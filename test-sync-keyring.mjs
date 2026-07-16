// Sync keyring tests — src/sync-keyring.js
//
// Exercises the flow the Settings UI drives: set a passphrase on device 1,
// push a sealed blob, then adopt it on device 2 via passphrase OR recovery
// code. Also pins the invariant that makes the whole fix work: the keyring
// lives in localStorage and never in IndexedDB, because exportAll() dumps IDB.

import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

// Minimal localStorage — Node has none, which is also why 6 existing suites
// die on a bare `localStorage` reference.
function makeLocalStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _dump: () => Object.fromEntries(map),
  };
}
globalThis.localStorage = makeLocalStorage();

const Keyring = await import('./src/sync-keyring.js');
const { sealEnvelope, isEnvelope } = await import('./src/backup-crypto.js');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else      { fail++; console.error(`  FAIL ${name}`); }
}
async function throws(name, fn) {
  try { await fn(); ok(name, false); } catch { ok(name, true); }
}

const PII_KEY = 'cGlpS2V5U2VjcmV0TWF0ZXJpYWw=';
const SNAPSHOT = {
  schemaVersion: 8,
  meta: [{ key: 'piiKey', value: PII_KEY }],
  cadets: [{ id: 'c1', svcNo: '8012345', surname: '~enc:AAAA' }],
};
const PASSPHRASE = 'unit q store passphrase';

console.log('=== sync-keyring ===');

// --- unconfigured device ---------------------------------------------------
ok('starts unconfigured', !Keyring.isConfigured());
ok('no blob key before setup', Keyring.getBlobKey() === null);

// --- setup rejects weak passphrases ----------------------------------------
await throws('rejects short passphrase', () => Keyring.setup('short'));
await throws('rejects empty passphrase', () => Keyring.setup(''));
ok('still unconfigured after rejected setup', !Keyring.isConfigured());

// --- setup -----------------------------------------------------------------
const { recoveryCodeFormatted } = await Keyring.setup(PASSPHRASE);
ok('setup returns a formatted recovery code', /^[A-Z0-9-]{12,}$/.test(recoveryCodeFormatted));
ok('configured after setup', Keyring.isConfigured());
ok('blob key is 256-bit', Keyring.getBlobKey()?.length === 32);
ok('two keyslots created', Keyring.getSlots().length === 2);

// --- the invariant: nothing recoverable in the keyring but the local BK -----
const ring = JSON.parse(globalThis.localStorage.getItem('qstore2_sync_keyring'));
ok('keyring stores only an argon2id hash of the recovery code',
  typeof ring.recoveryHash === 'string' && ring.recoveryHash.startsWith('$argon2id$'));
const recoveryCanonical = recoveryCodeFormatted.replace(/-/g, '');
ok('plaintext recovery code is NOT persisted',
  !JSON.stringify(ring).includes(recoveryCanonical));
ok('passphrase is NOT persisted', !JSON.stringify(ring).includes(PASSPHRASE));

// --- device 1 seals a push -------------------------------------------------
const envelope = await sealEnvelope(SNAPSHOT, Keyring.getBlobKey(), Keyring.getSlots());
ok('sealed payload is an envelope', isEnvelope(envelope));
const wire = JSON.stringify(envelope);
ok('sealed blob does not leak piiKey', !wire.includes(PII_KEY));
ok('sealed blob does not leak svcNo', !wire.includes('8012345'));

// --- device 2: fresh device adopts via passphrase --------------------------
globalThis.localStorage = makeLocalStorage();
ok('device 2 starts unconfigured', !Keyring.isConfigured());
const adopted = await Keyring.unlockFrom(envelope, PASSPHRASE);
ok('device 2 recovers the payload', adopted.payload.cadets[0].svcNo === '8012345');
ok('device 2 adopted via the passphrase slot', adopted.slotType === 'passphrase');
ok('device 2 is now configured', Keyring.isConfigured());
ok('device 2 can seal without prompting', Keyring.getBlobKey()?.length === 32);

// --- device 3: adopts via recovery code (passphrase lost) ------------------
globalThis.localStorage = makeLocalStorage();
const viaCode = await Keyring.unlockFrom(envelope, recoveryCanonical);
ok('recovery code recovers the payload', viaCode.payload.schemaVersion === 8);
ok('adopted via the recovery slot', viaCode.slotType === 'recovery');

// --- wrong secret ----------------------------------------------------------
globalThis.localStorage = makeLocalStorage();
await throws('wrong passphrase cannot adopt', () => Keyring.unlockFrom(envelope, 'wrong one entirely'));
ok('device stays unconfigured after a failed adopt', !Keyring.isConfigured());

// --- reset -----------------------------------------------------------------
globalThis.localStorage = makeLocalStorage();
await Keyring.setup(PASSPHRASE);
ok('configured before reset', Keyring.isConfigured());
Keyring.clear();
ok('reset clears the keyring', !Keyring.isConfigured());
ok('reset drops the blob key', Keyring.getBlobKey() === null);

// --- re-setup yields a different blob key (true re-key) --------------------
globalThis.localStorage = makeLocalStorage();
await Keyring.setup(PASSPHRASE);
const k1 = Buffer.from(Keyring.getBlobKey());
globalThis.localStorage = makeLocalStorage();
await Keyring.setup(PASSPHRASE);
const k2 = Buffer.from(Keyring.getBlobKey());
ok('re-setup generates a fresh blob key', !k1.equals(k2));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
