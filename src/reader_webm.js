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
 * lacings (Xiph, EBML, fixed; a lace that does not add up is dropped);
 * header-stripping compression (ContentEncodingScope / Order); CodecDelay
 * taken off the times, TrackTimestampScale applied; Info / Tracks after
 * the first Cluster (the SeekHead — or a second one — says where).
 *
 * Codecs: V_VP8, V_VP9, V_AV1, V_MPEG4/ISO/AVC, V_MPEGH/ISO/HEVC; A_OPUS,
 * A_VORBIS, A_AAC (and the A_AAC/MPEG2|4/… IDs), A_MPEG/L3, A_FLAC,
 * A_PCM/INT/LIT, A_PCM/INT/BIG, A_PCM/FLOAT/IEEE. Others (and an
 * encrypted or zlib-compressed track) come out with codec null; their
 * blocks go out as they are when the track is selected ('other' for a
 * track neither video nor audio).
 *
 * A sample: { trackId, payload, isKeyframe, ptsUs, dtsUs, durationUs }
 * (+ discardPaddingUs: a BlockGroup's DiscardPadding — positive: that much
 * of the frame's end is padding, negative: of its start).
 * Matroska stores presentation times only — dtsUs is the ptsUs;
 * durationUs is the BlockDuration, else the track's DefaultDuration,
 * else (audio; VP8 / VP9 / AV1, which do not reorder) the time to the
 * track's next block — RFC 9559's default — else 0 (unknown). Such a
 * block goes out when the next one is read. The payload stays valid.
 *
 * info: { container: 'webm'|'matroska', brand (DocType), fragmented:
 * false, quicktime: false, durationUs (0 when the file doesn't say),
 * startUs, tracks } — a track as reader_mp4's (sampleCount / bitrate
 * null: not known before reading; rotation / flip from the Projection;
 * bigEndian for PCM).
 *
 * seek(): from the last video keyframe at / before the time (audio from
 * the frame playing then, less its SeekPreRoll). With Cues, straight to
 * its cluster; without (a recorded file), from the first cluster,
 * reading up to the time without emitting, then back to the keyframe's
 * cluster.
 */

import EventEmitter from './core/events.js';
import FileWindow from './core/file_window.js';
import { toAscii, concat } from './core/bytes.js';
import { codecStringFromAvcC, codecStringFromHvcC } from './utils/nalu_utils.js';
import { parseAudioSpecificConfig } from './utils/aac_utils.js';
import { codecStringFromAv1C, buildCodecString, vp9Level } from './utils/codec_strings.js';
import { colorSpaceFromCicp } from './video_color_space.js';

var HEAD = 12;                     // the longest element header: 4-byte ID + 8-byte size

// Element IDs (with their length marker, as written)
var ID = {
  EBML: 0x1A45DFA3, DocType: 0x4282, EBMLReadVersion: 0x42F7, EBMLMaxIDLength: 0x42F2, EBMLMaxSizeLength: 0x42F3,
  DocTypeReadVersion: 0x4285, Void: 0xEC,
  Segment: 0x18538067, SeekHead: 0x114D9B74, Seek: 0x4DBB, SeekID: 0x53AB, SeekPosition: 0x53AC,
  Info: 0x1549A966, TimestampScale: 0x2AD7B1, Duration: 0x4489,
  Tracks: 0x1654AE6B, TrackEntry: 0xAE, TrackNumber: 0xD7, TrackType: 0x83, CodecID: 0x86,
  CodecPrivate: 0x63A2, DefaultDuration: 0x23E383, CodecDelay: 0x56AA, SeekPreRoll: 0x56BB, TrackTimestampScale: 0x23314F,
  Video: 0xE0, PixelWidth: 0xB0, PixelHeight: 0xBA, DisplayWidth: 0x54B0, DisplayHeight: 0x54BA, DisplayUnit: 0x54B2,
  PixelCropBottom: 0x54AA, PixelCropTop: 0x54BB, PixelCropLeft: 0x54CC, PixelCropRight: 0x54DD,
  Colour: 0x55B0, MatrixCoefficients: 0x55B1, Range: 0x55B9, TransferCharacteristics: 0x55BA, Primaries: 0x55BB,
  Projection: 0x7670, ProjectionType: 0x7671, ProjectionPoseYaw: 0x7673, ProjectionPosePitch: 0x7674, ProjectionPoseRoll: 0x7675,
  Audio: 0xE1, SamplingFrequency: 0xB5, OutputSamplingFrequency: 0x78B5, Channels: 0x9F, BitDepth: 0x6264,
  ContentEncodings: 0x6D80, ContentEncoding: 0x6240, ContentEncodingOrder: 0x5031, ContentEncodingScope: 0x5032, ContentCompression: 0x5034,
  ContentCompAlgo: 0x4254, ContentCompSettings: 0x4255, ContentEncryption: 0x5035,
  Cues: 0x1C53BB6B, CuePoint: 0xBB, CueTime: 0xB3, CueTrackPositions: 0xB7, CueTrack: 0xF7,
  CueClusterPosition: 0xF1,
  Cluster: 0x1F43B675, Timestamp: 0xE7, SimpleBlock: 0xA3, BlockGroup: 0xA0, Block: 0xA1,
  BlockDuration: 0x9B, ReferenceBlock: 0xFB, DiscardPadding: 0x75A2,
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
// A signed integer element (two's complement, big-endian).
function _sint(buf, e) { var v = _uint(buf, e), n = e.end - e.start; return n && (buf[e.start] & 0x80) ? v - Math.pow(2, 8 * n) : v; }
// A child's value, or `def` when it is absent — or EMPTY: RFC 8794 §6.3,
// an empty element is its default value. (Channels, Colour, … of 0 bytes
// were read as 0: an empty Channels gave 0 channels, FFmpeg 1.)
function _num(buf, kids, id, def) { var e = _kid(kids, id); return e && e.end > e.start ? _uint(buf, e) : def; }
function _flt(buf, kids, id, def) { var e = _kid(kids, id); return e && e.end > e.start ? _float(buf, e) : def; }
// An unsigned long (WebIDL: 0 … 2^32 − 1) out of a number read, else `def`.
function _u32(v, def) { return v >= 0 && v <= 0xFFFFFFFF ? v : def; }

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
  this._infoRead = false;        // the Info element applied
  this._tracksRead = false;      // the Tracks element applied (once: a later copy would replace the tracks selected)
  this._seekHeads = [];          // a second SeekHead (RFC 9559 §6.3): where — and which were read
  this._seekHeadsRead = {};
  this._held = [];               // per track, the block waiting for the next one (its duration)
  this._seekGen = 0;
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
  this._fetch = null;            // Info / Tracks after the first Cluster: { ids still to read, back: the first Cluster }
  this._expect = null;           // what a SeekHead says is at a position: { pos, id }
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
  if (!this._infoSent && !this._tracks.length) return this._fail('TRUNCATED', 'the file ended before its tracks');
  this._finish();
};

WebMReader.prototype._fail = function (code, message) {
  this._failed = true;
  var e = new Error('WebMReader: ' + message);
  e.code = code;
  this._ee.emit('error', e);
};

// The end: the blocks held for their duration go out (theirs unknown),
// 'info' if it hasn't come, 'end'. (A Segment with no Tracks ended with
// 'end' alone — no 'info', no error.) A seek from a listener goes on
// instead.
WebMReader.prototype._finish = function () {
  if (this._ended) return;
  var gen = this._seekGen, held = this._held, out = [];
  this._held = [];
  for (var h = 0; h < held.length; h++) this._frames(held[h], out);
  for (var i = 0; i < out.length && gen === this._seekGen; i++) this._deliver(out[i]);
  if (gen !== this._seekGen || this._ended || this._failed) return;
  if (!this._tracks.length) return this._fail('NO_TRACKS', 'no Tracks');
  if (!this._infoSent) { this._sendInfo(); if (gen !== this._seekGen) return; }
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

// To what a SeekHead says is element `id` at `pos`.
WebMReader.prototype._go = function (pos, id) {
  if (id === ID.SeekHead) this._seekHeadsRead[pos] = true;
  this._expect = { pos: pos, id: id };
  this._jump(pos);
};

// A SeekHead listed by one read (RFC 9559 §6.3) not read yet: its position, else -1.
WebMReader.prototype._nextSeekHead = function () {
  for (var i = 0; i < this._seekHeads.length; i++) if (!this._seekHeadsRead[this._seekHeads[i]]) return this._seekHeads[i];
  return -1;
};

// RFC 9559 §6.1: the first Info and Tracks are before the first Cluster —
// or the SeekHead says where. Only the Tracks were looked for: an Info
// after the first Cluster was read when reached, the clusters before it
// timed with the default TimestampScale (a 0.5 ms scale: every time
// doubled). Both now, then back to the first Cluster.
WebMReader.prototype._fetchNext = function () {
  var f = this._fetch;
  while (f.ids.length) {
    var id = f.ids[0];
    if (this._seeks[id] != null) return this._go(this._segStart + this._seeks[id], id);
    var sh = this._nextSeekHead();
    if (sh >= 0) return this._go(sh, ID.SeekHead);
    if (id === ID.Tracks) return this._fail('NO_TRACKS', 'no Tracks before the first Cluster');
    f.ids.shift();                                   // no Info: its defaults
  }
  this._fetch = null;
  this._jump(f.back);
};

// What the SeekHead points to is not there (another element, garbage, past
// the end): on without it.
WebMReader.prototype._missed = function () {
  var x = this._expect;
  this._expect = null;
  if (this._fetch) {
    if (x.id === ID.Tracks) return this._fail('NO_TRACKS', 'no Tracks where the SeekHead says');
    var i = this._fetch.ids.indexOf(x.id);
    if (i >= 0) this._fetch.ids.splice(i, 1);
    this._fetchNext();
  } else if (this._cuesFor != null) {
    var t = this._cuesFor;
    this._cuesFor = null;
    if (x.id === ID.Cues) this._cues = [];
    this._seek(t);
  }
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
      if (this._expect) { this._missed(); continue; }
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
    if (this._expect && this._expect.pos === pos) { this._missed(); return 'ok'; }
    this._fail('BAD_ELEMENT', 'a bad element at ' + pos);
    return 'wait';
  }
  var dataStart = pos + h.dataStart;

  if (this._phase === 'ebml') {
    if (h.id !== ID.EBML || h.size < 0) { this._fail('NOT_EBML', 'not a WebM / Matroska file'); return 'wait'; }
    if (!win.has(dataStart, h.size)) { this._want(dataStart, h.size); return 'wait'; }
    var eb = win.view(dataStart, h.size), ek = _kids(eb, 0, eb.length);
    var dt = _kid(ek, ID.DocType);
    this._info.brand = dt ? _str(eb, dt) : '';
    // RFC 9559 §4.3: a Matroska DocType is 'matroska' ('webm' its WebM
    // profile), EBMLMaxIDLength 4, EBMLMaxSizeLength 1 … 8; RFC 8794 §10:
    // an EBMLReadVersion / DocTypeReadVersion above what's read (EBML 1,
    // Matroska 4) can't be read. Any EBML document was read as WebM.
    if (this._info.brand !== 'webm' && this._info.brand !== 'matroska') {
      this._fail('BAD_DOCTYPE', "not a WebM / Matroska file (DocType '" + this._info.brand + "')");
      return 'wait';
    }
    var maxSize = _num(eb, ek, ID.EBMLMaxSizeLength, 8);
    if (_num(eb, ek, ID.EBMLReadVersion, 1) > 1 || _num(eb, ek, ID.DocTypeReadVersion, 1) > 4
        || _num(eb, ek, ID.EBMLMaxIDLength, 4) !== 4 || maxSize < 1 || maxSize > 8) {
      this._fail('UNSUPPORTED', 'an EBML header this reader cannot follow (versions / ID or size lengths)');
      return 'wait';
    }
    this._info.container = this._info.brand === 'matroska' ? 'matroska' : 'webm';
    this._phase = 'segment';
    this._pos = dataStart + h.size;
    return 'ok';
  }
  if (this._phase === 'segment') {
    // RFC 8794 §11.3.2: a Void element may be at the root (here: before
    // the Segment) — it was 'no Segment'.
    if (h.id === ID.Void && h.size >= 0) { this._pos = dataStart + h.size; return 'ok'; }
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
  // Not what the SeekHead said is here.
  if (this._expect && this._expect.pos === pos && h.id !== this._expect.id) { this._missed(); return 'ok'; }

  if (h.id === ID.Cluster) {
    if (this._firstCluster < 0) {
      this._firstCluster = pos;
      var ids = [];
      if (!this._infoRead) ids.push(ID.Info);
      if (!this._tracksRead) ids.push(ID.Tracks);
      // Later in the file (the SeekHead says where): read them, then back.
      if (ids.length) { this._fetch = { ids: ids, back: pos }; this._fetchNext(); return 'ok'; }
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
      var hit = this._expect && this._expect.pos === pos;
      if (hit) this._expect = null;
      if (h.id === ID.SeekHead) this._seekHeadsRead[pos] = true;
      // (Tracks after the first Cluster were read again when reached in
      // file order: new track objects, the selected ones gone — every
      // sample after them was dropped.)
      if (!(h.id === ID.Tracks && this._tracksRead) && !(h.id === ID.Info && this._infoRead)) this._apply(h.id, win.view(dataStart, h.size));
      this._pos = end;
      if (hit && this._fetch) {
        var fi = this._fetch.ids.indexOf(h.id);
        if (fi >= 0) this._fetch.ids.splice(fi, 1);
        this._fetchNext();
      } else if (hit && this._cuesFor != null) { var t = this._cuesFor; this._cuesFor = null; this._seek(t); }
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
    if (this._scan) this._scan.clusters.push({ pos: this._clusterPos, us: Math.round(this._clusterTs * this._scale / 1000) });
  } else if (h.id === ID.SimpleBlock) {
    this._block(b, 0, b.length, null, null, null, out);
  } else {
    var gk = _kids(b, 0, b.length), blk = _kid(gk, ID.Block), bd = _kid(gk, ID.BlockDuration), dp = _kid(gk, ID.DiscardPadding);
    if (blk) {
      this._block(b, blk.start, blk.end, !_kid(gk, ID.ReferenceBlock), bd && bd.end > bd.start ? _uint(b, bd) : null,
                  dp && dp.end > dp.start ? _sint(b, dp) : null, out);
    }
  }
  this._pos = end;
  if (this._scan && this._scan.done) { this._endScan(); return 'ok'; }
  // (A seek from a listener: the rest of the block is from before it —
  // it went out after the seek.)
  var gen = this._seekGen;
  for (var i = 0; i < out.length && !this._ended && gen === this._seekGen; i++) this._deliver(out[i]);
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
  for (var i = 0; i < early.length && !this._ended && gen === this._seekGen; i++) this._deliver(early[i]);
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
      if (!sid || !pos) return;
      seeks[_uint(buf, sid)] = _uint(buf, pos);
      if (_uint(buf, sid) === ID.SeekHead) self._seekHeads.push(self._segStart + _uint(buf, pos));
    });
  } else if (id === ID.Info) {
    this._infoRead = true;
    this._scale = _num(buf, kids, ID.TimestampScale, 1000000) || 1000000;
    // (range > 0: a negative / NaN Duration came out as such)
    var du = _flt(buf, kids, ID.Duration, 0);
    if (du > 0 && du < Infinity) info.durationUs = Math.round(du * this._scale / 1000);
  } else if (id === ID.Tracks) {
    this._tracksRead = true;
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
    defaultDurationUs: 0, codecDelayUs: 0, seekPreRollUs: 0, tts: 1, strip: null, encrypted: false,
    codedWidth: 0, codedHeight: 0, displayWidth: 0, displayHeight: 0, rotation: 0, flip: false, colorSpace: null,
    sampleRate: 0, outputRate: 0, numberOfChannels: 0, bitDepth: 0, pcm: false, bigEndian: false, startUs: 0,
    hold: false, lastFrameUs: 0,
  };
  var priv = _kid(k, ID.CodecPrivate);
  if (priv) t.description = buf.slice(priv.start, priv.end);
  t.defaultDurationUs = Math.round(_num(buf, k, ID.DefaultDuration, 0) / 1000);
  // RFC 9559 §11.2: CodecDelay comes off every block of the track (it was
  // taken off audio only); SeekPreRoll (§5.1.4.1.26): what a decoder must
  // decode after a seek before its output is valid.
  t.codecDelayUs = Math.round(_num(buf, k, ID.CodecDelay, 0) / 1000);
  t.seekPreRollUs = Math.round(_num(buf, k, ID.SeekPreRoll, 0) / 1000);
  // RFC 9559 §11.1.3: block timestamps and BlockDuration are in Track
  // Ticks — × TrackTimestampScale × TimestampScale. It was not read: a
  // track at 2.0 came out at half its times (FFmpeg applies it).
  var tts = _flt(buf, k, ID.TrackTimestampScale, 1);
  t.tts = tts > 0 && tts < Infinity ? tts : 1;
  // The time to the next block is a block's duration (below) where the
  // decode order is the presentation order: audio, VP8 / VP9 / AV1.
  t.hold = t.type === 'audio' || (t.type === 'video' && (t.codecId === 'V_VP8' || t.codecId === 'V_VP9' || t.codecId === 'V_AV1'));

  var v = _kid(k, ID.Video);
  if (v) {
    var vk = _kids(buf, v.start, v.end), g = function (id) { return _num(buf, vk, id, 0); };
    t.codedWidth = _u32(g(ID.PixelWidth), 0); t.codedHeight = _u32(g(ID.PixelHeight), 0);
    // RFC 9559 §5.1.4.1.28: DisplayWidth / DisplayHeight are in
    // DisplayUnit — pixels (0, the default), centimetres, inches or a
    // display aspect ratio (3) — and default (pixels only) to the size
    // left after the PixelCrop* fields. They were read as pixels always,
    // the crop ignored: a track of 16:9 by aspect ratio came out with a
    // display size of 16 x 9.
    var visW = Math.max(0, t.codedWidth - g(ID.PixelCropLeft) - g(ID.PixelCropRight));
    var visH = Math.max(0, t.codedHeight - g(ID.PixelCropTop) - g(ID.PixelCropBottom));
    var dw = g(ID.DisplayWidth), dh = g(ID.DisplayHeight), unit = g(ID.DisplayUnit);
    if (unit === 0) { t.displayWidth = dw || visW; t.displayHeight = dh || visH; }
    else if (unit <= 3 && dw && dh) { t.displayHeight = visH; t.displayWidth = Math.round(visH * dw / dh); }   // the shape, at the visible height
    else { t.displayWidth = visW; t.displayHeight = visH; }
    var col = _kid(vk, ID.Colour);
    if (col) {
      var ck = _kids(buf, col.start, col.end), c = function (id) { return _num(buf, ck, id, 2); };
      var range = _num(buf, ck, ID.Range, 0);
      t.colorSpace = colorSpaceFromCicp(c(ID.Primaries), c(ID.TransferCharacteristics), c(ID.MatrixCoefficients),
                                        range === 2 ? true : range === 1 ? false : null);
    }
    // RFC 9559 §15.2 / §5.1.4.1.28.41: a rectangular Projection's pose —
    // ProjectionPoseRoll counter-clockwise, a yaw of ±180 a left-right
    // flip (applied first). It was not read: FFmpeg's -display_rotation 90
    // (roll 90) came out at rotation 0. As WebCodecs' rotation (clockwise)
    // then flip; any other pose is shown as is.
    var pj = _kid(vk, ID.Projection);
    if (pj) {
      var pk = _kids(buf, pj.start, pj.end);
      var yaw = _flt(buf, pk, ID.ProjectionPoseYaw, 0), pitch = _flt(buf, pk, ID.ProjectionPosePitch, 0), roll = _flt(buf, pk, ID.ProjectionPoseRoll, 0);
      if (_num(buf, pk, ID.ProjectionType, 0) === 0 && pitch === 0 && (yaw === 0 || yaw === 180 || yaw === -180) && roll % 90 === 0) {
        t.flip = yaw !== 0;
        t.rotation = (((t.flip ? roll : -roll) % 360) + 360) % 360;
      }
    }
  }
  var a = _kid(k, ID.Audio);
  if (a) {
    var ak = _kids(buf, a.start, a.end);
    // (ranges > 0 / not 0: what isn't a rate or a count is the default)
    t.sampleRate = _u32(Math.round(_flt(buf, ak, ID.SamplingFrequency, 8000)), 0) || 8000;
    t.outputRate = _u32(Math.round(_flt(buf, ak, ID.OutputSamplingFrequency, 0)), 0);
    t.numberOfChannels = _u32(_num(buf, ak, ID.Channels, 1), 0) || 1;
    t.bitDepth = _u32(_num(buf, ak, ID.BitDepth, 0), 0);
  }
  var enc = _kid(k, ID.ContentEncodings);
  if (enc) {
    // RFC 9559 §5.1.4.1.31: ContentEncodingScope says what an encoding
    // changed — 1 the frames, 2 the CodecPrivate, 4 the next encoding —
    // and they are undone from the highest ContentEncodingOrder down. The
    // scope was ignored: header stripping of the CodecPrivate alone was
    // put in front of every frame (FFmpeg: frames untouched).
    var list = _kids(buf, enc.start, enc.end).filter(function (ce) { return ce.id === ID.ContentEncoding; }).map(function (ce) {
      var cek = _kids(buf, ce.start, ce.end);
      return { kids: cek, order: _num(buf, cek, ID.ContentEncodingOrder, 0), scope: _num(buf, cek, ID.ContentEncodingScope, 1) };
    });
    list.sort(function (x, y) { return y.order - x.order; });
    list.forEach(function (e) {
      var scope = e.scope, comp = _kid(e.kids, ID.ContentCompression);
      if (scope & 4) { t.encrypted = true; return; }   // an encoding of the next one's settings: can't follow
      if (_kid(e.kids, ID.ContentEncryption)) { if (scope & 3) t.encrypted = true; return; }
      if (!comp) return;
      var cc = _kids(buf, comp.start, comp.end), set = _kid(cc, ID.ContentCompSettings);
      // 3 = header stripping (the bytes stripped from each); 0 zlib, 1 bzlib, 2 lzo — not here.
      if (_num(buf, cc, ID.ContentCompAlgo, 0) !== 3) { if (scope & 3) t.encrypted = true; return; }   // can't read it either way
      var bytes = set ? buf.slice(set.start, set.end) : new Uint8Array(0);
      if (scope & 1) t.strip = t.strip ? concat([bytes, t.strip]) : bytes;
      if ((scope & 2) && t.description) t.description = concat([bytes, t.description]);
    });
    if (t.strip && !t.strip.length) t.strip = null;
  }
  _codec(t);
  return t;
}

