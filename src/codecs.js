/**
 * codecs — Codec registry with hardware acceleration + GPU upload filters.
 *
 * Each encoder returns { preInput: [...], args: [...] }
 *   preInput: FFmpeg args BEFORE -i (e.g. -init_hw_device)
 *   args:     FFmpeg args AFTER -map (codec, filters, quality)
 */

import { selectEncoder } from './hw_accel.js';
import { cpus } from 'node:os';

/**
 * WebCodecs profile names (extracted from full codec strings like
 * 'avc1.42E01F') do not all match the profile names libx264/libx265
 * accept on the command line. WebCodecs follows the H.264 spec naming
 * ('constrained-baseline', 'progressive-high', ...); FFmpeg's encoders
 * accept a smaller set. Without this mapping, FFmpeg is handed e.g.
 * `-profile:v constrained-baseline`, rejects it, and exits producing no
 * output. This surfaced when the HLS layer (which builds full codec
 * strings) was joined with the FFmpeg-backed encoder — see the codec-
 * injection seam.
 *
 * libx264 accepts: baseline, main, high, high10, high422, high444.
 */
function _ffmpegH264Profile(p) {
  if (!p) return 'baseline';
  switch (String(p).toLowerCase()) {
    case 'constrained-baseline':
    case 'baseline':            return 'baseline';
    case 'main':
    case 'extended':            return 'main';   // extended isn't a libx264 profile
    case 'high':
    case 'constrained-high':
    case 'progressive-high':    return 'high';
    case 'high-10':
    case 'high10':              return 'high10';
    case 'high-4:2:2':
    case 'high422':             return 'high422';
    case 'high-4:4:4':
    case 'high444':             return 'high444';
    default:                    return 'baseline';
  }
}

/** libx265 accepts: main, main10, main12, mainstillpicture, main444-8, ... */
function _ffmpegH265Profile(p) {
  if (!p) return 'main';
  switch (String(p).toLowerCase()) {
    case 'main':                return 'main';
    case 'main-10':
    case 'main10':              return 'main10';
    case 'main-12':
    case 'main12':              return 'main12';
    case 'main-still-picture':
    case 'mainstillpicture':    return 'mainstillpicture';
    default:                    return 'main';
  }
}


/** Detect available CPU threads (cached). */
var _cpuCount = 0;
function getCpuCount() {
  if (!_cpuCount) {
    try { _cpuCount = cpus().length; } catch (e) { _cpuCount = 4; }
    if (!_cpuCount || _cpuCount < 1) _cpuCount = 4;
  }
  return _cpuCount;
}

/**
 * Add bitrate/quality args based on bitrateMode.
 *  - 'variable' (default): CRF-based, optional maxrate
 *  - 'constant': CBR — fixed bitrate, no quality variation
 *  - 'quantizer': fixed QP/CRF, ignore bitrate target
 */
function _addBitrateArgs(args, cfg, defaultCrf) {
  var mode = cfg.bitrateMode || 'variable';
  var crf = (typeof cfg.crf === 'number') ? cfg.crf : defaultCrf;
  var br = cfg.bitrate ? String(cfg.bitrate) : '2000k';

  if (mode === 'constant' && cfg.bitrate) {
    args.push('-b:v', br, '-minrate', br, '-maxrate', br, '-bufsize', String(cfg.bitrate * 2));
  } else if (mode === 'quantizer') {
    args.push('-b:v', '0', '-crf', String(crf));
  } else {
    // variable (default)
    args.push('-b:v', cfg.bitrate ? br : '0', '-crf', String(crf));
  }
}

