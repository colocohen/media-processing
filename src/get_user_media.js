/**
 * getUserMedia — Camera, microphone, and screen capture.
 *
 * Improvements:
 *  - the capture process is killed when its last track (clones included)
 *    is stopped; the process exiting ends the tracks ('ended')
 *  - enumerateDevices() lists available cameras/mics/speakers
 *  - W3C MediaCapture compatibility: ConstrainULong/Double/DOMString/
 *    Boolean constraint objects ({ exact, ideal, min, max }) and
 *    `advanced` are evaluated against the probed devices (SelectSettings,
 *    OverconstrainedError), the spec-name aliases (frameRate, deviceId)
 *    are accepted, and the original constraints are stored on the track
 *    for getConstraints().
 *  - the returned promise settles only once capture is actually running:
 *    it resolves on the first data from the capture process, and rejects
 *    (NotFoundError / NotReadableError / AbortError) when there is no
 *    device or the process fails to start.
 */

import GStreamerProcess from './gstreamer_process.js';
import FFmpegProcess from './ffmpeg_process.js';
import FrameQueue from './core/frame_queue.js';
import { MediaStream, MediaStreamTrack, MediaDeviceInfo, InputDeviceInfo } from './media_stream.js';
import VideoFrame from './video_frame.js';
import AudioData from './audio_data.js';
import { spawnSync } from 'node:child_process';
import { resolveConstraint, selectSettings, overconstrainedError } from './core/constraints.js';
import { domException } from './core/dom_exception.js';
import { frameByteSize } from './core/frame_size.js';
import { platform } from 'node:os';
import { performance } from 'node:perf_hooks';

// The resolver lives in core/constraints.js (MediaStreamTrack.applyConstraints
// needs it too, and media_stream.js cannot import this module back).
var _resolveConstraint = resolveConstraint;

/**
 * Read a constraint from a constraints object, accepting either the W3C
 * name (preferred) or a library-specific alias; resolved to one value.
 */
function _readConstraint(opts, names, ropts) {
  if (!opts) return undefined;
  for (var i = 0; i < names.length; i++) {
    if (names[i] in opts) {
      var resolved = _resolveConstraint(opts[names[i]], ropts);
      if (resolved !== undefined) return resolved;
    }
  }
  return undefined;
}

// How long getUserMedia waits for the first data from a capture process
// before giving up (Chrome: "AbortError: Timeout starting video source").
// Covers the device probe too. Cameras that need ~2-3 s to wake fit.
var START_TIMEOUT_MS = 10000;

// Library aliases → W3C names (older code used fps / device / ...).
var VIDEO_ALIASES = { fps: 'frameRate', framerate: 'frameRate', device: 'deviceId' };
var AUDIO_ALIASES = { device: 'deviceId', numberOfChannels: 'channelCount' };

function _labelMatch(device, want) {
  return !!(device && device.label && device.label.indexOf(want) >= 0);
}

// The constrainable properties per kind (constraint names not listed are
// ignored, per spec). def = the value used when nothing asks otherwise.
var VIDEO_PROPS = {
  width:       { type: 'ulong',  def: 1280 },
  height:      { type: 'ulong',  def: 720 },
  frameRate:   { type: 'double', def: 30 },
  aspectRatio: { type: 'double' },
  deviceId:    { type: 'string', match: _labelMatch },
  groupId:     { type: 'string' },
  facingMode:  { type: 'string' },
  resizeMode:  { type: 'string' },
};
var AUDIO_PROPS = {
  sampleRate:       { type: 'ulong', def: 48000 },
  channelCount:     { type: 'ulong', def: 2 },
  sampleSize:       { type: 'ulong', def: 16 },
  echoCancellation: { type: 'boolean' },
  autoGainControl:  { type: 'boolean' },
  noiseSuppression: { type: 'boolean' },
  deviceId:         { type: 'string', match: _labelMatch },
  groupId:          { type: 'string' },
};

function _isObj(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }

/** Copy of a constraint set with library aliases renamed to W3C names. */
function _canonical(opts, aliases) {
  var out = {};
  if (!_isObj(opts)) return out;
  for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) out[k] = opts[k];
  for (var a in aliases) {
    if (a in out) {
      if (!(aliases[a] in out)) out[aliases[a]] = out[a];
      delete out[a];
    }
  }
  return out;
}