function _codec(t) {
  if (t.encrypted) return;
  var id = t.codecId, d = t.description;
  if (id === 'V_VP8') t.codec = 'vp8';
  else if (id === 'V_VP9') {
    // WebM's VP9 CodecPrivate ("VP9 Codec Feature Metadata": [id][1][value]
    // — 1 profile, 2 level, 3 bit depth) gives the level, which a frame
    // does not; it was never read, and the level was guessed from the
    // frame size. Refined from the first keyframe.
    t.vp9 = _vp9Features(d);
    t.codec = _vp9String(t.vp9.profile != null ? t.vp9.profile : 0, t.vp9.level != null ? t.vp9.level : 10, t.vp9.bitDepth || 8);
    t.description = null;
  }
  else if (id === 'V_AV1') t.codec = d ? codecStringFromAv1C(d) : null;
  else if (id === 'V_MPEG4/ISO/AVC') {
    // An SPS that doesn't parse threw out of feed() — no 'error', the
    // caller's exception. The avcC's own profile / level bytes name it
    // then (as reader_mp4 does for an avcC with no SPS).
    t.codec = d ? _try(codecStringFromAvcC, d, 'avc1') : null;
    if (!t.codec && d && d.length >= 4) t.codec = 'avc1.' + _hex2(d[1]) + _hex2(d[2]) + _hex2(d[3]);
  }
  else if (id === 'V_MPEGH/ISO/HEVC') t.codec = d ? _try(codecStringFromHvcC, d, 'hvc1') : null;
  else if (id === 'A_OPUS') t.codec = 'opus';             // CodecPrivate is the OpusHead
  else if (id === 'A_VORBIS') t.codec = 'vorbis';         // CodecPrivate: the three headers, Xiph-laced
  else if (id === 'A_FLAC') t.codec = 'flac';             // CodecPrivate: 'fLaC' + metadata blocks
  else if (id === 'A_MPEG/L3') { t.codec = 'mp3'; t.description = null; }
  else if (id.indexOf('A_AAC') === 0) {
    if (d) {
      var asc = parseAudioSpecificConfig(d);
      t.codec = 'mp4a.40.' + ((asc && asc.objectType) || 2);
      // HE-AAC: the output rate is SBR's (14496-3 §1.6.5) — the config's
      // extension rate, else the track's OutputSamplingFrequency (RFC 9559
      // §5.1.4.1.29.2: "used for SBR"). The core's was taken: 22050 for
      // 44.1 kHz HE-AAC (FFmpeg: 44100).
      if (asc) { if (asc.sampleRate) t.sampleRate = _sbrRate(d) || t.outputRate || asc.sampleRate; if (asc.channels) t.numberOfChannels = asc.channels; }
    } else {
      // The older IDs (A_AAC/MPEG4/LC/SBR, A_AAC/MPEG2/MAIN, …) have no
      // CodecPrivate: the profile is in the ID. They came out as
      // mp4a.40.2 with no description — which WebCodecs reads as ADTS,
      // and these frames are raw. The AudioSpecificConfig is built from
      // the ID and the track (FFmpeg's matroskadec builds the same bytes).
      var m = AAC_IDS[id] || [2, 'mp4a.40.2'];
      var out = m[2] ? (t.outputRate || t.sampleRate) : 0;     // RFC 9559: OutputSamplingFrequency defaults to SamplingFrequency
      t.description = _buildAsc(m[0], t.sampleRate, t.numberOfChannels, out);
      t.codec = m[1];
      if (out) t.sampleRate = out;
    }
  }
  else if (id === 'A_PCM/INT/LIT' || id === 'A_PCM/INT/BIG') {
    // Matroska's PCM: BitDepth-bit signed samples, 8-bit unsigned;
    // A_PCM/INT/BIG big-endian (bigEndian, as reader_mp4's PCM). BIG had
    // no codec (FFmpeg: pcm_s16be); a depth WebCodecs does not name
    // (pcm-u8 / -s16 / -s24 / -s32) gave 'pcm-s12' and the like.
    var bits = t.bitDepth || 16;
    t.codec = bits === 8 ? 'pcm-u8' : bits === 16 || bits === 24 || bits === 32 ? 'pcm-s' + bits : null;
    t.pcm = true; t.bigEndian = id === 'A_PCM/INT/BIG'; t.description = null;
  }
  else if (id === 'A_PCM/FLOAT/IEEE') {
    // (64-bit floats are not pcm-f32 — no WebCodecs codec string)
    t.codec = (t.bitDepth || 32) === 32 ? 'pcm-f32' : null;
    t.pcm = true; t.description = null;
  }
}

