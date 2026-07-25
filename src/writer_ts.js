/**
 * writer-ts — MPEG-TS container writer for HLS segments.
 *
 * Symmetric counterpart to reader_ts.js. Given encoded H.264/H.265
 * AUs in Annex-B format and AAC frames in ADTS format, produces
 * standards-compliant MPEG-TS bytes suitable for direct upload as
 * .ts segments in an HLS playlist.
 *
 * Usage:
 *   var writer = new TSWriter({
 *     video: { codec: 'h264' },
 *     audio: { codec: 'aac' },
 *   });
 *
 *   // At the start of every segment
 *   bytes.push(writer.writePSI());
 *
 *   // For each video AU (must already be Annex-B with SPS/PPS at
 *   // start of every keyframe — caller's responsibility)
 *   bytes.push(writer.writeVideo(au, { ptsUs, dtsUs }));
 *
 *   // For each audio frame (must already be ADTS-wrapped)
 *   bytes.push(writer.writeAudio(adtsFrame, { ptsUs }));
 *
 *   // At segment boundary, before next writePSI()
 *   writer.reset();
 *
 * Each method returns a Uint8Array containing zero or more 188-byte
 * TS packets. The writer holds no buffering — output is emitted
 * synchronously per call.
 *
 * Design choices (see the corresponding methods for details):
 *   - The writer is dumb: it does NOT cache SPS/PPS, does NOT split
 *     AUs by NAL type, does NOT compute DTS from frame ordering.
 *     Every responsibility that requires looking across frames is
 *     pushed up to HLSEncoder.
 *   - PCR rides on the video PID (or audio if video-less). Standard
 *     practice and matches FFmpeg's output.
 *   - Continuity counters reset on reset() — call between segments
 *     so each segment is self-contained.
 */

import { writeU32BE, concat } from './core/bytes.js';
import {
  PACKET_SIZE, SYNC_BYTE,
  PID_PAT, PID_PMT, PID_VIDEO, PID_AUDIO, PID_METADATA,
  STREAM_ID_VIDEO, STREAM_ID_AUDIO, STREAM_ID_METADATA,
  STREAM_TYPE_H264, STREAM_TYPE_H265, STREAM_TYPE_AAC, STREAM_TYPE_METADATA,
} from './utils/ts_constants.js';





// ── CRC-32/MPEG-2 ──────────────────────────────────────────
//
// Polynomial 0x04C11DB7, unreflected, init 0xFFFFFFFF, no final XOR.
// Same polynomial and direction as Ogg's CRC-32 (writer_ogg.js) but
// different initial value — the lookup table is reusable, only the
// running state init differs.
//
// Used to terminate every PSI section (PAT, PMT). The CRC covers the
// section bytes from table_id through the byte just before the CRC
// itself.

var _CRC_TABLE_MPEG2 = (function () {
  var table = new Uint32Array(256);
  for (var i = 0; i < 256; i++) {
    var crc = (i << 24) >>> 0;
    for (var j = 0; j < 8; j++) {
      if (crc & 0x80000000) {
        crc = (((crc << 1) >>> 0) ^ 0x04C11DB7) >>> 0;
      } else {
        crc = (crc << 1) >>> 0;
      }
    }
    table[i] = crc;
  }
  return table;
})();

function _crc32mpeg2(buf, start, end) {
  var crc = 0xFFFFFFFF;
  for (var i = start; i < end; i++) {
    crc = (((crc << 8) >>> 0) ^ _CRC_TABLE_MPEG2[((crc >>> 24) ^ buf[i]) & 0xFF]) >>> 0;
  }
  return crc;
}


// ══════════════════════════════════════════════════════════
//   TSWriter
// ══════════════════════════════════════════════════════════

/**
 * @param {object} opts
 * @param {object} [opts.video]  { codec: 'h264' | 'h265' }
 * @param {object} [opts.audio]  { codec: 'aac' }
 *
 * At least one of video / audio must be set. If both, video carries
 * the PCR (standard practice). For audio-only streams audio carries
 * the PCR.
 */
