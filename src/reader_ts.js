/**
 * reader_ts — MPEG-TS reader.
 *
 * Improvements:
 *  - Proper PAT/PMT parsing with pointer_field
 *  - Flat buffer for video AU accumulation
 *  - Imports NAL helpers from reader_annexb (no duplication)
 */

import { EventEmitter } from 'node:events';
import ByteQueue from './byte_queue.js';
import { hasIDR_H264 } from './reader_annexb.js';
import { parseAdtsHeader } from './aac.js';

function TSReader(opts) {
  if (!opts) opts = {};
  this._ee = new EventEmitter();
  this._q = new ByteQueue();

  this._patParsed = false;
  this._pmtPid = null;
  this._videoPid = null;
  this._audioPid = null;

  this._pesBuf = {};

  this._fps = opts.fps || 30;
  this._index = 0;
  this._groupId = 0;
  this._sampleRate = opts.sampleRate || 48000;
  this._nextAudioPtsUs = 0;
}

TSReader.prototype.on = function (ev, fn) { this._ee.on(ev, fn); };
TSReader.prototype.off = function (ev, fn) { this._ee.off(ev, fn); };

TSReader.prototype.feed = function (chunk) {
  this._q.push(chunk);
  while (this._q.length >= 188) {
    var pkt = this._q.read(188);
    if (pkt[0] !== 0x47) continue;
    this._handlePacket(pkt);
  }
};

TSReader.prototype.flush = function () {
  this._q.reset();
  this._pesBuf = {};
};

TSReader.prototype._handlePacket = function (pkt) {
  var pid = ((pkt[1] & 0x1F) << 8) | pkt[2];
  var pusi = !!(pkt[1] & 0x40);
  var afl = (pkt[3] >> 4) & 0x03;
  var off = 4;
  if (afl === 2 || afl === 3) {
    off += 1 + pkt[off];
  }
  if (off >= 188) return;
  var payload = pkt.subarray(off);

  if (pid === 0x0000) { this._parsePSI(payload, pusi, 'pat'); return; }
  if (this._pmtPid !== null && pid === this._pmtPid) { this._parsePSI(payload, pusi, 'pmt'); return; }
  if (this._videoPid !== null && pid === this._videoPid) { this._accumPES(pid, payload, pusi, 'video'); return; }
  if (this._audioPid !== null && pid === this._audioPid) { this._accumPES(pid, payload, pusi, 'audio'); return; }
};

/**
 * Parse PSI table (PAT or PMT) with proper pointer_field handling.
 */
TSReader.prototype._parsePSI = function (pl, pusi, type) {
  var off = 0;
  // pointer_field: if PUSI is set, first byte is pointer to start of section data
  if (pusi) {
    var pointer = pl[0];
    off = 1 + pointer;
  }
  if (off >= pl.length) return;
  var section = pl.subarray(off);

  if (type === 'pat') {
    this._parsePATSection(section);
  } else {
    this._parsePMTSection(section);
  }
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
    if ((streamType === 0x1B || streamType === 0x24) && this._videoPid === null) this._videoPid = elemPid;
    // Audio: AAC=0x0F, AAC-LATM=0x11
    if ((streamType === 0x0F || streamType === 0x11) && this._audioPid === null) this._audioPid = elemPid;
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
    pes = Buffer.allocUnsafe(total);
    var off = 0;
    for (var c2 = 0; c2 < chunks.length; c2++) {
      chunks[c2].copy(pes, off);
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
    pts = ((pes[9] & 0x0E) << 29) | ((pes[10] & 0xFF) << 22) |
          ((pes[11] & 0xFE) << 14) | ((pes[12] & 0xFF) << 7) |
          ((pes[13] & 0xFE) >> 1);
  }

  var payloadStart = 9 + headerDataLen;
  if (payloadStart > pes.length) return;
  var es = pes.subarray(payloadStart);

  if (kind === 'video') this._processVideoES(es, pts);
  else if (kind === 'audio') this._processAudioES(es, pts);
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
  var au = Buffer.from(es);
  var isKey = hasIDR_H264(au);
  if (isKey) this._groupId++;
  var ptsUs = pts !== null
    ? Math.floor(pts * (1000000 / 90000))
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
    if (!info || !info.frameLength) { pos++; continue; }
    if (pos + info.frameLength > es.length) break;

    var frame = Buffer.from(es.subarray(pos, pos + info.frameLength));
    pos += info.frameLength;

    var sampleRate = info.sampleRate || this._sampleRate;
    var durUs = Math.floor(info.samplesPerFrame * 1000000 / sampleRate);
    var ptsUsA = pts !== null ? Math.floor(pts * (1000000 / 90000)) : this._nextAudioPtsUs;
    this._nextAudioPtsUs = ptsUsA + durUs;
    this._ee.emit('audio', {
      payload: frame,
      ptsUs: ptsUsA,
      durationUs: durUs,
      sampleRate: sampleRate,
      channels: info.channels,
      profile: info.profile,
    });
  }
};

export default TSReader;
