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

// Reverse map for buildCodecString (MP-3).
var H264_PROFILE_IDC = {
  'baseline': 0x42, 'main': 0x4D, 'extended': 0x58,
  'high': 0x64, 'high10': 0x6E, 'high422': 0x7A, 'high444': 0xF4,
  // Constrained profiles share the base profile_idc and set constraint bits.
  'constrained-baseline': 0x42,
  'constrained-high':     0x64,
};

// Constraint-set bit masks for H.264 (ISO/IEC 14496-15 Annex E.4 +
// H.264 §7.4.2.1.1). The middle byte of an avc1 codec string carries
// these flags; the previous parser dropped it entirely (MP-4).
//
//   bit 7: constraint_set0_flag — if set with profile=66, this is
//          "Constrained Baseline" (CBP). Most browsers / Chrome
//          WebRTC emit this combination.
//   bit 6: constraint_set1_flag — with profile=77, this is
//          "Constrained Main".
//   bit 5: constraint_set2_flag
//   bit 4: constraint_set3_flag — with high profiles, indicates
//          "intra-only" subset.
//   bits 3-0: reserved (zero)
//
// For SDP fmtp, profile-level-id like '42E01F' carries:
//   profile_idc (42) + constraint_set bits (E0) + level_idc (1F)
// Without the middle byte we can't distinguish 'avc1.4200LL'
// (baseline) from 'avc1.42E0LL' (constrained baseline) — picky peers
// may reject the former.

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
      var cBits = parseInt(m[2], 16);   // MP-4: capture the middle byte
      var lIdc = parseInt(m[3], 16);
      var baseProfile = H264_PROFILES[pIdc] || null;

      // Derive a more specific profile name from constraint bits.
      // 'baseline' + constraint_set1 = 'constrained-baseline' (CBP).
      // 'high' + constraint_set1 = 'constrained-high'.
      var profileName = baseProfile;
      if (baseProfile === 'baseline' && (cBits & 0x40)) {
        profileName = 'constrained-baseline';
      } else if (baseProfile === 'high' && (cBits & 0x40)) {
        profileName = 'constrained-high';
      }

      result.profile = profileName;
      result.level = String((lIdc / 10) | 0) + '.' + String(lIdc % 10);
      // Surface the raw constraints byte so callers can losslessly
      // round-trip via buildCodecString. constraint_set0..3 bits are
      // also exposed individually for ergonomic checks.
      result.constraints = cBits;
      result.constraintSet0 = (cBits >> 7) & 1;
      result.constraintSet1 = (cBits >> 6) & 1;
      result.constraintSet2 = (cBits >> 5) & 1;
      result.constraintSet3 = (cBits >> 4) & 1;
    }
  } else if (name === 'vp9') {
    var mv = s.match(/^vp0?9\.(\d+)\.(\d+)\.(\d+)/);
    if (mv) {
      // Strip leading zeros from numeric profile string ('00' → '0')
      // so it round-trips cleanly through buildCodecString.
      result.profile = String(parseInt(mv[1], 10));
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
      // HEVC: level_idc = level × 30, where level = major + minor/10.
      // Minor digit therefore contributes (multiplier / 10) = 3.
      // For lv=93: major = 3, minor = (93 % 30) / 3 = 1 → "3.1".
      // For lv=120: major = 4, minor = 0 → "4.0".
      var hMaj = (lv / 30) | 0;
      var hMinRaw = lv - hMaj * 30;
      var hMin = Math.round(hMinRaw * 10 / 30);
      result.level = String(hMaj) + '.' + String(hMin);
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

/**
 * Build a browser-style codec string from a parsed structure.
 * Inverse of parseCodecDetails. (MP-3)
 *
 * Round-trip examples:
 *   { name: 'h264', profile: 'constrained-baseline', constraints: 0xE0, level: '3.1' }
 *     → 'avc1.42E01F'
 *   { name: 'vp9', profile: '0', level: '1.0', bitDepth: 8 } → 'vp09.00.10.08'
 *   { name: 'h265', profile: 'main', level: '3.1' }         → 'hev1.1.6.L93.B0'
 *   { name: 'av1',  profile: 'main', level: '2.1', bitDepth: 8 } → 'av01.0.04M.08'
 *   { name: 'aac' }                                          → 'mp4a.40.2'
 *   { name: 'opus' }                                         → 'opus'
 *
 * For unknown codec names, returns the name unchanged.
 *
 * @param {object} info — { name, profile, level, bitDepth?, constraints? }
 * @returns {string} the canonical codec string
 */
function buildCodecString(info) {
  if (!info || !info.name) return '';
  var name = String(info.name).toLowerCase();

  if (name === 'h264') {
    var pIdc = H264_PROFILE_IDC[info.profile];
    if (pIdc == null) {
      // If caller already supplied a numeric profile_idc via .profileIdc,
      // honor it. Otherwise default to baseline.
      pIdc = (typeof info.profileIdc === 'number') ? info.profileIdc : 0x42;
    }
    // Constraints: prefer caller-supplied constraints byte; else infer
    // from named profile (e.g. 'constrained-baseline' → set bit 6).
    var cBits;
    if (typeof info.constraints === 'number') {
      cBits = info.constraints & 0xFF;
    } else if (info.profile === 'constrained-baseline') {
      cBits = 0xE0;   // constraint_set0 + 1 + 2 = standard CBP signaling
    } else if (info.profile === 'constrained-high') {
      cBits = 0x40;   // constraint_set1
    } else {
      cBits = 0x00;
    }
    // Level: '3.1' → integer 31 (level_idc).
    var lIdc = _parseLevelToIdc(info.level, 30);   // default 3.0
    return 'avc1.' + _hex2(pIdc) + _hex2(cBits) + _hex2(lIdc);
  }

  if (name === 'vp9') {
    // 'vp09.PP.LL.DD' — PP=profile, LL=level*10, DD=bitDepth
    var profile = (info.profile != null) ? String(info.profile) : '0';
    var level = _parseLevelToIdc(info.level, 10);   // 1.0 default
    var bd = info.bitDepth || 8;
    return 'vp09.' + _pad2(profile) + '.' + _pad2(level) + '.' + _pad2(bd);
  }

  if (name === 'vp8') {
    // No profile/level encoding standard; bare 'vp8' is conventional.
    return 'vp8';
  }

  if (name === 'h265') {
    // 'hev1.P.X.LYYY.B0' — simplest conforming form
    var p;
    if (info.profile === 'main') p = '1';
    else if (info.profile === 'main10') p = '2';
    else if (info.profile == null) p = '1';
    else p = String(info.profile);
    // level_idc = level * 30 (so 3.1 → 93)
    var lvl = _parseLevelToIdc(info.level, 90, 30);
    return 'hev1.' + p + '.6.L' + lvl + '.B0';
  }

  if (name === 'av1') {
    // 'av01.P.LLX.DD'
    var ap;
    if (info.profile === 'main') ap = '0';
    else if (info.profile === 'high') ap = '1';
    else if (info.profile === 'professional') ap = '2';
    else if (info.profile == null) ap = '0';
    else ap = String(info.profile);
    // level: 2.0 → seq_level_idx 0; 2.1 → 1; 3.0 → 4. Per AV1 spec
    // §A.3: seq_level_idx = (major - 2) * 4 + minor.
    var seqLvl = _av1LevelToIdx(info.level);
    var bd2 = info.bitDepth || 8;
    return 'av01.' + ap + '.' + _pad2(seqLvl) + 'M.' + _pad2(bd2);
  }

  if (name === 'aac') {
    // 'mp4a.40.2' — AAC-LC (object_type 2). Other AAC types use
    // different second numbers (5 = HE-AAC v1, 29 = HE-AAC v2).
    return 'mp4a.40.' + (info.objectType || 2);
  }

  if (name === 'opus' || name === 'flac' || name === 'vorbis' ||
      name === 'mp3') {
    return name;
  }

  return name;
}

// ── Helpers for buildCodecString ──

function _hex2(n) {
  var s = (n & 0xFF).toString(16).toUpperCase();
  return s.length < 2 ? '0' + s : s;
}

function _pad2(v) {
  var s = String(v);
  return s.length < 2 ? '0' + s : s;
}

/**
 * Parse 'major.minor' level into an integer level_idc.
 *
 * level_idc encoding varies by codec:
 *   H.264: level_idc = level × 10
 *     '3.1' → 31  (3*10 + 1)
 *   HEVC:  level_idc = level × 30
 *     '3.1' → 93  (3*30 + 3, since minor 1 contributes 3 = 30/10)
 *
 * General formula: level_idc = (major + minor/10) × multiplier
 * which equals: major × multiplier + minor × (multiplier / 10)
 *
 *   _parseLevelToIdc('3.1', 30, 10)  → 31   (H.264-style)
 *   _parseLevelToIdc('3.1', 90, 30)  → 93   (HEVC-style)
 */
function _parseLevelToIdc(level, fallback, multiplier) {
  if (multiplier == null) multiplier = 10;
  if (level == null) return fallback;
  var s = String(level);
  var dot = s.indexOf('.');
  var maj = (dot < 0) ? parseInt(s, 10) : parseInt(s.substring(0, dot), 10);
  var min = (dot < 0) ? 0 : parseInt(s.substring(dot + 1), 10);
  return Math.round(maj * multiplier + (min * multiplier) / 10);
}

/**
 * AV1 level → seq_level_idx. Spec: idx = (major-2)*4 + minor.
 *   '2.0' → 0,  '2.1' → 1,  '3.0' → 4,  '4.0' → 8,  '5.1' → 13
 */
function _av1LevelToIdx(level) {
  if (level == null) return 0;
  var s = String(level);
  var dot = s.indexOf('.');
  var maj = (dot < 0) ? parseInt(s, 10) : parseInt(s.substring(0, dot), 10);
  var min = (dot < 0) ? 0 : parseInt(s.substring(dot + 1), 10);
  return Math.max(0, (maj - 2) * 4 + min);
}

export { parseCodecString, normalizeCodec, parseCodecDetails, buildCodecString };
