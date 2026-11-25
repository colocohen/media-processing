/**
 * reader_wav — WAV (RIFF / WAVE, and RF64 / BW64 for files over 4 GB): a
 * FILE fed in pieces → its PCM in chunks of whole sample frames, PCM_BLOCK
 * (1024) frames each (the last one shorter) — what demuxer.js has always
 * cut PCM into. The API and events are reader_mp4's (see
 * reader_file_stream.js).
 *
 * fmt: WAVE_FORMAT_PCM (1) 8-bit (unsigned) / 16 / 24 / 32-bit, IEEE float
 * (3) 32-bit, A-law (6), µ-law (7), and WAVE_FORMAT_EXTENSIBLE (0xFFFE:
 * the same, by the SubFormat GUID — a format tag in the KSDATAFORMAT
 * base GUID, or the Ambisonic B-Format one; any other GUID is a format
 * with no WebCodecs name). The sample size is
 * the container's (block_align / channels: 24 valid bits in 32 are
 * 'pcm-s32'). WebCodecs names: 'pcm-u8', 'pcm-s16', 'pcm-s24', 'pcm-s32',
 * 'pcm-f32', 'alaw', 'ulaw'; anything else (64-bit float, ADPCM, …) is a
 * track with codec null.
 *
 * RF64 (EBU Tech 3306): the 'ds64' chunk's 64-bit data size replaces the
 * 0xFFFFFFFF in the RIFF / data headers. A data size of 0 or past the end
 * of the file (a recording that never finished its header): to the end.
 * Chunks before 'data' are skipped (asked past with a 'need' when large);
 * after it, nothing is read.
 *
 * seek: exact — the chunk holding the time is computed (fmt.locate).
 */

import FileStreamReader from './reader_file_stream.js';
import { readU16LE, readU32LE, toAscii } from './core/bytes.js';

var PCM_BLOCK = 1024;

function WavFormat() {
  this.name = 'WAVReader';
  this.container = 'wav';
  this.tracks = [];
  this.resync = true;
  this.dataStart = 0;
  this.durationUs = 0;
  this._st = 0;            // 0 RIFF header, 1 chunks, 2 data
  this._rf64 = false;
  this._ds64Data = 0;
  this._fmt = null;
  this._dataEnd = Infinity;
}

WavFormat.prototype.ready = function () { return this._st === 2; };

WavFormat.prototype.parse = function (win, pos, eof, emit) {
  if (this._st === 0) {
    if (!win.has(pos, 12)) { if (eof) throw _err('TRUNCATED', 'no RIFF header'); return pos; }
    var h = win.view(pos, 12), id = toAscii(h, 0, 4);
    if ((id !== 'RIFF' && id !== 'RF64' && id !== 'BW64') || toAscii(h, 8, 12) !== 'WAVE') throw _err('NOT_WAV', 'not a RIFF / WAVE file');
    this._rf64 = id !== 'RIFF';
    this._st = 1;
    return pos + 12;
  }
  if (this._st === 1) return this._chunk(win, pos, eof);
  return this._data(win, pos, eof, emit);
};

WavFormat.prototype._chunk = function (win, pos, eof) {
  if (!win.has(pos, 8)) { if (eof) throw _err('NO_DATA', 'no data chunk'); return pos; }
  var h = win.view(pos, 8), id = toAscii(h, 0, 4), size = readU32LE(h, 4);
  if (id === 'data') {
    if (!this._fmt) throw _err('NO_FMT', 'a data chunk before the fmt chunk');
    this.dataStart = pos + 8;
    if (this._rf64 && size === 0xFFFFFFFF) size = this._ds64Data;
    this._dataEnd = size ? this.dataStart + size : Infinity;
    if (this.fileSize && this._dataEnd > this.fileSize) this._dataEnd = this.fileSize;
    this._st = 2;
    this._setup(win);
    return this.dataStart;
  }
  if (id === 'fmt ' || id === 'ds64') {
    if (!win.has(pos + 8, size)) { if (eof) throw _err('TRUNCATED', 'cut-off ' + id + ' chunk'); return pos; }
    var b = win.view(pos + 8, size);
    if (id === 'ds64') { if (size >= 16) this._ds64Data = _u64(b, 8); }
    else this._fmt = _parseFmt(b);
  }
  return pos + 8 + size + (size & 1);
};

WavFormat.prototype._setup = function (win) {
  var f = this._fmt, sr = f.sampleRate;
  this._ba = f.blockAlign;
  this._sr = sr;
  var size = win && this._dataEnd !== Infinity ? this._dataEnd - this.dataStart : 0;
  var frames = size ? Math.floor(size / f.blockAlign) : 0;
  this.durationUs = sr ? Math.round(frames * 1e6 / sr) : 0;  // 0: to the end, size unknown
  var t = {
    id: 1, type: 'audio', handler: 'wav', entry: f.name, codec: f.codec, description: null,
    timescale: sr, durationUs: this.durationUs, sampleCount: frames ? Math.ceil(frames / PCM_BLOCK) : null,
    bitrate: f.byteRate * 8, startUs: 0, sampleRate: sr, numberOfChannels: f.channels, config: null,
  };
  if (f.codec) t.config = { codec: f.codec, sampleRate: sr, numberOfChannels: f.channels };
  this.tracks = [t];
};