function TSWriter(opts) {
  if (!opts) opts = {};
  var video = opts.video || null;
  var audio = opts.audio || null;

  if (!video && !audio) {
    throw new Error('TSWriter: at least one of video/audio must be configured');
  }
  if (video && video.codec !== 'h264' && video.codec !== 'h265') {
    if (video.codec === 'vp9' || video.codec === 'av1') {
      throw new Error("TSWriter: '" + video.codec + "' is not supported in MPEG-TS; use the fMP4 writer (format: 'fmp4')");
    }
    throw new Error('TSWriter: video codec must be h264 or h265');
  }
  if (audio && audio.codec !== 'aac') {
    if (audio.codec === 'opus') {
      throw new Error("TSWriter: opus is not supported in MPEG-TS; use the fMP4 writer (format: 'fmp4')");
    }
    throw new Error('TSWriter: audio codec must be aac');
  }

  this._video = video;
  this._audio = audio;
  this._pcrPid = video ? PID_VIDEO : PID_AUDIO;

  // Whether the metadata stream is declared in PMT and being
  // packetized into segments. Off by default; enableMetadata() flips
  // it and rebuilds the PMT template. Once on, every subsequent PMT
  // emission carries the metadata stream entry — even if no metadata
  // is fed in a given segment, since players expect PMT consistency.
  this._metadataEnabled = false;

  // ── I-frame playlist support ──
  // When enabled, writeSegment computes the byte range of the first
  // video PES (the keyframe) within the segment. The range starts at
  // offset 0 (so it includes PAT+PMT, which the player needs to
  // decode). Stored on the writer rather than returned because we
  // can't change writeSegment's return type without breaking
  // callers — segment-builder reads this immediately after writing.
  this._iFramePlaylistEnabled = false;
  this._lastIFrameRange = null;

  // Per-PID continuity counters (4-bit, wraps at 16). PAT and PMT
  // each get their own counter even though they're rarely repeated
  // within a segment — convention is to track them anyway in case a
  // long segment needs a second PSI insertion.
  this._cc = {};
  this._cc[PID_PAT]      = 0;
  this._cc[PID_PMT]      = 0;
  this._cc[PID_VIDEO]    = 0;
  this._cc[PID_AUDIO]    = 0;
  this._cc[PID_METADATA] = 0;

  // Pre-build PAT and PMT packet templates. Their bytes are fully
  // determined by the writer's video/audio config; only the CC nibble
  // changes between segments, and that's a single byte we patch on
  // copy-out. The CRC32 — the most expensive part of building these —
  // is computed once here and reused for every segment. Saves ~50µs
  // per segment plus all the byte-by-byte writes.
  this._patTemplate = this._buildPATPacket();  // increments _cc[PID_PAT] to 1
  this._pmtTemplate = this._buildPMTPacket();  // increments _cc[PID_PMT] to 1
  // Reset the counters we just bumped — they should start at 0 for
  // the first real PSI emission.
  this._cc[PID_PAT] = 0;
  this._cc[PID_PMT] = 0;
}

/**
 * Enable carriage of timed metadata (ID3v2) in subsequent segments.
 * Adds the metadata stream to PMT (stream_type=0x15 with ID3
 * registration_descriptor) and starts accepting metadata chunks in
 * writeSegment.
 *
 * Idempotent: calling more than once is safe and has no effect after
 * the first. Cannot be undone — once a TS stream declares metadata,
 * subsequent segments must keep declaring it for player consistency.
 *
 * Called by HLSEncoder on the first feedMetadata() invocation, so
 * callers don't normally need to invoke this directly.
 */
TSWriter.prototype.enableMetadata = function () {
  if (this._metadataEnabled) return;
  this._metadataEnabled = true;
  // Clear the cached PMT template so _buildPMTPacket falls through to
  // the full-build path (otherwise it would copy the old, metadata-
  // less template). Reset the CC counter as well — the template
  // build path normally bumps it.
  this._pmtTemplate = null;
  var savedCc = this._cc[PID_PMT];
  this._pmtTemplate = this._buildPMTPacket();
  this._cc[PID_PMT] = savedCc;
};

/**
 * Enable byte-range tracking for the first video PES in each segment,
 * used to build EXT-X-I-FRAMES-ONLY playlists. Once enabled,
 * writeSegment populates `_lastIFrameRange` after each call with
 * { byteOffset: 0, byteLength: ..., ptsUs: ... }. The range starts
 * at 0 so it covers PAT + PMT — players need both to decode the
 * keyframe stand-alone.
 *
 * Idempotent. Has no effect on segment bytes — only on bookkeeping.
 */
TSWriter.prototype.enableIFramePlaylist = function () {
  this._iFramePlaylistEnabled = true;
};

/**
 * Build PAT + PMT TS packets. Call this at the start of every segment
 * — every HLS .ts segment must begin with PSI so it can be decoded
 * standalone (HLS players seek by jumping to segment boundaries and
 * expect PSI at the top).
 *
 * Returns 376 bytes (two 188-byte packets).
 */
TSWriter.prototype.writePSI = function () {
  return concat([this._buildPATPacket(), this._buildPMTPacket()]);
};

/**
 * Encode one video AU as one or more TS packets.
 *
 * @param {Uint8Array} au
 *   The complete access unit in Annex-B (start codes intact). For
 *   keyframes this MUST include SPS and PPS (and VPS for H.265) at
 *   the start, otherwise downstream decoders will fail until they
 *   see the next IDR with parameter sets. HLSEncoder is responsible
 *   for ensuring this.
 *
 * @param {object} opts
 * @param {number} opts.ptsUs   Presentation timestamp in microseconds.
 * @param {number} [opts.dtsUs] Decode timestamp in microseconds. Defaults
 *   to ptsUs (correct for any stream without B-frames). For B-frame
 *   content the caller must compute and supply DTS.
 */
TSWriter.prototype.writeVideo = function (au, opts) {
  if (!this._video) {
    throw new Error('TSWriter: writeVideo called but writer has no video config');
  }
  var pts = opts.ptsUs;
  var dts = (opts.dtsUs !== undefined && opts.dtsUs !== null) ? opts.dtsUs : pts;
  var pes = this._buildPES(STREAM_ID_VIDEO, au, pts, dts, /*useLength*/ false);
  // PCR rides on video PID and equals DTS: the decoder uses it to
  // schedule when the *current* sample should be delivered to the
  // decode buffer, which is DTS (not PTS).
  return this._packetize(PID_VIDEO, pes, dts);
};