function _try(f, a, b) { try { return f(a, b); } catch (e) { return null; } }
function _hex2(n) { return (n < 16 ? '0' : '') + n.toString(16); }

// Matroska's AAC codec IDs: [audio object type, codec string, SBR]. The
// MPEG-2 ones as their MP4 object type indications (0x66 … 0x68), as
// reader_mp4 names them.
var AAC_IDS = {
  'A_AAC/MPEG2/MAIN': [1, 'mp4a.66'], 'A_AAC/MPEG2/LC': [2, 'mp4a.67'], 'A_AAC/MPEG2/SSR': [3, 'mp4a.68'],
  'A_AAC/MPEG2/LC/SBR': [2, 'mp4a.40.5', true],
  'A_AAC/MPEG4/MAIN': [1, 'mp4a.40.1'], 'A_AAC/MPEG4/LC': [2, 'mp4a.40.2'], 'A_AAC/MPEG4/SSR': [3, 'mp4a.40.3'],
  'A_AAC/MPEG4/LTP': [4, 'mp4a.40.4'], 'A_AAC/MPEG4/LC/SBR': [2, 'mp4a.40.5', true],
};
var AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

// An AudioSpecificConfig (14496-3 §1.6.2.1): object type, rate (an index,
// else 15 and 24 bits), channelConfiguration, a GASpecificConfig of
// zeros; with SBR the backward-compatible extension (syncExtensionType
// 0x2B7, object type 5, sbrPresentFlag 1, the output rate).
function _buildAsc(aot, rate, channels, sbrRate) {
  var bits = [];
  function put(v, n) { for (var i = n - 1; i >= 0; i--) bits.push(Math.floor(v / Math.pow(2, i)) % 2); }
  function freq(r) { var i = AAC_RATES.indexOf(r); if (i < 0) { put(15, 4); put(r % 16777216, 24); } else put(i, 4); }
  put(aot, 5); freq(rate); put(channels <= 6 ? channels : channels === 8 ? 7 : 0, 4); put(0, 3);
  if (sbrRate) { put(0x2B7, 11); put(5, 5); put(1, 1); freq(sbrRate); }
  while (bits.length % 8) bits.push(0);
  var out = new Uint8Array(bits.length / 8);
  for (var j = 0; j < bits.length; j++) out[j >> 3] |= bits[j] << (7 - (j & 7));
  return out;
}

