/**
 * ImageDecoder — W3C WebCodecs ImageDecoder, decoding in FFmpeg.
 * https://www.w3.org/TR/webcodecs/#imagedecoder-interface
 *
 *   var dec = new ImageDecoder({ type: 'image/gif', data: bytesOrStream });
 *   await dec.tracks.ready;
 *   dec.tracks.selectedTrack.frameCount;          // 5
 *   var r = await dec.decode({ frameIndex: 3 });  // { image: VideoFrame, complete: true }
 *   r.image.close();
 *   dec.close();
 *
 * Supports JPEG, PNG (incl. APNG), WebP (incl. animated), GIF, BMP, AVIF.
 * Frames are I420 VideoFrames at the image's true size (odd sizes too).
 *
 * What this replaced (a sync, browser-incompatible subset):
 *   - decode() returned { image, complete } synchronously and handed out
 *     the SAME cached VideoFrame every time, so once the caller closed
 *     it (as it must) the next decode() returned a closed frame. It now
 *     returns a Promise of a clone().
 *   - Every animated GIF failed: ffprobe via image2pipe says
 *     nb_frames=N/A, so frameCount was 1 and execFileSync's maxBuffer
 *     (sized from it) overflowed → ENOBUFS → "FFmpeg decode failed".
 *     Frames are now counted by decoding them (ffprobe -show_frames) and
 *     the raw output is collected without a size cap.
 *   - Odd-sized images decoded to zero frames: the probe rounded 101x75
 *     up to 102x76, but FFmpeg writes 101x75 frames (with ceil chroma),
 *     so no full "frame" of the guessed size was ever found.
 *   - Timestamps were invented (i * 33333); durations, repetitionCount,
 *     tracks.ready, completed, reset(), the type check and the W3C
 *     exceptions were missing. They now come from the image.
 *   - Animated WebP failed outright: FFmpeg 8.0's webp decoder rejects
 *     ANIM/ANMF files ("image data not found"). The container is now
 *     split in JS, each frame's bitstream decoded by FFmpeg, and the
 *     frames composited per the WebP container spec.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import VideoFrame from './video_frame.js';
import { frameByteSize } from './core/frame_size.js';
import { isBufferSource } from './core/buffer_source.js';
import { takeBufferSource } from './core/take_buffer.js';
import { domException } from './core/dom_exception.js';

var FFMPEG_TIMEOUT_MS = 30000;

// MIME essence → how FFmpeg reads it. `fmt` is the demuxer (-f); null
// lets FFmpeg probe (AVIF goes through the mov demuxer that way).
var SUPPORTED = {
  'image/jpeg': { fmt: 'jpeg_pipe' },
  'image/png':  { fmt: 'png_pipe' },     // APNG detected from acTL
  'image/apng': { fmt: 'png_pipe' },
  'image/webp': { fmt: 'webp_pipe' },    // animated WebP: see _decodeAnimatedWebp
  'image/gif':  { fmt: 'gif' },
  'image/bmp':  { fmt: 'bmp_pipe' },
  'image/avif': { fmt: null },
};

// RFC 9110 token characters: a "valid image MIME type" is image/<token>
// with optional parameters.
var IMAGE_MIME_RE = /^image\/[!#$%&'*+.^_`|~0-9a-z-]+$/;

function _mimeEssence(type) {
  return String(type).split(';')[0].trim().toLowerCase();
}

function _isValidImageMime(type) {
  return typeof type === 'string' && IMAGE_MIME_RE.test(_mimeEssence(type));
}

function _deferred() {
  var d = { settled: false };
  d.promise = new Promise(function (res, rej) { d.resolve = res; d.reject = rej; });
  // The spec promises (completed, tracks.ready) are often never awaited;
  // a rejected one must not crash Node as an unhandled rejection.
  d.promise.catch(function () {});
  return d;
}

function _settle(d, ok, value) {
  if (d.settled) return;
  d.settled = true;
  if (ok) d.resolve(value); else d.reject(value);
}

function _isReadableStream(x) {
  if (typeof ReadableStream !== 'undefined' && x instanceof ReadableStream) return true;
  return !!x && typeof x.getReader === 'function';
}

// ── ImageTrack / ImageTrackList ──

function ImageTrack(list, info) {
  this._list = list;
  this.animated = info.animated;
  this.frameCount = info.frameCount;
  this.repetitionCount = info.repetitionCount;
}

Object.defineProperty(ImageTrack.prototype, 'selected', {
  get: function () { return this._list._selectedIndex === 0; },
  set: function (v) {
    var dec = this._list._decoder;
    if (dec._closed) return;
    var idx = v ? 0 : -1;
    if (idx === this._list._selectedIndex) return;
    // Spec: changing the selected track resets the decoder.
    dec.reset();
    this._list._selectedIndex = idx;
  },
  enumerable: true,
});

function ImageTrackList(decoder) {
  this._decoder = decoder;
  this._ready = _deferred();
  this._tracks = [];
  this._selectedIndex = -1;
}

Object.defineProperty(ImageTrackList.prototype, 'ready', { get: function () { return this._ready.promise; }, enumerable: true });
Object.defineProperty(ImageTrackList.prototype, 'length', { get: function () { return this._tracks.length; }, enumerable: true });
Object.defineProperty(ImageTrackList.prototype, 'selectedIndex', { get: function () { return this._selectedIndex; }, enumerable: true });
Object.defineProperty(ImageTrackList.prototype, 'selectedTrack', {
  get: function () { return this._selectedIndex < 0 ? null : this._tracks[this._selectedIndex]; },
  enumerable: true,
});

ImageTrackList.prototype._establish = function (info) {
  var t = new ImageTrack(this, info);
  this._tracks = [t];
  this[0] = t;                 // indexed getter: tracks[0]
  this._selectedIndex = 0;
  _settle(this._ready, true, undefined);
};

ImageTrackList.prototype._clear = function () {
  this._tracks = [];
  delete this[0];
  this._selectedIndex = -1;
};

// ── ImageDecoder ──

/**
 * @param {object} init — ImageDecoderInit
 * @param {string} init.type — image MIME type (required)
 * @param {BufferSource|ReadableStream} init.data — image bytes (required)
 * @param {ArrayBuffer[]} [init.transfer] — take data's buffer instead of copying
 * @param {number} [init.desiredWidth] / [init.desiredHeight] — scale (both or neither)
 */
