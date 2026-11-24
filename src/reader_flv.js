/**
 * reader_flv — FLV reader for the H.264 / H.265 ENCODE path.
 *
 * Why FLV and not the raw Annex-B stream the encoder used to read:
 * an Annex-B byte stream has no lengths, so the reader (reader_annexb)
 * could only tell that an access unit was complete when the AUD of the
 * NEXT one arrived. Every encoded frame therefore waited inside the
 * reader for the following frame — one frame interval of latency on
 * every frame (33 ms at 30 fps, 100 ms at 10 fps, and on a screen share
 * that sends a frame only when something changes, until the next
 * change). It also depended on the encoder emitting AUDs at all, which
 * only libx264/libx265 do (x264-params aud=1); a hardware encoder
 * without them produced no output from the reader.
 *
 * FLV carries every packet in a tag with its size up front, FFmpeg's
 * muxer writes a tag as soon as the encoder hands it the packet, and it
 * stores H.264 (legacy AVC tags) and H.265 (Enhanced RTMP 'hvc1' tags)
 * — so each frame is emitted the moment its tag is complete. Measured
 * (libx264 / libx265, a frame every 100 ms): 1 frame held with Annex-B,
 * 0 with FLV.
 *
 * Output stays exactly what the encoder emitted before: one Annex-B
 * access unit per 'video' event (start codes, AUD first, in-band
 * parameter sets on key frames). FLV stores length-prefixed NAL units;
 * they are converted back here. When a key frame carries no parameter
 * sets in-band (an encoder that put them only in the sequence header),
 * the ones from the sequence header are inserted after the AUD — what
 * h264_mp4toannexb / hevc_mp4toannexb did on the old path.
 *
 * Events: 'video' {payload, isKeyframe, ptsUs, dtsUs, index, groupId},
 *         'flushed' after flush().
 */

import EventEmitter from './core/events.js';
import {
  avccToAnnexb, splitNALUs, nalusToAnnexb, parseAvcC, parseHvcC,
  H264_NAL_AUD, H264_NAL_SPS, H265_NAL_AUD, H265_NAL_SPS,
} from './utils/nalu_utils.js';

var FLV_HEADER_SIZE = 9 + 4;   // file header + PreviousTagSize0
var TAG_HEADER_SIZE = 11;
var TAG_VIDEO = 9;
var CODEC_AVC = 7, CODEC_HEVC_LEGACY = 12;
// Enhanced RTMP VideoPacketType
var PKT_SEQUENCE_START = 0, PKT_CODED_FRAMES = 1, PKT_CODED_FRAMES_X = 3;

function FLVReader(opts) {
  if (!opts) opts = {};
  this._ee = new EventEmitter();
  this._codec = opts.codec || 'h264';
  this._isH265 = this._codec === 'h265';
  this._index = 0;
  this._groupId = 0;
  this._gotHeader = false;
  this._lengthSize = 4;
  this._paramSets = null;      // Annex-B parameter sets from the sequence header
  this._buf = new Uint8Array(256 * 1024);
  this._start = 0;
  this._end = 0;
}

FLVReader.prototype.on = function (ev, fn) { this._ee.on(ev, fn); };
FLVReader.prototype.off = function (ev, fn) { this._ee.off(ev, fn); };

