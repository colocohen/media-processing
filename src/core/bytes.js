/**
 * bytes — Isomorphic byte utilities over Uint8Array.
 *
 * Browser doesn't have Node's Buffer, and we don't want a polyfill in
 * the bundle, so all byte operations route through this module. Every
 * function takes/returns Uint8Array and uses direct byte ops for
 * big-endian IO without per-platform branches.
 *
 * Design notes:
 *  - All multi-byte ops are big-endian (network order). The container
 *    formats we touch (MP4, MPEG-TS, ADTS) are uniformly big-endian,
 *    so we don't expose LE variants — adding them later if needed.
 *  - `concat` allocates once. Avoid in hot paths; prefer pre-sized
 *    buffers + write functions when packet count is known.
 *
 * This is the canonical primitive of the unified library — both the
 * Node side and the browser bundle build on it. A Node Buffer IS a
 * Uint8Array subclass, so anything that reads/writes via these helpers
 * works identically whether it was handed a Buffer or a Uint8Array.
 */

// ── Reads ──────────────────────────────────────────────────

export function readU16BE(buf, off) {
  return (buf[off] << 8) | buf[off + 1];
}

export function readU24BE(buf, off) {
  return (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2];
}

export function readU32BE(buf, off) {
  // `<< 24` produces a negative 32-bit signed result when the high bit
  // is set (because JS bitwise ops are signed). Coercing to unsigned
  // with `>>> 0` at the end gives the correct unsigned 32-bit value
  // and is ~4× faster than building a DataView per call. Verified
  // correct for the full 0..0xFFFFFFFF range, including 0x80000000+.
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}

// Signed 32-bit BE — fMP4 trun fields data_offset and composition_time_offset
// are signed (the latter in version-1 trun). Same shift as readU32BE but
// WITHOUT the `>>> 0`, so the `<< 24` sign bit is preserved (two's complement).
export function readS32BE(buf, off) {
  return (buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3];
}

/**
 * Read 64-bit big-endian unsigned integer as JS Number.
 * Safe up to 2^53 (Number.MAX_SAFE_INTEGER) — fine for media
 * timestamps but truncates above ~9 PB. If full u64 ever needed
 * (it shouldn't, for HLS) switch to BigInt at the call site.
 */
export function readU64BE(buf, off) {
  var hi = readU32BE(buf, off);
  var lo = readU32BE(buf, off + 4);
  return hi * 0x100000000 + lo;
}

// ── Writes ─────────────────────────────────────────────────

export function writeU16BE(buf, off, val) {
  buf[off] = (val >>> 8) & 0xFF;
  buf[off + 1] = val & 0xFF;
}

export function writeU24BE(buf, off, val) {
  buf[off] = (val >>> 16) & 0xFF;
  buf[off + 1] = (val >>> 8) & 0xFF;
  buf[off + 2] = val & 0xFF;
}

export function writeU32BE(buf, off, val) {
  // Direct byte writes are far faster than `new DataView(...).setUint32`
  // (~25× in V8 when called in a tight loop, e.g. trun's per-sample
  // writes). The sign caveat noted on readU32BE doesn't apply on the
  // write side: `>>> 24 & 0xFF` is unsigned and produces the right
  // byte for any val in the JS unsigned 32-bit range.
  buf[off]     = (val >>> 24) & 0xFF;
  buf[off + 1] = (val >>> 16) & 0xFF;
  buf[off + 2] = (val >>> 8) & 0xFF;
  buf[off + 3] = val & 0xFF;
}

export function writeU64BE(buf, off, val) {
  // val is a JS Number. Decompose into two u32s. Safe up to 2^53.
  var hi = Math.floor(val / 0x100000000);
  var lo = val >>> 0;
  writeU32BE(buf, off, hi);
  writeU32BE(buf, off + 4, lo);
}

// ── Little-endian (Ogg) ─────────────────────────────────────
//
// Ogg is the one container we touch that is little-endian (page
// headers, granule position, serial/sequence numbers). These mirror
// the BE helpers above. Signature matches the BE side: (buf, off[, val]).

export function readU16LE(buf, off) {
  return (buf[off]) | (buf[off + 1] << 8);
}

