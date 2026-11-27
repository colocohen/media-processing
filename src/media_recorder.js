/**
 * MediaRecorder — W3C MediaStream Recording (mediacapture-record) for Node.
 *
 * Two internal modes:
 *   1. 'pipe' (default): ONE MediaEncoder (one FFmpeg) encodes the raw
 *      frames / samples and muxes them into the container the mimeType
 *      names, streamed back through pipe:3.
 *   2. 'muxer' (video + audio with `outputFile`): a VideoEncoder and an
 *      AudioEncoder (WebCodecs) feed a Muxer. The container is ALSO
 *      written to `outputFile` as it is produced.
 *
 * Containers (the type decides; codecs= picks the codecs, else defaults):
 *   video/webm, audio/webm   WebM   (vp8 / vp9 / av1, opus)
 *   video/x-matroska         Matroska (h264 / h265 / vp8 / vp9 / av1, opus / aac)
 *   video/mp4, audio/mp4     fragmented MP4 (h264 / h265 / vp9 / av1, aac / opus)
 *   audio/ogg                Ogg Opus
 *
 * Usage (as in a browser):
 *   var rec = new MediaRecorder(stream, { mimeType: 'video/webm; codecs=vp8,opus' });
 *   rec.ondataavailable = function (e) { chunks.push(e.data); };   // e.data: Blob
 *   rec.onstop = function () { var blob = new Blob(chunks, { type: rec.mimeType }); };
 *   rec.start(1000);   // a dataavailable about every second
 *
 *   // Also write the recording to disk as it is produced (video + audio):
 *   new MediaRecorder(stream, { mimeType: 'video/mp4; codecs=h264,aac', outputFile: 'rec.mp4' });
 *
 * Per the spec:
 *   - the constructor throws NotSupportedError for an unsupported mimeType
 *     ("is type supported" with deferNewerCodecsCheck: a codec identifier
 *     that is not synchronously exposed is left to start());
 *     mimeType stays as given ('' when none) until start() picks one;
 *     start() completes the codecs the type did not name for the kinds the
 *     stream has, and throws NotSupportedError when a track cannot be
 *     recorded in the type
 *   - start/pause/resume/stop/dataavailable/error events are dispatched as
 *     queued tasks (never synchronously inside the call), in spec order
 *   - dataavailable's `data` is always a Blob of type mimeType (possibly
 *     empty), `timecode` is 0 for the first one
 *   - pause()/resume()/requestData() throw InvalidStateError when inactive
 *   - recording stops by itself (dataavailable, stop) when every recorded
 *     track has ended; with an InvalidModificationError when a track is
 *     added to or removed from the stream
 *   - a failure (FFmpeg exits, an encoder fails) fires error, then
 *     dataavailable, then stop
 *   - timeslice: a dataavailable once timeslice ms of data were gathered
 *     (paused time does not count; at least MIN_TIMESLICE_MS)
 *   - bitsPerSecond shared out between the recorded kinds
 */

import fs from 'node:fs';
import EventEmitter from './core/events.js';
import { domException } from './core/dom_exception.js';
import { parseCodecString } from './utils/codec_strings.js';
import MediaEncoder from './media_encoder.js';
import VideoEncoder from './video_encoder.js';
import AudioEncoder from './audio_encoder.js';
import Muxer from './muxer.js';
import VideoFrame from './video_frame.js';
import AudioData from './audio_data.js';

// type → what it can hold. `muxer` is FFmpeg's muxer name.
var CONTAINERS = {
  'video/webm':       { muxer: 'webm',     video: ['vp8', 'vp9', 'av1'], audio: ['opus'],
                        defaults: { video: 'vp9', audio: 'opus' } },
  'audio/webm':       { muxer: 'webm',     video: [], audio: ['opus'], defaults: { audio: 'opus' } },
  'video/x-matroska': { muxer: 'matroska', video: ['h264', 'h265', 'vp8', 'vp9', 'av1'], audio: ['opus', 'aac'],
                        defaults: { video: 'h264', audio: 'opus' } },
  'video/mp4':        { muxer: 'mp4',      video: ['h264', 'h265', 'vp9', 'av1'], audio: ['aac', 'opus'],
                        defaults: { video: 'h264', audio: 'aac' } },
  'audio/mp4':        { muxer: 'mp4',      video: [], audio: ['aac', 'opus'], defaults: { audio: 'aac' } },
  'audio/ogg':        { muxer: 'ogg',      video: [], audio: ['opus'], defaults: { audio: 'opus' } },
};

// Codec names as they appear in a reported mimeType.
var MIME_CODEC_NAME = { h264: 'avc1', h265: 'hev1', aac: 'mp4a.40.2' };

var DEFAULT_SLICE_MS = 1000;   // fragment / cluster length when no timeslice
var DEFAULT_VIDEO_BPS = 2000000;
var DEFAULT_AUDIO_BPS = 128000;
// "or some minimum time slice imposed by the UA, whichever is greater"
var MIN_TIMESLICE_MS = 10;

