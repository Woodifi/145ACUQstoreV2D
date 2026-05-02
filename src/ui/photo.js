// =============================================================================
// QStore IMS v2 — Photo processing
// =============================================================================
// Take a File from a <input type="file"> or drag-drop, validate it as an
// image, scale-and-crop to 120x120 (cover-fit, centred), encode as JPEG at
// 78% quality, and return a Blob suitable for Storage.photos.put().
//
// Differences from v1 (line ~6893):
//   - Uses createImageBitmap() instead of FileReader→Image. Faster, simpler,
//     and avoids the data-URL round trip.
//   - Returns a Blob directly via canvas.toBlob() rather than a data URL.
//   - Same dimensions and quality (120×120 cover-crop, JPEG 0.78).
//
// IMAGE SIZE LIMITS
//   We accept up to 10MB of input file size. The output Blob is ~5–15kB
//   depending on content (120×120 JPEG). The original file is never stored.
//
// SAFARI / iOS NOTES
//   createImageBitmap is supported on all evergreen browsers including
//   Safari 15+. iOS Safari has historical bugs with very large source
//   images (>4096×4096 dimension) where the bitmap can come back blank.
//   We don't try to work around this — the output is small either way.
// =============================================================================

const OUTPUT_SIZE     = 120;
const OUTPUT_TYPE     = 'image/jpeg';
const OUTPUT_QUALITY  = 0.78;
const MAX_INPUT_BYTES = 10 * 1024 * 1024;

/**
 * Process an image File into a 120×120 cover-cropped JPEG Blob.
 *
 * @param {File} file
 * @returns {Promise<Blob>}
 * @throws {Error} with `.code` set to one of:
 *   'NOT_AN_IMAGE'   — file.type doesn't start with image/
 *   'TOO_LARGE'      — file.size > 10MB
 *   'DECODE_FAILED'  — createImageBitmap threw (corrupt or unsupported format)
 *   'ENCODE_FAILED'  — canvas.toBlob returned null (canvas tainted, OOM, etc.)
 */
export async function processItemPhoto(file) {
  if (!file || !file.type || !file.type.startsWith('image/')) {
    throw _err('NOT_AN_IMAGE', 'File is not an image.');
  }
  if (file.size > MAX_INPUT_BYTES) {
    const mb = (file.size / 1024 / 1024).toFixed(1);
    throw _err('TOO_LARGE', `Image is ${mb} MB. Maximum is 10 MB.`);
  }

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch (e) {
    throw _err('DECODE_FAILED', 'Could not decode image. The file may be corrupt or in an unsupported format.');
  }

  try {
    const canvas = document.createElement('canvas');
    canvas.width  = OUTPUT_SIZE;
    canvas.height = OUTPUT_SIZE;
    const ctx = canvas.getContext('2d');

    // Cover-crop: scale source so the smaller dimension fills 120, centre-crop the rest.
    const scale = Math.max(OUTPUT_SIZE / bitmap.width, OUTPUT_SIZE / bitmap.height);
    const sw = OUTPUT_SIZE / scale;
    const sh = OUTPUT_SIZE / scale;
    const sx = (bitmap.width  - sw) / 2;
    const sy = (bitmap.height - sh) / 2;
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);

    // canvas.toBlob is callback-based; promisify.
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, OUTPUT_TYPE, OUTPUT_QUALITY)
    );
    if (!blob) throw _err('ENCODE_FAILED', 'Image encoding failed. Try a different file.');
    return blob;
  } finally {
    // ImageBitmap holds a decoded raster; release it explicitly so we don't
    // wait on garbage collection.
    if (bitmap.close) bitmap.close();
  }
}

function _err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}