export function readU32LE(buf, off) {
  return ((buf[off]) | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

export function writeU16LE(buf, off, val) {
  buf[off]     = val & 0xFF;
  buf[off + 1] = (val >>> 8) & 0xFF;
}

export function writeU32LE(buf, off, val) {
  buf[off]     = val & 0xFF;
  buf[off + 1] = (val >>> 8) & 0xFF;
  buf[off + 2] = (val >>> 16) & 0xFF;
  buf[off + 3] = (val >>> 24) & 0xFF;
}

// Signed LE reads — audio sample data (s16/s32) is little-endian signed.
// Writes reuse writeU16LE/writeU32LE: masking (val & 0xFF, >>> shifts)
// produces correct two's-complement bytes for negative values too.

export function readS16LE(buf, off) {
  var v = (buf[off]) | (buf[off + 1] << 8);
  return v >= 0x8000 ? v - 0x10000 : v;
}

export function readS32LE(buf, off) {
  // `| 0` coerces to signed 32-bit — exactly the sign extension we want.
  return ((buf[off]) | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) | 0;
}

// Float32 LE — f32 audio sample format. Hand-rolling IEEE-754 is
// error-prone, so we route through a shared 4-byte DataView (created
// once, no per-call allocation). DataView is isomorphic.
var _f32scratch = new DataView(new ArrayBuffer(4));

export function readF32LE(buf, off) {
  _f32scratch.setUint8(0, buf[off]);
  _f32scratch.setUint8(1, buf[off + 1]);
  _f32scratch.setUint8(2, buf[off + 2]);
  _f32scratch.setUint8(3, buf[off + 3]);
  return _f32scratch.getFloat32(0, true);
}

export function writeF32LE(buf, off, val) {
  _f32scratch.setFloat32(0, val, true);
  buf[off]     = _f32scratch.getUint8(0);
  buf[off + 1] = _f32scratch.getUint8(1);
  buf[off + 2] = _f32scratch.getUint8(2);
  buf[off + 3] = _f32scratch.getUint8(3);
}

// ── Misc ────────────────────────────────────────────────────

/**
 * Concatenate Uint8Arrays into one.
 *
 * Equivalent to Buffer.concat() but Uint8Array-native. Total length
 * computed first to avoid intermediate allocations — important when
 * called from segment builders that may concat hundreds of NALUs
 * per second.
 *
 * Single-element arrays return the original (zero copy). Callers
 * that need to mutate the result must call slice() themselves —
 * this is safe in the codebase because concat() outputs are always
 * either consumed read-only or further concatenated.
 */
export function concat(arrays) {
  if (arrays.length === 1) return arrays[0];
  var total = 0;
  for (var i = 0; i < arrays.length; i++) total += arrays[i].length;
  var out = new Uint8Array(total);
  var off = 0;
  for (var j = 0; j < arrays.length; j++) {
    out.set(arrays[j], off);
    off += arrays[j].length;
  }
  return out;
}

/**
 * Encode an ASCII string to Uint8Array. Used for MP4 box types
 * ('ftyp', 'moov', etc.) and TS string fields.
 *
 * Caller's responsibility to ensure str is pure ASCII — non-ASCII
 * code points are masked to the low byte (matching Buffer's behavior
 * for ascii encoding) rather than throwing.
 */
export function fromAscii(str) {
  var out = new Uint8Array(str.length);
  for (var i = 0; i < str.length; i++) {
    out[i] = str.charCodeAt(i) & 0xFF;
  }
  return out;
}

/**
 * Decode an ASCII range from a Uint8Array to string. Used for reading
 * MP4 box types from a parsed buffer. Bounds-checked to avoid
 * out-of-range reads on truncated input.
 */
export function toAscii(buf, start, end) {
  if (end > buf.length) end = buf.length;
  var s = '';
  for (var i = start; i < end; i++) {
    s += String.fromCharCode(buf[i]);
  }
  return s;
}

/**
 * Compare two Uint8Arrays for byte equality. Used in tests and for
 * detecting unchanged init segments.
 */
export function equals(a, b) {
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
