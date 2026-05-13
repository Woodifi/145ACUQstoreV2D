// =============================================================================
// QStore IMS v2 — Recovery codes (OC PIN reset)
// =============================================================================
// Generates and verifies one-shot recovery codes for OC accounts. The code is
// shown to the user once at PIN-set time; only its argon2id hash is stored.
// On the login screen, an OC who's forgotten their PIN can paste the code
// to set a new one.
//
// FORMAT
//   12 alphanumeric chars in three groups of four, separated by hyphens:
//     XXXX-XXXX-XXXX
//   Drawn from a 32-character alphabet that excludes ambiguous glyphs:
//     - No 0/O, no 1/l/I (visual confusion on print)
//     - No vowels (avoids accidental words, including profanity)
//   Effective entropy: 12 chars * log2(32) = 60 bits. Comfortable margin
//   over the 4-digit PIN (which has ~13 bits) without being onerous to type.
//
// SCOPE
//   OC role only. QM/staff/cadet who forget their PIN can be reset by an OC
//   using existing user-management UI (TBD). The OC role has nobody above it
//   to perform a reset, so the recovery code exists specifically to break
//   that deadlock.
//
// THREAT MODEL
//   The code is a second credential equal in power to the OC's PIN. Storing
//   it on a sticky note next to the laptop defeats the purpose. The on-screen
//   guidance and the print layout (when we add it) emphasise off-device
//   storage — sealed envelope in the unit safe, key cabinet, etc.
//
// ROTATION
//   - Generated once when the OC moves off the default PIN.
//   - Successfully using a code consumes it: the recovery hash is cleared.
//     The OC must regenerate a code (manually) before they have recovery
//     coverage again. This is intentional — using the code means the
//     printed copy was found, and we don't want it remaining valid.
//   - The OC can regenerate a code at any time from settings; the old code
//     is invalidated.
// =============================================================================

import { argon2id, argon2Verify } from 'hash-wasm';
import * as Storage from './storage.js';

// Ambiguity-free alphabet. Uppercase + digits, with the four most
// commonly-confused glyphs removed:
//   0 (zero)        — confused with O
//   1 (one)         — confused with I and lowercase l
//   I (capital i)   — confused with 1 and l
//   O (capital o)   — confused with 0
// Removing exactly four glyphs from base36 (10 digits + 26 letters) leaves
// 32 chars, which makes byte-to-char mapping uniform — taking the low 5
// bits of a random byte gives a uniform distribution with no modulo bias.
const RECOVERY_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
// Length sanity check at module load — if someone edits the alphabet wrong
// we want the error at startup, not at first code generation.
if (RECOVERY_ALPHABET.length !== 32) {
  throw new Error('Recovery alphabet must be exactly 32 chars (got ' +
    RECOVERY_ALPHABET.length + ')');
}

const RECOVERY_LENGTH = 12;        // chars before grouping
const RECOVERY_GROUPS = [4, 4, 4]; // visual grouping; sums must equal RECOVERY_LENGTH

// Sanity check at module load — easier than discovering the mismatch on
// first format() call when a code drops its tail char.
{
  const sum = RECOVERY_GROUPS.reduce((a, b) => a + b, 0);
  if (sum !== RECOVERY_LENGTH) {
    throw new Error(`RECOVERY_GROUPS must sum to RECOVERY_LENGTH (got ${sum} vs ${RECOVERY_LENGTH})`);
  }
}

// We use the same argon2id parameters as PIN hashing — recovery codes are
// higher-entropy than PINs but treating them at parity costs us nothing
// and means one set of params to reason about.
const ARGON_PARAMS = {
  parallelism: 1,
  iterations:  3,
  memorySize:  64 * 1024,
  hashLength:  32,
};

// -----------------------------------------------------------------------------
// Code generation
// -----------------------------------------------------------------------------

/**
 * Generate a fresh 12-character recovery code, formatted with hyphens for
 * readability (XXXX-XXX-XXXX). Uses crypto.getRandomValues for entropy.
 *
 * The two forms — formatted (with hyphens) and canonical (no hyphens, lower
 * case stripped) — are kept distinct everywhere. Formatted is what we show
 * the user; canonical is what we hash and what we accept on input (after
 * normalising user input through normalize()).
 */
export function generate() {
  const raw = new Uint8Array(RECOVERY_LENGTH);
  crypto.getRandomValues(raw);
  let canonical = '';
  for (let i = 0; i < RECOVERY_LENGTH; i++) {
    // & 31 picks the low 5 bits — no modulo bias since alphabet is exactly
    // 2^5 long. We deliberately discard the upper 3 bits per byte.
    canonical += RECOVERY_ALPHABET[raw[i] & 31];
  }
  return {
    canonical,                 // hashed, stored, never displayed
    formatted: format(canonical), // displayed, printed, never stored
  };
}

