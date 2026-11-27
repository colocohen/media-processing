/**
 * MediaStream / MediaStreamTrack
 *
 * Improvements:
 *  - Track has _onStop callback for cleanup (GStreamer process kill)
 *  - Track validates kind
 */

import EventEmitter from './core/events.js';
import { randomUUID } from 'node:crypto';
import { domException as _domex } from './core/dom_exception.js';
import { resolveConstraint, overconstrainedError } from './core/constraints.js';
import VideoFrame from './video_frame.js';
import AudioData from './audio_data.js';

// ── MediaStreamTrack ──

function MediaStreamTrack(opts) {
  if (!opts) opts = {};
  // Internal plumbing is NON-ENUMERABLE: a MediaStreamTrack in a browser
  // exposes only its IDL attributes, so anything that walks or serialises
  // a track (JSON.stringify in tests, structured logging, shallow clones,
  // deep-equality helpers) must not see _ee/_onStop/_settings. Leaving
  // them enumerable leaked the EventEmitter and its listener arrays into
  // every serialised track.
  Object.defineProperty(this, '_ee', {
    value: new EventEmitter(), writable: true, enumerable: false, configurable: true });
  this.kind = opts.kind || 'video';
  this.id = opts.id || _generateId();
  this.label = opts.label || '';
  this.enabled = true;
  this.readyState = 'live';
  this.muted = false;
  this.contentHint = opts.contentHint || '';  // '', 'motion', 'detail', 'text'
  // The source this track draws from — its own, or the one of the track
  // it was cloned from (see TrackSource).
  Object.defineProperty(this, '_source', {
    value: null, writable: true, enumerable: false, configurable: true });
  if (opts._source) opts._source.attach(this);
  else new TrackSource(this.kind).attach(this);
  // capture-time settings (width, height, frameRate, sampleRate, …)
  Object.defineProperty(this, '_settings', {
    value: opts.settings || {}, writable: true, enumerable: false, configurable: true });
}

// Adding or removing a frame / audio listener changes how many consumers
// the SOURCE has (see TrackSource.consumerCount).
function _touched(track, ev) {
  if ((ev === 'frame' || ev === 'data') && track._source) track._source._consumersChanged();
}
MediaStreamTrack.prototype.on = function (ev, fn) { this._ee.on(ev, fn); _touched(this, ev); };
MediaStreamTrack.prototype.off = function (ev, fn) { this._ee.off(ev, fn); _touched(this, ev); };
MediaStreamTrack.prototype.addEventListener = function (ev, fn) { this._ee.on(ev, fn); _touched(this, ev); };
MediaStreamTrack.prototype.removeEventListener = function (ev, fn) { this._ee.off(ev, fn); _touched(this, ev); };
// prependListener exposes the EE method of the same name. Required so a
// consumer that needs first-call ordering (e.g. MediaStreamTrackProcessor,
// which must clone the VideoFrame before any sibling listener calls
// close() on it) can register itself ahead of pre-existing on() listeners.
// Without this, processor.handler runs after a diag listener that closes
// the frame, and processor.clone() throws "VideoFrame is detached".
MediaStreamTrack.prototype.prependListener = function (ev, fn) { this._ee.prependListener(ev, fn); _touched(this, ev); };
MediaStreamTrack.prototype.once           = function (ev, fn) { this._ee.once(ev, fn); _touched(this, ev); };

// ── Source sharing, stop() and 'ended' (W3C mediacapture-main) ──
//
// A track is a consumer of a SOURCE (a camera, a microphone, a remote
// peer's stream, a VideoSource). clone() makes another track of the SAME
// source, with its own state (enabled, constraints), and:
//
//   - stop() ends THIS track only. The source stops — its capture
//     process is killed (_onStop) — when no track of it is live any more.
//     stop() does NOT fire 'ended': the spec fires 'ended' only when the
//     track ends for another reason (the source ended: the camera was
//     unplugged, the capture process exited, the remote peer stopped).
//   - muted belongs to the source, so it changes on all of its tracks.
//
// Before: stop() killed the capture process of every clone and fired
// 'ended' on a stop() the application itself made, and a clone got no
// frames at all — it had no source.
//
// Internal events (code here and in webrtc-server, not applications):
//   '_stopped'        this track stopped delivering, by stop() or because
//                     the source ended. What a CONSUMER of the track (a
//                     sink, a sender, a processor) listens to.
//   '_sourceStopped'  the source has no live track left — on every track
//                     of it. What a PRODUCER feeding the track (a receive
//                     pipeline) listens to, to stop producing.

