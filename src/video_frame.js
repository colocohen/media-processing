/**
 * VideoFrame — W3C WebCodecs VideoFrame (§9.4).
 *
 * Constructors:
 *   new VideoFrame(data, init)        — W3C: data a BufferSource, init a
 *                                       VideoFrameBufferInit
 *   new VideoFrame(videoFrame, init?) — W3C: a new reference to the same
 *                                       pixels, with init (VideoFrameInit)
 *                                       overriding timing / rect / orientation
 *   new VideoFrame(init)              — non-W3C convenience: init.data
 *
 * The frame's pixels ("media resource") are kept tightly packed at the
 * coded size (core/frame_size.js), shared and reference-counted between a
 * frame and its clones; `data` exposes them (non-W3C, read by the
 * encoders).
 *
 * Non-W3C extensions, kept on purpose: the formats RGB24 (packed 8-bit
 * RGB) and YUV420P (an alias of I420); copyTo() to RGB24, and the
 * conversions RGBA → I420, RGB24 → I420, NV12 → I420 and I420 → NV12 (W3C
 * copyTo converts only to RGBA / RGBX / BGRA / BGRX, else
 * NotSupportedError); copyTo() with options.format equal to the frame's
 * own format (W3C: NotSupportedError unless it is an RGB format); and
 * new VideoFrame(frame, { format }) relabelling a copy of the pixels.
 */

import { rgbaToI420, rgb24ToI420, nv12ToI420, i420ToNv12 } from './pixel_utils.js';
import VideoColorSpace from './video_color_space.js';
import { isBufferSource as _isBufferSource, toUint8Array as _bufferSourceToBuffer } from './core/buffer_source.js';
import { domException as _domex } from './core/dom_exception.js';
import { planeSpecs, formatPlanes } from './core/frame_size.js';
import { enforceRange } from './core/webidl.js';

var RGB_FORMATS = { RGBA: 1, RGBX: 1, BGRA: 1, BGRX: 1 };
var U32_MAX = 4294967295;

// The non-W3C conversions copyTo keeps (source → target, by the source's
// canonical name; YUV420P is I420).
var EXT_CONVERSIONS = {
  'RGBA>I420': rgbaToI420, 'RGB24>I420': rgb24ToI420,
  'NV12>I420': nv12ToI420, 'I420>NV12': i420ToNv12,
};

function _canonical(fmt) { return fmt === 'YUV420P' ? 'I420' : fmt; }
function _isRgbFormat(fmt) { return !!RGB_FORMATS[fmt] || fmt === 'RGB24'; }
function _bitDepth(fmt) { return /P10$/.test(fmt) ? 10 : (/P12$/.test(fmt) ? 12 : 8); }
function _hasAlphaPlane(fmt) { return /^I4(20|22|44)A/.test(fmt); }

/** W3C "equivalent opaque format": the format without its alpha. */
function _opaqueFormat(fmt) {
  if (fmt === 'RGBA') return 'RGBX';
  if (fmt === 'BGRA') return 'BGRX';
  if (_hasAlphaPlane(fmt)) return fmt.slice(0, 4) + fmt.slice(5);
  return fmt;
}

function _absent(v) { return v === undefined || v === null; }

// ── WebIDL conversions ──────────────────────────────────────────────

function _format(v, what) {
  if (typeof v !== 'string' || !formatPlanes(v)) {
    throw new TypeError(what + ': unsupported format "' + v + '"');
  }
  return v;
}

/** DOMRectInit: unrestricted doubles, missing members 0. */
function _rectInit(r, what) {
  if (r === null || typeof r !== 'object') throw new TypeError(what + ' must be a DOMRectInit');
  var n = function (k) { return r[k] === undefined ? 0 : Number(r[k]); };
  return { x: n('x'), y: n('y'), width: n('width'), height: n('height') };
}

/** sequence<PlaneLayout>: each offset and stride a required [EnforceRange] unsigned long. */
function _layoutInit(l, what) {
  if (l === null || typeof l !== 'object' || typeof l[Symbol.iterator] !== 'function') {
    throw new TypeError(what + ': layout must be a sequence of PlaneLayout');
  }
  return Array.from(l).map(function (p, i) {
    if (p === null || typeof p !== 'object') throw new TypeError(what + ': layout[' + i + '] must be a PlaneLayout');
    if (_absent(p.offset)) throw new TypeError(what + ': layout[' + i + '].offset is required');
    if (_absent(p.stride)) throw new TypeError(what + ': layout[' + i + '].stride is required');
    return {
      offset: enforceRange(p.offset, 'unsigned long', what + ': layout[' + i + '].offset'),
      stride: enforceRange(p.stride, 'unsigned long', what + ': layout[' + i + '].stride'),
    };
  });
}

