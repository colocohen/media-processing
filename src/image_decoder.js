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
 * Frames are I420 VideoFrames at the image's true size (odd sizes too),
 * BT.601 limited range and tagged so; AVIF in its own format and colour
 * space; the EXIF orientation as the frame's rotation / flip. A
 * ReadableStream's GIF is decoded as it arrives (other types once the
 * stream ends).
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
import { isBufferSource, toUint8Array } from './core/buffer_source.js';
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
    // [EnforceRange] unsigned long: 0 is a valid value (Chrome decodes at
    // the image's size then); a negative / non-finite one a TypeError.
    var dw = Number(init.desiredWidth), dh = Number(init.desiredHeight);
    if (!Number.isFinite(dw) || !Number.isFinite(dh) || dw < 0 || dh < 0 || dw > 0xffffffff || dh > 0xffffffff) {
      throw new TypeError('ImageDecoder: desiredWidth/desiredHeight must be unsigned longs');
    }
    dw = Math.trunc(dw); dh = Math.trunc(dh);
    if (dw > 0 && dh > 0) this._desired = { width: dw, height: dh };
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
  this._chain = Promise.resolve();   // decode requests, one after another
  this._waiters = [];         // decodes waiting for more stream data
  this._probing = false;
  this._essence = _mimeEssence(init.type);

  var self = this;
  var stream = null;
  if (_isReadableStream(init.data)) {
    stream = init.data;
  } else if (isBufferSource(init.data)) {
    // Empty data is a TypeError before anything is detached (the transfer
    // happens with the copy, last).
    if (toUint8Array(init.data).length === 0) throw new TypeError('ImageDecoder: data is empty');
    var bytes = takeBufferSource('ImageDecoder: data', init.data, init.transfer);
    this._data = bytes;
    this._complete = true;
    _settle(this._completed, true, undefined);
  } else {
    throw new TypeError('ImageDecoder: data must be a BufferSource or ReadableStream');
  }

  var entry = SUPPORTED[this._essence];
  if (!entry) {
    // Spec: not a constructor throw — the decoder closes itself with
    // NotSupportedError (tracks.ready / decode() reject with it).
    queueMicrotask(function () {
      self._fatal(domException('ImageDecoder: unsupported type ' + init.type, 'NotSupportedError'));
    });
    return;
  }
  this._entry = entry;

  // W3C Fetch Stream Data Loop: the tracks are established, and frames
  // decoded, as the data comes (Establish Tracks / Update Tracks).
  if (stream) this._readStream(stream);
  else queueMicrotask(function () { self._onData(); });
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

  var run = function () {
    return self._tracks.ready.then(function () {
      if (d.settled) return false;
      if (self._closed) throw domException('ImageDecoder: decoder is closed', 'InvalidStateError');
      if (self._tracks.selectedIndex === -1) {
        throw domException('ImageDecoder: no track selected', 'InvalidStateError');
      }
      return self._whenFrame(idx, d);
    }).then(function (ok) {
      if (!ok || d.settled) return null;
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
  };
  // W3C: decode requests are control messages, run one after another.
  this._chain = this._chain.then(function () {
    run();
    return d.promise.then(function () {}, function () {});
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
  this._wake();
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
        self._data = Buffer.concat(chunks);
        self._complete = true;
        _settle(self._completed, true, undefined);
        self._onData();
        return;
      }
      // W3C Fetch Stream Data Loop: a chunk that is not a Uint8Array closes
      // the decoder with a DataError.
      if (!(r.value instanceof Uint8Array)) {
        self._fatal(domException('ImageDecoder: stream chunk is not a Uint8Array', 'DataError'));
        return;
      }
      chunks.push(Buffer.from(r.value));   // copy: the producer may reuse its buffer
      self._data = Buffer.concat(chunks);
      self._onData();
      return pump();
    }, function (err) {
      self._fatal(domException('ImageDecoder: stream error: ' + (err && err.message || err), 'NotReadableError'));
    });
  }
  pump();
};

