// =============================================================================
// QStore IMS v2 — License module
// =============================================================================
// Validates Ed25519-signed subscription keys. Manages the trial/active/grace/
// restricted state machine. Enforces read-only mode when expired.
//
// KEY FORMAT
//   base64url(json_payload) + "." + base64url(ed25519_signature)
//   Human form: QSTRE-XXXXX-XXXXX-XXXXX-XXXXX  (base32, chunked)
//
// STATES
//   TRIAL      — no key, within 30 days of first launch. Full access.
//   ACTIVE     — valid signed key, not expired. Full access.
//   GRACE      — key expired ≤ GRACE_DAYS ago. Full access with warning.
//   RESTRICTED — trial or key expired beyond grace. Read-only (view/export/print).
//   INVALID    — bad signature or tampered key. Access denied.
//
// ENFORCEMENT
//   requireEdit() is called by every write path in storage.js before
//   touching IndexedDB. RESTRICTED throws LicenseRestrictedError.
//   Data is never locked — exports and PDF generation always work.
//
// DEV MODE
//   When __QSTORE_BUILD_ID__ === 'dev' all checks return ACTIVE.
//
// PRODUCTION KEY
//   The PRODUCTION_PUBLIC_KEY_HEX constant below holds the real Ed25519 public
//   key. The matching private key is stored in keys/private.key (gitignored).
//   To generate a new key for a unit: node keys/generate-key.mjs --unit="Name"
// =============================================================================

import { ed25519 } from '@noble/curves/ed25519.js';

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const TRIAL_DAYS        = 30;
const GRACE_DAYS        = 14;
const TRIAL_START_KEY   = 'qstore_v2_trial_start';   // localStorage
const LICENSE_KEY_STORE = 'qstore_v2_license';        // localStorage
const CHECKIN_KEY       = 'qstore_v2_checkin';        // localStorage

// Ed25519 public key (32 bytes, hex-encoded).
// Generated 2026-05-29. Matching private key stored in keys/private.key (gitignored).
const PRODUCTION_PUBLIC_KEY_HEX =
  'eb72334df2894f576a922de348a7fd28842857ee8b2ca9f93ea1ba895624339e';

// In dev builds, skip all validation and report ACTIVE.
const IS_DEV = (typeof __QSTORE_BUILD_ID__ !== 'undefined' && __QSTORE_BUILD_ID__ === 'dev');

// -----------------------------------------------------------------------------
// Error classes
// -----------------------------------------------------------------------------

export class LicenseRestrictedError extends Error {
  constructor(msg = 'Subscription required to edit records. Your data is safe — renew to continue.') {
    super(msg);
    this.name = 'LicenseRestrictedError';
  }
}

export class LicenseInvalidError extends Error {
  constructor(msg = 'License key is invalid. Contact support.') {
    super(msg);
    this.name = 'LicenseInvalidError';
  }
}

// -----------------------------------------------------------------------------
// Key validation
// -----------------------------------------------------------------------------

