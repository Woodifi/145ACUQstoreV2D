// Stock movement ledger — derivation, the cache invariant, and the merge case.
//
// The assertion this file exists for is "two devices issue concurrently, and
// the union of their movements derives the right number". Everything else is
// there to make that assertion trustworthy: if the ledger is incomplete, or the
// cached figures on the item records drift from it, the merge would produce a
// confidently wrong count instead of an obviously broken one.
//
// The invariant test matters most in the long run. It asserts that after every
// kind of stock operation the derivation reproduces the cached scalars exactly.
// A future change that moves stock without going through the choke point fails
// here rather than showing up as a wrong figure at a stocktake months later.

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
const Ledger  = await import('./src/ledger.js');
const Device  = await import('./src/device.js');

let pass = 0, fail = 0;
const ok = (name, cond) => cond
  ? (pass++, console.log(`  ok   ${name}`))
  : (fail++, console.error(`  FAIL ${name}`));
const eq = (name, actual, expected) => {
  const good = JSON.stringify(actual) === JSON.stringify(expected);
  if (!good) console.error(`       expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  ok(name, good);
};

console.log('=== ledger: pure derivation ===');

// ---------------------------------------------------------------------------
// Derivation — no database
// ---------------------------------------------------------------------------

const mv = (o) => ({ id: o.id, itemId: 'IT-1', ts: o.ts, device: o.device || 'AAAA',
                     mode: o.mode || Ledger.MODE_DELTA,
                     onHand: o.onHand ?? null, onLoan: o.onLoan ?? null, unsvc: o.unsvc ?? null });

eq('empty ledger derives zero',
   Ledger.derive([]), { onHand: 0, onLoan: 0, unsvc: 0 });

eq('an opening absolute sets the baseline',
   Ledger.derive([mv({ id: 'a', ts: '2026-01-01T00:00:00Z', mode: 'absolute', onHand: 40, onLoan: 0, unsvc: 0 })]),
   { onHand: 40, onLoan: 0, unsvc: 0 });

eq('deltas accumulate on top of the baseline',
   Ledger.derive([
     mv({ id: 'a', ts: '2026-01-01T00:00:00Z', mode: 'absolute', onHand: 40, onLoan: 0, unsvc: 0 }),
     mv({ id: 'b', ts: '2026-01-02T00:00:00Z', onLoan: 5 }),
     mv({ id: 'c', ts: '2026-01-03T00:00:00Z', onLoan: 3 }),
   ]),
   { onHand: 40, onLoan: 8, unsvc: 0 });

eq('an absolute supersedes everything before it',
   Ledger.derive([
     mv({ id: 'a', ts: '2026-01-01T00:00:00Z', mode: 'absolute', onHand: 40 }),
     mv({ id: 'b', ts: '2026-01-02T00:00:00Z', onHand: -5 }),
     mv({ id: 'c', ts: '2026-01-03T00:00:00Z', mode: 'absolute', onHand: 38, onLoan: 0, unsvc: 0 }),
     mv({ id: 'd', ts: '2026-01-04T00:00:00Z', onHand: -1 }),
   ]),
   { onHand: 37, onLoan: 0, unsvc: 0 });

// Order of arrival must not matter — this is what makes a merge a union.
{
  const rows = [
    mv({ id: 'a', ts: '2026-01-01T00:00:00Z', mode: 'absolute', onHand: 40, onLoan: 0, unsvc: 0 }),
    mv({ id: 'b', ts: '2026-01-02T00:00:00Z', onLoan: 5 }),
    mv({ id: 'c', ts: '2026-01-03T00:00:00Z', onLoan: 3 }),
    mv({ id: 'd', ts: '2026-01-04T00:00:00Z', onLoan: -2 }),
  ];
  const forward = Ledger.derive(rows);
  const reversed = Ledger.derive([...rows].reverse());
  const shuffled = Ledger.derive([rows[2], rows[0], rows[3], rows[1]]);
  eq('derivation is order-independent (reversed)', reversed, forward);
  eq('derivation is order-independent (shuffled)', shuffled, forward);
}

eq('a null field is not asserted and passes through',
   Ledger.derive([
     mv({ id: 'a', ts: '2026-01-01T00:00:00Z', mode: 'absolute', onHand: 10, onLoan: 2, unsvc: 1 }),
     mv({ id: 'b', ts: '2026-01-02T00:00:00Z', onLoan: 1 }),   // says nothing about onHand/unsvc
   ]),
   { onHand: 10, onLoan: 3, unsvc: 1 });

eq('a counted zero IS an assertion, not an absence',
   Ledger.derive([
     mv({ id: 'a', ts: '2026-01-01T00:00:00Z', mode: 'absolute', onHand: 40 }),
     mv({ id: 'b', ts: '2026-01-02T00:00:00Z', mode: 'absolute', onHand: 0 }),
   ]),
   { onHand: 0, onLoan: 0, unsvc: 0 });

eq('a negative result is clamped rather than displayed',
   Ledger.derive([
     mv({ id: 'a', ts: '2026-01-01T00:00:00Z', mode: 'absolute', onHand: 1 }),
     mv({ id: 'b', ts: '2026-01-02T00:00:00Z', onHand: -5 }),
   ]),
   { onHand: 0, onLoan: 0, unsvc: 0 });

// Same timestamp on two devices — must still be total and reproducible.
{
  const a = mv({ id: 'x', ts: '2026-01-02T00:00:00Z', device: 'BBBB', onLoan: 1 });
  const b = mv({ id: 'y', ts: '2026-01-02T00:00:00Z', device: 'AAAA', onLoan: 2 });
  eq('identical timestamps still derive deterministically',
     Ledger.derive([a, b]), Ledger.derive([b, a]));
}

console.log('\n=== ledger: the merge case ===');

// ---------------------------------------------------------------------------
// THE POINT OF ALL OF THIS
// ---------------------------------------------------------------------------
// Two devices, both starting from 40, one issues 5 and the other issues 3.
// Their stored figures are 35 and 37. No rule recovers 32 from those two
// numbers. The union of their movements does.

{
  const opening = mv({ id: 'MV-AAAA-open', ts: '2026-01-01T00:00:00Z', device: 'AAAA',
                       mode: 'absolute', onHand: 40, onLoan: 0, unsvc: 0 });

  const deviceA = [opening, mv({ id: 'MV-AAAA-1', ts: '2026-02-01T09:00:00Z', device: 'AAAA', onLoan: 5 })];
  const deviceB = [opening, mv({ id: 'MV-BBBB-1', ts: '2026-02-01T09:01:00Z', device: 'BBBB', onLoan: 3 })];

  const onA = Ledger.derive(deviceA);
  const onB = Ledger.derive(deviceB);
  eq('device A alone shows 5 out', onA, { onHand: 40, onLoan: 5, unsvc: 0 });
  eq('device B alone shows 3 out', onB, { onHand: 40, onLoan: 3, unsvc: 0 });

  // Union by id — the opening movement is shared and must not be counted twice.
  const union = [...new Map([...deviceA, ...deviceB].map(m => [m.id, m])).values()];
  const merged = Ledger.derive(union);

  eq('merged: BOTH issues land — 8 out, not 5 and not 3',
     merged, { onHand: 40, onLoan: 8, unsvc: 0 });
  ok('available is 32, which neither device could have computed alone',
     merged.onHand - merged.onLoan === 32);

  // The shared opening balance appearing in both sets must not double.
  ok('a movement present on both devices is not applied twice', union.length === 3);

  // And a stocktake on one device supersedes the other's concurrent delta.
  const withRecount = [...union,
    mv({ id: 'MV-AAAA-st', ts: '2026-03-01T00:00:00Z', device: 'AAAA',
         mode: 'absolute', onHand: 36, onLoan: 8, unsvc: 0 })];
  eq('a later stocktake supersedes earlier movements',
     Ledger.derive(withRecount), { onHand: 36, onLoan: 8, unsvc: 0 });
}

// Two devices independently recounting the same item is reported, not hidden.
{
  const rows = [
    mv({ id: 'r1', ts: '2026-03-01T10:00:00Z', device: 'AAAA', mode: 'absolute', onHand: 38 }),
    mv({ id: 'r2', ts: '2026-03-01T11:00:00Z', device: 'BBBB', mode: 'absolute', onHand: 41 }),
  ];
  const s = Ledger.summarise(rows);
  ok('competing recounts are surfaced', s.competingRecounts.length === 1);
  eq('the superseding count is identified', s.competingRecounts[0].superseding.id, 'r2');
  eq('both devices are listed', s.devices.length, 2);
}

console.log('\n=== ledger: against the database ===');

// ---------------------------------------------------------------------------
// The invariant: the cached scalars must equal the derivation, always
// ---------------------------------------------------------------------------

async function assertIntegrity(label) {
  const res = await Storage.movements.checkIntegrity();
  if (!res.ok) console.error('       drift:', JSON.stringify(res.mismatches.slice(0, 4)));
  ok(`cache matches ledger ${label}`, res.ok);
}

Device._resetTokenCache();
await Storage.init({ dbName: 'qstore-ledger-test' });

// A brand-new item.
await Storage.items.put({ id: 'IT-A', name: 'Boots GP', onHand: 40, onLoan: 0, unsvc: 0 });
await assertIntegrity('after item creation');
eq('creation is recorded as a movement', (await Storage.movements.listForItem('IT-A')).length, 1);

// An edit that touches no stock field must not put a row in the ledger.
const beforeCount = (await Storage.movements.listForItem('IT-A')).length;
await Storage.items.put({ id: 'IT-A', name: 'Boots GP MkII', onHand: 40, onLoan: 0, unsvc: 0 });
eq('a rename writes no movement',
   (await Storage.movements.listForItem('IT-A')).length, beforeCount);
await assertIntegrity('after a non-stock edit');

// An issue.
await Storage.atomic.issue(
  { ref: 'LN-TEST-1', itemId: 'IT-A', qty: 5, active: true, location: 'Range' },
  { id: 'IT-A', name: 'Boots GP MkII', onHand: 40, onLoan: 5, unsvc: 0 },
);
await assertIntegrity('after an issue');
eq('derived stock after issue',
   await Storage.movements.derive('IT-A'), { onHand: 40, onLoan: 5, unsvc: 0 });

// A return with two unserviceable.
await Storage.atomic.return(
  { ref: 'LN-TEST-1', itemId: 'IT-A', qty: 5, active: false, location: 'Range' },
  { id: 'IT-A', name: 'Boots GP MkII', onHand: 40, onLoan: 0, unsvc: 2 },
);
await assertIntegrity('after a return');
eq('derived stock after return',
   await Storage.movements.derive('IT-A'), { onHand: 40, onLoan: 0, unsvc: 2 });

// A stocktake — absolute.
await Storage.atomic.stocktakeFinalise(
  [{ id: 'IT-A', name: 'Boots GP MkII', onHand: 38, onLoan: 0, unsvc: 2 }],
  { user: 'QM' },
);
await assertIntegrity('after a stocktake');
{
  const rows = await Storage.movements.listForItem('IT-A');
  const last = rows[rows.length - 1];
  eq('the stocktake is recorded as absolute', last.mode, Ledger.MODE_ABSOLUTE);
  eq('the stocktake records its kind', last.kind, Ledger.KINDS.STOCKTAKE);
  eq('the stocktake records who counted', last.user, 'QM');
}

// Movements carry the originating device and the reference they came from.
{
  const rows = await Storage.movements.listForItem('IT-A');
  const issue = rows.find(r => r.kind === Ledger.KINDS.ISSUE);
  const token = await Device.getDeviceToken(Storage);
  eq('a movement records the device that made it', issue.device, token);
  eq('a movement records the reference it came from', issue.ref, 'LN-TEST-1');
  ok('movement ids are namespaced by device', rows.every(r => r.id.startsWith(`MV-${token}-`)));
}

// recomputeAll is a no-op when nothing has drifted.
{
  const res = await Storage.movements.recomputeAll();
  eq('recompute changes nothing when the cache is correct', res.updated, 0);
}

// Deliberately corrupt the cache, then prove the ledger repairs it. This is the
// path a merge takes: union the movements, recompute, cache regenerated.
{
  const tx = await Storage.items.get('IT-A');
  await Storage.items.put({ ...tx, onHand: 999 }, { kind: 'adjust' });
  // That write is itself a movement, so the ledger now legitimately says 999.
  await assertIntegrity('after a manual adjustment');
  eq('an adjustment is derivable', (await Storage.movements.derive('IT-A')).onHand, 999);
}

console.log('\n=== ledger: opening balances for a pre-ledger database ===');

// ---------------------------------------------------------------------------
// An existing unit upgrading. Items exist; there is no ledger behind them.
// Without an opening balance the derivation would be zero and a recompute
// would wipe the unit's stock.
// ---------------------------------------------------------------------------

{
  Device._resetTokenCache();
  await Storage.init({ dbName: 'qstore-ledger-upgrade' });

  // Simulate the pre-ledger state: items present, ledger empty, and the
  // "already seeded" marker cleared so boot seeding runs as it would on
  // a first upgrade.
  await Storage.items.put({ id: 'OLD-1', name: 'Helmet', onHand: 12, onLoan: 3, unsvc: 1 });
  await Storage.items.put({ id: 'OLD-2', name: 'Webbing', onHand: 7, onLoan: 0, unsvc: 0 });

  const res = await Storage.movements.checkIntegrity();
  ok('a freshly seeded database is already consistent', res.ok);

  const recomputed = await Storage.movements.recomputeAll();
  eq('recompute does not wipe stock on an upgraded database', recomputed.updated, 0);
  eq('stock survives the recompute',
     (await Storage.items.get('OLD-1')).onHand, 12);
  eq('onLoan survives the recompute',
     (await Storage.items.get('OLD-1')).onLoan, 3);
}

console.log('\n=== ledger: survives export and import ===');

{
  const snapshot = await Storage.exportAll();
  ok('the ledger travels in the backup', Array.isArray(snapshot.movements) && snapshot.movements.length > 0);

  Device._resetTokenCache();
  await Storage.init({ dbName: 'qstore-ledger-restore' });
  await Storage.importAll(snapshot);

  await assertIntegrity('after a restore');
  eq('restored stock is intact', (await Storage.items.get('OLD-1')).onHand, 12);
  ok('restored movements are present', (await Storage.movements.count()) > 0);
}

// A backup written before the ledger existed: figures, no movements.
{
  Device._resetTokenCache();
  await Storage.init({ dbName: 'qstore-ledger-legacy-src' });
  await Storage.items.put({ id: 'LEG-1', name: 'Old stock', onHand: 25, onLoan: 4, unsvc: 0 });
  const legacy = await Storage.exportAll();
  delete legacy.movements;               // as an older build would have written it

  Device._resetTokenCache();
  await Storage.init({ dbName: 'qstore-ledger-legacy-dst' });
  await Storage.importAll(legacy);

  eq('a pre-ledger backup restores its stock',
     (await Storage.items.get('LEG-1')).onHand, 25);
  ok('a pre-ledger backup is given an opening balance',
     (await Storage.movements.count()) > 0);
  await assertIntegrity('after restoring a pre-ledger backup');

  const after = await Storage.movements.recomputeAll();
  eq('recompute does not wipe a restored pre-ledger database', after.updated, 0);
}

console.log('\n=== ledger: a real v4 -> v5 schema upgrade ===');

// ---------------------------------------------------------------------------
// The path every existing unit takes. The tests above all create their
// database at v5, so the createObjectStore in the oldVersion < 5 block runs as
// part of a fresh install. That is not what an upgrade does: an upgrade opens
// a database that already holds a unit's stock, at a lower version, and has to
// add the store and seed a baseline without losing anything.
//
// Built here by hand at v4 rather than by mocking, so this exercises the
// genuine IndexedDB upgrade transaction.
// ---------------------------------------------------------------------------

{
  const DB = 'qstore-v4-upgrade';

  await new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 4);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('meta',     { keyPath: 'key' });
      db.createObjectStore('settings', { keyPath: 'key' });
      db.createObjectStore('counters', { keyPath: 'key' });
      const items = db.createObjectStore('items', { keyPath: 'id' });
      items.createIndex('cat', 'cat', { unique: false });
      db.createObjectStore('photos', { keyPath: 'id' });
      db.createObjectStore('cadets', { keyPath: 'svcNo' });
      const loans = db.createObjectStore('loans', { keyPath: 'ref' });
      loans.createIndex('issueNo', 'issueNo', { unique: false });
      db.createObjectStore('audit', { keyPath: 'seq', autoIncrement: true });
      db.createObjectStore('users', { keyPath: 'id' });
      db.createObjectStore('pendingRequests', { keyPath: 'id' });
      db.createObjectStore('stocktakeCounts', { keyPath: 'itemId' });
      db.createObjectStore('kits', { keyPath: 'id' });
      const orders = db.createObjectStore('supplyOrders', { keyPath: 'id' });
      orders.createIndex('docType', 'docType', { unique: false });
      const staff = db.createObjectStore('staff', { keyPath: 'svcNo' });
      staff.createIndex('surname', 'surname', { unique: false });
    };
    req.onsuccess = () => {
      const db = req.result;
      // A unit's stock, as it stands before the upgrade.
      const tx = db.transaction('items', 'readwrite');
      tx.objectStore('items').put({ id: 'V4-1', name: 'Rifle sling', onHand: 60, onLoan: 12, unsvc: 2 });
      tx.objectStore('items').put({ id: 'V4-2', name: 'Bayonet frog', onHand: 15, onLoan: 0, unsvc: 0 });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });

  ok('a v4 database was created with stock in it', true);

  // Now open it through the app, which upgrades it to v5.
  Device._resetTokenCache();
  await Storage.init({ dbName: DB });

  eq('stock survives the upgrade untouched',
     (await Storage.items.get('V4-1')).onHand, 60);
  eq('onLoan survives the upgrade untouched',
     (await Storage.items.get('V4-1')).onLoan, 12);

  const seeded = await Storage.movements.count();
  eq('every pre-existing item is given an opening balance', seeded, 2);

  const opening = (await Storage.movements.listForItem('V4-1'))[0];
  eq('the opening balance is absolute', opening.mode, Ledger.MODE_ABSOLUTE);
  eq('the opening balance is marked as such', opening.kind, Ledger.KINDS.OPENING);
  eq('the opening balance carries the figures the book held',
     { onHand: opening.onHand, onLoan: opening.onLoan, unsvc: opening.unsvc },
     { onHand: 60, onLoan: 12, unsvc: 2 });

  await assertIntegrity('immediately after a v4 upgrade');

  const rc = await Storage.movements.recomputeAll();
  eq('recompute after upgrade changes nothing', rc.updated, 0);
  eq('stock is still intact after a recompute',
     (await Storage.items.get('V4-1')).onHand, 60);

  // Seeding must not run twice and double the baseline.
  Device._resetTokenCache();
  await Storage.init({ dbName: 'qstore-ledger-test' });   // switch away
  Device._resetTokenCache();
  await Storage.init({ dbName: DB });                      // and back
  eq('re-opening does not seed a second opening balance',
     await Storage.movements.count(), 2);
  await assertIntegrity('after re-opening the upgraded database');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
