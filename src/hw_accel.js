/**
 * hw_accel — Detect WORKING hardware encoders from FFmpeg.
 *
 * `ffmpeg -encoders` only says what the build was compiled with: a
 * stock Linux FFmpeg lists h264_nvenc, h264_qsv and h264_vaapi on a box
 * with no NVIDIA driver, no Intel media driver and no /dev/dri at all.
 * Selecting by that listing picked h264_nvenc, which died on every
 * start ("Cannot load libcuda.so.1"), fell back to libx264, and was
 * tried again on every keyframe restart (C11). So a hardware encoder is
 * used only after a one-frame test encode with it succeeded; results are
 * cached per ffmpeg path, and an encoder that later fails at run time is
 * remembered as failed (markEncoderFailed).
 */

import { spawnSync } from 'node:child_process';
import { platform } from 'node:os';

// Per ffmpeg path: Set of listed encoder names. Keyed by path: a cache
// shared by every path answered a later query for the system ffmpeg
// with whatever the first path returned (an empty set for a bad path) (C13).
var _listCache = new Map();
// Per ffmpeg path: Map encoderName → true (test encode worked) / false.
var _verifyCache = new Map();

// Builds the arguments the encoder is really run with (codecs.js
// ENCODER_ARGS), so the probe tests the same hwupload / device setup.
// Registered by codecs.js (it imports this module, so no import back).
var _argsBuilder = null;

function registerEncoderArgs(fn) { _argsBuilder = (typeof fn === 'function') ? fn : null; }

function _key(ffmpegPath) { return ffmpegPath || 'ffmpeg'; }

/**
 * Hardware encoder variants per codec, ordered by preference.
 * Each entry: { name: FFmpeg encoder name, platforms: [...] }
 */
var HW_ENCODERS = {
  h264: [
    { name: 'h264_nvenc',         platforms: ['win32', 'linux'] },
    { name: 'h264_videotoolbox',  platforms: ['darwin'] },
    { name: 'h264_qsv',          platforms: ['win32', 'linux'] },
    { name: 'h264_vaapi',        platforms: ['linux'] },
    { name: 'h264_amf',          platforms: ['win32'] },
  ],
  h265: [
    { name: 'hevc_nvenc',         platforms: ['win32', 'linux'] },
    { name: 'hevc_videotoolbox',  platforms: ['darwin'] },
    { name: 'hevc_qsv',          platforms: ['win32', 'linux'] },
    { name: 'hevc_vaapi',        platforms: ['linux'] },
    { name: 'hevc_amf',          platforms: ['win32'] },
  ],
  vp8: [
    { name: 'vp8_vaapi',         platforms: ['linux'] },
    { name: 'vp8_qsv',           platforms: ['linux'] },
  ],
  vp9: [
    { name: 'vp9_vaapi',         platforms: ['linux'] },
    { name: 'vp9_qsv',           platforms: ['win32', 'linux'] },
  ],
  av1: [
    { name: 'av1_nvenc',          platforms: ['win32', 'linux'] },
    { name: 'av1_qsv',           platforms: ['win32', 'linux'] },
    { name: 'av1_vaapi',         platforms: ['linux'] },
    { name: 'av1_amf',           platforms: ['win32'] },
  ],
};

/**
 * Software encoder names (fallback).
 */
var SW_ENCODERS = {
  h264: 'libx264',
  h265: 'libx265',
  vp8:  'libvpx',
  vp9:  'libvpx-vp9',
  av1:  'libaom-av1',
  aac:  'aac',
  opus: 'libopus',
  mp3:  'libmp3lame',
  flac: 'flac',
  vorbis: 'libvorbis',
};

/**
 * Query FFmpeg for the encoders its build includes. Cached per ffmpeg
 * path. Returns a Set of encoder names. Listing only — see
 * verifyEncoder for whether one actually works.
 */
function getAvailableEncoders(ffmpegPath) {
  var key = _key(ffmpegPath);
  if (_listCache.has(key)) return _listCache.get(key);

  var encoders = new Set();
  try {
    // argv, no shell (the path is caller input).
    var r = spawnSync(key, ['-hide_banner', '-encoders'], { timeout: 10000, encoding: 'utf8' });
    var out = String(r.stdout || '') + '\n' + String(r.stderr || '');
    var lines = out.split('\n');
    var inList = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      // The legend above the list (" V..... = Video") matched the
      // pattern too and added '=' as an encoder; the list starts after
      // the " ------" separator.
      if (/^\s*-{3,}\s*$/.test(line)) { inList = true; continue; }
      if (!inList) continue;
      // Format: " V....D encoder_name   Description"
      // First char: V=video, A=audio, S=subtitle
      var match = line.match(/^\s*[VAS][.\w]{5}\s+(\S+)/);
      if (match) encoders.add(match[1]);
    }
  } catch (e) {
    // FFmpeg not available or failed
  }

  // An empty listing (ffmpeg missing / timed out) is not cached: the
  // next call tries again.
  if (encoders.size) _listCache.set(key, encoders);
  return encoders;
}

/**
 * Whether `encoder` really encodes here: one 256x256 yuv420p frame piped
 * in as rawvideo — the way VideoEncoder feeds it — with the encoder's
 * own arguments, to a null muxer. Cached per (ffmpeg path, encoder).
 * Blocks for the probe's duration (tens to a few hundred ms) once per
 * encoder per process.
 */
