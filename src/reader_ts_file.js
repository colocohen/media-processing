/**
 * reader_ts_file — an MPEG-TS file (ISO/IEC 13818-1; also 192-byte M2TS
 * packets): a FILE fed in pieces → its H.264 / H.265 / AAC frames. The
 * API and events are reader_mp4's (see reader_file_stream.js).
 *
 * The packets go to reader_ts, which does the PSI (the first program of
 * the PAT, its first H.264 / H.265 and first ADTS AAC stream), the PES
 * assembly, the 33-bit PTS unwrapping and the access units / ADTS frames.
 * Around it, here: finding the packet grid (5 sync bytes in a row at 188 /
 * 192 strides), the byte where each PES starts (reader_ts does not keep
 * it — the PES header is read again from its first packet), and the
 * WebCodecs forms:
 *   H.264 / H.265: length-prefixed samples (in-band SPS / PPS / VPS and
 *     AUDs dropped — annexbToAvccSample), the avcC / hvcC built from the
 *     first keyframe's parameter sets as the description, 'avc1.*' /
 *     'hvc1.*' from it, the size from its SPS — what Demuxer's FFmpeg-TS
 *     path did.
 *   AAC: raw frames, the AudioSpecificConfig from the first ADTS header.
 * Track ids are the PIDs. Times are the PES's own (90 kHz, to the nearest
 * µs, as ffprobe's pts_time); a video frame's duration is the frame
 * interval of the first frames (TS has none — FFmpeg guesses the same).
 * info.durationUs: from the last PTS in the last 256 KB of the file (read
 * before 'info' when the size is known) to the first one, as FFmpeg's.
 *
 * The streams reader_ts chose come from its accessors (videoPid(),
 * videoStreamType(), audioPid(), streams()); its private fields were read
 * before.
 *
 * seek(): by bisection — a PES says its time wherever reading starts.
 * Video from the last keyframe at / before the time (its PES's first
 * packet), audio from the frame playing at its time. Exact.
 */

import FileStreamReader from './reader_file_stream.js';
import TSReader from './reader_ts.js';
import {
  annexbToAvccSample, buildAvcCFromAnnexB, buildHvcCFromAnnexB, codecStringFromAvcC, codecStringFromHvcC, splitNALUs,
} from './utils/nalu_utils.js';
import { stripAdts, audioSpecificConfigFromAdts, parseAudioSpecificConfig, parseAdtsHeader, adtsHeaderLength } from './utils/aac_utils.js';
import { parseH264Sps, parseH265Sps } from './utils/h26x_parse.js';
import { STREAM_TYPE_H265 } from './utils/ts_constants.js';

var TAIL = 256 * 1024;
var WRAP = 8589934592;     // 2^33

function TsFormat() {
  this.name = 'TSReader';
  this.container = 'mpegts';
  this.tracks = [];
  this.resync = true;
  this.dataStart = 0;
  this.estimateVideoDuration = true;
  this.tailFrom = null;
  this._stride = 0;
  this._pmtSeen = false;
  this._vCur = null;         // the video PES being collected: { pos, pts, dts } (90 kHz ticks)
  this._aCur = null;
  this._pend = [];
  this._mute = false;
  this._lastV = null;        // tail: the last video PTS, the last audio PES's PTS (ticks) and its length (µs)
  this._lastA = null;
  this._lastADur = 0;
  this._newReader();
  var self = this;
  Object.defineProperty(this, 'durationUs', { enumerable: true, get: function () { return self._duration(); } });
}

TsFormat.prototype._newReader = function () {
  var self = this;
  this._r = new TSReader();
  this._r.on('video', function (f) { if (!self._mute) self._video(f); });
  this._r.on('audio', function (f) { if (!self._mute) self._audio(f); });
};

TsFormat.prototype.ready = function () {
  if (!this._pmtSeen) return false;
  for (var i = 0; i < this.tracks.length; i++) if (!this.tracks[i].config) return false;
  return true;
};

