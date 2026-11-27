/**
 * AudioDecoder — WebCodecs-compatible audio decoder.
 *
 * Outputs (W3C WebCodecs §3, Output AudioData): one AudioData per output
 * of the codec for a chunk — for every codec FFmpeg frames (Opus, AAC,
 * MP3, FLAC, Vorbis) the decoder's frame for that chunk, stamped with
 * that chunk's timestamp; for PCM / G.711 the chunk's samples. Interleaved
 * f32 by default (what Chrome gives; DEFAULT_OUTPUT_FORMAT below — the
 * format is the implementation's: "If output uses a recognized
 * AudioSampleFormat, assign that format to [[format]]"), or the
 * library's `outputFormat` extension (u8 / s16 / s32 / f32, planar too).
 * Opus decodes at 48000 Hz whatever config.sampleRate says (Opus' rate,
 * RFC 7845 §5.1: "Input Sample Rate ... is not the sample rate to use for
 * playback"; the spec: [[sample rate]] "as determined by output"). They
 * were 10 ms s16 slices of FFmpeg's continuous PCM stream, at the
 * configured rate (Opus resampled to it).
 *
 * Input is what a browser AudioDecoder takes (W3C codec registrations):
 *
 *   Opus  raw Opus packets, one per chunk. FFmpeg's stdin pipeline needs
 *         a container, so each packet is wrapped in an OGG page here
 *         (~30 bytes per packet) — the same bridge libwebrtc uses.
 *
 *   AAC   with description (AudioSpecificConfig): raw access units;
 *         without: ADTS frames. MP3: MPEG audio frames. FLAC: frames, the
 *         description (fLaC + STREAMINFO) Matroska's A_FLAC CodecPrivate.
 *         Vorbis: raw packets + description (the Xiph-laced headers,
 *         A_VORBIS' CodecPrivate). All four go to FFmpeg in Matroska, one
 *         SimpleBlock per chunk.
 *
 *   PCM   'pcm-u8' / 'pcm-s16' / 'pcm-s24' / 'pcm-s32' / 'pcm-f32'
 *         (WebCodecs registry: interleaved samples) and G.711 — raw
 *         input, with the sample format, rate and channels given to
 *         FFmpeg.
 *
 * Which output is which chunk's (no drift): each chunk gets the run's
 * next sequence number k and goes to FFmpeg at time k × CHUNK_STEP_US —
 * the Ogg page's granule, the Matroska block's timestamp — with -copyts.
 * FFmpeg writes the PCM on pipe:1 and, from a second output of the same
 * decoded stream, a framecrc line per frame on pipe:3 (pts, size): the
 * frame's pts gives k back, its size cuts the PCM. A chunk FFmpeg drops
 * (a decoding error: FFmpeg logs it and goes on) has no frame, and the
 * frames after it keep their own k — their samples cannot move onto
 * another chunk's timestamp, whatever the codec's frame sizes. (The time
 * line is not the chunks' own timestamps: those may go backwards or
 * repeat, which FFmpeg's muxers "fix". Opus is in Ogg, not Matroska:
 * FFmpeg parses Matroska Opus, and its parser glues a broken packet to
 * the next one's timestamp.) PCM / G.711 cannot be dropped and FFmpeg
 * re-blocks them: their samples are counted (bytes per sample frame).
 *
 * Opus' pre-skip (the description's, RFC 7845 §5.1) is W3C's [[priming
 * samples to discard]] (WebCodecs §3, Opus registration §5): the first
 * pre-skip samples of a configuration's output are dropped here (FFmpeg
 * is given the head with pre-skip 0), and the output they were cut from
 * is stamped that much later ("Increment timestamp by discardedDuration").
 *
 * Before this, Opus needed a non-standard `rawFrames: true` (without it
 * raw packets decoded to nothing), and AAC's ASC was written raw in front
 * of the first chunk, so the browser's default raw-AAC form did not decode.
 */

import { initCoder, configureCoder, applyCoderPrototype, watchExit, detachCoderListeners,
  holdingCalls, holdCall, failUnsupported, drainThen, domex, failEmptyChunk, scheduleDequeue } from './base_coder.js';
