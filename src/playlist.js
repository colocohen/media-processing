/**
 * playlist — HLS Media Playlist (m3u8) generator (RFC 8216).
 *
 * Pure in-memory state machine. Given segment metadata (URI + duration),
 * produces standards-compliant m3u8 text suitable for hosting on any
 * HTTP server / CDN — every HLS player on the planet knows how to read
 * the output.
 *
 * Three playlist modes:
 *
 *   live   — Sliding window. Old segments fall off the front as new
 *            ones are appended; MEDIA-SEQUENCE tracks the absolute
 *            index of the first segment still in the playlist.
 *            Apple-style live; matches FFmpeg's `-hls_list_size 6`
 *            default. No ENDLIST until end() is called.
 *
 *   event  — Append-only. Segments accumulate forever; viewers
 *            arriving late can seek all the way back to start. Used
 *            for "live broadcasts you can rewind" — concerts,
 *            conferences, sports. PLAYLIST-TYPE:EVENT tag set, no
 *            ENDLIST until end().
 *
 *   vod    — Final, immutable. All segments listed, ENDLIST present
 *            from first serialize(). PLAYLIST-TYPE:VOD tag set.
 *
 * Usage:
 *   var p = new Playlist({ mode: 'live', windowSize: 6 });
 *   p.addSegment({ uri: 'seg0.ts', duration: 5.005 });
 *   p.addSegment({ uri: 'seg1.ts', duration: 5.992 });
 *   serverWriteFile('playlist.m3u8', p.serialize());
 *
 * Notes on conformance:
 *   - We always emit EXT-X-INDEPENDENT-SEGMENTS by default. Every
 *     segment we produce starts at an IDR with parameter sets — that's
 *     how the encoder splits in the first place — so each segment IS
 *     independently decodable. Setting the tag tells players they can
 *     start playback at any segment without waiting for context.
 *   - EXT-X-VERSION is computed at serialize time as the lowest
 *     version the output needs (RFC 8216 §7 / rfc8216bis §8): 3 for
 *     float EXTINF, 4 BYTERANGE / I-FRAMES-ONLY, 5 KEYFORMAT, 6 EXT-X-MAP
 *     (5 in an I-frames-only playlist), 8 EXT-X-DEFINE (11 QUERYPARAM),
 *     9 EXT-X-SKIP (10 when it also skips DATERANGEs). opts.version is
 *     a floor.
 *   - TARGETDURATION: opts.targetDuration when given (recommended, and
 *     required in practice for live). Otherwise VOD uses ceil(longest
 *     EXTINF) and live/event pin it at the first segment, because a live
 *     playlist's target duration MUST NOT change (RFC 8216 §6.2.1).
 */


/**
 * @param {object}  opts
 * @param {string}  [opts.mode='live']         'vod' | 'live' | 'event'
 * @param {number}  [opts.windowSize=6]        Sliding window size; live only.
 * @param {number}  [opts.targetDuration]      Explicit TARGETDURATION (sec).
 *                                             Auto-computed from segments if
 *                                             unset.
 * @param {number}  [opts.version]             Minimum EXT-X-VERSION. The
 *                                             written value is raised to
 *                                             what the features in use
 *                                             require.
 * @param {boolean} [opts.independentSegments=true]  Emit
 *                                             EXT-X-INDEPENDENT-SEGMENTS.
 * @param {number}  [opts.startMediaSequence=0]  Initial MEDIA-SEQUENCE.
 *                                             Useful when resuming a stream.
 * @param {string}  [opts.initSegmentUri]      URI of the init segment for
 *                                             fMP4 streams. When set,
 *                                             #EXT-X-MAP is emitted before
 *                                             the segment list. Leave unset
 *                                             for TS streams.
 */

import { escapeQuoted, isValidVariableName, isValidIvHex, isValidKeyFormatVersions,
         isValidEncryptionMethod, parseAttributeList,
         parseByteRange, decimalInteger as _decimalInteger,
         decimalFloat as _decimalFloat, decimalNumber as _decimalNumber,
         checkUriLine as _checkUriLine,
         parseIsoDateTime as _parseIsoDateTime } from './utils/playlist_utils.js';

function Playlist(opts) {
  if (!opts) opts = {};

  var mode = opts.mode || 'live';
  if (mode !== 'vod' && mode !== 'live' && mode !== 'event') {
    throw new Error('Playlist: mode must be vod, live, or event (got ' + mode + ')');
  }

  this._mode = mode;
  this._windowSize = opts.windowSize || 6;
  // TARGETDURATION is a decimal-integer (RFC 8216 §4.3.3.1), so a
  // fractional value from the caller is rounded up, never down.
  // A target that is not a positive finite number (-2, Infinity) used to
  // be written as it was: TARGETDURATION:-2.
  if (opts.targetDuration && !(isFinite(opts.targetDuration) && opts.targetDuration > 0)) {
    throw new RangeError('Playlist: opts.targetDuration must be a finite number > 0, got ' +
                         opts.targetDuration);
  }
  // A decimal-integer is at most 2^64-1 (RFC 8216 §4.2): from 1e21 the
  // target was written with an exponent (TARGETDURATION:1e+21).
  if (opts.targetDuration && Math.ceil(opts.targetDuration) >= _TWO_64) {
    throw new RangeError('Playlist: opts.targetDuration must be below 2^64 ' +
                         '(TARGETDURATION is a decimal-integer, RFC 8216 §4.2), got ' +
                         opts.targetDuration);
  }
  this._explicitTargetDuration = opts.targetDuration ? Math.ceil(opts.targetDuration) : 0;
  this._computedTargetDuration = 0;
  // Largest EXTINF rounded to the nearest integer — the quantity
  // RFC 8216 §4.3.3.1 compares against TARGETDURATION.
  this._maxRoundedDuration = 0;
  // Live/event without an explicit target: the value is pinned at the
  // first segment. It used to be recomputed as the running max, so a
  // live playlist went TARGETDURATION:2 -> 5 when one 4.2 s segment
  // arrived; RFC 8216 §6.2.1 says the target duration MUST NOT change.
  this._pinnedTargetDuration = 0;
  // EXT-X-VERSION. opts.version is a floor; the version actually written
  // is computed at serialize time from the features the output uses
  // (_requiredVersion). Before, it was 3 (or 6 with an init segment)
  // whatever the content, so a playlist with KEYFORMAT, BYTERANGE or
  // EXT-X-DEFINE claimed VERSION:3, which strict clients reject.
  this._version = opts.version || 3;
  this._independentSegments = opts.independentSegments !== false;
  this._initSegmentUri = opts.initSegmentUri || null;
  // EXT-X-MAP's URI is a quoted-string (checked here, at the call that
  // passed it, as every quoted-string of this module — see addDateRange).
  if (this._initSegmentUri) escapeQuoted(this._initSegmentUri);
  // Optional BYTERANGE on EXT-X-MAP. When the init segment is part
  // of a larger file (single-file CMAF where init + media are
  // byteranges in one .mp4), the player needs to know which bytes
  // form the init. Format: { length, offset } or null.
  this._initSegmentByterange = opts.initSegmentByterange || null;
  // EXT-X-MAP's BYTERANGE is "<n>@<o>" with the offset REQUIRED
  // (rfc8216bis §4.4.4.5); both decimal-integers.
  if (this._initSegmentByterange) {
    _decimalInteger(this._initSegmentByterange.length, 'Playlist: opts.initSegmentByterange.length');
    _decimalInteger(this._initSegmentByterange.offset, 'Playlist: opts.initSegmentByterange.offset');
  }

  this._segments = [];
  this._mediaSequence = opts.startMediaSequence || 0;

  // EXT-X-I-FRAMES-ONLY signals that every Media Segment in this
  // playlist holds a single I-frame, with playback duration set by
  // EXTINF. Used for trick play (FF/RW, scrub thumbnails). When true,
  // segments must be added with byterange pointing at the keyframe's
  // bytes within the parent media file.
  this._iFramesOnly = !!opts.iFramesOnly;

  // EXT-X-DISCONTINUITY-SEQUENCE tracks how many discontinuities have
  // dropped off the front of a sliding window. Players use it to
  // disambiguate timestamp resets across segments — without it, a
  // viewer who joins mid-stream might see two segments with PTS=0 and
  // not know they belong to different epochs.
  this._discontinuitySequence = 0;

  this._endlist = false;

  // ── LL-HLS partial-segment state ──
  // Set partTargetDuration > 0 to enable LL-HLS output. Players see:
  //   #EXT-X-PART-INF:PART-TARGET=<sec>
  //   #EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=<sec>
  //   #EXT-X-PART:DURATION=<sec>,URI="...",BYTERANGE="<n>@<off>",INDEPENDENT=YES
  //
  // PART-HOLD-BACK is a hint to the player: how far from the live
  // edge it should hold playback (in seconds). Apple's LL-HLS spec
  // recommends >= 3 × PART-TARGET. We use 3.0× by default; caller
  // can override via opts.partHoldBack.
  //
  // _partsBySegment[mediaSeq] = [{ duration, uri, byteOffset, byteLength,
  //                                independent, final }]
  // Stored alongside _segments so sliding-window cleanup removes both.
  this._partTargetDuration = opts.partTargetDuration || 0;
  this._partHoldBack = opts.partHoldBack ||
                       (this._partTargetDuration > 0 ? this._partTargetDuration * 3 : 0);
  // rfc8216bis §4.4.3.8: PART-HOLD-BACK MUST be at least twice the Part
  // Target Duration (a hold-back of 0.5 s for 1 s parts was written as it
  // was), and PART-TARGET / PART-HOLD-BACK are decimal-floating-points
  // (Infinity was written as "Infinity").
  if (this._partTargetDuration > 0) {
    if (!isFinite(this._partTargetDuration)) {
      throw new RangeError('Playlist: opts.partTargetDuration must be finite, got ' +
                           this._partTargetDuration);
    }
    if (!(this._partHoldBack >= 2 * this._partTargetDuration) || !isFinite(this._partHoldBack)) {
      throw new RangeError('Playlist: opts.partHoldBack must be a finite number of at least ' +
                           'twice partTargetDuration (RFC 8216bis §4.4.3.8), got ' + this._partHoldBack);
    }
    // Written by toFixed, which gives an exponent from 1e21 (PART-TARGET=
    // 1e+21): a decimal-floating-point is positional (RFC 8216 §4.2).
    _belowE21(this._partTargetDuration, 'partTargetDuration');
    _belowE21(this._partHoldBack, 'partHoldBack');
  }
  this._inProgressParts = [];   // parts of the segment currently being built
  this._inProgressUri = null;   // uri of that segment (placeholder)

  // ── Delta Update state (RFC 8216bis §4.4.5.2) ──
  // When CAN-SKIP-UNTIL is advertised, clients may request the playlist
  // with a special query and get a "delta" — older segments replaced
  // by a single EXT-X-SKIP tag. Reduces playlist size dramatically
  // for long-running live streams. We emit:
  //   - CAN-SKIP-UNTIL=<seconds> in EXT-X-SERVER-CONTROL when enabled
  //   - EXT-X-SKIP:SKIPPED-SEGMENTS=<n> when serializeDelta() is called
  // Both daterange-skip and segment-skip variants are supported per spec.
  //
  // Per RFC 8216bis §6.2.5.1: CAN-SKIP-UNTIL MUST be at least 6× the
  // Target Duration. We don't auto-compute it — caller passes it
  // explicitly to opt into delta updates.
  this._canSkipUntil = (typeof opts.canSkipUntil === 'number') ?
                       opts.canSkipUntil : 0;
  // NaN made serializeDelta skip every segment (accum < NaN is false) with
  // no SERVER-CONTROL written; Infinity was written as "Infinity".
  if (!isFinite(this._canSkipUntil)) {
    throw new RangeError('Playlist: opts.canSkipUntil must be a finite number, got ' +
                         this._canSkipUntil);
  }
  // The Skip Boundary MUST be at least six times the Target Duration
  // (rfc8216bis §4.4.3.8): CAN-SKIP-UNTIL=6 was written with
  // TARGETDURATION:4. Checked against the target as written (1 before
  // any segment when it is not given), and again in addSegment when a
  // segment sets or raises it.
  if (this._canSkipUntil > 0) {
    _belowE21(this._canSkipUntil, 'canSkipUntil');
    this._checkCanSkipUntil(this._explicitTargetDuration || 1, 'Playlist: TARGETDURATION is');
  }
  this._canSkipDateRanges = !!opts.canSkipDateRanges;

  // ── EXT-X-DATERANGE state ──
  // RFC 8216 §4.4.5.1: arbitrary time-anchored metadata events that
  // tag a date or date range with structured data. The two main
  // production uses:
  //   1. SCTE-35 ad markers (CUE-OUT / CUE-IN binary messages)
  //   2. Program-level metadata (chapters, song titles, news segments)
  //
  // Each entry is the parsed/normalized form of an addDateRange() call.
  // We don't auto-prune — the caller is responsible for not adding
  // ranges that have already aged out of the playlist window. They
  // can use removeDateRange(id) for explicit cleanup.
  this._dateRanges = [];

  // EXT-X-DEFINE entries (RFC 8216bis §4.4.2). Variable substitution
  // for URIs and attribute values. Defined once near the top of the
  // playlist; referenced as `{$name}` in any later string. Three
  // forms: literal NAME=VALUE, IMPORT from multivariant, QUERYPARAM
  // extracted from playlist URL.
  this._defines = [];

  // EXT-X-START state (RFC 8216bis §4.4.2.2). Optional preferred
  // playback start position. Either positive (offset from beginning)
  // or negative (offset from end of the playlist). PRECISE attribute
  // tells the player whether to seek exactly or to the nearest segment
  // start. null = no directive emitted.
  this._start = null;

  // EXT-X-KEY state (RFC 8216 §4.4.4.4). setKey() sets the key for the
  // segments added AFTER the call; each segment records the key it was
  // added under, and serialize() writes an EXT-X-KEY wherever the key
  // changes. This used to be one global tag at the top of the playlist,
  // so a key rotation re-labelled every earlier segment with the new
  // key (a.ts, encrypted with key-A, was advertised as key-B and could
  // no longer be decrypted). null = clear.
  this._key = null;

  // Wall-clock anchor for a synthetic EXT-X-PROGRAM-DATE-TIME. RFC 8216
  // §4.3.2.7: a playlist containing EXT-X-DATERANGE MUST contain at least
  // one EXT-X-PROGRAM-DATE-TIME. When the caller supplies none, the first
  // segment in the output gets one derived from this anchor (taken when
  // the first segment was added) plus the duration of everything before
  // it. _droppedDurationSec counts what slid out of a live window.
  this._pdtAnchorMs = null;
  this._droppedDurationSec = 0;

  // ── PRELOAD-HINT state ──
  // For LL-HLS, the playlist tells the player where the next part
  // *will* be (URI + byte offset). The player issues a request that
  // the server holds until the bytes exist — that's the mechanism
  // for sub-second latency without polling.
  //
  // _nextSegmentUri is set by the caller (HLSEncoder) when a segment
  // closes — it's the URI of the segment that will receive the next
  // first part. While a segment is in progress, we derive the hint
  // from _inProgressUri and the cumulative byte cursor instead.
  this._nextSegmentUri = null;

  // ── EXT-X-RENDITION-REPORT state ──
  // For LL-HLS multi-rendition setups: each rendition's playlist
  // carries reports about other renditions' live edges, so a player
  // switching renditions can resume at the correct position without
  // a poll round-trip. The reports are externally fed in — in
  // multi-encoder setups, the caller wires up cross-encoder updates.
  //
  // _renditionReports: Map uri → { uri, lastMsn, lastPart? }, for O(1)
  // update on repeated reports for the same rendition (a repeated URI
  // keeps its place). A Map, not a plain object: a report for the URI
  // "__proto__" set the object's prototype (and was never written), and
  // removeRenditionReport('toString') found Object.prototype's and
  // returned true.
  this._renditionReports = new Map();
}

