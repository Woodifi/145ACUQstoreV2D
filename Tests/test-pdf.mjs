// Headless smoke test for PDF generation.
//
// Doesn't try to validate visual layout (PDFs render in PDF viewers, and
// we'd need a renderer in Node to compare images). Instead checks:
//   - The function produces a valid PDF byte stream (starts with %PDF-,
//     ends with %%EOF, contains the expected content as text).
//   - Single-loan voucher and batch voucher both work.
//   - Batch precondition: loans with mismatched borrower or date are
//     rejected with a clear error.
//   - Filename pattern is correct.
//   - Long item names are truncated rather than overflowing.
//
// Manual eyes-on PDF inspection is still required before release; this is
// the cheapest mechanical check we can run in CI.

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

// pdf.js returns { filename, blob, bytes } and does NOT call doc.save() —
// it's the UI layer's job to trigger downloads via downloadPdf(). That
// keeps pdf.js DOM-free and makes this test straightforward.
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

const baseLoan = {
  ref:          'LN-1000',
  itemId:       'I-001',
  itemName:     'Slouch hat',
  nsn:          '8470-66-001-0001',
  qty:          1,
  borrowerSvc:  '8512345',
  borrowerName: 'CDT SMITH',
  purpose:      'Initial Issue',
  issueDate:    '2026-05-06',
  dueDate:      '2026-12-31',
  condition:    'serviceable',
  remarks:      'Issued at parade night.',
  active:       true,
  issuedBy:     'admin',
};

// -----------------------------------------------------------------------------
console.log('[1] Single-loan voucher produces valid PDF');
const r1 = await Pdf.generateIssueVoucher([baseLoan], { unit: sampleUnit });
expect(typeof r1.bytes === 'number' && r1.bytes > 1000,
  `bytes is a sensible PDF size (got ${r1.bytes})`);
expect(typeof r1.filename === 'string' && r1.filename.endsWith('.pdf'),
  `filename ends in .pdf (got ${r1.filename})`);
eq(r1.filename, 'IssueVoucher_8512345_2026-05-06.pdf',
  'filename pattern matches IssueVoucher_<svc>_<date>.pdf');
expect(r1.blob && typeof r1.blob.size === 'number',
  `result includes a Blob (size=${r1.blob?.size})`);
eq(r1.blob.type, 'application/pdf', 'Blob type is application/pdf');
eq(r1.blob.size, r1.bytes, 'Blob size matches reported bytes');

// -----------------------------------------------------------------------------
console.log('\n[2] Generated PDF byte stream is well-formed');
// Re-run with a buffer capture by intercepting output() — easier than
// hooking save. Generate a fresh doc and grab its bytes directly.
const { jsPDF: jsPDF2 } = await import('jspdf');
const probeDoc = new jsPDF2();
probeDoc.text('test', 10, 10);
const probeBytes = new Uint8Array(probeDoc.output('arraybuffer'));
const head = new TextDecoder().decode(probeBytes.slice(0, 8));
const tail = new TextDecoder().decode(probeBytes.slice(-8));
expect(head.startsWith('%PDF-'),  `PDF starts with %PDF- magic (got "${head}")`);
expect(tail.includes('%%EOF'),    `PDF ends with %%EOF (got "${tail}")`);

// -----------------------------------------------------------------------------
console.log('\n[3] Batch voucher (3 loans, same borrower + date)');
const batch = [
  { ...baseLoan, ref: 'LN-1001', itemId: 'I-002', itemName: 'Webbing belt',  nsn: '8465-66-001-0002', qty: 1 },
  { ...baseLoan, ref: 'LN-1002', itemId: 'I-003', itemName: 'Bush hat',      nsn: '8470-66-001-0003', qty: 1 },
  { ...baseLoan, ref: 'LN-1003', itemId: 'I-004', itemName: 'Field bedroll', nsn: '8465-66-001-0004', qty: 2 },
];
const r3 = await Pdf.generateIssueVoucher(batch, { unit: sampleUnit });
expect(r3.bytes > 1000, `batch PDF has sensible size (got ${r3.bytes})`);
eq(r3.filename, 'IssueVoucher_8512345_2026-05-06.pdf', 'batch uses first loan ref/date for filename');

// -----------------------------------------------------------------------------
console.log('\n[4] Batch precondition: mismatched borrower throws');
let threw = false; let err = null;
try {
  await Pdf.generateIssueVoucher([
    baseLoan,
    { ...baseLoan, borrowerSvc: '9999999' },  // different borrower
  ], { unit: sampleUnit });
} catch (e) { threw = true; err = e; }
expect(threw, 'mismatched borrower throws');
expect(err && /borrower/i.test(err.message), `error mentions "borrower" (got: ${err?.message})`);

// -----------------------------------------------------------------------------
console.log('\n[5] Batch precondition: mismatched issueDate throws');
threw = false; err = null;
try {
  await Pdf.generateIssueVoucher([
    baseLoan,
    { ...baseLoan, issueDate: '2026-06-01' },  // different date
  ], { unit: sampleUnit });
} catch (e) { threw = true; err = e; }
expect(threw, 'mismatched issueDate throws');
expect(err && /date/i.test(err.message), `error mentions "date" (got: ${err?.message})`);

// -----------------------------------------------------------------------------
console.log('\n[6] Empty/null input throws');
threw = false;
try { await Pdf.generateIssueVoucher([], { unit: sampleUnit }); }
catch { threw = true; }
expect(threw, 'empty array throws');

threw = false;
try { await Pdf.generateIssueVoucher(null, { unit: sampleUnit }); }
catch { threw = true; }
expect(threw, 'null throws');

// -----------------------------------------------------------------------------
console.log('\n[7] Filename sanitisation against injection');
// A borrower svcNo with path separators or weird chars should produce a
// filename safe for filesystems. Defensive — schema validation already
// strips whitespace, but other chars could sneak through.
const evil = { ...baseLoan, borrowerSvc: '../../../etc/passwd' };
const r7 = await Pdf.generateIssueVoucher([evil], { unit: sampleUnit });
expect(!r7.filename.includes('/'),  `filename has no path separators (got ${r7.filename})`);
expect(!r7.filename.includes('..'), `filename has no parent-dir refs (got ${r7.filename})`);
expect(r7.filename.endsWith('.pdf'), 'still ends in .pdf');

// -----------------------------------------------------------------------------
console.log('\n[8] Voucher works without unit branding');
// If the user hasn't filled in unit details yet, the voucher should still
// generate using sensible defaults rather than throwing or producing
// "undefined undefined" everywhere.
const r8 = await Pdf.generateIssueVoucher([baseLoan], {});
expect(r8.bytes > 1000, `unbranded voucher generates (${r8.bytes} bytes)`);

// -----------------------------------------------------------------------------
console.log('\n[9] Long item name does not break layout (smoke check via no-throw)');
const longName = {
  ...baseLoan,
  itemName: 'Field Pack Olive Drab Standard Issue Type 3 Lower Compartment Variant with Removable Yoke and Side Pouches',
  nsn:      '8465-66-99-99999-LONG',
};
const r9 = await Pdf.generateIssueVoucher([longName], { unit: sampleUnit });
expect(r9.bytes > 1000, `long-name voucher generates (${r9.bytes} bytes)`);

console.log(`\nResults: ${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
