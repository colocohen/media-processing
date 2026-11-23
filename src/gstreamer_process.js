/**
 * gstreamer_process — GStreamer child process manager for camera capture.
 * Cross-platform: mfvideosrc (Windows), v4l2src (Linux), avfvideosrc (macOS).
 */

import { spawn, spawnSync, execFile } from 'node:child_process';
import EventEmitter from './core/events.js';
import { platform } from 'node:os';

function GStreamerProcess(opts) {
  if (!opts) opts = {};
  this._ee = new EventEmitter();
  this._proc = null;
  this._started = false;
  // Bumped by every start*() and stop(). The camera and screen paths
  // spawn after an async step (device probe / screen-size probe); the
  // spawn only happens if no stop() or newer start*() came in between.
  // Without it a pipeline started after stop() — getUserMedia(c, cb)
  // returns the stream synchronously and the app may stop its tracks
  // before the probe resolves — was never killed (C9).
  this._gen = 0;
  this._gstPath = opts.gstPath || 'gst-launch-1.0';
}

GStreamerProcess.prototype.on = function (ev, fn) { this._ee.on(ev, fn); };
GStreamerProcess.prototype.off = function (ev, fn) { this._ee.off(ev, fn); };

GStreamerProcess.prototype._begin = function () {
  if (this._started || this._proc) this.stop();
  this._gen++;
  return this._gen;
};

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
 * @param {string} [opts.device] — deviceId (from the probe), or a
 *   Pulse source name (Linux), WASAPI device id (Windows), CoreAudio
 *   device id (macOS). Omit for system default.
 * @param {object} [opts.deviceInfo] — the probed DeviceInfo to open;
 *   its launch line (element + properties) is used as the source.
 */
