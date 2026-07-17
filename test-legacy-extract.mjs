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

// --- THE DEADLOCK ------------------------------------------------------------
// Reported from a walkthrough: "after doing the export and clicking remove it is
// still showing that there are q-records not exported but they were all done."
//
// summary() counted every loan carrying a borrower. list() only returned loans
// whose borrowerSvc matched a CADET. So three kinds were counted forever and
// never offered for export — UNIT-LOAN activity loans, staff loans, and phantom
// borrowers — and purge() refused permanently. The operator could export every
// record they were shown and still be told records remained. Unfixable from the
// UI: a dead end.
//
// list() now groups on the LOANS, which is where the truth is.
console.log('\n--- deadlock regression ---');
await Storage.importAll({
  schemaVersion: 4, meta: [], settings: [], counters: [], items: [], audit: [],
  users: [], stocktakeCounts: [], kits: [], supplyOrders: [], photos: [], pendingRequests: [],
  cadets: [{ svcNo: '8012345', surname: 'Wodehouse', given: 'Alice', rank: 'CDT' }],
  staff:  [{ svcNo: '9000001', surname: 'Laidlaw',   given: 'Doug',  rank: 'CAPT-AAC' }],
  loans: [
    { ref: 'D-1', itemId: 'i1', qty: 1, active: true, borrowerName: 'CDT Wodehouse A.', borrowerSvc: '8012345' },
    { ref: 'D-2', itemId: 'i2', qty: 1, active: true, borrowerName: 'Annual Camp 2026', borrowerSvc: 'UNIT-LOAN' },
    { ref: 'D-3', itemId: 'i3', qty: 1, active: true, borrowerName: 'CAPT Laidlaw D.',  borrowerSvc: '9000001' },
    { ref: 'D-4', itemId: 'i4', qty: 1, active: true, borrowerName: 'CDT Ghost G.',     borrowerSvc: '8099999' },
  ],
});
ok('summary counts all four borrower-carrying loans',
  (await Storage.legacy.summary()).loans === 4);

ok('activity loans convert without a PDF',
  (await Storage.legacy.convertActivityLoans()).converted === 1);
const d2 = await Storage.loans.get('D-2');
ok('the activity loan became a destination', d2.location === 'Annual Camp 2026' && !d2.borrowerSvc);

const people = (await Storage.legacy.list()).filter((e) => e.kind === 'person');
ok('list() surfaces the CADET', people.some((e) => e.member.svcNo === '8012345'));
ok('list() surfaces the STAFF member (not in the cadets store)',
  people.some((e) => e.member.svcNo === '9000001'));
ok('list() surfaces the PHANTOM (no person record at all)',
  people.some((e) => e.member.svcNo === '8099999'));
ok('exactly three people need a Q record', people.length === 3);

for (const e of people) {
  await Storage.legacy.linkToIssue(e.member.svcNo, `ISS-${e.member.svcNo}`,
    { borrowerName: e.member.surname });
}
ok('after exporting everything list() offers, NOTHING names a borrower',
  (await Storage.legacy.summary()).loans === 0);

const purged = await Storage.legacy.purge({ confirmedUploadedToCEA: true });
ok('purge now SUCCEEDS — the deadlock is gone', purged.cadets === 1);
ok('all four equipment records survive', (await Storage.loans.list()).length === 4);

// --- cadet LOGIN accounts ----------------------------------------------------
// A cadet account is cadet PII by a different door: PII_FIELDS_USERS is
// ['name','svcNo','totpSecret'], so it holds a cadet's name and service number
// in the USERS store, independently of the cadets store. Step 7 removed the
// ROLE and refused these accounts at login — but refused-and-hidden is not
// absent, and the build's claim is absence.
console.log('\n--- cadet login accounts ---');
await Storage.importAll({
  schemaVersion: 4, meta: [], settings: [], counters: [], items: [], audit: [],
  cadets: [], loans: [], pendingRequests: [], stocktakeCounts: [], kits: [],
  supplyOrders: [], photos: [],
  users: [
    { id: 'u1', username: 'oc',    name: 'CAPT Laidlaw',   svcNo: '9000001', role: 'co' },
    { id: 'u2', username: 'wodeh', name: 'CDT Wodehouse A.', svcNo: '8012345', role: 'cadet' },
    { id: 'u3', username: 'bront', name: 'LCPL Bronte E.',   svcNo: '8012346', role: 'cadet' },
  ],
});

const s1 = await Storage.legacy.summary();
ok('summary counts cadet login accounts', s1.cadetUsers === 2);
ok('cadet accounts count toward the total', s1.total === 2);

// Accounts alone must NOT be gated behind export — they are credentials, not
// Q records. Gating them would deadlock a database that has nothing else left.
const p1 = await Storage.legacy.purge({ confirmedUploadedToCEA: true });
ok('accounts-only purge is not blocked by the loans gate', p1.cadetUsers === 2);

const left = await Storage.users.list();
ok('cadet accounts are gone', !left.some((u) => u.role === 'cadet'));
ok('the OC account survives', left.some((u) => u.id === 'u1' && u.role === 'co'));
ok('no cadet name remains in the users store',
  !JSON.stringify(left).includes('Wodehouse'));
ok('summary is clean afterwards', (await Storage.legacy.summary()).total === 0);

const arows = await Storage.audit.list();
const pnote = arows.find((r) => r.action === 'legacy_pii_purged');
ok('the purge entry names the accounts removed', /login account/i.test(pnote?.desc || ''));
ok('the purge entry states the audit log is unchanged',
  /audit log is unchanged/i.test(pnote?.desc || ''));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
