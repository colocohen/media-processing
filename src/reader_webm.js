/**
 * reader_webm — WebM / Matroska (MKV): a FILE fed in pieces → its
 * samples, as they become available.
 *
 * The same API as reader_mp4 (MP4Reader):
 *
 *   var r = new WebMReader({ size });   // size: optional
 *   r.on('info' | 'video' | 'audio' | 'need' | 'end' | 'error', fn);
 *   r.feed(bytes, offset);              // offset: default — right after the last feed
 *   r.end();
 *   r.select(ids); r.seek(timeUs); r.progress();
 *
 * What a Matroska file is: EBML — elements of [ID][size][content], the
 * content of some being more elements (binary XML). A Segment holds the
 * Info (time scale, duration), the Tracks (codecs), then Clusters — each a
 * timestamp and the blocks (frames) of every track, in decode order —
 * and maybe Cues (an index: time → cluster) and a SeekHead (where the
 * others are).
 *
 * The blocks come in file order, so feeding in order from 0 is all it
 * takes; 'need' only comes for a seek (or Tracks after the first Cluster
 * — the SeekHead says where). 'info' waits for the first frames (the
 * start time, and a VP9 profile / bit depth are in the first keyframe);
 * the frames before it are held and emitted right after it.
 *
 * Handled: known and UNKNOWN sizes (a browser's MediaRecorder writes a
 * live file — unknown-size Segment and Clusters, no Cues, no Duration);
 * SimpleBlock and BlockGroup (ReferenceBlock → not a keyframe); all three
 * lacings (Xiph, EBML, fixed); header-stripping compression; CodecDelay
 * (Opus) taken off the audio times.
 *
 * Codecs: V_VP8, V_VP9, V_AV1, V_MPEG4/ISO/AVC, V_MPEGH/ISO/HEVC; A_OPUS,
 * A_VORBIS, A_AAC*, A_MPEG/L3, A_FLAC, A_PCM/INT/LIT, A_PCM/FLOAT/IEEE.
 * Others (and an encrypted track) come out with codec null.
 *
 * A sample: { trackId, payload, isKeyframe, ptsUs, dtsUs, durationUs }.
 * Matroska stores presentation times only — dtsUs is the ptsUs;
 * durationUs is the BlockDuration, else the track's DefaultDuration,
 * else 0 (unknown). The payload stays valid.
 *
 * info: { container: 'webm'|'matroska', brand (DocType), fragmented:
 * false, quicktime: false, durationUs (0 when the file doesn't say),
 * startUs, tracks } — a track as reader_mp4's (sampleCount / bitrate
 * null: not known before reading; rotation 0).
 *
 * seek(): from the last video keyframe at / before the time. With Cues,
 * straight to its cluster; without (a recorded file), from the first
 * cluster, reading up to the time without emitting, then back to the
 * keyframe's cluster.
 */

import EventEmitter from './core/events.js';
import FileWindow from './core/file_window.js';
import { toAscii, concat } from './core/bytes.js';
import { codecStringFromAvcC, codecStringFromHvcC } from './utils/nalu_utils.js';
import { parseAudioSpecificConfig } from './utils/aac_utils.js';
import { codecStringFromAv1C, buildCodecString } from './utils/codec_strings.js';
import { colorSpaceFromCicp } from './video_color_space.js';

var HEAD = 12;                     // the longest element header: 4-byte ID + 8-byte size

