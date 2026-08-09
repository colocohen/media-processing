// WebVTT Subtitle Encoder for HLS.
//
// Produces a stream of WebVTT segment files (.vtt) and an associated
// media playlist, both aligned to the same segmentDuration boundaries
// as the video/audio streams in a master playlist. Subtitles are
// referenced by master playlists via EXT-X-MEDIA:TYPE=SUBTITLES (see
// master-playlist.js).
//
// HLS subtitle constraints (RFC 8216 §4.3.2 + Apple "Authoring
// Specification for HLS"):
//   - Each segment is a self-contained WebVTT file
//   - First line is exactly "WEBVTT"
//   - Second line carries X-TIMESTAMP-MAP linking WebVTT local time
//     to MPEG-TS PTS — for our streams (start at PTS 0) the standard
//     mapping is "MPEGTS:0,LOCAL:00:00:00.000"
//   - Cue times use absolute stream time (HH:MM:SS.mmm), not segment-
//     relative
//   - Cues that span segment boundaries appear in EVERY segment they
//     intersect, with their full timing — players de-dupe on identifier
//
// Lifecycle:
//   - Caller adds cues with start/end in seconds
//   - As cues with start >= currentSegmentEnd arrive, the encoder
//     emits all segments whose end time precedes that cue
//   - On end()/flush(), all remaining segments are emitted

import EventEmitter from './core/events.js';
import Playlist from './playlist.js';
import { concat, fromAscii, writeU32BE, writeU16BE } from './core/bytes.js';

/**
 * @param {object} opts
 * @param {string} [opts.format='webvtt']     'webvtt' (text segments)
 *                                            or 'imsc' (TTML XML in fMP4
 *                                            stpp segments). IMSC is the
 *                                            premium OTT choice — richer
 *                                            styling, accessibility tags,
 *                                            ruby/RTL support.
 * @param {number} [opts.segmentDuration=4]   Target segment length, seconds.
 *                                            Should match the video stream's
 *                                            segmentDuration so the playlists
 *                                            stay aligned.
 * @param {string} [opts.segmentUriPattern]   URI template; '{n}' becomes
 *                                            the segment sequence number.
 *                                            Defaults: 'subs{n}.vtt' for
 *                                            WebVTT, 'subs{n}.m4s' for IMSC.
 * @param {string} [opts.initSegmentUri='subs-init.mp4']
 *                                            IMSC only. URI of the init
 *                                            segment (.mp4 with moov+stpp
 *                                            track). Emitted once before
 *                                            the first media segment.
 * @param {object} [opts.imsc]                IMSC-only styling overrides.
 * @param {object} [opts.imsc.region]         Region (positioning) overrides:
 *                                            { origin, extent, displayAlign }.
 *                                            Defaults position cues at the
 *                                            bottom of the safe area.
 * @param {object} [opts.imsc.style]          Style overrides: { fontFamily,
 *                                            fontSize, textAlign, color }.
 * @param {string} [opts.language]            BCP-47 language tag (default null).
 *                                            Surfaced in getRendition()
 *                                            and emitted as xml:lang in IMSC.
 * @param {string} [opts.mode='live']         'live' / 'event' / 'vod'.
 *                                            Same semantics as the media
 *                                            playlist's mode.
 * @param {number} [opts.windowSize=6]        Live sliding-window size.
 * @param {number} [opts.startTime=0]         Start time of the stream in
 *                                            seconds. Cues before this are
 *                                            rejected. Use to skip a warm-up
 *                                            period or align mid-stream.
 */