/**
 * What a probed camera can deliver, for constraint evaluation. The
 * pipeline scales (videoscale, add-borders) and drops/duplicates frames
 * (videorate) DOWN from the native modes — resizeMode 'crop-and-scale' —
 * so any size up to the largest native mode, and any rate up to the
 * fastest one, is satisfiable. Upscaling beyond the device is not.
 */
function _videoCaps(dev) {
  var c = GStreamerProcess.capabilitiesFromModes(dev.modes, 'videoinput');
  if (!c.width) return { deviceId: dev.deviceId, groupId: dev.deviceId };
  return {
    width:       { min: 1, max: c.width.max },
    height:      { min: 1, max: c.height.max },
    frameRate:   { min: Math.min(1, c.frameRate.min), max: c.frameRate.max },
    aspectRatio: { min: 1 / c.height.max, max: c.width.max },
    deviceId:    dev.deviceId,
    groupId:     dev.deviceId,
    resizeMode:  ['none', 'crop-and-scale'],
  };
}

function _audioCaps(dev) {
  var c = GStreamerProcess.capabilitiesFromModes(dev.modes, 'audioinput');
  var out = {
    sampleSize:       { min: 16, max: 16 },   // the pipeline delivers S16LE
    echoCancellation: [true, false],
    autoGainControl:  [true, false],
    noiseSuppression: [true, false],
    deviceId:         dev.deviceId,
    groupId:          dev.deviceId,
  };
  // audioconvert / audioresample convert to any rate / channel count,
  // but stay within what the device reports.
  if (c.sampleRate) out.sampleRate = c.sampleRate;
  if (c.channelCount) out.channelCount = c.channelCount;
  return out;
}

/**
 * Probe → candidates → SelectSettings. Resolves { device, settings };
 * rejects NotFoundError (the probe ran and found no device of the kind)
 * or OverconstrainedError. When the probe could not run, nothing is
 * known about the devices: the constraints only bound the settings and
 * the default device is opened (as before).
 */
function _select(kind, cs, props, capsFn) {
  return GStreamerProcess.probeDevices().then(function (probe) {
    var devices = [];
    for (var i = 0; i < probe.devices.length; i++) {
      if (probe.devices[i].kind === kind) devices.push(probe.devices[i]);
    }
    if (probe.ok && !devices.length) {
      throw domException('Requested device not found (no ' + kind + ' device)', 'NotFoundError');
    }
    var candidates = probe.ok
      ? devices.map(function (d) { return { device: d, caps: capsFn(d) }; })
      : [{ device: null, caps: null }];
    var sel = selectSettings(cs, candidates, props);
    if (sel.failed !== undefined) {
      throw overconstrainedError(sel.failed,
        'Constraint "' + sel.failed + '" cannot be satisfied by any ' + kind + ' device');
    }
    return { device: sel.candidate.device, settings: sel.settings };
  });
}

/**
 * Settles once a capture process is really running: resolves on its first
 * data; rejects NotReadableError when it errors / exits first, AbortError
 * on timeout or abort() (track stopped during start-up). getUserMedia used
 * to resolve before anything had started: with no camera, no GStreamer or
 * a busy device the app got a 'live' track that ended 20 ms later (C7).
 */
function _starter(proc, what, dataEvent) {
  var st = { done: false, started: false };
  var resolveFn, rejectFn;
  st.promise = new Promise(function (res, rej) { resolveFn = res; rejectFn = rej; });
  st.promise.catch(function () {});   // the caller may not be awaiting yet

  function settle(err) {
    if (st.done) return;
    st.done = true;
    clearTimeout(timer);
    proc.off(dataEvent, onData);
    proc.off('error', onError);
    proc.off('close', onClose);
    if (err) { st.error = err; rejectFn(err); }
    else { st.started = true; resolveFn(); }
  }
  function onData() { settle(null); }
  function onError(e) {
    settle(domException('Could not start ' + what + ': ' + ((e && e.message) || e), 'NotReadableError'));
  }
  function onClose(code) {
    settle(domException('Could not start ' + what + ': the capture process exited (code ' +
      code + ') before delivering any data', 'NotReadableError'));
  }
  proc.on(dataEvent, onData);
  proc.on('error', onError);
  proc.on('close', onClose);
  var timer = setTimeout(function () {
    settle(domException('Timeout starting ' + what, 'AbortError'));
  }, START_TIMEOUT_MS);

  st.abort = function (err) {
    settle(err || domException('Starting ' + what + ' was aborted: the track was stopped', 'AbortError'));
  };
  return st;
}

