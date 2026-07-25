/**
 * reader_annexb — H.264/H.265 Annex-B byte stream reader (Node side).
 *
 * Streaming reader that turns a raw Annex-B pipe (FFmpeg stdout) into
 * discrete access units, emitted as 'video' events. Uses a flat
 * ring-style buffer with compact-on-consume.
 *
 * The pure byte-level helpers (findAUD, splitNALUs, hasIDR_*, AVCC
 * conversions, NAL-type constants) now live in utils/nalu_utils.js and
 * are imported here — no duplication. This file keeps ONLY the stateful
 * streaming class plus extractParameterSetsAnnexB(), which returns the
 * concatenated Annex-B form the Demuxer needs for decoder description
 * (distinct from nalu_utils.extractParameterSets, which returns a
 * structured {sps,pps,vps} for the HLS writers).
 */

import EventEmitter from './core/events.js';
import {
  findAUD, findLastStartCode, hasIDR_H264, hasIDR_H265,
  splitNALUs, nalusToAnnexb, annexbToAvcc, avccToAnnexb,
  H264_NAL_AUD, H265_NAL_AUD,
  H264_NAL_SPS, H264_NAL_PPS,
  H265_NAL_VPS, H265_NAL_SPS, H265_NAL_PPS,
} from './utils/nalu_utils.js';

function AnnexBReader(opts) {
  if (!opts) opts = {};
  this._ee = new EventEmitter();
  this._maxBuf = opts.maxBuf || (8 * 1024 * 1024);
  this._fps = opts.fps || 30;
  this._codec = opts.codec || 'h264';
  this._index = 0;
  this._groupId = 0;

  this._buf = new Uint8Array(256 * 1024);
  this._start = 0;
  this._end = 0;
}

AnnexBReader.prototype.on = function (ev, fn) { this._ee.on(ev, fn); };
AnnexBReader.prototype.off = function (ev, fn) { this._ee.off(ev, fn); };

AnnexBReader.prototype.feed = function (chunk) {
  this._append(chunk);
  if ((this._end - this._start) > this._maxBuf) this._resync();

  var audType = this._codec === 'h265' ? H265_NAL_AUD : H264_NAL_AUD;
  var isH265 = this._codec === 'h265';

  while (true) {
    var first = findAUD(this._buf, this._start, this._end, audType, isH265);
    if (first < 0) break;
    var second = findAUD(this._buf, first + 3, this._end, audType, isH265);
    if (second < 0) break;

    var au = this._buf.slice(first, second);
    this._start = second;

    var isKey = isH265 ? hasIDR_H265(au) : hasIDR_H264(au);
    if (isKey) this._groupId++;
    var ptsUs = Math.floor(this._index * 1000000 / this._fps);

    this._ee.emit('video', {
      payload: au,
      isKeyframe: isKey,
      ptsUs: ptsUs,
      index: this._index++,
      groupId: this._groupId,
    });
  }
};

/**
 * Flush any AU still buffered after the upstream pipe has closed.
 *
 * The feed() loop emits an AU only when it can find the START of the
 * NEXT AU (so it knows where the current one ends). At end-of-stream
 * there's no "next" AUD — the trailing AU sits in the buffer and is
 * never emitted. flush() handles this case: if a start-code is found
 * before _end, treat everything from there to _end as the final AU.
 *
 * Critical for keyframe-restart correctness: when an old FFmpeg exits,
 * its reader's tail AU (often a P-frame from the moment just before
 * the restart) must be emitted before the transition releases.
 * Otherwise the receiver sees a gap or out-of-order frames after the
 * new keyframe arrives. See test_restart_real_world.js.
 */