function TrackSource(kind) {
  this.kind = kind;
  this.tracks = [];
  this.stopped = false;
  this.onStop = null;   // cleanup, e.g. kill the capture process
}

TrackSource.prototype.attach = function (track) {
  track._source = this;
  this.tracks.push(track);
};

/** See TrackSource.consumerCount. */
MediaStreamTrack.prototype._consumerCount = function () {
  return this._source ? this._source.consumerCount()
    : this._ee.listenerCount(this.kind === 'video' ? 'frame' : 'data');
};

TrackSource.prototype._live = function () {
  return this.tracks.filter(function (t) { return t.readyState === 'live'; });
};

/**
 * Deliver one VideoFrame / AudioData to every live track. Each track gets
 * its own reference (clone() shares the buffer), because each track's
 * consumers close() what they receive. Returns the number of tracks it
 * reached; with none, the data is released.
 */
TrackSource.prototype.push = function (data) {
  var live = this._live();
  if (!live.length) {
    try { if (data && typeof data.close === 'function') data.close(); } catch (e) {}
    return 0;
  }
  var copies = [];
  for (var i = 0; i < live.length - 1; i++) {
    copies.push((data && typeof data.clone === 'function') ? data.clone() : data);
  }
  copies.push(data);
  for (var j = 0; j < live.length; j++) live[j]._deliver(copies[j]);
  return live.length;
};

/**
 * How many listeners receive this source's frames ('frame') or audio
 * ('data'), over all of its live tracks. A producer that does work only
 * for a consumer (webrtc-server decodes a remote track only while
 * something listens) must count a clone's listeners too: it counted the
 * original track's alone, so once the application stopped the original
 * and kept a clone, decoding stopped and the clone got nothing.
 */
TrackSource.prototype.consumerCount = function () {
  var ev = this.kind === 'video' ? 'frame' : 'data';
  var live = this._live(), n = 0;
  for (var i = 0; i < live.length; i++) n += live[i]._ee.listenerCount(ev);
  return n;
};

// '_consumers' (count, previous) on every track of the source when the
// consumer count changes — a listener added or removed on any of them,
// or a track with listeners ending.
TrackSource.prototype._consumersChanged = function () {
  var n = this.consumerCount();
  var prev = this._consumers || 0;
  if (n === prev) return;
  this._consumers = n;
  var all = this.tracks.slice();
  for (var i = 0; i < all.length; i++) all[i]._ee.emit('_consumers', n, prev);
};

TrackSource.prototype.setMuted = function (muted) {
  var live = this._live();
  for (var i = 0; i < live.length; i++) live[i]._applyMuted(muted);
};

/** The source ended by itself: end every live track, with 'ended'. */
TrackSource.prototype.end = function () {
  var live = this._live();
  for (var i = 0; i < live.length; i++) live[i]._end();
  this._trackStopped();
};

/** A track of this source stopped; the last one stops the source. */
TrackSource.prototype._trackStopped = function () {
  this._consumersChanged();
  if (this.stopped || this._live().length) return;
  this.stopped = true;
  var fn = this.onStop;
  this.onStop = null;
  if (typeof fn === 'function') { try { fn(); } catch (e) {} }
  var all = this.tracks.slice();
  for (var i = 0; i < all.length; i++) {
    all[i]._ee.emit('_sourceStopped', _event('_sourceStopped', all[i]));
  }
};

// The source's cleanup, set by whoever starts the capture
// (getUserMedia: kill the GStreamer / FFmpeg process). Shared with clones.
Object.defineProperty(MediaStreamTrack.prototype, '_onStop', {
  get: function () { return this._source ? this._source.onStop : null; },
  set: function (fn) { if (this._source) this._source.onStop = fn; },
});

MediaStreamTrack.prototype.stop = function () {
  if (this.readyState === 'ended') return;
  this.readyState = 'ended';
  this._ee.emit('_stopped', _event('_stopped', this));
  if (this._source) this._source._trackStopped();
};

// The track ends for a reason other than stop(): fires 'ended'.
MediaStreamTrack.prototype._end = function () {
  if (this.readyState === 'ended') return;
  this.readyState = 'ended';
  this._ee.emit('_stopped', _event('_stopped', this));
  // `ended` is a W3C event, so the handler is entitled to read `e.type`.
  this._ee.emit('ended', _event('ended', this));
};

/**
 * The source ended (capture process exited, remote track ended, ...):
 * every track of it ends and fires 'ended'. For producers; an
 * application ends its own tracks with stop().
 */
