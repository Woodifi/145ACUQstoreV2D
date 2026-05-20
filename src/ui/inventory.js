// =============================================================================
// QStore IMS v2 — Inventory page
// =============================================================================
// Lists items. Provides search, category filter, add/edit/delete (with role
// gating), and photo upload. Photos live in Storage.photos as Blobs; this
// module manages object-URL lifecycle through ObjectURLPool.
//
// PERMISSION GATING (defence in depth)
//   1. UI: buttons hidden if AUTH.can(...) is false
//   2. Handlers: AUTH.requirePermission(...) throws if somehow invoked
//   The handler check defends against stale UI, DevTools tampering, and
//   programmatic clicks.
//
// VALIDATION
//   - NSN: free-text but normalised; warning shown if it doesn't match the
//     standard 4-2-3-4 pattern. v1 had no validation.
//   - Quantity fields: must be non-negative integers. v1 accepted negatives.
//   - Required: NSN, name. v1's same.
//
// MUTATIONS RE-FETCH BY ID
//   The submit handler always re-reads the item from Storage just before
//   updating, by id. If the item has been deleted by another tab between
//   modal open and submit, we surface that and close the modal. v1's
//   index-based addressing silently corrupted on concurrent change.
//
// AUDIT
//   add    → action 'add',     desc "Added: <name> — <onHand> units (Auth: <authQty>)"
//   edit   → action 'adjust',  desc "Updated item: <name>"
//   delete → action 'adjust',  desc "Deleted item: <name> (NSN: <nsn>) — reason: <reason>"
//   photo  → action 'adjust',  desc "Photo updated for item: <name>"
// =============================================================================

import * as Storage    from '../storage.js';
import * as AUTH       from '../auth.js';
import * as Sync       from '../sync.js';
import { processItemPhoto } from './photo.js';
import { generateStockReport, generateQRSheet, generateBoardOfSurvey, downloadPdf } from '../pdf.js';
import { openQRScanModal } from './qr-scan.js';
import { openKitManager } from './kits.js';
import { openModal }   from './modal.js';
import { showToast }   from './toast.js';
import { esc, $, $$, render, fmtDate, ObjectURLPool } from './util.js';

// -----------------------------------------------------------------------------
// Constants — categories and conditions
// -----------------------------------------------------------------------------
// TODO: when a Settings page is built (v2.1+), these should move to
// settings storage so units can extend the lists. For now they're hard-
// coded matching v1 plus the calibration-due addition.

// Default category list — used when no custom list has been saved in Settings.
// Exported so settings.js can seed the editor with these defaults.
export const CATEGORIES = [
  'Uniform', 'Equipment', 'Safety', 'Training Aids',
  'Field Stores', 'Medical', 'ICT',
];

/**
 * Return the effective category list: custom list from storage if set,
 * otherwise the DEFAULT_CATEGORIES constant above.
 * Also merges in any categories already in use by items that aren't in the
 * stored list — so data already entered is never orphaned.
 */
export async function getCategories(itemsForMerge) {
  let stored = null;
  try {
    const raw = await Storage.settings.get('categories');
    if (Array.isArray(raw) && raw.length > 0) stored = raw;
  } catch (_) { /* non-fatal */ }
  const base = stored || CATEGORIES;
  if (!itemsForMerge) return base;
  // Merge any in-use categories not in the base list so nothing is hidden.
  const inUse = [...new Set(itemsForMerge.map(i => i.cat).filter(Boolean))];
  const extra = inUse.filter(c => !base.includes(c));
  return extra.length > 0 ? [...base, ...extra.sort()] : base;
}

// CONDITIONS lives in src/conditions.js so non-UI modules can import it
// without pulling DOM-dependent code. Re-exported here so existing
// callers keep working.
import { CONDITIONS } from '../conditions.js';
export { CONDITIONS };

// Standard NSN format: 4-2-3-4 digits with dashes (e.g., 8470-66-001-0001).
// Items with non-standard local NSNs are still accepted, just flagged.
const NSN_PATTERN = /^\d{4}-\d{2}-\d{3}-\d{4}$/;

const MAX_DELETE_REASON = 200;

// -----------------------------------------------------------------------------
// Module state
// -----------------------------------------------------------------------------

let _root = null;
let _searchTerm = '';
let _categoryFilter = '';
let _urlPool = new ObjectURLPool();

// -----------------------------------------------------------------------------
// Mount / unmount
// -----------------------------------------------------------------------------

export async function mount(rootEl) {
  _root = rootEl;
  _root.innerHTML = '';   // ensure first render always builds the full shell
  _searchTerm = '';
  _categoryFilter = '';
  await _render();
  return function unmount() {
    _urlPool.revokeAll();
    _root = null;
  };
}

// -----------------------------------------------------------------------------
// Render
// -----------------------------------------------------------------------------

async function _render() {
  // Replace URL pool — old URLs get revoked, new render gets fresh ones.
  const oldPool = _urlPool;
  _urlPool = new ObjectURLPool();

  const items = await Storage.items.list({
    category: _categoryFilter || undefined,
    search:   _searchTerm     || undefined,
  });
  items.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  const canAdd  = AUTH.can('addItem');
  const canEdit = AUTH.can('editItem');
  const canDel  = AUTH.isCO();

  // Resolve photo URLs for items that have them, in parallel.
  const photoUrls = new Map();
  await Promise.all(items.map(async (item) => {
    if (item.hasPhoto) {
      const url = await Storage.photos.getURL(item.id);
      if (url) {
        _urlPool.register(url);
        photoUrls.set(item.id, url);
      }
    }
  }));

  const totalItems  = await Storage.items.count();
  const categories  = await getCategories(items);

  // Check whether a stocktake has ever been finalised.
  // The warning banner persists until at least one stocktake is completed.
  const lastStocktake = await Storage.audit.list({ action: 'stocktake_finalise', limit: 1, order: 'desc' });
  const stocktakeDone = lastStocktake.length > 0;

  const stocktakeWarnHtml = stocktakeDone ? '' : `
    <div class="inv__stocktake-warn" role="alert">
      <span class="inv__stocktake-warn-icon">⚠</span>
      <div class="inv__stocktake-warn-body">
        <strong>Stock counts are unverified.</strong>
        Quantities shown may not reflect actual physical stock until a full stocktake is
        performed and finalised. Items issued before QStore was installed may cause
        discrepancies between <em>On hand</em> and <em>On loan</em> figures.
        <a href="#" class="inv__stocktake-warn-link" data-nav="stocktake">
          Go to Stocktake →
        </a>
      </div>
    </div>
  `;

  const contentHtml = `
    ${stocktakeWarnHtml}
    <div class="inv__meta">
      ${items.length} ${items.length === 1 ? 'item' : 'items'} shown
      ${(_searchTerm || _categoryFilter) && totalItems !== items.length
        ? `<span class="inv__meta-of"> of ${totalItems}</span>`
        : ''}
    </div>
    <div class="inv__table-wrap">
      ${items.length === 0
        ? _emptyStateHtml(totalItems, canAdd)
        : _tableHtml(items, photoUrls, { canEdit, canDel })}
    </div>
  `;

  // If the toolbar already exists, only replace the content area so the search
  // input is never destroyed and never loses focus mid-keystroke.
  const existingContent = $('.inv__content', _root);
  if (existingContent) {
    existingContent.innerHTML = contentHtml;
    // Sync input/select state in case _render was called by clear-filters or
    // an external action that changed _searchTerm / _categoryFilter.
    const searchEl = $('.inv__search', _root);
    if (searchEl && searchEl !== document.activeElement) searchEl.value = _searchTerm;
    const catEl = $('.inv__cat-filter', _root);
    if (catEl) catEl.value = _categoryFilter;
    oldPool.revokeAll();
    return;
  }

  // First render: build the full shell including the toolbar.
  render(_root, `
    <section class="inv">
      <header class="inv__toolbar">
        <div class="inv__filters">
          <input type="search"
                 class="inv__search"
                 placeholder="Search NSN, name, category, or location…"
                 aria-label="Search inventory"
                 value="${esc(_searchTerm)}">
          <select class="inv__cat-filter" aria-label="Filter by category">
            <option value="">All categories</option>
            ${categories.map(c =>
              `<option value="${esc(c)}" ${c === _categoryFilter ? 'selected' : ''}>${esc(c)}</option>`
            ).join('')}
          </select>
        </div>
        <div class="inv__actions">
          <button type="button" class="btn btn--ghost" data-action="print-stock" title="Print the currently-shown stock list">⎙ Print stock</button>
          ${AUTH.can('qr') ? `<button type="button" class="btn btn--ghost" data-action="print-qr" title="Print QR code labels for the currently-shown items">⎙ QR codes</button>` : ''}
          ${AUTH.can('qr') ? `<button type="button" class="btn btn--ghost" data-action="scan-qr" title="Scan a QR code label to look up an item">⌖ Scan</button>` : ''}
          ${canEdit ? `<button type="button" class="btn btn--ghost" data-action="manage-kits" title="Create and manage issue kits">⊞ Kits</button>` : ''}
          ${canEdit ? `<button type="button" class="btn btn--ghost" data-action="print-ab174" title="Generate AB174 Board of Survey form for all written-off items">⎙ AB174</button>` : ''}
          ${canAdd ? `<button type="button" class="btn btn--primary" data-action="add">+ Add item</button>` : ''}
        </div>
      </header>
      <div class="inv__content">
        ${contentHtml}
      </div>
    </section>
  `);

  oldPool.revokeAll();
  _wireEventListeners();
}

