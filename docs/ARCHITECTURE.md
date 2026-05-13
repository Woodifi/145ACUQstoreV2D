# Architecture

This document describes the shape of QStore IMS v2 — modules, data, and
the not-obvious decisions. It's the reference for someone (or some future
Claude session) opening the codebase cold and needing to make a change
without breaking existing behaviour.

The source of truth for behaviour is the code and tests. This document
describes intent — when intent and code disagree, fix one or the other.

---

## High-level shape

```
v2 source                                v2 deliverable
──────────                               ──────────────
src/*.js (ES modules)                    dist/qstore.html
qstore.css            ──── build.js ──→  (single-file: HTML + CSS + JS +
index.html (entry)                        argon2id WASM, all inlined)
```

`build.js` runs esbuild in IIFE mode to bundle `src/*.js` into a single
`<script>` block, inlines `qstore.css` and the hash-wasm WASM blob as
base64 data URIs, and writes the result to `dist/qstore.html`. The
deliverable runs offline via `file://` in any modern Chromium browser.

Day-to-day development edits source files and reloads `index.html`
directly through a local file:// open or `python3 -m http.server` — no
build step needed. `BUILD.md` documents the release build step.

---

## Module map

```
src/
├── storage.js          IndexedDB layer — sole source of persistence
├── auth.js             PIN auth, sessions, roles, permissions
├── recovery.js         OC PIN recovery codes (one-shot, argon2id)
├── ranks.js            Rank vocabularies, normalisation, person-type inference
├── migration.js        v1 (localStorage JSON) → v2 (IndexedDB) migration
├── sync.js             Cloud sync orchestration (MSAL + Graph + storage merge)
├── cloud.js            MSAL/Graph implementation behind sync.js
├── pdf.js              jsPDF-based document generation (Issue Voucher + reports)
├── csv-import.js       CSV bulk import for items + cadets (DOM-free; UI in src/ui/csv-import.js)
├── conditions.js       Canonical condition list (lifted from ui/inventory.js
│                       so non-UI modules can read it without DOM deps)
└── ui/
    ├── shell.js        App shell — boot, login gating, page registry, nav
    ├── login.js        User picker + PIN keypad + Forgot PIN flow
    ├── inventory.js    Items list, add/edit/delete, photo upload
    ├── cadets.js       Nominal roll: list, add/edit/delete
    ├── loans.js        Issue / Return / All loans (single tabbed page)
    ├── stocktake.js    Stocktake session — counts, variance, finalisation
    ├── audit.js        Audit log viewer (read-only)
    ├── settings.js     Unit details, OC PIN recovery, cloud, data export/import
    ├── csv-import.js   CSV import preview + commit flow (UI for src/csv-import.js)
    ├── modal.js        openModal() helper used by every page
    ├── photo.js        Image processing pipeline (resize + JPEG encode)
    ├── qr-scan.js      Camera QR scanner — getUserMedia + jsQR decode loop
    └── util.js         esc(), $, $$, render(), date helpers, ObjectURLPool
```

**One-way dependency rule:** `src/ui/*` imports from `src/*` (storage,
auth, recovery, ranks, sync). Nothing in `src/*` imports from `src/ui/*`.
This keeps the data layer reusable and testable in Node without DOM.

**`shell.js` is the only module that knows about page registration.**
Each page module exports `mount(rootEl)` returning an `unmount()`
function. Adding a page is a one-line change to the `PAGES` constant in
`shell.js` plus the new module. Pages should not import each other; if
two pages need the same logic, lift it into `src/`.

---

## Storage — the IndexedDB layer

`src/storage.js` is the sole gateway to persisted state. Every other
module talks to data through it, never to IndexedDB directly.

### Stores

