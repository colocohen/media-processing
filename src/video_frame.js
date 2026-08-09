/**
 * VideoFrame — Raw video frame data class.
 * Mirrors the browser VideoFrame API (subset).
 *
 * Validates that data length matches format × width × height.
 */

import { i420ToRgba, rgbaToI420, rgb24ToI420, i420ToRgb24, nv12ToI420, i420ToNv12 } from './pixel_utils.js';
import VideoColorSpace from './video_color_space.js';
import { isBufferSource as _isBufferSource, toUint8Array as _bufferSourceToBuffer } from './core/buffer_source.js';
import { domException as _domex } from './core/dom_exception.js';

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

    // Per W3C, `new VideoFrame(videoFrame, init)` references the SAME
    // media resource — VideoFrameInit carries only timestamp, duration,
    // visibleRect, displayWidth/Height, alpha, rotation and flip, none
    // of which touch pixels. Browsers implement it that way, so
    // re-wrapping a frame to override its timestamp costs nothing there.
    //
    // This used to deep-copy unconditionally, which made
    // hls_encoder.js's ptsUs-override path copy an entire frame per
    // frame — its comment reads "Shares the underlying buffer
    // (zero-copy)", which was true of the browser and not of this
    // implementation. Same false claim, same shape, as the one in
    // track_processor.js.
    //
    // The one case that genuinely needs a copy is `over.format`: a
    // format change is a non-spec extension here, and the converted
    // pixels cannot alias the source.
    var formatChanges = over.format && over.format !== src.format;
    if (!formatChanges) {
      dataOrInit = {
        _sharedResource: src._res,
        data: src.data, format: src.format,
        codedWidth: src.codedWidth, codedHeight: src.codedHeight,
        displayWidth: over.displayWidth || src.displayWidth,
        displayHeight: over.displayHeight || src.displayHeight,
        visibleRect: over.visibleRect || src.visibleRect,
        colorSpace: over.colorSpace || src.colorSpace,
        timestamp: (typeof over.timestamp === 'number') ? over.timestamp : src.timestamp,
        duration: over.duration || src.duration,
        rotation: (typeof over.rotation === 'number') ? over.rotation : src.rotation,
        flip: (over.flip !== undefined) ? !!over.flip : src.flip,
      };
      return _finishConstruction(this, dataOrInit);
    }

    // Format override: independent buffer required.
    var copy = new Uint8Array(src.data.length);
    copy.set(src.data);
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

  return _finishConstruction(this, dataOrInit);
}

/**
 * Shared construction tail. Split out so the copy-constructor's
 * zero-copy path can reach it directly without re-running the
 * argument-shape detection above.
 */
