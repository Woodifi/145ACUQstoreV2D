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
import { openModal }                       from './modal.js';
import { esc, $, $$, render, fmtDateOnly } from './util.js';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

// Same set v1 used. If a unit needs others, they pick 'Other' and put a
// note in remarks. Future settings page could make these editable per-unit.
const PURPOSES = [
  'Initial Issue',
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
  _root      = rootEl;
  _allFilter = 'active';
  _allSearch = '';
  _issueState  = _freshIssueState();
  _returnState = _freshReturnState();
  _activeTab   = _firstAllowedTab();
  await _render();
  return function unmount() { _root = null; };
}

function _freshIssueState()  { return { svcNo: '', lines: [_freshLine()] }; }
function _freshReturnState() { return { svcNo: '', refsChecked: new Set() }; }
function _freshLine()        { return { itemId: '', qty: 1 }; }

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

  const cadets = await Storage.cadets.list();
  const items  = await Storage.items.list();
  const activeCadets = cadets.filter((c) => c.active !== false);

  // Resolve the currently-selected borrower (if any) so we can show their
  // name and any existing active loans alongside the form.
  const borrower = _issueState.svcNo
    ? cadets.find((c) => c.svcNo === _issueState.svcNo) || null
    : null;
  const borrowerActiveLoans = borrower
    ? (await Storage.loans.listForCadet(borrower.svcNo)).filter((l) => l.active === true)
    : [];

  // For the item picker — filter to items with available stock. We compute
  // available = onHand - onLoan. Items at zero or below don't appear; the
  // user can still see them on the inventory page.
  const availableItems = items
    .map((i) => ({ ...i, _avail: Math.max(0, (Number(i.onHand) || 0) - (Number(i.onLoan) || 0)) }))
    .filter((i) => i._avail > 0);

  body.innerHTML = `
    <div class="loan__issue">
      <div class="loan__issue-form">
        <h3 class="loan__heading">1. Borrower</h3>
        ${_borrowerPickerHtml('issue', _issueState.svcNo, activeCadets, borrower)}

        <h3 class="loan__heading">2. Items</h3>
        ${_issueLinesHtml(_issueState.lines, availableItems)}

        <h3 class="loan__heading">3. Issue details</h3>
        <div class="form__row">
          <label class="form__field form__field--grow">
            <span class="form__label">Purpose *</span>
            <select name="purpose" data-issue-field="purpose">
              ${PURPOSES.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('')}
            </select>
          </label>
          <label class="form__field">
            <span class="form__label">Due date *</span>
            <input type="date" name="dueDate" data-issue-field="dueDate"
                   value="${esc(_defaultDueDate())}" required>
          </label>
        </div>
        <label class="form__field">
          <span class="form__label">Remarks</span>
          <textarea name="remarks" rows="2" maxlength="300"
                    data-issue-field="remarks"
                    placeholder="optional"></textarea>
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

  _wireIssueTab(body, activeCadets, availableItems);
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

function _issueLineHtml(line, index, availableItems) {
  const item = line.itemId ? availableItems.find((i) => i.id === line.itemId) : null;
  const maxQty = item ? item._avail : 1;
  return `
    <div class="loan__line" data-line-index="${index}">
      <label class="form__field form__field--grow">
        ${index === 0 ? '<span class="form__label">Item *</span>' : ''}
        <input type="text" data-line-field="itemSearch"
               class="loan__item-search"
               placeholder="Search items by name or NSN…"
               value="${esc(item ? `${item.name} (${item.nsn || 'no NSN'})` : '')}"
               autocomplete="off"
               list="loan-item-list-${index}">
        <datalist id="loan-item-list-${index}">
          ${availableItems.map((i) =>
            `<option value="${esc(i.name)} (${esc(i.nsn || 'no NSN')})"
                     data-id="${esc(i.id)}"
                     data-avail="${i._avail}">`).join('')}
        </datalist>
        <input type="hidden" data-line-field="itemId" value="${esc(line.itemId)}">
        ${item ? `<span class="form__hint">${item._avail} available</span>` : ''}
      </label>
      <label class="form__field loan__qty-field">
        ${index === 0 ? '<span class="form__label">Qty *</span>' : ''}
        <input type="number" data-line-field="qty"
               value="${line.qty}" min="1" max="${maxQty}" step="1">
      </label>
      ${index > 0 ? `
        <button type="button" class="btn btn--sm btn--ghost loan__line-remove"
                data-action="issue-remove-line" data-line-index="${index}"
                aria-label="Remove this line">×</button>
      ` : '<span class="loan__line-spacer"></span>'}
    </div>
  `;
}

function _wireIssueTab(body, activeCadets, availableItems) {
  // Borrower picker change — search input + datalist.
  const borrowerInput = $('input[data-borrower-search="issue"]', body);
  const borrowerHidden = $('input[data-borrower-id="issue"]', body);
  borrowerInput?.addEventListener('input', () => {
    const val = borrowerInput.value;
    // Try to find an exact match in our cadet list (the datalist option
    // texts are formatted '<rank> <surname> (<svcNo>)').
    const match = activeCadets.find((c) =>
      `${c.rank} ${c.surname} (${c.svcNo})` === val);
    borrowerHidden.value = match ? match.svcNo : '';
    if (match && match.svcNo !== _issueState.svcNo) {
      _issueState.svcNo = match.svcNo;
      _render();
    }
  });

  // Per-line item search inputs — same pattern.
  $$('.loan__line', body).forEach((lineEl) => {
    const idx = Number(lineEl.dataset.lineIndex);
    const itemSearch = $('input[data-line-field="itemSearch"]', lineEl);
    const itemHidden = $('input[data-line-field="itemId"]', lineEl);
    const qtyInput   = $('input[data-line-field="qty"]', lineEl);

    itemSearch?.addEventListener('input', () => {
      const val = itemSearch.value;
      const match = availableItems.find((i) =>
        `${i.name} (${i.nsn || 'no NSN'})` === val);
      itemHidden.value = match ? match.id : '';
      if (match) {
        _issueState.lines[idx].itemId = match.id;
        // Clamp qty to available.
        if (Number(qtyInput.value) > match._avail) {
          qtyInput.value = match._avail;
          _issueState.lines[idx].qty = match._avail;
        }
        _render();    // re-render shows the available-stock hint
      } else {
        _issueState.lines[idx].itemId = '';
      }
    });

    qtyInput?.addEventListener('input', () => {
      const n = Number(qtyInput.value);
      if (Number.isFinite(n) && n > 0) _issueState.lines[idx].qty = Math.floor(n);
    });
  });

  // Field bindings for purpose/dueDate/remarks — read on submit, no need
  // to mirror to state on every keystroke.
  body.addEventListener('click', async (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'issue-add-line') {
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

async function _submitIssue(body) {
  const errEl = $('[data-issue-error]', body);
  errEl.textContent = '';

  // Re-read everything from the live DOM at submit time. The state object
  // tracks the structure (which lines exist) but the values come from the
  // form so we don't have to mirror every keystroke into state.
  const purpose = $('select[data-issue-field="purpose"]', body)?.value || '';
  const dueDate = $('input[data-issue-field="dueDate"]', body)?.value || '';
  const remarks = $('textarea[data-issue-field="remarks"]', body)?.value || '';

  if (!_issueState.svcNo) {
    errEl.textContent = 'Select a borrower first.';
    return;
  }
  if (!purpose)  { errEl.textContent = 'Purpose is required.'; return; }
  if (!dueDate)  { errEl.textContent = 'Due date is required.'; return; }
  if (new Date(dueDate) < _todayLocalDateOnly()) {
    errEl.textContent = 'Due date cannot be in the past.';
    return;
  }

  // Validate every line: must have an item and qty > 0 and qty <= avail.
  const cadet = await Storage.cadets.get(_issueState.svcNo);
  if (!cadet) { errEl.textContent = 'Selected borrower no longer exists.'; return; }

  const lineErrors = [];
  const resolvedLines = [];
  for (let i = 0; i < _issueState.lines.length; i++) {
    const ln = _issueState.lines[i];
    if (!ln.itemId) {
      lineErrors.push(`Line ${i + 1}: choose an item from the list.`);
      continue;
    }
    const item = await Storage.items.get(ln.itemId);
    if (!item) {
      lineErrors.push(`Line ${i + 1}: item no longer exists.`);
      continue;
    }
    const avail = Math.max(0, (Number(item.onHand) || 0) - (Number(item.onLoan) || 0));
    const qty = Math.floor(Number(ln.qty) || 0);
    if (qty < 1) {
      lineErrors.push(`Line ${i + 1}: quantity must be at least 1.`);
      continue;
    }
    if (qty > avail) {
      lineErrors.push(`Line ${i + 1}: only ${avail} of ${item.name} available.`);
      continue;
    }
    resolvedLines.push({ item, qty });
  }
  if (lineErrors.length > 0) {
    errEl.textContent = lineErrors.join(' ');
    return;
  }
  if (resolvedLines.length === 0) {
    errEl.textContent = 'Add at least one item to issue.';
    return;
  }

  // Detect double-issue of the same item across lines (would over-allocate).
  const sumByItemId = new Map();
  for (const { item, qty } of resolvedLines) {
    sumByItemId.set(item.id, (sumByItemId.get(item.id) || 0) + qty);
  }
  for (const [itemId, totalQty] of sumByItemId) {
    const item = resolvedLines.find((r) => r.item.id === itemId).item;
    const avail = Math.max(0, (Number(item.onHand) || 0) - (Number(item.onLoan) || 0));
    if (totalQty > avail) {
      errEl.textContent = `Total quantity for ${item.name} (${totalQty}) exceeds available (${avail}). Combine the lines.`;
      return;
    }
  }

  // Walk the batch and create one loan record per line. We do these
  // sequentially — if one fails midway, prior ones stay (caller sees
  // partial success in the audit log; this is acceptable since the
  // failure is more likely to be quota/disk than logic).
  const issueDate   = _todayLocalIsoDate();
  const borrowerName = `${cadet.rank} ${cadet.surname}`;
  const sessionUser  = AUTH.getSession()?.name || 'unknown';

  const created = [];
  try {
    for (const { item, qty } of resolvedLines) {
      const ref = await _nextLoanRef();
      const loan = {
        ref,
        itemId:       item.id,
        itemName:     item.name,
        nsn:          item.nsn || '',
        qty,
        borrowerSvc:  cadet.svcNo,
        borrowerName,
        purpose,
        issueDate,
        dueDate,
        condition:    item.condition || 'serviceable',
        remarks,
        active:       true,
        issuedBy:     sessionUser,
      };

      // Item update first — fail here means stock was already changing,
      // do NOT create the loan record. After this succeeds, the loan
      // and audit appends are best-effort recovery.
      const fresh = await Storage.items.get(item.id);
      if (!fresh) throw new Error(`Item ${item.name} was deleted during issue.`);
      const freshAvail = Math.max(0, (Number(fresh.onHand) || 0) - (Number(fresh.onLoan) || 0));
      if (qty > freshAvail) {
        throw new Error(`Race: another tab took stock of ${item.name}; only ${freshAvail} now available.`);
      }
      fresh.onLoan = (Number(fresh.onLoan) || 0) + qty;
      await Storage.items.put(fresh);

      await Storage.loans.put(loan);
      await Storage.audit.append({
        action: 'issue',
        user:   sessionUser,
        desc:   `${ref}: ${item.name} × ${qty} issued to ${borrowerName} for ${purpose}`,
      });
      created.push(loan);
    }
  } catch (err) {
    errEl.textContent =
      `Issued ${created.length} of ${resolvedLines.length} item(s) before error: ${err.message}`;
    Sync.notifyChanged();
    return;
  }

  Sync.notifyChanged();

  // Confirmation modal — list the created refs so the user can copy them.
  openModal({
    titleHtml: `Issued ${created.length} ${created.length === 1 ? 'item' : 'items'}`,
    size:      'sm',
    bodyHtml: `
      <p class="modal__body">
        Issued to <strong>${esc(borrowerName)}</strong> for ${esc(purpose)}, due ${esc(dueDate)}.
      </p>
      <ul class="loan__confirm-list">
        ${created.map((l) =>
          `<li><span class="loan__confirm-ref">${esc(l.ref)}</span> ${esc(l.itemName)} × ${l.qty}</li>`
        ).join('')}
      </ul>
      <div class="form__actions">
        <button type="button" class="btn btn--primary" data-action="modal-close">OK</button>
      </div>`,
  });

  _issueState = _freshIssueState();
  await _render();
}

// =============================================================================
// RETURN TAB
// =============================================================================

async function _renderReturnTab(body) {
  AUTH.requirePermission('return');

  const cadets = await Storage.cadets.list();

  // Borrowers shown in the picker = cadets with at least one active loan.
  // Walking listForCadet for every cadet would be O(N) queries; faster
  // to fetch all loans once and group.
  const allLoans = await Storage.loans.list();
  const activeLoans = allLoans.filter((l) => l.active === true);
  const svcsWithLoans = new Set(activeLoans.map((l) => l.borrowerSvc));
  const eligibleCadets = cadets.filter((c) => svcsWithLoans.has(c.svcNo));

  // The user might have selected a borrower who's since been fully returned
  // (e.g. via another tab). In that case clear the selection silently.
  if (_returnState.svcNo && !svcsWithLoans.has(_returnState.svcNo)) {
    _returnState.svcNo = '';
    _returnState.refsChecked.clear();
  }

  const borrower = _returnState.svcNo
    ? cadets.find((c) => c.svcNo === _returnState.svcNo) || null
    : null;
  const borrowerLoans = borrower
    ? activeLoans.filter((l) => l.borrowerSvc === borrower.svcNo)
    : [];

  body.innerHTML = `
    <div class="loan__return">
      <h3 class="loan__heading">1. Borrower</h3>
      ${_borrowerPickerHtml('return', _returnState.svcNo, eligibleCadets, borrower)}

      ${borrower ? `
        <h3 class="loan__heading">2. Items to return</h3>
        ${borrowerLoans.length === 0
          ? `<p class="loan__empty">No active loans for this borrower.</p>`
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

  _wireReturnTab(body, eligibleCadets, borrowerLoans);
}

function _returnLoanRowHtml(loan) {
  const checked = _returnState.refsChecked.has(loan.ref);
  const overdue = loan.dueDate && loan.dueDate < _todayLocalIsoDate();
  return `
    <label class="loan__return-row ${overdue ? 'loan__return-row--overdue' : ''}">
      <input type="checkbox" data-return-ref="${esc(loan.ref)}"
             ${checked ? 'checked' : ''}>
      <span class="loan__return-ref">${esc(loan.ref)}</span>
      <span class="loan__return-item">${esc(loan.itemName)} × ${loan.qty}</span>
      <span class="loan__return-due">
        ${overdue ? 'OVERDUE — ' : 'due '}${esc(loan.dueDate)}
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

  let returned = 0;
  const errors  = [];
  for (const ref of _returnState.refsChecked) {
    try {
      const loan = await Storage.loans.get(ref);
      if (!loan) { errors.push(`${ref}: no longer exists`); continue; }
      if (!loan.active) { errors.push(`${ref}: already returned`); continue; }

      // Decrement onLoan, optionally bump unsvc.
      const item = await Storage.items.get(loan.itemId);
      if (item) {
        item.onLoan = Math.max(0, (Number(item.onLoan) || 0) - loan.qty);
        if (condition === 'unserviceable' || condition === 'write-off') {
          item.unsvc = (Number(item.unsvc) || 0) + loan.qty;
        }
        if (condition === 'write-off') {
          // Mirror v1: write-off also marks the item itself as unserviceable.
          item.condition = 'unserviceable';
        }
        await Storage.items.put(item);
      }
      // If item is missing we still close out the loan — the loan record
      // is the historical truth, item missing is its own error elsewhere.

      loan.active           = false;
      loan.returnDate       = returnDate;
      loan.returnCondition  = condition;
      loan.returnRemarks    = remarks;
      loan.returnedBy       = sessionUser;
      await Storage.loans.put(loan);

      await Storage.audit.append({
        action: 'return',
        user:   sessionUser,
        desc:   `${ref}: ${loan.itemName} × ${loan.qty} returned by ${loan.borrowerName} — ${condition}`,
      });
      returned++;
    } catch (err) {
      errors.push(`${ref}: ${err.message}`);
    }
  }

  Sync.notifyChanged();

  if (errors.length > 0) {
    errEl.textContent = `Returned ${returned}. Errors: ${errors.join('; ')}`;
  }
  // Reset state and re-render — list will refresh with the items removed.
  _returnState = _freshReturnState();
  await _render();
}

