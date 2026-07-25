/**
 * byte_queue — Internal byte buffer for streaming parsers.
 * push/peek/read/discard/byteAt/compact on a chunk list.
 *
 * Isomorphic: all byte moves go through Uint8Array (.set / .subarray)
 * instead of Node's Buffer API. A Node Buffer is a Uint8Array subclass,
 * so callers may still push() Buffers — they just come back out as
 * plain Uint8Arrays. Safe in the browser bundle.
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
  var out = new Uint8Array(n);                       // was Buffer.allocUnsafe(n)
  if (this.chunks.length === 1) {
    // Single chunk fast path. set(subarray) still copies, so the
    // caller is free to mutate the result.
    out.set(this.chunks[0].subarray(0, n), 0);       // was chunks[0].copy(slice, 0, 0, n)
    return out;
  }
  var off = 0;
  for (var i = 0; i < this.chunks.length && off < n; i++) {
    var c = this.chunks[i];
    var take = Math.min(c.length, n - off);
    out.set(c.subarray(0, take), off);               // was c.copy(out, off, 0, take)
    off += take;
  }
  return out;
};

/**
 * Read and consume n bytes.
 */
ByteQueue.prototype.read = function (n) {
  if (n > this.length) return null;
  var out = new Uint8Array(n);                       // was Buffer.allocUnsafe(n)
  var off = 0;
  while (off < n) {
    var head = this.chunks[0];
    var take = Math.min(head.length, n - off);
    out.set(head.subarray(0, take), off);            // was head.copy(out, off, 0, take)
    off += take;
    if (take === head.length) {
      this.chunks.shift();
    } else {
      this.chunks[0] = head.subarray(take);          // .subarray works on both — unchanged
    }
  }
  this.length -= n;
  return out;
};

/**
 * Discard n bytes without returning them.
 * No Buffer-specific APIs — works unchanged on Uint8Array.
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
 * O(chunks) but avoids full buffer copy. Index access is identical
 * on Buffer and Uint8Array — unchanged.
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
  var flat = new Uint8Array(this.length);            // was Buffer.allocUnsafe(this.length)
  var off = 0;
  for (var i = 0; i < this.chunks.length; i++) {
    flat.set(this.chunks[i], off);                   // was chunks[i].copy(flat, off)
    off += this.chunks[i].length;
  }
  this.chunks = [flat];
};

ByteQueue.prototype.reset = function () {
  this.chunks = [];
  this.length = 0;
};

export default ByteQueue;
