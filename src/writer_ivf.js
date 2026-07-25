/**
 * writer_ivf.js — IVF container writer (the inverse of reader_ivf.js).
 *
 * IVF is the simplest possible video container: a 32-byte file header
 * followed by a flat sequence of frame records (12-byte header + payload).
 * It carries raw VP8 / VP9 / AV1 frames with timestamps and is the format
 * libvpx/ffmpeg expect when decoding those codecs from a pipe.
 *
 * This writer mirrors the streaming, per-frame model of writer_ogg.js:
 * call writeHeader() ONCE, then writeFrame() per frame; each method
 * returns the bytes to emit (the caller concatenates / writes them).
 * Stateless across frames except for the running frame counter, so it
 * lives flat under src/ (not core/ or utils/).
 *
 * Byte layout — kept byte-identical to what reader_ivf.js parses:
 *
 *   File header (32 bytes):
 *     0-3   'DKIF' signature
 *     4-5   version           (U16LE, 0)
 *     6-7   header length      (U16LE, 32)
 *     8-11  fourcc             ('VP80' | 'VP90' | 'AV01')
 *     12-13 width              (U16LE)
 *     14-15 height             (U16LE)
 *     16-19 timebase denominator (U32LE)   ← reader reads den here
 *     20-23 timebase numerator   (U32LE)   ← reader reads num here
 *     24-27 frame count         (U32LE, 0 for streaming/unknown)
 *     28-31 reserved            (0)
 *
 *   Frame header (12 bytes), then payload:
 *     0-3   frame size         (U32LE)
 *     4-7   timestamp low      (U32LE)
 *     8-11  timestamp high     (U32LE)   — 64-bit LE timestamp in timebase units
 */

import { writeU16LE, writeU32LE, fromAscii } from './core/bytes.js';

// codec name → IVF fourcc. Accepts either a friendly codec name or a raw
// 4-char fourcc (passed through untouched if it already looks like one).
var CODEC_FOURCC = {
  vp8: 'VP80',
  vp9: 'VP90',
  av1: 'AV01',
};

function resolveFourcc(codec) {
  if (!codec) return 'VP90';
  var lc = String(codec).toLowerCase();
  if (CODEC_FOURCC[lc]) return CODEC_FOURCC[lc];
  // already a fourcc-shaped string (e.g. 'VP90') → use as-is, padded to 4
  var s = String(codec);
  if (s.length === 4) return s;
  return 'VP90';
}

/**
 * @param {object} opts
 * @param {string} [opts.codec='vp9']   'vp8' | 'vp9' | 'av1' (or a raw fourcc)
 * @param {string} [opts.fourcc]         explicit fourcc, overrides codec
 * @param {number} opts.width            frame width  (required, U16)
 * @param {number} opts.height           frame height (required, U16)
 * @param {number} [opts.timebaseNum=1]      timebase numerator
 * @param {number} [opts.timebaseDen=1000000] timebase denominator. The
 *        default 1/1000000 means writeFrame() timestamps are plain
 *        microseconds (ts === ptsUs) — matching reader_ivf's own defaults,
 *        so a write→read round-trip returns the exact ptsUs you passed in.
 */
function IVFWriter(opts) {
  if (!opts) opts = {};
  this._fourcc      = opts.fourcc ? resolveFourcc(opts.fourcc) : resolveFourcc(opts.codec);
  this._width       = opts.width || 0;
  this._height      = opts.height || 0;
  this._timebaseNum = (opts.timebaseNum != null) ? opts.timebaseNum : 1;
  this._timebaseDen = (opts.timebaseDen != null) ? opts.timebaseDen : 1000000;

  this._frameCount  = 0;   // frames written so far (for symmetry / debugging)
}

/**
 * Build the 32-byte IVF file header. Call ONCE before any writeFrame().
 * @returns {Uint8Array} the 32-byte header
 */
IVFWriter.prototype.writeHeader = function () {
  var b = new Uint8Array(32);
  b.set(fromAscii('DKIF'), 0);
  writeU16LE(b, 4, 0);                 // version
  writeU16LE(b, 6, 32);                // header length
  b.set(fromAscii(this._fourcc), 8);
  writeU16LE(b, 12, this._width);
  writeU16LE(b, 14, this._height);
  writeU32LE(b, 16, this._timebaseDen);
  writeU32LE(b, 20, this._timebaseNum);
  writeU32LE(b, 24, 0);                // frame count unknown (streaming)
  writeU32LE(b, 28, 0);                // reserved
  return b;
};

/**
 * Wrap a single encoded frame into one IVF frame record.
 *
 * @param {Uint8Array} payload   raw VP8/VP9/AV1 frame bytes
 * @param {number}     ptsUs     presentation timestamp in microseconds
 * @returns {Uint8Array} 12-byte frame header followed by the payload
 */
IVFWriter.prototype.writeFrame = function (payload, ptsUs) {
  if (!payload) payload = new Uint8Array(0);

  // ptsUs → raw timebase units (inverse of reader_ivf's
  //   ptsUs = ts * 1e6 * num / den).
  // With the default 1/1000000 timebase this is the identity (ts = ptsUs).
  var ts = Math.round((ptsUs || 0) * this._timebaseDen / (1000000 * this._timebaseNum));
  var tsLo = ts >>> 0;
  var tsHi = Math.floor(ts / 0x100000000) >>> 0;

  var out = new Uint8Array(12 + payload.length);
  writeU32LE(out, 0, payload.length);
  writeU32LE(out, 4, tsLo);
  writeU32LE(out, 8, tsHi);
  out.set(payload, 12);

  this._frameCount++;
  return out;
};

/** Reset the running frame counter so the writer can be reused. */
IVFWriter.prototype.reset = function () {
  this._frameCount = 0;
};

export default IVFWriter;
