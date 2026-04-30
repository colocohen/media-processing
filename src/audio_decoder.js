/**
 * AudioDecoder — WebCodecs-compatible audio decoder.
 * Outputs raw s16le PCM in 10ms chunks.
 *
 * Two input modes:
 *
 *   1. Container-wrapped (default). Caller feeds bytes of a self-
 *      describing container stream (OGG, ADTS, MP3, FLAC). FFmpeg
 *      auto-detects the format and decodes. This matches how browser
 *      AudioDecoder is typically fed — chunks coming out of MSE or a
 *      file demuxer.
 *
 *   2. Raw frames mode (config.rawFrames === true, Opus only). Caller
 *      feeds raw Opus packets as they come out of an RTP depayloader
 *      or libopus. We wrap them in OGG pages transparently before
 *      handing to FFmpeg, because FFmpeg's decoder pipeline is
 *      stream-based and requires a container — there is no standard
 *      way to feed raw Opus frames to FFmpeg via stdin. Internal OGG
 *      wrapping is cheap (~30 bytes overhead per frame) and matches
 *      how Chrome/libwebrtc internally bridge raw opus to libopus.
 */

import { initCoder, configureCoder, applyCoderPrototype } from './base_coder.js';
import { normalizeCodec } from './codec_strings.js';
import FrameQueue from './frame_queue.js';
import AudioData from './audio_data.js';
import OggWriter from './writer_ogg.js';
import { getOpusPacketDurationUs } from './opus.js';
import { getDefaultContainer, getContainer, getContainerFormat } from './containers.js';

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

applyCoderPrototype(AudioDecoder);

AudioDecoder.prototype.configure = function (config) {
  if (!config || !config.codec) throw new TypeError('AudioDecoder.configure: codec required');
  configureCoder(this);

  this._config = {
    codec:            normalizeCodec(config.codec),
    sampleRate:       config.sampleRate || 48000,
    numberOfChannels: config.numberOfChannels || 2,
    outputFormat:     config.outputFormat || 's16',
    description:      config.description || null,   // e.g. AAC AudioSpecificConfig
    rawFrames:        !!config.rawFrames,           // raw-packet mode (Opus only)
  };

  this._descriptionSent = false;

  // Raw-frames mode currently only makes sense for Opus. For any other
  // codec the caller almost certainly has a container already (ADTS for
  // AAC, MP3 framing for MP3) so we silently ignore the flag rather
  // than error out, matching the permissive WebCodecs spec style.
  this._oggMuxer = null;
  this._oggHeadersFed = false;
  if (this._config.rawFrames && this._config.codec === 'opus') {
    this._oggMuxer = new OggWriter({
      channels:   this._config.numberOfChannels,
      // Mid-stream wrapping — don't ask the decoder to discard samples.
      // (pre-skip is only meaningful when starting a fresh encode.)
      preSkip:    0,
      vendor:     'media-processing AudioDecoder',
    });
  }

  this._frameIndex = 0;
  this._inputQueue = [];        // MP-23: clear any prior session's records
  this._consumedAtHead = 0;
  var bps = (this._config.outputFormat === 'f32' || this._config.outputFormat === 'f32-planar') ? 4 : 2;
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
    this._inputQueue.push({
      timestamp: chunk.timestamp,
      samplesRemaining: outputSamplesForChunk,
    });
    this._ffmpeg.write(this._oggMuxer.writePacket(chunk.data, samples));
    return;
  }

  // Prepend description (e.g. AAC AudioSpecificConfig) before first chunk
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

  // Track input timestamp for MP-23. For container-wrapped streams
  // we don't know the exact output sample count per chunk in advance,
  // so we use chunk.duration if provided. If absent, we fall back to
  // estimating from a default framing (1024 samples for AAC, etc. —
  // best effort; consumers needing exact mapping should provide
  // chunk.duration).
  var outSamples;
  if (chunk.duration && chunk.duration > 0) {
    outSamples = Math.round(chunk.duration * this._config.sampleRate / 1e6);
  } else {
    // Codec-default frame size at config sample rate. For AAC/MP3
    // this is typically 1024; for FLAC, variable. This is best-effort
    // — when the container reader is the source, it provides
    // chunk.duration so this path isn't hit.
    outSamples = 1024;
  }
  this._inputQueue.push({
    timestamp: chunk.timestamp,
    samplesRemaining: outSamples,
  });
};

