/**
 * Muxer — Write encoded video + audio chunks to a container file.
 *
 * Usage:
 *   var muxer = new Muxer({
 *     file: 'output.mp4',
 *     video: { codec: 'h264', width: 1920, height: 1080, framerate: 30 },
 *     audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
 *   });
 *   muxer.addVideoChunk(encodedVideoChunk);
 *   muxer.addAudioChunk(encodedAudioChunk);
 *   muxer.finalize(function () {
 *     // Container trailer written; the output file is complete.
 *   });
 *
 * finalize() also returns a Promise when no callback is given.
 *
 * Video is fed through stdin (pipe:0), audio through pipe:3.
 * FFmpeg muxes them into the output container.
 *
 * Chunks are taken exactly as WebCodecs encoders emit them (browser or
 * this library's Node encoders) and framed for FFmpeg's raw demuxers:
 *
 *   H.264 / H.265   → Annex-B (length-prefixed chunks converted, the
 *                     description's parameter sets put before key chunks)
 *   VP8 / VP9 / AV1 → IVF (IVFWriter header + one record per chunk)
 *   AAC             → ADTS (raw chunks get a header built from the
 *                     description's AudioSpecificConfig)
 *   Opus            → OGG (OggWriter headers + one page per packet)
 *
 * Pass each chunk's metadata along (addVideoChunk(chunk, metadata)): the
 * first one carries decoderConfig.description, which decides the form.
 */

import FFmpegProcess from './ffmpeg_process.js';
import EventEmitter from './core/events.js';
import { normalizeCodec } from './utils/codec_strings.js';
import { avccToAnnexb, bitstreamFromDescription } from './utils/nalu_utils.js';
import { adtsHeaderLength, parseAudioSpecificConfig, wrapAdtsWithConfig } from './utils/aac_utils.js';
import { toUint8Array } from './core/buffer_source.js';
import IVFWriter from './writer_ivf.js';
import OggWriter from './writer_ogg.js';

var FORMAT_MAP = {
  '.mp4': 'mp4', '.m4v': 'mp4', '.m4a': 'mp4',
  '.webm': 'webm', '.mkv': 'matroska', '.mka': 'matroska',
  '.ogg': 'ogg', '.avi': 'avi', '.ts': 'mpegts',
};

// Input format flag for FFmpeg based on codec
var VIDEO_INPUT_FMT = {
  h264: 'h264', h265: 'hevc', vp8: 'ivf', vp9: 'ivf', av1: 'ivf',
};
// FFmpeg's ADTS demuxer is named 'aac' — there is no 'adts' demuxer
// ('adts' is only a muxer), so '-f adts' made every AAC mux fail.
var AUDIO_INPUT_FMT = {
  aac: 'aac', opus: 'ogg', vorbis: 'ogg', mp3: 'mp3', flac: 'flac',
  alaw: 'alaw', ulaw: 'mulaw', 'g711-alaw': 'alaw', 'g711-ulaw': 'mulaw',
};

function Muxer(opts) {
  if (!opts) opts = {};
  this._ee = new EventEmitter();
  this._file = opts.file || null;
  this._format = opts.format || _guessFormat(opts.file);
  this._video = opts.video || null;
  this._audio = opts.audio || null;
  this._ffmpeg = new FFmpegProcess(opts);
  this._started = false;
  this._proc = null;
}

Muxer.prototype.on = function (ev, fn) { this._ee.on(ev, fn); };
Muxer.prototype.off = function (ev, fn) { this._ee.off(ev, fn); };

/**
 * Add an EncodedVideoChunk. For H.264 / H.265 pass the encoder's
 * metadata too: its decoderConfig.description says whether the chunks
 * are length-prefixed ('avc'/'hevc', the WebCodecs default) or Annex-B.
 * FFmpeg reads raw H.264/H.265 as Annex-B, so length-prefixed chunks are
 * converted and the parameter sets are put in front of every key chunk.
 */
