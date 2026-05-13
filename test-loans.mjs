// Headless smoke test for loan issue/return logic.
//
// Tests the data-layer behaviour the loans page depends on:
//   - Storage.counters.next monotonic loan refs
//   - Storage.loans put/get round-trip with v1-compatible schema
//   - Issue path: item.onLoan increments by qty, loan record created
//   - Return path: item.onLoan decrements, item.unsvc bumped on bad condition,
//     loan.active flipped, returnDate/returnCondition/returnRemarks set
//   - Listing/filtering: active vs returned vs overdue
//   - listForCadet returns historical loans (active + returned)
//   - Audit chain stays valid through batch issue and batch return
//
// Page DOM is not exercised here — pure logic only.

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

let pass = 0, fail = 0;
function ok(m)  { console.log('  ✓', m); pass++; }
function bad(m) { console.log('  ✗', m); fail++; }
function expect(cond, msg) { cond ? ok(msg) : bad(msg); }
function eq(a, b, m) {
  if (JSON.stringify(a) === JSON.stringify(b)) ok(`${m} (= ${JSON.stringify(a)})`);
  else bad(`${m} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

await Storage.init({ dbName: 'qstore_test_loans' });

// -----------------------------------------------------------------------------
console.log('[1] Storage.counters.next produces monotonic loan refs');
const r1 = await Storage.counters.next('loan', 1000);
const r2 = await Storage.counters.next('loan', 1000);
const r3 = await Storage.counters.next('loan', 1000);
eq(r1, 1000, 'first ref starts at 1000 (the startAt argument)');
eq(r2, 1001, 'second ref is 1001');
eq(r3, 1002, 'third ref is 1002');

// -----------------------------------------------------------------------------
console.log('\n[2] Loan put/get round-trip with v1-compatible schema');
const loan1 = {
  ref:          'LN-2000',
  itemId:       'I-001',
  itemName:     'Slouch hat',
  nsn:          '8470-66-001-0001',
  qty:          1,
  borrowerSvc:  '8512345',
  borrowerName: 'CDT SMITH',
  purpose:      'Initial Issue',
  issueDate:    '2026-05-01',
  dueDate:      '2026-12-31',
  condition:    'serviceable',
  remarks:      '',
  active:       true,
};
await Storage.loans.put(loan1);
const got = await Storage.loans.get('LN-2000');
eq(got?.ref, 'LN-2000',    'ref round-trips');
eq(got?.borrowerName, 'CDT SMITH', 'denormalised borrower name preserved');
eq(got?.itemName, 'Slouch hat',    'denormalised item name preserved');
eq(got?.active, true,             'active true');

// -----------------------------------------------------------------------------
console.log('\n[3] Issue flow: item.onLoan increments, loan record created');
// Seed an item: 10 onHand, 0 onLoan.
const item = {
  id: 'I-100', name: 'Webbing belt', nsn: '8465-66-001-0002',
  cat: 'Equipment', condition: 'serviceable',
  onHand: 10, onLoan: 0, unsvc: 0, authQty: 12,
};
await Storage.items.put(item);

// Simulate an issue of qty=3.
const fresh = await Storage.items.get('I-100');
const avail = (fresh.onHand || 0) - (fresh.onLoan || 0);
expect(avail >= 3, `available stock check (avail=${avail}) ≥ 3`);
fresh.onLoan = (fresh.onLoan || 0) + 3;
await Storage.items.put(fresh);

const ref = `LN-${await Storage.counters.next('loan', 1000)}`;
await Storage.loans.put({
  ref, itemId: 'I-100', itemName: 'Webbing belt', nsn: '8465-66-001-0002',
  qty: 3, borrowerSvc: '8512345', borrowerName: 'CDT SMITH',
  purpose: 'Annual Camp', issueDate: '2026-05-06', dueDate: '2026-05-20',
  condition: 'serviceable', remarks: '', active: true,
});

const after = await Storage.items.get('I-100');
eq(after.onLoan, 3, 'item.onLoan incremented to 3 after issue');
eq(after.onHand, 10, 'item.onHand unchanged by issue');
const issuedLoan = await Storage.loans.get(ref);
eq(issuedLoan?.qty, 3, 'loan record qty=3');
eq(issuedLoan?.active, true, 'loan record is active');

// -----------------------------------------------------------------------------
console.log('\n[4] Available calculation: onHand - onLoan');
// After the issue above, available = 10 - 3 = 7.
const refresh = await Storage.items.get('I-100');
eq((refresh.onHand || 0) - (refresh.onLoan || 0), 7, 'available = 10 - 3 = 7');

// -----------------------------------------------------------------------------
console.log('\n[5] Return flow: serviceable condition');
// Return the qty=3 loan above.
const loan = await Storage.loans.get(ref);
const item2 = await Storage.items.get('I-100');
item2.onLoan = Math.max(0, (item2.onLoan || 0) - loan.qty);
await Storage.items.put(item2);
loan.active          = false;
loan.returnDate      = '2026-05-21';
loan.returnCondition = 'serviceable';
loan.returnRemarks   = '';
await Storage.loans.put(loan);

const item2After = await Storage.items.get('I-100');
eq(item2After.onLoan, 0, 'onLoan back to 0 after serviceable return');
eq(item2After.unsvc, 0,  'unsvc unchanged on serviceable return');
const loanAfter = await Storage.loans.get(ref);
eq(loanAfter.active, false,     'loan inactive after return');
eq(loanAfter.returnDate, '2026-05-21', 'returnDate set');
eq(loanAfter.returnCondition, 'serviceable', 'returnCondition set');

// -----------------------------------------------------------------------------
console.log('\n[6] Return flow: unserviceable bumps unsvc');
// Issue another loan, return as unserviceable.
const item3 = await Storage.items.get('I-100');
item3.onLoan = (item3.onLoan || 0) + 2;
await Storage.items.put(item3);
const ref3 = `LN-${await Storage.counters.next('loan', 1000)}`;
await Storage.loans.put({
  ref: ref3, itemId: 'I-100', itemName: 'Webbing belt', nsn: '8465-66-001-0002',
  qty: 2, borrowerSvc: '8512345', borrowerName: 'CDT SMITH',
  purpose: 'Annual Camp', issueDate: '2026-05-22', dueDate: '2026-05-29',
  condition: 'serviceable', remarks: '', active: true,
});

const loan3 = await Storage.loans.get(ref3);
const item4 = await Storage.items.get('I-100');
item4.onLoan = Math.max(0, (item4.onLoan || 0) - loan3.qty);
item4.unsvc  = (item4.unsvc || 0) + loan3.qty;     // unserviceable bump
await Storage.items.put(item4);
loan3.active           = false;
loan3.returnDate       = '2026-05-30';
loan3.returnCondition  = 'unserviceable';
loan3.returnRemarks    = 'Belt strap torn';
await Storage.loans.put(loan3);

const item4After = await Storage.items.get('I-100');
eq(item4After.onLoan, 0, 'onLoan back to 0');
eq(item4After.unsvc, 2,  'unsvc bumped to 2 by unserviceable return');

// -----------------------------------------------------------------------------
console.log('\n[7] Return flow: write-off bumps unsvc AND marks item unserviceable');
// Re-issue, return as write-off.
const item5 = await Storage.items.get('I-100');
item5.onLoan = (item5.onLoan || 0) + 1;
await Storage.items.put(item5);
const ref5 = `LN-${await Storage.counters.next('loan', 1000)}`;
await Storage.loans.put({
  ref: ref5, itemId: 'I-100', itemName: 'Webbing belt', nsn: '8465-66-001-0002',
  qty: 1, borrowerSvc: '8512345', borrowerName: 'CDT SMITH',
  purpose: 'Annual Camp', issueDate: '2026-05-31', dueDate: '2026-06-07',
  condition: 'serviceable', remarks: '', active: true,
});

const loan5 = await Storage.loans.get(ref5);
const item6 = await Storage.items.get('I-100');
item6.onLoan = Math.max(0, (item6.onLoan || 0) - loan5.qty);
item6.unsvc  = (item6.unsvc || 0) + loan5.qty;
item6.condition = 'unserviceable';   // write-off
await Storage.items.put(item6);
loan5.active           = false;
loan5.returnDate       = '2026-06-08';
loan5.returnCondition  = 'write-off';
await Storage.loans.put(loan5);

const item6After = await Storage.items.get('I-100');
eq(item6After.unsvc, 3, 'unsvc bumped further to 3 by write-off');
eq(item6After.condition, 'unserviceable', 'item condition flipped to unserviceable');

// -----------------------------------------------------------------------------
console.log('\n[8] listForCadet returns active + returned loans');
const all = await Storage.loans.listForCadet('8512345');
expect(all.length >= 4, `cadet 8512345 has ≥4 loan records (got ${all.length})`);
const active = all.filter((l) => l.active === true);
const returned = all.filter((l) => l.active === false);
// Section [2] left LN-2000 active (we never returned it). Sections [3-7]
// each issued + returned one loan, so 3 returned. Total 4: 1 active + 3 returned.
expect(active.length === 1,   `one currently active — LN-2000 from section [2] (got ${active.length})`);
expect(returned.length === 3, `three returned in history (got ${returned.length})`);

// -----------------------------------------------------------------------------
console.log('\n[9] Overdue detection by date string compare');
// Date strings in YYYY-MM-DD format compare correctly as strings.
const today = '2026-05-06';
const cases = [
  ['2026-05-05', true,  'yesterday is overdue'],
  ['2026-05-06', false, 'today is NOT overdue'],
  ['2026-05-07', false, 'tomorrow is NOT overdue'],
  ['2025-12-31', true,  'last year is overdue'],
];
for (const [due, expectedOverdue, label] of cases) {
  const isOverdue = due < today;
  eq(isOverdue, expectedOverdue, label);
}

// -----------------------------------------------------------------------------
console.log('\n[10] Audit chain handles batch issue + return cycle');
// Append a series of issue + return audit entries to mirror a batch.
for (let i = 0; i < 3; i++) {
  await Storage.audit.append({
    action: 'issue',
    user:   'test',
    desc:   `LN-${3000 + i}: Item × 1 issued to CDT SMITH for Annual Camp`,
  });
}
for (let i = 0; i < 3; i++) {
  await Storage.audit.append({
    action: 'return',
    user:   'test',
    desc:   `LN-${3000 + i}: Item × 1 returned by CDT SMITH — serviceable`,
  });
}
const verify = await Storage.audit.verify();
eq(verify.ok, true, `audit chain valid (count=${verify.count}, brokenAt=${verify.brokenAt || 'n/a'})`);

const audits = await Storage.audit.list({ order: 'asc' });
const issueCount  = audits.filter((a) => a.action === 'issue').length;
const returnCount = audits.filter((a) => a.action === 'return').length;
expect(issueCount  >= 3, `≥3 'issue' actions in chain (got ${issueCount})`);
expect(returnCount >= 3, `≥3 'return' actions in chain (got ${returnCount})`);

// -----------------------------------------------------------------------------
console.log('\n[11] Counter persists across reads (peek)');
const peeked = await Storage.counters.peek('loan');
expect(typeof peeked === 'number' && peeked >= 1005, `counter is at least 1005 (got ${peeked})`);

console.log(`\nResults: ${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
