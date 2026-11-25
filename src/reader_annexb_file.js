/**
 * reader_annexb_file — a raw H.264 / H.265 Annex-B byte stream file
 * (.h264 / .264 / .h265 / .hevc): a FILE fed in pieces → its access units.
 * The API and events are reader_mp4's (see reader_file_stream.js).
 *
 * Access units are cut where the standards say one begins (H.264
 * §7.4.1.2.3, H.265 §7.4.2.4.4): at an AUD, parameter set, (prefix) SEI,
 * … or the first slice of the next picture, once the current one has a
 * picture — no AUD needed (reader_annexb, the encoder path's, cuts only at
 * AUDs, which libx264 / libx265 write only with aud=1 and most other
 * encoders never).
 *
 * The file has no timestamps. Frames are FPS apart (opts.fps, default 25
 * — FFmpeg's raw H.264 / H.265 demuxer default; the SPS timing info is
 * not used, as there). Presentation order is each picture's POC (H.264
 * §8.2.1 types 0 / 1 / 2, H.265 §8.3.1): a picture is shown
 * (POC − the POC of the IDR / BLA it follows) / the POC step later than
 * that IDR, the step being the smallest POC difference of the first
 * frames (2 for x264, 1 for x265). The first picture is at 0; DTS is
 * decode order, shifted back by the largest reorder of the first frames
 * (dts ≤ pts) — what an MP4 of the same stream says.
 *
 * WebCodecs: length-prefixed samples (parameter sets and AUDs dropped:
 * annexbToAvccSample), the avcC / hvcC built from the first parameter
 * sets as the description, 'avc1.*' / 'hvc1.*', the size from the SPS.
 * Keyframes: H.264 IDR, H.265 IRAP (what reader_ts says).
 * opts.codec: 'h264' | 'h265' (default: from the first NAL unit's header).
 *
 * Not handled: H.264 memory_management_control_operation 5 (a POC reset
 * without an IDR), field pictures (each field is an access unit),
 * nuh_layer_id > 0 layers (part of the access unit they follow).
 *
 * seek(): times are counted from the start, so it reads (without
 * emitting) from the last indexed keyframe before the time — or the start
 * — to the keyframe after it, then asks for the one at / before it. Exact.
 */

import FileStreamReader from './reader_file_stream.js';
import {
  annexbToAvccSample, buildAvcCFromAnnexB, buildHvcCFromAnnexB, codecStringFromAvcC, codecStringFromHvcC,
} from './utils/nalu_utils.js';
import {
  parseH264Sps, parseH264Pps, parseH264Slice, parseH265Sps, parseH265Pps, parseH265Slice,
  h264Poc, h265Poc, newPocState, copyPocState, startsAccessUnit, isVcl, isEndOfSequence, endOfSequence,
} from './utils/h26x_parse.js';

var WINDOW = 16;           // frames read before the POC step and the reorder delay are fixed
var DEFAULT_FPS = 25;

/** 'h264' | 'h265' | null from the first NAL unit header after a start code at b[0..]. */
export function sniffAnnexB(b) {
  var i = 0;
  while (i < b.length && b[i] === 0) i++;
  if (i < 2 || b[i] !== 1 || i + 3 > b.length) return null;
  var n0 = b[i + 1], n1 = b[i + 2];
  if (n0 & 0x80) return null;                                // forbidden_zero_bit
  var t5 = (n0 >> 1) & 0x3F, tid = n1 & 7, layer = ((n0 & 1) << 5) | (n1 >> 3);
  if (!layer && tid >= 1 && (t5 === 32 || t5 === 33 || t5 === 34 || t5 === 35 || t5 === 39 || (t5 >= 16 && t5 <= 21))) return 'h265';
  var t = n0 & 0x1F, ref = n0 >> 5;
  if (t === 7 || t === 8 || t === 5) return ref ? 'h264' : null;
  if (t === 9 || t === 6) return ref === 0 ? 'h264' : null;
  if (t === 1) return 'h264';
  return null;
}

