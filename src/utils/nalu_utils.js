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


/**
 * Build an AVCDecoderConfigurationRecord (ISO/IEC 14496-15 §5.2.4.1)
 * from Annex-B parameter sets (SPS + PPS with start codes).
 *
 * Needed for the Node-side isomorphism gap (MP-39): browser WebCodecs
 * emits decoderConfig.description as a proper avcC record, but our
 * FFmpeg-backed VideoEncoder extracts SPS/PPS in Annex-B form. The
 * fMP4 writer wraps description verbatim into the avcC box, so an
 * Annex-B description produces an invalid init segment that hls.js /
 * Safari reject. This builder closes the gap at the container seam.
 *
 * @param {Uint8Array} annexb  — SPS+PPS in Annex-B (start-code) form
 * @returns {Uint8Array|null}  — avcC record, or null if no SPS found
 */
export function buildAvcCFromAnnexB(annexb) {
  var nalus = splitNALUs(annexb, false);
  var spsList = [], ppsList = [];
  for (var i = 0; i < nalus.length; i++) {
    var t = nalus[i].data[0] & 0x1F;
    if (t === 7) spsList.push(nalus[i].data);
    else if (t === 8) ppsList.push(nalus[i].data);
  }
  if (spsList.length === 0) return null;
  var sps0 = spsList[0];

  var size = 6;                                    // version..numOfSPS (6 fixed bytes)
  for (var s = 0; s < spsList.length; s++) size += 2 + spsList[s].length;
  size += 1;                                       // numOfPictureParameterSets
  for (var p = 0; p < ppsList.length; p++) size += 2 + ppsList[p].length;

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
  return out;
}
