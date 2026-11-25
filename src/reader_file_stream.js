/**
 * reader_file_stream — the FILE side of the containers that are a run of
 * frames rather than an index plus data: MPEG-TS, ADTS, Ogg, IVF, FLV,
 * raw Annex-B H.264 / H.265, MP3, FLAC, WAV. One format module each
 * (reader_ts_file, reader_adts_file, reader_ogg_file, reader_ivf_file,
 * reader_flv_file, reader_annexb_file, reader_mp3, reader_flac,
 * reader_wav) says how its bytes become frames; this base does the rest,
 * with the API and events of reader_mp4 / reader_webm:
 *
 *   var r = new XReader({ size: fileSize });     // size: optional, but say it if known
 *   r.on('info' | 'video' | 'audio' | 'need' | 'end' | 'error', fn);
 *   r.feed(bytes, offset); r.end();
 *   r.select(ids); r.seek(timeUs); r.progress();
 *
 * (see reader_mp4.js for what 'info', a track and a sample carry).
 *
 * Feeding in order from 0 is all a file needs, except: a format may ask
 * for its last bytes before 'info' (where the duration is — TS, Ogg, an
 * FLV without one in its metadata), and seek() asks to be fed from where
 * it reads next. Memory: the frame being read, plus — before 'info' —
 * the frames read while the format still looks for its configs (at most
 * EARLY_SAMPLES / EARLY_BYTES).
 *
 * 'info' comes once every track the format found has its decoder config
 * (TS: the first keyframe's parameter sets and the first ADTS header;
 * FLV: the sequence headers; …) — or once that has taken EARLY_SAMPLES /
 * EARLY_BYTES, the tracks still without one then going out with codec
 * null.
 *
 * seek(timeUs): video from the last keyframe at / before the time; audio
 * from the frame playing at the time (with video: from that keyframe's
 * time). How the spot is found:
 *   1. keyframes (and, every AUDIO_INDEX_US, audio frames) already read
 *      are indexed: when the keyframes around the time are known, the
 *      reader asks for the one at / before it directly;
 *   2. a format with an index of its own (FLAC SEEKTABLE, the Xing TOC of
 *      a VBR MP3, a CBR MP3's or a WAV's fixed frame size) says where to
 *      start (fmt.locate) — an estimate (the TOC) only when it saves
 *      reading more than ESTIMATE_MIN;
 *   3. a format whose frames carry their own time and can be found from
 *      any byte (TS, FLV, Ogg, FLAC, CBR MP3) is bisected: a 'need' for a
 *      guess, the first keyframe after it says which side the time is on;
 *   4. else (ADTS, Annex-B, IVF, VBR MP3 without a TOC: times are counted
 *      from the start) it reads on from the last indexed point before the
 *      time (or the start), emitting nothing, to the keyframe after it —
 *      then asks for the one before.
 * Video frames from the keyframe on are emitted; audio frames from the
 * one playing at its time.
 *
 * A format module (the object passed in) has:
 *   container                 info.container
 *   tracks                    the public track objects (reader_mp4's
 *                             shape); the base sets startUs / frameRate
 *   parse(win, pos, eof, emit) → the position after what it used. win is
 *                             the FileWindow; pos where to go on; eof: no
 *                             bytes after win.end(). It emits each frame
 *                             with emit({ trackId, payload, isKeyframe,
 *                             ptsUs, dtsUs, durationUs, pos (the byte
 *                             where reading must restart to get this frame
 *                             again), state (what reset() needs to restart
 *                             there; counting formats), estimated (its time
 *                             is a guess — not indexed) }); emit() false:
 *                             stop now. Returning pos itself: it needs more
 *                             bytes (so after reading a header it goes on). A position past win.end(): skip there;
 *                             Infinity: nothing after this is read.
 *   ready()                   are the configs complete?
 *   reset(pos, state)         go on from pos: with an index entry's state,
 *                             or null (pos = dataStart: from the start;
 *                             else find the next frame — resync formats)
 *   dataStart                 where the first frame is (after the headers)
 *   resync                    true: can start anywhere, times stay exact
 *   locate(timeUs)            optional → { pos, ptsUs, state } where to
 *                             start reading for timeUs: a frame (with video:
 *                             a keyframe) at / before it, reset() with state;
 *                             estimated: its time is a guess
 *   tailFrom, parseTail(bytes, offset)   optional: the last bytes, wanted
 *                             before 'info' (tailFrom set by parse)
 *   durationUs, startUs       optional: info.durationUs / info.startUs
 *   estimateVideoDuration     video frames have no duration of their own:
 *                             the frame interval of the first frames is
 *                             used (FFmpeg guesses it from the frame rate)
 *
 * Sans-I/O: bytes in, events out — no file or Node API here.
 */