function SubtitleEncoder(opts) {
  if (!opts) opts = {};
  this._segmentDurationSec = opts.segmentDuration || 4;
  // FORMAT: 'webvtt' (default — text segments) or 'imsc' (TTML XML
  // wrapped in fMP4 stpp segments). IMSC enables far richer styling
  // and is the format used by Netflix, BBC, and most premium OTT.
  this._format = opts.format || 'webvtt';
  if (this._format !== 'webvtt' && this._format !== 'imsc') {
    throw new TypeError('SubtitleEncoder: format must be "webvtt" or "imsc"');
  }
  // Default URI pattern depends on format. WebVTT segments are .vtt
  // files; IMSC segments are fMP4 .m4s files.
  var defaultPattern = this._format === 'imsc' ? 'subs{n}.m4s' : 'subs{n}.vtt';
  this._segmentUriPattern  = opts.segmentUriPattern || defaultPattern;
  this._language = opts.language || null;
  this._mode = opts.mode || 'live';
  this._startTime = opts.startTime || 0;

  // IMSC-specific options. The TTML output uses one default region
  // and one default style — IMSC is designed for richer styling but
  // for HLS subtitles a single safe-area centered region is usually
  // what callers want. Override individual fields if needed.
  this._imscOpts = opts.imsc || {};
  this._imscRegion = {
    origin:       this._imscOpts.region && this._imscOpts.region.origin       || '10% 80%',
    extent:       this._imscOpts.region && this._imscOpts.region.extent       || '80% 15%',
    displayAlign: this._imscOpts.region && this._imscOpts.region.displayAlign || 'after',
  };
  this._imscStyle = {
    fontFamily: this._imscOpts.style && this._imscOpts.style.fontFamily || 'proportionalSansSerif',
    fontSize:   this._imscOpts.style && this._imscOpts.style.fontSize   || '100%',
    textAlign:  this._imscOpts.style && this._imscOpts.style.textAlign  || 'center',
    color:      this._imscOpts.style && this._imscOpts.style.color      || 'white',
  };
  // IMSC init segment URI — referenced via EXT-X-MAP in the playlist
  // and emitted once before the first media segment.
  this._initSegmentUri = opts.initSegmentUri || 'subs-init.mp4';
  // Track whether the init segment has been emitted yet. fMP4
  // playlists need the init bytes before any media; we emit on
  // the first segment flush.
  this._imscInitEmitted = false;

  this._ee = new EventEmitter();

  // The playlist for our subtitle segments. Subtitle playlists don't
  // need EXT-X-INDEPENDENT-SEGMENTS (subtitles have no decode
  // dependencies between segments anyway). For IMSC we DO set
  // initSegmentUri so EXT-X-MAP is emitted; for WebVTT we don't.
  this._playlist = new Playlist({
    mode:                this._mode,
    targetDuration:      Math.ceil(this._segmentDurationSec),
    windowSize:          opts.windowSize || 6,
    independentSegments: false,
    initSegmentUri:      this._format === 'imsc' ? this._initSegmentUri : null,
    // fMP4 stpp segments require version >= 6.
    version:             this._format === 'imsc' ? 6 : 3,
  });

  // Cues sorted by start time. Drained as segments emit — cues whose
  // end time is past the just-emitted segment are kept (they may also
  // belong to the next segment). The list is small (cues per active
  // window) so insertion-sort on add is cheap.
  this._cues = [];

  this._sequence = 0;                                  // next segment number
  this._currentSegmentStart = this._startTime;
  this._currentSegmentEnd   = this._startTime + this._segmentDurationSec;

  this._ended = false;
}

/**
 * Add a subtitle cue. May trigger emission of one or more segments
 * if the cue's start time is past the current segment end (i.e., the
 * caller has progressed the stream clock).
 *
 * Cues should generally be added in non-decreasing start order. A cue
 * arriving with start < currentSegmentStart (a segment that's already
 * been emitted) throws — the segment file is already finalized and
 * the playlist may have been published.
 *
 * @param {object} cue
 * @param {number} cue.start         Start time in seconds (>= startTime).
 * @param {number} cue.end           End time in seconds (> start).
 * @param {string} cue.text          Cue payload. Multi-line allowed.
 * @param {string} [cue.identifier]  WebVTT cue identifier (line before timing).
 *                                   Useful for cross-segment de-dup; players
 *                                   that see the same identifier in two
 *                                   adjacent segments treat it as one cue.
 * @param {string} [cue.settings]    Raw WebVTT cue settings appended to the
 *                                   timing line, e.g. 'align:center,line:80%'.
 *                                   Caller is responsible for syntax.
 */
SubtitleEncoder.prototype.addCue = function (cue) {
  if (this._ended) {
    throw new Error('SubtitleEncoder.addCue: cannot add after end()');
  }
  if (typeof cue !== 'object' || cue === null) {
    throw new TypeError('SubtitleEncoder.addCue: cue object required');
  }
  if (typeof cue.start !== 'number' || typeof cue.end !== 'number') {
    throw new TypeError('SubtitleEncoder.addCue: cue.start and cue.end (numbers) required');
  }
  if (cue.start >= cue.end) {
    throw new RangeError('SubtitleEncoder.addCue: cue.start must be < cue.end ' +
                         '(got ' + cue.start + ' >= ' + cue.end + ')');
  }
  if (typeof cue.text !== 'string') {
    throw new TypeError('SubtitleEncoder.addCue: cue.text (string) required');
  }
  // A cue identifier occupies its own line immediately before the
  // timing line. WebVTT forbids "-->" in it (§4.1) precisely because a
  // parser would then read that line AS the timing line, fail, and
  // discard the whole cue. A newline would split it into two lines with
  // the same effect. Both are unrecoverable in the output format, so
  // they are rejected at the API boundary rather than silently
  // producing a file that loses cues.
  if (cue.identifier !== undefined && cue.identifier !== null) {
    if (typeof cue.identifier !== 'string') {
      throw new TypeError('SubtitleEncoder.addCue: cue.identifier must be a string');
    }
    if (cue.identifier.indexOf('-->') >= 0 || /[\r\n]/.test(cue.identifier)) {
      throw new TypeError(
        'SubtitleEncoder.addCue: cue.identifier must not contain "-->" or a ' +
        'newline — WebVTT would parse it as the cue timing line and drop the cue'
      );
    }
  }
  if (cue.start < this._currentSegmentStart) {
    throw new RangeError(
      'SubtitleEncoder.addCue: cue.start (' + cue.start +
      ') is before currentSegmentStart (' + this._currentSegmentStart +
      '). The segment containing that time has already been emitted.');
  }

  // Insertion sort. For ordered input (the common case), this is O(1).
  // For out-of-order input within the active window, it's O(N) per add
  // but the window is small (one segment's worth, typically <50 cues).
  var entry = {
    start: cue.start,
    end:   cue.end,
    text:  cue.text,
    identifier: cue.identifier || null,
    settings:   cue.settings   || null,
  };
  var i = this._cues.length;
  this._cues.push(entry);
  while (i > 0 && this._cues[i - 1].start > entry.start) {
    this._cues[i] = this._cues[i - 1];
    i--;
  }
  this._cues[i] = entry;

  // Flush whatever segments are now safe to emit. A segment ending at
  // T is safe to emit once we see a cue with start >= T — at that
  // point all earlier cues are already known.
  while (this._currentSegmentEnd <= cue.start) {
    this._emitSegment();
  }
};

