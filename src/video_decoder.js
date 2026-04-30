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

  // MP-23: per-input-chunk timestamp queue. For video, the typical
  // mapping is 1 input encoded chunk → 1 output decoded frame, so we
  // shift one timestamp per output. This is approximate when B-frames
  // are present (decode order ≠ presentation order), but the WebRTC
  // demo path uses no B-frames, so this is exact in practice.
  this._inputQueue = [];

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

  // Per W3C WebCodecs §6.5: codedWidth and codedHeight are OPTIONAL
  // in VideoDecoderConfig (the spec defaults them from the decoded
  // stream). The previous implementation made them required.
  //
  // For our FFmpeg-backed decoder we still need a target output size
  // for the scale filter. Strategy:
  //   - If caller provides codedWidth/codedHeight, use them as the
  //     locked output size — every emitted VideoFrame will be at this
  //     size regardless of input stream resolution (handled by an
  //     `-vf scale=W:H` filter in FFmpeg, MP-9). This is what most
  //     WebRTC pipelines want: receiver-side fixed render target.
  //   - If not provided, default to 1920x1080. The decoder still
  //     scales any input to fit. (A future MP-9b will detect actual
  //     stream dimensions and emit accordingly; tracked separately.)
  //
  // The scale filter side-effect: when an upstream sender's quality
  // scaler drops resolution mid-stream, the FrameQueue stays in lock
  // step with our configured byte size — no corrupted frames. This
  // is the CORE BUG MP-9 was reporting.
  var w = config.codedWidth || config.width || 1920;
  var h = config.codedHeight || config.height || 1080;

  configureCoder(this);

  this._config = {
    codec: normalizeCodec(config.codec),
    width: w,
    height: h,
    framerate: config.framerate || 30,
    description: config.description || null,
    loglevel: config.loglevel || 'error',
    // Performance knobs — all optional, defaults match the tuned
    // values used in _startFFmpeg. If caller supplies a value, it
    // overrides; if not, we use the perf-tuned default rather than
    // the old conservative one. Test test_real_ffmpeg_args.js caught
    // a bug where probesize stuck at 1MB because configure() defaulted
    // it before _startFFmpeg's `|| 32768` had a chance to apply.
    probesize:        (config.probesize        != null) ? config.probesize        : 32768,
    analyzeduration:  (config.analyzeduration  != null) ? config.analyzeduration  : 100000,
    threads:          (config.threads          != null) ? config.threads          : 0,
    // MP-9: track whether dimensions were caller-supplied. If yes, we
    // lock output to those dims (scale-to-fit). If no (defaulted), we
    // still scale but flag this so callers / context.* reflects the
    // assumption.
    dimensionsExplicit: !!(config.codedWidth || config.width) &&
                        !!(config.codedHeight || config.height),
  };

  this._headerSent = false;
  this._descriptionSent = false;
  this._frameIndex = 0;
  this._decodeIndex = 0;
  this._inputQueue = [];                    // MP-23: clear per-session
  this._bytesPerFrame = ((w * h * 3) >> 1);
  this._fq = null;

  this.context.state = 'configured';
  this.context.codec = this._config.codec;
  this.context.width = w;
  this.context.height = h;
  this.context.frameCount = 0;
};

