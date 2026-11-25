/**
 * base_coder — Shared state machine and FFmpeg lifecycle.
 *
 * Improvements:
 *  - flush() ends stdin and waits for FFmpeg close, but doesn't kill
 *  - encodeQueueSize / decodeQueueSize tracking via write backpressure
 *  - checkFFmpeg on first use
 */

import FFmpegProcess from './ffmpeg_process.js';

/**
 * Build a DOMException-shaped error. WebCodecs spec mandates DOMException
 * on state violations (InvalidStateError) and config violations
 * (NotSupportedError). Node has globalThis.DOMException since 17.0; fall
 * back to a tagged Error for older runtimes.
 */
function _domex(msg, name) {
  if (typeof DOMException !== 'undefined') return new DOMException(msg, name);
  var e = new Error(msg);
  e.name = name || 'InvalidStateError';
  return e;
}

// ── W3C WebCodecs §3.6 / §4.6 / §5.6 / §6.6 "Schedule Dequeue Event" ──
//
//   1. If [[dequeue event scheduled]] equals true, return.
//   2. Assign true to [[dequeue event scheduled]].
//   3. Queue a task to run the following steps:
//      1. Fire a simple event named dequeue at this.
//      2. Assign false to [[dequeue event scheduled]].
//
// A dequeue event was dispatched synchronously after every output (and
// one per reset); outputs that come out before the task runs now share
// one event, which reads the queue size as it is then. "Queue a task" is
// setImmediate: a macrotask after the current one (an FFmpeg 'data'
// callback that may deliver many outputs) and after its microtasks (a
// flush promise settled by the same outputs) — queueMicrotask would run
// inside that callback's turn and coalesce nothing across it, and
// setTimeout(0) waits a timer tick (1 ms) for no reason. The event was
// dispatched with no argument, so `e.type` in a handler was a TypeError
// on undefined. A listener that throws does not leave the flag set (DOM
// dispatch reports a listener's exception and goes on).
function scheduleDequeue(self) {
  if (self._dequeueEventScheduled) return;
  self._dequeueEventScheduled = true;
  setImmediate(function () {
    try {
      if (self.dispatchEvent) self.dispatchEvent('dequeue', { type: 'dequeue', target: self });
    } finally {
      self._dequeueEventScheduled = false;
    }
  });
}

function initCoder(self, init) {
  var userOutput = (init && init.output) || function () {};
  // Wrap output to fire 'dequeue' event + forward metadata arg.
  // W3C WebCodecs §encodeQueueSize: "decreases when an output() callback fires."
  // (NOT when raw FFmpeg stdout bytes arrive — those are bytes, not frames.)
  // Decrement here, in the per-frame output path; the FFmpeg-data handler in
  // wireReader no longer touches _queueSize.
  self._output = function (chunk, metadata) {
    // A coder whose outputs do not map one-to-one to its inputs (the
    // AudioDecoder: 10 ms outputs from 20 ms packets) sets _queueByInput
    // and decrements per input consumed instead.
    if (!self._queueByInput && self._queueSize > 0) self._queueSize--;
    self._stats.outputCount++;
    userOutput(chunk, metadata);
    // W3C WebCodecs fires a plain Event named "dequeue" on the codec
    // (Schedule Dequeue Event, below: one at a time, as a task).
    scheduleDequeue(self);
  };
  // Wrap the user's error callback so _stats.errorCount is real.
  // It was declared in _stats below and never incremented anywhere in
  // the codebase, so `encoder.stats.errorCount` always read 0 — which
  // is worse than not exposing it, because it looks like a healthy
  // signal. Wrapping here catches every _error() call site at once.
  var userError = (init && init.error) || function () {};
  self._error = function (e) {
    self._stats.errorCount++;
    userError(e);
  };
  self._state = 'unconfigured';
  self._config = null;
  self._ffmpeg = new FFmpegProcess(init);
  self._reader = null;
  self._queueSize = 0;
  self._dequeueEventScheduled = false;   // W3C [[dequeue event scheduled]]
  self._eventListeners = {};

  // Production monitoring
  self._stats = {
    encodeCount: 0,      // total encode() calls
    outputCount: 0,      // total output callbacks fired
    errorCount: 0,       // total errors
    droppedCount: 0,     // frames dropped due to queue overflow
    startTime: 0,        // Date.now() of first encode()
    lastEncodeTime: 0,   // Date.now() of last encode()
  };
  self._maxQueueSize = (init && init.maxQueueSize) || 0;  // 0 = unlimited
  self._flushTimeout = (init && init.flushTimeout) || FLUSH_TIMEOUT;
}

