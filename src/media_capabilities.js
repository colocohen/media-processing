/**
 * MediaCapabilities — Query codec support before configure().
 * Browser-compatible subset of navigator.mediaCapabilities.
 */

import {
  parseWebCodecsCodec, videoEncoderConfigSupported, videoDecoderConfigSupported, audioEncoderConfigSupported, audioDecoderCodecSupported,
} from './codecs.js';
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
  // decodingInfo asks the decoders (CONFIG_CAPS.videoDecoder /
  // audioDecoder: what VideoDecoder / AudioDecoder take), not the
  // encoders: it answered from the encoders' codec list, so 'pcm-s16'
  // — which AudioDecoder decodes and no encoder makes — was "not
  // supported" (Media Capabilities §2.5: whether the user agent can
  // decode it). The PCM codec strings (WebCodecs' registry) are named by
  // parseWebCodecsCodec, which parseCodecString does not know.
  //
  // `supported` is the coders' Check Configuration Support (codecs.js,
  // what isConfigSupported() and configure() run): the codec string's
  // profile / bit depth / chroma against the coder's caps, and the
  // FFmpeg on this machine (codec_availability.js). W3C Media
  // Capabilities: supported is whether "the user agent is able to"
  // decode / encode the configuration (§2.5 Create a
  // MediaCapabilitiesDecodingInfo / EncodingInfo: "If the user agent is
  // able to decode the media represented by configuration, set supported
  // to true"). It answered from the tables alone: supported: true for
  // H.265 encoding on an FFmpeg without libx265, while
  // VideoEncoder.isConfigSupported() said false and configure() closed
  // with NotSupportedError; the encoding half ignored the scalabilityMode
  // ('L3T3'), hasAlphaChannel, an odd or oversized frame, AAC's object
  // type (HE-AAC 'mp4a.40.5', which no encoder here makes); the decoding
  // half the channel count.
  decodingInfo: function (config) {
    config = _checkConfiguration(config, 'decodingInfo', _DECODING_TYPES);
    return _combine(config,
      function (v) {
        var codec = _coderCodec(v.contentType || '', true);
        if (!codec || !videoDecoderConfigSupported({ codec: codec })) return null;
        var w = v.width || 1920, h = v.height || 1080, fps = v.framerate || 30;
        // decoding via FFmpeg is always CPU
        return { smooth: (w * h * fps) < (3840 * 2160 * 60), powerEfficient: false };
      },
      function (a) {
        var acodec = _coderCodec(a.contentType || '', true);
        if (!acodec || !audioDecoderCodecSupported(acodec, _channelCount(a.channels))) return null;
        return { smooth: true, powerEfficient: true };   // audio decode is cheap
      });
  },

  encodingInfo: function (config) {
    config = _checkConfiguration(config, 'encodingInfo', _ENCODING_TYPES);
    return _combine(config,
      function (v) {
        var cs = _coderCodec(v.contentType || '', false);
        var info = cs && parseWebCodecsCodec(cs);
        // the VideoEncoderConfig the configuration describes (a 0 size
        // as the 1920x1080 assumed below, a 0 bitrate as none: both are
        // invalid in a VideoEncoderConfig)
        var ec = { codec: cs, width: v.width || 1920, height: v.height || 1080, framerate: v.framerate };
        if (v.bitrate > 0) ec.bitrate = v.bitrate;
        if (v.scalabilityMode !== undefined) ec.scalabilityMode = v.scalabilityMode;
        // a track with alpha: kept (VideoEncoderConfig alpha 'keep'),
        // which the encoders cannot (no alpha side data)
        if (v.hasAlphaChannel) ec.alpha = 'keep';
        if (!info || !videoEncoderConfigSupported(ec)) return null;
        var codec = info.name;
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
        var acodec = _coderCodec(a.contentType || '', false);
        // The rate and channel count, when given ('webrtc'), as
        // isConfigSupported checks them: AAC's 7 channels, Opus at 44.1
        // kHz were supported here (only the codec name was looked at).
        // Not given: not checked.
        if (!acodec || !audioEncoderConfigSupported({ codec: acodec, sampleRate: a.samplerate, numberOfChannels: _channelCount(a.channels) })) return null;
        return { smooth: true, powerEfficient: true };
      });
  },
};

// audio.channels is a DOMString whose form the spec leaves open (§2.1.8:
// "a placeholder" — a count, or a layout such as 5.1): a whole number is
// that many channels, 'N.M' N + M ('5.1': 6, '6.1': 7, '7.1': 8); any
// other string is not checked.
function _channelCount(s) {
  if (s === undefined) return undefined;
  var m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return undefined;
  return m[2] !== undefined ? Number(m[1]) + Number(m[2]) : Number(m[1]);
}

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

// The WebCodecs codec string the coders' checks take for a contentType:
// the codecs= entry (or bare string) itself when it is one ('avc1.42E01E',
// 'mp4a.40.2', 'pcm-s16'), else the short name parseCodecString gives it
// ('video/VP8' → 'vp8', 'audio/PCMU' → 'g711-ulaw', 'H264' → 'h264'), when
// that is one; or null. `decoding`: the decoders' names (the PCM strings),
// else the encoders' (the library's 'pcm').
function _coderCodec(contentType, decoding) {
  var part = _codecPart(contentType);
  if (part === null) return null;
  var name = decoding ? _decodingCodec(contentType) : _encodingCodec(contentType);
  if (!name) return null;
  if (parseWebCodecsCodec(part)) return part;
  return parseWebCodecsCodec(name) ? name : null;
}

// The decoders' name for a contentType's codec: parseCodecString's, or a
// WebCodecs PCM string ('pcm-s16', 'audio/pcm-f32') as it is.
function _decodingCodec(contentType) {
  var part = _codecPart(contentType);
  if (part === null) return null;
  var name = parseCodecString(part);
  if (name) return name;
  var info = parseWebCodecsCodec(part);
  return info && /^pcm-/.test(info.name) ? info.name : null;
}

// The audio encoders' name for a contentType's codec: parseCodecString's,
// or the library's 'pcm' (s16), which AudioEncoder takes (codecs.js
// _SHORT_NAMES, parseWebCodecsCodec) and parseCodecString does not know:
// encodingInfo said 'pcm' was unsupported while AudioEncoder encoded it.
function _encodingCodec(contentType) {
  var part = _codecPart(contentType);
  if (part === null) return null;
  var name = parseCodecString(part);
  if (name) return name;
  var info = parseWebCodecsCodec(part);
  return info && info.name === 'pcm' ? 'pcm' : null;
}

// The codec string a contentType names (its first codecs= entry, else
// the bare string, else a bare MIME type's subtype), or null.
function _codecPart(contentType) {
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

  return codecPart;
}

export default mediaCapabilities;
export { mediaCapabilities };
