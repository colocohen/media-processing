/**
 * reader_annexb — H.264/H.265 Annex-B byte stream reader.
 *
 * Improvements:
 *  - Optimized AUD search: skips runs of non-zero bytes
 *  - Flat buffer with compact-on-consume
 *  - Exported helpers for reader_ts reuse
 */

import { EventEmitter } from 'node:events';

var H264_NAL_AUD = 9;
var H264_NAL_IDR = 5;
var H265_NAL_AUD = 35;
var H265_NAL_IDR_W_RADL = 19;

// Pre-allocated start code — avoids Buffer.from() in hot paths
var START_CODE = Buffer.from([0, 0, 0, 1]);
var H265_NAL_IDR_N_LP = 20;

function AnnexBReader(opts) {
  if (!opts) opts = {};
  this._ee = new EventEmitter();
  this._maxBuf = opts.maxBuf || (8 * 1024 * 1024);
  this._fps = opts.fps || 30;
  this._codec = opts.codec || 'h264';
  this._index = 0;
  this._groupId = 0;

  this._buf = Buffer.allocUnsafe(256 * 1024);
  this._start = 0;
  this._end = 0;
}

AnnexBReader.prototype.on = function (ev, fn) { this._ee.on(ev, fn); };
AnnexBReader.prototype.off = function (ev, fn) { this._ee.off(ev, fn); };

AnnexBReader.prototype.feed = function (chunk) {
  this._append(chunk);
  if ((this._end - this._start) > this._maxBuf) this._resync();

  var audType = this._codec === 'h265' ? H265_NAL_AUD : H264_NAL_AUD;
  var isH265 = this._codec === 'h265';

  while (true) {
    var first = findAUD(this._buf, this._start, this._end, audType, isH265);
    if (first < 0) break;
    var second = findAUD(this._buf, first + 3, this._end, audType, isH265);
    if (second < 0) break;

    var au = Buffer.from(this._buf.subarray(first, second));
    this._start = second;

    var isKey = isH265 ? hasIDR_H265(au) : hasIDR_H264(au);
    if (isKey) this._groupId++;
    var ptsUs = Math.floor(this._index * 1000000 / this._fps);

    this._ee.emit('video', {
      payload: au,
      isKeyframe: isKey,
      ptsUs: ptsUs,
      index: this._index++,
      groupId: this._groupId,
    });
  }
};

AnnexBReader.prototype.flush = function () {
  this._start = 0;
  this._end = 0;
};

AnnexBReader.prototype._append = function (chunk) {
  if (this._start > (this._buf.length >> 1)) {
    var live = this._end - this._start;
    if (live > 0) this._buf.copy(this._buf, 0, this._start, this._end);
    this._end = live;
    this._start = 0;
  }
  if (this._end + chunk.length > this._buf.length) {
    var newSize = Math.max(this._buf.length * 2, this._end - this._start + chunk.length);
    var newBuf = Buffer.allocUnsafe(newSize);
    var live2 = this._end - this._start;
    if (live2 > 0) this._buf.copy(newBuf, 0, this._start, this._end);
    this._end = live2;
    this._start = 0;
    this._buf = newBuf;
  }
  chunk.copy(this._buf, this._end);
  this._end += chunk.length;
};

AnnexBReader.prototype._resync = function () {
  var keep = 1024 * 1024;
  var live = this._end - this._start;
  if (live <= keep) return;
  var from = this._end - keep;
  var pos = findLastStartCode(this._buf, from, this._end);
  if (pos < 0) { this._start = 0; this._end = 0; return; }
  var tail = this._end - pos;
  this._buf.copy(this._buf, 0, pos, this._end);
  this._start = 0;
  this._end = tail;
};

// ══════════════════════════════════════════════════════════
// Exported helpers — shared with reader_ts
// ══════════════════════════════════════════════════════════

/**
 * Find AUD NAL in buf[from..end). Optimized: skips non-zero bytes.
 * Returns offset or -1.
 */
function findAUD(buf, from, end, audType, isH265) {
  var i = from;
  while (i + 4 <= end) {
    // Fast skip: if current byte is not 0x00, next start code is at least 3 bytes away
    if (buf[i] !== 0x00) { i++; continue; }
    if (buf[i + 1] !== 0x00) { i += 2; continue; }

    // 4-byte start code: 00 00 00 01
    if (buf[i + 2] === 0x00 && i + 5 <= end && buf[i + 3] === 0x01) {
      var t4 = isH265 ? ((buf[i + 4] >> 1) & 0x3F) : (buf[i + 4] & 0x1F);
      if (t4 === audType) return i;
      i += 4;
      continue;
    }

    // 3-byte start code: 00 00 01
    if (buf[i + 2] === 0x01 && i + 4 <= end) {
      var t3 = isH265 ? ((buf[i + 3] >> 1) & 0x3F) : (buf[i + 3] & 0x1F);
      if (t3 === audType) return i;
      i += 3;
      continue;
    }

    i++;
  }
  return -1;
}

function findLastStartCode(buf, from, end) {
  for (var i = end - 4; i >= from; i--) {
    if (buf[i] === 0x00 && buf[i + 1] === 0x00) {
      if (buf[i + 2] === 0x00 && buf[i + 3] === 0x01) return i;
      if (buf[i + 2] === 0x01) return i;
    }
  }
  return -1;
}

