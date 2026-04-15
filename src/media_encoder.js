/**
 * MediaEncoder — Combined video + audio encoder in a single FFmpeg process.
 *
 * Unlike VideoEncoder/AudioEncoder (which are separate processes per WebCodecs spec),
 * MediaEncoder runs ONE FFmpeg with:
 *   pipe:0  → raw video input (I420)
 *   pipe:4  → raw audio input (s16le)
 *   pipe:3  → encoded output (container with both tracks)
 *
 * Use cases:
 *   - fMP4/MPEG-TS output with interleaved audio+video
 *   - Single-process encoding (lower resource usage)
 *   - Real-time streaming with synchronized A/V
 *
 * Usage:
 *   var enc = new MediaEncoder({
 *     video: { codec: 'h264', width: 1280, height: 720, framerate: 30 },
 *     audio: { codec: 'aac', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 },
 *     container: 'ts',  // 'ts', 'fmp4', 'ivf', 'adts'
 *     output: function(data) { ... },
 *     error: function(e) { ... },
 *   });
 *
 *   enc.writeVideoFrame(videoFrame);
 *   enc.writeAudioData(audioData);
 *   enc.flush(function() { ... });
 */

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { getVideoCodec } from './codecs.js';
import { getAudioCodec } from './codecs.js';
import { getContainer, getContainerFormat, getContainerExtra } from './containers.js';

function MediaEncoder(opts) {
  if (!opts) opts = {};

  this._ee = new EventEmitter();
  this._output = opts.output || function () {};
  this._error = opts.error || function () {};

  this._videoConfig = opts.video || null;
  this._audioConfig = opts.audio || null;
  this._containerName = opts.container || (this._videoConfig ? 'ts' : 'adts');
  this._ffmpegPath = opts.ffmpegPath || 'ffmpeg';

  this._proc = null;
  this._started = false;
  this._videoStdin = null;   // pipe:0
  this._audioStdin = null;   // pipe:4

  // Backpressure tracking
  this._videoDrainCb = null;
  this._audioDrainCb = null;
}

MediaEncoder.prototype.on = function (ev, fn) { this._ee.on(ev, fn); };
MediaEncoder.prototype.off = function (ev, fn) { this._ee.off(ev, fn); };

/**
 * Write a raw video frame (I420/YUV420p).
 * @param {VideoFrame} frame — VideoFrame with .data buffer
 * @returns {boolean} — false if backpressure (call onVideoDrain)
 */
MediaEncoder.prototype.writeVideoFrame = function (frame) {
  if (!this._videoConfig) { this._error(new Error('MediaEncoder: no video configured')); return false; }
  if (!this._started) this._start();
  if (!this._videoStdin || !this._videoStdin.writable) return false;
  return this._videoStdin.write(frame.data || frame.buffer || frame);
};

/**
 * Write raw audio data (s16le).
 * @param {AudioData} audioData — AudioData with .data buffer
 * @returns {boolean} — false if backpressure (call onAudioDrain)
 */
MediaEncoder.prototype.writeAudioData = function (audioData) {
  if (!this._audioConfig) { this._error(new Error('MediaEncoder: no audio configured')); return false; }
  if (!this._started) this._start();
  if (!this._audioStdin || !this._audioStdin.writable) return false;
  return this._audioStdin.write(audioData.data || audioData.samples || audioData);
};

/** Backpressure: called when video stdin drains. */
MediaEncoder.prototype.onVideoDrain = function (cb) {
  if (this._videoStdin) this._videoStdin.once('drain', cb);
  else this._videoDrainCb = cb;
};

/** Backpressure: called when audio stdin drains. */
MediaEncoder.prototype.onAudioDrain = function (cb) {
  if (this._audioStdin) this._audioStdin.once('drain', cb);
  else this._audioDrainCb = cb;
};

/**
 * Flush: end all inputs, wait for FFmpeg to finish.
 */
MediaEncoder.prototype.flush = function (cb) {
  var self = this;
  if (!this._started || !this._proc) {
    if (typeof cb === 'function') { cb(); return; }
    return Promise.resolve();
  }

  if (typeof cb !== 'function') {
    return new Promise(function (resolve) { self.flush(resolve); });
  }

  this._proc.on('close', function () { if (cb) cb(); });

  // End audio first (pipe:4), then video (pipe:0)
  if (this._audioStdin && this._audioStdin.writable) {
    try { this._audioStdin.end(); } catch (e) {}
  }
  if (this._videoStdin && this._videoStdin.writable) {
    try { this._videoStdin.end(); } catch (e) {}
  }
};

MediaEncoder.prototype.close = function () {
  if (this._proc) {
    try { this._proc.kill('SIGTERM'); } catch (e) {}
    setTimeout(function () {
      try { this._proc.kill('SIGKILL'); } catch (e) {}
    }.bind(this), 2000);
  }
  this._proc = null;
  this._started = false;
  this._videoStdin = null;
  this._audioStdin = null;
};