/**
 * Emit any segments still buffered as final output. Use at end-of-
 * stream when the caller knows no more cues are coming. Idempotent.
 */
SubtitleEncoder.prototype.flush = function () {
  if (this._ended) return;

  // Find the upper bound of buffered cue end-times. Anything past
  // that doesn't need a segment.
  var maxEnd = this._currentSegmentStart;
  for (var i = 0; i < this._cues.length; i++) {
    if (this._cues[i].end > maxEnd) maxEnd = this._cues[i].end;
  }

  while (this._currentSegmentStart < maxEnd) {
    this._emitSegment();
  }
};

/**
 * Finalize the stream: flush remaining segments and mark the playlist
 * complete (writes EXT-X-ENDLIST). Idempotent.
 */
SubtitleEncoder.prototype.end = function () {
  if (this._ended) return;
  this.flush();
  this._ended = true;
  this._playlist.end();
  // One final 'manifest' so subscribers see the ENDLIST marker.
  this._ee.emit('manifest', this._playlist.serialize());
};

/**
 * Build a media rendition descriptor for use in a master playlist.
 * The returned object plugs into buildMasterPlaylist's
 * subtitleRenditions array.
 *
 * @param {object} opts
 * @param {string} opts.groupId         Required. GROUP-ID (referenced
 *                                       by variants' SUBTITLES attribute).
 * @param {string} opts.name            Required. Display name (NAME=).
 * @param {string} opts.uri             Required. URI of this encoder's
 *                                       subtitle playlist (the .m3u8 file
 *                                       the caller is uploading).
 * @param {string} [opts.language]      BCP-47 tag; falls back to encoder's
 *                                       language opt.
 * @param {boolean} [opts.default]      DEFAULT=YES.
 * @param {boolean} [opts.autoselect]   AUTOSELECT=YES (default true).
 * @param {boolean} [opts.forced]       FORCED=YES — for foreign-language
 *                                       passages in an otherwise-native film.
 */
SubtitleEncoder.prototype.getRendition = function (opts) {
  if (!opts || typeof opts.groupId !== 'string') {
    throw new TypeError('SubtitleEncoder.getRendition: opts.groupId required');
  }
  if (typeof opts.name !== 'string') {
    throw new TypeError('SubtitleEncoder.getRendition: opts.name required');
  }
  if (typeof opts.uri !== 'string') {
    throw new TypeError('SubtitleEncoder.getRendition: opts.uri required');
  }
  return {
    groupId:    opts.groupId,
    name:       opts.name,
    uri:        opts.uri,
    language:   opts.language !== undefined ? opts.language : this._language,
    default:    !!opts.default,
    autoselect: opts.autoselect !== false,   // default true
    forced:     !!opts.forced,
    // For IMSC, expose the CODECS string so master-playlist can put it
    // into the variant's CODECS attribute. WebVTT subtitles don't need
    // a codec advertisement (it's the absence of fMP4 wrapping).
    codecs:     this._format === 'imsc' ? 'stpp.ttml.im1t' : null,
  };
};

/**
 * Most recent serialized playlist. Useful for VOD callers that don't
 * want to track 'manifest' events.
 */
SubtitleEncoder.prototype.serialize = function () {
  return this._playlist.serialize();
};

SubtitleEncoder.prototype.on = function (event, cb) {
  this._ee.on(event, cb); return this;
};
SubtitleEncoder.prototype.off = function (event, cb) {
  this._ee.off(event, cb); return this;
};

// ── Internals ─────────────────────────────────────────────

