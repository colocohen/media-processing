/**
 * ByteQueue — Internal byte buffer for streaming parsers.
 * push/peek/read/discard/search on a chunk list.
 */

function ByteQueue() {
  this.chunks = [];
  this.length = 0;
}

ByteQueue.prototype.push = function (buf) {
  if (buf && buf.length) {
    this.chunks.push(buf);
    this.length += buf.length;
  }
};

/**
 * Peek at the first n bytes without consuming. Always returns a copy.
 */
ByteQueue.prototype.peek = function (n) {
  if (n > this.length) return null;
  if (this.chunks.length === 1 && this.chunks[0].length >= n) {
    // Return a copy, not a view — caller may mutate
    var slice = Buffer.allocUnsafe(n);
    this.chunks[0].copy(slice, 0, 0, n);
    return slice;
  }
  var out = Buffer.allocUnsafe(n);
  var off = 0;
  for (var i = 0; i < this.chunks.length && off < n; i++) {
    var c = this.chunks[i];
    var take = Math.min(c.length, n - off);
    c.copy(out, off, 0, take);
    off += take;
  }
  return out;
};

/**
 * Read and consume n bytes.
 */
ByteQueue.prototype.read = function (n) {
  if (n > this.length) return null;
  var out = Buffer.allocUnsafe(n);
  var off = 0;
  while (off < n) {
    var head = this.chunks[0];
    var take = Math.min(head.length, n - off);
    head.copy(out, off, 0, take);
    off += take;
    if (take === head.length) {
      this.chunks.shift();
    } else {
      this.chunks[0] = head.subarray(take);
    }
  }
  this.length -= n;
  return out;
};

/**
 * Discard n bytes without returning them.
 */
ByteQueue.prototype.discard = function (n) {
  if (n > this.length) n = this.length;
  var remaining = n;
  while (remaining > 0 && this.chunks.length) {
    var head = this.chunks[0];
    if (remaining >= head.length) {
      remaining -= head.length;
      this.length -= head.length;
      this.chunks.shift();
    } else {
      this.chunks[0] = head.subarray(remaining);
      this.length -= remaining;
      remaining = 0;
    }
  }
};

/**
 * Read a single byte at logical offset without consuming.
 * O(chunks) but avoids full buffer copy.
 */
ByteQueue.prototype.byteAt = function (offset) {
  if (offset < 0 || offset >= this.length) return -1;
  var pos = 0;
  for (var i = 0; i < this.chunks.length; i++) {
    var c = this.chunks[i];
    if (offset < pos + c.length) {
      return c[offset - pos];
    }
    pos += c.length;
  }
  return -1;
};

/**
 * Collapse all chunks into a single contiguous buffer (in-place).
 * Call sparingly — use byteAt() for searches when possible.
 */
ByteQueue.prototype.compact = function () {
  if (this.chunks.length <= 1) return;
  var flat = Buffer.allocUnsafe(this.length);
  var off = 0;
  for (var i = 0; i < this.chunks.length; i++) {
    this.chunks[i].copy(flat, off);
    off += this.chunks[i].length;
  }
  this.chunks = [flat];
};

ByteQueue.prototype.reset = function () {
  this.chunks = [];
  this.length = 0;
};

export default ByteQueue;
