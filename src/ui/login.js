// =============================================================================
// QStore IMS v2 — Login screen
// =============================================================================
// Three-step flow:
//   1. User picker  — list of all users in the unit, sorted by role then name
//   2. PIN keypad   — 4-digit entry, auto-submits on 4th digit
//   3. TOTP code    — 6-digit authenticator code (only if 2FA is enabled)
//
// Calls AUTH.login() and dispatches success via the onLoggedIn callback.
// Unsuccessful logins shake the keypad and clear the buffer for retry.
//
// ACCESSIBILITY
//   - PIN buttons have aria-label so screen readers say "1, 2, 3..." not
//     "button button button"
//   - The dot indicator has aria-live="polite" so screen readers announce
//     "1 digit entered" / "2 digits entered"
//   - Errors use role="alert" so they get announced when they appear
//
// SECURITY NOTES
//   - PIN is always masked on screen as dots (an eye-icon toggle reveals it
//     temporarily, useful for fat-finger debugging)
//   - We never log the typed PIN, even on failure
//   - Failed-login audit entries are written by AUTH.login(), not here
//   - TOTP step uses a ±30s window and replay guard (totpLastUsedStep)
//   - Backup codes are single-use; consumed entry is removed on success
// =============================================================================

import * as Storage from '../storage.js';
import * as AUTH    from '../auth.js';
import * as TOTP    from '../totp.js';
import { openModal } from './modal.js';
import { esc, $, $$, render, fmtDateOnly, sleep } from './util.js';

const ROLE_ORDER = ['co', 'qm', 'staff', 'cadet', 'ro'];

const _ICON_EYE     = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const _ICON_EYE_OFF = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

let _root           = null;
let _onLoggedIn     = null;
let _selectedUserId = null;
let _pinBuffer      = '';
let _pinRevealed    = false;
let _busy           = false;
let _lockoutTimer   = null;

/**
 * Mount the login screen into a DOM container. Calls onLoggedIn(session)
 * after a successful login. Returns a cleanup function.
 */
export async function mount(rootEl, { onLoggedIn } = {}) {
  _root = rootEl;
  _onLoggedIn = onLoggedIn || (() => {});
  _selectedUserId = null;
  _pinBuffer = '';
  _pinRevealed = false;
  _busy = false;

  await _renderUserPicker();

  return function unmount() {
    _root = null;
    _onLoggedIn = null;
  };
}

// -----------------------------------------------------------------------------
// User picker
// -----------------------------------------------------------------------------

async function _renderUserPicker() {
  const users = await Storage.users.list();
  const settings = await Storage.settings.getAll();
  const unitName = settings.unitName || 'QStore IMS';
  const unitCode = settings.unitCode || '';

  users.sort((a, b) => {
    const ra = ROLE_ORDER.indexOf(a.role);
    const rb = ROLE_ORDER.indexOf(b.role);
    if (ra !== rb) return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb);
    return (a.name || '').localeCompare(b.name || '');
  });

  const userButtonsHtml = users.length === 0
    ? `<div class="login__empty">No user accounts yet. The system needs to be initialised by an administrator.</div>`
    : users.map(_userButtonHtml).join('');

  render(_root, `
    <div class="login">
      <div class="login__card">
        <header class="login__header">
          <h1 class="login__title">${esc(unitName)}</h1>
          ${unitCode ? `<div class="login__subtitle">${esc(unitCode)} — Q-Store IMS</div>` : ''}
        </header>
        <div class="login__body">
          <h2 class="login__heading">Sign in</h2>
          <p class="login__hint">Select your name to continue.</p>
          <div class="login__user-list" role="list">
            ${userButtonsHtml}
          </div>
        </div>
        <footer class="login__privacy">
          This system stores personnel and equipment data.
          Access is restricted to authorised unit staff only.
          All actions are audit-logged.
        </footer>
      </div>
    </div>
  `);

  // Wire user-select buttons via event delegation on the list container.
  const list = $('.login__user-list', _root);
  if (list) {
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-user-id]');
      if (!btn) return;
      _selectedUserId = btn.dataset.userId;
      _pinBuffer = '';
      _renderPinKeypad();
    });
  }
}

function _userButtonHtml(user) {
  const roleLabel = AUTH.ROLES[user.role]?.short || user.role;
  const lastSeen  = user.lastLogin
    ? `last seen ${fmtDateOnly(user.lastLogin)}`
    : `never logged in`;
  return `
    <button type="button"
            class="login__user-btn"
            data-user-id="${esc(user.id)}"
            role="listitem">
      <span class="login__user-name">${esc(user.name)}</span>
      <span class="login__user-meta">
        <span class="login__user-role">${esc(roleLabel)}</span>
        <span class="login__user-last">${esc(lastSeen)}</span>
      </span>
    </button>
  `;
}

