// Envelope encryption tests — src/backup-crypto.js
//
// The test that matters most is "no key material in the serialised envelope".
// The original defect was exactly that: exportAll() emitted META (piiKey +
// auditKey) and sync pushed it to OneDrive as plain JSON, so the blob carried
// the key that decrypted it. Nothing failed, because nothing looked.

import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

import {
  newBlobKey, wrapKey, unwrapKey, sealEnvelope, openEnvelope, openWithBlobKey,
  isEnvelope, SLOT_PASSPHRASE, SLOT_RECOVERY,
} from './src/backup-crypto.js';

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else      { fail++; console.error(`  FAIL ${name}`); }
}
async function throws(name, fn) {
  try { await fn(); ok(name, false); }
  catch { ok(name, true); }
}

// A snapshot shaped like the real thing: META carrying the keys, cadets
// carrying ~enc: ciphertext.
const PII_KEY   = 'cGlpS2V5U2VjcmV0TWF0ZXJpYWxCYXNlNjQxMjM0NTY3ODkw';
const AUDIT_KEY = 'YXVkaXRLZXlTZWNyZXRNYXRlcmlhbEJhc2U2NDEyMzQ1Njc4';
const SNAPSHOT = {
  schemaVersion: 8,
  meta: [
    { key: 'installId', value: '7f3a-uuid' },
    { key: 'auditKey',  value: AUDIT_KEY },
    { key: 'piiKey',    value: PII_KEY },
  ],
  cadets: [{ id: 'c1', svcNo: '8012345', surname: '~enc:AAAA', given: '~enc:BBBB' }],
};

const PASSPHRASE = 'correct horse battery staple';
const RECOVERY   = 'H4KQ-9WT-MZP2XR';

console.log('=== backup-crypto ===');

// --- setup: one blob key, two independent slots -----------------------------
const bk = newBlobKey();
ok('blob key is 256-bit', bk.length === 32);

const slotPass = await wrapKey(bk, PASSPHRASE, SLOT_PASSPHRASE);
const slotRec  = await wrapKey(bk, RECOVERY, SLOT_RECOVERY);
const envelope = await sealEnvelope(SNAPSHOT, bk, [slotPass, slotRec]);

ok('isEnvelope recognises a sealed envelope', isEnvelope(envelope));
ok('envelope declares two slots', envelope.slots.length === 2);

// --- THE REGRESSION TEST ---------------------------------------------------
// Serialise exactly as sync.js would before PUTting to OneDrive.
const wire = JSON.stringify(envelope);
ok('serialised envelope does not leak piiKey',   !wire.includes(PII_KEY));
ok('serialised envelope does not leak auditKey', !wire.includes(AUDIT_KEY));
ok('serialised envelope does not leak svcNo',    !wire.includes('8012345'));
ok('serialised envelope does not leak store names', !wire.includes('cadets'));

// --- both slots open it ----------------------------------------------------
const viaPass = await openEnvelope(envelope, PASSPHRASE);
ok('passphrase slot recovers payload', viaPass.payload.cadets[0].svcNo === '8012345');
ok('passphrase slot reports its type', viaPass.slotType === SLOT_PASSPHRASE);

const viaRec = await openEnvelope(envelope, RECOVERY);
ok('recovery slot recovers payload', viaRec.payload.meta.find(m => m.key === 'piiKey').value === PII_KEY);
ok('recovery slot reports its type', viaRec.slotType === SLOT_RECOVERY);
ok('both slots yield the same blob key',
  Buffer.from(viaPass.blobKey).equals(Buffer.from(viaRec.blobKey)));

// --- slots are independent -------------------------------------------------
ok('recovery code does not unwrap the passphrase slot',
  (await unwrapKey(slotPass, RECOVERY)) === null);
ok('passphrase does not unwrap the recovery slot',
  (await unwrapKey(slotRec, PASSPHRASE)) === null);
ok('slots use distinct salts', slotPass.salt !== slotRec.salt);
ok('slots use distinct IVs', slotPass.iv !== slotRec.iv);

// --- wrong secrets ---------------------------------------------------------
await throws('wrong passphrase is rejected', () => openEnvelope(envelope, 'wrong passphrase'));
await throws('empty secret is rejected', () => openEnvelope(envelope, ''));
await throws('near-miss recovery code is rejected', () => openEnvelope(envelope, 'H4KQ-9WT-MZP2XQ'));

// --- tamper detection (AES-GCM auth tag) -----------------------------------
const tampered = JSON.parse(wire);
const bytes = Buffer.from(tampered.data, 'base64');
bytes[10] ^= 0xff;
tampered.data = bytes.toString('base64');
await throws('tampered ciphertext fails authentication', () => openEnvelope(tampered, PASSPHRASE));

const tamperedSlot = JSON.parse(wire);
const sb = Buffer.from(tamperedSlot.slots[0].wrapped, 'base64');
sb[3] ^= 0xff;
tamperedSlot.slots[0].wrapped = sb.toString('base64');
await throws('tampered keyslot fails authentication',
  () => openEnvelope({ ...tamperedSlot, slots: [tamperedSlot.slots[0]] }, PASSPHRASE));

// --- IV reuse: fresh IV per seal under a stable blob key --------------------
const again = await sealEnvelope(SNAPSHOT, bk, [slotPass, slotRec]);
ok('fresh IV on every seal', again.iv !== envelope.iv);
ok('same blob key still opens a later seal',
  (await openWithBlobKey(again, bk)).schemaVersion === 8);

// --- non-envelope input ----------------------------------------------------
ok('isEnvelope rejects a bare snapshot', !isEnvelope(SNAPSHOT));
ok('isEnvelope rejects null', !isEnvelope(null));
await throws('openEnvelope rejects a bare snapshot', () => openEnvelope(SNAPSHOT, PASSPHRASE));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
