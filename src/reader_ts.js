/**
 * reader_ts — MPEG-TS reader.
 *
 * Improvements:
 *  - Proper PAT/PMT parsing with pointer_field
 *  - Flat buffer for video AU accumulation
 *  - Imports NAL helpers from reader_annexb (no duplication)
 */

import EventEmitter from './core/events.js';
import ByteQueue from './core/byte_queue.js';
import { hasIDR_H264 } from './utils/nalu_utils.js';
import { parseAdtsHeader } from './utils/aac_utils.js';
import { concat } from './core/bytes.js';
import { PACKET_SIZE, SYNC_BYTE, STREAM_TYPE_H265 } from './utils/ts_constants.js';

var PTS_WRAP = 8589934592;   // 2^33: the PES PTS field's range (90 kHz ticks)

function TSReader(opts) {
  if (!opts) opts = {};
  this._ee = new EventEmitter();
  this._q = new ByteQueue();

  this._patParsed = false;
  this._pmtPid = null;
  this._videoPid = null;
  this._videoType = 0;     // the PMT stream_type of _videoPid (0x1B H.264, 0x24 H.265)
  this._audioPid = null;

  this._pesBuf = {};
  this._psi = {};          // PAT / PMT section being assembled: { pat: Uint8Array|null, pmt: … }
  this._lastCC = {};       // pid → [continuity_counter, the packet] (duplicate detection)
  this._lastPts = null;    // the last PTS seen (unwrapped), for the 33-bit wrap

  this._fps = opts.fps || 30;
  this._index = 0;
  this._groupId = 0;
  this._sampleRate = opts.sampleRate || 48000;
  this._nextAudioPtsUs = 0;
  // Audio timeline: the last PES PTS (µs) and the samples since it. A
  // frame's time is base + samples / rate, so a PES of several ADTS
  // frames gives each its own time (see _processAudioES).
  this._aBaseUs = 0;
  this._aSamples = 0;
  this._aRate = 0;
  this._aCarry = null;     // an ADTS frame cut off by the end of the last PES
}

TSReader.prototype.on = function (ev, fn) { this._ee.on(ev, fn); };
TSReader.prototype.off = function (ev, fn) { this._ee.off(ev, fn); };

TSReader.prototype.feed = function (chunk) {
  this._q.push(chunk);
  while (this._q.length >= PACKET_SIZE) {
    // Resync must advance by ONE byte, not by a whole packet.
    //
    // The previous loop read 188 bytes, and on a sync-byte mismatch
    // simply read the next 188. If the stream ever became misaligned
    // by k bytes — a truncated write, a dropped chunk, joining a live
    // stream mid-packet — every subsequent read stayed misaligned by
    // the same k. Alignment could never be recovered and the reader
    // silently emitted nothing for the rest of the session.
    //
    // Discarding a single byte lets the scan walk back onto the packet
    // grid within at most 188 bytes.
    if (this._q.byteAt(0) !== SYNC_BYTE) {
      this._q.discard(1);
      continue;
    }
    var pkt = this._q.read(PACKET_SIZE);
    this._handlePacket(pkt);
  }
};

/**
 * Emit any PES still accumulating, then reset.
 *
 * _accumPES only flushes a PES when the NEXT one starts (PUSI). At
 * end-of-stream there is no next PUSI, so the final access unit sat in
 * _pesBuf and was discarded — the same trailing-frame loss that
 * reader_annexb.flush() already exists to prevent, and for the same
 * reason.
 */
TSReader.prototype.flush = function () {
  if (this._videoPid !== null) this._flushPES(this._videoPid, 'video');
  if (this._audioPid !== null) this._flushPES(this._audioPid, 'audio');
  this._q.reset();
  this._pesBuf = {};
  this._psi = {};
  this._lastCC = {};
  this._aCarry = null;
  this._ee.emit('flushed');
};

