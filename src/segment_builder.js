/**
 * segment-builder — Buffers encoded chunks and seals them into HLS
 * segments based on keyframe-aware timing.
 *
 * Sits between HLSEncoder (which produces encoded chunks) and the
 * configured writer (TSWriter today, fMP4 later). The builder owns
 * the policy of WHEN to cut a segment; the writer owns the format.
 *
 * Flush trigger:
 *   "Receive a video keyframe whose PTS is at least segmentDuration
 *    seconds past the current segment's start PTS."
 *
 * This guarantees segments are always >= segmentDuration in length,
 * possibly slightly longer if the encoder didn't place a keyframe
 * exactly at the boundary. For tight target adherence, HLSEncoder
 * should force keyframes on VideoEncoder at segmentDuration intervals
 * — the builder will then see boundary-aligned IDRs and produce
 * segments matching target to within one frame interval.
 *
 * Audio handling:
 *   Audio frames are buffered alongside video. When a flush trigger
 *   fires, audio is split by PTS: frames with PTS < trigger_pts go
 *   into the sealed segment, frames with PTS >= trigger_pts stay in
 *   the buffer for the next segment.
 *
 * Audio-only mode (hasVideo:false):
 *   No keyframes to anchor on, so the trigger becomes purely time-
 *   based: "elapsed audio coverage >= segmentDuration". Every AAC
 *   frame is independently decodable, so audio segments cut cleanly
 *   on any frame boundary.
 *
 * Late-chunk policy:
 *   A chunk arriving with PTS < current segment start is silently
 *   dropped. In practice this only happens with mis-ordered input
 *   (badly-behaved encoder, or audio capture lagging video by more
 *   than the segment boundary). The alternative — rewinding the
 *   segment — would corrupt already-emitted playlist entries.
 *
 * Output (per segment):
 *   {
 *     bytes:         Uint8Array,   // the .ts segment, ready to upload
 *     duration:      number,        // seconds (for EXTINF)
 *     startPtsUs:    number,        // first frame PTS
 *     endPtsUs:      number,        // segment boundary PTS
 *     sequence:      number,        // 0-based segment index
 *     videoFrames:   number,
 *     audioFrames:   number,
 *   }
 */

import { concat } from './core/bytes.js';
import { ivFromSequence } from './encryption.js';

// Cap on pre-IDR audio/metadata buffers. 200 entries is roughly 4 s
// at AAC LC's 1024 samples/frame at 48 kHz. The cap is a safety net:
// if video never arrives (broken pipeline, dropped track, etc.), we
// don't want to grow these buffers unbounded. In normal operation
// the first IDR lands within ~150 ms — 7-8 entries — so the cap is
// only ever reached when something has gone wrong.
var _MAX_PRE_IDR_BUFFER = 200;


/**
 * @param {object}  opts
 * @param {object}  opts.writer            TSWriter (or compatible).
 * @param {Function} opts.onSegment        Called with segment info on each seal.
 * @param {number}  [opts.segmentDuration=6] Target duration in seconds.
 * @param {boolean} [opts.hasVideo=true]   Set false for audio-only streams.
 * @param {number}  [opts.firstMediaSequence=0]  MSN of sequence 0 (for the
 *                                         sequence-derived AES-128 IV).
 * @param {number}  [opts.targetDuration]  The playlist's explicit
 *                                         TARGETDURATION (seconds, rounded
 *                                         up): no segment outgrows it.
 *
 * With targetDuration, a segment that would outgrow it — its EXTINF
 * rounded to the nearest integer above the target, which RFC 8216
 * §4.3.3.1 forbids — is closed before the frame that would push it
 * there, on the latest keyframe that keeps it within the target, else
 * on the latest frame (the next segment then starts on a frame that is
 * not a keyframe: its info says independent:false, so a playlist that
 * declares EXT-X-INDEPENDENT-SEGMENTS refuses it — declare it only when
 * the keyframes come in time). Without, a late keyframe (sparse GOPs, a
 * gap in the input) gave a segment of 3 s under TARGETDURATION:2.
 * A single frame longer than the target still makes a segment over it.
 *
 * A segment whose encryption fails reaches onSegment with gap:true and
 * bytes:null — list it as EXT-X-GAP, don't publish bytes for it.
 */
