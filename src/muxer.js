/**
 * Muxer — Write encoded video + audio chunks to a container file.
 *
 * Usage:
 *   var muxer = new Muxer({
 *     file: 'output.mp4',             // or `output:` (alias); omit for a stream
 *     video: { codec: 'h264', width: 1920, height: 1080, framerate: 30 },
 *     audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
 *   });
 *   muxer.addVideoChunk(encodedVideoChunk, metadata);
 *   muxer.addAudioChunk(encodedAudioChunk, metadata);
 *   muxer.finalize(function () {
 *     // Container trailer written; the output file is complete.
 *   });
 *
 * finalize() also returns a Promise when no callback is given.
 *
 * Without `file` the container is streamed: 'data' events carry the
 * bytes, 'end' follows the last of them (an MP4 is then written
 * fragmented, the only MP4 a pipe can carry; opts.fragmentDuration in
 * µs sets the fragment length; opts.outputArgs adds FFmpeg muxer options).
 * 'error' reports an FFmpeg failure.
 *
 * Every track reaches FFmpeg as its own Matroska stream (MKVWriter),
 * which carries each chunk's timestamp, and FFmpeg copies the packets
 * into the output container (-c copy -copyts). Chunks are taken exactly
 * as WebCodecs encoders emit them (browser or this library's Node
 * encoders):
 *
 *   H.264 / H.265   avcC / hvcC description → length-prefixed chunks as
 *                   they are; no description → Annex-B chunks, the
 *                   record built from the first key chunk's SPS/PPS
 *   VP8 / VP9 / AV1 chunks as they are
 *   AAC             AudioSpecificConfig from the description (or from
 *                   the ADTS header / the config); ADTS headers stripped
 *   Opus            the encoder's OpusHead (description) verbatim
 *   MP3 / FLAC      as they are (FLAC: description = 'fLaC' + STREAMINFO)
 *
 * Other audio codecs (G.711, Vorbis) go through FFmpeg's raw demuxers
 * as before — timed by sample count.
 *
 * Before: H.264/H.265 went in as raw Annex-B read at a constant frame
 * rate, AAC as ADTS and Opus as Ogg, both timed by sample count. Chunk
 * timestamps were thrown away: a 1 s gap in the video (frames dropped,
 * capture paused) came out as no gap at all, so the video ran 1 s ahead
 * of the audio from that point on.
 *
 * Pass each chunk's metadata along (addVideoChunk(chunk, metadata)): the
 * first one carries decoderConfig.description, which decides the form.
 *
 * FFmpeg starts once every configured track has delivered its first
 * usable chunk (each input's header needs it); chunks before that are
 * held. A track that never delivers anything is left out at finalize().
 */

import FFmpegProcess from './ffmpeg_process.js';
import EventEmitter from './core/events.js';
import { normalizeCodec } from './utils/codec_strings.js';
import {
  parseAvcC, parseHvcC, detectFormat, annexbToAvcc,
  buildAvcCFromAnnexB, buildHvcCFromAnnexB,
} from './utils/nalu_utils.js';
import {
  adtsHeaderLength, stripAdts, parseAudioSpecificConfig,
  audioSpecificConfigFromAdts, buildAudioSpecificConfig,
} from './utils/aac_utils.js';
import { buildOpusHead, parseOpusHead } from './utils/opus_utils.js';
import { toUint8Array } from './core/buffer_source.js';
import MKVWriter from './writer_mkv.js';

var FORMAT_MAP = {
  '.mp4': 'mp4', '.m4v': 'mp4', '.m4a': 'mp4',
  '.webm': 'webm', '.mkv': 'matroska', '.mka': 'matroska',
  '.ogg': 'ogg', '.opus': 'ogg', '.avi': 'avi', '.ts': 'mpegts',
};

var MKV_VIDEO_CODEC = {
  h264: 'V_MPEG4/ISO/AVC', h265: 'V_MPEGH/ISO/HEVC',
  vp8: 'V_VP8', vp9: 'V_VP9', av1: 'V_AV1',
};

// Audio codecs without a Matroska mapping here: FFmpeg's raw demuxers.
// Its ADTS demuxer is named 'aac' — there is no 'adts' demuxer.
var AUDIO_INPUT_FMT = {
  vorbis: 'ogg',
  alaw: 'alaw', ulaw: 'mulaw', 'g711-alaw': 'alaw', 'g711-ulaw': 'mulaw',
};

