/**
 * h26x_parse — the parts of H.264 / H.265 headers a demuxer needs to
 * frame and time an Annex-B byte stream that has no container around it:
 * where an access unit starts, the picture size, and each picture's
 * picture order count (POC — its place in presentation order).
 *
 *   ISO/IEC 14496-10 (H.264): §7.3.2.1.1 SPS, §7.3.2.2 PPS, §7.3.3 slice
 *     header, §7.4.1.2.3 first VCL NAL unit of a primary coded picture,
 *     §8.2.1 POC (types 0, 1, 2).
 *   ISO/IEC 23008-2 (H.265): §7.3.2.2 SPS, §7.3.2.3 PPS, §7.3.6 slice
 *     segment header, §7.4.2.4.4 order of NAL units / access units,
 *     §8.3.1 POC.
 *
 * Sans-I/O, no state but what the caller keeps (PocState).
 * Not read: H.264 memory_management_control_operation 5 (a POC reset in
 * the middle of a period — it sits behind ref_pic_list_modification and
 * pred_weight_table in the slice header), and field pairs (each field is
 * its own access unit here).
 */

import { nalToRbsp } from './nalu_utils.js';

// MSB-first bit reader over an RBSP (emulation prevention removed).
export function Bits(bytes, byteOffset) {
  this.b = bytes;
  this.pos = (byteOffset || 0) * 8;
  this.len = bytes.length * 8;
}
Bits.prototype.u = function (n) {
  var v = 0;
  for (var i = 0; i < n; i++) {
    if (this.pos >= this.len) throw new Error('h26x: header truncated');
    v = v * 2 + ((this.b[this.pos >> 3] >> (7 - (this.pos & 7))) & 1);
    this.pos++;
  }
  return v;
};
Bits.prototype.skip = function (n) {
  if (this.pos + n > this.len) throw new Error('h26x: header truncated');
  this.pos += n;
};
Bits.prototype.ue = function () {
  var zeros = 0;
  while (this.u(1) === 0) if (++zeros > 31) throw new Error('h26x: bad Exp-Golomb code');
  return zeros ? Math.pow(2, zeros) - 1 + this.u(zeros) : 0;
};
Bits.prototype.se = function () {
  var k = this.ue();
  return k & 1 ? (k + 1) / 2 : -k / 2;
};

// The cropped picture size must be a picture: at least 1 × 1 and an
// unsigned long (H.264 §7.4.2.1.1 keeps the cropping window inside the
// picture, H.265 §7.4.3.2.1 the conformance window). A damaged SPS gave a
// negative or zero size (or one past 2^32) as the track's codedWidth.
function _sizeOk(s) { return s.width >= 1 && s.height >= 1 && s.width <= 4294967295 && s.height <= 4294967295; }

// NAL unit type from its first header byte.
export function nalType(nal, h265) { return h265 ? (nal[0] >> 1) & 0x3F : nal[0] & 0x1F; }

// ── H.264 ──

// Profiles whose SPS carries chroma_format_idc etc. (§7.3.2.1.1).
var H264_HIGH = { 100: 1, 110: 1, 122: 1, 244: 1, 44: 1, 83: 1, 86: 1, 118: 1, 128: 1, 138: 1, 139: 1, 134: 1, 135: 1 };

function _skipScalingList(r, size) {
  var last = 8, next = 8;
  for (var j = 0; j < size; j++) {
    if (next !== 0) next = (last + r.se() + 256) % 256;
    last = next === 0 ? last : next;
  }
}