/**
 * Encode one audio frame as one or more TS packets.
 *
 * @param {Uint8Array} adts
 *   ADTS-wrapped AAC frame (header + payload). HLSEncoder is
 *   responsible for the ADTS wrapping — see aac-utils.wrapAdts.
 * @param {object} opts
 * @param {number} opts.ptsUs   Presentation timestamp in microseconds.
 *   Audio has no DTS (no reordering), so PTS = DTS implicitly.
 */
TSWriter.prototype.writeAudio = function (adts, opts) {
  if (!this._audio) {
    throw new Error('TSWriter: writeAudio called but writer has no audio config');
  }
  var pts = opts.ptsUs;
  var pes = this._buildPES(STREAM_ID_AUDIO, adts, pts, null, /*useLength*/ true);
  // For audio-only streams audio carries PCR; otherwise no PCR here.
  var pcrUs = (this._pcrPid === PID_AUDIO) ? pts : null;
  return this._packetize(PID_AUDIO, pes, pcrUs);
};

/**
 * Reset all continuity counters to zero. Call at segment boundaries
 * before the next writePSI(): every HLS segment is independently
 * decodable, and the convention (FFmpeg, etc.) is to reset CCs so a
 * player can splice segments in any order.
 */
TSWriter.prototype.reset = function () {
  this._cc[PID_PAT]      = 0;
  this._cc[PID_PMT]      = 0;
  this._cc[PID_VIDEO]    = 0;
  this._cc[PID_AUDIO]    = 0;
  this._cc[PID_METADATA] = 0;
};

// ── Unified writer API ────────────────────────────────────
//
// SegmentBuilder talks to writers through a small interface that
// works for both TS and fMP4: writeInit() produces a one-time
// "initialization segment" (null for TS — no concept), and
// writeSegment() produces a complete media segment from accumulated
// chunks. The chunk-by-chunk methods above (writePSI, writeVideo,
// writeAudio) remain available for low-level use and tests.

/**
 * For format symmetry with FMP4Writer. Always returns true — TS has
 * no separate codec configuration that needs to be supplied before
 * segments can be produced; SPS/PPS travel inline in Annex-B AUs.
 */
TSWriter.prototype.canWriteInit = function () { return true; };

/**
 * For format symmetry with FMP4Writer. TS streams have no separate
 * init segment — every segment carries its own PAT+PMT, so `null`
 * means "skip init emission" to SegmentBuilder.
 */
TSWriter.prototype.writeInit = function () { return null; };

/**
 * Build a complete media segment as a single Uint8Array.
 *
 * @param {Array}  videoChunks  [{ au, ptsUs, dtsUs, isKey }] — au is Annex-B
 * @param {Array}  audioChunks  [{ data, ptsUs, durationUs }] — data is ADTS-wrapped
 * @param {number} [endPtsUs]   The PTS at which this segment ends. Accepted
 *                              for signature consistency with FMP4Writer
 *                              (which needs it to set the last frame's
 *                              duration explicitly). TS doesn't need it —
 *                              PESes carry their own PTS and the player
 *                              derives display duration from successive
 *                              PTSes across consecutive segments.
 */