// ── Capture clock ──
//
// Timestamps used to be a frame / chunk COUNTER (frameIdx * 1e6 / fps):
// every frame the leaky queue dropped (slow consumer) or the camera never
// produced compressed time, and video and audio — counted separately —
// drifted apart. Now every capture is on one monotonic clock shared by all
// tracks in the process (µs since the first capture started): a source's
// data is laid out back to back from when it first arrived, and re-anchored
// forward when the wall clock runs ahead of it by more than `slackUs`
// (data was lost). A stalled event loop delivering a backlog late does not
// trigger that: the backlog's end still matches the clock.
var _clockOrigin = null;

function _nowUs() {
  if (_clockOrigin === null) _clockOrigin = performance.now();
  return (performance.now() - _clockOrigin) * 1000;
}

function _sourceClock(bytesPerUnit, unitUs, slackUs) {
  var base = null, bytes = 0, units = 0;
  return {
    // Call with every chunk from the process, BEFORE framing it.
    onBytes: function (n) {
      var now = _nowUs();
      if (base === null) base = Math.max(0, now - (n / bytesPerUnit) * unitUs);
      bytes += n;
      var expectedEnd = base + (bytes / bytesPerUnit) * unitUs;
      if (now - expectedEnd > slackUs) base += now - expectedEnd;
    },
    // Timestamp of the next complete unit (frame / chunk).
    next: function () {
      var ts = Math.round((base || 0) + units * unitUs);
      units++;
      return ts;
    },
  };
}

/**
 * @param {object} constraints — W3C MediaStreamConstraints
 *   { video: boolean | MediaTrackConstraints,
 *     audio: boolean | MediaTrackConstraints,
 *     screen: ... (library extension, not W3C — use getDisplayMedia) }
 * @param {function} [cb] — node-style callback(err, mediaStream); also
 *   returns a Promise.
 *
 * Browser-compatible: returns a Promise that resolves once every capture
 * delivers data, with capabilities and settings populated; it rejects
 * with OverconstrainedError (constraint unsatisfiable, `.constraint`
 * names it), NotFoundError (no device of the kind), NotReadableError
 * (the capture process failed) or AbortError (start-up timeout).
 */
function getUserMedia(constraints, cb) {
  // W3C: getUserMedia() with no MediaStreamConstraints rejects with
  // a TypeError. The previous error message is preserved for callers
  // that match on the string.
  if (!constraints) {
    var err = new TypeError('getUserMedia: constraints required');
    if (cb) { cb(err); return; }
    return Promise.reject(err);
  }

  // W3C: at least one of {video, audio} must be requested. The library
  // also accepts 'screen' as an extension.
  var wantsAnything = constraints.video || constraints.audio || constraints.screen;
  if (!wantsAnything) {
    var err2 = new TypeError(
      'getUserMedia: at least one of {video, audio} must be requested'
    );
    if (cb) { cb(err2); return; }
    return Promise.reject(err2);
  }

  var stream = new MediaStream();
  var pending = [];

  if (constraints.video) {
    pending.push(_startCapture(stream, constraints.video, 'camera'));
  }

  if (constraints.screen) {
    pending.push(_startCapture(stream, constraints.screen, 'screen'));
  }

  if (constraints.audio) {
    pending.push(_startAudioCapture(stream, constraints.audio));
  }

  var promise = _settleAll(stream, pending);

  if (cb) {
    promise.then(function (s) { cb(null, s); }, function (e) { cb(e); });
    return stream;
  }
  return promise;
}

/**
 * All captures started → the stream. One failed → stop every track of
 * the stream (killing the processes that did start), then reject.
 */
function _settleAll(stream, pending) {
  return Promise.all(pending).then(function () { return stream; }, function (e) {
    var tracks = stream.getTracks();
    for (var i = 0; i < tracks.length; i++) {
      stream.removeTrack(tracks[i]);
      tracks[i].stop();
    }
    throw e;
  });
}

