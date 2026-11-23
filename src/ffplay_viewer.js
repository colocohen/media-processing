/**
 * ffplay_viewer.js — display a live MediaStreamTrack in an ffplay window.
 *
 * Pipes decoded VideoFrames as raw yuv420p to ffplay's stdin. Useful for
 * debugging WebRTC receive pipelines: see exactly what frames the node
 * obtains after RTP → depacketize → VideoDecoder.
 *
 * Usage:
 *   import { startFfplayViewer } from 'media-processing/ffplay_viewer.js';
 *
 *   peer.on('stream', (stream) => {
 *     const track  = stream.getVideoTracks()[0];
 *     if (!track) return;
 *     const viewer = startFfplayViewer(track, { title: 'browser cam' });
 *     track.on('ended', () => viewer.stop());
 *   });
 *
 * Returns a controller object: { stop(), pid, _proc }. Call stop() to
 * close the ffplay window; otherwise ffplay exits when the track ends
 * (its stdin closes). The viewer auto-spawns ffplay on the first frame
 * — knowing dimensions upfront isn't required, and zero-frame tracks
 * don't pay the cost of a stalled ffplay process.
 *
 * Notes:
 *   - ffplay must be in PATH. If not, supply { ffplayPath: '/path/...' }.
 *   - Only I420 / yuv420p VideoFrames are supported (the format produced
 *     by our FFmpeg-backed VideoDecoder for VP8/VP9/H264). If the first
 *     frame's format is anything else, the viewer logs a warning and
 *     stops itself; the track continues unaffected.
 *   - Resolution change mid-stream restarts ffplay automatically (kill
 *     + respawn). Frames during the gap are dropped.
 */

import { spawn } from 'node:child_process';
import { MediaStreamTrackProcessor } from './track_processor.js';
import { frameByteSize } from './core/frame_size.js';

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * @param {MediaStreamTrack} track  must be a video track
 * @param {object} [opts]
 * @param {string} [opts.title]         window title (default 'incoming video')
 * @param {string} [opts.ffplayPath]    path to ffplay binary (default 'ffplay')
 * @param {number} [opts.framerate]     hint for ffplay's pacing (default 30)
 * @param {boolean} [opts.autoclose]    close viewer when track ends (default true)
 * @param {function} [opts.onError]     called on spawn error / pipe error
 * @returns {{ stop: function(): void, pid: ?number, _proc: ?ChildProcess }}
 */
