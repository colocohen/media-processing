/**
 * reader_mp4 — MP4 / MOV (QuickTime) / 3GP / fragmented MP4: a FILE fed
 * in pieces → its samples, as they become available.
 *
 * Like the other readers (and HLSEncoder): you feed it when you choose,
 * it emits what it can.
 *
 *   var r = new MP4Reader({ size: fileSize });   // size: optional, but say it if known
 *   r.on('info',  function (info) { … });        // the tracks and their decoder configs
 *   r.on('video', function (s) { … });           // a sample — see below
 *   r.on('audio', function (s) { … });
 *   r.on('other', function (s) { … });        // a selected track neither video nor audio
 *   r.on('need',  function (n) { … });           // { offset, length }: feed from there
 *   r.on('end',   function () { … });
 *   r.on('error', function (err) { … });         // err.code
 *   r.feed(bytes, offset);                       // offset: default — right after the last feed
 *   r.end();                                     // no more bytes
 *
 * Feeding in order from 0 is all it takes for most files. 'need' is for
 * the rest: a phone's file usually has its index (moov) at the END — the
 * reader sees the media data first, can't use it yet, and says "feed
 * from after it"; once it has the index, it says "now from the first
 * sample". So: feed from where the last 'need' said, in order, until the
 * next one. (A need for bytes a little ahead of what's been fed isn't
 * sent — feeding in order gets there.) `length` is a hint (0: unknown).
 *
 * Memory: what's kept is from the next sample on (and what's fed past it)
 * — feed a piece at a time, as the decoder has room, and it stays small.
 *
 * Also:
 *   r.select([trackId, …])   which tracks' samples are emitted (default:
 *                            the first video and the first audio track)
 *   r.seek(timeUs)           from the last video keyframe at / before it —
 *                            a 'need' says where to feed from
 *   r.progress()             0..1 — of the selected samples known, how many
 *                            are out
 *
 * A sample: { trackId, payload: Uint8Array, isKeyframe, ptsUs, dtsUs,
 * durationUs }. Times are the presentation timeline: the edit list
 * applied, so the first frame shown is at 0 (info.startUs says otherwise
 * when the file has none). A sample from before that (a B-frame lead-in,
 * audio priming) is negative — decode it, don't show it. The payload
 * stays valid (it's never written over).
 *
 * info:
 *   { container: 'mp4'|'mov', brand, compatibleBrands, quicktime,
 *     fragmented, durationUs, startUs, tracks }
 *   startUs — when the first frame is shown (the video's; else the
 *   audio's). Subtract it to start at 0.
 * a track:
 *   { id, type: 'video'|'audio'|'other', handler, entry (sample entry
 *     4cc), codec (WebCodecs codec string, or null: not one WebCodecs
 *     names), description (Uint8Array|null), timescale, durationUs,
 *     sampleCount, bitrate, startUs,
 *     video: codedWidth, codedHeight, displayWidth, displayHeight,
 *            rotation (0|90|180|270 — clockwise, to show it upright),
 *            flip (then mirrored left-right: WebCodecs' rotation + flip),
 *            colorSpace ({ primaries, transfer, matrix, fullRange } |
 *            null), frameRate
 *     audio: sampleRate, numberOfChannels, bigEndian (PCM: the samples'
 *            byte order — 'twos', 'in24', … unless an 'enda' says little)
 *     config: a VideoDecoderConfig / AudioDecoderConfig to configure()
 *             with (null when codec is null) }
 * In a fragmented file 'info' comes with the first fragment, and
 * sampleCount / durationUs are what's indexed by then.
 *
 * Codecs: H.264 (avc1/avc3), H.265 (hvc1/hev1 — an iPhone's), AV1, VP8,
 * VP9; AAC (any profile), MP3, Opus, FLAC, ALAC, PCM (sowt/twos/raw/
 * in24/in32/fl32/lpcm, ipcm/fpcm), µ-law / A-law. QuickTime sound sample
 * descriptions v0/v1/v2 and an esds / alac / enda inside 'wave' (older
 * iPhones) are read. Encrypted tracks (encv / enca) come out with codec
 * null.
 *
 * Not here: a compressed moov (cmov, pre-2005 QuickTime); edit lists
 * past the first media edit (rare in camera files — the rest are
 * ignored).
 */

import EventEmitter from './core/events.js';
import FileWindow from './core/file_window.js';
import { readU16BE, readU32BE, readS32BE, readU64BE, toAscii, concat, fromAscii } from './core/bytes.js';
import {
  readBoxHeader, findBox, findBoxes, findPath, fullBoxHeader,
  parseTfhd, parseTfdt, parseTrun, isSyncSampleFlags,
} from './utils/iso_bmff.js';
import { codecStringFromAvcC, codecStringFromHvcC } from './utils/nalu_utils.js';
import { parseAudioSpecificConfig } from './utils/aac_utils.js';
import { codecStringFromAv1C } from './utils/codec_strings.js';
import { colorSpaceFromCicp } from './video_color_space.js';

var HEAD = 16;   // a box header with a 64-bit size


function MP4Reader(opts) {
  if (!opts) opts = {};
  this._ee = new EventEmitter();
  this._size = opts.size || 0;          // 0: not known (then the end is end())
  this._win = new FileWindow();
  this._scan = 0;                       // the next top-level box
  this._ftyp = null;
  this._moovSeen = false;
  this._tracks = [];
  this._selected = [];
  this._trex = {};
  this._movieTimescale = 1000;
  this._info = null;
  this._infoSent = false;
  this._fragmented = false;
  this._askedAt = -1;                   // the last 'need' (not asked twice)
  this._seekTarget = null;              // a fragmented file, seeking past what's indexed
  this._busy = false;                   // inside _process (a listener calling back in)
  this._again = false;
  this._ended = false;
  this._failed = false;
}

MP4Reader.prototype.on  = function (ev, fn) { this._ee.on(ev, fn); return this; };
MP4Reader.prototype.off = function (ev, fn) { this._ee.off(ev, fn); return this; };

/** Bytes of the file at `offset` (default: right after the last feed). */
MP4Reader.prototype.feed = function (bytes, offset) {
  if (this._ended || this._failed) return;
  this._win.add(bytes, offset);
  if (this._askedAt >= 0 && this._win.has(this._askedAt, 1)) this._askedAt = -1;
  this._process();
};

/** No more bytes are coming (the file is all fed). */
MP4Reader.prototype.end = function () {
  if (this._ended || this._failed) return;
  if (!this._infoSent) return this._fail('TRUNCATED', 'the file ended before its index (moov)');
  this._finish();
};

MP4Reader.prototype._fail = function (code, message) {
  this._failed = true;
  var e = new Error('MP4Reader: ' + message);
  e.code = code;
  this._ee.emit('error', e);
};

MP4Reader.prototype._finish = function () {
  if (this._ended) return;
  this._ended = true;
  this._ee.emit('end');
};

// Bytes at `offset` are wanted: wait for them, or say where to feed from.
// jump: ask even if feeding in order would get there (what's between isn't
// wanted — no point reading it).
MP4Reader.prototype._want = function (offset, length, jump) {
  if (this._askedAt === offset || this._win.has(offset, 1)) return;
  if (!jump && !this._win.mustAsk(offset)) return;
  this._askedAt = offset;
  this._ee.emit('need', { offset: offset, length: length || 0 });
};

