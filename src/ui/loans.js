// =============================================================================
// QStore IMS v2 — Loans page (Issue / Return / All loans)
// =============================================================================
// Single page with three internal tabs. The data model is one loan = one
// item (matching v1) — when the QM issues 3 items in a single transaction,
// the page creates 3 loan records as a batch sharing the same borrower
// and issueDate, which a future AB189 generator can group by borrower+date
// to print one form per batch.
//
// LOAN RECORD SHAPE (matches v1; do not change without migration)
//   ref            'LN-NNNN' from counters.next('loan')
//   itemId         FK to items
//   itemName       denormalised at issue time — preserves history if the
//                  item is later renamed
//   nsn            denormalised likewise
//   qty            integer > 0
//   borrowerSvc    FK to cadets
//   borrowerName   denormalised: '<rank> <surname>' at issue time
//   purpose        free text from a fixed list (Initial Issue, etc.)
//   issueDate      'YYYY-MM-DD' — date-only, local
//   dueDate        'YYYY-MM-DD'
//   condition      'serviceable' at issue (item condition copied)
//   remarks        optional free text
//   active         true while outstanding
//   returnDate     'YYYY-MM-DD' set on return (also clears active)
//   returnCondition  'serviceable' | 'unserviceable' | 'write-off'
//   returnRemarks    optional
//
// PERMISSIONS
//   View         'view'         — anyone logged in sees the All Loans tab
//   Issue tab    'issue'        — OC + QM
//   Return tab   'return'       — OC + QM
//   Inline view-only loans for ordinary users land in v2.2; for now the
//   Issue/Return tabs are simply hidden when the perm is missing.
//
// ATOMICITY CAVEAT
//   Issuing/returning touches three stores: items, loans, audit. Storage
//   doesn't currently expose a multi-store transaction API for these, so
//   the writes are sequential. The order is: item update first (failure
//   blocks the loan creation), then loan put, then audit append. Worst
//   case if a crash happens mid-sequence: stock is updated but the audit
//   log is missing the entry. The existence of the loan record itself is
//   recoverable evidence. Fixing this properly needs a Storage API change
//   (atomic multi-put) — backlogged, not a v2.1 blocker.
// =============================================================================

import * as Storage from '../storage.js';
import * as AUTH    from '../auth.js';
import * as Sync    from '../sync.js';
import { compareRanks } from '../ranks.js';
import { generateIssueVoucher, generateAB189, generateOutstandingLoansReport, downloadPdf } from '../pdf.js';
import { openModal }                       from './modal.js';
import { showToast }                       from './toast.js';
import { openKitPicker }                   from './kits.js';
import { esc, $, $$, render, fmtDateOnly } from './util.js';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

// The Initial Issue purpose is special: it auto-sets a 6-year return date
// (matching the cadet engagement period) and is protected from deletion in
// the settings category manager.
export const INITIAL_ISSUE = 'Initial Issue';

// Same set v1 used. If a unit needs others, they pick 'Other' and put a
// note in remarks. Future settings page could make these editable per-unit.
const PURPOSES = [
  INITIAL_ISSUE,
  'Annual Camp',
  'Training Activity',
  'Parade Night',
  'Field Exercise',
  'Ceremonial',
  'Course Attendance',
  'Other',
];

// Return-condition values used at return time. The on-loan stock comes off
// the borrower regardless; unserviceable/write-off ALSO bumps item.unsvc so
// the inventory page reflects the lost serviceability.
const RETURN_CONDITIONS = [
  { value: 'serviceable',   label: 'Serviceable' },
  { value: 'unserviceable', label: 'Unserviceable (needs repair)' },
  { value: 'write-off',     label: 'Write-off (beyond repair)' },
];

// Tab definitions. Permissions gate visibility; if a tab is hidden the
// user lands on the next visible tab to the right (typically All Loans).
const TABS = [
  { key: 'issue',  label: 'Issue',     perm: 'issue'  },
  { key: 'return', label: 'Return',    perm: 'return' },
  { key: 'all',    label: 'All loans', perm: 'view'   },
];

// -----------------------------------------------------------------------------
// Module state
// -----------------------------------------------------------------------------

let _root        = null;
let _activeTab   = null;          // 'issue' | 'return' | 'all'
let _allFilter   = 'active';      // 'active' | 'returned' | 'overdue' | 'all'
let _allSearch   = '';
let _allBorrower = '';            // svcNo of selected borrower, '' = show all
let _allSelected = new Set();     // refs of loans selected for bulk return
let _defaultDueDays = 7;          // loaded from settings on each issue-tab render

// Issue-tab transient state — the in-progress batch of lines, plus the
// borrower selection. Reset on submit or when the user switches away.
let _issueState  = null;          // { svcNo, lines: [{itemId, qty}, ...] }

// Return-tab transient state — the borrower selection and which of their
// active loans are checked for return.
let _returnState = null;          // { svcNo, refsChecked: Set }

// -----------------------------------------------------------------------------
// Mount / unmount
// -----------------------------------------------------------------------------

export async function mount(rootEl) {
  AUTH.requirePermission('view');
  _root        = rootEl;
  _allFilter   = 'active';
  _allSearch   = '';
  _allBorrower = '';
  _allSelected.clear();
  _issueState  = _freshIssueState();
  _returnState = _freshReturnState();
  _activeTab   = _firstAllowedTab();
  await _render();
  return function unmount() { _root = null; };
}

function _freshIssueState()  {
  return { svcNo: '', lines: [_freshLine()], longTermLoan: false, unitLoan: false, activityName: '', purpose: '' };
}
function _freshReturnState() { return { svcNo: '', refsChecked: new Set() }; }
function _freshLine()        {
  return { itemId: '', qty: 1, nonStock: false, nonStockDesc: '', nonStockNsn: '', lineNotes: '', existingLoan: false };
}

function _firstAllowedTab() {
  for (const t of TABS) if (AUTH.can(t.perm)) return t.key;
  return 'all';
}

// -----------------------------------------------------------------------------
// Render — top-level shell + active tab body
// -----------------------------------------------------------------------------

async function _render() {
  const visibleTabs = TABS.filter((t) => AUTH.can(t.perm));
  if (!visibleTabs.find((t) => t.key === _activeTab)) {
    _activeTab = visibleTabs[0]?.key || 'all';
  }

  render(_root, `
    <section class="loan">
      <nav class="loan__tabs" role="tablist">
        ${visibleTabs.map((t) => `
          <button type="button"
                  class="loan__tab ${t.key === _activeTab ? 'loan__tab--active' : ''}"
                  data-action="tab" data-tab="${esc(t.key)}"
                  role="tab" aria-selected="${t.key === _activeTab}">
            ${esc(t.label)}
          </button>`).join('')}
      </nav>
      <div class="loan__body" data-tab-body="${esc(_activeTab)}">
        <!-- tab body filled in below -->
      </div>
    </section>
  `);

  const body = $('.loan__body', _root);
  if (_activeTab === 'issue')  await _renderIssueTab(body);
  else if (_activeTab === 'return') await _renderReturnTab(body);
  else await _renderAllTab(body);

  _wireTopLevelEvents();
}

function _wireTopLevelEvents() {
  // Tab clicks bubble up here. Tab-body click handlers are wired by the
  // per-tab render functions, scoped to their own subtree.
  $$('.loan__tab', _root).forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      if (tab === _activeTab) return;
      _activeTab = tab;
      _render();
    });
  });
}

// =============================================================================
// ISSUE TAB
// =============================================================================

async function _renderIssueTab(body) {
  AUTH.requirePermission('issue');

  // Load the configured default loan duration (days). Falls back to 7 if not set.
  const dueDaysSetting = await Storage.settings.get('loans.defaultDueDays');
  _defaultDueDays = (dueDaysSetting != null && !isNaN(parseInt(dueDaysSetting, 10)))
    ? parseInt(dueDaysSetting, 10)
    : 7;

  const [cadets, staffList] = await Promise.all([Storage.cadets.list(), Storage.staff.list()]);
  const items  = await Storage.items.list();
  const activeCadets = [...cadets.filter((c) => c.active !== false), ...staffList.filter((s) => s.active !== false)];

  // Resolve the currently-selected borrower (if any) so we can show their
  // name and any existing active loans alongside the form.
  const allPersonnel = [...cadets, ...staffList];
  const borrower = _issueState.svcNo
    ? allPersonnel.find((c) => c.svcNo === _issueState.svcNo) || null
    : null;
  const borrowerActiveLoans = borrower
    ? (await Storage.loans.listForCadet(borrower.svcNo)).filter((l) => l.active === true)
    : [];

  // All items with computed availability (avail = onHand - onLoan).
  // We include out-of-stock items so the QM can see what's in the kit but
  // can't be issued from stock — they can substitute or use non-stock override.
  const allItemsWithAvail = items.map((i) => ({
    ...i,
    _avail: Math.max(0, (Number(i.onHand) || 0) - (Number(i.onLoan) || 0)),
  }));

  body.innerHTML = `
    <div class="loan__issue">
      <div class="loan__issue-form">

        <h3 class="loan__heading">1. Borrower</h3>
        <label class="loan__unit-loan-toggle">
          <input type="checkbox" data-issue-field="unitLoan"
                 ${_issueState.unitLoan ? 'checked' : ''}>
          <span>Unit / Activity loan</span>
          <span class="form__hint">Tick for hired items or equipment assigned to an activity rather than an individual.</span>
        </label>
        ${_issueState.unitLoan
          ? `<label class="form__field">
               <span class="form__label">Activity / description *</span>
               <input type="text" name="activityName" data-issue-field="activityName"
                      maxlength="120" placeholder="e.g. Annual Camp 2026 — Abseiling gear"
                      value="${esc(_issueState.activityName)}">
             </label>`
          : _borrowerPickerHtml('issue', _issueState.svcNo, activeCadets, borrower)
        }

        <h3 class="loan__heading">2. Items
          <button type="button" class="btn btn--ghost btn--sm loan__load-kit"
                  data-action="load-kit" title="Pre-fill with a saved kit">⊞ Load kit</button>
        </h3>
        ${_issueLinesHtml(_issueState.lines, allItemsWithAvail)}

        <h3 class="loan__heading">3. Issue details</h3>
        ${(() => {
          const isInitIssue = _issueState.purpose === INITIAL_ISSUE;
          // Initial Issue forces a 6-year return date; long-term toggle is irrelevant.
          const ltlActive   = _issueState.longTermLoan && !isInitIssue;
          const dueDefault  = isInitIssue ? _sixYearsFromToday() : _defaultDueDate();
          return `
          <div class="form__row">
            <label class="form__field form__field--grow">
              <span class="form__label">Purpose *</span>
              <select name="purpose" data-issue-field="purpose">
                ${PURPOSES.map((p) => `<option value="${esc(p)}"${p === _issueState.purpose ? ' selected' : ''}>${esc(p)}</option>`).join('')}
              </select>
            </label>
            <label class="form__field loan__due-date-field"
                   style="${ltlActive ? 'opacity:0.4;pointer-events:none' : ''}">
              <span class="form__label">Due date${ltlActive ? '' : ' *'}</span>
              <input type="date" name="dueDate" data-issue-field="dueDate"
                     value="${esc(ltlActive ? '' : dueDefault)}"
                     ${ltlActive ? 'disabled' : 'required'}
                     ${isInitIssue ? 'readonly' : ''}>
              ${isInitIssue
                ? `<span class="form__hint loan__ii-hint">6-year engagement period — auto-calculated</span>`
                : ''}
            </label>
          </div>
          <label class="loan__longterm-toggle"
                 style="${isInitIssue ? 'opacity:0.4;pointer-events:none' : ''}">
            <input type="checkbox" data-issue-field="longTermLoan"
                   ${ltlActive ? 'checked' : ''}
                   ${isInitIssue ? 'disabled' : ''}>
            <span>Long-term loan (no return date)</span>
            <span class="form__hint">For indefinite loans with no fixed return date.</span>
          </label>`;
        })()}
        <label class="form__field">
          <span class="form__label">Notes</span>
          <textarea name="remarks" rows="2" maxlength="400"
                    data-issue-field="remarks"
                    placeholder="optional — e.g. Annual camp kit, size details"></textarea>
        </label>

        <div class="form__error" data-issue-error role="alert"></div>
        <div class="form__actions">
          <button type="button" class="btn btn--ghost" data-action="issue-reset">Reset form</button>
          <button type="button" class="btn btn--primary" data-action="issue-submit">
            Issue ${_issueState.lines.length} ${_issueState.lines.length === 1 ? 'item' : 'items'}
          </button>
        </div>
      </div>

      ${borrower ? `
        <aside class="loan__sidebar">
          <h4 class="loan__sidebar-title">${esc(borrower.rank)} ${esc(borrower.surname)}</h4>
          <p class="loan__sidebar-meta">Service No. ${esc(borrower.svcNo)} · Plt ${esc(borrower.plt || '—')}</p>
          ${borrowerActiveLoans.length > 0 ? `
            <h5 class="loan__sidebar-subhead">Currently holding</h5>
            <ul class="loan__sidebar-list">
              ${borrowerActiveLoans.map((l) => `
                <li>
                  <span class="loan__sidebar-ref">${esc(l.ref)}</span>
                  ${esc(l.itemName)} × ${l.qty}
                  <span class="loan__sidebar-due">due ${esc(l.dueDate)}</span>
                </li>`).join('')}
            </ul>
          ` : `
            <p class="loan__sidebar-empty">No active loans.</p>
          `}
        </aside>
      ` : ''}
    </div>
  `;

  _wireIssueTab(body, activeCadets, allItemsWithAvail);
}