/** Insert hyphens between the configured groups: 'ABCDEFGHIJKL' → 'ABCD-EFG-HIJKL'. */
export function format(canonical) {
  if (typeof canonical !== 'string' || canonical.length !== RECOVERY_LENGTH) {
    throw new Error('format() expects ' + RECOVERY_LENGTH + ' canonical chars');
  }
  const parts = [];
  let cursor = 0;
  for (const groupLen of RECOVERY_GROUPS) {
    parts.push(canonical.slice(cursor, cursor + groupLen));
    cursor += groupLen;
  }
  return parts.join('-');
}

/**
 * Strip whitespace and hyphens from user input, then uppercase. The
 * alphabet is uppercase-only, so accepting lowercase here is just a
 * convenience for users typing the code on mobile or in mixed-case fields.
 */
export function normalize(input) {
  return String(input || '').replace(/[\s-]/g, '').toUpperCase();
}

/**
 * Validate that a normalised string consists only of allowed alphabet chars
 * and has the right length. Returns true/false; doesn't throw.
 */
export function isWellFormed(canonical) {
  if (typeof canonical !== 'string') return false;
  if (canonical.length !== RECOVERY_LENGTH) return false;
  for (const ch of canonical) {
    if (RECOVERY_ALPHABET.indexOf(ch) === -1) return false;
  }
  return true;
}

// -----------------------------------------------------------------------------
// Hashing & verification
// -----------------------------------------------------------------------------

/**
 * Hash a canonical (no hyphens) recovery code with argon2id. Output is the
 * encoded "$argon2id$..." form, same as PIN hashes. Stored in the user
 * record's recoveryHash field.
 */
export async function hash(canonical) {
  if (!isWellFormed(canonical)) {
    throw new Error('Recovery code is not well-formed.');
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return argon2id({
    password: canonical,
    salt,
    ...ARGON_PARAMS,
    outputType: 'encoded',
  });
}

/**
 * Verify a (possibly-formatted) input against a stored hash. Returns false
 * for malformed input or hash mismatch — never throws on bad input.
 */
export async function verify(input, encodedHash) {
  if (typeof encodedHash !== 'string' || !encodedHash.startsWith('$argon2id$')) {
    return false;
  }
  const canonical = normalize(input);
  if (!isWellFormed(canonical)) return false;
  try {
    return await argon2Verify({ password: canonical, hash: encodedHash });
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// User record helpers
// -----------------------------------------------------------------------------

/**
 * Generate a new code, hash it, and write the hash to the user record.
 * Returns the formatted plaintext code for one-time display to the user.
 *
 * Caller is responsible for:
 *   - Authorising the operation (must be the OC themselves, or another OC).
 *   - Showing the formatted code to the user with appropriate guidance.
 *   - Auditing the operation. We don't audit here because the calling
 *     context determines the audit message ('initial generation', 'manual
 *     rotation', 'post-recovery rotation' all warrant different desc text).
 */
export async function generateForUser(userId) {
  const user = await Storage.users.get(userId);
  if (!user) throw new Error('User not found: ' + userId);
  if (user.role !== 'co') {
    throw new Error('Recovery codes are OC-only.');
  }
  const { canonical, formatted } = generate();
  user.recoveryHash          = await hash(canonical);
  user.recoveryHashAlgorithm = 'argon2id';
  user.recoveryCreatedAt     = new Date().toISOString();
  await Storage.users.put(user);
  return formatted;
}

/**
 * Verify a code against a user's stored recovery hash. Returns true/false.
 * Does NOT consume the code (caller does that after also validating the
 * new PIN, to avoid invalidating the recovery before a successful reset).
 */
export async function verifyForUser(userId, codeInput) {
  const user = await Storage.users.get(userId);
  if (!user) return false;
  if (user.role !== 'co') return false;
  if (!user.recoveryHash) return false;
  return verify(codeInput, user.recoveryHash);
}

/**
 * Clear the recovery hash from a user record. Called after a successful
 * recovery — the code is one-shot; using it requires the user to generate
 * a fresh one before they're covered again.
 */
export async function consumeForUser(userId) {
  const user = await Storage.users.get(userId);
  if (!user) return;
  delete user.recoveryHash;
  delete user.recoveryHashAlgorithm;
  delete user.recoveryCreatedAt;
  await Storage.users.put(user);
}

/**
 * Return whether a user currently has a recovery code set, plus the
 * timestamp it was created. Used by settings UI to show status without
 * leaking the hash itself.
 */
export async function statusForUser(userId) {
  const user = await Storage.users.get(userId);
  if (!user) return { exists: false, createdAt: null };
  return {
    exists:    !!user.recoveryHash,
    createdAt: user.recoveryCreatedAt || null,
  };
}
