/**
 * reader_flv_file — an FLV file: a FILE fed in pieces → its H.264 / H.265
 * video (legacy AVC tags; HEVC as codec id 12 or Enhanced RTMP 'hvc1';
 * also Enhanced RTMP 'av01' / 'vp09') and its AAC / MP3 audio. The API
 * and events are reader_mp4's (see reader_file_stream.js).
 *
 *   FLV spec v10.1 (Annex E): the header, tags (type, 24-bit size, 24 +
 *   8-bit timestamp in ms, PreviousTagSize after each), VIDEODATA /
 *   AVCVIDEOPACKET (AVCPacketType, CompositionTime), AUDIODATA /
 *   AACAUDIODATA, SCRIPTDATA (AMF0 onMetaData).
 *   Enhanced RTMP v1 / v2: ExVideoTagHeader (IsExHeader, FrameType,
 *   VideoPacketType, FourCC; CodedFrames with a CompositionTime,
 *   CodedFramesX without).
 *
 * Samples are the tags' data as they are: length-prefixed NAL units with
 * the sequence header's avcC / hvcC as the description ('avc1.*' /
 * 'hvc1.*'), AV1 OBUs with its av1C, VP9 frames with its vpcC's profile /
 * level / depth; raw AAC with the AudioSpecificConfig of the AAC
 * sequence header; MP3 frames. Times: the tag timestamp is the DTS, plus
 * the CompositionTime for the PTS (ms, as FFmpeg's flv demuxer).
 * keyframe: FrameType 1 (a 'video info / command frame', 5, is no frame).
 * Video frames have no duration in FLV: the frame interval of the first
 * frames (FFmpeg guesses the same); an audio frame's is its samples
 * (1024 for AAC, the MP3 header's) at its rate.
 * info.durationUs: onMetaData's duration (what FFmpeg reports).
 *
 * Not reader_flv: that one is the encoder path's (video only, converted
 * to Annex-B access units with parameter sets inserted); the tag layer
 * here is its own, the Enhanced RTMP rules the same.
 * Not read: Enhanced RTMP multitrack / ModEx packets, audio other than
 * AAC / MP3 (a track with codec null), encrypted tags.
 *
 * seek(): by bisection — a tag says its time wherever reading starts (a
 * tag is found by its header and the PreviousTagSize after it). Video
 * from the last keyframe at / before the time, audio from its time. Exact.
 */

import FileStreamReader from './reader_file_stream.js';
import { readU32BE, toAscii } from './core/bytes.js';
import { codecStringFromAvcC, codecStringFromHvcC, parseAvcC, parseHvcC } from './utils/nalu_utils.js';
import { parseAudioSpecificConfig } from './utils/aac_utils.js';
import { codecStringFromAv1C, buildCodecString } from './utils/codec_strings.js';
import { parseH264Sps, parseH265Sps } from './utils/h26x_parse.js';
import { parseMpaHeader } from './utils/mpeg_audio.js';

var VIDEO_ID = 1, AUDIO_ID = 2;
var PROBE_TAGS = 200;          // tags read before 'info' while a track the header announces has no config yet

function FlvFormat() {
  this.name = 'FLVReader';
  this.container = 'flv';
  this.tracks = [];
  this.resync = true;
  this.dataStart = 0;
  this.durationUs = 0;
  this.estimateVideoDuration = true;
  this._st = 0;
  this._hasV = false;
  this._hasA = false;
  this._tags = 0;
  this._lengthSize = 4;
  this._resyncing = false;
}

FlvFormat.prototype.ready = function () {
  if (this._st !== 1) return false;
  var v = this._track(VIDEO_ID), a = this._track(AUDIO_ID);
  var vOk = v ? !!v.config : !this._hasV, aOk = a ? !!a.config : !this._hasA;
  return (vOk && aOk) || this._tags >= PROBE_TAGS;
};

FlvFormat.prototype._track = function (id) {
  for (var i = 0; i < this.tracks.length; i++) if (this.tracks[i].id === id) return this.tracks[i];
  return null;
};

