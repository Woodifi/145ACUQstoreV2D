// Device identity, namespaced references, and record provenance.
//
// Written because the merge these support cannot be built safely without them,
// and because the failure they prevent is silent.
//
// The specific failure: loans are keyed by `ref`, and refs came from a local
// counter starting at 1000. Two devices each raising their first issue both
// minted LN-1000 for entirely different loans. Bring the two databases together
// and one record overwrites the other — an issue disappears, the stock figure
// is wrong, and nothing is shown to the operator. A test that only checked
// "refs are unique" would have passed on either device alone, which is why this
// one runs two installs and compares across them.
//
// The second failure is quieter still: importAll used to restore the sender's
// installId over the receiver's, so after a restore two machines claimed the
// same identity and every ref they minted from then on collided by
// construction.

import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';

// Browser globals the modules expect. These have to be in place before the
// modules are loaded, so the imports below are dynamic — a static import is
// hoisted and would run license.js before localStorage exists.
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

const Storage   = await import('./src/storage.js');
const Device    = await import('./src/device.js');
const Locations = await import('./src/locations.js');

let pass = 0, fail = 0;
const ok = (name, cond) => cond
  ? (pass++, console.log(`  ok   ${name}`))
  : (fail++, console.error(`  FAIL ${name}`));

const eq = (name, actual, expected) => {
  const good = actual === expected;
  if (!good) console.error(`       expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  ok(name, good);
};

console.log('=== device identity ===');

// ---------------------------------------------------------------------------
// Token derivation — pure, no database
// ---------------------------------------------------------------------------

{
  const a = Device.tokenFromInstallId('3f6b1c9e-2a44-4f1e-9c77-8b21d0e5aa10');
  const b = Device.tokenFromInstallId('3f6b1c9e-2a44-4f1e-9c77-8b21d0e5aa10');
  const c = Device.tokenFromInstallId('9e1d7a02-55bc-4a3f-81de-2c40f7b9e3d1');

  eq('token is 4 characters', a.length, 4);
  eq('token is stable for the same install ID', a, b);
  ok('token differs for a different install ID', a !== c);
  ok('token uses the unambiguous alphabet (no I, L, O, U)', !/[ILOU]/.test(a + c));
  eq('missing install ID degrades to a fixed token', Device.tokenFromInstallId(''), '0000');

  // Spread check: distinct IDs should not pile onto one token.
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(Device.tokenFromInstallId('install-' + i));
  ok(`500 install IDs produce well-spread tokens (${seen.size} distinct)`, seen.size > 450);
}

// ---------------------------------------------------------------------------
// Two independent installs must not mint colliding references
// ---------------------------------------------------------------------------

async function bootInstall(dbName) {
  Device._resetTokenCache();
  await Storage.init({ dbName });
  return {
    installId: await Device.getInstallId(Storage),
    token:     await Device.getDeviceToken(Storage),
  };
}

const alpha = await bootInstall('qstore-test-alpha');
const alphaLoan1  = await Device.mintRef(Storage, 'LN', 'loan', 1000);
const alphaLoan2  = await Device.mintRef(Storage, 'LN', 'loan', 1000);
const alphaIssue1 = await Locations.nextIssueNo(Storage);

const bravo = await bootInstall('qstore-test-bravo');
const bravoLoan1  = await Device.mintRef(Storage, 'LN', 'loan', 1000);
const bravoIssue1 = await Locations.nextIssueNo(Storage);

ok('two installs get different install IDs', alpha.installId !== bravo.installId);
ok('two installs get different device tokens', alpha.token !== bravo.token);

// This is the assertion the whole change exists for.
ok('first loan ref on each device does NOT collide', alphaLoan1 !== bravoLoan1);
ok('first issue number on each device does NOT collide', alphaIssue1 !== bravoIssue1);

eq('loan ref carries the device token', alphaLoan1, `LN-${alpha.token}-1000`);
eq('issue number carries the device token', alphaIssue1, `ISS-${alpha.token}-1000`);
eq('the counter still advances within a device', alphaLoan2, `LN-${alpha.token}-1001`);

// Both devices' counters are at 1000 — the collision is real and is defeated
// only by the token, so prove the underlying counters did in fact match.
ok('underlying counters did collide (token is what saves it)',
   alphaLoan1.split('-').pop() === bravoLoan1.split('-').pop());

// ---------------------------------------------------------------------------
// Legacy reference detection
// ---------------------------------------------------------------------------

ok('a pre-namespace ref is recognised as legacy', Device.isLegacyRef('LN-1000'));
ok('a namespaced ref is not legacy', !Device.isLegacyRef('LN-K7M2-1000'));
ok('a minted ref is not legacy', !Device.isLegacyRef(alphaLoan1));
ok('an empty ref is treated as legacy', Device.isLegacyRef(''));

// ---------------------------------------------------------------------------
// Provenance stamping on write
// ---------------------------------------------------------------------------

await bootInstall('qstore-test-stamp');
const me = await Device.getDeviceToken(Storage);

const before = new Date().toISOString();
await Storage.items.put({ id: 'IT-1', name: 'Boots GP', onHand: 40 });
const stored = await Storage.items.get('IT-1');

ok('write records updatedAt', typeof stored.updatedAt === 'string' && stored.updatedAt >= before);
eq('write records the writing device', stored.updatedBy, me);

// A later write moves the stamp forward.
await new Promise(r => setTimeout(r, 5));
await Storage.items.put({ ...stored, name: 'Boots GP MkII' });
const restored = await Storage.items.get('IT-1');
ok('a later write advances updatedAt', restored.updatedAt >= stored.updatedAt);

// Kits and orders carry provenance too.
await Storage.kits.put({ id: 'KIT-1', name: 'Recruit issue', lines: [] });
const kit = await Storage.kits.get('KIT-1');
eq('kits are stamped', kit.updatedBy, me);

await Storage.orders.put({ id: 'ORD-1', docType: 'AB174', lines: [] });
const order = await Storage.orders.get('ORD-1');
eq('orders are stamped', order.updatedBy, me);

// ---------------------------------------------------------------------------
// Identity survives a restore
// ---------------------------------------------------------------------------
// The receiving machine keeps being itself. Previously it adopted the sender's
// installId, so both machines then minted references from the same namespace.

await bootInstall('qstore-test-source');
const sourceId = await Device.getInstallId(Storage);
await Storage.items.put({ id: 'IT-9', name: 'Helmet', onHand: 5 });
const snapshot = await Storage.exportAll();

const dest = await bootInstall('qstore-test-dest');
ok('sender and receiver start as different installs', dest.installId !== sourceId);

await Storage.importAll(snapshot);
Device._resetTokenCache();

const afterId    = await Device.getInstallId(Storage);
const afterToken = await Device.getDeviceToken(Storage);

eq('receiver keeps its own install ID across import', afterId, dest.installId);
ok('receiver did NOT adopt the sender identity', afterId !== sourceId);
eq('receiver keeps its own device token', afterToken, dest.token);
eq('the source install is recorded', await Storage.meta.get('importedFromInstallId'), sourceId);
ok('the import is timestamped', !!(await Storage.meta.get('importedAt')));

// The data itself still arrived, and kept the provenance of the device that
// wrote it rather than being re-stamped on arrival.
const carried = await Storage.items.get('IT-9');
ok('imported data is present', !!carried && carried.name === 'Helmet');
ok('imported rows keep the ORIGIN device stamp, not the receiver\'s',
   carried.updatedBy && carried.updatedBy !== afterToken);

// And because identity survived, the receiver now mints refs in its own
// namespace rather than the sender's.
const postImportRef = await Device.mintRef(Storage, 'LN', 'loan', 1000);
ok('refs minted after import use the receiver\'s namespace',
   postImportRef.includes(`-${afterToken}-`));

// ---------------------------------------------------------------------------
// Namespace marker
// ---------------------------------------------------------------------------

const nsFrom = await Storage.meta.get('refNamespaceFrom');
ok('the namespace start point is recorded', typeof nsFrom === 'string' && nsFrom.length > 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
