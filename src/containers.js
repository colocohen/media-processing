/**
 * containers — Maps codec → container format, FFmpeg format flag, and reader.
 */

import IVFReader from './reader_ivf.js';
import AnnexBReader from './reader_annexb.js';
import ADTSReader from './reader_adts.js';
import FMP4Reader from './reader_fmp4.js';
import TSReader from './reader_ts.js';
import OGGReader from './reader_ogg.js';

/**
 * Default codec → container mapping.
 */
var CODEC_CONTAINER_MAP = {
  vp8:  'ivf',
  vp9:  'ivf',
  av1:  'ivf',
  h264: 'annexb',
  h265: 'annexb',
  aac:  'adts',
  opus: 'ogg',
  mp3:  'mp3',
  flac: 'flac',
  vorbis: 'ogg',
  'g711-alaw': 'raw',
  'g711-ulaw': 'raw',
  alaw: 'raw',
  ulaw: 'raw',
  pcm:  'raw',
};

/**
 * Container definitions.
 */
var CONTAINERS = {
  ivf: {
    format: 'ivf',
    createReader: function (opts) {
      return new IVFReader();
    },
    extra: [],
  },
  annexb: {
    format: function (codec) {
      if (codec === 'h265') return 'hevc';
      return 'h264';
    },
    createReader: function (opts) {
      return new AnnexBReader({ codec: opts.codec || 'h264', fps: opts.fps || 30 });
    },
    extra: function (codec) {
      if (codec === 'h264') return ['-bsf:v', 'h264_mp4toannexb'];
      if (codec === 'h265') return ['-bsf:v', 'hevc_mp4toannexb'];
      return [];
    },
  },
  adts: {
    format: 'adts',
    createReader: function (opts) {
      return new ADTSReader({ sampleRate: opts.sampleRate || 48000 });
    },
    extra: [],
  },
  ogg: {
    format: 'ogg',
    createReader: function (opts) {
      return new OGGReader({ sampleRate: opts.sampleRate || 48000 });
    },
    extra: [],
  },
  mp3: {
    format: 'mp3',
    createReader: null,  // raw passthrough in audio_encoder
    extra: [],
  },
  flac: {
    format: 'flac',
    createReader: null,  // raw passthrough in audio_encoder
    extra: [],
  },
  raw: {
    format: function (codec) {
      if (codec === 'alaw' || codec === 'g711-alaw') return 'alaw';
      if (codec === 'ulaw' || codec === 'g711-ulaw') return 'mulaw';
      return 's16le';
    },
    createReader: null,  // raw passthrough — FrameQueue splits into chunks
    extra: [],
  },
  fmp4: {
    format: 'mp4',
    createReader: function () {
      return new FMP4Reader();
    },
    extra: ['-movflags', 'frag_keyframe+empty_moov+default_base_moof'],
  },
  ts: {
    format: 'mpegts',
    createReader: function (opts) {
      return new TSReader({ fps: opts.fps || 30, sampleRate: opts.sampleRate || 48000 });
    },
    extra: ['-mpegts_flags', 'resend_headers'],
  },
};

/**
 * Get the default container name for a codec.
 */
function getDefaultContainer(codec) {
  return CODEC_CONTAINER_MAP[String(codec).toLowerCase()] || null;
}

/**
 * Get a container definition by name.
 */
function getContainer(name) {
  return CONTAINERS[String(name).toLowerCase()] || null;
}

/**
 * Resolve the FFmpeg format string for a container.
 */
function getContainerFormat(containerDef, codec) {
  if (typeof containerDef.format === 'function') return containerDef.format(codec);
  return containerDef.format;
}

/**
 * Resolve extra FFmpeg args for a container.
 */
function getContainerExtra(containerDef, codec) {
  if (typeof containerDef.extra === 'function') return containerDef.extra(codec);
  return containerDef.extra || [];
}

export { getDefaultContainer, getContainer, getContainerFormat, getContainerExtra };
