// =============================================================================
// QStore IMS v2 — App shell
// =============================================================================
// Top-level orchestrator. Holds the layout chrome (header, nav, content area,
// banner) and decides which page-module to mount in the content area based
// on the current session and route.
//
// PAGE LIFECYCLE
//   Each page module exports `mount(rootEl)` which returns an unmount
//   function. The shell calls the previous page's unmount before mounting
//   the next one. This lets pages clean up listeners, object URLs, etc.
//
// ROUTES
//   No URL routing in v2.0 — pages are picked by an in-memory string.
//   When we add hash-routing later (v2.1+), it slots in here without
//   touching page modules.
//
// DEFAULT-PIN BANNER
//   Persistent banner shown across all pages while session.pinIsDefault is
//   true. Clears automatically after a successful PIN change.
// =============================================================================

import { logBanner, checkOrigin, checkIntegrity } from '../fingerprint.js';
import { showSplash } from './splash.js';
import * as Storage   from '../storage.js';
import * as AUTH      from '../auth.js';
import * as Sync      from '../sync.js';
import * as Login     from './login.js';
import * as Dashboard from './dashboard.js';
import * as Inventory from './inventory.js';
import * as Loans     from './loans.js';
import * as Cadets    from './cadets.js';
import * as Stocktake from './stocktake.js';
import * as Audit     from './audit.js';
import * as Users     from './users.js';
import * as Settings  from './settings.js';
import * as Help      from './help.js';
import * as Orders    from './orders.js';
import * as Reference from './reference.js';
import { openModal }  from './modal.js';
import { esc, $, render } from './util.js';

const PAGES = {
  dashboard: { label: 'Home',      perm: 'view',     mount: Dashboard.mount },
  inventory: { label: 'Inventory', perm: 'view',     mount: Inventory.mount },
  loans:     { label: 'Loans',     perm: 'view',     mount: Loans.mount     },
  cadets:    { label: 'Cadets',    perm: 'view',     mount: Cadets.mount    },
  stocktake: { label: 'Stocktake', perm: 'editItem', mount: Stocktake.mount },
  orders:    { label: 'Orders',    perm: 'editItem', mount: Orders.mount    },
  audit:     { label: 'Audit',     perm: 'audit',    mount: Audit.mount     },
  users:     { label: 'Users',     coOnly: true,     mount: Users.mount     },
  settings:  { label: 'Settings',  coOnly: true,     mount: Settings.mount  },
  reference: { label: 'Reference',  perm: 'view',     mount: Reference.mount },
  help:      { label: 'Help',      perm: 'view',     mount: Help.mount      },
};

const DEFAULT_PAGE = 'dashboard';

let _root             = null;
let _session          = null;
let _currentPage      = null;
let _currentUnmount   = null;

// -----------------------------------------------------------------------------
// Auto-lock (idle timeout)
// -----------------------------------------------------------------------------
// Reads 'security.idleTimeoutMinutes' from settings. 0 = disabled.
// On idle expiry, a full-screen lock overlay is shown over the current page.
// The user must enter their PIN to resume, or click "Sign out" to log out.

let _idleTimerHandle  = null;
let _idleTimeoutMs    = 0;
let _lockOverlay      = null;

const _IDLE_EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click'];

function _onIdleActivity() {
  _resetIdleTimer();
}

async function _startIdleWatcher() {
  _stopIdleWatcher();
  const raw  = await Storage.settings.get('security.idleTimeoutMinutes');
  const mins = parseInt(raw, 10);
  if (!mins || mins <= 0) return;                // disabled
  _idleTimeoutMs = mins * 60_000;
  _IDLE_EVENTS.forEach(ev =>
    document.addEventListener(ev, _onIdleActivity, { passive: true })
  );
  _resetIdleTimer();
}

function _stopIdleWatcher() {
  if (_idleTimerHandle) { clearTimeout(_idleTimerHandle); _idleTimerHandle = null; }
  _IDLE_EVENTS.forEach(ev => document.removeEventListener(ev, _onIdleActivity));
  _idleTimeoutMs = 0;
}

function _resetIdleTimer() {
  if (!_idleTimeoutMs) return;
  if (_idleTimerHandle) clearTimeout(_idleTimerHandle);
  _idleTimerHandle = setTimeout(_triggerLock, _idleTimeoutMs);
}

