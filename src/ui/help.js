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
      <h4>First login</h4>
      <p>Select <strong>Administrator</strong> from the user list and enter PIN <code>0000</code>.
      You will be prompted to change this immediately — do so before continuing.</p>

      <h4>Initial setup</h4>
      <ol>
        <li>Go to <strong>Settings → Unit details</strong></li>
        <li>Enter your unit name, unit code, state, OC/QM name, and rank</li>
        <li>Upload a unit logo (optional)</li>
        <li>Click <strong>Save unit details</strong></li>
      </ol>

      <h4>Adding users</h4>
      <ol>
        <li>Go to <strong>Settings → User accounts</strong></li>
        <li>Click <strong>+ Add user</strong> and fill in name, username, role, service number, and initial PIN</li>
        <li>Users should change their PIN on first login</li>
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
          <tr><td><strong>OC</strong></td><td>Full access including Settings. Assign to the Commanding Officer only.</td></tr>
          <tr><td><strong>QM</strong></td><td>Full operational access — inventory, loans, cadets, stocktake, audit. Cannot access Settings.</td></tr>
          <tr><td><strong>Staff</strong></td><td>View all pages. Cannot add/edit inventory or manage cadets.</td></tr>
          <tr><td><strong>Cadet</strong></td><td>View inventory and their own loans only.</td></tr>
          <tr><td><strong>Read-Only</strong></td><td>View-only. No actions.</td></tr>
        </tbody>
      </table>
      <p class="help__note">Only the OC can access the Settings page. Only OC and QM can issue/return loans, edit inventory, or run stocktakes.</p>
    `,
  },
  {
    id: 'inventory',
    title: 'Inventory',
    icon: '📦',
    body: `
      <h4>Viewing and searching</h4>
      <p>Type in the search box to filter by NSN, name, or category. Use the category dropdown to narrow further. Results update as you type.</p>

      <h4>Adding an item <span class="help__role">OC / QM</span></h4>
      <ol>
        <li>Click <strong>+ Add item</strong></li>
        <li>Enter NSN (4-2-3-4 format, e.g. <code>8470-66-001-0001</code>), name, category, quantities, condition, and location</li>
        <li>Click <strong>Save item</strong></li>
      </ol>

      <h4>Editing an item <span class="help__role">OC / QM</span></h4>
      <p>Click <strong>Edit</strong> on any row. All changes are recorded in the audit log.</p>

      <h4>Deleting an item <span class="help__role">OC only</span></h4>
      <p>Click <strong>Delete</strong> and provide a reason. Deletion is permanent.</p>

      <h4>Item photos</h4>
      <p>Click the camera icon on any row to upload a photo (JPEG, PNG, or WebP).</p>

      <h4>Print stock list</h4>
      <p>Click <strong>⎙ Print stock</strong> to generate a PDF of currently-visible items.</p>

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

      <h4>Using an issue kit</h4>
      <p>Click <strong>⊞ Load kit</strong> on the Issue tab to pre-fill items from a saved kit. Adjust quantities before issuing.</p>

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
      <p>Filter by Active, Returned, Overdue, or All. Search by borrower name or loan reference.</p>
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
      <p>All logged-in users can view the nominal roll. Search by name or service number. Filter by platoon. Tick <strong>Show inactive</strong> to see deactivated records.</p>

      <h4>Adding a person <span class="help__role">OC / QM</span></h4>
      <ol>
        <li>Click <strong>+ Add cadet/staff</strong></li>
        <li>Enter service number, surname, given names, rank, and platoon</li>
        <li>Person type (cadet or staff) is set automatically from the rank</li>
        <li>Click <strong>Save</strong></li>
      </ol>

      <h4>Deactivating a person</h4>
      <p>Click <strong>Edit</strong> and untick <strong>Active</strong>. The record and loan history are retained.</p>
    `,
  },
  {
    id: 'stocktake',
    title: 'Stocktake',
    icon: '🔢',
    body: `
      <h4>Running a stocktake <span class="help__role">OC / QM</span></h4>
      <ol>
        <li>Go to <strong>Stocktake</strong> and click <strong>Start new stocktake</strong></li>
        <li>Work through items — enter the physical count for each one</li>
        <li>Optionally override the condition or add notes per item</li>
        <li>Use the category filter to work section by section</li>
        <li>Drafts save automatically — you can leave and return</li>
        <li>When done, click <strong>Finalise stocktake</strong> and confirm</li>
      </ol>
      <p>On-hand quantities are updated to match physical counts. Discrepancies are recorded in the audit log. A PDF report is available after finalising.</p>
      <p class="help__warn">Finalising is irreversible. Check all counts before confirming.</p>
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

      <h4>Common action types</h4>
      <table class="help__table">
        <thead><tr><th>Action</th><th>Meaning</th></tr></thead>
        <tbody>
          <tr><td>add / adjust</td><td>Inventory item added or edited</td></tr>
          <tr><td>issue / return</td><td>Loan issued or returned</td></tr>
          <tr><td>cadet_add / cadet_update</td><td>Nominal roll changes</td></tr>
          <tr><td>pin_change</td><td>User changed their PIN</td></tr>
          <tr><td>login / login_failed</td><td>Login events</td></tr>
          <tr><td>data_export / data_imported</td><td>Backup actions</td></tr>
          <tr><td>stocktake</td><td>Stocktake finalised</td></tr>
        </tbody>
      </table>
    `,
  },
  {
    id: 'pin',
    title: 'PINs and security',
    icon: '🔐',
    body: `
      <h4>Changing your PIN</h4>
      <p>Click your name/role in the top-right corner and select <strong>Change PIN</strong>. Enter your current PIN, then the new PIN twice.</p>
      <p>PINs must be 4 digits and cannot be <code>0000</code>.</p>

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
      <p>Generate a recovery code in <strong>Settings → OC PIN recovery</strong>. Store it off-device. If you forget your PIN, use it on the login screen via <strong>Forgot PIN?</strong>.</p>
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
