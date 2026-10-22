// =============================================================================
// Edition wall — which edition this build is, and its browser-storage names
// =============================================================================
// Every edition opened from disk shares ONE browser storage area: file:// is a
// single origin in Chromium and Firefox (measured 2026-10-23 with two files in
// different folders — each saw the other's localStorage and IndexedDB). So the
// only wall between editions is that each touches nothing but its own names.
//
//   - The cadet edition keeps the names it has always used (`qstore`, `qstore_*`,
//     `qstore2_*`). Units in the field depend on them; they never change.
//   - A V2L learning (sandbox) build is another edition built from this code.
//     Every name it uses passes through storageKey(), so it can never write the
//     cadet's session, lockouts, licence, device identity, sync keyring or logo —
//     even when built without the __V2L_* overrides.
//   - Itemora uses `itemora` and `itemora_*`, and refuses the cadet's names.
// =============================================================================

export const SANDBOX = (typeof __V2L_SANDBOX__ !== 'undefined') && !!__V2L_SANDBOX__;

/** This build's edition, as written into its cloud snapshots. */
export const EDITION = SANDBOX ? 'cadet-learning' : 'cadet';

const SANDBOX_PREFIX = 'qstore_v2l__';

/** A browser-storage name for this build: unchanged for the cadet edition. */
export function storageKey(name) {
  return SANDBOX ? SANDBOX_PREFIX + name : name;
}