export function startFfplayViewer(track, opts) {
  if (!track || track.kind !== 'video') {
    throw new TypeError('startFfplayViewer: video MediaStreamTrack required');
  }
  opts = opts || {};

  // Display frame rate — frames arrive at the source rate (typically 30fps)
  // but we sample at displayFps for ffplay. This is a debug viewer; visual
  // smoothness < CPU/GC headroom. The sampler is the ONLY thing that gives
  // us back-pressure relief without allocating: untaken frames close()
  // immediately and don't traverse copyTo or stdin.write.
  //
  // Default: 10 fps. The visual difference between 10fps and 30fps for a
  // debug window is negligible; the difference in CPU/GC/pipe pressure is
  // dramatic (3x fewer 115KB writes/sec, 3x fewer Buffer allocations).
  var displayFps      = opts.displayFps || 10;
  var minIntervalMs   = Math.max(1, Math.round(1000 / displayFps));
  var lastSampledAt   = 0;
  // Stash the resolved value so _spawnFfplay (which lives in module scope
  // and only has `opts`, not our closure's local `displayFps`) can use it
  // for the ffplay -framerate hint.
  opts._resolvedDisplayFps = displayFps;

  var state = {
    proc:           null,    // current ffplay process (null before first frame)
    width:          0,
    height:         0,
    stopped:        false,
    framesWritten:  0,
    framesDropped:  0,
    framesBackpressured: 0,  // stdin.write returned false (pipe buffer full)
    framesCopyToErr:     0,
    framesSkipped:   0,      // skipped by the displayFps throttle
    pipeFull:        false,  // true between write→false and stdin 'drain' event
    lastFrameAt:    0,
    onError:        opts.onError || function () {},
    diagInterval:   null,
    reader:         null,
    track:          track,
    endedEvent:     null,    // the track event autoclose listens to …
    endedFn:        null,    // … and its listener, removed by stop()
  };

  var processor = new MediaStreamTrackProcessor({ track: track });
  var reader    = processor.readable.getReader();
  state.reader  = reader;

  // Diagnostic heartbeat — logs every 5s so freezes are visible. The line
  // shape lets you see at a glance whether the pump is alive (lastFrameAt
  // recent) and whether ffplay is keeping up (backpressured count).
  // Prefixed [ffplay_viewer] so it's grep-able.
  state.diagInterval = setInterval(function () {
    if (state.stopped) return;
    var sinceLastFrame = state.lastFrameAt
      ? (Date.now() - state.lastFrameAt) + 'ms'
      : 'never';
    var procAlive = state.proc && !state.proc.killed && state.proc.exitCode == null;
    console.log('[ffplay_viewer] heartbeat — written=' + state.framesWritten +
                ' skipped=' + state.framesSkipped +
                ' dropped=' + state.framesDropped +
                ' backpressured=' + state.framesBackpressured +
                ' copyToErr=' + state.framesCopyToErr +
                ' pipeFull=' + state.pipeFull +
                ' procAlive=' + procAlive +
                ' lastFrame=' + sinceLastFrame);
  }, 5000);
  if (state.diagInterval.unref) state.diagInterval.unref();

  // Pump loop — reads VideoFrames forever, until track ends or stop() called.
  (async function pump() {
    try {
      while (!state.stopped) {
        var r = await reader.read();
        if (r.done) break;
        var frame = r.value;
        try {
          // Throttle to displayFps. Sampling at the pump's entrance is
          // critical: copyTo and stdin.write are the expensive paths, and
          // skipping them entirely (rather than dropping inside the pipe)
          // is what keeps the event loop responsive. Without this, even
          // with backpressure handling, 30 fps × 115 KB Buffer.allocUnsafe
          // allocations cause GC pauses long enough to stall the pump.
          var now = Date.now();
          if (now - lastSampledAt < minIntervalMs) {
            state.framesSkipped++;
            continue;
          }
          lastSampledAt = now;
          // Awaited: copyTo may complete asynchronously (it returns a
          // Promise, as in browsers), and the frame must stay open until
          // it has.
          await _handleFrame(state, frame, opts);
        } finally {
          // Always close the frame to release the underlying buffer —
          // VideoFrames hold native memory until close() is called.
          try { frame.close(); } catch (e) {}
        }
      }
    } catch (e) {
      state.onError(e);
    } finally {
      // Track ended or stop(): release everything (also the heartbeat
      // timer and the track listener, which used to outlive the pump).
      _stop(state);
    }
  })();

  // Graceful shutdown when track ends. (Independent of pump loop's reader.read
  // returning {done:true} — the close-on-ended path below covers the case
  // where the track was already ended before we wired up.)
  if (opts.autoclose !== false && typeof track.on === 'function') {
    // '_stopped': ended by stop() too, which fires no 'ended'.
    state.endedEvent = track._source ? '_stopped' : 'ended';
    state.endedFn = function () { _stop(state); };
    track.on(state.endedEvent, state.endedFn);
  }

  return {
    get pid()   { return state.proc ? state.proc.pid : null; },
    get _proc() { return state.proc; },
    stop:       function () { _stop(state); },
  };
}


// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function _handleFrame(state, frame, opts) {
  if (state.stopped) return;

  // Format check — only I420 / yuv420p supported.
  var fmt = frame.format;
  if (fmt && fmt !== 'I420') {
    state.onError(new Error(
      'ffplay_viewer: unsupported VideoFrame format ' + fmt +
      ' (only I420/yuv420p — wrap a converter if needed)'));
    state.stopped = true;
    return;
  }

  // What copyTo() writes is the VISIBLE rect (the whole coded frame
  // when there is no crop), so that is the size ffplay must be told.
  var vr = frame.visibleRect;
  var fw = vr && vr.width ? vr.width : frame.codedWidth;
  var fh = vr && vr.height ? vr.height : frame.codedHeight;

  // Dimension change → restart ffplay (rawvideo container is fixed-size).
  if (state.proc && (fw !== state.width || fh !== state.height)) {
    _closeFfplay(state);
  }

  // Spawn (lazy) on first frame, or after a dimension-change close.
  if (!state.proc) {
    state.width  = fw;
    state.height = fh;
    if (!state.width || !state.height) {
      state.framesDropped++;
      return;  // first frame somehow has zero dims; skip and try again
    }
    if (!_spawnFfplay(state, opts)) return;
  }

  // While ffplay is behind, drop before paying for the copy.
  if (state.pipeFull) {
    state.framesDropped++;
    state.framesBackpressured++;
    return;
  }

  // I420 with ceil(w/2) x ceil(h/2) chroma (core/frame_size.js). This
  // was (w >> 1) * (h >> 1): 65x49 needs 4835 bytes, the buffer had
  // 4721, so every odd-sized frame failed copyTo.
  var buf = new Uint8Array(frameByteSize('I420', state.width, state.height));

  // copyTo() returns a Promise (W3C; this library's too) and reports
  // errors by REJECTING it. The try/catch around a bare copyTo() caught
  // nothing, and the rejection — e.g. the 65x49 size error above —
  // crashed the process as an unhandled rejection. Handle both a
  // Promise and a synchronous implementation.
  var res;
  try {
    res = frame.copyTo(buf);
  } catch (e) {
    _copyToFailed(state, e);
    return;
  }
  if (res && typeof res.then === 'function') {
    return res.then(function () { _writeFrame(state, buf); },
                    function (e) { _copyToFailed(state, e); });
  }
  _writeFrame(state, buf);
}

function _copyToFailed(state, e) {
  state.framesCopyToErr++;
  state.framesDropped++;
  state.onError(new Error('ffplay_viewer: VideoFrame.copyTo failed: ' + (e && e.message || e)));
}

function _writeFrame(state, buf) {
  // stop() or a respawn may have happened while copyTo was pending.
  if (state.stopped || !state.proc) {
    state.framesDropped++;
    return;
  }

  // Write to ffplay stdin. write() returns false when the OS pipe buffer
  // is full. Critical: we MUST NOT let writes accumulate — if we keep
  // writing past the buffer, Node's writable.write() pushes them onto an
  // in-memory queue that grows unbounded, the V8 heap balloons, and the
  // OS-level promise of "drained" never arrives because we keep adding.
  // Worse, this back-pressures into the MediaStreamTrackProcessor's queue
  // (since the pump's await reader.read() resolves as soon as a frame is
  // available, but write() blocks the next iteration), which back-pressures
  // into the depacketizer/jitter-buffer, which manifests as the
  // NACK→PLI escalation storm and millions of "lost" packets seen in the
  // user's log (jitter buffer reports inflated expectedSeq because real
  // packets aren't being dequeued).
  //
  // For a DEBUG viewer, freshness beats completeness. So:
  //   - Track that the pipe is "full" with state.pipeFull
  //   - While full, drop new frames immediately (don't even copyTo)
  //   - Clear the flag when stdin emits 'drain'
  // This caps total queued bytes at ONE frame worth, no matter how slow
  // ffplay is, and lets the pump keep reading at full rate.
  var stdin = state.proc.stdin;
  if (!stdin || stdin.destroyed) {
    state.framesDropped++;
    return;
  }
  if (state.pipeFull) {
    // ffplay isn't keeping up — drop this frame entirely. The pump stays
    // unblocked, the receive pipeline keeps draining, NACK storms don't
    // start.
    state.framesDropped++;
    state.framesBackpressured++;
    return;
  }
  try {
    var ok = stdin.write(buf);
    state.framesWritten++;
    state.lastFrameAt = Date.now();
    if (!ok) {
      // Pipe buffer hit high-water mark. Stop sending until 'drain'.
      state.pipeFull = true;
      state.framesBackpressured++;
      stdin.once('drain', function () { state.pipeFull = false; });
    }
  } catch (e) {
    state.framesDropped++;
    state.onError(e);
  }
}

