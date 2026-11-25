/**
 * reader_ivf_file — an IVF file (VP8 / VP9 / AV1): a FILE fed in pieces →
 * its frames. The API and events are reader_mp4's (see
 * reader_file_stream.js).
 *
 * The 32-byte header (its own length at bytes 6-7) gives the FourCC, the
 * size, the time base (rate / scale) and the frame count; each frame has
 * a 12-byte header (size, 64-bit timestamp in that time base). The frames
 * go through reader_ivf for the keyframe test (VP8 key_frame bit, VP9
 * uncompressed header, AV1 KEY_FRAME frame header); their times are taken
 * from the frame header here, to the nearest µs (reader_ivf floors). An
 * AV1 frame loses its leading temporal delimiter OBU, as in MP4 /
 * Matroska samples (FFmpeg's IVF packets keep its 2 bytes).
 * Frames have no duration in IVF: the frame interval of the first frames
 * (FFmpeg guesses it from the time base, which is 1 / frame rate in IVF
 * files as written).
 *
 * WebCodecs: 'vp8'; 'vp09.PP.LL.DD' — profile and bit depth from the first
 * keyframe's uncompressed header (VP9 spec §6.2), the level from the
 * VP9 level table for the picture size and frame rate (as reader_webm,
 * when nothing says it); 'av01.P.LLT.DD'
 * with the av1C built from the first keyframe's sequence header OBU (AV1
 * spec §5.5; ISO-BMFF binding §2.3) as the description.
 * info.durationUs: frame count × the time base (FFmpeg's).
 *
 * seek(): IVF has no sync pattern to find a frame from an arbitrary byte:
 * it reads (without emitting) from the last indexed keyframe before the
 * time — or the start — to the keyframe after it, then asks for the one
 * at / before it. Exact.
 */

import FileStreamReader from './reader_file_stream.js';
import IVFReader from './reader_ivf.js';
import { readU16LE, readU32LE, toAscii } from './core/bytes.js';
import { av1CFromTemporalUnit } from './utils/av1_utils.js';
import { codecStringFromAv1C, buildCodecString, vp9Level } from './utils/codec_strings.js';

function IvfFormat() {
  this.name = 'IVFReader';
  this.container = 'ivf';
  this.tracks = [];
  this.resync = false;
  this.dataStart = 0;
  this.durationUs = 0;
  this.estimateVideoDuration = true;
  this._hdr = null;
  this._r = null;
  this._ev = null;
  this._fourcc = '';
}

IvfFormat.prototype.ready = function () { return !!this._hdr && !!this.tracks[0].codec; };

IvfFormat.prototype._newReader = function () {
  var self = this;
  this._r = new IVFReader();
  this._r.on('video', function (f) { self._ev = f; });
  this._r.feed(this._hdr);
};

IvfFormat.prototype.parse = function (win, pos, eof, emit) {
  if (!this._hdr) {
    if (!win.has(pos, 32)) { if (eof) throw _err('TRUNCATED', 'no IVF header'); return pos; }
    var h = win.view(pos, 32);
    if (toAscii(h, 0, 4) !== 'DKIF') throw _err('NOT_IVF', 'not an IVF file');
    var len = Math.max(32, readU16LE(h, 6));
    if (!win.has(pos, len)) return pos;
    this._hdr = win.view(pos, len).slice();
    this._fourcc = toAscii(h, 8, 12);
    this._den = readU32LE(h, 16);
    this._num = readU32LE(h, 20);
    if (!this._den || !this._num) throw _err('BAD_HEADER', 'IVF time base 0');
    var frames = readU32LE(h, 24);
    this.durationUs = Math.round(frames * 1e6 * this._num / this._den);
    var codec = this._fourcc === 'VP80' ? 'vp8' : null;
    var w = readU16LE(h, 12), ht = readU16LE(h, 14);
    this.tracks = [{
      id: 1, type: 'video', handler: 'ivf', entry: this._fourcc, codec: codec, description: null,
      timescale: Math.round(this._den / this._num), durationUs: this.durationUs, sampleCount: frames || null,
      bitrate: null, startUs: null, codedWidth: w, codedHeight: ht, displayWidth: w, displayHeight: ht,
      rotation: 0, flip: false, colorSpace: null, frameRate: 0,
      config: codec ? { codec: codec, codedWidth: w, codedHeight: ht } : null,
    }];
    this.dataStart = pos + len;
    this._newReader();
    pos += len;
  }
  while (true) {
    if (!win.has(pos, 12)) return eof ? Infinity : pos;
    var fh = win.peek(pos, 12), size = readU32LE(fh, 0);
    if (!win.has(pos, 12 + size)) return eof ? Infinity : pos;      // a cut-off last frame isn't one
    var ts = readU32LE(fh, 8) * 4294967296 + readU32LE(fh, 4);
    this._ev = null;
    this._r.feed(win.view(pos, 12 + size));
    var f = this._ev;
    var at = pos;
    pos += 12 + size;
    if (!f) continue;
    if (f.isKeyframe && !this.tracks[0].codec) this._codec(f.payload);
    var pts = Math.round(ts * 1e6 * this._num / this._den);
    var data = this._fourcc === 'AV01' ? _noTemporalDelimiter(f.payload) : f.payload;
    if (!emit({ trackId: 1, payload: data, isKeyframe: f.isKeyframe, ptsUs: pts, dtsUs: pts, durationUs: 0, pos: at })) return pos;
  }
};

