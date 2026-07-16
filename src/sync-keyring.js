// Device-local keyring for cloud sync encryption.
//
// CRITICAL — WHERE THIS LIVES AND WHY
// -----------------------------------
// The keyring is held in localStorage, NOT in IndexedDB.
//
// Storage.exportAll() dumps IDB stores verbatim, including META and SETTINGS.
// That is precisely how `piiKey` ended up inside the OneDrive blob it was
// meant to protect. Anything we put in IDB gets exported. So the key that
// encrypts the export must never live there — putting the sync key in
// IDB settings would rebuild the original defect with extra steps.
//
// localStorage is device-local and is never touched by exportAll(). The one
// exception in the codebase is `qstore2_logo`, which sync.js mirrors OUT of
// IDB for the splash screen — data flows IDB → localStorage there, never back.
//
// THREAT MODEL
// ------------
// The blob key (BK) is cached here in the clear. That is deliberate and costs
// nothing: `piiKey` already sits in IDB in the clear on the same device, so an
// attacker with local profile access has already won. QStore's documented
// model excludes runtime access to the running device (see TECHNICAL.md). What
// the envelope defends is the blob *after it leaves* — in a consumer OneDrive
// tenant, in its version history, in anything that syncs it onward.
//
// KEYSLOTS
// --------
// BK is generated once at setup and wrapped into two independent slots:
// a passphrase (day-to-day) and a printed recovery code (break-glass). Wrapping
// happens once, so the recovery code is needed only at setup and is never
// persisted — we hold the plaintext just long enough to wrap BK and show it.
// Subsequent pushes reuse BK with a fresh IV per seal.

import { newBlobKey, wrapKey, openEnvelope, b64, fromB64, SLOT_PASSPHRASE, SLOT_RECOVERY } from './backup-crypto.js';
import * as Recovery from './recovery.js';

const LS_KEY = 'qstore2_sync_keyring';

/**
 * localStorage is absent in the headless test environment and in some
 * hardened browser modes. Six existing suites already die on a bare
 * `localStorage` reference (ReferenceError, not a catchable miss), so resolve
 * it defensively rather than assuming the global exists.
 */
function _ls() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch { return null; }
}

function _read() {
  const ls = _ls();
  if (!ls) return null;
  try {
    const raw = ls.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function _write(ring) {
  const ls = _ls();
  if (!ls) {
    throw new Error('Cannot store the sync keyring: browser storage is unavailable.');
  }
  ls.setItem(LS_KEY, JSON.stringify(ring));
}

/** True when this device can seal a push without prompting for anything. */
export function isConfigured() {
  const ring = _read();
  return !!(ring && ring.blobKey && Array.isArray(ring.slots) && ring.slots.length);
}

export function getBlobKey() {
  const ring = _read();
  return ring?.blobKey ? fromB64(ring.blobKey) : null;
}

export function getSlots() {
  return _read()?.slots || [];
}

/**
 * First-time setup on the unit's primary device. Generates BK, wraps it under
 * the passphrase and under a freshly generated recovery code, and persists the
 * keyring.
 *
 * Returns the formatted recovery code — shown ONCE and printed. It is not
 * stored anywhere: we keep an argon2id hash only so the UI can later confirm a
 * code the user types is the right one. The hash cannot derive a key, which is
 * why the wrap has to happen here, while we still hold the plaintext.
 */
export async function setup(passphrase) {
  if (!passphrase || passphrase.length < 12) {
    throw new Error('Sync passphrase must be at least 12 characters.');
  }
  const bk = newBlobKey();
  const code = Recovery.generate();
  const slots = [
    await wrapKey(bk, passphrase, SLOT_PASSPHRASE),
    await wrapKey(bk, code.canonical, SLOT_RECOVERY),
  ];
  _write({
    v: 1,
    blobKey: b64(bk),
    slots,
    recoveryHash: await Recovery.hash(code.canonical),
    configuredAt: new Date().toISOString(),
  });
  return { recoveryCodeFormatted: code.formatted };
}

/**
 * Adopt an existing envelope's keyring on a second device, given the
 * passphrase or the recovery code. Recovers BK via whichever slot matches and
 * caches it locally, so later pushes need no prompt.
 */
export async function unlockFrom(envelope, secret) {
  const { payload, blobKey, slotType } = await openEnvelope(envelope, secret);
  _write({
    v: 1,
    blobKey: b64(blobKey),
    slots: envelope.slots,
    adoptedAt: new Date().toISOString(),
    adoptedVia: slotType,
  });
  return { payload, slotType };
}

/**
 * Drop the local keyring. Used on sign-out and when rotating. Does NOT touch
 * the cloud blob — a rotation has to re-seal and re-push to take effect.
 */
export function clear() {
  try { localStorage.removeItem(LS_KEY); } catch (_) {}
}
