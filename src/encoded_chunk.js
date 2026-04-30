/**
 * EncodedVideoChunk / EncodedAudioChunk — Encoded media data classes.
 * Mirrors the browser WebCodecs API.
 *
 * Spec: https://www.w3.org/TR/webcodecs/
 *   - EncodedVideoChunk:  §5.2-5.5
 *   - EncodedAudioChunk:  §4.2-4.5
 *
 * @param {object} init
 * @param {string} init.type       — 'key' or 'delta'
 * @param {number} init.timestamp  — PTS in microseconds (REQUIRED per spec)
 * @param {number} [init.duration] — Duration in microseconds
 * @param {BufferSource} init.data — Encoded payload (Buffer / TypedArray /
 *                                   ArrayBuffer / DataView)
 * @param {object} [init.metadata] — Codec-specific metadata (Anthropic-
 *                                   specific extension; not in W3C spec)
 */

import { isBufferSource, toBuffer, requireBufferSource } from './buffer_source.js';

function _initChunk(name, self, init) {
  if (!init) throw new TypeError(name + ': init required');
  if (init.type !== 'key' && init.type !== 'delta') {
    throw new TypeError(name + ": type must be 'key' or 'delta'");
  }
  // W3C: timestamp is required, must be a number. The previous code
  // accepted undefined (defaulted to 0), which silently swallowed bugs
  // when callers forgot to pass it. We now require an explicit number,
  // including the value 0 (start of stream).
  if (typeof init.timestamp !== 'number' || !Number.isFinite(init.timestamp)) {
    throw new TypeError(name + ': timestamp (microseconds) is required and must be a finite number');
  }

  // Compute final values before defining read-only properties.
  var duration = (typeof init.duration === 'number' && Number.isFinite(init.duration))
    ? init.duration
    : 0;

  // Normalize data to a Buffer view. data may be null/undefined for
  // chunks with no payload (rare); otherwise it must be BufferSource.
  var data;
  if (init.data == null) {
    data = null;
  } else {
    data = requireBufferSource(init.data, name + ': data');
  }
  var byteLength = data ? data.length : 0;

  // ── Read-only attributes (MP-35) ──
  //
  // Per W3C WebCodecs IDL (§5.2 / §4.2), type, timestamp, duration,
  // and byteLength are `readonly attribute`s. Browser implementations
  // expose them as accessor properties with no setter; assigning to
  // them is silently ignored in sloppy mode and throws TypeError in
  // strict mode (which ESM is, by default).
  //
  // Previously these were plain assignments (`self.type = init.type`),
  // which made the chunk fully mutable — caller code could rewrite
  // `chunk.timestamp = 0` after construction and silently corrupt the
  // pipeline's PTS bookkeeping. Switching to defineProperty with
  // writable:false matches browser behavior and surfaces such bugs at
  // the assignment site rather than further downstream.
  //
  // `data` is not a W3C attribute (the spec exposes bytes only via
  // copyTo()), but we expose it as a convenience for internal code
  // paths that already have a Buffer. Made read-only for the same
  // immutability reason — once a chunk is constructed, its bytes
  // are fixed.
  //
  // `metadata` is our own non-spec extension; left writable so callers
  // can attach late-bound metadata (e.g. encoder annotations from a
  // later analysis pass) without having to construct a new chunk.
  var ro = function (key, value) {
    Object.defineProperty(self, key, {
      value: value,
      writable: false,
      enumerable: true,
      configurable: false,
    });
  };
  ro('type',        init.type);
  ro('timestamp',   init.timestamp);
  ro('duration',    duration);
  ro('data',        data);
  ro('byteLength',  byteLength);

  self.metadata = init.metadata || null;
}

/**
 * copyTo(destination) per W3C WebCodecs:
 *   - destination must be a BufferSource (ArrayBuffer / TypedArray /
 *     DataView). The previous implementation only accepted Buffer.
 *   - If destination's byte length is less than this chunk's byte
 *     length, throw TypeError.
 *   - On success, returns undefined and writes the chunk's bytes
 *     starting at destination[0].
 */
function _copyTo(self, destination) {
  if (!self.data) return;

  var dst = requireBufferSource(destination, 'copyTo: destination');

  // Spec: throw if destination is too small.
  if (dst.length < self.data.length) {
    throw new TypeError(
      'copyTo: destination byte length (' + dst.length +
      ') is less than the chunk byte length (' + self.data.length + ')'
    );
  }

  self.data.copy(dst, 0, 0, self.data.length);
}

// ── EncodedVideoChunk ──

function EncodedVideoChunk(init) { _initChunk('EncodedVideoChunk', this, init); }
EncodedVideoChunk.prototype.copyTo = function (destination) { _copyTo(this, destination); };

// ── EncodedAudioChunk ──

function EncodedAudioChunk(init) { _initChunk('EncodedAudioChunk', this, init); }
EncodedAudioChunk.prototype.copyTo = function (destination) { _copyTo(this, destination); };

export { EncodedVideoChunk, EncodedAudioChunk };
