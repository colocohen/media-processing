/**
 * reader_flac — native FLAC files (RFC 9639): a FILE fed in pieces → its
 * frames. The API and events are reader_mp4's (see reader_file_stream.js).
 *
 * 'fLaC', then the metadata blocks (an ID3v2 tag before them is
 * skipped): STREAMINFO gives the sample rate, channels, total samples
 * (info.durationUs) and the WebCodecs description — 'fLaC' followed by
 * the STREAMINFO block (its header marked last), what the FLAC
 * registration asks for and what Demuxer emitted before; SEEKTABLE is
 * the seek index. The rest (PICTURE, VORBIS_COMMENT, PADDING, …) are
 * skipped, asked past with a 'need' when large.
 *
 * Frames are split at the next frame header (§9.1) that is valid — sync
 * code with the stream's blocking strategy, no reserved values, the
 * stream's sample rate / channels / sample size, its CRC-8 right — and
 * where the frame before it ends with a right CRC-16 (§9.3): a byte
 * pattern inside a frame that looks like a header is not taken for one
 * (a damaged frame ends at the header numbered next, CRC or not).
 * Timestamps from the header's number (§9.1.5): a fixed-blocksize stream
 * numbers frames (sample = number × the STREAMINFO block size), a
 * variable one numbers samples. Every frame is a keyframe.
 *
 * seek(): from the frame playing at the time — from the SEEKTABLE's last
 * point at / before it when there is one, else by bisection (a frame
 * header says its own time, wherever reading starts). Exact either way.
 */

import FileStreamReader from './reader_file_stream.js';
import { id3v2Size } from './utils/mpeg_audio.js';
import { toAscii } from './core/bytes.js';

var SR_CODES = [0, 88200, 176400, 192000, 8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000];
var SS_CODES = [0, 8, 12, 0, 16, 20, 24, 32];