import EventEmitter from './core/events.js';
import FileWindow from './core/file_window.js';

var EARLY_SAMPLES = 600;
var EARLY_BYTES = 8 * 1024 * 1024;
var ESTIMATE_FRAMES = 8;         // video frames read before 'info' when their durations are guessed
var AUDIO_INDEX_US = 500000;
var BISECT_MIN = 256 * 1024;     // closer than this: read on instead
var BISECT_STEPS = 24;
var PREROLL_US = 2000000;        // a bisection guess aims this much before the time
var ESTIMATE_MIN = 2 * 1024 * 1024;   // an estimated locate() only this far ahead (else read there)

function FileStreamReader(fmt, opts) {
  if (!opts) opts = {};
  this._fmt = fmt;
  fmt.fileSize = opts.size || 0;
  this._ee = new EventEmitter();
  this._size = opts.size || 0;
  this._win = new FileWindow();
  this._pos = 0;
  this._eof = false;
  this._flushedAt = -1;
  this._infoSent = false;
  this._info = null;
  this._early = [];
  this._earlyBytes = 0;
  this._selected = null;           // track ids; null: not chosen yet
  this._idx = {};                  // trackId → sync points [{ pos, ptsUs, state, run, seq }], by time
  this._run = 0;                   // a contiguous read: a new one after every jump
  this._seq = {};                  // trackId → sync points recorded in this run
  this._lastIdx = {};              // trackId → the last audio point indexed (thinning)
  this._jumped = false;            // a jump during parse(): stop it, go on from _pos
  this._scan = null;               // { t, track, video, probe: { lo, hi, steps, at } | null }
  this._gate = null;               // after a jump: { from, key: false } — see _deliver
  this._hold = null;               // audio from the frame playing at t: { t, held: {} }
  this._tail = 0;                  // 0 none, 1 reading, 2 done
  this._tailBack = 0;
  this._askedAt = -1;
  this._busy = false;
  this._again = false;
  this._ended = false;
  this._failed = false;
}

FileStreamReader.prototype.on  = function (ev, fn) { this._ee.on(ev, fn); return this; };
FileStreamReader.prototype.off = function (ev, fn) { this._ee.off(ev, fn); return this; };

FileStreamReader.prototype.feed = function (bytes, offset) {
  if (this._ended || this._failed) return;
  this._win.add(bytes, offset);
  this._eof = false;
  if (this._askedAt >= 0 && this._win.has(this._askedAt, 1)) this._askedAt = -1;
  this._process();
};

/** The bytes fed so far run to the end of the file. */
FileStreamReader.prototype.end = function () {
  if (this._ended || this._failed) return;
  this._eof = true;
  this._process();
};

FileStreamReader.prototype._fail = function (code, message) {
  if (this._failed) return;
  this._failed = true;
  // (a stream reader's own error already names it: no second prefix)
  var prefix = this._fmt.name + ': ';
  var e = new Error(String(message).indexOf(prefix) === 0 ? message : prefix + message);
  e.code = code;
  this._ee.emit('error', e);
};

FileStreamReader.prototype._want = function (offset, jump) {
  if (this._askedAt === offset || this._win.has(offset, 1)) return;
  if (!jump && !this._win.mustAsk(offset)) return;
  this._askedAt = offset;
  this._ee.emit('need', { offset: offset, length: 0 });
};

FileStreamReader.prototype._atEof = function (offset) {
  if (offset === Infinity) return true;             // parse() said: nothing more to read
  if (this._size) return offset >= this._size;
  return this._eof && offset >= this._win.fedEnd;
};

FileStreamReader.prototype._process = function () {
  if (this._busy) { this._again = true; return; }
  this._busy = true;
  try {
    do { this._again = false; this._step(); } while (this._again && !this._failed);
  } catch (e) {
    this._fail(e.code || 'BAD_DATA', e.message);
  } finally {
    this._busy = false;
  }
};

