/**
 * MediaCapabilities — Query codec support before configure().
 * Browser-compatible subset of navigator.mediaCapabilities.
 */

import { getVideoCodec, getAudioCodec, getSupportedVideoCodecs, getSupportedAudioCodecs } from './codecs.js';
import { getHardwareAccelerationInfo } from './hw_accel.js';

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
 * Parse codec name from MIME string.
 * 'video/mp4; codecs="avc1.42E01E"' → 'h264'
 * 'video/webm; codecs="vp9"' → 'vp9'
 * 'audio/mp4; codecs="mp4a.40.2"' → 'aac'
 */
function _parseCodecString(contentType) {
  if (!contentType) return null;
  var str = String(contentType).toLowerCase();

  // Direct codec names
  if (str.indexOf('vp8') >= 0 || str.indexOf('vp08') >= 0) return 'vp8';
  if (str.indexOf('vp9') >= 0 || str.indexOf('vp09') >= 0) return 'vp9';
  if (str.indexOf('av1') >= 0 || str.indexOf('av01') >= 0) return 'av1';
  if (str.indexOf('avc') >= 0 || str.indexOf('h264') >= 0 || str.indexOf('h.264') >= 0) return 'h264';
  if (str.indexOf('hev') >= 0 || str.indexOf('hvc') >= 0 || str.indexOf('h265') >= 0 || str.indexOf('h.265') >= 0) return 'h265';
  if (str.indexOf('mp4a') >= 0 || str.indexOf('aac') >= 0) return 'aac';
  if (str.indexOf('opus') >= 0) return 'opus';

  return null;
}

export default mediaCapabilities;
export { mediaCapabilities };
