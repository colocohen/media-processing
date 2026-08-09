/**
 * VideoSource / AudioSource — Programmatic media frame sources.
 * VideoSink / AudioSink — Consume frames from a MediaStreamTrack.
 *
 * Like wrtc's RTCVideoSource/RTCVideoSink / RTCAudioSource/RTCAudioSink.
 */

import EventEmitter from './core/events.js';
import { MediaStreamTrack } from './media_stream.js';
import VideoFrame from './video_frame.js';
import AudioData from './audio_data.js';

// ═══════════════════════════════════════
//  Sources — push frames to tracks
// ═══════════════════════════════════════

function _createTrack(self, kind, label) {
  var track = new MediaStreamTrack({ kind: kind, label: label });
  self._tracks.push(track);
  track.on('ended', function () {
    for (var i = 0; i < self._tracks.length; i++) {
      if (self._tracks[i].id === track.id) {
        self._tracks.splice(i, 1);
        break;
      }
    }
  });
  return track;
}

/**
 * Deliver `data` to every live track. Returns the number of tracks that
 * actually received it.
 *
 * Visibility, not behaviour: pushing into a source whose tracks have all
 * ended is still a silent no-op by design — a producer racing a stop()
 * should not blow up. But it used to be *invisible*: no return value, no
 * throw, no log. Code that keeps feeding a dead source got zero feedback,
 * which turns a leak into something you can only find by noticing that
 * nothing downstream ever arrives. (A consumer wrapped these calls in
 * try/catch expecting a throw, and of course caught nothing.)
 *
 * So: return a delivered count callers can check, and warn ONCE per
 * source the first time a push lands nowhere. Once is deliberate — a
 * 30 fps producer against a dead source would otherwise emit 30 lines a
 * second, which is its own kind of invisible.
 */
function _pushToTracks(self, data) {
  var delivered = 0;
  for (var i = 0; i < self._tracks.length; i++) {
    if (self._tracks[i].readyState === 'live') {
      self._tracks[i]._push(data);
      delivered++;
    }
  }
  if (delivered === 0) _warnDropped(self);
  return delivered;
}

function _warnDropped(self) {
  if (self._warnedDropped || self._warnOnDrop === false) return;
  self._warnedDropped = true;
  if (typeof console !== 'undefined' && console.warn) {
    console.warn(
      '[' + (self._sourceName || 'Source') + '] push discarded: no live tracks. ' +
      'Every track from this source has ended (or none was created). ' +
      'Further pushes are dropped silently; check the return value of ' +
      'onFrame()/onData() — it is the number of tracks reached — or the ' +
      '`liveTrackCount` property. Pass { warnOnDrop: false } to silence this.'
    );
  }
}

// ── VideoSource ──

function VideoSource(opts) {
  if (!opts) opts = {};
  this._tracks = [];
  this._frameIndex = 0;
  this._lastWidth = 0;
  this._lastHeight = 0;
  this.isScreencast = !!opts.isScreencast;
  this._sourceName = 'VideoSource';
  this._warnOnDrop = opts.warnOnDrop !== false;
  this._warnedDropped = false;
}

VideoSource.prototype.createTrack = function () {
  var track = _createTrack(this, 'video', 'VideoSource');
  // A track created after frames have already flowed should not have to
  // wait for the next one to learn the geometry.
  if (this._lastWidth && this._lastHeight) {
    if (!track._settings) track._settings = {};
    track._settings.width = this._lastWidth;
    track._settings.height = this._lastHeight;
  }
  return track;
};

/**
 * Push a frame to every live track.
 * @returns {number} how many tracks received it — 0 means it was dropped.
 */