// The codec string (and AV1's av1C) from the first keyframe.
IvfFormat.prototype._codec = function (frame) {
  var t = this.tracks[0], codec = null, desc = null;
  if (this._fourcc === 'VP90') codec = _vp9String(frame, t.codedWidth, t.codedHeight, this._den / this._num);
  else if (this._fourcc === 'AV01') {
    var r = av1CFromTemporalUnit(frame);
    if (r) {
      desc = r.av1C;
      codec = codecStringFromAv1C(desc);
      if (!t.codedWidth) { t.codedWidth = t.displayWidth = r.seq.width; t.codedHeight = t.displayHeight = r.seq.height; }
    }
  }
  if (!codec) return;
  t.codec = codec;
  t.description = desc;
  t.config = { codec: codec, codedWidth: t.codedWidth, codedHeight: t.codedHeight };
  if (desc) t.config.description = desc;
};

// VP9 (spec §6.2 uncompressed_header): profile and bit depth of a
// keyframe; the level, as reader_webm picks it when nothing says it, from
// the VP9 level table (codec_strings' vp9Level: the picture size and the
// IVF time base as the frame rate — it was the size alone, by steps of
// its own: 2.1 for 160×120 at 30 fps, where FFmpeg's vpcC says 1).
function _vp9String(f, w, h, fps) {
  if (!f || f.length < 4) return null;
  var bit = 0;
  function b() { var v = (f[bit >> 3] >> (7 - (bit & 7))) & 1; bit++; return v; }
  if (b() !== 1 || b() !== 0) return null;          // frame_marker
  var lo = b(), hi = b(), profile = (hi << 1) | lo;
  if (profile === 3) b();                           // reserved_zero
  if (b()) return null;                             // show_existing_frame
  if (b() !== 0) return null;                       // frame_type: 0 = key
  b(); b();                                         // show_frame, error_resilient_mode
  for (var i = 0; i < 24; i++) b();                 // sync code
  var depth = 8;
  if (profile >= 2) depth = b() ? 12 : 10;
  var level = vp9Level(w, h, fps);
  return buildCodecString({ name: 'vp9', profile: String(profile), level: (level / 10).toFixed(1), bitDepth: depth });
}

// An AV1 temporal unit as MP4 / Matroska samples carry it (and reader_mp4
// / reader_webm emit it): without its leading temporal delimiter OBU
// (AV1-ISOBMFF §2.4 — the sample is the TU's other OBUs). IVF keeps it.
function _noTemporalDelimiter(tu) {
  if (tu.length >= 2 && ((tu[0] >> 3) & 0x0F) === 2 && (tu[0] & 0x02)) {
    var ext = (tu[0] >> 2) & 1;
    if (tu.length >= 2 + ext && tu[1 + ext] === 0) return tu.subarray(2 + ext);
  }
  return tu;
}

IvfFormat.prototype.reset = function () { if (this._hdr) this._newReader(); };

function _err(code, msg) { var e = new Error(msg); e.code = code; return e; }

function IVFFileReader(opts) { FileStreamReader.call(this, new IvfFormat(), opts); }
IVFFileReader.prototype = Object.create(FileStreamReader.prototype);
IVFFileReader.prototype.constructor = IVFFileReader;

export default IVFFileReader;