function Muxer(opts) {
  if (!opts) opts = {};
  this._ee = new EventEmitter();
  // `output` is accepted as an alias: MediaRecorder passed {output} and
  // the Muxer read only `file`, so no file was ever written (FFmpeg
  // streamed the recording into a stdout nobody read).
  this._file = opts.file || (typeof opts.output === 'string' ? opts.output : null);
  this._format = opts.format || _guessFormat(this._file);
  this._fragmentDurationUs = opts.fragmentDuration || 0;
  this._outputArgs = opts.outputArgs || [];   // extra FFmpeg muxer options
  this._video = opts.video || null;
  this._audio = opts.audio || null;
  this._ffmpeg = new FFmpegProcess(opts);
  this._started = false;      // FFmpeg spawned
  this._proc = null;
  this._finalizing = false;
  this._stopped = false;      // close() / timeout kill: no 'error' for that exit
  this._tsBias = null;        // µs added to every timestamp (Cluster timestamps are unsigned)
  this._tracks = {
    video: this._video ? _newTrack('video', this._video) : null,
    audio: this._audio ? _newTrack('audio', this._audio) : null,
  };
}

function _newTrack(kind, cfg) {
  return {
    kind: kind,
    codec: normalizeCodec(cfg.codec || (kind === 'video' ? 'h264' : 'aac')),
    cfg: cfg,
    raw: false,          // true: fed to a raw FFmpeg demuxer, not Matroska
    header: null,        // first bytes of this track's input (null = not ready)
    pending: [],         // input bytes held until FFmpeg starts
    pipe: -1,            // stdio index once started; -1 = not an input
    mkv: null,
  };
}

Muxer.prototype.on = function (ev, fn) { this._ee.on(ev, fn); };
Muxer.prototype.off = function (ev, fn) { this._ee.off(ev, fn); };

/**
 * Add an EncodedVideoChunk (pass its metadata too — see the header).
 */
Muxer.prototype.addVideoChunk = function (chunk, metadata) {
  var st = this._tracks.video;
  if (!st || this._finalizing) return;
  var data = _chunkBytes(chunk);
  if (!data) return;
  var dc = metadata && metadata.decoderConfig;
  var isH26x = st.codec === 'h264' || st.codec === 'h265';
  var isH265 = st.codec === 'h265';

  if (!st.header) {
    if (!MKV_VIDEO_CODEC[st.codec]) {
      this._ee.emit('error', new Error('Muxer: unsupported video codec ' + st.codec));
      return;
    }
    var priv = null;
    if (isH26x) {
      var desc = (dc && dc.description) ? toUint8Array(dc.description) : null;
      if (desc && desc.length) {
        if (isH265 ? parseHvcC(desc) : parseAvcC(desc)) {
          priv = desc;                         // chunks are length-prefixed
        } else if (detectFormat(desc) === 'annexb') {
          // Not a spec form (older code here put Annex-B parameter sets
          // in the description): chunks are Annex-B.
          priv = isH265 ? buildHvcCFromAnnexB(desc) : buildAvcCFromAnnexB(desc);
          st.annexb = true;
        } else {
          this._ee.emit('error', new Error('Muxer: description is not a valid ' + (isH265 ? 'hvcC' : 'avcC') + ' record'));
          return;
        }
      } else {
        // 'annexb' format: parameter sets are in the key chunks. Nothing
        // before the first key chunk can be decoded, so it is dropped.
        st.annexb = true;
        if (chunk.type !== 'key') return;
        priv = isH265 ? buildHvcCFromAnnexB(data) : buildAvcCFromAnnexB(data);
      }
      if (!priv) return;                        // no parameter sets yet
    } else if (st.codec === 'av1' && dc && dc.description) {
      priv = toUint8Array(dc.description);      // av1C
    }
    st.mkv = new MKVWriter({ tracks: [{
      type: 'video', codecId: MKV_VIDEO_CODEC[st.codec], codecPrivate: priv,
      width: st.cfg.width || (dc && dc.codedWidth) || 0,
      height: st.cfg.height || (dc && dc.codedHeight) || 0,
    }] });
    st.header = st.mkv.writeHeader();
    this._track(st, st.header);
  }
  if (isH26x && st.annexb) data = annexbToAvcc(data, isH265);   // all NAL units kept, 4-byte lengths
  this._track(st, st.mkv.writeFrame(1, data, this._ts(chunk), chunk.type === 'key'));
};

/**
 * Add an EncodedAudioChunk (pass its metadata too — see the header).
 */
