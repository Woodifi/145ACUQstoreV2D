// Headless smoke test — exercises Recovery codes and PIN reset.
//
// Covers:
//   - Recovery.generate produces formatted + canonical pairs that round-trip
//     through normalize/format/isWellFormed.
//   - Recovery.hash + Recovery.verify round-trip.
//   - generateForUser / verifyForUser / consumeForUser against fake-IDB.
//   - Recovery codes are OC-only.
//   - Auth.setPin({ generateRecovery: true }) returns a code; setPin without
//     the option does not.
//   - Auth.resetPinWithRecoveryCode rejects bad PINs, bad codes, non-OC,
//     and accepts a valid code while consuming it (one-shot).
//   - Audit chain stays valid through the recovery-reset flow.

import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

// Minimal sessionStorage polyfill — Auth.init() reads/writes it on restore
// to repopulate the session from a previous tab. We don't care about that
// path in tests; the polyfill makes the API exist so init() doesn't throw.
if (!globalThis.sessionStorage) {
  const _store = new Map();
  globalThis.sessionStorage = {
    getItem(k)  { return _store.has(k) ? _store.get(k) : null; },
    setItem(k, v) { _store.set(k, String(v)); },
    removeItem(k) { _store.delete(k); },
    clear()      { _store.clear(); },
  };
}

const Storage  = await import('./src/storage.js');
const Recovery = await import('./src/recovery.js');
const Auth     = await import('./src/auth.js');