/**
 * Append a segment to the playlist.
 *
 * @param {object}  seg
 * @param {string}  seg.uri               Segment URI (relative or absolute).
 * @param {number}  seg.duration          In seconds (float).
 * @param {boolean} [seg.discontinuity]   Emits EXT-X-DISCONTINUITY before
 *                                        this segment. Use after timestamp
 *                                        resets, codec changes, or splice
 *                                        boundaries.
 * @param {string|Date} [seg.programDateTime]  ISO 8601 string or Date.
 *                                        Emitted as EXT-X-PROGRAM-DATE-TIME.
 *                                        Anchors the segment to wall clock.
 * @param {boolean} [seg.independent]     false: the segment does not start
 *                                        on an independent frame (a
 *                                        SegmentBuilder cut forced by its
 *                                        targetDuration). Refused while
 *                                        EXT-X-INDEPENDENT-SEGMENTS is
 *                                        declared.
 */
Playlist.prototype.addSegment = function (seg) {
  if (this._endlist) {
    throw new Error('Playlist.addSegment: cannot call after end()');
  }
  if (!seg || typeof seg.uri !== 'string' || typeof seg.duration !== 'number') {
    throw new Error('Playlist.addSegment: requires { uri:string, duration:number }');
  }
  // Every value checked before any state changes: the URI is a line of
  // its own, EXTINF's duration a decimal-floating-point (a NaN first
  // segment pinned TARGETDURATION to NaN — written as 1 — and every later
  // duration passed the check: TARGETDURATION:1 above EXTINF:10.000), the
  // date-time a line's value, BYTERANGE and BITRATE decimal-integers.
  _checkUriLine(seg.uri, 'Playlist.addSegment: uri');
  _decimalFloat(seg.duration, 'Playlist.addSegment: duration');
  // EXT-X-INDEPENDENT-SEGMENTS applies to every segment of the playlist
  // (rfc8216bis §4.4.2.1) and cannot be taken back: a server MUST NOT
  // change a playlist but to append to it (§6.2.1).
  if (seg.independent === false && this._independentSegments) {
    throw new TypeError('Playlist.addSegment: the segment does not start on an independent ' +
                        'frame, and the playlist declares EXT-X-INDEPENDENT-SEGMENTS ' +
                        '(RFC 8216bis §4.4.2.1); pass opts.independentSegments: false');
  }
  // TARGETDURATION covers it, and a decimal-integer is at most 2^64-1
  // (from 1e21 EXTINF and TARGETDURATION were written with an exponent).
  if (Math.ceil(seg.duration) >= _TWO_64) {
    throw new RangeError('Playlist.addSegment: duration must be below 2^64 s ' +
                         '(TARGETDURATION is a decimal-integer, RFC 8216 §4.2), got ' + seg.duration);
  }
  var pdt = _formatProgramDateTime(seg.programDateTime);
  if (pdt && /[\r\n]/.test(pdt)) {
    throw new TypeError('Playlist.addSegment: programDateTime must not contain CR/LF');
  }
  if (seg.byterange) {
    _decimalInteger(seg.byterange.length, 'Playlist.addSegment: byterange.length');
    // The offset is optional: without it the range continues where the
    // previous segment's ended (it used to be written as "@undefined").
    if (seg.byterange.offset !== undefined && seg.byterange.offset !== null) {
      _decimalInteger(seg.byterange.offset, 'Playlist.addSegment: byterange.offset');
    }
  }
  var bitrate = typeof seg.bitrate === 'number' ? Math.round(seg.bitrate) : null;
  if (bitrate !== null) {
    _decimalInteger(bitrate, 'Playlist.addSegment: bitrate');
    // EXT-X-BITRATE applies to the segments after it that have no
    // EXT-X-BYTERANGE (rfc8216bis §4.4.4.8): it cannot describe this one.
    if (seg.byterange) {
      throw new TypeError('Playlist.addSegment: bitrate cannot apply to a segment with ' +
                          'byterange (RFC 8216bis §4.4.4.8)');
    }
  }

  // The target this segment sets (live / event) or raises (VOD) must
  // keep CAN-SKIP-UNTIL at six times it at least.
  if (this._canSkipUntil > 0) {
    this._checkCanSkipUntil(this._targetDurationWith(seg.duration),
                            'Playlist.addSegment: duration ' + seg.duration + ' s makes TARGETDURATION');
  }

  // Live/event without an explicit targetDuration: the first segment
  // pins TARGETDURATION. A later segment whose EXTINF rounds above it
  // can't be listed without either changing the target (RFC 8216
  // §6.2.1 MUST NOT) or breaking EXTINF <= TARGETDURATION (§4.3.3.1
  // MUST), so it's refused here, before any state changes. Pass
  // opts.targetDuration (the longest segment you will produce) for live.
  var rounded = Math.round(seg.duration);
  if (this._mode !== 'vod' && !this._explicitTargetDuration) {
    if (this._pinnedTargetDuration === 0) {
      this._pinnedTargetDuration = Math.max(1, Math.ceil(seg.duration));
    } else if (rounded > this._pinnedTargetDuration) {
      throw new RangeError('Playlist.addSegment: duration ' + seg.duration +
        ' s rounds above the live TARGETDURATION ' + this._pinnedTargetDuration +
        ', which was pinned by the first segment and must not change ' +
        '(RFC 8216 §6.2.1). Pass opts.targetDuration (the longest segment ' +
        'duration you will produce) for live/event playlists.');
    }
  }
  if (rounded > this._maxRoundedDuration) this._maxRoundedDuration = rounded;
  if (this._pdtAnchorMs === null) {
    var explicitPdt = seg.programDateTime ? Date.parse(pdt) : NaN;
    this._pdtAnchorMs = isNaN(explicitPdt) ? Date.now() - seg.duration * 1000 : explicitPdt;
  }

  this._segments.push({
    uri: seg.uri,
    duration: seg.duration,
    discontinuity: !!seg.discontinuity,
    programDateTime: pdt,
    // Optional byterange — present on I-frame playlists (always),
    // and occasionally on regular playlists when the caller stores
    // multiple segments in a single file. Format: { length, offset }
    // → emitted as #EXT-X-BYTERANGE:<length>@<offset>.
    byterange: seg.byterange || null,
    // EXT-X-GAP (RFC 8216bis §4.4.4.7). Marks a segment as a "gap" —
    // present in the timeline but not actually fetchable. Players use
    // this to skip the segment without errors and to fall over to
    // alternative renditions if available. Useful for live streams
    // where a segment failed to encode but the timeline must continue.
    gap: !!seg.gap,
    // EXT-X-BITRATE (RFC 8216bis §4.4.4.8). Optional per-segment
    // bitrate hint in kbps. Lets ABR players make finer decisions
    // than relying on the variant's overall BANDWIDTH. Most useful
    // for VBR encodes where individual segments deviate from the
    // average. Number of kilobits per second; serialized as integer.
    bitrate: bitrate,
    // Attach the parts that were emitted while this segment was being
    // built. _inProgressParts is reset here so the next segment starts
    // fresh. Stored as an array (possibly empty for non-LL-HLS) — the
    // serializer emits one EXT-X-PART line per entry.
    parts: this._inProgressParts,
    // The EXT-X-KEY in effect when the segment was added (see _key).
    key: this._key,
  });
  this._inProgressParts = [];
  this._inProgressUri = null;

  // VOD (no explicit target): TARGETDURATION = ceil(longest EXTINF),
  // which satisfies the round-to-nearest rule with margin.
  var ceil = Math.ceil(seg.duration);
  if (ceil > this._computedTargetDuration) {
    this._computedTargetDuration = ceil;
  }

  // Sliding window for live. Use while (not if) so that reducing
  // windowSize between calls does the right thing — and to be defensive
  // in case the caller pre-loaded segments.
  //
  // RFC 8216 §6.2.2: the server MUST NOT remove a segment if that would
  // leave the playlist shorter than three target durations. windowSize
  // is therefore a minimum: { windowSize: 1, targetDuration: 6 } used to
  // serve a single 6 s segment (players need >= 18 s to start safely);
  // now it keeps three.
  if (this._mode === 'live') {
    var minDurationSec = 3 * this._currentTargetDuration();
    var totalSec = 0;
    for (var ti = 0; ti < this._segments.length; ti++) totalSec += this._segments[ti].duration;
    while (this._segments.length > this._windowSize &&
           totalSec - this._segments[0].duration >= minDurationSec) {
      var dropped = this._segments.shift();
      totalSec -= dropped.duration;
      this._droppedDurationSec += dropped.duration;
      this._mediaSequence++;
      if (dropped.discontinuity) this._discontinuitySequence++;
    }
  }
};