// The packet grid: the first offset (≥ from) with sync bytes at `stride`
// for 5 packets (or to the end of the file). { at, stride } | null (none) | 0 (more bytes).
function _sync(v, from, eof) {
  var strides = [188, 192];
  for (var i = from; i < v.length; i++) {
    if (v[i] !== 0x47) continue;
    for (var s = 0; s < 2; s++) {
      var st = strides[s], k = 1, short = false;
      while (k < 5) {
        var q = i + k * st;
        if (q >= v.length) { short = true; break; }
        if (v[q] !== 0x47) break;
        k++;
      }
      if (k === 5) return { at: i, stride: st };
      if (short) return eof ? { at: i, stride: st } : 0;
    }
  }
  return eof ? null : 0;
}

TsFormat.prototype.parse = function (win, pos, eof, emit) {
  while (this._pend.length) if (!emit(this._pend.shift())) return pos;
  while (true) {
    if (!win.has(pos, 1)) return this._end(eof, emit, pos);
    var v = win.view(pos, win.end() - pos);
    if (!this._stride || v[0] !== 0x47) {
      var sy = _sync(v, 0, eof);
      if (sy === 0) return pos;
      if (!sy) return this._end(eof, emit, win.end());
      this._stride = sy.stride;
      pos += sy.at;
      continue;
    }
    if (v.length < 188) return eof ? this._end(eof, emit, win.end()) : pos;
    var pkt = v.subarray(0, 188), at = pos;
    pos += this._stride;
    this._packet(pkt, at);
    // (From this._pend itself: a jump from inside emit() — reset() —
    // empties it; the frames left were put back after it and went out
    // first at the new position.)
    while (this._pend.length) if (!emit(this._pend.shift())) return Math.min(pos, win.end());
    if (pos > win.end()) return win.end();
  }
};

// The end of the file: what reader_ts still holds goes out.
TsFormat.prototype._end = function (eof, emit, pos) {
  if (!eof) return pos;
  this._r.flush();
  while (this._pend.length) if (!emit(this._pend.shift())) return pos;
  return Infinity;
};

TsFormat.prototype._packet = function (pkt, at) {
  var r = this._r;
  var pid = ((pkt[1] & 0x1F) << 8) | pkt[2], pusi = pkt[1] & 0x40;
  var vNew = null, aNew = null;
  if (pusi && pid === r.videoPid()) vNew = _pesTimes(pkt, at) || { pos: at, pts: null, dts: null };
  if (pusi && pid === r.audioPid()) aNew = { pos: at };
  r.feed(pkt);
  if (vNew) this._vCur = vNew;
  if (aNew) this._aCur = aNew;
  // A PMT applied (all of its section: it may span packets). The first
  // packet of the PMT PID was taken for it, so a PMT cut over two packets
  // gave 'info' with no tracks.
  if (!this._pmtSeen && r.streams() !== null) this._pmtSeen = true;
  if (this._pmtSeen) this._tracksFromPmt();
};

TsFormat.prototype._tracksFromPmt = function () {
  var r = this._r;
  if (r.videoPid() !== null && !this._track(r.videoPid())) {
    this.tracks.unshift({
      id: r.videoPid(), type: 'video', handler: 'mpegts', entry: r.videoStreamType() === STREAM_TYPE_H265 ? 'hevc' : 'h264',
      codec: null, description: null, timescale: 90000, durationUs: 0, sampleCount: null, bitrate: null, startUs: null,
      codedWidth: 0, codedHeight: 0, displayWidth: 0, displayHeight: 0, rotation: 0, flip: false, colorSpace: null,
      frameRate: 0, config: null,
    });
  }
  if (r.audioPid() !== null && !this._track(r.audioPid())) {
    this.tracks.push({
      id: r.audioPid(), type: 'audio', handler: 'mpegts', entry: 'aac', codec: null, description: null,
      timescale: 90000, durationUs: 0, sampleCount: null, bitrate: null, startUs: null,
      sampleRate: 0, numberOfChannels: 0, config: null,
    });
  }
  if (this.tailFrom === null && this.fileSize) this.tailFrom = Math.max(0, this.fileSize - TAIL);
};