// =============================================================================
// ALL LOANS TAB
// =============================================================================

async function _renderAllTab(body) {
  AUTH.requirePermission('view');

  const all = await Storage.loans.list();
  const today = _todayLocalIsoDate();

  // Apply filter then search.
  let filtered = all;
  if (_allFilter === 'active') {
    filtered = filtered.filter((l) => l.active === true);
  } else if (_allFilter === 'returned') {
    filtered = filtered.filter((l) => l.active === false);
  } else if (_allFilter === 'overdue') {
    filtered = filtered.filter((l) => l.active === true && l.dueDate && l.dueDate < today);
  }
  if (_allSearch) {
    const q = _allSearch.toLowerCase();
    filtered = filtered.filter((l) =>
      [l.ref, l.itemName, l.nsn, l.borrowerName, l.borrowerSvc, l.purpose, l.remarks]
        .join(' ').toLowerCase().includes(q));
  }
  // Sort by issueDate desc (most recent first), tie-break by ref desc so
  // batches stay grouped.
  filtered.sort((a, b) => {
    const d = (b.issueDate || '').localeCompare(a.issueDate || '');
    return d !== 0 ? d : (b.ref || '').localeCompare(a.ref || '');
  });

  // Restrict view for non-OC/QM users to their own loans (viewOwnLoans).
  // We'll wire that properly in v2.2 when user-cadet linking lands; for now
  // OC/QM see all, others see all (read-only).
  const canReturn = AUTH.can('return');

  const filterCounts = {
    all:      all.length,
    active:   all.filter((l) => l.active === true).length,
    returned: all.filter((l) => l.active === false).length,
    overdue:  all.filter((l) => l.active === true && l.dueDate && l.dueDate < today).length,
  };

  body.innerHTML = `
    <div class="loan__all">
      <header class="loan__all-toolbar">
        <div class="loan__all-filters">
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
      </header>

      <div class="loan__meta">
        ${filtered.length} ${filtered.length === 1 ? 'loan' : 'loans'} shown
        ${(_allSearch || _allFilter !== 'all') && all.length !== filtered.length
          ? `<span class="loan__meta-of"> of ${all.length}</span>` : ''}
      </div>

      <div class="loan__table-wrap">
        ${filtered.length === 0
          ? `<div class="loan__empty">
               <p>No loans match the current filters.</p>
             </div>`
          : _allTableHtml(filtered, today, canReturn)}
      </div>
    </div>
  `;

  _wireAllTab(body);
}

