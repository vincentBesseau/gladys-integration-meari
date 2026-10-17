// -----------------------------------------------------------------------------
// Fit a JPEG into the Gladys camera image budget (150 KB, `image/jpg;base64`).
//
// Event snapshots of the ieGeek cameras are usually 2K JPEGs well above the
// limit: decode, downscale (box filter) and re-encode with jpeg-js, a pure
// JavaScript codec (no native build in the multi-arch image).
// -----------------------------------------------------------------------------

import jpeg from 'jpeg-js';

const PREFIX = 'image/jpg;base64,';
// Mirror of the SDK's MAX_CAMERA_IMAGE_SIZE (not exported), applied by the
// SDK to the whole `image/jpg;base64,...` string.
const LIMIT = 150 * 1024;

/** Size of the final string sent to Gladys (prefix + base64). */
function encodedSize(buf) {
  return PREFIX.length + Math.ceil(buf.length / 3) * 4;
}

export function toDataUri(buf) {
  return `${PREFIX}${buf.toString('base64')}`;
}

/** Box-filter downscale of an RGBA frame by an integer factor. */
export function downscale({ width, height, data }, factor) {
  const w = Math.max(1, Math.floor(width / factor));
  const h = Math.max(1, Math.floor(height / factor));
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let dy = 0; dy < factor; dy += 1) {
        const sy = y * factor + dy;
        if (sy >= height) break;
        for (let dx = 0; dx < factor; dx += 1) {
          const sx = x * factor + dx;
          if (sx >= width) break;
          const i = (sy * width + sx) * 4;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          n += 1;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * Return a Gladys camera image string for a JPEG buffer, re-encoding it when
 * it exceeds the budget. Returns null when the JPEG cannot be made to fit.
 */
export function fitJpeg(buf) {
  if (encodedSize(buf) <= LIMIT) {
    return toDataUri(buf);
  }
  let frame;
  try {
    frame = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 160 });
  } catch {
    return null;
  }
  // Aim for ~1280 px wide first, then shrink until it fits.
  let factor = Math.max(1, Math.ceil(frame.width / 1280));
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const scaled = factor > 1 ? downscale(frame, factor) : frame;
    for (const quality of [75, 60, 45]) {
      const out = Buffer.from(jpeg.encode(scaled, quality).data);
      if (encodedSize(out) <= LIMIT) {
        return toDataUri(out);
      }
    }
    factor += 1;
  }
  return null;
}
