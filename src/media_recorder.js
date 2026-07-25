/**
 * MediaRecorder — Browser-compatible recording API.
 *
 * Two internal modes:
 *   1. Single stream (video OR audio) → MediaEncoder with pipe:3 → real-time streaming
 *   2. Video + Audio → separate VideoEncoder + AudioEncoder + Muxer → real-time file output
 *
 * Mode 2 solves the MPEG-TS dual-input buffering problem: each encoder is its own
 * FFmpeg process (no interleaving delay), and the Muxer writes to a seekable file
 * where FFmpeg can interleave properly.
 *
 * Usage:
 *   // Streaming (single stream):
 *   var rec = new MediaRecorder(stream, { mimeType: 'video/mp4; codecs=h264' });
 *   rec.ondataavailable = function(e) { chunks.push(e.data); };
 *
 *   // File output (video + audio, real-time writing):
 *   var rec = new MediaRecorder(stream, {
 *     mimeType: 'video/mp4; codecs=h264,aac',
 *     outputFile: 'recording.ts',
 *   });
 *   rec.ondataavailable = function(e) { console.log(e.bytesWritten, 'bytes'); };
 */

import EventEmitter from './core/events.js';
import { concat } from './core/bytes.js';
import MediaEncoder from './media_encoder.js';
import VideoEncoder from './video_encoder.js';
import AudioEncoder from './audio_encoder.js';
import Muxer from './muxer.js';

var MIME_CODEC_MAP = {
  'video/webm; codecs=vp9,opus':   { video: 'vp9',  audio: 'opus', container: 'fmp4' },
  'video/webm; codecs=vp9':        { video: 'vp9',  audio: null,   container: 'ivf' },
  'video/webm; codecs=vp8,opus':   { video: 'vp8',  audio: 'opus', container: 'fmp4' },
  'video/webm; codecs=vp8':        { video: 'vp8',  audio: null,   container: 'ivf' },
  'video/mp4; codecs=h264,aac':    { video: 'h264', audio: 'aac',  container: 'fmp4' },
  'video/mp4; codecs=h264':        { video: 'h264', audio: null,   container: 'fmp4' },
  'video/mp4; codecs=h265,aac':    { video: 'h265', audio: 'aac',  container: 'fmp4' },
  'video/mp4; codecs=av1,opus':    { video: 'av1',  audio: 'opus', container: 'fmp4' },
  'audio/webm; codecs=opus':       { video: null,   audio: 'opus', container: 'ogg' },
  'audio/mp4; codecs=aac':         { video: null,   audio: 'aac',  container: 'adts' },
};

var DEFAULT_MIME = 'video/webm; codecs=vp9,opus';

/**
 * @param {MediaStream} stream
 * @param {object} [options]
 * @param {string} [options.mimeType]
 * @param {string} [options.outputFile]           — file path for real-time disk output (video+audio)
 * @param {number} [options.videoBitsPerSecond]
 * @param {number} [options.audioBitsPerSecond]
 * @param {number} [options.bitsPerSecond]
 */
function MediaRecorder(stream, options) {
  if (!stream) throw new TypeError('MediaRecorder: MediaStream required');
  if (!options) options = {};

  this._ee = new EventEmitter();
  this.stream = stream;
  this.mimeType = options.mimeType || DEFAULT_MIME;
  this.state = 'inactive';
  this.videoBitsPerSecond = options.videoBitsPerSecond || options.bitsPerSecond || 2000000;
  this.audioBitsPerSecond = options.audioBitsPerSecond || 128000;
  this.outputFile = options.outputFile || null;

  // Internal state
  this._encoder = null;       // MediaEncoder (single-stream mode)
  this._videoEncoder = null;  // VideoEncoder (dual-stream mode)
  this._audioEncoder = null;  // AudioEncoder (dual-stream mode)
  this._muxer = null;         // Muxer (dual-stream mode)
  this._mode = null;          // 'pipe' or 'muxer'

  this._timeslice = 0;
  this._timesliceTimer = null;
  this._chunks = [];
  this._bytesWritten = 0;
  this._videoHandler = null;
  this._audioHandler = null;

  // Event handler properties (browser-compatible)
  this.ondataavailable = null;
  this.onstop = null;
  this.onstart = null;
  this.onerror = null;
  this.onpause = null;
  this.onresume = null;
}

MediaRecorder.prototype.addEventListener = function (type, listener) { this._ee.on(type, listener); };
MediaRecorder.prototype.removeEventListener = function (type, listener) { this._ee.off(type, listener); };

MediaRecorder.prototype._dispatch = function (type, data) {
  this._ee.emit(type, data);
  var handler = this['on' + type];
  if (typeof handler === 'function') handler(data);
};

/**
 * Start recording.
 * @param {number} [timeslice] — milliseconds between ondataavailable events
 */