/**
 * Detach every listener a coder puts on its FFmpegProcess. The process
 * object outlives the FFmpeg runs it hosts — each flush() ends a run, and
 * the next decode()/encode() starts another on the same object — and each
 * _startFFmpeg() attaches its listeners afresh. Only 'data', 'error' and
 * 'close' were ever removed (and only on configure/close/reset, never
 * between runs), so after N flushes a decoder had N 'data' (video) or
 * 'stdout' (audio) listeners all feeding the same frame queue: every
 * frame came out N times (3, 6, 9, 12 for a 3-frame clip), and the
 * stale 'ffmpeg:log' size watchers and exit watchers piled up alongside.
 */
var CODER_EVENTS = ['data', 'stdout', 'error', 'close', 'ffmpeg:log', 'ffmpeg:warning'];
function detachCoderListeners(ffmpeg) {
  for (var i = 0; i < CODER_EVENTS.length; i++) ffmpeg.removeAllListeners(CODER_EVENTS[i]);
}

function configureCoder(self) {
  // W3C WebCodecs: if [[state]] is "closed", configure() throws
  // InvalidStateError DOMException. The previous behavior silently
  // resurrected the encoder, leaking the user's expectation that
  // close() is terminal.
  if (self._state === 'closed') {
    throw _domex('Cannot configure a closed coder', 'InvalidStateError');
  }
  // The queue size goes to 0 with the run it stops (its outputs will not
  // come); a configure() made after the previous run had finished (held
  // behind it, see drainThen) keeps the count of the calls held after it.
  if (self._state === 'configured' && self._ffmpeg.running) self._queueSize = 0;
  if (self._state === 'configured') {
    self._ffmpeg.stop();
    detachCoderListeners(self._ffmpeg);
    self._reader = null;
  }
  self._state = 'configured';
  self._configEpoch = (self._configEpoch || 0) + 1;
}

var FLUSH_TIMEOUT = 10000;

// ── FFmpeg failing is a codec error ──
//
// FFmpeg exiting on its own with a non-zero code (or killed by a signal)
// means the codec is gone: the encoder failed to open (libx265 refusing
// more than 16 frame threads, an unsupported profile, ...), or it died
// mid-stream. Nothing listened for that. The coder stayed 'configured';
// the next encode()/decode() saw `!running` and spawned a fresh FFmpeg,
// which failed the same way — one doomed process per frame — the queue
// size grew forever, flush() RESOLVED as if every frame had come out,
// and the error callback was never called. A caller had no way to learn
// that not one chunk would ever be produced.
//
// W3C WebCodecs: an encoding/decoding failure runs "close VideoEncoder
// (VideoDecoder, ...) with an EncodingError" — pending flush() promises
// are rejected with it, [[state]] becomes "closed" (so further encode()
// throws InvalidStateError instead of respawning), and the error
// callback is invoked with it. failCoder() is that algorithm.

/** The EncodingError for an FFmpeg exit, or null for a clean one (code 0). */
function exitError(code, signal, ffmpeg) {
  if (code === 0 && !signal) return null;
  var why = (ffmpeg && ffmpeg.lastError) || '';
  return _domex('FFmpeg exited ' + (signal ? 'on signal ' + signal : 'with code ' + code) +
                (why ? ': ' + why : ''), 'EncodingError');
}