/**
 * Run as far as the bytes go. Called again from inside a listener (a
 * select / seek / feed from 'info', a sample or 'need'): the running pass
 * takes it up — one more round once it's done — never a pass inside a pass.
 */
MP4Reader.prototype._process = function () {
  if (this._busy) { this._again = true; return; }
  this._busy = true;
  try {
    do { this._again = false; this._run(); } while (this._again && !this._failed);
  } finally {
    this._busy = false;
  }
};

MP4Reader.prototype._run = function () {
  while (!this._failed && !this._ended) {
    if (!this._infoSent) {
      if (!this._scanTop()) return;
      continue;
    }
    var st = this._emitSamples();
    if (st === 'wait') return;
    // Every sample known so far is out. A fragmented file: the next moof.
    if (this._fragmented) {
      if (this._size && this._scan >= this._size) return this._finish();
      if (!this._scanTop()) return;
      continue;
    }
    if (this._seekTarget == null) return this._finish();
    return;
  }
};


// ── The top-level boxes, in order ──

// One step through the top-level boxes. false: waiting for bytes.
MP4Reader.prototype._scanTop = function () {
  var off = this._scan;
  // After a box of size 0 (it runs to the end) in a file of unknown size:
  // nothing follows it — the end is end(). It was taken as a box at
  // offset Infinity, and a 'need' asked for { offset: Infinity }.
  if (off === Infinity) return false;
  if (this._size && off >= this._size) {
    if (!this._moovSeen) { this._fail('NO_MOOV', 'no moov — not an MP4 / MOV file, or truncated'); return false; }
    if (!this._infoSent) this._sendInfo();
    if (this._seekTarget != null) this._resolveSeek();
    return !this._fragmented ? true : false;
  }
  if (!this._win.has(off, 8)) { this._keep(); this._want(off, HEAD); return false; }
  var h = this._win.peek(off, HEAD);
  var b = _headerAt(h, off, this._size || Infinity);
  if (!b) {
    if (h.length < HEAD && !this._win.has(off, HEAD) && readU32BE(h, 0) === 1) { this._want(off, HEAD); return false; }
    this._fail('BAD_BOX', 'a bad box at ' + off);
    return false;
  }

  if (b.type === 'ftyp' || b.type === 'moov' || b.type === 'moof') {
    if (!this._win.has(off, b.size)) { this._keep(); this._want(off, b.size); return false; }
    var bytes = this._win.view(off, b.size);
    try {
      if (b.type === 'ftyp') this._ftyp = bytes;
      else if (b.type === 'moov') {
        // A compressed movie is a 'cmov' INSIDE the moov (QTFF): the check
        // was for a top-level one, which no file has — such a moov was
        // read as one with no tracks.
        var mh = readBoxHeader(bytes, 0, bytes.length, true);
        if (findBox(bytes, mh.dataStart, mh.end, 'cmov')) { this._fail('CMOV', 'compressed moov (cmov) not supported'); return false; }
        this._parseMoov(bytes);
      }
      else this._addMoof(b, bytes);
    } catch (e) {
      this._fail('BAD_' + b.type.toUpperCase(), e.message);
      return false;
    }
    this._scan = b.end;
    return true;
  }
  if (b.type === 'cmov') { this._fail('CMOV', 'compressed moov (cmov) not supported'); return false; }

  // mdat (and the rest: free, skip, wide, uuid, …). Before the moov — or
  // while a fragmented file seeks — its data isn't wanted yet: jump it.
  this._scan = b.end;
  if ((!this._moovSeen || this._seekTarget != null) && b.end !== Infinity) {
    this._win.trim(b.end);
    if (!this._size || b.end < this._size) this._want(b.end, HEAD, true);
  }
  return true;
};

MP4Reader.prototype._parseMoov = function (bytes) {
  this._moovSeen = true;
  var info = { container: 'mp4', brand: '', compatibleBrands: [], quicktime: false, fragmented: false,
               durationUs: 0, startUs: 0, tracks: [] };
  var f = this._ftyp;
  if (f) {
    var fb = readBoxHeader(f, 0, f.length, true);
    if (fb) {
      info.brand = toAscii(f, fb.dataStart, fb.dataStart + 4);
      for (var c = fb.dataStart + 8; c + 4 <= fb.end; c += 4) info.compatibleBrands.push(toAscii(f, c, c + 4));
    }
  }
  info.quicktime = info.brand === 'qt  ' || !f;
  if (info.quicktime) info.container = 'mov';
  // QuickTime's sound sample description v1 / v2 layout (QTFF) or ISO's
  // AudioSampleEntryV1 (14496-12 §12.2.3: v0's fields, then boxes)? As
  // FFmpeg tells them apart: QuickTime unless an ISO file (an ftyp whose
  // major brand is not 'qt  ') without 'qt  ' among its compatible brands.
  var qtLayout = info.quicktime || info.compatibleBrands.indexOf('qt  ') >= 0;

  var buf = bytes;
  var moov = readBoxHeader(buf, 0, buf.length, true);
  var mvhd = findBox(buf, moov.dataStart, moov.end, 'mvhd');
  if (mvhd) {
    var mh = fullBoxHeader(buf, mvhd);
    this._movieTimescale = mh.version === 1 ? readU32BE(buf, mh.dataStart + 16) : readU32BE(buf, mh.dataStart + 8);
    var md = _duration(buf, mh.dataStart + (mh.version === 1 ? 20 : 12), mh.version === 1);
    if (this._movieTimescale && md != null) info.durationUs = Math.round(md * 1e6 / this._movieTimescale);
  }
  // Fragment defaults per track (mvex/trex).
  var trex = this._trex;
  var mvex = findBox(buf, moov.dataStart, moov.end, 'mvex');
  if (mvex) {
    this._fragmented = info.fragmented = true;
    findBoxes(buf, mvex.dataStart, mvex.end, 'trex').forEach(function (t) {
      var p = t.dataStart + 4;
      trex[readU32BE(buf, p)] = {
        sampleDescriptionIndex: readU32BE(buf, p + 4),
        duration: readU32BE(buf, p + 8), size: readU32BE(buf, p + 12), flags: readU32BE(buf, p + 16),
      };
    });
  }
  var self = this;
  findBoxes(buf, moov.dataStart, moov.end, 'trak').forEach(function (trak) {
    var t = _parseTrak(buf, trak, self._movieTimescale, qtLayout);
    if (t) { t.cursor = 0; _finishTrack(t, false); self._tracks.push(t); }
  });
  this._info = info;
  // A whole index: say what it is now. A fragmented one: once the first
  // fragment is in (where the samples — and their start — are).
  if (!this._fragmented) this._sendInfo();
};

MP4Reader.prototype._addMoof = function (box, bytes) {
  if (!this._moovSeen) throw new Error('a moof before the moov');
  this._fragmented = this._info.fragmented = true;
  _addFragments(this._tracks, [{ box: box, bytes: bytes }], this._trex);
  this._tracks.forEach(function (t) { _finishTrack(t, true); });
  if (!this._infoSent) this._sendInfo();
  if (this._seekTarget != null) {
    var v = this._seekVideo();
    if (v && v.sampleCount && this._ptsUs(v, v.sampleCount - 1) >= this._seekTarget) this._resolveSeek();
  }
};

