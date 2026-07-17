// =============================================================================
// QStore IMS v3 — Staff page
// =============================================================================
// Manages the unit's staff establishment — officers, NCOs, and DAHs as a
// separate entity from cadets. Staff have a `position` (appointment) field
// in addition to rank. Both cadets and staff appear in the loans borrower
// picker; this page is for managing the staff records themselves.
//
// PERMISSION GATING
//   View: 'view' — anyone logged in can see the staff list
//   Add/edit/delete: 'manageStaff' — OC and QM only
//
// SCHEMA (per staff record)
//   svcNo      — primary key. AAC service number. Required, trimmed.
//   surname    — uppercased on save.
//   given      — given names, mixed case.
//   rank       — from STAFF_RANKS_CANONICAL (2LT-AAC … DAH). Free text accepted.
//   position   — appointment/role (OC, Training Officer, QM, RSM …). Free text.
//   company    — optional sub-unit assignment.
//   personType — always 'staff' on save.
//   active     — boolean.
//   email      — optional.
//   notes      — optional.
//
// AUDIT
//   add    → 'staff_add',    desc "Added staff: <rank> <surname> (<svcNo>)"
//   edit   → 'staff_update', desc "Updated staff: <rank> <surname> (<svcNo>)"
//   delete → 'staff_delete', desc "Deleted staff: <rank> <surname> (<svcNo>) — reason: <reason>"
// =============================================================================

import * as Storage from '../storage.js';
import * as AUTH    from '../auth.js';
import * as Sync    from '../sync.js';
import {
  STAFF_RANKS_CANONICAL,
  normalizeRank,
  compareRanks,
} from '../ranks.js';
import { openModal }                        from './modal.js';
import { esc, $, $$, render, fmtDateOnly }  from './util.js';
import { showToast }                        from './toast.js';

// -----------------------------------------------------------------------------
// Common staff appointments — offered as datalist suggestions
// -----------------------------------------------------------------------------

const STAFF_POSITIONS = [
  'OC', '2IC', 'Training Officer', 'QM', 'RSM', 'OIC Activities',
  'Cadet Admin Officer', 'WO2 Training', 'Platoon Commander',
  'Detachment Commander', 'RAAMC Officer', 'Padre', 'Other',
];

// -----------------------------------------------------------------------------
// Module state
// -----------------------------------------------------------------------------

let _root         = null;
let _controller   = null;   // AbortController — cleaned up on unmount
let _searchTerm   = '';
let _showInactive = false;

// -----------------------------------------------------------------------------
// Mount / unmount
// -----------------------------------------------------------------------------

export async function mount(rootEl) {
  AUTH.requirePermission('view');
  // Cadets must not access the staff list — defence-in-depth block in
  // addition to the notForCadet nav flag in shell.js.
  if (AUTH.isCadet()) {
    rootEl.innerHTML = `<div class="page-denied"><p>Access restricted.</p></div>`;
    return function unmount() {};
  }
  _root         = rootEl;
  _controller   = new AbortController();
  _searchTerm   = '';
  _showInactive = false;

  // Auto-migrate any cadets with personType='staff' to the staff store
  const migrated = await _migrateStaffFromCadets();
  if (migrated > 0) {
    showToast(
      `${migrated} staff record${migrated === 1 ? '' : 's'} migrated from the cadet list.`,
      'success',
    );
    Sync.notifyChanged();
  }

  await _render();
  return function unmount() {
    _controller.abort();
    _controller = null;
    _root = null;
  };
}

// -----------------------------------------------------------------------------
// Render
// -----------------------------------------------------------------------------

