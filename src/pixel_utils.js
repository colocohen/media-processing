/**
 * pixel_utils — Pure JS pixel format conversions.
 * No native bindings. Suitable for moderate frame sizes.
 *
 * ⚠ PERFORMANCE NOTE: For high-resolution / high-fps scenarios, prefer
 *   FFmpeg's built-in format conversion (-vf format=yuv420p) instead of
 *   these pure JS functions. These are useful for occasional conversion,
 *   thumbnail generation, or when FFmpeg is not in the pipeline.
 *
 * I420 layout: Y(w*h) + U(w/2 * h/2) + V(w/2 * h/2)
 * NV12 layout: Y(w*h) + interleaved UV(w * h/2)
 */

/**
 * Convert I420 to RGBA.
 * @param {object} src — { data, width, height }
 * @param {object} dst — { data, width, height }
 */
function i420ToRgba(src, dst) {
  var w = src.width, h = src.height;
  var Y = src.data, out = dst.data;
  var uOff = w * h;
  var vOff = uOff + ((w * h) >> 2);
  var uvW = w >> 1;

  for (var y = 0; y < h; y++) {
    var yRow = y * w;
    var uvRow = (y >> 1) * uvW;
    for (var x = 0; x < w; x++) {
      var yv = Y[yRow + x];
      var uv = Y[uOff + uvRow + (x >> 1)];
      var vv = Y[vOff + uvRow + (x >> 1)];
      var c = yv - 16, d = uv - 128, e = vv - 128;
      var p = (yRow + x) << 2;
      out[p]     = c * 298 + e * 409 + 128 >> 8;
      out[p + 1] = c * 298 - d * 100 - e * 208 + 128 >> 8;
      out[p + 2] = c * 298 + d * 516 + 128 >> 8;
      out[p + 3] = 255;
      // Clamp
      if (out[p] > 255) out[p] = 255; else if (out[p] < 0) out[p] = 0;
      if (out[p+1] > 255) out[p+1] = 255; else if (out[p+1] < 0) out[p+1] = 0;
      if (out[p+2] > 255) out[p+2] = 255; else if (out[p+2] < 0) out[p+2] = 0;
    }
  }
}

/**
 * Convert RGBA to I420.
 */
function rgbaToI420(src, dst) {
  var w = src.width, h = src.height;
  var rgba = src.data, Y = dst.data;
  var uOff = w * h;
  var vOff = uOff + ((w * h) >> 2);
  var uvW = w >> 1;

  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var p = (y * w + x) << 2;
      var r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
      Y[y * w + x] = (66 * r + 129 * g + 25 * b + 128 >> 8) + 16;

      if ((y & 1) === 0 && (x & 1) === 0) {
        var idx = (y >> 1) * uvW + (x >> 1);
        Y[uOff + idx] = (-38 * r - 74 * g + 112 * b + 128 >> 8) + 128;
        Y[vOff + idx] = (112 * r - 94 * g - 18 * b + 128 >> 8) + 128;
      }
    }
  }
}

/**
 * Convert RGB24 to I420.
 */
function rgb24ToI420(src, dst) {
  var w = src.width, h = src.height;
  var rgb = src.data, Y = dst.data;
  var uOff = w * h, vOff = uOff + ((w * h) >> 2);
  var uvW = w >> 1;

  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var p = (y * w + x) * 3;
      var r = rgb[p], g = rgb[p + 1], b = rgb[p + 2];
      Y[y * w + x] = (66 * r + 129 * g + 25 * b + 128 >> 8) + 16;

      if ((y & 1) === 0 && (x & 1) === 0) {
        var idx = (y >> 1) * uvW + (x >> 1);
        Y[uOff + idx] = (-38 * r - 74 * g + 112 * b + 128 >> 8) + 128;
        Y[vOff + idx] = (112 * r - 94 * g - 18 * b + 128 >> 8) + 128;
      }
    }
  }
}

/**
 * Convert I420 to RGB24.
 */
function i420ToRgb24(src, dst) {
  var w = src.width, h = src.height;
  var Y = src.data, out = dst.data;
  var uOff = w * h, vOff = uOff + ((w * h) >> 2);
  var uvW = w >> 1;

  for (var y = 0; y < h; y++) {
    var yRow = y * w;
    var uvRow = (y >> 1) * uvW;
    for (var x = 0; x < w; x++) {
      var c = Y[yRow + x] - 16;
      var d = Y[uOff + uvRow + (x >> 1)] - 128;
      var e = Y[vOff + uvRow + (x >> 1)] - 128;
      var p = (yRow + x) * 3;
      out[p]     = c * 298 + e * 409 + 128 >> 8;
      out[p + 1] = c * 298 - d * 100 - e * 208 + 128 >> 8;
      out[p + 2] = c * 298 + d * 516 + 128 >> 8;
      if (out[p] > 255) out[p] = 255; else if (out[p] < 0) out[p] = 0;
      if (out[p+1] > 255) out[p+1] = 255; else if (out[p+1] < 0) out[p+1] = 0;
      if (out[p+2] > 255) out[p+2] = 255; else if (out[p+2] < 0) out[p+2] = 0;
    }
  }
}

/**
 * Convert NV12 to I420.
 */
function nv12ToI420(src, dst) {
  var w = src.width, h = src.height;
  var ySize = w * h, uvSize = (w * h) >> 2;
  src.data.copy(dst.data, 0, 0, ySize);  // Y plane
  for (var i = 0; i < uvSize; i++) {
    dst.data[ySize + i] = src.data[ySize + i * 2];           // U
    dst.data[ySize + uvSize + i] = src.data[ySize + i * 2 + 1]; // V
  }
}

/**
 * Convert I420 to NV12.
 */
function i420ToNv12(src, dst) {
  var w = src.width, h = src.height;
  var ySize = w * h, uvSize = (w * h) >> 2;
  src.data.copy(dst.data, 0, 0, ySize);  // Y plane
  for (var i = 0; i < uvSize; i++) {
    dst.data[ySize + i * 2] = src.data[ySize + i];               // U
    dst.data[ySize + i * 2 + 1] = src.data[ySize + uvSize + i];  // V
  }
}

export { i420ToRgba, rgbaToI420, rgb24ToI420, i420ToRgb24, nv12ToI420, i420ToNv12 };
