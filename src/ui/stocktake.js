// =============================================================================
// QStore IMS v2 — Stocktake page
// =============================================================================
// One stocktake session at a time. Persistent draft in IndexedDB so
// counts survive a refresh / browser crash / overnight pause.
//
// FLOW
//   1. User starts a stocktake (or resumes a draft if one exists).
//   2. For each item: enter counts split by condition — Serviceable (Svc),
//      Unserviceable (U/S), and Written Off (W/O) — plus optional notes.
//      Each entry writes to Storage.stocktake on blur.
//   3. Live summary updates: counted / matches / discrepancies / missing.
//   4. Finalise: confirmation modal lists discrepancies → on confirm:
//      - For each item with a count: update item.onHand (total of all three
//        condition counts), item.unsvc (unserviceable count), item.writtenOff
//        (written-off count), push audit entry per discrepancy.
//      - Write-off items get a separate stocktake_writeoff audit entry.
//      - Push one finalisation audit entry with the totals.
//      - Clear the stocktake store.
//      - Offer to generate the stocktake report PDF.
//
// CONDITION BREAKDOWN SCHEMA (Storage.stocktake row)
//   Mirrors the five canonical conditions in conditions.js:
//     counted              — total physical count (sum of all five), for compat
//     qtyServiceable       — serviceable
//     qtyUnserviceable     — unserviceable (damaged / non-functional)
//     qtyRepair            — in repair (temporarily unserviceable)
//     qtyCalibrationDue    — calibration due (cannot be issued until calibrated)
//     qtyWrittenOff        — written-off (beyond repair, pending board of survey)
//   Legacy draft rows (without breakdown) default to svc = counted, rest = 0.
//
// ITEM FIELD UPDATES ON FINALISE
//   onHand     ← sum of all five qty fields (total physical count)
//   unsvc      ← qtyUnserviceable + qtyRepair + qtyCalibrationDue
//                (all items not currently ready for issue)
//   writtenOff ← qtyWrittenOff      (pending formal board of survey striking)
//
// WHAT THIS DOESN'T DO (deliberate)
//   - No multi-stage QM / CO sign-off workflow. The audit log is the
//     accountability layer; QM and CO sign the printed report by hand.
//   - No multi-counter / per-area assignment. One QM at a time per
//     stocktake. The countedBy field on each row is the session user.
//   - No "negative variance investigation" flow. Variance is recorded
//     in the audit description; investigation happens off-system.
//
// PERMISSIONS
//   View, edit, finalise: `editItem` permission (QM + above).
//   Read-only users see the page but can't enter counts.
// =============================================================================

import * as Storage from '../storage.js';
import * as AUTH    from '../auth.js';
import * as Sync    from '../sync.js';
import { generateStocktakeReport, generateStocktakeWorksheet, downloadPdf } from '../pdf.js';
import { openModal } from './modal.js';
import { esc, $, $$, render } from './util.js';
import { showToast } from './toast.js';

let _root = null;
let _categoryFilter = '';
// Cached lookup: itemId → stocktake row. Populated on each render so the
// per-row inputs initial-populate from persisted state without N IDB reads.
let _countsByItem = new Map();

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

export async function mount(rootEl) {
  AUTH.requirePermission('editItem');
  _root = rootEl;
  await _render();
}

// -----------------------------------------------------------------------------
// Render
// -----------------------------------------------------------------------------

async function _render() {
  const items   = await Storage.items.list({ category: _categoryFilter || undefined });
  items.sort((a, b) =>
    (a.cat  || '').localeCompare(b.cat  || '') ||
    (a.name || '').localeCompare(b.name || ''));

  const counts  = await Storage.stocktake.list();
  _countsByItem = new Map(counts.map((c) => [c.itemId, c]));

  // For category filter, derive from full item list (not the filtered view)
  // so the dropdown stays stable as the user filters.
  const allItems = _categoryFilter
    ? await Storage.items.list()
    : items;
  const categories = [...new Set(allItems.map((i) => i.cat).filter(Boolean))].sort();

  const session = _summariseSession(items);

  render(_root, `
    <section class="stk">
      ${_toolbarHtml(session, categories)}
      ${_summaryHtml(session)}
      ${_tableHtml(items)}
    </section>
  `);

  _wire();
}