async function _render() {
  const all = await Storage.staff.list();

  all.sort((a, b) =>
    compareRanks(a.rank, b.rank) ||
    (a.surname || '').localeCompare(b.surname || '')
  );

  const term     = _searchTerm.trim().toLowerCase();
  const filtered = all.filter((s) => {
    if (!_showInactive && s.active === false) return false;
    if (term) {
      const hay = [
        s.surname, s.given, s.svcNo, s.rank, s.position, s.company, s.email, s.notes,
      ].join(' ').toLowerCase();
      if (!hay.includes(term)) return false;
    }
    return true;
  });

  const canManage = AUTH.can('manageStaff');
  const hasFilter = _searchTerm || !_showInactive;

  render(_root, `
    <section class="stf">
      <header class="stf__toolbar">
        <div class="stf__filters">
          <input type="search"
                 class="stf__search"
                 placeholder="Search name, service number, rank, position…"
                 aria-label="Search staff"
                 value="${esc(_searchTerm)}">
          <label class="stf__inactive-toggle">
            <input type="checkbox" data-action="toggle-inactive"
                   ${_showInactive ? 'checked' : ''}>
            Show inactive
          </label>
        </div>
        <div class="stf__actions">
          ${canManage
            ? `<button type="button" class="btn btn--primary" data-action="add">+ Add staff</button>`
            : ''}
        </div>
      </header>

      <div class="stf__meta">
        ${filtered.length} ${filtered.length === 1 ? 'person' : 'people'} shown
        ${hasFilter && all.length !== filtered.length
          ? `<span class="stf__meta-of"> of ${all.length}</span>`
          : ''}
      </div>

      <div class="stf__table-wrap">
        ${filtered.length === 0
          ? _emptyStateHtml(all.length, canManage)
          : _tableHtml(filtered, canManage)}
      </div>
    </section>
  `);

  _wireEventListeners();
}

function _emptyStateHtml(total, canManage) {
  if (total === 0) {
    return `
      <div class="stf__empty">
        <p>No staff on the establishment yet.</p>
        ${canManage
          ? `<button type="button" class="btn btn--primary" data-action="add">+ Add first staff member</button>`
          : `<p class="stf__empty-hint">Ask your QM or OC to add staff records.</p>`}
      </div>`;
  }
  return `
    <div class="stf__empty">
      <p>No staff match the current filters.</p>
      <button type="button" class="btn btn--ghost" data-action="clear-filters">Clear filters</button>
    </div>`;
}

function _tableHtml(members, canManage) {
  const colCount = 6 + (canManage ? 1 : 0);
  const rows = members.map((s) => _staffRowHtml(s, canManage)).join('');
  return `
    <table class="stf__table">
      <thead>
        <tr>
          <th class="stf__col-rank">Rank</th>
          <th class="stf__col-surname">Surname</th>
          <th class="stf__col-givens">Given names</th>
          <th class="stf__col-svc">Service No.</th>
          <th class="stf__col-position">Position</th>
          <th class="stf__col-status">Status</th>
          ${canManage ? `<th class="stf__col-actions">Actions</th>` : ''}
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>`;
}

function _staffRowHtml(s, canManage) {
  const inactive = s.active === false;
  return `
    <tr class="stf__row ${inactive ? 'stf__row--inactive' : ''}"
        data-svc="${esc(s.svcNo)}">
      <td class="stf__rank">${esc(s.rank || '')}</td>
      <td class="stf__surname">${esc(s.surname || '')}</td>
      <td class="stf__givens">${esc(s.given || '')}</td>
      <td class="stf__svc">${esc(s.svcNo)}</td>
      <td class="stf__position">${esc(s.position || '')}</td>
      <td class="stf__status">
        ${inactive ? `<span class="stf__badge stf__badge--inactive">Inactive</span>` : ''}
      </td>
      ${canManage ? `
        <td class="stf__col-actions">
          <div class="stf__row-actions">
            <button type="button" class="btn btn--sm btn--ghost"
                    data-action="edit" data-svc="${esc(s.svcNo)}">Edit</button>
            <button type="button" class="btn btn--sm btn--danger"
                    data-action="delete" data-svc="${esc(s.svcNo)}">Delete</button>
          </div>
        </td>
      ` : ''}
    </tr>`;
}

// -----------------------------------------------------------------------------
// Event wiring
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Staff migration — move cadets with personType='staff' into the staff store
// -----------------------------------------------------------------------------

