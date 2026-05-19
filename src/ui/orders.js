// =============================================================================
// QStore IMS v2 — AAC QStore Orders page
// =============================================================================
// Tracks supply orders imported from AAC QStore PDF documents.
//
// Workflow:
//   1. QM imports a PDF → parsed → editable review screen (NOT saved yet)
//   2. QM corrects any parsing errors (meta fields + item rows inline)
//   3. QM clicks Save → stored in IndexedDB
//   4. Existing orders can be re-opened for editing at any time via Edit button
//   5. Issue orders: Approve & Receive updates IMS inventory
// =============================================================================

import * as Storage    from '../storage.js';
import * as AUTH       from '../auth.js';
import { parseOrderPdf, orderToCsv } from '../order-parser.js';
import { openModal }   from './modal.js';
import { esc, $, render } from './util.js';

const _uuid = () => crypto.randomUUID?.() ||
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

// ── Module state ──────────────────────────────────────────────────────────────

let _root      = null;
let _importing = false;

// ── Mount / Unmount ───────────────────────────────────────────────────────────

export async function mount(rootEl) {
  _root = rootEl;
  await _renderList();
  return () => { _root = null; };
}

// ── List view ─────────────────────────────────────────────────────────────────

async function _renderList() {
  if (!_root) return;
  const all = await Storage.orders.list();
  all.sort((a, b) => (b.importedAt || '').localeCompare(a.importedAt || ''));

  render(_root, `
    <div class="orders">
      <div class="orders__header">
        <h1 class="orders__title">AAC QStore Orders</h1>
        <div class="orders__header-actions">
          <label class="btn btn--primary orders__import-btn" tabindex="0"
                 role="button" title="Import a PDF order from AAC QStore">
            <input type="file" accept="application/pdf,.pdf" style="display:none"
                   data-action="import-pdf">
            Import PDF Order
          </label>
        </div>
      </div>

      ${all.length === 0 ? `
        <div class="orders__empty">
          <div class="orders__empty-icon">📋</div>
          <p>No orders imported yet.</p>
          <p class="orders__empty-hint">Click <strong>Import PDF Order</strong> to load an
             AAC QStore supply order PDF.</p>
        </div>
      ` : `
        <div class="orders__list">
          ${all.map(_orderRowHtml).join('')}
        </div>
      `}

      <div class="orders__parse-error form__error" role="alert" style="display:none"></div>
    </div>
  `);

  const fileInput  = $('input[data-action="import-pdf"]', _root);
  const importLabel = $('.orders__import-btn', _root);

  fileInput?.addEventListener('change', _onImportFile);
  importLabel?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput?.click(); }
  });

  _root.addEventListener('click', (e) => {
    const row = e.target.closest('[data-order-id]');
    if (row) _openDetail(row.dataset.orderId);
  });
}

function _orderRowHtml(order) {
  const dateStr   = order.dateRaw || order.date || '—';
  const requestor = [order.requestorRank, order.requestorName].filter(Boolean).join(' ') || '—';
  const itemCount = order.items?.length ?? 0;
  return `
    <div class="orders__row" data-order-id="${esc(order.id)}" role="button" tabindex="0"
         aria-label="Order ${esc(order.orderId)}">
      <div class="orders__row-meta">
        <span class="orders__row-id">Order #${esc(order.orderId)}</span>
        ${_typeBadge(order.docType)} ${_statusBadge(order)}
        <span class="ord__badge ord__badge--cat">${esc(_catLabel(order.orderCategory))}</span>
      </div>
      <div class="orders__row-body">
        <span class="orders__row-date">${esc(dateStr)}</span>
        <span class="orders__row-requestor">${esc(requestor)}</span>
        <span class="orders__row-unit">${esc(order.unit || '—')}</span>
        <span class="orders__row-count">${itemCount} item${itemCount !== 1 ? 's' : ''}</span>
      </div>
    </div>
  `;
}

function _statusBadge(order) {
  const map = {
    pending:  ['ord__badge--pending',  'Pending'],
    approved: ['ord__badge--approved', 'Approved'],
    received: ['ord__badge--received', 'Received'],
  };
  const [cls, label] = map[order.status] || ['ord__badge--pending', 'Pending'];
  return `<span class="ord__badge ${esc(cls)}">${esc(label)}</span>`;
}

function _typeBadge(docType) {
  const cls   = docType === 'issue' ? 'ord__badge--issue' : 'ord__badge--request';
  const label = docType === 'issue' ? 'Issue' : 'Request';
  return `<span class="ord__badge ${esc(cls)}">${esc(label)}</span>`;
}

function _catLabel(cat) {
  return ({ uniform: 'Uniform', equipment: 'Equipment', general: 'General' })[cat] || cat || 'General';
}

