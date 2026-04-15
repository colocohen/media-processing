/**
 * VideoEncoder — WebCodecs-compatible video encoder.
 *
 * Auto-fallback: if hardware encoder fails, silently retries with software.
 *
 * Flow for prefer-hardware:
 *   1. Start FFmpeg with GPU encoder + buffer frame data
 *   2. First output → HW confirmed, clear buffer, continue normally
 *   3. FFmpeg dies before output → restart with software, replay buffer
 *   4. flush() waits for the FINAL encoder (software after fallback)
 */

import { initCoder, configureCoder, wireReader, applyCoderPrototype } from './base_coder.js';
import FFmpegProcess from './ffmpeg_process.js';
import { EncodedVideoChunk } from './encoded_chunk.js';
import { getVideoCodec } from './codecs.js';
import { normalizeCodec, parseCodecDetails } from './codec_strings.js';
import { getDefaultContainer, getContainer, getContainerFormat, getContainerExtra } from './containers.js';
import { extractParameterSets } from './reader_annexb.js';

// ═══════════════════════════════════════════
// SVC Temporal Layer Patterns
// ═══════════════════════════════════════════
//
// L1T2: 2 layers — keyframe every 2 frames
//   Frame:  0  1  2  3  4  5  6  7
//   TID:    0  1  0  1  0  1  0  1
//   Drop TID=1 → 15fps, all keyframes ✅
//
// L1T3: 3 layers — keyframe every 2 frames
//   Frame:  0  1  2  3  4  5  6  7
//   TID:    0  2  1  2  0  2  1  2
//   Drop TID≥2 → 15fps, all keyframes ✅
//   Drop TID≥1 → 7.5fps, all keyframes ✅

var SVC_PATTERNS = {
  'L1T1': null,
  'L1T2': { tid: [0, 1],       keyExpr: 'eq(mod(n,2),0)', layers: 2 },
  'L1T3': { tid: [0, 2, 1, 2], keyExpr: 'eq(mod(n,2),0)', layers: 3 },
};

// Bytes per pixel for format validation
var _FORMAT_BPP = {
  'I420': 1.5, 'YUV420P': 1.5, 'NV12': 1.5, 'I420A': 2.5,
  'RGBA': 4, 'RGBX': 4, 'BGRA': 4, 'BGRX': 4, 'RGB24': 3,
};

// Map VideoFrame format → FFmpeg -pixel_format value
var _FORMAT_TO_FFMPEG = {
  'I420': 'yuv420p', 'YUV420P': 'yuv420p', 'NV12': 'nv12', 'I420A': 'yuva420p',
  'RGBA': 'rgba', 'RGBX': 'rgba', 'BGRA': 'bgra', 'BGRX': 'bgra', 'RGB24': 'rgb24',
};

function VideoEncoder(init) {
  if (!init) throw new TypeError('VideoEncoder: init required');
  initCoder(this, init);
  this._encodeCount = 0;
  this._expectedFrameSize = 0;

  this._hwProbing = false;
  this._pendingWrites = [];
  this._deferredFlush = null;
  this._oldProcesses = [];  // old FFmpeg instances still flushing after keyframe restart

  this.context = {
    state: 'unconfigured',
    codec: null,
    width: 0, height: 0,
    framerate: 0,
    frameCount: 0,
    keyframeCount: 0,
    encoder: null,
    isHardware: false,
  };
}

applyCoderPrototype(VideoEncoder);

var FLUSH_TIMEOUT = 10000;

// Override flush — Promise + callback, waits for output_end from all processes
VideoEncoder.prototype.flush = function (cb) {
  var self = this;
  if (typeof cb === 'function') {
    self._flushImpl(cb);
    return;
  }
  return new Promise(function (resolve) { self._flushImpl(resolve); });
};

