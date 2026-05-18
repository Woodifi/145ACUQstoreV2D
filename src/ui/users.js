// =============================================================================
// QStore IMS v2 — User management page
// =============================================================================
// OC-only page for creating, editing, and deleting user accounts, and for
// resetting any user's PIN.
//
// PERMISSIONS
//   coOnly — only the OC (role 'co') can access this page. It does not appear
//   in the nav for any other role.
//
// OPERATIONS
//   Add user  — full form: name, username, role, service no, initial PIN (×2).
//               Username must be unique. PIN hashed via AUTH.setPin().
//   Edit user — same fields minus PIN. If the OC also wants to reset a PIN,
//               they use the separate "Reset PIN" action on that row.
//   Reset PIN — quick modal: new PIN + confirm. Calls AUTH.setPin().
//   Delete    — confirmation modal. Blocked if the target is the current user
//               or the last remaining OC account.
//
// AUDIT
//   user_add, user_update, user_delete are written here.
//   pin_change is written by AUTH.setPin() automatically.
// =============================================================================

import * as Storage from '../storage.js';
import * as AUTH    from '../auth.js';
import { esc, $, render, fmtDateOnly } from './util.js';
import { showToast } from './toast.js';
import { openModal } from './modal.js';

// Role order for display — matches login.js convention.
const ROLE_ORDER = ['co', 'qm', 'staff', 'cadet', 'ro'];

// -----------------------------------------------------------------------------
// Module state
// -----------------------------------------------------------------------------

let _root = null;

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

export async function mount(rootEl) {
  AUTH.requireCO();
  _root = rootEl;
  await _render();
  return function unmount() { _root = null; };
}

// -----------------------------------------------------------------------------
// Render
// -----------------------------------------------------------------------------

async function _render() {
  const users = await Storage.users.list();
  users.sort((a, b) => {
    const ra = ROLE_ORDER.indexOf(a.role);
    const rb = ROLE_ORDER.indexOf(b.role);
    if (ra !== rb) return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb);
    return (a.name || '').localeCompare(b.name || '');
  });

  render(_root, `
    <section class="usr">
      <header class="usr__toolbar">
        <div class="usr__toolbar-left">
          <h2 class="usr__heading">User Accounts</h2>
          <span class="usr__count">${users.length} ${users.length === 1 ? 'account' : 'accounts'}</span>
        </div>
        <button type="button" class="btn btn--primary" data-action="add-user">+ Add User</button>
      </header>

      ${users.length === 0
        ? `<div class="usr__empty"><p>No user accounts exist. This should not happen — contact support.</p></div>`
        : _tableHtml(users)
      }
    </section>
  `);

  _root.addEventListener('click', _onRootClick);
}

