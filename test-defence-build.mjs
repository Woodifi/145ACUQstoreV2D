// Defence build variant — artefact inspection.
//
// This suite does not test source. It builds both variants and greps the
// resulting single-file artefacts, because the claim being made is about the
// BINARY, not about intent:
//
//   "This build cannot write cadet data to third-party cloud storage."
//
// A runtime flag can't support that claim — a reviewer would have to trust it,
// an operator can flip it, and a stale signed-in session can outlive it. A
// build-time substitution can: if graph.microsoft.com isn't in the file, the
// file cannot call it. That is checkable by anyone with grep, including someone
// assessing it who has never seen the source.
//
// Driver: Defence Youth Manual Pt 2 S4 Ch4 para 4.4.5(c).

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, 'dist/qstore.html');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else      { fail++; console.error(`  FAIL ${name}`); }
}

function build(args) {
  execFileSync('node', [join(__dirname, 'build.js'), ...args], {
    cwd: __dirname, stdio: 'pipe',
  });
  if (!existsSync(DIST)) throw new Error('build produced no dist/qstore.html');
  return readFileSync(DIST, 'utf8');
}

console.log('=== defence build variant ===');

// --- standard build: cloud code SHOULD be present --------------------------
// Without this the test proves nothing — an empty grep is meaningless if the
// needle is absent from both builds.
const std = build([]);
ok('standard build contains the Graph endpoint',   std.includes('https://graph.microsoft.com'));
ok('standard build contains the blob filename',    std.includes('qstore_data.json'));
ok('standard build contains MSAL',                 /msal/i.test(std));
ok('standard build renders cloud settings UI',     std.includes('Cloud sync encryption'));

// --- defence build: cloud code MUST be absent ------------------------------
const def = build(['--defence']);

ok('defence build has NO Graph endpoint',          !def.includes('graph.microsoft.com'));
ok('defence build has NO blob filename',           !def.includes('qstore_data.json'));
ok('defence build has NO MSAL',                    !/msal/i.test(def));
ok('defence build has NO OneDrive drive path',     !def.includes('/me/drive/root:'));
ok('defence build has NO Files.ReadWrite scope',   !def.includes('Files.ReadWrite'));
ok('defence build has NO MSAL client id field',    !def.includes('cloud.clientId'));

// --- the app itself still has to work -------------------------------------
ok('defence build still contains the app',         def.includes('QStore'));
ok('defence build keeps PII encryption',           def.includes('~enc:'));
ok('defence build keeps key rotation',             def.includes('keys_rotated'));
ok('defence build states no cloud egress',         def.includes('No cloud egress'));
ok('defence build keeps the rotate control',       def.includes('rotate-keys'));
ok('defence build drops the sync passphrase UI',   !def.includes('Turn on cloud encryption'));

// --- size: MSAL and Graph really are gone, not just unreferenced -----------
ok('defence build is materially smaller than standard', def.length < std.length);
console.log(`       standard ${(std.length / 1024).toFixed(0)} KB  →  defence ${(def.length / 1024).toFixed(0)} KB`
  + `  (−${((1 - def.length / std.length) * 100).toFixed(1)}%)`);

// Leave the tree holding a standard build so a stray --defence artefact can't
// be mistaken for the normal one.
build([]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