FileStreamReader.prototype._step = function () {
  var fmt = this._fmt, win = this._win, self = this;
  var emit = function (s) { return self._onSample(s); };
  while (!this._failed && !this._ended) {
    if (this._tail === 1 && !this._readTail()) return;
    var pos = this._pos;
    if (!win.has(pos, 1)) {
      if (this._atEof(pos)) {
        if (this._flushedAt !== pos) {
          this._flushedAt = pos;
          this._jumped = false;
          fmt.parse(win, pos, true, emit);
          if (this._failed) return;
          if (this._jumped) { this._jumped = false; continue; }
          if (!this._infoSent) this._sendInfo();
          if (this._jumped) { this._jumped = false; continue; }
        }
        if (!this._atEnd()) continue;
        return;
      }
      this._want(pos, false);
      return;
    }
    var eof = this._atEof(win.end());
    this._jumped = false;
    var np = fmt.parse(win, pos, eof, emit);
    if (this._failed) return;
    if (this._jumped) { this._jumped = false; continue; }
    if (np === pos && eof) np = win.end();
    if (np > pos) {
      this._pos = np;
      // (Before 'info' the head is kept — at most EARLY_BYTES: a small
      // file's tail may be in it.)
      if (this._infoSent || win.end() - win.off > EARLY_BYTES) win.trim(Math.min(np, win.end()));
    }
    if (this._tailPending()) { this._startTail(); continue; }
    if (!this._infoSent && this._ready() && this._tail !== 1) {
      this._sendInfo();
      if (this._jumped) { this._jumped = false; continue; }
    }
    if (np === pos) {
      this._want(win.end(), false);
      return;
    }
  }
};

// ── Before 'info': the last bytes of the file (the duration) ──

// The format has its configs — and, when video frame durations are to be
// guessed, enough frames to guess from.
FileStreamReader.prototype._ready = function () {
  if (!this._fmt.ready()) return false;
  if (!this._fmt.estimateVideoDuration) return true;
  var self = this, n = 0;
  this._early.forEach(function (s) { var t = self._trackById(s.trackId); if (t && t.type === 'video') n++; });
  return n >= ESTIMATE_FRAMES;
};

FileStreamReader.prototype._tailPending = function () {
  return !this._infoSent && this._tail === 0 && this._fmt.tailFrom != null && !!this._size;
};

FileStreamReader.prototype._startTail = function () {
  var from = this._fmt.tailFrom;
  if (from >= this._size) { this._tail = 2; return; }
  if (this._win.has(from, this._size - from)) {
    // all here already (a small file)
    try { this._fmt.parseTail(this._win.view(from, this._size - from), from); } catch (e) { /* no duration then */ }
    this._tail = 2;
    return;
  }
  this._tail = 1;
  this._tailBack = this._pos;
  this._want(from, true);
};

// The tail, once it's here: read it, then back to where reading was.
FileStreamReader.prototype._readTail = function () {
  var from = this._fmt.tailFrom, n = this._size - from;
  if (!this._win.has(from, n)) {
    if (!this._win.has(from, 1)) this._want(from, true);
    return false;
  }
  try { this._fmt.parseTail(this._win.view(from, n), from); } catch (e) { /* no duration then */ }
  this._tail = 2;
  this._pos = this._tailBack;
  this._askedAt = -1;
  this._want(this._pos, true);
  return true;
};

// ── Samples ──

FileStreamReader.prototype._onSample = function (s) {
  this._record(s);
  if (this._scan) return this._scanSample(s);
  if (!this._infoSent) {
    this._early.push(s);
    this._earlyBytes += s.payload.length;
    if (this._tailPending()) return false;     // stop: the tail first
    if (this._ready() || this._early.length >= EARLY_SAMPLES || this._earlyBytes >= EARLY_BYTES) this._sendInfo();
    return !this._jumped;
  }
  this._deliver(s);
  return !this._jumped && !this._ended && !this._failed;
};

// Index a sync point: a video keyframe, an audio frame every AUDIO_INDEX_US.
FileStreamReader.prototype._record = function (s) {
  if (s.estimated) return;
  var t = this._trackById(s.trackId);
  if (!t || (t.type !== 'video' && t.type !== 'audio')) return;
  if (t.type === 'video' && !s.isKeyframe) return;
  if (t.type === 'audio') {
    var last = this._lastIdx[s.trackId];
    if (last && last.run === this._run && s.ptsUs - last.ptsUs < AUDIO_INDEX_US && s.ptsUs >= last.ptsUs) return;
  }
  var list = this._idx[s.trackId] || (this._idx[s.trackId] = []);
  var seq = this._seq[s.trackId] = (this._seq[s.trackId] || 0) + 1;
  var e = { pos: s.pos, ptsUs: s.ptsUs, state: s.state || null, run: this._run, seq: seq };
  this._lastIdx[s.trackId] = e;
  var i = _search(list, s.ptsUs);              // first entry with ptsUs > s.ptsUs
  if (i > 0 && list[i - 1].pos === s.pos) { list[i - 1].run = e.run; list[i - 1].seq = e.seq; return; }
  list.splice(i, 0, e);
};

