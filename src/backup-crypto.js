// Envelope encryption for snapshots that leave the device (cloud sync blob,
// and — once wired — encrypted .qstore file exports).
//
// WHY THIS EXISTS
// ---------------
// Storage.exportAll() dumps the META store verbatim, and META holds `piiKey`
// (the AES-256-GCM key protecting cadet PII) and `auditKey` (the HMAC key the
// audit chain is built on). Any snapshot therefore carries the keys that
// decrypt its own contents. Written to OneDrive as plain JSON, the blob was
// self-decrypting: ciphertext and key in the same file.
//
// The importAll() docstring justifies exporting META so the audit chain stays
// verifiable across devices. That reasoning predates PII encryption and only
// ever mentions auditKey and installId — piiKey inherited the export path
// silently. Rather than break the documented audit-chain behaviour, we keep the
// snapshot intact and make the *container* opaque.
//
// FORMAT (v2)
// -----------
//   { qstoreEnvelope: true, v: 2, iv, data, slots: [ slot, ... ] }
//
// A random 256-bit blob key (BK) encrypts the payload. BK is then wrapped
// independently into each keyslot, LUKS-style: any one slot's secret recovers
// BK, and no slot reveals another. Slots are established once at setup; each
// push re-encrypts the payload under the same BK with a fresh IV, so the
// recovery code is needed only at setup and is never persisted.
//
// Slot secrets are stretched with PBKDF2-SHA256 at 310,000 iterations — the
// same parameters already used by the .qstore export encryption in settings.js.
// NOTE: PBKDF2 is not an ASD-Approved Cryptographic Algorithm (the ISM's AACA
// list covers AES, SHA-2, and the asymmetric set only; it does not address key
// derivation). The 310k iteration count follows OWASP guidance, not ASD's —
// do not attribute it to the ISM. AES-256 itself is ASD-approved and preferred
// (ISM-1769).

const PBKDF2_ITERATIONS = 310_000;
const SALT_BYTES = 32;
const IV_BYTES   = 12;   // 96-bit IV, the AES-GCM standard size
const KEY_BYTES  = 32;   // 256-bit blob key

export const SLOT_PASSPHRASE = 'passphrase';
export const SLOT_RECOVERY   = 'recovery';

// ---------------------------------------------------------------------------
// base64 helpers
// ---------------------------------------------------------------------------

/**
 * Spreading a large Uint8Array into String.fromCharCode blows the call stack
 * on real backups — chunk it. Same bug, same fix, as settings.js _b64().
 */
export function b64(buf) {
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let s = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

export function fromB64(s) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

// ---------------------------------------------------------------------------
// key derivation and wrapping
// ---------------------------------------------------------------------------

async function _deriveKek(secret, salt, usages) {
  const baseKey = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    usages,
  );
}

/** Fresh random blob key. Returned raw so it can be wrapped and cached. */
export function newBlobKey() {
  return crypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

/**
 * Wrap `blobKey` under a secret, producing one keyslot. Each slot gets its own
 * salt and IV so slots are cryptographically independent.
 */
export async function wrapKey(blobKey, secret, type) {
  if (!secret || typeof secret !== 'string') {
    throw new Error('A secret is required to wrap the blob key.');
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv   = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const kek  = await _deriveKek(secret, salt, ['encrypt']);
  const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, blobKey);
  return {
    type,
    kdf: 'PBKDF2-SHA256',
    iterations: PBKDF2_ITERATIONS,
    salt: b64(salt),
    iv: b64(iv),
    wrapped: b64(wrapped),
  };
}

/**
 * Try to recover the blob key from a single slot. Returns null when the secret
 * doesn't match this slot — callers walk every slot, so a mismatch is an
 * expected outcome, not an error.
 */
export async function unwrapKey(slot, secret) {
  if (!slot || slot.kdf !== 'PBKDF2-SHA256') return null;
  try {
    const kek = await _deriveKek(secret, fromB64(slot.salt), ['decrypt']);
    const raw = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(slot.iv) }, kek, fromB64(slot.wrapped),
    );
    return new Uint8Array(raw);
  } catch {
    return null;   // wrong secret for this slot
  }
}

// ---------------------------------------------------------------------------
// envelope
// ---------------------------------------------------------------------------

export function isEnvelope(obj) {
  return !!obj && obj.qstoreEnvelope === true && obj.v === 2;
}

/**
 * Seal `payload` under `blobKey` and attach the (already-built) keyslots.
 * A fresh IV per call — never reuse an IV under a fixed key.
 */
export async function sealEnvelope(payload, blobKey, slots) {
  if (!Array.isArray(slots) || slots.length === 0) {
    throw new Error('An envelope needs at least one keyslot.');
  }
  const iv  = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await crypto.subtle.importKey('raw', blobKey, { name: 'AES-GCM' }, false, ['encrypt']);
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(payload)),
  );
  return { qstoreEnvelope: true, v: 2, iv: b64(iv), data: b64(data), slots };
}

/** Decrypt a sealed payload with a blob key already in hand (the local case). */
export async function openWithBlobKey(envelope, blobKey) {
  if (!isEnvelope(envelope)) throw new Error('Not a QStore encrypted envelope.');
  const key = await crypto.subtle.importKey('raw', blobKey, { name: 'AES-GCM' }, false, ['decrypt']);
  let plain;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(envelope.iv) }, key, fromB64(envelope.data),
    );
  } catch {
    throw new Error('Envelope could not be decrypted — wrong key or corrupted data.');
  }
  return JSON.parse(new TextDecoder().decode(plain));
}

/**
 * Open an envelope with a passphrase or a recovery code — whichever the caller
 * has. Every slot is tried, so the same entry point serves both. Returns the
 * payload and the blob key, letting the caller cache BK for later pushes.
 */
export async function openEnvelope(envelope, secret) {
  if (!isEnvelope(envelope)) throw new Error('Not a QStore encrypted envelope.');
  for (const slot of envelope.slots || []) {
    const blobKey = await unwrapKey(slot, secret);
    if (blobKey) {
      return { payload: await openWithBlobKey(envelope, blobKey), blobKey, slotType: slot.type };
    }
  }
  throw new Error('Incorrect passphrase or recovery code.');
}