function AnnexbFormat(opts) {
  this.name = 'AnnexBReader';
  this.container = 'annexb';
  this.tracks = [];
  this.resync = false;
  this.dataStart = 0;
  this.durationUs = 0;
  this._fps = opts.fps || DEFAULT_FPS;
  this._codec = opts.codec || null;
  this._h265 = this._codec === 'h265';
  this._sps = {};
  this._pps = {};
  this._step = 0;            // POC units per frame (0: not known yet)
  this._delay = -1;          // reorder frames (DTS shift)
  this._q = [];              // access units waiting for the step / delay
  this._out = [];            // samples not taken yet (emit() said stop)
  this._start();
}

AnnexbFormat.prototype._start = function () {
  this._p = this.dataStart;  // where to look for the next start code
  this._nal = -1;            // payload start of the NAL unit whose end isn't found yet
  this._nalSc = -1;          // where its start code (zeros included) begins
  this._au = null;           // { start, vcl, key, slice, params }
  this._dec = 0;             // decode index of the next access unit
  this._poc = newPocState();
  this._firstPic = true;
  this._pocRef = 0;          // POC of the current period's first picture (decode side)
  this._periodDec0 = 0;
  this._periodBase = 0;      // presentation side: the current period's first index …
  this._tPocRef = 0;         // … its POC
  this._maxPres = -1;
  this._tFirst = true;
};

AnnexbFormat.prototype.ready = function () { return !!this.tracks.length && !!this.tracks[0].config && this._step > 0; };

AnnexbFormat.prototype.parse = function (win, pos, eof, emit) {
  while (this._out.length) if (!emit(this._out.shift())) return this._keep(pos);
  if (!this._codec) {
    if (!win.has(pos, 8)) { if (eof) throw _err('NOT_ANNEXB', 'no NAL units'); return pos; }
    this._codec = sniffAnnexB(win.view(pos, Math.min(64, win.end() - pos)));
    if (!this._codec) throw _err('NOT_ANNEXB', 'not an H.264 / H.265 byte stream');
    this._h265 = this._codec === 'h265';
  }
  if (!this.tracks.length) this._setup();
  if (this._p < pos) this._p = pos;
  var v = win.view(win.off, win.end() - win.off), base = win.off;
  var i = this._p - base, n = v.length;
  while (true) {
    // the next 00 00 01
    var q = -1;
    for (; i + 3 <= n; i++) {
      if (v[i + 2] > 1) { i += 2; continue; }
      if (v[i] === 0 && v[i + 1] === 0 && v[i + 2] === 1) { q = i; break; }
    }
    if (q < 0) {
      if (!eof) { this._p = base + Math.max(i, 0); return this._keep(pos); }
      if (this._nal >= 0) {
        var e = n;
        while (e > this._nal - base && v[e - 1] === 0) e--;
        this._nalDone(v, base, this._nal, e);
        this._nal = -1;
      }
      this._closeAu(v, base, n);
      this._flushQ(true);
      while (this._out.length) if (!emit(this._out.shift())) return this._keep(pos);
      return Infinity;
    }
    if (this._nal >= 0) {
      var pe = q;
      while (pe > this._nal - base && v[pe - 1] === 0) pe--;
      this._nalDone(v, base, this._nal, pe);
    }
    // the next NAL unit's start code begins after the last one's payload
    var sc = q;
    while (sc > 0 && v[sc - 1] === 0 && (this._nal < 0 || sc - 1 >= this._nalEnd - base)) sc--;
    this._nalSc = base + sc;
    this._nal = base + q + 3;
    i = q + 3;
    this._p = base + i;
    while (this._out.length) if (!emit(this._out.shift())) return this._keep(pos);
  }
};

// Where reading must restart from to get what isn't out yet.
AnnexbFormat.prototype._keep = function (pos) {
  var k = this._au ? this._au.start : this._nalSc >= 0 ? this._nalSc : this._p;
  for (var j = 0; j < this._q.length; j++) k = Math.min(k, this._q[j].start);
  return Math.max(pos, Math.min(k, this._p));
};