/**
 * Append a partial segment (LL-HLS). Must be called with the URI of
 * the segment that's currently being assembled — typically the same
 * URI that will be passed to addSegment() once that segment closes.
 *
 * Called per-part as the encoder emits them. Players poll the
 * playlist (or use HTTP/2 push) to discover new parts within a few
 * hundred ms of their availability.
 *
 * @param {object}  part
 * @param {string}  part.uri          URI of the parent segment file.
 * @param {number}  part.duration     In seconds.
 * @param {number}  part.byteOffset   Offset within the parent segment.
 * @param {number}  part.byteLength   Length of this part's bytes.
 * @param {boolean} [part.independent] True if part starts on a keyframe;
 *                                     enables byte-range seek to it.
 * @param {boolean} [part.gap]         True for a part that is not available
 *                                     (GAP=YES).
 *
 * The duration as written (5 decimals) MUST NOT be above PART-TARGET
 * (rfc8216bis §4.4.4.9): a RangeError.
 */
Playlist.prototype.addPart = function (part) {
  if (this._endlist) {
    throw new Error('Playlist: cannot addPart() after end()');
  }
  if (!part || typeof part.uri !== 'string' || typeof part.duration !== 'number') {
    throw new Error('Playlist: addPart requires { uri, duration, byteOffset, byteLength }');
  }
  // EXT-X-PART-INF is REQUIRED when there is an EXT-X-PART, and
  // PART-HOLD-BACK with it (rfc8216bis §4.4.3.7, §4.4.3.8); both come from
  // partTargetDuration, so without it the parts were written alone.
  if (!(this._partTargetDuration > 0)) {
    throw new Error('Playlist.addPart: opts.partTargetDuration must be set ' +
                    '(EXT-X-PART requires EXT-X-PART-INF, RFC 8216bis §4.4.3.7)');
  }
  escapeQuoted(part.uri);   // quoted-string check, see addDateRange
  _decimalFloat(part.duration, 'Playlist.addPart: duration');
  // Compared as written: both with 5 decimals.
  if (Number(part.duration.toFixed(5)) > Number(this._partTargetDuration.toFixed(5))) {
    throw new RangeError('Playlist.addPart: duration ' + part.duration.toFixed(5) +
                         ' is above PART-TARGET ' + this._partTargetDuration.toFixed(5) +
                         ' (RFC 8216bis §4.4.4.9)');
  }
  // decimal-integers: `| 0` made 2^31 and above negative.
  var byteOffset = (part.byteOffset === undefined || part.byteOffset === null) ? 0 :
                   _decimalInteger(part.byteOffset, 'Playlist.addPart: byteOffset');
  var byteLength = (part.byteLength === undefined || part.byteLength === null) ? 0 :
                   _decimalInteger(part.byteLength, 'Playlist.addPart: byteLength');
  // Sanity-check uri continuity within an in-progress segment. All
  // parts of a single segment must share the same URI (they're byte
  // ranges of the same file).
  if (this._inProgressUri !== null && this._inProgressUri !== part.uri) {
    throw new Error('Playlist.addPart: uri "' + part.uri + '" differs from ' +
                    'in-progress segment uri "' + this._inProgressUri + '". ' +
                    'Call addSegment() to close the current segment first.');
  }
  this._inProgressUri = part.uri;
  this._inProgressParts.push({
    uri: part.uri,
    duration: part.duration,
    byteOffset: byteOffset,
    byteLength: byteLength,
    independent: !!part.independent,
    gap: !!part.gap,
  });
};

/**
 * Add an EXT-X-DATERANGE entry. Use to declare time-anchored events
 * such as SCTE-35 ad break markers, program chapters, or any custom
 * structured metadata that needs to be synchronized to wall-clock
 * playback time.
 *
 * Two complementary use cases:
 *
 * **SCTE-35 ad markers** (most common). Pass `scte35Out` (CUE-OUT)
 * to mark the start of an ad break, or `scte35In` (CUE-IN) for the
 * end. The values are the binary SCTE-35 messages — typically
 * provided by an SCTE-35 generator library upstream. We hex-encode
 * them per HLS spec.
 *
 *   playlist.addDateRange({
 *     id: 'ad-1',
 *     startDate: '2024-01-15T12:00:00Z',
 *     plannedDuration: 30,
 *     scte35Out: cueOutBytes,   // Uint8Array
 *   });
 *
 * **Generic program metadata** (chapters, EPG events, etc):
 *
 *   playlist.addDateRange({
 *     id: 'chapter-3',
 *     classAttr: 'com.example.chapter',
 *     startDate: '2024-01-15T12:05:00Z',
 *     duration: 300,
 *     custom: { 'X-CHAPTER-TITLE': 'The Twist' },
 *   });
 *
 * Per RFC 8216 §4.4.5.1: ID is required, START-DATE is required.
 * All other fields are optional. Two ranges with the same ID and
 * different attributes mean "update" — players honor the most recent.
 * We don't enforce uniqueness here; the order added is preserved.
 *
 * @param {object} opts
 * @param {string} opts.id                    Required. Unique within playlist.
 * @param {string|Date} opts.startDate         Required. Wall-clock anchor.
 * @param {string|Date} [opts.endDate]         Wall-clock end (vs duration).
 * @param {number} [opts.duration]             Seconds.
 * @param {number} [opts.plannedDuration]      Seconds — anticipated, may differ from actual.
 * @param {string} [opts.classAttr]            Reverse-DNS class id, e.g. 'com.example.foo'.
 * @param {Uint8Array|string} [opts.scte35Out] CUE-OUT message; hex-encoded if Uint8Array.
 * @param {Uint8Array|string} [opts.scte35In]  CUE-IN message.
 * @param {Uint8Array|string} [opts.scte35Cmd] Generic SCTE-35 command (any other type).
 * @param {boolean} [opts.endOnNext]           true → emits END-ON-NEXT=YES.
 * @param {object} [opts.custom]               Map of X-… client-defined attributes.
 *                                              Keys are case-sensitive; values may be
 *                                              string, number, or Uint8Array (hex).
 */
Playlist.prototype.addDateRange = function (opts) {
  if (!opts || typeof opts.id !== 'string') {
    throw new TypeError('Playlist.addDateRange: opts.id (string) required');
  }
  if (opts.startDate === undefined || opts.startDate === null) {
    throw new TypeError('Playlist.addDateRange: opts.startDate required');
  }
  var entry = {
    id:              opts.id,
    classAttr:       opts.classAttr || null,
    startDate:       _formatProgramDateTime(opts.startDate),
    endDate:         _formatProgramDateTime(opts.endDate),
    // DURATION and PLANNED-DURATION MUST NOT be negative (RFC 8216
    // §4.3.2.7.1); NaN / Infinity are no decimal-floating-point either.
    duration:        typeof opts.duration === 'number' ?
                     _decimalFloat(opts.duration, 'Playlist.addDateRange: duration') : null,
    plannedDuration: typeof opts.plannedDuration === 'number' ?
                     _decimalFloat(opts.plannedDuration, 'Playlist.addDateRange: plannedDuration') : null,
    scte35Out:       _normalizeHexValue(opts.scte35Out),
    scte35In:        _normalizeHexValue(opts.scte35In),
    scte35Cmd:       _normalizeHexValue(opts.scte35Cmd),
    endOnNext:       !!opts.endOnNext,
    // CUE is an enumerated-string-list (PRE / POST / ONCE). Player
    // semantics: PRE = trigger before primary playback starts;
    // POST = trigger after; ONCE = play this range exactly once
    // even on replay. Unlike X-* attributes, CUE is a spec-defined
    // attribute (added in RFC 8216bis), not a custom client one.
    cue:             _normalizeCue(opts.cue),
    custom:          opts.custom || null,
  };
  // END-ON-NEXT=YES: the range ends where the next of its CLASS starts,
  // so it MUST have a CLASS and MUST NOT have DURATION or END-DATE
  // (rfc8216bis §4.4.5.1). Both were written as given.
  // START-DATE / END-DATE are ISO 8601 date-times, END-DATE not before
  // START-DATE, and with a DURATION too it MUST be START-DATE + DURATION
  // (rfc8216bis §4.4.5.1). Any string was written ('not a date', an
  // END-DATE an hour before the START-DATE).
  var start = _dateRangeDate(entry.startDate, 'startDate');
  if (entry.endDate) {
    var endAt = _dateRangeDate(entry.endDate, 'endDate');
    var span = (endAt.sec - start.sec) + (endAt.frac - start.frac);
    if (endAt.sec < start.sec || (endAt.sec === start.sec && endAt.frac < start.frac)) {
      throw new RangeError('Playlist.addDateRange: endDate ' + JSON.stringify(entry.endDate) +
                           ' is before startDate ' + JSON.stringify(entry.startDate) +
                           ' (RFC 8216bis §4.4.5.1)');
    }
    // Within a millisecond: the dates SHOULD carry milliseconds, so each
    // may be half of one off the exact time.
    if (entry.duration !== null && Math.abs(span - entry.duration) > 0.001) {
      throw new RangeError('Playlist.addDateRange: endDate is ' + span + ' s after startDate, ' +
                           'but duration is ' + entry.duration + ' s; with both, END-DATE ' +
                           'must be START-DATE + DURATION (RFC 8216bis §4.4.5.1)');
    }
  }
  if (entry.endOnNext) {
    if (!entry.classAttr) {
      throw new TypeError('Playlist.addDateRange: endOnNext requires classAttr ' +
                          '(RFC 8216bis §4.4.5.1)');
    }
    if (entry.duration !== null || entry.endDate) {
      throw new TypeError('Playlist.addDateRange: endOnNext excludes duration and endDate ' +
                          '(RFC 8216bis §4.4.5.1)');
    }
  }
  // Render once now so a value that can't be a quoted-string (a '"' or
  // CR/LF — escapeQuoted throws) fails here, at the call that added it,
  // instead of inside every later serialize() of a running stream.
  _serializeDateRange(entry);
  this._dateRanges.push(entry);
  return this;
};

