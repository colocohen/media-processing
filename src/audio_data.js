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
 */

import { isBufferSource as _isBufferSource, toUint8Array as _toBuffer } from './core/buffer_source.js';
import { takeBufferSource } from './core/take_buffer.js';
var _hasBuffer = typeof Buffer !== 'undefined';
import { domException as _domex } from './core/dom_exception.js';
import { readS16LE, readS32LE, readF32LE, writeU16LE, writeU32LE, writeF32LE } from './core/bytes.js';
import { enforceRange } from './core/webidl.js';

// Bytes per sample value, by format. Independent of planar/interleaved.
var FORMAT_BYTES = {
  'u8':         1, 's16':         2, 's32':         4, 'f32':         4,
  'u8-planar':  1, 's16-planar':  2, 's32-planar':  4, 'f32-planar':  4,
};

function _isPlanar(fmt) { return fmt && fmt.indexOf('-planar') > 0; }
function _baseFmt(fmt) {
  return fmt.replace('-planar', '');
}



function _required(init, key) {
  if (init[key] === undefined || init[key] === null) {
    throw new TypeError('AudioData: ' + key + ' is required');
  }
  return init[key];
}

// W3C AudioDataInit: format, sampleRate, numberOfFrames, numberOfChannels,
// timestamp and data are ALL required, and "check if valid AudioDataInit"
// refuses a sampleRate <= 0 and 0 frames or channels (TypeError). The JS
// made up a format (s16), a rate (48000), a channel count (1) and a frame
// count (from the data's length) when they were missing, and accepted 0 /
// negative ones — a caller's mistake became a different signal instead of
// an error. The members are converted in the IDL's (alphabetical) order.
function AudioData(init) {
  if (!init) throw new TypeError('AudioData: init required');
  if (!_isBufferSource(init.data)) {
    throw new TypeError(
      'AudioData: data must be a BufferSource ' +
      '(Buffer, ArrayBuffer, TypedArray, or DataView)'
    );
  }
  var format = _required(init, 'format');
  if (!FORMAT_BYTES[format]) {
    throw new TypeError(
      'AudioData: unsupported format "' + format +
      '". Supported: ' + Object.keys(FORMAT_BYTES).join(', ')
    );
  }
  var channels = enforceRange(_required(init, 'numberOfChannels'), 'unsigned long', 'AudioData: numberOfChannels');
  var frames = enforceRange(_required(init, 'numberOfFrames'), 'unsigned long', 'AudioData: numberOfFrames');
  // `required float sampleRate`: a WebIDL float — NaN / Infinity are a
  // TypeError, the value is rounded to single precision.
  var sampleRate = Math.fround(Number(_required(init, 'sampleRate')));
  if (!Number.isFinite(sampleRate)) throw new TypeError('AudioData: sampleRate must be a finite number');
  // W3C: timestamp is required. Allow 0 explicitly. Reject NaN/Infinity.
  if (init.timestamp === undefined || init.timestamp === null) {
    throw new TypeError('AudioData: timestamp (microseconds) is required');
  }
  var timestamp = enforceRange(init.timestamp, 'long long', 'AudioData: timestamp');

  if (!(sampleRate > 0)) throw new TypeError('AudioData: sampleRate must be greater than 0, got ' + sampleRate);
  if (frames === 0) throw new TypeError('AudioData: numberOfFrames must not be 0');
  if (channels === 0) throw new TypeError('AudioData: numberOfChannels must not be 0');

  // W3C: the AudioData's resource holds "a copy of init.data". This kept a
  // view on the caller's memory instead — and the encoder writes exactly
  // that memory to FFmpeg's stdin, where Node holds on to it until it is
  // flushed. A capture loop that reuses one buffer (allowed: the browser
  // copies) rewrote audio already handed to encode(): 86 of 100 sine
  // frames came out as the silence written after them.
  var _src = _toBuffer(init.data);
  var bps = FORMAT_BYTES[format];
  // W3C: init.data smaller than numberOfFrames × numberOfChannels × bytes
  // per sample is a TypeError. It was accepted, and every later read ran
  // past the end of the data.
  if (_src.length < frames * channels * bps) {
    throw new TypeError('AudioData: data is ' + _src.length + ' bytes, ' +
      frames + ' frames x ' + channels + ' channels of ' +
      format + ' need ' + (frames * channels * bps));
  }
  // W3C: init.transfer is checked (DataCloneError), the data copied (or
  // taken over when its buffer is listed), and every listed buffer
  // detached — after the TypeErrors above, so a throwing constructor
  // detaches nothing. `transfer` was ignored: the caller's buffers stayed
  // usable.
  this.data = takeBufferSource('AudioData: data', init.data, init.transfer);
  if (_hasBuffer && Buffer.isBuffer(this.data)) this.data = new Uint8Array(this.data.buffer, this.data.byteOffset, this.data.byteLength);
  this.format = format;
  this.sampleRate = sampleRate;
  this.numberOfChannels = channels;
  this.numberOfFrames = frames;
  this.timestamp = timestamp;
  this.byteLength = this.data.length;
  this._closed = false;
}

