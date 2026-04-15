/**
 * ffmpeg_process — Internal FFmpeg child process manager.
 *
 * Features:
 *  - FFmpeg presence detection with clear error message
 *  - stderr parsing → events (progress, warnings, errors)
 *  - EPIPE handling (normal when FFmpeg closes)
 *  - Listener cleanup on stop/restart (no leaks)
 *  - Graceful shutdown (SIGTERM then SIGKILL)
 */

import { spawn, execSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

var _resolvedPath = null;    // cached resolved FFmpeg path
var _resolveChecked = false;

/**
 * Resolve the FFmpeg binary path. Priority:
 *   1. Explicit path (user-provided)
 *   2. 'ffmpeg' in system PATH
 *   3. ffmpeg-static npm package
 *   4. @ffmpeg-installer/ffmpeg npm package
 *
 * Caches result after first call.
 * @param {string} [explicit] — user-provided path
 * @returns {string|null}
 */
function resolveFFmpegPath(explicit) {
  if (explicit && explicit !== 'ffmpeg') {
    // User provided a specific path — validate it
    if (_isExecutable(explicit)) return explicit;
    return null;
  }
  if (_resolveChecked) return _resolvedPath;
  _resolveChecked = true;

  // 1. System PATH
  if (_isExecutable('ffmpeg')) {
    _resolvedPath = 'ffmpeg';
    return _resolvedPath;
  }

  // 2. ffmpeg-static
  var staticPath = _tryRequire('ffmpeg-static');
  if (staticPath && typeof staticPath === 'string' && _isExecutable(staticPath)) {
    _resolvedPath = staticPath;
    return _resolvedPath;
  }

  // 3. @ffmpeg-installer/ffmpeg
  var installer = _tryRequire('@ffmpeg-installer/ffmpeg');
  if (installer && installer.path && _isExecutable(installer.path)) {
    _resolvedPath = installer.path;
    return _resolvedPath;
  }

  _resolvedPath = null;
  return null;
}

/**
 * Check if FFmpeg is available. Convenience wrapper around resolveFFmpegPath.
 * @param {string} [ffmpegPath]
 * @returns {boolean}
 */
function checkFFmpeg(ffmpegPath) {
  return !!resolveFFmpegPath(ffmpegPath);
}

/** Test if a binary is executable. */
function _isExecutable(bin) {
  try {
    execSync('"' + bin + '" -version', { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch (e) {
    return false;
  }
}

/** Try to require a package, return null if not installed. */
function _tryRequire(pkg) {
  try {
    var req = createRequire(import.meta.url);
    return req(pkg);
  } catch (e) {
    return null;
  }
}

function FFmpegProcess(opts) {
  if (!opts) opts = {};
  this._ee = new EventEmitter();
  this._proc = null;
  this._started = false;
  this._ffmpegPath = opts.ffmpegPath || resolveFFmpegPath() || 'ffmpeg';
  this._handlers = [];
  this._stderrBuf = '';
}

FFmpegProcess.prototype.on = function (ev, fn) { this._ee.on(ev, fn); };
FFmpegProcess.prototype.off = function (ev, fn) { this._ee.off(ev, fn); };
FFmpegProcess.prototype.removeAllListeners = function (ev) { this._ee.removeAllListeners(ev); };

/**
 * Start FFmpeg with given args and stdio config.
 * Throws if FFmpeg is not found.
 */
FFmpegProcess.prototype.start = function (args, stdio) {
  if (this._started) this.stop();

  // Re-resolve in case user installed ffmpeg-static after first check
  var resolvedPath = resolveFFmpegPath(this._ffmpegPath);
  if (!resolvedPath) {
    this._ee.emit('error', new Error(
      'FFmpeg not found. Install it using one of these methods:\n' +
      '  npm install ffmpeg-static              (auto-download, recommended)\n' +
      '  npm install @ffmpeg-installer/ffmpeg    (auto-download, alternative)\n' +
      '  Windows: https://www.gyan.dev/ffmpeg/builds/\n' +
      '  Linux:   sudo apt install ffmpeg\n' +
      '  macOS:   brew install ffmpeg'
    ));
    return null;
  }
  this._ffmpegPath = resolvedPath;

  var self = this;
  var proc = spawn(this._ffmpegPath, args, { stdio: stdio });
  this._proc = proc;
  this._started = true;
  this._handlers = [];
  this._stderrBuf = '';

  function track(target, ev, fn) {
    target.on(ev, fn);
    self._handlers.push({ target: target, ev: ev, fn: fn });
  }

  track(proc, 'error', function (e) {
    self._ee.emit('error', new Error('FFmpeg process error: ' + (e.message || e)));
  });

  track(proc, 'close', function (code) {
    self._detachAll();
    self._ee.emit('close', code);
  });

  // Catch all stdin write errors — PERMANENT handler, not tracked.
  // Must survive _detachAll() because pending writes can fail after stop().
  if (proc.stdin) {
    proc.stdin.on('error', function () {
      // Silently ignore — EPIPE (Unix), EOF (Windows), etc.
    });
  }

  // pipe:3 output
  if (proc.stdio[3]) {
    track(proc.stdio[3], 'data', function (chunk) {
      self._ee.emit('data', chunk);
    });
    // PERMANENT — must survive _detachAll() in close handler
    proc.stdio[3].on('end', function () {
      self._ee.emit('output_end');
    });
  }

  // stdout if piped
  if (proc.stdout && stdio[1] === 'pipe') {
    track(proc.stdout, 'data', function (chunk) {
      self._ee.emit('stdout', chunk);
    });
    proc.stdout.on('end', function () {
      self._ee.emit('stdout_end');
    });
  }

  // stderr parsing → events
  if (proc.stderr && stdio[2] === 'pipe') {
    track(proc.stderr, 'data', function (chunk) {
      self._parseStderr(chunk.toString());
    });
  }

  return proc;
};

/**
 * Parse FFmpeg stderr output into structured events.
 */
FFmpegProcess.prototype._parseStderr = function (text) {
  this._stderrBuf += text;
  var lines = this._stderrBuf.split('\n');
  this._stderrBuf = lines.pop();  // keep incomplete last line

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;

    // Progress line: frame=  120 fps= 30 q=28.0 size=     256kB time=00:00:04.00
    if (line.indexOf('frame=') === 0 || line.indexOf('size=') >= 0) {
      this._ee.emit('progress', line);
    }
    // Error/warning
    else if (line.indexOf('Error') >= 0 || line.indexOf('error') >= 0) {
      this._ee.emit('ffmpeg:error', line);
    }
    else if (line.indexOf('Warning') >= 0 || line.indexOf('warning') >= 0) {
      this._ee.emit('ffmpeg:warning', line);
    }
    // Everything else
    else {
      this._ee.emit('ffmpeg:log', line);
    }
  }
};

FFmpegProcess.prototype.write = function (data) {
  if (!this._proc || !this._started) return false;
  if (!this._proc.stdin || !this._proc.stdin.writable) return false;
  try {
    return this._proc.stdin.write(data);
  } catch (e) {
    return false;  // process died between check and write
  }
};

FFmpegProcess.prototype.writeTo = function (pipeIndex, data) {
  if (!this._proc || !this._started) return false;
  var stream = this._proc.stdio[pipeIndex];
  if (!stream || !stream.writable) return false;
  try {
    return stream.write(data);
  } catch (e) {
    return false;
  }
};

FFmpegProcess.prototype.onDrain = function (cb) {
  if (this._proc && this._proc.stdin) this._proc.stdin.once('drain', cb);
};

FFmpegProcess.prototype.onDrainPipe = function (pipeIndex, cb) {
  if (this._proc && this._proc.stdio[pipeIndex]) {
    this._proc.stdio[pipeIndex].once('drain', cb);
  }
};

FFmpegProcess.prototype.pauseOutput = function () {
  if (this._proc && this._proc.stdio[3]) {
    try { this._proc.stdio[3].pause(); } catch (e) {}
  }
};

FFmpegProcess.prototype.resumeOutput = function () {
  if (this._proc && this._proc.stdio[3]) {
    try { this._proc.stdio[3].resume(); } catch (e) {}
  }
};

/**
 * End stdin without killing the process.
 * FFmpeg will finish processing and exit on its own.
 */
FFmpegProcess.prototype.endInput = function () {
  if (this._proc && this._proc.stdin && this._proc.stdin.writable) {
    this._proc.stdin.end();
  }
};

FFmpegProcess.prototype._detachAll = function () {
  for (var i = 0; i < this._handlers.length; i++) {
    var h = this._handlers[i];
    try { h.target.removeListener(h.ev, h.fn); } catch (e) {}
  }
  this._handlers = [];
  this._started = false;
};

FFmpegProcess.prototype.stop = function () {
  if (!this._proc) return;
  this._detachAll();
  try { if (this._proc.stdin) this._proc.stdin.end(); } catch (e) {}
  try { this._proc.kill('SIGTERM'); } catch (e) {}
  // Force kill after 2 seconds if still alive
  var proc = this._proc;
  setTimeout(function () {
    try { proc.kill('SIGKILL'); } catch (e) {}
  }, 2000);
  this._proc = null;
};

Object.defineProperty(FFmpegProcess.prototype, 'running', {
  get: function () { return this._started; },
});

Object.defineProperty(FFmpegProcess.prototype, 'process', {
  get: function () { return this._proc; },
});

/** Pause reading from output pipes (backpressure). */
FFmpegProcess.prototype.pauseOutput = function () {
  if (!this._proc) return;
  if (this._proc.stdio && this._proc.stdio[3]) this._proc.stdio[3].pause();
  if (this._proc.stdout) this._proc.stdout.pause();
};

/** Resume reading from output pipes. */
FFmpegProcess.prototype.resumeOutput = function () {
  if (!this._proc) return;
  if (this._proc.stdio && this._proc.stdio[3]) this._proc.stdio[3].resume();
  if (this._proc.stdout) this._proc.stdout.resume();
};

export default FFmpegProcess;
export { checkFFmpeg, resolveFFmpegPath };