Muxer.prototype.addVideoChunk = function (chunk, metadata) {
  if (!this._started) this._start();
  if (!chunk.data) return;
  var codec = normalizeCodec((this._video && this._video.codec) || 'h264');
  if (codec === 'vp8' || codec === 'vp9' || codec === 'av1') {
    // Raw frames → IVF records (the ivf demuxer needs the framing).
    if (!this._ivf) {
      this._ivf = new IVFWriter({ codec: codec, width: this._video.width || 0, height: this._video.height || 0 });
      this._ffmpeg.write(this._ivf.writeHeader());
    }
    this._ffmpeg.write(this._ivf.writeFrame(chunk.data, chunk.timestamp));
    return;
  }
  if (codec !== 'h264' && codec !== 'h265') { this._ffmpeg.write(chunk.data); return; }

  var dc = metadata && metadata.decoderConfig;
  if (dc && dc.description) {
    var bs = bitstreamFromDescription(toUint8Array(dc.description), codec === 'h265');
    if (bs.error) { this._ee.emit('error', new Error('Muxer: ' + bs.error)); return; }
    this._videoBitstream = bs;
  }
  var bsCur = this._videoBitstream;
  var data = (bsCur && bsCur.lengthSize) ? avccToAnnexb(chunk.data, bsCur.lengthSize) : chunk.data;
  if (chunk.type === 'key' && bsCur && bsCur.lengthSize && bsCur.paramSets) {
    var withPs = new Uint8Array(bsCur.paramSets.length + data.length);
    withPs.set(bsCur.paramSets, 0);
    withPs.set(data, bsCur.paramSets.length);
    data = withPs;
  }
  this._ffmpeg.write(data);
};

/**
 * Add an EncodedAudioChunk (pass its metadata too — see the header).
 */
Muxer.prototype.addAudioChunk = function (chunk, metadata) {
  if (!this._started) this._start();
  if (!chunk.data) return;
  var codec = normalizeCodec((this._audio && this._audio.codec) || 'aac');
  var dc = metadata && metadata.decoderConfig;
  var desc = dc && dc.description ? toUint8Array(dc.description) : null;

  if (codec === 'aac') {
    // Raw access units ('aac' format, the encoder default) → ADTS.
    if (desc) this._aacConfig = parseAudioSpecificConfig(desc);
    if (adtsHeaderLength(chunk.data)) { this._writeAudio(chunk.data); return; }
    var cfg = this._aacConfig || {
      objectType: 2,
      sampleRate: this._audio.sampleRate || 48000,
      channels: this._audio.channels || this._audio.numberOfChannels || 2,
    };
    this._writeAudio(wrapAdtsWithConfig(chunk.data, cfg));
    return;
  }

  if (codec === 'opus') {
    // Raw Opus packets → OGG pages. The OpusHead description (if any)
    // supplies the encoder's pre-skip, so the muxed file trims the
    // encoder delay exactly like the original stream.
    if (!this._ogg) {
      var preSkip = (desc && desc.length >= 12) ? (desc[10] | (desc[11] << 8)) : 0;
      this._ogg = new OggWriter({
        channels: this._audio.channels || this._audio.numberOfChannels || 2,
        preSkip: preSkip,
      });
      this._writeAudio(this._ogg.writeHeaders());
    }
    this._writeAudio(this._ogg.writePacket(chunk.data));
    return;
  }

  this._writeAudio(chunk.data);
};

// Audio goes to pipe:3 (when both tracks) or stdin (audio-only).
Muxer.prototype._writeAudio = function (bytes) {
  if (this._video && this._audio) {
    if (this._proc && this._proc.stdio[3]) this._proc.stdio[3].write(bytes);
  } else {
    this._ffmpeg.write(bytes);
  }
};

/**
 * Finalize: close all inputs, wait for FFmpeg to write the container
 * trailer, then complete.
 *
 * Three ways this used to never complete, all of which stalled the
 * caller forever because it waited on a 'close' event that could not
 * arrive:
 *
 *   1. FFmpeg was never started. _start() runs lazily on the first
 *      chunk, so a recording that produced none has no child process
 *      and no 'close'. A recording that captured nothing is exactly
 *      the case a caller is most likely to finalize.
 *   2. FFmpeg already exited — it failed at startup, or finalize() was
 *      called twice. The event fired before the listener was attached.
 *   3. FFmpeg hung. Nothing bounded the wait.
 *
 * This matters beyond the Muxer: MediaRecorder.stop() in muxer mode
 * awaits finalize() before dispatching 'stop', so any of the above
 * meant onstop never fired and the recording never appeared to end.
 *
 * base_coder's flushCoder already solves the same problem with a
 * bounded wait and paired listener cleanup; this mirrors it.
 *
 * @param {Function} [cb] — callback style; omit for a Promise.
 * @param {number} [timeoutMs=10000] — upper bound on the wait.
 */