/**
 * Remove all EXT-X-DATERANGE entries with the given id. Useful for
 * sliding-window cleanup when the caller manages range lifecycle
 * (e.g. drops ad markers older than the playlist window).
 *
 * @param {string} id  ID of the date range to remove.
 * @returns {number}   Count of entries removed.
 */
Playlist.prototype.removeDateRange = function (id) {
  var before = this._dateRanges.length;
  this._dateRanges = this._dateRanges.filter(function (dr) { return dr.id !== id; });
  return before - this._dateRanges.length;
};

/**
 * Add an HLS Interstitial — Apple's structured form of EXT-X-DATERANGE
 * for ad insertion and other interruption-style content.
 *
 * Players that recognize the `com.apple.hls.interstitial` CLASS spawn
 * a secondary AVPlayer for the asset, pause primary playback, and
 * resume per X-RESUME-OFFSET. Old players see a vanilla DATERANGE and
 * ignore it — backwards-compatible by design.
 *
 * Sugar layer over addDateRange. Validates the schema, builds the
 * X-* attribute names Apple defines, and routes through the same
 * DATERANGE serialization path.
 *
 * @param {object}        opts
 * @param {string}        opts.id              Required, unique within the playlist.
 * @param {Date|string}   opts.startDate       Required, when interstitial fires.
 * @param {number}        [opts.duration]      Asset playout duration (seconds).
 *
 * @param {string}        [opts.assetUri]      Single asset URL (m3u8). Mutually
 *                                              exclusive with assetList.
 * @param {string}        [opts.assetList]     URL to a JSON list of assets — lets
 *                                              the server decide ad inventory at
 *                                              request time (late binding). MUST
 *                                              be set if assetUri isn't.
 *
 * @param {number}        [opts.resumeOffset]  Seconds added to primary playhead
 *                                              when interstitial ends (0 = no
 *                                              skip; null = use full duration).
 * @param {number}        [opts.playoutLimit]  Max playout time of interstitial
 *                                              regardless of asset duration.
 *
 * @param {string[]}      [opts.restrict]      Subset of ['SKIP','JUMP'] — bars
 *                                              user from skipping or seeking past.
 * @param {string[]}      [opts.snap]          Subset of ['OUT','IN'] — align
 *                                              start/end to nearest segment
 *                                              boundary (clock-drift mitigation).
 * @param {string[]}      [opts.cue]           Subset of ['PRE','POST','ONCE'].
 *
 * @param {boolean}       [opts.contentMayVary] WWDC25. Hints to player that the
 *                                              asset list response may change
 *                                              between sessions (don't cache).
 * @param {string}        [opts.timelineOccupies] WWDC25. 'POINT' or 'RANGE'.
 *                                                How the interstitial maps to
 *                                                the visible timeline UI.
 * @param {string}        [opts.timelineStyle]  WWDC25. 'HIGHLIGHT' or 'PRIMARY'.
 *                                              Visual treatment in the UI.
 * @param {object}        [opts.skipControl]    WWDC25. Skip-button config.
 * @param {number}        [opts.skipControl.offset]   Seconds before button shows.
 * @param {string}        [opts.skipControl.labelId]  Localization label key.
 *
 * @returns {Playlist}    this, for chaining.
 */
Playlist.prototype.addInterstitial = function (opts) {
  if (!opts || typeof opts.id !== 'string') {
    throw new TypeError('Playlist.addInterstitial: opts.id (string) required');
  }
  if (opts.startDate === undefined || opts.startDate === null) {
    throw new TypeError('Playlist.addInterstitial: opts.startDate required');
  }

  var hasUri  = typeof opts.assetUri === 'string';
  var hasList = typeof opts.assetList === 'string';
  if (hasUri === hasList) {
    throw new TypeError('Playlist.addInterstitial: exactly one of ' +
                        '{assetUri} or {assetList} required');
  }

  // Validate enumerated lists upfront — invalid values get caught
  // here rather than producing a playlist the player will silently
  // misinterpret.
  if (opts.restrict !== undefined) {
    _validateEnumList(opts.restrict, ['SKIP', 'JUMP'], 'restrict');
  }
  if (opts.snap !== undefined) {
    _validateEnumList(opts.snap, ['OUT', 'IN'], 'snap');
  }
  if (opts.cue !== undefined) {
    _validateEnumList(opts.cue, ['PRE', 'POST', 'ONCE'], 'cue');
  }
  if (opts.timelineOccupies !== undefined &&
      opts.timelineOccupies !== 'POINT' &&
      opts.timelineOccupies !== 'RANGE') {
    throw new TypeError('Playlist.addInterstitial: timelineOccupies must be ' +
                        '"POINT" or "RANGE" (got "' + opts.timelineOccupies + '")');
  }
  if (opts.timelineStyle !== undefined &&
      opts.timelineStyle !== 'HIGHLIGHT' &&
      opts.timelineStyle !== 'PRIMARY') {
    throw new TypeError('Playlist.addInterstitial: timelineStyle must be ' +
                        '"HIGHLIGHT" or "PRIMARY" (got "' + opts.timelineStyle + '")');
  }

  // Build the X-* custom attribute set in Apple's documented order,
  // so the resulting line is byte-identical with what AVPlayer's own
  // documentation shows. Insertion order is preserved by V8/SpiderMonkey
  // for string keys, so the serializer's iteration matches.
  var custom = {};
  if (hasUri)  custom['X-ASSET-URI']  = opts.assetUri;
  if (hasList) custom['X-ASSET-LIST'] = opts.assetList;
  if (typeof opts.resumeOffset === 'number') {
    custom['X-RESUME-OFFSET'] = opts.resumeOffset;
  }
  if (typeof opts.playoutLimit === 'number') {
    custom['X-PLAYOUT-LIMIT'] = opts.playoutLimit;
  }
  if (Array.isArray(opts.restrict) && opts.restrict.length > 0) {
    custom['X-RESTRICT'] = opts.restrict.join(',');
  }
  if (Array.isArray(opts.snap) && opts.snap.length > 0) {
    custom['X-SNAP'] = opts.snap.join(',');
  }
  if (opts.contentMayVary) {
    // Apple uses YES/NO for boolean-ish quoted strings here.
    custom['X-CONTENT-MAY-VARY'] = 'YES';
  }
  if (opts.timelineOccupies) {
    custom['X-TIMELINE-OCCUPIES'] = opts.timelineOccupies;
  }
  if (opts.timelineStyle) {
    custom['X-TIMELINE-STYLE'] = opts.timelineStyle;
  }
  if (opts.skipControl && typeof opts.skipControl === 'object') {
    if (typeof opts.skipControl.offset === 'number') {
      custom['X-SKIP-CONTROL-OFFSET'] = opts.skipControl.offset;
    }
    if (typeof opts.skipControl.labelId === 'string') {
      custom['X-SKIP-CONTROL-LABEL-ID'] = opts.skipControl.labelId;
    }
  }

  this.addDateRange({
    id:        opts.id,
    classAttr: 'com.apple.hls.interstitial',
    startDate: opts.startDate,
    duration:  typeof opts.duration === 'number' ? opts.duration : undefined,
    cue:       opts.cue,
    custom:    custom,
  });

  return this;
};

/**
 * Add an EXT-X-DEFINE directive. Variables can be referenced as
 * `{$name}` in any later URI or attribute value, and the player
 * substitutes at parse time.
 *
 * Three mutually exclusive forms — exactly one of these properties
 * must be set:
 *
 *   { name: 'cdn', value: 'https://cdn.example.com' }
 *     → #EXT-X-DEFINE:NAME="cdn",VALUE="https://cdn.example.com"
 *     Literal value, defined inline. Most common form.
 *
 *   { import: 'cdn' }
 *     → #EXT-X-DEFINE:IMPORT="cdn"
 *     Pull a previously-defined variable from the multivariant
 *     playlist that referenced this one. Lets a single multivariant
 *     drive per-rendition variable values without duplication.
 *
 *   { queryparam: 'session' }
 *     → #EXT-X-DEFINE:QUERYPARAM="session"
 *     Extract the variable's value from a query parameter on the
 *     URL the player used to fetch this playlist. Powers per-session
 *     personalization while keeping the playlist itself cacheable.
 *     HLS v11+ only — bumps the playlist's minimum version.
 *
 * Variable names per spec: 1+ ASCII letters, digits, hyphen, or
 * underscore. Validated here so typos surface immediately rather
 * than as silent player-side rendering issues.
 *
 * @param {object} def
 * @returns {Playlist}  this, for chaining
 */
Playlist.prototype.define = function (def) {
  if (!def || typeof def !== 'object') {
    throw new TypeError('Playlist.define: object required');
  }

  var hasName  = typeof def.name === 'string';
  var hasValue = typeof def.value === 'string';
  var hasImport = typeof def['import'] === 'string';
  var hasQuery  = typeof def.queryparam === 'string';

  // Exactly one of: NAME+VALUE, IMPORT, QUERYPARAM
  var formCount = (hasName && hasValue ? 1 : 0) + (hasImport ? 1 : 0) + (hasQuery ? 1 : 0);
  if (formCount === 0) {
    throw new TypeError('Playlist.define: exactly one of {name+value}, ' +
                        '{import}, {queryparam} required');
  }
  if (formCount > 1 || hasName !== hasValue) {
    throw new TypeError('Playlist.define: exactly one form allowed; ' +
                        'name+value must appear together');
  }

  var entry;
  if (hasName) {
    if (!isValidVariableName(def.name)) {
      throw new TypeError('Playlist.define: invalid variable name "' + def.name +
                          '" — must match [a-zA-Z0-9_-]+');
    }
    entry = { kind: 'literal', name: def.name, value: def.value };
  } else if (hasImport) {
    if (!isValidVariableName(def['import'])) {
      throw new TypeError('Playlist.define: invalid import name "' + def['import'] + '"');
    }
    entry = { kind: 'import', name: def['import'] };
  } else {
    if (!isValidVariableName(def.queryparam)) {
      throw new TypeError('Playlist.define: invalid queryparam name "' + def.queryparam + '"');
    }
    // QUERYPARAM needs EXT-X-VERSION 11 — computed in _requiredVersion.
    entry = { kind: 'queryparam', name: def.queryparam };
  }

  // rfc8216bis §4.4.2.3: no two EXT-X-DEFINE tags of a playlist may
  // declare the same Variable Name (a parser MUST fail on it), whatever
  // their forms.
  for (var di = 0; di < this._defines.length; di++) {
    if (this._defines[di].name === entry.name) {
      throw new TypeError('Playlist.define: variable "' + entry.name +
                          '" is already defined (RFC 8216bis §4.4.2.3)');
    }
  }
  _serializeDefine(entry);   // quoted-string check, see addDateRange
  this._defines.push(entry);
  return this;
};