// -----------------------------------------------------------------------------
// PIN keypad
// -----------------------------------------------------------------------------

async function _renderPinKeypad() {
  const user = await Storage.users.get(_selectedUserId);
  if (!user) {
    // Shouldn't happen, but guard anyway — return to picker.
    await _renderUserPicker();
    return;
  }

  render(_root, `
    <div class="login">
      <div class="login__card">
        <header class="login__header">
          <button type="button" class="login__back" aria-label="Back to user list">‹ Back</button>
          <div class="login__user-summary">
            <div class="login__user-name">${esc(user.name)}</div>
            <div class="login__user-meta">${esc(AUTH.ROLES[user.role]?.label || user.role)}</div>
          </div>
        </header>
        <div class="login__body">
          <h2 class="login__heading">Enter PIN</h2>
          <div class="login__pin-display ${_pinRevealed ? 'is-revealed' : ''}"
               aria-live="polite"
               aria-label="${_pinBuffer.length} of 4 digits entered">
            ${_pinDisplayInnerHtml()}
          </div>
          <div class="login__error" role="alert" aria-live="assertive"></div>
          <div class="login__keypad" role="group" aria-label="PIN keypad">
            ${[1,2,3,4,5,6,7,8,9].map(_pinKeyHtml).join('')}
            <button type="button" class="login__key login__key--clear"
                    data-action="clear" aria-label="Clear PIN">⌫⌫</button>
            ${_pinKeyHtml(0)}
            <button type="button" class="login__key login__key--backspace"
                    data-action="backspace" aria-label="Backspace">⌫</button>
          </div>
          <div class="login__forgot-row">
            <button type="button" class="login__forgot-link" data-action="forgot-pin">
              Forgot PIN?
            </button>
          </div>
        </div>
      </div>
    </div>
  `);

  const card = $('.login__card', _root);
  card.addEventListener('click', _onKeypadClick);
  document.addEventListener('keydown', _onKeydown);

  // Stash the keydown unbinder so _teardownKeypad() can remove the global
  // listener when this view leaves.
  _root.__loginKeydownUnbind = () => {
    document.removeEventListener('keydown', _onKeydown);
  };

  // If this user is already locked out (e.g. returning to the keypad after
  // switching tabs), start the countdown immediately.
  const lockoutStatus = AUTH.getLockoutStatus(_selectedUserId);
  if (lockoutStatus.locked) {
    _startLockoutCountdown(lockoutStatus.unlockAt);
  }
}

function _pinDisplayInnerHtml() {
  return `
    ${_pinDotsHtml()}
    <button type="button"
            class="login__pin-toggle"
            data-action="toggle-reveal"
            aria-label="${_pinRevealed ? 'Hide PIN' : 'Show PIN'}"
            aria-pressed="${_pinRevealed}">
      ${_pinRevealed ? _ICON_EYE_OFF : _ICON_EYE}
    </button>
  `;
}

function _pinDotsHtml() {
  let dots = '';
  for (let i = 0; i < 4; i++) {
    const filled = i < _pinBuffer.length;
    let content;
    if (_pinRevealed && filled) {
      content = esc(_pinBuffer[i]);
    } else if (filled) {
      content = '●';
    } else {
      content = '○';
    }
    dots += `<span class="login__pin-dot ${filled ? 'is-filled' : ''}">${content}</span>`;
  }
  return dots;
}

function _pinKeyHtml(digit) {
  return `
    <button type="button"
            class="login__key"
            data-digit="${digit}"
            aria-label="${digit}">${digit}</button>
  `;
}

// -----------------------------------------------------------------------------
// Keypad input handling
// -----------------------------------------------------------------------------

async function _onKeypadClick(e) {
  if (_busy) return;

  const back = e.target.closest('.login__back');
  if (back) {
    _teardownKeypad();
    await _renderUserPicker();
    return;
  }

  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'toggle-reveal') {
    _pinRevealed = !_pinRevealed;
    _refreshPinDisplay();
    return;
  }
  if (action === 'clear') {
    _pinBuffer = '';
    _refreshPinDisplay();
    return;
  }
  if (action === 'backspace') {
    _pinBuffer = _pinBuffer.slice(0, -1);
    _refreshPinDisplay();
    return;
  }
  if (action === 'forgot-pin') {
    _openRecoveryFlowModal();
    return;
  }

  const digit = e.target.closest('[data-digit]')?.dataset.digit;
  if (digit !== undefined) {
    await _handleDigit(digit);
  }
}