TSWriter.prototype.writeSegment = function (videoChunks, audioChunks, endPtsUs, metadataChunks) {
  videoChunks    = videoChunks    || [];
  audioChunks    = audioChunks    || [];
  metadataChunks = metadataChunks || [];
  if (videoChunks.length === 0 && audioChunks.length === 0 &&
      metadataChunks.length === 0) {
    throw new Error('TSWriter.writeSegment: at least one chunk required');
  }

  // If metadata is fed but the stream wasn't pre-enabled, enable it
  // now. The PMT in this segment will declare the metadata stream;
  // earlier segments (without metadata) declared only a/v. Players
  // reading mid-stream will refresh PMT on this segment via
  // version_number bump — except we keep version_number constant for
  // simplicity, so a player joining at this segment is fine, and
  // players already reading just see a new stream appear (which is
  // valid per ISO 13818-1 if PMT version doesn't change but PCR/
  // section-CRC reflect the new layout). For the cleanest behavior,
  // callers should enableMetadata() upfront before writing any segment.
  if (metadataChunks.length > 0 && !this._metadataEnabled) {
    this.enableMetadata();
  }

  this.reset();

  // Sort all chunks by DTS (video) / PTS (audio + metadata). MPEG-TS
  // tolerates any interleaving, but DTS-ordered output minimizes
  // player buffering and matches what FFmpeg produces.
  var ordered = [];
  for (var i = 0; i < videoChunks.length; i++) {
    var v = videoChunks[i];
    var key = (v.dtsUs !== undefined && v.dtsUs !== null) ? v.dtsUs : v.ptsUs;
    ordered.push({ kind: 'video', sortKey: key, chunk: v });
  }
  for (var j = 0; j < audioChunks.length; j++) {
    var a = audioChunks[j];
    ordered.push({ kind: 'audio', sortKey: a.ptsUs, chunk: a });
  }
  for (var mi = 0; mi < metadataChunks.length; mi++) {
    var md = metadataChunks[mi];
    ordered.push({ kind: 'metadata', sortKey: md.ptsUs, chunk: md });
  }

  // WebCodecs in 'realtime' latency mode emits chunks in PTS order
  // (no B-frame reordering, FIFO output). When inputs are already
  // sorted we can skip the comparator-driven sort entirely. Cheap
  // O(n) check, big win when n grows (sort is O(n log n) and the
  // comparator is called from JIT'd JS, not native).
  var alreadySorted = true;
  for (var s = 1; s < ordered.length; s++) {
    if (ordered[s].sortKey < ordered[s - 1].sortKey) {
      alreadySorted = false;
      break;
    }
  }
  if (!alreadySorted) {
    ordered.sort(function (x, y) { return x.sortKey - y.sortKey; });
  }

  // Pass 1: build all PESes, count packets needed.
  // PES allocation per chunk is unavoidable (variable-length payload
  // with header), but a segment has ~200 chunks vs ~3000 packets, so
  // moving allocation count from per-packet to per-PES is a 15x win.
  var pesItems = [];
  var totalPackets = 2;  // PAT + PMT lead every segment

  for (var k = 0; k < ordered.length; k++) {
    var item = ordered[k];
    var pid, pes, pcrUs, withPCR;

    if (item.kind === 'video') {
      var pts = item.chunk.ptsUs;
      var dts = (item.chunk.dtsUs !== undefined && item.chunk.dtsUs !== null) ? item.chunk.dtsUs : pts;
      pid = PID_VIDEO;
      pes = this._buildPES(STREAM_ID_VIDEO, item.chunk.au, pts, dts, /*useLength*/ false);
      // PCR rides on video PID and equals DTS (see writeVideo).
      pcrUs = dts;
      withPCR = (pid === this._pcrPid);
    } else if (item.kind === 'audio') {
      var aPts = item.chunk.ptsUs;
      pid = PID_AUDIO;
      pes = this._buildPES(STREAM_ID_AUDIO, item.chunk.data, aPts, null, /*useLength*/ true);
      // Audio PID only carries PCR in audio-only streams.
      pcrUs = (this._pcrPid === PID_AUDIO) ? aPts : null;
      withPCR = (pid === this._pcrPid);
    } else {
      // Metadata. PES uses PTS only (no DTS — metadata events are
      // instantaneous from the player's perspective) and useLength=true
      // because the payload is bounded (a single ID3v2 frame).
      var mdPts = item.chunk.ptsUs;
      pid = PID_METADATA;
      pes = this._buildPES(STREAM_ID_METADATA, item.chunk.data, mdPts, null, /*useLength*/ true);
      pcrUs = null;
      withPCR = false;
    }

    var pktCount = this._packetCountFor(pes.length, withPCR);
    pesItems.push({
      pid:      pid,
      pes:      pes,
      pcrUs:    pcrUs,
      kind:     item.kind,
      chunkPts: item.kind === 'video' ? item.chunk.ptsUs : null,
      isKey:    item.kind === 'video' ? !!item.chunk.isKey : false,
    });
    totalPackets += pktCount;
  }

  // Pass 2: allocate single output buffer, write all packets in place.
  // Replaces ~3000 small Uint8Array allocations + a final concat copy
  // per segment. The output buffer is the only allocation that escapes.
  var out = new Uint8Array(totalPackets * PACKET_SIZE);
  var off = 0;

  off = this._writePATPacketInto(out, off);
  off = this._writePMTPacketInto(out, off);

  // Track keyframe byte range. The first video PES in the segment is
  // the keyframe (HLS requires every segment to start with one). Its
  // bytes plus the leading PAT+PMT form a self-contained byte range
  // a player can fetch and decode for trick-play preview.
  var iFrameStartOff = -1, iFrameEndOff = -1, iFramePts = -1;

  for (var m = 0; m < pesItems.length; m++) {
    var p = pesItems[m];

    if (this._iFramePlaylistEnabled && iFrameStartOff === -1 &&
        p.kind === 'video' && p.isKey) {
      // Range starts at 0 so it covers PAT + PMT, which the player
      // needs to decode standalone.
      iFrameStartOff = 0;
      iFramePts = p.chunkPts;
    }

    off = this._packetizeInto(p.pid, p.pes, p.pcrUs, out, off);

    if (this._iFramePlaylistEnabled && iFrameStartOff !== -1 &&
        iFrameEndOff === -1 && p.kind === 'video' && p.isKey) {
      iFrameEndOff = off;
    }
  }

  this._lastIFrameRange = (this._iFramePlaylistEnabled &&
                           iFrameStartOff !== -1 && iFrameEndOff !== -1) ?
    {
      byteOffset: iFrameStartOff,
      byteLength: iFrameEndOff - iFrameStartOff,
      ptsUs:      iFramePts,
    } : null;

  return out;
};


// ── PSI builders ──────────────────────────────────────────