/**
 * Set or replace the EXT-X-START directive (RFC 8216bis §4.4.2.2).
 * Tells players where to begin playback by default — useful for
 * resuming partway in (e.g., a chapter), starting a few seconds
 * back from the live edge, or skipping a sponsor read at the top.
 *
 * @param {object}  opts
 * @param {number}  opts.timeOffset  Seconds. Positive = offset from
 *                                    start; negative = offset from end
 *                                    of the last Media Segment.
 * @param {boolean} [opts.precise]   If true, emit PRECISE=YES. The
 *                                    player will seek exactly to the
 *                                    offset rather than the nearest
 *                                    segment boundary. Default false.
 * @returns {Playlist}  this, for chaining.
 */
Playlist.prototype.setStart = function (opts) {
  if (!opts || typeof opts.timeOffset !== 'number' || !isFinite(opts.timeOffset)) {
    throw new TypeError('Playlist.setStart: opts.timeOffset (finite number) required');
  }
  this._start = {
    timeOffset: opts.timeOffset,
    precise:    !!opts.precise,
  };
  return this;
};

/**
 * Set the EXT-X-KEY for the Media Segments added from now on. Segments
 * already added keep the key they were added under; serialize() writes
 * an EXT-X-KEY line before the first segment of each run that shares a
 * key. Calling setKey again rotates the key (or, with METHOD=NONE,
 * starts a clear section) without touching earlier segments.
 *
 * @param {object}      opts
 * @param {string}      opts.method     'AES-128', 'SAMPLE-AES',
 *                                       'AES-256-GCM' (RFC 8216bis-19,
 *                                       January 2026), 'SAMPLE-AES-CTR',
 *                                       or 'NONE' to clear.
 * @param {string}      [opts.uri]      Required for non-NONE methods.
 *                                       URI from which the player
 *                                       fetches the raw key bytes.
 * @param {string}      [opts.iv]       Optional. "0x" + 32 hex digits.
 *                                       Omit to use the Media Sequence
 *                                       Number as IV (the standard
 *                                       and most flexible choice).
 * @param {string}      [opts.keyFormat]
 * @param {string}      [opts.keyFormatVersions]
 * @returns {Playlist}  this, for chaining.
 */
Playlist.prototype.setKey = function (opts) {
  if (!opts || typeof opts.method !== 'string') {
    throw new TypeError('Playlist.setKey: opts.method (string) required');
  }
  var m = opts.method;
  if (m === 'NONE') {
    // Per spec, METHOD=NONE forbids all other attributes — and
    // signals "from this point on the segments are clear". We just
    // emit it as-is.
    this._key = { method: 'NONE' };
    return this;
  }
  if (!isValidEncryptionMethod(m)) {
    throw new TypeError('Playlist.setKey: method "' + m +
                        '" must be NONE, AES-128, SAMPLE-AES, ' +
                        'AES-256-GCM, or SAMPLE-AES-CTR');
  }
  if (typeof opts.uri !== 'string') {
    throw new TypeError('Playlist.setKey: opts.uri required for non-NONE method');
  }
  if (opts.iv !== undefined && !isValidIvHex(String(opts.iv))) {
    throw new TypeError('Playlist.setKey: opts.iv must be 0x followed by 32 hex digits');
  }
  // KEYFORMATVERSIONS: one or more positive integers separated by "/"
  // (rfc8216bis §4.4.4.4); any string was written.
  if (opts.keyFormatVersions !== undefined && !isValidKeyFormatVersions(String(opts.keyFormatVersions))) {
    throw new TypeError('Playlist.setKey: opts.keyFormatVersions must be positive integers ' +
                        'separated by "/" (RFC 8216bis §4.4.4.4), got ' +
                        JSON.stringify(String(opts.keyFormatVersions)));
  }

  var key = {
    method:            m,
    uri:               opts.uri,
    iv:                opts.iv,
    keyFormat:         opts.keyFormat,
    keyFormatVersions: opts.keyFormatVersions,
  };
  _serializeKey(key);   // quoted-string check, see addDateRange
  this._key = key;
  return this;
};

/**
 * Tell the playlist what URI the next not-yet-started segment will
 * have. Drives the EXT-X-PRELOAD-HINT directive when LL-HLS is on:
 * the player can issue a blocking request for the first byte of
 * that URI before any of its parts exist.
 *
 * Set to null to clear (e.g. when the stream is about to end).
 *
 * No-op when partTargetDuration is 0 (LL-HLS disabled).
 *
 * @param {string|null} uri  URI of the next segment, or null to clear.
 */
Playlist.prototype.setNextSegmentUri = function (uri) {
  if (uri) escapeQuoted(uri);   // PRELOAD-HINT's URI is a quoted-string
  this._nextSegmentUri = uri || null;
};

/**
 * Add or update an EXT-X-RENDITION-REPORT entry. Each report describes
 * the live edge of ANOTHER rendition (e.g. a higher/lower bitrate
 * variant or a different audio language). Players use this to switch
 * renditions without losing time-sync — they know where to resume in
 * the new rendition without a separate playlist fetch.
 *
 * Calling repeatedly with the same URI updates the report (last value
 * wins). Typical usage in a multi-encoder setup:
 *
 *   videoEnc.on('part', (info) => {
 *     audioPlaylist.setRenditionReport({
 *       uri:      'video.m3u8',
 *       lastMsn:  info.segmentSequence,
 *       lastPart: info.partIndex,
 *     });
 *   });
 *
 * @param {object} opts
 * @param {string} opts.uri        Required. URI of the OTHER rendition's playlist.
 * @param {number} opts.lastMsn    Required. Latest media-sequence number in
 *                                 that rendition.
 * @param {number} [opts.lastPart] Latest part index in that rendition's
 *                                 most recent segment (LL-HLS only). Omit
 *                                 for non-LL-HLS renditions.
 */
Playlist.prototype.setRenditionReport = function (opts) {
  if (!opts || typeof opts.uri !== 'string') {
    throw new TypeError('Playlist.setRenditionReport: opts.uri (string) required');
  }
  if (typeof opts.lastMsn !== 'number') {
    throw new TypeError('Playlist.setRenditionReport: opts.lastMsn (number) required');
  }
  escapeQuoted(opts.uri);   // quoted-string check, see addDateRange
  // LAST-MSN / LAST-PART are decimal-integers: `| 0` wrote an MSN of
  // 3e9 as LAST-MSN=-1294967296.
  this._renditionReports.set(opts.uri, {
    uri:      opts.uri,
    lastMsn:  _decimalInteger(opts.lastMsn, 'Playlist.setRenditionReport: lastMsn'),
    lastPart: typeof opts.lastPart === 'number' ?
              _decimalInteger(opts.lastPart, 'Playlist.setRenditionReport: lastPart') : null,
  });
  return this;
};

/**
 * Remove a rendition report. Useful when a rendition is being shut
 * down or transitions to a different state.
 *
 * @param {string} uri  URI of the rendition to remove.
 * @returns {boolean}   true if removed, false if no report existed.
 */
Playlist.prototype.removeRenditionReport = function (uri) {
  return this._renditionReports.delete(uri);
};

/**
 * Mark the playlist as complete. The next serialize() will include
 * EXT-X-ENDLIST. Call this when the live stream ends, or after the
 * final segment of an event playlist. For mode='vod' this is
 * automatic — ENDLIST is always emitted.
 */
Playlist.prototype.end = function () {
  this._endlist = true;
};

/**
 * Render the current playlist state to an m3u8 string.
 * Idempotent — does not mutate state. Safe to call after every
 * addSegment() in live mode.
 */
Playlist.prototype.serialize = function () {
  return this._render(0);
};

/**
 * Serialize a Playlist Delta Update (RFC 8216bis §4.4.5.2 / §6.2.5.1).
 * Replaces older Media Segments with a single EXT-X-SKIP directive,
 * dramatically shrinking the playlist for long-running live streams
 * where clients only need recent segments.
 *
 * The retained tail MUST cover at least CAN-SKIP-UNTIL seconds. Older
 * Media Segments are replaced by EXT-X-SKIP:SKIPPED-SEGMENTS=<n>; the
 * global tags (MAP, DEFINE, DATERANGE, ...) remain, and the EXT-X-KEY in
 * effect for the first kept segment is repeated after the SKIP.
 *
 * Caller signals delta intent via canSkipUntil > 0 in the constructor.
 * If canSkipUntil is 0, this method falls back to a full serialize.
 *
 * @returns {string}  m3u8 text (delta-update form when applicable)
 */
Playlist.prototype.serializeDelta = function () {
  if (this._canSkipUntil <= 0 || this._segments.length === 0) {
    // Delta updates not enabled, or nothing to skip — full playlist.
    return this.serialize();
  }
  // A server MUST ignore _HLS_skip on a playlist with EXT-X-ENDLIST
  // (rfc8216bis §6.2.5.1): an ended (or VOD) playlist is served whole.
  if (this._endlist || this._mode === 'vod') {
    return this.serialize();
  }

  // Decide how many segments to retain at the tail. The kept tail
  // must cover at least CAN-SKIP-UNTIL seconds of duration. Walk
  // backward summing durations until we cross the threshold.
  var keepFromIdx = this._segments.length;
  var accum = 0;
  while (keepFromIdx > 0 && accum < this._canSkipUntil) {
    keepFromIdx--;
    accum += this._segments[keepFromIdx].duration;
  }
  if (keepFromIdx === 0) {
    // Nothing skipped — all segments are inside the CAN-SKIP-UNTIL
    // window, no delta possible. Return full playlist.
    return this.serialize();
  }
  return this._render(keepFromIdx);
};

/**
 * Lowest EXT-X-VERSION the rendered output is valid under — RFC 8216 §7
 * and rfc8216bis §8 — never below the opts.version floor.
 *
 * @param {number} skipCount  segments replaced by EXT-X-SKIP (0 = none)
 */
