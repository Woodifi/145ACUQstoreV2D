// =============================================================================
// QStore IMS v2 — Help page
// =============================================================================
// Quick-reference guide accessible to all logged-in users. Organised into
// collapsible sections so users can find answers without scrolling the whole
// document. Each section mirrors the matching chapter in MANUAL.md.
// =============================================================================

import { render, $ } from './util.js';

let _root = null;

export async function mount(rootEl) {
  _root = rootEl;
  _render();
  return function unmount() { _root = null; };
}

// -----------------------------------------------------------------------------
// Sections
// -----------------------------------------------------------------------------

const SECTIONS = [
  {
    id: 'getting-started',
    title: 'Getting started',
    icon: '🚀',
    body: `
      <h4>Launch splash screen</h4>
      <p>When the app loads a full-screen splash shows the unit logo and counts down from 5. It proceeds automatically — no action needed.</p>

      <h4>First login</h4>
      <p>Select <strong>Administrator</strong> from the user list and enter PIN <code>0000</code>.
      You will be prompted to change this immediately — do so before continuing.</p>

      <h4>Initial setup</h4>
      <p>After first login, the Dashboard shows a <strong>setup checklist</strong> with three steps: set unit details, add your first inventory item, and add cadets.
      Click <strong>Go →</strong> on any step to jump straight there. The checklist disappears once all three steps are complete, or when you dismiss it.</p>
      <ol>
        <li>Go to <strong>Settings → Unit details</strong> (the section is highlighted with a "⬅ Start here" badge until you save a unit name)</li>
        <li>Enter your unit name, unit code, state, OC/QM name, and rank</li>
        <li>Upload a unit logo (optional)</li>
        <li>Click <strong>Save unit details</strong></li>
      </ol>

      <h4>Adding users</h4>
      <ol>
        <li>Go to the <strong>Users</strong> page (OC only, visible in the navigation bar)</li>
        <li>Click <strong>+ Add User</strong> and fill in name, username, role, service number, and initial PIN</li>
        <li>After saving, the PIN is displayed <strong>once</strong> — note it down immediately and give it to the user verbally</li>
        <li>Only the OC can manage PINs. Users cannot change their own PIN — if a user forgets their PIN they must ask the OC to reset it via the <strong>Reset PIN</strong> button on the Users page</li>
      </ol>
    `,
  },
  {
    id: 'roles',
    title: 'User roles and permissions',
    icon: '👤',
    body: `
      <table class="help__table">
        <thead><tr><th>Role</th><th>What they can do</th></tr></thead>
        <tbody>
          <tr><td><strong>OC</strong></td><td>Full access including Settings, Users, approvals, and PIN management. Assign to the Commanding Officer only.</td></tr>
          <tr><td><strong>QM</strong></td><td>Full operational access — inventory, loans, cadets, stocktake, orders, audit, equipment request approval. Cannot access Settings.</td></tr>
          <tr><td><strong>Staff</strong></td><td>View all pages and submit equipment requests. Cannot add/edit inventory or manage cadets.</td></tr>
          <tr><td><strong>Cadet</strong></td><td>View inventory, view their own loans, and submit equipment requests.</td></tr>
          <tr><td><strong>Read-Only</strong></td><td>View-only. No actions.</td></tr>
        </tbody>
      </table>
      <table class="help__table" style="margin-top:0.5rem">
        <thead><tr><th>Action</th><th>OC</th><th>QM</th><th>Staff</th><th>Cadet</th><th>RO</th></tr></thead>
        <tbody>
          <tr><td>View inventory / cadets / loans</td><td>✓</td><td>✓</td><td>✓</td><td>✓</td><td>✓</td></tr>
          <tr><td>Submit equipment requests</td><td>✓</td><td>✓</td><td>✓</td><td>✓</td><td>—</td></tr>
          <tr><td>Issue / return loans</td><td>✓</td><td>✓</td><td>—</td><td>—</td><td>—</td></tr>
          <tr><td>Approve / deny requests</td><td>✓</td><td>✓</td><td>—</td><td>—</td><td>—</td></tr>
          <tr><td>Edit inventory / cadets</td><td>✓</td><td>✓</td><td>—</td><td>—</td><td>—</td></tr>
          <tr><td>Stocktake / Orders</td><td>✓</td><td>✓</td><td>—</td><td>—</td><td>—</td></tr>
          <tr><td>Audit log</td><td>✓</td><td>✓</td><td>—</td><td>—</td><td>—</td></tr>
          <tr><td>Settings / Users</td><td>✓</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>
        </tbody>
      </table>
      <p class="help__note">Only the OC can access the <strong>Users</strong> and <strong>Settings</strong> pages. Only OC and QM can issue/return loans, approve requests, edit inventory, or run stocktakes.</p>
    `,
  },
  {
    id: 'users',
    title: 'User accounts',
    icon: '👥',
    body: `
      <p>The <strong>Users</strong> page (OC only) is where you create and manage login accounts for everyone who uses the app.</p>

      <h4>Adding a user <span class="help__role">OC only</span></h4>
      <ol>
        <li>Click <strong>+ Add User</strong></li>
        <li>Enter full name, username, role, and service number (optional)</li>
        <li>Enter an initial PIN (4 digits, entered twice — PIN is visible while typing)</li>
        <li>Click <strong>Add User</strong></li>
        <li>The PIN is displayed <strong>once</strong> in a confirmation screen — note it down and give it to the user verbally before clicking Done</li>
      </ol>

      <h4>Editing a user <span class="help__role">OC only</span></h4>
      <p>Click <strong>Edit</strong> to update name, username, role, or service number. To reset a PIN use <strong>Reset PIN</strong> separately.</p>

      <h4>Resetting a PIN <span class="help__role">OC only</span></h4>
      <p>Click <strong>Reset PIN</strong> on any row and enter a new 4-digit PIN. After saving, the new PIN is displayed <strong>once</strong> — note it down and give it to the user verbally. The user must use this PIN on their next login.</p>
      <p class="help__note">Only the OC can set or reset PINs. Users cannot change their own PINs. If a user forgets their PIN, they must ask the OC to reset it.</p>

      <h4>Deleting a user <span class="help__role">OC only</span></h4>
      <p>Click <strong>Delete</strong> and confirm. Restrictions:</p>
      <ul>
        <li>Cannot delete your own account</li>
        <li>Cannot delete the last OC account — assign another OC first</li>
        <li>Deletion removes login access only; all loan history and audit entries are preserved</li>
      </ul>
    `,
  },
  {
    id: 'inventory',
    title: 'Inventory',
    icon: '📦',
    body: `
      <h4>Viewing and searching</h4>
      <p>Type in the search box to filter by NSN, name, or category. Use the category dropdown to narrow further. Results update as you type.</p>
      <p>The <strong>Condition</strong> column shows a coloured badge for each item's overall status. When an item has mixed conditions, a breakdown line appears below the badge — for example: <em>3 Svc · 1 U/S · 1 Repr</em>.</p>

      <h4>Condition breakdown</h4>
      <p>Every item tracks the full five-state condition breakdown — the same states used in Stocktake:</p>
      <table class="help__table">
        <thead><tr><th>Field</th><th>Meaning</th></tr></thead>
        <tbody>
          <tr><td><strong>Svc</strong></td><td>Serviceable — ready for issue</td></tr>
          <tr><td><strong>U/S</strong></td><td>Unserviceable — damaged or non-functional</td></tr>
          <tr><td><strong>Repr</strong></td><td>In repair — temporarily unavailable</td></tr>
          <tr><td><strong>Cal</strong></td><td>Calibration due — must be calibrated before issue</td></tr>
          <tr><td><strong>W/O</strong></td><td>Written off — beyond repair, pending Board of Survey</td></tr>
        </tbody>
      </table>
      <p>The overall <strong>Condition badge</strong> and <strong>Unsvc</strong> count are derived automatically from these five fields — no separate dropdown needed.</p>

      <h4>Adding an item <span class="help__role">OC / QM</span></h4>
      <ol>
        <li>Click <strong>+ Add item</strong></li>
        <li>Enter NSN (4-2-3-4 format, e.g. <code>8470-66-001-0001</code>), name, category, authorised and on-hand quantities</li>
        <li>Fill in the <strong>Condition breakdown</strong> — the five qty fields must total the On-hand count. The running total indicator turns green when they match.</li>
        <li>Enter a location and click <strong>Save item</strong></li>
      </ol>
      <p class="help__note">Changing <strong>On hand</strong> automatically adjusts the <strong>Svc</strong> field to keep the total consistent. Fine-tune the other fields as needed.</p>

      <h4>Editing an item <span class="help__role">OC / QM</span></h4>
      <p>Click <strong>Edit</strong> on any row. The condition breakdown fields are pre-filled from current data. All changes are recorded in the audit log.</p>

      <h4>Loan history</h4>
      <p>Click <strong>History</strong> on any row to see the full loan history for that item — borrower, dates, quantity, and return status.</p>

      <h4>Deleting an item <span class="help__role">OC only</span></h4>
      <p>Click <strong>Delete</strong> and provide a reason. Deletion is permanent.</p>

      <h4>Item photos</h4>
      <p>Click the camera icon on any row to upload a photo (JPEG, PNG, or WebP).</p>

      <h4>Print stock report</h4>
      <p>Click <strong>⎙ Print stock</strong> to generate a PDF of currently-visible items. The report includes a <strong>Condition</strong> column showing the full breakdown — for example <em>5S/2U/1R</em> means 5 Serviceable, 2 Unserviceable, 1 In Repair. Rows with more than half the stock not ready for issue are highlighted in red.</p>

      <h4>QR code labels</h4>
      <p>Click <strong>⎙ QR codes</strong> to generate printable labels. Use <strong>⌖ Scan</strong> to look up an item by scanning its label.</p>
    `,
  },
  {
    id: 'loans',
    title: 'Loans — issue and return',
    icon: '🔄',
    body: `
      <h4>Issuing equipment <span class="help__role">OC / QM</span></h4>
      <ol>
        <li>Go to <strong>Loans → Issue</strong> tab</li>
        <li>Select the borrower, purpose, issue date, and due date</li>
        <li>Add item lines (search by name or NSN, set quantity)</li>
        <li>Click <strong>Issue</strong></li>
      </ol>
      <p>A loan reference (LN-XXXX) is assigned automatically.</p>

      <h4>Initial Issue</h4>
      <p>The <strong>Initial Issue</strong> purpose creates a long-term personal issue record. The due date is automatically set to six years from today and is locked — it cannot be changed. Initial Issue loans are never flagged as overdue regardless of age.</p>
      <p class="help__note">Initial Issue is a protected purpose and cannot be deleted from Settings categories. It is not available in the self-service Requests form — the QM must create it directly.</p>

      <h4>Long-term loans</h4>
      <p>Tick <strong>Long-term loan</strong> on the issue form (step 3 of the kit picker) to mark a loan as indefinite. Long-term loans do not require a due date and are never flagged as overdue.</p>

      <h4>Using an issue kit</h4>
      <p>Click <strong>⊞ Load kit</strong> on the Issue tab to pre-fill items from a saved kit. Adjust quantities before issuing. Out-of-stock items are shown with a red "nil stock" badge — they can still be added as non-stock lines if needed.</p>

      <h4>Non-stock and unit/activity loans</h4>
      <p>On the issue form you can add lines for items not yet in inventory (non-stock) or issue to a unit/activity rather than an individual (unit loan). When a non-stock item is returned, you are prompted to add it to inventory.</p>

      <h4>Returning equipment <span class="help__role">OC / QM</span></h4>
      <ol>
        <li>Go to <strong>Loans → Return</strong> tab</li>
        <li>Find the loan and click <strong>Return</strong></li>
        <li>Set return condition for each item (Serviceable / Unserviceable / Write-off)</li>
        <li>Click <strong>Confirm return</strong></li>
      </ol>

      <h4>Loan purposes</h4>
      <p>Initial Issue · Annual Camp · Training Activity · Parade Night · Field Exercise · Ceremonial · Course Attendance · Other</p>

      <h4>All Loans tab</h4>
      <p>Filter by Active, Returned, Overdue, or All. Search by borrower name or loan reference. Use the <strong>Borrower</strong> picker to show only loans for a specific person — pill counts update to reflect that borrower's loans.</p>
      <p>Loans belonging to a discharged cadet are flagged with a red <strong>Discharged</strong> badge. These are automatically recalled (due date set to discharge date) when a cadet is deactivated.</p>
    `,
  },
  {
    id: 'requests',
    title: 'Equipment requests',
    icon: '📋',
    body: `
      <p>The <strong>Requests</strong> page lets cadets and staff submit equipment requests that QMs and OCs can then approve, issue, or deny — all within the IMS.</p>

      <h4>Submitting a request (all roles except Read-Only)</h4>
      <ol>
        <li>Go to <strong>Requests → Submit Request</strong></li>
        <li>Enter the purpose, required-by date, and optional notes</li>
        <li>Add item lines — description, NSN (optional), and quantity</li>
        <li>Click <strong>Submit Request</strong></li>
      </ol>
      <p>The request is assigned a reference number (REQ-NNNN) and appears in the QM's pending queue immediately.</p>
      <p>You can also <strong>import a pre-filled AB189 PDF</strong>: click <strong>Import AB189 PDF</strong> to extract the purpose, required-by date, and item lines from a scanned or digital AB189 form. Review and edit before submitting.</p>

      <h4>Request statuses</h4>
      <table class="help__table">
        <thead><tr><th>Status</th><th>Meaning</th></tr></thead>
        <tbody>
          <tr><td><span style="color:#b45309">Pending</span></td><td>Awaiting QM/OC review</td></tr>
          <tr><td><span style="color:#1d4ed8">Approved</span></td><td>Approved but items not yet physically issued</td></tr>
          <tr><td><span style="color:#166534">Issued</span></td><td>Items issued and loan record(s) created</td></tr>
          <tr><td><span style="color:#991b1b">Denied</span></td><td>Request rejected (denial reason shown)</td></tr>
          <tr><td>Withdrawn</td><td>Withdrawn by the requestor before a decision</td></tr>
        </tbody>
      </table>

      <h4>Withdrawing a request</h4>
      <p>Open your request from <strong>My Requests</strong> and click <strong>Withdraw</strong>. Only pending requests can be withdrawn.</p>

      <h4>QM / OC — reviewing requests <span class="help__role">OC / QM</span></h4>
      <p>The <strong>Pending</strong> tab shows all requests awaiting a decision. A nav badge shows the count of pending requests. From the detail view:</p>
      <ul>
        <li><strong>Approve &amp; Issue</strong> — creates loan records immediately. Each line is matched to inventory by NSN, then by name; unmatched lines become non-stock loan lines. Loan references are stored on the request.</li>
        <li><strong>Approve</strong> — marks the request approved without creating loans (use when items will be issued later at the counter).</li>
        <li><strong>Deny</strong> — enter a denial reason; the requestor sees this on their My Requests tab.</li>
      </ul>

      <h4>Blank AB189 PDF</h4>
      <p>Click <strong>⎙ Blank AB189</strong> to download a print-ready blank AB189 Equipment Request form. The form includes your unit details and approval blocks — cadets fill it in by hand and hand it to the QM, who can then scan/import it.</p>

      <h4>All Requests tab <span class="help__role">OC / QM</span></h4>
      <p>Shows all requests regardless of status. Use the status filter to narrow the list.</p>
    `,
  },
  {
    id: 'kits',
    title: 'Issue kits',
    icon: '⊞',
    body: `
      <p>Issue kits are saved item bundles that pre-fill the loan issue form — useful for Initial Issue or camp packing lists.</p>

      <h4>Creating a kit <span class="help__role">OC / QM</span></h4>
      <ol>
        <li>Go to <strong>Inventory</strong></li>
        <li>Click <strong>⊞ Kits</strong></li>
        <li>Click <strong>+ New kit</strong>, name it, add item lines, and click <strong>Create kit</strong></li>
      </ol>
      <p class="help__note">The kit form stays open if you click outside it — your data is not lost. When the item list gets long it becomes scrollable and new lines auto-scroll into view. Clicking <strong>Cancel</strong> will ask you to confirm before discarding changes.</p>

      <h4>Using a kit</h4>
      <ol>
        <li>On the <strong>Loans → Issue</strong> tab, click <strong>⊞ Load kit</strong></li>
        <li>Select the kit — lines pre-fill automatically</li>
        <li>Adjust quantities as needed</li>
      </ol>
      <p class="help__note">Items with zero available stock are skipped with a warning. Kit quantities are capped at available stock.</p>
    `,
  },
  {
    id: 'cadets',
    title: 'Cadets / nominal roll',
    icon: '🪖',
    body: `
      <h4>Viewing the roll</h4>
      <p>All logged-in users can view the nominal roll. Search by name or service number. Filter by Company, Platoon, and Section (or by platoon if unit sub-structure is not configured). Tick <strong>Show inactive</strong> to see deactivated records.</p>
      <p><strong>Sort order:</strong> Staff always appear first, then cadets grouped by Company → Platoon → Section (config order), then rank high-to-low, surname A–Z within each group.</p>
      <table class="help__table">
        <thead><tr><th>Group</th><th>Rank order (high → low)</th></tr></thead>
        <tbody>
          <tr><td>Staff</td><td>COL-AAC · LTCOL-AAC · MAJ-AAC · CAPT-AAC · LT-AAC · 2LT-AAC · DAH</td></tr>
          <tr><td>Cadets</td><td>UO · WO1 · WO2 · SSGT · SGT · CPL · LCPL · CDT</td></tr>
        </tbody>
      </table>

      <h4>Unit sub-structure (Company / Platoon / Section)</h4>
      <p>Configure your unit's hierarchy in <strong>Settings → Unit sub-structure</strong>. Once set, the cadet add/edit form shows cascading Company → Platoon → Section dropdowns. The table gains group-band headers between sections, and filter controls cascade. The nominal roll PDF also renders with group bands.</p>
      <p>Existing records with only a free-text platoon continue to display correctly in legacy mode until re-saved with the new dropdowns.</p>

      <h4>Adding a person <span class="help__role">OC / QM</span></h4>
      <ol>
        <li>Click <strong>+ Add cadet/staff</strong></li>
        <li>Enter service number, surname, given names, rank</li>
        <li>Select Company → Platoon → Section (if structure configured) or enter Platoon (if not)</li>
        <li>Person type (cadet or staff) is set automatically from the rank</li>
        <li>Click <strong>Save</strong></li>
      </ol>

      <h4>Deactivating a person (discharge)</h4>
      <p>Click <strong>Edit</strong> and untick <strong>Active</strong>, then click <strong>Save</strong>.</p>
      <p><strong>Automatic loan recall:</strong> If the cadet has any active loans at the time of deactivation, a discharge modal lists all outstanding items. All active loans are automatically recalled — their due date is set to today and they are flagged as <strong>Discharged</strong> in the All Loans list with a red badge and border. The QM should retrieve these items.</p>
      <p class="help__note">Deactivated records and all loan history are retained indefinitely. Tick <strong>Show inactive</strong> on the Cadets page to view them.</p>
    `,
  },
  {
    id: 'stocktake',
    title: 'Stocktake',
    icon: '🔢',
    body: `
      <h4>Running a stocktake <span class="help__role">OC / QM</span></h4>
      <p>Each item has <strong>five count columns</strong> matching every condition state in the system:</p>
      <table class="help__table">
        <thead><tr><th>Column</th><th>Meaning</th></tr></thead>
        <tbody>
          <tr><td><strong>Svc</strong></td><td>Serviceable — good working order</td></tr>
          <tr><td><strong>U/S</strong></td><td>Unserviceable — damaged or non-functional, awaiting assessment</td></tr>
          <tr><td><strong>Repr</strong></td><td>In repair — currently being repaired (amber tint when filled)</td></tr>
          <tr><td><strong>Cal</strong></td><td>Calibration due — must be calibrated before issue (amber tint when filled)</td></tr>
          <tr><td><strong>W/O</strong></td><td>Written off — beyond repair, pending Board of Survey (AB174) (red tint when filled)</td></tr>
        </tbody>
      </table>
      <ol>
        <li>Go to <strong>Stocktake</strong> and enter counts for each item's condition columns</li>
        <li>The <strong>Total</strong> cell sums all five columns; <strong>Variance</strong> compares it to the system quantity</li>
        <li>Optionally set the condition dropdown (same five states) and add notes per item</li>
        <li>Use the category filter to work section by section</li>
        <li>Drafts save automatically — you can leave and return</li>
        <li>When done, click <strong>Finalise stocktake</strong> and review the full breakdown before confirming</li>
      </ol>
      <p>On finalise, each item is updated: <strong>On hand</strong> ← total counted; the full condition breakdown (Svc / U/S / Repr / Cal / W/O) is stored on the item so the Inventory page and stock report PDF both reflect the exact post-stocktake state. Write-off items generate a separate <code>stocktake_writeoff</code> audit entry.</p>
      <p class="help__note">Written-off items must be formally struck off charge via Board of Survey (AB174). The system records them but does not process the write-off automatically.</p>
      <p class="help__warn">Finalising is irreversible. Check all counts before confirming.</p>
    `,
  },
  {
    id: 'orders',
    title: 'AAC QStore Orders',
    icon: '📦',
    body: `
      <p>The <strong>Orders</strong> page tracks supply orders from the AAC QStore procurement system. QMs and OCs can import order PDFs, view item details, and receive issued items directly into the IMS inventory.</p>
      <p class="help__note">Orders is a <strong>unit-only tracking module</strong> — it reads AAC QStore PDFs but does not connect to or modify the AAC QStore system.</p>

      <h4>Importing a PDF order <span class="help__role">OC / QM</span></h4>
      <ol>
        <li>Download the order PDF from AAC QStore</li>
        <li>Go to the <strong>Orders</strong> page and click <strong>Import PDF Order</strong></li>
        <li>Select the PDF file — the system extracts order number, category, date, requestor, unit, and all line items automatically</li>
        <li>The order is saved and opens in the detail view</li>
      </ol>

      <h4>Order types</h4>
      <table class="help__table">
        <thead><tr><th>Badge</th><th>Meaning</th></tr></thead>
        <tbody>
          <tr><td><strong>Request</strong></td><td>Order submitted to AAC QStore but not yet dispatched ("Order submitted")</td></tr>
          <tr><td><strong>Issue</strong></td><td>Items dispatched / issued by AAC QStore — can be received into IMS</td></tr>
        </tbody>
      </table>

      <h4>IMS match status</h4>
      <p>Each item in the order is matched to your IMS inventory by NSN. The status column shows:</p>
      <table class="help__table">
        <thead><tr><th>Status</th><th>Meaning</th></tr></thead>
        <tbody>
          <tr><td>In IMS</td><td>NSN exists in your inventory — onHand will be increased on receive</td></tr>
          <tr><td>New</td><td>NSN not yet in IMS — a new inventory item will be created on receive</td></tr>
          <tr><td>No NSN</td><td>Item has no NSN and will be skipped on receive</td></tr>
        </tbody>
      </table>

      <h4>Approve &amp; Receive into IMS <span class="help__role">OC / QM</span></h4>
      <p>Available for <strong>Issue</strong> orders that have not yet been received:</p>
      <ol>
        <li>Open the order detail and click <strong>Approve &amp; Receive into IMS</strong></li>
        <li>Review matched and new items — select a category for new items</li>
        <li>Add optional QM notes (e.g. "Received from Townsville warehouse")</li>
        <li>Click <strong>Confirm &amp; Update IMS</strong></li>
      </ol>
      <p>On confirm: existing items have their <strong>onHand</strong> (and Serviceable breakdown) incremented by the ordered quantity. New items are created with the NSN, description, and quantity from the order. An audit entry is written for the receive action.</p>
      <p class="help__warn">This action cannot be undone from the Orders page. If you receive an order in error, manually adjust the affected inventory items from the Inventory page.</p>

      <h4>Exporting as CSV</h4>
      <p>Click <strong>Export CSV</strong> on any order detail to download a spreadsheet with order metadata and all line items, including NSN, description, quantities, and IMS match status.</p>

      <h4>Order statuses</h4>
      <table class="help__table">
        <thead><tr><th>Status</th><th>Meaning</th></tr></thead>
        <tbody>
          <tr><td>Pending</td><td>Imported but not yet received into IMS</td></tr>
          <tr><td>Received</td><td>Items have been received and IMS inventory updated</td></tr>
        </tbody>
      </table>
    `,
  },
  {
    id: 'audit',
    title: 'Audit log',
    icon: '📋',
    body: `
      <p>The audit log records every action taken in the system. It is available to <strong>OC and QM</strong> from the <strong>Audit</strong> tab.</p>
      <p>Each entry shows: sequence number, timestamp, action type, user, and description.</p>
      <p>The log is cryptographically chained — click <strong>Verify chain</strong> to confirm no entries have been tampered with.</p>

      <h4>Exporting the log <span class="help__role">OC / QM</span></h4>
      <p>Use <strong>⬇ Export CSV</strong> or <strong>⬇ Export JSON</strong> to download the currently-filtered entries. Apply a search or action filter first to narrow the export. The filename includes your unit code and today's date.</p>

      <h4>Common action types</h4>
      <table class="help__table">
        <thead><tr><th>Action</th><th>Meaning</th></tr></thead>
        <tbody>
          <tr><td>add / adjust</td><td>Inventory item added or edited</td></tr>
          <tr><td>item_delete</td><td>Inventory item deleted</td></tr>
          <tr><td>issue / return</td><td>Loan issued or returned</td></tr>
          <tr><td>cadet_add / cadet_update</td><td>Nominal roll changes</td></tr>
          <tr><td>cadet_discharge</td><td>Cadet deactivated — outstanding loans automatically recalled</td></tr>
          <tr><td>user_add / user_update / user_delete</td><td>User account management</td></tr>
          <tr><td>pin_change</td><td>PIN set or reset</td></tr>
          <tr><td>login / login_failed</td><td>Login events</td></tr>
          <tr><td>session_unlock</td><td>Locked session resumed after PIN entry</td></tr>
          <tr><td>data_export / data_imported</td><td>Backup actions</td></tr>
          <tr><td>stocktake / stocktake_writeoff</td><td>Stocktake finalised / write-off recorded during stocktake</td></tr>
          <tr><td>order-import</td><td>AAC QStore order PDF imported</td></tr>
          <tr><td>order-received</td><td>Order approved and items received into IMS</td></tr>
          <tr><td>order-delete</td><td>Order record deleted</td></tr>
          <tr><td>request_submitted</td><td>Equipment request submitted by a user</td></tr>
          <tr><td>request_approved</td><td>Equipment request approved (and optionally issued) by QM/OC</td></tr>
          <tr><td>request_denied</td><td>Equipment request denied by QM/OC</td></tr>
          <tr><td>request_withdrawn</td><td>Equipment request withdrawn by the requestor</td></tr>
        </tbody>
      </table>
    `,
  },
  {
    id: 'pin',
    title: 'PINs and security',
    icon: '🔐',
    body: `
      <h4>PIN management policy</h4>
      <p>PINs are managed exclusively by the <strong>OC (administrator)</strong>. No user can view or change their own PIN — this is a deliberate security control.</p>
      <ul>
        <li>When a new user is created, the OC sets the initial PIN and tells the user verbally</li>
        <li>If a user forgets their PIN, they must ask the OC to reset it via <strong>Users → Reset PIN</strong></li>
        <li>After any PIN is set or reset, it is displayed once for the OC to note down — it cannot be retrieved again</li>
      </ul>
      <p>PINs must be exactly 4 digits.</p>

      <h4>Auto-lock (idle timeout) <span class="help__role">OC only</span></h4>
      <p>The OC can configure the app to lock automatically after a period of inactivity in <strong>Settings → Security → Auto-lock after idle</strong>. Options: Disabled, 5, 10, 15, 30 minutes, or 1 hour.</p>
      <p>When locked, a PIN entry screen overlays the current page. Any mouse, keyboard, or touch activity resets the timer. On the lock screen:</p>
      <ul>
        <li>Enter your PIN to resume — the page you were on is still active behind the overlay</li>
        <li>Click <strong>Sign out / switch user</strong> to log out fully</li>
      </ul>
      <p class="help__note">Failed unlock attempts follow the same lockout rules as login. Unlock events are recorded in the audit log as <code>session_unlock</code>.</p>

      <h4>PIN lockout</h4>
      <table class="help__table">
        <thead><tr><th>Failed attempts</th><th>Lockout</th></tr></thead>
        <tbody>
          <tr><td>5</td><td>30 seconds</td></tr>
          <tr><td>10</td><td>5 minutes</td></tr>
          <tr><td>15+</td><td>30 minutes</td></tr>
        </tbody>
      </table>

      <h4>OC PIN recovery <span class="help__role">OC only</span></h4>
      <p>The OC account has an additional recovery path: generate a recovery code in <strong>Settings → OC PIN recovery</strong>. Store it off-device (e.g. printed copy in the unit safe). If the OC forgets their PIN, use it on the login screen via <strong>Forgot PIN?</strong>.</p>
      <p class="help__warn">Recovery codes are one-use only. Generate a new one immediately after use. Without a recovery code, a lost OC PIN cannot be recovered.</p>
    `,
  },
  {
    id: 'backup',
    title: 'Backup and restore',
    icon: '💾',
    body: `
      <h4>Exporting a backup <span class="help__role">OC</span></h4>
      <ol>
        <li>Go to <strong>Settings → Data backup &amp; restore</strong></li>
        <li>Click <strong>Export backup</strong></li>
        <li>A JSON file is downloaded — store it off-device</li>
      </ol>
      <p>The backup includes all inventory, photos, loans, cadets, users, settings, and the audit chain.</p>

      <h4>Importing a backup <span class="help__role">OC</span></h4>
      <ol>
        <li>Click <strong>Import backup</strong></li>
        <li>Select the <code>.json</code> file</li>
        <li>Confirm — <strong>this replaces all current data</strong></li>
      </ol>
      <p class="help__warn">Always keep a current backup. Data is stored locally in the browser — clearing browser data will erase it.</p>

      <h4>CSV import</h4>
      <p>Bulk-import inventory items from a spreadsheet via <strong>Import CSV</strong>. Download the template, fill it in, then upload and map columns.</p>
    `,
  },
  {
    id: 'cloud',
    title: 'Cloud sync (OneDrive)',
    icon: '☁',
    body: `
      <p>Cloud sync backs up data to Microsoft OneDrive automatically. It is optional — the app works fully offline without it.</p>

      <h4>Setup <span class="help__role">OC</span></h4>
      <ol>
        <li>Go to <strong>Settings → Cloud sync</strong></li>
        <li>Note the <strong>Redirect URI</strong> — register it in Azure exactly as shown</li>
        <li>Enter your Azure Application (Client) ID</li>
        <li>Click <strong>Save</strong> then <strong>Sign in</strong></li>
      </ol>
      <p class="help__note">After the first successful sync the Client ID is hidden for security. Click and hold <strong>Hold to reveal</strong> to view it — it is shown only while held.</p>

      <h4>Sync options</h4>
      <ul>
        <li><strong>Auto-sync</strong> — syncs automatically when changes are made</li>
        <li><strong>Sync now</strong> — manual push</li>
        <li><strong>Load from cloud</strong> — replaces local data with the cloud copy (destructive)</li>
      </ul>
      <p class="help__note">Cloud sync requires the app to be served over HTTPS. It is unavailable when opened as a <code>file://</code> URL.</p>
    `,
  },
  {
    id: 'troubleshooting',
    title: 'Troubleshooting',
    icon: '🔧',
    body: `
      <dl class="help__dl">
        <dt>App shows a blank screen or won't load</dt>
        <dd>Ensure JavaScript is enabled. Try a hard refresh: <kbd>Ctrl+Shift+R</kbd> (Windows) or <kbd>Cmd+Shift+R</kbd> (Mac). Check the browser console (F12) for errors.</dd>

        <dt>Search cursor jumps out of the search box</dt>
        <dd>Upgrade to the latest version of the app — this was fixed in v2.</dd>

        <dt>Stock levels look wrong</dt>
        <dd>Run a stocktake to reconcile physical counts. Check the Audit log for unexpected adjustments.</dd>

        <dt>Cloud sync won't connect</dt>
        <dd>Verify the redirect URI in Azure exactly matches what Settings shows. The app must be served over HTTPS, not file://. Try signing out and back in.</dd>

        <dt>Audit chain verification fails</dt>
        <dd>Data may have been modified outside the app. Import from your most recent known-good backup.</dd>

        <dt>Forgot OC PIN — no recovery code</dt>
        <dd>Without a recovery code there is no bypass. Always generate and store a recovery code in Settings. Contact admin@seanscales.com.au for assistance.</dd>

        <dt>Data missing after browser update</dt>
        <dd>Browser data (including IndexedDB) can be lost if the browser profile is reset or cleared. Keep regular backup exports and store them off-device.</dd>
      </dl>
    `,
  },
  {
    id: 'reference',
    title: 'Uniform sizing reference',
    icon: '📐',
    body: `
      <p>The <strong>Reference</strong> page (accessible from the main navigation) provides ADF uniform and equipment sizing tables with conversion between AU/NATO (centimetres), US (inches) and generalised sizes (XS–3XL), together with measurement guides for each garment type.</p>

      <h4>Shirts &amp; Jackets (AMCU)</h4>
      <p>AMCU shirts and field jackets use a chest-plus-height code: <code>CHEST(cm) + HEIGHT-BAND</code> with no separator. e.g. <code>90R</code> = 90 cm chest, Regular height. Chest is measured in centimetres and rounded <em>down</em> to the nearest 5 cm. Height bands: <strong>S</strong> (Short, under 170 cm), <strong>R</strong> (Regular, 170–183 cm), <strong>L</strong> (Long/Tall, over 183 cm).</p>
      <p><em>How to measure chest:</em> Tape around the fullest part of the chest, under the armpits and across the shoulder blades. Keep horizontal and snug.</p>

      <h4>Trousers (AMCU)</h4>
      <p>AMCU trousers are sized by <code>WAIST(in) + LEG-BAND</code>, e.g. <code>34R</code> = 34-inch waist, Regular length. Leg bands: <strong>S</strong> (inside leg ≤ 76 cm), <strong>R</strong> (77–84 cm), <strong>L</strong> (≥ 85 cm).</p>
      <p><em>How to measure waist:</em> Around the natural waist, approximately 2.5 cm above the navel, in centimetres — then divide by 2.54 and round to the nearest even inch. <em>Inside leg:</em> From crotch seam down to ankle bone, standing straight.</p>

      <h4>Boots</h4>
      <p>AU boot sizes use the same scale as UK sizes. Add half a size when wearing thick military socks. Measure foot length from heel to longest toe on a flat surface.</p>

      <h4>Hats &amp; Berets</h4>
      <p>Sized by head circumference in centimetres. Wrap tape around the head 2 cm above the eyebrows and across the widest part at the back. Round up if between sizes.</p>
    `,
  },
];

