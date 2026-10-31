/**
 * Demuxer — Read media files and emit individual encoded chunks.
 *
 * Usage:
 *   var demuxer = new Demuxer({ file: 'input.mp4' });
 *   var info = demuxer.probe();
 *   demuxer.on('video', function(chunk, metadata) { ... }); // EncodedVideoChunk per frame
 *   demuxer.on('audio', function(chunk) { ... });            // EncodedAudioChunk per frame
 *   demuxer.on('end', function() { ... });
 *   demuxer.start();
 *
 * Video is output as Annex-B (H.264/H.265) or IVF (VP8/VP9/AV1) to pipe:3,
 * then parsed by our readers into individual frames.
 * Audio is output as ADTS/OGG/raw to stdout (pipe:1), then parsed similarly.
 */

import FFmpegProcess from './ffmpeg_process.js';
import EventEmitter from './core/events.js';
import { execFileSync } from 'node:child_process';
import { EncodedVideoChunk, EncodedAudioChunk } from './encoded_chunk.js';
import { getContainer, getDefaultContainer } from './containers.js';
import { bitstreamFromDescription, codecStringFromAnnexB } from './utils/nalu_utils.js';
import { parseAudioSpecificConfig } from './utils/aac_utils.js';
import FrameQueue from './core/frame_queue.js';

function Demuxer(opts) {
  if (!opts) opts = {};
  this._ee = new EventEmitter();
  this._file = opts.file || null;
  this._ffmpeg = new FFmpegProcess(opts);
  this._started = false;
  this._info = null;
}

Demuxer.prototype.on = function (ev, fn) { this._ee.on(ev, fn); };
Demuxer.prototype.off = function (ev, fn) { this._ee.off(ev, fn); };

/**
 * Probe the file for stream info.
 * @returns {{ video, audio, duration }}
 */
Demuxer.prototype.probe = function () {
  if (this._info) return this._info;
  if (!this._file) return null;

  try {
    var out = execFileSync('ffprobe', [
      '-hide_banner', '-loglevel', 'error',
      '-show_streams', '-show_format', '-show_data',   // -show_data: extradata bytes
      '-of', 'json', this._file,
    ], { encoding: 'utf8', timeout: 10000 });

    var json = JSON.parse(out);
    var info = { video: null, audio: null, duration: 0 };

    if (json.format && json.format.duration) {
      info.duration = parseFloat(json.format.duration);
    }

    var streams = json.streams || [];
    for (var i = 0; i < streams.length; i++) {
      var s = streams[i];
      if (s.codec_type === 'video' && !info.video) {
        info.video = {
          codec: _normalizeCodecName(s.codec_name),
          width: s.width || s.coded_width,
          height: s.height || s.coded_height,
          framerate: _parseFramerate(s.r_frame_rate),
        };
        info.video.codecString = _videoCodecString(s, info.video);
      } else if (s.codec_type === 'audio' && !info.audio) {
        info.audio = {
          codec: _normalizeCodecName(s.codec_name),
          sampleRate: parseInt(s.sample_rate, 10),
          channels: s.channels,
        };
        info.audio.codecString = _audioCodecString(s, info.audio.codec);
      }
    }

    this._info = info;
    return info;
  } catch (e) {
    return null;
  }
};

/**
 * Start demuxing. Emits 'video', 'audio', 'end', 'error' events.
 */
