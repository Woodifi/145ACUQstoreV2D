# QStore IMS v2 — User Manual

**Author:** Sean Scales  
**Version:** 2.1  
**Licence:** Proprietary — see [LICENSE](LICENSE)  
**Contact:** admin@seanscales.com.au

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Getting Started](#2-getting-started)
3. [User Roles and Permissions](#3-user-roles-and-permissions)
4. [Inventory](#4-inventory)
5. [Loans](#5-loans)
6. [Cadets / Nominal Roll](#6-cadets--nominal-roll)
7. [Stocktake](#7-stocktake)
8. [Audit Log](#8-audit-log)
9. [Settings](#9-settings)
10. [Cloud Sync (OneDrive)](#10-cloud-sync-onedrive)
11. [Backup and Restore](#11-backup-and-restore)
12. [PIN Security](#12-pin-security)
13. [OC PIN Recovery](#13-oc-pin-recovery)
14. [Issue Kits](#14-issue-kits)
15. [QR Codes](#15-qr-codes)
16. [Troubleshooting](#16-troubleshooting)

---

## 1. Introduction

QStore IMS (Inventory Management System) is a self-contained browser-based application for managing Australian Army Cadet Q-Store operations. It runs entirely in the browser using local storage — no internet connection or server is required for day-to-day use.

**Key capabilities:**
- Inventory tracking with photo support and QR codes
- Loan issue and return workflow with printable vouchers
- Nominal roll (cadets and staff)
- Stocktake with discrepancy reporting
- Tamper-evident audit log
- Optional cloud backup via Microsoft OneDrive
- Role-based access for OC, QM, Staff, and Cadets

**Data storage:** All data is stored in IndexedDB in the browser on the device running the app. Data does not leave the device unless cloud sync is configured or a manual backup is exported.

---

## 2. Getting Started

### Launch Splash Screen

When the app loads, a full-screen splash is displayed showing the unit logo and a 5-second countdown. The app proceeds automatically to the login screen once the countdown completes and all data has loaded. No action is required.

### First Login

When the app is opened for the first time, a default Administrator account is created automatically.

1. Open `qstore.html` in a modern browser (Chrome, Edge, Firefox, or Safari)
2. Select **Administrator** from the user list
3. Enter PIN: **0000**
4. You will be prompted to change the default PIN immediately — do this before proceeding

### Initial Setup (OC)

After changing the default PIN, complete unit setup:

1. Navigate to **Settings**
2. In **Unit Details**, enter:
   - Unit name (e.g., *145 ACU Moranbah Community*)
   - Unit code (e.g., *145ACU*)
   - State
   - OC/QM name and email
   - QM rank
3. Upload a unit logo if desired
4. Click **Save unit details**

### Adding Users

Before other staff and cadets can log in, add them from **Settings**:

1. Go to **Settings → User accounts**
2. Click **+ Add user**
3. Fill in name, username, role, and service number
4. Set an initial PIN (users should change this on first login)

> **Note:** The Settings page is only accessible to the OC (Commanding Officer) role.

---

## 3. User Roles and Permissions

QStore IMS has five roles. Assign the appropriate role when creating each user account.

| Role | Code | Description |
|------|------|-------------|
| Commanding Officer | OC | Full access including Settings. Only one OC account should exist. |
| Quartermaster (Staff) | QM | Full operational access — inventory, loans, cadets, stocktake, audit. Cannot access Settings. |
| Staff | Staff | Can view all pages and request issues. Cannot add/edit inventory or manage cadets. |
| Cadet | Cadet | Can view inventory and their own loans. |
| Read-Only | RO | View-only access. No actions. |

### Permission Reference

| Action | OC | QM | Staff | Cadet | RO |
|--------|----|----|-------|-------|----|
| View inventory | ✓ | ✓ | ✓ | ✓ | ✓ |
| Add / Edit inventory items | ✓ | ✓ | | | |
| Delete inventory items | ✓ | | | | |
| Issue loans | ✓ | ✓ | | | |
| Return loans | ✓ | ✓ | | | |
| View own loans | ✓ | ✓ | ✓ | ✓ | |
| View all loans | ✓ | ✓ | ✓ | ✓ | ✓ |
| Manage cadets/staff | ✓ | ✓ | | | |
| Run stocktake | ✓ | ✓ | | | |
| View audit log | ✓ | ✓ | | | |
| Print / QR codes | ✓ | ✓ | | | |
| Import CSV | ✓ | ✓ | | | |
| Manage user accounts | ✓ | | | | |
| Settings | ✓ | | | | |

### Managing User Accounts

The **Users** page (OC only, visible in the top navigation bar) is the central hub for all user account administration.

#### Adding a User

1. Navigate to **Users**
2. Click **+ Add User**
3. Fill in:
   - **Full name** — as it will appear on the login screen and audit log (e.g. `CAPT J Smith`)
   - **Username** — short, unique login identifier (e.g. `jsmith`); case-insensitive
   - **Role** — select the appropriate role from the table above
   - **Service number** — optional; stored for reference only
   - **Initial PIN** — 4-digit PIN the user will use on first login; enter it twice to confirm
4. Click **Add User**

> **Tip:** Tell new users their initial PIN verbally and advise them to change it in Settings on first login.

#### Editing a User

Click **Edit** on any row to update the user's name, username, role, or service number. PIN is not changed through the Edit form — use **Reset PIN** separately if needed.

#### Resetting a PIN

Click **Reset PIN** on any row to set a new 4-digit PIN for that user. The change takes effect immediately on next login.

#### Deleting a User

Click **Delete** on any row and confirm. Restrictions:

- You cannot delete your own account
- You cannot delete the last remaining OC account (assign another OC first)
- Deleting a user removes their login access only — all loan history, audit entries, and records they created are preserved

---

## 4. Inventory

The Inventory page lists all items in the Q-Store. It is the first page shown after login.

### Viewing Inventory

- **Search:** Type in the search box to filter by NSN, item name, or category. Results update as you type.
- **Category filter:** Use the dropdown to show only one category.
- **Columns:** NSN, photo, name, category, authorised qty, on hand, on loan, unserviceable, condition, location.
- **Condition badge:** Coloured badge showing overall item status. When an item has a mixed breakdown, a detail line appears below — e.g. *3 Svc · 1 U/S · 1 Repr*.

### Condition Breakdown

Every inventory item tracks the same five condition states as Stocktake:

| Field | Abbreviation | Meaning |
|-------|-------------|---------|
| Serviceable | Svc | Ready for issue |
| Unserviceable | U/S | Damaged or non-functional |
| In Repair | Repr | Temporarily unavailable (being repaired) |
| Calibration Due | Cal | Must be calibrated before issue |
| Written Off | W/O | Beyond repair — pending Board of Survey |

The **Condition badge** and **Unsvc** count are derived automatically from these fields. There is no separate condition dropdown to maintain — the breakdown drives everything.

### Adding an Item (OC / QM)

1. Click **+ Add item**
2. Complete the form:
   - **NSN** — National Stock Number in 4-2-3-4 format (e.g., *8470-66-001-0001*). Non-standard NSNs are accepted with a warning.
   - **Name** — Item description
   - **Category** — Uniform, Equipment, Safety, Training Aids, Field Stores, Medical, or ICT
   - **Authorised qty** — Establishment quantity
   - **On hand** — Current physical quantity
   - **Condition breakdown** — Enter a qty in each applicable condition field. The running total (shown top-right of the section) must equal On hand. Changing On hand automatically adjusts Svc to keep the total consistent.
   - **Location** — Storage location within the Q-Store
3. Click **Save item**

> **Tip:** For new items being added for the first time, the Svc field defaults to match On hand. Adjust if any units are already unserviceable.

### Editing an Item (OC / QM)

Click **Edit** on any row to modify any field. The condition breakdown fields are pre-filled with current data. Changes are audited.

### Loan History

Click **History** on any row to see the complete loan history for that item — borrower, issue date, return date, quantity, and return status.

### Deleting an Item (OC only)

Click **Delete** on a row. You must provide a reason (up to 200 characters). Deletion is permanent and audited.

### Item Photos

Click the photo icon (camera) on any inventory row to upload a photo. Recommended: photograph the item label or the item itself. Photos are resized and stored locally. Supported formats: JPEG, PNG, WebP.

### Printing the Stock Report

Click **⎙ Print stock** to generate a PDF of the currently-visible items (respects active search and category filters). The report includes:
- A **Condition** column showing the full breakdown in compact format — e.g. *5S/2U/1R* = 5 Serviceable, 2 Unserviceable, 1 In Repair. *Svc* means all units are serviceable.
- **Available** qty (On hand minus On loan).
- Rows with more than half the stock not ready for issue are highlighted in red.

### QR Code Labels

Click **⎙ QR codes** to generate printable QR code labels for all currently-visible items. Scan a label with **⌖ Scan** to quickly look up an item.

---

## 5. Loans

The Loans page manages equipment issue and return.

### Issuing Equipment (OC / QM)

1. Navigate to **Loans → Issue** tab
2. Select the **borrower** from the cadet/staff list (search by name or service number)
3. Select the **purpose**:
   - Initial Issue
   - Annual Camp
   - Training Activity
   - Parade Night
   - Field Exercise
   - Ceremonial
   - Course Attendance
   - Other
4. Set **issue date** and **due date**
5. Add items:
   - Click **+ Add item line** for each item
   - Search by name or NSN
   - Enter quantity (cannot exceed available stock)
6. Add remarks if needed
7. Click **Issue** to confirm

A loan reference number (LN-XXXX) is assigned automatically. The loan is added to the All Loans list as active.

### Using Issue Kits

If you have pre-defined kits (e.g., *Initial Issue — Male Cadet*):

1. On the Issue tab, click **⊞ Load kit**
2. Select the kit from the list
3. The item lines are pre-filled — adjust quantities as needed before issuing

See [Section 14 — Issue Kits](#14-issue-kits) for creating kits.

### Returning Equipment (OC / QM)

1. Navigate to **Loans → Return** tab
2. Find the active loan by borrower name or loan reference
3. Click **Return**
4. Set **return condition** for each item:
   - Serviceable
   - Unserviceable
   - Write-off
5. Add return remarks if needed
6. Click **Confirm return**

Stock quantities update automatically on return. Unserviceable returns increment the item's unserviceable count.

### Viewing All Loans

The **All Loans** tab shows every loan record with filter options:
- **Active** — currently outstanding
- **Returned** — completed loans
- **Overdue** — active loans past their due date
- **All** — full history

### Printing Vouchers

A printable loan voucher (AB180-style) is available from any loan record.

---

## 6. Cadets / Nominal Roll

The Cadets page manages the unit's personnel records for both cadets and staff.

### Viewing the Roll

All logged-in users can view the nominal roll. Search by name or service number, and filter by company, platoon, and section (or by platoon if unit sub-structure is not configured). Tick **Show inactive** to include deactivated records.

**Sort order:** Staff appear first sorted by rank then surname. Cadets follow, grouped by company → platoon → section in the order configured in Settings, then sorted by rank then surname within each group. This applies to the on-screen table and the printed nominal roll PDF.

| Group | Order |
|-------|-------|
| Staff | COL-AAC → LTCOL-AAC → MAJ-AAC → CAPT-AAC → LT-AAC → 2LT-AAC → DAH |
| Cadets | UO → WO1 → WO2 → SSGT → SGT → CPL → LCPL → CDT |

### Unit Sub-Structure (Company / Platoon / Section)

If your unit is organised into companies, platoons, and sections, configure this in **Settings → Unit sub-structure**. Once configured:

- The cadet add/edit form shows cascading **Company → Platoon → Section** dropdowns instead of a free-text platoon field
- The cadets table displays Company, Platoon, and Section columns and inserts gold band headers between groups
- Filter controls cascade: selecting a Company reveals its Platoons; selecting a Platoon reveals its Sections
- The nominal roll PDF renders with group band headings

Existing records that only have a free-text **Plt** value remain fully functional — they display in legacy mode until re-saved with the new dropdowns. No data migration step is required.

### Adding a Person (OC / QM)

1. Click **+ Add cadet/staff**
2. Complete the form:
   - **Service number** — AAC service number (primary identifier)
   - **Surname** — automatically uppercased
   - **Given names** — optional
   - **Rank** — type or select from the datalist (supports both staff and cadet ranks)
   - **Company / Platoon / Section** — cascading dropdowns (if unit sub-structure is configured) or free-text Platoon field (if not)
   - **Email** — optional
   - **Notes** — optional free text
3. The **person type** (cadet or staff) is derived automatically from the rank entered
4. Click **Save**

### Editing and Deactivating

Click **Edit** on any person to modify their record. To deactivate a person (e.g., they have left the unit), untick **Active** — their record and loan history are retained.

Tick **Show inactive** to view deactivated records.

---

## 7. Stocktake

The Stocktake page guides you through a physical count of all Q-Store items.

### Starting a Stocktake (OC / QM)

1. Navigate to **Stocktake**
2. Enter counts for each item using the **five condition columns** — one for each condition state in the system:

| Column | Abbreviation | Meaning |
|--------|-------------|---------|
| Serviceable | Svc | Items in good working order |
| Unserviceable | U/S | Items damaged or non-functional; awaiting repair or assessment |
| In Repair | Repr | Items currently being repaired (temporarily unavailable) |
| Calibration Due | Cal | Items requiring calibration before they can be issued |
| Written Off | W/O | Items beyond economic repair; pending formal Board of Survey |

3. The **Total** column shows the sum of all five columns automatically. **Variance** compares Total to the system's on-hand quantity
4. Optionally add **notes** per item (condition is derived automatically from the counts — see Finalising below)
5. The live summary shows: counted, matching, discrepancies, and missing items
6. Use the category filter to work through one section at a time
7. Drafts save automatically — you can leave and return without losing progress

> **Tip:** Leave any column blank (or at 0) if there are none of that condition. You only need to fill in the columns that apply. The In Repair and Calibration Due inputs turn amber when filled as a visual reminder.

### Finalising

1. Once all items are counted, click **Finalise stocktake**
2. Review the discrepancy table (shows all five condition columns per item) and confirm
3. On finalise, inventory is updated:
   - **On hand** ← total (Svc + U/S + Repr + Cal + W/O)
   - **Full condition breakdown** ← stored per item (Svc / U/S / Repr / Cal / W/O), so the Inventory page and stock report PDF immediately reflect the exact post-stocktake state
   - **Unserviceable** ← U/S + Repr + Cal (all items not ready for issue)
   - **Written off** ← W/O count (tracked for follow-up Board of Survey)
   - **Condition badge** ← derived automatically from the highest-severity count present (W/O > Repr > Cal > U/S > Svc)
4. Each discrepancy is recorded in the audit log with a full condition breakdown
5. Write-off items get a separate `stocktake_writeoff` audit entry flagging them for formal action
6. A stocktake report PDF (with all five condition columns) is available

> **Note:** Finalising is irreversible. Ensure all counts are correct before confirming. Written-off items must be formally struck off charge via a Board of Survey (AB174) — this is not done automatically by the system.

---

## 8. Audit Log

The Audit page provides a tamper-evident log of all actions taken in the system.

### Viewing the Log (OC / QM)

Navigate to **Audit**. Entries are shown in reverse chronological order, 200 per page.

Each entry shows:
- Sequence number
- Timestamp
- Action type
- User who performed the action
- Description

### Exporting the Audit Log (OC / QM)

The currently-filtered entries can be exported for external records or archiving:

- **⬇ Export CSV** — downloads a `.csv` file compatible with Excel and other spreadsheets
- **⬇ Export JSON** — downloads a `.json` file for programmatic processing

Both exports honour the active search and action filter — use filters to narrow to a date range or action type before exporting. The filename includes the unit code and today's date (e.g., `qstore-audit-145acu-2026-05-18.csv`).

### Action Types

| Action | Meaning |
|--------|---------|
| add | Inventory item added |
| adjust | Inventory item edited or deleted |
| issue | Loan issued |
| return | Loan returned |
| cadet_add | Person added to nominal roll |
| cadet_update | Person record updated |
| cadet_delete | Person deactivated/deleted |
| pin_change | User changed their PIN |
| recovery_set | OC recovery code generated |
| recovery_reset | OC PIN reset using recovery code |
| login | Successful login |
| login_failed | Failed PIN attempt |
| data_export | Backup exported |
| data_imported | Backup imported |
| stocktake | Stocktake finalised |

### Audit Chain

Each entry is cryptographically linked to the previous one. If any entry is altered or deleted, the chain breaks. Click **Verify chain** to run an integrity check — a broken chain indicates potential tampering.

---

## 9. Settings

Settings is accessible to the **OC only**. Navigate to **Settings** from the top navigation.

### Unit Details

Configure the information that appears in the app header, on the login screen, and on generated documents (AB189, stocktake reports).

| Field | Purpose |
|-------|---------|
| Unit name | Full unit name (e.g., *145 ACU Moranbah Community*) |
| Unit code | Short code (e.g., *145ACU*) |
| State | State/territory for AB189 forms |
| OC/QM name | Appears on signature blocks |
| OC/QM email | Contact email |
| QM rank | QM's rank for signature blocks |
| Unit logo | Displayed in the header and on the launch splash screen. Upload the highest-resolution version available — stored as lossless PNG up to 1024 × 1024 px. |

### Unit Sub-Structure

Configure the company / platoon / section hierarchy for your unit. Click **Configure structure** to open the tree editor:

1. Click **+ Add company** and type the company name (e.g., *A Coy*)
2. Under each company, click **+ Add platoon** (e.g., *1 Plt*)
3. Under each platoon, click **+ Add section** (e.g., *1 Sec*)
4. Click **Save structure** when done

Use the **×** buttons to remove companies, platoons, or sections. Click **Clear structure** to remove all configuration and revert to legacy free-text platoon entry.

> **Note:** Changing or removing entries in the structure does not alter existing cadet records — the stored company/platoon/section names on each record remain unchanged. Update individual cadet records if you rename a company or platoon.

### User Accounts

Add, edit, and manage user accounts. Each user has:
- Name and username
- Role (OC, QM, Staff, Cadet, Read-Only)
- Service number
- PIN (set by OC; user changes on first login)

### OC PIN Recovery

Generate a 12-character one-shot recovery code. Store this code **off-device** (printed, in a safe, or in a password manager). If the OC forgets their PIN, this code can reset it from the login screen.

- Click **Generate new code** to create a recovery code
- The code is shown once — copy it immediately
- Each code can only be used once; a new one must be generated after use

### About

Displays version information, authorship, and the proprietary licence.

---

## 10. Cloud Sync (OneDrive)

Cloud sync is optional. It backs up all data to a Microsoft OneDrive folder so it can be accessed from other devices and is protected against device loss.

### Requirements

- A Microsoft account (personal, school, or work)
- An Azure App Registration with the redirect URI matching your app's URL

### Setup

1. Go to **Settings → Cloud sync**
2. Note the **Redirect URI** shown — you must register this exact URI in Azure
3. Enter your **Azure Application (Client) ID**
4. Set the **OneDrive folder name** (default: *QStore*)
5. Set the **file name** (default: *qstore_data.json*)
6. Click **Save**
7. Click **Sign in** and complete the Microsoft authentication flow

> **Client ID security:** After the first successful sync, the Azure Client ID is hidden and replaced with a *Client ID configured* indicator. To view the ID at any time, click and hold the **Hold to reveal** button — the value is shown only while held and immediately hidden on release.

### Using Cloud Sync

- **Auto-sync** (default: on) — syncs automatically when you make changes
- **Sync now** — manually push current data to OneDrive
- **Load from cloud** — download and replace local data with the cloud copy (destructive — confirms before proceeding)

> **Note:** Cloud sync is unavailable when the app is opened directly as a `file://` URL. Host it on a web server (GitHub Pages, SharePoint, or a local server) for cloud sync to work.

---

## 11. Backup and Restore

Manual backup/restore is available in **Settings → Data backup & restore**. Use this to:
- Keep a local copy off-device
- Transfer data to a new device
- Restore after accidental data loss

### Exporting a Backup

1. Click **Export backup**
2. A JSON file is downloaded named `qstore-backup-<unitcode>-<date>.json`
3. Store this file in a safe location (not on the same device)

The backup includes all inventory, photos, loans, cadets, users, settings, and the full audit chain.

### Importing a Backup

1. Click **Import backup**
2. Select the previously exported `.json` file
3. Confirm — **this replaces all current data**
4. The audit chain is preserved and extended with an import entry

### CSV Import

Inventory items can be bulk-imported from a spreadsheet:

1. Click **Import CSV**
2. Download the template if needed
3. Map your columns to the required fields
4. Preview and confirm the import

---

## 12. PIN Security

Each user authenticates with a 4-digit PIN.

### PIN Rules

- Must be exactly 4 digits
- Cannot be `0000` (the default — must be changed on first login)
- Stored using Argon2id hashing — the actual PIN is never stored

### Changing Your PIN

1. Log in
2. Click your name/role in the top-right corner
3. Select **Change PIN**
4. Enter current PIN, then new PIN twice

### PIN Lockout

Repeated failed attempts trigger automatic lockouts:

| Failed attempts | Lockout duration |
|----------------|-----------------|
| 5 | 30 seconds |
| 10 | 5 minutes |
| 15+ | 30 minutes |

Lockouts apply per user account. Other users are unaffected.

---

## 13. OC PIN Recovery

If the OC forgets their PIN and no recovery code was generated:

- The OC account cannot be recovered without a recovery code
- **Prevention:** Always generate and securely store a recovery code in **Settings → OC PIN recovery**

### Using a Recovery Code

1. On the login screen, select the OC account
2. Click **Forgot PIN?**
3. Enter the 12-character recovery code
4. Enter and confirm a new PIN
5. The recovery code is consumed — generate a new one immediately

---

## 14. Issue Kits

Issue kits are pre-defined bundles of items (e.g., *Initial Issue — Male Cadet*) that pre-fill the loan issue form with a single click.

### Creating a Kit (OC / QM)

1. Go to **Inventory**
2. Click **⊞ Kits**
3. Click **+ New kit**
4. Enter a kit name (required) and description (optional)
5. Add item lines — search for items and set quantities
6. Click **Create kit**

**Kit form behaviour:**
- Clicking outside the form or pressing Escape does **not** close it — data is preserved until you explicitly save or cancel
- When a kit has many item lines the list becomes scrollable; new lines are added at the bottom and the list scrolls automatically
- Clicking **Cancel** asks for confirmation before discarding unsaved changes

### Using a Kit

1. Go to **Loans → Issue** tab
2. Click **⊞ Load kit**
3. Select the kit — item lines are pre-filled
4. Adjust quantities if needed (e.g., different sizes)
5. Proceed with the issue as normal

**Notes:**
- If a kit item has zero available stock, it is skipped with a warning
- Kits are templates only — they do not affect stock until the loan is issued
- Renaming an inventory item is reflected in all kits automatically

---

## 15. QR Codes

QR code labels allow quick item lookup using a phone or tablet camera.

### Printing Labels

1. On the Inventory page, filter to the items you want labels for (or show all)
2. Click **⎙ QR codes**
3. A PDF is generated with one label per item, including NSN, name, and QR code

### Scanning Labels

1. Click **⌖ Scan** on the Inventory page
2. Allow camera access if prompted
3. Point the camera at a QR code label
4. The matching item is highlighted in the inventory list

---

## 16. Troubleshooting

### App won't load / blank screen

- Ensure JavaScript is enabled in the browser
- Try a hard refresh: `Ctrl + Shift + R` (Windows) or `Cmd + Shift + R` (Mac)
- Check the browser console (F12 → Console) for error messages

### Forgot OC PIN and no recovery code

There is no bypass for a lost OC PIN without a recovery code. Options:
- Import a recent backup (data is restored but the PIN issue remains — you will need to reset the PIN via the default admin account if it still exists)
- Contact admin@seanscales.com.au for assistance

### Data appears missing after a browser update or profile change

IndexedDB data is tied to the browser profile and origin. If you switch browsers, profiles, or reinstall the browser, data may not be present. **Always keep a current backup export.**

### Cloud sync not working

- Ensure the redirect URI in Azure exactly matches the URL shown in Settings
- Ensure the Azure app has the required Microsoft Graph permissions (`Files.ReadWrite`, `offline_access`, `openid`, `profile`)
- Try signing out and back in
- Cloud sync requires the app to be served over HTTPS or from `localhost`

### Search cursor jumps out of the box while typing

Upgrade to the latest version of the app — this was fixed in v2.

### Items show incorrect stock levels

Run a stocktake to reconcile physical counts with the system. Check the Audit log for unexpected adjustments.

### Audit chain verification fails

A broken audit chain indicates that data has been modified outside the application (e.g., via browser DevTools or a corrupted import). Import from your most recent known-good backup.

---

*QStore IMS v2 — © 2025 Sean Scales. All rights reserved.*  
*Proprietary software — redistribution and modification prohibited without written consent.*