/** A WebIDL `double` (NaN / Infinity are a TypeError). */
function _double(v, what) {
  var x = Number(v);
  if (!Number.isFinite(x)) throw new TypeError(what + ' must be a finite number');
  return x;
}

/** A plain (not [EnforceRange]) WebIDL integer: NaN / Infinity → 0, the fraction dropped. */
function _plainInt(v, unsigned) {
  var x = Number(v);
  if (!Number.isFinite(x)) return 0;
  x = Math.trunc(x);
  if (x === 0) return 0;
  if (unsigned && x < 0) x += Math.pow(2, 64);
  return x;
}

// ── W3C algorithms ───────────────────────────────────────────────────

/**
 * W3C Parse Rotation: the nearest multiple of 90 (ties up), in [0, 360).
 * Exact for any double: `%` (fmod) is exact and rounding to a multiple of
 * 90 commutes with whole turns, so the work is on r in (-360, 360), where
 * r - 90k is exact too (Sterbenz). `r / 90` rounded as a whole was off for
 * huge values (1e17 gave 272; Number.MAX_VALUE 0 instead of 90).
 */
function _parseRotation(x) {
  var r = x % 360;
  var k = Math.floor(r / 90);
  var rem = r - 90 * k;
  // r / 90 is correctly rounded, so it can round UP to k (rem < 0) but
  // never below the true floor (rem >= 90 cannot happen).
  if (rem < 0) { k--; rem += 90; }
  if (rem >= 45) k++;
  var out = (k * 90) % 360;
  if (out < 0) out += 360;
  return out === 0 ? 0 : out;
}

/** RGBX / BGRX: the X byte of every pixel set to 255 (W3C leaves it unspecified; WPT, w3c/webcodecs#971). */
function _fillX(fmt, buf, offset, stride, rows, rowBytes) {
  if (fmt !== 'RGBX' && fmt !== 'BGRX') return;
  for (var row = 0; row < rows; row++) {
    for (var i = offset + row * stride + 3, end = offset + row * stride + rowBytes; i < end; i += 4) buf[i] = 255;
  }
}

/** W3C Add Rotations. */
function _addRotations(base, baseFlip, rotation) {
  var c = baseFlip ? base - rotation : base + rotation;
  var r = c - Math.floor(c / 360) * 360;
  return r === 0 ? 0 : r;
}

function _badRectMember(r) {
  return [r.x, r.y, r.width, r.height].some(function (v) { return !(v >= 0) || !Number.isFinite(v); });
}

/** W3C Verify Rect Offset Alignment. */
function _aligned(fmt, r) {
  var planes = formatPlanes(fmt);
  for (var i = 0; i < planes.length; i++) {
    if (r.x % planes[i][0] !== 0 || r.y % planes[i][1] !== 0) return false;
  }
  return true;
}

/** W3C Parse Visible Rect. */
function _parseVisibleRect(defaultRect, overrideRect, codedW, codedH, fmt, what) {
  var r = defaultRect;
  if (overrideRect !== undefined) {
    if (_badRectMember(overrideRect)) throw new TypeError(what + ': rect has a negative or non-finite member');
    if (overrideRect.width === 0 || overrideRect.height === 0) throw new TypeError(what + ': rect has a zero width or height');
    if (overrideRect.x + overrideRect.width > codedW) throw new TypeError(what + ': rect exceeds the coded width');
    if (overrideRect.y + overrideRect.height > codedH) throw new TypeError(what + ': rect exceeds the coded height');
    r = overrideRect;
  }
  if (!_aligned(fmt, r)) throw new TypeError(what + ': rect is not aligned to the sub-sampling of ' + fmt);
  return r;
}

/**
 * W3C Compute Layout and Allocation Size. Returns { computed: [{ sourceTop,
 * sourceHeight, sourceLeftBytes, sourceWidthBytes, destinationOffset,
 * destinationStride }], allocationSize }.
 */
function _computeLayout(rect, fmt, layout, what) {
  var planes = formatPlanes(fmt);
  if (layout !== undefined && layout.length !== planes.length) {
    throw new TypeError(what + ': layout has ' + layout.length + ' planes, ' + fmt + ' has ' + planes.length);
  }
  var x = Math.trunc(rect.x), y = Math.trunc(rect.y), w = Math.trunc(rect.width), h = Math.trunc(rect.height);
  var minSize = 0, computed = [], ends = [];
  for (var p = 0; p < planes.length; p++) {
    var sx = planes[p][0], sy = planes[p][1], sb = planes[p][2];
    var c = {
      sourceTop: Math.ceil(y / sy),
      sourceHeight: Math.ceil(h / sy),
      sourceLeftBytes: Math.floor(x / sx) * sb,
      sourceWidthBytes: Math.ceil(w / sx) * sb,
    };
    if (layout !== undefined) {
      if (layout[p].stride < c.sourceWidthBytes) {
        throw new TypeError(what + ': layout[' + p + '].stride ' + layout[p].stride +
          ' is less than the ' + c.sourceWidthBytes + ' bytes of a row');
      }
      c.destinationOffset = layout[p].offset;
      c.destinationStride = layout[p].stride;
    } else {
      c.destinationOffset = minSize;
      c.destinationStride = c.sourceWidthBytes;
    }
    var planeSize = c.destinationStride * c.sourceHeight;
    var planeEnd = planeSize + c.destinationOffset;
    if (planeSize > U32_MAX || planeEnd > U32_MAX) {
      throw new TypeError(what + ': plane ' + p + ' ends past the unsigned long range');
    }
    ends.push(planeEnd);
    minSize = Math.max(minSize, planeEnd);
    for (var e = 0; e < p; e++) {
      if (planeEnd <= computed[e].destinationOffset || ends[e] <= c.destinationOffset) continue;
      throw new TypeError(what + ': planes ' + e + ' and ' + p + ' overlap');
    }
    computed.push(c);
  }
  return { computed: computed, allocationSize: minSize };
}

