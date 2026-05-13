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
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const isWatch = process.argv.includes('--watch');
const isDev   = process.argv.includes('--dev') || isWatch;

const ENTRY    = join(__dirname, 'src/ui/shell.js');
const CSS_FILE = join(__dirname, 'qstore.css');
const HTML_IN    = join(__dirname, 'index.html');
const HTML_OUT   = join(__dirname, 'dist/qstore.html');
const PAGES_OUT  = join(__dirname, 'docs/index.html');   // GitHub Pages entry

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

  const html = inlineIntoHtml(indexHtml, cssSource, jsBundle);

  await mkdir(dirname(HTML_OUT),  { recursive: true });
  await mkdir(dirname(PAGES_OUT), { recursive: true });
  await Promise.all([
    writeFile(HTML_OUT,  html),
    writeFile(PAGES_OUT, html),
  ]);

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

  console.log(`✓ ${HTML_OUT} — ${sizeKb} KB (${ms} ms)`);
  console.log(`✓ ${PAGES_OUT} — (GitHub Pages copy)`);
  console.log(`  js: ${jsKb} KB${isDev ? ' (with inline source map)' : ' (minified)'}`);
  console.log(`  css: ${cssKb} KB`);
  return { sizeBytes: html.length, ms };
}

function inlineIntoHtml(html, css, js) {
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

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

try {
  await preflight();
  if (isWatch) {
    await watch();
  } else {
    await buildOnce();
  }
} catch (err) {
  console.error('✗ build failed:', err.message || err);
  process.exit(1);
}
