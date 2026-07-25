/**
 * audio_level.js — RFC 6464 audio-level helpers (ROADMAP RTP-5).
 *
 * Pure computation over a WebCodecs AudioData; no I/O. The WebRTC
 * framing (header-extension bytes) lives in rtp-packet — this module
 * only answers "how loud is this frame".
 *
 * Unblocked by MP-1: copyTo() now honors {format} conversion, so we
 * can always read normalized f32 samples regardless of source format.
 */

/**
 * RMS of the frame, 0..1 (all channels pooled).
 * @param {AudioData} audioData
 * @returns {number}
 */
export function computeAudioRms(audioData) {
  if (!audioData || typeof audioData.copyTo !== 'function') return 0;
  var frames = audioData.numberOfFrames || 0;
  var channels = audioData.numberOfChannels || 1;
  var n = frames * channels;
  if (n <= 0) return 0;
  var buf = new Float32Array(n);
  try {
    // Interleaved f32 covers every channel in plane 0.
    audioData.copyTo(buf, { planeIndex: 0, format: 'f32' });
  } catch (e) {
    return 0;
  }
  var sum = 0;
  for (var i = 0; i < n; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / n);
}

/**
 * RFC 6464 §3 level: 0 = loudest (0 dBov), 127 = silence (-127 dBov).
 * dBov = 20*log10(rms) for full-scale-relative samples.
 * @param {AudioData} audioData
 * @returns {number} 0..127
 */
export function computeAudioDbov(audioData) {
  var rms = computeAudioRms(audioData);
  if (rms <= 0) return 127;
  var db = 20 * Math.log10(rms);          // ≤ 0 for rms ≤ 1
  var level = Math.round(-db);
  if (level < 0) level = 0;
  if (level > 127) level = 127;
  return level;
}
