/**
 * getUserMedia — Camera, microphone, and screen capture.
 *
 * Improvements:
 *  - track.stop() kills the associated GStreamer/FFmpeg process
 *  - enumerateDevices() lists available cameras/mics
 *  - Shared _startCapture to avoid duplication between video/screen
 *  - W3C MediaCapture compatibility: accepts ConstrainULong/Double
 *    constraint objects ({ exact, ideal, min, max }), the spec-name
 *    aliases (frameRate, deviceId), and stores original constraints
 *    on the track for getConstraints().
 */

import GStreamerProcess from './gstreamer_process.js';
import FFmpegProcess from './ffmpeg_process.js';
import FrameQueue from './core/frame_queue.js';
import { MediaStream, MediaStreamTrack, MediaDeviceInfo, InputDeviceInfo } from './media_stream.js';
import VideoFrame from './video_frame.js';
import AudioData from './audio_data.js';
import { execSync } from 'node:child_process';
import { platform } from 'node:os';

/**
 * Resolve a W3C ConstrainULong / ConstrainDouble / ConstrainBoolean
 * /ConstrainDOMString value to a single concrete value.
 *
 * Spec (https://www.w3.org/TR/mediacapture-streams/#dom-constrainulong):
 *   ConstrainULong = unsigned long
 *                  | { exact?, ideal?, min?, max? }
 *
 * Browser code commonly writes
 *   { width: { ideal: 1280 }, height: { ideal: 720 } }
 *   { facingMode: { exact: 'user' } }
 * and expects it to "just work". The naive `vOpts.width || default`
 * pattern grabs the OBJECT, not the number, and downstream
 * arithmetic returns NaN.
 *
 * Resolution priority: exact > ideal > avg(min, max) > min > max.
 * If none of those keys exist, return undefined (caller falls back
 * to its own default).
 */
function _resolveConstraint(value) {
  if (value == null) return undefined;
  // Plain primitives — the most common case
  if (typeof value !== 'object') return value;
  // ConstrainXxx object form
  if ('exact' in value) return value.exact;
  if ('ideal' in value) return value.ideal;
  if ('min' in value && 'max' in value) {
    // Pick the midpoint when both bounds are given but no preference
    return (value.min + value.max) / 2;
  }
  if ('min' in value) return value.min;
  if ('max' in value) return value.max;
  return undefined;
}

/**
 * Read a video constraint from a constraints object, accepting
 * either the W3C name (preferred) or a library-specific alias.
 *
 * Examples:
 *   _readConstraint(opts, ['frameRate', 'fps', 'framerate'])
 *   _readConstraint(opts, ['deviceId', 'device'])
 *
 * The first name in the list is the W3C-canonical one; subsequent
 * names are accepted for back-compat. Browser code uses the first;
 * existing library users may have used a later one.
 */
function _readConstraint(opts, names) {
  if (!opts) return undefined;
  for (var i = 0; i < names.length; i++) {
    if (names[i] in opts) {
      var resolved = _resolveConstraint(opts[names[i]]);
      if (resolved !== undefined) return resolved;
    }
  }
  return undefined;
}