// A whole NAL unit [ps, pe) (window-relative): to the access unit it belongs to.
AnnexbFormat.prototype._nalDone = function (v, base, psAbs, pe) {
  var ps = psAbs - base, nal = v.subarray(ps, pe), h265 = this._h265;
  this._nalEnd = base + pe;
  if (!nal.length) return;
  if (this._au && this._au.vcl && startsAccessUnit(nal, h265)) this._closeAu(v, base, this._nalSc - base, false);
  if (!this._au) this._au = { start: this._nalSc, vcl: false, key: false, slice: null, params: false };
  var au = this._au, t = h265 ? (nal[0] >> 1) & 0x3F : nal[0] & 0x1F;
  if (!h265) {
    if (t === 7) { var s = parseH264Sps(nal); if (s) this._sps[s.id] = s; au.params = true; }
    else if (t === 8) { var p = parseH264Pps(nal); if (p) this._pps[p.id] = p; }
  } else {
    if (t === 33) { var s5 = parseH265Sps(nal); if (s5) this._sps[s5.id] = s5; au.params = true; }
    else if (t === 34) { var p5 = parseH265Pps(nal); if (p5) this._pps[p5.id] = p5; }
  }
  // (the picture after it starts a new sequence: applied once this
  // access unit, the one it ends, has its POC)
  if (isEndOfSequence(nal, h265)) au.eos = true;
  if (isVcl(nal, h265)) {
    if (!au.vcl) {
      au.slice = h265 ? parseH265Slice(nal, this._sps, this._pps) : parseH264Slice(nal, this._sps, this._pps);
      au.nalType = t;
    }
    au.vcl = true;
    if (h265 ? t >= 16 && t <= 23 : t === 5) au.key = true;
  }
};

// The access unit is complete (it ends at `end`, window-relative): its POC.
AnnexbFormat.prototype._closeAu = function (v, base, end) {
  var au = this._au;
  this._au = null;
  if (!au || !au.vcl) return;
  var bytes = v.subarray(au.start - base, end), h265 = this._h265;
  if (!this.tracks[0].config && au.params) this._config(bytes);
  au.pocState = copyPocState(this._poc);
  au.firstPic = this._firstPic;
  au.dec = this._dec++;
  var poc = null, reset = false, sl = au.slice;
  if (sl && sl.sps) {
    if (h265) { var r = h265Poc(sl, this._poc); poc = r.poc; reset = r.reset; }
    else { poc = h264Poc(sl, this._poc); reset = sl.idr; }
  }
  // (no slice header to read: decode order)
  if (poc === null) poc = (au.dec - this._periodDec0) * (this._step || (h265 ? 1 : 2)) + this._pocRef;
  if (au.eos) endOfSequence(this._poc);
  au.newPeriod = reset || this._firstPic;
  if (au.newPeriod) { this._pocRef = poc; this._periodDec0 = au.dec; this._firstPic = false; }
  au.poc = poc;
  au.pocRef = this._pocRef;
  au.bytes = bytes.slice();
  this._q.push(au);
  if (!this._step && this._q.length >= WINDOW) this._fix();
  if (this._step) this._flushQ(false);
};

// The POC step and the reorder delay, from the first access units.
AnnexbFormat.prototype._fix = function () {
  var g = 0, q = this._q;
  for (var i = 0; i < q.length; i++) {
    var d = Math.abs(q[i].poc - q[i].pocRef);
    if (d) g = _gcd(g, d);
  }
  this._step = g || (this._h265 ? 1 : 2);
  var delay = 0, keep = { periodBase: this._periodBase, tPocRef: this._tPocRef, maxPres: this._maxPres, tFirst: this._tFirst };
  for (var j = 0; j < q.length; j++) {
    this._time(q[j]);
    delay = Math.max(delay, q[j].dec - q[j].pres);
  }
  // (timed again as they go out)
  this._periodBase = keep.periodBase; this._tPocRef = keep.tPocRef; this._maxPres = keep.maxPres; this._tFirst = keep.tFirst;
  for (var k = 0; k < q.length; k++) delete q[k].pres;
  this._delay = delay;
};