/**
 * New data (or its end): W3C Establish Tracks / Update Tracks. The tracks
 * come once the header is in: a GIF's at once, its frames counted as
 * they arrive (a frame decodes once its data is whole); other types'
 * once the data is complete (FFmpeg probes them whole). Without enough
 * data for the header once it is complete: InvalidStateError.
 */
ImageDecoder.prototype._onData = function () {
  var self = this;
  if (this._closed || this._probing) return;
  var data = this._data || Buffer.alloc(0);
  if (!this._info) {
    var hdr = _sniffHeader(data, this._essence);
    if (!hdr) {
      if (this._complete) this._fatal(domException('ImageDecoder: cannot read the image header', 'InvalidStateError'));
      return;
    }
    if (!this._complete && this._essence !== 'image/gif') return;
    this._probing = true;
    var p = this._complete ? this._probe(this._entry, hdr) : Promise.resolve(_gifStreamInfo(data, false));
    p.then(function (info) {
      self._probing = false;
      if (self._closed || !info) return;
      self._info = info;
      self._tracks._establish(info);
      self._onData();   // what came in the meantime
    }, function (err) {
      self._probing = false;
      self._fatal(err);
    });
    return;
  }
  if (this._info.kind === 'gif-stream') {
    var next = _gifStreamInfo(data, this._complete);
    if (next) {
      this._info = next;
      var t = this._tracks._tracks[0];
      if (t) { t.frameCount = next.frameCount; t.animated = next.animated; t.repetitionCount = next.repetitionCount; }
    }
  }
  this._wake();
};

/** Re-check the decodes waiting for data. */
ImageDecoder.prototype._wake = function () {
  var w = this._waiters;
  this._waiters = [];
  for (var i = 0; i < w.length; i++) w[i]();
};

/**
 * Resolves true once frame `idx` can be decoded (W3C Decode Complete
 * Frame: wait for its data), rejects RangeError past the last frame of
 * complete data; false when the request was settled meanwhile.
 */
ImageDecoder.prototype._whenFrame = function (idx, d) {
  var self = this;
  return new Promise(function (resolve, reject) {
    (function check() {
      if (d.settled || self._closed) return resolve(false);
      var n = self._info.frameCount;
      if (idx < n) return resolve(true);
      if (self._complete) {
        return reject(new RangeError('ImageDecoder: frameIndex ' + idx + ' out of range (0-' + (n - 1) + ')'));
      }
      self._waiters.push(check);
    })();
  });
};

// ── Probe: frame count, timing, loop count ──

// A header that reads but data FFmpeg cannot decode: one track of one
// frame, whose decode() is the EncodingError (W3C: the tracks come from
// the header; Fatally Reject Bad Data when the frame is decoded). Was an
// EncodingError of tracks.ready.
function _broken(hdr, why) {
  return { kind: 'broken', width: hdr.width, height: hdr.height, frameCount: 1, animated: false,
    repetitionCount: 0, timing: [{ timestamp: 0, duration: null }], why: why };
}

