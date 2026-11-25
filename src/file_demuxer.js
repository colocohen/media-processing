/**
 * FileDemuxer — a media FILE fed in pieces → its samples, whatever the
 * container: it looks at the first bytes and reads it with the reader for
 * it. The API is theirs:
 *
 *   var d = new FileDemuxer({ size: fileSize });     // size: optional
 *   d.on('info',  function (info) { … });            // info.container: see below
 *   d.on('video', function (s) { … });               // { trackId, payload, isKeyframe, ptsUs, dtsUs, durationUs }
 *   d.on('audio', function (s) { … });
 *   d.on('need',  function (n) { … });               // { offset, length }: feed from there
 *   d.on('end',   function () { … });
 *   d.on('error', function (err) { … });             // err.code — 'UNSUPPORTED_CONTAINER': none of them
 *   d.feed(bytes, offset);                           // offset: default — right after the last feed
 *   d.end();                                         // no more bytes
 *   d.select(ids); d.seek(timeUs); d.progress();
 *
 * Feed in order from 0; when a 'need' comes, feed from its offset on.
 * See reader_mp4.js for what the events carry.
 *
 * The containers (info.container), as told by the first bytes — after
 * any ID3v2 tags (a 'need' past one that's bigger than what was fed):
 *   'mp4' | 'mov'      ISO BMFF box type at 4..8                       reader_mp4
 *   'webm' | 'matroska' EBML magic 1A 45 DF A3                         reader_webm
 *   'mpegts'           0x47 at 5 packets in a row, 188 or 192 apart    reader_ts_file
 *   'flv'              'FLV' 01                                        reader_flv_file
 *   'ivf'              'DKIF'                                          reader_ivf_file
 *   'ogg'              'OggS'                                          reader_ogg_file
 *   'flac'             'fLaC'                                          reader_flac
 *   'wav'              'RIFF' / 'RF64' / 'BW64' … 'WAVE'               reader_wav
 *   'aac'              ADTS: three frame headers in a row              reader_adts_file
 *   'mp3'              MPEG audio: three frame headers in a row        reader_mp3
 *   'annexb'           a start code and an H.264 / H.265 NAL header    reader_annexb_file
 *                      (opts.fps: its frame rate, default 25)
 */

import EventEmitter from './core/events.js';
import MP4Reader from './reader_mp4.js';
import WebMReader from './reader_webm.js';
import TSFileReader from './reader_ts_file.js';
import ADTSFileReader from './reader_adts_file.js';
import OggFileReader from './reader_ogg_file.js';
import IVFFileReader from './reader_ivf_file.js';
import FLVFileReader from './reader_flv_file.js';
import AnnexBFileReader, { sniffAnnexB } from './reader_annexb_file.js';
import MP3Reader from './reader_mp3.js';
import FLACReader from './reader_flac.js';
import WAVReader from './reader_wav.js';
import { toAscii, readU32BE, concat } from './core/bytes.js';
import { parseMpaHeader, sameStream, id3v2Size } from './utils/mpeg_audio.js';
import { parseAdtsHeader, adtsHeaderLength } from './utils/aac_utils.js';

var EVENTS = ['info', 'video', 'audio', 'need', 'end', 'error'];
var SNIFF = 8192;          // bytes looked at, at most, before deciding

var READERS = {
  mp4: MP4Reader, webm: WebMReader, mpegts: TSFileReader, flv: FLVFileReader, ivf: IVFFileReader,
  ogg: OggFileReader, flac: FLACReader, wav: WAVReader, aac: ADTSFileReader, mp3: MP3Reader, annexb: AnnexBFileReader,
};

// What an ISO BMFF file starts with (a top-level box type).
var BMFF_FIRST = ['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot', 'moof', 'styp', 'uuid', 'sidx'];

/**
 * The container from a file's first bytes (`head`; `ended`: that's all of
 * the file): { kind, codec? } | { id3: tag size } | 'more' (can't tell
 * yet) | null (none known).
 */
