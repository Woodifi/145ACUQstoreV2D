// =============================================================================
// QStore IMS v2 — Sync orchestrator
// =============================================================================
// Decides when to push to cloud and surfaces status. Talks to whatever
// CloudProvider is active via cloud.js. Does NOT decide when to pull —
// downloads are always explicit user actions because they overwrite local
// data.
//
// EVENTS
//   notifyChanged()        Call after any local mutation that should be
//                          synced. Schedules a debounced write.
//   syncNow()              Manual sync — flushes any pending write
//                          immediately. Returns a promise that resolves
//                          when the cloud write completes.
//   loadFromCloud()        Explicit user-initiated download. Replaces local
//                          data with whatever is in the cloud. Throws if
//                          nothing is in the cloud.
//   addStatusListener(fn)  Subscribe to status changes. fn receives the
//                          full status object; called immediately with the
//                          current status.
//   removeStatusListener(fn)
//
// AUTO-SYNC SETTING
//   cloud.autoSync (boolean, default true). When false, notifyChanged is
//   a no-op — only manual syncs run. Useful for QMs who prefer to push at
//   end-of-session rather than continuously.
//
// DEBOUNCE
//   5 seconds. Tuned for "added an item, edited 3 fields, added a photo"
//   to coalesce into one push. Configurable via SYNC_DEBOUNCE_MS if needed.
//
// FAILURE MODES
//   Push fails with auth error → status goes to 'error', user sees the
//     error message in the sync indicator. They can re-sign-in via
//     Settings or click the indicator.
//   Push fails with network error → retries on next notifyChanged or
//     manual sync. We don't currently retry on a timer — that would need
//     an exponential backoff to avoid hammering the API.
//   Concurrent writes from multiple devices → last-write-wins. The cloud
//     blob has a `cloud.lastModifiedBy` field showing who pushed last so
//     a QM can see if their work was overwritten.
// =============================================================================

import * as Storage from './storage.js';
import { getProvider, handlePopupAuth } from './cloud.js';
import { sealEnvelope, openWithBlobKey, isEnvelope } from './backup-crypto.js';
import * as Keyring from './sync-keyring.js';

// Re-export so shell.js can call Sync.handlePopupAuth() without importing cloud.js directly.
export { handlePopupAuth };

const SYNC_DEBOUNCE_MS = 5000;

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------

let _debounceTimer = null;
let _pendingPromise = null;
const _listeners = new Set();
let _lastError = null;
let _busy = false;

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Initialise the sync subsystem. Reads cloud settings, initialises the
 * provider, and processes any pending redirect. Safe to call once at boot
 * after Storage.init.
 */
export async function init() {
  // V2L sandbox — cloud sync is disabled to prevent interaction with real units.
  if (typeof __V2L_SANDBOX__ !== 'undefined' && __V2L_SANDBOX__) { _emitStatus(); return; }
  _lastError = null;
  await getProvider().init();
  _emitStatus();
}

/**
 * Notify the sync engine that local data has changed and should eventually
 * be pushed. If auto-sync is enabled and the user is signed in, this
 * schedules a debounced upload. No-op otherwise.
 *
 * Call from any handler that mutates IDB. The notification is fire-and-forget
 * — the actual upload happens later, asynchronously.
 */
export async function notifyChanged() {
  if (typeof __V2L_SANDBOX__ !== 'undefined' && __V2L_SANDBOX__) return;
  if (!await _shouldAutoSync()) return;
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(() => {
    _debounceTimer = null;
    _push().catch((err) => {
      console.warn('Auto-sync failed:', err);
    });
  }, SYNC_DEBOUNCE_MS);
  _emitStatus();
}

/**
 * Force an immediate push to cloud. Cancels any pending debounce and waits
 * for the upload to complete. Throws if not signed in or if the upload
 * fails. UI uses this for the "Sync now" button.
 */
export async function syncNow() {
  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }
  return _push();
}

/**
 * Pull from cloud and replace local data. This is destructive — local
 * changes since the last download are lost unless they were synced first.
 *
 * Returns:
 *   { ok: true, imported: true }   — data was downloaded and applied
 *   { ok: true, imported: false }  — cloud file doesn't exist yet
 *   { ok: false, error }           — auth or network failure
 *
 * Callers (the settings page) MUST prompt the user before invoking this.
 */
