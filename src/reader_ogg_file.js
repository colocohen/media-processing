/**
 * reader_ogg_file — an Ogg Opus file (.opus / .ogg): a FILE fed in pieces
 * → its Opus packets, with the OpusHead (RFC 7845 §5.1) as the WebCodecs
 * description. The API and events are reader_mp4's (see
 * reader_file_stream.js).
 *
 * The pages (RFC 3533) are found and checked here — capture pattern,
 * version 0, CRC-32 — and those of the first Opus logical stream (its
 * BOS page holds the OpusHead) go to reader_ogg, which assembles the
 * packets across pages and skips the two header packets; other logical
 * streams (a video, a second audio, a chained stream after it) are not
 * read. An Ogg file with no Opus stream (Vorbis, FLAC, Theora) gives a
 * track with codec null.
 *
 * Timestamps (RFC 7845 §4): from the granule positions — a page's granule
 * is where the last packet completed on it ends, so the packets on a page
 * are timed back from it by their TOC durations (RFC 6716 §3.1); the end-
 * of-stream page's last packet ends at its granule (§4.5 — shorter than
 * its TOC says). Minus the pre-skip: the first packet of a stream that
 * starts at granule 0 is at −pre-skip (−6.5 ms for libopus' 312), as
 * FFmpeg has it; info.startUs is where the audio starts (0), and
 * info.durationUs is the last granule minus the pre-skip (RFC 7845 §4.3 —
 * FFmpeg counts the pre-skip in it).
 *
 * The last page's granule (the duration) is read before 'info': when the
 * file size is known, a 'need' for its last 128 KB, then back to the start.
 *
 * seek(): from the packet playing at the time, by bisection (a page says
 * its time wherever reading starts; a packet is indexed at the page it
 * begins on, and the part of a packet before a jump is dropped). Exact.
 */

import FileStreamReader from './reader_file_stream.js';
import OggReader from './reader_ogg.js';
import { getOpusPacketDurationUs, parseOpusHead } from './utils/opus_utils.js';
import { readU32LE } from './core/bytes.js';

var TAIL = 128 * 1024;
var NO_GRANULE = -1;