function _onKeydown(e) {
  if (_busy) return;
  if (e.key >= '0' && e.key <= '9') {
    _handleDigit(e.key);
    e.preventDefault();
  } else if (e.key === 'Backspace') {
    _pinBuffer = _pinBuffer.slice(0, -1);
    _refreshPinDisplay();
    e.preventDefault();
  } else if (e.key === 'Escape') {
    _teardownKeypad();
    _renderUserPicker();
    e.preventDefault();
  }
}

async function _handleDigit(digit) {
  if (_pinBuffer.length >= 4) return;
  _pinBuffer += digit;
  _refreshPinDisplay();
  if (_pinBuffer.length === 4) {
    await _submitPin();
  }
}

function _refreshPinDisplay() {
  const display = $('.login__pin-display', _root);
  if (!display) return;
  display.classList.toggle('is-revealed', _pinRevealed);
  display.setAttribute('aria-label', `${_pinBuffer.length} of 4 digits entered`);
  display.innerHTML = _pinDisplayInnerHtml();
}

async function _submitPin() {
  _busy = true;
  const pin = _pinBuffer;
  _pinBuffer = '';   // never hold the typed PIN longer than the call

  let result;
  try {
    result = await AUTH.login(_selectedUserId, pin);
  } catch (err) {
    console.error('AUTH.login threw:', err);
    result = { ok: false, reason: 'thrown', error: err };
  }

  _busy = false;

  if (result.ok) {
    _teardownKeypad();
    // Check if this user has TOTP enabled — if so, gate on the code step
    // before completing the login. We pass the already-validated session
    // so that if the user abandons the TOTP step, the session is never
    // returned to the caller.
    const userRecord = await Storage.users.get(_selectedUserId);
    if (userRecord?.totpEnabled && userRecord?.totpSecret) {
      await _renderTotpStep(userRecord, result.session);
    } else {
      _onLoggedIn(result.session);
    }
    return;
  }

  // Failure path. Most common reason is invalid_pin. Show error, shake,
  // refresh display.
  if (result.reason === 'locked_out') {
    _startLockoutCountdown(result.unlockAt);
    return;
  }

  let msg;
  switch (result.reason) {
    case 'invalid_pin':         msg = 'Incorrect PIN. Try again.';                          break;
    case 'user_not_found':      msg = 'This account no longer exists.';                     break;
    case 'invalid_user_record': msg = 'Account is missing a PIN. Contact your CO or QM.';   break;
    case 'unknown_algorithm':   msg = 'Account uses an unsupported hash. Reset required.';  break;
    case 'thrown':              msg = 'Sign-in error. The app still works offline — try again or reload the page.'; break;
    default:                    msg = 'Sign-in failed. Try again or pick a different user.';
  }

  const errorEl = $('.login__error', _root);
  if (errorEl) errorEl.textContent = msg;

  const card = $('.login__card', _root);
  if (card) {
    card.classList.add('is-shaking');
    await sleep(400);
    card.classList.remove('is-shaking');
  }

  _refreshPinDisplay();
}

// -----------------------------------------------------------------------------
// TOTP verification step (step 3 of login)
// -----------------------------------------------------------------------------
// Shown only when the authenticated user has totpEnabled=true.
// Accepts both 6-digit TOTP codes and 8-char single-use backup codes.

