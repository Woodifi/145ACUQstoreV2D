// =============================================================================
// QStore IMS v2 — License module tests
// =============================================================================

import { ed25519 } from '@noble/curves/ed25519.js';

globalThis.__QSTORE_BUILD_ID__ = 'test-build';

const _lsStore = new Map();
globalThis.localStorage = {
  getItem:    k => _lsStore.has(k) ? _lsStore.get(k) : null,
  setItem:    (k, v) => _lsStore.set(k, String(v)),
  removeItem: k => _lsStore.delete(k),
  clear:      () => _lsStore.clear(),
};

if (typeof atob === 'undefined') {
  globalThis.atob = s => Buffer.from(s, 'base64').toString('binary');
  globalThis.btoa = s => Buffer.from(s, 'binary').toString('base64');
}

import { TextEncoder, TextDecoder } from 'node:util';
if (typeof globalThis.TextEncoder === 'undefined') {
  globalThis.TextEncoder = TextEncoder;
  globalThis.TextDecoder = TextDecoder;
}

import {
  validateKey, getLicenseState, activateKey, requireEdit,
  LicenseRestrictedError, LicenseInvalidError, __testing__,
} from './src/license.js';

const TEST_PRIV_KEY = ed25519.utils.randomSecretKey();
const TEST_PUB_KEY  = ed25519.getPublicKey(TEST_PRIV_KEY);
__testing__.setTestPubKey(TEST_PUB_KEY);

function _b64urlEncode(bytes) {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function _makeKey({ sub = 'unit-test', unit = 'Test Unit', iat, exp, tier = 'v2' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ sub, unit, tier, iat: iat ?? now, exp: exp ?? now + 365 * 86400 });
  const payloadB64 = _b64urlEncode(new TextEncoder().encode(payload));
  const msg = new TextEncoder().encode(payloadB64);
  const sig = ed25519.sign(msg, TEST_PRIV_KEY);
  return payloadB64 + '.' + _b64urlEncode(sig);
}

let _pass = 0, _fail = 0;
function assert(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { console.log('  ✓', label, '(' + JSON.stringify(actual) + ')'); _pass++; }
  else    { console.log('  ✗', label, '— expected', JSON.stringify(expected), 'got', JSON.stringify(actual)); _fail++; }
}
function assertThrows(label, fn, errorName) {
  try {
    fn();
    console.log('  ✗', label, '— expected throw, got nothing'); _fail++;
  } catch (e) {
    if (!errorName || e.name === errorName) { console.log('  ✓', label, '(' + e.name + ')'); _pass++; }
    else { console.log('  ✗', label, '— expected', errorName, 'got', e.name); _fail++; }
  }
}
function section(title) { console.log('\n' + title); }
function beforeEach() { __testing__.clearAll(); __testing__.invalidateCache(); }

section('[1] validateKey — signature verification');
{
  const r = validateKey(_makeKey(), { pubKey: TEST_PUB_KEY });
  assert('valid key → ACTIVE', r.state, 'ACTIVE');
  assert('payload.unit preserved', r.payload?.unit, 'Test Unit');
  assert('reason null', r.reason, null);
}
{
  const key = _makeKey();
  const parts = key.split('.');
  const fakePayload = _b64urlEncode(new TextEncoder().encode(
    JSON.stringify({ sub: 'evil', unit: 'Hacker', tier: 'v2', iat: 0, exp: 9999999999 })
  ));
  const r = validateKey(fakePayload + '.' + parts[1], { pubKey: TEST_PUB_KEY });
  assert('tampered payload → INVALID', r.state, 'INVALID');
  assert('reason: bad_signature', r.reason, 'bad_signature');
}
{
  assert('no dot → INVALID', validateKey('notakey', { pubKey: TEST_PUB_KEY }).state, 'INVALID');
  assert('empty → INVALID', validateKey('', { pubKey: TEST_PUB_KEY }).state, 'INVALID');
  assert('null → INVALID', validateKey(null, { pubKey: TEST_PUB_KEY }).state, 'INVALID');
}

