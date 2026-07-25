/**
 * aac-utils — Pure functions for AAC ADTS header parsing and building.
 *
 * Browser-side port of media-processing's aac.js, plus the inverse
 * (build) direction. AudioEncoder in WebCodecs emits raw AAC frames
 * with no container — for MPEG-TS we need to wrap them in ADTS, the
 * format reader_ts.js (and FFmpeg, and every TS demuxer) expects.
 *
 * The ADTS header (ISO/IEC 14496-3 §1.A.2.2.1) is 7 bytes (or 9 with
 * CRC). Layout:
 *
 *   syncword(12)               — 0xFFF
 *   ID(1) | layer(2) | prot_absent(1)
 *   profile(2) | sampling_freq_index(4) | private(1) | channel_cfg(3-hi)
 *   channel_cfg(3-lo) | original(1) | home(1) | copyright_id(1) |
 *     copyright_start(1) | frame_length(13-hi)
 *   frame_length(13-mid)
 *   frame_length(13-lo) | adts_buffer_fullness(11-hi)
 *   adts_buffer_fullness(11-lo) | num_raw_data_blocks_in_frame(2)
 *
 * We always write 7-byte headers (no CRC) — matches FFmpeg, and the
 * CRC field is rarely validated by demuxers.
 */

import { concat } from '../core/bytes.js';

// Sampling frequency index table (ISO/IEC 14496-3 §1.6.3.4).
// Indices 13-15 are reserved.
export var ADTS_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000,
  24000, 22050, 16000, 12000, 11025,  8000,
   7350,     0,     0,     0,
];

// ADTS profile field (2 bits) → MPEG-4 audio object type (= profile + 1).
// HE-AAC is signaled implicitly via SBR within an LC stream — it doesn't
// have its own ADTS profile value, and AudioEncoder produces LC by default.
var ADTS_PROFILES = ['main', 'lc', 'ssr', null];

// Reverse map: profile string → 2-bit ADTS field
var PROFILE_TO_FIELD = { main: 0, lc: 1, ssr: 2 };


/**
 * Parse a 7+ byte buffer starting at an ADTS sync word.
 * Returns null if the buffer doesn't look like an ADTS header.
 *
 * Mirrors media-processing's parseAdtsHeader, working on Uint8Array.
 */
export function parseAdtsHeader(buf) {
  if (!buf || buf.length < 7) return null;
  if (buf[0] !== 0xFF || (buf[1] & 0xF0) !== 0xF0) return null;

  var protectionAbsent = !!(buf[1] & 0x01);
  var profile = (buf[2] >> 6) & 0x03;
  var sampleFreqIndex = (buf[2] >> 2) & 0x0F;
  var channels = ((buf[2] & 0x01) << 2) | ((buf[3] >> 6) & 0x03);
  var frameLength = ((buf[3] & 0x03) << 11) | (buf[4] << 3) | ((buf[5] >> 5) & 0x07);

  return {
    sampleRate:       ADTS_SAMPLE_RATES[sampleFreqIndex] || 0,
    sampleFreqIndex:  sampleFreqIndex,
    profile:          ADTS_PROFILES[profile] || null,
    channels:         channels,
    frameLength:      frameLength,
    protectionAbsent: protectionAbsent,
    samplesPerFrame:  1024,
  };
}


/**
 * Look up the 4-bit ADTS sample frequency index for a given rate.
 * Returns -1 if the rate isn't in the standard table — caller should
 * decide whether to throw or fall back to a default.
 */
export function sampleRateToIndex(sampleRate) {
  for (var i = 0; i < ADTS_SAMPLE_RATES.length; i++) {
    if (ADTS_SAMPLE_RATES[i] === sampleRate) return i;
  }
  return -1;
}


/**
 * Build a 2-byte MPEG-4 AudioSpecificConfig (ASC) for AAC.
 *
 * This is the AAC analogue of an AVCDecoderConfigurationRecord. The
 * WebCodecs browser AudioEncoder surfaces it as
 * EncodedAudioChunkMetadata.decoderConfig.description on the first
 * encoded chunk; the fMP4 writer needs it to build the `esds` box.
 * ADTS streams carry these parameters inline (so TS doesn't need it),
 * but raw AAC in MP4 does.
 *
 * Layout (16 bits, MSB first):
 *   audioObjectType        5 bits  (LC = 2)
 *   samplingFrequencyIndex 4 bits  (ADTS table index)
 *   channelConfiguration   4 bits
 *   frameLengthFlag        1 bit   (0 = 1024 samples)
 *   dependsOnCoreCoder     1 bit   (0)
 *   extensionFlag          1 bit   (0)
 *
 * @param {object} opts
 * @param {string|number} [opts.profile='lc']  'main'|'lc'|'ssr' or 0..2
 * @param {number} opts.sampleRate  one of the ADTS table values
 * @param {number} opts.channels    1..7
 * @returns {Uint8Array}  exactly 2 bytes
 */
