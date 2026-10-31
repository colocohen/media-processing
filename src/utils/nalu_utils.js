/**
 * nalu-utils — Pure functions for H.264/H.265 NALU manipulation.
 *
 * Browser-side port of the byte-level helpers from reader_annexb.js,
 * working on Uint8Array instead of Buffer. These functions are the
 * bridge between the various input shapes WebCodecs' VideoEncoder
 * might produce (Annex-B vs AVCC, with or without embedded parameter
 * sets) and the byte format each writer needs.
 *
 * All functions are pure: same input → same output, no state, no
 * side effects. Safe to call from any module without coordination.
 *
 * Format primer:
 *   Annex-B: NALUs separated by start codes (00 00 00 01 or 00 00 01)
 *            — what MPEG-TS expects
 *   AVCC:    NALUs prefixed by their length (usually 4 bytes BE)
 *            — what MP4/fMP4 expects, also VideoEncoder's default
 */

import { writeU32BE, readU32BE, readU16BE, concat } from '../core/bytes.js';

// ── H.264 NAL unit types (ISO/IEC 14496-10 §7.3.1) ─────────
export var H264_NAL_IDR = 5;   // Coded slice of an IDR picture — keyframe
export var H264_NAL_SPS = 7;   // Sequence Parameter Set
export var H264_NAL_PPS = 8;   // Picture Parameter Set
export var H264_NAL_AUD = 9;   // Access Unit Delimiter

// ── H.265 NAL unit types (ISO/IEC 23008-2 §7.3.1.2) ────────
export var H265_NAL_IDR_W_RADL = 19;
export var H265_NAL_IDR_N_LP = 20;
export var H265_NAL_VPS = 32;  // Video Parameter Set (HEVC-only)
export var H265_NAL_SPS = 33;
export var H265_NAL_PPS = 34;
export var H265_NAL_AUD = 35;

// 4-byte Annex-B start code. Reused everywhere — preallocated to
// skip re-creation in hot paths.
var START_CODE_4 = new Uint8Array([0, 0, 0, 1]);

/**
 * Split an Annex-B access unit into individual NALUs.
 * Returns array of { type, data } where `data` is a subarray view
 * into the input buffer (no copy), excluding the start code.
 *
 * Both 3-byte (00 00 01) and 4-byte (00 00 00 01) start codes are
 * recognized. Per H.264 spec the 4-byte form is required for the
 * first NALU of an AU, but real-world encoders are inconsistent
 * — we accept both.
 */
export function splitNALUs(au, isH265) {
  var nalus = [];
  var i = 0, len = au.length;
  while (i < len) {
    var scLen = 0;
    if (i + 4 <= len && au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 0 && au[i + 3] === 1) {
      scLen = 4;
    } else if (i + 3 <= len && au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1) {
      scLen = 3;
    } else {
      i++;
      continue;
    }
    i += scLen;

    // NALU runs until the next start code (or end of buffer)
    var naluStart = i;
    while (i < len) {
      if (i + 3 <= len && au[i] === 0 && au[i + 1] === 0 &&
          (au[i + 2] === 1 || (au[i + 2] === 0 && i + 3 < len && au[i + 3] === 1))) break;
      i++;
    }
    if (naluStart < i) {
      var naluData = au.subarray(naluStart, i);
      var type = isH265 ? ((naluData[0] >> 1) & 0x3F) : (naluData[0] & 0x1F);
      nalus.push({ type: type, data: naluData });
    }
  }
  return nalus;
}

/**
 * Extract parameter sets from an AU.
 * Returns { sps, pps } for H.264 or { vps, sps, pps } for H.265.
 * Each field is the NALU payload (Uint8Array, no start code) or null
 * if not present in this AU.
 *
 * Returns null if no parameter sets at all — caller can use this
 * to decide whether to fall back to a cached set.
 *
 * Note this returns a structured result, not the concatenated
 * Annex-B form like reader_annexb.js's helper does. The TS writer
 * needs them individually because each goes into the bitstream
 * separately, prefixed with its own start code.
 */
export function extractParameterSets(au, isH265) {
  var nalus = splitNALUs(au, isH265);
  var sps = null, pps = null, vps = null;
  for (var i = 0; i < nalus.length; i++) {
    var t = nalus[i].type;
    if (!isH265) {
      if (t === H264_NAL_SPS) sps = nalus[i].data;
      else if (t === H264_NAL_PPS) pps = nalus[i].data;
    } else {
      if (t === H265_NAL_VPS) vps = nalus[i].data;
      else if (t === H265_NAL_SPS) sps = nalus[i].data;
      else if (t === H265_NAL_PPS) pps = nalus[i].data;
    }
  }
  if (!sps && !pps && !vps) return null;
  var out = { sps: sps, pps: pps };
  if (isH265) out.vps = vps;
  return out;
}