/** W3C Pick Color Space. */
function _pickColorSpace(init, fmt) {
  if (init !== undefined) return new VideoColorSpace(init);
  if (_isRgbFormat(fmt)) return new VideoColorSpace({ primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'rgb', fullRange: true });
  return new VideoColorSpace({ primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false });
}

// ── VideoFrame ───────────────────────────────────────────────────────

function VideoFrame(source, init) {
  if (source instanceof VideoFrame) {
    if (init !== undefined && init !== null && !_absent(init.format) && init.format !== source._format) {
      // Non-W3C: a format override — a COPY of the pixels, relabelled.
      if (source._detached) throw _domex('Source VideoFrame is closed', 'InvalidStateError');
      var copy = new Uint8Array(source._res.data.length);
      copy.set(source._res.data);
      var bi = { format: init.format, codedWidth: source.codedWidth, codedHeight: source.codedHeight,
        timestamp: _absent(init.timestamp) ? source.timestamp : init.timestamp };
      var dur = _absent(init.duration) ? source.duration : init.duration;
      if (dur !== null) bi.duration = dur;
      ['visibleRect', 'rotation', 'flip', 'displayWidth', 'displayHeight', 'colorSpace'].forEach(function (k) {
        if (!_absent(init[k])) bi[k] = init[k];
      });
      return _fromBuffer(this, copy, bi);
    }
    return _fromFrame(this, source, init || {});
  }
  if (_isBufferSource(source)) {
    if (init === undefined || init === null) throw new TypeError('VideoFrame: init required');
    return _fromBuffer(this, source, init);
  }
  // Non-W3C convenience form: new VideoFrame({ data, format, ... }).
  if (source === undefined || source === null) throw new TypeError('VideoFrame: init required');
  return _fromBuffer(this, source.data, source);
}

function _required(init, k) {
  if (_absent(init[k])) throw new TypeError('VideoFrame: ' + k + ' is required');
  return init[k];
}