// ── Import PDF ────────────────────────────────────────────────────────────────

async function _onImportFile(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  e.target.value = '';

  const errEl = $('.orders__parse-error', _root);
  if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
  if (_importing) return;
  _importing = true;

  const importBtn = $('.orders__import-btn', _root);
  if (importBtn) importBtn.classList.add('btn--loading');

  try {
    const buf    = await file.arrayBuffer();
    let parsed;
    try {
      parsed = await parseOrderPdf(buf);
    } catch (parseErr) {
      // Wrap low-level pdfjs errors in a user-friendly message.
      const msg = parseErr?.message || '';
      if (/password/i.test(msg)) {
        throw new Error('This PDF is password-protected. Remove the password and try again.');
      } else if (/invalid|corrupt|stream/i.test(msg)) {
        throw new Error('The PDF appears to be damaged or is not a valid AAC QStore order document.');
      } else {
        throw new Error('Could not read the PDF. Make sure you\'re importing an AAC QStore order saved directly from the QStore website.');
      }
    }

    if (!parsed.orderId && parsed.items.length === 0) {
      throw new Error(
        'No order data found in this PDF. ' +
        'Check that it\'s an AAC QStore supply order (not a receipt or other document).'
      );
    }

    // ── IMS enrichment ───────────────────────────────────────────────────────
    // For each parsed item whose NSN matches an IMS record, replace the PDF
    // description with the canonical IMS item name. This ensures consistent
    // naming and prevents clothing size descriptors from polluting descriptions.
    const imsItems  = await Storage.items.list();
    const imsNsnMap = new Map(imsItems.filter(i => i.nsn).map(i => [i.nsn.trim(), i]));
    let imsMatchCount = 0;

    parsed.items = parsed.items.map(item => {
      if (!item.nsn) return item;
      const imsItem = imsNsnMap.get(item.nsn.trim());
      if (!imsItem) return item;
      imsMatchCount++;
      const descChanged = item.description !== imsItem.name;
      return {
        ...item,
        description:     imsItem.name,
        _imsMatch:       true,
        _imsDescChanged: descChanged,
        _pdfDesc:        descChanged ? item.description : '',
      };
    });

    // Build the draft order (no ID yet — not saved until user confirms in edit view)
    const draft = {
      id:             `order-${_uuid()}`,
      orderId:        parsed.orderId,
      orderCategory:  parsed.orderCategory,
      docType:        parsed.docType,
      orderStatus:    parsed.orderStatus,
      status:         'pending',
      date:           parsed.date,
      dateRaw:        parsed.dateRaw,
      requestorName:  parsed.requestorName,
      requestorRank:  parsed.requestorRank,
      requestorSvcNo: parsed.requestorSvcNo,
      unit:           parsed.unit,
      items:          parsed.items,
      importedAt:     new Date().toISOString(),
      approvedAt:     null,
      approvedBy:     null,
      notes:          '',
    };

    // Check for duplicate (informational only — still show review screen)
    const existing = await Storage.orders.list();
    const dup = existing.find(o => o.orderId === draft.orderId && draft.orderId);

    // Go to editable review — user verifies/corrects before save
    await _renderEdit(draft, { isNew: true, isDuplicate: !!dup, imsMatchCount });

  } catch (err) {
    console.error('[Orders] Import failed:', err);
    if (errEl) {
      errEl.textContent = `Import failed: ${err.message || 'Unknown error'}`;
      errEl.style.display = '';
    }
  } finally {
    _importing = false;
    if (importBtn) importBtn.classList.remove('btn--loading');
  }
}

// ── Edit / Review view ────────────────────────────────────────────────────────
//
// Used for two scenarios:
//   isNew = true  → after PDF import, before first save
//   isNew = false → editing an already-saved order