// Element IDs (with their length marker, as written)
var ID = {
  EBML: 0x1A45DFA3, DocType: 0x4282,
  Segment: 0x18538067, SeekHead: 0x114D9B74, Seek: 0x4DBB, SeekID: 0x53AB, SeekPosition: 0x53AC,
  Info: 0x1549A966, TimestampScale: 0x2AD7B1, Duration: 0x4489,
  Tracks: 0x1654AE6B, TrackEntry: 0xAE, TrackNumber: 0xD7, TrackType: 0x83, CodecID: 0x86,
  CodecPrivate: 0x63A2, DefaultDuration: 0x23E383, CodecDelay: 0x56AA,
  Video: 0xE0, PixelWidth: 0xB0, PixelHeight: 0xBA, DisplayWidth: 0x54B0, DisplayHeight: 0x54BA,
  Colour: 0x55B0, MatrixCoefficients: 0x55B1, Range: 0x55B9, TransferCharacteristics: 0x55BA, Primaries: 0x55BB,
  Audio: 0xE1, SamplingFrequency: 0xB5, Channels: 0x9F, BitDepth: 0x6264,
  ContentEncodings: 0x6D80, ContentEncoding: 0x6240, ContentCompression: 0x5034,
  ContentCompAlgo: 0x4254, ContentCompSettings: 0x4255, ContentEncryption: 0x5035,
  Cues: 0x1C53BB6B, CuePoint: 0xBB, CueTime: 0xB3, CueTrackPositions: 0xB7, CueTrack: 0xF7,
  CueClusterPosition: 0xF1,
  Cluster: 0x1F43B675, Timestamp: 0xE7, SimpleBlock: 0xA3, BlockGroup: 0xA0, Block: 0xA1,
  BlockDuration: 0x9B, ReferenceBlock: 0xFB,
  Tags: 0x1254C367, Chapters: 0x1043A770, Attachments: 0x1941A469,
};
// A Segment's children — what ends an unknown-size Cluster.
var TOP = {};
[ID.Cluster, ID.Cues, ID.Tags, ID.Chapters, ID.Attachments, ID.SeekHead, ID.Info, ID.Tracks]
  .forEach(function (id) { TOP[id] = true; });


// ── EBML primitives ──

// An element header at `off` in buf: { id, size (-1 unknown), dataStart } | null
function _head(buf, off) {
  if (off >= buf.length) return null;
  var b = buf[off], idLen = 1;
  while (idLen <= 4 && !(b & (0x80 >> (idLen - 1)))) idLen++;
  if (idLen > 4 || off + idLen > buf.length) return null;
  var id = 0;
  for (var i = 0; i < idLen; i++) id = id * 256 + buf[off + i];
  var p = off + idLen;
  if (p >= buf.length) return null;
  var s0 = buf[p], sLen = 1;
  while (sLen <= 8 && !(s0 & (0x80 >> (sLen - 1)))) sLen++;
  if (sLen > 8 || p + sLen > buf.length) return null;
  var size = s0 & (0xFF >> sLen), allOnes = size === (0xFF >> sLen);
  for (var j = 1; j < sLen; j++) {
    size = size * 256 + buf[p + j];
    if (buf[p + j] !== 0xFF) allOnes = false;
  }
  return { id: id, size: allOnes ? -1 : size, dataStart: p + sLen };
}

// The children of [from, to) → [{ id, start, end }] (known sizes only).
function _kids(buf, from, to) {
  var out = [], off = from;
  while (off < to) {
    var h = _head(buf, off);
    if (!h || h.size < 0 || h.dataStart + h.size > to) break;
    out.push({ id: h.id, start: h.dataStart, end: h.dataStart + h.size });
    off = h.dataStart + h.size;
  }
  return out;
}
function _kid(kids, id) { for (var i = 0; i < kids.length; i++) if (kids[i].id === id) return kids[i]; return null; }
function _uint(buf, e) { var v = 0; for (var i = e.start; i < e.end; i++) v = v * 256 + buf[i]; return v; }
function _float(buf, e) {
  var dv = new DataView(buf.buffer, buf.byteOffset + e.start, e.end - e.start);
  return e.end - e.start === 4 ? dv.getFloat32(0) : e.end - e.start === 8 ? dv.getFloat64(0) : 0;
}
function _str(buf, e) { var s = toAscii(buf, e.start, e.end); var z = s.indexOf('\0'); return z < 0 ? s : s.slice(0, z); }

// A size-coded integer inside a block (no ID marker kept): { value, len }
function _vint(buf, off) {
  var b = buf[off], len = 1;
  while (len <= 8 && !(b & (0x80 >> (len - 1)))) len++;
  var v = b & (0xFF >> len);
  for (var i = 1; i < len; i++) v = v * 256 + buf[off + i];
  return { value: v, len: len };
}