/**
 * Build a single TS packet carrying a PAT (Program Association Table).
 *
 * PAT body layout (ISO 13818-1 §2.4.4.3):
 *   table_id(8)                              = 0x00
 *   section_syntax_indicator(1) = 1
 *   '0'(1)
 *   reserved(2)                              | section_length(12)
 *   transport_stream_id(16)                  = 1
 *   reserved(2) | version_number(5) | current_next_indicator(1)
 *   section_number(8)                        = 0
 *   last_section_number(8)                   = 0
 *   for each program:
 *     program_number(16)
 *     reserved(3) | program_map_PID(13)
 *   CRC_32(32)
 *
 * For our case (one program, points to PMT_PID):
 *   section_length covers the bytes after the section_length field
 *   itself, including CRC = 5 (mid-header) + 4 (program loop) + 4 (CRC)
 *   = 13.
 */
TSWriter.prototype._buildPATPacket = function () {
  var pkt = new Uint8Array(PACKET_SIZE);
  this._writePATPacketInto(pkt, 0);
  return pkt;
};

/**
 * Same as _buildPATPacket but writes directly into a provided buffer
 * at a given offset. Returns the new offset (base + 188).
 *
 * Used by writeSegment to avoid allocating a separate Uint8Array per
 * packet — every byte goes straight into the segment's output buffer.
 *
 * Fast path: if a template was pre-built in the constructor, copy it
 * and patch only the CC byte. Otherwise (constructor-path call when
 * the template doesn't exist yet) build from scratch.
 */
TSWriter.prototype._writePATPacketInto = function (buf, base) {
  if (this._patTemplate) {
    buf.set(this._patTemplate, base);
    // Patch byte 3: keep AFC=01 (high nibble 0x10), update CC (low nibble).
    buf[base + 3] = 0x10 | (this._cc[PID_PAT] & 0x0F);
    this._cc[PID_PAT] = (this._cc[PID_PAT] + 1) & 0x0F;
    return base + PACKET_SIZE;
  }

  // Pre-fill the packet region with stuffing — bytes after the CRC
  // are unused and get the conventional 0xFF pad.
  for (var i = base; i < base + PACKET_SIZE; i++) buf[i] = 0xFF;

  // TS header: PUSI=1, AFC=01 (payload only, no AF for PSI), CC.
  buf[base + 0] = SYNC_BYTE;
  buf[base + 1] = 0x40;                                // PUSI=1, PID high = 0
  buf[base + 2] = 0x00;                                // PID low = 0
  buf[base + 3] = 0x10 | (this._cc[PID_PAT] & 0x0F);   // AFC=01, CC
  this._cc[PID_PAT] = (this._cc[PID_PAT] + 1) & 0x0F;

  buf[base + 4] = 0x00;  // pointer_field — section starts immediately

  var off = base + 5;  // section_start
  buf[off++] = 0x00;            // table_id = PAT
  buf[off++] = 0xB0;            // ssi=1, '0'=0, reserved=11, length-hi=0
  buf[off++] = 0x0D;            // section_length = 13
  buf[off++] = 0x00;
  buf[off++] = 0x01;            // transport_stream_id = 1
  buf[off++] = 0xC1;            // reserved=11, version=0, current=1
  buf[off++] = 0x00;            // section_number
  buf[off++] = 0x00;            // last_section_number
  buf[off++] = 0x00;
  buf[off++] = 0x01;            // program_number = 1
  buf[off++] = 0xE0 | ((PID_PMT >> 8) & 0x1F);  // reserved=111, PMT_PID hi
  buf[off++] = PID_PMT & 0xFF;                  // PMT_PID lo

  var crc = _crc32mpeg2(buf, base + 5, off);
  writeU32BE(buf, off, crc);

  return base + PACKET_SIZE;
};

/**
 * Build a single TS packet carrying a PMT (Program Map Table).
 *
 * PMT body layout (ISO 13818-1 §2.4.4.8):
 *   table_id(8)                              = 0x02
 *   section_syntax_indicator(1) | '0'(1) | reserved(2) | section_length(12)
 *   program_number(16)
 *   reserved(2) | version_number(5) | current_next_indicator(1)
 *   section_number(8) | last_section_number(8)
 *   reserved(3) | PCR_PID(13)
 *   reserved(4) | program_info_length(12)
 *   [program_info]                           — we omit (length 0)
 *   for each elementary stream:
 *     stream_type(8)
 *     reserved(3) | elementary_PID(13)
 *     reserved(4) | ES_info_length(12)
 *     [ES_info]                              — we omit (length 0)
 *   CRC_32(32)
 *
 * section_length = 9 (mid-header) + 5 * stream_count + 4 (CRC).
 */
TSWriter.prototype._buildPMTPacket = function () {
  var pkt = new Uint8Array(PACKET_SIZE);
  this._writePMTPacketInto(pkt, 0);
  return pkt;
};

/**
 * Same as _buildPMTPacket but writes directly into a provided buffer
 * at a given offset. Returns the new offset (base + 188).
 *
 * Fast path: copies the pre-built template and patches the CC nibble.
 * See _writePATPacketInto for the rationale.
 */