MP4Reader.prototype._sendInfo = function () {
  var info = this._info;
  info.tracks = this._tracks.map(_publicTrack);
  var vt = null, at = null;
  this._tracks.forEach(function (t) {
    if (!t.sampleCount) return;
    if (!vt && t.type === 'video') vt = t;
    if (!at && t.type === 'audio') at = t;
  });
  // Where the presentation starts: the video's first shown frame (else the
  // audio's). A file with no edit list (often a fragmented one) can start
  // past 0; subtract this to put the first frame at 0.
  info.startUs = vt ? vt.startUs : at ? at.startUs : 0;
  var maxDur = 0;
  this._tracks.forEach(function (t) { if (t.durationUs > maxDur) maxDur = t.durationUs; });
  if (!info.durationUs || (info.fragmented && maxDur > info.durationUs)) info.durationUs = maxDur;
  this._infoSent = true;
  if (!this._selected.length) this.select(null);
  this._ee.emit('info', info);
};


// ── Samples ──

/**
 * The tracks to emit samples of, by id (null → the first video and the
 * first audio track that have a codec). Default: that, when 'info' comes.
 */
MP4Reader.prototype.select = function (ids) {
  var tracks = this._tracks;
  if (ids) {
    this._selected = tracks.filter(function (t) { return ids.indexOf(t.id) !== -1; });
  } else {
    var v = null, a = null;
    tracks.forEach(function (t) {
      if (!v && t.type === 'video' && t.codec) v = t;
      if (!a && t.type === 'audio' && t.codec) a = t;
    });
    this._selected = [v, a].filter(Boolean);
  }
  if (this._infoSent) this._process();
};

// Negative composition offsets (ctts version 1, written by e.g. FFmpeg's
// negative_cts_offsets) put a sample's presentation time BEFORE its
// decode time: the stts timeline starts at 0, a B-frame's offset is -1
// frame, and dts > pts. Decode time must never be after presentation
// (ISO/IEC 14496-12 8.6.1.4: the composition-to-decode shift — cslg —
// exists to move DTS back by that much). It was emitted as is: dts one
// frame ahead of FFmpeg's (0 vs -33333 µs) and above pts for every
// B-frame, which a muxer fed with these samples rejects. The shift is
// cslg's compositionToDTSShift when present, else the largest negative
// offset — FFmpeg's choice. Fixed once known, so a fragmented file's
// dts stays monotonic (later fragments are assumed to stay within it).
function _dtsShift(t) {
  if (t._dtsShift !== undefined) return t._dtsShift;
  if (!t.cto.length) return 0;
  var shift = t.cslgShift != null ? t.cslgShift : 0;
  if (t.cslgShift == null) {
    for (var i = 0; i < t.cto.length; i++) if (-t.cto[i] > shift) shift = -t.cto[i];
  }
  t._dtsShift = shift;
  return shift;
}

MP4Reader.prototype._ptsUs = function (t, i) {
  return Math.round((t.dts[i] + t.cto[i] - t.mediaStart) * 1e6 / t.timescale) + t.leadUs;
};

// The selected track whose next sample comes first in the file.
MP4Reader.prototype._nextTrack = function () {
  var best = null;
  for (var i = 0; i < this._selected.length; i++) {
    var t = this._selected[i];
    if (t.cursor >= t.sampleCount) continue;
    if (!best || t.off[t.cursor] < best.off[best.cursor]) best = t;
  }
  return best;
};

// Emit every next sample that's here. 'wait' — the next one isn't.
MP4Reader.prototype._emitSamples = function () {
  if (this._seekTarget != null) return 'done';
  while (true) {
    var t = this._nextTrack();
    if (!t) { this._keep(); return 'done'; }
    var i = t.cursor, o = t.off[i], sz = t.size[i];
    // (An empty sample needs no bytes: it goes out now. It went out only
    // once _keep had trimmed the window up to its offset — on a second
    // pass, so whether it came before the next feed depended on that.)
    if (sz > 0 && !this._win.has(o, sz)) {
      this._keep();
      this._want(o, sz);
      return 'wait';
    }
    t.cursor++;
    this._ee.emit(t.type, {
      trackId: t.id,
      payload: sz > 0 ? this._win.view(o, sz) : new Uint8Array(0),
      isKeyframe: !!t.sync[i],
      ptsUs: this._ptsUs(t, i),
      dtsUs: Math.round((t.dts[i] - _dtsShift(t) - t.mediaStart) * 1e6 / t.timescale) + t.leadUs,
      durationUs: Math.round(t.dur[i] * 1e6 / t.timescale),
    });
    if (this._ended || this._failed) return 'done';
    // A seek() from the listener just called, in a fragmented file, to a
    // time not indexed yet: the fragments up to it are found first. This
    // loop went on emitting the samples after the old position meanwhile —
    // 5 stale frames (366667 400000 … µs) ahead of the keyframe the seek
    // asked for (3066667).
    if (this._seekTarget != null) return 'done';
  }
};

// Let go of what's behind: the next sample, or (fragmented) the next box.
MP4Reader.prototype._keep = function () {
  var t = this._nextTrack();
  var from = t ? t.off[t.cursor] : Infinity;
  if (this._fragmented || !this._moovSeen) from = Math.min(from, this._scan);
  if (from !== Infinity) this._win.trim(from);
};

/**
 * From the last video keyframe at / before timeUs (audio from the same
 * time). The samples from there come as their bytes are fed — a 'need'
 * says from where. A fragmented file not yet indexed that far: its
 * fragments are found first (a 'need' past each mdat), then the same.
 */
MP4Reader.prototype.seek = function (timeUs) {
  if (!this._infoSent) throw new Error('MP4Reader: seek() after info');
  this._askedAt = -1;
  var v = this._seekVideo();
  var known = !v || (v.sampleCount && this._ptsUs(v, v.sampleCount - 1) >= timeUs);
  var atEnd = this._scan === Infinity || (this._size && this._scan >= this._size);
  if (this._fragmented && !known && !atEnd) {
    this._seekTarget = timeUs;
    this._win.trim(this._scan);
    this._want(this._scan, HEAD);
    this._process();
    return;
  }
  this._seekTarget = timeUs;
  this._resolveSeek();
};

MP4Reader.prototype._seekVideo = function () {
  return this._selected.filter(function (t) { return t.type === 'video'; })[0] || null;
};

MP4Reader.prototype._resolveSeek = function () {
  var timeUs = this._seekTarget, self = this, from = timeUs;
  this._seekTarget = null;
  this._selected.forEach(function (t) {
    if (t.type !== 'video') return;
    var k = 0;
    for (var i = 0; i < t.sampleCount; i++) {
      var p = self._ptsUs(t, i);
      if (t.sync[i] && p <= timeUs) k = i;
      if (p > timeUs && t.sync[i]) break;
    }
    t.cursor = k;
    if (t.sampleCount) from = Math.min(from, self._ptsUs(t, k));
  });
  this._selected.forEach(function (t) {
    if (t.type === 'video') return;
    var i = 0;
    while (i < t.sampleCount && self._ptsUs(t, i) + Math.round(t.dur[i] * 1e6 / t.timescale) <= from) i++;
    t.cursor = i;
  });
  this._ended = false;
  this._askedAt = -1;
  this._process();
};

