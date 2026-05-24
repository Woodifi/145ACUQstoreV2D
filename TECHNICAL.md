# QStore IMS v2 — Technical Reference Manual

**Classification: Developer / Maintainer only. Not for distribution.**
Last updated: 2026-05-25

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Project Structure](#2-project-structure)
3. [Build System](#3-build-system)
4. [IndexedDB Schema](#4-indexeddb-schema)
5. [Authentication System](#5-authentication-system)
6. [Security Implementation](#6-security-implementation)
7. [Known Security Issues and Mitigations](#7-known-security-issues-and-mitigations)
8. [Developer Recovery Procedures](#8-developer-recovery-procedures)
9. [Testing](#9-testing)
10. [Operational Notes](#10-operational-notes)

---

## 1. Architecture Overview

QStore IMS v2 is a **fully offline, browser-based** inventory management system. There is no server, no cloud sync, and no network dependency. All state is stored in the browser's IndexedDB on the local device.

V2 is a **single-module product** — it produces one self-contained `qstore.html` file that includes the complete IMS (inventory, loans, personnel, stocktake, reports, settings). There is no separate Accounting module in V2. Accounting functionality was introduced in V3.

V2 is the **open-source / community edition**. V3 is the commercial product.

### Technology stack

- **JavaScript** — vanilla ES2022+, no framework, no runtime dependencies in production
- **esbuild** — bundler/minifier (dev dependency only)
- **hash-wasm** — argon2id (WASM) for PIN and recovery code hashing
- **Web Crypto API** — AES-256-GCM (PII encryption, export encryption), PBKDF2 (export key derivation), HMAC-SHA256 (audit chain), SHA-256 (TOTP backup codes)
- **IndexedDB** — all persistent storage
- **sessionStorage** — auth session token (V2 uses sessionStorage; clears when tab closes)

---

## 2. Project Structure

```
qstore-v2-wip/
├── src/
│   └── ui/
│       ├── shell.js           App entry: auth, nav, idle watcher
│       ├── settings.js        Settings panel
│       ├── loans.js           Loan issue/return
│       ├── personnel.js       Cadet/staff management
│       ├── items.js           Equipment catalogue
│       ├── stocktake.js       Stocktake workflow
│       ├── reports.js         Report generation
│       └── help.js            In-app help overlay
├── docs/                      GitHub Pages deployed output
│   ├── index.html             Built qstore.html (GitHub Pages entry)
│   └── MANUAL.html            Printable user manual
├── dist/
│   └── qstore.html            Production build for distribution
├── build.js                   Build script (esbuild orchestration)
├── index.html                 HTML template
├── qstore.css                 Stylesheet
├── MANUAL.md                  User manual (Markdown source)
├── TECHNICAL.md               This file
└── package.json
```

---

## 3. Build System

### Commands

```bash
node build.js            # Production build (minified)
node build.js --dev      # Dev build (source maps, no minify)
node build.js --watch    # Watch mode (dev)
```

### Output

- `dist/qstore.html` — production single-file build for distribution
- `docs/index.html` — GitHub Pages deployment copy

The build inlines CSS and JavaScript into a single `.html` file with zero external dependencies.

### Build ID

Each non-dev build generates a `BUILD_ID` (`YYYYMMDD-XXXXXXXX`) embedded as a comment in the output HTML.

### Argon2 template literal guard

The build script includes a check that the argon2id hash-format template literal (containing `$${`) has not been corrupted by esbuild's string replacement. Uses a function replacer (`() => boot`) in `html.replace()` to prevent double-evaluation of `$$` sequences.

---

## 4. IndexedDB Schema

**Database name**: `qstore`  
**Current version**: 4

### Upgrade path

| Version | Changes |
|---------|---------|
| 1 | Initial: cadets, items, loans, auditLog |
| 2 | Added: settings, users |
| 3 | Added: staff |
| 4 | Added: meta (piiKey) |

### Stores

#### `cadets`
Cadet personnel records.

| Field | Type | Notes |
|-------|------|-------|
| `id` | number (auto) | Primary key |
| `svcNo` | string | Service number (unique index) |
| `rank` | string | Plain text |
| `surname` | string | **PII-encrypted** |
| `given` | string | **PII-encrypted** |
| `email` | string | **PII-encrypted** |
| `notes` | string | **PII-encrypted** |
| `active` | boolean | |
| `uniformSize` | string | |
| `createdAt` | ISO string | |
| `updatedAt` | ISO string | |

#### `staff`
Staff personnel records. Same structure as `cadets`.

#### `items`
Equipment catalogue.

| Field | Type | Notes |
|-------|------|-------|
| `id` | number (auto) | |
| `name` | string | Plain text |
| `category` | string | |
| `totalQty` | number | |
| `available` | number | |
| `description` | string | |
| `location` | string | |
| `condition` | string | |
| `notes` | string | |

#### `loans`

| Field | Type | Notes |
|-------|------|-------|
| `id` | number (auto) | |
| `borrowerSvcNo` | string | Plain text |
| `borrowerName` | string | **PII-encrypted** |
| `itemId` | number | FK → items |
| `qty` | number | |
| `issuedAt` | ISO string | |
| `dueAt` | ISO string | |
| `returnedAt` | ISO string \| null | |
| `remarks` | string | **PII-encrypted** |
| `issuedBy` | string | Username (plain) |

#### `auditLog`
IMS audit chain entries.

| Field | Type | Notes |
|-------|------|-------|
| `id` | number (auto) | |
| `ts` | ISO string | |
| `action` | string | |
| `actor` | string | Username (plain) |
| `payload` | object | |
| `hash` | string | HMAC-SHA256 chain link |

#### `users`

| Field | Type | Notes |
|-------|------|-------|
| `id` | number (auto) | |
| `username` | string | Plain text (index) |
| `name` | string | **PII-encrypted** |
| `svcNo` | string | **PII-encrypted** |
| `role` | string | `admin` or `user` (plain) |
| `pinHash` | string | argon2id PHC string |
| `recoveryHash` | string \| null | argon2id hash |
| `totpEnabled` | boolean | Plain |
| `totpSecret` | string \| null | **PII-encrypted** base32 secret |
| `backupCodes` | string[] \| null | SHA-256 hex digests (NOT PII-encrypted) |
| `totpLastUsedStep` | number | TOTP replay guard (plain) |
| `failedAttempts` | number | |
| `lockedUntil` | number \| null | Unix ms |

#### `meta`
Key-value store for database-level metadata.

| Key | Value |
|-----|-------|
| `piiKey` | Base64-encoded 32-byte AES-256 key |
| `dbInitAt` | ISO string |

#### `settings`
Key-value store for user-configurable settings.

| Key | Example value |
|-----|--------------|
| `security.idleTimeoutMinutes` | `15` |
| `unit.name` | `"1 Sqn"` |

---

## 5. Authentication System

### PIN hashing — argon2id

All PIN hashes use **argon2id** via the `hash-wasm` library (WASM, bundled).

**Parameters:**

| Parameter | Value |
|-----------|-------|
| Algorithm | argon2id |
| Time cost (t) | 3 iterations |
| Memory cost (m) | 65,536 KB (64 MB) |
| Parallelism (p) | 1 |
| Hash length | 32 bytes |
| Output format | PHC string: `$argon2id$v=19$m=65536,t=3,p=1$<salt_b64>$<hash_b64>` |
| Salt | 16-byte random per hash |

**Legacy support**: DJB2 hashes (V1 non-cryptographic, non-PHC format) are detected and transparently rehashed to argon2id on successful login.

### Recovery codes

- Format displayed: `XXXX-XXXX-XXXX` (12 chars with hyphens)
- Stored/verified as: `XXXXXXXXXXXX` (no hyphens, uppercase)
- Hashed with **argon2id** (same parameters as PIN)
- One-shot use — cleared after successful recovery login
- Stored as `recoveryHash` on user record

### PIN lockout

| Threshold | Action |
|-----------|--------|
| 5 failed attempts | 15-minute lockout |
| Counter reset | On success or after lockout expires |

### TOTP (2FA)

**Standard**: RFC 6238, HMAC-SHA1, 30-second steps, 6-digit codes.  
**Window**: ±1 step (±30 seconds).  
**Replay guard**: `totpLastUsedStep` — rejects previously-used step numbers.  
**Secret**: PII-encrypted in IDB. Decrypted in memory only during verification or QR display.

### TOTP backup codes

| Parameter | Value |
|-----------|-------|
| Count | 8 codes |
| Format | 8 uppercase hex chars (e.g. `A3F7C291`) |
| Hash | SHA-256 (Web Crypto) |
| Storage | Array of SHA-256 hex digests on user record (NOT PII-encrypted) |
| Single-use | Yes — used code removed from array |
| Timing safety | All 8 hashes always computed (no early exit) |

### Session token

On successful login, a 32-byte random token is generated and stored in **`sessionStorage`** as `qstore_session`.

**V2 uses `sessionStorage`** (not `localStorage`) because there is only one page — no cross-page session sharing is needed. `sessionStorage` is automatically cleared when the tab or browser window closes.

**Session invalidation**: Cleared on logout, auto-lock, manual lock, and tab/window close.

### Idle auto-lock

Auto-lock is **mandatory** — cannot be disabled. Minimum: 5 minutes. Default: 15 minutes.

**Implementation** (`shell.js`):

1. `_startIdleWatcher()` reads `security.idleTimeoutMinutes` from IDB settings
2. Six DOM events monitored: `mousemove`, `mousedown`, `keydown`, `touchstart`, `scroll`, `click` (`{ passive: true }`)
3. Each event sets `_lastActivityAt = Date.now()` and resets the `setTimeout` countdown
4. `visibilitychange` handler: on page becoming visible, checks elapsed wall-clock time vs `_lastActivityAt`. If ≥ timeout, lock immediately. Otherwise restart timer for remaining time.
5. The `visibilitychange` check handles **OS sleep/wake** — `setTimeout` is suspended during sleep, so elapsed wall-clock time catches the gap.

**Minimum enforcement:**

```js
const stored = parseInt(raw, 10);
const mins = (!isNaN(stored) && stored > 0) ? stored : _IDLE_DEFAULT_MINS; // 15
_idleTimeoutMs = mins * 60_000;
```

Values below 5 are rejected by the settings UI. The watcher defaults to 15 for any invalid/missing value.

---

## 6. Security Implementation

### PII encryption at rest

All personally-identifiable fields are encrypted using **AES-256-GCM**.

**Key management:**
- 256-bit `piiKey` generated once at DB init via `crypto.getRandomValues()`
- Stored in `meta` IDB store as Base64
- Never leaves IDB; never included in export files
- Loaded into memory once at app startup; cleared on lock/logout

**Per-field encryption:**
```
IV:         12 bytes random (crypto.getRandomValues()) per field per write
Ciphertext: AES-256-GCM(plaintext, piiKey, IV)
Stored as:  "~enc:<base64(IV + ciphertext)>"
```

`~enc:` prefix distinguishes encrypted from legacy plain-text values. Legacy unencrypted fields are returned as-is and re-encrypted on next write.

**Authentication tag**: AES-GCM includes a 128-bit tag. Tampered ciphertext causes decryption to throw — not silently ignored.

### Export file encryption

`.qstore` export files use:

| Parameter | Value |
|-----------|-------|
| KDF | PBKDF2, 310,000 iterations, HMAC-SHA-256 |
| Key length | 256 bits |
| Cipher | AES-256-GCM |
| IV | 12 bytes random per export |

No password recovery — by design.

### Audit chain

- Every significant action appends an entry to `auditLog`
- Each entry: `ts`, `action`, `actor`, `payload`, `hash`
- `hash` = HMAC-SHA256(prevHash || JSON.stringify({ts, action, actor, payload}), auditKey)
- `auditKey` derived from `piiKey` at runtime (not stored separately)
- Verifiable via Settings → Audit → Verify chain

**Limitations**: Prevents silent modification of historical records. Does not prevent full IDB deletion and restart.

### Build security

The built `qstore.html` contains no external resource loads — all CSS and JS are inlined. No CDN imports. Zero network dependencies at runtime.

---

## 7. Known Security Issues and Mitigations

### Issue 1 — `piiKey` stored unencrypted in IndexedDB

**Description**: The AES-256 `piiKey` is stored as a Base64 string in the `meta` store. An attacker with access to the browser's IDB files (disk image, backup) can extract the key and decrypt all PII.

**Mitigation**: Intended for locked-down, device-managed hardware. Physical access is a separate security control. See V3 TECHNICAL.md §10 Issue 1 for full analysis.

**Risk**: Medium — requires physical/remote device access.

### Issue 2 — Session token in `sessionStorage`

**V2 advantage over V3**: `sessionStorage` is automatically cleared on tab/window close, reducing the persistence window compared to `localStorage` (which V3 uses).

**Remaining risk**: XSS could exfiltrate the token within the session. Mitigated by zero-external-resource build and no `innerHTML` with user data.

**Risk**: Low.

### Issue 3 — Backup codes use SHA-256 (not argon2id)

Same analysis as V3. See §10 Issue 7 in V3 TECHNICAL.md. 8-char hex = 32-bit space, feasible to brute-force offline with IDB access. Planned mitigation: extend to 16 chars in a future version.

**Risk**: Low in typical deployment.

### Issue 4 — Audit chain tamper-evidence only, not tamper-prevention

A local admin user can delete the entire IDB. The chain verifies modification of existing records but cannot detect total erasure.

**Mitigation**: Regular `.qstore` exports to external storage.

**Risk**: Medium — insider threat.

### Issue 5 — TOTP secret in memory during enrollment

The decrypted TOTP secret is briefly in JavaScript memory during enrollment QR display. Shoulder-surfing risk.

**Mitigation**: Enrollment warning; secret cleared after step completes.

**Risk**: Low — physical/operational.

### Issue 6 — OS sleep / `setTimeout` bypass

**RESOLVED**: The `visibilitychange` handler with wall-clock elapsed time check ensures auto-lock fires on wake from OS sleep even if `setTimeout` was suspended. See §5 idle auto-lock for full implementation.

### Issue 7 — No mandatory export password strength enforcement

Weak/empty export passwords reduce protection of exported PII. No password complexity enforcement currently.

**Risk**: Low — user-controlled, documented.

---

## 8. Developer Recovery Procedures

### Scenario A — User locked out of 2FA (device lost, codes unavailable)

**Recovery via DevTools Console:**

1. Open `qstore.html` in Chrome/Edge
2. DevTools (F12) → Console

```javascript
// Open the database
const req = indexedDB.open('qstore');
req.onsuccess = e => { window.__db = e.target.result; console.log('DB open, version:', window.__db.version); };
```

```javascript
// List users
const tx = window.__db.transaction('users', 'readonly');
const store = tx.objectStore('users');
store.getAll().onsuccess = e => {
  console.table(e.target.result.map(u => ({
    id: u.id, username: u.username, totpEnabled: u.totpEnabled,
    hasCodes: !!u.backupCodes?.length
  })));
};
```

```javascript
// Disable TOTP for target user (replace TARGET_ID with actual id)
const TARGET_ID = 1;
const tx2 = window.__db.transaction('users', 'readwrite');
const store2 = tx2.objectStore('users');
store2.get(TARGET_ID).onsuccess = e => {
  const user = e.target.result;
  user.totpEnabled = false;
  user.totpSecret  = null;
  user.backupCodes = null;
  user.totpLastUsedStep = 0;
  store2.put(user);
  tx2.oncomplete = () => console.log('TOTP cleared for:', user.username);
};
```

3. Reload the page. User can log in with PIN only.
4. Advise user to re-enrol TOTP immediately.
5. Log recovery action in ACTIONS.log (date, username, reason — no real names).

---

### Scenario B — Admin PIN forgotten, no recovery code

```javascript
// Open DB (as above, step 1)

// List all users to find admin
const tx = window.__db.transaction('users', 'readonly');
const store = tx.objectStore('users');
store.getAll().onsuccess = e => { window.__users = e.target.result; console.table(window.__users.map(u => ({id:u.id, username:u.username, role:u.role}))); };
```

To set a new PIN, an argon2id hash is required. Options:

**Option A** — Use the in-page hash function if accessible:
```javascript
// Only works if QStoreApp._hashPin is exposed — check bundle's global name
const hash = await QStoreApp._hashPin('TEMP1234');
console.log(hash); // copy the PHC string
```

**Option B** — Generate hash externally using argon2id CLI or compatible tool with parameters:
- t=3, m=65536, p=1, hashLength=32, PHC format output

Then set it:
```javascript
const TARGET_ID = 1;
const NEW_HASH  = '$argon2id$v=19$m=65536,t=3,p=1$<salt>$<hash>'; // paste hash here
const tx3 = window.__db.transaction('users', 'readwrite');
const store3 = tx3.objectStore('users');
store3.get(TARGET_ID).onsuccess = e => {
  const u = e.target.result;
  u.pinHash = NEW_HASH;
  u.failedAttempts = 0;
  u.lockedUntil = null;
  store3.put(u);
  tx3.oncomplete = () => console.log('PIN reset for:', u.username);
};
```

After recovery: advise admin to change PIN and generate a recovery code immediately.

---

### Scenario C — Database corrupt / inaccessible

**Diagnosis:**
```javascript
const req = indexedDB.open('qstore');
req.onerror   = e => console.error('IDB error:', e.target.error);
req.onsuccess = e => console.log('IDB open, version:', e.target.result.version);
```

**Recovery**: Restore from `.qstore` export via Settings → Import.

**Last resort — delete IDB** (ALL DATA LOST):
```javascript
indexedDB.deleteDatabase('qstore');
```
Reload — app initialises fresh database.

---

### Scenario D — TOTP backup codes exhausted, device lost

Follow Scenario A to disable TOTP. As part of re-enrolment, generate a new set of backup codes and store them securely offline.

---

### Scenario E — `piiKey` lost

If the `meta` store is cleared or `piiKey` deleted, all PII-encrypted fields are permanently unreadable without the key.

**Only recovery**: restore from a `.qstore` export taken before the key was lost (export contains plaintext PII protected by the export password).

**Prevention**: Take regular `.qstore` exports.

---

## 9. Testing

### Manual test checklist

**Authentication:**
- [ ] New user PIN stored as argon2id PHC string (`$argon2id$` prefix in IDB)
- [ ] PIN login succeeds
- [ ] Wrong PIN increments `failedAttempts`; 5 wrong → lockout
- [ ] Lockout expires after 15 minutes
- [ ] TOTP enrolment and login
- [ ] TOTP replay rejected
- [ ] Backup code accepted and removed after use
- [ ] Recovery code accepted, cleared, forces PIN change
- [ ] Auto-lock after configured timeout
- [ ] Auto-lock on wake from OS sleep
- [ ] Timeout cannot be set below 5 minutes

**PII encryption:**
- [ ] New cadet added: surname, given, email, notes show `~enc:` in IDB
- [ ] Legacy unencrypted records display correctly
- [ ] Loan issued: borrowerName and remarks encrypted
- [ ] Export/import round-trip with correct password

**Audit chain:**
- [ ] New entry on each significant action
- [ ] Chain verifies clean
- [ ] Modified record breaks chain verification

**Loans (regression — staff borrower):**
- [ ] Staff member appears in borrower datalist
- [ ] Selecting staff member populates hidden svcNo
- [ ] Picker resets correctly on tab navigation

**Build:**
- [ ] `node build.js` produces `dist/qstore.html` and `docs/index.html`
- [ ] Argon2 integrity check passes (no build error about `$${`)

---

## 10. Operational Notes

### Supported browsers

Chrome/Edge 90+, Firefox 90+, Safari 15+. No Internet Explorer.

### Data locality

Each browser on each device has a separate IDB. No sync. Canonical device must be designated per IDB instance.

### V2 vs V3

V2 (`DB_VERSION=4`) and V3 (`DB_VERSION=7`) share the database name `qstore`. Opening both from the same browser origin causes V3 to upgrade the V2 database. Avoid concurrent use of both versions post-migration.

### sessionStorage behaviour

V2 session token clears when the tab/window closes (sessionStorage). Users will need to log in again after a browser restart. This is a feature, not a bug — it reduces the risk of an unattended device being accessed with a persistent session.

### Distribution policy

V2 (`dist/qstore.html`) is the community/open-source build. It is a single self-contained HTML file. Distribution requires no special procedure — copy the file. Ensure `MANUAL.html` is included alongside it.

V3 has a separate distribution policy (named zip packages, developer confirmation required before building). See V3 `TECHNICAL.md` §9.

---

*End of QStore IMS v2 Technical Reference Manual*
*Classification: Developer / Maintainer only. Not for distribution.*
