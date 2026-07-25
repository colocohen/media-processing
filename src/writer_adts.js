/**
 * writer_adts.js — ADTS framing writer (the inverse of reader_adts.js).
 *
 * This is a deliberately THIN class: a stateful-looking API for symmetry
 * with reader_adts / the other writer_* classes, but it owns no logic of
 * its own — every byte it produces is built by aac_utils.wrapAdts /
 * buildAdtsHeader, which remain the single source of truth for ADTS
 * framing. The class exists so the reader/writer naming is symmetric
 * (reader_adts ↔ writer_adts) without duplicating the framing code.
 *
 * Symmetry: reader_adts.feed(adtsBytes) emits 'audio' { payload: rawAac };
 * writer_adts.writeFrame(rawAac) returns those adtsBytes back.
 */

import { wrapAdts, buildAdtsHeader } from './utils/aac_utils.js';

/**
 * @param {object} opts
 * @param {string|number} [opts.profile='lc'] AAC profile ('lc'/'main'/'ssr'
 *        or a 2-bit numeric profile field)
 * @param {number} [opts.sampleRate=48000]    audio sample rate (Hz)
 * @param {number} [opts.channels=2]          channel count
 */
function ADTSWriter(opts) {
  if (!opts) opts = {};
  this._profile    = (opts.profile != null) ? opts.profile : 'lc';
  this._sampleRate = opts.sampleRate || 48000;
  this._channels   = opts.channels || 2;
}

/**
 * Wrap one raw AAC access unit in an ADTS frame (7-byte header + payload).
 * @param {Uint8Array} rawAac raw AAC frame (no ADTS header)
 * @returns {Uint8Array} complete ADTS frame
 */
ADTSWriter.prototype.writeFrame = function (rawAac) {
  return wrapAdts(rawAac, {
    profile: this._profile,
    sampleRate: this._sampleRate,
    channels: this._channels,
  });
};

/**
 * Build just the 7-byte ADTS header for a frame of the given payload
 * length (rarely needed directly — writeFrame() is the usual entry point).
 * @param {number} payloadLength length of the raw AAC payload in bytes
 * @returns {Uint8Array} 7-byte ADTS header
 */
ADTSWriter.prototype.writeHeader = function (payloadLength) {
  return buildAdtsHeader({
    profile: this._profile,
    sampleRate: this._sampleRate,
    channels: this._channels,
    frameLength: 7 + (payloadLength || 0),
  });
};

export default ADTSWriter;
