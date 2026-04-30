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

  // ── Keyframe-restart transition state (architectural fix) ──
  //
  // When a keyframe is requested mid-stream, we spawn a fresh FFmpeg
  // and let the old one drain. The naive design lets BOTH FFmpeg
  // readers emit to self._output in parallel, which produces:
  //   - out-of-order frames (new is faster than old's drain)
  //   - frame loss if cap evicts a still-buffered old process
  //   - visible output gaps during new's startup
  //
  // The fix: during a transition, the NEW reader's outputs are
  // buffered (not emitted). Only the OLD reader emits live. When all
  // tracked old processes have signaled `output_end`, we flush the
  // buffered new outputs in timestamp order, then return to direct
  // emission. If old fails to drain within MAX_TRANSITION_MS, we
  // give up waiting and flush — preserves liveness over correctness
  // in pathological cases (FFmpeg subprocess hung).
  //
  // _transitionPendingOld: set of old FFmpegProcess instances we're
  //                        still waiting on for output_end. While
  //                        non-empty, transition is active.
  // _transitionBuffer:     [{chunk, metadata}] queued from new reader.
  // _transitionTimer:      forcing timeout if drain stalls.
  this._transitionPendingOld = new Set();
  this._transitionBuffer = null;       // null when no transition active
  this._transitionTimer = null;

  // ── Keyframe-restart throttle (MP-14 Layer 1) ──
  //
  // Without this, every {keyFrame:true} encode() call triggers a fresh
  // FFmpeg subprocess, even when one was just spawned. PLI/FIR storms
  // (multiple receivers losing video, or one receiver retrying) easily
  // produce 5-10 keyframe requests per second, which means:
  //   • 5-10 restarts/sec × ~1000ms transition window = constant freezing
  //   • Eviction cap (MAX_PENDING_RESTARTS) drops P-frames to keep RAM
  //     bounded, making the freeze WORSE
  //   • CPU/FD churn from spawning subprocesses
  //
  // Throttle behavior: if a keyframe-restart was performed within the
  // last RESTART_COOLDOWN_MS, drop the request. The encoder's most
  // recent FFmpeg already produced a fresh keyframe; the receiver
  // either (a) hasn't seen it yet (RTT), in which case duplicate PLIs
  // are inevitable until the RTT elapses, or (b) saw it and stopped
  // sending PLIs. Either way, another restart now adds nothing.
  //
  // The throttled frame still gets encoded — it just goes through
  // the existing FFmpeg as a P-frame. Receiver recovers when the
  // next natural keyframe arrives, or when the cooldown expires and
  // a subsequent PLI does trigger a restart.
  //
  // RESTART_COOLDOWN_MS = 1000: matches typical cross-internet RTT +
  // jitter buffer; long enough that the previous keyframe is virtually
  // guaranteed to have been received-and-acked before we'd consider
  // another. Tunable via instance assignment.
  this._lastKeyframeRestart = 0;
  this.RESTART_COOLDOWN_MS = 1000;
  this._stats.keyframeThrottled = 0;

  // ── Pre-warmed FFmpeg pool (MP-14 Layer 2) ──
  //
  // Even with the throttle (Layer 1), each surviving keyframe-restart
  // still costs ~1000ms of transition-buffer freeze: spawn (~50ms) +
  // FFmpeg startup (~200ms) + libavcodec init + first-frame encode
  // (~500-700ms with libx264 ultrafast). The dominant cost is the
  // first three — the encode itself is fast.
  //
  // Optimization: keep one ALREADY-spawned FFmpeg sitting idle, args
  // pre-loaded, pipes open. When a keyframe-restart fires, swap in
  // the warm one (only cost: wiring the reader, ~1ms) and refill the
  // pool in the background. Net freeze drops to ~100-200ms — just
  // the time for the encoder lib to process the first input frame.
  //
  // Memory cost: ~30-50MB RSS per warm process. With pool target=1
  // (default), that's a single extra process per encoder. Apps with
  // dozens of encoders and tight memory should set target=0 to
  // disable pre-warming.
  //
  // Invalidation: pool contents are tied to the encoder's current
  // config. configure() flushes the pool. The fingerprint check on
  // take() is a defense-in-depth — if the args don't match, the pool
  // entry is discarded and the take falls back to fresh spawn.
  //
  // Lifecycle:
  //   _refillWarmPool   - async, top up to target. Idempotent.
  //   _takeWarmFFmpeg   - synchronous swap; returns running FFmpeg or null.
  //   _drainWarmPool    - kill all warm processes (called on close/reset).
  //
  // Configure with: encoder.WARM_POOL_TARGET = 0|1|2 (default 1).
  this._warmPool = [];
  this._warmPoolFilling = false;
  this._configFingerprint = null;
  this.WARM_POOL_TARGET = 1;
  this._stats.warmPoolHits = 0;
  this._stats.warmPoolMisses = 0;

  // ── Backpressure tracking (diagnostic only) ──
  //
  // Note: encodeQueueSize is NOT initialized here — the framework's
  // base_coder.js defines it as a getter on the prototype, and any
  // assignment throws TypeError. The 'dequeue' event is emitted by
  // the framework. We only track an internal counter for the
  // write()=false signal; for video this is mostly noise (frames
  // bigger than highWaterMark trigger it routinely) but useful for
  // sanity-checking sustained encoder pressure during diagnostics.
  this._stats.backpressureEvents = 0;

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
    // Final reader flush before stop, to extract any trailing AUs
    // still buffered in the reader. Without this, the last 1-2
    // frames of every flush() are silently lost (no AUD start code
    // follows the last AU, so feed() never emits it).
    self._flushAllReaders();
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
      // Same trailing-AU flush as the timeout path. The output_end
      // signal means FFmpeg's stdio[3] EOF'd, but the reader may
      // still hold a buffered AU it hasn't emitted yet (waiting for
      // the next AUD that will never come).
      self._flushAllReaders();
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

