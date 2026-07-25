/**
 * installWebCodecsPolyfill — register the FFmpeg-backed WebCodecs classes on
 * `globalThis` (and `navigator.mediaDevices`) so browser-style code that reads
 * the global names runs unchanged under Node.js.
 *
 * In the browser these globals are already the native implementations, so this
 * is a Node convenience and is intentionally NOT part of the browser bundle
 * (importing the FFmpeg-backed encoders there would pull Node built-ins in).
 *
 * Restored from the pre-merge media-processing API (the merge dropped it).
 *
 * After calling this, browser-style code works directly:
 *   installWebCodecsPolyfill();
 *   var encoder = new VideoEncoder({ ... });
 *   var stream  = await navigator.mediaDevices.getUserMedia({ video: true });
 */
import VideoEncoder from './video_encoder.js';
import VideoDecoder from './video_decoder.js';
import AudioEncoder from './audio_encoder.js';
import AudioDecoder from './audio_decoder.js';
import VideoFrame from './video_frame.js';
import AudioData from './audio_data.js';
import { EncodedVideoChunk, EncodedAudioChunk } from './encoded_chunk.js';
import VideoColorSpace from './video_color_space.js';
import ImageDecoder from './image_decoder.js';
import mediaCapabilities from './media_capabilities.js';
import MediaRecorder from './media_recorder.js';
import {
  MediaStream, MediaStreamTrack, MediaDeviceInfo, InputDeviceInfo,
} from './media_stream.js';
import {
  MediaStreamTrackProcessor, MediaStreamTrackGenerator,
} from './track_processor.js';
import getUserMedia, { enumerateDevices, getDisplayMedia } from './get_user_media.js';

export default function installWebCodecsPolyfill() {
  var g = globalThis;
  g.VideoEncoder = VideoEncoder;
  g.VideoDecoder = VideoDecoder;
  g.AudioEncoder = AudioEncoder;
  g.AudioDecoder = AudioDecoder;
  g.VideoFrame = VideoFrame;
  g.AudioData = AudioData;
  g.EncodedVideoChunk = EncodedVideoChunk;
  g.EncodedAudioChunk = EncodedAudioChunk;
  g.VideoColorSpace = VideoColorSpace;
  g.ImageDecoder = ImageDecoder;
  g.MediaRecorder = MediaRecorder;
  g.MediaStream = MediaStream;
  g.MediaStreamTrack = MediaStreamTrack;
  g.MediaDeviceInfo = MediaDeviceInfo;
  g.InputDeviceInfo = InputDeviceInfo;
  g.MediaStreamTrackProcessor = MediaStreamTrackProcessor;
  g.MediaStreamTrackGenerator = MediaStreamTrackGenerator;
  if (!g.navigator) g.navigator = {};
  if (!g.navigator.mediaDevices) g.navigator.mediaDevices = {};
  g.navigator.mediaDevices.getUserMedia = getUserMedia;
  g.navigator.mediaDevices.getDisplayMedia = getDisplayMedia;
  g.navigator.mediaDevices.enumerateDevices = enumerateDevices;
  g.navigator.mediaCapabilities = mediaCapabilities;
}
