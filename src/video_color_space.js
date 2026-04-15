/**
 * VideoColorSpace — W3C WebCodecs VideoColorSpace.
 * Describes the color space properties of a video frame.
 */

function VideoColorSpace(init) {
  if (!init) init = {};
  this.primaries = init.primaries || null;       // 'bt709', 'bt470bg', 'smpte170m', 'bt2020', ...
  this.transfer = init.transfer || null;         // 'bt709', 'smpte170m', 'iec61966-2-1' (sRGB), ...
  this.matrix = init.matrix || null;             // 'rgb', 'bt709', 'bt470bg', 'smpte170m', 'bt2020-ncl', ...
  this.fullRange = init.fullRange || null;       // true = full range, false = limited range
}

VideoColorSpace.prototype.toJSON = function () {
  return {
    primaries: this.primaries,
    transfer: this.transfer,
    matrix: this.matrix,
    fullRange: this.fullRange,
  };
};

export default VideoColorSpace;
