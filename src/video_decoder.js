/**
 * VideoDecoder — WebCodecs-compatible video decoder.
 * Validates input chunks, uses FrameQueue, single-write IVF headers.
 */

import { initCoder, configureCoder, applyCoderPrototype } from './base_coder.js';
import { normalizeCodec } from './codec_strings.js';
import FrameQueue from './frame_queue.js';
import VideoFrame from './video_frame.js';
import { getDefaultContainer, getContainer, getContainerFormat } from './containers.js';

function VideoDecoder(init) {
  if (!init) throw new TypeError('VideoDecoder: init required');
  initCoder(this, init);
  this._headerSent = false;
  this._frameIndex = 0;
  this._decodeIndex = 0;
  this._fq = null;
  this._bytesPerFrame = 0;

  this.context = {
    state: 'unconfigured',
    codec: null,
    width: 0, height: 0,
    frameCount: 0,
  };
}

applyCoderPrototype(VideoDecoder);

VideoDecoder.prototype.configure = function (config) {
  if (!config || !config.codec) throw new TypeError('VideoDecoder.configure: codec required');

  var w = config.codedWidth || config.width;
  var h = config.codedHeight || config.height;
  if (!w || !h) throw new TypeError('VideoDecoder.configure: codedWidth and codedHeight required');

  configureCoder(this);

  this._config = {
    codec: normalizeCodec(config.codec),
    width: w,
    height: h,
    framerate: config.framerate || 30,
    description: config.description || null,
    loglevel: config.loglevel || 'error',
    probesize: config.probesize || 1048576,
  };

  this._headerSent = false;
  this._descriptionSent = false;
  this._frameIndex = 0;
  this._decodeIndex = 0;
  this._bytesPerFrame = ((w * h * 3) >> 1);
  this._fq = null;

  this.context.state = 'configured';
  this.context.codec = this._config.codec;
  this.context.width = w;
  this.context.height = h;
  this.context.frameCount = 0;
};

VideoDecoder.prototype.decode = function (chunk) {
  if (this._state !== 'configured') {
    this._error(new Error('VideoDecoder: not configured'));
    return;
  }
  if (!chunk || !chunk.data || !chunk.data.length) {
    this._error(new Error('VideoDecoder.decode: chunk.data required'));
    return;
  }

  if (!this._ffmpeg.running) this._startFFmpeg();

  var containerName = getDefaultContainer(this._config.codec);

  if (containerName === 'ivf') {
    var ivfData;
    if (!this._headerSent) {
      // File header (32) + frame header (12) + payload — single write
      var fileHdr = this._buildIvfFileHeader();
      ivfData = Buffer.allocUnsafe(32 + 12 + chunk.data.length);
      fileHdr.copy(ivfData, 0);
      _writeIvfFrameAt(ivfData, 32, chunk.data.length, this._decodeIndex++);
      chunk.data.copy(ivfData, 44);
      this._headerSent = true;
    } else {
      // Frame header (12) + payload — single write
      ivfData = Buffer.allocUnsafe(12 + chunk.data.length);
      _writeIvfFrameAt(ivfData, 0, chunk.data.length, this._decodeIndex++);
      chunk.data.copy(ivfData, 12);
    }
    this._queueSize++;
    this._ffmpeg.write(ivfData);
  } else {
    // AnnexB (H.264/H.265) or other containers
    // Prepend description (SPS/PPS) before first keyframe if provided
    if (!this._descriptionSent && this._config.description && chunk.type === 'key') {
      var desc = this._config.description;
      var combined = Buffer.allocUnsafe(desc.length + chunk.data.length);
      desc.copy(combined, 0);
      chunk.data.copy(combined, desc.length);
      this._queueSize++;
      this._ffmpeg.write(combined);
      this._descriptionSent = true;
    } else {
      this._queueSize++;
      this._ffmpeg.write(chunk.data);
    }
  }
};

VideoDecoder.prototype._startFFmpeg = function () {
  var self = this;
  var cfg = this._config;
  var containerName = getDefaultContainer(cfg.codec);
  var containerDef = getContainer(containerName);

  var args = [
    '-hide_banner', '-loglevel', cfg.loglevel || 'error', '-threads', '1',
    '-probesize', String(cfg.probesize || 1048576), '-analyzeduration', '500000',
    '-fflags', 'nobuffer', '-flags', 'low_delay',
  ];

  var fmt = containerDef ? getContainerFormat(containerDef, cfg.codec) : null;
  if (fmt) args.push('-f', fmt);
  args.push('-i', 'pipe:0');

  // Use -vsync 0 as fallback for older FFmpeg (< 5.1 doesn't have -fps_mode)
  args.push('-an', '-pix_fmt', 'yuv420p', '-f', 'rawvideo', 'pipe:3');

  self._ffmpeg.start(args, ['pipe', 'inherit', 'pipe', 'pipe']);

  self._fq = new FrameQueue(self._bytesPerFrame, function (frameBuf) {
    var vf = new VideoFrame({
      data: frameBuf,
      format: 'I420',
      codedWidth: cfg.width,
      codedHeight: cfg.height,
      timestamp: Math.round((self._frameIndex * 1e6) / (cfg.framerate || 30)),
    });
    self._frameIndex++;
    self.context.frameCount = self._frameIndex;
    self._output(vf);
  });

  self._ffmpeg.on('data', function (chunk) { self._fq.push(chunk); });
  self._ffmpeg.on('error', function (e) { self._error(e); });
};

VideoDecoder.prototype._buildIvfFileHeader = function () {
  var cfg = this._config;
  var fourcc = 'VP90';
  if (cfg.codec === 'vp8') fourcc = 'VP80';
  else if (cfg.codec === 'av1') fourcc = 'AV01';

  var b = Buffer.allocUnsafe(32);
  b.write('DKIF', 0, 4, 'ascii');
  b.writeUInt16LE(0, 4);
  b.writeUInt16LE(32, 6);
  b.write(fourcc, 8, 4, 'ascii');
  b.writeUInt16LE(cfg.width, 12);
  b.writeUInt16LE(cfg.height, 14);
  b.writeUInt32LE(cfg.framerate || 30, 16);
  b.writeUInt32LE(1, 20);
  b.writeUInt32LE(0, 24);
  b.writeUInt32LE(0, 28);
  return b;
};

/**
 * Write IVF frame header directly into buffer at offset.
 * Avoids allocating a separate 12-byte buffer.
 */
function _writeIvfFrameAt(buf, offset, size, pts) {
  buf.writeUInt32LE(size, offset);
  var bi = BigInt(pts);
  buf.writeUInt32LE(Number(bi & 0xFFFFFFFFn), offset + 4);
  buf.writeUInt32LE(Number((bi >> 32n) & 0xFFFFFFFFn), offset + 8);
}

VideoDecoder.isConfigSupported = function (config) {
  return Promise.resolve({ supported: !!getDefaultContainer(config.codec) });
};

export default VideoDecoder;
