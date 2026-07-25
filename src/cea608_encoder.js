// CEA-608 / EIA-608 Closed Captions Encoder.
//
// CEA-608 is the legacy NTSC line-21 closed-caption format. Despite
// its age, it's still the de-facto standard for HLS closed captions
// in 2026 — it's mandated by FCC for broadcast, supported natively
// by every major player (Safari, hls.js, ExoPlayer, AVPlayer), and
// CEA-708 (the modern HD format) is required by spec to ALSO carry
// a CEA-608 backwards-compat stream alongside it.
//
// Wire format:
//   - Captions are encoded as 2-byte pairs ("byte pairs")
//   - Pairs are packed into "cc_data" triples in a SEI message that
//     rides along inside H.264/H.265 video streams
//   - One triple per video frame at NTSC rates (≈30fps/60fps); the
//     CC clock runs at 60Hz, so 60fps gets 1 triple/frame and 30fps
//     gets 2 triples/frame (we emit 1 to keep things simple)
//   - Each character has a parity bit set to give it odd parity
//
// Reference: CEA-608-E, Apple HLS authoring guide §10.
//
// We implement the "pop-on" caption mode: a hidden buffer is filled
// with the caption text, then revealed all at once with EOC. This
// matches how subtitle files are typically authored (cue-in/cue-out)
// and gives players a clean transition between cues.
//
// Lifecycle:
//   - Caller adds caption cues with start/end seconds and text
//   - Each cue is decomposed into a sequence of byte pairs:
//       RCL, ENM, PAC, [text...], EOC  (at cue start)
//       EDM                             (at cue end)
//   - The byte-pair queue is drained one pair per video frame
//   - getCcDataForFrame(ptsUs) returns the cc_data triples for the
//     given frame's PTS; consumer wraps in SEI and injects into AU

// ── CEA-608 Control Codes (Channel 1) ─────────────────────────
// All channel-1 control codes start with 0x14. Channel 2 uses 0x1C.
// (Channels 3 & 4 live in NTSC field 2 — different cc_type — and
// we don't generate them here.)
//
// We use only the subset needed for pop-on captions. Other codes
// (BS, DER, RU2-4, FON, RDC, TR, RTD, CR) are referenced in the
// CEA-608 spec but not used in our output, so they're elided.
var CTRL = 0x14;             // Channel 1 control code prefix
var CTRL_CH2 = 0x1C;         // Channel 2 control code prefix
var RCL  = 0x20;             // Resume Caption Loading (start of pop-on)
var EDM  = 0x2C;             // Erase Displayed Memory
var ENM  = 0x2E;             // Erase Non-displayed Memory
var EOC  = 0x2F;             // End Of Caption (swap memories — display)

/**
 * Add odd-parity bit to a 7-bit byte. CEA-608 requires every byte
 * (including control codes) to have odd parity over the low 7 bits.
 * The high bit (bit 7) is the parity bit and is REPLACED — not OR'd —
 * with whatever value makes the total number of 1-bits odd.
 */
function _withParity(b) {
  var v = b & 0x7F;
  var ones = 0;
  for (var i = 0; i < 7; i++) {
    if (v & (1 << i)) ones++;
  }
  // Set bit 7 so total 1-count is odd
  return v | ((ones & 1) ? 0 : 0x80);
}

// Preamble Address Code (PAC) lookup table. PAC positions the cursor
// at a row with optional styling. We use the simplest case: row N,
// indent 0, plain white text. Format is two bytes:
//   byte 1: 0x10..0x17 (channel-encoded)
//   byte 2: 0x40 or 0x60 (style: no underline / underline; we always
//           use the no-underline form)
//
// The mapping from row 1..15 is irregular (CEA-608-E Annex C, Table 4):
// historical accident of the 608 encoding, not derivable from row index.
//
// Index 0 unused; rows are 1-based. Row 15 used for any out-of-range
// input (defensive — caller controls the range so this is unreachable
// in practice).
var _PAC_TABLE = [
  null,                  // unused (row 0 invalid)
  [0x11, 0x40],          // row 1
  [0x11, 0x60],          // row 2
  [0x12, 0x40],          // row 3
  [0x12, 0x60],          // row 4
  [0x15, 0x40],          // row 5
  [0x15, 0x60],          // row 6
  [0x16, 0x40],          // row 7
  [0x16, 0x60],          // row 8
  [0x17, 0x40],          // row 9
  [0x17, 0x60],          // row 10
  [0x10, 0x40],          // row 11
  [0x13, 0x40],          // row 12
  [0x13, 0x60],          // row 13
  [0x14, 0x40],          // row 14
  [0x14, 0x60],          // row 15
];

