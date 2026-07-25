/**
 * writer_ogg — OGG container writer for Opus audio (RFC 3533 + RFC 7845).
 *
 * Symmetric counterpart to reader_ogg.js. Given raw Opus packets (as they
 * come out of an RTP depayloader, a network socket, or a libopus encoder),
 * produces a standards-compliant OGG Opus bitstream suitable for:
 *   - Feeding to an FFmpeg decoder via stdin
 *   - Writing directly to a .opus file
 *   - Streaming via HTTP / storing in a blob
 *
 * Usage:
 *   var writer = new OggWriter({ channels: 2 });
 *   fileOrPipe.write(writer.writeHeaders());
 *   for each opusPacket:
 *     fileOrPipe.write(writer.writePacket(opusPacket, 960));
 *
 * Each call to writePacket() returns one complete OGG page containing
 * that single Opus packet. This is the lowest-latency configuration —
 * the decoder can start emitting PCM as soon as a page arrives rather
 * than waiting for OGG page-level buffering to fill.
 */

import { getOpusPacketDurationUs } from './utils/opus_utils.js';
import { writeU16LE, writeU32LE, concat, fromAscii } from './core/bytes.js';

// ── Ogg CRC32 table ──
//
// Ogg uses CRC-32 with polynomial 0x04C11DB7, UNREFLECTED ("normal"
// form), initial value 0, no final XOR. This is different from the
// common zlib/Ethernet CRC-32, which uses the reflected polynomial
// 0xEDB88320 and XOR-finalizes with 0xFFFFFFFF. Do NOT substitute one
// for the other.
//
// Reference: https://xiph.org/ogg/doc/framing.html

var _CRC_TABLE = (function () {
  var table = new Uint32Array(256);
  for (var i = 0; i < 256; i++) {
    var crc = (i << 24) >>> 0;
    for (var j = 0; j < 8; j++) {
      if (crc & 0x80000000) crc = (((crc << 1) >>> 0) ^ 0x04C11DB7) >>> 0;
      else                  crc = (crc << 1) >>> 0;
    }
    table[i] = crc >>> 0;
  }
  return table;
})();

function _crc32(buf) {
  var crc = 0;
  for (var i = 0; i < buf.length; i++) {
    crc = (((crc << 8) >>> 0) ^ _CRC_TABLE[((crc >>> 24) ^ buf[i]) & 0xFF]) >>> 0;
  }
  return crc;
}


// ── Constants from RFC 7845 ──

var OPUS_SAMPLE_RATE   = 48000;  // Opus RTP clock rate is always 48 kHz
var OPUS_PACKET_SAMPLES = 960;   // 20 ms @ 48 kHz — WebRTC default ptime

// Page header flags (RFC 3533 §6)
var FLAG_CONTINUATION = 0x01;
var FLAG_BOS          = 0x02;   // beginning of stream
var FLAG_EOS          = 0x04;   // end of stream


/**
 * OggWriter — stateful OGG Opus page generator.
 *
 * @param {object}  opts
 * @param {number} [opts.channels=2]         output channel count
 * @param {number} [opts.serial]             bitstream serial (random if omitted)
 * @param {number} [opts.preSkip=0]          samples to discard at start; use 3840
 *                                           (80 ms) when muxing a fresh encode,
 *                                           0 when wrapping mid-stream RTP
 * @param {number} [opts.inputSampleRate=48000]  informational only
 * @param {string} [opts.vendor]             OpusTags vendor string
 */
function OggWriter(opts) {
  if (!opts) opts = {};
  this._channels   = opts.channels || 2;
  this._serial     = (opts.serial != null)
                      ? (opts.serial >>> 0)
                      : ((Math.random() * 0xFFFFFFFF) >>> 0);
  this._preSkip    = (opts.preSkip != null) ? opts.preSkip : 0;
  this._inputRate  = opts.inputSampleRate || OPUS_SAMPLE_RATE;
  this._vendor     = opts.vendor || 'media-processing';

  this._sequence   = 0;     // page sequence number, increments per page
  this._granule    = 0;     // running 48 kHz sample count
}

/**
 * Build the two mandatory header pages (ID + comments) and return them
 * as a single concatenated Buffer. Call this ONCE before any data pages.
 */
OggWriter.prototype.writeHeaders = function () {
  var head = this._buildIdPage();
  var tags = this._buildTagsPage();
  var out = new Uint8Array(head.length + tags.length);
  out.set(head, 0);
  out.set(tags, head.length);
  return out;
};

/**
 * Wrap a single Opus packet into one OGG data page.
 *
 * @param {Buffer} opusFrame       raw Opus packet (as from RTP payload)
 * @param {number} [samplesInFrame] number of 48 kHz samples represented
 *                                   by this frame. If omitted, derived
 *                                   from the Opus TOC byte (RFC 6716
 *                                   §3.1) — handles all configs (10/20/
 *                                   40/60 ms, plus 2.5/5 ms for CELT)
 *                                   correctly. Falls back to 960 (20 ms
 *                                   at 48 kHz, WebRTC default) only if
 *                                   the packet is truncated/empty.
 * @returns {Buffer}  a complete OGG page
 */