function ImageDecoder(init) {
  if (!init || typeof init !== 'object') throw new TypeError('ImageDecoder: init required');
  if (!_isValidImageMime(init.type)) {
    throw new TypeError("ImageDecoder: type must be a valid image MIME type, got '" + init.type + "'");
  }
  if ((init.desiredWidth === undefined) !== (init.desiredHeight === undefined)) {
    throw new TypeError('ImageDecoder: desiredWidth and desiredHeight must be given together');
  }
  this._desired = null;
  if (init.desiredWidth !== undefined) {
    var dw = Math.floor(Number(init.desiredWidth)), dh = Math.floor(Number(init.desiredHeight));
    if (!(dw > 0) || !(dh > 0)) throw new TypeError('ImageDecoder: desiredWidth/desiredHeight must be positive');
    this._desired = { width: dw, height: dh };
  }

  this._type = init.type;
  this._closed = false;
  this._complete = false;
  this._completed = _deferred();
  this._tracks = new ImageTrackList(this);
  this._data = null;
  this._reader = null;
  this._info = null;          // probe result
  this._framesPromise = null; // Promise<VideoFrame[]> (cached decode)
  this._frames = null;
  this._pending = [];         // decode() deferreds, for reset()/close()

  var self = this;
  var dataReady;
  if (_isReadableStream(init.data)) {
    dataReady = this._readStream(init.data);
  } else if (isBufferSource(init.data)) {
    var bytes = takeBufferSource('ImageDecoder: data', init.data, init.transfer);
    if (bytes.length === 0) throw new TypeError('ImageDecoder: data is empty');
    this._data = bytes;
    this._complete = true;
    _settle(this._completed, true, undefined);
    dataReady = Promise.resolve();
  } else {
    throw new TypeError('ImageDecoder: data must be a BufferSource or ReadableStream');
  }

  var entry = SUPPORTED[_mimeEssence(init.type)];
  if (!entry) {
    // Spec: not a constructor throw — the decoder closes itself with
    // NotSupportedError (tracks.ready / decode() reject with it).
    queueMicrotask(function () {
      self._fatal(domException('ImageDecoder: unsupported type ' + init.type, 'NotSupportedError'));
    });
    return;
  }

  dataReady.then(function () {
    if (self._closed) return null;
    return self._probe(entry);
  }).then(function (info) {
    if (self._closed || !info) return;
    self._info = info;
    self._tracks._establish(info);
  }, function (err) {
    self._fatal(err);
  });
}

