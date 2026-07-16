// =============================================================================
// QStore IMS — TOTP (RFC 6238) two-factor authentication
// =============================================================================
// Offline-capable time-based one-time passwords. No external libraries.
// Uses Web Crypto (HMAC-SHA1) — available in all modern browsers including
// Chromium from file:// (the V2 deployment target).
//
// Compatible with: Google Authenticator, Microsoft Authenticator, Authy,
//                  1Password, Bitwarden, Duo, and any RFC 6238 app.
//
// SECURITY NOTES
//   - HMAC-SHA1 is mandated by RFC 4226/6238. It is the algorithm all
//     authenticator apps implement. SHA-1 collision resistance is not
//     relevant here — we're using it as a PRF, not for integrity.
//   - 30-second windows are the RFC 6238 default.
//   - We verify ±1 window (±30 s) to tolerate modest clock skew.
//   - Replay guard: the verified step is stored on the user record so the
//     same code cannot be reused within its window.
//   - Backup codes are stored as SHA-256 hashes and consumed on use.
// =============================================================================

// ---------------------------------------------------------------------------
// Base-32 (RFC 4648) — required by the otpauth:// URI standard
// ---------------------------------------------------------------------------

const _B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const _B32_MAP = new Map([..._B32].map((c, i) => [c, i]));

/**
 * Decode a base-32 string to a Uint8Array.
 * Strips whitespace and padding; case-insensitive.
 */
function _b32Decode(s) {
  s = s.toUpperCase().replace(/[\s=]/g, '');
  const out = new Uint8Array(Math.floor(s.length * 5 / 8));
  let buf = 0, bits = 0, idx = 0;
  for (const c of s) {
    const v = _B32_MAP.get(c);
    if (v === undefined) continue;
    buf = (buf << 5) | v;
    bits += 5;
    if (bits >= 8) { out[idx++] = (buf >> (bits - 8)) & 0xff; bits -= 8; }
  }
  return out;
}

/**
 * Encode a Uint8Array to a base-32 string (no padding).
 */
export function b32Encode(bytes) {
  let s = '', buf = 0, bits = 0;
  for (const b of bytes) {
    buf = (buf << 8) | b;
    bits += 8;
    while (bits >= 5) { s += _B32[(buf >> (bits - 5)) & 0x1f]; bits -= 5; }
  }
  if (bits > 0) s += _B32[(buf << (5 - bits)) & 0x1f];
  return s;
}

// ---------------------------------------------------------------------------
// HMAC-SHA1 via Web Crypto
// ---------------------------------------------------------------------------

async function _hmacSha1(keyBytes, data) {
  const key = await crypto.subtle.importKey(
    'raw', keyBytes,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

// ---------------------------------------------------------------------------
// HOTP / TOTP core
// ---------------------------------------------------------------------------

async function _hotp(secret32, counter) {
  const key = _b32Decode(secret32);
  // Counter as 8-byte big-endian unsigned integer
  const msg = new Uint8Array(8);
  let c = BigInt(Math.round(counter));
  for (let i = 7; i >= 0; i--) { msg[i] = Number(c & 0xffn); c >>= 8n; }
  const hash   = await _hmacSha1(key, msg);
  const offset = hash[19] & 0x0f;
  const code   = (
    ((hash[offset]     & 0x7f) << 24) |
    ( hash[offset + 1]         << 16) |
    ( hash[offset + 2]         <<  8) |
      hash[offset + 3]
  ) % 1_000_000;
  return String(code).padStart(6, '0');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically random 20-byte secret, encoded as base-32.
 * Store this in the user record (encrypted). Never transmit it.
 */
export function generateSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(20)); // 160 bits
  return b32Encode(bytes);
}

/**
 * Return the 6-digit TOTP code for the current (or offset) 30-second window.
 * @param {string}  secret32   Base-32 TOTP secret.
 * @param {number}  stepOffset Steps offset from current (e.g. -1, 0, +1).
 */
export async function getCode(secret32, stepOffset = 0) {
  const step = Math.floor(Date.now() / 1000 / 30) + stepOffset;
  return _hotp(secret32, step);
}

/**
 * Verify a user-supplied 6-digit code against the secret.
 *
 * @param {string}  secret32      Base-32 TOTP secret.
 * @param {string}  code          User-supplied code (6 digits).
 * @param {object}  opts
 * @param {number}  opts.window         Steps to check on each side (default 1 = ±30 s).
 * @param {number}  opts.lastUsedStep   Last step that was accepted (replay guard).
 *
 * @returns {{ ok: boolean, step: number }}
 *   ok=true + matched step if valid; ok=false + step=-1 otherwise.
 */
export async function verify(secret32, code, { window = 1, lastUsedStep = -1 } = {}) {
  const canonical = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(canonical)) return { ok: false, step: -1 };
  const now = Math.floor(Date.now() / 1000 / 30);
  for (let i = -window; i <= window; i++) {
    const step = now + i;
    if (step <= lastUsedStep) continue; // replay guard
    if (await _hotp(secret32, step) === canonical) return { ok: true, step };
  }
  return { ok: false, step: -1 };
}