function _toolbarHtml(session, categories) {
  const canEdit = AUTH.can('editItem');
  const startedAt = _countsByItem.size > 0
    ? _earliestCountedAt()
    : null;
  return `
    <header class="stk__toolbar">
      <div class="stk__status">
        ${_countsByItem.size > 0
          ? `<span class="stk__status-badge stk__status-badge--draft">Draft</span>
             <span class="stk__status-text">
               ${_countsByItem.size} item${_countsByItem.size === 1 ? '' : 's'} counted
               ${startedAt ? `&middot; started ${esc(startedAt)}` : ''}
             </span>`
          : `<span class="stk__status-badge stk__status-badge--idle">No active stocktake</span>
             <span class="stk__status-text">Enter counts below to begin.</span>`}
      </div>
      <div class="stk__actions">
        <select class="stk__cat" data-action="cat-filter" aria-label="Filter by category">
          <option value="">All categories</option>
          ${categories.map((c) => `
            <option value="${esc(c)}" ${c === _categoryFilter ? 'selected' : ''}>
              ${esc(c)}
            </option>`).join('')}
        </select>
        <button type="button" class="btn btn--ghost"
                data-action="print-worksheet"
                title="Print a blank counting sheet for this item list">
          ⎙ Worksheet
        </button>
        ${_countsByItem.size > 0 && canEdit ? `
          <button type="button" class="btn btn--ghost"
                  data-action="discard"
                  title="Clear all entered counts and start over">
            Discard draft
          </button>
        ` : ''}
        ${_countsByItem.size > 0 && canEdit ? `
          <button type="button" class="btn btn--primary"
                  data-action="finalise"
                  title="Apply counts to inventory and generate stocktake report">
            ✓ Finalise stocktake
          </button>
        ` : ''}
      </div>
    </header>
  `;
}

function _summaryHtml(session) {
  if (_countsByItem.size === 0) return '';
  return `
    <div class="stk__summary">
      <div class="stk__summary-tile stk__summary-tile--counted">
        <span class="stk__summary-num">${session.counted}</span>
        <span class="stk__summary-lbl">Counted</span>
      </div>
      <div class="stk__summary-tile stk__summary-tile--match">
        <span class="stk__summary-num">${session.match}</span>
        <span class="stk__summary-lbl">Match</span>
      </div>
      <div class="stk__summary-tile stk__summary-tile--over">
        <span class="stk__summary-num">${session.over}</span>
        <span class="stk__summary-lbl">Over</span>
      </div>
      <div class="stk__summary-tile stk__summary-tile--short">
        <span class="stk__summary-num">${session.short}</span>
        <span class="stk__summary-lbl">Short</span>
      </div>
    </div>
  `;
}

