/**
 * ImageDecoder — Decode images to VideoFrames.
 * Supports JPEG, PNG, WebP, GIF, BMP, AVIF.
 * Mirrors browser ImageDecoder API (subset).
 */

import { execFileSync } from 'node:child_process';
import VideoFrame from './video_frame.js';

/**
 * @param {object} init
 * @param {Buffer} init.data — image bytes
 * @param {string} init.type — MIME type ('image/jpeg', 'image/png', etc.)
 */
function ImageDecoder(init) {
  if (!init || !init.data) throw new TypeError('ImageDecoder: data required');
  this._data = init.data;
  this._type = init.type || 'image/jpeg';
  this._frames = null;
  this._tracks = null;
}

/**
 * Decode image and return VideoFrames.
 * For animated GIF/WebP, returns multiple frames.
 *
 * @param {object} [options] — { frameIndex: 0, completeFramesOnly: true }
 * @returns {{ image: VideoFrame, complete: boolean }}
 */
ImageDecoder.prototype.decode = function (options) {
  var idx = (options && typeof options.frameIndex === 'number') ? options.frameIndex : 0;

  if (!this._frames) this._decodeAll();

  if (idx >= this._frames.length) {
    throw new RangeError('ImageDecoder: frameIndex ' + idx + ' out of range (0-' + (this._frames.length - 1) + ')');
  }

  return { image: this._frames[idx], complete: true };
};

Object.defineProperty(ImageDecoder.prototype, 'tracks', {
  get: function () {
    if (!this._tracks) this._decodeAll();
    return this._tracks;
  },
});

ImageDecoder.prototype.close = function () {
  if (this._frames) {
    for (var i = 0; i < this._frames.length; i++) {
      this._frames[i].close();
    }
  }
  this._frames = null;
  this._data = null;
};

ImageDecoder.prototype._decodeAll = function () {
  // Use FFmpeg to decode image to raw I420
  // First pass: get dimensions
  var info = _probeImage(this._data);
  if (!info) throw new Error('ImageDecoder: failed to decode image');

  var w = info.width;
  var h = info.height;
  var frameCount = info.frameCount || 1;

  // Decode to raw I420
  var raw;
  try {
    raw = execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', _mimeToFormat(this._type),
      '-i', 'pipe:0',
      '-pix_fmt', 'yuv420p',
      '-f', 'rawvideo',
      'pipe:1',
    ], {
      input: this._data,
      maxBuffer: w * h * 4 * frameCount,  // generous buffer
      timeout: 10000,
    });
  } catch (e) {
    throw new Error('ImageDecoder: FFmpeg decode failed: ' + (e.stderr || e.message));
  }

  var frameSize = ((w * h * 3) >> 1);
  this._frames = [];

  for (var i = 0; i < frameCount; i++) {
    var offset = i * frameSize;
    if (offset + frameSize > raw.length) break;
    var frameBuf = Buffer.from(raw.subarray(offset, offset + frameSize));
    this._frames.push(new VideoFrame({
      data: frameBuf,
      format: 'I420',
      codedWidth: w,
      codedHeight: h,
      timestamp: i * 33333,  // ~30fps for animated
    }));
  }

  this._tracks = {
    selectedTrack: {
      frameCount: this._frames.length,
      animated: this._frames.length > 1,
    },
  };
};

/**
 * Probe image dimensions using FFmpeg.
 */
function _probeImage(data) {
  try {
    var out = execFileSync('ffprobe', [
      '-hide_banner', '-loglevel', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,nb_frames',
      '-of', 'csv=p=0',
      '-f', 'image2pipe',
      '-i', 'pipe:0',
    ], {
      input: data,
      encoding: 'utf8',
      timeout: 5000,
    }).trim();

    var parts = out.split(',');
    var w = parseInt(parts[0], 10);
    var h = parseInt(parts[1], 10);
    var fc = parseInt(parts[2], 10) || 1;

    if (w > 0 && h > 0) {
      // Ensure even dimensions for I420
      w = w + (w % 2);
      h = h + (h % 2);
      return { width: w, height: h, frameCount: fc };
    }
  } catch (e) {}
  return null;
}

function _mimeToFormat(mime) {
  if (!mime) return 'image2pipe';
  var m = String(mime).toLowerCase();
  if (m.indexOf('gif') >= 0) return 'gif';
  if (m.indexOf('webp') >= 0) return 'webp_pipe';
  if (m.indexOf('png') >= 0) return 'png_pipe';
  if (m.indexOf('jpeg') >= 0 || m.indexOf('jpg') >= 0) return 'mjpeg';
  if (m.indexOf('bmp') >= 0) return 'bmp_pipe';
  if (m.indexOf('avif') >= 0) return 'avif';
  return 'image2pipe';
}

/**
 * Check if a MIME type is supported.
 */
ImageDecoder.isTypeSupported = function (type) {
  var supported = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/avif'];
  return supported.indexOf(String(type).toLowerCase()) >= 0;
};

export default ImageDecoder;
