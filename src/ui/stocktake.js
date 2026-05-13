// =============================================================================
// QStore IMS v2 — Stocktake page
// =============================================================================
// One stocktake session at a time. Persistent draft in IndexedDB so
// counts survive a refresh / browser crash / overnight pause.
//
// FLOW
//   1. User starts a stocktake (or resumes a draft if one exists).
//   2. For each item: enter physical count + optional condition override
//      + optional notes. Each entry writes to Storage.stocktake on blur.
//   3. Live summary updates: counted / matches / discrepancies / missing.
//   4. Finalise: confirmation modal lists discrepancies → on confirm:
//      - For each item with a count: update item.onHand, item.condition,
//        push audit entry per discrepancy.
//      - Push one finalisation audit entry with the totals.
//      - Clear the stocktake store.
//      - Offer to generate the stocktake report PDF.
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
import { generateStocktakeReport, downloadPdf } from '../pdf.js';
import { openModal } from './modal.js';
import { esc, $, $$, render } from './util.js';
import { CONDITIONS } from '../conditions.js';
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
    <table class="stk__table">
      <thead>
        <tr>
          <th class="stk__col-nsn">NSN</th>
          <th class="stk__col-name">Item</th>
          <th class="stk__col-cat">Cat.</th>
          <th class="stk__col-num">Auth</th>
          <th class="stk__col-num">On hand</th>
          <th class="stk__col-num">On loan</th>
          <th class="stk__col-count">Counted</th>
          <th class="stk__col-var">Variance</th>
          <th class="stk__col-cond">Condition</th>
          <th class="stk__col-notes">Notes</th>
        </tr>
      </thead>
      <tbody>
        ${items.map((item) => _itemRowHtml(item, canEdit)).join('')}
      </tbody>
    </table>
  `;
}

function _itemRowHtml(item, canEdit) {
  const stk      = _countsByItem.get(item.id);
  const counted  = stk ? stk.counted : '';
  const condVal  = stk?.condition || item.condition || 'serviceable';
  const notes    = stk?.notes || '';
  const sys      = Number(item.onHand) || 0;
  const onLoan   = Number(item.onLoan) || 0;
  const authQty  = Number(item.authQty) || 0;

  const variance = (counted === '' || counted == null)
    ? null
    : Number(counted) - sys;
  const varClass = variance === null ? 'stk__var--none'
    : variance === 0 ? 'stk__var--match'
    : variance < 0 ? 'stk__var--short'
    : 'stk__var--over';
  const varText  = variance === null ? '—' : (variance >= 0 ? `+${variance}` : `${variance}`);

  return `
    <tr class="stk__row" data-item-id="${esc(item.id)}">
      <td class="stk__col-nsn">${esc(item.nsn || '')}</td>
      <td class="stk__col-name">${esc(item.name || '')}</td>
      <td class="stk__col-cat">${esc(item.cat || '')}</td>
      <td class="stk__col-num">${authQty}</td>
      <td class="stk__col-num">${sys}</td>
      <td class="stk__col-num">${onLoan}</td>
      <td class="stk__col-count">
        <input type="number" min="0" inputmode="numeric"
               class="stk__count"
               value="${esc(String(counted))}"
               placeholder="—"
               data-field="counted"
               ${canEdit ? '' : 'disabled'}
               aria-label="Counted quantity">
      </td>
      <td class="stk__col-var ${varClass}">${varText}</td>
      <td class="stk__col-cond">
        <select class="stk__cond" data-field="condition" ${canEdit ? '' : 'disabled'}>
          ${CONDITIONS.map((c) => `
            <option value="${esc(c.value)}" ${c.value === condVal ? 'selected' : ''}>
              ${esc(c.label)}
            </option>`).join('')}
        </select>
      </td>
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

  $('[data-action="discard"]', _root)?.addEventListener('click', _onDiscard);
  $('[data-action="finalise"]', _root)?.addEventListener('click', _onFinalise);

  // Per-row input handlers. Use blur (and change for selects) rather than
  // input — blur fires after the user is done editing, which keeps IDB
  // writes from happening on every keystroke. For select dropdowns,
  // change is the natural event. The price is a brief window where the
  // user has typed but not blurred and a refresh could lose it; in
  // practice that window is small and the simpler model is worth it.
  //
  // For the count input we ALSO listen to input so the variance updates
  // visually as the user types — but we only persist on blur.
  $$('input[data-field="counted"]', _root).forEach((input) => {
    input.addEventListener('input',  _onCountInput);
    input.addEventListener('change', _onCountChange);
    input.addEventListener('blur',   _onCountChange);
  });
  $$('select[data-field="condition"]', _root).forEach((sel) => {
    sel.addEventListener('change', _onConditionChange);
  });
  $$('input[data-field="notes"]', _root).forEach((input) => {
    input.addEventListener('change', _onNotesChange);
    input.addEventListener('blur',   _onNotesChange);
  });
}

// -----------------------------------------------------------------------------
// Per-row event handlers
// -----------------------------------------------------------------------------

// While typing, update the variance cell live without touching IDB.
function _onCountInput(e) {
  const input = e.target;
  const row = input.closest('.stk__row');
  if (!row) return;
  const itemId = row.dataset.itemId;
  const sys = Number(row.cells[4].textContent.trim()) || 0;
  const counted = input.value.trim();
  const varCell = row.querySelector('.stk__col-var');
  if (counted === '') {
    varCell.textContent = '—';
    varCell.className = 'stk__col-var stk__var--none';
    return;
  }
  const v = Number(counted) - sys;
  varCell.textContent = v >= 0 ? `+${v}` : `${v}`;
  varCell.className = 'stk__col-var ' + (
    v === 0 ? 'stk__var--match' : v < 0 ? 'stk__var--short' : 'stk__var--over');
}