TSWriter.prototype._writePMTPacketInto = function (buf, base) {
  if (this._pmtTemplate) {
    buf.set(this._pmtTemplate, base);
    buf[base + 3] = 0x10 | (this._cc[PID_PMT] & 0x0F);
    this._cc[PID_PMT] = (this._cc[PID_PMT] + 1) & 0x0F;
    return base + PACKET_SIZE;
  }

  // Stream count and section_length depend on whether metadata is
  // enabled. Each regular stream contributes 5 bytes; the metadata
  // stream contributes 5 + 6 = 11 bytes (the extra 6 are the
  // registration_descriptor declaring "ID3 ").
  var streamCount = (this._video ? 1 : 0) + (this._audio ? 1 : 0);
  var streamBytes = 5 * streamCount;
  if (this._metadataEnabled) {
    streamBytes += 5 + 6;  // metadata stream entry + registration_descriptor
  }
  var sectionLength = 9 + streamBytes + 4;

  for (var i = base; i < base + PACKET_SIZE; i++) buf[i] = 0xFF;

  buf[base + 0] = SYNC_BYTE;
  buf[base + 1] = 0x40 | ((PID_PMT >> 8) & 0x1F);
  buf[base + 2] = PID_PMT & 0xFF;
  buf[base + 3] = 0x10 | (this._cc[PID_PMT] & 0x0F);
  this._cc[PID_PMT] = (this._cc[PID_PMT] + 1) & 0x0F;

  buf[base + 4] = 0x00;  // pointer_field

  var off = base + 5;
  buf[off++] = 0x02;            // table_id = PMT
  buf[off++] = 0xB0 | ((sectionLength >> 8) & 0x0F);
  buf[off++] = sectionLength & 0xFF;
  buf[off++] = 0x00;
  buf[off++] = 0x01;            // program_number = 1
  buf[off++] = 0xC1;            // reserved=11, version=0, current=1
  buf[off++] = 0x00;
  buf[off++] = 0x00;
  buf[off++] = 0xE0 | ((this._pcrPid >> 8) & 0x1F);
  buf[off++] = this._pcrPid & 0xFF;
  buf[off++] = 0xF0;            // reserved=1111, program_info_length-hi=0
  buf[off++] = 0x00;            // program_info_length-lo = 0

  if (this._video) {
    var streamType = (this._video.codec === 'h265') ? STREAM_TYPE_H265 : STREAM_TYPE_H264;
    buf[off++] = streamType;
    buf[off++] = 0xE0 | ((PID_VIDEO >> 8) & 0x1F);
    buf[off++] = PID_VIDEO & 0xFF;
    buf[off++] = 0xF0;          // ES_info_length = 0
    buf[off++] = 0x00;
  }
  if (this._audio) {
    buf[off++] = STREAM_TYPE_AAC;
    buf[off++] = 0xE0 | ((PID_AUDIO >> 8) & 0x1F);
    buf[off++] = PID_AUDIO & 0xFF;
    buf[off++] = 0xF0;
    buf[off++] = 0x00;
  }
  if (this._metadataEnabled) {
    // Metadata stream entry. ES_info_length = 6 (the registration_
    // descriptor below). The descriptor identifies the metadata
    // format as "ID3 " — Apple's "Adopting HLS" guide and FFmpeg's
    // mpegts muxer agree on this convention. Without the descriptor,
    // generic players will see stream_type=0x15 but won't know it's
    // ID3 specifically.
    buf[off++] = STREAM_TYPE_METADATA;
    buf[off++] = 0xE0 | ((PID_METADATA >> 8) & 0x1F);
    buf[off++] = PID_METADATA & 0xFF;
    buf[off++] = 0xF0;          // ES_info_length-hi (reserved=1111 + 4 high bits)
    buf[off++] = 0x06;          // ES_info_length-lo = 6
    // registration_descriptor (descriptor_tag=0x05, length=4, "ID3 ")
    buf[off++] = 0x05;          // descriptor_tag = registration_descriptor
    buf[off++] = 0x04;          // descriptor_length = 4
    buf[off++] = 0x49;          // 'I'
    buf[off++] = 0x44;          // 'D'
    buf[off++] = 0x33;          // '3'
    buf[off++] = 0x20;          // ' '
  }

  var crc = _crc32mpeg2(buf, base + 5, off);
  writeU32BE(buf, off, crc);

  return base + PACKET_SIZE;
};


// ── PES builder ───────────────────────────────────────────

/**
 * Build a complete PES packet (header + payload) ready to be split
 * across TS packets.
 *
 * PES header layout (ISO 13818-1 §2.4.3.6):
 *   packet_start_code_prefix(24)             = 0x000001
 *   stream_id(8)
 *   PES_packet_length(16)                    — 0 means "unbounded"
 *                                              (only legal for video)
 *   '10'(2) | scrambling(2) | priority(1) | data_align(1) |
 *     copyright(1) | original(1)             — first flags byte (=0x80)
 *   PTS_DTS_flags(2) | ESCR_flag(1) | ES_rate_flag(1) | trick(1) |
 *     additional_copy(1) | CRC_flag(1) | extension(1)
 *                                            — 0x80 (PTS only) or 0xC0 (PTS+DTS)
 *   PES_header_data_length(8)
 *   [optional fields, here only PTS / DTS]
 *
 * For us the PES header is either 14 bytes (PTS only, audio) or
 * 19 bytes (PTS + DTS, video).
 */
