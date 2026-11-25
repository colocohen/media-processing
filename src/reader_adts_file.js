/**
 * reader_adts_file — an ADTS AAC file (.aac): a FILE fed in pieces → its
 * AAC frames, raw (the ADTS header off), with the AudioSpecificConfig
 * built from the first header (ISO/IEC 14496-3 §1.A.2: profile → object
 * type, sampling_frequency_index, channel_configuration) as the WebCodecs
 * description — 'mp4a.40.<object type>'. The API and events are
 * reader_mp4's (see reader_file_stream.js).
 *
 * An ID3v2 tag before the first frame is skipped; the first frame is
 * where two consecutive ADTS headers are (within 64 KB); after it, a frame
 * is a header whose fixed part (ID, layer, profile, sampling frequency,
 * channel configuration) matches the first one's, frame_length at least
 * the header. Anything else is skipped to the next such header (ID3v1 /
 * APE tags at the end are not frames).
 *
 * Timestamps: ADTS has none — frames are counted from the first one, each
 * 1024 × (number_of_raw_data_blocks_in_frame + 1) samples at the header's
 * rate (as reader_adts does; for HE-AAC that is the core rate, which is
 * what such a frame's 1024 samples are at). info.durationUs is an
 * estimate from the file size and the first frames' average size (as
 * FFmpeg's).
 *
 * Not reader_adts itself: it takes any 0xFFF as a frame (an ID3 tag's
 * bytes too), and keeps no offsets — a file reader needs both. Its
 * header parsing (aac_utils) is shared.
 *
 * seek(): the frames are counted, so it reads (without emitting) from the
 * last indexed frame before the time, then emits from the one playing at
 * it. Exact.
 */

import FileStreamReader from './reader_file_stream.js';
import { parseAdtsHeader, adtsHeaderLength, stripAdts, audioSpecificConfigFromAdts, parseAudioSpecificConfig } from './utils/aac_utils.js';
import { id3v2Size } from './utils/mpeg_audio.js';

var FIRST_SEARCH = 64 * 1024;
var PROBE_FRAMES = 32;

function AdtsFormat() {
  this.name = 'ADTSReader';
  this.container = 'aac';
  this.tracks = [];
  this.resync = false;
  this.dataStart = 0;
  this.durationUs = 0;
  this._st = 0;
  this._fixed = 0;           // the first header's fixed bits
  this._S = 0;               // samples before the next frame (at _rate)
  this._baseUs = 0;          // time of sample 0 of the count (a rate change restarts it)
  this._rate = 0;
  this._frames = 0;
  this._bytes = 0;
}

AdtsFormat.prototype.ready = function () { return this._st === 1 && this._frames >= PROBE_FRAMES; };

// A header at b[o..]: the parsed fields, or null when it's no ADTS frame header.
function _hdr(b, o) {
  if (o + 9 > b.length && o + 7 > b.length) return null;
  var v = b.subarray(o, o + 9);
  if (!adtsHeaderLength(v)) return null;
  var h = parseAdtsHeader(v);
  if (!h || !h.sampleRate || h.frameLength < (h.protectionAbsent ? 7 : 9)) return null;
  h.fixed = ((v[1] << 16) | ((v[2] & 0xFD) << 8) | (v[3] & 0xC0)) >>> 0;
  return h;
}