/**
 * @param {object} constraints — W3C MediaStreamConstraints
 *   { video: boolean | MediaTrackConstraints,
 *     audio: boolean | MediaTrackConstraints,
 *     screen: ... (library extension, not W3C — use getDisplayMedia) }
 * @param {function} [cb] — node-style callback(err, mediaStream); also
 *   returns a Promise.
 *
 * Browser-compatible: returns a Promise that resolves AFTER the device
 * probe has populated the track's capabilities, mirroring the browser
 * contract where getCapabilities() works immediately on the resolved
 * stream's tracks.
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

  // Resolve once every capture's setup (probe + track capability
  // population) has completed. The actual media data may still take a
  // few frames to start flowing, but track.getCapabilities() and
  // track.getSettings() are guaranteed to be ready — matching browser
  // semantics where getUserMedia resolves with a "ready to query" stream.
  var promise = Promise.all(pending).then(function () { return stream; });

  if (cb) {
    promise.then(function (s) { cb(null, s); }, function (e) { cb(e); });
    return stream;
  }
  return promise;
}

function _startCapture(stream, opts, mode) {
  // opts may be `true` ("any video"), false/undefined (caller already
  // filtered this out before calling us), or a MediaTrackConstraints
  // object. Treat boolean true as empty constraints.
  var vOpts = (opts && typeof opts === 'object') ? opts : {};

  // Resolve W3C constraint forms ({ exact, ideal, min, max }) and
  // accept the spec-canonical names (frameRate, deviceId) alongside
  // the library's older aliases (fps, framerate, device). _resolveConstraint
  // returns undefined when no value was supplied, so we can fall back
  // to defaults cleanly.
  var w   = _readConstraint(vOpts, ['width']) || 1280;
  var h   = _readConstraint(vOpts, ['height']) || 720;
  var fps = _readConstraint(vOpts, ['frameRate', 'fps', 'framerate']) || 30;
  var device = _readConstraint(vOpts, ['deviceId', 'device']);

  // Other W3C constraints we accept for compatibility but don't
  // currently honor in the FFmpeg/GStreamer pipeline. Storing them
  // on the track means getConstraints() echoes them back, which is
  // what the spec requires and what browser code expects.
  var facingMode  = _readConstraint(vOpts, ['facingMode']);
  var aspectRatio = _readConstraint(vOpts, ['aspectRatio']);
  var resizeMode  = _readConstraint(vOpts, ['resizeMode']);
  var groupId     = _readConstraint(vOpts, ['groupId']);

  // Coerce numeric values — { ideal: '1280' } from a string-typed
  // signaling channel shouldn't end up as 'NaN' downstream.
  w   = Number(w);
  h   = Number(h);
  fps = Number(fps);
  if (!Number.isFinite(w) || w <= 0)   w = 1280;
  if (!Number.isFinite(h) || h <= 0)   h = 720;
  if (!Number.isFinite(fps) || fps <= 0) fps = 30;

  var bytesPerFrame = ((w * h * 3) >> 1);

  var track = new MediaStreamTrack({
    kind: 'video', label: mode,
    settings: {
      width: w, height: h, frameRate: fps,
      // Echo back W3C settings the caller supplied, even if we don't
      // act on them — getSettings() must mirror what was negotiated.
      deviceId:    device,
      facingMode:  facingMode,
      aspectRatio: aspectRatio,
      resizeMode:  resizeMode,
      groupId:     groupId,
      displaySurface: (mode === 'screen') ? (vOpts.displaySurface || 'monitor') : undefined,
    },
  });

  // Store the original (un-normalized) constraints on the track so
  // getConstraints() returns what the caller passed in, per spec
  // §5.2 step "set [[constraints]] internal slot".
  track._constraints = (opts && typeof opts === 'object') ? opts : {};

  var gst = new GStreamerProcess();
  stream.addTrack(track);
  stream._processes.push(gst);

  // track.stop() kills the capture process
  track._onStop = function () { gst.stop(); };

  var frameIdx = 0;
  var fq = new FrameQueue(bytesPerFrame, function (frameBuf) {
    if (track.readyState === 'ended') return;
    var vf = new VideoFrame({
      data: frameBuf,
      format: 'I420',
      codedWidth: w,
      codedHeight: h,
      timestamp: Math.round((frameIdx * 1e6) / fps),
    });
    frameIdx++;
    track._push(vf);
  });

  gst.on('data', function (chunk) { fq.push(chunk); });
  gst.on('error', function (e) { track._ee.emit('error', e); });
  gst.on('close', function () { track.stop(); });

  if (mode === 'screen') {
    gst.startScreen({
      width: w, height: h, fps: fps,
      cursor: vOpts.cursor,
      displaySurface: vOpts.displaySurface,
      windowTitle: vOpts.windowTitle,
      display: vOpts.display,
      device: device,
      ffmpegPath: vOpts.ffmpegPath,
    });
    // Screen capture has no probe — settings already set, capabilities
    // intentionally empty (browser getDisplayMedia behaves similarly).
    return Promise.resolve();
  }

  // Camera path: probe the device list to populate track capabilities
  // before returning. The probe is also called inside gst.startCamera()
  // for source-mode pinning, but the result is cached so this is a
  // single subprocess invocation total.
  gst.startCamera({ width: w, height: h, fps: fps, device: device });

  return GStreamerProcess.probeAllDevices().then(function (devices) {
    var match = _findCameraDevice(devices, device);
    if (match) {
      track._capabilities = GStreamerProcess.capabilitiesFromModes(match.modes, 'videoinput');
      // Fill in the actual deviceId/label from the probe — the user
      // may have passed undefined or a partial hint, but getSettings()
      // should reflect what we actually opened.
      track._settings.deviceId = match.deviceId;
      track._settings.groupId  = match.deviceId;  // groupId === deviceId per design
      track.label = match.label;
    }
    // If probe returned nothing or no camera matched, _capabilities
    // stays undefined and getCapabilities() returns {} — graceful
    // degradation without breaking the caller.
  });
}

/** Find a camera device by deviceId or label substring; falls back to first. */
function _findCameraDevice(devices, hint) {
  for (var i = 0; i < devices.length; i++) {
    if (devices[i].kind !== 'videoinput') continue;
    if (!hint) return devices[i];
    if (devices[i].deviceId === hint) return devices[i];
    if (devices[i].label.indexOf(hint) >= 0) return devices[i];
  }
  for (var j = 0; j < devices.length; j++) {
    if (devices[j].kind === 'videoinput') return devices[j];
  }
  return null;
}

