/**
 * playlist-utils — Shared helpers for HLS playlist serialization.
 *
 * Functions here are pure and used from both `playlist.js` (media
 * playlists) and `master-playlist.js` (multivariant playlists), and
 * occasionally from `hls-encoder.js` for input validation. Keeping
 * them in one module avoids drift between identical implementations.
 *
 * No module-level state. Safe to import from any source file.
 */

/**
 * Escape backslashes and double-quotes for the quoted-string subset of
 * HLS attribute values. Per RFC 8216 §4.2 quoted-string is "any number
 * of characters except double-quote and CR/LF" — the spec is silent on
 * escaping. Real-world parsers (hls.js, AVPlayer, FFmpeg) accept
 * backslash-escaped quotes, so we use that convention.
 *
 * URIs and most strings won't need escaping in practice; this exists
 * for pathological filenames and human-supplied display names.
 *
 * @param {string} s  arbitrary string
 * @returns {string}  safe to embed between double quotes
 */
export function escapeQuoted(s) {
  // Strip CR/LF first — these break parsers since the line ends there.
  s = String(s).replace(/[\r\n]/g, ' ');
  // Then escape backslash and double-quote.
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Validate VIDEO-RANGE attribute value. RFC 8216bis-13 §4.4.6.2.1
 * defines exactly three values:
 *   - SDR: Rec. 709 standard dynamic range
 *   - HLG: Hybrid Log-Gamma — used by BBC/NHK; backwards-compatible
 *          with SDR displays
 *   - PQ:  Perceptual Quantizer — HDR10, HDR10+, and Dolby Vision all
 *          use PQ as their transfer function
 *
 * Omitting VIDEO-RANGE entirely defaults to SDR per spec; callers who
 * explicitly want SDR can either set it or omit it.
 *
 * @param {string} range
 * @returns {boolean}  true iff range is one of the three valid values
 */
export function isValidVideoRange(range) {
  return range === 'SDR' || range === 'HLG' || range === 'PQ';
}

/**
 * Validate an HLS variable name (used by EXT-X-DEFINE NAME, IMPORT,
 * QUERYPARAM). Per RFC 8216bis the grammar restricts the value to
 * ASCII letters, digits, hyphens, and underscores — no dots, spaces,
 * or other characters. Validating here surfaces typos at the API
 * boundary instead of as silent player-side substitution failures.
 *
 * @param {string} s
 * @returns {boolean}  true iff s is a valid variable-name token
 */
export function isValidVariableName(s) {
  return typeof s === 'string' && /^[A-Za-z0-9_\-]+$/.test(s);
}

/**
 * Validate the IV attribute used by EXT-X-KEY and EXT-X-SESSION-KEY.
 * Per RFC 8216 the IV is a 128-bit number serialized as "0x" followed
 * by exactly 32 hex digits. Both upper- and lower-case are accepted;
 * the prefix character may be 'x' or 'X'.
 *
 * @param {string} s
 * @returns {boolean}  true iff s matches the IV grammar
 */
export function isValidIvHex(s) {
  return typeof s === 'string' && /^0[xX][0-9A-Fa-f]{32}$/.test(s);
}

/**
 * Validate the METHOD attribute on EXT-X-KEY / EXT-X-SESSION-KEY for
 * NON-clear methods. NONE has its own special treatment (no other
 * attributes allowed) and is excluded here so callers can branch
 * before validating method-bound attributes.
 *
 * Methods recognized:
 *   - AES-128         RFC 8216 baseline
 *   - SAMPLE-AES      Apple sample-level encryption
 *   - AES-256-GCM     RFC 8216bis-19 (January 2026)
 *   - SAMPLE-AES-CTR  CMAF-CTR
 *
 * @param {string} m
 * @returns {boolean}  true iff m is one of the four non-NONE methods
 */
export function isValidEncryptionMethod(m) {
  return m === 'AES-128' || m === 'SAMPLE-AES' ||
         m === 'AES-256-GCM' || m === 'SAMPLE-AES-CTR';
}


/**
 * Parse an HLS attribute-list (RFC 8216 §4.2) into a plain object of
 * raw string values. This is the inverse of the `KEY=VALUE` / quoted
 * serialization used by the playlist writers. Quoted values may contain
 * commas and '=' — handled by tracking quote state. Keys are kept as-is
 * (e.g. 'BANDWIDTH', 'FRAME-RATE'); callers map them to camelCase fields.
 *
 *   'BANDWIDTH=1280000,CODECS="avc1.42e,mp4a.40.2",RESOLUTION=640x360'
 *     → { BANDWIDTH:'1280000', CODECS:'avc1.42e,mp4a.40.2', RESOLUTION:'640x360' }
 *
 * @param {string} str  the text after the tag's ':' (no leading '#EXT…:')
 * @returns {Object<string,string>}
 */
export function parseAttributeList(str) {
  var out = {};
  if (!str) return out;
  var i = 0, n = str.length;
  while (i < n) {
    // Skip stray separators / whitespace between attributes.
    while (i < n && (str[i] === ',' || str[i] === ' ')) i++;
    var eq = str.indexOf('=', i);
    if (eq < 0) break;
    var key = str.slice(i, eq).trim();
    i = eq + 1;
    var val;
    if (str[i] === '"') {
      var end = str.indexOf('"', i + 1);
      if (end < 0) end = n;
      val = str.slice(i + 1, end);
      i = end + 1;
    } else {
      var comma = str.indexOf(',', i);
      var stop = (comma < 0) ? n : comma;
      val = str.slice(i, stop).trim();
      i = stop;
    }
    if (key) out[key] = val;
  }
  return out;
}


/**
 * Parse an HLS BYTERANGE value "<length>[@<offset>]" into {length, offset}.
 * When the offset is omitted, the spec says it continues from the end of
 * the previous range in the same file — pass that as `prevEnd`.
 *
 * @param {string} s        e.g. '1000@2048' or '1000'
 * @param {number} prevEnd  byte offset to use when '@offset' is absent
 * @returns {{length:number, offset:number}}
 */
export function parseByteRange(s, prevEnd) {
  var at = s.indexOf('@');
  if (at >= 0) {
    return { length: parseInt(s.slice(0, at), 10), offset: parseInt(s.slice(at + 1), 10) };
  }
  return { length: parseInt(s, 10), offset: prevEnd || 0 };
}