SubtitleEncoder.prototype._emitSegment = function () {
  var segStart = this._currentSegmentStart;
  var segEnd   = this._currentSegmentEnd;

  // Find all cues that overlap [segStart, segEnd). A cue overlaps if
  // its start is before segEnd AND its end is after segStart. Cues
  // are sorted by start, so we can stop once start >= segEnd.
  //
  // Cues spanning multiple segments appear in each segment they
  // intersect — we emit the cue's full timing in each, and players
  // use the WebVTT cue identifier (or IMSC xml:id) to merge them at
  // playback.
  var cuesInSegment = [];
  for (var i = 0; i < this._cues.length; i++) {
    var c = this._cues[i];
    if (c.start >= segEnd) break;
    if (c.end > segStart) cuesInSegment.push(c);
  }

  // For IMSC, emit the init segment lazily on the first media flush.
  // Init contains the moov box with the stpp track definition — once
  // per stream, never sliding-window'd, never repeated.
  if (this._format === 'imsc' && !this._imscInitEmitted) {
    var initBytes = _buildImscInit(this._language);
    this._ee.emit('segment', {
      kind:  'init',
      bytes: initBytes,
      uri:   this._initSegmentUri,
    });
    this._imscInitEmitted = true;
  }

  var segBytes;
  if (this._format === 'imsc') {
    segBytes = _buildImscMedia(
      cuesInSegment, segStart, segEnd, this._sequence,
      this._language, this._imscRegion, this._imscStyle
    );
  } else {
    segBytes = _buildVtt(cuesInSegment);
  }
  var uri = this._segmentUriPattern.replace('{n}', this._sequence);

  this._playlist.addSegment({
    uri:      uri,
    duration: this._segmentDurationSec,
  });

  this._ee.emit('segment', {
    kind:     'media',
    bytes:    segBytes,
    uri:      uri,
    duration: this._segmentDurationSec,
    sequence: this._sequence,
    cues:     cuesInSegment.length,
  });
  this._ee.emit('manifest', this._playlist.serialize());

  // Drop cues that are wholly behind the just-emitted segment. Cues
  // ending at exactly segEnd are dropped too (their last instant of
  // display is at the segment boundary, not after).
  var keep = [];
  for (var j = 0; j < this._cues.length; j++) {
    if (this._cues[j].end > segEnd) keep.push(this._cues[j]);
  }
  this._cues = keep;

  this._sequence++;
  this._currentSegmentStart = segEnd;
  this._currentSegmentEnd   = segEnd + this._segmentDurationSec;
};

// ── WebVTT serialization ──────────────────────────────────

/**
 * Format a number of seconds as WebVTT timestamp HH:MM:SS.mmm.
 * Per spec §3.3, hours are required when the duration is >= 1h
 * but allowed unconditionally; we always include hours for
 * predictable output formatting (Apple HLS validators expect it).
 */
function _formatVttTime(secondsFloat) {
  return _formatHhMmSsMs(secondsFloat);
}

/**
 * Format seconds as `HH:MM:SS.mmm`. Both WebVTT (§3.3) and TTML clock-
 * time (§10.3.1) use this exact format with millisecond precision. We
 * always include the hours field even when zero, for parser
 * compatibility (Apple's validators expect it for WebVTT, IMSC
 * decoders accept it everywhere).
 *
 * Negative inputs clamp to 0.
 */
function _formatHhMmSsMs(secondsFloat) {
  if (secondsFloat < 0) secondsFloat = 0;
  var totalMs = Math.round(secondsFloat * 1000);
  var ms      = totalMs % 1000;
  var totalS  = (totalMs - ms) / 1000;
  var s       = totalS % 60;
  var totalM  = (totalS - s) / 60;
  var m       = totalM % 60;
  var h       = (totalM - m) / 60;

  var hh = h < 10 ? '0' + h : '' + h;
  var mm = m < 10 ? '0' + m : '' + m;
  var ss = s < 10 ? '0' + s : '' + s;
  var mmm;
  if (ms < 10)       mmm = '00' + ms;
  else if (ms < 100) mmm = '0' + ms;
  else               mmm = '' + ms;
  return hh + ':' + mm + ':' + ss + '.' + mmm;
}

/**
 * Render a list of cues as a WebVTT segment file. Always emits the
 * standard HLS header (WEBVTT + X-TIMESTAMP-MAP) even when there
 * are no cues — players accept empty subtitle segments.
 */
function _buildVtt(cues) {
  var lines = [];
  lines.push('WEBVTT');
  // X-TIMESTAMP-MAP locks WebVTT local time to MPEG-TS PTS. For our
  // streams (PTS starts at 0), the identity mapping is correct.
  lines.push('X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000');
  lines.push('');

  for (var i = 0; i < cues.length; i++) {
    var c = cues[i];
    if (c.identifier) {
      // WebVTT cue identifiers go on a line by themselves before the
      // timing line. Players use them to de-dupe cross-segment cues.
      lines.push(c.identifier);
    }
    var timing = _formatVttTime(c.start) + ' --> ' + _formatVttTime(c.end);
    if (c.settings) timing += ' ' + c.settings;
    lines.push(timing);
    // Cue payload, sanitised. WebVTT's block structure makes two things
    // in the text unrepresentable, and passing them through verbatim
    // silently corrupted the file:
    //
    //   - A BLANK LINE terminates the cue (§3.4). Text like
    //     "line one\n\nline two" produced a cue containing only
    //     "line one"; "line two" was then read as the IDENTIFIER of the
    //     next block, which had no timing line, so that cue was dropped
    //     too. One blank line cost two cues.
    //
    //   - "-->" inside the payload is forbidden and leads parsers to
    //     treat the line as a timing line.
    //
    // Both come from real content (transcripts, translations, ASR
    // output), so throwing would be hostile. Blank lines collapse to a
    // single line break, which preserves the visible text; "-->" is
    // written as the entity form, which WebVTT renders as "-->".
    lines.push(_sanitizeVttPayload(c.text));
    lines.push('');
  }

  // UTF-8 encode. Subtitles are text and must be UTF-8 per WebVTT spec.
  var text = lines.join('\n');
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(text);
  }
  // Node fallback (older runtimes without global TextEncoder)
  return _utf8Encode(text);
}

/**
 * Make arbitrary text safe to place inside a WebVTT cue payload.
 * See the call site for why each substitution is necessary.
 */