// HE-AAC: SBR's extension sampling frequency — explicit (object type 5 /
// 29) or backward-compatible (sync extension 0x2B7, sbrPresentFlag 1);
// 0 when there is none (or a PCE stands in the way). reader_mp4's.
function _sbrRate(asc) {
  var pos = 0, n = asc.length * 8;
  function bits(k) {
    var v = 0;
    for (var i = 0; i < k; i++, pos++) v = v * 2 + (pos < n ? (asc[pos >> 3] >> (7 - (pos & 7))) & 1 : 0);
    return v;
  }
  function rate() { var i = bits(4); return i === 15 ? bits(24) : (AAC_RATES[i] || 0); }
  function aot() { var o = bits(5); return o === 31 ? 32 + bits(6) : o; }
  var type = aot();
  rate();
  var channels = bits(4);
  if (type === 5 || type === 29) return pos + 4 <= n ? rate() : 0;
  if (type < 1 || type > 4 || !channels) return 0;
  bits(1);                                   // frameLengthFlag
  if (bits(1)) bits(14);                     // dependsOnCoreCoder → coreCoderDelay
  if (bits(1)) bits(1);                      // extensionFlag → extensionFlag3
  if (n - pos < 16 || bits(11) !== 0x2B7 || aot() !== 5 || !bits(1)) return 0;
  return pos + 4 <= n ? rate() : 0;
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
  var level = t.vp9 && t.vp9.level != null ? t.vp9.level : 10;
  if (!(t.vp9 && t.vp9.level != null)) {
    // not in the frame (nor the CodecPrivate): the VP9 level table's for
    // the size and the DefaultDuration's rate (codec_strings' vp9Level —
    // it was guessed from the size alone by steps of its own: 8K got 5.1)
    level = vp9Level(t.codedWidth, t.codedHeight, t.defaultDurationUs ? 1e6 / t.defaultDurationUs : 0);
  }
  t.codec = _vp9String(profile, level, depth);
}