Playlist.prototype._requiredVersion = function (skipCount) {
  var v = Math.max(this._version, 3);              // 3: floating-point EXTINF
  // Only what is actually written counts: the listed segments (not
  // the skipped ones) and the current key if in-progress parts use it.
  var segs = this._segments;
  var keys = this._inProgressParts.length > 0 ? [this._key] : [];
  var hasByterange = !!this._initSegmentByterange;
  for (var i = skipCount; i < segs.length; i++) {
    if (segs[i].byterange) hasByterange = true;
    keys.push(segs[i].key);
  }
  // 4: EXT-X-BYTERANGE, EXT-X-I-FRAMES-ONLY.
  if (hasByterange || this._iFramesOnly) v = Math.max(v, 4);
  // 5: METHOD=SAMPLE-AES, KEYFORMAT / KEYFORMATVERSIONS on EXT-X-KEY
  // (SAMPLE-AES was left at 3).
  for (var k = 0; k < keys.length; k++) {
    var key = keys[k];
    if (key && key.method !== 'NONE' &&
        (key.method === 'SAMPLE-AES' ||
         key.keyFormat !== undefined || key.keyFormatVersions !== undefined)) {
      v = Math.max(v, 5);
    }
  }
  // 5: EXT-X-MAP in an I-frames-only playlist; 6: in any other.
  if (this._initSegmentUri) v = Math.max(v, this._iFramesOnly ? 5 : 6);
  // 8: variable substitution (EXT-X-DEFINE); 11: its QUERYPARAM form.
  for (var d = 0; d < this._defines.length; d++) {
    v = Math.max(v, this._defines[d].kind === 'queryparam' ? 11 : 8);
  }
  // 9: EXT-X-SKIP; 10: an EXT-X-SKIP that also replaces DATERANGEs
  // (we always write RECENTLY-REMOVED-DATERANGES when that is on).
  if (skipCount > 0) v = Math.max(v, this._canSkipDateRanges ? 10 : 9);
  return v;
};

/**
 * TARGETDURATION as written. Explicit value if given (in VOD raised to
 * cover a longer segment — a VOD playlist is fetched whole, so nothing
 * "changes" for a client, and EXTINF rounded must be <= it); otherwise
 * ceil(longest) for VOD and the pinned first value for live/event.
 */
Playlist.prototype._currentTargetDuration = function () {
  var td;
  if (this._explicitTargetDuration) {
    td = this._explicitTargetDuration;
    if (this._mode === 'vod' && this._maxRoundedDuration > td) td = this._maxRoundedDuration;
  } else if (this._mode === 'vod') {
    td = this._computedTargetDuration;
  } else {
    td = this._pinnedTargetDuration;
  }
  return td || 1;
};

/**
 * The renderer behind serialize() and serializeDelta().
 *
 * @param {number} skipCount  number of leading segments to replace with
 *                            EXT-X-SKIP (0 = full playlist)
 */
Playlist.prototype._render = function (skipCount) {
  var lines = [];

  lines.push('#EXTM3U');
  lines.push('#EXT-X-VERSION:' + this._requiredVersion(skipCount));

  // EXT-X-DEFINE (RFC 8216bis §4.4.2). Variable definitions appear
  // early so they can be referenced by every later directive. Three
  // forms are supported (validated in Playlist.define): NAME+VALUE
  // (literal), IMPORT (pull from multivariant), QUERYPARAM (extract
  // from playlist URL — HLS v11+).
  for (var di = 0; di < this._defines.length; di++) {
    lines.push(_serializeDefine(this._defines[di]));
  }

  if (this._independentSegments) {
    lines.push('#EXT-X-INDEPENDENT-SEGMENTS');
  }

  // EXT-X-START (RFC 8216bis §4.4.2.2). Optional preferred playback
  // start position. Goes near the top with other global tags, before
  // any segment-related directives. Per spec §4.4.2 these tags MUST
  // NOT appear more than once — we enforce single value via setStart's
  // replace-not-append semantics.
  if (this._start) {
    var startAttrs = 'TIME-OFFSET=' + _decimalNumber(this._start.timeOffset);
    if (this._start.precise) startAttrs += ',PRECISE=YES';
    lines.push('#EXT-X-START:' + startAttrs);
  }

  lines.push('#EXT-X-TARGETDURATION:' + this._currentTargetDuration());

  // A Delta Update keeps the MEDIA-SEQUENCE of the full playlist: it
  // is the number of the first (skipped) segment, and clients compute
  // the first listed segment as MEDIA-SEQUENCE + SKIPPED-SEGMENTS
  // (rfc8216bis §4.4.5.2). It used to be bumped by the skipped count,
  // so the client added it twice: seg4.ts was numbered 4+4 = 8.
  lines.push('#EXT-X-MEDIA-SEQUENCE:' + this._mediaSequence);

  if (this._discontinuitySequence > 0) {
    lines.push('#EXT-X-DISCONTINUITY-SEQUENCE:' + this._discontinuitySequence);
  }

  if (this._mode === 'vod') {
    lines.push('#EXT-X-PLAYLIST-TYPE:VOD');
  } else if (this._mode === 'event') {
    lines.push('#EXT-X-PLAYLIST-TYPE:EVENT');
  }
  // mode === 'live' → omit PLAYLIST-TYPE entirely (the convention)

  // EXT-X-I-FRAMES-ONLY (RFC 8216 §4.4.3.6). Goes early in the
  // playlist so every segment line is parsed in I-frame mode.
  if (this._iFramesOnly) {
    lines.push('#EXT-X-I-FRAMES-ONLY');
  }

  // LL-HLS directives. Emitted only when partTargetDuration > 0
  // OR when delta-updates (canSkipUntil > 0) are enabled. SERVER-
  // CONTROL goes near the top so polling players see the hold-back
  // hint and skip capability before any segment lines.
  if (this._partTargetDuration > 0 || this._canSkipUntil > 0) {
    var sc = '#EXT-X-SERVER-CONTROL:';
    var scAttrs = [];
    if (this._partTargetDuration > 0) {
      scAttrs.push('CAN-BLOCK-RELOAD=YES');
      scAttrs.push('PART-HOLD-BACK=' + this._partHoldBack.toFixed(3));
    }
    if (this._canSkipUntil > 0) {
      scAttrs.push('CAN-SKIP-UNTIL=' + this._canSkipUntil.toFixed(3));
      if (this._canSkipDateRanges) {
        scAttrs.push('CAN-SKIP-DATERANGES=YES');
      }
    }
    lines.push(sc + scAttrs.join(','));
    // With the parts' own precision: at 3 decimals a target of 0.2334 s
    // was written 0.233, below its parts' DURATION=0.23340 (§4.4.4.9).
    if (this._partTargetDuration > 0) {
      lines.push('#EXT-X-PART-INF:PART-TARGET=' +
                 this._partTargetDuration.toFixed(5));
    }
  }

  // EXT-X-MAP for fMP4 streams. Goes BEFORE the first EXTINF entry
  // (RFC 8216 §4.3.2.5). Players load this once and apply it to all
  // subsequent media segments. We emit it on every serialize() call
  // because for sliding-window live, players that join mid-stream
  // need to see it on whichever manifest snapshot they fetch.
  if (this._initSegmentUri) {
    var mapAttrs = 'URI="' + this._initSegmentUri + '"';
    if (this._initSegmentByterange) {
      mapAttrs += ',BYTERANGE="' + this._initSegmentByterange.length +
                  '@' + this._initSegmentByterange.offset + '"';
    }
    lines.push('#EXT-X-MAP:' + mapAttrs);
  }

  // EXT-X-DATERANGE entries. Spec doesn't require a specific position
  // (anywhere except inside a Media Segment is fine). We emit them
  // before the segment list so they're prominent — players that
  // stream-parse manifests see them early. Order is insertion order;
  // duplicate IDs are emitted as written (player resolves by latest).
  for (var dri = 0; dri < this._dateRanges.length; dri++) {
    lines.push(_serializeDateRange(this._dateRanges[dri]));
  }

  // EXT-X-SKIP replaces the first skipCount segments. It MUST follow the
  // last EXT-X-MAP and precede every Media Segment line (rfc8216bis
  // §4.4.5.2) — that is exactly here.
  if (skipCount > 0) {
    var skipLine = '#EXT-X-SKIP:SKIPPED-SEGMENTS=' + skipCount;
    // RECENTLY-REMOVED-DATERANGES is REQUIRED when CAN-SKIP-DATERANGES
    // is advertised, even when nothing was removed (empty string).
    if (this._canSkipDateRanges) {
      skipLine += ',RECENTLY-REMOVED-DATERANGES=""';
    }
    lines.push(skipLine);
  }

  // DATERANGE needs at least one PROGRAM-DATE-TIME in the playlist
  // (RFC 8216 §4.3.2.7 MUST). If no listed segment carries one, the
  // first listed segment gets one derived from the wall-clock anchor.
  // Without it, players have no way to place START-DATE on the media
  // timeline and ignore the ranges (ad markers silently never fire).
  var syntheticPdtIdx = -1;
  var syntheticPdt = null;
  if (this._dateRanges.length > 0 && skipCount < this._segments.length &&
      this._pdtAnchorMs !== null) {
    var anyPdt = false;
    for (var pi0 = skipCount; pi0 < this._segments.length; pi0++) {
      if (this._segments[pi0].programDateTime) { anyPdt = true; break; }
    }
    if (!anyPdt) {
      var offsetSec = this._droppedDurationSec;
      for (var pi1 = 0; pi1 < skipCount; pi1++) offsetSec += this._segments[pi1].duration;
      syntheticPdtIdx = skipCount;
      syntheticPdt = new Date(this._pdtAnchorMs + Math.round(offsetSec * 1000)).toISOString();
    }
  }

  // EXT-X-BITRATE (RFC 8216bis §4.4.4.8) is "sticky" — it applies
  // to the next segment AND to all subsequent segments until the next
  // EXT-X-BITRATE or EXT-X-DISCONTINUITY. We track the last-emitted
  // value and only push a directive when the value changes (or after
  // a discontinuity), keeping the playlist size minimal for VBR runs
  // that happen to flatten across consecutive segments.
  var lastBitrate = null;
  // EXT-X-KEY in effect at this point of the output (null = clear).
  var lastKey = null;

  for (var i = skipCount; i < this._segments.length; i++) {
    var s = this._segments[i];
    var segKey = _effectiveKey(s.key);
    if (segKey !== lastKey) {
      // A key line wherever the key changes; METHOD=NONE when going
      // back to clear after an encrypted run (not needed at the start —
      // clear is the default).
      lines.push(_serializeKey(segKey || { method: 'NONE' }));
      lastKey = segKey;
    }
    if (s.discontinuity) {
      lines.push('#EXT-X-DISCONTINUITY');
      // The next segment writes its bitrate again. (rfc8216bis-19 keeps
      // EXT-X-BITRATE in effect across a discontinuity; earlier drafts
      // ended it there. Repeating the tag is right under both.)
      lastBitrate = null;
    }
    if (s.programDateTime) {
      lines.push('#EXT-X-PROGRAM-DATE-TIME:' + s.programDateTime);
    } else if (i === syntheticPdtIdx) {
      lines.push('#EXT-X-PROGRAM-DATE-TIME:' + syntheticPdt);
    }
    // EXT-X-PART entries for closed segments — a closed segment in
    // LL-HLS still carries its part list so byte-range fetchers can
    // resolve any part within the playlist window. (Per spec, the
    // server MAY drop these once they're > 3 × TARGET-DURATION
    // behind the live edge; we keep them for the full window.)
    if (s.parts && s.parts.length > 0) {
      for (var pi = 0; pi < s.parts.length; pi++) {
        lines.push(_serializePart(s.parts[pi]));
      }
    }
    // BITRATE goes after PROGRAM-DATE-TIME / parts but before EXTINF
    // so the player knows the bitrate before fetching the segment.
    if (s.bitrate !== null && s.bitrate !== lastBitrate) {
      lines.push('#EXT-X-BITRATE:' + s.bitrate);
      lastBitrate = s.bitrate;
    }
    // Three decimal places = millisecond precision. EXTINF in v3+
    // accepts floats; older players that only handle integers are
    // not in scope.
    lines.push('#EXTINF:' + s.duration.toFixed(3) + ',');
    // Optional byterange — present for I-frame playlists (where every
    // entry points at a keyframe byte range within a parent media
    // file) and occasionally for byterange-packed media playlists.
    if (s.byterange) {
      var hasOffset = s.byterange.offset !== undefined && s.byterange.offset !== null;
      lines.push('#EXT-X-BYTERANGE:' + s.byterange.length +
                 (hasOffset ? '@' + s.byterange.offset : ''));
    }
    // EXT-X-GAP applies to the URI on the very next line, so it must
    // come AFTER EXTINF/BYTERANGE and immediately before the URI.
    if (s.gap) {
      lines.push('#EXT-X-GAP');
    }
    lines.push(s.uri);
  }

  // In-progress parts (segment hasn't closed yet). These appear at the
  // tail of the playlist with no EXTINF line — players treat them as
  // "live edge" until the segment closes. They belong to the segment
  // that will be added under the current key.
  if (this._inProgressParts.length > 0) {
    var curKey = _effectiveKey(this._key);
    if (curKey !== lastKey) {
      lines.push(_serializeKey(curKey || { method: 'NONE' }));
      lastKey = curKey;
    }
    for (var pj = 0; pj < this._inProgressParts.length; pj++) {
      lines.push(_serializePart(this._inProgressParts[pj]));
    }
  }

  // EXT-X-PRELOAD-HINT — drives sub-second LL-HLS latency. Tells the
  // player where the next part WILL be (URI + byte offset). The
  // player issues a GET that the server holds until the byte is
  // produced, eliminating a poll round-trip per part.
  //
  // Two cases:
  //   1. Mid-segment: hint to current segment's URI at the cumulative
  //      byte offset where the next part will start.
  //   2. Between segments (last part was 'final', segment closed):
  //      hint to the next segment's URI (set externally by the
  //      caller via setNextSegmentUri) starting at byte 0.
  if (this._partTargetDuration > 0) {
    var hintUri = null;
    var hintOffset = 0;
    if (this._inProgressUri && this._inProgressParts.length > 0) {
      var lastPart = this._inProgressParts[this._inProgressParts.length - 1];
      hintUri = this._inProgressUri;
      hintOffset = lastPart.byteOffset + lastPart.byteLength;
    } else if (this._nextSegmentUri) {
      hintUri = this._nextSegmentUri;
      hintOffset = 0;
    }
    // Not with EXT-X-ENDLIST (rfc8216bis §4.4.5.3), which a VOD playlist
    // always has.
    if (hintUri && !this._endlist && this._mode !== 'vod') {
      lines.push('#EXT-X-PRELOAD-HINT:TYPE=PART,URI="' + hintUri +
                 '",BYTERANGE-START=' + hintOffset);
    }
  }

  // EXT-X-RENDITION-REPORT entries. Per RFC 8216bis these are placed
  // near the playlist tail (before ENDLIST). Each report tells a
  // player following THIS playlist about the live edge of OTHER
  // renditions, enabling sub-second rendition switches.
  var reports = Array.from(this._renditionReports.values());
  for (var rri = 0; rri < reports.length; rri++) {
    var rep = reports[rri];
    var attrs = 'URI="' + escapeQuoted(rep.uri) + '"' +
                ',LAST-MSN=' + rep.lastMsn;
    if (rep.lastPart !== null) {
      attrs += ',LAST-PART=' + rep.lastPart;
    }
    lines.push('#EXT-X-RENDITION-REPORT:' + attrs);
  }

  if (this._endlist || this._mode === 'vod') {
    lines.push('#EXT-X-ENDLIST');
  }

  // m3u8 files conventionally end with a final newline.
  return lines.join('\n') + '\n';
};

