// Smoke test for v1-file-based migration (Migration.runFromObject).
//
// Feeds a hand-crafted v1-shaped JSON object into runFromObject and
// verifies the v2 stores end up populated with the right counts and
// shapes. The same-origin run() / check() / exportV1Backup() paths
// (which depend on localStorage) are not exercised here.
//
// Tests:
//   - Happy path: items, cadets, loans, users, audit entries land in v2
//   - wipeFirst clears prior v2 state
//   - File-shape sanity check rejects non-v1 input
//   - Migration flag is set and includes the source tag
//   - 'v1_import' audit entry appears in v2's audit chain
//   - v1 audit entries are imported with imported:true flag
//   - Cadets' personType is inferred from rank (matches Item 4 behaviour)

import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

if (!globalThis.sessionStorage) {
  const _store = new Map();
  globalThis.sessionStorage = {
    getItem(k)    { return _store.has(k) ? _store.get(k) : null; },
    setItem(k, v) { _store.set(k, String(v)); },
    removeItem(k) { _store.delete(k); },
    clear()       { _store.clear(); },
  };
}
// localStorage stub — Migration code paths we DON'T exercise still
// reference it on import; the stub prevents ReferenceError at module load.
if (!globalThis.localStorage) {
  const _store = new Map();
  globalThis.localStorage = {
    getItem(k)    { return _store.has(k) ? _store.get(k) : null; },
    setItem(k, v) { _store.set(k, String(v)); },
    removeItem(k) { _store.delete(k); },
  };
}

const Storage   = await import('./src/storage.js');
const Migration = await import('./src/migration.js');

