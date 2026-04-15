/**
 * FramePacer — Real-time frame delivery at fixed FPS with backpressure.
 *
 * Calls your callback at exact intervals, pausing when the consumer
 * signals backpressure and resuming on drain.
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

function FramePacer(opts) {
  if (!opts) opts = {};
  this._fps = opts.fps || 30;
  this._interval = Math.max(1, Math.round(1000 / this._fps));
  this._timer = null;
  this._frameIndex = 0;
  this._callback = null;
  this._running = false;
}

/**
 * Start pacing. Calls cb(frameIndex) at the configured FPS.
 * @param {function} cb — called with (frameIndex) for each tick
 */
FramePacer.prototype.start = function (cb) {
  if (this._running) return;
  this._callback = cb;
  this._running = true;
  this._frameIndex = 0;
  this._schedule();
};

/**
 * Pause delivery (backpressure). Call resume() when ready.
 */
FramePacer.prototype.pause = function () {
  if (this._timer !== null) {
    clearInterval(this._timer);
    this._timer = null;
  }
};

/**
 * Resume delivery after pause.
 */
FramePacer.prototype.resume = function () {
  if (!this._running) return;
  if (this._timer !== null) return;  // already running
  this._schedule();
};

/**
 * Stop completely. Reset frame index.
 */
FramePacer.prototype.stop = function () {
  this._running = false;
  if (this._timer !== null) {
    clearInterval(this._timer);
    this._timer = null;
  }
  this._callback = null;
};

FramePacer.prototype._schedule = function () {
  var self = this;
  self._timer = setInterval(function () {
    if (self._callback) self._callback(self._frameIndex++);
  }, self._interval);
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