/**
 * Build a Preamble Address Code byte pair for the given row (1..15),
 * channel-1, indent 0, plain white text. Out-of-range rows clamp to
 * row 15.
 *
 * Ref: CEA-608-E Annex C, Table 4.
 */
function _pacForRow(row) {
  var entry = (row >= 1 && row <= 15) ? _PAC_TABLE[row] : _PAC_TABLE[15];
  return [_withParity(entry[0]), _withParity(entry[1])];
}

// CEA-608 Extended Character Set (CEA-608-E Annex F).
//
// Non-ASCII characters require 2-byte escape sequences. Each extended
// char is encoded as THREE bytes total:
//   1. A fallback ASCII byte — the visually-closest non-extended char,
//      shown by decoders that don't understand the extended codes
//   2. Extended escape byte 1 (0x11/0x12/0x13 for the 3 char tables;
//      0x19/0x1A/0x1B for channel 2)
//   3. Extended escape byte 2 (0x20..0x3F)
//
// When a player receives the escape sequence, it BACKSPACES over the
// fallback char and renders the extended one in its place. Older
// players that ignore the escape simply show the fallback.
//
// Tables here cover the Latin sets most useful for HLS captions:
// Spanish, French, Portuguese, German. Cyrillic, Greek, etc. are
// not included — they're rare in CEA-608 streams (those usually use
// CEA-708 or out-of-band subtitles).
//
// The map keys are character codepoints (charCodeAt result). Values
// are 3-byte arrays [fallback, ext1, ext2] (BEFORE parity is added).
//
// Special characters (0x11 table — channel 1):
var _EXTENDED_CHARS = {
  // Special punctuation / symbols (0x11 0x30..0x3F)
  0x00AE: [0x52, 0x11, 0x30],   // ® (R)
  0x00B0: [0x6F, 0x11, 0x31],   // ° (o)
  0x00BD: [0x32, 0x11, 0x32],   // ½ (2)
  0x00BF: [0x3F, 0x11, 0x33],   // ¿ (?)
  0x2122: [0x54, 0x11, 0x34],   // ™ (T)
  0x00A2: [0x63, 0x11, 0x35],   // ¢ (c)
  0x00A3: [0x4C, 0x11, 0x36],   // £ (L)
  0x266A: [0x4E, 0x11, 0x37],   // ♪ (N)
  0x00E0: [0x61, 0x11, 0x38],   // à (a)
  0x00E8: [0x65, 0x11, 0x3A],   // è (e)
  0x00E2: [0x61, 0x11, 0x3B],   // â (a)
  0x00EA: [0x65, 0x11, 0x3C],   // ê (e)
  0x00EE: [0x69, 0x11, 0x3D],   // î (i)
  0x00F4: [0x6F, 0x11, 0x3E],   // ô (o)
  0x00FB: [0x75, 0x11, 0x3F],   // û (u)

  // Spanish / French extended (0x12 table)
  0x00C1: [0x41, 0x12, 0x20],   // Á (A)
  0x00C9: [0x45, 0x12, 0x21],   // É (E)
  0x00D3: [0x4F, 0x12, 0x22],   // Ó (O)
  0x00DA: [0x55, 0x12, 0x23],   // Ú (U)
  0x00DC: [0x55, 0x12, 0x24],   // Ü (U)
  0x00FC: [0x75, 0x12, 0x25],   // ü (u)
  0x2018: [0x27, 0x12, 0x29],   // ' (')
  0x00A1: [0x21, 0x12, 0x27],   // ¡ (!)
  0x00A9: [0x43, 0x12, 0x2B],   // © (C)
  0x2022: [0x2A, 0x12, 0x2D],   // • (*)
  0x201C: [0x22, 0x12, 0x2E],   // " (")
  0x201D: [0x22, 0x12, 0x2F],   // " (")
  0x00C0: [0x41, 0x12, 0x30],   // À (A)
  0x00C2: [0x41, 0x12, 0x31],   // Â (A)
  0x00C7: [0x43, 0x12, 0x32],   // Ç (C)
  0x00C8: [0x45, 0x12, 0x33],   // È (E)
  0x00CA: [0x45, 0x12, 0x34],   // Ê (E)
  0x00CB: [0x45, 0x12, 0x35],   // Ë (E)
  0x00EB: [0x65, 0x12, 0x36],   // ë (e)
  0x00CE: [0x49, 0x12, 0x37],   // Î (I)
  0x00CF: [0x49, 0x12, 0x38],   // Ï (I)
  0x00EF: [0x69, 0x12, 0x39],   // ï (i)
  0x00D4: [0x4F, 0x12, 0x3A],   // Ô (O)
  0x00D9: [0x55, 0x12, 0x3B],   // Ù (U)
  0x00F9: [0x75, 0x12, 0x3C],   // ù (u)
  0x00DB: [0x55, 0x12, 0x3D],   // Û (U)
  0x00AB: [0x22, 0x12, 0x3E],   // « (")
  0x00BB: [0x22, 0x12, 0x3F],   // » (")

  // Portuguese / German extended (0x13 table)
  0x00C3: [0x41, 0x13, 0x20],   // Ã (A)
  0x00E3: [0x61, 0x13, 0x21],   // ã (a)
  0x00CD: [0x49, 0x13, 0x22],   // Í (I)
  0x00CC: [0x49, 0x13, 0x23],   // Ì (I)
  0x00EC: [0x69, 0x13, 0x24],   // ì (i)
  0x00D2: [0x4F, 0x13, 0x25],   // Ò (O)
  0x00F2: [0x6F, 0x13, 0x26],   // ò (o)
  0x00D5: [0x4F, 0x13, 0x27],   // Õ (O)
  0x00F5: [0x6F, 0x13, 0x28],   // õ (o)
  0x007B: [0x28, 0x13, 0x29],   // { (()
  0x007D: [0x29, 0x13, 0x2A],   // } ())
  0x005C: [0x2F, 0x13, 0x2B],   // \ (/)
  0x005E: [0x2D, 0x13, 0x2C],   // ^ (-)
  0x005F: [0x2D, 0x13, 0x2D],   // _ (-)
  0x007C: [0x21, 0x13, 0x2E],   // | (!)
  0x007E: [0x2D, 0x13, 0x2F],   // ~ (-)
  0x00C4: [0x41, 0x13, 0x30],   // Ä (A)
  0x00E4: [0x61, 0x13, 0x31],   // ä (a)
  0x00D6: [0x4F, 0x13, 0x32],   // Ö (O)
  0x00F6: [0x6F, 0x13, 0x33],   // ö (o)
  0x00DF: [0x73, 0x13, 0x34],   // ß (s)
  0x00A5: [0x59, 0x13, 0x35],   // ¥ (Y)
  0x00A4: [0x6F, 0x13, 0x36],   // ¤ (o)
  0x00C5: [0x41, 0x13, 0x38],   // Å (A)
  0x00E5: [0x61, 0x13, 0x39],   // å (a)
  0x00D8: [0x4F, 0x13, 0x3A],   // Ø (O)
  0x00F8: [0x6F, 0x13, 0x3B],   // ø (o)
};