MediaEncoder.prototype._start = function () {
  if (this._started) return;
  this._started = true;
  var self = this;

  var vc = this._videoConfig;
  var ac = this._audioConfig;
  var containerDef = getContainer(this._containerName);

  var args = [
    '-loglevel', 'warning',
    '-fflags', 'nobuffer', '-flags', 'low_delay',
    '-probesize', '32', '-analyzeduration', '0',
  ];

  // ── Video input on pipe:0 (stdin) ──
  if (vc) {
    var videoCodecDef = getVideoCodec(vc.codec, vc);
    if (!videoCodecDef) { self._error(new Error('Unknown video codec: ' + vc.codec)); return; }
    args.push(
      '-f', 'rawvideo',
      '-pixel_format', videoCodecDef.pixFmt || 'yuv420p',
      '-video_size', vc.width + 'x' + vc.height,
      '-framerate', String(vc.framerate || 30),
      '-i', 'pipe:0'
    );
  }

  // ── Audio input on pipe:4 ──
  if (ac) {
    var fmt = (ac.format === 'f32' || ac.format === 'f32le') ? 'f32le' : 's16le';
    args.push(
      '-f', fmt,
      '-ar', String(ac.sampleRate || 48000),
      '-ac', String(ac.numberOfChannels || ac.channels || 2),
      '-i', 'pipe:4'
    );
  }

  // ── Map streams ──
  if (vc) {
    args.push('-map', '0:v:0');
    var vCodecDef = getVideoCodec(vc.codec, vc);
    Array.prototype.push.apply(args, vCodecDef.args);
    args.push('-pix_fmt', vCodecDef.pixFmt || 'yuv420p');
  }
  if (ac) {
    var audioIdx = vc ? 1 : 0;
    args.push('-map', audioIdx + ':a:0');
    var aCodecDef = getAudioCodec(ac.codec, ac);
    if (aCodecDef) Array.prototype.push.apply(args, aCodecDef.args);
  }

  // ── Output container → pipe:3 ──
  if (containerDef) {
    args.push('-f', getContainerFormat(containerDef, vc ? vc.codec : ac.codec));
    Array.prototype.push.apply(args, getContainerExtra(containerDef, vc ? vc.codec : ac.codec));
  }
  // Force immediate output: don't buffer for interleaving
  args.push('-flush_packets', '1', '-max_interleave_delta', '0');
  args.push('pipe:3');

  // ── stdio: [stdin=video, stdout, stderr, pipe3=output, pipe4=audio] ──
  var stdio = ['pipe', 'ignore', 'pipe', 'pipe'];
  if (ac) stdio.push('pipe');  // pipe:4 for audio

  var proc = spawn(self._ffmpegPath, args, { stdio: stdio });
  self._proc = proc;

  self._videoStdin = vc ? proc.stdin : null;
  self._audioStdin = ac ? proc.stdio[4] : null;

  // Wire backpressure callbacks
  if (self._videoStdin && self._videoDrainCb) {
    self._videoStdin.once('drain', self._videoDrainCb);
    self._videoDrainCb = null;
  }
  if (self._audioStdin && self._audioDrainCb) {
    self._audioStdin.once('drain', self._audioDrainCb);
    self._audioDrainCb = null;
  }

  // Suppress stdin errors
  if (self._videoStdin) self._videoStdin.on('error', function () {});
  if (self._audioStdin) self._audioStdin.on('error', function () {});

  // ── Output: pipe:3 → reader → output callback ──
  if (containerDef && containerDef.createReader) {
    var readerOpts = {};
    if (vc) { readerOpts.codec = vc.codec; readerOpts.fps = vc.framerate || 30; }
    if (ac) { readerOpts.sampleRate = ac.sampleRate || 48000; }
    var reader = containerDef.createReader(readerOpts);

    reader.on('video', function (f) { self._ee.emit('video', f); self._output(f); });
    reader.on('audio', function (f) { self._ee.emit('audio', f); self._output(f); });
    reader.on('init', function (info) { self._ee.emit('init', info); });
    reader.on('segment', function (seg) { self._ee.emit('segment', seg); });

    proc.stdio[3].on('data', function (chunk) {
      reader.feed(chunk);
      self._ee.emit('data', chunk);
    });
  } else {
    // Raw passthrough
    proc.stdio[3].on('data', function (chunk) { self._output(chunk); self._ee.emit('data', chunk); });
  }

  proc.on('error', function (e) { self._error(e); self._ee.emit('error', e); });
  proc.on('close', function (code) { self._started = false; self._ee.emit('close', code); });

  // stderr
  if (proc.stderr) {
    proc.stderr.on('data', function (chunk) {
      var msg = chunk.toString().trim();
      if (msg) self._ee.emit('ffmpeg:log', msg);
    });
  }
};

Object.defineProperty(MediaEncoder.prototype, 'running', {
  get: function () { return this._started; },
});

export default MediaEncoder;