// mediacapture-record: "The list of synchronously exposed codec
// identifiers" — and the codec each names.
var EXPOSED = {
  vp8: 'vp8', vp9: 'vp9', h264: 'h264', avc1: 'h264', avc3: 'h264',
  av1: 'av1', av01: 'av1', hvc1: 'h265', hev1: 'h265', opus: 'opus', pcm: 'pcm',
};

/**
 * @param {MediaStream} stream
 * @param {object} [options]
 * @param {string} [options.mimeType]
 * @param {string} [options.outputFile]   also write the container to this file (video+audio: muxer mode)
 * @param {number} [options.videoBitsPerSecond]
 * @param {number} [options.audioBitsPerSecond]
 * @param {number} [options.bitsPerSecond]
 */
function MediaRecorder(stream, options) {
  if (!stream) throw new TypeError('MediaRecorder: MediaStream required');
  if (!options) options = {};

  var type = options.mimeType ? String(options.mimeType) : '';
  // W3C: an unsupported type throws here. It was accepted and silently
  // recorded as something else. "is type supported" with
  // deferNewerCodecsCheck true: a codec identifier that is not
  // synchronously exposed ('mp4a.40.2', 'vp09.…') is start()'s to decide.
  if (type && !_resolveType(type, true)) {
    throw domException('MediaRecorder: mimeType "' + type + '" is not supported', 'NotSupportedError');
  }

  this._ee = new EventEmitter();
  this.stream = stream;
  this._constrainedMimeType = type;
  this.mimeType = type;
  this.state = 'inactive';
  // W3C: the given values, else the UA's; a bitsPerSecond overrides both,
  // shared out ("such that the sum of videoBitsPerSecond and
  // audioBitsPerSecond is close to" it). It went to the video only, the
  // audio's 128 kb/s added on top.
  this._constrainedBitsPerSecond = options.bitsPerSecond !== undefined ? _ulong(options.bitsPerSecond) : null;
  this.videoBitsPerSecond = options.videoBitsPerSecond !== undefined ? _ulong(options.videoBitsPerSecond) : DEFAULT_VIDEO_BPS;
  this.audioBitsPerSecond = options.audioBitsPerSecond !== undefined ? _ulong(options.audioBitsPerSecond) : DEFAULT_AUDIO_BPS;
  if (this._constrainedBitsPerSecond !== null) this._splitBitrate(true, true);
  // W3C: "variable" unless the recorder supports the one asked (both are).
  this.audioBitrateMode = options.audioBitrateMode === 'constant' ? 'constant' : 'variable';
  this._keyFrameIntervalDuration = options.videoKeyFrameIntervalDuration !== undefined ? Number(options.videoKeyFrameIntervalDuration) : null;
  this._keyFrameIntervalCount = options.videoKeyFrameIntervalCount !== undefined ? _ulong(options.videoKeyFrameIntervalCount) : null;
  this.outputFile = options.outputFile || null;

  this._reset();

  // Event handler properties (browser-compatible)
  this.ondataavailable = null;
  this.onstop = null;
  this.onstart = null;
  this.onerror = null;
  this.onpause = null;
  this.onresume = null;
}

MediaRecorder.prototype._reset = function () {
  this._encoder = null;       // MediaEncoder (pipe mode)
  this._videoEncoder = null;  // VideoEncoder (muxer mode)
  this._audioEncoder = null;  // AudioEncoder (muxer mode)
  this._muxer = null;         // Muxer (muxer mode)
  this._file = null;          // fs.WriteStream (muxer mode)
  this._mode = null;          // 'pipe' | 'muxer'
  this._plan = null;          // { muxer, video, audio, mime }
  this._timeslice = 0;          // 0: none
  this._timesliceTimer = null;
  this._sliceGathered = 0;      // ms of data gathered into the current Blob (recording time)
  this._sliceSince = -1;        // when the current stretch of recording began (-1: not recording)
  this._sliceDue = false;       // timeslice reached with nothing gathered: cut at the next data
  this._ending = false;         // the recording is ending by itself (tracks, a failure)
  this._pausedAt = -1;
  this._offsetUs = 0;           // paused time taken out of the timestamps (muxer mode)
  this._framesSinceKey = 0;
  this._lastKeyTs = null;
  this._chunks = [];
  this._chunksStartMs = 0;    // when the first chunk of the current blob arrived
  this._firstChunkMs = -1;    // when the first chunk of the recording arrived (timecode 0)
  this._bytesWritten = 0;
  this._handlers = [];        // [{track, ev, fn}] to detach
  this._recorded = [];        // the tracks being recorded
  this._held = [];            // pipe mode: [{kind, item}] until the encoder starts
  this._firstVideo = null;    // { width, height } of the first frame
  this._firstAudio = null;    // { sampleRate, numberOfChannels } of the first AudioData
  this._finished = false;     // stop/error sequence queued
  this._failed = false;
};

MediaRecorder.prototype.addEventListener = function (type, listener) { this._ee.on(type, listener); };
MediaRecorder.prototype.removeEventListener = function (type, listener) { this._ee.off(type, listener); };