function _tableHtml(items) {
  const canEdit = AUTH.can('editItem');
  if (items.length === 0) {
    return `<div class="stk__empty">
      <p>No items match the current filter.</p>
    </div>`;
  }
  return `
    <div class="stk__table-wrap">
      <table class="stk__table">
        <thead>
          <tr>
            <th class="stk__col-nsn">NSN</th>
            <th class="stk__col-name">Item</th>
            <th class="stk__col-cat">Cat.</th>
            <th class="stk__col-num" title="Authorised quantity">Auth</th>
            <th class="stk__col-num" data-sys-col title="System on-hand count">On hand</th>
            <th class="stk__col-num" title="Currently on loan">On loan</th>
            <th class="stk__col-count" title="Serviceable — items in good working order">Svc</th>
            <th class="stk__col-count" title="Unserviceable — damaged or non-functional, awaiting repair">U/S</th>
            <th class="stk__col-count" title="In repair — temporarily unserviceable, currently being repaired">Repr</th>
            <th class="stk__col-count" title="Calibration due — must be calibrated before issue">Cal</th>
            <th class="stk__col-count" title="Written off — beyond economic repair, pending board of survey">W/O</th>
            <th class="stk__col-total">Total</th>
            <th class="stk__col-var">Variance</th>
            <th class="stk__col-notes">Notes</th>
          </tr>
        </thead>
        <tbody>
          ${items.map((item) => _itemRowHtml(item, canEdit)).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function _itemRowHtml(item, canEdit) {
  const stk   = _countsByItem.get(item.id);
  const notes = stk?.notes || '';
  const sys     = Number(item.onHand) || 0;
  const onLoan  = Number(item.onLoan) || 0;
  const authQty = Number(item.authQty) || 0;

  // Condition breakdown — default legacy rows to: svc = counted, rest = 0.
  const qtyS = stk
    ? (stk.qtyServiceable    != null ? stk.qtyServiceable    : stk.counted ?? '')
    : '';
  const qtyU = stk ? (stk.qtyUnserviceable  ?? 0) : '';
  const qtyR = stk ? (stk.qtyRepair         ?? 0) : '';
  const qtyC = stk ? (stk.qtyCalibrationDue ?? 0) : '';
  const qtyW = stk ? (stk.qtyWrittenOff     ?? 0) : '';

  // Total — only compute when at least one field has a value.
  const hasCount = stk != null;
  const total    = hasCount
    ? (Number(qtyS) || 0) + (Number(qtyU) || 0) + (Number(qtyR) || 0) +
      (Number(qtyC) || 0) + (Number(qtyW) || 0)
    : null;

  const variance = total == null ? null : total - sys;
  const varClass = variance === null ? 'stk__var--none'
    : variance === 0 ? 'stk__var--match'
    : variance < 0   ? 'stk__var--short'
    : 'stk__var--over';
  const varText  = variance === null ? '—' : (variance >= 0 ? `+${variance}` : `${variance}`);

  return `
    <tr class="stk__row" data-item-id="${esc(item.id)}" data-sys="${sys}">
      <td class="stk__col-nsn">${esc(item.nsn || '')}</td>
      <td class="stk__col-name">${esc(item.name || '')}</td>
      <td class="stk__col-cat">${esc(item.cat || '')}</td>
      <td class="stk__col-num">${authQty}</td>
      <td class="stk__col-num">${sys}</td>
      <td class="stk__col-num">${onLoan}</td>

      <td class="stk__col-count">
        <input type="number" min="0" inputmode="numeric"
               class="stk__count-svc"
               value="${hasCount ? esc(String(qtyS)) : ''}"
               placeholder="—"
               data-field="qty-svc"
               ${canEdit ? '' : 'disabled'}
               aria-label="Serviceable count">
      </td>
      <td class="stk__col-count">
        <input type="number" min="0" inputmode="numeric"
               class="stk__count-uns"
               value="${hasCount ? esc(String(qtyU)) : ''}"
               placeholder="—"
               data-field="qty-uns"
               ${canEdit ? '' : 'disabled'}
               aria-label="Unserviceable count">
      </td>
      <td class="stk__col-count">
        <input type="number" min="0" inputmode="numeric"
               class="stk__count-repr"
               value="${hasCount ? esc(String(qtyR)) : ''}"
               placeholder="—"
               data-field="qty-repr"
               ${canEdit ? '' : 'disabled'}
               aria-label="In-repair count">
      </td>
      <td class="stk__col-count">
        <input type="number" min="0" inputmode="numeric"
               class="stk__count-cal"
               value="${hasCount ? esc(String(qtyC)) : ''}"
               placeholder="—"
               data-field="qty-cal"
               ${canEdit ? '' : 'disabled'}
               aria-label="Calibration-due count">
      </td>
      <td class="stk__col-count">
        <input type="number" min="0" inputmode="numeric"
               class="stk__count-wof"
               value="${hasCount ? esc(String(qtyW)) : ''}"
               placeholder="—"
               data-field="qty-wof"
               ${canEdit ? '' : 'disabled'}
               aria-label="Written-off count">
      </td>

      <td class="stk__col-total stk__total" data-target="total-cell">
        ${total != null ? String(total) : '—'}
      </td>
      <td class="stk__col-var ${varClass}" data-target="var-cell">${varText}</td>
      <td class="stk__col-notes">
        <input type="text" maxlength="200"
               class="stk__notes"
               value="${esc(notes)}"
               placeholder="—"
               data-field="notes"
               ${canEdit ? '' : 'disabled'}
               aria-label="Notes">
      </td>
    </tr>
  `;
}

// -----------------------------------------------------------------------------
// Wire
// -----------------------------------------------------------------------------

function _wire() {
  $('[data-action="cat-filter"]', _root)?.addEventListener('change', async (e) => {
    _categoryFilter = e.target.value;
    await _render();
  });

  $('[data-action="print-worksheet"]', _root)?.addEventListener('click', _onPrintWorksheet);
  $('[data-action="discard"]', _root)?.addEventListener('click', _onDiscard);
  $('[data-action="finalise"]', _root)?.addEventListener('click', _onFinalise);

  // Per-row input handlers. Use blur rather than input for IDB writes.
  // For count inputs we ALSO listen to input so Total/Variance cells update
  // live as the user types without writing to IDB on every keystroke.
  const countFields = ['qty-svc', 'qty-uns', 'qty-repr', 'qty-cal', 'qty-wof'];
  for (const field of countFields) {
    $$(`input[data-field="${field}"]`, _root).forEach((input) => {
      input.addEventListener('input',  _onCountInput);
      input.addEventListener('change', _onCountChange);
      input.addEventListener('blur',   _onCountChange);
    });
  }
  $$('input[data-field="notes"]', _root).forEach((input) => {
    input.addEventListener('change', _onNotesChange);
    input.addEventListener('blur',   _onNotesChange);
  });
}

// -----------------------------------------------------------------------------
// Per-row event handlers
// -----------------------------------------------------------------------------

// Helper: read all five condition count inputs from a row and return their
// numeric values. Mirrors the five entries in CONDITIONS (conditions.js).
function _readBreakdown(row) {
  const svc  = row.querySelector('input[data-field="qty-svc"]')?.value.trim()  ?? '';
  const uns  = row.querySelector('input[data-field="qty-uns"]')?.value.trim()  ?? '';
  const repr = row.querySelector('input[data-field="qty-repr"]')?.value.trim() ?? '';
  const cal  = row.querySelector('input[data-field="qty-cal"]')?.value.trim()  ?? '';
  const wof  = row.querySelector('input[data-field="qty-wof"]')?.value.trim()  ?? '';
  return {
    allEmpty: svc === '' && uns === '' && repr === '' && cal === '' && wof === '',
    qtyServiceable:    svc  === '' ? 0 : Math.max(0, Number(svc)  || 0),
    qtyUnserviceable:  uns  === '' ? 0 : Math.max(0, Number(uns)  || 0),
    qtyRepair:         repr === '' ? 0 : Math.max(0, Number(repr) || 0),
    qtyCalibrationDue: cal  === '' ? 0 : Math.max(0, Number(cal)  || 0),
    qtyWrittenOff:     wof  === '' ? 0 : Math.max(0, Number(wof)  || 0),
  };
}

// While typing, update Total and Variance cells live without touching IDB.
function _onCountInput(e) {
  const row = e.target.closest('.stk__row');
  if (!row) return;
  const sys        = Number(row.dataset.sys) || 0;
  const bd         = _readBreakdown(row);
  const totalCell  = row.querySelector('[data-target="total-cell"]');
  const varCell    = row.querySelector('[data-target="var-cell"]');

  if (bd.allEmpty) {
    if (totalCell) totalCell.textContent = '—';
    if (varCell)   { varCell.textContent = '—'; varCell.className = 'stk__col-var stk__var--none'; }
    return;
  }

  const total = bd.qtyServiceable + bd.qtyUnserviceable + bd.qtyRepair +
                bd.qtyCalibrationDue + bd.qtyWrittenOff;
  const v     = total - sys;
  if (totalCell) totalCell.textContent = String(total);
  if (varCell)   {
    varCell.textContent = v >= 0 ? `+${v}` : `${v}`;
    varCell.className = 'stk__col-var ' + (
      v === 0 ? 'stk__var--match' : v < 0 ? 'stk__var--short' : 'stk__var--over');
  }
}

async function _onCountChange(e) {
  const row    = e.target.closest('.stk__row');
  if (!row) return;
  const itemId = row.dataset.itemId;
  const bd     = _readBreakdown(row);

  if (bd.allEmpty) {
    // All three inputs cleared → remove the draft row entirely.
    if (_countsByItem.has(itemId)) {
      await Storage.stocktake.remove(itemId);
      _countsByItem.delete(itemId);
      await _refreshChrome();
    }
    return;
  }

  // Clear any invalid markers.
  row.querySelectorAll('.stk__count--invalid').forEach((el) => el.classList.remove('stk__count--invalid'));

  const total    = bd.qtyServiceable + bd.qtyUnserviceable + bd.qtyRepair +
                   bd.qtyCalibrationDue + bd.qtyWrittenOff;
  const existing = _countsByItem.get(itemId) || {};

  await Storage.stocktake.set(itemId, total, {
    countedBy:         AUTH.getSession()?.name || 'unknown',
    notes:             existing.notes || '',
    qtyServiceable:    bd.qtyServiceable,
    qtyUnserviceable:  bd.qtyUnserviceable,
    qtyRepair:         bd.qtyRepair,
    qtyCalibrationDue: bd.qtyCalibrationDue,
    qtyWrittenOff:     bd.qtyWrittenOff,
  });

  _countsByItem.set(itemId, {
    ...existing,
    itemId,
    counted:           total,
    qtyServiceable:    bd.qtyServiceable,
    qtyUnserviceable:  bd.qtyUnserviceable,
    qtyRepair:         bd.qtyRepair,
    qtyCalibrationDue: bd.qtyCalibrationDue,
    qtyWrittenOff:     bd.qtyWrittenOff,
    countedAt: new Date().toISOString(),
  });
  await _refreshChrome();
  Sync.notifyChanged();
}

async function _onNotesChange(e) {
  const input    = e.target;
  const row      = input.closest('.stk__row');
  if (!row) return;
  const itemId   = row.dataset.itemId;
  const existing = _countsByItem.get(itemId);
  if (!existing) return;  // Notes without a count are lost — no orphan UI needed.
  await Storage.stocktake.set(itemId, existing.counted, {
    countedBy:         AUTH.getSession()?.name || 'unknown',
    notes:             input.value,
    qtyServiceable:    existing.qtyServiceable    ?? existing.counted ?? 0,
    qtyUnserviceable:  existing.qtyUnserviceable   ?? 0,
    qtyRepair:         existing.qtyRepair          ?? 0,
    qtyCalibrationDue: existing.qtyCalibrationDue  ?? 0,
    qtyWrittenOff:     existing.qtyWrittenOff      ?? 0,
  });
  existing.notes = input.value;
  Sync.notifyChanged();
}

// -----------------------------------------------------------------------------
// Toolbar/summary refresh — minimum repaint that doesn't steal focus
// -----------------------------------------------------------------------------

async function _refreshChrome() {
  // Re-derive session shape from the cache map (not from IDB — we just
  // wrote to IDB and to the map; they agree).
  const items = await Storage.items.list({ category: _categoryFilter || undefined });
  const categories = [...new Set((await Storage.items.list()).map((i) => i.cat).filter(Boolean))].sort();
  const session = _summariseSession(items);

  // Replace just the toolbar and summary chrome.
  const newToolbar = _toolbarHtml(session, categories);
  const newSummary = _summaryHtml(session);

  const oldToolbar = $('.stk__toolbar', _root);
  const oldSummary = $('.stk__summary', _root);

  if (oldToolbar) oldToolbar.outerHTML = newToolbar;
  if (oldSummary) {
    oldSummary.outerHTML = newSummary;
  } else if (newSummary) {
    // Insert summary if it didn't exist before (first count entered).
    const newToolbarEl = $('.stk__toolbar', _root);
    if (newToolbarEl) newToolbarEl.insertAdjacentHTML('afterend', newSummary);
  }

  // Re-bind toolbar listeners (table listeners are still alive because
  // we didn't touch the table).
  $('[data-action="cat-filter"]', _root)?.addEventListener('change', async (e) => {
    _categoryFilter = e.target.value;
    await _render();
  });
  $('[data-action="print-worksheet"]', _root)?.addEventListener('click', _onPrintWorksheet);
  $('[data-action="discard"]', _root)?.addEventListener('click', _onDiscard);
  $('[data-action="finalise"]', _root)?.addEventListener('click', _onFinalise);
}

// -----------------------------------------------------------------------------
// Print worksheet
// -----------------------------------------------------------------------------

async function _onPrintWorksheet() {
  const btn = _root.querySelector('[data-action="print-worksheet"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Building PDF…'; }
  try {
    const items    = await Storage.items.list({ category: _categoryFilter || undefined });
    const settings = await Storage.settings.getAll();
    const unit     = settings || {};
    const result   = await generateStocktakeWorksheet(items, {
      unit,
      category: _categoryFilter,
    });
    downloadPdf(result);
  } catch (err) {
    showToast('Could not generate worksheet: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⎙ Worksheet'; }
  }
}

// -----------------------------------------------------------------------------
// Discard
// -----------------------------------------------------------------------------

async function _onDiscard() {
  AUTH.requirePermission('editItem');
  if (_countsByItem.size === 0) return;
  openModal({
    titleHtml: 'Discard stocktake draft?',
    size:      'sm',
    bodyHtml: `
      <p class="modal__body">
        This will clear all entered counts (${_countsByItem.size} item${_countsByItem.size === 1 ? '' : 's'})
        and start over. Cannot be undone.
      </p>
      <div class="form__actions">
        <button type="button" class="btn btn--ghost"  data-action="modal-close">Cancel</button>
        <button type="button" class="btn btn--danger" data-action="confirm-discard">Discard draft</button>
      </div>
    `,
    onMount(panel, close) {
      $('[data-action="confirm-discard"]', panel)?.addEventListener('click', async () => {
        try {
          await Storage.stocktake.clear();
          await Storage.audit.append({
            action: 'stocktake_discard',
            user:   AUTH.getSession()?.name || 'unknown',
            desc:   `Stocktake draft discarded (${_countsByItem.size} item${_countsByItem.size === 1 ? '' : 's'} cleared).`,
          });
          _countsByItem.clear();
          close();
          await _render();
          Sync.notifyChanged();
        } catch (err) {
          showToast('Discard failed: ' + (err.message || err), 'error');
        }
      });
    },
  });
}

// -----------------------------------------------------------------------------
// Finalise
// -----------------------------------------------------------------------------

async function _onFinalise() {
  AUTH.requirePermission('editItem');
  if (_countsByItem.size === 0) return;

  // Pre-compute the diff so the confirmation modal can show it.
  const allItems = await Storage.items.list();
  const itemsById = new Map(allItems.map((i) => [i.id, i]));

  const matches = [];
  const overs   = [];
  const shorts  = [];

  for (const [itemId, stk] of _countsByItem) {
    const item = itemsById.get(itemId);
    if (!item) continue;   // item deleted mid-stocktake (rare)
    const v = Number(stk.counted) - (Number(item.onHand) || 0);
    if (v === 0) matches.push({ item, stk });
    else if (v > 0) overs.push({ item, stk, v });
    else shorts.push({ item, stk, v });
  }

  openModal({
    titleHtml: 'Finalise stocktake — confirm',
    size:      'md',
    bodyHtml: `
      <p class="modal__body">
        Applying counts will update on-hand quantities and write audit
        entries for each discrepancy. The draft will be cleared.
      </p>
      <ul class="stk__finalise-summary">
        <li><strong>${matches.length}</strong> matching count${matches.length === 1 ? '' : 's'}</li>
        <li class="stk__var--over">  <strong>${overs.length}</strong>  over (count higher than system)</li>
        <li class="stk__var--short"> <strong>${shorts.length}</strong> short (count lower than system)</li>
      </ul>
      ${(overs.length + shorts.length) > 0 ? `
        <details class="stk__finalise-detail">
          <summary>${overs.length + shorts.length} discrepanc${overs.length + shorts.length === 1 ? 'y' : 'ies'} — review</summary>
          <table class="stk__finalise-table">
            <thead>
              <tr><th>Item</th><th>System</th><th>Svc</th><th>U/S</th><th>Repr</th><th>Cal</th><th>W/O</th><th>Total</th><th>Variance</th></tr>
            </thead>
            <tbody>
              ${[...overs, ...shorts].map(({ item, stk, v }) => {
                const qtyS = stk.qtyServiceable    != null ? Number(stk.qtyServiceable)    : Number(stk.counted) || 0;
                const qtyU = stk.qtyUnserviceable  != null ? Number(stk.qtyUnserviceable)  : 0;
                const qtyR = stk.qtyRepair         != null ? Number(stk.qtyRepair)         : 0;
                const qtyC = stk.qtyCalibrationDue != null ? Number(stk.qtyCalibrationDue) : 0;
                const qtyW = stk.qtyWrittenOff     != null ? Number(stk.qtyWrittenOff)     : 0;
                const total = qtyS + qtyU + qtyR + qtyC + qtyW;
                const variance = total - (Number(item.onHand) || 0);
                return `
                  <tr>
                    <td>${esc(item.name)} ${item.nsn ? `<span class="stk__nsn-inline">${esc(item.nsn)}</span>` : ''}</td>
                    <td>${item.onHand || 0}</td>
                    <td>${qtyS}</td>
                    <td>${qtyU || '—'}</td>
                    <td>${qtyR || '—'}</td>
                    <td>${qtyC || '—'}</td>
                    <td>${qtyW > 0 ? `<strong>${qtyW}</strong>` : '—'}</td>
                    <td>${total}</td>
                    <td class="${variance > 0 ? 'stk__var--over' : 'stk__var--short'}">${variance > 0 ? '+' : ''}${variance}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </details>
      ` : ''}
      <div class="form__actions">
        <button type="button" class="btn btn--ghost"   data-action="modal-close">Cancel</button>
        <button type="button" class="btn btn--primary" data-action="confirm-finalise">
          ✓ Finalise & generate report
        </button>
      </div>
    `,
    onMount(panel, close) {
      $('[data-action="confirm-finalise"]', panel)?.addEventListener('click', async (e) => {
        const btn = e.target;
        btn.disabled = true;
        btn.textContent = 'Finalising…';
        try {
          const sessionMeta = await _doFinalise(matches, overs, shorts, itemsById);
          close();
          await _render();
          // Offer report download. Build before the post-finalise re-render
          // so we still have the session's row data in scope.
          await _offerReportDownload(sessionMeta);
        } catch (err) {
          showToast('Finalisation failed: ' + (err.message || err), 'error');
          btn.disabled = false;
          btn.textContent = '✓ Finalise & generate report';
        }
      });
    },
  });
}

