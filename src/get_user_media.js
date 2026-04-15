/**
 * getUserMedia — Camera, microphone, and screen capture.
 *
 * Improvements:
 *  - track.stop() kills the associated GStreamer/FFmpeg process
 *  - enumerateDevices() lists available cameras/mics
 *  - Shared _startCapture to avoid duplication between video/screen
 */

import GStreamerProcess from './gstreamer_process.js';
import FFmpegProcess from './ffmpeg_process.js';
import FrameQueue from './frame_queue.js';
import { MediaStream, MediaStreamTrack } from './media_stream.js';
import VideoFrame from './video_frame.js';
import AudioData from './audio_data.js';
import { execSync } from 'node:child_process';
import { platform } from 'node:os';

/**
 * @param {object} constraints — { video, audio, screen }
 * @param {function} cb — function(err, mediaStream)
 */
function getUserMedia(constraints, cb) {
  if (!constraints) {
    var err = new Error('getUserMedia: constraints required');
    if (cb) { cb(err); return; }
    return Promise.reject(err);
  }

  var stream = new MediaStream();

  if (constraints.video) {
    _startCapture(stream, constraints.video, 'camera');
  }

  if (constraints.screen) {
    _startCapture(stream, constraints.screen, 'screen');
  }

  if (constraints.audio) {
    _startAudioCapture(stream, constraints.audio);
  }

  if (cb) { setTimeout(function () { cb(null, stream); }, 0); return stream; }
  return Promise.resolve(stream);
}

function _startCapture(stream, opts, mode) {
  var vOpts = (typeof opts === 'object') ? opts : {};
  var w = vOpts.width || 1280;
  var h = vOpts.height || 720;
  var fps = vOpts.fps || vOpts.framerate || 30;
  var bytesPerFrame = ((w * h * 3) >> 1);

  var track = new MediaStreamTrack({
    kind: 'video', label: mode,
    settings: {
      width: w, height: h, frameRate: fps,
      displaySurface: (mode === 'screen') ? (vOpts.displaySurface || 'monitor') : undefined,
    },
  });
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
      device: vOpts.device,
      ffmpegPath: vOpts.ffmpegPath,
    });
  } else {
    gst.startCamera({ width: w, height: h, fps: fps, device: vOpts.device });
  }
}