/** 0..1 — the share of the selected tracks' known samples emitted. */
MP4Reader.prototype.progress = function () {
  var done = 0, all = 0;
  this._selected.forEach(function (t) { done += t.cursor; all += t.sampleCount; });
  return all ? done / all : 0;
};


// A box header at absolute `off`, read from `h` (its first bytes).
function _headerAt(h, off, fileSize) {
  if (h.length < 8) return null;
  var size = readU32BE(h, 0), type = toAscii(h, 4, 8), headerSize = 8;
  if (size === 1) {
    if (h.length < 16) return null;
    size = readU64BE(h, 8); headerSize = 16;
  } else if (size === 0) {
    size = fileSize - off;             // runs to the end (a last mdat)
  }
  if (size < headerSize || off + size > fileSize) {
    // A cut-off last mdat (a recording that stopped badly): take what's there.
    if (type === 'mdat' && size >= headerSize) size = fileSize - off;
    else return null;
  }
  return { type: type, start: off, end: off + size, size: size, headerSize: headerSize };
}

// =========================================================================
// Parsing the moov
// =========================================================================

function _parseTrak(buf, trak, movieTimescale, qtLayout) {
  var t = {
    id: 0, type: 'other', handler: '', entry: '', codec: null, description: null,
    timescale: 0, durationUs: 0, rotation: 0, flip: false, displayWidth: 0, displayHeight: 0,
    codedWidth: 0, codedHeight: 0, colorSpace: null,
    sampleRate: 0, numberOfChannels: 0, bigEndian: false, pcm: false, pcmFrameBytes: 0,
    // edit list → presentation time: pts = (t - mediaStart) / timescale + leadUs
    mediaStart: 0, leadUs: 0,
    // the samples: parallel arrays, decode order
    off: [], size: [], dts: [], cto: [], sync: [], dur: [],
  };

  var tkhd = findBox(buf, trak.dataStart, trak.end, 'tkhd');
  if (tkhd) {
    var th = fullBoxHeader(buf, tkhd), p = th.dataStart;
    t.id = readU32BE(buf, p + (th.version === 1 ? 16 : 8));
    var mx = p + (th.version === 1 ? 48 : 36);
    var a = readS32BE(buf, mx) / 65536, b = readS32BE(buf, mx + 4) / 65536;
    var c = readS32BE(buf, mx + 12) / 65536, d = readS32BE(buf, mx + 16) / 65536;
    // A mirrored matrix (determinant < 0: FFmpeg's -display_hflip, a
    // selfie camera's) is a rotation then a left-right flip — WebCodecs'
    // rotation + flip, x' = -(x cos r - y sin r), y' = x sin r + y cos r,
    // so r = atan2(b, d). It was read as a rotation alone: atan2(b, a) of
    // the plain hflip [-1 0; 0 1] is 180, and the picture was shown
    // upside down where FFmpeg's autorotate only mirrors it.
    t.flip = a * d - b * c < 0;
    var deg = Math.round(Math.atan2(b, t.flip ? d : a) * 180 / Math.PI);
    t.rotation = ((deg % 360) + 360) % 360;
    if (t.rotation % 90) { t.rotation = 0; t.flip = false; }   // a shear / odd matrix: shown as is
    t.displayWidth  = readU32BE(buf, mx + 36) / 65536;
    t.displayHeight = readU32BE(buf, mx + 40) / 65536;
  }

  var mdia = findBox(buf, trak.dataStart, trak.end, 'mdia');
  if (!mdia) return null;
  var mdhd = findBox(buf, mdia.dataStart, mdia.end, 'mdhd');
  if (mdhd) {
    var mh = fullBoxHeader(buf, mdhd);
    t.timescale = mh.version === 1 ? readU32BE(buf, mh.dataStart + 16) : readU32BE(buf, mh.dataStart + 8);
    var d = _duration(buf, mh.dataStart + (mh.version === 1 ? 20 : 12), mh.version === 1);
    if (t.timescale && d != null) t.durationUs = Math.round(d * 1e6 / t.timescale);
  }
  if (!t.timescale) return null;
  var hdlr = findBox(buf, mdia.dataStart, mdia.end, 'hdlr');
  if (hdlr) t.handler = toAscii(buf, hdlr.dataStart + 8, hdlr.dataStart + 12);
  t.type = t.handler === 'vide' ? 'video' : t.handler === 'soun' ? 'audio' : 'other';

  // Edit list: a leading empty edit delays the track; the first media
  // edit says where in the media the presentation starts.
  // Entries past the box's end are not read (see _entries); a
  // media_time below -1 is not one (§8.6.6.3: -1 is an empty edit, the
  // rest are media times): it was taken as the media start, which moved
  // the track later by that many ticks — now the edit list is not
  // applied, as reader_fmp4 does.
  var elst = findPath(buf, trak, 'edts/elst');
  if (elst) {
    var eh = fullBoxHeader(buf, elst), ep = eh.dataStart, esz = eh.version === 1 ? 20 : 12;
    var count = _entries(readU32BE(buf, ep), ep + 4, elst.end, esz); ep += 4;
    var lead = 0, valid = true;
    for (var i = 0; i < count; i++) {
      var segDur, mediaTime;
      if (eh.version === 1) { segDur = readU64BE(buf, ep); mediaTime = readS32BE(buf, ep + 8) * 0x100000000 + readU32BE(buf, ep + 12); }
      else { segDur = readU32BE(buf, ep); mediaTime = readS32BE(buf, ep + 4); }
      ep += esz;
      if (mediaTime === -1) { lead += segDur; continue; }
      if (mediaTime < 0) valid = false;
      else t.mediaStart = mediaTime;
      break;
    }
    if (valid && movieTimescale) t.leadUs = Math.round(lead * 1e6 / movieTimescale);
  }

  var stbl = findPath(buf, mdia, 'minf/stbl');
  if (!stbl) return t;
  var stsd = findBox(buf, stbl.dataStart, stbl.end, 'stsd');
  if (stsd) _parseSampleEntry(buf, stsd, t, qtLayout);
  _parseSampleTables(buf, stbl, t);
  return t;
}


// ── Sample entries → codec, description, sizes ──

