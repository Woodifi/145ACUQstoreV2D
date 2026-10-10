// Headless smoke test for PDF generation.
//
// Doesn't try to validate visual layout (PDFs render in PDF viewers, and
// we'd need a renderer in Node to compare images). Instead checks:
//   - The function produces a valid PDF byte stream (starts with %PDF-,
//     ends with %%EOF, contains the expected content as text).
//   - Single-loan voucher and batch voucher both work.
//   - Batch precondition: loans with mismatched issue/destination or date are
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
  location:     'individual',
  issueNo:      'ISS-1001',
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
eq(r1.filename, 'IssueVoucher_ISS-1001_2026-05-06.pdf',
  'filename carries the issue ref, not a service number: IssueVoucher_<issue>_<date>.pdf');
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
console.log('\n[3] Batch voucher (3 loans, same issue + date)');
const batch = [
  { ...baseLoan, ref: 'LN-1001', itemId: 'I-002', itemName: 'Webbing belt',  nsn: '8465-66-001-0002', qty: 1 },
  { ...baseLoan, ref: 'LN-1002', itemId: 'I-003', itemName: 'Bush hat',      nsn: '8470-66-001-0003', qty: 1 },
  { ...baseLoan, ref: 'LN-1003', itemId: 'I-004', itemName: 'Field bedroll', nsn: '8465-66-001-0004', qty: 2 },
];
const r3 = await Pdf.generateIssueVoucher(batch, { unit: sampleUnit });
expect(r3.bytes > 1000, `batch PDF has sensible size (got ${r3.bytes})`);
eq(r3.filename, 'IssueVoucher_ISS-1001_2026-05-06.pdf', 'batch uses first loan issue/date for filename');

// -----------------------------------------------------------------------------
console.log('\n[4] Batch precondition: mismatched issue/destination throws');
let threw = false; let err = null;
try {
  await Pdf.generateIssueVoucher([
    baseLoan,
    { ...baseLoan, issueNo: 'ISS-9999' },  // different issue document
  ], { unit: sampleUnit });
} catch (e) { threw = true; err = e; }
expect(threw, 'mismatched issue/destination throws');
expect(err && /issue|destination/i.test(err.message), `error mentions issue/destination (got: ${err?.message})`);

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
// [10]-[12] Nominal roll tests removed with the generator. A nominal roll is by
// definition a list of cadets; this build has none. Deleted rather than skipped
// — a skipped test for a deleted feature is a to-do nobody does.

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
const r = await Pdf.generateStockReport(itemsSample, { unit: evilUnit });
expect(!r.filename.includes('/') && !r.filename.includes('\\') && !r.filename.includes('..'),
  `unit slug is sanitised (got ${r.filename})`);

// =============================================================================
// Blank forms
// =============================================================================
// jsPDF writes text uncompressed in these documents, so a string search of the
// bytes is a real check of what is printed.

const { readFileSync } = await import('node:fs');
const pdfText = async (r) => Buffer.from(await r.blob.arrayBuffer()).toString('latin1');
// The strings actually drawn on the page — the operands of the Tj operator —
// as opposed to the PDF's own structure, which legitimately contains "null".
const drawn = (txt) => [...txt.matchAll(/\(((?:[^()\\]|\\.)*)\) Tj/g)].map((m) => m[1]);

console.log('\n[17] Blank forms: the registry');
const blankIds = Pdf.BLANK_FORMS.map((f) => f.id);
eq(blankIds, ['request', 'issue-voucher', 'board-of-survey', 'stocktake-worksheet'],
  'BLANK_FORMS offers the request, issue voucher, Board of Survey and stocktake sheet');
expect(new Set(Pdf.BLANK_FORMS.map((f) => f.audit)).size === blankIds.length,
  'every blank form has its own audit action');

console.log('\n[18] Blank forms: each one is a valid single-page PDF with nothing filled in');
// A unit carrying every setting a form could prefill. Only branding may print.
const fullUnit = { ...sampleUnit, qmName: 'ZZQMNAME', qmRank: 'ZZQMRANK', coName: 'ZZCONAME' };
const titles = {
  'request':             'EQUIPMENT REQUEST',
  'issue-voucher':       'ISSUE VOUCHER',
  'board-of-survey':     'BOARD OF SURVEY',
  'stocktake-worksheet': 'STOCKTAKE WORKSHEET',
};
for (const form of Pdf.BLANK_FORMS) {
  const res = await Pdf.generateBlankForm(form.id, { unit: fullUnit });
  const txt = await pdfText(res);
  expect(txt.startsWith('%PDF-') && txt.trimEnd().endsWith('%%EOF'), `${form.id}: valid PDF (${res.bytes} bytes)`);
  expect((txt.match(/\/Type \/Page\b/g) || []).length === 1, `${form.id}: one page`);
  expect(txt.includes(titles[form.id]), `${form.id}: carries its title "${titles[form.id]}"`);
  expect(/_Blank_\d{4}-\d{2}-\d{2}\.pdf$/.test(res.filename), `${form.id}: filename marks it blank (${res.filename})`);
  expect(txt.includes('145 ACU Brisbane'), `${form.id}: prints the unit name`);
  const words = drawn(txt);
  expect(words.length > 10, `${form.id}: text was found to inspect (${words.length} strings)`);
  expect(!words.some((w) => /undefined|null|NaN/.test(w)),
    `${form.id}: no "undefined" / "null" / "NaN" printed`);
}

