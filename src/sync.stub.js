// Sync stub — substituted for src/sync.js in the Defence/cadet build.
//
// build.js --defence resolves every import of './sync.js' to this module, so
// the real sync engine and the whole OneDrive/MSAL dependency chain are never
// bundled. This is deliberately a BUILD-TIME substitution rather than a runtime
// flag: a flag can be flipped, misconfigured, or bypassed by a stale signed-in
// session, and it leaves the cloud code sitting in the artefact where a
// reviewer can see it. Compiling it out means the claim "this build cannot
// write cadet data to third-party cloud storage" is a property of the binary,
// verifiable by inspecting it — see test-defence-build.mjs, which greps the
// built bundle for graph.microsoft.com, MSAL, and the blob filename.
//
// Rationale: Defence Youth Manual Pt 2 S4 Ch4 para 4.4.5(c) requires ADF Cadets
// ICT systems to be hosted in Defence-approved data centres or ASD-approved
// cloud. A consumer M365 tenant is neither. The Defence build therefore has no
// cloud egress path at all.
//
// Every export of sync.js is mirrored here as a no-op. Eight UI modules call
// Sync.notifyChanged() on every mutation, so the surface has to match exactly
// or the app dies on first write.

const DISABLED_STATUS = Object.freeze({
  state:     'disabled',
  busy:      false,
  pending:   false,
  lastError: null,
  lastSync:  null,
  disabled:  true,
});

/** No cloud provider exists in this build; nothing to initialise. */
export async function init() {}

/** Fired after every local mutation. Intentionally does nothing here. */
export async function notifyChanged() {}

export async function syncNow() {
  throw new Error('Cloud sync is not available in this build.');
}

export async function loadFromCloud() {
  return { ok: false, error: new Error('Cloud sync is not available in this build.') };
}

/**
 * Listeners are still called once with the disabled status so the shell's sync
 * indicator resolves to a stable state instead of hanging on 'unknown'.
 */
export function addStatusListener(fn) {
  try { fn(DISABLED_STATUS); } catch (_) {}
}

export function removeStatusListener() {}

export function getStatus() {
  return { ...DISABLED_STATUS };
}

/** Only reachable via an MSAL redirect, which cannot occur in this build. */
export async function handlePopupAuth() {}