async function _renderEdit(order, { isNew = false, isDuplicate = false, imsMatchCount = null } = {}) {
  if (!_root) return;

  const items = order.items || [];

  render(_root, `
    <div class="orders">
      <div class="orders__header">
        <button type="button" class="btn btn--ghost orders__back" data-action="back">
          ← ${isNew ? 'Cancel import' : 'Cancel'}
        </button>
        <div class="orders__header-actions">
          ${isDuplicate ? `
            <span class="ord__badge ord__badge--pending" title="An order with this number was already imported">
              ⚠ Duplicate order number
            </span>
          ` : ''}
          <button type="button" class="btn btn--primary" data-action="save-order">
            ${isNew ? 'Save Order' : 'Save Changes'}
          </button>
        </div>
      </div>

      ${isNew ? `
        <div class="ord__edit-notice">
          <strong>Review before saving.</strong>
          Check all descriptions, quantities and NSNs below, then click
          <strong>Save Order</strong>. You can correct any row inline.
          ${imsMatchCount !== null && items.length > 0 ? `
            <div class="ord__edit-ims-summary">
              ${imsMatchCount > 0
                ? `<span class="ord__ims-pill ord__ims-pill--found">
                     ✓ ${imsMatchCount} of ${items.length} items matched your IMS —
                     descriptions updated to match your inventory names.
                     Items highlighted <span class="ord__ims-pill--changed-eg">like this</span>
                     had their PDF description replaced.
                   </span>`
                : `<span class="ord__ims-pill ord__ims-pill--none">
                     No items matched your current IMS inventory by NSN — all items will
                     need to be created as new entries when received.
                   </span>`
              }
            </div>
          ` : ''}
        </div>
      ` : ''}

      <form class="ord__edit-form" data-edit-form autocomplete="off" novalidate>

        <!-- Meta fields -->
        <div class="ord__edit-meta">
          <div class="ord__edit-meta-grid">

            <label class="form__field">
              <span class="form__label">Order number</span>
              <input type="text" name="orderId" class="form__input"
                     value="${esc(order.orderId || '')}" placeholder="e.g. 21922">
            </label>

            <label class="form__field">
              <span class="form__label">Category</span>
              <select name="orderCategory" class="form__select">
                <option value="uniform"   ${order.orderCategory === 'uniform'   ? 'selected' : ''}>Uniform</option>
                <option value="equipment" ${order.orderCategory === 'equipment' ? 'selected' : ''}>Equipment</option>
                <option value="general"   ${order.orderCategory === 'general'   ? 'selected' : ''}>General</option>
              </select>
            </label>

            <label class="form__field">
              <span class="form__label">Type</span>
              <select name="docType" class="form__select">
                <option value="request" ${order.docType === 'request' ? 'selected' : ''}>Request</option>
                <option value="issue"   ${order.docType === 'issue'   ? 'selected' : ''}>Issue</option>
              </select>
            </label>

            <label class="form__field">
              <span class="form__label">AAC Status</span>
              <input type="text" name="orderStatus" class="form__input"
                     value="${esc(order.orderStatus || '')}" placeholder="e.g. Order submitted">
            </label>

            <label class="form__field">
              <span class="form__label">Date</span>
              <input type="text" name="dateRaw" class="form__input"
                     value="${esc(order.dateRaw || order.date || '')}"
                     placeholder="e.g. 05 Apr 2026 12:17:01">
            </label>

            <label class="form__field">
              <span class="form__label">Requestor rank</span>
              <input type="text" name="requestorRank" class="form__input"
                     value="${esc(order.requestorRank || '')}" placeholder="e.g. LT(AAC)">
            </label>

            <label class="form__field">
              <span class="form__label">Requestor name</span>
              <input type="text" name="requestorName" class="form__input"
                     value="${esc(order.requestorName || '')}" placeholder="e.g. Scales, Sean">
            </label>

            <label class="form__field">
              <span class="form__label">Svc No</span>
              <input type="text" name="requestorSvcNo" class="form__input"
                     value="${esc(order.requestorSvcNo || '')}" placeholder="e.g. 2444075">
            </label>

            <label class="form__field ord__edit-unit-field">
              <span class="form__label">Unit</span>
              <input type="text" name="unit" class="form__input"
                     value="${esc(order.unit || '')}" placeholder="e.g. 145 ACU Moranbah Community">
            </label>

          </div>
        </div>

        <!-- Items table -->
        <div class="orders__items-section ord__edit-items-section">
          <div class="ord__edit-items-header">
            <h3 class="orders__items-heading">
              Items
              <span class="orders__items-count" data-item-count>${items.length}</span>
            </h3>
            <button type="button" class="btn btn--ghost btn--sm" data-action="add-row">
              + Add row
            </button>
          </div>

          <div class="orders__table-wrap">
            <table class="orders__table ord__edit-table">
              <thead>
                <tr>
                  <th class="ord__edit-col-nsn">NSN</th>
                  <th>Description
                    <span class="ord__edit-col-hint">
                      (✎ click to edit; IMS names shown where matched)
                    </span>
                  </th>
                  <th class="orders__col-num ord__edit-col-qty"
                      title="Qty Required — from the QTYREQ column of the order PDF">Qty Req</th>
                  <th class="orders__col-num ord__edit-col-qty"
                      title="Qty Requisitioned — quantity formally submitted">Qty Req'd</th>
                  <th class="orders__col-num ord__edit-col-qty"
                      title="Qty Received — quantity actually received">Qty Recv'd</th>
                  <th class="ord__edit-col-ims" title="IMS match status">IMS</th>
                  <th class="ord__edit-col-del"></th>
                </tr>
              </thead>
              <tbody data-items-body>
                ${items.map((item, i) => _editRowHtml(item, i)).join('')}
              </tbody>
            </table>
          </div>

          ${items.length === 0 ? `
            <p class="orders__items-empty" data-empty-hint>
              No items extracted — add rows manually below.
            </p>
          ` : ''}
        </div>

        <div class="form__error ord__edit-err" role="alert"></div>

      </form>
    </div>
  `);

  // ── Event wiring ───────────────────────────────────────────────────────────

  const form     = $('[data-edit-form]', _root);
  const body     = $('[data-items-body]', _root);
  const errEl    = $('.ord__edit-err', _root);
  const countEl  = $('[data-item-count]', _root);

  function _updateCount() {
    if (countEl) countEl.textContent = body?.querySelectorAll('tr').length ?? 0;
  }

  // Back / cancel
  $('[data-action="back"]', _root)?.addEventListener('click', async () => {
    if (isNew) {
      await _renderList();
    } else {
      const saved = await Storage.orders.get(order.id);
      if (saved) await _renderDetail(saved);
      else await _renderList();
    }
  });

  // Add row
  $('[data-action="add-row"]', _root)?.addEventListener('click', () => {
    const idx = body.querySelectorAll('tr').length;
    const emptyItem = { nsn: '', description: '', qtyRequired: null, qtyRequisitioned: null, qtyReceived: null };
    body.insertAdjacentHTML('beforeend', _editRowHtml(emptyItem, idx));
    _updateCount();
    // Focus the NSN input of the new row
    body.querySelector(`tr:last-child input[name^="nsn"]`)?.focus();
    const hint = $('[data-empty-hint]', _root);
    if (hint) hint.remove();
  });

  // Delete row (delegated)
  body?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="delete-row"]');
    if (!btn) return;
    btn.closest('tr')?.remove();
    _updateCount();
  });

  // Save
  $('[data-action="save-order"]', _root)?.addEventListener('click', async () => {
    if (errEl) errEl.textContent = '';
    try {
      const updated = _readEditForm(form, order, body);
      await Storage.orders.put(updated);
      await Storage.audit.append({
        action: isNew ? 'order-import' : 'order-edit',
        user:   AUTH.getSession()?.name || '',
        desc:   isNew
          ? `Imported AAC QStore order #${updated.orderId} (${updated.docType}, ${updated.items.length} items)`
          : `Edited order #${updated.orderId}`,
      });
      await _renderDetail(updated);
    } catch (err) {
      if (errEl) errEl.textContent = err.message || 'Save failed.';
    }
  });
}