TSReader.prototype._handlePacket = function (pkt) {
  var pid = ((pkt[1] & 0x1F) << 8) | pkt[2];
  var pusi = !!(pkt[1] & 0x40);
  var afl = (pkt[3] >> 4) & 0x03;
  // adaptation_field_control 00 is reserved — "decoders shall discard"
  // such packets (§2.4.3.3) — and 10 is an adaptation field with no
  // payload. Both used to go on as payload: a reserved packet's 184
  // bytes were appended to the PES in progress.
  if (!(afl & 1)) return;
  var off = 4;
  if (afl === 2 || afl === 3) {
    off += 1 + pkt[off];
  }
  if (off >= PACKET_SIZE) return;
  var payload = pkt.subarray(off);

  // ISO/IEC 13818-1 §2.4.3.3: a packet may be sent twice in a row (same
  // continuity_counter, same bytes) and the copy must be dropped. It was
  // appended to the PES instead — a 184-byte duplicate inside the first
  // access unit of the probe stream (3531 → 3715 bytes, a corrupt frame).
  // Only an identical repeat counts: a muxer that gets the counter wrong
  // (all zeros) must not lose real packets.
  var cc = pkt[3] & 0x0F, prev = this._lastCC[pid];
  if (prev && prev[0] === cc && _same(prev[1], pkt)) return;
  this._lastCC[pid] = [cc, pkt];

  if (pid === 0x0000) { this._parsePSI(payload, pusi, 'pat'); return; }
  if (this._pmtPid !== null && pid === this._pmtPid) { this._parsePSI(payload, pusi, 'pmt'); return; }
  if (this._videoPid !== null && pid === this._videoPid) { this._accumPES(pid, payload, pusi, 'video'); return; }
  if (this._audioPid !== null && pid === this._audioPid) { this._accumPES(pid, payload, pusi, 'audio'); return; }
};

/**
 * Parse PSI table (PAT or PMT) with proper pointer_field handling.
 */
TSReader.prototype._parsePSI = function (pl, pusi, type) {
  // A section may continue in the next packets of the PID (§2.4.4: up to
  // 1021 bytes for a PAT/PMT; a PMT with many streams or long descriptors
  // does not fit in one packet). Each packet used to be parsed on its own,
  // so such a PMT was cut at 183 bytes and the streams listed after the
  // cut were never found. The section is collected until section_length
  // says it is complete.
  var cur = this._psi[type] || null;
  if (pusi) {
    // pointer_field: the bytes before it end the section in progress.
    var pointer = pl[0];
    if (cur && pointer > 0) {
      this._psi[type] = concat([cur, pl.subarray(1, 1 + pointer)]);
      this._sectionReady(type);
    }
    if (1 + pointer >= pl.length) { this._psi[type] = null; return; }
    this._psi[type] = pl.slice(1 + pointer);
  } else {
    if (!cur) return;                       // joined mid-section: wait for the next start
    this._psi[type] = concat([cur, pl]);
  }
  this._sectionReady(type);
};

// Parse the section collected for `type` once all of it is here.
TSReader.prototype._sectionReady = function (type) {
  var sec = this._psi[type];
  if (!sec || sec.length < 3) return;
  if (sec[0] === 0xFF) { this._psi[type] = null; return; }   // stuffing: no section
  var total = 3 + (((sec[1] & 0x0F) << 8) | sec[2]);
  if (sec.length < total) return;
  this._psi[type] = null;
  // current_next_indicator 0: a table sent ahead, "not yet applicable"
  // (§2.4.4.5) — it was applied at once, PIDs and all.
  if (total < 6 || !(sec[5] & 0x01)) return;
  if (type === 'pat') this._parsePATSection(sec.subarray(0, total));
  else this._parsePMTSection(sec.subarray(0, total));
};

TSReader.prototype._parsePATSection = function (sec) {
  // table_id(8) + flags(16) with section_length(12) + transport_stream_id(16)
  // + version/cni(8) + section_number(8) + last_section_number(8) = 8 bytes header
  if (sec.length < 12) return;
  var tableId = sec[0];
  if (tableId !== 0x00) return;  // PAT table_id = 0
  var secLen = ((sec[1] & 0x0F) << 8) | sec[2];
  // Programs start at byte 8, each is 4 bytes: program_number(16) + reserved(3) + PID(13)
  var i = 8;
  var endPos = Math.min(3 + secLen - 4, sec.length);  // -4 for CRC32
  while (i + 4 <= endPos) {
    var progNum = (sec[i] << 8) | sec[i + 1];
    var progPid = ((sec[i + 2] & 0x1F) << 8) | sec[i + 3];
    if (progNum !== 0) {  // 0 = NIT, skip
      this._pmtPid = progPid;
      this._patParsed = true;
      break;  // Take first program
    }
    i += 4;
  }
};