// Pending flush() completions. Each is fn(err): err rejects that flush.
function addPendingFlush(self, fn) {
  (self._pendingFlushes = self._pendingFlushes || []).push(fn);
}
function removePendingFlush(self, fn) {
  var a = self._pendingFlushes;
  if (!a) return;
  var i = a.indexOf(fn);
  if (i >= 0) a.splice(i, 1);
}
function rejectPendingFlushes(self, err) {
  var a = self._pendingFlushes;
  self._pendingFlushes = [];
  for (var i = 0; a && i < a.length; i++) {
    try { a[i](err); } catch (e) {}
  }
}

/** InvalidStateError for a call that needs [[state]] "configured", else null. */
function notConfiguredError(self, what) {
  if (self._state === 'configured') return null;
  return _domex(what + '() needs state "configured", not "' + self._state + '"', 'InvalidStateError');
}

/** "Close the codec with `err`" — see the block above. Idempotent. */
function failCoder(self, err) {
  if (self._state === 'closed') return;
  self._fatalError = err;
  rejectPendingFlushes(self, err);
  self.close();   // the coder's own close(): stops every FFmpeg it owns
  self._error(err);
}

/** Watch the current FFmpeg for exiting on its own with a failure. */
function watchExit(self) {
  var ffmpeg = self._ffmpeg;
  ffmpeg.on('close', function (code, signal) {
    var err = exitError(code, signal, ffmpeg);
    if (err) failCoder(self, err);
  });
}

/**
 * Flush: end FFmpeg stdin, wait for FFmpeg to exit, then complete —
 * resolved on a clean exit, rejected (failCoder) on a failed one.
 * Timeout kills hung processes.
 */
function flushCoder(self, cb) {
  if (self._ffmpeg.running) {
    var done = false;

    // All three completion signals are attached together and MUST be
    // detached together.
    //
    // Previously each handler removed only itself, so the two that
    // didn't fire stayed attached for the lifetime of the FFmpegProcess.
    // Every flush() leaked two listeners plus their closures (which
    // capture `cb`, `timer` and `done`). A long-running pipeline that
    // flushes per segment — HLS, or any keyframe-boundary muxing —
    // accumulates them indefinitely, and Node starts printing
    // MaxListenersExceededWarning long before the memory shows up
    // anywhere obvious.
    var timer = null;
    function cleanup() {
      if (timer) { clearTimeout(timer); timer = null; }
      self._ffmpeg.off('output_end', onEnd);
      self._ffmpeg.off('stdout_end', onStdEnd);
      self._ffmpeg.off('close', onClose);
    }

    function finish(stopProcess, err) {
      if (done) return;
      done = true;
      cleanup();
      removePendingFlush(self, onFail);
      if (err) { if (cb) cb(err); return; }   // rejected: state is failCoder's/close()'s
      if (stopProcess) self._ffmpeg.stop();
      self._state = 'configured';
      self._queueSize = self._heldWork || 0;
      if (cb) cb();
      releaseCalls(self);
    }

    // output_end = pipe:3 EOF, stdout_end = pipe:1 EOF (audio decoder),
    // close = fallback when neither pipe exists (raw passthrough).
    // The flush completes on 'close', which carries the exit code — not on
    // output_end/stdout_end (the output pipe's EOF), which come FIRST:
    // FFmpeg failing at the end of input closed the pipe, the flush
    // resolved, and only then did the exit code say nothing had been
    // encoded. Node emits 'close' after every stdio stream has closed, so
    // all output has been delivered by then. A failed exit is failCoder's
    // (watchExit): it rejects this flush via onFail.
    function onEnd()    { /* wait for 'close' and its exit code */ }
    function onStdEnd() { /* wait for 'close' and its exit code */ }
    function onClose(code, signal) { if (!exitError(code, signal)) finish(false); }
    function onFail(err) { finish(false, err); }
    addPendingFlush(self, onFail);

    timer = setTimeout(function () { finish(true); }, self._flushTimeout || FLUSH_TIMEOUT);

    self._ffmpeg.on('output_end', onEnd);
    self._ffmpeg.on('stdout_end', onStdEnd);
    self._ffmpeg.on('close', onClose);

    self._ffmpeg.endInput();
    // The calls made from now until this run has exited wait for it
    // (holdCalls): they went to an FFmpeg whose input was ended — lost.
    holdCalls(self);
    return;
  }
  if (cb) cb();
}