function SegmentBuilder(opts) {
  if (!opts) opts = {};
  if (!opts.writer) {
    throw new Error('SegmentBuilder: opts.writer required');
  }
  if (typeof opts.onSegment !== 'function') {
    throw new Error('SegmentBuilder: opts.onSegment callback required');
  }

  this._writer = opts.writer;
  this._onSegment = opts.onSegment;
  // Optional: onPart fires for each LL-HLS partial segment. Only
  // invoked when partDuration is set; otherwise this is a no-op
  // function so the hot push paths can call it without a null check.
  this._onPart = opts.onPart || function () {};
  // Optional. Non-fatal problems (a segment that failed to encrypt)
  // reach the caller through this instead of vanishing into the log.
  this._onError = opts.onError || null;
  this._segmentDurationUs = (opts.segmentDuration || 6) * 1000000;
  // gridAligned: segments end at the first keyframe on or after each
  // multiple of segmentDuration on the (shared, 0-based) timeline,
  // instead of at the first keyframe segmentDuration after the segment
  // started. HLSEncoder sets it when it forces the keyframes itself,
  // on that same grid. With the elapsed-time rule, a rendition that
  // joined a stream at 3 s cut its segments at 5 s, 7 s, … while the
  // others cut at 4 s, 6 s, … — a player switching renditions lands
  // mid-segment. On the grid every rendition cuts at the same points
  // (the joiner's first segment is just shorter), and segment lengths
  // no longer creep up by a frame per segment either.
  this._gridAligned = !!opts.gridAligned;
  // Part duration in microseconds. 0 = LL-HLS disabled. The expected
  // value is in the 200ms–1s range; outside that range, players may
  // refuse the playlist (PART-TARGET upper bound is half the segment
  // duration per Apple's spec).
  //
  // A part may last up to PART-TARGET as the playlist writes it (5
  // decimals) and what rounds down to it there: 0.0333333 is written
  // 0.03333, and a part of 33334 µs is written 0.03333 as well
  // (rfc8216bis §4.4.4.9 compares what is written). Frame timestamps are
  // whole µs, so a target of exactly 1/30 s held 33333 µs frames but not
  // the 33334 µs ones between them.
  this._partDurationUs = opts.partDuration ?
    Math.round(Number(opts.partDuration.toFixed(5)) * 1000000) + 4 : 0;
  // The explicit TARGETDURATION no segment may outgrow (0: none; see the
  // constructor's comment).
  var td = opts.targetDuration;
  this._targetDurationSec = (td > 0 && isFinite(td)) ? Math.ceil(td) : 0;

  // I-frame playlist support. When enabled, each emitted segment
  // carries an `iFrame` property describing the byte range of its
  // first keyframe — used to populate an EXT-X-I-FRAMES-ONLY playlist
  // for trick-play. The mechanism varies by mode:
  //   - TS:                  writer tracks the range internally
  //                          (writeSegment side effect).
  //   - fMP4 + LL-HLS:       use the first part's byte range.
  //   - fMP4 + non-LL-HLS:   write the keyframe in its own moof+mdat
  //                          first, rest in a second moof+mdat.
  this._iFramePlaylistEnabled = !!opts.iFramePlaylist;
  this._hasVideo = opts.hasVideo !== false;

  // Encryption configuration. When set, every emitted Media Segment
  // is encrypted with AES-128-CBC before being delivered to the
  // listener. The init segment is NOT encrypted — only Media Segments.
  //
  // _encryption shape (or null):
  //   {
  //     encryptor: { encrypt(plaintext, iv, callback): void },
  //     iv:        Uint8Array(16) | null,  // null = derive from sequence
  //   }
  //
  // The encryptor may not exist yet when _emit fires
  // (set later with setEncryptor). To handle both "not ready yet" AND "previous
  // segment still encrypting", we use a single FIFO queue:
  //   - _pendingEncryptions[]: segments waiting (preserve sequence order)
  //   - _encryptionInProgress: true while an encrypt() call is in flight
  // The queue is drained whenever the encryptor is ready AND nothing
  // is in flight. Drain callbacks (registered by HLSEncoder.end) are
  // queued separately and fire when the encryption queue empties.
  this._encryption = opts.encryption || null;
  // Media Sequence Number of sequence 0. The sequence-derived IV MUST be
  // the segment's MSN in the playlist (RFC 8216 §5.2). Every sealed
  // segment gets exactly one playlist entry — a segment whose encryption
  // failed is listed as EXT-X-GAP, not dropped — so MSN = base + sequence.
  this._firstMediaSequence = opts.firstMediaSequence || 0;
  this._pendingEncryptions = [];
  this._encryptionInProgress = false;
  this._drainCallbacks = [];

  this._videoBuf = [];
  this._audioBuf = [];
  // Timed-metadata buffer (ID3v2 frames). Populated by pushMetadata,
  // drained by _emit which passes the in-segment subset to the writer
  // for emsg emission. fMP4 only — TS writer ignores it for now.
  this._metadataBuf = [];
  this._segmentStartPtsUs = null;
  this._sequence = 0;
  this._firstKeyframeReceived = false;

  // True once we've emitted the init segment (if any). For TS-style
  // writers (no init concept), it stays false but writeInit() returns
  // null, so nothing is emitted.
  this._initEmitted = false;

  // ── Pending segment-boundary state ──
  // When a video IDR arrives that closes a segment, we don't seal
  // immediately. The audio encoder runs a few frames behind the
  // video encoder (typically 4–5 AAC frames, ~85–110 ms), so audio
  // chunks belonging to the closing segment are still in flight
  // when the IDR lands. Sealing right away would drop those chunks
  // and leave a gap of exactly that length between this segment
  // and the next — players experience this as a bufferStalledError.
  //
  // Instead we record the boundary PTS and defer the seal until an
  // audio chunk arrives whose PTS is already past it: that proves
  // every earlier audio chunk has been emitted by the encoder and
  // is safely in our buffer. _maybeSealPending() does the check.
  this._pendingBoundaryPtsUs = null;
  this._audioStarted = false;

  // ── Pre-IDR audio buffer ──
  // For mixed A+V streams, audio is captured continuously from t=0
  // but we can't keep any of it until the first video keyframe lands
  // (every HLS segment must start with a video IDR). The video
  // encoder typically takes longer than the audio encoder to emit
  // its first chunk — anything from ~30 ms (realtime mode) to
  // ~150 ms (quality mode with lookahead). If we simply dropped
  // pre-IDR audio chunks, the audio for those first ~30–150 ms
  // would be lost and segment 0's audio tfdt would land later than
  // its video tfdt — causing visible A/V drift at the start.
  //
  // We instead stash pre-IDR audio here. When the first IDR
  // arrives, we replay them into the main audio buffer so they
  // appear in segment 0. The cap (200 ≈ 4 s at 48 kHz/1024) is
  // a safety net in case video never arrives for some reason.
  this._preIdrAudio = [];

  // Symmetric pre-IDR buffer for timed metadata. Same lifecycle as
  // _preIdrAudio but separate so the IDR-replay loop doesn't have to
  // discriminate audio vs metadata.
  this._preIdrMetadata = [];

  // ── LL-HLS partial-segment state ──
  // When partDuration is non-zero, the builder emits partial segments
  // every ~partDuration of media time, in addition to the usual full
  // segment at every IDR. Each partial is its own moof+mdat from the
  // writer's perspective, concatenated into the segment file. Players
  // can fetch parts via byte ranges before the segment closes,
  // achieving sub-second latency.
  //
  // _partStartPtsUs:           PTS where the current part begins.
  //                            Resets to segment start at each new segment.
  //                            Where the part ends is decided from the
  //                            buffered chunks in _nextPartEnd.
  // _segmentPartByteOffsets[]: byte offsets for each part within the
  //                            current segment (for BYTERANGE attribute).
  // _segmentPartByteLengths[]: byte lengths matching the offsets array.
  // _segmentPartBytes[]:       per-part bytes, concatenated at segment seal
  //                            to produce the full segment for 'segment'.
  // _segmentParts[]:           bookkeeping for playlist updates: each entry
  //                            is { duration, byteOffset, byteLength,
  //                            independent }.
  // _firstPartOfSegmentIndependent:
  //                            true if the next part to emit starts on an
  //                            IDR; gets set when a segment opens, cleared
  //                            after the first part emits.
  this._partStartPtsUs = null;
  this._segmentPartBytes = [];
  this._segmentParts = [];
  this._firstPartOfSegmentIndependent = false;
  // Does the open segment start on an independent frame (a keyframe, or
  // any audio frame)? False after a cut that targetDuration forced.
  this._segmentIndependent = true;
  // flush(): where the last video frame ends, when audio runs on after
  // it (a place a part may end at; see flush).
  this._videoTailEndUs = null;
  // True after disableAudio(): audio pushes are ignored.
  this._audioDisabled = false;
  // Internal byte-offset cursor — mirrors sum of _segmentPartByteLengths
  // but kept as scalar to avoid an O(N) sum on every push.
  this._segmentByteCursor = 0;
}

/**
 * Push a video access unit. Annex-B format expected (HLSEncoder is
 * responsible for normalizing WebCodecs AVCC output to Annex-B and
 * for injecting SPS/PPS at every keyframe).
 *
 * @param {Uint8Array} au
 * @param {object}     opts
 * @param {number}     opts.ptsUs   Presentation timestamp.
 * @param {number}     [opts.dtsUs] Decode timestamp; defaults to PTS.
 * @param {boolean}    opts.isKey   True for IDR / random-access frames.
 */
