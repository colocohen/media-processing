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
 *     container: 'ts',  // 'ts', 'fmp4', 'ivf', 'adts', 'ogg'
 *     output: function(data) { ... },
 *     error: function(e) { ... },
 *   });
 *
 *   enc.writeVideoFrame(videoFrame);
 *   enc.writeAudioData(audioData);
 *   enc.flush(function(err) { ... });   // or: await enc.flush()
 *
 * Frames are converted to what FFmpeg is told it gets: VideoFrames to
 * I420 (copyTo), AudioData to interleaved s16 (or f32 when audio.format
 * is 'f32'). Their visible size / sample rate / channel count must match
 * the configuration.
 *
 * Instead of a `container` from containers.js, `format` names any FFmpeg
 * muxer, with `formatArgs` for its options; its bytes are passed through
 * unparsed ('data' events and the output callback). E.g.
 *   { format: 'webm', formatArgs: ['-cluster_time_limit', '1000'] }
 *
 * When FFmpeg fails (exits non-zero), error() is called with the reason
 * and flush() rejects (callback form: cb(err)).
 */

import { spawn } from 'node:child_process';
import EventEmitter from './core/events.js';
import { getVideoCodec } from './codecs.js';
import { getAudioCodec } from './codecs.js';
import { getContainer, getContainerFormat, getContainerExtra, getDefaultContainer } from './containers.js';
import { trackChildProcess, untrackChildProcess } from './ffmpeg_process.js';
import { normalizeCodec } from './utils/codec_strings.js';
import VideoFrame from './video_frame.js';

function MediaEncoder(opts) {
  if (!opts) opts = {};

  this._ee = new EventEmitter();
  this._output = opts.output || function () {};
  this._error = opts.error || function () {};

  this._videoConfig = opts.video || null;
  this._audioConfig = opts.audio || null;
  // Audio-only default follows the codec (ogg for Opus, adts for AAC,
  // ...). It was 'adts' for every codec: Opus into ADTS made FFmpeg exit
  // with code 234 and 0 bytes of output — with no error reported.
  this._containerName = opts.container || (this._videoConfig ? 'ts'
    : (getDefaultContainer(normalizeCodec((this._audioConfig && this._audioConfig.codec) || 'aac')) || 'adts'));
  this._format = opts.format || null;          // raw FFmpeg muxer name (overrides container)
  this._formatArgs = opts.formatArgs || [];
  this._ffmpegPath = opts.ffmpegPath || 'ffmpeg';
  this._exitError = null;
  this._firstFfmpegError = '';

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
  var bytes;
  try {
    bytes = _videoFrameI420(frame, this._videoConfig);
  } catch (e) {
    this._error(e);
    return false;
  }
  if (!this._started) this._start();
  if (!this._videoStdin || !this._videoStdin.writable) return false;
  return this._videoStdin.write(bytes);
};

/**
 * Write raw audio data (s16le).
 * @param {AudioData} audioData — AudioData with .data buffer
 * @returns {boolean} — false if backpressure (call onAudioDrain)
 */
MediaEncoder.prototype.writeAudioData = function (audioData) {
  if (!this._audioConfig) { this._error(new Error('MediaEncoder: no audio configured')); return false; }
  var bytes;
  try {
    bytes = _audioDataInterleaved(audioData, this._audioConfig);
  } catch (e) {
    this._error(e);
    return false;
  }
  if (!this._started) this._start();
  if (!this._audioStdin || !this._audioStdin.writable) return false;
  return this._audioStdin.write(bytes);
};

// ── Raw input conversion ──
//
// FFmpeg is told the video input is yuv420p at the configured size and
// the audio input is interleaved s16le (or f32le), and is then handed
// .data whatever its format was. An RGBA frame (4 bytes/pixel) was read
// as 2.67 I420 frames — 30 solid-red frames came out as 79 frames of
// magenta-green garbage — and f32-planar audio as s16 interleaved noise
// (a 440 Hz tone measured at 5032 Hz).

