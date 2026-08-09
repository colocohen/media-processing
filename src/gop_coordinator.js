/**
 * GopCoordinator — one GOP boundary decision, shared by a set of encoders.
 *
 * WHY THIS EXISTS
 *
 * Running several encoders over the same source — an HLS ABR ladder, a
 * WebRTC simulcast set, an MoQ alternate group — only works if every
 * encoder starts a new GOP on the SAME source frame. A player switching
 * between renditions lands on a segment boundary and expects a keyframe
 * there in whichever rendition it switched to.
 *
 * Today each consumer makes that decision independently. HLSEncoder
 * computes it from its own `_lastForcedKeyframeUs`, so three HLSEncoder
 * instances fed identical frames agree *by coincidence* — the condition
 * happens to depend only on the frame timestamp. That coincidence breaks
 * in three ways:
 *
 *   1. An encoder added mid-stream starts its own clock and forces its
 *      first keyframe at a different frame than the others.
 *   2. A mid-stream resolution change restarts one encoder's FFmpeg and
 *      not the others'.
 *   3. In Node, VideoEncoder implements forced keyframes by respawning
 *      FFmpeg and throttles that with RESTART_COOLDOWN_MS, measured on
 *      the WALL CLOCK, per encoder. Two encoders whose last restarts
 *      were 900 ms and 1100 ms ago get different answers to the same
 *      request: one emits an IDR, the other silently emits a P-frame
 *      and increments _stats.keyframeThrottled.
 *
 * Point 3 is Node-only — it is an artifact of the FFmpeg-backed
 * polyfill. Native browser VideoEncoder honours keyFrame:true
 * unconditionally, so the same calling code stays aligned in a browser
 * and can drift under Node. The coordinator closes that gap by passing
 * `bypassThrottle` alongside a coordinated keyFrame request; browsers
 * ignore unknown members of an encode-options dictionary, so the exact
 * same call is correct in both environments.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not encode, scale, or inspect pixels, and it holds no
 * transport or container state. It decides one boolean per frame and
 * fans the frame out. That keeps it dependency-free and browser-safe.
 *
 * USAGE
 *
 *   var gop = new GopCoordinator({ segmentDurationUs: 2000000 });
 *   gop.add(encoderHd);
 *   gop.add(encoderMd);
 *   gop.add(encoderSd);
 *
 *   var r = gop.encode(frame);
 *   // r.keyFrame  — was this a GOP boundary?
 *   // r.groupId   — monotonic group counter; usable directly as an
 *   //               MOQT Group ID, or as an HLS segment index
 *   // r.delivered — how many encoders accepted the frame
 *   // r.errors    — [{ encoder, error }] for any that threw
 */

/**
 * @param {object} [opts]
 * @param {number} [opts.segmentDurationUs=2000000]
 *   Target GOP length in microseconds. A frame opens a new group when at
 *   least this much media time has elapsed since the last boundary.
 *   Measured on FRAME TIMESTAMPS, never on the wall clock — two runs over
 *   the same input must produce the same boundaries.
 * @param {number} [opts.gopSize]
 *   Alternative to segmentDurationUs: open a new group every N frames.
 *   Takes precedence when set. Useful when the source has irregular
 *   timestamps.
 * @param {boolean} [opts.joinAtBoundary=true]
 *   How an encoder added mid-stream is treated. See add().
 * @param {number} [opts.startGroupId=0]
 *   Initial group counter. MOQT requires Group IDs to increase
 *   monotonically across a publisher restart, so a publisher resuming a
 *   track should pass something greater than any previously used value
 *   (wall-clock milliseconds is the conventional choice).
 */
function GopCoordinator(opts) {
  if (!opts) opts = {};

  this._segmentDurationUs = (opts.segmentDurationUs != null)
    ? opts.segmentDurationUs : 2000000;
  this._gopSize = opts.gopSize || 0;
  this._joinAtBoundary = opts.joinAtBoundary !== false;

  this._entries = [];            // { encoder, pending, joinedAtGroup }
  this._lastBoundaryUs = null;   // timestamp of the last boundary frame
  this._frameIndex = 0;          // frames seen since the last boundary
  this._groupId = (opts.startGroupId != null) ? opts.startGroupId : 0;
  this._totalFrames = 0;
  this._started = false;
}