async function _doFinalise(matches, overs, shorts, itemsById) {
  const userName    = AUTH.getSession()?.name || 'unknown';
  const finalisedAt = new Date().toISOString();
  const reportRows  = [];
  let totalWriteOffs = 0;

  // 1. Apply each counted item: update onHand, unsvc, writtenOff + condition.
  for (const { item, stk, v } of [...matches, ...overs, ...shorts]) {
    // Breakdown fields — support legacy draft rows that only have `counted`.
    const qtyS = stk.qtyServiceable    != null ? Number(stk.qtyServiceable)    : Number(stk.counted) || 0;
    const qtyU = stk.qtyUnserviceable  != null ? Number(stk.qtyUnserviceable)  : 0;
    const qtyR = stk.qtyRepair         != null ? Number(stk.qtyRepair)         : 0;
    const qtyC = stk.qtyCalibrationDue != null ? Number(stk.qtyCalibrationDue) : 0;
    const qtyW = stk.qtyWrittenOff     != null ? Number(stk.qtyWrittenOff)     : 0;
    const total = qtyS + qtyU + qtyR + qtyC + qtyW;

    // Derive item condition from the breakdown — highest-severity condition
    // present wins. This replaces the old manual condition-dropdown override.
    const derivedCondition = qtyW > 0 ? 'written-off'
      : qtyR > 0 ? 'repair'
      : qtyC > 0 ? 'calibration-due'
      : qtyU > 0 ? 'unserviceable'
      : 'serviceable';

    const updated = {
      ...item,
      onHand:            Math.max(0, total),
      // unsvc = all items not ready for issue: U/S + In Repair + Cal Due
      unsvc:             Math.max(0, qtyU + qtyR + qtyC),
      writtenOff:        Math.max(0, qtyW),
      condition:         derivedCondition,
      // Store the full granular breakdown so inventory page can report accurately.
      qtyServiceable:    Math.max(0, qtyS),
      qtyUnserviceable:  Math.max(0, qtyU),
      qtyRepair:         Math.max(0, qtyR),
      qtyCalibrationDue: Math.max(0, qtyC),
      qtyWrittenOff:     Math.max(0, qtyW),
      lastStocktakeAt:   finalisedAt,
      updatedAt:         finalisedAt,
    };
    await Storage.items.put(updated);

    // Audit per-discrepancy. Matches rolled up in summary.
    const variance = total - (Number(item.onHand) || 0);
    if (variance !== 0) {
      const parts = [];
      if (qtyS > 0) parts.push(`Svc:${qtyS}`);
      if (qtyU > 0) parts.push(`U/S:${qtyU}`);
      if (qtyR > 0) parts.push(`Repr:${qtyR}`);
      if (qtyC > 0) parts.push(`Cal:${qtyC}`);
      if (qtyW > 0) parts.push(`W/O:${qtyW}`);
      const condBreakdown = parts.length > 1 ? ` [${parts.join(' ')}]` : '';
      await Storage.audit.append({
        action: 'stocktake_adjust',
        user:   userName,
        desc:   `Stocktake: ${item.name}` +
                (item.nsn ? ` (${item.nsn})` : '') +
                ` system:${item.onHand || 0} counted:${total}${condBreakdown} variance:${variance >= 0 ? '+' : ''}${variance}` +
                (stk.notes ? ` — ${stk.notes}` : ''),
      });
    }

    // Write-off entries get their own audit entry for visibility.
    if (qtyW > 0) {
      totalWriteOffs += qtyW;
      await Storage.audit.append({
        action: 'stocktake_writeoff',
        user:   userName,
        desc:   `Write-off recorded: ${item.name}` +
                (item.nsn ? ` (${item.nsn})` : '') +
                ` — ${qtyW} item${qtyW === 1 ? '' : 's'} beyond economic repair, pending board of survey.` +
                (stk.notes ? ` Notes: ${stk.notes}` : ''),
      });
    }

    reportRows.push({
      item: updated,
      stk:  { ...stk, qtyServiceable: qtyS, qtyUnserviceable: qtyU, qtyRepair: qtyR, qtyCalibrationDue: qtyC, qtyWrittenOff: qtyW, counted: total },
      variance,
    });
  }

  // 2. One summary audit entry.
  await Storage.audit.append({
    action: 'stocktake_finalise',
    user:   userName,
    desc:   `Stocktake finalised: ${matches.length + overs.length + shorts.length} counted, ` +
            `${matches.length} match, ${overs.length} over, ${shorts.length} short` +
            (totalWriteOffs > 0 ? `, ${totalWriteOffs} write-off item${totalWriteOffs === 1 ? '' : 's'} recorded` : '') + '.',
  });

  // 3. Clear the draft.
  await Storage.stocktake.clear();
  _countsByItem.clear();

  Sync.notifyChanged();

  return {
    finalisedAt,
    finalisedBy: userName,
    rows: reportRows,
    counts: {
      total:  reportRows.length,
      match:  matches.length,
      over:   overs.length,
      short:  shorts.length,
      writeOffs: totalWriteOffs,
    },
  };
}