FlvFormat.prototype.parse = function (win, pos, eof, emit) {
  if (this._st === 0) {
    if (!win.has(pos, 9)) { if (eof) throw _err('NOT_FLV', 'no FLV header'); return pos; }
    var h = win.view(pos, 9);
    if (toAscii(h, 0, 3) !== 'FLV') throw _err('NOT_FLV', 'not an FLV file');
    this._hasA = !!(h[4] & 4);
    this._hasV = !!(h[4] & 1);
    var off = readU32BE(h, 5);
    this.dataStart = pos + Math.max(9, off) + 4;               // + PreviousTagSize0
    this._st = 1;
    pos = this.dataStart;
  }
  while (true) {
    if (!win.has(pos, 11)) return eof ? Infinity : pos;
    var v = win.peek(pos, 11), type = v[0] & 0x1F, size = (v[1] << 16) | (v[2] << 8) | v[3];
    if (this._resyncing || (type !== 8 && type !== 9 && type !== 18) || (v[0] & 0xC0)) {
      var q = this._find(win, pos, eof);
      if (q === -2) return pos;
      if (q < 0) return eof ? Infinity : Math.max(pos, win.end() - 15);
      this._resyncing = false;
      pos = q;
      continue;
    }
    if (!win.has(pos, 11 + size)) return eof ? Infinity : pos;   // a cut-off last tag isn't one
    var ts = ((v[7] << 24) | (v[4] << 16) | (v[5] << 8) | v[6]) | 0;   // signed, as FFmpeg reads the extension byte
    var body = win.view(pos + 11, size), at = pos;
    pos += 11 + size + 4;
    this._tags++;
    var s = null;
    if (v[0] & 0x20) s = null;                                  // filtered (encrypted)
    else if (type === 9) s = this._videoTag(body, ts);
    else if (type === 8) s = this._audioTag(body, ts);
    else if (type === 18) this._script(body);
    if (s) {
      s.pos = at;
      if (!emit(s)) return pos;
    }
  }
};

// The next tag at / after `from`: a known type, its PreviousTagSize right,
// the tag after it (or the end) plausible. -1 none here, -2 can't tell yet.
FlvFormat.prototype._find = function (win, from, eof) {
  var end = win.end();
  for (var p = from; p + 11 <= end; p++) {
    var v = win.peek(p, 11), type = v[0];
    if (type !== 8 && type !== 9 && type !== 18) continue;
    if (v[8] | v[9] | v[10]) continue;                          // StreamID 0
    var size = (v[1] << 16) | (v[2] << 8) | v[3], q = p + 11 + size;
    if (q + 4 > end) { if (eof) continue; return -2; }
    if (readU32BE(win.peek(q, 4), 0) !== 11 + size) continue;
    if (q + 4 + 11 <= end) {
      var n = win.peek(q + 4, 1)[0] & 0x1F;
      if (n !== 8 && n !== 9 && n !== 18) continue;
    }
    return p;
  }
  return eof ? -1 : -2;
};

FlvFormat.prototype._videoTrack = function (entry) {
  var t = this._track(VIDEO_ID);
  if (!t) {
    t = {
      id: VIDEO_ID, type: 'video', handler: 'flv', entry: entry, codec: null, description: null,
      timescale: 1000, durationUs: 0, sampleCount: null, bitrate: null, startUs: null,
      codedWidth: _metaDim(this._meta, 'width'), codedHeight: _metaDim(this._meta, 'height'),
      displayWidth: 0, displayHeight: 0, rotation: 0, flip: false, colorSpace: null, frameRate: 0, config: null,
    };
    this.tracks.unshift(t);
  }
  return t;
};

FlvFormat.prototype._videoTag = function (b, ts) {
  if (b.length < 1) return null;
  var b0 = b[0], frameType, pkt, fourcc, data, cts = 0;
  if (b0 & 0x80) {
    // Enhanced RTMP: [IsExHeader | FrameType:3 | VideoPacketType:4][FourCC]
    frameType = (b0 >> 4) & 7;
    pkt = b0 & 0x0F;
    if (b.length < 5) return null;
    fourcc = toAscii(b, 1, 5);
    if (pkt === 1) {
      if (fourcc === 'avc1' || fourcc === 'hvc1') { if (b.length < 8) return null; cts = _si24(b, 5); data = b.subarray(8); }
      else data = b.subarray(5);
    } else if (pkt === 0 || pkt === 3) data = b.subarray(5);
    else return null;                                           // end of sequence, metadata, multitrack, ModEx, …
    if (pkt === 3) pkt = 1;
  } else {
    var codecId = b0 & 0x0F;
    frameType = b0 >> 4;
    if (codecId !== 7 && codecId !== 12) { this._videoTrack('flv-video-' + codecId); return null; }
    fourcc = codecId === 7 ? 'avc1' : 'hvc1';
    if (b.length < 5) return null;
    pkt = b[1];                                                 // 0 sequence header, 1 NALUs, 2 end of sequence
    if (pkt > 1) return null;
    cts = _si24(b, 2);
    data = b.subarray(5);
  }
  var t = this._videoTrack(fourcc);
  if (pkt === 0) { this._videoConfig(t, fourcc, data); return null; }
  if (frameType === 5) return null;                             // video info / command frame
  if (!data.length) return null;
  var dtsUs = ts * 1000;
  return { trackId: VIDEO_ID, payload: data, isKeyframe: frameType === 1, ptsUs: (ts + cts) * 1000, dtsUs: dtsUs, durationUs: 0 };
};

