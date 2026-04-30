/**
 * media-processing — WebCodecs-compatible media API for Node.js.
 * Type definitions.
 */

// ── Video Encoder / Decoder ──

export interface VideoEncoderInit {
  output: (chunk: EncodedVideoChunk, metadata?: EncodedVideoChunkMetadata) => void;
  error: (error: Error) => void;
  ffmpegPath?: string;
  maxQueueSize?: number;
  flushTimeout?: number;
}

export interface VideoEncoderConfig {
  codec: string;
  width: number;
  height: number;
  framerate?: number;
  bitrate?: number;
  latencyMode?: 'realtime' | 'quality';
  hardwareAcceleration?: 'no-preference' | 'prefer-hardware' | 'prefer-software';
  bitrateMode?: 'variable' | 'constant' | 'quantizer';
  scalabilityMode?: 'L1T1' | 'L1T2' | 'L1T3';
  contentHint?: '' | 'motion' | 'detail' | 'text';
  alpha?: 'discard' | 'keep';
  gopSize?: number;
  crf?: number;
  tileColumns?: number;
  tileRows?: number;
  errorResilient?: boolean;
  profile?: string;
  level?: string;
  loglevel?: string;
  codecOptions?: string[];
}

export interface VideoEncoderEncodeOptions {
  keyFrame?: boolean;
  vp9?: { quantizer: number };
  av1?: { quantizer: number };
  avc?: { quantizer: number };
  hevc?: { quantizer: number };
}

export class VideoEncoder {
  constructor(init: VideoEncoderInit);
  configure(config: VideoEncoderConfig): void;
  encode(frame: VideoFrame, options?: VideoEncoderEncodeOptions): boolean;
  flush(): Promise<void>;
  flush(callback: () => void): void;
  close(): void;
  reset(): void;
  readonly state: 'unconfigured' | 'configured' | 'closed';
  readonly encodeQueueSize: number;
  ondequeue: (() => void) | null;
  onDrain(callback: () => void): void;
  addEventListener(type: string, listener: Function): void;
  removeEventListener(type: string, listener: Function): void;
  static isConfigSupported(config: VideoEncoderConfig): Promise<{ supported: boolean }>;
  readonly context: {
    state: string;
    codec: string | null;
    width: number;
    height: number;
    framerate: number;
    frameCount: number;
    keyframeCount: number;
    encoder: string | null;
    isHardware: boolean;
  };
}

// ── Video Decoder ──

export interface VideoDecoderInit {
  output: (frame: VideoFrame) => void;
  error: (error: Error) => void;
  ffmpegPath?: string;
}

export interface VideoDecoderConfig {
  codec: string;
  codedWidth?: number;
  codedHeight?: number;
  description?: Buffer | Uint8Array;
}

export class VideoDecoder {
  constructor(init: VideoDecoderInit);
  configure(config: VideoDecoderConfig): void;
  decode(chunk: EncodedVideoChunk): void;
  flush(): Promise<void>;
  flush(callback: () => void): void;
  close(): void;
  reset(): void;
  readonly state: 'unconfigured' | 'configured' | 'closed';
  readonly decodeQueueSize: number;
  addEventListener(type: string, listener: Function): void;
  removeEventListener(type: string, listener: Function): void;
}

// ── Audio Encoder / Decoder ──

export interface AudioEncoderInit {
  output: (chunk: EncodedAudioChunk, metadata?: object) => void;
  error: (error: Error) => void;
}

export interface AudioEncoderConfig {
  codec: string;
  sampleRate?: number;
  numberOfChannels?: number;
  bitrate?: number;
  format?: string;
}

export class AudioEncoder {
  constructor(init: AudioEncoderInit);
  configure(config: AudioEncoderConfig): void;
  encode(data: AudioData): void;
  flush(): Promise<void>;
  flush(callback: () => void): void;
  close(): void;
  reset(): void;
  readonly state: 'unconfigured' | 'configured' | 'closed';
  readonly encodeQueueSize: number;
  addEventListener(type: string, listener: Function): void;
  removeEventListener(type: string, listener: Function): void;
}

export interface AudioDecoderInit {
  output: (data: AudioData) => void;
  error: (error: Error) => void;
}

