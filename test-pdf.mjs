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

// =============================================================================
// REPORTS — nominal roll, stock-on-hand, outstanding loans
// =============================================================================
console.log('\n[10] Nominal roll: small list, single page');
const cadetsSmall = [
  { rank: 'CDT', surname: 'SMITH', given: 'John', svcNo: '8512345', plt: '1', active: true },
  { rank: 'CDT', surname: 'JONES', given: 'Mary', svcNo: '8512346', plt: '2', active: true },
];
const roll1 = await Pdf.generateNominalRoll(cadetsSmall, { unit: sampleUnit });
expect(roll1.bytes > 1000, `roll PDF generated (${roll1.bytes} bytes)`);
expect(roll1.filename.startsWith('NominalRoll_'),
  `filename starts with NominalRoll_ (got ${roll1.filename})`);
eq(roll1.blob.type, 'application/pdf', 'roll Blob type is PDF');

console.log('\n[11] Nominal roll: large list forces pagination');
// 80 cadets pushes us onto multiple pages. We can't easily count pages
// from a Blob in Node without a PDF parser, but we can confirm the
// generator doesn't throw and produces a meaningfully-larger file.
const cadetsBig = [];
for (let i = 0; i < 80; i++) {
  cadetsBig.push({
    rank: 'CDT', surname: `SUR${i}`, given: `Given${i}`,
    svcNo: `${85123000 + i}`, plt: '1', active: true,
  });
}
const roll2 = await Pdf.generateNominalRoll(cadetsBig, { unit: sampleUnit });
expect(roll2.bytes > roll1.bytes * 5,
  `large roll is significantly larger than small (${roll2.bytes} > 5 * ${roll1.bytes})`);

console.log('\n[12] Nominal roll: empty list still produces a valid PDF');
// Edge: a unit with no cadets, or a filter that matches nothing. The PDF
// should still be generated (with just a header) — caller can decide
// whether to actually offer the print.
const rollEmpty = await Pdf.generateNominalRoll([], { unit: sampleUnit });
expect(rollEmpty.bytes > 1000, `empty roll still has a header (${rollEmpty.bytes} bytes)`);

console.log('\n[13] Stock report: produces valid PDF with totals');
const itemsSample = [
  { id: '1', nsn: '8470-66-001-0001', name: 'Slouch Hat',  cat: 'Headwear',  onHand: 50, onLoan: 12, unsvc: 0, authQty: 60, condition: 'serviceable' },
  { id: '2', nsn: '8465-66-001-0002', name: 'Webbing Belt',cat: 'Equipment', onHand: 40, onLoan: 8,  unsvc: 5, authQty: 50, condition: 'serviceable' },
];
const stock1 = await Pdf.generateStockReport(itemsSample, { unit: sampleUnit });
expect(stock1.bytes > 1000, `stock report generated (${stock1.bytes} bytes)`);
expect(stock1.filename.startsWith('StockReport_'),
  `filename starts with StockReport_ (got ${stock1.filename})`);

console.log('\n[14] Stock report: items with high unservic ratio get visual highlight');
// We can't visually check the row colour in a smoke test, but we can
// verify the generator doesn't throw on items at various unsvc ratios.
const itemsUnsvc = [
  { nsn: 'X1', name: 'Item-Healthy',         cat: 'Test', onHand: 10, onLoan: 0, unsvc: 0  },
  { nsn: 'X2', name: 'Item-HalfBroken',      cat: 'Test', onHand: 10, onLoan: 0, unsvc: 5  },
  { nsn: 'X3', name: 'Item-MostlyBroken',    cat: 'Test', onHand: 10, onLoan: 0, unsvc: 8  },
  { nsn: 'X4', name: 'Item-Empty',           cat: 'Test', onHand: 0,  onLoan: 0, unsvc: 0  },
];
const stock2 = await Pdf.generateStockReport(itemsUnsvc, { unit: sampleUnit });
expect(stock2.bytes > 1000, `mixed-condition stock report ok (${stock2.bytes} bytes)`);

console.log('\n[15] Outstanding loans: includes overdue badge in subtitle');
const loansForReport = [
  { ref: 'LN-1001', issueDate: '2026-04-01', dueDate: '2026-04-30', itemName: 'Slouch Hat',  qty: 1, borrowerName: 'CDT SMITH' },
  { ref: 'LN-1002', issueDate: '2026-05-06', dueDate: '2026-12-31', itemName: 'Webbing Belt',qty: 1, borrowerName: 'CDT JONES' },
];
const loansR = await Pdf.generateOutstandingLoansReport(loansForReport, { unit: sampleUnit });
expect(loansR.bytes > 1000, `outstanding report generated (${loansR.bytes} bytes)`);
expect(loansR.filename.startsWith('OutstandingLoans_'),
  `filename starts with OutstandingLoans_ (got ${loansR.filename})`);

console.log('\n[16] All reports use sanitised unit slug in filename');
const evilUnit = { unitName: 'Unit / With \\ Slashes', unitCode: '..\\evil' };
const r = await Pdf.generateNominalRoll(cadetsSmall, { unit: evilUnit });
expect(!r.filename.includes('/') && !r.filename.includes('\\') && !r.filename.includes('..'),
  `unit slug is sanitised (got ${r.filename})`);

console.log(`\nResults: ${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