/** VideoFrame(data, VideoFrameBufferInit) — W3C constructor steps 1-22. */
function _fromBuffer(self, data, init) {
  var W = 'VideoFrame';
  if (!_isBufferSource(data)) {
    throw new TypeError('VideoFrame: data must be a BufferSource (Buffer, ArrayBuffer, TypedArray, or DataView)');
  }
  // IDL conversion, members in their (alphabetical) order.
  var codedHeight = enforceRange(_required(init, 'codedHeight'), 'unsigned long', 'VideoFrame: codedHeight');
  var codedWidth = enforceRange(_required(init, 'codedWidth'), 'unsigned long', 'VideoFrame: codedWidth');
  var csInit = _absent(init.colorSpace) ? undefined : init.colorSpace;
  if (csInit !== undefined) new VideoColorSpace(csInit);       // the enum checks
  var hasDH = !_absent(init.displayHeight), hasDW = !_absent(init.displayWidth);
  var displayHeight = hasDH ? enforceRange(init.displayHeight, 'unsigned long', 'VideoFrame: displayHeight') : 0;
  var displayWidth = hasDW ? enforceRange(init.displayWidth, 'unsigned long', 'VideoFrame: displayWidth') : 0;
  var duration = _absent(init.duration) ? null : enforceRange(init.duration, 'unsigned long long', 'VideoFrame: duration');
  var flip = !!init.flip;
  var format = _format(_required(init, 'format'), W);
  var layout = _absent(init.layout) ? undefined : _layoutInit(init.layout, W);
  var rotation = _absent(init.rotation) ? 0 : _double(init.rotation, 'VideoFrame: rotation');
  var timestamp = enforceRange(_required(init, 'timestamp'), 'long long', 'VideoFrame: timestamp');
  var visibleRect = _absent(init.visibleRect) ? undefined : _rectInit(init.visibleRect, 'VideoFrame: visibleRect');

  // valid VideoFrameBufferInit
  if (codedWidth === 0 || codedHeight === 0) throw new TypeError('VideoFrame: codedWidth and codedHeight must not be 0');
  if (visibleRect !== undefined) {
    if (_badRectMember(visibleRect)) throw new TypeError('VideoFrame: rect has a negative or non-finite member');
    if (visibleRect.y + visibleRect.height > codedHeight) throw new TypeError('VideoFrame: rect exceeds the coded height');
    if (visibleRect.x + visibleRect.width > codedWidth) throw new TypeError('VideoFrame: rect exceeds the coded width');
  }
  if (hasDW !== hasDH) throw new TypeError('VideoFrame: displayWidth and displayHeight must be given together');
  if (hasDW && (displayWidth === 0 || displayHeight === 0)) throw new TypeError('VideoFrame: displayWidth and displayHeight must not be 0');

  var full = { x: 0, y: 0, width: codedWidth, height: codedHeight };
  var parsed = _parseVisibleRect(full, visibleRect, codedWidth, codedHeight, format, W);
  var combined = _computeLayout(full, format, layout, W);
  var src = _bufferSourceToBuffer(data);
  if (src.length < combined.allocationSize) {
    throw new TypeError('VideoFrame: data is ' + src.length + ' bytes, the layout needs ' + combined.allocationSize);
  }

  var vw = Math.trunc(parsed.width), vh = Math.trunc(parsed.height);
  // A rect under one pixel wide or high passes Parse Visible Rect's "is 0"
  // check and truncates to an empty visible region (and a 0 display size);
  // refused like a 0 one.
  if (vw === 0 || vh === 0) throw new TypeError('VideoFrame: rect has a zero width or height');

  // The resource: a copy of the VISIBLE rectangle only, tightly packed —
  // W3C step "the User Agent MAY use visibleRect to copy only the visible
  // rectangle … reposition visibleRect", as Chrome does and WPT expects:
  // the coded size becomes the visible size, the rect sits at (0, 0). (x, y
  // are whole numbers here: the alignment check refuses a fractional one.)
  var vx = parsed.x, vy = parsed.y;
  var tight = planeSpecs(format, vw, vh);
  var planes = formatPlanes(format);
  var size = tight[tight.length - 1].offset + tight[tight.length - 1].stride * tight[tight.length - 1].rows;
  var res = new Uint8Array(size);
  for (var p = 0; p < tight.length; p++) {
    var c = combined.computed[p];
    var start = c.destinationOffset + (vy / planes[p][1]) * c.destinationStride + (vx / planes[p][0]) * planes[p][2];
    for (var row = 0; row < tight[p].rows; row++) {
      var from = start + row * c.destinationStride;
      res.set(src.subarray(from, from + tight[p].stride), tight[p].offset + row * tight[p].stride);
    }
  }
  _fillX(format, res, 0, tight[0].stride, tight[0].rows, tight[0].stride);
  codedWidth = vw; codedHeight = vh;

  rotation = _parseRotation(rotation);
  if (!hasDW) {
    if (rotation === 0 || rotation === 180) { displayWidth = vw; displayHeight = vh; }
    else { displayWidth = vh; displayHeight = vw; }
  }
  _assign(self, { data: res, refs: 1 }, {
    format: format, codedWidth: codedWidth, codedHeight: codedHeight,
    visible: { x: 0, y: 0, width: vw, height: vh },
    rotation: rotation, flip: flip, displayWidth: displayWidth, displayHeight: displayHeight,
    timestamp: timestamp, duration: duration, colorSpace: _pickColorSpace(csInit, format),
  });
  return self;
}