function _issueLinesHtml(lines, availableItems) {
  return `
    <div class="loan__lines" data-issue-lines>
      ${lines.map((line, i) => _issueLineHtml(line, i, availableItems)).join('')}
    </div>
    <button type="button" class="btn btn--ghost btn--sm" data-action="issue-add-line">
      + Add another item
    </button>
  `;
}

function _issueLineHtml(line, index, allItems) {
  // Both stock and non-stock modes share the same row structure:
  //   [main field (grow)] [qty (fixed)] [remove / spacer (fixed)]
  // This keeps all rows aligned regardless of mode.
  // The NSN input (non-stock) lives in the opts area, not the top row.
  //
  // existingLoan mode: item IS in IMS, onLoan increments on issue but
  // onHand is NOT decreased (the item was already out before Q-Store).
  // Returns restore onHand. Mutually exclusive with nonStock.

  const isExisting = !line.nonStock && !!line.existingLoan;
  const item       = line.nonStock ? null : (line.itemId ? allItems.find((i) => i.id === line.itemId) : null);
  const avail      = item ? item._avail : 0;
  const outOfStock = item && avail === 0;

  const labelRow = index === 0
    ? `<div class="loan__line-labels">
         <span class="loan__line-label-main">${line.nonStock ? 'Item description *' : 'Item *'}</span>
         <span class="loan__line-label-qty">Qty *</span>
       </div>`
    : '';

  // Stock badge — suppressed in existingLoan mode (no stock deduction occurs)
  let stockBadge = '';
  if (!line.nonStock && item) {
    if (isExisting) {
      stockBadge = `<span class="form__hint loan__stock-badge loan__stock-badge--existing"
                          title="This item was issued before Q-Store was set up. On Hand is unchanged — only On Loan increases.">↕ Existing issue — stock not deducted</span>`;
    } else if (outOfStock) {
      stockBadge = `<span class="form__hint loan__stock-badge loan__stock-badge--nil"
                          title="No units currently on hand. Issuing will record the loan against this inventory item with qty shown as On Loan.">⚠ None on hand — will record as On Loan</span>`;
    } else {
      stockBadge = `<span class="form__hint loan__stock-badge">${avail} available</span>`;
    }
  }

  const mainInput = line.nonStock
    ? `<input type="text" data-line-field="nonStockDesc"
              class="loan__item-search"
              placeholder="e.g. Hat, Bush / Boots Pair"
              value="${esc(line.nonStockDesc || '')}"
              autocomplete="off">`
    : `<input type="text" data-line-field="itemSearch"
              class="loan__item-search"
              placeholder="Search items by name or NSN…"
              value="${esc(item ? item.name + ' (' + (item.nsn || 'no NSN') + ')' : '')}"
              autocomplete="off"
              list="loan-item-list-${index}">
       <datalist id="loan-item-list-${index}">
         ${allItems.map((i) =>
           `<option value="${esc(i.name)} (${esc(i.nsn || 'no NSN')})"
                    data-id="${esc(i.id)}"
                    data-avail="${i._avail}">`).join('')}
       </datalist>
       <input type="hidden" data-line-field="itemId" value="${esc(line.itemId)}">
       ${stockBadge}`;

  const optsNsn = line.nonStock
    ? `<label class="loan__line-nsn-field">
         <input type="text" data-line-field="nonStockNsn"
                placeholder="NSN (optional, e.g. 0000-00-000-0000)"
                value="${esc(line.nonStockNsn || '')}"
                autocomplete="off" spellcheck="false" style="font-size:12px">
       </label>`
    : '';

  // Non-stock checkbox — disabled when existingLoan is active (mutually exclusive)
  const optsNonstockLabel = line.nonStock
    ? `<label class="loan__line-nonstock-lbl loan__line-nonstock-lbl--on">
         <input type="checkbox" data-line-field="nonStock" data-line-index="${index}" checked>
         Non-stock item
       </label>
       <span class="loan__line-nonstock-hint">Not from IMS stock — inventory updated on return if NSN matches.</span>`
    : `<label class="loan__line-nonstock-lbl"
              title="Use this for items not recorded in the inventory — e.g. items on order, unit-sourced equipment">
         <input type="checkbox" data-line-field="nonStock" data-line-index="${index}"
                ${isExisting ? 'disabled' : ''}>
         Non-stock item
       </label>`;

  // Existing-loan checkbox — only shown for IMS lines (not non-stock).
  // Disabled when nonStock is checked; mutually exclusive.
  const optsExistingLoan = !line.nonStock
    ? `<label class="loan__line-existing-lbl"
             title="Tick if this item was already issued before Q-Store was set up. Records the loan and increases On Loan — but does NOT deduct On Hand.">
         <input type="checkbox" data-line-field="existingLoan" data-line-index="${index}"
                ${isExisting ? 'checked' : ''}>
         Record existing issue (no stock deduction)
       </label>
       ${isExisting ? `<span class="loan__line-existing-hint">On Hand is unchanged. On Loan increases to maintain accountability. Stock is restored when returned.</span>` : ''}`
    : '';

  return `
    <div class="loan__line ${line.nonStock ? 'loan__line--nonstock' : ''} ${isExisting ? 'loan__line--existing' : ''}" data-line-index="${index}">
      ${labelRow}
      <div class="loan__line-row">
        <div class="loan__line-main">
          ${mainInput}
        </div>
        <label class="loan__qty-field">
          <input type="number" data-line-field="qty"
                 value="${line.qty}" min="1" step="1">
        </label>
        ${index > 0
          ? `<button type="button" class="btn btn--sm btn--ghost loan__line-remove"
                     data-action="issue-remove-line" data-line-index="${index}"
                     aria-label="Remove this line">×</button>`
          : '<span class="loan__line-spacer"></span>'}
      </div>
      <div class="loan__line-opts">
        ${optsNonstockLabel}
        ${optsExistingLoan}
        ${optsNsn}
        <label class="form__field loan__line-notes-field">
          <input type="text" data-line-field="lineNotes"
                 placeholder="Notes (optional)"
                 value="${esc(line.lineNotes || '')}"
                 maxlength="200">
        </label>
      </div>
    </div>
  `;
}

function _wireIssueTab(body, activeCadets, allItems) {
  // Unit-loan toggle — swaps cadet picker for activity text field.
  const unitLoanCb = $('input[data-issue-field="unitLoan"]', body);
  unitLoanCb?.addEventListener('change', () => {
    _issueState.unitLoan = unitLoanCb.checked;
    _issueState.svcNo = '';
    _render();
  });

  // Long-term loan toggle — disables due-date field (blocked when Initial Issue selected).
  const ltlCb = $('input[data-issue-field="longTermLoan"]', body);
  ltlCb?.addEventListener('change', () => {
    _issueState.longTermLoan = ltlCb.checked;
    _render();
  });

  // Purpose select — when Initial Issue is chosen, auto-set 6-year due date.
  const purposeSelect = $('select[data-issue-field="purpose"]', body);
  const dueDateInput  = $('input[data-issue-field="dueDate"]', body);
  purposeSelect?.addEventListener('change', () => {
    const prev    = _issueState.purpose;
    const next    = purposeSelect.value;
    _issueState.purpose = next;

    if (next === INITIAL_ISSUE) {
      // Force long-term off (re-render handles the UI state)
      if (_issueState.longTermLoan) {
        _issueState.longTermLoan = false;
        _render();
        return; // _render re-creates the form and re-runs _wireIssueTab
      }
      // Directly update the date input — no re-render needed (avoids losing item lines)
      if (dueDateInput) {
        dueDateInput.value    = _sixYearsFromToday();
        dueDateInput.readOnly = true;
        dueDateInput.removeAttribute('disabled');
      }
    } else if (prev === INITIAL_ISSUE) {
      // Leaving Initial Issue — restore editable date
      if (dueDateInput) {
        dueDateInput.value    = _defaultDueDate();
        dueDateInput.readOnly = false;
      }
      _render(); // re-render to re-enable long-term toggle, remove II hint
    }
  });

  // Borrower picker (cadet mode).
  const borrowerInput  = $('input[data-borrower-search="issue"]', body);
  const borrowerHidden = $('input[data-borrower-id="issue"]', body);
  const _onBorrowerChange = () => {
    const val   = borrowerInput.value;
    const match = activeCadets.find((c) =>
      `${c.rank} ${c.surname} (${c.svcNo})` === val);
    borrowerHidden.value = match ? match.svcNo : '';
    if (match && match.svcNo !== _issueState.svcNo) {
      _issueState.svcNo = match.svcNo;
      _render();
    }
  };
  borrowerInput?.addEventListener('input',  _onBorrowerChange);
  borrowerInput?.addEventListener('change', _onBorrowerChange);

  // Activity name input (unit-loan mode) — keep state in sync on blur.
  const activityInput = $('input[data-issue-field="activityName"]', body);
  activityInput?.addEventListener('input', () => {
    _issueState.activityName = activityInput.value;
  });

  // Per-line wiring.
  $$('.loan__line', body).forEach((lineEl) => {
    const idx = Number(lineEl.dataset.lineIndex);

    // Non-stock toggle.
    const nonStockCb = $('input[data-line-field="nonStock"]', lineEl);
    nonStockCb?.addEventListener('change', () => {
      const line       = _issueState.lines[idx];
      const turningOn  = nonStockCb.checked;
      line.nonStock    = turningOn;
      if (turningOn) {
        // Pre-populate description from the currently selected IMS item so
        // the user doesn't have to retype a name they've already picked.
        if (!line.nonStockDesc && line.itemId) {
          const currentItem = allItems.find((i) => i.id === line.itemId);
          if (currentItem) line.nonStockDesc = currentItem.name;
        }
        line.itemId       = '';
        line.existingLoan = false;   // mutually exclusive
      }
      line.nonStockNsn = '';
      // Intentionally preserve lineNotes across the toggle.
      _render();
    });

    // Existing-loan toggle — IMS item linked but stock NOT deducted on issue.
    const existingLoanCb = $('input[data-line-field="existingLoan"]', lineEl);
    existingLoanCb?.addEventListener('change', () => {
      _issueState.lines[idx].existingLoan = existingLoanCb.checked;
      if (existingLoanCb.checked) {
        _issueState.lines[idx].nonStock = false;   // mutually exclusive
      }
      _render();
    });

    if (_issueState.lines[idx]?.nonStock) {
      // Non-stock fields.
      $('input[data-line-field="nonStockDesc"]', lineEl)?.addEventListener('input', (e) => {
        _issueState.lines[idx].nonStockDesc = e.target.value;
      });
      $('input[data-line-field="nonStockNsn"]', lineEl)?.addEventListener('input', (e) => {
        _issueState.lines[idx].nonStockNsn = e.target.value;
      });
    } else {
      // Standard stock-item fields.
      const itemSearch = $('input[data-line-field="itemSearch"]', lineEl);
      const itemHidden = $('input[data-line-field="itemId"]', lineEl);
      const qtyInput   = $('input[data-line-field="qty"]', lineEl);

      itemSearch?.addEventListener('input', () => {
        const val   = itemSearch.value;
        const match = allItems.find((i) => `${i.name} (${i.nsn || 'no NSN'})` === val);
        itemHidden.value = match ? match.id : '';
        if (match) {
          _issueState.lines[idx].itemId = match.id;
          // Re-render to show updated stock badge (available qty or "None on hand").
          _render();
        } else {
          _issueState.lines[idx].itemId = '';
        }
      });

      qtyInput?.addEventListener('input', () => {
        const n = Number(qtyInput.value);
        if (Number.isFinite(n) && n > 0) _issueState.lines[idx].qty = Math.floor(n);
      });
    }

    // Notes field (both modes).
    $('input[data-line-field="lineNotes"]', lineEl)?.addEventListener('input', (e) => {
      _issueState.lines[idx].lineNotes = e.target.value;
    });

    // Qty field (both modes).
    $('input[data-line-field="qty"]', lineEl)?.addEventListener('input', (e) => {
      const n = Number(e.target.value);
      if (Number.isFinite(n) && n > 0) _issueState.lines[idx].qty = Math.floor(n);
    });
  });

  body.addEventListener('click', async (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'load-kit') {
      await openKitPicker((kit, items) => _loadKitIntoIssue(kit, items, allItems));
    } else if (action === 'issue-add-line') {
      _issueState.lines.push(_freshLine());
      await _render();
    } else if (action === 'issue-remove-line') {
      const idx = Number(e.target.closest('[data-line-index]').dataset.lineIndex);
      _issueState.lines.splice(idx, 1);
      if (_issueState.lines.length === 0) _issueState.lines.push(_freshLine());
      await _render();
    } else if (action === 'issue-reset') {
      _issueState = _freshIssueState();
      await _render();
    } else if (action === 'issue-submit') {
      await _submitIssue(body);
    }
  });
}