Demuxer.prototype.start = function (opts) {
  if (this._started) return;
  this._started = true;
  if (!opts) opts = {};

  var self = this;
  var info = this.probe();
  if (!info) { self._ee.emit('error', new Error('Could not probe file')); return; }

  var hasVideo = !!info.video;
  var hasAudio = !!info.audio;
  var args = ['-hide_banner', '-loglevel', 'error'];

  if (opts.startTime) args.push('-ss', String(opts.startTime));
  args.push('-i', this._file);
  if (opts.duration) args.push('-t', String(opts.duration));

  // Video → pipe:3 (codec copy in native container)
  if (hasVideo) {
    var vc = info.video.codec;
    // AnnexBReader splits access units on AUDs, so there must be exactly one
    // per AU. h264_metadata=aud=insert adds one even when the source
    // already has it (every MPEG-TS / HLS input), which split each frame
    // into an AUD-only "delta" chunk + the real one; remove first.
    // (hevc_metadata does not duplicate.)
    if (vc === 'h264') args.push('-map', '0:v:0', '-c:v', 'copy', '-bsf:v', 'h264_mp4toannexb,h264_metadata=aud=remove,h264_metadata=aud=insert', '-f', 'h264', 'pipe:3');
    else if (vc === 'h265') args.push('-map', '0:v:0', '-c:v', 'copy', '-bsf:v', 'hevc_mp4toannexb,hevc_metadata=aud=insert', '-f', 'hevc', 'pipe:3');
    else if (vc === 'vp8' || vc === 'vp9' || vc === 'av1') args.push('-map', '0:v:0', '-c:v', 'copy', '-f', 'ivf', 'pipe:3');
    else args.push('-map', '0:v:0', '-c:v', 'copy', '-f', 'rawvideo', 'pipe:3');
  }

  // Audio → pipe:1 (stdout)
  if (hasAudio) {
    var ac = info.audio.codec;
    if (ac === 'aac') args.push('-map', '0:a:0', '-c:a', 'copy', '-f', 'adts', 'pipe:1');
    else if (ac === 'opus' || ac === 'vorbis') args.push('-map', '0:a:0', '-c:a', 'copy', '-f', 'ogg', 'pipe:1');
    else if (ac === 'mp3') args.push('-map', '0:a:0', '-c:a', 'copy', '-f', 'mp3', 'pipe:1');
    else args.push('-map', '0:a:0', '-c:a', 'copy', '-f', 'wav', 'pipe:1');
  }

  // Declared here so the end-of-stream path can flush them. A streaming
  // reader emits a frame only once it can see where the NEXT one starts,
  // so the final frame of every file sits in the reader's buffer until
  // flush() is called — see the long note on AnnexBReader.flush().
  var vReader = null;
  var aReader = null;

  // Determine stdio layout
  var stdio = ['ignore', hasAudio ? 'pipe' : 'ignore', 'pipe', hasVideo ? 'pipe' : 'ignore'];
  self._ffmpeg.start(args, stdio);

  // Wire video reader on pipe:3
  if (hasVideo) {
    var vContainer = getDefaultContainer(info.video.codec);
    var vContainerDef = getContainer(vContainer);
    if (vContainerDef && vContainerDef.createReader) {
      vReader = vContainerDef.createReader({ codec: info.video.codec, fps: info.video.framerate });
      vReader.on('video', function (f) {
        self._ee.emit('video', new EncodedVideoChunk({
          type: f.isKeyframe ? 'key' : 'delta',
          timestamp: f.ptsUs,
          data: f.payload,
        }));
      });
      self._ffmpeg.on('data', function (chunk) { vReader.feed(chunk); });
    }
  }

  // Wire audio reader on stdout
  if (hasAudio) {
    var aContainer = getDefaultContainer(info.audio.codec);
    var aContainerDef = getContainer(aContainer);
    if (aContainerDef && aContainerDef.createReader) {
      aReader = aContainerDef.createReader({ sampleRate: info.audio.sampleRate });
      aReader.on('audio', function (f) {
        self._ee.emit('audio', new EncodedAudioChunk({
          type: 'key',
          timestamp: f.ptsUs || 0,
          data: f.payload,
        }));
      });
      self._ffmpeg.on('stdout', function (chunk) { aReader.feed(chunk); });
    } else {
      // No reader — raw passthrough in fixed chunks (G.711, PCM, etc.)
      var sr = info.audio.sampleRate || 48000;
      var ch = info.audio.channels || 2;
      var bps = 2; // s16le
      var chunkBytes = Math.floor(sr / 100) * ch * bps;
      var aIdx = 0;
      var fq = new FrameQueue(chunkBytes, function (buf) {
        self._ee.emit('audio', new EncodedAudioChunk({
          type: 'key',
          timestamp: Math.round(aIdx * chunkBytes * 1e6 / (sr * ch * bps)),
          data: buf,
        }));
        aIdx++;
      });
      self._ffmpeg.on('stdout', function (chunk) { fq.push(chunk); });
    }
  }

  // ── End of stream ───────────────────────────────────────────────
  //
  // Two bugs lived here.
  //
  // 1. The readers were never flushed. AnnexBReader emits an access
  //    unit only when it finds the START of the next one, so at EOF the
  //    trailing AU stayed in its buffer forever — every H.264/H.265
  //    file lost its last frame, silently. TSReader has the same
  //    contract. Flushing before 'end' recovers it.
  //
  // 2. 'end' fired more than once. output_end and stdout_end set their
  //    flags and called checkEnd(), which emitted; then 'close' set both
  //    flags and called checkEnd() again, emitting a second time. A
  //    consumer that finalizes on 'end' did it twice.
  //
  // _ended latches so 'end' is emitted exactly once regardless of which
  // signals arrive or in what order.
  var videoDone = !hasVideo;
  var audioDone = !hasAudio;
  var ended = false;

  function checkEnd() {
    if (ended || !videoDone || !audioDone) return;
    ended = true;
    // Flush inside the latch: flush() emits the trailing frames, and
    // those must reach the consumer BEFORE 'end'.
    if (vReader && typeof vReader.flush === 'function') {
      try { vReader.flush(); } catch (e) { self._ee.emit('error', e); }
    }
    if (aReader && typeof aReader.flush === 'function') {
      try { aReader.flush(); } catch (e) { self._ee.emit('error', e); }
    }
    self._ee.emit('end');
  }

  if (hasVideo) {
    self._ffmpeg.on('output_end', function () { videoDone = true; checkEnd(); });
  }
  if (hasAudio) {
    self._ffmpeg.on('stdout_end', function () { audioDone = true; checkEnd(); });
  }

  self._ffmpeg.on('close', function () {
    videoDone = true; audioDone = true; checkEnd();
  });

  self._ffmpeg.on('error', function (e) { self._ee.emit('error', e); });
};