function _startAudioCapture(stream, opts) {
  var aOpts = (opts && typeof opts === 'object') ? opts : {};

  // W3C-aware constraint reads. ConstrainULong objects are resolved
  // here too so { sampleRate: { ideal: 48000 } } works.
  var sampleRate = _readConstraint(aOpts, ['sampleRate']);
  var channels   = _readConstraint(aOpts, ['channelCount', 'numberOfChannels']);
  var device     = _readConstraint(aOpts, ['deviceId', 'device']);

  // Per-spec audio booleans we accept and store for getConstraints
  // round-trip, even if the GStreamer pipeline doesn't apply them
  // yet. A future MP-* item can plumb these through to webrtcdsp.
  var echoCancellation = _readConstraint(aOpts, ['echoCancellation']);
  var autoGainControl  = _readConstraint(aOpts, ['autoGainControl']);
  var noiseSuppression = _readConstraint(aOpts, ['noiseSuppression']);

  sampleRate = Number(sampleRate);
  channels   = Number(channels);
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) sampleRate = 48000;
  if (!Number.isFinite(channels) || channels <= 0)     channels = 2;

  var track = new MediaStreamTrack({
    kind: 'audio', label: 'microphone',
    settings: {
      sampleRate: sampleRate,
      channelCount: channels,
      deviceId: device,
      echoCancellation: echoCancellation,
      autoGainControl:  autoGainControl,
      noiseSuppression: noiseSuppression,
    },
  });
  // Echo back original constraints for getConstraints()
  track._constraints = (opts && typeof opts === 'object') ? opts : {};

  // Mic capture uses GStreamer (pulsesrc / wasapisrc / osxaudiosrc).
  // The previous FFmpeg-based path with `-f pulse -i default` would
  // exit silently on systems where pulse wasn't the default audio
  // server (containers, WSL, some Linux desktops), producing a track
  // that emits zero AudioData events even though getUserMedia
  // returned successfully. GStreamer's pulsesrc auto-resolves a
  // sane source and surfaces failures via stderr. See gstreamer_process.js
  // startAudio() for the per-platform pipeline.
  var gst = new GStreamerProcess();
  stream.addTrack(track);
  stream._processes.push(gst);

  track._onStop = function () { gst.stop(); };

  // 10ms chunks of PCM. Frame queue is pre-sized so the sample-count
  // arithmetic below stays exact for the entire session.
  var samplesPerChunk = Math.floor(sampleRate / 100);
  var bytesPerChunk = samplesPerChunk * channels * 2;
  var chunkIdx = 0;

  var fq = new FrameQueue(bytesPerChunk, function (pcmBuf) {
    if (track.readyState === 'ended') return;
    var ad = new AudioData({
      data: pcmBuf,
      format: 's16',
      sampleRate: sampleRate,
      numberOfChannels: channels,
      numberOfFrames: samplesPerChunk,
      timestamp: Math.round(chunkIdx * samplesPerChunk * 1e6 / sampleRate),
    });
    chunkIdx++;
    track._push(ad);
  });

  gst.on('data', function (chunk) { fq.push(chunk); });
  gst.on('error', function (e) { track._ee.emit('error', e); });
  gst.on('close', function () { track.stop(); });

  gst.startAudio({
    sampleRate: sampleRate,
    channels: channels,
    device: device,
  });

  // Probe the device list to populate track capabilities. The probe
  // is cached, so this is free if a video capture also ran the probe.
  return GStreamerProcess.probeAllDevices().then(function (devices) {
    var match = _findAudioDevice(devices, device);
    if (match) {
      track._capabilities = GStreamerProcess.capabilitiesFromModes(match.modes, 'audioinput');
      // Augment capabilities with W3C audio booleans the spec
      // advertises for input devices, even though we don't apply
      // these in the pipeline yet. echoCancellation/autoGainControl/
      // noiseSuppression each map to "we'd accept it as a constraint"
      // — exposing the boolean array follows browser conventions.
      track._capabilities.echoCancellation = [true, false];
      track._capabilities.autoGainControl  = [true, false];
      track._capabilities.noiseSuppression = [true, false];

      track._settings.deviceId = match.deviceId;
      track._settings.groupId  = match.deviceId;
      track.label = match.label;
    }
  });
}

