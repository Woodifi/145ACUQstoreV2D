// =============================================================================
// QStore IMS v2 — Cloud sync (OneDrive + MSAL)
// =============================================================================
// Provides a CloudProvider interface and one implementation: OneDriveProvider
// using @azure/msal-browser 2.38.x. v2.0 ships only OneDrive; the interface
// exists so we can drop in Google Drive or Dropbox later without changing
// sync.js or any UI code.
//
// MSAL VERSION CHOICE
//   We pin MSAL Browser 2.38.3 — the same version v1 uses. Microsoft's CDN
//   for MSAL is fully deprecated as of v3.0, so we MUST bundle from npm
//   regardless. Pinning v2 minimises divergence from v1's well-tested setup.
//   Upgrading to MSAL 5.x is in the v2.1 backlog as a focused task.
//
// AUTH FLOW
//   OAuth 2.0 Authorization Code Flow with PKCE — MSAL handles all of it.
//   We use loginRedirect on mobile, loginPopup on desktop with auto-fallback
//   to redirect if the popup is blocked. Token cache is in localStorage so
//   it survives page reloads.
//
// REDIRECT URI
//   Origin + pathname only, no trailing slash. Must match the URI registered
//   in the Azure portal exactly. MSAL fails initialisation otherwise. The
//   most common deployment mistake is registering 'http://localhost:8000/'
//   (trailing slash) when the actual URI is 'http://localhost:8000' (no
//   trailing slash). The error message guides the user to fix it.
//
// SCOPES
//   Files.ReadWrite (read/write user's own OneDrive files) and User.Read
//   (sign-in identity). We don't ask for Files.ReadWrite.All — only the
//   user's own drive. Minimum surface for the use case.
//
// AUDIT KEY HANDLING
//   The cloud blob includes the meta store, which contains the audit HMAC
//   key. This means downloading a blob adopts the source device's audit
//   chain — necessary for verifiability. Anyone with cloud access can read
//   the audit key, but they already have full data access, so it's not an
//   additional weakness.
//
// CONCURRENCY
//   Last-write-wins. v2.0 doesn't merge concurrent edits. The realistic
//   case is one QM at a time; if two QMs edit simultaneously from different
//   devices, the later upload overwrites the earlier. Settings UI shows the
//   last-synced timestamp prominently to make this visible. v2.2+: real
//   conflict detection with a merge prompt.
// =============================================================================

import * as msal from '@azure/msal-browser';
import * as Storage from './storage.js';

// -----------------------------------------------------------------------------
// CloudProvider interface (documentation; not enforced at runtime)
// -----------------------------------------------------------------------------
//
// Implementations must provide:
//   async init({ clientId, folder, filename }) — set up the provider
//   async signIn()                              — interactive user sign-in
//   async signOut()                             — sign out, clear local tokens
//   isSignedIn(): boolean                       — sync check
//   getAccount(): {username, name} | null       — current account info
//   async read(): object | null                 — fetch & parse cloud blob
//   async write(snapshot)                       — push snapshot to cloud
//   getStatusInfo(): {state, lastSync, ...}     — diagnostic info
//
// State strings used in getStatusInfo().state:
//   'unconfigured'   — no clientId set
//   'not-signed-in'  — clientId set but user not signed in
//   'signed-in'      — ready to sync
//   'busy'           — sync in progress
//   'error'          — last operation failed
//
// All methods may throw. Callers should catch and log via the sync engine.
// -----------------------------------------------------------------------------

const SCOPES = ['Files.ReadWrite', 'User.Read'];
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// -----------------------------------------------------------------------------
// OneDriveProvider
// -----------------------------------------------------------------------------

export class OneDriveProvider {
  constructor() {
    this._msal = null;
    this._account = null;
    this._clientId = '';
    this._folder = 'QStore';
    this._filename = 'qstore_data.json';
    this._lastError = null;
    this._lastSync = null;
    this._lastDownload = null;
    this._busy = false;
  }

  // ---- Lifecycle ---------------------------------------------------------