function _parseSampleEntry(buf, stsd, t, qtLayout) {
  var stsdVersion = buf[stsd.dataStart];
  var entry = readBoxHeader(buf, stsd.dataStart + 8, stsd.end, false);   // the first entry
  if (!entry) return;
  t.entry = entry.type;
  // The entry's own fields are read within it: a short entry's were read
  // from the boxes after it (and v2's rate through a DataView on the
  // fed buffer itself — past the moov, or a RangeError that failed the
  // file as BAD_MOOV). Past the entry they are 0 now.
  buf = buf.subarray(0, entry.end);
  var E = entry.dataStart;   // past the box header: 6 reserved + 2 data_reference_index

  if (t.type === 'video') {
    t.codedWidth  = readU16BE(buf, E + 24);
    t.codedHeight = readU16BE(buf, E + 26);
    var kids = { start: E + 78, end: entry.end };
    _videoCodec(buf, entry.type, kids, t);
    // Colour information may come in several colr boxes, the most
    // accurate first (14496-12 §12.1.5: an ICC profile, then nclx): only
    // the first was looked at, so an nclx after a 'prof' was not seen.
    var colrs = findBoxes(buf, kids.start, kids.end, 'colr');
    for (var ci = 0; ci < colrs.length && !t.colorSpace; ci++) t.colorSpace = _colr(buf, colrs[ci]);
    if (!t.displayWidth) { t.displayWidth = t.codedWidth; t.displayHeight = t.codedHeight; }
    return;
  }

  if (t.type === 'audio') {
    var ver = readU16BE(buf, E + 8);
    t.numberOfChannels = readU16BE(buf, E + 16);
    var bits = readU16BE(buf, E + 18);
    t.sampleRate = readU32BE(buf, E + 24) >>> 16;
    var kidsStart = E + 28;
    var bytesPerFrame = 0, lpcmFlags = 0;
    // QuickTime's v1 / v2 (QTFF) — or ISO's AudioSampleEntryV1, which is
    // v0's layout (§12.2.3) in an stsd of version 1: it was read as
    // QuickTime's, its boxes looked for 16 bytes too far.
    if (qtLayout || stsdVersion === 0) {
      if (ver === 1) {
        // QuickTime v1: samplesPerPacket, bytesPerPacket, bytesPerFrame, bytesPerSample
        bytesPerFrame = readU32BE(buf, E + 36);
        kidsStart = E + 44;
      } else if (ver === 2) {
        var rate = _f64(buf, E + 32);
        t.sampleRate = rate >= 1 && rate < 0xFFFFFFFF ? Math.round(rate) : 0;   // (NaN, ≤ 0, huge: none)
        t.numberOfChannels = readU32BE(buf, E + 40);
        bits = readU32BE(buf, E + 48);
        lpcmFlags = readU32BE(buf, E + 52);
        bytesPerFrame = readU32BE(buf, E + 56);
        kidsStart = E + 64;
      }
    }
    var kids2 = { start: kidsStart, end: entry.end };
    // A rate of 2^16 or more does not fit the 16.16 field: ISO's 'srat'
    // gives it (§12.2.3), else (FFmpeg writes 0 there) the media
    // timescale, as FFmpeg reads it. A 96 kHz FLAC / ALAC / PCM .mp4
    // came out with sampleRate 0.
    var srat = findBox(buf, kids2.start, kids2.end, 'srat');
    if (srat) t.sampleRate = readU32BE(buf, srat.dataStart + 4);
    _audioCodec(buf, entry.type, kids2, t, bits, bytesPerFrame, lpcmFlags);
    if (!t.sampleRate && t.timescale > 1) t.sampleRate = t.timescale;
    return;
  }
}

// A big-endian IEEE double at o (0 past the end of buf).
function _f64(buf, o) {
  var dv = new DataView(new ArrayBuffer(8));
  dv.setUint32(0, readU32BE(buf, o)); dv.setUint32(4, readU32BE(buf, o + 4));
  return dv.getFloat64(0);
}

function _videoCodec(buf, type, kids, t) {
  var b;
  if (type === 'avc1' || type === 'avc3') {
    b = findBox(buf, kids.start, kids.end, 'avcC');
    if (!b) return;
    t.description = buf.slice(b.dataStart, b.end);
    // (An avcC of under 4 bytes has no profile / level to name: the
    // fallback read past it — a TypeError that failed the file.)
    t.codec = codecStringFromAvcC(t.description, type) || (t.description.length < 4 ? null :
              (type + '.' + _hex2(t.description[1]) + _hex2(t.description[2]) + _hex2(t.description[3])));
    return;
  }
  if (type === 'hvc1' || type === 'hev1') {
    b = findBox(buf, kids.start, kids.end, 'hvcC');
    if (!b) return;
    t.description = buf.slice(b.dataStart, b.end);
    t.codec = codecStringFromHvcC(t.description, type);
    return;
  }
  if (type === 'av01') {
    b = findBox(buf, kids.start, kids.end, 'av1C');
    if (!b) return;
    t.description = buf.slice(b.dataStart, b.end);
    t.codec = codecStringFromAv1C(t.description);
    return;
  }
  if (type === 'vp09' || type === 'vp08') {
    b = findBox(buf, kids.start, kids.end, 'vpcC');
    if (type === 'vp08') { t.codec = 'vp8'; return; }
    var v = b ? fullBoxHeader(buf, b).dataStart : 0;
    // (A vpcC too short for profile / level / bit depth: as none — it
    // gave 'vp09.undefined.undefined.00'.)
    if (!b || v + 3 > b.end) { t.codec = 'vp09.00.10.08'; return; }
    t.codec = 'vp09.' + _pad2(buf[v]) + '.' + _pad2(buf[v + 1]) + '.' + _pad2(buf[v + 2] >> 4);
    return;
  }
  // mp4v, encv (encrypted), jpeg, … — not a WebCodecs video codec.
}

// A box among the entry's boxes, or inside its QuickTime 'wave'.
function _kidOrWave(buf, kids, type) {
  var b = findBox(buf, kids.start, kids.end, type);
  if (b) return b;
  var wave = findBox(buf, kids.start, kids.end, 'wave');
  return wave ? findBox(buf, wave.dataStart, wave.end, type) : null;
}