async function _onCountChange(e) {
  const input = e.target;
  const row = input.closest('.stk__row');
  if (!row) return;
  const itemId = row.dataset.itemId;
  const raw = input.value.trim();

  if (raw === '') {
    // Empty count → remove the row from the session entirely. User
    // cleared their entry; we shouldn't pretend they counted 0.
    if (_countsByItem.has(itemId)) {
      await Storage.stocktake.remove(itemId);
      _countsByItem.delete(itemId);
      // Re-render the toolbar/summary which depend on session shape, but
      // not the whole table — that would steal focus from neighbouring
      // inputs.
      await _refreshChrome();
    }
    return;
  }

  const counted = Number(raw);
  if (!Number.isFinite(counted) || counted < 0) {
    input.classList.add('stk__count--invalid');
    return;
  }
  input.classList.remove('stk__count--invalid');

  const existing = _countsByItem.get(itemId) || {};
  await Storage.stocktake.set(itemId, counted, {
    countedBy: AUTH.getSession()?.name || 'unknown',
    condition: existing.condition || null,
    notes:     existing.notes || '',
  });

  // Mirror back to the cache so the next render reads the fresh values.
  _countsByItem.set(itemId, {
    ...(existing),
    itemId,
    counted,
    countedAt: new Date().toISOString(),
  });
  await _refreshChrome();
  Sync.notifyChanged();
}

async function _onConditionChange(e) {
  const sel = e.target;
  const row = sel.closest('.stk__row');
  if (!row) return;
  const itemId = row.dataset.itemId;
  const existing = _countsByItem.get(itemId);
  // If no count entered yet, condition change alone doesn't create a
  // session row — the count is the trigger. Without a count, finalisation
  // doesn't act on this row, so a condition override would be lost.
  // Tell the user via a soft warning rather than silently doing nothing.
  if (!existing) {
    sel.classList.add('stk__cond--orphan');
    sel.title = 'Enter a count to record this condition change.';
    return;
  }
  sel.classList.remove('stk__cond--orphan');
  await Storage.stocktake.set(itemId, existing.counted, {
    countedBy: AUTH.getSession()?.name || 'unknown',
    condition: sel.value,
    notes:     existing.notes || '',
  });
  existing.condition = sel.value;
  Sync.notifyChanged();
}

async function _onNotesChange(e) {
  const input = e.target;
  const row = input.closest('.stk__row');
  if (!row) return;
  const itemId = row.dataset.itemId;
  const existing = _countsByItem.get(itemId);
  if (!existing) {
    // Same orphan case as condition. Notes without a count are lost.
    return;
  }
  await Storage.stocktake.set(itemId, existing.counted, {
    countedBy: AUTH.getSession()?.name || 'unknown',
    condition: existing.condition || null,
    notes:     input.value,
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
  $('[data-action="discard"]', _root)?.addEventListener('click', _onDiscard);
  $('[data-action="finalise"]', _root)?.addEventListener('click', _onFinalise);
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
              <tr><th>Item</th><th>System</th><th>Counted</th><th>Variance</th></tr>
            </thead>
            <tbody>
              ${[...overs, ...shorts].map(({ item, stk, v }) => `
                <tr>
                  <td>${esc(item.name)} ${item.nsn ? `<span class="stk__nsn-inline">${esc(item.nsn)}</span>` : ''}</td>
                  <td>${item.onHand || 0}</td>
                  <td>${stk.counted}</td>
                  <td class="${v > 0 ? 'stk__var--over' : 'stk__var--short'}">${v > 0 ? '+' : ''}${v}</td>
                </tr>
              `).join('')}
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
  const userName = AUTH.getSession()?.name || 'unknown';
  const finalisedAt = new Date().toISOString();

  // Snapshot rows BEFORE clearing, so the report has the data.
  const reportRows = [];

  // 1. Apply each counted item: update onHand + condition.
  for (const { item, stk } of [...matches, ...overs, ...shorts]) {
    const v = Number(stk.counted) - (Number(item.onHand) || 0);
    const updated = {
      ...item,
      onHand:    Math.max(0, Number(stk.counted)),
      condition: stk.condition || item.condition,
      lastStocktakeAt: finalisedAt,
      updatedAt: finalisedAt,
    };
    await Storage.items.put(updated);

    // Audit per-discrepancy. Matches don't generate per-row entries —
    // they're rolled up in the finalisation entry below. This matches
    // v1's approach and keeps the audit log readable.
    if (v !== 0) {
      await Storage.audit.append({
        action: 'stocktake_adjust',
        user:   userName,
        desc:   `Stocktake: ${item.name}` +
                (item.nsn ? ` (${item.nsn})` : '') +
                ` system:${item.onHand} counted:${stk.counted} variance:${v >= 0 ? '+' : ''}${v}` +
                (stk.notes ? ` — ${stk.notes}` : ''),
      });
    }

    reportRows.push({ item: updated, stk, variance: v });
  }

  // 2. One summary audit entry.
  await Storage.audit.append({
    action: 'stocktake_finalise',
    user:   userName,
    desc:   `Stocktake finalised: ${matches.length + overs.length + shorts.length} counted, ` +
            `${matches.length} match, ${overs.length} over, ${shorts.length} short.`,
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
    },
  };
}

async function _offerReportDownload(sessionMeta) {
  openModal({
    titleHtml: 'Stocktake finalised',
    size:      'sm',
    bodyHtml: `
      <p class="modal__body">
        ${sessionMeta.counts.total} item${sessionMeta.counts.total === 1 ? '' : 's'} counted.
        ${sessionMeta.counts.match} match,
        ${sessionMeta.counts.over} over,
        ${sessionMeta.counts.short} short.
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