AdtsFormat.prototype.parse = function (win, pos, eof, emit) {
  if (this._st === 0) {
    if (!win.has(pos, 10) && !eof) return pos;
    var id3 = id3v2Size(win.peek(pos, 10), 0);
    if (id3) return pos + id3;
    var p = this._find(win, pos, eof, FIRST_SEARCH);
    if (p === -2) return pos;
    if (p < 0) throw _err('NO_FRAMES', 'no ADTS frames');
    var v = win.peek(p, 9), h = _hdr(v, 0);
    this._fixed = h.fixed;
    this.dataStart = p;
    this._setup(win.peek(p, h.frameLength), h);
    this._st = 1;
    pos = p;
  }
  while (true) {
    if (!win.has(pos, 9)) {
      if (!eof || !win.has(pos, 7)) return eof ? Infinity : pos;
    }
    var b = win.peek(pos, 9), hd = _hdr(b, 0);
    if (!hd || hd.fixed !== this._fixed) {
      var q = this._find(win, pos + 1, eof);
      if (q === -1) return eof ? Infinity : Math.max(pos, win.end() - 8);
      if (q === -2) return pos;
      pos = q;
      continue;
    }
    if (!win.has(pos, hd.frameLength)) return eof ? Infinity : pos;   // a cut-off last frame isn't one
    if (hd.sampleRate !== this._rate) {
      // a rate change: the count restarts from here
      this._baseUs = this._rate ? this._baseUs + Math.round(this._S * 1e6 / this._rate) : 0;
      this._S = 0;
      this._rate = hd.sampleRate;
    }
    var state = { S: this._S, baseUs: this._baseUs, rate: this._rate };
    var pts = this._baseUs + Math.round(this._S * 1e6 / this._rate);
    this._S += hd.samplesPerFrame;
    var end = this._baseUs + Math.round(this._S * 1e6 / this._rate);
    var frame = win.view(pos, hd.frameLength);
    if (this._st === 1 && this._frames < PROBE_FRAMES) { this._frames++; this._bytes += hd.frameLength; this._estimate(); }
    var go = emit({
      trackId: 1, payload: stripAdts(frame), isKeyframe: true,
      ptsUs: pts, dtsUs: pts, durationUs: end - pts, pos: pos, state: state,
    });
    pos += hd.frameLength;
    if (!go) return pos;
  }
};

// The next frame header at / after `from` with another right after it
// (or the end). -1: none here; -2: can't tell yet.
AdtsFormat.prototype._find = function (win, from, eof, limit) {
  var end = win.end(), stop = limit ? Math.min(end, from + limit) : end;
  for (var p = from; p + 7 <= stop; p++) {
    var b = win.peek(p, 9);
    if (b[0] !== 0xFF) continue;
    var h = _hdr(b, 0);
    if (!h || (this._fixed && h.fixed !== this._fixed)) continue;
    var q = p + h.frameLength;
    if (q + 7 > end) return eof ? p : -2;
    var h2 = _hdr(win.peek(q, 9), 0);
    if (h2 && h2.fixed === h.fixed) return p;
  }
  return !eof && (!limit || stop - from < limit) ? -2 : -1;
};

AdtsFormat.prototype._setup = function (frame, h) {
  var asc = audioSpecificConfigFromAdts(frame), a = parseAudioSpecificConfig(asc);
  var codec = 'mp4a.40.' + (a ? a.objectType : 2);
  this._rate = h.sampleRate;
  this.tracks = [{
    id: 1, type: 'audio', handler: 'adts', entry: 'aac', codec: codec, description: asc,
    timescale: h.sampleRate, durationUs: 0, sampleCount: null, bitrate: null, startUs: 0,
    sampleRate: h.sampleRate, numberOfChannels: h.channels,
    config: { codec: codec, sampleRate: h.sampleRate, numberOfChannels: h.channels, description: asc },
  }];
};

// The duration from the file size and the frames read so far.
AdtsFormat.prototype._estimate = function () {
  if (!this.fileSize || !this._frames) return;
  var frames = (this.fileSize - this.dataStart) * this._frames / this._bytes;
  this.durationUs = this.tracks[0].durationUs = Math.round(frames * 1024 * 1e6 / this._rate);
};

AdtsFormat.prototype.reset = function (pos, state) {
  if (state) { this._S = state.S; this._baseUs = state.baseUs; this._rate = state.rate; }
  else { this._S = 0; this._baseUs = 0; this._rate = this.tracks.length ? this.tracks[0].sampleRate : 0; }
};

function _err(code, msg) { var e = new Error(msg); e.code = code; return e; }

function ADTSFileReader(opts) { FileStreamReader.call(this, new AdtsFormat(), opts); }
ADTSFileReader.prototype = Object.create(FileStreamReader.prototype);
ADTSFileReader.prototype.constructor = ADTSFileReader;

export default ADTSFileReader;