MediaRecorder.prototype._dispatch = function (type, data) {
  // Every dispatched object carries `type` and `target`, as an Event
  // does: handler code routinely reads e.type.
  var ev = data || {};
  if (ev.type === undefined) ev.type = type;
  if (ev.target === undefined) ev.target = this;
  this._ee.emit(type, ev);
  var handler = this['on' + type];
  if (typeof handler === 'function') handler.call(this, ev);
};

// W3C: every event is fired from a queued task. They were dispatched
// synchronously inside start()/pause()/..., i.e. before the call
// returned — a 'start' listener ran before start() came back.
// setImmediate callbacks run in the order they are queued.
MediaRecorder.prototype._queue = function (type, data) {
  var self = this;
  setImmediate(function () { self._dispatch(type, data); });
};

// Bitrates for the kinds recorded, from [[ConstrainedBitsPerSecond]]:
// audio a tenth (at most 128 kb/s) when both are, all of it to the one
// kind otherwise (audio at most 510 kb/s, Opus' ceiling).
MediaRecorder.prototype._splitBitrate = function (video, audio) {
  var bps = this._constrainedBitsPerSecond;
  if (video && !audio) { this.videoBitsPerSecond = bps; this.audioBitsPerSecond = 0; return; }
  if (audio && !video) { this.videoBitsPerSecond = 0; this.audioBitsPerSecond = Math.min(bps, 510000); return; }
  var a = Math.min(Math.floor(bps / 10), 128000);
  this.videoBitsPerSecond = bps - a;
  this.audioBitsPerSecond = a;
};

// ── start ──

/**
 * Start recording.
 * @param {number} [timeslice] — milliseconds between dataavailable events
 */
MediaRecorder.prototype.start = function (timeslice) {
  if (this.state !== 'inactive') {
    throw domException('MediaRecorder: already ' + this.state, 'InvalidStateError');
  }
  if (this.stream.active === false) {
    throw domException('MediaRecorder: the stream is inactive', 'NotSupportedError');
  }
  if (this._keyFrameIntervalDuration !== null && this._keyFrameIntervalCount !== null) {
    throw domException('MediaRecorder: videoKeyFrameIntervalDuration and videoKeyFrameIntervalCount cannot both be given', 'NotSupportedError');
  }

  var videoTracks = _live(this.stream.getVideoTracks());
  var audioTracks = _live(this.stream.getAudioTracks());
  // W3C: "For each track in tracks, if the User Agent cannot record the
  // track using the current configuration, then throw a NotSupportedError".
  // A track the type could not hold was left out ('audio/webm' recorded
  // the audio of a video stream), and one the codecs list did not name
  // ('video/webm;codecs=vp9' with audio) was dropped.
  var plan = _plan(this._constrainedMimeType, videoTracks.length > 0, audioTracks.length > 0);
  if (!plan) {
    throw domException('MediaRecorder: this stream cannot be recorded as "' +
      (this._constrainedMimeType || 'default') + '"', 'NotSupportedError');
  }

  this._reset();
  this._plan = plan;
  if (this._constrainedBitsPerSecond !== null) this._splitBitrate(!!plan.video, !!plan.audio);
  // WebIDL `optional unsigned long`: undefined is no timeslice; 0 (or
  // what converts to it) is a timeslice too — the UA's minimum. It was
  // taken as none, and a negative value as none instead of 2^32 - n.
  this._timeslice = timeslice === undefined ? 0 : Math.max(_ulong(timeslice), MIN_TIMESLICE_MS);
  this.state = 'recording';
  this._sliceSince = _nowMs();

  var vTrack = plan.video ? videoTracks[0] : null;
  var aTrack = plan.audio ? audioTracks[0] : null;
  this._recorded = [vTrack, aTrack].filter(Boolean);

  this._mode = (vTrack && aTrack && this.outputFile) ? 'muxer' : 'pipe';
  if (this._mode === 'muxer') this._startMuxerMode();
  else if (this.outputFile) this._openFile();
  this._wireTracks(vTrack, aTrack);

  // The UA's choice becomes visible with the 'start' event.
  var self = this;
  setImmediate(function () {
    if (self._plan === plan) self.mimeType = plan.mime;
    self._dispatch('start', {});
  });

  this._scheduleSlice();
};

// ── timeslice ──
//
// W3C: "once a minimum of timeslice milliseconds of data have been
// collected … start gathering data into a new Blob blob, and queue a task
// … that fires … dataavailable". A setInterval of wall time counted the
// paused time as data: 200 ms recorded, 800 ms paused, and a 1000 ms
// slice came out with 200 ms in it (while paused). The time gathered is
// recording time; the timer runs only while recording.

MediaRecorder.prototype._scheduleSlice = function () {
  if (this._timesliceTimer) { clearTimeout(this._timesliceTimer); this._timesliceTimer = null; }
  if (!this._timeslice || this.state !== 'recording' || this._ending) return;
  var gathered = this._sliceGathered + (this._sliceSince >= 0 ? _nowMs() - this._sliceSince : 0);
  var self = this;
  this._timesliceTimer = setTimeout(function () {
    self._timesliceTimer = null;
    if (self.state !== 'recording' || self._ending) return;
    // Nothing gathered yet: the Blob is cut with the next data.
    if (self._chunks.length) self._cutBlob(); else self._sliceDue = true;
  }, Math.max(0, this._timeslice - gathered));
};

