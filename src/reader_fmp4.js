/**
 * reader_fmp4 — Fragmented MP4 reader with real PTS.
 *
 * Parses moof→traf→tfdt (base decode time) + trun (per-sample info)
 * to emit individual frames with accurate PTS and keyframe detection.
 */

import EventEmitter from './core/events.js';
import { readU32BE, toAscii, readS32BE } from './core/bytes.js';
import ByteQueue from './core/byte_queue.js';

function FMP4Reader(opts) {
  if (!opts) opts = {};
  this._ee = new EventEmitter();
  this._q = new ByteQueue();
  this._gotInit = false;
  this._timescale = opts.timescale || 90000;
  this._defaultSampleDuration = opts.defaultSampleDuration || 0;
  this._defaultSampleSize = opts.defaultSampleSize || 0;
}

FMP4Reader.prototype.on = function (ev, fn) { this._ee.on(ev, fn); };
FMP4Reader.prototype.off = function (ev, fn) { this._ee.off(ev, fn); };

FMP4Reader.prototype.feed = function (chunk) {
  this._q.push(chunk);
  while (true) {
    if (!this._gotInit) {
      var init = this._tryReadInit();
      if (!init) break;
      this._parseInitSegment(init);
      this._ee.emit('init', { initSegment: init, timescale: this._timescale });
      this._gotInit = true;
    } else {
      var seg = this._tryReadSegment();
      if (!seg) break;
      this._parseMediaSegment(seg);
    }
  }
};

FMP4Reader.prototype.flush = function () { this._q.reset(); };

// ── Init segment parsing (extract timescale from moov→mvhd or moov→trak→mdhd) ──

FMP4Reader.prototype._parseInitSegment = function (buf) {
  var moov = _findBox(buf, 0, buf.length, 'moov');
  if (!moov) return;
  // Try mvhd for timescale
  var mvhd = _findBox(buf, moov.dataStart, moov.end, 'mvhd');
  if (mvhd) {
    var ver = buf[mvhd.dataStart];
    if (ver === 0 && mvhd.dataStart + 20 <= buf.length) {
      this._timescale = readU32BE(buf, mvhd.dataStart + 12);
    } else if (ver === 1 && mvhd.dataStart + 28 <= buf.length) {
      this._timescale = readU32BE(buf, mvhd.dataStart + 20);
    }
  }
  // Try mdhd for more specific timescale
  var trak = _findBox(buf, moov.dataStart, moov.end, 'trak');
  if (trak) {
    var mdia = _findBox(buf, trak.dataStart, trak.end, 'mdia');
    if (mdia) {
      var mdhd = _findBox(buf, mdia.dataStart, mdia.end, 'mdhd');
      if (mdhd) {
        var mdVer = buf[mdhd.dataStart];
        if (mdVer === 0 && mdhd.dataStart + 20 <= buf.length) {
          this._timescale = readU32BE(buf, mdhd.dataStart + 12);
        } else if (mdVer === 1 && mdhd.dataStart + 28 <= buf.length) {
          this._timescale = readU32BE(buf, mdhd.dataStart + 20);
        }
      }
    }
  }
};

// ── Media segment parsing (moof + mdat → individual frames) ──