/** An H.264 SPS (NAL unit with its header byte) → what's needed here, or null. */
export function parseH264Sps(nal) {
  try {
    var r = new Bits(nalToRbsp(nal), 1);
    var s = { profile: r.u(8), constraints: r.u(8), level: r.u(8), id: r.ue(), chroma: 1, separateColour: 0 };
    if (H264_HIGH[s.profile]) {
      s.chroma = r.ue();
      if (s.chroma === 3) s.separateColour = r.u(1);
      r.ue(); r.ue();                 // bit depths
      r.u(1);                         // qpprime_y_zero_transform_bypass_flag
      if (r.u(1)) {                   // seq_scaling_matrix_present_flag
        for (var i = 0; i < (s.chroma !== 3 ? 8 : 12); i++) if (r.u(1)) _skipScalingList(r, i < 6 ? 16 : 64);
      }
    }
    s.log2MaxFrameNum = r.ue() + 4;
    s.pocType = r.ue();
    if (s.pocType === 0) s.log2MaxPocLsb = r.ue() + 4;
    else if (s.pocType === 1) {
      s.deltaPicOrderAlwaysZero = r.u(1);
      s.offsetForNonRefPic = r.se();
      s.offsetForTopToBottomField = r.se();
      var n = r.ue();
      s.offsetForRefFrame = [];
      for (var k = 0; k < n; k++) s.offsetForRefFrame.push(r.se());
    }
    r.ue();                           // max_num_ref_frames
    r.u(1);                           // gaps_in_frame_num_value_allowed_flag
    var wMbs = r.ue() + 1, hMap = r.ue() + 1;
    s.frameMbsOnly = r.u(1);
    if (!s.frameMbsOnly) r.u(1);      // mb_adaptive_frame_field_flag
    r.u(1);                           // direct_8x8_inference_flag
    var cl = 0, cr = 0, ct = 0, cb = 0;
    if (r.u(1)) { cl = r.ue(); cr = r.ue(); ct = r.ue(); cb = r.ue(); }
    var mono = s.chroma === 0 || s.separateColour;
    var cx = mono ? 1 : s.chroma === 3 ? 1 : 2;
    var cy = (mono ? 1 : s.chroma === 1 ? 2 : 1) * (2 - s.frameMbsOnly);
    s.width = wMbs * 16 - cx * (cl + cr);
    s.height = (2 - s.frameMbsOnly) * hMap * 16 - cy * (ct + cb);
    return _sizeOk(s) ? s : null;
  } catch (e) { return null; }
}

/** An H.264 PPS → { id, spsId, bottomFieldPicOrder } or null. */
export function parseH264Pps(nal) {
  try {
    var r = new Bits(nalToRbsp(nal), 1);
    var p = { id: r.ue(), spsId: r.ue() };
    r.u(1);                           // entropy_coding_mode_flag
    p.bottomFieldPicOrder = r.u(1);   // bottom_field_pic_order_in_frame_present_flag
    return p;
  } catch (e) { return null; }
}

/**
 * The start of an H.264 slice header (up to the POC fields), given the
 * parameter sets by id. null when its PPS / SPS isn't known.
 */
export function parseH264Slice(nal, spsById, ppsById) {
  try {
    var r = new Bits(nalToRbsp(nal.subarray(0, Math.min(nal.length, 64))), 1);
    var h = { nalType: nal[0] & 0x1F, refIdc: (nal[0] >> 5) & 3, firstMb: r.ue(), sliceType: r.ue() };
    var pps = ppsById[r.ue()];
    var sps = pps && spsById[pps.spsId];
    if (!sps) return null;
    h.sps = sps;
    if (sps.separateColour) r.u(2);
    h.frameNum = r.u(sps.log2MaxFrameNum);
    h.field = 0; h.bottom = 0;
    if (!sps.frameMbsOnly) { h.field = r.u(1); if (h.field) h.bottom = r.u(1); }
    h.idr = h.nalType === 5;
    if (h.idr) r.ue();                // idr_pic_id
    h.pocLsb = 0; h.deltaBottom = 0; h.delta0 = 0; h.delta1 = 0;
    if (sps.pocType === 0) {
      h.pocLsb = r.u(sps.log2MaxPocLsb);
      if (pps.bottomFieldPicOrder && !h.field) h.deltaBottom = r.se();
    } else if (sps.pocType === 1 && !sps.deltaPicOrderAlwaysZero) {
      h.delta0 = r.se();
      if (pps.bottomFieldPicOrder && !h.field) h.delta1 = r.se();
    }
    return h;
  } catch (e) { return null; }
}

/** The POC state carried from picture to picture (copy it to restart there). */
export function newPocState() {
  return { prevMsb: 0, prevLsb: 0, prevFrameNum: 0, prevFrameNumOffset: 0, prevTid0Poc: 0, first: true };
}
export function copyPocState(s) {
  return { prevMsb: s.prevMsb, prevLsb: s.prevLsb, prevFrameNum: s.prevFrameNum, prevFrameNumOffset: s.prevFrameNumOffset, prevTid0Poc: s.prevTid0Poc, first: s.first };
}