TSWriter.prototype._buildPES = function (streamId, payload, ptsUs, dtsUs, useLength) {
  // Convert µs to 90 kHz ticks. PTS/DTS are 33-bit fields — at 90 kHz
  // they wrap at 26.5 hours, well beyond any HLS segment use case.
  var pts = Math.floor(ptsUs * 90 / 1000);
  var dts = (dtsUs !== null && dtsUs !== undefined) ? Math.floor(dtsUs * 90 / 1000) : null;

  // Only emit a separate DTS field when DTS actually differs from PTS.
  // Saves 5 bytes per video frame in the no-B-frames case.
  var hasDts = dts !== null && dts !== pts;
  var headerDataLen = hasDts ? 10 : 5;
  var pesHeaderTotal = 9 + headerDataLen;

  // PES_packet_length field. Video sets 0 ("unbounded") because keyframe
  // AUs commonly exceed the 16-bit field max (65535). Audio frames are
  // always small, so we write the actual length there — strictly more
  // correct, and some demuxers prefer it.
  var pesPacketLength = 0;
  if (useLength) {
    var totalPES = pesHeaderTotal + payload.length;
    pesPacketLength = totalPES - 6;
    if (pesPacketLength > 0xFFFF) pesPacketLength = 0;
  }

  var pes = new Uint8Array(pesHeaderTotal + payload.length);

  pes[0] = 0x00;
  pes[1] = 0x00;
  pes[2] = 0x01;
  pes[3] = streamId;
  pes[4] = (pesPacketLength >> 8) & 0xFF;
  pes[5] = pesPacketLength & 0xFF;
  pes[6] = 0x80;                          // marker bits + flags1
  pes[7] = hasDts ? 0xC0 : 0x80;          // PTS_DTS_flags
  pes[8] = headerDataLen;

  // PTS prefix: 0010 if PTS only, 0011 if both PTS+DTS present.
  // DTS prefix when present: 0001.
  _encodeTimestamp(pes, 9, hasDts ? 0x3 : 0x2, pts);
  if (hasDts) _encodeTimestamp(pes, 14, 0x1, dts);

  pes.set(payload, pesHeaderTotal);
  return pes;
};

/**
 * Encode a 33-bit timestamp into 5 bytes per the PES timestamp format.
 *
 * Layout (40 bits total, big-endian):
 *   prefix(4) | ts[32..30](3) | marker(1=1)
 *             | ts[29..15](15) | marker(1=1)
 *             | ts[14..0](15)  | marker(1=1)
 *
 * Math.floor for the high portion because JS bitwise operators truncate
 * to 32-bit signed, which wraps for ts > 2^31.
 */
function _encodeTimestamp(buf, off, prefix4, ts) {
  var top = Math.floor(ts / 0x40000000) & 0x07;   // bits 32..30
  var mid = Math.floor(ts / 0x8000) & 0x7FFF;     // bits 29..15
  var lo  = ts & 0x7FFF;                          // bits 14..0

  buf[off]     = (prefix4 << 4) | (top << 1) | 0x01;
  buf[off + 1] = (mid >>> 7) & 0xFF;
  buf[off + 2] = ((mid << 1) & 0xFE) | 0x01;
  buf[off + 3] = (lo >>> 7) & 0xFF;
  buf[off + 4] = ((lo << 1) & 0xFE) | 0x01;
}


// ── Packetization ─────────────────────────────────────────

/**
 * Split a PES packet into 188-byte TS packets on the given PID.
 *
 * Per-packet layout decisions:
 *
 *   First packet (PUSI=1):
 *     - Always carries the PES header at start of payload.
 *     - If this PID is the PCR PID, includes an adaptation field
 *       with PCR (8 bytes total: length + flags + 6-byte PCR).
 *
 *   Middle packets (PUSI=0):
 *     - No adaptation field, full 184-byte payload.
 *
 *   Final packet:
 *     - If remaining payload < 184 bytes, an adaptation field with
 *       stuffing is added so the packet is exactly 188 bytes (TS
 *       packets must be a fixed 188 — the demuxer locks onto sync
 *       bytes at fixed intervals).
 *
 * @param {number} pid
 * @param {Uint8Array} payload     full PES bytes
 * @param {number|null} pcrUs      if non-null AND pid === pcrPid,
 *                                 PCR is written on the first packet
 */
TSWriter.prototype._packetize = function (pid, payload, pcrUs) {
  var includePCR = (pid === this._pcrPid) && (pcrUs !== null && pcrUs !== undefined);
  var packetCount = this._packetCountFor(payload.length, includePCR);
  var buf = new Uint8Array(packetCount * PACKET_SIZE);
  this._packetizeInto(pid, payload, pcrUs, buf, 0);
  return buf;
};

/**
 * Compute how many 188-byte TS packets a PES of `pesLen` bytes will
 * occupy. Used by writeSegment to pre-size the segment buffer so
 * that all packets can be written into a single allocation rather
 * than building per-packet Uint8Arrays and concatenating.
 *
 * Layout matches _packetizeInto:
 *   First packet has 184 bytes of payload (or 176 if it carries a
 *   PCR adaptation field, which only happens on the PCR PID's first
 *   packet). Every subsequent packet carries 184 bytes; the last
 *   may carry less and stuff the rest with an AF, but it's still
 *   one packet.
 */
