// =============================================================================
// QStore IMS v2 — Blank forms
// =============================================================================
// One place to download every hand-completed form with nothing filled in.
//
// The list is BLANK_FORMS in pdf.js — this module renders it and never names a
// form itself, so a form added there appears here without an edit.
//
// A blank form reads no record (no loan, no item, no member), only unit
// branding. That is why it is offered to every role that can open Reports,
// including read-only: there is nothing in it to protect.
// =============================================================================

import * as Storage from '../storage.js';
import * as AUTH    from '../auth.js';
import { esc }       from './util.js';
import { showToast } from './toast.js';
import { BLANK_FORMS, generateBlankForm, downloadPdf } from '../pdf.js';

/** Markup for the list of blank forms, one download button each. */
export function blankFormsHtml() {
  return `
    <div class="blank-forms">
      <p class="form__hint">
        Printable copies of each form with nothing filled in, for completing by hand.
        A blank form contains no records — only your unit name and code.
      </p>
      <table class="ims-report__table">
        <tbody>
          ${BLANK_FORMS.map((f) => `
            <tr>
              <td><strong>${esc(f.label)}</strong><br>${esc(f.desc)}</td>
              <td>
                <button type="button" class="btn btn--ghost btn--sm"
                        data-blank-form="${esc(f.id)}">⎙ Download blank</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

/** Wire every [data-blank-form] button under `root`. */
export function wireBlankForms(root) {
  root.querySelectorAll('[data-blank-form]').forEach((btn) => {
    btn.addEventListener('click', () => downloadBlankForm(btn.dataset.blankForm));
  });
}

/** Generate one blank form, hand it to the browser, and record that it was printed. */
export async function downloadBlankForm(id) {
  const form = BLANK_FORMS.find((f) => f.id === id);
  try {
    const unit = await Storage.settings.getAll();
    downloadPdf(await generateBlankForm(id, { unit }));
    await Storage.audit.append({
      action: form.audit,
      user:   AUTH.getSession()?.name || 'unknown',
      desc:   `Blank form printed for hand completion: ${form.label}.`,
    });
  } catch (err) {
    showToast(`Could not print blank ${form ? form.label : 'form'}: ` + (err.message || err), 'error');
  }
}