/** H.264 §8.2.1: the picture's POC (a frame: min(top, bottom)); updates st. */
export function h264Poc(h, st) {
  var sps = h.sps, top, bottom, poc;
  if (sps.pocType === 0) {
    if (h.idr) { st.prevMsb = 0; st.prevLsb = 0; }
    var max = Math.pow(2, sps.log2MaxPocLsb), msb;
    if (h.pocLsb < st.prevLsb && st.prevLsb - h.pocLsb >= max / 2) msb = st.prevMsb + max;
    else if (h.pocLsb > st.prevLsb && h.pocLsb - st.prevLsb > max / 2) msb = st.prevMsb - max;
    else msb = st.prevMsb;
    top = msb + h.pocLsb;
    bottom = top + h.deltaBottom;
    if (h.refIdc) { st.prevMsb = msb; st.prevLsb = h.pocLsb; }
  } else {
    var maxFrameNum = Math.pow(2, sps.log2MaxFrameNum), offset;
    if (h.idr) offset = 0;
    else if (st.prevFrameNum > h.frameNum) offset = st.prevFrameNumOffset + maxFrameNum;
    else offset = st.prevFrameNumOffset;
    if (sps.pocType === 2) {
      top = bottom = h.idr ? 0 : 2 * (offset + h.frameNum) - (h.refIdc ? 0 : 1);
    } else {
      var n = sps.offsetForRefFrame.length, abs = n ? offset + h.frameNum : 0, expected = 0;
      if (!h.refIdc && abs > 0) abs--;
      if (abs > 0) {
        var perCycle = 0;
        for (var i = 0; i < n; i++) perCycle += sps.offsetForRefFrame[i];
        var cycles = Math.floor((abs - 1) / n), inCycle = (abs - 1) % n;
        expected = cycles * perCycle;
        for (var j = 0; j <= inCycle; j++) expected += sps.offsetForRefFrame[j];
      }
      if (!h.refIdc) expected += sps.offsetForNonRefPic;
      top = expected + h.delta0;
      bottom = top + sps.offsetForTopToBottomField + h.delta1;
    }
    st.prevFrameNum = h.frameNum;
    st.prevFrameNumOffset = offset;
  }
  if (!h.field) poc = Math.min(top, bottom);
  else poc = h.bottom ? bottom : top;
  st.first = false;
  return poc;
}

// ── H.265 ──

/** An H.265 SPS → what's needed here, or null. */
export function parseH265Sps(nal) {
  try {
    var r = new Bits(nalToRbsp(nal), 2);
    r.u(4);                                         // sps_video_parameter_set_id
    var maxSub = r.u(3);
    r.u(1);                                         // sps_temporal_id_nesting_flag
    r.skip(96);                                     // general profile / tier / level
    var subProfile = [], subLevel = [];
    for (var i = 0; i < maxSub; i++) { subProfile.push(r.u(1)); subLevel.push(r.u(1)); }
    if (maxSub > 0) for (var k = maxSub; k < 8; k++) r.skip(2);
    for (var m = 0; m < maxSub; m++) { if (subProfile[m]) r.skip(88); if (subLevel[m]) r.skip(8); }
    var s = { id: r.ue(), chroma: r.ue(), separateColour: 0 };
    if (s.chroma === 3) s.separateColour = r.u(1);
    var w = r.ue(), h = r.ue();
    var cl = 0, cr = 0, ct = 0, cb = 0;
    if (r.u(1)) { cl = r.ue(); cr = r.ue(); ct = r.ue(); cb = r.ue(); }
    var sw = s.chroma === 1 || s.chroma === 2 ? 2 : 1, sh = s.chroma === 1 ? 2 : 1;
    s.width = w - sw * (cl + cr);
    s.height = h - sh * (ct + cb);
    r.ue(); r.ue();                                 // bit depths
    s.log2MaxPocLsb = r.ue() + 4;
    var all = r.u(1);
    s.maxNumReorder = 0;
    for (var j = all ? 0 : maxSub; j <= maxSub; j++) { r.ue(); s.maxNumReorder = r.ue(); r.ue(); }
    return _sizeOk(s) ? s : null;
  } catch (e) { return null; }
}

/** An H.265 PPS → { id, spsId, dependentSlices, outputFlag, extraBits } or null. */
export function parseH265Pps(nal) {
  try {
    var r = new Bits(nalToRbsp(nal), 2);
    return { id: r.ue(), spsId: r.ue(), dependentSlices: r.u(1), outputFlag: r.u(1), extraBits: r.u(3) };
  } catch (e) { return null; }
}

