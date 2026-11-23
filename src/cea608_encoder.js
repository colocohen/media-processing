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
function _pacForRow(row, channel) {
  var entry = (row >= 1 && row <= 15) ? _PAC_TABLE[row] : _PAC_TABLE[15];
  // The table holds channel-1 codes (0x10..0x17). Channel 2 uses the
  // same codes offset by 0x08 (0x18..0x1F) — the same relationship as
  // CTRL 0x14 → CTRL_CH2 0x1C above.
  //
  // This argument used to not exist. Control codes (RCL/ENM/EOC/EDM)
  // were correctly switched to channel 2, but the PAC that follows them
  // was always channel 1 — and a PAC is itself a channel-selecting
  // control code, so it switched the decoder BACK to channel 1 before
  // the text bytes arrived. Captions requested on CC2 rendered on CC1,
  // while a player that selected CC2 (which HLSEncoder advertises via
  // INSTREAM-ID) saw nothing at all.
  var b1 = (channel === 2) ? (entry[0] + 0x08) : entry[0];
  return [_withParity(b1), _withParity(entry[1])];
}

// ── Character mapping (CEA-608-E §6.4 / Annex F; FFmpeg ccaption_dec) ──
//
// Three kinds of character on the wire:
//
//   1. BASIC (one byte, 0x20..0x7F). Mostly ASCII, but NOT entirely:
//      ten code points are accented letters / symbols instead —
//        0x2A á   0x5C é   0x5E í   0x5F ó   0x60 ú
//        0x7B ç   0x7C ÷   0x7D Ñ   0x7E ñ   0x7F █
//      (and 0x27 is the apostrophe, which decoders draw as ’).
//      The old encoder sent every ASCII byte as is, so '*' showed as
//      "á" ("5*3" → "5á3"), and é á í ó ú ñ Ñ ç — the most common
//      accented letters in Spanish — had no entry at all and became '?'.
//
//   2. SPECIAL (two bytes 0x11 0x30..0x3F; CC2: 0x19): ® ° ½ ¿ ™ ¢ £ ♪
//      à (transparent space) è â ê î ô û. These do NOT backspace — the
//      decoder just writes them at the cursor — so they take no fallback
//      byte. The old encoder sent one anyway: "x®" → "xR®".
//
//   3. EXTENDED (two bytes 0x12/0x13 0x20..0x3F; CC2: 0x1A/0x1B). The
//      decoder BACKSPACES one column and draws the char over it, so the
//      escape is preceded by a basic "fallback" char that older decoders
//      leave on screen. The escape must be a whole byte PAIR: the old
//      encoder packed [fallback, esc1, esc2] into the text stream two
//      bytes at a time, so "Ü" went out as [U, 0x12] [0x24, NUL] — the
//      escape split across pairs and the decoder showed "U$".
//
// Each value: [table, code, fallback] — table 0 = basic (code is the
// byte), 0x11 special, 0x12 / 0x13 extended (fallback = basic byte).
// Tables 0x12 0x26/0x29 follow CEA-608 (‘ and ’); FFmpeg's ccaption_dec
// decodes 0x26 as ´ and 0x29 as ‘ — a known difference in its table.
var _CHARMAP = {};
(function () {
  function basic(cp, byte) { _CHARMAP[cp] = [0, byte, 0]; }
  function special(cp, code) { _CHARMAP[cp] = [0x11, code, 0]; }
  function ext(table, cp, code, fallback) { _CHARMAP[cp] = [table, code, fallback.charCodeAt(0)]; }

  var c;
  for (c = 0x20; c <= 0x7E; c++) basic(c, c);
  // ASCII the basic set does NOT have: those bytes mean something else.
  delete _CHARMAP[0x2A]; delete _CHARMAP[0x5C]; delete _CHARMAP[0x5E];
  delete _CHARMAP[0x5F]; delete _CHARMAP[0x60]; delete _CHARMAP[0x7B];
  delete _CHARMAP[0x7C]; delete _CHARMAP[0x7D]; delete _CHARMAP[0x7E];

  basic(0x00E1, 0x2A); basic(0x00E9, 0x5C); basic(0x00ED, 0x5E);   // á é í
  basic(0x00F3, 0x5F); basic(0x00FA, 0x60); basic(0x00E7, 0x7B);   // ó ú ç
  basic(0x00F7, 0x7C); basic(0x00D1, 0x7D); basic(0x00F1, 0x7E);   // ÷ Ñ ñ
  basic(0x2588, 0x7F);                                             // █
  basic(0x2019, 0x27);                                             // ’ (0x27 draws as ’)
  basic(0x0060, 0x27);                                             // ` → ' (no grave accent in 608)
  basic(0x2013, 0x2D);                                             // – → -

  // Special characters, 0x11 0x30..0x3F.
  special(0x00AE, 0x30); special(0x00B0, 0x31); special(0x00BD, 0x32); special(0x00BF, 0x33);
  special(0x2122, 0x34); special(0x00A2, 0x35); special(0x00A3, 0x36); special(0x266A, 0x37);
  special(0x00E0, 0x38); special(0x00A0, 0x39); special(0x00E8, 0x3A); special(0x00E2, 0x3B);
  special(0x00EA, 0x3C); special(0x00EE, 0x3D); special(0x00F4, 0x3E); special(0x00FB, 0x3F);

  // Extended Spanish / French / misc, 0x12 0x20..0x3F.
  var e12 = [
    [0x00C1, 'A'], [0x00C9, 'E'], [0x00D3, 'O'], [0x00DA, 'U'], [0x00DC, 'U'], [0x00FC, 'u'],
    [0x2018, "'"], [0x00A1, '!'], [0x002A, ' '], [0x2019, "'"], [0x2014, '-'], [0x00A9, 'c'],
    [0x2120, ' '], [0x2022, '.'], [0x201C, '"'], [0x201D, '"'],
    [0x00C0, 'A'], [0x00C2, 'A'], [0x00C7, 'C'], [0x00C8, 'E'], [0x00CA, 'E'], [0x00CB, 'E'],
    [0x00EB, 'e'], [0x00CE, 'I'], [0x00CF, 'I'], [0x00EF, 'i'], [0x00D4, 'O'], [0x00D9, 'U'],
    [0x00F9, 'u'], [0x00DB, 'U'], [0x00AB, '"'], [0x00BB, '"'],
  ];
  // Extended Portuguese / German / Danish, 0x13 0x20..0x3F. Also holds
  // the ASCII { } \ ^ _ | ~ that the basic set gave away (fallbacks are
  // the closest basic glyph for decoders without the extended sets).
  var e13 = [
    [0x00C3, 'A'], [0x00E3, 'a'], [0x00CD, 'I'], [0x00CC, 'I'], [0x00EC, 'i'], [0x00D2, 'O'],
    [0x00F2, 'o'], [0x00D5, 'O'], [0x00F5, 'o'], [0x007B, '('], [0x007D, ')'], [0x005C, '/'],
    [0x005E, "'"], [0x005F, '-'], [0x007C, '!'], [0x007E, '-'],
    [0x00C4, 'A'], [0x00E4, 'a'], [0x00D6, 'O'], [0x00F6, 'o'], [0x00DF, 's'], [0x00A5, 'Y'],
    [0x00A4, 'c'], [0x00A6, '!'], [0x00C5, 'A'], [0x00E5, 'a'], [0x00D8, 'O'], [0x00F8, 'o'],
    [0x250C, '+'], [0x2510, '+'], [0x2514, '+'], [0x2518, '+'],
  ];
  for (c = 0; c < 32; c++) {
    // ’ stays basic 0x27 (one byte, no backspace) — skip its 0x12 entry.
    if (e12[c][0] !== 0x2019) ext(0x12, e12[c][0], 0x20 + c, e12[c][1]);
    ext(0x13, e13[c][0], 0x20 + c, e13[c][1]);
  }
})();