function _triggerLock() {
  if (_lockOverlay) return;   // already locked
  _stopIdleWatcher();         // pause activity tracking while locked
  _showLockOverlay();
}

function _showLockOverlay() {
  const overlay = document.createElement('div');
  overlay.className = 'lock-overlay';

  overlay.innerHTML = `
    <div class="lock-card">
      <div class="lock-icon" aria-hidden="true">🔒</div>
      <h2 class="lock-title">Session Locked</h2>
      <p class="lock-body">
        Signed in as <strong>${esc(_session?.name || 'Unknown')}</strong>
      </p>
      <form class="lock-form" autocomplete="off" data-form="lock-form">
        <input type="text" inputmode="numeric" pattern="\\d{4}" maxlength="4"
               class="form__input--pin lock-pin"
               placeholder="Enter PIN" autocomplete="off"
               aria-label="Enter PIN to unlock" autofocus>
        <div class="form__error lock-error" role="alert"></div>
        <button type="submit" class="btn btn--primary lock-submit">Unlock</button>
      </form>
      <button type="button" class="btn btn--ghost lock-switch"
              data-action="lock-switch-user">Sign out / switch user</button>
    </div>
  `;

  document.body.appendChild(overlay);
  _lockOverlay = overlay;

  // Focus the PIN field after the overlay is painted.
  const pinInput = overlay.querySelector('.lock-pin');
  if (pinInput) requestAnimationFrame(() => pinInput.focus());

  const form      = overlay.querySelector('[data-form="lock-form"]');
  const errEl     = overlay.querySelector('.lock-error');
  const switchBtn = overlay.querySelector('[data-action="lock-switch-user"]');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.textContent = '';

    const enteredPin = (pinInput.value || '').trim();
    if (!/^\d{4}$/.test(enteredPin)) {
      errEl.textContent = 'Enter your 4-digit PIN.';
      return;
    }

    const submit = form.querySelector('[type="submit"]');
    if (submit) { submit.disabled = true; submit.textContent = 'Checking…'; }

    const result = await AUTH.verifyPin(_session.userId, enteredPin);

    if (result.ok) {
      _hideLockOverlay();
      await _startIdleWatcher();     // restart idle watcher after successful unlock
    } else {
      if (submit) { submit.disabled = false; submit.textContent = 'Unlock'; }
      pinInput.value = '';
      pinInput.focus();
      if (result.reason === 'locked_out') {
        const secs = Math.ceil(Math.max(0, (result.unlockAt - Date.now())) / 1000);
        errEl.textContent = `Too many failed attempts. Try again in ${secs} second${secs === 1 ? '' : 's'}.`;
      } else {
        errEl.textContent = 'Incorrect PIN. Try again.';
      }
    }
  });

  switchBtn.addEventListener('click', () => {
    _hideLockOverlay();
    _onLogout();
  });
}

function _hideLockOverlay() {
  if (_lockOverlay) { _lockOverlay.remove(); _lockOverlay = null; }
}

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------

export async function boot(rootEl) {
  _root = rootEl;
  logBanner();
  checkOrigin();
  // Integrity check deferred briefly so the DOM is fully parsed first.
  setTimeout(checkIntegrity, 1500);

  // Show splash immediately — runs for at least 5 seconds in parallel with boot.
  const splash = showSplash();

  try {
    await Storage.init();
    await Storage.requestPersistence();

    // Restore logo from localStorage mirror if IndexedDB has lost it.
    // This helps when the HTML file is upgraded at the same origin/path
    // (GitHub Pages update, or overwriting a local file at the same path).
    try {
      const existingLogo = await Storage.settings.get('unitLogo');
      if (!existingLogo) {
        const mirror = localStorage.getItem('qstore2_logo');
        if (mirror) {
          await Storage.settings.set('unitLogo', mirror);
          console.info('[QStore IMS] Logo restored from local mirror.');
        }
      }
    } catch (_) { /* non-fatal */ }

    // Push logo / unit name into the splash as soon as storage is ready.
    try {
      const s = await Storage.settings.getAll();
      splash.setContent({ logo: s.unitLogo || null, name: s.unitName || '', code: s.unitCode || '' });
    } catch (_) { /* non-fatal — splash continues without logo */ }

    _session = await AUTH.init();
    await AUTH.ensureDefaultAdmin();
    // Initialise sync after auth — sync may write audit entries which
    // depend on auth.getSession() for the user attribution.
    await Sync.init();

    // Wait for the full 5-second minimum before handing off.
    await splash.wait;
    splash.dismiss();

    if (_session) {
      await _renderShell();
    } else {
      await _mountLogin();
    }
  } catch (err) {
    console.error('Boot failed:', err);
    splash.dismiss();
    _renderFatalError(err);
  }
}

