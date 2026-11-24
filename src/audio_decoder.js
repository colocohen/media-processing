/**
 * AudioDecoder — WebCodecs-compatible audio decoder.
 * Outputs raw s16le PCM in 10ms chunks.
 *
 * Input is what a browser AudioDecoder takes (W3C codec registrations):
 *
 *   Opus  raw Opus packets, one per chunk. FFmpeg's stdin pipeline needs
 *         a container, so each packet is wrapped in an OGG page here
 *         (~30 bytes per packet) — the same bridge libwebrtc uses.
 *
 *   AAC   with description (AudioSpecificConfig): raw AAC access units.
 *         Each is given an ADTS header built from the ASC before FFmpeg.
 *         without description: ADTS frames, passed through as-is.
 *
 *   PCM   'pcm-u8' / 'pcm-s16' / 'pcm-s24' / 'pcm-s32' / 'pcm-f32'
 *         (WebCodecs registry: interleaved samples) — raw input, with
 *         the sample format, rate and channels given to FFmpeg.
 *
 *   Vorbis raw packets + description (the Xiph-laced identification,
 *         comment and setup headers): wrapped in Matroska, whose A_VORBIS
 *         CodecPrivate is exactly that description.
 *
 *   Others (MP3, FLAC, …) are passed through; FFmpeg auto-detects.
 *
 * Before this, Opus needed a non-standard `rawFrames: true` (without it
 * raw packets decoded to nothing), and AAC's ASC was written raw in front
 * of the first chunk, so the browser's default raw-AAC form did not decode.
 */

import { initCoder, configureCoder, applyCoderPrototype, watchExit, detachCoderListeners } from './base_coder.js';

// Output PCM: FFmpeg's interleaved format and bytes per sample, by the
// outputFormat's sample type.
var _FF_PCM  = { u8: 'u8', s16: 's16le', s32: 's32le', f32: 'f32le' };
var _OUT_BPS = { u8: 1, s16: 2, s32: 4, f32: 4 };
function _baseFormat(fmt) { return String(fmt || 's16').replace('-planar', ''); }
function _isG711(codec) { return codec === 'g711-alaw' || codec === 'g711-ulaw' || codec === 'alaw' || codec === 'ulaw'; }
// WebCodecs PCM codec strings → FFmpeg raw input format, bytes/sample.
// There was no PCM input at all: 'pcm-s16' had no container, so the
// chunks the Demuxer emits for a WAV/PCM track could not be decoded.
var _PCM_IN = {
  'pcm-u8':  { fmt: 'u8',    bps: 1 },
  'pcm-s16': { fmt: 's16le', bps: 2 },
  'pcm-s24': { fmt: 's24le', bps: 3 },
  'pcm-s32': { fmt: 's32le', bps: 4 },
  'pcm-f32': { fmt: 'f32le', bps: 4 },
};
import { normalizeCodec } from './utils/codec_strings.js';
import FrameQueue from './core/frame_queue.js';
import AudioData from './audio_data.js';
import OggWriter from './writer_ogg.js';
import { getOpusPacketDurationUs } from './utils/opus_utils.js';
import { parseAudioSpecificConfig, wrapAdtsWithConfig } from './utils/aac_utils.js';
import { toUint8Array } from './core/buffer_source.js';
import { getDefaultContainer, getContainer, getContainerFormat } from './containers.js';
import MKVWriter from './writer_mkv.js';

function AudioDecoder(init) {
  if (!init) throw new TypeError('AudioDecoder: init required');
  initCoder(this, init);
  this._frameIndex = 0;
  this._fq = null;
  this._bytesPerChunk = 0;

  // Input-timestamp tracking for MP-23. Each decode(chunk) pushes a
  // record; each emitted output frame consumes samples from the head
  // of the queue. This lets output timestamps follow input timing
  // (W3C WebCodecs §3.5: "let timestamp be the [[timestamp]] of the
  // EncodedAudioChunk associated with output").
  this._inputQueue = [];

  this.context = {
    state: 'unconfigured',
    codec: null,
    sampleRate: 0,
    numberOfChannels: 0,
    frameCount: 0,
  };
}

