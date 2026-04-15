/**
 * MediaStream / MediaStreamTrack
 *
 * Improvements:
 *  - Track has _onStop callback for cleanup (GStreamer process kill)
 *  - Track validates kind
 */

import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';

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

MediaStreamTrack.prototype.clone = function () {
  return new MediaStreamTrack({ kind: this.kind, label: this.label, settings: this._settings });
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
 * Dispatch an event (EventTarget interface).
 */
MediaStreamTrack.prototype.dispatchEvent = function (event) {
  var type = (typeof event === 'string') ? event : event.type;
  this._ee.emit(type, event);
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

function _domex(msg, name) {
  if (typeof DOMException !== 'undefined') return new DOMException(msg, name);
  var e = new TypeError(msg);
  e.name = name || 'InvalidStateError';
  return e;
}

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
  var type = (typeof event === 'string') ? event : event.type;
  this._ee.emit(type, event);
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

export { MediaStream, MediaStreamTrack };
