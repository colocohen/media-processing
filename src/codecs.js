/**
 * codecs — Codec registry with hardware acceleration + GPU upload filters.
 *
 * Each encoder returns { preInput: [...], args: [...] }
 *   preInput: FFmpeg args BEFORE -i (e.g. -init_hw_device)
 *   args:     FFmpeg args AFTER -map (codec, filters, quality)
 */

import { selectEncoder, registerEncoderArgs } from './hw_accel.js';
import { coderCodecAvailable } from './codec_availability.js';
import { cpus } from 'node:os';
import { enforceRange } from './core/webidl.js';

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

// libx264 / libx265: with -crf the encoder takes no -b:v at all (FFmpeg's
// libx264.c / libx265.c switch to CRF and drop the bitrate), so 'variable'
// with a bitrate was CRF alone: 1.37 Mb/s for a 640x360 test source
// whether 100 kb/s or 3 Mb/s was asked (measured, FFmpeg 8.0.1). The
// bitrate is now the VBV cap of the CRF (-maxrate, a 2 s -bufsize, as CBR's
// buffer): x264's / x265's capped CRF, the constrained quality libvpx and
// libaom get from -b:v with -crf.
function _addX26xRateCap(args, cfg) {
  var mode = cfg.bitrateMode || 'variable';
  if (mode === 'variable' && cfg.bitrate) {
    args.push('-maxrate', String(cfg.bitrate), '-bufsize', String(cfg.bitrate * 2));
  }
}

// ── libvpx (VP8 / VP9) ──
//
// Threads by the frame area, Chromium's GetNumberOfThreadsForSoftwareEncoding
// (media/base/video_encoder.cc; its VpxVideoEncoder gives it libvpx's
// g_threads): 1 under 640x480, 2 from it, 4 from 1280x720, 8 from
// 1920x1080, 16 from 3840x2160, never more than the cores. Every encoder
// took all the cores, which a machine running many small encodes (a
// simulcast ladder, an SFU's transcodes) pays for in thread overhead.
function _vpxThreads(cfg) {
  if (typeof cfg.threads === 'number') return cfg.threads;
  var area = (cfg.width || 0) * (cfg.height || 0);
  var t = area >= 3840 * 2160 ? 16 : area >= 1920 * 1080 ? 8 : area >= 1280 * 720 ? 4 : area >= 640 * 480 ? 2 : 1;
  return Math.min(t, getCpuCount());
}

// Temporal layers (WebCodecs scalabilityMode, W3C WebRTC-SVC L1T2 / L1T3)
// for real, on libvpx's temporal scalability: FFmpeg's -ts-parameters
// with its preset patterns (libvpxenc.c set_temporal_layer_pattern: mode
// 2, layers {0, 1}; mode 3, layers {0, 2, 1, 2}, each frame referencing
// only lower layers — the specification's figures), the layers'
// cumulative rates Chromium's (VpxVideoEncoder: 60 / 100 %, 50 / 70 /
// 100 % of the stream's kb/s; libvpx's default 256 with no bitrate), error
// resilient as Chromium and libwebrtc encode layers (a dropped frame must
// not carry entropy state the kept ones read). Key frames only by the
// usual rules: libvpx's own placement off (kf_min_dist = kf_max_dist, so
// no scene-cut key frame lands inside the pattern) and the gop forced
// instead — FFmpeg starts its pattern again at a forced key frame, not at
// one libvpx places. It was a key frame at every even frame and layer ids
// written over a stream that had no layers: twice the bytes, or more.
var _VPX_TEMPORAL = {
  L1T2: { layers: 2, mode: 2, pct: [60, 100] },
  L1T3: { layers: 3, mode: 3, pct: [50, 70, 100] },
};
function _vpxTemporalArgs(args, cfg) {
  var t = _VPX_TEMPORAL[cfg.scalabilityMode];
  if (!t) return false;
  var kbps = cfg.bitrate ? Math.round(cfg.bitrate / 1000) : 256;
  var rates = t.pct.map(function (p) { return Math.floor(p * kbps / 100); });
  var gi = args.indexOf('-g');
  if (gi >= 0) args.splice(gi, 2);
  args.push(
    '-g', '2147483647', '-keyint_min', '2147483647',
    '-force_key_frames', 'expr:eq(mod(n,' + (cfg.gopSize || 30) + '),0)',
    // ts_layering_mode last: it sets the pattern over the others
    '-ts-parameters', 'ts_number_layers=' + t.layers + ':ts_target_bitrate=' + rates.join(',') +
      ':ts_layering_mode=' + t.mode);
  return true;
}