/** Find an audio device by deviceId or label substring; falls back to first. */
function _findAudioDevice(devices, hint) {
  for (var i = 0; i < devices.length; i++) {
    if (devices[i].kind !== 'audioinput') continue;
    if (!hint) return devices[i];
    if (devices[i].deviceId === hint) return devices[i];
    if (devices[i].label.indexOf(hint) >= 0) return devices[i];
  }
  for (var j = 0; j < devices.length; j++) {
    if (devices[j].kind === 'audioinput') return devices[j];
  }
  return null;
}

/**
 * Enumerate available media devices via gst-device-monitor-1.0
 * (W3C MediaDevices.enumerateDevices()).
 *
 * Returns Promise<InputDeviceInfo[]> — async to match the browser API
 * exactly. Each returned object has { deviceId, kind, label, groupId }
 * plus a getCapabilities() method that returns W3C MediaTrackCapabilities
 * derived from the device's native modes.
 *
 * The probe is cached for the process lifetime, so repeated calls are
 * effectively free after the first one. If gst-device-monitor-1.0 is
 * unavailable (binary missing, query timed out, malformed output) this
 * resolves to [] without throwing — the same fail-soft behavior browsers
 * exhibit when permissions block device enumeration.
 *
 * Note: this replaces an earlier synchronous, platform-specific
 * implementation that scraped FFmpeg dshow / v4l2-ctl / system_profiler
 * output. The change to async aligns with the W3C contract; callers
 * must `await` (or .then()) the result.
 */
