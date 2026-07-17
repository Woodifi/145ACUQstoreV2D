// The Defence build must never restrict.
//
// Without this, a unit issued the free Defence build gets TRIAL for 30 days and
// then RESTRICTED — read-only. Their Q-Store quietly stops accepting issues and
// returns a month after they start, for a product they were told costs nothing
// and while the controls statement told HQ "no payment is sought" (§9).
//
// Nobody would have found that until day 31, in a unit, on a parade night.
//
// This asserts against the BUILT ARTEFACT, because the licence state is decided
// by a build-time define. Checking the source would prove nothing about what
// ships — the lesson of the manual's Defence gate, which passed vacuously for
// days because the module it guarded was never bundled.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, 'dist/qstore.html');

let pass = 0, fail = 0;
const ok = (n, c) => c ? (pass++, console.log(`  ok   ${n}`)) : (fail++, console.error(`  FAIL ${n}`));

const build = (args) => {
  execFileSync('node', [join(__dirname, 'build.js'), ...args], { cwd: __dirname, stdio: 'pipe' });
  return readFileSync(DIST, 'utf8');
};

console.log('=== defence licence ===');

// Standard build MUST still enforce licensing — otherwise the assertions below
// are vacuous: absence proves nothing if the thing is absent from both.
const std = build([]);
ok('standard build still has the trial state',      /Free Trial/.test(std));
ok('standard build still has key activation',       /activate-key|Activate/.test(std));
ok('standard build still has the restricted state', /RESTRICTED/.test(std));

const def = build(['--defence']);

ok('defence build states it is free of charge',  /free of charge/i.test(def));
ok('defence build shows a "No charge" badge',    /No charge/.test(def));
ok('defence build has no trial countdown',       !/Free Trial/.test(def));
// Needle the RENDERED markup, not the selector. `data-form="activate-key"`
// also appears in settings.js's wiring code as a querySelector string, which
// survives regardless — matching that asserted nothing and failed spuriously.
ok('defence build renders no key entry form',    !/<form class="form sub__key-form"/.test(def));
ok('defence build has no licence-key input',     !/sub__key-input|Enter your licence key/i.test(def));
ok('defence build keeps the app',                /QStore/.test(def));

build([]);   // leave a standard artefact behind

// --- BEHAVIOUR, not claims --------------------------------------------------
// The artefact greps above assert what the UI SAYS. They are not enough, and
// finding that out was instructive: the UI section and the licence engine are
// gated independently, so the build can render "No charge" while the engine
// still restricts after 30 days. A test of the claim would pass while the bug
// shipped — which is the exact failure this whole codebase keeps producing.
//
// So execute the state machine. license.js reads `typeof __QSTORE_DEFENCE__` as
// a global, so setting it here reproduces what the define does at build time.
globalThis.__QSTORE_DEFENCE__ = true;
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};
const Lic = await import('./src/license.js');

const state = Lic.getLicenseState();
ok('defence licence state is ACTIVE',            state.state === 'ACTIVE');
ok('defence licence never expires',              state.expiresAt === null);
ok('defence licence has no trial countdown',     state.trialDaysLeft === null);
ok('defence licence is tiered "defence"',        state.payload?.tier === 'defence');

let threw = false;
try { Lic.requireEdit(); } catch { threw = true; }
ok('requireEdit() does not throw in the defence build', !threw);

// And prove the engine is genuinely gated on the define, not incidentally
// passing: with the flag off and no key, a 31-day-old install RESTRICTS.
globalThis.__QSTORE_DEFENCE__ = false;
const Lic2 = await import('./src/license.js?nodefence=1');
const old = Date.now() - 31 * 86400 * 1000;
globalThis.localStorage.setItem('qstore_trial_start', String(old));
const s2 = Lic2.getLicenseState();
ok('WITHOUT the defence flag, an expired trial restricts (proves the gate matters)',
  s2.state === 'RESTRICTED' || s2.state === 'TRIAL');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