MediaStreamTrack.prototype._endSource = function () {
  if (this._source) this._source.end();
  else this._end();
};

/**
 * Clone the track per W3C MediaCapture-Main §4.3.5.
 *
 * The cloned track is a separate MediaStreamTrack whose state is
 * initialized from this track:
 *   - kind, label, contentHint     — copied
 *   - enabled, muted, readyState   — copied (initial values match source)
 *   - constraints                  — copied (current applied)
 *   - settings                     — copied (current effective)
 *   - id                           — newly generated
 * The clone is attached to the SAME source: it receives the same frames,
 * and the source stops only when both are stopped. Listeners are not
 * copied.
 *
 * This was previously copying only kind/label/settings, which meant
 * disabled/muted state was lost across clone() and contentHint and
 * constraints were silently dropped (MP-29).
 */
MediaStreamTrack.prototype.clone = function () {
  // Shallow-copy settings so the clone's mutations don't leak back
  // into the source. _constraints is similarly cloned shallow.
  var settingsCopy = {};
  for (var k in this._settings) {
    if (Object.prototype.hasOwnProperty.call(this._settings, k)) {
      settingsCopy[k] = this._settings[k];
    }
  }

  // An ended track's clone is ended and needs no source of its own
  // feeding it; it gets a detached, already stopped one.
  var ended = this.readyState === 'ended';
  var detached = null;
  if (ended) { detached = new TrackSource(this.kind); detached.stopped = true; }
  var cloned = new MediaStreamTrack({
    kind: this.kind,
    label: this.label,
    contentHint: this.contentHint,
    settings: settingsCopy,
    _source: ended ? detached : this._source,
  });
  // W3C "clone a track": "Set trackClone's [[Capabilities]] to a clone of
  // track's [[Capabilities]]" — a clone's getCapabilities() was {}, and
  // its applyConstraints() checked nothing.
  if (this._capabilities) cloned._capabilities = this._capabilities;
  cloned.enabled = this.enabled;
  // muted is the source's state.
  cloned.muted = this.muted;
  // readyState: 'ended' source → 'ended' clone (per spec).
  cloned.readyState = this.readyState;

  if (this._constraints) {
    var constraintsCopy = {};
    for (var c in this._constraints) {
      if (Object.prototype.hasOwnProperty.call(this._constraints, c)) {
        constraintsCopy[c] = this._constraints[c];
      }
    }
    cloned._constraints = constraintsCopy;
  }

  return cloned;
};

// A producer hands the source's next frame / audio buffer to the track it
// holds; it reaches that track and all its clones. Returns how many.
MediaStreamTrack.prototype._push = function (data) {
  if (this._source) return this._source.push(data);
  this._deliver(data);
  return 1;
};

MediaStreamTrack.prototype._deliver = function (data) {
  if (this.readyState === 'ended') {
    try { if (data && typeof data.close === 'function') data.close(); } catch (e) {}
    return;
  }
  // W3C mediacapture-main: a disabled track renders BLACK frames (video)
  // or SILENCE (audio) — it does not stop. It dropped the frames instead,
  // so every consumer simply starved: a WebRTC sender stopped sending (the
  // peer froze on the last picture, where Chrome shows black), a
  // MediaStreamTrackProcessor's reader stalled. The replacement keeps the
  // frame's geometry and timing; the original is released here.
  if (!this.enabled) {
    var blank = _blankLike(this.kind, data);
    // Released also when it cannot be imitated (it was kept open).
    try { if (data && typeof data.close === 'function') data.close(); } catch (e) {}
    if (!blank) return;
    data = blank;
  }
  this._ee.emit(this.kind === 'video' ? 'frame' : 'data', data);
};