/**
 * Encode a single character into one or more CEA-608 bytes (with
 * parity). Returns an array of bytes:
 *   - 1 byte for printable ASCII not in the extended remap table
 *   - 3 bytes for extended chars (fallback ASCII + 2-byte escape)
 *   - 1 byte (0x3F = '?') as the safe fallback for unmapped chars
 *
 * The 3-byte extended sequence works because CEA-608 decoders that
 * understand the escape codes will BACKSPACE over the fallback and
 * render the extended char in its place. Older decoders simply
 * display the fallback. Either way the caption is readable.
 *
 * Ref: CEA-608-E Annex F, Tables F.1, F.2, F.3.
 */
function _encodeChar(ch) {
  var code = ch.charCodeAt(0);
  // Extended Latin lookup first — covers both extended chars (à, Ç,
  // etc.) AND certain ASCII codepoints we remap (curly braces, etc.).
  var ext = _EXTENDED_CHARS[code];
  if (ext) {
    return [_withParity(ext[0]), _withParity(ext[1]), _withParity(ext[2])];
  }
  // Plain printable ASCII.
  if (code >= 0x20 && code <= 0x7E) {
    return [_withParity(code)];
  }
  // Out-of-range / unmapped: replace with '?'.
  return [_withParity(0x3F)];
}