SegmentBuilder.prototype.pushVideo = function (au, opts) {
  if (!this._hasVideo) {
    throw new Error('SegmentBuilder: pushVideo called but hasVideo is false');
  }

  // Drop until the first IDR — every HLS segment must start with a
  // random-access frame, otherwise a viewer joining at this segment
  // can't decode anything.
  if (!this._firstKeyframeReceived) {
    if (!opts.isKey) return;
    this._firstKeyframeReceived = true;
    this._segmentStartPtsUs = opts.ptsUs;
    this._segmentIndependent = true;

    // LL-HLS: open the first part of segment 0 anchored at the IDR PTS.
    // The first part of every segment starts on a keyframe and is
    // therefore INDEPENDENT (player can join at this part).
    if (this._partDurationUs > 0) {
      this._partStartPtsUs = opts.ptsUs;
      this._firstPartOfSegmentIndependent = true;
    }

    // Promote any audio that was captured during the wait for the
    // first keyframe. Anchoring segmentStart at the IDR's PTS may
    // leave some pre-IDR audio with PTS < segmentStart; those
    // chunks are still dropped (we don't move the segment start
    // earlier — HLS expects each segment to begin at its IDR's
    // PTS), but anything with PTS >= IDR PTS is replayed. Same
    // logic mirrored for pre-IDR metadata.
    var idrPts = opts.ptsUs;
    if (this._preIdrAudio.length > 0) {
      for (var k = 0; k < this._preIdrAudio.length; k++) {
        var ac = this._preIdrAudio[k];
        if (ac.ptsUs >= idrPts) {
          this._audioBuf.push(ac);
          this._audioStarted = true;
        }
      }
      this._preIdrAudio = [];
    }
    if (this._preIdrMetadata.length > 0) {
      for (var km = 0; km < this._preIdrMetadata.length; km++) {
        var mc = this._preIdrMetadata[km];
        if (mc.ptsUs >= idrPts) this._metadataBuf.push(mc);
      }
      this._preIdrMetadata = [];
    }
  }

  // Late chunks (PTS before current segment start) are dropped.
  if (opts.ptsUs < this._segmentStartPtsUs) return;

  // A segment that would end at this frame's start is over the explicit
  // target: it closes earlier (see the constructor).
  if (this._pendingBoundaryPtsUs === null && this._videoBuf.length > 0 &&
      this._overTarget(this._segmentStartPtsUs, opts.ptsUs)) {
    this._pendingBoundaryPtsUs = this._forcedBoundary(this._videoBuf, opts.ptsUs);
  }

  // Detect a new segment boundary: an IDR that arrives after at
  // least segmentDuration has elapsed since this segment started.
  // We record the boundary PTS but DO NOT seal yet — see the
  // explanation at _pendingBoundaryPtsUs in the constructor for
  // why deferring is necessary. The actual split happens once
  // _maybeSealPending() confirms audio has caught up.
  if (opts.isKey && this._videoBuf.length > 0 &&
      this._pendingBoundaryPtsUs === null) {
    if (this._isBoundary(opts.ptsUs)) {
      this._pendingBoundaryPtsUs = opts.ptsUs;
    }
  }

  // Always push into the same buffer. The seal step splits chunks
  // across segments at the recorded boundary PTS — chunks landing
  // here while a boundary is pending are routed correctly later.
  this._videoBuf.push({
    au: au,
    ptsUs: opts.ptsUs,
    dtsUs: (opts.dtsUs !== undefined && opts.dtsUs !== null) ? opts.dtsUs : opts.ptsUs,
    isKey: !!opts.isKey,
  });

  // LL-HLS: emit any part that is complete (see _nextPartEnd). The
  // split waits for audio to catch up — same flow as segment seal.
  this._maybeEmitPart();
  this._maybeSealPending();
};

/**
 * Push an audio frame. ADTS-wrapped expected (HLSEncoder is
 * responsible for wrapping raw AAC output from AudioEncoder).
 *
 * @param {Uint8Array} adts
 * @param {object}     opts
 * @param {number}     opts.ptsUs       Presentation timestamp.
 * @param {number}     [opts.durationUs] Frame playout duration. Used to
 *                                       compute final segment end-time
 *                                       at flush() and to detect coverage
 *                                       in audio-only mode.
 */
SegmentBuilder.prototype.pushAudio = function (adts, opts) {
  if (this._audioDisabled) return;
  // For mixed A+V streams, defer accepting audio into the main
  // buffer until video is anchored. Instead of dropping, we stash
  // pre-IDR audio so it can be replayed into segment 0 once the
  // first keyframe arrives — see _preIdrAudio in the constructor
  // for why this matters.
  if (this._hasVideo && !this._firstKeyframeReceived) {
    if (this._preIdrAudio.length < 200) {
      this._preIdrAudio.push({
        data: adts,
        ptsUs: opts.ptsUs,
        durationUs: opts.durationUs || 0,
      });
    }
    return;
  }

  // Audio-only: first audio frame anchors the segment start AND the
  // first part of segment 0. (For mixed A+V, partStartPtsUs is set
  // when the first IDR arrives.)
  if (!this._hasVideo && this._segmentStartPtsUs === null) {
    this._segmentStartPtsUs = opts.ptsUs;
    if (this._partDurationUs > 0) {
      this._partStartPtsUs = opts.ptsUs;
      // Audio-only parts are always independent — they have no decode
      // dependencies between frames (each AAC frame stands alone, Opus
      // ditto for typical configurations).
      this._firstPartOfSegmentIndependent = true;
    }
  }

  // Late chunks dropped.
  if (opts.ptsUs < this._segmentStartPtsUs) return;

  // Once we've seen any audio at all, the seal logic must wait for
  // audio to catch up at every boundary. Without this flag a video-
  // only stream would block forever waiting for audio that will
  // never come.
  this._audioStarted = true;

  // Audio-only flush trigger: time-based.
  if (!this._hasVideo) {
    // A segment that would end at this frame's start is over the
    // explicit target: close it on the latest frame that keeps it within
    // (every audio frame is independent).
    while (this._audioBuf.length > 0 && (!this._writer.canWriteInit || this._writer.canWriteInit()) &&
           this._overTarget(this._segmentStartPtsUs, opts.ptsUs)) {
      var forced = this._forcedBoundary(this._audioBuf, opts.ptsUs);
      this._maybeEmitPart(forced, true);
      this._sealSegment(forced);
      this._segmentStartPtsUs = forced;
    }
    // canWriteInit defends the same way the mixed-A+V path does in
    // _maybeSealPending — defer if the writer hasn't received its
    // audio config yet (AAC needs description; Opus is always ready).
    if (this._isBoundary(opts.ptsUs) && this._audioBuf.length > 0 &&
        (!this._writer.canWriteInit || this._writer.canWriteInit())) {
      // Parts that end before this boundary go out first, so the final
      // part of the segment is never longer than PART-TARGET.
      this._maybeEmitPart(opts.ptsUs, true);
      this._sealSegment(opts.ptsUs);
      this._segmentStartPtsUs = opts.ptsUs;
    }
  }

  this._audioBuf.push({
    data: adts,
    ptsUs: opts.ptsUs,
    durationUs: opts.durationUs || 0,
  });

  // LL-HLS: for audio-only streams audio frames define the parts; for
  // mixed A+V this push may be the audio that a pending part waits for.
  this._maybeEmitPart();
  this._maybeSealPending();
};

/**
 * Push a timed-metadata frame (typically ID3v2). Carried in fMP4
 * segments via emsg boxes prepended to each segment's moof; ignored
 * for TS output (TS metadata streams aren't supported yet).
 *
 * Late chunks (PTS before current segment start) are dropped, same
 * policy as audio/video. Pre-IDR metadata is kept and replayed into
 * segment 0 once the first keyframe arrives — symmetric with
 * _preIdrAudio behavior.
 *
 * @param {Uint8Array} data       ID3v2 frame bytes (no ADTS-style wrapping)
 * @param {object}     opts
 * @param {number}     opts.ptsUs       Presentation timestamp.
 * @param {number}     [opts.durationUs] 0 = instantaneous event.
 */
SegmentBuilder.prototype.pushMetadata = function (data, opts) {
  // Pre-IDR: stash in the same way as audio. Capped to avoid unbounded
  // growth if video never arrives. 200 entries is generous given that
  // metadata is rate-limited by definition (one event per song change,
  // per ad marker, etc — not per frame).
  if (this._hasVideo && !this._firstKeyframeReceived) {
    if (this._preIdrMetadata.length < 200) {
      this._preIdrMetadata.push({
        data: data,
        ptsUs: opts.ptsUs,
        durationUs: opts.durationUs || 0,
      });
    }
    return;
  }

  if (opts.ptsUs < this._segmentStartPtsUs) return;

  this._metadataBuf.push({
    data: data,
    ptsUs: opts.ptsUs,
    durationUs: opts.durationUs || 0,
  });
};

/**
 * Force-seal whatever is currently buffered as a final (possibly
 * short) segment. Call at end-of-stream — typically from HLSEncoder
 * after VideoEncoder.flush() / AudioEncoder.flush() have drained.
 *
 * No-op if the buffer is empty.
 */