// A black I420 VideoFrame (Y 0, U/V 128 — what Chrome renders for a
// disabled track) or a silent AudioData with the same size and timing as
// `src`. null when `src` is not something to imitate.
function _blankLike(kind, src) {
  if (!src) return null;
  try {
    if (kind === 'video') {
      // The visible size (a decoder's frame may have a padded coded
      // size), the orientation, and the display size only as a pair: W3C
      // requires both or neither, and one alone made the constructor
      // throw, so the frame went out unblanked.
      var vr = src.visibleRect;
      var w = (vr && vr.width) || src.codedWidth, h = (vr && vr.height) || src.codedHeight;
      if (!w || !h) return null;
      var ySize = w * h, cSize = Math.ceil(w / 2) * Math.ceil(h / 2);
      var buf = new Uint8Array(ySize + 2 * cSize);
      buf.fill(128, ySize);
      var init = { format: 'I420', codedWidth: w, codedHeight: h, timestamp: src.timestamp || 0 };
      if (typeof src.duration === 'number') init.duration = src.duration;
      if (src.displayWidth && src.displayHeight) { init.displayWidth = src.displayWidth; init.displayHeight = src.displayHeight; }
      if (typeof src.rotation === 'number') init.rotation = src.rotation;
      if (typeof src.flip === 'boolean') init.flip = src.flip;
      return new VideoFrame(buf, init);
    }
    var fmt = src.format || 's16';
    var frames = src.numberOfFrames, ch = src.numberOfChannels;
    if (!frames || !ch) return null;
    var bps = { u8: 1, s16: 2, s32: 4, f32: 4 }[String(fmt).replace('-planar', '')] || 2;
    var pcm = new Uint8Array(frames * ch * bps);
    if (String(fmt).indexOf('u8') === 0) pcm.fill(128);   // u8 silence is the midpoint
    return new AudioData({ data: pcm, format: fmt, sampleRate: src.sampleRate,
      numberOfChannels: ch, numberOfFrames: frames, timestamp: src.timestamp || 0 });
  } catch (e) { return null; }
}

// W3C getSettings(): [[Settings]], the constrainable properties' values;
// once ended, only "the list of inherent constrainable track properties"
// (deviceId, facingMode, groupId) "with the value at the time track was
// ended". It also gave kind, label and enabled (no MediaTrackSettings
// members: the track's own attributes) and every setting after the end.
var _INHERENT = { deviceId: true, facingMode: true, groupId: true };
MediaStreamTrack.prototype.getSettings = function () {
  var s = {}, ended = this.readyState === 'ended';
  for (var k in this._settings) {
    if (!Object.prototype.hasOwnProperty.call(this._settings, k)) continue;
    if (ended && !_INHERENT[k]) continue;
    s[k] = this._settings[k];
  }
  return s;
};

// What the source can do — getUserMedia fills _capabilities from the
// device probe (GStreamer modes). It returned {} regardless.
MediaStreamTrack.prototype.getCapabilities = function () {
  var c = this._capabilities || {}, out = {};
  for (var k in c) if (Object.prototype.hasOwnProperty.call(c, k)) out[k] = c[k];
  return out;
};

// A copy: the caller's edits must not reach the track's constraints.
MediaStreamTrack.prototype.getConstraints = function () {
  var c = this._constraints || {}, out = {};
  for (var k in c) if (Object.prototype.hasOwnProperty.call(c, k)) out[k] = c[k];
  return out;
};

/**
 * Apply constraints to the track (browser-compatible).
 * Updates stored settings. Resolution/FPS changes take effect on next frame.
 * @param {object} constraints — { width, height, frameRate, sampleRate, ... }
 * @returns {Promise<void>}
 */