function _editRowHtml(item, idx) {
  const qtyReq  = item.qtyRequired      != null ? item.qtyRequired      : '';
  const qtyReqd = item.qtyRequisitioned != null ? item.qtyRequisitioned : '';
  const qtyRecv = item.qtyReceived      != null ? item.qtyReceived      : '';

  // IMS status badge for the edit table
  let imsBadge;
  if (!item.nsn) {
    imsBadge = `<span class="ord__ims-status ord__ims--no-nsn" title="No NSN — cannot match IMS">No NSN</span>`;
  } else if (item._imsMatch) {
    imsBadge = `<span class="ord__ims-status ord__ims--found" title="NSN matched in your IMS inventory">✓ IMS</span>`;
  } else {
    imsBadge = `<span class="ord__ims-status ord__ims--new" title="NSN not found in IMS — will be a new item if received">New</span>`;
  }

  // If the description was auto-replaced with an IMS name, show the original
  // PDF description as a small hint below the input so the QM can compare.
  const pdfDescHint = item._imsDescChanged && item._pdfDesc
    ? `<div class="ord__edit-pdf-desc" title="Original text from PDF">
         PDF: ${esc(item._pdfDesc)}
       </div>`
    : '';

  const rowClass = item._imsDescChanged ? 'ord__edit-row ord__edit-row--desc-replaced' : 'ord__edit-row';

  return `
    <tr class="${rowClass}">
      <td>
        <input type="text" name="nsn_${idx}" class="form__input ord__edit-input ord__edit-input--nsn"
               value="${esc(item.nsn || '')}" placeholder="0000-00-000-0000"
               spellcheck="false" autocomplete="off">
      </td>
      <td class="ord__edit-desc-cell">
        <input type="text" name="desc_${idx}" class="form__input ord__edit-input ord__edit-input--desc"
               value="${esc(item.description || '')}" placeholder="Item description"
               spellcheck="false" autocomplete="off">
        ${pdfDescHint}
      </td>
      <td>
        <input type="number" name="qtyReq_${idx}" class="form__input ord__edit-input ord__edit-input--qty"
               value="${esc(String(qtyReq))}" placeholder="—" min="0" step="1">
      </td>
      <td>
        <input type="number" name="qtyReqd_${idx}" class="form__input ord__edit-input ord__edit-input--qty"
               value="${esc(String(qtyReqd))}" placeholder="--" min="0" step="1">
      </td>
      <td>
        <input type="number" name="qtyRecv_${idx}" class="form__input ord__edit-input ord__edit-input--qty"
               value="${esc(String(qtyRecv))}" placeholder="--" min="0" step="1">
      </td>
      <td class="ord__edit-col-ims">${imsBadge}</td>
      <td>
        <button type="button" class="btn btn--ghost btn--sm ord__edit-del"
                data-action="delete-row" title="Remove row" aria-label="Remove row">✕</button>
      </td>
    </tr>
  `;
}

