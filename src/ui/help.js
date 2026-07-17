// =============================================================================
// QStore IMS v2 — Help page
// =============================================================================
// Quick-reference guide accessible to all logged-in users. Organised into
// collapsible sections so users can find answers without scrolling the whole
// document. Each section mirrors the matching chapter in MANUAL.md.
// =============================================================================

import { render, $ } from './util.js';
import { generateUserManual, downloadUserManual } from '../manual-pdf.js';
import { showToast } from './toast.js';

let _root = null;

export async function mount(rootEl) {
  _root = rootEl;
  _render();

  // The manual generator has existed since it was written and has NEVER been
  // imported — `git log -S manual-pdf -- src/` returns nothing. Its own header
  // says "Called from the Help page via 'Download Manual PDF'". There was no
  // such button, and the link offered instead pointed at a MANUAL.md that does
  // not exist in this repository, in a repository that is private. So the
  // manual was unreachable and the fallback was broken twice over.
  const onClick = async (e) => {
    if (!e.target.closest('[data-action="download-manual"]')) return;
    try {
      downloadUserManual(await generateUserManual());
    } catch (err) {
      showToast('Could not generate the manual: ' + (err.message || err), 'error');
    }
  };
  _root.addEventListener('click', onClick);

  return function unmount() {
    _root?.removeEventListener('click', onClick);
    _root = null;
  };
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
      <p>After first login, the Dashboard shows a <strong>setup checklist</strong> with three steps: set unit details, add your first inventory item, and set up issue destinations.
      Click <strong>Go →</strong> on any step to jump straight there. The checklist disappears once all three steps are complete, or when you dismiss it.</p>
      <ol>
        <li>Go to <strong>Settings → Unit details</strong> (the section is highlighted with a "⬅ Start here" badge until you save a unit name)</li>
        <li>Enter your unit name, unit code, state, OC/QM name, and rank</li>
        <li>Upload a unit logo (optional)</li>
        <li>Click <strong>Save unit details</strong></li>
      </ol>

      <h4>Adding users</h4>
      <p class="help__note"><strong>Staff only. Never create an account for a cadet.</strong> A user account stores the person's name and service number. This build holds no cadet personal information, and a cadet account would put it back — by a different door. There is no cadet role, and cadet accounts from earlier versions cannot sign in.</p>
      <ol>
        <li>Go to the <strong>Users</strong> page (OC only, visible in the navigation bar)</li>
        <li><strong>Confirm the person is staff, not a cadet</strong></li>
        <li>Click <strong>+ Add User</strong> and fill in name, username, role, service number, and initial PIN</li>
        <li>After saving, the PIN is displayed <strong>once</strong> — note it down immediately and give it to the user verbally</li>
        <li>Only the OC can manage PINs. Users cannot change their own PIN — if a user forgets their PIN they must ask the OC to reset it via the <strong>Reset PIN</strong> button on the Users page</li>
      </ol>
      <h4>2FA status column</h4>
      <p>The Users table includes a <strong>2FA</strong> column showing two-factor authentication status at a glance:</p>
      <ul>
        <li><strong>✓ On</strong> (green) — 2FA is active; hover to see remaining backup code count</li>
        <li><strong>Off</strong> (grey) — 2FA is not configured</li>
        <li><strong>⚠ Off</strong> (amber) — 2FA is not configured on a privileged account (OC or QM) — enabling it is strongly recommended</li>
      </ul>
      <p>Each user configures their own 2FA from <strong>Settings → Two-factor authentication</strong>.</p>
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
          <tr><td><strong>QM</strong></td><td>Full operational access — inventory, loans, stocktake, orders, audit. Cannot access Settings.</td></tr>
          <tr><td><strong>Staff</strong></td><td>View pages and reports. Cannot add or edit inventory.</td></tr>
          <tr><td><strong>Read-Only</strong></td><td>View-only. No actions.</td></tr>
        </tbody>
      </table>
      <table class="help__table" style="margin-top:0.5rem">
        <thead><tr><th>Action</th><th>OC</th><th>QM</th><th>Staff</th><th>RO</th></tr></thead>
        <tbody>
          <tr><td>View inventory / loans</td><td>✓</td><td>✓</td><td>✓</td><td>✓</td></tr>
          <tr><td>Submit equipment requests</td><td>✓</td><td>✓</td><td>✓</td><td>—</td></tr>
          <tr><td>Issue / return loans</td><td>✓</td><td>✓</td><td>—</td><td>—</td></tr>
          <tr><td>Approve / deny requests</td><td>✓</td><td>✓</td><td>—</td><td>—</td></tr>
          <tr><td>Edit inventory</td><td>✓</td><td>✓</td><td>—</td><td>—</td></tr>
          <tr><td>Stocktake / Orders</td><td>✓</td><td>✓</td><td>—</td><td>—</td></tr>
          <tr><td>Audit log</td><td>✓</td><td>✓</td><td>—</td><td>—</td></tr>
          <tr><td>Settings / Users</td><td>✓</td><td>—</td><td>—</td><td>—</td></tr>
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
      <p>The <strong>Users</strong> page (OC only) is where you create and manage login accounts for the <strong>staff</strong> who use the app.</p>

      <p class="help__note"><strong>Staff only. Never create an account for a cadet.</strong> A user account stores the person's name and service number. This build holds no cadet personal information, and a cadet account would put it back — by a different door. There is no cadet role, and cadet accounts from earlier versions cannot sign in.</p>

      <h4>Adding a user <span class="help__role">OC only</span></h4>
      <ol>
        <li><strong>Confirm the person is staff.</strong> Cadets do not get accounts</li>
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
      <p>Every item tracks a five-state condition breakdown. <strong>Svc is automatically calculated</strong> — only the four non-serviceable categories need to be entered:</p>
      <table class="help__table">
        <thead><tr><th>Field</th><th>Meaning</th><th>Editable?</th></tr></thead>
        <tbody>
          <tr><td><strong>Svc</strong></td><td>Serviceable — ready for issue (auto-calculated)</td><td>Read-only — derived from On hand minus all other categories</td></tr>
          <tr><td><strong>U/S</strong></td><td>Unserviceable — damaged or non-functional</td><td>Yes</td></tr>
          <tr><td><strong>Repr</strong></td><td>In repair — temporarily unavailable</td><td>Yes</td></tr>
          <tr><td><strong>Cal</strong></td><td>Calibration due — must be calibrated before issue</td><td>Yes</td></tr>
          <tr><td><strong>W/O</strong></td><td>Written off — beyond repair, pending Board of Survey</td><td>Yes</td></tr>
        </tbody>
      </table>
      <p>The <strong>Svc</strong> field updates in real-time as you change any other category. To move 2 items from Svc to U/S: just increase U/S by 2 — Svc drops automatically. The overall <strong>Condition badge</strong> is also derived from these fields — no separate setting required.</p>

      <h4>Adding an item <span class="help__role">OC / QM</span></h4>
      <ol>
        <li>Click <strong>+ Add item</strong></li>
        <li>Enter NSN (4-2-3-4 format, e.g. <code>8470-66-001-0001</code>), name, category, authorised and on-hand quantities</li>
        <li>Enter the quantities in each <strong>non-serviceable</strong> category (U/S, Repr, Cal, W/O). <strong>Svc is calculated automatically.</strong></li>
        <li>Enter a location and click <strong>Save item</strong></li>
      </ol>
      <p class="help__note">Increasing <strong>On hand</strong> automatically increases <strong>Svc</strong> — new stock is assumed serviceable until categorised otherwise.</p>

      <h4>Editing an item <span class="help__role">OC / QM</span></h4>
      <p>Click <strong>Edit</strong> on any row. The condition breakdown fields are pre-filled from current data. All changes are recorded in the audit log.</p>

      <h4>Loan history</h4>
      <p>Click <strong>History</strong> on any row to see the full loan history for that item — issue number or destination, dates, quantity, and return status.</p>

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
        <li>Select the destination (or <strong>Individual</strong>, which allocates an issue number), purpose, issue date, and due date</li>
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
      <p>Filter by Active, Returned, Overdue, or All. Search by loan reference, item, issue number or destination. Use the <strong>Issue / destination</strong> filter to show only loans against one issue document or location — pill counts update to match. This build does not record who holds an item: that is on the issue document, filed in the member's CEA documents.</p>
      <p class="help__note">This build does not record who holds an item, so it cannot flag a discharged member's outstanding kit or recall it automatically. Chasing kit from a departing member is a documents task in CEA.</p>
    `,
  },
  {
    id: 'requests',
    title: 'Equipment requests (paper)',
    icon: '📋',
    body: `
      <p>Equipment requests are <strong>paper</strong> in this build. There is no
      Requests page: a request records who wants what, and this system does not
      store people.</p>

      <h4>How it works</h4>
      <ol>
        <li>Go to <strong>Loans → Issue</strong> and click <strong>⎙ Blank AB189</strong></li>
        <li>Give the printed form to the member — they complete their own details by hand</li>
        <li>Process the request from the paper as a normal issue</li>
        <li>Scan or save the completed AB189 and upload it to that member's
            <strong>CEA documents</strong></li>
      </ol>
      <p class="help__note">The CEA document is the record of who requested and
      received the equipment. This system records only that the items went out,
      against an issue number.</p>
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
          <tr><td>staff_viewed</td><td>Staff record opened for editing (PII read-access logged)</td></tr>
          <tr><td>user_add / user_update / user_delete</td><td>User account management</td></tr>
          <tr><td>pin_change</td><td>PIN set or reset</td></tr>
          <tr><td>login / login_failed</td><td>Login events</td></tr>
          <tr><td>session_unlock</td><td>Locked session resumed after PIN entry</td></tr>
          <tr><td>data_export / data_imported</td><td>Backup exported or restored</td></tr>
          <tr><td>2fa_enabled / 2fa_disabled</td><td>Two-factor authentication toggled</td></tr>
          <tr><td>2fa_backup_used</td><td>Backup code used to complete 2FA login</td></tr>
          <tr><td>2fa_backup_regen</td><td>2FA backup codes regenerated</td></tr>
          <tr><td>stocktake / stocktake_writeoff</td><td>Stocktake finalised / write-off recorded during stocktake</td></tr>
          <tr><td>order-import</td><td>AAC QStore order PDF imported</td></tr>
          <tr><td>order-received</td><td>Order approved and items received into IMS</td></tr>
          <tr><td>order-delete</td><td>Order record deleted</td></tr>
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
      <p>Configure in <strong>Settings → Security → Auto-lock after idle</strong>: 5, 10, 15, 30 minutes, or 1 hour. Auto-lock cannot be disabled — minimum is 5 minutes. The default (15 minutes) is active from first login even before the setting is explicitly saved.</p>
      <p>When locked, a PIN entry screen overlays the current page. Any mouse, keyboard, or touch activity resets the timer. The lock also fires immediately when the device wakes from sleep or when the browser tab becomes visible again, if the idle period elapsed during that time. On the lock screen:</p>
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

      <h4>Two-factor authentication (2FA) <span class="help__role">all roles</span></h4>
      <p>2FA adds a second sign-in step: after your PIN, you enter a 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator, Authy, etc.). It works fully offline.</p>
      <p>To set up 2FA on your account: <strong>Settings → Two-factor authentication → Set up two-factor authentication</strong>. The 3-step wizard walks you through adding the account to your authenticator app, verifying a code, and saving backup codes.</p>
      <p>Once enabled, your next login will ask for a code after the PIN. If you cannot access your authenticator app, click <strong>Use a backup code instead</strong> on the code screen and enter one of your 8-character single-use backup codes.</p>
      <p class="help__note">OC and QM accounts have full data access — 2FA is strongly recommended for these roles.</p>

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
        <li>Enter and confirm a password of at least 12 characters</li>
        <li>An encrypted <code>.qstore</code> file is downloaded</li>
        <li>Store the file off-device in a secure location</li>
      </ol>
      <p>The backup includes all inventory, photos, loans, users, settings, and the audit chain.</p>
      <p class="help__note">Backups are always encrypted; there is no unencrypted option. The backup contains the keys that protect personal information, so an unencrypted copy would give anyone who found the file both the data and the key to read it.</p>
      <p class="help__note">Encrypted backups use AES-256-GCM with PBKDF2 key derivation. The file is unreadable without the correct password — keep it safe, there is no recovery path. Losing it does not affect your live data; only that backup file becomes unreadable.</p>

      <h4>Importing a backup <span class="help__role">OC</span></h4>
      <ol>
        <li>Click <strong>Import backup</strong></li>
        <li>Confirm by typing <strong>OVERWRITE</strong> — this replaces all current data</li>
        <li>Select the <code>.qstore</code> file (older <code>.json</code> backups are still accepted)</li>
        <li>Enter the password when prompted</li>
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
          Click a section to expand it, or download the full manual as a PDF.
        </p>
        <div class="form__actions" style="margin:8px 0">
          <button type="button" class="btn btn--outline btn--sm" data-action="download-manual">
            ⎙ Download full manual (PDF)
          </button>
        </div>
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