function enumerateDevices() {
  return GStreamerProcess.probeAllDevices().then(function (probed) {
    var out = [];
    for (var i = 0; i < probed.length; i++) {
      var d = probed[i];
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
 * getDisplayMedia — Screen capture (browser-compatible API).
 * Equivalent to navigator.mediaDevices.getDisplayMedia(constraints).
 *
 * @param {object} [constraints]
 * @param {object|boolean} [constraints.video] — { width, height, fps, displaySurface, windowTitle, display }
 *   displaySurface: 'monitor' (default) | 'window'
 *   windowTitle: string — required when displaySurface='window' (Linux/Windows)
 * @param {object|boolean} [constraints.audio] — capture system audio
 *   Linux:   PulseAudio monitor (automatic)
 *   Windows: "Stereo Mix" or WASAPI loopback
 *   macOS:   requires virtual audio device (e.g. BlackHole) — pass { device: 'BlackHole 2ch' }
 * @returns {Promise<MediaStream>}
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

  var stream = new MediaStream();

  // Pass displaySurface and windowTitle through to GStreamer/FFmpeg.
  // _startCapture handles ConstrainULong normalization for width /
  // height / frameRate, so browser-style constraints work here too.
  _startCapture(stream, vOpts, 'screen');

  // System audio capture
  if (constraints.audio) {
    var aOpts = (typeof constraints.audio === 'object') ? constraints.audio : {};
    _startSystemAudioCapture(stream, aOpts);
  }

  return Promise.resolve(stream);
}

/**
 * System audio capture — captures desktop/system audio output.
 *
 * Platform-specific:
 *   Linux:   PulseAudio monitor source (captures all audio output)
 *   Windows: dshow "Stereo Mix" or virtual audio cable
 *   macOS:   requires virtual audio device (BlackHole, Soundflower, etc.)
 *
 * @param {MediaStream} stream
 * @param {object} opts — { sampleRate, channelCount, device }
 */
function _startSystemAudioCapture(stream, opts) {
  // Same W3C-aware constraint reads as _startAudioCapture; system
  // audio shares the audio-track shape.
  var sampleRate = _readConstraint(opts, ['sampleRate']);
  var channels   = _readConstraint(opts, ['channelCount', 'numberOfChannels']);
  sampleRate = Number(sampleRate);
  channels   = Number(channels);
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) sampleRate = 48000;
  if (!Number.isFinite(channels) || channels <= 0)     channels = 2;

  var plat = platform();

  var track = new MediaStreamTrack({
    kind: 'audio', label: 'system-audio',
    settings: { sampleRate: sampleRate, channelCount: channels },
  });
  track._constraints = (opts && typeof opts === 'object') ? opts : {};

  var ffmpeg = new FFmpegProcess();
  stream.addTrack(track);
  stream._processes.push(ffmpeg);

  track._onStop = function () { ffmpeg.stop(); };

  var args = ['-loglevel', 'error'];

  if (plat === 'linux') {
    // PulseAudio monitor — captures system audio output
    // 'default.monitor' captures the default output sink
    var monitor = opts.device || null;
    if (!monitor) {
      // Auto-detect the default monitor source
      try {
        var sinkName = execSync(
          'pactl get-default-sink 2>/dev/null',
          { timeout: 3000, encoding: 'utf8' }
        ).trim();
        if (sinkName) monitor = sinkName + '.monitor';
      } catch (e) {}
      if (!monitor) monitor = 'default.monitor';
    }
    args.push('-f', 'pulse', '-i', monitor);
  } else if (plat === 'win32') {
    // Windows: dshow Stereo Mix or virtual audio cable
    var device = opts.device || null;
    if (!device) {
      // Auto-detect: look for Stereo Mix or loopback device
      var available = _findWindowsAudioDevice();
      if (!available) {
        // No system audio device found — remove track and warn
        stream.removeTrack(track);
        track._ee.emit('error', new Error(
          'getDisplayMedia: system audio not available on this system.\n' +
          'Enable "Stereo Mix" in Sound Settings → Recording → Show Disabled Devices,\n' +
          'or install a virtual audio cable (e.g. VB-Cable).'
        ));
        console.warn('[media-processing] System audio not available — recording video only.');
        return;
      }
      device = available;
    }
    args.push('-f', 'dshow', '-i', 'audio=' + device);
  } else if (plat === 'darwin') {
    // macOS: requires virtual audio device (BlackHole, Soundflower, etc.)
    // User must install and configure audio routing themselves
    var device = opts.device || null;
    if (!device) {
      // Try common virtual audio device names
      var candidates = ['BlackHole 2ch', 'BlackHole 16ch', 'Soundflower (2ch)', 'Loopback Audio'];
      for (var c = 0; c < candidates.length; c++) {
        try {
          var check = execSync(
            'ffmpeg -f avfoundation -list_devices true -i "" 2>&1',
            { timeout: 3000, encoding: 'utf8' }
          );
          if (check.indexOf(candidates[c]) >= 0) {
            device = candidates[c];
            break;
          }
        } catch (e) {
          var stderr = e.stdout || e.stderr || (e.output ? e.output.join('') : '');
          if (stderr.indexOf(candidates[c]) >= 0) {
            device = candidates[c];
            break;
          }
        }
      }
      if (!device) {
        track._ee.emit('error', new Error(
          'getDisplayMedia: system audio on macOS requires a virtual audio device.\n' +
          'Install BlackHole (https://github.com/ExistentialAudio/BlackHole) and set it as\n' +
          'the system output, or pass { audio: { device: "YourDevice" } }.'
        ));
        return;
      }
    }
    args.push('-f', 'avfoundation', '-i', ':' + device);
  }

  args.push('-f', 's16le', '-ar', String(sampleRate), '-ac', String(channels), 'pipe:1');

  // 10ms chunks of PCM
  var samplesPerChunk = Math.floor(sampleRate / 100);
  var bytesPerChunk = samplesPerChunk * channels * 2;
  var chunkIdx = 0;

  var fq = new FrameQueue(bytesPerChunk, function (pcmBuf) {
    if (track.readyState === 'ended') return;
    var ad = new AudioData({
      data: pcmBuf,
      format: 's16',
      sampleRate: sampleRate,
      numberOfChannels: channels,
      numberOfFrames: samplesPerChunk,
      timestamp: Math.round(chunkIdx * samplesPerChunk * 1e6 / sampleRate),
    });
    chunkIdx++;
    track._push(ad);
  });

  ffmpeg.on('stdout', function (chunk) { fq.push(chunk); });
  ffmpeg.on('error', function (e) { track._ee.emit('error', e); });
  ffmpeg.on('close', function () { track.stop(); });

  ffmpeg.start(args, ['ignore', 'pipe', 'pipe']);
}

/**
 * Find a usable system audio loopback device on Windows.
 * Checks dshow device list for Stereo Mix, virtual cables, etc.
 * @returns {string|null} device name or null
 */
function _findWindowsAudioDevice() {
  var candidates = ['Stereo Mix', 'CABLE Output', 'VB-Cable', 'Loopback', 'What U Hear'];
  var out = '';
  try {
    execSync('ffmpeg -list_devices true -f dshow -i dummy 2>&1', { timeout: 5000, encoding: 'utf8' });
  } catch (e) {
    out = e.stdout || e.stderr || (e.output ? e.output.join('') : '');
  }
  for (var i = 0; i < candidates.length; i++) {
    if (out.indexOf(candidates[i]) >= 0) return candidates[i];
  }
  return null;
}

export default getUserMedia;
export { enumerateDevices, getDisplayMedia, MediaDeviceInfo, InputDeviceInfo };