/**
 * Moves staff-typed rows OUT of the legacy cadets store into `staff`.
 *
 * NO LONGER THE PRIMARY MECHANISM, and was never adequate as one. It matches
 * `personType === 'staff'` exactly, so it never saw the adults an older build
 * recorded with no personType at all; and it only runs when someone opens this
 * page, while the purge that destroys the cadet store lives on Settings. A unit
 * could import, extract and purge without ever coming here, and the adults went
 * with the cadets.
 *
 * Storage now does this at init() and after importAll() — see
 * _reclassifyStrandedStaff() in storage.js — covering both kinds and both
 * routes. This is retained as a backstop for a database that somehow reaches
 * this page with staff-typed rows still in `cadets`; in normal operation it
 * finds nothing.
 *
 * Relocation, not disposal: it calls Storage.cadets.delete(), and that is why —
 * the row is not gone, it is in `staff`.
 */
async function _migrateStaffFromCadets() {
  let cadets;
  try { cadets = await Storage.cadets.list(); } catch { return 0; }
  const staffCadets = cadets.filter(c => c.personType === 'staff');
  if (staffCadets.length === 0) return 0;

  for (const c of staffCadets) {
    const existing = await Storage.staff.get(c.svcNo);
    if (!existing) {
      await Storage.staff.put({
        svcNo:      c.svcNo,
        surname:    c.surname    || '',
        given:      c.given      || '',
        rank:       c.rank       || '',
        position:   c.position   || '',
        company:    c.company    || c.plt || '',
        personType: 'staff',
        active:     c.active !== false,
        email:      c.email      || '',
        notes:      c.notes      || '',
        createdAt:  c.createdAt  || new Date().toISOString(),
        migratedAt: new Date().toISOString(),
      });
      await Storage.audit.append({
        action: 'staff_add',
        user:   AUTH.getSession()?.name || 'system',
        desc:   `Migrated from cadet list: ${c.rank} ${c.surname} (${c.svcNo})`,
      }).catch(() => {});
    }
    await Storage.cadets.delete(c.svcNo);
  }
  return staffCadets.length;
}

// -----------------------------------------------------------------------------
// Event wiring
// -----------------------------------------------------------------------------

function _wireEventListeners() {
  const sig = _controller.signal;
  $('.stf__search', _root)?.addEventListener('input', _onSearchInput, { signal: sig });
  _root.addEventListener('click',  _onRootClick,  { signal: sig });
  _root.addEventListener('change', _onRootChange, { signal: sig });
}

function _onSearchInput(e) {
  _searchTerm = e.target.value;
  _render();
}

function _onRootChange(e) {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'toggle-inactive') {
    _showInactive = !!e.target.checked;
    _render();
  }
}

async function _onRootClick(e) {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  const svcNo = e.target.closest('[data-svc]')?.dataset.svc;
  switch (action) {
    case 'add':    await _openAddModal();        break;
    case 'edit':   await _openEditModal(svcNo);  break;
    case 'delete': await _openDeleteModal(svcNo); break;
    case 'clear-filters':
      _searchTerm   = '';
      _showInactive = false;
      await _render();
      break;
  }
}

// -----------------------------------------------------------------------------
// Add / edit modal
// -----------------------------------------------------------------------------

async function _openAddModal() {
  AUTH.requirePermission('manageStaff');
  _openStaffFormModal({ mode: 'add', member: null });
}

async function _openEditModal(svcNo) {
  AUTH.requirePermission('manageStaff');
  const member = await Storage.staff.get(svcNo);
  if (!member) {
    showToast('That staff record has been deleted. Refreshing the list.', 'warn');
    await _render();
    return;
  }
  // Fire-and-forget read-access audit — records who viewed this staff PII record
  Storage.audit.append({
    action: 'staff_viewed',
    user:   AUTH.getSession()?.name || 'unknown',
    detail: svcNo,
  }).catch(() => {});
  _openStaffFormModal({ mode: 'edit', member });
}

