// =============================================================================
// QStore IMS v2 — AUTH module
// =============================================================================
// Authentication, sessions, roles, and permissions. Built on top of Storage —
// users, audit entries, and the force-invalidation flag all go through the
// IndexedDB layer. Sessions live in sessionStorage (per-tab, cleared on
// close) and a single in-memory _session object for fast access.
//
// PIN HASHING
//   Live algorithm: argon2id via hash-wasm.
//     params: t=3, m=64MB (65536 KB), p=1, hashLength=32, outputType='encoded'
//     ~200ms per hash on typical desktop hardware.
//
//   Legacy algorithm: v1's DJB2 (32-bit, unsalted, base36 string).
//     Kept here byte-for-byte under _legacyHashV1 — DO NOT modify, or
//     migrated user accounts will be locked out.
//
//   Transparent rehash: on first successful login, if the user record has
//   pinHashAlgorithm === 'legacy-sha' and the supplied PIN verifies against
//   the DJB2 hash, the PIN is re-hashed with argon2id, the legacy fields
//   are removed, and an audit entry is written.
//
//   Limitation: a 4-digit PIN has only 10,000 possibilities. Any attacker
//   with database access can brute-force it in seconds regardless of hash
//   function. The hash slows down opportunistic attacks but does not
//   provide meaningful resistance to a determined adversary. Real
//   protection requires keeping the database off attacker-controlled
//   machines.
//
// SESSIONS
//   Stored in sessionStorage as JSON. Restored on init() if present and
//   valid. Force-invalidation: a CO can call invalidateAllSessions() which
//   writes a timestamp to settings; restoreSession() rejects any cached
//   session with a loginAt earlier than that timestamp (CO sessions are
//   exempt so the CO can't lock themselves out).
//
// ROLES & PERMISSIONS
//   Verbatim copy of v1's ROLES and PERMS tables. Five roles: co, qm,
//   staff, cadet, ro. The 'co' role has the implicit 'all' permission.
//
// DEPENDENCIES
//   hash-wasm 4.11+ for argon2id.
//     The bare 'hash-wasm' import is resolved two different ways:
//       Dev:  index.html provides an importmap pointing at the esm.sh CDN,
//             so the browser fetches it at runtime. No build step needed.
//       Prod: build.js bundles hash-wasm from node_modules into the single
//             output HTML. The WASM payload is base64-inlined inside
//             hash-wasm's own JS, so no separate .wasm file is emitted.
// =============================================================================

import * as Storage from './storage.js';
import { argon2id, argon2Verify } from 'hash-wasm';

// -----------------------------------------------------------------------------
// Constants — exported so other modules can reference role labels and the
// permission table directly (e.g., for rendering a role dropdown).
// -----------------------------------------------------------------------------

export const ROLES = Object.freeze({
  co:    { label: 'CO / OC',    short: 'CO'  },
  qm:    { label: 'QM Staff',   short: 'QM'  },
  staff: { label: 'Staff',      short: 'STF' },
  cadet: { label: 'Cadet',      short: 'CDT' },
  ro:    { label: 'Read-Only',  short: 'R/O' },
});

export const PERMS = Object.freeze({
  co:    ['all'],
  qm:    ['view', 'issue', 'return', 'addItem', 'editItem', 'manageCadets',
          'reports', 'audit', 'qr', 'import', 'requestIssue'],
  staff: ['view', 'viewOwnLoans', 'requestIssue', 'reports'],
  cadet: ['view', 'viewOwnLoans', 'requestIssue', 'reports'],
  ro:    ['view', 'requestIssue', 'reports'],
});

const SESSION_STORAGE_KEY    = 'qstore_session';
const SETTING_INVALIDATED_AT = 'session.invalidatedAt';

const ARGON_PARAMS = {
  parallelism: 1,
  iterations:  3,
  memorySize:  64 * 1024,  // 64 MB, expressed in KB per hash-wasm convention
  hashLength:  32,
};

// -----------------------------------------------------------------------------
// Module state
// -----------------------------------------------------------------------------

