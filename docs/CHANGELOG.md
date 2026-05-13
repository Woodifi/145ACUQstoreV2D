# Changelog

All notable changes to QStore IMS are recorded here. The format is loosely
based on [Keep a Changelog](https://keepachangelog.com/), in reverse
chronological order. Entries are written when the change is shipped, not when
it's planned.

The version stream starts at v2.0 — that's the rewrite from the v1 single-file
HTML monolith into the modular esbuild-bundled v2 architecture. Anything
prior is in git history but not summarised here.

---

## [Unreleased] — v2.1 in progress

### Added — QR code scanner (Item 4)

- `src/ui/qr-scan.js` (new). `openQRScanModal(onFound)` opens a modal with a
  live camera preview and a `requestAnimationFrame` decode loop using `jsQR`.
  On detecting a `QSTORE:<item.id>` payload, stops the camera, closes the
  modal, and calls `onFound(itemId)`.
- Camera permission UX: surfaces distinct messages for `NotAllowedError`
  (permission denied), `NotFoundError` (no camera), `NotSupportedError`
  (insecure context), and generic errors. Works under `file://` (Chrome, Edge
  treat local files as a secure context).
- Gold corner-bracket reticle overlay on the video viewport (CSS only).
- "⌖ Scan" button added to the inventory toolbar alongside "⎙ QR codes",
  gated on `qr` permission. On successful decode, looks up the item in storage
  and opens its edit modal — gives the QM instant access to the item record.
  If the code is from a different unit (item ID not found), surfaces a clear
  alert and takes no further action.
- `parseQStoreCode(text)` exported from `qr-scan.js` for testability; returns
  the item ID from a `QSTORE:<id>` string, or null for anything else (case-
  sensitive prefix match).
- Camera stream is always stopped via `onClose`, regardless of how the modal
  is dismissed (Escape, backdrop click, scan success). No leaks across modal
  open/close cycles.
- Dependency: `jsqr` 1.x. Bundle size increase: ~132 KB (larger than jsQR's
  headline ~40 KB minified because it includes full Shift-JIS decode tables;
  this is unavoidable for correct international QR support).
- `test-qr.mjs` expanded: 11 new `parseQStoreCode` tests (valid codes, non-
  QStore codes, edge cases). Camera integration untestable in Node — manual
  eyes-on required before release.

### Added — QR code label sheet (Item 3)

- `generateQRSheet(items, opts)` added to `src/pdf.js`. Produces an A4 PDF
  of 3×5 QR label cells (15 per page), each showing the QR code, item name
  (up to 2 lines), and NSN. Multi-page for inventories > 15 items.
- QR data encodes `QSTORE:<item.id>` — the `QSTORE:` prefix lets the future
  scan feature distinguish QStore-generated codes from arbitrary barcodes. The
  item ID is always unique; NSN is displayed as human-readable text only.
- QR modules rendered as vector `rect()` calls in jsPDF — crisp at any print
  resolution, no rasterisation step. Quiet zone is provided by the cell padding
  (10 mm on each side for a 40 mm code in a 60 mm cell).
- Dependency: `qrcode-generator` 1.x (pure JS, no DOM/canvas deps; works in
  Node for tests). Bundle size increase: ~31 KB.
- "⎙ QR codes" button added to the inventory toolbar, gated on `qr` permission
  (QM role and above). Prints the currently-filtered view — same scope as
  "⎙ Print stock" on the same toolbar. Handler in `src/ui/inventory.js`.
- `test-qr.mjs` — 15 tests covering single-item, multi-item, multi-page,
  long names, missing NSN, empty input error, no-branding fallback.

### Test status at this point

```
test-ranks.mjs:           30/30 ✓
test-unit-branding.mjs:   17/17 ✓
test-export-import.mjs:   23/23 ✓
test-recovery.mjs:        86/86 ✓
test-cadets.mjs:          37/37 ✓
test-loans.mjs:           33/33 ✓
test-audit.mjs:           22/22 ✓
test-pdf.mjs:             32/32 ✓
test-cloud-disable.mjs:    3/ 3 ✓
test-v1-import.mjs:       36/36 ✓
test-inventory.mjs:       18/18 ✓
test-csv-import.mjs:      68/68 ✓
test-stocktake.mjs:       26/26 ✓
test-qr.mjs:              26/26 ✓
─────────────────────────────────
                         457/457 ✓ across fourteen suites
```

Bundle: `dist/qstore.html` ~1594 KB.



Items shipped from the v2.1 backlog so far. Will be tagged `v2.1.0` once the
remaining items (audit log viewer, AB189 PDF + reports, cloud sync polish)
are complete.

### Added — Loans page (Item 5)

- `src/ui/loans.js` (new). Single page with three internal tabs: **Issue**,
  **Return**, **All loans**. Each tab is independently gated by permission
  (`issue`, `return`, `view`); tabs the user can't access don't render.
- **Issue tab:** borrower picker (search-as-you-type, active cadets only),
  batch line-items (add/remove rows, multi-item single-transaction issue),
  purpose dropdown matching v1's eight options, due date defaulting to
  +14 days, remarks. Sidebar shows the borrower's existing active loans for
  context. Submit creates one loan record per line, all sharing the same
  `issueDate`/`borrower`/`purpose`. Confirmation modal lists fresh loan refs.
- **Return tab:** borrower picker filtered to cadets with active loans only.
  Active loans render as checkbox rows with select-all/clear; overdue rows
  highlighted in red. Condition-on-return dropdown
  (serviceable/unserviceable/write-off) flows through to `item.unsvc`
  (bumped on bad condition) and `item.condition` (flipped to unserviceable
  on write-off, matching v1).
- **All loans tab:** search across ref/item/borrower/NSN/purpose/remarks;
  pill-bar filter (Active / Overdue / Returned / All) with live counts;
  status badges per row; returned rows visually dimmed; sort by issueDate
  desc with ref desc as tiebreaker (keeps batches grouped).
- Loan ref allocator uses `Storage.counters.next('loan', 1000)` →
  `LN-NNNN` format, monotonic across tabs.
- Best-effort race detection: at submit, each line re-reads item stock from
  storage between writes, so concurrent issues from another tab can't
  over-allocate within the batch.
- Audit actions: `issue`, `return`. Both record borrower name, item name,
  qty, and (for returns) the condition.

### Added — Cadets page (Item 4)

- `src/ui/cadets.js` (new). List view with search, platoon filter (dropdown
  populated from actual data), "Show inactive" toggle, "+ Add cadet" button
  gated on `manageCadets` perm.
- Add/edit modal: svcNo (read-only on edit, since it's the PK), rank with
  datalist of staff+cadet ranks for autocomplete (free text accepted),
  surname (force-uppercased on save matching v1), given names (mixed case),
  platoon, email (format-validated if non-empty), active checkbox, notes.
- Delete flow: blocks deletion if any active loans exist (`l.active === true`),
  with a modal explaining the block and suggesting "mark inactive" instead.
  Otherwise requires a typed reason for the audit trail.
- Manual rank entry passes through `normalizeRank` from `ranks.js`, so
  a user typing `CAPT` produces the same canonical `CAPT-AAC` that the
  v1→v2 migration produces. One source of truth.
- `personType` derived from rank on save via `inferPersonType`. Not exposed
  as a form field — flipping it requires changing the rank, which is the
  field that conveys the meaning.
- Inactive cadets visually de-emphasised (opacity 0.55) but stay in the
  list for historical loan integrity.
- Audit actions: `cadet_add`, `cadet_update`, `cadet_delete`.
- Field name `given` (not `givenNames`) chosen for v1 compatibility — v1
  used the same key, and the existing test harness depends on it.

### Added — OC PIN recovery (Item 3)

- `src/recovery.js` (new module). Generates 12-character one-shot recovery
  codes from a 32-char ambiguity-free alphabet (`23456789ABCDEFGHJKLMNPQRSTUVWXYZ`
  — base36 minus `0/1/I/O`), formatted `XXXX-XXXX-XXXX`, ~60 bits entropy.
  Hashed with argon2id (same parameters as PIN hashing) and stored in the
  user record's `recoveryHash` field.
- `Auth.setPin(userId, pin, { generateRecovery: true })` extension:
  generates a recovery code at PIN-set time for OC users, returns
  `{ recoveryCode: '<formatted>' }`. Flag is OC-only (non-OC users get
  `null`); routine PIN rotation does NOT regenerate (so paper copies don't
  silently invalidate).
- `Auth.resetPinWithRecoveryCode(userId, code, newPin)`: validates the new
  PIN, looks up the user, verifies the code, on success rewrites the PIN
  hash and consumes the recovery hash. Returns `{ ok: true }` or
  `{ ok: false, reason: 'invalid_pin'|'invalid_code'|'no_recovery' }`.
- Default-PIN modal in `shell.js` now generates a code on first PIN-set
  (when the OC moves off `0000`) and shows it in a follow-up
  acknowledgement modal with off-device-storage guidance and a required
  checkbox.
- "Forgot PIN?" link added to `login.js` keypad — visible only when an OC
  user is selected. Opens a modal with code + new PIN + confirm PIN.
- Settings page gains an "OC PIN recovery" section: status block (active +
  generated date, or warn-no-code), single button (`Generate` → `Regenerate`
  if a code exists). Confirms before overwriting.
- Audit actions: `recovery_set` (first generation), `recovery_rotated`
  (regeneration), `recovery_reset` (successful PIN reset via code),
  `recovery_reset_failed` (failed attempt).

### Added — Unit branding settings (Item 2)

- `src/ranks.js` (new module). Extracted rank vocabularies and helpers from
  `migration.js`: `OFFICER_RANK_BASES`, `STAFF_RANKS_CANONICAL` (with
  `-AAC` suffix), `CADET_RANKS`, `STAFF_RANKS_RECOGNISED`. Exports
  `normaliseRankInput()`, `normalizeRank()`, `inferPersonType()`. Migration
  refactored to import from here (49 lines removed, behaviour preserved).
- Settings page gains a "Unit details" section: `unitName`, `unitCode`,
  `state` (AU dropdown), `qmName`, `qmRank` (datalist of staff + cadet
  ranks — cadet QMs are a designed-in role), `qmEmail`, plus the
  approver fields (`coName`/`coEmail`, kept under those storage keys for
  schema compat though labelled OC).
- Saving the unit details soft-updates the shell brand via DOM patch — no
  page reload needed.

### Added — Manual export/import (Item 1)

- Settings page gains a "Data" section: download backup file
  (filename pattern `qstore-backup-<unitslug>-YYYY-MM-DD-HH-MM-SS.json`),
  restore from backup file (`OVERWRITE`-typed confirmation gate).
- Audit actions: `data_export`, `data_imported`.

### Changed — OC role label rename

- `ROLES.co.label` changed from `'CO / OC'` to `'OC'`; `short` from `'CO'`
  to `'OC'`. Permission-denied error message in `requireCO()` changed from
  `CO/OC role required` to `OC role required`. Internal role key remains
  `'co'` — no schema change. AB189 forms are in-unit only (battalion
  requests use CadetNet pro-formas), so the original "CO or OC approval"
  semantics weren't needed; OC + QM signatures are sufficient.

### Documentation

- `docs/CHANGELOG.md` (this file, new).
- `docs/ARCHITECTURE.md` (new) — module map, schemas, the not-obvious
  decisions.

### Test status at this point

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
test-stocktake.mjs:       26/26 ✓ (new)
─────────────────────────────────
                         431/431 ✓ across thirteen suites
```

---

## [v2.0] — initial v2 architecture

The v1 7600-line single-file HTML monolith was rewritten into a modular
codebase bundled to a single-file deliverable via `esbuild`. Functional
parity with v1 was the goal; new features and polish were deferred to v2.1.

### Architecture changes from v1

- **Bundled output, modular source.** Source lives in `src/` as ES modules;
  `node build.js` produces `dist/qstore.html` with HTML + CSS + JS + WASM
  inlined. The deliverable still works offline via `file://`.
- **IndexedDB instead of localStorage.** 11 stores (items, photos, cadets,
  loans, audit, users, requests, stocktake, counters, settings, meta).
  Photo blobs live in their own store, keyed to item id.
- **Argon2id PIN hashing** via `hash-wasm` 4.12.0. v1 had no hashing — PINs
  were stored in plain text.
- **HMAC-SHA256 audit chain.** Each audit row carries a hash linking it to
  its predecessor; `Storage.audit.verify()` walks the chain to detect
  tampering. Key is generated at install time and stored in the meta store.
- **MSAL Browser 2.38.3** for OneDrive sync (Microsoft Graph). Sync is
  last-write-wins; multi-device coordination is naive and is the largest
  v2 architectural debt — see `V2.1-BACKLOG.md` and the cloud sync polish
  item.
- **Role-based permissions.** Five roles (`co`, `qm`, `staff`, `cadet`,
  `ro`); `co` has all perms, others have explicit lists. Defence-in-depth
  pattern: UI hides actions when the perm is missing, handlers re-check
  via `AUTH.requirePermission()` to defend against stale UI / DevTools.
- **Single-file diagnostic harness** at `Tests/test-harness.html` walks
  Storage CRUD across all stores. Headless smoke tests (`test-*.mjs`)
  cover business logic with `fake-indexeddb` + Node's `webcrypto`.

### Known v2.0 gaps documented in `V2.1-BACKLOG.md`

- No CO recovery flow (now done, see v2.1)
- No manual export/import UI (now done, see v2.1)
- No unit branding settings UI (now done, see v2.1)
- No cadets page (now done, see v2.1)
- No issue/return UI (now done, see v2.1)
- No audit log viewer (pending)
- No AB189 PDF generation (pending)
- LWW cloud sync — gated on brigade ITSO reply about defence policy
