# QStore IMS v2 — Changelog

All notable changes to QStore IMS v2 are documented here.
Format: [version] — [date] — summary of changes.

---

## [2.3.1] — 2026-05-29

### Added
- **Licensing system** — Ed25519-signed subscription keys with 30-day free trial, 14-day grace period, read-only restricted mode on expiry. Settings → Subscription section shows status and activation form. Shell banner warns when trial is ending, expired, or in grace.
- **License key generator** — `keys/generate-key.mjs` CLI for generating unit license keys. Production Ed25519 keypair generated.
- **Distro subdirectories** — recipient distribution builds now output to `dist/<unit-slug>/` instead of flat `dist/`. Previous recipient builds auto-deleted on rebuild.

### Fixed
- **PDF worksheets — item name wrapping** — stocktake worksheet, kit checklist, AB174 Board of Survey: item names now wrap to multiple lines with dynamic row height instead of being truncated with ellipsis. Stocktake blank boxes expand with the row.
- **Inventory table — item notes wrapping** — notes/description line below item name now wraps instead of being clipped at 300px with ellipsis.

---

## [2.3.0] — 2026-05-20 to 2026-05-27

### Added
- **Inventory sort** — all inventory lists sorted category A→Z then NSN (numeric-first). Applied at storage layer; covers inventory page, stocktake, kit picker, reports, QR sheet.
- **Cadet login UX** — staff/officers shown by default; "Cadet Login" button reveals filtered cadet-only picker.
- **Cadet data isolation** — cadets see only their own record in Cadets page and their own loans in Loans page. Staff page blocked for cadets.
- **Initial Issue purpose** — protected from deletion; auto-sets 6-year return date; forces long-term loan flag.
- **Cadet discharge recall** — on deactivation, all active loans recalled (dueDate = today), flagged "Discharged".
- **Cadet self-service equipment request workflow** — cadet submit/track, QM approve/issue/deny, editable issue items modal, copy to cadets, print AB189, blank AB189 PDF download.
- **Editable Issue Items modal** — reviewed issue table: description datalist, NSN auto-fill, Qty Req'd, Qty Issued, per-line Status (Issue/Loan/Backorder/Unavailable).
- **AB174 Board of Survey PDF** — for written-off items; army-green header, board-member signature blocks, CO approval.
- **Dark/light/system theme toggle** — Settings → Appearance.
- **Keyboard shortcuts** — `/` search, `n` add, `←→` tabs, `1–6` nav, `?` help.
- **Borrower sub-unit grouping** — datalist options show `· Coy / Plt / Sec` suffix.
- **Quick return** — `↩ Return` button on every active loan row in All Loans tab.
- **Bulk return** — checkboxes, select-all, bulk return with shared condition/remarks.
- **Bulk purpose change** — change purpose on multiple selected active loans.
- **Overdue dashboard detail** — red-bordered table showing borrower/item/qty/due/days-over.
- **Default loan due date** — configurable in Settings → Loan Defaults.
- **Duplicate NSN detection** — live warning + save block.
- **Low/zero stock indicators** — badges on inventory rows; tiles on dashboard link to filtered inventory.
- **Audit date range filter** — From/To date inputs in audit log.
- **Cadet equipment profile modal** — active loans + loan history; print kit checklist.
- **Item maintenance/notes log** — timestamped free text per item; `item_note` audit entry.
- **Inventory location search** — `loc` and `notes` fields included in search filter.
- **Cadet kit checklist PDF** — A4 with tick boxes and signature blocks.
- **IMS reports hub** — outstanding loans, written-off items, issue history, kit allocation; CSV export.
- **Non-stock return → add-to-inventory prompt** — after returning unmatched non-stock loans.
- **Unit/activity loans** — `unitLoan: true` lines with activity description instead of borrower.
- **Record existing issue** — `existingLoan` flag; `onHand` not decremented; amber badge.
- **Export stack overflow fix** — `_b64()` chunked loop prevents call stack overflow on large backups.
- **Download unit copy** — embeds logo + unit config into HTML for new-device distribution.
- **TOTP 2FA** — RFC 6238, QR code, SHA-256 hashed backup codes, login + lock overlay.
- **Export encryption** — AES-256-GCM + PBKDF2 310k on `.qstore` backup files.
- **Read-access audit** — `cadet_viewed`, `staff_viewed` entries.
- **Users page 2FA status column** — green/grey/amber badge + backup count.
- **Atomic IDB transactions** — `Storage.atomic.issue()`, `.return()`, `.stocktakeFinalise()`.
- **Auto-lock security fixes** — lock overlay now requires 2FA when TOTP enrolled; session suspended during lock; lockout thresholds corrected (5→15 min, 10→30 min, 15+→60 min).
- **MSAL popup auth fix** — `broadcastResponseToMainFrame()` replaces `handleRedirectPromise()` for popup interactions.
- **Cadet PII migration** — auto-encrypts pre-PII plaintext cadet records on first boot.
- **AbortController** — all UI page modules prevent ghost-click accumulation across re-renders.
- **Staff borrower picker fix** — staff svcNo now resolves correctly in issue tab datalist.
- **Idle timeout** — wall-clock sleep detection; "Disabled" option removed; minimum 5 minutes.

### Changed
- AB189 approval gate: shows `approved` requests alongside `pending`; "Issue Items" button on approved cards.
- Initial Issue: `longTermLoan = true` + 6-year due date enforced in both issue and approve-and-issue paths.
- Borrower name format: `Rank Surname F.` (first initial appended).

---

## [2.2.0] — 2026-05-18

### Added
- Dashboard home page (stat tiles, stocktake status, quick actions, recent audit)
- Overdue loans nav badge
- Blank stocktake worksheet PDF
- Bulk cadet CSV import
- Cadet bulk platoon migration wizard
- Item loan history panel
- Category management in Settings (managed chip list, drag-and-drop reorder)
- Logo localStorage persistence
- Mobile responsive UI (hamburger nav ≤768px)
- Rank sort — all people sorted by rank then surname
- User management page (OC only)
- Stocktake condition breakdown (Svc/U/S/Repr/Cal/W/O)
- Company / Platoon / Section unit sub-structure
- Audit log export (CSV + JSON)
- Per-user PIN lockout (escalating delays)
- Launch splash screen (5-second countdown)
- Kit form UX (persistent modal, scrollable item list)
- Header logo 2× size
- AAC QStore Orders plugin (PDF import, receive, CSV export)
- Reference page (AMCU uniform sizing guide)
- Administrator-only PIN management with show-once display
- 5-column stocktake condition breakdown

---

## [2.1.0] — 2026-05-13 to 2026-05-15

### Added
- Toast notifications (replaced all `alert()`)
- Mobile responsive layout
- Build fingerprinting (unique build ID per dist, DIST_LOG.md)
- Proprietary licence (LICENSE file, Queensland law, Sean Scales)
- User manual (MANUAL.md public, MANUAL_ADDENDUM_OWNER.md gitignored)
- About section in Settings
- Splash screen
- QR code label generation
- Search cursor fix (split render — toolbar never replaced)
- GitHub Pages setup (docs/index.html)
- PIN lockout (localStorage, escalating delays)

### Initial
- Core IMS: inventory, loans, cadets (with rank sort), audit, stocktake, settings
- Cloud sync (OneDrive, MSAL)
- OC PIN recovery (argon2id)
- CSV import
- QR print/scan
