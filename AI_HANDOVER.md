# QStore IMS — AI Handover Document

> **Purpose:** Concise orientation for any AI assistant reviewing or extending this project.
> **Last updated:** 2026-05-27 (auto-maintained — update after every significant change)

---

## 1. Product Name & Tier

**QStore IMS v2** — inventory management system for Australian Army Cadet (AAC) unit Q-Stores.
- Tier: Pay/donate (free to use; donation requested)
- Tier above: QStore V3 (commercial SaaS, separate repo)
- Distribution: single self-contained HTML file (no server required)

---

## 2. Tech Stack

| Layer | Detail |
|---|---|
| Language | Vanilla ES modules (no framework) |
| Bundler | esbuild → single-file HTML |
| Storage | IndexedDB (all persistent data) |
| Auth | argon2id PIN, optional TOTP 2FA (RFC 6238), AES-256-GCM PII encryption |
| Cloud sync | OneDrive via MSAL 5.x (last-write-wins snapshot) |
| PDF | jsPDF (custom) |
| QR | qrcode-generator |
| PDF parse | pdfjs-dist (FakeWorker) for AAC Orders import |
| Build output | `dist/qstore.html` + `docs/index.html` (GitHub Pages) |

---

## 3. Repository

- **Path:** `C:\ClaudeAImemoryfolder\QStore\qstore-v2-wip\`
- **Remote:** `https://github.com/Woodifi/145ACUQstoreV2D.git` (branch: `master`)
- **Build:** `node build.js` → `dist/qstore.html` + `docs/index.html`
- **Dist:** `node build.js --dist --recipient="Unit Name"` → named single-file HTML (never overwrites docs/)
- **Tests:** `for t in test-ranks test-unit-branding test-export-import test-recovery test-cadets test-loans test-audit test-pdf test-cloud-disable test-v1-import test-inventory test-csv-import test-stocktake test-qr test-ab189; do node "$t.mjs"; done`
- **Test count:** 491 across 15 suites

---

## 4. Folder Structure

```
qstore-v2-wip/
├── src/
│   ├── auth.js            # argon2id PIN, TOTP, session, lockout
│   ├── cloud.js           # MSAL 5.x OneDrive sync provider
│   ├── sync.js            # LWW snapshot sync orchestrator
│   ├── storage.js         # IndexedDB layer (all stores)
│   ├── pii.js             # AES-256-GCM field-level PII encryption
│   ├── totp.js            # RFC 6238 TOTP implementation
│   ├── pdf.js             # All PDF generators (jsPDF)
│   ├── fingerprint.js     # Build ID + distribution tracking
│   ├── structure.js       # Company/Platoon/Section helpers
│   ├── order-parser.js    # AAC Orders PDF parser (pdfjs)
│   └── ui/
│       ├── shell.js       # App boot, session, nav, idle lock
│       ├── login.js       # Login picker, PIN keypad, TOTP step
│       ├── settings.js    # All settings (unit, sync, data, security)
│       ├── inventory.js   # Inventory CRUD, stocktake, reports
│       ├── loans.js       # Issue, return, all-loans, bulk actions
│       ├── cadets.js      # Cadet management, equipment profile
│       ├── staff.js       # Staff management
│       ├── users.js       # User account management (OC only)
│       ├── requests.js    # Cadet equipment request workflow (AB189)
│       ├── orders.js      # AAC supply orders import
│       ├── stocktake.js   # Stocktake workflow
│       ├── audit.js       # Audit log viewer
│       ├── dashboard.js   # Home page with stat tiles
│       ├── ims-reports.js # IMS reports hub
│       ├── reference.js   # Uniform sizing reference
│       └── ...
├── test-*.mjs             # Test suites (node, no browser)
├── build.js               # esbuild bundler + dist packaging
├── MANUAL.md              # User manual (public)
├── TECHNICAL.md           # Developer technical reference
├── AI_HANDOVER.md         # This file
└── ACTIONS.log            # Autonomous action log
```

---

## 5. Database Schema (IndexedDB — DB_VERSION 4)

| Store | Key | PII Encrypted Fields | Purpose |
|---|---|---|---|
| `meta` | key | — | installId, auditKey, piiKey |
| `settings` | key | — | All app settings (unitLogo, unitName, etc.) |
| `items` | id | — | Inventory items (NSN, name, qty, category, loc) |
| `photos` | id | — | Item photos (Blob) |
| `cadets` | svcNo | surname, given, email, notes | Cadet records |
| `staff` | svcNo | surname, given, email, notes | Staff records |
| `loans` | id | borrowerName, remarks | Loan transactions |
| `audit` | id | — | HMAC-chained audit log |
| `users` | username | name, svcNo, totpSecret | App user accounts |
| `pendingRequests` | id | requestorName, requestorRank, requestorSvc | AB189 requests |
| `stocktakeCounts` | id | countedBy | Stocktake session data |
| `kits` | id | — | Kit templates |
| `supplyOrders` | id | requestorName, requestorRank, requestorSvcNo | AAC supply orders |
| `counters` | key | — | Auto-increment counters |

---

## 6. Authentication

- **PINs:** argon2id (memoryCost=19456, timeCost=2, parallelism=1), 4–8 digits
- **Lockout:** 5 failures → 15 min, 10 → 30 min, 15+ → 60 min (localStorage, per-user)
- **Roles:** `oc` (full access), `qm` (operational, no user management), `viewer` (read-only), `cadet` (own data only)
- **TOTP 2FA:** RFC 6238 TOTP, QR code enrolment, SHA-256 hashed backup codes, replay guard
- **Auto-lock:** 5–60 min idle (default 15), visibilitychange sleep/wake detection, suspends session token on lock
- **PII encryption:** AES-256-GCM per-field, device-specific piiKey (never exported)
- **Export encryption:** Optional AES-256-GCM with PBKDF2-SHA256 310k iterations on `.qstore` files