// -----------------------------------------------------------------------------
// Login
// -----------------------------------------------------------------------------

async function _mountLogin() {
  _session = null;
  await _teardownCurrentPage();
  await Login.mount(_root, {
    onLoggedIn: async (session) => {
      _session = session;
      await _renderShell();
    },
  });
}

// -----------------------------------------------------------------------------
// Shell layout
// -----------------------------------------------------------------------------

async function _renderShell() {
  const settings  = await Storage.settings.getAll();
  const unitName  = settings.unitName || 'QStore IMS';
  const unitCode  = settings.unitCode || '';
  const unitLogo  = settings.unitLogo  || null;
  const showBanner = _session.pinIsDefault === true;

  const initialPage = _pickInitialPage();
  _currentPage = initialPage;

  render(_root, `
    <div class="shell">
      <header class="shell__header">
        <div class="shell__brand">
          ${unitLogo ? `<img class="shell__brand-logo" src="${esc(unitLogo)}" alt="">` : ''}
          <div class="shell__brand-text">
            <div class="shell__brand-name">${esc(unitName)}</div>
            ${unitCode ? `<div class="shell__brand-code">${esc(unitCode)}</div>` : ''}
          </div>
        </div>
        <nav class="shell__nav" aria-label="Main">
          ${_navHtml(initialPage)}
          <div class="shell__nav-user">
            <div class="shell__nav-username">${esc(_session.name)}</div>
            <div class="shell__nav-userrole">${esc(AUTH.ROLES[_session.role]?.label || _session.role)}</div>
          </div>
          <button type="button" class="shell__nav-signout" data-action="logout">Sign out</button>
        </nav>
        <div class="shell__sync" data-target="sync-indicator" title="Cloud sync status"></div>
        <div class="shell__session">
          <div class="shell__session-name">${esc(_session.name)}</div>
          <div class="shell__session-role">${esc(AUTH.ROLES[_session.role]?.label || _session.role)}</div>
        </div>
        <button type="button" class="shell__logout" data-action="logout">Sign out</button>
        <button type="button" class="shell__hamburger" aria-expanded="false"
                aria-label="Open menu" data-action="toggle-nav">
          <span></span><span></span><span></span>
        </button>
      </header>

      ${showBanner ? _defaultPinBannerHtml() : ''}

      <main class="shell__main" data-target="page-content">
        <div class="shell__loading">Loading…</div>
      </main>
    </div>
  `);

  // Wire logout buttons (desktop header + mobile nav).
  _root.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="logout"]')) _onLogout();
  });

  const nav       = $('.shell__nav', _root);
  const hamburger = $('.shell__hamburger', _root);
  if (nav) nav.addEventListener('click', _onNavClick);

  // Hamburger toggle — shows/hides nav overlay on mobile.
  if (hamburger && nav) {
    hamburger.addEventListener('click', () => {
      const open = nav.classList.toggle('is-open');
      hamburger.setAttribute('aria-expanded', String(open));
      hamburger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    });

    // Close nav overlay when user clicks outside (tap on content area).
    const _docClick = (e) => {
      if (!_root) { document.removeEventListener('click', _docClick); return; }
      if (!nav.classList.contains('is-open')) return;
      if (!nav.contains(e.target) && !hamburger.contains(e.target)) {
        nav.classList.remove('is-open');
        hamburger.setAttribute('aria-expanded', 'false');
        hamburger.setAttribute('aria-label', 'Open menu');
      }
    };
    // Use capture so the outside-click fires before any other handler.
    document.addEventListener('click', _docClick, true);
  }

  // Dashboard quick-action tiles dispatch a custom event to navigate.
  _root.addEventListener('dash:navigate', (e) => {
    const page = e.detail?.page;
    if (page && PAGES[page]) _navigateTo(page);
  });

  // Re-apply idle timeout when OC changes the setting in Settings.
  document.addEventListener('qstore:idle-timeout-changed', _startIdleWatcher);

  // Start idle watcher for this session.
  await _startIdleWatcher();

  const syncIndicator = $('[data-target="sync-indicator"]', _root);
  if (syncIndicator) {
    syncIndicator.addEventListener('click', () => {
      if (PAGES.settings && _hasAccessTo(PAGES.settings)) {
        _navigateTo('settings');
      }
    });
  }

  if (showBanner) {
    _wireDefaultPinFlow();
  }

  // Subscribe to sync status updates and surface them in the header.
  // Listener removed via _teardownCurrentPage on logout (boot path also
  // re-renders the shell when re-mounting after login, so the listener
  // stays bound for the session lifetime).
  Sync.addStatusListener(_onSyncStatus);

  await _mountPage(initialPage);
}