var ENCODER_ARGS = {

  // ════════════════ H.264 ════════════════

  libx264: function (cfg) {
    var preset = cfg.latencyMode === 'quality' ? 'medium' : 'veryfast';
    var threads = (typeof cfg.threads === 'number') ? cfg.threads : getCpuCount();
    var profile = _ffmpegH264Profile(cfg.profile);
    var level = cfg.level || '3.1';
    var args = [
      '-c:v', 'libx264', '-threads', String(threads),
      '-preset', preset, '-tune', 'zerolatency',
      '-profile:v', profile, '-level', level,
      '-x264-params', 'repeat-headers=1:aud=1:scenecut=0:open_gop=0',
      '-g', String(cfg.gopSize || 30),
    ];
    _addBitrateArgs(args, cfg, 23);
    return { preInput: [], args: args };
  },
  h264_nvenc: function (cfg) {
    return { preInput: ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'], args: [
      '-vf', 'hwupload_cuda,scale_cuda=format=yuv420p',
      '-c:v', 'h264_nvenc',
      '-preset', cfg.latencyMode === 'quality' ? 'p5' : 'p1',
      '-tune', 'll', '-rc', 'vbr',
      '-g', String(cfg.gopSize || 30),
      '-b:v', cfg.bitrate ? String(cfg.bitrate) : '2000k',
      '-cq', String((typeof cfg.crf === 'number') ? cfg.crf : 23),
    ]};
  },
  h264_videotoolbox: function (cfg) {
    return { preInput: [], args: [
      '-c:v', 'h264_videotoolbox',
      '-realtime', cfg.latencyMode === 'quality' ? '0' : '1',
      '-g', String(cfg.gopSize || 30),
      '-b:v', cfg.bitrate ? String(cfg.bitrate) : '2000k',
      '-q:v', String((typeof cfg.crf === 'number') ? cfg.crf : 50),
    ]};
  },
  h264_qsv: function (cfg) {
    return { preInput: ['-init_hw_device', 'qsv=hw', '-filter_hw_device', 'hw'], args: [
      '-vf', 'hwupload=extra_hw_frames=64,format=qsv',
      '-c:v', 'h264_qsv',
      '-preset', cfg.latencyMode === 'quality' ? 'medium' : 'veryfast',
      '-g', String(cfg.gopSize || 30),
      '-b:v', cfg.bitrate ? String(cfg.bitrate) : '2000k',
      '-global_quality', String((typeof cfg.crf === 'number') ? cfg.crf : 23),
    ]};
  },
  h264_vaapi: function (cfg) {
    return { preInput: ['-init_hw_device', 'vaapi=hw:/dev/dri/renderD128', '-filter_hw_device', 'hw'], args: [
      '-vf', 'format=nv12,hwupload',
      '-c:v', 'h264_vaapi',
      '-g', String(cfg.gopSize || 30),
      '-b:v', cfg.bitrate ? String(cfg.bitrate) : '2000k',
      '-rc_mode', 'VBR',
    ]};
  },
  h264_amf: function (cfg) {
    return { preInput: [], args: [
      '-vf', 'hwupload_amf',
      '-c:v', 'h264_amf',
      '-quality', cfg.latencyMode === 'quality' ? 'quality' : 'speed',
      '-g', String(cfg.gopSize || 30),
      '-b:v', cfg.bitrate ? String(cfg.bitrate) : '2000k',
      '-rc', 'vbr_latency',
    ]};
  },

  // ════════════════ H.265 ════════════════

  libx265: function (cfg) {
    var preset = cfg.latencyMode === 'quality' ? 'medium' : 'ultrafast';
    var threads = (typeof cfg.threads === 'number') ? cfg.threads : getCpuCount();
    var profile = _ffmpegH265Profile(cfg.profile);
    var args = [
      '-c:v', 'libx265', '-threads', String(threads),
      '-preset', preset, '-tune', 'zerolatency',
      '-profile:v', profile,
      '-x265-params', 'repeat-headers=1:aud=1:scenecut=0:open-gop=0',
      '-g', String(cfg.gopSize || 60),
    ];
    if (cfg.level) args.push('-level', cfg.level);
    _addBitrateArgs(args, cfg, 28);
    return { preInput: [], args: args };
  },
  hevc_nvenc: function (cfg) {
    return { preInput: ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'], args: [
      '-vf', 'hwupload_cuda,scale_cuda=format=yuv420p',
      '-c:v', 'hevc_nvenc',
      '-preset', cfg.latencyMode === 'quality' ? 'p5' : 'p1',
      '-tune', 'll', '-rc', 'vbr',
      '-g', String(cfg.gopSize || 60),
      '-b:v', cfg.bitrate ? String(cfg.bitrate) : '2000k',
      '-cq', String((typeof cfg.crf === 'number') ? cfg.crf : 28),
    ]};
  },
  hevc_videotoolbox: function (cfg) {
    return { preInput: [], args: [
      '-c:v', 'hevc_videotoolbox',
      '-realtime', cfg.latencyMode === 'quality' ? '0' : '1',
      '-g', String(cfg.gopSize || 60),
      '-b:v', cfg.bitrate ? String(cfg.bitrate) : '2000k',
      '-q:v', String((typeof cfg.crf === 'number') ? cfg.crf : 50),
    ]};
  },
  hevc_qsv: function (cfg) {
    return { preInput: ['-init_hw_device', 'qsv=hw', '-filter_hw_device', 'hw'], args: [
      '-vf', 'hwupload=extra_hw_frames=64,format=qsv',
      '-c:v', 'hevc_qsv',
      '-preset', cfg.latencyMode === 'quality' ? 'medium' : 'veryfast',
      '-g', String(cfg.gopSize || 60),
      '-b:v', cfg.bitrate ? String(cfg.bitrate) : '2000k',
      '-global_quality', String((typeof cfg.crf === 'number') ? cfg.crf : 28),
    ]};
  },
  hevc_vaapi: function (cfg) {
    return { preInput: ['-init_hw_device', 'vaapi=hw:/dev/dri/renderD128', '-filter_hw_device', 'hw'], args: [
      '-vf', 'format=nv12,hwupload',
      '-c:v', 'hevc_vaapi',
      '-g', String(cfg.gopSize || 60),
      '-b:v', cfg.bitrate ? String(cfg.bitrate) : '2000k',
      '-rc_mode', 'VBR',
    ]};
  },
  hevc_amf: function (cfg) {
    return { preInput: [], args: [
      '-vf', 'hwupload_amf',
      '-c:v', 'hevc_amf',
      '-quality', cfg.latencyMode === 'quality' ? 'quality' : 'speed',
      '-g', String(cfg.gopSize || 60),
      '-b:v', cfg.bitrate ? String(cfg.bitrate) : '2000k',
      '-rc', 'vbr_latency',
    ]};
  },

  // ════════════════ VP8 ════════════════

  libvpx: function (cfg) {
    var threads = (typeof cfg.threads === 'number') ? cfg.threads : getCpuCount();
    var args = [
      '-c:v', 'libvpx',
      '-threads', String(threads),
      '-deadline', cfg.latencyMode === 'quality' ? 'good' : 'realtime',
      '-cpu-used', '8', '-lag-in-frames', '0', '-auto-alt-ref', '0',
      '-g', String(cfg.gopSize || 30),
      '-b:v', cfg.bitrate ? String(cfg.bitrate) : '0',
      '-crf', String((typeof cfg.crf === 'number') ? cfg.crf : 10),
    ];
    if (cfg.errorResilient) args.push('-error-resilient', '1');
    return { preInput: [], args: args };
  },

  // ════════════════ VP9 ════════════════

  'libvpx-vp9': function (cfg) {
    var cores = getCpuCount();
    var w = cfg.width || 0;

    // Auto tile-columns based on resolution (same logic as Chrome/libvpx)
    // then clamped to available cores (no point having 64 tiles on 4 cores)
    var defaultTileCols;
    if (w >= 3840) defaultTileCols = 6;       // 4K → up to 64 columns
    else if (w >= 2560) defaultTileCols = 4;  // 1440p → up to 16 columns
    else if (w >= 1280) defaultTileCols = 2;  // 720p → up to 4 columns
    else if (w >= 640) defaultTileCols = 1;   // 480p → up to 2 columns
    else defaultTileCols = 0;                 // below → 1 column

    // Clamp: tile count (2^tileCols) shouldn't exceed core count
    var maxTileLog2 = Math.max(0, Math.floor(Math.log2(cores)));
    if (defaultTileCols > maxTileLog2) defaultTileCols = maxTileLog2;

    var tileCols = (typeof cfg.tileColumns === 'number') ? cfg.tileColumns : defaultTileCols;
    var tileRows = (typeof cfg.tileRows === 'number') ? cfg.tileRows : (w >= 1280 ? 1 : 0);
    var threads = (typeof cfg.threads === 'number') ? cfg.threads : cores;

    var args = [
      '-c:v', 'libvpx-vp9',
      '-threads', String(threads),
      '-deadline', cfg.latencyMode === 'quality' ? 'good' : 'realtime',
      '-cpu-used', '8', '-lag-in-frames', '0', '-auto-alt-ref', '0',
      '-row-mt', '1', '-frame-parallel', '1',
      '-tile-columns', String(tileCols), '-tile-rows', String(tileRows),
      '-g', String(cfg.gopSize || 30),
    ];
    _addBitrateArgs(args, cfg, 32);
    if (cfg.errorResilient) args.push('-error-resilient', '1');
    return { preInput: [], args: args };
  },
  vp9_vaapi: function (cfg) {
    return { preInput: ['-init_hw_device', 'vaapi=hw:/dev/dri/renderD128', '-filter_hw_device', 'hw'], args: [
      '-vf', 'format=nv12,hwupload',
      '-c:v', 'vp9_vaapi',
      '-g', String(cfg.gopSize || 30),
      '-b:v', cfg.bitrate ? String(cfg.bitrate) : '2000k',
      '-rc_mode', 'VBR',
    ]};
  },
  vp9_qsv: function (cfg) {
    return { preInput: ['-init_hw_device', 'qsv=hw', '-filter_hw_device', 'hw'], args: [
      '-vf', 'hwupload=extra_hw_frames=64,format=qsv',
      '-c:v', 'vp9_qsv',
      '-g', String(cfg.gopSize || 30),
      '-b:v', cfg.bitrate ? String(cfg.bitrate) : '2000k',
      '-global_quality', String((typeof cfg.crf === 'number') ? cfg.crf : 32),
    ]};
  },

  // ════════════════ AV1 ════════════════

  'libaom-av1': function (cfg) {
    var cores = getCpuCount();
    var threads = (typeof cfg.threads === 'number') ? cfg.threads : cores;
    var w = cfg.width || 0;
    var defaultTileCols = (w >= 1920) ? 2 : (w >= 640 ? 1 : 0);
    var tileCols = (typeof cfg.tileColumns === 'number') ? cfg.tileColumns : defaultTileCols;
    var tileRows = (typeof cfg.tileRows === 'number') ? cfg.tileRows : (w >= 1280 ? 1 : 0);
    var args = [
      '-c:v', 'libaom-av1',
      '-threads', String(threads),
      '-cpu-used', '8', '-lag-in-frames', '0',
      '-tile-columns', String(tileCols), '-tile-rows', String(tileRows),
      '-row-mt', '1',
      '-g', String(cfg.gopSize || 60),
    ];
    _addBitrateArgs(args, cfg, 35);
    args.push('-strict', '-2');
    return { preInput: [], args: args };
  },
  av1_nvenc: function (cfg) {
    return { preInput: ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'], args: [
      '-vf', 'hwupload_cuda,scale_cuda=format=yuv420p',
      '-c:v', 'av1_nvenc',
      '-preset', cfg.latencyMode === 'quality' ? 'p5' : 'p1',
      '-tune', 'll', '-rc', 'vbr',
      '-g', String(cfg.gopSize || 60),
      '-b:v', cfg.bitrate ? String(cfg.bitrate) : '2000k',
      '-cq', String((typeof cfg.crf === 'number') ? cfg.crf : 35),
    ]};
  },
  av1_qsv: function (cfg) {
    return { preInput: ['-init_hw_device', 'qsv=hw', '-filter_hw_device', 'hw'], args: [
      '-vf', 'hwupload=extra_hw_frames=64,format=qsv',
      '-c:v', 'av1_qsv',
      '-g', String(cfg.gopSize || 60),
      '-b:v', cfg.bitrate ? String(cfg.bitrate) : '2000k',
      '-global_quality', String((typeof cfg.crf === 'number') ? cfg.crf : 35),
    ]};
  },
  av1_vaapi: function (cfg) {
    return { preInput: ['-init_hw_device', 'vaapi=hw:/dev/dri/renderD128', '-filter_hw_device', 'hw'], args: [
      '-vf', 'format=nv12,hwupload',
      '-c:v', 'av1_vaapi',
      '-g', String(cfg.gopSize || 60),
      '-b:v', cfg.bitrate ? String(cfg.bitrate) : '2000k',
      '-rc_mode', 'VBR',
    ]};
  },
  av1_amf: function (cfg) {
    return { preInput: [], args: [
      '-vf', 'hwupload_amf',
      '-c:v', 'av1_amf',
      '-quality', cfg.latencyMode === 'quality' ? 'quality' : 'speed',
      '-g', String(cfg.gopSize || 60),
      '-b:v', cfg.bitrate ? String(cfg.bitrate) : '2000k',
    ]};
  },
};