async function _loadKitIntoIssue(kit, _unusedItems, allItems) {
  // Drop the single empty default line before merging.
  const existing = _issueState.lines.filter((l) => l.itemId || l.nonStock);

  const outOfStock = [];
  for (const kitLine of (kit.lines || [])) {
    const stockItem = allItems.find((i) => i.id === kitLine.itemId);
    if (!stockItem) continue;   // item deleted from IMS — skip silently

    const avail = stockItem._avail;
    const existing_line = existing.find((l) => l.itemId === kitLine.itemId);
    if (existing_line) {
      existing_line.qty = existing_line.qty + kitLine.qty;
    } else {
      existing.push({ ..._freshLine(), itemId: kitLine.itemId, qty: kitLine.qty });
    }
    if (avail === 0) outOfStock.push(stockItem.name);
  }

  _issueState.lines = existing.length > 0 ? existing : [_freshLine()];
  if (outOfStock.length > 0) {
    showToast(
      `⚠ ${outOfStock.length} kit item${outOfStock.length === 1 ? '' : 's'} with no stock on hand: ${outOfStock.join(', ')}. ` +
      `These will be issued and recorded as On Loan against the inventory entry.`,
      'warn', 9000,
    );
  }
  await _render();
}

async function _submitIssue(body) {
  const errEl = $('[data-issue-error]', body);
  errEl.textContent = '';

  const purpose      = $('select[data-issue-field="purpose"]', body)?.value || '';
  const dueDate      = $('input[data-issue-field="dueDate"]', body)?.value || '';
  const remarks      = $('textarea[data-issue-field="remarks"]', body)?.value || '';
  const longTermLoan = _issueState.longTermLoan;
  const unitLoan     = _issueState.unitLoan;
  const activityName = ($('input[data-issue-field="activityName"]', body)?.value || _issueState.activityName).trim();

  if (!purpose) { errEl.textContent = 'Purpose is required.'; return; }

  if (unitLoan) {
    if (!activityName) { errEl.textContent = 'Enter an activity / description for the unit loan.'; return; }
  } else {
    if (!_issueState.svcNo) { errEl.textContent = 'Select a borrower first.'; return; }
  }

  if (!longTermLoan) {
    if (!dueDate)  { errEl.textContent = 'Due date is required (or tick Long-term loan).'; return; }
    if (new Date(dueDate) < _todayLocalDateOnly()) {
      errEl.textContent = 'Due date cannot be in the past.';
      return;
    }
  }

  // Resolve borrower — cadet or unit/activity.
  let cadet = null;
  let borrowerName, borrowerSvc;
  if (unitLoan) {
    borrowerName = activityName;
    borrowerSvc  = 'UNIT-LOAN';
  } else {
    cadet = await Storage.cadets.get(_issueState.svcNo)
         || await Storage.staff.get(_issueState.svcNo);
    if (!cadet) { errEl.textContent = 'Selected borrower no longer exists.'; return; }
    borrowerName = `${cadet.rank} ${cadet.surname}`;
    borrowerSvc  = cadet.svcNo;
  }

  // Validate and resolve every line.
  const lineErrors   = [];
  const resolvedLines = [];

  for (let i = 0; i < _issueState.lines.length; i++) {
    const ln  = _issueState.lines[i];
    const num = i + 1;
    const qty = Math.floor(Number(ln.qty) || 0);
    if (qty < 1) { lineErrors.push(`Line ${num}: quantity must be at least 1.`); continue; }

    if (ln.nonStock) {
      // Non-stock line — description required; NSN optional.
      const desc = ln.nonStockDesc.trim();
      if (!desc) { lineErrors.push(`Line ${num}: enter an item description.`); continue; }
      resolvedLines.push({ nonStock: true, existingLoan: false, desc, nsn: ln.nonStockNsn.trim(), qty, lineNotes: ln.lineNotes || '' });
    } else {
      // Standard inventory line (may be an existing-loan recording).
      if (!ln.itemId) { lineErrors.push(`Line ${num}: choose an item from the list.`); continue; }
      const item = await Storage.items.get(ln.itemId);
      if (!item) { lineErrors.push(`Line ${num}: item no longer exists.`); continue; }
      // existingLoan = true → item was issued before Q-Store; onLoan increments
      // but onHand is NOT decreased (stock was already out at implementation time).
      resolvedLines.push({ nonStock: false, existingLoan: !!ln.existingLoan, item, qty, lineNotes: ln.lineNotes || '' });
    }
  }

  if (lineErrors.length > 0) { errEl.textContent = lineErrors.join(' '); return; }
  if (resolvedLines.length === 0) { errEl.textContent = 'Add at least one item.'; return; }

  // Detect over-allocation across stock lines for the same item.
  // Only hard-error when the item has actual on-hand stock and we're drawing
  // more than is available — zero-stock items and existingLoan lines are exempt
  // (existingLoan lines do not deduct stock, so there is nothing to over-allocate).
  const sumByItemId = new Map();
  for (const r of resolvedLines.filter((r) => !r.nonStock && !r.existingLoan)) {
    sumByItemId.set(r.item.id, (sumByItemId.get(r.item.id) || 0) + r.qty);
  }
  for (const [itemId, totalQty] of sumByItemId) {
    const r      = resolvedLines.find((r) => !r.nonStock && !r.existingLoan && r.item.id === itemId);
    const onHand = Number(r.item.onHand) || 0;
    const avail  = Math.max(0, onHand - (Number(r.item.onLoan) || 0));
    if (onHand > 0 && totalQty > avail) {
      errEl.textContent = `Total qty for "${r.item.name}" (${totalQty}) exceeds available (${avail}). Combine the lines or reduce the quantity.`;
      return;
    }
  }

  // Walk the batch and create one loan record per line.
  const issueDate  = _todayLocalIsoDate();
  const sessionUser = AUTH.getSession()?.name || 'unknown';

  const created = [];
  try {
    for (const r of resolvedLines) {
      const ref = await _nextLoanRef();

      if (r.nonStock) {
        // Non-stock — no inventory touch.
        const loan = {
          ref,
          itemId:       null,
          itemName:     r.desc,
          nsn:          r.nsn || '',
          qty:          r.qty,
          borrowerSvc,
          borrowerName,
          purpose,
          issueDate,
          dueDate:      longTermLoan ? '' : dueDate,
          longTermLoan: longTermLoan || false,
          unitLoan:     unitLoan     || false,
          nonStock:     true,
          existingLoan: false,
          condition:    'serviceable',
          remarks,
          notes:        r.lineNotes,
          active:       true,
          issuedBy:     sessionUser,
        };
        await Storage.loans.put(loan);
        await Storage.audit.append({
          action: 'issue',
          user:   sessionUser,
          desc:   `${ref}: [non-stock] ${r.desc} × ${r.qty} issued to ${borrowerName} for ${purpose}`,
        });
        created.push(loan);
      } else if (r.existingLoan) {
        // Existing issue — item IS in IMS but was physically out before Q-Store.
        // onLoan increments (accountability) but onHand is NOT decreased.
        // Return will restore onHand.
        const { item, qty } = r;
        const loan = {
          ref,
          itemId:       item.id,
          itemName:     item.name,
          nsn:          item.nsn || '',
          qty,
          borrowerSvc,
          borrowerName,
          purpose,
          issueDate,
          dueDate:      longTermLoan ? '' : dueDate,
          longTermLoan: longTermLoan || false,
          unitLoan:     unitLoan     || false,
          nonStock:     false,
          existingLoan: true,
          condition:    item.condition || 'serviceable',
          remarks,
          notes:        r.lineNotes,
          active:       true,
          issuedBy:     sessionUser,
        };
        const fresh = await Storage.items.get(item.id);
        if (!fresh) throw new Error(`"${item.name}" was deleted during issue.`);
        // Increment onLoan only — onHand is unchanged.
        fresh.onLoan = (Number(fresh.onLoan) || 0) + qty;
        await Storage.atomic.issue(loan, fresh);
        await Storage.audit.append({
          action: 'issue',
          user:   sessionUser,
          desc:   `${ref}: [existing issue] ${item.name} × ${qty} recorded for ${borrowerName} — no stock deduction`,
        });
        created.push(loan);
      } else {
        // Standard stock item.
        const { item, qty } = r;
        const loan = {
          ref,
          itemId:       item.id,
          itemName:     item.name,
          nsn:          item.nsn || '',
          qty,
          borrowerSvc,
          borrowerName,
          purpose,
          issueDate,
          dueDate:      longTermLoan ? '' : dueDate,
          longTermLoan: longTermLoan || false,
          unitLoan:     unitLoan     || false,
          nonStock:     false,
          existingLoan: false,
          condition:    item.condition || 'serviceable',
          remarks,
          notes:        r.lineNotes,
          active:       true,
          issuedBy:     sessionUser,
        };

        // Atomic stock check + update.
        // If onHand > 0, guard against race conditions where stock was issued by
        // another session between validation and commit. Zero-stock items are
        // allowed through for reconciliation purposes.
        const fresh = await Storage.items.get(item.id);
        if (!fresh) throw new Error(`"${item.name}" was deleted during issue.`);
        const freshOnHand = Number(fresh.onHand) || 0;
        const freshAvail  = Math.max(0, freshOnHand - (Number(fresh.onLoan) || 0));
        if (freshOnHand > 0 && qty > freshAvail) {
          throw new Error(`Only ${freshAvail} of "${item.name}" are now available — the form was open while stock changed. Please reduce the quantity and try again.`);
        }
        fresh.onLoan = (Number(fresh.onLoan) || 0) + qty;
        await Storage.atomic.issue(loan, fresh);
        await Storage.audit.append({
          action: 'issue',
          user:   sessionUser,
          desc:   `${ref}: ${item.name} × ${qty} issued to ${borrowerName} for ${purpose}`,
        });
        created.push(loan);
      }
    }
  } catch (err) {
    errEl.textContent =
      `Issued ${created.length} of ${resolvedLines.length} item(s) before error: ${err.message}`;
    Sync.notifyChanged();
    return;
  }

  Sync.notifyChanged();

  // Confirmation modal — list the created refs so the user can copy them.
  // The "Print voucher" button generates a PDF of THIS batch (all loans
  // share borrowerSvc + issueDate by construction here, since we just
  // created them in one transaction).
  openModal({
    titleHtml: `Issued ${created.length} ${created.length === 1 ? 'item' : 'items'}`,
    size:      'sm',
    bodyHtml: `
      <p class="modal__body">
        Issued to <strong>${esc(borrowerName)}</strong> for ${esc(purpose)}${longTermLoan ? ' — long-term loan' : `, due ${esc(dueDate)}`}.
      </p>
      <ul class="loan__confirm-list">
        ${created.map((l) =>
          `<li><span class="loan__confirm-ref">${esc(l.ref)}</span> ${esc(l.itemName)} × ${l.qty}</li>`
        ).join('')}
      </ul>
      <div class="form__actions">
        <button type="button" class="btn btn--ghost" data-action="print-batch-voucher"
                title="Issue Voucher — internal record of items issued to this borrower. Print and file with the loan.">
          ⎙ Issue Voucher
        </button>
        <button type="button" class="btn btn--ghost" data-action="print-batch-ab189"
                title="AB189 — Army Book 189 loan card. Required for formal Army property accountability.">
          ⎙ AB189
        </button>
        <button type="button" class="btn btn--primary" data-action="modal-close">OK</button>
      </div>`,
    onMount(panel, close) {
      const voucherBtn = panel.querySelector('[data-action="print-batch-voucher"]');
      voucherBtn?.addEventListener('click', async () => {
        voucherBtn.disabled = true;
        voucherBtn.textContent = 'Building PDF…';
        try {
          await _printVoucherForLoans(created);
          voucherBtn.textContent = '⎙ Issue Voucher';
          voucherBtn.disabled = false;
        } catch (err) {
          voucherBtn.textContent = '⎙ Issue Voucher';
          voucherBtn.disabled = false;
          showToast('Voucher generation failed: ' + (err.message || err), 'error');
        }
      });
      const ab189Btn = panel.querySelector('[data-action="print-batch-ab189"]');
      ab189Btn?.addEventListener('click', async () => {
        ab189Btn.disabled = true;
        ab189Btn.textContent = 'Building PDF…';
        try {
          await _printAB189ForLoans(created);
          ab189Btn.textContent = '⎙ AB189';
          ab189Btn.disabled = false;
        } catch (err) {
          ab189Btn.textContent = '⎙ AB189';
          ab189Btn.disabled = false;
          showToast('AB189 generation failed: ' + (err.message || err), 'error');
        }
      });
    },
  });

  _issueState = _freshIssueState();
  await _render();
}