FLVReader.prototype.feed = function (chunk) {
  this._append(chunk);
  var b = this._buf;
  if (!this._gotHeader) {
    if (this._end - this._start < FLV_HEADER_SIZE) return;
    if (b[this._start] !== 0x46 || b[this._start + 1] !== 0x4C || b[this._start + 2] !== 0x56) {
      throw new Error('FLVReader: not an FLV stream');
    }
    var dataOffset = ((b[this._start + 5] << 24) | (b[this._start + 6] << 16) |
                      (b[this._start + 7] << 8) | b[this._start + 8]) >>> 0;
    if (this._end - this._start < dataOffset + 4) return;
    this._start += dataOffset + 4;
    this._gotHeader = true;
  }
  while (this._end - this._start >= TAG_HEADER_SIZE) {
    var p = this._start;
    var type = b[p] & 0x1f;
    var size = (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
    var total = TAG_HEADER_SIZE + size + 4;
    if (this._end - p < total) break;
    var tsMs = ((b[p + 7] << 24) | (b[p + 4] << 16) | (b[p + 5] << 8) | b[p + 6]) >>> 0;
    // Copy: the buffer is compacted and reused by later feeds, and the
    // payload outlives this call.
    var body = b.slice(p + TAG_HEADER_SIZE, p + TAG_HEADER_SIZE + size);
    this._start += total;
    if (type === TAG_VIDEO && body.length) this._videoTag(body, tsMs);
  }
};

FLVReader.prototype._videoTag = function (body, tsMs) {
  var b0 = body[0];
  var frameType, pktType, data, cts = 0;
  if (b0 & 0x80) {
    // Enhanced RTMP: [1|frameType:3|packetType:4][fourcc:4][CTS:3 if CodedFrames]
    frameType = (b0 >> 4) & 7;
    pktType = b0 & 0x0f;
    if (body.length < 5) return;
    if (pktType === PKT_SEQUENCE_START) data = body.subarray(5);
    else if (pktType === PKT_CODED_FRAMES) { if (body.length < 8) return; cts = _si24(body, 5); data = body.subarray(8); }
    else if (pktType === PKT_CODED_FRAMES_X) data = body.subarray(5);
    else return;   // metadata, sequence end, ...
    if (pktType !== PKT_SEQUENCE_START) pktType = PKT_CODED_FRAMES;
  } else {
    // Legacy: [frameType:4|codecId:4][AVCPacketType][CTS:3]
    var codecId = b0 & 0x0f;
    if (codecId !== CODEC_AVC && codecId !== CODEC_HEVC_LEGACY) return;
    frameType = b0 >> 4;
    if (body.length < 5) return;
    pktType = body[1];          // 0 = sequence header, 1 = NALUs, 2 = end
    if (pktType !== PKT_SEQUENCE_START && pktType !== PKT_CODED_FRAMES) return;
    cts = _si24(body, 2);
    data = body.subarray(5);
  }

  if (pktType === PKT_SEQUENCE_START) {
    var rec = this._isH265 ? parseHvcC(data) : parseAvcC(data);
    if (rec) {
      this._lengthSize = rec.lengthSize || 4;
      // hvcC arrays may also hold SEI (x265 stores its version string
      // there); only VPS/SPS/PPS are parameter sets.
      var ps = this._isH265
        ? rec.nalus.filter(function (n) { var t = (n[0] >> 1) & 0x3f; return t >= 32 && t <= 34; })
        : rec.sps.concat(rec.pps);
      this._paramSets = ps.length ? ps : null;
    }
    return;
  }

  var isKey = frameType === 1;
  var payload = this._toAccessUnit(avccToAnnexb(data, this._lengthSize), isKey);
  if (!payload.length) return;
  if (isKey) this._groupId++;
  // The tag timestamp is the DECODE time; the presentation time adds the
  // packet's CompositionTime (FLV spec AVCVIDEOPACKET; Enhanced RTMP
  // CodedFrames — CodedFramesX has none). It went out as the PTS, so with
  // B-frames every frame was stamped in decode order (FFmpeg: 0.08, 0.2,
  // 0.12 s; here 0, 0.04, 0.08).
  this._ee.emit('video', {
    payload: payload,
    isKeyframe: isKey,
    ptsUs: (tsMs + cts) * 1000,
    dtsUs: tsMs * 1000,
    index: this._index++,
    groupId: this._groupId,
  });
};

/**
 * One Annex-B access unit as the old path emitted it: starting at the
 * AUD (NAL units before it — x264 puts its version SEI first on the
 * first frame — fell before the AUD the Annex-B reader cut at, and an
 * AUD must be the first NAL unit of an access unit), with parameter
 * sets on a key frame.
 */
FLVReader.prototype._toAccessUnit = function (annexb, isKey) {
  var isH265 = this._isH265;
  var nalus = splitNALUs(annexb, isH265);
  var audType = isH265 ? H265_NAL_AUD : H264_NAL_AUD;
  var spsType = isH265 ? H265_NAL_SPS : H264_NAL_SPS;
  var first = 0, hasSps = false;
  for (var i = 0; i < nalus.length; i++) {
    if (nalus[i].type === audType) { first = i; break; }
  }
  var out = [];
  for (var j = first; j < nalus.length; j++) {
    if (nalus[j].type === spsType) hasSps = true;
    out.push(nalus[j].data);
  }
  if (isKey && !hasSps && this._paramSets) {
    var at = (out.length && nalus[first] && nalus[first].type === audType) ? 1 : 0;
    Array.prototype.splice.apply(out, [at, 0].concat(this._paramSets));
  }
  return nalusToAnnexb(out);
};

/**
 * Every complete tag has already been emitted (that is the point of
 * FLV); a partial tag left at end of stream is a truncated write and is
 * dropped. 'flushed' tells the encoder no more 'video' events follow.
 */
FLVReader.prototype.flush = function () {
  this._start = 0;
  this._end = 0;
  this._ee.emit('flushed');
};

// A signed 24-bit big-endian integer (the CompositionTime field).
function _si24(b, o) {
  var v = (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
  return v & 0x800000 ? v - 0x1000000 : v;
}

FLVReader.prototype._append = function (chunk) {
  if (this._start > (this._buf.length >> 1)) {
    var live = this._end - this._start;
    if (live > 0) this._buf.set(this._buf.subarray(this._start, this._end), 0);
    this._end = live;
    this._start = 0;
  }
  if (this._end + chunk.length > this._buf.length) {
    var live2 = this._end - this._start;
    var newBuf = new Uint8Array(Math.max(this._buf.length * 2, live2 + chunk.length));
    if (live2 > 0) newBuf.set(this._buf.subarray(this._start, this._end), 0);
    this._end = live2;
    this._start = 0;
    this._buf = newBuf;
  }
  this._buf.set(chunk, this._end);
  this._end += chunk.length;
};

export default FLVReader;