function _readEditForm(form, originalOrder, tbody) {
  const fd = new FormData(form);

  const dateRaw = String(fd.get('dateRaw') || '').trim();

  // Read items from tbody rows
  const rows  = Array.from(tbody.querySelectorAll('tr'));
  const items = rows.map((row, i) => {
    const nsn   = String(row.querySelector(`[name^="nsn_"]`)?.value || '').trim();
    const desc  = String(row.querySelector(`[name^="desc_"]`)?.value || '').trim();
    const qReq  = row.querySelector(`[name^="qtyReq_"]`)?.value;
    const qReqd = row.querySelector(`[name^="qtyReqd_"]`)?.value;
    const qRecv = row.querySelector(`[name^="qtyRecv_"]`)?.value;
    // Strip transient import-time fields (_imsMatch, _imsDescChanged, _pdfDesc)
    // — these are display hints only and must not be persisted.
    return {
      nsn:              nsn || null,
      description:      desc,
      qtyRequired:      qReq  !== '' && qReq  != null ? Number(qReq)  : null,
      qtyRequisitioned: qReqd !== '' && qReqd != null ? Number(qReqd) : null,
      qtyReceived:      qRecv !== '' && qRecv != null ? Number(qRecv) : null,
    };
  }).filter(item => item.nsn || item.description); // drop fully blank rows

  return {
    ...originalOrder,
    orderId:        String(fd.get('orderId')       || '').trim(),
    orderCategory:  String(fd.get('orderCategory') || 'general'),
    docType:        String(fd.get('docType')       || 'request'),
    orderStatus:    String(fd.get('orderStatus')   || '').trim(),
    dateRaw,
    date:           _parseDateRaw(dateRaw) || originalOrder.date || '',
    requestorRank:  String(fd.get('requestorRank')  || '').trim(),
    requestorName:  String(fd.get('requestorName')  || '').trim(),
    requestorSvcNo: String(fd.get('requestorSvcNo') || '').trim(),
    unit:           String(fd.get('unit')            || '').trim(),
    items,
  };
}

// Simple date parser matching order-parser.js logic
const _MONTH_MAP = {
  jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06',
  jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12',
};
function _parseDateRaw(raw) {
  const m = raw.match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
  if (!m) return '';
  const [, dd, mon, yyyy] = m;
  const mm = _MONTH_MAP[mon.toLowerCase()] || '01';
  return `${yyyy}-${mm}-${dd.padStart(2, '0')}`;
}

// ── Detail view ───────────────────────────────────────────────────────────────

async function _openDetail(id) {
  const order = await Storage.orders.get(id);
  if (!order) return;
  await _renderDetail(order);
}