export class AudioDecoder {
  constructor(init: AudioDecoderInit);
  configure(config: { codec: string; sampleRate?: number; numberOfChannels?: number }): void;
  decode(chunk: EncodedAudioChunk): void;
  flush(): Promise<void>;
  flush(callback: () => void): void;
  close(): void;
  reset(): void;
  readonly state: 'unconfigured' | 'configured' | 'closed';
  readonly decodeQueueSize: number;
  addEventListener(type: string, listener: Function): void;
  removeEventListener(type: string, listener: Function): void;
}

// ── Data Classes ──

export interface VideoFrameInit {
  data: Buffer | Uint8Array;
  format?: 'I420' | 'YUV420P' | 'NV12' | 'RGBA' | 'RGBX' | 'RGB24' | 'BGRA' | 'BGRX' | 'I420A';
  codedWidth: number;
  codedHeight: number;
  timestamp?: number;
  duration?: number;
  displayWidth?: number;
  displayHeight?: number;
  visibleRect?: { x: number; y: number; width: number; height: number };
  colorSpace?: VideoColorSpaceInit;
}

export class VideoFrame {
  constructor(init: VideoFrameInit);
  constructor(data: Buffer | Uint8Array, init: Omit<VideoFrameInit, 'data'>);
  constructor(source: VideoFrame, overrides?: Partial<VideoFrameInit>);
  readonly data: Buffer | null;
  readonly format: string;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly visibleRect: { x: number; y: number; width: number; height: number };
  readonly codedRect: { x: number; y: number; width: number; height: number };
  readonly colorSpace: VideoColorSpace;
  readonly timestamp: number;
  readonly duration: number;
  readonly byteLength: number;
  allocationSize(options?: { format?: string }): number;
  copyTo(destination: Buffer | Uint8Array, options?: { format?: string }): Promise<Array<{ offset: number; stride: number }>>;
  clone(): VideoFrame;
  close(): void;
}

export interface AudioDataInit {
  data: Buffer | Uint8Array;
  format: string;
  sampleRate: number;
  numberOfChannels: number;
  numberOfFrames: number;
  timestamp?: number;
  duration?: number;
}

export class AudioData {
  constructor(init: AudioDataInit);
  readonly data: Buffer | null;
  readonly format: string;
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly numberOfFrames: number;
  readonly timestamp: number;
  readonly duration: number;
  allocationSize(options?: { format?: string }): number;
  copyTo(destination: Buffer | Uint8Array, options?: { format?: string }): void;
  close(): void;
}

export interface EncodedVideoChunkInit {
  type: 'key' | 'delta';
  timestamp: number;
  duration?: number;
  data: Buffer | Uint8Array;
}

export interface EncodedVideoChunkMetadata {
  decoderConfig?: VideoDecoderConfig;
  svc?: { temporalLayerId: number };
}

export class EncodedVideoChunk {
  constructor(init: EncodedVideoChunkInit);
  readonly type: 'key' | 'delta';
  readonly timestamp: number;
  readonly duration: number;
  readonly data: Buffer;
  readonly byteLength: number;
  metadata?: EncodedVideoChunkMetadata;
  copyTo(destination: Buffer | Uint8Array): void;
}

export class EncodedAudioChunk {
  constructor(init: EncodedVideoChunkInit);
  readonly type: 'key' | 'delta';
  readonly timestamp: number;
  readonly duration: number;
  readonly data: Buffer;
  readonly byteLength: number;
  copyTo(destination: Buffer | Uint8Array): void;
}

export interface VideoColorSpaceInit {
  primaries?: string;
  transfer?: string;
  matrix?: string;
  fullRange?: boolean;
}

export class VideoColorSpace {
  constructor(init?: VideoColorSpaceInit);
  readonly primaries: string | null;
  readonly transfer: string | null;
  readonly matrix: string | null;
  readonly fullRange: boolean | null;
  toJSON(): VideoColorSpaceInit;
}

// ── MediaStream / MediaStreamTrack ──

