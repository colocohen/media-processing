/**
 * VideoDecoder — WebCodecs-compatible video decoder.
 * Validates input chunks, uses FrameQueue, single-write IVF headers.
 */

import { initCoder, configureCoder, applyCoderPrototype } from './base_coder.js';
import { normalizeCodec } from './utils/codec_strings.js';
import FrameQueue from './core/frame_queue.js';
import { writeU16LE, writeU32LE, fromAscii } from './core/bytes.js';
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

applyCoderPrototype(VideoDecoder, { role: 'decoder' });

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
  this._keyChunkRequired = true;   // reset per configure(), per spec
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
  // W3C WebCodecs §6.4 [[key chunk required]]: the first chunk after
  // configure() (and after flush()) MUST be a key chunk, else DataError.
  // Chrome enforces this. Without it a delta chunk was fed straight to
  // FFmpeg, which has no reference frame to decode against and emits
  // either nothing or visibly broken output — a silent failure exactly
  // where a loud one belongs.
  if (this._keyChunkRequired) {
    if (!chunk || chunk.type !== 'key') {
      var keyErr = new Error(
        'VideoDecoder.decode: a key chunk is required first (got ' +
        ((chunk && chunk.type) || 'no chunk') + '). Decoding cannot start ' +
        'from a delta chunk.'
      );
      keyErr.name = 'DataError';
      throw keyErr;
    }
    this._keyChunkRequired = false;
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
      ivfData = new Uint8Array(32 + 12 + chunk.data.length);
      ivfData.set(fileHdr, 0);
      _writeIvfFrameAt(ivfData, 32, chunk.data.length, this._decodeIndex++);
      ivfData.set(chunk.data, 44);
      this._headerSent = true;
    } else {
      // Frame header (12) + payload — single write
      ivfData = new Uint8Array(12 + chunk.data.length);
      _writeIvfFrameAt(ivfData, 0, chunk.data.length, this._decodeIndex++);
      ivfData.set(chunk.data, 12);
    }
    this._queueSize++;
    this._ffmpeg.write(ivfData);
  } else {
    // AnnexB (H.264/H.265) or other containers
    // Prepend description (SPS/PPS) before first keyframe if provided
    if (!this._descriptionSent && this._config.description && chunk.type === 'key') {
      var desc = this._config.description;
      var combined = new Uint8Array(desc.length + chunk.data.length);
      combined.set(desc, 0);
      combined.set(chunk.data, desc.length);
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
  //
  // Bounded. The queue drains one entry per emitted frame, which assumes
  // 1 input chunk → 1 output frame. That assumption breaks whenever
  // FFmpeg drops or merges an input (corrupt chunk, decoder error,
  // stream discontinuity), and every such event leaves one entry behind
  // permanently. On a long-running receive pipeline the queue grows
  // without bound and, worse, the timestamps drift further out of
  // alignment with the frames they're supposed to describe. Capping it
  // discards the stalest entries — which are the ones already known to
  // be unmatched — and keeps the head of the queue aligned with the
  // frames actually arriving.
  this._inputQueue.push(chunk.timestamp);
  if (this._inputQueue.length > MAX_PENDING_TIMESTAMPS) {
    var overflow = this._inputQueue.length - MAX_PENDING_TIMESTAMPS;
    this._inputQueue.splice(0, overflow);
    this._tsOverflowCount = (this._tsOverflowCount || 0) + overflow;
  }
};

// Decoder pipeline depth is a few frames; 120 is two seconds at 60fps,
// far beyond any legitimate in-flight count, so trimming here only ever
// discards entries that will never be matched to an output.
var MAX_PENDING_TIMESTAMPS = 120;

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
  // In auto-size mode we need FFmpeg's stream report, which is only
  // printed at 'info' or above. Callers who set an explicit loglevel
  // keep it; the default 'error' is raised just enough to see the one
  // line we parse. The extra output is a handful of startup lines,
  // routed to the existing ffmpeg:log event rather than the console.
  var effectiveLoglevel = cfg.loglevel || 'error';
  if (!cfg.dimensionsExplicit && (effectiveLoglevel === 'error' ||
      effectiveLoglevel === 'fatal' || effectiveLoglevel === 'panic' ||
      effectiveLoglevel === 'quiet')) {
    effectiveLoglevel = 'info';
  }

  var args = [
    '-hide_banner', '-loglevel', effectiveLoglevel,
    '-threads', String(cfg.threads),
    '-probesize', String(cfg.probesize),
    '-analyzeduration', String(cfg.analyzeduration),
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
  ];

  var fmt = containerDef ? getContainerFormat(containerDef, cfg.codec) : null;
  if (fmt) args.push('-f', fmt);
  args.push('-i', 'pipe:0');

  // MP-9 / spec alignment: the scale filter is now CONDITIONAL.
  //
  // Per W3C WebCodecs, VideoDecoderConfig.codedWidth/codedHeight
  // describe the stream; they are optional, and a conforming decoder
  // emits frames at whatever size the stream actually contains. The
  // previous code always applied `scale=cfg.width:cfg.height` with an
  // invented 1920x1080 default, so decoding a 320x240 stream without
  // an explicit config produced 3,110,400-byte frames instead of
  // 115,200 — a 27x inflation, 89 MB/s of upscaled pixels at 30fps,
  // plus a 9 MB FrameQueue buffer per decoder instance.
  //
  //   - dimensionsExplicit (caller supplied codedWidth/codedHeight):
  //     keep locking output to those dimensions. This is what WebRTC
  //     receive pipelines want — a fixed render target that survives
  //     an upstream Quality Scaler dropping resolution mid-stream —
  //     and it is what every current consumer already relies on.
  //
  //   - not explicit: follow the stream. Dimensions are read from
  //     FFmpeg's own stream report (see _watchStreamDimensions) and
  //     the FrameQueue is resized to match before any frame is cut.
  //
  // The format filter stays in both paths so output is always planar
  // yuv420p even when the input is 4:2:2 or 4:4:4.
  var autoSize = !cfg.dimensionsExplicit;
  if (autoSize) {
    args.push('-vf', 'format=yuv420p');
  } else {
    args.push('-vf', 'scale=' + cfg.width + ':' + cfg.height + ',format=yuv420p');
  }

  // Use -vsync 0 as fallback for older FFmpeg (< 5.1 doesn't have -fps_mode)
  args.push('-an', '-f', 'rawvideo', 'pipe:3');

  self._ffmpeg.start(args, ['pipe', 'inherit', 'pipe', 'pipe']);

  // Output geometry actually in effect. In locked mode it is the
  // configured size; in auto mode it starts as a provisional guess and
  // is corrected by _watchStreamDimensions before the first frame is
  // cut (data is held back until then).
  self._outWidth = cfg.width;
  self._outHeight = cfg.height;
  self._sizeKnown = !autoSize;
  self._pendingData = [];
  self._pendingBytes = 0;

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
      codedWidth: self._outWidth,
      codedHeight: self._outHeight,
      timestamp: ts,
    });
    self._frameIndex++;
    self.context.frameCount = self._frameIndex;
    self._output(vf);
  });

  if (autoSize) self._watchStreamDimensions();

  self._ffmpeg.on('data', function (chunk) {
    if (!self._sizeKnown) {
      // Hold back rawvideo bytes until the real frame size is known.
      // FFmpeg emits its stream report before the first encoded frame,
      // but stdout and stderr are separate pipes with no ordering
      // guarantee in Node, so a race is possible and buffering removes
      // it. In practice this holds a few KB for a few milliseconds.
      self._pendingData.push(chunk);
      self._pendingBytes += chunk.length;
      // Safety valve: if the report never arrives (unusual build,
      // suppressed logging), fall back to the configured dimensions
      // rather than buffering forever.
      if (self._pendingBytes >= MAX_PENDING_BYTES) {
        self._applyStreamDimensions(cfg.width, cfg.height, 'fallback');
      }
      return;
    }
    self._fq.push(chunk);
  });
  self._ffmpeg.on('error', function (e) { self._error(e); });
};