// A new Blob: the current one goes out (dataavailable), the slice restarts.
MediaRecorder.prototype._cutBlob = function () {
  this._queueData();
  this._sliceGathered = 0;
  this._sliceDue = false;
  this._sliceSince = this.state === 'recording' ? _nowMs() : -1;
  this._scheduleSlice();
};

// ── Muxer mode: VideoEncoder + AudioEncoder → Muxer → Blob (+ file) ──

MediaRecorder.prototype._startMuxerMode = function () {
  var self = this;
  var plan = this._plan;
  var slice = this._timeslice || DEFAULT_SLICE_MS;

  // Streamed (no `file`): the bytes come back as 'data' and go both to
  // the Blobs and to outputFile. It used to pass {output}, which the
  // Muxer did not read, so the outputFile was never written.
  this._muxer = new Muxer({
    format: plan.muxer,
    fragmentDuration: slice * 1000,
    outputArgs: plan.muxer === 'mp4' ? [] : _streamingArgs(plan.muxer, slice),
    video: { codec: plan.video },
    audio: { codec: plan.audio },
  });
  this._muxer.on('data', function (chunk) { self._onData(chunk); });
  this._muxer.on('error', function (e) { self._fail(e); });
  this._openFile();

  this._videoEncoder = new VideoEncoder({
    output: function (chunk, metadata) { if (self._muxer) self._muxer.addVideoChunk(chunk, metadata); },
    error: function (e) { self._fail(e); },
  });
  this._audioEncoder = new AudioEncoder({
    output: function (chunk, metadata) { if (self._muxer) self._muxer.addAudioChunk(chunk, metadata); },
    error: function (e) { self._fail(e); },
  });
};

MediaRecorder.prototype._openFile = function () {
  if (!this.outputFile) return;
  var self = this;
  this._file = fs.createWriteStream(this.outputFile);
  this._file.on('error', function (e) { self._fail(e); });
};

// ── Track wiring ──

MediaRecorder.prototype._wireTracks = function (vTrack, aTrack) {
  var self = this;

  // Frames arrive inside the track's emit(), on the producer's stack.
  // A throw would be logged by core/events and lost; it becomes an
  // error (which ends the recording) instead.
  function guarded(fn) {
    return function (data) {
      if (self.state !== 'recording') return;
      try {
        fn(data);
      } catch (e) {
        self._fail(e);
      }
    };
  }
  function on(track, ev, fn) {
    track.on(ev, fn);
    self._handlers.push({ track: track, ev: ev, fn: fn });
  }

  if (vTrack) on(vTrack, 'frame', guarded(function (frame) { self._onMedia('video', frame); }));
  if (aTrack) on(aTrack, 'data', guarded(function (ad) { self._onMedia('audio', ad); }));

  // W3C: "If all recorded tracks become ended, then stop gathering data"
  // — and fire dataavailable + stop. Nothing watched the tracks: after
  // track.stop() the recorder stayed 'recording' with FFmpeg running.
  // '_stopped' fires on any end of the track (its own stop() fires no
  // 'ended'); 'ended' covers a track without the internal event.
  // The recorder stays in its state until the task that ends it (W3C:
  // "stop gathering data, and queue a task … Inactivate the recorder"); it
  // went inactive at once.
  var onEnded = function () {
    for (var i = 0; i < self._recorded.length; i++) {
      if (self._recorded[i].readyState !== 'ended') return;
    }
    self._end(null);
  };
  for (var i = 0; i < this._recorded.length; i++) {
    var t = this._recorded[i];
    on(t, t._source ? '_stopped' : 'ended', onEnded);
  }
  // W3C: "If at any point, a track is added to or removed from stream's
  // track set, the UA MUST stop gathering data, and queue a task … Fire an
  // error event named InvalidModificationError". Not watched at all.
  if (typeof this.stream.on === 'function') {
    on(this.stream, '_trackset', function () {
      self._end(domException("MediaRecorder: the stream's track set changed", 'InvalidModificationError'));
    });
  }
};

MediaRecorder.prototype._detachTracks = function () {
  for (var i = 0; i < this._handlers.length; i++) {
    var h = this._handlers[i];
    try { h.track.off(h.ev, h.fn); } catch (e) {}
  }
  this._handlers = [];
};

