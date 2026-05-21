// =============================================================================
// QStore IMS — TOTP 2FA setup and management modal
// =============================================================================
// Provides three entry points:
//
//   openTotpSetup(userId)     — enrol a user in 2FA (step-by-step wizard)
//   openTotpManage(userId)    — manage existing 2FA (disable / regen backup codes)
//   openBackupCodesView(user) — view/print remaining backup codes
//
// Wizard flow:
//   Step 1 → Show secret + otpauth:// URI for manual app entry
//   Step 2 → Verify: user enters a code from their authenticator
//   Step 3 → Show backup codes with print option; confirm stored safely
//
// On completion the user record is updated via Storage.users.put().
// The caller is responsible for re-rendering the settings page if needed.
// =============================================================================

import * as Storage from '../storage.js';
import * as AUTH    from '../auth.js';
import * as TOTP    from '../totp.js';
import { openModal } from './modal.js';
import { esc, $, render } from './util.js';
import { showToast } from './toast.js';

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Open the TOTP enrolment wizard for `userId`.
 * On success the user record will have totpEnabled=true and a hashed backup list.
 */
export function openTotpSetup(userId) {
  const secret = TOTP.generateSecret();
  _wizardStep1(userId, secret);
}

/**
 * Open the 2FA management modal for a user who already has 2FA enabled.
 * Options: disable 2FA, regenerate backup codes, view remaining backup codes.
 */
export async function openTotpManage(userId) {
  const user = await Storage.users.get(userId);
  if (!user) { showToast('User not found.', 'error'); return; }

  openModal({
    titleHtml: 'Two-factor authentication',
    size:      'sm',
    bodyHtml: `
      <div class="totp-manage">
        <p class="totp-manage__status">
          <span class="badge badge--success">Enabled</span>
          ${esc(user.name)} has two-factor authentication active.
        </p>
        <p class="totp-manage__hint">
          Backup codes remaining:
          <strong>${(user.totpHashedBackups || []).length}</strong> of 8.
        </p>
        <div class="totp-manage__actions">
          <button type="button" class="btn btn--outline" data-action="view-backups">
            View remaining backup codes
          </button>
          <button type="button" class="btn btn--outline" data-action="regen-backups">
            Regenerate backup codes
          </button>
          <button type="button" class="btn btn--danger-ghost" data-action="disable-2fa">
            Disable two-factor authentication
          </button>
        </div>
      </div>
    `,
    onMount(panel, close) {
      panel.addEventListener('click', async (e) => {
        const action = e.target.closest('[data-action]')?.dataset.action;
        if (!action) return;

        if (action === 'view-backups') {
          close();
          openBackupCodesView(user);
          return;
        }
        if (action === 'regen-backups') {
          close();
          await _regenBackupCodes(userId);
          return;
        }
        if (action === 'disable-2fa') {
          close();
          await _disable2FA(userId);
        }
      });
    },
  });
}

/**
 * Show remaining hashed backup codes (view only — codes are already hashed
 * and cannot be recovered; this just shows the count and a regen prompt).
 */
export function openBackupCodesView(user) {
  const remaining = (user.totpHashedBackups || []).length;
  openModal({
    titleHtml: 'Backup codes',
    size:      'sm',
    bodyHtml: `
      <p>
        You have <strong>${remaining}</strong> backup code${remaining !== 1 ? 's' : ''} remaining.
      </p>
      <p class="text--muted">
        Backup codes are consumed when used and cannot be recovered — they are
        stored as one-way hashes. If you are running low, regenerate a fresh
        set from the 2FA management screen.
      </p>
      ${remaining === 0 ? `
        <div class="alert alert--warning">
          You have no backup codes left. Regenerate now to avoid being locked out
          if you lose access to your authenticator app.
        </div>
      ` : ''}
    `,
  });
}

// ---------------------------------------------------------------------------
// Wizard steps (internal)
// ---------------------------------------------------------------------------

