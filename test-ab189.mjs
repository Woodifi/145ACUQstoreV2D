// Headless smoke test for AB189 Equipment Request Form generation.
//
// Same strategy as test-pdf.mjs: verify the output is a valid PDF byte stream
// with the expected filename pattern, and that preconditions are enforced.
// Visual layout is verified manually (eyes-on) before release.

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

const Pdf = await import('./src/pdf.js');

let pass = 0, fail = 0;
function ok(m)  { console.log('  ✓', m); pass++; }
function bad(m) { console.log('  ✗', m); fail++; }
function expect(cond, msg) { cond ? ok(msg) : bad(msg); }
function eq(a, b, m) {
  if (JSON.stringify(a) === JSON.stringify(b)) ok(`${m} (= ${JSON.stringify(a)})`);
  else bad(`${m} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const sampleUnit = {
  unitName: '145 ACU Brisbane',
  unitCode: '145ACU',
  state:    'QLD',
  qmName:   'Wood',
  qmRank:   'CAPT-AAC',
  coName:   'Smith',
};

const sampleCadet = {
  svcNo:      '8512345',
  rank:       'CDT',
  surname:    'JONES',
  given:      'Alice',
  plt:        '2',
  personType: 'cadet',
  active:     true,
};

const baseLoan = {
  ref:          'LN-1000',
  itemId:       'I-001',
  itemName:     'Slouch hat',
  nsn:          '8470-66-001-0001',
  qty:          1,
  borrowerSvc:  '8512345',
  borrowerName: 'CDT JONES',
  purpose:      'Initial Issue',
  issueDate:    '2026-05-06',
  dueDate:      '2026-12-31',
  condition:    'serviceable',
  remarks:      'Issued at parade night.',
  active:       true,
  issuedBy:     'admin',
};

// -----------------------------------------------------------------------------
console.log('[1] Single-loan AB189 produces valid PDF');
const r1 = await Pdf.generateAB189([baseLoan], { unit: sampleUnit, cadet: sampleCadet });
expect(typeof r1.bytes === 'number' && r1.bytes > 1000,
  `bytes is a sensible PDF size (got ${r1.bytes})`);
expect(typeof r1.filename === 'string' && r1.filename.endsWith('.pdf'),
  `filename ends in .pdf (got ${r1.filename})`);
eq(r1.filename, 'AB189_8512345_2026-05-06.pdf',
  'filename pattern matches AB189_<svc>_<date>.pdf');
expect(r1.blob && typeof r1.blob.size === 'number',
  `result includes a Blob (size=${r1.blob?.size})`);
eq(r1.blob.type, 'application/pdf', 'Blob type is application/pdf');
eq(r1.blob.size, r1.bytes, 'Blob size matches reported bytes');

// -----------------------------------------------------------------------------
console.log('\n[2] Batch AB189 (3 loans, same borrower, mixed dates allowed)');
const batch = [
  { ...baseLoan, ref: 'LN-1001', itemId: 'I-002', itemName: 'Webbing belt',  nsn: '8465-66-001-0002', qty: 1 },
  { ...baseLoan, ref: 'LN-1002', itemId: 'I-003', itemName: 'Bush hat',      nsn: '8470-66-001-0003', qty: 1 },
  { ...baseLoan, ref: 'LN-1003', itemId: 'I-004', itemName: 'Field bedroll', nsn: '8465-66-001-0004', qty: 2 },
];
const r2 = await Pdf.generateAB189(batch, { unit: sampleUnit, cadet: sampleCadet });
expect(r2.bytes > 1000, `batch AB189 has sensible size (${r2.bytes} bytes)`);
eq(r2.filename, 'AB189_8512345_2026-05-06.pdf', 'batch uses first loan svc+date for filename');

// -----------------------------------------------------------------------------
console.log('\n[3] AB189 allows mixed issueDates (unlike Issue Voucher)');
// The AB189 is a request form — multi-date batches are allowed.
const mixedDates = [
  { ...baseLoan, ref: 'LN-1010', issueDate: '2026-05-06' },
  { ...baseLoan, ref: 'LN-1011', issueDate: '2026-05-07', itemId: 'I-005', itemName: 'Torch' },
];
let threw = false;
try {
  await Pdf.generateAB189(mixedDates, { unit: sampleUnit });
} catch { threw = true; }
expect(!threw, 'mixed issueDates does NOT throw (unlike Issue Voucher)');

// -----------------------------------------------------------------------------
console.log('\n[4] Precondition: mismatched borrower throws');
threw = false; let err = null;
try {
  await Pdf.generateAB189([
    baseLoan,
    { ...baseLoan, borrowerSvc: '9999999' },
  ], { unit: sampleUnit });
} catch (e) { threw = true; err = e; }
expect(threw, 'mismatched borrower throws');
expect(err && /borrower/i.test(err.message), `error mentions "borrower" (got: ${err?.message})`);

// -----------------------------------------------------------------------------
console.log('\n[5] Empty / null input throws');
threw = false;
try { await Pdf.generateAB189([], { unit: sampleUnit }); }
catch { threw = true; }
expect(threw, 'empty array throws');

threw = false;
try { await Pdf.generateAB189(null, { unit: sampleUnit }); }
catch { threw = true; }
expect(threw, 'null throws');

// -----------------------------------------------------------------------------
console.log('\n[6] Works without cadet data (cadet = null)');
const r6 = await Pdf.generateAB189([baseLoan], { unit: sampleUnit, cadet: null });
expect(r6.bytes > 1000, `no-cadet AB189 generates (${r6.bytes} bytes)`);

// -----------------------------------------------------------------------------
console.log('\n[7] Works with full cadet data (includes plt + given names)');
const r7 = await Pdf.generateAB189([baseLoan], { unit: sampleUnit, cadet: sampleCadet });
expect(r7.bytes > 1000, `full-cadet AB189 generates (${r7.bytes} bytes)`);
// Full-cadet PDF should be slightly larger than the no-cadet one (extra rows).
expect(r7.bytes >= r6.bytes,
  `full-cadet PDF is not smaller than no-cadet (${r7.bytes} >= ${r6.bytes})`);

// -----------------------------------------------------------------------------
console.log('\n[8] Works without unit branding');
const r8 = await Pdf.generateAB189([baseLoan], {});
expect(r8.bytes > 1000, `unbranded AB189 generates (${r8.bytes} bytes)`);

// -----------------------------------------------------------------------------
console.log('\n[9] Filename sanitisation against injection');
const evil = { ...baseLoan, borrowerSvc: '../../../etc/passwd' };
const r9 = await Pdf.generateAB189([evil], { unit: sampleUnit });
expect(!r9.filename.includes('/'),  `filename has no path separators (got ${r9.filename})`);
expect(!r9.filename.includes('..'), `filename has no parent-dir refs (got ${r9.filename})`);
expect(r9.filename.startsWith('AB189_'), `filename starts with AB189_`);
expect(r9.filename.endsWith('.pdf'), 'still ends in .pdf');

// -----------------------------------------------------------------------------
console.log('\n[10] Long item names do not break layout (smoke — no-throw)');
const longName = {
  ...baseLoan,
  itemName: 'Field Pack Olive Drab Standard Issue Type 3 Lower Compartment Variant with Removable Yoke and Side Pouches',
  nsn:      '8465-66-99-99999-LONG',
};
const r10 = await Pdf.generateAB189([longName], { unit: sampleUnit, cadet: sampleCadet });
expect(r10.bytes > 1000, `long-name AB189 generates (${r10.bytes} bytes)`);

// -----------------------------------------------------------------------------
console.log('\n[11] Loan without a ref (pre-issue generation path)');
// When the AB189 is generated before the loan is created (v2.2 self-service),
// loan.ref will not exist. The form should still generate cleanly.
const noRef = { ...baseLoan, ref: undefined };
let r11Threw = false;
try {
  const r11 = await Pdf.generateAB189([noRef], { unit: sampleUnit, cadet: sampleCadet });
  expect(r11.bytes > 1000, `no-ref AB189 generates (${r11.bytes} bytes)`);
} catch (e) {
  r11Threw = true;
  bad(`no-ref AB189 threw unexpectedly: ${e.message}`);
}
if (!r11Threw) ok('no-ref loan does not throw');

console.log(`\nResults: ${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
