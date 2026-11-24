/**
 * AudioEncoder — WebCodecs-compatible audio encoder.
 * Validates input data alignment.
 */

import { initCoder, configureCoder, wireReader, applyCoderPrototype, watchExit, detachCoderListeners, failCoder } from './base_coder.js';
import { normalizeCodec } from './utils/codec_strings.js';
import { EncodedAudioChunk } from './encoded_chunk.js';
import { getAudioCodec } from './codecs.js';
import { getDefaultContainer, getContainer, getContainerFormat, getContainerExtra } from './containers.js';
import { getOpusPacketDurationUs } from './utils/opus_utils.js';
import { buildAudioSpecificConfig, stripAdts, audioSpecificConfigFromAdts, parseAdtsHeader } from './utils/aac_utils.js';

// ── AAC bitstream format (W3C AAC codec registration) ──
//
//   aac.format = 'aac'  (default): chunks are raw AAC access units;
//                       decoderConfig.description = AudioSpecificConfig.
//   aac.format = 'adts': chunks keep their ADTS header; no description.
//
// FFmpeg is run with an ADTS container (the reader needs the framing),
// so the raw form is derived here by stripping each header. Before this
// the option was ignored: chunks were always ADTS AND came with an ASC
// description — a mix no browser produces, which put ADTS headers inside
// fMP4 samples (HLSEncoder fMP4 path) and broke spec-following decoders.
var _AAC_FORMATS = { aac: 1, adts: 1 };

// ── Format helpers ────────────────────────────────────────────────────────

/**
 * Bytes per sample for each WebCodecs AudioSampleFormat.
 * Spec list: u8, s16, s32, f32 + their -planar variants.
 * Default falls back to 2 bytes (s16) — matches legacy behavior.
 */
function _bytesPerSample(fmt) {
  switch (fmt) {
    case 'u8':  case 'u8-planar':  return 1;
    case 's16': case 's16-planar': return 2;
    case 's32': case 's32-planar': return 4;
    case 'f32': case 'f32-planar': return 4;
    default:                       return 2;
  }
}

// ── OpusEncoderConfig validator (MP-11, W3C WebCodecs Opus registration) ──
//
// The W3C OpusEncoderConfig dictionary
// (https://www.w3.org/TR/webcodecs-opus-codec-registration/):
//
//   dictionary OpusEncoderConfig {
//     OpusBitstreamFormat format = "opus";       // 'opus' | 'ogg'
//     OpusSignal signal = "auto";                // 'auto' | 'voice' | 'music'
//     OpusApplication application = "audio";     // 'voip' | 'audio' | 'lowdelay'
//     [EnforceRange] unsigned long long frameDuration = 20000;  // µs
//     [EnforceRange] unsigned long complexity;   // 0..10
//     [EnforceRange] unsigned long packetlossperc = 0;
//     boolean useinbandfec = false;
//     boolean usedtx = false;
//   };
//
// frameDuration MUST be a valid Opus frame duration per RFC 6716 §2.1.4 —
// one of {2.5, 5, 10, 20, 40, 60} ms expressed in microseconds.
// Invalid values throw NotSupportedError per the WebCodecs configure()
// contract (the spec uses [Clamp] on integers but errors on out-of-range
// enums and durations).
//
// Returns a plain object with cfg-shape fields suitable for direct
// merging into AudioEncoder._config (which codecs.js's opus() consumes).

var _VALID_OPUS_FRAME_DURATIONS_US = [2500, 5000, 10000, 20000, 40000, 60000];
var _VALID_OPUS_FORMATS = ['opus', 'ogg'];
var _VALID_OPUS_SIGNALS = ['auto', 'voice', 'music'];
var _VALID_OPUS_APPLICATIONS = ['voip', 'audio', 'lowdelay'];