VideoEncoder.prototype._flushImpl = function (cb) {
  if (this._hwProbing) {
    this._deferredFlush = cb;
    this._ffmpeg.endInput();
    return;
  }

  var self = this;
  var pending = 1;
  var done = false;

  for (var i = 0; i < self._oldProcesses.length; i++) {
    if (self._oldProcesses[i].running) pending++;
  }

  var timer = setTimeout(function () {
    if (done) return;
    done = true;
    self._ffmpeg.stop();
    for (var k = 0; k < self._oldProcesses.length; k++) {
      try { self._oldProcesses[k].stop(); } catch (e) {}
    }
    self._state = 'configured';
    self._queueSize = 0;
    self._oldProcesses = [];
    if (cb) cb();
  }, FLUSH_TIMEOUT);

  function onOneDone() {
    pending--;
    if (pending <= 0 && !done) {
      done = true;
      clearTimeout(timer);
      self._state = 'configured';
      self._queueSize = 0;
      self._oldProcesses = [];
      if (cb) cb();
    }
  }

  // Wait for old processes — use output_end with close fallback
  for (var j = 0; j < self._oldProcesses.length; j++) {
    var old = self._oldProcesses[j];
    if (old.running) {
      (function (proc) {
        var oldDone = false;
        proc.on('output_end', function () { if (!oldDone) { oldDone = true; onOneDone(); } });
        proc.on('close', function () { if (!oldDone) { oldDone = true; onOneDone(); } });
      })(old);
    } else {
      pending--;  // already closed
    }
  }

  // Wait for current FFmpeg — output_end with close fallback
  if (this._ffmpeg.running) {
    var curDone = false;
    this._ffmpeg.on('output_end', function () { if (!curDone) { curDone = true; onOneDone(); } });
    this._ffmpeg.on('close', function () { if (!curDone) { curDone = true; onOneDone(); } });
    this._ffmpeg.endInput();
  } else {
    onOneDone();
  }
};

// Override close to also stop old FFmpeg processes from keyframe restarts
VideoEncoder.prototype.close = function () {
  // Stop old processes
  for (var i = 0; i < this._oldProcesses.length; i++) {
    try { this._oldProcesses[i].stop(); } catch (e) {}
  }
  this._oldProcesses = [];
  // Stop current
  this._ffmpeg.stop();
  this._ffmpeg.removeAllListeners('data');
  this._ffmpeg.removeAllListeners('error');
  this._ffmpeg.removeAllListeners('close');
  this._reader = null;
  this._state = 'closed';
  this.context.state = 'closed';
};

VideoEncoder.prototype.configure = function (config) {
  if (!config || !config.codec) throw new TypeError('VideoEncoder.configure: codec required');
  if (!config.width || !config.height) throw new TypeError('VideoEncoder.configure: width and height required');

  configureCoder(this);

  // Extract profile/level from browser codec string (e.g. 'avc1.64002A' → high/4.2)
  var details = parseCodecDetails(config.codec);

  this._config = {
    codec: normalizeCodec(config.codec),
    width: config.width,
    height: config.height,
    framerate: config.framerate || 30,
    bitrate: config.bitrate || 0,
    latencyMode: config.latencyMode || 'realtime',
    gopSize: config.gopSize || config.gop || 30,
    crf: config.crf,
    tileColumns: config.tileColumns,
    tileRows: config.tileRows,
    errorResilient: !!config.errorResilient,
    hardwareAcceleration: config.hardwareAcceleration || 'no-preference',
    bitrateMode: config.bitrateMode || 'variable',
    scalabilityMode: config.scalabilityMode || null,
    codecOptions: config.codecOptions || null,
    // H.264/H.265: explicit config overrides codec string extraction
    profile: config.profile || details.profile || null,
    level: config.level || details.level || null,
    // FFmpeg log level
    loglevel: config.loglevel || 'warning',
    contentHint: config.contentHint || '',  // '', 'motion', 'detail', 'text'
    alpha: config.alpha || 'discard',  // 'discard' (default) or 'keep' (not yet implemented)
  };

  this._encodeCount = 0;
  this._expectedFrameSize = ((config.width * config.height * 3) >> 1);
  this._inputPixelFormat = null;  // detected from first frame format
  this._hwProbing = false;
  this._pendingWrites = [];
  this._deferredFlush = null;
  this._svcPattern = config.scalabilityMode ? SVC_PATTERNS[config.scalabilityMode] || null : null;
  this._svcFrameIndex = 0;

  this.context.state = 'configured';
  this.context.codec = this._config.codec;
  this.context.width = this._config.width;
  this.context.height = this._config.height;
  this.context.framerate = this._config.framerate;
  this.context.frameCount = 0;
  this.context.keyframeCount = 0;
};