// W3C: the duration getter is numberOfFrames / sampleRate × 1,000,000,
// returned as an `unsigned long long` (the fraction dropped). It was
// Math.round of that, or whatever init.duration said (not an AudioDataInit
// member) — 1024 frames at 44.1 kHz read 23220 where the spec says 23219.
// A closed AudioData (0 frames at rate 0) reads 0.
Object.defineProperty(AudioData.prototype, 'duration', {
  get: function () {
    var d = this.numberOfFrames / this.sampleRate * 1e6;
    return Number.isFinite(d) ? Math.trunc(d) : 0;
  },
  enumerable: true, configurable: true,
});

/**
 * W3C AudioDataCopyToOptions + "Compute Copy Element Count", shared by
 * allocationSize and copyTo. planeIndex is REQUIRED; frameOffset at or
 * past the last frame is a RangeError. (planeIndex was optional — leaving
 * it out of a planar copy copied every plane, which the spec has no form
 * for — and a frameOffset equal to numberOfFrames was accepted as an
 * empty copy.) A null member is taken as absent, like undefined.
 */
function _copyOptions(self, options, what) {
  if (!options || options.planeIndex === undefined || options.planeIndex === null) {
    throw new TypeError(what + ': options.planeIndex is required');
  }
  // The IDL converts the members in order: format, frameCount, frameOffset, planeIndex.
  var format = (options.format === undefined || options.format === null) ? self.format : options.format;
  if (!FORMAT_BYTES[format]) {
    throw new TypeError(what + ': unsupported target format "' + format + '"');
  }
  var frameCount = (options.frameCount === undefined || options.frameCount === null)
    ? null : enforceRange(options.frameCount, 'unsigned long', what + ': frameCount');
  var frameOffset = (options.frameOffset === undefined || options.frameOffset === null)
    ? 0 : enforceRange(options.frameOffset, 'unsigned long', what + ': frameOffset');
  var planeIndex = enforceRange(options.planeIndex, 'unsigned long', what + ': planeIndex');

  var planar = _isPlanar(format);
  if (!planar && planeIndex > 0) {
    throw new RangeError(what + ': planeIndex ' + planeIndex +
      ' out of range for interleaved format "' + format + '" (one plane)');
  }
  if (planar && planeIndex >= self.numberOfChannels) {
    throw new RangeError(what + ': planeIndex ' + planeIndex + ' out of range');
  }
  if (frameOffset >= self.numberOfFrames) {
    throw new RangeError(what + ': frameOffset ' + frameOffset +
      ' out of range [0, ' + self.numberOfFrames + ')');
  }
  var copyFrames = self.numberOfFrames - frameOffset;
  if (frameCount !== null) {
    if (frameCount > copyFrames) {
      throw new RangeError(what + ': frameCount ' + frameCount + ' beyond remaining frames');
    }
    copyFrames = frameCount;
  }
  return {
    format: format, planar: planar, planeIndex: planeIndex,
    frameOffset: frameOffset, frameCount: copyFrames,
    elementCount: planar ? copyFrames : copyFrames * self.numberOfChannels,
  };
}

/**
 * allocationSize(options) — bytes needed to hold a copyTo() result.
 * Honors options.format, options.planeIndex, options.frameOffset,
 * options.frameCount per W3C.
 */
AudioData.prototype.allocationSize = function (options) {
  if (this._closed) throw _domex('AudioData is closed', 'InvalidStateError');
  var o = _copyOptions(this, options, 'AudioData.allocationSize');
  return o.elementCount * FORMAT_BYTES[o.format];
};