applyCoderPrototype(AudioDecoder, { role: 'decoder' });

AudioDecoder.prototype.configure = function (config) {
  if (!config || !config.codec) throw new TypeError('AudioDecoder.configure: codec required');
  configureCoder(this);

  this._config = {
    codec:            normalizeCodec(config.codec),
    sampleRate:       config.sampleRate || 48000,
    numberOfChannels: config.numberOfChannels || 2,
    outputFormat:     config.outputFormat || 's16',
    description:      config.description || null,   // e.g. AAC AudioSpecificConfig
  };

  // AAC: a description means raw access units (see header comment).
  this._aacConfig = null;
  if (this._config.codec === 'aac' && this._config.description) {
    this._aacConfig = parseAudioSpecificConfig(toUint8Array(this._config.description));
    if (!this._aacConfig) {
      throw new TypeError('AudioDecoder.configure: description is not a valid AudioSpecificConfig');
    }
  }

  this._descriptionSent = false;
  this._keyChunkRequired = true;   // reset per configure(), per spec
  this._pcmIn = _PCM_IN[this._config.codec] || null;

  // Vorbis: raw packets need the three header packets, which WebCodecs
  // carries as the description. Without one there is nothing to decode
  // with (the registry makes it required).
  this._mkv = null;
  if (this._config.codec === 'vorbis') {
    if (!this._config.description) {
      throw new TypeError('AudioDecoder.configure: vorbis requires a description (Xiph-laced header packets)');
    }
    this._mkv = new MKVWriter({ tracks: [{
      type: 'audio', codecId: 'A_VORBIS',
      codecPrivate: new Uint8Array(toUint8Array(this._config.description)),
      sampleRate: this._config.sampleRate, channels: this._config.numberOfChannels,
    }] });
  }

  // Opus chunks are raw packets (as in a browser): wrap them in OGG.
  this._oggMuxer = null;
  this._oggHeadersFed = false;
  if (this._config.codec === 'opus') {
    // The description, when given, IS the stream's OpusHead (WebCodecs
    // Opus registration): use it, so a multichannel stream keeps its
    // channel mapping family and table. A header rebuilt from the
    // channel count alone matched only the libopus default layout.
    // Its pre-skip is zeroed for the reason below.
    var head = null;
    if (this._config.description) {
      head = new Uint8Array(toUint8Array(this._config.description));
      if (head.length >= 19 && String.fromCharCode.apply(null, head.subarray(0, 8)) === 'OpusHead') {
        head[10] = 0; head[11] = 0;
      } else {
        head = null;
      }
    }
    this._oggMuxer = new OggWriter({
      opusHead:   head || undefined,
      channels:   this._config.numberOfChannels,
      // Mid-stream wrapping — don't ask the decoder to discard samples.
      // (pre-skip is only meaningful when starting a fresh encode.)
      preSkip:    0,
      vendor:     'media-processing AudioDecoder',
    });
  }

  this._frameIndex = 0;
  // Input records, one per decode(): {start, samples, timestamp} — where
  // the chunk's samples begin in this run's output PCM stream, how many
  // there are, and its timestamp. Outputs are stamped from the record
  // holding their first sample (_timestampAt), and a record leaves the
  // queue — decodeQueueSize drops by one — once the output has passed
  // all of its samples (see _emitPcm).
  this._inputQueue = [];
  this._runInputSamples = 0;
  this._outPos = 0;
  this._queueByInput = true;
  var bps = _OUT_BPS[_baseFormat(this._config.outputFormat)] || 2;
  this._bytesPerChunk = Math.floor(this._config.sampleRate / 100) * this._config.numberOfChannels * bps;
  this._fq = null;

  this.context.state = 'configured';
  this.context.codec = this._config.codec;
  this.context.sampleRate = this._config.sampleRate;
  this.context.numberOfChannels = this._config.numberOfChannels;
  this.context.frameCount = 0;
};