function _onSyncStatus(status) {
  if (!_root) return;
  const el = $('[data-target="sync-indicator"]', _root);
  if (!el) return;
  el.className = `shell__sync shell__sync--${esc(status.state)}`;
  el.innerHTML = _syncIndicatorHtml(status);
}

function _syncIndicatorHtml(status) {
  const symbol = {
    'unconfigured':  '○',
    'not-signed-in': '○',
    'signed-in':     '✓',
    'busy':          '⟳',
    'error':         '!',
  }[status.state] || '?';
  const label = {
    'unconfigured':  'Cloud sync off',
    'not-signed-in': 'Sign in to sync',
    'signed-in':     status.pending ? 'Sync pending' : 'Synced',
    'busy':          'Syncing…',
    'error':         status.lastError ? 'Sync error' : 'Sync error',
  }[status.state] || status.state;
  return `
    <span class="shell__sync-icon">${esc(symbol)}</span>
    <span class="shell__sync-label">${esc(label)}</span>
  `;
}

function _navHtml(activePage) {
  return Object.entries(PAGES)
    .filter(([, def]) => _hasAccessTo(def))
    .map(([key, def]) => `
      <button type="button"
              class="shell__nav-link ${key === activePage ? 'is-active' : ''}"
              data-page="${esc(key)}">
        ${esc(def.label)}
      </button>
    `).join('');
}

function _hasAccessTo(pageDef) {
  if (pageDef.coOnly) return AUTH.isCO();
  if (pageDef.perm)   return AUTH.can(pageDef.perm) || AUTH.isCO();
  return true;
}

function _pickInitialPage() {
  if (PAGES[DEFAULT_PAGE] && _hasAccessTo(PAGES[DEFAULT_PAGE])) {
    return DEFAULT_PAGE;
  }
  for (const [key, def] of Object.entries(PAGES)) {
    if (_hasAccessTo(def)) return key;
  }
  return null;
}

async function _onNavClick(e) {
  const link = e.target.closest('[data-page]');
  if (!link) return;
  // Close the mobile nav overlay if it's open.
  const nav       = _root?.querySelector('.shell__nav');
  const hamburger = _root?.querySelector('.shell__hamburger');
  if (nav?.classList.contains('is-open')) {
    nav.classList.remove('is-open');
    hamburger?.setAttribute('aria-expanded', 'false');
    hamburger?.setAttribute('aria-label', 'Open menu');
  }
  await _navigateTo(link.dataset.page);
}

async function _navigateTo(page) {
  if (page === _currentPage) return;
  if (!PAGES[page]) return;
  if (!_hasAccessTo(PAGES[page])) return;

  _currentPage = page;
  const links = _root.querySelectorAll('.shell__nav-link');
  links.forEach(a => a.classList.toggle('is-active', a.dataset.page === page));

  await _mountPage(page);
}