// One VideoFrame / AudioData from a recorded track.
//
// Encoders are configured from the FIRST delivered frame / AudioData,
// not from track settings: the settings' audio defaults (2 ch, 48 kHz)
// were used for a mono or 16 kHz source, so FFmpeg read the samples at
// the wrong layout — a 6 s mono recording came out 3 s long, a 3 s
// 16 kHz mono one 0.52 s.
//
// The frame is NOT closed here: the track hands the same object to all
// of its listeners, and closing it would empty it for the others.
MediaRecorder.prototype._onMedia = function (kind, item) {
  if (kind === 'video' && !this._firstVideo) {
    var v = item.visibleRect;
    this._firstVideo = { width: (v && v.width) || item.codedWidth, height: (v && v.height) || item.codedHeight };
  }
  if (kind === 'audio' && !this._firstAudio) {
    this._firstAudio = { sampleRate: item.sampleRate, numberOfChannels: item.numberOfChannels };
  }

  if (this._mode === 'muxer') {
    // The encoders keep the timestamps: the paused time is taken out of
    // them (the pipe mode's FFmpeg times by count, so it has no gap).
    var it = this._offsetUs ? _retimed(kind, item, item.timestamp - this._offsetUs) : item;
    if (kind === 'video') {
      if (this._videoEncoder.state === 'unconfigured') this._configureVideoEncoder();
      this._videoEncoder.encode(it, { keyFrame: this._wantKey(it.timestamp) });
    } else {
      if (this._audioEncoder.state === 'unconfigured') this._configureAudioEncoder();
      this._audioEncoder.encode(it);
    }
    if (it !== item) it.close();
    return;
  }

  // Pipe mode: one FFmpeg for both, so both formats must be known
  // before it starts. Held (as clones) until then.
  if (!this._encoder) {
    this._held.push({ kind: kind, item: typeof item.clone === 'function' ? item.clone() : item });
    this._maybeStartEncoder(false);
    return;
  }
  this._write(kind, item);
};

// videoKeyFrameIntervalDuration / Count (W3C start(): "the video encoder
// produces a keyframe on the first frame arriving after …"). Muxer mode;
// the pipe mode's FFmpeg picks its own.
MediaRecorder.prototype._wantKey = function (ts) {
  var d = this._keyFrameIntervalDuration, n = this._keyFrameIntervalCount;
  if (d === null && n === null) return false;
  var key = this._lastKeyTs === null ||
    (d !== null ? ts - this._lastKeyTs >= d * 1000 : this._framesSinceKey >= n);
  if (key) { this._lastKeyTs = ts; this._framesSinceKey = 1; } else { this._framesSinceKey++; }
  return key;
};

MediaRecorder.prototype._configureVideoEncoder = function () {
  var vs = _settings(this._recorded, 'video');
  this._videoEncoder.configure({
    codec: this._plan.video,
    width: this._firstVideo.width,
    height: this._firstVideo.height,
    framerate: vs.frameRate || 30,
    bitrate: this.videoBitsPerSecond || undefined,
    latencyMode: 'realtime',
  });
};

MediaRecorder.prototype._configureAudioEncoder = function () {
  this._audioEncoder.configure({
    codec: this._plan.audio,
    sampleRate: this._firstAudio.sampleRate,
    numberOfChannels: this._firstAudio.numberOfChannels,
    bitrate: this.audioBitsPerSecond || undefined,
    bitrateMode: this.audioBitrateMode,
  });
};

// Start the pipe-mode encoder once every recorded kind has delivered
// (or `force`, at stop). A kind still silent after 2 s of the other is
// configured from its track settings, so one dead track cannot hold the
// recording in memory forever.
MediaRecorder.prototype._maybeStartEncoder = function (force) {
  if (this._encoder) return;
  var plan = this._plan;
  var needV = plan.video && !this._firstVideo;
  var needA = plan.audio && !this._firstAudio;
  if (needV || needA) {
    if (!force && _heldSpanUs(this._held) < 2000000) return;
    if (!this._held.length) return;
  }
  var self = this;
  var slice = this._timeslice || DEFAULT_SLICE_MS;
  var opts = {
    format: plan.muxer,
    formatArgs: _streamingArgs(plan.muxer, slice),
    error: function (e) { self._fail(e); },
  };
  if (plan.video && (this._firstVideo || !force)) {
    var vs = _settings(this._recorded, 'video');
    var fv = this._firstVideo || { width: vs.width || 1280, height: vs.height || 720 };
    opts.video = { codec: plan.video, width: fv.width, height: fv.height,
                   framerate: vs.frameRate || 30, bitrate: this.videoBitsPerSecond };
  }
  if (plan.audio && (this._firstAudio || !force)) {
    var as = _settings(this._recorded, 'audio');
    var fa = this._firstAudio || { sampleRate: as.sampleRate || 48000, numberOfChannels: as.channelCount || 2 };
    opts.audio = { codec: plan.audio, sampleRate: fa.sampleRate, numberOfChannels: fa.numberOfChannels,
                   bitrate: this.audioBitsPerSecond };
  }
  this._encoder = new MediaEncoder(opts);
  this._encoder.on('data', function (chunk) { self._onData(chunk); });

  var held = this._held;
  this._held = [];
  for (var i = 0; i < held.length; i++) {
    try {
      if (this._encoder && !this._failed) this._write(held[i].kind, held[i].item);
    } catch (e) {
      this._fail(e);
    }
    try { if (held[i].item && typeof held[i].item.close === 'function') held[i].item.close(); } catch (e) {}
  }
};

MediaRecorder.prototype._write = function (kind, item) {
  if (kind === 'video') {
    if (this._encoder._videoConfig) this._encoder.writeVideoFrame(item);
  } else if (this._encoder._audioConfig) {
    this._encoder.writeAudioData(item);
  }
};

// ── Data ──

