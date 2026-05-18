# QStore IMS v2 — User Manual

**Author:** Sean Scales  
**Version:** 2.3.0  
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
8. [AAC QStore Orders](#8-aac-qstore-orders)
9. [Audit Log](#9-audit-log)
10. [Settings](#10-settings)
11. [Cloud Sync (OneDrive)](#11-cloud-sync-onedrive)
12. [Backup and Restore](#12-backup-and-restore)
13. [PIN Security](#13-pin-security)
14. [OC PIN Recovery](#14-oc-pin-recovery)
15. [Issue Kits](#15-issue-kits)
16. [QR Codes](#16-qr-codes)
17. [Troubleshooting](#17-troubleshooting)

---

## 1. Introduction

QStore IMS (Inventory Management System) is a self-contained browser-based application for managing Australian Army Cadet Q-Store operations. It runs entirely in the browser using local storage — no internet connection or server is required for day-to-day use.

**Key capabilities:**
- Inventory tracking with five-state condition breakdown, photo support, and QR codes
- Loan issue and return workflow with printable vouchers and overdue tracking
- Nominal roll (cadets and staff) with company / platoon / section grouping
- Stocktake with full condition breakdown and blank worksheet PDF
- AAC QStore order PDF import with IMS receive workflow
- Tamper-evident audit log
- Optional cloud backup via Microsoft OneDrive
- Role-based access for OC, QM, Staff, Cadets, and Read-Only users

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

### Dashboard

After logging in, the **Dashboard** (home page) gives an at-a-glance overview of the Q-Store:

- **Stat tiles** — total items, items on loan, overdue loans, and unserviceable items
- **Stocktake status** — date and readiness of the last stocktake
- **Quick actions** — shortcuts to Issue, Return, Add Item, and run a Stocktake
- **Recent audit** — the five most recent audit log entries

The Dashboard is the first page shown after login. Click **Dashboard** in the navigation bar to return to it at any time.

### Adding Users

Before other staff and cadets can log in, add them from the **Users** page:

1. Go to **Users** (visible in the navigation bar — OC only)
2. Click **+ Add User**
3. Fill in name, username, role, service number, and initial PIN
4. After saving, the PIN is displayed **once** — note it down and give it to the user verbally

> **Note:** Only the OC can manage user accounts and PINs. Users cannot change their own PINs. If a user forgets their PIN, they must ask the OC to reset it via **Users → Reset PIN**.

---

## 3. User Roles and Permissions

QStore IMS has five roles. Assign the appropriate role when creating each user account.

| Role | Code | Description |
|------|------|-------------|
| Commanding Officer | OC | Full access including Settings. Only one OC account should exist. |
| Quartermaster (Staff) | QM | Full operational access — inventory, loans, cadets, stocktake, orders, audit. Cannot access Settings. |
| Staff | Staff | Can view all pages. Cannot add/edit inventory or manage cadets. |
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
| Manage cadets / staff | ✓ | ✓ | | | |
| Run stocktake | ✓ | ✓ | | | |
| Import / manage orders | ✓ | ✓ | | | |
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
   - **Initial PIN** — 4-digit PIN for the user's first login; enter it twice to confirm. The PIN is visible while you type.
4. Click **Add User**
5. A **show-once screen** displays the new PIN — note it down immediately and give it to the user verbally. Click **Done** to close.

> **Security policy:** Only the OC can set or reset PINs. Users cannot change their own PINs. If a user forgets their PIN, they must ask the OC to reset it. Once set, the PIN cannot be retrieved — even the OC cannot view it again.

#### Editing a User

Click **Edit** on any row to update the user's name, username, role, or service number. PIN is not changed through the Edit form — use **Reset PIN** separately if needed.

#### Resetting a PIN

Click **Reset PIN** on any row, enter a new 4-digit PIN and confirm it, then click **Reset PIN**. A **show-once screen** then displays the new PIN — note it down and give it to the user verbally. The change takes effect immediately.

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
   - **Category** — Select from the unit's configured categories (see [Section 10 — Settings](#10-settings))
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

The Loans page manages equipment issue and return. When any active loans are past their due date, a **red badge** showing the overdue count appears on the **Loans** navigation item as a reminder.

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

See [Section 15 — Issue Kits](#15-issue-kits) for creating kits.

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

#### Platoon Migration Wizard

If you previously used the free-text platoon field and have since configured unit sub-structure, use **Settings → Unit sub-structure → ↝ Migrate** to bulk-reassign cadets to the new structure. The wizard maps existing free-text platoon values to the configured platoon names.

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

### Bulk CSV Import (OC / QM)

Import multiple cadets or staff from a spreadsheet in one operation:

1. Click **⇪ Import CSV** in the Cadets toolbar
2. Prepare your CSV with columns: `svcNo`, `surname`, `givenNames`, `rank`, `company`, `platoon`, `section` (company/platoon/section accept aliases matching your configured structure)
3. Upload the file and review the preview — rows with validation errors are highlighted
4. Click **Confirm import** to add all valid rows

Existing records with the same service number are skipped (no overwrite). The import is audited as `cadet_add` for each person created.

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

### Blank Stocktake Worksheet PDF

Click **⎙ Worksheet** to generate a blank printed count sheet. The worksheet lists all current inventory items with empty count columns for each condition state — use it to record physical counts on the floor before entering them into the system.

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
6. A stocktake report PDF (with all five condition columns) is available after finalising

> **Note:** Finalising is irreversible. Ensure all counts are correct before confirming. Written-off items must be formally struck off charge via a Board of Survey (AB174) — this is not done automatically by the system.

---

## 8. AAC QStore Orders

The **Orders** page is a unit-only tracking module for supply orders placed through the AAC QStore system. It does not connect to or modify AAC QStore — it reads exported PDFs and uses them to track orders and update your local IMS inventory.

**Access:** OC and QM only.

### Overview

| Concept | Description |
|---------|-------------|
| Request | Order submitted to AAC QStore but not yet dispatched |
| Issue | Items dispatched by AAC QStore — can be received into IMS |
| Pending | Imported order not yet received into IMS |
| Received | Order processed — IMS inventory updated |

### Importing an Order PDF (OC / QM)

1. Download the PDF from AAC QStore
2. Navigate to **Orders** and click **Import PDF Order**
3. Select the PDF — the system extracts:
   - Order number and category (Uniform / Equipment / General)
   - Order status (Request or Issue)
   - Date, requestor name, rank, service number, and unit
   - All line items: NSN, description, qty required, qty requisitioned, qty received
4. An **editable review screen** opens before the order is saved — check all extracted fields and correct any parsing errors (e.g., truncated descriptions or misread quantities) by editing inline
5. Click **Save** to store the order and open the detail view

> **Note:** PDF parsing is automatic but not perfect. Always review the extracted items before saving. Sizes or product codes near the quantity column may be misread — correct them in the review screen.

If an order with the same number was already imported you will be prompted to confirm before creating a duplicate record.

### Viewing and Editing Order Details

The detail view shows:
- **Metadata:** order number, category, type, AAC status, date, requestor, unit
- **Items table:** NSN, description, quantities, and IMS match status for each line:

| IMS Status | Meaning |
|------------|---------|
| In IMS | NSN exists — onHand will be incremented on receive |
| New | NSN not in IMS — a new item will be created on receive |
| No NSN | Item has no NSN and will be skipped on receive |

Click **Edit** on any saved order to return to the editable review screen and correct any fields.

### Approving and Receiving an Issue Order (OC / QM)

When an **Issue** order arrives from AAC QStore:

1. Open the order and click **Approve & Receive into IMS**
2. The modal shows matched items and new items separately
3. Select a category for any new items to be created
4. Add optional QM notes
5. Click **Confirm & Update IMS**

What happens on confirm:
- **Matched items** (In IMS): `onHand` incremented by the ordered quantity. If the item has a condition breakdown, the Serviceable count is also incremented.
- **New items**: Created with the NSN, description, and quantity from the order. Tagged with source `aac-order`.
- The order status changes to **Received**
- An audit entry is written: `order-received`

> **Warning:** Receiving an order into IMS cannot be reversed from the Orders page. If an error occurs, manually correct the affected items in Inventory.

### Exporting as CSV

Click **Export CSV** on any order detail. The download includes:
- Order metadata header (order number, category, type, date, requestor, unit)
- Item rows: NSN, Description, Qty Required, Qty Requisitioned, Qty Received, IMS Status

The filename format is `order-<number>-<date>.csv`.

### Deleting an Order Record

Click **Delete** on the order detail to remove the import record. This does **not** reverse any inventory changes already applied.

---

## 9. Audit Log

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
| user_add | User account created |
| user_update | User account edited |
| user_delete | User account deleted |
| pin_change | PIN set or reset by administrator |
| recovery_set | OC recovery code generated |
| recovery_reset | OC PIN reset using recovery code |
| login | Successful login |
| logout | User signed out |
| login_failed | Failed PIN attempt |
| session_unlock | Locked session resumed after PIN entry |
| data_export | Backup exported |
| data_imported | Backup imported |
| stocktake | Stocktake finalised |
| stocktake_writeoff | Written-off items flagged during stocktake |
| order-import | AAC QStore order PDF imported |
| order-received | Order approved and items received into IMS |
| order-delete | Order record deleted |

### Audit Chain

Each entry is cryptographically linked to the previous one. If any entry is altered or deleted, the chain breaks. Click **Verify chain** to run an integrity check — a broken chain indicates potential tampering.

---

## 10. Settings

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

### Categories

Manage the item categories available in the Inventory and stocktake pages. The default categories are:

- Uniform
- Equipment
- Safety
- Training Aids
- Field Stores
- Medical
- ICT

To customise: click each chip to remove a category, or type a new name in the text field and press **Enter** to add it. Click **Save categories** to apply. Click **Reset to defaults** to restore the original list.

> **Note:** Removing a category does not affect existing items — they retain their stored category name. Update affected items individually if needed.

### User Accounts

Add, edit, and manage user accounts. Each user has:
- Name and username
- Role (OC, QM, Staff, Cadet, Read-Only)
- Service number
- PIN (set and reset exclusively by the OC; users cannot change their own PINs)

See [Section 3 — Managing User Accounts](#3-user-roles-and-permissions) for full details.

### OC PIN Recovery

Generate a 12-character one-shot recovery code. Store this code **off-device** (printed, in a safe, or in a password manager). If the OC forgets their PIN, this code can reset it from the login screen.

- Click **Generate new code** to create a recovery code
- The code is shown once — copy it immediately
- Each code can only be used once; a new one must be generated after use

### Security

Configure the auto-lock idle timeout. This is the only control in this section.

| Setting | Options | Default |
|---------|---------|---------|
| Auto-lock after idle | Disabled / 5 / 10 / 15 / 30 min / 1 hour | 15 minutes |

When configured, the app locks automatically after the selected period without mouse, keyboard, or touch input. A PIN entry screen overlays the current page — work is not lost. The user enters their PIN to resume or clicks **Sign out / switch user** to log out fully.

Changes take effect immediately without a reload.

> **Tip:** Enable auto-lock on any device shared between users (duty computer, parade-night tablet) to prevent one user's session being accessed by another. 15 minutes is appropriate for most environments.

See [Section 13 — PIN Security](#13-pin-security) for full auto-lock behaviour.

### About

Displays version information, authorship, and the proprietary licence.

---

## 11. Cloud Sync (OneDrive)

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

## 12. Backup and Restore

Manual backup/restore is available in **Settings → Data backup & restore**. Use this to:
- Keep a local copy off-device
- Transfer data to a new device
- Restore after accidental data loss

### Exporting a Backup

1. Click **Export backup**
2. A JSON file is downloaded named `qstore-backup-<unitcode>-<date>.json`
3. Store this file in a safe location (not on the same device)

The backup includes all inventory, photos, loans, cadets, users, settings, supply orders, and the full audit chain.

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

## 13. PIN Security

Each user authenticates with a 4-digit PIN.

### PIN Rules

- Must be exactly 4 digits
- Stored using Argon2id hashing — the actual PIN is never stored after it is set

### PIN Management Policy

PINs are managed exclusively by the **OC (administrator)**. This is a deliberate security control:

- **No self-service:** Users cannot view or change their own PINs
- **OC sets initial PINs:** When a new user is created, the OC sets the PIN and gives it to the user verbally
- **Show-once display:** After any PIN is set or reset, it is displayed once in a confirmation screen for the OC to note down. It cannot be retrieved again — not even by the OC
- **Forgotten PIN:** If a user forgets their PIN, they must ask the OC to reset it via **Users → Reset PIN**

### Auto-Lock (Idle Timeout)

The OC can configure the app to lock automatically after inactivity. This is set in **Settings → Security → Auto-lock after idle**.

**How it works:**
- Any mouse, keyboard, or touch activity resets the idle timer
- When the timer expires, a lock overlay appears over the current page — the user does not lose their place
- Entering the correct PIN dismisses the overlay and resumes the session
- Clicking **Sign out / switch user** on the lock screen performs a full logout

**Lockout on the lock screen:** Failed PIN attempts follow the same escalating lockout as login — 5 wrong attempts triggers a 30-second delay, 10 triggers 5 minutes, 15+ triggers 30 minutes.

**Audit trail:** Successful unlocks are recorded as `session_unlock`. Failed attempts are recorded as `login_failed`, the same as login failures.

> **Recommendation:** Enable auto-lock on any shared or unattended device. 15 minutes is the default and suits most environments.

### PIN Lockout

Repeated failed attempts trigger automatic lockouts (applies to both login and lock screen unlock):

| Failed attempts | Lockout duration |
|----------------|-----------------|
| 5 | 30 seconds |
| 10 | 5 minutes |
| 15+ | 30 minutes |

Lockouts apply per user account. Other users are unaffected.

---

## 14. OC PIN Recovery

The OC account has an additional recovery mechanism that is not available to other roles. It is important to set this up before it is needed.

### Setting Up a Recovery Code (OC)

1. Navigate to **Settings → OC PIN recovery**
2. Click **Generate new code**
3. The 12-character recovery code is displayed once — write it down immediately
4. Store the code **off-device**: a printed copy in the unit safe, on a key cabinet, or in a secured off-device location
5. Treat it with the same care as the safe combination — anyone with this code can reset the OC PIN and gain full administrative access

> **Warning:** Recovery codes are single-use. After using a code to reset the OC PIN, generate a new one immediately. Without a recovery code, a lost OC PIN cannot be recovered.

### Using a Recovery Code

If the OC forgets their PIN:

1. On the login screen, select the OC account
2. Click **Forgot PIN?**
3. Enter the 12-character recovery code
4. Enter and confirm a new PIN
5. The recovery code is consumed — generate a new one immediately from Settings

### If the Recovery Code Is Also Lost

There is no bypass for a lost OC PIN without a recovery code. Options:
- Import a recent backup (data is restored, but the PIN issue remains — you will need to contact support)
- Contact admin@seanscales.com.au for assistance

---

## 15. Issue Kits

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

## 16. QR Codes

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

## 17. Troubleshooting

### App won't load / blank screen

- Ensure JavaScript is enabled in the browser
- Try a hard refresh: `Ctrl + Shift + R` (Windows) or `Cmd + Shift + R` (Mac)
- Check the browser console (F12 → Console) for error messages

### User forgot their PIN

Users cannot reset their own PINs. The OC must click **Reset PIN** on the **Users** page to set a new PIN, then give it to the user verbally.

### Forgot OC PIN — have recovery code

Follow the steps in [Section 14 — OC PIN Recovery](#14-oc-pin-recovery). The recovery code is single-use — generate a new one immediately after use.

### Forgot OC PIN — no recovery code

There is no bypass for a lost OC PIN without a recovery code. Options:
- Import a recent backup (data is restored but the PIN issue remains — contact support)
- Contact admin@seanscales.com.au for assistance

**Prevention:** Always generate and securely store a recovery code in Settings before it is needed.

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

### Orders — extracted items look wrong after PDF import

The PDF parser reads text positions to assign items to columns. Complex PDFs (e.g., multi-line descriptions, unusual fonts) may misread quantities or truncate descriptions. Use the **editable review screen** that appears before saving to correct any errors. If a size or code has been placed in the quantity field, zero it out and enter the correct quantity manually.

---

*QStore IMS v2.3.0 — © 2026 Sean Scales. All rights reserved.*  
*Proprietary software — redistribution and modification prohibited without written consent.*
