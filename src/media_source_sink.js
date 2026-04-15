/**
 * VideoSource / AudioSource — Programmatic media frame sources.
 * VideoSink / AudioSink — Consume frames from a MediaStreamTrack.
 *
 * Like wrtc's RTCVideoSource/RTCVideoSink / RTCAudioSource/RTCAudioSink.
 */

import { EventEmitter } from 'node:events';
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

function _pushToTracks(self, data) {
  for (var i = 0; i < self._tracks.length; i++) {
    if (self._tracks[i].readyState === 'live') {
      self._tracks[i]._push(data);
    }
  }
}

// ── VideoSource ──

function VideoSource(opts) {
  if (!opts) opts = {};
  this._tracks = [];
  this._frameIndex = 0;
  this.isScreencast = !!opts.isScreencast;
}

VideoSource.prototype.createTrack = function () {
  return _createTrack(this, 'video', 'VideoSource');
};

VideoSource.prototype.onFrame = function (frame) {
  if (!frame || !frame.data) return;
  var vf;
  if (frame instanceof VideoFrame) {
    vf = frame;
  } else {
    vf = new VideoFrame({
      data: frame.data,
      format: frame.format || 'I420',
      codedWidth: frame.width || 0,
      codedHeight: frame.height || 0,
      timestamp: frame.timestamp || Math.round((this._frameIndex * 1e6) / 30),
    });
  }
  this._frameIndex++;
  _pushToTracks(this, vf);
};

// ── AudioSource ──

function AudioSource() {
  this._tracks = [];
  this._sampleIndex = 0;
}

AudioSource.prototype.createTrack = function () {
  return _createTrack(this, 'audio', 'AudioSource');
};

AudioSource.prototype.onData = function (data) {
  if (!data || !data.samples) return;
  var sampleRate = data.sampleRate || 48000;
  var channels = data.channelCount || 1;
  var buf = Buffer.isBuffer(data.samples) ? data.samples : Buffer.from(data.samples.buffer);
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
  _pushToTracks(this, ad);
};

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