  /**
   * Initialise the provider. Reads cloud.* settings from Storage, builds the
   * MSAL instance if a clientId is configured, processes any pending redirect
   * response, and restores any cached account.
   *
   * Safe to call multiple times — re-creates the MSAL instance if the
   * clientId changes. No-op if clientId is empty.
   */
  async init() {
    const settings = await Storage.settings.getAll();
    this._clientId = settings['cloud.clientId'] || '';
    this._folder   = settings['cloud.folder']   || 'QStore';
    this._filename = settings['cloud.filename'] || 'qstore_data.json';
    this._lastSync = settings['cloud.lastSync'] || null;

    if (!this._clientId) {
      this._msal = null;
      this._account = null;
      return;
    }

    try {
      this._msal = new msal.PublicClientApplication({
        auth: {
          clientId:                  this._clientId,
          authority:                 'https://login.microsoftonline.com/common',
          redirectUri:               this._getRedirectUri(),
          postLogoutRedirectUri:     this._getRedirectUri(),
          navigateToLoginRequestUrl: true,
        },
        cache: {
          cacheLocation:          'localStorage',
          storeAuthStateInCookie: false,
        },
        system: {
          loggerOptions: {
            loggerCallback: (level, message, containsPii) => {
              if (!containsPii) console.debug('[MSAL]', message);
            },
            piiLoggingEnabled: false,
            logLevel: msal.LogLevel.Warning,
          },
        },
      });

      // CRITICAL — handleRedirectPromise() must be called on every page load
      // to complete an in-flight Authorization Code Flow + PKCE exchange.
      // Omitting this is the most common cause of MSAL initialisation
      // failures and silent sign-in loops.
      const response = await this._msal.handleRedirectPromise();

      if (response && response.account) {
        this._account = response.account;
        this._msal.setActiveAccount(this._account);
      } else {
        // Not a redirect callback — check for a cached account instead
        const accounts = this._msal.getAllAccounts();
        if (accounts.length > 0) {
          this._account = accounts[0];
          this._msal.setActiveAccount(this._account);
        }
      }
      this._lastError = null;
    } catch (err) {
      this._lastError = this._formatInitError(err);
      this._msal = null;
      this._account = null;
      console.error('OneDrive init failed:', err);
    }
  }

  /**
   * Persist the current cloud settings (clientId, folder, filename) to
   * Storage. After calling this, the caller MUST call init() (or
   * Sync.init()) to apply the new settings — typically the settings page
   * does the latter so sync-engine state also resets.
   */
  async configure({ clientId, folder, filename }) {
    if (clientId !== undefined) await Storage.settings.set('cloud.clientId', String(clientId).trim());
    if (folder   !== undefined) await Storage.settings.set('cloud.folder',   String(folder).trim() || 'QStore');
    if (filename !== undefined) await Storage.settings.set('cloud.filename', String(filename).trim() || 'qstore_data.json');
  }

  // ---- Sign-in / sign-out ------------------------------------------------

  /**
   * Interactive sign-in. Uses popup on desktop, redirect on mobile/touch.
   * Falls back to redirect if the popup is blocked. On mobile redirect, the
   * page navigates away — code after this call doesn't execute. The result
   * is processed by the next init() call (via handleRedirectPromise).
   */
  async signIn() {
    if (!this._msal) {
      throw new Error('Cloud provider not configured. Set the Azure Client ID in Settings.');
    }
    const request = {
      scopes:      SCOPES,
      redirectUri: this._getRedirectUri(),
      prompt:      'select_account',
    };

    if (this._useRedirect()) {
      // Page navigates away. Result processed in init() on next load.
      await this._msal.loginRedirect(request);
      return;
    }

    try {
      const resp = await this._msal.loginPopup(request);
      this._account = resp.account;
      this._msal.setActiveAccount(this._account);
      this._lastError = null;
    } catch (err) {
      const msg = err.message || String(err);
      // Popup blocked — fall back to redirect.
      if (msg.includes('popup_window_error') || msg.includes('user_cancelled')) {
        await this._msal.loginRedirect(request);
        return;
      }
      // "interaction_in_progress" means a previous flow didn't complete.
      // Most likely a stuck state in localStorage. Surface a clear message.
      if (msg.includes('interaction_in_progress')) {
        throw new Error('A sign-in is already in progress. Refresh the page and try again.');
      }
      this._lastError = msg;
      throw err;
    }
  }

