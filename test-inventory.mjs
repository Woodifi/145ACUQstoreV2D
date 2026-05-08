// Test for the inventory badge derivation logic (_deriveCondition).
//
// Bug context: prior to this test, setting an item's `unsvc` count to >0
// while leaving the line-level `condition` flag at 'serviceable' resulted
// in a green "Serviceable" badge — visually misleading. The fix derives
// the badge from BOTH fields together. This test pins the matrix.

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

const { _deriveCondition } = await import('./src/ui/inventory.js');

let pass = 0, fail = 0;
function ok(m)  { console.log('  ✓', m); pass++; }
function bad(m) { console.log('  ✗', m); fail++; }
function eq(a, b, m) {
  if (JSON.stringify(a) === JSON.stringify(b)) ok(`${m}`);
  else bad(`${m} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// -----------------------------------------------------------------------------
console.log('[1] Line-level flags trump everything');
eq(_deriveCondition('written-off',     5, 0), { label: 'Written off',     modifier: 'written-off' },     'written-off');
eq(_deriveCondition('repair',          5, 0), { label: 'In repair',       modifier: 'repair' },          'repair');
eq(_deriveCondition('calibration-due', 5, 0), { label: 'Calibration due', modifier: 'calibration-due' }, 'calibration-due');
eq(_deriveCondition('unserviceable',   5, 0), { label: 'Unserviceable',   modifier: 'unserviceable' },   'unserviceable explicit');

// -----------------------------------------------------------------------------
console.log('\n[2] All units unsvc → unserviceable (the bug case)');
eq(_deriveCondition('serviceable', 1, 1), { label: 'Unserviceable', modifier: 'unserviceable' },
  'onHand=1, unsvc=1 → unserviceable');
eq(_deriveCondition('serviceable', 5, 5), { label: 'Unserviceable', modifier: 'unserviceable' },
  'onHand=5, unsvc=5 → unserviceable');
eq(_deriveCondition('serviceable', 5, 7), { label: 'Unserviceable', modifier: 'unserviceable' },
  'onHand=5, unsvc=7 (data error but defensive) → unserviceable');

// -----------------------------------------------------------------------------
console.log('\n[3] Partial unsvc → amber Partially U/S');
eq(_deriveCondition('serviceable', 5, 1), { label: 'Partially U/S', modifier: 'partial-unsvc' },
  'onHand=5, unsvc=1 → partial');
eq(_deriveCondition('serviceable', 5, 4), { label: 'Partially U/S', modifier: 'partial-unsvc' },
  'onHand=5, unsvc=4 → partial');

// -----------------------------------------------------------------------------
console.log('\n[4] All serviceable → green Serviceable');
eq(_deriveCondition('serviceable', 5, 0), { label: 'Serviceable', modifier: 'serviceable' },
  'onHand=5, unsvc=0 → serviceable');
eq(_deriveCondition('serviceable', 0, 0), { label: 'Serviceable', modifier: 'serviceable' },
  'onHand=0, unsvc=0 → serviceable (empty stock)');

// -----------------------------------------------------------------------------
console.log('\n[5] Unknown / missing condition handled gracefully');
eq(_deriveCondition('',        5, 0), { label: '—',           modifier: 'unknown' }, 'empty condition');
eq(_deriveCondition(undefined, 5, 0), { label: '—',           modifier: 'unknown' }, 'undefined condition');
eq(_deriveCondition('garbage', 5, 0), { label: 'garbage',     modifier: 'unknown' }, 'unknown string');

// Unknown condition with full unsvc still gets promoted to red.
eq(_deriveCondition('garbage', 3, 3), { label: 'Unserviceable', modifier: 'unserviceable' },
  'unknown condition + all unsvc → red');

// -----------------------------------------------------------------------------
console.log('\n[6] Numeric coercion handles strings and missing values');
eq(_deriveCondition('serviceable', '5', '0'), { label: 'Serviceable', modifier: 'serviceable' },
  'string-numbers coerced');
eq(_deriveCondition('serviceable', null, null), { label: 'Serviceable', modifier: 'serviceable' },
  'null counts → 0/0 → serviceable');
eq(_deriveCondition('serviceable', undefined, undefined), { label: 'Serviceable', modifier: 'serviceable' },
  'undefined counts → 0/0 → serviceable');

console.log(`\nResults: ${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