function WebMReader(opts) {
  if (!opts) opts = {};
  this._ee = new EventEmitter();
  this._size = opts.size || 0;
  this._win = new FileWindow();
  this._pos = 0;                 // the next element
  this._busy = false;            // inside _process (a listener calling back in)
  this._again = false;
  this._phase = 'ebml';          // 'ebml' → 'segment' → 'body'
  this._segStart = 0;
  this._segEnd = Infinity;
  this._seeks = {};              // SeekHead: element id → position in the segment
  this._tracks = [];
  this._byNum = {};
  this._selected = [];
  this._scale = 1000000;         // ns per timestamp unit
  this._info = { container: 'webm', brand: '', fragmented: false, quicktime: false, durationUs: 0, startUs: 0, tracks: [] };
  this._infoSent = false;
  this._early = [];              // samples before 'info' (it waits for the first frames)
  this._earlyBytes = 0;
  this._firstCluster = -1;
  this._inCluster = false;
  this._clusterEnd = 0;
  this._clusterTs = 0;
  this._clusterPos = 0;
  this._cues = null;
  this._fromUs = null;           // after a seek: what's before it, dropped
  this._scan = null;             // a seek without Cues, looking for its keyframe
  this._cuesFor = null;          // a seek waiting for the Cues (read from the SeekHead's place)
  this._resume = -1;             // Tracks after the first Cluster: where to come back to
  this._askedAt = -1;
  this._ended = false;
  this._failed = false;
}

WebMReader.prototype.on  = function (ev, fn) { this._ee.on(ev, fn); return this; };
WebMReader.prototype.off = function (ev, fn) { this._ee.off(ev, fn); return this; };

WebMReader.prototype.feed = function (bytes, offset) {
  if (this._ended || this._failed) return;
  this._win.add(bytes, offset);
  if (this._askedAt >= 0 && this._win.has(this._askedAt, 1)) this._askedAt = -1;
  this._process();
};

WebMReader.prototype.end = function () {
  if (this._ended || this._failed) return;
  if (this._scan) { this._endScan(); if (!this._ended) return; }
  if (!this._infoSent) {
    if (!this._tracks.length) return this._fail('TRUNCATED', 'the file ended before its tracks');
    this._sendInfo();
  }
  this._finish();
};

WebMReader.prototype._fail = function (code, message) {
  this._failed = true;
  var e = new Error('WebMReader: ' + message);
  e.code = code;
  this._ee.emit('error', e);
};

WebMReader.prototype._finish = function () {
  if (this._ended) return;
  if (!this._infoSent && this._tracks.length) this._sendInfo();
  this._ended = true;
  this._ee.emit('end');
};

WebMReader.prototype._want = function (offset, length, jump) {
  if (this._askedAt === offset || this._win.has(offset, 1)) return;
  if (!jump && !this._win.mustAsk(offset)) return;
  this._askedAt = offset;
  this._ee.emit('need', { offset: offset, length: length || 0 });
};

// Go on from `pos` (a jump: ask for it).
WebMReader.prototype._jump = function (pos) {
  this._pos = pos;
  this._inCluster = false;
  this._win.trim(pos);
  this._askedAt = -1;
  this._want(pos, HEAD, true);
};


// =========================================================================
// Parsing what's fed, element by element
// =========================================================================

/**
 * Run as far as the bytes go. Called again from inside a listener (a
 * select / seek / feed from 'info', a sample or 'need'): the running pass
 * takes it up — one more round once it's done — never a pass inside a pass.
 */
WebMReader.prototype._process = function () {
  if (this._busy) { this._again = true; return; }
  this._busy = true;
  try {
    do { this._again = false; this._run(); } while (this._again && !this._failed);
  } finally {
    this._busy = false;
  }
};

WebMReader.prototype._run = function () {
  while (!this._failed && !this._ended) {
    if (this._pos >= this._segEnd || (this._size && this._pos >= this._size)) {
      if (this._scan) { this._endScan(); continue; }
      return this._finish();
    }
    var r = this._step();
    this._win.trim(this._pos);
    if (r === 'wait') return;
  }
};

