/**
 * MediaCapabilities — Query codec support before configure().
 * Browser-compatible subset of navigator.mediaCapabilities.
 */

import { getVideoCodec, getAudioCodec, getSupportedVideoCodecs, getSupportedAudioCodecs } from './codecs.js';
import { selectEncoder } from './hw_accel.js';
import { parseCodecString } from './utils/codec_strings.js';

var mediaCapabilities = {
  /**
   * @param {object} config — { type: 'file', video: {...}, audio: {...} }
   * @returns {{ supported, smooth, powerEfficient }}
   */
  // Both halves must be supported when both are given. Either half set
  // `supported = true` on its own, so {video: unsupported, audio: opus}
  // reported supported — and the audio half overwrote the video half's
  // smooth/powerEfficient. W3C: supported only if every configured part
  // is; smooth/powerEfficient likewise hold only if they hold for all.
  decodingInfo: function (config) {
    return _combine(config,
      function (v) {
        var codec = _parseCodecString(v.contentType || '');
        if (!codec || getSupportedVideoCodecs().indexOf(codec) < 0) return null;
        var w = v.width || 1920, h = v.height || 1080, fps = v.framerate || 30;
        // decoding via FFmpeg is always CPU
        return { smooth: (w * h * fps) < (3840 * 2160 * 60), powerEfficient: false };
      },
      function (a) {
        var acodec = _parseCodecString(a.contentType || '');
        if (!acodec || getSupportedAudioCodecs().indexOf(acodec) < 0) return null;
        return { smooth: true, powerEfficient: true };   // audio decode is cheap
      });
  },

  encodingInfo: function (config) {
    return _combine(config,
      function (v) {
        var codec = _parseCodecString(v.contentType || '');
        if (!codec || !getVideoCodec(codec, {})) return null;
        var w = v.width || 1920, h = v.height || 1080, fps = v.framerate || 30;
        var pixelsPerSec = w * h * fps, smooth;
        if (codec === 'av1') smooth = pixelsPerSec < (1280 * 720 * 30);
        else if (codec === 'h265') smooth = pixelsPerSec < (1920 * 1080 * 60);
        else smooth = pixelsPerSec < (3840 * 2160 * 30);
        // Power efficient only if a hardware encoder would really be
        // used: one that passed hw_accel's test encode (selected with
        // hardwareAcceleration 'prefer-hardware'). It was true whenever
        // `ffmpeg -encoders` LISTED one — h264_nvenc/qsv/vaapi on a box
        // where none of them can open, i.e. everywhere a stock FFmpeg
        // runs — while the encode actually ran on libx264 (C12).
        var sel = selectEncoder(codec, 'prefer-hardware');
        return { smooth: smooth, powerEfficient: !!sel.isHardware };
      },
      function (a) {
        var acodec = _parseCodecString(a.contentType || '');
        if (!acodec || getSupportedAudioCodecs().indexOf(acodec) < 0) return null;
        return { smooth: true, powerEfficient: true };
      });
  },
};

function _combine(config, videoInfo, audioInfo) {
  var parts = [];
  if (config && config.video) parts.push(videoInfo(config.video));
  if (config && config.audio) parts.push(audioInfo(config.audio));
  var result = { supported: parts.length > 0, smooth: parts.length > 0, powerEfficient: parts.length > 0 };
  for (var i = 0; i < parts.length; i++) {
    if (!parts[i]) return { supported: false, smooth: false, powerEfficient: false };
    result.smooth = result.smooth && parts[i].smooth;
    result.powerEfficient = result.powerEfficient && parts[i].powerEfficient;
  }
  return result;
}

/**
 * Parse codec name from a MIME contentType string.
 *   'video/mp4; codecs="avc1.42E01E"'  → 'h264'
 *   'video/webm; codecs="vp9"'         → 'vp9'
 *   'audio/mp4; codecs="mp4a.40.2"'    → 'aac'
 *
 * Delegates to codec_strings.parseCodecString for the actual codec
 * identification (via regex patterns on full strings). The previous
 * implementation used indexOf substring matching, which gave false
 * positives like 'avp9' or 'lvp9' → vp9 (MP-28).
 */
function _parseCodecString(contentType) {
  if (!contentType) return null;
  var str = String(contentType);

  // Extract the value of the codecs="..." parameter from the MIME
  // string, if present. Per RFC 6381, the codecs parameter holds
  // one or more codec strings separated by commas. We use the
  // first one (matches browser MediaCapabilities behavior).
  var m = str.match(/codecs\s*=\s*"?([^";]+)/i);
  var codecPart;
  if (m) {
    codecPart = m[1].split(',')[0].trim();
  } else {
    // No codecs parameter — caller might have passed a bare codec
    // string like 'vp9' or 'avc1.42E01E'. Try to parse directly.
    codecPart = str.trim();
    // A bare MIME type names the codec as its subtype ('audio/PCMU',
    // 'video/VP8' — the WebRTC form).
    var slash = codecPart.indexOf('/');
    if (slash > 0 && !parseCodecString(codecPart)) codecPart = codecPart.slice(slash + 1);
  }

  return parseCodecString(codecPart);
}

export default mediaCapabilities;
export { mediaCapabilities };
