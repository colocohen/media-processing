/**
 * reader_ogg — OGG container reader for Opus audio.
 *
 * Parses OGG pages, extracts Opus packets with timing.
 */

import { EventEmitter } from 'node:events';
import ByteQueue from './byte_queue.js';

function OGGReader(opts) {
  if (!opts) opts = {};
  this._ee = new EventEmitter();
  this._q = new ByteQueue();
  this._sampleRate = opts.sampleRate || 48000;
  this._granulePos = 0;
  this._headersParsed = 0;
  this._ptsUs = 0;
}

OGGReader.prototype.on = function (ev, fn) { this._ee.on(ev, fn); };
OGGReader.prototype.off = function (ev, fn) { this._ee.off(ev, fn); };

OGGReader.prototype.feed = function (chunk) {
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
    var granLo = page.readUInt32LE(6);
    var granHi = page.readInt32LE(10);
    var granule = granHi * 0x100000000 + granLo;

    var body = page.subarray(headerLen);

    // First two pages are Opus headers — skip
    if (this._headersParsed < 2) {
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
            pkt = Buffer.from(packetBuf[0]);
          } else {
            var total = 0;
            for (var t = 0; t < packetBuf.length; t++) total += packetBuf[t].length;
            pkt = Buffer.allocUnsafe(total);
            var pOff = 0;
            for (var t2 = 0; t2 < packetBuf.length; t2++) {
              packetBuf[t2].copy(pkt, pOff);
              pOff += packetBuf[t2].length;
            }
          }
          packets.push(pkt);
          packetBuf = [];
        }
      }
    }

    // Emit audio events for each packet
    for (var p = 0; p < packets.length; p++) {
      // Opus frame duration: 20ms default (960 samples at 48kHz)
      var durSamples = 960;
      var durUs = Math.round(durSamples * 1e6 / this._sampleRate);

      this._ee.emit('audio', {
        payload: packets[p],
        ptsUs: this._ptsUs,
        durationUs: durUs,
      });
      this._ptsUs += durUs;
    }
  }
};

OGGReader.prototype.flush = function () {
  this._q.reset();
};

export default OGGReader;
