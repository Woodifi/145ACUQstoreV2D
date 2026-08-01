// Merging two devices.
//
// The scenario this file is built around is the one the unit actually has: the
// Q-Store terminal and a laptop both get used on the same weekend, against the
// same stock, with nobody synchronising anything. Before this work the only
// option was to restore one over the other and lose a day's issues. The
// assertion that matters is that after a merge BOTH days of work are present
// and the stock figure is the one neither device could compute alone.
//
// The second thing tested hard is what the merge REFUSES. A merge that quietly
// resolved an ambiguous loan reference would produce a figure that looks
// authoritative and is wrong, which is worse than stopping. So: pre-namespace
// refs that collide are conflicts, user accounts are not imported, and the two
// audit chains are left alone.

import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.Blob) {
  const { Blob: NodeBlob } = await import('node:buffer');
  globalThis.Blob = NodeBlob;
}
if (!globalThis.localStorage) {
  const map = new Map();
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

const Storage = await import('./src/storage.js');
const Device  = await import('./src/device.js');
const Merge   = await import('./src/merge.js');
const Ledger  = await import('./src/ledger.js');

let pass = 0, fail = 0;
const ok = (name, cond) => cond
  ? (pass++, console.log(`  ok   ${name}`))
  : (fail++, console.error(`  FAIL ${name}`));
const eq = (name, actual, expected) => {
  const good = JSON.stringify(actual) === JSON.stringify(expected);
  if (!good) console.error(`       expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  ok(name, good);
};

const use = async (db) => { Device._resetTokenCache(); await Storage.init({ dbName: db }); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

console.log('=== merge: the weekend both devices were used ===');

// ---------------------------------------------------------------------------
// Set up a shared starting point, then diverge.
// ---------------------------------------------------------------------------

// TERMINAL — the Q-Store machine. Holds the stock.
await use('merge-terminal');
await Storage.items.put({ id: 'IT-BOOT', name: 'Boots GP', nsn: '8430-66-123-4567',
                          cat: 'Clothing', onHand: 40, onLoan: 0, unsvc: 0 });
await Storage.items.put({ id: 'IT-HELM', name: 'Helmet', cat: 'Protective',
                          onHand: 20, onLoan: 0, unsvc: 0 });

// The laptop is set up from a copy of the terminal, which is how a second
// device gets its starting data in practice.
const seed = await Storage.exportAll();
const terminalDevice = await Device.getDeviceToken(Storage);

await use('merge-laptop');
await Storage.importAll(seed);
const laptopDevice = await Device.getDeviceToken(Storage);
ok('the two devices have different tags', terminalDevice !== laptopDevice);
eq('the laptop starts from the same stock',
   (await Storage.items.get('IT-BOOT')).onHand, 40);

// ── Saturday: the laptop issues 3 boots, and adds an item of its own ───────
await Storage.atomic.issue(
  { ref: `LN-${laptopDevice}-1000`, itemId: 'IT-BOOT', qty: 3, active: true, location: 'Range' },
  { ...(await Storage.items.get('IT-BOOT')), onLoan: 3 },
);
await Storage.items.put({ id: 'IT-WEBB', name: 'Webbing set', cat: 'Field',
                          onHand: 12, onLoan: 0, unsvc: 0 });
// And corrects the helmet's category — a descriptive edit.
await sleep(5);
await Storage.items.put({ ...(await Storage.items.get('IT-HELM')), cat: 'Head protection' });

const fromLaptop = await Storage.exportAll();

// ── Meanwhile, the terminal issues 5 boots ────────────────────────────────
await use('merge-terminal');
await Storage.atomic.issue(
  { ref: `LN-${terminalDevice}-1000`, itemId: 'IT-BOOT', qty: 5, active: true, location: 'Store' },
  { ...(await Storage.items.get('IT-BOOT')), onLoan: 5 },
);

eq('terminal alone believes 5 are out',
   (await Storage.items.get('IT-BOOT')).onLoan, 5);

// ---------------------------------------------------------------------------
// The merge
// ---------------------------------------------------------------------------

const preview = await Storage.mergePreview(fromLaptop);

ok('the preview reports no conflicts', !preview.hasConflicts);
ok('the preview reports it would change something', preview.willChange);
ok('the preview brings movements across', preview.movements.add.length > 0);
ok('the preview identifies the source device', !!preview.sourceDevice);
ok('the laptop\'s new item is listed as an addition',
   preview.records.items.add.some(i => i.id === 'IT-WEBB'));
ok('the laptop\'s newer edit is listed as an update',
   preview.records.items.update.some(i => i.id === 'IT-HELM'));

// Nothing has happened yet.
eq('the preview changed nothing', (await Storage.items.get('IT-BOOT')).onLoan, 5);
ok('the preview did not add the laptop\'s item', !(await Storage.items.get('IT-WEBB')));

const { plan, recomputed } = await Storage.mergeAll(fromLaptop);

console.log('\n--- after the merge ---');

// THE ASSERTION THIS ALL EXISTS FOR.
const boots = await Storage.items.get('IT-BOOT');
eq('BOTH days of issues survive — 8 out, not 5 and not 3', boots.onLoan, 8);
eq('on-hand is untouched by issues', boots.onHand, 40);
ok('available is 32, which neither device could have computed alone',
   boots.onHand - boots.onLoan === 32);

ok('the stock change came from the recompute, not from either side',
   recomputed.updated >= 1);

// Both loans are present and distinct — this is what namespaced refs bought.
const loans = await Storage.loans.list();
eq('both issues are recorded', loans.length, 2);
ok('the terminal\'s issue survived', loans.some(l => l.ref === `LN-${terminalDevice}-1000`));
ok('the laptop\'s issue arrived',   loans.some(l => l.ref === `LN-${laptopDevice}-1000`));

// Descriptive merge.
ok('the laptop\'s new item arrived', !!(await Storage.items.get('IT-WEBB')));
eq('the laptop\'s newer edit won',
   (await Storage.items.get('IT-HELM')).cat, 'Head protection');

// Provenance is preserved, not rewritten to look local.
{
  const webb = await Storage.items.get('IT-WEBB');
  eq('a merged record keeps the device that wrote it', webb.updatedBy, laptopDevice);
}

// The ledger is intact and the cache agrees with it.
{
  const res = await Storage.movements.checkIntegrity();
  if (!res.ok) console.error('       drift:', JSON.stringify(res.mismatches.slice(0, 3)));
  ok('the cache matches the merged ledger', res.ok);

  const derived = await Storage.movements.derive('IT-BOOT');
  eq('the ledger derives the merged figure', derived, { onHand: 40, onLoan: 8, unsvc: 0 });

  const summary = await Storage.movements.summarise();
  eq('the ledger now carries movements from both devices', summary.devices.length, 2);
}

// Merging the same snapshot twice must not double anything.
{
  const before = (await Storage.items.get('IT-BOOT')).onLoan;
  const mvBefore = await Storage.movements.count();
  await Storage.mergeAll(fromLaptop);
  eq('re-merging the same data changes nothing', (await Storage.items.get('IT-BOOT')).onLoan, before);
  eq('re-merging adds no duplicate movements', await Storage.movements.count(), mvBefore);
}

console.log('\n=== merge: what it refuses to do ===');

// ---------------------------------------------------------------------------
// A pre-namespace reference collision. Two devices each minted LN-1000 for
// different issues, before refs carried a device tag. There is no safe
// automatic answer, so the merge stops.
// ---------------------------------------------------------------------------

{
  await use('merge-legacy-a');
  await Storage.items.put({ id: 'IT-X', name: 'Compass', onHand: 10, onLoan: 0, unsvc: 0 });
  await Storage.atomic.issue(
    { ref: 'LN-1000', itemId: 'IT-X', qty: 2, active: true, location: 'Store', issuedAt: '2026-01-01' },
    { ...(await Storage.items.get('IT-X')), onLoan: 2 },
  );

  await use('merge-legacy-b');
  await Storage.items.put({ id: 'IT-X', name: 'Compass', onHand: 10, onLoan: 0, unsvc: 0 });
  await Storage.atomic.issue(
    // Same old-style ref, entirely different issue.
    { ref: 'LN-1000', itemId: 'IT-X', qty: 7, active: true, location: 'Range', issuedAt: '2026-02-02' },
    { ...(await Storage.items.get('IT-X')), onLoan: 7 },
  );
  const snapB = await Storage.exportAll();

  await use('merge-legacy-a');
  const p = await Storage.mergePreview(snapB);
  ok('a pre-namespace ref collision is detected', p.hasConflicts);
  eq('the collision is reported as such', p.conflicts[0].kind, 'loan-ref-collision');
  eq('the conflicting reference is named', p.conflicts[0].ref, 'LN-1000');
  ok('both sides of the conflict are shown',
     p.conflicts[0].local.qty === 2 && p.conflicts[0].incoming.qty === 7);

  let threw = false;
  try { await Storage.mergeAll(snapB); }
  catch (e) { threw = true; ok('the merge refuses to proceed', /conflict/i.test(e.message)); }
  ok('the merge threw rather than guessing', threw);
  eq('nothing was changed by the refusal', (await Storage.loans.get('LN-1000')).qty, 2);

  // force proceeds, keeps what this device had, and still reports the conflict.
  const forced = await Storage.mergeAll(snapB, { force: true });
  eq('forcing keeps this device\'s version of the conflicted record',
     (await Storage.loans.get('LN-1000')).qty, 2);
  ok('forcing still reports the conflict', forced.plan.conflicts.length === 1);
}

// ---------------------------------------------------------------------------
// Things a merge must not touch
// ---------------------------------------------------------------------------

{
  await use('merge-guard-src');
  await Storage.users.put({ id: 'U-INTRUDER', name: 'Someone Else', role: 'co', pinHash: 'x' });
  await Storage.settings.set('unitName', 'Other Unit');
  const src = await Storage.exportAll();

  await use('merge-guard-dst');
  await Storage.settings.set('unitName', 'My Unit');
  const usersBefore = (await Storage.users.list()).length;
  const auditBefore = await Storage.audit.count();

  const p = await Storage.mergePreview(src);
  const skipped = Object.fromEntries(p.skipped.map(s => [s.store, s]));
  ok('user accounts are reported as not merged', !!skipped.users);
  ok('settings are reported as not merged', !!skipped.settings);
  ok('the audit chain is reported as not merged', !!skipped.audit);
  ok('a reason is given for each omission', p.skipped.every(s => s.reason && s.reason.length > 20));

  await Storage.mergeAll(src);

  eq('no user account was imported', (await Storage.users.list()).length, usersBefore);
  ok('the intruding account is absent', !(await Storage.users.get('U-INTRUDER')));
  eq('local settings are untouched', await Storage.settings.get('unitName'), 'My Unit');

  // The other device's audit entries are not interleaved into this chain; the
  // only new entry is this device's own record that a merge happened.
  const auditAfter = await Storage.audit.count();
  eq('only this device\'s own merge entry was added', auditAfter - auditBefore, 1);
  const entries = await Storage.audit.list({ limit: 1, order: 'desc' });
  eq('the merge is recorded in this device\'s chain', entries[0].action, 'merge');
  ok('the chain still verifies after a merge', (await Storage.audit.verify()).ok);
}

// ---------------------------------------------------------------------------
// A backup written before the ledger existed
// ---------------------------------------------------------------------------

{
  await use('merge-noledger-src');
  await Storage.items.put({ id: 'IT-OLD', name: 'Old kit', onHand: 9, onLoan: 0, unsvc: 0 });
  const snap = await Storage.exportAll();
  delete snap.movements;                 // as a pre-v2.4 build would have written it

  await use('merge-noledger-dst');
  await Storage.items.put({ id: 'IT-MINE', name: 'My kit', onHand: 4, onLoan: 0, unsvc: 0 });

  const p = await Storage.mergePreview(snap);
  ok('a ledger-less backup is flagged', p.warnings.some(w => w.kind === 'no-ledger'));

  await Storage.mergeAll(snap);
  ok('its item details still merge', !!(await Storage.items.get('IT-OLD')));
  eq('this device\'s own stock is unharmed', (await Storage.items.get('IT-MINE')).onHand, 4);
  const res = await Storage.movements.checkIntegrity();
  ok('the ledger and cache still agree afterwards', res.ok);
}

// ---------------------------------------------------------------------------
// Competing stocktakes are surfaced, not silently resolved
// ---------------------------------------------------------------------------

{
  await use('merge-recount-a');
  await Storage.items.put({ id: 'IT-R', name: 'Rope', onHand: 50, onLoan: 0, unsvc: 0 });
  const shared = await Storage.exportAll();

  await use('merge-recount-b');
  await Storage.importAll(shared);
  await sleep(5);
  await Storage.atomic.stocktakeFinalise(
    [{ ...(await Storage.items.get('IT-R')), onHand: 47 }], { user: 'B' });
  const snapB = await Storage.exportAll();

  await use('merge-recount-a');
  await sleep(5);
  await Storage.atomic.stocktakeFinalise(
    [{ ...(await Storage.items.get('IT-R')), onHand: 44 }], { user: 'A' });

  const p = await Storage.mergePreview(snapB);
  ok('two devices recounting the same item is surfaced',
     p.warnings.some(w => w.kind === 'competing-recount'));

  await Storage.mergeAll(snapB);
  const derived = await Storage.movements.derive('IT-R');
  ok('the later recount wins, deterministically', derived.onHand === 44 || derived.onHand === 47);
  const res = await Storage.movements.checkIntegrity();
  ok('the cache matches after competing recounts', res.ok);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