async function _renderDetail(order) {
  if (!_root) return;

  const canApprove = AUTH.isCO() || AUTH.can('editItem');
  const isIssue    = order.docType === 'issue';
  const isReceived = order.status === 'received';

  const imsItems = await Storage.items.list();
  const nsnMap   = new Map(imsItems.map(i => [i.nsn, i]));
  const requestor = [order.requestorRank, order.requestorName].filter(Boolean).join(' ') || '—';

  render(_root, `
    <div class="orders">
      <div class="orders__header">
        <button type="button" class="btn btn--ghost orders__back" data-action="back">
          ← Back to Orders
        </button>
        <div class="orders__header-actions">
          <button type="button" class="btn btn--ghost" data-action="edit-order"
                  title="Edit order fields and items">Edit</button>
          <button type="button" class="btn btn--ghost" data-action="export-csv"
                  title="Export as CSV">Export CSV</button>
          ${canApprove && isIssue && !isReceived ? `
            <button type="button" class="btn btn--primary" data-action="approve-receive">
              Approve &amp; Receive into IMS
            </button>
          ` : ''}
          ${isReceived ? `<span class="ord__badge ord__badge--received">Received into IMS</span>` : ''}
          <button type="button" class="btn btn--danger-ghost" data-action="delete-order"
                  title="Delete order record">Delete</button>
        </div>
      </div>

      <div class="orders__detail">
        <div class="orders__detail-meta">
          <h2 class="orders__detail-title">
            Order #${esc(order.orderId)}
            ${_typeBadge(order.docType)} ${_statusBadge(order)}
            <span class="ord__badge ord__badge--cat">${esc(_catLabel(order.orderCategory))}</span>
          </h2>
          <dl class="orders__detail-fields">
            <div class="orders__detail-field">
              <dt>AAC Status</dt><dd>${esc(order.orderStatus || '—')}</dd>
            </div>
            <div class="orders__detail-field">
              <dt>Date</dt><dd>${esc(order.dateRaw || order.date || '—')}</dd>
            </div>
            <div class="orders__detail-field">
              <dt>Requestor</dt><dd>${esc(requestor)}</dd>
            </div>
            ${order.requestorSvcNo ? `
              <div class="orders__detail-field">
                <dt>Svc No</dt><dd>${esc(order.requestorSvcNo)}</dd>
              </div>
            ` : ''}
            <div class="orders__detail-field">
              <dt>Unit</dt><dd>${esc(order.unit || '—')}</dd>
            </div>
            ${order.approvedBy ? `
              <div class="orders__detail-field">
                <dt>Received by</dt>
                <dd>${esc(order.approvedBy)} on ${esc(order.approvedAt?.slice(0, 10) || '')}</dd>
              </div>
            ` : ''}
          </dl>
          ${order.notes ? `<div class="orders__notes">${esc(order.notes)}</div>` : ''}
        </div>

        <div class="orders__items-section">
          <h3 class="orders__items-heading">
            Items <span class="orders__items-count">${order.items.length}</span>
          </h3>
          ${order.items.length === 0 ? `
            <p class="orders__items-empty">No items — click <strong>Edit</strong> to add them.</p>
          ` : `
            <div class="orders__table-wrap">
              <table class="orders__table">
                <thead>
                  <tr>
                    <th>NSN</th>
                    <th>Description</th>
                    <th class="orders__col-num">Qty Req</th>
                    <th class="orders__col-num">Qty Req'd</th>
                    <th class="orders__col-num">Qty Recv'd</th>
                    <th>IMS</th>
                  </tr>
                </thead>
                <tbody>
                  ${order.items.map(item => _itemRowHtml(item, nsnMap)).join('')}
                </tbody>
              </table>
            </div>
          `}
        </div>
      </div>
    </div>
  `);

  $('[data-action="back"]', _root)?.addEventListener('click', () => _renderList());
  $('[data-action="edit-order"]', _root)?.addEventListener('click', () => _renderEdit(order, { isNew: false }));
  $('[data-action="export-csv"]', _root)?.addEventListener('click', () => _exportCsv(order, imsItems));
  $('[data-action="approve-receive"]', _root)?.addEventListener('click', () => _openApproveModal(order, nsnMap));
  $('[data-action="delete-order"]', _root)?.addEventListener('click', () => _deleteOrder(order));
}

function _itemRowHtml(item, nsnMap) {
  const imsMatch = item.nsn ? nsnMap.get(item.nsn) : null;

  // Show description mismatch as a tooltip hint on the IMS badge.
  const descMismatch = imsMatch && imsMatch.name && imsMatch.name !== item.description;
  const imsStatus = !item.nsn
    ? `<span class="ord__ims-status ord__ims--no-nsn"
             title="No NSN — this item cannot be matched to IMS automatically">No NSN</span>`
    : imsMatch
      ? `<span class="ord__ims-status ord__ims--found"
               title="IMS name: ${esc(imsMatch.name || '')}${descMismatch ? ' (differs from order description)' : ''}">
               In IMS${descMismatch ? ' ⚠' : ''}</span>`
      : `<span class="ord__ims-status ord__ims--new"
               title="NSN not in IMS — will be created as a new item if received">New</span>`;

  const qtyR  = item.qtyRequired      != null ? item.qtyRequired      : '—';
  const qtyQ  = item.qtyRequisitioned != null ? item.qtyRequisitioned : '--';
  const qtyRx = item.qtyReceived      != null ? item.qtyReceived      : '--';

  return `
    <tr class="${imsMatch ? '' : item.nsn ? 'orders__row--new' : ''}">
      <td class="orders__cell-nsn">${esc(item.nsn || '—')}</td>
      <td>${esc(item.description || '—')}</td>
      <td class="orders__col-num">${esc(String(qtyR))}</td>
      <td class="orders__col-num">${esc(String(qtyQ))}</td>
      <td class="orders__col-num">${esc(String(qtyRx))}</td>
      <td>${imsStatus}</td>
    </tr>
  `;
}

// ── CSV export ────────────────────────────────────────────────────────────────

