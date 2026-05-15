// =============================================================================
// QStore IMS v2 — Issue Kits UI
// =============================================================================
// Two public entry points:
//   openKitManager() — CRUD modal for QM+ to create/edit/delete kits
//   openKitPicker(onSelect) — selection modal for the Loans issue tab
//
// Kit schema: { id, name, description, lines: [{itemId, qty}], createdAt, updatedAt }
// Item names are resolved at use-time from the live items store, not stored
// in the kit, so renaming an item is reflected immediately in all kits.
// =============================================================================

import * as Storage from '../storage.js';
import * as AUTH    from '../auth.js';
import { openModal } from './modal.js';
import { showToast } from './toast.js';
import { esc, $, $$, render } from './util.js';

// -----------------------------------------------------------------------------
// Kit manager — list + add/edit/delete
// -----------------------------------------------------------------------------

export async function openKitManager() {
  AUTH.requirePermission('editItem');

  const handle = openModal({
    titleHtml: 'Issue Kits',
    size:      'lg',
    bodyHtml:  '<div class="kit__manager-body"><p>Loading…</p></div>',
    onMount(panel, close) {
      _renderManager(panel, close);
    },
  });
  return handle;
}

async function _renderManager(panel, close) {
  const [kits, items] = await Promise.all([
    Storage.kits.list(),
    Storage.items.list(),
  ]);
  kits.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  const body = $('.kit__manager-body', panel);
  if (!body) return;

  body.innerHTML = `
    <div class="kit__manager">
      <div class="kit__manager-toolbar">
        <button type="button" class="btn btn--primary btn--sm" data-action="kit-add">
          + New kit
        </button>
      </div>
      ${kits.length === 0
        ? `<p class="kit__empty">No kits yet. Create one to speed up batch issue.</p>`
        : `<ul class="kit__list">
            ${kits.map((k) => _kitItemHtml(k, items)).join('')}
           </ul>`
      }
    </div>
  `;

  body.addEventListener('click', async (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    const kitId = e.target.closest('[data-kit-id]')?.dataset.kitId;

    if (action === 'kit-add') {
      await _openKitForm({ mode: 'add', items, onSaved: () => _renderManager(panel, close) });
    } else if (action === 'kit-edit' && kitId) {
      const kit = await Storage.kits.get(kitId);
      if (kit) await _openKitForm({ mode: 'edit', kit, items, onSaved: () => _renderManager(panel, close) });
    } else if (action === 'kit-delete' && kitId) {
      await _confirmDeleteKit(kitId, () => _renderManager(panel, close));
    }
  });
}

function _kitItemHtml(kit, items) {
  const count = (kit.lines || []).length;
  const preview = (kit.lines || [])
    .slice(0, 3)
    .map((l) => {
      const item = items.find((i) => i.id === l.itemId);
      return item ? `${esc(item.name)} ×${l.qty}` : `<em>Unknown item</em> ×${l.qty}`;
    })
    .join(', ');
  const more = count > 3 ? ` <span class="kit__preview-more">+${count - 3} more</span>` : '';

  return `
    <li class="kit__item" data-kit-id="${esc(kit.id)}">
      <div class="kit__item-info">
        <div class="kit__item-name">${esc(kit.name)}</div>
        ${kit.description ? `<div class="kit__item-desc">${esc(kit.description)}</div>` : ''}
        <div class="kit__item-preview">${preview}${more}</div>
      </div>
      <div class="kit__item-actions">
        <button type="button" class="btn btn--sm btn--ghost" data-action="kit-edit">Edit</button>
        <button type="button" class="btn btn--sm btn--danger" data-action="kit-delete">Delete</button>
      </div>
    </li>
  `;
}

async function _confirmDeleteKit(kitId, onDeleted) {
  const kit = await Storage.kits.get(kitId);
  if (!kit) return;
  const handle = openModal({
    titleHtml: 'Delete kit',
    size: 'sm',
    bodyHtml: `
      <p>Delete <strong>${esc(kit.name)}</strong>?</p>
      <p class="modal__body--small">This only removes the kit template — existing loans are unaffected.</p>
      <div class="form__actions">
        <button type="button" class="btn btn--ghost" data-action="modal-close">Cancel</button>
        <button type="button" class="btn btn--danger" data-action="confirm-delete">Delete</button>
      </div>
    `,
    onMount(panel, close) {
      $('[data-action="confirm-delete"]', panel).addEventListener('click', async () => {
        await Storage.kits.delete(kitId);
        close();
        onDeleted();
      });
    },
  });
  return handle;
}

