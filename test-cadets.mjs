// Headless smoke test for cadet CRUD logic.
//
// Tests the data-layer behaviour the cadets page depends on:
//   - Storage.cadets put/get/delete round-trip
//   - svcNo uniqueness on add (UI enforces this; we verify Storage doesn't
//     silently merge or overwrite)
//   - Rank canonicalisation: manual entry produces the same form as migration
//   - personType inference matches expectations across realistic ranks
//   - Active-loan blocking: Storage.loans.listForCadet returns the right
//     records so the cadets page can warn before delete
//   - Audit chain stays valid through cadet_add / cadet_update / cadet_delete
//
// The actual DOM/render code is not exercised here — that needs a browser
// runtime. The smoke test covers the pure logic behind the UI.

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

const Storage = await import('./src/storage.js');
const Ranks   = await import('./src/ranks.js');

let pass = 0, fail = 0;
function ok(m)  { console.log('  ✓', m); pass++; }
function bad(m) { console.log('  ✗', m); fail++; }
function expect(cond, msg) { cond ? ok(msg) : bad(msg); }
function eq(a, b, m) {
  if (JSON.stringify(a) === JSON.stringify(b)) ok(`${m} (= ${JSON.stringify(a)})`);
  else bad(`${m} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

await Storage.init({ dbName: 'qstore_test_cadets' });

// -----------------------------------------------------------------------------
console.log('[1] Storage.cadets CRUD round-trip');
const cadet1 = {
  svcNo: '8512345', surname: 'SMITH', given: 'John',
  rank: 'CDT', plt: '1', personType: 'cadet', active: true,
  email: 'j.smith@example.com', notes: '',
  createdAt: new Date().toISOString(),
};
await Storage.cadets.put(cadet1);
const got1 = await Storage.cadets.get('8512345');
eq(got1?.svcNo, '8512345', 'put → get round-trip on svcNo');
eq(got1?.surname, 'SMITH', 'surname preserved');
eq(got1?.given, 'John', 'given (v1-compatible name) preserved');
eq(got1?.personType, 'cadet', 'personType preserved');

// -----------------------------------------------------------------------------
console.log('\n[2] svcNo is the primary key — same key overwrites');
await Storage.cadets.put({ ...cadet1, surname: 'SMYTHE' });
const got2 = await Storage.cadets.get('8512345');
eq(got2?.surname, 'SMYTHE', 'put with same svcNo overwrites the record');
const all = await Storage.cadets.list();
eq(all.length, 1, 'list still has only one record (no silent duplicate)');

// -----------------------------------------------------------------------------
console.log('\n[3] Different svcNo creates a separate record');
await Storage.cadets.put({
  svcNo: '8512346', surname: 'JONES', given: 'Mary',
  rank: 'CDTLCPL', plt: '1', personType: 'cadet', active: true,
});
const all2 = await Storage.cadets.list();
eq(all2.length, 2, 'two cadets after second add');

// -----------------------------------------------------------------------------
console.log('\n[4] Rank canonicalisation — manual entry matches migration');
// The migration uses normalizeRank. The cadets form ALSO uses normalizeRank
// after this fix, so 'capt' typed by the user and 'CAPT' from a v1 record
// both become 'CAPT-AAC' in v2.
eq(Ranks.normalizeRank('capt'),     'CAPT-AAC', "'capt' → 'CAPT-AAC'");
eq(Ranks.normalizeRank('CAPT'),     'CAPT-AAC', "'CAPT' → 'CAPT-AAC'");
eq(Ranks.normalizeRank('CAPT.'),    'CAPT-AAC', "'CAPT.' → 'CAPT-AAC' (dot stripped)");
eq(Ranks.normalizeRank('CAPT-AAC'), 'CAPT-AAC', "'CAPT-AAC' is idempotent");
eq(Ranks.normalizeRank('CDT'),      'CDT',      "'CDT' unchanged (cadet rank, no suffix)");
eq(Ranks.normalizeRank('cdtwo1'),   'CDTWO1',   "'cdtwo1' uppercased");
eq(Ranks.normalizeRank('DAH'),      'DAH',      "'DAH' unchanged (non-ranking staff)");

// -----------------------------------------------------------------------------
console.log('\n[5] personType inference');
eq(Ranks.inferPersonType('CDT'),       'cadet', "CDT → cadet");
eq(Ranks.inferPersonType('CDTWO1'),    'cadet', "CDTWO1 → cadet");
eq(Ranks.inferPersonType('OFFCDT'),    'cadet', "OFFCDT → cadet (officer cadet is still a cadet)");
eq(Ranks.inferPersonType('CAPT'),      'staff', "CAPT → staff (bare officer rank)");
eq(Ranks.inferPersonType('CAPT-AAC'),  'staff', "CAPT-AAC → staff");
eq(Ranks.inferPersonType('LT'),        'staff', "LT → staff");
eq(Ranks.inferPersonType('DAH'),       'staff', "DAH → staff (non-ranking staff)");
eq(Ranks.inferPersonType(''),          'cadet', "empty → cadet (safe default)");
eq(Ranks.inferPersonType('UNKNOWN'),   'cadet', "unknown → cadet (safe default)");

// -----------------------------------------------------------------------------
console.log('\n[6] Storage.loans.listForCadet returns the right records');
// Seed loans against cadet 8512345 and 8512346.
await Storage.loans.put({
  ref: 'AB189-001', borrowerSvc: '8512345', borrowerName: 'CDT SMITH',
  qty: 1, active: true,
});
await Storage.loans.put({
  ref: 'AB189-002', borrowerSvc: '8512345', borrowerName: 'CDT SMITH',
  qty: 1, active: true,
});
await Storage.loans.put({
  ref: 'AB189-003', borrowerSvc: '8512345', borrowerName: 'CDT SMITH',
  qty: 1, active: false,    // returned (active: false IS the returned flag)
});
await Storage.loans.put({
  ref: 'AB189-004', borrowerSvc: '8512346', borrowerName: 'CDTLCPL JONES',
  qty: 1, active: true,
});

const loans1 = await Storage.loans.listForCadet('8512345');
eq(loans1.length, 3, 'cadet 8512345 has 3 loan records (2 active + 1 returned)');
const active1 = loans1.filter((l) => l.active === true);
eq(active1.length, 2, 'cadet 8512345 has 2 ACTIVE loans');

const loans2 = await Storage.loans.listForCadet('8512346');
eq(loans2.length, 1, 'cadet 8512346 has 1 loan');

const loansNone = await Storage.loans.listForCadet('99999');
eq(loansNone.length, 0, 'unknown cadet has 0 loans');

// -----------------------------------------------------------------------------
console.log('\n[7] Delete removes only the targeted record');
// The cadets page blocks delete if active loans exist; we test the storage
// behaviour assuming the UI has cleared that block.
await Storage.cadets.delete('8512346');
const all3 = await Storage.cadets.list();
eq(all3.length, 1, 'after delete, only one cadet remains');
eq((await Storage.cadets.get('8512346')), null, 'deleted cadet not retrievable');
eq((await Storage.cadets.get('8512345'))?.surname, 'SMYTHE', 'other cadet unchanged');

// Loan records reference svcNo as a string — they survive cadet deletion.
// This is intentional: AB189s and audit history must remain referenceable.
const orphanLoan = await Storage.loans.get('AB189-004');
eq(orphanLoan?.borrowerSvc, '8512346', 'loan record retains the deleted cadet svcNo (as borrowerSvc)');

// -----------------------------------------------------------------------------
console.log('\n[8] Audit chain handles cadet_add / cadet_update / cadet_delete');
await Storage.audit.append({
  action: 'cadet_add', user: 'test', desc: 'Added cadet: CDT SMITH (8512345)',
});
await Storage.audit.append({
  action: 'cadet_update', user: 'test', desc: 'Updated cadet: CDTLCPL SMITH (8512345)',
});
await Storage.audit.append({
  action: 'cadet_delete', user: 'test', desc: 'Deleted cadet: CDT JONES (8512346) — reason: duplicate',
});

const verify = await Storage.audit.verify();
eq(verify.ok, true, `audit chain valid (count=${verify.count}, brokenAt=${verify.brokenAt || 'n/a'})`);

const audits = await Storage.audit.list({ order: 'asc' });
const cadetActions = audits.filter((a) => a.action.startsWith('cadet_')).map((a) => a.action);
expect(cadetActions.includes('cadet_add'),    'cadet_add action recorded');
expect(cadetActions.includes('cadet_update'), 'cadet_update action recorded');
expect(cadetActions.includes('cadet_delete'), 'cadet_delete action recorded');

// -----------------------------------------------------------------------------
console.log(`\n[9] Cadets without "given" field are tolerated (legacy shape)`);
// v1 records had no givenNames field. Migration left it absent. The page
// must render and edit such records without throwing.
await Storage.cadets.put({
  svcNo: '8512999', surname: 'LEGACY', rank: 'CDT', plt: '2',
  personType: 'cadet', active: true,
  // intentionally NO givenNames field
});
const legacy = await Storage.cadets.get('8512999');
eq(legacy?.given, undefined, "legacy record has no 'given' field");
expect(typeof legacy?.surname === 'string', 'legacy record still has surname');

console.log(`\nResults: ${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