import { checkAudioDecoderConfig, audioDecoderConfigSupported } from './codecs.js';

// The outputs' sample format when config.outputFormat (the library's
// extension) is not given. W3C leaves it to the implementation; Chrome
// gives 'f32'. 's16' is half the bytes through the pipe and in memory.
var DEFAULT_OUTPUT_FORMAT = 'f32';
// The run's time line (see the header): chunk k at k × 1 s. A frame's k
// is its pts over this, rounded (Matroska; a resampler's delay or a
// second frame of the same chunk stays well inside half a second) or
// floored (Ogg: a packet's pts is the previous page's granule, so the
// first one starts its duration before 1 s, the others on the second).
var CHUNK_STEP_US = 1000000;
// Output PCM: FFmpeg's interleaved format and bytes per sample, by the
// outputFormat's sample type.
var _FF_PCM  = { u8: 'u8', s16: 's16le', s32: 's32le', f32: 'f32le' };
var _FF_PCM_CODEC = { u8: 'pcm_u8', s16: 'pcm_s16le', s32: 'pcm_s32le', f32: 'pcm_f32le' };
var _OUT_BPS = { u8: 1, s16: 2, s32: 4, f32: 4 };
function _baseFormat(fmt) { return String(fmt || DEFAULT_OUTPUT_FORMAT).replace('-planar', ''); }
// Matroska codec IDs of the codecs fed in Matroska (RFC 9559's codec
// specs: A_AAC's CodecPrivate is the AudioSpecificConfig — none for ADTS
// frames, which FFmpeg's AAC decoder reads in-band —, A_FLAC's the fLaC
// marker and metadata blocks, A_VORBIS' the Xiph-laced headers).
var _MKV_CODEC = { aac: 'A_AAC', mp3: 'A_MPEG/L3', flac: 'A_FLAC', vorbis: 'A_VORBIS' };
function _isG711(codec) { return codec === 'g711-alaw' || codec === 'g711-ulaw' || codec === 'alaw' || codec === 'ulaw'; }
// The library's own 'g711-alaw' / 'g711-ulaw': an RTP payload, 8 kHz mono
// (RFC 3551 §4.5.14) whatever the config says, taken to its rate and
// channels. The W3C 'alaw' / 'ulaw' registrations make each byte one
// sample of the stream the config describes ("each byte is an A-law
// encoded PCM sample", AudioDecoderConfig sampleRate / numberOfChannels):
// they were read as 8 kHz mono too, so a 48 kHz stream came out six
// times as long (WPT audioDecoder-codec-specific ?pcm_alaw).
function _isRtpG711(codec) { return codec === 'g711-alaw' || codec === 'g711-ulaw'; }
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
import AudioData from './audio_data.js';
import OggWriter from './writer_ogg.js';
import { parseAudioSpecificConfig } from './utils/aac_utils.js';
import { toUint8Array, copyBufferSource } from './core/buffer_source.js';
import { getDefaultContainer, getContainer, getContainerFormat } from './containers.js';
import MKVWriter from './writer_mkv.js';

function AudioDecoder(init) {
  if (!init) throw new TypeError('AudioDecoder: init required');
  initCoder(this, init);
  this._frameIndex = 0;

  // One record per decode(chunk) of the run (see _pushInputRecord): its
  // sequence number, timestamp, and how much output it has given. W3C
  // WebCodecs Output AudioData: "Let timestamp be the [[timestamp]] of
  // the EncodedAudioChunk associated with output".
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
  // W3C: the WebIDL conversion and "valid AudioDecoderConfig" are
  // TypeErrors (sampleRate and numberOfChannels are required: they were
  // 48000 / 2 when missing), then a closed decoder an InvalidStateError.
  config = checkAudioDecoderConfig(config, 'AudioDecoder.configure');
  if (this._state === 'closed') throw domex('Cannot configure a closed coder', 'InvalidStateError');
  var self = this;
  this._keyChunkRequired = true;   // W3C: at the call, whenever it applies
  if (holdingCalls(this)) {
    // Queued behind a flush() in progress (base_coder holdCalls).
    this._state = 'configured';
    holdCall(this, function () { self._configureRun(config); }, false);
    return;
  }
  this._configureRun(config);
};