// ═══════════════════════════════════════════
// Codec metadata
// ═══════════════════════════════════════════

// MP-6: video codec metadata now carries profile/level capabilities,
// enabling RTCRtpSender.getCapabilities() to report a complete
// {codec, profile, level} matrix per W3C webrtc-pc §5.2.7. The
// previous getSupportedVideoCodecs() returned just names, forcing
// callers in webrtc-server to either hardcode profiles or skip the
// fmtp negotiation step.
//
// Profile lists below reflect what FFmpeg's encoders can produce
// AND what major browsers commonly negotiate. Levels are conservative
// — listing the highest commonly-supported level for each profile.
// SDP fmtp strings use buildCodecString conventions (codec_strings.js).
var VIDEO_CODEC_META = {
  vp8: {
    pixFmt: 'yuv420p',
    fourcc: 'VP80',
    profiles: [
      // VP8 has no formal profile/level — single profile, no level.
      // Use empty profile string per common SDP convention.
      { profile: '', level: '', codecString: 'vp8' },
    ],
  },
  vp9: {
    pixFmt: 'yuv420p',
    fourcc: 'VP90',
    profiles: [
      // VP9 profiles 0 (8-bit 4:2:0), 2 (10/12-bit 4:2:0).
      // Level 1 = 240p; Level 4 = 1080p; Level 5 = 4k. We list the
      // common WebRTC ones.
      { profile: '0', level: '4.1', codecString: 'vp09.00.41.08' },
      { profile: '0', level: '5.0', codecString: 'vp09.00.50.08' },
      { profile: '2', level: '4.1', codecString: 'vp09.02.41.10', bitDepth: 10 },
    ],
  },
  av1: {
    pixFmt: 'yuv420p',
    fourcc: 'AV01',
    profiles: [
      { profile: 'main', level: '4.0', codecString: 'av01.0.08M.08' },
      { profile: 'main', level: '5.0', codecString: 'av01.0.12M.08' },
      { profile: 'high', level: '4.0', codecString: 'av01.1.08M.08' },
    ],
  },
  h264: {
    pixFmt: 'yuv420p',
    profiles: [
      // Constrained Baseline — Chrome WebRTC default. CBP at 3.1
      // covers up to 720p30. Level 4.0 covers 1080p30.
      { profile: 'constrained-baseline', level: '3.1', codecString: 'avc1.42E01F' },
      { profile: 'constrained-baseline', level: '4.0', codecString: 'avc1.42E028' },
      { profile: 'baseline',             level: '3.1', codecString: 'avc1.42001F' },
      { profile: 'main',                 level: '3.1', codecString: 'avc1.4D001F' },
      { profile: 'main',                 level: '4.0', codecString: 'avc1.4D0028' },
      { profile: 'high',                 level: '4.0', codecString: 'avc1.640028' },
      { profile: 'high',                 level: '4.2', codecString: 'avc1.64002A' },
    ],
  },
  h265: {
    pixFmt: 'yuv420p',
    profiles: [
      { profile: 'main',   level: '3.1', codecString: 'hev1.1.6.L93.B0' },
      { profile: 'main',   level: '4.0', codecString: 'hev1.1.6.L120.B0' },
      { profile: 'main10', level: '4.0', codecString: 'hev1.2.6.L120.B0' },
    ],
  },
};

