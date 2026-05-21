// =============================================================================
// QStore IMS v2.3 — Equipment Request (self-service) page
// =============================================================================
// Allows cadets and staff to submit equipment requests (AB189-style) without
// needing direct access to the Issue tab. QMs and the CO can then approve,
// deny, or approve-and-auto-issue the requests.
//
// VIEWS
//   Cadet / Staff / R-O (perm: requestIssue, but NOT 'issue'):
//     – "New Request" tab: submit a request form
//     – "My Requests" tab: view own submissions; withdraw pending ones
//
//   QM / CO (perm: 'issue'):
//     – "Pending" tab: approve / deny / approve-and-issue each request
//     – "All Requests" tab: full history with status filter
//     – Blank AB189 download available on all tabs
//     – Import filled AB189 PDF (digitally-filled; OCR not supported in V2)
//
// REQUEST SCHEMA (pendingRequests IndexedDB store)
//   {
//     id:            'REQ-1000',
//     requestorSvc:  '1234567',
//     requestorName: 'CDT Smith',
//     requestorRank: 'CDT',
//     purpose:       'Annual Camp',
//     requiredBy:    '2026-06-15',
//     submittedAt:   '2026-05-20T08:00:00.000Z',
//     status:        'pending' | 'approved' | 'issued' | 'denied' | 'withdrawn',
//     lines:         [{ description, nsn, qty }],
//     notes:         '',
//     decidedBy:     null | 'SGT Jones',
//     decidedAt:     null | '2026-05-20T09:00:00.000Z',
//     decisionNote:  null | 'Reason for denial',
//     loanRefs:      [],   // populated on approve-and-issue
//   }
// =============================================================================

import * as Storage from '../storage.js';
import * as AUTH    from '../auth.js';
import * as Sync    from '../sync.js';
import { esc, $, $$, render, fmtDate } from './util.js';
import { showToast }                   from './toast.js';
import { openModal }                   from './modal.js';
import { INITIAL_ISSUE }               from './loans.js';
import { generateBlankAB189, generateRequestAB189, downloadPdf } from '../pdf.js';

// pdfjs for AB189 import (same FakeWorker setup as order-parser.js).
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { WorkerMessageHandler } from 'pdfjs-dist/legacy/build/pdf.worker.mjs';
if (!globalThis.pdfjsWorker) {
  globalThis.pdfjsWorker = { WorkerMessageHandler };
}
if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = '_pdfjs_fakeworker_';
}

// Loan purposes available in requests (Initial Issue is QM-only).
const REQUEST_PURPOSES = [
  'Annual Camp',
  'Training Activity',
  'Parade Night',
  'Field Exercise',
  'Ceremonial',
  'Course Attendance',
  'Other',
];

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _root         = null;
let _tab          = null;
let _lines        = [];   // new-request form lines
let _unmounted    = false;
let _filterStatus = 'all'; // persists across All Requests tab visits
let _pendingAbort = null;  // AbortController for pending-tab click listener

// ---------------------------------------------------------------------------
// One-time migration: reverse requests auto-issued by the old bulk-copy code.
//
// The previous implementation of _handleCopyToCadets called _issueLinesToCadet
// inside the modal, automatically creating loan records and marking each
// cloned request as 'issued' without any QM confirmation per cadet.
//
// This function finds those requests (identified by decisionNote containing
// "Bulk copy from" or "bulk copy"), reverses their loans (decrement onLoan,
// remove loan record), and resets each request to 'pending' so the QM can
// process them manually.
//
// Safe to re-run: requests already at 'pending' with no loanRefs are skipped.
// Runs once per mount; after all affected records are cleaned the function
// becomes a no-op.
// ---------------------------------------------------------------------------

async function _revertAutoIssuedRequests() {
  const AUTO_MARKERS = ['bulk copy from', 'issued via bulk copy', 'bulk issued via'];

  const isAutoIssued = (req) => {
    if (req.status !== 'issued' && req.status !== 'approved') return false;
    const note = (req.decisionNote || '').toLowerCase();
    return AUTO_MARKERS.some(m => note.includes(m));
  };

  let allReqs;
  try { allReqs = await Storage.requests.list(); } catch { return; }

  const targets = allReqs.filter(isAutoIssued);
  if (targets.length === 0) return;

  const sessionUser = AUTH.getSession()?.name || 'system';
  let reversedLoans = 0;

  for (const req of targets) {
    // Reverse each loan record.
    for (const ref of (req.loanRefs || [])) {
      try {
        const loan = await Storage.loans.get(ref);
        if (!loan) continue;

        // Restore onLoan on the inventory item.
        if (loan.itemId && !loan.nonStock) {
          try {
            const item = await Storage.items.get(loan.itemId);
            if (item) {
              item.onLoan = Math.max(0, (Number(item.onLoan) || 0) - (Number(loan.qty) || 0));
              await Storage.items.put(item);
            }
          } catch { /* item may have been deleted — skip */ }
        }

        // Remove the loan record.
        await Storage.loans.remove(ref);
        reversedLoans++;
      } catch { /* non-fatal — move on */ }
    }

    // Reset request to pending.
    await Storage.requests.put({
      ...req,
      status:       'pending',
      decidedBy:    null,
      decidedAt:    null,
      decisionNote: null,
      loanRefs:     [],
    });
  }

  // Single audit entry covering the whole cleanup.
  await Storage.audit.append({
    action: 'loans_cleanup',
    user:   sessionUser,
    desc:   `Auto-issue rollback: ${targets.length} request${targets.length !== 1 ? 's' : ''} reset to pending; ${reversedLoans} loan record${reversedLoans !== 1 ? 's' : ''} removed. Requests were incorrectly auto-issued by the bulk copy function without QM confirmation.`,
  }).catch(() => {});

  Sync.notifyChanged();
  showToast(
    `${targets.length} request${targets.length !== 1 ? 's' : ''} reset to pending — please process each one manually.`,
    'warn', 8000
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function mount(rootEl) {
  _root         = rootEl;
  _tab          = null;
  _lines        = [{ description: '', nsn: '', qty: 1 }];
  _unmounted    = false;
  _filterStatus = 'all';
  _pendingAbort = null;

  const canManage = AUTH.can('issue') || AUTH.isCO();
  _tab = canManage ? 'pending' : 'submit';

  // One-time cleanup: reverse any requests that were auto-marked as issued
  // by the previous bulk-copy implementation without user confirmation.
  await _revertAutoIssuedRequests();

  await _render();

  return function unmount() {
    _unmounted = true;
    _root      = null;
  };
}

// ---------------------------------------------------------------------------
// Shell layout
// ---------------------------------------------------------------------------

async function _render() {
  if (!_root || _unmounted) return;

  const canManage = AUTH.can('issue') || AUTH.isCO();

  const tabs = canManage
    ? [
        { key: 'pending', label: 'Pending' },
        { key: 'all',     label: 'All Requests' },
        { key: 'submit',  label: 'New Request' },
      ]
    : [
        { key: 'submit', label: 'New Request' },
        { key: 'mine',   label: 'My Requests' },
      ];

  const badgeHtml = canManage ? await _pendingBadgeHtml() : '';

  render(_root, `
    <div class="req__page">
      <div class="req__header">
        <h1 class="req__title">Equipment Requests</h1>
        <div class="req__header-actions">
          <button type="button" class="btn btn--ghost req__blank-btn"
                  data-action="blank-form">
            ⬇ Blank AB189 Form
          </button>
          ${canManage ? `
          <label class="btn btn--ghost req__import-label" title="Import filled AB189 PDF">
            ⬆ Import AB189 PDF
            <input type="file" accept=".pdf" class="req__import-input"
                   data-action="import-pdf" style="display:none">
          </label>` : ''}
        </div>
      </div>

      <nav class="req__tabs" role="tablist">
        ${tabs.map(t => `
          <button type="button"
                  class="req__tab ${t.key === _tab ? 'is-active' : ''}"
                  role="tab"
                  aria-selected="${t.key === _tab}"
                  data-tab="${esc(t.key)}">
            ${esc(t.label)}${t.key === 'pending' ? badgeHtml : ''}
          </button>
        `).join('')}
      </nav>

      <div class="req__body" data-target="req-body">
        <div class="shell__loading">Loading…</div>
      </div>
    </div>
  `);

  _root.querySelector('.req__tabs')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-tab]');
    if (!btn || btn.dataset.tab === _tab) return;
    _tab = btn.dataset.tab;
    $$('.req__tab', _root).forEach(b =>
      b.classList.toggle('is-active', b.dataset.tab === _tab));
    $$('.req__tab', _root).forEach(b =>
      b.setAttribute('aria-selected', String(b.dataset.tab === _tab)));
    await _mountTabBody();
  });

  _root.querySelector('[data-action="blank-form"]')?.addEventListener('click', _downloadBlankForm);

  const importInput = _root.querySelector('[data-action="import-pdf"]');
  if (importInput) {
    importInput.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      await _importAB189Pdf(file);
    });
  }

  await _mountTabBody();
}

