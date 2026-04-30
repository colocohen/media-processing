/**
 * AudioData — Raw audio data class. Mirrors the browser AudioData API.
 *
 * Spec: https://www.w3.org/TR/webcodecs/#audiodata
 *
 * Supported formats per W3C:
 *   Interleaved: 'u8', 's16', 's32', 'f32'
 *   Planar:      'u8-planar', 's16-planar', 's32-planar', 'f32-planar'
 *
 * Internal storage: data is always a single Buffer. For interleaved
 * formats it's [s0_c0, s0_c1, ..., s1_c0, s1_c1, ...]. For planar
 * formats it's [s0_c0, s1_c0, ..., s0_c1, s1_c1, ...] (each channel's
 * samples are contiguous, then the next channel begins).
 *
 * @param {object} init
 * @param {BufferSource} init.data       — PCM data
 * @param {string} init.format           — see above
 * @param {number} init.sampleRate       — Hz
 * @param {number} init.numberOfChannels — channel count
 * @param {number} init.numberOfFrames   — samples per channel (REQUIRED per W3C)
 * @param {number} init.timestamp        — PTS in microseconds (REQUIRED)
 * @param {number} [init.duration]       — derived if absent
 */

import { isBufferSource as _isBufferSource, toBuffer as _toBuffer } from './buffer_source.js';
import { domException as _domex } from './dom_exception.js';

// Bytes per sample value, by format. Independent of planar/interleaved.
var FORMAT_BYTES = {
  'u8':         1, 's16':         2, 's32':         4, 'f32':         4,
  'u8-planar':  1, 's16-planar':  2, 's32-planar':  4, 'f32-planar':  4,
};

function _isPlanar(fmt) { return fmt && fmt.indexOf('-planar') > 0; }
function _baseFmt(fmt) {
  return fmt.replace('-planar', '');
}



function AudioData(init) {
  if (!init) throw new TypeError('AudioData: init required');
  if (!_isBufferSource(init.data)) {
    throw new TypeError(
      'AudioData: data must be a BufferSource ' +
      '(Buffer, ArrayBuffer, TypedArray, or DataView)'
    );
  }

  // W3C: timestamp is required. Allow 0 explicitly. Reject NaN/Infinity.
  if (typeof init.timestamp !== 'number' || !Number.isFinite(init.timestamp)) {
    throw new TypeError('AudioData: timestamp (microseconds) is required');
  }

  this.data = _toBuffer(init.data);
  this.format = init.format || 's16';
  if (!FORMAT_BYTES[this.format]) {
    throw new TypeError(
      'AudioData: unsupported format "' + this.format +
      '". Supported: ' + Object.keys(FORMAT_BYTES).join(', ')
    );
  }
  this.sampleRate = init.sampleRate || 48000;
  this.numberOfChannels = init.numberOfChannels || 1;
  this.timestamp = init.timestamp;

  // Derive numberOfFrames from data length if not provided.
  var bps = FORMAT_BYTES[this.format];
  this.numberOfFrames = init.numberOfFrames ||
    Math.floor(this.data.length / (this.numberOfChannels * bps));

  // Default duration: derived from frames + sampleRate
  this.duration = (typeof init.duration === 'number')
    ? init.duration
    : Math.round(this.numberOfFrames * 1e6 / this.sampleRate);

  this.byteLength = this.data.length;
  this._closed = false;
}

/**
 * allocationSize(options) — bytes needed to hold a copyTo() result.
 * Honors options.format, options.planeIndex, options.frameOffset,
 * options.frameCount per W3C.
 */
AudioData.prototype.allocationSize = function (options) {
  if (this._closed) throw _domex('AudioData is closed', 'InvalidStateError');
  options = options || {};

  var targetFmt = options.format || this.format;
  if (!FORMAT_BYTES[targetFmt]) {
    throw new TypeError('AudioData: unsupported target format "' + targetFmt + '"');
  }
  var targetBps = FORMAT_BYTES[targetFmt];
  var targetPlanar = _isPlanar(targetFmt);

  var frameOffset = options.frameOffset || 0;
  var frameCount = (options.frameCount != null)
    ? options.frameCount
    : Math.max(0, this.numberOfFrames - frameOffset);

  if (frameOffset < 0 || frameOffset > this.numberOfFrames) {
    throw new RangeError(
      'AudioData.allocationSize: frameOffset ' + frameOffset +
      ' out of range [0, ' + this.numberOfFrames + ']'
    );
  }
  if (frameCount < 0 || frameOffset + frameCount > this.numberOfFrames) {
    throw new RangeError(
      'AudioData.allocationSize: frameCount ' + frameCount +
      ' beyond remaining frames'
    );
  }

  // For planar target with planeIndex set, we copy ONE plane.
  // Otherwise we copy all channels (interleaved or all planes).
  if (targetPlanar && options.planeIndex != null) {
    return frameCount * targetBps;
  }
  return frameCount * this.numberOfChannels * targetBps;
};

