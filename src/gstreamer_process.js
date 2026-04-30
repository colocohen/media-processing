/**
 * gstreamer_process — GStreamer child process manager for camera capture.
 * Cross-platform: mfvideosrc (Windows), v4l2src (Linux), avfvideosrc (macOS).
 */

import { spawn, execSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { platform } from 'node:os';

function GStreamerProcess(opts) {
  if (!opts) opts = {};
  this._ee = new EventEmitter();
  this._proc = null;
  this._started = false;
  this._gstPath = opts.gstPath || 'gst-launch-1.0';
}

GStreamerProcess.prototype.on = function (ev, fn) { this._ee.on(ev, fn); };
GStreamerProcess.prototype.off = function (ev, fn) { this._ee.off(ev, fn); };

/**
 * Start audio (microphone) capture. Cross-platform via the appropriate
 * GStreamer source element:
 *
 *   Linux:    pulsesrc          (PulseAudio / PipeWire pulse compat)
 *   Windows:  wasapisrc         (WASAPI — included in modern GStreamer)
 *   macOS:    osxaudiosrc       (CoreAudio)
 *
 * Why this exists: the original implementation used FFmpeg with
 * `-f pulse -i default` for audio capture. On many setups
 * (containers, WSL, headless servers, Linux desktops where pulse
 * isn't the default) that subprocess exits silently or never
 * receives audio, and the only sign of trouble is "no sound on the
 * other end". GStreamer's pulsesrc behaves better — it auto-selects
 * a sane default source, surfaces failures via stderr, and matches
 * what the camera path already uses.
 *
 * Output: interleaved s16le PCM at the requested rate/channels on
 * stdout (fd=1), suitable for direct framing into 10ms AudioData
 * chunks by the caller (FrameQueue).
 *
 * @param {object} opts
 * @param {number} [opts.sampleRate=48000]
 * @param {number} [opts.channels=2]
 * @param {string} [opts.device] — Pulse source name (Linux),
 *   WASAPI device-name (Windows), or device id (macOS).
 *   Omit for system default.
 */
GStreamerProcess.prototype.startAudio = function (opts) {
  if (this._started) this.stop();

  opts = opts || {};
  var sampleRate = opts.sampleRate || 48000;
  var channels   = opts.channels || 2;
  var device     = opts.device || null;
  var plat = platform();

  // Source element + per-platform device-property name.
  // pulsesrc:    device=<source-name>
  // wasapisrc:   device=<device-name-friendly>
  // osxaudiosrc: device=<integer-id>
  var src;
  if (plat === 'win32') {
    src = device ? 'wasapisrc device="' + device + '"' : 'wasapisrc';
  } else if (plat === 'darwin') {
    src = device ? 'osxaudiosrc device=' + device : 'osxaudiosrc';
  } else {
    // Pulse-compat works on PulseAudio AND PipeWire (which ships a
    // pulse shim by default on most modern Linux distros).
    src = device ? 'pulsesrc device="' + device + '"' : 'pulsesrc';
  }

  // Caps after audioconvert+audioresample so the format negotiation
  // happens AFTER conversion, letting GStreamer pick whatever the
  // device exposes natively and convert downstream.
  var caps = 'audio/x-raw,format=S16LE,layout=interleaved' +
             ',rate=' + sampleRate +
             ',channels=' + channels;

  var args = [
    '-q',                              // quiet (no progress lines)
    src,
    '!', 'audioconvert',
    '!', 'audioresample',
    '!', caps,
    // Bound the queue so a slow consumer doesn't accumulate audio in
    // memory; leaky=downstream drops oldest. max-size-time=0 means
    // we don't apply a wall-clock limit, only a buffer count.
    '!', 'queue', 'leaky=downstream', 'max-size-buffers=8', 'max-size-time=0',
    '!', 'fdsink', 'fd=1', 'sync=false',
  ];

  // Mid-pipeline `!` tokens collapse around the source element string
  // when it contains a space (e.g. 'pulsesrc device="..."'). Splitting
  // by the GST shell-style separator is what gst-launch expects.
  var flat = [];
  for (var i = 0; i < args.length; i++) {
    var token = args[i];
    if (typeof token === 'string' && token.indexOf(' ') >= 0 && i === 1) {
      // Source element with property — split on whitespace, but keep
      // quoted segments intact (device="..." stays one arg).
      var parts = token.match(/"[^"]*"|\S+/g);
      for (var p = 0; p < parts.length; p++) flat.push(parts[p].replace(/"/g, ''));
    } else {
      flat.push(token);
    }
  }

  // stderr is INHERITED — GStreamer's launch errors (missing
  // pulsesrc, no default source, permission denied) go straight to
  // the parent process's stderr where the user can see them. The
  // FFmpeg path silently swallowed these and that's the bug we're
  // fixing here.
  var proc = spawn(this._gstPath, flat, { stdio: ['ignore', 'pipe', 'inherit'] });
  this._proc = proc;
  this._started = true;

  var self = this;
  proc.on('error', function (e) {
    self._ee.emit('error', new Error('GStreamer audio capture failed: ' + (e.message || e)));
  });
  proc.on('close', function (code) {
    self._started = false;
    // A non-zero exit when we didn't ask for stop() means the source
    // never produced any audio. Surface it as an error so callers
    // (track) emit 'error' rather than just 'close'.
    if (code !== 0 && code !== null) {
      self._ee.emit('error', new Error(
        'GStreamer audio exited with code ' + code +
        ' — check the stderr above for the actual cause.' +
        ' Common causes: no microphone, pulseaudio not running,' +
        ' device permissions denied.'
      ));
    }
    self._ee.emit('close', code);
  });

  proc.stdout.on('data', function (chunk) {
    self._ee.emit('data', chunk);
  });

  return proc;
};

/**
 * Start camera capture (smart-negotiation aware).
 *
 * Async internally: probes the device's native capabilities (cached),
 * picks the best matching mode, and builds a pipeline that pins the
 * source to that mode and uses videoscale+videorate to deliver exactly
 * the size and rate the caller asked for. This avoids the
 * "not-negotiated -4" failure that hits when the user requests a mode
 * the camera doesn't natively expose.
 *
 * If the probe is unavailable or returns nothing, the pipeline is
 * built without source caps, relying on default GStreamer negotiation
 * — videoscale is still in the chain so most cameras will still work.
 *
 * The function returns immediately (no proc available synchronously);
 * data, error, and close events flow through the EventEmitter as
 * before. To know when the pipeline is actually running, listen for
 * the first 'data' event.
 *
 * @param {object} opts
 * @param {number} opts.width
 * @param {number} opts.height
 * @param {number} opts.fps
 * @param {string} [opts.device] — device path/name (platform-specific)
 * @param {string} [opts.format='I420'] — output format
 */
GStreamerProcess.prototype.startCamera = function (opts) {
  if (this._started) this.stop();
  var self = this;

  // Async work runs in the background; errors funnel through 'error'
  // on the EventEmitter (existing listener path). Caller's signature
  // is unchanged.
  _startCameraAsync(self, opts || {}).catch(function (e) {
    self._ee.emit('error', e);
  });

  return null;
};

function _startCameraAsync(self, opts) {
  return _probeAllDevices(self._gstPath).then(function (devices) {
    var w   = opts.width  || 1280;
    var h   = opts.height || 720;
    var fps = opts.fps    || 30;

    var target = _findDevice(devices, 'videoinput', opts.device || null);
    var modes  = target ? target.modes : [];
    var native = _selectMode(modes, w, h, fps);

    if (native) {
      console.log(
        '[gstreamer] camera: ' + (target ? target.label : 'default') +
        ' — using native ' + native.width + 'x' + native.height +
        '@' + Math.round(native.fps) + 'fps' +
        (native.format ? ' (' + native.format + ')' : '') +
        ' \u2192 request ' + w + 'x' + h + '@' + fps + 'fps'
      );
    } else if (devices.length === 0) {
      console.log(
        '[gstreamer] camera: probe returned no devices ' +
        '(gst-device-monitor-1.0 unavailable or no cameras detected); ' +
        'falling back to default negotiation with videoscale'
      );
    }

    _spawnCameraPipeline(self, opts, native);
  });
}

function _spawnCameraPipeline(self, opts, native) {
  var w   = opts.width  || 1280;
  var h   = opts.height || 720;
  var fps = opts.fps    || 30;
  var fmt = opts.format || 'I420';

  var source = _getCameraSource(opts.device);
  var args = ['-q', source];

  if (native) {
    var nativeFps = Math.round(native.fps);
    var sourceCaps =
      native.mediaType +
      ',width='  + native.width +
      ',height=' + native.height +
      ',framerate=' + nativeFps + '/1';
    if (native.format && native.mediaType === 'video/x-raw') {
      sourceCaps += ',format=' + native.format;
    }
    args.push('!', sourceCaps);

    // MJPEG cameras need decoding before raw video processing.
    if (native.mediaType === 'image/jpeg') {
      args.push('!', 'jpegdec');
    }
  }

  // videoscale absorbs size differences, videoconvert handles format,
  // videorate adjusts framerate. With these in place, the final caps
  // filter below ALWAYS negotiates successfully regardless of what
  // the source produces. add-borders=true letterboxes aspect-ratio
  // mismatches rather than stretching.
  args.push('!', 'videoconvert', '!', 'videoscale', 'add-borders=true', '!', 'videorate');

  var outCaps = 'video/x-raw,format=' + fmt + ',width=' + w + ',height=' + h + ',framerate=' + fps + '/1';
  args.push('!', outCaps);

  args.push('!', 'queue', 'leaky=downstream', 'max-size-buffers=1', 'max-size-time=0');
  args.push('!', 'fdsink', 'fd=1', 'sync=false');

  var proc = spawn(self._gstPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
  self._proc = proc;
  self._started = true;

  proc.on('error', function (e) {
    self._ee.emit('error', new Error('GStreamer not found or failed: ' + (e.message || e)));
  });
  proc.on('close', function (code) {
    self._started = false;
    if (code !== 0 && code !== null) {
      self._ee.emit('error', new Error(
        'GStreamer camera exited with code ' + code +
        (native
          ? ' \u2014 pipeline used native ' + native.width + 'x' + native.height +
            '@' + Math.round(native.fps) + 'fps. See stderr above.'
          : ' \u2014 no native mode probed; relied on default negotiation. See stderr above.')
      ));
    }
    self._ee.emit('close', code);
  });

  proc.stdout.on('data', function (chunk) {
    self._ee.emit('data', chunk);
  });

  return proc;
}

/**
 * Start screen capture (via FFmpeg gdigrab/x11grab).
 * @param {object} opts
 * @param {number} opts.width
 * @param {number} opts.height
 * @param {number} opts.fps
 * @param {string} [opts.ffmpegPath='ffmpeg']
 */
GStreamerProcess.prototype.startScreen = function (opts) {
  if (this._started) this.stop();

  var w = opts.width || 1280;
  var h = opts.height || 720;
  var fps = opts.fps || 30;
  var ffmpegPath = opts.ffmpegPath || 'ffmpeg';
  var displaySurface = opts.displaySurface || 'monitor';
  var windowTitle = opts.windowTitle || null;
  var drawMouse = (opts.cursor === false) ? '0' : '1';

  var plat = platform();
  var args = ['-loglevel', 'error'];

  if (plat === 'win32') {
    // Try ddagrab (Desktop Duplication API, FFmpeg 7+) — no cursor flickering
    // Falls back to gdigrab if ddagrab is not available
    var useGdigrab = (displaySurface === 'window' && windowTitle) || opts.captureMethod === 'gdigrab';
    var useDdagrab = !useGdigrab && _hasDdagrab(ffmpegPath);

    if (useDdagrab) {
      args.push(
        '-f', 'ddagrab',
        '-draw_mouse', drawMouse,
        '-framerate', String(fps),
        '-i', opts.display || '0'       // display output index (0 = primary)
      );
      // ddagrab outputs hardware frames — need hwdownload + format conversion
      args.push(
        '-vf', 'hwdownload,format=bgra,scale=' + w + ':' + h,
        '-pix_fmt', 'yuv420p',
        '-f', 'rawvideo',
        'pipe:1'
      );
    } else if (displaySurface === 'window' && windowTitle) {
      // Window capture — gdigrab only (ddagrab doesn't support window titles)
      args.push(
        '-f', 'gdigrab',
        '-draw_mouse', drawMouse,
        '-framerate', String(fps),
        '-i', 'title=' + windowTitle
      );
      args.push(
        '-vf', 'scale=' + w + ':' + h,
        '-pix_fmt', 'yuv420p',
        '-f', 'rawvideo',
        'pipe:1'
      );
    } else {
      args.push(
        '-f', 'gdigrab',
        '-draw_mouse', drawMouse,
        '-framerate', String(fps),
        '-i', 'desktop'
      );
      args.push(
        '-vf', 'scale=' + w + ':' + h,
        '-pix_fmt', 'yuv420p',
        '-f', 'rawvideo',
        'pipe:1'
      );
    }
  } else if (plat === 'linux') {
    var display = opts.display || process.env.DISPLAY || ':0.0';
    if (displaySurface === 'window' && windowTitle) {
      // Window capture via x11grab — get window ID by name using xdotool
      var windowId = null;
      try {
        windowId = execSync('xdotool search --name ' + JSON.stringify(windowTitle) + ' | head -1', {
          timeout: 3000, encoding: 'utf8',
        }).trim();
      } catch (e) {}

      if (windowId) {
        // Get window geometry
        var geom = null;
        try {
          geom = execSync('xdotool getwindowgeometry --shell ' + windowId, {
            timeout: 3000, encoding: 'utf8',
          });
        } catch (e) {}

        var winX = 0, winY = 0, winW = w, winH = h;
        if (geom) {
          var mx = geom.match(/X=(\d+)/);
          var my = geom.match(/Y=(\d+)/);
          var mw = geom.match(/WIDTH=(\d+)/);
          var mh = geom.match(/HEIGHT=(\d+)/);
          if (mx) winX = parseInt(mx[1], 10);
          if (my) winY = parseInt(my[1], 10);
          if (mw) winW = parseInt(mw[1], 10);
          if (mh) winH = parseInt(mh[1], 10);
        }

        args.push(
          '-f', 'x11grab',
          '-draw_mouse', drawMouse,
          '-framerate', String(fps),
          '-video_size', winW + 'x' + winH,
          '-grab_x', String(winX), '-grab_y', String(winY),
          '-i', display
        );
      } else {
        // Fallback to full screen if window not found
        args.push(
          '-f', 'x11grab',
          '-draw_mouse', drawMouse,
          '-framerate', String(fps),
          '-video_size', w + 'x' + h,
          '-i', display
        );
      }
    } else {
      args.push(
        '-f', 'x11grab',
        '-draw_mouse', drawMouse,
        '-framerate', String(fps),
        '-video_size', w + 'x' + h,
        '-i', display
      );
    }
  } else if (plat === 'darwin') {
    // macOS: avfoundation — device index selects screen/window
    args.push(
      '-f', 'avfoundation',
      '-framerate', String(fps),
      '-capture_cursor', drawMouse,
      '-i', opts.device || '1'
    );
  }

  // Linux/macOS: add common output args (Windows handles output in each branch)
  if (plat !== 'win32') {
    args.push(
      '-vf', 'scale=' + w + ':' + h,
      '-pix_fmt', 'yuv420p',
      '-f', 'rawvideo',
      'pipe:1'
    );
  }

  var proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  this._proc = proc;
  this._started = true;

  var self = this;
  proc.on('error', function (e) {
    self._ee.emit('error', new Error('FFmpeg screen capture failed: ' + (e.message || e)));
  });
  proc.on('close', function (code) {
    self._started = false;
    self._ee.emit('close', code);
  });

  proc.stdout.on('data', function (chunk) {
    self._ee.emit('data', chunk);
  });

  // Forward stderr for diagnostics
  if (proc.stderr) {
    proc.stderr.on('data', function () { /* suppress */ });
  }

  return proc;
};

GStreamerProcess.prototype.stop = function () {
  if (!this._proc) return;
  try { this._proc.kill('SIGKILL'); } catch (e) {}
  this._proc = null;
  this._started = false;
};

Object.defineProperty(GStreamerProcess.prototype, 'running', {
  get: function () { return this._started; },
});

// ── Platform detection ──
function _getCameraSource(device) {
  var plat = platform();
  if (plat === 'win32') return device || 'mfvideosrc';
  if (plat === 'darwin') return device || 'avfvideosrc';
  // Linux default
  return device || 'v4l2src';
}

/**
 * Check if FFmpeg supports ddagrab (Desktop Duplication API, FFmpeg 7+).
 * Cached after first call.
 */
var _ddagrabChecked = false;
var _ddagrabAvailable = false;

function _hasDdagrab(ffmpegPath) {
  if (_ddagrabChecked) return _ddagrabAvailable;
  _ddagrabChecked = true;
  try {
    var out = execSync(
      (ffmpegPath || 'ffmpeg') + ' -hide_banner -demuxers 2>&1',
      { timeout: 5000, encoding: 'utf8' }
    );
    _ddagrabAvailable = out.indexOf('ddagrab') >= 0;
  } catch (e) {
    _ddagrabAvailable = false;
  }
  return _ddagrabAvailable;
}


// ── Device capability probing (smart negotiation + W3C enumerateDevices) ──
//
// Hard-coding the user's requested width/height as source caps fails the
// moment the camera doesn't expose that exact mode. mfvideosrc on Windows
// raises "Internal data stream error / not-negotiated -4" and tears down
// the pipeline; v4l2src and avfvideosrc behave similarly. Real-world
// cameras typically expose only a handful of modes (640x480, 1280x720,
// 1920x1080, sometimes MJPEG-only at the higher resolutions), so any
// app that asks for 320x240 or other "small odd sizes" is gambling.
//
// Strategy: run gst-device-monitor-1.0 once at startup, parse EVERY
// device's full caps list, cache the result. Three users of this cache:
//
//   1. startCamera        - pick the native mode best matching the
//                            user's request, pin it at the source.
//   2. enumerateDevices   - list devices with kind/label/deviceId.
//   3. getCapabilities    - derive W3C-style {min,max} ranges from
//                            the cached modes.
//
// Cached per gstPath (the binary location), since capabilities don't
// change for a fixed build during a session.

var _probeCache = new Map();

/**
 * Probe ALL media devices (Video/Source AND Audio/Source) via
 * gst-device-monitor-1.0. Returns Promise<DeviceInfo[]> where each
 * DeviceInfo is { kind, deviceId, label, modes }. On any failure
 * (binary missing, timeout, unparseable output) resolves to [] -
 * callers fall back to default behavior.
 */
function _probeAllDevices(gstPath) {
  var cacheKey = gstPath || 'gst-launch-1.0';
  if (_probeCache.has(cacheKey)) {
    return Promise.resolve(_probeCache.get(cacheKey));
  }

  // gst-device-monitor-1.0 ships in the same bin/ as gst-launch-1.0,
  // so derive its path by name substitution. Handles both POSIX and
  // Windows (with .exe) and bare names that rely on PATH lookup.
  var monitorPath = (gstPath || 'gst-launch-1.0')
    .replace(/gst-launch-1\.0(\.exe)?$/i, function (_, ext) {
      return 'gst-device-monitor-1.0' + (ext || '');
    });

  return new Promise(function (resolve) {
    var out = '';
    var done = false;
    function finish(devices) {
      if (done) return;
      done = true;
      _probeCache.set(cacheKey, devices);
      resolve(devices);
    }

    var proc;
    try {
      // Querying both classes in one invocation is supported by
      // gst-device-monitor-1.0 and is a single subprocess.
      proc = spawn(monitorPath, ['Video/Source', 'Audio/Source'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (e) {
      finish([]);
      return;
    }

    proc.stdout.on('data', function (c) { out += c.toString(); });
    proc.on('error', function () { finish([]); });
    proc.on('close', function () {
      finish(_parseAllDevices(out));
    });

    var probeTimer = setTimeout(function () {
      if (done) return;
      try { proc.kill('SIGKILL'); } catch (e) {}
      finish([]);
    }, 2000);
    if (probeTimer && probeTimer.unref) probeTimer.unref();
  });
}

/**
 * Parse gst-device-monitor-1.0 output into a flat device list.
 *
 * Output format (one entry per device):
 *
 *   Device found:
 *     name  : Integrated Camera
 *     class : Video/Source
 *     caps  : video/x-raw, format=(string)YUY2, width=(int)640, ...;
 *             video/x-raw, format=(string)YUY2, width=(int)1280, ...;
 *             image/jpeg, width=(int)1920, ...;
 *     properties:
 *       device.path = /dev/video0
 *       device.api  = v4l2
 *
 * Returns DeviceInfo[]:
 *   { kind:     'videoinput'|'audioinput',
 *     deviceId: string,    // device.path or fallback
 *     label:    string,    // human-readable name
 *     modes:    Mode[] }   // shape varies by kind
 */
function _parseAllDevices(text) {
  var devices = [];
  var blocks = text.split(/Device found\s*:/);

  for (var b = 1; b < blocks.length; b++) {
    var block = blocks[b];

    var classMatch = block.match(/class\s*:\s*(Video\/Source|Audio\/Source)/i);
    if (!classMatch) continue;
    var isVideo = /^video/i.test(classMatch[1]);
    var kind = isVideo ? 'videoinput' : 'audioinput';

    var nameMatch = block.match(/name\s*:\s*([^\n]+)/);
    var label = nameMatch ? nameMatch[1].trim() : 'Unknown';

    // deviceId resolution priority: device.path > device.string >
    // device.id > the device name. device.path is the most stable
    // identifier across reboots on Linux/Windows MF; on macOS
    // avfoundation it shows up as a numeric index. Always a string.
    var idMatch =
      block.match(/device\.path\s*=\s*"([^"]+)"/) ||
      block.match(/device\.path\s*=\s*(\S+)/) ||
      block.match(/device\.string\s*=\s*"([^"]+)"/) ||
      block.match(/device\.string\s*=\s*(\S+)/) ||
      block.match(/device\.id\s*=\s*"([^"]+)"/) ||
      block.match(/device\.id\s*=\s*(\S+)/);
    var deviceId = idMatch ? idMatch[1] : label;

    // Caps span from "caps:" until the next top-level key.
    var capsStart = block.search(/\bcaps\s*:/);
    if (capsStart < 0) continue;
    var afterCaps = block.substring(capsStart);
    var nextKey = afterCaps.search(/\n\s*[a-zA-Z][\w-]*\s*:/);
    var capsText = nextKey > 0 ? afterCaps.substring(0, nextKey) : afterCaps;

    var entries = capsText.split(';');
    var modes = [];
    for (var i = 0; i < entries.length; i++) {
      var mode = isVideo
        ? _parseCapEntry(entries[i])
        : _parseAudioCapEntry(entries[i]);
      if (mode) modes.push(mode);
    }

    if (!modes.length) continue;

    devices.push({
      kind:     kind,
      deviceId: deviceId,
      label:    label,
      modes:    modes,
    });
  }
  return devices;
}

/**
 * Parse one video cap entry, e.g.:
 *   "video/x-raw, format=(string)YUY2, width=(int)640, height=(int)480,
 *    framerate=(fraction)30/1"
 *
 * Returns { mediaType, format, width, height, framerates: number[] }
 * or null if the entry is malformed or unsupported.
 */
function _parseCapEntry(entry) {
  var mediaTypeMatch = entry.match(/(video\/x-raw|image\/jpeg)/);
  if (!mediaTypeMatch) return null;

  var widthMatch  = entry.match(/width\s*=\s*\(int\)\s*(\d+)/);
  var heightMatch = entry.match(/height\s*=\s*\(int\)\s*(\d+)/);
  if (!widthMatch || !heightMatch) return null;

  var formatMatch = entry.match(/format\s*=\s*\(string\)\s*([^\s,;{}]+)/);

  // framerate forms encountered in practice:
  //   (fraction)30/1                          single
  //   (fraction){ 30/1, 24/1, 15/1, 5/1 }     enumerated list
  //   (fraction)[ 1/1, 30/1 ]                 continuous range
  var fpsList = [];
  var listMatch   = entry.match(/framerate\s*=\s*\(fraction\)\s*\{([^}]+)\}/);
  var rangeMatch  = entry.match(/framerate\s*=\s*\(fraction\)\s*\[([^\]]+)\]/);
  var singleMatch = entry.match(/framerate\s*=\s*\(fraction\)\s*(\d+)\/(\d+)/);

  if (listMatch) {
    var parts = listMatch[1].split(',');
    for (var i = 0; i < parts.length; i++) {
      var f = _parseFraction(parts[i].trim());
      if (f != null) fpsList.push(f);
    }
  } else if (rangeMatch) {
    var bounds = rangeMatch[1].split(',');
    if (bounds.length === 2) {
      var lo = _parseFraction(bounds[0].trim());
      var hi = _parseFraction(bounds[1].trim());
      if (lo != null && hi != null) {
        var commons = [60, 50, 30, 25, 24, 15, 10, 5];
        for (var c = 0; c < commons.length; c++) {
          if (commons[c] >= lo && commons[c] <= hi) fpsList.push(commons[c]);
        }
        if (fpsList.indexOf(lo) < 0) fpsList.push(lo);
        if (fpsList.indexOf(hi) < 0) fpsList.push(hi);
      }
    }
  } else if (singleMatch) {
    var num = parseInt(singleMatch[1], 10);
    var den = parseInt(singleMatch[2], 10);
    if (den > 0) fpsList.push(num / den);
  }

  if (!fpsList.length) return null;
  fpsList.sort(function (a, b) { return a - b; });

  return {
    mediaType:  mediaTypeMatch[1],
    format:     formatMatch ? formatMatch[1] : null,
    width:      parseInt(widthMatch[1], 10),
    height:     parseInt(heightMatch[1], 10),
    framerates: fpsList,
  };
}

/**
 * Parse one audio cap entry, e.g.:
 *   "audio/x-raw, format=(string)S16LE, layout=(string)interleaved,
 *    rate=(int)[ 1, 384000 ], channels=(int)[ 1, 64 ]"
 *
 * Returns { format, sampleRates, channels } where sampleRates and
 * channels are number[]. For ranges, [min, max]. For lists, all
 * values. For singles, single-element arrays.
 */
function _parseAudioCapEntry(entry) {
  if (!/audio\/x-raw/.test(entry)) return null;

  var formatMatch = entry.match(/format\s*=\s*\(string\)\s*([^\s,;{}]+)/);
  var rates    = _parseIntField(entry, 'rate');
  var channels = _parseIntField(entry, 'channels');

  if (!rates.length || !channels.length) return null;

  return {
    format:      formatMatch ? formatMatch[1] : 'S16LE',
    sampleRates: rates,
    channels:    channels,
  };
}

/** Parse a (int) field as range, list, or single. Returns number[]. */
function _parseIntField(entry, fieldName) {
  var rangeMatch  = entry.match(new RegExp(fieldName + '\\s*=\\s*\\(int\\)\\s*\\[([^\\]]+)\\]'));
  var listMatch   = entry.match(new RegExp(fieldName + '\\s*=\\s*\\(int\\)\\s*\\{([^}]+)\\}'));
  var singleMatch = entry.match(new RegExp(fieldName + '\\s*=\\s*\\(int\\)\\s*(\\d+)'));

  if (rangeMatch) {
    var bounds = rangeMatch[1].split(',');
    if (bounds.length === 2) {
      var lo = parseInt(bounds[0].trim(), 10);
      var hi = parseInt(bounds[1].trim(), 10);
      if (Number.isFinite(lo) && Number.isFinite(hi)) return [lo, hi];
    }
  } else if (listMatch) {
    var items = listMatch[1].split(',');
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var n = parseInt(items[i].trim(), 10);
      if (Number.isFinite(n)) out.push(n);
    }
    return out;
  } else if (singleMatch) {
    var s = parseInt(singleMatch[1], 10);
    if (Number.isFinite(s)) return [s];
  }
  return [];
}

function _parseFraction(s) {
  var p = s.split('/');
  if (p.length !== 2) return null;
  var num = parseInt(p[0], 10), den = parseInt(p[1], 10);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return null;
  return num / den;
}

/**
 * Convert a probed mode list to W3C-style capabilities.
 *
 * Video -> { width: {min,max}, height: {min,max}, frameRate: {min,max} }
 * Audio -> { sampleRate: {min,max}, channelCount: {min,max} }
 *
 * Empty input or unknown kind returns {}. Spec: W3C Media Capture
 * MediaTrackCapabilities.
 */
function capabilitiesFromModes(modes, kind) {
  if (!modes || !modes.length) return {};

  if (kind === 'videoinput') {
    var minW = Infinity, maxW = 0, minH = Infinity, maxH = 0;
    var minFps = Infinity, maxFps = 0;
    for (var i = 0; i < modes.length; i++) {
      var m = modes[i];
      if (m.width  < minW) minW = m.width;
      if (m.width  > maxW) maxW = m.width;
      if (m.height < minH) minH = m.height;
      if (m.height > maxH) maxH = m.height;
      for (var j = 0; j < m.framerates.length; j++) {
        var f = m.framerates[j];
        if (f < minFps) minFps = f;
        if (f > maxFps) maxFps = f;
      }
    }
    return {
      width:     { min: minW,   max: maxW },
      height:    { min: minH,   max: maxH },
      frameRate: { min: minFps, max: maxFps },
    };
  }

  if (kind === 'audioinput') {
    var minR = Infinity, maxR = 0, minC = Infinity, maxC = 0;
    for (var k = 0; k < modes.length; k++) {
      var am = modes[k];
      if (am.sampleRates && am.sampleRates.length) {
        var srMin = Math.min.apply(null, am.sampleRates);
        var srMax = Math.max.apply(null, am.sampleRates);
        if (srMin < minR) minR = srMin;
        if (srMax > maxR) maxR = srMax;
      }
      if (am.channels && am.channels.length) {
        var chMin = Math.min.apply(null, am.channels);
        var chMax = Math.max.apply(null, am.channels);
        if (chMin < minC) minC = chMin;
        if (chMax > maxC) maxC = chMax;
      }
    }
    return {
      sampleRate:   { min: minR, max: maxR },
      channelCount: { min: minC, max: maxC },
    };
  }

  return {};
}

/**
 * Pick the best video native mode for a requested W/H/FPS. Heuristic.
 * Scoring (lower = better):
 *   - upscale (mode smaller than requested):  HEAVY penalty
 *   - excess pixels (downscale work):         light penalty
 *   - aspect-ratio mismatch:                  moderate penalty
 *   - JPEG path (extra jpegdec stage):        small penalty
 *   - framerate distance from requested:      small penalty,
 *                                             smallest fps >= req preferred
 */
function _selectMode(modes, reqW, reqH, reqFps) {
  if (!modes || !modes.length) return null;

  var requestAr = reqW / reqH;
  var bestScore = Infinity;
  var winner = null;
  var winnerFps = null;

  for (var i = 0; i < modes.length; i++) {
    var m = modes[i];
    var score = 0;

    if (m.width  < reqW) score += (reqW - m.width)  * 100;
    if (m.height < reqH) score += (reqH - m.height) * 100;

    var pixels = m.width * m.height;
    var reqPixels = reqW * reqH;
    if (pixels > reqPixels) score += Math.log2(pixels / reqPixels) * 50;

    score += Math.abs(requestAr - (m.width / m.height)) * 200;

    if (m.mediaType === 'image/jpeg') score += 100;

    var pickedFps = null;
    for (var j = 0; j < m.framerates.length; j++) {
      var f = m.framerates[j];
      if (f >= reqFps - 0.1) {
        if (pickedFps === null || f < pickedFps) pickedFps = f;
      }
    }
    if (pickedFps === null) {
      pickedFps = m.framerates[m.framerates.length - 1];
      score += (reqFps - pickedFps) * 30;
    } else {
      score += (pickedFps - reqFps) * 2;
    }

    if (score < bestScore) {
      bestScore = score;
      winner = m;
      winnerFps = pickedFps;
    }
  }

  if (!winner) return null;
  return {
    mediaType: winner.mediaType,
    format:    winner.format,
    width:     winner.width,
    height:    winner.height,
    fps:       winnerFps,
  };
}

/**
 * Find the device matching a (possibly null) device hint among probed
 * devices of the requested kind. Falls back to first matching device.
 */
function _findDevice(devices, kind, deviceHint) {
  for (var i = 0; i < devices.length; i++) {
    if (devices[i].kind !== kind) continue;
    if (!deviceHint) return devices[i];
    if (devices[i].deviceId === deviceHint) return devices[i];
    if (devices[i].label.indexOf(deviceHint) >= 0) return devices[i];
  }
  for (var j = 0; j < devices.length; j++) {
    if (devices[j].kind === kind) return devices[j];
  }
  return null;
}

/**
 * Public probe API. Use this from get_user_media.js's enumerateDevices
 * or anywhere else that needs the full device list with capabilities.
 * Returns a Promise<DeviceInfo[]> (cached after first call).
 */
GStreamerProcess.probeAllDevices = function (gstPath) {
  return _probeAllDevices(gstPath || 'gst-launch-1.0');
};

GStreamerProcess.capabilitiesFromModes = capabilitiesFromModes;

export default GStreamerProcess;