// One element. 'wait': its bytes aren't here yet.
WebMReader.prototype._step = function () {
  var pos = this._pos, win = this._win;
  var headLen = this._size ? Math.min(HEAD, this._size - pos) : HEAD;
  if (!win.has(pos, Math.min(headLen, 2))) { this._want(pos, HEAD); return 'wait'; }
  var hb = win.peek(pos, HEAD);
  var h = _head(hb, 0);
  if (!h) {
    if (hb.length < headLen) { this._want(pos, HEAD); return 'wait'; }
    this._fail('BAD_ELEMENT', 'a bad element at ' + pos);
    return 'wait';
  }
  var dataStart = pos + h.dataStart;

  if (this._phase === 'ebml') {
    if (h.id !== ID.EBML || h.size < 0) { this._fail('NOT_EBML', 'not a WebM / Matroska file'); return 'wait'; }
    if (!win.has(dataStart, h.size)) { this._want(dataStart, h.size); return 'wait'; }
    var eb = win.view(dataStart, h.size);
    var dt = _kid(_kids(eb, 0, eb.length), ID.DocType);
    this._info.brand = dt ? _str(eb, dt) : '';
    this._info.container = this._info.brand === 'matroska' ? 'matroska' : 'webm';
    this._phase = 'segment';
    this._pos = dataStart + h.size;
    return 'ok';
  }
  if (this._phase === 'segment') {
    if (h.id !== ID.Segment) { this._fail('NO_SEGMENT', 'no Segment'); return 'wait'; }
    this._segStart = dataStart;
    this._segEnd = h.size < 0 ? Infinity : dataStart + h.size;
    if (this._size && this._segEnd > this._size) this._segEnd = this._size;
    this._phase = 'body';
    this._pos = dataStart;
    return 'ok';
  }

  // An unknown-size cluster ends where the next top-level element starts.
  if (this._inCluster && (pos >= this._clusterEnd || TOP[h.id])) this._inCluster = false;

  if (h.id === ID.Cluster) {
    if (this._firstCluster < 0) {
      this._firstCluster = pos;
      if (!this._tracks.length) {
        // The Tracks are later (the SeekHead says where) — read them, then back.
        if (this._seeks[ID.Tracks] == null) { this._fail('NO_TRACKS', 'no Tracks before the first Cluster'); return 'wait'; }
        this._resume = pos;
        this._jump(this._segStart + this._seeks[ID.Tracks]);
        return 'ok';
      }
    }
    this._inCluster = true;
    this._clusterPos = pos;
    this._clusterEnd = h.size < 0 ? Infinity : dataStart + h.size;
    this._pos = dataStart;
    return 'ok';
  }
  if (h.size < 0) { this._pos = this._segEnd; return 'ok'; }   // nothing past an unknown-size non-cluster
  var end = dataStart + h.size;

  if (!this._inCluster) {
    if (h.id === ID.SeekHead || h.id === ID.Info || h.id === ID.Tracks || h.id === ID.Cues) {
      if (!win.has(dataStart, h.size)) { this._want(dataStart, h.size); return 'wait'; }
      this._apply(h.id, win.view(dataStart, h.size));
      this._pos = end;
      if (h.id === ID.Tracks && this._resume >= 0) { var back = this._resume; this._resume = -1; this._jump(back); }
      else if (h.id === ID.Cues && this._cuesFor != null) { var t = this._cuesFor; this._cuesFor = null; this.seek(t); }
      return 'ok';
    }
    // Tags, Chapters, Attachments, Void, …: past it (a jump if it's big).
    this._pos = end;
    if (h.size > HEAD) { win.trim(end); this._want(end, HEAD, h.size > 64 * 1024); }
    return 'ok';
  }

  if (h.id !== ID.Timestamp && h.id !== ID.SimpleBlock && h.id !== ID.BlockGroup) { this._pos = end; return 'ok'; }
  if (!win.has(dataStart, h.size)) { this._want(dataStart, h.size); return 'wait'; }
  var b = win.view(dataStart, h.size), out = [];
  if (h.id === ID.Timestamp) {
    this._clusterTs = _uint(b, { start: 0, end: b.length });
  } else if (h.id === ID.SimpleBlock) {
    this._block(b, 0, b.length, null, null, out);
  } else {
    var gk = _kids(b, 0, b.length), blk = _kid(gk, ID.Block), bd = _kid(gk, ID.BlockDuration);
    if (blk) this._block(b, blk.start, blk.end, !_kid(gk, ID.ReferenceBlock), bd ? _uint(b, bd) : null, out);
  }
  this._pos = end;
  if (this._scan && this._scan.done) { this._endScan(); return 'ok'; }
  for (var i = 0; i < out.length && !this._ended; i++) this._deliver(out[i]);
  return 'ok';
};