/**
 * copyTo(destination, options) — copy frames into destination.
 *
 * Per W3C WebCodecs §4.5.5:
 *   - destination: BufferSource
 *   - options.planeIndex (REQUIRED for planar formats)
 *   - options.frameOffset (default 0)
 *   - options.frameCount (default = remaining frames)
 *   - options.format (default = this.format; conversion if differs)
 *
 * The previous implementation IGNORED options entirely and just copied
 * the whole raw .data buffer. This produced garbage when the caller
 * asked for a different format, a frame range, or a specific plane (MP-1).
 */
AudioData.prototype.copyTo = function (destination, options) {
  if (this._closed) return Promise.reject(_domex('AudioData is closed', 'InvalidStateError'));
  try {
    this._copyToSync(destination, options);
    return Promise.resolve();
  } catch (e) {
    return Promise.reject(e);
  }
};

AudioData.prototype._copyToSync = function (destination, options) {
  if (this._closed) throw _domex('AudioData is closed', 'InvalidStateError');
  options = options || {};

  if (!_isBufferSource(destination)) {
    throw new TypeError(
      'AudioData.copyTo: destination must be a BufferSource'
    );
  }
  var dst = _toBuffer(destination);

  var srcFmt = this.format;
  var dstFmt = options.format || srcFmt;
  if (!FORMAT_BYTES[dstFmt]) {
    throw new TypeError('AudioData.copyTo: unsupported target format "' + dstFmt + '"');
  }

  var frameOffset = options.frameOffset || 0;
  var frameCount = (options.frameCount != null)
    ? options.frameCount
    : Math.max(0, this.numberOfFrames - frameOffset);
  var planeIndex = options.planeIndex;

  if (frameOffset < 0 || frameOffset > this.numberOfFrames) {
    throw new RangeError('AudioData.copyTo: frameOffset out of range');
  }
  if (frameCount < 0 || frameOffset + frameCount > this.numberOfFrames) {
    throw new RangeError('AudioData.copyTo: frameCount out of range');
  }

  // Required allocation size — matches allocationSize() output.
  var needed = this.allocationSize({
    format: dstFmt,
    frameOffset: frameOffset,
    frameCount: frameCount,
    planeIndex: planeIndex,
  });
  if (dst.length < needed) {
    throw new RangeError(
      'AudioData.copyTo: destination too small — need ' +
      needed + ' bytes, got ' + dst.length
    );
  }

  // Same-format fast path
  if (srcFmt === dstFmt) {
    return _copySameFormat(this, dst, frameOffset, frameCount, planeIndex);
  }

  // Conversion path. We support cross-format and planar↔interleaved.
  return _copyWithConversion(this, dst, dstFmt, frameOffset, frameCount, planeIndex);
};

// ── Same-format copy (no conversion needed) ──
function _copySameFormat(self, dst, frameOffset, frameCount, planeIndex) {
  var fmt = self.format;
  var bps = FORMAT_BYTES[fmt];
  var ch = self.numberOfChannels;
  var planar = _isPlanar(fmt);

  if (planar && planeIndex != null) {
    // Extract one plane's slice. In planar layout, plane k starts at
    // offset k * numberOfFrames * bps.
    if (planeIndex < 0 || planeIndex >= ch) {
      throw new RangeError('AudioData.copyTo: planeIndex out of range');
    }
    var planeStart = planeIndex * self.numberOfFrames * bps;
    var srcOff = planeStart + frameOffset * bps;
    self.data.copy(dst, 0, srcOff, srcOff + frameCount * bps);
    return;
  }

  if (planar) {
    // Copy ALL planes contiguously to destination, each plane sliced
    // by [frameOffset, frameOffset+frameCount). Destination layout
    // mirrors source: plane 0 then plane 1 then ...
    var dstOff = 0;
    for (var k = 0; k < ch; k++) {
      var pStart = k * self.numberOfFrames * bps;
      var sOff = pStart + frameOffset * bps;
      self.data.copy(dst, dstOff, sOff, sOff + frameCount * bps);
      dstOff += frameCount * bps;
    }
    return;
  }

  // Interleaved: just slice [frameOffset, frameOffset+frameCount).
  var iOff = frameOffset * ch * bps;
  self.data.copy(dst, 0, iOff, iOff + frameCount * ch * bps);
}