FileStreamReader.prototype._trackById = function (id) {
  var ts = this._fmt.tracks;
  for (var i = 0; i < ts.length; i++) if (ts[i].id === id) return ts[i];
  return null;
};

FileStreamReader.prototype._isSelected = function (id) {
  return this._selected && this._selected.indexOf(id) !== -1;
};

// A sample, after 'info': through the seek gates, then out.
FileStreamReader.prototype._deliver = function (s) {
  if (!this._isSelected(s.trackId)) return;
  var t = this._trackById(s.trackId);
  if (t.estimate && !s.durationUs) s.durationUs = t.frameDurUs || 0;
  var g = this._gate;
  if (g) {
    // After a jump to a keyframe: video from that keyframe, audio from
    // the frame playing at its time.
    if (t.type === 'video') {
      if (!g.key) {
        if (!(s.isKeyframe && s.trackId === g.track)) return;
        g.key = true;
      }
    } else if (s.durationUs ? s.ptsUs + s.durationUs <= g.from : s.ptsUs < g.from) {
      return;
    }
  }
  var h = this._hold;
  if (h && t.type === 'audio') {
    if (s.ptsUs <= h.t) { h.held[s.trackId] = s; return; }
    var p = h.held[s.trackId];
    if (p) { delete h.held[s.trackId]; this._out(t, p); }
    h.open[s.trackId] = true;
    if (this._allOpen()) this._hold = null;
  }
  this._out(t, s);
};

FileStreamReader.prototype._allOpen = function () {
  var h = this._hold, self = this;
  return this._selected.every(function (id) {
    var t = self._trackById(id);
    return !t || t.type !== 'audio' || h.open[id];
  });
};

FileStreamReader.prototype._out = function (t, s) {
  this._ee.emit(t.type === 'video' ? 'video' : t.type === 'audio' ? 'audio' : 'other', {
    trackId: s.trackId,
    payload: s.payload,
    isKeyframe: !!s.isKeyframe,
    ptsUs: s.ptsUs,
    dtsUs: s.dtsUs != null ? s.dtsUs : s.ptsUs,
    durationUs: s.durationUs || 0,
  });
};

// The end of the file: what a seek still waits for, held audio, 'end'.
// false: a jump was made — go on.
FileStreamReader.prototype._atEnd = function () {
  if (!this._infoSent) this._sendInfo();
  if (this._jumped) { this._jumped = false; return false; }
  var sc = this._scan;
  if (sc) {
    if (sc.probe) {
      // A guess with no sync point after it: the time is before it.
      sc.probe.hi = { pos: sc.probe.at, ptsUs: sc.probe.hi.ptsUs };
      this._bisect();
    } else {
      this._resolveScan(null);
    }
    this._jumped = false;
    return false;
  }
  var h = this._hold;
  if (h) {
    this._hold = null;
    for (var id in h.held) this._out(this._trackById(h.held[id].trackId), h.held[id]);
  }
  this._ended = true;
  this._ee.emit('end');
  return true;
};

// ── info / select ──

FileStreamReader.prototype._sendInfo = function () {
  if (this._infoSent) return;
  var fmt = this._fmt, early = this._early;
  var vStart = null, aStart = null;
  fmt.tracks.forEach(function (t) {
    var mine = early.filter(function (s) { return s.trackId === t.id; });
    var min = null;
    mine.forEach(function (s) { if (min === null || s.ptsUs < min) min = s.ptsUs; });
    if (t.startUs == null) t.startUs = min !== null ? min : 0;
    if (t.type === 'video') {
      if (fmt.estimateVideoDuration && !t.frameDurUs) {
        var ps = mine.map(function (s) { return s.ptsUs; }).sort(function (a, b) { return a - b; });
        var d = 0;
        for (var i = 1; i < ps.length; i++) { var x = ps[i] - ps[i - 1]; if (x > 0 && (!d || x < d)) d = x; }
        t.frameDurUs = d;
        t.estimate = true;
      }
      if (!t.frameRate && t.frameDurUs) t.frameRate = Math.round(1e8 / t.frameDurUs) / 100;
      if (min !== null && vStart === null) vStart = t.startUs;
    }
    if (t.type === 'audio' && min !== null && aStart === null) aStart = t.startUs;
  });
  var info = this._info = {
    container: fmt.container, brand: '', compatibleBrands: [], quicktime: false, fragmented: false,
    durationUs: fmt.durationUs || 0,
    startUs: fmt.startUs != null ? fmt.startUs : vStart !== null ? vStart : aStart !== null ? aStart : 0,
    tracks: fmt.tracks.map(_public),
  };
  this._infoSent = true;
  if (!this._selected) this.select(null);
  this._early = [];
  this._earlyBytes = 0;
  this._ee.emit('info', info);
  if (this._jumped) return;           // a seek from the listener: what was read is before it
  for (var i = 0; i < early.length && !this._jumped && !this._ended && !this._failed; i++) this._deliver(early[i]);
};