VideoEncoder.prototype.encode = function (frame, options) {
  if (this._state !== 'configured') {
    this._error(new Error('VideoEncoder: not configured'));
    return;
  }
  if (!frame || (!Buffer.isBuffer(frame.data) && !(frame.data instanceof Uint8Array))) {
    this._error(new Error('VideoEncoder.encode: frame.data must be Buffer'));
    return;
  }

  // Auto-detect pixel format from frame (browser compat: accept any format)
  var fmt = (frame.format || 'I420').toUpperCase();
  var bpp = _FORMAT_BPP[fmt];
  if (!bpp) {
    this._error(new Error('VideoEncoder.encode: unsupported format "' + fmt + '"'));
    return;
  }
  var expectedSize = Math.floor(this._config.width * this._config.height * bpp);
  if (frame.data.length !== expectedSize) {
    this._error(new Error(
      'VideoEncoder.encode: frame size ' + frame.data.length +
      ' does not match ' + this._config.width + 'x' + this._config.height +
      ' ' + fmt + ' (expected ' + expectedSize + ')'
    ));
    return;
  }

  // Store input format for FFmpeg startup (first frame determines format)
  if (!this._inputPixelFormat) {
    this._inputPixelFormat = _FORMAT_TO_FFMPEG[fmt] || 'yuv420p';
  }

  // Production: track stats
  if (this._stats.encodeCount === 0) this._stats.startTime = Date.now();
  this._stats.encodeCount++;
  this._stats.lastEncodeTime = Date.now();

  // Production: frame dropping when queue exceeds limit
  if (this._maxQueueSize > 0 && this._queueSize >= this._maxQueueSize) {
    this._stats.droppedCount++;
    return;  // drop frame silently
  }

  // Browser-compat: accept per-frame quantizer options
  // { keyFrame, vp9: { quantizer }, av1: { quantizer }, avc: { quantizer }, hevc: { quantizer } }
  // Note: per-frame QP is not supported with FFmpeg child processes (CRF from configure is used)
  if (options) {
    var qp = (options.vp9 && options.vp9.quantizer) ||
             (options.av1 && options.av1.quantizer) ||
             (options.avc && options.avc.quantizer) ||
             (options.hevc && options.hevc.quantizer);
    if (typeof qp === 'number' && !this._qpWarned) {
      this._qpWarned = true;
      // Per-frame QP requires native encoder API; FFmpeg uses global CRF
    }
  }

  // Force keyframe: end old FFmpeg (let it flush) and start new one.
  // Old FFmpeg continues emitting buffered frames; new FFmpeg starts with IDR.
  if (options && options.keyFrame && this._ffmpeg.running) {
    var oldFfmpeg = this._ffmpeg;
    var oldReader = this._reader;

    // Let old FFmpeg finish processing — DON'T stop/kill
    oldFfmpeg.endInput();
    this._oldProcesses.push(oldFfmpeg);
    // Old reader keeps emitting output to _output callback — no detach needed

    // Create fresh FFmpeg process for new session
    this._ffmpeg = new FFmpegProcess();
    this._reader = null;
    // _startFFmpeg will be called below since _ffmpeg.running is now false
  }

  if (!this._ffmpeg.running) this._startFFmpeg();

  // Buffer frames during HW probe for potential replay
  if (this._hwProbing) {
    var copy = Buffer.allocUnsafe(frame.data.length);
    frame.data.copy(copy);
    this._pendingWrites.push(copy);
  }

  this._queueSize++;
  var ok = this._ffmpeg.write(frame.data);
  this._encodeCount++;
  this.context.frameCount = this._encodeCount;
  return ok;  // false = backpressure, caller should wait for onDrain
};

// ── Start FFmpeg ──

VideoEncoder.prototype._startFFmpeg = function () {
  var codecDef = getVideoCodec(this._config.codec, this._config);
  if (!codecDef) { this._error(new Error('Unknown codec: ' + this._config.codec)); return; }

  this.context.encoder = codecDef.encoder;
  this.context.isHardware = codecDef.isHardware;
  this._hwProbing = codecDef.isHardware;

  this._launchFFmpeg(codecDef);
};

