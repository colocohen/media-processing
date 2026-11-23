/**
 * reader_adts — AAC/ADTS stream reader.
 * Splits by ADTS sync word (0xFFF), computes cumulative PTS from the
 * sample rate signaled in each frame's ADTS header (was: assumed
 * opts.sampleRate, which silently produced wrong PTS when the stream
 * rate differed from the configured rate — MP-32).
 */

import EventEmitter from './core/events.js';
import ByteQueue from './core/byte_queue.js';
import { parseAdtsHeader } from './utils/aac_utils.js';

function ADTSReader(opts) {
  if (!opts) opts = {};
  this._ee = new EventEmitter();
  this._q = new ByteQueue();
  this._index = 0;
  // Fallback sample rate, used only if a frame's header is malformed.
  // Actual per-frame sample rate is read from the ADTS header.
  this._fallbackSampleRate = opts.sampleRate || 48000;
  this._nextSamples = 0;   // samples emitted so far (timestamps derive from it)
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

    var info = parseAdtsHeader(hdr);
    if (!info || !info.frameLength) {
      // Malformed header — skip a byte and try again
      this._q.discard(1);
      continue;
    }

    if (this._q.length < info.frameLength) return;

    var frame = this._q.read(info.frameLength);

    // Use the sample rate the encoder actually wrote into the header.
    // For HE-AAC streams this is the LOWER (core) rate — consistent
    // with the 1024-samples-per-frame frame size, so duration math
    // gives the right wall-clock value regardless of LC vs HE-AAC.
    var sampleRate = info.sampleRate || this._fallbackSampleRate;
    // Timestamps from the SAMPLE count, not a sum of per-frame durations.
    // Each frame's duration was floored to whole µs and the floors were
    // added up (1024 samples @ 48 kHz = 21333.33 → 21333): 21333, 42666,
    // 63999 ... — 56 ms behind after an hour. The duration of each frame
    // is the difference of its rounded endpoints, so they sum exactly.
    var ptsUs = Math.round(this._nextSamples * 1000000 / sampleRate);
    this._nextSamples += info.samplesPerFrame;
    var durationUs = Math.round(this._nextSamples * 1000000 / sampleRate) - ptsUs;

    this._ee.emit('audio', {
      payload: frame,
      ptsUs: ptsUs,
      durationUs: durationUs,
      index: this._index++,
      // Surface the actual stream parameters to consumers — webrtc-server
      // can then signal correct caps in SDP without trusting opts.
      sampleRate: sampleRate,
      channels: info.channels,
      profile: info.profile,
    });
  }
};

ADTSReader.prototype.flush = function () { this._q.reset(); };

export default ADTSReader;
