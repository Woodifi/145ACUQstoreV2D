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
import * as TOTP      from '../totp.js';
import * as Orders    from './orders.js';
import * as Requests  from './requests.js';
import * as Reference  from './reference.js';
import * as Staff      from './staff.js';
import * as ImsReports from './ims-reports.js';
import { openModal }  from './modal.js';
import { esc, $, render } from './util.js';
import { applyStoredTheme, applyTheme } from '../theme.js';
import { getLicenseState } from '../license.js';
import * as Shortcuts from './shortcuts.js';

const PAGES = {
  dashboard:  { label: 'Home',      perm: 'view',         mount: Dashboard.mount  },
  inventory:  { label: 'Inventory', perm: 'view',         mount: Inventory.mount  },
  loans:      { label: 'Loans',     perm: 'view',         mount: Loans.mount      },
  cadets:     { label: 'Cadets',    perm: 'view',         mount: Cadets.mount     },
  staff:      { label: 'Staff',     perm: 'view',         mount: Staff.mount,      notForCadet: true },
  stocktake:  { label: 'Stocktake', perm: 'editItem',     mount: Stocktake.mount  },
  orders:     { label: 'Orders',    perm: 'editItem',     mount: Orders.mount     },
  requests:   { label: 'Requests',  perm: 'requestIssue', mount: Requests.mount   },
  reports:    { label: 'Reports',   perm: 'audit',        mount: ImsReports.mount },
  audit:      { label: 'Audit',     perm: 'audit',        mount: Audit.mount      },
  users:      { label: 'Users',     coOnly: true,         mount: Users.mount      },
  settings:   { label: 'Settings',  coOnly: true,         mount: Settings.mount   },
  reference:  { label: 'Reference', perm: 'view',         mount: Reference.mount  },
  help:       { label: 'Help',      perm: 'view',         mount: Help.mount       },
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
let _lastActivityAt   = 0;   // wall-clock ms of last user activity
let _lockOverlay      = null;

// Default timeout when the setting has never been saved (new installs).
const _IDLE_DEFAULT_MINS = 15;

const _IDLE_EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click'];

function _onIdleActivity() {
  _lastActivityAt = Date.now();
  _resetIdleTimer();
}

// Fired when the tab/window becomes visible again (covers OS sleep/wake and
// tab switches).  setTimeout is suspended during sleep so we must compare
// wall-clock elapsed time rather than trusting the remaining timer.
function _onVisibilityChange() {
  if (document.visibilityState !== 'visible') return;
  if (!_idleTimeoutMs || _lockOverlay) return;
  const elapsed = Date.now() - _lastActivityAt;
  if (elapsed >= _idleTimeoutMs) {
    _triggerLock();
  } else {
    // Recalibrate remaining time so the timer is accurate after wake.
    if (_idleTimerHandle) clearTimeout(_idleTimerHandle);
    _idleTimerHandle = setTimeout(_triggerLock, _idleTimeoutMs - elapsed);
  }
}

async function _startIdleWatcher() {
  _stopIdleWatcher();
  const raw  = await Storage.settings.get('security.idleTimeoutMinutes');
  const stored = parseInt(raw, 10);
  // If the setting has never been saved (NaN), apply the secure default.
  // Explicit 0 (disabled) is not permitted — treat as default.
  const mins = (!isNaN(stored) && stored > 0) ? stored : _IDLE_DEFAULT_MINS;
  _idleTimeoutMs  = mins * 60_000;
  _lastActivityAt = Date.now();
  _IDLE_EVENTS.forEach(ev =>
    document.addEventListener(ev, _onIdleActivity, { passive: true })
  );
  document.addEventListener('visibilitychange', _onVisibilityChange);
  _resetIdleTimer();
}

function _stopIdleWatcher() {
  if (_idleTimerHandle) { clearTimeout(_idleTimerHandle); _idleTimerHandle = null; }
  _IDLE_EVENTS.forEach(ev => document.removeEventListener(ev, _onIdleActivity));
  document.removeEventListener('visibilitychange', _onVisibilityChange);
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
  // Suspend the sessionStorage session so closing the browser/tab during a
  // lock requires full re-login (including 2FA). The in-memory AUTH session
  // is kept so the overlay can verify PIN and display the user name.
  AUTH.suspendSession();
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

      <!-- Step 1: PIN -->
      <form class="lock-form" autocomplete="off" data-form="lock-pin-form">
        <input type="text" inputmode="numeric" pattern="\\d{4}" maxlength="4"
               class="form__input--pin lock-pin"
               placeholder="Enter PIN" autocomplete="off"
               aria-label="Enter PIN to unlock" autofocus>
        <div class="form__error lock-error" role="alert"></div>
        <button type="submit" class="btn btn--primary lock-submit">Unlock</button>
      </form>

      <!-- Step 2: 2FA (hidden until PIN passes) -->
      <form class="lock-form lock-totp-form" autocomplete="off"
            data-form="lock-totp-form" style="display:none">
        <p class="lock-totp-hint" data-totp-hint>
          Open your authenticator app and enter the 6-digit code.
        </p>
        <input type="text" class="form__input lock-totp-input"
               inputmode="numeric" maxlength="6"
               placeholder="000000" autocomplete="one-time-code"
               spellcheck="false" aria-label="6-digit authenticator code">
        <div class="form__error lock-totp-error" role="alert"></div>
        <button type="submit" class="btn btn--primary">Verify</button>
        <button type="button" class="btn btn--ghost lock-totp-backup-toggle"
                data-action="toggle-backup">Use a backup code instead</button>
      </form>

      <button type="button" class="btn btn--ghost lock-switch"
              data-action="lock-switch-user">Sign out / switch user</button>
    </div>
  `;

  document.body.appendChild(overlay);
  _lockOverlay = overlay;

  const pinInput  = overlay.querySelector('.lock-pin');
  if (pinInput) requestAnimationFrame(() => pinInput.focus());

  const pinForm   = overlay.querySelector('[data-form="lock-pin-form"]');
  const totpForm  = overlay.querySelector('[data-form="lock-totp-form"]');
  const errEl     = overlay.querySelector('.lock-error');
  const switchBtn = overlay.querySelector('[data-action="lock-switch-user"]');

  let _useBackup  = false;
  let _cachedUser = null;

  // Helper: complete unlock after all auth steps pass.
  function _doUnlock() {
    AUTH.resumeSession();      // re-write session to sessionStorage
    _hideLockOverlay();
    _startIdleWatcher();       // restart idle watcher
  }

  // ── Step 1: PIN ──────────────────────────────────────────────────────────
  pinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.textContent = '';

    const enteredPin = (pinInput.value || '').trim();
    if (!/^\d{4}$/.test(enteredPin)) {
      errEl.textContent = 'Enter your 4-digit PIN.';
      return;
    }

    const submit = pinForm.querySelector('[type="submit"]');
    if (submit) { submit.disabled = true; submit.textContent = 'Checking…'; }

    const result = await AUTH.verifyPin(_session.userId, enteredPin);

    if (result.ok) {
      // Check whether this user also has TOTP enabled.
      const userRecord = await Storage.users.get(_session.userId);
      if (userRecord?.totpEnabled && userRecord?.totpSecret) {
        // Gate on 2FA before unlocking.
        _cachedUser = userRecord;
        pinForm.style.display  = 'none';
        totpForm.style.display = '';
        const totpInput = totpForm.querySelector('.lock-totp-input');
        if (totpInput) { totpInput.value = ''; requestAnimationFrame(() => totpInput.focus()); }
      } else {
        _doUnlock();
      }
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

  // ── Step 2: TOTP / backup code ───────────────────────────────────────────
  totpForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const totpInput  = totpForm.querySelector('.lock-totp-input');
    const totpErrEl  = totpForm.querySelector('.lock-totp-error');
    const submit     = totpForm.querySelector('[type="submit"]');
    const code       = (totpInput?.value || '').trim().toUpperCase().replace(/\s/g, '');
    if (!code) return;

    if (submit) { submit.disabled = true; submit.textContent = 'Verifying…'; }
    if (totpErrEl) totpErrEl.textContent = '';

    try {
      if (_useBackup) {
        const remaining = _cachedUser.totpHashedBackups || [];
        const idx = await TOTP.verifyBackupCode(code, remaining);
        if (idx < 0) {
          if (submit) { submit.disabled = false; submit.textContent = 'Verify'; }
          if (totpErrEl) totpErrEl.textContent = 'Backup code not recognised or already used.';
          if (totpInput) { totpInput.value = ''; totpInput.focus(); }
          return;
        }
        const newBackups = remaining.filter((_, i) => i !== idx);
        await Storage.users.put({ ..._cachedUser, totpHashedBackups: newBackups });
        await Storage.audit.append({
          action: '2fa_backup_used',
          user:   _cachedUser.name || _cachedUser.id,
          desc:   `Backup code used for session unlock. ${newBackups.length} remaining.`,
        });
      } else {
        const result = await TOTP.verify(
          _cachedUser.totpSecret,
          code,
          { lastUsedStep: _cachedUser.totpLastUsedStep ?? -1 },
        );
        if (!result.ok) {
          if (submit) { submit.disabled = false; submit.textContent = 'Verify'; }
          if (totpErrEl) totpErrEl.textContent = 'Code incorrect or expired — check your device clock.';
          if (totpInput) { totpInput.value = ''; totpInput.focus(); }
          return;
        }
        await Storage.users.put({ ..._cachedUser, totpLastUsedStep: result.step });
        await Storage.audit.append({
          action: 'session_unlock',
          user:   _cachedUser.name || _cachedUser.username,
          desc:   `Session unlocked with PIN + 2FA: ${_cachedUser.name || _cachedUser.username}`,
        });
      }
      _doUnlock();
    } catch (err) {
      console.error('Lock overlay TOTP verification error:', err);
      if (submit) { submit.disabled = false; submit.textContent = 'Verify'; }
      if (totpErrEl) totpErrEl.textContent = 'Verification error — please try again.';
    }
  });

  // Auto-submit on correct-length input
  totpForm.addEventListener('input', (e) => {
    const totpInput = totpForm.querySelector('.lock-totp-input');
    if (!totpInput || e.target !== totpInput) return;
    if (_useBackup) {
      totpInput.value = totpInput.value.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase();
      if (totpInput.value.length === 8) totpForm.querySelector('[type="submit"]')?.click();
    } else {
      totpInput.value = totpInput.value.replace(/\D/g, '').slice(0, 6);
      if (totpInput.value.length === 6) totpForm.querySelector('[type="submit"]')?.click();
    }
  });

  // Toggle TOTP ↔ backup code mode
  totpForm.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="toggle-backup"]')) {
      _useBackup = !_useBackup;
      const totpInput  = totpForm.querySelector('.lock-totp-input');
      const hintEl     = totpForm.querySelector('[data-totp-hint]');
      const toggleBtn  = totpForm.querySelector('[data-action="toggle-backup"]');
      const totpErrEl  = totpForm.querySelector('.lock-totp-error');
      if (totpInput) {
        totpInput.value       = '';
        totpInput.placeholder = _useBackup ? 'XXXXXXXX' : '000000';
        totpInput.inputMode   = _useBackup ? 'text' : 'numeric';
        totpInput.maxLength   = _useBackup ? 8 : 6;
        totpInput.focus();
      }
      if (hintEl) hintEl.textContent = _useBackup
        ? 'Enter one of your 8-character backup codes.'
        : 'Open your authenticator app and enter the 6-digit code.';
      if (toggleBtn) toggleBtn.textContent = _useBackup
        ? 'Use authenticator code instead'
        : 'Use a backup code instead';
      if (totpErrEl) totpErrEl.textContent = '';
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
  // MSAL 5.x redirect bridge: if this page loaded inside a popup window that
  // Microsoft redirected back to us with an auth code, broadcast the response
  // to the main window via BroadcastChannel and close — do NOT render the app.
  //
  // handlePopupAuth() detects popup context by parsing the URL state parameter
  // (interactionType === 'popup'). This is reliable even after cross-origin
  // redirects through login.microsoftonline.com that null out window.opener.
  // It calls broadcastResponseToMainFrame() from @azure/msal-browser/redirect-bridge,
  // which is the sender that the main window's waitForBridgeResponse() is
  // waiting for on BroadcastChannel(libraryState.id).
  if (await Sync.handlePopupAuth()) return;

  _root = rootEl;
  // Apply stored theme immediately — before any async ops — to avoid flash.
  applyStoredTheme();
  logBanner();
  checkOrigin();
  // Integrity check deferred briefly so the DOM is fully parsed first.
  setTimeout(checkIntegrity, 1500);

  // Pre-seed localStorage from embedded unit config so the logo shows on splash
  // immediately when opening a "unit copy" distribution on a fresh device.
  if (window.__UNIT_CONFIG__?.logo) {
    try { localStorage.setItem('qstore2_logo', window.__UNIT_CONFIG__.logo); } catch (_) {}
  }

  // Show splash immediately — runs for at least 5 seconds in parallel with boot.
  const splash = showSplash();

  try {
    await Storage.init();
    await Storage.requestPersistence();

    // V2L sandbox: seed sample data on very first launch.
    if (typeof __V2L_SANDBOX__ !== 'undefined' && __V2L_SANDBOX__) {
      await _v2lSeedIfNeeded();
    }

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
    // Also sync the theme from IndexedDB (authoritative) into localStorage.
    try {
      const s = await Storage.settings.getAll();
      splash.setContent({ logo: s.unitLogo || null, name: s.unitName || '', code: s.unitCode || '' });
      if (s['ui.theme']) applyTheme(s['ui.theme']);
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
  const showBanner   = _session.pinIsDefault === true;
  const licenseState = getLicenseState();

  const initialPage = _pickInitialPage();
  _currentPage = initialPage;

  render(_root, `
    <div class="shell">
      <header class="shell__header">
        <div class="shell__brand">
          <div class="shell__brand-mark">
            ${unitLogo ? `<img class="shell__brand-logo" src="${esc(unitLogo)}" alt="${esc(unitName)}">` : ''}
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
        <button type="button" class="shell__help" data-action="help"
                aria-label="Help" title="Open help &amp; user guide">?</button>
        <button type="button" class="shell__logout" data-action="logout">Sign out</button>
        <button type="button" class="shell__hamburger" aria-expanded="false"
                aria-label="Open menu" data-action="toggle-nav">
          <span></span><span></span><span></span>
        </button>
      </header>

      ${(typeof __V2L_SANDBOX__ !== 'undefined' && __V2L_SANDBOX__) ? _v2lSandboxBannerHtml() : ''}
      ${showBanner ? _defaultPinBannerHtml() : ''}
      ${_licenseBannerHtml(licenseState)}

      <main class="shell__main" data-target="page-content">
        <div class="shell__loading">Loading…</div>
      </main>
    </div>
  `);

  // Wire logout buttons (desktop header + mobile nav).
  _root.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="logout"]')) _onLogout();
    if (e.target.closest('[data-action="help"]')) _navigateTo('help');
    if (e.target.closest('[data-action="open-subscription-settings"]')) _navigateTo('settings');
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

  // Start global keyboard shortcuts for this session.
  Shortcuts.mount();

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
  if (pageDef.coOnly)      return AUTH.isCO();
  if (pageDef.notForCadet && AUTH.isCadet()) return false;
  if (pageDef.perm)        return AUTH.can(pageDef.perm) || AUTH.isCO();
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

  // ---- Overdue loans badge on "Loans" nav button ----
  const loansNavBtn = _root.querySelector('.shell__nav-link[data-page="loans"]');
  if (loansNavBtn) {
    const today = new Date().toISOString().slice(0, 10);
    const active = await Storage.loans.listActive();
    const overdueCount = active.filter(l => !l.longTermLoan && l.dueDate && l.dueDate < today).length;

    if (overdueCount > 0) {
      loansNavBtn.innerHTML =
        `Loans <span class="shell__nav-badge">${overdueCount}</span>`;
    } else {
      loansNavBtn.textContent = 'Loans';
    }
  }

  // ---- Pending requests badge on "Requests" nav button (QM / CO only) ----
  const reqNavBtn = _root.querySelector('.shell__nav-link[data-page="requests"]');
  if (reqNavBtn && (AUTH.can('issue') || AUTH.isCO())) {
    try {
      const pending = await Storage.requests.listByStatus('pending');
      if (pending.length > 0) {
        reqNavBtn.innerHTML =
          `Requests <span class="shell__nav-badge">${pending.length}</span>`;
      } else {
        reqNavBtn.textContent = 'Requests';
      }
    } catch { /* non-fatal */ }
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
// V2L Sandbox — banner + seed data injection
// -----------------------------------------------------------------------------

function _v2lSandboxBannerHtml() {
  return `
    <div class="shell__banner" style="background:rgba(107,176,255,0.12);border-bottom:2px solid var(--info);color:var(--info);" role="alert">
      <strong>⚡ QStore IMS V2L — Learning Edition</strong>
      &nbsp;This is a sandboxed training environment. Data is isolated and cloud sync is disabled.
      No changes here will affect any real unit.
    </div>
  `;
}

async function _v2lSeedIfNeeded() {
  const seed = (typeof __V2L_SEED__ !== 'undefined') ? __V2L_SEED__ : null;
  if (!seed) return;
  try {
    const count = await Storage.items.count();
    if (count > 0) return;   // already seeded — don't overwrite

    for (const [k, v] of Object.entries(seed.settings || {})) {
      await Storage.settings.set(k, v);
    }
    for (const item of seed.items || []) {
      await Storage.items.put(item);
    }
    for (const cadet of seed.cadets || []) {
      await Storage.cadets.put(cadet);
    }
    for (const member of seed.staff || []) {
      await Storage.staff.put(member);
    }
    for (const loan of seed.loans || []) {
      await Storage.loans.put(loan);
    }
    console.info('[V2L] Sample data seeded successfully.');
  } catch (err) {
    console.warn('[V2L] Seed failed (non-fatal):', err);
  }
}

// -----------------------------------------------------------------------------
// License banners
// -----------------------------------------------------------------------------

function _licenseBannerHtml(ls) {
  if (ls.state === 'RESTRICTED') {
    return `
      <div class="shell__banner shell__banner--error" role="alert">
        <strong>Subscription expired.</strong>
        QStore is in read-only mode — you can view records and export data, but editing is blocked.
        <button type="button" class="shell__banner-action"
                data-action="open-subscription-settings">Manage subscription</button>
      </div>
    `;
  }
  if (ls.state === 'GRACE') {
    const days   = ls.graceDaysLeft ?? 0;
    const dayStr = days === 1 ? '1 day' : `${days} days`;
    return `
      <div class="shell__banner shell__banner--warn" role="alert">
        <strong>Subscription expired.</strong>
        ${days > 0 ? `${dayStr} remaining in the grace period.` : 'Grace period ending soon.'}
        Renew to avoid losing edit access.
        <button type="button" class="shell__banner-action"
                data-action="open-subscription-settings">Manage subscription</button>
      </div>
    `;
  }
  if (ls.state === 'TRIAL' && ls.trialDaysLeft !== null && ls.trialDaysLeft <= 7) {
    const days   = ls.trialDaysLeft;
    const dayStr = days === 1 ? '1 day' : `${days} days`;
    return `
      <div class="shell__banner shell__banner--warn" role="alert">
        <strong>${dayStr} left in your free trial.</strong>
        Activate a subscription key in Settings to continue editing after the trial ends.
        <button type="button" class="shell__banner-action"
                data-action="open-subscription-settings">Activate key</button>
      </div>
    `;
  }
  return '';
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
  Shortcuts.unmount();
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