ImageDecoder.prototype._probe = function (entry, hdr) {
  var data = this._data;
  var fmt = entry.fmt;
  var essence = this._essence;
  if (fmt === 'webp_pipe' && _isAnimatedWebp(data)) {
    var anim = _parseAnimatedWebp(data);
    if (!anim) return Promise.resolve(_broken(hdr, 'invalid animated WebP'));
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
      timing: timing, orientation: 1,
    });
  }
  var apng = fmt === 'png_pipe' ? _apngPlays(data) : null;
  if (apng !== null) fmt = 'apng';

  return _runFfmpeg('ffprobe', ['-hide_banner', '-v', 'error'], fmt, data, [
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,pix_fmt,color_range,color_space,color_transfer,color_primaries:frame=best_effort_timestamp_time,duration_time',
    '-of', 'json',
  ]).then(function (res) {
    var j = null;
    try { j = JSON.parse(res.stdout.toString('utf8')); } catch (e) {}
    var st = j && j.streams && j.streams[0];
    var frames = (j && j.frames) || [];
    if (res.code !== 0 || !st || !(st.width > 0) || !(st.height > 0) || frames.length === 0) {
      return _broken(hdr, 'cannot decode image' + (res.stderr ? ': ' + res.stderr.trim().split('\n').pop() : ''));
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
      // The delays as the file has them (FFmpeg's gif demuxer turns a 0
      // delay into 100 ms; Chrome reports 0): from our own block walk.
      var g = _gifWalk(data);
      if (g && g.frames.length === frames.length) timing = _gifTiming(g.frames, animated);
    } else if (fmt === 'apng') {
      rep = apng === 0 ? Infinity : apng - 1;   // num_plays = total plays
    }
    var info = {
      kind: 'ffmpeg', fmt: fmt, width: st.width, height: st.height,
      frameCount: frames.length, animated: animated,
      repetitionCount: animated ? rep : 0, timing: timing,
      orientation: _exifOrientation(data, essence),
    };
    // AVIF in its own format and colour space (W3C: the decoded image's;
    // was always I420), as Chrome gives it; the rest as before, I420.
    var own = essence === 'image/avif' && AVIF_FORMATS[st.pix_fmt];
    if (own) { info.pixFmt = st.pix_fmt; info.format = own; info.colorSpace = _avifColorSpace(data, st); }
    // an AVIF's 'irot' (quarter turns anticlockwise): the frame's rotation
    if (essence === 'image/avif') info.turn = _avifTurn(data);
    return info;
  });
};

// ── Decode all frames once (cached per data length), as I420 VideoFrames (AVIF: its own format) ──