// One second of 1080p is far more than the startup window ever needs;
// crossing it means the stream report is not coming.
var MAX_PENDING_BYTES = 3 * 1024 * 1024;

// FFmpeg reports each stream during startup, e.g.
//   Stream #0:0: Video: h264 (High), yuv444p, 320x240 [SAR 1:1 DAR 4:3] ...
//   Stream #0:0: Video: rawvideo (I420 / 0x30323449), yuv420p, 320x240 ...
// We take the FIRST Video line, which is the input stream. In auto-size
// mode no scale filter is applied, so the rawvideo output carries the
// same geometry — and the input line arrives first, which shortens the
// window during which output bytes have to be held back.
//
// The {2,5} digit bounds matter: they stop the pattern from matching
// hex codec tags like "0x30323449", which have a single digit before
// the x.
var _STREAM_DIMS_RE = /Video:.*?\b(\d{2,5})x(\d{2,5})\b/;

VideoDecoder.prototype._watchStreamDimensions = function () {
  var self = this;
  function onLine(line) {
    if (self._sizeKnown || typeof line !== 'string') return;
    if (line.indexOf('Video:') < 0) return;
    var m = _STREAM_DIMS_RE.exec(line);
    if (!m) return;
    var w = parseInt(m[1], 10);
    var h = parseInt(m[2], 10);
    if (w > 0 && h > 0) self._applyStreamDimensions(w, h, 'stream');
  }
  // Stream reports are plain informational lines; _parseStderr routes
  // them to ffmpeg:log. Watch the warning/error channels too so an
  // unusual build's placement doesn't lose the line.
  this._ffmpeg.on('ffmpeg:log', onLine);
  this._ffmpeg.on('ffmpeg:warning', onLine);
};