// ── Getters (for HLSEncoder bookkeeping) ──────────────────

Playlist.prototype.segmentCount = function () {
  return this._segments.length;
};

Playlist.prototype.mediaSequence = function () {
  return this._mediaSequence;
};

Playlist.prototype.targetDuration = function () {
  return this._segments.length > 0 || this._explicitTargetDuration ?
    this._currentTargetDuration() : 0;
};

Playlist.prototype.isEnded = function () {
  return this._endlist;
};


// ── Internal helpers ──────────────────────────────────────

// 2^64: a decimal-integer is below it (RFC 8216 §4.2).
var _TWO_64 = 18446744073709551616;

// A decimal-floating-point the writer formats with toFixed, which uses an
// exponent from 1e21.
function _belowE21(v, what) {
  if (v >= 1e21) {
    throw new RangeError('Playlist: opts.' + what + ' must be below 1e21 (a ' +
                         'decimal-floating-point is positional, RFC 8216 §4.2), got ' + v);
  }
}

// START-DATE / END-DATE as an instant (see parseIsoDateTime), or a
// TypeError naming the option.
function _dateRangeDate(value, what) {
  var at = _parseIsoDateTime(value);
  if (!at) {
    throw new TypeError('Playlist.addDateRange: ' + what + ' ' + JSON.stringify(value) +
                        ' is not an ISO 8601 date-time (RFC 8216bis §4.4.5.1)');
  }
  return at;
}

/**
 * CAN-SKIP-UNTIL against a target duration: at least six times it
 * (rfc8216bis §4.4.3.8).
 */
Playlist.prototype._checkCanSkipUntil = function (target, what) {
  if (this._canSkipUntil < 6 * target) {
    throw new RangeError(what + ' ' + target + ', and opts.canSkipUntil ' + this._canSkipUntil +
                         ' is below six times it (RFC 8216bis §4.4.3.8)');
  }
};

/**
 * TARGETDURATION as written once a segment of this duration is added
 * (_currentTargetDuration with it).
 */
Playlist.prototype._targetDurationWith = function (duration) {
  var td;
  if (this._explicitTargetDuration) {
    td = this._explicitTargetDuration;
    if (this._mode === 'vod') td = Math.max(td, this._maxRoundedDuration, Math.round(duration));
  } else if (this._mode === 'vod') {
    td = Math.max(this._computedTargetDuration, Math.ceil(duration));
  } else {
    td = this._pinnedTargetDuration || Math.max(1, Math.ceil(duration));
  }
  return td || 1;
};

// A key object as written: null for clear (no key, or METHOD=NONE).
function _effectiveKey(k) {
  return (k && k.method !== 'NONE') ? k : null;
}

function _formatProgramDateTime(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * Render one EXT-X-PART line. Per RFC 8216bis §4.4.5.3:
 *   #EXT-X-PART:DURATION=<float>,URI="<uri>",BYTERANGE="<n>@<off>",INDEPENDENT=YES
 *
 * INDEPENDENT is omitted when false (per spec it's a flag, not a
 * value). BYTERANGE is omitted only when byteLength is 0 — for our
 * encoder output every part has bytes, so it's always present.
 */
function _serializePart(p) {
  var attrs = 'DURATION=' + p.duration.toFixed(5) + ',URI="' + p.uri + '"';
  if (p.byteLength > 0) {
    attrs += ',BYTERANGE="' + p.byteLength + '@' + p.byteOffset + '"';
  }
  if (p.independent) {
    attrs += ',INDEPENDENT=YES';
  }
  if (p.gap) {
    attrs += ',GAP=YES';
  }
  return '#EXT-X-PART:' + attrs;
}

/**
 * Normalize an SCTE-35 / hex-attribute value to the `0x…` string
 * format that HLS attribute values require. Accepts:
 *   - Uint8Array of binary message bytes
 *   - String already in `0x…` form (passed through; case normalized)
 *   - String of bare hex digits (prefix added)
 *   - null/undefined → null (attribute is omitted)
 *
 * Per RFC 8216 §4.2 hexadecimal-sequence: "two-letter prefix '0x' or
 * '0X'… followed by an unbroken string of upper-case hexadecimal
 * digits." We force upper-case to match Apple's mediastreamvalidator
 * which is strict on this point.
 */
function _normalizeHexValue(v) {
  if (v === null || v === undefined) return null;
  // A hexadecimal-sequence has at least one digit, and only [0-9A-F]
  // after the prefix: a string was passed through as it was ('zz,Q'
  // wrote SCTE35-OUT=0xZZ,Q, a second attribute), an empty Uint8Array
  // gave a bare '0x'.
  if (v instanceof Uint8Array) {
    if (v.length === 0) {
      throw new TypeError('Playlist: SCTE-35/hex value must not be empty');
    }
    var s = '0x';
    for (var i = 0; i < v.length; i++) {
      var b = v[i].toString(16).toUpperCase();
      if (b.length < 2) s += '0';
      s += b;
    }
    return s;
  }
  if (typeof v === 'string') {
    var trimmed = v.replace(/^0x/i, '').toUpperCase();
    if (!/^[0-9A-F]+$/.test(trimmed)) {
      throw new TypeError('Playlist: SCTE-35/hex value ' + JSON.stringify(v) +
                          ' is not a hexadecimal-sequence (RFC 8216 §4.2)');
    }
    return '0x' + trimmed;
  }
  throw new TypeError('Playlist: SCTE-35/hex value must be Uint8Array or string');
}

/**
 * Render one EXT-X-DATERANGE line.
 *
 * Attribute order matches Apple's example output for diff-friendliness
 * (the spec is silent on order). ID and START-DATE always come first.
 * Custom (X-…) attributes come last.
 */
function _serializeDateRange(d) {
  var attrs = 'ID="' + escapeQuoted(d.id) + '"';
  if (d.classAttr) {
    attrs += ',CLASS="' + escapeQuoted(d.classAttr) + '"';
  }
  // START-DATE / END-DATE are quoted-strings too (they were written
  // unchecked: START-DATE="2024"" from a '"').
  attrs += ',START-DATE="' + escapeQuoted(d.startDate) + '"';
  // CUE is positioned right after START-DATE per Apple's
  // documented examples — gives PRE/POST hints early in the line
  // for parsers that scan attribute-by-attribute.
  if (d.cue) {
    attrs += ',CUE="' + d.cue + '"';
  }
  if (d.endDate)         attrs += ',END-DATE="' + escapeQuoted(d.endDate) + '"';
  if (d.duration !== null)        attrs += ',DURATION=' + _decimalNumber(d.duration);
  if (d.plannedDuration !== null) attrs += ',PLANNED-DURATION=' + _decimalNumber(d.plannedDuration);
  if (d.scte35Cmd) attrs += ',SCTE35-CMD=' + d.scte35Cmd;
  if (d.scte35Out) attrs += ',SCTE35-OUT=' + d.scte35Out;
  if (d.scte35In)  attrs += ',SCTE35-IN='  + d.scte35In;
  if (d.endOnNext) attrs += ',END-ON-NEXT=YES';

  if (d.custom) {
    var keys = Object.keys(d.custom);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      if (key.indexOf('X-') !== 0) {
        // Per spec, client-defined attributes MUST start with "X-".
        // Skip silently rather than throw — the alternative is a
        // hostile mid-stream error for what's usually a typo.
        continue;
      }
      // An X- name is still an AttributeName: [A-Z0-9-] only (RFC 8216
      // §4.2; 'X-a b' or 'X-A=1,B' broke the attribute list).
      if (!/^X-[A-Z0-9-]+$/.test(key)) {
        throw new TypeError('Playlist.addDateRange: custom attribute name "' + key +
                            '" must match X-[A-Z0-9-]+ (RFC 8216 §4.2 AttributeName)');
      }
      var val = d.custom[key];
      if (val instanceof Uint8Array) {
        attrs += ',' + key + '=' + _normalizeHexValue(val);
      } else if (typeof val === 'number') {
        // signed-decimal-floating-point: NaN / Infinity were written as such.
        if (!isFinite(val)) {
          throw new RangeError('Playlist.addDateRange: custom attribute ' + key +
                               ' must be a finite number, got ' + val);
        }
        attrs += ',' + key + '=' + _decimalNumber(val);
      } else {
        attrs += ',' + key + '="' + escapeQuoted(String(val)) + '"';
      }
    }
  }
  return '#EXT-X-DATERANGE:' + attrs;
}

