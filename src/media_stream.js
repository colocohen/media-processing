/**
 * MediaStream / MediaStreamTrack
 *
 * Improvements:
 *  - Track has _onStop callback for cleanup (GStreamer process kill)
 *  - Track validates kind
 */

import EventEmitter from './core/events.js';
import { randomBytes } from 'node:crypto';
import { domException as _domex } from './core/dom_exception.js';

// ── MediaStreamTrack ──

function MediaStreamTrack(opts) {
  if (!opts) opts = {};
  this._ee = new EventEmitter();
  this.kind = opts.kind || 'video';
  this.id = opts.id || _generateId();
  this.label = opts.label || '';
  this.enabled = true;
  this.readyState = 'live';
  this.muted = false;
  this.contentHint = opts.contentHint || '';  // '', 'motion', 'detail', 'text'
  this._onStop = null;
  this._settings = opts.settings || {};  // capture-time settings (width, height, frameRate, sampleRate, etc.)
}

MediaStreamTrack.prototype.on = function (ev, fn) { this._ee.on(ev, fn); };
MediaStreamTrack.prototype.off = function (ev, fn) { this._ee.off(ev, fn); };
MediaStreamTrack.prototype.addEventListener = function (ev, fn) { this._ee.on(ev, fn); };
MediaStreamTrack.prototype.removeEventListener = function (ev, fn) { this._ee.off(ev, fn); };
// prependListener exposes the EE method of the same name. Required so a
// consumer that needs first-call ordering (e.g. MediaStreamTrackProcessor,
// which must clone the VideoFrame before any sibling listener calls
// close() on it) can register itself ahead of pre-existing on() listeners.
// Without this, processor.handler runs after a diag listener that closes
// the frame, and processor.clone() throws "VideoFrame is detached".
MediaStreamTrack.prototype.prependListener = function (ev, fn) { this._ee.prependListener(ev, fn); };
MediaStreamTrack.prototype.once           = function (ev, fn) { this._ee.once(ev, fn); };

MediaStreamTrack.prototype.stop = function () {
  if (this.readyState === 'ended') return;
  this.readyState = 'ended';
  // Call cleanup callback (e.g., kill GStreamer process)
  if (typeof this._onStop === 'function') {
    this._onStop();
    this._onStop = null;
  }
  this._ee.emit('ended');
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
 * Source-only data (the underlying media source binding, _onStop, the
 * EventEmitter listeners) is NOT copied — the clone has its own pipeline.
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

  var cloned = new MediaStreamTrack({
    kind: this.kind,
    label: this.label,
    contentHint: this.contentHint,
    settings: settingsCopy,
  });
  cloned.enabled = this.enabled;
  // muted is a "live" state set by the source; for a clone created
  // mid-stream it should mirror current value.
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

MediaStreamTrack.prototype._push = function (data) {
  if (this.readyState === 'ended' || !this.enabled) return;
  this._ee.emit(this.kind === 'video' ? 'frame' : 'data', data);
};

MediaStreamTrack.prototype.getSettings = function () {
  var s = { kind: this.kind, label: this.label, enabled: this.enabled };
  for (var k in this._settings) {
    if (Object.prototype.hasOwnProperty.call(this._settings, k)) s[k] = this._settings[k];
  }
  return s;
};

MediaStreamTrack.prototype.getCapabilities = function () {
  return {};  // platform-specific, not applicable for FFmpeg/GStreamer
};

MediaStreamTrack.prototype.getConstraints = function () {
  return this._constraints || {};
};

/**
 * Apply constraints to the track (browser-compatible).
 * Updates stored settings. Resolution/FPS changes take effect on next frame.
 * @param {object} constraints — { width, height, frameRate, sampleRate, ... }
 * @returns {Promise<void>}
 */
MediaStreamTrack.prototype.applyConstraints = function (constraints) {
  if (this.readyState === 'ended') {
    return Promise.reject(_domex('Track is ended', 'InvalidStateError'));
  }
  if (!constraints) return Promise.resolve();
  this._constraints = constraints;
  // Merge into settings
  for (var k in constraints) {
    if (Object.prototype.hasOwnProperty.call(constraints, k)) {
      this._settings[k] = constraints[k];
    }
  }
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
  if (this.muted === muted) return;
  this.muted = muted;
  this._ee.emit(muted ? 'mute' : 'unmute');
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
function MediaStream(arg) {
  this._ee = new EventEmitter();
  this.id = _generateId();
  this._tracks = [];
  this._processes = [];

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

Object.defineProperty(MediaStream.prototype, 'onactive', {
  get: function () { return this._onactive || null; },
  set: function (fn) {
    if (this._onactive) this._ee.off('active', this._onactive);
    this._onactive = fn;
    if (fn) this._ee.on('active', fn);
  },
});

Object.defineProperty(MediaStream.prototype, 'oninactive', {
  get: function () { return this._oninactive || null; },
  set: function (fn) {
    if (this._oninactive) this._ee.off('inactive', this._oninactive);
    this._oninactive = fn;
    if (fn) this._ee.on('inactive', fn);
  },
});

MediaStream.prototype.addTrack = function (track) {
  if (!(track instanceof MediaStreamTrack)) {
    throw new TypeError('MediaStream.addTrack: expected MediaStreamTrack');
  }
  for (var i = 0; i < this._tracks.length; i++) {
    if (this._tracks[i].id === track.id) return;
  }
  this._tracks.push(track);
  this._ee.emit('addtrack', track);
};

MediaStream.prototype.removeTrack = function (track) {
  for (var i = 0; i < this._tracks.length; i++) {
    if (this._tracks[i].id === track.id) {
      this._tracks.splice(i, 1);
      this._ee.emit('removetrack', track);
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

function _generateId() { return randomBytes(16).toString('hex'); }


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