// -----------------------------------------------------------------------------
// Render
// -----------------------------------------------------------------------------

function _render() {
  if (!_root) return;

  render(_root, `
    <section class="help">
      <header class="help__header">
        <h1 class="help__title">Help &amp; Quick Reference</h1>
        <p class="help__subtitle">
          Click a section to expand it. For the full manual see
          <a href="https://github.com/Woodifi/145ACUQstoreV2D/blob/master/MANUAL.md"
             target="_blank" rel="noopener" class="help__manual-link">MANUAL.md on GitHub ↗</a>.
        </p>
        <input type="search" class="help__search" placeholder="Search help…" aria-label="Search help">
      </header>

      <div class="help__sections">
        ${SECTIONS.map(s => `
          <details class="help__section" id="help-${s.id}">
            <summary class="help__section-summary">
              <span class="help__section-icon">${s.icon}</span>
              <span class="help__section-title">${s.title}</span>
            </summary>
            <div class="help__section-body">${s.body}</div>
          </details>
        `).join('')}
      </div>
    </section>
  `);

  _wireSearch();
}

function _wireSearch() {
  const input = $('.help__search', _root);
  if (!input) return;

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    $$('.help__section', _root).forEach(el => {
      if (!q) {
        el.style.display = '';
        return;
      }
      const text = el.textContent.toLowerCase();
      el.style.display = text.includes(q) ? '' : 'none';
      if (text.includes(q)) el.open = true;
    });
  });
}

function $$( sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}