export async function loadFromCloud({ secret } = {}) {
  const provider = getProvider();
  if (!provider.isSignedIn()) {
    return { ok: false, error: new Error('Not signed in to OneDrive.') };
  }
  _busy = true;
  _lastError = null;
  _emitStatus();
  try {
    const raw = await provider.read();
    if (!raw) {
      return { ok: true, imported: false };
    }

    let snapshot;
    let legacy = false;

    if (isEnvelope(raw)) {
      const blobKey = Keyring.getBlobKey();
      if (blobKey) {
        snapshot = await openWithBlobKey(raw, blobKey);
      } else if (secret) {
        // Second device, or this one after a keyring clear: recover the blob
        // key from whichever slot the supplied secret opens, then cache it.
        ({ payload: snapshot } = await Keyring.unlockFrom(raw, secret));
      } else {
        return {
          ok: false,
          needsSecret: true,
          error: new Error('This cloud backup is encrypted. Enter the sync passphrase or a recovery code.'),
        };
      }
    } else {
      // Unsealed blob written by a pre-fix build. Accept it so units can
      // recover their data, but mark it: this file carried piiKey and auditKey
      // in the clear, so both keys must be treated as compromised and rotated,
      // and the file purged from OneDrive including its version history.
      legacy = true;
      snapshot = raw;
    }

    // Validate the snapshot before importing — we don't want to wipe local
    // data and discover the snapshot is malformed.
    if (typeof snapshot !== 'object' || !snapshot.schemaVersion) {
      throw new Error('Cloud blob is not a valid QStore snapshot.');
    }
    await Storage.importAll(snapshot);
    // Mirror logo to localStorage so splash shows it on the caller's reload.
    try {
      const ls = await Storage.settings.getAll();
      if (ls.unitLogo) localStorage.setItem('qstore2_logo', ls.unitLogo);
      else localStorage.removeItem('qstore2_logo');
    } catch (_) {}
    await Storage.audit.append({
      action: 'data_imported',
      user:   'cloud-sync',
      desc:   `Loaded ${legacy ? 'UNENCRYPTED (pre-fix) ' : 'encrypted '}snapshot from cloud `
            + `(${snapshot.exportedAt || 'unknown date'}).`
            + (legacy ? ' Keys in this blob are compromised — rotate and purge the cloud file.' : ''),
    });
    return { ok: true, imported: true, legacy };
  } catch (err) {
    _lastError = err.message || String(err);
    return { ok: false, error: err };
  } finally {
    _busy = false;
    _emitStatus();
  }
}

/**
 * Subscribe to status changes. The listener is called immediately with the
 * current status, and again after every status transition.
 */
export function addStatusListener(fn) {
  _listeners.add(fn);
  // Fire immediately with current state — async to avoid surprising callers
  // that wire the listener inside a render and don't expect synchronous
  // re-entry.
  Promise.resolve().then(() => {
    if (_listeners.has(fn)) {
      try { fn(getStatus()); } catch (e) { console.error('sync listener error:', e); }
    }
  });
}

export function removeStatusListener(fn) {
  _listeners.delete(fn);
}

/**
 * Get the current sync status — combines provider state with our own
 * pending/busy flags.
 */
export function getStatus() {
  const provider = getProvider();
  const info = provider.getStatusInfo();
  return {
    ...info,
    busy:        _busy || info.state === 'busy',
    pending:     Boolean(_debounceTimer),
    lastError:   _lastError || info.lastError,
  };
}

// -----------------------------------------------------------------------------
// Internal
// -----------------------------------------------------------------------------

async function _shouldAutoSync() {
  const settings = await Storage.settings.getAll();
  // The 'cloud.disabled' kill-switch trumps everything. When the user has
  // explicitly disabled cloud sync (e.g. for defence-environment policy
  // reasons), notifyChanged becomes a no-op even if there's a stale
  // signed-in MSAL session lurking. The settings UI also signs out on
  // toggle-on, so this should be belt-and-braces, but the check is cheap.
  if (settings['cloud.disabled'] === true) return false;

  const provider = getProvider();
  if (!provider.isSignedIn()) return false;
  return settings['cloud.autoSync'] !== false;  // default true
}

async function _push() {
  if (_pendingPromise) return _pendingPromise;
  _pendingPromise = (async () => {
    _busy = true;
    _lastError = null;
    _emitStatus();
    try {
      const provider = getProvider();
      if (!provider.isSignedIn()) {
        throw new Error('Not signed in to OneDrive.');
      }
      // The snapshot contains META, and META contains piiKey and auditKey.
      // It must never reach the provider unsealed — see backup-crypto.js.
      const blobKey = Keyring.getBlobKey();
      if (!blobKey) {
        throw new Error(
          'Cloud sync encryption is not set up. Configure a sync passphrase in '
          + 'Settings before syncing.',
        );
      }
      const snapshot = await Storage.exportAll();
      // Annotate the snapshot with sync metadata so we can show it in the
      // settings UI of any device that downloads.
      snapshot.cloudSync = {
        pushedAt: new Date().toISOString(),
        pushedBy: provider.getAccount()?.username || 'unknown',
      };
      await provider.write(await sealEnvelope(snapshot, blobKey, Keyring.getSlots()));
    } catch (err) {
      _lastError = err.message || String(err);
      throw err;
    } finally {
      _busy = false;
      _pendingPromise = null;
      _emitStatus();
    }
  })();
  return _pendingPromise;
}

function _emitStatus() {
  const status = getStatus();
  for (const fn of _listeners) {
    try { fn(status); } catch (e) { console.error('sync listener error:', e); }
  }
}