export function buildAudioSpecificConfig(opts) {
  var profileField = (typeof opts.profile === 'number')
    ? opts.profile
    : PROFILE_TO_FIELD[opts.profile || 'lc'];
  if (profileField === undefined || profileField === null) profileField = 1; // LC
  var aot = profileField + 1;  // MPEG-4 audio object type = ADTS profile field + 1

  var freqIdx = sampleRateToIndex(opts.sampleRate);
  if (freqIdx < 0) {
    throw new Error('buildAudioSpecificConfig: unsupported sampleRate ' + opts.sampleRate);
  }
  var chan = opts.channels;

  // 5 + 4 + 4 + 3(flags=0) = 16 bits.
  var value = (aot << 11) | (freqIdx << 7) | (chan << 3);
  return new Uint8Array([(value >> 8) & 0xFF, value & 0xFF]);
}


/**
 * Build a 7-byte ADTS header.
 *
 * @param {object} opts
 * @param {string|number} [opts.profile='lc']
 *   'main' | 'lc' | 'ssr', or 0..2. Defaults to LC — what AudioEncoder
 *   produces by default and what the vast majority of streams use.
 *
 * @param {number} opts.sampleRate
 *   One of the ADTS table values (8000..96000).
 *
 * @param {number} opts.channels
 *   1..7. Channel config 0 ("specified by program config") is invalid
 *   for our use since we always know the layout.
 *
 * @param {number} opts.frameLength
 *   Total frame size in bytes INCLUDING the 7-byte ADTS header.
 *   Caller's responsibility — needs to be baked into the header per
 *   spec so the demuxer can find the next sync word.
 *
 * @returns {Uint8Array}  exactly 7 bytes
 */
export function buildAdtsHeader(opts) {
  var profileField;
  if (typeof opts.profile === 'number') {
    profileField = opts.profile & 0x03;
  } else {
    profileField = PROFILE_TO_FIELD[opts.profile || 'lc'];
    if (profileField === undefined) profileField = 1;  // LC fallback
  }

  var sampleFreqIndex = sampleRateToIndex(opts.sampleRate);
  if (sampleFreqIndex < 0) {
    throw new Error('aac-utils: unsupported sample rate ' + opts.sampleRate);
  }

  var channels = opts.channels & 0x07;
  var frameLength = opts.frameLength & 0x1FFF;  // 13-bit field

  var h = new Uint8Array(7);

  // Byte 0: syncword high (0xFF — top 8 bits of the 12-bit syncword)
  h[0] = 0xFF;

  // Byte 1: syncword low (4 bits = 0xF) | MPEG version ID (1 bit,
  // 0=MPEG-4, 1=MPEG-2) | layer (2 bits, must be 0) | protection_absent
  // (1 bit, 1 = no CRC). 0xF1 = 1111 000 1 → **MPEG-4** + no CRC —
  // the form FFmpeg writes and every demuxer accepts. (MPEG-2 would
  // be 0xF9; an earlier comment here said "MPEG-2" — the CODE was
  // always right, the comment was inverted.)
  h[1] = 0xF1;

  // Byte 2: profile(2) | sample_freq_index(4) | private(1, 0) |
  //         channels-high-bit(1)
  h[2] = (profileField << 6) |
         ((sampleFreqIndex & 0x0F) << 2) |
         ((channels >> 2) & 0x01);

  // Byte 3: channels-low-2bits(2) | original(1, 0) | home(1, 0) |
  //         copyright_id(1, 0) | copyright_start(1, 0) |
  //         frame_length-high-2bits(2)
  h[3] = ((channels & 0x03) << 6) | ((frameLength >> 11) & 0x03);

  // Byte 4: frame_length-mid-8bits
  h[4] = (frameLength >> 3) & 0xFF;

  // Byte 5: frame_length-low-3bits(3) | adts_buffer_fullness-high(5).
  // We set buffer_fullness to all-1s (0x7FF), the standard "VBR /
  // unspecified" sentinel. Top 5 bits of 0x7FF = 0x1F.
  h[5] = ((frameLength & 0x07) << 5) | 0x1F;

  // Byte 6: adts_buffer_fullness-low(6) | num_raw_data_blocks_in_frame(2).
  // Low 6 bits of 0x7FF = 0x3F → shifted left 2 = 0xFC. num_blocks = 0
  // means "one AAC raw_data_block per ADTS frame", the standard case.
  h[6] = 0xFC;

  return h;
}


/**
 * Compute the playout duration of an AAC ADTS frame, in microseconds.
 * Reads sampleRate from the ADTS header — does NOT trust caller's
 * configured sample rate, which may not match the actual stream.
 * Mirrors media-processing's getAdtsFrameDurationUs.
 *
 * @returns {number} duration in µs, or 0 if header is invalid
 */
export function getAdtsFrameDurationUs(buf) {
  var info = parseAdtsHeader(buf);
  if (!info || !info.sampleRate) return 0;
  return Math.floor(info.samplesPerFrame * 1000000 / info.sampleRate);
}


/**
 * Wrap a raw AAC frame in an ADTS header. The frame_length field is
 * computed automatically as 7 + payload.length.
 *
 * Call once per AudioEncoder output to produce a TS-ready ADTS frame.
 */
export function wrapAdts(rawAac, opts) {
  var header = buildAdtsHeader({
    profile: opts.profile,
    sampleRate: opts.sampleRate,
    channels: opts.channels,
    frameLength: 7 + rawAac.length,
  });
  return concat([header, rawAac]);
}