Muxer.prototype.addAudioChunk = function (chunk, metadata) {
  var st = this._tracks.audio;
  if (!st || this._finalizing) return;
  var data = _chunkBytes(chunk);
  if (!data) return;
  var dc = metadata && metadata.decoderConfig;
  var desc = (dc && dc.description) ? toUint8Array(dc.description) : null;
  var cfg = st.cfg;
  var channels = cfg.channels || cfg.numberOfChannels || (dc && dc.numberOfChannels) || 2;
  var sampleRate = cfg.sampleRate || (dc && dc.sampleRate) || 48000;

  if (!st.header) {
    var track = null;
    if (st.codec === 'aac') {
      var asc = (desc && parseAudioSpecificConfig(desc)) ? desc
        : (adtsHeaderLength(data) ? audioSpecificConfigFromAdts(data) : null);
      if (!asc) {
        try { asc = buildAudioSpecificConfig({ sampleRate: sampleRate, channels: channels }); } catch (e) { asc = null; }
      }
      var info = asc ? parseAudioSpecificConfig(asc) : null;
      if (!info) { this._ee.emit('error', new Error('Muxer: no usable AudioSpecificConfig for AAC')); return; }
      track = { type: 'audio', codecId: 'A_AAC', codecPrivate: asc,
                sampleRate: info.sampleRate, channels: info.channels || channels };
    } else if (st.codec === 'opus') {
      // The encoder's OpusHead verbatim: it holds the channel mapping the
      // packets were coded with. A rebuilt one was always family 0, which
      // FFmpeg rejects for more than 2 channels (6-channel Opus could not
      // be muxed at all).
      var head = (desc && parseOpusHead(desc)) ? desc : buildOpusHead({ channels: channels, inputSampleRate: sampleRate });
      track = { type: 'audio', codecId: 'A_OPUS', codecPrivate: head,
                sampleRate: 48000, channels: parseOpusHead(head).channels,
                seekPreRollNs: 80000000 };
    } else if (st.codec === 'mp3') {
      track = { type: 'audio', codecId: 'A_MPEG/L3', sampleRate: sampleRate, channels: channels };
    } else if (st.codec === 'flac' && desc && desc.length > 4) {
      track = { type: 'audio', codecId: 'A_FLAC', codecPrivate: desc, sampleRate: sampleRate, channels: channels };
    }
    if (track) {
      st.mkv = new MKVWriter({ tracks: [track] });
      st.header = st.mkv.writeHeader();
    } else {
      st.raw = true;
      st.header = new Uint8Array(0);
    }
    this._track(st, st.header);
  }
  if (st.raw) { this._track(st, data); return; }
  if (st.codec === 'aac') data = stripAdts(data);
  this._track(st, st.mkv.writeFrame(1, data, this._ts(chunk), true));
};

// Chunk timestamp (µs) on the Matroska timeline. The first chunk of the
// muxer fixes one bias for all tracks, so their relative timing is kept.
Muxer.prototype._ts = function (chunk) {
  var t = typeof chunk.timestamp === 'number' ? chunk.timestamp : 0;
  if (this._tsBias === null) this._tsBias = t < 0 ? -t : 0;
  return Math.max(0, t + this._tsBias);
};

// Route a track's input bytes: held until FFmpeg runs, then written.
Muxer.prototype._track = function (st, bytes) {
  if (!bytes || !bytes.length) { if (!this._started) this._maybeStart(); return; }
  if (!this._started) {
    st.pending.push(bytes);
    this._maybeStart();
    return;
  }
  this._writePipe(st, bytes);
};

Muxer.prototype._writePipe = function (st, bytes) {
  if (st.pipe === 0) this._ffmpeg.write(bytes);
  else if (st.pipe > 0) this._ffmpeg.writeTo(st.pipe, bytes);
};

Muxer.prototype._maybeStart = function () {
  var v = this._tracks.video, a = this._tracks.audio;
  if ((v && !v.header) || (a && !a.header)) return;
  this._start();
};