// Audio codec capabilities — most audio codecs don't have profile/level
// concepts (Opus is fixed; AAC has profiles 'aac-lc', 'he-aac', etc.
// but only AAC-LC is relevant for WebRTC).
var AUDIO_CODEC_META = {
  opus: {
    profiles: [
      { profile: '',      codecString: 'opus' },
    ],
    sampleRates: [8000, 12000, 16000, 24000, 48000],
    channels: [1, 2],
  },
  aac: {
    profiles: [
      { profile: 'lc',    codecString: 'mp4a.40.2', objectType: 2 },
      { profile: 'he',    codecString: 'mp4a.40.5', objectType: 5 },
      { profile: 'he-v2', codecString: 'mp4a.40.29', objectType: 29 },
    ],
    sampleRates: [8000, 16000, 22050, 24000, 32000, 44100, 48000],
    channels: [1, 2],
  },
  mp3:    { profiles: [{ profile: '', codecString: 'mp3' }] },
  flac:   { profiles: [{ profile: '', codecString: 'flac' }] },
  vorbis: { profiles: [{ profile: '', codecString: 'vorbis' }] },
};

// ═══════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════

function getVideoCodec(name, cfg) {
  if (!cfg) cfg = {};
  var codecKey = String(name || '').toLowerCase();
  var meta = VIDEO_CODEC_META[codecKey];
  if (!meta) return null;

  var preference = cfg.hardwareAcceleration || 'no-preference';
  var selected = selectEncoder(codecKey, preference);

  var argBuilder = ENCODER_ARGS[selected.encoder];
  if (!argBuilder) {
    selected = selectEncoder(codecKey, 'prefer-software');
    argBuilder = ENCODER_ARGS[selected.encoder];
  }
  if (!argBuilder) return null;

  var result = argBuilder(cfg);

  return {
    kind: 'video',
    pixFmt: meta.pixFmt,
    fourcc: meta.fourcc || null,
    preInput: result.preInput || [],
    args: result.args,
    encoder: selected.encoder,
    isHardware: selected.isHardware,
  };
}

