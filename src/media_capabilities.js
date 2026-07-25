/**
 * MediaCapabilities — Query codec support before configure().
 * Browser-compatible subset of navigator.mediaCapabilities.
 */

import { getVideoCodec, getAudioCodec, getSupportedVideoCodecs, getSupportedAudioCodecs } from './codecs.js';
import { getHardwareAccelerationInfo } from './hw_accel.js';
import { parseCodecString } from './utils/codec_strings.js';

var mediaCapabilities = {
  /**
   * @param {object} config — { type: 'file', video: {...}, audio: {...} }
   * @returns {{ supported, smooth, powerEfficient }}
   */
  decodingInfo: function (config) {
    var result = { supported: false, smooth: false, powerEfficient: false };

    if (config.video) {
      var codec = _parseCodecString(config.video.contentType || '');
      if (codec && getSupportedVideoCodecs().indexOf(codec) >= 0) {
        result.supported = true;
        var w = config.video.width || 1920;
        var h = config.video.height || 1080;
        var fps = config.video.framerate || 30;
        // Smooth: can we decode at this resolution/fps? Conservative estimate
        result.smooth = (w * h * fps) < (3840 * 2160 * 60);
        result.powerEfficient = false;  // decoding via FFmpeg is always CPU
      }
    }

    if (config.audio) {
      var acodec = _parseCodecString(config.audio.contentType || '');
      if (acodec && getSupportedAudioCodecs().indexOf(acodec) >= 0) {
        result.supported = true;
        result.smooth = true;
        result.powerEfficient = true;  // audio decode is cheap
      }
    }

    return result;
  },

  /**
   * @param {object} config — { type: 'record', video: {...}, audio: {...} }
   * @returns {{ supported, smooth, powerEfficient }}
   */
  encodingInfo: function (config) {
    var result = { supported: false, smooth: false, powerEfficient: false };

    if (config.video) {
      var codec = _parseCodecString(config.video.contentType || '');
      if (codec) {
        var codecDef = getVideoCodec(codec, {});
        if (codecDef) {
          result.supported = true;
          var w = config.video.width || 1920;
          var h = config.video.height || 1080;
          var fps = config.video.framerate || 30;
          // Smooth: estimate based on codec speed at this resolution
          var pixelsPerSec = w * h * fps;
          if (codec === 'av1') result.smooth = pixelsPerSec < (1280 * 720 * 30);
          else if (codec === 'h265') result.smooth = pixelsPerSec < (1920 * 1080 * 60);
          else result.smooth = pixelsPerSec < (3840 * 2160 * 30);

          // Power efficient if hardware encoder available
          var hwInfo = getHardwareAccelerationInfo();
          if (hwInfo.encoders[codec] && hwInfo.encoders[codec].hasHardware) {
            result.powerEfficient = true;
          }
        }
      }
    }

    if (config.audio) {
      var acodec = _parseCodecString(config.audio.contentType || '');
      if (acodec && getSupportedAudioCodecs().indexOf(acodec) >= 0) {
        result.supported = true;
        result.smooth = true;
        result.powerEfficient = true;
      }
    }

    return result;
  },
};

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
  }

  return parseCodecString(codecPart);
}

export default mediaCapabilities;
export { mediaCapabilities };
