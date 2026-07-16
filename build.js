#!/usr/bin/env node
// =============================================================================
// QStore IMS v2 — Build script
// =============================================================================
// Bundles src/ui/shell.js (and everything it imports, including hash-wasm)
// into a single JS string, reads qstore.css, reads index.html as a template,
// and produces dist/qstore.html — a self-contained file that can be opened
// directly via file:// without any server.
//
// Modes:
//   node build.js           Production build, minified, no source map.
//   node build.js --dev     Development build, not minified, inline source map.
//   node build.js --watch   Watches sources, rebuilds on change (dev mode).
//
// Output:
//   dist/qstore.html        Single-file artefact for shipping.
//
// Notes on bundling:
//   - format: 'iife' wraps everything in a function expression so the bundle
//     can sit inside a plain <script> tag (no type="module" needed).
//   - target: modern browsers — Chrome 90+, Firefox 90+, Safari 15+, Edge 90+.
//     This matches what we need for IndexedDB, crypto.subtle, ESM, and
//     async/await without transpilation overhead.
//   - hash-wasm bundles its WASM as inlined base64 — no .wasm file emitted,
//     no special plugin needed. The bundle is genuinely single-file.
//
// Notes on inlining:
//   - The dev HTML uses an importmap to resolve 'hash-wasm' to the esm.sh
//     CDN. The bundled HTML doesn't need the importmap — esbuild has already
//     resolved that import to bundled code. The build strips the importmap.
//   - <script type="module"> in dev → plain <script> in production, since
//     IIFE doesn't need module semantics.
//   - <link rel="stylesheet" href="qstore.css"> → inline <style> block.
// =============================================================================