// ── G.711 sampleRate validation (MP-35) ──
//
// G.711 (PCMA/PCMU per ITU-T G.711, RTP payload per RFC 3551 §4.5.14) is
// defined ONLY at 8000 Hz / mono. The FFmpeg muxer args we emit hardcode
// '-ar 8000 -ac 1', which means any caller-provided sampleRate ≠ 8000 was
// silently being overridden — the caller's sampleRate field appeared to
// be honored (no error, no warning) but FFmpeg was actually resampling
// behind the scenes (or producing output at 8000Hz with a channel-count
// mismatch on input). Surface this loudly so misconfigurations are caught
// at configure() rather than producing surprising output.
//
// We do not throw — RFC 3551 only profiles G.711 at 8000Hz, but the
// underlying PCM A-law / μ-law transforms are sample-rate agnostic;
// FFmpeg can in principle encode at 16kHz if asked. So this is a soft
// error: console.warn rather than NotSupportedError. Callers that want
// strict behavior can opt in via cfg.strictSampleRate=true.
function _validateG711SampleRate(cfg, codecName) {
  if (!cfg || cfg.sampleRate === undefined || cfg.sampleRate === null) return;
  if (cfg.sampleRate === 8000) return;
  var msg = "[codecs] " + codecName + ": sampleRate=" + cfg.sampleRate +
            " ignored — RFC 3551 §4.5.14 defines this codec only at 8000 Hz. " +
            "FFmpeg will resample to 8000 Hz internally.";
  if (cfg.strictSampleRate) {
    var e = new Error(msg);
    e.name = 'NotSupportedError';
    throw e;
  }
  // Lazy console import — codecs.js is a pure function module otherwise.
  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    console.warn(msg);
  }
}