TsFormat.prototype._track = function (id) {
  for (var i = 0; i < this.tracks.length; i++) if (this.tracks[i].id === id) return this.tracks[i];
  return null;
};

TsFormat.prototype._video = function (f) {
  var r = this._r, t = this._track(r.videoPid()), h265 = r.videoStreamType() === STREAM_TYPE_H265;
  if (!t) { this._tracksFromPmt(); t = this._track(r.videoPid()); }
  if (!t.config) _videoConfig(t, f.payload, h265);
  var cur = this._vCur || { pos: 0, pts: null, dts: null };
  // reader_ts gives the DTS now (it was read again here from the PES's
  // first packet).
  this._pend.push({
    trackId: t.id, payload: annexbToAvccSample(f.payload, h265), isKeyframe: f.isKeyframe,
    ptsUs: f.ptsUs, dtsUs: f.dtsUs, durationUs: 0, pos: cur.pos,
  });
};

TsFormat.prototype._audio = function (f) {
  var r = this._r, t = this._track(r.audioPid());
  if (!t) { this._tracksFromPmt(); t = this._track(r.audioPid()); }
  if (!t.config) {
    var asc = audioSpecificConfigFromAdts(f.payload), a = asc && parseAudioSpecificConfig(asc);
    if (a) {
      t.codec = 'mp4a.40.' + a.objectType;
      t.description = asc;
      t.sampleRate = f.sampleRate;
      t.numberOfChannels = f.channels;
      t.config = { codec: t.codec, sampleRate: f.sampleRate, numberOfChannels: f.channels, description: asc };
    }
  }
  this._pend.push({
    trackId: t.id, payload: stripAdts(f.payload), isKeyframe: true,
    ptsUs: f.ptsUs, dtsUs: f.ptsUs, durationUs: f.durationUs, pos: this._aCur ? this._aCur.pos : 0,
  });
};

// The decoder config from an access unit with parameter sets.
function _videoConfig(t, au, h265) {
  var rec = h265 ? buildHvcCFromAnnexB(au) : buildAvcCFromAnnexB(au);
  if (!rec) return;
  var codec = h265 ? codecStringFromHvcC(rec, 'hvc1') : codecStringFromAvcC(rec, 'avc1');
  if (!codec) return;
  var nalus = splitNALUs(au, h265), sps = null;
  for (var i = 0; i < nalus.length && !sps; i++) {
    if (nalus[i].type === (h265 ? 33 : 7)) sps = h265 ? parseH265Sps(nalus[i].data) : parseH264Sps(nalus[i].data);
  }
  t.codec = codec;
  t.description = rec;
  if (sps) { t.codedWidth = t.displayWidth = sps.width; t.codedHeight = t.displayHeight = sps.height; }
  t.config = { codec: codec, codedWidth: t.codedWidth, codedHeight: t.codedHeight, description: rec };
}

// A PES's first packet: { pos, pts, dts } (33-bit ticks; dts = pts without one).
function _pesTimes(pkt, at) {
  var afc = (pkt[3] >> 4) & 3;
  if (!(afc & 1)) return null;
  var o = 4;
  if (afc & 2) o += 1 + pkt[4];
  if (o + 14 > pkt.length || pkt[o] !== 0 || pkt[o + 1] !== 0 || pkt[o + 2] !== 1) return null;
  var flags = pkt[o + 7] >> 6;
  if (!(flags & 2)) return { pos: at, pts: null, dts: null };
  var pts = _ts(pkt, o + 9);
  var dts = flags === 3 && o + 19 <= pkt.length ? _ts(pkt, o + 14) : pts;
  return { pos: at, pts: pts, dts: dts };
}

function _ts(b, o) {
  return ((b[o] >> 1) & 7) * 1073741824 + ((b[o + 1] << 7) | (b[o + 2] >> 1)) * 32768 + ((b[o + 3] << 7) | (b[o + 4] >> 1));
}