// ── Calls made while a flush() is in progress ──
//
// W3C: flush() is a control message like the others — the encode() /
// decode() / configure() / flush() calls after it are queued behind it
// and run once it is done. Here a flush ends FFmpeg's input and waits for
// it to exit, and those calls went to that FFmpeg: encode() of 3 frames,
// flush(), encode() of 2 more, flush() — 3 chunks out, both flushes
// resolved, the 2 frames gone (write() on an ended stdin returns false).
// They are held now (their synchronous checks made at the call, as the
// spec's are) and made in order once the flush has resolved; reset(),
// close() and a codec failure drop them, as they do the spec's control
// messages. Also used while a configure() that is not supported waits
// for its close (failCoder drops them).
function holdCalls(self) { if (!self._held) { self._held = []; self._heldWork = 0; } }
function holdingCalls(self) { return !!self._held; }
/** Hold `fn`; `work`: it is an encode()/decode() (counted in the queue size). */
function holdCall(self, fn, work) {
  self._held.push(fn);
  if (work) self._heldWork++;
}
function releaseCalls(self) {
  var q = self._held;
  self._held = null;
  self._heldWork = 0;
  for (var i = 0; q && i < q.length; i++) {
    if (self._state === 'closed') return;
    if (self._held) { self._held.push(q[i]); continue; }   // a held flush() holds the rest again
    q[i]();
  }
}
function dropCalls(self) { self._held = null; self._heldWork = 0; }

/**
 * A flush() made while calls are held: queued like them. `run(cb)` is
 * the flush itself; until then the promise is pending — reset()/close()
 * reject it (AbortError) and failCoder with its error.
 */
function holdFlush(self, run, cb) {
  var settled = false;
  function onFail(err) { if (settled) return; settled = true; cb(err); }
  addPendingFlush(self, onFail);
  holdCall(self, function () {
    removePendingFlush(self, onFail);
    if (settled) return;
    settled = true;
    run(cb);
  }, false);
}

// ── configure() with a config the codecs cannot do ──
//
// W3C: configure() sets [[state]] "configured" and queues the configure
// control message; when Check Configuration Support says no, that message
// closes the coder with a NotSupportedError (a queued task). Calls made
// before then are queued behind it (held here) and go with the close.
function failUnsupported(self, err, draining) {
  var epoch = self._configEpoch;
  holdCalls(self);
  function fail() {
    if (self._configEpoch !== epoch || self._state !== 'configured') return;
    failCoder(self, err);
  }
  // Runs of the previous configuration still finishing (a reconfigure
  // retires them, VideoEncoder): their outputs come before the close.
  var left = 0;
  for (var i = 0; draining && i < draining.length; i++) {
    if (!draining[i].running) continue;
    left++;
    draining[i].on('close', function () { if (--left === 0) fail(); });
  }
  if (!left) queueMicrotask(fail);
}

/**
 * A configure() on a running coder (AudioEncoder, AudioDecoder): the
 * calls made before it finish in the running FFmpeg — end its input and
 * hold `fn` (the configure) and every later call until it has exited
 * cleanly. configureCoder() used to stop it, and whatever was still
 * inside was lost (W3C: configure() is queued behind the encode() /
 * decode() calls before it; their outputs come first). A failed exit is
 * failCoder's (watchExit).
 */
function drainThen(self, fn) {
  var proc = self._ffmpeg;
  holdCalls(self);
  holdCall(self, fn, false);
  var epoch = self._configEpoch;
  proc.on('close', function (code, signal) {
    if (exitError(code, signal) || self._configEpoch !== epoch || self._state !== 'configured') return;
    self._queueSize = self._heldWork || 0;
    releaseCalls(self);
  });
  proc.endInput();
}

// W3C: close() and reset() reject a pending flush() with an AbortError.
// They used to drop its listeners and leave it hanging until the flush
// timeout — which then resolved it and set [[state]] back to
// 'configured' on a closed coder.
function _abortError() { return _domex('Aborted due to close() or reset()', 'AbortError'); }

