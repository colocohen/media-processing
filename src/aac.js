/**
 * aac — AAC/ADTS header parsing helpers.
 *
 * Pure parsing logic — no FFmpeg, no I/O. Used by:
 *   - reader_adts.js  to extract sample rate, profile, channels from each
 *                     ADTS frame's header
 *   - reader_ts.js    same, when AAC is carried over MPEG-TS
 *
 * The ADTS header (ISO/IEC 14496-3 §1.A.2.2.1) is 7 bytes (or 9 with
 * CRC). Layout:
 *
 *   syncword(12)               — 0xFFF
 *   ID(1) | layer(2) | prot_absent(1)
 *   profile(2) | sampling_freq_index(4) | private_bit(1) | channel_config(3-hi)
 *   channel_config(3-lo) | original(1) | home(1) | copyright_id(1) |
 *     copyright_start(1) | frame_length(13-hi)
 *   frame_length(13-mid)
 *   frame_length(13-lo) | adts_buffer_fullness(11-hi)
 *   adts_buffer_fullness(11-lo) | num_raw_data_blocks_in_frame(2)
 *
 * The sample rate is encoded as a 4-bit index into a fixed table.
 * Note: for HE-AAC (SBR), the index reflects the CORE sample rate
 * (half of the actual output rate); the SBR decoder upsamples at
 * playout. Frame duration = 1024 / encoded_sample_rate is correct
 * regardless of HE-AAC vs LC: the same wall-clock interval, just
 * fewer or more output samples after SBR.
 */


// Sampling frequency index table (ISO/IEC 14496-3 §1.6.3.4).
// Entries 13-15 are reserved.
var ADTS_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000,
  24000, 22050, 16000, 12000, 11025,  8000,
   7350,     0,     0,     0,
];

// Profile field maps to MPEG-4 audio object type (object_type = profile + 1).
// HE-AAC is signaled implicitly via SBR within an LC stream — it doesn't
// have its own ADTS profile value.
var ADTS_PROFILES = [
  'main',    // object_type 1 = MAIN
  'lc',      // object_type 2 = LC (most common)
  'ssr',     // object_type 3 = SSR (rarely used)
  null,      // 3 = reserved in ADTS
];


/**
 * Parse a 7+ byte buffer starting at an ADTS sync word.
 * Returns null if the buffer doesn't look like an ADTS header.
 *
 * @param  {Buffer|Uint8Array} buf  At least 7 bytes starting at the sync.
 * @returns {{
 *   sampleRate: number,        // resolved from sample_freq_index, 0 if reserved
 *   sampleFreqIndex: number,   // raw 4-bit field
 *   profile: string|null,      // 'main' | 'lc' | 'ssr' | null
 *   channels: number,          // 1..7 (0 = "specified by program config")
 *   frameLength: number,       // bytes including ADTS header
 *   protectionAbsent: boolean, // false = 9-byte header (with CRC)
 *   samplesPerFrame: number,   // 1024 (AAC frame size — invariant in ADTS)
 * }|null}
 */
function parseAdtsHeader(buf) {
  if (!buf || buf.length < 7) return null;
  // Sync: 12 bits 0xFFF
  if (buf[0] !== 0xFF || (buf[1] & 0xF0) !== 0xF0) return null;

  var protectionAbsent = !!(buf[1] & 0x01);

  var profile = (buf[2] >> 6) & 0x03;
  var sampleFreqIndex = (buf[2] >> 2) & 0x0F;
  // private_bit at buf[2] bit 1 — ignored for our purposes.
  // channel_config: 1 bit in buf[2] | 2 bits in buf[3]
  var channels = ((buf[2] & 0x01) << 2) | ((buf[3] >> 6) & 0x03);

  // frame_length: 13 bits across buf[3] (low 2) | buf[4] | buf[5] (top 3)
  var frameLength = ((buf[3] & 0x03) << 11) | (buf[4] << 3) | ((buf[5] >> 5) & 0x07);

  return {
    sampleRate:       ADTS_SAMPLE_RATES[sampleFreqIndex] || 0,
    sampleFreqIndex:  sampleFreqIndex,
    profile:          ADTS_PROFILES[profile] || null,
    channels:         channels,
    frameLength:      frameLength,
    protectionAbsent: protectionAbsent,
    // AAC frame size is invariant at 1024 samples (per encoded sample
    // rate). The 960-sample variant exists in the spec but is rarely
    // seen in ADTS streams; both Windows AAC decoder and FFmpeg's
    // built-in encoder emit 1024.
    samplesPerFrame:  1024,
  };
}


/**
 * Compute the playout duration of an AAC ADTS frame, in microseconds.
 * Reads sampleRate from the ADTS header — does NOT trust caller's
 * configured sample rate, which may not match the actual stream.
 *
 * @returns {number} duration in µs, or 0 if header is invalid
 */
function getAdtsFrameDurationUs(buf) {
  var info = parseAdtsHeader(buf);
  if (!info || !info.sampleRate) return 0;
  return Math.floor(info.samplesPerFrame * 1000000 / info.sampleRate);
}


export { parseAdtsHeader, getAdtsFrameDurationUs, ADTS_SAMPLE_RATES };