function _startCapture(stream, opts, mode) {
  if (mode === 'screen') return _startScreenCapture(stream, opts);

  // opts may be `true` ("any video"), false/undefined (caller already
  // filtered this out before calling us), or a MediaTrackConstraints
  // object. Treat boolean true as empty constraints.
  var cs = _canonical(opts, VIDEO_ALIASES);

  var track = new MediaStreamTrack({ kind: 'video', label: 'camera', settings: {} });

  // Store the original (un-normalized) constraints on the track so
  // getConstraints() returns what the caller passed in, per spec
  // §5.2 step "set [[constraints]] internal slot".
  track._constraints = _isObj(opts) ? opts : {};

  var gst = new GStreamerProcess();
  stream.addTrack(track);
  stream._processes.push(gst);

  var starter = _starter(gst, 'video source', 'data');
  // Stopping the last track of this source kills the capture process
  // (and cancels a start still in progress).
  track._onStop = function () { gst.stop(); starter.abort(); };

  gst.on('error', function (e) { if (starter.started) track._ee.emit('error', e); });
  // The capture process exiting is the source ending: every track of
  // it (clones too) ends, with 'ended' — not a stop() by the app.
  gst.on('close', function () { track._endSource(); });

  return _select('videoinput', cs, VIDEO_PROPS, _videoCaps).then(function (sel) {
    if (starter.done) return starter.promise;   // stopped meanwhile
    var dev = sel.device;
    var s = sel.settings;
    var w = s.width, h = s.height, fps = s.frameRate;

    var settings = track._settings;
    settings.width = w;
    settings.height = h;
    settings.frameRate = fps;
    settings.aspectRatio = w / h;
    settings.deviceId = dev ? dev.deviceId : _readConstraint(cs, ['deviceId']);
    settings.groupId = dev ? dev.deviceId : undefined;
    // 'none' when a native mode is delivered as is.
    settings.resizeMode = (dev && _hasNativeSize(dev.modes, w, h)) ? 'none' : 'crop-and-scale';
    if (dev) {
      track._capabilities = GStreamerProcess.capabilitiesFromModes(dev.modes, 'videoinput');
      track.label = dev.label;
    }

    // GStreamer writes I420 in ITS default layout: 4-byte aligned plane
    // strides, even luma rows. The frame size was (w*h*3)>>1 — floored
    // chroma, so at odd sizes (321x241) no frame ever matched the
    // VideoFrame size check (C3) — and the buffer was taken as tightly
    // packed, so at widths not a multiple of 8 (854, 1366) every row
    // after the first was shifted: sheared picture (C4). Frame on
    // GStreamer's size, repack to tight I420 (no copy when they agree).
    var layout = GStreamerProcess.i420Layout(w, h);
    var clock = _sourceClock(layout.size, 1e6 / fps, Math.max(100000, 2e6 / fps));
    var fq = new FrameQueue(layout.size, function (frameBuf) {
      if (track.readyState === 'ended') return;
      var vf = new VideoFrame({
        data: GStreamerProcess.repackI420(frameBuf, w, h, layout),
        format: 'I420',
        codedWidth: w,
        codedHeight: h,
        timestamp: clock.next(),
      });
      track._push(vf);
    });
    gst.on('data', function (chunk) { clock.onBytes(chunk.length); fq.push(chunk); });

    gst.startCamera({
      width: w, height: h, fps: fps,
      device: settings.deviceId,
      deviceInfo: dev,
    });
    return starter.promise;
  }, function (e) {
    starter.abort(e);
    throw e;
  });
}

function _hasNativeSize(modes, w, h) {
  for (var i = 0; i < (modes || []).length; i++) {
    if (modes[i].width === w && modes[i].height === h) return true;
  }
  return false;
}

/**
 * Screen capture track (getDisplayMedia, and getUserMedia's `screen`
 * extension). The frame size is known only once the grabbed surface's
 * native size has been probed (GStreamerProcess 'size' event).
 */
