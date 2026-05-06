// =============================================================================
// QStore IMS v2 — Login screen
// =============================================================================
// Two-step flow:
//   1. User picker  — list of all users in the unit, sorted by role then name
//   2. PIN keypad   — 4-digit entry, auto-submits on 4th digit
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
// =============================================================================

import * as Storage from '../storage.js';
import * as AUTH    from '../auth.js';
import { esc, $, $$, render, fmtDateOnly, sleep } from './util.js';

const ROLE_ORDER = ['co', 'qm', 'staff', 'cadet', 'ro'];

let _root           = null;
let _onLoggedIn     = null;
let _selectedUserId = null;
let _pinBuffer      = '';
let _pinRevealed    = false;
let _busy           = false;

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
}

function _pinDisplayInnerHtml() {
  return `
    ${_pinDotsHtml()}
    <button type="button"
            class="login__pin-toggle"
            data-action="toggle-reveal"
            aria-label="${_pinRevealed ? 'Hide PIN' : 'Show PIN'}"
            aria-pressed="${_pinRevealed}">
      ${_pinRevealed ? '🙈' : '👁'}
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
    _onLoggedIn(result.session);
    return;
  }

  // Failure path. Most common reason is invalid_pin. Show error, shake,
  // refresh display.
  let msg;
  switch (result.reason) {
    case 'invalid_pin':         msg = 'Incorrect PIN. Try again.';                          break;
    case 'user_not_found':      msg = 'This account no longer exists.';                     break;
    case 'invalid_user_record': msg = 'Account is missing a PIN. Contact your CO or QM.';   break;
    case 'unknown_algorithm':   msg = 'Account uses an unsupported hash. Reset required.';  break;
    case 'thrown':              msg = 'Sign-in error. Check your connection and reload.';   break;
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

function _teardownKeypad() {
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
