/**
 * codec_strings — Parse browser-style codec strings to short names + details.
 *
 * 'avc1.42E01E'       → { name: 'h264', profile: 'baseline', level: '3.0' }
 * 'avc1.4D401F'       → { name: 'h264', profile: 'main',     level: '3.1' }
 * 'avc1.64002A'       → { name: 'h264', profile: 'high',     level: '4.2' }
 * 'vp09.02.10.10'     → { name: 'vp9',  profile: '2', bitDepth: 10 }
 * 'hev1.1.6.L93.B0'   → { name: 'h265', profile: 'main' }
 * 'av01.0.01M.08'     → { name: 'av1',  profile: 'main', level: '2.1' }
 * 'mp4a.40.2'         → { name: 'aac' }
 * 'opus'              → { name: 'opus' }
 */

var CODEC_MAP = [
  { pattern: /^avc[13]?\b/i,     name: 'h264' },
  { pattern: /^h\.?264\b/i,      name: 'h264' },
  { pattern: /^hev[c1]?\b/i,     name: 'h265' },
  { pattern: /^hvc1?\b/i,        name: 'h265' },
  { pattern: /^h\.?265\b/i,      name: 'h265' },
  { pattern: /^vp0?8\b/i,        name: 'vp8' },
  { pattern: /^vp0?9\b/i,        name: 'vp9' },
  { pattern: /^av0?1\b/i,        name: 'av1' },
  { pattern: /^mp4a\b/i,         name: 'aac' },
  { pattern: /^aac\b/i,          name: 'aac' },
  { pattern: /^opus\b/i,         name: 'opus' },
  { pattern: /^flac\b/i,         name: 'flac' },
  { pattern: /^vorbis\b/i,       name: 'vorbis' },
  { pattern: /^mp3\b/i,          name: 'mp3' },
];

var H264_PROFILES = {
  0x42: 'baseline', 0x4D: 'main', 0x58: 'extended',
  0x64: 'high', 0x6E: 'high10', 0x7A: 'high422', 0xF4: 'high444',
};

function parseCodecString(str) {
  if (!str) return null;
  var s = String(str).trim();
  var lower = s.toLowerCase();
  if (lower === 'h264' || lower === 'h265' || lower === 'vp8' || lower === 'vp9' ||
      lower === 'av1' || lower === 'aac' || lower === 'opus') {
    return lower;
  }
  for (var i = 0; i < CODEC_MAP.length; i++) {
    if (CODEC_MAP[i].pattern.test(s)) return CODEC_MAP[i].name;
  }
  return null;
}

function normalizeCodec(str) {
  return parseCodecString(str) || String(str).toLowerCase();
}

/**
 * Parse a codec string into { name, profile, level, bitDepth }.
 *
 *   H.264: 'avc1.PPCCLL'   — PP=profile_idc(hex), CC=constraint, LL=level_idc(hex)
 *   VP9:   'vp09.PP.LL.DD' — PP=profile, LL=level*10, DD=bitDepth
 *   H.265: 'hev1.P.X.LYYY' — P=profile, L=level*30
 *   AV1:   'av01.P.LLX.DD' — P=profile, LL=seq_level_idx, DD=bitDepth
 */
function parseCodecDetails(str) {
  if (!str) return { name: null, profile: null, level: null, bitDepth: null };
  var s = String(str).trim();
  var name = parseCodecString(s);
  var result = { name: name, profile: null, level: null, bitDepth: null };
  if (!name) return result;

  if (name === 'h264') {
    var m = s.match(/^avc[13]?\.([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
    if (m) {
      var pIdc = parseInt(m[1], 16);
      var lIdc = parseInt(m[3], 16);
      result.profile = H264_PROFILES[pIdc] || null;
      result.level = String((lIdc / 10) | 0) + '.' + String(lIdc % 10);
    }
  } else if (name === 'vp9') {
    var mv = s.match(/^vp0?9\.(\d+)\.(\d+)\.(\d+)/);
    if (mv) {
      result.profile = mv[1];
      var lvl = parseInt(mv[2], 10);
      result.level = String((lvl / 10) | 0) + '.' + String(lvl % 10);
      result.bitDepth = parseInt(mv[3], 10);
    }
  } else if (name === 'h265') {
    var mh = s.match(/^(?:hev|hvc)1?\.(\d+)/);
    if (mh) {
      var pn = parseInt(mh[1], 10);
      result.profile = pn === 1 ? 'main' : pn === 2 ? 'main10' : String(pn);
    }
    var ml = s.match(/\.L(\d+)/);
    if (ml) {
      var lv = parseInt(ml[1], 10);
      result.level = String((lv / 30) | 0) + '.' + String(lv % 30);
    }
  } else if (name === 'av1') {
    var ma = s.match(/^av0?1\.(\d+)\.(\d+)[A-Z]?\.(\d+)/);
    if (ma) {
      var ap = parseInt(ma[1], 10);
      result.profile = ap === 0 ? 'main' : ap === 1 ? 'high' : ap === 2 ? 'professional' : String(ap);
      var sl = parseInt(ma[2], 10);
      result.level = String(((sl / 4) | 0) + 2) + '.' + String(sl % 4);
      result.bitDepth = parseInt(ma[3], 10);
    }
  }

  return result;
}

export { parseCodecString, normalizeCodec, parseCodecDetails };
