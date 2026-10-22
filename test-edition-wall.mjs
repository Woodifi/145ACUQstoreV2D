// =============================================================================
// Edition wall — the cadet edition defends its own data
// =============================================================================
//
// Every Itemora edition opened from disk shares ONE browser storage area:
// file:// is a single origin in Chromium and Firefox alike (measured
// 2026-10-23 with two files in different folders — each saw the other's
// localStorage and IndexedDB). The Itemora (consumer) edition now keeps to its
// own names. This suite proves the cadet edition does not depend on that:
//
//   [0] a `qstore` database another application has written to is refused —
//       not opened, not upgraded, not written — whatever shape the change took;
//       another edition's database name is never opened
//   [1] a session this database did not issue is never honoured, though every
//       edition creates `usr-default-co` and the May 2026 Itemora unit builds
//       write this edition's own sessionStorage key
//   [2] a cloud file this edition did not write is never imported and never
//       replaced; this edition's own files are tagged
//   [3] sessionScope never travels in a backup
//   [4] every browser-storage name goes through storageKey(), so a V2L
//       learning build can never write the cadet's names
//   [5] other editions are detected by NAME, without opening their databases

import 'fake-indexeddb/auto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
for (const name of ['localStorage', 'sessionStorage']) {
  const m = new Map();
  globalThis[name] = {
    getItem(k) { return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { m.set(k, String(v)); },
    removeItem(k) { m.delete(k); }, clear() { m.clear(); },
  };
}

const Storage = await import('./src/storage.js');
const AUTH    = await import('./src/auth.js');
const Cloud   = await import('./src/cloud.js');
const Sync    = await import('./src/sync.js');
const Keyring = await import('./src/sync-keyring.js');
const Edition = await import('./src/edition.js');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
async function caught(fn) { try { await fn(); return null; } catch (e) { return e; } }

/** Create a database with these stores at this version, holding one marker row. */
function makeDb(name, version, stores) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = () => { for (const s of stores) req.result.createObjectStore(s, { keyPath: 'id' }); };
    req.onsuccess = () => {
      const tx = req.result.transaction(stores[0], 'readwrite');
      tx.objectStore(stores[0]).put({ id: 'marker', from: 'another application' });
      tx.oncomplete = () => { req.result.close(); resolve(); };
    };
    req.onerror = () => reject(req.error);
  });
}
function describeDb(name) {
  return new Promise((resolve) => {
    const req = indexedDB.open(name);
    req.onsuccess = () => {
      const db = req.result;
      const out = { version: db.version, stores: [...db.objectStoreNames].sort() };
      db.close();
      resolve(out);
    };
  });
}

// The cadet edition's own stores at version 5, as STORES lists them.
const OWN = Object.values(Storage.STORES);
// What the May 2026 Itemora unit builds add when they open `qstore`.
const ITEMORA_ONLY = ['events', 'devices', 'syncMeta', 'accounts', 'transactions'];

// -----------------------------------------------------------------------------
console.log('\n[0] a cadet database another application changed is refused, untouched');
// -----------------------------------------------------------------------------
{
  // (a) upgraded past this edition's version — an Itemora build at v9
  await makeDb('qstore_wall_a', 9, [...OWN, ...ITEMORA_ONLY]);
  let err = await caught(() => Storage.init({ dbName: 'qstore_wall_a' }));
  ok('(a) a newer-version database is refused', err?.name === 'ForeignDatabaseError', err?.message);
  ok('(a) …and left at version 9', (await describeDb('qstore_wall_a')).version === 9);

  // (b) an older database another app added stores to — the upgrade must abort
  await makeDb('qstore_wall_b', 3, ['meta', 'items', 'events']);
  err = await caught(() => Storage.init({ dbName: 'qstore_wall_b' }));
  ok('(b) a database holding a store this edition never made is refused', err?.name === 'ForeignDatabaseError', err?.message);
  ok('(b) …naming the store', /events/.test(err?.message || ''));
  const b = await describeDb('qstore_wall_b');
  ok('(b) …and the upgrade was aborted: still version 3, same stores',
    b.version === 3 && JSON.stringify(b.stores) === '["events","items","meta"]', JSON.stringify(b));

  // (c) same version as this edition, one extra store — refused on the plain open
  await makeDb('qstore_wall_c', 5, [...OWN, 'accounts']);
  err = await caught(() => Storage.init({ dbName: 'qstore_wall_c' }));
  ok('(c) an extra store at this edition\'s own version is refused', err?.name === 'ForeignDatabaseError', err?.message);

  // another edition's database is never opened at all
  for (const name of ['itemora', 'Itemora', 'itemora_test']) {
    ok(`isOtherEditionDbName('${name}')`, Storage.isOtherEditionDbName(name));
  }
  ok('not another edition: qstore', !Storage.isOtherEditionDbName('qstore'));
  err = await caught(() => Storage.init({ dbName: 'itemora' }));
  ok('init({ dbName: "itemora" }) throws', !!err && /another Itemora edition/.test(err.message), err?.message);

  // positive controls: a fresh database and this edition's own database open
  ok('a fresh database opens', !(await caught(() => Storage.init({ dbName: 'qstore_wall_fresh' }))));
  ok('…with exactly this edition\'s stores',
    JSON.stringify((await describeDb('qstore_wall_fresh')).stores) === JSON.stringify([...OWN].sort()));
  await Storage.init({ dbName: 'qstore_wall_reopen' });
  await Storage.init({ dbName: 'qstore_wall_fresh' });
  ok('this edition\'s own database reopens', !(await caught(() => Storage.init({ dbName: 'qstore_wall_reopen' }))));
}

