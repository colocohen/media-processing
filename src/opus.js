/**
 * opus — Opus codec packet parsing helpers (RFC 6716).
 *
 * Pure parsing logic — no FFmpeg, no I/O. Used by:
 *   - reader_ogg.js     to compute correct PTS per Opus packet
 *   - audio_decoder.js  (future) to advance timestamps without container
 *   - any caller that has raw Opus packets and needs timing info
 *
 * The Opus TOC (Table of Contents) byte (RFC 6716 §3.1) is the first
 * byte of every Opus packet. It encodes:
 *   - config (5 bits): codec mode + bandwidth + frame duration
 *   - s (1 bit):       stereo flag
 *   - c (2 bits):      packet code (1 frame / 2 same / 2 diff / arbitrary)
 *
 * From these we can derive the packet's playout duration without needing
 * any encoder state or container metadata.
 */


// ── Frame duration tables (RFC 6716 §3.1, Table 2) ─────────────────
//
// Configurations 0..31 partition into three ranges by codec mode:
//
//   config 0..11   SILK     — frame sizes cycle 10/20/40/60 ms (config & 3)
//   config 12..15  Hybrid   — frame sizes cycle 10/20 ms       (config & 1)
//   config 16..31  CELT     — frame sizes cycle 2.5/5/10/20 ms (config & 3)
//
// Values are in microseconds (all exact integers — 2.5ms = 2500us).

var SILK_FRAME_US   = [10000, 20000, 40000, 60000];
var HYBRID_FRAME_US = [10000, 20000];
var CELT_FRAME_US   = [ 2500,  5000, 10000, 20000];


/**
 * Compute the playout duration of an Opus packet, in microseconds.
 * Honors the TOC byte (frame size from `config`, frame count from `c`).
 *
 * For code=3 (arbitrary frame count), reads the frame count from byte 1
 * per RFC 6716 §3.2.5. The count occupies the low 6 bits of that byte;
 * the high 2 bits are VBR/padding flags which don't affect duration.
 *
 * Returns 20000 (20ms) as a safe default if the packet is missing or
 * empty — that matches Chrome's WebRTC default and avoids divide-by-
 * zero downstream.
 *
 * @param  {Buffer|Uint8Array} packet  Raw Opus packet (TOC byte + payload)
 * @returns {number}                   Playout duration in microseconds
 */
function getOpusPacketDurationUs(packet) {
  if (!packet || packet.length < 1) return 20000;

  var toc    = packet[0];
  var config = (toc >> 3) & 0x1F;  // bits 7..3
  var code   = toc & 0x03;          // bits 1..0

  // Frame duration per configuration
  var frameDurUs;
  if (config < 12) {
    frameDurUs = SILK_FRAME_US[config & 3];
  } else if (config < 16) {
    frameDurUs = HYBRID_FRAME_US[config & 1];
  } else {
    frameDurUs = CELT_FRAME_US[config & 3];
  }

  // Number of frames in this packet (RFC 6716 §3.2)
  var numFrames;
  if (code === 0) {
    numFrames = 1;                                  // single frame
  } else if (code === 1 || code === 2) {
    numFrames = 2;                                  // two frames
  } else {
    // Code 3 — arbitrary frame count in byte 1 (low 6 bits).
    // If truncated, fall back to single-frame estimate; if zero
    // (encoder violated spec), treat as one frame.
    if (packet.length < 2) return frameDurUs;
    numFrames = packet[1] & 0x3F;
    if (numFrames === 0) numFrames = 1;
  }

  return frameDurUs * numFrames;
}


/**
 * Parse the Opus TOC byte into structured fields.
 * Useful for debugging or for callers that need finer-grained info
 * than just the duration (e.g. to detect bandwidth changes).
 *
 * @param  {Buffer|Uint8Array} packet
 * @returns {{config:number, mode:string, bandwidth:string, frameDurUs:number, stereo:boolean, code:number}|null}
 *          null if packet is missing or empty
 */
function parseOpusToc(packet) {
  if (!packet || packet.length < 1) return null;

  var toc    = packet[0];
  var config = (toc >> 3) & 0x1F;
  var stereo = !!((toc >> 2) & 0x01);
  var code   = toc & 0x03;

  var mode, bandwidth, frameDurUs;
  if (config < 4)        { mode = 'silk';   bandwidth = 'narrowband';      frameDurUs = SILK_FRAME_US[config & 3]; }
  else if (config < 8)   { mode = 'silk';   bandwidth = 'mediumband';      frameDurUs = SILK_FRAME_US[config & 3]; }
  else if (config < 12)  { mode = 'silk';   bandwidth = 'wideband';        frameDurUs = SILK_FRAME_US[config & 3]; }
  else if (config < 14)  { mode = 'hybrid'; bandwidth = 'super-wideband';  frameDurUs = HYBRID_FRAME_US[config & 1]; }
  else if (config < 16)  { mode = 'hybrid'; bandwidth = 'fullband';        frameDurUs = HYBRID_FRAME_US[config & 1]; }
  else if (config < 20)  { mode = 'celt';   bandwidth = 'narrowband';      frameDurUs = CELT_FRAME_US[config & 3]; }
  else if (config < 24)  { mode = 'celt';   bandwidth = 'wideband';        frameDurUs = CELT_FRAME_US[config & 3]; }
  else if (config < 28)  { mode = 'celt';   bandwidth = 'super-wideband';  frameDurUs = CELT_FRAME_US[config & 3]; }
  else                   { mode = 'celt';   bandwidth = 'fullband';        frameDurUs = CELT_FRAME_US[config & 3]; }

  return {
    config:     config,
    mode:       mode,
    bandwidth:  bandwidth,
    frameDurUs: frameDurUs,
    stereo:     stereo,
    code:       code,
  };
}


export { getOpusPacketDurationUs, parseOpusToc };