var FINALIZE_TIMEOUT = 10000;

Muxer.prototype.finalize = function (cb, timeoutMs) {
  var self = this;
  if (typeof cb !== 'function') {
    var tmo = cb;   // called as finalize(timeoutMs)
    return new Promise(function (resolve) { self.finalize(resolve, tmo); });
  }

  // Nothing was ever spawned, or it has already exited: there is no
  // trailer left to write and no event coming. Complete on the next
  // tick so the caller always sees consistent async cadence.
  if (!this._started || !this._ffmpeg.running) {
    setTimeout(function () { cb(); }, 0);
    return;
  }

  var done = false;
  var timer = null;
  function finish() {
    if (done) return;
    done = true;
    if (timer) { clearTimeout(timer); timer = null; }
    self._ffmpeg.off('close', finish);
    cb();
  }

  timer = setTimeout(function () {
    // FFmpeg is wedged. Kill it so the caller isn't held hostage; the
    // output file may be missing its trailer, which is the lesser
    // failure compared with never returning.
    self._ffmpeg.stop();
    finish();
  }, timeoutMs || FINALIZE_TIMEOUT);
  if (timer.unref) timer.unref();

  this._ffmpeg.on('close', finish);
  this._finishInputs();
};

Muxer.prototype._finishInputs = function () {
  // End audio pipe:3 first, then stdin
  if (this._video && this._audio && this._proc && this._proc.stdio[3]) {
    this._proc.stdio[3].end();
  }
  this._ffmpeg.endInput();
};

Muxer.prototype.close = function () {
  this._ffmpeg.stop();
  // Reset so the instance is not left in a half-open state where
  // _started is true but no process exists — addVideoChunk() would then
  // write into nothing and finalize() would wait on a dead handle.
  this._started = false;
  this._proc = null;
};

Muxer.prototype._start = function () {
  if (this._started) return;
  this._started = true;
  var self = this;

  var args = ['-hide_banner', '-loglevel', 'error', '-y'];
  var hasVideo = !!this._video;
  var hasAudio = !!this._audio;

  // Video input on stdin (pipe:0)
  if (hasVideo) {
    var vc = normalizeCodec(this._video.codec || 'h264');
    var vFmt = VIDEO_INPUT_FMT[vc] || 'h264';
    args.push('-f', vFmt);
    // Raw H.264/H.265 has no timestamps, so the rate is given; IVF
    // records carry their own (and the ivf demuxer has no -framerate).
    if (this._video.framerate && vFmt !== 'ivf') args.push('-framerate', String(this._video.framerate));
    args.push('-i', 'pipe:0');
  }

  // Audio input on pipe:3 (dual track) or pipe:0 (audio only)
  if (hasAudio) {
    var ac = normalizeCodec(this._audio.codec || 'aac');
    var aFmt = AUDIO_INPUT_FMT[ac] || 'aac';
    if (hasVideo) {
      args.push('-f', aFmt, '-i', 'pipe:3');
    } else {
      args.push('-f', aFmt, '-i', 'pipe:0');
    }
  }

  // Copy all streams to output
  args.push('-c', 'copy');
  if (this._format) args.push('-f', this._format);
  if (this._file) {
    args.push(this._file);
  } else {
    args.push('pipe:1');
  }

  // stdio: [stdin=video, stdout, stderr, pipe3=audio]
  var stdio;
  if (hasVideo && hasAudio) {
    stdio = ['pipe', this._file ? 'ignore' : 'pipe', 'pipe', 'pipe'];
  } else {
    stdio = ['pipe', this._file ? 'ignore' : 'pipe', 'pipe'];
  }

  this._proc = self._ffmpeg.start(args, stdio);
  self._ffmpeg.on('error', function (e) { self._ee.emit('error', e); });
};

function _guessFormat(file) {
  if (!file) return 'mp4';
  var ext = file.substring(file.lastIndexOf('.')).toLowerCase();
  return FORMAT_MAP[ext] || 'mp4';
}

export default Muxer;
