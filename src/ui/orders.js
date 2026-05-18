// =============================================================================
// QStore IMS v2 — AAC QStore Orders page
// =============================================================================
// Tracks supply orders imported from AAC QStore PDF documents.
//
// Workflow:
//   1. QM imports a PDF order → parsed → stored in IndexedDB
//   2. Orders list shows all imported orders with status badges
//   3. For REQUEST orders: view items, export CSV
//   4. For ISSUE orders: QM/OC can "Approve & Receive" which:
//        - Matches items by NSN against IMS inventory
//        - Updates onHand qty for existing items
//        - Creates new items for unknown NSNs
//        - Writes an audit entry
//        - Marks order status → "received"
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

// ── Module state ─────────────────────────────────────────────────────────────

let _root       = null;
let _unmount    = null;
let _view       = 'list';    // 'list' | 'detail'
let _orderId    = null;      // PK of the order currently open
let _importing  = false;

// ── Mount / Unmount ───────────────────────────────────────────────────────────

export async function mount(rootEl) {
  _root    = rootEl;
  _view    = 'list';
  _orderId = null;
  await _renderList();
  return _cleanup;
}

function _cleanup() {
  _root = null;
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

  // Wire import file input
  const fileInput = $('input[data-action="import-pdf"]', _root);
  fileInput?.addEventListener('change', _onImportFile);

  // Allow keyboard activation of the label
  const importLabel = $('.orders__import-btn', _root);
  importLabel?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput?.click(); }
  });

  // Wire row clicks → detail view
  _root.addEventListener('click', _onListClick);
}

function _orderRowHtml(order) {
  const badge     = _statusBadge(order);
  const typeBadge = _typeBadge(order.docType);
  const catLabel  = _catLabel(order.orderCategory);
  const dateStr   = order.dateRaw || order.date || '—';
  const requestor = [order.requestorRank, order.requestorName].filter(Boolean).join(' ') || '—';
  const itemCount = order.items?.length ?? 0;

  return `
    <div class="orders__row" data-order-id="${esc(order.id)}" role="button" tabindex="0"
         aria-label="Order ${esc(order.orderId)} — ${esc(order.orderStatus)}">
      <div class="orders__row-meta">
        <span class="orders__row-id">Order #${esc(order.orderId)}</span>
        ${typeBadge}
        ${badge}
        <span class="orders__row-cat">${esc(catLabel)}</span>
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

function _onListClick(e) {
  // Row click → open detail
  const row = e.target.closest('[data-order-id]');
  if (row) { _openDetail(row.dataset.orderId); return; }
}

// ── Import PDF ────────────────────────────────────────────────────────────────

async function _onImportFile(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  // Reset input so same file can be re-imported if needed
  e.target.value = '';

  const errEl = $('.orders__parse-error', _root);
  if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }

  if (_importing) return;
  _importing = true;

  const importBtn = $('.orders__import-btn', _root);
  if (importBtn) importBtn.classList.add('btn--loading');

  try {
    const buf    = await file.arrayBuffer();
    const parsed = await parseOrderPdf(buf);

    if (!parsed.orderId && parsed.items.length === 0) {
      throw new Error('Could not extract order data from this PDF. Is it an AAC QStore order?');
    }

    // Check for duplicate (same orderId already imported)
    const existing = await Storage.orders.list();
    const dup = existing.find(o => o.orderId === parsed.orderId && parsed.orderId);
    if (dup) {
      const proceed = await _confirmDuplicate(parsed.orderId);
      if (!proceed) { _importing = false; if (importBtn) importBtn.classList.remove('btn--loading'); return; }
    }

    const order = {
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

    await Storage.orders.put(order);
    await Storage.audit.append({
      action: 'order-import',
      user:   AUTH.getSession()?.name || '',
      desc:   `Imported AAC QStore order #${order.orderId} (${order.docType}, ${order.items.length} items)`,
    });

    // Navigate to the newly imported order detail
    _orderId = order.id;
    await _renderDetail(order);

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

