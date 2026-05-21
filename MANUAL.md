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
6. [Equipment Requests (Self-Service)](#6-equipment-requests-self-service)
7. [Cadets / Nominal Roll](#7-cadets--nominal-roll)
8. [Stocktake](#8-stocktake)
9. [AAC QStore Orders](#9-aac-qstore-orders)
10. [Audit Log](#10-audit-log)
11. [Settings](#11-settings)
12. [Cloud Sync (OneDrive)](#12-cloud-sync-onedrive)
13. [Backup and Restore](#13-backup-and-restore)
14. [PIN Security](#14-pin-security)
15. [Two-Factor Authentication (2FA)](#15-two-factor-authentication-2fa)
16. [OC PIN Recovery](#16-oc-pin-recovery)
17. [Issue Kits](#17-issue-kits)
18. [QR Codes](#18-qr-codes)
19. [Troubleshooting](#19-troubleshooting)
20. [Reference — Uniform Sizing](#20-reference--uniform-sizing)

---

## 1. Introduction

QStore IMS (Inventory Management System) is a self-contained browser-based application for managing Australian Army Cadet Q-Store operations. It runs entirely in the browser using local storage — no internet connection or server is required for day-to-day use.

**Key capabilities:**
- Inventory tracking with five-state condition breakdown, photo support, and QR codes
- Loan issue and return workflow with printable vouchers and overdue tracking
- **Cadet self-service equipment request workflow** (AB189-style) with QM approval
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

#### Backfilling pre-existing loans (migration)

If equipment was already on issue before QStore was installed, record those loans so accountability is maintained from day one.

**Items with no stock on hand (`On hand = 0`):** Issue normally — the system will record the loan against the inventory entry and increment *On Loan* even though no physical stock is present. The badge will show *"⚠ None on hand — will record as On Loan"*.

**Items where more units are out than `On hand` shows:** The system will not allow issuing past the recorded on-hand quantity. In this case, temporarily edit the item and set `On hand = 0`, record all the outstanding loans, then run a stocktake to set the correct physical count. The stocktake report will flag the discrepancy for reconciliation.

### Dashboard

After logging in, the **Dashboard** (home page) gives an at-a-glance overview of the Q-Store:

- **Setup checklist** — shown to the OC until unit details, items, and cadets are all configured. Click **Go →** next to any step to jump straight to that page. Dismiss once you're done.
- **Stat tiles** — total items, items on loan, overdue loans, and unserviceable items
- **Stocktake status** — date and readiness of the last stocktake
- **Quick actions** — shortcuts to Inventory, Loans, Cadets, Stocktake, Audit log, and Settings
- **Recent audit** — the five most recent audit log entries

The Dashboard is the first page shown after login. Click **Dashboard** in the navigation bar to return to it at any time.

> **Tip:** The **?** button in the top-right corner of the header opens this help guide at any time.

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
| Staff | Staff | Can view all pages and submit equipment requests. Cannot add/edit inventory or manage cadets. |
| Cadet | Cadet | Can view inventory, their own loans, and submit equipment requests. |
| Read-Only | RO | View-only access plus equipment request submission. No other actions. |

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
| Submit equipment requests | ✓ | ✓ | ✓ | ✓ | ✓ |
| Approve / deny requests | ✓ | ✓ | | | |
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

#### 2FA Status Column

The Users table includes a **2FA** column showing the current two-factor authentication status for each account:

| Badge | Meaning |
|-------|---------|
| **✓ On** (green) | 2FA is enabled; tooltip shows how many backup codes remain |
| **Off** (grey) | 2FA is not configured |
| **⚠ Off** (amber) | 2FA is not configured — this account has a privileged role (OC or QM) where 2FA is strongly recommended |

Users configure their own 2FA through **Settings → Two-factor authentication**. See [Section 15 — Two-Factor Authentication](#15-two-factor-authentication-2fa) for the full setup guide.

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
   - **Category** — Select from the unit's configured categories (see [Section 11 — Settings](#11-settings))
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
   - **Initial Issue** — see below for special behaviour
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

### Initial Issue

**Initial Issue** is a protected loan purpose for the permanent issue of uniform and equipment to a cadet for the duration of their enlistment.

- The **due date is automatically set to 6 years from today** (matching the standard cadet engagement period) and cannot be changed manually
- The **long-term loan toggle is disabled** for Initial Issue — a fixed return date is always set
- **Initial Issue cannot be deleted** from the loan purpose list in Settings — it is permanently available
- Initial Issue items are clearly marked in the borrower's loan history

> **Purpose:** Initial Issue covers items such as AMCU uniform, boots, beret, and personal equipment that remain with the cadet throughout their service.

### Using Issue Kits

If you have pre-defined kits (e.g., *Initial Issue — Male Cadet*):

1. On the Issue tab, click **⊞ Load kit**
2. Select the kit from the list
3. The item lines are pre-filled — adjust quantities as needed before issuing

See [Section 16 — Issue Kits](#16-issue-kits) for creating kits.

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

**Discharged borrowers:** When a cadet is marked inactive (discharged), all their active loans are immediately recalled — due dates are set to today and the loans are flagged with a **Discharged** badge in the All Loans table. These loans remain active until the QM physically processes the return. See [Section 7 — Cadets](#7-cadets--nominal-roll) for the discharge workflow.

### Printing Vouchers

A printable loan voucher (AB180-style) is available from any loan record.

---

## 6. Equipment Requests (Self-Service)

The **Requests** page allows cadets, staff, and all users to submit equipment requests (AB189-style) without requiring direct access to the Issue tab. QMs and the OC review, approve, and issue from the same page.

When pending requests are waiting for approval, a **badge showing the count** appears on the **Requests** navigation item (visible to QM and OC).

### For Cadets and Staff — Submitting a Request

1. Navigate to **Requests → New Request**
2. Complete the form:
   - **Purpose** — select from the standard list (Annual Camp, Training Activity, Parade Night, Field Exercise, Ceremonial, Course Attendance, Other)
   - **Required by** — date the equipment is needed (optional but helpful)
   - **Items** — add one line per item: enter a description, NSN (optional), and quantity. Click **+ Add item** to add more lines.
   - **Notes** — any additional information for the QM
3. Click **Submit Request**

A request reference (REQ-XXXX) is assigned automatically. The request appears in **My Requests** where you can track its status.

### Request Status Badges

| Status | Meaning |
|--------|---------|
| **Pending** | Submitted, awaiting QM review |
| **Approved** | QM has approved — issue will be processed separately |
| **Issued** | Approved and equipment has been issued; loan references listed |
| **Denied** | Request declined — reason shown on the request card |
| **Withdrawn** | You withdrew the request before it was actioned |

### Withdrawing a Request

While a request is **Pending**, click **Withdraw** on the request card in **My Requests** to cancel it. Approved, issued, or denied requests cannot be withdrawn.

### For QM and OC — Approving Requests

1. Navigate to **Requests → Pending**
2. Review each request card — it shows the requestor, purpose, required-by date, item lines, and any notes
3. Choose an action:
   - **Approve & Issue** — immediately creates loan records for each item and marks the request as Issued. The system auto-matches items to inventory by NSN then by description; unmatched lines are issued as non-stock loans.
   - **Approve (issue later)** — marks the request as Approved. The QM issues the items manually from the standard Loans → Issue tab at a later time.
   - **Deny** — prompts for a mandatory reason. The requestor can see the reason on their request card.

### Approve & Issue — Matching Logic

When a QM clicks **Approve & Issue**, the system attempts to link each request line to an inventory item:

1. **NSN match** — if the request line has an NSN, the system looks for an inventory item with the same NSN
2. **Name match** — if no NSN match is found, the system looks for an inventory item with a matching description (case-insensitive exact match)
3. **Non-stock loan** — if neither match is found, the item is issued as a non-stock loan (no inventory deduction)

The matching logic creates loan records automatically using the same rules as the standard Issue tab. The loan references are displayed on the request card after issue.

### Blank AB189 Form (Print and Fill Offline)

Click **⬇ Blank AB189 Form** on any tab to download a print-ready blank form. This is useful when:
- A cadet needs to submit a request in writing (e.g. at camp without device access)
- Brigade or CO requires a signed paper copy
- The QM wants a physical form to process offline before entering into the system

The blank form includes the unit name in the header (from Settings), all field labels, blank underlines for hand-written completion, and QM/OC signature blocks.

### Importing a Filled AB189 PDF

If a cadet has typed into (digitally filled) a blank AB189 PDF, the QM can import it to pre-populate a new request:

1. On the **Requests** page, click **⬆ Import AB189 PDF**
2. Select the filled PDF file
3. The system extracts text and attempts to pre-fill the request form — items, purpose, required-by date, and notes
4. Review all pre-filled fields and correct any parsing errors before submitting

> **Note:** PDF import works reliably for **digitally-filled** PDFs (text typed into the PDF on a computer). Scanned paper forms are not supported in v2.3 — items would need to be entered manually.

### Viewing All Requests (QM / OC)

The **All Requests** tab shows the complete request history with a status filter bar. Click any status chip to filter the list. All request cards show the requestor, date, purpose, status, and items. Loan references appear on Issued requests.

---

## 7. Cadets / Nominal Roll

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

### Cadet Discharge — Automatic Loan Recall

When a cadet is **deactivated** (Active unticked and saved), the system immediately:

1. Sets the **due date to today** on all of that cadet's active loans
2. Flags those loans as **Discharged** in the All Loans table (red badge and border)
3. Writes a `cadet_discharge` audit entry listing all recalled loan references
4. Shows a summary modal listing the outstanding items

> **Purpose:** This ensures outstanding equipment does not go untracked when a cadet leaves the unit. The loans remain active — the QM must physically process the return of each item through the normal return workflow once the equipment is recovered.

The Discharged badge remains visible in All Loans until each item is formally returned.

---

## 8. Stocktake

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

## 9. AAC QStore Orders

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

1. Download the PDF directly from the AAC QStore website — save it as a PDF file
2. Navigate to **Orders** and click **Import PDF Order**
3. Select the PDF — the system automatically extracts:
   - Order number and category (Uniform / Equipment / General)
   - Order status (Request or Issue)
   - Date, requestor name, rank, service number, and unit
   - All line items: NSN, description, qty required, qty requisitioned, qty received
4. **IMS matching happens automatically:** each item's NSN is checked against your inventory. Where a match is found, the description is replaced with your IMS item name so naming stays consistent. A summary banner shows how many items were matched.
5. An **editable review screen** opens before the order is saved — every field is editable inline. For each row the **IMS** column shows:

| IMS badge | Meaning |
|-----------|---------|
| ✓ IMS | NSN found in your inventory — description updated to match IMS name |
| New | NSN not in IMS — will be created as a new item if received |
| No NSN | No NSN on this line — cannot be matched or received automatically |

   Rows where the description was auto-replaced show the original PDF text below the input in small grey text so you can compare. Correct any errors by clicking and typing directly in any cell.

6. Click **Save Order** to store the order and open the detail view

> **PDF parsing tip:** The system reads the QTYREQ column specifically for quantity — clothing size codes (e.g. "SIZE 10R", "32L") are automatically excluded from the quantity field and kept in the description where they belong. If a quantity still looks wrong, simply type the correct value in the Qty Req cell before saving.

If an order with the same number was already imported, a warning badge appears on the review screen — you can still save if it is a legitimate re-import.

### Viewing and Editing Order Details

The detail view shows:
- **Metadata:** order number, category, type, AAC status, date, requestor, unit
- **Items table:** NSN, description, quantities, and IMS match status:

| IMS Status | Meaning |
|------------|---------|
| In IMS | NSN matched — onHand will increase on receive |
| In IMS ⚠ | NSN matched but description differs between the order and IMS |
| New | NSN not in IMS — a new item will be created on receive |
| No NSN | Item has no NSN and will be skipped on receive |

Click **Edit** on any saved order to return to the editable review screen and correct any fields.

### Approving and Receiving an Issue Order (OC / QM)

When an **Issue** order arrives from AAC QStore:

1. Open the order and click **Approve & Receive into IMS**
2. A confirmation screen shows all matched items and new items with their quantities
3. **Adjust quantities if needed** — the qty inputs default to the received quantity from the order. Change any value if the actual delivery differed. **Set a qty to 0 to skip that item** (useful if a line was back-ordered or short-shipped)
4. Select a category for any brand-new items that will be created
5. Add optional QM notes, then click **Confirm & Update IMS**

What happens on confirm:
- **Matched items** (In IMS): `onHand` incremented by the entered quantity. Serviceable count also updated if the item uses condition breakdown.
- **New items**: Created with the NSN, description, and entered quantity. Tagged as source `aac-order`.
- The order status changes to **Received**
- An audit entry is written: `order-received`

> **Warning:** Receiving an order into IMS cannot be reversed from the Orders page. If an error is made, correct the affected items manually in Inventory and note the reason in the Audit log.

### Exporting as CSV

Click **Export CSV** on any order detail. The download includes:
- Order metadata header (order number, category, type, date, requestor, unit)
- Item rows: NSN, Description, Qty Required, Qty Requisitioned, Qty Received, IMS Status

The filename format is `order-<number>-<date>.csv`.

### Deleting an Order Record

Click **Delete** on the order detail to remove the import record. This does **not** reverse any inventory changes already applied.

---

## 10. Audit Log

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
| cadet_discharge | Cadet deactivated — active loans recalled automatically |
| request_submitted | Equipment request submitted by a cadet/staff member |
| request_approved | Request approved (issue pending or auto-issued) |
| request_denied | Request denied; reason recorded |
| request_withdrawn | Request withdrawn by the requestor |
| user_add | User account created |
| user_update | User account edited |
| user_delete | User account deleted |
| pin_change | PIN set or reset by administrator |
| recovery_set | OC recovery code generated |
| recovery_reset | OC PIN reset using recovery code |
| 2fa_enabled | Two-factor authentication enabled for an account |
| 2fa_disabled | Two-factor authentication disabled for an account |
| 2fa_backup_used | Backup code used to complete 2FA login |
| 2fa_backup_regen | 2FA backup codes regenerated |
| cadet_viewed | Cadet equipment profile opened (PII access recorded) |
| staff_viewed | Staff record opened for editing (PII access recorded) |
| login | Successful login |
| logout | User signed out |
| login_failed | Failed PIN attempt |
| session_unlock | Locked session resumed after PIN entry |
| data_export | Backup exported (plain or encrypted) |
| data_imported | Backup imported |
| stocktake | Stocktake finalised |
| stocktake_writeoff | Written-off items flagged during stocktake |
| order-import | AAC QStore order PDF imported |
| order-received | Order approved and items received into IMS |
| order-delete | Order record deleted |

### Audit Chain

Each entry is cryptographically linked to the previous one. If any entry is altered or deleted, the chain breaks. Click **Verify chain** to run an integrity check — a broken chain indicates potential tampering.

---

## 11. Settings

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

To customise:

- **Drag** the ⠿ handle to reorder categories
- Click **↑** / **↓** to move a category up or down. Hold **Shift** while clicking to jump the item to the top or bottom
- Type a new name in the text field and press **Enter** (or click **Add**) to add it
- Click **✕** on a chip to remove a category

Click **Save categories** to apply. Click **Reset to defaults** to restore the original list.

> **Notes:**
> - **Initial Issue** is a protected loan purpose and cannot be removed from the category list, regardless of what is shown here. It is always available on the Loans issue form.
> - Removing a category does not affect existing items — they retain their stored category name. Update affected items individually if needed.

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

See [Section 15 — OC PIN Recovery](#15-oc-pin-recovery) for full details.

### Security

Configure the auto-lock idle timeout.

| Setting | Options | Default |
|---------|---------|---------|
| Auto-lock after idle | Disabled / 5 / 10 / 15 / 30 min / 1 hour | 15 minutes |

When configured, the app locks automatically after the selected period without mouse, keyboard, or touch input. A PIN entry screen overlays the current page — work is not lost. The user enters their PIN to resume or clicks **Sign out / switch user** to log out fully.

Changes take effect immediately without a reload.

> **Tip:** Enable auto-lock on any device shared between users (duty computer, parade-night tablet) to prevent one user's session being accessed by another. 15 minutes is appropriate for most environments.

See [Section 14 — PIN Security](#14-pin-security) for full auto-lock behaviour.

### About

Displays version information, authorship, and the proprietary licence.

---

## 12. Cloud Sync (OneDrive)

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

## 13. Backup and Restore

Manual backup/restore is available in **Settings → Data backup & restore**. Use this to:
- Keep a local copy off-device
- Transfer data to a new device
- Restore after accidental data loss

> **Data sensitivity:** Backup files contain names, service numbers, and equipment records. Store them as you would any personnel document — not in shared drives or unprotected email attachments.

### Exporting a Backup

1. Click **Export backup**
2. An **Export backup** dialog appears — choose whether to password-protect the file:
   - **Without a password:** a plain `.json` file is downloaded (`qstore-backup-<unitcode>-<date>.json`)
   - **With a password:** enter a password, confirm it, and click **Export backup** — an encrypted `.qstore` file is downloaded
3. Store the file in a safe location off-device

The backup includes all inventory, photos, loans, cadets, users, settings, supply orders, and the full audit chain.

#### Encrypted backups (.qstore files)

Encrypted backups use **AES-256-GCM** with a key derived via **PBKDF2 (310,000 iterations, SHA-256)**. The file is unreadable without the correct password. Use this when:
- Storing a backup in a shared or cloud location (email, OneDrive, USB drive)
- Handing a backup to another person for safe-keeping
- Complying with unit data-handling requirements for personnel files

> **Keep the password safe.** There is no password recovery — a forgotten password means the encrypted backup cannot be restored.

### Importing a Backup

1. Click **Import backup**
2. Type **OVERWRITE** to confirm — this replaces all current data
3. Select the previously exported `.json` or `.qstore` file
4. If the file is encrypted, enter the password when prompted
5. The page reloads — the audit chain is preserved and extended with an import entry

### CSV Import

Inventory items can be bulk-imported from a spreadsheet:

1. Click **Import CSV**
2. Download the template if needed
3. Map your columns to the required fields
4. Preview and confirm the import

---

## 14. PIN Security

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

## 15. Two-Factor Authentication (2FA)

Two-factor authentication (2FA) adds a second sign-in step after the PIN. Once enabled, signing in requires:

1. Your **PIN** — something you know
2. A **6-digit code** from an authenticator app — something you have

2FA works fully **offline** — no internet connection is required. It is compatible with Google Authenticator, Microsoft Authenticator, Authy, 1Password, Bitwarden, and any RFC 6238-compliant app.

> **Recommendation:** OC and QM accounts should have 2FA enabled. These accounts have full write access to all data including user management and exports.

### Setting Up 2FA (per user)

Each user sets up 2FA on their own account. OCs can see the 2FA status of all accounts on the Users page.

1. Log in, then go to **Settings → Two-factor authentication**
2. Click **Set up two-factor authentication**
3. **Step 1 — Add account to your authenticator app:**
   - Open your authenticator app and choose *Enter a setup key* or *Manual entry*
   - Enter the **secret key** shown on screen (or click **Copy** to copy it)
   - Set the account name to your QStore username
4. **Step 2 — Verify:**
   - Enter the 6-digit code currently shown in your authenticator app
   - Click **Verify code** — this confirms the app is working correctly
5. **Step 3 — Save backup codes:**
   - Eight single-use backup codes are generated
   - **Save them immediately** — print them or store them in a password manager
   - Tick the confirmation checkbox, then click **Enable two-factor authentication**

2FA is now active on your account. The next login will ask for a 6-digit code after the PIN.

### Signing In With 2FA

1. Select your name on the login screen
2. Enter your 4-digit PIN
3. Open your authenticator app and enter the **6-digit code** shown for QStore IMS
4. The code auto-submits when 6 digits are entered

If the code is rejected, check that your device clock is accurate — TOTP codes are time-sensitive.

### Backup Codes

Backup codes are used when you cannot access your authenticator app (e.g. lost phone). Each code is **single-use** — it is consumed immediately on successful login.

**Using a backup code:**
1. On the TOTP code screen, click **Use a backup code instead**
2. Enter the 8-character backup code (letters and digits)
3. The code is consumed; check how many codes remain in Settings

**Managing backup codes:**

| Action | Location |
|--------|----------|
| View remaining count | Settings → Two-factor authentication |
| Regenerate all codes | Settings → Two-factor authentication → Manage 2FA → Regenerate backup codes |

> **Warning:** If you run out of backup codes and lose your authenticator app, you cannot log in. Regenerate backup codes before they run out.

### Disabling 2FA

1. Go to **Settings → Two-factor authentication → Manage 2FA**
2. Click **Disable two-factor authentication**
3. Confirm — the TOTP secret and backup codes are removed from your account

### 2FA Audit Entries

| Action | Meaning |
|--------|---------|
| `2fa_enabled` | 2FA successfully enrolled for an account |
| `2fa_disabled` | 2FA removed from an account |
| `2fa_backup_used` | A backup code was used to log in (with remaining count) |
| `2fa_backup_regen` | Backup codes regenerated |

---

## 16. OC PIN Recovery

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

## 17. Issue Kits

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
- If a kit item has no stock on hand, it is still added to the issue list and will be recorded as *On Loan* against the inventory entry — a warning toast lists the affected items
- Kits are templates only — they do not affect stock until the loan is issued
- Renaming an inventory item is reflected in all kits automatically

---

## 18. QR Codes

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

## 19. Troubleshooting

### App won't load / blank screen

- Ensure JavaScript is enabled in the browser
- Try a hard refresh: `Ctrl + Shift + R` (Windows) or `Cmd + Shift + R` (Mac)
- Check the browser console (F12 → Console) for error messages

### User forgot their PIN

Users cannot reset their own PINs. The OC must click **Reset PIN** on the **Users** page to set a new PIN, then give it to the user verbally.

### Forgot OC PIN — have recovery code

Follow the steps in [Section 15 — OC PIN Recovery](#15-oc-pin-recovery). The recovery code is single-use — generate a new one immediately after use.

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

The PDF parser reads the QTYREQ column specifically for quantity values and rejects clothing size codes (e.g. "10R", "SIZE 10") from the quantity field automatically. If a quantity still looks wrong:

1. In the editable review screen, click directly on the Qty Req cell for that row and type the correct number
2. If the description is incorrect, click the Description cell and type the right text
3. If the NSN is missing dashes or contains a zero/O confusion, correct it — the IMS match will update the IMS status badge as you type

If the import produced **no items at all**, make sure the PDF was downloaded directly from the AAC QStore website (not printed to PDF from a browser, which strips the table structure). Try the download again and re-import.

For password-protected PDFs, remove the password in a PDF reader before importing.

### Equipment request submitted but not showing in Pending

Ensure the user who submitted the request has the correct service number set on their user account. If the user account has no service number, the request still submits correctly — but the QM sees it in Pending immediately regardless.

### Approve & Issue partially issued some items

If the automatic issue failed for some lines, the request is marked **Approved** (not Issued) and the error is noted on the request card. The QM can issue the remaining items manually from **Loans → Issue** and reference the request number in remarks.

---

## 20. Reference — Uniform Sizing

The **Reference** page is accessible from the main navigation bar and is available to all logged-in users. It provides ADF uniform and equipment sizing tables with conversions between AU/NATO (centimetres), US (inches/US sizes), and generalised sizes (XS–3XL), together with measurement guides for each garment type.

### Shirts and Jackets

ADF shirts and field jackets use NATO sizing in the format **CHEST(cm) / HEIGHT-BAND**, for example `102/R`.

**Height bands (torso code):**
- **S** (Short) — height under 170 cm
- **R** (Regular) — height 170–183 cm
- **L** (Long/Tall) — height over 183 cm

**How to measure — chest:** Wrap the tape around the fullest part of the chest, under the armpits and across the shoulder blades. Keep the tape horizontal and snug but not tight. Record in centimetres.

| Chest (cm) | Gen. size | US chest | NATO codes |
|---|---|---|---|
| 87  | XS  | 34" | 87/S • 87/R • 87/L |
| 92  | S   | 36" | 92/S • 92/R • 92/L |
| 97  | M   | 38" | 97/S • 97/R • 97/L |
| 102 | L   | 40" | 102/S • 102/R • 102/L |
| 107 | XL  | 42" | 107/S • 107/R • 107/L |
| 112 | 2XL | 44" | 112/S • 112/R • 112/L |
| 117 | 3XL | 46" | 117/S • 117/R • 117/L |

> If between sizes, select the larger size. For layering (e.g. body armour carrier), go one size up.

### Trousers

ADF trousers use NATO sizing in the format **WAIST(cm) / LEG-BAND**, for example `90/R`.

**Leg length bands (inseam code):**
- **S** (Short) — inside leg ≤ 76 cm
- **R** (Regular) — inside leg 77–84 cm
- **L** (Long) — inside leg ≥ 85 cm

**How to measure — waist:** Around the natural waist, approximately 2.5 cm above the navel, tape horizontal and flat against the skin.

**How to measure — inside leg:** From the crotch seam down the inner leg to the ankle bone, standing straight in bare feet on a hard floor.

| Waist (cm) | Gen. size | US waist |
|---|---|---|
| 75  | XS  | 29" |
| 80  | S   | 31" |
| 85  | M   | 33" |
| 90  | L   | 35" |
| 95  | XL  | 37" |
| 100 | 2XL | 39" |
| 105 | 3XL | 41" |
| 110 | 4XL | 43" |

### Boots

AU/UK boot sizes use the same scale.

**How to measure — foot length:** Place foot flat on a sheet of paper. Mark the longest toe and the back of the heel. Measure the distance in centimetres. Measure both feet and use the larger measurement.

> Add half a size when wearing thick military socks. Boots should feel snug with the issued sock, not bare foot.

| AU / UK | US Men's | US Women's | Foot (cm) |
|---|---|---|---|
| 5   | 6   | 7.5  | 23.5 |
| 6   | 7   | 8.5  | 24.5 |
| 7   | 8   | 9.5  | 25.5 |
| 8   | 9   | 10.5 | 26.5 |
| 9   | 10  | 11.5 | 27.5 |
| 10  | 11  | 12.5 | 28.5 |
| 11  | 12  | 13.5 | 29.5 |
| 12  | 13  | 14.5 | 30.5 |

*Half sizes are listed in the app's Reference page. Where a half size is unavailable, round up.*

### Hats and Berets

**How to measure — head circumference:** Wrap the tape around the head approximately 2 cm above the eyebrows and across the widest part at the back of the skull. Keep the tape level all the way around. Record in centimetres. Round up if between sizes.

| Head circ. (cm) | Head circ. (in) | Gen. size | UK / US hat size |
|---|---|---|---|
| 54 | 21¼" | XS  | 6¾ |
| 56 | 22"  | S   | 7  |
| 57 | 22½" | S   | 7⅛ |
| 58 | 22⅞" | M   | 7¼ |
| 59 | 23¼" | M   | 7⅜ |
| 60 | 23⅝" | L   | 7½ |
| 61 | 24"  | L   | 7⅝ |
| 62 | 24⅜" | XL  | 7¾ |
| 64 | 25¼" | 2XL | 8  |

*Full table including all intermediate sizes is available in the app's Reference page.*

---

*QStore IMS v2.3.0 — © 2026 Sean Scales. All rights reserved.*  
*Proprietary software — redistribution and modification prohibited without written consent.*