export class MediaStreamTrack {
  constructor(opts?: { kind?: 'video' | 'audio'; label?: string; id?: string; contentHint?: string; settings?: Record<string, any> });
  readonly kind: 'video' | 'audio';
  readonly id: string;
  label: string;
  enabled: boolean;
  readyState: 'live' | 'ended';
  muted: boolean;
  contentHint: string;
  stop(): void;
  clone(): MediaStreamTrack;
  getSettings(): Record<string, any>;
  getCapabilities(): Record<string, any>;
  getConstraints(): Record<string, any>;
  applyConstraints(constraints: Record<string, any>): Promise<void>;
  on(event: string, listener: Function): void;
  off(event: string, listener: Function): void;
  addEventListener(event: string, listener: Function): void;
  removeEventListener(event: string, listener: Function): void;
  dispatchEvent(event: any): void;
  onended: (() => void) | null;
  onmute: (() => void) | null;
  onunmute: (() => void) | null;
  /** @internal */ _push(data: any): void;
  /** @internal */ _setMuted(muted: boolean): void;
}

export class MediaStream {
  constructor();
  constructor(stream: MediaStream);
  constructor(tracks: MediaStreamTrack[]);
  readonly id: string;
  readonly active: boolean;
  addTrack(track: MediaStreamTrack): void;
  removeTrack(track: MediaStreamTrack): void;
  getTracks(): MediaStreamTrack[];
  getVideoTracks(): MediaStreamTrack[];
  getAudioTracks(): MediaStreamTrack[];
  getTrackById(id: string): MediaStreamTrack | null;
  clone(): MediaStream;
  stop(): void;
  on(event: string, listener: Function): void;
  off(event: string, listener: Function): void;
  addEventListener(event: string, listener: Function): void;
  removeEventListener(event: string, listener: Function): void;
  dispatchEvent(event: any): void;
  onaddtrack: ((track: MediaStreamTrack) => void) | null;
  onremovetrack: ((track: MediaStreamTrack) => void) | null;
}

// ── MediaRecorder ──

export interface MediaRecorderOptions {
  mimeType?: string;
  videoBitsPerSecond?: number;
  audioBitsPerSecond?: number;
  bitsPerSecond?: number;
}

export interface BlobEvent {
  data: Buffer;
  timecode: number;
}

export class MediaRecorder {
  constructor(stream: MediaStream, options?: MediaRecorderOptions);
  readonly stream: MediaStream;
  readonly mimeType: string;
  state: 'inactive' | 'recording' | 'paused';
  videoBitsPerSecond: number;
  audioBitsPerSecond: number;
  start(timeslice?: number): void;
  stop(): void;
  pause(): void;
  resume(): void;
  requestData(): void;
  ondataavailable: ((event: BlobEvent) => void) | null;
  onstop: ((event: any) => void) | null;
  onstart: ((event: any) => void) | null;
  onerror: ((event: { error: Error }) => void) | null;
  onpause: ((event: any) => void) | null;
  onresume: ((event: any) => void) | null;
  addEventListener(type: string, listener: Function): void;
  removeEventListener(type: string, listener: Function): void;
  static isTypeSupported(mimeType: string): boolean;
}

// ── TrackProcessor / Generator ──

export class MediaStreamTrackProcessor {
  constructor(init: { track: MediaStreamTrack; maxBufferSize?: number });
  readonly readable: ReadableStream;
}

export class MediaStreamTrackGenerator extends MediaStreamTrack {
  constructor(init: { kind: 'video' | 'audio' });
  readonly writable: WritableStream;
}

// ── getUserMedia / getDisplayMedia ──

export interface MediaConstraints {
  video?: boolean | {
    width?: number;
    height?: number;
    fps?: number;
    framerate?: number;
    device?: string;
  };
  audio?: boolean | {
    sampleRate?: number;
    channelCount?: number;
    numberOfChannels?: number;
    device?: string;
  };
  screen?: boolean | {
    width?: number;
    height?: number;
    fps?: number;
  };
}

export interface DisplayMediaConstraints {
  video?: boolean | {
    width?: number;
    height?: number;
    fps?: number;
    cursor?: boolean;
    displaySurface?: 'monitor' | 'window';
    windowTitle?: string;
    display?: string;
    device?: string;
    ffmpegPath?: string;
  };
  audio?: boolean | {
    sampleRate?: number;
    channelCount?: number;
    device?: string;
  };
}

export function getUserMedia(constraints: MediaConstraints): Promise<MediaStream>;
export function getDisplayMedia(constraints?: DisplayMediaConstraints): Promise<MediaStream>;