MediaStreamTrack.prototype.applyConstraints = function (constraints) {
  // W3C applyConstraints(): "If track's [[ReadyState]] is "ended", ...
  // resolve p with undefined" — nothing changes. It rejected with an
  // InvalidStateError.
  if (this.readyState === 'ended') return Promise.resolve();
  // W3C: applyConstraints() with no argument removes every constraint.
  if (!constraints) { this._constraints = {}; return Promise.resolve(); }
  // W3C (apply constraints algorithm): a REQUIRED constraint — exact,
  // min, max — that the source cannot satisfy rejects with
  // OverconstrainedError naming it, and the track keeps its previous
  // constraints and settings. Every request was accepted and echoed into
  // getSettings(), so width:{exact:3840} on a source that only does
  // 1280x720 reported 3840. Checked against getCapabilities(); a
  // property with no known capability is not constrained here.
  //
  // A numeric constraint is also checked against itself: {min: 30, max:
  // 10}, or {exact: 5, min: 10}, can be met by no settings dictionary at
  // all (W3C fitness distance: infinity), capability known or not — both
  // were accepted (the first unless a capability range was known). An
  // empty list is no constraint ("If an empty list has been given as the
  // value for a constraint, it MUST be interpreted as if the constraint
  // were not specified"): {exact: []} was rejected.
  var caps = this._capabilities || {};
  for (var ck in constraints) {
    if (!Object.prototype.hasOwnProperty.call(constraints, ck) || ck === 'advanced') continue;
    var c = constraints[ck], cap = caps[ck];
    if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
    var capRange = cap && typeof cap === 'object' && !Array.isArray(cap) &&
        (typeof cap.min === 'number' || typeof cap.max === 'number');
    var numeric = typeof c.exact === 'number' || typeof c.min === 'number' || typeof c.max === 'number';
    if (capRange || (cap === undefined && numeric)) {
      var lo = capRange && typeof cap.min === 'number' ? cap.min : -Infinity;
      var hi = capRange && typeof cap.max === 'number' ? cap.max : Infinity;
      if (typeof c.min === 'number') lo = Math.max(lo, c.min);
      if (typeof c.max === 'number') hi = Math.min(hi, c.max);
      if (lo > hi || (typeof c.exact === 'number' && (c.exact < lo || c.exact > hi))) {
        return Promise.reject(overconstrainedError(ck));
      }
    } else if (cap !== undefined && c.exact !== undefined) {
      var allowed = Array.isArray(cap) ? cap : [cap];
      var want = Array.isArray(c.exact) ? c.exact : [c.exact];
      if (want.length && !want.some(function (w) { return allowed.indexOf(w) >= 0; })) {
        return Promise.reject(overconstrainedError(ck));
      }
    }
  }
  // Settings are VALUES. The constraint objects were merged in as they
  // were, so after applyConstraints({width: {ideal: 1280}}) getSettings()
  // .width was {ideal: 1280} — any consumer reading width/height as a
  // number broke. Each is resolved to the value it asks for.
  var copy = {};
  for (var k in constraints) {
    if (!Object.prototype.hasOwnProperty.call(constraints, k)) continue;
    copy[k] = constraints[k];
    if (k === 'advanced') continue;
    var v = resolveConstraint(constraints[k]);
    // An ideal / bare value is the closest the source can do (fitness
    // distance): clamped into its capability range, not echoed beyond it.
    var kc = caps[k];
    if (typeof v === 'number' && kc && typeof kc === 'object' && !Array.isArray(kc)) {
      if (typeof kc.max === 'number' && v > kc.max) v = kc.max;
      if (typeof kc.min === 'number' && v < kc.min) v = kc.min;
    }
    if (v !== undefined) this._settings[k] = v;
  }
  this._constraints = copy;
  return Promise.resolve();
};

/**
 * Dispatch an event (W3C EventTarget interface).
 *
 * Per the DOM standard:
 *   - The argument MUST be an Event object (has .type at minimum).
 *     Passing a string throws TypeError. The previous implementation
 *     accepted strings, which is non-compliant.
 *   - Returns `true` if the event was not canceled, `false` if a
 *     listener called event.preventDefault() and event.cancelable
 *     was true. The previous implementation returned undefined.
 *   - Sets event.target and event.currentTarget on the event object
 *     before invoking listeners.
 *
 * This brings dispatchEvent in line with browser MediaStreamTrack and
 * lets W3C-compliant callers use the standard contract:
 *   var ev = new Event('mute', { cancelable: true });
 *   var notCanceled = track.dispatchEvent(ev);
 */
MediaStreamTrack.prototype.dispatchEvent = function (event) {
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
    throw new TypeError(
      "Failed to execute 'dispatchEvent' on 'EventTarget': " +
      "parameter 1 is not of type 'Event'."
    );
  }
  // Best-effort: set target/currentTarget. Some Event implementations
  // freeze these properties; ignore failures rather than throwing.
  try { if (event.target == null) event.target = this; } catch (e) {}
  try { if (event.currentTarget == null) event.currentTarget = this; } catch (e) {}

  this._ee.emit(event.type, event);

  // Spec: return false when canceled, true otherwise. cancelable=false
  // events ignore preventDefault — defaultPrevented stays false.
  return !event.defaultPrevented;
};

// ── Handler properties (browser-compatible) ──

Object.defineProperty(MediaStreamTrack.prototype, 'onended', {
  get: function () { return this._onended || null; },
  set: function (fn) {
    if (this._onended) this._ee.off('ended', this._onended);
    this._onended = fn;
    if (fn) this._ee.on('ended', fn);
  },
});

Object.defineProperty(MediaStreamTrack.prototype, 'onmute', {
  get: function () { return this._onmute || null; },
  set: function (fn) {
    if (this._onmute) this._ee.off('mute', this._onmute);
    this._onmute = fn;
    if (fn) this._ee.on('mute', fn);
  },
});

Object.defineProperty(MediaStreamTrack.prototype, 'onunmute', {
  get: function () { return this._onunmute || null; },
  set: function (fn) {
    if (this._onunmute) this._ee.off('unmute', this._onunmute);
    this._onunmute = fn;
    if (fn) this._ee.on('unmute', fn);
  },
});