function _sanitizeVttPayload(text) {
  return String(text)
    // Normalise line endings first so the blank-line collapse below
    // sees a single form.
    .replace(/\r\n?/g, '\n')
    // Two or more line breaks (optionally with whitespace between)
    // become one: a payload cannot contain an empty line.
    .replace(/\n[ \t]*(?=\n)/g, '')
    // Trailing newline would create the terminating blank line early.
    .replace(/\n+$/, '')
    // "-->" is structural; the entity form renders identically.
    .replace(/-->/g, '--&gt;');
}

/**
 * Minimal UTF-8 encoder for environments without TextEncoder. Handles
 * the BMP and supplementary planes via surrogate-pair decoding. Used
 * only as a fallback — modern Node and all browsers have TextEncoder.
 */
function _utf8Encode(str) {
  var bytes = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
    } else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) {
      // High surrogate — combine with low surrogate to recover code point
      var c2 = str.charCodeAt(i + 1);
      var cp = 0x10000 + ((c & 0x3FF) << 10) + (c2 & 0x3FF);
      bytes.push(
        0xF0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3F),
        0x80 | ((cp >> 6)  & 0x3F),
        0x80 | (cp & 0x3F));
      i++;
    } else {
      bytes.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
    }
  }
  return new Uint8Array(bytes);
}


// ── IMSC / TTML / fMP4 stpp ───────────────────────────────────
//
// IMSC1 Text Profile is a constrained TTML2 dialect designed for
// subtitles and captions in OTT and broadcast. We produce one self-
// contained TTML document per fMP4 segment, wrapped in the stpp
// codec format (ISO/IEC 14496-30).
//
// Each IMSC segment is a complete TTML document (not a fragment) —
// players parse and apply it independently. This is what HLS expects
// per Apple's "HLS Authoring Specification for Apple Devices".
//
// References:
//   IMSC1 Text Profile: https://www.w3.org/TR/ttml-imsc1.0.1/
//   stpp encapsulation: ISO/IEC 14496-30 §7
//   HLS authoring:      developer.apple.com/streaming/HLS-Authoring-...

/**
 * Format seconds as TTML clock-time (`HH:MM:SS.mmm`). TTML §10.3.1
 * matches the WebVTT format exactly so we share the helper.
 */
function _formatTtmlTime(secondsFloat) {
  return _formatHhMmSsMs(secondsFloat);
}

/**
 * XML-escape text. TTML cue text is XML PCDATA so the five base
 * entities (& < > " ') must be replaced. We don't strip control
 * characters — caller is responsible for sane input.
 */
function _xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Build a complete IMSC1 Text Profile TTML document for one segment.
 * One <p> per cue; each cue gets a unique xml:id so cross-segment
 * cues can be merged by the player.
 *
 * Per IMSC §6.1, the document must declare timeBase (we use "media"
 * — relative to the presentation timeline), profile, and root
 * xml:lang. Style and Region are inlined per the segmentation rules
 * in IMSC §11 — every segment must be self-contained.
 */
function _buildTtmlDocument(cues, language, region, style) {
  var lang = language || 'und';   // BCP-47 'undetermined' if no lang set

  var lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    '<tt xmlns="http://www.w3.org/ns/ttml"' +
    ' xmlns:ttp="http://www.w3.org/ns/ttml#parameter"' +
    ' xmlns:tts="http://www.w3.org/ns/ttml#styling"' +
    ' xmlns:ttm="http://www.w3.org/ns/ttml#metadata"' +
    ' ttp:profile="http://www.w3.org/ns/ttml/profile/imsc1/text"' +
    ' ttp:timeBase="media"' +
    ' xml:lang="' + _xmlEscape(lang) + '">'
  );
  lines.push('  <head>');
  lines.push('    <styling>');
  lines.push(
    '      <style xml:id="s0"' +
    ' tts:fontFamily="' + _xmlEscape(style.fontFamily) + '"' +
    ' tts:fontSize="' + _xmlEscape(style.fontSize) + '"' +
    ' tts:textAlign="' + _xmlEscape(style.textAlign) + '"' +
    ' tts:color="' + _xmlEscape(style.color) + '"/>'
  );
  lines.push('    </styling>');
  lines.push('    <layout>');
  lines.push(
    '      <region xml:id="r0"' +
    ' tts:origin="' + _xmlEscape(region.origin) + '"' +
    ' tts:extent="' + _xmlEscape(region.extent) + '"' +
    ' tts:displayAlign="' + _xmlEscape(region.displayAlign) + '"/>'
  );
  lines.push('    </layout>');
  lines.push('  </head>');
  lines.push('  <body>');
  lines.push('    <div>');

  for (var i = 0; i < cues.length; i++) {
    var c = cues[i];
    // xml:id per cue gives players a stable handle for cross-segment
    // de-dup. Use the caller's identifier if provided, else synthesize.
    var idAttr = c.identifier ? c.identifier : ('c' + i);
    // TTML allows multi-line cues via <br/>. Replace LF with <br/>.
    // Convert \n\n to a paragraph break is also possible but uncommon
    // in HLS subtitles — single <br/> per line is the convention.
    var textHtml = _xmlEscape(c.text).replace(/\r?\n/g, '<br/>');
    lines.push(
      '      <p xml:id="' + _xmlEscape(idAttr) + '"' +
      ' begin="' + _formatTtmlTime(c.start) + '"' +
      ' end="' + _formatTtmlTime(c.end) + '"' +
      ' region="r0" style="s0">' +
      textHtml +
      '</p>'
    );
  }

  lines.push('    </div>');
  lines.push('  </body>');
  lines.push('</tt>');

  var doc = lines.join('\n');
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(doc);
  }
  return _utf8Encode(doc);
}

