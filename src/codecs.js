/**
 * codecs — Codec registry with hardware acceleration + GPU upload filters.
 *
 * Each encoder returns { preInput: [...], args: [...] }
 *   preInput: FFmpeg args BEFORE -i (e.g. -init_hw_device)
 *   args:     FFmpeg args AFTER -map (codec, filters, quality)
 */

import { selectEncoder } from './hw_accel.js';
import { cpus } from 'node:os';

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
    var profile = cfg.profile || 'baseline';
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
    var profile = cfg.profile || 'main';
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

var VIDEO_CODEC_META = {
  vp8:  { pixFmt: 'yuv420p', fourcc: 'VP80' },
  vp9:  { pixFmt: 'yuv420p', fourcc: 'VP90' },
  av1:  { pixFmt: 'yuv420p', fourcc: 'AV01' },
  h264: { pixFmt: 'yuv420p' },
  h265: { pixFmt: 'yuv420p' },
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

var AUDIO_CODECS = {
  aac: function (cfg) {
    var br = cfg.bitrate || 128000;
    return { kind: 'audio', preInput: [], args: ['-c:a', 'aac', '-b:a', String(Math.round(br / 1000)) + 'k'] };
  },
  opus: function (cfg) {
    var br = cfg.bitrate || 64000;
    return { kind: 'audio', preInput: [], args: ['-c:a', 'libopus', '-b:a', String(Math.round(br / 1000)) + 'k'] };
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
  'g711-alaw': function () {
    return { kind: 'audio', preInput: [], args: ['-c:a', 'pcm_alaw', '-ar', '8000', '-ac', '1'] };
  },
  'g711-ulaw': function () {
    return { kind: 'audio', preInput: [], args: ['-c:a', 'pcm_mulaw', '-ar', '8000', '-ac', '1'] };
  },
  alaw: function () {
    return { kind: 'audio', preInput: [], args: ['-c:a', 'pcm_alaw', '-ar', '8000', '-ac', '1'] };
  },
  ulaw: function () {
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

export { getVideoCodec, getAudioCodec, getSupportedVideoCodecs, getSupportedAudioCodecs };