function _validateAndMapOpusConfig(opus) {
  var out = {};

  if (opus.format !== undefined) {
    if (_VALID_OPUS_FORMATS.indexOf(opus.format) === -1) {
      _throwNotSupported(
        "OpusEncoderConfig.format must be 'opus' or 'ogg', got " +
        JSON.stringify(opus.format)
      );
    }
    // Our pipeline always emits raw Opus packets (the OGG container
    // reader unpacks pages → Opus packets → EncodedAudioChunk). That
    // matches OpusBitstreamFormat='opus' chunk semantics from the
    // codec registration spec ("Opus packets, as described in section
    // 3 of [OPUS]"). 'ogg' would require additionally setting an
    // Identification Header on AudioDecoderConfig.description per
    // [OPUS-IN-OGG] §5.1 — out of scope for this iteration. Reject
    // explicitly so callers don't get silently-wrong behavior.
    if (opus.format === 'ogg') {
      _throwNotSupported(
        "OpusEncoderConfig.format='ogg' is not yet supported (only 'opus' " +
        "raw-packet chunks are emitted; pass codecOptions ['-f','ogg'] " +
        "to bypass the OGG reader if you need framed output)"
      );
    }
    // out.format intentionally not set — current default is already 'opus'.
  }

  if (opus.signal !== undefined) {
    if (_VALID_OPUS_SIGNALS.indexOf(opus.signal) === -1) {
      _throwNotSupported(
        "OpusEncoderConfig.signal must be 'auto', 'voice', or 'music', got " +
        JSON.stringify(opus.signal)
      );
    }
    out.signal = opus.signal;
  }

  if (opus.application !== undefined) {
    if (_VALID_OPUS_APPLICATIONS.indexOf(opus.application) === -1) {
      _throwNotSupported(
        "OpusEncoderConfig.application must be 'voip', 'audio', or 'lowdelay', got " +
        JSON.stringify(opus.application)
      );
    }
    out.application = opus.application;
  }

  if (opus.frameDuration !== undefined) {
    if (typeof opus.frameDuration !== 'number' ||
        _VALID_OPUS_FRAME_DURATIONS_US.indexOf(opus.frameDuration) === -1) {
      _throwNotSupported(
        "OpusEncoderConfig.frameDuration must be one of " +
        _VALID_OPUS_FRAME_DURATIONS_US.join(', ') + " µs (got " +
        opus.frameDuration + ")"
      );
    }
    // codecs.js consumes ptimeMs (libopus uses ms). Spec is in µs.
    out.ptimeMs = opus.frameDuration / 1000;
  }

  if (opus.complexity !== undefined) {
    if (typeof opus.complexity !== 'number' ||
        !Number.isInteger(opus.complexity) ||
        opus.complexity < 0 || opus.complexity > 10) {
      _throwNotSupported(
        "OpusEncoderConfig.complexity must be an integer 0..10 (got " +
        opus.complexity + ")"
      );
    }
    out.complexity = opus.complexity;
  }

  if (opus.packetlossperc !== undefined) {
    if (typeof opus.packetlossperc !== 'number' ||
        !Number.isInteger(opus.packetlossperc) ||
        opus.packetlossperc < 0 || opus.packetlossperc > 100) {
      _throwNotSupported(
        "OpusEncoderConfig.packetlossperc must be an integer 0..100 (got " +
        opus.packetlossperc + ")"
      );
    }
    out.packetlossperc = opus.packetlossperc;
  }

  if (opus.useinbandfec !== undefined) {
    out.useinbandfec = !!opus.useinbandfec;
  }

  if (opus.usedtx !== undefined) {
    out.usedtx = !!opus.usedtx;
  }

  return out;
}

function _throwNotSupported(msg) {
  // Per WebCodecs spec (§"configure()"): invalid configuration values
  // reject the configure step with NotSupportedError.
  var e = new Error(msg);
  e.name = 'NotSupportedError';
  throw e;
}

function AudioEncoder(init) {
  if (!init) throw new TypeError('AudioEncoder: init required');
  initCoder(this, init);
  this._encodeCount = 0;

  // ── Diagnostic counters (observability for long-run audio bugs) ──
  //
  // Note: encodeQueueSize is NOT initialized here — the framework's
  // base_coder.js defines it as a getter on the prototype, and any
  // assignment ("this.encodeQueueSize = 0") throws TypeError. The
  // 'dequeue' event is also emitted by the framework itself.
  this._stats = this._stats || {};
  this._stats.backpressureEvents = 0;
  this._stats.ffmpegRestarts = 0;

  this.context = {
    state: 'unconfigured',
    codec: null,
    sampleRate: 0,
    numberOfChannels: 0,
    frameCount: 0,
  };
}