// =============================================================================
// RETURN TAB
// =============================================================================

async function _renderReturnTab(body) {
  AUTH.requirePermission('return');

  const [cadets, staffList] = await Promise.all([Storage.cadets.list(), Storage.staff.list()]);
  const allPersonnel = [...cadets, ...staffList];

  // Borrowers shown in the picker = cadets/staff with at least one active loan.
  // Walking listForCadet for every person would be O(N) queries; faster
  // to fetch all loans once and group.
  const allLoans    = await Storage.loans.list();
  const activeLoans = allLoans.filter((l) => l.active === true);
  const svcsWithLoans = new Set(activeLoans.map((l) => l.borrowerSvc));

  // Eligible borrowers: cadets/staff with at least one active loan.
  const eligibleCadets = allPersonnel.filter((c) => svcsWithLoans.has(c.svcNo));

  // Virtual "borrower" entry for unit/activity loans (borrowerSvc = UNIT-LOAN).
  const hasUnitLoans = activeLoans.some((l) => l.borrowerSvc === 'UNIT-LOAN');
  const allEligible  = hasUnitLoans
    ? [...eligibleCadets, { svcNo: 'UNIT-LOAN', rank: '', surname: 'Unit / Activity Loans', plt: '' }]
    : eligibleCadets;

  // Clear stale selection.
  if (_returnState.svcNo && !svcsWithLoans.has(_returnState.svcNo)) {
    _returnState.svcNo = '';
    _returnState.refsChecked.clear();
  }

  const isUnitLoanView = _returnState.svcNo === 'UNIT-LOAN';
  const borrower = (!isUnitLoanView && _returnState.svcNo)
    ? allPersonnel.find((c) => c.svcNo === _returnState.svcNo) || null
    : null;
  const borrowerLoans = _returnState.svcNo
    ? activeLoans.filter((l) => l.borrowerSvc === _returnState.svcNo)
    : [];

  body.innerHTML = `
    <div class="loan__return">
      <h3 class="loan__heading">1. Borrower</h3>
      ${_borrowerPickerHtml('return', _returnState.svcNo, allEligible, borrower || (isUnitLoanView ? { svcNo: 'UNIT-LOAN', rank: '', surname: 'Unit / Activity Loans' } : null))}

      ${(borrower || isUnitLoanView) ? `
        <h3 class="loan__heading">2. Items to return</h3>
        ${borrowerLoans.length === 0
          ? `<p class="loan__empty">No active loans for ${isUnitLoanView ? 'unit / activity loans' : 'this borrower'}.</p>`
          : `
            <div class="loan__return-list">
              ${borrowerLoans.map((l) => _returnLoanRowHtml(l)).join('')}
              <div class="loan__return-actions">
                <button type="button" class="btn btn--ghost btn--sm"
                        data-action="return-select-all">Select all</button>
                <button type="button" class="btn btn--ghost btn--sm"
                        data-action="return-select-none">Clear</button>
              </div>
            </div>

            <h3 class="loan__heading">3. Return details</h3>
            <div class="form__row">
              <label class="form__field form__field--grow">
                <span class="form__label">Condition on return *</span>
                <select name="returnCondition" data-return-field="condition">
                  ${RETURN_CONDITIONS.map((c) =>
                    `<option value="${esc(c.value)}">${esc(c.label)}</option>`).join('')}
                </select>
                <span class="form__hint">
                  Unserviceable / write-off bumps the item's unserviceable count
                </span>
              </label>
            </div>
            <label class="form__field">
              <span class="form__label">Return remarks</span>
              <textarea name="returnRemarks" rows="2" maxlength="300"
                        data-return-field="remarks"
                        placeholder="optional — e.g. damage notes"></textarea>
            </label>

            <div class="form__error" data-return-error role="alert"></div>
            <div class="form__actions">
              <button type="button" class="btn btn--primary"
                      data-action="return-submit">
                Return selected (${_returnState.refsChecked.size})
              </button>
            </div>
          `}
      ` : ''}
    </div>
  `;

  _wireReturnTab(body, allEligible, borrowerLoans);
}

function _returnLoanRowHtml(loan) {
  const checked = _returnState.refsChecked.has(loan.ref);
  const overdue = !loan.longTermLoan && loan.dueDate && loan.dueDate < _todayLocalIsoDate();
  const badges  = [
    loan.nonStock     ? `<span class="loan__badge loan__badge--nonstock">Non-stock</span>` : '',
    loan.longTermLoan ? `<span class="loan__badge loan__badge--longterm">Long-term</span>` : '',
    loan.unitLoan     ? `<span class="loan__badge loan__badge--unitloan">Unit loan</span>` : '',
    loan.existingLoan ? `<span class="loan__badge loan__badge--existing" title="Recorded as existing issue — stock not deducted at issue time">Existing</span>` : '',
  ].join('');
  return `
    <label class="loan__return-row ${overdue ? 'loan__return-row--overdue' : ''}">
      <input type="checkbox" data-return-ref="${esc(loan.ref)}"
             ${checked ? 'checked' : ''}>
      <span class="loan__return-ref">${esc(loan.ref)}</span>
      <span class="loan__return-item">${esc(loan.itemName)} × ${loan.qty}${badges}</span>
      <span class="loan__return-due">
        ${loan.longTermLoan
          ? 'long-term'
          : overdue
            ? `OVERDUE — ${esc(loan.dueDate)}`
            : `due ${esc(loan.dueDate)}`}
      </span>
    </label>
  `;
}

function _wireReturnTab(body, eligibleCadets, borrowerLoans) {
  const borrowerInput  = $('input[data-borrower-search="return"]', body);
  const borrowerHidden = $('input[data-borrower-id="return"]', body);
  borrowerInput?.addEventListener('input', () => {
    const val = borrowerInput.value;
    const match = eligibleCadets.find((c) =>
      `${c.rank} ${c.surname} (${c.svcNo})` === val);
    borrowerHidden.value = match ? match.svcNo : '';
    if (match && match.svcNo !== _returnState.svcNo) {
      _returnState.svcNo = match.svcNo;
      _returnState.refsChecked.clear();
      _render();
    }
  });

  // Loan checkbox toggles.
  body.addEventListener('change', (e) => {
    const ref = e.target.dataset?.returnRef;
    if (!ref) return;
    if (e.target.checked) _returnState.refsChecked.add(ref);
    else                  _returnState.refsChecked.delete(ref);
    // Refresh just the submit button label without a full re-render —
    // the checkbox states are already correct in DOM.
    const btn = $('[data-action="return-submit"]', body);
    if (btn) btn.textContent = `Return selected (${_returnState.refsChecked.size})`;
  });

  body.addEventListener('click', async (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'return-select-all') {
      borrowerLoans.forEach((l) => _returnState.refsChecked.add(l.ref));
      await _render();
    } else if (action === 'return-select-none') {
      _returnState.refsChecked.clear();
      await _render();
    } else if (action === 'return-submit') {
      await _submitReturn(body);
    }
  });
}

async function _submitReturn(body) {
  const errEl = $('[data-return-error]', body);
  errEl.textContent = '';

  if (_returnState.refsChecked.size === 0) {
    errEl.textContent = 'Select at least one loan to return.';
    return;
  }
  const condition = $('select[data-return-field="condition"]', body)?.value || 'serviceable';
  const remarks   = $('textarea[data-return-field="remarks"]', body)?.value || '';

  const sessionUser = AUTH.getSession()?.name || 'unknown';
  const returnDate  = _todayLocalIsoDate();

  let returned         = 0;
  let addedToIms       = 0;
  let stockRestored    = 0;
  const errors         = [];
  const needsPrompt    = [];   // non-stock items with no IMS match → prompt to add
  const now            = new Date().toISOString();

  // Fetch item list once so each nonStock loan doesn't repeat the query.
  const imsItemsList = await Storage.items.list();

  for (const ref of _returnState.refsChecked) {
    try {
      const loan = await Storage.loans.get(ref);
      if (!loan) { errors.push(`${ref}: no longer exists`); continue; }
      if (!loan.active) { errors.push(`${ref}: already returned`); continue; }

      // _updatedItem collects any item record that must be co-written with
      // the loan in one IDB transaction (prevents partial-write corruption).
      let _updatedItem = null;

      if (loan.nonStock) {
        // Non-stock return — try to match by NSN.
        let matched = false;
        if (loan.nsn) {
          const match = imsItemsList.find((i) => i.nsn === loan.nsn);
          if (match) {
            match.onHand = (Number(match.onHand) || 0) + loan.qty;
            if (match.qtyServiceable != null) {
              match.qtyServiceable = (Number(match.qtyServiceable) || 0) + loan.qty;
            }
            match.updatedAt = now;
            _updatedItem = match; // deferred — written atomically with loan below
            // Update our local list so duplicate NSNs in the same batch are
            // also caught correctly without re-querying.
            const idx = imsItemsList.findIndex((i) => i.id === match.id);
            if (idx >= 0) imsItemsList[idx] = match;
            addedToIms++;
            matched = true;
          }
        }
        if (!matched) {
          // No NSN supplied, or NSN not found in IMS — queue for the add prompt.
          needsPrompt.push({ name: loan.itemName, nsn: loan.nsn || '', qty: loan.qty });
        }
        // No onLoan decrement — was never incremented on issue.
      } else if (loan.existingLoan) {
        // Existing-loan return — this item was recorded as already out before
        // Q-Store; onHand was NOT decremented on issue. On return: decrement
        // onLoan AND increment onHand so stock figures are correct going forward.
        const item = await Storage.items.get(loan.itemId);
        if (item) {
          item.onLoan = Math.max(0, (Number(item.onLoan) || 0) - loan.qty);
          item.onHand = (Number(item.onHand) || 0) + loan.qty;
          // Condition tracking.
          if (condition === 'serviceable' && item.qtyServiceable != null) {
            item.qtyServiceable = (Number(item.qtyServiceable) || 0) + loan.qty;
          }
          if (condition === 'unserviceable' || condition === 'write-off') {
            item.unsvc = (Number(item.unsvc) || 0) + loan.qty;
            if (item.qtyUnserviceable != null) {
              item.qtyUnserviceable = (Number(item.qtyUnserviceable) || 0) + loan.qty;
            }
          }
          if (condition === 'write-off') {
            item.condition = 'unserviceable';
          }
          item.updatedAt = now;
          _updatedItem = item; // deferred — written atomically with loan below
          stockRestored++;
        }
      } else {
        // Standard stock return — decrement onLoan, optionally bump unsvc.
        const item = await Storage.items.get(loan.itemId);
        if (item) {
          item.onLoan = Math.max(0, (Number(item.onLoan) || 0) - loan.qty);
          if (condition === 'unserviceable' || condition === 'write-off') {
            item.unsvc = (Number(item.unsvc) || 0) + loan.qty;
          }
          if (condition === 'write-off') {
            item.condition = 'unserviceable';
          }
          item.updatedAt = now;
          _updatedItem = item; // deferred — written atomically with loan below
        }
      }

      loan.active          = false;
      loan.returnDate      = returnDate;
      loan.returnCondition = condition;
      loan.returnRemarks   = remarks;
      loan.returnedBy      = sessionUser;
      // Write loan + item change in one IDB transaction where possible.
      if (_updatedItem) {
        await Storage.atomic.return(loan, _updatedItem);
      } else {
        await Storage.loans.put(loan);
      }

      await Storage.audit.append({
        action: 'return',
        user:   sessionUser,
        desc:   `${ref}: ${loan.itemName} × ${loan.qty} returned by ${loan.borrowerName} — ${condition}${loan.nonStock ? ' [non-stock]' : ''}`,
      });
      returned++;
    } catch (err) {
      errors.push(`${ref}: ${err.message}`);
    }
  }

  if (addedToIms > 0) {
    showToast(`${addedToIms} non-stock item(s) matched by NSN and added to inventory.`, 'success', 6000);
  }
  if (stockRestored > 0) {
    showToast(
      `${stockRestored} existing-loan item${stockRestored === 1 ? '' : 's'} returned — On Hand restored in inventory.`,
      'success', 6000,
    );
  }

  Sync.notifyChanged();

  if (errors.length > 0) {
    errEl.textContent = `Returned ${returned}. Errors: ${errors.join('; ')}`;
  }

  _returnState = _freshReturnState();

  // If any non-stock items had no IMS match, prompt the QM to add them.
  if (needsPrompt.length > 0) {
    await _promptAddNonStockToInventory(needsPrompt);
  } else {
    await _render();
  }
}