// A sample: out, or (before 'info') kept until it can go.
WebMReader.prototype._deliver = function (s) {
  if (this._infoSent) {
    var t = this._byNum[s.trackId];
    if (this._selected.indexOf(t) === -1) return;
    var type = s.type; delete s.type;
    this._ee.emit(type, s);
    return;
  }
  this._early.push(s);
  this._earlyBytes += s.payload.length;
  var t2 = this._byNum[s.trackId];
  if (!t2.seen) {
    t2.seen = true;
    t2.startUs = s.ptsUs;
    if (t2.codecId === 'V_VP9' && s.isKeyframe) _vp9FromFrame(t2, s.payload);
  }
  // 'info' once every track that will be read has a first frame — or
  // enough has gone by that one of them has none.
  var waiting = this._tracks.some(function (t) { return (t.type === 'video' || t.type === 'audio') && t.codec && !t.seen; });
  if (!waiting || this._earlyBytes > (1 << 20) || this._early.length > 300) this._sendInfo();
};

WebMReader.prototype._sendInfo = function () {
  if (this._infoSent) return;
  var info = this._info, self = this;
  var v = this._tracks.filter(function (t) { return t.type === 'video' && t.seen; })[0];
  var a = this._tracks.filter(function (t) { return t.type === 'audio' && t.seen; })[0];
  info.startUs = v ? v.startUs : a ? a.startUs : 0;
  info.tracks = this._tracks.map(_publicTrack);
  this._infoSent = true;
  this.select(null);
  var gen = this._seekGen;
  this._ee.emit('info', info);
  var early = this._early;
  this._early = []; this._earlyBytes = 0;
  // A seek from the 'info' listener: the frames held are from before it.
  if (gen !== this._seekGen) return;
  for (var i = 0; i < early.length && !this._ended; i++) this._deliver(early[i]);
  void self;
};


// ── Header elements ──

WebMReader.prototype._apply = function (id, buf) {
  var self = this, info = this._info, seeks = this._seeks;
  var kids = _kids(buf, 0, buf.length);
  if (id === ID.SeekHead) {
    kids.forEach(function (s) {
      if (s.id !== ID.Seek) return;
      var sk = _kids(buf, s.start, s.end), sid = _kid(sk, ID.SeekID), pos = _kid(sk, ID.SeekPosition);
      if (sid && pos) seeks[_uint(buf, sid)] = _uint(buf, pos);
    });
  } else if (id === ID.Info) {
    var sc = _kid(kids, ID.TimestampScale);
    if (sc) this._scale = _uint(buf, sc) || 1000000;
    var du = _kid(kids, ID.Duration);
    if (du) info.durationUs = Math.round(_float(buf, du) * this._scale / 1000);
  } else if (id === ID.Tracks) {
    kids.forEach(function (te) {
      if (te.id !== ID.TrackEntry) return;
      var t = _track(buf, te);
      if (t) { self._tracks.push(t); self._byNum[t.id] = t; }
    });
  } else if (id === ID.Cues) {
    this._cues = [];
    kids.forEach(function (cp) {
      if (cp.id !== ID.CuePoint) return;
      var ck = _kids(buf, cp.start, cp.end), time = _kid(ck, ID.CueTime);
      if (!time) return;
      ck.forEach(function (tp) {
        if (tp.id !== ID.CueTrackPositions) return;
        var tk = _kids(buf, tp.start, tp.end), tr = _kid(tk, ID.CueTrack), pos = _kid(tk, ID.CueClusterPosition);
        if (tr && pos) self._cues.push({ track: _uint(buf, tr), timeUs: Math.round(_uint(buf, time) * self._scale / 1000), pos: _uint(buf, pos) });
      });
    });
  }
};

