/**
 * codec_availability — which codecs THIS FFmpeg build can really encode
 * and decode, answered synchronously.
 *
 * getSupportedVideoCodecs() answers from the library's own tables: every
 * codec the library has arguments for. Whether the FFmpeg on the machine
 * was built with the library behind it is another question: a build
 * without libx265 has no H.265 encoder, and configure() then fails when
 * the process starts. Code that must decide up front, such as a WebRTC
 * stack building its offer, asks this module; so do the four coders'
 * isConfigSupported() (coderCodecAvailable): they answered from the
 * tables alone, `supported: true` for H.265 without libx265.
 *
 * Two FFmpeg runs at most per ffmpeg path: `-encoders` (hw_accel's
 * cached listing, shared with the hardware probe) and `-decoders`. Both
 * results are cached. An FFmpeg that cannot be run gives null ("unknown"),
 * which is not cached, so the next call tries again.
 *
 * Encoders: the SOFTWARE encoder each codec is run with (hw_accel
 * SW_ENCODERS: libx264, libx265, libvpx, libvpx-vp9, libaom-av1,
 * libopus; G.711 is FFmpeg's native pcm_alaw / pcm_mulaw). A hardware
 * encoder is used only on request (selectEncoder), so it does not make a
 * codec available.
 *
 * Decoders: any decoder FFmpeg would pick for the codec. AV1 needs
 * libdav1d or libaom-av1: FFmpeg's native 'av1' decoder decodes only
 * through a hardware accelerator.
 */

import { spawnSync } from 'node:child_process';
import { getAvailableEncoders, SW_ENCODERS } from './hw_accel.js';
import { resolveFFmpegPath } from './ffmpeg_process.js';

var VIDEO_NAMES = ['vp8', 'vp9', 'av1', 'h264', 'h265'];
var AUDIO_NAMES = ['opus', 'g711-alaw', 'g711-ulaw', 'aac', 'mp3', 'flac', 'vorbis'];

var AUDIO_ENCODERS = { 'g711-alaw': 'pcm_alaw', 'g711-ulaw': 'pcm_mulaw' };

var DECODERS = {
  vp8: ['vp8', 'libvpx'],
  vp9: ['vp9', 'libvpx-vp9'],
  av1: ['libdav1d', 'libaom-av1'],
  h264: ['h264'],
  h265: ['hevc'],
  opus: ['opus', 'libopus'],
  'g711-alaw': ['pcm_alaw'],
  'g711-ulaw': ['pcm_mulaw'],
  aac: ['aac', 'libfdk_aac'],
  mp3: ['mp3float', 'mp3'],
  flac: ['flac'],
  vorbis: ['vorbis', 'libvorbis'],
};

// Per ffmpeg path: Set of decoder names.
var _decoderCache = new Map();
// Per ffmpeg path: the availability object.
var _cache = new Map();

function _key(ffmpegPath) { return ffmpegPath || 'ffmpeg'; }

function _listDecoders(key) {
  if (_decoderCache.has(key)) return _decoderCache.get(key);
  var decoders = new Set();
  try {
    var r = spawnSync(key, ['-hide_banner', '-decoders'], { timeout: 10000, encoding: 'utf8' });
    var lines = (String(r.stdout || '') + '\n' + String(r.stderr || '')).split('\n');
    var inList = false;
    for (var i = 0; i < lines.length; i++) {
      // The legend above the list matches the pattern too; the list
      // starts after the " ------" separator (as hw_accel's -encoders).
      if (/^\s*-{3,}\s*$/.test(lines[i])) { inList = true; continue; }
      if (!inList) continue;
      var m = lines[i].match(/^\s*[VAS][.\w]{5}\s+(\S+)/);
      if (m) decoders.add(m[1]);
    }
  } catch (e) { /* FFmpeg not available */ }
  if (decoders.size) _decoderCache.set(key, decoders);
  return decoders;
}

/**
 * The codecs (the library's short names) this FFmpeg can encode and
 * decode:
 *   { video: { encode: [...], decode: [...] },
 *     audio: { encode: [...], decode: [...] } }
 * in the library's order; null when FFmpeg could not be listed.
 *
 * @param {string} [ffmpegPath]
 */
function getCodecAvailability(ffmpegPath) {
  var key = _key(ffmpegPath);
  if (_cache.has(key)) return _cache.get(key);
  var enc = getAvailableEncoders(key);
  var dec = _listDecoders(key);
  if (!enc || !enc.size || !dec.size) return null;
  function encodes(name) {
    var e = AUDIO_ENCODERS[name] || SW_ENCODERS[name];
    return !!e && enc.has(e);
  }
  function decodes(name) {
    var list = DECODERS[name] || [];
    for (var i = 0; i < list.length; i++) if (dec.has(list[i])) return true;
    return false;
  }
  var out = {
    video: { encode: VIDEO_NAMES.filter(encodes), decode: VIDEO_NAMES.filter(decodes) },
    audio: { encode: AUDIO_NAMES.filter(encodes), decode: AUDIO_NAMES.filter(decodes) },
  };
  _cache.set(key, out);
  return out;
}

// WebCodecs codec strings whose short name differs from the one above.
var ALIASES = { alaw: 'g711-alaw', ulaw: 'g711-ulaw' };

/**
 * For the coders' isConfigSupported() (WebCodecs "Check Configuration
 * Support": supported only if the User Agent can really provide a codec
 * for the config): can the FFmpeg the coders run (resolveFFmpegPath, as
 * FFmpegProcess picks it) encode ('encode') / decode ('decode') this codec
 * (parseWebCodecsCodec's short name)?
 *   true / false — the listing says so;
 *   false        — no FFmpeg at all (no coder can run);
 *   null         — not known: a codec this module does not probe (raw PCM:
 *                  FFmpeg's own pcm_* coders), or an FFmpeg whose listing
 *                  could not be read (the caller keeps the table answer).
 *
 * @param {'video'|'audio'} kind
 * @param {'encode'|'decode'} way
 * @param {string} name
 */
function coderCodecAvailable(kind, way, name) {
  var n = ALIASES[name] || name;
  if ((kind === 'video' ? VIDEO_NAMES : AUDIO_NAMES).indexOf(n) < 0) return null;
  var path = resolveFFmpegPath();
  if (!path) return false;
  var a = getCodecAvailability(path);
  if (!a) return null;
  return a[kind][way].indexOf(n) >= 0;
}

/** Clear the caches (tests). */
function resetCodecAvailability() {
  _cache.clear();
  _decoderCache.clear();
}

export { getCodecAvailability, resetCodecAvailability, coderCodecAvailable };