/** VideoFrame(videoFrame, VideoFrameInit) — W3C Initialize Frame From Other Frame. */
function _fromFrame(self, other, init) {
  var W = 'VideoFrame';
  // IDL conversion (VideoFrameInit), members in their order.
  var alpha = _absent(init.alpha) ? 'keep' : init.alpha;
  if (alpha !== 'keep' && alpha !== 'discard') throw new TypeError("VideoFrame: alpha must be 'keep' or 'discard'");
  var hasDH = !_absent(init.displayHeight), hasDW = !_absent(init.displayWidth);
  var displayHeight = hasDH ? enforceRange(init.displayHeight, 'unsigned long', 'VideoFrame: displayHeight') : 0;
  var displayWidth = hasDW ? enforceRange(init.displayWidth, 'unsigned long', 'VideoFrame: displayWidth') : 0;
  var hasDur = !_absent(init.duration);
  var duration = hasDur ? _plainInt(init.duration, true) : null;
  var flip = !!init.flip;
  var rotation = _absent(init.rotation) ? 0 : _double(init.rotation, 'VideoFrame: rotation');
  var hasTs = !_absent(init.timestamp);
  var timestamp = hasTs ? _plainInt(init.timestamp, false) : 0;
  var visibleRect = _absent(init.visibleRect) ? undefined : _rectInit(init.visibleRect, 'VideoFrame: visibleRect');

  if (other._detached) throw _domex('Source VideoFrame is closed', 'InvalidStateError');
  var format = alpha === 'discard' ? _opaqueFormat(other._format) : other._format;

  // Validate VideoFrameInit
  if (visibleRect !== undefined) {
    if (!_aligned(format, visibleRect)) throw new TypeError('VideoFrame: rect is not aligned to the sub-sampling of ' + format);
    if (_badRectMember(visibleRect)) throw new TypeError('VideoFrame: rect has a negative or non-finite member');
    if (visibleRect.width === 0 || visibleRect.height === 0) throw new TypeError('VideoFrame: rect has a zero width or height');
    if (visibleRect.y + visibleRect.height > other.codedHeight) throw new TypeError('VideoFrame: rect exceeds the coded height');
    if (visibleRect.x + visibleRect.width > other.codedWidth) throw new TypeError('VideoFrame: rect exceeds the coded width');
  }
  if (hasDW !== hasDH) throw new TypeError('VideoFrame: displayWidth and displayHeight must be given together');
  if (hasDW && (displayWidth === 0 || displayHeight === 0)) throw new TypeError('VideoFrame: displayWidth and displayHeight must not be 0');

  // Initialize Visible Rect, Orientation, and Display Size
  var defVis = other._visible;
  var vis = visibleRect !== undefined ? visibleRect : defVis;
  rotation = _parseRotation(rotation);
  var newRotation = _addRotations(other._rotation, other._flip, rotation);
  var newFlip = other._flip !== flip;
  if (!hasDW) {
    var ws, hs;
    if (other._rotation === 0 || other._rotation === 180) {
      ws = other._displayWidth / defVis.width; hs = other._displayHeight / defVis.height;
    } else {
      ws = other._displayHeight / defVis.width; hs = other._displayWidth / defVis.height;
    }
    var dw = Math.round(vis.width * ws), dh = Math.round(vis.height * hs);
    if (!(dw > 0) || !(dh > 0)) throw new TypeError('VideoFrame: the display size computes to 0');
    // W3C step 8.6 tests the init's `rotation`; read literally, re-wrapping
    // a 90°-rotated frame with no change swaps its display size back. dw/dh
    // are the unrotated display size, so the swap follows the frame's
    // combined [[rotation]] (newRotation) — the evident intent.
    if (newRotation === 0 || newRotation === 180) { displayWidth = dw; displayHeight = dh; }
    else { displayWidth = dh; displayHeight = dw; }
  }
  other._res.refs++;
  _assign(self, other._res, {
    format: format, codedWidth: other.codedWidth, codedHeight: other.codedHeight,
    visible: { x: vis.x, y: vis.y, width: vis.width, height: vis.height },
    rotation: newRotation, flip: newFlip, displayWidth: displayWidth, displayHeight: displayHeight,
    timestamp: hasTs ? timestamp : other.timestamp,
    duration: hasDur ? duration : other.duration,
    colorSpace: new VideoColorSpace(other.colorSpace.toJSON()),
  });
  return self;
}

/** The frame's slots, as plain attributes (W3C getters' values). */
function _assign(self, res, s) {
  Object.defineProperty(self, '_res', { value: res, writable: true, enumerable: false, configurable: true });
  Object.defineProperty(self, 'data', {
    get: function () { return this._detached ? null : this._res.data; },
    enumerable: true, configurable: true,
  });
  self._detached = false;
  self._format = s.format;
  self._visible = s.visible;
  self._rotation = s.rotation;
  self._flip = s.flip;
  self._displayWidth = s.displayWidth;
  self._displayHeight = s.displayHeight;
  self.format = s.format;
  self.codedWidth = s.codedWidth;
  self.codedHeight = s.codedHeight;
  self.codedRect = { x: 0, y: 0, width: s.codedWidth, height: s.codedHeight };
  self.visibleRect = { x: s.visible.x, y: s.visible.y, width: s.visible.width, height: s.visible.height };
  self.displayWidth = s.displayWidth;
  self.displayHeight = s.displayHeight;
  self.rotation = s.rotation;
  self.flip = s.flip;
  self.timestamp = s.timestamp;
  self.duration = s.duration;
  self.colorSpace = s.colorSpace;
  self.byteLength = res.data.length;
  // Non-enumerable mirror kept for code that read `_closed`.
  Object.defineProperty(self, '_closed', { get: function () { return this._detached; }, enumerable: false, configurable: true });
}

// ── allocationSize / copyTo ─────────────────────────────────────────