export function validateKey(keyString, { pubKey } = {}) {
  if (!keyString || typeof keyString !== 'string') {
    return { state: 'INVALID', payload: null, reason: 'empty_key' };
  }

  const normalised = _normaliseKeyString(keyString.trim());
  const parts = normalised.split('.');
  if (parts.length !== 2) {
    return { state: 'INVALID', payload: null, reason: 'malformed' };
  }

  const [payloadB64, sigB64] = parts;

  let payload;
  try {
    payload = JSON.parse(_b64urlDecode(payloadB64));
  } catch {
    return { state: 'INVALID', payload: null, reason: 'malformed_payload' };
  }

  try {
    const effectivePubKey = pubKey ?? _testPubKey ?? _getProductionPubKey();
    const msg = new TextEncoder().encode(payloadB64);
    const sig = _b64urlToBytes(sigB64);
    if (!ed25519.verify(sig, msg, effectivePubKey)) {
      return { state: 'INVALID', payload: null, reason: 'bad_signature' };
    }
  } catch {
    return { state: 'INVALID', payload: null, reason: 'verify_error' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number') {
    return { state: 'INVALID', payload, reason: 'missing_exp' };
  }

  if (now <= payload.exp) {
    return { state: 'ACTIVE', payload, reason: null };
  }
  if (now <= payload.exp + GRACE_DAYS * 86400) {
    return { state: 'GRACE', payload, reason: null };
  }
  return { state: 'RESTRICTED', payload, reason: 'expired' };
}

// -----------------------------------------------------------------------------
// State machine
// -----------------------------------------------------------------------------

let _cachedState = null;
let _testPubKey  = null;

export function getLicenseState() {
  // V2L sandbox — always active, no key required.
  if (typeof __V2L_SANDBOX__ !== 'undefined' && __V2L_SANDBOX__) {
    return { state: 'ACTIVE', payload: { unit: 'Learning Edition', tier: 'v2l' }, daysRemaining: 9999, trialDaysLeft: null, expiresAt: null };
  }
  if (IS_DEV) {
    return { state: 'ACTIVE', payload: { unit: 'Development', tier: 'v2' }, daysRemaining: 365, trialDaysLeft: null, expiresAt: null };
  }

  if (_cachedState) return _cachedState;

  const storedKey = localStorage.getItem(LICENSE_KEY_STORE);

  if (storedKey) {
    const result  = validateKey(storedKey);
    const payload = result.payload;
    const now     = Math.floor(Date.now() / 1000);

    let daysRemaining = null;
    let graceDaysLeft = null;
    let expiresAt     = null;
    if (payload?.exp) {
      daysRemaining = Math.max(0, Math.ceil((payload.exp - now) / 86400));
      expiresAt     = new Date(payload.exp * 1000).toLocaleDateString('en-AU');
      if (result.state === 'GRACE') {
        graceDaysLeft = Math.max(0, Math.ceil((payload.exp + GRACE_DAYS * 86400 - now) / 86400));
      }
    }

    const checkin = _readCheckin();
    if (checkin?.valid === false && result.state === 'ACTIVE') {
      _cachedState = { state: 'GRACE', payload, daysRemaining: 0, graceDaysLeft: 0, trialDaysLeft: null, expiresAt };
      return _cachedState;
    }

    _cachedState = { state: result.state, payload, daysRemaining, graceDaysLeft, trialDaysLeft: null, expiresAt };
    return _cachedState;
  }

  const trialStart    = _getTrialStart();
  const trialDaysLeft = _trialDaysLeft(trialStart);

  if (trialDaysLeft > 0) {
    _cachedState = { state: 'TRIAL', payload: null, daysRemaining: null, trialDaysLeft, expiresAt: null };
  } else {
    _cachedState = { state: 'RESTRICTED', payload: null, daysRemaining: null, trialDaysLeft: 0, expiresAt: null };
  }
  return _cachedState;
}

export function activateKey(keyString, { pubKey } = {}) {
  const result = validateKey(keyString, { pubKey });
  if (result.state === 'INVALID') {
    return { ok: false, state: 'INVALID', payload: null, error: result.reason };
  }
  localStorage.setItem(LICENSE_KEY_STORE, keyString.trim());
  _cachedState = null;
  return { ok: true, state: result.state, payload: result.payload, error: null };
}

export function clearKey() {
  localStorage.removeItem(LICENSE_KEY_STORE);
  _cachedState = null;
}

// -----------------------------------------------------------------------------
// Enforcement
// -----------------------------------------------------------------------------

export function requireEdit() {
  if (typeof __V2L_SANDBOX__ !== 'undefined' && __V2L_SANDBOX__) return;
  if (IS_DEV) return;
  const { state } = getLicenseState();
  if (state === 'RESTRICTED') throw new LicenseRestrictedError();
  if (state === 'INVALID')    throw new LicenseInvalidError();
}

// -----------------------------------------------------------------------------
// Trial management
// -----------------------------------------------------------------------------

function _getTrialStart() {
  const stored = localStorage.getItem(TRIAL_START_KEY);
  if (stored) return parseInt(stored, 10);
  const now = Math.floor(Date.now() / 1000);
  localStorage.setItem(TRIAL_START_KEY, String(now));
  return now;
}

function _trialDaysLeft(trialStartSec) {
  const elapsed = Math.floor(Date.now() / 1000) - trialStartSec;
  return Math.max(0, TRIAL_DAYS - Math.floor(elapsed / 86400));
}

// -----------------------------------------------------------------------------
// Cloud check-in
// -----------------------------------------------------------------------------

export async function checkIn(apiBase) {
  if (IS_DEV) return null;
  const storedKey = localStorage.getItem(LICENSE_KEY_STORE);
  if (!storedKey) return null;

  const checkin = _readCheckin();
  const now = Math.floor(Date.now() / 1000);
  if (checkin?.ts && (now - checkin.ts) < 30 * 86400) return checkin;

  try {
    let payload = null;
    try { payload = JSON.parse(_b64urlDecode(storedKey.split('.')[0])); } catch { return null; }

    const resp = await fetch(apiBase + '/v1/check-in', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        key:     storedKey,
        buildId: typeof __QSTORE_BUILD_ID__ !== 'undefined' ? __QSTORE_BUILD_ID__ : 'unknown',
        sub:     payload?.sub || '',
      }),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data   = await resp.json();
    const result = { valid: !!data.valid, expiresAt: data.expiresAt || null, ts: now };
    _writeCheckin(result);
    _cachedState = null;
    return result;
  } catch {
    const updated = {
      ...(checkin || {}),
      ts:       checkin?.ts || now,
      failures: Math.min(3, (checkin?.failures || 0) + 1),
    };
    _writeCheckin(updated);
    return null;
  }
}

function _readCheckin() {
  try { return JSON.parse(localStorage.getItem(CHECKIN_KEY) || 'null'); }
  catch { return null; }
}

function _writeCheckin(data) {
  try { localStorage.setItem(CHECKIN_KEY, JSON.stringify(data)); } catch {}
}

// -----------------------------------------------------------------------------
// Human key format helpers (QSTRE-XXXXX-XXXXX-XXXXX-XXXXX)
// -----------------------------------------------------------------------------