async function _mountPage(pageKey) {
  await _teardownCurrentPage();

  // Update overdue badge on the Loans nav item before each page mount.
  // Non-blocking — badge update failure must not prevent navigation.
  _updateOverdueBadge().catch(() => {});

  const target = $('[data-target="page-content"]', _root);
  if (!target) return;
  if (!pageKey || !PAGES[pageKey]) {
    target.innerHTML = `<div class="shell__placeholder"><h2>No accessible pages</h2><p>Your account doesn't have permission for any page. Contact your CO or QM.</p></div>`;
    return;
  }
  try {
    _currentUnmount = await PAGES[pageKey].mount(target);
  } catch (err) {
    console.error(`Mount failed for page "${pageKey}":`, err);
    target.innerHTML = `
      <div class="fatal">
        <h1>This page failed to load</h1>
        <p>Try refreshing the page (press <kbd>F5</kbd>). If the problem keeps
           happening, export a backup from Settings → Data and contact your system
           administrator.</p>
        <details class="fatal__details-toggle">
          <summary>Technical detail</summary>
          <pre class="fatal__detail">${esc(err.message || String(err))}</pre>
        </details>
      </div>
    `;
  }
}

async function _updateOverdueBadge() {
  if (!_root) return;
  const loansNavBtn = _root.querySelector('.shell__nav-link[data-page="loans"]');
  if (!loansNavBtn) return;

  const today = new Date().toISOString().slice(0, 10);
  const active = await Storage.loans.listActive();
  const overdueCount = active.filter(l => !l.longTermLoan && l.dueDate && l.dueDate < today).length;

  // The label is always "Loans"; we replace it to add/remove the badge.
  if (overdueCount > 0) {
    loansNavBtn.innerHTML =
      `Loans <span class="shell__nav-badge">${overdueCount}</span>`;
  } else {
    loansNavBtn.textContent = 'Loans';
  }
}

async function _teardownCurrentPage() {
  if (typeof _currentUnmount === 'function') {
    try { _currentUnmount(); }
    catch (e) { console.error('page unmount error:', e); }
  }
  _currentUnmount = null;
}

// -----------------------------------------------------------------------------
// Default-PIN banner + modal
// -----------------------------------------------------------------------------

function _defaultPinBannerHtml() {
  return `
    <div class="shell__banner shell__banner--warn" role="alert">
      <strong>Default PIN in use.</strong>
      You're signed in as the default Administrator with PIN 0000. Set a new
      PIN now to secure this account.
      <button type="button" class="shell__banner-action" data-action="open-pin-modal">
        Change PIN
      </button>
    </div>
  `;
}

function _wireDefaultPinFlow() {
  const banner = $('.shell__banner-action', _root);
  banner?.addEventListener('click', _openSetPinModal);
}

function _openSetPinModal() {
  openModal({
    titleHtml: 'Set a new PIN',
    size: 'sm',
    bodyHtml: `
      <p class="modal__body">
        Choose a 4-digit PIN. This replaces the default. Don't pick something
        obvious like 1234 or your service number.
      </p>
      <form class="form" data-form="set-pin" autocomplete="off">
        <label class="form__field">
          <span class="form__label">New PIN</span>
          <input type="password" name="newPin" inputmode="numeric"
                 pattern="\\d{4}" maxlength="4" required
                 autocomplete="new-password" class="form__input--pin">
        </label>
        <label class="form__field">
          <span class="form__label">Confirm PIN</span>
          <input type="password" name="confirmPin" inputmode="numeric"
                 pattern="\\d{4}" maxlength="4" required
                 autocomplete="new-password" class="form__input--pin">
        </label>
        <div class="form__error" role="alert"></div>
        <div class="form__actions">
          <button type="button" class="btn btn--ghost" data-action="modal-close">Later</button>
          <button type="submit" class="btn btn--primary">Save PIN</button>
        </div>
      </form>
    `,
    onMount(panel, close) {
      const form  = $('form[data-form="set-pin"]', panel);
      const errEl = $('.form__error', panel);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errEl.textContent = '';
        const fd = new FormData(form);
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
        try {
          // Ask AUTH to generate a recovery code as part of the PIN-set.
          // For OC accounts replacing the default PIN, this is the only
          // recovery path back if they later forget the new PIN. The flag
          // is harmless for non-OC users — AUTH ignores it for them.
          const result = await AUTH.setPin(_session.userId, newPin, {
            generateRecovery: true,
          });
          // AUTH.setPin updated session state for us — pull the fresh copy.
          _session = AUTH.getSession();
          Sync.notifyChanged();
          close();
          // Remove the banner without re-rendering the whole shell, so the
          // user keeps their current page and scroll position.
          const banner = $('.shell__banner', _root);
          if (banner) banner.remove();
          // If a recovery code was generated, show it in a follow-up modal.
          // The user MUST acknowledge they have stored it before the modal
          // closes — the code is shown only here and in settings; we don't
          // store the plaintext anywhere.
          if (result?.recoveryCode) {
            _openRecoveryCodeModal(result.recoveryCode, { reason: 'initial' });
          }
        } catch (err) {
          errEl.textContent = err.message || 'Failed to set PIN.';
        }
      });
    },
  });
}

