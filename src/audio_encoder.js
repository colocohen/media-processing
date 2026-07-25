/**
 * AudioEncoder — WebCodecs-compatible audio encoder.
 * Validates input data alignment.
 */

import { initCoder, configureCoder, wireReader, applyCoderPrototype } from './base_coder.js';
import { normalizeCodec } from './utils/codec_strings.js';
import { EncodedAudioChunk } from './encoded_chunk.js';
import { getAudioCodec } from './codecs.js';
import { getDefaultContainer, getContainer, getContainerFormat, getContainerExtra } from './containers.js';
import { getOpusPacketDurationUs } from './utils/opus_utils.js';
import { buildAudioSpecificConfig } from './utils/aac_utils.js';

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

applyCoderPrototype(AudioEncoder);

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

  this._config = {
    codec: normalizedCodec,
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

  this._encodeCount = 0;
  // ── W3C timestamp anchoring ──
  // Browser AudioEncoder derives output chunk timestamps from the INPUT
  // AudioData timeline. Output pts = _basePtsUs (first input's timestamp)
  // + accumulated encoded duration + _gapAccumUs (input gaps re-inserted).
  // With 0-based sources (media_source_sink counters) base ≈ 0 → identical
  // to the old counter behavior, so muxer consumers see no change; with
  // wallclock/capture-anchored sources (live WebRTC, browser parity) the
  // output now follows the input timeline — keeping long-run A/V sync
  // even across capture gaps (DTX, source hiccups).
  this._basePtsUs = null;      // first input AudioData.timestamp
  this._inputAccumUs = 0;      // total input duration fed
  this._gapAccumUs = 0;        // detected input-timeline gaps, re-applied to output
  this._decoderConfigSent = false;  // emit decoderConfig on first output chunk
  this._opusHead = null;            // captured from ogg stream (opus only)
  this.context.state = 'configured';
  this.context.codec = this._config.codec;
  this.context.sampleRate = this._config.sampleRate;
  this.context.numberOfChannels = this._config.numberOfChannels;
  this.context.frameCount = 0;
};

AudioEncoder.prototype.encode = function (audioData) {
  if (this._state !== 'configured') {
    this._error(new Error('AudioEncoder: not configured'));
    return;
  }
  if (!audioData || !audioData.data) {
    this._error(new Error('AudioEncoder.encode: audioData.data required'));
    return;
  }

  // ── Input-timeline tracking (W3C timestamp anchoring) ──
  // Gap detection: if this AudioData's timestamp is ahead of where the
  // continuous input timeline says it should be (> 100ms), the source
  // skipped time (DTX / dropped capture). FFmpeg encodes the PCM stream
  // as continuous, so we re-insert the gap into the OUTPUT timeline via
  // _gapAccumUs. (Applied immediately — frames already in the FFmpeg
  // pipe shift with it; the error is bounded by pipeline depth, tens of
  // ms, only at gap moments — vs unbounded cumulative drift without it.)
  if (typeof audioData.timestamp === 'number' && isFinite(audioData.timestamp)) {
    if (this._basePtsUs === null) {
      this._basePtsUs = audioData.timestamp;
    } else {
      var _expectedTs = this._basePtsUs + this._inputAccumUs + this._gapAccumUs;
      var _aheadUs = audioData.timestamp - _expectedTs;
      if (_aheadUs > 100000) this._gapAccumUs += _aheadUs;
    }
  } else if (this._basePtsUs === null) {
    this._basePtsUs = 0;
  }
  var _inDurUs = 0;
  if (typeof audioData.numberOfFrames === 'number' && audioData.sampleRate) {
    _inDurUs = Math.round(audioData.numberOfFrames * 1e6 / audioData.sampleRate);
  } else if (typeof audioData.duration === 'number') {
    _inDurUs = audioData.duration;
  }
  this._inputAccumUs += _inDurUs;

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

  // Remember input format for FFmpeg startup
  if (!this._inputFormat) this._inputFormat = fmt;

  if (!this._ffmpeg.running) {
    // ════════════════════════ DIAGNOSTIC ════════════════════════
    // FFmpeg has died and is being respawned. Log the count and
    // (critically) the listener count BEFORE _startFFmpeg attaches
    // a new one. Listener doubling (count > 0 here) indicates the
    // pre-fix bug; post-fix this should always log 0.
    var preCount = this._ffmpeg._ee
      ? this._ffmpeg._ee.listenerCount('data') : 0;
    this._stats.ffmpegRestarts++;
    console.log('[audio_encoder] FFMPEG RESTART @ ' +
                new Date().toISOString().slice(11, 23) +
                ' encodeCount=' + this._encodeCount +
                ' restarts=' + this._stats.ffmpegRestarts +
                ' listenersBefore=' + preCount);
    // ═══════════════════════════════════════════════════════════
    this._startFFmpeg();
  }

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
  var ok = this._ffmpeg.write(audioData.data);
  this._encodeCount++;
  this.context.frameCount = this._encodeCount;

  if (!ok) {
    this._stats.backpressureEvents++;
  }

  return ok;
};

