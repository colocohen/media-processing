/**
 * AudioEncoder — WebCodecs-compatible audio encoder.
 * Validates input data alignment.
 */

import { initCoder, configureCoder, wireReader, applyCoderPrototype } from './base_coder.js';
import { normalizeCodec } from './codec_strings.js';
import { EncodedAudioChunk } from './encoded_chunk.js';
import { getAudioCodec } from './codecs.js';
import { getDefaultContainer, getContainer, getContainerFormat, getContainerExtra } from './containers.js';

function AudioEncoder(init) {
  if (!init) throw new TypeError('AudioEncoder: init required');
  initCoder(this, init);
  this._encodeCount = 0;

  this.context = {
    state: 'unconfigured',
    codec: null,
    sampleRate: 0,
    numberOfChannels: 0,
    frameCount: 0,
  };
}

applyCoderPrototype(AudioEncoder);

AudioEncoder.prototype.configure = function (config) {
  if (!config || !config.codec) throw new TypeError('AudioEncoder.configure: codec required');
  configureCoder(this);

  this._config = {
    codec: normalizeCodec(config.codec),
    sampleRate: config.sampleRate || 48000,
    numberOfChannels: config.numberOfChannels || 2,
    bitrate: config.bitrate || 0,
    bitrateMode: config.bitrateMode || 'variable',  // 'constant','variable'
    codecOptions: config.codecOptions || null,
  };

  this._encodeCount = 0;
  this.context.state = 'configured';
  this.context.codec = this._config.codec;
  this.context.sampleRate = this._config.sampleRate;
  this.context.numberOfChannels = this._config.numberOfChannels;
  this.context.frameCount = 0;
};

AudioEncoder.prototype.encode = function (audioData) {
  if (this._state !== 'configured') {
    this._error(new Error('AudioEncoder: not configured'));
    return;
  }
  if (!audioData || !audioData.data) {
    this._error(new Error('AudioEncoder.encode: audioData.data required'));
    return;
  }

  // Detect format: s16 = 2 bytes/sample, f32 = 4 bytes/sample
  var fmt = audioData.format || this._inputFormat || 's16';
  var bps = (fmt === 'f32' || fmt === 'f32-planar') ? 4 : 2;
  var align = this._config.numberOfChannels * bps;
  if (audioData.data.length % align !== 0) {
    this._error(new Error(
      'AudioEncoder.encode: data length ' + audioData.data.length +
      ' not aligned to ' + align + ' bytes'
    ));
    return;
  }

  // Remember input format for FFmpeg startup
  if (!this._inputFormat) this._inputFormat = fmt;

  if (!this._ffmpeg.running) this._startFFmpeg();

  this._queueSize++;
  var ok = this._ffmpeg.write(audioData.data);
  this._encodeCount++;
  this.context.frameCount = this._encodeCount;
  return ok;
};

AudioEncoder.prototype._startFFmpeg = function () {
  var self = this;
  var cfg = this._config;

  var codecDef = getAudioCodec(cfg.codec, cfg);
  if (!codecDef) { self._error(new Error('Unknown codec: ' + cfg.codec)); return; }

  var containerName = getDefaultContainer(cfg.codec);
  var containerDef = getContainer(containerName);

  // No -fflags nobuffer / -flags low_delay for audio — breaks AAC
  var args = ['-loglevel', 'warning'];

  // Input format: s16le (default) or f32le
  var ffFmt = (self._inputFormat === 'f32' || self._inputFormat === 'f32-planar') ? 'f32le' : 's16le';
  args.push('-f', ffFmt, '-ar', String(cfg.sampleRate), '-ac', String(cfg.numberOfChannels), '-i', 'pipe:0');
  Array.prototype.push.apply(args, codecDef.args);

  if (cfg.codecOptions && cfg.codecOptions.length) {
    Array.prototype.push.apply(args, cfg.codecOptions);
  }

  if (containerDef) {
    args.push('-f', getContainerFormat(containerDef, cfg.codec));
    Array.prototype.push.apply(args, getContainerExtra(containerDef, cfg.codec));
  }
  args.push('pipe:3');

  self._ffmpeg.start(args, ['pipe', 'ignore', 'pipe', 'pipe']);

  if (containerDef && containerDef.createReader) {
    var reader = containerDef.createReader({ sampleRate: cfg.sampleRate });
    wireReader(self, reader, {
      audio: function (f) {
        self._output(new EncodedAudioChunk({
          type: 'key', timestamp: f.ptsUs, duration: f.durationUs, data: f.payload,
        }));
      },
    });
  } else {
    // No reader — emit raw encoded data chunks directly
    var chunkIdx = 0;
    self._ffmpeg.on('data', function (chunk) {
      var ptsUs = Math.round(chunkIdx * 1024 * 1e6 / (cfg.sampleRate || 48000));
      var durUs = Math.round(1024 * 1e6 / (cfg.sampleRate || 48000));
      self._output(new EncodedAudioChunk({
        type: 'key', timestamp: ptsUs, duration: durUs, data: chunk,
      }));
      chunkIdx++;
    });
    self._ffmpeg.on('error', function (e) { self._error(e); });
  }
};

AudioEncoder.isConfigSupported = function (config) {
  return Promise.resolve({ supported: !!getAudioCodec(config.codec, config) });
};

export default AudioEncoder;