/**
 * Finalize: close all inputs, wait for FFmpeg to write the container
 * trailer, then complete.
 *
 * Three ways this used to never complete, all of which stalled the
 * caller forever because it waited on a 'close' event that could not
 * arrive:
 *
 *   1. FFmpeg was never started. A recording that produced no chunk
 *      has no child process and no 'close'.
 *   2. FFmpeg already exited — it failed at startup, or finalize() was
 *      called twice. The event fired before the listener was attached.
 *   3. FFmpeg hung. Nothing bounded the wait.
 *
 * This matters beyond the Muxer: MediaRecorder.stop() in muxer mode
 * awaits finalize() before dispatching 'stop'.
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

  // FFmpeg waits for every configured track before it starts. A track
  // that never produced a usable chunk is left out now, so what the
  // others delivered is still written.
  if (!this._started && !this._stopped) {
    var v = this._tracks.video, a = this._tracks.audio;
    if ((v && v.header) || (a && a.header)) this._start();
  }
  this._finalizing = true;

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
    self._stopped = true;
    self._ffmpeg.stop();
    finish();
  }, timeoutMs || FINALIZE_TIMEOUT);
  if (timer.unref) timer.unref();

  this._ffmpeg.on('close', finish);
  this._finishInputs();
};

Muxer.prototype._finishInputs = function () {
  var proc = this._proc;
  if (proc && proc.stdio[3] && proc.stdio[3].writable) {
    try { proc.stdio[3].end(); } catch (e) {}
  }
  this._ffmpeg.endInput();
};

Muxer.prototype.close = function () {
  this._stopped = true;
  this._ffmpeg.stop();
  // Reset so the instance is not left in a half-open state where
  // _started is true but no process exists.
  this._started = false;
  this._proc = null;
};

Muxer.prototype._start = function () {
  if (this._started) return;
  this._started = true;
  var self = this;

  var inputs = [];
  if (this._tracks.video && this._tracks.video.header) inputs.push(this._tracks.video);
  if (this._tracks.audio && this._tracks.audio.header) inputs.push(this._tracks.audio);

  var args = ['-hide_banner', '-loglevel', 'error', '-y'];
  // Keep every input's timestamps as written. Without -copyts FFmpeg
  // moves EACH input to start at 0, which would undo the relative
  // timing of an audio input that starts later than the video.
  args.push('-copyts');
  for (var i = 0; i < inputs.length; i++) {
    var st = inputs[i];
    st.pipe = i === 0 ? 0 : 3;
    if (st.raw) {
      args.push('-f', AUDIO_INPUT_FMT[st.codec] || st.codec);
      if (st.codec.indexOf('law') >= 0) {
        args.push('-ar', String(st.cfg.sampleRate || 8000), '-ac', String(st.cfg.channels || st.cfg.numberOfChannels || 1));
      }
    } else {
      args.push('-f', 'matroska');
    }
    args.push('-i', 'pipe:' + st.pipe);
  }
  for (var m = 0; m < inputs.length; m++) args.push('-map', m + ':0');

  args.push('-c', 'copy');
  // One shift for all streams: the output starts at 0 as it always did,
  // with the tracks' relative timing intact.
  args.push('-avoid_negative_ts', 'make_zero');
  var isMp4 = this._format === 'mp4' || this._format === 'mov' || this._format === 'ipod';
  if (isMp4) args.push('-video_track_timescale', '90000');
  if (isMp4 && !this._file) {
    // A pipe cannot be seeked back to write the moov: fragmented MP4.
    args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof');
    if (this._fragmentDurationUs) args.push('-frag_duration', String(Math.round(this._fragmentDurationUs)));
  }
  Array.prototype.push.apply(args, this._outputArgs);
  if (this._format) args.push('-f', this._format);
  args.push(this._file || 'pipe:1');

  // stdio: [stdin=input 0, stdout, stderr, pipe3=input 1]
  var stdio = ['pipe', this._file ? 'ignore' : 'pipe', 'pipe'];
  if (inputs.length > 1) stdio.push('pipe');

  // Without a file the container comes out of stdout; it was never
  // forwarded, so a Muxer with no `file` produced output nobody could
  // reach. 'data' carries it, 'end' follows the last byte.
  this._ffmpeg.on('stdout', function (chunk) { self._ee.emit('data', chunk); });
  this._ffmpeg.on('stdout_end', function () { self._ee.emit('end'); });
  this._ffmpeg.on('error', function (e) { self._ee.emit('error', e); });
  // A failing FFmpeg (bad input, unwritable file, codec the container
  // cannot hold) used to end with no sign at all.
  this._ffmpeg.on('close', function (code, signal) {
    if (self._stopped || code === 0) return;
    var why = self._ffmpeg.lastError;
    self._ee.emit('error', new Error('Muxer: FFmpeg exited with ' +
      (signal ? 'signal ' + signal : 'code ' + code) + (why ? ': ' + why : '')));
  });

  this._proc = this._ffmpeg.start(args, stdio);
  if (!this._proc) return;
  if (this._proc.stdio[3]) this._proc.stdio[3].on('error', function () {});   // EPIPE after an FFmpeg failure

  for (var k = 0; k < inputs.length; k++) {
    var t = inputs[k];
    for (var p = 0; p < t.pending.length; p++) this._writePipe(t, t.pending[p]);
    t.pending = [];
  }
  // A configured track left out of this run: drop what it holds.
  var all = [this._tracks.video, this._tracks.audio];
  for (var q = 0; q < all.length; q++) if (all[q] && all[q].pipe < 0) all[q].pending = [];
};

// The chunk's bytes: `.data` (this library's chunks, plain objects) or
// copyTo() (any EncodedVideoChunk / EncodedAudioChunk).
function _chunkBytes(chunk) {
  if (!chunk) return null;
  if (chunk.data) return toUint8Array(chunk.data);
  if (typeof chunk.copyTo === 'function' && chunk.byteLength) {
    var b = new Uint8Array(chunk.byteLength);
    chunk.copyTo(b);
    return b;
  }
  return null;
}

function _guessFormat(file) {
  if (!file) return 'mp4';
  var ext = file.substring(file.lastIndexOf('.')).toLowerCase();
  return FORMAT_MAP[ext] || 'mp4';
}

export default Muxer;