SegmentBuilder.prototype.flush = function () {
  // Last-chance check: the writer needs all its codec configs by now.
  // If a chunk's metadata.decoderConfig.description was missing for the
  // entire recording (browser quirk for some codec/latency combinations),
  // we'd otherwise crash deep inside writeInit() with an opaque error.
  // Throw a clearer one upfront so the caller can surface it usefully.
  if (this._writer.canWriteInit && !this._writer.canWriteInit() &&
      (this._videoBuf.length > 0 || this._audioBuf.length > 0 ||
       this._pendingBoundaryPtsUs !== null)) {
    // Drop the buffered chunks so the encoder shutdown path doesn't
    // get stuck if the caller swallows this throw.
    this._videoBuf = [];
    this._audioBuf = [];
    this._metadataBuf = [];
    this._pendingBoundaryPtsUs = null;
    throw new Error(
      'SegmentBuilder.flush: the encoder produced output, but the writer ' +
      'never received a codec config (decoderConfig.description was missing ' +
      'on every chunk). Recording cannot be finalized. This typically means ' +
      'the recording was too short, or the browser did not emit description ' +
      'metadata for the chosen codec — try a longer recording or a different codec.');
  }

  // If a boundary is pending (an IDR was detected but we were still
  // waiting on audio), seal it now regardless of whether audio caught
  // up — there's no more data coming, so waiting any longer would
  // just discard whatever audio did arrive into the next segment.
  if (this._pendingBoundaryPtsUs !== null) {
    var boundary = this._pendingBoundaryPtsUs;
    this._maybeEmitPart(boundary, true);
    var videoForSeg    = _spliceUpTo(this._videoBuf,    boundary);
    var audioForSeg    = _spliceUpTo(this._audioBuf,    boundary);
    var metadataForSeg = _spliceUpTo(this._metadataBuf, boundary);
    var startPts = this._segmentStartPtsUs;
    this._pendingBoundaryPtsUs = null;
    this._segmentStartPtsUs = boundary;
    this._emit(videoForSeg, audioForSeg, metadataForSeg, startPts, boundary);
  }

  if (this._videoBuf.length === 0 && this._audioBuf.length === 0) return;

  // Compute end-PTS for the trailing segment. The "natural" end is
  // the last frame's PTS, but that under-reports duration by one
  // frame interval (the playback duration of the final frame).
  // Estimate the final-frame interval and add it.
  //
  // Buffers are PTS-sorted (same invariant _spliceUpTo relies on), so
  // we can read the max from the last element in O(1) instead of a
  // linear scan.
  var endPts = this._segmentStartPtsUs;
  var vLen = this._videoBuf.length;
  var aLen = this._audioBuf.length;

  if (vLen > 0) {
    var lastV = this._videoBuf[vLen - 1].ptsUs;
    if (lastV > endPts) endPts = lastV;
  }
  if (aLen > 0) {
    var lastA = this._audioBuf[aLen - 1];
    var aEnd = lastA.ptsUs + (lastA.durationUs || 0);
    if (aEnd > endPts) endPts = aEnd;
  }

  var videoEnd = null;   // where the last video frame ends
  if (vLen >= 2) {
    var lastVc = this._videoBuf[vLen - 1];
    var prevVc = this._videoBuf[vLen - 2];
    var gap = lastVc.ptsUs - prevVc.ptsUs;
    if (gap > 0) { endPts = Math.max(endPts, lastVc.ptsUs + gap); videoEnd = lastVc.ptsUs + gap; }
  } else if (vLen === 1) {
    // Single-frame segment is a pathological case; fall back to a
    // 30 fps default (~33 ms per frame) which is harmless if wrong.
    endPts = Math.max(endPts, this._videoBuf[0].ptsUs + 33333);
    videoEnd = this._videoBuf[0].ptsUs + 33333;
  }

  // The tail over the explicit target: cut it as pushes do (on the
  // latest keyframe / frame that keeps each segment within the target);
  // past the last video frame, on the audio that runs on after it (no
  // more video can come now).
  while (this._overTarget(this._segmentStartPtsUs, endPts)) {
    var cut = this._forcedBoundary(this._hasVideo ? this._videoBuf : this._audioBuf, endPts);
    if (cut >= endPts && this._hasVideo) cut = this._forcedBoundary(this._audioBuf, endPts);
    if (cut >= endPts) break;   // the last frame alone is longer than the target
    this._maybeEmitPart(cut, true);
    var startCut = this._segmentStartPtsUs;
    this._segmentStartPtsUs = cut;
    this._emit(_spliceUpTo(this._videoBuf, cut), _spliceUpTo(this._audioBuf, cut),
               _spliceUpTo(this._metadataBuf, cut), startCut, cut);
  }

  // LL-HLS: cut the tail into parts first, so the final part is not
  // everything since the last part (no more data is coming, so don't
  // wait for audio). Audio that runs on past the last video frame: a
  // part may end where that frame does (else the part before the final
  // one could end on the frame's start, a frame long, below 85 % of
  // PART-TARGET — rfc8216bis §4.4.4.9).
  this._videoTailEndUs = (videoEnd !== null && endPts > videoEnd) ? videoEnd : null;
  try {
    this._maybeEmitPart(endPts, true);
  } finally {
    this._videoTailEndUs = null;
  }
  this._sealAtBoundary(endPts);
};

/**
 * True while a segment boundary is waiting — for audio to catch up, or
 * for the writer's codec configs (canWriteInit). HLSEncoder uses it to
 * notice an audio track that never produced anything.
 */
SegmentBuilder.prototype.hasPendingBoundary = function () {
  return this._pendingBoundaryPtsUs !== null;
};

/**
 * True once the init segment has gone out (and until reset()): from then
 * on the tracks are fixed, so disableAudio() can no longer drop one.
 */
SegmentBuilder.prototype.hasWrittenInit = function () {
  return this._initEmitted;
};

/**
 * Stop expecting audio: drop buffered audio, ignore later pushAudio()
 * calls, and swap in `writer` (one built without an audio track). Only
 * valid before the init segment has gone out — after that the track
 * list is fixed. Then retries whatever was waiting on the audio.
 *
 * @param {object} writer  replacement writer with no audio track
 */
SegmentBuilder.prototype.disableAudio = function (writer) {
  if (this._initEmitted) {
    throw new Error('SegmentBuilder.disableAudio: init segment already written');
  }
  if (writer) this._writer = writer;
  this._audioDisabled = true;
  this._audioStarted = false;
  this._audioBuf = [];
  this._preIdrAudio = [];
  this._maybeEmitPart();
  this._maybeSealPending();
};

/**
 * Discard all buffered state and reset the segment counter to 0.
 * Use when restarting a stream from scratch.
 */
SegmentBuilder.prototype.reset = function () {
  this._videoBuf = [];
  this._audioBuf = [];
  this._metadataBuf = [];
  this._segmentStartPtsUs = null;
  this._sequence = 0;
  this._firstKeyframeReceived = false;
  this._initEmitted = false;
  this._pendingBoundaryPtsUs = null;
  this._audioStarted = false;
  this._preIdrAudio = [];
  this._preIdrMetadata = [];
  this._partStartPtsUs = null;
  this._segmentPartBytes = [];
  this._segmentParts = [];
  this._firstPartOfSegmentIndependent = false;
  this._segmentIndependent = true;
  this._segmentByteCursor = 0;
};


// ── Internal: seal helpers ────────────────────────────────

/**
 * Split buffer at the first element with ptsUs >= boundary, in place.
 * Returns the prefix (PTS < boundary). The buffer is mutated to keep
 * only the suffix (PTS >= boundary).
 *
 * Assumes the buffer is PTS-sorted, which is true for both _videoBuf
 * and _audioBuf in our pipeline (encoder is FIFO under realtime mode
 * and both push paths preserve order). splice() is one allocation
 * (the removed prefix) plus one in-place shift of the suffix — cheaper
 * than two slices that allocate twice.
 */
