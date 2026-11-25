/**
 * mpeg_audio — MPEG-1 / MPEG-2 / MPEG-2.5 audio frame headers (layers
 * I, II, III) and the VBR headers an encoder puts in the first frame.
 *
 *   ISO/IEC 11172-3 §2.4.1.3 / §2.4.2.3 (header), ISO/IEC 13818-3 §2.4
 *   (the lower sampling frequencies, ID = 0), MPEG-2.5 (the unofficial
 *   extension to 8 / 11.025 / 12 kHz: the top bit of the version field
 *   0); the Xing / Info tag and the LAME extension to it (LAME's
 *   "Mp3 info tag" rev 1 — encoder delay / padding), Fraunhofer's VBRI.
 */

// [version][layer] → kbit/s by bitrate_index (index 0 = free format, 15 = bad).
var BR_V1 = [
  null,
  [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],       // layer III
  [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],      // layer II
  [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],   // layer I
];
var BR_V2 = [
  null,
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
];
var SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

// The fields every frame of one stream shares (FFmpeg's MP3_MASK: sync,
// version, layer, sampling frequency, channel mode, copyright, original,
// emphasis — not protection, bitrate, padding, private, mode extension).
export var MPA_MASK = 0xFFFE0CCF;

/**
 * The header at b[o..o+4): { version (1 | 2 | 2.5), layer, protection,
 * bitrate (kbit/s), sampleRate, padding, channelMode, channels,
 * frameLength, samplesPerFrame, word (the 32 header bits) }, or null —
 * not a header, a reserved value, or free format (no frame length).
 */
export function parseMpaHeader(b, o) {
  if (o + 4 > b.length) return null;
  if (b[o] !== 0xFF || (b[o + 1] & 0xE0) !== 0xE0) return null;
  var ver = (b[o + 1] >> 3) & 3, layerBits = (b[o + 1] >> 1) & 3;
  if (ver === 1 || layerBits === 0) return null;
  var bri = b[o + 2] >> 4, sri = (b[o + 2] >> 2) & 3;
  if (bri === 0 || bri === 15 || sri === 3) return null;
  if ((b[o + 3] & 3) === 2) return null;                            // emphasis '10': reserved
  var layer = 4 - layerBits;
  var v1 = ver === 3;
  var kbps = (v1 ? BR_V1 : BR_V2)[layerBits][bri];
  var sr = SR[ver][sri];
  var pad = (b[o + 2] >> 1) & 1;
  var mode = b[o + 3] >> 6;
  var len, spf;
  if (layer === 1) { len = (Math.floor(12000 * kbps / sr) + pad) * 4; spf = 384; }
  else if (layer === 2 || v1) { len = Math.floor(144000 * kbps / sr) + pad; spf = 1152; }
  else { len = Math.floor(72000 * kbps / sr) + pad; spf = 576; }
  return {
    version: v1 ? 1 : ver === 2 ? 2 : 2.5,
    layer: layer,
    protection: !(b[o + 1] & 1),
    bitrate: kbps,
    sampleRate: sr,
    padding: pad,
    channelMode: mode,
    channels: mode === 3 ? 1 : 2,
    frameLength: len,
    samplesPerFrame: spf,
    word: ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0,
  };
}

/** Do two headers belong to the same stream? */
export function sameStream(h1, h2) {
  return ((h1.word ^ h2.word) & MPA_MASK) === 0;
}

function _u32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
function _tag(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]); }

/**
 * The VBR header in a layer III frame (all of the frame in `f`), as
 * FFmpeg's mp3 demuxer reads it (mp3_parse_info_tag / _vbri_tag):
 *   { kind: 'Xing' | 'Info' | 'VBRI', frames, bytes, toc (100 bytes or
 *     null), encoder (the LAME tag's version string, '' without one),
 *     delay, padding (encoder delay / padding in samples; 0 without a
 *     LAME / Lavf / Lavc tag) }
 * or null. The Xing / Info tag starts after the side information (17 /
 * 32 bytes for MPEG-1 mono / stereo, 9 / 17 for MPEG-2 / 2.5); VBRI 32
 * bytes after the header.
 */
export function parseVbrHeader(f, h) {
  if (h.layer !== 3) return null;
  var mono = h.channels === 1;
  var o = 4 + (h.version === 1 ? (mono ? 17 : 32) : (mono ? 9 : 17));
  var out = null;
  if (o + 8 <= f.length && (_tag(f, o) === 'Xing' || _tag(f, o) === 'Info')) {
    out = { kind: _tag(f, o), frames: 0, bytes: 0, toc: null, encoder: '', delay: 0, padding: 0 };
    var flags = _u32(f, o + 4), p = o + 8;
    if (flags & 1) { if (p + 4 > f.length) return out; out.frames = _u32(f, p); p += 4; }
    if (flags & 2) { if (p + 4 > f.length) return out; out.bytes = _u32(f, p); p += 4; }
    if (flags & 4) { if (p + 100 > f.length) return out; out.toc = f.slice(p, p + 100); p += 100; }
    if (flags & 8) p += 4;
    // The LAME tag: a 9-byte version string, then (at +21) the 12-bit
    // encoder delay and 12-bit padding.
    if (p + 24 <= f.length) {
      var ver = String.fromCharCode.apply(null, f.subarray(p, p + 9)).replace(/\0.*$/, '');
      out.encoder = ver;
      var four = ver.slice(0, 4);
      if (four === 'LAME' || four === 'Lavf' || four === 'Lavc') {
        var v = (f[p + 21] << 16) | (f[p + 22] << 8) | f[p + 23];
        out.delay = v >> 12;
        out.padding = v & 0xFFF;
      }
    }
    return out;
  }
  if (40 + 14 <= f.length && _tag(f, 36) === 'VBRI' && ((f[40] << 8) | f[41]) === 1) {
    return { kind: 'VBRI', frames: _u32(f, 50), bytes: _u32(f, 46), toc: null, encoder: '', delay: 0, padding: 0 };
  }
  return null;
}

/** The size of an ID3v2 tag at b[o..] (header, footer included), or 0. */
export function id3v2Size(b, o) {
  if (o + 10 > b.length) return 0;
  if (b[o] !== 0x49 || b[o + 1] !== 0x44 || b[o + 2] !== 0x33) return 0;   // 'ID3'
  if (b[o + 3] === 0xFF || b[o + 4] === 0xFF) return 0;
  if ((b[o + 6] | b[o + 7] | b[o + 8] | b[o + 9]) & 0x80) return 0;        // sync-safe
  var size = (b[o + 6] << 21) | (b[o + 7] << 14) | (b[o + 8] << 7) | b[o + 9];
  return 10 + size + (b[o + 5] & 0x10 ? 10 : 0);
}