Demuxer.prototype.stop = function () {
  this._ffmpeg.stop();
  this._started = false;
};

/**
 * Get a VideoDecoder-compatible config. Call after probe().
 * Can be passed directly to VideoDecoder.configure().
 *
 * Shaped like the WebCodecs registrations for the chunks this Demuxer
 * emits: H.264/H.265 chunks are Annex-B with parameter sets in-band, so
 * per the avc/hevc registrations there is NO description; AV1 carries its
 * sequence header in-band on keyframes and VP8/VP9 need none. codec is
 * the full codec string ('avc1.64001f', 'hev1.2.4.L60.90',
 * 'vp09.00.10.08', 'av01.0.04M.08'), read from the stream at probe time.
 * The short name stays on `tracks[i].codec`.
 *
 * Usage:
 *   var demuxer = new Demuxer({ file: 'input.mp4' });
 *   demuxer.probe();
 *   decoder.configure(demuxer.videoDecoderConfig);
 */
Object.defineProperty(Demuxer.prototype, 'videoDecoderConfig', {
  get: function () {
    var info = this._info;
    if (!info || !info.video) return null;
    return {
      codec: info.video.codecString,
      codedWidth: info.video.width,
      codedHeight: info.video.height,
    };
  },
});

/**
 * Get an AudioDecoder-compatible config. Call after probe().
 * AAC chunks are ADTS frames (aac.format 'adts': no description); Opus,
 * MP3 etc. are raw packets. codec is the full codec string ('mp4a.40.2').
 */
Object.defineProperty(Demuxer.prototype, 'audioDecoderConfig', {
  get: function () {
    var info = this._info;
    if (!info || !info.audio) return null;
    return {
      codec: info.audio.codecString,
      sampleRate: info.audio.sampleRate,
      numberOfChannels: info.audio.channels,
    };
  },
});

/**
 * Get track info array. Call after probe().
 */
Object.defineProperty(Demuxer.prototype, 'tracks', {
  get: function () {
    var info = this._info;
    if (!info) return [];
    var out = [];
    if (info.video) out.push({ kind: 'video', codec: info.video.codec, width: info.video.width, height: info.video.height, framerate: info.video.framerate });
    if (info.audio) out.push({ kind: 'audio', codec: info.audio.codec, sampleRate: info.audio.sampleRate, channels: info.audio.channels });
    return out;
  },
});

/**
 * Get duration in seconds. Call after probe().
 */
Object.defineProperty(Demuxer.prototype, 'duration', {
  get: function () { return this._info ? this._info.duration : 0; },
});

/**
 * Seek to a timestamp (seconds). Stops current FFmpeg and restarts.
 * @param {number} time — target time in seconds
 * @param {object} [opts] — same options as start()
 */
Demuxer.prototype.seek = function (time, opts) {
  if (!opts) opts = {};
  if (this._started) {
    this._ffmpeg.stop();
    this._started = false;
    this._ffmpeg = new FFmpegProcess();
  }
  opts.startTime = time;
  this.start(opts);
};

function _normalizeCodecName(name) {
  if (!name) return null;
  var n = name.toLowerCase();
  if (n === 'hevc') return 'h265';
  if (n === 'h264' || n === 'avc') return 'h264';
  return n;
}

// ── Codec strings from ffprobe (one spawn: -show_data adds extradata) ──