// W3C Reset / Close: on a closed coder an InvalidStateError (close() is
// final: reset() set a closed coder back to "unconfigured", close() twice
// passed). A queue size above 0 goes to 0 with a dequeue event (it went
// to 0 silently): Reset VideoEncoder step 7 "If [[encodeQueueSize]] is
// greater than zero: Set [[encodeQueueSize]] to zero. Run the Schedule
// Dequeue Event algorithm." (the same in the other three).
function _checkNotClosed(self, what) {
  if (self._state === 'closed') throw _domex('Cannot ' + what + ' a closed coder', 'InvalidStateError');
}
function resetQueue(self) {
  dropCalls(self);
  self._configEpoch = (self._configEpoch || 0) + 1;
  if (self._queueSize > 0) {
    self._queueSize = 0;
    scheduleDequeue(self);
  }
}

function closeCoder(self) {
  _checkNotClosed(self, 'close');
  resetQueue(self);
  rejectPendingFlushes(self, _abortError());
  self._ffmpeg.stop();
  detachCoderListeners(self._ffmpeg);
  self._reader = null;
  self._state = 'closed';
  self._queueSize = 0;
}

function resetCoder(self) {
  _checkNotClosed(self, 'reset');
  resetQueue(self);
  rejectPendingFlushes(self, _abortError());
  self._ffmpeg.stop();
  detachCoderListeners(self._ffmpeg);
  self._reader = null;
  self._state = 'unconfigured';
  self._config = null;
  self._queueSize = 0;
}

/**
 * Wire FFmpeg output to reader, reader events to output callback.
 * Also handles stderr events.
 *
 * Note: queueSize is NOT decremented here. Per W3C WebCodecs spec,
 * encodeQueueSize/decodeQueueSize should track FRAMES (one decrement
 * per output() callback), not raw FFmpeg stdout bytes. The decrement
 * happens in the wrapped self._output set by initCoder().
 */
function wireReader(self, reader, eventMap) {
  self._reader = reader;
  for (var ev in eventMap) {
    if (Object.prototype.hasOwnProperty.call(eventMap, ev)) {
      reader.on(ev, eventMap[ev]);
    }
  }
  self._ffmpeg.on('data', function (chunk) {
    if (self._reader) self._reader.feed(chunk);
  });
  self._ffmpeg.on('error', function (e) {
    self._error(e);
  });
}

/**
 * Apply standard coder prototype methods.
 *
 * Per W3C WebCodecs spec, encoders expose only `encodeQueueSize` and
 * decoders expose only `decodeQueueSize`. Mixing them on the same
 * prototype breaks feature detection (`'decodeQueueSize' in encoder`
 * incorrectly returns true). Callers pass options.role = 'encoder' or
 * 'decoder' to get the right surface; a caller that omits it still
 * gets both, which is the pre-role behaviour.
 *
 * NOTE: all four in-tree call sites now pass a role. Until this change
 * none of them did, so every codec class exposed BOTH properties and
 * the feature-detection fix this parameter exists for was inert. The
 * doc block here also promised "a one-time deprecation warning on first
 * access of the wrong-side property" — no such warning was ever
 * implemented. Rather than add a warning nothing can now trigger, the
 * claim is removed.
 *
 * Includes:
 *  - flush() → Promise (browser-compatible) + callback backward compat
 *  - addEventListener / removeEventListener (EventTarget)
 *  - dequeue event (scheduled when output is produced: scheduleDequeue)
 */