applyCoderPrototype(AudioEncoder, { role: 'encoder' });

AudioEncoder.prototype.configure = function (config) {
  if (!config || !config.codec) throw new TypeError('AudioEncoder.configure: codec required');
  configureCoder(this);

  var normalizedCodec = normalizeCodec(config.codec);

  // ── W3C OpusEncoderConfig (MP-11) ──
  // When the caller passes config.opus per the WebCodecs Opus codec
  // registration, validate and map its fields into the cfg shape that
  // codecs.js consumes. Spec violations throw NotSupportedError.
  // The legacy escape hatch — config.codecOptions raw FFmpeg args —
  // is still applied unchanged (and AFTER opus-derived args, so it
  // can override for power-user scenarios).
  var opusOpts = null;
  if (normalizedCodec === 'opus' && config.opus &&
      typeof config.opus === 'object') {
    opusOpts = _validateAndMapOpusConfig(config.opus);
  }

  var aacFormat = null;
  if (normalizedCodec === 'aac') {
    aacFormat = (config.aac && config.aac.format !== undefined) ? config.aac.format : 'aac';
    if (!_AAC_FORMATS[aacFormat]) {
      throw new TypeError("AudioEncoder.configure: aac.format must be 'aac' or 'adts' (got '" + aacFormat + "')");
    }
  }

  this._config = {
    codec: normalizedCodec,
    // decoderConfig.codec must be a full codec string ('mp4a.40.2'),
    // never the short name — a browser AudioDecoder rejects 'aac'.
    codecString: String(config.codec),
    aacFormat: aacFormat,
    sampleRate: config.sampleRate || 48000,
    numberOfChannels: config.numberOfChannels || 2,
    bitrate: config.bitrate || 0,
    bitrateMode: config.bitrateMode || 'variable',  // 'constant','variable'
    codecOptions: config.codecOptions || null,
  };

  if (opusOpts) {
    // Merge spec-derived fields into _config so codecs.js's opus()
    // function sees them via cfg.useinbandfec / cfg.usedtx /
    // cfg.ptimeMs / cfg.complexity / etc. Top-level config fields
    // would still be respected via direct cfg.useinbandfec etc., but
    // when both are specified the W3C config.opus form wins (it's
    // the canonical surface).
    for (var k in opusOpts) {
      if (Object.prototype.hasOwnProperty.call(opusOpts, k)) {
        this._config[k] = opusOpts[k];
      }
    }
  }

  // W3C: a config the codec rejects (getAudioCodec throws
  // NotSupportedError — e.g. Opus at 44100 Hz) closes the encoder with
  // that error, asynchronously. It surfaced as an exception thrown out of
  // the FIRST encode() instead, from _startFFmpeg.
  try { getAudioCodec(normalizedCodec, this._config); }
  catch (eCfg) {
    var selfCfg = this;
    var nsErr = new Error(eCfg && eCfg.message || String(eCfg));
    nsErr.name = 'NotSupportedError';
    queueMicrotask(function () { failCoder(selfCfg, nsErr); });
  }

  this._encodeCount = 0;
  // ── W3C timestamp anchoring ──
  // A browser AudioEncoder stamps each output chunk from the INPUT
  // timeline: the chunk that starts with input frame i's samples carries
  // i's timestamp. FFmpeg sees one continuous PCM stream and reports
  // positions in it (µs from the start of the run); _runSegments maps
  // those positions back: one entry per encode(), {startUs: where its
  // samples begin in the run's stream, timestamp: its AudioData
  // timestamp}. See _inputTimestampAt.
  //
  // This replaced a running "gap" total added to every chunk emitted
  // after a gap was SEEN AT INPUT — so packets already inside FFmpeg
  // (~80 ms in realtime; everything when fed faster than realtime) were
  // shifted by the gap too (a 300 ms gap stamped the 3 packets before it
  // 300 ms late; fed at once, 90 of 100 timestamps were wrong), gaps of
  // ≤100 ms were ignored until they summed past it, and after a flush()
  // the next run's output restarted at the first run's timestamps.
  this._runSegments = [];
  this._runInputUs = 0;
  this._decoderConfigSent = false;  // emit decoderConfig on first output chunk
  this._opusHead = null;            // captured from ogg stream (opus only)
  this.context.state = 'configured';
  this.context.codec = this._config.codec;
  this.context.sampleRate = this._config.sampleRate;
  this.context.numberOfChannels = this._config.numberOfChannels;
  this.context.frameCount = 0;
};

