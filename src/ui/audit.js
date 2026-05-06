// =============================================================================
// QStore IMS v2 — Audit log viewer
// =============================================================================
// Read-only page that surfaces the existing Storage.audit API. Three roles
// it serves:
//   1. Routine review — "what happened in the Q-store this week?"
//   2. Investigation — "who issued LN-1234 and when?"
//   3. Tamper detection — "has anyone modified the audit log itself?"
//
// PERMISSIONS
//   audit — QM, OC. Cadets/staff/RO have no access (no nav entry).
//
// PAGINATION
//   Audit logs grow unbounded. Render at most PAGE_SIZE rows at a time and
//   surface a "Load more" affordance. Filtering happens server-side (well,
//   inside Storage.audit.list) so we don't have to hold the whole log in
//   memory.
//
// CHAIN VERIFICATION
//   Storage.audit.verify() walks the entire chain and reports the first
//   broken seq. We surface this prominently because a tampered log is the
//   single most important integrity signal the system has.
// =============================================================================

import * as Storage from '../storage.js';
import * as AUTH    from '../auth.js';
import { esc, $, $$, render, fmtDate } from './util.js';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const PAGE_SIZE = 200;

// Known action keys — kept in sync with the registry in
// docs/ARCHITECTURE.md. Adding an action means adding it here so it gets a
// sensible label in the filter dropdown. Unknown actions render with their
// raw key as the label, which is acceptable but ugly.
const ACTION_LABELS = Object.freeze({
  add:                     'Item added',
  adjust:                  'Item adjusted',
  cadet_add:               'Cadet added',
  cadet_update:            'Cadet updated',
  cadet_delete:            'Cadet deleted',
  issue:                   'Loan issued',
  return:                  'Loan returned',
  pin_change:              'PIN changed',
  recovery_set:            'Recovery code generated',
  recovery_rotated:        'Recovery code rotated',
  recovery_reset:          'PIN reset via recovery',
  recovery_reset_failed:   'Recovery reset attempt failed',
  data_export:             'Backup exported',
  data_imported:           'Backup restored',
  login:                   'Login',
  logout:                  'Logout',
  login_failed:            'Login failed',
});

// Action → CSS modifier. Categorises actions broadly: success / mutation /
// security / failure. Drives the badge colour.
const ACTION_CATEGORY = Object.freeze({
  add:                     'mutation',
  adjust:                  'mutation',
  cadet_add:               'mutation',
  cadet_update:            'mutation',
  cadet_delete:            'mutation',
  issue:                   'mutation',
  return:                  'mutation',
  pin_change:              'security',
  recovery_set:            'security',
  recovery_rotated:        'security',
  recovery_reset:          'security',
  recovery_reset_failed:   'failure',
  data_export:             'mutation',
  data_imported:           'mutation',
  login:                   'auth',
  logout:                  'auth',
  login_failed:            'failure',
});

// -----------------------------------------------------------------------------
// Module state
// -----------------------------------------------------------------------------

let _root        = null;
let _filter      = 'all';        // action key or 'all'
let _search      = '';
let _renderLimit = PAGE_SIZE;    // pagination cursor — grows on "Load more"
let _verifyState = null;         // { ok, count, brokenAt?, reason? } | null

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

export async function mount(rootEl) {
  AUTH.requirePermission('audit');
  _root        = rootEl;
  _filter      = 'all';
  _search      = '';
  _renderLimit = PAGE_SIZE;
  _verifyState = null;
  await _render();
  return function unmount() { _root = null; };
}

// -----------------------------------------------------------------------------
// Render
// -----------------------------------------------------------------------------

