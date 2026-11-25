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

import { getOpusPacketDurationUs, buildOpusHead, parseOpusHead } from './utils/opus_utils.js';
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
 * @param {Uint8Array} [opts.opusHead]       the encoder's OpusHead (WebCodecs
 *                                           decoderConfig.description). Written
 *                                           verbatim — it carries the channel
 *                                           mapping the packets were coded with,
 *                                           which a rebuilt header can only guess.
 *                                           channels / preSkip / inputSampleRate
 *                                           are then read from it.
 */
function OggWriter(opts) {
  if (!opts) opts = {};
  var head = opts.opusHead ? parseOpusHead(opts.opusHead) : null;
  this._opusHead   = head ? new Uint8Array(opts.opusHead) : null;
  this._channels   = head ? head.channels : (opts.channels || 2);
  this._serial     = (opts.serial != null)
                      ? (opts.serial >>> 0)
                      : ((Math.random() * 0xFFFFFFFF) >>> 0);
  this._preSkip    = head ? head.preSkip : ((opts.preSkip != null) ? opts.preSkip : 0);
  this._inputRate  = head ? (head.inputSampleRate || OPUS_SAMPLE_RATE) : (opts.inputSampleRate || OPUS_SAMPLE_RATE);
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
 * @param {boolean} [isLast]  mark this packet's page end-of-stream (the
 *                            preferred way to end a stream: no extra page)
 * @returns {Uint8Array}  one complete OGG page — or several, for a packet
 *                        larger than one page can hold (65025 bytes)
 */
OggWriter.prototype.writePacket = function (opusFrame, samplesInFrame, isLast) {
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
  return this._buildPage(opusFrame, isLast ? FLAG_EOS : 0x00, this._granule);
};

/**
 * Build an EOS (end-of-stream) page. Send this after the final packet
 * to cleanly terminate the bitstream. Optional — most demuxers handle
 * truncated streams gracefully. (Or pass isLast to the final
 * writePacket() and skip this page.)
 *
 * The page has NO segments (RFC 3533 allows page_segments = 0). It used
 * to carry one zero-length segment, i.e. a 0-byte packet — not a valid
 * Opus packet (RFC 6716 §3.1 requires at least the TOC byte), and
 * FFmpeg failed the file at that page: "Packet processing failed:
 * Invalid data found when processing input".
 */
OggWriter.prototype.writeEos = function () {
  return this._buildPage(null, FLAG_EOS, this._granule);
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
 * and is mandatory. Channel mapping family 0 (mono/stereo, 19 bytes,
 * no mapping table) is the common case for WebRTC.
 *
 * Family 0 is only defined for 1-2 channels: for more it used to be
 * written anyway, and FFmpeg refused the stream ("Channel mapping 0 is
 * only specified for up to 2 channels"). The encoder's own OpusHead is
 * used when given; otherwise buildOpusHead picks family 1 / 255.
 */
OggWriter.prototype._buildIdPage = function () {
  var body = this._opusHead || buildOpusHead({
    channels: this._channels,
    preSkip: this._preSkip,
    inputSampleRate: this._inputRate,
  });
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
 * Build the OGG page(s) carrying one packet.
 *
 * Segment-table rules (RFC 3533 §6):
 *   - Divide the packet into 255-byte segments, one entry each.
 *   - The final entry is the length of the last partial segment
 *     (0..254). If the packet length is an exact multiple of 255,
 *     a trailing zero-length segment MUST be appended to signal
 *     "end of packet, no continuation into the next page".
 *   - A page holds at most 255 segments. A longer packet continues
 *     on the next page (header flag 0x01 = continued packet); a page
 *     on which no packet ends carries granule position -1. It used to
 *     throw instead, so any packet over 65024 bytes could not be
 *     written at all.
 *   - body === null: a page with no segments (the EOS page).
 *
 * CRC rule: compute CRC-32 over the entire page with the CRC field
 * itself set to zero, then patch the computed value in.
 */
OggWriter.prototype._buildPage = function (body, flags, granule) {
  if (!body) return this._buildOnePage([], new Uint8Array(0), flags, granule);

  var segments = [];
  var remaining = body.length;
  while (remaining >= 255) {
    segments.push(255);
    remaining -= 255;
  }
  segments.push(remaining);   // 0..254 — "ends the packet"

  if (segments.length <= 255) return this._buildOnePage(segments, body, flags, granule);

  var pages = [];
  var off = 0;
  for (var s = 0; s < segments.length; s += 255) {
    var segs = segments.slice(s, s + 255);
    var bytes = 0;
    for (var k = 0; k < segs.length; k++) bytes += segs[k];
    var last = s + 255 >= segments.length;
    // BOS on the first page only, EOS on the last only (RFC 3533 §6: BOS
    // marks the first page of the bitstream). This was
    // `last ? flags : (flags & FLAG_BOS)`, which put BOS on every page of
    // a header packet that spans pages — continuation pages included.
    var f = (s > 0 ? FLAG_CONTINUATION : (flags & FLAG_BOS)) | (last ? (flags & ~FLAG_BOS) : 0);
    pages.push(this._buildOnePage(segs, body.subarray(off, off + bytes), f, last ? granule : -1));
    off += bytes;
  }
  return concat(pages);
};

OggWriter.prototype._buildOnePage = function (segments, body, flags, granule) {
  var headerLen = 27 + segments.length;
  var page = new Uint8Array(headerLen + body.length);

  // Fixed-header portion
  page.set(fromAscii('OggS'), 0);                   // 0..3  sync
  page[4] = 0;                            // 4     version
  page[5] = flags;                        // 5     type flags
  // 6..13 granule position (64-bit LE). Split high/low to avoid
  // BigInt — Opus streams at 48 kHz will only exceed 32 bits after
  // ~24 hours of continuous audio, so this matters for long sessions.
  // -1 (all ones) = no packet finishes on this page.
  var granLo = granule < 0 ? 0xFFFFFFFF : (granule >>> 0);
  var granHi = granule < 0 ? 0xFFFFFFFF : (Math.floor(granule / 0x100000000) >>> 0);
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
// Ogg's page CRC (RFC 3533 §6), also checked by reader_ogg.
export { _crc32 as oggCrc32 };
