/**
 * VideoColorSpace — W3C WebCodecs VideoColorSpace.
 * Describes the color space properties of a video frame.
 */

// W3C WebCodecs enums (VideoColorPrimaries / VideoTransferCharacteristics /
// VideoMatrixCoefficients). WebIDL rejects a value outside the enum with a
// TypeError; before, any string (typos included) was stored as is.
var PRIMARIES = ['bt709', 'bt470bg', 'smpte170m', 'bt2020', 'smpte432'];
var TRANSFERS = ['bt709', 'smpte170m', 'iec61966-2-1', 'linear', 'pq', 'hlg'];
var MATRICES  = ['rgb', 'bt709', 'bt470bg', 'smpte170m', 'bt2020-ncl'];

function _enumOrNull(value, allowed, name) {
  if (value === undefined || value === null) return null;
  if (allowed.indexOf(value) === -1) {
    throw new TypeError("VideoColorSpace: '" + value + "' is not a valid " + name);
  }
  return value;
}

function VideoColorSpace(init) {
  if (!init) init = {};
  this.primaries = _enumOrNull(init.primaries, PRIMARIES, 'VideoColorPrimaries');
  this.transfer = _enumOrNull(init.transfer, TRANSFERS, 'VideoTransferCharacteristics');
  this.matrix = _enumOrNull(init.matrix, MATRICES, 'VideoMatrixCoefficients');
  // true = full range, false = limited range, null = unknown. This was
  // `init.fullRange || null`, which turned an explicit false (limited
  // range — the usual case for video) into null, so toJSON() of a
  // limited-range BT.709 space said "unknown".
  this.fullRange = (init.fullRange === undefined || init.fullRange === null) ? null : !!init.fullRange;
}

VideoColorSpace.prototype.toJSON = function () {
  return {
    primaries: this.primaries,
    transfer: this.transfer,
    matrix: this.matrix,
    fullRange: this.fullRange,
  };
};

// CICP code points (ISO/IEC 23091-2 / ITU-T H.273) → the WebCodecs names.
// What an MP4 'colr' (nclx / nclc) and a Matroska Colour element carry.
var CICP_PRIMARIES = { 1: 'bt709', 5: 'bt470bg', 6: 'smpte170m', 9: 'bt2020', 12: 'smpte432' };
var CICP_TRANSFER  = { 1: 'bt709', 6: 'smpte170m', 8: 'linear', 13: 'iec61966-2-1', 16: 'pq', 18: 'hlg' };
var CICP_MATRIX    = { 0: 'rgb', 1: 'bt709', 5: 'bt470bg', 6: 'smpte170m', 9: 'bt2020-ncl' };

/**
 * A VideoColorSpaceInit from CICP code points; a code point with no
 * WebCodecs name (2 = unspecified, …) → null. fullRange: true / false /
 * null (not said).
 */
export function colorSpaceFromCicp(primaries, transfer, matrix, fullRange) {
  return {
    primaries: CICP_PRIMARIES[primaries] || null,
    transfer:  CICP_TRANSFER[transfer] || null,
    matrix:    CICP_MATRIX[matrix] || null,
    fullRange: fullRange == null ? null : !!fullRange,
  };
}

export default VideoColorSpace;