AudioEncoder.prototype.encode = function (audioData) {
  // W3C: encode() THROWS — InvalidStateError when not "configured", a
  // TypeError for a closed (detached) AudioData. Both went to the error
  // callback as plain Errors, so a caller's try/catch caught nothing.
  // (VideoEncoder and the decoders already throw.)
  if (this._state !== 'configured') {
    var stErr = new Error('AudioEncoder.encode: state is "' + this._state + '", not "configured"');
    stErr.name = 'InvalidStateError';
    throw stErr;
  }
  if (!audioData || audioData._closed || !audioData.data) {
    throw new TypeError('AudioEncoder.encode: audioData is closed or has no data');
  }

  var _inDurUs = 0;
  if (typeof audioData.numberOfFrames === 'number' && audioData.sampleRate) {
    _inDurUs = audioData.numberOfFrames * 1e6 / audioData.sampleRate;
  } else if (typeof audioData.duration === 'number') {
    _inDurUs = audioData.duration;
  }

  // ── Per-frame format consistency check (W3C WebCodecs alignment) ──
  //
  // Chrome and Firefox AudioEncoder reject frames whose numberOfChannels
  // or sampleRate doesn't match the configured encoder. We mirror that
  // — but more importantly, MUST do so because of the downstream FFmpeg
  // path: -ac and -ar are baked in at _startFFmpeg() time from
  // _config.{numberOfChannels,sampleRate}, so a mismatched audioData
  // gets reinterpreted as the configured layout, producing silent
  // corruption (mono fed into a stereo-configured pipeline plays at
  // half speed with phase issues; off-rate input plays at the wrong
  // pitch).
  //
  // The pipeline-level fix at media_pipeline.js's createAudioSendPipeline
  // (item #10 in the recent batch) reads track.getSettings() to configure
  // the encoder correctly, which closes the failure mode for our
  // internal tracks. This validation is defense in depth: third-party
  // AudioData sources, future WebCodecs-direct callers, or any future
  // refactor that decouples encoder config from track settings will hit
  // this validation explicitly instead of silently producing wrong
  // bytes.
  //
  // Per W3C: the AudioData constructor REQUIRES numberOfChannels and
  // sampleRate (required dictionary members of AudioDataInit). They
  // should always be present on a properly-constructed AudioData.
  // Accept absent fields as "skip the check" — the alignment check
  // below catches the most common form of mismatch (channel count
  // wrong → byte alignment wrong) anyway.
  if (typeof audioData.numberOfChannels === 'number' &&
      audioData.numberOfChannels !== this._config.numberOfChannels) {
    this._error(new Error(
      'AudioEncoder.encode: audioData.numberOfChannels=' + audioData.numberOfChannels +
      ' does not match configured numberOfChannels=' + this._config.numberOfChannels
    ));
    return;
  }
  if (typeof audioData.sampleRate === 'number' &&
      audioData.sampleRate !== this._config.sampleRate) {
    this._error(new Error(
      'AudioEncoder.encode: audioData.sampleRate=' + audioData.sampleRate +
      ' does not match configured sampleRate=' + this._config.sampleRate
    ));
    return;
  }

  // Detect format and compute byte-per-sample. WebCodecs AudioSampleFormat
  // enumerates u8, s16, s32, f32 (and -planar variants) — the spec is
  // explicit, so we cover all of them rather than the legacy "f32 or 2"
  // shortcut that would mis-handle s32 and u8 inputs.
  var fmt = audioData.format || this._inputFormat || 's16';
  var bps = _bytesPerSample(fmt);
  var align = this._config.numberOfChannels * bps;
  if (audioData.data.length % align !== 0) {
    this._error(new Error(
      'AudioEncoder.encode: data length ' + audioData.data.length +
      ' not aligned to ' + align + ' bytes'
    ));
    return;
  }

  // ── The PCM FFmpeg reads: interleaved s16 or f32, nothing else ──
  //
  // FFmpeg is started with -f s16le or -f f32le — interleaved — chosen
  // from the first frame. The frame's bytes were written as they were:
  // a *-planar frame was read as interleaved (stereo became both
  // channels smeared together), s32 as twice as many s16 samples (2 s of
  // noise per second), u8 as half as many, and any later frame in
  // another format than the first was misread the same way. Every
  // AudioSampleFormat is now converted to the pipeline's format
  // (AudioData.copyTo does the conversion); s16/u8 sources run the
  // pipeline in s16, the rest in f32.
  if (!this._inputFormat) {
    var _b = String(fmt).replace('-planar', '');
    this._inputFormat = (_b === 's16' || _b === 'u8') ? 's16' : 'f32';
  }
  var pcm = audioData.data;
  if (fmt !== this._inputFormat) {
    if (typeof audioData.copyTo !== 'function') {
      throw new TypeError('AudioEncoder.encode: format "' + fmt + '" needs an AudioData (copyTo) to convert to ' + this._inputFormat);
    }
    var _conv = { planeIndex: 0, format: this._inputFormat };
    pcm = new Uint8Array(audioData.allocationSize(_conv));
    audioData.copyTo(pcm, _conv);
  }

  if (!this._ffmpeg.running) {
    // The first start is not a restart; every later one is (FFmpeg
    // exited after flush() or died).
    if (this._encodeCount > 0) this._stats.ffmpegRestarts++;
    this._startFFmpeg();
  }

  // Where this frame's samples begin in the run's stream, and its
  // timestamp (a missing one continues from the previous frame).
  var _ts = audioData.timestamp;
  if (typeof _ts !== 'number' || !isFinite(_ts)) {
    var _last = this._runSegments[this._runSegments.length - 1];
    _ts = _last ? _last.timestamp + (this._runInputUs - _last.startUs) : 0;
  }
  this._runSegments.push({ startUs: this._runInputUs, timestamp: _ts });
  this._runInputUs += _inDurUs;

  // ── Backpressure tracking (diagnostic only) ──
  //
  // The framework's base_coder defines encodeQueueSize as a getter,
  // and emits 'dequeue' on its own — we MUST NOT touch them from
  // here (assigning encodeQueueSize throws "has only a getter").
  // We just record write()=false occurrences for observability.
  //
  // We also do NOT drop on write()=false. Node's highWaterMark
  // (16KB default) is much smaller than typical kernel pipe buffers
  // (~64KB), so write() returns false in normal operation whenever
  // sustained PCM throughput exceeds 16KB worth of buffered data
  // (~170ms of 48kHz stereo s16). Treating that as a drop signal
  // would gate audio behind drain cycles even when the kernel is
  // perfectly happy.
  this._queueSize++;
  var ok = this._ffmpeg.write(pcm);
  this._encodeCount++;
  this.context.frameCount = this._encodeCount;

  if (!ok) {
    this._stats.backpressureEvents++;
  }

  return ok;
};