// Pre-compute parity-encoded control bytes. These are referenced
// for every cue, so caching the parity calculation saves a bit of
// work and makes the pair-construction code below clearer.
var _CTRL_P     = _withParity(CTRL);     // channel 1 control prefix
var _CTRL_CH2_P = _withParity(CTRL_CH2); // channel 2 control prefix
var _RCL_P      = _withParity(RCL);
var _ENM_P      = _withParity(ENM);
var _EOC_P      = _withParity(EOC);
var _EDM_P      = _withParity(EDM);
var _NUL_P      = _withParity(0x00);     // padding byte for odd-length text

/**
 * Pad a byte sequence to even length with a parity-encoded NUL.
 * CEA-608 byte pairs are always 2 bytes, so an odd-count text run
 * needs trailing padding.
 */
function _padToEven(bytes) {
  if (bytes.length & 1) bytes.push(_NUL_P);
}

/**
 * Decompose a caption cue into a queue of byte-pairs ([byte1, byte2])
 * that the encoder will emit one pair per video frame. Order:
 *
 *   1. RCL  — switch to pop-on mode
 *   2. ENM  — clear non-displayed buffer
 *   3. PAC  — position cursor at row N (multi-row captions stack up)
 *   4. text bytes (1 or 3 bytes per char, 2 per pair)
 *   5. EOC  — flip memories: caption becomes visible
 *
 * For the cue's end time:
 *   1. EDM — erase displayed memory (caption disappears)
 *
 * Returns { startPairs, endPairs } — arrays of [byte1, byte2] pairs.
 */
function _buildCuePairs(text, channel) {
  var ctrlP = channel === 2 ? _CTRL_CH2_P : _CTRL_P;

  var startPairs = [];
  startPairs.push([ctrlP, _RCL_P]);     // Resume Caption Loading
  startPairs.push([ctrlP, _ENM_P]);     // Erase Non-displayed Memory

  // Wrap text to lines of 32 chars max, up to 4 rows.
  var lines = _wrapText(text, 32, 4);
  // Multi-row captions stack from row 15 upward (so single-line
  // captions go on row 15, two-line on rows 14-15, etc.).
  var startRow = 15 - lines.length + 1;
  if (startRow < 1) startRow = 1;

  for (var li = 0; li < lines.length; li++) {
    startPairs.push(_pacForRow(startRow + li));

    // Encode line characters. _encodeChar may return 1 byte (ASCII)
    // or 3 bytes (extended Latin: ASCII fallback + 2-byte escape).
    // Push them all into one flat array, then chunk into 2-byte pairs.
    var bytes = [];
    var line = lines[li];
    for (var ci = 0; ci < line.length; ci++) {
      var encoded = _encodeChar(line.charAt(ci));
      for (var ei = 0; ei < encoded.length; ei++) {
        bytes.push(encoded[ei]);
      }
    }
    _padToEven(bytes);
    for (var bi = 0; bi < bytes.length; bi += 2) {
      startPairs.push([bytes[bi], bytes[bi + 1]]);
    }
  }
  startPairs.push([ctrlP, _EOC_P]);    // End Of Caption (display)

  var endPairs = [
    [ctrlP, _EDM_P],                   // Erase Displayed Memory
  ];

  return { startPairs: startPairs, endPairs: endPairs };
}

/**
 * Greedy word-wrap to maxWidth columns, max maxLines rows. Lines are
 * trimmed; words longer than maxWidth are hard-broken. Excess lines
 * are dropped (consider truncated; v1 keeps things simple).
 */
