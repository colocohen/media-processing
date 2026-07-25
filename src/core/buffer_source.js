/**
 * buffer_source — Shared helpers for W3C BufferSource handling.
 *
 * The W3C IDL "BufferSource" union covers ArrayBuffer + ArrayBufferView
 * (which itself includes all TypedArrays and DataView). WebCodecs data
 * classes (EncodedVideoChunk, EncodedAudioChunk, VideoFrame, AudioData)
 * all accept BufferSource for `data` params and `copyTo` destinations.
 *
 * Isomorphic: coerces to a **Uint8Array view** (not a Node Buffer). A
 * Node Buffer is a Uint8Array subclass, so a Buffer passed in is a
 * valid ArrayBufferView and is handled by the generic view branch.
 *
 * Performance: toUint8Array() returns a VIEW (zero-copy) over the same
 * memory — `new Uint8Array(buffer, byteOffset, byteLength)` aliases the
 * underlying ArrayBuffer rather than allocating. That's the W3C spec
 * intent: copyTo writes into caller-provided memory.
 */

/**
 * @returns {boolean} true if x is any BufferSource (ArrayBuffer /
 * TypedArray / DataView / Node Buffer).
 */
export function isBufferSource(x) {
  if (x == null) return false;
  if (x instanceof ArrayBuffer) return true;
  // ArrayBuffer.isView covers every TypedArray, DataView, and Node Buffer.
  if (ArrayBuffer.isView(x)) return true;
  return false;
}

/**
 * Coerce any BufferSource to a Uint8Array view over the SAME memory
 * region (zero copy). A plain Uint8Array (or Node Buffer) passes
 * through unchanged; an ArrayBuffer is wrapped; other views
 * (e.g. Int16Array, DataView) preserve their byteOffset/byteLength.
 *
 * @param {ArrayBuffer|ArrayBufferView} x
 * @returns {Uint8Array}
 * @throws TypeError if x is not a BufferSource
 */
export function toUint8Array(x) {
  if (x instanceof Uint8Array) return x;               // includes Node Buffer
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) {
    return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  }
  throw new TypeError(
    'Expected BufferSource (ArrayBuffer, TypedArray, or DataView)'
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
      ' must be a BufferSource (ArrayBuffer, TypedArray, or DataView)'
    );
  }
  return toUint8Array(x);
}
