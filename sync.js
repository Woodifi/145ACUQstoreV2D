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
import { getProvider } from './cloud.js';

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
export async function loadFromCloud() {
  const provider = getProvider();
  if (!provider.isSignedIn()) {
    return { ok: false, error: new Error('Not signed in to OneDrive.') };
  }
  _busy = true;
  _lastError = null;
  _emitStatus();
  try {
    const snapshot = await provider.read();
    if (!snapshot) {
      return { ok: true, imported: false };
    }
    // Validate the snapshot before importing — we don't want to wipe local
    // data and discover the snapshot is malformed.
    if (typeof snapshot !== 'object' || !snapshot.schemaVersion) {
      throw new Error('Cloud blob is not a valid QStore snapshot.');
    }
    await Storage.importAll(snapshot);
    await Storage.audit.append({
      action: 'data_imported',
      user:   'cloud-sync',
      desc:   `Loaded snapshot from cloud (${snapshot.exportedAt || 'unknown date'}).`,
    });
    return { ok: true, imported: true };
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
  const provider = getProvider();
  if (!provider.isSignedIn()) return false;
  const settings = await Storage.settings.getAll();
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
      const snapshot = await Storage.exportAll();
      // Annotate the snapshot with sync metadata so we can show it in the
      // settings UI of any device that downloads.
      snapshot.cloudSync = {
        pushedAt: new Date().toISOString(),
        pushedBy: provider.getAccount()?.username || 'unknown',
      };
      await provider.write(snapshot);
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
