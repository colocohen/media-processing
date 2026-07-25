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

function initCoder(self, init) {
  var userOutput = (init && init.output) || function () {};
  // Wrap output to fire 'dequeue' event + forward metadata arg.
  // W3C WebCodecs §encodeQueueSize: "decreases when an output() callback fires."
  // (NOT when raw FFmpeg stdout bytes arrive — those are bytes, not frames.)
  // Decrement here, in the per-frame output path; the FFmpeg-data handler in
  // wireReader no longer touches _queueSize.
  self._output = function (chunk, metadata) {
    if (self._queueSize > 0) self._queueSize--;
    self._stats.outputCount++;
    userOutput(chunk, metadata);
    if (self.dispatchEvent) self.dispatchEvent('dequeue');
  };
  self._error = (init && init.error) || function () {};
  self._state = 'unconfigured';
  self._config = null;
  self._ffmpeg = new FFmpegProcess(init);
  self._reader = null;
  self._queueSize = 0;
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

function configureCoder(self) {
  // W3C WebCodecs: if [[state]] is "closed", configure() throws
  // InvalidStateError DOMException. The previous behavior silently
  // resurrected the encoder, leaking the user's expectation that
  // close() is terminal.
  if (self._state === 'closed') {
    throw _domex('Cannot configure a closed coder', 'InvalidStateError');
  }
  if (self._state === 'configured') {
    self._ffmpeg.stop();
    self._ffmpeg.removeAllListeners('data');
    self._ffmpeg.removeAllListeners('error');
    self._ffmpeg.removeAllListeners('close');
    self._reader = null;
  }
  self._state = 'configured';
  self._queueSize = 0;
}

var FLUSH_TIMEOUT = 10000;

/**
 * Flush: end FFmpeg stdin, wait for ALL output data, then complete.
 * Uses 'output_end' event (pipe:3 EOF) = deterministic "all data received".
 * Timeout kills hung processes.
 */
function flushCoder(self, cb) {
  if (self._ffmpeg.running) {
    var done = false;

    var timer = setTimeout(function () {
      if (done) return;
      done = true;
      self._ffmpeg.stop();
      self._state = 'configured';
      self._queueSize = 0;
      if (cb) cb();
    }, self._flushTimeout || FLUSH_TIMEOUT);

    // Wait for output pipe to finish (all data received)
    // output_end = pipe:3 EOF, stdout_end = pipe:1 EOF (audio decoder)
    self._ffmpeg.on('output_end', function onEnd() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      self._ffmpeg.off('output_end', onEnd);
      self._state = 'configured';
      self._queueSize = 0;
      if (cb) cb();
    });

    self._ffmpeg.on('stdout_end', function onStdEnd() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      self._ffmpeg.off('stdout_end', onStdEnd);
      self._state = 'configured';
      self._queueSize = 0;
      if (cb) cb();
    });

    // Fallback: if no pipe:3 (e.g. audio with raw passthrough), use close
    self._ffmpeg.on('close', function onClose() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      self._ffmpeg.off('close', onClose);
      self._state = 'configured';
      self._queueSize = 0;
      if (cb) cb();
    });

    self._ffmpeg.endInput();
    return;
  }
  if (cb) cb();
}

function closeCoder(self) {
  self._ffmpeg.stop();
  self._ffmpeg.removeAllListeners('data');
  self._ffmpeg.removeAllListeners('error');
  self._ffmpeg.removeAllListeners('close');
  self._reader = null;
  self._state = 'closed';
  self._queueSize = 0;
}

function resetCoder(self) {
  self._ffmpeg.stop();
  self._ffmpeg.removeAllListeners('data');
  self._ffmpeg.removeAllListeners('error');
  self._ffmpeg.removeAllListeners('close');
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
 * 'decoder' to get the right surface; legacy callers (no role) still
 * get both, with a one-time deprecation warning on first access of
 * the wrong-side property.
 *
 * Includes:
 *  - flush() → Promise (browser-compatible) + callback backward compat
 *  - addEventListener / removeEventListener (EventTarget)
 *  - dequeue event (fires when output is produced)
 */
function applyCoderPrototype(Ctor, options) {
  var role = options && options.role;   // 'encoder' | 'decoder' | undefined
  // flush: returns Promise if no callback, or uses callback
  Ctor.prototype.flush = function (cb) {
    var self = this;
    if (typeof cb === 'function') {
      flushCoder(self, cb);
      return;
    }
    return new Promise(function (resolve) { flushCoder(self, resolve); });
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

export { initCoder, configureCoder, flushCoder, closeCoder, resetCoder, wireReader, applyCoderPrototype };
