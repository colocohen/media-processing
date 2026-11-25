/**
 * av1_utils — the AV1CodecConfigurationRecord (av1C) a WebCodecs AV1
 * config carries, from a temporal unit's sequence header OBU — for a
 * container that has none of its own (IVF).
 *
 *   AV1 bitstream spec §5.3 (OBU header), §5.5 (sequence_header_obu),
 *   §5.5.2 (color_config); "AV1 Codec ISO Media File Format Binding"
 *   §2.3 (av1C: marker, version, seq_profile, seq_level_idx_0,
 *   seq_tier_0, high_bitdepth, twelve_bit, monochrome,
 *   chroma_subsampling_x / _y, chroma_sample_position,
 *   initial_presentation_delay, then configOBUs — the sequence header).
 */

import { Bits } from './h26x_parse.js';

var OBU_SEQUENCE_HEADER = 1;

// leb128 (§4.10.5): { value, bytes } or null.
function _leb128(b, o) {
  var v = 0;
  for (var i = 0; i < 8; i++) {
    if (o + i >= b.length) return null;
    v += (b[o + i] & 0x7F) * Math.pow(2, 7 * i);
    if (!(b[o + i] & 0x80)) return { value: v, bytes: i + 1 };
  }
  return null;
}

// uvlc() (§4.10.3). It stopped at the 32nd leading zero, leaving the
// terminating 1 (and any further zeros) to be read as the next fields; the
// spec reads on to the 1 and gives 2^32 − 1 without value bits. That value
// is outside the one field coded so (num_ticks_per_picture_minus_1: 0 to
// 2^32 − 2, §6.4.2): the header is invalid (FFmpeg's cbs refuses it too;
// dav1d stops at 32, as this did).
function _uvlc(r) {
  var lz = 0;
  while (!r.u(1)) lz++;
  if (lz >= 32) throw new Error('av1: uvlc() of 32 leading zeros (2^32 − 1: out of range)');
  return lz ? r.u(lz) + Math.pow(2, lz) - 1 : 0;
}

/**
 * The sequence header OBU in a temporal unit (low-overhead format: every
 * OBU has obu_has_size_field — what IVF, MP4 and Matroska carry):
 * { obu (the whole OBU, header and size), payload } or null.
 */
export function findSequenceHeader(tu) {
  var p = 0;
  while (p < tu.length) {
    var b0 = tu[p];
    if (b0 & 0x80) return null;                      // obu_forbidden_bit
    var type = (b0 >> 3) & 0x0F, ext = (b0 >> 2) & 1, hasSize = (b0 >> 1) & 1;
    if (!hasSize) return null;
    var h = 1 + ext, s = _leb128(tu, p + h);
    if (!s) return null;
    var start = p + h + s.bytes, end = start + s.value;
    if (end > tu.length) return null;
    if (type === OBU_SEQUENCE_HEADER) return { obu: tu.subarray(p, end), payload: tu.subarray(start, end) };
    p = end;
  }
  return null;
}

/** sequence_header_obu() fields up to color_config(), or null. */
export function parseSequenceHeader(payload) {
  try {
    var r = new Bits(payload, 0);
    var s = { profile: r.u(3), still: r.u(1), reduced: r.u(1), level: 0, tier: 0 };
    var decoderModel = 0, bufferDelayLen = 0;
    if (s.reduced) {
      s.level = r.u(5);
    } else {
      if (r.u(1)) {                                  // timing_info_present_flag
        r.skip(64);                                  // num_units_in_display_tick, time_scale
        if (r.u(1)) _uvlc(r);                        // equal_picture_interval → num_ticks_per_picture_minus_1
        decoderModel = r.u(1);
        if (decoderModel) {
          bufferDelayLen = r.u(5) + 1;
          r.skip(32);                                // num_units_in_decoding_tick
          r.skip(10);                                // buffer_removal_time_length_minus_1, frame_presentation_time_length_minus_1
        }
      }
      var initialDelay = r.u(1);
      var ops = r.u(5) + 1;
      for (var i = 0; i < ops; i++) {
        r.skip(12);                                  // operating_point_idc
        var lv = r.u(5), tier = lv > 7 ? r.u(1) : 0;
        if (i === 0) { s.level = lv; s.tier = tier; }
        if (decoderModel && r.u(1)) r.skip(2 * bufferDelayLen + 1);
        if (initialDelay && r.u(1)) r.skip(4);
      }
    }
    var wb = r.u(4) + 1, hb = r.u(4) + 1;
    s.width = r.u(wb) + 1;
    s.height = r.u(hb) + 1;
    if (!s.reduced && r.u(1)) r.skip(7);             // frame_id_numbers_present_flag → lengths
    r.skip(3);                                       // use_128x128_superblock, enable_filter_intra, enable_intra_edge_filter
    if (!s.reduced) {
      r.skip(4);                                     // interintra, masked compound, warped motion, dual filter
      var orderHint = r.u(1);
      if (orderHint) r.skip(2);                      // enable_jnt_comp, enable_ref_frame_mvs
      var force = r.u(1) ? 2 : r.u(1);               // seq_choose_screen_content_tools ? SELECT : seq_force_screen_content_tools
      if (force > 0 && !r.u(1)) r.u(1);              // seq_choose_integer_mv / seq_force_integer_mv
      if (orderHint) r.skip(3);                      // order_hint_bits_minus_1
    }
    r.skip(3);                                       // enable_superres, enable_cdef, enable_restoration
    // color_config()
    s.highBitdepth = r.u(1);
    s.twelveBit = s.profile === 2 && s.highBitdepth ? r.u(1) : 0;
    s.bitDepth = s.twelveBit ? 12 : s.highBitdepth ? 10 : 8;
    s.mono = s.profile === 1 ? 0 : r.u(1);
    var cp = 2, tc = 2, mc = 2;
    if (r.u(1)) { cp = r.u(8); tc = r.u(8); mc = r.u(8); }
    s.colorPrimaries = cp; s.transfer = tc; s.matrix = mc;
    s.subX = 1; s.subY = 1; s.chromaPos = 0;
    if (s.mono) { s.fullRange = r.u(1); return s; }
    if (cp === 1 && tc === 13 && mc === 0) { s.fullRange = 1; s.subX = 0; s.subY = 0; return s; }
    s.fullRange = r.u(1);
    if (s.profile === 0) { s.subX = 1; s.subY = 1; }
    else if (s.profile === 1) { s.subX = 0; s.subY = 0; }
    else if (s.bitDepth === 12) { s.subX = r.u(1); s.subY = s.subX ? r.u(1) : 0; }
    else { s.subX = 1; s.subY = 0; }
    if (s.subX && s.subY) s.chromaPos = r.u(2);
    return s;
  } catch (e) { return null; }
}

/** av1C from a temporal unit holding a sequence header: { av1C, seq } or null. */
export function av1CFromTemporalUnit(tu) {
  var sh = findSequenceHeader(tu);
  var s = sh && parseSequenceHeader(sh.payload);
  if (!s) return null;
  var rec = new Uint8Array(4 + sh.obu.length);
  rec[0] = 0x81;                                     // marker, version 1
  rec[1] = (s.profile << 5) | s.level;
  rec[2] = (s.tier << 7) | (s.highBitdepth << 6) | (s.twelveBit << 5) | (s.mono << 4) |
           (s.subX << 3) | (s.subY << 2) | s.chromaPos;
  rec[3] = 0;                                        // no initial_presentation_delay
  rec.set(sh.obu, 4);
  return { av1C: rec, seq: s };
}