MediaRecorder.prototype._onData = function (data) {
  var bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  var now = _nowMs();
  if (this._firstChunkMs < 0) this._firstChunkMs = now;
  if (!this._chunks.length) this._chunksStartMs = now;
  this._chunks.push(bytes);
  this._bytesWritten += bytes.length;
  if (this._file) this._file.write(bytes);
  if (this._sliceDue) this._cutBlob();
};

// Queue a dataavailable with everything collected since the last one.
// The Blob is cut now (spec: "start a new Blob"), dispatched in a task.
MediaRecorder.prototype._queueData = function () {
  this._queue('dataavailable', this._blobEvent());
};

MediaRecorder.prototype._blobEvent = function () {
  var parts = this._chunks;
  var timecode = parts.length && this._firstChunkMs >= 0 ? this._chunksStartMs - this._firstChunkMs : 0;
  this._chunks = [];
  // W3C: data is a Blob of type mimeType, never null. It was a
  // Uint8Array (and null in muxer mode).
  var blob = new Blob(parts, { type: this._plan ? this._plan.mime : this.mimeType });
  return { data: blob, timecode: timecode, bytesWritten: this._bytesWritten };
};

// ── stop / pause / resume / requestData ──

/**
 * Stop recording. dataavailable (the rest of the data), then stop.
 */
MediaRecorder.prototype.stop = function () {
  if (this.state === 'inactive') return;
  var ending = this._ending;
  this._inactivate();
  if (ending) return;            // ending by itself already: that sequence fires
  this._ending = true;
  this._detachTracks();
  var self = this;
  this._flushEncoders(function () { self._finish(null); });
};

MediaRecorder.prototype.pause = function () {
  if (this.state === 'inactive') throw domException('MediaRecorder: not recording', 'InvalidStateError');
  if (this.state === 'paused') return;
  this.state = 'paused';
  var now = _nowMs();
  if (this._sliceSince >= 0) { this._sliceGathered += now - this._sliceSince; this._sliceSince = -1; }
  this._pausedAt = now;
  if (this._timesliceTimer) { clearTimeout(this._timesliceTimer); this._timesliceTimer = null; }
  this._queue('pause', {});
};

MediaRecorder.prototype.resume = function () {
  if (this.state === 'inactive') throw domException('MediaRecorder: not recording', 'InvalidStateError');
  if (this.state === 'recording') return;
  this.state = 'recording';
  var now = _nowMs();
  if (this._pausedAt >= 0) { this._offsetUs += Math.round((now - this._pausedAt) * 1000); this._pausedAt = -1; }
  if (!this._ending) this._sliceSince = now;
  this._queue('resume', {});
  this._scheduleSlice();
};

/**
 * Deliver what has been collected so far (dataavailable; the Blob may be
 * empty).
 */
MediaRecorder.prototype.requestData = function () {
  if (this.state === 'inactive') throw domException('MediaRecorder: not recording', 'InvalidStateError');
  // "Create a new Blob and gather subsequent data into it": the slice
  // starts again.
  this._cutBlob();
};

// W3C "inactivate the recorder": state inactive, mimeType back to the
// constructor's value. Stops gathering.
MediaRecorder.prototype._inactivate = function () {
  this.state = 'inactive';
  this.mimeType = this._constrainedMimeType;
  if (this._constrainedBitsPerSecond !== null) this._splitBitrate(true, true);
  this._sliceSince = -1;
  if (this._timesliceTimer) {
    clearTimeout(this._timesliceTimer);
    this._timesliceTimer = null;
  }
};

// The recording ends by itself (err null: its tracks ended; a DOMException:
// the track set changed): stop gathering now, write what was gathered,
// then one task: inactivate, error, dataavailable, stop.
MediaRecorder.prototype._end = function (err) {
  if (this._ending || this._finished || this.state === 'inactive') return;
  this._ending = true;
  this._detachTracks();
  if (this._timesliceTimer) { clearTimeout(this._timesliceTimer); this._timesliceTimer = null; }
  var self = this;
  this._flushEncoders(function () { self._finish(err); });
};

MediaRecorder.prototype._flushEncoders = function (done) {
  var self = this;
  if (this._mode === 'muxer') {
    var pending = 2;
    var one = function () {
      if (--pending > 0) return;
      if (!self._muxer) { done(); return; }
      self._muxer.finalize(function () { self._closeFile(done); });
    };
    [this._videoEncoder, this._audioEncoder].forEach(function (enc) {
      if (enc && enc.state === 'configured') {
        enc.flush().then(one, one);
      } else {
        one();
      }
    });
    return;
  }
  // Pipe mode. Something held but never started (one kind never came):
  // start with what there is, so it is not lost.
  if (!this._encoder && this._held.length) this._maybeStartEncoder(true);
  if (this._encoder) {
    this._encoder.flush(function () { self._closeFile(done); });   // a failure has reached _fail already
  } else {
    this._closeFile(done);
  }
};

MediaRecorder.prototype._closeFile = function (done) {
  if (!this._file) { done(); return; }
  var f = this._file;
  this._file = null;
  f.end(function () { done(); });
};

