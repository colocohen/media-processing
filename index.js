/**
 * media-processing — Node entry point.
 *
 * Exports the full public API. In Node, the WebCodecs codec/data
 * classes are this library's own FFmpeg-backed polyfills; in the
 * browser bundle (see build-browser.js) those are dropped and the
 * native WebCodecs globals are used instead, while the shared HLS +
 * bitstream layers come from the same source files.
 *
 * Collision notes:
 *  - extractParameterSets: only the nalu_utils form (structured
 *    {sps,pps,vps}) is exported here. reader_annexb's concatenated
 *    form stays internal to the Demuxer path.
 *  - MediaDeviceInfo / InputDeviceInfo: exported from media_stream
 *    (get_user_media re-exports them internally; not re-exported here).
 *  - OGGReader is surfaced as `OggReader` for casing symmetry with
 *    OggWriter.
 *
 * Raw primitives (bytes, events, byte_queue, frame_queue,
 * buffer_source, dom_exception) are intentionally internal — add
 * explicit exports here if a consumer needs them.
 */

// ── WebCodecs: codec & data classes ──
export { default as VideoEncoder } from './src/video_encoder.js';
export { default as VideoDecoder } from './src/video_decoder.js';
export { default as AudioEncoder } from './src/audio_encoder.js';
export { default as AudioDecoder } from './src/audio_decoder.js';
export { default as VideoFrame } from './src/video_frame.js';
export { default as AudioData } from './src/audio_data.js';
export { EncodedVideoChunk, EncodedAudioChunk } from './src/encoded_chunk.js';
export { default as VideoColorSpace } from './src/video_color_space.js';
export { default as ImageDecoder } from './src/image_decoder.js';
export { default as mediaCapabilities } from './src/media_capabilities.js';

// Node convenience: register all WebCodecs classes on globalThis so
// browser-style code (reading the global names) runs unchanged under Node.
// Node-only by design — the browser already provides these globals natively.
export { default as installWebCodecsPolyfill } from './src/install_polyfill.js';

// ── MediaStream & capture ──
export {
  MediaStream, MediaStreamTrack, MediaDeviceInfo, InputDeviceInfo,
} from './src/media_stream.js';
export {
  MediaStreamTrackProcessor, MediaStreamTrackGenerator,
} from './src/track_processor.js';
export { default as MediaRecorder } from './src/media_recorder.js';
export {
  default as getUserMedia, enumerateDevices, getDisplayMedia,
} from './src/get_user_media.js';
export {
  VideoSource, AudioSource, VideoSink, AudioSink,
} from './src/media_source_sink.js';

// ── HLS ──
export { default as HLSEncoder } from './src/hls_encoder.js';
export { default as Playlist, parseMediaPlaylist } from './src/playlist.js';
export { buildMasterPlaylist, parseMasterPlaylist } from './src/master_playlist.js';
export { default as SegmentBuilder } from './src/segment_builder.js';
export { default as SubtitleEncoder } from './src/subtitle_encoder.js';
export { default as CEA608Encoder, buildCea608SeiNalu } from './src/cea608_encoder.js';
export {
  createEncryptor, ivFromSequence, ivFromHex, ivToHex,
} from './src/encryption.js';

// ── Writers (muxers) ──
export { default as TSWriter } from './src/writer_ts.js';
export { default as FMP4Writer } from './src/writer_fmp4.js';
export { default as OggWriter } from './src/writer_ogg.js';
export { default as IVFWriter } from './src/writer_ivf.js';
export { default as ADTSWriter } from './src/writer_adts.js';
export { default as AnnexBWriter } from './src/writer_annexb.js';

// ── Readers (demuxers) ──
export { default as TSReader } from './src/reader_ts.js';
export { default as FMP4Reader } from './src/reader_fmp4.js';
export { default as OggReader } from './src/reader_ogg.js';
export { default as IVFReader, splitOBUs, extractSequenceHeader } from './src/reader_ivf.js';
export { default as ADTSReader } from './src/reader_adts.js';
export { default as AnnexBReader } from './src/reader_annexb.js';

// ── High-level Node ──
export { default as Demuxer } from './src/demuxer.js';
export { default as Muxer } from './src/muxer.js';
export { default as MediaEncoder } from './src/media_encoder.js';
export { default as FFmpegProcess, checkFFmpeg, resolveFFmpegPath } from './src/ffmpeg_process.js';
export { default as GStreamerProcess } from './src/gstreamer_process.js';
export { default as VideoPlayer } from './src/video_player.js';
export { startFfplayViewer } from './src/ffplay_viewer.js';
export { default as FramePacer } from './src/frame_pacer.js';

// ── Utilities (pure, shared, browser-safe) ──
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

// ── Low-level primitives ──
// Intentionally internal by default, but surfaced for consumers that
// build directly on the bitstream layer (e.g. browser test harnesses
// that exercise byte/NALU/ADTS helpers directly).
export {
  concat, equals, fromAscii, toAscii,
  readU16BE, readU24BE, readU32BE, readU64BE,
  readU16LE, readU32LE, readS16LE, readS32LE, readS32BE, readF32LE,
  writeU16BE, writeU24BE, writeU32BE, writeU64BE,
  writeU16LE, writeU32LE, writeF32LE,
} from './src/core/bytes.js';
export { default as EventEmitter } from './src/core/events.js';

// ── Codec / hardware capability queries (Node) ──
export {
  getVideoCodec, getAudioCodec,
  getSupportedVideoCodecs, getSupportedAudioCodecs,
} from './src/codecs.js';
export { getHardwareAccelerationInfo } from './src/hw_accel.js';

export { computeAudioRms, computeAudioDbov } from './src/audio_level.js';