async function _pendingBadgeHtml() {
  try {
    const pending = await Storage.requests.listByStatus('pending');
    if (pending.length > 0) {
      return `<span class="shell__nav-badge req__tab-badge">${pending.length}</span>`;
    }
  } catch { /* non-fatal */ }
  return '';
}

async function _mountTabBody() {
  if (!_root || _unmounted) return;
  const body = $('[data-target="req-body"]', _root);
  if (!body) return;

  switch (_tab) {
    case 'pending': await _mountPending(body);   break;
    case 'all':     await _mountAll(body);       break;
    case 'submit':  _mountSubmit(body);          break;
    case 'mine':    await _mountMine(body);      break;
    default:        body.innerHTML = '';
  }
}

// ---------------------------------------------------------------------------
// PENDING tab (QM / CO)
// ---------------------------------------------------------------------------

async function _mountPending(body) {
  // Abort any previously registered click listener on this body element
  // to prevent duplicate handlers accumulating across re-renders.
  if (_pendingAbort) { _pendingAbort.abort(); }
  _pendingAbort = new AbortController();

  const requests = await Storage.requests.listByStatus('pending');

  if (requests.length === 0) {
    body.innerHTML = `
      <div class="req__empty">
        <p>No pending requests.</p>
        <p class="req__empty-hint">Requests submitted by cadets and staff will appear here for approval.</p>
      </div>`;
    return;
  }

  // Sort by oldest first (FIFO).
  requests.sort((a, b) => (a.submittedAt > b.submittedAt ? 1 : -1));

  body.innerHTML = `
    <div class="req__list">
      ${requests.map(r => _requestCardHtml(r, true)).join('')}
    </div>`;

  body.addEventListener('click', async (e) => {
    const card = e.target.closest('[data-req-id]');
    if (!card) return;
    const id = card.dataset.reqId;
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    // Re-fetch request live so we always have current data.
    let req;
    try { req = await Storage.requests.get(id); } catch { return; }
    if (!req) return;

    if (action === 'approve-issue')  await _handleApproveAndIssue(req, body);
    if (action === 'approve-only')   await _handleApproveOnly(req, body);
    if (action === 'deny')           await _handleDeny(req, body);
    if (action === 'print-ab189')    await _printRequestAB189(req, e.target);
    if (action === 'copy-to-cadets') await _handleCopyToCadets(req, body);
  }, { signal: _pendingAbort.signal });
}

function _requestCardHtml(req, showActions) {
  const canManage = AUTH.can('issue') || AUTH.isCO();
  const dateStr = req.submittedAt ? fmtDate(req.submittedAt.slice(0, 10)) : '—';

  return `
    <div class="req__card ${req.status !== 'pending' ? 'req__card--resolved' : ''}"
         data-req-id="${esc(req.id)}">
      <div class="req__card-header">
        <div class="req__card-meta">
          <span class="req__card-ref">${esc(req.id)}</span>
          <span class="req__card-who">${esc(req.requestorName)}</span>
          <span class="req__card-date">${esc(dateStr)}</span>
          <span class="req__card-purpose">${esc(req.purpose)}</span>
          ${req.requiredBy ? `<span class="req__card-required">Required by ${esc(fmtDate(req.requiredBy))}</span>` : ''}
        </div>
        ${_statusBadge(req.status)}
      </div>

      <ul class="req__card-lines">
        ${(req.lines || []).map(l => `
          <li class="req__card-line">
            ${l.nsn ? `<span class="req__card-nsn">${esc(l.nsn)}</span>` : ''}
            <span class="req__card-desc">${esc(l.description)}</span>
            <span class="req__card-qty">× ${l.qty}</span>
          </li>`).join('')}
      </ul>

      ${req.notes ? `<p class="req__card-notes">${esc(req.notes)}</p>` : ''}

      ${req.status !== 'pending' && req.decisionNote
        ? `<p class="req__card-decision-note"><em>${esc(req.decidedBy)}</em>: ${esc(req.decisionNote)}</p>`
        : ''}

      ${req.loanRefs?.length > 0
        ? `<p class="req__card-loans">Loan refs: ${req.loanRefs.map(r => `<span class="req__card-loan-ref">${esc(r)}</span>`).join(' ')}</p>`
        : ''}

      ${showActions && req.status === 'pending' ? `
        <div class="req__card-actions">
          ${canManage ? `
          <button type="button" class="btn btn--primary btn--sm"
                  data-action="approve-issue">Approve &amp; Issue</button>
          <button type="button" class="btn btn--ghost btn--sm"
                  data-action="approve-only">Approve (issue later)</button>
          <button type="button" class="btn btn--ghost btn--sm"
                  data-action="copy-to-cadets"
                  title="Issue this kit list to multiple cadets">↗ Copy to cadets</button>
          <button type="button" class="btn btn--danger btn--sm"
                  data-action="deny">Deny</button>
          ` : ''}
          <button type="button" class="btn btn--ghost btn--sm"
                  data-action="print-ab189"
                  title="Print pre-filled AB189 for this request">⎙ Print AB189</button>
        </div>` : ''}
    </div>`;
}

