# QStore IMS v2 — AI Handover Document

> **Purpose:** Concise orientation for any AI assistant (Claude or ChatGPT) reviewing or extending this project.
> **Last updated:** 2026-05-29 (auto-maintained — update after every significant change)

---

## 1. Product Name & Tier

**QStore IMS v2** — inventory management system for Australian Army Cadet (AAC) unit Q-Stores.

| | |
|---|---|
| **Tier** | Paid Tier 1 — subscription-based, 30-day free trial |
| **Tier above** | QStore V3 (Paid Tier 2 — IMS + Accounting, commercial SaaS, separate repo) |
| **Tier below** | QStore V1 (legacy, free, no longer maintained — not in this directory) |
| **Distribution** | Single self-contained HTML file (no server required, works offline) |
| **Licensing** | Ed25519-signed subscription keys; trial/grace/restricted enforcement |

---

## 2. Tech Stack

| Layer | Detail |
|---|---|
| Language | Vanilla ES modules (no framework) |
| Bundler | esbuild → single-file HTML |
| Storage | IndexedDB (all persistent data, DB_VERSION 3) |
| Auth | argon2id PIN, optional TOTP 2FA (RFC 6238), AES-256-GCM PII encryption |
| Licensing | Ed25519 signed keys (`src/license.js`), `@noble/curves` |
| Cloud sync | OneDrive via MSAL 5.x (last-write-wins snapshot) |
| PDF | jsPDF (custom generators) |
| QR | qrcode-generator |
| PDF parse | pdfjs-dist (FakeWorker) for AAC Orders import |
| Build output | `dist/qstore.html` + `docs/index.html` (GitHub Pages) |

---

## 3. Repository

- **Path:** `C:\ClaudeAImemoryfolder\QStore\qstore-v2-wip\`
- **Remote:** `https://github.com/Woodifi/145ACUQstoreV2D.git` (branch: `master`)
- **Build:** `node build.js` → `dist/qstore.html` + `docs/index.html`
- **Dist:** `node build.js --dist --recipient="Unit Name"` → `dist/<unit-slug>/qstore-<slug>-<buildid>.html`
- **Tests:** 16 suites (test-ranks, test-unit-branding, test-export-import, test-recovery, test-cadets, test-loans, test-audit, test-pdf, test-ab189, test-cloud-disable, test-v1-import, test-inventory, test-csv-import, test-stocktake, test-qr, test-license)
- **Test count:** 522 across 16 suites

---

## 4. Folder Structure

```
qstore-v2-wip/
├── src/
│   ├── auth.js            # argon2id PIN, TOTP, session, lockout
│   ├── cloud.js           # MSAL 5.x OneDrive sync provider
│   ├── sync.js            # LWW snapshot sync orchestrator
│   ├── storage.js         # IndexedDB layer (requireEdit() on all writes)
│   ├── license.js         # Ed25519 subscription key validation + enforcement
│   ├── pii.js             # AES-256-GCM field-level PII encryption
│   ├── totp.js            # RFC 6238 TOTP implementation
│   ├── pdf.js             # All PDF generators (jsPDF)
│   ├── fingerprint.js     # Build ID + distribution tracking
│   ├── structure.js       # Company/Platoon/Section helpers
│   ├── order-parser.js    # AAC Orders PDF parser (pdfjs)
│   └── ui/
│       ├── shell.js       # App boot, session, nav, idle lock, license banner
│       ├── login.js       # Login picker, PIN keypad, TOTP step
│       ├── settings.js    # All settings including Subscription section
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
├── keys/
│   ├── generate-key.mjs   # License key generator (requires private.key)
│   └── private.key        # GITIGNORED — Ed25519 private key (keep secure)
├── test-*.mjs             # Test suites (node, no browser)
├── build.js               # esbuild bundler + dist packaging
├── MANUAL.md              # User manual (public)
├── TECHNICAL.md           # Developer technical reference
├── AI_HANDOVER.md         # This file
├── ROADMAP.md             # Product roadmap
├── CHANGELOG.md           # Version history
└── ACTIONS.log            # Autonomous action log
```

---

## 5. Database Schema (IndexedDB — DB_VERSION 3)

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

## 6. Authentication & Licensing

**Auth:**
- PINs: argon2id (memoryCost=19456, timeCost=2, parallelism=1), 4–8 digits
- Lockout: 5 failures → 15 min, 10 → 30 min, 15+ → 60 min
- Roles: `oc` (full), `qm` (operational), `viewer` (read-only), `cadet` (own data only)
- TOTP 2FA: RFC 6238, QR code enrolment, SHA-256 hashed backup codes, replay guard
- Auto-lock: 5–60 min idle, sleep/wake detection, session suspended on lock
- PII: AES-256-GCM per-field, device-specific piiKey (never exported)