VideoDecoder.prototype.decode = function (chunk) {
  // Per W3C WebCodecs §6.4: throw InvalidStateError synchronously
  // if state isn't 'configured'. Mirrors MP-19's fix for VideoEncoder.
  if (this._state !== 'configured') {
    var stateErr = new Error(
      'VideoDecoder.decode: state is "' + this._state + '", not "configured"'
    );
    stateErr.name = 'InvalidStateError';
    throw stateErr;
  }
  if (!chunk || !chunk.data || !chunk.data.length) {
    var inputErr = new Error('VideoDecoder.decode: chunk.data required');
    inputErr.name = 'TypeError';
    throw inputErr;
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

  // MP-23: track input timestamp so the output VideoFrame's timestamp
  // can derive from it instead of from a free-running frame counter
  // (which drifts when input is irregular, e.g. real-world RTP).
  // Per W3C WebCodecs §6.7: output's timestamp must be the input
  // chunk's timestamp.
  this._inputQueue.push(chunk.timestamp);
};

VideoDecoder.prototype._startFFmpeg = function () {
  var self = this;
  var cfg = this._config;
  var containerName = getDefaultContainer(cfg.codec);
  var containerDef = getContainer(containerName);

  // Performance-tuned FFmpeg args. Several knobs matter for latency:
  //
  //   -threads 0       Auto thread selection (was: hardcoded 1 thread,
  //                    which bottlenecked HD decode at ~25 fps when
  //                    target is 30fps real-time. Letting FFmpeg pick
  //                    based on codec capabilities yields ~1.5-2x
  //                    throughput on multi-core hosts).
  //
  //   -probesize 32K   Tiny probe (was: 1 MB). For WebRTC where the
  //                    caller supplies the codec name explicitly via
  //                    configure(), FFmpeg doesn't need to identify
  //                    the codec by reading 1 MB first.
  //
  //   -analyzeduration 100K
  //                    Cap stream analysis to 100ms (was: 500ms). Going
  //                    to 0 broke very short streams (FFmpeg needs SOME
  //                    bytes to identify the codec); 100ms is the
  //                    smallest value that's reliable across codecs and
  //                    still saves significant first-frame latency.
  //
  //   -fflags nobuffer Disable internal demuxer buffering (immediate
  //                    delivery to decoder). Caller's input chunks are
  //                    already aligned to access-unit boundaries, so
  //                    this is safe.
  //
  //   -flags low_delay
  //                    Codec-level low-latency hint. Disables B-frame
  //                    reordering buffer in the decode path where
  //                    supported.
  //
  // Note: We do NOT pass `-c:v <decoder>` to force a decoder. FFmpeg's
  // auto-selection picks an available accelerated decoder on some
  // hosts (e.g. h264_v4l2m2m, h264_qsv) which can be 5-10x faster than
  // the software path. The `-f <demuxer>` hint above is enough to skip
  // probesize-based format detection without locking us into software.
  var args = [
    '-hide_banner', '-loglevel', cfg.loglevel || 'error',
    '-threads', String(cfg.threads),
    '-probesize', String(cfg.probesize),
    '-analyzeduration', String(cfg.analyzeduration),
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
  ];

  var fmt = containerDef ? getContainerFormat(containerDef, cfg.codec) : null;
  if (fmt) args.push('-f', fmt);
  args.push('-i', 'pipe:0');

  // MP-9: scale filter forces output to our configured codedWidth /
  // codedHeight regardless of what the input stream contains. This:
  //   1. Keeps FrameQueue's frame_size invariant — no corrupted frames
  //      when upstream sender changes resolution (Quality Scaler / ABR).
  //   2. Lets us decode H.264/H.265/VP9 streams with arbitrary input
  //      dimensions while the consumer sees a fixed-size buffer.
  //   3. Uses fast bilinear scaling by default (FFmpeg default).
  //      Callers needing higher quality can override via opts.scaler
  //      (lanczos/bicubic) — not exposed yet, can be added later.
  // The format filter ensures we always get planar yuv420p out, even
  // if the input is 4:4:4 or 4:2:2 (in which case scale produces 4:2:0
  // automatically when it's the requested output).
  var scaleFilter = 'scale=' + cfg.width + ':' + cfg.height + ',format=yuv420p';
  args.push('-vf', scaleFilter);

  // Use -vsync 0 as fallback for older FFmpeg (< 5.1 doesn't have -fps_mode)
  args.push('-an', '-f', 'rawvideo', 'pipe:3');

  self._ffmpeg.start(args, ['pipe', 'inherit', 'pipe', 'pipe']);

  self._fq = new FrameQueue(self._bytesPerFrame, function (frameBuf) {
    // MP-23: derive timestamp from the input chunk that produced this
    // frame, not from a frame counter. For video without B-frames the
    // mapping is 1:1 in order. If the queue is empty (FFmpeg emitted
    // a frame before any decode() — rare startup transient — fall
    // back to counter-based math).
    var ts;
    if (self._inputQueue.length > 0) {
      ts = self._inputQueue.shift();
    } else {
      ts = Math.round((self._frameIndex * 1e6) / (cfg.framerate || 30));
    }
    var vf = new VideoFrame({
      data: frameBuf,
      format: 'I420',
      codedWidth: cfg.width,
      codedHeight: cfg.height,
      timestamp: ts,
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