async function _renderTotpStep(userRecord, session) {
  let _verifying  = false;
  let _useBackup  = false;

  const _render2FA = () => {
    render(_root, `
      <div class="login">
        <div class="login__card">
          <header class="login__header">
            <button type="button" class="login__back" aria-label="Back to PIN entry">‹ Back</button>
            <div class="login__user-summary">
              <div class="login__user-name">${esc(userRecord.name)}</div>
              <div class="login__user-meta">Two-factor authentication</div>
            </div>
          </header>
          <div class="login__body">
            <h2 class="login__heading">${_useBackup ? 'Enter backup code' : 'Enter authenticator code'}</h2>
            <p class="login__hint">
              ${_useBackup
                ? 'Enter one of your 8-character backup codes.'
                : 'Open your authenticator app and enter the 6-digit code.'}
            </p>
            <div class="login__totp-wrap">
              <input type="text"
                     id="login-totp-input"
                     class="login__totp-input"
                     inputmode="${_useBackup ? 'text' : 'numeric'}"
                     ${_useBackup ? '' : 'pattern="\\d{6}" maxlength="6"'}
                     ${_useBackup ? 'maxlength="8"' : ''}
                     autocomplete="one-time-code"
                     spellcheck="false"
                     placeholder="${_useBackup ? 'XXXXXXXX' : '000000'}"
                     aria-label="${_useBackup ? 'Backup code' : '6-digit authenticator code'}">
            </div>
            <div class="login__error" role="alert" aria-live="assertive"></div>
            <div class="login__totp-actions">
              <button type="button" class="login__forgot-link" data-action="toggle-backup">
                ${_useBackup ? 'Use authenticator code instead' : 'Use a backup code instead'}
              </button>
            </div>
          </div>
        </div>
      </div>
    `);

    const input = $('#login-totp-input', _root);
    if (input) {
      input.focus();
      input.addEventListener('input', () => {
        if (!_useBackup) {
          input.value = input.value.replace(/\D/g, '').slice(0, 6);
          if (input.value.length === 6) _doVerify();
        } else {
          input.value = input.value.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase();
          if (input.value.length === 8) _doVerify();
        }
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') _doVerify();
      });
    }

    const card = $('.login__card', _root);
    if (card) {
      card.addEventListener('click', async (e) => {
        const back   = e.target.closest('.login__back');
        const action = e.target.closest('[data-action]')?.dataset.action;
        if (back) {
          // Back to PIN — clear session, re-render keypad
          _selectedUserId = userRecord.id;
          _pinBuffer = '';
          await _renderPinKeypad();
          return;
        }
        if (action === 'toggle-backup') {
          _useBackup = !_useBackup;
          _render2FA();
          return;
        }
      });
    }
  };

  const _doVerify = async () => {
    if (_verifying) return;
    const input  = $('#login-totp-input', _root);
    const errEl  = $('.login__error',     _root);
    const code   = input?.value?.trim() || '';
    if (!code) return;

    _verifying = true;
    if (errEl) errEl.textContent = '';

    try {
      if (_useBackup) {
        // Backup code path
        const remaining = userRecord.totpHashedBackups || [];
        const idx = await TOTP.verifyBackupCode(code, remaining);
        if (idx < 0) {
          _verifying = false;
          if (errEl) errEl.textContent = 'Backup code not recognised or already used.';
          if (input) { input.value = ''; input.focus(); }
          return;
        }
        // Consume the code
        const newBackups = remaining.filter((_, i) => i !== idx);
        await Storage.users.put({ ...userRecord, totpHashedBackups: newBackups });
        await Storage.audit.append({
          action: '2fa_backup_used',
          user:   userRecord.name || userRecord.id,
          desc:   `Backup code used for login. ${newBackups.length} remaining.`,
        });
      } else {
        // TOTP path
        const result = await TOTP.verify(
          userRecord.totpSecret,
          code,
          { lastUsedStep: userRecord.totpLastUsedStep ?? -1 },
        );
        if (!result.ok) {
          _verifying = false;
          if (errEl) errEl.textContent = 'Code incorrect or expired — check your device clock and try again.';
          if (input) { input.value = ''; input.focus(); }
          return;
        }
        // Update replay guard
        await Storage.users.put({ ...userRecord, totpLastUsedStep: result.step });
      }

      // Success — hand off to the shell
      _onLoggedIn(session);
    } catch (err) {
      _verifying = false;
      console.error('TOTP verification error:', err);
      if (errEl) errEl.textContent = 'Verification error — please try again.';
    }
  };

  _render2FA();
}

function _startLockoutCountdown(unlockAt) {
  if (_lockoutTimer) clearInterval(_lockoutTimer);

  const errorEl  = $('.login__error', _root);
  const keypad   = $('.login__keypad', _root);
  if (keypad) keypad.setAttribute('aria-disabled', 'true');
  $$('.login__key', _root).forEach((b) => b.disabled = true);

  const _tick = () => {
    const secs = Math.ceil((unlockAt - Date.now()) / 1000);
    if (secs <= 0) {
      clearInterval(_lockoutTimer);
      _lockoutTimer = null;
      if (errorEl) errorEl.textContent = '';
      if (keypad) keypad.removeAttribute('aria-disabled');
      $$('.login__key', _root).forEach((b) => b.disabled = false);
      _refreshPinDisplay();
      return;
    }
    const mins = Math.floor(secs / 60);
    const display = mins >= 1
      ? `${mins} minute${mins !== 1 ? 's' : ''}`
      : `${secs} second${secs !== 1 ? 's' : ''}`;
    if (errorEl) errorEl.textContent =
      `Too many incorrect PINs. Please wait ${display} before trying again.`;
  };

  _tick();
  _lockoutTimer = setInterval(_tick, 1000);
}

