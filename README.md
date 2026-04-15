
<h1 align="center">media-processing</h1>
<p align="center">
  <em>WebCodecs API for Node.js - encode, decode, capture &amp; play media with zero native bindings</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/media-processing">
    <img src="https://img.shields.io/npm/v/media-processing?color=blue" alt="npm">
  </a>
  <img src="https://img.shields.io/github/license/colocohen/media-processing?color=brightgreen" alt="license">
</p>

---

> **The browser's `VideoEncoder`, `VideoDecoder`, `VideoFrame`, and `MediaStream` - in Node.js.**
> Backed by FFmpeg child processes. No WASM, no native addons, no build step.

---


## Table of Contents
1. [Why media-processing?](#-why-media-processing)
2. [Quick Start](#-quick-start)
3. [Browser-Compatible API](#-browser-compatible-api)
4. [Node.js API](#-nodejs-api)
5. [Bitstream Utilities](#-bitstream-utilities)
6. [Supported Codecs](#-supported-codecs)
7. [Hardware Acceleration](#-hardware-acceleration)
8. [Comparison with Other Libraries](#-comparison-with-other-libraries)
9. [Project Structure](#-project-structure)
10. [Roadmap](#-roadmap)
11. [Limitations & Tradeoffs](#️-limitations--tradeoffs)
12. [Compatibility Matrix](#-compatibility-matrix)
13. [How It Works](#️-how-it-works)
14. [License](#-license)


## 🧠 Why media-processing?

Node.js has no built-in media encoding or decoding. Existing solutions require either **native C++ bindings** (complex builds, platform-specific failures) or **WASM** (slow startup, large bundles). Neither gives you the browser's clean `VideoEncoder` / `VideoDecoder` API.

**media-processing** changes this:

- **`npm install` and go** - zero dependencies, zero native bindings, zero build step
- **Browser-compatible API** - same `VideoEncoder`, `VideoDecoder`, `VideoFrame`, `MediaStream` classes you use in Chrome
- **FFmpeg under the hood** - all encoding/decoding goes through FFmpeg child processes via pipes. No WASM, no bindings, just `spawn('ffmpeg', ...)`
- **Realtime-first** - designed for WebRTC, streaming, and video conferencing. SVC temporal layers, error-resilient encoding, frame pacing, backpressure
- **Works everywhere** - Linux, macOS, Windows. ARM, x64, Docker. Anywhere Node.js and FFmpeg run
- **Debuggable** - every frame, every pipe, every FFmpeg argument is JavaScript you can inspect

### What "browser-compatible" means

media-processing implements the same **class names, method signatures, and data flow** as the W3C WebCodecs spec. Code written for the browser will work here with minimal changes. However, the underlying engine is FFmpeg child processes, not a browser's native codec stack. This means:

- **Encoding/decoding** - functionally identical. Same inputs, same outputs, same callbacks.
- **Force keyframe** - works, but implemented by restarting FFmpeg (adds ~50ms latency for one frame). Browsers do this internally without restart.
- **Per-frame quantizer** (`vp9: { quantizer }`) - accepted but applied as global CRF, not per-frame QP. FFmpeg CLI doesn't expose per-frame QP control.
- **Alpha channel** - `'discard'` only. `'keep'` requires dual-process encoding (planned).
- **Latency** - each encoder/decoder is a separate OS process. First-frame latency is higher than native (~100ms for process startup). Steady-state latency is dominated by the codec, not the pipe overhead.


## 📦 Quick Start

```bash
npm install media-processing
```

> **FFmpeg** is required. If it's not already in your PATH, install it automatically:
> ```bash
> npm install ffmpeg-static
> ```
> media-processing auto-detects `ffmpeg-static` and `@ffmpeg-installer/ffmpeg` - no configuration needed.
> GStreamer is optional (only needed for camera capture).

### Encode video

```js
import { VideoEncoder, VideoFrame } from 'media-processing';

var encoder = new VideoEncoder({
  output: function (chunk, metadata) {
    console.log(chunk.type, chunk.byteLength, 'bytes');
    // chunk.data = Buffer with encoded VP9 frame
  },
  error: function (e) { console.error(e); },
});

encoder.configure({
  codec: 'vp9',            // or 'h264', 'h265', 'vp8', 'av1'
  width: 1280,
  height: 720,
  bitrate: 2_000_000,
  framerate: 30,
});

// Create a frame from raw YUV420 data
var frame = new VideoFrame({
  data: yuvBuffer,          // Buffer of W×H×1.5 bytes (I420)
  format: 'I420',
  codedWidth: 1280,
  codedHeight: 720,
  timestamp: 0,
});

encoder.encode(frame);
await encoder.flush();
encoder.close();
```

### Decode video

```js
import { VideoDecoder } from 'media-processing';

var decoder = new VideoDecoder({
  output: function (frame) {
    // frame.data = raw I420 Buffer
    console.log(frame.codedWidth, 'x', frame.codedHeight);
    frame.close();
  },
  error: function (e) { console.error(e); },
});

decoder.configure({
  codec: 'vp9',
  codedWidth: 1280,
  codedHeight: 720,
});

decoder.decode(encodedChunk);
await decoder.flush();
decoder.close();
```

### Capture camera

```js
import { getUserMedia, VideoEncoder } from 'media-processing';

var stream = await getUserMedia({
  video: { width: 1280, height: 720, fps: 30 },
  audio: { sampleRate: 48000 },
});

var videoTrack = stream.getVideoTracks()[0];
videoTrack.on('frame', function (frame) {
  encoder.encode(frame);
});

// Later:
stream.stop();
```

### Browser-compatible polyfill

```js
import { installWebCodecsPolyfill } from 'media-processing';
installWebCodecsPolyfill();

// Now browser code works as-is - no changes needed:
var encoder = new VideoEncoder({ output: fn, error: fn });
var stream = await navigator.mediaDevices.getUserMedia({ video: true });
var screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
var recorder = new MediaRecorder(stream, { mimeType: 'video/mp4; codecs=h264,aac' });
```

### End-to-end: transcode MP4 → WebM

```js
import { Demuxer, VideoDecoder, VideoEncoder, Muxer } from 'media-processing';

// 1. Demux - extract encoded frames from source file
var demuxer = new Demuxer({ file: 'input.mp4' });
demuxer.probe();

// 2. Decode - MP4/H.264 → raw frames
var frames = [];
var decoder = new VideoDecoder({
  output: function (frame) { frames.push(frame); },
  error: function (e) { console.error(e); },
});
decoder.configure(demuxer.videoDecoderConfig);

// 3. Encode - raw frames → VP9
var muxer = new Muxer({
  output: 'output.webm',
  video: { codec: 'vp9', width: 1280, height: 720 },
});

var encoder = new VideoEncoder({
  output: function (chunk, metadata) { muxer.addVideoChunk(chunk); },
  error: function (e) { console.error(e); },
});
encoder.configure({
  codec: 'vp9',
  width: 1280,
  height: 720,
  bitrate: 2_000_000,
  framerate: 30,
});

// 4. Run the pipeline
demuxer.on('video', function (chunk) { decoder.decode(chunk); });
demuxer.start();
await decoder.flush();

for (var frame of frames) {
  encoder.encode(frame);
  frame.close();
}

await encoder.flush();
await muxer.flush();
encoder.close();
decoder.close();
```


## ✨ Browser-Compatible API

media-processing implements the [W3C WebCodecs](https://www.w3.org/TR/webcodecs/), [MediaStream Recording](https://www.w3.org/TR/mediastream-recording/), [Screen Capture](https://www.w3.org/TR/screen-capture/), and [Insertable Streams](https://www.w3.org/TR/mediacapture-transform/) specifications. If you know the browser API, you know this library - the classes, methods, and data flow are the same. See [MDN WebCodecs API](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API) for full documentation.

**Implemented classes:** `VideoEncoder`, `VideoDecoder`, `AudioEncoder`, `AudioDecoder`, `VideoFrame`, `AudioData`, `EncodedVideoChunk`, `EncodedAudioChunk`, `VideoColorSpace`, `ImageDecoder`, `MediaStream`, `MediaStreamTrack`, `MediaRecorder`, `MediaStreamTrackProcessor`, `MediaStreamTrackGenerator`, `getUserMedia`, `getDisplayMedia`, `enumerateDevices`, `MediaCapabilities`.

### What's different from the browser

| Feature | Browser | media-processing | Notes |
|---|---|---|---|
| Encoding/decoding | Native codec stack | FFmpeg child processes | Same API, same results, different engine |
| Force keyframe | Internal | Restarts FFmpeg (~50ms) | One-time latency per forced IDR |
| Per-frame quantizer | Per-frame QP | Global CRF | FFmpeg CLI limitation |
| Alpha channel | `'keep'` supported | `'discard'` only | Planned |
| First-frame latency | ~0ms | ~100ms | FFmpeg process startup |
| HW acceleration | Browser-managed | NVENC, QSV, VAAPI, VideoToolbox, AMF | Auto-detection with software fallback |
| SVC temporal layers | Chrome-only | ✅ L1T2, L1T3 | Drop-safe, integration tested |
| `getDisplayMedia` | User picker dialog | Captures full screen or window by title | No UI picker in Node.js |
| System audio | Tab audio capture | PulseAudio / Stereo Mix / virtual device | Platform-specific |

### MediaRecorder

```js
import { getUserMedia, MediaRecorder } from 'media-processing';

var stream = await getUserMedia({ video: { width: 1280, height: 720 }, audio: true });

var recorder = new MediaRecorder(stream, {
  mimeType: 'video/mp4; codecs=h264,aac',
  videoBitsPerSecond: 5_000_000,
});

recorder.ondataavailable = function (event) {
  // event.data = Buffer with encoded media
  fileStream.write(event.data);
};

recorder.start(1000);  // fire ondataavailable every 1000ms
// ... later:
recorder.stop();
```

### getDisplayMedia - Screen capture

```js
import { getDisplayMedia } from 'media-processing';

// Full screen + system audio
var stream = await getDisplayMedia({
  video: { width: 1920, height: 1080 },
  audio: true,
});

// Specific window (Linux/Windows)
var stream = await getDisplayMedia({
  video: { displaySurface: 'window', windowTitle: 'Firefox' },
});

// Hide cursor
var stream = await getDisplayMedia({
  video: { cursor: false },
});
```

Platform support: `x11grab` (Linux), `gdigrab`/`ddagrab` (Windows), `avfoundation` (macOS). System audio via PulseAudio monitor (Linux), Stereo Mix (Windows), or virtual audio device (macOS).

### MediaStreamTrackProcessor / MediaStreamTrackGenerator

Breakout Box API - bridges MediaStreamTrack and Web Streams for processing pipelines.

```js
import { MediaStreamTrackProcessor, MediaStreamTrackGenerator } from 'media-processing';

// Read frames from a track as a ReadableStream
var processor = new MediaStreamTrackProcessor({ track: videoTrack });
var reader = processor.readable.getReader();
var { value: frame, done } = await reader.read();

// Create a track fed by a WritableStream
var generator = new MediaStreamTrackGenerator({ kind: 'video' });
var writer = generator.writable.getWriter();
await writer.write(processedFrame);
stream.addTrack(generator);  // generator IS a track
```


## 🔧 Node.js API

These features go beyond browser specs and are designed for server-side media work:

### MediaEncoder - Combined video + audio

Single FFmpeg process with dual-input pipes (video on `pipe:0`, audio on `pipe:4`):

```js
import { MediaEncoder } from 'media-processing';

var enc = new MediaEncoder({
  video: { codec: 'h264', width: 1920, height: 1080, framerate: 30 },
  audio: { codec: 'aac', sampleRate: 48000, numberOfChannels: 2 },
  container: 'ts',          // 'ts', 'fmp4', 'ivf', 'adts'
  output: function (data) { /* interleaved A/V output */ },
  error: function (e) { console.error(e); },
});

enc.writeVideoFrame(videoFrame);
enc.writeAudioData(audioData);
await enc.flush();
```

### Demuxer - File to frames

```js
import { Demuxer, VideoDecoder } from 'media-processing';

var demuxer = new Demuxer({ file: 'video.mp4' });
demuxer.probe();

// Auto-extracted config - pass directly to decoder:
var decoder = new VideoDecoder({ output: fn, error: fn });
decoder.configure(demuxer.videoDecoderConfig);
// → { codec: 'h264', codedWidth: 1920, codedHeight: 1080 }

demuxer.on('video', function (chunk) { decoder.decode(chunk); });
demuxer.start({ startTime: 10.5, duration: 5.0 });

// Seek during playback:
demuxer.seek(30.0);
```

### Muxer - Frames to file

```js
import { Muxer } from 'media-processing';

var muxer = new Muxer({
  output: 'output.webm',
  video: { codec: 'vp9', width: 1280, height: 720 },
  audio: { codec: 'opus', sampleRate: 48000 },
});

muxer.addVideoChunk(encodedVideoChunk);
muxer.addAudioChunk(encodedAudioChunk);
await muxer.flush();
```

### FramePacer - Realtime delivery

```js
import { FramePacer } from 'media-processing';

var pacer = new FramePacer({ fps: 30 });

pacer.start(function (frameIndex) {
  var ok = encoder.encode(makeFrame(frameIndex));
  if (!ok) {
    pacer.pause();
    encoder.onDrain(function () { pacer.resume(); });
  }
});
```

### VideoSource / VideoSink - wrtc-style

```js
import { VideoSource, VideoSink } from 'media-processing';

// Source: push frames programmatically
var source = new VideoSource();
var track = source.createTrack();
source.onFrame({ data: yuvBuffer, width: 1280, height: 720 });

// Sink: consume frames from a track
var sink = new VideoSink(track);
sink.on('frame', function (frame) { /* process */ });
```

### getUserMedia - Camera & mic capture

```js
// Camera via GStreamer (cross-platform):
//   Windows: mfvideosrc  |  Linux: v4l2src  |  macOS: avfvideosrc
// Microphone via FFmpeg:
//   Windows: dshow  |  Linux: pulse  |  macOS: avfoundation

var stream = await getUserMedia({
  video: { width: 1280, height: 720, fps: 30 },
  audio: { sampleRate: 48000, channelCount: 2 },
});
```

### VideoPlayer - Display via ffplay

```js
import { VideoPlayer } from 'media-processing';

var player = new VideoPlayer({ width: 1280, height: 720, title: 'Preview' });
player.writeFrame(videoFrame);
// or
player.play(mediaStream);
```

### Advanced Encoder Tuning

```js
encoder.configure({
  codec: 'avc1.64002A',        // → auto: profile=high, level=4.2
  width: 1920,
  height: 1080,
  profile: 'high',              // override: 'baseline', 'main', 'high'
  level: '5.1',                 // override: '3.1', '4.1', '5.1'
  loglevel: 'debug',            // FFmpeg log: 'quiet', 'error', 'warning', 'info', 'debug'
  codecOptions: [               // raw FFmpeg args (escape hatch)
    '-tune', 'film',
    '-x264-params', 'ref=4:bframes=3',
  ],
});
```


## 🔬 Bitstream Utilities

Low-level tools for RTP packetization and SFU routing:

```js
import {
  splitNALUs, extractParameterSets, annexbToAvcc, avccToAnnexb,
  splitOBUs, extractSequenceHeader, parseCodecDetails,
} from 'media-processing';

// H.264/H.265 - NALU parsing
var nalus = splitNALUs(annexbBuffer);           // → [{ type, data }]
var spsPps = extractParameterSets(annexbBuffer); // → SPS+PPS Buffer
var avcc = annexbToAvcc(annexbBuffer);           // → length-prefixed (for MP4)
var annexb = avccToAnnexb(avccBuffer);           // → start-code prefixed

// AV1 - OBU parsing (with SVC layer info)
var obus = splitOBUs(av1Buffer);
// → [{ type, data, temporalId, spatialId }]
//   temporalId/spatialId for SFU layer routing

var seqHdr = extractSequenceHeader(av1Buffer);   // → Sequence Header Buffer

// Codec string parsing
var details = parseCodecDetails('avc1.64002A');
// → { name: 'h264', profile: 'high', level: '4.2', bitDepth: null }
```


## 🎛 Supported Codecs

| Type | Codecs |
|---|---|
| **Video** | VP8, VP9, AV1, H.264, H.265 |
| **Audio** | AAC, Opus, MP3, FLAC, Vorbis, G.711 (alaw/ulaw), PCM (s16le/f32le) |


## ⚡ Hardware Acceleration

Automatic GPU detection with software fallback:

| Platform | Encoders |
|---|---|
| **NVIDIA** (Windows/Linux) | h264_nvenc, hevc_nvenc, av1_nvenc |
| **Intel QSV** (Windows/Linux) | h264_qsv, hevc_qsv, vp9_qsv, av1_qsv |
| **AMD AMF** (Windows) | h264_amf, hevc_amf |
| **Apple VideoToolbox** (macOS) | h264_videotoolbox, hevc_videotoolbox |
| **VAAPI** (Linux) | h264_vaapi, hevc_vaapi, vp9_vaapi, av1_vaapi |

```js
encoder.configure({
  codec: 'h264',
  hardwareAcceleration: 'prefer-hardware',  // auto-detect + fallback to software
  width: 1920, height: 1080,
});
```


## 📊 Comparison with Other Libraries

|  | **media-processing** | **@napi-rs/webcodecs** | **boulabiar/webcodecs-node** |
|---|---|---|---|
| W3C WebCodecs API | ✅ Full | ✅ Full | ✅ Full |
| Dependencies | **0** | Rust/NAPI-RS | node-av (native) |
| Build step | **None** | Rust compiler | C++ compiler |
| MediaStream / Track | ✅ | ❌ | ❌ |
| MediaRecorder | ✅ | ❌ | ❌ |
| getUserMedia (capture) | ✅ | ❌ | ❌ |
| getDisplayMedia (screen) | ✅ | ❌ | ❌ |
| TrackProcessor / Generator | ✅ | ❌ | ❌ |
| MediaEncoder (V+A) | ✅ | ❌ | ❌ |
| FramePacer | ✅ | ❌ | ❌ |
| SVC temporal layers | ✅ | ❌ | ❌ |
| NALU/OBU utilities | ✅ | ❌ | ❌ |
| Source/Sink (wrtc) | ✅ | ❌ | ❌ |
| VideoPlayer | ✅ | ❌ | ❌ |
| Error-resilient encoding | ✅ | ❌ | ❌ |
| Demuxer with seeking | ✅ | ✅ | ❌ |
| Polyfill mode | ✅ | ❌ | ✅ |
| FFmpeg auto-resolve | ✅ | N/A | N/A |
| HW acceleration | ✅ Auto-fallback | ✅ Zero-copy | ✅ |
| Alpha encoding | ❌ | ✅ | ❌ |
| Canvas integration | ❌ | ✅ | ❌ |
| **Best for** | **Realtime streaming** | **File processing** | **General purpose** |

### Where others are better

- **@napi-rs/webcodecs** has **lower latency** for file processing because it uses native FFmpeg bindings (no process spawn overhead). It also supports **zero-copy GPU encoding** and **alpha channel encoding** which we don't.
- **Native bindings** in general give better **per-frame latency** (~1ms vs ~5ms for our pipe round-trip) and lower **memory overhead** (shared process vs separate FFmpeg process per encoder).
- **Our advantage** is operational simplicity: `npm install` with zero build failures, zero platform-specific binaries, and the ability to debug the entire stack in JavaScript. For realtime streaming use cases (WebRTC, QUIC, conferencing), the pipe overhead is negligible compared to network jitter.


## 📁 Project Structure

```
media-processing/
├── index.js                    - 51 exports
├── package.json                - v0.1.0, ESM, zero deps
├── src/
│   ├── video_encoder.js          VideoEncoder (HW auto-fallback, SVC, force keyframe)
│   ├── video_decoder.js          VideoDecoder (description, IVF wrapping)
│   ├── audio_encoder.js          AudioEncoder (AAC/Opus/MP3/FLAC/Vorbis/G.711/PCM)
│   ├── audio_decoder.js          AudioDecoder (auto-detect format)
│   ├── media_encoder.js          MediaEncoder (dual-input video+audio, single process)
│   ├── media_recorder.js         MediaRecorder (browser-compatible recording API)
│   ├── video_frame.js            VideoFrame (browser constructors, copyTo, colorSpace)
│   ├── audio_data.js             AudioData (allocationSize, copyTo)
│   ├── encoded_chunk.js          EncodedVideoChunk + EncodedAudioChunk
│   ├── video_color_space.js      VideoColorSpace
│   ├── media_stream.js           MediaStream + MediaStreamTrack (full EventTarget)
│   ├── track_processor.js        MediaStreamTrackProcessor + Generator (Breakout Box)
│   ├── get_user_media.js         getUserMedia + getDisplayMedia + enumerateDevices
│   ├── media_source_sink.js      VideoSource/Sink + AudioSource/Sink
│   ├── media_capabilities.js     MediaCapabilities API
│   ├── image_decoder.js          ImageDecoder (JPEG/PNG/WebP/GIF)
│   ├── demuxer.js                Demuxer (file → frames, seeking, auto-config)
│   ├── muxer.js                  Muxer (encoded chunks → file)
│   ├── frame_pacer.js            FramePacer (realtime FPS pacing)
│   ├── video_player.js           VideoPlayer (ffplay wrapper)
│   ├── pixel_utils.js            I420↔RGBA/RGB24/NV12 conversion
│   ├── codec_strings.js          Parse 'avc1.64002A' → profile/level
│   ├── codecs.js                 Codec registry + thread-aware defaults
│   ├── hw_accel.js               Hardware acceleration detection
│   ├── containers.js             Codec → container → reader mapping
│   ├── base_coder.js             Shared encoder/decoder lifecycle
│   ├── ffmpeg_process.js         FFmpeg process manager + auto-resolve path
│   ├── gstreamer_process.js      GStreamer + screen/window capture
│   ├── frame_queue.js            Pre-allocated frame accumulator
│   ├── byte_queue.js             Internal byte buffer
│   ├── reader_annexb.js          H.264/H.265 Annex-B + NALU utilities
│   ├── reader_ivf.js             VP8/VP9/AV1 IVF + OBU utilities
│   ├── reader_adts.js            AAC/ADTS
│   ├── reader_fmp4.js            Fragmented MP4 with tfdt/trun parsing
│   ├── reader_ts.js              MPEG-TS (PAT→PMT→PES)
│   └── reader_ogg.js             OGG/Opus
├── test/                       - 179+ tests
└── LICENSE                     - Apache-2.0
```


## 🛣 Roadmap

### ✅ Done
- W3C WebCodecs API - VideoEncoder, VideoDecoder, AudioEncoder, AudioDecoder
- All data classes - VideoFrame, AudioData, EncodedVideoChunk, EncodedAudioChunk
- MediaStream and MediaStreamTrack with full browser API + EventTarget
- MediaRecorder - browser-compatible recording API with timeslice support
- MediaStreamTrackProcessor / MediaStreamTrackGenerator (Breakout Box)
- getUserMedia - camera (GStreamer) + microphone (FFmpeg) + screen capture
- getDisplayMedia - screen/window capture with system audio and cursor control
- Hardware acceleration - NVENC, QSV, VAAPI, VideoToolbox, AMF with auto-fallback
- SVC temporal layers - L1T2, L1T3 (drop-safe, integration tested)
- 6 container readers - Annex-B, IVF, ADTS, fMP4, MPEG-TS, OGG
- Bitstream utilities - splitNALUs, splitOBUs, AnnexB↔AVCC, OBU temporal_id/spatial_id
- MediaEncoder - dual-input (video + audio in single FFmpeg process)
- Demuxer with seeking and auto decoder config extraction
- Muxer - encoded chunks to file
- FramePacer - realtime delivery with backpressure
- VideoPlayer - display via ffplay
- Browser codec string parsing - `avc1.64002A` → profile/level auto-extraction
- Thread-aware encoding - auto-detects CPU cores, adjusts tiles and threads
- FFmpeg auto-resolve - system PATH, `ffmpeg-static`, `@ffmpeg-installer/ffmpeg`
- installWebCodecsPolyfill - browser-compatible globals (including MediaRecorder, getDisplayMedia)
- 179+ tests across 5 test suites

### ⏳ Planned
- Alpha channel encoding (VP9/HEVC - requires dual FFmpeg processes)
- ESM + CJS + TypeScript type definitions
- WebM/MKV container-specific muxers
- W3C Web Platform Tests (WPT) validation
- Performance benchmarks vs native bindings


## ⚠️ Limitations & Tradeoffs

Every architecture has tradeoffs. Ours - zero native bindings, pure FFmpeg child processes - comes with these:

**Process overhead.** Each encoder/decoder spawns one FFmpeg process. On a typical system this adds ~5-15MB RSS per process and ~100ms first-frame latency. After startup, steady-state overhead is negligible - the pipe is just `write()` and `read()` on file descriptors.

**Force keyframe via restart.** When you call `encode(frame, { keyFrame: true })`, media-processing ends the current FFmpeg process (letting it flush) and starts a new one. The new process begins with an IDR frame. This adds ~50ms of one-time latency. The old process continues emitting its buffered frames, so no data is lost. This is the only way to force IDR with FFmpeg CLI - there is no mid-stream keyframe API.

**No per-frame QP.** Per-frame quantizer (`vp9: { quantizer }`) is accepted for API compatibility but applied as a global CRF value. FFmpeg CLI doesn't expose per-frame QP control. For fine-grained quality control, use `bitrateMode: 'constant'` with a target bitrate.

**Copy at pipe boundaries.** Data crosses a pipe twice: once from Node.js to FFmpeg stdin, once from FFmpeg pipe:3 back to Node.js. This is inherent to child process IPC. The internal readers use pre-allocated flat buffers to minimize GC pressure after the pipe read.

**No zero-copy GPU path.** Native libraries like @napi-rs/webcodecs can pass GPU surfaces directly between encoder and decoder. Our approach always goes through CPU memory via pipes. For GPU-intensive workflows (4K+, multi-stream), native bindings will outperform us.

**Process cleanup.** If your Node.js process exits abnormally (kill -9), spawned FFmpeg processes may become orphans. Always call `encoder.close()` or `stream.stop()` in cleanup handlers. The library sends SIGTERM with a 2-second timeout before SIGKILL.


## 📋 Compatibility Matrix

| Requirement | Minimum | Recommended |
|---|---|---|
| **Node.js** | 16.0+ | 20+ (for stable ESM) |
| **FFmpeg** | 4.4+ | 6.0+ (for AV1 libaom, SVC) |
| **GStreamer** | 1.16+ (optional) | 1.20+ |
| **OS** | Linux, macOS, Windows | All supported equally |

| Feature | Linux | macOS | Windows | Notes |
|---|---|---|---|---|
| Video encoding | ✅ | ✅ | ✅ | FFmpeg required |
| Audio encoding | ✅ | ✅ | ✅ | FFmpeg required |
| Camera capture | ✅ v4l2src | ✅ avfvideosrc | ✅ mfvideosrc | GStreamer required |
| Mic capture | ✅ pulse | ✅ avfoundation | ✅ dshow | FFmpeg required |
| Screen capture | ✅ x11grab | ✅ avfoundation | ✅ gdigrab | FFmpeg required |
| NVENC | ✅ | ❌ | ✅ | NVIDIA GPU + drivers |
| VideoToolbox | ❌ | ✅ | ❌ | Apple Silicon or Intel Mac |
| VAAPI | ✅ | ❌ | ❌ | Intel/AMD GPU |
| QSV | ✅ | ❌ | ✅ | Intel GPU |
| AMF | ❌ | ❌ | ✅ | AMD GPU |
| VideoPlayer (ffplay) | ✅ | ✅ | ✅ | Display server required |


## ⚙️ How It Works

media-processing doesn't link against FFmpeg or use WASM. Instead, it spawns FFmpeg as child processes and communicates via pipes:

```
Your code
  │
  ├── encoder.encode(videoFrame)
  │     │ writes raw I420 to FFmpeg stdin (pipe:0)
  │     ▼
  │   FFmpeg child process (libx264/libvpx/libaom)
  │     │ outputs encoded bitstream to pipe:3
  │     ▼
  │   Reader (AnnexB/IVF/ADTS) parses stream into frames
  │     │
  │     ▼
  │   output(EncodedVideoChunk, metadata)
  │
  ├── decoder.decode(chunk)
  │     │ writes encoded data to FFmpeg stdin (with container header)
  │     ▼
  │   FFmpeg child process (decoder)
  │     │ outputs raw YUV420 to pipe:3
  │     ▼
  │   FrameQueue cuts by frame size → VideoFrame
  │
  └── getUserMedia()
        │ spawns GStreamer (video) + FFmpeg (audio)
        ▼
      MediaStream with tracks emitting frames
```

Each encoder/decoder is an independent FFmpeg process. Node.js manages the lifecycle, backpressure, and frame routing.


## 🙏 Sponsors

media-processing is an evenings-and-weekends project.  
Support development via **GitHub Sponsors** or simply share the project.



## 📜 License

**Apache License 2.0**

```
Copyright © 2025 colocohen

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```