function _confirmDuplicate(orderId) {
  return new Promise(resolve => {
    openModal({
      titleHtml: 'Duplicate Order',
      size: 'sm',
      bodyHtml: `
        <p class="modal__body">
          Order <strong>#${esc(orderId)}</strong> has already been imported.
          Do you want to import it again as a separate record?
        </p>
        <div class="form__actions">
          <button type="button" class="btn btn--ghost" data-action="modal-close">Cancel</button>
          <button type="button" class="btn btn--primary" data-action="confirm-dup">Import Again</button>
        </div>
      `,
      onMount(panel, close) {
        $('[data-action="confirm-dup"]', panel)?.addEventListener('click', () => { close(); resolve(true); });
        $('[data-action="modal-close"]', panel)?.addEventListener('click', () => { close(); resolve(false); });
      },
    });
  });
}

// ── Detail view ───────────────────────────────────────────────────────────────

async function _openDetail(id) {
  const order = await Storage.orders.get(id);
  if (!order) return;
  _orderId = id;
  _view    = 'detail';
  await _renderDetail(order);
}

async function _renderDetail(order) {
  if (!_root) return;

  const session = AUTH.getSession();
  const canApprove = AUTH.isCO() || AUTH.can('editItem');
  const isIssue    = order.docType === 'issue';
  const isReceived = order.status === 'received';

  // Match IMS items by NSN for display
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
          <button type="button" class="btn btn--ghost" data-action="export-csv"
                  title="Export order as CSV">Export CSV</button>
          ${canApprove && isIssue && !isReceived ? `
            <button type="button" class="btn btn--primary" data-action="approve-receive">
              Approve &amp; Receive into IMS
            </button>
          ` : ''}
          ${isReceived ? `<span class="ord__badge ord__badge--received">Received into IMS</span>` : ''}
          <button type="button" class="btn btn--danger-ghost orders__delete"
                  data-action="delete-order" title="Delete this order record">Delete</button>
        </div>
      </div>

      <div class="orders__detail">
        <div class="orders__detail-meta">
          <h2 class="orders__detail-title">
            Order #${esc(order.orderId)}
            ${_typeBadge(order.docType)}
            ${_statusBadge(order)}
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
                <dt>Received by</dt><dd>${esc(order.approvedBy)} on ${esc(order.approvedAt?.slice(0, 10) || '')}</dd>
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
            <p class="orders__items-empty">No items were extracted from this order PDF.</p>
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

  // Wire actions
  $('[data-action="back"]', _root)?.addEventListener('click', () => {
    _view = 'list';
    _renderList();
  });
  $('[data-action="export-csv"]', _root)?.addEventListener('click', () => _exportCsv(order, imsItems));
  $('[data-action="approve-receive"]', _root)?.addEventListener('click', () => _openApproveModal(order, nsnMap));
  $('[data-action="delete-order"]', _root)?.addEventListener('click', () => _deleteOrder(order));
}

function _itemRowHtml(item, nsnMap) {
  const imsMatch  = item.nsn ? nsnMap.get(item.nsn) : null;
  const imsStatus = !item.nsn
    ? `<span class="ord__ims-status ord__ims--no-nsn">No NSN</span>`
    : imsMatch
      ? `<span class="ord__ims-status ord__ims--found" title="${esc(imsMatch.name || '')}">In IMS</span>`
      : `<span class="ord__ims-status ord__ims--new">New</span>`;

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
  const csv      = orderToCsv(order, imsItems);
  const filename = `order-${order.orderId || 'unknown'}-${order.date || 'nodate'}.csv`;
  const blob     = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url      = URL.createObjectURL(blob);
  const a        = document.createElement('a');
  a.href         = url;
  a.download     = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
}

// ── Approve & Receive modal ───────────────────────────────────────────────────