var CRC = new Uint32Array(256);
(function () {
  for (var i = 0; i < 256; i++) {
    var c = i << 24;
    for (var k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04C11DB7 : c << 1;
    CRC[i] = c >>> 0;
  }
})();

// A whole, valid page at v[o..]: { len, type, granule, serial, body offsets } — or
// null (not a page / bad CRC), or 0 (could be one: more bytes needed).
function _page(v, o) {
  var n = v.length - o;
  if (n < 27) return 0;
  if (v[o] !== 0x4F || v[o + 1] !== 0x67 || v[o + 2] !== 0x67 || v[o + 3] !== 0x53 || v[o + 4] !== 0) return null;
  var segs = v[o + 26], hl = 27 + segs;
  if (n < hl) return 0;
  var body = 0;
  for (var i = 0; i < segs; i++) body += v[o + 27 + i];
  if (n < hl + body) return 0;
  var crc = 0;
  for (var j = 0; j < hl + body; j++) {
    var b = j >= 22 && j < 26 ? 0 : v[o + j];
    crc = ((crc << 8) ^ CRC[((crc >>> 24) ^ b) & 0xFF]) >>> 0;
  }
  if (crc !== readU32LE(v, o + 22)) return null;
  var lo = readU32LE(v, o + 6), hi = readU32LE(v, o + 10);
  var granule = hi === 0xFFFFFFFF && lo === 0xFFFFFFFF ? NO_GRANULE : hi * 4294967296 + lo;
  return { len: hl + body, type: v[o + 5], granule: granule, serial: readU32LE(v, o + 14), head: hl, segs: segs };
}

function OggFormat() {
  this.name = 'OggReader';
  this.container = 'ogg';
  this.tracks = [];
  this.resync = true;
  this.dataStart = 0;
  this.durationUs = 0;
  this.startUs = null;
  this.tailFrom = null;
  this._serial = null;
  this._head = null;
  this._preSkip = 0;
  this._other = null;        // a non-Opus stream's name, when that's all there is
  this._r = null;
  this._evs = [];
  this._next = null;         // granule of the next packet's start
  this._timed = false;
  this._lastGranule = NO_GRANULE;
  this._eosAt = -1;          // the EOS page (from the tail) and where the packets
  this._eosStart = null;     // read from it after a jump start (null: not known)
  this._openAt = -1;         // the page the packet still open began on (-1: not known)
  this._pend = [];
  this._newReader();
}

OggFormat.prototype._newReader = function () {
  var self = this;
  this._r = new OggReader();
  this._r.on('audio', function (f) { self._evs.push(f); });
};

OggFormat.prototype.ready = function () { return (this._serial !== null && this._timed) || this._other !== null; };

OggFormat.prototype.parse = function (win, pos, eof, emit) {
  // Packets of the last page that weren't taken yet (emit() said stop).
  while (this._pend.length) {
    if (!emit(this._pend.shift())) return pos;
  }
  while (true) {
    if (!win.has(pos, 1)) return eof ? Infinity : pos;
    var v = win.view(pos, win.end() - pos);
    var pg = _page(v, 0);
    if (pg === 0) {
      if (!eof) return pos;
      return Infinity;                         // a cut-off last page
    }
    if (!pg) {                                 // not a page: the next 'OggS'
      var q = -1;
      for (var i = 1; i + 4 <= v.length; i++) {
        if (v[i] === 0x4F && v[i + 1] === 0x67 && v[i + 2] === 0x67 && v[i + 3] === 0x53 && _page(v, i) !== null) { q = i; break; }
      }
      if (q < 0) return eof ? Infinity : Math.max(pos, win.end() - 27);
      pos += q;
      continue;
    }
    var page = v.subarray(0, pg.len), at = pos;
    pos += pg.len;
    if (pg.type & 2) {                         // BOS: which logical stream is this?
      var first = page.subarray(pg.head, pg.head + page[27]);
      if (this._serial === null && _isTag(first, 'OpusHead')) {
        this._serial = pg.serial;
        this._head = first.slice();
        var oh = parseOpusHead(this._head);
        this._preSkip = oh ? oh.preSkip : 0;
        this._setup(oh);
        if (this.fileSize) this.tailFrom = Math.max(0, this.fileSize - TAIL);
      } else if (this._serial === null && this._other === null && !(_isTag(first, 'OpusHead'))) {
        this._firstOther = this._firstOther || _streamName(first);
      }
    } else if (this._serial === null && this._other === null) {
      // past the BOS pages without an Opus stream
      this._other = this._firstOther || 'unknown';
      this.tracks = [{ id: 1, type: 'audio', handler: 'ogg', entry: this._other, codec: null, description: null,
                       timescale: 48000, durationUs: 0, sampleCount: null, bitrate: null, startUs: 0,
                       sampleRate: 0, numberOfChannels: 0, config: null }];
      return Infinity;
    }
    if (pg.serial !== this._serial) continue;
    // (A packet completed on a page that continues one starts on the page
    // it began on — one or more pages back: reading for it restarts there.
    // After a jump, the first packet of a continued page is dropped by
    // reader_ogg: nothing is pending for it, RFC 7845 §3.)
    var from = pg.type & 1 && this._openAt >= 0 ? this._openAt : at;
    var ns = page[26], ends = false;
    for (var q = 0; q < ns; q++) if (page[27 + q] < 255) { ends = true; break; }
    if (!(ns && page[26 + ns] === 255)) this._openAt = -1;           // no packet left open
    else if (ends || !(pg.type & 1)) this._openAt = at;            // one begins here
    // (else: a page all of one packet's middle — it began where it did)
    this._evs = [];
    this._r.feed(page);
    var evs = this._evs;
    if (!evs.length) continue;
    var durs = evs.map(function (f) { return Math.round(getOpusPacketDurationUs(f.payload) * 48 / 1000); });
    var eos = !!(pg.type & 4), sum = 0;
    for (var d = 0; d < durs.length; d++) sum += durs[d];
    var start;
    // (§4.5: an EOS page that is also the first, its granule under its
    // samples, starts at 0 — it was a negative start; the cases §4.5
    // calls invalid made reader_ogg throw above: an 'error'.)
    // (An EOS page's granule is the end after the end trim, §4.4: with no
    // page timed before it, its packets start where the tail said.)
    if (eos && this._next === null && at === this._eosAt && this._eosStart !== null) start = this._eosStart;
    else if (pg.granule !== NO_GRANULE && !(eos && this._next !== null)) start = eos && this._next === null && pg.granule < sum ? 0 : pg.granule - sum;
    else if (this._next !== null) start = this._next;
    else continue;                             // no time for these yet (cannot happen in a valid file)
    if (this.startUs === null) this.startUs = this.tracks[0].startUs = Math.max(0, Math.round(start * 1e6 / 48000));
    this._timed = true;
    var out = [];
    for (var k = 0; k < evs.length; k++) {
      var s0 = start, s1 = start + durs[k];
      if (eos && k === evs.length - 1 && pg.granule !== NO_GRANULE && pg.granule < s1 && pg.granule > s0) s1 = pg.granule;
      var pts = Math.round((s0 - this._preSkip) * 1e6 / 48000);
      out.push({
        trackId: 1, payload: evs[k].payload, isKeyframe: true,
        ptsUs: pts, dtsUs: pts, durationUs: Math.round((s1 - this._preSkip) * 1e6 / 48000) - pts,
        pos: k === 0 ? from : at,
      });
      start += durs[k];
    }
    this._next = start;
    // (Taken from this._pend itself: a jump from inside emit() — reset() —
    // empties it. The packets left were kept in a local list and put back
    // after it, so the rest of the page before the jump went out first at
    // the new position, indexed as read there.)
    this._pend = out;
    while (this._pend.length) {
      if (!emit(this._pend.shift())) return pos;
    }
  }
};

OggFormat.prototype._setup = function (oh) {
  var ch = oh ? oh.channels : 2;
  this.tracks = [{
    id: 1, type: 'audio', handler: 'ogg', entry: 'opus', codec: 'opus', description: this._head,
    timescale: 48000, durationUs: 0, sampleCount: null, bitrate: null, startUs: null,
    sampleRate: 48000, numberOfChannels: ch,
    config: { codec: 'opus', sampleRate: 48000, numberOfChannels: ch, description: this._head },
  }];
};

// The last page of the stream: its granule is where the audio ends. The
// tail's pages are read as packets too, for where the EOS page's start:
// the granule of the page before (the end of the packets before), and the
// one it completes first when that continues from there — reading from
// the EOS page itself drops that one (nothing pending for it).
OggFormat.prototype.parseTail = function (b, offset) {
  var r = new OggReader(), evs = [], prev = NO_GRANULE;
  r.on('audio', function (f) { evs.push(f); });
  for (var i = 0; i + 27 <= b.length; i++) {
    if (b[i] !== 0x4F || b[i + 1] !== 0x67 || b[i + 2] !== 0x67 || b[i + 3] !== 0x53) continue;
    var pg = _page(b, i);
    if (!pg) continue;
    if (pg.serial === this._serial) {
      if (pg.granule !== NO_GRANULE) this._lastGranule = pg.granule;
      evs = [];
      try { r.feed(b.subarray(i, i + pg.len)); } catch (e) { evs = null; }
      if (pg.type & 4) {
        var done = 0;
        for (var q = 0; q < pg.segs; q++) if (b[i + 27 + q] < 255) done++;
        this._eosAt = (offset || 0) + i;
        this._eosStart = prev === NO_GRANULE || !evs || evs.length !== done ? null
          : pg.type & 1 && evs.length ? prev + Math.round(getOpusPacketDurationUs(evs[0].payload) * 48 / 1000) : prev;
      } else if (pg.granule !== NO_GRANULE && evs && evs.length) prev = pg.granule;
    }
    i += pg.len - 1;
  }
  if (this._lastGranule !== NO_GRANULE) {
    this.durationUs = Math.max(0, Math.round((this._lastGranule - this._preSkip) * 1e6 / 48000));
    this.tracks[0].durationUs = this.durationUs;
  }
};

OggFormat.prototype.reset = function (pos) {
  this._newReader();
  this._next = null;
  this._openAt = -1;
  this._pend = [];
};

function _isTag(b, s) {
  if (b.length < s.length) return false;
  for (var i = 0; i < s.length; i++) if (b[i] !== s.charCodeAt(i)) return false;
  return true;
}

// The codec of a BOS page's first packet (RFC 3533 streams' usual magics).
function _streamName(b) {
  if (b.length >= 7 && b[0] === 1 && _isTag(b.subarray(1), 'vorbis')) return 'vorbis';
  if (b.length >= 5 && b[0] === 0x7F && _isTag(b.subarray(1), 'FLAC')) return 'flac';
  if (b.length >= 7 && b[0] === 0x80 && _isTag(b.subarray(1), 'theora')) return 'theora';
  if (_isTag(b, 'Speex')) return 'speex';
  return 'unknown';
}

function OggFileReader(opts) { FileStreamReader.call(this, new OggFormat(), opts); }
OggFileReader.prototype = Object.create(FileStreamReader.prototype);
OggFileReader.prototype.constructor = OggFileReader;

export default OggFileReader;