function _startScreenCapture(stream, opts) {
  var vOpts = _canonical(opts, VIDEO_ALIASES);
  // width / height: when not asked for, the surface's native size.
  var w   = Number(_readConstraint(vOpts, ['width'], { integer: true }));
  var h   = Number(_readConstraint(vOpts, ['height'], { integer: true }));
  var fps = Number(_readConstraint(vOpts, ['frameRate'], { preferred: 30 }));
  if (!Number.isFinite(w) || w <= 0) w = undefined;
  if (!Number.isFinite(h) || h <= 0) h = undefined;
  if (!Number.isFinite(fps) || fps <= 0) fps = 30;
  var device = _readConstraint(vOpts, ['deviceId']);

  var track = new MediaStreamTrack({
    kind: 'video', label: 'screen',
    settings: {
      width: w, height: h, frameRate: fps,
      deviceId: device,
      displaySurface: vOpts.displaySurface || 'monitor',
      cursor: vOpts.cursor === false ? 'never' : 'always',
    },
  });
  track._constraints = _isObj(opts) ? opts : {};

  var gst = new GStreamerProcess();
  stream.addTrack(track);
  stream._processes.push(gst);

  var starter = _starter(gst, 'screen capture', 'data');
  track._onStop = function () { gst.stop(); starter.abort(); };

  var fq = null, clock = null;
  gst.on('size', function (sz) {
    track._settings.width = sz.width;
    track._settings.height = sz.height;
    track._settings.aspectRatio = sz.width / sz.height;
    var fw = sz.width, fh = sz.height;
    // FFmpeg's rawvideo yuv420p is tightly packed with ceil() chroma;
    // (w*h*3)>>1 floored it and rejected every odd-sized frame (C3).
    var bytes = frameByteSize('I420', fw, fh);
    clock = _sourceClock(bytes, 1e6 / fps, Math.max(100000, 2e6 / fps));
    fq = new FrameQueue(bytes, function (frameBuf) {
      if (track.readyState === 'ended') return;
      track._push(new VideoFrame({
        data: frameBuf, format: 'I420',
        codedWidth: fw, codedHeight: fh,
        timestamp: clock.next(),
      }));
    });
  });
  gst.on('data', function (chunk) {
    if (!fq) return;
    clock.onBytes(chunk.length);
    fq.push(chunk);
  });
  gst.on('error', function (e) { if (starter.started) track._ee.emit('error', e); });
  gst.on('close', function () { track._endSource(); });

  gst.startScreen({
    width: w, height: h, fps: fps,
    cursor: vOpts.cursor,
    displaySurface: vOpts.displaySurface,
    windowTitle: vOpts.windowTitle,
    display: vOpts.display,
    device: device,
    ffmpegPath: vOpts.ffmpegPath,
  });
  return starter.promise;
}

function _startAudioCapture(stream, opts) {
  var cs = _canonical(opts, AUDIO_ALIASES);

  var track = new MediaStreamTrack({ kind: 'audio', label: 'microphone', settings: {} });
  // Echo back original constraints for getConstraints()
  track._constraints = _isObj(opts) ? opts : {};

  // Mic capture uses GStreamer (pulsesrc / wasapisrc / osxaudiosrc).
  // The previous FFmpeg-based path with `-f pulse -i default` would
  // exit silently on systems where pulse wasn't the default audio
  // server (containers, WSL, some Linux desktops), producing a track
  // that emits zero AudioData events even though getUserMedia
  // returned successfully. See gstreamer_process.js startAudio().
  var gst = new GStreamerProcess();
  stream.addTrack(track);
  stream._processes.push(gst);

  var starter = _starter(gst, 'audio source', 'data');
  track._onStop = function () { gst.stop(); starter.abort(); };

  gst.on('error', function (e) { if (starter.started) track._ee.emit('error', e); });
  gst.on('close', function () { track._endSource(); });

  return _select('audioinput', cs, AUDIO_PROPS, _audioCaps).then(function (sel) {
    if (starter.done) return starter.promise;
    var dev = sel.device;
    var s = sel.settings;
    var sampleRate = s.sampleRate, channels = s.channelCount;

    var settings = track._settings;
    settings.sampleRate = sampleRate;
    settings.channelCount = channels;
    settings.sampleSize = 16;
    settings.deviceId = dev ? dev.deviceId : _readConstraint(cs, ['deviceId']);
    settings.groupId = dev ? dev.deviceId : undefined;
    // Accepted and echoed, not applied by the pipeline (yet).
    settings.echoCancellation = s.echoCancellation;
    settings.autoGainControl  = s.autoGainControl;
    settings.noiseSuppression = s.noiseSuppression;
    if (dev) {
      track._capabilities = GStreamerProcess.capabilitiesFromModes(dev.modes, 'audioinput');
      // W3C audio booleans the spec advertises for input devices; we
      // accept them as constraints.
      track._capabilities.echoCancellation = [true, false];
      track._capabilities.autoGainControl  = [true, false];
      track._capabilities.noiseSuppression = [true, false];
      track.label = dev.label;
    }

    _wireAudio(track, gst, 'data', sampleRate, channels);
    gst.startAudio({
      sampleRate: sampleRate,
      channels: channels,
      device: settings.deviceId,
      deviceInfo: dev,
    });
    return starter.promise;
  }, function (e) {
    starter.abort(e);
    throw e;
  });
}