function _finishConstruction(self, dataOrInit) {
  var init = dataOrInit;
  if (!init) throw new TypeError('VideoFrame: init required');
  // Normalize init.data through the same coercion used above.
  if (!(init.data instanceof Uint8Array)) {
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

  // ── Shared, reference-counted pixel buffer ────────────────────────
  //
  // W3C describes VideoFrame's bytes as a "media resource" held by
  // reference: clone() produces a new VideoFrame pointing at the SAME
  // resource with the refcount raised, and the bytes are released only
  // when the last reference closes. Browsers implement exactly that,
  // which is why the spec can describe clone() as cheap.
  //
  // This implementation used to deep-copy on every clone(). That made
  // track_processor.js — which clones every single frame so a sibling
  // listener's close() cannot detach the queued one — cost a full frame
  // copy per frame: ~1.4 MB at 720p, about 42 MB/s of fresh allocations
  // at 30 fps, with the GC pauses to match. The comment there even
  // asserts "clone() is cheap — it just bumps the refcount", describing
  // the spec rather than what the code did.
  //
  // Refcounting preserves the property track_processor actually needs.
  // A sibling calling close() decrements but does not free while our
  // clone still holds a reference, so the queued frame stays readable.
  var res;
  if (init._sharedResource) {
    // Internal path used by clone(): adopt the existing resource.
    res = init._sharedResource;
    res.refs++;
  } else {
    res = { data: init.data, refs: 1 };
  }
  Object.defineProperty(self, '_res', {
    value: res, writable: true, enumerable: false, configurable: true,
  });

  // `data` stays a normal-looking property so every existing reader
  // (encoder stdin writes, ffplay_viewer, media_encoder) is unaffected.
  Object.defineProperty(self, 'data', {
    get: function () { return this._closed ? null : this._res.data; },
    enumerable: true, configurable: true,
  });

  self.format = format;
  self.codedWidth = init.codedWidth;
  self.codedHeight = init.codedHeight;
  self.codedRect = { x: 0, y: 0, width: init.codedWidth, height: init.codedHeight };
  self.displayWidth = init.displayWidth || init.codedWidth;
  self.displayHeight = init.displayHeight || init.codedHeight;
  self.visibleRect = init.visibleRect || {
    x: 0, y: 0, width: init.codedWidth, height: init.codedHeight,
  };
  self.colorSpace = new VideoColorSpace(init.colorSpace);
  self.timestamp = (typeof init.timestamp === 'number') ? init.timestamp : 0;
  self.duration = init.duration || 0;
  self.byteLength = res.data.length;
  self._closed = false;

  // rotation / flip — W3C VideoFrame attributes, previously absent
  // entirely. VideoEncoder needs them for the spec's [[active
  // orientation]] check (a mid-stream orientation change is a
  // DataError), and consumers read them to render correctly.
  self.rotation = (typeof init.rotation === 'number') ? init.rotation : 0;
  self.flip = !!init.flip;

  return self;
}

/**
 * Has this frame a real crop, i.e. a visibleRect smaller than or offset
 * from the coded rect? Full-frame rects are treated as "no crop" so the
 * overwhelmingly common case takes the fast path untouched.
 */
VideoFrame.prototype._hasCrop = function () {
  var v = this.visibleRect;
  if (!v) return false;
  return (v.x || 0) !== 0 || (v.y || 0) !== 0 ||
         v.width !== this.codedWidth || v.height !== this.codedHeight;
};

/**
 * allocationSize(options) — bytes needed for a copyTo() result.
 *
 * Sized from the VISIBLE rect, not the coded rect. Per W3C, copyTo()
 * copies the visible region by default, so an allocation based on coded
 * dimensions over-allocates for a cropped frame and, worse, disagrees
 * with what copyTo() writes.
 *
 * Until now visibleRect was decorative: the constructor stored it and
 * nothing read it. VideoEncoder now honours it (crop before scale), so
 * leaving copyTo/allocationSize on coded dimensions would mean the same
 * frame reports two different geometries depending on which consumer
 * asks — an inconsistency introduced by fixing the encoder, and closed
 * here.
 */
VideoFrame.prototype.allocationSize = function (options) {
  var fmt = (options && options.format) || this.format;
  var bpp = FORMAT_BPP[fmt];
  if (!bpp) return this.data ? this.data.length : 0;
  var v = this.visibleRect;
  var w = (v && v.width) || this.codedWidth;
  var h = (v && v.height) || this.codedHeight;
  return Math.floor(w * h * bpp);
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
    var needed = this.allocationSize({ format: targetFmt });
    if (dst.length < needed) {
      throw new TypeError(
        'VideoFrame.copyTo: destination byte length (' + dst.length +
        ') is less than the required ' + needed + ' bytes'
      );
    }
    if (!this._hasCrop()) {
      dst.set(this.data.subarray(0, this.data.length), 0);
      return _layoutForFormat(targetFmt, this.codedWidth, this.codedHeight);
    }
    var vr = this.visibleRect;
    _cropInto(dst, this.data, targetFmt, this.codedWidth, this.codedHeight, vr);
    return _layoutForFormat(targetFmt, vr.width, vr.height);
  }

  // Format conversion using pixel_utils.
  //
  // The converters operate on whole planes and have no notion of a
  // sub-rect. Rather than silently returning the UNCROPPED image in a
  // buffer the caller sized for the cropped one — which would look like
  // working code and produce shifted pixels — refuse explicitly. Crop
  // first (copyTo in the source format), then convert.
  if (this._hasCrop()) {
    throw new TypeError(
      'VideoFrame.copyTo: cropping (visibleRect) combined with format ' +
      'conversion ' + this.format + ' \u2192 ' + targetFmt + ' is not supported. ' +
      'Copy in the source format first, then convert.'
    );
  }
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
    dst.set(converted.subarray(0, converted.length), 0);
  }
  return _layoutForFormat(targetFmt, w, h);
};

/**
 * clone() — new VideoFrame over the SAME pixel buffer, refcount + 1.
 *
 * O(1) and allocation-free apart from the wrapper object, matching the
 * spec and matching what callers already assume. The bytes survive
 * until every clone (and the original) has been closed.
 */
VideoFrame.prototype.clone = function () {
  if (this._closed) throw _domex('VideoFrame is closed', 'InvalidStateError');
  return new VideoFrame({
    _sharedResource: this._res,
    data: this._res.data,
    format: this.format,
    codedWidth: this.codedWidth,
    codedHeight: this.codedHeight,
    displayWidth: this.displayWidth,
    displayHeight: this.displayHeight,
    visibleRect: this.visibleRect,
    colorSpace: this.colorSpace,
    timestamp: this.timestamp,
    duration: this.duration,
    rotation: this.rotation,
    flip: this.flip,
  });
};

/**
 * close() — drop this reference. The buffer is released only when the
 * last outstanding reference closes.
 *
 * Idempotent: a second close() on the same VideoFrame is a no-op rather
 * than a double-decrement, so one over-eager caller cannot free a
 * buffer another clone is still reading.
 */
VideoFrame.prototype.close = function () {
  if (this._closed) return;
  this._closed = true;
  this.byteLength = 0;
  var res = this._res;
  if (res) {
    res.refs--;
    if (res.refs <= 0) res.data = null;
  }
};

