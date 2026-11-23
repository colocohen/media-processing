/**
 * reader_fmp4 — Fragmented MP4 reader with real PTS.
 *
 * Parses moof→traf→tfdt (base decode time) + trun (per-sample info)
 * to emit individual frames with accurate PTS and keyframe detection.
 *
 * Events:
 *   'init'    { initSegment (ftyp + moov), timescale, tracks }
 *             tracks: [{ id, type: 'video'|'audio'|'other', timescale }];
 *             timescale: the first video track's (else the first track's)
 *   'video' / 'audio'
 *             { trackId, payload, isKeyframe, ptsUs, dtsUs, durationUs,
 *               duration (track ticks) } — by the track's handler
 *   'segment' { payload } — a moof with nothing this reader can read
 *
 * The stream is read box by box at the top level (ISO/IEC 14496-12 §4.2):
 * the boxes it doesn't need — styp, sidx, emsg, prft, free, skip, uuid,
 * an mdat without a moof — are skipped by their size, and boxes between a
 * moof and its mdat are allowed.
 */

import EventEmitter from './core/events.js';
import { readU32BE, readU64BE, toAscii, concat } from './core/bytes.js';
import { findBox, findBoxes, findPath, parseTfhd, parseTfdt, parseTrun, isSyncSampleFlags } from './utils/iso_bmff.js';
import ByteQueue from './core/byte_queue.js';

// Boxes read whole; any other top-level box is skipped as it streams by.
var KEEP = { ftyp: true, moov: true, moof: true, mdat: true };

function FMP4Reader(opts) {
  if (!opts) opts = {};
  this._ee = new EventEmitter();
  this._q = new ByteQueue();
  this._gotInit = false;
  this._timescale = opts.timescale || 90000;
  this._defaultSampleDuration = opts.defaultSampleDuration || 0;
  this._defaultSampleSize = opts.defaultSampleSize || 0;
  this._pos = 0;          // the stream offset of the queue's first byte
  this._skip = 0;         // bytes of a skipped box still to come
  this._ftyp = null;
  this._tracks = {};      // track_ID → { id, type, timescale, trex defaults, nextDts }
  this._moof = null;      // { buf, start }: waiting for its mdat
}

FMP4Reader.prototype.on = function (ev, fn) { this._ee.on(ev, fn); };
FMP4Reader.prototype.off = function (ev, fn) { this._ee.off(ev, fn); };

/**
 * One top-level box at a time.
 *
 * This used to accept only `ftyp moov` and then strictly `moof mdat`
 * pairs: the first other box stalled the reader for good — every byte
 * after it stayed queued. An HLS fMP4 stream (init + segments, each
 * starting with styp) and a file with a global sidx gave 0 of 90 frames.
 */
FMP4Reader.prototype.feed = function (chunk) {
  this._q.push(chunk);
  while (true) {
    if (this._skip) {
      var n = Math.min(this._skip, this._q.length);
      if (!n) break;
      this._q.discard(n);
      this._pos += n;
      this._skip -= n;
      continue;
    }
    var h = this._q.peek(8);
    if (!h) break;
    var size = readU32BE(h, 0), type = toAscii(h, 4, 8), hdr = 8;
    if (size === 1) {
      var h16 = this._q.peek(16);
      if (!h16) break;
      size = readU64BE(h16, 8);
      hdr = 16;
    }
    // size 0 (to the end of the file) can't be framed in a stream; a
    // size below the header is garbage — either way nothing more can be
    // read, as before.
    if (size < hdr) break;
    if (!KEEP[type]) { this._skip = size; continue; }
    if (this._q.length < size) break;
    var start = this._pos;
    var box = this._q.read(size);
    this._pos += size;
    this._box(type, box, start);
  }
};

FMP4Reader.prototype.flush = function () {
  this._q.reset();
  this._skip = 0;
  this._moof = null;
};