/**
 * True if the AU contains an IDR (instantaneous decoder refresh) NAL.
 * IDR is what HLS calls a "keyframe" — every TS segment must start
 * at one. WebCodecs already tells us via `chunk.type === 'key'`, so
 * in normal flow we don't need this — exposed for completeness and
 * for cases where the encoder is unknown.
 */
export function hasIDR(au, isH265) {
  var nalus = splitNALUs(au, isH265);
  for (var i = 0; i < nalus.length; i++) {
    var t = nalus[i].type;
    if (!isH265 && t === H264_NAL_IDR) return true;
    if (isH265 && (t === H265_NAL_IDR_W_RADL || t === H265_NAL_IDR_N_LP)) return true;
  }
  return false;
}

/**
 * Convert AVCC (length-prefixed) to Annex-B (start-code-prefixed).
 *
 *   AVCC:    [4-byte len][NALU][4-byte len][NALU]...
 *   Annex-B: [00 00 00 01][NALU][00 00 00 01][NALU]...
 *
 * VideoEncoder's default output is AVCC with 4-byte length prefixes.
 * The lengthSize parameter is for sources that use 1- or 2-byte
 * prefixes (uncommon — see avcC box's lengthSizeMinusOne field for
 * the rare cases this matters).
 */
export function avccToAnnexb(buf, lengthSize) {
  if (!lengthSize) lengthSize = 4;
  var parts = [];
  var off = 0;
  while (off + lengthSize <= buf.length) {
    var len;
    if (lengthSize === 4) len = readU32BE(buf, off);
    else if (lengthSize === 2) len = readU16BE(buf, off);
    else len = buf[off];
    off += lengthSize;
    if (off + len > buf.length) break;
    parts.push(START_CODE_4, buf.subarray(off, off + len));
    off += len;
  }
  return concat(parts);
}

/**
 * Convert Annex-B to AVCC. Mirror of avccToAnnexb. Always emits
 * 4-byte lengths, which is what fMP4 expects (and what we'll use
 * when writer-fmp4 lands).
 */
export function annexbToAvcc(buf, isH265) {
  var nalus = splitNALUs(buf, isH265);
  var totalSize = 0;
  for (var i = 0; i < nalus.length; i++) totalSize += 4 + nalus[i].data.length;
  var out = new Uint8Array(totalSize);
  var off = 0;
  for (var j = 0; j < nalus.length; j++) {
    writeU32BE(out, off, nalus[j].data.length);
    out.set(nalus[j].data, off + 4);
    off += 4 + nalus[j].data.length;
  }
  return out;
}

/**
 * Wrap a list of NALU payloads into an Annex-B byte stream.
 * Each NALU gets a 4-byte start code prefix.
 *
 * Used when reconstructing AUs from separate NALU buffers — for
 * example, when the HLS encoder injects cached SPS/PPS in front
 * of a keyframe that didn't carry them inline.
 */
export function nalusToAnnexb(nalus) {
  var parts = [];
  for (var i = 0; i < nalus.length; i++) {
    parts.push(START_CODE_4, nalus[i]);
  }
  return concat(parts);
}

/**
 * Detect whether a buffer is in Annex-B or AVCC format.
 *
 * Heuristic: Annex-B always starts with 00 00 00 01 or 00 00 01.
 * AVCC starts with a 4-byte length whose value is the size of the
 * first NALU — for any real frame this is at least a few bytes,
 * so the buffer's first 3 bytes won't all be zero.
 *
 * The check isn't 100% (a malicious buffer could fool it) but
 * works for all real WebCodecs output. Used by HLSEncoder to pick
 * the right normalization path automatically — avoids requiring
 * the caller to declare the format up front.
 */
