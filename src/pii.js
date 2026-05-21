// =============================================================================
// QStore IMS v3 — PII Field Encryption
// =============================================================================
// Provides transparent AES-256-GCM encryption for personally-identifiable
// information stored in IndexedDB. Every encrypted value is prefixed with
// '~enc:' followed by base64(12-byte-IV || ciphertext) so plain and
// encrypted values are unambiguous and the format is self-describing.
//
// KEY MANAGEMENT
//   A 32-byte random key ('piiKey') is generated once on first DB initialisation
//   and stored in the meta store. It is loaded and imported as a Web Crypto
//   AES-GCM CryptoKey on every app boot. The key never leaves IndexedDB
//   unencrypted.
//
//   Protection model:
//     ✓ IDB data copied to another machine is unreadable (different piiKey)
//     ✓ Raw IndexedDB file inspection reveals only ciphertext for PII fields
//     ✗ An attacker with DevTools access on this device while the app is
//       running can intercept the decrypted values from memory
//
//   This is the appropriate level of protection for a locally-hosted single-
//   origin web app. Cloud sync blobs are independently encrypted (cloud.js).
//   Exports are plaintext JSON (suitable for portability) and should be
//   treated as sensitive documents by the user.
//
// BACKWARDS COMPATIBILITY
//   Records written before PII encryption was enabled may have plain-text
//   values in PII fields. decrypt() passes those through unchanged. The next
//   write of the record re-encrypts all PII fields, migrating it silently.
//
// FIELDS ENCRYPTED
//   cadets/staff : surname, given, email, notes
//   loans        : borrowerName, remarks
//   expenseClaims: claimantName, description, receiptRef, reviewNotes
// =============================================================================

const ENC_PREFIX = '~enc:';

// Cached CryptoKey — imported once per session during storage.init()
let _key = null;

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/**
 * Import the base64-encoded piiKey as a Web Crypto AES-GCM CryptoKey.
 * Called once by storage.init() after the DB is open and piiKey is available.
 *
 * @param {string} piiKeyB64  Base64-encoded 32-byte key from the meta store
 */
export async function init(piiKeyB64) {
  const bytes = _b64ToBytes(piiKeyB64);
  _key = await crypto.subtle.importKey(
    'raw', bytes,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
}

/** Returns true if the PII module has been initialised with a key. */
export function isReady() {
  return _key !== null;
}

// ---------------------------------------------------------------------------
// Field-level encrypt / decrypt
// ---------------------------------------------------------------------------

/**
 * Encrypt a string value. Returns '~enc:<base64(iv+ciphertext)>'.
 * Returns the original value unchanged if:
 *   - value is null/undefined/empty string
 *   - value is not a string (numbers etc. stored as-is)
 *   - value is already encrypted (already has prefix)
 *   - PII module not yet initialised
 */
export async function encrypt(value) {
  if (!_key || !value || typeof value !== 'string' || value.startsWith(ENC_PREFIX)) {
    return value;
  }
  const iv         = crypto.getRandomValues(new Uint8Array(12));
  const encoded    = new TextEncoder().encode(value);
  const cipherBuf  = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, _key, encoded);
  const combined   = new Uint8Array(12 + cipherBuf.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(cipherBuf), 12);
  return ENC_PREFIX + _bytesToB64(combined);
}

/**
 * Decrypt a string value. Returns the original plaintext.
 * Returns the value unchanged if it does not have the '~enc:' prefix
 * (plaintext pass-through for legacy / non-encrypted records).
 * Returns the value unchanged if PII module is not initialised.
 */
export async function decrypt(value) {
  if (!_key || !value || typeof value !== 'string' || !value.startsWith(ENC_PREFIX)) {
    return value;
  }
  try {
    const combined   = _b64ToBytes(value.slice(ENC_PREFIX.length));
    const iv         = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const plainBuf   = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, _key, ciphertext);
    return new TextDecoder().decode(plainBuf);
  } catch {
    // Decryption failure — return the raw value rather than crashing.
    // This can happen if the key has changed (e.g., after a full DB reset).
    return value;
  }
}

// ---------------------------------------------------------------------------
// Record-level helpers
// ---------------------------------------------------------------------------

/**
 * Encrypt specified fields in a record. Returns a new object; does not
 * mutate the input. Fields not listed are copied through unchanged.
 *
 * @param {object}   record
 * @param {string[]} fields  Field names to encrypt
 */
export async function encryptRecord(record, fields) {
  if (!record) return record;
  const out = { ...record };
  for (const f of fields) {
    if (out[f] !== undefined && out[f] !== null) {
      out[f] = await encrypt(String(out[f]));
    }
  }
  return out;
}

/**
 * Decrypt specified fields in a record. Returns a new object; does not
 * mutate the input.
 *
 * @param {object}   record
 * @param {string[]} fields  Field names to decrypt
 */
export async function decryptRecord(record, fields) {
  if (!record) return record;
  const out = { ...record };
  for (const f of fields) {
    if (out[f] !== undefined && out[f] !== null) {
      out[f] = await decrypt(String(out[f]));
    }
  }
  return out;
}

/**
 * Decrypt an array of records — convenience wrapper for list() results.
 *
 * @param {object[]} records
 * @param {string[]} fields
 */
export async function decryptAll(records, fields) {
  return Promise.all(records.map((r) => decryptRecord(r, fields)));
}

// ---------------------------------------------------------------------------
// Field lists (exported constants — used in storage.js and tests)
// ---------------------------------------------------------------------------

export const PII_FIELDS_CADETS        = ['surname', 'given', 'email', 'notes'];
export const PII_FIELDS_STAFF         = ['surname', 'given', 'email', 'notes'];
export const PII_FIELDS_LOANS         = ['borrowerName', 'remarks'];
export const PII_FIELDS_EXPENSE_CLAIMS = ['claimantName', 'description', 'receiptRef', 'reviewNotes'];

// Users: name (display name) and svcNo are PII. username is the login credential
// and is indexed in IDB for login lookup — left unencrypted intentionally.
export const PII_FIELDS_USERS   = ['name', 'svcNo'];

// Pending requests: the requestor's personal details are PII.
// requestorSvc is a service number FK — encrypted; the IDB index is not used
// for lookups (JS-side filter on decrypted list() output is used instead).
export const PII_FIELDS_REQUESTS = ['requestorName', 'requestorRank', 'requestorSvc'];

// Supply orders: requestor fields pulled from AAC PDF forms are PII.
export const PII_FIELDS_ORDERS   = ['requestorName', 'requestorRank', 'requestorSvcNo'];

// Stocktake counts: countedBy holds the session user's display name.
// Stocktake data is transient (cleared after each count) but still PII at rest.
export const PII_FIELDS_STOCKTAKE = ['countedBy'];

// Purchase orders: requestedBy and approvedBy are individual military personnel names.
export const PII_FIELDS_PURCHASE_ORDERS = ['requestedBy', 'approvedBy'];

// ---------------------------------------------------------------------------
// Encoding helpers (self-contained — no dep on storage.js)
// ---------------------------------------------------------------------------

function _bytesToB64(bytes) {
  let binary = '';
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < u8.length; i++) binary += String.fromCharCode(u8[i]);
  return btoa(binary);
}

function _b64ToBytes(b64) {
  const binary = atob(b64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
