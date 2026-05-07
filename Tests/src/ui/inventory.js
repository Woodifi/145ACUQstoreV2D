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
import { openModal }   from './modal.js';
import { esc, $, $$, render, fmtDate, ObjectURLPool } from './util.js';

// -----------------------------------------------------------------------------
// Constants — categories and conditions
// -----------------------------------------------------------------------------
// TODO: when a Settings page is built (v2.1+), these should move to
// settings storage so units can extend the lists. For now they're hard-
// coded matching v1 plus the calibration-due addition.

export const CATEGORIES = [
  'Uniform', 'Equipment', 'Safety', 'Training Aids',
  'Field Stores', 'Medical', 'ICT',
];

export const CONDITIONS = [
  { value: 'serviceable',      label: 'Serviceable'      },
  { value: 'unserviceable',    label: 'Unserviceable'    },
  { value: 'repair',           label: 'In repair'        },
  { value: 'calibration-due',  label: 'Calibration due'  },
  { value: 'written-off',      label: 'Written off'      },
];

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

  const totalItems = await Storage.items.count();

  render(_root, `
    <section class="inv">
      <header class="inv__toolbar">
        <div class="inv__filters">
          <input type="search"
                 class="inv__search"
                 placeholder="Search NSN, name, or category…"
                 aria-label="Search inventory"
                 value="${esc(_searchTerm)}">
          <select class="inv__cat-filter" aria-label="Filter by category">
            <option value="">All categories</option>
            ${CATEGORIES.map(c =>
              `<option value="${esc(c)}" ${c === _categoryFilter ? 'selected' : ''}>${esc(c)}</option>`
            ).join('')}
          </select>
        </div>
        <div class="inv__actions">
          ${canAdd ? `<button type="button" class="btn btn--primary" data-action="add">+ Add item</button>` : ''}
        </div>
      </header>

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
      ${(canEdit || canDel) ? `<th class="inv__col-actions" aria-label="Actions"></th>` : ''}
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

  const condDef = CONDITIONS.find(c => c.value === item.condition);
  const condLabel = condDef ? condDef.label : (item.condition || '—');
  const condCss   = `inv__cond inv__cond--${esc((item.condition || 'unknown').replace(/\s+/g, '-'))}`;

  const photoCell = photoUrl
    ? `<img class="inv__thumb" src="${esc(photoUrl)}" alt="" loading="lazy"
            data-action="photo" data-item-id="${esc(item.id)}"
            title="Click to change photo">`
    : `<button type="button" class="inv__thumb-placeholder" aria-label="Add photo"
               data-action="photo" data-item-id="${esc(item.id)}"
               title="Click to upload photo">📷</button>`;

  const actionsCell = (canEdit || canDel) ? `
    <td class="inv__col-actions">
      <div class="inv__row-actions">
        ${canEdit ? `<button type="button" class="btn btn--sm btn--ghost"
                              data-action="edit" data-item-id="${esc(item.id)}">Edit</button>` : ''}
        ${canDel  ? `<button type="button" class="btn btn--sm btn--danger"
                              data-action="delete" data-item-id="${esc(item.id)}">Delete</button>` : ''}
      </div>
    </td>` : '';

  return `
    <tr class="inv__row">
      <td class="inv__col-nsn"><span class="inv__nsn">${esc(item.nsn || '—')}</span></td>
      <td class="inv__col-photo">${photoCell}</td>
      <td class="inv__col-name">
        <div class="inv__name">${esc(item.name || '')}</div>
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
      <td class="inv__col-cond"><span class="${condCss}">${esc(condLabel)}</span></td>
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
  const target = e.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  const itemId = target.dataset.itemId;

  switch (action) {
    case 'add':
      if (AUTH.can('addItem')) await _openAddModal();
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
  }
}

// -----------------------------------------------------------------------------
// Add / Edit modal
// -----------------------------------------------------------------------------

async function _openAddModal() {
  AUTH.requirePermission('addItem');
  _openItemFormModal({ mode: 'add', item: null });
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

function _openItemFormModal({ mode, item }) {
  const isEdit = mode === 'edit';
  const title  = isEdit ? `Edit item — ${esc(item.name || item.id)}` : 'Add inventory item';

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
              ${CATEGORIES.map(c =>
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
                   value="${esc(item?.onHand ?? (isEdit ? 0 : 1))}">
          </label>
          ${isEdit ? `
          <label class="form__field">
            <span class="form__label">Unsvc</span>
            <input type="number" name="unsvc" min="0" step="1" inputmode="numeric"
                   value="${esc(item?.unsvc ?? 0)}">
          </label>` : ''}
        </div>
        <div class="form__row">
          <label class="form__field form__field--grow">
            <span class="form__label">Condition</span>
            <select name="condition">
              ${CONDITIONS.map(c =>
                `<option value="${esc(c.value)}" ${c.value === (item?.condition || 'serviceable') ? 'selected' : ''}>${esc(c.label)}</option>`
              ).join('')}
            </select>
          </label>
          <label class="form__field form__field--grow">
            <span class="form__label">Location</span>
            <input type="text" name="loc" maxlength="80"
                   value="${esc(item?.loc || '')}"
                   placeholder="e.g. Bay 3, Shelf A">
          </label>
        </div>
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
    onMount(panel, close) {
      const form = $('form[data-form="item"]', panel);
      const errEl = $('.form__error', panel);
      const nsnInput = $('input[name="nsn"]', panel);
      const nsnHint  = $('[data-hint="nsn"]', panel);

      // Live NSN format hint.
      const updateNsnHint = () => {
        const v = nsnInput.value.trim();
        if (!v) { nsnHint.textContent = ''; return; }
        nsnHint.textContent = NSN_PATTERN.test(v)
          ? '✓ Standard format'
          : 'Non-standard format (will be accepted as a local NSN)';
        nsnHint.className = 'form__hint ' + (NSN_PATTERN.test(v) ? 'is-good' : 'is-warn');
      };
      nsnInput.addEventListener('input', updateNsnHint);
      updateNsnHint();

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
  const unsvc   = isEdit ? _readNonNegInt(fd, 'unsvc', 'Unsvc') : 0;

  return {
    nsn, name,
    cat:        String(fd.get('cat') || 'Equipment'),
    authQty, onHand, unsvc,
    condition:  String(fd.get('condition') || 'serviceable'),
    loc:        String(fd.get('loc')   || '').trim(),
    notes:      String(fd.get('notes') || '').trim(),
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
  const id = 'I' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const item = {
    id,
    nsn:        data.nsn,
    name:       data.name,
    cat:        data.cat,
    authQty:    data.authQty,
    onHand:     data.onHand,
    onLoan:     0,
    unsvc:      0,
    condition:  data.condition,
    loc:        data.loc,
    notes:      data.notes,
    hasPhoto:   false,
    createdAt:  new Date().toISOString(),
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
    nsn:       data.nsn,
    name:      data.name,
    cat:       data.cat,
    authQty:   data.authQty,
    onHand:    data.onHand,
    unsvc:     data.unsvc,
    condition: data.condition,
    loc:       data.loc,
    notes:     data.notes,
    updatedAt: new Date().toISOString(),
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
  // Tiny non-blocking error reporter. For now, alert(); in a future round
  // we'll add a proper toast component.
  alert(message);  // eslint-disable-line no-alert
}