// ffprobe prints extradata as a hexdump: '00000000: 0000 0167 ...  ascii'.
// The hex column is the fixed 39 characters after the 10-char offset.
function _extradata(s) {
  if (!s.extradata) return null;
  var lines = String(s.extradata).split('\n'), hex = '';
  for (var i = 0; i < lines.length; i++) {
    if (/^[0-9a-f]{8}: /.test(lines[i])) hex += lines[i].substr(10, 39).replace(/ /g, '');
  }
  if (!hex.length || hex.length & 1) return null;
  var out = new Uint8Array(hex.length / 2);
  for (var j = 0; j < out.length; j++) out[j] = parseInt(hex.substr(j * 2, 2), 16);
  return out;
}

function _bitDepth(pixFmt) {
  var m = /p(9|10|12|14|16)(le|be)?$/.exec(pixFmt || '');
  return m ? parseInt(m[1], 10) : 8;
}

function _pad2(n) { return (n < 10 ? '0' : '') + n; }

// VP9 Annex A: smallest level whose max picture size and max luma sample
// rate cover the stream. [level*10, maxLumaPictureSize, maxLumaSampleRate]
var VP9_LEVELS = [
  [10, 36864, 829440], [11, 73728, 2764800], [20, 122880, 4608000],
  [21, 245760, 9216000], [30, 552960, 20736000], [31, 983040, 36864000],
  [40, 2228224, 83558400], [41, 2228224, 160432128], [50, 8912896, 311951360],
  [51, 8912896, 588251136], [52, 8912896, 1176502272], [60, 35651584, 1176502272],
  [61, 35651584, 2353004544], [62, 35651584, 4706009088],
];

function _videoCodecString(s, v) {
  var c = v.codec, ed = _extradata(s);
  if (c === 'h264' || c === 'h265') {
    // extradata is avcC/hvcC (MP4, MKV) or Annex-B parameter sets (TS).
    var bs = ed ? bitstreamFromDescription(ed, c === 'h265') : null;
    var str = bs && bs.paramSets ? codecStringFromAnnexB(bs.paramSets, c === 'h265') : null;
    return str || c;   // no parameter sets in the container: short name
  }
  if (c === 'av1') {
    // av1C: byte1 = seq_profile(3) | seq_level_idx_0(5);
    //       byte2 = seq_tier_0 | high_bitdepth | twelve_bit | ...
    if (ed && ed.length >= 4 && ed[0] === 0x81) {
      var bd = (ed[2] & 0x40) ? ((ed[2] & 0x20) ? 12 : 10) : 8;
      return 'av01.' + (ed[1] >> 5) + '.' + _pad2(ed[1] & 0x1F) + ((ed[2] & 0x80) ? 'H' : 'M') + '.' + _pad2(bd);
    }
    var ap = { Main: 0, High: 1, Professional: 2 }[s.profile];
    var al = s.level >= 0 && s.level < 32 ? s.level : 31;   // 31 = unconstrained
    return 'av01.' + (ap == null ? 0 : ap) + '.' + _pad2(al) + 'M.' + _pad2(_bitDepth(s.pix_fmt));
  }
  if (c === 'vp9') {
    var vp = /(\d)$/.exec(s.profile || '');
    var pic = (v.width || 0) * (v.height || 0), rate = pic * (v.framerate || 30), lv = 62;
    for (var i = 0; i < VP9_LEVELS.length; i++) {
      if (pic <= VP9_LEVELS[i][1] && rate <= VP9_LEVELS[i][2]) { lv = VP9_LEVELS[i][0]; break; }
    }
    return 'vp09.' + _pad2(vp ? +vp[1] : 0) + '.' + _pad2(lv) + '.' + _pad2(_bitDepth(s.pix_fmt));
  }
  return c;   // 'vp8' and anything without a registered string form
}

var AAC_PROFILE_AOT = { Main: 1, LC: 2, SSR: 3, LTP: 4, 'HE-AAC': 5, 'HE-AACv2': 29, LD: 23, ELD: 39 };

function _audioCodecString(s, c) {
  if (c !== 'aac') return c;   // 'opus', 'mp3', 'flac', 'vorbis', ...
  var ed = _extradata(s), asc = ed ? parseAudioSpecificConfig(ed) : null;
  if (asc && asc.objectType) return 'mp4a.40.' + asc.objectType;
  return 'mp4a.40.' + (AAC_PROFILE_AOT[s.profile] || 2);
}

function _parseFramerate(str) {
  if (!str) return 30;
  var parts = str.split('/');
  if (parts.length === 2) return parseInt(parts[0], 10) / parseInt(parts[1], 10);
  return parseFloat(str) || 30;
}

export default Demuxer;