// ── Tiny inline mp4 box helpers (self-contained for stpp) ──
//
// The basic byte primitives (u32be, u16be, ascii, concat) come from
// bytes.js — those are shared with writer-fmp4.js.
//
// Box-construction helpers (_box, _fullBox) are tiny enough that we
// keep them local rather than coupling to writer-fmp4 (which is full
// of AV-specific machinery we don't need). If a future feature needs
// a third place to build boxes, extract these to a shared mp4-box.js.

/** Allocate a 4-byte big-endian u32 as a fresh Uint8Array. */
function _u32be(n) {
  var b = new Uint8Array(4);
  writeU32BE(b, 0, n);
  return b;
}

/** Allocate a 2-byte big-endian u16 as a fresh Uint8Array. */
function _u16be(n) {
  var b = new Uint8Array(2);
  writeU16BE(b, 0, n);
  return b;
}

/**
 * Build a basic MP4 box: 8-byte header (size + 4-char type) + payload.
 */
function _box(type, payload) {
  var size = 8 + payload.length;
  return concat([_u32be(size), fromAscii(type), payload]);
}

/**
 * Build a "full box" — basic box with an extra 1-byte version + 3-byte
 * flags prefix in payload. Most boxes inside `moov` and `moof` are
 * full boxes.
 */
function _fullBox(type, version, flags, payload) {
  var head = new Uint8Array(4);
  head[0] = version & 0xFF;
  head[1] = (flags >>> 16) & 0xFF;
  head[2] = (flags >>> 8) & 0xFF;
  head[3] = flags & 0xFF;
  return _box(type, concat([head, payload]));
}

/**
 * Build the IMSC fMP4 init segment — a self-contained ftyp+moov for
 * a single 'subt' track with an stpp sample entry. Same init is used
 * for all media segments in the playlist.
 *
 * Track structure (ISO 14496-12 + ISO 14496-30):
 *   moov
 *     mvhd  (version 0, timescale 1000ms, duration 0)
 *     trak  (track_id=1)
 *       tkhd  (track header)
 *       mdia
 *         mdhd  (timescale 1000ms, language)
 *         hdlr  (handler_type='subt')
 *         minf
 *           sthd  (subtitle media header — no payload)
 *           dinf -> dref -> url (self-contained)
 *           stbl
 *             stsd -> stpp sample entry
 *             stts/stsc/stsz/stco  (all empty in fragmented init)
 *     mvex
 *       trex  (default sample flags)
 */