// Flush all readers (current + olds) so any trailing AU buffered with
// no following AUD start-code gets emitted. Called from _flushImpl on
// both success and timeout paths. Idempotent: flush() on a reader is
// safe to call multiple times.
VideoEncoder.prototype._flushAllReaders = function () {
  if (this._reader && typeof this._reader.flush === 'function') {
    try { this._reader.flush(); } catch (e) {}
  }
  for (var i = 0; i < this._oldProcesses.length; i++) {
    var r = this._oldProcesses[i]._readerForFlush;
    if (r && typeof r.flush === 'function') {
      try { r.flush(); } catch (e) {}
    }
  }
};

// Override close to also stop old FFmpeg processes from keyframe restarts
VideoEncoder.prototype.close = function () {
  // Stop old processes
  for (var i = 0; i < this._oldProcesses.length; i++) {
    try { this._oldProcesses[i].stop(); } catch (e) {}
  }
  this._oldProcesses = [];
  // Drop any pending transition state — we're shutting down, no need
  // to flush. Buffered frames are abandoned (caller is closing anyway).
  this._transitionPendingOld.clear();
  this._transitionBuffer = null;
  if (this._transitionTimer) {
    clearTimeout(this._transitionTimer);
    this._transitionTimer = null;
  }
  // Drain warm pool — these are subprocesses we'd otherwise leak.
  this._drainWarmPool();
  // Stop current
  this._ffmpeg.stop();
  this._ffmpeg.removeAllListeners('data');
  this._ffmpeg.removeAllListeners('error');
  this._ffmpeg.removeAllListeners('close');
  this._reader = null;
  this._state = 'closed';
  this.context.state = 'closed';
};

// ── Transition routing helpers (architectural fix for restart) ──
//
// When no transition is active, every reader emits straight to
// _output — current behavior preserved. When a transition starts:
//
//   - Frames from OLD readers (their producingFfmpeg is in
//     _transitionPendingOld) emit live. They're the "trailing"
//     frames that must arrive before the new keyframe.
//   - Frames from the NEW reader (producingFfmpeg === current
//     self._ffmpeg) get buffered in _transitionBuffer. They'll be
//     held until all olds drain, then flushed in timestamp order.
//
// When the last old emits 'output_end' (or the safety timer fires),
// _flushTransition() releases the buffer and resumes direct mode.