// The track as reader_mp4 shows it (internal fields left out).
function _public(t) {
  var p = {};
  for (var k in t) if (k !== 'estimate' && k !== 'frameDurUs') p[k] = t[k];
  return p;
}

/** Which tracks' samples are emitted (default: the first video and audio track with a codec). */
FileStreamReader.prototype.select = function (ids) {
  var ts = this._fmt.tracks;
  if (ids) {
    this._selected = ts.filter(function (t) { return ids.indexOf(t.id) !== -1; }).map(function (t) { return t.id; });
  } else {
    var v = null, a = null;
    ts.forEach(function (t) {
      if (!v && t.type === 'video' && t.codec) v = t;
      if (!a && t.type === 'audio' && t.codec) a = t;
    });
    this._selected = [v, a].filter(Boolean).map(function (t) { return t.id; });
  }
  if (this._infoSent) this._process();
};

/** 0..1 — how far into the file reading is. */
FileStreamReader.prototype.progress = function () {
  if (!this._size) return 0;
  return Math.max(0, Math.min(1, this._pos / this._size));
};

// ── seek ──

// The track a seek is about: the first selected video track, else audio.
FileStreamReader.prototype._seekTrack = function () {
  var self = this, v = null, a = null;
  (this._selected || []).forEach(function (id) {
    var t = self._trackById(id);
    if (!t) return;
    if (!v && t.type === 'video') v = t;
    if (!a && t.type === 'audio') a = t;
  });
  return v || a;
};

FileStreamReader.prototype.seek = function (timeUs) {
  if (!this._infoSent) throw new Error(this._fmt.name + ': seek() after info');
  var tr = this._seekTrack();
  this._gate = null;
  this._hold = null;
  this._scan = null;
  this._ended = false;
  if (!tr) return;
  var video = tr.type === 'video';
  var idx = this._idx[tr.id] || [];
  var i = _search(idx, timeUs);
  var best = i > 0 ? idx[i - 1] : null, next = i < idx.length ? idx[i] : null;
  // 1. The keyframes around the time are known.
  if (best && next && next.run === best.run && next.seq === best.seq + 1) {
    return this._jumpTo(best, timeUs, video, tr);
  }
  // 2. The format's own index: a frame (a keyframe) at / before the time.
  var loc = this._fmt.locate ? this._fmt.locate(timeUs) : null;
  // (A guess — a VBR MP3's TOC — only when reading there exactly would be long.)
  if (loc && loc.estimated && loc.pos - (best ? best.pos : this._fmt.dataStart) < ESTIMATE_MIN) loc = null;
  if (loc && (!best || loc.ptsUs > best.ptsUs)) {
    this._startScan(loc, timeUs, video, tr);
    return this._kick();
  }
  var from = best || { pos: this._fmt.dataStart, ptsUs: -Infinity, state: null };
  // 3. Bisect, when the frames say their time wherever reading starts.
  if (this._fmt.resync) {
    var hi = next ? { pos: next.pos, ptsUs: next.ptsUs } : null;
    if (!hi && this._size && this._info.durationUs) hi = { pos: this._size, ptsUs: this._info.startUs + this._info.durationUs };
    var lo = { pos: from.pos, ptsUs: from.ptsUs === -Infinity ? this._info.startUs : from.ptsUs };
    // (where the time should be, at the average rate: close to `from`, just read on)
    var guess = hi && hi.ptsUs > lo.ptsUs ? lo.pos + (timeUs - PREROLL_US - lo.ptsUs) * (hi.pos - lo.pos) / (hi.ptsUs - lo.ptsUs) : 0;
    if (hi && guess - lo.pos > BISECT_MIN && timeUs < hi.ptsUs) {
      this._scan = { t: timeUs, track: tr.id, video: video, probe: { lo: lo, hi: hi, steps: 0, at: -1, from: from } };
      this._bisect();
      return this._kick();
    }
  }
  // 4. Read on from there.
  this._startScan(from, timeUs, video, tr);
  this._kick();
};

