// Cadet data minimisation — email and notes removed from cadet records.
//
// Removing the fields from the schema and the form only stops NEW collection.
// The values already in a unit's database survive unless something deletes
// them — encrypted, unreachable from the UI, and still present in every export
// and backup. Dead PII you cannot see is worse than PII you can, because nobody
// remembers it is there.
//
// `notes` is the field this is really about: free text about a child, which in
// practice accumulates health and behavioural information — sensitive
// information under the Privacy Act, and never needed to track equipment.

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

const PII = await import('./src/pii.js');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else      { fail++; console.error(`  FAIL ${name}`); }
}

function rawRead(storeName) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('qstore');
    open.onsuccess = () => {
      const db = open.result;
      const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
      req.onsuccess = () => { resolve(req.result); db.close(); };
      req.onerror = () => reject(req.error);
    };
    open.onerror = () => reject(open.error);
  });
}

console.log('=== cadet data minimisation ===');

// --- the PII field list no longer names email/notes ------------------------
ok('PII_FIELDS_CADETS is surname+given only',
  JSON.stringify(PII.PII_FIELDS_CADETS) === JSON.stringify(['surname', 'given']));
ok('cadets no longer carry email', !PII.PII_FIELDS_CADETS.includes('email'));
ok('cadets no longer carry notes', !PII.PII_FIELDS_CADETS.includes('notes'));
ok('STAFF (adults) still carry email', PII.PII_FIELDS_STAFF.includes('email'));
ok('STAFF (adults) still carry notes', PII.PII_FIELDS_STAFF.includes('notes'));

// --- seed a legacy record the way a pre-change build would have -------------
// Written directly, bypassing storage.js, so it looks exactly like a record
// created before the field removal: encrypted email and notes present.
const Storage = await import('./src/storage.js');
await Storage.init();

const legacyEmail = 'cadet.parent@example.test';
const legacyNotes = 'Asthma — inhaler in CQ office. Parents separated.';
await PII.init(await (async () => {
  const rows = await rawRead('meta');
  return rows.find((r) => r.key === 'piiKey').value;
})());

await new Promise((resolve, reject) => {
  const open = indexedDB.open('qstore');
  open.onsuccess = async () => {
    const db = open.result;
    const rec = await PII.encryptRecord({
      svcNo: '8012345', rank: 'CDT', surname: 'Wodehouse', given: 'Alice',
      email: legacyEmail, notes: legacyNotes, active: true,
    }, ['surname', 'given', 'email', 'notes']);   // the OLD field list
    const tx = db.transaction('cadets', 'readwrite');
    tx.objectStore('cadets').put(rec);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  };
  open.onerror = () => reject(open.error);
});

const before = (await rawRead('cadets')).find((r) => r.svcNo === '8012345');
ok('legacy record really has email at rest', typeof before.email === 'string' && before.email.length > 0);
ok('legacy record really has notes at rest', typeof before.notes === 'string' && before.notes.length > 0);

// --- a fresh page load runs the migration ----------------------------------
// storage.js de-dupes init() via a module-level _initPromise, so calling init()
// twice in one process is a no-op. A real unit gets the migration on next page
// load, i.e. fresh module state — reproduced here with a cache-busted import.
const Storage2 = await import('./src/storage.js?reload=1');
await Storage2.init();

const after = (await rawRead('cadets')).find((r) => r.svcNo === '8012345');
ok('migration removes email from the record', !('email' in after));
ok('migration removes notes from the record', !('notes' in after));

// The load-bearing assertion: the values must be GONE from the stored bytes,
// not merely hidden from the UI.
const wire = JSON.stringify(after);
ok('no residual email ciphertext on the record', !/email/i.test(wire));
ok('no residual notes ciphertext on the record', !/notes/i.test(wire));

// --- everything operational survives ---------------------------------------
ok('svcNo survives', after.svcNo === '8012345');
ok('rank survives', after.rank === 'CDT');
ok('active flag survives', after.active === true);
const roundTripped = await PII.decryptRecord({ ...after }, PII.PII_FIELDS_CADETS);
ok('surname still decrypts', roundTripped.surname === 'Wodehouse');
ok('given name still decrypts', roundTripped.given === 'Alice');

// --- idempotent: a second run is a no-op -----------------------------------
const Storage3 = await import('./src/storage.js?reload=2');
await Storage3.init();
const third = (await rawRead('cadets')).find((r) => r.svcNo === '8012345');
ok('migration is idempotent', !('email' in third) && !('notes' in third)
  && third.svcNo === '8012345');

// --- new records cannot reintroduce the fields -----------------------------
await Storage3.cadets.put({ svcNo: '8012999', rank: 'LCPL', surname: 'Brontë', given: 'Emily', active: true });
const fresh = (await rawRead('cadets')).find((r) => r.svcNo === '8012999');
ok('a newly written cadet has no email field', !('email' in fresh));
ok('a newly written cadet has no notes field', !('notes' in fresh));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