function _emptyStateHtml(totalItems, canAdd) {
  if (totalItems === 0) {
    return `
      <div class="inv__empty">
        <h3>No inventory items yet</h3>
        <p>${canAdd
          ? 'Add the first item to get started.'
          : 'Ask your QM to add inventory items.'}</p>
        ${canAdd ? `<button type="button" class="btn btn--primary" data-action="add">+ Add first item</button>` : ''}
      </div>
    `;
  }
  return `
    <div class="inv__empty">
      <h3>No matches</h3>
      <p>No items match your search and filter. Try clearing them.</p>
      <button type="button" class="btn btn--ghost" data-action="clear-filters">Clear filters</button>
    </div>
  `;
}

function _tableHtml(items, photoUrls, { canEdit, canDel }) {
  const headerCols = `
    <tr>
      <th class="inv__col-nsn">NSN</th>
      <th class="inv__col-photo" aria-label="Photo"></th>
      <th class="inv__col-name">Name</th>
      <th class="inv__col-cat">Category</th>
      <th class="inv__col-qty">Auth</th>
      <th class="inv__col-qty">On hand</th>
      <th class="inv__col-qty">On loan</th>
      <th class="inv__col-qty">Unsvc</th>
      <th class="inv__col-cond">Condition</th>
      <th class="inv__col-loc">Location</th>
      <th class="inv__col-actions" aria-label="Actions"></th>
    </tr>
  `;

  const bodyRows = items.map((item) =>
    _itemRowHtml(item, photoUrls.get(item.id), { canEdit, canDel })
  ).join('');

  return `
    <table class="inv__table">
      <thead>${headerCols}</thead>
      <tbody>${bodyRows}</tbody>
    </table>
  `;
}

function _itemRowHtml(item, photoUrl, { canEdit, canDel }) {
  const onHand   = Number(item.onHand)  || 0;
  const onLoan   = Number(item.onLoan)  || 0;
  const unsvc    = Number(item.unsvc)   || 0;
  const authQty  = Number(item.authQty) || 0;
  const pct = authQty > 0 ? Math.min(100, Math.round((onHand / authQty) * 100)) : 0;
  const fillClass = pct < 50 ? 'is-low' : pct < 75 ? 'is-mid' : '';

  // Low-stock / zero-stock indicator. Only shown when an auth qty is set.
  const isZeroStock = authQty > 0 && onHand === 0;
  const isLowStock  = authQty > 0 && !isZeroStock && onHand < Math.ceil(authQty * 0.25);
  const stockBadge  = isZeroStock
    ? `<span class="inv__stock-badge inv__stock-badge--zero" title="No stock on hand">Zero stock</span>`
    : isLowStock
      ? `<span class="inv__stock-badge inv__stock-badge--low" title="Below 25% of authorised qty">Low stock</span>`
      : '';

  // Badge derivation: blends the line-level `condition` flag with the
  // numeric `unsvc`/`onHand` counts so that bumping just the Unsvc count
  // surfaces visually. Without this, a line with onHand=2/unsvc=2 and
  // condition='serviceable' would render a green badge despite every
  // unit being unserviceable.
  //
  // Priority order: explicit non-serviceable conditions > derived
  // unsvc-vs-onHand > serviceable. The Partially U/S state is amber and
  // exists specifically for the "some but not all units broken" case
  // that v1 had no visual marker for.
  const { label: condLabel, modifier: condModifier } = _deriveCondition(item.condition, onHand, unsvc);
  const condCss    = `inv__cond inv__cond--${condModifier}`;
  const bdText     = _breakdownText(item);
  const bdTooltip  = _breakdownTooltip(item);

  const photoCell = photoUrl
    ? `<img class="inv__thumb" src="${esc(photoUrl)}" alt="" loading="lazy"
            data-action="photo" data-item-id="${esc(item.id)}"
            title="Click to change photo">`
    : `<button type="button" class="inv__thumb-placeholder" aria-label="Add photo"
               data-action="photo" data-item-id="${esc(item.id)}"
               title="Click to upload photo">📷</button>`;

  const mlogCount = Array.isArray(item.maintenanceLogs) ? item.maintenanceLogs.length : 0;
  const actionsCell = `
    <td class="inv__col-actions">
      <div class="inv__row-actions">
        <button type="button" class="btn btn--sm btn--ghost"
                data-action="history" data-item-id="${esc(item.id)}"
                title="View loan history for this item">History</button>
        <button type="button" class="btn btn--sm btn--ghost"
                data-action="maint-log" data-item-id="${esc(item.id)}"
                title="View / add maintenance notes">${mlogCount > 0 ? `Notes (${mlogCount})` : 'Notes'}</button>
        ${canEdit ? `<button type="button" class="btn btn--sm btn--ghost"
                              data-action="edit" data-item-id="${esc(item.id)}">Edit</button>` : ''}
        ${canDel  ? `<button type="button" class="btn btn--sm btn--danger"
                              data-action="delete" data-item-id="${esc(item.id)}">Delete</button>` : ''}
      </div>
    </td>`;

  return `
    <tr class="inv__row ${isZeroStock ? 'inv__row--zero-stock' : isLowStock ? 'inv__row--low-stock' : ''}">
      <td class="inv__col-nsn"><span class="inv__nsn">${esc(item.nsn || '—')}</span></td>
      <td class="inv__col-photo">${photoCell}</td>
      <td class="inv__col-name">
        <div class="inv__name">${esc(item.name || '')}${stockBadge}</div>
        ${item.notes ? `<div class="inv__notes">${esc(item.notes)}</div>` : ''}
      </td>
      <td class="inv__col-cat">${esc(item.cat || '—')}</td>
      <td class="inv__col-qty">${authQty}</td>
      <td class="inv__col-qty">
        <div class="inv__qty-with-bar">
          <span>${onHand}</span>
          <span class="inv__progress" aria-hidden="true">
            <span class="inv__progress-fill ${fillClass}" style="width:${pct}%"></span>
          </span>
        </div>
      </td>
      <td class="inv__col-qty inv__col-qty--loan">${onLoan}</td>
      <td class="inv__col-qty inv__col-qty--unsvc">${unsvc || ''}</td>
      <td class="inv__col-cond">
        <span class="${condCss}" title="${esc(condLabel)}">${esc(condLabel)}</span>
        ${bdText ? `<div class="inv__cond-bd" title="${esc(bdTooltip)}">${esc(bdText)}</div>` : ''}
      </td>
      <td class="inv__col-loc">${esc(item.loc || '—')}</td>
      ${actionsCell}
    </tr>
  `;
}