FileStreamReader.prototype._kick = function () {
  if (!this._busy) this._process();
};

// Read from an exact point `from`, without emitting, to the keyframe
// after the time (audio only: emit from the frame playing at it).
FileStreamReader.prototype._startScan = function (from, t, video, tr) {
  if (!video) {
    this._goto(from.pos, from.state);
    this._hold = { t: t, held: {}, open: {} };
    return;
  }
  this._scan = { t: t, track: tr.id, video: true, probe: null };
  this._goto(from.pos, from.state);
};

FileStreamReader.prototype._goto = function (pos, state) {
  this._pos = pos;
  this._run++;
  this._seq = {};
  this._lastIdx = {};
  this._flushedAt = -1;
  this._askedAt = -1;
  this._fmt.reset(pos, state);
  this._jumped = true;
  this._want(pos, true);
};

FileStreamReader.prototype._jumpTo = function (e, t, video, tr) {
  this._scan = null;
  if (video) this._gate = { from: e.ptsUs, key: false, track: tr.id };
  else this._hold = { t: t, held: {}, open: {} };
  this._goto(e.pos, e.state);
  this._kick();
};

// A sample while seeking: nothing goes out; is it where the time is?
FileStreamReader.prototype._scanSample = function (s) {
  var sc = this._scan;
  if (s.trackId !== sc.track) return true;
  var t = this._trackById(s.trackId);
  if (t.type === 'video' && !s.isKeyframe) return true;
  if (sc.probe) {
    var p = sc.probe;
    if (s.ptsUs > sc.t) {
      p.hi = { pos: p.at, ptsUs: s.ptsUs };
      this._bisect();
      return false;
    }
    // At / before the time: read on from here.
    var here = { pos: s.pos, ptsUs: s.ptsUs, state: s.state || null };
    if (!sc.video) {
      this._scan = null;
      this._hold = { t: sc.t, held: {}, open: {} };
      this._deliver(s);
      return !this._jumped;
    }
    sc.probe = null;
    sc.lastKey = here;
    return true;
  }
  if (s.ptsUs > sc.t) {
    this._resolveScan(s);
    return false;
  }
  return true;
};

// The keyframe after the time was found (or the end): from the last one
// at / before it.
FileStreamReader.prototype._resolveScan = function (after) {
  var sc = this._scan, idx = this._idx[sc.track] || [];
  var i = _search(idx, sc.t);
  var best = i > 0 ? idx[i - 1] : (idx.length ? idx[0] : null);
  if (!best) { this._scan = null; return this._goto(this._fmt.dataStart, null); }
  this._jumpTo(best, sc.t, true, this._trackById(sc.track));
};

// Next bisection guess (or, close enough, read on from the low end).
FileStreamReader.prototype._bisect = function () {
  var sc = this._scan, p = sc.probe, lo = p.lo, hi = p.hi;
  p.steps++;
  var span = hi.pos - lo.pos;
  if (span <= BISECT_MIN || p.steps > BISECT_STEPS || hi.ptsUs <= lo.ptsUs) {
    // Close enough (or no better guess): read on from the low end.
    var tr = this._trackById(sc.track);
    this._scan = null;
    return this._startScan(p.from, sc.t, sc.video, tr);
  }
  var rate = span / (hi.ptsUs - lo.ptsUs);
  var at = lo.pos + (sc.t - PREROLL_US - lo.ptsUs) * rate;
  at = Math.max(lo.pos, Math.min(hi.pos - BISECT_MIN / 2, at));
  if (at - lo.pos < BISECT_MIN / 4) at = lo.pos + span / 2;
  at = Math.floor(at);
  p.at = at;
  this._goto(at, null);
};

// The first entry with ptsUs > t.
function _search(list, t) {
  var a = 0, b = list.length;
  while (a < b) { var m = (a + b) >> 1; if (list[m].ptsUs <= t) a = m + 1; else b = m; }
  return a;
}

export default FileStreamReader;