// The last bytes: the last video PTS, and where the last audio PES ends.
TsFormat.prototype.parseTail = function (b) {
  var r = this._r, sy = _sync(b, 0, true);
  if (!sy) return;
  var st = sy.stride, lastV = null, aPes = null, aStart = null;
  for (var p = sy.at; p + 188 <= b.length; p += st) {
    if (b[p] !== 0x47) continue;
    var pid = ((b[p + 1] & 0x1F) << 8) | b[p + 2], pusi = b[p + 1] & 0x40;
    var afc = (b[p + 3] >> 4) & 3, o = p + 4;
    if (!(afc & 1)) continue;
    if (afc & 2) o += 1 + b[p + 4];
    if (o >= p + 188) continue;
    if (pusi && (pid === r.videoPid() || pid === r.audioPid())) {
      var tm = _pesTimes(b.subarray(p, p + 188), 0);
      if (tm && tm.pts !== null) {
        // (the latest, each PTS taken as the one nearest the latest so far:
        // a tail across the 2^33 wrap (13818-1 §2.4.3.7, PTS modulo 2^33)
        // had the last PTS before the wrap as the greatest — a 3 s file
        // wrapping in its middle was info.durationUs 1.4 s, ffprobe 3.0 s)
        if (pid === r.videoPid()) lastV = lastV === null ? tm.pts : Math.max(lastV, _near(tm.pts, lastV));
        else { aStart = tm.pts; aPes = [b.subarray(o + 9 + b[o + 8], p + 188)]; }
      }
    } else if (pid === r.audioPid() && aPes) aPes.push(b.subarray(o, p + 188));
  }
  if (lastV !== null) this._lastV = lastV;
  if (aStart !== null) {
    var samples = 0, rate = 0, es = _cat(aPes);
    for (var q = 0; q + 7 <= es.length;) {
      var h = adtsHeaderLength(es.subarray(q, q + 9)) ? parseAdtsHeader(es.subarray(q, q + 9)) : null;   // layer '00' too
      if (!h || !h.frameLength || !h.sampleRate) break;
      samples += h.samplesPerFrame; rate = h.sampleRate; q += h.frameLength;
    }
    this._lastA = aStart;
    this._lastADur = rate ? samples * 1e6 / rate : 0;
  }
};

// A tail PTS (33 bits) as the one nearest a reference time (the 2^33 wrap).
function _near(t, ref) { return t + Math.round((ref - t) / WRAP) * WRAP; }
function _cat(list) {
  var n = 0, i;
  for (i = 0; i < list.length; i++) n += list[i].length;
  var o = new Uint8Array(n), k = 0;
  for (i = 0; i < list.length; i++) { o.set(list[i], k); k += list[i].length; }
  return o;
}

TsFormat.prototype._duration = function () {
  var start = null, end = null, v = null;
  this.tracks.forEach(function (t) {
    if (t.startUs != null && (start === null || t.startUs < start)) start = t.startUs;
    if (t.type === 'video' && !v) v = t;
  });
  if (start === null) return 0;
  var ref = Math.round(start * 9 / 100);
  if (this._lastV !== null) end = Math.round(_near(this._lastV, ref) * 100 / 9) + (v && v.frameDurUs ? v.frameDurUs : 0);
  if (this._lastA !== null) {
    var ae = Math.round(_near(this._lastA, ref) * 100 / 9 + this._lastADur);
    end = end === null ? ae : Math.max(end, ae);
  }
  return end !== null && end > start ? end - start : 0;
};

TsFormat.prototype.reset = function (pos) {
  // Keep the PSI (the PIDs), drop the PES in progress: what reader_ts
  // still holds would be from before the jump.
  this._mute = true;
  this._r.flush();
  this._mute = false;
  this._pend = [];
  this._vCur = null;
  this._aCur = null;
  this._stride = pos === this.dataStart ? this._stride : 0;
};

function TSFileReader(opts) { FileStreamReader.call(this, new TsFormat(), opts); }
TSFileReader.prototype = Object.create(FileStreamReader.prototype);
TSFileReader.prototype.constructor = TSFileReader;

export default TSFileReader;