ImageDecoder.prototype._decodeFrames = function () {
  var self = this;
  var info = this._info;
  if (info.kind === 'broken') {
    return Promise.reject(domException('ImageDecoder: ' + info.why, 'EncodingError'));
  }
  var w = this._desired ? this._desired.width : info.width;
  var h = this._desired ? this._desired.height : info.height;
  var format = info.format || 'I420';
  // The frames are tagged with the colour space their bytes are in (they
  // were tagged as the VideoFrame default, BT.709 limited, while FFmpeg
  // writes BT.601, and a JPEG's yuvj420p full range, as is): FFmpeg is
  // told to write BT.601 limited range, and the frames say so.
  var cs = info.colorSpace || { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'smpte170m', fullRange: false };
  var vf = info.format ? (this._desired ? ['-vf', 'scale=' + w + ':' + h] : [])
    : ['-vf', 'scale=' + (this._desired ? w + ':' + h + ':' : '') + 'out_color_matrix=bt601:out_range=tv'];
  var out = ['-map', '0:v:0', '-fps_mode', 'passthrough'].concat(vf,
    ['-pix_fmt', info.pixFmt || 'yuv420p', '-f', 'rawvideo', 'pipe:1']);
  var rot = info.turn || ORIENTATION[info.orientation] || ORIENTATION[1];

  var run;
  var key = (this._data ? this._data.length : 0) + (this._complete ? 'c' : '');
  if (this._framesPromise && this._framesKey === key) return this._framesPromise;
  this._framesKey = key;
  if (info.kind === 'gif-stream') {
    // Data still coming: the frames whole so far, and a trailer.
    var input = Buffer.concat([this._data.subarray(0, info.end), Buffer.from([0x3b])]);
    run = _runFfmpeg('ffmpeg', ['-hide_banner', '-v', 'error'], 'gif', input, out);
  } else if (info.kind === 'webp-anim') {
    run = _compositeAnimatedWebp(this._data, info.anim).then(function (rgba) {
      return _runFfmpeg('ffmpeg', ['-hide_banner', '-v', 'error'], 'rawvideo', rgba,
        out, ['-pix_fmt', 'rgba', '-s', info.width + 'x' + info.height]);
    });
  } else {
    // -noautorotate: FFmpeg turns an EXIF-oriented JPEG's pixels itself
    // (its width and height swapped for 5-8), which were then cut as the
    // unturned size (scrambled frames); the orientation is the frame's
    // rotation / flip instead.
    run = _runFfmpeg('ffmpeg', ['-hide_banner', '-v', 'error', '-noautorotate'], info.fmt, this._data, out);
  }

  this._framesPromise = run.then(function (res) {
    // Real size with ceil chroma: 101x75 → 7575 + 2*51*38 = 11451 bytes.
    var size = frameByteSize(format, w, h);
    var n = Math.min(info.frameCount, Math.floor(res.stdout.length / size));
    if (res.code !== 0 || n === 0) {
      throw domException('ImageDecoder: FFmpeg decode failed' +
        (res.stderr ? ': ' + res.stderr.trim().split('\n').pop() : ''), 'EncodingError');
    }
    if (self._closed) return [];
    if (self._frames) for (var k = 0; k < self._frames.length; k++) self._frames[k].close();
    var frames = [];
    for (var i = 0; i < n; i++) {
      var tm = info.timing[i] || { timestamp: 0, duration: null };
      var init = {
        data: res.stdout.subarray(i * size, (i + 1) * size),
        format: format,
        codedWidth: w,
        codedHeight: h,
        timestamp: tm.timestamp,
        colorSpace: cs,
        // EXIF orientation (JPEG APP1, PNG eXIf): the frame's rotation /
        // flip, W3C ImageDecoder output (was ignored).
        rotation: rot[0],
        flip: rot[1],
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

// ── Native header reading (what FFmpeg cannot say about partial data) ──

/**
 * The image's size from its header, or null when the header is not all
 * there (or is not of this type): W3C Establish Tracks needs "enough data
 * to determine the number of tracks"; without it once the data is
 * complete, InvalidStateError.
 */
function _sniffHeader(d, essence) {
  var b = Buffer.from(d.buffer, d.byteOffset, d.byteLength);
  var n = b.length;
  var ok = function (w, h) { return w > 0 && h > 0 ? { width: w, height: h } : null; };
  switch (essence) {
    case 'image/png': case 'image/apng':
      if (n < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.toString('latin1', 12, 16) !== 'IHDR') return null;
      return ok(b.readUInt32BE(16), b.readUInt32BE(20));
    case 'image/gif':
      if (n < 13 || !/^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return null;
      return ok(b.readUInt16LE(6), b.readUInt16LE(8));
    case 'image/bmp':
      if (n < 26 || b[0] !== 0x42 || b[1] !== 0x4d) return null;
      return ok(Math.abs(b.readInt32LE(18)), Math.abs(b.readInt32LE(22)));
    case 'image/jpeg': {
      if (n < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
      var p = 2;
      while (p + 4 <= n) {
        if (b[p] !== 0xff) return null;
        var m = b[p + 1];
        if (m === 0xff) { p++; continue; }
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { p += 2; continue; }
        var len = b.readUInt16BE(p + 2);
        if ((m >= 0xc0 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          return p + 9 <= n ? ok(b.readUInt16BE(p + 7), b.readUInt16BE(p + 5)) : null;
        }
        if (m === 0xda || m === 0xd9) return null;
        p += 2 + len;
      }
      return null;
    }
    case 'image/webp': {
      if (n < 30 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') return null;
      var cc = b.toString('latin1', 12, 16);
      if (cc === 'VP8X') return ok(1 + _u24(b, 24), 1 + _u24(b, 27));
      if (cc === 'VP8L') { var v = b.readUInt32LE(21); return ok((v & 0x3fff) + 1, ((v >>> 14) & 0x3fff) + 1); }
      if (cc === 'VP8 ') return ok(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
      return null;
    }
    case 'image/avif': {
      if (n < 12 || b.toString('latin1', 4, 8) !== 'ftyp') return null;
      var i = b.indexOf('ispe', 0, 'latin1');
      return i > 0 && i + 16 <= n ? ok(b.readUInt32BE(i + 8), b.readUInt32BE(i + 12)) : null;
    }
  }
  return null;
}

/**
 * GIF blocks as far as they have come: the loop count, each frame whole
 * so far (its graphic control extension's delay, null without one; where
 * it ends), whether the trailer was read. Null when the header is not in
 * or a block is unknown.
 */
function _gifWalk(d) {
  var b = Buffer.from(d.buffer, d.byteOffset, d.byteLength);
  if (b.length < 13 || !/^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return null;
  var p = 13 + (b[10] & 0x80 ? 3 << ((b[10] & 7) + 1) : 0);
  var res = { loops: null, frames: [], ended: false, end: p };
  var delay = null;
  function subBlocks(q) {
    for (;;) { if (q >= b.length) return -1; var k = b[q]; q += 1 + k; if (k === 0) return q <= b.length ? q : -1; }
  }
  while (p < b.length) {
    var t = b[p];
    if (t === 0x3b) { res.ended = true; break; }
    if (t === 0x00) { p++; continue; }
    if (t === 0x21) {
      if (p + 2 > b.length) break;
      var e = subBlocks(p + 2);
      if (e < 0) break;
      if (b[p + 1] === 0xf9 && b[p + 2] === 4) delay = b.readUInt16LE(p + 4);
      if (b[p + 1] === 0xff && b[p + 2] === 11 && p + 18 <= b.length &&
          /^(NETSCAPE2\.0|ANIMEXTS1\.0)$/.test(b.toString('latin1', p + 3, p + 14)) && b[p + 14] === 3 && b[p + 15] === 1) {
        res.loops = b.readUInt16LE(p + 16);
      }
      p = e;
      continue;
    }
    if (t === 0x2c) {
      if (p + 10 > b.length) break;
      var q = p + 10 + (b[p + 9] & 0x80 ? 3 << ((b[p + 9] & 7) + 1) : 0) + 1;
      var e2 = subBlocks(q);
      if (e2 < 0) break;
      res.frames.push({ delay: delay });
      delay = null;
      p = res.end = e2;
      continue;
    }
    return res.frames.length ? res : null;
  }
  return res;
}

/** Times from GIF delays (centiseconds), as Chrome: a 0 delay is 0. */
function _gifTiming(frames, animated) {
  var t = 0;
  return frames.map(function (f) {
    var du = (f.delay || 0) * 10000;
    var r = { timestamp: t, duration: animated ? du : null };
    t += du;
    return r;
  });
}

/** The track of a GIF still arriving (or complete), from its blocks. */
function _gifStreamInfo(d, complete) {
  var g = _gifWalk(d);
  if (!g) return null;
  var n = g.frames.length;
  var animated = n > 1 || (!complete && g.loops !== null);
  var rep = g.loops === null ? 0 : (g.loops === 0 ? Infinity : g.loops);
  return {
    kind: 'gif-stream', fmt: 'gif', width: b16(d, 6), height: b16(d, 8), frameCount: n, animated: animated,
    repetitionCount: animated ? rep : 0, timing: _gifTiming(g.frames, animated), end: g.end, orientation: 1,
  };
  function b16(x, o) { return x[o] | (x[o + 1] << 8); }
}

// EXIF orientation → [rotation, flip] (Chrome's: 5 and 7 are flips plus a
// rotation; the image's frame keeps its coded size).
var ORIENTATION = { 1: [0, false], 2: [0, true], 3: [180, false], 4: [180, true],
  5: [90, true], 6: [90, false], 7: [270, true], 8: [270, false] };

/** The TIFF orientation tag (IFD0 0x0112) of a JPEG's Exif APP1 or a PNG's eXIf; 1 without. */
function _exifOrientation(d, essence) {
  var b = Buffer.from(d.buffer, d.byteOffset, d.byteLength);
  var tiff = null;
  if (essence === 'image/jpeg') {
    var p = 2;
    while (p + 4 <= b.length && b[p] === 0xff) {
      var m = b[p + 1];
      if (m === 0xda || m === 0xd9) break;
      var len = b.readUInt16BE(p + 2);
      if (m === 0xe1 && b.toString('latin1', p + 4, p + 10) === 'Exif\0\0') { tiff = b.subarray(p + 10, p + 2 + len); break; }
      p += 2 + len;
    }
  } else if (essence === 'image/png' || essence === 'image/apng') {
    var q = 8;
    while (q + 8 <= b.length) {
      var l = b.readUInt32BE(q), type = b.toString('latin1', q + 4, q + 8);
      if (type === 'eXIf') { tiff = b.subarray(q + 8, q + 8 + l); break; }
      if (type === 'IDAT') break;
      q += 12 + l;
    }
  }
  if (!tiff || tiff.length < 8) return 1;
  var le = tiff[0] === 0x49;
  var u16 = function (o) { return o + 2 <= tiff.length ? (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o)) : 0; };
  var u32 = function (o) { return o + 4 <= tiff.length ? (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o)) : 0; };
  var ifd = u32(4), count = u16(ifd);
  for (var i = 0; i < count; i++) {
    var e = ifd + 2 + i * 12;
    if (u16(e) === 0x0112) { var o = u16(e + 8); return o >= 1 && o <= 8 ? o : 1; }
  }
  return 1;
}

/** An AVIF's first 'irot' property as [rotation clockwise, flip], or null ('imir' is not read). */
function _avifTurn(d) {
  var b = Buffer.from(d.buffer, d.byteOffset, d.byteLength);
  var i = b.indexOf('irot', 0, 'latin1');
  if (i < 4 || i + 5 > b.length || b.readUInt32BE(i - 4) !== 9) return null;
  return [(360 - 90 * (b[i + 4] & 3)) % 360, false];
}

// AVIF: FFmpeg's pix_fmt → the frame's own format.
var AVIF_FORMATS = {
  yuv420p: 'I420', yuv422p: 'I422', yuv444p: 'I444',
  yuv420p10le: 'I420P10', yuv422p10le: 'I422P10', yuv444p10le: 'I444P10',
  yuv420p12le: 'I420P12', yuv422p12le: 'I422P12', yuv444p12le: 'I444P12',
};

/**
 * An AVIF's colour space: its nclx 'colr' box (FFmpeg reports only the
 * range of an AVIF), CICP codes as W3C names.
 */
function _avifColorSpace(d, st) {
  var b = Buffer.from(d.buffer, d.byteOffset, d.byteLength);
  var P = { 1: 'bt709', 5: 'bt470bg', 6: 'smpte170m', 9: 'bt2020', 12: 'smpte432' };
  var T = { 1: 'bt709', 6: 'smpte170m', 8: 'linear', 13: 'iec61966-2-1', 16: 'pq', 18: 'hlg' };
  var M = { 0: 'rgb', 1: 'bt709', 5: 'bt470bg', 6: 'smpte170m', 9: 'bt2020-ncl' };
  var range = st.color_range === 'pc' ? true : (st.color_range === 'tv' ? false : null);
  var i = b.indexOf('colrnclx', 0, 'latin1');
  // without one (or unspecified codes), Chrome's defaults: sRGB, BT.601
  if (i < 0 || i + 15 > b.length) return { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'smpte170m', fullRange: range };
  return {
    primaries: P[b.readUInt16BE(i + 8)] || 'bt709', transfer: T[b.readUInt16BE(i + 10)] || 'iec61966-2-1',
    matrix: M[b.readUInt16BE(i + 12)] || 'smpte170m', fullRange: (b[i + 14] & 0x80) !== 0,
  };
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