// Presentation index, in decode order: a new POC period (IDR / BLA)
// starts right after everything shown before it.
AnnexbFormat.prototype._time = function (au) {
  au.state = {
    dec: au.dec, poc: au.pocState, firstPic: au.firstPic,
    periodBase: this._periodBase, tPocRef: this._tPocRef, maxPres: this._maxPres, tFirst: this._tFirst,
    pocRef: au.newPeriod ? au.poc : au.pocRef, periodDec0: this._periodDec0,
  };
  if (au.newPeriod) {
    this._periodBase = this._tFirst ? 0 : this._maxPres + 1;
    this._tPocRef = au.poc;
    this._tFirst = false;
  }
  au.pres = this._periodBase + Math.round((au.poc - this._tPocRef) / this._step);
  if (au.pres > this._maxPres) this._maxPres = au.pres;
};

// Access units with their times known: out as samples.
AnnexbFormat.prototype._flushQ = function (end) {
  if (!this._step) { if (!end || !this._q.length) return; this._fix(); }
  var fps = this._fps, h265 = this._h265;
  while (this._q.length) {
    var au = this._q.shift();
    if (au.pres === undefined) this._time(au);
    var pts = Math.round(au.pres * 1e6 / fps);
    this._out.push({
      trackId: 1, payload: annexbToAvccSample(au.bytes, h265), isKeyframe: au.key,
      ptsUs: pts, dtsUs: Math.round((au.dec - this._delay) * 1e6 / fps),
      durationUs: Math.round((au.pres + 1) * 1e6 / fps) - pts, pos: au.start, state: au.state,
    });
  }
};

AnnexbFormat.prototype._config = function (bytes) {
  var h265 = this._h265, rec = h265 ? buildHvcCFromAnnexB(bytes) : buildAvcCFromAnnexB(bytes);
  if (!rec) return;
  var codec = h265 ? codecStringFromHvcC(rec, 'hvc1') : codecStringFromAvcC(rec, 'avc1');
  if (!codec) return;
  var t = this.tracks[0], sps = null;
  for (var k in this._sps) { sps = this._sps[k]; break; }
  if (sps) { t.codedWidth = t.displayWidth = sps.width; t.codedHeight = t.displayHeight = sps.height; }
  t.codec = codec;
  t.description = rec;
  t.config = { codec: codec, codedWidth: t.codedWidth, codedHeight: t.codedHeight, description: rec };
};

AnnexbFormat.prototype._setup = function () {
  this.tracks = [{
    id: 1, type: 'video', handler: 'annexb', entry: this._codec, codec: null, description: null,
    timescale: this._fps, durationUs: 0, sampleCount: null, bitrate: null, startUs: 0,
    codedWidth: 0, codedHeight: 0, displayWidth: 0, displayHeight: 0, rotation: 0, flip: false, colorSpace: null,
    frameRate: this._fps, frameDurUs: Math.round(1e6 / this._fps), config: null,
  }];
};

AnnexbFormat.prototype.reset = function (pos, state) {
  this._start();
  this._q = [];
  this._out = [];
  this._p = pos;
  if (state) {
    this._dec = state.dec;
    this._poc = copyPocState(state.poc);
    this._firstPic = state.firstPic;
    this._pocRef = state.pocRef;
    this._periodDec0 = state.periodDec0;
    this._periodBase = state.periodBase;
    this._tPocRef = state.tPocRef;
    this._maxPres = state.maxPres;
    this._tFirst = state.tFirst;
  }
};

function _gcd(a, b) { while (b) { var t = a % b; a = b; b = t; } return a; }

function _err(code, msg) { var e = new Error(msg); e.code = code; return e; }

function AnnexBFileReader(opts) { FileStreamReader.call(this, new AnnexbFormat(opts || {}), opts); }
AnnexBFileReader.prototype = Object.create(FileStreamReader.prototype);
AnnexBFileReader.prototype.constructor = AnnexBFileReader;

export default AnnexBFileReader;