function _vp9String(profile, level, depth) {
  return buildCodecString({ name: 'vp9', profile: String(profile), level: (level / 10).toFixed(1), bitDepth: depth });
}

// The VP9 CodecPrivate's features: { profile, level, bitDepth } (absent: undefined).
function _vp9Features(d) {
  var out = {};
  for (var p = 0; d && p + 3 <= d.length; p += 2 + d[p + 1]) {
    if (d[p + 1] !== 1) continue;
    var v = d[p + 2];
    if (d[p] === 1) out.profile = v;
    else if (d[p] === 2) out.level = v;
    else if (d[p] === 3) out.bitDepth = v;
  }
  return out;
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
    p.rotation = t.rotation; p.flip = t.flip; p.colorSpace = t.colorSpace;
    p.frameRate = t.defaultDurationUs ? Math.round(1e8 / t.defaultDurationUs) / 100 : 0;
    if (t.codec) {
      p.config = { codec: t.codec, codedWidth: t.codedWidth, codedHeight: t.codedHeight };
      if (t.description) p.config.description = t.description;
      if (t.colorSpace) p.config.colorSpace = t.colorSpace;
    }
  } else if (t.type === 'audio') {
    p.sampleRate = t.sampleRate; p.numberOfChannels = t.numberOfChannels;
    if (t.pcm) p.bigEndian = t.bigEndian;
    if (t.codec) {
      p.config = { codec: t.codec, sampleRate: t.sampleRate, numberOfChannels: t.numberOfChannels };
      if (t.description) p.config.description = t.description;
    }
  }
  return p;
}


