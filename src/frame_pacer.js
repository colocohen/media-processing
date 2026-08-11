/**
 * FramePacer — Real-time frame delivery at fixed FPS with backpressure.
 *
 * Calls your callback at exact intervals, pausing when the consumer
 * signals backpressure and resuming on drain.
 *
 * Scheduling uses target-time instead of fixed intervals (was: setInterval
 * with Math.round(1000/fps), which drifted ~500 ms over 60 s at 24 fps —
 * MP-25). Each tick computes the next target time from the start anchor
 * plus elapsed frame count, and uses setTimeout with the appropriate
 * remainder. This keeps long-term timing accurate to within one ms even
 * when the event loop is busy or the system is under load.
 *
 * Usage:
 *   var pacer = new FramePacer({ fps: 30 });
 *
 *   pacer.start(function(frameIndex) {
 *     var frame = makeFrame(frameIndex);
 *     var ok = encoder.encode(frame);
 *     if (!ok) {
 *       pacer.pause();
 *       encoder.onDrain(function() { pacer.resume(); });
 *     }
 *   });
 *
 *   // later:
 *   pacer.stop();
 */

// monotonic time source — performance.now() on Node 16+, falls back to
// Date.now() (which is wall-clock, slightly less accurate but close enough)
var _now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
  ? function () { return performance.now(); }
  : function () { return Date.now(); };

// If we fall this far behind target (system suspended, GC pause), reset
// the anchor instead of firing a burst of N catch-up frames.
var MAX_CATCH_UP_MS = 500;


function FramePacer(opts) {
  if (!opts) opts = {};
  this._fps = (typeof opts.fps === 'number' && opts.fps > 0) ? opts.fps : 30;
  this._frameDurMs = 1000 / this._fps;            // exact, no Math.round
  this._timer = null;
  this._frameIndex = 0;
  this._callback = null;
  this._running = false;

  // Anchor for target-time scheduling. _anchorMs is the time at which
  // frame 0 was (or will be) emitted; subsequent frames target
  // _anchorMs + (k * _frameDurMs).
  this._anchorMs = 0;
  this._sinceAnchorIndex = 0;  // resets to 0 across pause/resume cycles
}

/**
 * Start pacing. Calls cb(frameIndex) at the configured FPS.
 * @param {function} cb — called with (frameIndex) for each tick
 */
FramePacer.prototype.start = function (cb) {
  if (this._running) return;
  if (typeof cb !== 'function') {
    throw new TypeError('FramePacer.start: callback must be a function');
  }
  this._callback = cb;
  this._running = true;
  this._frameIndex = 0;
  this._anchorMs = _now();
  this._sinceAnchorIndex = 0;
  this._scheduleNext();
};

/**
 * Pause delivery (backpressure). Call resume() when ready.
 */
FramePacer.prototype.pause = function () {
  if (this._timer !== null) {
    clearTimeout(this._timer);
    this._timer = null;
  }
};

/**
 * Resume delivery after pause.
 *
 * Re-anchors to the current time so that resumed pacing starts a fresh
 * cadence rather than firing a burst to "catch up" the missed frames.
 * frameIndex resumes from where it left off — only the *timing* anchor
 * is reset.
 */
FramePacer.prototype.resume = function () {
  if (!this._running) return;
  if (this._timer !== null) return;
  this._anchorMs = _now();
  this._sinceAnchorIndex = 0;
  this._scheduleNext();
};

/**
 * Stop completely. Reset frame index.
 */
FramePacer.prototype.stop = function () {
  this._running = false;
  if (this._timer !== null) {
    clearTimeout(this._timer);
    this._timer = null;
  }
  this._callback = null;
};

/**
 * Schedule the next tick using target-time math:
 *   target = anchor + (sinceAnchorIndex * frameDurMs)
 *   delay  = max(0, target - now)
 * If we're far behind target (system was suspended), reset the anchor.
 */
FramePacer.prototype._scheduleNext = function () {
  var self = this;
  var now = _now();
  var targetMs = self._anchorMs + (self._sinceAnchorIndex * self._frameDurMs);
  var delayMs = targetMs - now;

  // If we're MAX_CATCH_UP_MS behind target, the system likely paused
  // (GC, OS suspend, debugger breakpoint). Don't try to fire all the
  // missed frames in a row — just re-anchor and continue.
  if (delayMs < -MAX_CATCH_UP_MS) {
    self._anchorMs = now;
    self._sinceAnchorIndex = 0;
    delayMs = 0;
  } else if (delayMs < 0) {
    delayMs = 0;
  }

  self._timer = setTimeout(function () {
    self._timer = null;
    if (!self._running) return;
    if (self._callback) {
      // Insulate the pacer from callback exceptions: a misbehaving
      // consumer shouldn't kill the timer chain. Errors surface to
      // process-level uncaughtException as a normal Node async fault.
      try { self._callback(self._frameIndex); }
      catch (e) {
        // A throwing callback must not break the timer chain, but it
        // must not vanish either.
        //
        // The Node path routes it to process-level uncaughtException.
        // In a browser `process` is undefined, so the previous code
        // silently swallowed every callback error — the pacer kept
        // ticking and the developer saw nothing at all. This module is
        // in the browser bundle, so that was the common case, not the
        // exotic one.
        //
        // Rethrowing on a fresh macrotask reaches window.onerror in a
        // browser and the default uncaught handler in Node, with the
        // caller's own stack, without unwinding the pacer.
        // ALWAYS a real throw on a fresh macrotask — never process.emit.
        //
        // process.emit('uncaughtException', e) SYNTHESISES the event instead
        // of raising a fault. Any listener is entitled to rethrow so Node's
        // default handler still runs, and that rethrow is itself uncaught,
        // which re-enters the same listener. The two then feed each other:
        // measured at 11 callbacks producing 204,296 handler invocations in
        // one second.
        //
        // It does not crash. The check and microtask queues starve, so every
        // await in the process stops progressing and even SIGINT goes
        // unanswered while timers and sockets keep running — the process
        // looks wedged, and nothing is logged, because the error never
        // reaches the default handler that would print it.
        //
        // A plain throw on a macrotask is a REAL uncaught exception:
        // window.onerror in a browser, Node's default handler otherwise,
        // carrying the caller's stack and leaving the pacer's timer chain
        // intact. It is exactly what the browser branch already did, and it
        // behaves correctly in both, so there is no reason to have two paths.
        setTimeout(function () { throw e; }, 0);
      }
    }
    self._frameIndex++;
    self._sinceAnchorIndex++;
    if (self._running) self._scheduleNext();
  }, delayMs);
};

Object.defineProperty(FramePacer.prototype, 'fps', {
  get: function () { return this._fps; },
});

Object.defineProperty(FramePacer.prototype, 'frameIndex', {
  get: function () { return this._frameIndex; },
});

Object.defineProperty(FramePacer.prototype, 'running', {
  get: function () { return this._running && this._timer !== null; },
});

export default FramePacer;