OggWriter.prototype.writePacket = function (opusFrame, samplesInFrame) {
  // Resolve sample count. Caller-supplied wins; otherwise parse the
  // TOC byte. The previous default-to-960 silently wrote wrong granule
  // for any non-20 ms packet — same root cause as MP-10/MP-24.
  var n;
  if (typeof samplesInFrame === 'number' && samplesInFrame > 0) {
    n = samplesInFrame;
  } else {
    var durUs = getOpusPacketDurationUs(opusFrame);
    n = Math.round(durUs * OPUS_SAMPLE_RATE / 1000000);
  }
  this._granule += n;
  return this._buildPage(opusFrame, 0x00, this._granule);
};

/**
 * Build an EOS (end-of-stream) page. Send this after the final packet
 * to cleanly terminate the bitstream. Optional — most demuxers handle
 * truncated streams gracefully.
 */
OggWriter.prototype.writeEos = function () {
  return this._buildPage(new Uint8Array(0), FLAG_EOS, this._granule);
};

/**
 * Reset internal state. Use if the upstream source restarts (new RTP
 * session, seek, etc.). Serial number is preserved.
 */
OggWriter.prototype.reset = function () {
  this._sequence = 0;
  this._granule  = 0;
};


// ── Internal: header packet builders ──────────────────────────────

/**
 * OpusHead page — RFC 7845 §5.1. This is the "identification header"
 * and is mandatory. Channel mapping family 0 (mono/stereo Vorbis-style
 * order) is the common case for WebRTC; the channel mapping table
 * MUST be omitted for family 0. Total body size: 19 bytes.
 */
OggWriter.prototype._buildIdPage = function () {
  var body = new Uint8Array(19);
  body.set(fromAscii('OpusHead'), 0);    // 0..7
  body[8] = 1;                 // version
  body[9] = this._channels;    // channel count
  writeU16LE(body, 10, this._preSkip); // pre-skip (samples @ 48 kHz)
  writeU32LE(body, 12, this._inputRate);  // original input sample rate
  writeU16LE(body, 16, 0);              // output gain (Q8 dB, 0 = flat)
  body[18] = 0;                // channel mapping family = 0
  return this._buildPage(body, FLAG_BOS, 0);
};

/**
 * OpusTags page — RFC 7845 §5.2. The "comment header". Has a Vorbis-
 * comment-like structure with a vendor string and a list of key=value
 * user comments (empty list is fine).
 */
OggWriter.prototype._buildTagsPage = function () {
  var vendor = new TextEncoder().encode(this._vendor);
  var body = new Uint8Array(8 + 4 + vendor.length + 4);
  body.set(fromAscii('OpusTags'), 0);
  writeU32LE(body, 8, vendor.length);
  body.set(vendor, 12);
  writeU32LE(body, 12 + vendor.length, 0);   // user comment list length
  return this._buildPage(body, 0x00, 0);
};


// ── Internal: page framing ────────────────────────────────────────

/**
 * Build a complete OGG page from a packet body.
 *
 * Segment-table rules (RFC 3533 §6):
 *   - Divide the packet into 255-byte segments, one entry each.
 *   - The final entry is the length of the last partial segment
 *     (0..254). If the packet length is an exact multiple of 255,
 *     a trailing zero-length segment MUST be appended to signal
 *     "end of packet, no continuation into the next page".
 *   - For an empty packet (e.g. EOS marker page), still emit a
 *     single zero-length segment.
 *   - Maximum 255 segments per page → max ~65 KB per page.
 *
 * CRC rule: compute CRC-32 over the entire page with the CRC field
 * itself set to zero, then patch the computed value in.
 */
OggWriter.prototype._buildPage = function (body, flags, granule) {
  // Build segment lacing table
  var segments;
  if (body.length === 0) {
    segments = [0];
  } else {
    segments = [];
    var remaining = body.length;
    while (remaining >= 255) {
      segments.push(255);
      remaining -= 255;
    }
    segments.push(remaining);   // 0..254 — "ends the packet"
  }

  if (segments.length > 255) {
    throw new Error('OggWriter: packet size ' + body.length +
                    ' requires more than 255 segments; split across pages');
  }

  var headerLen = 27 + segments.length;
  var page = new Uint8Array(headerLen + body.length);

  // Fixed-header portion
  page.set(fromAscii('OggS'), 0);                   // 0..3  sync
  page[4] = 0;                            // 4     version
  page[5] = flags;                        // 5     type flags
  // 6..13 granule position (64-bit LE). Split high/low to avoid
  // BigInt — Opus streams at 48 kHz will only exceed 32 bits after
  // ~24 hours of continuous audio, so this matters for long sessions.
  var granLo = (granule >>> 0);
  var granHi = Math.floor(granule / 0x100000000) >>> 0;
  writeU32LE(page, 6, granLo);
  writeU32LE(page, 10, granHi);
  writeU32LE(page, 14, this._serial);             // 14..17 bitstream serial
  writeU32LE(page, 18, this._sequence);           // 18..21 page sequence
  writeU32LE(page, 22, 0);                        // 22..25 CRC placeholder
  page[26] = segments.length;             // 26     num segments

  // Segment table
  for (var i = 0; i < segments.length; i++) {
    page[27 + i] = segments[i];
  }

  // Body
  if (body.length) page.set(body, headerLen);

  // Compute CRC over the *entire* page with placeholder zero in place,
  // then patch it in.
  var crc = _crc32(page);
  writeU32LE(page, 22, crc);

  this._sequence++;
  return page;
};


export default OggWriter;
