// Key rotation tests — Storage.rotateKeys()
//
// Rotation exists because pre-fix builds shipped piiKey and auditKey inside
// every snapshot pushed to OneDrive. Enabling the envelope does NOT help data
// already protected by a leaked key — it seals the same burnt keys in a new
// wrapper. These tests pin the three things that must hold:
//
//   1. PII survives the round-trip intact (a rotation that eats cadet records
//      is worse than the bug).
//   2. The OLD piiKey genuinely stops working — otherwise nothing was retired.
//   3. The audit chain still verifies afterwards, and the honesty marker lands.

import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.Blob) {
  const { Blob: NodeBlob } = await import('node:buffer');
  globalThis.Blob = NodeBlob;
}
if (!globalThis.localStorage) {
  const map = new Map();
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

const Storage = await import('./src/storage.js');
const PII     = await import('./src/pii.js');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else      { fail++; console.error(`  FAIL ${name}`); }
}

// Read the DB directly — deliberately NOT via test-only exports on storage.js.
// Production code shouldn't grow hooks just so a test can peek at ciphertext.
function rawRead(storeName) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('qstore');
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => { resolve(req.result); db.close(); };
      req.onerror = () => reject(req.error);
    };
    open.onerror = () => reject(open.error);
  });
}
async function metaValue(key) {
  const rows = await rawRead('meta');
  return rows.find((r) => r.key === key)?.value;
}

console.log('=== key rotation ===');

await Storage.init();

// --- seed realistic PII -----------------------------------------------------
// STAFF, not cadets. This build stores no cadet records (Storage.cadets.put
// refuses), but rotation still has to work: staff and user accounts are adults
// and remain PII-encrypted pending HQ's answer on whether "no PII" covers them.
// Rotation matters exactly as much for their data as it did for cadets'.
await Storage.staff.put({
  svcNo: '8012345', surname: 'Wodehouse', given: 'Alice',
  email: 'alice@example.test', notes: 'Key holder, CQ store', rank: 'CAPT-AAC',
});
await Storage.staff.put({
  svcNo: '8012346', surname: 'Brontë', given: 'Emily',
  email: 'emily@example.test', notes: '', rank: 'LT-AAC',
});
await Storage.audit.append({ action: 'item_add', user: 'QM', desc: 'Seeded item' });
await Storage.audit.append({ action: 'issue',    user: 'QM', desc: 'Issued boots' });

const oldPiiB64 = await metaValue('piiKey');
const oldAudB64 = await metaValue('auditKey');
ok('pre-rotation piiKey exists', typeof oldPiiB64 === 'string' && oldPiiB64.length > 0);
ok('audit chain verifies before rotation', (await Storage.audit.verify()).ok);

// Prove the data really is encrypted at rest, so the rest of the test means
// something.
const rawBefore = await rawRead('staff');
const beforeC1  = rawBefore.find((r) => r.svcNo === '8012345');
ok('staff surname is ciphertext at rest', String(beforeC1.surname).startsWith('~enc:'));

// --- rotate ----------------------------------------------------------------
const result = await Storage.rotateKeys({ reason: 'test rotation' });
ok('rotation reports records re-encrypted', result.records === 2);
ok('rotation reports audit entries re-signed', result.auditEntries === 2);

// --- 1. PII survived -------------------------------------------------------
const c1 = await Storage.staff.get('8012345');
ok('surname survives rotation', c1.surname === 'Wodehouse');
ok('given name survives rotation', c1.given === 'Alice');
ok('email survives rotation', c1.email === 'alice@example.test');
ok('notes survive rotation', c1.notes === 'Key holder, CQ store');
ok('non-PII field untouched', c1.rank === 'CAPT-AAC');
const c2 = await Storage.staff.get('8012346');
ok('second record survives (non-ASCII)', c2.surname === 'Brontë');
ok('empty PII field stays empty', c2.notes === '');

// --- 2. keys actually changed, old key is dead -----------------------------
const newPiiB64 = await metaValue('piiKey');
const newAudB64 = await metaValue('auditKey');
ok('piiKey changed', newPiiB64 !== oldPiiB64);
ok('auditKey changed', newAudB64 !== oldAudB64);

const rawAfter = await rawRead('staff');
const afterC1  = rawAfter.find((r) => r.svcNo === '8012345');
ok('still ciphertext at rest after rotation', String(afterC1.surname).startsWith('~enc:'));
ok('ciphertext actually changed', afterC1.surname !== beforeC1.surname);

// The load-bearing assertion: re-init PII with the OLD key and confirm the
// leaked key can no longer read the record. If this passes with the old key,
// rotation retired nothing.
await PII.init(oldPiiB64);
let oldKeyReadable = false;
try {
  const viaOld = await PII.decryptRecord({ ...afterC1 }, PII.PII_FIELDS_STAFF);
  oldKeyReadable = viaOld.surname === 'Wodehouse';
} catch { oldKeyReadable = false; }
ok('OLD piiKey can no longer decrypt records', !oldKeyReadable);

// Restore the live key so the rest of the assertions work.
await PII.init(newPiiB64);
ok('new piiKey reads records', (await Storage.staff.get('8012345')).surname === 'Wodehouse');

// --- 3. audit chain re-signed and marked -----------------------------------
ok('audit chain verifies after rotation', (await Storage.audit.verify()).ok);

const rows = await Storage.audit.list();   // newest first
const marker = rows.find((r) => r.action === 'keys_rotated');
ok('rotation marker written', !!marker);
ok('marker is the newest entry', rows[0]?.action === 'keys_rotated');
ok('marker states integrity is NOT assured for prior entries',
  /NOT cryptographically assured/i.test(marker?.desc || ''));
ok('marker records the reason', /test rotation/.test(marker?.desc || ''));
ok('pre-rotation entries still present', rows.some((r) => r.desc === 'Issued boots'));

// --- appends after rotation stay on-chain ----------------------------------
await Storage.audit.append({ action: 'return', user: 'QM', desc: 'Post-rotation entry' });
ok('chain still verifies after a fresh append', (await Storage.audit.verify()).ok);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
