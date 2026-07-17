// Restoring a legacy backup must not silently reintroduce personal information.
//
// The question that prompted this: "if importing an old database, does it
// automatically strip cadet PII or drop it in some way?" The answer was NO —
// importAll() writes rows straight to the object stores, bypassing the
// cadets.put()/loans.put() guards entirely. A legacy .qstore backup would have
// restored cadet records, loans naming a borrower, and plaintext requestor
// details into an identifier-free database, in silence.
//
// The fix is NOT to drop them. The legacy stores exist so this data can be
// extracted to CEA before disposal; a restore that discarded it would leave a
// unit unable to extract the very records they are required to extract, readable
// only by the old build — the one with the key-exposure defect.
//
// The fix is that it cannot arrive quietly. This asserts the report.

import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.Blob) { const { Blob: B } = await import('node:buffer'); globalThis.Blob = B; }
if (!globalThis.localStorage) {
  const m = new Map();
  globalThis.localStorage = {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}
if (!globalThis.FileReader) {
  globalThis.FileReader = class {
    readAsDataURL(b) { b.arrayBuffer().then((buf) => {
      this.result = `data:${b.type};base64,${Buffer.from(buf).toString('base64')}`;
      this.onload?.(); }); }
  };
}

const Storage = await import('./src/storage.js');

let pass = 0, fail = 0;
const ok = (n, c) => c ? (pass++, console.log(`  ok   ${n}`)) : (fail++, console.error(`  FAIL ${n}`));

console.log('=== legacy backup import ===');
await Storage.init();

// A backup exactly as a pre-identifier-free build wrote it.
const legacy = {
  schemaVersion: 4,
  meta: [], settings: [], counters: [], items: [], audit: [], users: [],
  stocktakeCounts: [], kits: [], supplyOrders: [], photos: [],
  cadets: [
    { svcNo: '8012345', surname: 'Wodehouse', given: 'Alice', rank: 'CDT' },
    { svcNo: '8012346', surname: 'Bronte',    given: 'Emily', rank: 'LCPL' },
  ],
  loans: [
    { ref: 'LN-1001', itemId: 'i1', qty: 1, active: true,
      borrowerName: 'CDT Wodehouse A.', borrowerSvc: '8012345' },
    { ref: 'LN-1002', itemId: 'i2', qty: 1, active: true,
      location: 'Field exercise', issueNo: '' },      // modern: no person
  ],
  pendingRequests: [
    { id: 'REQ-1', requestorName: 'CDT Bronte E.', requestorSvc: '8012346', lines: [] },
  ],
};

const report = await Storage.importAll(legacy);

// --- the report exists and is accurate --------------------------------------
ok('importAll returns a report', !!report?.legacyPersonData);
const L = report.legacyPersonData;
ok('counts the cadet records', L.cadets === 2);
ok('counts ONLY loans naming a borrower', L.loans === 1);   // not the modern one
ok('counts the requests', L.requests === 1);
ok('totals them', L.total === 4);

// --- the data IS restored, deliberately, for extraction ---------------------
ok('cadet records are restored (needed for CEA extraction)',
  (await Storage.cadets.list()).length === 2);
ok('loans are restored', (await Storage.loans.list()).length === 2);

// --- and the arrival is recorded --------------------------------------------
const rows = await Storage.audit.list();
const note = rows.find((r) => r.action === 'legacy_pii_imported');
ok('an audit entry records the legacy PII', !!note);
ok('the entry names the cadet records', /cadet record/i.test(note?.desc || ''));
ok('the entry names the borrower loans', /naming a borrower/i.test(note?.desc || ''));
ok('the entry directs extraction to CEA', /CEA/.test(note?.desc || ''));

// --- a clean backup must NOT trigger the warning -----------------------------
// Otherwise the alert is noise and gets ignored — which is how a real one gets
// missed.
const clean = { ...legacy, cadets: [], pendingRequests: [],
  loans: [{ ref: 'LN-2001', itemId: 'i1', qty: 1, active: true, location: 'Bivouac', issueNo: '' }] };
const cleanReport = await Storage.importAll(clean);
ok('a clean backup reports no legacy PII', cleanReport.legacyPersonData.total === 0);
const rows2 = await Storage.audit.list();
ok('a clean backup writes no legacy-PII warning',
  !rows2.some((r) => r.action === 'legacy_pii_imported'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