/**
 * Map one character (a full code point) to its CEA-608 form:
 *   { basic: byte }                       — one byte in the text stream
 *   { code: [b1, b2] }                    — special char: own pair
 *   { fallback: byte, code: [b1, b2] }    — extended: basic fallback
 *                                           byte, then its own pair
 * all with parity, b1 already shifted to the channel. A character with
 * no 608 form is tried without its accents (NFD: ő → o), else '?'.
 *
 * Ref: CEA-608-E §6.4.1, Annex F; FFmpeg libavcodec/ccaption_dec.c.
 */
function _encodeChar(ch, channel) {
  var m = _CHARMAP[ch.codePointAt(0)];
  if (!m) {
    // Combining marks as \u escapes, not the literal characters: the
    // browser bundle kept them as raw UTF-8 inside this regex, and a
    // page without <meta charset="utf-8"> reads the script as
    // windows-1252 — "Range out of order in character class", and the
    // whole library failed to load.
    var base = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    m = (base.length === 1 && _CHARMAP[base.charCodeAt(0)]) || _CHARMAP[0x3F];
  }
  if (m[0] === 0) return { basic: _withParity(m[1]) };
  // The table byte is channel-scoped: 0x11/0x12/0x13 on CC1,
  // 0x19/0x1A/0x1B on CC2 (an unshifted code drags the line onto CC1).
  var code = [_withParity(channel === 2 ? m[0] + 0x08 : m[0]), _withParity(m[1])];
  if (m[0] === 0x11) return { code: code };
  return { fallback: _withParity(m[2]), code: code };
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
var _NUL_P      = _withParity(0x00);     // pads an odd basic byte to a full pair

/**
 * Decompose a caption cue into "units" — each unit is the list of byte
 * pairs ([byte1, byte2]) that must go out back to back. Order:
 *
 *   1. RCL  — switch to pop-on mode
 *   2. ENM  — clear non-displayed buffer
 *   3. PAC  — position cursor at row N (multi-row captions stack up)
 *   4. text — basic bytes two per pair; special / extended chars as
 *             their own pair (an odd basic byte before one is padded
 *             with NUL, so the 2-byte code never straddles pairs)
 *   5. EOC  — flip memories: caption becomes visible
 *
 * For the cue's end time:
 *   1. EDM — erase displayed memory (caption disappears)
 *
 * Every control code, PAC and special/extended char is sent TWICE in
 * consecutive pairs (CEA-608-E §8 / 47 CFR 15.119 practice): decoders
 * drop the immediate repeat, and a pair lost to a transmission error is
 * covered by its copy. Doubling also makes two identical consecutive
 * specials ("♪♪") decodable on spec decoders: [♪][♪][♪][♪] = two ♪,
 * where [♪][♪] is one ♪ plus its ignored repeat. (FFmpeg's
 * ccaption_dec drops every consecutive repeat, so it shows one ♪
 * either way.)
 *
 * Returns { startUnits, endUnits }.
 */
function _buildCuePairs(text, channel) {
  var ctrlP = channel === 2 ? _CTRL_CH2_P : _CTRL_P;
  function twice(pair) { return [pair, pair.slice()]; }

  var startUnits = [];
  startUnits.push(twice([ctrlP, _RCL_P]));     // Resume Caption Loading
  startUnits.push(twice([ctrlP, _ENM_P]));     // Erase Non-displayed Memory

  // Wrap text to lines of 32 chars max, up to 4 rows.
  var lines = _wrapText(text, 32, 4);
  // Multi-row captions stack from row 15 upward (so single-line
  // captions go on row 15, two-line on rows 14-15, etc.).
  var startRow = 15 - lines.length + 1;
  if (startRow < 1) startRow = 1;

  for (var li = 0; li < lines.length; li++) {
    startUnits.push(twice(_pacForRow(startRow + li, channel)));

    var pending = null;                        // odd basic byte waiting for a partner
    var chars = Array.from(lines[li]);         // code points, not UTF-16 halves
    for (var ci = 0; ci < chars.length; ci++) {
      var enc = _encodeChar(chars[ci], channel);
      var b = enc.code ? enc.fallback : enc.basic;
      if (b !== undefined) {
        if (pending === null) pending = b;
        else { startUnits.push([[pending, b]]); pending = null; }
      }
      if (enc.code) {
        if (pending !== null) { startUnits.push([[pending, _NUL_P]]); pending = null; }
        startUnits.push(twice(enc.code));
      }
    }
    if (pending !== null) startUnits.push([[pending, _NUL_P]]);
  }
  startUnits.push(twice([ctrlP, _EOC_P]));     // End Of Caption (display)

  var endUnits = [
    twice([ctrlP, _EDM_P]),                    // Erase Displayed Memory
  ];

  return { startUnits: startUnits, endUnits: endUnits };
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

  // Cues not yet fully sent: { id, startUs, endUs, startUnits, endUnits,
  // sent: Set of unit keys already emitted }. The pair schedule is
  // derived from ALL of them together (see _rebuild) — it used to be
  // built cue by cue, which is what let two cues' load sequences
  // interleave.
  this._cues = [];
  this._nextId = 0;
  // Pending pairs in emission order: { ptsUs, pair, cue, key, last }.
  // null = cues changed, rebuild before the next drain.
  this._scheduled = [];
  this._dirty = false;
  this._nowUs = -Infinity;     // start of the last frame drained
}

/**
 * Schedule a caption cue. Cues may be added in any order (and while
 * frames are being drained); the schedule is rebuilt from all pending
 * cues on the next getCcDataForFrame().
 *
 * Pop-on captions show one caption at a time, so cues are serialized:
 *   - A cue's load sequence (RCL … EOC) is paced so that EOC lands at
 *     cue.start, but never starts before the previous cue's EOC has
 *     gone out — the later cue is delayed instead. Before, two cues
 *     whose load sequences overlapped (start 2.0 s and 2.3 s) had their
 *     pairs merged by time, writing both texts into the same hidden
 *     buffer: FFmpeg showed "deEclthoa f" then "oxtrot golf hotel".
 *   - A cue's EDM (at cue.end) is dropped when the next cue is shown
 *     at or before that time: EOC already replaces it, and an EDM after
 *     that EOC would erase the NEW caption. Before, with back-to-back
 *     cues (end of one == start of the next) the order of the two pairs
 *     at the same pts depended on which cue was added first; added in
 *     reverse order, EOC went first and the EDM blanked the next cue
 *     (FFmpeg: one 0-length cue "First cueSecond cue" at 4.000).
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

  var units = _buildCuePairs(cue.text, this._channel);
  this._cues.push({
    id: this._nextId++,
    startUs: Math.round(cue.start * 1_000_000),
    endUs: Math.round(cue.end * 1_000_000),
    startUnits: units.startUnits,
    endUnits: units.endUnits,
    sent: new Set(),
  });
  this._dirty = true;
};

/**
 * Recompute the pair schedule from the pending cues.
 *
 * Cues whose load sequence has already begun keep their place (their
 * remaining pairs must not be split by another cue's); the rest follow
 * in start order. A cue that has not started and whose end is already
 * past is dropped — it can no longer be shown.
 */
CEA608Encoder.prototype._rebuild = function () {
  var self = this;
  var started = [], waiting = [];
  this._cues.forEach(function (c) {
    if (c.sent.size > 0) started.push(c);
    else if (c.endUs > self._nowUs) waiting.push(c);
  });
  var byStart = function (a, b) { return (a.startUs - b.startUs) || (a.id - b.id); };
  started.sort(byStart);
  waiting.sort(byStart);
  var order = started.concat(waiting);
  this._cues = order;

  // Pass 1: when each cue's EOC goes out.
  var loadFreeUs = -Infinity;
  var firstUs = [];
  for (var i = 0; i < order.length; i++) {
    var n = order[i].startUnits.length;
    var first = order[i].startUs - (n - 1) * _FRAME_GAP_US;
    if (first < 0) first = 0;
    if (first < loadFreeUs) first = loadFreeUs;
    firstUs.push(first);
    order[i].eocUs = first + (n - 1) * _FRAME_GAP_US;
    loadFreeUs = order[i].eocUs + _FRAME_GAP_US;
  }

  // Pass 2: the pairs. seq keeps units of one cue in order and both
  // copies of a doubled code adjacent; at equal pts an EDM sorts first.
  var entries = [];
  var seq = 0;
  function add(cue, units, kind, t0, prio) {
    for (var u = 0; u < units.length; u++) {
      var key = kind + u;
      if (cue.sent.has(key)) continue;
      for (var p = 0; p < units[u].length; p++) {
        entries.push({ ptsUs: t0 + u * _FRAME_GAP_US, prio: prio, seq: seq++,
          pair: units[u][p], cue: cue, key: key, last: p === units[u].length - 1 });
      }
    }
  }
  for (var j = 0; j < order.length; j++) {
    var c = order[j];
    add(c, c.startUnits, 's', firstUs[j], 1);
    var next = order[j + 1];
    // EOC of the next cue replaces this one at/before its end: no EDM.
    c.needsEdm = !(next && next.eocUs <= c.endUs);
    if (c.needsEdm) add(c, c.endUnits, 'e', Math.max(c.endUs, c.eocUs + _FRAME_GAP_US), 0);
  }
  entries.sort(function (a, b) { return (a.ptsUs - b.ptsUs) || (a.prio - b.prio) || (a.seq - b.seq); });
  this._scheduled = entries;
  this._dirty = false;
};

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
  if (this._dirty) this._rebuild();
  if (frameStartUs > this._nowUs) this._nowUs = frameStartUs;
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
    if (entry.last) this._markSent(entry.cue, entry.key);
  }

  return triples;
};

// Record a fully emitted unit; forget a cue once nothing of it is left.
CEA608Encoder.prototype._markSent = function (cue, key) {
  cue.sent.add(key);
  var done = cue.sent.size >= cue.startUnits.length &&
    (!cue.needsEdm || cue.sent.size >= cue.startUnits.length + cue.endUnits.length);
  if (done) {
    var i = this._cues.indexOf(cue);
    if (i !== -1) this._cues.splice(i, 1);
  }
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