/**
 * Lock in the output geometry, resize the FrameQueue, and release any
 * rawvideo bytes held while the size was unknown.
 */
VideoDecoder.prototype._applyStreamDimensions = function (w, h, source) {
  if (this._sizeKnown) return;
  this._sizeKnown = true;
  this._outWidth = w;
  this._outHeight = h;
  this._dimensionSource = source;
  this._bytesPerFrame = ((w * h * 3) >> 1);

  this.context.width = w;
  this.context.height = h;

  if (this._fq) this._fq.setFrameSize(this._bytesPerFrame);

  var held = this._pendingData;
  this._pendingData = [];
  this._pendingBytes = 0;
  for (var i = 0; i < held.length; i++) this._fq.push(held[i]);
};

VideoDecoder.prototype._buildIvfFileHeader = function () {
  var cfg = this._config;
  var fourcc = 'VP90';
  if (cfg.codec === 'vp8') fourcc = 'VP80';
  else if (cfg.codec === 'av1') fourcc = 'AV01';

  var b = new Uint8Array(32);
  b.set(fromAscii('DKIF'), 0);
  writeU16LE(b, 4, 0);
  writeU16LE(b, 6, 32);
  b.set(fromAscii(fourcc), 8);
  writeU16LE(b, 12, cfg.width);
  writeU16LE(b, 14, cfg.height);
  writeU32LE(b, 16, cfg.framerate || 30);
  writeU32LE(b, 20, 1);
  writeU32LE(b, 24, 0);
  writeU32LE(b, 28, 0);
  return b;
};

/**
 * Write IVF frame header directly into buffer at offset.
 * Avoids allocating a separate 12-byte buffer.
 */
function _writeIvfFrameAt(buf, offset, size, pts) {
  writeU32LE(buf, offset, size);
  var bi = BigInt(pts);
  writeU32LE(buf, offset + 4, Number(bi & 0xFFFFFFFFn));
  writeU32LE(buf, offset + 8, Number((bi >> 32n) & 0xFFFFFFFFn));
}

VideoDecoder.isConfigSupported = function (config) {
  // Per W3C WebCodecs, VideoDecoderSupport carries BOTH `supported` and
  // `config` — the latter being the subset of the input config the User
  // Agent recognised, cloned. Authors are explicitly told to diff the
  // returned config against theirs to discover which members were
  // ignored (§7.3.2 note). Returning only `supported` removed the only
  // mechanism for detecting an unrecognised option.
  return Promise.resolve({
    supported: !!getDefaultContainer(config.codec),
    config: _cloneDecoderConfig(config),
  });
};

// Mirrors the spec's Clone Configuration algorithm: copy only the
// members we actually recognise, so the caller can detect the rest by
// comparison.
var _DECODER_CONFIG_KEYS = [
  'codec', 'codedWidth', 'codedHeight', 'description', 'framerate',
  'displayAspectWidth', 'displayAspectHeight', 'colorSpace',
  'hardwareAcceleration', 'optimizeForLatency',
];
function _cloneDecoderConfig(config) {
  var out = {};
  if (!config) return out;
  for (var i = 0; i < _DECODER_CONFIG_KEYS.length; i++) {
    var k = _DECODER_CONFIG_KEYS[i];
    if (config[k] !== undefined) out[k] = config[k];
  }
  return out;
}

export default VideoDecoder;