| Store | Key | Indexes | Purpose |
|---|---|---|---|
| `meta` | `key` | — | Install ID, audit HMAC key, schema version |
| `settings` | `key` | — | Unit branding, cloud config |
| `counters` | `key` | — | Atomic increment for loan refs etc. |
| `items` | `id` | `nsn`, `cat`, `name` | Inventory |
| `photos` | `id` (= item.id) | — | Blob storage for item photos |
| `cadets` | `svcNo` | `surname`, `plt`, `personType` | Nominal roll |
| `loans` | `ref` | `borrowerSvc`, `itemId`, `active`, `dueDate` | Issue records |
| `audit` | `seq` (autoincr) | `ts`, `action`, `user` | Tamper-evident log |
| `users` | `id` | `username` (unique), `svcNo` | Login accounts |
| `pendingRequests` | `id` | `status`, `requestorSvc` | Cadet self-service requests (v2.2) |
| `stocktakeCounts` | `itemId` | — | In-progress stocktake counts |

### Cross-store transactions — known gap

The Storage API exposes per-store transactions but no multi-store
wrapper. Operations that touch multiple stores (issue: items + loans +
audit; return: same) do them sequentially. **If a crash happens between
writes, partial state is possible.** Mitigations:

- Order writes to minimise blast radius. For loan issue: item update
  first (so we don't create an orphan loan), then loan put, then audit
  append. Worst case: missing audit row, but the loan record itself is
  recoverable evidence.
- Re-read items between batch lines to narrow concurrency races.
- This is on the v2.2 backlog as a Storage API change:
  `Storage.transaction([STORES.ITEMS, STORES.LOANS, STORES.AUDIT], fn)`.

### Audit chain

`Storage.audit.append({ action, user, desc })` writes a row containing:

```
{
  seq:    autoincrement integer,
  ts:     ISO timestamp,
  action: 'issue' | 'return' | 'cadet_add' | ... ,
  user:   session.name (or 'system' / 'unknown'),
  desc:   human-readable description,
  prevHash: hex string (HMAC-SHA256 of previous row's hash),
  hash:     hex string (HMAC-SHA256 of this row's content)
}
```

The HMAC key lives in the `meta` store, generated at install time.
`Storage.audit.verify()` walks the chain and reports `{ ok, count,
brokenAt }`. **Tampering — adding, removing, or modifying any row —
breaks the chain at the modification point and every row after it.**

This is integrity, not confidentiality. Anyone with read access to
IndexedDB can read the audit log. The chain proves "no one has tampered
with this log since install" given the HMAC key is intact.

### Counters

`Storage.counters.next(key, startAt = 1000)` atomically increments and
returns. Used for loan refs (`LN-NNNN`). The transaction wraps a
read+write on the single counter row, so it's safe within a single tab.
Cross-tab safety relies on IndexedDB's serialisation of writes per
store. Cross-device safety relies on cloud sync resolving the counter
on pull — naive LWW today, see sync section below.

---

## Auth and permissions

`src/auth.js` owns sessions, role checks, and PIN management.

### PIN storage

Argon2id via `hash-wasm`. Parameters:

```
parallelism: 1
iterations:  3
memorySize:  64 MB (= 64 * 1024 KB)
hashLength:  32
```

≈250 ms per hash on commodity hardware. Stored as the encoded form
(`$argon2id$v=19$m=65536,t=3,p=1$<salt>$<hash>`) in `user.pinHash` with
algorithm tag `user.pinHashAlgorithm = 'argon2id'`. Legacy v1 users had
plaintext PINs hashed by DJB2; migration re-hashes them with argon2id
on first successful login.

**Honest framing on PIN security.** A 4-digit PIN has ~13 bits of
entropy. Argon2id at these parameters means an offline attacker can
test ~4 PINs/sec — ~40 minutes to brute-force the entire keyspace.
Argon2id therefore protects against IndexedDB exfiltration scenarios
(disk image, browser data theft) where the attacker has the hash but
no oracle to test online. It does NOT meaningfully protect against an
in-person attacker who can shoulder-surf or repeatedly guess. The
threat model is "casual snooping by other unit members on a shared
laptop," not "determined adversary with the device."

### Roles

```
co     — All permissions ('all')
qm     — view, issue, return, addItem, editItem, manageCadets,
         reports, audit, qr, import, requestIssue
staff  — view, viewOwnLoans, requestIssue, reports
cadet  — view, viewOwnLoans, requestIssue, reports
ro     — view, requestIssue, reports
```

The `co` role key remains internal even after the OC label rename;
display labels are `'OC'` everywhere. AB189 forms are in-unit (battalion
requests use CadetNet pro-formas), so OC + QM signatures are sufficient
for the physical paperwork.

**Defence-in-depth pattern.** Every permission check happens twice: once
in the UI (hide buttons, gate nav) and once in the handler
(`AUTH.requirePermission(perm)` throws). The handler check defends
against stale UI, DevTools tampering, and programmatic clicks.

### Recovery codes

OC accounts get a 12-char recovery code at first non-default PIN-set
(see `src/recovery.js`). The code is shown once, hashed with argon2id,
and stored in `user.recoveryHash`. Successfully using a code consumes
the hash (one-shot semantics). Settings page can regenerate, which
invalidates the prior code.

We can't show an existing code's plaintext because we only store the
hash — the "retrievable" surface is therefore actually "regeneratable",
with a confirmation that the previous code becomes invalid. This is
honest about what the storage allows, rather than weakening the storage
to permit retrieval.

### Sessions

In-memory session object, mirrored to `sessionStorage` for tab restore.
Logout clears both. There's no remember-me; closing the browser ends the
session. Multi-tab sessions don't share state — each tab has its own
session derived from `sessionStorage`.

---

## Migration: v1 → v2

`src/migration.js` exposes two paths from v1:

**`runFromObject(v1, opts)`** — file-based import. Takes a parsed v1 export
JSON object (the same shape v1 wrote to localStorage as `qstore_data`),
optionally wipes existing v2 stores, then runs per-entity migration:
items+photos, cadets, loans, users, requests, stocktake, audit log. The
audit log entries get re-chained under v2's HMAC key and flagged
`imported: true`. Triggered from the Settings → Data → "Import data from
a v1 backup file" UI. **This is the supported v2.1 path.**

**`run()` + `check()` + `exportV1Backup()`** — same-origin/same-browser
auto-migration. Reads from `localStorage`, including the OneDrive config
that lives under a separate key. Code is present and tested at the unit
level but is **not wired into the boot flow** — no UI calls these. Kept
for a possible future "auto-detect v1 on boot" feature; not deletable
without losing capability we may want.

Both paths share the same `_migrate*` per-entity helpers, so behaviour is
identical regardless of which entry point is used. Rank canonicalisation
during migration uses `normalizeRank` from `ranks.js`. The cadets page
form uses the same function so manual entry and migrated entries produce
identical canonical forms.

The migration writes a flag (`migrationFromV1`) into the meta store on
success. `check()` short-circuits on that flag. `runFromObject` writes
the flag too (with `source: 'v1_file_import'`) but does not refuse to
re-run — re-running with `wipeFirst: true` is a deliberate clean-slate
re-import, which we don't want to block.

---

## Cloud sync

`src/sync.js` and `src/cloud.js` together implement OneDrive sync via
MSAL Browser 2.38.3 and Microsoft Graph. The OC signs in to a Microsoft
account, picks a OneDrive folder; the app reads/writes a single
`qstore-data.json` blob there.

### Sync model — the time bomb

Last-write-wins. On push, the local snapshot overwrites the cloud blob.
On pull, the cloud blob overwrites local. There is **no merge, no
conflict detection, no field-level reconciliation.**

For a single-QM-laptop unit this is fine. For two QMs editing on
different devices simultaneously, the second to push overwrites the
first's changes silently. The only safety net is the audit log being
append-only — by inspecting the audit chains pre-merge you could
manually reconcile, but the app doesn't do this for you.

This is the largest architectural debt in v2. Fixing properly needs:
- Operation-log sync rather than snapshot sync (each device sends its
  audit-log delta, the receiver replays missing operations).
- Conflict detection on counters (loan refs in particular).
- Optimistic UI with rollback on conflict.

**Status update (May 2026):** Brigade ITSO has confirmed AAC units may
use unit-owned cloud storage (personal Microsoft accounts, family M365,
or unit-purchased M365 Business) but **not** defence-issued M365 tenants.
The MSAL/Graph code path stays. The cloud settings UI now carries a
standing policy notice (see Deployment notes below) and a kill-switch
toggle for environments where cloud sync should be off entirely. The
deeper LWW fix is still backlogged for v2.2.

### MSAL specifics

MSAL Browser 2.38.x is the version pinned. 5.x has a different API
surface and would need a small rewrite. Pinned to 2.x for now to keep
moving.

### Deployment notes — defence-environment policy

**Rule (from brigade ITSO, May 2026):** AAC units may use unit-owned
cloud storage for Q-Store data. Defence-issued M365 tenants are not
approved for this tool.

**What "unit-owned" means in practice:**

- A personal Microsoft account (`@outlook.com`, `@hotmail.com`,
  `@live.com`).
- A family M365 subscription owned by a unit member.
- A unit-purchased Microsoft 365 Business subscription where the unit
  (or its parent association/charity) is the tenant owner.

**What it doesn't mean:**

- A defence-issued account in a defence M365 tenant
  (`*.defence.gov.au`, `*.dpe.protected.mil.au`, etc.).
- Any account where the tenant admin is Defence rather than the unit.

**What the app does to support this:**

- A standing policy notice in the cloud settings section makes the rule
  explicit. Every QM who reaches the cloud configuration UI sees it.
- A "Disable cloud sync entirely" toggle hides the cloud UI and stops
  the sync engine, for deployments where cloud sync is policy-prohibited
  (e.g. a borrowed defence laptop, or a unit that simply prefers local
  only).
- The disabled state is the kill-switch — `_shouldAutoSync` returns
  false unconditionally when `cloud.disabled === true` in settings.

**What the app deliberately does NOT do:**

- Detect defence accounts via tenant ID or domain heuristics. False
  positives in policy warnings teach users to ignore them; the tenant
  list isn't ours to maintain. The QM is the policy enforcer; the app
  surfaces the rule.
- Block specific Microsoft tenants from the MSAL flow. The auth flow
  uses the standard `common` authority — we accept whatever account
  the user signs in with. Their account choice is their compliance
  decision.

---

## UI conventions

### Page lifecycle

```js
export async function mount(rootEl) {
  // setup
  return function unmount() {
    // teardown — revoke object URLs, drop listeners on _root, etc.
  };
}
```

Shell calls `mount(rootEl)` when navigating to the page, and the
returned `unmount()` when navigating away. Pages should not retain
references to `rootEl` across unmount.

### Permission gating in pages

Every action handler that mutates state calls
`AUTH.requirePermission(perm)` at the top. UI hides the corresponding
button when `AUTH.can(perm)` is false. Both are required.

### Form patterns

Forms live inside `openModal({ bodyHtml, onMount })` for add/edit/delete
flows. The `onMount` callback wires submit handlers; modals close
themselves via the `close` argument or `data-action="modal-close"`
buttons. Form errors render inside `<div class="form__error">` slots.

### Audit logging from UI handlers

After a successful state mutation, the handler appends an audit row
with a stable action key and a description containing the user-readable
identifier of the affected record:

```js
await Storage.audit.append({
  action: 'cadet_update',
  user:   AUTH.getSession()?.name || 'unknown',
  desc:   `Updated cadet: ${rank} ${surname} (${svcNo})`,
});
```

Action keys must be stable — they're indexed and become the basis for
the audit log viewer's filter UI. Adding a new action means adding it to
the table below.

### Action key registry

| Action | Module | Description format |
|---|---|---|
| `add` | inventory | "Added: \<name\> — \<onHand\> units (Auth: \<authQty\>)" |
| `adjust` | inventory | "Updated item: \<name\>" / "Deleted item: ..." / "Photo updated for ..." |
| `cadet_add` | cadets | "Added cadet: \<rank\> \<surname\> (\<svcNo\>)" |
| `cadet_update` | cadets | "Updated cadet: \<rank\> \<surname\> (\<svcNo\>)" |
| `cadet_delete` | cadets | "Deleted cadet: \<rank\> \<surname\> (\<svcNo\>) — reason: \<reason\>" |
| `issue` | loans | "\<ref\>: \<itemName\> × \<qty\> issued to \<borrowerName\> for \<purpose\>" |
| `return` | loans | "\<ref\>: \<itemName\> × \<qty\> returned by \<borrowerName\> — \<condition\>" |
| `pin_change` | auth | "PIN updated for \<username\>." |
| `recovery_set` | auth/settings | "Recovery code generated for \<username\>." |
| `recovery_rotated` | settings | "Recovery code regenerated for \<username\> from settings." |
| `recovery_reset` | auth | "PIN reset for \<username\> via recovery code. ..." |
| `recovery_reset_failed` | auth | "Recovery reset attempted for \<who\>; \<reason\>." |
| `data_export` | settings | "Backup exported." |
| `data_imported` | settings | "Backup restored from \<filename\>." |
| `login` | auth | "Login successful." |
| `logout` | auth | "Logout." |
| `login_failed` | auth | "Failed login attempt for \<userId\>." |

(Future: sync actions, per-user lockout actions.)

---

## Schemas

### User

```
{
  id:                  string (PK, e.g. 'usr-abc123'),
  username:            string (unique, lowercased),
  name:                string (display name),
  role:                'co' | 'qm' | 'staff' | 'cadet' | 'ro',
  pinHash:             string ($argon2id$ encoded),
  pinHashAlgorithm:    'argon2id',
  legacyPinHash:       string?  (DJB2 hex from v1, removed after first re-hash),
  svcNo:               string?  (FK to cadets.svcNo, used for viewOwnLoans),
  recoveryHash:        string?  ($argon2id$ encoded, OC-only),
  recoveryHashAlgorithm: 'argon2id',
  recoveryCreatedAt:   ISO timestamp,
  createdAt:           ISO timestamp,
  lastLogin:           ISO timestamp?,
}
```

### Item (inventory)

```
{
  id:        string (PK, e.g. 'itm-abc123'),
  nsn:       string (free text, no validation),
  name:      string,
  cat:       string (one of CATEGORIES in inventory.js),
  onHand:    int,    // total physical stock
  onLoan:    int,    // currently issued (subset of onHand)
  unsvc:     int,    // unserviceable (subset of onHand)
  authQty:   int,    // authorised quantity for the unit
  condition: 'serviceable' | 'unserviceable' | 'repair'
             | 'calibration-due' | 'written-off',
  loc:       string?,
  notes:     string?,
  hasPhoto:  bool,   // mirror of presence in photos store
  createdAt: ISO timestamp,
  updatedAt: ISO timestamp?,
}
```

Available stock = `onHand - onLoan`. Items can have `onLoan > 0` even
when conditionally unserviceable — the condition is separate from
allocation.

### Cadet

```
{
  svcNo:      string (PK, AAC service number),
  rank:       string (canonicalised via normalizeRank),
  surname:    string (force-uppercased on save),
  given:      string?  (mixed case; v1-compatible field name),
  plt:        string?  (free text: '1', '2', 'HQ' etc.),
  personType: 'cadet' | 'staff'  (derived from rank),
  active:     bool (defaults true),
  email:      string?  (format-validated when non-empty),
  notes:      string?,
  createdAt:  ISO timestamp,
  updatedAt:  ISO timestamp?,
}
```

### Loan (v1-compatible — DO NOT change without migration)

```
{
  ref:             string (PK, 'LN-NNNN'),
  itemId:          string (FK to items.id),
  itemName:        string  (denormalised at issue),
  nsn:             string  (denormalised at issue),
  qty:             int > 0,
  borrowerSvc:     string (FK to cadets.svcNo),
  borrowerName:    string  (denormalised: '<rank> <surname>' at issue),
  purpose:         string (one of PURPOSES in loans.js),
  issueDate:       'YYYY-MM-DD' (local),
  dueDate:         'YYYY-MM-DD',
  condition:       string (item condition copied at issue),
  remarks:         string?,
  active:          bool (true while outstanding),
  // Set on return:
  returnDate:      'YYYY-MM-DD',
  returnCondition: 'serviceable' | 'unserviceable' | 'write-off',
  returnRemarks:   string?,
  // v2 additions (not in v1):
  issuedBy:        string (session user name at issue),
  returnedBy:      string (session user name at return),
}
```

Denormalised name fields (`itemName`, `nsn`, `borrowerName`) are kept on
purpose: if an item is later renamed or a cadet's surname changes, the
historical loan still shows what was issued to whom **at the time**.
AB189 reproduction depends on this.

### Audit row

```
{
  seq:      int (autoincrement, PK),
  ts:       ISO timestamp,
  action:   string (see action key registry),
  user:     string (session user name, 'system', or 'unknown'),
  desc:     string (human-readable),
  prevHash: hex string,
  hash:     hex string,
}
```

### Settings

Free-form key-value store. Conventions:

```
unitName, unitCode, state, qmName, qmRank, qmEmail, coName, coEmail
cloud.clientId, cloud.folder, cloud.filename, cloud.autoSync, cloud.lastSync
cloud.disabled        (new in v2.1 — kill-switch, see Deployment notes)
```

---

## Build and tests

### Build

`node build.js` → `dist/qstore.html` (single file, ~1594 KB at v2.1). The size is dominated by jsPDF; other dependencies add:

| Dependency | Minified size | Purpose |
|---|---|---|
| jsPDF | ~800 KB | PDF generation (offline, no server) |
| jsQR | ~132 KB | QR code decoding (includes Shift-JIS tables) |
| qrcode-generator | ~31 KB | QR code generation for label sheets |
| PapaParse | ~19 KB | CSV import |
| hash-wasm WASM | ~70 KB | Argon2id PIN hashing |

The build inlines:
- All JS modules into one IIFE script (esbuild bundle, minified for prod)
- `qstore.css` in a `<style>` block
- The hash-wasm WASM blob as a base64 data URI inside the script
- All npm dependencies listed above

Output is loadable via `file://` and runs fully offline once loaded.

### Tests

Three layers:

**1. Headless smoke tests** — `test-*.mjs` in repo root. Run with
`node test-<name>.mjs`. Use `fake-indexeddb` for persistence and Node's
`webcrypto` for crypto. Each test self-contained, opens its own DB
(`qstore_test_<name>`) so they don't interfere.

**2. Diagnostic harness** — `Tests/test-harness.html`. Browser-based,
walks Storage CRUD across all stores. Useful for catching schema bugs
that headless tests miss (real IndexedDB vs fake-indexeddb behaviours).

**3. Manual eyes-on UI testing** — no automated harness. Pages with
significant DOM logic (loans batch issue, cadets active-loan blocking)
need human verification before each release.

Running all suites:

```bash
for t in test-ranks test-unit-branding test-export-import \
         test-recovery test-cadets test-loans test-audit test-ab189 \
         test-pdf test-cloud-disable test-v1-import test-inventory \
         test-csv-import test-stocktake test-qr; do
  node ${t}.mjs
done
# Expected: 481/481 across 15 suites
```

---

## Known debt and design tensions

These aren't bugs but they're things future-me should know about.

1. **Cross-store transactions** — see Storage section.
2. **Cloud sync LWW** — see Cloud sync section.
3. **`viewOwnLoans` perm not enforced** — currently the All loans tab
   shows everything to any `view` user. To filter by their cadet
   record, we need a UI for linking `users.svcNo` to `cadets.svcNo`.
   Backlogged for v2.2 with the user management page.
4. **No per-user lockout on failed PIN attempts** — argon2id makes
   offline brute force expensive but in-person guessing is still
   possible. Worth adding a per-user delay-after-N-failures.
5. **Spinner gap on argon2id PIN-set** — ~250 ms blocking, no UI
   feedback. Annoying but not broken.
6. **Mobile inventory layout is desktop-first** — the table doesn't
   reflow well on phones. The cadets and loans pages inherit the same
   problem. Backlogged.
7. **Toast component doesn't exist** — most user feedback is via
   `alert()` or a `.form__error` slot. A real toast widget would
   improve return-tab feedback ("returned 3 items") without a modal.
8. **CAPT(AAC) doesn't classify as staff** — `normaliseRankInput`
   strips whitespace and dots but not parens, so `CAPT(AAC)` falls
   through to `cadet`. Fix is a 2-line ranks.js change but pre-dates
   this work; flagged for a future cleanup.
