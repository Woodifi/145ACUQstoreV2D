// Legacy extraction: export to CEA, then remove. In that order, enforced.
//
// HQ AAC ICT, 16 July 2026: "The local copy of the nominal roll should be
// disposed off once the data is entered in CEA" … "produce PDF based exports of
// your respective cadet Q records, and upload them to the individual members
// CEA documents".
//
// The load-bearing assertion here is that purge() REFUSES while any member is
// still un-extracted. Destroying a Commonwealth record before it reaches CEA is
// not a bug — DYM S1 Ch2 para 67 attaches criminal penalties under the Archives
// Act 1983 to exactly that. The refusal is checked against the DATA, not against
// a flag the UI passes in, so a caller cannot talk it out of the check.

import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.Blob) { const { Blob: B } = await import('node:buffer'); globalThis.Blob = B; }
if (!globalThis.localStorage) {
  const m = new Map();
  globalThis.localStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
if (!globalThis.FileReader) {
  globalThis.FileReader = class { readAsDataURL(b) { b.arrayBuffer().then((buf) => {
    this.result = `data:${b.type};base64,${Buffer.from(buf).toString('base64')}`; this.onload?.(); }); } };
}

const Storage = await import('./src/storage.js');

let pass = 0, fail = 0;
const ok = (n, c) => c ? (pass++, console.log(`  ok   ${n}`)) : (fail++, console.error(`  FAIL ${n}`));
const throws = async (n, fn, re) => { try { await fn(); ok(n, false); }
  catch (e) { ok(n, !re || re.test(e.message)); } };

console.log('=== legacy extraction ===');
await Storage.init();

// Seed a legacy database the way an upgraded unit's would look.
await Storage.importAll({
  schemaVersion: 4, meta: [], settings: [], counters: [], items: [], audit: [],
  users: [], stocktakeCounts: [], kits: [], supplyOrders: [], photos: [],
  cadets: [
    { svcNo: '8012345', surname: 'Wodehouse', given: 'Alice', rank: 'CDT' },
    { svcNo: '8012346', surname: 'Bronte',    given: 'Emily', rank: 'LCPL' },
  ],
  loans: [
    { ref: 'LN-1001', itemId: 'i1', itemName: 'Slouch Hat', qty: 1, active: true,
      borrowerName: 'CDT Wodehouse A.', borrowerSvc: '8012345' },
    { ref: 'LN-1002', itemId: 'i2', itemName: 'Webbing', qty: 1, active: true,
      borrowerName: 'LCPL Bronte E.', borrowerSvc: '8012346' },
  ],
  pendingRequests: [{ id: 'REQ-1', requestorName: 'CDT Wodehouse A.', lines: [] }],
});

const sum0 = await Storage.legacy.summary();
ok('summary sees the legacy cadets', sum0.cadets === 2);
ok('summary sees the borrower loans', sum0.loans === 2);
ok('summary sees the requests', sum0.requests === 1);

// --- THE LOAD-BEARING ASSERTION --------------------------------------------
await throws('purge REFUSES while members are un-extracted',
  () => Storage.legacy.purge({ confirmedUploadedToCEA: true }), /still name a borrower/i);
ok('nothing was destroyed by the refused purge',
  (await Storage.legacy.summary()).cadets === 2);

await throws('purge REFUSES without explicit CEA confirmation',
  () => Storage.legacy.purge({}), /explicit confirmation/i);

// --- extraction links, it does not delete -----------------------------------
const entries = await Storage.legacy.list();
ok('list() pairs each member with their loans', entries.length === 2
  && entries.every((e) => e.loans.length === 1));
ok('list() decrypts the member name for the PDF',
  entries.some((e) => e.member.surname === 'Wodehouse'));

const r1 = await Storage.legacy.linkToIssue('8012345', 'ISS-1042');
ok('linkToIssue reports what it linked', r1.linked === 1);

const ln1 = await Storage.loans.get('LN-1001');
ok('the loan now points at the issue document', ln1.issueNo === 'ISS-1042');
ok('the loan is marked as held by an individual', ln1.location === 'individual');
ok('the borrower name is gone from the loan', !('borrowerName' in ln1));
ok('the borrower svcNo is gone from the loan', !('borrowerSvc' in ln1));
ok('the equipment record survives', ln1.itemName === 'Slouch Hat' && ln1.qty === 1);

await throws('purge STILL refuses — one member remains un-extracted',
  () => Storage.legacy.purge({ confirmedUploadedToCEA: true }), /still name a borrower/i);

await Storage.legacy.linkToIssue('8012346', 'ISS-1043');
ok('all members extracted', (await Storage.legacy.summary()).loans === 0);

// --- now, and only now, purge -----------------------------------------------
const res = await Storage.legacy.purge({ confirmedUploadedToCEA: true });
ok('purge removed the cadet records', res.cadets === 2);
ok('purge removed the requests', res.requests === 1);
ok('no cadet records remain', (await Storage.legacy.summary()).total === 0);
ok('EQUIPMENT records survive the purge', (await Storage.loans.list()).length === 2);

const rows = await Storage.audit.list();
ok('the purge is audited', rows.some((r) => r.action === 'legacy_pii_purged'));
ok('the audit entry says it is irreversible',
  /irreversible/i.test(rows.find((r) => r.action === 'legacy_pii_purged')?.desc || ''));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