function _wrapText(text, maxWidth, maxLines) {
  var lines = [];
  // Honor explicit \n line breaks first
  var paragraphs = text.split(/\r?\n/);
  for (var pi = 0; pi < paragraphs.length; pi++) {
    var words = paragraphs[pi].split(/\s+/).filter(function (w) { return w.length > 0; });
    var current = '';
    for (var wi = 0; wi < words.length; wi++) {
      var w = words[wi];
      // If word alone is longer than maxWidth, hard-break it
      while (w.length > maxWidth) {
        if (current.length > 0) {
          lines.push(current);
          current = '';
          if (lines.length >= maxLines) return lines;
        }
        lines.push(w.substring(0, maxWidth));
        if (lines.length >= maxLines) return lines;
        w = w.substring(maxWidth);
      }
      var candidate = current.length === 0 ? w : current + ' ' + w;
      if (candidate.length <= maxWidth) {
        current = candidate;
      } else {
        lines.push(current);
        if (lines.length >= maxLines) return lines;
        current = w;
      }
    }
    if (current.length > 0) {
      lines.push(current);
      if (lines.length >= maxLines) return lines;
    }
  }
  return lines;
}

// CEA-608 byte-pair pacing rate. NTSC line-21 carries one byte-pair
// every 1/30s = 33,333 µs. We use this to space scheduled pairs from
// addCue() — start sequence is positioned so that the EOC pair
// (the one that flips the caption to visible) lands at cue.start.
//
// Most HLS players are tolerant of slight timing variations; pairs
// arriving up to a few hundred ms early or late are still rendered
// correctly. We only respect this rate for SCHEDULING; the actual
// emission rate is determined by the host video stream's frame rate.
var _FRAME_GAP_US = Math.round(1_000_000 / 30);

// ── CEA608Encoder ─────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {number} [opts.channel=1]   CEA-608 channel: 1 (CC1) or 2 (CC2).
 *                                     Channels 3/4 require NTSC field-2
 *                                     cc_data and are not implemented.
 */
function CEA608Encoder(opts) {
  if (!opts) opts = {};
  this._channel = opts.channel || 1;
  if (this._channel !== 1 && this._channel !== 2) {
    throw new TypeError('CEA608Encoder: channel must be 1 or 2');
  }

  // Schedule of byte pairs to emit, sorted by ptsUs. Each entry is
  // { ptsUs, pair: [byte1, byte2] }. Drained on demand by getCcData-
  // ForFrame, which pops every entry whose ptsUs falls in the
  // requested frame window.
  this._scheduled = [];
}

/**
 * Schedule a caption cue. Decomposes into byte pairs and queues them
 * relative to the cue's start and end times. Caller can add cues out
 * of order; the encoder sorts internally by ptsUs.
 *
 * @param {object} cue
 * @param {number} cue.start      Start time in seconds (>= 0).
 * @param {number} cue.end        End time in seconds (> start).
 * @param {string} cue.text       Caption text. Multi-line via "\n".
 *                                 Wrapped to 32 cols × 4 rows max.
 */
CEA608Encoder.prototype.addCue = function (cue) {
  if (!cue || typeof cue.text !== 'string') {
    throw new TypeError('CEA608Encoder.addCue: cue.text (string) required');
  }
  if (typeof cue.start !== 'number' || typeof cue.end !== 'number') {
    throw new TypeError('CEA608Encoder.addCue: cue.start/end (numbers) required');
  }
  if (cue.end <= cue.start) {
    throw new RangeError('CEA608Encoder.addCue: cue.end must be > cue.start');
  }

  var pairs = _buildCuePairs(cue.text, this._channel);

  // Schedule the START sequence so the LAST pair (EOC — the one that
  // flips the caption to visible) lands at cue.start. Each pair is
  // separated by _FRAME_GAP_US (NTSC pacing). If cue.start is so
  // close to t=0 that the start sequence can't be paced before then,
  // we clamp the first pair to t=0 and let the front pairs queue up
  // — the caption will appear a frame or two late, which is
  // imperceptible.
  var nPairs = pairs.startPairs.length;
  var firstStartUs = Math.round(cue.start * 1_000_000) -
                     (nPairs - 1) * _FRAME_GAP_US;
  if (firstStartUs < 0) firstStartUs = 0;

  for (var i = 0; i < pairs.startPairs.length; i++) {
    this._scheduled.push({
      ptsUs: firstStartUs + i * _FRAME_GAP_US,
      pair:  pairs.startPairs[i],
    });
  }
  // End pair (EDM) at cue.end
  for (var j = 0; j < pairs.endPairs.length; j++) {
    this._scheduled.push({
      ptsUs: Math.round(cue.end * 1_000_000) + j * _FRAME_GAP_US,
      pair:  pairs.endPairs[j],
    });
  }

  // Keep schedule sorted for efficient drain.
  this._scheduled.sort(_compareByPts);
};