function _sniff(head, ended) {
  var n = head.length;
  if (n < 4) return ended ? null : 'more';
  if (readU32BE(head, 0) === 0x1A45DFA3) return { kind: 'webm' };
  var m4 = toAscii(head, 0, 4);
  if (m4 === 'DKIF') return { kind: 'ivf' };
  if (m4 === 'OggS') return { kind: 'ogg' };
  if (m4 === 'fLaC') return { kind: 'flac' };
  if (m4.slice(0, 3) === 'FLV' && head[3] === 1) return { kind: 'flv' };
  if (n < 12 && !ended) return 'more';
  if (n >= 8 && BMFF_FIRST.indexOf(toAscii(head, 4, 8)) !== -1) return { kind: 'mp4' };
  if (n >= 12 && (m4 === 'RIFF' || m4 === 'RF64' || m4 === 'BW64') && toAscii(head, 8, 12) === 'WAVE') return { kind: 'wav' };
  if (m4.slice(0, 3) === 'ID3') {
    var sz = id3v2Size(head, 0);
    if (sz) return { id3: sz };
  }
  // The rest have no magic: TS packets, audio frame headers, NAL units.
  var ts = _sniffTs(head, ended), au = _sniffAudio(head, ended), ab = null;
  if (head[0] === 0 && head[1] === 0 && (head[2] === 1 || (head[2] === 0 && head[3] === 1))) {
    ab = n < 8 && !ended ? 'more' : sniffAnnexB(head);
    ab = ab && ab !== 'more' ? { kind: 'annexb', codec: ab } : ab;
  }
  var all = [ts, au, ab];
  for (var i = 0; i < 3; i++) if (all[i] && all[i] !== 'more') return all[i];
  return !ended && all.indexOf('more') !== -1 && n < SNIFF ? 'more' : null;
}

// 0x47 every 188 (or 192) bytes, 5 times, starting in the first packet.
function _sniffTs(h, ended) {
  var strides = [188, 192];
  for (var i = 0; i < 192 && i < h.length; i++) {
    if (h[i] !== 0x47) continue;
    for (var s = 0; s < 2; s++) {
      var st = strides[s], k = 1;
      while (k < 5 && i + k * st < h.length && h[i + k * st] === 0x47) k++;
      if (k === 5) return { kind: 'mpegts' };
      if (i + k * st >= h.length) return ended && k >= 2 ? { kind: 'mpegts' } : 'more';
    }
  }
  return null;
}

// ADTS or MPEG audio: three consecutive frame headers of one stream at the
// start (two when that's the whole file).
function _sniffAudio(h, ended) {
  if (h[0] !== 0xFF || (h[1] & 0xE0) !== 0xE0) return null;
  if (adtsHeaderLength(h)) {
    var p = 0, k = 0;
    while (k < 3) {
      if (p + 7 > h.length) return ended && k >= 2 ? { kind: 'aac' } : ended ? null : 'more';
      var a = adtsHeaderLength(h.subarray(p)) ? parseAdtsHeader(h.subarray(p, p + 9)) : null;
      if (!a || !a.sampleRate || a.frameLength < 7) return null;
      p += a.frameLength; k++;
    }
    return { kind: 'aac' };
  }
  var h0 = parseMpaHeader(h, 0);
  if (!h0) return null;
  var q = 0, j = 0;
  while (j < 3) {
    if (q + 4 > h.length) return ended && j >= 2 ? { kind: 'mp3' } : ended ? null : 'more';
    var m = parseMpaHeader(h, q);
    if (!m || !sameStream(m, h0)) {
      // the first frame may be a Xing / Info frame with other fixed bits
      if (j === 1 && m && m.layer === h0.layer && m.sampleRate === h0.sampleRate) { h0 = m; }
      else return null;
    }
    q += m.frameLength; j++;
  }
  return { kind: 'mp3' };
}