// Frames / chunks in flight finish with the configuration they were
// made under (drainThen); else configure now. Also for a configure()
// held behind a flush: decided when it runs.
AudioDecoder.prototype._configureRun = function (config) {
  var self = this;
  if (this._state === 'configured' && this._ffmpeg.running && this._inputQueue.length > 0) {
    // Chunks in flight: they finish with this configuration (drainThen).
    drainThen(this, function () { self._configureNow(config); });
    return;
  }
  this._configureNow(config);
};

AudioDecoder.prototype._configureNow = function (config) {
  configureCoder(this);

  this._config = {
    codec:            normalizeCodec(config.codec),
    sampleRate:       config.sampleRate,
    numberOfChannels: config.numberOfChannels,
    outputFormat:     config.outputFormat || DEFAULT_OUTPUT_FORMAT,
    description:      config.description || null,   // e.g. AAC AudioSpecificConfig
  };
  // The outputs' rate: Opus' own, 48 kHz — the config's is a hint (the
  // Opus registration says nothing of it; RFC 7845 §5.1's input rate is
  // "not the sample rate to use for playback"; libopus decodes at 8, 12,
  // 16, 24 or 48 kHz, FFmpeg's at 48). Chrome and WPT ("Test Opus decoding
  // with non-48k sample rate") give 48000. It was resampled to the config's.
  this._outRate = this._config.codec === 'opus' ? 48000 : this._config.sampleRate;

  // AAC: a description means raw access units (see header comment).
  // One that does not parse is a config the decoder cannot do
  // (NotSupportedError below; it was a TypeError, which W3C keeps for
  // invalid configs, §7.5).
  this._aacConfig = null;
  var descError = null;
  if (this._config.codec === 'aac' && this._config.description) {
    this._aacConfig = parseAudioSpecificConfig(toUint8Array(this._config.description));
    if (!this._aacConfig) descError = 'description is not a valid AudioSpecificConfig';
  }
  if (this._config.codec === 'opus') descError = _opusDescriptionError(this._config);

  this._keyChunkRequired = true;   // reset per configure(), per spec
  this._pcmIn = _PCM_IN[this._config.codec] || null;

  // AAC / MP3 / FLAC / Vorbis: one Matroska SimpleBlock per chunk. The
  // description is the track's CodecPrivate (Vorbis: the three header
  // packets the registry makes it carry; FLAC: its STREAMINFO, which went
  // in front of the first chunk in-band; AAC: the AudioSpecificConfig,
  // whose raw access units were given ADTS headers before).
  this._mkv = null;
  var mkvCodec = _MKV_CODEC[this._config.codec];
  if (mkvCodec) {
    var priv = this._config.description ? new Uint8Array(toUint8Array(this._config.description)) : undefined;
    this._mkvTrack = { type: 'audio', codecId: mkvCodec, codecPrivate: priv,
      sampleRate: this._config.sampleRate, channels: this._config.numberOfChannels };
    this._mkv = new MKVWriter({ tracks: [this._mkvTrack] });
  }

  // Opus chunks are raw packets (as in a browser): wrap them in OGG.
  this._oggMuxer = null;
  this._oggHeadersFed = false;
  var preSkip = 0;
  if (this._config.codec === 'opus') {
    // The description, when given, IS the stream's OpusHead (WebCodecs
    // Opus registration): use it, so a multichannel stream keeps its
    // channel mapping family and table. A header rebuilt from the
    // channel count alone matched only the libopus default layout.
    // Its pre-skip is zeroed for the reason below; the class drops the
    // pre-skip itself ([[priming samples to discard]], _emitFor).
    var head = null;
    if (this._config.description) {
      head = new Uint8Array(toUint8Array(this._config.description));
      if (head.length >= 19 && String.fromCharCode.apply(null, head.subarray(0, 8)) === 'OpusHead') {
        preSkip = head[10] | (head[11] << 8);
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

  // W3C [[priming samples to discard]], assigned by configure() from the
  // description (Opus registration §5: the OpusHead's pre-skip, in 48 kHz
  // samples — the output rate), in frames. A flush() does not set it
  // again: only the configuration's first outputs are trimmed.
  this._priming = Math.round(preSkip * this._outRate / 48000);

  this._frameIndex = 0;
  this._inputQueue = [];
  this._queueByInput = true;

  this.context.state = 'configured';
  this.context.codec = this._config.codec;
  this.context.sampleRate = this._outRate;
  this.context.numberOfChannels = this._config.numberOfChannels;
  this.context.frameCount = 0;

  // Check Configuration Support (codecs.js): Vorbis without its header
  // packets (the description) cannot be decoded.
  if (!audioDecoderConfigSupported(config, !descError)) {
    failUnsupported(this, domex("AudioDecoder.configure: unsupported config (codec '" + config.codec + "')" +
      (descError ? ': ' + descError : ''), 'NotSupportedError'));
  }
};

AudioDecoder.prototype.decode = function (chunk) {
  // WebIDL: `chunk` is converted to an EncodedAudioChunk before the method
  // steps run, so a missing one is a TypeError even when the state is not
  // "configured" (it was checked after the state and the key-chunk check:
  // decode() with no argument threw InvalidStateError, or DataError).
  if (!chunk || !chunk.data) {
    throw new TypeError('AudioDecoder.decode: chunk must be an EncodedAudioChunk');
  }
  // Per W3C WebCodecs §3.4: throw InvalidStateError synchronously
  // if state isn't 'configured'. The previous behavior emitted via
  // the async _error callback, which means try/catch around decode()
  // wouldn't catch the bug. This mirrors MP-19's fix for VideoEncoder.
  if (this._state !== 'configured') {
    var stateErr = domex(
      'AudioDecoder.decode: state is "' + this._state + '", not "configured"', 'InvalidStateError');
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
      var keyErr = domex(
        'AudioDecoder.decode: a key chunk is required first (got ' +
        ((chunk && chunk.type) || 'no chunk') + '). Decoding cannot start ' +
        'from a delta chunk.', 'DataError');
      throw keyErr;
    }
    this._keyChunkRequired = false;
  }
  this._queueSize++;
  if (holdingCalls(this)) {
    // Queued behind a flush() in progress (base_coder holdCalls).
    var self = this;
    holdCall(this, function () { self._decodeNow(chunk); }, true);
    return;
  }
  this._decodeNow(chunk);
};

AudioDecoder.prototype._decodeNow = function (chunk) {
  if (!chunk.data.length) { failEmptyChunk(this, 'AudioDecoder.decode'); return; }
  if (!this._ffmpeg.running) this._startFFmpeg();
  var k = this._runSeq++;
  var at = k * CHUNK_STEP_US;

  if (this._oggMuxer) {
    // One Ogg page per packet, after the two header pages. The page's
    // granule is the END of its packet, and FFmpeg's Ogg demuxer times a
    // packet at the previous page's granule: page k ends at (k + 1) s, so
    // packet k is at k s (the first, with no page before it, at 1 s
    // minus its TOC duration). Nothing here needs the packet's length.
    if (!this._oggHeadersFed) {
      this._ffmpeg.write(this._oggMuxer.writeHeaders());
      this._oggHeadersFed = true;
    }
    this._pushInputRecord(chunk.timestamp, k);
    this._ffmpeg.write(this._oggMuxer._buildPage(toUint8Array(chunk.data), 0, (k + 1) * 48000 * CHUNK_STEP_US / 1e6));
    return;
  }
  if (this._mkv) {
    if (!this._mkvHeaderFed) {
      this._ffmpeg.write(this._mkv.writeHeader());
      this._mkvHeaderFed = true;
    }
    this._pushInputRecord(chunk.timestamp, k);
    this._ffmpeg.write(this._mkv.writeFrame(1, toUint8Array(chunk.data), at, true));
    return;
  }

  // PCM / G.711: a byte stream FFmpeg re-blocks. The chunk's samples end
  // where its bytes end in the run (cumulative, so a sample frame split
  // over two chunks is not lost to rounding): bytes / (channels × bytes
  // per sample); the library's RTP G.711, 8 kHz mono, at the output rate.
  this._ffmpeg.write(chunk.data);
  this._runInBytes += chunk.data.length;
  var ch = Math.max(1, this._config.numberOfChannels);
  var end;
  if (this._pcmIn) end = Math.floor(this._runInBytes / (ch * this._pcmIn.bps));
  else if (_isRtpG711(this._config.codec)) end = Math.round(this._runInBytes * this._outRate / 8000);
  else end = Math.floor(this._runInBytes / ch);   // W3C alaw / ulaw: a byte a sample
  var rec = this._pushInputRecord(chunk.timestamp, k);
  rec.end = end;
};

AudioDecoder.prototype._pushInputRecord = function (timestamp, k) {
  // consumed: the output frames given so far for this chunk, the ones
  // discarded as priming included (a later output of the same chunk is
  // stamped after them); counted: it has left decodeQueueSize.
  var rec = { k: k, timestamp: timestamp, consumed: 0, counted: false, end: 0 };
  this._inputQueue.push(rec);
  return rec;
};

/**
 * The record leaves decodeQueueSize (once): at its first output, or when
 * it is done without one (FFmpeg dropped it, or gave nothing for it, as
 * Vorbis' first packet). decodeQueueSize counts decode() calls; every
 * decrement runs Schedule Dequeue Event (base_coder's output wrapper does
 * not: this coder counts by input).
 */
AudioDecoder.prototype._countRecord = function (rec) {
  if (rec.counted) return;
  rec.counted = true;
  if (this._queueSize > 0) { this._queueSize--; scheduleDequeue(this); }
};

/** The records before `rec`, and `rec` when `inclusive`, are done. */
AudioDecoder.prototype._finishUpTo = function (k, inclusive) {
  var q = this._inputQueue;
  while (q.length && (q[0].k < k || (inclusive && q[0].k === k))) {
    var r = q.shift();
    this._lastRecord = r;
    this._countRecord(r);
  }
};

/**
 * One output of the chunk `rec` (interleaved PCM in the output format).
 * W3C Output AudioData: [[priming samples to discard]] come off its
 * front ("Remove the first discardedFrames frames from output"), and its
 * timestamp is the chunk's plus the discarded duration ("Increment
 * timestamp by discardedDuration") — plus, for a chunk's second output,
 * the frames before it.
 */
AudioDecoder.prototype._emitFor = function (rec, pcmBuf) {
  var cfg = this._config;
  var base = _baseFormat(cfg.outputFormat);
  var frameBytes = cfg.numberOfChannels * _OUT_BPS[base];
  var frames = Math.floor(pcmBuf.length / frameBytes);
  if (frames <= 0) return;
  this._countRecord(rec);
  var before = rec.consumed;
  rec.consumed += frames;
  var discarded = Math.min(frames, this._priming);
  this._priming -= discarded;
  frames -= discarded;
  if (frames <= 0) return;
  var ts = rec.timestamp + Math.round((before + discarded) * 1e6 / this._outRate);
  pcmBuf = pcmBuf.subarray(discarded * frameBytes, (discarded + frames) * frameBytes);

  var ad = new AudioData({
    data: pcmBuf, format: base, sampleRate: this._outRate,
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
    ad.close();
    ad = new AudioData({
      data: planes, format: cfg.outputFormat, sampleRate: this._outRate,
      numberOfChannels: cfg.numberOfChannels, numberOfFrames: frames,
      timestamp: ts,
    });
  }
  this._output(ad);
  this._frameIndex++;
  this.context.frameCount = this._frameIndex;
};

// This run's FFmpeg, and no reset() / close() / failure since (they
// move _configEpoch): an output callback may end it mid-loop.
AudioDecoder.prototype._live = function (run) {
  return this._run === run && this._configEpoch === run.epoch;
};

// ── The PCM FFmpeg writes (pipe:1), as it comes ──

AudioDecoder.prototype._pcmPush = function (buf) {
  this._pcm.push(buf);
  this._pcmLen += buf.length;
};

/** The next n bytes of PCM (n <= _pcmLen). */
AudioDecoder.prototype._pcmTake = function (n) {
  var out = (this._pcm[0].length >= n) ? null : new Uint8Array(n);
  if (!out) {
    var head = this._pcm[0];
    var part = head.subarray(0, n);
    if (head.length === n) this._pcm.shift(); else this._pcm[0] = head.subarray(n);
    this._pcmLen -= n;
    return part;
  }
  var o = 0;
  while (o < n) {
    var h = this._pcm[0], m = Math.min(h.length, n - o);
    out.set(h.subarray(0, m), o);
    o += m;
    if (m === h.length) this._pcm.shift(); else this._pcm[0] = h.subarray(m);
  }
  this._pcmLen -= n;
  return out;
};

// ── Framed codecs: FFmpeg's frames, from the framecrc lines (pipe:3) ──

/** framecrc text: "#tb 0: 1/<den>", then "stream, dts, pts, duration, size, checksum". */
AudioDecoder.prototype._framesText = function (text) {
  var lines = (this._lineBuf + text).split('\n');
  this._lineBuf = lines.pop();
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    if (!l) continue;
    if (l.charAt(0) === '#') {
      var tb = /^#tb 0: (\d+)\/(\d+)/.exec(l);
      if (tb) this._tb = +tb[1] / +tb[2];
      continue;
    }
    var f = l.split(',');
    if (f.length < 5) continue;
    this._frames.push({ pts: +f[2], size: +f[4] });
  }
};

/** Pair each frame line with its bytes of PCM and give it out. */
AudioDecoder.prototype._drainFrames = function (run) {
  while (this._live(run) && this._frames.length && this._pcmLen >= this._frames[0].size) {
    var fr = this._frames.shift();
    this._onFrame(fr.pts, this._pcmTake(fr.size));
  }
};

/** A decoded frame: its chunk is the one whose k its pts gives. */
AudioDecoder.prototype._onFrame = function (pts, bytes) {
  var steps = pts * this._tb * 1e6 / CHUNK_STEP_US;
  var k = this._oggMuxer ? Math.floor(steps + 1e-9) : Math.round(steps);
  this._finishUpTo(k, false);
  var q = this._inputQueue;
  var rec = (q.length && q[0].k === k) ? q[0]
    : (this._lastRecord && this._lastRecord.k === k) ? this._lastRecord
    : (q[0] || this._lastRecord);   // not on the time line (cannot happen): the nearest chunk
  if (rec) this._emitFor(rec, bytes);
};

// ── PCM / G.711: the chunks' samples, counted ──

AudioDecoder.prototype._drainCounted = function (run, atEnd) {
  var frameBytes = this._config.numberOfChannels * _OUT_BPS[_baseFormat(this._config.outputFormat)];
  var q = this._inputQueue;
  while (this._live(run) && q.length) {
    var rec = q[0];
    var want = rec.end - this._outPos;
    var have = Math.floor(this._pcmLen / frameBytes);
    var last = q.length === 1;
    if (!atEnd && have < want) return;
    // at the end of the stream the last chunk takes what is left (a
    // resampler's tail), the others what there is of theirs
    var n = atEnd ? (last ? have : Math.min(have, Math.max(0, want))) : Math.max(0, want);
    q.shift();
    this._lastRecord = rec;
    this._outPos += n;
    if (n > 0) this._emitFor(rec, this._pcmTake(n * frameBytes));
    this._countRecord(rec);
  }
};

AudioDecoder.prototype._startFFmpeg = function () {
  // One run's listeners at a time (see base_coder detachCoderListeners):
  // after a flush() this starts a new run on the same process object.
  detachCoderListeners(this._ffmpeg);
  var self = this;
  var cfg = this._config;
  var containerName = getDefaultContainer(cfg.codec);
  var containerDef = getContainer(containerName);

  // A new run (the first, or the next after flush()): its sequence
  // numbers and PCM stream start at 0, and an Opus run needs its own
  // OpusHead/OpusTags pages. _oggHeadersFed stayed true across a flush,
  // so the next run got Opus packets with no header: FFmpeg failed to
  // open its input and the decoder could not decode anything after its
  // first flush().
  var run = this._run = { epoch: this._configEpoch };
  var framed = !!(this._oggMuxer || this._mkv);
  this._inputQueue = [];
  this._runSeq = 0;
  this._runInBytes = 0;
  this._outPos = 0;
  this._lastRecord = null;
  this._pcm = [];
  this._pcmLen = 0;
  this._frames = [];
  this._lineBuf = '';
  this._tb = 1 / this._outRate;
  if (this._oggMuxer) {
    this._oggMuxer.reset();
    this._oggHeadersFed = false;
  }
  // Likewise a Matroska run starts with its own header (and cluster).
  this._mkvHeaderFed = false;
  if (this._mkv) this._mkv = new MKVWriter({ tracks: [this._mkvTrack] });

  // Small probesize for audio — the input is a few KB. No '-fflags
  // nobuffer': it discards the packets read while probing, i.e. the start
  // of the stream. Measured on 2 s of AAC: 1856 ms decoded with it,
  // 2026 ms (all of it) without.
  // Raw PCM / G.711 is described in full by -f / -ar / -ac: nothing to
  // probe. With the 32 KB probe FFmpeg gave no output before 32 KB of
  // input — all of a short stream at its end (WPT audioDecoder-reconfigure
  // "Test reset() while configure() waits ...", 8 / 16 / 24-bit PCM and
  // G.711: the 32-bit files are bigger than the probe).
  var args = [
    '-hide_banner', '-loglevel', 'error',
    '-probesize', framed ? '32768' : '32', '-analyzeduration', framed ? '100000' : '0',
  ];

  // The container we synthesize is named (no format detection, PCM from
  // the very first page — what real-time WebRTC needs), and its
  // timestamps are kept as they are (-copyts: the time line above).
  if (self._oggMuxer) args.push('-copyts', '-f', 'ogg');
  if (self._mkv) args.push('-copyts', '-f', 'matroska');
  if (self._pcmIn) {
    args.push('-f', self._pcmIn.fmt, '-ar', String(cfg.sampleRate), '-ac', String(cfg.numberOfChannels));
  }
  // G.711 has no container and nothing to detect it by: FFmpeg was given
  // bare mu-law/A-law bytes with no -f and failed to open the input
  // ("Invalid data found") — G.711 decoding never worked. Raw input needs
  // its format, rate and channels spelled out.
  if (containerName === 'raw' && containerDef) {
    args.push('-f', getContainerFormat(containerDef, cfg.codec));
    if (_isRtpG711(cfg.codec)) args.push('-ar', '8000', '-ac', '1');
    else args.push('-ar', String(cfg.sampleRate), '-ac', String(cfg.numberOfChannels));
  }

  // FFmpeg writes interleaved PCM in the output format's sample type —
  // all four of them: s32 and u8 were written as s16 and labelled s32/u8
  // (half the bytes the AudioData claimed). Planar is made in _emitFor.
  var base = _baseFormat(cfg.outputFormat);
  var outArgs = ['-vn', '-ar', String(self._outRate), '-ac', String(cfg.numberOfChannels)];
  args.push('-i', 'pipe:0');
  if (framed) {
    // The same decoded stream twice, through the same filters: PCM on
    // pipe:1, and a framecrc line per frame (its pts and byte size) on
    // pipe:3.
    args.push('-map', '0:a:0');
    args.push.apply(args, outArgs);
    args.push('-f', _FF_PCM[base], 'pipe:1', '-map', '0:a:0');
    args.push.apply(args, outArgs);
    args.push('-c:a', _FF_PCM_CODEC[base], '-f', 'framecrc', 'pipe:3');
  } else {
    args.push.apply(args, outArgs);
    args.push('-f', _FF_PCM[base], 'pipe:1');
  }

  self._ffmpeg.start(args, framed ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe']);
  // FFmpeg failing (non-zero exit) closes this coder with an EncodingError
  // — see base_coder's failCoder. It used to fail silently.
  watchExit(self);

  // The stream ended (FFmpeg exited after flush()'s end of input): every
  // byte of both pipes is in (Node's 'close' comes after them). The last
  // frames go out, and the chunks with no output leave the queue. This
  // runs before flush() resolves (its 'close' listener comes later).
  self._ffmpeg.on('close', function (code) {
    if (code !== 0 || !self._live(run)) return;
    if (framed) {
      self._framesText('\n');
      self._drainFrames(run);
      // PCM no line describes (none should be): the last chunk's
      if (self._live(run) && self._pcmLen) {
        var rec = self._inputQueue[self._inputQueue.length - 1] || self._lastRecord;
        var rest = self._pcmTake(self._pcmLen);
        if (rec) self._emitFor(rec, rest);
      }
      if (self._live(run)) self._finishUpTo(Infinity, true);
    } else {
      self._drainCounted(run, true);
    }
  });

  self._ffmpeg.on('stdout', function (chunk) {
    if (!self._live(run)) return;
    self._pcmPush(chunk);
    if (framed) self._drainFrames(run); else self._drainCounted(run, false);
  });
  if (framed) {
    self._ffmpeg.on('data', function (chunk) {
      if (!self._live(run)) return;
      self._framesText(typeof chunk === 'string' ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length).toString('latin1'));
      self._drainFrames(run);
    });
  }
  self._ffmpeg.on('error', function (e) { self._error(e); });
};

AudioDecoder.isConfigSupported = function (config) {
  // W3C: an invalid config rejects with a TypeError; supported is Check
  // Configuration Support (codecs.js), with an AAC description that has
  // to be an AudioSpecificConfig. AudioDecoderSupport carries `config`
  // alongside `supported`; see the matching note on
  // VideoDecoder.isConfigSupported.
  var c;
  try { c = checkAudioDecoderConfig(config, 'AudioDecoder.isConfigSupported'); }
  catch (e) { return Promise.reject(e); }
  var nc = normalizeCodec(c.codec);
  var descOk = !(nc === 'aac' && c.description &&
    !parseAudioSpecificConfig(toUint8Array(c.description))) &&
    !(nc === 'opus' && _opusDescriptionError(c));
  return Promise.resolve({ supported: audioDecoderConfigSupported(c, descOk), config: _cloneAudioDecoderConfig(c) });
};

/**
 * Opus (WebCodecs Opus registration §3, RFC 7845 §5.1): a description is
 * an Identification Header — "OpusHead", 19 bytes, and with a channel
 * mapping family other than 0 the stream count, coupled count and one
 * mapping byte per channel (21 + C). Without one the stream is family 0,
 * one or two channels. Anything else is a config the decoder cannot do
 * (NotSupportedError): a short or foreign description was dropped
 * silently, and 3 or more channels without one were decoded as stereo.
 * The error text, or null.
 */
function _opusDescriptionError(config) {
  if (!config.description) {
    return config.numberOfChannels > 2
      ? 'more than 2 channels need a description (an OpusHead with a channel mapping table)' : null;
  }
  var h = toUint8Array(config.description);
  if (h.length < 19 || String.fromCharCode.apply(null, h.subarray(0, 8)) !== 'OpusHead') {
    return 'description is not a valid OpusHead';
  }
  if (h[18] !== 0 && h.length < 21 + h[9]) return 'description is not a valid OpusHead (channel mapping table too short)';
  return null;
}

var _AUDIO_DECODER_CONFIG_KEYS = [
  'codec', 'sampleRate', 'numberOfChannels', 'description',
];
function _cloneAudioDecoderConfig(config) {
  var out = {};
  if (!config) return out;
  for (var i = 0; i < _AUDIO_DECODER_CONFIG_KEYS.length; i++) {
    var k = _AUDIO_DECODER_CONFIG_KEYS[i];
    if (config[k] !== undefined) out[k] = (k === 'description') ? copyBufferSource(config[k]) : config[k];
  }
  return out;
}

export default AudioDecoder;