let pass = 0, fail = 0;
function ok(m)  { console.log('  ✓', m); pass++; }
function bad(m) { console.log('  ✗', m); fail++; }
function expect(cond, msg) { cond ? ok(msg) : bad(msg); }
function eq(a, b, m) {
  if (JSON.stringify(a) === JSON.stringify(b)) ok(`${m} (= ${JSON.stringify(a)})`);
  else bad(`${m} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

await Storage.init({ dbName: 'qstore_test_v1import' });

// -----------------------------------------------------------------------------
// Build a representative v1 export object. Matches the shape v1's
// exportData() writes to file: state object containing items, cadets,
// loans, users, auditLog, settings, etc.
// -----------------------------------------------------------------------------
const v1Export = {
  settings: {
    unitName: '145 ACU',
    unitCode: '145ACU',
    qmName:   'Wood',
  },
  items: [
    { id: 'i-001', nsn: '8470-66-001-0001', name: 'Slouch Hat',   cat: 'Headwear',  onHand: 50, onLoan: 12, unsvc: 0, authQty: 60, condition: 'serviceable' },
    { id: 'i-002', nsn: '8465-66-001-0002', name: 'Webbing Belt', cat: 'Equipment', onHand: 40, onLoan: 8,  unsvc: 5, authQty: 50, condition: 'serviceable' },
    { id: 'i-003', nsn: '8470-66-001-0003', name: 'Bush Hat',     cat: 'Headwear',  onHand: 30, onLoan: 4,  unsvc: 18,authQty: 30, condition: 'unserviceable' },
  ],
  cadets: [
    { svcNo: '8512345', surname: 'SMITH', given: 'John',  rank: 'CDT',     plt: '1', active: true },
    { svcNo: '8512346', surname: 'JONES', given: 'Mary',  rank: 'CDTLCPL', plt: '2', active: true },
    { svcNo: '8512347', surname: 'BROWN', given: 'Sarah', rank: 'CAPT',    plt: '',  active: true }, // staff
    { svcNo: '8512348', surname: 'GREY',  given: 'Tim',   rank: 'CDT',     plt: '1', active: false },
  ],
  loans: [
    { ref: 'LN-1001', itemId: 'i-001', itemName: 'Slouch Hat', nsn: '8470-66-001-0001', qty: 1, borrowerSvc: '8512345', borrowerName: 'CDT SMITH', purpose: 'Initial Issue', issueDate: '2026-04-01', dueDate: '2026-12-31', condition: 'serviceable', active: true },
    { ref: 'LN-1002', itemId: 'i-002', itemName: 'Webbing Belt', nsn: '8465-66-001-0002', qty: 1, borrowerSvc: '8512346', borrowerName: 'CDTLCPL JONES', purpose: 'Annual Camp', issueDate: '2026-05-01', dueDate: '2026-05-15', condition: 'serviceable', active: false, returnDate: '2026-05-14', returnCondition: 'serviceable' },
  ],
  users: [
    { id: 'usr-co',  username: 'admin', name: 'Wood',   role: 'co', pinHash: 'legacy-djb2-hex-here' },
    { id: 'usr-qm',  username: 'qm',    name: 'Smith',  role: 'qm', pinHash: 'another-legacy-hex' },
  ],
  pendingRequests: [
    { id: 'req-1', requestorSvc: '8512345', status: 'pending', items: [{ itemId: 'i-001', qty: 1 }] },
  ],
  stocktakeCounts: { 'i-001': 48, 'i-002': 38 },
  auditLog: [
    { ts: '2026-04-01T10:00:00Z', action: 'add',    user: 'admin', desc: 'Added: Slouch Hat — 50 units' },
    { ts: '2026-04-02T11:00:00Z', action: 'cadet_add', user: 'admin', desc: 'Added cadet: CDT SMITH (8512345)' },
    { ts: '2026-04-15T14:00:00Z', action: 'issue',  user: 'admin', desc: 'LN-1001: Slouch Hat × 1 issued to CDT SMITH' },
  ],
  loanCounter: 1003,
};

// -----------------------------------------------------------------------------
console.log('[1] runFromObject migrates a representative v1 export');

const progress = [];
const result = await Migration.runFromObject(v1Export, {
  wipeFirst:  true,
  onProgress: (msg, pct) => progress.push([msg, pct]),
});

eq(result.ok, true, 'runFromObject returns ok:true');
expect(progress.length >= 8, `progress callback fired multiple times (got ${progress.length})`);
expect(progress[progress.length - 1][1] === 100, 'final progress is 100%');

// -----------------------------------------------------------------------------
console.log('\n[2] Items migrated');
const items2 = await Storage.items.list();
eq(items2.length, 3, '3 items in v2 after import');
const slouch = items2.find((i) => i.id === 'i-001');
eq(slouch?.name, 'Slouch Hat', 'item name preserved');
eq(slouch?.onHand, 50, 'item onHand preserved');

// -----------------------------------------------------------------------------
console.log('\n[3] Cadets migrated, personType inferred from rank');
const cadets2 = await Storage.cadets.list();
eq(cadets2.length, 4, '4 cadet/staff records');
const smith = cadets2.find((c) => c.svcNo === '8512345');
eq(smith?.rank, 'CDT', 'cadet rank preserved');
eq(smith?.personType, 'cadet', 'CDT → personType:cadet');
const brown = cadets2.find((c) => c.svcNo === '8512347');
eq(brown?.rank, 'CAPT-AAC', 'CAPT canonicalised to CAPT-AAC by migration');
eq(brown?.personType, 'staff', 'CAPT → personType:staff');

// -----------------------------------------------------------------------------
console.log('\n[4] Loans migrated, denormalised fields preserved');
const loans2 = await Storage.loans.list();
eq(loans2.length, 2, '2 loans imported');
const ln1001 = await Storage.loans.get('LN-1001');
eq(ln1001?.borrowerName, 'CDT SMITH', 'denormalised borrower name preserved');
eq(ln1001?.itemName, 'Slouch Hat', 'denormalised item name preserved');
eq(ln1001?.active, true, 'active loan preserved');
const ln1002 = await Storage.loans.get('LN-1002');
eq(ln1002?.active, false, 'returned loan marked inactive');
eq(ln1002?.returnDate, '2026-05-14', 'returnDate preserved');

// -----------------------------------------------------------------------------
console.log('\n[5] Users migrated, legacy PIN hashes flagged');
const users2 = await Storage.users.list();
eq(users2.length, 2, '2 users imported');
const co = users2.find((u) => u.id === 'usr-co');
eq(co?.legacyPinHash, 'legacy-djb2-hex-here', 'legacy hash moved to legacyPinHash');
eq(co?.pinHashAlgorithm, 'legacy-sha', 'algorithm marked legacy-sha');
expect(!('pinHash' in co) || co.pinHash === undefined, 'plaintext-named pinHash field removed');

// -----------------------------------------------------------------------------
console.log('\n[6] Loan counter restored');
const counterValue = await Storage.counters.peek('loanCounter');
eq(counterValue, 1003, 'loan counter set to v1 value');

// -----------------------------------------------------------------------------
console.log('\n[7] Audit log: v1 entries imported, v1_import action present');
const audits = await Storage.audit.list({ order: 'asc' });
const importedEntries = audits.filter((a) => a.imported === true);
expect(importedEntries.length === 3,
  `3 v1 entries marked imported (got ${importedEntries.length})`);

const v1ImportEntry = audits.find((a) => a.action === 'v1_import');
expect(v1ImportEntry, 'v1_import audit entry present');
expect(/3 items/.test(v1ImportEntry?.desc || ''),
  `v1_import desc mentions counts (got "${v1ImportEntry?.desc}")`);

// Audit chain still verifies despite imports.
const verify = await Storage.audit.verify();
eq(verify.ok, true, 'audit chain valid after v1 import');

// -----------------------------------------------------------------------------
console.log('\n[8] Migration flag set with source tag');
const flag = await Storage.meta.get('migrationFromV1');
expect(flag != null, 'migration flag stored in meta');
eq(flag?.source, 'v1_file_import', 'flag carries source:v1_file_import');

// -----------------------------------------------------------------------------
console.log('\n[9] wipeFirst clears prior v2 state');
// Add a stray v2 record, then re-import — confirm it's gone.
await Storage.items.put({ id: 'stray-test', name: 'Stray', cat: 'Test', onHand: 1, onLoan: 0, unsvc: 0, authQty: 1 });
expect(await Storage.items.get('stray-test'), 'stray v2 record present before re-import');

await Migration.runFromObject(v1Export, { wipeFirst: true, onProgress: () => {} });
const stray = await Storage.items.get('stray-test');
expect(!stray, 'stray v2 record gone after wipeFirst migration');

// -----------------------------------------------------------------------------
console.log('\n[10] File-shape sanity check rejects non-v1 input');
let threw = false; let err = null;
try {
  await Migration.runFromObject({ foo: 'bar', baz: [1, 2, 3] },
    { wipeFirst: false, onProgress: () => {} });
} catch (e) { threw = true; err = e; }
expect(threw, 'object lacking items/cadets is rejected');
expect(err && /v1 backup/i.test(err.message),
  `error mentions "v1 backup" (got: ${err?.message})`);

threw = false;
try { await Migration.runFromObject(null, {}); }
catch { threw = true; }
expect(threw, 'null input is rejected');

threw = false;
try { await Migration.runFromObject('a string', {}); }
catch { threw = true; }
expect(threw, 'string input is rejected');

// -----------------------------------------------------------------------------
console.log('\n[11] Empty arrays are valid (a unit migrating with no data yet)');
const tinyV1 = { items: [], cadets: [], loans: [], users: [], settings: {} };
const tinyResult = await Migration.runFromObject(tinyV1,
  { wipeFirst: true, onProgress: () => {} });
eq(tinyResult.ok, true, 'empty v1 import succeeds');
const itemsAfterTiny = await Storage.items.list();
eq(itemsAfterTiny.length, 0, '0 items after empty import');

console.log(`\nResults: ${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