export function detectFormat(buf) {
  if (!buf || buf.length < 4) return 'unknown';

  var looksLikeStartCode =
    buf[0] === 0 && buf[1] === 0 &&
    (buf[2] === 1 || (buf[2] === 0 && buf[3] === 1));

  // No start-code prefix — unambiguously length-prefixed.
  if (!looksLikeStartCode) return 'avcc';

  // Ambiguous. An AVCC length field ALIASES a start code whenever the
  // first NALU's size falls in a range whose big-endian encoding begins
  // 00 00 01 or 00 00 00 01:
  //
  //   size 1        → 00 00 00 01
  //   size 256..511 → 00 00 01 xx      ← a 256-value window
  //
  // Sizes in 256..511 are entirely ordinary for a first NALU (an SPS,
  // a PPS, a small slice), so this is not a corner case. The previous
  // heuristic returned 'annexb' for all of them, and its comment
  // reasoned only about the size-1 case ("for any real frame this is at
  // least a few bytes"), which is why the wider window went unnoticed.
  //
  // Consequence: hls_encoder._onVideoChunk runs annexbToAvcc() on a
  // buffer that is ALREADY AVCC. splitNALUs then scans length fields as
  // if they were payload, finds start codes inside them, and emits
  // nonsense — corrupt mdat samples in the fMP4 output, from the
  // browser path, with no error raised anywhere.
  //
  // Resolve it by walking the buffer as AVCC: chained length prefixes
  // must consume it exactly. Real Annex-B data effectively never does
  // (its first "length" would be 1, after which the next four bytes are
  // NAL payload interpreted as a size, which overshoots immediately).
  return _walksAsAvcc(buf) ? 'avcc' : 'annexb';
}

/**
 * True if `buf` parses cleanly as a chain of 4-byte-length-prefixed
 * NALUs that ends exactly at the buffer's end.
 */
function _walksAsAvcc(buf) {
  var off = 0;
  var count = 0;
  while (off + 4 <= buf.length) {
    var len = readU32BE(buf, off);
    if (len === 0) return false;          // zero-length NALU is invalid
    off += 4 + len;
    if (off > buf.length) return false;   // overshoots — not AVCC
    count++;
  }
  return off === buf.length && count > 0;
}

/**
 * Inject a SEI NAL unit into a video access unit at the correct
 * position: BEFORE any VCL (slice/IDR) NALU but AFTER an AUD if one
 * is present. This matches H.264 §7.4.1.2.3 NAL ordering rules.
 *
 * Auto-detects Annex-B (start-code framed, used by TS) vs AVCC
 * (length-prefixed, used by fMP4) and produces output in the same
 * format as the input. AVCC always uses 4-byte length prefix, which
 * matches what writer-fmp4 expects and what WebCodecs produces.
 *
 * The seiNal argument is the full NAL unit bytes WITHOUT a start
 * code or length prefix (just the NAL header + RBSP). The helper
 * adds whichever framing the AU uses.
 *
 * Used for inserting CEA-608/708 closed-caption SEI messages into
 * encoded video streams. Could also be used for HDR metadata,
 * pic-timing info, or any other prefix SEI.
 *
 * @param {Uint8Array} au       Access unit (Annex-B or AVCC)
 * @param {Uint8Array} seiNal   SEI NAL unit (with NAL header)
 * @param {boolean}    isH265   true for HEVC (different AUD type)
 * @returns {Uint8Array}        New AU with SEI injected
 */
export function injectSeiIntoAU(au, seiNal, isH265) {
  var format = detectFormat(au);
  var audType = isH265 ? H265_NAL_AUD : H264_NAL_AUD;

  if (format === 'annexb') {
    var nalus = splitNALUs(au, isH265);
    var insertIdx = 0;
    if (nalus.length > 0 && nalus[0].type === audType) {
      insertIdx = 1;
    }
    var reassembled = [];
    for (var i = 0; i < nalus.length; i++) {
      if (i === insertIdx) reassembled.push(seiNal);
      reassembled.push(nalus[i].data);
    }
    if (insertIdx >= nalus.length) reassembled.push(seiNal);
    return nalusToAnnexb(reassembled);
  }

  // AVCC: parse 4-byte length-prefixed NALUs.
  var avccNalus = [];
  var off = 0;
  while (off + 4 <= au.length) {
    var nalLen = readU32BE(au, off);
    off += 4;
    if (off + nalLen > au.length || nalLen <= 0) break;
    var nalData = au.subarray(off, off + nalLen);
    var nalType = isH265 ? ((nalData[0] >> 1) & 0x3F) : (nalData[0] & 0x1F);
    avccNalus.push({ data: nalData, type: nalType });
    off += nalLen;
  }
  var avccInsertIdx = 0;
  if (avccNalus.length > 0 && avccNalus[0].type === audType) {
    avccInsertIdx = 1;
  }
  var totalSize = 4 + seiNal.length;
  for (var k = 0; k < avccNalus.length; k++) {
    totalSize += 4 + avccNalus[k].data.length;
  }
  var out = new Uint8Array(totalSize);
  var ptr = 0;
  var injected = false;
  function writeAvccNalu(data) {
    writeU32BE(out, ptr, data.length);
    out.set(data, ptr + 4);
    ptr += 4 + data.length;
  }
  for (var n = 0; n < avccNalus.length; n++) {
    if (n === avccInsertIdx && !injected) {
      writeAvccNalu(seiNal);
      injected = true;
    }
    writeAvccNalu(avccNalus[n].data);
  }
  if (!injected) writeAvccNalu(seiNal);
  return out;
}