/** 10 ms s16 AudioData chunks from a PCM byte stream. */
function _wireAudio(track, proc, dataEvent, sampleRate, channels) {
  var samplesPerChunk = Math.floor(sampleRate / 100);
  var bytesPerChunk = samplesPerChunk * channels * 2;
  var clock = _sourceClock(bytesPerChunk, samplesPerChunk * 1e6 / sampleRate, 100000);
  var fq = new FrameQueue(bytesPerChunk, function (pcmBuf) {
    if (track.readyState === 'ended') return;
    track._push(new AudioData({
      data: pcmBuf,
      format: 's16',
      sampleRate: sampleRate,
      numberOfChannels: channels,
      numberOfFrames: samplesPerChunk,
      timestamp: clock.next(),
    }));
  });
  proc.on(dataEvent, function (chunk) { clock.onBytes(chunk.length); fq.push(chunk); });
}

/**
 * Enumerate available media devices via gst-device-monitor-1.0
 * (W3C MediaDevices.enumerateDevices()).
 *
 * Returns Promise<MediaDeviceInfo[]> — inputs ('videoinput',
 * 'audioinput') as InputDeviceInfo with getCapabilities(), outputs
 * ('audiooutput') as MediaDeviceInfo.
 *
 * The probe is cached briefly (see gstreamer_process _probeDevices). If
 * gst-device-monitor-1.0 is unavailable (binary missing, query timed
 * out, malformed output) this resolves to [] without throwing — the same
 * fail-soft behavior browsers exhibit when permissions block device
 * enumeration.
 */
function enumerateDevices() {
  return GStreamerProcess.probeAllDevices().then(function (probed) {
    var out = [];
    for (var i = 0; i < probed.length; i++) {
      var d = probed[i];
      if (d.kind === 'audiooutput') {
        out.push(new MediaDeviceInfo({
          deviceId: d.deviceId, kind: d.kind, label: d.label, groupId: d.deviceId,
        }));
        continue;
      }
      out.push(new InputDeviceInfo({
        deviceId: d.deviceId,
        kind:     d.kind,
        label:    d.label,
        groupId:  d.deviceId,  // groupId === deviceId per design choice
        capabilities: GStreamerProcess.capabilitiesFromModes(d.modes, d.kind),
      }));
    }
    return out;
  });
}

getUserMedia.enumerateDevices = enumerateDevices;

/**
 * W3C screen-capture: getDisplayMedia() constraints may not use `min`,
 * `exact` or `advanced` (TypeError) — the user picks the surface, the
 * app can only express ideal/max. Returns the offending member or null.
 */
function _forbiddenDisplayConstraint(cs) {
  if (!_isObj(cs)) return null;
  if ('advanced' in cs) return 'advanced';
  for (var k in cs) {
    if (!Object.prototype.hasOwnProperty.call(cs, k)) continue;
    var v = cs[k];
    if (_isObj(v) && (('min' in v) || ('exact' in v))) return k;
  }
  return null;
}

/**
 * getDisplayMedia — Screen capture (browser-compatible API).
 * Equivalent to navigator.mediaDevices.getDisplayMedia(constraints).
 *
 * @param {object} [constraints]
 * @param {object|boolean} [constraints.video] — { width, height, frameRate, displaySurface, windowTitle, display }
 *   width/height: the output size (ideal / max); omitted → the native
 *     size of the captured surface (the other one follows its aspect ratio)
 *   displaySurface: 'monitor' (default) | 'window'
 *   windowTitle: string — required when displaySurface='window' (Linux/Windows)
 * @param {object|boolean} [constraints.audio] — capture system audio
 *   Linux:   PulseAudio monitor (automatic)
 *   Windows: "Stereo Mix" or WASAPI loopback
 *   macOS:   requires virtual audio device (e.g. BlackHole) — pass { device: 'BlackHole 2ch' }
 *   When system audio is not available the stream has no audio track.
 * @returns {Promise<MediaStream>} — resolves once the screen grab delivers
 *   data; rejects TypeError (forbidden constraints), NotReadableError
 *   (FFmpeg failed to start) or AbortError (timeout).
 */
function getDisplayMedia(constraints) {
  if (!constraints) constraints = {};
  var vOpts = constraints.video;
  if (vOpts === true || vOpts === undefined) vOpts = {};
  if (vOpts === false) {
    return Promise.reject(new TypeError(
      'getDisplayMedia: video must not be set to false'
    ));
  }
  var bad = _forbiddenDisplayConstraint(vOpts) ||
            _forbiddenDisplayConstraint(constraints.audio);
  if (bad) {
    return Promise.reject(new TypeError(
      'getDisplayMedia: constraint "' + bad + '" is not allowed ' +
      '(no min, exact or advanced — the user chooses the surface)'
    ));
  }

  var stream = new MediaStream();
  var pending = [_startScreenCapture(stream, vOpts)];

  // System audio capture. Optional: when it cannot start, the stream
  // simply has no audio track (as in browsers without system audio).
  if (constraints.audio) {
    var aOpts = _isObj(constraints.audio) ? constraints.audio : {};
    pending.push(_startSystemAudioCapture(stream, aOpts));
  }

  return _settleAll(stream, pending);
}