---

## 7. Current Functionality (v2.3.0)

**Inventory:** CRUD, NSN, category, location, photos, condition breakdown (Svc/U/S/Repr/Cal/W/O), low/zero stock badges, maintenance notes log, QR codes, AB174 Board of Survey PDF

**Loans:** Issue (standard/non-stock/existing/unit), return, all-loans view, quick return, bulk return, bulk purpose change, overdue tracking, long-term loans, Initial Issue (6-year), borrower sub-unit grouping

**Cadets:** CRUD, sub-unit structure (Coy/Plt/Sec), equipment profile, discharge recall, cadet data isolation (cadets see only own records)

**Staff:** Separate module, CRUD, staff borrowers in loans

**Requests:** AB189 workflow — cadet submit, QM approve/issue/deny, editable issue items modal, copy to cadets, print AB189

**Orders:** AAC supply order PDF import (pdfjs), receive with qty adjustment, post-receive accounting prompt

**Stocktake:** Count + condition breakdown, draft management, finalise (atomic IDB transaction)

**Reports:** IMS reports hub (outstanding loans, written-off items, issue history, kit allocation), CSV export, print

**Security:** All above + cloud sync (OneDrive), export/import backup, HMAC audit chain

**Settings:** Unit profile, logo upload + "Download unit copy" (embeds logo in HTML for new-device distribution), cloud sync, data backup/restore, user management, 2FA, recovery codes, auto-lock, theme, categories, sub-structure, loan defaults

---

## 8. APIs / Key Exports

- `Storage.*` — all IDB operations (items, loans, cadets, staff, users, audit, settings, etc.)
- `AUTH.*` — login, logout, session, PIN verify, TOTP, lockout, isCadet()
- `Sync.*` — notifyChanged, syncNow, loadFromCloud, addStatusListener
- `Cloud.*` — MSAL sign-in/out, read/write, resetAuthState
- `PII.*` — encrypt, decrypt, encryptRecord, decryptRecord, decryptAll
- `Storage.atomic.*` — issue(loan, item), return(loan, item), stocktakeFinalise(items[])

---

## 9. Licensing / Subscriptions

- No licensing enforcement in V2 (pay/donate model)
- Single-file HTML, no backend
- V3 is the commercial tier; V3 SaaS backend = **Platform Core** (see below)

---

## 10. Deployment

- **Development:** Open `dist/qstore.html` in browser (Chromium/Edge recommended)
- **GitHub Pages:** `docs/index.html` is served at the repo's Pages URL
- **Distribution:** `node build.js --dist --recipient="Unit Name"` → standalone HTML
- **Unit copy with embedded logo:** Settings → Upload logo → "Download unit copy" button

---

## 11. SaaS Backend — Platform Core

The SaaS backend for this product family is **Platform Core**, located at:
`C:\ClaudeAImemoryfolder\QStore\platform-core`

It is a complete, tested system with:
- `auth-service` (port 3001) — RS256 JWT, refresh token rotation
- `licence-api` (port 3002) — licence issuance, validation, revocation
- `billing-service` (port 3003) — Stripe abstraction, invoices, trial management
- `notification-service` (port 3004) — email events
- `portal-web` (port 3000) — self-service user portal (Next.js 14)
- `admin-dashboard` (port 3005) — admin management (Next.js 14)
- `@platform-core/sdk` — typed `PlatformClient` for product integration

V2 does not integrate directly with Platform Core (pay/donate, no licensing enforcement). V3 will register as product slug `qstore-ims-v3` and use Platform Core for all subscription/licensing. See V3's `AI_HANDOVER.md` section 9 for the full integration plan.

The marketing website should link to the Platform Core `portal-web` for unit subscriptions — do not design a custom checkout or licensing flow.

---

## 12. Current Sprint (as of 2026-05-27)

- Fixed: export stack overflow (`_b64` spread overflow on large backups)
- Fixed: logo not visible on new device after cloud load (mirror to localStorage after importAll)
- Added: "Download unit copy" — embeds logo + unit config into HTML for distribution
- Clarified: SaaS backend = Platform Core (already built); V3 integration is the next milestone

---

## 13. Next Sprint (planned)

- Register QStore IMS v3 in Platform Core (Admin Dashboard)
- Marketing website (ChatGPT-led; links to Platform Core portal-web for subscriptions)
- No new V2 IMS features planned; V2 is feature-complete

---

## 14. Known Issues / Constraints

- `file://` URLs: MSAL cloud sync requires HTTPS or localhost — not available when opened directly from filesystem
- Chrome/Edge recommended; Firefox has stricter `crypto.subtle` restrictions on `file://`
- PII encryption is device-bound — a raw IDB file copied to another device is unreadable (by design)
- Session token in localStorage can be read by any JS running in the same origin (documented limitation)
- Cloud sync is last-write-wins snapshot — no conflict resolution; concurrent edits from two devices will lose one
- Photos are stored as Blobs in IDB — not included in cloud sync (too large); included in local backup exports

---

## 15. Work Split (ChatGPT / Claude)

| Claude | ChatGPT |
|---|---|
| Coding, testing, refactoring | Product strategy, feature prioritisation |
| Database migrations | Security reviews |
| Platform Core → V3 integration | Monetisation strategy |
| Bug fixes | **Marketing website & sales funnel** |
| — | Licensing model documentation |
| — | User guides, release notes |
| — | Investor/business material |
