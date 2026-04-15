/**
 * AudioData — Raw audio data class.
 * Mirrors the browser AudioData API (subset).
 *
 * @param {object} init
 * @param {Buffer} init.data           — Raw PCM data
 * @param {string} init.format         — Sample format: 's16' (s16le), 'f32' (f32le)
 * @param {number} init.sampleRate     — Sample rate in Hz (e.g. 48000)
 * @param {number} init.numberOfChannels — Channel count (e.g. 1, 2)
 * @param {number} init.numberOfFrames — Number of audio frames (samples per channel)
 * @param {number} init.timestamp      — Presentation timestamp in microseconds
 * @param {number} [init.duration]     — Duration in microseconds
 */
function AudioData(init) {
  if (!init) throw new TypeError('AudioData: init required');
  if (!Buffer.isBuffer(init.data) && !(init.data instanceof Uint8Array)) {
    throw new TypeError('AudioData: data must be Buffer or Uint8Array');
  }

  this.data = init.data;
  this.format = init.format || 's16';
  this.sampleRate = init.sampleRate || 48000;
  this.numberOfChannels = init.numberOfChannels || 1;
  this.timestamp = init.timestamp || 0;
  this.duration = init.duration || 0;

  // Compute numberOfFrames if not given
  var bytesPerSample = (this.format === 'f32') ? 4 : 2;
  this.numberOfFrames = init.numberOfFrames || (this.data.length / (this.numberOfChannels * bytesPerSample));

  this.byteLength = this.data.length;
  this._closed = false;
}

AudioData.prototype.allocationSize = function (options) {
  var fmt = (options && options.format) || this.format;
  var bps = (fmt === 'f32' || fmt === 'f32-planar') ? 4 : 2;
  return this.numberOfFrames * this.numberOfChannels * bps;
};

AudioData.prototype.copyTo = function (destination, options) {
  if (this._closed) return Promise.reject(new Error('AudioData is closed'));
  if (this.data) this.data.copy(destination, 0, 0, this.data.length);
  return Promise.resolve();
};

AudioData.prototype.clone = function () {
  if (this._closed) throw new DOMException('AudioData is closed', 'InvalidStateError');
  var copy = Buffer.allocUnsafe(this.data.length);
  this.data.copy(copy);
  return new AudioData({
    data: copy,
    format: this.format,
    sampleRate: this.sampleRate,
    numberOfChannels: this.numberOfChannels,
    numberOfFrames: this.numberOfFrames,
    timestamp: this.timestamp,
    duration: this.duration,
  });
};

AudioData.prototype.close = function () {
  this._closed = true;
  this.data = null;
  this.byteLength = 0;
};

export default AudioData;
