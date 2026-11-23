/**
 * writer_mkv — minimal streaming Matroska writer (one or more tracks).
 *
 * Written for the Muxer: it hands FFmpeg each track's chunks in a
 * container that carries the chunks' own timestamps, so `-c copy` keeps
 * them. Raw Annex-B / ADTS / one-page-per-packet Ogg — what the Muxer
 * used before — carry none: H.264/H.265 were read at a constant frame
 * rate and audio was timed by sample count, so any gap in the chunk
 * timestamps (dropped frames, a paused capture) was squeezed out of the
 * output and audio and video drifted apart by the gap.
 *
 * Streaming layout (no seeking, nothing rewritten):
 *   EBML header
 *   Segment (unknown size)
 *     Info     TimestampScale = 1000 ns  — timestamps in µs, the
 *                                          WebCodecs unit, so they pass
 *                                          through without rounding
 *     Tracks
 *     Cluster (unknown size) { Timestamp, SimpleBlock... }
 *     Cluster ...
 *
 * A SimpleBlock's timestamp is an int16 relative to its cluster, i.e.
 * ±32.767 ms at this scale; a new cluster starts whenever a frame falls
 * outside that window (and at every video keyframe).
 *
 * Usage:
 *   var w = new MKVWriter({ tracks: [{ type: 'video', codecId: 'V_VP9', width: 640, height: 480 }] });
 *   out.write(w.writeHeader());
 *   out.write(w.writeFrame(1, data, timestampUs, isKey));
 */

import { concat, fromAscii } from './core/bytes.js';

var TIMESTAMP_SCALE_NS = 1000;   // 1 µs per tick

// ── EBML primitives ──

function _idBytes(id) {
  if (id > 0xFFFFFF) return [(id >>> 24) & 0xFF, (id >>> 16) & 0xFF, (id >>> 8) & 0xFF, id & 0xFF];
  if (id > 0xFFFF) return [(id >>> 16) & 0xFF, (id >>> 8) & 0xFF, id & 0xFF];
  if (id > 0xFF) return [(id >>> 8) & 0xFF, id & 0xFF];
  return [id & 0xFF];
}

// EBML variable-size integer for an element data size.
function _sizeBytes(n) {
  var len = 1;
  while (len < 8 && n >= Math.pow(2, 7 * len) - 1) len++;
  var out = new Array(len);
  var v = n;
  for (var i = len - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0] |= (0x80 >> (len - 1));
  return out;
}

var UNKNOWN_SIZE = [0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF];

function _el(id, payload) {
  var head = _idBytes(id).concat(_sizeBytes(payload.length));
  var out = new Uint8Array(head.length + payload.length);
  out.set(head, 0);
  out.set(payload, head.length);
  return out;
}

function _uint(id, value) {
  var bytes = [];
  var v = value;
  do { bytes.unshift(v % 256); v = Math.floor(v / 256); } while (v > 0);
  return _el(id, new Uint8Array(bytes));
}

function _float(id, value) {
  var b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, value, false);
  return _el(id, b);
}

function _str(id, s) { return _el(id, fromAscii(s)); }

function _master(id, children) { return _el(id, concat(children)); }

// ── Element IDs (Matroska / EBML) ──
var ID = {
  EBML: 0x1A45DFA3, EBMLVersion: 0x4286, EBMLReadVersion: 0x42F7,
  EBMLMaxIDLength: 0x42F2, EBMLMaxSizeLength: 0x42F3,
  DocType: 0x4282, DocTypeVersion: 0x4287, DocTypeReadVersion: 0x4285,
  Segment: 0x18538067, Info: 0x1549A966, TimestampScale: 0x2AD7B1,
  MuxingApp: 0x4D80, WritingApp: 0x5741,
  Tracks: 0x1654AE6B, TrackEntry: 0xAE, TrackNumber: 0xD7, TrackUID: 0x73C5,
  TrackType: 0x83, FlagLacing: 0x9C, CodecID: 0x86, CodecPrivate: 0x63A2,
  CodecDelay: 0x56AA, SeekPreRoll: 0x56BB,
  Video: 0xE0, PixelWidth: 0xB0, PixelHeight: 0xBA,
  Audio: 0xE1, SamplingFrequency: 0xB5, Channels: 0x9F,
  Cluster: 0x1F43B675, Timestamp: 0xE7, SimpleBlock: 0xA3,
};