// -----------------------------------------------------------------------------
// Event wiring
// -----------------------------------------------------------------------------

function _wireEventListeners() {
  const search = $('.inv__search', _root);
  if (search) {
    search.addEventListener('input', _onSearchInput);
  }
  const catSel = $('.inv__cat-filter', _root);
  if (catSel) {
    catSel.addEventListener('change', _onCategoryChange);
  }
  _root.addEventListener('click', _onRootClick);
}

let _searchDebounce = null;
function _onSearchInput(e) {
  const value = e.target.value;
  if (_searchDebounce) clearTimeout(_searchDebounce);
  _searchDebounce = setTimeout(() => {
    _searchTerm = value;
    _render();
  }, 150);
}

function _onCategoryChange(e) {
  _categoryFilter = e.target.value;
  _render();
}

async function _onRootClick(e) {
  // Handle in-page navigation links (e.g. stocktake warning banner).
  const navTarget = e.target.closest('[data-nav]');
  if (navTarget) {
    e.preventDefault();
    _root.dispatchEvent(new CustomEvent('dash:navigate', {
      bubbles: true,
      detail: { page: navTarget.dataset.nav },
    }));
    return;
  }

  const target = e.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  const itemId = target.dataset.itemId;

  switch (action) {
    case 'add':
      if (AUTH.can('addItem')) await _openAddModal();
      break;
    case 'history':
      if (itemId) await _openHistoryModal(itemId);
      break;
    case 'maint-log':
      if (itemId) await _openMaintLogModal(itemId);
      break;
    case 'edit':
      if (AUTH.can('editItem') && itemId) await _openEditModal(itemId);
      break;
    case 'delete':
      if (AUTH.isCO() && itemId) await _openDeleteModal(itemId);
      break;
    case 'photo':
      if (AUTH.can('editItem') && itemId) await _openPhotoModal(itemId);
      break;
    case 'clear-filters':
      _searchTerm = '';
      _categoryFilter = '';
      await _render();
      break;
    case 'print-stock':
      await _doPrintStock(target);
      break;
    case 'print-ab174':
      await _doPrintAB174(target);
      break;
    case 'print-qr':
      await _doPrintQR(target);
      break;
    case 'scan-qr':
      _doScanQR();
      break;
    case 'manage-kits':
      if (AUTH.can('editItem')) openKitManager();
      break;
  }
}

// Print the currently-filtered stock list. Storage.items.list does the
// filtering for us; we sort by category-then-name to give the printed
// version a stable, scan-friendly order regardless of how the user is
// viewing it on screen.
async function _doPrintStock(button) {
  if (button) { button.disabled = true; button.textContent = 'Building PDF…'; }
  try {
    const items = await Storage.items.list({
      category: _categoryFilter || undefined,
      search:   _searchTerm     || undefined,
    });
    items.sort((a, b) =>
      (a.cat  || '').localeCompare(b.cat  || '') ||
      (a.name || '').localeCompare(b.name || ''));

    const filterParts = [];
    if (_categoryFilter) filterParts.push(`Category: ${_categoryFilter}`);
    if (_searchTerm)     filterParts.push(`Search: "${_searchTerm}"`);
    const subtitle = filterParts.join(' · ');

    const unit = await Storage.settings.getAll();
    const result = await generateStockReport(items, { unit, subtitle });
    downloadPdf(result);
  } catch (err) {
    showToast('Stock report generation failed: ' + (err.message || err), 'error');
  } finally {
    if (button) { button.disabled = false; button.textContent = '⎙ Print stock'; }
  }
}

// Generate AB174 Board of Survey form for all items with writtenOff > 0.
async function _doPrintAB174(button) {
  if (button) { button.disabled = true; button.textContent = 'Building PDF…'; }
  try {
    const allItems = await Storage.items.list();
    const writtenOffItems = allItems.filter((i) => (Number(i.writtenOff) || Number(i.qtyWrittenOff) || 0) > 0);
    if (writtenOffItems.length === 0) {
      showToast('No written-off items found in inventory.', 'info');
      return;
    }
    const unit = await Storage.settings.getAll();
    const result = await generateBoardOfSurvey(writtenOffItems, { unit });
    downloadPdf(result);
  } catch (err) {
    showToast('AB174 generation failed: ' + (err.message || err), 'error');
  } finally {
    if (button) { button.disabled = false; button.textContent = '⎙ AB174'; }
  }
}

// Print QR code labels for the currently-filtered inventory. Same filter
// logic as _doPrintStock; sorted by category then name for a stable layout.
async function _doPrintQR(button) {
  AUTH.requirePermission('qr');
  if (button) { button.disabled = true; button.textContent = 'Building PDF…'; }
  try {
    const items = await Storage.items.list({
      category: _categoryFilter || undefined,
      search:   _searchTerm     || undefined,
    });
    items.sort((a, b) =>
      (a.cat  || '').localeCompare(b.cat  || '') ||
      (a.name || '').localeCompare(b.name || ''));
    const unit   = await Storage.settings.getAll();
    const result = await generateQRSheet(items, { unit });
    downloadPdf(result);
  } catch (err) {
    showToast('QR sheet generation failed: ' + (err.message || err), 'error');
  } finally {
    if (button) { button.disabled = false; button.textContent = '⎙ QR codes'; }
  }
}

// Open the QR scan modal. On a successful decode, look up the item and open
// its edit modal so the QM can inspect or update it immediately.
function _doScanQR() {
  AUTH.requirePermission('qr');
  openQRScanModal(async (itemId) => {
    const item = await Storage.items.get(itemId);
    if (!item) {
      showToast('Scanned item not found in this Q-Store. The label may belong to a different unit.', 'warn');
      return;
    }
    await _openEditModal(itemId);
  });
}

