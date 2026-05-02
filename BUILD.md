# Building QStore IMS

This document explains how to produce the single-file `dist/qstore.html`
deliverable. You only need this if you're shipping a release. For day-to-day
development you can edit source files and reload `index.html` directly — no
build step is required.

## What you get

After running `npm run build`, you get **`dist/qstore.html`** — a single
self-contained file with everything inlined: HTML, CSS, JS, and the WASM blob
needed for argon2id PIN hashing. It can be opened directly via `file://` in
Edge or Chrome and works fully offline once loaded. No web server required.

## One-time setup

Install Node.js 18 or later from https://nodejs.org/ if you don't have it.
Verify with:

```
node --version
npm --version
```

Then in this folder:

```
npm install
```

This downloads two packages (`esbuild` and `hash-wasm`) plus their dependencies
into `node_modules/`. The first install is around 25 MB on disk; subsequent
runs reuse the cache. The folder is gitignored — never commit it.

## Building

Production build (minified, ready to ship):

```
npm run build
```

Development build (not minified, with inline source map for DevTools debugging):

```
npm run dev
```

Watch mode (rebuilds automatically when you edit `src/`, `qstore.css`, or
`index.html`):

```
npm run watch
```

Output is written to `dist/qstore.html`. Expect roughly 250–350 KB for a
production build.

## Day-to-day development

You don't need to build during development. Just run a static server in the
project root and open `index.html`:

```
python3 -m http.server 8000
```

Then visit `http://localhost:8000/`. The dev path uses an importmap to load
`hash-wasm` from the esm.sh CDN at runtime, so changes to source files only
require a reload. This needs internet access on first load (the CDN response
caches in the browser afterwards).

## When to rebuild

- Before shipping a release to a unit
- Before testing what end users will actually run (the bundled file behaves
  slightly differently from the dev path — minification can occasionally
  expose name-collision bugs that the un-minified dev code hides)
- When you've changed `src/auth.js` or anything it imports — the dev path
  pulls hash-wasm from CDN, but the build inlines it, so the bundle is the
  authoritative version

## Known limitations

- **Cloud sync requires a hosted URL.** Microsoft Entra ID requires a
  registered redirect URI for OAuth, and `file://` origins cannot be
  registered. This means the bundled `dist/qstore.html` opened directly via
  `file://` works fully for local-only use, but the cloud sync feature in
  Settings is disabled with an explanatory message. To use cloud sync, host
  the file on a web server — even a one-line `python3 -m http.server 8000`
  in the folder is enough. Local-only operation (no cloud) works fine from
  `file://`.
- **Inline scripts and a strict CSP don't mix.** If a unit's defence-managed
  machine enforces a Content Security Policy that disallows inline scripts
  (`script-src 'self'`), `dist/qstore.html` won't run. There's no fix from our
  end — that environment requires the dev-style multi-file deployment served
  from a real web server.
- **The bundled JS is minified, not obfuscated.** Anyone with DevTools can
  read the source. This is correct for our threat model (we're not protecting
  trade secrets) but worth knowing.
- **Test harness is not bundled.** `tests/test-harness.html` is a development
  tool and stays on the dev path. Run tests against `index.html`'s source
  tree, not against `dist/qstore.html`.