FMP4Reader.prototype._parseMediaSegment = function (buf) {
  var moof = _findBox(buf, 0, buf.length, 'moof');
  var mdat = _findBox(buf, 0, buf.length, 'mdat');
  if (!moof || !mdat) {
    // Fallback: emit as raw segment
    this._ee.emit('segment', { payload: buf });
    return;
  }

  var traf = _findBox(buf, moof.dataStart, moof.end, 'traf');
  if (!traf) { this._ee.emit('segment', { payload: buf }); return; }

  // Parse tfhd for defaults
  var tfhd = _findBox(buf, traf.dataStart, traf.end, 'tfhd');
  var defaultDur = this._defaultSampleDuration;
  var defaultSize = this._defaultSampleSize;
  var defaultFlags = 0;
  if (tfhd) {
    var tfhdOff = tfhd.dataStart;
    var tfhdFlags = (buf[tfhdOff + 1] << 16) | (buf[tfhdOff + 2] << 8) | buf[tfhdOff + 3];
    var p = tfhdOff + 8;  // skip version(1) + flags(3) + trackID(4)
    if (tfhdFlags & 0x000002) p += 8;  // base_data_offset
    if (tfhdFlags & 0x000008) { defaultDur = readU32BE(buf, p); p += 4; }
    if (tfhdFlags & 0x000010) { defaultSize = readU32BE(buf, p); p += 4; }
    if (tfhdFlags & 0x000020) { defaultFlags = readU32BE(buf, p); }
  }

  // Parse tfdt for base decode time
  var baseDecodeTime = 0;
  var tfdt = _findBox(buf, traf.dataStart, traf.end, 'tfdt');
  if (tfdt) {
    var tfdtVer = buf[tfdt.dataStart];
    if (tfdtVer === 0) {
      baseDecodeTime = readU32BE(buf, tfdt.dataStart + 4);
    } else {
      var hi = readU32BE(buf, tfdt.dataStart + 4);
      var lo = readU32BE(buf, tfdt.dataStart + 8);
      baseDecodeTime = hi * 0x100000000 + lo;
    }
  }

  // Parse trun for per-sample info
  var trun = _findBox(buf, traf.dataStart, traf.end, 'trun');
  if (!trun) { this._ee.emit('segment', { payload: buf }); return; }

  var trunOff = trun.dataStart;
  var trunFlags = (buf[trunOff + 1] << 16) | (buf[trunOff + 2] << 8) | buf[trunOff + 3];
  var sampleCount = readU32BE(buf, trunOff + 4);
  var tp = trunOff + 8;

  // data_offset (relative to moof start)
  var dataOffset = 0;
  if (trunFlags & 0x000001) { dataOffset = readS32BE(buf, tp); tp += 4; }
  if (trunFlags & 0x000004) tp += 4;  // first_sample_flags

  var hasDuration = !!(trunFlags & 0x000100);
  var hasSize = !!(trunFlags & 0x000200);
  var hasFlags = !!(trunFlags & 0x000400);
  var hasCTO = !!(trunFlags & 0x000800);

  // Read samples
  var samples = [];
  for (var i = 0; i < sampleCount; i++) {
    var dur = defaultDur, sz = defaultSize, fl = defaultFlags, cto = 0;
    if (hasDuration) { dur = readU32BE(buf, tp); tp += 4; }
    if (hasSize) { sz = readU32BE(buf, tp); tp += 4; }
    if (hasFlags) { fl = readU32BE(buf, tp); tp += 4; }
    if (hasCTO) { cto = readS32BE(buf, tp); tp += 4; }
    samples.push({ duration: dur, size: sz, flags: fl, compositionOffset: cto });
  }

  // Emit individual frames from mdat
  var mdatDataStart = mdat.dataStart;
  var sampleOffset = moof.start + dataOffset;
  // If dataOffset points into mdat, use it; otherwise start at mdat data
  if (sampleOffset < mdatDataStart || sampleOffset >= mdat.end) {
    sampleOffset = mdatDataStart;
  }

  var currentTime = baseDecodeTime;
  for (var s = 0; s < samples.length; s++) {
    var sample = samples[s];
    var end = sampleOffset + sample.size;
    if (end > buf.length) break;

    var payload = buf.slice(sampleOffset, end);
    var ptsUs = Math.round((currentTime + sample.compositionOffset) * 1e6 / this._timescale);

    // Keyframe detection from sample_flags (ISO/IEC 14496-12 §8.6.4.3).
    //
    // sample_flags is a 32-bit field. Two relevant fields:
    //
    //   bit 25-24: sample_depends_on (2 bits)
    //     0 = unknown
    //     1 = THIS sample depends on others (P/B-frame)
    //     2 = THIS sample does NOT depend on others (I-frame)
    //     3 = reserved
    //
    //   bit 16: sample_is_non_sync_sample (1 bit)
    //     0 = this IS a sync (random-access) sample — keyframe
    //     1 = not a sync sample
    //
    // History: the original code (pre-MP-30) used `depends_on != 2`,
    // which over-classified depends_on=0 ("unknown") as keyframe.
    // FFmpeg's default fMP4 muxer sets depends_on=0 for every sample
    // unless explicitly configured, so EVERY P-frame got flagged as
    // keyframe → unnecessary PLI / RTCP feedback, broken NACK / FEC
    // heuristics.
    //
    // The MP-30 fix added the fallback to is_non_sync_sample but
    // inverted the depends_on direction by mistake — it read
    // "1 = others depend on this" (i.e. I-frame), but the spec
    // actually says "1 = this depends on others" (i.e. P/B-frame).
    // The bug stayed masked because depends_on=0 is the common case
    // (handled by the fallback path) and depends_on != 0 was rare in
    // tested inputs. Caught while writing writer-fmp4.js.
    //
    // Current logic (correct per spec):
    //   - depends_on=2 → I-frame → keyframe
    //   - depends_on=1 → P/B-frame → not keyframe
    //   - depends_on=0 or 3 (unknown / reserved) → defer to is_non_sync
    var dependsOn = (sample.flags >> 24) & 0x03;
    var isNonSync = (sample.flags >> 16) & 0x01;
    var isKey;
    if (dependsOn === 2) {
      isKey = true;
    } else if (dependsOn === 1) {
      isKey = false;
    } else {
      // dependsOn === 0 (unknown) or === 3 (reserved) — fall back to
      // is_non_sync_sample bit. is_non_sync == 0 means it IS a sync
      // sample (keyframe).
      isKey = (isNonSync === 0);
    }
    // First sample in fragment with first_sample_flags might override
    if (s === 0 && (trunFlags & 0x000004)) {
      // first_sample_flags was present — already handled above
    }

    this._ee.emit('video', {
      payload: payload,
      isKeyframe: isKey,
      ptsUs: ptsUs,
      dtsUs: Math.round(currentTime * 1e6 / this._timescale),
      duration: sample.duration,
    });

    sampleOffset = end;
    currentTime += sample.duration;
  }
};

