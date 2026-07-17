// Staff must survive a backup round-trip, and adults must not be filed as cadets.
//
// Two defects, one root: the `staff` store was added in schema v4 and the code
// that walks the stores was never updated to know about it.
//
//   1. exportAll() omitted `staff`, so no backup ever written by v4 contained
//      the unit's staff establishment. importAll() had nothing to restore. The
//      Staff page came up empty after a restore with no error anywhere, and
//      exportAll()'s docstring said "the entire database" the whole time.
//
//   2. Adults an older build left in the `cadets` store (no `personType`, staff
//      rank) matched no migration, so they stayed there. legacy.purge() clears
//      the cadets store — so the feature built to dispose of cadet PII safely
//      would irreversibly destroy adult staff records and log them as "cadet
//      record(s)" while doing it.
//
// Both were silent. That is the whole problem: nothing threw, nothing logged,
// and the loss surfaced on a different machine at restore time. So the last
// test here asserts the store lists are COMPLETE against STORES rather than
// checking for `staff` by name — the next store added to the schema should fail
// a test rather than quietly go missing from backups for a release.

import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.Blob) {
  const { Blob: NodeBlob } = await import('node:buffer');
  globalThis.Blob = NodeBlob;
}
if (!globalThis.FileReader) {
  globalThis.FileReader = class {
    readAsDataURL(blob) {
      blob.arrayBuffer().then((buf) => {
        this.result = `data:${blob.type};base64,${Buffer.from(buf).toString('base64')}`;
        if (this.onload) this.onload();
      }).catch((err) => { this.error = err; if (this.onerror) this.onerror(); });
    }
  };
}
for (const name of ['localStorage', 'sessionStorage']) {
  if (!globalThis[name]) {
    const m = new Map();
    globalThis[name] = {
      getItem:    (k) => (m.has(k) ? m.get(k) : null),
      setItem:    (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
      clear:      () => m.clear(),
    };
  }
}

const Storage = await import('./src/storage.js');

let pass = 0, fail = 0;
function ok(msg)  { console.log('  ok   ', msg); pass++; }
function bad(msg) { console.error('  FAIL ', msg); fail++; }
function expect(cond, msg) { cond ? ok(msg) : bad(msg); }
function eq(actual, expected, msg) {
  if (actual === expected) ok(`${msg} (= ${JSON.stringify(actual)})`);
  else bad(`${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

await Storage.init({ dbName: 'qstore_test_staff_roundtrip' });

// -----------------------------------------------------------------------------
console.log('\n[1] Staff survive export → import');

await Storage.staff.put({
  svcNo: '8011111', surname: 'SCALES', given: 'Sean',
  rank: 'LT-AAC', position: 'OC', active: true,
});
await Storage.staff.put({
  svcNo: '8022222', surname: 'NGUYEN', given: 'Kim',
  rank: 'CAPT-AAC', position: 'QM', active: true,
});
eq((await Storage.staff.list()).length, 2, 'two staff on the establishment before export');

const snap = await Storage.exportAll();
expect(Object.prototype.hasOwnProperty.call(snap, 'staff'),
  "backup contains a 'staff' key at all");
eq((snap.staff || []).length, 2, 'backup carries both staff records');

await Storage.importAll(snap);
const restored = await Storage.staff.list();
eq(restored.length, 2, 'both staff restored after import');
eq(restored.find((s) => s.svcNo === '8011111')?.surname, 'SCALES',
  'restored staff record keeps its surname (decrypts correctly under the imported key)');
eq(restored.find((s) => s.svcNo === '8022222')?.position, 'QM',
  'restored staff record keeps its appointment');

// -----------------------------------------------------------------------------
console.log('\n[2] wipe() clears staff — a restore must not leave stale records behind');

await Storage.wipe({ keepMeta: true });
eq((await Storage.staff.list()).length, 0, 'wipe() clears the staff store');

// Import over the top of DIFFERENT staff: the result must be the snapshot's
// establishment, not a merge. Before the fix wipe() skipped `staff`, so a
// restore silently union'd the old device's staff with the new one's.
await Storage.staff.put({ svcNo: '8099999', surname: 'STALE', given: 'Rec', rank: 'MAJ-AAC', active: true });
await Storage.importAll(snap);
const afterOverwrite = await Storage.staff.list();
eq(afterOverwrite.length, 2, 'import replaces the staff establishment rather than merging');
expect(!afterOverwrite.some((s) => s.svcNo === '8099999'),
  'a staff record absent from the backup does not survive the restore');

// -----------------------------------------------------------------------------
console.log('\n[3] Adults stranded in the cadet store are reclassified, not purged');

// A backup from an older build: everyone in `cadets`, most rows with no
// personType at all. This is the shape that strands adults.
const legacy = await Storage.exportAll();
legacy.staff  = [];
legacy.cadets = [
  { svcNo: '8011111', surname: 'SCALES', given: 'Sean', rank: 'LT-AAC',   personType: 'staff', active: true },
  { svcNo: '8022222', surname: 'NGUYEN', given: 'Kim',  rank: 'CAPT-AAC', active: true },  // no personType
  { svcNo: '8033333', surname: 'DAHL',   given: 'Ann',  rank: 'DAH',      active: true },  // no personType
  { svcNo: '8544444', surname: 'SMITH',  given: 'Jo',   rank: 'CDT',      personType: 'cadet', active: true },
  { svcNo: '8555555', surname: 'BROWN',  given: 'Al',   rank: 'CDTWO1',   active: true },  // no personType, cadet rank
  { svcNo: '8566666', surname: 'GREEN',  given: 'Sam',  rank: 'OFFCDT',   active: true },  // officer CADET — still a cadet
];
const report = await Storage.importAll(legacy);

const staffNow  = await Storage.staff.list();
const cadetsNow = await Storage.cadets.list();
const svcNos    = (rows) => rows.map((r) => r.svcNo).sort().join(',');

eq(svcNos(staffNow), '8011111,8022222,8033333',
  'all three adults land in staff — typed and rank-only alike');
eq(svcNos(cadetsNow), '8544444,8555555,8566666',
  'cadets stay in the cadet store — including OFFCDT, an officer cadet is a cadet');
eq(staffNow.find((s) => s.svcNo === '8033333')?.rank, 'DAH',
  'a DAH is recognised as an adult despite having no rank in the usual sense');
eq(staffNow.find((s) => s.svcNo === '8022222')?.surname, 'NGUYEN',
  'a reclassified record survives the move intact (re-encrypted under the staff fields)');
eq(staffNow.find((s) => s.svcNo === '8022222')?.personType, 'staff',
  'a reclassified record is now explicitly typed, so it never strands again');

// -----------------------------------------------------------------------------
console.log('\n[4] The count the operator is shown excludes the adults');

eq(report.legacyPersonData.cadets, 3,
  'import reports 3 cadet records for extraction, not the 6 rows in the backup');
eq(report.legacyPersonData.staffReclassified, 3, 'import reports the 3 adults it moved');

const auditRows = await Storage.audit.list({ order: 'asc' });
expect(auditRows.some((a) => a.action === 'staff_reclassified'),
  'the relocation is recorded in the audit log');
expect((await Storage.audit.verify()).ok,
  'the audit chain still verifies after reclassification');

// -----------------------------------------------------------------------------
console.log('\n[5] The purge no longer destroys adults');

// The whole point. Purge clears the cadets store; before the fix these three
// adults were in it.
const purged = await Storage.legacy.purge({ confirmedUploadedToCEA: true });
eq(purged.cadets, 3, 'purge destroys the 3 cadet records');
eq((await Storage.staff.list()).length, 3,
  'all three adults SURVIVE the purge — they are staff, not cadet PII');
eq((await Storage.cadets.list()).length, 0, 'cadet store is empty after purge');

// -----------------------------------------------------------------------------
console.log('\n[6] Every store is covered by export / import / wipe');

// The structural check. `staff` went missing because these lists are written by
// hand and nothing compared them to the schema. Rather than assert 'staff' is
// present — which only re-tests the bug just fixed — assert the LISTS ARE
// COMPLETE, so the next store added to _runSchemaMigrations fails here.
//
// META and PHOTOS are named exceptions with reasons:
//   META   — install identity + keys. Exported (the audit chain needs the key)
//            but deliberately NOT cleared by wipe(): losing the install key
//            makes every prior export unverifiable. wipe({keepMeta:false}) is
//            the explicit opt-out.
//   PHOTOS — exported and imported via the base64 path, not the plain row path,
//            so it does not appear in the snapshot as a raw store array.
const allStores   = Object.values(Storage.STORES);
const snapshotOf  = await Storage.exportAll();
const EXPORT_VIA_PHOTOS_PATH = ['photos'];

const exportKeyFor = {
  [Storage.STORES.REQUESTS]:  'pendingRequests',
  [Storage.STORES.STOCKTAKE]: 'stocktakeCounts',
  [Storage.STORES.SUPPLY_ORDERS]: 'supplyOrders',
};
const missingFromExport = allStores.filter((s) => {
  if (EXPORT_VIA_PHOTOS_PATH.includes(s)) return false;
  return !Object.prototype.hasOwnProperty.call(snapshotOf, exportKeyFor[s] || s);
});
eq(missingFromExport.join(',') || '(none)', '(none)',
  'exportAll() covers every store in STORES');

// wipe() coverage: seed one row into every clearable store, wipe, and see what
// survived. Behavioural — it cannot be fooled by the list looking right.
await Storage.items.put({ id: 'IT-W1', name: 'Test', qty: 1 });
await Storage.staff.put({ svcNo: '8077777', surname: 'WIPE', given: 'Me', rank: 'LT-AAC', active: true });
await Storage.wipe({ keepMeta: true, keepUsers: true });
eq((await Storage.staff.list()).length, 0, 'wipe() leaves no staff behind');
eq((await Storage.items.list()).length, 0, 'wipe() leaves no items behind');
expect((await Storage.audit.list()).length === 0, 'wipe() clears the audit log');

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