// One block → its frames into out. key: null = from the SimpleBlock flags;
// durTicks: the BlockDuration (null: none); discard: the DiscardPadding (ns).
WebMReader.prototype._block = function (b, s, e, key, durTicks, discard, out) {
  // (a block too short for its header, or no track number: dropped — it
  // was read past its end, an empty frame out)
  if (s >= e) return;
  var tn = _vint(b, s);
  if (tn.len > 8 || s + tn.len + 3 > e) return;
  // RFC 9559 §10: the number is a TrackEntry's — else dropped (FFmpeg:
  // 'Invalid track number'). A track with no codec: its blocks as they
  // are (when selected).
  var t = this._byNum[tn.value];
  if (!t) return;
  var p = s + tn.len;
  var rel = (b[p] << 8) | b[p + 1]; if (rel & 0x8000) rel -= 0x10000;
  var flags = b[p + 2]; p += 3;
  var isKey = key == null ? !!(flags & 0x80) : key;
  if (t.type === 'audio') isKey = true;

  // Frames: one, or laced (Xiph / EBML / fixed).
  var lace = _lace(b, p, e, (flags >> 1) & 3);
  if (!lace) return;
  var frames = [];
  for (var f = 0, q = lace.at; f < lace.sizes.length; q += lace.sizes[f], f++) {
    var payload = b.subarray(q, q + lace.sizes[f]);
    frames.push(t.strip ? concat([t.strip, payload]) : payload);
  }
  // RFC 9559 §11.2: ( Cluster\Timestamp + block timestamp × TrackTimestampScale ) × TimestampScale
  var blk = { t: t, ns: (this._clusterTs + rel * t.tts) * this._scale, key: isKey, frames: frames,
              durNs: durTicks != null ? durTicks * t.tts * this._scale : null, discard: discard };
  // RFC 9559 §5.1.3.5.3: with no BlockDuration and no DefaultDuration, a
  // block lasts until the track's next one (in presentation order). It
  // was 0 — and the frames of a lace all had the block's time (mkvmerge's
  // Opus / Vorbis: 8 frames at one timestamp; FFmpeg: 20 ms apart). So
  // such a block waits for the next.
  for (var h = 0; h < this._held.length; h++) {
    if (this._held[h].t !== t) continue;
    var prev = this._held.splice(h, 1)[0], gap = blk.ns - prev.ns;
    prev.durNs = gap >= 0 ? gap : null;
    this._frames(prev, out);
    break;
  }
  if (blk.durNs == null && !t.defaultDurationUs && t.hold && !this._scan) this._held.push(blk);
  else this._frames(blk, out);
};