function _allTableHtml(loans, today, canReturn) {
  return `
    <table class="loan__table">
      <thead>
        <tr>
          <th>Ref</th>
          <th>Issued</th>
          <th>Item</th>
          <th>Qty</th>
          <th>Borrower</th>
          <th>Purpose</th>
          <th>Due</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${loans.map((l) => _allRowHtml(l, today, canReturn)).join('')}
      </tbody>
    </table>
  `;
}

function _allRowHtml(loan, today, canReturn) {
  const overdue = loan.active === true && loan.dueDate && loan.dueDate < today;
  let statusBadge;
  if (loan.active === false) {
    statusBadge = `<span class="loan__badge loan__badge--returned">Returned ${esc(loan.returnDate || '')}</span>`;
  } else if (overdue) {
    statusBadge = `<span class="loan__badge loan__badge--overdue">Overdue</span>`;
  } else {
    statusBadge = `<span class="loan__badge loan__badge--active">Active</span>`;
  }

  return `
    <tr class="loan__row ${overdue ? 'loan__row--overdue' : ''}
                       ${loan.active === false ? 'loan__row--returned' : ''}">
      <td class="loan__ref">${esc(loan.ref)}</td>
      <td class="loan__date">${esc(loan.issueDate || '')}</td>
      <td>
        <div>${esc(loan.itemName || '')}</div>
        ${loan.nsn ? `<div class="loan__nsn">${esc(loan.nsn)}</div>` : ''}
      </td>
      <td class="loan__qty">${loan.qty}</td>
      <td>
        <div>${esc(loan.borrowerName || '')}</div>
        <div class="loan__nsn">${esc(loan.borrowerSvc || '')}</div>
      </td>
      <td>${esc(loan.purpose || '')}</td>
      <td class="loan__date">${esc(loan.dueDate || '')}</td>
      <td>${statusBadge}</td>
    </tr>
  `;
}

function _wireAllTab(body) {
  $('.loan__all-search', body)?.addEventListener('input', (e) => {
    _allSearch = e.target.value;
    _renderAllTab(body);
    _wireAllTab(body);   // re-wire after partial re-render
  });
  $$('[data-action="all-filter"]', body).forEach((btn) => {
    btn.addEventListener('click', () => {
      _allFilter = btn.dataset.filter;
      _renderAllTab(body);
      _wireAllTab(body);
    });
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
  return `
    <label class="form__field">
      <span class="form__label">Search by name or service number</span>
      <input type="text" class="loan__borrower-search"
             data-borrower-search="${esc(context)}"
             value="${esc(value)}"
             list="${listId}"
             placeholder="Start typing…"
             autocomplete="off">
      <datalist id="${listId}">
        ${cadets
          .slice()
          .sort((a, b) => (a.surname || '').localeCompare(b.surname || ''))
          .map((c) =>
            `<option value="${esc(c.rank)} ${esc(c.surname)} (${esc(c.svcNo)})">`)
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
  const d = new Date();
  d.setDate(d.getDate() + 14);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