function hasIDR_H264(au) {
  var i = 0, len = au.length;
  while (i + 4 <= len) {
    if (au[i] !== 0x00) { i++; continue; }
    if (au[i + 1] !== 0x00) { i += 2; continue; }
    if (au[i + 2] === 0x00 && au[i + 3] === 0x01 && i + 5 <= len) {
      if ((au[i + 4] & 0x1F) === H264_NAL_IDR) return true;
      i += 4; continue;
    }
    if (au[i + 2] === 0x01 && i + 4 <= len) {
      if ((au[i + 3] & 0x1F) === H264_NAL_IDR) return true;
      i += 3; continue;
    }
    i++;
  }
  return false;
}

function hasIDR_H265(au) {
  var i = 0, len = au.length;
  while (i + 4 <= len) {
    if (au[i] !== 0x00) { i++; continue; }
    if (au[i + 1] !== 0x00) { i += 2; continue; }
    if (au[i + 2] === 0x00 && au[i + 3] === 0x01 && i + 5 <= len) {
      var t = (au[i + 4] >> 1) & 0x3F;
      if (t === H265_NAL_IDR_W_RADL || t === H265_NAL_IDR_N_LP) return true;
      i += 4; continue;
    }
    if (au[i + 2] === 0x01 && i + 4 <= len) {
      var t3 = (au[i + 3] >> 1) & 0x3F;
      if (t3 === H265_NAL_IDR_W_RADL || t3 === H265_NAL_IDR_N_LP) return true;
      i += 3; continue;
    }
    i++;
  }
  return false;
}

// H.264 NAL types
var H264_NAL_SPS = 7;
var H264_NAL_PPS = 8;
// H.265 NAL types  
var H265_NAL_VPS = 32;
var H265_NAL_SPS = 33;
var H265_NAL_PPS = 34;

/**
 * Extract individual NAL units from an Annex-B access unit.
 * Returns array of { type, data } where data excludes start code.
 */
function splitNALUs(au, isH265) {
  var nalus = [];
  var i = 0, len = au.length;
  while (i < len) {
    // Find start code
    if (i + 3 <= len && au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1) {
      i += 3;
    } else if (i + 4 <= len && au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 0 && au[i + 3] === 1) {
      i += 4;
    } else { i++; continue; }

    // Find end (next start code or end of buffer)
    var naluStart = i;
    while (i < len) {
      if (i + 3 <= len && au[i] === 0 && au[i + 1] === 0 && (au[i + 2] === 1 || (au[i + 2] === 0 && i + 3 < len && au[i + 3] === 1))) break;
      i++;
    }
    if (naluStart < i) {
      var naluData = au.subarray(naluStart, i);
      var type = isH265 ? ((naluData[0] >> 1) & 0x3F) : (naluData[0] & 0x1F);
      nalus.push({ type: type, data: Buffer.from(naluData) });
    }
  }
  return nalus;
}

/**
 * Extract SPS + PPS (H.264) or VPS + SPS + PPS (H.265) from Annex-B data.
 * Returns a Buffer (concatenated parameter sets in Annex-B format) or null.
 */
function extractParameterSets(au, isH265) {
  var nalus = splitNALUs(au, isH265);
  var params = [];
  for (var i = 0; i < nalus.length; i++) {
    var t = nalus[i].type;
    if (!isH265 && (t === H264_NAL_SPS || t === H264_NAL_PPS)) {
      params.push(nalus[i].data);
    } else if (isH265 && (t === H265_NAL_VPS || t === H265_NAL_SPS || t === H265_NAL_PPS)) {
      params.push(nalus[i].data);
    }
  }
  if (params.length === 0) return null;
  // Concatenate in Annex-B format: [00 00 00 01] [NALU] [00 00 00 01] [NALU] ...
  var sc = START_CODE;
  var parts = [];
  for (var j = 0; j < params.length; j++) {
    parts.push(sc, params[j]);
  }
  return Buffer.concat(parts);
}

/**
 * Convert Annex-B byte stream to AVCC format (length-prefixed NALUs).
 * MP4 containers use AVCC. RTP uses raw NALUs (no prefix).
 *
 * AnnexB:  [00 00 00 01] [NALU] [00 00 00 01] [NALU]
 * AVCC:    [4-byte-len]  [NALU] [4-byte-len]  [NALU]
 */
function annexbToAvcc(buf, isH265) {
  var nalus = splitNALUs(buf, isH265);
  var totalSize = 0;
  for (var i = 0; i < nalus.length; i++) totalSize += 4 + nalus[i].data.length;
  var out = Buffer.allocUnsafe(totalSize);
  var off = 0;
  for (var j = 0; j < nalus.length; j++) {
    out.writeUInt32BE(nalus[j].data.length, off);
    nalus[j].data.copy(out, off + 4);
    off += 4 + nalus[j].data.length;
  }
  return out;
}

/**
 * Convert AVCC format (length-prefixed NALUs) to Annex-B byte stream.
 * @param {Buffer} buf — AVCC data
 * @param {number} [lengthSize=4] — NALU length field size (1, 2, or 4 bytes)
 */
function avccToAnnexb(buf, lengthSize) {
  if (!lengthSize) lengthSize = 4;
  var parts = [];
  var sc = START_CODE;
  var off = 0;
  while (off + lengthSize <= buf.length) {
    var len;
    if (lengthSize === 4) len = buf.readUInt32BE(off);
    else if (lengthSize === 2) len = buf.readUInt16BE(off);
    else len = buf[off];
    off += lengthSize;
    if (off + len > buf.length) break;
    parts.push(sc, buf.subarray(off, off + len));
    off += len;
  }
  return Buffer.concat(parts);
}

export default AnnexBReader;
export { findAUD, findLastStartCode, hasIDR_H264, hasIDR_H265, splitNALUs, extractParameterSets, annexbToAvcc, avccToAnnexb, H264_NAL_AUD, H265_NAL_AUD };