function _tableHtml(users) {
  return `
    <div class="usr__table-wrap">
      <table class="usr__table">
        <thead>
          <tr>
            <th class="usr__col-name">Name</th>
            <th class="usr__col-username">Username</th>
            <th class="usr__col-role">Role</th>
            <th class="usr__col-svc">Service No</th>
            <th class="usr__col-last">Last Login</th>
            <th class="usr__col-actions">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${users.map(_rowHtml).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function _rowHtml(user) {
  const session   = AUTH.getSession();
  const isSelf    = session?.userId === user.id;
  const roleLabel = AUTH.ROLES[user.role]?.label || user.role;
  const lastLogin = user.lastLogin ? fmtDateOnly(user.lastLogin) : '—';

  return `
    <tr class="usr__row ${isSelf ? 'usr__row--self' : ''}">
      <td class="usr__name">
        ${esc(user.name)}
        ${isSelf ? `<span class="usr__you-badge">you</span>` : ''}
      </td>
      <td class="usr__username">${esc(user.username)}</td>
      <td class="usr__role">
        <span class="usr__role-badge usr__role-badge--${esc(user.role)}">${esc(roleLabel)}</span>
      </td>
      <td class="usr__svc">${esc(user.svcNo || '—')}</td>
      <td class="usr__last">${esc(lastLogin)}</td>
      <td class="usr__actions">
        <button type="button" class="btn btn--ghost btn--sm"
                data-action="edit-user" data-user-id="${esc(user.id)}">Edit</button>
        <button type="button" class="btn btn--ghost btn--sm"
                data-action="reset-pin" data-user-id="${esc(user.id)}">Reset PIN</button>
        <button type="button" class="btn btn--danger btn--sm"
                data-action="delete-user" data-user-id="${esc(user.id)}"
                ${isSelf ? 'disabled title="Cannot delete your own account"' : ''}>Delete</button>
      </td>
    </tr>
  `;
}

// -----------------------------------------------------------------------------
// Event handling
// -----------------------------------------------------------------------------

async function _onRootClick(e) {
  const btn    = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const userId = btn.dataset.userId;

  switch (action) {
    case 'add-user':    await _openUserForm(null);   break;
    case 'edit-user':   await _openUserForm(userId); break;
    case 'reset-pin':   await _openResetPinModal(userId); break;
    case 'delete-user': await _openDeleteConfirm(userId); break;
  }
}

// -----------------------------------------------------------------------------
// Add / Edit user modal
// -----------------------------------------------------------------------------

async function _openUserForm(userId) {
  const isNew = !userId;
  let user    = null;

  if (!isNew) {
    user = await Storage.users.get(userId);
    if (!user) { showToast('User not found.', 'error'); return; }
  }

  const roleOptions = ROLE_ORDER
    .filter((key) => AUTH.ROLES[key])
    .map((key) => {
      const sel = !isNew && user.role === key ? 'selected' : '';
      return `<option value="${esc(key)}" ${sel}>${esc(AUTH.ROLES[key].label)}</option>`;
    })
    .join('');

  openModal({
    titleHtml: isNew ? 'Add User' : `Edit User — ${esc(user.name)}`,
    size:      'sm',
    persistent: true,
    bodyHtml:  `
      <form class="form" data-form="user-form" autocomplete="off">
        <label class="form__field">
          <span class="form__label">Full name <span class="form__required">*</span></span>
          <input type="text" name="name" required maxlength="80"
                 value="${esc(user?.name || '')}" class="form__input"
                 placeholder="e.g. CAPT J Smith">
        </label>
        <label class="form__field">
          <span class="form__label">Username <span class="form__required">*</span></span>
          <input type="text" name="username" required maxlength="40"
                 value="${esc(user?.username || '')}" class="form__input"
                 autocapitalize="none" spellcheck="false"
                 placeholder="e.g. jsmith">
        </label>
        <label class="form__field">
          <span class="form__label">Role <span class="form__required">*</span></span>
          <select name="role" class="form__select">
            ${roleOptions}
          </select>
        </label>
        <label class="form__field">
          <span class="form__label">Service number</span>
          <input type="text" name="svcNo" maxlength="20"
                 value="${esc(user?.svcNo || '')}" class="form__input"
                 placeholder="e.g. 8123456">
        </label>
        ${isNew ? `
          <p class="form__hint">
            Set the user's initial PIN. The PIN will be displayed once after
            saving — note it down and give it to the user verbally.
          </p>
          <label class="form__field">
            <span class="form__label">Initial PIN <span class="form__required">*</span></span>
            <input type="text" name="pin" inputmode="numeric"
                   pattern="\\d{4}" maxlength="4" required
                   autocomplete="off" class="form__input--pin"
                   placeholder="4 digits">
          </label>
          <label class="form__field">
            <span class="form__label">Confirm PIN <span class="form__required">*</span></span>
            <input type="text" name="pinConfirm" inputmode="numeric"
                   pattern="\\d{4}" maxlength="4" required
                   autocomplete="off" class="form__input--pin"
                   placeholder="4 digits">
          </label>
        ` : ''}
        <div class="form__error" role="alert"></div>
        <div class="form__actions">
          <button type="button" class="btn btn--ghost" data-action="modal-close">Cancel</button>
          <button type="submit" class="btn btn--primary">${isNew ? 'Add User' : 'Save Changes'}</button>
        </div>
      </form>
    `,
    onMount(panel, close) {
      const form  = $('form[data-form="user-form"]', panel);
      const errEl = $('.form__error', panel);

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errEl.textContent = '';

        const fd         = new FormData(form);
        const name       = String(fd.get('name')       || '').trim();
        const username   = String(fd.get('username')   || '').trim().toLowerCase();
        const role       = String(fd.get('role')       || '');
        const svcNo      = String(fd.get('svcNo')      || '').trim();
        const pin        = isNew ? String(fd.get('pin')        || '') : null;
        const pinConfirm = isNew ? String(fd.get('pinConfirm') || '') : null;

        // Validation
        if (!name)             { errEl.textContent = 'Full name is required.';           return; }
        if (!username)         { errEl.textContent = 'Username is required.';            return; }
        if (!AUTH.ROLES[role]) { errEl.textContent = 'Please select a valid role.';      return; }

        if (isNew) {
          if (!/^\d{4}$/.test(pin))  { errEl.textContent = 'PIN must be exactly 4 digits.'; return; }
          if (pin !== pinConfirm)    { errEl.textContent = 'PINs do not match.';             return; }
        }

        // Username uniqueness check
        const allUsers  = await Storage.users.list();
        const duplicate = allUsers.find((u) => u.username === username && u.id !== (user?.id));
        if (duplicate)  { errEl.textContent = 'That username is already taken.';         return; }

        const submit = form.querySelector('[type="submit"]');
        if (submit) { submit.disabled = true; submit.textContent = isNew ? 'Adding…' : 'Saving…'; }

        try {
          if (isNew) {
            // Generate ID, create the record with an empty hash placeholder,
            // then let AUTH.setPin() do the actual argon2id hash + audit entry.
            const id = 'usr-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            await Storage.users.put({
              id,
              name,
              username,
              role,
              svcNo,
              pinHash:          '',
              pinHashAlgorithm: 'argon2id',
              lastLogin:        null,
              createdAt:        new Date().toISOString(),
            });
            // setPin hashes the PIN and writes a pin_change audit entry.
            await AUTH.setPin(id, pin);
            await Storage.audit.append({
              action: 'user_add',
              user:   AUTH.getSession()?.name || 'OC',
              desc:   `User account created: ${username} (${AUTH.ROLES[role]?.label}).`,
            });
            // Close the add-user form then show the PIN once for the admin to
            // note down. _render() is deferred until the admin acknowledges.
            close();
            _showPinOnce(name, pin, async () => {
              showToast(`User "${name}" added.`, 'success');
              await _render();
            });
          } else {
            const updated = { ...user, name, username, role, svcNo };
            await Storage.users.put(updated);
            await Storage.audit.append({
              action: 'user_update',
              user:   AUTH.getSession()?.name || 'OC',
              desc:   `User account updated: ${username} — name, role, or service number changed.`,
            });
            close();
            showToast(`User "${name}" updated.`, 'success');
            await _render();
          }
        } catch (err) {
          errEl.textContent = err.message || 'Save failed. Please try again.';
          if (submit) { submit.disabled = false; submit.textContent = isNew ? 'Add User' : 'Save Changes'; }
        }
      });
    },
  });
}

// -----------------------------------------------------------------------------
// Reset PIN modal
// -----------------------------------------------------------------------------

async function _openResetPinModal(userId) {
  const user = await Storage.users.get(userId);
  if (!user) { showToast('User not found.', 'error'); return; }

  openModal({
    titleHtml: `Reset PIN — ${esc(user.name)}`,
    size:      'sm',
    bodyHtml:  `
      <p class="modal__body">
        Set a new 4-digit PIN for <strong>${esc(user.name)}</strong>.
        The PIN will be displayed once after saving — note it down and
        give it to the user verbally.
      </p>
      <form class="form" data-form="reset-pin-form" autocomplete="off">
        <label class="form__field">
          <span class="form__label">New PIN <span class="form__required">*</span></span>
          <input type="text" name="pin" inputmode="numeric"
                 pattern="\\d{4}" maxlength="4" required
                 autocomplete="off" class="form__input--pin"
                 placeholder="4 digits">
        </label>
        <label class="form__field">
          <span class="form__label">Confirm PIN <span class="form__required">*</span></span>
          <input type="text" name="pinConfirm" inputmode="numeric"
                 pattern="\\d{4}" maxlength="4" required
                 autocomplete="off" class="form__input--pin"
                 placeholder="4 digits">
        </label>
        <div class="form__error" role="alert"></div>
        <div class="form__actions">
          <button type="button" class="btn btn--ghost" data-action="modal-close">Cancel</button>
          <button type="submit" class="btn btn--primary">Reset PIN</button>
        </div>
      </form>
    `,
    onMount(panel, close) {
      const form  = $('form[data-form="reset-pin-form"]', panel);
      const errEl = $('.form__error', panel);

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errEl.textContent = '';

        const fd         = new FormData(form);
        const pin        = String(fd.get('pin')        || '');
        const pinConfirm = String(fd.get('pinConfirm') || '');

        if (!/^\d{4}$/.test(pin)) { errEl.textContent = 'PIN must be exactly 4 digits.'; return; }
        if (pin !== pinConfirm)   { errEl.textContent = 'PINs do not match.';             return; }

        const submit = form.querySelector('[type="submit"]');
        if (submit) { submit.disabled = true; submit.textContent = 'Resetting…'; }

        try {
          await AUTH.setPin(userId, pin);
          // Close the reset form then show the PIN once for the admin to
          // note down. _render() is deferred until the admin acknowledges.
          close();
          _showPinOnce(user.name, pin, async () => {
            showToast(`PIN reset for ${user.name}.`, 'success');
            await _render();
          });
        } catch (err) {
          errEl.textContent = err.message || 'Reset failed. Please try again.';
          if (submit) { submit.disabled = false; submit.textContent = 'Reset PIN'; }
        }
      });
    },
  });
}

// -----------------------------------------------------------------------------
// Show-once PIN display
// -----------------------------------------------------------------------------
// Called immediately after a PIN is set (Add User or Reset PIN). The modal is
// persistent so the admin cannot dismiss it without explicitly acknowledging
// they have written the PIN down. After Done, afterDone() is called to show
// the success toast and re-render the user table.

function _showPinOnce(userName, pin, afterDone) {
  openModal({
    titleHtml:  'Note down this PIN',
    size:       'sm',
    persistent: true,
    bodyHtml:   `
      <p class="modal__body">
        The PIN for <strong>${esc(userName)}</strong> is shown below.
        <strong>This is the only time it will be displayed.</strong>
        Write it down and give it to the user verbally — it cannot be
        retrieved again, even by the administrator.
      </p>
      <div class="recovery-code__display" role="textbox" aria-readonly="true"
           aria-label="PIN for ${esc(userName)}">${esc(pin)}</div>
      <form class="form" data-form="pin-ack">
        <label class="form__field">
          <input type="checkbox" name="ack" required>
          I have noted this PIN down and will give it to the user verbally.
        </label>
        <div class="form__actions">
          <button type="submit" class="btn btn--primary" disabled
                  data-action="pin-ack-submit">Done</button>
        </div>
      </form>
    `,
    onMount(panel, close) {
      const form = $('form[data-form="pin-ack"]', panel);
      const cb   = $('input[name="ack"]', panel);
      const btn  = $('button[data-action="pin-ack-submit"]', panel);
      cb.addEventListener('change', () => { btn.disabled = !cb.checked; });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (cb.checked) {
          close();
          afterDone();
        }
      });
    },
  });
}

// -----------------------------------------------------------------------------
// Delete confirmation
// -----------------------------------------------------------------------------

async function _openDeleteConfirm(userId) {
  const session = AUTH.getSession();

  // Belt-and-braces guard — the Delete button is disabled for self, but
  // re-check here in case of DOM manipulation.
  if (session?.userId === userId) {
    showToast('You cannot delete your own account.', 'error');
    return;
  }

  const user = await Storage.users.get(userId);
  if (!user) { showToast('User not found.', 'error'); return; }

  // Prevent deleting the last OC.
  if (user.role === 'co') {
    const allUsers = await Storage.users.list();
    const coCount  = allUsers.filter((u) => u.role === 'co').length;
    if (coCount <= 1) {
      showToast('Cannot delete the only OC account. Assign another OC first.', 'error');
      return;
    }
  }

  const roleLabel = AUTH.ROLES[user.role]?.label || user.role;

  openModal({
    titleHtml: 'Delete User',
    size:      'sm',
    bodyHtml:  `
      <p class="modal__body">
        Delete <strong>${esc(user.name)}</strong>
        (${esc(roleLabel)}, username: <code>${esc(user.username)}</code>)?
      </p>
      <p class="modal__body">
        Their login access will be removed immediately. Loan history, audit
        entries, and any issued equipment records are preserved.
      </p>
      <div class="form__actions">
        <button type="button" class="btn btn--ghost" data-action="modal-close">Cancel</button>
        <button type="button" class="btn btn--danger" data-action="confirm-delete">Delete Account</button>
      </div>
    `,
    onMount(panel, close) {
      const confirmBtn = $('[data-action="confirm-delete"]', panel);
      confirmBtn?.addEventListener('click', async () => {
        confirmBtn.disabled    = true;
        confirmBtn.textContent = 'Deleting…';
        try {
          await Storage.users.delete(userId);
          await Storage.audit.append({
            action: 'user_delete',
            user:   session?.name || 'OC',
            desc:   `User account deleted: ${user.username} (${roleLabel}).`,
          });
          close();
          showToast(`User "${user.name}" deleted.`, 'success');
          await _render();
        } catch (err) {
          showToast(err.message || 'Delete failed.', 'error');
          close();
        }
      });
    },
  });
}
