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
import { STAFF_RANKS_CANONICAL, CADET_RANKS } from '../ranks.js';
import * as Recovery from '../recovery.js';
import * as Migration from '../migration.js';
import * as CsvUi from './csv-import.js';
import { showToast } from './toast.js';

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
  const settings       = await Storage.settings.getAll();
  const status         = Sync.getStatus();
  // Recovery status is per-user. The settings page already requires the OC
  // role at mount time, so the session userId is the OC's. If somehow we
  // end up with no session here we render a 'no code' state — defensive,
  // shouldn't happen in practice.
  const sess           = AUTH.getSession();
  const recoveryStatus = sess?.userId
    ? await Recovery.statusForUser(sess.userId)
    : { exists: false, createdAt: null };

  render(_root, `
    <section class="settings">
      <div class="settings__column">
        ${_unitSectionHtml(settings)}
        ${_recoverySectionHtml(recoveryStatus)}
        ${_cloudSectionHtml(settings, status)}
        ${_dataSectionHtml(settings)}
        ${_aboutSectionHtml()}
      </div>
    </section>
  `);

  _wireEventListeners();
}

// -----------------------------------------------------------------------------
// Unit branding section
// -----------------------------------------------------------------------------
// Surfaces the unit identity fields that v1 carried but v2 had no UI for.
// All values flow into the same flat 'settings' KV that the migration writes
// to, so a v1-migrated unit's existing values populate this form on first
// load. Keys consumed elsewhere:
//   - unitName / unitCode  → shell.js header, login.js title
//   - qmName / qmRank      → AB189 signature block (when that lands)
//   - coName (OC/QM)       → AB189 approver name + reports
//   - state                → AB189 (form footer)
//   - qmEmail / coEmail    → reserved for future notifications
//
// QM AND APPROVER ROLES
//   The QM may be either staff OR a cadet. Cadet QMs are a designed-in
//   role: cadets run day-to-day operations under staff oversight. The
//   rank datalist therefore offers BOTH staff ranks and cadet ranks as
//   suggestions, with staff ranks listed first since they remain the
//   more common arrangement. The field accepts any value regardless —
//   datalist is suggestions, not a constraint.
//
//   The approver field is labelled "OC/QM" because either the OC or a
//   staff QM can be the in-unit approving authority on AB189s. AB189s
//   are in-unit only — battalion Q-Store requests go through CadetNet
//   pro-formas, outside this app's scope. Two signatures (issuer + OC/QM
//   approver) are sufficient; no third signatory field is needed.
//
// SCHEMA KEY vs LABEL
//   The settings KV keys 'coName' and 'coEmail' predate the OC/QM
//   labelling decision and remain unchanged to avoid a migration step
//   for what is a cosmetic relabel. Treat them as 'approver name/email'
//   internally; only the visible label matters to the user.
//
// The state field is a fixed dropdown of AU codes; the AB189 form needs an
// exact match.
// -----------------------------------------------------------------------------

const AU_STATES = ['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA'];

function _unitSectionHtml(settings) {
  const unitName   = settings.unitName  || '';
  const unitCode   = settings.unitCode  || '';
  const state      = settings.state     || '';
  const qmName     = settings.qmName    || '';
  const qmRank     = settings.qmRank    || '';
  const qmEmail    = settings.qmEmail   || '';
  const coName     = settings.coName    || '';
  const coEmail    = settings.coEmail   || '';
  const logoDataUrl = settings.unitLogo || null;

  const stateOptions = ['', ...AU_STATES].map((code) => {
    const label = code || '— Select —';
    const sel   = code === state ? ' selected' : '';
    return `<option value="${esc(code)}"${sel}>${esc(label)}</option>`;
  }).join('');

  // Staff ranks first (more common QM arrangement), cadet ranks after.
  // The full list is suggestions only — the field accepts any value.
  const rankOptions = [...STAFF_RANKS_CANONICAL, ...CADET_RANKS].map((r) =>
    `<option value="${esc(r)}">`
  ).join('');

  return `
    <section class="settings__section" data-section="unit">
      <header class="settings__section-header">
        <h2 class="settings__section-title">Unit details</h2>
        <p class="settings__section-hint">
          These fields appear in the app header, on the login screen, and on
          generated AB189 forms and reports. Only the OC can edit them.
        </p>
      </header>

      <form class="form" data-form="unit-config" autocomplete="off">
        <div class="form__row">
          <label class="form__field form__field--grow">
            <span class="form__label">Unit name</span>
            <input type="text" name="unitName" value="${esc(unitName)}" maxlength="80"
                   placeholder="1 Australian Cadet Training Unit">
            <span class="form__hint">Full name shown in the app header and login screen</span>
          </label>
          <label class="form__field">
            <span class="form__label">Unit code</span>
            <input type="text" name="unitCode" value="${esc(unitCode)}" maxlength="16"
                   placeholder="1 ACTU" spellcheck="false">
            <span class="form__hint">Short code (e.g. 145 ACU)</span>
          </label>
        </div>

        <div class="form__row">
          <label class="form__field">
            <span class="form__label">State</span>
            <select name="state">${stateOptions}</select>
            <span class="form__hint">Used on AB189 form footer</span>
          </label>
          <label class="form__field form__field--grow">
            <span class="form__label">OC/QM name</span>
            <input type="text" name="coName" value="${esc(coName)}" maxlength="80"
                   placeholder="Surname, Given names">
          </label>
          <label class="form__field form__field--grow">
            <span class="form__label">OC/QM email</span>
            <input type="email" name="coEmail" value="${esc(coEmail)}" maxlength="120"
                   placeholder="co@example.com" spellcheck="false">
          </label>
        </div>

        <div class="form__row">
          <label class="form__field">
            <span class="form__label">QM rank</span>
            <input type="text" name="qmRank" value="${esc(qmRank)}" maxlength="16"
                   placeholder="e.g. CAPT-AAC, CDTWO1, DAH"
                   list="qm-rank-options" spellcheck="false">
            <datalist id="qm-rank-options">${rankOptions}</datalist>
            <span class="form__hint">Staff or cadet rank — choose from list or type</span>
          </label>
          <label class="form__field form__field--grow">
            <span class="form__label">QM name</span>
            <input type="text" name="qmName" value="${esc(qmName)}" maxlength="80"
                   placeholder="Surname, Given names">
          </label>
          <label class="form__field form__field--grow">
            <span class="form__label">QM email</span>
            <input type="email" name="qmEmail" value="${esc(qmEmail)}" maxlength="120"
                   placeholder="qm@example.com" spellcheck="false">
          </label>
        </div>

        <div class="form__error" role="alert"></div>
        <div class="form__actions">
          <button type="submit" class="btn btn--primary">Save unit details</button>
        </div>
      </form>

      <div class="settings__logo">
        <h3 class="settings__logo-title">Unit logo</h3>
        <p class="settings__section-hint">
          Displayed in the app header at top-left. PNG or SVG recommended
          (preserves transparency). Resized to fit the header automatically.
          Max 5 MB.
        </p>
        ${logoDataUrl ? `
          <div class="settings__logo-preview-wrap">
            <img class="settings__logo-preview" src="${esc(logoDataUrl)}" alt="Current unit logo">
          </div>
        ` : `
          <p class="settings__section-hint" style="margin-top:8px">No logo set.</p>
        `}
        <div class="form__actions" style="margin-top:8px">
          <label class="btn btn--ghost settings__logo-upload-label">
            ${logoDataUrl ? 'Replace logo' : 'Upload logo'}
            <input type="file" accept="image/*" data-target="logo-file-input" hidden>
          </label>
          ${logoDataUrl ? `
            <button type="button" class="btn btn--ghost" data-action="logo-remove">
              Remove logo
            </button>
          ` : ''}
        </div>
        <div class="form__error" data-target="logo-error" role="alert"></div>
      </div>
    </section>
  `;
}