function _track(buf, te) {
  var k = _kids(buf, te.start, te.end);
  var num = _kid(k, ID.TrackNumber), type = _kid(k, ID.TrackType), cid = _kid(k, ID.CodecID);
  if (!num || !type || !cid) return null;
  var tt = _uint(buf, type);
  var t = {
    id: _uint(buf, num), type: tt === 1 ? 'video' : tt === 2 ? 'audio' : 'other',
    codecId: _str(buf, cid), codec: null, description: null,
    defaultDurationUs: 0, codecDelayUs: 0, strip: null, encrypted: false,
    codedWidth: 0, codedHeight: 0, displayWidth: 0, displayHeight: 0, colorSpace: null,
    sampleRate: 0, numberOfChannels: 0, bitDepth: 0, startUs: 0,
  };
  var priv = _kid(k, ID.CodecPrivate);
  if (priv) t.description = buf.slice(priv.start, priv.end);
  var dd = _kid(k, ID.DefaultDuration);
  if (dd) t.defaultDurationUs = Math.round(_uint(buf, dd) / 1000);
  var cd = _kid(k, ID.CodecDelay);
  if (cd) t.codecDelayUs = Math.round(_uint(buf, cd) / 1000);

  var v = _kid(k, ID.Video);
  if (v) {
    var vk = _kids(buf, v.start, v.end), g = function (id) { var e = _kid(vk, id); return e ? _uint(buf, e) : 0; };
    t.codedWidth = g(ID.PixelWidth); t.codedHeight = g(ID.PixelHeight);
    t.displayWidth = g(ID.DisplayWidth) || t.codedWidth; t.displayHeight = g(ID.DisplayHeight) || t.codedHeight;
    var col = _kid(vk, ID.Colour);
    if (col) {
      var ck = _kids(buf, col.start, col.end), c = function (id) { var e = _kid(ck, id); return e ? _uint(buf, e) : 2; };
      var range = _kid(ck, ID.Range);
      t.colorSpace = colorSpaceFromCicp(c(ID.Primaries), c(ID.TransferCharacteristics), c(ID.MatrixCoefficients),
                                        range ? (_uint(buf, range) === 2 ? true : _uint(buf, range) === 1 ? false : null) : null);
    }
  }
  var a = _kid(k, ID.Audio);
  if (a) {
    var ak = _kids(buf, a.start, a.end);
    var sf = _kid(ak, ID.SamplingFrequency), ch = _kid(ak, ID.Channels), bd = _kid(ak, ID.BitDepth);
    t.sampleRate = sf ? Math.round(_float(buf, sf)) : 8000;
    t.numberOfChannels = ch ? _uint(buf, ch) : 1;
    t.bitDepth = bd ? _uint(buf, bd) : 0;
  }
  var enc = _kid(k, ID.ContentEncodings);
  if (enc) {
    _kids(buf, enc.start, enc.end).forEach(function (ce) {
      if (ce.id !== ID.ContentEncoding) return;
      var cek = _kids(buf, ce.start, ce.end);
      if (_kid(cek, ID.ContentEncryption)) t.encrypted = true;
      var comp = _kid(cek, ID.ContentCompression);
      if (comp) {
        var cc = _kids(buf, comp.start, comp.end), algo = _kid(cc, ID.ContentCompAlgo), set = _kid(cc, ID.ContentCompSettings);
        // 3 = header stripping (the bytes stripped from every frame); 0 zlib — not here.
        if (algo && _uint(buf, algo) === 3 && set) t.strip = buf.slice(set.start, set.end);
        else t.encrypted = true;   // can't read it either way
      }
    });
  }
  _codec(t);
  return t;
}

function _codec(t) {
  if (t.encrypted) return;
  var id = t.codecId, d = t.description;
  if (id === 'V_VP8') t.codec = 'vp8';
  else if (id === 'V_VP9') { t.codec = 'vp09.00.10.08'; t.description = null; }   // refined from the first keyframe
  else if (id === 'V_AV1') t.codec = d ? codecStringFromAv1C(d) : null;
  else if (id === 'V_MPEG4/ISO/AVC') t.codec = d ? codecStringFromAvcC(d, 'avc1') : null;
  else if (id === 'V_MPEGH/ISO/HEVC') t.codec = d ? codecStringFromHvcC(d, 'hvc1') : null;
  else if (id === 'A_OPUS') t.codec = 'opus';             // CodecPrivate is the OpusHead
  else if (id === 'A_VORBIS') t.codec = 'vorbis';         // CodecPrivate: the three headers, Xiph-laced
  else if (id === 'A_FLAC') t.codec = 'flac';             // CodecPrivate: 'fLaC' + metadata blocks
  else if (id === 'A_MPEG/L3') { t.codec = 'mp3'; t.description = null; }
  else if (id.indexOf('A_AAC') === 0) {
    var asc = d && parseAudioSpecificConfig(d);
    t.codec = 'mp4a.40.' + ((asc && asc.objectType) || 2);
    if (asc) { if (asc.sampleRate) t.sampleRate = asc.sampleRate; if (asc.channels) t.numberOfChannels = asc.channels; }
  }
  else if (id === 'A_PCM/INT/LIT') { t.codec = t.bitDepth === 8 ? 'pcm-u8' : 'pcm-s' + (t.bitDepth || 16); t.description = null; }
  else if (id === 'A_PCM/FLOAT/IEEE') { t.codec = 'pcm-f32'; t.description = null; }
}

