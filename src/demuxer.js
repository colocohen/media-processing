/**
 * Demuxer — Read media files and emit individual encoded chunks.
 *
 * Usage:
 *   var demuxer = new Demuxer({ file: 'input.mp4' });
 *   var info = demuxer.probe();
 *   demuxer.on('video', function(chunk, metadata) { ... }); // EncodedVideoChunk per frame
 *   demuxer.on('audio', function(chunk) { ... });            // EncodedAudioChunk per frame
 *   demuxer.on('end', function() { ... });
 *   demuxer.start();
 *
 * Video is output as Annex-B (H.264/H.265) or IVF (VP8/VP9/AV1) to pipe:3,
 * then parsed by our readers into individual frames.
 * Audio is output as ADTS/OGG/raw to stdout (pipe:1), then parsed similarly.
 */

import FFmpegProcess from './ffmpeg_process.js';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { EncodedVideoChunk, EncodedAudioChunk } from './encoded_chunk.js';
import { getContainer, getDefaultContainer } from './containers.js';
import { extractParameterSets } from './reader_annexb.js';
import { extractSequenceHeader } from './reader_ivf.js';
import FrameQueue from './frame_queue.js';

function Demuxer(opts) {
  if (!opts) opts = {};
  this._ee = new EventEmitter();
  this._file = opts.file || null;
  this._ffmpeg = new FFmpegProcess(opts);
  this._started = false;
  this._info = null;
  this._videoDescription = null;  // SPS/PPS (H.264) or SeqHdr (AV1)
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
      '-show_streams', '-show_format',
      '-of', 'json', this._file,
    ], { encoding: 'utf8', timeout: 10000 });

    var json = JSON.parse(out);
    var info = { video: null, audio: null, duration: 0 };

    if (json.format && json.format.duration) {
      info.duration = parseFloat(json.format.duration);
    }

    var streams = json.streams || [];
    for (var i = 0; i < streams.length; i++) {
      var s = streams[i];
      if (s.codec_type === 'video' && !info.video) {
        info.video = {
          codec: _normalizeCodecName(s.codec_name),
          width: s.width || s.coded_width,
          height: s.height || s.coded_height,
          framerate: _parseFramerate(s.r_frame_rate),
        };
      } else if (s.codec_type === 'audio' && !info.audio) {
        info.audio = {
          codec: _normalizeCodecName(s.codec_name),
          sampleRate: parseInt(s.sample_rate, 10),
          channels: s.channels,
        };
      }
    }

    this._info = info;
    return info;
  } catch (e) {
    return null;
  }
};

/**
 * Start demuxing. Emits 'video', 'audio', 'end', 'error' events.
 */
