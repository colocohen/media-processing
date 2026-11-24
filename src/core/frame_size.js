/**
 * frame_size — plane geometry of a raw video frame, in ONE place.
 *
 * Chroma planes of a subsampled format cover ceil(w/2) x ceil(h/2)
 * samples (4:2:0; 4:2:2 halves the width only) — W3C WebCodecs' plane
 * layout and FFmpeg's rawvideo agree on that. Every size used to be
 * computed as w*h*bpp (1.5 for I420) and every chroma stride as w >> 1,
 * i.e. FLOORED, in three places (VideoFrame, VideoEncoder, VideoDecoder)
 * that only happened to agree with each other. For an odd dimension
 * that is wrong against everything else: a correctly sized 321x241 I420
 * buffer (116323 bytes) was rejected by the VideoFrame constructor, and
 * a decoder at 321x241 cut FFmpeg's 116323-byte frames every 116041
 * bytes, so from the second frame on each one was shifted.
 *
 * Plane spec: { offset, stride, pixBytes, subX, subY, rows } — pixBytes is
 * the bytes per sample position (2 for NV12's UV pair and for the 16-bit
 * P10 / P12 samples).
 */

// Per format, the planes as [subX, subY, sampleBytes]: the horizontal and
// vertical sub-sampling factors and the bytes per sample position (2 for
// NV12's interleaved UV pair, 4 for RGBA). The P10 / P12 formats store
// each sample as a 16-bit little-endian integer (W3C VideoPixelFormat).
// RGB24 and YUV420P are this library's non-W3C extensions.
var FORMAT_PLANES = {};
(function () {
  var families = { I420: [2, 2], I422: [2, 1], I444: [1, 1] };
  Object.keys(families).forEach(function (fam) {
    var sx = families[fam][0], sy = families[fam][1];
    [['', 1], ['P10', 2], ['P12', 2]].forEach(function (d) {
      var b = d[1];
      FORMAT_PLANES[fam + d[0]] = [[1, 1, b], [sx, sy, b], [sx, sy, b]];
      FORMAT_PLANES[fam + 'A' + d[0]] = [[1, 1, b], [sx, sy, b], [sx, sy, b], [1, 1, b]];
    });
  });
  FORMAT_PLANES.YUV420P = FORMAT_PLANES.I420;
  FORMAT_PLANES.NV12 = [[1, 1, 1], [2, 2, 2]];
  FORMAT_PLANES.RGBA = FORMAT_PLANES.RGBX = FORMAT_PLANES.BGRA = FORMAT_PLANES.BGRX = [[1, 1, 4]];
  FORMAT_PLANES.RGB24 = [[1, 1, 3]];
})();

/** The [subX, subY, sampleBytes] of each plane of `fmt`, or null. */
function formatPlanes(fmt) {
  return Object.prototype.hasOwnProperty.call(FORMAT_PLANES, fmt) ? FORMAT_PLANES[fmt] : null;
}

function planeSpecs(fmt, w, h) {
  var planes = formatPlanes(fmt);
  if (!planes) return null;
  var out = [], offset = 0;
  for (var i = 0; i < planes.length; i++) {
    var sx = planes[i][0], sy = planes[i][1], b = planes[i][2];
    var stride = Math.ceil(w / sx) * b, rows = Math.ceil(h / sy);
    out.push({ offset: offset, stride: stride, pixBytes: b, subX: sx, subY: sy, rows: rows });
    offset += stride * rows;
  }
  return out;
}

/** Bytes of a tightly packed w x h frame in `fmt`, or 0 for an unknown format. */
function frameByteSize(fmt, w, h) {
  var planes = planeSpecs(fmt, w, h);
  if (!planes) return 0;
  var last = planes[planes.length - 1];
  return last.offset + last.stride * last.rows;
}

/** W3C PlaneLayout[] ({offset, stride}) of a tightly packed frame. */
function planeLayout(fmt, w, h) {
  var planes = planeSpecs(fmt, w, h);
  if (!planes) return [{ offset: 0, stride: w }];
  return planes.map(function (p) { return { offset: p.offset, stride: p.stride }; });
}

export { planeSpecs, frameByteSize, planeLayout, formatPlanes };
