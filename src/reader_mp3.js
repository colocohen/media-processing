/**
 * reader_mp3 — MPEG audio files (MP3; also layer I / II): a FILE fed in
 * pieces → its frames. The API and events are reader_mp4's (see
 * reader_file_stream.js). MPEG-1, MPEG-2 and MPEG-2.5, layers I, II and
 * III, CBR and VBR; free-format streams (bitrate_index 0) are not read.
 *
 * Tags: ID3v2 at the start (several in a row too) are skipped; at the end
 * ID3v1 ('TAG'), APEv2 and Lyrics3 are not frames and end the stream —
 * reading stops at the last frame (a frame is a valid header whose fixed
 * fields match the first frame's: FFmpeg's MP3_MASK).
 * The first frame is where two consecutive frames are found (within 64
 * KB, as FFmpeg's mp3 demuxer looks).
 *
 * A Xing / Info / VBRI header (in a layer III first frame) is not a frame
 * of audio: it's skipped, and gives
 *   - the duration: frames × samples per frame, minus the LAME tag's
 *     encoder delay and padding — what FFmpeg reports (without one: the
 *     file size over the first 32 frames' average size);
 *   - gapless playback, as FFmpeg applies a LAME (or Lavf / Lavc) tag:
 *     the first frame is at 0 and the audio starts after skipSamples =
 *     delay + 529 (the decoder's own delay): info.startUs (FFmpeg's
 *     start_time); the last discardSamples = padding − 529 of the decoded
 *     audio aren't part of it. The track carries both, and
 *     encoderDelay / encoderPadding as the tag has them. Frames keep
 *     their whole durations (as FFmpeg's packets do).
 *   - the TOC (seek).
 * Timestamps: frame n at n × samples per frame / sample rate — the
 * frames are counted from the first one.
 *
 * WebCodecs: 'mp3' (layer III, no description). Layer I / II have no
 * WebCodecs registration: their track has codec null (entry 'mp1' /
 * 'mp2').
 *
 * seek(): from the frame playing at the time.
 *   - CBR (an 'Info' tag, or no VBR header and one bitrate so far — the
 *     first frames of a VBR file without a header may all be one): the
 *     frame's position is computed — the average frame is exactly
 *     samples × kbit/s × 125 / rate bytes, so a frame's number is its
 *     offset / that, rounded. Exact.
 *   - VBR with a Xing TOC: the TOC's position for the time (1 % steps of
 *     the duration), and the frames from there are timed from the TOC's
 *     time — an estimate, like FFmpeg with -usetoc 1: off by what the
 *     TOC is (it's 1/256 of the file per step); not indexed. A time
 *     already read past is found exactly in the index instead.
 *   - VBR without a TOC: read (not emitted) from the last indexed frame
 *     before the time — exact.
 */

import FileStreamReader from './reader_file_stream.js';
import { parseMpaHeader, sameStream, parseVbrHeader, id3v2Size } from './utils/mpeg_audio.js';

var FIRST_SEARCH = 64 * 1024;
var DECODER_DELAY = 529;      // what FFmpeg adds to the LAME delay (528 + 1)
var PROBE_FRAMES = 32;

function Mp3Format() {
  this.name = 'MP3Reader';
  this.container = 'mp3';
  this.tracks = [];
  this.resync = false;
  this.dataStart = 0;
  this.durationUs = 0;
  this.startUs = 0;
  this._st = 0;
  this._h0 = null;
  this._vbr = null;
  this._n = 0;                // the number of the next frame
  this._findN = false;        // after a jump to a CBR offset: the next frame's number from its position
  this._estimated = false;
  this._cbr = true;
  this._probed = 0;
  this._probeBytes = 0;
}

// (Without a frame count, the duration is estimated from the first
// PROBE_FRAMES frames' average size — what's in 'info'.)
Mp3Format.prototype.ready = function () {
  return this._st === 1 && (!!(this._vbr && this._vbr.frames) || this._probed >= PROBE_FRAMES || !this.fileSize);
};