/**
 * Mute/unmute the track programmatically.
 * Sets muted state and fires mute/unmute events.
 */
MediaStreamTrack.prototype._setMuted = function (muted) {
  // muted is the source's state: it changes on every track of it.
  if (this._source) { this._source.setMuted(muted); return; }
  this._applyMuted(muted);
};

MediaStreamTrack.prototype._applyMuted = function (muted) {
  if (this.muted === muted) return;
  this.muted = muted;
  // An Event, like 'ended' — a handler reading e.type got undefined.
  this._ee.emit(muted ? 'mute' : 'unmute', _event(muted ? 'mute' : 'unmute', this));
};

// _domex now imported from dom_exception.js (top of file).

// ── MediaStream ──

/**
 * MediaStream — browser-compatible constructor.
 *
 * Forms:
 *   new MediaStream()                    — empty stream
 *   new MediaStream(existingStream)      — clone tracks from another stream
 *   new MediaStream([track1, track2])    — create from array of tracks
 *   new MediaStream({ tracks: [...] })   — internal form
 */
/**
 * Minimal Event / MediaStreamTrackEvent shapes.
 *
 * These are not full DOM Events — there is no capture phase, no
 * preventDefault, no bubbling here — but they carry the members a
 * handler actually reads, so code written against the browser API works
 * unchanged. `target` and `currentTarget` are included because handlers
 * commonly reach for them.
 */
function _event(type, target) {
  return { type: type, target: target || null, currentTarget: target || null,
           timeStamp: Date.now() };
}

function _trackEvent(type, track) {
  var e = _event(type, null);
  e.track = track;
  return e;
}

function MediaStream(arg) {
  // Same non-enumerable rule as MediaStreamTrack: a browser MediaStream
  // exposes only `id` (plus its methods), so the EventEmitter, the track
  // array and the pipeline processes must stay hidden from serialisation
  // and property walks.
  Object.defineProperty(this, '_ee', {
    value: new EventEmitter(), writable: true, enumerable: false, configurable: true });
  this.id = _generateId();
  Object.defineProperty(this, '_tracks', {
    value: [], writable: true, enumerable: false, configurable: true });
  Object.defineProperty(this, '_processes', {
    value: [], writable: true, enumerable: false, configurable: true });

  if (arg instanceof MediaStream) {
    // Clone from existing stream
    var srcTracks = arg.getTracks();
    for (var i = 0; i < srcTracks.length; i++) this._tracks.push(srcTracks[i]);
  } else if (Array.isArray(arg)) {
    // Array of tracks
    for (var j = 0; j < arg.length; j++) this._tracks.push(arg[j]);
  } else if (arg && typeof arg === 'object') {
    if (arg.id) this.id = arg.id;
    if (Array.isArray(arg.tracks)) {
      for (var k = 0; k < arg.tracks.length; k++) this._tracks.push(arg.tracks[k]);
    }
  }

  // A track appears once in a stream's track set (W3C: a set) —
  // new MediaStream([t, t]) kept both.
  var _seen = {};
  this._tracks = this._tracks.filter(function (t) {
    if (!t || _seen[t.id]) return false;
    _seen[t.id] = true;
    return true;
  });
}

MediaStream.prototype.on = function (ev, fn) { this._ee.on(ev, fn); };
MediaStream.prototype.off = function (ev, fn) { this._ee.off(ev, fn); };
MediaStream.prototype.addEventListener = function (ev, fn) { this._ee.on(ev, fn); };
MediaStream.prototype.removeEventListener = function (ev, fn) { this._ee.off(ev, fn); };

MediaStream.prototype.dispatchEvent = function (event) {
  // See MediaStreamTrack.prototype.dispatchEvent for the full spec
  // commentary. Same algorithm: validate Event, set target, emit,
  // return !defaultPrevented.
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
    throw new TypeError(
      "Failed to execute 'dispatchEvent' on 'EventTarget': " +
      "parameter 1 is not of type 'Event'."
    );
  }
  try { if (event.target == null) event.target = this; } catch (e) {}
  try { if (event.currentTarget == null) event.currentTarget = this; } catch (e) {}

  this._ee.emit(event.type, event);

  return !event.defaultPrevented;
};

Object.defineProperty(MediaStream.prototype, 'onaddtrack', {
  get: function () { return this._onaddtrack || null; },
  set: function (fn) {
    if (this._onaddtrack) this._ee.off('addtrack', this._onaddtrack);
    this._onaddtrack = fn;
    if (fn) this._ee.on('addtrack', fn);
  },
});