function _audioCodec(buf, type, kids, t, bits, bytesPerFrame, lpcmFlags) {
  if (type === 'mp4a') {
    // The esds may be inside a 'wave' (QuickTime).
    var esds = _kidOrWave(buf, kids, 'esds');
    if (esds) _esds(buf, esds, t);
    return;
  }
  // QuickTime's MP3 entries ('.mp3', 'ms\0U' — QTFF): codec null before.
  if (type === '.mp3' || type === 'ms\u0000U') { t.codec = 'mp3'; return; }
  if (type === 'Opus') {
    var dops = findBox(buf, kids.start, kids.end, 'dOps');
    t.codec = 'opus';
    if (dops) t.description = _opusHead(buf, dops);
    return;
  }
  if (type === 'fLaC') {
    var dfla = findBox(buf, kids.start, kids.end, 'dfLa');
    t.codec = 'flac';
    if (dfla) t.description = concat([fromAscii('fLaC'), buf.slice(dfla.dataStart + 4, dfla.end)]);
    return;
  }
  if (type === 'alac') {
    // In a .mov the 'alac' box is inside 'wave' (what FFmpeg and Apple
    // write): it was looked for among the entry's boxes only, so a .mov's
    // ALAC track had no description.
    var alac = _kidOrWave(buf, kids, 'alac');
    t.codec = 'alac';
    if (alac) t.description = buf.slice(alac.dataStart + 4, alac.end);
    return;
  }
  // PCM: a QuickTime "sample" is one audio frame (a few bytes): they are
  // grouped by chunk (_pcmChunks). µ-law / A-law are such a format too
  // (one byte per channel): they went out one frame per sample — 48 000
  // samples a second, each with a duration rounded to 21 µs.
  if (type === 'ulaw' || type === 'alaw') {
    t.codec = type;
    t.pcm = true;
    t.pcmFrameBytes = bytesPerFrame || (t.numberOfChannels || 1);
    return;
  }
  if (type === 'sowt' || type === 'twos' || type === 'raw ' || type === 'in24' || type === 'in32' || type === 'fl32' || type === 'lpcm') {
    var width = type === 'raw ' ? 8 : type === 'in24' ? 24 : (type === 'in32' || type === 'fl32') ? 32 : (bits || 16);
    if (type === 'lpcm') {
      // QuickTime v2 LPCM (what FFmpeg writes for PCM above 65535 Hz):
      // formatSpecificFlags (kAudioFormatFlagIsFloat 1, IsBigEndian 2,
      // IsSignedInteger 4) say what it is. Not recognised before — no
      // codec, and one sample per frame.
      var fl = lpcmFlags & 1, signed = lpcmFlags & 4;
      t.codec = fl ? (width === 32 ? 'pcm-f32' : null)
        : signed ? ([16, 24, 32].indexOf(width) >= 0 ? 'pcm-s' + width : null)
        : width === 8 ? 'pcm-u8' : null;
      t.bigEndian = !!(lpcmFlags & 2);
    } else {
      // 'twos' / 'sowt' of 8 bits is signed — 'pcm-s8', which WebCodecs
      // does not name (its PCM codecs: pcm-u8, -s16, -s24, -s32, -f32);
      // of 12, 'pcm-s12'. Those went out as codec strings.
      t.codec = type === 'raw ' ? 'pcm-u8' : type === 'fl32' ? 'pcm-f32'
        : [16, 24, 32].indexOf(width) >= 0 ? 'pcm-s' + width : null;
      t.bigEndian = type !== 'sowt' && type !== 'raw ';
      // An 'enda' (in 'wave') of 1 makes in24 / in32 / fl32 little-endian
      // (QTFF; FFmpeg writes it for pcm_s24le / s32le / f32le in .mov):
      // it was ignored, and such a track was read as big-endian.
      if (type === 'in24' || type === 'in32' || type === 'fl32') {
        var enda = _kidOrWave(buf, kids, 'enda');
        if (enda && (readU16BE(buf, enda.dataStart) & 0xFF)) t.bigEndian = false;
      }
    }
    t.pcm = true;
    // (whole bytes: 12-bit samples take 2 — a fractional frame size put
    // samples at fractional offsets)
    t.pcmFrameBytes = bytesPerFrame || Math.ceil(width / 8) * (t.numberOfChannels || 1);
    return;
  }
  // ISO/IEC 23003-5 PCM in ISO BMFF ('ipcm' integer, 'fpcm' float — what
  // FFmpeg writes for PCM in .mp4): the pcmC box gives the sample size and
  // byte order. Unrecognised, such a track had no codec and was skipped —
  // 0 of 130 samples.
  if (type === 'ipcm' || type === 'fpcm') {
    var pcmc = findBox(buf, kids.start, kids.end, 'pcmC');
    var little = true, ssize = bits || 16;
    if (pcmc && pcmc.end - pcmc.dataStart >= 6) {
      little = (buf[pcmc.dataStart + 4] & 1) === 1;
      ssize = buf[pcmc.dataStart + 5] || ssize;
    }
    if (type === 'fpcm' && ssize !== 32) return;          // pcm-f32 only
    if (type === 'ipcm' && [16, 24, 32].indexOf(ssize) < 0) return;
    t.codec = type === 'fpcm' ? 'pcm-f32' : 'pcm-s' + ssize;
    t.bigEndian = !little;
    t.pcm = true;
    t.pcmFrameBytes = (ssize / 8) * (t.numberOfChannels || 1);
    return;
  }
  // enca (encrypted), ac-3, ec-3, samr, … — not a WebCodecs audio codec here.
}

// esds → codec + AudioSpecificConfig (ISO/IEC 14496-1 §7.2.6)
function _esds(buf, esds, t) {
  var p = esds.dataStart + 4, end = esds.end;
  function desc() {
    if (p >= end) return null;
    var tag = buf[p++], len = 0, n = 0, b;
    do { b = buf[p++]; len = (len << 7) | (b & 0x7F); n++; } while ((b & 0x80) && n < 4);
    return { tag: tag, start: p, end: Math.min(p + len, end) };
  }
  var es = desc();
  if (!es || es.tag !== 0x03) return;
  p = es.start + 2;
  var fl = buf[p++];
  if (fl & 0x80) p += 2;
  if (fl & 0x40) p += 1 + buf[p];
  if (fl & 0x20) p += 2;
  var dc = desc();
  if (!dc || dc.tag !== 0x04) return;
  var oti = buf[dc.start];
  p = dc.start + 13;
  var dsi = p < dc.end ? desc() : null;
  if (oti === 0x69 || oti === 0x6B) { t.codec = 'mp3'; return; }
  if (oti === 0x40 || oti === 0x66 || oti === 0x67 || oti === 0x68) {
    var asc = dsi && dsi.tag === 0x05 ? buf.slice(dsi.start, dsi.end) : null;
    var a = asc ? parseAudioSpecificConfig(asc) : null;
    t.description = asc;
    t.codec = oti === 0x40 ? 'mp4a.40.' + ((a && a.objectType) || 2) : 'mp4a.' + oti.toString(16);
    if (a) {
      if (a.sampleRate) t.sampleRate = _sbrRate(asc) || a.sampleRate;
      if (a.channels) t.numberOfChannels = a.channels;
    }
  }
}

var AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

// HE-AAC: the decoder's output rate is SBR's extension sampling frequency
// (14496-3 §1.6.2.1 / §1.6.5), not the core's. The core's was taken —
// half the rate (24000 for 48 kHz HE-AAC; FFmpeg: 48000). Explicit
// signalling (audioObjectType 5 / 29, then the extension rate) and the
// backward-compatible kind (an AAC config, then syncExtensionType 0x2B7,
// SBR, sbrPresentFlag 1) are read; 0 when there is no SBR (or a PCE — a
// channelConfiguration of 0 — stands in the way).
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
  // GASpecificConfig (§4.4.1) of AAC Main / LC / SSR / LTP
  bits(1);                                   // frameLengthFlag
  if (bits(1)) bits(14);                     // dependsOnCoreCoder → coreCoderDelay
  if (bits(1)) bits(1);                      // extensionFlag → extensionFlag3
  if (n - pos < 16 || bits(11) !== 0x2B7 || aot() !== 5 || !bits(1)) return 0;
  return pos + 4 <= n ? rate() : 0;
}

// dOps (big-endian) → OpusHead (Ogg identification header, little-endian):
// what WebCodecs takes as an Opus description.
function _opusHead(buf, dops) {
  var o = dops.dataStart;
  var channels = buf[o + 1], preSkip = readU16BE(buf, o + 2), rate = readU32BE(buf, o + 4);
  var gain = readU16BE(buf, o + 8), family = buf[o + 10];
  var map = family ? buf.slice(o + 11, dops.end) : new Uint8Array(0);
  var out = new Uint8Array(19 + map.length);
  out.set(fromAscii('OpusHead'), 0);
  out[8] = 1; out[9] = channels;
  out[10] = preSkip & 0xFF; out[11] = preSkip >> 8;
  out[12] = rate & 0xFF; out[13] = (rate >> 8) & 0xFF; out[14] = (rate >> 16) & 0xFF; out[15] = (rate >>> 24) & 0xFF;
  out[16] = gain & 0xFF; out[17] = gain >> 8; out[18] = family;
  out.set(map, 19);
  return out;
}

