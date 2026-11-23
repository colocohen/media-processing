/**
 * FileDemuxer — a media FILE fed in pieces → its samples, whatever the
 * container: it looks at the first bytes and reads it as MP4 / MOV / 3GP
 * / fMP4 (reader_mp4) or WebM / MKV (reader_webm). The API is theirs:
 *
 *   var d = new FileDemuxer({ size: fileSize });     // size: optional
 *   d.on('info',  function (info) { … });            // info.container: 'mp4'|'mov'|'webm'|'matroska'
 *   d.on('video', function (s) { … });               // { trackId, payload, isKeyframe, ptsUs, dtsUs, durationUs }
 *   d.on('audio', function (s) { … });
 *   d.on('need',  function (n) { … });               // { offset, length }: feed from there
 *   d.on('end',   function () { … });
 *   d.on('error', function (err) { … });             // err.code — 'UNSUPPORTED_CONTAINER': neither
 *   d.feed(bytes, offset);                           // offset: default — right after the last feed
 *   d.end();                                         // no more bytes
 *   d.select(ids); d.seek(timeUs); d.progress();
 *
 * Feed in order from 0; when a 'need' comes, feed from its offset on.
 * See reader_mp4.js for what the events carry.
 */

import EventEmitter from './core/events.js';
import MP4Reader from './reader_mp4.js';
import WebMReader from './reader_webm.js';
import { toAscii, readU32BE, concat } from './core/bytes.js';

var EVENTS = ['info', 'video', 'audio', 'need', 'end', 'error'];
var SNIFF = 12;

// What an ISO BMFF file starts with (a top-level box type).
var BMFF_FIRST = ['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot', 'moof', 'styp', 'uuid', 'sidx'];

// 'mp4' | 'webm' | null — from a file's first bytes.
function _sniff(head) {
  if (readU32BE(head, 0) === 0x1A45DFA3) return 'webm';
  if (BMFF_FIRST.indexOf(toAscii(head, 4, 8)) !== -1) return 'mp4';
  return null;
}

function FileDemuxer(opts) {
  this._opts = opts || {};
  this._ee = new EventEmitter();
  this._inner = null;
  this._head = new Uint8Array(0);   // the first bytes, until there are enough to tell
  this._held = [];                  // feeds before that
  this._failed = false;
}

FileDemuxer.prototype.on  = function (ev, fn) { this._ee.on(ev, fn); return this; };
FileDemuxer.prototype.off = function (ev, fn) { this._ee.off(ev, fn); return this; };

FileDemuxer.prototype.feed = function (bytes, offset) {
  if (this._failed) return;
  if (this._inner) return this._inner.feed(bytes, offset);
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  this._held.push([bytes, offset]);
  if ((offset == null || offset === this._head.length) && this._head.length < SNIFF) {
    this._head = concat([this._head, bytes.subarray(0, SNIFF - this._head.length)]);
  }
  if (this._head.length >= SNIFF) this._open();
};

FileDemuxer.prototype.end = function () {
  if (this._failed) return;
  if (!this._inner) {
    if (this._head.length >= 8) this._open();
    if (!this._inner) return this._unsupported();
  }
  this._inner.end();
};

FileDemuxer.prototype._open = function () {
  var kind = _sniff(this._head);
  if (!kind) return this._unsupported();
  var inner = this._inner = kind === 'webm' ? new WebMReader(this._opts) : new MP4Reader(this._opts);
  var ee = this._ee;
  EVENTS.forEach(function (ev) { inner.on(ev, function (x) { ee.emit(ev, x); }); });
  var held = this._held;
  this._held = [];
  for (var i = 0; i < held.length; i++) inner.feed(held[i][0], held[i][1]);
};

FileDemuxer.prototype._unsupported = function () {
  this._failed = true;
  var e = new Error('FileDemuxer: not an MP4 / MOV / WebM / MKV file');
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