let _session = null;
const _listeners = new Set();

// -----------------------------------------------------------------------------
// Hashing
// -----------------------------------------------------------------------------

/**
 * EXACT copy of v1's hashPin function. DO NOT modify — required to verify
 * legacy PINs during transparent rehash. v1 source location: line ~3397.
 */
function _legacyHashV1(pin) {
  let h = 5381;
  for (let i = 0; i < pin.length; i++) h = ((h << 5) + h) ^ pin.charCodeAt(i);
  return (h >>> 0).toString(36);
}

async function _argonHash(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return argon2id({
    password: String(pin),
    salt,
    ...ARGON_PARAMS,
    outputType: 'encoded',  // standard "$argon2id$..." string; salt + params self-describing
  });
}

async function _argonVerify(pin, encoded) {
  if (typeof encoded !== 'string' || !encoded.startsWith('$argon2id$')) {
    return false;
  }
  try {
    return await argon2Verify({ password: String(pin), hash: encoded });
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Lifecycle
// -----------------------------------------------------------------------------

/**
 * Open Storage and attempt to restore a session from sessionStorage. Returns
 * the restored session, or null if there isn't one (or it's been invalidated).
 */
export async function init() {
  await Storage.init();
  return _restoreSession();
}

/**
 * If no users exist, create the default admin account: username 'admin',
 * PIN '0000', role 'co'. Returns true if created, false if no-op.
 */
export async function ensureDefaultAdmin() {
  const count = await Storage.users.count();
  if (count > 0) return false;

  const pinHash = await _argonHash('0000');
  await Storage.users.put({
    id:                'usr-default-co',
    name:              'Administrator (CO)',
    username:          'admin',
    role:              'co',
    svcNo:             '',
    pinHash,
    pinHashAlgorithm:  'argon2id',
    lastLogin:         null,
    createdAt:         new Date().toISOString(),
  });
  await Storage.audit.append({
    action: 'add',
    user:   'system',
    desc:   'Default Administrator (CO) account created with PIN 0000 — change immediately.',
  });
  return true;
}

// -----------------------------------------------------------------------------
// Login / logout / session
// -----------------------------------------------------------------------------

/**
 * Attempt to log in by user id and PIN.
 *
 * Returns:
 *   { ok: true, session }                — successful login
 *   { ok: false, reason: 'missing_credentials' }
 *   { ok: false, reason: 'user_not_found' }
 *   { ok: false, reason: 'invalid_user_record' }   — user has no hash at all
 *   { ok: false, reason: 'unknown_algorithm' }
 *   { ok: false, reason: 'invalid_pin' }
 *
 * On a successful login from a legacy-sha record, the PIN is transparently
 * re-hashed with argon2id; the user record is updated and the legacy fields
 * are removed. Audit entries are written for: rehash (if it happened),
 * login (always on success), login_failed (on bad PIN).
 */
export async function login(userId, pin) {
  if (!userId || pin === undefined || pin === null || pin === '') {
    return { ok: false, reason: 'missing_credentials' };
  }
  const user = await Storage.users.get(userId);
  if (!user) return { ok: false, reason: 'user_not_found' };

  const algo = user.pinHashAlgorithm || (user.legacyPinHash ? 'legacy-sha' : 'argon2id');
  let verified    = false;
  let needsRehash = false;

  if (algo === 'legacy-sha') {
    if (!user.legacyPinHash) return { ok: false, reason: 'invalid_user_record' };
    verified    = (_legacyHashV1(String(pin)) === user.legacyPinHash);
    needsRehash = verified;
  } else if (algo === 'argon2id') {
    if (!user.pinHash) return { ok: false, reason: 'invalid_user_record' };
    verified = await _argonVerify(pin, user.pinHash);
  } else {
    return { ok: false, reason: 'unknown_algorithm' };
  }

  if (!verified) {
    await Storage.audit.append({
      action: 'login_failed',
      user:   user.name || user.username,
      desc:   `Failed login attempt for user: ${user.username}`,
    });
    return { ok: false, reason: 'invalid_pin' };
  }

  // Transparent rehash from legacy → argon2id. We do this BEFORE setting the
  // session and writing the success audit entry, so the audit chain reads
  // chronologically: rehash → login.
  if (needsRehash) {
    const newHash = await _argonHash(pin);
    user.pinHash          = newHash;
    user.pinHashAlgorithm = 'argon2id';
    delete user.legacyPinHash;
    await Storage.users.put(user);
    await Storage.audit.append({
      action: 'rehash',
      user:   user.name || user.username,
      desc:   `PIN rehashed from legacy-sha to argon2id for ${user.username}.`,
    });
  }

  // Update last-login timestamp.
  user.lastLogin = new Date().toISOString();
  await Storage.users.put(user);

  _session = {
    userId:        user.id,
    username:      user.username,
    name:          user.name,
    role:          user.role,
    svcNo:         user.svcNo || null,
    loginAt:       new Date().toISOString(),
    pinIsDefault:  String(pin) === '0000',
  };
  sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(_session));

  await Storage.audit.append({
    action: 'login',
    user:   user.name,
    desc:   `Login: ${user.name} (${ROLES[user.role]?.label || user.role})`,
  });
  _notify();
  return { ok: true, session: { ..._session } };
}

export async function logout() {
  if (_session) {
    await Storage.audit.append({
      action: 'logout',
      user:   _session.name,
      desc:   `Logout: ${_session.name}`,
    });
  }
  _session = null;
  sessionStorage.removeItem(SESSION_STORAGE_KEY);
  _notify();
}

export function getSession() {
  return _session ? { ..._session } : null;
}

export function isAuthenticated() {
  return _session !== null;
}

// -----------------------------------------------------------------------------
// Permission helpers
// -----------------------------------------------------------------------------

/**
 * Returns true if the current session has the named permission. CO has all
 * permissions implicitly via the 'all' wildcard.
 */
export function can(perm) {
  if (!_session) return false;
  const perms = PERMS[_session.role] || [];
  return perms.includes('all') || perms.includes(perm);
}

export function isAdmin() {
  return _session !== null && (_session.role === 'co' || _session.role === 'qm');
}

export function isCO() {
  return _session !== null && _session.role === 'co';
}

/** Throws Error if the current session lacks the named permission. */
export function requirePermission(perm) {
  if (!can(perm)) {
    const role = _session?.role || 'unauthenticated';
    throw new Error(`Permission denied: '${perm}' (current role: ${role})`);
  }
}

/** Throws Error if the current session is not in the named role. */
export function requireRole(role) {
  if (_session?.role !== role) {
    const cur = _session?.role || 'unauthenticated';
    throw new Error(`Role required: '${role}' (current role: ${cur})`);
  }
}

/** Throws Error if the current session is not the CO. Convenience wrapper. */
export function requireCO() {
  if (!isCO()) {
    const cur = _session?.role || 'unauthenticated';
    throw new Error(`CO/OC role required (current role: ${cur})`);
  }
}

// -----------------------------------------------------------------------------
// PIN management
// -----------------------------------------------------------------------------

/**
 * Set or reset a user's PIN. Always stores using argon2id, regardless of
 * whether the previous algorithm was legacy-sha. Writes an audit entry. Use
 * for "I forgot my PIN" CO-driven resets, or for self-service PIN changes
 * after the user is logged in (callers should enforce that).
 *
 * If the user being updated is the currently logged-in user AND the new PIN
 * is not '0000', the in-memory and stored session are updated to clear the
 * pinIsDefault flag. This avoids the shell needing to reach into
 * sessionStorage directly.
 *
 * Note: callers wanting the user to set their own PIN should verify the
 * user is logged in as that account, or the caller is a CO.
 */
export async function setPin(userId, pin) {
  if (!/^\d{4}$/.test(String(pin))) {
    throw new Error('PIN must be exactly 4 digits.');
  }
  const user = await Storage.users.get(userId);
  if (!user) throw new Error('User not found: ' + userId);

  user.pinHash          = await _argonHash(pin);
  user.pinHashAlgorithm = 'argon2id';
  delete user.legacyPinHash;
  await Storage.users.put(user);

  await Storage.audit.append({
    action: 'pin_change',
    user:   _session?.name || 'system',
    desc:   `PIN updated for ${user.username}.`,
  });

  // If the caller updated the currently-logged-in user and they moved off
  // the default, sync the session state. This is the only place the
  // pinIsDefault flag transitions from true to false post-login.
  if (_session && _session.userId === userId) {
    const stillDefault = String(pin) === '0000';
    if (_session.pinIsDefault !== stillDefault) {
      _session = { ..._session, pinIsDefault: stillDefault };
      sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(_session));
      _notify();
    }
  }
}