function verifyEncoder(encoder, ffmpegPath) {
  var key = _key(ffmpegPath);
  var map = _verifyCache.get(key);
  if (!map) { map = new Map(); _verifyCache.set(key, map); }
  if (map.has(encoder)) return map.get(encoder);

  var ok = false;
  if (getAvailableEncoders(key).has(encoder)) {
    var W = 256, H = 256;
    var built = null;
    try { built = _argsBuilder ? _argsBuilder(encoder, { width: W, height: H, framerate: 30, bitrate: 500000 }) : null; } catch (e) { built = null; }
    var preInput = (built && built.preInput) || [];
    var encArgs = (built && built.args) || ['-c:v', encoder];
    var args = ['-hide_banner', '-loglevel', 'error', '-nostdin']
      .concat(preInput, [
        '-f', 'rawvideo', '-pixel_format', 'yuv420p', '-video_size', W + 'x' + H,
        '-framerate', '30', '-i', 'pipe:0',
      ], encArgs, ['-frames:v', '1', '-f', 'null', '-']);
    var frame = Buffer.alloc(W * H * 3 / 2, 128);
    try {
      var r = spawnSync(key, args, { input: frame, timeout: 15000, stdio: ['pipe', 'ignore', 'pipe'] });
      ok = !r.error && r.status === 0;
    } catch (e) {
      ok = false;
    }
  }
  map.set(encoder, ok);
  return ok;
}

/**
 * Remember that `encoder` failed at run time (VideoEncoder's hardware
 * fallback), so the next selection skips it instead of retrying it on
 * every keyframe restart.
 */
function markEncoderFailed(encoder, ffmpegPath) {
  var key = _key(ffmpegPath);
  var map = _verifyCache.get(key);
  if (!map) { map = new Map(); _verifyCache.set(key, map); }
  map.set(encoder, false);
}

/** Verified hardware encoders for a codec on this platform, in preference order. */
function _workingHardware(codecKey, ffmpegPath) {
  var hwCandidates = HW_ENCODERS[codecKey] || [];
  var plat = platform();
  var out = [];
  for (var i = 0; i < hwCandidates.length; i++) {
    var hw = hwCandidates[i];
    if (hw.platforms.indexOf(plat) < 0) continue;
    if (verifyEncoder(hw.name, ffmpegPath)) out.push(hw.name);
  }
  return out;
}

/**
 * Select the best encoder for a codec based on hardwareAcceleration preference.
 *
 * @param {string} codec — 'h264', 'h265', 'vp9', etc.
 * @param {string} preference — 'no-preference', 'prefer-hardware', 'prefer-software'
 * @param {string} [ffmpegPath]
 * @returns {{ encoder: string, isHardware: boolean }}
 */
function selectEncoder(codec, preference, ffmpegPath) {
  var codecKey = String(codec).toLowerCase();
  var swEncoder = SW_ENCODERS[codecKey];
  if (!swEncoder) return { encoder: codecKey, isHardware: false };

  // Only try hardware when explicitly requested.
  // 'no-preference' defaults to software because hardware encoders
  // don't always work correctly with pipe-based I/O (our architecture).
  // The browser can use 'no-preference' = try hardware because it uses
  // shared GPU memory. We use child process pipes, so software is safer.
  if (preference !== 'prefer-hardware') {
    return { encoder: swEncoder, isHardware: false };
  }

  // prefer-hardware: the first hardware encoder that passed a test
  // encode and has not failed since; otherwise software.
  var hw = _workingHardware(codecKey, ffmpegPath);
  if (hw.length) return { encoder: hw[0], isHardware: true };

  // No working hardware — fallback to software
  return { encoder: swEncoder, isHardware: false };
}

/**
 * Get a summary of hardware acceleration. Useful for diagnostics.
 *   hardware     encoders that passed a test encode (and did not fail since)
 *   listed       hardware encoders the FFmpeg build includes
 *   hasHardware  hardware.length > 0
 * Test-encodes every listed candidate (once per process).
 */
function getHardwareAccelerationInfo(ffmpegPath) {
  var available = getAvailableEncoders(ffmpegPath);
  var plat = platform();
  var result = {
    platform: plat,
    encoders: {},
  };

  var codecs = Object.keys(HW_ENCODERS);
  for (var i = 0; i < codecs.length; i++) {
    var codec = codecs[i];
    var listed = [];
    var candidates = HW_ENCODERS[codec];
    for (var j = 0; j < candidates.length; j++) {
      if (candidates[j].platforms.indexOf(plat) >= 0 && available.has(candidates[j].name)) {
        listed.push(candidates[j].name);
      }
    }
    var hw = _workingHardware(codec, ffmpegPath);
    result.encoders[codec] = {
      software: SW_ENCODERS[codec],
      hardware: hw,
      listed: listed,
      hasHardware: hw.length > 0,
    };
  }

  return result;
}

/**
 * Clear the caches (useful for testing).
 */
function resetCache() {
  _listCache.clear();
  _verifyCache.clear();
}

export {
  selectEncoder, getAvailableEncoders, getHardwareAccelerationInfo, resetCache, SW_ENCODERS,
  verifyEncoder, markEncoderFailed, registerEncoderArgs,
};
