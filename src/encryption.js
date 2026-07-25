/**
 * encryption — Web Crypto wrapper for HLS AES-128-CBC segment encryption.
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
 * Web Crypto's subtle.encrypt uses PKCS#7 padding by default for
 * AES-CBC, which matches the HLS spec exactly.
 *
 * API style: callbacks. Web Crypto's subtle.* methods natively return
 * Promises — we wrap them once at the boundary so the rest of the
 * library exposes Node-style (err, result) callbacks throughout.
 *
 * Browser support: SubtleCrypto.encrypt is universal in modern
 * browsers and Node.js 18+. We only need 'AES-CBC' which is in the
 * baseline algorithm set everywhere.
 */

import { isValidIvHex } from './utils/playlist_utils.js';

/**
 * Build the IV from a Media Sequence Number per RFC 8216 §5.2:
 * "If the EXT-X-KEY tag does not have an IV attribute, implementations
 *  MUST use the Media Sequence Number as the IV when encrypting or
 *  decrypting that Media Segment."
 *
 * The IV is a 128-bit big-endian integer. Sequence numbers fit in
 * 32 bits in practice (years of segments at typical durations), so
 * we put the sequence in the low 4 bytes and zero-pad the high 12.
 *
 * @param {number} sequenceNumber  Non-negative integer.
 * @returns {Uint8Array}            Exactly 16 bytes.
 */
export function ivFromSequence(sequenceNumber) {
  var iv = new Uint8Array(16);
  // High 12 bytes already zero. Low 4 bytes = sequence in big-endian.
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
 * Find the SubtleCrypto interface across browser / Node environments.
 * Browsers expose `crypto.subtle` on globalThis. Node 18+ exposes the
 * same shape on globalThis.crypto.
 */
function _getSubtle() {
  if (typeof globalThis !== 'undefined' &&
      globalThis.crypto && globalThis.crypto.subtle) {
    return globalThis.crypto.subtle;
  }
  throw new Error('encryption: Web Crypto API not available — ' +
                  'requires browser or Node.js 18+');
}

/**
 * Create an Encryptor bound to a single AES-128 key. The key is
 * imported once into the Web Crypto subsystem (where it's stored
 * non-extractable) and reused for every segment, which is the
 * standard HLS pattern.
 *
 * Web Crypto's importKey is natively Promise-based; we wrap it so the
 * public API uses Node-style (err, result) callbacks throughout.
 *
 * @param {object}    opts
 * @param {Uint8Array} opts.key    Raw 16-byte AES-128 key.
 * @param {Function}  callback     callback(err, encryptor)
 */
export function createEncryptor(opts, callback) {
  if (typeof callback !== 'function') {
    throw new TypeError('createEncryptor: callback function required');
  }
  if (!opts || !(opts.key instanceof Uint8Array) || opts.key.length !== 16) {
    // Synchronous validation errors throw rather than calling callback —
    // these are programming bugs, not runtime conditions. Matches Node
    // convention for argument-shape errors.
    throw new TypeError('createEncryptor: opts.key must be Uint8Array(16)');
  }

  var subtle;
  try {
    subtle = _getSubtle();
  } catch (e) {
    // Defer to next tick so the caller sees consistent async cadence.
    setTimeout(function () { callback(e); }, 0);
    return;
  }

  // 'raw' format is the literal 16 bytes. AES-CBC algorithm. Not
  // extractable — the key never leaves Web Crypto's secure context.
  // Only 'encrypt' usage; we never decrypt locally.
  subtle.importKey(
    'raw',
    opts.key,
    { name: 'AES-CBC' },
    false,
    ['encrypt']
  ).then(function (cryptoKey) {
    callback(null, new Encryptor(cryptoKey, subtle));
  }, function (err) {
    callback(err);
  });
}

/**
 * Encryptor — wraps a CryptoKey + the encrypt() routine. Returned via
 * the callback to createEncryptor. Reused for every segment; the key
 * material lives inside Web Crypto's secure context for the lifetime
 * of the instance.
 */
function Encryptor(cryptoKey, subtle) {
  this._key = cryptoKey;
  this._subtle = subtle;
}

/**
 * Encrypt a media segment with AES-128-CBC and PKCS#7 padding.
 *
 * Web Crypto returns an ArrayBuffer of length plaintext.length +
 * (16 - plaintext.length % 16). When plaintext is a multiple of 16,
 * an extra full block of padding is appended (PKCS#7 requirement —
 * the player needs to know how many padding bytes to strip).
 *
 * The IV must be exactly 16 bytes. For sequence-based IVs, callers
 * typically pass the result of ivFromSequence(mediaSequenceNumber).
 *
 * @param {Uint8Array} plaintext
 * @param {Uint8Array} iv         16 bytes
 * @param {Function}   callback   callback(err, ciphertext)
 */
Encryptor.prototype.encrypt = function (plaintext, iv, callback) {
  if (typeof callback !== 'function') {
    throw new TypeError('Encryptor.encrypt: callback function required');
  }
  if (!(plaintext instanceof Uint8Array)) {
    throw new TypeError('Encryptor.encrypt: plaintext must be Uint8Array');
  }
  if (!(iv instanceof Uint8Array) || iv.length !== 16) {
    throw new TypeError('Encryptor.encrypt: iv must be Uint8Array(16)');
  }

  this._subtle.encrypt(
    { name: 'AES-CBC', iv: iv },
    this._key,
    plaintext
  ).then(function (buffer) {
    // ArrayBuffer → Uint8Array view. No copy; the caller can use it
    // directly as a Uint8Array (set into a larger buffer, upload, etc.).
    callback(null, new Uint8Array(buffer));
  }, function (err) {
    callback(err);
  });
};