/**
 * Register an encoder.
 *
 * An encoder added before the first frame simply participates from the
 * start. One added mid-stream is the interesting case, and the default
 * is deliberate: `joinAtBoundary` holds it out until the next group
 * boundary, so its first encoded frame is a keyframe that coincides with
 * everyone else's.
 *
 * The alternative — starting it immediately with its own keyframe — is
 * what happens today when a caller constructs a fourth HLSEncoder
 * mid-stream, and it is exactly the drift this class exists to prevent:
 * that encoder's group boundaries are offset from the rest for the
 * lifetime of the stream. Pass { joinAtBoundary: false } if you want the
 * old behaviour (reasonable for a standalone recording track that is not
 * part of an alternate group).
 *
 * @param {object} encoder — anything with an encode(frame, opts) method
 * @param {object} [entryOpts]
 * @param {boolean} [entryOpts.joinAtBoundary] — overrides the constructor default
 * @returns {GopCoordinator} this, for chaining
 */
GopCoordinator.prototype.add = function (encoder, entryOpts) {
  if (!encoder || typeof encoder.encode !== 'function') {
    throw new TypeError('GopCoordinator.add: encoder must have an encode() method');
  }
  for (var i = 0; i < this._entries.length; i++) {
    if (this._entries[i].encoder === encoder) return this;   // idempotent
  }
  var wait = (entryOpts && entryOpts.joinAtBoundary !== undefined)
    ? entryOpts.joinAtBoundary
    : this._joinAtBoundary;

  this._entries.push({
    encoder: encoder,
    // Only meaningful once frames are flowing; an encoder added before
    // the first frame joins at the first boundary anyway.
    pending: !!(wait && this._started),
    joinedAtGroup: null,
  });
  return this;
};

/**
 * Unregister an encoder. Does not close it — lifetime stays the
 * caller's, since an encoder may be shared or reused.
 * @returns {boolean} true if it was registered
 */
GopCoordinator.prototype.remove = function (encoder) {
  for (var i = 0; i < this._entries.length; i++) {
    if (this._entries[i].encoder === encoder) {
      this._entries.splice(i, 1);
      return true;
    }
  }
  return false;
};

/**
 * Decide whether this frame opens a new group, then hand it to every
 * participating encoder with that decision.
 *
 * @param {VideoFrame} frame
 * @param {object} [opts]
 * @param {boolean} [opts.keyFrame] — force a boundary here regardless of
 *   the configured interval (e.g. a PLI from a receiver). Forcing it for
 *   the group keeps the renditions aligned, which is the whole point;
 *   requesting a keyframe from one encoder alone would desync it.
 * @returns {{keyFrame: boolean, groupId: number, delivered: number,
 *            errors: Array<{encoder: object, error: Error}>}}
 */