Mp3Format.prototype.parse = function (win, pos, eof, emit) {
  if (this._st !== 1) {
    var p = this._head(win, pos, eof);
    if (this._st !== 1) return p;
    pos = p;
  }
  var h0 = this._h0;
  while (true) {
    if (!win.has(pos, 4)) return eof ? Infinity : pos;
    var h = parseMpaHeader(win.peek(pos, 4), 0);
    if (!h || !sameStream(h, h0)) {
      var q = this._resync(win, pos + 1, eof);
      if (q === -1) return eof ? Infinity : Math.max(pos, win.end() - 3);
      if (q === -2) return pos;
      pos = q;
      continue;
    }
    if (!win.has(pos, h.frameLength)) {
      // The file ends inside this frame: what's there goes out (as
      // FFmpeg's parser does with a cut-off last frame).
      if (!eof) return pos;
      if (win.end() - pos <= 4) return Infinity;
    }
    var len = Math.min(h.frameLength, win.end() - pos);
    if (h.bitrate !== h0.bitrate && !this._vbr) this._cbr = this.resync = false;
    if (this._probed < PROBE_FRAMES && !this._estimated) this._probe(len);
    if (this._findN) { this._findN = false; this._n = Math.round((pos - this.dataStart) / this._avg); }
    var spf = h.samplesPerFrame, n = this._n++;
    var pts = Math.round(n * spf * 1e6 / h.sampleRate);
    var go = emit({
      trackId: 1, payload: win.view(pos, len), isKeyframe: true,
      ptsUs: pts, dtsUs: pts, durationUs: Math.round((n + 1) * spf * 1e6 / h.sampleRate) - pts,
      pos: pos, state: { n: n }, estimated: this._estimated,
    });
    pos += len;
    if (!go) return pos;
  }
};

// The start: ID3v2 tags, then a VBR header frame (read where it is, as
// FFmpeg does — its fixed fields may differ from the audio frames'), then
// the first frame: two in a row (within FIRST_SEARCH).
Mp3Format.prototype._head = function (win, pos, eof) {
  if (this._st === 0) {
    if (!win.has(pos, 10) && !eof) return pos;
    var id3 = id3v2Size(win.peek(pos, 10), 0);
    if (id3) return pos + id3;
    var hv = parseMpaHeader(win.peek(pos, 4), 0);
    if (hv) {
      if (!win.has(pos, hv.frameLength) && !eof) return pos;
      var vbr = parseVbrHeader(win.peek(pos, hv.frameLength), hv);
      if (vbr && (vbr.frames || vbr.bytes)) { this._vbr = vbr; pos += hv.frameLength; }
    }
    this._st = 2;
  }
  var p = this._resync(win, pos, eof, FIRST_SEARCH);
  if (p === -2) return pos;                               // waiting for bytes
  if (p < 0) throw _err('NO_FRAMES', 'no MPEG audio frames');
  this._h0 = parseMpaHeader(win.peek(p, 4), 0);
  this.dataStart = p;
  this._setup();
  this._st = 1;
  return p;
};

/**
 * The next frame at / after `from`: a valid header of this stream (the
 * first one: any) followed by another (or by the end of the file).
 * -1: none in what's here, -2: can't tell yet (the first frame only).
 */
Mp3Format.prototype._resync = function (win, from, eof, limit) {
  var end = win.end(), first = !this._h0;
  var stop = limit ? Math.min(end, from + limit) : end;
  for (var p = from; p + 4 <= stop; p++) {
    if (win.peek(p, 1)[0] !== 0xFF) continue;
    var h = parseMpaHeader(win.peek(p, 4), 0);
    if (!h || (!first && !sameStream(h, this._h0))) continue;
    var q = p + h.frameLength;
    if (q + 4 > end) return eof ? p : -2;
    var h2 = parseMpaHeader(win.peek(q, 4), 0);
    if (h2 && sameStream(h, h2)) return p;
  }
  return !eof && (!limit || stop - from < limit) ? -2 : -1;
};