/**
 * The input timestamp of the sample at `posUs` in the current run's PCM
 * stream: the AudioData that sample came from, plus the offset into it.
 * Entries the output has moved past are dropped.
 */
AudioEncoder.prototype._inputTimestampAt = function (posUs) {
  var segs = this._runSegments;
  while (segs.length > 1 && segs[1].startUs <= posUs) segs.shift();
  var seg = segs[0];
  if (!seg) return Math.round(posUs);
  return Math.round(seg.timestamp + (posUs - seg.startUs));
};

AudioEncoder.prototype._startFFmpeg = function () {
  var self = this;
  var cfg = this._config;
  // A new run: FFmpeg's stream positions restart at 0 (see configure()).
  this._runSegments = [];
  this._runInputUs = 0;

  // ── Defensive listener cleanup (fix #1: listener doubling) ──
  //
  // Without this, every FFmpeg restart added a NEW 'data' listener on
  // self._ffmpeg._ee while the prior listener stayed attached. After
  // an OOM-induced restart you'd get two listeners both emitting
  // EncodedAudioChunks for every encoded packet — the receiver got
  // duplicate chunks with identical timestamps, which corrupts the
  // AAC/Opus decoder state and produces audible noise that doesn't
  // recover until the call ends.
  //
  // removeAllListeners is idempotent on a fresh instance (does nothing
  // if no listeners are attached), so it's safe as a defensive
  // unconditional call before each spawn — handles the "running=false
  // → restart" path AND any future code that might call _startFFmpeg
  // for other reasons. Cheap insurance.
  detachCoderListeners(self._ffmpeg);

  var codecDef = getAudioCodec(cfg.codec, cfg);
  if (!codecDef) { self._error(new Error('Unknown codec: ' + cfg.codec)); return; }

  var containerName = getDefaultContainer(cfg.codec);
  var containerDef = getContainer(containerName);

  // ── Input-side latency flags ──
  //
  // FFmpeg defaults to -analyzeduration 5000000 (5 seconds!) and
  // -probesize 5MB before deciding it understands the input. For
  // raw PCM this is pure overhead — every sample is exactly
  // numberOfChannels × bytesPerSample bytes, declared explicitly
  // by `-f s16le -ar -ac` below. There is nothing to analyze.
  //
  // Without these flags, the encoder eats ~4 seconds of input
  // before emitting anything (measured: firstOutput=4188ms on a
  // localhost mic→Opus pipeline). The flags target the input
  // demuxer ONLY and do not change codec behavior, so they are
  // safe for any output codec including AAC.
  //
  // What we deliberately DO NOT add:
  //   -fflags nobuffer  — affects parser internal state, can drop
  //                       initial frames; documented gotcha for
  //                       both rawvideo and AAC parsing
  //   -flags low_delay  — codec-level reorder flag, breaks AAC
  // These were the flags the older comment was warning against.
  var args = [
    '-loglevel', 'warning',
    '-probesize', '32',
    '-analyzeduration', '0',
    '-max_delay', '0',
  ];

  // Input format: s16le (default) or f32le
  var ffFmt = (self._inputFormat === 'f32') ? 'f32le' : 's16le';   // see encode()
  args.push('-f', ffFmt, '-ar', String(cfg.sampleRate), '-ac', String(cfg.numberOfChannels), '-i', 'pipe:0');
  Array.prototype.push.apply(args, codecDef.args);

  if (cfg.codecOptions && cfg.codecOptions.length) {
    Array.prototype.push.apply(args, cfg.codecOptions);
  }

  if (containerDef) {
    args.push('-f', getContainerFormat(containerDef, cfg.codec));
    Array.prototype.push.apply(args, getContainerExtra(containerDef, cfg.codec));
  }

  // ── Output-side flush flags ──
  //
  // Without these, FFmpeg buffers output packets and writes them
  // in batches. For streaming (WebRTC, RTP) this manifests as
  // bursty packet output instead of paced delivery.
  //
  // -flush_packets 1   force flush after each packet
  // -avioflags direct  bypass internal AVIO buffer
  //
  // These only change WHEN bytes are written to pipe:3, not WHAT
  // bytes — safe across all codecs.
  args.push('-flush_packets', '1', '-avioflags', 'direct');
  args.push('pipe:3');

  self._ffmpeg.start(args, ['pipe', 'ignore', 'pipe', 'pipe']);
  // FFmpeg failing (non-zero exit) closes this coder with an EncodingError
  // — see base_coder's failCoder. It used to fail silently.
  watchExit(self);

  if (containerDef && containerDef.createReader) {
    var reader = containerDef.createReader({ sampleRate: cfg.sampleRate });
    wireReader(self, reader, {
      audio: function (f) {
        // Surface the real OpusHead (captured by reader_ogg from the
        // ogg stream) so the first chunk's decoderConfig carries it —
        // browser-faithful, with the correct libopus pre-skip.
        if (reader._opusHead && !self._opusHead) self._opusHead = reader._opusHead;
        var payload = (cfg.aacFormat === 'aac') ? stripAdts(f.payload) : f.payload;
        var meta = self._takeFirstChunkMetadata(f.payload);
        self._output(new EncodedAudioChunk({
          type: 'key',
          // Reader pts are positions in this run's stream (from 0) —
          // mapped back to the input timeline (_inputTimestampAt).
          timestamp: self._inputTimestampAt(f.ptsUs),
          duration: f.durationUs, data: payload,
        }), meta);
      },
    });
  } else if (_rawBytesPerSecond(cfg)) {
    // ── Constant-rate raw output (G.711, PCM): cut into ptime frames ──
    //
    // These have no container and no packet structure, so FFmpeg's pipe
    // writes were emitted as chunks as they came: arbitrary sizes (512
    // bytes = 64 ms of G.711, in bursts), each stamped with the duration
    // of 1024 samples at the CONFIGURED rate (128 ms for 8 kHz G.711 —
    // 2.048 s of timestamps per second of audio; 21 ms at a 48 kHz input
    // config), and decoderConfig said 48000 Hz for an 8000 Hz stream. The
    // byte rate is constant, so frames are cut at exactly ptime (default
    // 20 ms: 160 bytes of G.711, what RTP carries — RFC 3551 §4.5.14),
    // with the duration of their bytes. The tail goes out at the end.
    var bps = _rawBytesPerSecond(cfg);
    var frameBytes = Math.max(1, Math.round(bps * ((cfg.ptimeMs > 0 ? cfg.ptimeMs : 20) / 1000)));
    var pending = null, posBytes = 0;
    function emitRaw(bytes) {
      var posUs = posBytes * 1e6 / bps;
      posBytes += bytes.length;
      self._output(new EncodedAudioChunk({
        type: 'key', timestamp: self._inputTimestampAt(posUs),
        duration: Math.round(bytes.length * 1e6 / bps), data: bytes,
      }), self._takeFirstChunkMetadata());
    }
    self._ffmpeg.on('data', function (chunk) {
      var buf = pending ? Buffer.concat([pending, chunk]) : chunk;
      var off = 0;
      while (buf.length - off >= frameBytes) {
        emitRaw(Buffer.from(buf.subarray(off, off + frameBytes)));
        off += frameBytes;
      }
      pending = (off < buf.length) ? Buffer.from(buf.subarray(off)) : null;
    });
    // FFmpeg exited: the last partial frame (before a flush completes —
    // flush() listens on 'close' after this does).
    self._ffmpeg.on('close', function () {
      if (pending && pending.length) { var p = pending; pending = null; emitRaw(p); }
    });
    self._ffmpeg.on('error', function (e) { self._error(e); });
  } else {
    // No reader and no constant byte rate — emit FFmpeg's writes as
    // chunks. Opus: parse the TOC byte (RFC 6716 §3.1) for the duration;
    // anything else: AAC LC's 1024 samples, what this path was written
    // for. (Every codec configured today has a reader or a byte rate.)
    var totalDurUs = 0;
    self._ffmpeg.on('data', function (chunk) {
      var sr = cfg.sampleRate || 48000;
      var durUs;
      if (cfg.codec === 'opus') {
        durUs = getOpusPacketDurationUs(chunk);
      } else {
        durUs = Math.round(1024 * 1e6 / sr);  // AAC LC default
      }
      var ptsUs = self._inputTimestampAt(totalDurUs);
      totalDurUs += durUs;
      self._output(new EncodedAudioChunk({
        type: 'key', timestamp: ptsUs, duration: durUs, data: chunk,
      }), self._takeFirstChunkMetadata());
    });
    self._ffmpeg.on('error', function (e) { self._error(e); });
  }
};