await Storage.init({ dbName: 'qstore_wall_main' });
await AUTH.init();
await AUTH.ensureDefaultAdmin();   // usr-default-co / 0000 — the same id every edition creates

// -----------------------------------------------------------------------------
console.log('\n[1] a session this database did not issue is never honoured');
// -----------------------------------------------------------------------------
{
  const KEY = 'qstore_session';
  // Exactly what the May 2026 Itemora unit builds leave in this key.
  const foreign = JSON.stringify({ userId: 'usr-default-co', username: 'admin', role: 'co', loginAt: new Date().toISOString() });
  sessionStorage.setItem(KEY, foreign);
  const fresh = await import('./src/auth.js?wall=1');
  ok('a scopeless session with the default admin\'s id and role: NOT signed in', (await fresh.init()) === null);
  ok('…and it is cleared', sessionStorage.getItem(KEY) === null);

  const r = await AUTH.login('usr-default-co', '0000');
  ok('a real PIN sign-in works', r.ok === true, JSON.stringify(r));
  const stored = JSON.parse(sessionStorage.getItem(KEY) || 'null');
  ok('the session carries this database\'s scope', !!stored?.scope && stored.scope === await Storage.getSessionScope());
  const again = await import('./src/auth.js?wall=2');
  ok('…and restores', (await again.init())?.userId === 'usr-default-co');

  sessionStorage.setItem(KEY, JSON.stringify({ ...stored, scope: 'another-database' }));
  const third = await import('./src/auth.js?wall=3');
  ok('a session scoped to another database is refused', (await third.init()) === null);
  await AUTH.logout();
}

