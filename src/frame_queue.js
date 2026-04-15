/**
 * FrameQueue — Accumulates incoming data and emits fixed-size frames.
 * Replaces the Buffer.concat pattern that was duplicated everywhere.
 *
 * Usage:
 *   var fq = new FrameQueue(bytesPerFrame, function(frameBuf) { ... });
 *   fq.push(chunk);  // called from pipe data events
 *   fq.reset();
 */

function FrameQueue(frameSize, onFrame) {
  this._frameSize = frameSize;
  this._onFrame = onFrame;

  // Pre-allocate buffer with room for ~2 frames to reduce allocations
  this._capacity = frameSize * 3;
  this._buf = Buffer.allocUnsafe(this._capacity);
  this._writePos = 0;
}

/**
 * Push incoming data. Emits complete frames via callback.
 */
FrameQueue.prototype.push = function (chunk) {
  // Ensure capacity
  var needed = this._writePos + chunk.length;
  if (needed > this._capacity) {
    var newCap = Math.max(this._capacity * 2, needed);
    var newBuf = Buffer.allocUnsafe(newCap);
    if (this._writePos > 0) {
      this._buf.copy(newBuf, 0, 0, this._writePos);
    }
    this._buf = newBuf;
    this._capacity = newCap;
  }

  // Copy incoming data
  chunk.copy(this._buf, this._writePos);
  this._writePos += chunk.length;

  // Emit complete frames
  while (this._writePos >= this._frameSize) {
    // Slice out one frame (copy — caller owns it)
    var frame = Buffer.allocUnsafe(this._frameSize);
    this._buf.copy(frame, 0, 0, this._frameSize);

    // Shift remaining data to front
    var remaining = this._writePos - this._frameSize;
    if (remaining > 0) {
      this._buf.copy(this._buf, 0, this._frameSize, this._writePos);
    }
    this._writePos = remaining;

    this._onFrame(frame);
  }
};

/**
 * How many bytes are buffered (incomplete frame).
 */
Object.defineProperty(FrameQueue.prototype, 'buffered', {
  get: function () { return this._writePos; },
});

/**
 * Reset the accumulator.
 */
FrameQueue.prototype.reset = function () {
  this._writePos = 0;
};

export default FrameQueue;