// -----------------------------------------------------------------------------
// Add / Edit modal
// -----------------------------------------------------------------------------

async function _openAddModal() {
  AUTH.requirePermission('addItem');
  _openItemFormModal({ mode: 'add', item: null });
}

// -----------------------------------------------------------------------------
// Loan history panel
// -----------------------------------------------------------------------------

async function _openHistoryModal(itemId) {
  const item  = await Storage.items.get(itemId);
  if (!item) return;

  // Load all loans for this item from the loans store. The loans store has
  // an `itemId` index we can query.
  const allLoans = await Storage.loans.list();
  const itemLoans = allLoans
    .filter(l => l.itemId === itemId)
    .sort((a, b) => b.issueDate.localeCompare(a.issueDate));  // most-recent first

  const totalIssued  = itemLoans.reduce((n, l) => n + (l.qty || 1), 0);
  const activeCount  = itemLoans.filter(l => l.active).length;
  const today        = new Date().toISOString().slice(0, 10);
  const overdueCount = itemLoans.filter(l => l.active && l.dueDate && l.dueDate < today).length;

  const rowsHtml = itemLoans.length === 0
    ? `<tr><td colspan="6" class="inv__hist-empty">No loan records for this item.</td></tr>`
    : itemLoans.map(l => {
        const isActive   = l.active;
        const isOverdue  = isActive && l.dueDate && l.dueDate < today;
        const rowClass   = isOverdue ? 'inv__hist-row--overdue' : isActive ? 'inv__hist-row--active' : 'inv__hist-row--returned';
        const statusHtml = isOverdue
          ? `<span class="inv__hist-badge inv__hist-badge--overdue">Overdue</span>`
          : isActive
            ? `<span class="inv__hist-badge inv__hist-badge--active">Active</span>`
            : `<span class="inv__hist-badge inv__hist-badge--returned">Returned</span>`;
        return `
          <tr class="inv__hist-row ${rowClass}">
            <td class="inv__hist-ref">${esc(l.ref || '—')}</td>
            <td>${esc(l.borrowerName || l.borrowerSvc || '—')}</td>
            <td class="inv__hist-qty">${esc(String(l.qty || 1))}</td>
            <td>${esc(_fmtDateAU(l.issueDate))}</td>
            <td>${esc(l.dueDate ? _fmtDateAU(l.dueDate) : '—')}</td>
            <td>${statusHtml}</td>
          </tr>
        `;
      }).join('');

  openModal({
    titleHtml: `Loan history — ${esc(item.name || itemId)}`,
    size:      'lg',
    bodyHtml: `
      <div class="inv__hist-summary">
        <span>${itemLoans.length} loan record${itemLoans.length === 1 ? '' : 's'}</span>
        <span>&middot; ${totalIssued} unit${totalIssued === 1 ? '' : 's'} issued total</span>
        ${activeCount > 0
          ? `<span>&middot; <strong>${activeCount} currently on loan</strong></span>` : ''}
        ${overdueCount > 0
          ? `<span class="inv__hist-overdue-warn">&middot; ${overdueCount} overdue</span>` : ''}
      </div>
      <div class="inv__hist-table-wrap">
        <table class="inv__hist-table">
          <thead>
            <tr>
              <th>Ref</th>
              <th>Borrower</th>
              <th>Qty</th>
              <th>Issued</th>
              <th>Due</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      <div class="form__actions">
        <button type="button" class="btn btn--primary" data-action="modal-close">Close</button>
      </div>
    `,
  });
}

function _fmtDateAU(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
}