TSWriter.prototype._packetCountFor = function (pesLen, withPCR) {
  var firstCap = withPCR ? 176 : 184;
  if (pesLen <= firstCap) return 1;
  return 1 + Math.ceil((pesLen - firstCap) / 184);
};

/**
 * Same as _packetize but writes packets directly into `buf` starting
 * at `off`. Returns the new offset after the last packet (i.e.
 * off + packetCount * 188).
 *
 * Caller must ensure `buf` has room for at least
 *   _packetCountFor(payload.length, withPCR) * 188
 * bytes available at `off`. _packetizeInto does not bounds-check; an
 * undersized buffer corrupts surrounding data.
 */
TSWriter.prototype._packetizeInto = function (pid, payload, pcrUs, buf, off) {
  var pos = 0;
  var first = true;
  var includePCR = (pid === this._pcrPid) && (pcrUs !== null && pcrUs !== undefined);

  while (pos < payload.length) {
    var pktBase = off;
    var remaining = payload.length - pos;
    var afSize = 0;
    var payloadSize;

    var pcrThisPacket = first && includePCR;

    if (pcrThisPacket) {
      // AF with PCR: 1 length byte + 1 flags byte + 6 PCR bytes = 8.
      var maxPayload = PACKET_SIZE - 4 - 8;  // 176
      if (remaining >= maxPayload) {
        afSize = 8;
        payloadSize = maxPayload;
      } else {
        // Smaller than max → pad the AF with stuffing after PCR.
        payloadSize = remaining;
        afSize = PACKET_SIZE - 4 - payloadSize;
      }
    } else if (remaining < PACKET_SIZE - 4) {
      // No PCR but need stuffing to reach 188.
      payloadSize = remaining;
      afSize = PACKET_SIZE - 4 - payloadSize;
    } else {
      // Full payload, no AF.
      afSize = 0;
      payloadSize = PACKET_SIZE - 4;
    }

    // TS header
    var afc = afSize > 0 ? 0x3 : 0x1;
    var pusi = first ? 0x40 : 0x00;
    // Cache the continuity-counter value once instead of dereferencing
    // this._cc[pid] twice (read for the header byte + read+write for
    // the increment). For ~3000 packets/segment this saves ~3000
    // property lookups vs. doing it inline twice.
    var cc = this._cc[pid];
    buf[pktBase + 0] = SYNC_BYTE;
    buf[pktBase + 1] = pusi | ((pid >> 8) & 0x1F);
    buf[pktBase + 2] = pid & 0xFF;
    buf[pktBase + 3] = (afc << 4) | (cc & 0x0F);
    this._cc[pid] = (cc + 1) & 0x0F;

    var p = pktBase + 4;

    if (afSize > 0) {
      buf[p++] = afSize - 1;  // af_length = bytes after the length byte

      if (afSize > 1) {
        // Flags byte. PCR_flag (0x10) if writing PCR; everything else 0.
        buf[p++] = pcrThisPacket ? 0x10 : 0x00;

        if (pcrThisPacket) {
          _encodePCR(buf, p, pcrUs);
          p += 6;
        }

        // Stuffing — fill remaining AF bytes with 0xFF until we reach
        // the start of the payload region.
        var stuffEnd = pktBase + 4 + afSize;
        while (p < stuffEnd) buf[p++] = 0xFF;
      }
    }

    buf.set(payload.subarray(pos, pos + payloadSize), p);
    pos += payloadSize;

    off = pktBase + PACKET_SIZE;
    first = false;
  }

  return off;
};

/**
 * Encode a PCR (Program Clock Reference) into 6 bytes.
 *
 * Format (48 bits, big-endian):
 *   base[32..25](8) | base[24..17](8) | base[16..9](8) | base[8..1](8)
 *     | base[0](1) | reserved(6=111111) | ext[8](1) | ext[7..0](8)
 *
 * base is 33 bits at 90 kHz, ext is 9 bits at 27 MHz mod 300, and the
 * effective 27 MHz time is base*300 + ext. With µs input we get
 * enough precision to populate both — base from the integer 90 kHz
 * portion, ext from the sub-tick remainder.
 */
function _encodePCR(buf, off, pcrUs) {
  var pcr27 = pcrUs * 27;
  var base = Math.floor(pcr27 / 300);
  var ext  = pcr27 - base * 300;

  // base is up to 33 bits — split for shifting since JS bitwise ops
  // are 32-bit signed.
  var hi = Math.floor(base / 0x100000000);  // top 1 bit of base
  var lo = base >>> 0;                      // low 32 bits

  buf[off]     = (((hi & 1) << 7) | ((lo >>> 25) & 0x7F)) & 0xFF;
  buf[off + 1] = (lo >>> 17) & 0xFF;
  buf[off + 2] = (lo >>> 9) & 0xFF;
  buf[off + 3] = (lo >>> 1) & 0xFF;
  buf[off + 4] = ((lo & 1) << 7) | 0x7E | ((ext >> 8) & 0x01);
  buf[off + 5] = ext & 0xFF;
}


export default TSWriter;