async function _handleApproveAndIssue(req, body) {
  const session     = AUTH.getSession();
  const sessionUser = session?.name || 'unknown';

  // Load inventory items for datalist + NSN lookup.
  let allItems = [];
  try { allItems = await Storage.items.list(); } catch { /* ok */ }

  // Resolve borrower name from cadet record if available.
  let cadet = null;
  try { cadet = await Storage.cadets.get(req.requestorSvc); } catch { /* ok */ }
  const borrowerSvc  = req.requestorSvc;
  const borrowerName = cadet ? (cadet.rank + ' ' + cadet.surname) : req.requestorName;
  const defaultDue   = req.requiredBy || _defaultDueDate();

  // Build editable line state — each line carries the original fields plus
  // qtyIssued (editable, defaults to requested) and lineAction (issue/loan/backorder/unavailable).
  const editableLines = (req.lines || []).map(function(line) {
    return {
      description: line.description || '',
      nsn:         line.nsn || '',
      qty:         line.qty || 1,
      qtyIssued:   line.qtyIssued != null ? line.qtyIssued : (line.qty || 1),
      lineAction:  line.lineAction || 'issue',
    };
  });

  // Build inventory datalist options (used for description auto-complete).
  const datalistId = 'iss-inv-dl';
  const datalistHtml = '<datalist id="' + datalistId + '">' +
    allItems.map(function(it) {
      return '<option value="' + esc(it.name) + '" data-nsn="' + esc(it.nsn || '') + '">';
    }).join('') +
    '</datalist>';

  const lineActionOpts = [
    { v: 'issue',       l: 'Issue'              },
    { v: 'loan',        l: 'Loan (prior issue)' },
    { v: 'backorder',   l: 'Backorder'          },
    { v: 'unavailable', l: 'Unavailable'        },
  ];

  function _lineRowHtml(line, idx) {
    const selOpts = lineActionOpts.map(function(o) {
      return '<option value="' + o.v + '"' + (line.lineAction === o.v ? ' selected' : '') + '>' + o.l + '</option>';
    }).join('');
    return (
      '<tr class="iss__line" data-line-idx="' + idx + '" data-action-val="' + esc(line.lineAction) + '">' +
        '<td class="iss__td-num">' + (idx + 1) + '</td>' +
        '<td class="iss__td-desc">' +
          '<input type="text" class="form__input iss__desc-inp" list="' + datalistId + '"' +
                 ' value="' + esc(line.description) + '" data-field="description"' +
                 ' placeholder="Description">' +
        '</td>' +
        '<td class="iss__td-nsn">' +
          '<input type="text" class="form__input iss__nsn-inp" value="' + esc(line.nsn) + '"' +
                 ' data-field="nsn" placeholder="NSN">' +
        '</td>' +
        '<td class="iss__td-req">' + esc(String(line.qty)) + '</td>' +
        '<td class="iss__td-qty">' +
          '<input type="number" class="form__input iss__qty-inp" value="' + esc(String(line.qtyIssued)) + '"' +
                 ' data-field="qtyIssued" min="0" max="999">' +
        '</td>' +
        '<td class="iss__td-action">' +
          '<select class="form__select iss__action-sel" data-field="lineAction">' + selOpts + '</select>' +
        '</td>' +
      '</tr>'
    );
  }

  openModal({
    titleHtml: 'Issue Items — ' + esc(req.id),
    size: 'lg',
    bodyHtml: (
      datalistHtml +
      '<div class="iss__meta">' +
        '<div class="iss__borrower-info">' +
          '<span class="iss__meta-label">Borrower:</span> ' +
          '<strong>' + esc(borrowerName) + '</strong>' +
          '<span class="iss__svc-no">' + esc(borrowerSvc) + '</span>' +
          '<span class="iss__purpose">' + esc(req.purpose) + '</span>' +
        '</div>' +
        '<label class="iss__due-wrap">' +
          '<span class="iss__meta-label">Due date</span>' +
          '<input type="date" class="form__input iss__due-inp" id="iss-due-date"' +
                 ' value="' + esc(defaultDue) + '" min="' + esc(_todayLocalIsoDate()) + '">' +
        '</label>' +
      '</div>' +
      '<div class="iss__table-wrap">' +
        '<table class="iss__table">' +
          '<thead><tr>' +
            '<th class="iss__th-num">#</th>' +
            '<th class="iss__th-desc">Item Description</th>' +
            '<th class="iss__th-nsn">NSN</th>' +
            '<th class="iss__th-req" title="Requested quantity">Req</th>' +
            '<th class="iss__th-qty" title="Quantity to issue">Qty</th>' +
            '<th class="iss__th-action">Status</th>' +
          '</tr></thead>' +
          '<tbody id="iss-tbody">' +
            editableLines.map(function(l, i) { return _lineRowHtml(l, i); }).join('') +
          '</tbody>' +
        '</table>' +
      '</div>' +
      '<label class="form__field" style="margin-top:12px">' +
        '<span class="form__label">Issue notes <span class="form__hint">(appended to each loan remark)</span></span>' +
        '<textarea id="iss-notes" class="form__textarea" rows="2"' +
                  ' placeholder="e.g. Boot size 10, item exchanged&#8230;"></textarea>' +
      '</label>' +
      '<div class="form__error" id="iss-err" role="alert"></div>' +
      '<div class="form__actions">' +
        '<button type="button" class="btn btn--ghost" data-action="modal-close">Cancel</button>' +
        '<button type="button" class="btn btn--primary" id="iss-submit">Issue Items</button>' +
      '</div>'
    ),

    async onMount(panel, close) {
      const tbody     = panel.querySelector('#iss-tbody');
      const dueEl     = panel.querySelector('#iss-due-date');
      const notesEl   = panel.querySelector('#iss-notes');
      const errEl     = panel.querySelector('#iss-err');
      const submitBtn = panel.querySelector('#iss-submit');

      // Helper: sync a single line from its DOM row into editableLines.
      function _syncLine(lineEl) {
        const idx = Number(lineEl.dataset.lineIdx);
        if (idx < 0 || idx >= editableLines.length) return;
        const desc   = lineEl.querySelector('[data-field="description"]');
        const nsn    = lineEl.querySelector('[data-field="nsn"]');
        const qty    = lineEl.querySelector('[data-field="qtyIssued"]');
        const action = lineEl.querySelector('[data-field="lineAction"]');
        if (desc)   editableLines[idx].description = desc.value.trim();
        if (nsn)    editableLines[idx].nsn         = nsn.value.trim();
        if (qty)    editableLines[idx].qtyIssued   = Math.max(0, Number(qty.value) || 0);
        if (action) editableLines[idx].lineAction  = action.value;
      }

      // Helper: update row CSS class for status colour.
      function _updateRowClass(lineEl) {
        const action = lineEl.querySelector('[data-field="lineAction"]')?.value || 'issue';
        lineEl.dataset.actionVal = action;
      }

      // Wire input / change events on the table.
      tbody.addEventListener('input', function(e) {
        const lineEl = e.target.closest('[data-line-idx]');
        if (!lineEl) return;
        _syncLine(lineEl);

        // Auto-fill NSN when description matches an inventory item name.
        if (e.target.dataset.field === 'description') {
          const val     = e.target.value.trim().toLowerCase();
          const matched = allItems.find(function(it) {
            return it.name.trim().toLowerCase() === val;
          });
          if (matched) {
            const nsnInp = lineEl.querySelector('[data-field="nsn"]');
            if (nsnInp && !nsnInp.value) {
              nsnInp.value = matched.nsn || '';
              editableLines[Number(lineEl.dataset.lineIdx)].nsn = nsnInp.value;
            }
          }
        }
      });

      tbody.addEventListener('change', function(e) {
        const lineEl = e.target.closest('[data-line-idx]');
        if (!lineEl) return;
        _syncLine(lineEl);
        _updateRowClass(lineEl);
      });

      // Submit: process lines and create loan records.
      submitBtn.addEventListener('click', async function() {
        errEl.textContent = '';
        const dueDate    = dueEl.value || defaultDue;
        const issueNotes = notesEl.value.trim();

        // Final sync of all lines from DOM.
        tbody.querySelectorAll('[data-line-idx]').forEach(function(lineEl) {
          _syncLine(lineEl);
        });

        submitBtn.disabled    = true;
        submitBtn.textContent = 'Issuing…';

        const now       = new Date().toISOString();
        const loanRefs  = [];
        const errors    = [];
        const skipped   = [];  // backorder / unavailable / 0-qty lines

        // Pre-load fresh item list once.
        let freshItems = [];
        try { freshItems = await Storage.items.list(); } catch { /* ok */ }

        for (let idx = 0; idx < editableLines.length; idx++) {
          const line   = editableLines[idx];
          const action = line.lineAction;

          if (action === 'backorder' || action === 'unavailable') {
            skipped.push({ desc: line.description || ('Item ' + (idx + 1)), reason: action });
            continue;
          }

          const qty = Math.max(0, Math.floor(Number(line.qtyIssued) || 0));
          if (qty === 0) {
            skipped.push({ desc: line.description || ('Item ' + (idx + 1)), reason: 'qty 0' });
            continue;
          }

          const existingLoan = (action === 'loan');

          // Match inventory item by NSN then by name.
          let item = null;
          if (line.nsn) {
            item = freshItems.find(function(it) {
              return it.nsn && it.nsn.trim() === line.nsn.trim();
            }) || null;
          }
          if (!item && line.description) {
            const d = line.description.trim().toLowerCase();
            item = freshItems.find(function(it) {
              return it.name && it.name.trim().toLowerCase() === d;
            }) || null;
          }

          try {
            const ref = await _nextRequestLoanRef();

            if (item) {
              // Inventory item: increment onLoan (onHand unchanged — existingLoan flag
              // governs whether return restores onHand).
              const fresh = await Storage.items.get(item.id);
              if (!fresh) throw new Error('"' + item.name + '" no longer exists.');
              fresh.onLoan = (Number(fresh.onLoan) || 0) + qty;
              await Storage.items.put(fresh);

              await Storage.loans.put({
                ref,
                itemId:       item.id,
                itemName:     item.name,
                nsn:          item.nsn || '',
                qty,
                borrowerSvc,
                borrowerName,
                purpose:      req.purpose,
                issueDate:    _todayLocalIsoDate(),
                dueDate,
                longTermLoan: false,
                unitLoan:     false,
                nonStock:     false,
                existingLoan,
                condition:    item.condition || 'serviceable',
                remarks:      'Issued from request ' + req.id + (issueNotes ? '. ' + issueNotes : ''),
                notes:        '',
                active:       true,
                issuedBy:     sessionUser,
              });
              await Storage.audit.append({
                action: existingLoan ? 'loan_existing' : 'issue',
                user:   sessionUser,
                desc:   ref + ': ' + item.name + ' \xd7 ' + qty +
                        (existingLoan ? ' [existing loan]' : ' issued') +
                        ' to ' + borrowerName + ' (from request ' + req.id + ')',
              });
            } else {
              // Non-stock line.
              await Storage.loans.put({
                ref,
                itemId:       null,
                itemName:     line.description,
                nsn:          line.nsn || '',
                qty,
                borrowerSvc,
                borrowerName,
                purpose:      req.purpose,
                issueDate:    _todayLocalIsoDate(),
                dueDate,
                longTermLoan: false,
                unitLoan:     false,
                nonStock:     true,
                existingLoan,
                condition:    'serviceable',
                remarks:      'Issued from request ' + req.id + (issueNotes ? '. ' + issueNotes : ''),
                notes:        '',
                active:       true,
                issuedBy:     sessionUser,
              });
              await Storage.audit.append({
                action: existingLoan ? 'loan_existing' : 'issue',
                user:   sessionUser,
                desc:   ref + ': [non-stock] ' + line.description + ' \xd7 ' + qty +
                        (existingLoan ? ' [existing loan]' : ' issued') +
                        ' to ' + borrowerName + ' (from request ' + req.id + ')',
              });
            }

            loanRefs.push(ref);
            // Update freshItems cache so subsequent lines see the updated onLoan.
            freshItems = freshItems.map(function(it) {
              return it.id === (item && item.id) ? { ...it, onLoan: it.onLoan + qty } : it;
            });
          } catch (err) {
            errors.push((line.description || ('Item ' + (idx + 1))) + ': ' + err.message);
          }
        }

        // Build decision note from non-issued lines.
        const noteParts = [];
        const backordered  = skipped.filter(function(s) { return s.reason === 'backorder'; });
        const unavailable  = skipped.filter(function(s) { return s.reason === 'unavailable'; });
        const zeroQty      = skipped.filter(function(s) { return s.reason === 'qty 0'; });
        if (backordered.length)  noteParts.push('Backorder: ' + backordered.map(function(s) { return s.desc; }).join(', '));
        if (unavailable.length)  noteParts.push('Unavailable: ' + unavailable.map(function(s) { return s.desc; }).join(', '));
        if (zeroQty.length)      noteParts.push('Skipped (qty 0): ' + zeroQty.map(function(s) { return s.desc; }).join(', '));
        if (errors.length)       noteParts.push('Errors: ' + errors.join('; '));

        // Determine final request status.
        const hasActive   = loanRefs.length > 0;
        const hasDeferred = skipped.length > 0 || errors.length > 0;
        const newStatus   = hasActive && !hasDeferred ? 'issued' : (hasActive ? 'issued' : 'approved');

        // Save updated lines (with qtyIssued + lineAction) back to the request.
        const updatedLines = editableLines.map(function(l) {
          return {
            description: l.description,
            nsn:         l.nsn,
            qty:         l.qty,
            qtyIssued:   l.qtyIssued,
            lineAction:  l.lineAction,
          };
        });

        const updatedReq = {
          ...req,
          lines:        updatedLines,
          status:       newStatus,
          decidedBy:    sessionUser,
          decidedAt:    now,
          decisionNote: noteParts.length > 0 ? noteParts.join('; ') : null,
          loanRefs,
        };
        await Storage.requests.put(updatedReq);
        await Storage.audit.append({
          action: 'request_approved',
          user:   sessionUser,
          desc:   'Request ' + req.id + ' from ' + req.requestorName + ' issued. ' +
                  'Refs: ' + (loanRefs.join(', ') || 'none') +
                  (noteParts.length ? '. ' + noteParts.join('; ') : ''),
        });
        Sync.notifyChanged();

        // Build summary toast.
        const toastParts = [];
        if (loanRefs.length) toastParts.push(loanRefs.length + ' item' + (loanRefs.length !== 1 ? 's' : '') + ' issued');
        if (backordered.length)  toastParts.push(backordered.length + ' on backorder');
        if (unavailable.length)  toastParts.push(unavailable.length + ' unavailable');
        if (errors.length)       toastParts.push(errors.length + ' error' + (errors.length !== 1 ? 's' : ''));
        if (loanRefs.length) toastParts.push('Refs: ' + loanRefs.join(', '));

        showToast(toastParts.join(' · ') || 'No items issued.',
          errors.length ? 'warn' : 'success', 8000);

        close();
        await _mountPending(body);
        await _refreshPendingBadge();
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Issue all lines from a request to a single cadet — reusable core.
// Returns { loanRefs: string[], errors: string[] }.
// ---------------------------------------------------------------------------

async function _issueLinesToCadet(req, { borrowerSvc, borrowerName, dueDate, sessionUser }) {
  const issueDate = _todayLocalIsoDate();
  const loanRefs  = [];
  const errors    = [];

  // Pre-load item list once for this cadet's issue batch.
  const allItems = await Storage.items.list();

  for (const line of req.lines) {
    const qty = Math.max(1, Math.floor(Number(line.qty) || 1));

    // Try to find a matching inventory item (by NSN first, then name).
    let matchedItem = null;
    if (line.nsn) {
      matchedItem = allItems.find(it => it.nsn && it.nsn.trim() === line.nsn.trim()) || null;
    }
    if (!matchedItem && line.description) {
      const desc = line.description.trim().toLowerCase();
      matchedItem = allItems.find(it => it.name && it.name.trim().toLowerCase() === desc) || null;
    }

    try {
      const ref = await _nextRequestLoanRef();

      if (matchedItem) {
        // Standard stock issue.
        const fresh = await Storage.items.get(matchedItem.id);
        if (!fresh) throw new Error(`"${matchedItem.name}" no longer exists.`);
        fresh.onLoan = (Number(fresh.onLoan) || 0) + qty;
        await Storage.items.put(fresh);

        await Storage.loans.put({
          ref,
          itemId:      matchedItem.id,
          itemName:    matchedItem.name,
          nsn:         matchedItem.nsn || '',
          qty,
          borrowerSvc,
          borrowerName,
          purpose:     req.purpose,
          issueDate,
          dueDate,
          longTermLoan: false,
          unitLoan:    false,
          nonStock:    false,
          condition:   matchedItem.condition || 'serviceable',
          remarks:     `Issued from request ${req.id}`,
          notes:       '',
          active:      true,
          issuedBy:    sessionUser,
        });
        await Storage.audit.append({
          action: 'issue',
          user:   sessionUser,
          desc:   `${ref}: ${matchedItem.name} × ${qty} issued to ${borrowerName} (from request ${req.id})`,
        });
      } else {
        // Non-stock issue — description from request.
        await Storage.loans.put({
          ref,
          itemId:      null,
          itemName:    line.description,
          nsn:         line.nsn || '',
          qty,
          borrowerSvc,
          borrowerName,
          purpose:     req.purpose,
          issueDate,
          dueDate,
          longTermLoan: false,
          unitLoan:    false,
          nonStock:    true,
          condition:   'serviceable',
          remarks:     `Issued from request ${req.id}`,
          notes:       '',
          active:      true,
          issuedBy:    sessionUser,
        });
        await Storage.audit.append({
          action: 'issue',
          user:   sessionUser,
          desc:   `${ref}: [non-stock] ${line.description} × ${qty} issued to ${borrowerName} (from request ${req.id})`,
        });
      }
      loanRefs.push(ref);
    } catch (err) {
      errors.push(`${line.description}: ${err.message}`);
    }
  }

  return { loanRefs, errors };
}

async function _handleApproveOnly(req, body) {
  const session = AUTH.getSession();
  const sessionUser = session?.name || 'unknown';

  const updated = {
    ...req,
    status:      'approved',
    decidedBy:   sessionUser,
    decidedAt:   new Date().toISOString(),
    decisionNote: 'Approved — QM to issue separately.',
  };
  await Storage.requests.put(updated);
  await Storage.audit.append({
    action: 'request_approved',
    user:   sessionUser,
    desc:   `Request ${req.id} from ${req.requestorName} approved (issue pending).`,
  });
  Sync.notifyChanged();
  showToast(`Request ${req.id} approved.`, 'success');
  await _mountPending(body);
  await _refreshPendingBadge();
}

async function _handleDeny(req, body) {
  openModal({
    titleHtml: `Deny request ${esc(req.id)}`,
    size: 'sm',
    bodyHtml: `
      <p class="modal__body">
        Denying equipment request from <strong>${esc(req.requestorName)}</strong>
        for <em>${esc(req.purpose)}</em>.
      </p>
      <form class="form" data-form="deny-form">
        <label class="form__field">
          <span class="form__label">Reason for denial</span>
          <textarea name="reason" class="form__textarea" rows="3"
                    placeholder="e.g. Insufficient stock; contact the QM to arrange alternatives"
                    required></textarea>
        </label>
        <div class="form__error" role="alert"></div>
        <div class="form__actions">
          <button type="button" class="btn btn--ghost" data-action="modal-close">Cancel</button>
          <button type="submit" class="btn btn--danger">Deny Request</button>
        </div>
      </form>`,
    async onMount(panel, close) {
      const form  = $('form[data-form="deny-form"]', panel);
      const errEl = $('.form__error', panel);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errEl.textContent = '';
        const reason = (new FormData(form).get('reason') || '').trim();
        if (!reason) { errEl.textContent = 'A reason is required.'; return; }

        const session = AUTH.getSession();
        const sessionUser = session?.name || 'unknown';
        const updated = {
          ...req,
          status:      'denied',
          decidedBy:   sessionUser,
          decidedAt:   new Date().toISOString(),
          decisionNote: reason,
        };
        await Storage.requests.put(updated);
        await Storage.audit.append({
          action: 'request_denied',
          user:   sessionUser,
          desc:   `Request ${req.id} from ${req.requestorName} denied. Reason: ${reason}`,
        });
        Sync.notifyChanged();
        showToast(`Request ${req.id} denied.`, 'info');
        close();
        await _mountPending(body);
        await _refreshPendingBadge();
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Copy to cadets — bulk individual issue from a request template
// ---------------------------------------------------------------------------

async function _handleCopyToCadets(req, body) {
  // Load all active cadets for the picker.
  let allCadets = [];
  try {
    allCadets = (await Storage.cadets.list()).filter(c => c.active !== false);
  } catch { /* ok — empty list */ }

  const unit = await Storage.settings.getAll().catch(() => ({}));
  const sessionUser = AUTH.getSession()?.name || 'unknown';
  const defaultDue  = req.requiredBy || _defaultDueDate();

  // Sort: staff first, then rank, then surname.
  allCadets.sort((a, b) => {
    const ta = a.personType === 'staff' ? 0 : 1;
    const tb = b.personType === 'staff' ? 0 : 1;
    return (ta - tb) || (a.surname || '').localeCompare(b.surname || '');
  });

  /** Build the cadet list rows HTML (re-used for filter updates). */
  const _cadetRowsHtml = (cadets) => cadets.map(c => {
    const sub = [c.company, c.platoon || c.plt, c.section].filter(Boolean).join(' / ');
    return `
      <label class="ctc__cadet-row" data-svc="${esc(c.svcNo)}">
        <input type="checkbox" class="ctc__cadet-chk" value="${esc(c.svcNo)}"
               data-name="${esc(`${c.rank} ${c.surname}`)}"
               data-rank="${esc(c.rank)}" data-surname="${esc(c.surname)}">
        <span class="ctc__cadet-name">${esc(c.rank)} ${esc(c.surname)}</span>
        <span class="ctc__cadet-svc">${esc(c.svcNo)}</span>
        ${sub ? `<span class="ctc__cadet-sub">${esc(sub)}</span>` : ''}
      </label>`;
  }).join('');

  const itemsSummary = (req.lines || [])
    .map(l => `<li>${esc(l.description)}${l.nsn ? ` <span class="ctc__nsn">${esc(l.nsn)}</span>` : ''} × ${l.qty}</li>`)
    .join('');

  openModal({
    titleHtml: `Copy to cadets — ${esc(req.id)}`,
    size: 'lg',
    bodyHtml: `
      <p class="ctc__intro">
        Issue the same kit list to multiple cadets individually.
        Each selected cadet gets their own set of loan records and AB189.
      </p>

      <div class="ctc__kit-summary">
        <strong>Kit list (per cadet):</strong>
        <ul class="ctc__kit-lines">${itemsSummary}</ul>
      </div>

      <div class="ctc__due-row">
        <label class="form__label" for="ctc-due-date">Due date</label>
        <input type="date" id="ctc-due-date" class="form__input ctc__due-input"
               value="${esc(defaultDue)}" min="${esc(_todayLocalIsoDate())}">
      </div>

      <div class="ctc__controls">
        <input type="text" class="ctc__search form__input" placeholder="Search cadets…"
               id="ctc-search" autocomplete="off">
        <label class="ctc__select-all-label">
          <input type="checkbox" id="ctc-select-all"> Select all
        </label>
        <span class="ctc__selected-count" id="ctc-count">0 selected</span>
      </div>

      <div class="ctc__list" id="ctc-cadet-list">
        ${_cadetRowsHtml(allCadets)}
      </div>

      <div class="form__error" id="ctc-error" role="alert"></div>

      <div class="ctc__footer">
        <button type="button" class="btn btn--ghost" data-action="modal-close">Cancel</button>
        <button type="button" class="btn btn--ghost" data-action="ctc-print" disabled>⎙ Print AB189s</button>
        <button type="button" class="btn btn--primary" data-action="ctc-issue" disabled>📋 Create pending requests</button>
      </div>`,

    async onMount(panel, close) {
      const searchEl    = $('#ctc-search',      panel);
      const listEl      = $('#ctc-cadet-list',  panel);
      const selectAll   = $('#ctc-select-all',  panel);
      const countEl     = $('#ctc-count',        panel);
      const dueInput    = $('#ctc-due-date',     panel);
      const errEl       = $('#ctc-error',        panel);

      // --- Helpers ---
      const getChecked = () =>
        Array.from(panel.querySelectorAll('.ctc__cadet-chk:checked'));

      const updateCount = () => {
        const n = getChecked().length;
        countEl.textContent = `${n} selected`;
        const issueBtn = panel.querySelector('[data-action="ctc-issue"]');
        const printBtn = panel.querySelector('[data-action="ctc-print"]');
        if (issueBtn) {
          issueBtn.disabled = n === 0;
          issueBtn.textContent = n === 0 ? '📋 Create pending requests' : `📋 Create requests for ${n} cadet${n !== 1 ? 's' : ''}`;
        }
        if (printBtn) {
          printBtn.disabled = n === 0;
          printBtn.textContent = n === 0 ? '⎙ Print AB189s' : `⎙ Print AB189s (${n})`;
        }
        // Sync select-all state.
        const visible = Array.from(panel.querySelectorAll('.ctc__cadet-chk'));
        selectAll.checked = visible.length > 0 && visible.every(cb => cb.checked);
        selectAll.indeterminate = n > 0 && !selectAll.checked;
      };

      // Filter list by search term.
      searchEl.addEventListener('input', () => {
        const q = searchEl.value.toLowerCase();
        const filtered = q
          ? allCadets.filter(c =>
              `${c.rank} ${c.surname} ${c.svcNo} ${c.company || ''} ${c.platoon || c.plt || ''} ${c.section || ''}`
              .toLowerCase().includes(q))
          : allCadets;
        listEl.innerHTML = _cadetRowsHtml(filtered);
        // Re-wire checkboxes; preserve selections.
        const prevSelected = new Set(getChecked().map(cb => cb.value));
        listEl.querySelectorAll('.ctc__cadet-chk').forEach(cb => {
          if (prevSelected.has(cb.value)) cb.checked = true;
          cb.addEventListener('change', updateCount);
        });
        updateCount();
      });

      // Select-all toggle.
      selectAll.addEventListener('change', () => {
        panel.querySelectorAll('.ctc__cadet-chk').forEach(cb => {
          cb.checked = selectAll.checked;
        });
        updateCount();
      });

      // Wire individual checkboxes.
      listEl.querySelectorAll('.ctc__cadet-chk').forEach(cb => {
        cb.addEventListener('change', updateCount);
      });
      updateCount();

      // Footer buttons wired via panel click delegation.
      panel.addEventListener('click', async (e) => {
        const action = e.target.closest('[data-action]')?.dataset.action;
        if (!action) return;

        if (action === 'ctc-issue') {
          const selected = getChecked();
          if (selected.length === 0) return;
          const dueDate = dueInput.value || defaultDue;
          errEl.textContent = '';

          const btn = e.target;
          btn.disabled = true;
          btn.textContent = 'Creating…';

          const now = new Date().toISOString();
          let created = 0;
          const errors = [];

          for (const cb of selected) {
            const svc  = cb.value;
            const name = cb.dataset.name;
            const rank = allCadets.find(c => c.svcNo === svc)?.rank || '';
            try {
              // Create a PENDING request record only — no loans, no auto-issue.
              // The QM must manually approve and issue each request.
              const reqN  = await Storage.counters.next('request', 1000);
              const reqId = 'REQ-' + String(reqN).padStart(4, '0');
              await Storage.requests.put({
                id:           reqId,
                requestorSvc:  svc,
                requestorName: name,
                requestorRank: rank,
                purpose:      req.purpose,
                requiredBy:   dueDate,
                submittedAt:  now,
                status:       'pending',
                lines:        req.lines,
                notes:        'Copied from request ' + req.id,
                decidedBy:    null,
                decidedAt:    null,
                decisionNote: null,
                loanRefs:     [],
              });
              created++;
            } catch (err) {
              errors.push(name + ': ' + err.message);
            }
          }

          await Storage.audit.append({
            action: 'request_submitted',
            user:   sessionUser,
            desc:   'Bulk copy from ' + req.id + ': ' + created + ' pending request' + (created !== 1 ? 's' : '') + ' created' +
                    (errors.length ? '; errors: ' + errors.join('; ') : ''),
          });
          Sync.notifyChanged();

          const msg = errors.length
            ? created + ' of ' + selected.length + ' requests created. Errors: ' + errors.join('; ')
            : created + ' pending request' + (created !== 1 ? 's' : '') + ' created — process each one in the Pending tab.';
          showToast(msg, errors.length ? 'warn' : 'success', 7000);

          close();
          await _mountPending(body);
          await _refreshPendingBadge();
        }

        if (action === 'ctc-print') {
          const selected = getChecked();
          if (selected.length === 0) return;

          const btn = e.target;
          btn.disabled = true;
          btn.textContent = 'Generating…';

          let generated = 0;
          for (const cb of selected) {
            const svc  = cb.value;
            const name = cb.dataset.name;
            let cadet = null;
            try { cadet = await Storage.cadets.get(svc); } catch { /* ok */ }

            // Build a request-shaped record with this cadet's details.
            const cadetReq = {
              ...req,
              requestorName: name,
              requestorSvc:  svc,
            };
            try {
              const result = await generateRequestAB189(cadetReq, { unit, cadet });
              downloadPdf(result);
              generated++;
              // Brief pause between downloads so the browser doesn't block them.
              await new Promise(r => setTimeout(r, 350));
            } catch (err) {
              console.warn(`AB189 failed for ${name}:`, err);
            }
          }

          await Storage.audit.append({
            action: 'pdf_ab189',
            user:   sessionUser,
            desc:   `Bulk AB189 printed for ${generated} cadets from request ${req.id}`,
          });
          showToast(`${generated} AB189 PDF${generated !== 1 ? 's' : ''} downloaded.`, 'success');
          btn.disabled = false;
          updateCount();
        }
      });
    },
  });
}

async function _refreshPendingBadge() {
  // Update the "Pending" tab badge count.
  const pendingTab = _root?.querySelector('.req__tab[data-tab="pending"]');
  if (!pendingTab) return;
  try {
    const pending = await Storage.requests.listByStatus('pending');
    const oldBadge = pendingTab.querySelector('.req__tab-badge');
    if (oldBadge) oldBadge.remove();
    if (pending.length > 0) {
      pendingTab.insertAdjacentHTML(
        'beforeend',
        `<span class="shell__nav-badge req__tab-badge">${pending.length}</span>`
      );
    }
  } catch { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// ALL REQUESTS tab (QM / CO)
// ---------------------------------------------------------------------------

async function _mountAll(body) {
  const allReqs = await Storage.requests.list();

  // Sort newest first.
  allReqs.sort((a, b) => (a.submittedAt > b.submittedAt ? -1 : 1));

  const statuses = ['all', 'pending', 'approved', 'issued', 'denied', 'withdrawn'];
  // _filterStatus is module-level so it persists across tab switches.

  function _filtered() {
    return _filterStatus === 'all'
      ? allReqs
      : allReqs.filter(function(r) { return r.status === _filterStatus; });
  }

  function _refreshList() {
    const list = body.querySelector('[data-target="req-list"]');
    if (!list) return;
    const items = _filtered();
    list.innerHTML = items.length === 0
      ? '<p class="req__empty">No requests match the filter.</p>'
      : items.map(function(r) { return _requestCardHtml(r, false); }).join('');
  }

  function _buildFilterBar() {
    return '<div class="req__filter-bar">' +
      statuses.map(function(s) {
        return (
          '<button type="button"' +
                  ' class="req__filter-btn ' + (s === _filterStatus ? 'is-active' : '') + '"' +
                  ' data-filter="' + esc(s) + '">' +
            esc(s === 'all' ? 'All' : _statusLabel(s)) +
          '</button>'
        );
      }).join('') +
      '</div>';
  }

  const initItems = _filtered();
  body.innerHTML =
    _buildFilterBar() +
    '<div class="req__list" data-target="req-list">' +
      (initItems.length === 0
        ? '<p class="req__empty">No requests yet.</p>'
        : initItems.map(function(r) { return _requestCardHtml(r, false); }).join('')) +
    '</div>';

  body.querySelector('.req__filter-bar')?.addEventListener('click', function(e) {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;
    _filterStatus = btn.dataset.filter;
    $$('.req__filter-btn', body).forEach(function(b) {
      b.classList.toggle('is-active', b.dataset.filter === _filterStatus);
    });
    _refreshList();
  });
}

// ---------------------------------------------------------------------------
// SUBMIT tab (Cadet / Staff / QM-on-behalf)
// ---------------------------------------------------------------------------

function _mountSubmit(body) {
  _renderSubmitForm(body);
  _wireSubmitForm(body);
}

function _renderSubmitForm(body) {
  const session = AUTH.getSession();
  const canManage = AUTH.can('issue') || AUTH.isCO();

  body.innerHTML = `
    <form class="form req__submit-form" data-form="request-form" autocomplete="off">
      ${canManage ? `
      <div class="form__section-title">On behalf of</div>
      <label class="form__field">
        <span class="form__label">Borrower (service number or name)</span>
        <input type="text" name="borrowerSearch" list="req-borrower-list"
               class="form__input" placeholder="Start typing…" data-req-borrower>
        <datalist id="req-borrower-list"></datalist>
        <input type="hidden" name="borrowerSvc" data-req-borrower-svc>
      </label>` : `
      <p class="req__submitting-as">
        Submitting as: <strong>${esc(session?.name || 'Unknown')}</strong>
      </p>`}

      <div class="form__section-title">Request details</div>

      <div class="form__row">
        <label class="form__field">
          <span class="form__label">Purpose</span>
          <select name="purpose" class="form__select" required>
            <option value="">— Select purpose —</option>
            ${REQUEST_PURPOSES.map(p =>
              `<option value="${esc(p)}">${esc(p)}</option>`).join('')}
          </select>
        </label>
        <label class="form__field">
          <span class="form__label">Required by</span>
          <input type="date" name="requiredBy" class="form__input"
                 min="${_todayLocalIsoDate()}">
        </label>
      </div>

      <div class="form__section-title">Equipment items</div>

      <div class="req__lines" data-target="req-lines">
        ${_linesHtml()}
      </div>

      <button type="button" class="btn btn--ghost btn--sm req__add-line"
              data-action="add-line">+ Add item</button>

      <label class="form__field" style="margin-top:12px">
        <span class="form__label">Notes / additional information</span>
        <textarea name="notes" class="form__textarea" rows="3"
                  placeholder="Any other details the QM should know…"></textarea>
      </label>

      <div class="form__error" role="alert" data-req-error></div>

      <div class="form__actions">
        <button type="submit" class="btn btn--primary">Submit Request</button>
      </div>
    </form>`;
}

function _linesHtml() {
  return _lines.map((l, i) => `
    <div class="req__line" data-line-idx="${i}">
      <span class="req__line-num">${i + 1}.</span>
      <input type="text" class="form__input req__line-desc"
             placeholder="Item description (required)"
             value="${esc(l.description)}"
             data-field="description">
      <input type="text" class="form__input req__line-nsn"
             placeholder="NSN (optional)"
             value="${esc(l.nsn)}"
             data-field="nsn">
      <input type="number" class="form__input req__line-qty"
             placeholder="Qty" min="1" max="999"
             value="${l.qty}"
             data-field="qty">
      ${_lines.length > 1
        ? `<button type="button" class="btn btn--ghost btn--sm req__rm-line"
                   data-action="remove-line" data-idx="${i}"
                   aria-label="Remove item ${i + 1}">✕</button>`
        : ''}
    </div>`).join('');
}

async function _wireSubmitForm(body) {
  const canManage = AUTH.can('issue') || AUTH.isCO();

  // Populate borrower datalist if QM/CO.
  if (canManage) {
    try {
      const cadets = await Storage.cadets.list();
      const dl = body.querySelector('#req-borrower-list');
      if (dl) {
        dl.innerHTML = cadets
          .filter(c => c.active !== false)
          .sort((a, b) => a.surname.localeCompare(b.surname))
          .map(c => `<option value="${esc(`${c.rank} ${c.surname} (${c.svcNo})`)}"`+
                    ` data-svc="${esc(c.svcNo)}">`)
          .join('');
      }

      // Wire borrower input to extract svcNo.
      const borrowerInput  = body.querySelector('[data-req-borrower]');
      const borrowerSvcInput = body.querySelector('[data-req-borrower-svc]');
      borrowerInput?.addEventListener('input', () => {
        const val = borrowerInput.value;
        const m   = val.match(/\(([^)]+)\)\s*$/);
        borrowerSvcInput.value = m ? m[1] : '';
      });
    } catch { /* non-fatal */ }
  }

  // Live-sync line state.
  const linesContainer = body.querySelector('[data-target="req-lines"]');
  linesContainer?.addEventListener('input', (e) => {
    const lineEl = e.target.closest('[data-line-idx]');
    if (!lineEl) return;
    const idx   = Number(lineEl.dataset.lineIdx);
    const field = e.target.dataset.field;
    if (idx >= 0 && idx < _lines.length && field) {
      _lines[idx][field] = field === 'qty'
        ? Math.max(1, Number(e.target.value) || 1)
        : e.target.value;
    }
  });

  // Add / remove line buttons.
  body.querySelector('[data-action="add-line"]')?.addEventListener('click', () => {
    _lines.push({ description: '', nsn: '', qty: 1 });
    const linesEl = body.querySelector('[data-target="req-lines"]');
    if (linesEl) linesEl.innerHTML = _linesHtml();
    // Focus new line description.
    const newLineEl = linesEl?.querySelector(`[data-line-idx="${_lines.length - 1}"]`);
    newLineEl?.querySelector('[data-field="description"]')?.focus();
  });

  body.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="remove-line"]');
    if (!btn) return;
    const idx = Number(btn.dataset.idx);
    if (idx >= 0 && idx < _lines.length) {
      _lines.splice(idx, 1);
      const linesEl = body.querySelector('[data-target="req-lines"]');
      if (linesEl) linesEl.innerHTML = _linesHtml();
    }
  });

  // Form submit.
  const form  = body.querySelector('[data-form="request-form"]');
  const errEl = body.querySelector('[data-req-error]');
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.textContent = '';

    // Sync final field values before validation.
    $$('[data-line-idx]', body).forEach(lineEl => {
      const idx = Number(lineEl.dataset.lineIdx);
      if (idx >= 0 && idx < _lines.length) {
        _lines[idx].description = lineEl.querySelector('[data-field="description"]')?.value?.trim() || '';
        _lines[idx].nsn         = lineEl.querySelector('[data-field="nsn"]')?.value?.trim() || '';
        _lines[idx].qty         = Math.max(1, Number(lineEl.querySelector('[data-field="qty"]')?.value) || 1);
      }
    });

    const fd      = new FormData(form);
    const purpose = fd.get('purpose')?.trim() || '';
    const reqBy   = fd.get('requiredBy')?.trim() || '';
    const notes   = fd.get('notes')?.trim() || '';

    if (!purpose) { errEl.textContent = 'Purpose is required.'; return; }

    let requestorSvc, requestorName, requestorRank;

    if (canManage) {
      const svcInput  = body.querySelector('[data-req-borrower-svc]');
      const nameInput = body.querySelector('[data-req-borrower]');
      requestorSvc = svcInput?.value?.trim() || '';
      if (!requestorSvc) {
        // Try to extract from text.
        const raw = nameInput?.value?.trim() || '';
        const m   = raw.match(/\(([^)]+)\)\s*$/);
        requestorSvc = m ? m[1] : '';
      }
      if (!requestorSvc) { errEl.textContent = 'Select a borrower from the list.'; return; }
      try {
        const cadet = await Storage.cadets.get(requestorSvc);
        requestorName = cadet ? `${cadet.rank} ${cadet.surname}` : requestorSvc;
        requestorRank = cadet?.rank || '';
      } catch {
        requestorName = requestorSvc;
        requestorRank = '';
      }
    } else {
      const session = AUTH.getSession();
      requestorSvc  = session?.svcNo || session?.userId || '';
      requestorName = session?.name  || 'Unknown';
      requestorRank = '';
    }

    const validLines = _lines.filter(l => l.description.trim());
    if (validLines.length === 0) {
      errEl.textContent = 'Add at least one item with a description.';
      return;
    }

    // Submit.
    const submitBtn = form.querySelector('[type="submit"]');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Submitting…'; }

    try {
      const n   = await Storage.counters.next('request', 1000);
      const id  = `REQ-${String(n).padStart(4, '0')}`;
      const req = {
        id,
        requestorSvc,
        requestorName,
        requestorRank,
        purpose,
        requiredBy:   reqBy || null,
        submittedAt:  new Date().toISOString(),
        status:       'pending',
        lines:        validLines.map(l => ({
          description: l.description.trim(),
          nsn:         l.nsn.trim(),
          qty:         Math.max(1, Math.floor(Number(l.qty) || 1)),
        })),
        notes,
        decidedBy:    null,
        decidedAt:    null,
        decisionNote: null,
        loanRefs:     [],
      };
      await Storage.requests.put(req);
      await Storage.audit.append({
        action: 'request_submitted',
        user:   AUTH.getSession()?.name || 'unknown',
        desc:   `Request ${id} submitted by ${requestorName} for ${purpose} — ${validLines.length} item(s).`,
      });
      Sync.notifyChanged();
      showToast(`Request ${id} submitted successfully.`, 'success');

      // Reset form.
      _lines = [{ description: '', nsn: '', qty: 1 }];
      _renderSubmitForm(body);
      _wireSubmitForm(body);

      // Switch cadet to "My Requests" to see their submission.
      if (!canManage) {
        _tab = 'mine';
        $$('.req__tab', _root).forEach(b => {
          b.classList.toggle('is-active', b.dataset.tab === _tab);
          b.setAttribute('aria-selected', String(b.dataset.tab === _tab));
        });
        await _mountTabBody();
      }
    } catch (err) {
      errEl.textContent = err.message || 'Failed to submit request.';
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Submit Request'; }
    }
  });
}

// ---------------------------------------------------------------------------
// MY REQUESTS tab (Cadet / Staff)
// ---------------------------------------------------------------------------

async function _mountMine(body) {
  const session = AUTH.getSession();
  const svcNo   = session?.svcNo || session?.userId || '';

  let mine;
  try {
    if (svcNo) {
      // Filter by requestorSvc index when available.
      const all = await Storage.requests.list();
      mine = all.filter(r => r.requestorSvc === svcNo);
    } else {
      mine = [];
    }
  } catch {
    mine = [];
  }

  mine.sort((a, b) => (a.submittedAt > b.submittedAt ? -1 : 1));

  if (mine.length === 0) {
    body.innerHTML = `
      <div class="req__empty">
        <p>No requests found for your account.</p>
        <p class="req__empty-hint">Use the "New Request" tab to submit an equipment request.</p>
      </div>`;
    return;
  }

  body.innerHTML = `
    <div class="req__list">
      ${mine.map(r => _requestCardHtml(r, false) + _withdrawButtonHtml(r)).join('')}
    </div>`;

  body.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action="withdraw"]');
    if (!btn) return;
    const id  = btn.dataset.id;
    const req = mine.find(r => r.id === id);
    if (!req || req.status !== 'pending') return;

    const confirmed = await _confirmModal(
      `Withdraw request ${req.id}`,
      `Are you sure you want to withdraw your request for <strong>${esc(req.purpose)}</strong>?`
    );
    if (!confirmed) return;

    const session = AUTH.getSession();
    await Storage.requests.put({ ...req, status: 'withdrawn', decidedBy: session?.name || 'self', decidedAt: new Date().toISOString() });
    await Storage.audit.append({
      action: 'request_withdrawn',
      user:   session?.name || 'unknown',
      desc:   `Request ${req.id} withdrawn by ${req.requestorName}.`,
    });
    Sync.notifyChanged();
    showToast(`Request ${req.id} withdrawn.`, 'info');
    await _mountMine(body);
  });
}

function _withdrawButtonHtml(req) {
  if (req.status !== 'pending') return '';
  return `
    <div class="req__withdraw-wrap" data-req-id="${esc(req.id)}">
      <button type="button" class="btn btn--ghost btn--sm"
              data-action="withdraw" data-id="${esc(req.id)}">
        Withdraw
      </button>
    </div>`;
}

// ---------------------------------------------------------------------------
// Print AB189 for a pending request
// ---------------------------------------------------------------------------

async function _printRequestAB189(req, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '⎙ Generating…'; }
  try {
    const unit  = await Storage.settings.getAll().catch(() => ({}));
    let cadet = null;
    if (req.requestorSvc) {
      try { cadet = await Storage.cadets.get(req.requestorSvc); } catch { /* ok */ }
    }
    const result = await generateRequestAB189(req, { unit, cadet });
    downloadPdf(result);
    await Storage.audit.append({
      action:  'pdf_ab189',
      desc:    `AB189 printed for request ${req.id} (${req.requestorName})`,
      user:    AUTH.getSession()?.name || 'unknown',
    });
    showToast('AB189 downloaded.', 'success');
  } catch (err) {
    showToast(`Failed to generate AB189: ${err.message}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⎙ Print AB189'; }
  }
}

// ---------------------------------------------------------------------------
// Blank AB189 download
// ---------------------------------------------------------------------------

async function _downloadBlankForm() {
  try {
    const unit = await Storage.settings.getAll().catch(() => ({}));
    const result = await generateBlankAB189({ unit });
    downloadPdf(result);
    showToast('Blank AB189 form downloaded.', 'success');
  } catch (err) {
    showToast(`Failed to generate form: ${err.message}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// AB189 PDF import (digitally-filled forms via pdfjs text extraction)
// ---------------------------------------------------------------------------

async function _importAB189Pdf(file) {
  showToast('Extracting text from PDF…', 'info', 3000);

  let text = '';
  try {
    const buf  = await file.arrayBuffer();
    const pdf  = await pdfjsLib.getDocument({ data: buf }).promise;
    for (let p = 1; p <= pdf.numPages; p++) {
      const page    = await pdf.getPage(p);
      const content = await page.getTextContent();
      text += content.items.map(it => it.str).join(' ') + '\n';
    }
  } catch (err) {
    showToast(`Could not read PDF: ${err.message}`, 'error');
    return;
  }

  // Attempt to parse the extracted text into request fields.
  const parsed = _parseAB189Text(text);

  // Switch to submit tab and pre-fill the form.
  _tab   = 'submit';
  _lines = parsed.lines.length > 0
    ? parsed.lines
    : [{ description: '', nsn: '', qty: 1 }];

  $$('.req__tab', _root).forEach(b => {
    b.classList.toggle('is-active', b.dataset.tab === _tab);
    b.setAttribute('aria-selected', String(b.dataset.tab === _tab));
  });

  const body = $('[data-target="req-body"]', _root);
  if (!body) return;

  _renderSubmitForm(body);

  // Pre-fill fields from parse.
  const form = body.querySelector('[data-form="request-form"]');
  if (form && parsed.purpose) {
    const purposeSel = form.querySelector('[name="purpose"]');
    if (purposeSel) {
      const match = REQUEST_PURPOSES.find(p => p.toLowerCase() === parsed.purpose.toLowerCase());
      if (match) purposeSel.value = match;
    }
  }
  if (form && parsed.requiredBy) {
    const reqByInput = form.querySelector('[name="requiredBy"]');
    if (reqByInput) reqByInput.value = parsed.requiredBy;
  }
  if (form && parsed.notes) {
    const notesEl = form.querySelector('[name="notes"]');
    if (notesEl) notesEl.value = parsed.notes;
  }

  await _wireSubmitForm(body);

  const count = parsed.lines.length;
  showToast(
    count > 0
      ? `Imported ${count} item${count !== 1 ? 's' : ''} from PDF. Review and submit.`
      : 'PDF imported — no items auto-detected. Fill in the form and submit.',
    count > 0 ? 'success' : 'warn',
    6000
  );
}

/**
 * Best-effort parser for text extracted from a QStore blank AB189 PDF.
 * Our blank form has fixed section labels; this parser looks for them
 * and extracts the values that follow.
 *
 * Only works reliably on digitally-filled PDFs (typed text is preserved
 * as extractable text items by pdfjs). Scanned paper forms require OCR
 * which is out of scope for V2.
 */
function _parseAB189Text(text) {
  const result = {
    purpose:    '',
    requiredBy: '',
    notes:      '',
    lines:      [],
  };

  // Normalise whitespace.
  const t = text.replace(/\s+/g, ' ');

  // Extract "Purpose" field — appears after the label in our form.
  const purposeM = t.match(/Purpose\s+([A-Za-z ]+?)(?=Required by|Remarks|Approval|QM|OC|$)/i);
  if (purposeM) {
    result.purpose = purposeM[1].trim();
  }

  // Extract "Required by" date.
  const reqByM = t.match(/Required by(?:\s*\(date\))?\s+(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}|\d{4}-\d{2}-\d{2})/i);
  if (reqByM) {
    result.requiredBy = _parseDateStr(reqByM[1]);
  }

  // Extract remarks/notes.
  const remarksM = t.match(/Remarks\s*\/?\s*Notes?\s+(.+?)(?=Purpose|Required|QM APPROVAL|OC AUTHORITY|$)/i);
  if (remarksM) {
    result.notes = remarksM[1].trim();
  }

  // Extract item lines from the "Equipment requested" table.
  // Pattern: optional row number, then NSN-looking text or description, then qty.
  // This is heuristic — the blank form has underlines not actual input fields,
  // so typed-over text appears between the underline markers.
  // Look for sequences like: <number> <text> <number> where the trailing number <= 999.
  const itemsSection = t.match(/Equipment requested(.+?)(?:Purpose and details|QM APPROVAL|$)/is);
  if (itemsSection) {
    const rows = itemsSection[1];
    // Match lines that look like: (row#) (description) (qty)
    // NSNs look like NNNN-NN-NNN-NNNN.
    const nsnPat = /(\d{4}-\d{2}-\d{3}-\d{4})/g;
    const nsnMatches = [...rows.matchAll(nsnPat)];

    if (nsnMatches.length > 0) {
      // NSN-based extraction.
      for (const m of nsnMatches) {
        // Grab description text after the NSN.
        const after = rows.slice(m.index + m[0].length, m.index + m[0].length + 120);
        const descM = after.match(/^\s*(.+?)\s+(\d{1,3})\s/);
        result.lines.push({
          description: descM ? descM[1].trim() : '',
          nsn:         m[1],
          qty:         descM ? Number(descM[2]) || 1 : 1,
        });
      }
    } else {
      // No NSNs — try to extract description + qty pairs.
      // Row pattern: number . description qty
      const rowPat = /(\d+)\.\s*([A-Za-z][^0-9]{3,60?})\s+(\d{1,3})(?:\s|$)/g;
      for (const m of rows.matchAll(rowPat)) {
        const desc = m[2].trim();
        if (desc.length >= 3) {
          result.lines.push({ description: desc, nsn: '', qty: Number(m[3]) || 1 });
        }
      }
    }
  }

  return result;
}

/** Try to parse various date string formats into ISO YYYY-MM-DD. */
function _parseDateStr(str) {
  if (!str) return '';
  // Already ISO.
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  // DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
  const m = str.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
  if (m) {
    let [, dd, mm, yyyy] = m;
    if (yyyy.length === 2) yyyy = `20${yyyy}`;
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function _statusBadge(status) {
  const cls = {
    pending:   'req__badge--pending',
    approved:  'req__badge--approved',
    issued:    'req__badge--issued',
    denied:    'req__badge--denied',
    withdrawn: 'req__badge--withdrawn',
  }[status] || '';
  return `<span class="req__badge ${cls}">${esc(_statusLabel(status))}</span>`;
}

function _statusLabel(status) {
  return {
    pending:   'Pending',
    approved:  'Approved',
    issued:    'Issued',
    denied:    'Denied',
    withdrawn: 'Withdrawn',
    all:       'All',
  }[status] || status;
}

function _todayLocalIsoDate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function _defaultDueDate() {
  const d = new Date();
  d.setDate(d.getDate() + 14);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function _nextRequestLoanRef() {
  const n = await Storage.counters.next('loan', 1000);
  return `LN-${n}`;
}

/** Simple confirm modal — returns a promise that resolves to true/false. */
function _confirmModal(title, bodyHtml) {
  return new Promise((resolve) => {
    openModal({
      titleHtml: esc(title),
      size: 'sm',
      bodyHtml: `
        <p class="modal__body">${bodyHtml}</p>
        <div class="form__actions">
          <button type="button" class="btn btn--ghost" data-action="modal-close">Cancel</button>
          <button type="button" class="btn btn--danger" data-action="confirm">Confirm</button>
        </div>`,
      onMount(panel, close) {
        panel.querySelector('[data-action="confirm"]')?.addEventListener('click', () => {
          resolve(true);
          close();
        });
      },
      onClose() {
        resolve(false);
      },
    });
  });
}
