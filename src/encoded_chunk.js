/**
 * EncodedVideoChunk / EncodedAudioChunk — Encoded media data classes.
 * Mirrors the browser WebCodecs API.
 *
 * @param {object} init
 * @param {string} init.type       — 'key' or 'delta'
 * @param {number} init.timestamp  — PTS in microseconds
 * @param {number} [init.duration] — Duration in microseconds
 * @param {Buffer} init.data       — Encoded payload
 * @param {object} [init.metadata] — Codec-specific metadata
 */

function _initChunk(name, self, init) {
  if (!init) throw new TypeError(name + ': init required');
  if (init.type !== 'key' && init.type !== 'delta') {
    throw new TypeError(name + ": type must be 'key' or 'delta'");
  }
  self.type = init.type;
  self.timestamp = init.timestamp || 0;
  self.duration = init.duration || 0;
  self.data = init.data || null;
  self.byteLength = self.data ? self.data.length : 0;
  self.metadata = init.metadata || null;
}

function _copyTo(self, destination) {
  if (self.data) self.data.copy(destination, 0, 0, self.data.length);
}

// ── EncodedVideoChunk ──

function EncodedVideoChunk(init) { _initChunk('EncodedVideoChunk', this, init); }
EncodedVideoChunk.prototype.copyTo = function (destination) { _copyTo(this, destination); };

// ── EncodedAudioChunk ──

function EncodedAudioChunk(init) { _initChunk('EncodedAudioChunk', this, init); }
EncodedAudioChunk.prototype.copyTo = function (destination) { _copyTo(this, destination); };

export { EncodedVideoChunk, EncodedAudioChunk };
