// Smoke tests for stocktake.
//
// The page UI itself can't run in Node (DOM, event handlers). What we
// can test is the storage layer and the data shape produced by the
// finalise pipeline by replaying the same operations the UI would.
//
// Coverage:
//   - Storage.stocktake.set with new opts shape
//   - Storage.stocktake.remove (added in this delivery)
//   - Variance classification (match / over / short)
//   - Finalise round-trip: items.onHand updates correctly
//   - Audit log entries are emitted with the right action keys
//   - Audit chain remains valid after a stocktake finalisation

import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.sessionStorage) {
  const _store = new Map();
  globalThis.sessionStorage = {
    getItem(k)    { return _store.has(k) ? _store.get(k) : null; },
    setItem(k, v) { _store.set(k, String(v)); },
    removeItem(k) { _store.delete(k); },
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

await Storage.init({ dbName: 'qstore_test_stocktake' });

// -----------------------------------------------------------------------------
console.log('[1] Storage.stocktake.set with new opts shape');

await Storage.stocktake.set('item-1', 50, { countedBy: 'WO Wood' });
const r1 = await Storage.stocktake.get('item-1');
eq(r1.itemId, 'item-1', 'itemId stored');
eq(r1.counted, 50, 'counted stored');
eq(r1.countedBy, 'WO Wood', 'countedBy stored');
expect(r1.condition === null, 'condition null when not provided');
eq(r1.notes, '', 'notes default empty');

await Storage.stocktake.set('item-2', 30, {
  countedBy: 'WO Wood',
  condition: 'unserviceable',
  notes:     'Beyond economical repair',
});
const r2 = await Storage.stocktake.get('item-2');
eq(r2.condition, 'unserviceable', 'condition preserved');
eq(r2.notes, 'Beyond economical repair', 'notes preserved');

// -----------------------------------------------------------------------------
console.log('\n[2] Storage.stocktake.remove (new in this delivery)');

await Storage.stocktake.remove('item-1');
const r1Gone = await Storage.stocktake.get('item-1');
expect(r1Gone === null, 'removed item returns null');

// item-2 should still be there
const r2Still = await Storage.stocktake.get('item-2');
expect(r2Still !== null, 'other items unaffected by remove');

// -----------------------------------------------------------------------------
console.log('\n[3] Storage.stocktake.list returns all current counts');

await Storage.stocktake.clear();
await Storage.stocktake.set('a', 10, { countedBy: 'X' });
await Storage.stocktake.set('b', 20, { countedBy: 'X' });
await Storage.stocktake.set('c', 30, { countedBy: 'X' });
const list = await Storage.stocktake.list();
eq(list.length, 3, 'list returns 3 items');

// -----------------------------------------------------------------------------
console.log('\n[4] Variance classification (the data shape used by the UI)');

// Simulate the _summariseSession logic against a hypothetical inventory.
const items = [
  { id: 'a', name: 'A', cat: 'Test', onHand: 10, onLoan: 0, unsvc: 0, authQty: 10 },
  { id: 'b', name: 'B', cat: 'Test', onHand: 20, onLoan: 0, unsvc: 0, authQty: 20 },
  { id: 'c', name: 'C', cat: 'Test', onHand: 30, onLoan: 0, unsvc: 0, authQty: 30 },
];

// counts: a=10 (match), b=25 (over by 5), c=27 (short by 3)
await Storage.stocktake.clear();
await Storage.stocktake.set('a', 10, { countedBy: 'X' });
await Storage.stocktake.set('b', 25, { countedBy: 'X' });
await Storage.stocktake.set('c', 27, { countedBy: 'X' });

const counts = await Storage.stocktake.list();
const byItem = new Map(counts.map((c) => [c.itemId, c]));
let match = 0, over = 0, short = 0;
for (const it of items) {
  const stk = byItem.get(it.id);
  if (!stk) continue;
  const v = stk.counted - it.onHand;
  if (v === 0) match++;
  else if (v > 0) over++;
  else short++;
}
eq(match, 1, '1 match (a)');
eq(over,  1, '1 over (b)');
eq(short, 1, '1 short (c)');

// -----------------------------------------------------------------------------
console.log('\n[5] Finalise round-trip: items.onHand updated, audit entries emitted');

// Seed inventory.
await Storage.stocktake.clear();
for (const it of items) {
  await Storage.items.put(it);
}

// Pretend the user counted three items.
await Storage.stocktake.set('a', 10, { countedBy: 'WO Wood' });
await Storage.stocktake.set('b', 25, { countedBy: 'WO Wood', condition: 'serviceable' });
await Storage.stocktake.set('c', 27, { countedBy: 'WO Wood', notes: 'Two items missing' });

// Replay the finalise pipeline.
const ctsBefore = (await Storage.audit.list()).length;
const session = await Storage.stocktake.list();
const itemsById = new Map((await Storage.items.list()).map((i) => [i.id, i]));
let updated = 0;
for (const stk of session) {
  const it = itemsById.get(stk.itemId);
  if (!it) continue;
  const v = stk.counted - it.onHand;
  if (v !== 0) {
    await Storage.audit.append({
      action: 'stocktake_adjust',
      user:   'WO Wood',
      desc:   `Stocktake: ${it.name} system:${it.onHand} counted:${stk.counted} variance:${v >= 0 ? '+' : ''}${v}`,
    });
  }
  await Storage.items.put({
    ...it,
    onHand: Math.max(0, stk.counted),
    condition: stk.condition || it.condition,
  });
  if (v !== 0) updated++;
}
await Storage.audit.append({
  action: 'stocktake_finalise',
  user:   'WO Wood',
  desc:   `Stocktake finalised: 3 counted, 1 match, 1 over, 1 short.`,
});
await Storage.stocktake.clear();

// Verify state.
const aAfter = await Storage.items.get('a');
const bAfter = await Storage.items.get('b');
const cAfter = await Storage.items.get('c');
eq(aAfter.onHand, 10, 'a unchanged (match)');
eq(bAfter.onHand, 25, 'b updated to 25 (was 20)');
eq(cAfter.onHand, 27, 'c updated to 27 (was 30)');

const ctsAfter = await Storage.audit.list();
const newAudits = ctsAfter.length - ctsBefore;
expect(newAudits === 3, `3 new audit entries (got ${newAudits}: 2 adjustments + 1 finalise)`);

// Discrepancy entries get the right action key.
const adjustEntries = ctsAfter.filter((a) => a.action === 'stocktake_adjust');
const finalEntries = ctsAfter.filter((a) => a.action === 'stocktake_finalise');
eq(adjustEntries.length, 2, '2 stocktake_adjust entries (b and c only — match excluded)');
eq(finalEntries.length, 1, '1 stocktake_finalise entry');

// Stocktake store cleared after finalise.
const remaining = await Storage.stocktake.list();
eq(remaining.length, 0, 'stocktake store cleared after finalise');

// -----------------------------------------------------------------------------
console.log('\n[6] Audit chain remains valid after a stocktake');

const verify = await Storage.audit.verify();
eq(verify.ok, true, 'audit chain valid after stocktake adjust + finalise');

// -----------------------------------------------------------------------------
console.log('\n[7] Discard flow clears stocktake without touching items');

// Pre-condition: counts again.
await Storage.stocktake.set('a', 999, { countedBy: 'X' });
await Storage.stocktake.set('b', 888, { countedBy: 'X' });

const aBeforeDiscard = await Storage.items.get('a');
await Storage.stocktake.clear();
const aAfterDiscard = await Storage.items.get('a');
const remainingAfterDiscard = await Storage.stocktake.list();

eq(remainingAfterDiscard.length, 0, 'discard clears all counts');
eq(aAfterDiscard.onHand, aBeforeDiscard.onHand, 'item onHand untouched by discard');

// -----------------------------------------------------------------------------
console.log('\n[8] Counted=0 is valid (means "I counted zero of these")');

await Storage.stocktake.clear();
await Storage.items.put({ id: 'd', name: 'D', cat: 'Test', onHand: 5, onLoan: 0, unsvc: 0, authQty: 5 });
await Storage.stocktake.set('d', 0, { countedBy: 'X' });
const d = await Storage.stocktake.get('d');
eq(d.counted, 0, 'counted=0 stored as 0, not coerced to undefined');

// Variance: 0 - 5 = -5 → short
const v = d.counted - 5;
eq(v, -5, 'variance -5 (short by 5)');

// -----------------------------------------------------------------------------
console.log('\n[9] Re-counting an item overwrites the previous value');

await Storage.stocktake.set('d', 3, { countedBy: 'X' });
await Storage.stocktake.set('d', 4, { countedBy: 'X' });
await Storage.stocktake.set('d', 5, { countedBy: 'X' });
const d3 = await Storage.stocktake.get('d');
eq(d3.counted, 5, 'latest value wins');

console.log(`\nResults: ${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