function _openStaffFormModal({ mode, member }) {
  const isEdit = mode === 'edit';
  const s = member || {};

  const rankOptions = STAFF_RANKS_CANONICAL.map((r) => `<option value="${esc(r)}">`).join('');
  const posOptions  = STAFF_POSITIONS.map((p) => `<option value="${esc(p)}">`).join('');

  openModal({
    titleHtml: isEdit ? 'Edit staff member' : 'Add staff member',
    size:      'md',
    bodyHtml: `
      <form class="form" data-form="staff" autocomplete="off">
        <div class="form__row">
          <label class="form__field">
            <span class="form__label">Service number *</span>
            <input type="text" name="svcNo" required maxlength="16"
                   value="${esc(s.svcNo || '')}"
                   ${isEdit ? 'readonly' : ''}
                   spellcheck="false" autocapitalize="off"
                   placeholder="e.g. 8512345">
            ${isEdit
              ? `<span class="form__hint">Service number is the record key — to change it, delete and re-add.</span>`
              : `<span class="form__hint">Required. Used as the record key.</span>`}
          </label>
          <label class="form__field">
            <span class="form__label">Rank *</span>
            <input type="text" name="rank" required maxlength="16"
                   value="${esc(s.rank || '')}"
                   list="stf-rank-options" spellcheck="false"
                   placeholder="e.g. CAPT-AAC, WO2-AAC, DAH">
            <datalist id="stf-rank-options">${rankOptions}</datalist>
          </label>
        </div>

        <div class="form__row">
          <label class="form__field form__field--grow">
            <span class="form__label">Surname *</span>
            <input type="text" name="surname" required maxlength="80"
                   value="${esc(s.surname || '')}"
                   style="text-transform: uppercase;"
                   placeholder="SURNAME">
          </label>
          <label class="form__field form__field--grow">
            <span class="form__label">Given names</span>
            <input type="text" name="given" maxlength="80"
                   value="${esc(s.given || '')}"
                   placeholder="Given names">
          </label>
        </div>

        <div class="form__row">
          <label class="form__field form__field--grow">
            <span class="form__label">Position / appointment</span>
            <input type="text" name="position" maxlength="80"
                   value="${esc(s.position || '')}"
                   list="stf-position-options"
                   placeholder="e.g. OC, Training Officer, QM">
            <datalist id="stf-position-options">${posOptions}</datalist>
          </label>
          <label class="form__field">
            <span class="form__label">Sub-unit / company</span>
            <input type="text" name="company" maxlength="40"
                   value="${esc(s.company || '')}"
                   placeholder="e.g. A Coy (optional)">
          </label>
        </div>

        <div class="form__row">
          <label class="form__field form__field--grow">
            <span class="form__label">Email</span>
            <input type="email" name="email" maxlength="120"
                   value="${esc(s.email || '')}"
                   spellcheck="false" placeholder="optional">
          </label>
          <label class="form__field stf__active-field">
            <span class="form__label">Status</span>
            <label class="form__checkbox-inline">
              <input type="checkbox" name="active"
                     ${s.active !== false ? 'checked' : ''}>
              Active
            </label>
            <span class="form__hint">Inactive staff stay listed but are excluded from new issues</span>
          </label>
        </div>

        <label class="form__field">
          <span class="form__label">Notes</span>
          <textarea name="notes" rows="2" maxlength="500"
                    placeholder="optional">${esc(s.notes || '')}</textarea>
        </label>

        <div class="form__error" role="alert"></div>
        <div class="form__actions">
          <button type="button" class="btn btn--ghost" data-action="modal-close">Cancel</button>
          <button type="submit" class="btn btn--primary">
            ${isEdit ? 'Save changes' : 'Add staff member'}
          </button>
        </div>
      </form>`,
    onMount(panel, close) {
      const form  = $('form[data-form="staff"]', panel);
      const errEl = $('.form__error', panel);

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errEl.textContent = '';
        let data;
        try {
          data = _readFormData(form);
        } catch (err) {
          errEl.textContent = err.message;
          return;
        }
        try {
          if (isEdit) await _saveEdit(s.svcNo, data);
          else        await _saveAdd(data);
          close();
          await _render();
        } catch (err) {
          errEl.textContent = err.message || 'Save failed.';
        }
      });
    },
  });
}

// -----------------------------------------------------------------------------
// Form parsing & validation
// -----------------------------------------------------------------------------