function _videoFrameI420(frame, vc) {
  // Plain bytes (no VideoFrame): taken as I420, as before.
  if (!frame || frame.format === undefined || typeof frame.allocationSize !== 'function') {
    return _plainBytes(frame);
  }
  var v = frame.visibleRect;
  var w = (v && v.width) || frame.codedWidth;
  var h = (v && v.height) || frame.codedHeight;
  if (w !== vc.width || h !== vc.height) {
    throw new Error('MediaEncoder: VideoFrame is ' + w + 'x' + h + ' but the encoder is configured for ' +
      vc.width + 'x' + vc.height + ' (FFmpeg reads fixed-size raw frames)');
  }
  var cropped = v && (v.x || v.y || v.width !== frame.codedWidth || v.height !== frame.codedHeight);
  if ((frame.format === 'I420' || frame.format === 'YUV420P') && !cropped) return frame.data;
  var src = frame;
  if (cropped && frame.format !== 'I420') {
    // copyTo cannot crop and convert in one step: crop in the source
    // format first, then convert that frame.
    var tmp = new Uint8Array(frame.allocationSize());
    _copyFrame(frame, tmp, undefined);
    src = new VideoFrame(tmp, { format: frame.format, codedWidth: w, codedHeight: h, timestamp: frame.timestamp });
  }
  var out = new Uint8Array(src.allocationSize({ format: 'I420' }));
  _copyFrame(src, out, { format: 'I420' });
  if (src !== frame) src.close();
  return out;
}

// Bytes given directly (a typed array, an ArrayBuffer, or an object with
// .data / .samples). A Uint8Array used to be replaced by its .buffer —
// an ArrayBuffer, which stream.write() rejects.
function _plainBytes(x) {
  if (!x) return x;
  if (ArrayBuffer.isView(x)) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  return x.data || x.samples || x;
}

// copyTo fills the destination before it returns; the synchronous form
// is used where it exists so a failed conversion throws here instead of
// becoming an unhandled rejection.
function _copyFrame(frame, dst, opts) {
  if (typeof frame._copyToSync === 'function') return frame._copyToSync(dst, opts);
  return frame.copyTo(dst, opts);
}

