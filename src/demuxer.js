/**
 * Demuxer — Read media files and emit individual encoded chunks.
 *
 * Usage:
 *   var demuxer = new Demuxer({ file: 'input.mp4' });
 *   var info = demuxer.probe();
 *   demuxer.on('video', function(chunk, metadata) { ... }); // EncodedVideoChunk per frame
 *   demuxer.on('audio', function(chunk, metadata) { ... }); // EncodedAudioChunk per frame
 *   demuxer.on('end', function() { ... });
 *   demuxer.start();
 *
 * Chunks carry the media's own presentation timestamps (µs, what ffprobe
 * calls pts_time), the container's keyframe flags and durations; the
 * first chunk of each kind after start() / seek() comes with
 * metadata.decoderConfig (also on videoDecoderConfig / audioDecoderConfig).
 * They are in the WebCodecs registrations' default forms: H.264 / H.265
 * length-prefixed with an avcC / hvcC description, AAC raw with its
 * AudioSpecificConfig, Opus / Vorbis / FLAC packets with their headers as
 * the description, PCM as 'pcm-s16' / 'pcm-s24' / 'pcm-s32' / 'pcm-f32' /
 * 'pcm-u8' blocks of whole samples.
 *
 * How the packets are read:
 *  - MP4 / MOV / WebM / MKV files with codecs those readers know: read
 *    directly by FileDemuxer (reader_mp4 / reader_webm), off the disk.
 *  - Anything else: FFmpeg copies the streams (-c copy -copyts) into a
 *    container that keeps every packet's timestamp and keyframe flag, on
 *    stdout. H.264 / H.265 / AAC (MPEG-TS, FLV, ADTS, …): MPEG-TS, read by
 *    reader_ts (90 kHz times, as the source has them). The rest (Ogg, MP3,
 *    FLAC, WAV, …): Matroska, read by reader_webm, which also carries the
 *    codec headers (Matroska times are in ms). PCM that WebCodecs has no
 *    name for (big-endian, 64-bit float, A-law, …) is converted.
 *
 * Before, video went out as raw Annex-B / IVF and audio as ADTS / Ogg /
 * a WAV byte stream, and the readers numbered frames in arrival order:
 * timestamps were decode-order frame counts (87 of 90 wrong on a B-frame
 * file), restarted at 0 after a seek, VP9 from WebM started at 7000 µs;
 * MP3 / PCM came out as fixed 10 ms byte slices starting with the ID3 /
 * RIFF header; Vorbis was timed as Opus and had no description.
 */

import fs from 'node:fs';
import FFmpegProcess from './ffmpeg_process.js';
import EventEmitter from './core/events.js';
import { execFileSync } from 'node:child_process';
import { EncodedVideoChunk, EncodedAudioChunk } from './encoded_chunk.js';
import FileDemuxer from './file_demuxer.js';
import WebMReader from './reader_webm.js';
import TSReader from './reader_ts.js';
import {
  bitstreamFromDescription, codecStringFromAnnexB, parseAvcC, parseHvcC,
  buildAvcCFromAnnexB, buildHvcCFromAnnexB, codecStringFromAvcC, codecStringFromHvcC,
  annexbToAvccSample,
} from './utils/nalu_utils.js';
import {
  parseAudioSpecificConfig, buildAudioSpecificConfig, audioSpecificConfigFromAdts, stripAdts,
  ADTS_SAMPLE_RATES,
} from './utils/aac_utils.js';

// FFmpeg path: added to every timestamp so none is negative (Matroska
// cluster times are unsigned; FFmpeg would otherwise shift the whole file
// — AAC priming at -23 ms moved every timestamp by +23 ms), taken off again
// when read.
var TS_OFFSET_S = 1000;
// FFmpeg path, seeking: how much earlier than the time FFmpeg starts
// reading (to be sure of a keyframe at / before it).
var PREROLL_S = 10;
// PCM chunks: at most this many sample frames.
var PCM_BLOCK = 1024;
// Native path: bytes read per feed, and feeds per event-loop turn.
var READ_SIZE = 256 * 1024;
var READS_PER_TURN = 4;

// Codecs the MP4 / WebM readers turn into WebCodecs configs.
var NATIVE_VIDEO = { h264: 1, h265: 1, av1: 1, vp8: 1, vp9: 1 };
var NATIVE_AUDIO_MKV = { aac: 1, opus: 1, vorbis: 1, mp3: 1, flac: 1, pcm_s16le: 1, pcm_s24le: 1, pcm_s32le: 1, pcm_f32le: 1, pcm_u8: 1 };
var NATIVE_AUDIO_MP4 = { aac: 1, opus: 1, mp3: 1, flac: 1, pcm_mulaw: 1, pcm_alaw: 1 };
// MP4 PCM read natively, by sample entry: 'sowt' 16-bit little-endian,
// 'twos' 16-bit big-endian (swapped here), 'raw ' unsigned 8-bit. Others
// (ipcm, in24, lpcm, 8-bit 'twos', …) go through FFmpeg.
var NATIVE_PCM_MP4 = { sowt: 'pcm_s16le', twos: 'pcm_s16be', 'raw ': 'pcm_u8' };
// Matroska can carry these as is; WebCodecs names them (see header).
var PCM_COPY = { pcm_s16le: 'pcm-s16', pcm_s24le: 'pcm-s24', pcm_s32le: 'pcm-s32', pcm_f32le: 'pcm-f32', pcm_u8: 'pcm-u8' };

