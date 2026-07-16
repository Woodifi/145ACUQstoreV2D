// =============================================================================
// QStore IMS v2 — QR code scanner
// =============================================================================
// Opens a modal with a live camera preview and continuously decodes frames
// via jsQR. On detecting a `QSTORE:<item.id>` code, stops the camera and
// calls the provided onFound(itemId) callback.
//
// getUserMedia requires a secure context. Chrome treats file:// as secure;
// Firefox and Safari do too for locally-opened files. The app's primary
// delivery channel (dist/qstore.html opened directly) therefore works.
// If the user opens it over plain HTTP (no TLS), getUserMedia will throw
// NotSupportedError and we surface a clear message.
//
// SCAN LOOP
//   requestAnimationFrame drives the loop. Each tick: draw the video frame
//   to a hidden canvas, read ImageData, pass to jsQR. On a match that
//   starts with 'QSTORE:', extract the item ID and hand off. The loop is
//   cancelled and the camera stopped before calling onFound, so the modal
//   can close without a race between an in-flight tick and the unmount.
//
// CLEANUP
//   Camera tracks are stopped in the onClose handler regardless of how the
//   modal is dismissed (Escape, backdrop click, scan success, page unmount).
//   The module-level state is fully reset on each openQRScanModal() call so
//   the same module can be used multiple times per session without leaks.
// =============================================================================

import jsQR from 'jsqr';
import { openModal } from './modal.js';
import { esc } from './util.js';

const QSTORE_PREFIX = 'QSTORE:';

/**
 * Parse a QStore QR code payload. Returns the item ID or null.
 * Exported so test-qr.mjs can verify the parse logic without DOM.
 */
export function parseQStoreCode(text) {
  if (typeof text !== 'string') return null;
  if (!text.startsWith(QSTORE_PREFIX)) return null;
  const id = text.slice(QSTORE_PREFIX.length).trim();
  return id || null;
}

/**
 * Open the QR scan modal.
 *
 * @param {Function} onFound  Called with the decoded item ID string when a
 *                            QStore code is successfully decoded. The camera
 *                            is already stopped and the modal already closed
 *                            before this is called.
 * @returns {{ close: Function }}  The modal handle, in case the caller wants
 *                                 to close it programmatically (e.g. on page
 *                                 unmount).
 */
export function openQRScanModal(onFound) {
  let _stream    = null;
  let _animFrame = null;
  let _scanning  = false;

  const _stopCamera = () => {
    _scanning = false;
    if (_animFrame) { cancelAnimationFrame(_animFrame); _animFrame = null; }
    if (_stream) {
      _stream.getTracks().forEach((t) => t.stop());
      _stream = null;
    }
  };

  const handle = openModal({
    titleHtml: '⌖ Scan QR label',
    size:      'md',
    onClose:   _stopCamera,
    bodyHtml: `
      <div class="qrscan">
        <p class="qrscan__status" data-target="scan-status">Starting camera…</p>
        <div class="qrscan__viewport">
          <video class="qrscan__video"
                 data-target="scan-video"
                 autoplay playsinline muted></video>
          <div class="qrscan__overlay">
            <div class="qrscan__reticle"></div>
          </div>
        </div>
        <canvas data-target="scan-canvas" hidden></canvas>
        <p class="qrscan__hint">Point the camera at a QStore QR code label</p>
      </div>
    `,

    onMount(panel, close) {
      const videoEl  = panel.querySelector('[data-target="scan-video"]');
      const statusEl = panel.querySelector('[data-target="scan-status"]');
      const canvas   = panel.querySelector('[data-target="scan-canvas"]');
      const ctx      = canvas.getContext('2d');

      const _tick = () => {
        if (!_scanning) return;
        // Video isn't ready yet — keep waiting.
        if (videoEl.readyState < videoEl.HAVE_ENOUGH_DATA) {
          _animFrame = requestAnimationFrame(_tick);
          return;
        }
        canvas.width  = videoEl.videoWidth;
        canvas.height = videoEl.videoHeight;
        ctx.drawImage(videoEl, 0, 0);
        const img  = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(img.data, img.width, img.height, {
          inversionAttempts: 'dontInvert',
        });
        if (code) {
          const itemId = parseQStoreCode(code.data);
          if (itemId) {
            _stopCamera();
            close();
            onFound(itemId);
            return;
          }
          // Decoded a QR code but not a QStore one — keep scanning.
        }
        _animFrame = requestAnimationFrame(_tick);
      };

      // Camera startup is async; run it detached so onMount can return
      // synchronously (required by modal.js).
      (async () => {
        if (!navigator.mediaDevices?.getUserMedia) {
          statusEl.textContent =
            'Camera not available — this browser or context does not support getUserMedia.';
          return;
        }
        try {
          _stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' } },
          });
          videoEl.srcObject = _stream;
          await videoEl.play();
          _scanning = true;
          statusEl.textContent = 'Scanning… hold the label steady in the frame.';
          _animFrame = requestAnimationFrame(_tick);
        } catch (err) {
          if (err.name === 'NotAllowedError') {
            statusEl.textContent =
              'Camera access denied. Allow camera permission in your browser and try again.';
          } else if (err.name === 'NotFoundError') {
            statusEl.textContent = 'No camera found on this device.';
          } else if (err.name === 'NotSupportedError') {
            statusEl.textContent =
              'Camera not supported in this context (requires HTTPS or file://).';
          } else {
            statusEl.textContent = `Camera error: ${err.message || err.name}`;
          }
        }
      })();
    },
  });

  return handle;
}