FMP4Reader.prototype._box = function (type, buf, start) {
  if (type === 'ftyp') { this._ftyp = buf; return; }
  if (type === 'moov') {
    this._parseInitSegment(buf);
    var init = this._ftyp ? concat([this._ftyp, buf]) : buf;
    var tracks = [], self = this;
    Object.keys(this._tracks).forEach(function (id) {
      var t = self._tracks[id];
      tracks.push({ id: t.id, type: t.type, timescale: t.timescale });
    });
    this._gotInit = true;
    this._ee.emit('init', { initSegment: init, timescale: this._timescale, tracks: tracks });
    return;
  }
  if (type === 'moof') { this._moof = { buf: buf, start: start }; return; }
  // mdat
  if (!this._moof) return;                    // media data without a moof: nothing to index it
  var moof = this._moof;
  this._moof = null;
  this._parseMediaSegment(moof.buf, moof.start, buf, start);
};

// ── Init segment: every trak's id, handler and timescale; mvex/trex defaults ──

FMP4Reader.prototype._parseInitSegment = function (buf) {
  var moov = { dataStart: 8, end: buf.length };
  if (readU32BE(buf, 0) === 1) moov.dataStart = 16;
  var mvhd = findBox(buf, moov.dataStart, moov.end, 'mvhd');
  if (mvhd) {
    var ver = buf[mvhd.dataStart];
    if (ver === 0 && mvhd.dataStart + 20 <= buf.length) {
      this._timescale = readU32BE(buf, mvhd.dataStart + 12);
    } else if (ver === 1 && mvhd.dataStart + 28 <= buf.length) {
      this._timescale = readU32BE(buf, mvhd.dataStart + 20);
    }
  }
  // Every trak, by track_ID. Only the first trak's mdhd was read, and
  // every sample was timed with it and emitted as 'video': with the audio
  // track first (track 1, 48 kHz) the 142 AAC frames came out as 'video'
  // keyframes and the video track (90 kHz) was never told apart.
  var self = this, firstVideo = null, first = null;
  findBoxes(buf, moov.dataStart, moov.end, 'trak').forEach(function (trak) {
    var tkhd = findBox(buf, trak.dataStart, trak.end, 'tkhd');
    var mdhd = findPath(buf, trak, 'mdia/mdhd');
    var hdlr = findPath(buf, trak, 'mdia/hdlr');
    if (!tkhd || !mdhd) return;
    var id = readU32BE(buf, tkhd.dataStart + (buf[tkhd.dataStart] === 1 ? 20 : 12));
    var ts = readU32BE(buf, mdhd.dataStart + (buf[mdhd.dataStart] === 1 ? 20 : 12));
    var handler = hdlr ? toAscii(buf, hdlr.dataStart + 8, hdlr.dataStart + 12) : '';
    var t = {
      id: id, timescale: ts || self._timescale,
      type: handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : 'other',
      defaultDuration: null, defaultSize: null, defaultFlags: null, nextDts: 0,
    };
    self._tracks[id] = t;
    if (!first) first = t;
    if (!firstVideo && t.type === 'video') firstVideo = t;
  });
  var mvex = findBox(buf, moov.dataStart, moov.end, 'mvex');
  if (mvex) {
    findBoxes(buf, mvex.dataStart, mvex.end, 'trex').forEach(function (trex) {
      var p = trex.dataStart + 4, t = self._tracks[readU32BE(buf, p)];
      if (!t) return;
      t.defaultDuration = readU32BE(buf, p + 8);
      t.defaultSize = readU32BE(buf, p + 12);
      t.defaultFlags = readU32BE(buf, p + 16);
    });
  }
  if (firstVideo || first) this._timescale = (firstVideo || first).timescale;
};

// ── Media segment (moof + its mdat → individual frames) ──

/**
 * Every traf of the moof, every trun of each traf (§8.8.4: one traf per
 * track, any number of truns). Only the first traf and its first trun
 * were read, so the other tracks of a muxed fragment were lost.
 *
 * Sample positions (§8.8.7, §8.8.8): base_data_offset when tfhd has it,
 * else the moof's start (default-base-is-moof, or the first traf), else
 * where the previous traf's data ended; a trun's data_offset is from that
 * base, and a trun without one continues after the previous run.
 */