Object.defineProperty(ImageDecoder.prototype, 'type', { get: function () { return this._type; }, enumerable: true });
Object.defineProperty(ImageDecoder.prototype, 'complete', { get: function () { return this._complete; }, enumerable: true });
Object.defineProperty(ImageDecoder.prototype, 'completed', { get: function () { return this._completed.promise; }, enumerable: true });
Object.defineProperty(ImageDecoder.prototype, 'tracks', { get: function () { return this._tracks; }, enumerable: true });

/**
 * decode({ frameIndex = 0, completeFramesOnly = true }) →
 *   Promise<{ image: VideoFrame, complete: boolean }>
 *
 * The image is the caller's to close(). Frames are only ever delivered
 * complete (all data is received before decoding), so `complete` is
 * always true and completeFramesOnly makes no difference.
 */
ImageDecoder.prototype.decode = function (options) {
  if (this._closed) {
    return Promise.reject(domException('ImageDecoder: decoder is closed', 'InvalidStateError'));
  }
  var idx = 0;
  if (options && options.frameIndex !== undefined) {
    idx = Number(options.frameIndex);
    // WebIDL unsigned long: -1 becomes 4294967295, i.e. out of range.
    if (!Number.isInteger(idx) || idx < 0) {
      return Promise.reject(new RangeError('ImageDecoder: frameIndex ' + options.frameIndex + ' out of range'));
    }
  }
  var self = this;
  var d = _deferred();
  this._pending.push(d);
  var done = function (ok, v) {
    var i = self._pending.indexOf(d);
    if (i !== -1) self._pending.splice(i, 1);
    _settle(d, ok, v);
  };

  this._tracks.ready.then(function () {
    if (d.settled) return null;
    if (self._closed) throw domException('ImageDecoder: decoder is closed', 'InvalidStateError');
    if (self._tracks.selectedIndex === -1) {
      throw domException('ImageDecoder: no track selected', 'InvalidStateError');
    }
    if (idx >= self._info.frameCount) {
      throw new RangeError('ImageDecoder: frameIndex ' + idx + ' out of range (0-' + (self._info.frameCount - 1) + ')');
    }
    return self._decodeFrames();
  }).then(function (frames) {
    if (d.settled || !frames) return;
    if (self._closed) throw domException('ImageDecoder: decoder is closed', 'InvalidStateError');
    if (idx >= frames.length) {
      throw new RangeError('ImageDecoder: frameIndex ' + idx + ' out of range (0-' + (frames.length - 1) + ')');
    }
    // A clone: the caller closes it without touching our cached frame.
    done(true, { image: frames[idx].clone(), complete: true });
  }).catch(function (err) {
    if (err && err.name === 'EncodingError') self._fatal(err);
    done(false, err);
  });
  return d.promise;
};

/** reset() — abort pending decode() calls with AbortError. */
ImageDecoder.prototype.reset = function () {
  this._abortPending(domException('ImageDecoder: reset', 'AbortError'));
};

/** close() — release everything; later decode() rejects InvalidStateError. */
ImageDecoder.prototype.close = function () {
  this._fatal(domException('ImageDecoder: closed', 'AbortError'));
};

ImageDecoder.prototype._abortPending = function (err) {
  var pending = this._pending;
  this._pending = [];
  for (var i = 0; i < pending.length; i++) _settle(pending[i], false, err);
};

// Spec "Close ImageDecoder with exception".
ImageDecoder.prototype._fatal = function (err) {
  if (this._closed) return;
  this._abortPending(err);
  this._closed = true;
  _settle(this._tracks._ready, false, err);
  _settle(this._completed, false, err);
  this._tracks._clear();
  if (this._reader) {
    try { this._reader.cancel(err).catch(function () {}); } catch (e) {}
    this._reader = null;
  }
  if (this._frames) {
    for (var i = 0; i < this._frames.length; i++) this._frames[i].close();
  }
  this._frames = null;
  this._data = null;
};