// -----------------------------------------------------------------------------
// Session force-invalidation (CO-only)
// -----------------------------------------------------------------------------

/**
 * Force every non-CO session to expire on next restoreSession(). Stores the
 * cutoff timestamp in settings; sessions with loginAt < cutoff are rejected
 * unless their role is 'co'. Throws if called by a non-CO.
 *
 * The current CO's session is preserved (loginAt timestamp updated to now)
 * so they don't lock themselves out by issuing the command.
 */
export async function invalidateAllSessions() {
  if (!isCO()) {
    throw new Error('Only CO can force-invalidate all sessions.');
  }
  const ts = new Date().toISOString();
  await Storage.settings.set(SETTING_INVALIDATED_AT, ts);

  // Bump the current CO's session loginAt so it remains valid.
  _session.loginAt = ts;
  sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(_session));

  await Storage.audit.append({
    action: 'session_invalidate',
    user:   _session.name,
    desc:   'All non-CO sessions force-invalidated.',
  });
}

// -----------------------------------------------------------------------------
// Listeners (for UI to react to session changes)
// -----------------------------------------------------------------------------

/**
 * Subscribe to session changes (login, logout, restore). Listener is called
 * with the new session (or null on logout). Returns an unsubscribe function.
 */
export function onSessionChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