async function _offerReportDownload(sessionMeta) {
  openModal({
    titleHtml: 'Stocktake finalised',
    size:      'sm',
    bodyHtml: `
      <p class="modal__body">
        ${sessionMeta.counts.total} item${sessionMeta.counts.total === 1 ? '' : 's'} counted:
        ${sessionMeta.counts.match} match,
        ${sessionMeta.counts.over} over,
        ${sessionMeta.counts.short} short
        ${sessionMeta.counts.writeOffs > 0
          ? `, <strong>${sessionMeta.counts.writeOffs} write-off item${sessionMeta.counts.writeOffs === 1 ? '' : 's'} flagged</strong> (see audit log)`
          : ''}.
        Inventory and audit log updated.
      </p>
      <div class="form__actions">
        <button type="button" class="btn btn--ghost" data-action="modal-close">Skip report</button>
        <button type="button" class="btn btn--primary" data-action="download-report">
          Download stocktake report
        </button>
      </div>
    `,
    onMount(panel, close) {
      $('[data-action="download-report"]', panel)?.addEventListener('click', async (e) => {
        const btn = e.target;
        btn.disabled = true;
        btn.textContent = 'Building PDF…';
        try {
          const unit = await Storage.settings.getAll();
          const result = await generateStocktakeReport(sessionMeta, { unit });
          downloadPdf(result);
          close();
        } catch (err) {
          showToast('Report generation failed: ' + (err.message || err), 'error');
          btn.disabled = false;
          btn.textContent = 'Download stocktake report';
        }
      });
    },
  });
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function _summariseSession(items) {
  // Iterate the cache map; for each counted itemId, classify against the
  // current item's onHand. Items in the map but not in the items list
  // (filtered out by category) still count toward overall totals — the
  // toolbar/summary always reflect the WHOLE session, not the filtered
  // view. The user filtering by category shouldn't change "you've
  // counted 47 items so far".
  let counted = 0, match = 0, over = 0, short = 0;
  // Need full item list for accurate matches even when filtered.
  const allItemsById = new Map();
  // We don't have the all-items list here; use what's been hydrated into
  // the cache (counts already reference itemIds we can look up via items
  // when present). Items in the visible list dominate; out-of-filter
  // counts are still totalled.
  for (const stk of _countsByItem.values()) {
    counted++;
    // Try to find the corresponding item in the visible list. If filter
    // hides it, we still count toward "counted" but skip variance class
    // (we don't have the system qty in scope).
    const item = items.find((i) => i.id === stk.itemId);
    if (!item) continue;
    const v = Number(stk.counted) - (Number(item.onHand) || 0);
    if (v === 0) match++;
    else if (v > 0) over++;
    else short++;
  }
  return { counted, match, over, short };
}

function _earliestCountedAt() {
  let earliest = null;
  for (const stk of _countsByItem.values()) {
    if (!stk.countedAt) continue;
    if (earliest == null || stk.countedAt < earliest) earliest = stk.countedAt;
  }
  if (!earliest) return null;
  // Format as relative time at low precision.
  const d = new Date(earliest);
  return d.toLocaleString('en-AU', {
    day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}
