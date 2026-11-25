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
    config = _checkConfiguration(config, 'decodingInfo', _DECODING_TYPES);
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
    config = _checkConfiguration(config, 'encodingInfo', _ENCODING_TYPES);
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

// ── W3C validity (Media Capabilities §2.1, §2.5) ──
//
// decodingInfo() / encodingInfo() reject a configuration that is not a
// valid one with a TypeError: the WebIDL conversion of the dictionaries
// (the required members — type; video's contentType, width, height,
// bitrate and framerate; audio's contentType — and the enums), neither
// audio nor video given, a framerate that is not finite and above 0, a
// member given for a type it does not apply to. All of these were
// answered {supported: false} (or, for a missing width / framerate,
// supported with 1920x1080 at 30 fps assumed). Here they throw: the
// methods answer synchronously (the spec's Promise is an open item).
// The contentType's MIME validity stays lenient — a bare codec string
// ('vp9', 'avc1.42E01E') is accepted as an extension.
var _DECODING_TYPES = ['file', 'media-source', 'webrtc'];
var _ENCODING_TYPES = ['record', 'webrtc'];
var _VIDEO_IDL = [
  ['bitrate', 'ull', true], ['colorGamut', ['srgb', 'p3', 'rec2020']], ['contentType', 'str', true],
  ['framerate', 'double', true], ['hasAlphaChannel', 'bool'], ['hdrMetadataType', ['smpteSt2086', 'smpteSt2094-10', 'smpteSt2094-40']],
  ['height', 'ul', true], ['scalabilityMode', 'str'], ['spatialScalability', 'bool'],
  ['transferFunction', ['srgb', 'pq', 'hlg']], ['width', 'ul', true],
];
var _AUDIO_IDL = [
  ['bitrate', 'ull'], ['channels', 'str'], ['contentType', 'str', true], ['samplerate', 'ul'], ['spatialRendering', 'bool'],
];

// WebIDL conversions of the plain (not [EnforceRange]) integer types:
// modulo 2^32 / 2^64, NaN and the infinities 0. double: finite or a TypeError.
function _toUnsigned(v, bits) {
  var x = Number(v);
  if (!Number.isFinite(x)) return 0;
  x = Math.trunc(x);
  var m = Math.pow(2, bits);
  x = x - Math.floor(x / m) * m;
  return x === 0 ? 0 : x;
}

function _convert(dict, idl, what) {
  if (dict === null) dict = {};
  if (typeof dict !== 'object') throw new TypeError(what + ' must be a dictionary');
  var out = {};
  for (var i = 0; i < idl.length; i++) {
    var name = idl[i][0], kind = idl[i][1], v = dict[name];
    if (v === undefined) {
      if (idl[i][2]) throw new TypeError(what + '.' + name + ' required');
      continue;
    }
    if (Array.isArray(kind)) {
      var sv = String(v);
      if (kind.indexOf(sv) < 0) throw new TypeError(what + '.' + name + " must be one of '" + kind.join("', '") + "' (got '" + sv + "')");
      out[name] = sv;
    } else if (kind === 'str') out[name] = String(v);
    else if (kind === 'bool') out[name] = !!v;
    else if (kind === 'ul') out[name] = _toUnsigned(v, 32);
    else if (kind === 'ull') out[name] = _toUnsigned(v, 64);
    else if (kind === 'double') {
      var d = Number(v);
      if (!Number.isFinite(d)) throw new TypeError(what + '.' + name + ' must be a finite number');
      out[name] = d;
    }
  }
  return out;
}

function _checkConfiguration(config, method, types) {
  var prefix = 'MediaCapabilities.' + method;
  if (config === null || config === undefined) config = {};
  if (typeof config !== 'object') throw new TypeError(prefix + ': configuration must be a dictionary');
  // Inherited members first (MediaConfiguration: audio, video), then the
  // derived dictionary's (type) — WebIDL §3.2.17.
  var out = {};
  if (config.audio !== undefined) out.audio = _convert(config.audio, _AUDIO_IDL, prefix + ': audio');
  if (config.video !== undefined) out.video = _convert(config.video, _VIDEO_IDL, prefix + ': video');
  if (config.type === undefined) throw new TypeError(prefix + ': type required');
  var type = String(config.type);
  if (types.indexOf(type) < 0) throw new TypeError(prefix + ": type must be one of '" + types.join("', '") + "' (got '" + type + "')");
  out.type = type;
  if (!out.audio && !out.video) throw new TypeError(prefix + ': audio or video required');
  var decoding = types === _DECODING_TYPES;
  var v = out.video, a = out.audio;
  if (v) {
    if (!(v.framerate > 0)) throw new TypeError(prefix + ': video.framerate must be greater than 0');
    var hdrOk = decoding && type !== 'webrtc';
    ['hdrMetadataType', 'colorGamut', 'transferFunction'].forEach(function (k) {
      if (v[k] !== undefined && !hdrOk) throw new TypeError(prefix + ': video.' + k + " does not apply to type '" + type + "'");
    });
    if (v.scalabilityMode !== undefined && !(!decoding && type === 'webrtc')) throw new TypeError(prefix + ": video.scalabilityMode does not apply to type '" + type + "'");
    if (v.spatialScalability !== undefined && !decoding) throw new TypeError(prefix + ": video.spatialScalability does not apply to type '" + type + "'");
  }
  if (a) {
    var chOk = decoding || type === 'webrtc';
    ['channels', 'samplerate'].forEach(function (k) {
      if (a[k] !== undefined && !chOk) throw new TypeError(prefix + ': audio.' + k + " does not apply to type '" + type + "'");
    });
  }
  return out;
}

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