function _spliceUpTo(buf, boundaryPtsUs) {
  var split = 0;
  while (split < buf.length && buf[split].ptsUs < boundaryPtsUs) split++;
  return buf.splice(0, split);
}

/**
 * Decide whether a pending boundary can be sealed yet. For mixed
 * A+V streams we wait until at least one audio chunk has arrived
 * past the boundary — this proves the audio encoder has produced
 * everything we owe to the closing segment. For video-only streams
 * (_audioStarted is false) we seal immediately.
 *
 * Called from pushVideo and pushAudio after every push.
 */
SegmentBuilder.prototype._maybeSealPending = function () {
  if (this._pendingBoundaryPtsUs === null) return;

  // Defer the seal until the writer has all codec configs it needs.
  // Without them, _emit's writeInit() throws and the partially-split
  // chunks would be lost. Stays deferred until a later encoder chunk
  // delivers config (or flush() force-fails with a clearer error).
  if (this._writer.canWriteInit && !this._writer.canWriteInit()) return;

  var boundary = this._pendingBoundaryPtsUs;

  if (this._audioStarted) {
    // Need at least one audio chunk at-or-past the boundary to
    // know the audio encoder has caught up.
    var n = this._audioBuf.length;
    if (n === 0 || this._audioBuf[n - 1].ptsUs < boundary) return;
  }

  // Parts of this segment still owed go out before the seal; otherwise
  // the final part would swallow them and exceed PART-TARGET.
  this._maybeEmitPart();

  var videoForSeg = _spliceUpTo(this._videoBuf, boundary);
  var audioForSeg = _spliceUpTo(this._audioBuf, boundary);
  var metadataForSeg = _spliceUpTo(this._metadataBuf, boundary);

  var startPts = this._segmentStartPtsUs;
  this._pendingBoundaryPtsUs = null;
  this._segmentStartPtsUs = boundary;

  this._emit(videoForSeg, audioForSeg, metadataForSeg, startPts, boundary);

  // Edge case: another keyframe past the next boundary may already
  // be sitting in the carried-over buffer (extremely rare, but
  // possible if audio fell behind by more than a full segment).
  // Re-detect once so we don't miss it.
  this._maybeDetectNewBoundary();
};

/**
 * LL-HLS: emit every partial segment that is ready. Mirrors the
 * deferral logic of _maybeSealPending — wait for audio to catch up
 * before splicing — but operates inside an active segment without
 * needing an IDR. Each part is its own moof+mdat from the writer's
 * perspective, written into the same segment file (concatenated by
 * _emit at segment seal). The byte ranges are tracked here so the
 * playlist's EXT-X-PART entries can carry BYTERANGE attributes.
 *
 * @param {number}  [segEndPtsUs] end of the current segment, when known
 *                                and not yet in _pendingBoundaryPtsUs
 *                                (audio-only seal, flush tail)
 * @param {boolean} [force]       don't wait for audio (end of stream /
 *                                audio already past the boundary)
 */
SegmentBuilder.prototype._maybeEmitPart = function (segEndPtsUs, force) {
  if (this._partDurationUs <= 0) return;
  if (this._writer.canWriteInit && !this._writer.canWriteInit()) return;
  var segEnd = (segEndPtsUs !== undefined && segEndPtsUs !== null) ?
    segEndPtsUs : this._pendingBoundaryPtsUs;
  for (;;) {
    var partEnd = this._nextPartEnd(segEnd);
    if (partEnd === null) return;
    // Same audio-caught-up gate as the segment seal — without it the
    // part would miss its share of audio frames, leaving an audible
    // gap that compounds over many parts.
    if (!force && this._audioStarted) {
      var n = this._audioBuf.length;
      if (n === 0 || this._audioBuf[n - 1].ptsUs < partEnd) return;
    }
    if (!this._emitPart(partEnd, segEnd)) return;
  }
};

/**
 * Where the current part ends, or null if it isn't complete yet.
 *
 * rfc8216bis §4.4.4.9: a part's duration MUST be <= PART-TARGET. The
 * part used to end AT the first frame whose PTS reached the target, so
 * it included that frame's predecessor interval and always overshot:
 * PART-TARGET 0.250 at 30 fps gave every part 0.26667 s. Now a part ends
 * at the latest frame start that keeps it within the target (0.23333 s
 * at 30 fps), decided once a frame at or past the target shows the part
 * can't grow any more.
 *
 * Video frames define part edges in A+V streams (a part never splits a
 * frame); audio frames in audio-only streams. A part never crosses the
 * segment end; the rest of a segment that fits in PART-TARGET becomes
 * the final part at seal time.
 *
 * When nothing starts within the target — a frame longer than
 * PART-TARGET (variable frame rate input, a gap), or the tail of a
 * stream whose audio outlasts its video — the part ends at the target
 * itself, inside that frame: the frame keeps its whole duration (its
 * sample runs on to the next frame, so the track has no hole), the parts
 * after it carry what else that time holds (the audio), or are GAP=YES
 * parts when it holds nothing. A part used to be as long as that frame
 * (0.5 s parts under PART-TARGET 0.3, the whole tail at end()), above
 * PART-TARGET, which rfc8216bis §4.4.4.9 forbids. (A part cut there can
 * be shorter than 85 % of the target — the one before the next frame —
 * if it is not followed by a GAP part: only such input reaches it.)
 */
SegmentBuilder.prototype._nextPartEnd = function (segEnd) {
  var start = this._partStartPtsUs;
  if (start === null) return null;
  var limit = start + this._partDurationUs;
  if (segEnd !== null && segEnd !== undefined && segEnd <= limit) return null;
  var buf = this._hasVideo ? this._videoBuf : this._audioBuf;
  var best = null;        // latest chunk start in (start, limit]
  var firstAfter = null;  // first chunk start > limit
  for (var i = 0; i < buf.length; i++) {
    var p = buf[i].ptsUs;
    if (segEnd !== null && segEnd !== undefined && p >= segEnd) break;
    if (p <= start) continue;
    if (p > limit) { firstAfter = p; break; }
    best = p;
  }
  // flush(): the end of the last video frame, after every frame start.
  var tail = this._videoTailEndUs;
  if (tail !== null && tail > start && (segEnd === null || segEnd === undefined || tail < segEnd)) {
    if (tail <= limit) best = tail;
    else if (firstAfter === null) firstAfter = tail;
  }
  // Complete once something at/after the target exists: a chunk at
  // exactly the limit, a chunk past it, or the known segment end.
  var reached = (best === limit) || firstAfter !== null ||
                (segEnd !== null && segEnd !== undefined);
  if (!reached) return null;
  if (best !== null) return best;
  // Nothing starts in (start, limit]: the part ends at the target.
  return Math.max(start + 1, Math.floor(limit));
};

/**
 * Write one part ending at partEnd (segEnd: the segment's end when
 * known). A part with no media (a time nothing covers) is a GAP part.
 */