// -----------------------------------------------------------------------------
// Recovery code section — OC-only PIN reset coverage
// -----------------------------------------------------------------------------
// The settings page is gated by AUTH.requireCO at mount time, so every
// visitor here is an OC. Each OC's recovery code is bound to their own
// user record — if the unit has multiple OC accounts, each has their own
// independent code.
//
// "Retrievable while logged in" semantics: because we only store the
// argon2id hash, we cannot show the plaintext of an existing code. The
// retrieve flow is therefore actually a regenerate flow: pressing the
// button generates a new code, invalidates the old one, and shows the
// new code in a one-shot display modal. This is the honest behaviour
// given the storage choice — pretending we can "show" an existing code
// would require storing it reversibly, which would mean the recovery
// code has weaker protection at rest than the PIN it recovers. Not an
// acceptable trade.

function _recoverySectionHtml(recoveryStatus) {
  const exists = recoveryStatus.exists;
  const createdAt = exists && recoveryStatus.createdAt
    ? fmtDate(recoveryStatus.createdAt)
    : null;

  const statusBlock = exists
    ? `<div class="settings__status settings__status--ok">
         <strong>Active.</strong> Generated ${esc(createdAt)}.
       </div>`
    : `<div class="settings__status settings__status--warn">
         <strong>No active recovery code.</strong>
         If you forget your PIN there is no in-app recovery path. Generate
         one now.
       </div>`;

  const buttonLabel = exists ? 'Regenerate recovery code' : 'Generate recovery code';

  return `
    <section class="settings__section" data-section="recovery">
      <header class="settings__section-header">
        <h2 class="settings__section-title">OC PIN recovery</h2>
        <p class="settings__section-hint">
          A 12-character one-shot code that resets your PIN from the login
          screen if you forget it. Store it off this device &mdash; a
          printed copy in the unit safe or key cabinet is appropriate.
        </p>
      </header>
      ${statusBlock}
      <div class="form__actions">
        <button type="button" class="btn btn--primary"
                data-action="recovery-generate">${esc(buttonLabel)}</button>
      </div>
    </section>
  `;
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

  // Cloud-disabled toggle: when true, the cloud sync UI collapses to just
  // the policy notice + the toggle itself, and Sync.notifyChanged is a
  // no-op. Useful for deployments where cloud sync is policy-prohibited
  // (e.g. defence-issued laptops where ITSO has restricted it) or where
  // the QM simply doesn't want it.
  const cloudDisabled = settings['cloud.disabled'] === true;

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

      <div class="settings__notice settings__notice--policy">
        <strong>Use unit-owned cloud storage only.</strong>
        Australian Army Cadet units are permitted to use their own
        OneDrive accounts (personal Microsoft, family, or unit-purchased
        Microsoft 365 Business) for Q-Store data. <strong>Do not sign in
        with a defence-issued account</strong> &mdash; defence M365
        tenants are not approved for this tool. If you're unsure which
        account is which, check with your unit's IT contact or the
        brigade ITSO before signing in.
      </div>

      <label class="form__field form__check">
        <input type="checkbox" name="cloudDisabled"
               data-action="toggle-cloud-disabled"
               ${cloudDisabled ? 'checked' : ''}>
        <span>Disable cloud sync entirely (sign out and hide the rest of this section)</span>
      </label>

      ${cloudDisabled ? `
        <p class="settings__section-hint">
          Cloud sync is off. Local data continues to work normally, and
          you can still use manual export/import below to back up the
          database to a file.
        </p>
      ` : `
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
      `}
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

// -----------------------------------------------------------------------------
// Data backup section — manual export/import
// -----------------------------------------------------------------------------
// Independent of cloud sync. Works on any origin including file://. Provides
// the only recovery path when cloud sync isn't configured.
//
// Export: builds the snapshot, triggers a download via a transient anchor.
//   Logs a 'data_export' audit entry BEFORE building the snapshot so the
//   entry is present in the export itself — the file self-documents when it
//   was created.
//
// Import: destructive. Wipes operational data and replaces it with the
//   snapshot. Same OVERWRITE-typed confirmation as cloud load, then a file
//   picker, then importAll. After success, force a reload so every page
//   picks up the new data and the audit key change.
//
// Both operations can take a few seconds on large datasets (lots of photos);
// buttons are disabled while in progress.
// -----------------------------------------------------------------------------

function _dataSectionHtml(settings) {
  const unitCode = settings.unitCode || '';
  const unitName = settings.unitName || '';
  const lastExport = settings['data.lastExport'] || null;
  const lastImport = settings['data.lastImport'] || null;

  const unitLabel = (unitCode || unitName)
    ? `<span class="settings__section-meta">${esc(unitCode || unitName)}</span>`
    : '';

  return `
    <section class="settings__section" data-section="data">
      <header class="settings__section-header">
        <h2 class="settings__section-title">Data backup &amp; restore ${unitLabel}</h2>
        <p class="settings__section-hint">
          Export a complete snapshot of this Q-Store to a file you can keep
          off-device, or restore from a previously exported file. Use this
          for end-of-cycle archives, transferring to a new computer, or as a
          fallback when cloud sync isn't available.
        </p>
      </header>

      <div class="modal__warn" style="margin-bottom:12px">
        <strong>The export contains sensitive data.</strong>
        Cadet personal details, audit log, and (hashed) user PINs are all
        included. Treat the file as PROTECTED — store it on encrypted media
        or a secure unit drive, not on personal cloud storage.
      </div>

      <div class="form__row">
        <div class="form__field form__field--grow">
          <span class="form__label">Last export</span>
          <span class="settings__data-meta">${esc(fmtDate(lastExport))}</span>
        </div>
        <div class="form__field form__field--grow">
          <span class="form__label">Last import</span>
          <span class="settings__data-meta">${esc(fmtDate(lastImport))}</span>
        </div>
      </div>

      <div class="form__actions">
        <button type="button" class="btn btn--primary"
                data-action="export-data">Download backup file</button>
        <button type="button" class="btn btn--danger"
                data-action="import-data">Restore from backup file&hellip;</button>
      </div>

      <details class="settings__details">
        <summary>Import data from a v1 backup file</summary>
        <div class="settings__details-body">
          <p>
            One-time migration from a QStore v1 backup file (filename pattern
            <code>qstore_&lt;unitcode&gt;_&lt;date&gt;.json</code>). This is a
            destructive operation: it clears the v2 database first, then
            imports the v1 contents through a schema migration. Use this when
            transitioning a unit from v1 to v2 for the first time.
          </p>
          <p>
            <strong>Not the same as Restore from backup file</strong> above —
            that's the v2-to-v2 path. Picking the wrong button is rejected
            by a file-shape sanity check, but the buttons are kept distinct
            for clarity.
          </p>
          <div class="form__actions">
            <button type="button" class="btn btn--danger"
                    data-action="import-v1">Import from v1 backup file&hellip;</button>
          </div>
        </div>
      </details>

      <details class="settings__details">
        <summary>Import items from CSV</summary>
        <div class="settings__details-body">
          <p>
            Bulk-import inventory items from a spreadsheet. Useful when
            transitioning a unit from a non-QStore system (Excel, paper).
            Existing items match by <code>id</code> or <code>nsn</code> and
            are updated in place — fields not in the CSV (like
            <code>onLoan</code>, photos, creation timestamps) are preserved.
          </p>
          <p>
            A preview is shown before any data is written. You can review
            the column mapping and row counts and cancel without committing.
          </p>
          <div class="form__actions">
            <button type="button" class="btn btn--primary"
                    data-action="import-items-csv">Import items from CSV&hellip;</button>
          </div>
        </div>
      </details>

      <details class="settings__details">
        <summary>Import cadets from CSV</summary>
        <div class="settings__details-body">
          <p>
            Bulk-import cadets and staff from a spreadsheet. Existing records
            match by <code>svcNo</code> and are updated in place.
          </p>
          <p>
            Rank values are normalised — <code>Cdt</code>/<code>cdt</code>/<code>CDT</code>
            all become <code>CDT</code>. The <code>active</code> flag accepts
            true/false/yes/no/1/0 as values.
          </p>
          <div class="form__actions">
            <button type="button" class="btn btn--primary"
                    data-action="import-cadets-csv">Import cadets from CSV&hellip;</button>
          </div>
        </div>
      </details>

      <input type="file" data-target="import-file"
             accept="application/json,.json" hidden>
      <input type="file" data-target="import-v1-file"
             accept="application/json,.json" hidden>
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
  const cloudForm = $('form[data-form="cloud-config"]', _root);
  if (cloudForm) cloudForm.addEventListener('submit', _onSaveConfig);
  const unitForm = $('form[data-form="unit-config"]', _root);
  if (unitForm) unitForm.addEventListener('submit', _onSaveUnit);
  _root.addEventListener('click', _onRootClick);

  const logoInput = $('input[data-target="logo-file-input"]', _root);
  if (logoInput) logoInput.addEventListener('change', _onLogoFileChange);

  // Cloud-disabled toggle. The checkbox lives outside any <form>, so we
  // listen for the change event directly on the root and dispatch from
  // the data-action attribute. Saving the setting is async — we mark
  // the checkbox disabled while the save runs to prevent rapid-fire
  // toggling that could leave settings and runtime out of step.
  const cloudToggle = $('input[data-action="toggle-cloud-disabled"]', _root);
  if (cloudToggle) {
    cloudToggle.addEventListener('change', _onToggleCloudDisabled);
  }
}

async function _onToggleCloudDisabled(e) {
  const checkbox = e.target;
  const desiredDisabled = checkbox.checked;
  checkbox.disabled = true;
  try {
    await Storage.settings.set('cloud.disabled', desiredDisabled);
    if (desiredDisabled) {
      // If the user is currently signed in, sign them out so the
      // disabled state is genuinely "no cloud activity". This also
      // clears any cached MSAL tokens. Errors from sign-out are
      // non-fatal — the setting is still applied.
      try {
        const provider = getProvider();
        if (provider && provider.isSignedIn && provider.isSignedIn()) {
          await provider.signOut();
        }
      } catch (err) {
        console.warn('Sign-out during cloud-disable failed:', err);
      }
    }
    await Storage.audit.append({
      action: 'settings_change',
      user:   AUTH.getSession()?.name || 'unknown',
      desc:   desiredDisabled
        ? 'Cloud sync disabled (UI hidden, sync engine stopped, signed out).'
        : 'Cloud sync re-enabled.',
    });
    Sync.notifyChanged();   // trigger a status emit so the sync block
                            // updates if it's now visible
    await _render();
  } catch (err) {
    showToast('Failed to update cloud-disabled setting: ' + (err.message || err), 'error');
    // Roll back the visual state so the UI matches storage.
    checkbox.checked = !desiredDisabled;
  } finally {
    checkbox.disabled = false;
  }
}

async function _onSaveUnit(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const errEl = $('.form__error', form);
  errEl.textContent = '';

  const fd = new FormData(form);
  // Trim everything; empty strings are valid (clears the field).
  const fields = {
    unitName: String(fd.get('unitName') || '').trim(),
    unitCode: String(fd.get('unitCode') || '').trim(),
    state:    String(fd.get('state')    || '').trim(),
    qmName:   String(fd.get('qmName')   || '').trim(),
    qmRank:   String(fd.get('qmRank')   || '').trim().toUpperCase(),
    qmEmail:  String(fd.get('qmEmail')  || '').trim(),
    coName:   String(fd.get('coName')   || '').trim(),
    coEmail:  String(fd.get('coEmail')  || '').trim(),
  };

  // Light validation only — emails optional, but if present must look like one.
  // We are deliberately permissive on rank: free text with a datalist of
  // suggestions is enough; AB189 generation can validate strictly at use.
  for (const key of ['qmEmail', 'coEmail']) {
    if (fields[key] && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields[key])) {
      errEl.textContent = `${key === 'qmEmail' ? 'QM' : 'OC/QM'} email is not in a valid format.`;
      return;
    }
  }

  try {
    await Storage.settings.setMany(fields);
    await Storage.audit.append({
      action: 'settings_change',
      user:   AUTH.getSession()?.name || 'unknown',
      desc:   `Unit details updated (name: ${fields.unitName || '(empty)'}, code: ${fields.unitCode || '(empty)'}).`,
    });
    // Soft-update the shell brand without a re-render so we don't lose the
    // settings page's open state. We deliberately don't try to update the
    // login screen because the user is logged in — login screen's values
    // refresh next time it mounts.
    // Soft-update the shell brand. name+code now live inside .shell__brand-text
    // so the parent for new element insertion is that wrapper, not .shell__brand.
    const brand     = document.querySelector('.shell__brand');
    const brandText = brand && brand.querySelector('.shell__brand-text');
    const brandName = brandText && brandText.querySelector('.shell__brand-name');
    if (brandName) brandName.textContent = fields.unitName || 'QStore IMS';
    if (brandText) {
      let brandCode = brandText.querySelector('.shell__brand-code');
      if (fields.unitCode) {
        if (!brandCode) {
          brandCode = document.createElement('div');
          brandCode.className = 'shell__brand-code';
          brandText.appendChild(brandCode);
        }
        brandCode.textContent = fields.unitCode;
      } else if (brandCode) {
        brandCode.remove();
      }
    }
    _flashSuccess('Unit details saved.');
  } catch (err) {
    errEl.textContent = err.message || 'Could not save unit details.';
  }
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
    case 'export-data':     await _doExportData(e.target.closest('button')); break;
    case 'import-data':     await _doImportData(e.target.closest('button')); break;
    case 'import-v1':       await _doImportV1(e.target.closest('button')); break;
    case 'import-items-csv':  CsvUi.openItemsCsvImport();  break;
    case 'import-cadets-csv': CsvUi.openCadetsCsvImport(); break;
    case 'recovery-generate': await _doGenerateRecovery(e.target.closest('button')); break;
    case 'logo-remove':       await _doRemoveLogo(); break;
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
    showToast('Sign-in failed: ' + (err.message || err), 'error');
  }
}

async function _doSignOut() {
  if (!confirm('Sign out of OneDrive? Local data will not be affected.')) return;
  try {
    await getProvider().signOut();
    await _refreshSyncBlock(Sync.getStatus());
  } catch (err) {
    showToast('Sign-out failed: ' + (err.message || err), 'error');
  }
}

async function _doSyncNow() {
  try {
    await Sync.syncNow();
    _flashSuccess('Synced to OneDrive.');
  } catch (err) {
    showToast('Sync failed: ' + (err.message || err), 'error');
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
// Data backup / restore handlers
// -----------------------------------------------------------------------------
// These run from the data section buttons. Each disables its trigger button
// while running so a frantic double-click can't kick off two exports or two
// imports racing each other through the same IndexedDB transaction queue.

async function _doExportData(btn) {
  if (btn) btn.disabled = true;
  try {
    // Audit BEFORE building the snapshot, so the export self-documents.
    // The audit entry will be inside the snapshot we hand the user.
    await Storage.audit.append({
      action: 'data_export',
      user:   AUTH.getSession()?.name || 'unknown',
      desc:   'Manual data export to file.',
    });

    const snapshot = await Storage.exportAll();
    const blob = new Blob([JSON.stringify(snapshot)], { type: 'application/json' });

    const settings = await Storage.settings.getAll();
    const unitTag = (settings.unitCode || settings.unitName || 'qstore')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'qstore';
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const filename = `qstore-backup-${unitTag}-${stamp}.json`;

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke after a tick — some browsers need the URL to still be valid
    // when the click handler returns.
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    await Storage.settings.set('data.lastExport', new Date().toISOString());
    await _render();
    _flashSuccess(`Backup saved as ${filename}.`);
  } catch (err) {
    console.error('Export failed:', err);
    showToast('Export failed: ' + (err.message || err), 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function _doImportData(btn) {
  // Step 1 — typed-OVERWRITE confirmation dialog. Same pattern as cloud load.
  // Only after the user types OVERWRITE do we open the file picker. This
  // keeps the destructive action behind a deliberate gate.
  openModal({
    titleHtml: 'Restore from backup — confirm',
    size: 'sm',
    bodyHtml: `
      <div class="modal__warn">
        <strong>This will replace ALL local data</strong> with the contents of
        the backup file you select. Local changes since that backup was made
        will be lost. This cannot be undone.
      </div>
      <p>The backup file's user accounts will replace the current ones — make
      sure you know the PINs for the accounts in the backup before continuing,
      or you may lock yourself out.</p>
      <p>Type the word <strong>OVERWRITE</strong> to confirm.</p>
      <form class="form" data-form="confirm-restore">
        <label class="form__field">
          <input type="text" name="confirm" autocomplete="off" placeholder="OVERWRITE">
        </label>
        <div class="form__error" role="alert"></div>
        <div class="form__actions">
          <button type="button" class="btn btn--ghost" data-action="modal-close">Cancel</button>
          <button type="submit" class="btn btn--danger">Choose file&hellip;</button>
        </div>
      </form>
    `,
    onMount(panel, close) {
      const form  = $('form[data-form="confirm-restore"]', panel);
      const errEl = $('.form__error', panel);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        errEl.textContent = '';
        const value = String(new FormData(form).get('confirm') || '').trim();
        if (value !== 'OVERWRITE') {
          errEl.textContent = 'Type OVERWRITE in capitals to confirm.';
          return;
        }
        close();
        // Trigger the hidden file input. The file picker dialog itself
        // serves as the second-stage gate — cancelling it cancels the
        // operation cleanly.
        const fileInput = $('input[data-target="import-file"]', _root);
        if (!fileInput) {
          showToast('Internal error: file input missing.', 'error');
          return;
        }
        // One-shot listener so repeated imports don't stack handlers.
        const onChange = async () => {
          fileInput.removeEventListener('change', onChange);
          const file = fileInput.files && fileInput.files[0];
          fileInput.value = ''; // allow re-selecting the same file later
          if (!file) return;
          await _performImport(file, btn);
        };
        fileInput.addEventListener('change', onChange);
        fileInput.click();
      });
    },
  });
}

async function _performImport(file, btn) {
  if (btn) btn.disabled = true;
  try {
    const text = await file.text();
    let snapshot;
    try {
      snapshot = JSON.parse(text);
    } catch {
      showToast('That file is not valid JSON. Choose a backup file produced by QStore.', 'error');
      return;
    }
    if (!snapshot || typeof snapshot !== 'object' || !snapshot.schemaVersion) {
      showToast('That file is not a QStore backup (missing schemaVersion).', 'error');
      return;
    }
    // Storage.importAll throws on schema mismatch; we surface that cleanly.
    await Storage.importAll(snapshot);

    // Log AFTER importAll because importAll wipes the audit store and
    // replaces it with the snapshot's chain. Logging before the import
    // would put the entry into a chain that's about to be discarded.
    // The post-import audit append uses the freshly-loaded auditKey from
    // the snapshot's meta, so it extends the imported chain correctly.
    await Storage.audit.append({
      action: 'data_imported',
      user:   AUTH.getSession()?.name || 'unknown',
      desc:   `Manual restore from backup file: ${file.name} (snapshot exported ${snapshot.exportedAt || 'unknown date'}).`,
    });
    await Storage.settings.set('data.lastImport', new Date().toISOString());

    // Force a reload — the current page state is now stale, and the
    // session may also be invalid (the imported users table might not
    // contain the currently-logged-in user).
    showToast('Backup restored. The page will now reload.', 'success', 2000);
    location.reload();
  } catch (err) {
    console.error('Import failed:', err);
    showToast('Restore failed: ' + (err.message || err), 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
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


// -----------------------------------------------------------------------------
// Recovery-code generation handler
// -----------------------------------------------------------------------------
// Generates (or regenerates — same flow) a recovery code for the currently-
// logged-in OC. Disables the button during the argon2 hash to prevent
// double-submit (which would otherwise generate two codes and invalidate
// the first immediately).
//
// We use the existing setPin pathway? — No. setPin is for changing the PIN
// itself; here we want to replace JUST the recovery hash without touching
// the PIN. Recovery.generateForUser handles the storage write directly.
//
// Audit: 'recovery_set' for fresh generation, 'recovery_rotated' for
// regeneration of an existing code. Distinguishing them in the audit log
// helps a future investigator answer "when was this code last refreshed".

async function _doGenerateRecovery(button) {
  const sess = AUTH.getSession();
  if (!sess?.userId) {
    showToast('No active session — cannot generate recovery code.', 'warn');
    return;
  }

  // Confirm if we're about to overwrite an existing code.
  const before = await Recovery.statusForUser(sess.userId);
  if (before.exists) {
    const ok = confirm(
      'Generating a new recovery code will invalidate the existing one.\n\n' +
      'Make sure you can update or replace any printed copy of the previous code.\n\n' +
      'Continue?'
    );
    if (!ok) return;
  }

  if (button) button.disabled = true;
  try {
    const formattedCode = await Recovery.generateForUser(sess.userId);
    await Storage.audit.append({
      action: before.exists ? 'recovery_rotated' : 'recovery_set',
      user:   sess.name || 'unknown',
      desc:   before.exists
        ? `Recovery code regenerated for ${sess.username || sess.userId} from settings.`
        : `Recovery code generated for ${sess.username || sess.userId} from settings.`,
    });
    // Re-render the section so the status block updates from "no active code"
    // to "active, generated <date>". Quickest way: re-render the whole page.
    // It's cheap because we're already on the settings page.
    await _render();
    // Show the code AFTER the re-render so the modal sits on top of the
    // updated status block — gives the user feedback that something changed
    // even before they read the code.
    _openRecoveryFromSettings(formattedCode, before.exists);
  } catch (err) {
    showToast('Failed to generate recovery code: ' + (err.message || err), 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

// Local copy of the recovery-display modal — settings.js can't import from
// shell.js without a circular dependency (shell.js mounts pages including
// settings). The modal content is similar but the framing text differs:
// settings-initiated regeneration emphasises the off-device storage rule
// and the fact that the previous code is now invalid.
function _openRecoveryFromSettings(formattedCode, wasRotation) {
  const headline = wasRotation
    ? 'New recovery code generated'
    : 'Your recovery code';
  const intro = wasRotation
    ? 'Your previous recovery code is no longer valid. Replace any printed copy with this new one.'
    : 'Write this down and store it OFF this device. You will not see it again — generating another code from this page invalidates this one.';

  openModal({
    titleHtml: esc(headline),
    size:      'sm',
    bodyHtml:  `
      <p class="modal__body">${esc(intro)}</p>
      <div class="recovery-code__display" role="textbox" aria-readonly="true"
           aria-label="Recovery code">${esc(formattedCode)}</div>
      <div class="modal__warn">
        <strong>Store this code OFF this device.</strong> A printed copy in a
        sealed envelope in the unit safe is appropriate. Anyone with this
        code can reset the OC PIN and gain administrative access.
      </div>
      <form class="form" data-form="ack-recovery-settings">
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
      const form = $('form[data-form="ack-recovery-settings"]', panel);
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

// =============================================================================
// Unit logo upload / remove
// =============================================================================
// The logo is stored as a PNG data URL in the settings store under key
// 'unitLogo'. Storing as a data URL means it's included in backup exports
// without any extra serialisation logic, and it renders inline in the <img>
// without an object-URL lifecycle to manage.
//
// Size budget: we cap input at 5 MB and resize to fit 400×160 px before
// encoding as PNG. A typical unit badge at that size is 20–80 KB as a
// data URL — well within the settings store's practical limits.
//
// PNG is used (not JPEG) to preserve transparency, which most unit logos need.

async function _onLogoFileChange(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';  // allow re-selecting the same file later
  if (!file) return;

  const errEl = $('[data-target="logo-error"]', _root);
  if (errEl) errEl.textContent = '';

  if (!file.type.startsWith('image/')) {
    if (errEl) errEl.textContent = 'File must be an image (PNG, JPEG, SVG, etc.).';
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    const mb = (file.size / 1024 / 1024).toFixed(1);
    if (errEl) errEl.textContent = `Image is ${mb} MB — maximum is 5 MB.`;
    return;
  }

  try {
    const dataUrl = await _processLogo(file);
    await Storage.settings.set('unitLogo', dataUrl);
    _softUpdateHeaderLogo(dataUrl);
    await _render();
    _flashSuccess('Logo updated.');
  } catch (err) {
    if (errEl) errEl.textContent = err.message || 'Failed to process logo.';
  }
}

async function _doRemoveLogo() {
  await Storage.settings.set('unitLogo', null);
  _softUpdateHeaderLogo(null);
  await _render();
  _flashSuccess('Logo removed.');
}

async function _processLogo(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('Could not decode image. Try a different file or format.');
  }

  try {
    // Fit inside 400×160 (2× the header logo slot at HiDPI). Keeps the stored
    // data URL small while staying sharp on retina displays.
    const MAX_W = 400;
    const MAX_H = 160;
    const scale = Math.min(MAX_W / bitmap.width, MAX_H / bitmap.height, 1);
    const w = Math.max(1, Math.round(bitmap.width  * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width  = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    return canvas.toDataURL('image/png');
  } finally {
    if (bitmap.close) bitmap.close();
  }
}

function _softUpdateHeaderLogo(logoDataUrl) {
  const brand = document.querySelector('.shell__brand');
  if (!brand) return;
  let logoImg = brand.querySelector('.shell__brand-logo');
  if (logoDataUrl) {
    if (!logoImg) {
      logoImg = document.createElement('img');
      logoImg.className = 'shell__brand-logo';
      logoImg.alt = '';
      brand.insertBefore(logoImg, brand.firstChild);
    }
    logoImg.src = logoDataUrl;
  } else {
    if (logoImg) logoImg.remove();
  }
}

// =============================================================================
// v1 backup file import
// =============================================================================
// Distinct from _doImportData (the v2-to-v2 restore). v1 import takes a
// QStore v1 export file, wipes the v2 db, and runs schema migration. The
// wipe is irrevocable; the confirmation gate is intentionally explicit.
//
// FLOW
//   1. Confirmation modal (typed OVERWRITE — matches v2 restore)
//   2. File picker (hidden input data-target="import-v1-file")
//   3. _performV1Import: read file → JSON.parse → Migration.runFromObject
//   4. Final modal showing what came through
//
// AUDIT
//   Migration.runFromObject appends 'v1_import' to the v2 audit log on
//   success. We don't append a second entry from the UI.

async function _doImportV1(btn) {
  openModal({
    titleHtml: 'Import v1 backup — confirm',
    size:      'sm',
    bodyHtml: `
      <div class="modal__warn">
        <strong>This will replace ALL local data</strong> with the contents of
        the v1 backup file you select. This cannot be undone. Use this only
        when transitioning a unit from QStore v1 to v2 for the first time.
      </div>
      <p>
        The v1 backup's user accounts will replace the current ones &mdash;
        make sure you know the PINs from your v1 install before continuing,
        or you will lock yourself out.
      </p>
      <p>
        Your v1 OneDrive sync configuration will <strong>not</strong> be
        carried over (v1 stored it in a separate place that's not in the
        backup file). You'll re-enter cloud sync settings in v2 if you want
        to use them.
      </p>
      <p>Type the word <strong>OVERWRITE</strong> to confirm.</p>
      <form class="form" data-form="confirm-v1">
        <label class="form__field">
          <input type="text" name="confirm" autocomplete="off" placeholder="OVERWRITE">
        </label>
        <div class="form__error" role="alert"></div>
        <div class="form__actions">
          <button type="button" class="btn btn--ghost" data-action="modal-close">Cancel</button>
          <button type="submit" class="btn btn--danger">Choose v1 file&hellip;</button>
        </div>
      </form>
    `,
    onMount(panel, close) {
      const form  = $('form[data-form="confirm-v1"]', panel);
      const errEl = $('.form__error', panel);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        errEl.textContent = '';
        const value = String(new FormData(form).get('confirm') || '').trim();
        if (value !== 'OVERWRITE') {
          errEl.textContent = 'Type OVERWRITE in capitals to confirm.';
          return;
        }
        close();
        const fileInput = $('input[data-target="import-v1-file"]', _root);
        if (!fileInput) {
          showToast('Internal error: v1 file input missing.', 'error');
          return;
        }
        const onChange = async () => {
          fileInput.removeEventListener('change', onChange);
          const file = fileInput.files && fileInput.files[0];
          fileInput.value = '';
          if (!file) return;
          await _performV1Import(file, btn);
        };
        fileInput.addEventListener('change', onChange);
        fileInput.click();
      });
    },
  });
}

async function _performV1Import(file, btn) {
  if (btn) btn.disabled = true;

  // Read + parse first, before opening the progress modal — if the file
  // is malformed we'd rather show the error inline than open a "0%
  // Migrating…" modal then immediately abort.
  let parsed;
  try {
    const text = await file.text();
    parsed = JSON.parse(text);
  } catch (err) {
    showToast('Could not read the v1 file: ' + (err.message || err) + ' — The file may be corrupted or not a valid JSON export.', 'error');
    if (btn) btn.disabled = false;
    return;
  }

  // Open a progress modal. The migration itself reports progress via
  // onProgress(msg, pct); we update the modal's body in place.
  let progressClose = null;
  let progressBody  = null;
  openModal({
    titleHtml: 'Importing v1 data…',
    size:      'sm',
    bodyHtml: `
      <p class="modal__body" data-target="v1-progress-msg">Starting…</p>
      <div class="settings__progress" aria-live="polite">
        <div class="settings__progress-bar" data-target="v1-progress-bar"
             style="width: 0%"></div>
      </div>
      <p class="modal__body modal__body--small">
        Do not close this tab until the import completes.
      </p>
    `,
    onMount(panel, close) {
      progressClose = close;
      progressBody  = panel;
    },
  });

  const onProgress = (msg, pct) => {
    if (!progressBody) return;
    const m = $('[data-target="v1-progress-msg"]', progressBody);
    const b = $('[data-target="v1-progress-bar"]', progressBody);
    if (m) m.textContent = msg;
    if (b) b.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  };

  let result;
  try {
    result = await Migration.runFromObject(parsed, { wipeFirst: true, onProgress });
  } catch (err) {
    if (progressClose) progressClose();
    showToast('v1 import failed: ' + (err.message || err) + ' — Database may be partially migrated. Restore from a v2 backup or re-run the import.', 'error', 8000);
    if (btn) btn.disabled = false;
    return;
  }

  if (progressClose) progressClose();

  // Summary modal — shows the counts the migration reports back. The user
  // can use these to spot-check that nothing was silently dropped.
  const c = result.counts || {};
  openModal({
    titleHtml: 'v1 import complete',
    size:      'sm',
    bodyHtml: `
      <p class="modal__body">
        v1 backup imported successfully. Reload the page or navigate to a
        page (Inventory, Cadets, Loans) to see the migrated data.
      </p>
      <ul class="settings__import-summary">
        <li>${esc(String(c.items     || 0))} inventory items</li>
        <li>${esc(String(c.cadets    || 0))} cadets / staff</li>
        <li>${esc(String(c.loans     || 0))} loan records</li>
        <li>${esc(String(c.users     || 0))} user accounts</li>
        <li>${esc(String(c.auditEntries || 0))} audit entries (re-chained, marked imported)</li>
      </ul>
      <p class="modal__body modal__body--small">
        Cloud sync settings were not carried over. If you want OneDrive
        sync, configure it in the Cloud sync section above. The v1 import
        action has been audited.
      </p>
      <div class="form__actions">
        <button type="button" class="btn btn--primary" data-action="modal-close">OK</button>
      </div>
    `,
  });

  // Re-render so the data section's "last import" timestamp updates.
  await _render();
  if (btn) btn.disabled = false;
}

// -----------------------------------------------------------------------------
// About section
// -----------------------------------------------------------------------------

function _aboutSectionHtml() {
  return `
    <section class="settings__section" data-section="about">
      <header class="settings__section-header">
        <h2 class="settings__section-title">About QStore IMS</h2>
      </header>

      <div class="about__block">
        <div class="about__app-name">QStore IMS <span class="about__version">v2</span></div>
        <p class="about__tagline">Inventory Management System for Australian Army Cadet Q-Stores</p>
      </div>

      <div class="about__credits">
        <div class="about__credit-row">
          <span class="about__credit-label">Primary Author</span>
          <span class="about__credit-value">Sean Scales</span>
        </div>
        <div class="about__credit-row">
          <span class="about__credit-label">AI Development Partner</span>
          <span class="about__credit-value">Claude Sonnet 4.6 — Anthropic</span>
        </div>
        <div class="about__credit-row">
          <span class="about__credit-label">Copyright</span>
          <span class="about__credit-value">&copy; ${new Date().getFullYear()} Sean Scales. All rights reserved.</span>
        </div>
        <div class="about__credit-row">
          <span class="about__credit-label">Licensing enquiries</span>
          <span class="about__credit-value"><a href="mailto:admin@seanscales.com.au" class="about__link">admin@seanscales.com.au</a></span>
        </div>
      </div>

      <details class="about__license">
        <summary class="about__license-summary">Proprietary Software Licence</summary>
        <div class="about__license-body">
          <p><strong>QStore IMS — Proprietary Software Licence</strong></p>
          <p>Copyright &copy; ${new Date().getFullYear()} Sean Scales (&ldquo;the Author&rdquo;). All rights reserved.</p>

          <p><strong>OWNERSHIP</strong><br>
          This software, QStore IMS (the &ldquo;Software&rdquo;), including all associated source code, compiled
          outputs, documentation, and assets, is the exclusive intellectual property of the Author.
          All rights not expressly granted herein are reserved by the Author.</p>

          <p><strong>PERMITTED USE</strong><br>
          Authorised end users may use the Software solely for its intended purpose of inventory
          management operations. This permission is granted at the Author&rsquo;s sole discretion and
          may be withdrawn at any time.</p>

          <p><strong>RESTRICTIONS</strong><br>
          Without the express prior written consent of the Author, you may <strong>not</strong>:</p>
          <ol class="about__license-list">
            <li>Distribute, sublicense, sell, lease, rent, lend, or otherwise transfer the Software
                or any copy thereof to any third party;</li>
            <li>Modify, adapt, translate, reverse-engineer, decompile, disassemble, or create
                derivative works based on the Software;</li>
            <li>Remove, alter, or obscure any copyright, trademark, or proprietary notices
                contained in or accompanying the Software;</li>
            <li>Use the Software, in whole or in part, for any commercial purpose or incorporate
                it into any commercial product or service without a separate written licence
                agreement with the Author;</li>
            <li>Publicly display, publicly perform, or otherwise make the Software available to
                any person not expressly authorised by the Author.</li>
          </ol>

          <p><strong>INTELLECTUAL PROPERTY</strong><br>
          The Software incorporates AI-assisted development tooling provided by Anthropic
          (Claude Sonnet 4.6). All output generated through such tooling in the creation of this
          Software is attributed to and owned by the Author in accordance with Anthropic&rsquo;s
          terms of service.</p>

          <p><strong>DISCLAIMER OF WARRANTIES</strong><br>
          THE SOFTWARE IS PROVIDED &ldquo;AS IS&rdquo;, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
          INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
          PARTICULAR PURPOSE, AND NON-INFRINGEMENT. THE AUTHOR DOES NOT WARRANT THAT THE
          SOFTWARE WILL BE ERROR-FREE OR UNINTERRUPTED.</p>

          <p><strong>LIMITATION OF LIABILITY</strong><br>
          TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE AUTHOR SHALL NOT BE LIABLE
          FOR ANY INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
          (INCLUDING LOSS OF DATA, LOSS OF PROFITS, OR BUSINESS INTERRUPTION) ARISING OUT OF
          OR IN CONNECTION WITH THE USE OR INABILITY TO USE THE SOFTWARE.</p>

          <p><strong>GOVERNING LAW</strong><br>
          This licence is governed by the laws of Queensland, Australia. Any dispute arising
          under or in connection with this licence shall be subject to the exclusive jurisdiction
          of the courts of Queensland, Australia.</p>

          <p><strong>LICENSING ENQUIRIES</strong><br>
          To enquire about commercial licensing, distribution rights, or any permissions beyond
          the scope of this licence, contact the Author at
          <a href="mailto:admin@seanscales.com.au" class="about__link">admin@seanscales.com.au</a>.</p>
        </div>
      </details>
    </section>
  `;
}