// Codecs whose output is a constant byte rate with no framing: G.711
// (8000 one-byte samples a second, mono — FFmpeg resamples to it) and
// raw PCM. 0 for the rest.
function _isG711(codec) { return codec === 'g711-alaw' || codec === 'g711-ulaw' || codec === 'alaw' || codec === 'ulaw'; }
function _rawBytesPerSecond(cfg) {
  if (_isG711(cfg.codec)) return 8000;
  if (cfg.codec === 'pcm') {
    var b = (cfg.format === 'f32' || cfg.format === 'f32le') ? 4 : 2;
    return (cfg.sampleRate || 48000) * (cfg.numberOfChannels || 1) * b;
  }
  return 0;
}

/**
 * Build the metadata for the FIRST encoded chunk, mirroring the browser
 * WebCodecs AudioEncoder which surfaces the decoder configuration (incl.
 * the AAC AudioSpecificConfig) on the first output's
 * EncodedAudioChunkMetadata.decoderConfig. Consumers like the fMP4 writer
 * need `description` to build the `esds` box; TS ignores it because ADTS
 * carries the same parameters inline. Returns undefined after the first
 * call, so subsequent chunks carry no metadata (matching the browser).
 */
AudioEncoder.prototype._takeFirstChunkMetadata = function (firstFrame) {
  if (this._decoderConfigSent) return undefined;
  this._decoderConfigSent = true;

  var cfg = this._config;
  var dc = {
    codec: _outputCodecString(cfg, firstFrame),
    // G.711 is always 8 kHz mono (FFmpeg resamples to it) — not the
    // configured input layout, which decoderConfig used to report.
    sampleRate: _isG711(cfg.codec) ? 8000 : cfg.sampleRate,
    numberOfChannels: _isG711(cfg.codec) ? 1 : cfg.numberOfChannels,
  };
  if (cfg.codec === 'aac') {
    // Only the raw ('aac') form carries an AudioSpecificConfig. Built
    // from the first ADTS header FFmpeg actually wrote, so it describes
    // the real stream; the configured values are the fallback.
    if (cfg.aacFormat === 'aac') {
      var asc = firstFrame ? audioSpecificConfigFromAdts(firstFrame) : null;
      if (!asc) {
        try {
          asc = buildAudioSpecificConfig({ profile: 'lc', sampleRate: cfg.sampleRate, channels: cfg.numberOfChannels });
        } catch (e) { asc = null; }   // non-standard sample rate: no description
      }
      if (asc) dc.description = asc;
    }
  } else if (cfg.codec === 'opus' && this._opusHead) {
    // Real OpusHead (RFC 7845 §5.1) captured from the ogg stream by
    // reader_ogg — carries the correct libopus pre-skip. Matches the
    // browser, which surfaces OpusHead as opus decoderConfig.description.
    dc.description = this._opusHead;
  }
  return { decoderConfig: dc };
};