SegmentBuilder.prototype._emitPart = function (partEnd, segEnd) {
  var videoForPart    = _spliceUpTo(this._videoBuf,    partEnd);
  var audioForPart    = _spliceUpTo(this._audioBuf,    partEnd);

  if (videoForPart.length === 0 && audioForPart.length === 0) {
    return this._emitGapPart(partEnd, false);
  }
  var metadataForPart = _spliceUpTo(this._metadataBuf, partEnd);

  // The first init-segment must go out before any part. Only emits
  // once per stream; later calls return null from writeInit.
  this._emitInitOnce();

  var partStart = this._partStartPtsUs;
  // The last video frame lasts until the next one starts (the part's
  // end, unless the part was cut inside a frame longer than the target).
  var videoEnd = this._videoBuf.length > 0 ? this._videoBuf[0].ptsUs :
    this._videoTailEndUs !== null ? this._videoTailEndUs :
    (segEnd !== null && segEnd !== undefined) ? segEnd : partEnd;
  var partBytes = this._writer.writeSegment(
    videoForPart, audioForPart, videoEnd, metadataForPart);

  // Track the part's location within the in-progress segment file so
  // EXT-X-PART can declare BYTERANGE for byte-range fetches.
  var byteOffset = this._segmentByteCursor;
  var byteLength = partBytes.length;
  this._segmentByteCursor += byteLength;
  this._segmentPartBytes.push(partBytes);

  var partInfo = {
    bytes:           partBytes,
    duration:        (partEnd - partStart) / 1000000,
    startPtsUs:      partStart,
    endPtsUs:        partEnd,
    byteOffset:      byteOffset,
    byteLength:      byteLength,
    independent:     this._firstPartOfSegmentIndependent ||
                     _hasIndependentFrame(this._hasVideo, videoForPart, audioForPart),
    gap:             false,
    partIndex:       this._segmentParts.length,
    segmentSequence: this._sequence,    // segment that contains this part
    final:           false,             // becomes true via _emit when seg seals
    videoFrames:     videoForPart.length,
    audioFrames:     audioForPart.length,
    metadataEvents:  metadataForPart.length,
  };
  this._segmentParts.push(partInfo);
  this._firstPartOfSegmentIndependent = false;
  this._partStartPtsUs = partEnd;

  this._onPart(partInfo);
  return true;
};

/**
 * A part over a time no media sample starts in (after a frame longer
 * than PART-TARGET): listed with GAP=YES, no bytes. Metadata in it waits
 * for the next part.
 */
SegmentBuilder.prototype._emitGapPart = function (partEnd, isFinal) {
  var partStart = this._partStartPtsUs;
  if (!(partEnd > partStart)) return false;
  var partInfo = {
    bytes:           new Uint8Array(0),
    duration:        (partEnd - partStart) / 1000000,
    startPtsUs:      partStart,
    endPtsUs:        partEnd,
    byteOffset:      this._segmentByteCursor,
    byteLength:      0,
    independent:     false,
    gap:             true,
    partIndex:       this._segmentParts.length,
    segmentSequence: this._sequence,
    final:           isFinal,
    videoFrames:     0,
    audioFrames:     0,
    metadataEvents:  0,
  };
  this._segmentParts.push(partInfo);
  this._firstPartOfSegmentIndependent = false;
  this._partStartPtsUs = partEnd;
  this._onPart(partInfo);
  return true;
};

/**
 * Does a part contain an independent frame? rfc8216bis §4.4.4.9: every
 * Partial Segment containing one SHOULD carry INDEPENDENT=YES (clients
 * join and switch renditions there). Only the first part of each segment
 * was marked, so a part starting on a mid-segment keyframe (a GOP shorter
 * than the segment) and every audio-only part after the first — each AAC /
 * Opus frame decodes on its own — said INDEPENDENT=NO.
 */
function _hasIndependentFrame(hasVideo, video, audio) {
  if (!hasVideo) return audio.length > 0;
  for (var i = 0; i < video.length; i++) if (video[i].isKey) return true;
  return false;
}

/**
 * Scan _videoBuf for an IDR that's already past the current
 * segment's duration and, if found, set it as the new pending
 * boundary. Used after a seal to handle cases where multiple
 * boundaries queued up in the buffer at once.
 */
/** Does a segment that started at _segmentStartPtsUs end at ptsUs? */
SegmentBuilder.prototype._isBoundary = function (ptsUs) {
  var d = this._segmentDurationUs;
  if (this._gridAligned) return Math.floor(ptsUs / d) > Math.floor(this._segmentStartPtsUs / d);
  return ptsUs - this._segmentStartPtsUs >= d;
};

/** Would a segment from fromUs to toUs outgrow the explicit target? */
SegmentBuilder.prototype._overTarget = function (fromUs, toUs) {
  return this._targetDurationSec > 0 &&
         Math.round((toUs - fromUs) / 1000000) > this._targetDurationSec;
};

/**
 * Where a segment that would otherwise end at endUs closes: the latest
 * chunk start in buf after the segment's start that keeps it within the
 * target — a keyframe if one does (audio frames all are) —, else the
 * first chunk after the start (the frame there alone is longer than the
 * target), else endUs.
 */
SegmentBuilder.prototype._forcedBoundary = function (buf, endUs) {
  var start = this._segmentStartPtsUs;
  var key = null, any = null, first = null;
  for (var i = 0; i < buf.length; i++) {
    var p = buf[i].ptsUs;
    if (p >= endUs) break;
    if (p <= start) continue;
    if (first === null) first = p;
    if (this._overTarget(start, p)) break;
    any = p;
    if (buf[i].isKey !== false) key = p;
  }
  if (key !== null) return key;
  if (any !== null) return any;
  return first !== null ? first : endUs;
};

SegmentBuilder.prototype._maybeDetectNewBoundary = function () {
  for (var i = 1; i < this._videoBuf.length; i++) {
    var c = this._videoBuf[i];
    if (this._overTarget(this._segmentStartPtsUs, c.ptsUs)) {
      this._pendingBoundaryPtsUs = this._forcedBoundary(this._videoBuf, c.ptsUs);
      this._maybeSealPending();
      return;
    }
    if (c.isKey && this._isBoundary(c.ptsUs)) {
      this._pendingBoundaryPtsUs = c.ptsUs;
      this._maybeSealPending();
      return;
    }
  }
};

/**
 * Seal at a hard PTS boundary (trigger keyframe). All buffered video
 * goes to the sealed segment. Audio is split by PTS — frames before
 * the boundary go in, frames at-or-after stay for the next segment.
 * Metadata is split the same way as audio.
 */
SegmentBuilder.prototype._sealSegment = function (boundaryPtsUs) {
  var videoChunks = this._videoBuf;
  this._videoBuf = [];
  var audioForSegment    = _spliceUpTo(this._audioBuf,    boundaryPtsUs);
  var metadataForSegment = _spliceUpTo(this._metadataBuf, boundaryPtsUs);
  this._emit(videoChunks, audioForSegment, metadataForSegment,
             this._segmentStartPtsUs, boundaryPtsUs);
};

/**
 * Seal everything buffered (no split). Used by flush() at end-of-
 * stream where there's no "next segment" to keep audio for.
 */
SegmentBuilder.prototype._sealAtBoundary = function (endPtsUs) {
  var videoChunks = this._videoBuf;
  var audioChunks = this._audioBuf;
  var metadataChunks = this._metadataBuf;
  this._videoBuf = [];
  this._audioBuf = [];
  this._metadataBuf = [];
  this._emit(videoChunks, audioChunks, metadataChunks,
             this._segmentStartPtsUs, endPtsUs);
};

/**
 * Run the writer to produce segment bytes, then deliver to onSegment.
 *
 * The writer interface is uniform: writeInit() once for codec setup
 * (returns null for formats without init segments), then writeSegment()
 * per segment with the accumulated chunks. Each writer takes care of
 * its own format-specific concerns — interleaving for TS, box layout
 * for fMP4 — so this method stays simple and format-agnostic.
 *
 * Two onSegment callbacks may fire on the very first segment (init +
 * media); subsequent segments fire one (media only).
 */

/**
 * Emit the init segment exactly once per stream. Idempotent — safe
 * to call from both _emit (non-LL-HLS) and _maybeEmitPart (LL-HLS,
 * where init must precede the first part). For TS the writer's
 * writeInit returns null and we don't fire an event.
 */