// colr 'nclx' / 'nclc' → a VideoColorSpaceInit
function _colr(buf, colr) {
  var o = colr.dataStart, kind = toAscii(buf, o, o + 4);
  if (kind !== 'nclx' && kind !== 'nclc') return null;
  return colorSpaceFromCicp(readU16BE(buf, o + 4), readU16BE(buf, o + 6), readU16BE(buf, o + 8),
                            kind === 'nclx' ? (buf[o + 10] & 0x80) : null);
}


// ── Sample tables (stts, ctts, stss, stsz / stz2, stsc, stco / co64) ──

// How many of a table's `count` entries of `size` bytes, from p, fit in
// the box (ending at end). The counts were taken as written: a count
// past the box read its entries from the boxes after it (an elst whose
// count said 2 for 1 entry took the next box's header as a media_time,
// and every pts came out −143 382 s; FFmpeg reads within the box).
function _entries(count, p, end, size) {
  return Math.min(count, Math.max(0, Math.floor((end - p) / size)));
}

// An mvhd / mdhd duration; null when all ones — "cannot be determined"
// (14496-12 §8.2.2.3, §8.4.2.3). mvhd's was taken as 2^32 − 1 ticks (an
// info.durationUs of 4 294 967 295 000 for a 1 s file), mdhd v1's as
// 2^64 − 1.
function _duration(buf, p, v1) {
  if (v1) return readU32BE(buf, p) === 0xFFFFFFFF && readU32BE(buf, p + 4) === 0xFFFFFFFF ? null : readU64BE(buf, p);
  var d = readU32BE(buf, p);
  return d === 0xFFFFFFFF ? null : d;
}

function _parseSampleTables(buf, stbl, t) {
  var F = function (type) { return findBox(buf, stbl.dataStart, stbl.end, type); };
  var stsz = F('stsz'), stz2 = F('stz2'), stsc = F('stsc'), stco = F('stco') || F('co64');
  var stts = F('stts'), ctts = F('ctts'), stss = F('stss');
  if (!(stsz || stz2) || !stsc || !stco || !stts) return;

  // sizes
  var sizes = [], n, p, i;
  if (stsz) {
    p = fullBoxHeader(buf, stsz).dataStart;
    var fixed = readU32BE(buf, p); n = readU32BE(buf, p + 4); p += 8;
    if (!fixed) n = _entries(n, p, stsz.end, 4);
    for (i = 0; i < n; i++) { sizes.push(fixed || readU32BE(buf, p)); if (!fixed) p += 4; }
  } else {
    p = fullBoxHeader(buf, stz2).dataStart;
    var field = buf[p + 3]; n = readU32BE(buf, p + 4); p += 8;
    n = Math.min(n, Math.max(0, Math.floor((stz2.end - p) * 8 / (field === 4 ? 4 : field === 8 ? 8 : 16))));
    for (i = 0; i < n; i++) {
      if (field === 4) sizes.push((i & 1) ? (buf[p + (i >> 1)] & 0x0F) : (buf[p + (i >> 1)] >> 4));
      else if (field === 8) sizes.push(buf[p + i]);
      else sizes.push(readU16BE(buf, p + i * 2));
    }
  }

  // chunk offsets
  var chunks = [];
  var ch = fullBoxHeader(buf, stco), cp = ch.dataStart, cn = readU32BE(buf, cp); cp += 4;
  var wide = stco.type === 'co64';
  cn = _entries(cn, cp, stco.end, wide ? 8 : 4);
  for (i = 0; i < cn; i++) { chunks.push(wide ? readU64BE(buf, cp) : readU32BE(buf, cp)); cp += wide ? 8 : 4; }

  // samples per chunk
  var sc = fullBoxHeader(buf, stsc), sp = sc.dataStart, sn = readU32BE(buf, sp); sp += 4;
  sn = _entries(sn, sp, stsc.end, 12);
  var runs = [];
  for (i = 0; i < sn; i++) { runs.push({ first: readU32BE(buf, sp), per: readU32BE(buf, sp + 4) }); sp += 12; }

  // durations / decode times
  var deltas = [];
  var tt = fullBoxHeader(buf, stts), tp = tt.dataStart, tn = readU32BE(buf, tp); tp += 4;
  tn = _entries(tn, tp, stts.end, 8);
  for (i = 0; i < tn; i++) {
    var cnt = readU32BE(buf, tp), dl = readU32BE(buf, tp + 4); tp += 8;
    for (var k = 0; k < cnt && deltas.length < n; k++) deltas.push(dl);
  }

  // cslg (composition to decode timeline mapping): its shift moves DTS so
  // that no sample decodes after it is presented (see _dtsShift).
  var cslg = F('cslg');
  if (cslg) {
    var cg = fullBoxHeader(buf, cslg);
    t.cslgShift = cg.version === 1
      ? readS32BE(buf, cg.dataStart) * 4294967296 + readU32BE(buf, cg.dataStart + 4)
      : readS32BE(buf, cg.dataStart);
    if (!(t.cslgShift > 0)) t.cslgShift = 0;
  }

  // composition offsets (signed — version 0 writers put negatives there too)
  var ctos = null;
  if (ctts) {
    ctos = [];
    var ct = fullBoxHeader(buf, ctts), op = ct.dataStart, on = readU32BE(buf, op); op += 4;
    on = _entries(on, op, ctts.end, 8);
    for (i = 0; i < on; i++) {
      var oc = readU32BE(buf, op), ov = readS32BE(buf, op + 4); op += 8;
      for (var m = 0; m < oc && ctos.length < n; m++) ctos.push(ov);
    }
  }

  // sync samples (absent → all are)
  var sync = null;
  if (stss) {
    sync = new Uint8Array(n);
    var ss = fullBoxHeader(buf, stss), xp = ss.dataStart, xn = readU32BE(buf, xp); xp += 4;
    xn = _entries(xn, xp, stss.end, 4);
    for (i = 0; i < xn; i++) { var num = readU32BE(buf, xp) - 1; xp += 4; if (num >= 0 && num < n) sync[num] = 1; }
  }

  // PCM in QuickTime: a "sample" is one audio frame (a few bytes) — one
  // per chunk instead, or there'd be tens of thousands of tiny samples.
  if (t.pcm) return _pcmChunks(t, sizes, chunks, runs, deltas);

  var s = 0, dts = 0;
  for (var c = 0, r = 0; c < chunks.length && s < n; c++) {
    while (r + 1 < runs.length && runs[r + 1].first <= c + 1) r++;
    var per = runs.length ? runs[r].per : 1;
    var off = chunks[c];
    for (var j = 0; j < per && s < n; j++, s++) {
      var d = deltas[s] != null ? deltas[s] : (deltas[deltas.length - 1] || 0);
      t.off.push(off); t.size.push(sizes[s]); t.dts.push(dts); t.dur.push(d);
      t.cto.push(ctos ? (ctos[s] || 0) : 0);
      t.sync.push(sync ? sync[s] : 1);
      off += sizes[s]; dts += d;
    }
  }
}