FlvFormat.prototype._videoConfig = function (t, fourcc, rec) {
  if (t.config || !rec.length) return;
  var codec = null, w = 0, h = 0;
  rec = rec.slice();
  if (fourcc === 'avc1') {
    var avc = parseAvcC(rec);
    codec = codecStringFromAvcC(rec, 'avc1');
    var sps = avc && avc.sps.length ? parseH264Sps(avc.sps[0]) : null;
    if (sps) { w = sps.width; h = sps.height; }
    if (avc) this._lengthSize = avc.lengthSize;
  } else if (fourcc === 'hvc1') {
    var hv = parseHvcC(rec);
    codec = codecStringFromHvcC(rec, 'hvc1');
    for (var i = 0; hv && i < hv.nalus.length; i++) {
      if (((hv.nalus[i][0] >> 1) & 0x3F) === 33) { var s = parseH265Sps(hv.nalus[i]); if (s) { w = s.width; h = s.height; } break; }
    }
  } else if (fourcc === 'av01') {
    codec = codecStringFromAv1C(rec);
  } else if (fourcc === 'vp09') {
    // vpcC (VP Codec ISO Media File Format Binding §2.2): version, flags, profile, level, bitDepth << 4 | …
    if (rec.length >= 7) codec = buildCodecString({ name: 'vp9', profile: String(rec[4]), level: (rec[5] / 10).toFixed(1), bitDepth: rec[6] >> 4 });
    rec = null;
  }
  if (!codec) return;
  if (w) { t.codedWidth = t.displayWidth = w; t.codedHeight = t.displayHeight = h; }
  t.codec = codec;
  t.description = rec;
  t.config = { codec: codec, codedWidth: t.codedWidth, codedHeight: t.codedHeight };
  if (rec) t.config.description = rec;
};

FlvFormat.prototype._audioTrack = function (entry) {
  var t = this._track(AUDIO_ID);
  if (!t) {
    t = {
      id: AUDIO_ID, type: 'audio', handler: 'flv', entry: entry, codec: null, description: null,
      timescale: 1000, durationUs: 0, sampleCount: null, bitrate: null, startUs: null,
      sampleRate: 0, numberOfChannels: 0, config: null,
    };
    this.tracks.push(t);
  }
  return t;
};

FlvFormat.prototype._audioTag = function (b, ts) {
  if (b.length < 1) return null;
  var fmt = b[0] >> 4;
  if (fmt === 10) {
    var t = this._audioTrack('aac');
    if (b.length < 2) return null;
    if (b[1] === 0) {                                           // AudioSpecificConfig
      if (!t.config) {
        var asc = b.slice(2), a = parseAudioSpecificConfig(asc);
        if (a) {
          t.codec = 'mp4a.40.' + a.objectType;
          t.description = asc;
          t.sampleRate = a.sampleRate;
          t.numberOfChannels = a.channels;
          t.config = { codec: t.codec, sampleRate: a.sampleRate, numberOfChannels: a.channels, description: asc };
        }
      }
      return null;
    }
    var data = b.subarray(2);
    if (!data.length) return null;
    var rate = t.sampleRate || 44100, pts = ts * 1000;
    return { trackId: AUDIO_ID, payload: data, isKeyframe: true, ptsUs: pts, dtsUs: pts, durationUs: Math.round(1024 * 1e6 / rate) };
  }
  if (fmt === 2 || fmt === 14) {                                // MP3 (14: MP3 8 kHz)
    var tm = this._audioTrack('mp3'), d = b.subarray(1), h = parseMpaHeader(d, 0);
    if (!h) return null;
    if (!tm.config) {
      tm.codec = h.layer === 3 ? 'mp3' : null;
      tm.entry = 'mp' + h.layer;
      tm.sampleRate = h.sampleRate;
      tm.numberOfChannels = h.channels;
      if (tm.codec) tm.config = { codec: tm.codec, sampleRate: h.sampleRate, numberOfChannels: h.channels };
    }
    var p2 = ts * 1000;
    return { trackId: AUDIO_ID, payload: d, isKeyframe: true, ptsUs: p2, dtsUs: p2, durationUs: Math.round(h.samplesPerFrame * 1e6 / h.sampleRate) };
  }
  this._audioTrack('flv-audio-' + fmt);
  return null;
};

