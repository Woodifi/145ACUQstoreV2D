// =============================================================================
// QStore IMS v2 — Settings page
// =============================================================================
// CO-only. Manages cloud sync configuration and provides the data import/
// export controls. v2.0 covers cloud config + manual sync; later rounds
// extend with unit details, user management, audit log viewer, etc.
//
// Cloud config:
//   - Azure Application (client) ID  — required to enable sync
//   - Folder name in OneDrive (default: QStore)
//   - File name (default: qstore_data.json)
//   - Auto-sync toggle (default: on)
//
// Cloud actions:
//   - Sign in / Sign out
//   - Sync now            — manual push
//   - Load from cloud     — destructive download with confirmation
//
// REDIRECT URI HINT
//   We display the redirect URI prominently because mismatching it with
//   the Azure registration is the single most common deployment error.
//   The page shows the exact value to paste into Azure's portal.
// =============================================================================

import * as Storage from '../storage.js';
import * as AUTH    from '../auth.js';
import * as Sync    from '../sync.js';
import { getProvider } from '../cloud.js';
import { openModal }   from './modal.js';
import { esc, $, $$, render, fmtDate } from './util.js';

let _root = null;
let _statusListener = null;

export async function mount(rootEl) {
  _root = rootEl;
  AUTH.requireCO();

  await _render();

  // Listen for sync status changes so the page reflects sign-in/out, busy,
  // and error states without a full re-render.
  _statusListener = (status) => _refreshSyncBlock(status);
  Sync.addStatusListener(_statusListener);

  return function unmount() {
    if (_statusListener) {
      Sync.removeStatusListener(_statusListener);
      _statusListener = null;
    }
    _root = null;
  };
}

// -----------------------------------------------------------------------------
// Render
// -----------------------------------------------------------------------------

async function _render() {
  const settings = await Storage.settings.getAll();
  const status   = Sync.getStatus();

  render(_root, `
    <section class="settings">
      <div class="settings__column">
        ${_cloudSectionHtml(settings, status)}
      </div>
    </section>
  `);

  _wireEventListeners();
}

function _cloudSectionHtml(settings, status) {
  // Cloud sync requires a stable HTTP(S) origin for the OAuth redirect URI.
  // file:// origins can't be registered in Azure, so we disable the config
  // UI entirely and explain the situation rather than silently failing.
  if (window.location.protocol === 'file:') {
    return _cloudUnavailableFileProtocolHtml();
  }

  const clientId = settings['cloud.clientId'] || '';
  const folder   = settings['cloud.folder']   || 'QStore';
  const filename = settings['cloud.filename'] || 'qstore_data.json';
  const autoSync = settings['cloud.autoSync'] !== false;
  const lastSync = settings['cloud.lastSync'] || null;
  const redirect = status.redirectUri;

  return `
    <section class="settings__section" data-section="cloud">
      <header class="settings__section-header">
        <h2 class="settings__section-title">Cloud sync — Microsoft OneDrive</h2>
        <p class="settings__section-hint">
          Sync your Q-Store data to OneDrive so it's backed up and accessible
          from other devices. Requires an Azure app registration; the unit's
          IT support or CO needs to do this once.
        </p>
      </header>

      <div class="settings__cloud-status" data-target="sync-block">
        ${_syncBlockHtml(status, lastSync)}
      </div>

      <form class="form" data-form="cloud-config" autocomplete="off">
        <label class="form__field">
          <span class="form__label">Azure Application (client) ID</span>
          <input type="text" name="clientId" value="${esc(clientId)}"
                 placeholder="00000000-0000-0000-0000-000000000000"
                 spellcheck="false">
          <span class="form__hint">From Azure Portal → App registrations → Overview → Application (client) ID</span>
        </label>

        <div class="form__row">
          <label class="form__field form__field--grow">
            <span class="form__label">OneDrive folder</span>
            <input type="text" name="folder" value="${esc(folder)}" maxlength="80"
                   placeholder="QStore">
          </label>
          <label class="form__field form__field--grow">
            <span class="form__label">File name</span>
            <input type="text" name="filename" value="${esc(filename)}" maxlength="120"
                   placeholder="qstore_data.json">
          </label>
        </div>

        <label class="form__field form__check">
          <input type="checkbox" name="autoSync" ${autoSync ? 'checked' : ''}>
          <span>Auto-sync after every change (debounced 5 s)</span>
        </label>

        <div class="form__error" role="alert"></div>
        <div class="form__actions">
          <button type="submit" class="btn btn--primary">Save settings</button>
        </div>
      </form>

      <details class="settings__details">
        <summary>Azure registration details</summary>
        <div class="settings__details-body">
          <p>
            To enable cloud sync, register a Single-Page Application in the
            Azure portal under your Microsoft account or unit M365 tenant.
            Use exactly this redirect URI:
          </p>
          <code class="settings__redirect">${esc(redirect)}</code>
          <p>
            After registering, copy the Application (client) ID into the field
            above. The app needs the delegated permissions
            <code>Files.ReadWrite</code> and <code>User.Read</code>. No admin
            consent is required.
          </p>
        </div>
      </details>
    </section>
  `;
}