/** Drop an audio track that could not start: removed from the stream, ended. */
function _dropTrack(stream, track, err) {
  stream.removeTrack(track);
  if (err) track._ee.emit('error', err);
  // Ends with 'ended' (the source is gone) — it used to stay 'live' forever
  // on macOS without a virtual device, emitting nothing (C15a).
  track._endSource();
}

/**
 * System audio capture — captures desktop/system audio output.
 *
 * Platform-specific:
 *   Linux:   PulseAudio monitor source (captures all audio output)
 *   Windows: dshow "Stereo Mix" or virtual audio cable
 *   macOS:   requires virtual audio device (BlackHole, Soundflower, etc.)
 *
 * Resolves always (never rejects): with the track live and delivering
 * data, or with the track removed from the stream and ended.
 *
 * @param {MediaStream} stream
 * @param {object} opts — { sampleRate, channelCount, device }
 */
function _startSystemAudioCapture(stream, opts) {
  var cs = _canonical(opts, AUDIO_ALIASES);
  var sampleRate = Number(_readConstraint(cs, ['sampleRate'], { integer: true, preferred: 48000 }));
  var channels   = Number(_readConstraint(cs, ['channelCount'], { integer: true, preferred: 2 }));
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) sampleRate = 48000;
  if (!Number.isFinite(channels) || channels <= 0)     channels = 2;
  var ffmpegPath = opts.ffmpegPath || 'ffmpeg';
  var deviceOpt = _readConstraint(cs, ['deviceId']) || null;

  var plat = platform();

  var track = new MediaStreamTrack({
    kind: 'audio', label: 'system-audio',
    settings: { sampleRate: sampleRate, channelCount: channels },
  });
  track._constraints = _isObj(opts) ? opts : {};

  var ffmpeg = new FFmpegProcess();
  stream.addTrack(track);
  stream._processes.push(ffmpeg);

  var args = ['-loglevel', 'error'];

  if (plat === 'linux') {
    // PulseAudio monitor — captures system audio output
    // '<default sink>.monitor' captures the default output sink
    var monitor = deviceOpt;
    if (!monitor) {
      // Auto-detect the default monitor source (argv, no shell).
      try {
        var r = spawnSync('pactl', ['get-default-sink'], { timeout: 3000, encoding: 'utf8' });
        var sinkName = r && r.status === 0 ? String(r.stdout || '').trim() : '';
        if (sinkName) monitor = sinkName + '.monitor';
      } catch (e) {}
      if (!monitor) monitor = 'default.monitor';
    }
    args.push('-f', 'pulse', '-i', monitor);
  } else if (plat === 'win32') {
    // Windows: dshow Stereo Mix or virtual audio cable
    var device = deviceOpt;
    if (!device) {
      // Auto-detect: look for Stereo Mix or loopback device
      device = _findWindowsAudioDevice(ffmpegPath);
      if (!device) {
        console.warn('[media-processing] System audio not available — recording video only.');
        _dropTrack(stream, track, new Error(
          'getDisplayMedia: system audio not available on this system.\n' +
          'Enable "Stereo Mix" in Sound Settings → Recording → Show Disabled Devices,\n' +
          'or install a virtual audio cable (e.g. VB-Cable).'
        ));
        return Promise.resolve();
      }
    }
    args.push('-f', 'dshow', '-i', 'audio=' + device);
  } else if (plat === 'darwin') {
    // macOS: requires virtual audio device (BlackHole, Soundflower, etc.)
    // User must install and configure audio routing themselves
    var macDevice = deviceOpt;
    if (!macDevice) {
      macDevice = _findMacLoopbackDevice(ffmpegPath);
      if (!macDevice) {
        console.warn('[media-processing] System audio not available — recording video only.');
        _dropTrack(stream, track, new Error(
          'getDisplayMedia: system audio on macOS requires a virtual audio device.\n' +
          'Install BlackHole (https://github.com/ExistentialAudio/BlackHole) and set it as\n' +
          'the system output, or pass { audio: { device: "YourDevice" } }.'
        ));
        return Promise.resolve();
      }
    }
    args.push('-f', 'avfoundation', '-i', ':' + macDevice);
  }

  args.push('-f', 's16le', '-ar', String(sampleRate), '-ac', String(channels), 'pipe:1');

  var starter = _starter(ffmpeg, 'system audio', 'stdout');
  track._onStop = function () { ffmpeg.stop(); starter.abort(); };

  _wireAudio(track, ffmpeg, 'stdout', sampleRate, channels);
  ffmpeg.on('error', function (e) { if (starter.started) track._ee.emit('error', e); });
  ffmpeg.on('close', function () { track._endSource(); });

  ffmpeg.start(args, ['ignore', 'pipe', 'pipe']);

  return starter.promise.then(null, function (e) {
    if (track.readyState === 'ended' && e && e.name === 'AbortError') return;   // stopped by the app
    console.warn('[media-processing] System audio failed to start — recording video only. ' + e.message);
    ffmpeg.stop();
    _dropTrack(stream, track, e);
  });
}

