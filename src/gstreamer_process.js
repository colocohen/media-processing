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
 * Start camera capture.
 * @param {object} opts
 * @param {number} opts.width
 * @param {number} opts.height
 * @param {number} opts.fps
 * @param {string} [opts.device] — Device path/name (platform-specific)
 * @param {string} [opts.format='I420'] — Output format
 */
GStreamerProcess.prototype.startCamera = function (opts) {
  if (this._started) this.stop();

  var w = opts.width || 1280;
  var h = opts.height || 720;
  var fps = opts.fps || 30;
  var fmt = opts.format || 'I420';

  var source = _getCameraSource(opts.device);
  var caps = 'video/x-raw,format=' + fmt + ',width=' + w + ',height=' + h + ',framerate=' + fps + '/1';

  var args = [
    '-q',
    source,
    '!', 'videoconvert', '!', 'videorate',
    '!', caps,
    '!', 'queue', 'leaky=downstream', 'max-size-buffers=1', 'max-size-time=0',
    '!', 'fdsink', 'fd=1', 'sync=false'
  ];

  var proc = spawn(this._gstPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
  this._proc = proc;
  this._started = true;

  var self = this;
  proc.on('error', function (e) {
    self._ee.emit('error', new Error('GStreamer not found or failed: ' + (e.message || e)));
  });
  proc.on('close', function (code) {
    self._started = false;
    self._ee.emit('close', code);
  });

  proc.stdout.on('data', function (chunk) {
    self._ee.emit('data', chunk);
  });

  return proc;
};

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

export default GStreamerProcess;
