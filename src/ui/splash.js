// =============================================================================
// QStore IMS v2 — Launch splash screen
// =============================================================================
// showSplash() mounts a fullscreen overlay immediately on boot.
// Returns { wait, setContent, dismiss }
//   wait        — Promise that resolves after DURATION ms (the minimum display time)
//   setContent  — call once storage is ready to inject the logo / unit name
//   dismiss     — fades out and removes the element (called after wait + boot done)
// =============================================================================

const DURATION = 5000; // ms

export function showSplash() {
  const startTime = Date.now();

  const el = document.createElement('div');
  el.className = 'splash';
  el.innerHTML = `
    <div class="splash__body">
      <div class="splash__logo-wrap" data-target="splash-logo-wrap">
        <!-- logo or unit name injected by setContent() -->
      </div>
    </div>
    <div class="splash__footer">
      <span class="splash__loading-text">Loading</span><span class="splash__dots"></span>
      <span class="splash__count-label">&nbsp;&nbsp;Starting in <span data-target="splash-count">5</span>…</span>
    </div>
  `;
  document.body.appendChild(el);

  // Animated ellipsis
  const dotsEl = el.querySelector('.splash__dots');
  let dotCount = 0;
  const dotsTimer = setInterval(() => {
    dotCount = (dotCount + 1) % 4;
    dotsEl.textContent = '.'.repeat(dotCount);
  }, 350);

  // Countdown — updates every second, stops at 0
  const countEl = el.querySelector('[data-target="splash-count"]');
  const countTimer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const remaining = Math.max(0, Math.ceil((DURATION - (Date.now() - startTime)) / 1000));
    if (countEl) countEl.textContent = remaining;
    if (remaining <= 0) clearInterval(countTimer);
  }, 200); // poll at 200ms for smooth display

  // Resolves after DURATION regardless of boot speed
  const wait = new Promise((resolve) => setTimeout(resolve, DURATION));

  /**
   * Inject unit logo and/or name once storage is available.
   * @param {{ logo?: string|null, name?: string, code?: string }} opts
   */
  const setContent = ({ logo = null, name = '', code = '' } = {}) => {
    const wrap = el.querySelector('[data-target="splash-logo-wrap"]');
    if (!wrap) return;
    if (logo) {
      wrap.innerHTML = `<img class="splash__logo" src="${logo}" alt="${name || 'Unit logo'}">`;
    } else if (name) {
      wrap.innerHTML = `
        <div class="splash__unit-name">${_esc(name)}</div>
        ${code ? `<div class="splash__unit-code">${_esc(code)}</div>` : ''}
      `;
    } else {
      wrap.innerHTML = `<div class="splash__app-name">Q-STORE IMS</div>`;
    }
  };

  const dismiss = () => {
    clearInterval(dotsTimer);
    clearInterval(countTimer);
    el.classList.add('splash--out');
    setTimeout(() => { if (el.parentNode) el.remove(); }, 500);
  };

  return { wait, setContent, dismiss };
}

function _esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
