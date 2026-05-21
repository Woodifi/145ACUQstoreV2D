// =============================================================================
// QStore IMS v3 — IMS Reports Hub
// =============================================================================
// Dedicated Reports page for IMS data (separate from Accounting reports).
// Surfaces four report types:
//
//   1. Outstanding loans    — active loans grouped by borrower / item / plt
//   2. Written-off items    — items with writtenOff qty > 0 (from inventory)
//   3. Issue history        — all loans in a date range (CSV/print)
//   4. Kit allocation       — Initial Issue items per cadet (summary)
//
// All reports are rendered inline and printable via Ctrl+P.
// CSV export downloads the data as a spreadsheet-friendly file.
// =============================================================================

import * as Storage  from '../storage.js';
import * as AUTH     from '../auth.js';
import { esc, $, render } from './util.js';
import { showToast }      from './toast.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function _csvCell(val) {
  const s = String(val ?? '');
  return /[,"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function _download(content, filename, mimeType = 'text/csv') {
  const blob = new Blob([content], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function _today() { return new Date().toISOString().slice(0, 10); }

// ---------------------------------------------------------------------------
// Report 1: Outstanding loans
// ---------------------------------------------------------------------------

function _renderOutstandingLoans(loans, groupBy) {
  const today    = _today();
  const active   = loans.filter((l) => l.active !== false);
  const overdue  = active.filter((l) => !l.longTermLoan && l.dueDate && l.dueDate < today);

  if (active.length === 0) {
    return '<p class="ims-report__empty">No active loans.</p>';
  }

  let html = `<p class="ims-report__meta">${active.length} active loan${active.length === 1 ? '' : 's'}, ${overdue.length} overdue</p>`;

  if (groupBy === 'borrower') {
    const groups = {};
    for (const l of active) {
      const key = l.borrowerName || l.borrowerSvcNo || 'Unknown';
      if (!groups[key]) groups[key] = [];
      groups[key].push(l);
    }
    for (const [borrower, rows] of Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0]))) {
      html += `
        <h4 class="ims-report__group">${esc(borrower)}</h4>
        ${_loanTableHtml(rows, today)}
      `;
    }
  } else if (groupBy === 'item') {
    const groups = {};
    for (const l of active) {
      const key = l.itemName || l.itemId || 'Unknown item';
      if (!groups[key]) groups[key] = [];
      groups[key].push(l);
    }
    for (const [item, rows] of Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0]))) {
      html += `
        <h4 class="ims-report__group">${esc(item)}</h4>
        ${_loanTableHtml(rows, today)}
      `;
    }
  } else {
    // Flat (no grouping)
    html += _loanTableHtml(active, today);
  }

  return html;
}