AnnexBReader.prototype.flush = function () {
  var audType = this._codec === 'h265' ? H265_NAL_AUD : H264_NAL_AUD;
  var isH265 = this._codec === 'h265';

  // If a start code remains and there's data after it, that data is
  // the trailing AU — emit it.
  var first = findAUD(this._buf, this._start, this._end, audType, isH265);
  if (first >= 0 && first < this._end) {
    var au = this._buf.slice(first, this._end);
    var isKey = isH265 ? hasIDR_H265(au) : hasIDR_H264(au);
    if (isKey) this._groupId++;
    var ptsUs = Math.floor(this._index * 1000000 / this._fps);

    this._ee.emit('video', {
      payload: au,
      isKeyframe: isKey,
      ptsUs: ptsUs,
      index: this._index++,
      groupId: this._groupId,
    });
  }

  // Reset for potential reuse (rare — readers are typically created
  // per FFmpeg instance, but we keep the contract symmetric).
  this._start = 0;
  this._end = 0;

  // Signal to listeners that no more 'video' events will come from
  // this reader. The encoder's transition logic uses this to know
  // when to release the buffered new-FFmpeg outputs.
  this._ee.emit('flushed');
};

AnnexBReader.prototype._append = function (chunk) {
  if (this._start > (this._buf.length >> 1)) {
    var live = this._end - this._start;
    if (live > 0) this._buf.set(this._buf.subarray(this._start, this._end), 0);
    this._end = live;
    this._start = 0;
  }
  if (this._end + chunk.length > this._buf.length) {
    var newSize = Math.max(this._buf.length * 2, this._end - this._start + chunk.length);
    var newBuf = new Uint8Array(newSize);
    var live2 = this._end - this._start;
    if (live2 > 0) newBuf.set(this._buf.subarray(this._start, this._end), 0);
    this._end = live2;
    this._start = 0;
    this._buf = newBuf;
  }
  this._buf.set(chunk, this._end);
  this._end += chunk.length;
};

AnnexBReader.prototype._resync = function () {
  var keep = 1024 * 1024;
  var live = this._end - this._start;
  if (live <= keep) return;
  var from = this._end - keep;
  var pos = findLastStartCode(this._buf, from, this._end);
  if (pos < 0) { this._start = 0; this._end = 0; return; }
  var tail = this._end - pos;
  this._buf.set(this._buf.subarray(pos, this._end), 0);
  this._start = 0;
  this._end = tail;
};

// ══════════════════════════════════════════════════════════
// Demuxer-facing parameter-set extraction.
//
// Returns the SPS+PPS (H.264) or VPS+SPS+PPS (H.265) concatenated in
// Annex-B form (start-code framed) as a single Uint8Array, or null.
// This is the shape Demuxer stores as the VideoDecoder `description`.
// (nalu_utils.extractParameterSets returns a structured {sps,pps,vps}
// object instead — used by the HLS writers. Same name, different
// contract on purpose; both reuse splitNALUs from nalu_utils.)
// ══════════════════════════════════════════════════════════
function extractParameterSetsAnnexB(au, isH265) {
  var nalus = splitNALUs(au, isH265);
  var params = [];
  for (var i = 0; i < nalus.length; i++) {
    var t = nalus[i].type;
    if (!isH265 && (t === H264_NAL_SPS || t === H264_NAL_PPS)) {
      params.push(nalus[i].data);
    } else if (isH265 && (t === H265_NAL_VPS || t === H265_NAL_SPS || t === H265_NAL_PPS)) {
      params.push(nalus[i].data);
    }
  }
  if (params.length === 0) return null;
  // [00 00 00 01][NALU][00 00 00 01][NALU]... — nalusToAnnexb (nalu_utils)
  return nalusToAnnexb(params);
}

export default AnnexBReader;
// Re-export the shared helpers so existing import sites that pull them
// from reader_annexb keep working; implementations are single-sourced
// in nalu_utils.
export {
  findAUD, findLastStartCode, hasIDR_H264, hasIDR_H265,
  splitNALUs, annexbToAvcc, avccToAnnexb,
  H264_NAL_AUD, H265_NAL_AUD,
  extractParameterSetsAnnexB,
};