/** IDL conversion of VideoFrameCopyToOptions (members in order). */
function _copyOptionsInit(options, what) {
  if (_absent(options)) options = {};
  var cs = _absent(options.colorSpace) ? undefined : options.colorSpace;
  if (cs !== undefined && cs !== 'srgb' && cs !== 'display-p3') {
    throw new TypeError(what + ": colorSpace must be 'srgb' or 'display-p3'");
  }
  var format = _absent(options.format) ? undefined : _format(options.format, what);
  var layout = _absent(options.layout) ? undefined : _layoutInit(options.layout, what);
  var rect = _absent(options.rect) ? undefined : _rectInit(options.rect, what + ': rect');
  return { colorSpace: cs, format: format, layout: layout, rect: rect };
}

/** W3C Parse VideoFrameCopyToOptions (with the non-W3C conversions). */
function _parseCopyOptions(self, o, what) {
  var rect = _parseVisibleRect(self._visible, o.rect, self.codedWidth, self.codedHeight, self._format, what);
  var format = self._format, kind = 'copy';
  if (o.format !== undefined) {
    if (_isRgbFormat(o.format)) { format = o.format; kind = 'rgb'; }
    else if (_canonical(o.format) === _canonical(self._format)) { format = o.format; }
    else if (EXT_CONVERSIONS[_canonical(self._format) + '>' + _canonical(o.format)]) { format = o.format; kind = 'ext'; }
    else {
      throw _domex(what + ': unsupported conversion ' + self._format + ' → ' + o.format, 'NotSupportedError');
    }
  }
  if (kind === 'ext' && (Math.trunc(rect.x) !== 0 || Math.trunc(rect.y) !== 0 ||
      Math.trunc(rect.width) !== self.codedWidth || Math.trunc(rect.height) !== self.codedHeight)) {
    throw new TypeError(what + ': cropping (a rect smaller than the coded frame) combined with format conversion ' +
      self._format + ' → ' + format + ' is not supported. Copy in the source format first, then convert.');
  }
  return { rect: rect, format: format, kind: kind, colorSpace: o.colorSpace || 'srgb',
    combined: _computeLayout(rect, format, o.layout, what) };
}

VideoFrame.prototype.allocationSize = function (options) {
  var W = 'VideoFrame.allocationSize';
  var o = _copyOptionsInit(options, W);
  if (this._detached) throw _domex('VideoFrame is closed', 'InvalidStateError');
  return _parseCopyOptions(this, o, W).combined.allocationSize;
};

/**
 * W3C copyTo(destination, options): a Promise of the PlaneLayout of each
 * plane written.
 */
VideoFrame.prototype.copyTo = function (destination, options) {
  try {
    return Promise.resolve(this._copyToSync(destination, options));
  } catch (e) {
    return Promise.reject(e);
  }
};

/** copyTo, synchronously (internal callers). */
VideoFrame.prototype._copyToSync = function (destination, options) {
  var W = 'VideoFrame.copyTo';
  if (!_isBufferSource(destination)) {
    throw new TypeError(W + ': destination must be a BufferSource (Buffer, ArrayBuffer, TypedArray, or DataView)');
  }
  var o = _copyOptionsInit(options, W);
  if (this._detached) throw _domex('VideoFrame is closed', 'InvalidStateError');
  var p = _parseCopyOptions(this, o, W);
  var dst = _bufferSourceToBuffer(destination);
  if (dst.length < p.combined.allocationSize) {
    throw new TypeError(W + ': destination byte length (' + dst.length +
      ') is less than the required ' + p.combined.allocationSize + ' bytes');
  }
  var src = this._res.data, srcFmt = this._format, cw = this.codedWidth, ch = this.codedHeight;
  if (p.kind === 'rgb') {
    _toRgb(this, p.rect, p.format, p.colorSpace, dst, p.combined.computed[0]);
  } else {
    if (p.kind === 'ext') {
      var tmp = new Uint8Array(planeSpecs(p.format, cw, ch).reduce(function (a, s) { return a + s.stride * s.rows; }, 0));
      var conv = EXT_CONVERSIONS[_canonical(srcFmt) + '>' + _canonical(p.format)];
      conv({ data: src, width: cw, height: ch }, { data: tmp, width: cw, height: ch });
      src = tmp; srcFmt = p.format;
    }
    var specs = planeSpecs(srcFmt, cw, ch);
    for (var i = 0; i < specs.length; i++) {
      var c = p.combined.computed[i];
      var from = specs[i].offset + c.sourceTop * specs[i].stride + c.sourceLeftBytes;
      for (var row = 0; row < c.sourceHeight; row++) {
        var at = from + row * specs[i].stride;
        dst.set(src.subarray(at, at + c.sourceWidthBytes), c.destinationOffset + row * c.destinationStride);
      }
    }
    // An RGBX frame made from an RGBA one (alpha 'discard') shares its
    // pixels: its X bytes still hold the alpha.
    if (p.kind === 'copy') {
      var c0 = p.combined.computed[0];
      _fillX(p.format, dst, c0.destinationOffset, c0.destinationStride, c0.sourceHeight, c0.sourceWidthBytes);
    }
  }
  return p.combined.computed.map(function (c) { return { offset: c.destinationOffset, stride: c.destinationStride }; });
};

