/**
 * VideoDecoder — WebCodecs-compatible video decoder.
 * Validates input chunks, uses FrameQueue, single-write IVF headers.
 */

import { frameByteSize } from './core/frame_size.js';
import { initCoder, configureCoder, applyCoderPrototype, watchExit, detachCoderListeners,
  addPendingFlush, removePendingFlush, holdingCalls, holdCall, failUnsupported, domex, failEmptyChunk } from './base_coder.js';
import { checkVideoDecoderConfig, videoDecoderConfigSupported } from './codecs.js';
import { normalizeCodec } from './utils/codec_strings.js';
import FrameQueue from './core/frame_queue.js';
import { writeU16LE, writeU32LE, fromAscii } from './core/bytes.js';
import VideoFrame from './video_frame.js';
import { getDefaultContainer, getContainer, getContainerFormat } from './containers.js';
import { avccToAnnexb, bitstreamFromDescription, splitNALUs } from './utils/nalu_utils.js';
import { findSequenceHeader, parseSequenceHeader } from './utils/av1_utils.js';
import { parseH264Sps, parseH265Sps, h264VideoSignal, h265VideoSignal } from './utils/h26x_parse.js';
import { colorSpaceFromCicp } from './video_color_space.js';
import { toUint8Array, copyBufferSource } from './core/buffer_source.js';

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
var _baseFlush = VideoDecoder.prototype.flush;
var _baseReset = VideoDecoder.prototype.reset;
var _baseClose = VideoDecoder.prototype.close;

VideoDecoder.prototype.configure = function (config) {
  // W3C: the WebIDL conversion and "valid VideoDecoderConfig" are
  // TypeErrors, then a closed decoder an InvalidStateError (codecs.js).
  config = checkVideoDecoderConfig(config, 'VideoDecoder.configure');
  if (this._state === 'closed') throw domex('Cannot configure a closed coder', 'InvalidStateError');
  if (holdingCalls(this)) {
    // Queued behind a flush() in progress (base_coder holdCalls).
    var self = this;
    this._state = 'configured';
    this._keyChunkRequired = true;
    holdCall(this, function () { self.configure(config); }, false);
    return;
  }

  // Per W3C WebCodecs §6.5: codedWidth and codedHeight are OPTIONAL
  // in VideoDecoderConfig (the spec defaults them from the decoded
  // stream). The previous implementation made them required.
  //
  // They are a hint (W3C: "used when selecting a [[codec
  // implementation]]"): the frames have the stream's own size (Output
  // VideoFrames creates them from the decoder's output; Chrome 158 gives
  // a 64x48 stream as 64x48 under codedWidth 96 / 32, measured). The
  // configured size (or 1920x1080) is only the provisional geometry until
  // FFmpeg reports the stream's (_watchStreamDimensions) and the IVF
  // header's size for VP9 / AV1. It used to lock the output to the
  // config's size with `-vf scale=W:H` (MP-9's "fixed render target").
  var w = config.codedWidth || config.width || 1920;
  var h = config.codedHeight || config.height || 1080;

  // H.264 / H.265: the description decides the input format (see
  // bitstreamFromDescription). FFmpeg is always fed Annex-B.
  var vcodec = normalizeCodec(config.codec);
  var bitstream = (vcodec === 'h264' || vcodec === 'h265')
    ? bitstreamFromDescription(config.description ? toUint8Array(config.description) : null, vcodec === 'h265')
    : { lengthSize: 0, paramSets: null };
  // A description that is not one (bitstream.error) is a config the
  // decoder cannot do: NotSupportedError below (it was a TypeError; W3C
  // keeps TypeErrors for invalid configs, §7.6).

  // Reconfiguring while chunks are in flight, or while a previous
  // reconfigure is still draining: queue it (see _drainThenConfigure).
  if (this._draining) {
    this._keyChunkRequired = true;
    this._draining.items.push({ config: config });
    return;
  }
  if (this._state === 'configured' && this._ffmpeg.running && this._inputQueue.length > 0) {
    this._drainThenConfigure(config);
    return;
  }

  configureCoder(this);
  this._lengthSize = bitstream.lengthSize;      // >0: chunks are length-prefixed
  this._paramSets = bitstream.paramSets;        // Annex-B, before the first key chunk

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
    // 32 bytes, not 32 KB: FFmpeg reads probesize bytes of the stream
    // before it decodes anything, and in realtime 32 KB is several
    // frames (measured: the first H.264 frame at 640x480 came out after
    // ~110 ms with 32 KB, ~45 ms with 32 — the cost of starting FFmpeg).
    // The demuxer is always named with -f, so nothing is identified by
    // probing; codec parameters come from the first packet.
    probesize:        (config.probesize        != null) ? config.probesize        : 32,
    analyzeduration:  (config.analyzeduration  != null) ? config.analyzeduration  : 100000,
    threads:          (config.threads          != null) ? config.threads          : 0,
  };

  this._headerSent = false;
  this._descriptionSent = false;
  this._keyChunkRequired = true;   // reset per configure(), per spec
  this._frameIndex = 0;
  this._decodeIndex = 0;
  this._inputQueue = [];                    // MP-23: clear per-session
  this._bytesPerFrame = frameByteSize('I420', w, h);
  this._fq = null;

  // The config's display aspect, orientation and colour space go on
  // every frame (W3C Output VideoFrames); they were ignored.
  this._frameMeta = {
    displayAspectWidth: config.displayAspectWidth, displayAspectHeight: config.displayAspectHeight,
    rotation: config.rotation || 0, flip: !!config.flip, colorSpace: config.colorSpace || null,
  };

  this.context.state = 'configured';
  this.context.codec = this._config.codec;
  this.context.width = w;
  this.context.height = h;
  this.context.frameCount = 0;

  // Check Configuration Support (codecs.js).
  if (!videoDecoderConfigSupported(config, !bitstream.error)) {
    failUnsupported(this, domex("VideoDecoder.configure: unsupported config (codec '" + config.codec + "')" +
      (bitstream.error ? ': ' + bitstream.error : ''), 'NotSupportedError'));
  }
};