// A block's frames → out (or, seeking without Cues, looked at).
WebMReader.prototype._frames = function (blk, out) {
  var t = blk.t, n = blk.frames.length;
  var baseUs = Math.round(blk.ns / 1000);
  var durUs = blk.durNs != null ? Math.round(blk.durNs / 1000) : t.defaultDurationUs;
  var frameDur;
  if (blk.durNs != null || t.defaultDurationUs) {
    frameDur = n > 1 ? (t.defaultDurationUs || Math.round(durUs / n)) : durUs;
    t.lastFrameUs = frameDur;
  } else {
    // Not known (the last block): a lace's frames are contiguous (RFC 9559
    // §10.3.5) — the track's last frame duration apart.
    frameDur = n > 1 ? t.lastFrameUs : 0;
  }
  for (var f = 0; f < n; f++) {
    var payload = blk.frames[f];
    var pts = baseUs + f * frameDur - t.codecDelayUs;
    // seek without cues: nothing before the first video keyframe at / after the time
    if (this._scan) {
      // Seeking without an index: remember the last video keyframe at /
      // before the time (its cluster); past the time, read() goes back there.
      if (t.type === 'video' && blk.key && pts <= this._scan.target) this._scan.key = { pos: this._clusterPos, pts: pts };
      if (t.type === 'video' && pts > this._scan.target) this._scan.done = true;
      continue;
    }
    // After a seek: video from the keyframe; audio from the frame that's
    // playing then (one of unknown length: taken as up to 60 ms), less
    // the track's SeekPreRoll — the decoder must decode that much first.
    if (this._fromUs != null && (t.type === 'audio' ? pts + (frameDur || 60000) <= this._fromUs - t.seekPreRollUs : pts < this._fromUs)) continue;
    var smp = { trackId: t.id, type: t.type, payload: payload, isKeyframe: blk.key,
                ptsUs: pts, dtsUs: pts, durationUs: frameDur };
    // RFC 9559 §5.1.3.5.7: DiscardPadding — at the block's end (its last
    // frame) when positive, its start (its first) when negative; it was
    // not read (FFmpeg: skip_samples side data).
    if (blk.discard != null && (blk.discard < 0 ? f === 0 : f === n - 1)) smp.discardPaddingUs = Math.round(blk.discard / 1000);
    out.push(smp);
  }
};