// ═══════════════════════════════════════════════════════════════════
//  Annex-B scan helpers (ported from reader_annexb for shared reuse)
//
//  These were Buffer-based in media-processing's reader_annexb.js. They
//  only INDEX into the byte array (no allocation, no Buffer-specific
//  API), so the port to Uint8Array is identical logic. Kept here so
//  both reader_annexb (full streaming reader) and reader_ts (which
//  needs hasIDR_H264) import from one place — no duplication.
// ═══════════════════════════════════════════════════════════════════

/**
 * Find the byte offset of the first Access Unit Delimiter of type
 * `audType` within buf[from..end), or -1. Recognizes 3- and 4-byte
 * start codes. `isH265` selects the NAL-type bit layout.
 */
export function findAUD(buf, from, end, audType, isH265) {
  var i = from;
  while (i + 4 <= end) {
    if (buf[i] !== 0x00) { i++; continue; }
    if (buf[i + 1] !== 0x00) { i += 2; continue; }
    if (buf[i + 2] === 0x00 && i + 5 <= end && buf[i + 3] === 0x01) {
      var t4 = isH265 ? ((buf[i + 4] >> 1) & 0x3F) : (buf[i + 4] & 0x1F);
      if (t4 === audType) return i;
      i += 4; continue;
    }
    if (buf[i + 2] === 0x01 && i + 4 <= end) {
      var t3 = isH265 ? ((buf[i + 3] >> 1) & 0x3F) : (buf[i + 3] & 0x1F);
      if (t3 === audType) return i;
      i += 3; continue;
    }
    i++;
  }
  return -1;
}

/**
 * Find the offset of the last start code in buf[from..end), or -1.
 * Used by streaming readers to split at a safe boundary while keeping
 * a possibly-incomplete trailing NALU buffered.
 */
export function findLastStartCode(buf, from, end) {
  for (var i = end - 4; i >= from; i--) {
    if (buf[i] === 0x00 && buf[i + 1] === 0x00) {
      if (buf[i + 2] === 0x00 && buf[i + 3] === 0x01) return i;
      if (buf[i + 2] === 0x01) return i;
    }
  }
  return -1;
}

/**
 * True if an Annex-B H.264 access unit contains an IDR slice.
 * (reader_ts imports this directly; the generic hasIDR(au,isH265)
 * above covers both codecs, but reader_ts wants the explicit name.)
 */
export function hasIDR_H264(au) {
  var i = 0, len = au.length;
  while (i + 4 <= len) {
    if (au[i] !== 0x00) { i++; continue; }
    if (au[i + 1] !== 0x00) { i += 2; continue; }
    if (au[i + 2] === 0x00 && au[i + 3] === 0x01 && i + 5 <= len) {
      if ((au[i + 4] & 0x1F) === H264_NAL_IDR) return true;
      i += 4; continue;
    }
    if (au[i + 2] === 0x01 && i + 4 <= len) {
      if ((au[i + 3] & 0x1F) === H264_NAL_IDR) return true;
      i += 3; continue;
    }
    i++;
  }
  return false;
}

/**
 * True if an Annex-B H.265 access unit contains an IDR (W_RADL or N_LP).
 */
export function hasIDR_H265(au) {
  var i = 0, len = au.length;
  while (i + 4 <= len) {
    if (au[i] !== 0x00) { i++; continue; }
    if (au[i + 1] !== 0x00) { i += 2; continue; }
    if (au[i + 2] === 0x00 && au[i + 3] === 0x01 && i + 5 <= len) {
      var t = (au[i + 4] >> 1) & 0x3F;
      if (t === H265_NAL_IDR_W_RADL || t === H265_NAL_IDR_N_LP) return true;
      i += 4; continue;
    }
    if (au[i + 2] === 0x01 && i + 4 <= len) {
      var t3 = (au[i + 3] >> 1) & 0x3F;
      if (t3 === H265_NAL_IDR_W_RADL || t3 === H265_NAL_IDR_N_LP) return true;
      i += 3; continue;
    }
    i++;
  }
  return false;
}



