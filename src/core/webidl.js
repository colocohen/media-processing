/**
 * webidl — the WebIDL conversions the WebCodecs IDL asks for, in one place.
 *
 * [EnforceRange] integer types (WebIDL §3.2.4 "ConvertToInt"): the value
 * is converted with ToNumber, NaN and ±Infinity are a TypeError, the
 * fraction is dropped (toward zero), and a value outside the type's range
 * is a TypeError. For the 64-bit types the range is the safe integers
 * (±(2^53 − 1); unsigned: 0..2^53 − 1).
 */

var RANGES = {
  'long long':          [-(Math.pow(2, 53) - 1), Math.pow(2, 53) - 1],
  'unsigned long long': [0, Math.pow(2, 53) - 1],
  'unsigned long':      [0, 4294967295],
};

/**
 * @param {*} value
 * @param {string} type — 'long long' | 'unsigned long long' | 'unsigned long'
 * @param {string} what — error-message prefix, e.g. 'EncodedVideoChunk: duration'
 * @returns {number}
 */
export function enforceRange(value, type, what) {
  var x = Number(value);
  if (!Number.isFinite(x)) {
    throw new TypeError(what + ' must be a finite number');
  }
  x = Math.trunc(x);
  if (x === 0) x = 0;                       // -0 → +0
  var r = RANGES[type];
  if (x < r[0] || x > r[1]) {
    throw new TypeError(what + " is outside the '" + type + "' value range");
  }
  return x;
}