function applyCoderPrototype(Ctor, options) {
  var role = options && options.role;   // 'encoder' | 'decoder' | undefined
  // flush: returns Promise if no callback, or uses callback
  Ctor.prototype.flush = function (cb) {
    var self = this;
    // W3C: flush() on a coder that is not "configured" rejects with an
    // InvalidStateError. It resolved — on a closed coder too, so after
    // failCoder had closed it a later flush() reported success.
    var stateErr = notConfiguredError(self, 'flush');
    if (stateErr) {
      if (typeof cb === 'function') { cb(stateErr); return; }
      return Promise.reject(stateErr);
    }
    // W3C (decoders): flush() sets [[key chunk required]] when it is
    // called — it was set when the flush completed, so a delta chunk
    // decoded right after flush() passed.
    if (typeof self._keyChunkRequired === 'boolean') self._keyChunkRequired = true;
    var run = function (done) { flushCoder(self, done); };
    if (typeof cb === 'function') {
      if (holdingCalls(self)) holdFlush(self, run, cb); else run(cb);   // cb(err): err set when rejected
      return;
    }
    return new Promise(function (resolve, reject) {
      var done = function (err) { if (err) reject(err); else resolve(); };
      if (holdingCalls(self)) holdFlush(self, run, done); else run(done);
    });
  };

  Ctor.prototype.close = function () { closeCoder(this); this.context.state = 'closed'; };
  Ctor.prototype.reset = function () { resetCoder(this); this.context.state = 'unconfigured'; };
  Ctor.prototype.onDrain = function (cb) { this._ffmpeg.onDrain(cb); };

  // Output backpressure — delegates to FFmpegProcess
  Ctor.prototype.pauseOutput = function () {
    if (this._ffmpeg) this._ffmpeg.pauseOutput();
  };
  Ctor.prototype.resumeOutput = function () {
    if (this._ffmpeg) this._ffmpeg.resumeOutput();
  };

  // W3C WebCodecs: encoders get encodeQueueSize, decoders get decodeQueueSize.
  // Only define the property that matches the role (or both, for legacy
  // callers who didn't specify). This keeps `'decodeQueueSize' in encoder`
  // correctly false for spec-compliant encoders.
  if (role !== 'decoder') {
    Object.defineProperty(Ctor.prototype, 'encodeQueueSize', {
      get: function () { return this._queueSize; },
    });
  }
  if (role !== 'encoder') {
    Object.defineProperty(Ctor.prototype, 'decodeQueueSize', {
      get: function () { return this._queueSize; },
    });
  }

  /**
   * Production monitoring stats. Non-standard.
   * @returns {{ encodeCount, outputCount, errorCount, droppedCount, startTime, lastEncodeTime }}
   */
  Object.defineProperty(Ctor.prototype, 'stats', {
    get: function () { return Object.assign({}, this._stats); },
  });

  // EventTarget interface (browser-compatible)
  Ctor.prototype.addEventListener = function (type, listener) {
    if (!this._eventListeners) this._eventListeners = {};
    if (!this._eventListeners[type]) this._eventListeners[type] = [];
    this._eventListeners[type].push(listener);
  };

  Ctor.prototype.removeEventListener = function (type, listener) {
    if (!this._eventListeners || !this._eventListeners[type]) return;
    var arr = this._eventListeners[type];
    for (var i = arr.length - 1; i >= 0; i--) {
      if (arr[i] === listener) { arr.splice(i, 1); break; }
    }
  };

  Ctor.prototype.dispatchEvent = function (type, data) {
    if (!this._eventListeners || !this._eventListeners[type]) return;
    var arr = this._eventListeners[type];
    for (var i = 0; i < arr.length; i++) arr[i](data);
  };

  Object.defineProperty(Ctor.prototype, 'state', {
    get: function () { return this._state; },
  });

  // ondequeue handler property (browser-compatible)
  Object.defineProperty(Ctor.prototype, 'ondequeue', {
    get: function () { return this._ondequeue || null; },
    set: function (fn) {
      if (this._ondequeue) this.removeEventListener('dequeue', this._ondequeue);
      this._ondequeue = fn;
      if (fn) this.addEventListener('dequeue', fn);
    },
  });
}

export {
  holdCalls, holdingCalls, holdCall, holdFlush, releaseCalls, dropCalls, failUnsupported, resetQueue, drainThen, _domex as domex,
  scheduleDequeue,
  initCoder, configureCoder, flushCoder, closeCoder, resetCoder, wireReader, applyCoderPrototype,
  exitError, failCoder, watchExit, detachCoderListeners, notConfiguredError, addPendingFlush, removePendingFlush, rejectPendingFlushes,
};