// ── Convert to RGB ───────────────────────────────────────────────────

// Kr, Kb of each VideoMatrixCoefficients (H.273).
var MATRIX_K = {
  bt709: [0.2126, 0.0722], bt470bg: [0.299, 0.114], smpte170m: [0.299, 0.114], 'bt2020-ncl': [0.2627, 0.0593],
};
// CIE xy of the R, G, B primaries (H.273); white is D65 for all of them.
var PRIMARIES_XY = {
  bt709: [0.64, 0.33, 0.30, 0.60, 0.15, 0.06],
  bt470bg: [0.64, 0.33, 0.29, 0.60, 0.15, 0.06],
  smpte170m: [0.630, 0.340, 0.310, 0.595, 0.155, 0.070],
  bt2020: [0.708, 0.292, 0.170, 0.797, 0.131, 0.046],
  smpte432: [0.680, 0.320, 0.265, 0.690, 0.150, 0.060],
};

function _inv3(m) {
  var a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5], g = m[6], h = m[7], i = m[8];
  var A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  var det = a * A + b * B + c * C;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
          B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
          C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

function _mul3(m, n) {
  var o = [];
  for (var r = 0; r < 3; r++) {
    for (var k = 0; k < 3; k++) o.push(m[r * 3] * n[k] + m[r * 3 + 1] * n[3 + k] + m[r * 3 + 2] * n[6 + k]);
  }
  return o;
}

/** RGB → XYZ of a set of primaries (D65 white). */
function _rgbToXyz(name) {
  var p = PRIMARIES_XY[name];
  var P = [p[0] / p[1], p[2] / p[3], p[4] / p[5],
           1, 1, 1,
           (1 - p[0] - p[1]) / p[1], (1 - p[2] - p[3]) / p[3], (1 - p[4] - p[5]) / p[5]];
  var wx = 0.3127, wy = 0.3290;
  var W = [wx / wy, 1, (1 - wx - wy) / wy];
  var I = _inv3(P);
  var S = [I[0] * W[0] + I[1] * W[1] + I[2] * W[2], I[3] * W[0] + I[4] * W[1] + I[5] * W[2], I[6] * W[0] + I[7] * W[1] + I[8] * W[2]];
  return [P[0] * S[0], P[1] * S[1], P[2] * S[2], P[3] * S[0], P[4] * S[1], P[5] * S[2], P[6] * S[0], P[7] * S[1], P[8] * S[2]];
}