function _loanTableHtml(loans, today) {
  return `
    <table class="ims-report__table">
      <thead>
        <tr>
          <th>Ref</th><th>Borrower</th><th>Item</th><th>Qty</th>
          <th>Issued</th><th>Due</th><th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${loans.map((l) => {
          const overdue = !l.longTermLoan && l.dueDate && l.dueDate < today;
          return `
            <tr class="${overdue ? 'ims-report__row--overdue' : ''}">
              <td class="ims-report__mono">${esc(l.ref)}</td>
              <td>${esc(l.borrowerName || l.borrowerSvcNo || '—')}</td>
              <td>${esc(l.itemName || '—')}${l.nsn ? `<div class="ims-report__sub">${esc(l.nsn)}</div>` : ''}</td>
              <td>${l.qty}</td>
              <td>${esc(_fmtDate(l.issueDate))}</td>
              <td>${l.longTermLoan ? 'Long-term' : esc(_fmtDate(l.dueDate))}</td>
              <td>${overdue
                ? '<span class="ims-report__badge ims-report__badge--danger">Overdue</span>'
                : l.longTermLoan
                  ? '<span class="ims-report__badge ims-report__badge--info">Long-term</span>'
                  : '<span class="ims-report__badge ims-report__badge--ok">Active</span>'}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

function _exportOutstandingCsv(loans) {
  const today  = _today();
  const active = loans.filter((l) => l.active !== false);
  const header = ['Ref', 'Borrower', 'Svc No', 'Item', 'NSN', 'Qty', 'Issue date', 'Due date', 'Status'];
  const rows   = active.map((l) => {
    const overdue = !l.longTermLoan && l.dueDate && l.dueDate < today;
    return [
      l.ref, l.borrowerName || '', l.borrowerSvcNo || '',
      l.itemName || '', l.nsn || '', l.qty || '',
      l.issueDate || '', l.dueDate || '',
      l.longTermLoan ? 'Long-term' : overdue ? 'Overdue' : 'Active',
    ].map(_csvCell).join(',');
  });
  return [header.join(','), ...rows].join('\r\n');
}

// ---------------------------------------------------------------------------
// Report 2: Written-off items
// ---------------------------------------------------------------------------

function _renderWrittenOff(items) {
  const writtenOff = items.filter((i) =>
    (Number(i.qtyWrittenOff) || Number(i.writtenOff) || 0) > 0
  );

  if (writtenOff.length === 0) {
    return '<p class="ims-report__empty">No written-off items on record.</p>';
  }

  const total = writtenOff.reduce((s, i) => s + (Number(i.qtyWrittenOff) || Number(i.writtenOff) || 0), 0);

  return `
    <p class="ims-report__meta">${writtenOff.length} item type${writtenOff.length === 1 ? '' : 's'}, ${total} unit${total === 1 ? '' : 's'} written off</p>
    <table class="ims-report__table">
      <thead>
        <tr>
          <th>NSN</th><th>Item name</th><th>Category</th>
          <th>On hand</th><th>Written off</th><th>Auth qty</th>
        </tr>
      </thead>
      <tbody>
        ${writtenOff.map((i) => `
          <tr>
            <td class="ims-report__mono">${esc(i.nsn || '—')}</td>
            <td>${esc(i.name || '—')}</td>
            <td>${esc(i.cat || '—')}</td>
            <td>${Number(i.onHand) || 0}</td>
            <td class="ims-report__num--danger">${Number(i.qtyWrittenOff) || Number(i.writtenOff) || 0}</td>
            <td>${Number(i.authQty) || '—'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function _exportWrittenOffCsv(items) {
  const writtenOff = items.filter((i) =>
    (Number(i.qtyWrittenOff) || Number(i.writtenOff) || 0) > 0
  );
  const header = ['NSN', 'Item name', 'Category', 'On hand', 'Written off', 'Auth qty'];
  const rows   = writtenOff.map((i) => [
    i.nsn || '', i.name || '', i.cat || '',
    Number(i.onHand) || 0,
    Number(i.qtyWrittenOff) || Number(i.writtenOff) || 0,
    Number(i.authQty) || 0,
  ].map(_csvCell).join(','));
  return [header.join(','), ...rows].join('\r\n');
}

// ---------------------------------------------------------------------------
// Report 3: Issue history
// ---------------------------------------------------------------------------

function _renderIssueHistory(loans, fromDate, toDate) {
  let filtered = loans.filter((l) => {
    const date = l.issueDate || '';
    return (!fromDate || date >= fromDate) && (!toDate || date <= toDate);
  });
  filtered.sort((a, b) => (b.issueDate || '').localeCompare(a.issueDate || ''));

  if (filtered.length === 0) {
    return '<p class="ims-report__empty">No loans found in the selected date range.</p>';
  }

  return `
    <p class="ims-report__meta">${filtered.length} loan${filtered.length === 1 ? '' : 's'} in range</p>
    <table class="ims-report__table">
      <thead>
        <tr>
          <th>Ref</th><th>Issued</th><th>Borrower</th><th>Item</th><th>Qty</th>
          <th>Purpose</th><th>Returned</th><th>Condition</th>
        </tr>
      </thead>
      <tbody>
        ${filtered.map((l) => `
          <tr>
            <td class="ims-report__mono">${esc(l.ref)}</td>
            <td>${esc(_fmtDate(l.issueDate))}</td>
            <td>${esc(l.borrowerName || l.borrowerSvcNo || '—')}</td>
            <td>${esc(l.itemName || '—')}</td>
            <td>${l.qty}</td>
            <td>${esc(l.purpose || '—')}</td>
            <td>${l.active === false ? esc(_fmtDate(l.returnDate)) : '<em>On loan</em>'}</td>
            <td>${l.returnCondition ? esc(l.returnCondition) : '—'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function _exportIssueHistoryCsv(loans, fromDate, toDate) {
  let filtered = loans.filter((l) => {
    const date = l.issueDate || '';
    return (!fromDate || date >= fromDate) && (!toDate || date <= toDate);
  });
  filtered.sort((a, b) => (b.issueDate || '').localeCompare(a.issueDate || ''));
  const header = ['Ref', 'Issue date', 'Borrower', 'Svc No', 'Item', 'NSN', 'Qty',
                  'Purpose', 'Due date', 'Active', 'Return date', 'Return condition'];
  const rows = filtered.map((l) => [
    l.ref, l.issueDate || '', l.borrowerName || '', l.borrowerSvcNo || '',
    l.itemName || '', l.nsn || '', l.qty || '',
    l.purpose || '', l.dueDate || '', l.active !== false ? 'Yes' : 'No',
    l.returnDate || '', l.returnCondition || '',
  ].map(_csvCell).join(','));
  return [header.join(','), ...rows].join('\r\n');
}

// ---------------------------------------------------------------------------
// Report 4: Kit allocation (Initial Issue)
// ---------------------------------------------------------------------------

function _renderKitAllocation(loans, cadets) {
  // Only Initial Issue loans (purpose === 'Initial Issue') grouped by borrower
  const kitLoans = loans.filter((l) =>
    l.active !== false &&
    (l.purpose === 'Initial Issue' || l.purpose === 'initial_issue')
  );

  if (kitLoans.length === 0) {
    return '<p class="ims-report__empty">No Initial Issue loans on record.</p>';
  }

  const byBorrower = {};
  for (const l of kitLoans) {
    const key = l.borrowerSvcNo || l.borrowerName || 'Unknown';
    if (!byBorrower[key]) byBorrower[key] = { name: l.borrowerName || '', svcNo: l.borrowerSvcNo || '', items: [] };
    byBorrower[key].items.push(l);
  }

  return `
    <p class="ims-report__meta">${Object.keys(byBorrower).length} cadet${Object.keys(byBorrower).length === 1 ? '' : 's'} with Initial Issue kit</p>
    <table class="ims-report__table">
      <thead>
        <tr>
          <th>Svc No</th><th>Name</th><th>Items issued</th><th>Total qty</th><th>Oldest issue</th>
        </tr>
      </thead>
      <tbody>
        ${Object.entries(byBorrower).sort((a, b) => (a[1].name || a[0]).localeCompare(b[1].name || b[0])).map(([key, d]) => {
          const totalQty  = d.items.reduce((s, l) => s + (Number(l.qty) || 0), 0);
          const oldestDt  = d.items.map((l) => l.issueDate || '').sort()[0];
          return `
            <tr>
              <td class="ims-report__mono">${esc(d.svcNo || '—')}</td>
              <td>${esc(d.name || '—')}</td>
              <td>${d.items.map((l) => `${esc(l.itemName || '')} (×${l.qty})`).join(', ')}</td>
              <td>${totalQty}</td>
              <td>${esc(_fmtDate(oldestDt))}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

function _exportKitAllocationCsv(loans) {
  const kitLoans = loans.filter((l) =>
    l.active !== false &&
    (l.purpose === 'Initial Issue' || l.purpose === 'initial_issue')
  );
  const header = ['Svc No', 'Borrower name', 'Item', 'NSN', 'Qty', 'Issue date', 'Loan ref'];
  const rows   = kitLoans.map((l) => [
    l.borrowerSvcNo || '', l.borrowerName || '',
    l.itemName || '', l.nsn || '', l.qty || '',
    l.issueDate || '', l.ref,
  ].map(_csvCell).join(','));
  return [header.join(','), ...rows].join('\r\n');
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

export function mount(root) {
  let _destroyed    = false;
  let _activeReport = 'outstanding';
  let _groupBy      = 'borrower';
  let _fromDate     = '';
  let _toDate       = _today();
  let _loans        = [];
  let _items        = [];
  let _cadets       = [];

  AUTH.requirePermission('view');

  async function _load() {
    if (_destroyed) return;
    [_loans, _items, _cadets] = await Promise.all([
      Storage.loans.list(),
      Storage.items.list(),
      Storage.cadets.list(),
    ]);
    _render();
  }

  const REPORT_TABS = [
    { id: 'outstanding', label: 'Outstanding loans' },
    { id: 'writtenoff',  label: 'Written-off items'  },
    { id: 'history',     label: 'Issue history'       },
    { id: 'kit',         label: 'Kit allocation'      },
  ];

  function _render() {
    if (_destroyed) return;
    render(root, `
      <div class="ims-report">
        <div class="ims-report__header">
          <h2 class="ims-report__title">IMS Reports</h2>
        </div>
        <div class="ims-report__tabs">
          ${REPORT_TABS.map((t) => `
            <button type="button"
                    class="ims-report__tab ${_activeReport === t.id ? 'ims-report__tab--active' : ''}"
                    data-report="${esc(t.id)}">
              ${esc(t.label)}
            </button>
          `).join('')}
        </div>

        <div class="ims-report__body">
          ${_activeReport === 'outstanding' ? `
            <div class="ims-report__controls">
              <label style="font-size:13px">Group by:</label>
              <select class="ims-report__groupby" id="ims-report-groupby">
                <option value="borrower" ${_groupBy === 'borrower' ? 'selected' : ''}>Borrower</option>
                <option value="item"     ${_groupBy === 'item'     ? 'selected' : ''}>Item</option>
                <option value="none"     ${_groupBy === 'none'     ? 'selected' : ''}>None (flat)</option>
              </select>
              <button type="button" class="btn btn--ghost btn--sm" data-action="export-outstanding">
                ↓ CSV
              </button>
              <button type="button" class="btn btn--ghost btn--sm" onclick="window.print()">⎙ Print</button>
            </div>
            ${_renderOutstandingLoans(_loans, _groupBy)}
          ` : ''}

          ${_activeReport === 'writtenoff' ? `
            <div class="ims-report__controls">
              <button type="button" class="btn btn--ghost btn--sm" data-action="export-writtenoff">
                ↓ CSV
              </button>
              <button type="button" class="btn btn--ghost btn--sm" onclick="window.print()">⎙ Print</button>
            </div>
            ${_renderWrittenOff(_items)}
          ` : ''}

          ${_activeReport === 'history' ? `
            <div class="ims-report__controls">
              <label class="ims-report__date-lbl">From</label>
              <input type="date" id="ims-history-from" value="${esc(_fromDate)}"
                     max="${esc(_today())}">
              <label class="ims-report__date-lbl">To</label>
              <input type="date" id="ims-history-to" value="${esc(_toDate)}"
                     max="${esc(_today())}">
              <button type="button" class="btn btn--ghost btn--sm" data-action="export-history">
                ↓ CSV
              </button>
              <button type="button" class="btn btn--ghost btn--sm" onclick="window.print()">⎙ Print</button>
            </div>
            ${_renderIssueHistory(_loans, _fromDate, _toDate)}
          ` : ''}

          ${_activeReport === 'kit' ? `
            <div class="ims-report__controls">
              <button type="button" class="btn btn--ghost btn--sm" data-action="export-kit">
                ↓ CSV
              </button>
              <button type="button" class="btn btn--ghost btn--sm" onclick="window.print()">⎙ Print</button>
            </div>
            ${_renderKitAllocation(_loans, _cadets)}
          ` : ''}
        </div>
      </div>
    `);

    _wire();
  }

  function _wire() {
    root.querySelectorAll('[data-report]').forEach((btn) => {
      btn.addEventListener('click', () => {
        _activeReport = btn.dataset.report;
        _render();
      });
    });

    $('#ims-report-groupby', root)?.addEventListener('change', (e) => {
      _groupBy = e.target.value;
      _render();
    });

    $('#ims-history-from', root)?.addEventListener('change', (e) => {
      _fromDate = e.target.value;
      _render();
    });

    $('#ims-history-to', root)?.addEventListener('change', (e) => {
      _toDate = e.target.value;
      _render();
    });

    $('[data-action="export-outstanding"]', root)?.addEventListener('click', () => {
      try {
        _download(_exportOutstandingCsv(_loans), `qstore-outstanding-${_today()}.csv`);
        showToast('CSV downloaded.', 'success');
      } catch (err) { showToast('Export failed: ' + (err.message || err), 'error'); }
    });

    $('[data-action="export-writtenoff"]', root)?.addEventListener('click', () => {
      try {
        _download(_exportWrittenOffCsv(_items), `qstore-writtenoff-${_today()}.csv`);
        showToast('CSV downloaded.', 'success');
      } catch (err) { showToast('Export failed: ' + (err.message || err), 'error'); }
    });

    $('[data-action="export-history"]', root)?.addEventListener('click', () => {
      try {
        _download(_exportIssueHistoryCsv(_loans, _fromDate, _toDate), `qstore-issue-history-${_today()}.csv`);
        showToast('CSV downloaded.', 'success');
      } catch (err) { showToast('Export failed: ' + (err.message || err), 'error'); }
    });

    $('[data-action="export-kit"]', root)?.addEventListener('click', () => {
      try {
        _download(_exportKitAllocationCsv(_loans), `qstore-kit-allocation-${_today()}.csv`);
        showToast('CSV downloaded.', 'success');
      } catch (err) { showToast('Export failed: ' + (err.message || err), 'error'); }
    });
  }

  _load();
  return function unmount() { _destroyed = true; };
}
