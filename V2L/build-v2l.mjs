// =============================================================================
// QStore IMS V2L — Learning Edition Build Script
// =============================================================================
// Builds a sandboxed V2L from the standard V2 source using esbuild defines
// to inject sandbox constants. No source files are duplicated.
//
// Usage:
//   node V2L/build-v2l.mjs
//
// Output:
//   V2L/dist/v2l.html   Self-contained single-file learning environment
//
// Sandbox guarantees:
//   - Separate IndexedDB  (qstore_v2l)   — data never mixes with production
//   - Separate session key               — logins don't bleed across files
//   - Cloud sync disabled                — no OneDrive interaction
//   - License bypassed                   — always Active, no key needed
//   - Sample data pre-loaded on first boot
// =============================================================================

import * as esbuild from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEED } from './seed.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');
const OUT_DIR   = join(__dirname, 'dist');
const OUT_FILE  = join(OUT_DIR, 'v2l.html');

const BUILD_ID = 'V2L-' + new Date().toISOString().slice(0, 10).replace(/-/g, '');
const BUILD_TS = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

// ---------------------------------------------------------------------------
// Serialise seed data for HTML injection
// ---------------------------------------------------------------------------

const SEED_JSON = JSON.stringify(SEED);

// ---------------------------------------------------------------------------
// esbuild — bundle V2 source with V2L sandbox constants
// ---------------------------------------------------------------------------

const result = await esbuild.build({
  entryPoints:  [join(ROOT, 'src/ui/shell.js')],
  bundle:       true,
  minify:       true,
  sourcemap:    false,
  format:       'iife',
  globalName:   'QStoreApp',
  target:       ['chrome90', 'firefox90', 'safari15', 'edge90'],
  legalComments:'none',
  write:        false,
  logLevel:     'warning',
  define: {
    // Standard V2 build constants
    __QSTORE_BUILD_ID__:  JSON.stringify(BUILD_ID),
    __QSTORE_BUILD_TS__:  JSON.stringify(BUILD_TS),
    // V2L sandbox constants — trigger all isolation + bypass logic in V2 source
    __V2L_SANDBOX__:      'true',
    __V2L_DB_NAME__:      '"qstore_v2l"',
    __V2L_SESSION_KEY__:  '"qstore_v2l_session"',
    __V2L_THEME_KEY__:    '"qstore_v2l_theme"',
    // Seed data is injected via HTML script tag (see below) so shell.js reads
    // window.__V2L_SEED__ at runtime — not embedded in the JS bundle.
    // We define __V2L_SEED__ as undefined so typeof checks resolve correctly.
    __V2L_SEED__: 'window.__V2L_SEED__',
  },
});

const jsBundle = result.outputFiles[0].text;

// ---------------------------------------------------------------------------
// HTML assembly
// ---------------------------------------------------------------------------

const [cssSource, indexHtml] = await Promise.all([
  readFile(join(ROOT, 'qstore.css'), 'utf8'),
  readFile(join(ROOT, 'index.html'), 'utf8'),
]);

let html = indexHtml;

// 1. Replace page title
html = html.replace(/<title>[^<]*<\/title>/i, '<title>QStore IMS V2L — Learning Edition</title>');

// 2. Inject meta tags into <head>
const metaTags = [
  `<meta name="description" content="QStore IMS V2L — Learning Edition (sandboxed training environment)">`,
  `<meta name="generator" content="QStore IMS V2L Build ${BUILD_ID}">`,
].join('\n  ');
html = html.replace('</head>', `  ${metaTags}\n</head>`);

// 3. Replace stylesheet link with inline styles
const linkRe = /<link\s+rel="stylesheet"\s+href="qstore\.css"\s*\/?>/i;
html = html.replace(linkRe, () => `<style>\n${cssSource}\n</style>`);

// 4. Strip dev importmap
html = html.replace(/[\t ]*<script[^>]*type="importmap"[^>]*>[\s\S]*?<\/script>\s*\n?/i, '');

// 5. Replace the module entry script with:
//    a) seed data injected as window.__V2L_SEED__
//    b) the bundled IIFE
const moduleRe = /<script\s+type="module">[\s\S]*?<\/script>/i;
const combinedScript = [
  `<script>`,
  `/* V2L Learning Edition — Build ${BUILD_ID} — ${BUILD_TS} */`,
  `/* Sandboxed: separate IDB (qstore_v2l), no cloud sync, always-active license */`,
  `window.__V2L_SEED__ = ${SEED_JSON};`,
  `</script>`,
  `<script>`,
  jsBundle,
  `QStoreApp.boot(document.getElementById('app'));`,
  `</script>`,
].join('\n');
html = html.replace(moduleRe, () => combinedScript);

// ---------------------------------------------------------------------------
// Write output
// ---------------------------------------------------------------------------

await mkdir(OUT_DIR, { recursive: true });
await writeFile(OUT_FILE, html);

const sizeKb = (html.length / 1024).toFixed(1);
console.log(`\n✓ QStore IMS V2L — Learning Edition`);
console.log(`  Output:   ${OUT_FILE}`);
console.log(`  Size:     ${sizeKb} KB`);
console.log(`  Build ID: ${BUILD_ID}  (${BUILD_TS})`);
console.log(`  IDB name: qstore_v2l  (isolated from production)`);
console.log(`  Seed:     ${SEED.cadets.length} cadets, ${SEED.staff.length} staff, ${SEED.items.length} items, ${SEED.loans.length} loans`);
console.log(`\n  Open V2L/dist/v2l.html in your browser to launch.`);
console.log(`  Default login: Administrator — PIN 0000\n`);