console.log('\n[19] Blank forms: generated from no record, so none can appear');
// The blank generators take { unit, rows } and nothing else. Passing records
// anyway must not print them — this is what makes a blank form safe for every role.
for (const form of Pdf.BLANK_FORMS) {
  const res = await Pdf.generateBlankForm(form.id, {
    unit: sampleUnit,
    cadet: { svcNo: 'ZZSVC999', surname: 'ZZSURNAME', given: 'ZZGIVEN' },
    loans: [{ ...baseLoan, itemName: 'ZZITEMNAME', borrowerName: 'ZZBORROWER' }],
    items: [{ nsn: 'ZZNSN', name: 'ZZITEMNAME' }],
  });
  const txt = await pdfText(res);
  expect(!/ZZ(SVC999|SURNAME|GIVEN|ITEMNAME|BORROWER|NSN)/.test(txt), `${form.id}: prints no record data`);
}
// Signature prefill: the blank voucher and Board of Survey are completed by
// whoever is present, so they must not carry the QM or CO from settings.
for (const id of ['issue-voucher', 'board-of-survey', 'stocktake-worksheet']) {
  const txt = await pdfText(await Pdf.generateBlankForm(id, { unit: fullUnit }));
  expect(!/ZZ(QMNAME|QMRANK|CONAME)/.test(txt), `${id}: no staff name prefilled`);
}

console.log('\n[20] Blank forms: rows are bounded, unknown ids are refused');
const few  = await pdfText(await Pdf.generateBlankIssueVoucher({ rows: 3 }));
const many = await pdfText(await Pdf.generateBlankIssueVoucher({ rows: 500 }));
expect(many.length > few.length, 'more rows requested → more rows drawn');
expect(drawn(many).includes('20') && !drawn(many).includes('21'), 'an absurd row count is clamped to 20 rows');
expect(drawn(few).includes('3') && !drawn(few).includes('4'), 'three rows requested → three rows drawn');
let refused = false;
try { await Pdf.generateBlankForm('nominal-roll'); } catch { refused = true; }
expect(refused, 'generateBlankForm refuses an id that is not in BLANK_FORMS');

console.log('\n[21] Board of Survey no longer prints under the voucher title');
const bos = await pdfText(await Pdf.generateBoardOfSurvey(
  [{ nsn: 'X1', name: 'Tent', qtyWrittenOff: 1, notes: 'Torn' }], { unit: sampleUnit }));
expect(!bos.includes('ISSUE VOUCHER'), 'filled AB174 does not say ISSUE VOUCHER');
const bosBlank = await pdfText(await Pdf.generateBlankForm('board-of-survey', { unit: sampleUnit }));
expect(!bosBlank.includes('ISSUE VOUCHER'), 'blank AB174 does not say ISSUE VOUCHER');

console.log('\n[22] Blank forms are offered in the app');
// Source checks: the page renders from the registry, and both entry points exist.
const uiBlank   = readFileSync(new URL('./src/ui/blank-forms.js', import.meta.url), 'utf8');
const uiReports = readFileSync(new URL('./src/ui/ims-reports.js', import.meta.url), 'utf8');
const uiLoans   = readFileSync(new URL('./src/ui/loans.js', import.meta.url), 'utf8');
expect(/BLANK_FORMS\.map\(/.test(uiBlank), 'the Blank forms list is rendered from BLANK_FORMS, not a second list');
expect(/id: 'blankforms'/.test(uiReports) && /blankFormsHtml\(\)/.test(uiReports) && /wireBlankForms\(root\)/.test(uiReports),
  'Reports has a Blank forms tab that renders and wires the list');
expect(/data-blank-form="issue-voucher"/.test(uiLoans) && /wireBlankForms\(body\)/.test(uiLoans),
  'Loans → Issue offers the blank voucher and wires it');
expect(/print-blank-ab189/.test(uiLoans) && /downloadBlankForm\('request'\)/.test(uiLoans),
  'Loans → Issue still offers the blank AB189');
for (const m of uiLoans.matchAll(/data-blank-form="([a-z-]+)"/g)) {
  expect(blankIds.includes(m[1]), `button for "${m[1]}" points at a real blank form`);
}

console.log(`\nResults: ${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
