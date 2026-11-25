/**
 * encryption — what HLS AES-128 segment encryption asks of the encoder.
 *
 * Implements the encryption side of RFC 8216 §4.4.4.4 (EXT-X-KEY) for
 * METHOD=AES-128: each Media Segment is encrypted standalone with
 * AES-128 in CBC mode and PKCS#7 padding. The Initialization Vector
 * is either:
 *   - Explicitly provided by the encoder (constant for all segments)
 *   - Derived from the segment's Media Sequence Number when no IV
 *     attribute is present in EXT-X-KEY (the default)
 *
 * Init segments (fMP4 ftyp+moov) are NOT encrypted under this method —
 * only Media Segments. Players fetch the init clear, then decrypt
 * each media segment with its IV before parsing.
 *
 * The cipher itself is the caller's: a hook (encryptorFromHook, below),
 * so this library carries no cryptography.
 */

import { isValidIvHex } from './utils/playlist_utils.js';

/**
 * Build the IV from a Media Sequence Number per RFC 8216 §5.2:
 * "If the EXT-X-KEY tag does not have an IV attribute, implementations
 *  MUST use the Media Sequence Number as the IV when encrypting or
 *  decrypting that Media Segment."
 *
 * The IV is a 128-bit big-endian integer: the sequence number in the
 * low bytes, zeros above.
 *
 * @param {number} sequenceNumber  Non-negative integer.
 * @returns {Uint8Array}            Exactly 16 bytes.
 */
export function ivFromSequence(sequenceNumber) {
  // A Media Sequence Number is a decimal-integer, 0 to 2^64-1 (RFC 8216
  // §4.2, §4.3.3.2); a JS number holds it exactly up to 2^53-1. This
  // used to stop at 2^32-1 (32-bit shifts), refusing valid sequence
  // numbers such as a live stream's MSN derived from the wall clock in
  // milliseconds. A non-integer, a negative or a value past 2^53-1 is
  // still refused: it would round, and two segments encrypted under the
  // same key and IV leak their XOR (CBC).
  if (typeof sequenceNumber !== 'number' || !Number.isSafeInteger(sequenceNumber) ||
      sequenceNumber < 0) {
    throw new RangeError(
      'encryption.ivFromSequence: sequenceNumber must be an integer in ' +
      '[0, 2^53-1], got ' + sequenceNumber
    );
  }
  var iv = new Uint8Array(16);
  // High 9 bytes stay zero (the number is under 2^53). Low 7 bytes =
  // sequence in big-endian: the low 32 bits, then the bits above them.
  var hi = Math.floor(sequenceNumber / 4294967296);
  iv[9]  = (hi >>> 16) & 0xFF;
  iv[10] = (hi >>> 8) & 0xFF;
  iv[11] = hi & 0xFF;
  iv[12] = (sequenceNumber >>> 24) & 0xFF;
  iv[13] = (sequenceNumber >>> 16) & 0xFF;
  iv[14] = (sequenceNumber >>> 8) & 0xFF;
  iv[15] = sequenceNumber & 0xFF;
  return iv;
}

/**
 * Convert a 0x-prefixed hex string to a 16-byte Uint8Array IV. Used
 * when the encoder is configured with an explicit IV that the player
 * will read from EXT-X-KEY's IV attribute.
 */
export function ivFromHex(hex) {
  if (!isValidIvHex(hex)) {
    throw new TypeError('encryption.ivFromHex: must be 0x followed by 32 hex digits');
  }
  var iv = new Uint8Array(16);
  for (var i = 0; i < 16; i++) {
    iv[i] = parseInt(hex.substr(2 + i * 2, 2), 16);
  }
  return iv;
}

/**
 * Format an IV (Uint8Array of 16 bytes) as a 0x-prefixed hex string
 * suitable for the IV attribute on EXT-X-KEY.
 */
export function ivToHex(iv) {
  if (!(iv instanceof Uint8Array) || iv.length !== 16) {
    throw new TypeError('encryption.ivToHex: requires Uint8Array(16)');
  }
  var s = '0x';
  for (var i = 0; i < 16; i++) {
    var h = iv[i].toString(16);
    s += (h.length === 1 ? '0' : '') + h;
  }
  return s.toUpperCase().replace('0X', '0x');
}

/**
 * The segment encryptor over the caller's cipher.
 *
 * The cipher is not part of this library: the caller passes
 * `encrypt(plaintext, iv, callback(err, ciphertext))`, AES-128-CBC with
 * PKCS#7 padding of the whole segment under its key, with any crypto it
 * likes (cryptographic-primitives, WebCrypto, node:crypto, a KMS). What
 * the spec asks of the encoder stays here: which bytes are encrypted
 * (each Media Segment whole, never the init), with which IV, in which
 * order, and the EXT-X-KEY tag.
 *
 * The wrapper holds the hook to what the segment builder relies on:
 *   - the result comes on a later turn, never inside the call (a hook
 *     that calls back at once is deferred);
 *   - a hook that throws fails that segment (a gap), as an error
 *     through the callback would;
 *   - one result per segment (a second callback is ignored);
 *   - the ciphertext is a Uint8Array of the length AES-CBC with PKCS#7
 *     gives (16 * (floor(n / 16) + 1) bytes); anything else fails the
 *     segment rather than publishing bytes no player can decrypt.
 * The hook gets copies of the plaintext and the IV.
 *
 * @param {Function} hook  encrypt(plaintext, iv, callback)
 * @returns {{ encrypt: Function }}
 */
export function encryptorFromHook(hook) {
  if (typeof hook !== 'function') {
    throw new TypeError('encryptorFromHook: hook must be a function (plaintext, iv, callback)');
  }
  return {
    encrypt: function (plaintext, iv, callback) {
      var want = 16 * (Math.floor(plaintext.length / 16) + 1);
      var inCall = true, done = false;
      function finish(err, ct) {
        if (done) return;
        done = true;
        if (!err && !(ct instanceof Uint8Array && ct.length === want)) {
          err = new Error('encryption: the encrypt hook gave ' +
            (ct instanceof Uint8Array ? ct.length + ' bytes' : 'no Uint8Array') + ' for a ' +
            plaintext.length + '-byte segment; AES-128-CBC with PKCS#7 padding gives ' + want);
          ct = undefined;
        }
        if (inCall) setTimeout(function () { callback(err || null, ct); }, 0);
        else callback(err || null, ct);
      }
      try {
        hook(plaintext.slice(), iv.slice(), function (err, ct) { finish(err, ct); });
      } catch (e) {
        finish(e instanceof Error ? e : new Error(String(e)));
      }
      inCall = false;
    },
  };
}
