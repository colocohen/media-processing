/**
 * writer_annexb.js — Annex-B framing writer (the inverse of reader_annexb.js).
 *
 * Like writer_adts, this is a THIN class kept for reader/writer naming
 * symmetry (reader_annexb ↔ writer_annexb). It owns no framing logic:
 * every byte it produces comes from nalu_utils.nalusToAnnexb /
 * avccToAnnexb, which remain the single source of truth. The class just
 * gives the inverse of reader_annexb a stateful-looking, class-shaped API
 * consistent with the other writer_* classes.
 *
 * Symmetry: reader_annexb.feed(annexbBytes) emits 'video' access units /
 * NALUs; writer_annexb turns NALUs (or length-prefixed AVCC) back into an
 * Annex-B byte stream.
 */

import { nalusToAnnexb, avccToAnnexb } from './utils/nalu_utils.js';

/**
 * @param {object} [opts]
 * @param {string} [opts.codec='h264'] 'h264' | 'h265' (informational; the
 *        Annex-B start-code framing is identical for both)
 */
function AnnexBWriter(opts) {
  if (!opts) opts = {};
  this._codec = opts.codec || 'h264';
}

/**
 * Join raw NAL units into an Annex-B stream (each NALU prefixed with a
 * 4-byte 0x00000001 start code).
 * @param {Uint8Array[]} nalus array of raw NAL units (no start codes)
 * @returns {Uint8Array} Annex-B byte stream
 */
AnnexBWriter.prototype.writeNALUs = function (nalus) {
  return nalusToAnnexb(nalus || []);
};

/**
 * Convert a length-prefixed AVCC/HVCC buffer into an Annex-B stream.
 * @param {Uint8Array} avcc       length-prefixed NAL data (AVCC/HVCC)
 * @param {number} [lengthSize=4] size in bytes of each NAL length prefix
 * @returns {Uint8Array} Annex-B byte stream
 */
AnnexBWriter.prototype.writeAvcc = function (avcc, lengthSize) {
  return avccToAnnexb(avcc, lengthSize);
};

export default AnnexBWriter;