VideoSource.prototype.onFrame = function (frame) {
  if (!frame || !frame.data) return 0;
  var vf;
  if (frame instanceof VideoFrame) {
    vf = frame;
  } else {
    // Accept both spellings. VideoFrame exposes codedWidth/codedHeight,
    // so a frame-shaped object copied from one (or produced by any
    // WebCodecs-facing code) carries those names; the older wrtc-style
    // {width,height} form is still accepted for compatibility. Reading
    // only `width` meant a VideoFrame-shaped plain object failed the
    // constructor's "codedWidth and codedHeight required" check.
    vf = new VideoFrame({
      data: frame.data,
      format: frame.format || 'I420',
      codedWidth: frame.codedWidth || frame.width || 0,
      codedHeight: frame.codedHeight || frame.height || 0,
      timestamp: frame.timestamp || Math.round((this._frameIndex * 1e6) / 30),
    });
  }
  this._frameIndex++;

  // Publish frame geometry onto every live track.
  //
  // getSettings() previously reported only {kind, label, enabled}, so a
  // consumer had no way to learn the frame size before the first frame
  // arrived and had to guess — webrtc-server defaults to 640x480 and
  // mis-sizes anything else. Populating settings here means the answer
  // is available from the first frame onward, and stays correct if the
  // source changes resolution mid-stream.
  //
  // Reported dimensions are the VISIBLE ones: getSettings() describes
  // what a consumer will see, and mediacapture-main has no notion of a
  // coded rect with padding.
  var w = (vf.visibleRect && vf.visibleRect.width) || vf.codedWidth;
  var h = (vf.visibleRect && vf.visibleRect.height) || vf.codedHeight;
  if (w && h && (w !== this._lastWidth || h !== this._lastHeight)) {
    this._lastWidth = w;
    this._lastHeight = h;
    for (var i = 0; i < this._tracks.length; i++) {
      var t = this._tracks[i];
      if (!t._settings) t._settings = {};
      t._settings.width = w;
      t._settings.height = h;
    }
  }

  return _pushToTracks(this, vf);
};

// ── AudioSource ──

function AudioSource(opts) {
  if (!opts) opts = {};
  this._tracks = [];
  this._sampleIndex = 0;
  this._sourceName = 'AudioSource';
  this._warnOnDrop = opts.warnOnDrop !== false;
  this._warnedDropped = false;
}

AudioSource.prototype.createTrack = function () {
  return _createTrack(this, 'audio', 'AudioSource');
};

/**
 * Push audio to every live track.
 * @returns {number} how many tracks received it — 0 means it was dropped.
 */
AudioSource.prototype.onData = function (data) {
  if (!data || !data.samples) return 0;
  var sampleRate = data.sampleRate || 48000;
  var channels = data.channelCount || 1;
  var buf = data.samples instanceof Uint8Array ? data.samples : new Uint8Array(data.samples.buffer);
  var numberOfFrames = data.numberOfFrames || (buf.length / (channels * 2));
  var durationUs = Math.round((numberOfFrames * 1e6) / sampleRate);

  var ad = new AudioData({
    data: buf,
    format: 's16',
    sampleRate: sampleRate,
    numberOfChannels: channels,
    numberOfFrames: numberOfFrames,
    timestamp: Math.round((this._sampleIndex * 1e6) / sampleRate),
    duration: durationUs,
  });
  this._sampleIndex += numberOfFrames;
  return _pushToTracks(this, ad);
};

// Number of tracks currently able to receive data. Lets a producer test
// the source before doing the work of building a frame, rather than
// inferring it from a zero return afterwards.
function _defineLiveTrackCount(Ctor) {
  Object.defineProperty(Ctor.prototype, 'liveTrackCount', {
    get: function () {
      var n = 0;
      for (var i = 0; i < this._tracks.length; i++) {
        if (this._tracks[i].readyState === 'live') n++;
      }
      return n;
    },
  });
}
_defineLiveTrackCount(VideoSource);
_defineLiveTrackCount(AudioSource);

// ═══════════════════════════════════════
//  Sinks — consume frames from tracks
// ═══════════════════════════════════════

function _setupSink(self, track, kind, eventName, cbProp) {
  if (!track || track.kind !== kind) {
    throw new TypeError((kind === 'video' ? 'VideoSink' : 'AudioSink') +
      ': requires a ' + kind + ' MediaStreamTrack');
  }

  self._ee = new EventEmitter();
  self._track = track;
  self.stopped = false;
  self[cbProp] = null;

  self._handler = function (data) {
    if (self.stopped) return;
    self._ee.emit(eventName, data);
    if (typeof self[cbProp] === 'function') {
      self[cbProp](data);
    }
  };

  track.on(eventName, self._handler);
  track.on('ended', function () { self.stop(); });

  self.on = function (ev, fn) { self._ee.on(ev, fn); };
  self.off = function (ev, fn) { self._ee.off(ev, fn); };
  self.stop = function () {
    if (self.stopped) return;
    self.stopped = true;
    track.off(eventName, self._handler);
    self._ee.emit('stopped');
  };
}

// ── VideoSink ──

function VideoSink(track) {
  _setupSink(this, track, 'video', 'frame', 'onframe');
}

// ── AudioSink ──

function AudioSink(track) {
  _setupSink(this, track, 'audio', 'data', 'ondata');
}

export { VideoSource, AudioSource, VideoSink, AudioSink };