/**
 * copyTo(destination, options) — copy frames into destination.
 *
 * Per W3C WebCodecs §4.5.5:
 *   - destination: BufferSource
 *   - options.planeIndex (REQUIRED)
 *   - options.frameOffset (default 0)
 *   - options.frameCount (default = remaining frames)
 *   - options.format (default = this.format; conversion if differs)
 *
 * The previous implementation IGNORED options entirely and just copied
 * the whole raw .data buffer. This produced garbage when the caller
 * asked for a different format, a frame range, or a specific plane (MP-1).
 */
// W3C IDL: `undefined copyTo(...)` — synchronous; errors THROW. It
// returned a Promise and turned errors into rejections, so a caller's
// try/catch caught nothing: computeAudioDbov on a closed AudioData left
// an unhandled rejection that killed the process.
AudioData.prototype.copyTo = function (destination, options) {
  this._copyToSync(destination, options);
};

AudioData.prototype._copyToSync = function (destination, options) {
  if (this._closed) throw _domex('AudioData is closed', 'InvalidStateError');
  var o = _copyOptions(this, options, 'AudioData.copyTo');

  if (!_isBufferSource(destination)) {
    throw new TypeError(
      'AudioData.copyTo: destination must be a BufferSource'
    );
  }
  var dst = _toBuffer(destination);

  var needed = o.elementCount * FORMAT_BYTES[o.format];
  if (dst.length < needed) {
    throw new RangeError(
      'AudioData.copyTo: destination too small — need ' +
      needed + ' bytes, got ' + dst.length
    );
  }

  // Same-format fast path
  if (this.format === o.format) {
    return _copySameFormat(this, dst, o.frameOffset, o.frameCount, o.planeIndex);
  }

  // Conversion path. We support cross-format and planar↔interleaved.
  return _copyWithConversion(this, dst, o.format, o.frameOffset, o.frameCount, o.planeIndex);
};

// ── Same-format copy (no conversion needed) ──
function _copySameFormat(self, dst, frameOffset, frameCount, planeIndex) {
  var fmt = self.format;
  var bps = FORMAT_BYTES[fmt];
  var ch = self.numberOfChannels;
  var planar = _isPlanar(fmt);

  if (planar) {
    // One plane's slice. In planar layout, plane k starts at offset
    // k * numberOfFrames * bps.
    var planeStart = planeIndex * self.numberOfFrames * bps;
    var srcOff = planeStart + frameOffset * bps;
    dst.set(self.data.subarray(srcOff, srcOff + frameCount * bps), 0);
    return;
  }

  // Interleaved: just slice [frameOffset, frameOffset+frameCount).
  var iOff = frameOffset * ch * bps;
  dst.set(self.data.subarray(iOff, iOff + frameCount * ch * bps), 0);
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
  // A planar destination is the one plane planeIndex; an interleaved one
  // every channel.
  var startCh, endCh;
  if (dstPlanar) {
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
    case 's16': return readS16LE(buf, off) / 32768;
    case 's32': return readS32LE(buf, off) / 2147483648;
    case 'f32': return readF32LE(buf, off);
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
      writeU16LE(buf, off, Math.max(-32768, Math.min(32767, Math.round(value * 32768))));
      break;
    case 's32':
      writeU32LE(buf, off, Math.max(-2147483648, Math.min(2147483647,
                                  Math.round(value * 2147483648))));
      break;
    case 'f32':
      // Not clamped: W3C "implementations SHOULD take care not to clip
      // internally when handling f32 samples" — f32 → f32-planar cut a
      // 1.5 overshoot to 1.0.
      writeF32LE(buf, off, value);
      break;
  }
}

AudioData.prototype.clone = function () {
  if (this._closed) throw _domex('AudioData is closed', 'InvalidStateError');
  var copy = new Uint8Array(this.data.length);
  copy.set(this.data);
  return new AudioData({
    data: copy,
    format: this.format,
    sampleRate: this.sampleRate,
    numberOfChannels: this.numberOfChannels,
    numberOfFrames: this.numberOfFrames,
    timestamp: this.timestamp,
  });
};

// W3C "close AudioData": the resource is released and format becomes
// null, sampleRate / numberOfFrames / numberOfChannels 0 (so duration 0).
// They kept their values, so a closed AudioData still looked usable.
AudioData.prototype.close = function () {
  this._closed = true;
  this.data = null;
  this.byteLength = 0;
  this.format = null;
  this.sampleRate = 0;
  this.numberOfFrames = 0;
  this.numberOfChannels = 0;
};

export default AudioData;