ImageDecoder.prototype._readStream = function (stream) {
  var self = this;
  var reader = stream.getReader();
  this._reader = reader;
  var chunks = [];
  function pump() {
    return reader.read().then(function (r) {
      if (self._closed) return;
      if (r.done) {
        self._reader = null;
        var all = Buffer.concat(chunks);
        if (all.length === 0) throw domException('ImageDecoder: stream was empty', 'EncodingError');
        self._data = all;
        self._complete = true;
        _settle(self._completed, true, undefined);
        return;
      }
      if (!isBufferSource(r.value)) {
        throw domException('ImageDecoder: stream chunk is not a BufferSource', 'DataError');
      }
      var v = r.value instanceof ArrayBuffer ? new Uint8Array(r.value)
        : new Uint8Array(r.value.buffer, r.value.byteOffset, r.value.byteLength);
      chunks.push(Buffer.from(v));   // copy: the producer may reuse its buffer
      return pump();
    }, function (err) {
      throw domException('ImageDecoder: stream error: ' + (err && err.message || err), 'NotReadableError');
    });
  }
  return pump();
};

// ── Probe: frame count, timing, loop count ──

ImageDecoder.prototype._probe = function (entry) {
  var data = this._data;
  var fmt = entry.fmt;
  if (fmt === 'webp_pipe' && _isAnimatedWebp(data)) {
    var anim = _parseAnimatedWebp(data);
    if (!anim) return Promise.reject(domException('ImageDecoder: invalid animated WebP', 'EncodingError'));
    var t = 0;
    var timing = anim.frames.map(function (f) {
      var r = { timestamp: t * 1000, duration: f.duration * 1000 };
      t += f.duration;
      return r;
    });
    return Promise.resolve({
      kind: 'webp-anim', anim: anim, width: anim.width, height: anim.height,
      frameCount: anim.frames.length, animated: anim.frames.length > 1,
      // WebP loop count = total plays (0 = forever); spec wants repeats.
      repetitionCount: anim.loopCount === 0 ? Infinity : anim.loopCount - 1,
      timing: timing,
    });
  }
  var apng = fmt === 'png_pipe' ? _apngPlays(data) : null;
  if (apng !== null) fmt = 'apng';

  return _runFfmpeg('ffprobe', ['-hide_banner', '-v', 'error'], fmt, data, [
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:frame=best_effort_timestamp_time,duration_time',
    '-of', 'json',
  ]).then(function (res) {
    var j = null;
    try { j = JSON.parse(res.stdout.toString('utf8')); } catch (e) {}
    var st = j && j.streams && j.streams[0];
    var frames = (j && j.frames) || [];
    if (res.code !== 0 || !st || !(st.width > 0) || !(st.height > 0) || frames.length === 0) {
      throw domException('ImageDecoder: cannot decode image' +
        (res.stderr ? ': ' + res.stderr.trim().split('\n').pop() : ''), 'EncodingError');
    }
    var animated = frames.length > 1;
    var t0 = parseFloat(frames[0].best_effort_timestamp_time) || 0;
    var timing = frames.map(function (f) {
      var ts = parseFloat(f.best_effort_timestamp_time);
      var du = parseFloat(f.duration_time);
      return {
        timestamp: Number.isFinite(ts) ? Math.round((ts - t0) * 1e6) : 0,
        // A still image has no duration (FFmpeg reports its default
        // 1/25 s for image2pipe, which is not a property of the image).
        duration: animated && Number.isFinite(du) ? Math.round(du * 1e6) : null,
      };
    });
    var rep = 0;
    if (fmt === 'gif') {
      // GIF NETSCAPE2.0 loop count = extra plays; 0 = forever.
      var loops = _gifLoopCount(data);
      rep = loops === null ? 0 : (loops === 0 ? Infinity : loops);
    } else if (fmt === 'apng') {
      rep = apng === 0 ? Infinity : apng - 1;   // num_plays = total plays
    }
    return {
      kind: 'ffmpeg', fmt: fmt, width: st.width, height: st.height,
      frameCount: frames.length, animated: animated,
      repetitionCount: animated ? rep : 0, timing: timing,
    };
  });
};