function _cloudUnavailableFileProtocolHtml() {
  return `
    <section class="settings__section">
      <header class="settings__section-header">
        <h2 class="settings__section-title">Cloud sync — unavailable</h2>
      </header>
      <div class="modal__warn">
        <strong>This page is loaded from a local file (file://).</strong>
        Cloud sync requires the app to be served from a stable web URL
        (HTTP or HTTPS) because Microsoft Entra ID needs a registered
        redirect URI. file:// origins can't be registered.
      </div>
      <p class="settings__section-hint" style="margin-top:12px">
        To use cloud sync, host this page on a web server. Options include:
      </p>
      <ul class="settings__section-hint" style="line-height:1.8">
        <li>A unit-internal web server</li>
        <li>SharePoint Online (upload the file and access via its URL)</li>
        <li>A simple local server: <code>python3 -m http.server 8000</code> in this folder</li>
      </ul>
      <p class="settings__section-hint">
        Local-only operation works fine without cloud sync — you just won't
        get automatic backup or cross-device sync.
      </p>
    </section>
  `;
}

function _syncBlockHtml(status, lastSync) {
  const account = status.account;
  const stateMsg = _stateMessage(status);
  const lastSyncTxt = lastSync ? `Last sync: ${fmtDate(lastSync)}` : 'Never synced';

  return `
    <div class="settings__sync-status settings__sync-status--${esc(status.state)}">
      <div class="settings__sync-state">
        <span class="settings__sync-dot"></span>
        ${esc(stateMsg)}
      </div>
      ${account ? `
        <div class="settings__sync-account">
          <span class="settings__sync-account-name">${esc(account.name || account.username)}</span>
          ${account.username && account.username !== account.name
            ? `<span class="settings__sync-account-mail">${esc(account.username)}</span>`
            : ''}
        </div>
      ` : ''}
      <div class="settings__sync-meta">${esc(lastSyncTxt)}</div>
      ${status.lastError ? `
        <div class="settings__sync-error">
          ${esc(status.lastError)}
        </div>
      ` : ''}
      <div class="settings__sync-actions">
        ${_syncActionsHtml(status)}
      </div>
    </div>
  `;
}

function _stateMessage(status) {
  switch (status.state) {
    case 'unconfigured':  return 'Not configured';
    case 'not-signed-in': return 'Configured, not signed in';
    case 'signed-in':     return status.pending ? 'Sync pending…' : 'Signed in';
    case 'busy':          return 'Syncing…';
    case 'error':         return 'Sync error';
    default:              return status.state;
  }
}

function _syncActionsHtml(status) {
  const buttons = [];
  if (status.state === 'unconfigured') {
    return `<span class="settings__sync-hint">Save your Client ID below to enable sign-in.</span>`;
  }
  if (status.state === 'not-signed-in' || status.state === 'error') {
    buttons.push(`<button type="button" class="btn btn--primary" data-action="sign-in">Sign in to OneDrive</button>`);
  }
  if (status.state === 'signed-in' || status.state === 'busy') {
    buttons.push(`<button type="button" class="btn btn--primary" data-action="sync-now" ${status.busy ? 'disabled' : ''}>Sync now</button>`);
    buttons.push(`<button type="button" class="btn btn--ghost" data-action="load-from-cloud" ${status.busy ? 'disabled' : ''}>Load from cloud…</button>`);
    buttons.push(`<button type="button" class="btn btn--ghost" data-action="sign-out">Sign out</button>`);
  }
  return buttons.join('');
}

// -----------------------------------------------------------------------------
// Live status updates
// -----------------------------------------------------------------------------

async function _refreshSyncBlock(status) {
  if (!_root) return;
  const block = $('[data-target="sync-block"]', _root);
  if (!block) return;
  const settings = await Storage.settings.getAll();
  block.innerHTML = _syncBlockHtml(status, settings['cloud.lastSync']);
}

// -----------------------------------------------------------------------------
// Event wiring
// -----------------------------------------------------------------------------

function _wireEventListeners() {
  const form = $('form[data-form="cloud-config"]', _root);
  if (form) form.addEventListener('submit', _onSaveConfig);
  _root.addEventListener('click', _onRootClick);
}