TSReader.prototype._parsePMTSection = function (sec) {
  if (sec.length < 16) return;
  var tableId = sec[0];
  if (tableId !== 0x02) return;  // PMT table_id = 2
  var secLen = ((sec[1] & 0x0F) << 8) | sec[2];
  var progInfoLen = ((sec[10] & 0x0F) << 8) | sec[11];
  var i = 12 + progInfoLen;
  var endPos = Math.min(3 + secLen - 4, sec.length);
  while (i + 5 <= endPos) {
    var streamType = sec[i];
    var elemPid = ((sec[i + 1] & 0x1F) << 8) | sec[i + 2];
    var esInfoLen = ((sec[i + 3] & 0x0F) << 8) | sec[i + 4];
    // Video: H.264=0x1B, H.265=0x24
    if ((streamType === 0x1B || streamType === 0x24) && this._videoPid === null) { this._videoPid = elemPid; this._videoType = streamType; }
    // Audio: AAC in ADTS (0x0F). 0x11 is AAC in LATM/LOAS, which this
    // reader cannot parse (no ADTS sync word): it used to be taken as the
    // audio PID too, so its stream gave no frames and an ADTS track listed
    // after it was never read.
    if (streamType === 0x0F && this._audioPid === null) this._audioPid = elemPid;
    i += 5 + esInfoLen;
  }
};

TSReader.prototype._accumPES = function (pid, payload, pusi, kind) {
  if (!this._pesBuf[pid]) this._pesBuf[pid] = [];
  if (pusi) this._flushPES(pid, kind);
  this._pesBuf[pid].push(payload);
};

TSReader.prototype._flushPES = function (pid, kind) {
  var chunks = this._pesBuf[pid];
  if (!chunks || !chunks.length) return;

  // Fast path: single chunk, no concat needed
  var pes;
  if (chunks.length === 1) {
    pes = chunks[0];
  } else {
    // Calculate total size first, then copy
    var total = 0;
    for (var c = 0; c < chunks.length; c++) total += chunks[c].length;
    pes = new Uint8Array(total);
    var off = 0;
    for (var c2 = 0; c2 < chunks.length; c2++) {
      pes.set(chunks[c2], off);
      off += chunks[c2].length;
    }
  }
  this._pesBuf[pid] = [];

  if (pes.length < 9) return;
  if (!(pes[0] === 0x00 && pes[1] === 0x00 && pes[2] === 0x01)) return;

  var flags = pes[7];
  var headerDataLen = pes[8];
  var pts = null;

  if (pes.length < 9 + headerDataLen) return;
  if ((flags & 0x80) === 0x80 && headerDataLen >= 5) {
    // PES PTS is 33 bits (ISO/IEC 13818-1 §2.4.3.7). JavaScript's
    // bitwise operators are 32-bit and SIGNED, so the textbook shift
    // form silently breaks:
    //
    //   ((pes[9] & 0x0E) << 29)  — the top field is 0..14; 8 << 29 is
    //   2^32, which truncates to 0, and any result above 2^31 comes
    //   back negative through the `|` chain.
    //
    // Measured against synthetic PES headers: correct up to 6.63 hours
    // of 90 kHz PTS, NEGATIVE beyond it, and wrapped to small wrong
    // values past 13.26 hours. MPEG-TS PTS also commonly starts at a
    // large arbitrary value rather than zero, so a stream can land in
    // the broken range within seconds of starting.
    //
    // Multiplication keeps the value in Number's 53-bit safe integer
    // range, which covers the full 33-bit field with room to spare.
    var ptsHi  = (pes[9] & 0x0E) >> 1;              // PTS[32:30]
    var ptsMid = ((pes[10] & 0xFF) << 7) | ((pes[11] & 0xFE) >> 1);   // PTS[29:15]
    var ptsLo  = ((pes[12] & 0xFF) << 7) | ((pes[13] & 0xFE) >> 1);   // PTS[14:0]
    pts = (ptsHi * 1073741824) + (ptsMid * 32768) + ptsLo;
    pts = this._unwrap(pts);
  }

  var payloadStart = 9 + headerDataLen;
  if (payloadStart > pes.length) return;
  var es = pes.subarray(payloadStart);

  if (kind === 'video') this._processVideoES(es, pts);
  else if (kind === 'audio') this._processAudioES(es, pts);
};

