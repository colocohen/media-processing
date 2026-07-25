/**
 * hw_accel — Detect available hardware encoders from FFmpeg.
 *
 * Runs `ffmpeg -encoders` once, caches the result.
 * Maps codec + platform → best hardware encoder.
 */

import { execSync } from 'node:child_process';
import { platform } from 'node:os';

var _cache = null;

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
 * Query FFmpeg for available encoders. Cached after first call.
 * Returns Set of encoder names.
 */
function getAvailableEncoders(ffmpegPath) {
  if (_cache) return _cache;

  var encoders = new Set();
  try {
    var out = execSync((ffmpegPath || 'ffmpeg') + ' -encoders -hide_banner 2>&1', {
      timeout: 10000,
      encoding: 'utf8',
    });
    var lines = out.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      // Format: " V....D encoder_name   Description"
      // First char: V=video, A=audio, S=subtitle
      var match = line.match(/^\s*[VAS][.\w]+\s+(\S+)/);
      if (match) {
        encoders.add(match[1]);
      }
    }
  } catch (e) {
    // FFmpeg not available or failed
  }

  _cache = encoders;
  return encoders;
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

  // prefer-hardware: try GPU encoders, fallback to software
  var hwCandidates = HW_ENCODERS[codecKey];
  if (hwCandidates) {
    var available = getAvailableEncoders(ffmpegPath);
    var plat = platform();

    for (var i = 0; i < hwCandidates.length; i++) {
      var hw = hwCandidates[i];
      if (hw.platforms.indexOf(plat) >= 0 && available.has(hw.name)) {
        return { encoder: hw.name, isHardware: true };
      }
    }
  }

  // No hardware found — fallback to software
  return { encoder: swEncoder, isHardware: false };
}

/**
 * Get a summary of available hardware acceleration.
 * Useful for diagnostics.
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
    var hw = [];
    var candidates = HW_ENCODERS[codec];
    for (var j = 0; j < candidates.length; j++) {
      if (candidates[j].platforms.indexOf(plat) >= 0 && available.has(candidates[j].name)) {
        hw.push(candidates[j].name);
      }
    }
    result.encoders[codec] = {
      software: SW_ENCODERS[codec],
      hardware: hw,
      hasHardware: hw.length > 0,
    };
  }

  return result;
}

/**
 * Clear the cache (useful for testing).
 */
function resetCache() {
  _cache = null;
}

export { selectEncoder, getAvailableEncoders, getHardwareAccelerationInfo, resetCache, SW_ENCODERS };