// The end of a recording, normal (err null) or failed: error (if any),
// dataavailable with the rest, stop — each in its own task, once.
// One task (W3C: "queue a task … that runs the following steps:
// Inactivate the recorder … Fire an error event … Fire a blob event named
// dataavailable … Fire an event named stop"): the recorder becomes
// inactive in that task when it ended by itself.
MediaRecorder.prototype._finish = function (err) {
  if (this._finished) return;
  this._finished = true;
  var data = this._blobEvent();
  this._cleanup();
  var self = this;
  setImmediate(function () {
    if (self.state !== 'inactive') self._inactivate();
    if (err) self._dispatch('error', { error: _asDomError(err) });
    self._dispatch('dataavailable', data);
    self._dispatch('stop', {});
  });
};

// A failure while recording: FFmpeg exited, an encoder failed, a frame
// could not be converted. It used to vanish — 'video/webm; codecs=vp8,
// opus' produced 0 bytes, then 'stop', and no 'error' at all.
MediaRecorder.prototype._fail = function (e) {
  if (this._failed || this._finished) return;
  this._failed = true;
  var self = this;
  if (this.state === 'inactive' || this._ending) {
    // Already stopping: the error goes out ahead of the dataavailable
    // and stop that the stop sequence queues.
    this._queue('error', { error: _asDomError(e) });
    return;
  }
  // Stop gathering; the recorder becomes inactive in _finish's task.
  this._ending = true;
  this._detachTracks();
  if (this._timesliceTimer) { clearTimeout(this._timesliceTimer); this._timesliceTimer = null; }
  // Keep whatever the process still delivers before it is gone.
  setImmediate(function () { self._closeFile(function () { self._finish(e); }); });
};

MediaRecorder.prototype._cleanup = function () {
  for (var i = 0; i < this._held.length; i++) {
    try { if (this._held[i].item && this._held[i].item.close) this._held[i].item.close(); } catch (e) {}
  }
  this._held = [];
  if (this._encoder) { this._encoder.close(); this._encoder = null; }
  if (this._videoEncoder) { try { this._videoEncoder.close(); } catch (e) {} this._videoEncoder = null; }
  if (this._audioEncoder) { try { this._audioEncoder.close(); } catch (e) {} this._audioEncoder = null; }
  if (this._muxer) { this._muxer.close(); this._muxer = null; }
  if (this._file) { try { this._file.end(); } catch (e) {} this._file = null; }
};

/**
 * W3C isTypeSupported(): '' → true; a type this recorder can produce.
 * MIME parameters are parsed properly: `video/webm;codecs=vp8` (no
 * space) and `codecs="vp8"` (quoted) were both reported unsupported, and
 * only a fixed list of exact strings was known.
 * @param {string} mimeType
 * @returns {boolean}
 */
MediaRecorder.isTypeSupported = function (mimeType) {
  var s = String(mimeType === undefined ? '' : mimeType);
  if (s === '') return true;
  // W3C "is type supported" with deferNewerCodecsCheck false: a codec
  // identifier that is not synchronously exposed makes it false
  // ('video/mp4;codecs=avc1,mp4a.40.2', 'video/webm;codecs=vp09.00.10.08'
  // were true; Chrome says false too).
  return !!_resolveType(s, false);
};

// ── Helpers ──

// Parse a MIME type: { type, params } (lowercased type and names), or
// null when it is not one. RFC 9110 media-type syntax, values may be
// quoted strings.
function _parseMime(str) {
  var s = String(str).trim();
  var semi = s.indexOf(';');
  var type = (semi < 0 ? s : s.substring(0, semi)).trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)) return null;
  var params = {};
  var i = semi < 0 ? s.length : semi + 1;
  while (i < s.length) {
    while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === ';')) i++;
    var eq = s.indexOf('=', i);
    if (eq < 0) break;
    var name = s.substring(i, eq).trim().toLowerCase();
    i = eq + 1;
    var value = '';
    if (s[i] === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length) i++;
        value += s[i++];
      }
      i++;
      var next = s.indexOf(';', i);
      i = next < 0 ? s.length : next + 1;
    } else {
      var end = s.indexOf(';', i);
      if (end < 0) end = s.length;
      value = s.substring(i, end).trim();
      i = end + 1;
    }
    if (name && !(name in params)) params[name] = value;
  }
  return { type: type, params: params };
}

// The container and codecs a type names, or null when unsupported:
// { type, container, video, audio, videoString, audioString, explicit,
// unknown } (codecs null = not named). mediacapture-record's "is type
// supported": a synchronously exposed identifier (the part before the
// first '.') must fit the container; another one makes the answer
// `defer` (the constructor's true: start() decides — `unknown` when this
// recorder does not know it at all).
function _resolveType(str, defer) {
  var m = _parseMime(str);
  if (!m) return null;
  var c = CONTAINERS[m.type];
  if (!c) return null;
  var out = { type: m.type, container: c, video: null, audio: null, videoString: null, audioString: null,
              explicit: false, unknown: false };
  if (m.params.codecs === undefined) return out;
  out.explicit = true;
  var list = m.params.codecs.split(',');
  for (var i = 0; i < list.length; i++) {
    var raw = list[i].trim();
    var id = raw.toLowerCase();
    if (!id) return null;
    var identifier = id.split('.')[0];
    var isExposed = Object.prototype.hasOwnProperty.call(EXPOSED, identifier);
    var name;
    if (isExposed) name = EXPOSED[identifier];
    else if (!defer) return null;
    else name = parseCodecString(id);
    if (!name) { out.unknown = true; continue; }
    if (c.video.indexOf(name) >= 0) {
      if (out.video) return null;              // more than one video codec
      out.video = name; out.videoString = raw;
    } else if (c.audio.indexOf(name) >= 0) {
      if (out.audio) return null;              // more than one audio codec
      out.audio = name; out.audioString = raw;
    } else if (isExposed) {
      return null;
    } else {
      out.unknown = true;
    }
  }
  return out;
}