WavFormat.prototype._data = function (win, pos, eof, emit) {
  var ba = this._ba, block = PCM_BLOCK * ba, end = this._dataEnd;
  while (true) {
    if (pos >= end) return Infinity;                 // the data is all out: nothing after it is read
    var n = Math.min(block, end - pos), avail = win.has(pos, 1) ? win.end() - pos : 0;
    if (avail < n) {
      if (!eof) return pos;
      n = avail - avail % ba;                        // the file ends inside the data
      if (!n) return Infinity;
    }
    var f0 = (pos - this.dataStart) / ba, f1 = f0 + n / ba;
    var pts = Math.round(f0 * 1e6 / this._sr);
    var go = emit({
      trackId: 1, payload: win.view(pos, n), isKeyframe: true,
      ptsUs: pts, dtsUs: pts, durationUs: Math.round(f1 * 1e6 / this._sr) - pts, pos: pos,
    });
    pos += n;
    if (!go) return pos;
  }
};

WavFormat.prototype.reset = function (pos) { this._pos = pos; };

WavFormat.prototype.locate = function (timeUs) {
  if (this._st !== 2 || !this._sr) return null;
  var frame = Math.max(0, Math.floor(timeUs * this._sr / 1e6));
  var b = Math.floor(frame / PCM_BLOCK);
  var pos = this.dataStart + b * PCM_BLOCK * this._ba;
  if (pos >= this._dataEnd) return null;
  return { pos: pos, ptsUs: Math.round(b * PCM_BLOCK * 1e6 / this._sr), state: null, exact: true };
};

// WAVEFORMATEX (+ WAVEFORMATEXTENSIBLE): what's needed, and the WebCodecs name.
function _parseFmt(b) {
  if (b.length < 16) throw _err('BAD_FMT', 'fmt chunk too short');
  var tag = readU16LE(b, 0), channels = readU16LE(b, 2), sr = readU32LE(b, 4);
  var byteRate = readU32LE(b, 8), blockAlign = readU16LE(b, 12), bits = readU16LE(b, 14);
  // WAVE_FORMAT_EXTENSIBLE: the SubFormat GUID is a format tag (its first
  // four bytes, little-endian) only in the KSDATAFORMAT_SUBTYPE base
  // GUID xxxxxxxx-0000-0010-8000-00AA00389B71 (Microsoft's mmreg.h) or the
  // Ambisonic B-Format one xxxxxxxx-0721-11D3-8644-C8C1CA000000; its first
  // two bytes alone were taken, so any GUID starting 01 00 read as PCM
  // (ffprobe: codec unknown). Another GUID: no tag known (codec null).
  if (tag === 0xFFFE && b.length >= 40) tag = _guidTag(b, 24);
  if (!channels || !blockAlign) throw _err('BAD_FMT', 'no channels / block_align');
  // A sample rate of 0 has no time: it was read, and every chunk was
  // timed NaN, then Infinity (0 / 0, n / 0). FFmpeg's ff_get_wav_header
  // refuses it too ("Invalid sample rate").
  if (!sr) throw _err('BAD_FMT', 'sample rate 0');
  var bytes = blockAlign / channels, codec = null, name = tag < 0 ? 'wav-guid' : 'wav-0x' + tag.toString(16);
  if (bytes === Math.floor(bytes)) {
    if (tag === 1) {
      codec = { 1: 'pcm-u8', 2: 'pcm-s16', 3: 'pcm-s24', 4: 'pcm-s32' }[bytes] || null;
      name = bytes === 1 ? 'pcm_u8' : 'pcm_s' + bytes * 8 + 'le';
    } else if (tag === 3) {
      codec = bytes === 4 ? 'pcm-f32' : null;
      name = 'pcm_f' + bytes * 8 + 'le';
    } else if (tag === 6 && bytes === 1) { codec = 'alaw'; name = 'pcm_alaw'; }
    else if (tag === 7 && bytes === 1) { codec = 'ulaw'; name = 'pcm_mulaw'; }
  }
  return { tag: tag, channels: channels, sampleRate: sr, byteRate: byteRate, blockAlign: blockAlign, bits: bits, codec: codec, name: name };
}

var GUID_BASES = [
  [0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71],   // KSDATAFORMAT_SUBTYPE_*
  [0x21, 0x07, 0xD3, 0x11, 0x86, 0x44, 0xC8, 0xC1, 0xCA, 0x00, 0x00, 0x00],   // KSDATAFORMAT_SUBTYPE_AMBISONIC_B_FORMAT_*
];

// The format tag a SubFormat GUID at b[o..o+16) stands for, or -1.
function _guidTag(b, o) {
  for (var i = 0; i < GUID_BASES.length; i++) {
    var base = GUID_BASES[i], k = 0;
    while (k < 12 && b[o + 4 + k] === base[k]) k++;
    if (k === 12) return readU32LE(b, o);
  }
  return -1;
}

function _u64(b, o) { return readU32LE(b, o + 4) * 4294967296 + readU32LE(b, o); }

function _err(code, msg) { var e = new Error(msg); e.code = code; return e; }

function WAVReader(opts) { FileStreamReader.call(this, new WavFormat(), opts); }
WAVReader.prototype = Object.create(FileStreamReader.prototype);
WAVReader.prototype.constructor = WAVReader;

export default WAVReader;