// ═══════════════════════════════════════════════════════════════════
//  Decoder configuration records (ISO/IEC 14496-15)
//
//  WebCodecs ties the bitstream format to the description:
//
//    avc.format / hevc.format = 'avc' / 'hevc' (the default)
//      chunks:      length-prefixed NALUs (AVCC/HVCC), no parameter sets
//      description: AVCDecoderConfigurationRecord (avcC) /
//                   HEVCDecoderConfigurationRecord (hvcC)
//
//    format = 'annexb'
//      chunks:      start-code NALUs, parameter sets in-band
//      description: none
//
//  The helpers below build and parse those records so the FFmpeg-backed
//  VideoEncoder/VideoDecoder can speak both forms exactly like a
//  browser does (MP-39 is closed at the source, not at each container).
// ═══════════════════════════════════════════════════════════════════

/**
 * Remove emulation-prevention bytes (00 00 03 → 00 00) from a NALU
 * payload, giving the RBSP that bit-level parsing works on.
 */
export function nalToRbsp(nal) {
  var out = new Uint8Array(nal.length);
  var o = 0, zeros = 0;
  for (var i = 0; i < nal.length; i++) {
    var b = nal[i];
    if (zeros >= 2 && b === 3) { zeros = 0; continue; }   // drop the 03
    out[o++] = b;
    zeros = (b === 0) ? zeros + 1 : 0;
  }
  return out.subarray(0, o);
}

// Minimal MSB-first bit reader with Exp-Golomb, for SPS fields.
function BitReader(bytes, byteOffset) {
  this.b = bytes;
  this.pos = (byteOffset || 0) * 8;
}
BitReader.prototype.u = function (n) {
  var v = 0;
  for (var i = 0; i < n; i++) {
    var byte = this.b[this.pos >> 3];
    if (byte === undefined) throw new Error('nalu-utils: SPS truncated');
    v = v * 2 + ((byte >> (7 - (this.pos & 7))) & 1);
    this.pos++;
  }
  return v;
};
BitReader.prototype.skip = function (n) { this.pos += n; };
BitReader.prototype.ue = function () {
  var zeros = 0;
  while (this.u(1) === 0) {
    if (++zeros > 31) throw new Error('nalu-utils: bad Exp-Golomb code');
  }
  return zeros ? (Math.pow(2, zeros) - 1 + this.u(zeros)) : 0;
};

// H.264 profiles whose SPS (and avcC) carry chroma / bit-depth fields
// (ISO/IEC 14496-10 §7.3.2.1.1, ISO/IEC 14496-15 §5.3.3.1.2).
var H264_HIGH_PROFILES = { 100: 1, 110: 1, 122: 1, 144: 1 };

/**
 * Chroma format and bit depths from an H.264 SPS (NALU incl. header).
 * Only meaningful for the High family; others are 4:2:0 / 8-bit.
 */
function _h264SpsFormat(sps) {
  var profile = sps[1];
  if (!H264_HIGH_PROFILES[profile]) return { chroma: 1, lumaMinus8: 0, chromaMinus8: 0 };
  var r = new BitReader(nalToRbsp(sps), 4);   // skip header, profile, constraints, level
  r.ue();                                    // seq_parameter_set_id
  var chroma = r.ue();
  if (chroma === 3) r.skip(1);               // separate_colour_plane_flag
  return { chroma: chroma, lumaMinus8: r.ue(), chromaMinus8: r.ue() };
}

function _paramSets(annexb, isH265) {
  var nalus = splitNALUs(annexb, isH265);
  var out = { vps: [], sps: [], pps: [] };
  for (var i = 0; i < nalus.length; i++) {
    var t = nalus[i].type;
    if (!isH265) {
      if (t === H264_NAL_SPS) out.sps.push(nalus[i].data);
      else if (t === H264_NAL_PPS) out.pps.push(nalus[i].data);
    } else {
      if (t === H265_NAL_VPS) out.vps.push(nalus[i].data);
      else if (t === H265_NAL_SPS) out.sps.push(nalus[i].data);
      else if (t === H265_NAL_PPS) out.pps.push(nalus[i].data);
    }
  }
  return out;
}

/**
 * Build an AVCDecoderConfigurationRecord (ISO/IEC 14496-15 §5.3.3.1)
 * from Annex-B data containing SPS + PPS (an access unit or just the
 * parameter sets). For High-family profiles the record carries the
 * chroma_format / bit_depth extension the spec requires for them.
 *
 * @param {Uint8Array} annexb
 * @returns {Uint8Array|null}  avcC record, or null if no SPS found
 */