function _audioDataInterleaved(ad, ac) {
  if (!ad || !ad.format || typeof ad.copyTo !== 'function') {
    return _plainBytes(ad);                               // plain bytes: as before
  }
  var rate = ac.sampleRate || 48000;
  var ch = ac.numberOfChannels || ac.channels || 2;
  if (ad.sampleRate !== rate || ad.numberOfChannels !== ch) {
    throw new Error('MediaEncoder: AudioData is ' + ad.sampleRate + ' Hz / ' + ad.numberOfChannels +
      ' ch but the encoder is configured for ' + rate + ' Hz / ' + ch + ' ch');
  }
  var fmt = (ac.format === 'f32' || ac.format === 'f32le') ? 'f32' : 's16';
  if (ad.format === fmt && ad.data) return ad.data;
  var out = new Uint8Array(ad.allocationSize({ format: fmt, planeIndex: 0 }));
  ad.copyTo(out, { format: fmt, planeIndex: 0 });
  return out;
}

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
    return new Promise(function (resolve, reject) {
      self.flush(function (err) { if (err) reject(err); else resolve(); });
    });
  }

  // Exit status decides: a failed FFmpeg used to resolve flush() like a
  // good one, with nothing written.
  this._proc.on('close', function () { if (cb) cb(self._exitError || undefined); });

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
    // Capture the handle BEFORE clearing the field.
    //
    // This used to read `this._proc` inside the timer callback, but
    // `this._proc = null` runs synchronously below — so two seconds
    // later the callback dereferenced null, threw a TypeError, and the
    // surrounding catch swallowed it. The SIGKILL fallback could never
    // fire, and an FFmpeg that ignored SIGTERM survived indefinitely.
    //
    // unref() so the timer doesn't hold the event loop open: a script
    // that closes and exits should exit now, not two seconds later.
    //
    // ffmpeg_process.js:stop() already does both correctly — this is
    // the same intent, and the divergence was accidental.
    var proc = this._proc;
    // Untrack now: we are committing to killing it, and a stale entry
    // would linger in the live set if SIGTERM failed.
    untrackChildProcess(proc);
    try { proc.kill('SIGTERM'); } catch (e) {}
    var killTimer = setTimeout(function () {
      try { proc.kill('SIGKILL'); } catch (e) {}
    }, 2000);
    if (killTimer.unref) killTimer.unref();
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

  // No '-fflags nobuffer': it makes FFmpeg discard the packets it read
  // while probing the input, i.e. the start of the stream. Measured: the
  // first video frame (29 of 30 decoded) and ~80 ms of audio lost; an
  // audio-only ADTS output lost the whole first 33 ms tone (peak 0).
  var args = [
    '-loglevel', 'warning',
    '-flags', 'low_delay',
  ];
  // Raw input: nothing to probe. These are PER-INPUT options (they bind
  // to the next -i), so they are given before each input. Given once,
  // they reached only the video input, and FFmpeg probed the audio pipe
  // with its 5 s default — with video + audio nothing came out until
  // the input ended (a 4 s recording with timeslice 500: one
  // dataavailable, at stop).
  var probeArgs = ['-probesize', '32', '-analyzeduration', '0'];

  // ── Video input on pipe:0 (stdin) ──
  if (vc) {
    var videoCodecDef = getVideoCodec(vc.codec, vc);
    if (!videoCodecDef) { self._error(new Error('Unknown video codec: ' + vc.codec)); return; }
    Array.prototype.push.apply(args, probeArgs);
    args.push(
      '-f', 'rawvideo',
      // Always I420: writeVideoFrame converts to it. -pix_fmt below sets
      // what the encoder gets.
      '-pixel_format', 'yuv420p',
      '-video_size', vc.width + 'x' + vc.height,
      '-framerate', String(vc.framerate || 30),
      '-i', 'pipe:0'
    );
  }

  // ── Audio input on pipe:4 ──
  if (ac) {
    var fmt = (ac.format === 'f32' || ac.format === 'f32le') ? 'f32le' : 's16le';
    Array.prototype.push.apply(args, probeArgs);
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
  if (this._format) {
    containerDef = null;    // raw passthrough of the named muxer's bytes
    args.push('-f', this._format);
  } else if (containerDef) {
    args.push('-f', getContainerFormat(containerDef, vc ? vc.codec : ac.codec));
    Array.prototype.push.apply(args, getContainerExtra(containerDef, vc ? vc.codec : ac.codec));
  }
  // Force immediate output: don't buffer for interleaving
  args.push('-flush_packets', '1', '-max_interleave_delta', '0');
  // After the defaults above, so a caller's muxer options can override them.
  if (this._format) Array.prototype.push.apply(args, this._formatArgs);
  args.push('pipe:3');

  // ── stdio: [stdin=video, stdout, stderr, pipe3=output, pipe4=audio] ──
  var stdio = ['pipe', 'ignore', 'pipe', 'pipe'];
  if (ac) stdio.push('pipe');  // pipe:4 for audio

  var proc = spawn(self._ffmpegPath, args, { stdio: stdio });
  // MediaEncoder spawns directly rather than through FFmpegProcess,
  // because it needs a five-pipe stdio layout (video in, output, audio
  // in) that FFmpegProcess doesn't model. That bypassed the orphan
  // prevention every other spawn site gets: on a Node crash this child
  // was reparented to init and kept running. Register it explicitly.
  trackChildProcess(proc);
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
  proc.on('close', function (code, signal) {
    // close() kills deliberately and clears _proc first: not a failure.
    if (self._proc === proc && code !== 0) {
      var err = new Error('MediaEncoder: FFmpeg exited with ' +
        (signal ? 'signal ' + signal : 'code ' + code) +
        (self._firstFfmpegError ? ': ' + self._firstFfmpegError : ''));
      self._exitError = err;
      self._error(err);
      self._ee.emit('error', err);
    }
    if (self._proc === proc) self._started = false;
    self._ee.emit('close', code);
  });

  // stderr
  if (proc.stderr) {
    proc.stderr.on('data', function (chunk) {
      var msg = chunk.toString().trim();
      if (!msg) return;
      // The first error line says why (later ones are the cascade).
      if (!self._firstFfmpegError) {
        var lines = msg.split('\n');
        for (var i = 0; i < lines.length; i++) {
          if (/error|could not|invalid|not supported/i.test(lines[i])) { self._firstFfmpegError = lines[i].trim(); break; }
        }
      }
      self._ee.emit('ffmpeg:log', msg);
    });
  }
};

Object.defineProperty(MediaEncoder.prototype, 'running', {
  get: function () { return this._started; },
});

export default MediaEncoder;