/**
 * @param {object} opts
 * @param {Array}  opts.tracks  [{ type:'video'|'audio', codecId, codecPrivate?,
 *                                 width?, height?, sampleRate?, channels?,
 *                                 codecDelayNs?, seekPreRollNs? }]
 *                              Track numbers are 1-based, in this order.
 * @param {string} [opts.docType='matroska']
 */
function MKVWriter(opts) {
  if (!opts || !opts.tracks || !opts.tracks.length) throw new Error('MKVWriter: at least one track required');
  this._tracks = opts.tracks;
  this._docType = opts.docType || 'matroska';
  this._clusterTs = null;        // current cluster's timestamp (µs), null = none open
}

MKVWriter.prototype.writeHeader = function () {
  var ebml = _master(ID.EBML, [
    _uint(ID.EBMLVersion, 1), _uint(ID.EBMLReadVersion, 1),
    _uint(ID.EBMLMaxIDLength, 4), _uint(ID.EBMLMaxSizeLength, 8),
    _str(ID.DocType, this._docType), _uint(ID.DocTypeVersion, 4), _uint(ID.DocTypeReadVersion, 2),
  ]);
  var segHead = new Uint8Array(_idBytes(ID.Segment).concat(UNKNOWN_SIZE));
  var info = _master(ID.Info, [
    _uint(ID.TimestampScale, TIMESTAMP_SCALE_NS),
    _str(ID.MuxingApp, 'media-processing'), _str(ID.WritingApp, 'media-processing'),
  ]);
  var entries = [];
  for (var i = 0; i < this._tracks.length; i++) {
    var t = this._tracks[i];
    var kids = [
      _uint(ID.TrackNumber, i + 1),
      _uint(ID.TrackUID, i + 1),
      _uint(ID.TrackType, t.type === 'video' ? 1 : 2),
      _uint(ID.FlagLacing, 0),
      _str(ID.CodecID, t.codecId),
    ];
    if (t.codecPrivate && t.codecPrivate.length) kids.push(_el(ID.CodecPrivate, t.codecPrivate));
    if (t.codecDelayNs) kids.push(_uint(ID.CodecDelay, t.codecDelayNs));
    if (t.seekPreRollNs) kids.push(_uint(ID.SeekPreRoll, t.seekPreRollNs));
    if (t.type === 'video') {
      kids.push(_master(ID.Video, [_uint(ID.PixelWidth, t.width || 0), _uint(ID.PixelHeight, t.height || 0)]));
    } else {
      kids.push(_master(ID.Audio, [_float(ID.SamplingFrequency, t.sampleRate || 48000), _uint(ID.Channels, t.channels || 2)]));
    }
    entries.push(_master(ID.TrackEntry, kids));
  }
  return concat([ebml, segHead, info, _master(ID.Tracks, entries)]);
};

/**
 * One frame as a SimpleBlock, preceded by a new Cluster when needed.
 * @param {number} trackNumber  1-based
 * @param {Uint8Array} data
 * @param {number} timestampUs  >= 0 (Cluster timestamps are unsigned)
 * @param {boolean} isKey
 * @returns {Uint8Array}
 */
MKVWriter.prototype.writeFrame = function (trackNumber, data, timestampUs, isKey) {
  var ts = Math.max(0, Math.round(timestampUs));
  var parts = [];
  var isVideo = this._tracks[trackNumber - 1] && this._tracks[trackNumber - 1].type === 'video';
  var rel = this._clusterTs === null ? null : ts - this._clusterTs;
  if (rel === null || rel < -32768 || rel > 32767 || (isKey && isVideo && rel !== 0)) {
    this._clusterTs = ts;
    rel = 0;
    parts.push(new Uint8Array(_idBytes(ID.Cluster).concat(UNKNOWN_SIZE)));
    parts.push(_uint(ID.Timestamp, ts));
  }
  var head = _sizeBytes(trackNumber);   // track number as a vint
  var block = new Uint8Array(head.length + 3 + data.length);
  block.set(head, 0);
  var o = head.length;
  var r = rel & 0xFFFF;
  block[o] = (r >> 8) & 0xFF;
  block[o + 1] = r & 0xFF;
  block[o + 2] = isKey ? 0x80 : 0x00;
  block.set(data, o + 3);
  parts.push(_el(ID.SimpleBlock, block));
  return parts.length === 1 ? parts[0] : concat(parts);
};

export default MKVWriter;
