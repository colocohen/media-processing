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
  // ── Constructor validation (MP-35) ──
  // Without these, misconfigurations failed in confusing ways:
  //   - frameSize <= 0  → infinite loop in push() (writePos >= 0 always)
  //   - frameSize NaN   → new Uint8Array(NaN*3) throws RangeError
  //                       deep in the call stack
  //   - frameSize float → silent truncation by allocUnsafe; later frames
  //                       misalign by fractions
  //   - missing onFrame → push() crashes with "this._onFrame is not a
  //                       function" at first frame, possibly long after
  //                       construction made it look fine
  // Validate up front so the caller sees a clear TypeError at the
  // construction site.
  if (typeof frameSize !== 'number' || !Number.isInteger(frameSize) || frameSize <= 0) {
    throw new TypeError(
      'FrameQueue: frameSize must be a positive integer, got ' + frameSize
    );
  }
  if (typeof onFrame !== 'function') {
    throw new TypeError('FrameQueue: onFrame must be a function');
  }

  this._frameSize = frameSize;
  this._onFrame = onFrame;

  // Pre-allocate buffer with room for ~2 frames to reduce allocations
  this._capacity = frameSize * 3;
  this._buf = new Uint8Array(this._capacity);
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
    var newBuf = new Uint8Array(newCap);
    if (this._writePos > 0) {
      newBuf.set(this._buf.subarray(0, this._writePos), 0);
    }
    this._buf = newBuf;
    this._capacity = newCap;
  }

  // Copy incoming data
  this._buf.set(chunk, this._writePos);
  this._writePos += chunk.length;

  // Emit complete frames
  while (this._writePos >= this._frameSize) {
    // Slice out one frame (copy — caller owns it)
    var frame = new Uint8Array(this._frameSize);
    frame.set(this._buf.subarray(0, this._frameSize), 0);

    // Shift remaining data to front
    var remaining = this._writePos - this._frameSize;
    if (remaining > 0) {
      this._buf.set(this._buf.subarray(this._frameSize, this._writePos), 0);
    }
    this._writePos = remaining;

    // ── Defensive callback invocation (MP-35) ──
    // Buffer state above (frame extracted, remaining bytes shifted,
    // writePos updated) is fully consistent BEFORE this callback runs.
    // If onFrame throws — say a downstream encoder rejects audioData
    // for one bad frame, or a video encoder.encode() fails on a
    // resolution mismatch — we MUST NOT let the throw propagate up
    // through push(). Doing so would:
    //   (a) Lose any frames still queued in the buffer (the while
    //       loop would be aborted; subsequent frames sit in the buffer
    //       until a future push() call adds enough bytes to retrigger).
    //   (b) Surface to the source (FFmpeg stdout 'data' handler in our
    //       case), which has no good way to recover and typically just
    //       crashes the process or — worse — silently de-pipes.
    //   (c) Make audio pipelines particularly susceptible to drift:
    //       a single dropped frame at the source aligns with what the
    //       receiver expects, but a half-emitted batch leaves writePos
    //       in a state where the NEXT chunk's bytes are concatenated
    //       to the leftover of the failed batch, producing
    //       phase-shifted misaligned frames downstream — exactly the
    //       symptom we'd want to rule out for the alien-noise
    //       investigation.
    // The single-frame loss is acceptable; the persistent corruption
    // is not. Drop the bad frame, log, continue.
    try {
      this._onFrame(frame);
    } catch (err) {
      if (typeof console !== 'undefined' && typeof console.error === 'function') {
        console.error('[FrameQueue] onFrame threw, dropping frame and continuing:', err);
      }
    }
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
