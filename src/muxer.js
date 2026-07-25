/**
 * Muxer — Write encoded video + audio chunks to a container file.
 *
 * Usage:
 *   var muxer = new Muxer({
 *     file: 'output.mp4',
 *     video: { codec: 'h264', width: 1920, height: 1080, framerate: 30 },
 *     audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
 *   });
 *   muxer.addVideoChunk(encodedVideoChunk);
 *   muxer.addAudioChunk(encodedAudioChunk);
 *   await muxer.finalize();
 *
 * Video is fed through stdin (pipe:0), audio through pipe:3.
 * FFmpeg muxes them into the output container.
 */

import FFmpegProcess from './ffmpeg_process.js';
import EventEmitter from './core/events.js';

var FORMAT_MAP = {
  '.mp4': 'mp4', '.m4v': 'mp4', '.m4a': 'mp4',
  '.webm': 'webm', '.mkv': 'matroska', '.mka': 'matroska',
  '.ogg': 'ogg', '.avi': 'avi', '.ts': 'mpegts',
};

// Input format flag for FFmpeg based on codec
var VIDEO_INPUT_FMT = {
  h264: 'h264', h265: 'hevc', vp8: 'ivf', vp9: 'ivf', av1: 'ivf',
};
var AUDIO_INPUT_FMT = {
  aac: 'adts', opus: 'ogg', vorbis: 'ogg', mp3: 'mp3', flac: 'flac',
  alaw: 'alaw', ulaw: 'mulaw', 'g711-alaw': 'alaw', 'g711-ulaw': 'mulaw',
};

function Muxer(opts) {
  if (!opts) opts = {};
  this._ee = new EventEmitter();
  this._file = opts.file || null;
  this._format = opts.format || _guessFormat(opts.file);
  this._video = opts.video || null;
  this._audio = opts.audio || null;
  this._ffmpeg = new FFmpegProcess(opts);
  this._started = false;
  this._proc = null;
}

Muxer.prototype.on = function (ev, fn) { this._ee.on(ev, fn); };
Muxer.prototype.off = function (ev, fn) { this._ee.off(ev, fn); };

Muxer.prototype.addVideoChunk = function (chunk) {
  if (!this._started) this._start();
  if (chunk.data) this._ffmpeg.write(chunk.data);
};

Muxer.prototype.addAudioChunk = function (chunk) {
  if (!this._started) this._start();
  // Audio goes to pipe:3 (when both tracks) or stdin (audio-only)
  if (this._video && this._audio) {
    if (this._proc && this._proc.stdio[3]) {
      this._proc.stdio[3].write(chunk.data);
    }
  } else {
    this._ffmpeg.write(chunk.data);
  }
};

/**
 * Finalize: close all inputs, wait for FFmpeg to write container trailer.
 */
Muxer.prototype.finalize = function (cb) {
  var self = this;
  if (typeof cb === 'function') {
    self._finishInputs();
    self._ffmpeg.on('close', function () { cb(); });
    return;
  }
  return new Promise(function (resolve) {
    self._finishInputs();
    self._ffmpeg.on('close', function () { resolve(); });
  });
};

Muxer.prototype._finishInputs = function () {
  // End audio pipe:3 first, then stdin
  if (this._video && this._audio && this._proc && this._proc.stdio[3]) {
    this._proc.stdio[3].end();
  }
  this._ffmpeg.endInput();
};

Muxer.prototype.close = function () { this._ffmpeg.stop(); };

Muxer.prototype._start = function () {
  if (this._started) return;
  this._started = true;
  var self = this;

  var args = ['-hide_banner', '-loglevel', 'error', '-y'];
  var hasVideo = !!this._video;
  var hasAudio = !!this._audio;

  // Video input on stdin (pipe:0)
  if (hasVideo) {
    var vc = this._video.codec || 'h264';
    var vFmt = VIDEO_INPUT_FMT[vc] || 'h264';
    args.push('-f', vFmt);
    if (this._video.framerate) args.push('-framerate', String(this._video.framerate));
    args.push('-i', 'pipe:0');
  }

  // Audio input on pipe:3 (dual track) or pipe:0 (audio only)
  if (hasAudio) {
    var ac = this._audio.codec || 'aac';
    var aFmt = AUDIO_INPUT_FMT[ac] || 'adts';
    if (hasVideo) {
      args.push('-f', aFmt, '-i', 'pipe:3');
    } else {
      args.push('-f', aFmt, '-i', 'pipe:0');
    }
  }

  // Copy all streams to output
  args.push('-c', 'copy');
  if (this._format) args.push('-f', this._format);
  if (this._file) {
    args.push(this._file);
  } else {
    args.push('pipe:1');
  }

  // stdio: [stdin=video, stdout, stderr, pipe3=audio]
  var stdio;
  if (hasVideo && hasAudio) {
    stdio = ['pipe', this._file ? 'ignore' : 'pipe', 'pipe', 'pipe'];
  } else {
    stdio = ['pipe', this._file ? 'ignore' : 'pipe', 'pipe'];
  }

  this._proc = self._ffmpeg.start(args, stdio);
  self._ffmpeg.on('error', function (e) { self._ee.emit('error', e); });
};

function _guessFormat(file) {
  if (!file) return 'mp4';
  var ext = file.substring(file.lastIndexOf('.')).toLowerCase();
  return FORMAT_MAP[ext] || 'mp4';
}

export default Muxer;