function _clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
function _eotf(v) { return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
function _oetf(v) { return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055; }

/**
 * W3C Convert to RGB frame, over `rect` of the coded frame: YUV → R'G'B'
 * by the frame's matrix and range, then — when the frame's primaries are
 * not the target's (sRGB: BT.709, Display P3: SMPTE 432) — a primaries
 * conversion in linear light, both sides through the sRGB transfer (an
 * approximation: the source transfer is taken as SDR display-referred).
 */
function _toRgb(self, rect, target, targetCs, dst, c) {
  var fmt = self._format, src = self._res.data;
  var x0 = Math.trunc(rect.x), y0 = Math.trunc(rect.y), w = Math.trunc(rect.width), h = Math.trunc(rect.height);
  var cs = self.colorSpace;
  var srcPrim = cs.primaries || 'bt709';
  var dstPrim = targetCs === 'display-p3' ? 'smpte432' : 'bt709';
  var M = srcPrim === dstPrim ? null : _mul3(_inv3(_rgbToXyz(dstPrim)), _rgbToXyz(srcPrim));
  var specs = planeSpecs(fmt, self.codedWidth, self.codedHeight);
  var rgbSrc = _isRgbFormat(fmt);
  var bits = _bitDepth(fmt), wide = bits > 8;
  var maxv = Math.pow(2, bits) - 1, s = Math.pow(2, bits - 8), half = Math.pow(2, bits - 1);
  var full = cs.fullRange === true;
  var matrix = cs.matrix || 'bt709';
  var K = MATRIX_K[matrix];
  var alphaPlane = _hasAlphaPlane(fmt);
  var outBpp = target === 'RGB24' ? 3 : 4;
  var bgr = target === 'BGRA' || target === 'BGRX';
  var keepAlpha = target === 'RGBA' || target === 'BGRA';
  function sample(plane, px, py) {
    var sp = specs[plane];
    var off = sp.offset + py * sp.stride + px * sp.pixBytes;
    return wide ? (src[off] | (src[off + 1] << 8)) : src[off];
  }
  function ynorm(v) { return full ? v / maxv : (v - 16 * s) / (219 * s); }
  for (var row = 0; row < h; row++) {
    var py = y0 + row;
    var out = c.destinationOffset + row * c.destinationStride;
    for (var col = 0; col < w; col++) {
      var px = x0 + col;
      var r, g, b, a = 255;
      if (rgbSrc) {
        var o = specs[0].offset + py * specs[0].stride + px * specs[0].pixBytes;
        if (fmt === 'BGRA' || fmt === 'BGRX') { b = src[o]; g = src[o + 1]; r = src[o + 2]; }
        else { r = src[o]; g = src[o + 1]; b = src[o + 2]; }
        if (fmt === 'RGBA' || fmt === 'BGRA') a = src[o + 3];
        r /= 255; g /= 255; b /= 255;
      } else {
        var Y = sample(0, px, py), U, V;
        var cx = Math.floor(px / specs[1].subX), cy = Math.floor(py / specs[1].subY);
        if (fmt === 'NV12') {
          var uo = specs[1].offset + cy * specs[1].stride + cx * 2;
          U = src[uo]; V = src[uo + 1];
        } else {
          U = sample(1, cx, cy); V = sample(2, cx, cy);
        }
        if (alphaPlane) {
          var A = sample(3, px, py);
          // A 16-bit sample past the format's bit depth would store
          // modulo 256: clamped like the colour channels.
          a = wide ? Math.round(_clamp01(A / maxv) * 255) : A;
        }
        if (matrix === 'rgb') {
          g = ynorm(Y); b = ynorm(U); r = ynorm(V);
        } else {
          var yn = ynorm(Y);
          var cb = full ? (U - half) / maxv : (U - 128 * s) / (224 * s);
          var cr = full ? (V - half) / maxv : (V - 128 * s) / (224 * s);
          r = yn + 2 * (1 - K[0]) * cr;
          b = yn + 2 * (1 - K[1]) * cb;
          g = (yn - K[0] * r - K[1] * b) / (1 - K[0] - K[1]);
        }
      }
      if (M) {
        var lr = _eotf(_clamp01(r)), lg = _eotf(_clamp01(g)), lb = _eotf(_clamp01(b));
        r = _oetf(_clamp01(M[0] * lr + M[1] * lg + M[2] * lb));
        g = _oetf(_clamp01(M[3] * lr + M[4] * lg + M[5] * lb));
        b = _oetf(_clamp01(M[6] * lr + M[7] * lg + M[8] * lb));
      }
      var R = Math.round(_clamp01(r) * 255), G = Math.round(_clamp01(g) * 255), B = Math.round(_clamp01(b) * 255);
      var q = out + col * outBpp;
      if (bgr) { dst[q] = B; dst[q + 1] = G; dst[q + 2] = R; }
      else { dst[q] = R; dst[q + 1] = G; dst[q + 2] = B; }
      if (outBpp === 4) dst[q + 3] = keepAlpha ? a : 255;
    }
  }
}

// ── clone / close ────────────────────────────────────────────────────

/**
 * clone() — W3C Clone VideoFrame: a new VideoFrame over the SAME pixels
 * (refcount + 1), every attribute the same. O(1).
 */
VideoFrame.prototype.clone = function () {
  if (this._detached) throw _domex('VideoFrame is closed', 'InvalidStateError');
  var c = Object.create(VideoFrame.prototype);
  this._res.refs++;
  _assign(c, this._res, {
    format: this._format, codedWidth: this.codedWidth, codedHeight: this.codedHeight,
    visible: { x: this._visible.x, y: this._visible.y, width: this._visible.width, height: this._visible.height },
    rotation: this._rotation, flip: this._flip, displayWidth: this._displayWidth, displayHeight: this._displayHeight,
    timestamp: this.timestamp, duration: this.duration, colorSpace: new VideoColorSpace(this.colorSpace.toJSON()),
  });
  return c;
};

/**
 * close() — W3C Close VideoFrame: the reference dropped (the pixels are
 * released when the last one closes), format null, rects null, sizes and
 * rotation 0, flip false. Idempotent: a second close() does not drop
 * another clone's reference.
 */
VideoFrame.prototype.close = function () {
  if (this._detached) return;
  this._detached = true;
  var res = this._res;
  res.refs--;
  if (res.refs <= 0) res.data = null;
  this.format = null;
  this._format = null;
  this.codedWidth = 0;
  this.codedHeight = 0;
  this.codedRect = null;
  this.visibleRect = null;
  this._visible = { x: 0, y: 0, width: 0, height: 0 };
  this.displayWidth = this._displayWidth = 0;
  this.displayHeight = this._displayHeight = 0;
  this.rotation = this._rotation = 0;
  this.flip = this._flip = false;
  this.byteLength = 0;
};

/** Outstanding references to this frame's pixels. Non-standard; for tests. */
Object.defineProperty(VideoFrame.prototype, '_refCount', {
  get: function () { return this._res ? this._res.refs : 0; },
});

export default VideoFrame;