function _compareByPts(a, b) { return a.ptsUs - b.ptsUs; }

/**
 * Pull cc_data triples that should be emitted at the given frame PTS.
 * Returns up to 2 triples (NTSC pairs the 60Hz CC clock with 30fps
 * video at 2 byte-pairs/frame; we cap at 2 to leave headroom for
 * future CEA-708 alongside, and to keep parity sequences contiguous).
 *
 * Each triple is { ccType: 0|1|2|3, ccValid: 0|1, b1: byte, b2: byte }.
 * cc_type=0 means "CEA-608 NTSC field 1" — the channel for CC1/CC2.
 *
 * If no real data is queued, returns an empty array. Caller may want
 * to emit a "filler" triple (cc_valid=0, b1/b2=0x80) per frame to
 * keep the SEI message structurally constant — that's optional.
 *
 * @param {number} frameStartUs   Inclusive lower bound of frame window
 * @param {number} frameEndUs     Exclusive upper bound (= start of next frame)
 */
CEA608Encoder.prototype.getCcDataForFrame = function (frameStartUs, frameEndUs) {
  var triples = [];

  // Take any scheduled pairs whose ptsUs falls into this frame.
  // Cap at 2 per frame (see header comment).
  while (triples.length < 2 && this._scheduled.length > 0 &&
         this._scheduled[0].ptsUs < frameEndUs) {
    var entry = this._scheduled.shift();
    triples.push({
      ccType:  0,           // 0b00 = CEA-608 NTSC field 1
      ccValid: 1,
      b1: entry.pair[0],
      b2: entry.pair[1],
    });
  }

  return triples;
};

/**
 * Build a SEI message payload carrying the given cc_data triples.
 * Wraps them in the ATSC `user_data_registered_itu_t_t35` structure
 * defined by ATSC A/53 Part 4 Annex A.
 *
 * Output is the full SEI NAL unit's RBSP payload — ready to be wrapped
 * in a NAL header (forbidden_zero_bit=0, nal_ref_idc=0, nal_unit_type=6
 * for H.264 / 39 for H.265) and the start code or length prefix.
 *
 * @param {Array} triples   List of {ccType, ccValid, b1, b2}
 * @param {boolean} isH265  Use HEVC SEI structure (NAL header is 2
 *                           bytes instead of 1). Default false.
 * @returns {Uint8Array}    SEI NAL bytes (with NAL header, no start code)
 */