async function _render() {
  // Pull the full unfiltered list once. Storage.audit.list does a single
  // store-wide scan; doing it twice (once for the visible rows, once for
  // distinct-action computation) would double the cost. Instead, we read
  // once and apply filter+search in memory. This is acceptable because:
  //   - audit logs are small relative to other stores (text-only rows),
  //   - the alternative (two store reads) is genuinely slower on large
  //     logs because each read serialises through IndexedDB.
  // If logs ever grow into the hundreds of thousands of entries, revisit
  // by adding a count-distinct API to Storage.audit.
  const allRows = await Storage.audit.list({ order: 'desc' });
  const totalCount = allRows.length;

  const distinctActions = [...new Set(allRows.map((r) => r.action))]
    .sort((a, b) => (ACTION_LABELS[a] || a).localeCompare(ACTION_LABELS[b] || b));

  let filtered = allRows;
  if (_filter !== 'all') {
    filtered = filtered.filter((r) => r.action === _filter);
  }
  if (_search) {
    const q = _search.toLowerCase();
    filtered = filtered.filter((r) =>
      (r.desc   || '').toLowerCase().includes(q) ||
      (r.user   || '').toLowerCase().includes(q) ||
      (r.action || '').toLowerCase().includes(q));
  }
  const filteredLen = filtered.length;
  const visible     = filtered.slice(0, _renderLimit);

  render(_root, `
    <section class="aud">
      <header class="aud__toolbar">
        <div class="aud__filters">
          <input type="search"
                 class="aud__search"
                 placeholder="Search description, user, or action…"
                 aria-label="Search audit log"
                 value="${esc(_search)}">
          <select class="aud__action-filter" aria-label="Filter by action">
            <option value="all" ${_filter === 'all' ? 'selected' : ''}>All actions</option>
            ${distinctActions.map((a) =>
              `<option value="${esc(a)}" ${a === _filter ? 'selected' : ''}>${esc(ACTION_LABELS[a] || a)}</option>`
            ).join('')}
          </select>
        </div>
        <div class="aud__actions">
          <button type="button" class="btn btn--ghost" data-action="verify-chain">
            Verify chain integrity
          </button>
        </div>
      </header>

      ${_verifyBlockHtml(_verifyState)}

      <div class="aud__meta">
        ${filteredLen} ${filteredLen === 1 ? 'entry' : 'entries'} match
        ${(_filter !== 'all' || _search) && totalCount !== filteredLen
          ? `<span class="aud__meta-of"> of ${totalCount} total</span>`
          : ''}
      </div>

      <div class="aud__table-wrap">
        ${filteredLen === 0
          ? `<div class="aud__empty"><p>No audit entries match the current filters.</p></div>`
          : _tableHtml(visible)}
      </div>

      ${visible.length < filteredLen ? `
        <div class="aud__loadmore">
          <button type="button" class="btn btn--ghost" data-action="load-more">
            Load ${Math.min(PAGE_SIZE, filteredLen - visible.length)} more
            <span class="aud__loadmore-meta">(${visible.length} of ${filteredLen} shown)</span>
          </button>
        </div>
      ` : ''}
    </section>
  `);

  _wireEventListeners();
}

function _verifyBlockHtml(state) {
  if (!state) return '';
  if (state.ok) {
    return `
      <div class="aud__verify aud__verify--ok">
        <strong>Chain verified.</strong> All ${state.count} ${state.count === 1 ? 'entry is' : 'entries are'} intact.
        Each entry's hash matches its content, and each entry's prevHash
        matches its predecessor's hash &mdash; no rows have been added,
        removed, or modified since the audit key was generated at install.
      </div>`;
  }
  return `
    <div class="aud__verify aud__verify--bad">
      <strong>Chain integrity broken.</strong>
      The audit log has been tampered with. Verification failed at sequence
      number <code>${state.brokenAt}</code> &mdash; reason:
      <code>${esc(state.reason)}</code>.
      All entries from <code>${state.brokenAt}</code> onwards are
      suspect. Entries before <code>${state.brokenAt}</code> are still
      provably intact.
    </div>`;
}

function _tableHtml(rows) {
  return `
    <table class="aud__table">
      <thead>
        <tr>
          <th class="aud__col-seq">#</th>
          <th class="aud__col-time">When</th>
          <th class="aud__col-action">Action</th>
          <th class="aud__col-user">User</th>
          <th class="aud__col-desc">Description</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(_rowHtml).join('')}
      </tbody>
    </table>
  `;
}

function _rowHtml(row) {
  const label = ACTION_LABELS[row.action] || row.action;
  const cat   = ACTION_CATEGORY[row.action] || 'other';
  // Mark the row as below-break-point if verification has run and this
  // seq is at or after the broken point.
  const broken = _verifyState && !_verifyState.ok && row.seq >= _verifyState.brokenAt;
  return `
    <tr class="aud__row ${broken ? 'aud__row--broken' : ''}">
      <td class="aud__seq">${row.seq}</td>
      <td class="aud__time">${esc(fmtDate(row.ts))}</td>
      <td class="aud__action">
        <span class="aud__badge aud__badge--${esc(cat)}">${esc(label)}</span>
        ${row.imported ? `<span class="aud__badge aud__badge--imported">Imported</span>` : ''}
      </td>
      <td class="aud__user">${esc(row.user || '')}</td>
      <td class="aud__desc">${esc(row.desc || '')}</td>
    </tr>
  `;
}

// -----------------------------------------------------------------------------
// Event wiring
// -----------------------------------------------------------------------------

function _wireEventListeners() {
  $('.aud__search', _root)?.addEventListener('input', (e) => {
    _search = e.target.value;
    _renderLimit = PAGE_SIZE;   // reset pagination on filter change
    _render();
  });
  $('.aud__action-filter', _root)?.addEventListener('change', (e) => {
    _filter = e.target.value;
    _renderLimit = PAGE_SIZE;
    _render();
  });
  _root.addEventListener('click', _onRootClick);
}

async function _onRootClick(e) {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  switch (action) {
    case 'verify-chain': await _doVerify(e.target.closest('button')); break;
    case 'load-more':    _renderLimit += PAGE_SIZE; await _render(); break;
  }
}

async function _doVerify(button) {
  if (button) {
    button.disabled = true;
    button.textContent = 'Verifying…';
  }
  try {
    _verifyState = await Storage.audit.verify();
  } catch (err) {
    _verifyState = { ok: false, brokenAt: 0, reason: err.message || 'verify error', count: 0 };
  }
  await _render();
}