AudioDecoder.prototype._startFFmpeg = function () {
  var self = this;
  var cfg = this._config;
  var containerName = getDefaultContainer(cfg.codec);
  var containerDef = getContainer(containerName);

  // Small probesize for audio — ADTS/OGG streams are typically only a few KB.
  // -fflags nobuffer forces FFmpeg to start decoding immediately.
  var args = [
    '-hide_banner', '-loglevel', 'error',
    '-fflags', 'nobuffer',
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

  // Don't specify -f for input in the default (container-wrapped) path:
  // FFmpeg auto-detects ADTS/OGG/MP3 from stream content.
  // Some FFmpeg builds lack specific demuxers (e.g. 'adts') but auto-detect works.
  // Output format: s16le (default) or f32le
  var outFmt = cfg.outputFormat || 's16';
  var ffOutFmt = (outFmt === 'f32' || outFmt === 'f32-planar') ? 'f32le' : 's16le';
  var bps = (outFmt === 'f32' || outFmt === 'f32-planar') ? 4 : 2;

  args.push('-i', 'pipe:0');
  args.push('-vn', '-f', ffOutFmt, '-ar', String(cfg.sampleRate), '-ac', String(cfg.numberOfChannels), 'pipe:1');

  self._ffmpeg.start(args, ['pipe', 'pipe', 'pipe']);

  var samplesPerChunk = self._bytesPerChunk / (cfg.numberOfChannels * bps);
  // _consumedAtHead tracks how many output samples the FrameQueue has
  // consumed from the head of _inputQueue. When it equals the head
  // record's samplesRemaining, we shift to the next record.
  self._consumedAtHead = 0;

  self._fq = new FrameQueue(self._bytesPerChunk, function (pcmBuf) {
    var durationUs = Math.round((samplesPerChunk * 1e6) / cfg.sampleRate);

    // Compute output timestamp from the head of _inputQueue (MP-23).
    // Per W3C WebCodecs §3.5: the output's timestamp must derive from
    // the input chunk's timestamp, not from a free-running counter.
    //
    // Math:
    //   output.timestamp = head.timestamp +
    //                      (consumedAtHead / sampleRate) microseconds
    // Then we advance consumedAtHead by samplesPerChunk; when it
    // reaches the head's allotment, we move to the next input record.
    //
    // Fallback (shouldn't happen in normal operation): if _inputQueue
    // is empty when an output arrives — i.e. FFmpeg emitted PCM with
    // no preceding decode() — extrapolate from the previous timestamp
    // using frame counter math. This preserves monotonicity at least.
    var outTimestamp;
    if (self._inputQueue.length > 0) {
      var head = self._inputQueue[0];
      var offsetUs = Math.round((self._consumedAtHead * 1e6) / cfg.sampleRate);
      outTimestamp = head.timestamp + offsetUs;
      self._consumedAtHead += samplesPerChunk;
      // Drain the head record once we've covered its full extent.
      // Use >= because FFmpeg's PCM output may slightly under- or
      // over-fill on the boundary depending on resample; we always
      // advance to keep the queue from growing without bound.
      if (self._consumedAtHead >= head.samplesRemaining) {
        self._inputQueue.shift();
        self._consumedAtHead = 0;
      }
    } else {
      // No input record matches — best-effort extrapolation. This
      // happens if FFmpeg produces output before any decode() (rare,
      // typically a startup transient) or if the stream gets out of
      // sync after an error. Use frame counter as a stable fallback.
      outTimestamp = Math.round((self._frameIndex * 1e6 * samplesPerChunk) / cfg.sampleRate);
    }

    self._output(new AudioData({
      data: pcmBuf,
      format: outFmt,
      sampleRate: cfg.sampleRate,
      numberOfChannels: cfg.numberOfChannels,
      numberOfFrames: samplesPerChunk,
      timestamp: outTimestamp,
      duration: durationUs,
    }));
    self._frameIndex++;
    self.context.frameCount = self._frameIndex;
  });

  // Listen on stdout (pipe:1) for decoded PCM data
  self._ffmpeg.on('stdout', function (chunk) { self._fq.push(chunk); });
  self._ffmpeg.on('error', function (e) { self._error(e); });
};

AudioDecoder.isConfigSupported = function (config) {
  // rawFrames mode adds support for 'opus' even when no default
  // container is registered — the decoder supplies one internally.
  if (config && config.rawFrames && normalizeCodec(config.codec) === 'opus') {
    return Promise.resolve({ supported: true });
  }
  return Promise.resolve({ supported: !!getDefaultContainer(config.codec) });
};

export default AudioDecoder;