async function _onSaveConfig(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const errEl = $('.form__error', form);
  errEl.textContent = '';

  const fd = new FormData(form);
  const clientId = String(fd.get('clientId') || '').trim();
  const folder   = String(fd.get('folder')   || '').trim() || 'QStore';
  const filename = String(fd.get('filename') || '').trim() || 'qstore_data.json';
  const autoSync = fd.get('autoSync') === 'on';

  // Validate the client ID is at least the right shape — Azure GUIDs are
  // 8-4-4-4-12 hex. Empty is allowed (clears the configuration).
  if (clientId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) {
    errEl.textContent = 'Client ID should be a GUID like 00000000-0000-0000-0000-000000000000.';
    return;
  }

  try {
    await Storage.settings.set('cloud.autoSync', autoSync);
    await getProvider().configure({ clientId, folder, filename });
    // Reset sync state so any previous error clears.
    await Sync.init();
    await Storage.audit.append({
      action: 'settings_change',
      user:   AUTH.getSession()?.name || 'unknown',
      desc:   `Cloud config updated (clientId set: ${clientId ? 'yes' : 'no'}, folder: ${folder}, file: ${filename}, autoSync: ${autoSync}).`,
    });
    await _refreshSyncBlock(Sync.getStatus());
    _flashSuccess('Cloud settings saved.');
  } catch (err) {
    errEl.textContent = err.message || 'Could not save settings.';
  }
}

async function _onRootClick(e) {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  switch (action) {
    case 'sign-in':         await _doSignIn();       break;
    case 'sign-out':        await _doSignOut();      break;
    case 'sync-now':        await _doSyncNow();      break;
    case 'load-from-cloud': await _doLoadFromCloud(); break;
  }
}

async function _doSignIn() {
  try {
    await getProvider().signIn();
    // On desktop popup, the sign-in is now complete and we can refresh.
    // On mobile redirect, the page has navigated away and this code never
    // executes — the next page load will resume.
    await _refreshSyncBlock(Sync.getStatus());
  } catch (err) {
    alert('Sign-in failed: ' + (err.message || err));
  }
}

async function _doSignOut() {
  if (!confirm('Sign out of OneDrive? Local data will not be affected.')) return;
  try {
    await getProvider().signOut();
    await _refreshSyncBlock(Sync.getStatus());
  } catch (err) {
    alert('Sign-out failed: ' + (err.message || err));
  }
}

async function _doSyncNow() {
  try {
    await Sync.syncNow();
    _flashSuccess('Synced to OneDrive.');
  } catch (err) {
    alert('Sync failed: ' + (err.message || err));
  }
}

async function _doLoadFromCloud() {
  openModal({
    titleHtml: 'Load from OneDrive — confirm',
    size: 'sm',
    bodyHtml: `
      <div class="modal__warn">
        <strong>This will replace ALL local data</strong> with the version
        currently in OneDrive. Local changes since the last sync will be lost.
        This cannot be undone.
      </div>
      <p>Type the word <strong>OVERWRITE</strong> to confirm.</p>
      <form class="form" data-form="confirm-load">
        <label class="form__field">
          <input type="text" name="confirm" autocomplete="off" placeholder="OVERWRITE">
        </label>
        <div class="form__error" role="alert"></div>
        <div class="form__actions">
          <button type="button" class="btn btn--ghost" data-action="modal-close">Cancel</button>
          <button type="submit" class="btn btn--danger">Replace local data</button>
        </div>
      </form>
    `,
    onMount(panel, close) {
      const form  = $('form[data-form="confirm-load"]', panel);
      const errEl = $('.form__error', panel);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errEl.textContent = '';
        const value = String(new FormData(form).get('confirm') || '').trim();
        if (value !== 'OVERWRITE') {
          errEl.textContent = 'Type OVERWRITE in capitals to confirm.';
          return;
        }
        try {
          const result = await Sync.loadFromCloud();
          if (!result.ok) {
            errEl.textContent = (result.error?.message) || 'Download failed.';
            return;
          }
          if (!result.imported) {
            errEl.textContent = 'No data file found in OneDrive yet.';
            return;
          }
          close();
          // Force a full reload so every page picks up the new data.
          // This is brutal but correct — the page-level state of the
          // current tab is now stale (item lists, filters, etc.) and the
          // simplest correct response is to start fresh.
          location.reload();
        } catch (err) {
          errEl.textContent = err.message || 'Download failed.';
        }
      });
    },
  });
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function _flashSuccess(message) {
  // TODO: replace with a proper toast in v2.1.
  // For now we use a small overlay that fades on its own.
  const flash = document.createElement('div');
  flash.className = 'flash flash--success';
  flash.textContent = message;
  document.body.appendChild(flash);
  setTimeout(() => flash.classList.add('is-leaving'), 2000);
  setTimeout(() => flash.remove(), 2600);
}