FMP4Reader.prototype._parseMediaSegment = function (moofBuf, moofStart, mdat, mdatStart) {
  var trafs = findBoxes(moofBuf, 8, moofBuf.length, 'traf');
  if (!trafs.length) { this._ee.emit('segment', { payload: concat([moofBuf, mdat]) }); return; }
  var prevEnd = moofStart, any = false;
  for (var ti = 0; ti < trafs.length; ti++) {
    var traf = trafs[ti];
    var tfhdBox = findBox(moofBuf, traf.dataStart, traf.end, 'tfhd');
    if (!tfhdBox) continue;
    var tfhd = parseTfhd(moofBuf, tfhdBox);
    var track = this._tracks[tfhd.trackId];
    if (!track) {
      // No moov seen (fed from a segment on): one video track, as before.
      track = this._tracks[tfhd.trackId] = {
        id: tfhd.trackId, type: 'video', timescale: this._timescale,
        defaultDuration: null, defaultSize: null, defaultFlags: null, nextDts: 0,
      };
    }
    var defaultDur   = _first(tfhd.defaultSampleDuration, track.defaultDuration, this._defaultSampleDuration);
    var defaultSize  = _first(tfhd.defaultSampleSize, track.defaultSize, this._defaultSampleSize);
    var defaultFlags = _first(tfhd.defaultSampleFlags, track.defaultFlags, 0);

    var base = tfhd.baseDataOffset != null ? tfhd.baseDataOffset
             : (tfhd.defaultBaseIsMoof || ti === 0) ? moofStart : prevEnd;

    var tfdt = findBox(moofBuf, traf.dataStart, traf.end, 'tfdt');
    var time = tfdt ? parseTfdt(moofBuf, tfdt) : track.nextDts;
    var dataPos = base;

    var truns = findBoxes(moofBuf, traf.dataStart, traf.end, 'trun');
    for (var ri = 0; ri < truns.length; ri++) {
      var trun = parseTrun(moofBuf, truns[ri]);
      if (trun.dataOffset != null) dataPos = base + trun.dataOffset;
      for (var i = 0; i < trun.samples.length; i++) {
        var t = trun.samples[i];
        // first_sample_flags stands in for the first sample's flags when the
        // trun gives no per-sample ones (§8.8.8.1).
        var flags = t.flags != null ? t.flags
                  : (i === 0 && trun.firstSampleFlags != null ? trun.firstSampleFlags : defaultFlags);
        var dur = t.duration != null ? t.duration : defaultDur;
        var size = t.size != null ? t.size : defaultSize;
        var at = dataPos - mdatStart;
        dataPos += size;
        var ptsUs = Math.round((time + t.compositionOffset) * 1e6 / track.timescale);
        var dtsUs = Math.round(time * 1e6 / track.timescale);
        var endUs = Math.round((time + dur) * 1e6 / track.timescale);
        time += dur;
        if (at < 0 || at + size > mdat.length) continue;   // not in this mdat
        any = true;
        if (track.type === 'other') continue;

        // Keyframe from sample_flags — utils/iso_bmff isSyncSampleFlags
        // (ISO/IEC 14496-12 §8.6.4.3): sample_depends_on 2 → I-frame, 1 →
        // P/B-frame, 0 / 3 (unknown / reserved) → sample_is_non_sync_sample
        // decides. (FFmpeg writes depends_on=0 for every sample, so the
        // fallback is the common path — see the MP-30 history in git.)
        // Audio samples are all sync samples whatever the flags say.
        this._ee.emit(track.type, {
          trackId: track.id,
          payload: mdat.slice(at, at + size),
          isKeyframe: track.type === 'audio' ? true : isSyncSampleFlags(flags),
          ptsUs: ptsUs,
          dtsUs: dtsUs,
          durationUs: endUs - dtsUs,
          duration: dur,
        });
      }
    }
    track.nextDts = time;
    prevEnd = dataPos;
  }
  if (!any) this._ee.emit('segment', { payload: concat([moofBuf, mdat]) });
};

function _first(a, b, c) { return a != null ? a : b != null ? b : c; }

export default FMP4Reader;