function _wizardStep1(userId, secret) {
  const formatted = TOTP.formatSecret(secret);

  openModal({
    titleHtml: 'Set up two-factor authentication — Step 1 of 3',
    size:      'md',
    bodyHtml: `
      <div class="totp-setup">
        <p class="totp-setup__intro">
          Install an authenticator app on your phone (Google Authenticator,
          Microsoft Authenticator, Authy, or any RFC 6238-compatible app), then
          add a new account by entering the key below manually.
        </p>

        <div class="totp-setup__section">
          <div class="totp-setup__label">Account type</div>
          <div class="totp-setup__value totp-setup__value--meta">
            Time-based (TOTP) · SHA1 · 6 digits · 30 second window
          </div>
        </div>

        <div class="totp-setup__section">
          <div class="totp-setup__label">Secret key</div>
          <div class="totp-setup__secret" id="totp-secret-display">
            <code class="totp-setup__code">${esc(formatted)}</code>
            <button type="button" class="btn btn--xs btn--ghost" data-action="copy-secret"
                    aria-label="Copy secret to clipboard">Copy</button>
          </div>
          <div class="totp-setup__secret-warn">
            Keep this key private. Anyone with it can generate codes for this account.
          </div>
        </div>

        <div class="totp-setup__section">
          <div class="totp-setup__label">Manual entry hint</div>
          <div class="totp-setup__value text--muted">
            In your authenticator app: choose "Enter a setup key" or "Manual entry".
            Paste the key above. Set account name to your QStore username.
          </div>
        </div>

        <div class="totp-setup__footer">
          <button type="button" class="btn btn--ghost" data-action="cancel">Cancel</button>
          <button type="button" class="btn btn--primary" data-action="next">
            I've added the account — Next
          </button>
        </div>
      </div>
    `,
    onMount(panel, close) {
      panel.addEventListener('click', async (e) => {
        const action = e.target.closest('[data-action]')?.dataset.action;
        if (!action) return;

        if (action === 'copy-secret') {
          try {
            await navigator.clipboard.writeText(secret);
            e.target.textContent = 'Copied!';
            setTimeout(() => { e.target.textContent = 'Copy'; }, 2000);
          } catch {
            showToast('Copy failed — select the key manually.', 'warning');
          }
          return;
        }
        if (action === 'cancel') { close(); return; }
        if (action === 'next') {
          close();
          _wizardStep2(userId, secret);
        }
      });
    },
  });
}

function _wizardStep2(userId, secret) {
  let _verifying = false;

  openModal({
    titleHtml: 'Set up two-factor authentication — Step 2 of 3',
    size:      'sm',
    bodyHtml: `
      <div class="totp-setup">
        <p class="totp-setup__intro">
          Open your authenticator app and enter the 6-digit code shown for
          your QStore account to confirm everything is working.
        </p>
        <div class="totp-setup__verify-wrap">
          <input type="text" id="totp-verify-input"
                 inputmode="numeric" pattern="\\d{6}" maxlength="6"
                 autocomplete="one-time-code" spellcheck="false"
                 class="totp-setup__code-input"
                 placeholder="000000"
                 aria-label="6-digit code from authenticator app">
          <div class="totp-setup__verify-error" role="alert"></div>
        </div>
        <div class="totp-setup__footer">
          <button type="button" class="btn btn--ghost" data-action="back">Back</button>
          <button type="button" class="btn btn--primary" data-action="verify">
            Verify code
          </button>
        </div>
      </div>
    `,
    onMount(panel, close) {
      const input   = $('#totp-verify-input',        panel);
      const errEl   = $('.totp-setup__verify-error', panel);
      const verifyBtn = panel.querySelector('[data-action="verify"]');

      if (input) input.focus();

      // Auto-submit when 6 digits typed
      if (input) {
        input.addEventListener('input', () => {
          input.value = input.value.replace(/\D/g, '').slice(0, 6);
          if (input.value.length === 6) verifyBtn?.click();
        });
      }

      panel.addEventListener('click', async (e) => {
        const action = e.target.closest('[data-action]')?.dataset.action;
        if (!action) return;

        if (action === 'back') { close(); _wizardStep1(userId, secret); return; }
        if (action === 'verify') {
          if (_verifying) return;
          _verifying = true;
          if (errEl) errEl.textContent = '';
          const code = input?.value?.trim() || '';
          const result = await TOTP.verify(secret, code);
          _verifying = false;
          if (result.ok) {
            close();
            await _wizardStep3(userId, secret, result.step);
          } else {
            if (errEl) errEl.textContent = 'Code incorrect or expired — check your device clock and try again.';
            if (input) { input.value = ''; input.focus(); }
          }
        }
      });
    },
  });
}