function _fmtDateTimeAU(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString('en-AU', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// -----------------------------------------------------------------------------
// Maintenance / notes log modal
// -----------------------------------------------------------------------------
// Provides a timestamped free-text log per item. Entries are stored as
// `item.maintenanceLogs = [{ ts, user, note }, ...]` (appended, never deleted).
// The log is purely informational — no stock impact. Useful for servicing,
// calibration reminders, or QM notes about an item's physical state.

async function _openMaintLogModal(itemId) {
  const item = await Storage.items.get(itemId);
  if (!item) return;

  const logs = Array.isArray(item.maintenanceLogs) ? item.maintenanceLogs : [];

  const _renderLogs = (entries) => entries.length === 0
    ? `<p class="inv__mlog-empty">No notes yet. Add the first one below.</p>`
    : `<div class="inv__mlog-list">
        ${entries.slice().reverse().map((e) => `
          <div class="inv__mlog-entry">
            <span class="inv__mlog-ts">${esc(_fmtDateTimeAU(e.ts))}</span>
            <span class="inv__mlog-user">${esc(e.user || '—')}</span>
            <p class="inv__mlog-note">${esc(e.note)}</p>
          </div>`).join('')}
       </div>`;

  openModal({
    titleHtml: `Maintenance notes — ${esc(item.name || itemId)}`,
    size: 'md',
    bodyHtml: `
      <div class="inv__mlog" data-mlog-itemid="${esc(itemId)}">
        <div data-mlog-list>
          ${_renderLogs(logs)}
        </div>
        <div class="inv__mlog-form">
          <label class="form__field">
            <span class="form__label">Add note</span>
            <textarea class="form__input" rows="3" data-mlog-input
                      placeholder="e.g. Sent for calibration 2026-05-20, due back 2026-06-10"></textarea>
          </label>
          <div class="form__error" data-mlog-error role="alert"></div>
          <div class="form__actions" style="margin-top:8px">
            <button type="button" class="btn btn--primary" data-action="mlog-save">
              + Add note
            </button>
          </div>
        </div>
      </div>
    `,
    async onMount(panel) {
      panel.querySelector('[data-action="mlog-save"]')?.addEventListener('click', async () => {
        const textarea = panel.querySelector('[data-mlog-input]');
        const errEl    = panel.querySelector('[data-mlog-error]');
        const note     = (textarea?.value || '').trim();
        if (!note) { errEl.textContent = 'Note cannot be empty.'; return; }
        errEl.textContent = '';

        const saveBtn = panel.querySelector('[data-action="mlog-save"]');
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';

        try {
          // Re-fetch the item to avoid overwriting concurrent changes.
          const current = await Storage.items.get(itemId);
          if (!current) throw new Error('Item no longer exists.');
          const existing = Array.isArray(current.maintenanceLogs) ? current.maintenanceLogs : [];
          const entry = {
            ts:   new Date().toISOString(),
            user: AUTH.getSession()?.name || 'unknown',
            note,
          };
          current.maintenanceLogs = [...existing, entry];
          current.updatedAt = entry.ts;
          await Storage.items.put(current);
          await Storage.audit.append({
            action: 'item_note',
            user:   entry.user,
            desc:   `Note added to "${current.name}" (${current.nsn}): ${note.slice(0, 100)}${note.length > 100 ? '…' : ''}`,
          });
          Sync.notifyChanged();

          // Refresh the log display in-place without closing the modal.
          textarea.value = '';
          const listEl = panel.querySelector('[data-mlog-list]');
          if (listEl) listEl.innerHTML = _renderLogs(current.maintenanceLogs);

          // Refresh the Notes button count in the main list.
          await _render();
        } catch (err) {
          errEl.textContent = 'Failed to save: ' + (err.message || err);
        } finally {
          saveBtn.disabled = false;
          saveBtn.textContent = '+ Add note';
        }
      });
    },
  });
}

async function _openEditModal(itemId) {
  AUTH.requirePermission('editItem');
  const item = await Storage.items.get(itemId);
  if (!item) {
    _flashError('That item no longer exists. The list will refresh.');
    await _render();
    return;
  }
  _openItemFormModal({ mode: 'edit', item });
}

async function _openItemFormModal({ mode, item }) {
  const isEdit     = mode === 'edit';
  const title      = isEdit ? `Edit item — ${esc(item.name || item.id)}` : 'Add inventory item';
  // Pre-fetch categories so the form select is populated on open.
  const categories = await getCategories();

  openModal({
    titleHtml: title,
    size: 'md',
    bodyHtml: `
      <form class="form" data-form="item" autocomplete="off" novalidate>
        <div class="form__row">
          <label class="form__field form__field--grow">
            <span class="form__label">NSN <abbr title="Required">*</abbr></span>
            <input type="text" name="nsn" required maxlength="32"
                   value="${esc(item?.nsn || '')}"
                   placeholder="e.g. 8470-66-001-0001">
            <span class="form__hint" data-hint="nsn"></span>
          </label>
          <label class="form__field">
            <span class="form__label">Category</span>
            <select name="cat">
              ${categories.map(c =>
                `<option value="${esc(c)}" ${c === (item?.cat || 'Equipment') ? 'selected' : ''}>${esc(c)}</option>`
              ).join('')}
            </select>
          </label>
        </div>
        <label class="form__field">
          <span class="form__label">Name / nomenclature <abbr title="Required">*</abbr></span>
          <input type="text" name="name" required maxlength="200"
                 value="${esc(item?.name || '')}">
        </label>
        <div class="form__row">
          <label class="form__field">
            <span class="form__label">Authorised qty</span>
            <input type="number" name="authQty" min="0" step="1" inputmode="numeric"
                   value="${esc(item?.authQty ?? 1)}">
          </label>
          <label class="form__field">
            <span class="form__label">On hand</span>
            <input type="number" name="onHand" min="0" step="1" inputmode="numeric"
                   value="${esc(item?.onHand ?? (isEdit ? 0 : 1))}"
                   data-target="onhand-input">
          </label>
        </div>
        ${(() => {
          const bd = _seedBreakdown(item);
          const total = bd.qtyServiceable + bd.qtyUnserviceable + bd.qtyRepair + bd.qtyCalibrationDue + bd.qtyWrittenOff;
          const oh = item?.onHand ?? (isEdit ? 0 : 1);
          const totalClass = total === oh ? 'inv__bd-total--ok' : 'inv__bd-total--warn';
          return `
        <div class="inv__breakdown">
          <div class="inv__breakdown-header">
            <span class="form__label">Condition breakdown</span>
            <span class="inv__bd-total ${totalClass}" data-target="bd-total">
              Total: ${total} / ${oh}
            </span>
          </div>
          <div class="inv__breakdown-row">
            <label class="inv__bd-field">
              <span class="inv__bd-label inv__bd-label--svc" title="Serviceable — ready for issue">Svc</span>
              <input type="number" name="qtyServiceable" min="0" step="1" inputmode="numeric"
                     value="${esc(String(bd.qtyServiceable))}" class="inv__bd-input"
                     title="Serviceable — ready for issue">
            </label>
            <label class="inv__bd-field">
              <span class="inv__bd-label inv__bd-label--uns" title="Unserviceable — damaged or non-functional">U/S</span>
              <input type="number" name="qtyUnserviceable" min="0" step="1" inputmode="numeric"
                     value="${esc(String(bd.qtyUnserviceable))}" class="inv__bd-input"
                     title="Unserviceable — damaged or non-functional">
            </label>
            <label class="inv__bd-field">
              <span class="inv__bd-label inv__bd-label--repr" title="In repair — temporarily unavailable">Repr</span>
              <input type="number" name="qtyRepair" min="0" step="1" inputmode="numeric"
                     value="${esc(String(bd.qtyRepair))}" class="inv__bd-input"
                     title="In repair — temporarily unavailable">
            </label>
            <label class="inv__bd-field">
              <span class="inv__bd-label inv__bd-label--cal" title="Calibration due — must be calibrated before issue">Cal</span>
              <input type="number" name="qtyCalibrationDue" min="0" step="1" inputmode="numeric"
                     value="${esc(String(bd.qtyCalibrationDue))}" class="inv__bd-input"
                     title="Calibration due — must be calibrated before issue">
            </label>
            <label class="inv__bd-field">
              <span class="inv__bd-label inv__bd-label--wo" title="Written off — beyond repair, pending Board of Survey">W/O</span>
              <input type="number" name="qtyWrittenOff" min="0" step="1" inputmode="numeric"
                     value="${esc(String(bd.qtyWrittenOff))}" class="inv__bd-input"
                     title="Written off — beyond repair, pending Board of Survey">
            </label>
          </div>
        </div>`;
        })()}
        <label class="form__field">
          <span class="form__label">Location</span>
          <input type="text" name="loc" maxlength="80"
                 value="${esc(item?.loc || '')}"
                 placeholder="e.g. Bay 3, Shelf A">
        </label>
        <label class="form__field">
          <span class="form__label">Notes</span>
          <textarea name="notes" maxlength="500" rows="2">${esc(item?.notes || '')}</textarea>
        </label>
        <div class="form__error" role="alert"></div>
        <div class="form__actions">
          <button type="button" class="btn btn--ghost" data-action="modal-close">Cancel</button>
          <button type="submit" class="btn btn--primary">${isEdit ? 'Save changes' : 'Add item'}</button>
        </div>
      </form>
    `,
    async onMount(panel, close) {
      const form = $('form[data-form="item"]', panel);
      const errEl = $('.form__error', panel);
      const nsnInput = $('input[name="nsn"]', panel);
      const nsnHint  = $('[data-hint="nsn"]', panel);

      // Pre-load the item list once for duplicate NSN checks.
      let allItems = [];
      try { allItems = await Storage.items.list(); } catch (_) { /* non-fatal */ }

      // Live NSN format hint + duplicate detection.
      const updateNsnHint = () => {
        const v = nsnInput.value.trim();
        if (!v) { nsnHint.textContent = ''; nsnHint.className = 'form__hint'; return; }

        // Duplicate check — ignore the item being edited (same id).
        const dupe = allItems.find(
          (i) => i.nsn === v && (!isEdit || i.id !== item?.id)
        );
        if (dupe) {
          nsnHint.textContent = `⚠ Duplicate NSN — already used by "${dupe.name}"`;
          nsnHint.className = 'form__hint is-warn';
          return;
        }

        nsnHint.textContent = NSN_PATTERN.test(v)
          ? '✓ Standard format'
          : 'Non-standard format (will be accepted as a local NSN)';
        nsnHint.className = 'form__hint ' + (NSN_PATTERN.test(v) ? 'is-good' : 'is-warn');
      };
      nsnInput.addEventListener('input', updateNsnHint);
      updateNsnHint();

      // Live breakdown total — updates as the user types.
      const onHandInput  = $('[data-target="onhand-input"]', panel);
      const bdInputs     = $$('.inv__bd-input', panel);
      const bdTotalEl    = $('[data-target="bd-total"]', panel);
      const _updateBdTotal = () => {
        if (!bdTotalEl) return;
        const oh    = Math.max(0, Number(onHandInput?.value) || 0);
        const total = bdInputs.reduce((s, el) => s + (Math.max(0, Number(el.value) || 0)), 0);
        bdTotalEl.textContent = `Total: ${total} / ${oh}`;
        bdTotalEl.className = `inv__bd-total ${total === oh ? 'inv__bd-total--ok' : 'inv__bd-total--warn'}`;
      };
      bdInputs.forEach(el => el.addEventListener('input', _updateBdTotal));
      if (onHandInput) {
        onHandInput.addEventListener('input', () => {
          // Auto-adjust Svc to absorb any change in onHand so the total stays consistent.
          const oh    = Math.max(0, Number(onHandInput.value) || 0);
          const svcEl = $('input[name="qtyServiceable"]', panel);
          if (svcEl) {
            const nonSvc = bdInputs
              .filter(el => el.name !== 'qtyServiceable')
              .reduce((s, el) => s + (Math.max(0, Number(el.value) || 0)), 0);
            svcEl.value = String(Math.max(0, oh - nonSvc));
          }
          _updateBdTotal();
        });
      }

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errEl.textContent = '';
        try {
          const data = _readFormData(form, isEdit);
          if (isEdit) {
            await _saveEdit(item.id, data);
          } else {
            await _saveAdd(data);
          }
          close();
          await _render();
        } catch (err) {
          errEl.textContent = err.message || 'Could not save.';
        }
      });
    },
  });
}