MediaRecorder.prototype.start = function (timeslice) {
  if (this.state !== 'inactive') {
    throw (typeof DOMException !== 'undefined')
      ? new DOMException('MediaRecorder: already recording', 'InvalidStateError')
      : new Error('MediaRecorder: already recording');
  }

  var self = this;
  var codecInfo = _parseMime(this.mimeType);
  var videoTracks = this.stream.getVideoTracks();
  var audioTracks = this.stream.getAudioTracks();
  var hasVideo = codecInfo.video && videoTracks.length;
  var hasAudio = codecInfo.audio && audioTracks.length;

  var vSettings = hasVideo && videoTracks[0].getSettings ? videoTracks[0].getSettings() : {};
  var aSettings = hasAudio && audioTracks[0].getSettings ? audioTracks[0].getSettings() : {};

  // Dual-stream (video + audio) with outputFile → separate encoders + Muxer
  // This avoids the MPEG-TS dual-input pipe buffering problem.
  if (hasVideo && hasAudio && this.outputFile) {
    this._mode = 'muxer';
    this._startMuxerMode(codecInfo, videoTracks, audioTracks, vSettings, aSettings);
  }
  // Single stream or no outputFile → MediaEncoder with pipe:3
  else {
    this._mode = 'pipe';
    this._startPipeMode(codecInfo, videoTracks, audioTracks, hasVideo, hasAudio, vSettings, aSettings);
  }

  this.state = 'recording';
  this._bytesWritten = 0;

  // Timeslice: fire ondataavailable periodically
  if (timeslice && timeslice > 0) {
    this._timeslice = timeslice;
    this._timesliceTimer = setInterval(function () {
      if (self._mode === 'pipe') {
        self._flushChunks();
      } else {
        // Muxer mode: report progress
        self._dispatch('dataavailable', {
          data: null,
          bytesWritten: self._bytesWritten,
          timecode: Date.now(),
        });
      }
    }, timeslice);
  }

  this._dispatch('start', {});
};

// ── Pipe mode: single MediaEncoder with pipe:3 ──

MediaRecorder.prototype._startPipeMode = function (codecInfo, videoTracks, audioTracks, hasVideo, hasAudio, vSettings, aSettings) {
  var self = this;

  var encOpts = {
    container: codecInfo.container,
    error: function (e) { self._dispatch('error', { error: e }); },
  };

  if (hasVideo) {
    encOpts.video = {
      codec: codecInfo.video,
      width: vSettings.width || 1280,
      height: vSettings.height || 720,
      framerate: vSettings.frameRate || 30,
      bitrate: self.videoBitsPerSecond,
    };
  }
  if (hasAudio) {
    encOpts.audio = {
      codec: codecInfo.audio,
      sampleRate: aSettings.sampleRate || 48000,
      numberOfChannels: aSettings.channelCount || 2,
      bitrate: self.audioBitsPerSecond,
    };
  }

  this._encoder = new MediaEncoder(encOpts);
  this._encoder.on('data', function (chunk) { self._onData(chunk); });
  this._chunks = [];

  this._wireTrackHandlers(videoTracks, audioTracks, hasVideo, hasAudio, 'pipe');
};

// ── Muxer mode: separate VideoEncoder + AudioEncoder + Muxer ──

MediaRecorder.prototype._startMuxerMode = function (codecInfo, videoTracks, audioTracks, vSettings, aSettings) {
  var self = this;
  var vWidth = vSettings.width || 1280;
  var vHeight = vSettings.height || 720;
  var vFps = vSettings.frameRate || 30;

  // Muxer → writes interleaved output to file
  this._muxer = new Muxer({
    output: this.outputFile,
    video: { codec: codecInfo.video, width: vWidth, height: vHeight },
    audio: { codec: codecInfo.audio, sampleRate: aSettings.sampleRate || 48000 },
  });

  // VideoEncoder → encoded chunks → Muxer
  this._videoEncoder = new VideoEncoder({
    output: function (chunk, metadata) {
      self._bytesWritten += chunk.byteLength || 0;
      if (self._muxer) self._muxer.addVideoChunk(chunk, metadata);
    },
    error: function (e) { self._dispatch('error', { error: e }); },
  });

  this._videoEncoder.configure({
    codec: codecInfo.video,
    width: vWidth,
    height: vHeight,
    framerate: vFps,
    bitrate: self.videoBitsPerSecond,
    latencyMode: 'realtime',
  });

  // AudioEncoder → encoded chunks → Muxer
  this._audioEncoder = new AudioEncoder({
    output: function (chunk, metadata) {
      self._bytesWritten += chunk.byteLength || 0;
      if (self._muxer) self._muxer.addAudioChunk(chunk, metadata);
    },
    error: function (e) { self._dispatch('error', { error: e }); },
  });

  this._audioEncoder.configure({
    codec: codecInfo.audio,
    sampleRate: aSettings.sampleRate || 48000,
    numberOfChannels: aSettings.channelCount || 2,
    bitrate: self.audioBitsPerSecond,
  });

  this._wireTrackHandlers(videoTracks, audioTracks, true, true, 'muxer');
};

// ── Wire track events to encoders ──