SegmentBuilder.prototype._emitInitOnce = function () {
  if (this._initEmitted) return;
  var initBytes = this._writer.writeInit();
  if (initBytes) {
    this._onSegment({ kind: 'init', bytes: initBytes });
  }
  this._initEmitted = true;
};

SegmentBuilder.prototype._emit = function (videoChunks, audioChunks, metadataChunks, startPtsUs, endPtsUs) {
  var w = this._writer;
  // This segment's independence, and the next one's: it starts on the
  // first frame left (a keyframe unless a forced cut put it there).
  var segmentIndependent = this._segmentIndependent;
  var nextIndependent = !(this._hasVideo && this._videoBuf.length > 0 && !this._videoBuf[0].isKey);
  this._segmentIndependent = nextIndependent;

  // Emit init segment once. TSWriter.writeInit() returns null and
  // nothing is published; FMP4Writer.writeInit() returns ftyp+moov.
  this._emitInitOnce();

  var bytes;
  var partsForSegment = null;
  var iFrameRange = null;

  if (this._partDurationUs > 0) {
    // LL-HLS path: parts emitted during the segment have already been
    // written (each is its own moof+mdat). The chunks passed in here
    // are the leftover trailing chunks that didn't fill a full part —
    // we wrap them as the FINAL part. Edge case: if leftovers are
    // empty (the IDR fell right on a part boundary), no final part.
    if (videoChunks.length === 0 && audioChunks.length === 0 &&
        endPtsUs > this._partStartPtsUs) {
      // Nothing starts in the rest of the segment (after a frame longer
      // than PART-TARGET): a final GAP part; its metadata waits for the
      // next segment.
      for (var mi = metadataChunks.length - 1; mi >= 0; mi--) this._metadataBuf.unshift(metadataChunks[mi]);
      metadataChunks = [];
      this._emitGapPart(endPtsUs, true);
    } else if (videoChunks.length > 0 || audioChunks.length > 0 || metadataChunks.length > 0) {
      var finalPartBytes = w.writeSegment(videoChunks, audioChunks, endPtsUs, metadataChunks);
      var finalPartInfo = {
        bytes:           finalPartBytes,
        duration:        (endPtsUs - this._partStartPtsUs) / 1000000,
        startPtsUs:      this._partStartPtsUs,
        endPtsUs:        endPtsUs,
        byteOffset:      this._segmentByteCursor,
        byteLength:      finalPartBytes.length,
        independent:     this._firstPartOfSegmentIndependent ||
                         _hasIndependentFrame(this._hasVideo, videoChunks, audioChunks),
        gap:             false,
        partIndex:       this._segmentParts.length,
        segmentSequence: this._sequence,
        final:           true,
        videoFrames:     videoChunks.length,
        audioFrames:     audioChunks.length,
        metadataEvents:  metadataChunks.length,
      };
      this._segmentByteCursor += finalPartBytes.length;
      this._segmentPartBytes.push(finalPartBytes);
      this._segmentParts.push(finalPartInfo);
      this._onPart(finalPartInfo);
    } else if (this._segmentParts.length > 0) {
      // No leftover chunks but there were earlier parts. Mark the last
      // emitted part as final so the playlist can avoid emitting an
      // EXT-X-PRELOAD-HINT for a part that won't materialize.
      this._segmentParts[this._segmentParts.length - 1].final = true;
    }

    // Concatenate all part bytes for the 'segment' event. The result
    // is a valid CMAF/fMP4 segment file — players can fetch it whole
    // (legacy clients) or via byte ranges (LL-HLS clients).
    bytes = concat(this._segmentPartBytes);
    partsForSegment = this._segmentParts;

    // I-frame range (LL-HLS path): the first part of the segment is
    // INDEPENDENT (starts on a keyframe), so its byte range IS the
    // I-frame's byte range. Free, no extra writer call. (Not for a
    // segment a forced cut started on another frame: a keyframe later in
    // its first part would come after frames that need the one before.)
    if (this._iFramePlaylistEnabled && segmentIndependent && this._segmentParts.length > 0) {
      var firstPart = this._segmentParts[0];
      if (firstPart.independent) {
        iFrameRange = {
          byteOffset: firstPart.byteOffset,
          byteLength: firstPart.byteLength,
          ptsUs:      firstPart.startPtsUs,
        };
      }
    }

    // Reset per-segment LL-HLS state for the next segment.
    this._segmentPartBytes = [];
    this._segmentParts = [];
    this._segmentByteCursor = 0;
    this._partStartPtsUs = endPtsUs;
    this._firstPartOfSegmentIndependent = nextIndependent;
  } else if (this._iFramePlaylistEnabled && this._hasVideo &&
             videoChunks.length > 1 && videoChunks[0].isKey && _writerIsFmp4(w)) {
    // fMP4 + I-frame playlist + non-LL-HLS: split the segment into
    // two fragments. The first fragment carries only the keyframe (no
    // audio, no metadata); the second carries everything else. The
    // resulting segment file is valid multi-fragment fMP4 — players
    // that fetch the whole file see two fragments back-to-back.
    //
    // The I-frame byterange covers exactly the first fragment.
    var keyframeOnly = [videoChunks[0]];
    var restVideo    = videoChunks.slice(1);
    // The keyframe-only fragment ends where the next frame starts. It
    // was given the SEGMENT end, so the writer stretched the IDR's
    // sample duration to the whole segment (2.0 s) and the first
    // fragment overlapped the second one's timeline.
    var bytes1 = w.writeSegment(keyframeOnly, [], restVideo[0].ptsUs, []);
    var bytes2 = w.writeSegment(restVideo, audioChunks, endPtsUs, metadataChunks);
    bytes = concat([bytes1, bytes2]);
    iFrameRange = {
      byteOffset: 0,
      byteLength: bytes1.length,
      ptsUs:      videoChunks[0].ptsUs,
    };
  } else {
    // Standard non-LL path — single writeSegment for the whole
    // segment. For TS, the writer's _lastIFrameRange is populated as
    // a side effect when iFramePlaylist is on, and we read it after.
    bytes = w.writeSegment(videoChunks, audioChunks, endPtsUs, metadataChunks);
    if (this._iFramePlaylistEnabled && w._lastIFrameRange) {
      iFrameRange = w._lastIFrameRange;
    }
  }

  var info = {
    kind:           'media',
    bytes:          bytes,
    duration:       (endPtsUs - startPtsUs) / 1000000,
    startPtsUs:     startPtsUs,
    endPtsUs:       endPtsUs,
    sequence:       this._sequence++,
    independent:    segmentIndependent,
    videoFrames:    videoChunks.length,
    audioFrames:    audioChunks.length,
    metadataEvents: metadataChunks.length,
  };
  if (partsForSegment) info.parts = partsForSegment;
  if (iFrameRange)     info.iFrame = iFrameRange;

  if (this._encryption) {
    // Enqueue and try to process. The queue handles ordering and
    // also "encryptor not yet ready" (set later with setEncryptor).
    this._pendingEncryptions.push(info);
    this._processEncryptionQueue();
  } else {
    this._onSegment(info);
  }
};

/**
 * Drive the encryption queue forward. Re-entrancy-safe: returns
 * immediately if encryption is already in flight or the encryptor
 * hasn't been wired up yet. Called both when new work arrives
 * (_emit) and when previous work completes (encrypt callback).
 */