/**
 * The 33-bit PTS wraps to 0 every 26.5 hours (2^33 / 90 kHz), and a
 * stream may start anywhere in that range — one started 10 minutes
 * before the wrap goes back to 0 ten minutes in. The raw value went out
 * as is, so timestamps jumped back by 26.5 h. Each PTS is taken as the
 * value nearest the previous one (video and audio share the clock).
 */
TSReader.prototype._unwrap = function (pts) {
  if (this._lastPts !== null) {
    pts += Math.round((this._lastPts - pts) / PTS_WRAP) * PTS_WRAP;
  }
  this._lastPts = pts;
  return pts;
};

TSReader.prototype._processVideoES = function (es, pts) {
  // AU splitting strategy: PES boundary = AU boundary.
  //
  // Background: in MPEG-TS, the demux layer (PSI + PES accumulation
  // via PUSI) already gives us complete PES packets one at a time.
  // For elementary video streams encoded by a single encoder, the
  // overwhelmingly common case is 1 PES = 1 AU (per ISO/IEC 13818-1
  // Annex 2.4.4.10). So when _accumPES flushes a PES via PUSI, the
  // resulting `es` payload IS one AU.
  //
  // The previous implementation tried to find access-unit boundaries
  // by searching for AUD NAL units (type 9, byte 0x09) in a flat
  // accumulator buffer. That strategy works ONLY for encoders that
  // emit AUDs:
  //   - libx264:        emits AUDs because codecs.js sets aud=1
  //   - h264_nvenc:     OMITS AUDs by default
  //   - h264_qsv:       OMITS AUDs
  //   - h264_vaapi:     OMITS AUDs
  //   - h264_amf:       OMITS AUDs
  //   - h264_videotoolbox: OMITS AUDs
  // For any non-libx264 encoder, the previous code accumulated forever
  // and never emitted a frame. (MP-21.)
  //
  // PES-boundary splitting works for all encoders: PUSI is a TS
  // packet header bit, set by the muxer, independent of encoder.
  //
  // Edge case (rare): some muxers pack multiple AUs into one PES.
  // For now we treat the whole PES as one AU; if we ever encounter
  // such streams we can add a secondary AUD-based split as a
  // refinement. Empirically WebRTC-style streams are 1:1.
  // A PES with no payload is no access unit (it went out as a 0-byte frame).
  if (!es.length) return;
  var au = es.slice();
  // The PMT's stream_type says which codec this is. Every PES used to go
  // through the H.264 IDR test, which reads an H.265 NAL header wrong
  // (type is bits 1..6 of the first byte, not the low 5), so no H.265
  // frame was ever a keyframe: 0 of 3 on the probe stream.
  var isKey = this._videoType === STREAM_TYPE_H265 ? _hasIrapH265(au) : hasIDR_H264(au);
  if (isKey) this._groupId++;
  // Nearest µs, not floor: 132000 ticks (1.4666…7 s) came out as 1466666.
  var ptsUs = pts !== null
    ? Math.round(pts * (1000000 / 90000))
    : Math.floor(this._index * 1000000 / this._fps);

  this._ee.emit('video', {
    payload: au,
    isKeyframe: isKey,
    ptsUs: ptsUs,
    index: this._index++,
    groupId: this._groupId,
  });
};