function _readFormData(form) {
  const fd      = new FormData(form);
  const svcNo   = String(fd.get('svcNo')    || '').trim();
  const rankRaw = String(fd.get('rank')     || '').trim();
  const surname = String(fd.get('surname')  || '').trim().toUpperCase();
  const given   = String(fd.get('given')    || '').trim();
  const position= String(fd.get('position') || '').trim();
  const company = String(fd.get('company')  || '').trim();
  const email   = String(fd.get('email')    || '').trim();
  const notes   = String(fd.get('notes')    || '').trim();
  const active  = fd.get('active') === 'on';

  if (!svcNo)   throw new Error('Service number is required.');
  if (!rankRaw) throw new Error('Rank is required.');
  if (!surname) throw new Error('Surname is required.');
  if (/\s/.test(svcNo))  throw new Error('Service number must not contain whitespace.');
  if (svcNo.length > 16) throw new Error('Service number is too long (max 16 chars).');

  const rank = normalizeRank(rankRaw);

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Email is not in a valid format.');
  }

  return { svcNo, rank, surname, given, position, company, personType: 'staff', active, email, notes };
}

// -----------------------------------------------------------------------------
// Save handlers
// -----------------------------------------------------------------------------

async function _saveAdd(data) {
  AUTH.requirePermission('manageStaff');

  // Check both stores — svcNo must be unique across cadets and staff.
  const existingStaff  = await Storage.staff.get(data.svcNo);
  const existingCadet  = await Storage.cadets.get(data.svcNo);
  if (existingStaff || existingCadet) {
    throw new Error(`A record with service number ${data.svcNo} already exists.`);
  }

  await Storage.staff.put({ ...data, createdAt: new Date().toISOString() });

  await Storage.audit.append({
    action: 'staff_add',
    user:   AUTH.getSession()?.name || 'unknown',
    desc:   `Added staff: ${data.rank} ${data.surname} (${data.svcNo})`,
  });

  Sync.notifyChanged();
}

async function _saveEdit(svcNo, data) {
  AUTH.requirePermission('manageStaff');

  const existing = await Storage.staff.get(svcNo);
  if (!existing) {
    throw new Error('This staff record has been deleted in another tab. Close the modal and refresh.');
  }

  await Storage.staff.put({
    ...existing,
    ...data,
    svcNo,
    updatedAt: new Date().toISOString(),
  });

  await Storage.audit.append({
    action: 'staff_update',
    user:   AUTH.getSession()?.name || 'unknown',
    desc:   `Updated staff: ${data.rank} ${data.surname} (${svcNo})`,
  });

  Sync.notifyChanged();
}

// -----------------------------------------------------------------------------
// Delete modal
// -----------------------------------------------------------------------------

async function _openDeleteModal(svcNo) {
  AUTH.requirePermission('manageStaff');
  const member = await Storage.staff.get(svcNo);
  if (!member) {
    showToast('That staff record has already been deleted.', 'warn');
    await _render();
    return;
  }

  openModal({
    titleHtml: 'Delete staff member',
    size:      'sm',
    bodyHtml: `
      <form class="form" data-form="staff-delete" autocomplete="off">
        <p class="modal__body">
          Delete <strong>${esc(member.rank)} ${esc(member.surname)}</strong> (${esc(svcNo)})?
        </p>
        <p class="form__hint">
          This removes the staff record. Existing loan history is preserved — the
          borrower name on historical loans will remain unchanged.
        </p>
        <label class="form__field">
          <span class="form__label">Reason *</span>
          <input type="text" name="reason" maxlength="200"
                 placeholder="e.g. Posted out, left unit" autocomplete="off">
        </label>
        <div class="form__error" role="alert"></div>
        <div class="form__actions">
          <button type="button" class="btn btn--ghost" data-action="modal-close">Cancel</button>
          <button type="submit" class="btn btn--danger">Delete</button>
        </div>
      </form>`,
    onMount(panel, close) {
      const form  = $('form[data-form="staff-delete"]', panel);
      const errEl = $('.form__error', panel);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errEl.textContent = '';
        const reason = (new FormData(form).get('reason') || '').trim();
        if (!reason) { errEl.textContent = 'Reason is required.'; return; }
        try {
          AUTH.requirePermission('manageStaff');
          await Storage.staff.delete(svcNo);
          await Storage.audit.append({
            action: 'staff_delete',
            user:   AUTH.getSession()?.name || 'unknown',
            desc:   `Deleted staff: ${member.rank} ${member.surname} (${svcNo}) — reason: ${reason}`,
          });
          Sync.notifyChanged();
          close();
          await _render();
        } catch (err) {
          errEl.textContent = err.message || 'Delete failed.';
        }
      });
    },
  });
}
