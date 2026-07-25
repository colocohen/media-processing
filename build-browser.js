/**
 * build-browser.js — produces the single-file browser bundle.
 *
 * The browser entry is defined INLINE here (no index.browser.js file).
 * esbuild follows the import graph from this entry; because none of the
 * listed modules import Node built-ins (child_process / os / crypto /
 * module), the FFmpeg-backed coders, process managers, capture, and the
 * WebCodecs/MediaStream polyfills are never in the graph and never land
 * in the bundle — automatically.
 *
 * In the browser, HLSEncoder consumes the native global VideoEncoder /
 * AudioEncoder (WebCodecs); here we only ship the shared HLS + bitstream
 * + utility layers.
 *
 * Usage:  node build-browser.js
 * Output: dist/media-processing.browser.js  (ESM, minified)
 *
 * Note: the readers (reader_ts, reader_fmp4, ...) are themselves
 * browser-safe (pure Uint8Array parsing). They're omitted from this
 * entry because the current browser use case is HLS *writing*; add them
 * here when browser-side HLS *reading* is implemented.
 */

import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });

const BROWSER_ENTRY = `
  // ── HLS ──
  export { default as HLSEncoder } from './src/hls_encoder.js';
  export { default as Playlist, parseMediaPlaylist } from './src/playlist.js';
  export { buildMasterPlaylist, parseMasterPlaylist } from './src/master_playlist.js';
  export { default as SegmentBuilder } from './src/segment_builder.js';
  export { default as SubtitleEncoder } from './src/subtitle_encoder.js';
  export { default as CEA608Encoder, buildCea608SeiNalu } from './src/cea608_encoder.js';
  export { createEncryptor, ivFromSequence, ivFromHex, ivToHex } from './src/encryption.js';

  // ── Writers (muxers) ──
  export { default as TSWriter } from './src/writer_ts.js';
  export { default as FMP4Writer } from './src/writer_fmp4.js';
  export { default as OggWriter } from './src/writer_ogg.js';
  export { default as IVFWriter } from './src/writer_ivf.js';
  export { default as ADTSWriter } from './src/writer_adts.js';
  export { default as AnnexBWriter } from './src/writer_annexb.js';

  // ── Bitstream / codec utilities ──
  export {
    splitNALUs, extractParameterSets, avccToAnnexb, annexbToAvcc,
    nalusToAnnexb, detectFormat, injectSeiIntoAU,
    hasIDR, hasIDR_H264, hasIDR_H265, findAUD, findLastStartCode,
  } from './src/utils/nalu_utils.js';
  export {
    parseAdtsHeader, buildAdtsHeader, wrapAdts,
    getAdtsFrameDurationUs, sampleRateToIndex,
  } from './src/utils/aac_utils.js';
  export {
    parseCodecString, normalizeCodec, parseCodecDetails, buildCodecString,
  } from './src/utils/codec_strings.js';
  export { getOpusPacketDurationUs, parseOpusToc } from './src/utils/opus_utils.js';
  export {
    i420ToRgba, rgbaToI420, rgb24ToI420, i420ToRgb24, nv12ToI420, i420ToNv12,
  } from './src/pixel_utils.js';
  export {
    escapeQuoted, isValidVideoRange, isValidVariableName,
    isValidIvHex, isValidEncryptionMethod,
  } from './src/utils/playlist_utils.js';

  // ── Pure helpers (browser-safe) ──
  export { default as VideoColorSpace } from './src/video_color_space.js';
  export { default as FramePacer } from './src/frame_pacer.js';

  // ── Low-level primitives (for test harnesses / direct bitstream use) ──
  export {
    concat, equals, fromAscii, toAscii,
    readU16BE, readU24BE, readU32BE, readU64BE,
    readU16LE, readU32LE, readS16LE, readS32LE, readS32BE, readF32LE,
    writeU16BE, writeU24BE, writeU32BE, writeU64BE,
    writeU16LE, writeU32LE, writeF32LE,
  } from './src/core/bytes.js';
  export { default as EventEmitter } from './src/core/events.js';
`;

// UMD wrapper footer: esbuild emits `var MediaProcessing = (()=>{…})()`
// for iife+globalName (which is already the browser global). The footer
// adds CommonJS + AMD detection so the same file is truly universal —
// usable via <script> (global), require() (CJS), and define() (AMD).
// ESM is shipped as a SEPARATE file: `export`/`import` are static
// top-level forms and cannot live inside a UMD function wrapper.
const UMD_FOOTER =
  'if(typeof module==="object"&&typeof module.exports==="object")module.exports=MediaProcessing;' +
  'else if(typeof define==="function"&&define.amd)define([],function(){return MediaProcessing;});';

const TARGETS = [
  { format: 'esm',  outfile: 'dist/media-processing.esm.js',  extra: {} },
  { format: 'iife', outfile: 'dist/media-processing.umd.js',
    extra: { globalName: 'MediaProcessing', footer: { js: UMD_FOOTER } } },
];

for (const t of TARGETS) {
  const result = await build({
    stdin: {
      contents: BROWSER_ENTRY,
      resolveDir: '.',
      sourcefile: 'media-processing.browser.entry.js',
      loader: 'js',
    },
    bundle: true,
    format: t.format,
    platform: 'browser',
    target: ['es2020'],
    minify: true,
    outfile: t.outfile,
    // Hard guarantee: if anything in the graph tries to pull a Node
    // built-in, fail the build loudly instead of silently shipping it.
    external: [],
    metafile: true,
    ...t.extra,
  });

  // Post-build assertion: no Node built-ins resolved into the graph.
  const inputs = Object.keys(result.metafile.outputs[t.outfile].inputs);
  const nodeLeaks = inputs.filter((p) => /node:|child_process|[\\/]os[\\/]|gstreamer_process|ffmpeg_process/.test(p));
  if (nodeLeaks.length) {
    console.error('✗ Node-only modules leaked into ' + t.outfile + ':', nodeLeaks);
    process.exit(1);
  }
  console.log('✓ ' + t.format.toUpperCase().padEnd(4) + ' bundle written: ' + t.outfile +
              ' (' + inputs.length + ' modules, no Node leaks)');
}