function _openApproveModal(order, nsnMap) {
  const matchedItems  = order.items.filter(i => i.nsn && nsnMap.has(i.nsn));
  const newItems      = order.items.filter(i => i.nsn && !nsnMap.has(i.nsn));
  const noNsnItems    = order.items.filter(i => !i.nsn);

  openModal({
    titleHtml: 'Approve &amp; Receive into IMS',
    size:      'lg',
    bodyHtml: `
      <div class="modal__body ord__approve-body">
        <p>This will update your IMS inventory based on the items in Order
           <strong>#${esc(order.orderId)}</strong>.</p>

        ${matchedItems.length ? `
          <h4 class="ord__approve-heading ord__approve-heading--found">
            ${matchedItems.length} item${matchedItems.length !== 1 ? 's' : ''} found in IMS
            <span class="ord__approve-sub">— onHand qty will be increased</span>
          </h4>
          <table class="orders__table orders__table--compact">
            <thead><tr><th>NSN</th><th>Description</th><th>Qty</th><th>IMS Name</th><th>Current onHand</th></tr></thead>
            <tbody>
              ${matchedItems.map(item => {
                const imsItem = nsnMap.get(item.nsn);
                return `<tr>
                  <td>${esc(item.nsn)}</td>
                  <td>${esc(item.description)}</td>
                  <td>${esc(String(item.qtyRequired ?? '?'))}</td>
                  <td>${esc(imsItem?.name || '—')}</td>
                  <td>${esc(String(imsItem?.onHand ?? '—'))}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        ` : ''}

        ${newItems.length ? `
          <h4 class="ord__approve-heading ord__approve-heading--new">
            ${newItems.length} new item${newItems.length !== 1 ? 's' : ''} (not in IMS)
            <span class="ord__approve-sub">— will be created as new inventory items</span>
          </h4>
          <table class="orders__table orders__table--compact">
            <thead><tr><th>NSN</th><th>Description</th><th>Qty</th></tr></thead>
            <tbody>
              ${newItems.map(item => `<tr>
                <td>${esc(item.nsn)}</td>
                <td>${esc(item.description)}</td>
                <td>${esc(String(item.qtyRequired ?? '?'))}</td>
              </tr>`).join('')}
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
            ⚠ ${noNsnItems.length} item${noNsnItems.length !== 1 ? 's' : ''} without an NSN
            will be skipped (cannot match to IMS without NSN).
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
          const newItemCat = catSel?.value || 'equipment';
          const notes      = notesTa?.value?.trim() || '';
          await _doApprove(order, nsnMap, newItemCat, notes);
          close();
          // Re-render detail with updated order
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

async function _doApprove(order, nsnMap, newItemCat, notes) {
  const session  = AUTH.getSession();
  const userName = session?.name || 'QM';
  const now      = new Date().toISOString();
  const itemsToProcess = order.items.filter(i => i.nsn);

  for (const orderItem of itemsToProcess) {
    const qty       = Math.max(0, orderItem.qtyRequired || 0);
    const existsIms = nsnMap.get(orderItem.nsn);

    if (existsIms) {
      // Update existing — increment onHand
      const updated = {
        ...existsIms,
        onHand:    (existsIms.onHand || 0) + qty,
        updatedAt: now,
      };
      // Adjust serviceability breakdown if present
      if (updated.qtyServiceable != null) {
        updated.qtyServiceable = (updated.qtyServiceable || 0) + qty;
      }
      await Storage.items.put(updated);
    } else {
      // Create new item
      const newItem = {
        id:            `item-${_uuid()}`,
        nsn:           orderItem.nsn,
        name:          orderItem.description || `NSN ${orderItem.nsn}`,
        cat:           newItemCat,
        onHand:        qty,
        unsvc:         0,
        writtenOff:    0,
        condition:     'serviceable',
        qtyServiceable: qty,
        qtyUnserviceable: 0,
        qtyRepair:     0,
        qtyCalibrationDue: 0,
        qtyWrittenOff: 0,
        source:        'aac-order',
        sourceOrderId: order.orderId,
        createdAt:     now,
        updatedAt:     now,
      };
      await Storage.items.put(newItem);
    }
  }

  // Update order record
  const updatedOrder = {
    ...order,
    status:     'received',
    approvedAt: now,
    approvedBy: userName,
    notes:      notes || order.notes || '',
  };
  await Storage.orders.put(updatedOrder);

  // Audit entry
  await Storage.audit.append({
    action: 'order-received',
    user:   userName,
    desc:   `Order #${order.orderId} received — ${itemsToProcess.length} items processed, ` +
            `${itemsToProcess.filter(i => !nsnMap.has(i.nsn)).length} new items created`,
  });
}

// ── Delete order ──────────────────────────────────────────────────────────────

function _deleteOrder(order) {
  openModal({
    titleHtml: 'Delete Order',
    size:      'sm',
    bodyHtml:  `
      <p class="modal__body">
        Delete order <strong>#${esc(order.orderId)}</strong>? This removes the import record
        from QStore IMS. It does <strong>not</strong> reverse any inventory changes
        already applied.
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
        _view = 'list';
        await _renderList();
      });
    },
  });
}
