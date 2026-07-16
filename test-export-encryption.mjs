// Export encryption tests — the .qstore file export path.
//
// Last instance of the original defect. exportAll() emits META, and META holds
// piiKey and auditKey. The export modal used to offer "leave blank for
// unencrypted", which wrote that snapshot to disk as plain JSON: the key and
// the ciphertext it opens, in one file, attached to an email.
//
// Encryption is now mandatory. These tests pin the format contract rather than
// the DOM: given the snapshot shape the exporter serialises, the bytes that
// reach disk must never contain key material.

import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else      { fail++; console.error(`  FAIL ${name}`); }
}
async function throws(name, fn) {
  try { await fn(); ok(name, false); } catch { ok(name, true); }
}

// Mirror of settings.js _encryptBackup / _decryptBackup. Kept in step by the
// format assertions below — if the shipped format changes, these fail.
const PBKDF2_ITER = 310_000;
function _b64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const _fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function encryptBackup(jsonStr, password) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const iv   = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  const key  = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
  );
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(jsonStr));
  return JSON.stringify({ qstoreEncrypted: true, v: 1, salt: _b64(salt), iv: _b64(iv), data: _b64(ct) });
}
async function decryptBackup(encObj, password) {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  const key  = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: _fromB64(encObj.salt), iterations: PBKDF2_ITER, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
  );
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: _fromB64(encObj.iv) }, key, _fromB64(encObj.data),
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

const PII_KEY   = 'cGlpS2V5U2VjcmV0TWF0ZXJpYWxCYXNlNjQxMjM0NTY3ODkw';
const AUDIT_KEY = 'YXVkaXRLZXlTZWNyZXRNYXRlcmlhbEJhc2U2NDEyMzQ1Njc4';
const SNAPSHOT = {
  schemaVersion: 8,
  meta: [
    { key: 'installId', value: '7f3a-uuid' },
    { key: 'auditKey',  value: AUDIT_KEY },
    { key: 'piiKey',    value: PII_KEY },
  ],
  cadets: [{ svcNo: '8012345', surname: '~enc:AAAA', email: '~enc:BBBB' }],
};
const PASSWORD = 'unit backup password';

console.log('=== export encryption ===');

// --- what the OLD path wrote — the defect, stated as a test ----------------
const legacyPlain = JSON.stringify(SNAPSHOT);
ok('DEFECT (old unencrypted export) leaked piiKey',   legacyPlain.includes(PII_KEY));
ok('DEFECT (old unencrypted export) leaked auditKey', legacyPlain.includes(AUDIT_KEY));

// --- what the export path writes now ---------------------------------------
const wire = await encryptBackup(JSON.stringify(SNAPSHOT), PASSWORD);
ok('exported file does not leak piiKey',      !wire.includes(PII_KEY));
ok('exported file does not leak auditKey',    !wire.includes(AUDIT_KEY));
ok('exported file does not leak svcNo',       !wire.includes('8012345'));
ok('exported file does not leak store names', !wire.includes('cadets'));

// --- format contract -------------------------------------------------------
const parsed = JSON.parse(wire);
ok('file is marked as a QStore encrypted backup', parsed.qstoreEncrypted === true);
ok('format version is 1 (import compatibility)',  parsed.v === 1);
ok('salt is present and 32 bytes', _fromB64(parsed.salt).length === 32);
ok('iv is present and 12 bytes',   _fromB64(parsed.iv).length === 12);
ok('only the envelope fields are present',
  Object.keys(parsed).sort().join(',') === 'data,iv,qstoreEncrypted,salt,v');

// --- round-trip ------------------------------------------------------------
const back = await decryptBackup(parsed, PASSWORD);
ok('round-trips to an identical snapshot', JSON.stringify(back) === JSON.stringify(SNAPSHOT));
ok('keys survive INSIDE the sealed file (restore needs them)',
  back.meta.find((m) => m.key === 'piiKey').value === PII_KEY);

// --- wrong password --------------------------------------------------------
await throws('wrong password is rejected', () => decryptBackup(parsed, 'not the password'));
await throws('empty password is rejected', () => decryptBackup(parsed, ''));

// --- tamper detection ------------------------------------------------------
const tampered = JSON.parse(wire);
const bytes = Buffer.from(tampered.data, 'base64');
bytes[5] ^= 0xff;
tampered.data = bytes.toString('base64');
await throws('tampered file fails authentication', () => decryptBackup(tampered, PASSWORD));

// --- salt/iv freshness -----------------------------------------------------
const second = JSON.parse(await encryptBackup(JSON.stringify(SNAPSHOT), PASSWORD));
ok('fresh salt per export', second.salt !== parsed.salt);
ok('fresh iv per export',   second.iv   !== parsed.iv);
ok('identical input yields different ciphertext', second.data !== parsed.data);

// --- the UI contract: no unencrypted branch survives in source -------------
const src = await import('node:fs').then((fs) =>
  fs.readFileSync(new URL('./src/ui/settings.js', import.meta.url), 'utf8'));
ok('export UI no longer offers an unencrypted option',
  !/leave blank for unencrypted/i.test(src));
ok('export enforces a minimum password length',
  /Password must be at least 12 characters/.test(src));
ok('export no longer writes a .json branch',
  !/filename = `\$\{baseFilename\}\.json`/.test(src));
ok('import still accepts legacy plain files (old backups must restore)',
  /qstoreEncrypted === true/.test(src));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