GStreamerProcess.prototype.startAudio = function (opts) {
  this._begin();

  opts = opts || {};
  var sampleRate = opts.sampleRate || 48000;
  var channels   = opts.channels || 2;

  // Source element + per-platform device property, as separate argv
  // tokens (see _sourceTokens). The old code glued 'pulsesrc device="x"'
  // into one string and split it again, stripping every quote — a device
  // name containing a quote or '!' broke the pipeline.
  var src = _sourceTokens('audioinput', opts.device || null, opts.deviceInfo || null);

  // Caps after audioconvert+audioresample so the format negotiation
  // happens AFTER conversion, letting GStreamer pick whatever the
  // device exposes natively and convert downstream.
  var caps = 'audio/x-raw,format=S16LE,layout=interleaved' +
             ',rate=' + Math.round(sampleRate) +
             ',channels=' + Math.round(channels);

  var args = ['-q'].concat(src, [
    '!', 'audioconvert',
    '!', 'audioresample',
    '!', caps,
    // Bound the queue so a slow consumer doesn't accumulate audio in
    // memory; leaky=downstream drops oldest. max-size-time=0 means
    // we don't apply a wall-clock limit, only a buffer count.
    '!', 'queue', 'leaky=downstream', 'max-size-buffers=8', 'max-size-time=0',
    '!', 'fdsink', 'fd=1', 'sync=false',
  ]);

  // stderr is INHERITED — GStreamer's launch errors (missing
  // pulsesrc, no default source, permission denied) go straight to
  // the parent process's stderr where the user can see them. The
  // FFmpeg path silently swallowed these and that's the bug we're
  // fixing here.
  var proc = spawn(this._gstPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
  this._proc = proc;
  this._started = true;

  var self = this;
  proc.on('error', function (e) {
    self._ee.emit('error', new Error('GStreamer audio capture failed: ' + (e.message || e)));
  });
  proc.on('close', function (code) {
    if (self._proc === proc) self._started = false;
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
 * Output buffers use GStreamer's default I420 layout, which is NOT
 * tightly packed for every size: see GStreamerProcess.i420Layout /
 * repackI420.
 *
 * @param {object} opts
 * @param {number} opts.width
 * @param {number} opts.height
 * @param {number} opts.fps
 * @param {string} [opts.device] — deviceId (from the probe / enumerateDevices)
 * @param {object} [opts.deviceInfo] — the probed DeviceInfo to open
 * @param {string} [opts.format='I420'] — output format
 */
GStreamerProcess.prototype.startCamera = function (opts) {
  var gen = this._begin();
  var self = this;
  opts = opts || {};

  // Async work runs in the background; errors funnel through 'error'
  // on the EventEmitter (existing listener path). Caller's signature
  // is unchanged.
  // getUserMedia has already probed and chosen the device (deviceInfo,
  // null when the probe could not run): don't probe again.
  var devicesP = ('deviceInfo' in opts)
    ? Promise.resolve(opts.deviceInfo ? [opts.deviceInfo] : [])
    : _probeAllDevices(self._gstPath);
  devicesP.then(function (devices) {
    if (gen !== self._gen) return;   // stopped / restarted meanwhile
    _startCameraWithDevices(self, opts, devices);
  }).catch(function (e) {
    if (gen !== self._gen) return;
    self._ee.emit('error', e);
  });

  return null;
};

function _startCameraWithDevices(self, opts, devices) {
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
      ' → request ' + w + 'x' + h + '@' + fps + 'fps'
    );
  } else if (devices.length === 0) {
    console.log(
      '[gstreamer] camera: probe returned no devices ' +
      '(gst-device-monitor-1.0 unavailable or no cameras detected); ' +
      'falling back to default negotiation with videoscale'
    );
  }

  _spawnCameraPipeline(self, opts, native, target);
}

function _spawnCameraPipeline(self, opts, native, target) {
  var w   = opts.width  || 1280;
  var h   = opts.height || 720;
  var fps = opts.fps    || 30;
  var fmt = opts.format || 'I420';

  // The source element is fixed per platform (or taken from the probed
  // device's launch line); the device goes in as a PROPERTY. deviceId
  // used to be passed as the element itself: enumerateDevices() gives
  // '/dev/video0', and the pipeline became "-q /dev/video0 ! ..." —
  // "no element /dev/video0", so selecting any camera failed (C1).
  var args = ['-q'].concat(_sourceTokens('videoinput', opts.device || null, target));

  if (native) {
    var sourceCaps =
      native.mediaType +
      ',width='  + native.width +
      ',height=' + native.height +
      ',framerate=' + _fpsFraction(native.fps);
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

  // Integer sizes, fractional rate: 'width=960.5' or 'framerate=24.5/1'
  // are invalid caps and gst-launch refused the pipeline (C10).
  var outCaps = 'video/x-raw,format=' + fmt + ',width=' + Math.round(w) +
    ',height=' + Math.round(h) + ',framerate=' + _fpsFraction(fps);
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
    if (self._proc === proc) self._started = false;
    if (code !== 0 && code !== null) {
      self._ee.emit('error', new Error(
        'GStreamer camera exited with code ' + code +
        (native
          ? ' — pipeline used native ' + native.width + 'x' + native.height +
            '@' + Math.round(native.fps) + 'fps. See stderr above.'
          : ' — no native mode probed; relied on default negotiation. See stderr above.')
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
 * Start screen capture (via FFmpeg gdigrab/ddagrab/x11grab/avfoundation).
 *
 * Async internally (like startCamera): when the output size is not
 * fully given, the native size of the grabbed surface is probed first.
 * Emits 'size' ({ width, height, sourceWidth, sourceHeight }) with the
 * size of the frames that will be written, BEFORE the process starts.
 *
 * Output size:
 *   width and height given → exactly that, aspect-preserving letterbox
 *   one of them given      → the other from the source's aspect ratio
 *   neither                → the source's native size
 *
 * @param {object} opts
 * @param {number} [opts.width]
 * @param {number} [opts.height]
 * @param {number} opts.fps
 * @param {string} [opts.ffmpegPath='ffmpeg']
 */
GStreamerProcess.prototype.startScreen = function (opts) {
  var gen = this._begin();
  var self = this;
  opts = opts || {};

  var fps = opts.fps || 30;
  var ffmpegPath = opts.ffmpegPath || 'ffmpeg';
  _runScreen(this, gen, opts, _screenInputArgs(opts, platform(), ffmpegPath, fps), ffmpegPath);
  return null;
};

/**
 * Probe the size (unless known), emit 'size', spawn. When the input is
 * ddagrab and FFmpeg fails before delivering a frame, run again with
 * gdigrab — see _spawnScreen's onEarlyFail.
 */
function _runScreen(self, gen, opts, input, ffmpegPath) {
  var sizeP;
  if (opts.width && opts.height) sizeP = Promise.resolve(null);
  else if (input.size) sizeP = Promise.resolve(input.size);
  else sizeP = _probeScreenSize(ffmpegPath, input.args);

  sizeP.then(function (src) {
    if (gen !== self._gen) return;   // stopped / restarted meanwhile
    var out = _screenOutputSize(opts.width, opts.height, src);
    self._ee.emit('size', {
      width: out.width, height: out.height,
      sourceWidth: src ? src.width : undefined,
      sourceHeight: src ? src.height : undefined,
    });
    if (gen !== self._gen) return;   // a 'size' listener may stop us
    var onEarlyFail = !input.ddagrab ? null : function () {
      // Desktop Duplication is unavailable in some sessions (Remote
      // Desktop, some hybrid-GPU laptops, no D3D11 device). Remember it
      // for this FFmpeg and grab with gdigrab instead; the size is
      // probed again (gdigrab's desktop spans every monitor) and a new
      // 'size' is emitted.
      _ddagrabCache.set(ffmpegPath, false);
      if (gen !== self._gen) return;
      _runScreen(self, gen, opts,
        _screenInputArgs(Object.assign({}, opts, { captureMethod: 'gdigrab' }), platform(), ffmpegPath, opts.fps || 30),
        ffmpegPath);
    };
    _spawnScreen(self, ffmpegPath, input, out, !!(opts.width && opts.height), onEarlyFail);
  }).catch(function (e) {
    if (gen !== self._gen) return;
    self._ee.emit('error', e);
  });
}

/**
 * The FFmpeg input half of a screen grab. Returns
 * { args, size: {width,height}|null (known region size), hwFrames,
 *   ddagrab }.
 */
function _screenInputArgs(opts, plat, ffmpegPath, fps) {
  var displaySurface = opts.displaySurface || 'monitor';
  var windowTitle = opts.windowTitle || null;
  var drawMouse = (opts.cursor === false) ? '0' : '1';
  var args = [];
  var size = null;
  var hwFrames = false;

  var useDdagrab = false;
  if (plat === 'win32') {
    // ddagrab (Desktop Duplication API, FFmpeg 6.0+): captures on the
    // GPU, no cursor flicker, far cheaper than gdigrab's GDI BitBlt.
    // gdigrab when it is missing or fails, and for a window by title.
    //
    // ddagrab is a libavfilter SOURCE FILTER, not an input device. It
    // used to be opened as one ('-f ddagrab -framerate 30 -i 0'), which
    // FFmpeg rejects, and detected in 'ffmpeg -demuxers', where it is
    // never listed — so the detection always said no and gdigrab was
    // always used; had it said yes, every screen capture would have
    // failed. Now: '-f lavfi -i ddagrab=…', detected in '-filters'.
    var useGdigrab = (displaySurface === 'window' && windowTitle) || opts.captureMethod === 'gdigrab';
    useDdagrab = !useGdigrab && _hasDdagrab(ffmpegPath);

    if (useDdagrab) {
      // output_idx: the DXGI output (monitor), 0 = primary. framerate
      // is a cap; dup_frames (default on) repeats the last frame while
      // the desktop is idle, so the rate stays constant.
      var outputIdx = parseInt(opts.display, 10);
      if (!(outputIdx >= 0)) outputIdx = 0;
      args.push(
        '-f', 'lavfi',
        '-i', 'ddagrab=output_idx=' + outputIdx + ':framerate=' + fps + ':draw_mouse=' + drawMouse
      );
      // D3D11 hardware frames only: hwdownload,format=bgra brings them
      // to system memory for the software scale / yuv420p conversion.
      hwFrames = true;
    } else if (displaySurface === 'window' && windowTitle) {
      // Window capture — gdigrab only (ddagrab doesn't support window titles).
      // An argv element, never a shell string, so the title is inert.
      args.push(
        '-f', 'gdigrab',
        '-draw_mouse', drawMouse,
        '-framerate', String(fps),
        '-i', 'title=' + windowTitle
      );
    } else {
      args.push(
        '-f', 'gdigrab',
        '-draw_mouse', drawMouse,
        '-framerate', String(fps),
        '-i', 'desktop'
      );
    }
  } else if (plat === 'linux') {
    var display = opts.display || process.env.DISPLAY || ':0.0';
    var region = null;
    if (displaySurface === 'window' && windowTitle) {
      region = _findX11Window(windowTitle);
    }
    if (region) {
      args.push(
        '-f', 'x11grab',
        '-draw_mouse', drawMouse,
        '-framerate', String(fps),
        '-video_size', region.width + 'x' + region.height,
        '-grab_x', String(region.x), '-grab_y', String(region.y),
        '-i', display
      );
      size = { width: region.width, height: region.height };
    } else {
      // The WHOLE screen: no -video_size. It used to pass the requested
      // output size (default 1280x720) as -video_size, which x11grab
      // treats as the grab REGION — a 1920x1080 desktop came out as its
      // top-left 1280x720 corner, not the screen scaled down (C8).
      args.push(
        '-f', 'x11grab',
        '-draw_mouse', drawMouse,
        '-framerate', String(fps),
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

  return { args: args, size: size, hwFrames: hwFrames, ddagrab: useDdagrab };
}

/**
 * Locate an X11 window by title with xdotool. Returns {x,y,width,height}
 * or null.
 *
 * execFile-style argv, no shell: the title used to be pasted into
 * execSync('xdotool search --name ' + JSON.stringify(title) + ' | head -1'),
 * and JSON quotes are double quotes, inside which the shell still runs
 * $(...) — windowTitle 'x$(touch /tmp/p)' executed `touch` (C2). The
 * title is matched literally (xdotool takes a regex), and '--' keeps a
 * title starting with '-' from being read as an option.
 */
function _findX11Window(windowTitle) {
  var pattern = String(windowTitle).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var r = spawnSync('xdotool', ['search', '--name', '--', pattern], {
    timeout: 3000, encoding: 'utf8',
  });
  if (r.error || r.status !== 0 || !r.stdout) return null;
  var windowId = r.stdout.split('\n')[0].trim();
  if (!/^\d+$/.test(windowId)) return null;

  var g = spawnSync('xdotool', ['getwindowgeometry', '--shell', windowId], {
    timeout: 3000, encoding: 'utf8',
  });
  if (g.error || g.status !== 0 || !g.stdout) return null;
  var geom = g.stdout;
  var mx = geom.match(/X=(-?\d+)/);
  var my = geom.match(/Y=(-?\d+)/);
  var mw = geom.match(/WIDTH=(\d+)/);
  var mh = geom.match(/HEIGHT=(\d+)/);
  if (!mw || !mh) return null;
  return {
    x: mx ? Math.max(0, parseInt(mx[1], 10)) : 0,
    y: my ? Math.max(0, parseInt(my[1], 10)) : 0,
    width: parseInt(mw[1], 10),
    height: parseInt(mh[1], 10),
  };
}

/**
 * Native size of a screen grab: grab one frame with the same input args
 * and read the stream size FFmpeg reports. Resolves null on failure.
 */
function _probeScreenSize(ffmpegPath, inputArgs) {
  return new Promise(function (resolve) {
    var args = ['-hide_banner'].concat(inputArgs, ['-frames:v', '1', '-f', 'null', '-']);
    execFile(ffmpegPath, args, { timeout: 5000, encoding: 'utf8' }, function (err, stdout, stderr) {
      var text = String(stderr || '') + String(stdout || '');
      var m = text.match(/Stream #\d+:\d+[^\n]*Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/);
      if (!m) { resolve(null); return; }
      resolve({ width: parseInt(m[1], 10), height: parseInt(m[2], 10) });
    });
  });
}

function _screenOutputSize(w, h, src) {
  if (w && h) return { width: Math.round(w), height: Math.round(h) };
  if (!src) {
    // Native size unknown (probe failed): the old fixed default.
    if (w) return { width: Math.round(w), height: Math.round(w * 9 / 16) };
    if (h) return { width: Math.round(h * 16 / 9), height: Math.round(h) };
    return { width: 1280, height: 720 };
  }
  if (w) return { width: Math.round(w), height: Math.max(1, Math.round(w * src.height / src.width)) };
  if (h) return { width: Math.max(1, Math.round(h * src.width / src.height)), height: Math.round(h) };
  return { width: src.width, height: src.height };
}

/**
 * @param {function|null} onEarlyFail  called instead of reporting the
 *   failure when FFmpeg exits with an error before its first frame
 *   (the ddagrab → gdigrab fallback)
 */
function _spawnScreen(self, ffmpegPath, input, out, letterbox, onEarlyFail) {
  var w = out.width, h = out.height;
  // Letterbox (as the camera path's videoscale add-borders=true). pad
  // runs in 4:4:4: on yuv420p FFmpeg 8 rounds an odd pad size down
  // (321x241 came out 320x240) or refuses it outright.
  var scale = letterbox
    ? 'scale=' + w + ':' + h + ':force_original_aspect_ratio=decrease,format=yuv444p,' +
      'pad=' + w + ':' + h + ':(ow-iw)/2:(oh-ih)/2'
    : 'scale=' + w + ':' + h;
  var args = ['-loglevel', 'error'].concat(input.args, [
    '-vf', (input.hwFrames ? 'hwdownload,format=bgra,' : '') + scale,
    '-pix_fmt', 'yuv420p',
    '-f', 'rawvideo',
    'pipe:1',
  ]);

  var proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  self._proc = proc;
  self._started = true;

  var errText = '';
  var gotData = false, spawnFailed = false;
  proc.on('error', function (e) {
    spawnFailed = true;   // FFmpeg missing: no other grabber will help
    self._ee.emit('error', new Error('FFmpeg screen capture failed: ' + (e.message || e)));
  });
  proc.on('close', function (code) {
    if (self._proc === proc) self._started = false;
    if (onEarlyFail && !gotData && !spawnFailed && code !== 0 && code !== null && self._proc === proc) {
      self._proc = null;
      onEarlyFail();
      return;
    }
    if (code !== 0 && code !== null) {
      self._ee.emit('error', new Error('FFmpeg screen capture exited with code ' + code +
        (errText ? ': ' + errText.trim().split('\n').slice(-1)[0] : '')));
    }
    self._ee.emit('close', code);
  });

  proc.stdout.on('data', function (chunk) {
    gotData = true;
    self._ee.emit('data', chunk);
  });

  // Keep the last bit of stderr for the exit error (was discarded).
  if (proc.stderr) {
    proc.stderr.on('data', function (c) { errText = (errText + c).slice(-2000); });
  }

  return proc;
}

GStreamerProcess.prototype.stop = function () {
  this._gen++;          // cancels a spawn still waiting on a probe (C9)
  this._started = false;
  if (!this._proc) return;
  try { this._proc.kill('SIGKILL'); } catch (e) {}
  this._proc = null;
};

Object.defineProperty(GStreamerProcess.prototype, 'running', {
  get: function () { return this._started; },
});

// ── Source element selection ──

var _DEFAULT_SOURCE = {
  videoinput: { win32: 'mfvideosrc', darwin: 'avfvideosrc', linux: 'v4l2src' },
  audioinput: { win32: 'wasapisrc',  darwin: 'osxaudiosrc', linux: 'pulsesrc' },
};

/**
 * gst-launch argv tokens for the capture source: the element, then its
 * device property.
 *
 * Preferred: the probed device's own launch line (gst-device-monitor
 * prints "gst-launch-1.0 <element> <prop>=<value> ! ..." per device) —
 * it names the right element AND property for every provider (v4l2src
 * device=, pipewiresrc target-object=, mfvideosrc device-path=,
 * avfvideosrc device-index=, pulsesrc device=, ...).
 * Fallback (device not probed): the platform's default element with the
 * deviceId as its device property.
 */
function _sourceTokens(kind, deviceId, deviceInfo) {
  if (deviceInfo && deviceInfo.launch && deviceInfo.launch.element) {
    var t = [deviceInfo.launch.element];
    var props = deviceInfo.launch.props || [];
    // Verbatim: already serialized for gst-launch by gst-device-monitor.
    for (var i = 0; i < props.length; i++) t.push(props[i][0] + '=' + props[i][1]);
    return t;
  }
  var plat = platform();
  var table = _DEFAULT_SOURCE[kind] || _DEFAULT_SOURCE.videoinput;
  var element = table[plat] || table.linux;
  if (!deviceId) return [element];
  var prop;
  if (element === 'mfvideosrc') prop = 'device-path';
  else if (element === 'avfvideosrc') {
    // avfvideosrc selects by index only; a non-numeric id (a label)
    // cannot be expressed — open the default camera.
    if (!/^\d+$/.test(String(deviceId))) return [element];
    prop = 'device-index';
  } else prop = 'device';
  return [element, _gstProp(prop, String(deviceId))];
}

/**
 * One "prop=value" gst-launch token. Plain values go bare (numbers and
 * enums must, a quoted "0" does not deserialize as an int); anything
 * else is double-quoted with \ and " escaped, which gst-launch unwraps
 * back to the exact string (checked with gst 1.28: a filesink location
 * of  a\b c"d!e.txt  round-trips).
 */
function _gstProp(name, value) {
  var v = String(value);
  if (/^[A-Za-z0-9_.:\/+@-]+$/.test(v)) return name + '=' + v;
  return name + '="' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** fps → GStreamer fraction string; 29.97 → 30000/1001, 24.5 → 49/2. */
function _fpsFraction(fps) {
  var f = Number(fps);
  if (!(f > 0)) f = 30;
  if (Math.abs(f - Math.round(f)) < 1e-6) return Math.round(f) + '/1';
  var ntsc = Math.round(f * 1.001);
  if (Math.abs(f - ntsc * 1000 / 1001) < 1e-3) return (ntsc * 1000) + '/1001';
  var num = Math.round(f * 1000), den = 1000;
  var a = num, b = den;
  while (b) { var t = b; b = a % b; a = t; }
  return (num / a) + '/' + (den / a);
}

/**
 * GStreamer's default I420 layout (video-info.c): plane strides are
 * 4-byte aligned and the luma plane covers an even number of rows.
 *   stride Y  = round_up_4(w)
 *   stride UV = round_up_4(round_up_2(w) / 2)
 *   offset U  = stride Y * round_up_2(h)
 *   offset V  = offset U + stride UV * round_up_2(h) / 2
 * fdsink writes buffers in this layout. Only when w % 8 == 0 and h is
 * even is it the tightly packed I420 that VideoFrame expects.
 */
function i420Layout(w, h) {
  var h2 = (h + 1) & ~1;
  var sy = (w + 3) & ~3;
  var suv = ((((w + 1) & ~1) / 2) + 3) & ~3;
  var offU = sy * h2;
  var offV = offU + suv * (h2 / 2);
  var size = offV + suv * (h2 / 2);
  var cw = (w + 1) >> 1;
  var tight = (sy === w && suv === cw && h2 === h);
  return { strideY: sy, strideUV: suv, offsetU: offU, offsetV: offV, size: size, tight: tight };
}

/**
 * Copy one GStreamer-layout I420 buffer into tightly packed I420
 * (W3C VideoFrame / FFmpeg rawvideo layout: chroma ceil(w/2) x ceil(h/2)).
 * Returns `buf` itself when the layouts coincide.
 */
function repackI420(buf, w, h, layout) {
  var L = layout || i420Layout(w, h);
  if (L.tight) return buf;
  var cw = (w + 1) >> 1, ch = (h + 1) >> 1;
  var out = new Uint8Array(w * h + 2 * cw * ch);
  var r, o = 0;
  for (r = 0; r < h; r++, o += w) {
    out.set(buf.subarray(r * L.strideY, r * L.strideY + w), o);
  }
  for (r = 0; r < ch; r++, o += cw) {
    out.set(buf.subarray(L.offsetU + r * L.strideUV, L.offsetU + r * L.strideUV + cw), o);
  }
  for (r = 0; r < ch; r++, o += cw) {
    out.set(buf.subarray(L.offsetV + r * L.strideUV, L.offsetV + r * L.strideUV + cw), o);
  }
  return out;
}

/**
 * Check if FFmpeg has the ddagrab source filter (Desktop Duplication
 * API, FFmpeg 6.0+, Windows builds). It is listed by '-filters' — a
 * line like ' ... ddagrab  |->V  Grab Windows Desktop images using
 * Desktop Duplication API' — never by '-demuxers', where it was looked
 * for. Cached per ffmpeg path; set to false when it fails at run time.
 * argv, no shell: ffmpegPath is caller input (a path with spaces, or
 * worse, went through /bin/sh before).
 */
var _ddagrabCache = new Map();

function _hasDdagrab(ffmpegPath) {
  var key = ffmpegPath || 'ffmpeg';
  if (_ddagrabCache.has(key)) return _ddagrabCache.get(key);
  var ok = false;
  try {
    var r = spawnSync(key, ['-hide_banner', '-filters'], { timeout: 5000, encoding: 'utf8' });
    ok = /^\s*\S+\s+ddagrab\s/m.test(String(r.stdout || ''));
  } catch (e) {
    ok = false;
  }
  _ddagrabCache.set(key, ok);
  return ok;
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
// Successful probes are cached per gstPath for PROBE_TTL_MS (devices get
// plugged in); concurrent callers share the one in-flight probe. Failed
// or timed-out probes are NOT cached. Before, the result was cached only
// once the probe had FINISHED — getUserMedia({video, audio}) started 3
// gst-device-monitor processes (startCamera, the video track and the
// audio track each missed the cache) — and a single timeout cached []
// for the life of the process: no device, no capabilities, ever (C14).

var _probeCache = new Map();
var PROBE_TTL_MS = 60000;
var PROBE_TIMEOUT_MS = 5000;

/**
 * Probe ALL media devices (Video/Source, Audio/Source, Audio/Sink) via
 * gst-device-monitor-1.0. Resolves { ok, devices }:
 *   ok       true when the monitor ran to completion (devices may then
 *            legitimately be empty: there is no such device), false when
 *            it could not run (binary missing, timeout, crash) and
 *            nothing is known about the devices.
 *   devices  DeviceInfo[] — { kind, deviceId, label, modes, launch }.
 */
function _probeDevices(gstPath) {
  var cacheKey = gstPath || 'gst-launch-1.0';
  var cached = _probeCache.get(cacheKey);
  if (cached) {
    if (cached.pending) return cached.promise;
    if (Date.now() - cached.at < PROBE_TTL_MS) return Promise.resolve(cached.result);
  }

  // gst-device-monitor-1.0 ships in the same bin/ as gst-launch-1.0,
  // so derive its path by name substitution. Handles both POSIX and
  // Windows (with .exe) and bare names that rely on PATH lookup.
  var monitorPath = cacheKey
    .replace(/gst-launch-1\.0(\.exe)?$/i, function (_, ext) {
      return 'gst-device-monitor-1.0' + (ext || '');
    });

  var entry = { pending: true, promise: null, result: null, at: 0 };
  entry.promise = new Promise(function (resolve) {
    var out = '';
    var done = false;
    var probeTimer = null;
    function finish(ok, devices) {
      if (done) return;
      done = true;
      if (probeTimer) clearTimeout(probeTimer);
      entry.pending = false;
      entry.result = { ok: ok, devices: devices };
      entry.at = Date.now();
      if (!ok && _probeCache.get(cacheKey) === entry) _probeCache.delete(cacheKey);
      resolve(entry.result);
    }

    var proc;
    try {
      // Querying several classes in one invocation is supported by
      // gst-device-monitor-1.0 and is a single subprocess.
      proc = spawn(monitorPath, ['Video/Source', 'Audio/Source', 'Audio/Sink'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (e) {
      finish(false, []);
      return;
    }

    proc.stdout.on('data', function (c) { out += c.toString(); });
    proc.on('error', function () { finish(false, []); });
    proc.on('close', function (code) {
      if (code !== 0 && code !== null && !/Device found/.test(out)) { finish(false, []); return; }
      finish(code === 0 || /Device found/.test(out), _parseAllDevices(out));
    });

    probeTimer = setTimeout(function () {
      if (done) return;
      try { proc.kill('SIGKILL'); } catch (e) {}
      finish(false, []);
    }, PROBE_TIMEOUT_MS);
    if (probeTimer && probeTimer.unref) probeTimer.unref();
  });
  _probeCache.set(cacheKey, entry);
  return entry.promise;
}

/** Back-compat shape: Promise<DeviceInfo[]> ([] when the probe failed). */
function _probeAllDevices(gstPath) {
  return _probeDevices(gstPath).then(function (r) { return r.devices; });
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
 *   { kind:     'videoinput'|'audioinput'|'audiooutput',
 *     deviceId: string,    // device.path or fallback
 *     label:    string,    // human-readable name
 *     modes:    Mode[],    // shape varies by kind
 *     launch:   { element, props: [[name, value]] } | null }
 *               // the device's own gst-launch source (see _sourceTokens)
 */
function _parseAllDevices(text) {
  var devices = [];
  var blocks = text.split(/Device found\s*:/);

  for (var b = 1; b < blocks.length; b++) {
    var block = blocks[b];

    var classMatch = block.match(/class\s*:\s*(Video\/Source|Audio\/Source|Audio\/Sink)\b/i);
    if (!classMatch) continue;
    var isVideo = /^video/i.test(classMatch[1]);
    var isSink = /sink$/i.test(classMatch[1]);
    var kind = isVideo ? 'videoinput' : (isSink ? 'audiooutput' : 'audioinput');

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

    var launch = _parseLaunchLine(block);

    // Caps span from "caps:" until the next top-level key.
    var capsStart = block.search(/\bcaps\s*:/);
    if (capsStart < 0 && !isSink) continue;
    var afterCaps = capsStart < 0 ? '' : block.substring(capsStart);
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

    // An output's caps are irrelevant to enumerateDevices; inputs
    // without a parseable mode cannot be opened sensibly.
    if (!modes.length && !isSink) continue;

    devices.push({
      kind:     kind,
      deviceId: deviceId,
      label:    label,
      modes:    modes,
      launch:   launch,
    });
  }
  return devices;
}

/**
 * The source part of the device's "gst-launch-1.0 <element> p=v ... ! ..."
 * line, as { element, props: [[name, value], ...] }. Values are kept
 * exactly as printed (gst_value_serialize form: quoted and escaped when
 * needed, octal escapes included), i.e. already in gst-launch syntax, so
 * they are passed through verbatim. null when absent or a sink.
 */
function _parseLaunchLine(block) {
  var m = block.match(/gst-launch-1\.0\s+([^\n]*)/);
  if (!m) return null;
  var line = m[1];
  var tokens = [];
  var cur = '', inQ = false;
  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (ch === '\\' && i + 1 < line.length) { cur += ch + line[i + 1]; i++; continue; }
    if (ch === '"') { inQ = !inQ; cur += ch; continue; }
    if (!inQ && (ch === ' ' || ch === '\t')) {
      if (cur) { tokens.push(cur); cur = ''; }
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  var end = tokens.indexOf('!');
  if (end >= 0) tokens = tokens.slice(0, end);
  if (!tokens.length || !/^[A-Za-z][\w-]*$/.test(tokens[0])) return null;
  if (/sink$/i.test(tokens[0])) return null;
  var props = [];
  for (var t = 1; t < tokens.length; t++) {
    var eq = tokens[t].indexOf('=');
    if (eq <= 0) continue;
    props.push([tokens[t].slice(0, eq), tokens[t].slice(eq + 1)]);
  }
  return { element: tokens[0], props: props };
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
 * devices of the requested kind: no hint → the first device; a hint →
 * that deviceId (or a label containing it), else null. It used to fall
 * back to the first device for an unknown hint too, which would now open
 * a different camera than the one asked for.
 */
function _findDevice(devices, kind, deviceHint) {
  var i;
  for (i = 0; i < devices.length; i++) {
    if (devices[i].kind !== kind) continue;
    if (!deviceHint) return devices[i];
    if (devices[i].deviceId === deviceHint) return devices[i];
  }
  if (!deviceHint) return null;
  for (i = 0; i < devices.length; i++) {
    if (devices[i].kind === kind && devices[i].label.indexOf(deviceHint) >= 0) return devices[i];
  }
  return null;
}

/**
 * Public probe API. Use this from get_user_media.js's enumerateDevices
 * or anywhere else that needs the full device list with capabilities.
 * Returns a Promise<DeviceInfo[]> (see _probeDevices for caching).
 */
GStreamerProcess.probeAllDevices = function (gstPath) {
  return _probeAllDevices(gstPath || 'gst-launch-1.0');
};

/** Promise<{ ok, devices }> — like probeAllDevices, plus whether the probe ran. */
GStreamerProcess.probeDevices = function (gstPath) {
  return _probeDevices(gstPath || 'gst-launch-1.0');
};

GStreamerProcess.capabilitiesFromModes = capabilitiesFromModes;
GStreamerProcess.findDevice = _findDevice;
GStreamerProcess.i420Layout = i420Layout;
GStreamerProcess.repackI420 = repackI420;

export default GStreamerProcess;