function _startAudioCapture(stream, opts) {
  var aOpts = (typeof opts === 'object') ? opts : {};
  var sampleRate = aOpts.sampleRate || 48000;
  var channels = aOpts.channelCount || aOpts.numberOfChannels || 2;
  var device = aOpts.device || null;
  var plat = platform();

  var track = new MediaStreamTrack({
    kind: 'audio', label: 'microphone',
    settings: { sampleRate: sampleRate, channelCount: channels },
  });
  var ffmpeg = new FFmpegProcess();
  stream.addTrack(track);
  stream._processes.push(ffmpeg);

  track._onStop = function () { ffmpeg.stop(); };

  // Build FFmpeg args for mic capture
  var args = ['-loglevel', 'error'];

  if (plat === 'win32') {
    args.push('-f', 'dshow', '-i', 'audio=' + (device || 'Microphone'));
  } else if (plat === 'darwin') {
    args.push('-f', 'avfoundation', '-i', ':' + (device || '0'));
  } else {
    args.push('-f', 'pulse', '-i', device || 'default');
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
 * Enumerate available media devices (cameras, microphones).
 * Returns an array of { deviceId, kind, label }.
 *
 * Platform-specific: uses FFmpeg/GStreamer to discover devices.
 */
function enumerateDevices() {
  var devices = [];
  var plat = platform();

  try {
    if (plat === 'win32') {
      // FFmpeg dshow device listing
      var out = '';
      try {
        execSync('ffmpeg -list_devices true -f dshow -i dummy 2>&1', { timeout: 5000, encoding: 'utf8' });
      } catch (e) {
        out = e.stdout || e.stderr || (e.output ? e.output.join('') : '');
      }
      var lines = out.split('\n');
      var currentKind = null;
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line.indexOf('DirectShow video') >= 0) currentKind = 'videoinput';
        else if (line.indexOf('DirectShow audio') >= 0) currentKind = 'audioinput';
        else if (currentKind) {
          var match = line.match(/"([^"]+)"/);
          if (match && line.indexOf('Alternative name') < 0) {
            devices.push({ deviceId: match[1], kind: currentKind, label: match[1] });
          }
        }
      }
    } else if (plat === 'linux') {
      // v4l2 devices
      try {
        var v4l2 = execSync('v4l2-ctl --list-devices 2>/dev/null', { timeout: 5000, encoding: 'utf8' });
        var v4lLines = v4l2.split('\n');
        for (var j = 0; j < v4lLines.length; j++) {
          var dev = v4lLines[j].trim();
          if (dev.indexOf('/dev/video') === 0) {
            devices.push({ deviceId: dev, kind: 'videoinput', label: dev });
          }
        }
      } catch (e) {}
      // PulseAudio sources
      try {
        var pa = execSync('pactl list short sources 2>/dev/null', { timeout: 5000, encoding: 'utf8' });
        var paLines = pa.split('\n');
        for (var k = 0; k < paLines.length; k++) {
          var parts = paLines[k].split('\t');
          if (parts.length >= 2) {
            devices.push({ deviceId: parts[1], kind: 'audioinput', label: parts[1] });
          }
        }
      } catch (e) {}
    } else if (plat === 'darwin') {
      // macOS: cameras via system_profiler
      try {
        var camOut = execSync('system_profiler SPCameraDataType 2>/dev/null', { timeout: 5000, encoding: 'utf8' });
        var camLines = camOut.split('\n');
        for (var m = 0; m < camLines.length; m++) {
          var camLine = camLines[m].trim();
          if (camLine && camLine.indexOf(':') === -1 && camLine.indexOf('Camera') === -1 && camLine.length > 0) {
            // Lines without ':' are device names
          } else if (camLine.indexOf(':') > 0 && camLine.indexOf('Model') < 0 && camLine.indexOf('Unique') < 0) {
            continue;
          }
          // Match device name lines (indented, no colon usually, or "Name: ...")
          var camMatch = camLine.match(/^\s*(.+?):\s*$/);
          if (camMatch && camLine.indexOf('Camera') >= 0) {
            devices.push({ deviceId: camMatch[1], kind: 'videoinput', label: camMatch[1] });
          }
        }
      } catch (e) {}
      // macOS: audio devices via FFmpeg avfoundation
      try {
        var avfOut = '';
        try {
          execSync('ffmpeg -f avfoundation -list_devices true -i "" 2>&1', { timeout: 5000, encoding: 'utf8' });
        } catch (e2) {
          avfOut = e2.stdout || e2.stderr || (e2.output ? e2.output.join('') : '');
        }
        var avfLines = avfOut.split('\n');
        var avfKind = null;
        for (var n = 0; n < avfLines.length; n++) {
          var avfLine = avfLines[n];
          if (avfLine.indexOf('video devices') >= 0) avfKind = 'videoinput';
          else if (avfLine.indexOf('audio devices') >= 0) avfKind = 'audioinput';
          else if (avfKind) {
            var avfMatch = avfLine.match(/\[(\d+)\]\s+(.+)/);
            if (avfMatch) {
              devices.push({ deviceId: avfMatch[1], kind: avfKind, label: avfMatch[2].trim() });
            }
          }
        }
      } catch (e) {}
    }
  } catch (e) {
    // Device enumeration failed silently
  }

  return devices;
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
  if (vOpts === true) vOpts = {};
  if (vOpts === false || vOpts === undefined) vOpts = {};

  var stream = new MediaStream();

  // Pass displaySurface and windowTitle through to GStreamer/FFmpeg
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
  var sampleRate = opts.sampleRate || 48000;
  var channels = opts.channelCount || opts.numberOfChannels || 2;
  var plat = platform();

  var track = new MediaStreamTrack({
    kind: 'audio', label: 'system-audio',
    settings: { sampleRate: sampleRate, channelCount: channels },
  });
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
export { enumerateDevices, getDisplayMedia };