async function _wizardStep3(userId, secret, verifiedStep) {
  // Generate backup codes before opening the modal
  const { plain, hashed } = await TOTP.generateBackupCodes(8);

  openModal({
    titleHtml: 'Set up two-factor authentication — Step 3 of 3',
    size:      'md',
    bodyHtml: `
      <div class="totp-setup">
        <p class="totp-setup__intro">
          Save these backup codes somewhere secure (printed, password manager,
          or secure notes). Each code can be used once if you lose access to
          your authenticator app.
        </p>

        <div class="totp-setup__backup-grid" id="backup-codes-grid">
          ${plain.map(c => `<code class="totp-setup__backup-code">${esc(c)}</code>`).join('')}
        </div>

        <div class="totp-setup__backup-actions">
          <button type="button" class="btn btn--xs btn--ghost" data-action="print-backups">
            Print codes
          </button>
          <button type="button" class="btn btn--xs btn--ghost" data-action="copy-backups">
            Copy all codes
          </button>
        </div>

        <label class="totp-setup__confirm-row">
          <input type="checkbox" id="totp-confirm-saved" class="totp-setup__confirm-check">
          <span>I have saved these backup codes in a secure location</span>
        </label>

        <div class="totp-setup__footer">
          <button type="button" class="btn btn--primary" id="totp-finish-btn" disabled>
            Enable two-factor authentication
          </button>
        </div>
      </div>
    `,
    onMount(panel, close) {
      const confirmCheck = $('#totp-confirm-saved', panel);
      const finishBtn    = $('#totp-finish-btn',    panel);

      if (confirmCheck) {
        confirmCheck.addEventListener('change', () => {
          if (finishBtn) finishBtn.disabled = !confirmCheck.checked;
        });
      }

      panel.addEventListener('click', async (e) => {
        const action = e.target.closest('[data-action]')?.dataset.action;

        if (action === 'print-backups') {
          _printBackupCodes(plain, userId);
          return;
        }
        if (action === 'copy-backups') {
          try {
            await navigator.clipboard.writeText(plain.join('\n'));
            e.target.textContent = 'Copied!';
            setTimeout(() => { e.target.textContent = 'Copy all codes'; }, 2000);
          } catch {
            showToast('Copy failed — select the codes manually.', 'warning');
          }
          return;
        }

        if (e.target === finishBtn || e.target.closest('#totp-finish-btn')) {
          if (!confirmCheck?.checked) return;
          finishBtn.disabled = true;
          finishBtn.textContent = 'Saving…';
          try {
            const user = await Storage.users.get(userId);
            if (!user) throw new Error('User not found');
            await Storage.users.put({
              ...user,
              totpSecret:       secret,
              totpEnabled:      true,
              totpHashedBackups: hashed,
              totpLastUsedStep:  verifiedStep,
            });
            await Storage.audit.append({
              action: '2fa_enabled',
              user:   AUTH.getSession()?.name || 'system',
              desc:   `Two-factor authentication enabled for ${user.name}.`,
            });
            close();
            showToast('Two-factor authentication is now active.', 'success');
          } catch (err) {
            finishBtn.disabled   = false;
            finishBtn.textContent = 'Enable two-factor authentication';
            showToast('Failed to save 2FA settings: ' + (err.message || err), 'error');
          }
        }
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Manage: disable 2FA
// ---------------------------------------------------------------------------

async function _disable2FA(userId) {
  openModal({
    titleHtml: 'Disable two-factor authentication',
    size:      'sm',
    bodyHtml: `
      <p>
        This will remove two-factor authentication from this account.
        The account will be protected by PIN only.
      </p>
      <p class="text--muted">
        To re-enable 2FA later, go to Settings → Security → Two-factor
        authentication and run the setup wizard again.
      </p>
      <div class="modal__footer">
        <button type="button" class="btn btn--ghost" data-action="cancel">Cancel</button>
        <button type="button" class="btn btn--danger" data-action="confirm-disable">
          Disable 2FA
        </button>
      </div>
    `,
    onMount(panel, close) {
      panel.addEventListener('click', async (e) => {
        const action = e.target.closest('[data-action]')?.dataset.action;
        if (action === 'cancel') { close(); return; }
        if (action === 'confirm-disable') {
          const btn = e.target;
          btn.disabled    = true;
          btn.textContent = 'Disabling…';
          try {
            const user = await Storage.users.get(userId);
            if (!user) throw new Error('User not found');
            await Storage.users.put({
              ...user,
              totpSecret:        null,
              totpEnabled:       false,
              totpHashedBackups: [],
              totpLastUsedStep:  -1,
            });
            await Storage.audit.append({
              action: '2fa_disabled',
              user:   AUTH.getSession()?.name || 'system',
              desc:   `Two-factor authentication disabled for ${user.name}.`,
            });
            close();
            showToast('Two-factor authentication has been disabled.', 'success');
          } catch (err) {
            btn.disabled    = false;
            btn.textContent = 'Disable 2FA';
            showToast('Failed: ' + (err.message || err), 'error');
          }
        }
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Manage: regenerate backup codes
// ---------------------------------------------------------------------------

async function _regenBackupCodes(userId) {
  openModal({
    titleHtml: 'Regenerate backup codes',
    size:      'sm',
    bodyHtml: `
      <p>
        This will invalidate all existing backup codes and generate a fresh set of 8.
        Save the new codes immediately — they cannot be recovered later.
      </p>
      <div class="modal__footer">
        <button type="button" class="btn btn--ghost" data-action="cancel">Cancel</button>
        <button type="button" class="btn btn--primary" data-action="regen">Regenerate</button>
      </div>
    `,
    onMount(panel, close) {
      panel.addEventListener('click', async (e) => {
        const action = e.target.closest('[data-action]')?.dataset.action;
        if (action === 'cancel') { close(); return; }
        if (action === 'regen') {
          const btn = e.target;
          btn.disabled    = true;
          btn.textContent = 'Generating…';
          try {
            const { plain, hashed } = await TOTP.generateBackupCodes(8);
            const user = await Storage.users.get(userId);
            if (!user) throw new Error('User not found');
            await Storage.users.put({ ...user, totpHashedBackups: hashed });
            await Storage.audit.append({
              action: '2fa_backup_regen',
              user:   AUTH.getSession()?.name || 'system',
              desc:   `2FA backup codes regenerated for ${user.name}.`,
            });
            close();
            // Show the new codes
            _showNewBackupCodes(plain, userId);
          } catch (err) {
            btn.disabled    = false;
            btn.textContent = 'Regenerate';
            showToast('Failed: ' + (err.message || err), 'error');
          }
        }
      });
    },
  });
}

function _showNewBackupCodes(plain, userId) {
  openModal({
    titleHtml: 'New backup codes',
    size:      'md',
    bodyHtml: `
      <p class="text--warning">Save these now — they will not be shown again.</p>
      <div class="totp-setup__backup-grid">
        ${plain.map(c => `<code class="totp-setup__backup-code">${esc(c)}</code>`).join('')}
      </div>
      <div class="totp-setup__backup-actions">
        <button type="button" class="btn btn--xs btn--ghost" data-action="print-backups">Print codes</button>
        <button type="button" class="btn btn--xs btn--ghost" data-action="copy-backups">Copy all codes</button>
      </div>
    `,
    onMount(panel, close) {
      panel.addEventListener('click', async (e) => {
        const action = e.target.closest('[data-action]')?.dataset.action;
        if (action === 'print-backups') { _printBackupCodes(plain, userId); return; }
        if (action === 'copy-backups') {
          try {
            await navigator.clipboard.writeText(plain.join('\n'));
            e.target.textContent = 'Copied!';
            setTimeout(() => { e.target.textContent = 'Copy all codes'; }, 2000);
          } catch {
            showToast('Copy failed.', 'warning');
          }
        }
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Print backup codes
// ---------------------------------------------------------------------------

function _printBackupCodes(plain, userId) {
  const w = window.open('', '_blank', 'width=500,height=600');
  if (!w) { showToast('Pop-up blocked — allow pop-ups and try again.', 'warning'); return; }
  w.document.write(`<!DOCTYPE html><html><head>
    <title>QStore — 2FA Backup Codes</title>
    <style>
      body { font-family: monospace; padding: 2rem; }
      h1 { font-size: 1.2rem; margin-bottom: 0.5rem; }
      p  { font-size: 0.85rem; color: #555; margin-bottom: 1.5rem; }
      .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.75rem; }
      code { font-size: 1.1rem; letter-spacing: 0.1em; border: 1px solid #ccc;
             padding: 0.5rem 1rem; border-radius: 4px; }
      .footer { margin-top: 2rem; font-size: 0.75rem; color: #888; }
    </style>
  </head><body>
    <h1>QStore IMS — Two-factor authentication backup codes</h1>
    <p>Each code can be used once. Store in a secure location. Printed: ${new Date().toLocaleDateString()}.</p>
    <div class="grid">
      ${plain.map(c => `<code>${c}</code>`).join('')}
    </div>
    <div class="footer">These codes are linked to user ID: ${esc(userId)}</div>
  </body></html>`);
  w.document.close();
  w.print();
}