import * as esbuild from 'esbuild';
import { readFile, writeFile, mkdir, stat, readdir, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

const isWatch = process.argv.includes('--watch');
const isDev   = process.argv.includes('--dev') || isWatch;
const isDist  = process.argv.includes('--dist');  // distribution build — no GitHub Pages output

// --defence builds the Defence/cadet variant: cloud sync is COMPILED OUT, not
// merely disabled. src/cloud.js and src/sync.js are resolved to their stubs, so
// @azure/msal-browser and the Microsoft Graph calls never enter the bundle.
//
// Why compile-out rather than the existing 'cloud.disabled' setting: a setting
// is a runtime claim ("we turned it off"), which a reviewer has to take on
// trust and an operator can flip back. Compiling it out makes "this build has
// no cloud egress path" a property of the artefact, verifiable by grepping it —
// which is exactly what test-defence-build.mjs does.
//
// Driver: Defence Youth Manual Pt 2 S4 Ch4 para 4.4.5(c) — ADF Cadets ICT
// systems must be hosted in Defence-approved data centres or ASD-approved
// cloud. A consumer M365 tenant is neither.
const isDefence = process.argv.includes('--defence');

// --recipient="Unit Name" embeds the unit name in the filename and dist log.
const recipientArg = process.argv.find(a => a.startsWith('--recipient='));
const RECIPIENT = recipientArg ? recipientArg.split('=').slice(1).join('=').trim() : null;

const ENTRY      = join(__dirname, 'src/ui/shell.js');
const CSS_FILE   = join(__dirname, 'qstore.css');
const HTML_IN    = join(__dirname, 'index.html');
const DIST_DIR   = join(__dirname, 'dist');
const HTML_OUT   = join(__dirname, 'dist/qstore.html');
const PAGES_OUT  = join(__dirname, 'docs/index.html');   // GitHub Pages entry — never written by --dist
const DIST_LOG   = join(__dirname, 'DIST_LOG.md');

// Unique per-build fingerprint — stamped into the JS bundle and HTML meta tags.
// Keep a log of which build ID was distributed to which unit so you can trace
// any unauthorised copy back to its source.
function _generateBuildId() {
  const now  = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = randomBytes(4).toString('hex').toUpperCase();
  return `${date}-${rand}`;
}
function _buildTimestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

const BUILD_ID = isDev ? 'dev' : _generateBuildId();
const BUILD_TS = isDev ? 'dev' : _buildTimestamp();

/**
 * Redirect cloud.js / sync.js to their stubs in the Defence build.
 *
 * An esbuild `alias` won't do here: the same module is imported by different
 * specifiers depending on the importer's depth ('./cloud.js' from sync.js,
 * '../cloud.js' from ui/settings.js), and alias matches the specifier as
 * written. onResolve matches the resolved shape instead, so every importer is
 * covered regardless of relative depth.
 *
 * The filter requires a path separator before the name, so 'sync-keyring.js'
 * and 'csv-import.js' are untouched.
 */
const defenceStubPlugin = {
  name: 'defence-stub-cloud',
  setup(build) {
    build.onResolve({ filter: /\/(cloud|sync)\.js$/ }, (args) => {
      // Don't rewrite the stubs' own resolution back onto themselves.
      if (args.importer.includes('.stub.js')) return null;
      const which = args.path.endsWith('/cloud.js') ? 'cloud' : 'sync';
      return { path: join(__dirname, `src/${which}.stub.js`) };
    });
  },
};

const ESBUILD_OPTS = {
  entryPoints: [ENTRY],
  bundle: true,
  minify: !isDev,
  sourcemap: isDev ? 'inline' : false,
  format: 'iife',
  globalName: 'QStoreApp',
  target: ['chrome90', 'firefox90', 'safari15', 'edge90'],
  legalComments: 'none',
  write: false,        // we want the bytes back, not a file on disk
  logLevel: 'warning', // suppress info chatter, keep warnings + errors
  plugins: isDefence ? [defenceStubPlugin] : [],
  // Inject build-time constants into the bundle as string literals.
  // These survive minification and make every build uniquely identifiable.
  define: {
    __QSTORE_BUILD_ID__: JSON.stringify(BUILD_ID),
    __QSTORE_BUILD_TS__: JSON.stringify(BUILD_TS),
    __QSTORE_DEFENCE__:  JSON.stringify(isDefence),
  },
};

// -----------------------------------------------------------------------------
// Inline the bundled JS and the CSS into the HTML shell.
// -----------------------------------------------------------------------------

async function buildOnce() {
  const start = Date.now();

  const result = await esbuild.build(ESBUILD_OPTS);
  const jsBundle = result.outputFiles[0].text;

  // Sanity check — the IIFE format does NOT support runtime require(), so
  // any URL import that survived bundling will throw "Dynamic require of
  // <url> is not supported" at load time in a browser. esbuild generates
  // a __require shim for these and they only show up at runtime.
  // Catching this here gives a clear failure with the offending URL
  // instead of a baffling browser console error.
  if (jsBundle.includes('Dynamic require of ')) {
    const match = jsBundle.match(/Dynamic require of\s*"\s*\+\s*[A-Za-z_]\w*\s*\+\s*"\)?[^\n]*/);
    const allUrls = [...jsBundle.matchAll(/['"`](https?:\/\/[^'"`\s]+)['"`]/g)]
      .map(m => m[1])
      .filter(u => /(esm\.sh|cdn\.|unpkg|jsdelivr|skypack)/i.test(u));
    const offenders = [...new Set(allUrls)];
    throw new Error(
      'Build produced a bundle with unresolved URL imports. ' +
      'esbuild can\'t bundle remote modules — change the import to a bare ' +
      'package name (e.g. "hash-wasm") and let npm resolve it.' +
      (offenders.length ? `\nLikely culprits:\n  - ${offenders.join('\n  - ')}` : '') +
      '\nCheck src/*.js for any import statements with "https://" URLs.'
    );
  }

  const cssSource = await readFile(CSS_FILE, 'utf8');
  const indexHtml = await readFile(HTML_IN,  'utf8');

  const html = inlineIntoHtml(indexHtml, cssSource, jsBundle, BUILD_ID, BUILD_TS);

  await mkdir(DIST_DIR, { recursive: true });

  if (isDist) {
    // Distribution build — write to dist/<unit-slug>/, never touch docs/.
    const slug = RECIPIENT
      ? RECIPIENT.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
      : 'unit';

    // Each recipient gets its own subdirectory under dist/.
    const unitDir = join(DIST_DIR, slug);
    await mkdir(unitDir, { recursive: true });

    // Remove any previous dist builds for this recipient before writing the new one.
    try {
      const existing = (await readdir(unitDir))
        .filter(f => f.startsWith(`qstore-${slug}-`) && f.endsWith('.html'));
      for (const f of existing) {
        await unlink(join(unitDir, f));
        console.log(`  removed old: ${f}`);
      }
    } catch { /* unit dir may not exist yet — handled above */ }

    const distFile = join(unitDir, `qstore-${slug}-${BUILD_ID}.html`);
    await writeFile(distFile, html);
    await _appendDistLog(distFile, slug);
    console.log(`✓ ${distFile}`);
    console.log(`  full path: ${resolve(distFile)}`);
    console.log(`  build ID: ${BUILD_ID}  (${BUILD_TS})`);
    if (RECIPIENT) console.log(`  recipient: ${RECIPIENT}`);
    console.log('  GitHub Pages copy: NOT updated (--dist mode)');
  } else {
    // Normal build — update both dist/qstore.html and docs/ (GitHub Pages).
    await mkdir(dirname(PAGES_OUT), { recursive: true });
    await Promise.all([
      writeFile(HTML_OUT,  html),
      writeFile(PAGES_OUT, html),
    ]);
  }

  // Sanity check — verify the argon2 encoded-output template literal survived
  // the inline step intact. The literal in hash-wasm's bundled output looks
  // like `$argon2${...}$v=19$${...}$${...}$${...}` and produces strings of
  // the form "$argon2id$v=19$m=...$<salt>$<hash>". If the inline step uses
  // String.prototype.replace with a string replacement (rather than a function
  // replacement), '$$' inside the bundle gets collapsed to '$', destroying the
  // separator dollars and silently corrupting every argon2 hash this build
  // ever produces. See the comment in inlineIntoHtml above.
  const argonTemplate = html.match(/`\$argon2\$\{[^`]*?`/);
  if (argonTemplate) {
    const tpl = argonTemplate[0];
    // Each substitution after $v=19 should be preceded by a literal $.
    // We expect at least three '$$' sequences inside the template body.
    const dollarSubs = (tpl.match(/\$\$\{/g) || []).length;
    if (dollarSubs < 3) {
      throw new Error(
        'Build sanity check failed: hash-wasm argon2 template literal is corrupted.\n' +
        '  Expected at least 3 "$${" sequences (separator dollars before substitutions).\n' +
        '  Found: ' + dollarSubs + '\n' +
        '  Template: ' + tpl + '\n' +
        'This is almost certainly the String.prototype.replace "$$ collapses to $" trap.\n' +
        'Verify that inlineIntoHtml uses a function replacer, not a string replacer.'
      );
    }
  }

  // Wire up the IIFE entry call. The bundled IIFE assigns its exports to
  // the global QStoreApp; we then call boot() on document load.
  const ms = Date.now() - start;
  const sizeKb = (html.length / 1024).toFixed(1);
  const jsKb   = (jsBundle.length / 1024).toFixed(1);
  const cssKb  = (cssSource.length / 1024).toFixed(1);

  if (!isDist) {
    console.log(`✓ ${HTML_OUT} — ${sizeKb} KB (${ms} ms)`);
    console.log(`✓ ${PAGES_OUT} — (GitHub Pages copy)`);
    console.log(`  js: ${jsKb} KB${isDev ? ' (with inline source map)' : ' (minified)'}`);
    console.log(`  css: ${cssKb} KB`);
    if (!isDev) console.log(`  build ID: ${BUILD_ID}  (${BUILD_TS})`);
  }
  return { sizeBytes: html.length, ms };
}

// -----------------------------------------------------------------------------
// Distribution log — appends one line per dist build to DIST_LOG.md
// -----------------------------------------------------------------------------

async function _appendDistLog(filePath, slug) {
  const { appendFile } = await import('node:fs/promises');
  const { basename } = await import('node:path');
  let existing = '';
  try { existing = await readFile(DIST_LOG, 'utf8'); } catch { /* first entry */ }
  const header = existing.trim() === ''
    ? '# QStore IMS — Distribution Log\n\n| Date (UTC) | Build ID | Recipient | File |\n|---|---|---|---|\n'
    : '';
  const line = `| ${BUILD_TS} | \`${BUILD_ID}\` | ${RECIPIENT || slug} | ${basename(filePath)} |\n`;
  await appendFile(DIST_LOG, header + line, 'utf8');
}

// -----------------------------------------------------------------------------
// Inline the bundled JS and the CSS into the HTML shell.
// -----------------------------------------------------------------------------

function inlineIntoHtml(html, css, js, buildId, buildTs) {
  // 0) Inject copyright meta tags and a fingerprint comment into <head>.
  //    These survive copy/paste of the HTML file and are indexed by search
  //    engines, making authorship discoverable and legally defensible.
  const metaTags = [
    `<meta name="author" content="Sean Scales">`,
    `<meta name="copyright" content="© 2025 Sean Scales. All rights reserved.">`,
    `<meta name="generator" content="QStore IMS Build ${buildId}">`,
    `<meta name="license" content="Proprietary — redistribution and modification prohibited without written consent. Contact: admin@seanscales.com.au">`,
  ].join('\n  ');
  const fingerprintComment =
    `\n  <!-- QStore IMS v2 | Author: Sean Scales | Build: ${buildId} | Built: ${buildTs} | © 2025 Sean Scales. All rights reserved. Proprietary software — unauthorised copying or modification is prohibited. admin@seanscales.com.au -->`;
  html = html.replace('</head>', `  ${metaTags}${fingerprintComment}\n</head>`);

  // 1) Replace the <link rel="stylesheet" href="qstore.css"> with an inline
  //    <style> block. Match permissively to allow attribute order variation.
  const linkRe = /<link\s+rel="stylesheet"\s+href="qstore\.css"\s*\/?>/i;
  if (!linkRe.test(html)) {
    throw new Error('Expected <link rel="stylesheet" href="qstore.css"> in index.html — build cannot proceed.');
  }
  // Use a function replacer to avoid String.prototype.replace's $-pattern
  // interpretation. CSS rarely contains '$' but a function replacer is safer
  // and the cost is zero.
  html = html.replace(linkRe, () => `<style>\n${css}\n</style>`);

  // 2) Strip the dev importmap. After bundling, no bare imports remain;
  //    the importmap only exists to make the dev HTML work without a build.
  html = html.replace(/[\t ]*<script[^>]*type="importmap"[^>]*>[\s\S]*?<\/script>\s*\n?/i, '');

  // 3) Replace the <script type="module">…boot()…</script> with the bundled
  //    IIFE plus a tiny boot call. The bundled IIFE assigns its exports to
  //    the global QStoreApp (configured via globalName above).
  const moduleRe = /<script\s+type="module">[\s\S]*?<\/script>/i;
  if (!moduleRe.test(html)) {
    throw new Error('Expected <script type="module"> entry in index.html — build cannot proceed.');
  }
  const inlineScript = `<script>\n${js}\nQStoreApp.boot(document.getElementById('app'));\n</script>`;
  // CRITICAL: Use a function replacer (not a string replacer) so that '$' in
  // the bundled JS is treated literally. String.prototype.replace interprets
  // '$$' / '$&' / '$1' / etc. in replacement strings as special patterns; this
  // mangles template literals like `$${X}$${Y}` (which appear in hash-wasm's
  // argon2 encoded-output builder) into `${X}${Y}` — silently corrupting every
  // generated argon2 hash. We hit this on PIN hashes; debugging took hours.
  // See: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/replace#specifying_a_string_as_the_replacement
  html = html.replace(moduleRe, () => inlineScript);

  return html;
}

// -----------------------------------------------------------------------------
// Watch mode
// -----------------------------------------------------------------------------
// esbuild's context API has its own watch, but it only watches files that
// esbuild itself imports — meaning changes to qstore.css or index.html
// won't trigger a rebuild. We use Node's built-in fs watching instead, so
// any change in src/, qstore.css, or index.html triggers a rebuild.

async function watch() {
  await buildOnce();
  const { watch: fsWatch } = await import('node:fs');
  let pending = false;
  let timer = null;

  const onChange = () => {
    if (pending) return;
    pending = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        await buildOnce();
      } catch (err) {
        console.error('✗ build failed:', err.message || err);
      } finally {
        pending = false;
      }
    }, 100);
  };

  fsWatch(join(__dirname, 'src'),     { recursive: true }, onChange);
  fsWatch(CSS_FILE, onChange);
  fsWatch(HTML_IN,  onChange);
  console.log('Watching src/, qstore.css, index.html for changes. Ctrl+C to stop.');
}

// -----------------------------------------------------------------------------
// Pre-flight checks — fail fast with a clear message if something obvious is wrong
// -----------------------------------------------------------------------------

async function preflight() {
  for (const path of [ENTRY, CSS_FILE, HTML_IN]) {
    try {
      await stat(path);
    } catch {
      throw new Error(`Missing required file: ${path}`);
    }
  }
}

/**
 * Distribution pre-flight — verifies the working tree is on master, clean,
 * and fully in sync with origin/master before allowing a dist build.
 *
 * A dist build from a dirty or unsynced tree would mean the distributed file
 * doesn't match the tracked codebase, breaking the build-ID traceability
 * guarantee. Abort early with a clear message rather than silently shipping
 * the wrong version.
 */
function preflightDist() {
  const git = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

  // 1 — Must be on master.
  let branch;
  try {
    branch = git('git rev-parse --abbrev-ref HEAD');
  } catch {
    throw new Error(
      '--dist aborted: unable to determine git branch.\n' +
      'Ensure this is a git repository before building a distribution.'
    );
  }
  if (branch !== 'master') {
    throw new Error(
      `--dist aborted: working tree is on branch '${branch}', not 'master'.\n` +
      'Switch to master (git checkout master) before building a distribution.'
    );
  }

  // 2 — No uncommitted changes (staged or unstaged).
  let status;
  try {
    status = git('git status --porcelain');
  } catch {
    throw new Error('--dist aborted: unable to check git status.');
  }
  if (status) {
    throw new Error(
      '--dist aborted: working tree has uncommitted changes.\n' +
      'Commit or stash all changes before building a distribution:\n' +
      status
    );
  }

  // 3 — Local HEAD must match origin/master (no unpushed or unpulled commits).
  let localHead, remoteHead;
  try {
    localHead  = git('git rev-parse HEAD');
    remoteHead = git('git rev-parse origin/master');
  } catch {
    console.warn('  ⚠  Could not read origin/master ref — skipping remote sync check.');
    return;
  }
  if (localHead !== remoteHead) {
    // Determine direction so the error message is actionable.
    let direction = 'out of sync';
    try {
      const aheadCount  = Number(git(`git rev-list origin/master..HEAD --count`));
      const behindCount = Number(git(`git rev-list HEAD..origin/master --count`));
      if (aheadCount > 0 && behindCount === 0) direction = `${aheadCount} commit(s) ahead of origin/master — push before distributing`;
      else if (behindCount > 0 && aheadCount === 0) direction = `${behindCount} commit(s) behind origin/master — pull before distributing`;
      else direction = 'diverged from origin/master — resolve the conflict before distributing';
    } catch { /* use generic message */ }
    throw new Error(
      `--dist aborted: local master is ${direction}.\n` +
      `  local:  ${localHead.slice(0, 7)}\n` +
      `  remote: ${remoteHead.slice(0, 7)}\n` +
      'Ensure git push/pull is complete so the distributed file matches the repository.'
    );
  }

  console.log(`  ✓ master @ ${localHead.slice(0, 7)} — in sync with origin/master`);
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

try {
  await preflight();
  if (isDist) preflightDist();
  if (isWatch) {
    await watch();
  } else {
    await buildOnce();
  }
} catch (err) {
  console.error('✗ build failed:', err.message || err);
  process.exit(1);
}