/**
 * Render one EXT-X-DEFINE directive based on the entry's kind.
 * Each form has a distinct attribute set; we never emit more than
 * one form per line.
 */
function _serializeDefine(entry) {
  if (entry.kind === 'literal') {
    return '#EXT-X-DEFINE:NAME="' + escapeQuoted(entry.name) +
           '",VALUE="' + escapeQuoted(entry.value, true) + '"';
  }
  if (entry.kind === 'import') {
    return '#EXT-X-DEFINE:IMPORT="' + escapeQuoted(entry.name) + '"';
  }
  // queryparam
  return '#EXT-X-DEFINE:QUERYPARAM="' + escapeQuoted(entry.name) + '"';
}

/**
 * Render an EXT-X-KEY directive. METHOD=NONE is the special
 * "everything from here is clear" form that takes no other attributes.
 * For real methods we serialize METHOD, URI, then the optional
 * IV / KEYFORMAT / KEYFORMATVERSIONS in spec order.
 */
function _serializeKey(k) {
  if (k.method === 'NONE') {
    return '#EXT-X-KEY:METHOD=NONE';
  }
  var attrs = 'METHOD=' + k.method;
  attrs += ',URI="' + escapeQuoted(k.uri) + '"';
  if (k.iv !== undefined) {
    // IV is unquoted hex with the literal "0x" prefix per spec.
    attrs += ',IV=' + k.iv;
  }
  if (k.keyFormat !== undefined) {
    attrs += ',KEYFORMAT="' + escapeQuoted(k.keyFormat) + '"';
  }
  if (k.keyFormatVersions !== undefined) {
    attrs += ',KEYFORMATVERSIONS="' + escapeQuoted(k.keyFormatVersions) + '"';
  }
  return '#EXT-X-KEY:' + attrs;
}

/**
 * Normalize a CUE attribute value to its serialization-ready form.
 * Accepts either a string ("PRE,ONCE") or an array (["PRE","ONCE"]).
 * Returns the comma-separated string or null if absent. Validates
 * each token is one of PRE/POST/ONCE.
 */
function _normalizeCue(cue) {
  if (cue === undefined || cue === null) return null;
  var arr = Array.isArray(cue) ? cue : String(cue).split(',');
  for (var i = 0; i < arr.length; i++) {
    var token = String(arr[i]).trim();
    if (token !== 'PRE' && token !== 'POST' && token !== 'ONCE') {
      throw new TypeError('Playlist.addDateRange: cue token "' + token +
                          '" must be PRE, POST, or ONCE');
    }
    arr[i] = token;
  }
  // rfc8216bis §4.4.5.1: a CUE MUST NOT include both PRE and POST.
  if (arr.indexOf('PRE') >= 0 && arr.indexOf('POST') >= 0) {
    throw new TypeError('Playlist.addDateRange: cue must not include both PRE and POST ' +
                        '(RFC 8216bis §4.4.5.1)');
  }
  return arr.join(',');
}

/**
 * Validate an enumerated-string-list attribute (e.g. X-RESTRICT,
 * X-SNAP, CUE) — every entry must be in the allowed set. Used by
 * addInterstitial to surface bad values at config time.
 */
function _validateEnumList(value, allowed, name) {
  if (!Array.isArray(value)) {
    throw new TypeError('Playlist.addInterstitial: ' + name + ' must be an array');
  }
  for (var i = 0; i < value.length; i++) {
    if (allowed.indexOf(value[i]) < 0) {
      throw new TypeError('Playlist.addInterstitial: ' + name + ' contains "' +
                          value[i] + '" — must be one of ' + allowed.join('/'));
    }
  }
}


/**
 * Parse an HLS Media Playlist (.m3u8) into a structured object whose shape
 * mirrors the Playlist writer's inputs — segments use the same field names
 * the writer's addSegment() accepts ({uri, duration, byterange:{length,
 * offset}, discontinuity, programDateTime, gap, bitrate}), so a parsed
 * playlist can (after dropping read-only state) round-trip back through the
 * writer. This is the read half of the future merged read+write Playlist.
 *
 * Scope: segments (EXTINF + title), byte-ranges, EXT-X-MAP (fMP4 init),
 * discontinuities, program-date-time, gap, per-segment bitrate, EXT-X-KEY
 * (carried onto following segments), and the playlist-level tags
 * (version, target duration, media/discontinuity sequence, playlist type,
 * independent-segments, i-frames-only, endlist).
 *
 * Unknown tags are ignored (forward-compatible per RFC 8216 §4.1).
 *
 * @param {string} text  the full .m3u8 text
 * @returns {{
 *   version:?number, targetDuration:?number, mediaSequence:number,
 *   discontinuitySequence:number, playlistType:?string,
 *   independentSegments:boolean, iFramesOnly:boolean, endlist:boolean,
 *   map:?{uri:string, byterange:?{length:number,offset:number}},
 *   segments:Array<Object>
 * }}
 */
export function parseMediaPlaylist(text) {
  var lines = String(text).split(/\r?\n/);
  var pl = {
    version: null,
    targetDuration: null,
    mediaSequence: 0,
    discontinuitySequence: 0,
    playlistType: null,
    independentSegments: false,
    iFramesOnly: false,
    endlist: false,
    map: null,
    segments: [],
  };

  var pending = null;        // segment being assembled from its preceding tags
  var currentMap = null;     // EXT-X-MAP applies to all following segments
  var currentKey = null;     // EXT-X-KEY applies to all following segments
  var byteCursor = 0;        // running offset for BYTERANGE without '@offset'
  // EXT-X-BITRATE applies to every following segment up to the next one,
  // except segments with an EXT-X-BYTERANGE (rfc8216bis §4.4.4.8). It was
  // put on the next segment only, so a run the writer gave one tag (it
  // writes it when the rate changes) read back as 500, null, null.
  var currentBitrate = null;

  function fresh() {
    return {
      uri: null, duration: 0, title: '', discontinuity: false,
      programDateTime: null, byterange: null, gap: false,
      bitrate: null, map: null, key: null,
    };
  }
  function need() { if (!pending) pending = fresh(); return pending; }

  for (var li = 0; li < lines.length; li++) {
    var line = lines[li].trim();
    if (line === '') continue;

    if (line.charCodeAt(0) !== 35 /* '#' */) {
      // URI line — closes the current segment.
      var seg = need();
      seg.uri = line;
      if (!seg.map && currentMap) seg.map = currentMap;
      if (!seg.key && currentKey) seg.key = currentKey;
      seg.bitrate = seg.byterange ? null : currentBitrate;
      pl.segments.push(seg);
      pending = null;
      continue;
    }

    if (line.indexOf('#EXTINF:') === 0) {
      var v = line.slice(8);
      var comma = v.indexOf(',');
      var s = need();
      if (comma >= 0) { s.duration = parseFloat(v.slice(0, comma)); s.title = v.slice(comma + 1); }
      else { s.duration = parseFloat(v); }
    } else if (line.indexOf('#EXT-X-BYTERANGE:') === 0) {
      var br = parseByteRange(line.slice(17), byteCursor);
      need().byterange = br;
      byteCursor = br.offset + br.length;
    } else if (line === '#EXT-X-DISCONTINUITY') {
      need().discontinuity = true;
    } else if (line.indexOf('#EXT-X-PROGRAM-DATE-TIME:') === 0) {
      need().programDateTime = line.slice(25).trim();
    } else if (line === '#EXT-X-GAP') {
      need().gap = true;
    } else if (line.indexOf('#EXT-X-BITRATE:') === 0) {
      currentBitrate = parseInt(line.slice(15), 10);
    } else if (line.indexOf('#EXT-X-MAP:') === 0) {
      var ma = parseAttributeList(line.slice(11));
      currentMap = {
        uri: ma.URI || '',
        byterange: ma.BYTERANGE ? parseByteRange(ma.BYTERANGE, 0) : null,
      };
      if (!pl.map) pl.map = currentMap;
    } else if (line.indexOf('#EXT-X-KEY:') === 0) {
      var ka = parseAttributeList(line.slice(11));
      currentKey = (ka.METHOD === 'NONE') ? null : {
        method: ka.METHOD || null,
        uri: ka.URI || null,
        iv: ka.IV || null,
        keyFormat: ka.KEYFORMAT || null,
        // It was not read (an EXT-X-KEY written with it came back without).
        keyFormatVersions: ka.KEYFORMATVERSIONS || null,
      };
    } else if (line.indexOf('#EXT-X-VERSION:') === 0) {
      pl.version = parseInt(line.slice(15), 10);
    } else if (line.indexOf('#EXT-X-TARGETDURATION:') === 0) {
      pl.targetDuration = parseInt(line.slice(22), 10);
    } else if (line.indexOf('#EXT-X-MEDIA-SEQUENCE:') === 0) {
      pl.mediaSequence = parseInt(line.slice(22), 10);
    } else if (line.indexOf('#EXT-X-DISCONTINUITY-SEQUENCE:') === 0) {
      pl.discontinuitySequence = parseInt(line.slice(30), 10);
    } else if (line.indexOf('#EXT-X-PLAYLIST-TYPE:') === 0) {
      pl.playlistType = line.slice(21).trim();
    } else if (line === '#EXT-X-INDEPENDENT-SEGMENTS') {
      pl.independentSegments = true;
    } else if (line === '#EXT-X-I-FRAMES-ONLY') {
      pl.iFramesOnly = true;
    } else if (line === '#EXT-X-ENDLIST') {
      pl.endlist = true;
    }
    // Unknown tags are ignored (forward-compatible).
  }

  return pl;
}

export default Playlist;