// ── Decode all frames once (cached), as I420 VideoFrames ──

ImageDecoder.prototype._decodeFrames = function () {
  if (this._framesPromise) return this._framesPromise;
  var self = this;
  var info = this._info;
  var w = this._desired ? this._desired.width : info.width;
  var h = this._desired ? this._desired.height : info.height;
  var scale = this._desired ? ['-vf', 'scale=' + w + ':' + h] : [];
  var out = ['-map', '0:v:0', '-fps_mode', 'passthrough'].concat(scale,
    ['-pix_fmt', 'yuv420p', '-f', 'rawvideo', 'pipe:1']);

  var run;
  if (info.kind === 'webp-anim') {
    run = _compositeAnimatedWebp(this._data, info.anim).then(function (rgba) {
      return _runFfmpeg('ffmpeg', ['-hide_banner', '-v', 'error'], 'rawvideo', rgba,
        out, ['-pix_fmt', 'rgba', '-s', info.width + 'x' + info.height]);
    });
  } else {
    run = _runFfmpeg('ffmpeg', ['-hide_banner', '-v', 'error'], info.fmt, this._data, out);
  }

  this._framesPromise = run.then(function (res) {
    // Real size with ceil chroma: 101x75 → 7575 + 2*51*38 = 11451 bytes.
    var size = frameByteSize('I420', w, h);
    var n = Math.min(info.frameCount, Math.floor(res.stdout.length / size));
    if (res.code !== 0 || n === 0) {
      throw domException('ImageDecoder: FFmpeg decode failed' +
        (res.stderr ? ': ' + res.stderr.trim().split('\n').pop() : ''), 'EncodingError');
    }
    if (self._closed) return [];
    var frames = [];
    for (var i = 0; i < n; i++) {
      var tm = info.timing[i] || { timestamp: 0, duration: null };
      var init = {
        data: res.stdout.subarray(i * size, (i + 1) * size),
        format: 'I420',
        codedWidth: w,
        codedHeight: h,
        timestamp: tm.timestamp,
      };
      if (tm.duration !== null) init.duration = tm.duration;
      frames.push(new VideoFrame(init));
    }
    self._frames = frames;
    return frames;
  });
  return this._framesPromise;
};

/**
 * Promise<boolean>. Rejects with TypeError when `type` is not a valid
 * image MIME type (spec); was a plain boolean before.
 */
ImageDecoder.isTypeSupported = function (type) {
  if (!_isValidImageMime(type)) {
    return Promise.reject(new TypeError("ImageDecoder.isTypeSupported: '" + type + "' is not a valid image MIME type"));
  }
  return Promise.resolve(Object.prototype.hasOwnProperty.call(SUPPORTED, _mimeEssence(type)));
};

// ── FFmpeg runner ──

/**
 * Run ffmpeg/ffprobe on `input`, collecting stdout with no size cap
 * (execFileSync's maxBuffer is what killed animated GIFs). Resolves
 * { code, stdout, stderr }; never rejects. APNG needs a seekable input
 * (the apng demuxer fails on a pipe: "Function not implemented"), so it
 * goes through a temp file.
 */
