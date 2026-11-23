/**
 * pixel_utils — Pure JS pixel format conversions.
 * No native bindings. Suitable for moderate frame sizes.
 *
 * ⚠ PERFORMANCE NOTE: For high-resolution / high-fps scenarios, prefer
 *   FFmpeg's built-in format conversion (-vf format=yuv420p) instead of
 *   these pure JS functions. These are useful for occasional conversion,
 *   thumbnail generation, or when FFmpeg is not in the pipeline.
 *
 * Colour math: BT.601, limited ("TV") range — Y 16..235, U/V 16..240 —
 * which is what FFmpeg's swscale assumes for untagged yuv420p and what
 * every caller in this library produces. There is no colorSpace option.
 *
 * Plane geometry comes from core/frame_size.js (chroma is
 * ceil(w/2) x ceil(h/2)):
 *   I420: Y(w*h) + U(cw*ch) + V(cw*ch)
 *   NV12: Y(w*h) + interleaved UV(2*cw*ch)
 * Before, every function here used FLOORED chroma (w >> 1, w*h >> 2):
 * for a 3x3 frame the "V plane" started at 9+2=11, inside the real U
 * plane (9..12), so reds came out of the blue samples, and the last
 * chroma column/row was never read or written.
 */

import { planeSpecs } from './core/frame_size.js';

// Clamp to 0..255 BEFORE storing. The old code stored first and clamped
// by reading the element back — but a Uint8Array store already wraps
// modulo 256, so the read-back value is always in range and the clamp
// never fired: Y235/U128/V240 (R = 434) came out as R=178, and
// Y16/U128/V16 (R = -180) as R=77, instead of 255 and 0.
function clamp8(v) {
  return v < 0 ? 0 : (v > 255 ? 255 : v);
}

function _chromaLayout(fmt, w, h) {
  var p = planeSpecs(fmt, w, h);
  return { cw: Math.ceil(w / 2), ch: Math.ceil(h / 2), uOff: p[1].offset, vOff: fmt === 'NV12' ? p[1].offset + 1 : p[2].offset };
}

// I420 → packed RGB(A); bpp = 4 (RGBA, alpha 255) or 3 (RGB24).
function _i420ToPacked(src, dst, bpp) {
  var w = src.width, h = src.height;
  var Y = src.data, out = dst.data;
  var L = _chromaLayout('I420', w, h);
  var uOff = L.uOff, vOff = L.vOff, uvW = L.cw;

  for (var y = 0; y < h; y++) {
    var yRow = y * w;
    var uvRow = (y >> 1) * uvW;
    for (var x = 0; x < w; x++) {
      var c = Y[yRow + x] - 16;
      var d = Y[uOff + uvRow + (x >> 1)] - 128;
      var e = Y[vOff + uvRow + (x >> 1)] - 128;
      var p = (yRow + x) * bpp;
      out[p]     = clamp8(c * 298 + e * 409 + 128 >> 8);
      out[p + 1] = clamp8(c * 298 - d * 100 - e * 208 + 128 >> 8);
      out[p + 2] = clamp8(c * 298 + d * 516 + 128 >> 8);
      if (bpp === 4) out[p + 3] = 255;
    }
  }
}

// Packed RGB(A) → I420. Chroma is the rounded average of the (up to)
// 2x2 block it covers; it used to be the top-left pixel only, so a
// 1-pixel red/blue line on an odd row or column vanished from chroma.
function _packedToI420(src, dst, bpp) {
  var w = src.width, h = src.height;
  var rgb = src.data, Y = dst.data;
  var L = _chromaLayout('I420', w, h);
  var uOff = L.uOff, vOff = L.vOff, uvW = L.cw;

  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var p = (y * w + x) * bpp;
      var r = rgb[p], g = rgb[p + 1], b = rgb[p + 2];
      Y[y * w + x] = (66 * r + 129 * g + 25 * b + 128 >> 8) + 16;
    }
  }
  for (var cy = 0; cy < L.ch; cy++) {
    for (var cx = 0; cx < uvW; cx++) {
      var sr = 0, sg = 0, sb = 0, n = 0;
      for (var dy = 0; dy < 2; dy++) {
        var yy = cy * 2 + dy;
        if (yy >= h) break;
        for (var dx = 0; dx < 2; dx++) {
          var xx = cx * 2 + dx;
          if (xx >= w) break;
          var q = (yy * w + xx) * bpp;
          sr += rgb[q]; sg += rgb[q + 1]; sb += rgb[q + 2]; n++;
        }
      }
      var ar = (sr + (n >> 1)) / n | 0, ag = (sg + (n >> 1)) / n | 0, ab = (sb + (n >> 1)) / n | 0;
      var idx = cy * uvW + cx;
      Y[uOff + idx] = clamp8((-38 * ar - 74 * ag + 112 * ab + 128 >> 8) + 128);
      Y[vOff + idx] = clamp8((112 * ar - 94 * ag - 18 * ab + 128 >> 8) + 128);
    }
  }
}

/**
 * Convert I420 to RGBA.
 * @param {object} src — { data, width, height }
 * @param {object} dst — { data, width, height }
 */
function i420ToRgba(src, dst) { _i420ToPacked(src, dst, 4); }

/** Convert RGBA to I420. */
function rgbaToI420(src, dst) { _packedToI420(src, dst, 4); }

/** Convert RGB24 to I420. */
function rgb24ToI420(src, dst) { _packedToI420(src, dst, 3); }

/** Convert I420 to RGB24. */
function i420ToRgb24(src, dst) { _i420ToPacked(src, dst, 3); }

/**
 * Convert NV12 to I420.
 */
function nv12ToI420(src, dst) {
  var w = src.width, h = src.height;
  var ySize = w * h;
  var I = _chromaLayout('I420', w, h);
  var uvSize = I.cw * I.ch;
  dst.data.set(src.data.subarray(0, ySize), 0);  // Y plane
  for (var i = 0; i < uvSize; i++) {
    dst.data[I.uOff + i] = src.data[ySize + i * 2];      // U
    dst.data[I.vOff + i] = src.data[ySize + i * 2 + 1];  // V
  }
}

/**
 * Convert I420 to NV12.
 */
function i420ToNv12(src, dst) {
  var w = src.width, h = src.height;
  var ySize = w * h;
  var I = _chromaLayout('I420', w, h);
  var uvSize = I.cw * I.ch;
  dst.data.set(src.data.subarray(0, ySize), 0);  // Y plane
  for (var i = 0; i < uvSize; i++) {
    dst.data[ySize + i * 2] = src.data[I.uOff + i];      // U
    dst.data[ySize + i * 2 + 1] = src.data[I.vOff + i];  // V
  }
}

export { i420ToRgba, rgbaToI420, rgb24ToI420, i420ToRgb24, nv12ToI420, i420ToNv12 };