// What start() records: the type (given, or the default for the
// stream's tracks), its codecs, and the reported mimeType. The kinds the
// stream has and the codecs list did not name get the container's
// defaults (W3C: "If the container and codecs to use for the recording
// have not yet been fully specified, the User Agent specifies them"; the
// extendedMimeType names them); a kind the container cannot hold: null.
function _plan(constrained, hasVideo, hasAudio) {
  var r = constrained ? _resolveType(constrained, true)
    : _resolveType(hasVideo ? 'video/webm' : 'audio/webm', true);
  if (!r || r.unknown) return null;
  var c = r.container;
  var video = hasVideo ? (r.video || c.defaults.video || null) : null;
  var audio = hasAudio ? (r.audio || c.defaults.audio || null) : null;
  if ((hasVideo && !video) || (hasAudio && !audio)) return null;
  if (!video && !audio) return null;
  var completed = (hasVideo && !r.video) || (hasAudio && !r.audio);
  var mime = constrained;
  if (!r.explicit || completed) {
    var names = [];
    if (video) names.push(r.video ? r.videoString : (MIME_CODEC_NAME[video] || video));
    if (audio) names.push(r.audio ? r.audioString : (MIME_CODEC_NAME[audio] || audio));
    mime = r.type + ';codecs=' + names.join(',');
  }
  return { muxer: c.muxer, video: video, audio: audio, mime: mime };
}

// FFmpeg muxer options that make the container come out while recording
// — in pieces of about `sliceMs` — instead of at the end. A video+audio
// MP4 was fragmented only at keyframes (frag_keyframe), so a 4 s
// recording with start(500) got one dataavailable, at stop.
function _streamingArgs(muxer, sliceMs) {
  if (muxer === 'mp4') {
    return ['-movflags', 'empty_moov+default_base_moof', '-frag_duration', String(Math.round(sliceMs * 1000))];
  }
  if (muxer === 'webm' || muxer === 'matroska') {
    return ['-cluster_time_limit', String(Math.round(sliceMs))];
  }
  if (muxer === 'ogg') {
    return ['-page_duration', String(Math.round(Math.min(sliceMs, 1000) * 1000))];
  }
  return [];
}

// WebIDL unsigned long (no [EnforceRange]): ToNumber, NaN / ±Infinity → 0,
// truncated, modulo 2^32.
function _ulong(v) {
  var n = Number(v);
  if (!isFinite(n)) return 0;
  n = Math.trunc(n) % 4294967296;
  return n < 0 ? n + 4294967296 : n;
}

// A VideoFrame / AudioData at another timestamp (theirs are read-only).
function _retimed(kind, item, ts) {
  if (kind === 'video') return new VideoFrame(item, { timestamp: ts });
  var planes = item.format && item.format.indexOf('planar') >= 0 ? item.numberOfChannels : 1;
  var size = 0, parts = [];
  for (var p = 0; p < planes; p++) {
    var b = new Uint8Array(item.allocationSize({ planeIndex: p }));
    item.copyTo(b, { planeIndex: p });
    parts.push(b); size += b.length;
  }
  var data = new Uint8Array(size), off = 0;
  for (var q = 0; q < parts.length; q++) { data.set(parts[q], off); off += parts[q].length; }
  return new AudioData({ format: item.format, sampleRate: item.sampleRate, numberOfFrames: item.numberOfFrames,
                         numberOfChannels: item.numberOfChannels, timestamp: ts, data: data });
}

function _live(tracks) {
  return (tracks || []).filter(function (t) { return t.readyState !== 'ended'; });
}

function _settings(tracks, kind) {
  for (var i = 0; i < tracks.length; i++) {
    if (tracks[i].kind === kind && typeof tracks[i].getSettings === 'function') return tracks[i].getSettings();
  }
  return {};
}

// How much media the pipe-mode hold queue spans (µs).
function _heldSpanUs(held) {
  if (held.length < 2) return 0;
  var a = held[0].item, b = held[held.length - 1].item;
  return (b && a && typeof b.timestamp === 'number') ? b.timestamp - a.timestamp : 0;
}

function _asDomError(e) {
  if (e && typeof DOMException !== 'undefined' && e instanceof DOMException) return e;
  var d = domException((e && e.message) || String(e), 'UnknownError');
  try { d.cause = e; } catch (x) {}
  return d;
}

function _nowMs() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

export default MediaRecorder;