VideoEncoder.prototype._emitEncoded = function (chunk, metadata, producingFfmpeg) {
  // Fast path: no transition active → straight through.
  if (this._transitionBuffer === null) {
    this._output(chunk, metadata);
    return;
  }
  // Transition active. If this frame came from an OLD process, emit
  // it live — those are the trailing pre-keyframe frames we want the
  // receiver to see first. The new keyframe is buffered until they
  // all drain.
  if (this._transitionPendingOld.has(producingFfmpeg)) {
    this._output(chunk, metadata);

    // Reset watchdog: OLD made progress. As long as OLD keeps
    // emitting, we keep waiting (no premature flush).
    if (this._transitionTimer && this._transitionTimerDuration) {
      clearTimeout(this._transitionTimer);
      var self = this;
      this._transitionTimer = setTimeout(function () {
        self._flushTransition('timeout');
      }, this._transitionTimerDuration);
    }

    // Count-based drain check: if this OLD has now produced as many
    // outputs as it received inputs, it's fully drained. Trigger
    // _onOldDrained synchronously — no waiting on async pipe events.
    if (producingFfmpeg._drainTarget != null &&
        producingFfmpeg._outputCount >= producingFfmpeg._drainTarget) {
      if (producingFfmpeg._onDrainHook) {
        producingFfmpeg._onDrainHook();
      }
    }
    return;
  }
  // Otherwise it came from the NEW (current) FFmpeg → buffer.
  this._transitionBuffer.push({ chunk: chunk, metadata: metadata });
};

// Called when one old FFmpeg has drained (or closed). If it was the
// last pending old, release the transition.
VideoEncoder.prototype._onOldDrained = function (oldFfmpeg) {
  // Remove from pending set. Set.delete is a no-op if already removed
  // (e.g. cap eviction or double-fire from output_end + close).
  this._transitionPendingOld.delete(oldFfmpeg);
  if (this._transitionPendingOld.size === 0) {
    this._flushTransition('drain');
  }
};

// Force-end the transition (timeout or all-drained). Flush buffered
// new outputs in timestamp order, then return to direct mode.
VideoEncoder.prototype._flushTransition = function (reason) {
  if (this._transitionTimer) {
    clearTimeout(this._transitionTimer);
    this._transitionTimer = null;
  }
  if (this._transitionBuffer === null) return;   // already flushed

  // Capture the buffer NOW and clear the active transition state
  // BEFORE any side effects. Reader.flush() below can emit frames
  // through the live path which may call back into _emitEncoded —
  // and during a count-based drain check, _onOldDrained → recursive
  // _flushTransition. Capturing first prevents the recursive call
  // from re-flushing or NPE'ing on a null buffer.
  var buffered = this._transitionBuffer;
  this._transitionBuffer = null;

  // Flush any tail AUs from old readers. On the timeout path this
  // catches frames that FFmpeg emitted just before going idle but
  // the reader hadn't seen a following AUD for. On the drain path
  // it's redundant but harmless. Late frames that surface from
  // these flushes go straight to _output via the fast path (since
  // _transitionBuffer is now null).
  if (reason === 'timeout') {
    var pendingArr = Array.from(this._transitionPendingOld);
    for (var pi = 0; pi < pendingArr.length; pi++) {
      var rdr = pendingArr[pi]._readerForFlush;
      if (rdr && typeof rdr.flush === 'function') {
        try { rdr.flush(); } catch (e) {}
      }
    }
  }

  // Sort by timestamp. Should already be in order from a single
  // reader, but the cost is small and the safety is real.
  buffered.sort(function (a, b) {
    return a.chunk.timestamp - b.chunk.timestamp;
  });

  for (var i = 0; i < buffered.length; i++) {
    this._output(buffered[i].chunk, buffered[i].metadata);
  }

  // If timeout-induced flush, the remaining olds are still in the
  // pending set — clear it so the next restart starts fresh. Their
  // frames (if they arrive late) will hit the fast path and emit
  // directly, which can produce out-of-order output. This is the
  // intentional liveness-over-correctness trade in the timeout path.
  if (reason === 'timeout') {
    this._transitionPendingOld.clear();
  }
};

// Alias for backward compatibility with the constructor's reference
VideoEncoder.prototype._forceFlushTransition = VideoEncoder.prototype._flushTransition;