// decoderConfig.codec: the configured string when it is a full one;
// 'aac' → 'mp4a.40.<object type>' from the ADTS header actually written.
function _outputCodecString(cfg, firstFrame) {
  if (cfg.codec !== 'aac' || cfg.codecString.indexOf('.') >= 0) return cfg.codecString;
  var h = firstFrame ? parseAdtsHeader(firstFrame) : null;
  var objectType = { main: 1, lc: 2, ssr: 3, ltp: 4 }[h && h.profile] || 2;
  return 'mp4a.40.' + objectType;
}

AudioEncoder.isConfigSupported = function (config) {
  // W3C AudioEncoderSupport carries `config` alongside `supported`;
  // see the matching note on VideoEncoder.isConfigSupported.
  // getAudioCodec THROWS NotSupportedError for a config it rejects
  // (Opus at 44100 Hz) — and it threw out of isConfigSupported
  // synchronously. W3C: an unsupported config resolves {supported:false}.
  var supported;
  try { supported = !!getAudioCodec(normalizeCodec(config.codec), config); }
  catch (e) { supported = false; }
  return Promise.resolve({
    supported: supported,
    config: _cloneAudioEncoderConfig(config),
  });
};

var _AUDIO_ENCODER_CONFIG_KEYS = [
  'codec', 'sampleRate', 'numberOfChannels', 'bitrate', 'bitrateMode',
  'aac', 'opus',
];
function _cloneAudioEncoderConfig(config) {
  var out = {};
  if (!config) return out;
  for (var i = 0; i < _AUDIO_ENCODER_CONFIG_KEYS.length; i++) {
    var k = _AUDIO_ENCODER_CONFIG_KEYS[i];
    if (config[k] !== undefined) out[k] = config[k];
  }
  return out;
}

export default AudioEncoder;