// configure() with chunks still in flight. W3C queues configure() behind
// the decode() calls before it, so those chunks are decoded — and output
// — with the configuration they were submitted under; Chrome's decoder
// drains before it reconfigures. configureCoder() killed FFmpeg instead,
// and every chunk in flight was lost: 10 chunks decoded back to back,
// then a new render size, and only the 10 after it came out.
//
// The running FFmpeg gets end of input and finishes on its own, with its
// run's state (frame queue, timestamps, output size) untouched. Until it
// has exited, decode() and configure() calls are queued in order; then
// the new configuration is applied and the queue replayed. 'close' comes
// after every byte of its output has been delivered, so all of its
// frames are out by then. A failed exit closes the coder (watchExit),
// and the queue goes with it.
VideoDecoder.prototype._drainThenConfigure = function (config) {
  var self = this;
  var old = this._ffmpeg;
  var drain = this._draining = { old: old, items: [{ config: config }], flushes: [] };
  this._keyChunkRequired = true;
  old.on('close', function (code, signal) {
    if (self._draining !== drain) return;          // reset()/close() discarded it
    self._draining = null;
    if (self._state !== 'configured') return;      // failCoder closed the coder
    var items = drain.items;
    for (var i = 0; i < items.length; i++) {
      if (self._draining) { self._draining.items.push(items[i]); continue; }
      try {
        // A decode() was checked and counted when it was made. Calls held
        // meanwhile (a flush() made during the drain, the configure() just
        // replayed being held behind it) keep the rest behind them: the
        // decodes were written straight to the decoder, ahead of the
        // configure() made before them — decoded with the configuration
        // they were not submitted under.
        if (items[i].config) self.configure(items[i].config);
        else if (holdingCalls(self)) holdCall(self, (function (c) { return function () { self._decodeNow(c); }; })(items[i].chunk), true);
        else self._decodeNow(items[i].chunk);
      } catch (e) {
        self._error(e);
        return;
      }
    }
    var flushes = drain.flushes;
    for (var j = 0; j < flushes.length; j++) flushes[j]();
  });
  old.endInput();
};