export function toHumanKey(rawKey) {
  const bytes  = new TextEncoder().encode(rawKey);
  const b32    = _bytesToBase32(bytes);
  const chunks = b32.match(/.{1,5}/g) || [];
  return 'QSTRE-' + chunks.join('-');
}

function _normaliseKeyString(key) {
  if (key.startsWith('QSTRE-')) {
    const b32 = key.slice(6).replace(/-/g, '');
    return new TextDecoder().decode(_base32ToBytes(b32));
  }
  return key;
}

// -----------------------------------------------------------------------------
// Production public key
// -----------------------------------------------------------------------------

function _getProductionPubKey() {
  const hex = PRODUCTION_PUBLIC_KEY_HEX;
  if (!hex || hex === '0000000000000000000000000000000000000000000000000000000000000000') {
    throw new Error('Production public key not configured.');
  }
  return _hexToBytes(hex);
}

// -----------------------------------------------------------------------------
// Crypto utilities
// -----------------------------------------------------------------------------

function _b64urlDecode(s) {
  const pad    = s.length % 4;
  const padded = pad ? s + '='.repeat(4 - pad) : s;
  return atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
}

function _b64urlToBytes(s) {
  const str   = _b64urlDecode(s);
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
  return bytes;
}

function _hexToBytes(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return arr;
}

const B32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function _bytesToBase32(bytes) {
  let bits = 0, value = 0, output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += B32_CHARS[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += B32_CHARS[(value << (5 - bits)) & 31];
  return output;
}

function _base32ToBytes(str) {
  let bits = 0, value = 0;
  const output = [];
  for (const char of str.toUpperCase()) {
    const idx = B32_CHARS.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(output);
}

// -----------------------------------------------------------------------------
// Device registration (Platform Core)
// -----------------------------------------------------------------------------

const _PC_DEVICE_BASE = 'https://api.itemora.com.au/api/v1/devices';
const DEVICE_ID_KEY   = 'qstore_v2_device_id';

function _getDeviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
      (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
    try { localStorage.setItem(DEVICE_ID_KEY, id); } catch { /* storage full */ }
  }
  return id;
}

function _getDeviceOs() {
  const ua = navigator.userAgent;
  if (/Windows/.test(ua)) return 'Windows';
  if (/Mac OS X|macOS/.test(ua)) return 'macOS';
  if (/Android/.test(ua)) return 'Android';
  if (/iPhone|iPad/.test(ua)) return 'iOS';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Unknown';
}

async function _keyHash(rawKey) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawKey));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Register this device with Platform Core. Enforces the maxDevices limit from
 * the signed JWT payload. Non-blocking on startup; await on key entry to catch
 * MAX_DEVICES_REACHED before confirming activation.
 *
 * Returns { success, errorCode?, activeDevices, maxDevices } or null on network failure.
 */
export async function deviceActivate() {
  if (IS_DEV) return null;
  const storedKey = localStorage.getItem(LICENSE_KEY_STORE);
  if (!storedKey) return null;

  let payload = null;
  try { payload = JSON.parse(_b64urlDecode(storedKey.split('.')[0])); } catch { return null; }

  const sub        = payload?.sub || '';
  const maxDevices = typeof payload?.maxDevices === 'number' ? payload.maxDevices : 3;
  const deviceId   = _getDeviceId();
  const deviceName = navigator.userAgent.slice(0, 120);
  const deviceOs   = _getDeviceOs();

  try {
    const keyHash = await _keyHash(storedKey);
    const resp = await fetch(_PC_DEVICE_BASE + '/activate', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ keyHash, sub, maxDevices, deviceId, deviceName, deviceOs }),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return await resp.json();
  } catch {
    return null;
  }
}

/**
 * Deactivate this device on Platform Core (frees a slot).
 */
export async function deviceDeactivate() {
  if (IS_DEV) return null;
  const storedKey = localStorage.getItem(LICENSE_KEY_STORE);
  if (!storedKey) return null;

  try {
    const keyHash = await _keyHash(storedKey);
    const resp = await fetch(_PC_DEVICE_BASE + '/deactivate', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ keyHash, deviceId: _getDeviceId() }),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return await resp.json();
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Testing API — not for use in app code
// -----------------------------------------------------------------------------

export const __testing__ = {
  TRIAL_DAYS,
  GRACE_DAYS,
  TRIAL_START_KEY,
  LICENSE_KEY_STORE,
  CHECKIN_KEY,
  invalidateCache: () => { _cachedState = null; },
  setTestPubKey:   (key) => { _testPubKey = key; _cachedState = null; },
  clearTestPubKey: () => { _testPubKey = null; _cachedState = null; },
  setTrialStart:   (unixSec) => {
    localStorage.setItem(TRIAL_START_KEY, String(unixSec));
    _cachedState = null;
  },
  clearAll: () => {
    localStorage.removeItem(TRIAL_START_KEY);
    localStorage.removeItem(LICENSE_KEY_STORE);
    localStorage.removeItem(CHECKIN_KEY);
    _cachedState = null;
  },
};
