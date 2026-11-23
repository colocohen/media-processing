/**
 * reader_ogg — OGG container reader for Opus audio.
 *
 * Parses OGG pages, extracts Opus packets with timing.
 */

import EventEmitter from './core/events.js';
import { readU32LE } from './core/bytes.js';
import ByteQueue from './core/byte_queue.js';
import { getOpusPacketDurationUs } from './utils/opus_utils.js';

function OggReader(opts) {
  if (!opts) opts = {};
  this._ee = new EventEmitter();
  this._q = new ByteQueue();
  this._sampleRate = opts.sampleRate || 48000;
  this._granulePos = 0;
  this._headersParsed = 0;
  this._ptsUs = 0;
  // Segments of a packet that continued past the end of the previous
  // page. Ogg signals continuation with a final 255-byte segment; the
  // remainder arrives in the next page and must be joined to this.
  this._pendingSegments = [];
}

OggReader.prototype.on = function (ev, fn) { this._ee.on(ev, fn); };
OggReader.prototype.off = function (ev, fn) { this._ee.off(ev, fn); };

OggReader.prototype.feed = function (chunk) {
  this._q.push(chunk);

  while (this._q.length >= 27) {
    // OGG page sync: 'OggS'
    if (this._q.byteAt(0) !== 0x4F || this._q.byteAt(1) !== 0x67 ||
        this._q.byteAt(2) !== 0x67 || this._q.byteAt(3) !== 0x53) {
      this._q.discard(1);
      continue;
    }

    var numSegments = this._q.byteAt(26);
    var headerLen = 27 + numSegments;
    if (this._q.length < headerLen) break;

    var header = this._q.peek(headerLen);

    // Calculate page body size from segment table
    var bodySize = 0;
    for (var i = 0; i < numSegments; i++) {
      bodySize += header[27 + i];
    }

    var totalPageSize = headerLen + bodySize;
    if (this._q.length < totalPageSize) break;

    // Read full page
    var page = this._q.read(totalPageSize);

    // Granule position (8 bytes, little-endian) at offset 6
    var granLo = readU32LE(page, 6);
    var granHi = readU32LE(page, 10);
    var granule = granHi * 0x100000000 + granLo;

    var headerType = page[5];
    var body = page.subarray(headerLen);

    // Extract packets from segments.
    //
    // packetBuf carries over from the previous page. Ogg splits a packet
    // into 255-byte segments and terminates it with a segment of 0..254;
    // a page whose LAST segment is 255 means the packet continues into
    // the next page (RFC 3533 §6). packetBuf used to be re-initialised
    // per page, so every such continued packet was silently discarded
    // along with everything already collected for it. Opus packets at
    // 20 ms are well under 255 bytes so this never showed up in the
    // WebRTC path, but any larger frame — higher bitrate, longer frame
    // duration, or a non-Opus stream through the same reader — lost
    // audio without a word.
    var packets = [];
    var packetBuf = this._pendingSegments;
    var segOff = 0;
    for (var s = 0; s < numSegments; s++) {
      var segSize = header[27 + s];
      if (segOff + segSize <= body.length) {
        packetBuf.push(body.subarray(segOff, segOff + segSize));
      }
      segOff += segSize;
      // Segment < 255 terminates the packet; 255 means "continues".
      if (segSize < 255) {
        if (packetBuf.length) {
          // Fast path: single segment = no concat needed
          var pkt;
          if (packetBuf.length === 1) {
            pkt = packetBuf[0].slice();
          } else {
            var total = 0;
            for (var t = 0; t < packetBuf.length; t++) total += packetBuf[t].length;
            pkt = new Uint8Array(total);
            var pOff = 0;
            for (var t2 = 0; t2 < packetBuf.length; t2++) {
              pkt.set(packetBuf[t2], pOff);
              pOff += packetBuf[t2].length;
            }
          }
          packets.push(pkt);
          packetBuf = [];
        }
      }
    }
    // Whatever is left belongs to a packet continuing into the next page.
    this._pendingSegments = packetBuf;

    // The first two PACKETS are the Opus headers (RFC 7845 §3): OpusHead
    // (§5.1, with the real libopus pre-skip — kept so the encoder can
    // surface it as decoderConfig.description, like the browser's
    // AudioEncoder) and OpusTags (§5.2). They were taken to be the first
    // two PAGES, but OpusTags may span pages (§3: "the comment header
    // packet ... MAY span multiple pages") — any tag over ~64 KB, e.g. a
    // cover image, does. Its continuation page then came out as an
    // audio packet (a 35052-byte 'Opus frame') and every timestamp after
    // it was off by one packet.
    while (packets.length && this._headersParsed < 2 && _isOpusHeader(packets[0])) {
      if (this._headersParsed === 0) this._opusHead = packets[0];
      this._headersParsed++;
      packets.shift();
    }
    if (packets.length) this._headersParsed = 2;   // audio from here (headers or not)

    // Emit audio events for each packet.
    //
    // Per-packet duration comes from the Opus TOC byte (RFC 6716 §3.1)
    // via getOpusPacketDurationUs — NOT a hardcoded 960 samples. The
    // previous hardcode was correct for 20ms@48kHz only; it produced
    // 2x-3x drift for any other Opus configuration (10/40/60ms frames,
    // or non-48kHz sample rates) and is the bug that ROADMAP MP-10 was
    // supposed to address (in a different file — actual bug was here).
    //
    // We could alternatively use the OGG granule_position (parsed
    // above) which is sample-accurate per RFC 7845 §4. We don't, for
    // two reasons: (1) granule needs special handling for pre-skip and
    // partial final packet, and (2) parsing the TOC keeps reader_ogg
    // useful as a reference for non-OGG callers (RTP payload parsing,
    // raw-stream debugging) without depending on container framing.
    for (var p = 0; p < packets.length; p++) {
      var durUs = getOpusPacketDurationUs(packets[p]);
      // End trimming (RFC 7845 §4.5): the end-of-stream page's granule
      // position (48 kHz, from the stream's start) says where the audio
      // ends, which may be inside its last packet. The last packet went out
      // whole (20000 µs where FFmpeg says 6500).
      if ((headerType & 0x04) && p === packets.length - 1 && granule > 0) {
        var endUs = Math.round(granule * 1000000 / 48000) - this._ptsUs;
        if (endUs > 0 && endUs < durUs) durUs = endUs;
      }
      this._ee.emit('audio', {
        payload: packets[p],
        ptsUs: this._ptsUs,
        durationUs: durUs,
      });
      this._ptsUs += durUs;
    }
  }
};

// 'OpusHead' / 'OpusTags': an Opus header packet, not audio.
function _isOpusHeader(pkt) {
  if (pkt.length < 8) return false;
  var m = String.fromCharCode(pkt[0], pkt[1], pkt[2], pkt[3], pkt[4], pkt[5], pkt[6], pkt[7]);
  return m === 'OpusHead' || m === 'OpusTags';
}

OggReader.prototype.flush = function () {
  this._q.reset();
  this._pendingSegments = [];
};

export default OggReader;