/** Outstanding references to this frame's buffer. Non-standard; for tests. */
Object.defineProperty(VideoFrame.prototype, '_refCount', {
  get: function () { return this._res ? this._res.refs : 0; },
});

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
  var dst = { data: new Uint8Array(outSize), width: w, height: h };
  fn({ data: data, width: w, height: h }, dst);
  return dst.data;
}

var _converterOutputFmt = {
  i420ToRgba: 'RGBA', rgbaToI420: 'I420',
  rgb24ToI420: 'I420', i420ToRgb24: 'RGB24',
  nv12ToI420: 'I420', i420ToNv12: 'NV12',
};

/**
 * Copy the visible sub-rect out of a full-frame buffer, plane by plane.
 *
 * Chroma planes are subsampled, so the rect must be scaled per plane:
 * 4:2:0 halves both axes, 4:2:2 halves width only, 4:4:4 and packed RGB
 * use it as-is. Odd offsets on a subsampled plane are rounded down to
 * the chroma grid — the alternative is resampling chroma, which copyTo
 * has no business doing.
 */
function _cropInto(dst, src, fmt, codedW, codedH, rect) {
  var planes = _planeSpecs(fmt, codedW, codedH);
  var dstOff = 0;
  for (var p = 0; p < planes.length; p++) {
    var sp = planes[p];
    var x = Math.floor((rect.x || 0) / sp.subX);
    var y = Math.floor((rect.y || 0) / sp.subY);
    var w = Math.floor(rect.width / sp.subX);
    var h = Math.floor(rect.height / sp.subY);
    for (var row = 0; row < h; row++) {
      var from = sp.offset + (y + row) * sp.stride + x * sp.pixBytes;
      dst.set(src.subarray(from, from + w * sp.pixBytes), dstOff);
      dstOff += w * sp.pixBytes;
    }
  }
}

/**
 * Plane geometry per format: byte offset, row stride, per-pixel bytes,
 * and the chroma subsampling factors that map a luma rect onto it.
 */
function _planeSpecs(fmt, w, h) {
  var y = { offset: 0, stride: w, pixBytes: 1, subX: 1, subY: 1 };
  var ySize = w * h;
  switch (fmt) {
    case 'I420': case 'YUV420P': {
      var c = (w >> 1) * (h >> 1);
      return [y,
        { offset: ySize,     stride: w >> 1, pixBytes: 1, subX: 2, subY: 2 },
        { offset: ySize + c, stride: w >> 1, pixBytes: 1, subX: 2, subY: 2 }];
    }
    case 'I420A': {
      var ca = (w >> 1) * (h >> 1);
      return [y,
        { offset: ySize,          stride: w >> 1, pixBytes: 1, subX: 2, subY: 2 },
        { offset: ySize + ca,     stride: w >> 1, pixBytes: 1, subX: 2, subY: 2 },
        { offset: ySize + ca * 2, stride: w,      pixBytes: 1, subX: 1, subY: 1 }];
    }
    case 'NV12':
      // Interleaved UV: one plane, two bytes per chroma sample pair.
      return [y, { offset: ySize, stride: w, pixBytes: 2, subX: 2, subY: 2 }];
    case 'I422': {
      var c422 = (w >> 1) * h;
      return [y,
        { offset: ySize,        stride: w >> 1, pixBytes: 1, subX: 2, subY: 1 },
        { offset: ySize + c422, stride: w >> 1, pixBytes: 1, subX: 2, subY: 1 }];
    }
    case 'I422A': {
      var c422a = (w >> 1) * h;
      return [y,
        { offset: ySize,             stride: w >> 1, pixBytes: 1, subX: 2, subY: 1 },
        { offset: ySize + c422a,     stride: w >> 1, pixBytes: 1, subX: 2, subY: 1 },
        { offset: ySize + c422a * 2, stride: w,      pixBytes: 1, subX: 1, subY: 1 }];
    }
    case 'I444':
      return [y,
        { offset: ySize,     stride: w, pixBytes: 1, subX: 1, subY: 1 },
        { offset: ySize * 2, stride: w, pixBytes: 1, subX: 1, subY: 1 }];
    case 'I444A':
      return [y,
        { offset: ySize,     stride: w, pixBytes: 1, subX: 1, subY: 1 },
        { offset: ySize * 2, stride: w, pixBytes: 1, subX: 1, subY: 1 },
        { offset: ySize * 3, stride: w, pixBytes: 1, subX: 1, subY: 1 }];
    case 'RGBA': case 'RGBX': case 'BGRA': case 'BGRX':
      return [{ offset: 0, stride: w * 4, pixBytes: 4, subX: 1, subY: 1 }];
    case 'RGB24':
      return [{ offset: 0, stride: w * 3, pixBytes: 3, subX: 1, subY: 1 }];
    default:
      return [y];
  }
}

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