GopCoordinator.prototype.encode = function (frame, opts) {
  if (!frame) throw new TypeError('GopCoordinator.encode: frame required');

  var ts = (typeof frame.timestamp === 'number') ? frame.timestamp : null;
  var forced = !!(opts && opts.keyFrame);
  var isBoundary = this._decideBoundary(ts, forced);

  if (isBoundary) {
    this._groupId++;
    this._lastBoundaryUs = ts;
    this._frameIndex = 0;
    // Anything held out for alignment joins here — this frame is a
    // keyframe for everyone, so a late encoder starts cleanly.
    for (var p = 0; p < this._entries.length; p++) {
      if (this._entries[p].pending) {
        this._entries[p].pending = false;
        this._entries[p].joinedAtGroup = this._groupId;
      }
    }
  }
  this._frameIndex++;
  this._totalFrames++;
  this._started = true;

  // The encode options handed to EVERY encoder. `bypassThrottle` is
  // non-standard and Node-only in effect: it tells the FFmpeg-backed
  // VideoEncoder that this keyframe is a coordination requirement, not a
  // best-effort request, so its restart cooldown must not silently
  // downgrade it to a P-frame. WebIDL dictionaries ignore unknown
  // members, so a native browser VideoEncoder sees plain
  // { keyFrame: true } and behaves identically.
  var encodeOpts = isBoundary
    ? { keyFrame: true, bypassThrottle: true }
    : { keyFrame: false };

  var delivered = 0;
  var errors = [];
  for (var i = 0; i < this._entries.length; i++) {
    var e = this._entries[i];
    if (e.pending) continue;
    try {
      e.encoder.encode(frame, encodeOpts);
      delivered++;
    } catch (err) {
      // encode() throws by design — W3C requires a synchronous
      // InvalidStateError when a codec is not configured, and a frame
      // can arrive just after one encoder in the set was closed. One
      // failing rendition must not stop the others from receiving the
      // frame, so collect and continue rather than propagate.
      errors.push({ encoder: e.encoder, error: err });
    }
  }

  return {
    keyFrame: isBoundary,
    groupId: this._groupId,
    delivered: delivered,
    errors: errors,
  };
};

/**
 * Boundary rule. Deliberately a pure function of the frame's own
 * timestamp (or index) and prior boundaries — never Date.now(). Encoding
 * the same input twice must produce identical group boundaries, and a
 * boundary must not move because the process was busy.
 */
GopCoordinator.prototype._decideBoundary = function (ts, forced) {
  if (forced) return true;
  if (!this._started) return true;             // first frame always opens group

  if (this._gopSize > 0) {
    return this._frameIndex >= this._gopSize;
  }
  if (ts === null || this._lastBoundaryUs === null) {
    // No usable timestamp; fall back to counting frames so boundaries
    // still happen at a predictable rate rather than never.
    return this._frameIndex >= 30;
  }
  return (ts - this._lastBoundaryUs) >= this._segmentDurationUs;
};

/** Encoders currently receiving frames (excludes any awaiting a boundary). */
Object.defineProperty(GopCoordinator.prototype, 'activeCount', {
  get: function () {
    var n = 0;
    for (var i = 0; i < this._entries.length; i++) if (!this._entries[i].pending) n++;
    return n;
  },
});

/** Encoders registered but held until the next boundary. */
Object.defineProperty(GopCoordinator.prototype, 'pendingCount', {
  get: function () {
    var n = 0;
    for (var i = 0; i < this._entries.length; i++) if (this._entries[i].pending) n++;
    return n;
  },
});

/** Current group counter. Usable as an MOQT Group ID or a segment index. */
Object.defineProperty(GopCoordinator.prototype, 'groupId', {
  get: function () { return this._groupId; },
});

/** Frames seen since the last boundary. */
Object.defineProperty(GopCoordinator.prototype, 'framesInGroup', {
  get: function () { return this._frameIndex; },
});

/**
 * Flush every participating encoder. Returns a Promise that settles once
 * all have flushed; individual failures are reported rather than thrown,
 * matching encode()'s error isolation.
 */
GopCoordinator.prototype.flush = function () {
  var jobs = [];
  for (var i = 0; i < this._entries.length; i++) {
    var enc = this._entries[i].encoder;
    if (typeof enc.flush !== 'function') continue;
    jobs.push(Promise.resolve()
      .then(function (e) { return function () { return e.flush(); }; }(enc))
      .then(function () { return null; },
            function (err) { return err; }));
  }
  return Promise.all(jobs).then(function (results) {
    return { errors: results.filter(function (r) { return r !== null; }) };
  });
};

/**
 * Reset the boundary state so the next frame opens a new group.
 * Registered encoders are kept. Use after a source discontinuity.
 */
GopCoordinator.prototype.reset = function () {
  this._lastBoundaryUs = null;
  this._frameIndex = 0;
  this._started = false;
  for (var i = 0; i < this._entries.length; i++) {
    this._entries[i].pending = false;
  }
};

export default GopCoordinator;
