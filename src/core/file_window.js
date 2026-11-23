/**
 * file_window — the bytes of a file a reader has been fed, by absolute
 * offset, for the readers that take a FILE piece by piece and may ask for
 * another part of it (reader_mp4, reader_webm).
 *
 * One contiguous region is kept: a feed right after it extends it, a feed
 * anywhere else (the caller answering a 'need') starts a new one. The
 * reader drops what it's done with (trim). Views handed out (subarray)
 * stay valid: the region is never written in place — extending and
 * trimming make new arrays.
 */

import { concat } from './bytes.js';

// How far past what was fed a wanted offset may be and still just be
// waited for (the caller is feeding in order and will get there), rather
// than asked for with a 'need'.
var SLACK = 512 * 1024;

function FileWindow() {
  this.buf = new Uint8Array(0);
  this.off = 0;        // the absolute offset of buf[0]
  this.fedEnd = 0;     // where the last feed ended (the next one in order starts here)
}

FileWindow.prototype.end = function () { return this.off + this.buf.length; };

/** Bytes fed at `offset` (null: right after the last feed). */
FileWindow.prototype.add = function (bytes, offset) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  if (offset == null) offset = this.fedEnd;
  var end = this.end();
  if (this.buf.length && offset >= this.off && offset <= end) {
    this.buf = concat([this.buf.subarray(0, offset - this.off), bytes]);
  } else {
    this.buf = bytes;
    this.off = offset;
  }
  this.fedEnd = offset + bytes.length;
};

/** Is [offset, offset+length) here? */
FileWindow.prototype.has = function (offset, length) {
  return offset >= this.off && offset + length <= this.end();
};

/** A view of [offset, offset+length) — has() first. */
FileWindow.prototype.view = function (offset, length) {
  return this.buf.subarray(offset - this.off, offset - this.off + length);
};

/** As much of [offset, offset+length) as is here (from offset on). */
FileWindow.prototype.peek = function (offset, length) {
  if (offset < this.off || offset >= this.end()) return new Uint8Array(0);
  return this.buf.subarray(offset - this.off, Math.min(this.end(), offset + length) - this.off);
};

/** Done with everything before `offset`. */
FileWindow.prototype.trim = function (offset) {
  if (offset <= this.off) return;
  if (offset >= this.end()) { this.buf = new Uint8Array(0); this.off = offset; return; }
  this.buf = this.buf.slice(offset - this.off);
  this.off = offset;
};

/**
 * Bytes at `offset` are wanted and aren't here: will feeding in order get
 * there (wait), or does the caller have to jump (true → emit 'need')?
 */
FileWindow.prototype.mustAsk = function (offset) {
  // fed already and dropped / never fed here — or too far ahead to just wait for
  return (offset < this.fedEnd && !this.has(offset, 1)) || offset > this.fedEnd + SLACK;
};

export default FileWindow;