// -----------------------------------------------------------------------------
// _promptAddNonStockToInventory
// -----------------------------------------------------------------------------
// Called after a return that includes non-stock items with no IMS match.
// Shows a modal with one editable row per item. The QM can correct the name,
// supply an NSN, adjust qty, choose a category, and tick which items to add.
// On confirm those items are created as new inventory entries.

async function _promptAddNonStockToInventory(candidates) {
  const CATS = ['Equipment', 'Uniform', 'Safety', 'Training Aids', 'Field Stores', 'Medical', 'ICT', 'Other'];
  // Load the current category list from settings for the select.
  let cats = CATS;
  try {
    const stored = await Storage.settings.get('categories');
    if (Array.isArray(stored) && stored.length) cats = stored;
  } catch (_) { /* use defaults */ }

  const rowsHtml = candidates.map((c, i) => `
    <tr class="nsv__row" data-row="${i}">
      <td>
        <label class="nsv__chk-cell">
          <input type="checkbox" name="add_${i}" checked>
        </label>
      </td>
      <td>
        <input type="text" name="name_${i}" class="form__input nsv__input"
               value="${esc(c.name)}" placeholder="Item name" required>
      </td>
      <td>
        <input type="text" name="nsn_${i}" class="form__input nsv__input nsv__input--nsn"
               value="${esc(c.nsn)}" placeholder="optional"
               spellcheck="false" autocomplete="off">
      </td>
      <td>
        <input type="number" name="qty_${i}" class="form__input nsv__input nsv__input--qty"
               value="${c.qty}" min="1" step="1">
      </td>
      <td>
        <select name="cat_${i}" class="form__select nsv__input">
          ${cats.map((cat) =>
            `<option value="${esc(cat)}"${cat === 'Equipment' ? ' selected' : ''}>${esc(cat)}</option>`
          ).join('')}
        </select>
      </td>
    </tr>
  `).join('');

  openModal({
    titleHtml: `Add returned items to inventory?`,
    size:      'lg',
    persistent: true,
    bodyHtml: `
      <p class="modal__body">
        The items below were returned as non-stock and have no matching entry in your IMS.
        Tick the ones you want to add to inventory — you can correct names, NSNs and quantities before saving.
      </p>
      <div class="nsv__table-wrap">
        <table class="nsv__table">
          <thead>
            <tr>
              <th class="nsv__col-chk"></th>
              <th>Item name</th>
              <th>NSN</th>
              <th class="nsv__col-qty">Qty</th>
              <th>Category</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      <div class="form__error nsv__err" role="alert"></div>
      <div class="form__actions">
        <button type="button" class="btn btn--ghost" data-action="nsv-skip">Skip — don't add</button>
        <button type="button" class="btn btn--primary" data-action="nsv-confirm">Add to IMS</button>
      </div>
    `,
    async onMount(panel, close) {
      const errEl = $('.nsv__err', panel);
      const sessionUser = AUTH.getSession()?.name || 'QM';
      const now = new Date().toISOString();

      $('[data-action="nsv-skip"]', panel)?.addEventListener('click', () => {
        close();
        _render();
      });

      $('[data-action="nsv-confirm"]', panel)?.addEventListener('click', async () => {
        errEl.textContent = '';
        const toCreate = [];
        candidates.forEach((_, i) => {
          const chk  = $(`input[name="add_${i}"]`, panel);
          if (!chk?.checked) return;
          const name = $(`input[name="name_${i}"]`, panel)?.value.trim();
          const nsn  = $(`input[name="nsn_${i}"]`, panel)?.value.trim();
          const qty  = Math.max(1, parseInt($(`input[name="qty_${i}"]`, panel)?.value || '1', 10));
          const cat  = $(`select[name="cat_${i}"]`, panel)?.value || 'Equipment';
          if (!name) { errEl.textContent = `Row ${i + 1}: item name is required.`; return; }
          toCreate.push({ name, nsn, qty, cat });
        });
        if (errEl.textContent) return;
        if (toCreate.length === 0) { close(); await _render(); return; }

        try {
          for (const t of toCreate) {
            const id = `item-${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`;
            await Storage.items.put({
              id,
              name:             t.name,
              nsn:              t.nsn || '',
              cat:              t.cat,
              onHand:           t.qty,
              onLoan:           0,
              unsvc:            0,
              writtenOff:       0,
              condition:        'serviceable',
              qtyServiceable:   t.qty,
              qtyUnserviceable: 0,
              qtyRepair:        0,
              qtyCalibrationDue:0,
              qtyWrittenOff:    0,
              source:           'non-stock-return',
              createdAt:        now,
              updatedAt:        now,
            });
            await Storage.audit.append({
              action: 'item_add',
              user:   sessionUser,
              desc:   `"${t.name}" × ${t.qty} added to inventory from non-stock return`,
            });
          }
          Sync.notifyChanged();
          showToast(`${toCreate.length} item(s) added to inventory.`, 'success');
          close();
          await _render();
        } catch (err) {
          errEl.textContent = 'Failed to create item(s): ' + (err.message || err);
        }
      });
    },
  });
}

// =============================================================================
// ALL LOANS TAB
// =============================================================================

async function _renderAllTab(body) {
  AUTH.requirePermission('view');

  const [all, cadets, staffList] = await Promise.all([
    Storage.loans.list(),
    Storage.cadets.list(),
    Storage.staff.list(),
  ]);
  const allPersonnelHist = [...cadets, ...staffList];
  const today = _todayLocalIsoDate();

  // Build a sorted list of borrowers who have at least one loan record,
  // for the person-picker datalist. Use denormalised borrowerName from the
  // loan records so it matches even if the cadet record was later removed.
  const borrowerMap = new Map();
  all.forEach((l) => {
    if (l.borrowerSvc && !borrowerMap.has(l.borrowerSvc)) {
      borrowerMap.set(l.borrowerSvc, l.borrowerName || l.borrowerSvc);
    }
  });
  // Enrich with live personnel records where possible (rank may have changed).
  const cadetSvcSet = new Set(allPersonnelHist.map((c) => c.svcNo));
  allPersonnelHist.forEach((c) => {
    if (borrowerMap.has(c.svcNo)) {
      borrowerMap.set(c.svcNo, `${c.rank || ''} ${c.surname || ''} ${c.firstName ? c.firstName.charAt(0) + '.' : ''}`.trim());
    }
  });

  // Discharged / inactive personnel — still holding active loans. We flag those
  // rows in the All Loans view so the QM can see what needs chasing.
  const dischargedSvcs = new Set(
    allPersonnelHist.filter((c) => c.active === false).map((c) => c.svcNo),
  );

  // Detect phantom borrowers — in loan records but absent from the cadet list
  // and not a UNIT-LOAN entry. These are typically v1 sample-data remnants.
  const phantomBorrowers = [...borrowerMap.entries()]
    .filter(([svc]) => svc !== 'UNIT-LOAN' && !cadetSvcSet.has(svc))
    .map(([svc, name]) => ({ svc, name }));

  const borrowerOptions = [...borrowerMap.entries()]
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([svc, name]) => ({ svc, name }));

  // Resolved selected borrower name (for the chip label).
  const selectedBorrowerName = _allBorrower
    ? (borrowerMap.get(_allBorrower) || _allBorrower)
    : '';

  // Apply borrower → status filter → text search (most restrictive first).
  const _isOverdue = (l) => !l.longTermLoan && l.active === true && l.dueDate && l.dueDate < today;

  let filtered = all;
  if (_allBorrower) {
    filtered = filtered.filter((l) => l.borrowerSvc === _allBorrower);
  }
  if (_allFilter === 'active') {
    filtered = filtered.filter((l) => l.active === true);
  } else if (_allFilter === 'returned') {
    filtered = filtered.filter((l) => l.active === false);
  } else if (_allFilter === 'overdue') {
    filtered = filtered.filter(_isOverdue);
  }
  if (_allSearch) {
    const q = _allSearch.toLowerCase();
    filtered = filtered.filter((l) =>
      [l.ref, l.itemName, l.nsn, l.borrowerName, l.borrowerSvc, l.purpose, l.remarks]
        .join(' ').toLowerCase().includes(q));
  }
  // Sort: issueDate desc, tie-break ref desc (keeps batches together).
  filtered.sort((a, b) => {
    const d = (b.issueDate || '').localeCompare(a.issueDate || '');
    return d !== 0 ? d : (b.ref || '').localeCompare(a.ref || '');
  });

  const canReturn = AUTH.can('return');

  // Pill counts respect the borrower filter so the numbers are meaningful
  // in person-view (e.g. "3 active for this person").
  const scope = _allBorrower ? all.filter((l) => l.borrowerSvc === _allBorrower) : all;
  const filterCounts = {
    all:      scope.length,
    active:   scope.filter((l) => l.active === true).length,
    returned: scope.filter((l) => l.active === false).length,
    overdue:  scope.filter(_isOverdue).length,
  };

  const datalistId = 'loan-all-borrower-list';

  body.innerHTML = `
    <div class="loan__all">
      <header class="loan__all-toolbar">
        <div class="loan__all-filters">

          <div class="loan__borrower-row">
            <div class="loan__borrower-pick">
              <input type="search"
                     class="loan__borrower-search"
                     list="${datalistId}"
                     placeholder="Filter by person…"
                     aria-label="Filter loans by borrower"
                     value="${esc(selectedBorrowerName)}"
                     autocomplete="off">
              <datalist id="${datalistId}">
                ${borrowerOptions.map((b) =>
                  `<option value="${esc(b.name)}" data-svc="${esc(b.svc)}"></option>`
                ).join('')}
              </datalist>
              ${_allBorrower ? `
                <button type="button" class="btn btn--sm btn--ghost loan__borrower-clear"
                        data-action="clear-borrower" title="Show all borrowers">✕ Clear</button>
              ` : ''}
            </div>
            ${_allBorrower ? `
              <span class="loan__borrower-banner">
                Showing loans for <strong>${esc(selectedBorrowerName)}</strong>
              </span>
            ` : ''}
          </div>

          ${phantomBorrowers.length > 0 ? `
            <div class="loan__phantom-warn" role="alert">
              <span>⚠ ${phantomBorrowers.length} borrower${phantomBorrowers.length === 1 ? '' : 's'} in loan records
              not found in the cadet list:
              <strong>${phantomBorrowers.map((b) => esc(b.name)).join(', ')}</strong>.
              These may be leftover sample or imported data.</span>
              <button type="button" class="btn btn--sm btn--danger loan__phantom-remove"
                      data-action="remove-phantom-borrowers"
                      title="Delete all loan records for these phantom borrowers">
                Remove
              </button>
            </div>
          ` : ''}

          <input type="search" class="loan__all-search"
                 placeholder="Search ref, item, borrower, NSN…"
                 aria-label="Search loans"
                 value="${esc(_allSearch)}">
          <div class="loan__all-pills">
            ${[
              ['active',   'Active',   filterCounts.active],
              ['overdue',  'Overdue',  filterCounts.overdue],
              ['returned', 'Returned', filterCounts.returned],
              ['all',      'All',      filterCounts.all],
            ].map(([key, label, count]) => `
              <button type="button"
                      class="loan__pill ${key === _allFilter ? 'loan__pill--active' : ''}"
                      data-action="all-filter" data-filter="${key}">
                ${esc(label)} <span class="loan__pill-count">${count}</span>
              </button>`).join('')}
          </div>
        </div>
        <div class="loan__all-actions">
          <button type="button" class="btn btn--ghost"
                  data-action="print-outstanding"
                  title="Print active loans (with overdue highlighted)">
            ⎙ Print outstanding
          </button>
        </div>
      </header>

      ${canReturn && _allSelected.size > 0 ? `
        <div class="loan__bulk-bar" role="toolbar" aria-label="Bulk return actions">
          <span class="loan__bulk-count">${_allSelected.size} loan${_allSelected.size === 1 ? '' : 's'} selected</span>
          <button type="button" class="btn btn--primary btn--sm" data-action="bulk-return">
            ↩ Return selected (${_allSelected.size})
          </button>
          <button type="button" class="btn btn--ghost btn--sm" data-action="clear-selection">
            ✕ Clear selection
          </button>
        </div>
      ` : ''}

      <div class="loan__meta">
        ${filtered.length} ${filtered.length === 1 ? 'loan' : 'loans'} shown
        ${(_allBorrower || _allSearch || _allFilter !== 'all') && all.length !== filtered.length
          ? `<span class="loan__meta-of"> of ${all.length} total</span>` : ''}
      </div>

      <div class="loan__table-wrap">
        ${filtered.length === 0
          ? `<div class="loan__empty">
               <p>No loans match the current filters.</p>
             </div>`
          : _allTableHtml(filtered, today, canReturn, dischargedSvcs)}
      </div>
    </div>
  `;

  _wireAllTab(body, borrowerOptions, phantomBorrowers);
}

