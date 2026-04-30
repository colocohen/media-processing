/**
 * VideoFrame — Raw video frame data class.
 * Mirrors the browser VideoFrame API (subset).
 *
 * Validates that data length matches format × width × height.
 */

import { i420ToRgba, rgbaToI420, rgb24ToI420, i420ToRgb24, nv12ToI420, i420ToNv12 } from './pixel_utils.js';
import VideoColorSpace from './video_color_space.js';
import { isBufferSource as _isBufferSource, toBuffer as _bufferSourceToBuffer } from './buffer_source.js';
import { domException as _domex } from './dom_exception.js';

// Bytes per pixel by format. For planar YUV formats this is the
// AVERAGE — actual layout: Y plane (W*H) + chroma plane(s) at the
// chroma subsampling rate.
//
//   I420 (4:2:0): Y=WH + U=WH/4 + V=WH/4         = 1.5 * WH
//   I422 (4:2:2): Y=WH + U=WH/2 + V=WH/2         = 2.0 * WH
//   I444 (4:4:4): Y=WH + U=WH   + V=WH           = 3.0 * WH
//   With alpha plane (suffix "A"): + 1.0 * WH for the alpha plane.
//
// I422 is common in broadcast/professional capture. I444 is needed
// for high-fidelity screen-share (especially text, where 4:2:0 chroma
// subsampling causes color fringing on small text). Both were listed
// as W3C VideoFrame.format values but rejected by our constructor —
// MP-34. Adding them is purely a table extension; pixel conversion
// for these formats can be added later as needed.
var FORMAT_BPP = {
  // 4:2:0 chroma subsampling
  'I420':    1.5,
  'YUV420P': 1.5,
  'I420A':   2.5,
  'NV12':    1.5,
  // 4:2:2 chroma subsampling (added MP-34)
  'I422':    2.0,
  'I422A':   3.0,
  // 4:4:4 chroma subsampling (added MP-34)
  'I444':    3.0,
  'I444A':   4.0,
  // Packed RGB
  'RGBA':    4,
  'RGBX':    4,
  'RGB24':   3,
  'BGRA':    4,
  'BGRX':    4,
};

/**
 * @param {object} init
 * @param {Buffer|Uint8Array} init.data
 * @param {string} init.format          — 'I420', 'NV12', 'RGBA', 'RGB24'
 * @param {number} init.codedWidth
 * @param {number} init.codedHeight
 * @param {number} init.timestamp       — PTS in microseconds
 * @param {number} [init.duration]
 */
/**
 * VideoFrame — Browser-compatible constructor.
 *
 * Forms:
 *   new VideoFrame(data, init)     — browser: data=Buffer, init={format,codedWidth,...}
 *   new VideoFrame(otherFrame)     — clone from another VideoFrame
 *   new VideoFrame(init)           — convenience: init.data = Buffer
 */
function VideoFrame(dataOrInit, initArg) {
  // Form: VideoFrame(otherFrame) or VideoFrame(otherFrame, overrides)
  if (dataOrInit instanceof VideoFrame) {
    if (dataOrInit._closed) throw _domex('Source VideoFrame is closed', 'InvalidStateError');
    var src = dataOrInit;
    var over = initArg || {};
    var copy = Buffer.allocUnsafe(src.data.length);
    src.data.copy(copy);
    dataOrInit = {
      data: copy, format: over.format || src.format,
      codedWidth: src.codedWidth, codedHeight: src.codedHeight,
      displayWidth: over.displayWidth || src.displayWidth,
      displayHeight: over.displayHeight || src.displayHeight,
      visibleRect: over.visibleRect || src.visibleRect,
      colorSpace: over.colorSpace || src.colorSpace,
      timestamp: (typeof over.timestamp === 'number') ? over.timestamp : src.timestamp,
      duration: over.duration || src.duration,
    };
  }
  // Form: VideoFrame(data, init) — browser standard. Accept any
  // BufferSource per W3C VideoFrame spec (ArrayBuffer / TypedArray /
  // DataView / Buffer), not just Buffer/Uint8Array (MP-34).
  else if (initArg && _isBufferSource(dataOrInit)) {
    initArg.data = _bufferSourceToBuffer(dataOrInit);
    dataOrInit = initArg;
  }

  var init = dataOrInit;
  if (!init) throw new TypeError('VideoFrame: init required');
  // Normalize init.data through the same coercion used above.
  if (!Buffer.isBuffer(init.data)) {
    if (!_isBufferSource(init.data)) {
      throw new TypeError(
        'VideoFrame: data must be a BufferSource ' +
        '(Buffer, ArrayBuffer, TypedArray, or DataView)'
      );
    }
    init.data = _bufferSourceToBuffer(init.data);
  }
  if (!init.codedWidth || !init.codedHeight) {
    throw new TypeError('VideoFrame: codedWidth and codedHeight required');
  }

  var format = init.format || 'I420';
  var bpp = FORMAT_BPP[format];
  if (!bpp) {
    throw new TypeError('VideoFrame: unsupported format "' + format + '". Supported: ' + Object.keys(FORMAT_BPP).join(', '));
  }

  var expectedSize = Math.floor(init.codedWidth * init.codedHeight * bpp);
  if (init.data.length !== expectedSize) {
    throw new RangeError(
      'VideoFrame: data length ' + init.data.length +
      ' does not match ' + format + ' ' + init.codedWidth + 'x' + init.codedHeight +
      ' (expected ' + expectedSize + ' bytes)'
    );
  }

  this.data = init.data;
  this.format = format;
  this.codedWidth = init.codedWidth;
  this.codedHeight = init.codedHeight;
  this.codedRect = { x: 0, y: 0, width: init.codedWidth, height: init.codedHeight };
  this.displayWidth = init.displayWidth || init.codedWidth;
  this.displayHeight = init.displayHeight || init.codedHeight;
  this.visibleRect = init.visibleRect || {
    x: 0, y: 0, width: init.codedWidth, height: init.codedHeight,
  };
  this.colorSpace = new VideoColorSpace(init.colorSpace);
  this.timestamp = (typeof init.timestamp === 'number') ? init.timestamp : 0;
  this.duration = init.duration || 0;
  this.byteLength = this.data.length;
  this._closed = false;
}