  /**
   * Sign out. On mobile this redirects (page navigates away). On desktop
   * uses logoutPopup. Either way the local account state is cleared.
   */
  async signOut() {
    if (!this._msal || !this._account) {
      this._account = null;
      return;
    }
    try {
      if (this._useRedirect()) {
        await this._msal.logoutRedirect({
          account:               this._account,
          postLogoutRedirectUri: this._getRedirectUri(),
        });
        // Page navigates away
        return;
      }
      await this._msal.logoutPopup({ account: this._account });
    } catch (err) {
      // Any failure — best effort: clear local state and treat as signed out.
      try { await this._msal.clearCache(); } catch (_) {}
      console.warn('OneDrive sign-out warning:', err);
    }
    this._account = null;
  }

  isSignedIn() {
    return Boolean(this._account);
  }

  getAccount() {
    if (!this._account) return null;
    return {
      username: this._account.username || '',
      name:     this._account.name || this._account.username || '',
    };
  }

  // ---- Read / write ------------------------------------------------------

  /**
   * Fetch the cloud blob and parse it as JSON. Returns null if the file
   * doesn't exist (404) — this is normal for a fresh install before the
   * first push.
   *
   * Throws on auth failure or any other Graph API error. The sync engine
   * decides what to do with the error.
   */
  async read() {
    const token = await this._getAccessToken();
    this._busy = true;
    try {
      // Get item metadata to obtain the pre-authenticated download URL.
      // Graph's @microsoft.graph.downloadUrl is short-lived and doesn't
      // require the Authorization header, which avoids CORS issues.
      const metaResp = await fetch(this._graphUrl(''), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (metaResp.status === 404) {
        this._lastError = null;
        return null;
      }
      if (!metaResp.ok) {
        throw new Error(`Cloud read failed: HTTP ${metaResp.status} ${metaResp.statusText}`);
      }
      const meta = await metaResp.json();
      const dlUrl = meta['@microsoft.graph.downloadUrl'];
      if (!dlUrl) {
        throw new Error('Cloud read failed: no download URL in metadata response.');
      }
      const dlResp = await fetch(dlUrl);
      if (!dlResp.ok) {
        throw new Error(`Cloud download failed: HTTP ${dlResp.status}`);
      }
      const data = await dlResp.json();
      this._lastDownload = new Date().toISOString();
      this._lastError = null;
      return data;
    } catch (err) {
      this._lastError = err.message || String(err);
      throw err;
    } finally {
      this._busy = false;
    }
  }

  /**
   * Push a snapshot to the cloud as JSON. Uses Graph PUT /content for
   * simple replace-the-file semantics. If the folder doesn't exist, Graph
   * creates it implicitly.
   */
  async write(snapshot) {
    const token = await this._getAccessToken();
    this._busy = true;
    try {
      const body = JSON.stringify(snapshot);
      const resp = await fetch(this._graphUrl('/content'), {
        method:  'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body,
      });
      if (resp.status === 401) {
        throw new Error('Cloud write failed: token expired. Please sign in again.');
      }
      if (!resp.ok) {
        throw new Error(`Cloud write failed: HTTP ${resp.status} ${resp.statusText}`);
      }
      const ts = new Date().toISOString();
      this._lastSync = ts;
      await Storage.settings.set('cloud.lastSync', ts);
      this._lastError = null;
    } catch (err) {
      this._lastError = err.message || String(err);
      throw err;
    } finally {
      this._busy = false;
    }
  }

  // ---- Diagnostics -------------------------------------------------------

  getStatusInfo() {
    let state;
    if (this._busy)               state = 'busy';
    else if (this._lastError)     state = 'error';
    else if (!this._clientId)     state = 'unconfigured';
    else if (!this._account)      state = 'not-signed-in';
    else                          state = 'signed-in';

    return {
      state,
      provider:     'onedrive',
      clientId:     this._clientId,
      folder:       this._folder,
      filename:     this._filename,
      account:      this.getAccount(),
      lastSync:     this._lastSync,
      lastDownload: this._lastDownload,
      lastError:    this._lastError,
      redirectUri:  this._getRedirectUri(),
    };
  }

  // ---- Internals ---------------------------------------------------------

  _getRedirectUri() {
    const uri = window.location.origin + window.location.pathname;
    return uri.endsWith('/') ? uri.slice(0, -1) : uri;
  }

  _useRedirect() {
    return ('ontouchstart' in window)
        || (navigator.maxTouchPoints > 0)
        || /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  }

  _graphUrl(suffix) {
    const folder = (this._folder || '').trim().replace(/^\/+|\/+$/g, '');
    const fname  = (this._filename || 'qstore_data.json').trim();
    const path   = folder ? `${folder}/${fname}` : fname;
    // encodeURIComponent then restore forward slashes — Graph expects
    // path-encoded segments but with literal / between them.
    const encoded = encodeURIComponent(path).replace(/%2F/g, '/');
    return `${GRAPH_BASE}/me/drive/root:/${encoded}:${suffix}`;
  }

  /**
   * Acquire an access token. Tries silent first (uses MSAL's token cache
   * + refresh tokens); on failure falls back to interactive popup or
   * redirect. The redirect path stores a flag so the sync engine knows to
   * resume after the page reloads.
   */
  async _getAccessToken() {
    if (!this._msal || !this._account) {
      throw new Error('Not signed in to OneDrive.');
    }
    const request = {
      scopes:  SCOPES,
      account: this._account,
    };
    try {
      const resp = await this._msal.acquireTokenSilent(request);
      return resp.accessToken;
    } catch (err) {
      // Silent token acquisition failed — token expired or cache miss.
      // Need interactive auth. On mobile, that means redirect (page
      // navigates away). On desktop, popup with redirect fallback.
      if (this._useRedirect()) {
        sessionStorage.setItem('qstore_cloud_token_refresh', '1');
        await this._msal.acquireTokenRedirect({ ...request, redirectUri: this._getRedirectUri() });
        // Page navigates away — code after this never executes
        throw new Error('Redirecting to refresh token. Please wait...');
      }
      try {
        const resp = await this._msal.acquireTokenPopup(request);
        return resp.accessToken;
      } catch (popupErr) {
        // Popup blocked — fall back to redirect
        sessionStorage.setItem('qstore_cloud_token_refresh', '1');
        await this._msal.acquireTokenRedirect({ ...request, redirectUri: this._getRedirectUri() });
        throw new Error('Redirecting to refresh token. Please wait...');
      }
    }
  }

  _formatInitError(err) {
    const msg = err.message || String(err);
    if (msg.includes('redirect_uri_mismatch') || msg.includes('AADSTS50011')) {
      const uri = this._getRedirectUri();
      return `Azure registration mismatch. Add this URI in the Azure Portal under App registrations → Authentication → Single-page application: ${uri}`;
    }
    if (msg.includes('ClientAuthError') || msg.includes('client_id')) {
      return 'Invalid Client ID. Check the Azure portal and confirm the app registration exists.';
    }
    return msg;
  }
}

// -----------------------------------------------------------------------------
// Module-level provider singleton
// -----------------------------------------------------------------------------
// We expose a single shared instance because cloud sync is global state —
// having two providers running concurrently would cause overlapping token
// requests and write races. If we ever support multiple providers in
// parallel (e.g. backup to two clouds), we'd need a coordinator.

let _provider = null;

/**
 * Return the active CloudProvider. v2.0 always returns an OneDriveProvider.
 * Future versions may return different providers based on settings.
 */
export function getProvider() {
  if (!_provider) _provider = new OneDriveProvider();
  return _provider;
}

/** For tests only — replace the provider singleton. */
export function _setProvider(p) {
  _provider = p;
}