var ENCODER_ARGS = {

  // ════════════════ H.264 ════════════════

  libx264: function (cfg) {
    var preset = cfg.latencyMode === 'quality' ? 'medium' : 'veryfast';
    var threads = (typeof cfg.threads === 'number') ? cfg.threads : getCpuCount();
    var profile = _ffmpegH264Profile(cfg.profile);
    var args = [
      '-c:v', 'libx264', '-threads', String(threads),
      '-preset', preset, '-tune', 'zerolatency',
      '-profile:v', profile,
      '-x264-params', 'repeat-headers=1:aud=1:scenecut=0:open_gop=0',
      '-g', String(cfg.gopSize || 30),
    ];
    // The codec string's level; for the short name 'h264' libx264's own
    // choice (the lowest that holds the size, rate and VBV — Annex A). It
    // was '3.1' for every short-name stream: a 1080p30 stream said level
    // 3.1 (x264 warns "frame MB size (120x68) > level limit (3600)" and
    // writes level_idc 31 anyway), and so did its decoderConfig.codec
    // ('avc1.42c01f'), which a decoder may hold it to.
    if (cfg.level) args.push('-level', cfg.level);
    _addBitrateArgs(args, cfg, 23);
    _addX26xRateCap(args, cfg);
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
    // FFmpeg passes -threads to x265 as --frame-threads, and that is NOT a
    // thread count in the usual sense:
    //   - x265 refuses more than 16 (X265_MAX_FRAME_THREADS). The default
    //     was the CPU count, so on any machine with more than 16 the
    //     encoder failed to open — H.265 did not work at all on a
    //     32-core host.
    //   - each frame thread is one more frame in flight: measured here,
    //     output lags input by (frame threads + 1) frames — 17 frames,
    //     ~570 ms at 30 fps, for -threads 16. -tune zerolatency sets
    //     frame-threads=1 precisely for that, and the -threads we passed
    //     overrode it.
    // Within a frame x265 still uses every core (WPP rows on its own
    // thread pool), so realtime takes 1 frame thread and quality — where
    // latency does not matter — up to the 16 x265 accepts.
    var threads = (typeof cfg.threads === 'number') ? cfg.threads
      : (cfg.latencyMode === 'quality' ? getCpuCount() : 1);
    if (threads > 16) threads = 16;
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
    _addX26xRateCap(args, cfg);
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
    var threads = _vpxThreads(cfg);
    var args = [
      '-c:v', 'libvpx',
      '-threads', String(threads),
      '-deadline', cfg.latencyMode === 'quality' ? 'good' : 'realtime',
      '-cpu-used', '8', '-lag-in-frames', '0', '-auto-alt-ref', '0',
      '-g', String(cfg.gopSize || 30),
    ];
    // bitrateMode as for VP9 (it was ignored here: '-b:v <bitrate> -crf
    // 10' in every mode, so 'constant' was libvpx's constrained quality,
    // not CBR, and 'quantizer' still capped the quality at the bitrate).
    _addBitrateArgs(args, cfg, 10);
    var layered = _vpxTemporalArgs(args, cfg);
    if (cfg.errorResilient || layered) args.push('-error-resilient', '1');
    return { preInput: [], args: args, temporalLayers: layered };
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
    var threads = _vpxThreads(cfg);

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
    var layered = _vpxTemporalArgs(args, cfg);
    if (cfg.errorResilient || layered) args.push('-error-resilient', '1');
    return { preInput: [], args: args, temporalLayers: layered };
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
      // Main 10's compatibility flags are flag[2] only (reversed: 4); '6'
      // (flags 1 and 2) claimed a Main 10 stream decodes as Main.
      { profile: 'main10', level: '4.0', codecString: 'hev1.2.4.L120.B0' },
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
  // G.711 (RFC 3551 §4.5.14): 8 kHz mono only. These had no entry, so
  // getAllAudioCodecCapabilities() returned null for every G.711 name.
  'g711-alaw': { profiles: [{ profile: '', codecString: 'alaw' }], sampleRates: [8000], channels: [1] },
  'g711-ulaw': { profiles: [{ profile: '', codecString: 'ulaw' }], sampleRates: [8000], channels: [1] },
  alaw:        { profiles: [{ profile: '', codecString: 'alaw' }], sampleRates: [8000], channels: [1] },
  ulaw:        { profiles: [{ profile: '', codecString: 'ulaw' }], sampleRates: [8000], channels: [1] },
  pcm:         { profiles: [{ profile: '', codecString: 'pcm-s16' }] },
};

// ═══════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════

// hw_accel's hardware probe runs each candidate with the arguments it
// will really get (hwupload filters, -init_hw_device, ...).
registerEncoderArgs(function (encoder, cfg) {
  var b = ENCODER_ARGS[encoder];
  return b ? b(cfg) : null;
});

function getVideoCodec(name, cfg) {
  if (!cfg) cfg = {};
  var codecKey = String(name || '').toLowerCase();
  var meta = VIDEO_CODEC_META[codecKey];
  if (!meta) return null;

  var preference = cfg.hardwareAcceleration || 'no-preference';
  // hw_accel test-encodes hardware candidates (and skips ones that
  // failed at run time) per ffmpeg path.
  var selected = selectEncoder(codecKey, preference, cfg.ffmpegPath);

  var argBuilder = ENCODER_ARGS[selected.encoder];
  if (!argBuilder) {
    selected = selectEncoder(codecKey, 'prefer-software', cfg.ffmpegPath);
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
    // The encoder layers L1T2 / L1T3 itself (libvpx): no forced key frames
    // for the pattern, which starts again at each key frame.
    temporalLayers: !!result.temporalLayers,
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

// OpusEncoderConfig.complexity when none is given (Opus registration §6.1).
var OPUS_DEFAULT_COMPLEXITY = 9;

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
    // (else: leave libopus's default, FEC off)
    // packetlossperc without FEC: the encoder still uses it (the Opus
    // registration's packetlossperc stands on its own; libopus' SILK and
    // CELT lower their inter-frame prediction for it). It was dropped
    // unless useinbandfec was on.
    if (!(cfg.useinbandfec === 1 || cfg.useinbandfec === true) && typeof cfg.packetlossperc === 'number') {
      args.push('-packet_loss', String(Math.max(0, Math.min(100, cfg.packetlossperc))));
    }

    // usedtx: discontinuous transmission. libopus -dtx 1.
    if (cfg.usedtx === 1 || cfg.usedtx === true) {
      args.push('-dtx', '1');
    } else if (cfg.usedtx === 0 || cfg.usedtx === false) {
      args.push('-dtx', '0');
    }

    // cbr: force constant bitrate (vs VBR default). The W3C
    // AudioEncoderConfig.bitrateMode 'constant' means the same and was
    // ignored (29 distinct packet sizes at 'constant', as at 'variable');
    // an explicit cbr (SDP fmtp) still decides.
    var wantCbr = (cfg.cbr === undefined || cfg.cbr === null) ? (cfg.bitrateMode === 'constant') : cfg.cbr;
    if (wantCbr === 1 || wantCbr === true) {
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
    // Higher = better quality but more CPU. Maps to FFmpeg's
    // -compression_level. Spec field OpusEncoderConfig.complexity (W3C
    // webcodecs-opus-codec-registration §6.1): without one, "User Agents
    // SHOULD set a default of 5 for mobile platforms, and a default of 9
    // for all other platforms" — FFmpeg's own default is 10.
    if (typeof cfg.complexity === 'number' &&
        cfg.complexity >= 0 && cfg.complexity <= 10) {
      args.push('-compression_level', String(cfg.complexity | 0));
    } else {
      args.push('-compression_level', String(OPUS_DEFAULT_COMPLEXITY));
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

// ═══════════════════════════════════════════
// WebCodecs configurations (W3C WebCodecs §7, the codec registrations)
// ═══════════════════════════════════════════
//
// What the four WebCodecs classes share for configure() and
// isConfigSupported(): the WebIDL conversion of the config dictionaries
// (enum members and [EnforceRange] integers are TypeErrors), the
// "valid config" checks of §7.5-7.8 (TypeErrors too), and "Check
// Configuration Support" (§7.1): a valid codec string per its
// registration, and a codec that can do the exact profile / bit depth /
// chroma the string names, at the configured size, rate and channels.
//
// These were missing. isConfigSupported() answered from the codec's
// short name alone (any 'avc1.*' was supported, also 'avc1.FF000b'; a
// config with width 0 or codec '' resolved instead of rejecting with a
// TypeError), and configure() took any codec: 'foo' failed only at the
// first encode(), with an Error through the error callback and the
// coder left "configured". Unsupported now means: isConfigSupported()
// resolves { supported: false }; configure() closes the coder with a
// NotSupportedError, asynchronously (the spec's configure control
// message).
//
// The library's short names ('h264', 'h265', 'vp9', 'av1', 'aac' —
// ambiguous about profile and level, so not WebCodecs codec strings) stay
// accepted as an extension, with the codec's defaults; so do 'pcm',
// 'g711-alaw' and 'g711-ulaw' (the encoders' raw outputs). Every other
// string must be a registration's exact form (case and whitespace
// included: 'vP8' and ' vp8' are not 'vp8').

var _H264_PROFILE_IDCS = [66, 77, 88, 100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135];
var _H264_LEVEL_IDCS = [9, 10, 11, 12, 13, 20, 21, 22, 30, 31, 32, 40, 41, 42, 50, 51, 52, 60, 61, 62];
var _HEVC_LEVEL_IDCS = [30, 60, 63, 90, 93, 120, 123, 150, 153, 156, 180, 183, 186];
var _VP9_LEVELS = [10, 11, 20, 21, 30, 31, 40, 41, 50, 51, 52, 60, 61, 62];
var _AAC_STRINGS = { 'mp4a.40.2': 2, 'mp4a.40.02': 2, 'mp4a.40.5': 5, 'mp4a.40.05': 5,
  'mp4a.40.29': 29, 'mp4a.40.42': 42, 'mp4a.67': 0x67 };
var _MP3_STRINGS = { 'mp3': 1, 'mp4a.69': 1, 'mp4a.6B': 1, 'mp4a.40.34': 1 };
var _PCM_STRINGS = { 'pcm-u8': 1, 'pcm-s16': 1, 'pcm-s24': 1, 'pcm-s32': 1, 'pcm-f32': 1 };
var _PLAIN_AUDIO = { opus: 1, flac: 1, vorbis: 1, ulaw: 1, alaw: 1 };
var _SHORT_NAMES = { h264: 1, h265: 1, vp9: 1, av1: 1, aac: 1, pcm: 1, 'g711-alaw': 1, 'g711-ulaw': 1 };
// ISO/IEC 23091-2 code points (VP9 / AV1 codec strings' colour fields).
var _COLOUR_PRIMARIES = [1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 22];
var _TRANSFER = [1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
var _MATRIX = [0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

function _num2(s) { return parseInt(s, 10); }

/**
 * A WebCodecs codec string read per its registration, or null when it
 * is not one (nor one of the library's short names).
 *   { name, short, profile, level, bitDepth, chroma, objectType }
 * name: the short name the rest of the library uses (normalizeCodec's).
 * chroma: '420' | '422' | '444' | 'mono' where the string says.
 */
function parseWebCodecsCodec(codec) {
  if (typeof codec !== 'string') return null;
  var s = codec;
  var info = { name: null, short: false, profile: null, level: null, bitDepth: null, chroma: null, objectType: null };
  if (_SHORT_NAMES[s]) { info.name = s; info.short = true; return info; }
  if (s === 'vp8') { info.name = 'vp8'; return info; }
  if (_PLAIN_AUDIO[s] || _PCM_STRINGS[s]) { info.name = s; return info; }
  if (_MP3_STRINGS[s]) { info.name = 'mp3'; return info; }
  if (Object.prototype.hasOwnProperty.call(_AAC_STRINGS, s)) {
    info.name = 'aac'; info.objectType = _AAC_STRINGS[s]; return info;
  }
  var m;
  // AVC: avc1.PPCCLL / avc3.PPCCLL (RFC 6381 §3.4, 14496-15 §5.4.1).
  if ((m = /^avc[13]\.([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})$/.exec(s))) {
    var p = parseInt(m[1], 16), c = parseInt(m[2], 16), l = parseInt(m[3], 16);
    if (_H264_PROFILE_IDCS.indexOf(p) < 0 || (c & 0x03) || _H264_LEVEL_IDCS.indexOf(l) < 0) return null;
    info.name = 'h264'; info.profile = p; info.level = l; info.constraints = c;
    info.bitDepth = (p === 110 || p === 122 || p === 244 || p === 44) ? null : 8;
    info.chroma = (p === 122) ? '422' : (p === 244 || p === 44) ? '444' : (p === 110 || p === 100 || p === 66 || p === 77 || p === 88) ? '420' : null;
    return info;
  }
  // HEVC: hev1./hvc1.[A-C]?profile.compat.(L|H)level(.constraint){0,6}
  // (14496-15 Annex E.3).
  if ((m = /^(?:hev1|hvc1)\.([ABC]?)(\d{1,2})\.([0-9A-Fa-f]{1,8})\.([LH])(\d{1,3})((?:\.[0-9A-Fa-f]{1,2}){0,6})$/.exec(s))) {
    var hp = _num2(m[2]), hl = _num2(m[5]);
    if (hp > 31 || _HEVC_LEVEL_IDCS.indexOf(hl) < 0) return null;
    info.name = 'h265'; info.profile = hp; info.level = hl; info.tier = m[4];
    info.profileSpace = m[1] || '';
    return info;
  }
  // VP9: vp09.PP.LL.DD[.CC[.cp[.tc[.mc[.FF]]]]] (VP9-ISOBMFF "Codecs
  // Parameter String"): two digits each.
  if ((m = /^vp09\.(\d{2})\.(\d{2})\.(\d{2})((?:\.\d{2}){0,5})$/.exec(s))) {
    var vp = _num2(m[1]), vl = _num2(m[2]), vd = _num2(m[3]);
    var rest = m[4] ? m[4].slice(1).split('.').map(_num2) : [];
    if (vp > 3 || _VP9_LEVELS.indexOf(vl) < 0 || [8, 10, 12].indexOf(vd) < 0) return null;
    if (vp < 2 && vd !== 8) return null;          // profiles 0 / 1: 8 bit
    if (vp >= 2 && vd === 8) return null;         // profiles 2 / 3: 10 / 12 bit
    var cc = rest.length > 0 ? rest[0] : 1;       // default 4:2:0 (colocated)
    if (cc > 3) return null;
    if ((vp === 0 || vp === 2) && cc > 1) return null;   // 4:2:0 only
    if ((vp === 1 || vp === 3) && cc < 2) return null;   // 4:2:2 / 4:4:0 / 4:4:4
    if (rest.length > 1 && _COLOUR_PRIMARIES.indexOf(rest[1]) < 0) return null;
    if (rest.length > 2 && _TRANSFER.indexOf(rest[2]) < 0) return null;
    if (rest.length > 3 && _MATRIX.indexOf(rest[3]) < 0) return null;
    if (rest.length > 4 && rest[4] > 1) return null;
    info.name = 'vp9'; info.profile = vp; info.level = vl; info.bitDepth = vd;
    info.chroma = cc <= 1 ? '420' : cc === 2 ? '422' : '444';
    return info;
  }
  // AV1: av01.P.LLT.DD[.M[.CCC[.cp[.tc[.mc[.F]]]]]] (AV1-ISOBMFF §5).
  if ((m = /^av01\.(\d)\.(\d{2})([MH])\.(\d{2})(?:\.(\d)(?:\.(\d{3})(?:\.(\d{2})(?:\.(\d{2})(?:\.(\d{2})(?:\.(\d))?)?)?)?)?)?$/.exec(s))) {
    var ap = _num2(m[1]), al = _num2(m[2]), ad = _num2(m[4]);
    if (ap > 2 || (al > 23 && al !== 31) || [8, 10, 12].indexOf(ad) < 0) return null;
    if (m[3] === 'H' && al < 8) return null;      // seq_tier only above level 3.3
    if (ad === 12 && ap !== 2) return null;       // 12 bit: Professional
    var mono = m[5] !== undefined ? _num2(m[5]) : 0;
    if (mono > 1 || (mono && ap === 1)) return null;
    // Professional at 8 / 10 bits is 4:2:2 or mono (AV1 §5.5.2
    // color_config: subsampling_x = 1, subsampling_y = 0 unless 12-bit):
    // its default subsampling is 4:2:2, as High's is 4:4:4. It took 4:2:0
    // ('av01.2.08M.10' parsed as a 10-bit 4:2:0 stream, which no
    // profile-2 sequence header can describe).
    var cs = m[6] !== undefined ? m[6] : (mono ? '111' : (ap === 1 ? '000' : (ap === 2 && ad !== 12) ? '100' : '110'));
    if (['110', '111', '112', '100', '000'].indexOf(cs) < 0) return null;
    if (ap === 0 && cs.slice(0, 2) !== '11') return null;   // Main: 4:2:0 / mono
    if (ap === 1 && cs !== '000') return null;               // High: 4:4:4
    if (ap === 2 && ad !== 12 && !mono && cs !== '100') return null;   // Professional 8 / 10 bit: 4:2:2
    if (mono && cs.slice(0, 2) !== '11') return null;
    if (m[7] !== undefined && _COLOUR_PRIMARIES.indexOf(_num2(m[7])) < 0) return null;
    if (m[8] !== undefined && _TRANSFER.indexOf(_num2(m[8])) < 0) return null;
    if (m[9] !== undefined && _MATRIX.indexOf(_num2(m[9])) < 0) return null;
    if (m[10] !== undefined && _num2(m[10]) > 1) return null;
    info.name = 'av1'; info.profile = ap; info.level = al; info.bitDepth = ad;
    info.chroma = mono ? 'mono' : cs === '000' ? '444' : cs === '100' ? '422' : '420';
    return info;
  }
  return null;
}

// What the FFmpeg codecs here can do. Encoders get yuv420p (8-bit
// 4:2:0: VideoEncoder's -pix_fmt) — a 10-bit, 4:2:2 or 4:4:4 profile
// would be encoded as something else; libx264 / libx265 need even
// sizes in 4:2:0. FFmpeg's own AAC encoder is LC only (an HE-AAC string
// came out as LC labelled 'mp4a.40.5'); libopus takes its five rates
// and, with the default mapping, up to 8 channels.
var _ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
var CONFIG_CAPS = {
  videoEncoder: {
    vp8:  { maxSize: 16383 },
    vp9:  { profiles: [0], bitDepths: [8], chroma: ['420'], maxSize: 65536 },
    av1:  { profiles: [0], bitDepths: [8], chroma: ['420'], maxSize: 65536 },
    h264: { profiles: [66, 77, 100], bitDepths: [8], chroma: ['420'], maxSize: 16384, even: true },
    h265: { profiles: [1], bitDepths: [8], chroma: ['420'], maxSize: 16384, even: true },
  },
  videoDecoder: {
    vp8:  {},
    vp9:  { profiles: [0, 1, 2, 3] },
    av1:  { profiles: [0, 1, 2] },
    h264: { profiles: [66, 77, 88, 100, 110, 122, 244, 44] },
    h265: { profiles: [1, 2, 3, 4] },
  },
  audioEncoder: {
    // AAC: the channel counts an ADTS channel configuration names (ISO/IEC
    // 14496-3 Table 1.19: 1-6 and 8). FFmpeg's aac encodes 7 (6.1) with a
    // PCE in the bitstream (channel configuration 0), but the description
    // made from the ADTS header is then '1180' — channelConfiguration 0
    // without the program_config_element its GASpecificConfig must carry
    // (§4.4.1): not a valid AudioSpecificConfig. Supported said yes.
    aac:  { objectTypes: [2], sampleRates: _ADTS_RATES, channels: [1, 2, 3, 4, 5, 6, 8] },
    opus: { sampleRates: [8000, 12000, 16000, 24000, 48000], maxChannels: 8 },
    mp3:  { sampleRates: [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000], maxChannels: 2 },
    flac: { maxRate: 655350, maxChannels: 8 },
    vorbis: { maxChannels: 8 },
    'g711-alaw': {}, 'g711-ulaw': {}, alaw: {}, ulaw: {}, pcm: {},
  },
  audioDecoder: {
    aac:  { objectTypes: [2, 5, 29, 0x67] },
    opus: { maxChannels: 255 },
    mp3: {}, flac: { needsDescription: true }, vorbis: { needsDescription: true },
    alaw: {}, ulaw: {}, 'g711-alaw': {}, 'g711-ulaw': {},
    'pcm-u8': {}, 'pcm-s16': {}, 'pcm-s24': {}, 'pcm-s32': {}, 'pcm-f32': {},
  },
};

var SCALABILITY_MODES = ['L1T1', 'L1T2', 'L1T3'];

function _videoCaps(caps, info) {
  if (!caps) return false;
  if (info.profile !== null && caps.profiles && caps.profiles.indexOf(info.profile) < 0) return false;
  if (info.bitDepth !== null && caps.bitDepths && caps.bitDepths.indexOf(info.bitDepth) < 0) return false;
  if (info.chroma !== null && caps.chroma && caps.chroma.indexOf(info.chroma) < 0) return false;
  // A profile whose bit depth / chroma the string leaves open (H.264
  // High 10 and up) is the profile's, not 8-bit 4:2:0.
  if (info.name === 'h264' && info.profile !== null && caps.bitDepths && info.bitDepth === null) return false;
  return true;
}

/** Check Configuration Support for a (valid) VideoEncoderConfig. */
function videoEncoderConfigSupported(config) {
  var info = parseWebCodecsCodec(config.codec);
  if (!info) return false;
  var caps = CONFIG_CAPS.videoEncoder[info.name];
  if (!_videoCaps(caps, info)) return false;
  if (config.width > caps.maxSize || config.height > caps.maxSize) return false;
  if (caps.even && ((config.width & 1) || (config.height & 1))) return false;
  if (config.scalabilityMode !== undefined && SCALABILITY_MODES.indexOf(config.scalabilityMode) < 0) return false;
  if (config.alpha === 'keep') return false;      // no alpha side data from FFmpeg
  var v;
  try { v = getVideoCodec(info.name, config); } catch (e) { return false; }
  if (!v) return false;
  // The encoder has to be in this FFmpeg (see _inThisFFmpeg). A hardware
  // encoder selectEncoder picked has passed its test encode.
  return v.isHardware || _inThisFFmpeg('video', 'encode', info.name);
}

// Check Configuration Support (WebCodecs §7.1): "If the User Agent can
// provide a codec to support all entries of the config ... return true";
// the tables above say what the library has arguments for, not what the
// FFmpeg on this machine was built with. A build without libx265 answered
// isConfigSupported() supported: true for H.265 and failed at the first
// frame (EncodingError); configure() now closes with NotSupportedError, as
// for any unsupported config. Unknown (raw PCM, an FFmpeg whose listing
// could not be read) keeps the table's answer; no FFmpeg at all is false.
function _inThisFFmpeg(kind, way, name) {
  return coderCodecAvailable(kind, way, name) !== false;
}

/** Check Configuration Support for a (valid) VideoDecoderConfig. */
function videoDecoderConfigSupported(config, descriptionOk) {
  var info = parseWebCodecsCodec(config.codec);
  if (!info) return false;
  var caps = CONFIG_CAPS.videoDecoder[info.name];
  if (!_videoCaps(caps, info)) return false;
  return descriptionOk !== false && _inThisFFmpeg('video', 'decode', info.name);
}

/**
 * Whether the audio encoder of a codec (its short name) takes this sample
 * rate and channel count; an undefined one is not checked
 * (MediaCapabilities' optional members).
 */
function audioEncoderCapsAllow(name, sampleRate, channels) {
  var caps = CONFIG_CAPS.audioEncoder[name];
  if (!caps) return false;
  if (sampleRate !== undefined) {
    if (caps.sampleRates && caps.sampleRates.indexOf(sampleRate) < 0) return false;
    if (caps.maxRate && sampleRate > caps.maxRate) return false;
  }
  if (channels !== undefined) {
    if (caps.maxChannels && channels > caps.maxChannels) return false;
    if (caps.channels && caps.channels.indexOf(channels) < 0) return false;
  }
  return true;
}

/** Check Configuration Support for a (valid) AudioEncoderConfig. */
function audioEncoderConfigSupported(config) {
  var info = parseWebCodecsCodec(config.codec);
  if (!info) return false;
  var caps = CONFIG_CAPS.audioEncoder[info.name];
  if (!caps) return false;
  if (info.objectType !== null && caps.objectTypes && caps.objectTypes.indexOf(info.objectType) < 0) return false;
  if (!audioEncoderCapsAllow(info.name, config.sampleRate, config.numberOfChannels)) return false;
  if (info.name === 'opus' && config.opus && config.opus.format === 'ogg') return false;   // raw packets only
  try { if (!getAudioCodec(info.name, config)) return false; } catch (e) { return false; }
  return _inThisFFmpeg('audio', 'encode', info.name);
}

/** Check Configuration Support for a (valid) AudioDecoderConfig. */
function audioDecoderConfigSupported(config, descriptionOk) {
  if (!audioDecoderCodecSupported(config.codec, config.numberOfChannels)) return false;
  var caps = CONFIG_CAPS.audioDecoder[parseWebCodecsCodec(config.codec).name];
  if (caps.needsDescription && !config.description) return false;
  return descriptionOk !== false;
}

/**
 * The part of audioDecoderConfigSupported that is the codec's, not one
 * stream's: the codec string, the channel count (undefined: not checked)
 * and this FFmpeg — what MediaCapabilities.decodingInfo asks (it has no
 * description: a FLAC or Vorbis stream carries its own).
 */
function audioDecoderCodecSupported(codec, numberOfChannels) {
  var info = parseWebCodecsCodec(codec);
  if (!info) return false;
  var caps = CONFIG_CAPS.audioDecoder[info.name];
  if (!caps) return false;
  if (info.objectType !== null && caps.objectTypes && caps.objectTypes.indexOf(info.objectType) < 0) return false;
  if (caps.maxChannels && numberOfChannels > caps.maxChannels) return false;
  return _inThisFFmpeg('audio', 'decode', info.name);
}

// ── WebIDL conversion and validity ──
//
// A dictionary's members are converted in lexicographic order (WebIDL
// §3.2.17), the first bad one throws. Each entry: [member, kind, arg].
//   'enum' (arg: values), 'ul' ([EnforceRange] unsigned long), 'ull'
//   (unsigned long long), 'req' (required, any value), 'dict' (arg: a
//   nested entry list).
var _HW = ['no-preference', 'prefer-hardware', 'prefer-software'];
var VIDEO_ENCODER_CONFIG_IDL = [
  ['alpha', 'enum', ['keep', 'discard']],
  ['avc', 'dict', [['format', 'enum', ['annexb', 'avc']]]],
  ['bitrate', 'ull'],
  ['bitrateMode', 'enum', ['constant', 'variable', 'quantizer']],
  ['codec', 'req'],
  ['displayHeight', 'ul'],
  ['displayWidth', 'ul'],
  ['hardwareAcceleration', 'enum', _HW],
  ['height', 'ul', 'req'],
  ['hevc', 'dict', [['format', 'enum', ['annexb', 'hevc']]]],
  ['latencyMode', 'enum', ['quality', 'realtime']],
  ['width', 'ul', 'req'],
];
var VIDEO_DECODER_CONFIG_IDL = [
  ['codec', 'req'],
  ['codedHeight', 'ul'],
  ['codedWidth', 'ul'],
  ['displayAspectHeight', 'ul'],
  ['displayAspectWidth', 'ul'],
  ['hardwareAcceleration', 'enum', _HW],
];
var AUDIO_ENCODER_CONFIG_IDL = [
  ['aac', 'dict', [['format', 'enum', ['aac', 'adts']]]],
  ['bitrate', 'ull'],
  ['bitrateMode', 'enum', ['constant', 'variable']],
  ['codec', 'req'],
  ['numberOfChannels', 'ul', 'req'],
  ['opus', 'dict', [
    ['application', 'enum', ['voip', 'audio', 'lowdelay']],
    ['complexity', 'ul'],
    ['format', 'enum', ['opus', 'ogg']],
    ['frameDuration', 'ull'],
    ['packetlossperc', 'ul'],
    ['signal', 'enum', ['auto', 'music', 'voice']],
  ]],
  ['sampleRate', 'ul', 'req'],
];
var AUDIO_DECODER_CONFIG_IDL = [
  ['codec', 'req'],
  ['numberOfChannels', 'ul', 'req'],
  ['sampleRate', 'ul', 'req'],
];

var _RANGE = { ul: 'unsigned long', ull: 'unsigned long long' };

function _quoteList(values) {
  return values.map(function (v) { return "'" + v + "'"; }).join(' or ');
}

/** WebIDL-convert `config` per `idl`: a converted copy, or throws a TypeError. */
function _convertDict(config, idl, prefix, path) {
  var out = {};
  for (var k in config) if (Object.prototype.hasOwnProperty.call(config, k)) out[k] = config[k];
  for (var i = 0; i < idl.length; i++) {
    var name = idl[i][0], kind = idl[i][1], arg = idl[i][2];
    var v = config[name];
    var what = path + name;
    if (v === undefined) {
      if (kind === 'req' || arg === 'req') throw new TypeError(prefix + ': ' + what + ' required');
      continue;
    }
    if (kind === 'enum') {
      var sv = String(v);
      if (arg.indexOf(sv) < 0) throw new TypeError(prefix + ': ' + what + ' must be ' + _quoteList(arg) + " (got '" + sv + "')");
      out[name] = sv;
    } else if (kind === 'ul' || kind === 'ull') {
      out[name] = enforceRange(v, _RANGE[kind], prefix + ': ' + what);
    } else if (kind === 'dict') {
      if (v === null || typeof v !== 'object') {
        if (v === null) continue;   // null is an empty dictionary
        throw new TypeError(prefix + ': ' + what + ' must be a dictionary');
      }
      out[name] = _convertDict(v, arg, prefix, what + '.');
    } else if (kind === 'req') {
      out[name] = String(v);
    }
  }
  return out;
}

// "codec is empty after stripping leading and trailing ASCII whitespace"
function _emptyCodec(codec) { return String(codec).replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '') === ''; }

var _OPUS_FRAME_DURATIONS = [2500, 5000, 10000, 20000, 40000, 60000];

/**
 * The WebIDL conversion + "valid VideoEncoderConfig" (§7.8): the
 * converted config, or throws the TypeError. `prefix`: the method
 * ('VideoEncoder.configure', 'VideoEncoder.isConfigSupported').
 */
function checkVideoEncoderConfig(config, prefix) {
  if (!config || typeof config !== 'object') throw new TypeError(prefix + ': config required');
  var c = _convertDict(config, VIDEO_ENCODER_CONFIG_IDL, prefix, '');
  if (_emptyCodec(c.codec)) throw new TypeError(prefix + ': codec required');
  if (c.width === 0 || c.height === 0) throw new TypeError(prefix + ': width and height must not be 0');
  if (c.displayWidth === 0 || c.displayHeight === 0) throw new TypeError(prefix + ': displayWidth and displayHeight must not be 0');
  if (c.bitrate === 0) throw new TypeError(prefix + ': bitrate must not be 0');
  return c;
}

// "If config.description is [detached], return false" (valid
// VideoDecoderConfig / AudioDecoderConfig): a transferred ArrayBuffer, or
// a view on one, is a TypeError. It went on as an empty description.
function _detached(d) {
  if (d === undefined || d === null) return false;
  var b = (d instanceof ArrayBuffer) ? d : (ArrayBuffer.isView(d) ? d.buffer : null);
  return !!(b && b instanceof ArrayBuffer && b.detached === true);
}

/** Conversion + "valid VideoDecoderConfig" (§7.6). */
function checkVideoDecoderConfig(config, prefix) {
  if (!config || typeof config !== 'object') throw new TypeError(prefix + ': config required');
  var c = _convertDict(config, VIDEO_DECODER_CONFIG_IDL, prefix, '');
  if (_emptyCodec(c.codec)) throw new TypeError(prefix + ': codec required');
  if ((c.codedWidth === undefined) !== (c.codedHeight === undefined)) throw new TypeError(prefix + ': codedWidth and codedHeight must be given together');
  if (c.codedWidth === 0 || c.codedHeight === 0) throw new TypeError(prefix + ': codedWidth and codedHeight must not be 0');
  if ((c.displayAspectWidth === undefined) !== (c.displayAspectHeight === undefined)) throw new TypeError(prefix + ': displayAspectWidth and displayAspectHeight must be given together');
  if (c.displayAspectWidth === 0 || c.displayAspectHeight === 0) throw new TypeError(prefix + ': displayAspectWidth and displayAspectHeight must not be 0');
  if (_detached(c.description)) throw new TypeError(prefix + ': description is detached');
  return c;
}

/** Conversion + "valid AudioEncoderConfig" (§7.7), with the Opus registration's checks. */
function checkAudioEncoderConfig(config, prefix) {
  if (!config || typeof config !== 'object') throw new TypeError(prefix + ': config required');
  var c = _convertDict(config, AUDIO_ENCODER_CONFIG_IDL, prefix, '');
  if (_emptyCodec(c.codec)) throw new TypeError(prefix + ': codec required');
  // A codec-specific extension of the config's own codec whose
  // registration has validity steps decides alone — §7.7 step 2 returns
  // their result (Opus registration §6.1, "check if an OpusEncoderConfig
  // is valid"; frameDuration's default 20000 is valid).
  if (c.codec === 'opus' && c.opus) {
    var o = c.opus;
    if (o.frameDuration !== undefined && _OPUS_FRAME_DURATIONS.indexOf(o.frameDuration) < 0) {
      throw new TypeError(prefix + ': opus.frameDuration must be one of ' + _OPUS_FRAME_DURATIONS.join(', ') + ' µs (got ' + o.frameDuration + ')');
    }
    if (o.complexity !== undefined && o.complexity > 10) throw new TypeError(prefix + ': opus.complexity must be 0..10 (got ' + o.complexity + ')');
    if (o.packetlossperc !== undefined && o.packetlossperc > 100) throw new TypeError(prefix + ': opus.packetlossperc must be 0..100 (got ' + o.packetlossperc + ')');
    return c;
  }
  if (c.sampleRate === 0 || c.numberOfChannels === 0) throw new TypeError(prefix + ': sampleRate and numberOfChannels must not be 0');
  return c;
}

/** Conversion + "valid AudioDecoderConfig" (§7.5). */
function checkAudioDecoderConfig(config, prefix) {
  if (!config || typeof config !== 'object') throw new TypeError(prefix + ': config required');
  var c = _convertDict(config, AUDIO_DECODER_CONFIG_IDL, prefix, '');
  if (_emptyCodec(c.codec)) throw new TypeError(prefix + ': codec required');
  if (c.sampleRate === 0 || c.numberOfChannels === 0) throw new TypeError(prefix + ': sampleRate and numberOfChannels must not be 0');
  if (_detached(c.description)) throw new TypeError(prefix + ': description is detached');
  return c;
}

export {
  OPUS_DEFAULT_COMPLEXITY,
  parseWebCodecsCodec, CONFIG_CAPS, SCALABILITY_MODES,
  videoEncoderConfigSupported, videoDecoderConfigSupported,
  audioEncoderConfigSupported, audioDecoderConfigSupported, audioDecoderCodecSupported, audioEncoderCapsAllow,
  checkVideoEncoderConfig, checkVideoDecoderConfig, checkAudioEncoderConfig, checkAudioDecoderConfig,
  getVideoCodec, getAudioCodec,
  getSupportedVideoCodecs, getSupportedAudioCodecs,
  getVideoCodecCapabilities, getAudioCodecCapabilities,
  getAllVideoCodecCapabilities, getAllAudioCodecCapabilities,
};