VideoFrame.prototype.allocationSize = function (options) {
  var fmt = (options && options.format) || this.format;
  var bpp = FORMAT_BPP[fmt];
  if (!bpp) return this.data ? this.data.length : 0;
  return Math.floor(this.codedWidth * this.codedHeight * bpp);
};

/**
 * Copy frame data to destination buffer, optionally converting format.
 * Returns a Promise for browser API compatibility.
 *
 * @param {Buffer|Uint8Array} destination
 * @param {object} [options] — { format: 'RGBA' | 'I420' | ... }
 * @returns {Promise<{ offset, stride }[]>} — layout per plane
 */
VideoFrame.prototype.copyTo = function (destination, options) {
  if (this._closed) return Promise.reject(_domex('VideoFrame is closed', 'InvalidStateError'));
  try {
    var layout = this._copyToSync(destination, options);
    return Promise.resolve(layout);
  } catch (e) {
    return Promise.reject(e);
  }
};

/** Sync version for internal use. */
VideoFrame.prototype._copyToSync = function (destination, options) {
  if (this._closed) throw _domex('VideoFrame is closed', 'InvalidStateError');

  // Resolve destination to a Buffer view per MP-34 BufferSource rule.
  // The previous code only accepted Buffer/Uint8Array; W3C requires
  // any AllowSharedBufferSource.
  if (!_isBufferSource(destination)) {
    throw new TypeError(
      'VideoFrame.copyTo: destination must be a BufferSource ' +
      '(Buffer, ArrayBuffer, TypedArray, or DataView)'
    );
  }
  var dst = _bufferSourceToBuffer(destination);

  var targetFmt = (options && options.format) || this.format;

  if (targetFmt === this.format) {
    // Same format — direct copy. Spec: throw if destination too small.
    if (dst.length < this.data.length) {
      throw new TypeError(
        'VideoFrame.copyTo: destination byte length (' + dst.length +
        ') is less than frame byte length (' + this.data.length + ')'
      );
    }
    this.data.copy(dst, 0, 0, this.data.length);
    return _layoutForFormat(targetFmt, this.codedWidth, this.codedHeight);
  }

  // Format conversion using pixel_utils
  var w = this.codedWidth, h = this.codedHeight;
  var converted = null;

  if (this.format === 'I420' && targetFmt === 'RGBA') {
    converted = _pixelConvert('i420ToRgba', this.data, w, h);
  } else if (this.format === 'RGBA' && targetFmt === 'I420') {
    converted = _pixelConvert('rgbaToI420', this.data, w, h);
  } else if (this.format === 'NV12' && targetFmt === 'I420') {
    converted = _pixelConvert('nv12ToI420', this.data, w, h);
  } else if (this.format === 'I420' && targetFmt === 'NV12') {
    converted = _pixelConvert('i420ToNv12', this.data, w, h);
  } else if (this.format === 'RGB24' && targetFmt === 'I420') {
    converted = _pixelConvert('rgb24ToI420', this.data, w, h);
  } else if (this.format === 'I420' && targetFmt === 'RGB24') {
    converted = _pixelConvert('i420ToRgb24', this.data, w, h);
  } else {
    throw new TypeError('VideoFrame.copyTo: unsupported conversion ' + this.format + ' → ' + targetFmt);
  }

  if (converted) {
    if (dst.length < converted.length) {
      throw new TypeError(
        'VideoFrame.copyTo: destination byte length (' + dst.length +
        ') is less than converted byte length (' + converted.length + ')'
      );
    }
    converted.copy(dst, 0, 0, converted.length);
  }
  return _layoutForFormat(targetFmt, w, h);
};