export function buildAvcCFromAnnexB(annexb) {
  var ps = _paramSets(annexb, false);
  var spsList = ps.sps, ppsList = ps.pps;
  if (spsList.length === 0) return null;
  var sps0 = spsList[0];
  var ext = H264_HIGH_PROFILES[sps0[1]] ? _h264SpsFormat(sps0) : null;

  var size = 6;                                    // version..numOfSPS (6 fixed bytes)
  for (var s = 0; s < spsList.length; s++) size += 2 + spsList[s].length;
  size += 1;                                       // numOfPictureParameterSets
  for (var p = 0; p < ppsList.length; p++) size += 2 + ppsList[p].length;
  if (ext) size += 4;                              // chroma, 2× bit depth, numOfSPSExt

  var out = new Uint8Array(size);
  var o = 0;
  out[o++] = 1;                                    // configurationVersion
  out[o++] = sps0[1];                              // AVCProfileIndication
  out[o++] = sps0[2];                              // profile_compatibility
  out[o++] = sps0[3];                              // AVCLevelIndication
  out[o++] = 0xFF;                                 // reserved(6) | lengthSizeMinusOne=3
  out[o++] = 0xE0 | (spsList.length & 0x1F);       // reserved(3) | numOfSPS
  for (var s2 = 0; s2 < spsList.length; s2++) {
    out[o++] = (spsList[s2].length >> 8) & 0xFF;
    out[o++] = spsList[s2].length & 0xFF;
    out.set(spsList[s2], o); o += spsList[s2].length;
  }
  out[o++] = ppsList.length & 0xFF;                // numOfPPS
  for (var p2 = 0; p2 < ppsList.length; p2++) {
    out[o++] = (ppsList[p2].length >> 8) & 0xFF;
    out[o++] = ppsList[p2].length & 0xFF;
    out.set(ppsList[p2], o); o += ppsList[p2].length;
  }
  if (ext) {
    out[o++] = 0xFC | (ext.chroma & 0x03);         // reserved(6) | chroma_format
    out[o++] = 0xF8 | (ext.lumaMinus8 & 0x07);     // reserved(5) | bit_depth_luma_minus8
    out[o++] = 0xF8 | (ext.chromaMinus8 & 0x07);   // reserved(5) | bit_depth_chroma_minus8
    out[o++] = 0;                                  // numOfSequenceParameterSetExt
  }
  return out;
}

/**
 * Parse an AVCDecoderConfigurationRecord.
 * @returns {{lengthSize:number, sps:Uint8Array[], pps:Uint8Array[]}|null}
 *          null when the bytes are not an avcC record
 */
export function parseAvcC(rec) {
  if (!rec || rec.length < 7 || rec[0] !== 1) return null;
  var lengthSize = (rec[4] & 0x03) + 1;
  var o = 5;
  var out = { lengthSize: lengthSize, sps: [], pps: [] };
  var nSps = rec[o++] & 0x1F;
  for (var i = 0; i < nSps; i++) {
    if (o + 2 > rec.length) return null;
    var len = (rec[o] << 8) | rec[o + 1]; o += 2;
    if (o + len > rec.length) return null;
    out.sps.push(rec.subarray(o, o + len)); o += len;
  }
  if (o >= rec.length) return null;
  var nPps = rec[o++];
  for (var j = 0; j < nPps; j++) {
    if (o + 2 > rec.length) return null;
    var plen = (rec[o] << 8) | rec[o + 1]; o += 2;
    if (o + plen > rec.length) return null;
    out.pps.push(rec.subarray(o, o + plen)); o += plen;
  }
  return out;
}

// H.265 profile_tier_level() general fields + what hvcC needs from the SPS.
function _h265SpsInfo(sps) {
  var r = new BitReader(nalToRbsp(sps), 2);      // skip the 2-byte NAL header
  r.skip(4);                                     // sps_video_parameter_set_id
  var maxSubLayersMinus1 = r.u(3);
  var temporalIdNested = r.u(1);
  // profile_tier_level(1, maxSubLayersMinus1) — general part, 88 + 8 bits
  var ptl = new Uint8Array(12);
  for (var i = 0; i < 12; i++) ptl[i] = r.u(8);
  // ptl[0]      profile_space(2) tier(1) profile_idc(5)
  // ptl[1..4]   general_profile_compatibility_flags
  // ptl[5..10]  general_constraint_indicator_flags (48 bits)
  // ptl[11]     general_level_idc
  var subProfile = [], subLevel = [];
  for (var j = 0; j < maxSubLayersMinus1; j++) { subProfile.push(r.u(1)); subLevel.push(r.u(1)); }
  if (maxSubLayersMinus1 > 0) for (var k = maxSubLayersMinus1; k < 8; k++) r.skip(2);
  for (var m = 0; m < maxSubLayersMinus1; m++) {
    if (subProfile[m]) r.skip(88);
    if (subLevel[m]) r.skip(8);
  }
  r.ue();                                        // sps_seq_parameter_set_id
  var chroma = r.ue();
  if (chroma === 3) r.skip(1);                   // separate_colour_plane_flag
  r.ue(); r.ue();                                // pic_width / pic_height_in_luma_samples
  if (r.u(1)) { r.ue(); r.ue(); r.ue(); r.ue(); } // conformance window
  return {
    ptl: ptl,
    chroma: chroma,
    lumaMinus8: r.ue(),
    chromaMinus8: r.ue(),
    numTemporalLayers: maxSubLayersMinus1 + 1,
    temporalIdNested: temporalIdNested,
  };
}

