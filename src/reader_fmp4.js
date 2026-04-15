/**
 * reader_fmp4 — Fragmented MP4 reader with real PTS.
 *
 * Parses moof→traf→tfdt (base decode time) + trun (per-sample info)
 * to emit individual frames with accurate PTS and keyframe detection.
 */

import { EventEmitter } from 'node:events';
import ByteQueue from './byte_queue.js';

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
      this._timescale = buf.readUInt32BE(mvhd.dataStart + 12);
    } else if (ver === 1 && mvhd.dataStart + 28 <= buf.length) {
      this._timescale = buf.readUInt32BE(mvhd.dataStart + 20);
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
          this._timescale = buf.readUInt32BE(mdhd.dataStart + 12);
        } else if (mdVer === 1 && mdhd.dataStart + 28 <= buf.length) {
          this._timescale = buf.readUInt32BE(mdhd.dataStart + 20);
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
    if (tfhdFlags & 0x000008) { defaultDur = buf.readUInt32BE(p); p += 4; }
    if (tfhdFlags & 0x000010) { defaultSize = buf.readUInt32BE(p); p += 4; }
    if (tfhdFlags & 0x000020) { defaultFlags = buf.readUInt32BE(p); }
  }

  // Parse tfdt for base decode time
  var baseDecodeTime = 0;
  var tfdt = _findBox(buf, traf.dataStart, traf.end, 'tfdt');
  if (tfdt) {
    var tfdtVer = buf[tfdt.dataStart];
    if (tfdtVer === 0) {
      baseDecodeTime = buf.readUInt32BE(tfdt.dataStart + 4);
    } else {
      var hi = buf.readUInt32BE(tfdt.dataStart + 4);
      var lo = buf.readUInt32BE(tfdt.dataStart + 8);
      baseDecodeTime = hi * 0x100000000 + lo;
    }
  }

  // Parse trun for per-sample info
  var trun = _findBox(buf, traf.dataStart, traf.end, 'trun');
  if (!trun) { this._ee.emit('segment', { payload: buf }); return; }

  var trunOff = trun.dataStart;
  var trunFlags = (buf[trunOff + 1] << 16) | (buf[trunOff + 2] << 8) | buf[trunOff + 3];
  var sampleCount = buf.readUInt32BE(trunOff + 4);
  var tp = trunOff + 8;

  // data_offset (relative to moof start)
  var dataOffset = 0;
  if (trunFlags & 0x000001) { dataOffset = buf.readInt32BE(tp); tp += 4; }
  if (trunFlags & 0x000004) tp += 4;  // first_sample_flags

  var hasDuration = !!(trunFlags & 0x000100);
  var hasSize = !!(trunFlags & 0x000200);
  var hasFlags = !!(trunFlags & 0x000400);
  var hasCTO = !!(trunFlags & 0x000800);

  // Read samples
  var samples = [];
  for (var i = 0; i < sampleCount; i++) {
    var dur = defaultDur, sz = defaultSize, fl = defaultFlags, cto = 0;
    if (hasDuration) { dur = buf.readUInt32BE(tp); tp += 4; }
    if (hasSize) { sz = buf.readUInt32BE(tp); tp += 4; }
    if (hasFlags) { fl = buf.readUInt32BE(tp); tp += 4; }
    if (hasCTO) { cto = buf.readInt32BE(tp); tp += 4; }
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

    var payload = Buffer.from(buf.subarray(sampleOffset, end));
    var ptsUs = Math.round((currentTime + sample.compositionOffset) * 1e6 / this._timescale);

    // Keyframe detection from sample_flags:
    // Bit 26-25 (sample_depends_on): 2 = depends on others (not keyframe)
    // If sample_depends_on == 2, it's NOT a keyframe
    var dependsOn = (sample.flags >> 24) & 0x03;
    var isKey = (dependsOn !== 2);
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
  if (hdr1.toString('ascii', 4, 8) !== 'ftyp') return null;
  var ftypSize = hdr1.readUInt32BE(0);
  if (ftypSize === 1) {
    var hdr1ext = this._q.peek(16);
    if (!hdr1ext) return null;
    ftypSize = hdr1ext.readUInt32BE(8) * 0x100000000 + hdr1ext.readUInt32BE(12);
  }
  if (ftypSize < 8 || this._q.length < ftypSize + 8) return null;

  // Peek moov header at offset ftypSize
  var buf2 = this._q.peek(ftypSize + 8);
  if (!buf2) return null;
  if (buf2.toString('ascii', ftypSize + 4, ftypSize + 8) !== 'moov') return null;
  var moovSize = buf2.readUInt32BE(ftypSize);
  if (moovSize === 1) {
    var buf2ext = this._q.peek(ftypSize + 16);
    if (!buf2ext) return null;
    moovSize = buf2ext.readUInt32BE(ftypSize + 8) * 0x100000000 + buf2ext.readUInt32BE(ftypSize + 12);
  }
  if (moovSize < 8 || this._q.length < ftypSize + moovSize) return null;

  return this._q.read(ftypSize + moovSize);
};

FMP4Reader.prototype._tryReadSegment = function () {
  // Peek just 8 bytes to get moof size, then check mdat
  var hdr1 = this._q.peek(8);
  if (!hdr1) return null;
  if (hdr1.toString('ascii', 4, 8) !== 'moof') return null;
  var moofSize = hdr1.readUInt32BE(0);
  if (moofSize === 1) {
    var hdr1ext = this._q.peek(16);
    if (!hdr1ext) return null;
    moofSize = hdr1ext.readUInt32BE(8) * 0x100000000 + hdr1ext.readUInt32BE(12);
  }
  if (moofSize < 8 || this._q.length < moofSize + 8) return null;

  var buf2 = this._q.peek(moofSize + 8);
  if (!buf2) return null;
  if (buf2.toString('ascii', moofSize + 4, moofSize + 8) !== 'mdat') return null;
  var mdatSize = buf2.readUInt32BE(moofSize);
  if (mdatSize === 1) {
    var buf2ext = this._q.peek(moofSize + 16);
    if (!buf2ext) return null;
    mdatSize = buf2ext.readUInt32BE(moofSize + 8) * 0x100000000 + buf2ext.readUInt32BE(moofSize + 12);
  }
  if (mdatSize < 8 || this._q.length < moofSize + mdatSize) return null;

  return this._q.read(moofSize + mdatSize);
};

function _readBoxHeader(buf, off) {
  if (off + 8 > buf.length) return null;
  var size = buf.readUInt32BE(off);
  var type = buf.toString('ascii', off + 4, off + 8);
  if (size === 1) {
    if (off + 16 > buf.length) return null;
    size = buf.readUInt32BE(off + 8) * 0x100000000 + buf.readUInt32BE(off + 12);
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
    var size = buf.readUInt32BE(off);
    var t = buf.toString('ascii', off + 4, off + 8);
    var headerSize = 8;
    if (size === 1 && off + 16 <= to) {
      size = buf.readUInt32BE(off + 8) * 0x100000000 + buf.readUInt32BE(off + 12);
      headerSize = 16;
    }
    if (size < 8 || off + size > to) break;
    if (t === type) return { start: off, end: off + size, dataStart: off + headerSize };
    off += size;
  }
  return null;
}

export default FMP4Reader;