function _spawnFfplay(state, opts) {
  // libuv (Node's spawn implementation) searches PATH and tries the
  // standard Windows extensions (.exe, .cmd, .bat, .com) automatically
  // — so plain 'ffplay' resolves to ffplay.exe on Windows just like
  // typing it in cmd does. No need to force the extension.
  //
  // We previously used shell:true (to let cmd.exe handle resolution)
  // but that caused two problems:
  //   1. Node DEP0190 deprecation warning (shell-passed args aren't
  //      escaped, security risk in general).
  //   2. cmd.exe word-splits argument values containing spaces (e.g.
  //      our window title "peerId — incoming video #0"), which
  //      caused ffplay to see fragments as separate filenames and
  //      crash with "Argument 'incoming' provided as input filename".
  // Plain spawn (no shell) avoids both.
  var path = opts.ffplayPath || 'ffplay';
  // ffplay paces playback by the -framerate hint. We sample at displayFps
  // upstream, so tell ffplay the same — otherwise it thinks frames are
  // missing and inserts duplicates / waits.
  var fps  = opts.framerate || opts._resolvedDisplayFps || 10;
  var args = [
    '-loglevel',     'info',          // bumped from warning so freezes are diagnosable
    '-f',            'rawvideo',
    '-pixel_format', 'yuv420p',
    '-video_size',   state.width + 'x' + state.height,
    '-framerate',    String(fps),
    '-window_title', opts.title || 'incoming video',
    '-fflags',       'nobuffer',
    '-flags',        'low_delay',
    '-i', 'pipe:0',
  ];

  // No shell — args pass directly as argv (preserves spaces / em-dashes
  // in the title, no word-splitting).
  var spawnOpts = { stdio: ['pipe', 'inherit', 'inherit'] };

  var proc;
  try {
    proc = spawn(path, args, spawnOpts);
  } catch (e) {
    state.onError(new Error('ffplay_viewer: spawn(' + path + ') failed: ' + e.message));
    state.stopped = true;
    return false;
  }

  proc.on('error', function (err) {
    // ENOENT here means ffplay isn't on PATH. Surface a clear message —
    // this is the most common Windows / fresh-install setup issue.
    if (err && err.code === 'ENOENT') {
      state.onError(new Error(
        'ffplay_viewer: ffplay not found on PATH. Install FFmpeg ' +
        '(https://ffmpeg.org), or supply { ffplayPath: \'/full/path/to/ffplay\' }.'));
    } else {
      state.onError(new Error('ffplay_viewer: process error: ' + (err && err.message || err)));
    }
    state.stopped = true;
    if (state.proc === proc) state.proc = null;
  });
  proc.on('exit', function (code, signal) {
    // ffplay window closed by user → tear down the viewer cleanly.
    if (state.proc === proc) {
      state.proc = null;
      state.stopped = true;
    }
  });
  if (proc.stdin) {
    proc.stdin.on('error', function (err) {
      // EPIPE / EOF when ffplay window is closed mid-stream — expected,
      // swallow rather than surfacing to the user.
      if (err && err.code !== 'EPIPE' && err.code !== 'EOF') state.onError(err);
    });
  }

  state.proc = proc;
  return true;
}

function _closeFfplay(state) {
  if (!state.proc) return;
  var p = state.proc;
  state.proc = null;
  state.pipeFull = false;   // reset — next spawn starts with a fresh pipe
  try { if (p.stdin && !p.stdin.destroyed) p.stdin.end(); } catch (e) {}
  try { p.kill('SIGTERM'); } catch (e) {}
}

function _stop(state) {
  state.stopped = true;
  if (state.diagInterval) {
    clearInterval(state.diagInterval);
    state.diagInterval = null;
  }
  // Release the track. stop() used to only kill ffplay: the
  // MediaStreamTrackProcessor stayed attached (track._consumerCount()
  // stayed 1, so the source kept producing and cloning frames for
  // nobody) and the pump sat in reader.read() forever. cancel()
  // detaches the processor and ends the pending read.
  if (state.reader) {
    var r = state.reader;
    state.reader = null;
    try { r.cancel().catch(function () {}); } catch (e) {}
  }
  if (state.endedFn && state.track && typeof state.track.off === 'function') {
    state.track.off(state.endedEvent, state.endedFn);
    state.endedFn = null;
  }
  _closeFfplay(state);
}