Mp3Format.prototype._setup = function () {
  var h = this._h0, v = this._vbr, sr = h.sampleRate, spf = h.samplesPerFrame;
  this._avg = spf * h.bitrate * 125 / sr;
  this._cbr = !v || v.kind === 'Info';
  this.resync = this._cbr;
  var delay = v ? v.delay : 0, padding = v ? v.padding : 0, gapless = !!(v && (delay || padding || /^(LAME|Lav)/.test(v.encoder)));
  var skip = gapless ? delay + DECODER_DELAY : 0;
  this.startUs = Math.round(skip * 1e6 / sr);
  if (v && v.frames) this.durationUs = Math.round((v.frames * spf - delay - padding) * 1e6 / sr);
  else if (this.fileSize > this.dataStart) this.durationUs = Math.round((this.fileSize - this.dataStart) * 8000 / h.bitrate);
  var codec = h.layer === 3 ? 'mp3' : null;
  var t = {
    id: 1, type: 'audio', handler: 'mpeg-audio', entry: 'mp' + h.layer, codec: codec, description: null,
    timescale: sr, durationUs: this.durationUs, sampleCount: v && v.frames ? v.frames : null,
    bitrate: v && v.frames && v.bytes ? Math.round(v.bytes * 8 * sr / (v.frames * spf)) : h.bitrate * 1000,
    startUs: this.startUs, sampleRate: sr, numberOfChannels: h.channels, config: null,
    encoderDelay: delay, encoderPadding: padding,
    skipSamples: skip, discardSamples: gapless ? Math.max(0, padding - DECODER_DELAY) : 0,
  };
  if (codec) t.config = { codec: codec, sampleRate: sr, numberOfChannels: h.channels };
  this.tracks = [t];
};

// The duration from the file size and the average frame so far (no Xing count).
Mp3Format.prototype._probe = function (len) {
  this._probed++;
  this._probeBytes += len;
  if (this._vbr && this._vbr.frames) return;
  var end = this.fileSize, spf = this._h0.samplesPerFrame;
  if (end <= this.dataStart) return;
  var frames = (end - this.dataStart) * this._probed / this._probeBytes;
  this.durationUs = this.tracks[0].durationUs = Math.round(frames * spf * 1e6 / this._h0.sampleRate);
};

Mp3Format.prototype.reset = function (pos, state) {
  this._estimated = false;
  this._findN = false;
  if (state && state.n != null) {
    this._n = state.n;
    this._estimated = !!state.estimated;
  } else if (pos === this.dataStart) {
    this._n = 0;
  } else {
    this._findN = true;      // a CBR offset: numbered from where the next frame is
  }
};

Mp3Format.prototype.locate = function (timeUs) {
  if (this._st !== 1) return null;
  var h = this._h0, spf = h.samplesPerFrame, sr = h.sampleRate, v = this._vbr;
  var n = Math.max(0, Math.floor(timeUs * sr / (spf * 1e6)));
  if (this._cbr) {
    // A frame or two early: reading finds the next frame and numbers it.
    var pos = this.dataStart + Math.max(0, Math.floor((n - 1) * this._avg) - 4);
    return { pos: pos, ptsUs: Math.round(Math.max(0, n - 1) * spf * 1e6 / sr), state: null };
  }
  if (v && v.toc && v.frames) {
    var total = v.frames * spf * 1e6 / sr;
    var i = Math.max(0, Math.min(99, Math.floor(timeUs * 100 / total)));
    var bytes = v.bytes || (this.fileSize ? this.fileSize - this.dataStart : 0);
    if (!bytes) return null;
    var n0 = Math.round(i * v.frames / 100);
    var tp = this.dataStart + Math.floor(v.toc[i] * bytes / 256);
    return { pos: tp, ptsUs: Math.round(n0 * spf * 1e6 / sr), state: { n: n0, estimated: true }, estimated: true };
  }
  return null;
};

function _err(code, msg) { var e = new Error(msg); e.code = code; return e; }

function MP3Reader(opts) { FileStreamReader.call(this, new Mp3Format(), opts); }
MP3Reader.prototype = Object.create(FileStreamReader.prototype);
MP3Reader.prototype.constructor = MP3Reader;

export default MP3Reader;