function _allTableHtml(loans, today, canReturn, dischargedSvcs = new Set()) {
  return `
    <table class="loan__table">
      <thead>
        <tr>
          ${canReturn ? `<th class="loan__col-chk"><input type="checkbox" data-action="select-all-rows" title="Select all active loans" aria-label="Select all active loans"></th>` : ''}
          <th>Ref</th>
          <th>Issued</th>
          <th>Item</th>
          <th>Qty</th>
          <th>Borrower</th>
          <th>Purpose</th>
          <th>Due</th>
          <th>Status</th>
          <th class="loan__col-actions">Documents</th>
        </tr>
      </thead>
      <tbody>
        ${loans.map((l) => _allRowHtml(l, today, canReturn, dischargedSvcs)).join('')}
      </tbody>
    </table>
  `;
}

function _allRowHtml(loan, today, canReturn, dischargedSvcs = new Set()) {
  const overdue     = !loan.longTermLoan && loan.active === true && loan.dueDate && loan.dueDate < today;
  // Discharged: borrower has been made inactive but still holds this loan.
  const discharged  = loan.active === true
    && loan.borrowerSvc
    && loan.borrowerSvc !== 'UNIT-LOAN'
    && dischargedSvcs.has(loan.borrowerSvc);

  let statusBadge;
  if (loan.active === false) {
    statusBadge = `<span class="loan__badge loan__badge--returned">Returned ${esc(loan.returnDate || '')}</span>`;
  } else if (discharged) {
    // Discharged takes priority over overdue — it's the more urgent state.
    statusBadge = `<span class="loan__badge loan__badge--discharged" title="Cadet is inactive — kit must be returned">⚠ Discharged</span>`;
  } else if (loan.longTermLoan) {
    statusBadge = `<span class="loan__badge loan__badge--longterm">Long-term</span>`;
  } else if (overdue) {
    statusBadge = `<span class="loan__badge loan__badge--overdue">Overdue</span>`;
  } else {
    statusBadge = `<span class="loan__badge loan__badge--active">Active</span>`;
  }
  const typeBadges = [
    loan.nonStock    ? `<span class="loan__badge loan__badge--nonstock"  title="Not from IMS stock">NS</span>` : '',
    loan.unitLoan    ? `<span class="loan__badge loan__badge--unitloan"  title="Unit/Activity loan">Unit</span>` : '',
    loan.existingLoan ? `<span class="loan__badge loan__badge--existing" title="Existing issue — stock not deducted">Exist</span>` : '',
  ].join('');

  const detailId = `loan-detail-${esc(loan.ref).replace(/\W/g, '-')}`;
  const isSelected = _allSelected.has(loan.ref);
  return `
    <tr class="loan__row ${discharged ? 'loan__row--discharged' : overdue ? 'loan__row--overdue' : ''}
                       ${loan.active === false ? 'loan__row--returned' : ''}
                       ${isSelected ? 'loan__row--selected' : ''}"
        data-detail-target="${detailId}" role="button" tabindex="0"
        title="Tap to expand details" aria-expanded="false"
        data-loan-ref="${esc(loan.ref)}">
      ${canReturn ? `
        <td class="loan__col-chk" data-no-expand>
          ${loan.active ? `
            <input type="checkbox" class="loan__row-chk"
                   data-action="select-row" data-loan-ref="${esc(loan.ref)}"
                   ${isSelected ? 'checked' : ''}
                   aria-label="Select ${esc(loan.ref)}">
          ` : ''}
        </td>
      ` : ''}
      <td class="loan__ref">${esc(loan.ref)}</td>
      <td class="loan__date">${esc(loan.issueDate || '')}</td>
      <td>
        <div>${esc(loan.itemName || '')}${typeBadges}</div>
        ${loan.nsn ? `<div class="loan__nsn">${esc(loan.nsn)}</div>` : ''}
      </td>
      <td class="loan__qty">${loan.qty}</td>
      <td>
        <div>${esc(loan.borrowerName || '')}</div>
        ${loan.borrowerSvc && loan.borrowerSvc !== 'UNIT-LOAN' ? `<div class="loan__nsn">${esc(loan.borrowerSvc)}</div>` : ''}
      </td>
      <td>${esc(loan.purpose || '')}</td>
      <td class="loan__date">${loan.longTermLoan ? '<em>Long-term</em>' : esc(loan.dueDate || '')}</td>
      <td>${statusBadge}</td>
      <td class="loan__col-actions">
        ${canReturn && loan.active ? `
        <button type="button" class="btn btn--sm btn--primary"
                data-action="quick-return"
                data-loan-ref="${esc(loan.ref)}"
                title="Return this item without navigating to the Return tab">
          ↩ Return
        </button>` : ''}
        <button type="button" class="btn btn--sm btn--ghost"
                data-action="print-row-voucher"
                data-loan-ref="${esc(loan.ref)}"
                title="Print issue voucher for this loan and any others in the same batch">
          ⎙ Voucher
        </button>
        <button type="button" class="btn btn--sm btn--ghost"
                data-action="print-row-ab189"
                data-loan-ref="${esc(loan.ref)}"
                title="Print AB189 equipment request form for this batch">
          ⎙ AB189
        </button>
      </td>
    </tr>
    <tr class="loan__row-detail" id="${detailId}" hidden aria-hidden="true">
      <td colspan="${canReturn ? 10 : 9}">
        <dl class="loan__detail-dl">
          <div><dt>Issued</dt><dd>${esc(loan.issueDate || '—')}</dd></div>
          <div><dt>Purpose</dt><dd>${esc(loan.purpose || '—')}</dd></div>
          <div><dt>Due</dt><dd>${loan.longTermLoan ? 'Long-term' : esc(loan.dueDate || '—')}</dd></div>
          ${loan.notes ? `<div><dt>Notes</dt><dd>${esc(loan.notes)}</dd></div>` : ''}
        </dl>
      </td>
    </tr>
  `;
}

function _wireAllTab(body, borrowerOptions = [], phantomBorrowers = []) {
  // Borrower picker — match typed text against the datalist options by name.
  const borrowerInput = $('.loan__borrower-search', body);
  if (borrowerInput) {
    borrowerInput.addEventListener('change', () => {
      const val = borrowerInput.value.trim();
      if (!val) {
        _allBorrower = '';
        _renderAllTab(body);
        return;
      }
      const match = borrowerOptions.find((b) => b.name === val);
      const newSvc = match ? match.svc : '';
      if (newSvc !== _allBorrower) {
        _allBorrower = newSvc;
        _renderAllTab(body);
      }
    });
    // Also respond to the user clearing the field with the × in a search input.
    borrowerInput.addEventListener('search', () => {
      if (!borrowerInput.value) {
        _allBorrower = '';
        _renderAllTab(body);
      }
    });
  }

  // Clear borrower button.
  $('[data-action="clear-borrower"]', body)?.addEventListener('click', () => {
    _allBorrower = '';
    _renderAllTab(body);
  });

  $('.loan__all-search', body)?.addEventListener('input', (e) => {
    _allSearch = e.target.value;
    _renderAllTab(body);
    _wireAllTab(body);   // re-wire after partial re-render
  });
  $$('[data-action="all-filter"]', body).forEach((btn) => {
    btn.addEventListener('click', () => {
      _allFilter = btn.dataset.filter;
      _allSelected.clear();  // clear selection when filter changes
      _renderAllTab(body);
      _wireAllTab(body);
    });
  });
  // Phantom borrower cleanup — delete all loan records for borrowers not in cadets.
  $('[data-action="remove-phantom-borrowers"]', body)?.addEventListener('click', async () => {
    if (!phantomBorrowers.length) return;
    const names = phantomBorrowers.map((b) => b.name).join(', ');
    const deleteLabel = phantomBorrowers.length === 1 ? 'Delete 1 borrower' : `Delete ${phantomBorrowers.length} borrowers`;
    openModal({
      titleHtml: 'Remove phantom loan records?',
      size: 'sm',
      bodyHtml: `
        <p>The following borrowers appear in loan records but are not in the cadet list:</p>
        <ul style="margin:8px 0 12px 20px">
          ${phantomBorrowers.map((b) => `<li><strong>${esc(b.name)}</strong> (${esc(b.svc)})</li>`).join('')}
        </ul>
        <p>All loan records for these borrowers will be permanently deleted. This cannot be undone.</p>
        <div class="form__actions" style="margin-top:16px">
          <button type="button" class="btn btn--ghost" data-action="modal-close">Cancel</button>
          <button type="button" class="btn btn--danger" data-action="confirm-remove-phantoms">${esc(deleteLabel)}</button>
        </div>
      `,
      async onMount(panel, close) {
        panel.querySelector('[data-action="confirm-remove-phantoms"]')?.addEventListener('click', async () => {
          const sessionUser = AUTH.getSession()?.name || 'unknown';
          const allLoans = await Storage.loans.list();
          const phantomSvcs = new Set(phantomBorrowers.map((b) => b.svc));
          const toDelete = allLoans.filter((l) => phantomSvcs.has(l.borrowerSvc));
          for (const loan of toDelete) {
            await Storage.loans.remove(loan.ref);
          }
          await Storage.audit.append({
            action: 'loans_cleanup',
            user:   sessionUser,
            desc:   `Deleted ${toDelete.length} phantom loan record(s) for: ${names}`,
          });
          close();
          if (_allBorrower && phantomSvcs.has(_allBorrower)) _allBorrower = '';
          await _renderAllTab(body);
          _wireAllTab(body);
          showToast(`Removed ${toDelete.length} loan record(s) for ${phantomBorrowers.length} phantom borrower(s).`, 'success');
          Sync.notifyChanged();
        });
      },
    });
  });

  // Row checkbox — select/deselect for bulk return.
  body.querySelectorAll('[data-action="select-row"]').forEach((chk) => {
    chk.addEventListener('change', () => {
      const ref = chk.dataset.loanRef;
      if (!ref) return;
      if (chk.checked) _allSelected.add(ref);
      else             _allSelected.delete(ref);
      // Refresh just the bulk bar and the row highlight without full re-render.
      _updateBulkBar(body);
      const row = chk.closest('.loan__row');
      if (row) row.classList.toggle('loan__row--selected', chk.checked);
    });
  });

  // Select-all header checkbox.
  $('[data-action="select-all-rows"]', body)?.addEventListener('change', (e) => {
    const checked = e.target.checked;
    // Only active loans are selectable.
    body.querySelectorAll('[data-action="select-row"]').forEach((chk) => {
      chk.checked = checked;
      const ref = chk.dataset.loanRef;
      if (ref) { if (checked) _allSelected.add(ref); else _allSelected.delete(ref); }
      const row = chk.closest('.loan__row');
      if (row) row.classList.toggle('loan__row--selected', checked);
    });
    _updateBulkBar(body);
  });

  // Bulk return button.
  $('[data-action="bulk-return"]', body)?.addEventListener('click', async () => {
    if (_allSelected.size === 0) return;
    await _bulkReturnLoans([..._allSelected], body);
  });

  // Clear selection button.
  $('[data-action="clear-selection"]', body)?.addEventListener('click', () => {
    _allSelected.clear();
    body.querySelectorAll('[data-action="select-row"]').forEach((chk) => { chk.checked = false; });
    $('[data-action="select-all-rows"]', body)?.let?.((h) => { h.checked = false; });
    _updateBulkBar(body);
    body.querySelectorAll('.loan__row--selected').forEach((r) => r.classList.remove('loan__row--selected'));
  });

  // Row expand/collapse for mobile — tapping a loan row reveals its detail row.
  body.querySelectorAll('[data-detail-target]').forEach((row) => {
    row.addEventListener('click', (e) => {
      // Don't expand if the user clicked a button inside the row, or the checkbox cell.
      if (e.target.closest('button') || e.target.closest('[data-no-expand]')) return;
      const detailId = row.dataset.detailTarget;
      const detailRow = body.querySelector(`#${detailId}`);
      if (!detailRow) return;
      const isOpen = !detailRow.hidden;
      detailRow.hidden = isOpen;
      detailRow.setAttribute('aria-hidden', String(isOpen));
      row.setAttribute('aria-expanded', String(!isOpen));
    });
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); }
    });
  });

  // Print outstanding button — generates a PDF of currently-active loans
  // sorted by due date ascending (most overdue first). Honours the search
  // filter but ignores the active/returned/overdue/all toggle, because
  // the report is specifically named "outstanding" and includes only
  // active loans by definition. If the user wanted other filtering
  // surfaces (e.g. "include returned"), that's a different report.
  $('[data-action="print-outstanding"]', body)?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = 'Building PDF…';
    try {
      const all = await Storage.loans.list();
      let active = all.filter((l) => l.active === true);
      // Honour the search filter only.
      if (_allSearch) {
        const q = _allSearch.toLowerCase();
        active = active.filter((l) =>
          [l.ref, l.itemName, l.nsn, l.borrowerName, l.borrowerSvc, l.purpose, l.remarks]
            .join(' ').toLowerCase().includes(q));
      }
      // Sort by dueDate asc (oldest due-date first → most overdue at top).
      active.sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''));
      const subtitle = _allSearch ? `Search: "${_allSearch}"` : '';
      const unit = await Storage.settings.getAll();
      const result = await generateOutstandingLoansReport(active, { unit, subtitle });
      downloadPdf(result);
    } catch (err) {
      showToast('Outstanding-loans report failed: ' + (err.message || err), 'error');
    } finally {
      btn.textContent = orig;
      btn.disabled = false;
    }
  });
  // Per-row "Print voucher" buttons. Each finds the loan's batch (other
  // loans sharing borrowerSvc + issueDate) and renders the whole batch
  // to one PDF — same as the issue-time confirmation flow.
  $$('[data-action="print-row-voucher"]', body).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ref = btn.dataset.loanRef;
      btn.disabled = true;
      const orig = btn.textContent;
      btn.textContent = '…';
      try {
        await _printVoucherForLoanRef(ref);
      } catch (err) {
        showToast('Voucher generation failed: ' + (err.message || err), 'error');
      } finally {
        btn.textContent = orig;
        btn.disabled = false;
      }
    });
  });
  // Per-row "AB189" buttons — same batch-lookup logic, different generator.
  $$('[data-action="print-row-ab189"]', body).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ref = btn.dataset.loanRef;
      btn.disabled = true;
      const orig = btn.textContent;
      btn.textContent = '…';
      try {
        await _printAB189ForLoanRef(ref);
      } catch (err) {
        showToast('AB189 generation failed: ' + (err.message || err), 'error');
      } finally {
        btn.textContent = orig;
        btn.disabled = false;
      }
    });
  });
  // Per-row "Quick Return" buttons — opens a compact return modal without
  // navigating away from the All Loans tab.
  $$('[data-action="quick-return"]', body).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ref = btn.dataset.loanRef;
      await _quickReturnLoan(ref, body);
    });
  });
}