function _buildImscInit(language) {
  var lang = language || 'und';
  // ISO 639-2 language packing for mdhd: 5 bits per letter, 3 letters,
  // each (letter - 0x60). MDHD language is 16 bits with high bit zero.
  // BCP-47 "und" = "und" 3-letter code.
  var langCode = (lang.length >= 3 ? lang.substring(0, 3) : 'und').toLowerCase();
  var langBits = (
    ((langCode.charCodeAt(0) - 0x60) & 0x1F) << 10 |
    ((langCode.charCodeAt(1) - 0x60) & 0x1F) << 5 |
    ((langCode.charCodeAt(2) - 0x60) & 0x1F)
  ) & 0x7FFF;

  // ftyp: brand 'iso6' (CMAF requires iso6+) with compatible cmfc/iso5.
  var ftyp = _box('ftyp', concat([
    fromAscii('iso6'),       // major_brand
    _u32be(1),             // minor_version
    fromAscii('iso6'),       // compatible_brand 1
    fromAscii('cmfc'),       // compatible_brand 2 (CMAF)
    fromAscii('iso5'),       // compatible_brand 3 (legacy fragmented)
  ]));

  // mvhd (version 0): 100 bytes total payload after FullBox header
  //   creation/modification times (4+4)
  //   timescale (4) = 1000
  //   duration (4) = 0 (open-ended/fragmented)
  //   rate (4) = 0x00010000 (1.0)
  //   volume (2) = 0x0100 (1.0)
  //   reserved (10)
  //   matrix (36) = identity
  //   pre_defined (24)
  //   next_track_ID (4) = 2
  var mvhdPayload = new Uint8Array(96);
  // ts/duration/rate/etc — write bytes manually
  // creation_time, modification_time = 0
  // (bytes 0-7 zero by default)
  writeU32BE(mvhdPayload, 8, 1000);                     // timescale
  writeU32BE(mvhdPayload, 12, 0);                       // duration
  writeU32BE(mvhdPayload, 16, 0x00010000);              // rate
  mvhdPayload[20] = 0x01; mvhdPayload[21] = 0x00;  // volume 1.0
  // reserved 22-23 + 24-31 zero
  // matrix at offset 32: 0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000
  writeU32BE(mvhdPayload, 32, 0x00010000);
  writeU32BE(mvhdPayload, 48, 0x00010000);
  writeU32BE(mvhdPayload, 64, 0x40000000);
  // pre_defined 68-91 zero
  writeU32BE(mvhdPayload, 92, 2);                       // next_track_ID
  var mvhd = _fullBox('mvhd', 0, 0, mvhdPayload);

  // tkhd (version 0, flags=7 — track enabled+in_movie+in_preview)
  //   creation/modification 0
  //   track_ID = 1
  //   reserved
  //   duration = 0
  //   reserved (8)
  //   layer/alternate_group (4)
  //   volume (2)
  //   reserved (2)
  //   matrix (36) identity
  //   width/height (4+4) = 0 for subtitle tracks
  var tkhdPayload = new Uint8Array(80);
  writeU32BE(tkhdPayload, 0, 0);                       // creation_time
  writeU32BE(tkhdPayload, 4, 0);                       // modification_time
  writeU32BE(tkhdPayload, 8, 1);                       // track_ID
  writeU32BE(tkhdPayload, 12, 0);                      // reserved
  writeU32BE(tkhdPayload, 16, 0);                      // duration
  // 20-27 reserved
  // 28-31 layer+alternate_group
  // 32-33 volume = 0 for subtitle
  // 34-35 reserved
  writeU32BE(tkhdPayload, 36, 0x00010000);
  writeU32BE(tkhdPayload, 52, 0x00010000);
  writeU32BE(tkhdPayload, 68, 0x40000000);
  writeU32BE(tkhdPayload, 72, 0);                      // width
  writeU32BE(tkhdPayload, 76, 0);                      // height
  var tkhd = _fullBox('tkhd', 0, 0x07, tkhdPayload);

  // mdhd (version 0): 20 bytes payload
  //   creation/modification (4+4)
  //   timescale (4) = 1000
  //   duration (4) = 0
  //   language (2) packed
  //   pre_defined (2)
  var mdhdPayload = new Uint8Array(20);
  writeU32BE(mdhdPayload, 8, 1000);                    // timescale (ms)
  writeU32BE(mdhdPayload, 12, 0);                      // duration
  mdhdPayload[16] = (langBits >>> 8) & 0x7F;
  mdhdPayload[17] = langBits & 0xFF;
  var mdhd = _fullBox('mdhd', 0, 0, mdhdPayload);

  // hdlr (handler_type='subt' for subtitle media)
  //   pre_defined (4) = 0
  //   handler_type (4) = 'subt'
  //   reserved (12) = 0
  //   name (string, null-terminated)
  var nameBytes = _utf8Encode('SubtitleHandler');
  var hdlrPayload = concat([
    _u32be(0),                  // pre_defined
    fromAscii('subt'),
    _u32be(0), _u32be(0), _u32be(0),
    nameBytes,
    new Uint8Array([0]),
  ]);
  var hdlr = _fullBox('hdlr', 0, 0, hdlrPayload);

  // sthd: SubtitleMediaHeaderBox — empty FullBox
  var sthd = _fullBox('sthd', 0, 0, new Uint8Array(0));

  // dref/dinf — self-contained data reference
  var url = _fullBox('url ', 0, 0x01, new Uint8Array(0));   // self-contained flag
  var drefPayload = concat([_u32be(1), url]);              // entry_count=1
  var dref = _fullBox('dref', 0, 0, drefPayload);
  var dinf = _box('dinf', dref);

  // stsd with stpp sample entry. stpp structure (ISO 14496-30 §7.2):
  //   reserved (6)
  //   data_reference_index (2) = 1
  //   namespace (utf-8 string + NUL)
  //   schema_location (utf-8 string + NUL)
  //   auxiliary_mime_types (utf-8 string + NUL)
  var ns = _utf8Encode('http://www.w3.org/ns/ttml');
  var stppPayload = concat([
    new Uint8Array(6),                    // reserved
    _u16be(1),                            // data_reference_index
    ns, new Uint8Array([0]),              // namespace + NUL
    new Uint8Array([0]),                  // schema_location empty + NUL
    new Uint8Array([0]),                  // auxiliary_mime_types empty + NUL
  ]);
  var stpp = _box('stpp', stppPayload);

  var stsdPayload = concat([_u32be(1), stpp]);   // entry_count=1
  var stsd = _fullBox('stsd', 0, 0, stsdPayload);

  // Empty stts/stsc/stsz/stco for fragmented init
  var stts = _fullBox('stts', 0, 0, _u32be(0));
  var stsc = _fullBox('stsc', 0, 0, _u32be(0));
  // stsz: sample_size(4)=0 + sample_count(4)=0 + (no entries)
  var stszPayload = concat([_u32be(0), _u32be(0)]);
  var stsz = _fullBox('stsz', 0, 0, stszPayload);
  var stco = _fullBox('stco', 0, 0, _u32be(0));

  var stbl = _box('stbl', concat([stsd, stts, stsc, stsz, stco]));
  var minf = _box('minf', concat([sthd, dinf, stbl]));
  var mdia = _box('mdia', concat([mdhd, hdlr, minf]));
  var trak = _box('trak', concat([tkhd, mdia]));

  // mvex + trex (default sample flags so trun is small)
  // trex: track_ID(4) + default_sample_description_index(4) +
  //       default_sample_duration(4) + default_sample_size(4) +
  //       default_sample_flags(4)
  var trexPayload = concat([
    _u32be(1),     // track_ID
    _u32be(1),     // default_sample_description_index
    _u32be(0),     // default_sample_duration
    _u32be(0),     // default_sample_size
    _u32be(0),     // default_sample_flags
  ]);
  var trex = _fullBox('trex', 0, 0, trexPayload);
  var mvex = _box('mvex', trex);

  var moov = _box('moov', concat([mvhd, trak, mvex]));
  return concat([ftyp, moov]);
}

