// TOTP headless test — validates generateSecret, getCode, verify,
// generateBackupCodes, verifyBackupCode, and formatSecret against
// known-good values and edge cases.

import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

// Must use the actual src path after polyfill
const TOTP = await import('./src/totp.js');

let pass = 0, fail = 0;
function ok(msg)  { console.log('  ✓', msg); pass++; }
function bad(msg) { console.error('  ✗', msg); fail++; }
function expect(cond, msg) { cond ? ok(msg) : bad(msg); }
function eq(a, b, msg) {
  if (a === b) ok(`${msg} (= ${JSON.stringify(a)})`);
  else bad(`${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ---------------------------------------------------------------------------
// [1] generateSecret
// ---------------------------------------------------------------------------
console.log('\n[1] generateSecret');
const secret = TOTP.generateSecret();
expect(typeof secret === 'string', 'returns a string');
expect(secret.length >= 32, `length >= 32 (${secret.length})`);
expect(/^[A-Z2-7]+$/.test(secret), 'valid base-32 alphabet');

// ---------------------------------------------------------------------------
// [2] getCode
// ---------------------------------------------------------------------------
console.log('\n[2] getCode');
const code = await TOTP.getCode(secret);
expect(/^\d{6}$/.test(code), `6-digit code: ${code}`);

// Codes for different offsets should differ (with overwhelming probability)
const codeM1 = await TOTP.getCode(secret, -100);  // far past
const codeP1 = await TOTP.getCode(secret, +100);  // far future
expect(codeM1 !== codeP1, 'different offsets produce different codes');

// ---------------------------------------------------------------------------
// [3] verify — basic
// ---------------------------------------------------------------------------
console.log('\n[3] verify — basic acceptance');
const current = await TOTP.getCode(secret, 0);
const r1 = await TOTP.verify(secret, current);
expect(r1.ok, 'current step verifies');
expect(r1.step >= 0, `step is non-negative (${r1.step})`);

// ---------------------------------------------------------------------------
// [4] verify — window tolerance
// ---------------------------------------------------------------------------
console.log('\n[4] verify — ±1 window');
const prev = await TOTP.getCode(secret, -1);
const next = await TOTP.getCode(secret, +1);
const rPrev = await TOTP.verify(secret, prev);
const rNext = await TOTP.verify(secret, next);
expect(rPrev.ok, 'previous step accepted within window');
expect(rNext.ok, 'next step accepted within window');

const farPast = await TOTP.getCode(secret, -5);
const rFar = await TOTP.verify(secret, farPast);
expect(!rFar.ok, 'step 5 windows ago rejected');

// ---------------------------------------------------------------------------
// [5] verify — replay guard
// ---------------------------------------------------------------------------
console.log('\n[5] verify — replay guard');
const step = r1.step;
const r2 = await TOTP.verify(secret, current, { lastUsedStep: step });
expect(!r2.ok, `same step rejected after marking used (step ${step})`);
// But a different (future) step should still work
const rFuture = await TOTP.verify(secret, next, { lastUsedStep: step });
expect(rFuture.ok, 'future step accepted even after guard on current');

// ---------------------------------------------------------------------------
// [6] verify — wrong code
// ---------------------------------------------------------------------------
console.log('\n[6] verify — wrong code');
const wrong = await TOTP.verify(secret, '000000');
expect(!wrong.ok, 'arbitrary code 000000 rejected');
const rBadFormat = await TOTP.verify(secret, 'abc');
expect(!rBadFormat.ok, 'non-numeric code rejected');

// ---------------------------------------------------------------------------
// [7] Backup codes
// ---------------------------------------------------------------------------
console.log('\n[7] generateBackupCodes + verifyBackupCode');
const { plain, hashed } = await TOTP.generateBackupCodes(8);
eq(plain.length, 8, 'generates 8 plain codes');
eq(hashed.length, 8, 'generates 8 hashed codes');
for (const c of plain) expect(/^[0-9A-F]{8}$/.test(c), `code format: ${c}`);
for (const h of hashed) expect(/^[0-9a-f]{64}$/.test(h), `hash is SHA-256 hex: ${h.slice(0, 8)}…`);

// Verify each plain code against the hashed list
const idx0 = await TOTP.verifyBackupCode(plain[0], hashed);
eq(idx0, 0, 'first code found at index 0');
const idx4 = await TOTP.verifyBackupCode(plain[4], hashed);
eq(idx4, 4, 'fifth code found at index 4');

// Verify case-insensitive
const lower = plain[2].toLowerCase();
const idxLow = await TOTP.verifyBackupCode(lower, hashed);
eq(idxLow, 2, 'code verified case-insensitively');

// Wrong code
const idxWrong = await TOTP.verifyBackupCode('XXXXXXXX', hashed);
eq(idxWrong, -1, 'invalid backup code returns -1');

// After consuming index 0, same code should still find it (caller removes it)
// i.e. verifyBackupCode is stateless — caller responsibility to remove
const idx0Again = await TOTP.verifyBackupCode(plain[0], hashed);
eq(idx0Again, 0, 'verifyBackupCode is stateless (index still findable)');

// Simulate consuming: remove index 0 from hashed
const consumed = hashed.filter((_, i) => i !== 0);
const idxGone = await TOTP.verifyBackupCode(plain[0], consumed);
eq(idxGone, -1, 'code not found after removal from list');

// ---------------------------------------------------------------------------
// [8] otpauthUri
// ---------------------------------------------------------------------------
console.log('\n[8] otpauthUri');
const uri = TOTP.otpauthUri(secret, 'LCPL Smith', 'QStore IMS');
expect(uri.startsWith('otpauth://totp/'), 'uri starts correctly');
expect(uri.includes(`secret=${secret}`), 'uri contains secret');
expect(uri.includes('algorithm=SHA1'), 'uri has SHA1');
expect(uri.includes('digits=6'), 'uri has digits=6');
expect(uri.includes('period=30'), 'uri has period=30');

// ---------------------------------------------------------------------------
// [9] formatSecret
// ---------------------------------------------------------------------------
console.log('\n[9] formatSecret');
const formatted = TOTP.formatSecret('JBSWY3DPEHPK3PXP');
eq(formatted, 'JBSW Y3DP EHPK 3PXP', 'groups of 4 with spaces');

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
console.log(`\nResults: ${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
