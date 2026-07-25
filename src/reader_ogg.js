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

    var body = page.subarray(headerLen);

    // First two pages are Opus headers — skip for packet extraction.
    // Page 0's body IS the OpusHead identification header (RFC 7845
    // §5.1, contains the real libopus pre-skip); capture it so the
    // encoder can surface it as decoderConfig.description, matching the
    // browser WebCodecs AudioEncoder. Page 1 is the comment header.
    if (this._headersParsed < 2) {
      if (this._headersParsed === 0) this._opusHead = body.slice();
      this._headersParsed++;
      continue;
    }

    // Extract packets from segments
    var packets = [];
    var packetBuf = [];
    var segOff = 0;
    for (var s = 0; s < numSegments; s++) {
      var segSize = header[27 + s];
      if (segOff + segSize <= body.length) {
        packetBuf.push(body.subarray(segOff, segOff + segSize));
      }
      segOff += segSize;
      // Segment < 255 means end of packet
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
      this._ee.emit('audio', {
        payload: packets[p],
        ptsUs: this._ptsUs,
        durationUs: durUs,
      });
      this._ptsUs += durUs;
    }
  }
};

OggReader.prototype.flush = function () {
  this._q.reset();
};

export default OggReader;