AudioEncoder.prototype._startFFmpeg = function () {
  var self = this;
  var cfg = this._config;

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
  self._ffmpeg.removeAllListeners('data');
  self._ffmpeg.removeAllListeners('error');
  self._ffmpeg.removeAllListeners('close');

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
  var ffFmt = (self._inputFormat === 'f32' || self._inputFormat === 'f32-planar') ? 'f32le' : 's16le';
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

  if (containerDef && containerDef.createReader) {
    var reader = containerDef.createReader({ sampleRate: cfg.sampleRate });
    wireReader(self, reader, {
      audio: function (f) {
        // Surface the real OpusHead (captured by reader_ogg from the
        // ogg stream) so the first chunk's decoderConfig carries it —
        // browser-faithful, with the correct libopus pre-skip.
        if (reader._opusHead && !self._opusHead) self._opusHead = reader._opusHead;
        self._output(new EncodedAudioChunk({
          type: 'key',
          // Reader pts are 0-based per-stream — anchor them to the input
          // timeline the same way as the raw path.
          timestamp: (self._basePtsUs || 0) + self._gapAccumUs + f.ptsUs,
          duration: f.durationUs, data: f.payload,
        }), self._takeFirstChunkMetadata());
      },
    });
  } else {
    // No reader — emit raw encoded data chunks directly.
    //
    // PTS is accumulated in microseconds, with each chunk's duration
    // derived from its actual content:
    //
    //   Opus: parse the TOC byte (RFC 6716 §3.1) via the shared
    //         getOpusPacketDurationUs() helper. This stays correct
    //         across all six Opus frame durations (2.5 / 5 / 10 /
    //         20 / 40 / 60 ms) without the encoder needing prior
    //         knowledge of -frame_duration.
    //   Other codecs: AAC LC's 1024-sample frame is the historical
    //         default this code path was written for. Other codecs
    //         that fall through here would need their own duration
    //         calc, but in practice they ship with a container reader.
    //
    // Using a wrong frame size produces metallic / "alien" audio:
    // the receiver's decoder triggers Packet Loss Concealment to
    // synthesize the apparent gap, firing 50 times per second.
    var totalDurUs = 0;
    self._ffmpeg.on('data', function (chunk) {
      var sr = cfg.sampleRate || 48000;
      var durUs;
      if (cfg.codec === 'opus') {
        durUs = getOpusPacketDurationUs(chunk);
      } else {
        durUs = Math.round(1024 * 1e6 / sr);  // AAC LC default
      }
      // Anchor to the input timeline (see configure() comment): base +
      // gaps + accumulated encoded duration. 0-based inputs → unchanged.
      var ptsUs = (self._basePtsUs || 0) + self._gapAccumUs + totalDurUs;
      totalDurUs += durUs;
      self._output(new EncodedAudioChunk({
        type: 'key', timestamp: ptsUs, duration: durUs, data: chunk,
      }), self._takeFirstChunkMetadata());
    });
    self._ffmpeg.on('error', function (e) { self._error(e); });
  }
};

/**
 * Build the metadata for the FIRST encoded chunk, mirroring the browser
 * WebCodecs AudioEncoder which surfaces the decoder configuration (incl.
 * the AAC AudioSpecificConfig) on the first output's
 * EncodedAudioChunkMetadata.decoderConfig. Consumers like the fMP4 writer
 * need `description` to build the `esds` box; TS ignores it because ADTS
 * carries the same parameters inline. Returns undefined after the first
 * call, so subsequent chunks carry no metadata (matching the browser).
 */
AudioEncoder.prototype._takeFirstChunkMetadata = function () {
  if (this._decoderConfigSent) return undefined;
  this._decoderConfigSent = true;

  var cfg = this._config;
  var dc = {
    codec: cfg.codec,
    sampleRate: cfg.sampleRate,
    numberOfChannels: cfg.numberOfChannels,
  };
  if (cfg.codec === 'aac') {
    try {
      dc.description = buildAudioSpecificConfig({
        profile: 'lc',
        sampleRate: cfg.sampleRate,
        channels: cfg.numberOfChannels,
      });
    } catch (e) {
      // Non-standard sample rate: omit description rather than crash.
      // The fMP4 esds path will surface its own error if it truly needs it.
    }
  } else if (cfg.codec === 'opus' && this._opusHead) {
    // Real OpusHead (RFC 7845 §5.1) captured from the ogg stream by
    // reader_ogg — carries the correct libopus pre-skip. Matches the
    // browser, which surfaces OpusHead as opus decoderConfig.description.
    dc.description = this._opusHead;
  }
  return { decoderConfig: dc };
};

AudioEncoder.isConfigSupported = function (config) {
  return Promise.resolve({ supported: !!getAudioCodec(config.codec, config) });
};

export default AudioEncoder;