function _exportCsv(order, imsItems) {
  const csv  = orderToCsv(order, imsItems);
  const name = `order-${order.orderId || 'unknown'}-${order.date || 'nodate'}.csv`;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
}

// ── Approve & Receive modal ───────────────────────────────────────────────────

function _openApproveModal(order, nsnMap) {
  const matchedItems = order.items.filter(i => i.nsn && nsnMap.has(i.nsn));
  const newItems     = order.items.filter(i => i.nsn && !nsnMap.has(i.nsn));
  const noNsnItems   = order.items.filter(i => !i.nsn);

  openModal({
    titleHtml: 'Approve &amp; Receive into IMS',
    size:      'lg',
    bodyHtml: `
      <div class="modal__body ord__approve-body">
        <p>This will update your IMS inventory based on the items in Order
           <strong>#${esc(order.orderId)}</strong>.</p>

        <div class="ord__approve-note">
          <strong>Check quantities before confirming.</strong>
          Each row shows the quantity from the order — adjust if the actual delivery
          was different. <strong>Set to 0 to skip an item</strong> (it won't be added
          to your IMS). Once you click Confirm this cannot be undone automatically —
          inventory counts will be updated immediately.
        </div>

        ${matchedItems.length ? `
          <h4 class="ord__approve-heading ord__approve-heading--found">
            ${matchedItems.length} item${matchedItems.length !== 1 ? 's' : ''} found in IMS
            <span class="ord__approve-sub">— onHand (serviceable) will be increased</span>
          </h4>
          <table class="orders__table orders__table--compact">
            <thead><tr>
              <th>NSN</th><th>Description</th>
              <th class="orders__col-num">Ordered</th>
              <th class="orders__col-num">Qty to receive</th>
              <th>IMS Name</th>
              <th class="orders__col-num">Current onHand</th>
            </tr></thead>
            <tbody>
              ${matchedItems.map(item => {
                const imsItem = nsnMap.get(item.nsn);
                const dflt    = item.qtyReceived ?? item.qtyRequired ?? 0;
                return `<tr>
                  <td>${esc(item.nsn)}</td>
                  <td>${esc(item.description)}</td>
                  <td class="orders__col-num">${esc(String(item.qtyRequired ?? '—'))}</td>
                  <td class="orders__col-num">
                    <input type="number" class="form__input ord__rcv-qty"
                           data-nsn="${esc(item.nsn)}" data-new="0"
                           value="${dflt}" min="0" step="1"
                           style="width:70px;text-align:right">
                  </td>
                  <td>${esc(imsItem?.name || '—')}</td>
                  <td class="orders__col-num">${esc(String(imsItem?.onHand ?? '—'))}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        ` : ''}

        ${newItems.length ? `
          <h4 class="ord__approve-heading ord__approve-heading--new">
            ${newItems.length} new item${newItems.length !== 1 ? 's' : ''} (not in IMS)
            <span class="ord__approve-sub">— will be created with the specified quantity</span>
          </h4>
          <table class="orders__table orders__table--compact">
            <thead><tr>
              <th>NSN</th><th>Description</th>
              <th class="orders__col-num">Ordered</th>
              <th class="orders__col-num">Qty to receive</th>
            </tr></thead>
            <tbody>
              ${newItems.map(item => {
                const dflt = item.qtyReceived ?? item.qtyRequired ?? 0;
                return `<tr>
                  <td>${esc(item.nsn)}</td>
                  <td>${esc(item.description)}</td>
                  <td class="orders__col-num">${esc(String(item.qtyRequired ?? '—'))}</td>
                  <td class="orders__col-num">
                    <input type="number" class="form__input ord__rcv-qty"
                           data-nsn="${esc(item.nsn)}" data-new="1"
                           value="${dflt}" min="0" step="1"
                           style="width:70px;text-align:right">
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
          <label class="ord__approve-cat-label">
            Category for new items:
            <select name="newItemCat" class="form__select ord__approve-cat-sel">
              <option value="equipment">Equipment</option>
              <option value="clothing" ${order.orderCategory === 'uniform' ? 'selected' : ''}>Clothing / Uniform</option>
              <option value="consumable">Consumable</option>
              <option value="other">Other</option>
            </select>
          </label>
        ` : ''}

        ${noNsnItems.length ? `
          <p class="ord__approve-warn">
            ⚠ ${noNsnItems.length} item${noNsnItems.length !== 1 ? 's' : ''} without NSN will be skipped.
          </p>
        ` : ''}

        <div class="ord__approve-notes">
          <label>QM Notes (optional)
            <textarea class="form__input ord__notes-input" name="approveNotes" rows="2"
                      placeholder="e.g. Items received from Townsville warehouse…"></textarea>
          </label>
        </div>
        <div class="form__error ord__approve-err" role="alert"></div>
      </div>
      <div class="form__actions">
        <button type="button" class="btn btn--ghost" data-action="modal-close">Cancel</button>
        <button type="button" class="btn btn--primary" data-action="confirm-approve">
          Confirm &amp; Update IMS
        </button>
      </div>
    `,
    async onMount(panel, close) {
      const confirmBtn = $('[data-action="confirm-approve"]', panel);
      const errEl      = $('.ord__approve-err', panel);
      const catSel     = $('select[name="newItemCat"]', panel);
      const notesTa    = $('[name="approveNotes"]', panel);

      confirmBtn?.addEventListener('click', async () => {
        if (confirmBtn.disabled) return;
        confirmBtn.disabled = true;
        if (errEl) errEl.textContent = '';
        try {
          // Build a map of nsn → qty to receive from the editable inputs.
          const qtyMap = new Map();
          panel.querySelectorAll('.ord__rcv-qty').forEach((input) => {
            const nsn = input.dataset.nsn;
            const qty = Math.max(0, parseInt(input.value, 10) || 0);
            if (nsn) qtyMap.set(nsn, qty);
          });
          const newItemCat = catSel?.value || 'equipment';
          const notes      = notesTa?.value?.trim() || '';
          await _doApprove(order, nsnMap, newItemCat, notes, qtyMap);
          close();
          const updated = await Storage.orders.get(order.id);
          if (updated) await _renderDetail(updated);
        } catch (err) {
          if (errEl) errEl.textContent = err.message || 'Update failed.';
          confirmBtn.disabled = false;
        }
      });
    },
  });
}

// ── Approve: update IMS inventory ────────────────────────────────────────────

async function _doApprove(order, nsnMap, newItemCat, notes, qtyMap = new Map()) {
  const session  = AUTH.getSession();
  const userName = session?.name || 'QM';
  const now      = new Date().toISOString();

  for (const orderItem of order.items.filter(i => i.nsn)) {
    // Use the qty from the modal's editable input; fall back to qtyRequired.
    const qty = qtyMap.has(orderItem.nsn)
      ? Math.max(0, qtyMap.get(orderItem.nsn))
      : Math.max(0, orderItem.qtyRequired || 0);
    if (qty === 0) continue;   // user set to 0 → skip this line
    const existing = nsnMap.get(orderItem.nsn);

    if (existing) {
      const updated = { ...existing, onHand: (existing.onHand || 0) + qty, updatedAt: now };
      if (updated.qtyServiceable != null) updated.qtyServiceable = (updated.qtyServiceable || 0) + qty;
      await Storage.items.put(updated);
    } else {
      await Storage.items.put({
        id:               `item-${_uuid()}`,
        nsn:              orderItem.nsn,
        name:             orderItem.description || `NSN ${orderItem.nsn}`,
        cat:              newItemCat,
        onHand:           qty,
        unsvc:            0,
        writtenOff:       0,
        condition:        'serviceable',
        qtyServiceable:   qty,
        qtyUnserviceable: 0,
        qtyRepair:        0,
        qtyCalibrationDue:0,
        qtyWrittenOff:    0,
        source:           'aac-order',
        sourceOrderId:    order.orderId,
        createdAt:        now,
        updatedAt:        now,
      });
    }
  }

  const itemsProcessed = order.items.filter(i => i.nsn);
  const newCount       = itemsProcessed.filter(i => !nsnMap.has(i.nsn)).length;

  await Storage.orders.put({
    ...order,
    status:     'received',
    approvedAt: now,
    approvedBy: userName,
    notes:      notes || order.notes || '',
  });

  await Storage.audit.append({
    action: 'order-received',
    user:   userName,
    desc:   `Order #${order.orderId} received — ${itemsProcessed.length} items processed, ${newCount} new items created`,
  });
}

// ── Delete order ──────────────────────────────────────────────────────────────

function _deleteOrder(order) {
  openModal({
    titleHtml: 'Delete Order',
    size:      'sm',
    bodyHtml:  `
      <p class="modal__body">
        Delete order <strong>#${esc(order.orderId)}</strong>? This removes the import record only —
        any inventory changes already applied are <strong>not</strong> reversed.
      </p>
      <div class="form__actions">
        <button type="button" class="btn btn--ghost" data-action="modal-close">Cancel</button>
        <button type="button" class="btn btn--danger" data-action="confirm-delete">Delete</button>
      </div>
    `,
    async onMount(panel, close) {
      $('[data-action="confirm-delete"]', panel)?.addEventListener('click', async () => {
        await Storage.orders.delete(order.id);
        await Storage.audit.append({
          action: 'order-delete',
          user:   AUTH.getSession()?.name || '',
          desc:   `Deleted order record #${order.orderId}`,
        });
        close();
        await _renderList();
      });
    },
  });
}