VideoDecoder.prototype.flush = function (cb) {
  var self = this;
  if (!this._draining) return _baseFlush.call(this, cb);
  this._keyChunkRequired = true;   // W3C: set by flush() itself
  // Resolves after the queued chunks are out too: flush again once the
  // drain has replayed them.
  var p = new Promise(function (resolve, reject) {
    var onFail = function (err) { reject(err); };
    addPendingFlush(self, onFail);
    self._draining.flushes.push(function () {
      removePendingFlush(self, onFail);
      self.flush().then(resolve, reject);
    });
  });
  if (typeof cb === 'function') { p.then(function () { cb(); }, cb); return; }
  return p;
};

VideoDecoder.prototype.reset = function () {
  this._draining = null;
  _baseReset.call(this);
};

VideoDecoder.prototype.close = function () {
  this._draining = null;
  _baseClose.call(this);
};

VideoDecoder.prototype.decode = function (chunk) {
  // WebIDL: `chunk` is converted to an EncodedVideoChunk before the method
  // steps run, so a missing one is a TypeError even when the state is not
  // "configured" (it was checked after the state and the key-chunk check).
  if (!chunk || !chunk.data) {
    throw new TypeError('VideoDecoder.decode: chunk must be an EncodedVideoChunk');
  }
  // Per W3C WebCodecs §6.4: throw InvalidStateError synchronously
  // if state isn't 'configured'. Mirrors MP-19's fix for VideoEncoder.
  if (this._state !== 'configured') {
    var stateErr = domex(
      'VideoDecoder.decode: state is "' + this._state + '", not "configured"', 'InvalidStateError');
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
      var keyErr = domex(
        'VideoDecoder.decode: a key chunk is required first (got ' +
        ((chunk && chunk.type) || 'no chunk') + '). Decoding cannot start ' +
        'from a delta chunk.', 'DataError');
      throw keyErr;
    }
    this._keyChunkRequired = false;
  }

  this._queueSize++;
  if (this._draining) {
    // A reconfigure is draining: decoded after it, in order.
    this._draining.items.push({ chunk: chunk });
    return;
  }
  if (holdingCalls(this)) {
    // Queued behind a flush() in progress (base_coder holdCalls).
    var self = this;
    holdCall(this, function () { self._decodeNow(chunk); }, true);
    return;
  }
  this._decodeNow(chunk);
};

