/**
 * take_buffer — the WebCodecs "copy unless transferred" rule for a
 * BufferSource `data` + optional `transfer` list, in one place.
 *
 * W3C WebCodecs (EncodedVideoChunk / EncodedAudioChunk / ImageDecoder
 * constructors): the object keeps its OWN bytes. If data's ArrayBuffer
 * is listed in init.transfer it is taken over without a copy; otherwise
 * data is copied. Every ArrayBuffer in transfer is detached afterwards.
 * The transfer list must hold only ArrayBuffers (TypeError), none
 * detached and none twice (DataCloneError).
 */

import { requireBufferSource } from './buffer_source.js';
import { domException } from './dom_exception.js';

var _hasBuffer = typeof Buffer !== 'undefined';

/**
 * @param {string} name — error-message prefix, e.g. 'EncodedVideoChunk: data'
 * @param {BufferSource} source
 * @param {Iterable<ArrayBuffer>} [transfer]
 * @returns {Uint8Array} the object's own bytes (a Node Buffer when the
 *   source was a Node Buffer, since internal code uses Buffer methods)
 */
export function takeBufferSource(name, source, transfer) {
  var view = requireBufferSource(source, name);
  var asBuffer = _hasBuffer && Buffer.isBuffer(view);
  var list = [];
  if (transfer !== undefined && transfer !== null) {
    if (typeof transfer[Symbol.iterator] !== 'function') {
      throw new TypeError(name + ': transfer must be a sequence of ArrayBuffer');
    }
    list = Array.from(transfer);
    for (var i = 0; i < list.length; i++) {
      if (!(list[i] instanceof ArrayBuffer)) {
        throw new TypeError(name + ': transfer may only contain ArrayBuffer');
      }
      if (list[i].detached) throw domException(name + ': transfer contains a detached ArrayBuffer', 'DataCloneError');
      if (list.indexOf(list[i]) !== i) throw domException(name + ': transfer lists the same ArrayBuffer twice', 'DataCloneError');
    }
  }
  var out;
  var own = list.indexOf(view.buffer);
  if (own !== -1) {
    // Zero-copy: ArrayBuffer.prototype.transfer moves the memory into a
    // new ArrayBuffer and detaches the old one in one step. Offset and
    // length are read first — a view over a detached buffer reads 0/0.
    var off = view.byteOffset, len = view.byteLength;
    var moved = list[own].transfer();
    list.splice(own, 1);
    out = asBuffer ? Buffer.from(moved, off, len) : new Uint8Array(moved, off, len);
  } else {
    // allocUnsafeSlow: an unpooled Buffer, so out.buffer is this
    // object's own memory (a pooled slice would share it with others).
    out = asBuffer ? Buffer.allocUnsafeSlow(view.byteLength) : new Uint8Array(view.byteLength);
    out.set(view);
  }
  for (var j = 0; j < list.length; j++) list[j].transfer(0);   // detach the rest
  return out;
}