Demuxer.prototype.start = function (opts) {
  if (this._started) return;
  this._started = true;
  if (!opts) opts = {};

  var self = this;
  var info = this.probe();
  if (!info) { self._ee.emit('error', new Error('Could not probe file')); return; }

  var hasVideo = !!info.video;
  var hasAudio = !!info.audio;
  var args = ['-hide_banner', '-loglevel', 'error'];

  if (opts.startTime) args.push('-ss', String(opts.startTime));
  args.push('-i', this._file);
  if (opts.duration) args.push('-t', String(opts.duration));

  // Video → pipe:3 (codec copy in native container)
  if (hasVideo) {
    var vc = info.video.codec;
    if (vc === 'h264') args.push('-map', '0:v:0', '-c:v', 'copy', '-bsf:v', 'h264_mp4toannexb', '-f', 'h264', 'pipe:3');
    else if (vc === 'h265') args.push('-map', '0:v:0', '-c:v', 'copy', '-bsf:v', 'hevc_mp4toannexb', '-f', 'hevc', 'pipe:3');
    else if (vc === 'vp8' || vc === 'vp9' || vc === 'av1') args.push('-map', '0:v:0', '-c:v', 'copy', '-f', 'ivf', 'pipe:3');
    else args.push('-map', '0:v:0', '-c:v', 'copy', '-f', 'rawvideo', 'pipe:3');
  }

  // Audio → pipe:1 (stdout)
  if (hasAudio) {
    var ac = info.audio.codec;
    if (ac === 'aac') args.push('-map', '0:a:0', '-c:a', 'copy', '-f', 'adts', 'pipe:1');
    else if (ac === 'opus' || ac === 'vorbis') args.push('-map', '0:a:0', '-c:a', 'copy', '-f', 'ogg', 'pipe:1');
    else if (ac === 'mp3') args.push('-map', '0:a:0', '-c:a', 'copy', '-f', 'mp3', 'pipe:1');
    else args.push('-map', '0:a:0', '-c:a', 'copy', '-f', 'wav', 'pipe:1');
  }

  // Determine stdio layout
  var stdio = ['ignore', hasAudio ? 'pipe' : 'ignore', 'pipe', hasVideo ? 'pipe' : 'ignore'];
  self._ffmpeg.start(args, stdio);

  // Wire video reader on pipe:3
  if (hasVideo) {
    var vContainer = getDefaultContainer(info.video.codec);
    var vContainerDef = getContainer(vContainer);
    if (vContainerDef && vContainerDef.createReader) {
      var vReader = vContainerDef.createReader({ codec: info.video.codec, fps: info.video.framerate });
      vReader.on('video', function (f) {
        // Extract description from first keyframe
        if (f.isKeyframe && !self._videoDescription) {
          var vc = info.video.codec;
          if (vc === 'h264' || vc === 'h265') {
            self._videoDescription = extractParameterSets(f.payload, vc === 'h265');
          } else if (vc === 'av1') {
            self._videoDescription = extractSequenceHeader(f.payload);
          } else if (vc === 'vp9' || vc === 'vp8') {
            // VP8/VP9 don't need description for decoder config
            self._videoDescription = null;
          }
        }
        self._ee.emit('video', new EncodedVideoChunk({
          type: f.isKeyframe ? 'key' : 'delta',
          timestamp: f.ptsUs,
          data: f.payload,
        }));
      });
      self._ffmpeg.on('data', function (chunk) { vReader.feed(chunk); });
    }
  }

  // Wire audio reader on stdout
  if (hasAudio) {
    var aContainer = getDefaultContainer(info.audio.codec);
    var aContainerDef = getContainer(aContainer);
    if (aContainerDef && aContainerDef.createReader) {
      var aReader = aContainerDef.createReader({ sampleRate: info.audio.sampleRate });
      aReader.on('audio', function (f) {
        self._ee.emit('audio', new EncodedAudioChunk({
          type: 'key',
          timestamp: f.ptsUs || 0,
          data: f.payload,
        }));
      });
      self._ffmpeg.on('stdout', function (chunk) { aReader.feed(chunk); });
    } else {
      // No reader — raw passthrough in fixed chunks (G.711, PCM, etc.)
      var sr = info.audio.sampleRate || 48000;
      var ch = info.audio.channels || 2;
      var bps = 2; // s16le
      var chunkBytes = Math.floor(sr / 100) * ch * bps;
      var aIdx = 0;
      var fq = new FrameQueue(chunkBytes, function (buf) {
        self._ee.emit('audio', new EncodedAudioChunk({
          type: 'key',
          timestamp: Math.round(aIdx * chunkBytes * 1e6 / (sr * ch * bps)),
          data: buf,
        }));
        aIdx++;
      });
      self._ffmpeg.on('stdout', function (chunk) { fq.push(chunk); });
    }
  }

  // End
  var videoDone = !hasVideo;
  var audioDone = !hasAudio;
  function checkEnd() { if (videoDone && audioDone) self._ee.emit('end'); }

  if (hasVideo) {
    self._ffmpeg.on('output_end', function () { videoDone = true; checkEnd(); });
  }
  if (hasAudio) {
    self._ffmpeg.on('stdout_end', function () { audioDone = true; checkEnd(); });
  }

  self._ffmpeg.on('close', function () {
    videoDone = true; audioDone = true; checkEnd();
  });

  self._ffmpeg.on('error', function (e) { self._ee.emit('error', e); });
};

Demuxer.prototype.stop = function () {
  this._ffmpeg.stop();
  this._started = false;
};

/**
 * Get a VideoDecoder-compatible config. Call after probe() or after first keyframe.
 * Can be passed directly to VideoDecoder.configure().
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
    var cfg = {
      codec: info.video.codec,
      codedWidth: info.video.width,
      codedHeight: info.video.height,
    };
    if (this._videoDescription) cfg.description = this._videoDescription;
    return cfg;
  },
});

/**
 * Get an AudioDecoder-compatible config. Call after probe().
 */
Object.defineProperty(Demuxer.prototype, 'audioDecoderConfig', {
  get: function () {
    var info = this._info;
    if (!info || !info.audio) return null;
    return {
      codec: info.audio.codec,
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
 * Seek to a timestamp (seconds). Stops current FFmpeg and restarts.
 * @param {number} time — target time in seconds
 * @param {object} [opts] — same options as start()
 */
Demuxer.prototype.seek = function (time, opts) {
  if (!opts) opts = {};
  if (this._started) {
    this._ffmpeg.stop();
    this._started = false;
    this._ffmpeg = new FFmpegProcess();
  }
  opts.startTime = time;
  this.start(opts);
};

function _normalizeCodecName(name) {
  if (!name) return null;
  var n = name.toLowerCase();
  if (n === 'hevc') return 'h265';
  if (n === 'h264' || n === 'avc') return 'h264';
  return n;
}

function _parseFramerate(str) {
  if (!str) return 30;
  var parts = str.split('/');
  if (parts.length === 2) return parseInt(parts[0], 10) / parseInt(parts[1], 10);
  return parseFloat(str) || 30;
}

export default Demuxer;
