/**
 * media-processing — Media toolkit for Node.js
 * WebCodecs-compatible API backed by FFmpeg and GStreamer.
 * Zero native bindings, zero npm dependencies.
 */

import VideoEncoder from './src/video_encoder.js';
import VideoDecoder from './src/video_decoder.js';
import AudioEncoder from './src/audio_encoder.js';
import AudioDecoder from './src/audio_decoder.js';

import VideoFrame from './src/video_frame.js';
import VideoColorSpace from './src/video_color_space.js';
import AudioData from './src/audio_data.js';
import { EncodedVideoChunk, EncodedAudioChunk } from './src/encoded_chunk.js';

import { MediaStream, MediaStreamTrack } from './src/media_stream.js';
import getUserMedia from './src/get_user_media.js';
import { enumerateDevices, getDisplayMedia, MediaDeviceInfo, InputDeviceInfo } from './src/get_user_media.js';

import { VideoSource, AudioSource, VideoSink, AudioSink } from './src/media_source_sink.js';
import { MediaStreamTrackProcessor, MediaStreamTrackGenerator } from './src/track_processor.js';
import MediaRecorder from './src/media_recorder.js';

import VideoPlayer from './src/video_player.js';
import ImageDecoder from './src/image_decoder.js';
import MediaEncoder from './src/media_encoder.js';
import FramePacer from './src/frame_pacer.js';
import Demuxer from './src/demuxer.js';
import Muxer from './src/muxer.js';
import { splitNALUs, extractParameterSets, annexbToAvcc, avccToAnnexb } from './src/reader_annexb.js';
import { splitOBUs, extractSequenceHeader } from './src/reader_ivf.js';
import { parseCodecString, normalizeCodec, parseCodecDetails } from './src/codec_strings.js';

import { i420ToRgba, rgbaToI420, rgb24ToI420, i420ToRgb24, nv12ToI420, i420ToNv12 } from './src/pixel_utils.js';
import { getSupportedVideoCodecs, getSupportedAudioCodecs } from './src/codecs.js';
import { checkFFmpeg, resolveFFmpegPath } from './src/ffmpeg_process.js';
import { getHardwareAccelerationInfo } from './src/hw_accel.js';
import { mediaCapabilities } from './src/media_capabilities.js';

var nonstandard = {
  VideoSource: VideoSource,
  VideoSink: VideoSink,
  AudioSource: AudioSource,
  AudioSink: AudioSink,
  VideoPlayer: VideoPlayer,
  i420ToRgba: i420ToRgba,
  rgbaToI420: rgbaToI420,
  rgb24ToI420: rgb24ToI420,
  i420ToRgb24: i420ToRgb24,
  nv12ToI420: nv12ToI420,
  i420ToNv12: i420ToNv12,
  splitNALUs: splitNALUs,
  extractParameterSets: extractParameterSets,
  parseCodecString: parseCodecString,
  normalizeCodec: normalizeCodec,
  parseCodecDetails: parseCodecDetails,
};

/**
 * Install WebCodecs API as globals — browser-compatible polyfill.
 * After calling this, browser-style code works directly:
 *   installWebCodecsPolyfill();
 *   var encoder = new VideoEncoder({ ... });
 */
function installWebCodecsPolyfill() {
  globalThis.VideoEncoder = VideoEncoder;
  globalThis.VideoDecoder = VideoDecoder;
  globalThis.AudioEncoder = AudioEncoder;
  globalThis.AudioDecoder = AudioDecoder;
  globalThis.VideoFrame = VideoFrame;
  globalThis.AudioData = AudioData;
  globalThis.EncodedVideoChunk = EncodedVideoChunk;
  globalThis.EncodedAudioChunk = EncodedAudioChunk;
  globalThis.VideoColorSpace = VideoColorSpace;
  globalThis.ImageDecoder = ImageDecoder;
  globalThis.MediaRecorder = MediaRecorder;
  globalThis.MediaStream = MediaStream;
  globalThis.MediaStreamTrack = MediaStreamTrack;
  globalThis.MediaDeviceInfo = MediaDeviceInfo;
  globalThis.InputDeviceInfo = InputDeviceInfo;
  globalThis.MediaStreamTrackProcessor = MediaStreamTrackProcessor;
  globalThis.MediaStreamTrackGenerator = MediaStreamTrackGenerator;
  if (!globalThis.navigator) globalThis.navigator = {};
  if (!globalThis.navigator.mediaDevices) globalThis.navigator.mediaDevices = {};
  globalThis.navigator.mediaDevices.getUserMedia = getUserMedia;
  globalThis.navigator.mediaDevices.getDisplayMedia = getDisplayMedia;
  globalThis.navigator.mediaDevices.enumerateDevices = enumerateDevices;
  globalThis.navigator.mediaCapabilities = mediaCapabilities;
}

export {
  VideoEncoder, VideoDecoder, AudioEncoder, AudioDecoder,
  VideoFrame, VideoColorSpace, AudioData, EncodedVideoChunk, EncodedAudioChunk,
  MediaStream, MediaStreamTrack, MediaDeviceInfo, InputDeviceInfo,
  getUserMedia, getDisplayMedia, enumerateDevices,
  MediaStreamTrackProcessor, MediaStreamTrackGenerator, MediaRecorder,
  VideoSource, VideoSink, AudioSource, AudioSink,
  VideoPlayer, ImageDecoder, MediaEncoder, FramePacer, Demuxer, Muxer, mediaCapabilities,
  i420ToRgba, rgbaToI420, rgb24ToI420, i420ToRgb24, nv12ToI420, i420ToNv12,
  splitNALUs, extractParameterSets, annexbToAvcc, avccToAnnexb, splitOBUs, extractSequenceHeader,
  getSupportedVideoCodecs, getSupportedAudioCodecs,
  parseCodecString, normalizeCodec, parseCodecDetails,
  checkFFmpeg, resolveFFmpegPath, getHardwareAccelerationInfo,
  installWebCodecsPolyfill,
  nonstandard,
};

export default {
  VideoEncoder, VideoDecoder, AudioEncoder, AudioDecoder,
  VideoFrame, VideoColorSpace, AudioData, EncodedVideoChunk, EncodedAudioChunk,
  MediaStream, MediaStreamTrack, MediaDeviceInfo, InputDeviceInfo,
  getUserMedia, getDisplayMedia, enumerateDevices,
  MediaStreamTrackProcessor, MediaStreamTrackGenerator, MediaRecorder,
  VideoSource, VideoSink, AudioSource, AudioSink,
  VideoPlayer, ImageDecoder, MediaEncoder, FramePacer, Demuxer, Muxer, mediaCapabilities,
  i420ToRgba, rgbaToI420, rgb24ToI420, i420ToRgb24, nv12ToI420, i420ToNv12,
  splitNALUs, extractParameterSets, annexbToAvcc, avccToAnnexb, splitOBUs, extractSequenceHeader,
  getSupportedVideoCodecs, getSupportedAudioCodecs,
  parseCodecString, normalizeCodec, parseCodecDetails,
  checkFFmpeg, resolveFFmpegPath, getHardwareAccelerationInfo,
  installWebCodecsPolyfill,
  nonstandard,
};