// ── Conversion path ──
//
// Supported conversions (any of these directions):
//   - planar ↔ interleaved (same sample type)
//   - s16 ↔ f32 (rescale: int16 / 32768)
//   - s32 ↔ f32 (rescale: int32 / 2^31)
//   - u8 ↔ s16 (rescale: u8 - 128, ×256)
//
// The full cross-product is implemented through a 2-stage pipe:
//   1. Read source samples into a Float64 scratch (lossless).
//   2. Write to destination format with appropriate clamping.
//
// This is not the fastest possible path but it's small and correct.
function _copyWithConversion(self, dst, dstFmt, frameOffset, frameCount, planeIndex) {
  var srcFmt = self.format;
  var srcBase = _baseFmt(srcFmt);
  var dstBase = _baseFmt(dstFmt);
  var srcPlanar = _isPlanar(srcFmt);
  var dstPlanar = _isPlanar(dstFmt);
  var ch = self.numberOfChannels;

  // Determine which channel(s) to emit.
  var startCh, endCh;
  if (dstPlanar && planeIndex != null) {
    if (planeIndex < 0 || planeIndex >= ch) {
      throw new RangeError('AudioData.copyTo: planeIndex out of range');
    }
    startCh = planeIndex; endCh = planeIndex + 1;
  } else {
    startCh = 0; endCh = ch;
  }

  // For each (channel, frame), compute src sample value as Float64,
  // then write to dst at the appropriate position.
  for (var c = startCh; c < endCh; c++) {
    for (var f = 0; f < frameCount; f++) {
      var sample = _readSample(self.data, srcBase, srcPlanar,
                                c, frameOffset + f, ch, self.numberOfFrames);
      _writeSample(dst, dstBase, dstPlanar, sample,
                   c - startCh, f, endCh - startCh, frameCount);
    }
  }
}

function _readSample(buf, baseFmt, planar, ch, frameIdx, channels, totalFrames) {
  var bps = FORMAT_BYTES[baseFmt];
  var off = planar
    ? (ch * totalFrames * bps + frameIdx * bps)
    : (frameIdx * channels * bps + ch * bps);
  switch (baseFmt) {
    case 'u8':  return (buf[off] - 128) / 128;
    case 's16': return buf.readInt16LE(off) / 32768;
    case 's32': return buf.readInt32LE(off) / 2147483648;
    case 'f32': return buf.readFloatLE(off);
  }
  return 0;
}

function _writeSample(buf, baseFmt, planar, value, ch, frameIdx, channels, totalFrames) {
  var bps = FORMAT_BYTES[baseFmt];
  var off = planar
    ? (ch * totalFrames * bps + frameIdx * bps)
    : (frameIdx * channels * bps + ch * bps);
  switch (baseFmt) {
    case 'u8':
      buf[off] = Math.max(0, Math.min(255, Math.round(value * 128 + 128)));
      break;
    case 's16':
      buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value * 32768))), off);
      break;
    case 's32':
      buf.writeInt32LE(Math.max(-2147483648, Math.min(2147483647,
                                  Math.round(value * 2147483648))), off);
      break;
    case 'f32':
      buf.writeFloatLE(Math.max(-1, Math.min(1, value)), off);
      break;
  }
}

AudioData.prototype.clone = function () {
  if (this._closed) throw _domex('AudioData is closed', 'InvalidStateError');
  var copy = Buffer.allocUnsafe(this.data.length);
  this.data.copy(copy);
  return new AudioData({
    data: copy,
    format: this.format,
    sampleRate: this.sampleRate,
    numberOfChannels: this.numberOfChannels,
    numberOfFrames: this.numberOfFrames,
    timestamp: this.timestamp,
    duration: this.duration,
  });
};

AudioData.prototype.close = function () {
  this._closed = true;
  this.data = null;
  this.byteLength = 0;
};

export default AudioData;