// =============================================================================
// BULK RETURN
// =============================================================================

/**
 * Refresh the bulk-return action bar in-place without a full re-render.
 * Called whenever the selection set changes.
 */
function _updateBulkBar(body) {
  let bar = $('.loan__bulk-bar', body);
  const count = _allSelected.size;
  if (count === 0) {
    if (bar) bar.remove();
    return;
  }
  const barHtml = `
    <div class="loan__bulk-bar" role="toolbar" aria-label="Bulk return actions">
      <span class="loan__bulk-count">${count} loan${count === 1 ? '' : 's'} selected</span>
      <button type="button" class="btn btn--primary btn--sm" data-action="bulk-return">
        ↩ Return selected (${count})
      </button>
      <button type="button" class="btn btn--ghost btn--sm" data-action="clear-selection">
        ✕ Clear selection
      </button>
    </div>`;
  if (bar) {
    bar.outerHTML = barHtml;
    // Re-wire the newly replaced bar's buttons.
    bar = $('.loan__bulk-bar', body);
  } else {
    // Insert before the meta line.
    const meta = $('.loan__meta', body);
    if (meta) meta.insertAdjacentHTML('beforebegin', barHtml);
    bar = $('.loan__bulk-bar', body);
  }
  bar?.querySelector('[data-action="bulk-return"]')?.addEventListener('click', async () => {
    if (_allSelected.size === 0) return;
    await _bulkReturnLoans([..._allSelected], body);
  });
  bar?.querySelector('[data-action="clear-selection"]')?.addEventListener('click', () => {
    _allSelected.clear();
    body.querySelectorAll('[data-action="select-row"]').forEach((chk) => { chk.checked = false; });
    const allChk = $('[data-action="select-all-rows"]', body);
    if (allChk) allChk.checked = false;
    _updateBulkBar(body);
    body.querySelectorAll('.loan__row--selected').forEach((r) => r.classList.remove('loan__row--selected'));
  });
}

/**
 * Opens a confirm modal for bulk-returning multiple loans in one action.
 * The QM picks a single condition + remarks that apply to all selected loans.
 */
async function _bulkReturnLoans(refs, body) {
  AUTH.requirePermission('return');
  if (refs.length === 0) return;

  openModal({
    titleHtml: `Bulk Return — ${refs.length} loan${refs.length === 1 ? '' : 's'}`,
    size: 'sm',
    bodyHtml: `
      <p style="margin:0 0 12px;color:var(--text-secondary);font-size:13px">
        Return all ${refs.length} selected loan${refs.length === 1 ? '' : 's'} with the same condition and remarks.
      </p>
      <label class="form__field">
        <span class="form__label">Condition on return *</span>
        <select class="form__select" data-bulk-condition>
          <option value="serviceable">Serviceable</option>
          <option value="unserviceable">Unserviceable</option>
          <option value="write-off">Write-off</option>
        </select>
      </label>
      <label class="form__field" style="margin-top:10px">
        <span class="form__label">Remarks (optional)</span>
        <textarea class="form__input" rows="2" data-bulk-remarks placeholder="e.g. End of annual camp"></textarea>
      </label>
      <div class="form__error" data-bulk-error role="alert" style="margin-top:8px"></div>
      <div class="form__actions" style="margin-top:16px">
        <button type="button" class="btn btn--ghost" data-action="modal-close">Cancel</button>
        <button type="button" class="btn btn--primary" data-action="bulk-confirm">
          ↩ Return ${refs.length} loan${refs.length === 1 ? '' : 's'}
        </button>
      </div>
    `,
    async onMount(panel, close) {
      panel.querySelector('[data-action="bulk-confirm"]')?.addEventListener('click', async () => {
        const errEl     = panel.querySelector('[data-bulk-error]');
        const condition = panel.querySelector('[data-bulk-condition]')?.value || 'serviceable';
        const remarks   = panel.querySelector('[data-bulk-remarks]')?.value   || '';

        const confirmBtn = panel.querySelector('[data-action="bulk-confirm"]');
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Returning…';

        const sessionUser = AUTH.getSession()?.name || 'unknown';
        const returnDate  = _todayLocalIsoDate();
        const now         = new Date().toISOString();
        const needsPrompt = [];
        let returned      = 0;
        const errors      = [];

        // Fetch item list once for non-stock NSN matching.
        const imsItemsList = await Storage.items.list();

        for (const ref of refs) {
          try {
            const current = await Storage.loans.get(ref);
            if (!current) { errors.push(`${ref}: not found`); continue; }
            if (!current.active) { errors.push(`${ref}: already returned`); continue; }

            if (current.nonStock) {
              let matched = false;
              if (current.nsn) {
                const match = imsItemsList.find((i) => i.nsn === current.nsn);
                if (match) {
                  match.onHand = (Number(match.onHand) || 0) + current.qty;
                  if (match.qtyServiceable != null) {
                    match.qtyServiceable = (Number(match.qtyServiceable) || 0) + current.qty;
                  }
                  match.updatedAt = now;
                  await Storage.items.put(match);
                  const idx = imsItemsList.findIndex((i) => i.id === match.id);
                  if (idx >= 0) imsItemsList[idx] = match;
                  matched = true;
                }
              }
              if (!matched) needsPrompt.push({ name: current.itemName, nsn: current.nsn || '', qty: current.qty });
            } else if (current.existingLoan) {
              const item = await Storage.items.get(current.itemId);
              if (item) {
                item.onLoan = Math.max(0, (Number(item.onLoan) || 0) - current.qty);
                item.onHand = (Number(item.onHand) || 0) + current.qty;
                if (condition === 'serviceable' && item.qtyServiceable != null) {
                  item.qtyServiceable = (Number(item.qtyServiceable) || 0) + current.qty;
                }
                if (condition === 'unserviceable' || condition === 'write-off') {
                  item.unsvc = (Number(item.unsvc) || 0) + current.qty;
                  if (item.qtyUnserviceable != null) {
                    item.qtyUnserviceable = (Number(item.qtyUnserviceable) || 0) + current.qty;
                  }
                }
                if (condition === 'write-off') item.condition = 'unserviceable';
                item.updatedAt = now;
                await Storage.items.put(item);
              }
            } else {
              const item = await Storage.items.get(current.itemId);
              if (item) {
                item.onLoan = Math.max(0, (Number(item.onLoan) || 0) - current.qty);
                if (condition === 'unserviceable' || condition === 'write-off') {
                  item.unsvc = (Number(item.unsvc) || 0) + current.qty;
                }
                if (condition === 'write-off') item.condition = 'unserviceable';
                item.updatedAt = now;
                await Storage.items.put(item);
              }
            }

            current.active          = false;
            current.returnDate      = returnDate;
            current.returnCondition = condition;
            current.returnRemarks   = remarks;
            current.returnedBy      = sessionUser;
            await Storage.loans.put(current);

            await Storage.audit.append({
              action: 'return',
              user:   sessionUser,
              desc:   `${ref}: ${current.itemName} × ${current.qty} returned by ${current.borrowerName} — ${condition} [bulk]`,
            });
            returned++;
          } catch (err) {
            errors.push(`${ref}: ${err.message}`);
          }
        }

        Sync.notifyChanged();
        _allSelected.clear();
        close();

        if (errors.length > 0) {
          showToast(`Returned ${returned}. Errors: ${errors.join('; ')}`, 'error', 8000);
        } else {
          showToast(`${returned} loan${returned === 1 ? '' : 's'} returned (${condition}).`, 'success');
        }

        if (needsPrompt.length > 0) {
          await _promptAddNonStockToInventory(needsPrompt);
        } else {
          await _renderAllTab(body);
          _wireAllTab(body);
        }
      });
    },
  });
}

// =============================================================================
// QUICK RETURN
// =============================================================================

/**
 * Opens a compact modal that lets the QM return a single loan from the All
 * Loans tab without navigating to the Return tab. Reuses the same item-update
 * logic as _submitReturn so stock figures stay consistent.
 */
