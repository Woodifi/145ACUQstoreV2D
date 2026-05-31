# QStore IMS V2

Version 2.3.0 | Maintenance | `C:\ClaudeAImemoryfolder\QStore\qstore-v2-wip` | branch: master

## Build
```
node build.js                                        # dist/qstore.html + docs/index.html (~1647 KB)
node build.js --dev                                  # dev build (no minification)
node build.js --dist --recipient="Unit Name"         # dist/qstore-UNIT-DATE-ID.html (no docs touch)
```

## Tests — 522 across 16 suites
Run all (PowerShell, from project root):
```powershell
cd "C:\ClaudeAImemoryfolder\QStore\qstore-v2-wip"
$pass=0; $fail=0
foreach ($t in @("test-ranks","test-unit-branding","test-export-import","test-recovery","test-cadets","test-loans","test-audit","test-pdf","test-ab189","test-cloud-disable","test-v1-import","test-inventory","test-csv-import","test-stocktake","test-qr","test-license")) {
  $out = node "$t.mjs" 2>&1; $r = ($out -split "`n" | Select-String "pass|fail" | Select-Object -Last 1)
  if ($r -match "fail") { $fail++; Write-Host "FAIL: $t — $r" } else { $pass++; Write-Host "ok: $t" }
}
Write-Host "`n=== $pass passed, $fail failed ==="
```

## Key Source Files
| File | Purpose |
|------|---------|
| `src/ui/shell.js` | Navigation, boot, session, page mounting, idle lock |
| `src/cloud.js` | MSAL 5.x auth, OneDrive sync, popup bridge |
| `src/storage.js` | IndexedDB API, DB_VERSION 3, atomic transactions |
| `src/pdf.js` | PDF generation (jsPDF) — AB189, nominal roll, stocktake, AB174 |
| `src/auth.js` | PIN auth, argon2id recovery, lockout, TOTP, session |
| `src/pii.js` | AES-256-GCM field-level PII encryption |
| `qstore.css` | All styles — BEM prefixes below |
| `build.js` | esbuild bundler + dist fingerprinting |

## CSS BEM Prefixes
`cad__` cadets · `stf__` staff · `inv__` inventory · `lns__` loans · `aud__` audit
`cat__` categories · `ref__` reference · `ord__` orders · `req__` requests · `usr__` users

## MSAL Popup Auth (important — fixed May 2026)
- Popup window calls `broadcastResponseToMainFrame()` from `@azure/msal-browser/redirect-bridge`
- Main window `waitForBridgeResponse()` listens on `BroadcastChannel(libraryState.id)`
- shell.js boot: `if (await Sync.handlePopupAuth()) return` — exits early in popup window
- `_hasPopupResponseInUrl()` decodes base64 MSAL state to detect `interactionType === 'popup'`
- Do NOT use `handleRedirectPromise()` for popup — it throws `stateInteractionTypeMismatch`

## Architecture
Single HTML · Vanilla JS ES modules · esbuild bundle · IndexedDB (DB_VERSION 3) · MSAL 5.x OneDrive sync
PII encrypted at rest (cadets/staff/loans/users/requests/orders/stocktake) · TOTP 2FA · argon2id PIN recovery
