/**
 * buffer_source.js — Shared helpers for W3C BufferSource handling.
 *
 * The W3C IDL "BufferSource" union covers ArrayBuffer + ArrayBufferView
 * (which itself includes all TypedArrays and DataView). WebCodecs APIs
 * (EncodedVideoChunk, EncodedAudioChunk, VideoFrame, AudioData) all
 * accept BufferSource for `data` parameters and `copyTo` destinations.
 *
 * This module centralizes the type-check + Buffer-coercion logic that
 * was previously duplicated across audio_data.js, video_frame.js, and
 * encoded_chunk.js. A single import keeps behavior consistent and
 * eliminates ~60 lines of near-identical code.
 *
 * Performance note: toBuffer() returns a VIEW (zero-copy) for the
 * non-Buffer cases — Node's Buffer.from(ArrayBuffer, offset, length)
 * shares the underlying memory rather than allocating a new copy.
 * For mutable BufferSources passed in by callers, this means writes
 * through our Buffer alias DO propagate back. That's the W3C spec
 * intent: copyTo writes into caller-provided memory.
 */

/**
 * @returns {boolean} true if x is any BufferSource (Buffer / ArrayBuffer
 * / TypedArray / DataView).
 */
export function isBufferSource(x) {
  if (x == null) return false;
  if (Buffer.isBuffer(x)) return true;
  if (x instanceof ArrayBuffer) return true;
  if (ArrayBuffer.isView(x)) return true;
  return false;
}

/**
 * Coerce any BufferSource to a Node Buffer view of the same memory
 * region. Buffer pass-through is zero-cost; ArrayBuffer wraps; views
 * (TypedArray / DataView) preserve their byteOffset and byteLength.
 *
 * @param {Buffer|ArrayBuffer|ArrayBufferView} x
 * @returns {Buffer}
 * @throws TypeError if x is not a BufferSource
 */
export function toBuffer(x) {
  if (Buffer.isBuffer(x)) return x;
  if (x instanceof ArrayBuffer) return Buffer.from(x);
  if (ArrayBuffer.isView(x)) {
    return Buffer.from(x.buffer, x.byteOffset, x.byteLength);
  }
  throw new TypeError(
    'Expected BufferSource (Buffer, ArrayBuffer, TypedArray, or DataView)'
  );
}

/**
 * Coerce-or-throw with a custom error prefix. Useful at API boundaries
 * where the error message should name the parameter.
 *
 * Example:
 *   var buf = requireBufferSource(init.data, 'AudioData: data');
 *   // → throws TypeError 'AudioData: data must be a BufferSource ...'
 */
export function requireBufferSource(x, errorPrefix) {
  if (!isBufferSource(x)) {
    throw new TypeError(
      (errorPrefix || 'Argument') +
      ' must be a BufferSource (Buffer, ArrayBuffer, TypedArray, or DataView)'
    );
  }
  return toBuffer(x);
}