// -----------------------------------------------------------------------------
// Recovery code display modal
// -----------------------------------------------------------------------------
// Shown once after PIN-set generates a recovery code, and on demand from
// settings (with reason: 'manual'). The code is plaintext and we make NO
// effort to obscure it on screen — the whole point is for the user to
// read and write it down. We do strongly emphasise the off-device storage
// guidance, because writing it on a sticky note next to the laptop
// defeats the entire mechanism.

function _openRecoveryCodeModal(formattedCode, { reason } = {}) {
  const headline = reason === 'rotated'
    ? 'New recovery code generated'
    : reason === 'manual'
    ? 'Your recovery code'
    : 'Save your recovery code';

  const intro = reason === 'rotated'
    ? `Your previous recovery code is no longer valid. Use the new code below.`
    : reason === 'manual'
    ? `This is your current recovery code. If you've lost the previous copy, write this one down and discard the old.`
    : `Now that you've set a real PIN, here's your one-shot recovery code. Use it from the login screen if you ever forget your PIN.`;

  openModal({
    titleHtml: esc(headline),
    size:      'sm',
    bodyHtml:  `
      <p class="modal__body">\${esc(intro)}</p>
      <div class="recovery-code__display" role="textbox" aria-readonly="true"
           aria-label="Recovery code">\${esc(formattedCode)}</div>
      <div class="modal__warn">
        <strong>Store this code OFF this device.</strong> A printed copy in a
        sealed envelope in the unit safe, or on a key cabinet, is appropriate.
        Anyone with this code can reset the OC PIN and gain administrative
        access &mdash; treat it with the same care as the safe combination.
      </div>
      <p class="modal__body modal__body--small">
        Using the code resets your PIN and consumes the code. You'll need to
        generate a new one from Settings afterwards if you want continued
        recovery coverage.
      </p>
      <form class="form" data-form="ack-recovery">
        <label class="form__field">
          <input type="checkbox" name="ack" required>
          I have stored this code somewhere safe.
        </label>
        <div class="form__actions">
          <button type="submit" class="btn btn--primary" disabled
                  data-action="ack-submit">Done</button>
        </div>
      </form>
    `,
    onMount(panel, close) {
      const form = $('form[data-form="ack-recovery"]', panel);
      const cb   = $('input[name="ack"]', panel);
      const btn  = $('button[data-action="ack-submit"]', panel);
      cb.addEventListener('change', () => { btn.disabled = !cb.checked; });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (cb.checked) close();
      });
    },
  });
}

// -----------------------------------------------------------------------------
// Logout
// -----------------------------------------------------------------------------

async function _onLogout() {
  _stopIdleWatcher();
  _hideLockOverlay();
  document.removeEventListener('qstore:idle-timeout-changed', _startIdleWatcher);
  await _teardownCurrentPage();
  Sync.removeStatusListener(_onSyncStatus);
  await AUTH.logout();
  await _mountLogin();
}

// -----------------------------------------------------------------------------
// Fatal error renderer
// -----------------------------------------------------------------------------

function _renderFatalError(err) {
  render(_root, `
    <div class="fatal">
      <h1>Something went wrong</h1>
      <p>The application failed to start. Try a hard refresh
         (Ctrl+Shift+R). If the problem persists, contact your CO or QM.</p>
      <pre class="fatal__detail">${esc(err.message || String(err))}</pre>
    </div>
  `);
}