var AUDIO_CODECS = {
  aac: function (cfg) {
    var br = cfg.bitrate || 128000;
    return { kind: 'audio', preInput: [], args: ['-c:a', 'aac', '-b:a', String(Math.round(br / 1000)) + 'k'] };
  },
  opus: function (cfg) {
    // ── Opus sampleRate validation (MP-35) ──
    // Per RFC 6716 §2.1.4, libopus accepts only {8000, 12000, 16000,
    // 24000, 48000} Hz at the encoder boundary. Anything else fails
    // libopus_encoder_init silently or with a confusing error. Validate
    // here so callers see a clear NotSupportedError at configure() time
    // rather than an obscure FFmpeg failure at first encode.
    if (cfg.sampleRate !== undefined && cfg.sampleRate !== null) {
      var validRates = [8000, 12000, 16000, 24000, 48000];
      if (validRates.indexOf(cfg.sampleRate) === -1) {
        var e = new Error(
          'Opus sampleRate must be one of ' + validRates.join(', ') +
          ' Hz (RFC 6716 §2.1.4); got ' + cfg.sampleRate
        );
        e.name = 'NotSupportedError';
        throw e;
      }
    }

    // MP-5: Opus encoder must respect SDP fmtp parameters per RFC 7587:
    //   useinbandfec=1       — in-band FEC (recover lost packets)
    //   usedtx=1             — discontinuous transmission (silence-skip)
    //   cbr=0|1              — constant bitrate forcing
    //   maxaveragebitrate=N  — bitrate ceiling
    //   maxplaybackrate=N    — receiver's reported playback ceiling
    //
    // The previous encoder honored only `bitrate`. WebRTC SDP from
    // most browsers includes these params (e.g. Chrome offers
    // 'useinbandfec=1; usedtx=0' by default), and FFmpeg exposes
    // each as a libopus option. Without these the negotiated FEC /
    // DTX flags from SDP became silently inactive — picky peers
    // would reject the session, others would just have wrong loss
    // recovery behavior.

    var args = ['-c:a', 'libopus'];

    // bitrate: prefer caller-supplied. maxaveragebitrate caps it.
    var br = cfg.bitrate || 64000;
    if (typeof cfg.maxaveragebitrate === 'number' && cfg.maxaveragebitrate > 0) {
      br = Math.min(br, cfg.maxaveragebitrate);
    }
    args.push('-b:a', String(Math.round(br / 1000)) + 'k');

    // useinbandfec: enable Opus in-band FEC. libopus expects -fec 1.
    if (cfg.useinbandfec === 1 || cfg.useinbandfec === true) {
      args.push('-fec', '1');
      // FEC needs a hint about expected packet loss; default 10% is
      // conservative. Caller can override via packetlossperc.
      var loss = (typeof cfg.packetlossperc === 'number')
        ? cfg.packetlossperc : 10;
      args.push('-packet_loss', String(Math.max(0, Math.min(100, loss))));
    } else if (cfg.useinbandfec === 0 || cfg.useinbandfec === false) {
      args.push('-fec', '0');
    }
    // (else: leave libopus default, which is FEC enabled)

    // usedtx: discontinuous transmission. libopus -dtx 1.
    if (cfg.usedtx === 1 || cfg.usedtx === true) {
      args.push('-dtx', '1');
    } else if (cfg.usedtx === 0 || cfg.usedtx === false) {
      args.push('-dtx', '0');
    }

    // cbr: force constant bitrate (vs VBR default).
    if (cfg.cbr === 1 || cfg.cbr === true) {
      args.push('-vbr', 'off');
    } else if (cfg.cbr === 0 || cfg.cbr === false) {
      args.push('-vbr', 'on');
    }

    // maxplaybackrate: cap output sample rate. libopus -ar handles
    // this naturally — when caller provides it, we set the encoder's
    // internal SR to the lower of {input rate, maxplaybackrate}.
    if (typeof cfg.maxplaybackrate === 'number' && cfg.maxplaybackrate > 0) {
      args.push('-ar', String(cfg.maxplaybackrate));
    }

    // Application: 'voip' for low-latency speech, 'audio' for music,
    // 'lowdelay' for minimum latency. WebRTC default is voip.
    if (cfg.application) {
      args.push('-application', String(cfg.application));
    }

    // Frame duration (ptime) — RFC 7587 default 20ms; WebRTC commonly
    // negotiates 10/20/40/60. libopus uses -frame_duration in ms.
    if (typeof cfg.ptimeMs === 'number' && cfg.ptimeMs > 0) {
      args.push('-frame_duration', String(cfg.ptimeMs));
    }

    // Complexity (MP-11) — libopus computational complexity, 0..10.
    // Higher = better quality but more CPU. libopus default is 9 for
    // realtime use. Maps to FFmpeg's -compression_level. Spec field
    // OpusEncoderConfig.complexity (W3C webcodecs-opus-codec-registration).
    if (typeof cfg.complexity === 'number' &&
        cfg.complexity >= 0 && cfg.complexity <= 10) {
      args.push('-compression_level', String(cfg.complexity | 0));
    }

    // Signal (MP-11) — OpusEncoderConfig.signal: 'auto' | 'voice' | 'music'.
    // libopus exposes this via OPUS_SET_SIGNAL_REQUEST, which FFmpeg's
    // libopus wrapper does NOT expose as a CLI option. We accept it for
    // spec compliance (the AudioEncoder.configure() validator allows
    // 'voice'/'music' through), but it has no effect on the encode —
    // libopus uses OPUS_AUTO. The closest functional equivalent
    // available is `-application`, which we wire separately above.
    // No flag emitted here; this comment is the contract documentation.

    return { kind: 'audio', preInput: [], args: args };
  },
  mp3: function (cfg) {
    var br = cfg.bitrate || 192000;
    return { kind: 'audio', preInput: [], args: ['-c:a', 'libmp3lame', '-b:a', String(Math.round(br / 1000)) + 'k'] };
  },
  flac: function (cfg) {
    var level = (typeof cfg.compressionLevel === 'number') ? cfg.compressionLevel : 5;
    return { kind: 'audio', preInput: [], args: ['-c:a', 'flac', '-compression_level', String(level)] };
  },
  vorbis: function (cfg) {
    var br = cfg.bitrate || 128000;
    return { kind: 'audio', preInput: [], args: ['-c:a', 'libvorbis', '-b:a', String(Math.round(br / 1000)) + 'k'] };
  },
  'g711-alaw': function (cfg) {
    _validateG711SampleRate(cfg, 'g711-alaw');
    return { kind: 'audio', preInput: [], args: ['-c:a', 'pcm_alaw', '-ar', '8000', '-ac', '1'] };
  },
  'g711-ulaw': function (cfg) {
    _validateG711SampleRate(cfg, 'g711-ulaw');
    return { kind: 'audio', preInput: [], args: ['-c:a', 'pcm_mulaw', '-ar', '8000', '-ac', '1'] };
  },
  alaw: function (cfg) {
    _validateG711SampleRate(cfg, 'alaw');
    return { kind: 'audio', preInput: [], args: ['-c:a', 'pcm_alaw', '-ar', '8000', '-ac', '1'] };
  },
  ulaw: function (cfg) {
    _validateG711SampleRate(cfg, 'ulaw');
    return { kind: 'audio', preInput: [], args: ['-c:a', 'pcm_mulaw', '-ar', '8000', '-ac', '1'] };
  },
  pcm: function (cfg) {
    var fmt = (cfg.format === 'f32' || cfg.format === 'f32le') ? 'pcm_f32le' : 'pcm_s16le';
    return { kind: 'audio', preInput: [], args: ['-c:a', fmt] };
  },
};

