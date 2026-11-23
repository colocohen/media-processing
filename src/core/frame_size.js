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
 * Plane spec: { offset, stride, pixBytes, subX, subY, rows }.
 */

function planeSpecs(fmt, w, h) {
  var cw = Math.ceil(w / 2), ch = Math.ceil(h / 2), y = w * h;
  var Y = { offset: 0, stride: w, pixBytes: 1, subX: 1, subY: 1, rows: h };
  switch (fmt) {
    case 'I420': case 'YUV420P':
      return [Y,
        { offset: y,           stride: cw, pixBytes: 1, subX: 2, subY: 2, rows: ch },
        { offset: y + cw * ch, stride: cw, pixBytes: 1, subX: 2, subY: 2, rows: ch }];
    case 'I420A':
      return [Y,
        { offset: y,               stride: cw, pixBytes: 1, subX: 2, subY: 2, rows: ch },
        { offset: y + cw * ch,     stride: cw, pixBytes: 1, subX: 2, subY: 2, rows: ch },
        { offset: y + 2 * cw * ch, stride: w,  pixBytes: 1, subX: 1, subY: 1, rows: h }];
    case 'NV12':
      // Interleaved UV: one plane, two bytes per chroma sample pair.
      return [Y, { offset: y, stride: 2 * cw, pixBytes: 2, subX: 2, subY: 2, rows: ch }];
    case 'I422':
      return [Y,
        { offset: y,          stride: cw, pixBytes: 1, subX: 2, subY: 1, rows: h },
        { offset: y + cw * h, stride: cw, pixBytes: 1, subX: 2, subY: 1, rows: h }];
    case 'I422A':
      return [Y,
        { offset: y,              stride: cw, pixBytes: 1, subX: 2, subY: 1, rows: h },
        { offset: y + cw * h,     stride: cw, pixBytes: 1, subX: 2, subY: 1, rows: h },
        { offset: y + 2 * cw * h, stride: w,  pixBytes: 1, subX: 1, subY: 1, rows: h }];
    case 'I444':
      return [Y,
        { offset: y,     stride: w, pixBytes: 1, subX: 1, subY: 1, rows: h },
        { offset: 2 * y, stride: w, pixBytes: 1, subX: 1, subY: 1, rows: h }];
    case 'I444A':
      return [Y,
        { offset: y,     stride: w, pixBytes: 1, subX: 1, subY: 1, rows: h },
        { offset: 2 * y, stride: w, pixBytes: 1, subX: 1, subY: 1, rows: h },
        { offset: 3 * y, stride: w, pixBytes: 1, subX: 1, subY: 1, rows: h }];
    case 'RGBA': case 'RGBX': case 'BGRA': case 'BGRX':
      return [{ offset: 0, stride: w * 4, pixBytes: 4, subX: 1, subY: 1, rows: h }];
    case 'RGB24':
      return [{ offset: 0, stride: w * 3, pixBytes: 3, subX: 1, subY: 1, rows: h }];
    default:
      return null;
  }
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

export { planeSpecs, frameByteSize, planeLayout };