/**
 * Build an HEVCDecoderConfigurationRecord (ISO/IEC 14496-15 §8.3.3.1)
 * from Annex-B data containing VPS + SPS + PPS. Fields that live in the
 * VUI or are encoder hints (min_spatial_segmentation, parallelismType,
 * avgFrameRate, constantFrameRate) are written as 0 = "unspecified",
 * which the spec allows.
 *
 * @param {Uint8Array} annexb
 * @returns {Uint8Array|null}  hvcC record, or null without VPS/SPS/PPS
 */
export function buildHvcCFromAnnexB(annexb) {
  var ps = _paramSets(annexb, true);
  if (!ps.vps.length || !ps.sps.length || !ps.pps.length) return null;
  var info = _h265SpsInfo(ps.sps[0]);
  var arrays = [[H265_NAL_VPS, ps.vps], [H265_NAL_SPS, ps.sps], [H265_NAL_PPS, ps.pps]];

  var size = 23;
  for (var a = 0; a < arrays.length; a++) {
    size += 3;
    for (var n = 0; n < arrays[a][1].length; n++) size += 2 + arrays[a][1][n].length;
  }
  var out = new Uint8Array(size);
  var o = 0;
  out[o++] = 1;                                      // configurationVersion
  out.set(info.ptl, o); o += 12;                     // profile_space..general_level_idc
  out[o++] = 0xF0; out[o++] = 0x00;                  // reserved(4) | min_spatial_segmentation_idc(12)=0
  out[o++] = 0xFC;                                   // reserved(6) | parallelismType=0
  out[o++] = 0xFC | (info.chroma & 0x03);            // reserved(6) | chromaFormat
  out[o++] = 0xF8 | (info.lumaMinus8 & 0x07);        // reserved(5) | bitDepthLumaMinus8
  out[o++] = 0xF8 | (info.chromaMinus8 & 0x07);      // reserved(5) | bitDepthChromaMinus8
  out[o++] = 0; out[o++] = 0;                        // avgFrameRate = unspecified
  out[o++] = ((info.numTemporalLayers & 0x07) << 3) | // constantFrameRate(2)=0 | numTemporalLayers(3)
             ((info.temporalIdNested & 0x01) << 2) | // temporalIdNested(1)
             0x03;                                   // lengthSizeMinusOne = 3
  out[o++] = arrays.length;                          // numOfArrays
  for (var b = 0; b < arrays.length; b++) {
    var list = arrays[b][1];
    out[o++] = 0x80 | arrays[b][0];                  // array_completeness=1 | reserved=0 | NAL_unit_type
    out[o++] = (list.length >> 8) & 0xFF; out[o++] = list.length & 0xFF;
    for (var c = 0; c < list.length; c++) {
      out[o++] = (list[c].length >> 8) & 0xFF; out[o++] = list[c].length & 0xFF;
      out.set(list[c], o); o += list[c].length;
    }
  }
  return out;
}

/**
 * Parse an HEVCDecoderConfigurationRecord.
 * @returns {{lengthSize:number, nalus:Uint8Array[]}|null}  nalus in
 *          record order (VPS, SPS, PPS, SEI…); null if not hvcC
 */
export function parseHvcC(rec) {
  if (!rec || rec.length < 23 || rec[0] !== 1) return null;
  var lengthSize = (rec[21] & 0x03) + 1;
  var numArrays = rec[22];
  var o = 23;
  var nalus = [];
  for (var a = 0; a < numArrays; a++) {
    if (o + 3 > rec.length) return null;
    var count = (rec[o + 1] << 8) | rec[o + 2]; o += 3;
    for (var i = 0; i < count; i++) {
      if (o + 2 > rec.length) return null;
      var len = (rec[o] << 8) | rec[o + 1]; o += 2;
      if (o + len > rec.length) return null;
      nalus.push(rec.subarray(o, o + len)); o += len;
    }
  }
  return { lengthSize: lengthSize, nalus: nalus };
}

