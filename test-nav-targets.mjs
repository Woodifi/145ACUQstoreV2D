// Every navigation target must resolve to a page that exists.
//
// Written because a "👥 Cadets" quick-action button survived the removal of the
// Cadets page and shipped in a walkthrough build. It was found by a human
// clicking the dashboard, not by any check I ran.
//
// Why nothing caught it: the sweeps looked for `Storage.cadets`, `borrowerName`,
// `listForCadet` — code-shaped things. A dead nav button is none of those. It is
// the string "cadets" inside an HTML attribute, pointing at a key in a page
// registry. It matched no grep I wrote and no test that existed.
//
// The failure mode is silent: clicking it navigates to an undefined page. No
// error in the source, no build failure — a dead button on the home screen.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, 'src');

let pass = 0, fail = 0;
const ok = (name, cond) => cond
  ? (pass++, console.log(`  ok   ${name}`))
  : (fail++, console.error(`  FAIL ${name}`));

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name))
      : e.name.endsWith('.js') ? [join(dir, e.name)] : []);
}

console.log('=== nav targets ===');

const shell = readFileSync(join(SRC, 'ui/shell.js'), 'utf8');
const block = /const PAGES\s*=\s*(?:Object\.freeze\()?\{([\s\S]*?)\n\}\)?;/.exec(shell);
ok('PAGES registry is parseable', !!block);

const pages = new Set([...block[1].matchAll(/^\s*([a-z]+):\s*\{/gm)].map((m) => m[1]));
ok('PAGES is non-empty', pages.size > 0);
ok('PAGES has no cadets page', !pages.has('cadets'));
ok('PAGES has no requests page', !pages.has('requests'));

const dangling = [];
for (const file of walk(SRC)) {
  const src = readFileSync(file, 'utf8');
  const targets = new Set([
    ...[...src.matchAll(/data-nav="([a-z]+)"/g)].map((m) => m[1]),
    ...[...src.matchAll(/\bnav:\s*'([a-z]+)'/g)].map((m) => m[1]),
  ]);
  for (const t of targets) {
    if (!pages.has(t)) dangling.push(`${file.split('/').pop()} → '${t}'`);
  }
}
if (dangling.length) dangling.forEach((d) => console.error(`       ${d}`));
ok('every nav target resolves to a real page', dangling.length === 0);

// --- empty action containers ------------------------------------------------
// The fingerprint of a button deleted from its container. The cadet CSV
// importer shipped like this: the <button> was removed but the surrounding
// <details><summary>Import cadets from CSV</summary> block survived, with an
// empty form__actions where the button had been. A user opened it, read
// instructions for bulk-importing cadets, and found nothing.
//
// Found by the operator clicking Settings. No grep of mine looked for the
// ABSENCE of something inside a container that still existed.
const emptyActions = [];
for (const file of walk(SRC)) {
  const src = readFileSync(file, 'utf8');
  if (/<div class="form__actions">\s*<\/div>/.test(src)) emptyActions.push(file.split('/').pop());
}
if (emptyActions.length) emptyActions.forEach((f) => console.error(`       ${f}`));
ok('no empty action containers (button removed, wrapper left)', emptyActions.length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