AudioDecoder.prototype.decode = function (chunk) {
  // Per W3C WebCodecs §3.4: throw InvalidStateError synchronously
  // if state isn't 'configured'. The previous behavior emitted via
  // the async _error callback, which means try/catch around decode()
  // wouldn't catch the bug. This mirrors MP-19's fix for VideoEncoder.
  if (this._state !== 'configured') {
    var stateErr = new Error(
      'AudioDecoder.decode: state is "' + this._state + '", not "configured"'
    );
    stateErr.name = 'InvalidStateError';
    throw stateErr;
  }
  // W3C WebCodecs §3.4 [[key chunk required]]: the first chunk after
  // configure() (and after flush()) MUST be a key chunk, else DataError.
  // Chrome enforces this. Without it a delta chunk was fed straight to
  // FFmpeg, which has no reference frame to decode against and emits
  // either nothing or visibly broken output — a silent failure exactly
  // where a loud one belongs.
  if (this._keyChunkRequired) {
    if (!chunk || chunk.type !== 'key') {
      var keyErr = new Error(
        'AudioDecoder.decode: a key chunk is required first (got ' +
        ((chunk && chunk.type) || 'no chunk') + '). Decoding cannot start ' +
        'from a delta chunk.'
      );
      keyErr.name = 'DataError';
      throw keyErr;
    }
    this._keyChunkRequired = false;
  }
  if (!chunk || !chunk.data || !chunk.data.length) {
    // chunk.data missing/empty is a programmer error — also sync per spec.
    var inputErr = new Error('AudioDecoder.decode: chunk.data required');
    inputErr.name = 'TypeError';
    throw inputErr;
  }
  if (!this._ffmpeg.running) this._startFFmpeg();

  // Raw-frames mode: wrap each packet in an OGG page before handing
  // to FFmpeg. The first decode() triggers the two mandatory header
  // pages (OpusHead + OpusTags).
  if (this._oggMuxer) {
    this._queueSize++;
    if (!this._oggHeadersFed) {
      this._ffmpeg.write(this._oggMuxer.writeHeaders());
      this._oggHeadersFed = true;
    }
    // Compute the sample count this packet represents.
    //
    // Priority order:
    //  1. caller-supplied chunk.duration (microseconds) — most accurate
    //     when known
    //  2. Opus TOC byte parsing via getOpusPacketDurationUs (RFC 6716
    //     §3.1) — handles all 32 configs and 4 packet codes correctly
    //  3. fallback to 960 (20 ms @ 48 kHz, Chrome's WebRTC default)
    //
    // The previous code hardcoded 960 in the no-duration path. That
    // produced correct OGG granule_position only for 20 ms @ 48 kHz —
    // 2x-3x drift for 10/40/60 ms or non-48 kHz Opus configs. This
    // is the symmetric mirror of the MP-10 bug (same hardcode, same
    // root cause, decoder side instead of reader side).
    var samples;
    if (chunk.duration && chunk.duration > 0) {
      samples = Math.round(chunk.duration * 48000 / 1e6);
    } else {
      var durUs = getOpusPacketDurationUs(chunk.data);
      samples = Math.round(durUs * 48000 / 1e6);
    }
    // Track input timestamp for MP-23. Convert the input's
    // 48-kHz-Opus-clock samples to output-rate samples for the
    // output PCM stream.
    var outputSamplesForChunk = Math.round(samples * this._config.sampleRate / 48000);
    this._pushInputRecord(chunk.timestamp, outputSamplesForChunk);
    this._ffmpeg.write(this._oggMuxer.writePacket(chunk.data, samples));
    return;
  }

  if (this._mkv) {
    // Vorbis: one SimpleBlock per packet, after the Matroska header.
    // Block timestamps are relative to the run's first chunk (they
    // must be >= 0); output timestamps come from the input records.
    this._queueSize++;
    if (!this._mkvHeaderFed) {
      this._ffmpeg.write(this._mkv.writeHeader());
      this._mkvHeaderFed = true;
      this._mkvBaseTs = chunk.timestamp;
    }
    this._ffmpeg.write(this._mkv.writeFrame(1, chunk.data, chunk.timestamp - this._mkvBaseTs, true));
  } else if (this._pcmIn) {
    // Raw PCM: the sample count is exact — bytes / (channels * bytes per sample).
    this._queueSize++;
    this._ffmpeg.write(chunk.data);
    var pcmFrames = Math.floor(chunk.data.length / (this._config.numberOfChannels * this._pcmIn.bps));
    this._pushInputRecord(chunk.timestamp, pcmFrames);
    return;
  } else if (this._config.codec === 'aac') {
    // Raw AAC (description given) → ADTS; ADTS chunks pass through.
    this._queueSize++;
    this._ffmpeg.write(this._aacConfig ? wrapAdtsWithConfig(chunk.data, this._aacConfig) : chunk.data);
  } else if (!this._descriptionSent && this._config.description && chunk.type === 'key') {
    // Codecs whose description is a stream header FFmpeg reads in-band
    // (FLAC's STREAMINFO): put it in front of the first chunk.
    var desc = toUint8Array(this._config.description);
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

  // Track input timestamp for MP-23. For container-wrapped streams
  // we don't know the exact output sample count per chunk in advance,
  // so we use chunk.duration if provided. If absent, we fall back to
  // estimating from a default framing (1024 samples for AAC, etc. —
  // best effort; consumers needing exact mapping should provide
  // chunk.duration).
  var outSamples;
  if (chunk.duration && chunk.duration > 0) {
    outSamples = Math.round(chunk.duration * this._config.sampleRate / 1e6);
  } else if (_isG711(this._config.codec)) {
    // One 8 kHz sample per byte — exact, unlike the 1024 guess below.
    outSamples = Math.round(chunk.data.length * this._config.sampleRate / 8000);
  } else {
    // Codec-default frame size at config sample rate. For AAC/MP3
    // this is typically 1024; for FLAC, variable. This is best-effort
    // — when the container reader is the source, it provides
    // chunk.duration so this path isn't hit.
    outSamples = 1024;
  }
  this._pushInputRecord(chunk.timestamp, outSamples);
};

AudioDecoder.prototype._pushInputRecord = function (timestamp, samples) {
  this._inputQueue.push({ start: this._runInputSamples, samples: samples, timestamp: timestamp });
  this._runInputSamples += samples;
};

/**
 * Timestamp of the output sample at `pos` (samples from the start of the
 * run): the input chunk it came from plus the offset into it.
 *
 * This replaced per-record "samplesRemaining" bookkeeping that, whenever
 * an output (10 ms) ran past the end of its record, dropped the record
 * and restarted the count at 0 — the overshoot was thrown away instead of
 * carried. Any chunk that is not a multiple of 10 ms drifted: AAC (21.33
 * ms) lost 580 ms over 2 s (0, 10, 20, 21.3, 31.3 ms...), 5 ms Opus ran
 * at half speed.
 */
AudioDecoder.prototype._timestampAt = function (pos) {
  var q = this._inputQueue, sr = this._config.sampleRate;
  for (var i = 0; i < q.length; i++) {
    if (pos < q[i].start + q[i].samples || i === q.length - 1) {
      return Math.round(q[i].timestamp + (pos - q[i].start) * 1e6 / sr);
    }
  }
  var last = this._lastRecord;   // the queue ran dry: continue the last one
  if (last) return Math.round(last.timestamp + (pos - last.start) * 1e6 / sr);
  return Math.round(pos * 1e6 / sr);
};

/** Emit decoded PCM (interleaved, the FFmpeg output format) as AudioData. */
AudioDecoder.prototype._emitPcm = function (pcmBuf) {
  var cfg = this._config;
  var base = _baseFormat(cfg.outputFormat);
  var bps = _OUT_BPS[base];
  var frames = Math.floor(pcmBuf.length / (cfg.numberOfChannels * bps));
  if (frames <= 0) return;
  if (frames * cfg.numberOfChannels * bps !== pcmBuf.length) {
    pcmBuf = pcmBuf.subarray(0, frames * cfg.numberOfChannels * bps);
  }
  var ts = this._timestampAt(this._outPos);
  this._outPos += frames;
  // Records the output has now passed entirely are done: decodeQueueSize
  // counts decode() calls, and dropped by one per 10 ms OUTPUT before —
  // twice per 20 ms packet, reaching 0 with ~40 decodes still pending.
  var q = this._inputQueue;
  while (q.length && q[0].start + q[0].samples <= this._outPos) {
    this._lastRecord = q.shift();
    if (this._queueSize > 0) this._queueSize--;
  }

  var ad = new AudioData({
    data: pcmBuf, format: base, sampleRate: cfg.sampleRate,
    numberOfChannels: cfg.numberOfChannels, numberOfFrames: frames,
    timestamp: ts,
  });
  // A planar outputFormat: FFmpeg writes interleaved, so de-interleave.
  // The AudioData used to be LABELLED planar over interleaved bytes —
  // left and right read as one smeared signal.
  if (base !== cfg.outputFormat) {
    // One plane per channel: copyTo copies ONE plane of a planar format
    // (W3C planeIndex is required).
    var planeBytes = ad.allocationSize({ format: cfg.outputFormat, planeIndex: 0 });
    var planes = new Uint8Array(planeBytes * cfg.numberOfChannels);
    for (var pc = 0; pc < cfg.numberOfChannels; pc++) {
      ad.copyTo(planes.subarray(pc * planeBytes), { format: cfg.outputFormat, planeIndex: pc });
    }
    var timestamp = ad.timestamp;
    ad.close();
    ad = new AudioData({
      data: planes, format: cfg.outputFormat, sampleRate: cfg.sampleRate,
      numberOfChannels: cfg.numberOfChannels, numberOfFrames: frames,
      timestamp: timestamp,
    });
  }
  this._output(ad);
  this._frameIndex++;
  this.context.frameCount = this._frameIndex;
};

AudioDecoder.prototype._startFFmpeg = function () {
  // One run's listeners at a time (see base_coder detachCoderListeners):
  // after a flush() this starts a new run on the same process object.
  detachCoderListeners(this._ffmpeg);
  var self = this;
  var cfg = this._config;
  var containerName = getDefaultContainer(cfg.codec);
  var containerDef = getContainer(containerName);

  // A new run (the first, or the next after flush()): its PCM stream
  // starts at 0, and an Opus run needs its own OpusHead/OpusTags pages.
  // _oggHeadersFed stayed true across a flush, so the next run got Opus
  // packets with no header: FFmpeg failed to open its input and the
  // decoder could not decode anything after its first flush().
  this._inputQueue = [];
  this._runInputSamples = 0;
  this._outPos = 0;
  this._lastRecord = null;
  if (this._oggMuxer) {
    this._oggMuxer.reset();
    this._oggHeadersFed = false;
  }
  // Likewise a Matroska (Vorbis) run starts with its own header.
  this._mkvHeaderFed = false;
  if (this._mkv) this._mkv = new MKVWriter({ tracks: this._mkv._tracks });

  // Small probesize for audio — ADTS/OGG streams are typically only a few KB.
  // No '-fflags nobuffer': it discards the packets read while probing,
  // i.e. the start of the stream. Measured on 2 s of AAC: 1856 ms
  // decoded with it, 2026 ms (all of it) without.
  var args = [
    '-hide_banner', '-loglevel', 'error',
    '-probesize', '32768', '-analyzeduration', '100000',
  ];

  // When the caller is using raw-frames mode we know the container
  // we're synthesizing (OGG), so we can tell FFmpeg explicitly — this
  // skips format auto-detection and lets FFmpeg emit PCM from the
  // very first page instead of waiting to probesize bytes. Critical
  // for real-time WebRTC use where any added latency is felt.
  if (self._oggMuxer) {
    args.push('-f', 'ogg');
  }
  if (self._mkv) args.push('-f', 'matroska');
  if (self._pcmIn) {
    args.push('-f', self._pcmIn.fmt, '-ar', String(cfg.sampleRate), '-ac', String(cfg.numberOfChannels));
  }
  // G.711 has no container and nothing to detect it by: FFmpeg was given
  // bare mu-law/A-law bytes with no -f and failed to open the input
  // ("Invalid data found") — G.711 decoding never worked. Raw input needs
  // its format, rate and channels spelled out.
  if (containerName === 'raw' && containerDef) {
    args.push('-f', getContainerFormat(containerDef, cfg.codec));
    if (_isG711(cfg.codec)) args.push('-ar', '8000', '-ac', '1');
    else args.push('-ar', String(cfg.sampleRate), '-ac', String(cfg.numberOfChannels));
  }

  // Don't specify -f for input in the default (container-wrapped) path:
  // FFmpeg auto-detects ADTS/OGG/MP3 from stream content.
  // Some FFmpeg builds lack specific demuxers (e.g. 'adts') but auto-detect works.
  // Output format: s16le (default) or f32le
  // FFmpeg writes interleaved PCM in the output format's sample type —
  // all four of them: s32 and u8 were written as s16 and labelled s32/u8
  // (half the bytes the AudioData claimed). Planar is made in _emitPcm.
  var ffOutFmt = _FF_PCM[_baseFormat(cfg.outputFormat)];

  args.push('-i', 'pipe:0');
  args.push('-vn', '-f', ffOutFmt, '-ar', String(cfg.sampleRate), '-ac', String(cfg.numberOfChannels), 'pipe:1');

  self._ffmpeg.start(args, ['pipe', 'pipe', 'pipe']);
  // FFmpeg failing (non-zero exit) closes this coder with an EncodingError
  // — see base_coder's failCoder. It used to fail silently.
  watchExit(self);

  self._fq = new FrameQueue(self._bytesPerChunk, function (pcmBuf) { self._emitPcm(pcmBuf); });
  // The stream ended (FFmpeg exited after flush()'s end of input): the
  // tail shorter than one 10 ms frame goes out too — it was dropped.
  // This runs before flush() resolves (its 'close' listener comes later).
  self._ffmpeg.on('close', function (code) {
    if (code !== 0 || !self._fq) return;
    var rest = self._fq.takeRemainder();
    if (rest.length) self._emitPcm(rest);
  });

  // Listen on stdout (pipe:1) for decoded PCM data
  self._ffmpeg.on('stdout', function (chunk) { self._fq.push(chunk); });
  self._ffmpeg.on('error', function (e) { self._error(e); });
};

AudioDecoder.isConfigSupported = function (config) {
  var name = config && config.codec ? normalizeCodec(config.codec) : null;
  var supported = !!(name && (getDefaultContainer(name) || _PCM_IN[name]));
  if (name === 'vorbis' && !(config && config.description)) supported = false;
  // W3C AudioDecoderSupport carries `config` alongside `supported`; see
  // the matching note on VideoDecoder.isConfigSupported.
  return Promise.resolve({ supported: supported, config: _cloneAudioDecoderConfig(config) });
};

var _AUDIO_DECODER_CONFIG_KEYS = [
  'codec', 'sampleRate', 'numberOfChannels', 'description',
];
function _cloneAudioDecoderConfig(config) {
  var out = {};
  if (!config) return out;
  for (var i = 0; i < _AUDIO_DECODER_CONFIG_KEYS.length; i++) {
    var k = _AUDIO_DECODER_CONFIG_KEYS[i];
    if (config[k] !== undefined) out[k] = config[k];
  }
  return out;
}

export default AudioDecoder;