function _readFormData(form, isEdit) {
  const fd = new FormData(form);
  const nsn  = String(fd.get('nsn')  || '').trim();
  const name = String(fd.get('name') || '').trim();
  if (!nsn)  throw new Error('NSN is required.');
  if (!name) throw new Error('Name is required.');

  const authQty = _readNonNegInt(fd, 'authQty', 'Authorised qty');
  const onHand  = _readNonNegInt(fd, 'onHand',  'On hand');

  // Condition breakdown — always present (both add and edit).
  const qtyServiceable    = _readNonNegInt(fd, 'qtyServiceable',    'Svc count');
  const qtyUnserviceable  = _readNonNegInt(fd, 'qtyUnserviceable',  'U/S count');
  const qtyRepair         = _readNonNegInt(fd, 'qtyRepair',         'Repr count');
  const qtyCalibrationDue = _readNonNegInt(fd, 'qtyCalibrationDue', 'Cal count');
  const qtyWrittenOff     = _readNonNegInt(fd, 'qtyWrittenOff',     'W/O count');
  const bdTotal = qtyServiceable + qtyUnserviceable + qtyRepair + qtyCalibrationDue + qtyWrittenOff;
  if (bdTotal !== onHand) {
    throw new Error(
      `Condition breakdown total (${bdTotal}) must equal On hand (${onHand}).`
    );
  }

  // Derive legacy aggregated fields from the breakdown (kept for backward compat
  // and for any code that still reads .unsvc / .condition directly).
  const unsvc     = qtyUnserviceable + qtyRepair + qtyCalibrationDue;
  const writtenOff = qtyWrittenOff;
  const condition  = qtyWrittenOff > 0     ? 'written-off'
    : qtyRepair > 0         ? 'repair'
    : qtyCalibrationDue > 0 ? 'calibration-due'
    : qtyUnserviceable > 0  ? 'unserviceable'
    : 'serviceable';

  return {
    nsn, name,
    cat: String(fd.get('cat') || 'Equipment'),
    authQty, onHand,
    qtyServiceable, qtyUnserviceable, qtyRepair, qtyCalibrationDue, qtyWrittenOff,
    unsvc, writtenOff, condition,
    loc:   String(fd.get('loc')   || '').trim(),
    notes: String(fd.get('notes') || '').trim(),
  };
}