function Demuxer(opts) {
  if (!opts) opts = {};
  this._ee = new EventEmitter();
  this._opts = opts;
  this._file = opts.file || null;
  this._ffmpeg = new FFmpegProcess(opts);
  this._started = false;
  this._info = null;
  // The run (one start() / seek()) whose events count. A seek stops the
  // run before it, but what that run had queued — stdout data, its
  // 'stdout_end' / 'close' — still arrived and was taken as the new run's:
  // a stale chunk and a second 'end' (D12). Events of any other run are
  // now dropped.
  this._run = null;
}

Demuxer.prototype.on = function (ev, fn) { this._ee.on(ev, fn); };
Demuxer.prototype.off = function (ev, fn) { this._ee.off(ev, fn); };

/**
 * Probe the file for stream info.
 * @returns {{ video, audio, duration }}
 */
Demuxer.prototype.probe = function () {
  if (this._info) return this._info;
  if (!this._file) return null;

  try {
    var out = execFileSync('ffprobe', [
      '-hide_banner', '-loglevel', 'error',
      '-show_streams', '-show_format', '-show_data',   // -show_data: extradata bytes
      '-of', 'json', this._file,
    ], { encoding: 'utf8', timeout: 10000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

    var json = JSON.parse(out);
    var info = { video: null, audio: null, duration: 0, startTime: 0, format: '' };

    if (json.format && json.format.duration) {
      info.duration = parseFloat(json.format.duration);
    }
    if (json.format) {
      info.format = json.format.format_name || '';
      info.startTime = parseFloat(json.format.start_time) || 0;
    }

    var streams = json.streams || [];
    for (var i = 0; i < streams.length; i++) {
      var s = streams[i];
      // A cover image (MKV / MP4 / MP3 attachment) is a 'video' stream to
      // ffprobe — not the video.
      if (s.codec_type === 'video' && !info.video && !(s.disposition && s.disposition.attached_pic)) {
        info.video = {
          codec: _normalizeCodecName(s.codec_name),
          width: s.width || s.coded_width,
          height: s.height || s.coded_height,
          framerate: _parseFramerate(s.r_frame_rate),
          index: s.index,
          tag: s.codec_tag_string || '',
        };
        info.video.codecString = _videoCodecString(s, info.video);
        info.video.config = _videoConfig(s, info.video);
      } else if (s.codec_type === 'audio' && !info.audio) {
        info.audio = {
          codec: _normalizeCodecName(s.codec_name),
          sampleRate: parseInt(s.sample_rate, 10),
          channels: s.channels,
          index: s.index,
          tag: s.codec_tag_string || '',
        };
        info.audio.pcm = _pcmOutput(info.audio.codec);
        info.audio.codecString = info.audio.pcm ? info.audio.pcm.codec : _audioCodecString(s, info.audio.codec);
        info.audio.config = _audioConfig(s, info.audio);
      }
    }
    info.native = _nativeReadable(info);
    // Read natively, MP4 µ-law / A-law keep their WebCodecs names.
    if (info.native && info.audio && /^pcm_(mu|a)law$/.test(info.audio.codec)) {
      info.audio.codecString = info.audio.config.codec = info.audio.codec === 'pcm_mulaw' ? 'ulaw' : 'alaw';
    }

    this._info = info;
    return info;
  } catch (e) {
    return null;
  }
};

/**
 * Start demuxing. Emits 'video', 'audio', 'end', 'error' events.
 * opts.startTime (s): from the last video keyframe at / before it, on the
 * timeline the chunks carry. opts.duration (s): up to that long after it.
 */
Demuxer.prototype.start = function (opts) {
  if (this._started) return;
  this._started = true;
  if (!opts) opts = {};

  var info = this.probe();
  if (!info) { this._started = false; this._ee.emit('error', new Error('Could not probe file')); return; }

  var startUs = opts.startTime ? Math.round(opts.startTime * 1e6) : null;
  var run = {
    // Streams WebCodecs has no codec for (MPEG-2 video, AC-3, …) aren't
    // read: neither reader can frame them into chunks a decoder takes.
    hasVideo: !!info.video && !!NATIVE_VIDEO[info.video.codec],
    hasAudio: !!info.audio && _audioReadable(info.audio.codec),
    startUs: startUs,
    endUs: opts.duration ? (startUs != null ? startUs : Math.round(info.startTime * 1e6)) + Math.round(opts.duration * 1e6) : null,
    offsetUs: 0,
    stopped: false,
    ended: false,
    configSent: { video: false, audio: false },
    videoDone: false, audioDone: false,
    held: [],               // video past the end, kept while frames before it may follow
    swap: 0,                // byte-swap PCM samples of this width (big-endian MP4 'twos')
    close: null,            // stops what this run reads from
  };
  if (!run.hasVideo && !run.hasAudio) {
    this._started = false;
    this._ee.emit('error', new Error('Demuxer: no video or audio stream in a codec it can read'));
    return;
  }
  this._run = run;
  if (info.native) this._startNative(run, info);
  else this._startFFmpeg(run, info);
};

// ── FFmpeg path: -c copy into MPEG-TS or Matroska on stdout ──

Demuxer.prototype._startFFmpeg = function (run, info) {
  var self = this;
  var src = run.src = {};
  var v = run.hasVideo ? info.video : null, a = run.hasAudio ? info.audio : null;
  // H.264 / H.265 / AAC: MPEG-TS, read by reader_ts — the 90 kHz times of
  // a TS / FLV / ADTS source kept exactly. And an ADTS source has to go
  // this way: Matroska needs the AudioSpecificConfig in its header, which
  // FFmpeg only has after the first packet, so FFmpeg 8 refuses to write
  // it to a pipe ("Error parsing AAC extradata").
  var ts = (!v || v.codec === 'h264' || v.codec === 'h265') && (!a || a.codec === 'aac') && !!(v || a);

  var args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (run.startUs != null) {
    // FFmpeg's seek in a TS / FLV / Ogg lands near the time, not on a
    // keyframe before it (seek(2.0) in a 1 s-GOP TS gave a first keyframe
    // at 2.467 s), and a stream copy starts at the next keyframe. Start
    // PREROLL_S earlier; the gate in _sample then starts from the last
    // keyframe at / before the time. -seek_timestamp: -ss is a timestamp
    // of the file, the timeline the chunks carry (-copyts), not an offset
    // from its start time.
    var from = run.startUs / 1e6 - PREROLL_S;
    if (from > info.startTime) args.push('-seek_timestamp', '1', '-ss', String(from));
    run.gate = { heldV: [], heldA: [] };
  }
  args.push('-copyts', '-i', this._file);
  if (v) args.push('-map', '0:' + v.index);
  if (a) args.push('-map', '0:' + a.index);
  args.push('-c', 'copy');
  if (a && a.pcm && a.pcm.convert) args.push('-c:a', a.pcm.convert);
  args.push('-output_ts_offset', String(TS_OFFSET_S));
  if (ts) args.push('-mpegts_copyts', '1', '-f', 'mpegts', 'pipe:1');
  else args.push('-f', 'matroska', 'pipe:1');
  run.offsetUs = TS_OFFSET_S * 1e6;

  var ff = this._ffmpeg = new FFmpegProcess(this._opts);
  run.close = function () { ff.stop(); };
  var reader;
  if (ts) {
    reader = new TSReader();
    var h265 = !!v && v.codec === 'h265';
    reader.on('video', function (f) {
      if (run.src !== src) return;
      // Annex-B access unit → the 'avc' / 'hevc' form the config says.
      self._fromStream(run, 'video', f.payload, h265);
      self._sample(run, src, 'video', { payload: annexbToAvccSample(f.payload, h265), isKeyframe: f.isKeyframe, ptsUs: f.ptsUs, durationUs: 0 });
    });
    reader.on('audio', function (f) {
      if (run.src !== src) return;
      self._fromStream(run, 'audio', f.payload);
      self._sample(run, src, 'audio', { payload: stripAdts(f.payload), isKeyframe: true, ptsUs: f.ptsUs, durationUs: f.durationUs });
    });
  } else {
    reader = new WebMReader();
    reader.on('info', function (ri) { if (run.src === src) self._adopt(run, ri); });
    reader.on('video', function (s) { self._sample(run, src, 'video', s); });
    reader.on('audio', function (s) { self._sample(run, src, 'audio', s); });
    reader.on('error', function (e) { if (run.src === src && self._run === run) { self._ee.emit('error', e); self._finish(run); } });
  }

  ff.on('stdout', function (chunk) { if (run.src === src && self._run === run && !run.ended) reader.feed(chunk); });
  var exited = false, outEnded = false;
  function done() {
    if (run.src !== src || self._run !== run || run.ended || !exited || !outEnded) return;
    if (ts) reader.flush(); else reader.end();   // the last frame waits for what follows it
    self._finish(run);
  }
  ff.on('stdout_end', function () { outEnded = true; done(); });
  ff.on('close', function (code) {
    if (run.src === src && self._run === run && code && !run.ended) {
      self._ee.emit('error', new Error('Demuxer: FFmpeg exited with code ' + code + (ff.lastError ? ': ' + ff.lastError : '')));
    }
    exited = true; outEnded = true; done();
  });
  ff.on('error', function (e) { if (run.src === src && self._run === run) self._ee.emit('error', e); });
  ff.start(args, ['ignore', 'pipe', 'pipe']);
};

// MPEG-TS path: the decoder config from the stream itself, before its
// first chunk goes out — the avcC / hvcC from the first keyframe's
// parameter sets, the AudioSpecificConfig from the first ADTS header —
// in case ffprobe had none (an ADTS source has no extradata at all).
Demuxer.prototype._fromStream = function (run, kind, payload, h265) {
  if (run.configSent[kind]) return;
  var info = this._info;
  if (kind === 'audio') {
    var asc = audioSpecificConfigFromAdts(payload);
    if (asc) info.audio.config.description = asc;
    return;
  }
  if (info.video.config.description) return;
  var rec = h265 ? buildHvcCFromAnnexB(payload) : buildAvcCFromAnnexB(payload);
  if (!rec) return;
  info.video.config.description = rec;
  var str = h265 ? codecStringFromHvcC(rec, 'hvc1') : codecStringFromAvcC(rec, 'avc1');
  if (str) info.video.codecString = info.video.config.codec = str;
};

// ── Native path: FileDemuxer over the file ──

Demuxer.prototype._startNative = function (run, info) {
  var self = this, fd, size;
  var src = run.src = {};
  try {
    fd = fs.openSync(this._file, 'r');
    size = fs.fstatSync(fd).size;
  } catch (e) {
    this._ee.emit('error', e);
    return;
  }
  var r = new FileDemuxer({ size: size });
  var pos = 0, need = null, closed = false, readerEnded = false;
  function closeFile() {
    if (closed) return;
    closed = true;
    try { fs.closeSync(fd); } catch (e) { /* already closed */ }
  }
  run.close = closeFile;
  r.on('need', function (n) { need = n.offset; });
  r.on('info', function (ri) {
    if (run.src !== src || self._run !== run) return;
    if (!self._adopt(run, ri)) {
      // The reader has no config for a stream ffprobe found (a sample
      // entry it doesn't know): FFmpeg reads the file instead.
      closeFile();
      self._startFFmpeg(run, info);
      return;
    }
    if (run.startUs != null) r.seek(run.startUs);
  });
  r.on('video', function (s) { self._sample(run, src, 'video', s); });
  r.on('audio', function (s) { self._sample(run, src, 'audio', s); });
  r.on('end', function () { readerEnded = true; });
  r.on('error', function (e) {
    readerEnded = true;
    if (run.src === src && self._run === run && !closed) { self._ee.emit('error', e); self._finish(run); }
  });

  // A piece at a time, yielding between turns like a pipe would: listeners
  // added after start() still get everything, and a seek() / stop() from a
  // timer or I/O callback lands mid-file.
  function pump() {
    if (closed) return;
    if (self._run !== run || run.ended) { closeFile(); return; }
    for (var k = 0; k < READS_PER_TURN && !readerEnded && !closed; k++) {
      if (need != null) { pos = need; need = null; }
      if (pos >= size) {
        r.end();
        if (need == null) readerEnded = true;
        break;
      }
      var len = Math.min(READ_SIZE, size - pos);
      var buf = Buffer.allocUnsafe(len);
      var got = fs.readSync(fd, buf, 0, len, pos);
      if (got <= 0) { r.end(); readerEnded = true; break; }
      var at = pos;
      pos += got;
      r.feed(got < len ? buf.subarray(0, got) : buf, at);
    }
    if (closed) return;
    if (self._run !== run) { closeFile(); return; }
    if (readerEnded) { closeFile(); self._finish(run); return; }
    setImmediate(pump);
  }
  setImmediate(pump);
};

// ── All paths ──

// A reader's 'info': its configs describe the chunks exactly — they
// replace what was worked out from ffprobe. false: a stream has none.
Demuxer.prototype._adopt = function (run, ri) {
  var info = this._info, v = null, a = null;
  (ri.tracks || []).forEach(function (t) {
    if (!t.config) return;
    if (!v && t.type === 'video') v = t;
    if (!a && t.type === 'audio') a = t;
  });
  if ((run.hasVideo && !v) || (run.hasAudio && !a)) return false;
  if (v) {
    info.video.config = _copyConfig(v.config);
    info.video.codecString = v.config.codec;
  }
  if (a) {
    info.audio.config = _copyConfig(a.config);
    info.audio.codecString = a.config.codec;
    // 'twos' (QuickTime big-endian PCM): WebCodecs PCM is little-endian.
    run.swap = a.bigEndian && /^pcm-s16$/.test(a.codec) ? 2 : 0;
    run.pcmFrame = _pcmFrameBytes(a.config.codec, a.config.numberOfChannels);
    run.sampleRate = a.config.sampleRate;
  }
  return true;
};

// One packet from a reader. Dropped when it's from a run or a source that
// was replaced; held back by the seek gate; then through the duration cut.
Demuxer.prototype._sample = function (run, src, kind, s) {
  if (this._run !== run || run.src !== src || run.ended) return;
  // PCM: an MP4 sample is one chunk of the file (all 3 s of a short
  // QuickTime file in one 264600-byte sample). Cut into blocks of 1024
  // sample frames, as FFmpeg does, each with its own time.
  if (kind === 'audio' && run.pcmFrame && s.payload.length > PCM_BLOCK * run.pcmFrame) {
    var step = PCM_BLOCK * run.pcmFrame, n = 0;
    for (var o = 0; o < s.payload.length; o += step, n += PCM_BLOCK) {
      var part = s.payload.subarray(o, Math.min(s.payload.length, o + step));
      var t0 = s.ptsUs + Math.round(n * 1e6 / run.sampleRate);
      var t1 = s.ptsUs + Math.round((n + part.length / run.pcmFrame) * 1e6 / run.sampleRate);
      this._sample(run, src, kind, { payload: part, isKeyframe: true, ptsUs: t0, durationUs: t1 - t0 });
    }
    return;
  }
  s.ts = s.ptsUs - run.offsetUs;
  var g = run.gate;
  if (!g) {
    // Audio is muxed up to ~0.7 s ahead of / behind the video: frames over
    // before the keyframe the gate opened at still come after it opened.
    if (kind === 'audio' && run.audioFrom != null && s.ts + (s.durationUs || 0) <= run.audioFrom) return;
    return this._cut(run, kind, s);
  }
  var T = run.startUs;
  if (!run.hasVideo) {
    // Audio only: from the frame playing at the time — the last one that
    // starts at / before it (a Matroska block often has no duration).
    if (s.ts <= T) { g.heldA = [s]; return; }
    g.heldV = [];
    return this._openGate(run, s);
  }
  if (kind === 'audio') { g.heldA.push(s); return; }
  if (s.isKeyframe && s.ts <= T) {
    // A later keyframe at / before the time: start from it instead.
    g.heldV = [s];
    return;
  }
  if (!g.heldV.length && !s.isKeyframe) return;   // before any keyframe
  if (s.ts <= T) { g.heldV.push(s); return; }
  // Past the time: open from the keyframe held (or this one, when there's
  // no keyframe before the time).
  this._openGate(run, s);
};

/**
 * Let out what the seek gate held (then `next`): the video from its
 * keyframe; the audio from the frame playing at that keyframe's time (an
 * unknown duration: up to the next frame). Also at the end of the stream
 * with the gate still shut — the time past the last frame.
 */
Demuxer.prototype._openGate = function (run, next) {
  var g = run.gate;
  if (!g) return;
  run.gate = null;
  var aud = g.heldA, vids = next && run.hasVideo ? g.heldV.concat([next]) : g.heldV;
  var from = vids.length ? vids[0].ts : run.hasVideo ? -Infinity : run.startUs;
  if (vids.length) run.audioFrom = from;
  for (var i = 0; i < aud.length; i++) {
    var end = aud[i].durationUs ? aud[i].ts + aud[i].durationUs : i + 1 < aud.length ? aud[i + 1].ts : Infinity;
    if (end > from) this._cut(run, 'audio', aud[i]);
  }
  for (var j = 0; j < vids.length; j++) this._cut(run, 'video', vids[j]);
  if (next && !run.hasVideo) this._cut(run, 'audio', next);
};

// opts.duration: nothing from its end on.
Demuxer.prototype._cut = function (run, kind, s) {
  if (run.ended) return;
  var ts = s.ts;
  if (run.endUs != null) {
    if (kind === 'audio') {
      if (run.audioDone) return;
      if (ts >= run.endUs) { run.audioDone = true; return this._checkCut(run); }
    } else {
      if (run.videoDone) return;
      if (ts >= run.endUs) {
        // In decode order a frame shown after the end may be needed by
        // frames shown before it (B-frames): kept until it's clear none
        // follow — a keyframe, or a run of 16 frames all past the end.
        if (s.isKeyframe || run.held.length >= 16) { run.held = []; run.videoDone = true; return this._checkCut(run); }
        run.held.push(s);
        return;
      }
      var held = run.held;
      run.held = [];
      for (var i = 0; i < held.length; i++) this._emitChunk(run, 'video', held[i], held[i].ts);
    }
  }
  this._emitChunk(run, kind, s, ts);
};

Demuxer.prototype._emitChunk = function (run, kind, s, ts) {
  var data = s.payload;
  if (kind === 'audio' && run.swap === 2) data = _swap16(data);
  var init = {
    type: kind === 'audio' || s.isKeyframe ? 'key' : 'delta',
    timestamp: ts,
    data: data,
  };
  if (s.durationUs > 0) init.duration = s.durationUs;
  var meta;
  if (!run.configSent[kind]) {
    run.configSent[kind] = true;
    meta = { decoderConfig: kind === 'video' ? this.videoDecoderConfig : this.audioDecoderConfig };
  }
  this._ee.emit(kind, kind === 'video' ? new EncodedVideoChunk(init) : new EncodedAudioChunk(init), meta);
};

// opts.duration reached for every stream: done.
Demuxer.prototype._checkCut = function (run) {
  if ((!run.hasVideo || run.videoDone) && (!run.hasAudio || run.audioDone)) this._finish(run);
};

// 'end', once per run, and only for the current one.
Demuxer.prototype._finish = function (run) {
  if (run.ended || this._run !== run) return;
  this._openGate(run);
  run.ended = true;
  if (run.close) run.close();
  this._started = false;
  this._ee.emit('end');
};

Demuxer.prototype._stopRun = function () {
  var run = this._run;
  this._run = null;
  if (run) {
    run.stopped = true;
    if (run.close) run.close();
  }
  this._started = false;
};

Demuxer.prototype.stop = function () {
  this._stopRun();
};

/**
 * Get a VideoDecoderConfig — can be passed directly to
 * VideoDecoder.configure(). Call after probe().
 *
 * Shaped like the WebCodecs registrations for the chunks this Demuxer
 * emits: H.264 / H.265 are length-prefixed ('avc' / 'hevc' format) with
 * the avcC / hvcC record as description; AV1 has its av1C when the file
 * does; VP8 / VP9 need none. codec is the full codec string
 * ('avc1.64001f', 'hvc1.1.6.L60.90', 'vp09.00.10.08', 'av01.0.04M.08').
 * Once reading has started it is the reader's (from the container's own
 * codec record); the short name stays on `tracks[i].codec`.
 *
 * Usage:
 *   var demuxer = new Demuxer({ file: 'input.mp4' });
 *   demuxer.probe();
 *   decoder.configure(demuxer.videoDecoderConfig);
 */
Object.defineProperty(Demuxer.prototype, 'videoDecoderConfig', {
  get: function () {
    var info = this._info;
    if (!info || !info.video) return null;
    if (info.video.config) return _copyConfig(info.video.config);
    return {
      codec: info.video.codecString,
      codedWidth: info.video.width,
      codedHeight: info.video.height,
    };
  },
});

/**
 * Get an AudioDecoderConfig. Call after probe(). AAC chunks are raw
 * frames with the AudioSpecificConfig as description; Opus has its
 * OpusHead, Vorbis its three headers (Xiph-laced), FLAC 'fLaC' + its
 * metadata blocks; MP3 and PCM need none. codec is the full codec string
 * ('mp4a.40.2', 'opus', 'pcm-s16', …).
 */
Object.defineProperty(Demuxer.prototype, 'audioDecoderConfig', {
  get: function () {
    var info = this._info;
    if (!info || !info.audio) return null;
    if (info.audio.config) return _copyConfig(info.audio.config);
    return {
      codec: info.audio.codecString,
      sampleRate: info.audio.sampleRate,
      numberOfChannels: info.audio.channels,
    };
  },
});

/**
 * Get track info array. Call after probe().
 */
Object.defineProperty(Demuxer.prototype, 'tracks', {
  get: function () {
    var info = this._info;
    if (!info) return [];
    var out = [];
    if (info.video) out.push({ kind: 'video', codec: info.video.codec, width: info.video.width, height: info.video.height, framerate: info.video.framerate });
    if (info.audio) out.push({ kind: 'audio', codec: info.audio.codec, sampleRate: info.audio.sampleRate, channels: info.audio.channels });
    return out;
  },
});

/**
 * Get duration in seconds. Call after probe().
 */
Object.defineProperty(Demuxer.prototype, 'duration', {
  get: function () { return this._info ? this._info.duration : 0; },
});

/**
 * Seek to a timestamp (seconds, on the timeline the chunks carry). Stops
 * the current run and starts from the last video keyframe at / before it.
 * @param {number} time — target time in seconds
 * @param {object} [opts] — same options as start()
 */
Demuxer.prototype.seek = function (time, opts) {
  var o = {};
  if (opts) for (var k in opts) o[k] = opts[k];
  o.startTime = time;
  // The new run gets its own reader and FFmpeg (made with the options
  // the Demuxer was given — ffmpegPath was lost before).
  this._stopRun();
  this.start(o);
};

function _normalizeCodecName(name) {
  if (!name) return null;
  var n = name.toLowerCase();
  if (n === 'hevc') return 'h265';
  if (n === 'h264' || n === 'avc') return 'h264';
  return n;
}

// Can FileDemuxer read the chosen streams straight from the file?
function _nativeReadable(info) {
  var f = info.format || '';
  var mp4 = /(^|,)(mov|mp4)(,|$)/.test(f), mkv = /(^|,)(matroska|webm)(,|$)/.test(f);
  if (!mp4 && !mkv) return false;
  var v = info.video && NATIVE_VIDEO[info.video.codec], a = info.audio && _audioReadable(info.audio.codec);
  if (!v && !a) return false;
  if (a) {
    var c = info.audio.codec;
    if (mkv && !NATIVE_AUDIO_MKV[c]) return false;
    if (mp4 && !NATIVE_AUDIO_MP4[c] && NATIVE_PCM_MP4[info.audio.tag] !== c) return false;
  }
  return true;
}

// An audio codec this Demuxer delivers as WebCodecs chunks (PCM of any
// kind: converted when it has to be).
function _audioReadable(c) {
  return c === 'aac' || c === 'opus' || c === 'vorbis' || c === 'mp3' || c === 'flac' || /^pcm_/.test(c || '');
}

// PCM: what goes out. { codec: WebCodecs string, convert: FFmpeg encoder
// to convert with (null: copied) } — null when it isn't PCM.
function _pcmOutput(c) {
  if (!/^pcm_/.test(c || '')) return null;
  if (PCM_COPY[c]) return { codec: PCM_COPY[c], convert: null };
  if (/^pcm_f/.test(c)) return { codec: 'pcm-f32', convert: 'pcm_f32le' };
  if (/^pcm_s24/.test(c)) return { codec: 'pcm-s24', convert: 'pcm_s24le' };
  if (/^pcm_s32/.test(c)) return { codec: 'pcm-s32', convert: 'pcm_s32le' };
  // The rest (big-endian 16-bit, 8-bit signed, µ-law / A-law, DVD / Blu-ray
  // PCM, …): 16-bit. (MP4 µ-law / A-law and big-endian 'twos' are read
  // natively instead — 'ulaw' / 'alaw' / swapped — see _adopt.)
  return { codec: 'pcm-s16', convert: 'pcm_s16le' };
}

// ── Codec strings from ffprobe (one spawn: -show_data adds extradata) ──

// ffprobe prints extradata as a hexdump: '00000000: 0000 0167 ...  ascii'.
// The hex column is the fixed 39 characters after the 10-char offset.
function _extradata(s) {
  if (!s.extradata) return null;
  var lines = String(s.extradata).split('\n'), hex = '';
  for (var i = 0; i < lines.length; i++) {
    if (/^[0-9a-f]{8}: /.test(lines[i])) hex += lines[i].substr(10, 39).replace(/ /g, '');
  }
  if (!hex.length || hex.length & 1) return null;
  var out = new Uint8Array(hex.length / 2);
  for (var j = 0; j < out.length; j++) out[j] = parseInt(hex.substr(j * 2, 2), 16);
  return out;
}

function _bitDepth(pixFmt) {
  var m = /p(9|10|12|14|16)(le|be)?$/.exec(pixFmt || '');
  return m ? parseInt(m[1], 10) : 8;
}

function _pad2(n) { return (n < 10 ? '0' : '') + n; }

// VP9 Annex A: smallest level whose max picture size and max luma sample
// rate cover the stream. [level*10, maxLumaPictureSize, maxLumaSampleRate]
var VP9_LEVELS = [
  [10, 36864, 829440], [11, 73728, 2764800], [20, 122880, 4608000],
  [21, 245760, 9216000], [30, 552960, 20736000], [31, 983040, 36864000],
  [40, 2228224, 83558400], [41, 2228224, 160432128], [50, 8912896, 311951360],
  [51, 8912896, 588251136], [52, 8912896, 1176502272], [60, 35651584, 1176502272],
  [61, 35651584, 2353004544], [62, 35651584, 4706009088],
];

function _videoCodecString(s, v) {
  var c = v.codec, ed = _extradata(s);
  if (c === 'h264' || c === 'h265') {
    // extradata is avcC/hvcC (MP4, MKV) or Annex-B parameter sets (TS).
    var bs = ed ? bitstreamFromDescription(ed, c === 'h265') : null;
    var str = bs && bs.paramSets ? codecStringFromAnnexB(bs.paramSets, c === 'h265') : null;
    if (str && c === 'h265') str = 'hvc1' + str.slice(4);   // parameter sets in the hvcC (see _videoConfig)
    return str || c;   // no parameter sets in the container: short name
  }
  if (c === 'av1') {
    // av1C: byte1 = seq_profile(3) | seq_level_idx_0(5);
    //       byte2 = seq_tier_0 | high_bitdepth | twelve_bit | ...
    if (ed && ed.length >= 4 && ed[0] === 0x81) {
      var bd = (ed[2] & 0x40) ? ((ed[2] & 0x20) ? 12 : 10) : 8;
      return 'av01.' + (ed[1] >> 5) + '.' + _pad2(ed[1] & 0x1F) + ((ed[2] & 0x80) ? 'H' : 'M') + '.' + _pad2(bd);
    }
    var ap = { Main: 0, High: 1, Professional: 2 }[s.profile];
    var al = s.level >= 0 && s.level < 32 ? s.level : 31;   // 31 = unconstrained
    return 'av01.' + (ap == null ? 0 : ap) + '.' + _pad2(al) + 'M.' + _pad2(_bitDepth(s.pix_fmt));
  }
  if (c === 'vp9') {
    var vp = /(\d)$/.exec(s.profile || '');
    var pic = (v.width || 0) * (v.height || 0), rate = pic * (v.framerate || 30), lv = 62;
    for (var i = 0; i < VP9_LEVELS.length; i++) {
      if (pic <= VP9_LEVELS[i][1] && rate <= VP9_LEVELS[i][2]) { lv = VP9_LEVELS[i][0]; break; }
    }
    return 'vp09.' + _pad2(vp ? +vp[1] : 0) + '.' + _pad2(lv) + '.' + _pad2(_bitDepth(s.pix_fmt));
  }
  return c;   // 'vp8' and anything without a registered string form
}

/**
 * The VideoDecoderConfig from ffprobe, for before reading starts. Both
 * paths deliver H.264 / H.265 length-prefixed (MP4 / Matroska samples),
 * so the description is the avcC / hvcC record — the file's own, or built
 * from the Annex-B parameter sets an MPEG-TS stream has as extradata (as
 * FFmpeg's Matroska muxer does).
 */
function _videoConfig(s, v) {
  var c = v.codec, ed = _extradata(s);
  var cfg = { codec: v.codecString, codedWidth: v.width, codedHeight: v.height };
  if (c === 'h264' || c === 'h265') {
    var h265 = c === 'h265';
    var rec = ed && (h265 ? parseHvcC(ed) : parseAvcC(ed)) ? ed : null;
    if (!rec && ed) rec = h265 ? buildHvcCFromAnnexB(ed) : buildAvcCFromAnnexB(ed);
    if (rec) {
      var tag = v.tag === 'avc1' || v.tag === 'avc3' || v.tag === 'hvc1' || v.tag === 'hev1' ? v.tag : (h265 ? 'hvc1' : 'avc1');
      var str = h265 ? codecStringFromHvcC(rec, tag) : codecStringFromAvcC(rec, tag);
      if (str) cfg.codec = str;
      cfg.description = rec;
    }
  } else if (c === 'av1' && ed && ed.length >= 4 && ed[0] === 0x81) {
    cfg.description = ed;
  }
  return cfg;
}

var AAC_PROFILE_AOT = { Main: 1, LC: 2, SSR: 3, LTP: 4, 'HE-AAC': 5, 'HE-AACv2': 29, LD: 23, ELD: 39 };

function _audioCodecString(s, c) {
  if (c !== 'aac') return c;   // 'opus', 'mp3', 'flac', 'vorbis', ...
  var ed = _extradata(s), asc = ed ? parseAudioSpecificConfig(ed) : null;
  if (asc && asc.objectType) return 'mp4a.40.' + asc.objectType;
  return 'mp4a.40.' + (AAC_PROFILE_AOT[s.profile] || 2);
}

/**
 * The AudioDecoderConfig from ffprobe, per the WebCodecs registrations:
 *   AAC    — description: the AudioSpecificConfig (an ADTS source has
 *            none: built from its parameters, as FFmpeg does)
 *   Opus   — the OpusHead, when the file has it
 *   Vorbis — identification, comment and setup headers, Xiph-laced
 *            (FFmpeg's extradata for Vorbis is already that form)
 *   FLAC   — 'fLaC' + metadata blocks (FFmpeg keeps the bare STREAMINFO)
 */
function _audioConfig(s, a) {
  var cfg = { codec: a.codecString, sampleRate: a.sampleRate, numberOfChannels: a.channels };
  var c = a.codec, ed = _extradata(s);
  if (c === 'aac') {
    var asc = ed && !(ed[0] === 0xFF && (ed[1] & 0xF0) === 0xF0) && parseAudioSpecificConfig(ed) ? ed : null;
    if (!asc) {
      var aot = AAC_PROFILE_AOT[s.profile] || 2;
      // An ADTS header can only say Main / LC / SSR (HE-AAC rides on LC
      // with implicit SBR at half the output rate).
      var sr = a.sampleRate;
      if (aot === 5 || aot === 29) { aot = 2; sr = a.sampleRate / 2; }
      if (aot > 3 || ADTS_SAMPLE_RATES.indexOf(sr) < 0) aot = 2;
      try { asc = buildAudioSpecificConfig({ profile: aot - 1, sampleRate: sr, channels: a.channels }); } catch (e) { asc = null; }
    }
    if (asc) cfg.description = asc;
  } else if (c === 'opus') {
    if (ed && ed.length >= 19 && String.fromCharCode.apply(null, ed.subarray(0, 8)) === 'OpusHead') cfg.description = ed;
  } else if (c === 'vorbis') {
    if (ed && ed[0] === 2) cfg.description = ed;
  } else if (c === 'flac') {
    if (ed && ed.length >= 4 && String.fromCharCode(ed[0], ed[1], ed[2], ed[3]) === 'fLaC') cfg.description = ed;
    else if (ed && ed.length === 34) {
      var d = new Uint8Array(4 + 4 + 34);
      d.set([0x66, 0x4C, 0x61, 0x43, 0x80, 0, 0, 34]);   // 'fLaC', last block, STREAMINFO, 34 bytes
      d.set(ed, 8);
      cfg.description = d;
    }
  }
  return cfg;
}

// Bytes per sample frame of a WebCodecs PCM codec (0: not PCM).
function _pcmFrameBytes(codec, channels) {
  var w = { 'pcm-u8': 1, 'pcm-s16': 2, 'pcm-s24': 3, 'pcm-s32': 4, 'pcm-f32': 4, ulaw: 1, alaw: 1 }[codec];
  return w && channels ? w * channels : 0;
}

function _copyConfig(c) {
  var o = {};
  for (var k in c) o[k] = c[k];
  return o;
}

// 16-bit samples, big-endian → little-endian (a copy).
function _swap16(b) {
  var o = new Uint8Array(b.length & ~1);
  for (var i = 0; i + 1 < b.length; i += 2) { o[i] = b[i + 1]; o[i + 1] = b[i]; }
  return o;
}

function _parseFramerate(str) {
  if (!str) return 30;
  var parts = str.split('/');
  if (parts.length === 2) return parseInt(parts[0], 10) / parseInt(parts[1], 10);
  return parseFloat(str) || 30;
}

export default Demuxer;