let pass = 0, fail = 0;
function ok(m)  { console.log('  ✓', m); pass++; }
function bad(m) { console.log('  ✗', m); fail++; }
function expect(cond, msg) { cond ? ok(msg) : bad(msg); }
function eq(a, b, m) {
  if (a === b) ok(`${m} (= ${JSON.stringify(a)})`);
  else bad(`${m} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

await Storage.init({ dbName: 'qstore_test_recovery' });
await Auth.init();

// -----------------------------------------------------------------------------
console.log('[1] generate() produces well-formed codes');
for (let i = 0; i < 5; i++) {
  const { canonical, formatted } = Recovery.generate();
  expect(canonical.length === 12, `attempt ${i}: canonical is 12 chars`);
  expect(/^[A-Z0-9]+$/.test(canonical),
    `attempt ${i}: canonical is uppercase alphanumeric (${canonical})`);
  expect(/[01IO]/.test(canonical) === false,
    `attempt ${i}: contains no 0/1/I/O (${canonical})`);
  expect(formatted.length === 14, `attempt ${i}: formatted is 14 chars (with hyphens)`);
  expect(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(formatted),
    `attempt ${i}: formatted matches XXXX-XXX-XXXX (${formatted})`);
  expect(Recovery.normalize(formatted) === canonical,
    `attempt ${i}: formatted -> normalize -> canonical round-trip`);
  expect(Recovery.isWellFormed(canonical),
    `attempt ${i}: canonical isWellFormed`);
}

// -----------------------------------------------------------------------------
console.log('\n[2] normalize forgives whitespace, hyphens, and case');
const { canonical, formatted } = Recovery.generate();
eq(Recovery.normalize(formatted),                canonical, 'as-formatted');
eq(Recovery.normalize(formatted.toLowerCase()),  canonical, 'lowercased');
eq(Recovery.normalize('  ' + formatted + '  '),  canonical, 'wrapped in whitespace');
eq(Recovery.normalize(formatted.replace(/-/g, ' ')), canonical, 'spaces instead of hyphens');
eq(Recovery.normalize(formatted.replace(/-/g, '')), canonical, 'no separators at all');

// -----------------------------------------------------------------------------
console.log('\n[3] isWellFormed rejects bad input');
expect(!Recovery.isWellFormed('AAAA'),       'too short');
expect(!Recovery.isWellFormed('A'.repeat(13)), 'too long');
expect(!Recovery.isWellFormed('ABCDEFGHIJKO'), 'contains O (excluded)');
expect(!Recovery.isWellFormed('ABCDEFGHIJK0'), 'contains 0 (excluded)');
expect(!Recovery.isWellFormed('ABCDEFGHIJK1'), 'contains 1 (excluded)');
expect(!Recovery.isWellFormed('ABCDEFGHIJKI'), 'contains I (excluded)');
expect(!Recovery.isWellFormed('abcdefghjklm'), 'lowercase rejected (caller must normalize first)');
expect(!Recovery.isWellFormed(null),  'null rejected');
expect(!Recovery.isWellFormed(123),   'number rejected');

// -----------------------------------------------------------------------------
console.log('\n[4] hash + verify round-trip');
const code1 = Recovery.generate();
const h1 = await Recovery.hash(code1.canonical);
expect(h1.startsWith('$argon2id$'), 'hash is encoded form');
expect(await Recovery.verify(code1.canonical, h1) === true, 'verifies canonical');
expect(await Recovery.verify(code1.formatted, h1) === true, 'verifies formatted');
expect(await Recovery.verify(code1.formatted.toLowerCase(), h1) === true, 'verifies lowercased formatted');
expect(await Recovery.verify('XXXX-XXXX-XXXX', h1) === false, 'wrong code rejected');
expect(await Recovery.verify('', h1) === false, 'empty rejected');
expect(await Recovery.verify(code1.formatted, 'not a hash') === false, 'malformed hash rejected');

// -----------------------------------------------------------------------------
console.log('\n[5] generateForUser + verifyForUser + consumeForUser');
// Seed a CO and a non-CO user.
await Storage.users.put({
  id: 'usr-co', name: 'OC Test', username: 'oc', role: 'co',
  pinHash: await (await import('hash-wasm')).argon2id({
    password: '1234',
    salt: crypto.getRandomValues(new Uint8Array(16)),
    parallelism: 1, iterations: 3, memorySize: 64*1024, hashLength: 32,
    outputType: 'encoded',
  }),
  pinHashAlgorithm: 'argon2id',
  createdAt: new Date().toISOString(),
});
await Storage.users.put({
  id: 'usr-cdt', name: 'Cadet Test', username: 'cdt', role: 'cadet',
  pinHash: '$argon2id$v=19$m=65536,t=3,p=1$AAAA$AAAA',
  pinHashAlgorithm: 'argon2id',
  createdAt: new Date().toISOString(),
});

const codeForOc = await Recovery.generateForUser('usr-co');
expect(typeof codeForOc === 'string' && codeForOc.length === 14, `code returned: ${codeForOc}`);
const status = await Recovery.statusForUser('usr-co');
expect(status.exists === true, 'status.exists === true after generation');
expect(typeof status.createdAt === 'string', 'status.createdAt is a string');

expect(await Recovery.verifyForUser('usr-co', codeForOc) === true, 'verifyForUser accepts the code');
expect(await Recovery.verifyForUser('usr-co', 'WRON-GCOD-EHER') === false, 'wrong code rejected');
expect(await Recovery.verifyForUser('does-not-exist', codeForOc) === false, 'unknown user rejected');

// Non-CO is rejected at generate-for-user.
let threw = false;
try { await Recovery.generateForUser('usr-cdt'); } catch { threw = true; }
expect(threw, 'generateForUser refuses non-CO');
expect(await Recovery.verifyForUser('usr-cdt', codeForOc) === false, 'verifyForUser refuses non-CO');

// Consume — clears the hash.
await Recovery.consumeForUser('usr-co');
expect((await Recovery.statusForUser('usr-co')).exists === false, 'consumed: status.exists === false');
expect(await Recovery.verifyForUser('usr-co', codeForOc) === false, 'consumed: code no longer verifies');

// -----------------------------------------------------------------------------
console.log('\n[6] Auth.setPin({ generateRecovery: true })');
const r1 = await Auth.setPin('usr-co', '5678', { generateRecovery: true });
expect(typeof r1.recoveryCode === 'string' && r1.recoveryCode.length === 14,
  `setPin with generateRecovery returned a formatted code: ${r1.recoveryCode}`);
expect((await Recovery.statusForUser('usr-co')).exists === true,
  'recovery hash present after setPin with generateRecovery');

// Without the flag, no code is generated and no existing one is touched.
const r2 = await Auth.setPin('usr-co', '9999');
eq(r2.recoveryCode, null, 'setPin without flag returns recoveryCode: null');
expect((await Recovery.statusForUser('usr-co')).exists === true,
  'existing recovery hash NOT consumed by routine setPin');

// generateRecovery on a non-CO is a no-op (no error).
const r3 = await Auth.setPin('usr-cdt', '1111', { generateRecovery: true });
eq(r3.recoveryCode, null, 'setPin generateRecovery on non-CO returns null');

// -----------------------------------------------------------------------------
console.log('\n[7] Auth.resetPinWithRecoveryCode happy path');
// Set up fresh: new PIN + new recovery code on the OC.
const r4 = await Auth.setPin('usr-co', '1234', { generateRecovery: true });
const codeNow = r4.recoveryCode;

const reset1 = await Auth.resetPinWithRecoveryCode('usr-co', codeNow, '7777');
eq(reset1.ok, true, 'happy-path returns ok: true');

// Verify by attempting login with the new PIN.
const login1 = await Auth.login('usr-co', '7777');
eq(login1.ok, true, 'login succeeds with new PIN');
await Auth.logout();

// Recovery hash should be consumed — code no longer works.
const reset2 = await Auth.resetPinWithRecoveryCode('usr-co', codeNow, '8888');
eq(reset2.ok, false, 'second reset with same code fails');
eq(reset2.reason, 'no_recovery', 'reason is no_recovery (hash was consumed)');

// -----------------------------------------------------------------------------
console.log('\n[8] Auth.resetPinWithRecoveryCode failure paths');
// Generate a fresh code first.
const r5 = await Auth.setPin('usr-co', '4321', { generateRecovery: true });
const codeFresh = r5.recoveryCode;

eq((await Auth.resetPinWithRecoveryCode('usr-co', codeFresh, '123')).reason,  'invalid_pin', 'short PIN rejected');
eq((await Auth.resetPinWithRecoveryCode('usr-co', codeFresh, '0000')).reason, 'invalid_pin', 'default PIN rejected');
eq((await Auth.resetPinWithRecoveryCode('usr-co', 'WRON-GCOD-EHER', '5555')).reason, 'invalid_code', 'wrong code rejected');
eq((await Auth.resetPinWithRecoveryCode('does-not-exist', codeFresh, '5555')).reason, 'no_recovery', 'unknown user rejected');
eq((await Auth.resetPinWithRecoveryCode('usr-cdt', codeFresh, '5555')).reason, 'no_recovery', 'non-CO rejected');

// Code must still be live after failed attempts (failures don't consume it).
const status3 = await Recovery.statusForUser('usr-co');
expect(status3.exists === true, 'recovery hash still present after failed attempts');
const reset3 = await Auth.resetPinWithRecoveryCode('usr-co', codeFresh, '6666');
eq(reset3.ok, true, 'recovery still usable after prior failures');

// -----------------------------------------------------------------------------
console.log('\n[9] Audit chain remains valid through recovery flow');
const verify = await Storage.audit.verify();
eq(verify.ok, true, `audit chain valid (count=${verify.count}, brokenAt=${verify.brokenAt || 'n/a'})`);

// Check that the expected audit actions appear.
const audits = await Storage.audit.list({ order: 'asc' });
const actions = audits.map((a) => a.action);
expect(actions.includes('recovery_set'),    'recovery_set action present');
expect(actions.includes('recovery_reset'),  'recovery_reset action present');
expect(actions.includes('recovery_reset_failed'), 'recovery_reset_failed action present');

console.log(`\nResults: ${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