MediaRecorder.prototype._wireTrackHandlers = function (videoTracks, audioTracks, hasVideo, hasAudio, mode) {
  var self = this;

  if (hasVideo && videoTracks.length) {
    this._videoHandler = function (frame) {
      if (self.state !== 'recording') return;
      if (mode === 'muxer' && self._videoEncoder) {
        self._videoEncoder.encode(frame);
      } else if (mode === 'pipe' && self._encoder) {
        self._encoder.writeVideoFrame(frame);
      }
    };
    videoTracks[0].on('frame', this._videoHandler);
  }

  if (hasAudio && audioTracks.length) {
    this._audioHandler = function (audioData) {
      if (self.state !== 'recording') return;
      if (mode === 'muxer' && self._audioEncoder) {
        self._audioEncoder.encode(audioData);
      } else if (mode === 'pipe' && self._encoder) {
        self._encoder.writeAudioData(audioData);
      }
    };
    audioTracks[0].on('data', this._audioHandler);
  }
};

/**
 * Stop recording.
 */
MediaRecorder.prototype.stop = function () {
  if (this.state === 'inactive') return;

  var self = this;
  this.state = 'inactive';
  this._detachTracks();

  if (this._timesliceTimer) {
    clearInterval(this._timesliceTimer);
    this._timesliceTimer = null;
  }

  if (this._mode === 'muxer') {
    // Flush both encoders, then flush muxer
    var pending = 2;
    function onEncoderDone() {
      pending--;
      if (pending <= 0) {
        if (self._muxer) {
          self._muxer.finalize(function () {
            self._cleanup();
            self._dispatch('stop', {});
          });
        } else {
          self._cleanup();
          self._dispatch('stop', {});
        }
      }
    }
    if (self._videoEncoder) self._videoEncoder.flush().then(onEncoderDone);
    else onEncoderDone();
    if (self._audioEncoder) self._audioEncoder.flush().then(onEncoderDone);
    else onEncoderDone();
  } else {
    // Pipe mode: flush MediaEncoder
    if (this._encoder) {
      this._encoder.flush(function () {
        self._flushChunks();
        self._cleanup();
        self._dispatch('stop', {});
      });
    } else {
      self._dispatch('stop', {});
    }
  }
};

/**
 * Pause recording.
 */
MediaRecorder.prototype.pause = function () {
  if (this.state !== 'recording') return;
  this.state = 'paused';
  this._dispatch('pause', {});
};

/**
 * Resume recording.
 */
MediaRecorder.prototype.resume = function () {
  if (this.state !== 'paused') return;
  this.state = 'recording';
  this._dispatch('resume', {});
};

/**
 * Request current data (triggers ondataavailable).
 */
MediaRecorder.prototype.requestData = function () {
  if (this._mode === 'pipe') this._flushChunks();
};

MediaRecorder.prototype._onData = function (data) {
  this._chunks.push(data instanceof Uint8Array ? data : new Uint8Array(data));
};

MediaRecorder.prototype._flushChunks = function () {
  if (!this._chunks.length) return;
  var data = concat(this._chunks);
  this._chunks = [];
  this._bytesWritten += data.length;
  this._dispatch('dataavailable', { data: data, bytesWritten: this._bytesWritten, timecode: Date.now() });
};

MediaRecorder.prototype._detachTracks = function () {
  var videoTracks = this.stream.getVideoTracks();
  var audioTracks = this.stream.getAudioTracks();
  if (this._videoHandler && videoTracks.length) {
    videoTracks[0].off('frame', this._videoHandler);
    this._videoHandler = null;
  }
  if (this._audioHandler && audioTracks.length) {
    audioTracks[0].off('data', this._audioHandler);
    this._audioHandler = null;
  }
};

MediaRecorder.prototype._cleanup = function () {
  if (this._encoder) { this._encoder.close(); this._encoder = null; }
  if (this._videoEncoder) { this._videoEncoder.close(); this._videoEncoder = null; }
  if (this._audioEncoder) { this._audioEncoder.close(); this._audioEncoder = null; }
  this._muxer = null;
};

/**
 * Check if a MIME type is supported.
 * @param {string} mimeType
 * @returns {boolean}
 */
MediaRecorder.isTypeSupported = function (mimeType) {
  var normalized = String(mimeType || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (MIME_CODEC_MAP[normalized]) return true;
  if (normalized === 'video/webm' || normalized === 'video/mp4') return true;
  if (normalized === 'audio/webm' || normalized === 'audio/mp4') return true;
  return false;
};

// ── Helpers ──

function _parseMime(mimeType) {
  var normalized = String(mimeType || '').toLowerCase().replace(/\s+/g, ' ').trim();
  var mapped = MIME_CODEC_MAP[normalized];
  if (mapped) return mapped;
  if (normalized.indexOf('vp9') >= 0) return MIME_CODEC_MAP[DEFAULT_MIME];
  if (normalized.indexOf('h264') >= 0) return { video: 'h264', audio: 'aac', container: 'ts' };
  return MIME_CODEC_MAP[DEFAULT_MIME];
}

export default MediaRecorder;