VideoDecoder.prototype._decodeNow = function (chunk) {
  if (this._draining) { this._draining.items.push({ chunk: chunk }); return; }
  if (!chunk.data.length) { failEmptyChunk(this, 'VideoDecoder.decode'); return; }
  if (!this._ffmpeg.running) this._startFFmpeg(chunk);

  var containerName = getDefaultContainer(this._config.codec);

  if (containerName === 'ivf') {
    var ivfData;
    if (!this._headerSent) {
      // File header (32) + frame header (12) + payload — single write
      var fileHdr = this._buildIvfFileHeader(chunk.data);
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
    this._ffmpeg.write(ivfData);
  } else {
    // H.264 / H.265 reach FFmpeg as Annex-B: convert length-prefixed
    // chunks, and put the parameter sets in front of the first key chunk.
    var data = this._lengthSize ? avccToAnnexb(chunk.data, this._lengthSize) : chunk.data;
    // Each chunk is written followed by an access unit delimiter, and a
    // leading AUD of its own is dropped (the previous write already put
    // one there). FFmpeg's Annex-B demuxer only knows an access unit is
    // complete when it sees the start of the NEXT one, so every frame
    // used to sit inside FFmpeg until the following chunk arrived — one
    // frame of latency always, a whole frame interval of it (and on a
    // still scene, where the encoder sends rarely, much more). The
    // trailing AUD is that start, written right away; it is a legal
    // first NAL unit of the next access unit (H.264 7.4.1.2.3, H.265
    // 7.4.2.4.4), so the bitstream FFmpeg sees stays conforming.
    var isHevc = this._config.codec === 'h265';
    var body = _stripLeadingAud(data, isHevc);
    var aud = isHevc ? HEVC_AUD : H264_AUD;
    var ps = (!this._descriptionSent && this._paramSets && chunk.type === 'key') ? this._paramSets : null;
    var psLen = ps ? ps.length : 0;
    var combined = new Uint8Array(psLen + body.length + aud.length);
    if (ps) combined.set(ps, 0);
    combined.set(body, psLen);
    combined.set(aud, psLen + body.length);
    if (ps) this._descriptionSent = true;
    this._ffmpeg.write(combined);
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
  // {timestamp, duration}: the frame carries its chunk's duration (W3C);
  // it was dropped.
  this._inputQueue.push({ timestamp: chunk.timestamp,
    duration: (typeof chunk.duration === 'number') ? chunk.duration : null });
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

// Access unit delimiters (start code + NAL header + primary_pic_type
// "any" + RBSP stop bit) — see decode().
var H264_AUD = new Uint8Array([0, 0, 0, 1, 0x09, 0xF0]);
var HEVC_AUD = new Uint8Array([0, 0, 0, 1, 0x46, 0x01, 0x50]);

/** `data` without a leading AUD NAL unit (Annex-B), or `data` itself. */
function _stripLeadingAud(data, isHevc) {
  var sc = (data.length > 4 && data[0] === 0 && data[1] === 0)
    ? (data[2] === 1 ? 3 : (data[2] === 0 && data[3] === 1 ? 4 : 0)) : 0;
  if (!sc || sc >= data.length) return data;
  var type = isHevc ? (data[sc] >> 1) & 0x3f : data[sc] & 0x1f;
  if (type !== (isHevc ? 35 : 9)) return data;
  for (var i = sc + 1; i + 2 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      // Keep a 4-byte start code's leading zero with the next NAL.
      return data.subarray(i > 0 && data[i - 1] === 0 ? i - 1 : i);
    }
  }
  return data.subarray(data.length); // the chunk was only an AUD
}

// ── The output format: the decoded picture's own (W3C Output VideoFrames) ──
//
// A browser's VideoFrame has the format the stream decodes to: I420P10 for
// VP9 profile 2 or 10-bit AV1, I444 / I422 for 4:4:4 / 4:2:2 (Chrome 158,
// measured). Every stream was converted to yuv420p — 10-bit streams lost
// their two low bits, 4:4:4 three quarters of its chroma. The format is
// read from the run's first chunk (a key chunk: VP9's uncompressed header,
// AV1's sequence header, the H.264 / H.265 SPS of the description or the
// chunk), and FFmpeg is asked for exactly that pix_fmt — the decoder's own,
// so nothing is converted. Only what WebCodecs has no format for is
// converted, to the nearest one that loses nothing it can keep:
//   - 4:4:0 (VP9 profile 1 / 3)              → I444 (chroma doubled vertically)
//   - monochrome (AV1, H.264 / H.265 4:0:0)   → I420 with mid-grey chroma (Chrome's)
//   - 9-bit (H.264 / H.265)                   → the P10 format
//   - 13- to 16-bit (H.264 High 4:4:4, HEVC RExt) → the P12 format
// VP9 / AV1 4:4:4 with the identity matrix (GBR planes: FFmpeg's gbrp) is
// I444 with colorSpace matrix 'rgb' (H.273: Y = G, Cb = B, Cr = R).
// A stream the parse does not read (a damaged key chunk) is yuv420p, as before.
var _NATIVE = {
  '420': { 8: ['I420', 'yuv420p'], 10: ['I420P10', 'yuv420p10le'], 12: ['I420P12', 'yuv420p12le'] },
  '422': { 8: ['I422', 'yuv422p'], 10: ['I422P10', 'yuv422p10le'], 12: ['I422P12', 'yuv422p12le'] },
  '444': { 8: ['I444', 'yuv444p'], 10: ['I444P10', 'yuv444p10le'], 12: ['I444P12', 'yuv444p12le'] },
  'gbr': { 8: ['I444', 'gbrp'], 10: ['I444P10', 'gbrp10le'], 12: ['I444P12', 'gbrp12le'] },
};
// VP9 color_space (§7.2.2) → the H.273 matrix: BT.601 is FFmpeg's bt470bg
var _VP9_MATRIX = [2, 5, 1, 6, 7, 9, 2, 0];

/**
 * The output of a stream: { format, pixFmt, colorSpace } from its first
 * key chunk (Annex-B for H.264 / H.265, `paramSets` the description's).
 * colorSpace: what the bitstream says (W3C: "as detected by the codec
 * implementation"; null members where it says nothing) — VP9: the matrix
 * and range;
 * AV1: color_config's primaries, transfer, matrix and range; H.264 /
 * H.265: the SPS VUI's video signal type (colour description and
 * video_full_range_flag; H.273 code points). VP8 has none detected. The
 * config's colorSpace wins over it (_applyFrameMeta).
 */
function _nativeOutput(codec, data, paramSets) {
  var depth = 8, sub = '420', cs = null, info;
  if (codec === 'vp9') info = _vp9ColorConfig(data);
  else if (codec === 'av1') {
    var sh = findSequenceHeader(data);
    var seq = sh && parseSequenceHeader(sh.payload);
    if (seq) {
      info = { depth: seq.bitDepth, sub: seq.mono ? '420' : seq.subX ? (seq.subY ? '420' : '422') : (seq.matrix === 0 ? 'gbr' : '444'), mono: !!seq.mono };
      info.cs = colorSpaceFromCicp(seq.colorPrimaries, seq.transfer, seq.matrix, seq.fullRange);
    }
  } else if (codec === 'h264' || codec === 'h265') {
    var isH265 = codec === 'h265';
    var all = paramSets ? [].concat(splitNALUs(paramSets, isH265), splitNALUs(data, isH265)) : splitNALUs(data, isH265);
    for (var i = 0; i < all.length && !info; i++) {
      if (all[i].type !== (isH265 ? 33 : 7)) continue;
      var sps = isH265 ? parseH265Sps(all[i].data) : parseH264Sps(all[i].data);
      if (sps) {
        info = { depth: sps.bitDepth, sub: sps.chroma === 2 ? '422' : sps.chroma === 3 ? '444' : '420', mono: sps.chroma === 0 };
        // The VUI's video signal type (H.264 §E.1.1, H.265 §E.2.1).
        var vs = isH265 ? h265VideoSignal(all[i].data) : h264VideoSignal(all[i].data);
        if (vs) info.cs = colorSpaceFromCicp(vs.primaries, vs.transfer, vs.matrix, vs.fullRange);
      }
    }
  }
  if (info) {
    depth = info.depth <= 8 ? 8 : info.depth <= 10 ? 10 : 12;
    sub = info.sub;
    cs = info.cs || null;
    if (cs && !cs.primaries && !cs.transfer && !cs.matrix && cs.fullRange === null) cs = null;
  }
  var f = _NATIVE[sub][depth];
  return { format: f[0], pixFmt: f[1], colorSpace: cs, mono: !!(info && info.mono) };
}

/**
 * A VP9 key frame's color_config (VP9 bitstream §6.2): { depth, sub, cs }
 * — sub '420' | '422' | '444' | 'gbr' (4:4:0 is '444': converted), or
 * null when the frame is not a key frame it can read.
 */
function _vp9ColorConfig(frame) {
  if (!frame || frame.length < 10) return null;
  var pos = 0;
  var bit = function () { var b = (frame[pos >> 3] >> (7 - (pos & 7))) & 1; pos++; return b; };
  var bits = function (n) { var v = 0; for (var k = 0; k < n; k++) v = (v << 1) | bit(); return v; };
  if (bits(2) !== 2) return null;                          // frame_marker
  var profile = bit() | (bit() << 1);
  if (profile === 3) bit();                                // reserved_zero
  if (bit()) return null;                                  // show_existing_frame
  if (bit() !== 0) return null;                            // frame_type: KEY_FRAME
  bits(2);                                                 // show_frame, error_resilient_mode
  if (bits(24) !== 0x498342) return null;                  // frame_sync_code
  var depth = profile >= 2 ? (bit() ? 12 : 10) : 8;
  var space = bits(3);
  var sub = '420', full;
  if (space !== 7) {                                       // CS_RGB
    full = bit();
    if (profile === 1 || profile === 3) {
      var sx = bit(), sy = bit();
      sub = sx ? (sy ? '420' : '422') : '444';             // 4:4:0 (sx 0, sy 1): '444'
    }
  } else {
    full = 1;
    if (profile !== 1 && profile !== 3) return null;       // RGB needs 4:4:4
    sub = 'gbr';
  }
  if ((pos >> 3) >= frame.length) return null;
  return { depth: depth, sub: sub, cs: colorSpaceFromCicp(2, 2, _VP9_MATRIX[space], full) };
}

VideoDecoder.prototype._startFFmpeg = function (firstChunk) {
  // One run's listeners at a time (see base_coder detachCoderListeners):
  // after a flush() this starts a new run on the same process object.
  detachCoderListeners(this._ffmpeg);
  // A new run is a new FFmpeg input stream: it needs the IVF file header
  // (VP8/VP9/AV1) and, for 'avc'/'hevc' input, the out-of-band parameter
  // sets in front of its first key chunk — again. Both were reset only
  // in configure(), so the first decode after a flush() fed the new
  // FFmpeg IVF frames with no file header (or slices with no SPS/PPS):
  // it failed to open its input and the decoder closed.
  this._headerSent = false;
  this._descriptionSent = false;
  this._decodeIndex = 0;
  var self = this;
  var cfg = this._config;
  // The decoded picture's format (see _nativeOutput).
  var chunkData = firstChunk && firstChunk.data;
  if (chunkData && this._lengthSize) chunkData = avccToAnnexb(chunkData, this._lengthSize);
  var native = _nativeOutput(cfg.codec, chunkData, this._paramSets);
  this._outFormat = native.format;
  this._streamColorSpace = native.colorSpace;
  this._bytesPerFrame = frameByteSize(native.format, cfg.width, cfg.height);
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
  //   -probesize 32    Tiny probe (was: 1 MB, then 32 KB — see the
  //                    default in configure). The caller names the
  //                    codec in configure(), so FFmpeg doesn't need to
  //                    identify it by reading ahead.
  //
  //   -analyzeduration 100K
  //                    Cap stream analysis to 100ms (was: 500ms). Going
  //                    to 0 broke very short streams (FFmpeg needs SOME
  //                    bytes to identify the codec); 100ms is the
  //                    smallest value that's reliable across codecs and
  //                    still saves significant first-frame latency.
  //
  //   (no -fflags nobuffer — see the note at the args below: it
  //    discards the probed packets, i.e. the stream's first keyframe)
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
  // We need FFmpeg's stream report (the stream's size), which is only
  // printed at 'info' or above. Callers who set an explicit loglevel
  // keep it; the default 'error' is raised just enough to see the one
  // line we parse. The extra output is a handful of startup lines,
  // routed to the existing ffmpeg:log event rather than the console.
  var effectiveLoglevel = cfg.loglevel || 'error';
  if ((effectiveLoglevel === 'error' ||
      effectiveLoglevel === 'fatal' || effectiveLoglevel === 'panic' ||
      effectiveLoglevel === 'quiet')) {
    effectiveLoglevel = 'info';
  }

  var args = [
    '-hide_banner', '-loglevel', effectiveLoglevel,
    '-threads', String(cfg.threads),
    '-probesize', String(cfg.probesize),
    '-analyzeduration', String(cfg.analyzeduration),
    // No '-fflags nobuffer': it DISCARDS the packets read while probing
    // the stream (up to -probesize). That is the start of
    // the stream — including its first keyframe — so a small or
    // low-bitrate stream decoded to nothing, and a realtime one showed
    // nothing until the next keyframe (which 'realtime' mode only emits
    // on request). Measured: 12 chunks in → 0 frames out with it,
    // 12 out without it. low_delay alone keeps the latency benefit.
    '-flags', 'low_delay',
  ];

  var fmt = containerDef ? getContainerFormat(containerDef, cfg.codec) : null;
  if (fmt) args.push('-f', fmt);
  args.push('-i', 'pipe:0');

  // No scale filter: W3C's frames are the stream's size, whatever the
  // config's codedWidth / codedHeight (a hint; see configure). Dimensions
  // are read from FFmpeg's own stream report (see _watchStreamDimensions)
  // and the FrameQueue is resized to match before any frame is cut. (It
  // scaled to the config's size when one was given — MP-9's fixed render
  // target — and, before that, to an invented 1920x1080.) A size change
  // in the middle of a run is FFmpeg's autoscale to the run's first size
  // (the rawvideo output keeps one size).
  //
  // The format filter: the stream's own pix_fmt
  // (_nativeOutput), so FFmpeg converts only what WebCodecs cannot
  // express (and a hardware decoder's NV12 / P010 back to it).
  // Monochrome (gray → yuv420p): one range in and out, or swscale
  // stretches a full-range luma to studio range — the luma is the
  // decoder's as it is, the chroma mid-grey.
  var range = native.mono ? 'in_range=pc:out_range=pc' : '';
  args.push('-vf', (range ? 'scale=' + range + ',' : '') + 'format=' + native.pixFmt);

  // '-threads 1' here is the OUTPUT side: the rawvideo "encoder" that
  // writes the decoded frames to pipe:3 supports frame threading, and
  // with FFmpeg's default thread count it kept one frame in flight, so
  // every decoded frame reached us only when the next one was decoded
  // (measured on FFmpeg 8: 1 frame held for VP8/VP9/AV1 and raw input
  // alike, 0 with this). Copying a raw frame needs no threads.
  args.push('-an', '-threads', '1', '-f', 'rawvideo', 'pipe:3');

  self._ffmpeg.start(args, ['pipe', 'inherit', 'pipe', 'pipe']);
  // FFmpeg failing (non-zero exit) closes this coder with an EncodingError
  // — see base_coder's failCoder. It used to fail silently.
  watchExit(self);

  // Output geometry actually in effect: a provisional guess, corrected
  // by _watchStreamDimensions before the first frame is cut (data is
  // held back until then).
  self._outWidth = cfg.width;
  self._outHeight = cfg.height;
  self._sizeKnown = false;
  self._pendingData = [];
  self._pendingBytes = 0;

  self._fq = new FrameQueue(self._bytesPerFrame, function (frameBuf) {
    // MP-23: derive timestamp from the input chunk that produced this
    // frame, not from a frame counter. For video without B-frames the
    // mapping is 1:1 in order. If the queue is empty (FFmpeg emitted
    // a frame before any decode() — rare startup transient — fall
    // back to counter-based math).
    var ts, dur = null;
    if (self._inputQueue.length > 0) {
      var _in = self._inputQueue.shift();
      ts = _in.timestamp;
      dur = _in.duration;
    } else {
      ts = Math.round((self._frameIndex * 1e6) / (cfg.framerate || 30));
    }
    var init = {
      data: frameBuf,
      format: self._outFormat,
      codedWidth: self._outWidth,
      codedHeight: self._outHeight,
      timestamp: ts,
      duration: dur,
    };
    // W3C Output VideoFrames: the colour space the stream says, unless
    // the config gives one (_applyFrameMeta).
    if (self._streamColorSpace) init.colorSpace = self._streamColorSpace;
    _applyFrameMeta(init, self._frameMeta, self._outWidth, self._outHeight);
    var vf = new VideoFrame(init);
    self._frameIndex++;
    self.context.frameCount = self._frameIndex;
    self._output(vf);
  });

  self._watchStreamDimensions();

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

/**
 * W3C Output VideoFrames / Create a VideoFrame: the config's rotation and
 * flip, its colorSpace, and the display size grown until its ratio is
 * displayAspectWidth : displayAspectHeight.
 */
function _applyFrameMeta(init, meta, w, h) {
  if (!meta) return;
  if (meta.rotation) init.rotation = meta.rotation;
  if (meta.flip) init.flip = true;
  if (meta.colorSpace) init.colorSpace = meta.colorSpace;
  var aw = meta.displayAspectWidth, ah = meta.displayAspectHeight;
  if (aw && ah) {
    var dw = w, dh = h;
    if (dw * ah < dh * aw) dw = Math.round(dh * aw / ah);
    else if (dw * ah > dh * aw) dh = Math.round(dw * ah / aw);
    init.displayWidth = dw;
    init.displayHeight = dh;
  }
}

// One second of 1080p is far more than the startup window ever needs;
// crossing it means the stream report is not coming.
var MAX_PENDING_BYTES = 3 * 1024 * 1024;

// FFmpeg reports each stream during startup, e.g.
//   Stream #0:0: Video: h264 (High), yuv444p, 320x240 [SAR 1:1 DAR 4:3] ...
//   Stream #0:0: Video: rawvideo (I420 / 0x30323449), yuv420p, 320x240 ...
// We take the FIRST Video line, which is the input stream. No scale
// filter is applied, so the rawvideo output carries the same geometry — and the input line arrives first, which shortens the
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
  this._bytesPerFrame = frameByteSize(this._outFormat || 'I420', w, h);

  this.context.width = w;
  this.context.height = h;

  if (this._fq) this._fq.setFrameSize(this._bytesPerFrame);

  var held = this._pendingData;
  this._pendingData = [];
  this._pendingBytes = 0;
  for (var i = 0; i < held.length; i++) this._fq.push(held[i]);
};

// The header's size is the stream's where its first frame says it: a VP8
// key frame carries it (RFC 6386 §9.1: start code 9d 01 2a, then 14-bit
// width and height). It used to be the config's — 1920x1080 when the
// config gives none — and FFmpeg reports an IVF VP8 stream at its header's
// size (VP9 and AV1 have parsers that read the frame instead), so
// _watchStreamDimensions cut 1920x1080 frames out of 160x120 ones: a VP8
// decoder without codedWidth / codedHeight output nothing.
VideoDecoder.prototype._buildIvfFileHeader = function (first) {
  var cfg = this._config;
  var fourcc = 'VP90';
  if (cfg.codec === 'vp8') fourcc = 'VP80';
  else if (cfg.codec === 'av1') fourcc = 'AV01';
  var w = cfg.width, h = cfg.height;
  if (cfg.codec === 'vp8' && first && first.length >= 10 && (first[0] & 1) === 0 &&
      first[3] === 0x9d && first[4] === 0x01 && first[5] === 0x2a) {
    w = (first[6] | (first[7] << 8)) & 0x3fff;
    h = (first[8] | (first[9] << 8)) & 0x3fff;
  }

  var b = new Uint8Array(32);
  b.set(fromAscii('DKIF'), 0);
  writeU16LE(b, 4, 0);
  writeU16LE(b, 6, 32);
  b.set(fromAscii(fourcc), 8);
  writeU16LE(b, 12, w);
  writeU16LE(b, 14, h);
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
  // The codec STRING is normalised first ('avc1.42001f' → 'h264'), as
  // configure() does. The container table knows only short names, so
  // every WebCodecs codec string — avc1.*, vp09.*, av01.*, hvc1.* —
  // was reported unsupported while configure() accepted it.
  //
  // W3C: an invalid config rejects with a TypeError; supported is Check
  // Configuration Support (codecs.js), with an avc / hevc description
  // that has to be a record.
  var c;
  try { c = checkVideoDecoderConfig(config, 'VideoDecoder.isConfigSupported'); }
  catch (e) { return Promise.reject(e); }
  var vcodec = normalizeCodec(c.codec), descOk = true;
  if ((vcodec === 'h264' || vcodec === 'h265') && c.description) {
    descOk = !bitstreamFromDescription(toUint8Array(c.description), vcodec === 'h265').error;
  }
  return Promise.resolve({
    supported: videoDecoderConfigSupported(c, descOk),
    config: _cloneDecoderConfig(c),
  });
};

// Mirrors the spec's Clone Configuration algorithm: copy only the
// members we actually recognise, so the caller can detect the rest by
// comparison.
var _DECODER_CONFIG_KEYS = [
  'codec', 'codedWidth', 'codedHeight', 'description', 'framerate',
  'displayAspectWidth', 'displayAspectHeight', 'colorSpace',
  'hardwareAcceleration', 'optimizeForLatency', 'rotation', 'flip',
];
function _cloneDecoderConfig(config) {
  var out = {};
  if (!config) return out;
  for (var i = 0; i < _DECODER_CONFIG_KEYS.length; i++) {
    var k = _DECODER_CONFIG_KEYS[i];
    if (config[k] === undefined) continue;
    if (k === 'description') out[k] = copyBufferSource(config[k]);
    else if (k === 'colorSpace' && config[k] !== null && typeof config[k] === 'object') {
      // A nested dictionary (VideoColorSpaceInit), cloned member by member
      // with its IDL defaults (null): it was the caller's object.
      var cs = config[k];
      out[k] = {
        primaries: cs.primaries !== undefined ? cs.primaries : null,
        transfer:  cs.transfer  !== undefined ? cs.transfer  : null,
        matrix:    cs.matrix    !== undefined ? cs.matrix    : null,
        fullRange: cs.fullRange !== undefined ? cs.fullRange : null,
      };
    } else out[k] = config[k];
  }
  return out;
}

export default VideoDecoder;