// -----------------------------------------------------------------------------
// Kit form — create or edit
// -----------------------------------------------------------------------------

async function _openKitForm({ mode, kit, items, onSaved }) {
  const isEdit = mode === 'edit';
  const initial = isEdit ? kit : { id: _kitId(), name: '', description: '', lines: [{ itemId: '', qty: 1 }], createdAt: new Date().toISOString() };

  // Working copy of lines so edits don't touch the original until save.
  let lines = (initial.lines || [{ itemId: '', qty: 1 }]).map((l) => ({ ...l }));
  if (lines.length === 0) lines = [{ itemId: '', qty: 1 }];

  const handle = openModal({
    titleHtml: isEdit ? `Edit kit — ${esc(initial.name)}` : 'New kit',
    size: 'lg',
    onMount(panel, close) {
      _renderKitForm(panel, close, { isEdit, initial, lines, items, onSaved });
    },
  });
  return handle;
}

function _renderKitForm(panel, close, { isEdit, initial, lines, items, onSaved }) {
  panel.innerHTML = `
    <div class="kit__form">
      <div class="form__row">
        <label class="form__field form__field--grow">
          <span class="form__label">Kit name <abbr title="Required">*</abbr></span>
          <input type="text" name="kitName" maxlength="80" required
                 value="${esc(initial.name || '')}"
                 placeholder="e.g. Initial Issue — Male Cadet">
        </label>
      </div>
      <label class="form__field">
        <span class="form__label">Description</span>
        <input type="text" name="kitDesc" maxlength="160"
               value="${esc(initial.description || '')}"
               placeholder="optional">
      </label>

      <h4 class="kit__form-heading">Items</h4>
      <datalist id="kit-items-list">
        ${items.map((i) => `<option value="${esc(`${i.name} (${i.nsn || 'no NSN'})`)}">`).join('')}
      </datalist>
      <div class="kit__form-lines" data-kit-lines>
        ${lines.map((l, i) => _kitLineHtml(l, i, items)).join('')}
      </div>
      <button type="button" class="btn btn--ghost btn--sm" data-action="kit-line-add">
        + Add item
      </button>

      <div class="form__error" data-kit-error role="alert"></div>
      <div class="form__actions">
        <button type="button" class="btn btn--ghost" data-action="modal-close">Cancel</button>
        <button type="button" class="btn btn--primary" data-action="kit-save">
          ${isEdit ? 'Save changes' : 'Create kit'}
        </button>
      </div>
    </div>
  `;

  _wireKitFormLines(panel, lines, items);

  $('[data-action="kit-save"]', panel).addEventListener('click', async () => {
    const errEl = $('[data-kit-error]', panel);
    errEl.textContent = '';
    try {
      const name = $('input[name="kitName"]', panel).value.trim();
      if (!name) throw new Error('Kit name is required.');
      const description = $('input[name="kitDesc"]', panel).value.trim();
      const validLines = lines.filter((l) => l.itemId);
      if (validLines.length === 0) throw new Error('Add at least one item.');

      const now = new Date().toISOString();
      await Storage.kits.put({
        id:          initial.id,
        name,
        description,
        lines:       validLines,
        createdAt:   initial.createdAt || now,
        updatedAt:   now,
      });
      close();
      onSaved();
      showToast(`Kit "${name}" ${isEdit ? 'updated' : 'created'}.`, 'success');
    } catch (err) {
      errEl.textContent = err.message || 'Could not save kit.';
    }
  });

  $('[data-action="kit-line-add"]', panel).addEventListener('click', () => {
    lines.push({ itemId: '', qty: 1 });
    _rerenderLines(panel, lines, items);
  });
}