export interface DeviceInfo {
  deviceId: string;
  kind: 'videoinput' | 'audioinput';
  label: string;
}

export function enumerateDevices(): DeviceInfo[];

// ── Source / Sink ──

export class VideoSource {
  constructor(opts?: { isScreencast?: boolean });
  createTrack(): MediaStreamTrack;
  onFrame(frame: VideoFrame | { data: Buffer; format?: string; width: number; height: number; timestamp?: number }): void;
}

export class AudioSource {
  createTrack(): MediaStreamTrack;
  onData(data: { samples: Buffer; sampleRate?: number; channelCount?: number; numberOfFrames?: number }): void;
}

export class VideoSink {
  constructor(track: MediaStreamTrack);
  stopped: boolean;
  onframe: ((frame: VideoFrame) => void) | null;
  on(event: string, listener: Function): void;
  off(event: string, listener: Function): void;
  stop(): void;
}

export class AudioSink {
  constructor(track: MediaStreamTrack);
  stopped: boolean;
  ondata: ((data: AudioData) => void) | null;
  on(event: string, listener: Function): void;
  off(event: string, listener: Function): void;
  stop(): void;
}

// ── Node.js API (non-browser) ──

export interface MediaEncoderOptions {
  video?: { codec: string; width: number; height: number; framerate?: number; bitrate?: number };
  audio?: { codec: string; sampleRate?: number; numberOfChannels?: number; channels?: number; bitrate?: number; format?: string };
  container?: string;
  output?: (data: any) => void;
  error?: (error: Error) => void;
  ffmpegPath?: string;
}

export class MediaEncoder {
  constructor(opts: MediaEncoderOptions);
  writeVideoFrame(frame: VideoFrame): boolean;
  writeAudioData(audioData: AudioData): boolean;
  flush(): Promise<void>;
  flush(callback: () => void): void;
  close(): void;
  readonly running: boolean;
  on(event: string, listener: Function): void;
  off(event: string, listener: Function): void;
  onVideoDrain(callback: () => void): void;
  onAudioDrain(callback: () => void): void;
}

export class ImageDecoder {
  constructor(init: { data: Buffer; type?: string });
  decode(options?: { frameIndex?: number }): { image: VideoFrame; complete: boolean };
  close(): void;
  readonly tracks: { selectedTrack: { frameCount: number; animated: boolean } };
  static isTypeSupported(type: string): boolean;
}

export interface DemuxerOptions {
  file: string;
  ffmpegPath?: string;
}

export class Demuxer {
  constructor(opts: DemuxerOptions);
  probe(): void;
  start(options?: { startTime?: number; duration?: number }): void;
  seek(time: number): void;
  readonly videoDecoderConfig: VideoDecoderConfig;
  on(event: string, listener: Function): void;
  off(event: string, listener: Function): void;
}

export interface MuxerOptions {
  output: string;
  video?: { codec: string; width: number; height: number };
  audio?: { codec: string; sampleRate?: number };
}

export class Muxer {
  constructor(opts: MuxerOptions);
  addVideoChunk(chunk: EncodedVideoChunk): void;
  addAudioChunk(chunk: EncodedAudioChunk): void;
  flush(): Promise<void>;
}

export class FramePacer {
  constructor(opts?: { fps?: number });
  start(callback: (frameIndex: number) => void): void;
  pause(): void;
  resume(): void;
  stop(): void;
}

export class VideoPlayer {
  constructor(opts?: { width?: number; height?: number; fps?: number; framerate?: number; title?: string; windowWidth?: number; windowHeight?: number });
  writeFrame(frame: VideoFrame): boolean;
  play(stream: MediaStream): void;
  onDrain(callback: () => void): void;
  stop(): void;
  on(event: string, listener: Function): void;
  off(event: string, listener: Function): void;
}

// ── Utilities ──

export function i420ToRgba(src: { data: Buffer; width: number; height: number }, dst: { data: Buffer; width: number; height: number }): void;
export function rgbaToI420(src: { data: Buffer; width: number; height: number }, dst: { data: Buffer; width: number; height: number }): void;
export function rgb24ToI420(src: { data: Buffer; width: number; height: number }, dst: { data: Buffer; width: number; height: number }): void;
export function i420ToRgb24(src: { data: Buffer; width: number; height: number }, dst: { data: Buffer; width: number; height: number }): void;
export function nv12ToI420(src: { data: Buffer; width: number; height: number }, dst: { data: Buffer; width: number; height: number }): void;
export function i420ToNv12(src: { data: Buffer; width: number; height: number }, dst: { data: Buffer; width: number; height: number }): void;