/**
 * Build a single IMSC media segment (.m4s): moof + mdat with one
 * sample = a complete TTML document covering the segment's time
 * window. The segment is self-contained for parsing per IMSC §11
 * (every segment is a complete document with all referenced styles
 * and regions).
 *
 * The TTML 'begin' attribute uses absolute media-time per timeBase=
 * "media", so cues spanning multiple segments display correctly.
 * The fMP4 sample's tfdt sets the segment's start time on the media
 * timeline (in 1000ms ticks).
 */
function _buildImscMedia(cues, segStart, segEnd, sequence, language, region, style) {
  // 1. Build the TTML document for this segment's cues.
  var ttmlBytes = _buildTtmlDocument(cues, language, region, style);

  // 2. mdat = box header + raw TTML bytes.
  var mdat = _box('mdat', ttmlBytes);

  // 3. moof: mfhd + traf(tfhd + tfdt + trun).
  // mfhd: sequence_number
  var mfhd = _fullBox('mfhd', 0, 0, _u32be(sequence + 1));   // 1-based per spec

  // tfhd flags = 0x020000 (default-base-is-moof) | 0x000020 (default_sample_flags)
  // Plus we'll set sample_duration via trun (0x000100 in trun flags).
  // Actually simplest: tfhd with NO flags (uses trex defaults) plus
  // trun with sample_count=1, sample_duration set per-sample.
  // tfhd payload: track_ID(4)
  var tfhd = _fullBox('tfhd', 0, 0x020000, _u32be(1));   // default-base-is-moof
  var segDurationTicks = Math.round((segEnd - segStart) * 1000);
  var baseDecodeTicks  = Math.round(segStart * 1000);
  // tfdt v1: baseMediaDecodeTime as u64 — we use v0 (u32) since
  // 1000ms * Number.MAX_SAFE_INTEGER / 1000 covers eons of streams,
  // but Number.MAX_SAFE_INTEGER is safer with v1. Use v1.
  var tfdtPayload = new Uint8Array(8);
  // upper 32 bits = 0 (we won't exceed 2^32 ms = ~50 days)
  writeU32BE(tfdtPayload, 0, 0);
  writeU32BE(tfdtPayload, 4, baseDecodeTicks >>> 0);
  var tfdt = _fullBox('tfdt', 1, 0, tfdtPayload);

  // trun with sample_count=1, including:
  //   flags = 0x000001 (data-offset-present) | 0x000100 (sample-duration-present)
  //         | 0x000200 (sample-size-present)
  // Layout (after FullBox header):
  //   sample_count(4)
  //   data_offset(4)        — patched with offset to mdat bytes
  //   sample[0]:
  //     duration(4)
  //     size(4)
  var trunPayload = new Uint8Array(4 + 4 + 8);
  writeU32BE(trunPayload, 0, 1);                        // sample_count
  writeU32BE(trunPayload, 4, 0);                        // data_offset (patched below)
  writeU32BE(trunPayload, 8, segDurationTicks);         // sample_duration
  writeU32BE(trunPayload, 12, ttmlBytes.length);        // sample_size
  var trun = _fullBox('trun', 0, 0x000301, trunPayload);

  // Assemble traf and moof.
  var traf = _box('traf', concat([tfhd, tfdt, trun]));
  var moof = _box('moof', concat([mfhd, traf]));

  // Patch trun.data_offset = offset from start of moof to first byte
  // of mdat payload. That's: moof.length + 8 (mdat header).
  var dataOffset = moof.length + 8;
  // trun.data_offset is at:
  //   moof header (8) + mfhd (size) + traf header (8) + tfhd (size)
  //   + tfdt (size) + FullBox header in trun (12) + sample_count (4)
  // Find the position of trun's data_offset in the assembled moof.
  // Simpler: locate inside moof by computing offsets we know.
  var trunOffsetInMoof =
    8 +              // moof box header
    mfhd.length +    // mfhd
    8 +              // traf box header
    tfhd.length +    // tfhd
    tfdt.length +    // tfdt
    12 +             // trun box header (8) + version/flags (4)
    4;               // sample_count
  writeU32BE(moof, trunOffsetInMoof, dataOffset);

  // Optional styp (segment type) at start. Strict parsers need it
  // for byte-range fetches; we always emit it for safety. Brand 'msdh'
  // (Movie Fragment Sequence Data Header) for fragmented segments.
  var styp = _box('styp', concat([
    fromAscii('msdh'),
    _u32be(0),
    fromAscii('msdh'),
    fromAscii('msix'),
  ]));

  return concat([styp, moof, mdat]);
}


export default SubtitleEncoder;