// VP9: profile and bit depth from a keyframe's uncompressed header
// (VP9 bitstream spec §6.2) — a WebM CodecPrivate rarely says.
function _vp9FromFrame(t, f) {
  if (!f || f.length < 4) return;
  var bit = 0;
  function b() { var v = (f[bit >> 3] >> (7 - (bit & 7))) & 1; bit++; return v; }
  if (b() !== 1 || b() !== 0) return;               // frame_marker
  var lo = b(), hi = b(), profile = (hi << 1) | lo;
  if (profile === 3) b();                           // reserved_zero
  if (b()) return;                                  // show_existing_frame
  if (b() !== 0) return;                            // frame_type: 0 = key
  b(); b();                                         // show_frame, error_resilient_mode
  for (var i = 0; i < 24; i++) b();                 // sync code
  var depth = 8;
  if (profile >= 2) depth = b() ? 12 : 10;
  var level = 10;   // not in the frame: a safe level for the size
  var px = (t.codedWidth || 0) * (t.codedHeight || 0);
  if (px > 1920 * 1080) level = 51; else if (px > 1280 * 720) level = 41; else if (px > 640 * 360) level = 31; else if (px) level = 21;
  t.codec = buildCodecString({ name: 'vp9', profile: String(profile), level: (level / 10).toFixed(1), bitDepth: depth });
}

function _publicTrack(t) {
  var p = {
    id: t.id, type: t.type, handler: t.codecId, entry: t.codecId, codec: t.codec,
    description: t.description, timescale: 1e6, durationUs: 0,
    sampleCount: null, bitrate: null, startUs: t.startUs, config: null,
  };
  if (t.type === 'video') {
    p.codedWidth = t.codedWidth; p.codedHeight = t.codedHeight;
    p.displayWidth = t.displayWidth; p.displayHeight = t.displayHeight;
    p.rotation = 0; p.colorSpace = t.colorSpace;
    p.frameRate = t.defaultDurationUs ? Math.round(1e8 / t.defaultDurationUs) / 100 : 0;
    if (t.codec) {
      p.config = { codec: t.codec, codedWidth: t.codedWidth, codedHeight: t.codedHeight };
      if (t.description) p.config.description = t.description;
      if (t.colorSpace) p.config.colorSpace = t.colorSpace;
    }
  } else if (t.type === 'audio') {
    p.sampleRate = t.sampleRate; p.numberOfChannels = t.numberOfChannels;
    if (t.codec) {
      p.config = { codec: t.codec, sampleRate: t.sampleRate, numberOfChannels: t.numberOfChannels };
      if (t.description) p.config.description = t.description;
    }
  }
  return p;
}


