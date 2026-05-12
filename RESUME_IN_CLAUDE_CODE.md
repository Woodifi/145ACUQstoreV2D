# Resuming in Claude Code

This project was developed in Claude.ai chat through about a dozen sessions
of feature work. Continuing in Claude Code is significantly more
token-efficient (no system prompt re-load per turn, no auto-summarisation
of context).

## First-time setup

```bash
# 1. Unpack the archive somewhere sensible (e.g. ~/projects/qstore-v2/)
tar -xzf qstore-v2.tar.gz
cd qstore-v2

# 2. Install dependencies
npm install

# 3. Sanity check — run the test suite
for t in test-*.mjs; do echo "=== $t ==="; node "$t"; done
# Should produce 431/431 passing tests across 13 suites.

# 4. Build the bundle
node build.js
# Produces dist/qstore.html — single-file deployable.

# 5. Init git (project hasn't been versioned)
git init
git add .
git commit -m "Initial commit — v2.1 (pre-AB189)"
```

## Starting a Claude Code session

```bash
cd ~/projects/qstore-v2
claude

# In Claude Code, first message:
```

Paste the following as your first message to Claude Code so it has context:

---

I'm continuing development of QStore IMS v2, an inventory management system for Australian Army Cadet unit Q-stores. Built as a single-file HTML/JS deployable using esbuild bundling.

**Project state (as of last session):** v2.1 feature-complete except for these
remaining items, in priority order:

1. **AB189 Equipment Request PDF** — half session. Different from the
   Issue Voucher we already built; this is the pre-issue request form
   the cadet fills + QM/CO sign before issue. Lives in `src/pdf.js`,
   same style as the other generators.
2. **Unit logo upload** — half session. Image upload in Settings,
   render in shell header top-left.
3. **QR code print** — half session. Per-item QR codes containing NSN
   or item ID. Needs a small QR library (~30KB).
4. **QR code scan** — full session. Camera access via getUserMedia,
   scan to find item. Permission-prompt UX is the tricky part.

**Read these first to orient yourself:**
- `docs/ARCHITECTURE.md` — module map, schemas, design decisions
- `docs/CHANGELOG.md` — every feature shipped, with rationale
- `package.json` — dependencies (hash-wasm, jspdf, papaparse, msal-browser)

**Coding patterns to follow:**
- One-way module dep: `src/ui/*` imports from `src/*`, never the reverse
- Storage API is the only persistence layer (`src/storage.js`); no
  direct `localStorage` outside that module
- New features get a `test-feature.mjs` smoke test alongside the existing
  suite
- Run `node build.js` after every change; test bundle is `dist/qstore.html`
- Each PDF function in `src/pdf.js` returns `{ filename, blob, bytes }`,
  not a download — the UI layer calls `downloadPdf(result)` separately

**Communication style preference:** be direct, point out problems honestly,
don't oversell ideas. If something seems wrong, say so before fixing.

Start by reading the CHANGELOG and ARCHITECTURE to confirm you understand
the current state, then we'll continue with #1 (AB189 PDF).

---

## What's NOT in this archive

- `node_modules/` — run `npm install` to restore
- `.git/` — initialise yourself with `git init`
- Stray top-level files (`cloud.js`, `migration.js`, `sync.js`, `shell.js`
  at repo root) that were leftovers from refactoring. The canonical
  copies live in `src/`.

## Known v2.2 backlog (deferred deliberately)

These are bigger projects that didn't fit in v2.1:

- **Cadet self-service request workflow** (uses `pendingRequests` store)
- **Cross-store atomic transactions** (currently sequential — risk of
  partial writes on crash)
- **Proper LWW sync fix** (operation-log sync rather than snapshot sync)
- **User management page** (links `users.svcNo` to `cadets.svcNo`,
  enables `viewOwnLoans` filtering)
- **Per-user lockout after N failed PIN attempts**
- **Mobile inventory layout** (currently desktop-only fluent)
- **Toast component** (currently using `alert()` for errors)
- **MSAL 5.x bump** (currently 2.38.3 — API differs)
- **Voucher print audit logging** (PDF generation is currently un-audited)
- **CSV/JSON audit export**
- **Reports hub page** (currently distributed buttons per page)

These are documented in CHANGELOG entries and architecture decisions.

## Test status snapshot

```
test-ranks.mjs:           30/30 ✓
test-unit-branding.mjs:   17/17 ✓
test-export-import.mjs:   23/23 ✓
test-recovery.mjs:        86/86 ✓
test-cadets.mjs:          37/37 ✓
test-loans.mjs:           33/33 ✓
test-audit.mjs:           22/22 ✓
test-pdf.mjs:             32/32 ✓
test-cloud-disable.mjs:    3/3 ✓
test-v1-import.mjs:       36/36 ✓
test-inventory.mjs:       18/18 ✓
test-csv-import.mjs:      68/68 ✓
test-stocktake.mjs:       26/26 ✓
─────────────────────────────────
                         431/431 ✓
```

Bundle: `dist/qstore.html` ~1430 KB (single-file, includes hash-wasm
WASM + jsPDF + PapaParse + all app code).