// -----------------------------------------------------------------------------
console.log('\n[2] a cloud file this edition did not write is never imported or replaced');
// -----------------------------------------------------------------------------
{
  const O = Sync.cloudFileOwner;
  ok('owner: own sealed envelope', O({ qstoreEnvelope: true, v: 2, iv: 'a', data: 'b', slots: [] }) === 'self');
  ok('owner: own tagged envelope', O({ qstoreEnvelope: true, v: 2, edition: 'cadet' }) === 'self');
  ok('owner: own legacy unsealed snapshot', O({ schemaVersion: 4, items: [], cadets: [] }) === 'self');
  ok('owner: Itemora journal (schemaVersion 4 + format)', O({ format: 'v3events', schemaVersion: 4, events: [] }) === 'other');
  ok('owner: Itemora tagged journal', O({ format: 'v3events', edition: 'itemora', events: [] }) === 'other');
  ok('owner: learning edition', O({ qstoreEnvelope: true, v: 2, edition: 'cadet-learning' }) === 'other');
  ok('owner: Itemora encrypted blob', O({ v3enc: true, salt: 'x', iv: 'y', data: 'z' }) === 'unknown');
  ok('owner: nothing recognisable', O(null) === 'unknown' && O({ a: 1 }) === 'unknown');

  let cloud = null, writes = 0;
  Cloud._setProvider({
    async init() {},
    isSignedIn() { return true; },
    getAccount() { return { username: 'tester' }; },
    getStatusInfo() { return { state: 'signed-in', lastError: null }; },
    async read() { return cloud ? JSON.parse(JSON.stringify(cloud)) : null; },
    async write(d) { writes++; cloud = JSON.parse(JSON.stringify(d)); },
  });
  await Keyring.setup('a long enough unit sync passphrase');

  await Storage.items.put({ id: 'unit-item', name: 'Unit webbing', qty: 4 });
  // An Itemora journal — plaintext, and it HAS a schemaVersion, which is how
  // the old code took it for a legacy cadet snapshot and imported it.
  const itemoraJournal = { format: 'v3events', schemaVersion: 4, events: [{ id: 'e1', entityType: 'item' }], pushedBy: 'someone' };
  cloud = JSON.parse(JSON.stringify(itemoraJournal));

  const load = await Sync.loadFromCloud();
  ok('"Load from cloud" refuses the Itemora journal', load.ok === false && load.error?.name === 'ForeignCloudFileError', load.error?.message);
  ok('…and the cadet data was not wiped', (await Storage.items.get('unit-item'))?.name === 'Unit webbing');

  const pushErr = await caught(() => Sync.syncNow());
  ok('a push onto the Itemora journal is refused', pushErr?.name === 'ForeignCloudFileError', pushErr?.message);
  ok('…nothing was written', writes === 0);
  ok('…the file is byte-for-byte as Itemora wrote it', JSON.stringify(cloud) === JSON.stringify(itemoraJournal));

  // positive controls
  cloud = null;
  await Sync.syncNow();
  ok('with no cloud file, a push writes this edition\'s envelope', writes === 1 && cloud?.qstoreEnvelope === true);
  ok('…tagged outside the ciphertext', cloud?.edition === 'cadet');
  await Sync.syncNow();
  ok('a push onto this edition\'s own file is allowed', writes === 2);
  const back = await Sync.loadFromCloud();
  ok('…and "Load from cloud" restores it', back.ok === true && back.imported === true, back.error?.message);
  ok('…with the data intact', (await Storage.items.get('unit-item'))?.qty === 4);
}

// -----------------------------------------------------------------------------
console.log('\n[3] sessionScope never travels in a backup');
// -----------------------------------------------------------------------------
{
  const scope = await Storage.getSessionScope();
  const snap = await Storage.exportAll();
  ok('a backup does not carry sessionScope', !(snap.meta || []).some((m) => m.key === 'sessionScope'));
  snap.meta = [...(snap.meta || []), { key: 'sessionScope', value: 'adopted-from-a-backup' }];
  await Storage.importAll(snap);
  ok('restoring one that names a sessionScope keeps this database\'s own', (await Storage.getSessionScope()) === scope);
}

// -----------------------------------------------------------------------------
console.log('\n[4] every browser-storage name goes through storageKey()');
// -----------------------------------------------------------------------------
{
  ok('the cadet build is the cadet edition', Edition.EDITION === 'cadet' && Edition.SANDBOX === false);
  ok('storageKey is the identity for the cadet build — no field data moves',
    Edition.storageKey('qstore2_logo') === 'qstore2_logo');

  const files = [];
  (function walk(dir) {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      // edition.js is the one place names are made (it holds the V2L prefix).
      if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js') && !p.endsWith('edition.js')) files.push(p);
    }
  })('src');
  const raw = [];
  for (const f of files) {
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((l, i) => {
      if (/^\s*(\/\/|\*)/.test(l)) return;
      // A storage name written as a bare literal bypasses storageKey().
      if (/(local|session)Storage\.(getItem|setItem|removeItem)\(\s*['"`]/.test(l)) raw.push(`${f}:${i + 1}`);
      if (/=\s*['"]qstore[a-z0-9_]*['"]\s*;/.test(l) && !/DB_NAME|dbName/.test(l)) raw.push(`${f}:${i + 1}`);
    });
  }
  ok(`no raw storage-name literal in ${files.length} source files`, raw.length === 0, raw.join(', '));
}

// -----------------------------------------------------------------------------
console.log('\n[5] other editions are detected by name, never opened');
// -----------------------------------------------------------------------------
{
  ok('no other edition yet', (await Storage.otherEditionDatabases()).length === 0,
    JSON.stringify(await Storage.otherEditionDatabases()));
  await makeDb('itemora', 9, ['meta', 'events']);
  const found = await Storage.otherEditionDatabases();
  ok('an Itemora database is detected', found.includes('itemora'), JSON.stringify(found));
  ok('…and was not opened or changed', (await describeDb('itemora')).version === 9);
  ok('this edition\'s own and test databases are not reported',
    !found.some((n) => n.startsWith('qstore_wall')));
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