function _runFfmpeg(cmd, pre, fmt, input, post, inOpts) {
  var tmpDir = null, inPath = 'pipe:0';
  if (fmt === 'apng') {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgdec-'));
    inPath = path.join(tmpDir, 'in.png');
    fs.writeFileSync(inPath, input);
  }
  var args = pre.slice();
  if (fmt) args.push('-f', fmt);
  if (inOpts) args = args.concat(inOpts);
  args.push('-i', inPath);
  args = args.concat(post);

  return new Promise(function (resolve) {
    var out = [], err = [], finished = false, child;
    function finish(code, extra) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {} }
      resolve({ code: code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') + (extra || '') });
    }
    var timer = setTimeout(function () { if (child) child.kill('SIGKILL'); }, FFMPEG_TIMEOUT_MS);
    try {
      child = spawn(cmd, args, { stdio: [tmpDir ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    } catch (e) {
      finish(-1, String(e && e.message || e));
      return;
    }
    child.stdout.on('data', function (c) { out.push(c); });
    child.stderr.on('data', function (c) { err.push(c); });
    child.on('error', function (e) { finish(-1, String(e && e.message || e)); });
    child.on('close', function (code) { finish(code === null ? -1 : code); });
    if (!tmpDir) {
      // EPIPE when FFmpeg gives up on corrupt input before reading it all.
      child.stdin.on('error', function () {});
      child.stdin.end(input);
    }
  });
}

// ── Container peeking (loop counts, animation) ──

/** GIF NETSCAPE2.0 / ANIMEXTS1.0 loop count, or null when absent. */
function _gifLoopCount(data) {
  var buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  var names = ['NETSCAPE2.0', 'ANIMEXTS1.0'];
  for (var n = 0; n < names.length; n++) {
    var i = buf.indexOf(names[n], 0, 'latin1');
    if (i > 0 && buf[i - 1] === 0x0b && buf[i + 11] === 0x03 && buf[i + 12] === 0x01) {
      return buf[i + 13] | (buf[i + 14] << 8);
    }
  }
  return null;
}

/** APNG num_plays from acTL (before the first IDAT), or null for a plain PNG. */
function _apngPlays(data) {
  var buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  var p = 8;
  while (p + 8 <= buf.length) {
    var len = buf.readUInt32BE(p);
    var type = buf.toString('latin1', p + 4, p + 8);
    if (type === 'acTL' && p + 16 <= buf.length) return buf.readUInt32BE(p + 12);
    if (type === 'IDAT' || type === 'IEND') return null;
    p += 12 + len;
  }
  return null;
}

// ── Animated WebP ──
// https://developers.google.com/speed/webp/docs/riff_container

function _u24(b, o) { return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16); }

function _webpChunks(buf, start, end) {
  var chunks = [];
  var p = start;
  while (p + 8 <= end) {
    var size = buf.readUInt32LE(p + 4);
    if (p + 8 + size > end) return null;
    chunks.push({ fourcc: buf.toString('latin1', p, p + 4), start: p, data: p + 8, size: size });
    p += 8 + size + (size & 1);
  }
  return chunks;
}

function _isAnimatedWebp(data) {
  var buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return buf.length >= 21 && buf.toString('latin1', 0, 4) === 'RIFF' &&
    buf.toString('latin1', 8, 16) === 'WEBPVP8X' && (buf[20] & 0x02) !== 0;
}

function _parseAnimatedWebp(data) {
  var buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  var end = Math.min(buf.length, 8 + buf.readUInt32LE(4));
  var chunks = _webpChunks(buf, 12, end);
  if (!chunks || !chunks.length || chunks[0].fourcc !== 'VP8X') return null;
  var x = chunks[0].data;
  var res = { width: 1 + _u24(buf, x + 4), height: 1 + _u24(buf, x + 7), loopCount: 0, frames: [] };
  for (var i = 1; i < chunks.length; i++) {
    var c = chunks[i];
    if (c.fourcc === 'ANIM' && c.size >= 6) {
      res.loopCount = buf.readUInt16LE(c.data + 4);
    } else if (c.fourcc === 'ANMF' && c.size >= 16) {
      var d = c.data;
      var sub = _webpChunks(buf, d + 16, d + c.size);
      if (!sub) return null;
      var alph = null, bits = null;
      for (var k = 0; k < sub.length; k++) {
        if (sub[k].fourcc === 'ALPH') alph = sub[k];
        else if (sub[k].fourcc === 'VP8 ' || sub[k].fourcc === 'VP8L') bits = sub[k];
      }
      if (!bits) return null;
      res.frames.push({
        x: 2 * _u24(buf, d), y: 2 * _u24(buf, d + 3),
        width: 1 + _u24(buf, d + 6), height: 1 + _u24(buf, d + 9),
        duration: _u24(buf, d + 12),
        blend: (buf[d + 15] & 0x02) === 0,      // B bit set = do not blend
        dispose: (buf[d + 15] & 0x01) !== 0,    // D bit set = dispose to background
        alph: alph, bits: bits,
      });
    }
  }
  return res.frames.length ? res : null;
}

function _riffChunk(fourcc, payload) {
  var pad = payload.length & 1;
  var b = Buffer.alloc(8 + payload.length + pad);
  b.write(fourcc, 0, 'latin1');
  b.writeUInt32LE(payload.length, 4);
  payload.copy(b, 8);
  return b;
}

/** One ANMF frame as a standalone still WebP that FFmpeg can decode. */
function _stillWebp(buf, f) {
  var parts = [];
  var bits = _riffChunk(f.bits.fourcc, buf.subarray(f.bits.data, f.bits.data + f.bits.size));
  if (f.alph && f.bits.fourcc === 'VP8 ') {
    var x = Buffer.alloc(10);
    x[0] = 0x10;                                   // alpha flag
    x.writeUIntLE(f.width - 1, 4, 3);
    x.writeUIntLE(f.height - 1, 7, 3);
    parts.push(_riffChunk('VP8X', x), _riffChunk('ALPH', buf.subarray(f.alph.data, f.alph.data + f.alph.size)));
  }
  parts.push(bits);
  var body = Buffer.concat(parts);
  var hdr = Buffer.alloc(12);
  hdr.write('RIFF', 0, 'latin1');
  hdr.writeUInt32LE(4 + body.length, 4);
  hdr.write('WEBP', 8, 'latin1');
  return Buffer.concat([hdr, body]);
}

/**
 * Decode every ANMF sub-image (one FFmpeg run over the concatenated
 * stills, each padded to the canvas so the raw output has a fixed
 * frame size), then composite them onto the canvas as the container
 * spec says: dispose-to-background clears the previous frame's rect
 * (transparent, as libwebp's WebPAnimDecoder does), then alpha-blend
 * or overwrite. Resolves the concatenated RGBA canvases.
 */
function _compositeAnimatedWebp(data, anim) {
  var buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  var CW = anim.width, CH = anim.height;
  var stills = Buffer.concat(anim.frames.map(function (f) { return _stillWebp(buf, f); }));
  return _runFfmpeg('ffmpeg', ['-hide_banner', '-v', 'error'], 'webp_pipe', stills, [
    '-fps_mode', 'passthrough',
    '-vf', 'format=rgba,pad=' + CW + ':' + CH + ':0:0:color=black@0',
    '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1',
  ]).then(function (res) {
    var fsz = CW * CH * 4;
    if (res.code !== 0 || res.stdout.length < fsz * anim.frames.length) {
      throw domException('ImageDecoder: cannot decode animated WebP' +
        (res.stderr ? ': ' + res.stderr.trim().split('\n').pop() : ''), 'EncodingError');
    }
    var canvas = new Uint8Array(fsz);            // transparent black
    var outAll = Buffer.alloc(fsz * anim.frames.length);
    var prev = null;
    for (var i = 0; i < anim.frames.length; i++) {
      var f = anim.frames[i];
      if (prev && prev.dispose) _fillRect(canvas, CW, CH, prev);
      var src = res.stdout.subarray(i * fsz, (i + 1) * fsz);   // sub-image at (0,0), stride CW
      for (var y = 0; y < f.height && f.y + y < CH; y++) {
        for (var x = 0; x < f.width && f.x + x < CW; x++) {
          var s = (y * CW + x) * 4, d = ((f.y + y) * CW + f.x + x) * 4;
          var sa = src[s + 3];
          if (!f.blend || sa === 255) {
            canvas[d] = src[s]; canvas[d + 1] = src[s + 1]; canvas[d + 2] = src[s + 2]; canvas[d + 3] = sa;
          } else if (sa !== 0) {
            // Non-premultiplied "src over dst" (libwebp BlendPixelNonPremult).
            var da = canvas[d + 3] * (255 - sa) / 255;
            var oa = sa + da;
            for (var ch = 0; ch < 3; ch++) {
              canvas[d + ch] = Math.round((src[s + ch] * sa + canvas[d + ch] * da) / oa);
            }
            canvas[d + 3] = Math.round(oa);
          }
        }
      }
      outAll.set(canvas, i * fsz);
      prev = f;
    }
    return outAll;
  });
}

function _fillRect(canvas, CW, CH, r) {
  for (var y = r.y; y < r.y + r.height && y < CH; y++) {
    canvas.fill(0, (y * CW + r.x) * 4, (y * CW + Math.min(r.x + r.width, CW)) * 4);
  }
}

export { ImageTrack, ImageTrackList };
export default ImageDecoder;