// onMetaData (AMF0): the duration, and the size before a sequence header says it.
FlvFormat.prototype._script = function (b) {
  try {
    var r = { b: b, p: 0 };
    var name = _amf(r);
    if (name !== 'onMetaData') return;
    var m = _amf(r);
    if (!m || typeof m !== 'object') return;
    this._meta = m;
    // (a number that is a duration: finite, its µs a safe integer — an
    // Infinity / 1e300 there was info.durationUs Infinity / 1e306)
    var us = typeof m.duration === 'number' ? Math.round(m.duration * 1e6) : 0;
    if (us > 0 && us <= Number.MAX_SAFE_INTEGER) this.durationUs = us;
  } catch (e) { /* not readable: no metadata */ }
};

// onMetaData's width / height, as the track's size until a sequence
// header says it: a number (AMF0 type 0 — FFmpeg's flvdec takes only
// those), truncated to an integer as FFmpeg's (int) does, 1 … 2^32 − 1
// (WebCodecs' unsigned long); else 0. Any truthy value was taken as it
// was: a string, true, -5 or 1e12 became the codedWidth (ffprobe:
// the decoder's 64×48).
function _metaDim(m, k) {
  var v = m && Object.prototype.hasOwnProperty.call(m, k) ? m[k] : 0;
  if (typeof v !== 'number' || !(v >= 1 && v < 4294967296)) return 0;
  return Math.floor(v);
}

// One AMF0 value (strings, numbers, booleans, objects, ECMA / strict arrays, dates).
function _amf(r) {
  var b = r.b, t = b[r.p++];
  if (t === 0) {
    // (within the tag: a DataView on b.buffer read on past b's end — into
    // the next tag's bytes — when a number was cut off by the tag's size)
    if (r.p + 8 > b.length) throw new Error('AMF0 number cut off');
    var dv = new DataView(b.buffer, b.byteOffset + r.p, 8); r.p += 8; return dv.getFloat64(0);
  }
  if (t === 1) return !!b[r.p++];
  if (t === 2) return _amfStr(r, 2);
  if (t === 12) return _amfStr(r, 4);
  if (t === 3 || t === 8) {
    if (t === 8) r.p += 4;
    var o = Object.create(null);           // ('__proto__' is a key like the others)
    while (r.p + 3 <= b.length) {
      var k = _amfStr(r, 2);
      if (!k && b[r.p] === 9) { r.p++; break; }
      o[k] = _amf(r);
    }
    return o;
  }
  if (t === 10) {
    var n = readU32BE(b, r.p), arr = [];
    r.p += 4;
    for (var i = 0; i < n; i++) arr.push(_amf(r));
    return arr;
  }
  if (t === 11) { r.p += 10; return null; }
  if (t === 5 || t === 6) return null;
  throw new Error('AMF0 type ' + t);
}
function _amfStr(r, w) {
  var b = r.b, n = w === 2 ? (b[r.p] << 8) | b[r.p + 1] : readU32BE(b, r.p);
  r.p += w;
  var s = toAscii(b, r.p, r.p + n);
  r.p += n;
  return s;
}

function _si24(b, o) {
  var v = (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
  return v & 0x800000 ? v - 0x1000000 : v;
}

FlvFormat.prototype.reset = function (pos) { this._resyncing = pos !== this.dataStart; };

function _err(code, msg) { var e = new Error(msg); e.code = code; return e; }

function FLVFileReader(opts) { FileStreamReader.call(this, new FlvFormat(), opts); }
FLVFileReader.prototype = Object.create(FileStreamReader.prototype);
FLVFileReader.prototype.constructor = FLVFileReader;

export default FLVFileReader;