// ── Box reading helpers ──

FMP4Reader.prototype._tryReadInit = function () {
  // Peek just 8 bytes to get ftyp size, then check moov
  var hdr1 = this._q.peek(8);
  if (!hdr1) return null;
  if (toAscii(hdr1, 4, 8) !== 'ftyp') return null;
  var ftypSize = readU32BE(hdr1, 0);
  if (ftypSize === 1) {
    var hdr1ext = this._q.peek(16);
    if (!hdr1ext) return null;
    ftypSize = readU32BE(hdr1ext, 8) * 0x100000000 + readU32BE(hdr1ext, 12);
  }
  if (ftypSize < 8 || this._q.length < ftypSize + 8) return null;

  // Peek moov header at offset ftypSize
  var buf2 = this._q.peek(ftypSize + 8);
  if (!buf2) return null;
  if (toAscii(buf2, ftypSize + 4, ftypSize + 8) !== 'moov') return null;
  var moovSize = readU32BE(buf2, ftypSize);
  if (moovSize === 1) {
    var buf2ext = this._q.peek(ftypSize + 16);
    if (!buf2ext) return null;
    moovSize = readU32BE(buf2ext, ftypSize + 8) * 0x100000000 + readU32BE(buf2ext, ftypSize + 12);
  }
  if (moovSize < 8 || this._q.length < ftypSize + moovSize) return null;

  return this._q.read(ftypSize + moovSize);
};

FMP4Reader.prototype._tryReadSegment = function () {
  // Peek just 8 bytes to get moof size, then check mdat
  var hdr1 = this._q.peek(8);
  if (!hdr1) return null;
  if (toAscii(hdr1, 4, 8) !== 'moof') return null;
  var moofSize = readU32BE(hdr1, 0);
  if (moofSize === 1) {
    var hdr1ext = this._q.peek(16);
    if (!hdr1ext) return null;
    moofSize = readU32BE(hdr1ext, 8) * 0x100000000 + readU32BE(hdr1ext, 12);
  }
  if (moofSize < 8 || this._q.length < moofSize + 8) return null;

  var buf2 = this._q.peek(moofSize + 8);
  if (!buf2) return null;
  if (toAscii(buf2, moofSize + 4, moofSize + 8) !== 'mdat') return null;
  var mdatSize = readU32BE(buf2, moofSize);
  if (mdatSize === 1) {
    var buf2ext = this._q.peek(moofSize + 16);
    if (!buf2ext) return null;
    mdatSize = readU32BE(buf2ext, moofSize + 8) * 0x100000000 + readU32BE(buf2ext, moofSize + 12);
  }
  if (mdatSize < 8 || this._q.length < moofSize + mdatSize) return null;

  return this._q.read(moofSize + mdatSize);
};

function _readBoxHeader(buf, off) {
  if (off + 8 > buf.length) return null;
  var size = readU32BE(buf, off);
  var type = toAscii(buf, off + 4, off + 8);
  if (size === 1) {
    if (off + 16 > buf.length) return null;
    size = readU32BE(buf, off + 8) * 0x100000000 + readU32BE(buf, off + 12);
  }
  if (size === 0 || off + size > buf.length) return null;
  return { size: size, type: type };
}

/**
 * Find a box by type within a range. Returns { start, end, dataStart } or null.
 */
function _findBox(buf, from, to, type) {
  var off = from;
  while (off + 8 <= to) {
    var size = readU32BE(buf, off);
    var t = toAscii(buf, off + 4, off + 8);
    var headerSize = 8;
    if (size === 1 && off + 16 <= to) {
      size = readU32BE(buf, off + 8) * 0x100000000 + readU32BE(buf, off + 12);
      headerSize = 16;
    }
    if (size < 8 || off + size > to) break;
    if (t === type) return { start: off, end: off + size, dataStart: off + headerSize };
    off += size;
  }
  return null;
}

export default FMP4Reader;