// ---------------------------------------------------------------------------
// Backup codes
// ---------------------------------------------------------------------------

/**
 * Generate `count` random 8-character hex backup codes.
 *
 * Returns { plain: string[], hashed: string[] }.
 * Store `hashed` on the user record; show `plain` to the user ONCE.
 * Each hashed entry is a lowercase hex SHA-256 digest of the plain code.
 */
export async function generateBackupCodes(count = 8) {
  const enc    = new TextEncoder();
  const plain  = [];
  const hashed = [];
  for (let i = 0; i < count; i++) {
    // 5 random bytes → 10 hex chars; slice to 8 for usability
    const raw  = crypto.getRandomValues(new Uint8Array(5));
    const code = Array.from(raw).map(b => b.toString(16).padStart(2, '0')).join('')
      .toUpperCase().slice(0, 8);
    plain.push(code);
    const digest = await crypto.subtle.digest('SHA-256', enc.encode(code));
    hashed.push(Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join(''));
  }
  return { plain, hashed };
}

/**
 * Check if `inputCode` matches one of the `hashedCodes`.
 * Returns the index of the matched code (for removal), or -1 if not found.
 * Comparison is timing-safe (all hashes are always computed).
 */
export async function verifyBackupCode(inputCode, hashedCodes) {
  const enc       = new TextEncoder();
  const canonical = String(inputCode ?? '').replace(/[\s-]/g, '').toUpperCase();
  const digest    = await crypto.subtle.digest('SHA-256', enc.encode(canonical));
  const hex       = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  // Scan all entries so timing is constant regardless of match position
  let found = -1;
  for (let i = 0; i < hashedCodes.length; i++) {
    if (hashedCodes[i] === hex && found === -1) found = i;
  }
  return found;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the otpauth:// URI for QR-code generation or manual import into
 * any RFC 6238-compliant authenticator app.
 *
 * @param {string} secret32    Base-32 secret.
 * @param {string} accountLabel  e.g. "LCPL Smith" — shown in the app.
 * @param {string} issuer        e.g. "QStore IMS" — shown in the app.
 */
export function otpauthUri(secret32, accountLabel, issuer = 'QStore IMS') {
  return (
    `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(accountLabel)}`
    + `?secret=${secret32}`
    + `&issuer=${encodeURIComponent(issuer)}`
    + `&algorithm=SHA1&digits=6&period=30`
  );
}

/**
 * Format a base-32 secret into 4-character groups for manual entry display.
 * e.g. "JBSWY3DPEHPK3PXP" → "JBSW Y3DP EHPK 3PXP"
 */
export function formatSecret(secret32) {
  return secret32.toUpperCase().replace(/(.{4})(?=.)/g, '$1 ');
}