var CRC8 = new Uint8Array(256), CRC16 = new Uint16Array(256);
(function () {
  for (var i = 0; i < 256; i++) {
    var c = i;
    for (var k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xFF : (c << 1) & 0xFF;
    CRC8[i] = c;
    var d = i << 8;
    for (var j = 0; j < 8; j++) d = d & 0x8000 ? ((d << 1) ^ 0x8005) & 0xFFFF : (d << 1) & 0xFFFF;
    CRC16[i] = d;
  }
})();

function FlacFormat() {
  this.name = 'FLACReader';
  this.container = 'flac';
  this.tracks = [];
  this.resync = true;
  this.dataStart = 0;
  this.durationUs = 0;
  this._st = 0;              // 0 'fLaC', 1 metadata, 2 frames
  this._si = null;           // STREAMINFO
  this._seek = [];           // SEEKTABLE points [{ sample, offset }]
  this._fr = null;           // the frame being split: { p, h, x, c0, c1, c2 }
}

FlacFormat.prototype.ready = function () { return this._st === 2; };

FlacFormat.prototype.parse = function (win, pos, eof, emit) {
  if (this._st === 0) {
    if (!win.has(pos, 10)) { if (eof) throw _err('NOT_FLAC', 'no fLaC marker'); return pos; }
    var id3 = id3v2Size(win.peek(pos, 10), 0);
    if (id3) return pos + id3;
    if (toAscii(win.peek(pos, 4), 0, 4) !== 'fLaC') throw _err('NOT_FLAC', 'no fLaC marker');
    this._st = 1;
    return pos + 4;
  }
  if (this._st === 1) {
    if (!win.has(pos, 4)) { if (eof) throw _err('TRUNCATED', 'cut-off metadata'); return pos; }
    var bh = win.peek(pos, 4), last = bh[0] & 0x80, type = bh[0] & 0x7F, len = (bh[1] << 16) | (bh[2] << 8) | bh[3];
    if (type === 127) throw _err('BAD_METADATA', 'metadata block type 127 (forbidden)');   // RFC 9639 §8.1
    if (type === 0 || type === 3) {
      if (!win.has(pos + 4, len)) { if (eof) throw _err('TRUNCATED', 'cut-off metadata'); return pos; }
      var b = win.view(pos + 4, len);
      if (type === 0) this._streamInfo(b);
      else this._seekTable(b);
    }
    if (last) {
      if (!this._si) throw _err('NO_STREAMINFO', 'no STREAMINFO');
      this._st = 2;
      this.dataStart = pos + 4 + len;
      this._setup();
    }
    return pos + 4 + len;
  }
  return this._frames(win, pos, eof, emit);
};

FlacFormat.prototype._streamInfo = function (b) {
  if (b.length < 34) throw _err('BAD_STREAMINFO', 'STREAMINFO too short');
  var sr = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
  this._si = {
    bytes: b.slice(0, 34),
    minBlock: (b[0] << 8) | b[1], maxBlock: (b[2] << 8) | b[3],
    sampleRate: sr,
    channels: ((b[12] >> 1) & 7) + 1,
    bits: (((b[12] & 1) << 4) | (b[13] >> 4)) + 1,
    total: (b[13] & 0x0F) * 4294967296 + ((b[14] << 24) >>> 0) + (b[15] << 16) + (b[16] << 8) + b[17],
  };
  if (!sr) throw _err('BAD_STREAMINFO', 'sample rate 0');
  if (this._si.minBlock < 16 || this._si.maxBlock < 16) throw _err('BAD_STREAMINFO', 'block size under 16 (forbidden)');   // §8.2
};

FlacFormat.prototype._seekTable = function (b) {
  for (var o = 0; o + 18 <= b.length; o += 18) {
    var hi = ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
    var lo = ((b[o + 4] << 24) | (b[o + 5] << 16) | (b[o + 6] << 8) | b[o + 7]) >>> 0;
    if (hi === 0xFFFFFFFF && lo === 0xFFFFFFFF) continue;         // placeholder
    var off = (((b[o + 8] << 24) | (b[o + 9] << 16) | (b[o + 10] << 8) | b[o + 11]) >>> 0) * 4294967296 +
              (((b[o + 12] << 24) | (b[o + 13] << 16) | (b[o + 14] << 8) | b[o + 15]) >>> 0);
    this._seek.push({ sample: hi * 4294967296 + lo, offset: off });
  }
};

FlacFormat.prototype._setup = function () {
  var si = this._si;
  this.durationUs = si.total ? Math.round(si.total * 1e6 / si.sampleRate) : 0;
  var desc = new Uint8Array(4 + 4 + 34);
  desc.set([0x66, 0x4C, 0x61, 0x43, 0x80, 0, 0, 34]);   // 'fLaC', last block, STREAMINFO, 34 bytes
  desc.set(si.bytes, 8);
  this.tracks = [{
    id: 1, type: 'audio', handler: 'flac', entry: 'flac', codec: 'flac', description: desc,
    timescale: si.sampleRate, durationUs: this.durationUs, sampleCount: null, bitrate: null, startUs: 0,
    sampleRate: si.sampleRate, numberOfChannels: si.channels,
    config: { codec: 'flac', sampleRate: si.sampleRate, numberOfChannels: si.channels, description: desc },
  }];
};

/**
 * A frame header at v[o..] (§9.1): { len (header bytes, CRC-8 included),
 * variable, number, blockSize } or null.
 */
FlacFormat.prototype._header = function (v, o) {
  var n = v.length;
  if (o + 6 > n || v[o] !== 0xFF || (v[o + 1] & 0xFE) !== 0xF8) return null;
  var variable = v[o + 1] & 1;
  if (this._variable != null && variable !== this._variable) return null;
  var bsCode = v[o + 2] >> 4, srCode = v[o + 2] & 0x0F, ch = v[o + 3] >> 4, ss = (v[o + 3] >> 1) & 7;
  if (bsCode === 0 || srCode === 15 || ch > 10 || ss === 3 || (v[o + 3] & 1)) return null;
  var si = this._si;
  if ((ch < 8 ? ch + 1 : 2) !== si.channels) return null;
  if (ss && SS_CODES[ss] !== si.bits) return null;
  // the coded number: 1..7 bytes, UTF-8 style
  var p = o + 4, b0 = v[p], extra, num;
  if (b0 < 0x80) { extra = 0; num = b0; }
  else if (b0 >= 0xC0 && b0 < 0xE0) { extra = 1; num = b0 & 0x1F; }
  else if (b0 >= 0xE0 && b0 < 0xF0) { extra = 2; num = b0 & 0x0F; }
  else if (b0 >= 0xF0 && b0 < 0xF8) { extra = 3; num = b0 & 0x07; }
  else if (b0 >= 0xF8 && b0 < 0xFC) { extra = 4; num = b0 & 0x03; }
  else if (b0 >= 0xFC && b0 < 0xFE) { extra = 5; num = b0 & 0x01; }
  else if (b0 === 0xFE) { extra = 6; num = 0; }
  else return null;
  if (!variable && extra > 5) return null;                          // a frame number is at most 31 bits
  p++;
  if (p + extra > n) return null;
  for (var i = 0; i < extra; i++, p++) {
    if ((v[p] & 0xC0) !== 0x80) return null;
    num = num * 64 + (v[p] & 0x3F);
  }
  var bs;
  if (bsCode === 1) bs = 192;
  else if (bsCode <= 5) bs = 576 << (bsCode - 2);
  else if (bsCode === 6) { if (p + 1 > n) return null; bs = v[p++] + 1; }
  else if (bsCode === 7) { if (p + 2 > n) return null; bs = ((v[p] << 8) | v[p + 1]) + 1; p += 2; if (bs === 65536) return null; }   // forbidden (§9.1.6)
  else bs = 256 << (bsCode - 8);
  var sr;
  if (srCode === 0) sr = si.sampleRate;
  else if (srCode < 12) sr = SR_CODES[srCode];
  else if (srCode === 12) { if (p + 1 > n) return null; sr = v[p++] * 1000; }
  else if (srCode === 13) { if (p + 2 > n) return null; sr = (v[p] << 8) | v[p + 1]; p += 2; }
  else { if (p + 2 > n) return null; sr = ((v[p] << 8) | v[p + 1]) * 10; p += 2; }
  if (sr !== si.sampleRate) return null;
  if (p + 1 > n) return null;
  var crc = 0;
  for (var j = o; j < p; j++) crc = CRC8[crc ^ v[j]];
  if (crc !== v[p]) return null;
  return { len: p + 1 - o, variable: variable, number: num, blockSize: bs };
};

FlacFormat.prototype._frames = function (win, pos, eof, emit) {
  while (true) {
    if (!win.has(pos, 1)) return eof ? Infinity : pos;
    var v = win.view(pos, win.end() - pos);
    var f = this._fr;
    if (!f || f.p !== pos) {
      var h = v.length >= 16 || eof ? this._header(v, 0) : null;
      if (!h) {
        if (v.length < 16 && !eof) return pos;
        // not at a frame: the next valid header (junk, or a jump to an arbitrary offset)
        var q0 = this._find(v, 1);
        if (q0 < 0) return eof ? Infinity : Math.max(pos, win.end() - 16);
        pos += q0;
        continue;
      }
      if (this._variable == null) this._variable = h.variable;
      f = this._fr = { p: pos, h: h, x: 0, c0: 0, c1: 0, c2: 0 };
    }
    // Look for where it ends: the next header, the CRC-16 before it right.
    var end = -1, x = f.x, c0 = f.c0, c1 = f.c1, c2 = f.c2, min = f.h.len + 2;
    var next = f.h.variable ? f.h.number + f.h.blockSize : f.h.number + 1;
    for (; x < v.length; x++) {
      if (x >= min && v[x] === 0xFF && x + 1 < v.length && (v[x + 1] & 0xFE) === 0xF8) {
        var nh = c2 === ((v[x - 2] << 8) | v[x - 1]) || x + 16 <= v.length ? this._header(v, x) : null;
        // the frame's CRC-16 right — or (a damaged frame) the very header
        // that should come next
        if (nh && (c2 === ((v[x - 2] << 8) | v[x - 1]) || nh.number === next)) { end = x; break; }
      }
      if (x >= min && v[x] === 0xFF && x + 16 > v.length && !eof) break;   // might be a header: wait for its bytes
      c2 = c1; c1 = c0; c0 = ((c0 << 8) & 0xFFFF) ^ CRC16[(c0 >> 8) ^ v[x]];
    }
    if (end < 0) {
      if (!eof) { f.x = x; f.c0 = c0; f.c1 = c1; f.c2 = c2; return pos; }
      end = v.length;                                               // the last frame
    }
    this._fr = null;
    var hd = f.h, si = this._si;
    var sample = hd.variable ? hd.number : hd.number * (si.minBlock === si.maxBlock ? si.maxBlock : (this._nominal || (this._nominal = hd.blockSize)));
    var pts = Math.round(sample * 1e6 / si.sampleRate);
    var go = emit({
      trackId: 1, payload: v.subarray(0, end), isKeyframe: true,
      ptsUs: pts, dtsUs: pts, durationUs: Math.round((sample + hd.blockSize) * 1e6 / si.sampleRate) - pts,
      pos: pos,
    });
    pos += end;
    if (!go) return pos;
  }
};

// The first offset ≥ from in v with a valid frame header, or -1.
FlacFormat.prototype._find = function (v, from) {
  for (var i = from; i + 6 <= v.length; i++) {
    if (v[i] === 0xFF && (v[i + 1] & 0xFE) === 0xF8 && this._header(v, i)) return i;
  }
  return -1;
};

FlacFormat.prototype.reset = function () { this._fr = null; };

FlacFormat.prototype.locate = function (timeUs) {
  if (this._st !== 2 || !this._seek.length) return null;
  var target = Math.floor(timeUs * this._si.sampleRate / 1e6), best = null;
  for (var i = 0; i < this._seek.length; i++) if (this._seek[i].sample <= target) best = this._seek[i];
  if (!best) return null;
  return { pos: this.dataStart + best.offset, ptsUs: Math.round(best.sample * 1e6 / this._si.sampleRate), state: null };
};

function _err(code, msg) { var e = new Error(msg); e.code = code; return e; }

function FLACReader(opts) { FileStreamReader.call(this, new FlacFormat(), opts); }
FLACReader.prototype = Object.create(FileStreamReader.prototype);
FLACReader.prototype.constructor = FLACReader;

export default FLACReader;