VideoEncoder.prototype.configure = function (config) {
  if (!config || !config.codec) throw new TypeError('VideoEncoder.configure: codec required');
  if (!config.width || !config.height) throw new TypeError('VideoEncoder.configure: width and height required');

  configureCoder(this);

  // Drain any warm pool from a previous configuration. _refillWarmPool
  // will repopulate it after the new config takes effect (triggered
  // from the next _launchFFmpeg). Doing this BEFORE setting the new
  // _config means stale entries can't pass the fingerprint check
  // even if take() races with refill on a future encode.
  this._drainWarmPool();

  // Extract profile/level from browser codec string (e.g. 'avc1.64002A' → high/4.2)
  var details = parseCodecDetails(config.codec);

  // latencyMode default per W3C WebCodecs — 'realtime' is the spec default
  // and signals that the application manages keyframes (via encode(frame,
  // {keyFrame:true}), typically in response to PLI/FIR in a WebRTC context).
  // 'quality' signals a classic encode where the encoder inserts its own
  // periodic keyframes to support seeking and random access.
  var latencyMode = config.latencyMode || 'realtime';

  // gopSize default depends on latencyMode. In 'realtime' we must not emit
  // unrequested keyframes — a 30-frame GOP at 30 fps produces one per second,
  // each a ~7-packet burst that stresses the remote jitter buffer for no
  // benefit (the app requests keyframes as needed). Chrome's libwebrtc sets
  // kf_max_dist ≈ INT_MAX for exactly this reason. In 'quality' we keep the
  // classic 30/60-frame GOP so encoded files remain seekable.
  // An explicit gopSize always wins.
  var defaultGop = (latencyMode === 'realtime') ? 0x7fffffff : 30;

  this._config = {
    codec: normalizeCodec(config.codec),
    width: config.width,
    height: config.height,
    framerate: config.framerate || 30,
    bitrate: config.bitrate || 0,
    latencyMode: latencyMode,
    gopSize: config.gopSize || config.gop || defaultGop,
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
  // The old reader continues to emit live; the new reader's outputs
  // are buffered until old drains, then flushed in order. See the
  // _transitionBuffer comment block in the constructor for the full
  // architectural rationale.
  //
  // Throttled: if a restart was performed within RESTART_COOLDOWN_MS,
  // we skip and let the frame go through the existing FFmpeg as a
  // P-frame. See the cooldown rationale in the constructor.
  if (options && options.keyFrame && this._ffmpeg.running) {
    var _kfNow = Date.now();
    var _kfSinceLast = _kfNow - this._lastKeyframeRestart;
    if (_kfSinceLast < this.RESTART_COOLDOWN_MS) {
      // Throttled. Log only once per cooldown window so a sustained
      // PLI storm doesn't drown the log; the count goes into _stats
      // for after-the-fact diagnosis.
      this._stats.keyframeThrottled++;
      if (!this._kfThrottleLogged) {
        console.log('[encoder] KEYFRAME throttled @ ' +
                    new Date().toISOString().slice(11, 23) +
                    ' (last restart ' + _kfSinceLast + 'ms ago, cooldown ' +
                    this.RESTART_COOLDOWN_MS + 'ms; total throttled=' +
                    this._stats.keyframeThrottled + ')');
        this._kfThrottleLogged = true;
        var self_kf = this;
        setTimeout(function () { self_kf._kfThrottleLogged = false; },
                   this.RESTART_COOLDOWN_MS);
      }
      // Skip the entire restart block. Frame falls through to the
      // standard encode path below — encoded as P-frame by the
      // currently-running FFmpeg. The receiver doesn't get a fresh
      // keyframe right now, but it WILL on the next request after
      // the cooldown expires (or on the natural keyframe interval).
    } else {
      // Cooldown expired (or first keyframe ever). Proceed with the
      // restart and stamp the timestamp so subsequent requests within
      // RESTART_COOLDOWN_MS get throttled.
      this._lastKeyframeRestart = _kfNow;

    // ════════════════════════ DIAGNOSTIC (PLI-loop test) ════════════════════════
    // Logs every keyframe-induced subprocess restart. Run for ~60s, count
    // entries:
    //   • With audio enabled:  expecting ~12/min if PLI loop is active
    //   • Without audio:       should be 0-1/min
    // If the pattern matches, the hypothesis "audio induces PLI loop" is
    // confirmed and we can move to the fix. Remove this log once diagnosed.
    console.log('[encoder] KEYFRAME RESTART @ ' + new Date().toISOString().slice(11, 23) +
                ' (encodeCount=' + this._encodeCount +
                ', pendingOlds=' + this._oldProcesses.length + ')');
    // ═══════════════════════════════════════════════════════════════════════════

    var oldFfmpeg = this._ffmpeg;

    // Let old FFmpeg finish processing — DON'T stop/kill yet.
    // Capture the reader BEFORE replacing self._reader; we need it
    // to flush trailing AUs after FFmpeg's stdio drains. Without this
    // flush, the last AU(s) buffered in the reader (no following AUD
    // start-code to terminate them) never get emitted — visible as
    // frame loss + out-of-order outputs in real-world FFmpeg tests.
    var oldReader = this._reader;
    oldFfmpeg.endInput();
    oldFfmpeg._oldReader = oldReader;   // keep reader reachable for flush
    this._oldProcesses.push(oldFfmpeg);

    // Track this old process as one we wait on before flushing.
    //
    // Drain detection: COUNT-BASED (race-free).
    //
    // Earlier event-based approach (waiting for stdio[3] 'end') was
    // racey with Node's event loop:
    //   - OLD subprocess might exit and emit 'end' BEFORE we attach
    //     the listener (if endInput → exit → end happens fast).
    //   - 'end' fires after all data events queued, but data events
    //     can still be PENDING in the JS event queue when 'end' fires
    //     synchronously.
    //   - Result: transition releases before OLD's last frames have
    //     been emitted, causing out-of-order outputs in real tests.
    //
    // Count approach: each FFmpeg instance tracks input frames
    // pushed (_inputPtsQueue.length when restarted) vs output frames
    // emitted (_outputCount). Drain is reached when output reaches
    // input. This is checked from the reader callback (synchronous,
    // race-free) AND from a fallback timer.
    //
    // Assumption: 1 input frame = 1 output frame. True for B-frame=0
    // encoders (our WebRTC default). For codecs that reorder or
    // produce multiple outputs per input, this would need adjustment.
    oldFfmpeg._drainTarget = oldFfmpeg._totalInputs || 0;
    oldFfmpeg._outputCount = oldFfmpeg._outputCount || 0;
    oldFfmpeg._readerForFlush = oldReader;

    this._transitionPendingOld.add(oldFfmpeg);
    var self = this;
    var drained = false;
    var onDrainOnce = function () {
      if (drained) return;
      drained = true;
      // Final reader flush in case there's a tail AU. Synchronous —
      // any 'video' events emitted during flush propagate through
      // the reader handler. The flush itself can produce more output
      // counts; if the count crosses _drainTarget mid-flush, no harm:
      // we're already declaring drained.
      if (oldReader && typeof oldReader.flush === 'function') {
        try { oldReader.flush(); } catch (e) {}
      }
      self._onOldDrained(oldFfmpeg);
    };
    oldFfmpeg._onDrainHook = onDrainOnce;   // called from reader callback

    // We deliberately do NOT attach output_end / close listeners as
    // drain triggers — they fire BEFORE the reader has processed all
    // buffered data (Node's event ordering). Relying on them caused
    // out-of-order outputs (transition closed prematurely while
    // OLD's reader was still emitting frames). The 250ms _flushTransition
    // timeout is the only fallback for liveness if the count never
    // reaches its target.

    // Activate transition: from now until all olds drain, the
    // NEW reader's outputs are buffered, not emitted live.
    this._transitionBuffer = [];

    // Watchdog timer: if no OLD output arrives for MAX_IDLE_MS, force
    // the transition to flush. This prevents indefinite buffering if
    // OLD subprocess hung or the count-based detection fails.
    //
    // The timer is RESET each time an OLD frame arrives — so a slowly-
    // draining OLD can take many seconds to drain as long as it makes
    // progress. Only true silence triggers the timeout.
    //
    // Was: fixed 250ms (caused premature flush on real workloads
    //   where libx264 ultrafast encode of 30 frames takes >250ms).
    var MAX_IDLE_MS = 1000;
    if (this._transitionTimer) clearTimeout(this._transitionTimer);
    this._transitionTimer = setTimeout(function () {
      self._flushTransition('timeout');
    }, MAX_IDLE_MS);
    this._transitionTimerDuration = MAX_IDLE_MS;

    // MP-14 BAND-AID: cap pending old processes. Without this, a
    // PLI/FIR storm accumulates FFmpeg subprocesses unboundedly.
    // Each is ~30-50 MB RSS + a few file descriptors. Test
    // test_ffmpeg_restart_behavior.js measured 101 active
    // subprocesses after 100 keyframe requests with no cap.
    //
    // Frames buffered in evicted FFmpegs are lost — but losing a few
    // P-frames is far better than OOM/FD exhaustion. The proper fix
    // (cheap keyframe-on-demand without restart) is tracked in MP-14
    // root cause; needs FFmpeg ZMQ/sendcmd integration or libav
    // bindings. Both are days of architectural work.
    var MAX_PENDING_RESTARTS = 4;
    while (this._oldProcesses.length > MAX_PENDING_RESTARTS) {
      var victim = this._oldProcesses.shift();
      // ════════════════════════ DIAGNOSTIC ════════════════════════
      // Eviction = PLI storm faster than old FFmpegs can drain.
      // Seeing this means we're losing P-frames to keep memory bounded.
      console.log('[encoder] EVICT pending old process (PLI STORM) @ ' +
                  new Date().toISOString().slice(11, 23));
      // ════════════════════════════════════════════════════════════
      // Also remove from pending-old set (won't get its output_end now)
      this._transitionPendingOld.delete(victim);
      try { victim.stop(); } catch (e) {}
    }

    // Take a pre-warmed FFmpeg from the pool if available — saves the
    // ~50-100ms spawn + ~200ms FFmpeg startup window. If the pool is
    // empty or has only stale entries, fall back to a fresh spawn
    // (which is what the throttle path used to do unconditionally).
    var warm = this._takeWarmFFmpeg();
    if (warm) {
      // Pool hit: skip _startFFmpeg's spawn step. Just wire the reader
      // onto the warm process and trigger pool refill.
      this._ffmpeg = warm;
      this._reader = null;
      var codecDef = getVideoCodec(this._config.codec, this._config);
      if (codecDef) {
        this.context.encoder = codecDef.encoder;
        this.context.isHardware = codecDef.isHardware;
        this._hwProbing = codecDef.isHardware;
        this._wireReader(codecDef);
      }
      // Refill in background. _wireReader does NOT trigger a refill
      // (refill is in _launchFFmpeg, which we skipped) so we kick it
      // off explicitly here.
      var self_warm = this;
      setImmediate(function () { self_warm._refillWarmPool(); });
    } else {
      // Pool miss: fresh spawn via the standard path. _startFFmpeg is
      // called below because _ffmpeg.running is false on a brand-new
      // FFmpegProcess.
      this._ffmpeg = new FFmpegProcess();
      this._reader = null;
    }
    // _startFFmpeg will be called below if _ffmpeg.running is still false
    }  // end of throttle-cleared else
  }

  // Sweep old processes that finished naturally (no longer running).
  // Their output_end listener will have fired; this just keeps the
  // array from growing unnecessarily.
  for (var ii = this._oldProcesses.length - 1; ii >= 0; ii--) {
    if (!this._oldProcesses[ii].running) {
      this._oldProcesses.splice(ii, 1);
    }
  }

  if (!this._ffmpeg.running) this._startFFmpeg();

  // Buffer frames during HW probe for potential replay
  if (this._hwProbing) {
    var copy = Buffer.allocUnsafe(frame.data.length);
    frame.data.copy(copy);
    this._pendingWrites.push(copy);
  }

  // PTS Injection (architectural fix):
  //
  // FFmpeg receives raw video frames via stdin without per-frame PTS
  // (rawvideo format has no timestamp metadata). It computes output
  // PTS internally from the configured input framerate (`-r`), starting
  // at 0 for each new FFmpeg process. After a keyframe restart, the
  // NEW FFmpeg's first frame would emit PTS=0 — even though the
  // caller fed a frame with timestamp = (e.g.) 1_000_000 µs.
  //
  // Without injection, the receiver would see a timestamp jump backward
  // at the restart boundary, breaking frame-ordering invariants and
  // confusing the receiver-side jitter buffer.
  //
  // The reader emits frames in input order (codecs may reorder for
  // B-frames, but our encoders use B=0 for low-latency / WebRTC). We
  // Backpressure tracking (diagnostic only).
  //
  // The framework's base_coder defines encodeQueueSize as a getter
  // and emits 'dequeue' on its own — we MUST NOT touch them from
  // here (assigning encodeQueueSize throws "has only a getter").
  // We only count write()=false occurrences; for video each frame
  // (~1.4MB I420 at 720p) exceeds Node's highWaterMark (16KB) so
  // this fires often even under healthy operation. The existing
  // _maxQueueSize gate above is the real memory bound.
  // queue input PTS per-FFmpeg instance and replay them onto outputs.
  //
  // The queue is keyed on `this._ffmpeg` so old FFmpegs keep their
  // own queue (their frames still flush after restart).
  if (!this._ffmpeg._inputPtsQueue) {
    this._ffmpeg._inputPtsQueue = [];
    this._ffmpeg._totalInputs = 0;     // monotonic counter, never decreases
  }
  this._ffmpeg._inputPtsQueue.push(frame.timestamp);
  this._ffmpeg._totalInputs++;

  this._queueSize++;
  var ok = this._ffmpeg.write(frame.data);
  this._encodeCount++;
  this.context.frameCount = this._encodeCount;

  if (!ok) {
    this._stats.backpressureEvents++;
  }

  return ok;  // false = backpressure hint, caller may also wait for onDrain
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
  var args = this._buildFFmpegArgs(codecDef);
  this._ffmpeg.start(args, ['pipe', 'ignore', 'pipe', 'pipe']);
  this._wireReader(codecDef);

  // Trigger pool refill in the background. Doing this AFTER the
  // current FFmpeg is up means we never block the foreground path
  // on pool maintenance.
  var self = this;
  setImmediate(function () { self._refillWarmPool(); });
};

/**
 * Build the FFmpeg argv for the encoder's current config + the given
 * codec definition. Pure: no side effects, no use of self._ffmpeg.
 *
 * Refactored out of _launchFFmpeg so the warm pool can pre-spawn
 * processes with the same args.
 */
VideoEncoder.prototype._buildFFmpegArgs = function (codecDef) {
  var self = this;
  var cfg = this._config;

  var containerName = getDefaultContainer(cfg.codec);
  var containerDef = getContainer(containerName);
  if (!containerDef) {
    self._error(new Error('No container for: ' + cfg.codec));
    return null;
  }

  var args = ['-loglevel', cfg.loglevel || 'warning'];
  if (cfg.latencyMode !== 'quality') {
    // -flags low_delay: tells libavcodec to minimize re-ordering delay.
    //
    // Note: -fflags nobuffer was REMOVED (would normally appear as an
    // input flag here). For rawvideo input it's a documented FFmpeg
    // gotcha — the demuxer eagerly EOFs and silently drops the FIRST
    // frame of the stream. Confirmed by repro: feed N rawvideo frames
    // + close stdin → only N-1 frames reach the encoder, with frame 0
    // missing from the decoded output.
    //
    // The flag exists to skip stream-analysis buffering for transport
    // formats (MPEG-TS, RTSP, RTMP). rawvideo has no analysis to skip
    // (every frame is exactly width*height*pix_fmt bytes), so nobuffer
    // is a pure no-op for latency on this input. Measurement: 30 frames
    // at 30fps fed through a Node pipe, averaged over 5 runs each:
    //   with    -fflags nobuffer: 29/30 AUDs, 289 ms first-frame latency
    //   without -fflags nobuffer: 30/30 AUDs, 263 ms first-frame latency
    // i.e. removing it is strictly better on both axes.
    args.push('-flags', 'low_delay');
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

  return args;
};

/**
 * Wire the reader and event listeners onto self._ffmpeg.
 *
 * Must be called AFTER self._ffmpeg has been started (or swapped in
 * from the warm pool). Captures `producingFfmpeg = self._ffmpeg` in
 * the closure so the reader stays bound to its specific instance even
 * across subsequent restarts.
 */
VideoEncoder.prototype._wireReader = function (codecDef) {
  var self = this;
  var cfg = this._config;
  var containerName = getDefaultContainer(cfg.codec);
  var containerDef = getContainer(containerName);

  var gotOutput = false;
  var svcPat = self._svcPattern;

  if (containerDef.createReader) {
    var reader = containerDef.createReader({ codec: cfg.codec, fps: cfg.framerate });
    self._reader = reader;

    // Capture this FFmpeg ref at reader-creation time. The closure
    // outlives _startFFmpeg; if a restart happens, self._ffmpeg
    // points at the NEW process, but THIS reader is still bound to
    // its original (now-old) FFmpeg. We need to emit frames tagged
    // with their producing FFmpeg so _emitEncoded can decide
    // (current/new = maybe-buffer, old = always-direct).
    var producingFfmpeg = self._ffmpeg;

    reader.on('video', function (f) {
      if (self._hwProbing && !gotOutput) {
        gotOutput = true;
        self._hwProbing = false;
        self._pendingWrites = [];
      }
      if (f.isKeyframe) self.context.keyframeCount++;

      // PTS injection: replace the reader's counter-based ptsUs with
      // the actual input timestamp from the encoder's queue. The queue
      // is per-FFmpeg-instance (producingFfmpeg._inputPtsQueue) so old
      // FFmpegs draining after restart use their own queue and emit
      // correct timestamps for their trailing frames.
      //
      // Fallback: if the queue is empty (rare — possible if FFmpeg
      // emits more frames than were fed, e.g. duplicates), fall back
      // to reader's counter-based PTS so we don't crash.
      var realPts;
      if (producingFfmpeg._inputPtsQueue && producingFfmpeg._inputPtsQueue.length > 0) {
        realPts = producingFfmpeg._inputPtsQueue.shift();
      } else {
        realPts = f.ptsUs;
      }

      // Track this output against its producing FFmpeg's count.
      // If it's an OLD ffmpeg in pendingOld, we may have hit the
      // drain target → trigger _onOldDrained synchronously (race-free).
      producingFfmpeg._outputCount = (producingFfmpeg._outputCount || 0) + 1;

      var chunk = new EncodedVideoChunk({
        type: f.isKeyframe ? 'key' : 'delta',
        timestamp: realPts,
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

      self._emitEncoded(chunk, metadata, producingFfmpeg);
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

// ── Warm pool methods (MP-14 Layer 2) ─────────────────────────────────

/**
 * Compute a fingerprint string for the current encoder config.
 * The pool is invalidated whenever this changes — e.g., reconfigure
 * to a different resolution, or codec swap. Includes everything the
 * built FFmpeg argv depends on.
 */
VideoEncoder.prototype._computeConfigFingerprint = function () {
  var cfg = this._config;
  if (!cfg) return null;
  return JSON.stringify({
    codec:       cfg.codec,
    width:       cfg.width,
    height:      cfg.height,
    framerate:   cfg.framerate,
    pixelFormat: this._inputPixelFormat,
    latencyMode: cfg.latencyMode,
    loglevel:    cfg.loglevel,
    codecOptions: cfg.codecOptions || null,
    svc:         this._svcPattern ? this._svcPattern.keyExpr : null,
    // Note: bitrate/CRF differences live in the codec args via
    // getVideoCodec() — capturing the codec name is sufficient because
    // codec swaps go through configure() which already drains the pool.
  });
};

/**
 * Top up the warm pool to WARM_POOL_TARGET. Async (subprocess spawn
 * isn't free), but never blocks the foreground encode path. Concurrent
 * calls coalesce via _warmPoolFilling.
 */
VideoEncoder.prototype._refillWarmPool = function () {
  var self = this;
  if (self._warmPoolFilling) return;
  if (!self._config) return;
  if (self._state === 'closed') return;
  if (self.WARM_POOL_TARGET <= 0) return;
  if (self._warmPool.length >= self.WARM_POOL_TARGET) return;

  var codecDef = getVideoCodec(self._config.codec, self._config);
  if (!codecDef) return;
  var args = self._buildFFmpegArgs(codecDef);
  if (!args) return;
  var fingerprint = self._computeConfigFingerprint();

  self._warmPoolFilling = true;

  // Spawn one. If we still need more after this, schedule another
  // refill — keeps the spawn cost spread out across the event loop.
  var ffmpeg = new FFmpegProcess();
  try {
    ffmpeg.start(args, ['pipe', 'ignore', 'pipe', 'pipe']);
  } catch (e) {
    self._warmPoolFilling = false;
    return;
  }

  // Suppress errors on warm processes — they're idle, anything that
  // happens to them is by definition not affecting active encoding.
  // If a warm process dies before being taken, we just discard it
  // on the next take and refill.
  ffmpeg.on('error', function () {});
  ffmpeg.on('close', function () {});

  self._warmPool.push({
    ffmpeg:      ffmpeg,
    fingerprint: fingerprint,
    spawnedAt:   Date.now(),
  });
  self._warmPoolFilling = false;

  // Schedule another fill if we're still under target.
  if (self._warmPool.length < self.WARM_POOL_TARGET && self._state !== 'closed') {
    setImmediate(function () { self._refillWarmPool(); });
  }
};

/**
 * Pop a warm FFmpeg whose fingerprint matches the current config.
 * Returns the FFmpegProcess instance (already spawned, pipes open) or
 * null if the pool is empty / has only stale entries.
 *
 * Stale entries (config changed, FFmpeg died) are discarded as a
 * side effect — the pool self-heals on every take.
 */
VideoEncoder.prototype._takeWarmFFmpeg = function () {
  var currentFp = this._computeConfigFingerprint();
  while (this._warmPool.length > 0) {
    var entry = this._warmPool.shift();
    var ok = entry.ffmpeg.running && entry.fingerprint === currentFp;
    if (ok) {
      this._stats.warmPoolHits++;
      return entry.ffmpeg;
    }
    // Stale or dead — kill and discard.
    try { entry.ffmpeg.stop(); } catch (e) {}
  }
  this._stats.warmPoolMisses++;
  return null;
};

/**
 * Stop and discard all warm processes. Called from close()/reset() to
 * reclaim resources, and from configure() if the new config has a
 * different fingerprint (taking the simple path of dropping all rather
 * than keeping fingerprint-matching ones — reconfigures are rare).
 */
VideoEncoder.prototype._drainWarmPool = function () {
  while (this._warmPool.length > 0) {
    var entry = this._warmPool.shift();
    try { entry.ffmpeg.stop(); } catch (e) {}
  }
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
