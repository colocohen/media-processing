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
 * Check a value for use as an HLS quoted-string and return it as a
 * string, ready to put between double quotes.
 *
 * RFC 8216 §4.2: a quoted-string is any characters except double-quote
 * and CR/LF, and there is NO escape mechanism. This used to emit `\"`
 * and `\\` escapes, which is not HLS syntax: NAME="Director \"cut\", EN"
 * was read back (by our own parser too) as NAME="Director \" — the value
 * ends at the first '"'. It also replaced CR/LF with spaces, silently
 * changing the value. A value that cannot be represented is now rejected.
 *
 * The string MUST also be non-empty unless its attribute allows an empty
 * one (§4.2): ID="", URI="", NAME="" were written as given. Only
 * EXT-X-DEFINE's VALUE (and EXT-X-SKIP's RECENTLY-REMOVED-DATERANGES,
 * which the writer composes itself) may be empty — `allowEmpty`.
 *
 * @param {string} s  the attribute value
 * @param {boolean} [allowEmpty]  the attribute allows ""
 * @returns {string}  the same value, as a string
 * @throws {TypeError} if it contains '"', CR or LF, or is empty
 */
export function escapeQuoted(s, allowEmpty) {
  s = String(s);
  if (/["\r\n]/.test(s)) {
    throw new TypeError('HLS quoted-string value ' + JSON.stringify(s) +
      ' contains a double quote or CR/LF, which RFC 8216 §4.2 does not allow ' +
      '(the format has no escape syntax)');
  }
  if (s === '' && !allowEmpty) {
    throw new TypeError('HLS quoted-string value is empty, which RFC 8216 §4.2 does not ' +
      'allow unless the attribute says so');
  }
  return s;
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
 * Validate KEYFORMATVERSIONS (EXT-X-KEY / EXT-X-SESSION-KEY): one or more
 * positive integers separated by "/" — "1", "1/2", "1/2/5" (rfc8216bis
 * §4.4.4.4).
 *
 * @param {string} s
 * @returns {boolean}
 */
export function isValidKeyFormatVersions(s) {
  return typeof s === 'string' && /^0*[1-9][0-9]*(\/0*[1-9][0-9]*)*$/.test(s);
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
 * `quoted`, when given, gets for each key whether its (last) value was a
 * quoted-string: an enumerated-string such as CLOSED-CAPTIONS=NONE is not
 * the quoted-string "NONE".
 *
 * @param {string} str  the text after the tag's ':' (no leading '#EXT…:')
 * @param {Object<string,boolean>} [quoted]  filled with key → quoted
 * @returns {Object<string,string>}
 */
export function parseAttributeList(str, quoted) {
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
    var isQuoted = str[i] === '"';
    if (isQuoted) {
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
    if (key) {
      out[key] = val;
      if (quoted) quoted[key] = isQuoted;
    }
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


// ── RFC 8216 §4.2 value grammars, checked by the playlist writers where a
// value enters the playlist, so that a value the format cannot hold fails
// at the call that passed it (as escapeQuoted does for quoted-strings).

// decimal-integer: 0 to 2^64-1; a JS number is exact up to 2^53-1.
export function decimalInteger(v, what) {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
    throw new RangeError(what + ' must be an integer in [0, 2^53-1] ' +
                         '(decimal-integer, RFC 8216 §4.2), got ' + v);
  }
  return v;
}

// decimal-floating-point: finite and not negative.
export function decimalFloat(v, what) {
  if (typeof v !== 'number' || !isFinite(v) || v < 0) {
    throw new RangeError(what + ' must be a finite number >= 0 ' +
                         '(decimal-floating-point, RFC 8216 §4.2), got ' + v);
  }
  return v;
}

// A finite number in decimal positional notation (decimal-floating-point
// and signed-decimal-floating-point, RFC 8216 §4.2): String(n), but
// without the exponent JavaScript writes below 1e-6 and from 1e21 —
// DURATION=1e-7 and X-ID=1e+21 are not HLS numbers.
export function decimalNumber(n) {
  var s = String(n);
  var e = s.indexOf('e');
  if (e < 0) return s;
  var sign = s.charAt(0) === '-' ? '-' : '';
  var mant = s.slice(sign.length, e);
  var exp = parseInt(s.slice(e + 1), 10);
  var dot = mant.indexOf('.');
  var digits = mant.replace('.', '');
  var intLen = (dot < 0 ? mant.length : dot) + exp;
  if (intLen <= 0) return sign + '0.' + '0'.repeat(-intLen) + digits;
  if (intLen >= digits.length) return sign + digits + '0'.repeat(intLen - digits.length);
  return sign + digits.slice(0, intLen) + '.' + digits.slice(intLen);
}

// A URI line (RFC 8216 §4.1): CR / LF would end it and start another
// line (a segment URI 'a.ts\n#EXT-X-ENDLIST' ended the playlist), an empty
// one is a blank line readers skip (the segment vanished), and one that
// starts with '#' is read as a tag or comment.
export function checkUriLine(s, what) {
  if (s === '' || /[\r\n]/.test(s) || s.charAt(0) === '#') {
    throw new TypeError(what + ' ' + JSON.stringify(s) + ' cannot be a URI line ' +
                        '(empty, CR/LF, or a leading "#"; RFC 8216 §4.1)');
  }
  return s;
}


// An ISO/IEC 8601 date-time as START-DATE / END-DATE hold it (rfc8216bis
// §4.4.5.1): a complete calendar date, extended (YYYY-MM-DD) or basic
// (YYYYMMDD), alone or with 'T' and a time of day — hh:mm, hh:mm:ss or
// hh:mm:ss.s… (hhmm, hhmmss[.s…] in the basic format; ',' is a decimal
// sign too), 24:00:00 the end of the day, second 60 a leap second — and
// a UTC designator Z or an offset ±hh, ±hhmm, ±hh:mm. A time without
// one is UTC (the client SHOULD treat it so, §4.4.5.1). Ordinal and week
// dates, reduced dates (2024-01), expanded years (+002024) and the space
// separator RFC 3339 allows are not taken.
//
// Returns the instant as { sec, frac } — whole seconds since 1970 and
// the fraction of a second — or null when s is not such a date-time.
export function parseIsoDateTime(s) {
  var m = /^(\d{4})(-?)(\d{2})\2(\d{2})(?:T(\d{2})(:?)(\d{2})(?:\6(\d{2})(?:[.,](\d+))?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/.exec(s);
  if (!m) return null;
  var y = +m[1], mo = +m[3], d = +m[4];
  var leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  var mdays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (mo < 1 || mo > 12 || d < 1 || d > mdays[mo - 1]) return null;
  var h = 0, mi = 0, sec = 0, frac = 0, off = 0;
  if (m[5] !== undefined) {
    // The date's and the time's separators agree (both extended or both
    // basic: "2024-01-15T1200" mixes them).
    if ((m[2] === '-') !== (m[6] === ':')) return null;
    h = +m[5]; mi = +m[7];
    sec = m[8] !== undefined ? +m[8] : 0;
    frac = m[9] !== undefined ? parseFloat('0.' + m[9]) : 0;
    if (h > 24 || mi > 59 || sec > 60) return null;
    if (h === 24 && (mi !== 0 || sec !== 0 || frac !== 0)) return null;
    var z = m[10];
    if (z !== undefined && z !== 'Z') {
      var zh = +z.slice(1, 3);
      var zm = z.length > 3 ? +z.slice(z.length - 2) : 0;
      if (zh > 23 || zm > 59) return null;
      off = (z.charAt(0) === '-' ? -1 : 1) * (zh * 3600 + zm * 60);
    }
  }
  // Days since 1970-01-01 of the proleptic Gregorian date (H. Hinnant's
  // days_from_civil).
  var yy = mo <= 2 ? y - 1 : y;
  var era = Math.floor(yy / 400);
  var yoe = yy - era * 400;
  var doy = Math.floor((153 * (mo + (mo > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  var doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  var days = era * 146097 + doe - 719468;
  return { sec: days * 86400 + h * 3600 + mi * 60 + sec - off, frac: frac };
}