// One block → its frames into out. key: null = from the SimpleBlock flags.
WebMReader.prototype._block = function (b, s, e, key, durTicks, out) {
  var tn = _vint(b, s), t = this._byNum[tn.value];
  if (!t || !t.codec) return 0;
  var p = s + tn.len;
  var rel = (b[p] << 8) | b[p + 1]; if (rel & 0x8000) rel -= 0x10000;
  var flags = b[p + 2]; p += 3;
  var isKey = key == null ? !!(flags & 0x80) : key;
  if (t.type === 'audio') isKey = true;

  // Frames: one, or laced (Xiph / EBML / fixed).
  var sizes = [], lacing = (flags >> 1) & 3;
  if (lacing === 0) sizes.push(e - p);
  else {
    var n = b[p++] + 1, total = 0, i;
    if (lacing === 1) {
      for (i = 0; i < n - 1; i++) { var sz = 0, x; do { x = b[p++]; sz += x; } while (x === 255); sizes.push(sz); total += sz; }
    } else if (lacing === 3) {
      var first = _vint(b, p); p += first.len; sizes.push(first.value); total = first.value;
      for (i = 1; i < n - 1; i++) {
        var dv = _vint(b, p); p += dv.len;
        var delta = dv.value - (Math.pow(2, 7 * dv.len - 1) - 1);
        var next = sizes[i - 1] + delta; sizes.push(next); total += next;
      }
    } else {
      var each = Math.floor((e - p) / n);
      for (i = 0; i < n - 1; i++) { sizes.push(each); total += each; }
    }
    sizes.push(e - p - total);
  }

  var baseUs = Math.round((this._clusterTs + rel) * this._scale / 1000);
  var durUs = durTicks != null ? Math.round(durTicks * this._scale / 1000) : t.defaultDurationUs;
  var frameDur = sizes.length > 1 ? (t.defaultDurationUs || Math.round(durUs / sizes.length)) : durUs;
  var got = 0;
  for (var f = 0; f < sizes.length; f++) {
    var payload = b.subarray(p, p + sizes[f]);
    p += sizes[f];
    if (t.strip) payload = concat([t.strip, payload]);
    var pts = baseUs + f * frameDur - (t.type === 'audio' ? t.codecDelayUs : 0);
    // seek without cues: nothing before the first video keyframe at / after the time
    if (this._scan) {
      // Seeking without an index: remember the last video keyframe at /
      // before the time (its cluster); past the time, read() goes back there.
      if (t.type === 'video' && isKey && pts <= this._scan.target) this._scan.key = { pos: this._clusterPos, pts: pts };
      if (t.type === 'video' && pts > this._scan.target) this._scan.done = true;
      continue;
    }
    // After a seek: video from the keyframe; audio from the frame that's
    // playing then (one of unknown length: taken as up to 60 ms).
    if (this._fromUs != null && (t.type === 'audio' ? pts + (frameDur || 60000) <= this._fromUs : pts < this._fromUs)) continue;
    out.push({ trackId: t.id, type: t.type, payload: payload, isKeyframe: isKey,
               ptsUs: pts, dtsUs: pts, durationUs: frameDur });
    got += payload.length;
  }
  return got;
};

// =========================================================================
// select, seek, progress
// =========================================================================

/** The tracks to emit samples of (null → the first video + the first audio with a codec). */
WebMReader.prototype.select = function (ids) {
  if (ids) {
    this._selected = this._tracks.filter(function (t) { return ids.indexOf(t.id) !== -1; });
    return;
  }
  var v = null, a = null;
  this._tracks.forEach(function (t) {
    if (!v && t.type === 'video' && t.codec) v = t;
    if (!a && t.type === 'audio' && t.codec) a = t;
  });
  this._selected = [v, a].filter(Boolean);
};

/**
 * From the last video keyframe at / before timeUs. With Cues, straight to
 * its cluster (a 'need'); Cues somewhere else in the file (the SeekHead
 * says) — those first. No Cues (a recorded file): from the first cluster,
 * reading up to the time without emitting, then back to the keyframe's
 * cluster (two 'need's).
 */
WebMReader.prototype.seek = function (timeUs) {
  if (!this._infoSent) throw new Error('WebMReader: seek() after info');
  this._seekGen = (this._seekGen || 0) + 1;
  this._ended = false;
  this._scan = null;
  var v = this._selected.filter(function (t) { return t.type === 'video'; })[0];
  if (!this._cues && this._seeks[ID.Cues] != null && this._cuesFor == null) {
    this._cuesFor = timeUs;
    this._jump(this._segStart + this._seeks[ID.Cues]);
    return this._process();
  }
  var cues = (this._cues || []).filter(function (c) { return !v || c.track === v.id; });
  if (cues.length) {
    var best = null;
    cues.forEach(function (c) { if (c.timeUs <= timeUs && (!best || c.timeUs > best.timeUs)) best = c; });
    if (!best) best = cues[0];
    this._fromUs = best.timeUs;
    this._jump(this._segStart + best.pos);
    return this._process();
  }
  this._fromUs = null;
  if (v) this._scan = { target: timeUs, key: null, done: false };
  else this._fromUs = timeUs;
  this._jump(this._firstCluster);
  this._process();
};

// The scan of a seek without Cues is over: back to the keyframe's cluster.
WebMReader.prototype._endScan = function () {
  var key = this._scan.key;
  this._scan = null;
  this._fromUs = key ? key.pts : null;
  this._jump(key ? key.pos : this._firstCluster);
};

/** 0..1 — how far into the file the reading has got. */
WebMReader.prototype.progress = function () {
  var end = this._segEnd !== Infinity ? this._segEnd : this._size;
  var span = end - this._firstCluster;
  return this._firstCluster >= 0 && span > 0 ? Math.min(1, Math.max(0, (this._pos - this._firstCluster) / span)) : 0;
};

export default WebMReader;