SegmentBuilder.prototype._processEncryptionQueue = function () {
  if (this._encryptionInProgress) return;
  if (!this._encryption) return;
  // No encryptor yet: keep waiting — UNLESS the key import has
  // terminally failed, in which case fall through so drain subscribers
  // fire and anyone blocked on end() is released.
  if (!this._encryption.encryptor && !this._encryption.failed) return;
  if (this._encryption.failed) {
    // Key import failed: anything sealed since becomes a gap too.
    var late = this._pendingEncryptions;
    this._pendingEncryptions = [];
    for (var li = 0; li < late.length; li++) this._emitGap(late[li]);
  }
  if (this._pendingEncryptions.length === 0) {
    // Queue is empty — fire all drain subscribers and clear the list.
    if (this._drainCallbacks.length > 0) {
      var cbs = this._drainCallbacks;
      this._drainCallbacks = [];
      for (var di = 0; di < cbs.length; di++) {
        try { cbs[di](); } catch (e) {
          if (typeof console !== 'undefined' && console.error) {
            console.error('SegmentBuilder: drain callback threw:', e);
          }
        }
      }
    }
    return;
  }

  this._encryptionInProgress = true;
  var info = this._pendingEncryptions.shift();
  var enc = this._encryption;
  // IV: explicit (constant for all segments) or derived from sequence
  // number (different IV per segment, matches the no-IV-attribute case
  // in EXT-X-KEY).
  // The sequence-derived IV is the segment's Media Sequence Number.
  var iv = enc.iv || ivFromSequence(this._firstMediaSequence + info.sequence);
  var self = this;
  enc.encryptor.encrypt(info.bytes, iv, function (err, ciphertext) {
    self._encryptionInProgress = false;
    // A throw from onSegment here has no caller to reach: it used to
    // escape the encrypt callback as an uncaught exception (in Node, the
    // end of the process; HLSEncoder: a segment URI the playlist refuses)
    // and the queue stopped. It goes to onError, as the builder's other
    // asynchronous failures do, and the queue moves on.
    try {
      self._deliverEncrypted(info, err, ciphertext);
    } catch (e) {
      self._reportError(e);
    }
    // Process next regardless of error so the queue keeps moving.
    self._processEncryptionQueue();
  });
};

/** The encrypt callback's delivery: the ciphertext, or a gap on failure. */
SegmentBuilder.prototype._deliverEncrypted = function (info, err, ciphertext) {
  if (err) {
    // One bad segment shouldn't halt the stream — but it must keep
    // its place in the timeline. It used to be dropped outright: the
    // playlist then renumbered every later segment (seg2.ts listed at
    // MSN 1) while each had been encrypted with IV = its own sequence
    // (2), so a player — which derives the IV from the MSN — decrypted
    // every following segment with the wrong IV, and the media
    // timeline jumped with no EXT-X-DISCONTINUITY. Now the segment is
    // delivered as a gap (no bytes), which the playlist lists as
    // EXT-X-GAP: MSNs and IVs stay aligned and players skip over it.
    this._reportError(new Error(
      'SegmentBuilder: segment encryption failed for sequence=' +
      info.sequence + ': ' + ((err && err.message) || err)
    ));
    this._emitGap(info);
  } else {
    info.bytes = ciphertext;
    this._onSegment(info);
  }
};

/**
 * Deliver a segment that has no usable bytes (encryption failed) as a
 * gap: info.gap = true, info.bytes = null. The listener lists it with
 * EXT-X-GAP so the segment keeps its Media Sequence Number and duration.
 */
SegmentBuilder.prototype._emitGap = function (info) {
  info.bytes = null;
  info.gap = true;
  if (info.parts) info.parts = null;
  if (info.iFrame) info.iFrame = null;
  this._onSegment(info);
};

/** Report a non-fatal problem to the caller, falling back to the console. */
SegmentBuilder.prototype._reportError = function (err) {
  if (typeof this._onError === 'function') {
    try { this._onError(err); return; } catch (e) { /* fall through */ }
  }
  if (typeof console !== 'undefined' && console.error) console.error(err);
};

/**
 * Declare that the encryptor will never arrive — the key import failed.
 *
 * Without this the builder waits forever: _processEncryptionQueue
 * returns early while `encryption.encryptor` is null, so it never
 * reaches the branch that fires drain subscribers. Queued segments
 * stayed queued, and HLSEncoder.end() — which completes only once
 * onEncryptionDrained fires — never returned. The caller did receive an
 * 'error' event for the failed import, but their end() hung anyway, so
 * the stream never appeared to finish.
 *
 * Pending segments are discarded rather than emitted in the clear: the
 * playlist carries an EXT-X-KEY directive, so plaintext bytes under
 * that URI would be worse than a missing segment.
 */
SegmentBuilder.prototype.failEncryption = function (err) {
  if (!this._encryption) return;
  this._encryption.failed = err || new Error('encryption unavailable');
  var dropped = this._pendingEncryptions;
  this._pendingEncryptions = [];
  for (var i = 0; i < dropped.length; i++) {
    this._reportError(new Error(
      'SegmentBuilder: dropping segment sequence=' + dropped[i].sequence +
      ' — encryption unavailable: ' + this._encryption.failed.message
    ));
    this._emitGap(dropped[i]);   // keep the timeline, see _processEncryptionQueue
  }
  this._encryptionInProgress = false;
  this._processEncryptionQueue();
};

/**
 * Inject the encryptor after construction. Used by HLSEncoder which
 * creates the encryptor asynchronously and only has the
 * ready Encryptor instance later. Calling this also kicks off any
 * segments that were enqueued in the meantime.
 *
 * @param {object}     encryptor   { encrypt(plaintext, iv, callback) }
 * @param {Uint8Array} [iv]        Explicit constant IV, or null/omit
 *                                  to derive from sequence number.
 */
SegmentBuilder.prototype.setEncryptor = function (encryptor, iv) {
  if (!this._encryption) {
    // Encryption was not configured at construction time — refuse
    // to attach an encryptor now, since the playlist won't have an
    // EXT-X-KEY directive and the output would be unusable.
    throw new Error('SegmentBuilder.setEncryptor: encryption was not ' +
                    'enabled in constructor opts');
  }
  this._encryption.encryptor = encryptor;
  if (iv) this._encryption.iv = iv;
  this._processEncryptionQueue();
};

/**
 * Register a callback to fire once when all currently-queued and
 * in-flight encryptions have completed. Used by HLSEncoder.end so
 * the caller's `end(callback)` only fires after the final 'segment'
 * event has been delivered.
 *
 * Multiple callbacks can be registered; all fire when the queue
 * drains. Each is one-shot — a callback that needs to fire on
 * subsequent drains must re-register inside its own body.
 *
 * If encryption is not configured, or the queue is already empty,
 * the callback fires on the next tick (never synchronously, to
 * avoid surprising re-entrance into the caller).
 */
SegmentBuilder.prototype.onEncryptionDrained = function (callback) {
  if (typeof callback !== 'function') {
    throw new TypeError('SegmentBuilder.onEncryptionDrained: callback required');
  }
  if (!this._encryption || this._encryption.failed ||
      (!this._encryptionInProgress && this._pendingEncryptions.length === 0)) {
    // Nothing in flight or pending — fire on next tick. We never
    // call back synchronously, even when the answer is trivially
    // "already done", because callers tend to assume async cadence
    // and may have unfinished setup on the calling line.
    setTimeout(callback, 0);
    return;
  }
  this._drainCallbacks.push(callback);
};

/**
 * Distinguish the two writer types without an instanceof import.
 * fMP4 has a `setVideoConfig` method; TS doesn't. Used for the
 * non-LL-HLS I-frame split — we only do the moof+mdat split for
 * fMP4 (TS keyframe ranges are tracked in-place by the writer).
 */
function _writerIsFmp4(w) {
  return typeof w.setVideoConfig === 'function';
}


export default SegmentBuilder;