function _pcmChunks(t, sizes, chunks, runs, deltas) {
  var s = 0, dts = 0, frameBytes = t.pcmFrameBytes || sizes[0] || 1;
  var fixed = sizes.length && sizes[0] && sizes.every(function (x) { return x === sizes[0]; });
  for (var c = 0, r = 0; c < chunks.length; c++) {
    while (r + 1 < runs.length && runs[r + 1].first <= c + 1) r++;
    var frames = runs.length ? runs[r].per : 1;
    // stsz of QuickTime PCM is often 1 per frame; the bytes are frames × frameBytes.
    var bytes = fixed && sizes[0] <= 1 ? frames * frameBytes : frames * (sizes[0] || frameBytes);
    // A chunk can hold the whole track (FFmpeg writes a 3 s audio-only
    // .mp4 as one 264 600-byte chunk): split it into packets of at most
    // PCM_PACKET_FRAMES frames, as FFmpeg's mov demuxer does, so a
    // decoder gets steady, small packets instead of one huge one.
    var bpf = frames ? bytes / frames : frameBytes;
    for (var f = 0; f < frames; f += PCM_PACKET_FRAMES) {
      var nf = Math.min(PCM_PACKET_FRAMES, frames - f), dur = 0;
      for (var j = 0; j < nf; j++) dur += deltas[s + j] != null ? deltas[s + j] : 1;
      t.off.push(chunks[c] + f * bpf); t.size.push(nf * bpf); t.dts.push(dts); t.dur.push(dur);
      t.cto.push(0); t.sync.push(1);
      s += nf; dts += dur;
    }
  }
}
var PCM_PACKET_FRAMES = 1024;


// ── Fragments (moof / traf / trun) ──

function _addFragments(tracks, moofs, trex) {
  var byId = {};
  tracks.forEach(function (t) { byId[t.id] = t; t._fragDts = t.dts.length ? t.dts[t.dts.length - 1] + t.dur[t.dur.length - 1] : 0; });
  moofs.forEach(function (m) {
    var buf = m.bytes, moof = readBoxHeader(buf, 0, buf.length, true);
    if (!moof) return;
    var prevEnd = m.box.start;   // no base offset, not the first traf: after the previous one's data
    findBoxes(buf, moof.dataStart, moof.end, 'traf').forEach(function (traf, ti) {
      var tfhdBox = findBox(buf, traf.dataStart, traf.end, 'tfhd');
      if (!tfhdBox) return;
      var h = parseTfhd(buf, tfhdBox), t = byId[h.trackId];
      if (!t) return;
      var x = trex[h.trackId] || {};
      var defDur  = h.defaultSampleDuration != null ? h.defaultSampleDuration : (x.duration || 0);
      var defSize = h.defaultSampleSize != null ? h.defaultSampleSize : (x.size || 0);
      var defFlag = h.defaultSampleFlags != null ? h.defaultSampleFlags : (x.flags || 0);
      var base = h.baseDataOffset != null ? h.baseDataOffset
               : (h.defaultBaseIsMoof || ti === 0) ? m.box.start : prevEnd;
      var tfdt = findBox(buf, traf.dataStart, traf.end, 'tfdt');
      var dts = tfdt ? parseTfdt(buf, tfdt) : t._fragDts;
      var dataPos = base;
      findBoxes(buf, traf.dataStart, traf.end, 'trun').forEach(function (trunBox) {
        var tr = parseTrun(buf, trunBox);
        if (tr.dataOffset != null) dataPos = base + tr.dataOffset;
        tr.samples.forEach(function (s, i) {
          var size = s.size != null ? s.size : defSize;
          var dur  = s.duration != null ? s.duration : defDur;
          var fl   = s.flags != null ? s.flags : (i === 0 && tr.firstSampleFlags != null ? tr.firstSampleFlags : defFlag);
          t.off.push(dataPos); t.size.push(size); t.dts.push(dts); t.dur.push(dur);
          t.cto.push(s.compositionOffset); t.sync.push(t.type === 'video' ? (isSyncSampleFlags(fl) ? 1 : 0) : 1);
          dataPos += size; dts += dur;
        });
      });
      t._fragDts = dts;
      prevEnd = dataPos;
    });
  });
  tracks.forEach(function (t) { delete t._fragDts; });
}


// ── The track as the caller sees it ──

function _finishTrack(t, fragmented) {
  var n = t.off.length, bytes = 0, ticks = 0;
  for (var i = 0; i < n; i++) { bytes += t.size[i]; ticks += t.dur[i]; }
  t.sampleCount = n;
  t.sampleTicks = ticks;
  if (n) {
    var last = t.dts[n - 1] + t.dur[n - 1];
    var us = Math.round((last - t.mediaStart) * 1e6 / t.timescale) + t.leadUs;
    // A fragmented file's mdhd covers the moov's samples only (§8.8.1):
    // once fragments go past it, what's indexed is the duration. It kept
    // the mdhd's (400 ms for 20 samples of 40 ms).
    if (us > 0 && (!t.durationUs || t.durationUs < us / 2 || (fragmented && us > t.durationUs))) t.durationUs = us;
  }
  t.bitrate = t.durationUs ? Math.round(bytes * 8 * 1e6 / t.durationUs) : 0;
  // The first shown time: the smallest pts of the first samples (B-frames
  // come out of order only within a GOP's start).
  t.startUs = 0;
  if (n) {
    var min = Infinity;
    for (var j = 0; j < Math.min(n, 64); j++) {
      var pts = Math.round((t.dts[j] + t.cto[j] - t.mediaStart) * 1e6 / t.timescale) + t.leadUs;
      if (pts < min) min = pts;
    }
    t.startUs = min;
  }
}

function _publicTrack(t) {
  var p = {
    id: t.id, type: t.type, handler: t.handler, entry: t.entry, codec: t.codec,
    description: t.description, timescale: t.timescale, durationUs: t.durationUs,
    sampleCount: t.sampleCount, bitrate: t.bitrate, startUs: t.startUs, config: null,
  };
  if (t.type === 'video') {
    p.codedWidth = t.codedWidth; p.codedHeight = t.codedHeight;
    p.displayWidth = t.displayWidth; p.displayHeight = t.displayHeight;
    p.rotation = t.rotation; p.flip = t.flip; p.colorSpace = t.colorSpace;
    // Samples per second of their own durations (FFmpeg's avg_frame_rate).
    // It was sampleCount / durationUs — the mdhd duration, which FFmpeg
    // makes include the B-frame delay: 24.04 for a 25 fps file.
    p.frameRate = t.sampleTicks ? Math.round(t.sampleCount * t.timescale / t.sampleTicks * 100) / 100 : 0;
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


function _hex2(n) { return (n < 16 ? '0' : '') + n.toString(16); }
function _pad2(n) { n = String(n); return n.length < 2 ? '0' + n : n; }

export default MP4Reader;