function buildCea608SeiNalu(triples, isH265) {
  if (!triples || triples.length === 0) return null;
  if (triples.length > 31) {
    // cc_count is 5 bits — hard cap. Real streams almost never see
    // more than 2 triples per frame; 31 is comfortable.
    triples = triples.slice(0, 31);
  }

  // ATSC A/53 user_data_registered_itu_t_t35:
  //   itu_t_t35_country_code              = 0xB5         (USA)
  //   itu_t_t35_provider_code             = 0x0031       (ATSC, 16 bits)
  //   user_identifier                     = 0x47413934   ("GA94")
  //   user_data_type_code                 = 0x03         (cc_data)
  //   user_data_type_structure: cc_data():
  //     reserved (1 bit) = 1
  //     process_cc_data_flag (1 bit) = 1
  //     zero_bit (1 bit) = 0
  //     cc_count (5 bits)
  //     reserved (8 bits) = 0xFF
  //     for i=0..cc_count-1:
  //       marker_bits (5 bits) = 0b11111
  //       cc_valid (1 bit)
  //       cc_type (2 bits)
  //       cc_data_1 (8 bits)
  //       cc_data_2 (8 bits)
  //     marker_bits (8 bits) = 0xFF

  var ccCount = triples.length;
  // payload size:
  //   8  bytes T.35 + GA94 + type prefix
  //     (B5 00 31 47 41 39 34 03)
  //   1  byte  cc_data header (reserved+process+zero+cc_count)
  //   1  byte  em_data (reserved, 0xFF)
  //   3 * ccCount bytes triples
  //   1  byte  trailing marker_bits (0xFF)
  // = 11 + 3*ccCount
  var payload = new Uint8Array(11 + 3 * ccCount);
  var off = 0;
  payload[off++] = 0xB5;                            // country code (USA)
  payload[off++] = 0x00; payload[off++] = 0x31;     // provider (ATSC)
  payload[off++] = 0x47; payload[off++] = 0x41;     // "GA"
  payload[off++] = 0x39; payload[off++] = 0x34;     // "94"
  payload[off++] = 0x03;                            // user_data_type_code = cc_data
  // cc_data header byte: reserved=1 | process=1 | zero=0 | cc_count(5)
  payload[off++] = 0xC0 | (ccCount & 0x1F);
  payload[off++] = 0xFF;                            // em_data (reserved, all-1s)
  for (var i = 0; i < ccCount; i++) {
    var t = triples[i];
    // marker_bits(5) | cc_valid(1) | cc_type(2)
    var hdr = 0xF8 | ((t.ccValid & 1) << 2) | (t.ccType & 0x03);
    payload[off++] = hdr;
    payload[off++] = t.b1;
    payload[off++] = t.b2;
  }
  payload[off++] = 0xFF;                            // marker_bits (trailer)

  // SEI message structure (Annex B raw bytes, before EBSP escaping):
  //   payload_type (= 4, user_data_registered_itu_t_t35)
  //   payload_size (= len(payload))
  //   payload bytes (with EBSP escaping)
  //   trailing rbsp bits: 0x80 (single 1 bit + zero alignment)
  //
  // payload_type and payload_size are written with FF FF FF... NN
  // run-length encoding for values > 255. payload_type=4 fits in 1 byte.
  // For typical small payloads, payload_size also fits in 1 byte too —
  // we cap at 31 triples above so payload.length <= 11+93 = 104.
  if (payload.length > 254) {
    // Unreachable in practice (cc_count is 5 bits, capped at 31 above).
    // Defensive only.
    throw new RangeError('CEA-608 SEI payload too large');
  }

  // Compute size with EBSP escapes. EBSP = "Encapsulated Byte Sequence
  // Payload" — anywhere 0x00 0x00 appears followed by a byte ≤ 0x03,
  // a 0x03 escape is inserted to avoid emulating a NAL start code.
  // For our typical T.35 / GA94 payloads this never triggers (header
  // bytes are 0xB5/0x47/0xC0+/0xF8+), but the code path is defensive
  // for extensions like CEA-708 where arbitrary text bytes can land
  // adjacent to zero bytes.
  var escapedLen = 0;
  for (var ei = 0; ei < payload.length; ei++) {
    if (ei >= 2 && payload[ei] <= 0x03 &&
        payload[ei - 1] === 0 && payload[ei - 2] === 0) {
      escapedLen++;   // need to insert 0x03 escape
    }
    escapedLen++;
  }
  // Allocate final buffer:
  //   NAL header (1 for H.264, 2 for H.265) + payload_type (1) +
  //   payload_size (1) + escaped payload + trailing rbsp byte (1).
  var headerSize = isH265 ? 2 : 1;
  var sei = new Uint8Array(headerSize + 2 + escapedLen + 1);
  var off2 = 0;
  // NAL header. H.264: nal_unit_type=6 (SEI). H.265: type=39 PREFIX_SEI_NUT
  // packed as (forbidden=0)|(type<<1)|(layer_id_high), then (layer_id_low
  // 5 bits)|(tid+1, 3 bits) = 0x4E 0x01.
  if (isH265) {
    sei[off2++] = 0x4E;
    sei[off2++] = 0x01;
  } else {
    sei[off2++] = 0x06;
  }
  sei[off2++] = 0x04;                      // payload_type = 4 (T.35)
  sei[off2++] = payload.length & 0xFF;     // payload_size
  // Copy payload with EBSP escapes (same condition as the size pass —
  // these MUST stay in sync).
  for (var pi = 0; pi < payload.length; pi++) {
    if (pi >= 2 && payload[pi] <= 0x03 &&
        payload[pi - 1] === 0 && payload[pi - 2] === 0) {
      sei[off2++] = 0x03;
    }
    sei[off2++] = payload[pi];
  }
  // RBSP trailing bits: 0x80 (rbsp_stop_one_bit + zero alignment)
  sei[off2++] = 0x80;

  return sei;
}

export default CEA608Encoder;
export { buildCea608SeiNalu, _withParity, _pacForRow, _wrapText };