VideoEncoder.prototype._launchFFmpeg = function (codecDef) {
  var self = this;
  var cfg = this._config;

  var containerName = getDefaultContainer(cfg.codec);
  var containerDef = getContainer(containerName);
  if (!containerDef) { self._error(new Error('No container for: ' + cfg.codec)); return; }

  var args = ['-loglevel', cfg.loglevel || 'warning'];
  if (cfg.latencyMode !== 'quality') {
    args.push('-fflags', 'nobuffer', '-flags', 'low_delay');
    args.push('-probesize', '32', '-analyzeduration', '0');
    args.push('-max_delay', '0');
  }

  if (codecDef.preInput && codecDef.preInput.length) {
    Array.prototype.push.apply(args, codecDef.preInput);
  }

  args.push(
    '-f', 'rawvideo',
    '-pixel_format', self._inputPixelFormat || 'yuv420p',
    '-video_size', cfg.width + 'x' + cfg.height,
    '-framerate', String(cfg.framerate),
    '-i', 'pipe:0'
  );

  args.push('-map', '0:v:0');
  Array.prototype.push.apply(args, codecDef.args);

  if (!codecDef.isHardware) {
    args.push('-pix_fmt', codecDef.pixFmt || 'yuv420p');
  }

  // User-provided raw FFmpeg args (advanced tuning)
  if (cfg.codecOptions && cfg.codecOptions.length) {
    Array.prototype.push.apply(args, cfg.codecOptions);
  }

  // SVC: force keyframes at pattern positions for drop-safe temporal layers
  if (self._svcPattern) {
    args.push('-force_key_frames', 'expr:' + self._svcPattern.keyExpr);
  }

  args.push('-f', getContainerFormat(containerDef, cfg.codec));
  Array.prototype.push.apply(args, getContainerExtra(containerDef, cfg.codec));
  if (cfg.latencyMode !== 'quality') {
    args.push('-flush_packets', '1', '-avioflags', 'direct');
  }
  args.push('pipe:3');

  self._ffmpeg.start(args, ['pipe', 'ignore', 'pipe', 'pipe']);

  // Wire reader
  var gotOutput = false;
  var svcPat = self._svcPattern;

  if (containerDef.createReader) {
    var reader = containerDef.createReader({ codec: cfg.codec, fps: cfg.framerate });
    self._reader = reader;

    reader.on('video', function (f) {
      if (self._hwProbing && !gotOutput) {
        gotOutput = true;
        self._hwProbing = false;
        self._pendingWrites = [];
      }
      if (f.isKeyframe) self.context.keyframeCount++;

      var chunk = new EncodedVideoChunk({
        type: f.isKeyframe ? 'key' : 'delta',
        timestamp: f.ptsUs,
        data: f.payload,
      });

      // SVC: assign temporalLayerId from pattern
      var metadata = {};
      if (svcPat) {
        var tid = svcPat.tid[self._svcFrameIndex % svcPat.tid.length];
        metadata.svc = { temporalLayerId: tid };
        chunk.metadata = metadata;
        self._svcFrameIndex++;
      }

      // Build decoderConfig metadata (browser passes this on keyframes)
      if (f.isKeyframe) {
        metadata.decoderConfig = {
          codec: cfg.codec,
          codedWidth: cfg.width,
          codedHeight: cfg.height,
        };
        // Extract SPS/PPS (H.264) or VPS/SPS/PPS (H.265) as description
        if (cfg.codec === 'h264' || cfg.codec === 'h265') {
          var desc = extractParameterSets(f.payload, cfg.codec === 'h265');
          if (desc) metadata.decoderConfig.description = desc;
        }
      }

      self._output(chunk, metadata);
    });

    self._ffmpeg.on('data', function (chunk) {
      reader.feed(chunk);  // use captured local reader, NOT self._reader
    });
  }

  // Suppress errors during HW probe
  self._ffmpeg.on('error', function (e) {
    if (self._hwProbing) return;
    self._error(e);
  });

  // Handle close — fallback if HW failed
  self._ffmpeg.on('close', function () {
    if (self._hwProbing && !gotOutput) {
      self._hwProbing = false;
      self._fallbackToSoftware();
      return;
    }
  });
};

/**
 * Hardware failed → restart with software, replay buffered frames.
 * If flush() was deferred, flush the software encoder after replay.
 */
VideoEncoder.prototype._fallbackToSoftware = function () {
  var self = this;
  var cfg = this._config;

  var swConfig = {};
  for (var k in cfg) {
    if (Object.prototype.hasOwnProperty.call(cfg, k)) swConfig[k] = cfg[k];
  }
  swConfig.hardwareAcceleration = 'prefer-software';

  var swCodecDef = getVideoCodec(cfg.codec, swConfig);
  if (!swCodecDef) {
    self._error(new Error('Fallback failed: no software encoder for ' + cfg.codec));
    return;
  }

  self.context.encoder = swCodecDef.encoder;
  self.context.isHardware = false;

  // Clean up old listeners
  self._ffmpeg.removeAllListeners('data');
  self._ffmpeg.removeAllListeners('error');
  self._ffmpeg.removeAllListeners('close');
  self._reader = null;

  // Launch software encoder
  self._launchFFmpeg(swCodecDef);

  // Replay buffered frames
  var pending = self._pendingWrites;
  self._pendingWrites = [];
  for (var i = 0; i < pending.length; i++) {
    self._ffmpeg.write(pending[i]);
  }

  // If flush() was called during probe, now flush the software encoder
  if (self._deferredFlush) {
    var cb = self._deferredFlush;
    self._deferredFlush = null;
    self._ffmpeg.on('close', function onClose() {
      self._ffmpeg.off('close', onClose);
      self._state = 'configured';
      self._queueSize = 0;
      cb();
    });
    self._ffmpeg.endInput();
  }
};

VideoEncoder.isConfigSupported = function (config) {
  return Promise.resolve({ supported: !!getVideoCodec(config.codec, config) });
};

export default VideoEncoder;