function _kitLineHtml(line, index, items) {
  const item = line.itemId ? items.find((i) => i.id === line.itemId) : null;
  return `
    <div class="kit__form-line" data-kit-line-index="${index}">
      <label class="form__field form__field--grow">
        ${index === 0 ? '<span class="form__label">Item</span>' : ''}
        <input type="text" data-kit-line-search
               list="kit-items-list"
               value="${esc(item ? `${item.name} (${item.nsn || 'no NSN'})` : '')}"
               placeholder="Search items…"
               autocomplete="off">
        <input type="hidden" data-kit-line-id value="${esc(line.itemId || '')}">
      </label>
      <label class="form__field" style="flex:0 0 80px">
        ${index === 0 ? '<span class="form__label">Qty</span>' : ''}
        <input type="number" data-kit-line-qty min="1" step="1" inputmode="numeric"
               value="${line.qty || 1}">
      </label>
      <button type="button" class="btn btn--sm btn--ghost kit__line-remove"
              data-action="kit-line-remove"
              style="align-self:flex-end;margin-bottom:0"
              aria-label="Remove line">✕</button>
    </div>
  `;
}

function _rerenderLines(panel, lines, items) {
  const container = $('[data-kit-lines]', panel);
  if (!container) return;
  container.innerHTML = lines.map((l, i) => _kitLineHtml(l, i, items)).join('');
  _wireKitFormLines(panel, lines, items);
}

function _wireKitFormLines(panel, lines, items) {
  $$('[data-kit-line-index]', panel).forEach((lineEl) => {
    const idx    = Number(lineEl.dataset.kitLineIndex);
    const search = $('[data-kit-line-search]', lineEl);
    const hidden = $('[data-kit-line-id]', lineEl);
    const qty    = $('[data-kit-line-qty]', lineEl);
    const remove = $('[data-action="kit-line-remove"]', lineEl);

    search?.addEventListener('input', () => {
      const val = search.value;
      const match = items.find((i) => `${i.name} (${i.nsn || 'no NSN'})` === val);
      hidden.value = match ? match.id : '';
      lines[idx].itemId = match ? match.id : '';
    });

    qty?.addEventListener('input', () => {
      const n = parseInt(qty.value, 10);
      if (n > 0) lines[idx].qty = n;
    });

    remove?.addEventListener('click', () => {
      lines.splice(idx, 1);
      if (lines.length === 0) lines.push({ itemId: '', qty: 1 });
      _rerenderLines(panel, lines, items);
    });
  });
}

// -----------------------------------------------------------------------------
// Kit picker — for the Loans issue tab
// -----------------------------------------------------------------------------

/**
 * Open a kit selection modal. Calls onSelect(kit, items) when the user picks
 * one, where `items` is the full items list for name resolution.
 */
export async function openKitPicker(onSelect) {
  const [kits, items] = await Promise.all([
    Storage.kits.list(),
    Storage.items.list(),
  ]);
  kits.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  if (kits.length === 0) {
    showToast('No kits defined yet. Create one from the Inventory page.', 'info');
    return;
  }

  openModal({
    titleHtml: 'Load kit',
    size: 'md',
    bodyHtml: `
      <p class="kit__picker-hint">Select a kit to pre-fill the items list. You can adjust quantities before issuing.</p>
      <ul class="kit__picker-list">
        ${kits.map((k) => {
          const lineCount = (k.lines || []).length;
          const preview = (k.lines || [])
            .slice(0, 4)
            .map((l) => {
              const item = items.find((i) => i.id === l.itemId);
              return item ? `${esc(item.name)} ×${l.qty}` : null;
            })
            .filter(Boolean)
            .join(', ');
          const more = lineCount > 4 ? ` +${lineCount - 4} more` : '';
          return `
            <li>
              <button type="button" class="kit__picker-btn" data-action="kit-pick" data-kit-id="${esc(k.id)}">
                <span class="kit__picker-name">${esc(k.name)}</span>
                ${k.description ? `<span class="kit__picker-desc">${esc(k.description)}</span>` : ''}
                <span class="kit__picker-items">${preview}${more}</span>
              </button>
            </li>
          `;
        }).join('')}
      </ul>
    `,
    onMount(panel, close) {
      panel.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action="kit-pick"]');
        if (!btn) return;
        const kit = kits.find((k) => k.id === btn.dataset.kitId);
        if (kit) { close(); onSelect(kit, items); }
      });
    },
  });
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function _kitId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return 'kit-' + crypto.randomUUID();
  return 'kit-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