Object.defineProperty(MediaStream.prototype, 'onremovetrack', {
  get: function () { return this._onremovetrack || null; },
  set: function (fn) {
    if (this._onremovetrack) this._ee.off('removetrack', this._onremovetrack);
    this._onremovetrack = fn;
    if (fn) this._ee.on('removetrack', fn);
  },
});

// No onactive / oninactive, and no 'active' / 'inactive' events: they are
// not in mediacapture-main (Chrome's legacy; WPT historical.https.html:
// "MediaStream.onactive should not exist"). The stream had them, fired
// from a '_stopped' watcher on each track; `active` is derived from the
// tracks when read.

// addTrack() / removeTrack() are the SCRIPT's: they change the track set
// and fire nothing. mediacapture-main, the event table: addtrack — "Note
// that this event is not fired when the script directly modifies the
// tracks of a MediaStream" (WPT MediaStream-add-audio-track /
// MediaStream-removetrack: "onaddtrack is not fired when the script
// directly modified the track of a mediastream"). They fired 'addtrack' /
// 'removetrack' like the User Agent's own algorithms below.
MediaStream.prototype.addTrack = function (track) {
  this._addToTrackSet(track, false);
};

MediaStream.prototype.removeTrack = function (track) {
  this._removeFromTrackSet(track, false);
};

/**
 * The User Agent's "add a track" (mediacapture-main §4.3.1): for an
 * implementation acting as the User Agent — webrtc-server adding a remote
 * peer's track to its streams (webrtc-pc, setRemoteDescription's "add
 * track to stream" steps). Adds the track and fires 'addtrack' (a
 * MediaStreamTrackEvent). Not for application code: a script uses
 * addTrack(), which fires nothing.
 */
MediaStream.prototype._addTrackFromUA = function (track) {
  this._addToTrackSet(track, true);
};

/**
 * The User Agent's "remove a track": webrtc-pc §4.4.1.6 "process the
 * removal of a remote track". Removes it and fires 'removetrack'. Not
 * for application code (removeTrack() fires nothing).
 */
MediaStream.prototype._removeTrackFromUA = function (track) {
  this._removeFromTrackSet(track, true);
};

MediaStream.prototype._addToTrackSet = function (track, fire) {
  // DUCK-TYPED (not instanceof): under node --preserve-symlinks, sibling
  // packages (webrtc-server, stable-webrtc) resolve media-processing via
  // DIFFERENT module paths and therefore hold DIFFERENT class identities
  // for the very same source file — a genuine MediaStreamTrack from one
  // fails `instanceof` against the other. Shape is identity here.
  var looksLikeTrack = track && typeof track === 'object' &&
    (track.kind === 'audio' || track.kind === 'video') &&
    typeof track.id === 'string';
  if (!(track instanceof MediaStreamTrack) && !looksLikeTrack) {
    throw new TypeError('MediaStream.addTrack: expected MediaStreamTrack');
  }
  for (var i = 0; i < this._tracks.length; i++) {
    if (this._tracks[i].id === track.id) return;
  }
  this._tracks.push(track);
  // Internal: the track set changed, by anyone (MediaRecorder's
  // InvalidModificationError watches it).
  this._ee.emit('_trackset', track);
  // W3C dispatches a MediaStreamTrackEvent — an object carrying `type`
  // and `track` — not the bare track. Emitting the track itself meant
  // spec-shaped handler code (`e.track.id`) threw TypeError, and because
  // core/events.js catches listener exceptions and only logs them, the
  // symptom was an event that appeared never to have fired at all.
  if (fire) this._ee.emit('addtrack', _trackEvent('addtrack', track));
};

MediaStream.prototype._removeFromTrackSet = function (track, fire) {
  for (var i = 0; i < this._tracks.length; i++) {
    if (this._tracks[i].id === track.id) {
      this._tracks.splice(i, 1);
      this._ee.emit('_trackset', track);
      if (fire) this._ee.emit('removetrack', _trackEvent('removetrack', track));
      return;
    }
  }
};

MediaStream.prototype.getTracks = function () { return this._tracks.slice(); };

MediaStream.prototype.getVideoTracks = function () {
  var out = [];
  for (var i = 0; i < this._tracks.length; i++) {
    if (this._tracks[i].kind === 'video') out.push(this._tracks[i]);
  }
  return out;
};

MediaStream.prototype.getAudioTracks = function () {
  var out = [];
  for (var i = 0; i < this._tracks.length; i++) {
    if (this._tracks[i].kind === 'audio') out.push(this._tracks[i]);
  }
  return out;
};

