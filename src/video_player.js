/**
 * VideoPlayer — Display raw video via ffplay.
 * For testing and debugging. Not part of WebCodecs API.
 *
 * Usage:
 *   var player = new VideoPlayer({ width: 1280, height: 720 });
 *   player.writeFrame(videoFrame);
 *   player.stop();
 */

import { spawn } from 'node:child_process';
import EventEmitter from './core/events.js';
import { frameByteSize } from './core/frame_size.js';

function VideoPlayer(opts) {
  if (!opts) opts = {};
  this._ee = new EventEmitter();
  this._proc = null;
  this._started = false;
  this._warnedSize = false;
  this._track = null;          // track attached by play()
  this._onFrame = null;        // … and its 'frame' listener

  this.width = opts.width || 1280;
  this.height = opts.height || 720;
  this.fps = opts.fps || opts.framerate || 30;
  this.title = opts.title || 'VideoPlayer';
  this.windowWidth = opts.windowWidth || 800;
  this.windowHeight = opts.windowHeight || 450;

  // I420 with ceil chroma (core/frame_size.js); (w*h*3)>>1 floored it,
  // so every correct odd-sized frame was rejected as the wrong size.
  this._bytesPerFrame = frameByteSize('I420', this.width, this.height);
}

VideoPlayer.prototype.on = function (ev, fn) { this._ee.on(ev, fn); };
VideoPlayer.prototype.off = function (ev, fn) { this._ee.off(ev, fn); };

/**
 * Write a raw I420 frame to the player.
 * @param {VideoFrame|object} frame — { data: Buffer } with I420 data
 * @returns {boolean} false if backpressure
 */
VideoPlayer.prototype.writeFrame = function (frame) {
  if (!frame) return false;
  var buf = frame.data || frame.buffer || frame;
  if (!(buf instanceof Uint8Array)) return false;

  if (buf.length !== this._bytesPerFrame) {
    if (!this._warnedSize) {
      this._warnedSize = true;
      this._ee.emit('error', new Error(
        'VideoPlayer: buffer ' + buf.length + ' bytes != expected ' + this._bytesPerFrame
      ));
    }
    return true; // skip bad frame
  }

  this._ensureStarted();
  if (!this._proc || !this._proc.stdin || !this._proc.stdin.writable) return false;
  return this._proc.stdin.write(buf);
};

/**
 * Play a MediaStream (connects to first video track).
 * @param {MediaStream} stream
 */
VideoPlayer.prototype.play = function (stream) {
  var tracks = stream.getVideoTracks();
  if (!tracks.length) {
    this._ee.emit('error', new Error('VideoPlayer.play: no video tracks'));
    return;
  }

  var self = this;
  this._detach();   // play() again: don't feed ffplay from two tracks
  this._track = tracks[0];
  this._onFrame = function (frame) {
    self.writeFrame(frame);
  };
  this._track.on('frame', this._onFrame);
};

VideoPlayer.prototype._detach = function () {
  if (this._track && this._onFrame && typeof this._track.off === 'function') {
    this._track.off('frame', this._onFrame);
  }
  this._track = null;
  this._onFrame = null;
};

/**
 * Register drain callback (for backpressure).
 */
VideoPlayer.prototype.onDrain = function (cb) {
  if (this._proc && this._proc.stdin) {
    this._proc.stdin.once('drain', cb);
  }
};

/**
 * Stop the player.
 */
VideoPlayer.prototype.stop = function () {
  // Remove the play() listener first. It used to stay attached, so the
  // next frame after stop() went through writeFrame → _ensureStarted
  // and spawned a new ffplay (4 spawns for 5 frames in the repro), and
  // the track kept counting the player as a consumer.
  this._detach();
  try { if (this._proc && this._proc.stdin) this._proc.stdin.end(); } catch (e) {}
  try { if (this._proc) this._proc.kill('SIGKILL'); } catch (e) {}
  this._proc = null;
  this._started = false;
};

VideoPlayer.prototype._ensureStarted = function () {
  if (this._started) return;

  var args = [
    '-hide_banner', '-loglevel', 'warning',
    '-fflags', 'nobuffer', '-flags', 'low_delay',
    '-window_title', this.title,
    '-x', String(this.windowWidth),
    '-y', String(this.windowHeight),
    '-f', 'rawvideo',
    '-video_size', this.width + 'x' + this.height,
    '-pixel_format', 'yuv420p',
    '-framerate', String(this.fps),
    '-i', '-'
  ];

  var proc = spawn('ffplay', args, { stdio: ['pipe', 'inherit', 'inherit'] });
  this._proc = proc;
  this._started = true;

  var self = this;
  proc.on('error', function (e) { self._ee.emit('error', e); });
  // EPIPE when the ffplay window is closed mid-write; without a
  // listener it is thrown as an uncaught 'error' event.
  if (proc.stdin) proc.stdin.on('error', function (e) { if (e && e.code !== 'EPIPE') self._ee.emit('error', e); });
  proc.on('close', function (c) {
    self._started = false;
    self._ee.emit('close', c);
  });
};

export default VideoPlayer;