VideoFrame.prototype.clone = function () {
  if (this._closed) throw _domex('VideoFrame is closed', 'InvalidStateError');
  var copy = Buffer.allocUnsafe(this.data.length);
  this.data.copy(copy);
  return new VideoFrame({
    data: copy,
    format: this.format,
    codedWidth: this.codedWidth,
    codedHeight: this.codedHeight,
    displayWidth: this.displayWidth,
    displayHeight: this.displayHeight,
    visibleRect: this.visibleRect,
    colorSpace: this.colorSpace,
    timestamp: this.timestamp,
    duration: this.duration,
  });
};

VideoFrame.prototype.close = function () {
  this._closed = true;
  this.data = null;
  this.byteLength = 0;
};

// ── Helpers ──

var _converters = {
  i420ToRgba: i420ToRgba, rgbaToI420: rgbaToI420,
  rgb24ToI420: rgb24ToI420, i420ToRgb24: i420ToRgb24,
  nv12ToI420: nv12ToI420, i420ToNv12: i420ToNv12,
};

function _pixelConvert(name, data, w, h) {
  var fn = _converters[name];
  if (!fn) return null;
  var bpp = FORMAT_BPP[_converterOutputFmt[name]] || 4;
  var outSize = Math.floor(w * h * bpp);
  var dst = { data: Buffer.allocUnsafe(outSize), width: w, height: h };
  fn({ data: data, width: w, height: h }, dst);
  return dst.data;
}

var _converterOutputFmt = {
  i420ToRgba: 'RGBA', rgbaToI420: 'I420',
  rgb24ToI420: 'I420', i420ToRgb24: 'RGB24',
  nv12ToI420: 'I420', i420ToNv12: 'NV12',
};

function _layoutForFormat(fmt, w, h) {
  if (fmt === 'I420' || fmt === 'YUV420P') {
    var ySize = w * h;
    var uvSize = (w >> 1) * (h >> 1);
    return [
      { offset: 0, stride: w },
      { offset: ySize, stride: w >> 1 },
      { offset: ySize + uvSize, stride: w >> 1 },
    ];
  }
  if (fmt === 'I420A') {
    var yS = w * h;
    var uvS = (w >> 1) * (h >> 1);
    return [
      { offset: 0, stride: w },
      { offset: yS, stride: w >> 1 },
      { offset: yS + uvS, stride: w >> 1 },
      { offset: yS + uvS * 2, stride: w },  // alpha
    ];
  }
  if (fmt === 'NV12') {
    return [
      { offset: 0, stride: w },
      { offset: w * h, stride: w },
    ];
  }
  // 4:2:2 chroma subsampling — chroma planes are half-width, full-height.
  if (fmt === 'I422') {
    var ySz422 = w * h;
    var uvSz422 = (w >> 1) * h;
    return [
      { offset: 0, stride: w },
      { offset: ySz422, stride: w >> 1 },
      { offset: ySz422 + uvSz422, stride: w >> 1 },
    ];
  }
  if (fmt === 'I422A') {
    var yS422a = w * h;
    var uvS422a = (w >> 1) * h;
    return [
      { offset: 0, stride: w },
      { offset: yS422a, stride: w >> 1 },
      { offset: yS422a + uvS422a, stride: w >> 1 },
      { offset: yS422a + uvS422a * 2, stride: w },     // alpha
    ];
  }
  // 4:4:4 chroma subsampling — chroma planes match Y plane.
  if (fmt === 'I444') {
    var ySz444 = w * h;
    return [
      { offset: 0, stride: w },
      { offset: ySz444, stride: w },
      { offset: ySz444 * 2, stride: w },
    ];
  }
  if (fmt === 'I444A') {
    var yS444a = w * h;
    return [
      { offset: 0, stride: w },
      { offset: yS444a, stride: w },
      { offset: yS444a * 2, stride: w },
      { offset: yS444a * 3, stride: w },               // alpha
    ];
  }
  if (fmt === 'RGBA' || fmt === 'BGRA') {
    return [{ offset: 0, stride: w * 4 }];
  }
  if (fmt === 'RGB24') {
    return [{ offset: 0, stride: w * 3 }];
  }
  return [{ offset: 0, stride: w }];
}

/**
 * Create DOMException if available (Node 17+), otherwise fallback Error.
 * Imported from dom_exception.js — see _domex import above.
 */

// ── BufferSource helpers (MP-34) imported from buffer_source.js ──

export default VideoFrame;