function _notify() {
  const snapshot = _session ? { ..._session } : null;
  for (const fn of _listeners) {
    try { fn(snapshot); }
    catch (e) { console.error('AUTH listener error:', e); }
  }
}

// -----------------------------------------------------------------------------
// Internal: session restore
// -----------------------------------------------------------------------------

async function _restoreSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.userId) return _clearStaleSession();

    // Force-invalidation check. Co sessions are exempt so the CO who issues
    // the invalidation isn't immediately locked out (they also get their
    // loginAt bumped at issue time, but this is belt-and-braces).
    const cutoff = await Storage.settings.get(SETTING_INVALIDATED_AT);
    if (cutoff && parsed.loginAt < cutoff && parsed.role !== 'co') {
      return _clearStaleSession();
    }

    // Verify the user still exists and the role hasn't changed since this
    // session was issued. Role drift can happen if a CO demotes the user
    // mid-session — they should be forced back through login.
    const user = await Storage.users.get(parsed.userId);
    if (!user || user.role !== parsed.role) {
      return _clearStaleSession();
    }

    _session = parsed;
    _notify();
    return { ..._session };
  } catch {
    return _clearStaleSession();
  }
}

function _clearStaleSession() {
  sessionStorage.removeItem(SESSION_STORAGE_KEY);
  _session = null;
  return null;
}

// -----------------------------------------------------------------------------
// Exposed for tests only — do not call from app code.
// -----------------------------------------------------------------------------

export const __testing__ = {
  legacyHashV1: _legacyHashV1,
  /**
   * Wipe in-memory session state without writing audit. Tests are
   * responsible for clearing sessionStorage themselves if they want a
   * clean slate; this lets tests pre-seed a session blob and then call
   * init() to verify restoration logic.
   */
  resetForTests: () => {
    _session = null;
    _listeners.clear();
  },
};
