/**
 * reader_ivf — IVF container reader (VP8/VP9/AV1).
 *
 * Rewritten with flat buffer (no ByteQueue peek(length)).
 * Same keyframe detection logic for all codecs.
 */

import EventEmitter from './core/events.js';
import { readU16LE, readU32LE, toAscii } from './core/bytes.js';

function IVFReader() {
  this._ee = new EventEmitter();
  this._gotHeader = false;
  this._timebaseNum = 1;
  this._timebaseDen = 1000000;
  this._fourcc = 'VP80';
  this._width = 0;
  this._height = 0;

  this._buf = new Uint8Array(128 * 1024);
  this._start = 0;
  this._end = 0;
}

IVFReader.prototype.on = function (ev, fn) { this._ee.on(ev, fn); };
IVFReader.prototype.off = function (ev, fn) { this._ee.off(ev, fn); };

IVFReader.prototype.feed = function (chunk) {
  this._append(chunk);

  var avail = this._end - this._start;

  if (!this._gotHeader) {
    if (avail < 32) return;
    var b = this._buf;
    var s = this._start;
    if (b[s] !== 0x44 || b[s+1] !== 0x4B || b[s+2] !== 0x49 || b[s+3] !== 0x46) return; // 'DKIF'

    this._fourcc = toAscii(b, s + 8, s + 12);
    this._width = readU16LE(b, s + 12);
    this._height = readU16LE(b, s + 14);
    this._timebaseDen = readU32LE(b, s + 16);
    this._timebaseNum = readU32LE(b, s + 20);

    var ivfHeader = b.slice(s, s + 32);
    this._start += 32;

    this._ee.emit('init', {
      ivfHeader: ivfHeader,
      timebaseNum: this._timebaseNum,
      timebaseDen: this._timebaseDen,
      fourcc: this._fourcc,
      width: this._width,
      height: this._height,
    });
    this._gotHeader = true;
  }

  while (true) {
    avail = this._end - this._start;
    if (avail < 12) break;

    var b2 = this._buf;
    var s2 = this._start;
    var frameSize = readU32LE(b2, s2);
    var tsLo = readU32LE(b2, s2 + 4);
    var tsHi = readU32LE(b2, s2 + 8);
    var ts = tsHi * 0x100000000 + tsLo;

    if (avail < 12 + frameSize) break;

    this._start += 12;
    var payload = this._buf.slice(this._start, this._start + frameSize);
    this._start += frameSize;

    // PTS in microseconds. Use Math.floor (NOT `| 0`): the bitwise
    // operator coerces to a 32-bit signed int, which overflows after
    // ~35 minutes (2^31 µs). Math.floor stays in JS Number's 53-bit
    // safe range — at 48 kHz that's >280 years before precision loss.
    var ptsUs = Math.floor(ts * 1000000 * this._timebaseNum / this._timebaseDen);
    var isKey = false;
    if (this._fourcc === 'VP80') isKey = _keyVP8(payload);
    else if (this._fourcc === 'VP90') isKey = _keyVP9(payload);
    else if (this._fourcc === 'AV01') isKey = _keyAV1(payload);

    this._ee.emit('video', { payload: payload, isKeyframe: isKey, ptsUs: ptsUs });
  }
};

IVFReader.prototype.flush = function () { this._start = 0; this._end = 0; };

IVFReader.prototype._append = function (chunk) {
  if (this._start > (this._buf.length >> 1)) {
    var live = this._end - this._start;
    if (live > 0) this._buf.set(this._buf.subarray(this._start, this._end), 0);
    this._end = live;
    this._start = 0;
  }
  if (this._end + chunk.length > this._buf.length) {
    var newSize = Math.max(this._buf.length * 2, this._end - this._start + chunk.length);
    var newBuf = new Uint8Array(newSize);
    var live2 = this._end - this._start;
    if (live2 > 0) newBuf.set(this._buf.subarray(this._start, this._end), 0);
    this._end = live2;
    this._start = 0;
    this._buf = newBuf;
  }
  this._buf.set(chunk, this._end);
  this._end += chunk.length;
};

// ── Keyframe detection ──

function _keyVP8(buf) { return buf && buf.length > 0 ? ((buf[0] & 0x01) === 0) : false; }