function _teardownKeypad() {
  if (_lockoutTimer) { clearInterval(_lockoutTimer); _lockoutTimer = null; }
  if (_root?.__loginKeydownUnbind) {
    _root.__loginKeydownUnbind();
    delete _root.__loginKeydownUnbind;
  }
}


// -----------------------------------------------------------------------------
// Recovery-flow modal (Forgot PIN)
// -----------------------------------------------------------------------------
// Two-step modal:
//   Step 1: enter recovery code.
//   Step 2: enter new PIN (twice, must match, must not be 0000).
//
// On success, dismisses with a confirmation that the PIN has been reset and
// returns the user to the keypad to log in normally with the new PIN. We
// deliberately don't auto-login from here — the user just typed the new
// PIN so we know they have it; making them enter it again at the keypad
// is a small confirmation that nothing typoed in the modal.

function _openRecoveryFlowModal() {
  const userId = _selectedUserId;

  openModal({
    titleHtml: 'Reset PIN with recovery code',
    size:      'sm',
    bodyHtml:  `
      <p class="modal__body">
        Enter your recovery code to set a new PIN. The code will be consumed
        on success &mdash; you'll need to generate a new one from Settings
        after you next log in if you want continued recovery coverage.
      </p>
      <form class="form" data-form="recovery-flow" autocomplete="off">
        <label class="form__field">
          <span class="form__label">Recovery code</span>
          <input type="text" name="code" required spellcheck="false"
                 autocapitalize="characters" inputmode="text"
                 placeholder="XXXX-XXXX-XXXX"
                 class="form__input--code">
        </label>
        <label class="form__field">
          <span class="form__label">New PIN</span>
          <input type="password" name="newPin" inputmode="numeric"
                 pattern="\\d{4}" maxlength="4" required
                 autocomplete="new-password" class="form__input--pin">
        </label>
        <label class="form__field">
          <span class="form__label">Confirm new PIN</span>
          <input type="password" name="confirmPin" inputmode="numeric"
                 pattern="\\d{4}" maxlength="4" required
                 autocomplete="new-password" class="form__input--pin">
        </label>
        <div class="form__error" role="alert"></div>
        <div class="form__actions">
          <button type="button" class="btn btn--ghost" data-action="modal-close">Cancel</button>
          <button type="submit" class="btn btn--primary">Reset PIN</button>
        </div>
      </form>
    `,
    onMount(panel, close) {
      const form  = $('form[data-form="recovery-flow"]', panel);
      const errEl = $('.form__error', panel);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errEl.textContent = '';
        const fd = new FormData(form);
        const code       = String(fd.get('code')       || '');
        const newPin     = String(fd.get('newPin')     || '');
        const confirmPin = String(fd.get('confirmPin') || '');

        if (!/^\d{4}$/.test(newPin)) {
          errEl.textContent = 'PIN must be exactly 4 digits.';
          return;
        }
        if (newPin !== confirmPin) {
          errEl.textContent = 'PINs do not match.';
          return;
        }
        if (newPin === '0000') {
          errEl.textContent = '0000 is the default. Choose a different PIN.';
          return;
        }

        let result;
        try {
          result = await AUTH.resetPinWithRecoveryCode(userId, code, newPin);
        } catch (err) {
          errEl.textContent = err.message || 'Reset failed.';
          return;
        }

        if (result?.ok) {
          close();
          // Clear the PIN buffer and re-render the keypad so the user can
          // log in normally with the new PIN.
          _pinBuffer = '';
          _refreshPinDisplay();
          // Show a one-line flash via the keypad's existing error slot,
          // styled neutrally — we reuse the alert region for both errors
          // and confirmations because the keypad doesn't have its own
          // toast component yet (v2.1 backlog item).
          const flashEl = $('.login__error', _root);
          if (flashEl) {
            flashEl.textContent = 'PIN reset. Enter your new PIN to sign in.';
          }
          return;
        }

        const reasonMsg = {
          invalid_code: 'Recovery code is incorrect.',
          invalid_pin:  'New PIN is invalid.',
          no_recovery:  'No active recovery code for this user. The code may have already been used.',
        }[result?.reason] || 'Reset failed.';
        errEl.textContent = reasonMsg;
      });
    },
  });
}