function getAudioCodec(name, cfg) {
  var key = String(name || '').toLowerCase();
  return AUDIO_CODECS[key] ? AUDIO_CODECS[key](cfg || {}) : null;
}

function getSupportedVideoCodecs() { return Object.keys(VIDEO_CODEC_META); }
function getSupportedAudioCodecs() { return Object.keys(AUDIO_CODECS); }

/**
 * Get full capabilities for a video codec — profile/level matrix
 * suitable for RTCRtpSender.getCapabilities().codecs[i].sdpFmtpLine
 * fan-out per W3C webrtc-pc §5.2.7. (MP-6)
 *
 * @param {string} name — 'vp8', 'vp9', 'av1', 'h264', 'h265'
 * @returns {{name, profiles: Array<{profile, level, codecString}>} | null}
 */
function getVideoCodecCapabilities(name) {
  if (!name) return null;
  var lower = String(name).toLowerCase();
  var meta = VIDEO_CODEC_META[lower];
  if (!meta) return null;
  return {
    name: lower,
    pixFmt: meta.pixFmt,
    fourcc: meta.fourcc || null,
    // Return a copy so callers can't mutate our static metadata.
    profiles: meta.profiles.map(function (p) {
      return Object.assign({}, p);
    }),
  };
}

/**
 * Same for audio. AAC has multiple object types; Opus has none.
 *
 * @param {string} name — 'opus', 'aac', 'mp3', 'flac', 'vorbis'
 * @returns {{name, profiles, sampleRates?, channels?} | null}
 */
function getAudioCodecCapabilities(name) {
  if (!name) return null;
  var lower = String(name).toLowerCase();
  var meta = AUDIO_CODEC_META[lower];
  if (!meta) return null;
  return {
    name: lower,
    profiles: meta.profiles.map(function (p) {
      return Object.assign({}, p);
    }),
    sampleRates: meta.sampleRates ? meta.sampleRates.slice() : null,
    channels: meta.channels ? meta.channels.slice() : null,
  };
}

/**
 * Aggregate: get all video codecs + their full profile/level matrix.
 * Equivalent to getSupportedVideoCodecs().map(getVideoCodecCapabilities).
 */
function getAllVideoCodecCapabilities() {
  return getSupportedVideoCodecs().map(getVideoCodecCapabilities);
}

function getAllAudioCodecCapabilities() {
  return getSupportedAudioCodecs().map(getAudioCodecCapabilities);
}

export {
  getVideoCodec, getAudioCodec,
  getSupportedVideoCodecs, getSupportedAudioCodecs,
  getVideoCodecCapabilities, getAudioCodecCapabilities,
  getAllVideoCodecCapabilities, getAllAudioCodecCapabilities,
};