// The frame sizes of a block from `p` (its lacing) → { at, sizes }, or
// null when they do not add up to the block: RFC 9559 §10.3. (The sizes
// were read past the block — negative sizes, frames cut from the next
// one; a fixed lace not divisible by its count split unevenly; an EBML
// lace of one frame read the frame's first bytes as a size. FFmpeg
// drops such a block: 'Error parsing frame sizes'.)
function _lace(b, p, e, lacing) {
  if (lacing === 0) return { at: p, sizes: [e - p] };
  if (p >= e) return null;
  var n = b[p++] + 1, sizes = [], total = 0, i;
  if (lacing === 1) {
    for (i = 0; i < n - 1; i++) {
      var sz = 0, x;
      do { if (p >= e) return null; x = b[p++]; sz += x; } while (x === 255);
      sizes.push(sz); total += sz;
    }
  } else if (lacing === 3) {
    if (n > 1) {
      if (p >= e) return null;
      var first = _vint(b, p);
      if (first.len > 8 || p + first.len > e) return null;
      p += first.len; sizes.push(first.value); total = first.value;
    }
    for (i = 1; i < n - 1; i++) {
      if (p >= e) return null;
      var dv = _vint(b, p);
      if (dv.len > 8 || p + dv.len > e) return null;
      p += dv.len;
      var next = sizes[i - 1] + dv.value - (Math.pow(2, 7 * dv.len - 1) - 1);
      if (next < 0) return null;
      sizes.push(next); total += next;
    }
  } else {
    // fixed: each frame the same size (§10.3.4)
    if ((e - p) % n) return null;
    for (i = 0; i < n - 1; i++) { sizes.push((e - p) / n); total += (e - p) / n; }
  }
  if (total > e - p) return null;
  sizes.push(e - p - total);
  return { at: p, sizes: sizes };
}

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
 * From the last video keyframe at / before timeUs (audio from the frame
 * playing then, less its SeekPreRoll). With Cues, straight to its cluster
 * (a 'need'); Cues somewhere else in the file (the SeekHead says — or a
 * second SeekHead) — those first. No Cues (a recorded file): from the
 * first cluster, reading up to the time without emitting, then back to
 * the keyframe's cluster (two 'need's).
 */
WebMReader.prototype.seek = function (timeUs) {
  if (!this._infoSent) throw new Error('WebMReader: seek() after info');
  this._seek(timeUs);
};

WebMReader.prototype._seek = function (timeUs) {
  this._seekGen++;
  this._ended = false;
  this._scan = null;
  this._held = [];          // waiting for a next block that is now elsewhere
  this._fetch = null;
  this._expect = null;
  this._cuesFor = null;
  // (No Cluster at all: it asked for offset -1.)
  if (this._firstCluster < 0) return this._finish();
  var v = this._selected.filter(function (t) { return t.type === 'video'; })[0];
  var pre = 0;
  this._selected.forEach(function (t) { if (t.type === 'audio' && t.seekPreRollUs > pre) pre = t.seekPreRollUs; });
  if (!this._cues) {
    // (A second seek while the Cues were being fetched kept the first's time.)
    var at = this._seeks[ID.Cues] != null ? this._segStart + this._seeks[ID.Cues] : this._nextSeekHead();
    if (at >= 0) {
      this._cuesFor = timeUs;
      this._go(at, this._seeks[ID.Cues] != null ? ID.Cues : ID.SeekHead);
      return this._process();
    }
  }
  var cues = (this._cues || []).filter(function (c) { return !v || c.track === v.id; });
  if (cues.length) {
    var best = null;
    cues.forEach(function (c) { if (c.timeUs <= timeUs && (!best || c.timeUs > best.timeUs)) best = c; });
    if (!best) cues.forEach(function (c) { if (!best || c.timeUs < best.timeUs) best = c; });
    // Audio alone: from the time asked — the cue only says where to read
    // from (it was from the cue's time, up to a cluster early).
    this._fromUs = v ? best.timeUs : timeUs;
    // The cluster to read from: the last cue early enough for the pre-roll.
    var from = null, start = this._fromUs - pre;
    cues.forEach(function (c) { if (c.timeUs <= start && (!from || c.timeUs > from.timeUs)) from = c; });
    this._jump(from ? this._segStart + from.pos : this._firstCluster);
    return this._process();
  }
  this._fromUs = null;
  if (v) this._scan = { target: timeUs, key: null, done: false, clusters: [], pre: pre };
  else this._fromUs = timeUs;
  this._jump(this._firstCluster);
  this._process();
};

// The scan of a seek without Cues is over: back to the keyframe's cluster
// (a cluster earlier for the audio's pre-roll).
WebMReader.prototype._endScan = function () {
  var sc = this._scan, key = sc.key;
  this._scan = null;
  this._fromUs = key ? key.pts : null;
  var at = key ? key.pos : this._firstCluster;
  if (key && sc.pre) {
    var best = null;
    sc.clusters.forEach(function (c) { if (c.us <= key.pts - sc.pre && (!best || c.us > best.us)) best = c; });
    at = best ? best.pos : this._firstCluster;
  }
  this._jump(at);
};

/** 0..1 — how far into the file the reading has got. */
WebMReader.prototype.progress = function () {
  var end = this._segEnd !== Infinity ? this._segEnd : this._size;
  var span = end - this._firstCluster;
  return this._firstCluster >= 0 && span > 0 ? Math.min(1, Math.max(0, (this._pos - this._firstCluster) / span)) : 0;
};

export default WebMReader;
