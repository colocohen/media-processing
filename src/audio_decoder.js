/**
 * AudioDecoder — WebCodecs-compatible audio decoder.
 * Outputs raw s16le PCM in 10ms chunks.
 */

import { initCoder, configureCoder, applyCoderPrototype } from './base_coder.js';
import { normalizeCodec } from './codec_strings.js';
import FrameQueue from './frame_queue.js';
import AudioData from './audio_data.js';
import { getDefaultContainer, getContainer, getContainerFormat } from './containers.js';

function AudioDecoder(init) {
  if (!init) throw new TypeError('AudioDecoder: init required');
  initCoder(this, init);
  this._frameIndex = 0;
  this._fq = null;
  this._bytesPerChunk = 0;

  this.context = {
    state: 'unconfigured',
    codec: null,
    sampleRate: 0,
    numberOfChannels: 0,
    frameCount: 0,
  };
}

applyCoderPrototype(AudioDecoder);

AudioDecoder.prototype.configure = function (config) {
  if (!config || !config.codec) throw new TypeError('AudioDecoder.configure: codec required');
  configureCoder(this);

  this._config = {
    codec: normalizeCodec(config.codec),
    sampleRate: config.sampleRate || 48000,
    numberOfChannels: config.numberOfChannels || 2,
    outputFormat: config.outputFormat || 's16',
    description: config.description || null,  // codec-specific init data (e.g. AudioSpecificConfig for AAC)
  };

  this._descriptionSent = false;

  this._frameIndex = 0;
  var bps = (this._config.outputFormat === 'f32' || this._config.outputFormat === 'f32-planar') ? 4 : 2;
  this._bytesPerChunk = Math.floor(this._config.sampleRate / 100) * this._config.numberOfChannels * bps;
  this._fq = null;

  this.context.state = 'configured';
  this.context.codec = this._config.codec;
  this.context.sampleRate = this._config.sampleRate;
  this.context.numberOfChannels = this._config.numberOfChannels;
  this.context.frameCount = 0;
};

AudioDecoder.prototype.decode = function (chunk) {
  if (this._state !== 'configured') {
    this._error(new Error('AudioDecoder: not configured'));
    return;
  }
  if (!chunk || !chunk.data || !chunk.data.length) {
    this._error(new Error('AudioDecoder.decode: chunk.data required'));
    return;
  }
  if (!this._ffmpeg.running) this._startFFmpeg();

  // Prepend description (AudioSpecificConfig) before first chunk if provided
  if (!this._descriptionSent && this._config.description && chunk.type === 'key') {
    var desc = this._config.description;
    var combined = Buffer.allocUnsafe(desc.length + chunk.data.length);
    desc.copy(combined, 0);
    chunk.data.copy(combined, desc.length);
    this._queueSize++;
    this._ffmpeg.write(combined);
    this._descriptionSent = true;
  } else {
    this._queueSize++;
    this._ffmpeg.write(chunk.data);
  }
};

AudioDecoder.prototype._startFFmpeg = function () {
  var self = this;
  var cfg = this._config;
  var containerName = getDefaultContainer(cfg.codec);
  var containerDef = getContainer(containerName);

  // Small probesize for audio — ADTS/OGG streams are typically only a few KB.
  // -fflags nobuffer forces FFmpeg to start decoding immediately.
  var args = [
    '-hide_banner', '-loglevel', 'error',
    '-fflags', 'nobuffer',
    '-probesize', '32768', '-analyzeduration', '100000',
  ];

  // Don't specify -f for input: FFmpeg auto-detects ADTS/OGG/MP3 from stream content.
  // Some FFmpeg builds lack specific demuxers (e.g. 'adts') but auto-detect works.
  // Output format: s16le (default) or f32le
  var outFmt = cfg.outputFormat || 's16';
  var ffOutFmt = (outFmt === 'f32' || outFmt === 'f32-planar') ? 'f32le' : 's16le';
  var bps = (outFmt === 'f32' || outFmt === 'f32-planar') ? 4 : 2;

  args.push('-i', 'pipe:0');
  args.push('-vn', '-f', ffOutFmt, '-ar', String(cfg.sampleRate), '-ac', String(cfg.numberOfChannels), 'pipe:1');

  self._ffmpeg.start(args, ['pipe', 'pipe', 'pipe']);

  var samplesPerChunk = self._bytesPerChunk / (cfg.numberOfChannels * bps);

  self._fq = new FrameQueue(self._bytesPerChunk, function (pcmBuf) {
    var durationUs = Math.round((samplesPerChunk * 1e6) / cfg.sampleRate);
    self._output(new AudioData({
      data: pcmBuf,
      format: outFmt,
      sampleRate: cfg.sampleRate,
      numberOfChannels: cfg.numberOfChannels,
      numberOfFrames: samplesPerChunk,
      timestamp: Math.round((self._frameIndex * 1e6 * samplesPerChunk) / cfg.sampleRate),
      duration: durationUs,
    }));
    self._frameIndex++;
    self.context.frameCount = self._frameIndex;
  });

  // Listen on stdout (pipe:1) for decoded PCM data
  self._ffmpeg.on('stdout', function (chunk) { self._fq.push(chunk); });
  self._ffmpeg.on('error', function (e) { self._error(e); });
};

AudioDecoder.isConfigSupported = function (config) {
  return Promise.resolve({ supported: !!getDefaultContainer(config.codec) });
};

export default AudioDecoder;