TSReader.prototype._processAudioES = function (es, pts) {
  // An ADTS frame may straddle two PES packets: ISO/IEC 13818-1 lets a
  // PES end anywhere, its PTS being that of the first access unit that
  // STARTS in it (§2.4.3.7). The tail of such a frame used to be thrown
  // away at the end of the PES (`break`) and the next PES scanned from its
  // own first byte, so the frame was lost: 86 of 131 frames came out of a
  // stream cut every 600 bytes (FFmpeg: 131). The cut-off bytes now wait
  // for the next PES.
  var carryLen = 0;
  if (this._aCarry) {
    carryLen = this._aCarry.length;
    es = concat([this._aCarry, es]);
    this._aCarry = null;
  }
  var ptsUsed = pts === null;
  var pos = 0;
  while (pos + 7 <= es.length) {
    if (es[pos] !== 0xFF || (es[pos + 1] & 0xF0) !== 0xF0) { pos++; continue; }

    // Parse the ADTS header for this frame. parseAdtsHeader does the
    // same validation we used to do inline (sync, protection_absent,
    // frame_length) and additionally exposes the sample rate and
    // channel config. Using the header-reported sample rate fixes
    // PTS drift when the stream rate differs from this._sampleRate
    // (e.g. caller passed 48000 but stream is 44100) — see MP-32.
    var info = parseAdtsHeader(es.subarray(pos, pos + 9));
    // frame_length counts the header (7 bytes, 9 with a CRC): one shorter
    // is no frame (ISO/IEC 14496-3 §1.A.2.2.1). It was taken as one — a
    // 3-byte 'frame' — and the scan went on inside the header.
    if (!info || info.frameLength < (info.protectionAbsent ? 7 : 9)) { pos++; continue; }
    if (pos + info.frameLength > es.length) break;

    var frame = es.slice(pos, pos + info.frameLength);
    var sampleRate = info.sampleRate || this._sampleRate;

    // The PES PTS is the time of the first frame that starts in this PES
    // (not one carried over from the last). The frames after it follow
    // by their sample counts. Every frame of a PES used to get the PES
    // PTS itself — FFmpeg packs several AAC frames per PES, so on the
    // probe stream frames 1..7 all came out at 1445333 µs (FFmpeg:
    // 1466667, 1488000, …).
    if (!ptsUsed && pos >= carryLen) {
      ptsUsed = true;
      this._aBaseUs = pts * (1000000 / 90000);
      this._aSamples = 0;
      this._aRate = sampleRate;
    } else if (this._aRate !== sampleRate) {
      // no PTS yet, or the rate changed: restart the count from here
      this._aBaseUs = this._nextAudioPtsUs;
      this._aSamples = 0;
      this._aRate = sampleRate;
    }
    pos += info.frameLength;

    var ptsUsA = Math.round(this._aBaseUs + this._aSamples * 1000000 / sampleRate);
    this._aSamples += info.samplesPerFrame;
    var endUs = Math.round(this._aBaseUs + this._aSamples * 1000000 / sampleRate);
    this._nextAudioPtsUs = endUs;
    this._ee.emit('audio', {
      payload: frame,
      ptsUs: ptsUsA,
      durationUs: endUs - ptsUsA,
      sampleRate: sampleRate,
      channels: info.channels,
      profile: info.profile,
    });
  }
  // What's left (at most a frame's worth: frame_length is 13 bits) waits
  // for the next PES.
  if (pos < es.length && es.length - pos < 8192) this._aCarry = es.slice(pos);
};

// Is this packet the same bytes as the last one of its PID?
function _same(a, b) {
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return a.length === b.length;
}

/**
 * Does an Annex-B H.265 access unit hold an IRAP picture (nal_unit_type
 * 16..21: BLA_W_LP, BLA_W_RADL, BLA_N_LP, IDR_W_RADL, IDR_N_LP, CRA)?
 * A decoder can start at any of them — what FFmpeg's hevc parser flags
 * as a keyframe. An IDR-only test misses the CRA that open-GOP encoders
 * (x265 by default) put at every GOP start.
 */
function _hasIrapH265(au) {
  var i = 0, len = au.length;
  while (i + 3 < len) {
    if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1) {
      var t = (au[i + 3] >> 1) & 0x3F;
      if (t >= 16 && t <= 21) return true;
      i += 3;
      continue;
    }
    i++;
  }
  return false;
}

export default TSReader;