/**
 * Turn an Annex-B access unit into the sample a browser emits in
 * 'avc' / 'hevc' format: 4-byte length-prefixed NALUs, WITHOUT the
 * parameter sets (they live in the description) and without AUDs.
 * Everything else — slices, SEI — is kept in order.
 */
export function annexbToAvccSample(au, isH265) {
  var nalus = splitNALUs(au, isH265);
  var keep = [];
  var total = 0;
  for (var i = 0; i < nalus.length; i++) {
    var t = nalus[i].type;
    var drop = isH265
      ? (t === H265_NAL_VPS || t === H265_NAL_SPS || t === H265_NAL_PPS || t === H265_NAL_AUD)
      : (t === H264_NAL_SPS || t === H264_NAL_PPS || t === H264_NAL_AUD);
    if (drop) continue;
    keep.push(nalus[i].data);
    total += 4 + nalus[i].data.length;
  }
  var out = new Uint8Array(total);
  var o = 0;
  for (var j = 0; j < keep.length; j++) {
    writeU32BE(out, o, keep[j].length);
    out.set(keep[j], o + 4);
    o += 4 + keep[j].length;
  }
  return out;
}

/**
 * What a decoder (or muxer) needs to turn WebCodecs H.264 / H.265 chunks
 * into an Annex-B stream, given the decoderConfig.description:
 *
 *   avcC / hvcC record  → chunks are length-prefixed ('avc'/'hevc'
 *                         format, the browser default): lengthSize from
 *                         the record, parameter sets from the record.
 *   no description      → chunks are already Annex-B ('annexb' format).
 *   Annex-B bytes       → not a spec form, but what older code here
 *                         produced (Demuxer still does): used as the
 *                         parameter sets, chunks taken as Annex-B.
 *
 * @param {Uint8Array|null} description
 * @param {boolean} isH265
 * @returns {{lengthSize:number, paramSets:Uint8Array|null, error?:string}}
 *          lengthSize 0 = chunks are Annex-B; paramSets in Annex-B form
 */
export function bitstreamFromDescription(description, isH265) {
  var out = { lengthSize: 0, paramSets: null };
  if (!description || !description.length) return out;
  var rec = isH265 ? parseHvcC(description) : parseAvcC(description);
  if (rec) {
    out.lengthSize = rec.lengthSize;
    out.paramSets = nalusToAnnexb(isH265 ? rec.nalus : rec.sps.concat(rec.pps));
    return out;
  }
  if (detectFormat(description) === 'annexb') {
    out.paramSets = description;
    return out;
  }
  out.error = 'description is not a valid ' + (isH265 ? 'hvcC' : 'avcC') + ' record';
  return out;
}

/**
 * The WebCodecs codec string for an H.264 / H.265 stream, read from the
 * SPS in an Annex-B access unit (the keyframe, or just the parameter sets):
 *
 *   H.264: 'avc1.PPCCLL' — profile_idc, constraint flags, level_idc
 *   H.265: 'hev1.<space><profile>.<compat>.<tier><level>[.<constraints>]'
 *          per ISO/IEC 14496-15 Annex E: compatibility flags bit-reversed
 *          in hex, trailing zero constraint bytes dropped. 'hev1' because
 *          an Annex-B stream carries its parameter sets in-band.
 *
 * @returns {string|null}  null when the AU has no SPS
 */
export function codecStringFromAnnexB(au, isH265) {
  var ps = _paramSets(au, isH265);
  if (!ps.sps.length) return null;
  var sps = ps.sps[0];
  if (!isH265) {
    if (sps.length < 4) return null;
    return 'avc1.' + _hex2(sps[1]) + _hex2(sps[2]) + _hex2(sps[3]);
  }
  var info = _h265SpsInfo(sps), ptl = info.ptl;
  var space = (ptl[0] >> 6) & 0x03, tier = (ptl[0] >> 5) & 0x01, profile = ptl[0] & 0x1F;
  var compat = ((ptl[1] << 24) | (ptl[2] << 16) | (ptl[3] << 8) | ptl[4]) >>> 0;
  var reversed = 0;
  for (var i = 0; i < 32; i++) if (compat & (1 << i)) reversed |= (1 << (31 - i));
  var s = 'hev1.' + (space ? String.fromCharCode(64 + space) : '') + profile +
          '.' + (reversed >>> 0).toString(16).toUpperCase() +
          '.' + (tier ? 'H' : 'L') + ptl[11];
  var last = 10;
  while (last >= 5 && ptl[last] === 0) last--;
  for (var j = 5; j <= last; j++) s += '.' + ptl[j].toString(16).toUpperCase();
  return s;
}

function _hex2(n) { return (n < 16 ? '0' : '') + n.toString(16); }