/** The start of an H.265 slice segment header (to slice_pic_order_cnt_lsb). */
export function parseH265Slice(nal, spsById, ppsById) {
  try {
    var r = new Bits(nalToRbsp(nal.subarray(0, Math.min(nal.length, 64))), 2);
    var t = (nal[0] >> 1) & 0x3F;
    var h = { nalType: t, tid: (nal[1] & 7) - 1, first: r.u(1) };
    if (!h.first) return h;                         // not where the picture starts
    if (t >= 16 && t <= 23) r.u(1);                 // no_output_of_prior_pics_flag
    var pps = ppsById[r.ue()];
    var sps = pps && spsById[pps.spsId];
    if (!sps) return null;
    h.sps = sps;
    r.skip(pps.extraBits);                          // slice_reserved_flag[]
    h.sliceType = r.ue();
    if (pps.outputFlag) r.u(1);                     // pic_output_flag
    if (sps.separateColour) r.u(2);                 // colour_plane_id
    h.pocLsb = t === 19 || t === 20 ? 0 : r.u(sps.log2MaxPocLsb);
    return h;
  } catch (e) { return null; }
}

/**
 * H.265 §8.3.1: the picture's POC; updates st. An IDR / BLA, or the
 * first picture (a CRA there has NoRaslOutputFlag = 1), starts a new
 * POC period: `reset` is set on the result.
 */
export function h265Poc(h, st) {
  var t = h.nalType, max = Math.pow(2, h.sps.log2MaxPocLsb), msb;
  var irap = t >= 16 && t <= 23;
  var reset = (irap && (t <= 20 || st.first));
  if (reset) msb = 0;
  else {
    var prevLsb = st.prevTid0Poc & (max - 1), prevMsb = st.prevTid0Poc - prevLsb;
    if (h.pocLsb < prevLsb && prevLsb - h.pocLsb >= max / 2) msb = prevMsb + max;
    else if (h.pocLsb > prevLsb && h.pocLsb - prevLsb > max / 2) msb = prevMsb - max;
    else msb = prevMsb;
  }
  var poc = msb + h.pocLsb;
  // prevTid0Pic: TemporalId 0 and not a RASL, RADL or sub-layer non-reference picture.
  var slnr = t <= 14 && !(t & 1);
  if (h.tid === 0 && !(t >= 6 && t <= 9) && !slnr) st.prevTid0Poc = poc;
  st.first = false;
  return { poc: poc, reset: reset };
}

/**
 * Does this NAL unit begin a new access unit, given that the current one
 * already holds a VCL NAL unit (a picture)? H.264 §7.4.1.2.3, H.265
 * §7.4.2.4.4: an AUD, parameter sets, a (prefix) SEI and the reserved
 * types that precede a picture do; so does the first slice of the next
 * picture (first_mb_in_slice 0 / first_slice_segment_in_pic_flag 1).
 */
export function startsAccessUnit(nal, h265) {
  if (!nal.length) return false;
  if (!h265) {
    var t = nal[0] & 0x1F;
    if (t === 9 || t === 7 || t === 8 || t === 6 || (t >= 14 && t <= 18)) return true;
    if (t === 1 || t === 5) return nal.length > 1 && (nal[1] & 0x80) !== 0;   // ue(v) 0 is a single 1 bit
    return false;
  }
  if (nal.length < 2) return false;
  var u = (nal[0] >> 1) & 0x3F, layer = ((nal[0] & 1) << 5) | (nal[1] >> 3);
  if (layer) return false;                          // another layer of the same access unit
  if (u === 35 || u === 32 || u === 33 || u === 34 || u === 39 || (u >= 41 && u <= 44) || (u >= 48 && u <= 55)) return true;
  if (u <= 31) return nal.length > 2 && (nal[2] & 0x80) !== 0;
  return false;
}

/**
 * An end of sequence NAL unit (H.264 type 10, H.265 type 36)? The picture
 * after it starts a new coded video sequence: in H.265 it is an IRAP with
 * NoRaslOutputFlag = 1 (§8.1.3), so a CRA there resets the POC as an IDR
 * does — see endOfSequence(). (H.264 §7.4.1.2.3: an IDR follows it.)
 */
export function isEndOfSequence(nal, h265) {
  if (!nal.length) return false;
  return h265 ? ((nal[0] >> 1) & 0x3F) === 36 : (nal[0] & 0x1F) === 10;
}

/**
 * After an end of sequence NAL unit: the next picture is taken as the
 * first of the bitstream (H.265: NoRaslOutputFlag = 1). A CRA there was
 * given a POC from the pictures before the end of sequence (its MSB from
 * their prevTid0Pic), so a stream joined after EOS — FFmpeg's hevc
 * decoder starts a new sequence there — was timed back inside the first.
 */
export function endOfSequence(st) { st.first = true; }

/** Is this NAL unit part of a picture (VCL)? */
export function isVcl(nal, h265) {
  if (!h265) { var t = nal[0] & 0x1F; return t >= 1 && t <= 5; }
  return ((nal[0] >> 1) & 0x3F) <= 31;
}
