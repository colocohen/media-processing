/**
 * reader_adts — AAC/ADTS stream reader.
 * Splits by ADTS sync word (0xFFF), computes cumulative PTS.
 */

import { EventEmitter } from 'node:events';
import ByteQueue from './byte_queue.js';

function ADTSReader(opts) {
  if (!opts) opts = {};
  this._ee = new EventEmitter();
  this._q = new ByteQueue();
  this._index = 0;
  this._sampleRate = opts.sampleRate || 48000;
  this._samplesPerFrame = 1024;  // AAC LC typical
  this._nextPtsUs = 0;
}

ADTSReader.prototype.on = function (ev, fn) { this._ee.on(ev, fn); };
ADTSReader.prototype.off = function (ev, fn) { this._ee.off(ev, fn); };

ADTSReader.prototype.feed = function (chunk) {
  this._q.push(chunk);
  while (true) {
    var hdr = this._q.peek(7);
    if (!hdr) return;
    // Sync word check: 0xFFF
    if (hdr[0] !== 0xFF || (hdr[1] & 0xF0) !== 0xF0) {
      this._q.discard(1);
      continue;
    }
    var protectionAbsent = hdr[1] & 0x01;
    var headerLen = protectionAbsent ? 7 : 9;
    var fullHdr = this._q.peek(headerLen);
    if (!fullHdr) return;
    var frameLen = ((fullHdr[3] & 0x03) << 11) | (fullHdr[4] << 3) | ((fullHdr[5] & 0xE0) >> 5);
    if (this._q.length < frameLen) return;

    var frame = this._q.read(frameLen);
    var durationUs = Math.floor(this._samplesPerFrame * 1000000 / this._sampleRate);
    var ptsUs = this._nextPtsUs;
    this._nextPtsUs += durationUs;

    this._ee.emit('audio', {
      payload: frame,
      ptsUs: ptsUs,
      durationUs: durationUs,
      index: this._index++,
    });
  }
};

ADTSReader.prototype.flush = function () { this._q.reset(); };

export default ADTSReader;