export function splitNALUs(buffer: Buffer): Array<{ type: number; data: Buffer }>;
export function extractParameterSets(buffer: Buffer, isHEVC?: boolean): Buffer | null;
export function annexbToAvcc(buffer: Buffer): Buffer;
export function avccToAnnexb(buffer: Buffer): Buffer;
export function splitOBUs(buffer: Buffer): Array<{ type: number; data: Buffer; temporalId?: number; spatialId?: number }>;
export function extractSequenceHeader(buffer: Buffer): Buffer | null;

export function parseCodecString(codec: string): { name: string; profile?: string; level?: string };
export function normalizeCodec(codec: string): string;
export function parseCodecDetails(codec: string): { name: string; profile: string | null; level: string | null; bitDepth: number | null };

export function getSupportedVideoCodecs(): string[];
export function getSupportedAudioCodecs(): string[];

export function checkFFmpeg(ffmpegPath?: string): boolean;
export function resolveFFmpegPath(explicit?: string): string | null;
export function getHardwareAccelerationInfo(): {
  encoders: Record<string, { hasHardware: boolean; encoder?: string }>;
};

export declare const mediaCapabilities: {
  decodingInfo(config: any): { supported: boolean; smooth: boolean; powerEfficient: boolean };
  encodingInfo(config: any): { supported: boolean; smooth: boolean; powerEfficient: boolean };
};

export function installWebCodecsPolyfill(): void;

export declare const nonstandard: {
  VideoSource: typeof VideoSource;
  VideoSink: typeof VideoSink;
  AudioSource: typeof AudioSource;
  AudioSink: typeof AudioSink;
  VideoPlayer: typeof VideoPlayer;
  i420ToRgba: typeof i420ToRgba;
  rgbaToI420: typeof rgbaToI420;
  rgb24ToI420: typeof rgb24ToI420;
  i420ToRgb24: typeof i420ToRgb24;
  nv12ToI420: typeof nv12ToI420;
  i420ToNv12: typeof i420ToNv12;
  splitNALUs: typeof splitNALUs;
  extractParameterSets: typeof extractParameterSets;
  parseCodecString: typeof parseCodecString;
  normalizeCodec: typeof normalizeCodec;
  parseCodecDetails: typeof parseCodecDetails;
};

// ── Default export ──

declare const _default: {
  VideoEncoder: typeof VideoEncoder;
  VideoDecoder: typeof VideoDecoder;
  AudioEncoder: typeof AudioEncoder;
  AudioDecoder: typeof AudioDecoder;
  VideoFrame: typeof VideoFrame;
  VideoColorSpace: typeof VideoColorSpace;
  AudioData: typeof AudioData;
  EncodedVideoChunk: typeof EncodedVideoChunk;
  EncodedAudioChunk: typeof EncodedAudioChunk;
  MediaStream: typeof MediaStream;
  MediaStreamTrack: typeof MediaStreamTrack;
  getUserMedia: typeof getUserMedia;
  getDisplayMedia: typeof getDisplayMedia;
  enumerateDevices: typeof enumerateDevices;
  MediaStreamTrackProcessor: typeof MediaStreamTrackProcessor;
  MediaStreamTrackGenerator: typeof MediaStreamTrackGenerator;
  MediaRecorder: typeof MediaRecorder;
  VideoSource: typeof VideoSource;
  VideoSink: typeof VideoSink;
  AudioSource: typeof AudioSource;
  AudioSink: typeof AudioSink;
  VideoPlayer: typeof VideoPlayer;
  ImageDecoder: typeof ImageDecoder;
  MediaEncoder: typeof MediaEncoder;
  FramePacer: typeof FramePacer;
  Demuxer: typeof Demuxer;
  Muxer: typeof Muxer;
  mediaCapabilities: typeof mediaCapabilities;
  installWebCodecsPolyfill: typeof installWebCodecsPolyfill;
  nonstandard: typeof nonstandard;
};

export default _default;