/**
 * Device names from `ffmpeg -list_devices true -f <fmt> -i <dummy>`
 * (printed on stderr, exit code 1 — that is normal), for one media type.
 * Handles both listing styles: '"Name" (audio)' (FFmpeg ≥ 4.4) and the
 * older "DirectShow audio devices" section header followed by '"Name"'.
 * 'Alternative name "@device_..."' lines are skipped.
 */
function _listFFmpegDevices(ffmpegPath, fmt, dummy, mediaType) {
  var out = '';
  try {
    var r = spawnSync(ffmpegPath || 'ffmpeg',
      ['-hide_banner', '-f', fmt, '-list_devices', 'true', '-i', dummy],
      { timeout: 5000, encoding: 'utf8' });
    out = String(r.stderr || '') + String(r.stdout || '');
  } catch (e) {}
  var names = [];
  var section = null;
  var lines = out.split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (/Alternative name/i.test(line)) continue;
    var hdr = line.match(/(DirectShow|AVFoundation)\s+(video|audio)\s+devices/i);
    if (hdr) { section = hdr[2].toLowerCase(); continue; }
    var tagged = line.match(/"([^"]+)"\s*\((video|audio|none)\)/);
    if (tagged) {
      if (tagged[2] === mediaType) names.push(tagged[1]);
      continue;
    }
    var quoted = line.match(/\]\s*"([^"]+)"\s*$/);
    if (quoted && section === mediaType) { names.push(quoted[1]); continue; }
    // avfoundation: "[AVFoundation indev @ 0x..] [1] BlackHole 2ch"
    var indexed = line.match(/\]\s*\[(\d+)\]\s*(.+?)\s*$/);
    if (indexed && section === mediaType) names.push(indexed[2]);
  }
  return names;
}

/**
 * Find a usable system audio loopback device on Windows.
 * Returns the FULL device name from the dshow listing, or null.
 *
 * It returned the candidate substring it found ('Stereo Mix'), but
 * FFmpeg's dshow input matches the friendly name EXACTLY — the real
 * device is 'Stereo Mix (Realtek(R) Audio)', so `-i audio=Stereo Mix`
 * failed with "Could not find audio only device" (C15b). The listing
 * also ran through a shell (execSync).
 */
function _findWindowsAudioDevice(ffmpegPath) {
  var candidates = ['Stereo Mix', 'CABLE Output', 'VB-Cable', 'Loopback', 'What U Hear'];
  var names = _listFFmpegDevices(ffmpegPath, 'dshow', 'dummy', 'audio');
  for (var i = 0; i < candidates.length; i++) {
    for (var j = 0; j < names.length; j++) {
      if (names[j].indexOf(candidates[i]) >= 0) return names[j];
    }
  }
  return null;
}

/** A virtual loopback audio device on macOS (BlackHole, ...), or null. One listing. */
function _findMacLoopbackDevice(ffmpegPath) {
  var candidates = ['BlackHole 2ch', 'BlackHole 16ch', 'Soundflower (2ch)', 'Loopback Audio'];
  var names = _listFFmpegDevices(ffmpegPath, 'avfoundation', '', 'audio');
  for (var i = 0; i < candidates.length; i++) {
    for (var j = 0; j < names.length; j++) {
      if (names[j].indexOf(candidates[i]) >= 0) return names[j];
    }
  }
  return null;
}

export default getUserMedia;
export { enumerateDevices, getDisplayMedia, MediaDeviceInfo, InputDeviceInfo };