function _keyVP9(buf) {
  if (!buf || buf.length < 1) return false;
  var r = _mkBitReader(buf);
  var fm = r.rb(2); if (fm !== 2) return false;
  var profile = r.rb(2); if (profile === null) return false;
  if (profile === 3) { if (r.rb(1) === null) return false; }
  var show = r.rb(1); if (show === null) return false;
  if (show === 1) return false;
  var ft = r.rb(1); if (ft === null) return false;
  return (ft === 0);
}

function _keyAV1(buf) {
  if (!buf || buf.length < 2) return false;
  var p = 0;
  while (p < buf.length) {
    var h = _parseObu(buf, p);
    if (!h) return false;
    p += h.hdrBytes;
    var s = _leb128(buf, p);
    if (!s) return false;
    p += s.bytes;
    var end = p + s.value;
    if (end > buf.length) return false;
    if (h.type === 6 || h.type === 7) {
      var r = _mkBitReader(buf.subarray(p, end));
      var show = r.rb(1); if (show === null) return false;
      if (show === 1) return false;
      var ft = r.rb(2); if (ft === null) return false;
      return (ft === 0 || ft === 2);
    }
    p = end;
  }
  return false;
}

function _mkBitReader(buf) {
  var bp = 0, bit = 7;
  return { rb: function (n) {
    var v = 0;
    for (var i = 0; i < n; i++) {
      if (bp >= buf.length) return null;
      v = (v << 1) | ((buf[bp] >> bit) & 1);
      if (--bit < 0) { bit = 7; bp++; }
    }
    return v;
  }};
}

function _parseObu(buf, off) {
  if (off >= buf.length) return null;
  var b0 = buf[off];
  if ((b0 >> 7) & 1) return null;  // forbidden bit
  var type = (b0 >> 3) & 0x0F;
  var ext = (b0 >> 2) & 1;
  var hasSize = (b0 >> 1) & 1;
  if (!hasSize) return null;
  var hdrBytes = 1;
  var temporalId = 0;
  var spatialId = 0;
  if (ext) {
    if (off + 2 > buf.length) return null;
    var b1 = buf[off + 1];
    temporalId = (b1 >> 5) & 0x07;  // 3 bits
    spatialId = (b1 >> 3) & 0x03;   // 2 bits
    hdrBytes = 2;
  }
  if (off + hdrBytes > buf.length) return null;
  return { type: type, hdrBytes: hdrBytes, temporalId: temporalId, spatialId: spatialId };
}

function _leb128(buf, off) {
  var val = 0, shift = 0, bytes = 0;
  while (off + bytes < buf.length) {
    var b = buf[off + bytes]; val |= ((b & 0x7F) << shift); bytes++;
    if (!(b & 0x80)) break;
    shift += 7; if (bytes > 8) return null;
  }
  return { value: val, bytes: bytes };
}

/**
 * Split an AV1 bitstream into individual OBUs.
 * Returns array of { type, data, temporalId, spatialId } where data includes the OBU header.
 *
 * OBU types:
 *   1 = SEQUENCE_HEADER
 *   2 = TEMPORAL_DELIMITER
 *   3 = FRAME_HEADER
 *   4 = TILE_GROUP
 *   5 = METADATA
 *   6 = FRAME
 *   7 = REDUNDANT_FRAME_HEADER
 *   8 = TILE_LIST
 *
 * temporalId/spatialId: from OBU extension header (0 if no extension).
 * Used by SFU to route AV1 SVC layers.
 */
function splitOBUs(buf) {
  var obus = [];
  var p = 0;
  while (p < buf.length) {
    var h = _parseObu(buf, p);
    if (!h) break;
    var sizeStart = p + h.hdrBytes;
    var s = _leb128(buf, sizeStart);
    if (!s) break;
    var dataStart = sizeStart + s.bytes;
    var end = dataStart + s.value;
    if (end > buf.length) break;
    obus.push({
      type: h.type,
      temporalId: h.temporalId,
      spatialId: h.spatialId,
      data: buf.slice(p, end),
    });
    p = end;
  }
  return obus;
}

/**
 * Extract Sequence Header OBU from an AV1 bitstream.
 * Returns Buffer or null. Used for SDP / decoderConfig.description.
 */
function extractSequenceHeader(buf) {
  var obus = splitOBUs(buf);
  for (var i = 0; i < obus.length; i++) {
    if (obus[i].type === 1) return obus[i].data;  // OBU_SEQUENCE_HEADER
  }
  return null;
}

export default IVFReader;
export { splitOBUs, extractSequenceHeader };