section('[2] validateKey — expiry states');
{
  const now = Math.floor(Date.now() / 1000);
  assert('not expired → ACTIVE',      validateKey(_makeKey({ exp: now + 86400     }), { pubKey: TEST_PUB_KEY }).state, 'ACTIVE');
  assert('5 days expired → GRACE',    validateKey(_makeKey({ exp: now - 5 * 86400 }), { pubKey: TEST_PUB_KEY }).state, 'GRACE');
  assert('20 days expired → RESTRICTED', validateKey(_makeKey({ exp: now - 20 * 86400 }), { pubKey: TEST_PUB_KEY }).state, 'RESTRICTED');
}

section('[3] Trial state machine');
{
  beforeEach();
  const s = getLicenseState();
  assert('first launch → TRIAL', s.state, 'TRIAL');
  assert('trialDaysLeft = 30', s.trialDaysLeft, 30);
}
{
  beforeEach();
  __testing__.setTrialStart(Math.floor(Date.now() / 1000) - 31 * 86400);
  const s = getLicenseState();
  assert('trial expired → RESTRICTED', s.state, 'RESTRICTED');
  assert('trialDaysLeft = 0', s.trialDaysLeft, 0);
}
{
  beforeEach();
  __testing__.setTrialStart(Math.floor(Date.now() / 1000) - 15 * 86400);
  const s = getLicenseState();
  assert('15 days in → TRIAL', s.state, 'TRIAL');
  assert('15 days left', s.trialDaysLeft, 15);
}

section('[4] activateKey');
{
  beforeEach();
  const r = activateKey(_makeKey(), { pubKey: TEST_PUB_KEY });
  assert('valid key activates', r.ok, true);
  assert('state ACTIVE after activate', getLicenseState().state, 'ACTIVE');
  assert('unit in payload', getLicenseState().payload?.unit, 'Test Unit');
}
{
  beforeEach();
  const r = activateKey('garbage', { pubKey: TEST_PUB_KEY });
  assert('invalid key → ok:false', r.ok, false);
  assert('state INVALID', r.state, 'INVALID');
}

section('[5] requireEdit enforcement');
{
  beforeEach();
  activateKey(_makeKey(), { pubKey: TEST_PUB_KEY });
  let threw = false; try { requireEdit(); } catch { threw = true; }
  assert('ACTIVE: does not throw', threw, false);
}
{
  beforeEach();
  activateKey(_makeKey({ exp: Math.floor(Date.now() / 1000) - 5 * 86400 }), { pubKey: TEST_PUB_KEY });
  __testing__.invalidateCache();
  let threw = false; try { requireEdit(); } catch { threw = true; }
  assert('GRACE: does not throw', threw, false);
}
{
  beforeEach();
  let threw = false; try { requireEdit(); } catch { threw = true; }
  assert('TRIAL: does not throw', threw, false);
}
{
  beforeEach();
  __testing__.setTrialStart(Math.floor(Date.now() / 1000) - 35 * 86400);
  __testing__.invalidateCache();
  assertThrows('RESTRICTED: throws LicenseRestrictedError', requireEdit, 'LicenseRestrictedError');
}

section('[6] Grace/restricted boundary');
{
  const now = Math.floor(Date.now() / 1000);
  assert('just expired → GRACE',          validateKey(_makeKey({ exp: now - 1             }), { pubKey: TEST_PUB_KEY }).state, 'GRACE');
  assert('14 days expired → GRACE',       validateKey(_makeKey({ exp: now - 14 * 86400    }), { pubKey: TEST_PUB_KEY }).state, 'GRACE');
  assert('14d+1s expired → RESTRICTED',   validateKey(_makeKey({ exp: now - 14*86400 - 1  }), { pubKey: TEST_PUB_KEY }).state, 'RESTRICTED');
}

section('[7] daysRemaining');
{
  beforeEach();
  const now = Math.floor(Date.now() / 1000);
  activateKey(_makeKey({ exp: now + 60 * 86400 }), { pubKey: TEST_PUB_KEY });
  __testing__.invalidateCache();
  assert('daysRemaining ≈ 60', getLicenseState().daysRemaining, 60);
}

console.log('\nResults: ' + _pass + ' passed, ' + _fail + ' failed.');
if (_fail > 0) process.exit(1);