MediaStream.prototype.getTrackById = function (id) {
  for (var i = 0; i < this._tracks.length; i++) {
    if (this._tracks[i].id === id) return this._tracks[i];
  }
  return null;
};

Object.defineProperty(MediaStream.prototype, 'active', {
  get: function () {
    for (var i = 0; i < this._tracks.length; i++) {
      if (this._tracks[i].readyState === 'live') return true;
    }
    return false;
  },
});

/**
 * Stop all tracks and kill associated processes.
 */
MediaStream.prototype.stop = function () {
  var tracks = this.getTracks();
  for (var i = 0; i < tracks.length; i++) tracks[i].stop();
  for (var j = 0; j < this._processes.length; j++) {
    try { this._processes[j].stop(); } catch (e) {}
  }
  this._processes = [];
};

MediaStream.prototype.clone = function () {
  var tracks = [];
  for (var i = 0; i < this._tracks.length; i++) tracks.push(this._tracks[i].clone());
  return new MediaStream({ tracks: tracks });
};

// W3C MediaStream.id: "A good practice is to use a UUID [rfc4122] ...
// implementations SHOULD use the forms in section 4.4 or 4.5 of RFC 4122"
// (MediaStreamTrack.id follows the same guidelines). It was 32 hex digits
// (WPT MediaStream-id checks the 36 characters of a UUID's form).
function _generateId() { return randomUUID(); }


// ═══════════════════════════════════════════════════════════════════
//  MediaDeviceInfo / InputDeviceInfo
//  (W3C Media Capture and Streams §11.1, §11.5)
// ═══════════════════════════════════════════════════════════════════

/**
 * MediaDeviceInfo — describes a single media input/output device.
 * Constructed from the device-probe results (gst-device-monitor or
 * platform fallback) and returned from navigator.mediaDevices
 * .enumerateDevices().
 *
 * Standard fields (read-only per W3C):
 *   - deviceId  string  — opaque, stable identifier
 *   - kind      string  — 'videoinput' | 'audioinput' | 'audiooutput'
 *   - label     string  — human-readable name (may be empty until permission granted)
 *   - groupId   string  — groups devices from the same physical hardware
 */
function MediaDeviceInfo(opts) {
  opts = opts || {};
  this.deviceId = opts.deviceId || '';
  this.kind     = opts.kind     || '';
  this.label    = opts.label    || '';
  this.groupId  = opts.groupId  || '';
}

MediaDeviceInfo.prototype.toJSON = function () {
  return {
    deviceId: this.deviceId,
    kind:     this.kind,
    label:    this.label,
    groupId:  this.groupId,
  };
};

/**
 * InputDeviceInfo — extends MediaDeviceInfo for input-capable devices
 * (cameras, microphones). Adds getCapabilities() which exposes the
 * device's negotiable parameters (resolution ranges, framerate ranges,
 * channel counts, etc.) BEFORE getUserMedia() is called.
 *
 * Per W3C §11.5.2, getCapabilities() returns a fresh object on each
 * call (caller mutations don't leak into stored capabilities).
 *
 * @param {object} opts  same shape as MediaDeviceInfo, plus:
 *   - capabilities  object  W3C-shaped capabilities map (e.g. for video:
 *                           { width: {min, max}, height: {min, max},
 *                             frameRate: {min, max}, ... })
 *   - _modes        any     non-standard escape hatch — preserves the
 *                           raw discrete modes returned by gst-device-
 *                           monitor for callers that need exact mode
 *                           combinations rather than W3C ranges.
 */
function InputDeviceInfo(opts) {
  MediaDeviceInfo.call(this, opts);
  this._capabilities = (opts && opts.capabilities) || {};
  if (opts && opts._modes !== undefined) this._modes = opts._modes;
}

InputDeviceInfo.prototype = Object.create(MediaDeviceInfo.prototype);
InputDeviceInfo.prototype.constructor = InputDeviceInfo;

InputDeviceInfo.prototype.getCapabilities = function () {
  // Return a shallow copy so caller mutations don't leak into our
  // stored capabilities. Per W3C the returned object is conceptually
  // a snapshot.
  var out = {};
  for (var k in this._capabilities) {
    if (Object.prototype.hasOwnProperty.call(this._capabilities, k)) {
      out[k] = this._capabilities[k];
    }
  }
  return out;
};

export { MediaStream, MediaStreamTrack, MediaDeviceInfo, InputDeviceInfo };