function FileDemuxer(opts) {
  this._opts = opts || {};
  this._ee = new EventEmitter();
  this._inner = null;
  this._sniffAt = 0;                // where the bytes being looked at start (after ID3v2 tags)
  this._head = new Uint8Array(0);   // those bytes, until there are enough to tell
  this._held = [];                  // feeds before that: [bytes, offset]
  this._fedEnd = 0;
  this._replay = null;              // feeds still to give the reader (while replaying)
  this._failed = false;
}

FileDemuxer.prototype.on  = function (ev, fn) { this._ee.on(ev, fn); return this; };
FileDemuxer.prototype.off = function (ev, fn) { this._ee.off(ev, fn); return this; };

FileDemuxer.prototype.feed = function (bytes, offset) {
  if (this._failed) return;
  if (this._inner) return this._inner.feed(bytes, offset);
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  if (offset == null) offset = this._fedEnd;
  this._held.push([bytes, offset]);
  this._fedEnd = offset + bytes.length;
  var at = this._sniffAt + this._head.length;
  if (this._head.length < SNIFF && offset <= at && offset + bytes.length > at) {
    this._head = concat([this._head, bytes.subarray(at - offset, Math.min(bytes.length, at - offset + SNIFF - this._head.length))]);
  }
  this._try(false);
};

FileDemuxer.prototype.end = function () {
  if (this._failed) return;
  if (!this._inner) {
    this._try(true);
    if (!this._inner) { if (!this._failed) this._unsupported(); return; }
  }
  this._inner.end();
};

FileDemuxer.prototype._try = function (ended) {
  while (!this._inner && !this._failed) {
    var r = _sniff(this._head, ended);
    if (r === 'more') return;
    if (!r) { this._unsupported(); return; }
    if (r.id3) {
      // what follows the tag says what this is
      var past = this._sniffAt + r.id3;
      var here = this._head.length > r.id3;
      this._head = here ? this._head.subarray(r.id3) : new Uint8Array(0);
      this._sniffAt = past;
      if (!here) {
        // look for it among what was fed already; else ask for it
        for (var i = 0; i < this._held.length; i++) {
          var hb = this._held[i][0], ho = this._held[i][1];
          if (ho <= past && ho + hb.length > past) { this._head = hb.slice(past - ho, past - ho + SNIFF); break; }
        }
        if (!this._head.length) { this._ee.emit('need', { offset: past, length: 0 }); return; }
      }
      continue;
    }
    this._open(r);
  }
};

FileDemuxer.prototype._open = function (r) {
  var o = {};
  for (var k in this._opts) o[k] = this._opts[k];
  if (r.codec && !o.codec) o.codec = r.codec;
  var inner = this._inner = new READERS[r.kind](o);
  var ee = this._ee, self = this;
  EVENTS.forEach(function (ev) {
    inner.on(ev, function (x) {
      // While what was fed is given to the reader: a 'need' for bytes
      // still to come from it isn't one.
      if (ev === 'need' && self._replay && self._replay.some(function (f) { return x.offset >= f[1] && x.offset < f[1] + f[0].length; })) return;
      ee.emit(ev, x);
    });
  });
  var held = this._held;
  this._held = [];
  this._replay = held.slice();
  for (var i = 0; i < held.length && !this._failed; i++) {
    this._replay.shift();
    inner.feed(held[i][0], held[i][1]);
  }
  this._replay = null;
};

FileDemuxer.prototype._unsupported = function () {
  this._failed = true;
  var e = new Error('FileDemuxer: not a media file it knows (MP4 / MOV / WebM / MKV / TS / FLV / IVF / Ogg / FLAC / WAV / AAC / MP3 / H.264 / H.265)');
  e.code = 'UNSUPPORTED_CONTAINER';
  this._ee.emit('error', e);
};

['select', 'seek'].forEach(function (m) {
  FileDemuxer.prototype[m] = function () {
    if (!this._inner) throw new Error('FileDemuxer: ' + m + '() after info');
    return this._inner[m].apply(this._inner, arguments);
  };
});

FileDemuxer.prototype.progress = function () {
  return this._inner ? this._inner.progress() : 0;
};

export default FileDemuxer;