function _readNonNegInt(fd, key, label) {
  const raw = String(fd.get(key) ?? '').trim();
  if (raw === '') return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${label} must be a non-negative whole number.`);
  }
  return n;
}

async function _saveAdd(data) {
  // Guard against duplicate NSNs — a second click or a race condition could
  // slip through the live hint. Throw so the form shows an inline error.
  const existing = await Storage.items.list();
  const dupe = existing.find((i) => i.nsn === data.nsn);
  if (dupe) {
    throw new Error(`NSN ${data.nsn} is already in the inventory ("${dupe.name}"). Edit that item instead.`);
  }
  const id = 'I' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const item = {
    id,
    nsn:               data.nsn,
    name:              data.name,
    cat:               data.cat,
    authQty:           data.authQty,
    onHand:            data.onHand,
    onLoan:            0,
    unsvc:             data.unsvc,
    writtenOff:        data.writtenOff,
    condition:         data.condition,
    qtyServiceable:    data.qtyServiceable,
    qtyUnserviceable:  data.qtyUnserviceable,
    qtyRepair:         data.qtyRepair,
    qtyCalibrationDue: data.qtyCalibrationDue,
    qtyWrittenOff:     data.qtyWrittenOff,
    loc:               data.loc,
    notes:             data.notes,
    hasPhoto:          false,
    createdAt:         new Date().toISOString(),
  };
  await Storage.items.put(item);
  await Storage.audit.append({
    action: 'add',
    user:   _sessionName(),
    desc:   `Added: ${data.name} — ${data.onHand} units (Auth: ${data.authQty})`,
  });
  Sync.notifyChanged();
}

async function _saveEdit(itemId, data) {
  const existing = await Storage.items.get(itemId);
  if (!existing) {
    throw new Error('That item was deleted by another session. Reload to see the current list.');
  }
  const updated = {
    ...existing,
    nsn:               data.nsn,
    name:              data.name,
    cat:               data.cat,
    authQty:           data.authQty,
    onHand:            data.onHand,
    unsvc:             data.unsvc,
    writtenOff:        data.writtenOff,
    condition:         data.condition,
    qtyServiceable:    data.qtyServiceable,
    qtyUnserviceable:  data.qtyUnserviceable,
    qtyRepair:         data.qtyRepair,
    qtyCalibrationDue: data.qtyCalibrationDue,
    qtyWrittenOff:     data.qtyWrittenOff,
    loc:               data.loc,
    notes:             data.notes,
    updatedAt:         new Date().toISOString(),
  };
  await Storage.items.put(updated);
  await Storage.audit.append({
    action: 'adjust',
    user:   _sessionName(),
    desc:   `Updated item: ${data.name}`,
  });
  Sync.notifyChanged();
}

// -----------------------------------------------------------------------------
// Delete modal
// -----------------------------------------------------------------------------

async function _openDeleteModal(itemId) {
  AUTH.requireCO();
  const item = await Storage.items.get(itemId);
  if (!item) {
    _flashError('That item no longer exists. The list will refresh.');
    await _render();
    return;
  }

  openModal({
    titleHtml: `Delete item — ${esc(item.name)}`,
    size: 'sm',
    bodyHtml: `
      <p class="modal__warn">
        This will permanently delete the item and its photo. The audit log will
        record this deletion and the reason you provide. <strong>This cannot be undone.</strong>
      </p>
      <dl class="modal__detail">
        <dt>NSN</dt><dd>${esc(item.nsn)}</dd>
        <dt>Name</dt><dd>${esc(item.name)}</dd>
        <dt>On hand</dt><dd>${esc(item.onHand)}</dd>
        <dt>On loan</dt><dd>${esc(item.onLoan)}</dd>
      </dl>
      ${item.onLoan > 0 ? `
        <div class="modal__error" style="position: static;">
          <strong>Warning:</strong> ${esc(item.onLoan)} unit${item.onLoan === 1 ? ' is' : 's are'} currently on loan.
          Deleting this item will not return those loans.
        </div>
      ` : ''}
      <form class="form" data-form="delete" autocomplete="off" novalidate>
        <label class="form__field">
          <span class="form__label">Reason for deletion <abbr title="Required">*</abbr></span>
          <textarea name="reason" required maxlength="${MAX_DELETE_REASON}" rows="3"
                    placeholder="e.g. Written off following loss inquiry, BOI ref 24/03"></textarea>
          <span class="form__hint">Recorded permanently in the audit log. Maximum ${MAX_DELETE_REASON} characters.</span>
        </label>
        <div class="form__error" role="alert"></div>
        <div class="form__actions">
          <button type="button" class="btn btn--ghost" data-action="modal-close">Cancel</button>
          <button type="submit" class="btn btn--danger">Delete permanently</button>
        </div>
      </form>
    `,
    onMount(panel, close) {
      const form  = $('form[data-form="delete"]', panel);
      const errEl = $('.form__error', panel);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errEl.textContent = '';
        const fd = new FormData(form);
        const reason = String(fd.get('reason') || '').trim();
        if (!reason) {
          errEl.textContent = 'A reason is required.';
          return;
        }
        try {
          await _doDelete(itemId, reason);
          close();
          await _render();
        } catch (err) {
          errEl.textContent = err.message || 'Delete failed.';
        }
      });
    },
  });
}

async function _doDelete(itemId, reason) {
  const item = await Storage.items.get(itemId);
  if (!item) {
    throw new Error('Item already deleted.');
  }
  // Capture name and NSN before delete for audit trail.
  const { name, nsn } = item;
  await Storage.items.delete(itemId);  // also drops the photo (Storage.items.delete cascades)
  await Storage.audit.append({
    action: 'adjust',
    user:   _sessionName(),
    desc:   `Deleted item: ${name} (NSN: ${nsn || '—'}) — reason: ${reason}`,
  });
  Sync.notifyChanged();
}

// -----------------------------------------------------------------------------
// Photo upload
// -----------------------------------------------------------------------------

async function _openPhotoModal(itemId) {
  AUTH.requirePermission('editItem');
  const item = await Storage.items.get(itemId);
  if (!item) {
    _flashError('That item no longer exists. The list will refresh.');
    await _render();
    return;
  }

  // We track previewUrl in this outer scope so onClose can revoke it.
  // Without this, the last URL created in setPreview() would leak until GC.
  let modalPreviewUrl = null;

  openModal({
    titleHtml: `Photo — ${esc(item.name)}`,
    size: 'sm',
    bodyHtml: `
      <div class="photo-upload" data-target="drop">
        <div class="photo-upload__preview" data-target="preview">
          <span class="photo-upload__placeholder">No photo selected</span>
        </div>
        <p class="photo-upload__hint">
          Click to choose, or drag &amp; drop an image here.<br>
          JPG / PNG / WEBP, up to 10 MB. Will be cropped to 120×120.
        </p>
        <input type="file" accept="image/*" data-target="file" hidden>
        <div class="form__error" role="alert" data-target="error"></div>
        <div class="form__actions">
          ${item.hasPhoto ? `<button type="button" class="btn btn--danger" data-action="remove-photo">Remove photo</button>` : ''}
          <button type="button" class="btn btn--ghost" data-action="modal-close">Cancel</button>
          <button type="button" class="btn btn--primary" data-target="save" disabled>Save photo</button>
        </div>
      </div>
    `,
    onMount(panel, close) {
      const drop    = $('[data-target="drop"]',    panel);
      const preview = $('[data-target="preview"]', panel);
      const fileInp = $('[data-target="file"]',    panel);
      const errEl   = $('[data-target="error"]',   panel);
      const saveBtn = $('[data-target="save"]',    panel);

      let pendingBlob = null;

      const setPreview = async (blob) => {
        if (modalPreviewUrl) {
          URL.revokeObjectURL(modalPreviewUrl);
          modalPreviewUrl = null;
        }
        if (blob) {
          modalPreviewUrl = URL.createObjectURL(blob);
          preview.innerHTML = `<img src="${esc(modalPreviewUrl)}" alt="Preview">`;
        } else if (item.hasPhoto) {
          const url = await Storage.photos.getURL(item.id);
          modalPreviewUrl = url;
          preview.innerHTML = url
            ? `<img src="${esc(url)}" alt="Current photo">`
            : `<span class="photo-upload__placeholder">No photo</span>`;
        } else {
          preview.innerHTML = `<span class="photo-upload__placeholder">No photo selected</span>`;
        }
      };

      // Initial preview shows the existing photo if present.
      setPreview(null);

      const ingest = async (file) => {
        errEl.textContent = '';
        if (!file) return;
        try {
          pendingBlob = await processItemPhoto(file);
          await setPreview(pendingBlob);
          saveBtn.disabled = false;
        } catch (err) {
          pendingBlob = null;
          saveBtn.disabled = true;
          errEl.textContent = err.message || 'Photo processing failed.';
        }
      };

      drop.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        fileInp.click();
      });
      fileInp.addEventListener('change', (e) => {
        ingest(e.target.files?.[0]);
        fileInp.value = '';
      });
      drop.addEventListener('dragover', (e) => {
        e.preventDefault();
        drop.classList.add('is-drag');
      });
      drop.addEventListener('dragleave', () => {
        drop.classList.remove('is-drag');
      });
      drop.addEventListener('drop', (e) => {
        e.preventDefault();
        drop.classList.remove('is-drag');
        ingest(e.dataTransfer.files?.[0]);
      });

      panel.addEventListener('click', async (e) => {
        const action = e.target.closest('[data-action]')?.dataset.action;
        if (action === 'remove-photo') {
          try {
            await Storage.photos.delete(item.id);
            const updated = await Storage.items.get(item.id);
            if (updated) {
              await Storage.items.put({ ...updated, hasPhoto: false, updatedAt: new Date().toISOString() });
            }
            await Storage.audit.append({
              action: 'adjust',
              user:   _sessionName(),
              desc:   `Photo removed for item: ${item.name}`,
            });
            Sync.notifyChanged();
            close();
            await _render();
          } catch (err) {
            errEl.textContent = err.message || 'Could not remove photo.';
          }
        }
      });

      saveBtn.addEventListener('click', async () => {
        if (!pendingBlob) return;
        errEl.textContent = '';
        try {
          await Storage.photos.put(item.id, pendingBlob);
          const updated = await Storage.items.get(item.id);
          if (updated) {
            await Storage.items.put({ ...updated, hasPhoto: true, updatedAt: new Date().toISOString() });
          }
          await Storage.audit.append({
            action: 'adjust',
            user:   _sessionName(),
            desc:   `Photo updated for item: ${item.name}`,
          });
          Sync.notifyChanged();
          close();
          await _render();
        } catch (err) {
          errEl.textContent = err.message || 'Could not save photo.';
        }
      });
    },
    onClose() {
      // Revoke any preview URL we created. Without this, the URL holds the
      // Blob alive until GC eventually clears it — small leak but real.
      if (modalPreviewUrl) {
        URL.revokeObjectURL(modalPreviewUrl);
        modalPreviewUrl = null;
      }
    },
  });
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function _sessionName() {
  return AUTH.getSession()?.name || 'unknown';
}

function _flashError(message) {
  showToast(message, 'error');
}

// -----------------------------------------------------------------------------
// Condition breakdown helpers
// -----------------------------------------------------------------------------

/**
 * Seed the 5 breakdown qty fields for the item form.
 * - If the item already stores the breakdown (qtyServiceable is set), use it.
 * - Otherwise (legacy item) derive from the old `condition` + `unsvc` fields.
 */
function _seedBreakdown(item) {
  if (!item) {
    return { qtyServiceable: 1, qtyUnserviceable: 0, qtyRepair: 0, qtyCalibrationDue: 0, qtyWrittenOff: 0 };
  }
  if (item.qtyServiceable != null) {
    return {
      qtyServiceable:    Math.max(0, Number(item.qtyServiceable)    || 0),
      qtyUnserviceable:  Math.max(0, Number(item.qtyUnserviceable)  || 0),
      qtyRepair:         Math.max(0, Number(item.qtyRepair)         || 0),
      qtyCalibrationDue: Math.max(0, Number(item.qtyCalibrationDue) || 0),
      qtyWrittenOff:     Math.max(0, Number(item.qtyWrittenOff)     || 0),
    };
  }
  // Legacy item — distribute unsvc into the appropriate condition bucket.
  const onHand     = Math.max(0, Number(item.onHand)    || 0);
  const unsvc      = Math.max(0, Number(item.unsvc)     || 0);
  const writtenOff = Math.max(0, Number(item.writtenOff) || 0);
  const cond       = item.condition || 'serviceable';
  let qtyU = 0, qtyR = 0, qtyC = 0;
  if      (cond === 'unserviceable')   qtyU = unsvc;
  else if (cond === 'repair')          qtyR = unsvc;
  else if (cond === 'calibration-due') qtyC = unsvc;
  else if (unsvc > 0)                  qtyU = unsvc; // best guess for any other condition
  const qtyW = writtenOff;
  const qtyS = Math.max(0, onHand - qtyU - qtyR - qtyC - qtyW);
  return { qtyServiceable: qtyS, qtyUnserviceable: qtyU, qtyRepair: qtyR, qtyCalibrationDue: qtyC, qtyWrittenOff: qtyW };
}

/**
 * Build a short breakdown text for the table row, e.g. "3 Svc · 1 U/S · 1 Repr".
 * Returns empty string when the item is fully serviceable (no noise in the table).
 */
function _breakdownText(item) {
  if (item.qtyServiceable == null) return ''; // legacy — badge is sufficient
  const qS = Number(item.qtyServiceable)    || 0;
  const qU = Number(item.qtyUnserviceable)  || 0;
  const qR = Number(item.qtyRepair)         || 0;
  const qC = Number(item.qtyCalibrationDue) || 0;
  const qW = Number(item.qtyWrittenOff)     || 0;
  // Only show breakdown when something non-serviceable exists.
  if (qU === 0 && qR === 0 && qC === 0 && qW === 0) return '';
  const parts = [];
  if (qS > 0) parts.push(`${qS} Svc`);
  if (qU > 0) parts.push(`${qU} U/S`);
  if (qR > 0) parts.push(`${qR} Repr`);
  if (qC > 0) parts.push(`${qC} Cal`);
  if (qW > 0) parts.push(`${qW} W/O`);
  return parts.join(' · ');
}

// Full-text expansion of the abbreviations in _breakdownText — used as tooltip.
function _breakdownTooltip(item) {
  if (item.qtyServiceable == null) return '';
  const qS = Number(item.qtyServiceable)    || 0;
  const qU = Number(item.qtyUnserviceable)  || 0;
  const qR = Number(item.qtyRepair)         || 0;
  const qC = Number(item.qtyCalibrationDue) || 0;
  const qW = Number(item.qtyWrittenOff)     || 0;
  if (qU === 0 && qR === 0 && qC === 0 && qW === 0) return '';
  const parts = [];
  if (qS > 0) parts.push(`${qS} Serviceable`);
  if (qU > 0) parts.push(`${qU} Unserviceable`);
  if (qR > 0) parts.push(`${qR} In repair`);
  if (qC > 0) parts.push(`${qC} Calibration due`);
  if (qW > 0) parts.push(`${qW} Written off`);
  return parts.join(', ');
}

// -----------------------------------------------------------------------------
// Badge derivation
// -----------------------------------------------------------------------------
// Decides what the inventory list badge should say, given the line-level
// `condition` flag and the numeric `unsvc`/`onHand` counts. Returns
// { label, modifier } where modifier is the suffix for inv__cond--XXX.
//
// Behaviour matrix:
//   condition === 'written-off'     → red "Written off"
//   condition === 'repair'          → blue "In repair"
//   condition === 'calibration-due' → gold "Calibration due"
//   condition === 'unserviceable'   → red "Unserviceable" (line-level flag)
//   unsvc >= onHand && onHand > 0   → red "Unserviceable" (all units)
//   unsvc > 0                       → amber "Partially U/S"
//   condition === 'serviceable'     → green "Serviceable"
//   otherwise (no condition, etc.)  → grey "—"
//
// The "all units unsvc" case promotes the badge to red even when the
// line-level condition says serviceable — because at that point the
// line-level flag is lying about reality. This catches the common QM
// pattern of just bumping the Unsvc count when a unit goes bad without
// also flipping the dropdown.
//
// Exported for testability; not part of the public API.
export function _deriveCondition(condition, onHand, unsvc) {
  const oh = Number(onHand) || 0;
  const us = Number(unsvc)  || 0;

  // Explicit non-serviceable line-level flags trump numeric derivation.
  if (condition === 'written-off')     return { label: 'Written off',     modifier: 'written-off' };
  if (condition === 'repair')          return { label: 'In repair',       modifier: 'repair' };
  if (condition === 'calibration-due') return { label: 'Calibration due', modifier: 'calibration-due' };
  if (condition === 'unserviceable')   return { label: 'Unserviceable',   modifier: 'unserviceable' };

  // Numeric derivation for serviceable-flagged lines.
  if (oh > 0 && us >= oh) {
    // Every unit on the line is unserviceable — promote regardless of flag.
    return { label: 'Unserviceable', modifier: 'unserviceable' };
  }
  if (us > 0) {
    return { label: 'Partially U/S', modifier: 'partial-unsvc' };
  }

  if (condition === 'serviceable') return { label: 'Serviceable', modifier: 'serviceable' };

  // Unknown condition value (legacy data, typo) — render generically.
  return { label: condition || '—', modifier: 'unknown' };
}