async function _quickReturnLoan(ref, body) {
  AUTH.requirePermission('return');
  const loan = await Storage.loans.get(ref);
  if (!loan) { showToast('Loan not found.', 'error'); return; }
  if (!loan.active) { showToast('This loan has already been returned.', 'error'); return; }

  openModal({
    titleHtml: `Quick Return — ${esc(loan.ref)}`,
    size: 'sm',
    bodyHtml: `
      <dl class="loan__detail-dl" style="margin-bottom:16px">
        <div><dt>Item</dt><dd>${esc(loan.itemName || '—')} × ${loan.qty}</dd></div>
        <div><dt>Borrower</dt><dd>${esc(loan.borrowerName || '—')}</dd></div>
        <div><dt>Issued</dt><dd>${esc(loan.issueDate || '—')}</dd></div>
        ${loan.longTermLoan ? '<div><dt>Due</dt><dd>Long-term</dd></div>' : `<div><dt>Due</dt><dd>${esc(loan.dueDate || '—')}</dd></div>`}
      </dl>
      <label class="form__field">
        <span class="form__label">Condition on return *</span>
        <select class="form__select" data-qr-condition>
          <option value="serviceable">Serviceable</option>
          <option value="unserviceable">Unserviceable</option>
          <option value="write-off">Write-off</option>
        </select>
      </label>
      <label class="form__field" style="margin-top:10px">
        <span class="form__label">Remarks</span>
        <textarea class="form__input" rows="2" data-qr-remarks placeholder="Optional notes…"></textarea>
      </label>
      <div class="form__error" data-qr-error role="alert" style="margin-top:8px"></div>
      <div class="form__actions" style="margin-top:16px">
        <button type="button" class="btn btn--ghost" data-action="modal-close">Cancel</button>
        <button type="button" class="btn btn--primary" data-action="qr-confirm">↩ Confirm Return</button>
      </div>
    `,
    async onMount(panel, close) {
      panel.querySelector('[data-action="qr-confirm"]')?.addEventListener('click', async () => {
        const errEl   = panel.querySelector('[data-qr-error]');
        const condition = panel.querySelector('[data-qr-condition]')?.value || 'serviceable';
        const remarks   = panel.querySelector('[data-qr-remarks]')?.value   || '';

        const confirmBtn = panel.querySelector('[data-action="qr-confirm"]');
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Returning…';

        try {
          // Re-fetch the loan to ensure we have current state.
          const current = await Storage.loans.get(ref);
          if (!current || !current.active) {
            errEl.textContent = 'This loan has already been returned.';
            return;
          }

          const sessionUser = AUTH.getSession()?.name || 'unknown';
          const returnDate  = _todayLocalIsoDate();
          const now         = new Date().toISOString();
          const needsPrompt = [];

          // _qrUpdatedItem collects any item that must be co-written with the
          // loan record in one IDB transaction (prevents partial-write corruption).
          let _qrUpdatedItem = null;

          if (current.nonStock) {
            // Non-stock return — try NSN match.
            let matched = false;
            if (current.nsn) {
              const imsItems = await Storage.items.list();
              const match = imsItems.find((i) => i.nsn === current.nsn);
              if (match) {
                match.onHand = (Number(match.onHand) || 0) + current.qty;
                if (match.qtyServiceable != null) {
                  match.qtyServiceable = (Number(match.qtyServiceable) || 0) + current.qty;
                }
                match.updatedAt = now;
                _qrUpdatedItem = match; // deferred — written atomically with loan below
                matched = true;
                showToast('Non-stock item matched by NSN and added to inventory.', 'success', 5000);
              }
            }
            if (!matched) {
              needsPrompt.push({ name: current.itemName, nsn: current.nsn || '', qty: current.qty });
            }
          } else if (current.existingLoan) {
            const item = await Storage.items.get(current.itemId);
            if (item) {
              item.onLoan = Math.max(0, (Number(item.onLoan) || 0) - current.qty);
              item.onHand = (Number(item.onHand) || 0) + current.qty;
              if (condition === 'serviceable' && item.qtyServiceable != null) {
                item.qtyServiceable = (Number(item.qtyServiceable) || 0) + current.qty;
              }
              if (condition === 'unserviceable' || condition === 'write-off') {
                item.unsvc = (Number(item.unsvc) || 0) + current.qty;
                if (item.qtyUnserviceable != null) {
                  item.qtyUnserviceable = (Number(item.qtyUnserviceable) || 0) + current.qty;
                }
              }
              if (condition === 'write-off') item.condition = 'unserviceable';
              item.updatedAt = now;
              _qrUpdatedItem = item; // deferred — written atomically with loan below
              showToast('Existing-loan item returned — On Hand restored.', 'success', 5000);
            }
          } else {
            // Standard return.
            const item = await Storage.items.get(current.itemId);
            if (item) {
              item.onLoan = Math.max(0, (Number(item.onLoan) || 0) - current.qty);
              if (condition === 'unserviceable' || condition === 'write-off') {
                item.unsvc = (Number(item.unsvc) || 0) + current.qty;
              }
              if (condition === 'write-off') item.condition = 'unserviceable';
              item.updatedAt = now;
              _qrUpdatedItem = item; // deferred — written atomically with loan below
            }
          }

          current.active          = false;
          current.returnDate      = returnDate;
          current.returnCondition = condition;
          current.returnRemarks   = remarks;
          current.returnedBy      = sessionUser;
          // Write loan + item change in one IDB transaction where possible.
          if (_qrUpdatedItem) {
            await Storage.atomic.return(current, _qrUpdatedItem);
          } else {
            await Storage.loans.put(current);
          }

          await Storage.audit.append({
            action: 'return',
            user:   sessionUser,
            desc:   `${ref}: ${current.itemName} × ${current.qty} returned by ${current.borrowerName} — ${condition}${current.nonStock ? ' [non-stock]' : ''}`,
          });

          Sync.notifyChanged();
          close();

          if (needsPrompt.length > 0) {
            await _promptAddNonStockToInventory(needsPrompt);
          } else {
            showToast(`${ref} returned (${condition}).`, 'success');
            await _renderAllTab(body);
            _wireAllTab(body);
          }
        } catch (err) {
          errEl.textContent = 'Return failed: ' + (err.message || err);
          confirmBtn.disabled = false;
          confirmBtn.textContent = '↩ Confirm Return';
        }
      });
    },
  });
}

// =============================================================================
// SHARED HELPERS
// =============================================================================

/**
 * Reusable borrower picker. The picker is a text input + datalist. Posts to
 * a hidden field (data-borrower-id="<context>") which the wiring code reads
 * to extract the chosen svcNo. The visible string is '<rank> <surname> (<svcNo>)'.
 *
 * `context` distinguishes Issue from Return so two pickers can coexist on
 * one page render without clashing data attributes.
 */
function _borrowerPickerHtml(context, currentSvcNo, cadets, currentCadet) {
  const value = currentCadet
    ? `${currentCadet.rank} ${currentCadet.surname} (${currentCadet.svcNo})`
    : '';
  const listId = `loan-borrower-list-${context}`;

  // Build option label: rank + surname + svcNo + company/platoon/section suffix.
  // The svcNo must be present so the input handler can resolve the match.
  // Adding company/plt/section means users can search by unit sub-structure.
  const _groupSuffix = (c) => {
    const parts = [];
    if (c.company)  parts.push(c.company);
    if (c.platoon || c.plt) parts.push(c.platoon || c.plt);
    if (c.section)  parts.push(c.section);
    return parts.length ? ` · ${parts.join(' / ')}` : '';
  };

  const sortedCadets = cadets.slice().sort((a, b) => {
    const typeA = a.personType === 'staff' ? 0 : 1;
    const typeB = b.personType === 'staff' ? 0 : 1;
    return (typeA - typeB) || compareRanks(a.rank, b.rank) ||
      (a.surname || '').localeCompare(b.surname || '');
  });

  return `
    <label class="form__field">
      <span class="form__label">Search by name, service number, or sub-unit</span>
      <input type="text" class="loan__borrower-search"
             data-borrower-search="${esc(context)}"
             value="${esc(value)}"
             list="${listId}"
             placeholder="Start typing name, svc no, or company…"
             autocomplete="off">
      <datalist id="${listId}">
        ${sortedCadets
          .map((c) =>
            `<option value="${esc(c.rank)} ${esc(c.surname)} (${esc(c.svcNo)})">` +
            `${esc(c.rank)} ${esc(c.surname)} (${esc(c.svcNo)})${esc(_groupSuffix(c))}</option>`)
          .join('')}
      </datalist>
      <input type="hidden" data-borrower-id="${esc(context)}"
             value="${esc(currentSvcNo)}">
    </label>
  `;
}

/**
 * Generate the next loan reference. Uses the counters store so the value
 * is monotonic across tabs/devices (assuming sync resolves the counter on
 * pull). Format matches v1: 'LN-NNNN' starting at LN-1000.
 */
async function _nextLoanRef() {
  const n = await Storage.counters.next('loan', 1000);
  return `LN-${n}`;
}

/** ISO date string (YYYY-MM-DD) for "today" in the local timezone. */
function _todayLocalIsoDate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Today as a Date object stripped to midnight local — used for date comparisons. */
function _todayLocalDateOnly() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Default due date for the issue form: 14 days from today. Arbitrary but
 * sensible for parade-night loans which is the common case. */
function _defaultDueDate() {
  // Returns '' if the QM has configured "no default" (0 days).
  if (_defaultDueDays === 0) return '';
  const d = new Date();
  d.setDate(d.getDate() + _defaultDueDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Return date for Initial Issue loans: 6 years from today.
 *  Matches the standard cadet engagement period. */
function _sixYearsFromToday() {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 6);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// =============================================================================
// VOUCHER PRINTING
// =============================================================================
// Two entry points:
//   _printVoucherForLoans(loans)  — caller already has the list (issue
//                                   confirmation modal: pass `created`).
//   _printVoucherForLoanRef(ref)  — caller has only a ref (All-loans row
//                                   action: looks up the loan, finds its
//                                   batch, then prints).
//
// "Batch" = all loans sharing borrowerSvc + issueDate. The voucher PDF
// represents one paper handover; in real-unit practice that's one paper
// per borrower per day, regardless of how many items changed hands.

async function _printVoucherForLoans(loans) {
  if (!Array.isArray(loans) || loans.length === 0) {
    throw new Error('No loans provided to print.');
  }
  // Pull unit branding from settings — used in the PDF header and the
  // pre-filled "Issued by" signature block.
  const unit = await Storage.settings.getAll();
  const issuedByName = AUTH.getSession()?.name || '';
  const result = await generateIssueVoucher(loans, { unit, issuedByName });
  downloadPdf(result);
  const refs = loans.map((l) => l.ref).join(', ');
  await Storage.audit.append({
    action: 'pdf_voucher',
    user:   AUTH.getSession()?.name || 'unknown',
    desc:   `Issue voucher printed — ${loans.length} item(s): ${refs}`,
  });
}

async function _printVoucherForLoanRef(ref) {
  const loan = await Storage.loans.get(ref);
  if (!loan) throw new Error(`Loan ${ref} not found.`);

  // Find the whole batch — all loans for this borrower on this day.
  // listForCadet uses the borrowerSvc index; we filter for the issueDate.
  const allForBorrower = await Storage.loans.listForCadet(loan.borrowerSvc);
  const batch = allForBorrower
    .filter((l) => l.issueDate === loan.issueDate)
    // Sort by ref so the voucher rows appear in issue order, which is
    // what the user expects when they look at LN-1043 through LN-1047
    // and compare to the printed paper.
    .sort((a, b) => (a.ref || '').localeCompare(b.ref || ''));

  if (batch.length === 0) {
    // Shouldn't happen — `loan` itself is in the listForCadet result.
    // Defensive in case of storage anomaly.
    throw new Error(`Could not find any loans for ${loan.borrowerSvc} on ${loan.issueDate}.`);
  }
  await _printVoucherForLoans(batch);
}

async function _printAB189ForLoans(loans) {
  if (!Array.isArray(loans) || loans.length === 0) {
    throw new Error('No loans provided to print.');
  }
  const unit  = await Storage.settings.getAll();
  const cadet = await Storage.cadets.get(loans[0].borrowerSvc)
            || await Storage.staff.get(loans[0].borrowerSvc);
  const result = await generateAB189(loans, { unit, cadet: cadet || null });
  downloadPdf(result);
  const refs = loans.map((l) => l.ref).join(', ');
  await Storage.audit.append({
    action: 'pdf_ab189',
    user:   AUTH.getSession()?.name || 'unknown',
    desc:   `AB189 printed for ${loans[0].borrowerName || loans[0].borrowerSvc} — ${loans.length} item(s): ${refs}`,
  });
}

async function _printAB189ForLoanRef(ref) {
  const loan = await Storage.loans.get(ref);
  if (!loan) throw new Error(`Loan ${ref} not found.`);
  const allForBorrower = await Storage.loans.listForCadet(loan.borrowerSvc);
  const batch = allForBorrower
    .filter((l) => l.issueDate === loan.issueDate)
    .sort((a, b) => (a.ref || '').localeCompare(b.ref || ''));
  if (batch.length === 0) {
    throw new Error(`Could not find any loans for ${loan.borrowerSvc} on ${loan.issueDate}.`);
  }
  await _printAB189ForLoans(batch);
}