**Licensing (added 2026-05-29):**
- 30-day free trial on first launch
- 14-day grace period on expiry
- RESTRICTED state = read-only (view, export, print still work)
- Keys: Ed25519-signed, `QSTRE-XXXXX-XXXXX-...` human format
- V2 public key: `eb72334df2894f576a922de348a7fd28842857ee8b2ca9f93ea1ba895624339e`
- Private key: `keys/private.key` (gitignored — back up securely)
- Generate new key: `node keys/generate-key.mjs --unit="Unit Name" --tier=lifetime`
- Settings → Subscription shows status + activate form

---

## 7. Current Functionality (v2.3.0+)

**Inventory:** CRUD, NSN, category, location, photos, condition breakdown (Svc/U/S/Repr/Cal/W/O), low/zero stock badges, maintenance notes log, QR codes, AB174 Board of Survey PDF, inventory sort by category→NSN

**Loans:** Issue (standard/non-stock/existing/unit), return, all-loans view, quick return, bulk return, bulk purpose change, overdue tracking, long-term loans, Initial Issue (6-year), borrower sub-unit grouping

**Cadets:** CRUD, sub-unit structure (Coy/Plt/Sec), equipment profile, discharge recall, cadet data isolation, kit checklist PDF

**Staff:** Separate module, CRUD, staff as loan borrowers

**Requests:** AB189 workflow — cadet submit, QM approve/issue/deny, editable issue modal, copy to cadets, print AB189

**Orders:** AAC supply order PDF import (pdfjs), receive with qty adjustment

**Stocktake:** Count + condition breakdown, draft management, atomic IDB finalise

**Reports:** IMS reports hub, CSV export, print; PDF worksheets now wrap long item names

**Security:** TOTP 2FA, HMAC audit chain, PII encryption, auto-lock, export encryption

**Settings:** Full unit profile, logo, cloud sync, backup/restore, user management, 2FA, recovery codes, auto-lock, theme (dark/light/system), categories, sub-structure, loan defaults, **Subscription** (license key activation)

---

## 8. Licensing Key Management

```
# Generate new keypair (first time only — already done, DON'T RUN again)
node keys/generate-key.mjs --generate-keypair

# Generate a key for a new unit
node keys/generate-key.mjs --unit="Unit Name" --tier=lifetime

# Generate an annual key
node keys/generate-key.mjs --unit="Unit Name" --tier=annual --exp=2027-05-31
```

**CRITICAL:** Back up `keys/private.key` outside the repo. If lost, no new keys can be signed.

---

## 9. Distribution

```
# Standard build (source + GitHub Pages update)
node build.js

# Named distro for a specific unit
node build.js --dist --recipient="422 ACU StMichaels College"
# → dist/422-acu-stmichaels-college/qstore-422-acu-stmichaels-college-YYYYMMDD-XXXXXXXX.html
```

- Recipient distro files are local only — NEVER pushed to GitHub
- Each recipient gets their own subdirectory under `dist/`
- Previous builds for the same recipient are auto-deleted on new build

---

## 10. SaaS Backend — Platform Core

The SaaS backend for this product family is **Platform Core**, located at:
`C:\ClaudeAImemoryfolder\QStore\platform-core`

All 8 phases complete. Provides auth, licensing, billing, subscriptions, user portal, admin dashboard.
V2 integration with Platform Core is a future milestone.

---

## 11. Current State (as of 2026-05-29)

- ✅ Ed25519 licensing system added (30-day trial, grace, restricted enforcement)
- ✅ Lifetime key issued for 422 ACU StMichaels College
- ✅ PDF worksheets wrap long item descriptions (no more ellipsis truncation)
- ✅ Inventory item notes wrap in table (no more truncation)
- ✅ Recipient distros go to unit subdirectories
- ✅ 522/522 tests passing (16 suites)

---

## 12. Next Steps

- Register QStore IMS v2 as a product in Platform Core
- Marketing website (ChatGPT-led)
- Platform Core → V2 license validation API integration (replace local Ed25519 with SDK)

---

## 13. Known Issues / Constraints

- `file://` URLs: MSAL cloud sync requires HTTPS or localhost
- Chrome/Edge recommended; Firefox has stricter `crypto.subtle` restrictions on `file://`
- PII encryption is device-bound — raw IDB copy to another device is unreadable (by design)
- Cloud sync is last-write-wins snapshot — no conflict resolution; concurrent edits from two devices will lose one
- Photos stored as Blobs in IDB — not included in cloud sync; included in local backup exports

---

## 14. Work Split (ChatGPT / Claude)

| Claude | ChatGPT |
|---|---|
| All coding, testing, refactoring | Product strategy, feature prioritisation |
| Database migrations | Monetisation strategy |
| License key generation | **Marketing website & sales funnel** |
| Bug fixes | User guides, release notes |
| IMS feature development | Investor/business material |
| Platform Core → V2 integration | Licensing model documentation |
