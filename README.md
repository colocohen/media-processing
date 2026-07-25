<h1 align="center">media-processing</h1>
<p align="center">
  <em>The WebCodecs API <strong>and</strong> a full HLS encoder — one isomorphic library that runs the same code in Node.js and the browser.</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/media-processing">
    <img src="https://img.shields.io/npm/v/media-processing?color=blue" alt="npm">
  </a>
  <img src="https://img.shields.io/github/license/colocohen/media-processing?color=brightgreen" alt="license">
</p>

---

> **The browser's `VideoEncoder`, `VideoDecoder`, `VideoFrame`, and `MediaStream` — in Node.js**, backed by FFmpeg child processes (no WASM, no native addons, no build step).
> **Plus a complete HLS encoder** — MPEG-TS and fMP4/CMAF, LL-HLS, encryption, captions, subtitles, ABR ladders, HDR, ad markers — and an **HLS parser** for reading playlists back.
> Write once. Run in Node (over FFmpeg) or in the browser (over native WebCodecs).

---

## Table of Contents
1. [Why media-processing?](#-why-media-processing)
2. [Install & loading](#-install--loading)
3. [Quick start](#-quick-start)
4. [Browser-compatible API](#-browser-compatible-api)
5. [Node.js API](#-nodejs-api)
6. [HLS](#-hls)
7. [Bitstream utilities](#-bitstream-utilities)
8. [Supported codecs & containers](#-supported-codecs--containers)
9. [Hardware acceleration](#-hardware-acceleration)
10. [Comparison with other libraries](#-comparison-with-other-libraries)
11. [Use cases](#-use-cases)
12. [Project structure](#-project-structure)
13. [Roadmap](#-roadmap)
14. [Limitations & tradeoffs](#️-limitations--tradeoffs)
15. [Compatibility matrix](#-compatibility-matrix)
16. [How it works](#️-how-it-works)
17. [License](#-license)


## 🧠 Why media-processing?

Two problems, one library:

1. **Node.js has no built-in media encoding/decoding**, and existing solutions need native C++ bindings (complex builds) or WASM (slow startup, big bundles). None give you the browser's clean `VideoEncoder` / `VideoDecoder` API.
2. **Producing HLS used to require a server.** Multi-bitrate, encrypted streams with captions and ad markers meant operating a transcode fleet — even when the content originated in the browser.

media-processing solves both, and does it the same way on both sides of the wire:

- **`npm install` and go** — zero native bindings, zero build step on the Node side.
- **Browser-compatible API** — the same `VideoEncoder`, `VideoDecoder`, `VideoFrame`, `MediaStream` classes you use in Chrome.
- **A real HLS encoder built in** — take `VideoFrame` / `AudioData`, get HLS segments and playlists. TS or fMP4, LL-HLS parts, AES-128, CEA-608 captions, WebVTT/IMSC subtitles, ABR ladders, I-frame playlists, HDR, ID3, SCTE-35, Interstitials.
- **HLS reading too** — `parseMediaPlaylist` / `parseMasterPlaylist` turn an `.m3u8` back into structured objects (the exact inverse of the writers).
- **Isomorphic** — in Node, encoding runs through FFmpeg child processes; in the browser, through native WebCodecs. The library code above that line is identical.
- **Realtime-first** — designed for WebRTC, streaming, conferencing: SVC temporal layers, error-resilient encoding, frame pacing, backpressure.

### What "isomorphic" means here

The library implements the same **class names, method signatures, and data flow** as the W3C WebCodecs spec. The engine underneath differs by environment:

- **In the browser**, `VideoEncoder` / `AudioEncoder` are the platform's native WebCodecs — hardware-accelerated, zero process overhead.
- **In Node.js**, they're a polyfill backed by FFmpeg child processes (`spawn('ffmpeg', …)` over pipes). Same inputs, same outputs, same callbacks.

Higher-level pieces — the HLS muxer, playlist builders/parsers, bitstream utilities — are pure JavaScript and behave identically in both. The one place you choose an engine is the **codec seam** (see [the seam](#the-codec-seam-how-isomorphism-works)).

Caveats for the Node/FFmpeg engine specifically: force-keyframe is implemented by restarting FFmpeg (~50 ms one-frame latency; browsers do it internally), per-frame quantizer is applied as a global CRF, alpha is `'discard'`-only, and first-frame latency is ~100 ms for process startup (steady-state is codec-bound, not pipe-bound).


## 📦 Install & loading

### Node.js

```bash
npm install media-processing
```

> **FFmpeg** is required for the Node engine. If it isn't on your PATH:
> ```bash
> npm install ffmpeg-static
> ```
> media-processing auto-detects `ffmpeg-static` and `@ffmpeg-installer/ffmpeg` — no configuration. GStreamer is optional (camera capture only).

```js
import { VideoEncoder, HLSEncoder, parseMediaPlaylist } from 'media-processing';
```

### Browser

The browser build ships **two bundles**, so every loading style is covered:

| File | Format | How you load it |
|---|---|---|
| `media-processing.esm.js` | ES module | `import { … } from './media-processing.esm.js'` |
| `media-processing.umd.js` | UMD | `<script>` global · `require()` · AMD `define()` |

Build them with `npm run build:browser` (esbuild). Why two files? UMD covers CommonJS + AMD + a browser global, but **not** ES modules — `export`/`import` are static top-level forms that can't live inside a UMD function wrapper. So ESM is a separate file. This is the standard dual-bundle convention.

**Method 1 — ESM `import`:**
```html
<script type="module">
  import { HLSEncoder } from './media-processing.esm.js';
</script>
```

**Method 2 — global via `<script>` (no import):**
```html
<script src="./media-processing.umd.js"></script>
<script>
  const { HLSEncoder, Playlist } = MediaProcessing;   // single global
</script>
```

**Method 3 — `require()` / AMD** (Node consumers of the browser build, or legacy loaders):
```js
const MP = require('./media-processing.umd.js');
```

> Note: the package declares `"type": "module"`, so Node treats bare `.js` as ESM. To `require` the UMD build inside this package, give it a `.cjs` extension (or consume it from a non-`type:module` context). In the browser the extension is irrelevant — the `<script>` global path always works.

### The codec seam (how isomorphism works)

The only environment-specific decision is where `VideoEncoder` / `AudioEncoder` come from. `HLSEncoder` resolves them in this order:

```js
// 1. Explicitly injected — works anywhere, fully deterministic:
new HLSEncoder({ VideoEncoder, AudioEncoder, /* …options… */ });

// 2. Not injected → falls back to the global VideoEncoder / AudioEncoder.
//    • Browser: those globals are the native WebCodecs implementations,
//      so you can construct HLSEncoder with no codec options at all.
//    • Node: call installWebCodecsPolyfill() once to register the
//      FFmpeg-backed classes on globalThis (or inject them via option 1).
import { installWebCodecsPolyfill } from 'media-processing';
installWebCodecsPolyfill();
new HLSEncoder({ /* no codec options needed — resolved from globals */ });
```

So the same `HLSEncoder` pipeline runs in a browser tab (native hardware encoders) and in a Node service (FFmpeg-backed polyfill) with no code changes above the seam.


## 🚀 Quick start

### Encode video (WebCodecs)

```js
import { VideoEncoder, VideoFrame } from 'media-processing';

const encoder = new VideoEncoder({
  output: (chunk, metadata) => { /* chunk = encoded frame */ },
  error:  (e) => console.error(e),
});

encoder.configure({ codec: 'vp9', width: 1280, height: 720, bitrate: 2_000_000, framerate: 30 });

const frame = new VideoFrame({ data: yuvBuffer, format: 'I420', codedWidth: 1280, codedHeight: 720, timestamp: 0 });
encoder.encode(frame);
await encoder.flush();
encoder.close();
```

### Decode video (WebCodecs)

```js
import { VideoDecoder } from 'media-processing';

const decoder = new VideoDecoder({ output: (frame) => frame.close(), error: console.error });
decoder.configure({ codec: 'vp9', codedWidth: 1280, codedHeight: 720 });
decoder.decode(encodedChunk);
await decoder.flush();
decoder.close();
```

### Produce an HLS stream

```js
import { HLSEncoder } from 'media-processing';   // browser: from './media-processing.esm.js'

const encoder = new HLSEncoder({
  format: 'fmp4',                 // 'ts' | 'fmp4'
  mode:   'live',                 // 'live' | 'event' | 'vod'
  segmentDuration: 6,
  video: { codec: 'h264', width: 1280, height: 720, bitrate: 2_500_000 },
  audio: { codec: 'aac',  sampleRate: 48000, channels: 2 },
});

encoder.on('segment',  ({ uri, bytes }) => upload(uri, bytes));
encoder.on('manifest', (m3u8) => upload('stream.m3u8', m3u8));

// Feed VideoFrame / AudioData from any source — MediaStreamTrack, canvas, decoded files, generated content:
encoder.feed(videoFrame);
encoder.feed(audioData);
encoder.end(() => console.log('done'));
```

### Browser-compatible polyfill (Node)

`installWebCodecsPolyfill()` registers every WebCodecs class on `globalThis` (and wires `navigator.mediaDevices`), so browser code runs unchanged under Node:

```js
import { installWebCodecsPolyfill } from 'media-processing';
installWebCodecsPolyfill();

// Browser-style code now works as-is in Node:
const encoder  = new VideoEncoder({ output: fn, error: fn });
const stream   = await navigator.mediaDevices.getUserMedia({ video: true });
const recorder = new MediaRecorder(stream, { mimeType: 'video/mp4; codecs=h264,aac' });
```

(Node-only — the browser already provides these globals natively. You can also import the classes by name instead of installing globals.)


## ✨ Browser-compatible API

Implements [W3C WebCodecs](https://www.w3.org/TR/webcodecs/), [MediaStream Recording](https://www.w3.org/TR/mediastream-recording/), [Screen Capture](https://www.w3.org/TR/screen-capture/), and [Insertable Streams](https://www.w3.org/TR/mediacapture-transform/). If you know the browser API, you know this library.

**Implemented classes:** `VideoEncoder`, `VideoDecoder`, `AudioEncoder`, `AudioDecoder`, `VideoFrame`, `AudioData`, `EncodedVideoChunk`, `EncodedAudioChunk`, `VideoColorSpace`, `ImageDecoder`, `MediaStream`, `MediaStreamTrack`, `MediaRecorder`, `MediaStreamTrackProcessor`, `MediaStreamTrackGenerator`, `getUserMedia`, `getDisplayMedia`, `enumerateDevices`, `MediaCapabilities`.

### What differs in the Node engine

| Feature | Browser (native) | Node (FFmpeg engine) | Notes |
|---|---|---|---|
| Encoding/decoding | Native codec stack | FFmpeg child processes | Same API & results, different engine |
| Force keyframe | Internal | Restarts FFmpeg (~50 ms) | One-time latency per forced IDR |
| Per-frame quantizer | Per-frame QP | Global CRF | FFmpeg CLI limitation |
| Alpha channel | `'keep'` | `'discard'` only | Planned |
| First-frame latency | ~0 ms | ~100 ms | Process startup |
| HW acceleration | Browser-managed | NVENC, QSV, VAAPI, VideoToolbox, AMF | Auto-detect + software fallback |
| SVC temporal layers | Chrome-only | ✅ L1T2, L1T3 | Drop-safe, integration tested |
| `getDisplayMedia` | User picker dialog | Full screen / window by title | No UI picker in Node |
| System audio | Tab capture | PulseAudio / Stereo Mix / virtual device | Platform-specific |
| Audio timestamps | Anchored to input | Anchored to input | Output `EncodedAudioChunk.timestamp` is anchored to the **first `AudioData`'s** timestamp plus accumulated duration; capture gaps >100 ms are preserved in the output timeline instead of silently compressed — keeps long sessions drift-free and A/V sync honest |
| H.264 bitstream form | AVCC + avcC record | Annex-B | Normalized automatically at the fMP4 seam (see [HLS notes](#node-engine-notes-fmp4)) — consumers see spec-valid output either way |

### MediaRecorder · getDisplayMedia · Breakout Box

```js
// MediaRecorder
const recorder = new MediaRecorder(stream, { mimeType: 'video/mp4; codecs=h264,aac', videoBitsPerSecond: 5_000_000 });
recorder.ondataavailable = (e) => fileStream.write(e.data);
recorder.start(1000); /* … */ recorder.stop();

// getDisplayMedia (Node: x11grab / gdigrab / avfoundation; system audio via PulseAudio / Stereo Mix)
const screen = await getDisplayMedia({ video: { width: 1920, height: 1080 }, audio: true });

// MediaStreamTrackProcessor / Generator (bridges tracks ⇄ Web Streams)
const processor = new MediaStreamTrackProcessor({ track: videoTrack });
const { value: frame } = await processor.readable.getReader().read();
```


## 🔧 Node.js API

Server-side features beyond the browser specs:

- **`MediaEncoder`** — combined video + audio through a single FFmpeg process (video on `pipe:0`, audio on `pipe:4`), container `'ts' | 'fmp4' | 'ivf' | 'adts'`.
- **`Demuxer`** — file → encoded frames, with `probe()`, auto `videoDecoderConfig`, `start({ startTime, duration })`, and `seek()`.
- **`Muxer`** — encoded chunks → file (`.webm`, etc.).
- **`FramePacer`** — realtime FPS pacing with backpressure (`pause()` / `resume()` on encoder drain).
- **`VideoSource` / `VideoSink`** — wrtc-style push/consume of frames on a track.
- **`getUserMedia`** — camera via GStreamer (`v4l2src` / `avfvideosrc` / `mfvideosrc`) + mic via FFmpeg (`pulse` / `avfoundation` / `dshow`).
- **`VideoPlayer`** — preview window via ffplay.

```js
import { MediaEncoder } from 'media-processing';
const enc = new MediaEncoder({
  video: { codec: 'h264', width: 1920, height: 1080, framerate: 30 },
  audio: { codec: 'aac', sampleRate: 48000, numberOfChannels: 2 },
  container: 'ts',
  output: (data) => { /* interleaved A/V */ }, error: console.error,
});
enc.writeVideoFrame(videoFrame);
enc.writeAudioData(audioData);
await enc.flush();
```

**Advanced encoder tuning** — codec strings auto-derive profile/level, with raw-FFmpeg escape hatch:
```js
encoder.configure({
  codec: 'avc1.64002A',                 // → profile=high, level=4.2
  width: 1920, height: 1080,
  profile: 'high', level: '5.1',        // explicit overrides
  codecOptions: ['-tune', 'film', '-x264-params', 'ref=4:bframes=3'],
});
```


## 📺 HLS

A complete HLS **encoder** (raw frames → segments + playlists) and **parser** (playlists → structured objects). Targets RFC 8216bis feature coverage. Runs in the browser over native WebCodecs, or in Node over the FFmpeg polyfill.

### Core concepts

**What HLS is:** a manifest (`.m3u8` text listing media segments) plus a segmentation convention; everything moves over plain HTTP. This library produces both halves — **media segments** (byte buffers via the `'segment'` event) and the **manifest** (a string via the `'manifest'` event, re-emitted on every state change).

**Lifecycle:** `new HLSEncoder(opts)` → `encoder.ready(cb)` (optional, awaits async key import) → `feed(frame)` / `feedAudio(data)` (encoders configure lazily on the first frame) → `end(cb)` (drain, finalize, emit final segment).

**MPEG-TS vs fMP4 (CMAF):**

| Property | MPEG-TS (`.ts`) | fMP4 / CMAF (`.m4s` + init) |
|---|---|---|
| Init segment | None (self-contained) | One-time `init.mp4` |
| Audio codecs | AAC LC, HE-AAC v1/v2 | AAC, HE-AAC, **Opus** |
| Video codecs | H.264, H.265 | H.264, H.265, **VP9, AV1** |
| Overhead | ~10% | ~5% |
| LL-HLS parts | Patchy | Excellent |
| Player support | Universal (every player ever) | All modern players |

**Use fMP4 unless you specifically need TS** — smaller, faster, more codecs, LL-HLS-friendly, same file format as DASH.

**Modes:** `live` (sliding window — old segments fall off; `windowSize` controls how many stay, default 6), `event` (append-only DVR), `vod` (single shot, `EXT-X-PLAYLIST-TYPE:VOD` + `EXT-X-ENDLIST`). `event`/`vod` ignore `windowSize`.

### `HLSEncoder`

One encoder = one media playlist (one quality tier).

```js
new HLSEncoder({
  // Codec seam (see Install & loading) — omit to use globals
  VideoEncoder, AudioEncoder,

  // Container & lifecycle
  format: 'fmp4',                       // 'ts' | 'fmp4'
  mode: 'live',                         // 'live' | 'event' | 'vod'
  segmentDuration: 6,
  windowSize: 6,                        // sliding window for mode:'live'
  segmentUriPattern: 'seg-{n}.m4s',     // {n} = sequence number
  initSegmentUri: 'init.mp4',           // fMP4 only

  // Media
  video: {
    codec: 'h264',                      // 'h264' | 'h265' | 'vp9' | 'av1'
    width: 1920, height: 1080, bitrate: 5_000_000, framerate: 30,
    codecString: undefined,             // override auto-derived string
    hardwareAcceleration: 'no-preference',
    videoRange: 'SDR',                  // 'SDR' | 'HLG' | 'PQ'
    supplementalCodecs: undefined,      // Dolby Vision
  },
  audio: {
    codec: 'aac',                       // 'aac' | 'opus' (opus → fmp4 only)
    sampleRate: 48000, channels: 2, bitrate: 128_000,
    codecString: undefined,             // e.g. 'mp4a.40.5' (HE-AAC)
  },

  partDuration: 0,                      // > 0 enables LL-HLS
  encryption: undefined,                // see Feature guide
  captions: undefined,                  // CEA-608
  iFramePlaylist: false, iFramePlaylistUri: 'iframe.m3u8',
  forceKeyframes: false,                // IDR at every segment boundary
})
```

**Methods**
- Lifecycle: `ready(cb)`, `feed(input, ptsUs?)`, `feedVideo(frame, ptsUs?)`, `feedAudio(data, ptsUs?)`, `feedMetadata({ data, timestampUs, durationUs? })`, `end(cb)`.
- Captions & metadata: `addCaption({ start, end, text })`, `addDateRange({ id, startDate, … })`, `removeDateRange(id)`, `addInterstitial({ id, startDate, assetUri, … })`, `define({ name, value | import | queryparam })`, `setStart({ timeOffset, precise? })`, `setRenditionReport({ uri, lastMsn, lastPart? })`.
- Master helpers: `getStreamInf({ uri, … })`, `getIFrameStreamInf({ uri, … })`, `getClosedCaptionsRendition({ … })`.

**Events**
```js
encoder.on('segment',         ({ kind, bytes, uri, duration, sequence, parts, iFrame }) => {});
encoder.on('manifest',        (m3u8Text) => {});
encoder.on('iframe-playlist', (m3u8Text) => {});   // when iFramePlaylist enabled
encoder.on('error',           (err) => {});
```
`kind` is `'init'` (fMP4 init segment) or `'media'`. `parts` is populated in LL-HLS mode; `iFrame` describes the keyframe byte range when I-frame playlists are on.

### `SubtitleEncoder`

Standalone WebVTT or IMSC TTML rendition — its own playlist + segments.

```js
import { SubtitleEncoder } from 'media-processing';

const subs = new SubtitleEncoder({ format: 'webvtt', language: 'en', segmentDuration: 6 });
subs.on('segment', ({ bytes, uri }) => upload(uri, bytes));
subs.addCue({ start: 0, end: 3, text: 'Hello' });
subs.end();
const rendition = subs.getRendition({ groupId: 'subs', name: 'English', uri: 'subs.m3u8', default: true });
```

### `buildMasterPlaylist`

Pure function building a multivariant playlist from descriptors.

```js
import { buildMasterPlaylist } from 'media-processing';

const m3u8 = buildMasterPlaylist({
  variants: [
    { uri: '720p.m3u8',  bandwidth: 2_500_000, codecs: 'avc1.640028,mp4a.40.2', resolution: '1280x720', frameRate: 30, audio: 'aud', subtitles: 'subs' },
    { uri: '1080p.m3u8', bandwidth: 5_000_000, codecs: 'avc1.640028,mp4a.40.2', resolution: '1920x1080', frameRate: 30, audio: 'aud', subtitles: 'subs' },
  ],
  audioRenditions: [
    { groupId: 'aud', name: 'English', language: 'en', uri: 'aud-en.m3u8', default: true },
    { groupId: 'aud', name: 'Spanish', language: 'es', uri: 'aud-es.m3u8' },
  ],
  subtitleRenditions: [{ groupId: 'subs', name: 'English', language: 'en', uri: 'subs-en.m3u8' }],
  closedCaptions:     [{ groupId: 'cc', name: 'CC1', language: 'en', instreamId: 'CC1' }],
  iFrameVariants:     [{ uri: '720p-iframe.m3u8', bandwidth: 250_000, codecs: 'avc1.640028', resolution: '1280x720' }],
  independentSegments: true,
});
```

Supports full RFC 8216bis attributes: `STABLE-VARIANT-ID`, `STABLE-RENDITION-ID`, `SCORE`, `PATHWAY-ID`, `ALLOWED-CPC`, `CHARACTERISTICS`, `ASSOC-LANGUAGE`, `BIT-DEPTH`, `VIDEO-RANGE`, `SUPPLEMENTAL-CODECS` (Dolby Vision), `REQ-VIDEO-LAYOUT`, plus `defines`, `sessionData`, `sessionKeys`, and `contentSteering`.

### `Playlist` (low-level)

The internal media-playlist builder — `HLSEncoder` / `SubtitleEncoder` use it, but it's exposed for manual control.

```js
import { Playlist } from 'media-processing';

const p = new Playlist({ mode: 'live', windowSize: 6, targetDuration: 6, partTargetDuration: 1.0, initSegmentUri: 'init.mp4' });
p.addSegment({ uri: 'seg-0.m4s', duration: 6.0 });
p.addPart({ uri: 'seg-1.m4s', duration: 1.0, byteOffset: 0, byteLength: 12345 });
p.setKey({ method: 'AES-128', uri: 'key.bin' });
console.log(p.serialize());
```

### Reading HLS: `parseMediaPlaylist` / `parseMasterPlaylist`

The exact inverse of the writers. The parsed objects use the **same field names** the builders accept, so a playlist round-trips writer → parser → writer.

```js
import { parseMediaPlaylist, parseMasterPlaylist } from 'media-processing';

const media = parseMediaPlaylist(m3u8Text);
// → { version, targetDuration, mediaSequence, playlistType, endlist,
//     map: { uri, byterange }, segments: [{ uri, duration, byterange, discontinuity,
//     programDateTime, gap, bitrate, key, … }] }

const master = parseMasterPlaylist(m3u8Text);
// → { version, independentSegments, variants: [{ uri, bandwidth, averageBandwidth,
//     codecs, resolution, frameRate, videoRange, audio, … }],
//     iFrameVariants, audioRenditions, subtitleRenditions, closedCaptionsRenditions }
```

Handles real-world manifests: CRLF, reordered/unknown tags (ignored, forward-compatible), `CODECS` strings containing commas, `EXT-X-MAP`, and implicit `BYTERANGE` offset continuation. Useful for re-muxing, conformance testing, ABR-ladder introspection, and HLS player tooling.

### Feature guide

- **LL-HLS** — set `partDuration` (e.g. `1.0`); emits `EXT-X-PART-INF`, `EXT-X-PART` (with `BYTERANGE`), `EXT-X-PRELOAD-HINT`, and `EXT-X-RENDITION-REPORT` (via `setRenditionReport`). fMP4-only here. Sub-2-second glass-to-glass.
- **Encryption** — AES-128 segment-level via Web Crypto. Key bytes never leave the encoder (imported into a `CryptoKey`); only `keyUri` appears in `EXT-X-KEY`. `await ready()` before feeding.
- **CEA-608 captions** — encoded as SEI NAL units inside the H.264/H.265 bitstream. Latin-Extended escape sequences with ASCII fallback. `addCaption({ start, end, text })`; declare via `closedCaptions` in the master.
- **WebVTT / IMSC subtitles** — Unicode script-track renditions via `SubtitleEncoder`. WebVTT is universal; IMSC TTML for rich styling/positioning.
- **ABR ladders** — run one `HLSEncoder` per tier, stitch with `buildMasterPlaylist`. `getStreamInf` auto-derives `BANDWIDTH` (monotonic per spec), `AVERAGE-BANDWIDTH`, `CODECS`, `RESOLUTION`, `FRAME-RATE` from real output.
- **I-frame playlists (trick play)** — `iFramePlaylist: true` emits a keyframe-byte-range playlist for scrubbing/thumbnails. Plugs into the master via `getIFrameStreamInf` / `iFrameVariants`.
- **HDR** — `videoRange: 'HLG' | 'PQ'` (+ `supplementalCodecs` for Dolby Vision) auto-populates `colr` / `mdcv` / `clli` boxes and flows `VIDEO-RANGE` / `SUPPLEMENTAL-CODECS` to the master.
- **Multi-channel audio** — up to 7.1 for fMP4. Built-in libopus 5.1/7.1 mappings; `CHANNELS` auto-derived for the master.
- **Timed metadata (ID3)** — `feedMetadata(...)`: `emsg` boxes in fMP4, a dedicated ID3 PES stream (type `0x15`) in TS.
- **DateRanges & SCTE-35** — `addDateRange({ id, startDate, scte35Out / scte35In, … })`, plus generic chapters/EPG via `custom: { 'X-…': … }`.
- **HLS Interstitials** — `addInterstitial(...)`: Apple structured ad insertion (incl. WWDC25 skip-control/timeline attributes), backwards-compatible as a plain DATERANGE.
- **`EXT-X-DEFINE`** — `define({ name, value })` (literal), `define({ import })`, or `define({ queryparam })` (HLS v11+), used as `{$VAR}` in subsequent URIs/attributes.

### Node engine notes (fMP4) <a name="node-engine-notes-fmp4"></a>

The fMP4 path was designed against the browser-WebCodecs contract
(AVCC length-prefixed samples + an `AVCDecoderConfigurationRecord` in
`decoderConfig.description`). The Node FFmpeg engine emits Annex-B in
both places — so the encoder seam now **detects and normalizes**:

- The Annex-B parameter sets are converted into a spec-valid `avcC`
  record (ISO 14496-15 §5.2.4.1) for the init segment.
- Every access unit is converted to 4-byte length-prefixed form for
  `mdat`.

Both conversions are detection-gated: in the browser (input already
AVCC) they are provable no-ops. Result: fMP4/H.264 segments produced
in Node play in hls.js and Safari, byte-layout identical in spirit to
browser output.

**Known limitation:** H.265 + fMP4 from the Node engine requires an
`hvcC` record, whose construction needs bit-level VPS/SPS parsing —
not implemented yet. The encoder fails loudly (`console.warn` with
guidance) instead of emitting a broken init segment. Use `format:
'ts'` for H.265 from Node, or H.264 for fMP4. (Browser H.265 fMP4 is
unaffected — native WebCodecs provides the record.)


## 🔬 Bitstream utilities

Low-level tools for RTP packetization, SFU routing, and manual muxing:

```js
import {
  splitNALUs, extractParameterSets, annexbToAvcc, avccToAnnexb,
  buildAvcCFromAnnexB,
  splitOBUs, extractSequenceHeader, parseCodecDetails,
} from 'media-processing';

const nalus  = splitNALUs(annexbBuffer);            // → [{ type, data }]
const avcc   = annexbToAvcc(annexbBuffer);          // → length-prefixed (MP4)
const record = buildAvcCFromAnnexB(spsPpsAnnexB);   // → AVCDecoderConfigurationRecord (avcC box body)
const obus   = splitOBUs(av1Buffer);                // → [{ type, data, temporalId, spatialId }]
const detail = parseCodecDetails('avc1.64002A');    // → { name:'h264', profile:'high', level:'4.2', … }
```

### Audio level helpers

Pure per-frame loudness computation over an `AudioData` — the
building block for WebRTC's RFC 6464 `ssrc-audio-level` extension and
for any "who is speaking" UI:

```js
import { computeAudioRms, computeAudioDbov } from 'media-processing';

const rms  = computeAudioRms(audioData);    // 0..1, all channels pooled
const dbov = computeAudioDbov(audioData);   // RFC 6464 scale: 0 = loudest, 127 = silence
```

Format-agnostic (uses `copyTo` with f32 conversion, so u8/s16/s32/f32
and their planar variants all work). `webrtc-server` calls
`computeAudioDbov` per outgoing frame to stamp audio levels on RTP —
the framing itself lives in `rtp-packet`; only the math lives here.

The browser build also surfaces byte-level primitives (`readU24BE`, `writeU32BE`, `concat`, `fromAscii`, …) and `EventEmitter` for consumers that build directly on the bitstream layer.


## 🎛 Supported codecs & containers

| | |
|---|---|
| **Video** | VP8, VP9, AV1, H.264, H.265 |
| **Audio** | AAC, Opus, MP3, FLAC, Vorbis, G.711 (a/µ-law), PCM (s16le/f32le) |
| **Container readers** | Annex-B, IVF, ADTS, fMP4 (tfdt/trun), MPEG-TS (PAT→PMT→PES), OGG |
| **Container writers** | Annex-B, IVF, ADTS, fMP4/CMAF, MPEG-TS, OGG |
| **HLS video** | H.264, H.265 (TS + fMP4) · VP9, AV1 (fMP4) |
| **HLS audio** | AAC, HE-AAC (TS + fMP4) · Opus (fMP4) |


## ⚡ Hardware acceleration

In the **browser**, encoding uses the platform's native hardware encoders (set `video.hardwareAcceleration: 'prefer-hardware'` for HD/4K). In **Node**, GPU encoders are auto-detected with software fallback:

| Platform | Encoders |
|---|---|
| **NVIDIA** | h264_nvenc, hevc_nvenc, av1_nvenc |
| **Intel QSV** | h264_qsv, hevc_qsv, vp9_qsv, av1_qsv |
| **AMD AMF** | h264_amf, hevc_amf |
| **Apple VideoToolbox** | h264_videotoolbox, hevc_videotoolbox |
| **VAAPI** | h264_vaapi, hevc_vaapi, vp9_vaapi, av1_vaapi |


## 📊 Comparison with other libraries

**As a WebCodecs runtime for Node** (vs native-binding alternatives):

| | **media-processing** | **@napi-rs/webcodecs** | **boulabiar/webcodecs-node** |
|---|---|---|---|
| W3C WebCodecs API | ✅ Full | ✅ Full | ✅ Full |
| Dependencies / build | **0 / none** | Rust/NAPI-RS | node-av (C++) |
| MediaStream / Recorder / getUserMedia / getDisplayMedia | ✅ | ❌ | ❌ |
| MediaEncoder · FramePacer · SVC · Source/Sink · VideoPlayer | ✅ | ❌ | ❌ |
| **Built-in HLS encoder + parser** | ✅ | ❌ | ❌ |
| Polyfill mode | ✅ | ❌ | ✅ |
| Alpha / zero-copy GPU | ❌ | ✅ | ❌ |
| **Best for** | **Realtime streaming + HLS** | File processing | General purpose |

Native bindings give lower per-frame latency and zero-copy GPU paths; our edge is operational simplicity (no build failures, no platform binaries, fully debuggable in JS) and the fact that the **same code runs in the browser**.

**As an HLS encoder** (the browser camp; server-side packagers shown for feature reference):

| HLS capability | media-processing | shaka-packager¹ | FFmpeg¹ | hls.js | ffmpeg.wasm |
|---|---|---|---|---|---|
| Runs in the browser | ✅ | ❌ | ❌ | ✅ (player) | ✅ |
| Playlist generation (RFC 8216bis) | ✅ Full | ✅ Full | partial | ❌ | via CLI |
| **Playlist parsing** | ✅ | ✅ | ✅ | ✅ | via CLI |
| MPEG-TS · fMP4/CMAF | ✅ · ✅ | ✅ · ✅ | ✅ · ✅ | ❌ | ✅ · ✅ |
| Encodes from raw frames | ✅ WebCodecs | ❌ packager | ✅ | n/a | ✅ |
| LL-HLS parts | ✅ | ✅ | ✅ | (player) | via CLI |
| AES-128 encryption | ✅ | ✅ +CTR | ✅ | (decrypt) | ✅ |
| CEA-608 · WebVTT · IMSC | ✅ encode | partial · ✅ · ✅ | ✅ | decode | ✅ |
| Multivariant · I-frame · HDR · Dolby Vision | ✅ | ✅ | ✅ / partial | (parse) | ✅ / partial |
| Interstitials (WWDC25) · SCTE-35 · DateRange · DEFINE | ✅ | ✅ | partial | (parse) | partial |
| Widevine/PlayReady/FairPlay DRM · DASH · AC-3 | ❌ | ✅ | partial | (decrypt) | ✅ |
| Footprint | Small (pure JS) | Native binary | Native binary | ~350 KB | ~25 MB WASM |

¹ Server-side tools, included for HLS feature reference.

**Pick media-processing** when content is *produced* in the browser (webcam, canvas, editors, generated) or you want one isomorphic codebase for capture + HLS. **Pick shaka-packager/FFmpeg** for DRM, DASH, AC-3, or packaging already-encoded assets at CDN scale. **Pick hls.js** to *play* HLS in non-Safari browsers.


## 💡 Use cases

Each replaces what was traditionally a server with a few hundred kilobytes of JavaScript:

1. **Live broadcasting from the browser** — webcam → HLS segments → CDN (or YouTube Live HLS ingest at 4K HDR). No RTMP server, no FFmpeg fleet.
2. **In-browser video editors with HLS export** — render the timeline once, get a full ABR ladder with chapters, captions, HDR. Raw footage never leaves the device.
3. **Privacy-first / end-to-end encrypted video** — AES-128 inside Web Crypto before bytes leave the page; the CDN sees only ciphertext (medical, legal, journalistic).
4. **Offline-first PWAs** — encode and store HLS locally, sync to a CDN later.
5. **Real-time collaborative video** and **generative / AI-driven streaming** — encode synthesized frames straight to HLS.
6. **Edge-class deployments** (Pi / kiosk / smart device) — small footprint, no native toolchain.
7. **Hybrid live + DVR + VOD** — `live` / `event` / `vod` modes from one API.
8. **HLS player conformance testing** — generate (or parse) manifests exercising specific RFC 8216bis attributes.
9. **Server-side transcoding & re-muxing in Node** — FFmpeg-backed WebCodecs + the same HLS muxer/parser, no browser required.


## 📁 Project structure

```
media-processing/
├── index.js                    - package entry (123 exports)
├── build-browser.js            - esbuild → dist/*.esm.js + *.umd.js
├── package.json                - ESM, conditional exports (browser/node)
├── dist/
│   ├── media-processing.esm.js   ESM bundle (import)
│   └── media-processing.umd.js   UMD bundle (script global / require / AMD)
├── src/
│   ├── video_encoder.js · video_decoder.js · audio_encoder.js · audio_decoder.js
│   ├── video_frame.js · audio_data.js · encoded_chunk.js · video_color_space.js
│   ├── media_encoder.js · media_recorder.js · muxer.js · demuxer.js
│   ├── media_stream.js · track_processor.js · media_source_sink.js
│   ├── get_user_media.js · media_capabilities.js · image_decoder.js
│   ├── frame_pacer.js · video_player.js · ffplay_viewer.js · pixel_utils.js
│   ├── hls_encoder.js · subtitle_encoder.js · segment_builder.js   ← HLS
│   ├── playlist.js · master_playlist.js                            ← HLS write + read
│   ├── cea608_encoder.js · encryption.js                           ← HLS captions / AES
│   ├── writer_ts.js · writer_fmp4.js · writer_{ivf,adts,annexb,ogg}.js
│   ├── reader_{annexb,ivf,adts,fmp4,ts,ogg}.js
│   ├── codecs.js · codec_strings.js · containers.js · hw_accel.js
│   ├── base_coder.js · ffmpeg_process.js · gstreamer_process.js
│   ├── core/   - bytes, events, byte_queue, frame_queue, buffer_source, dom_exception
│   └── utils/  - nalu_utils, aac_utils, opus_utils, codec_strings, playlist_utils, ts_constants
├── tests/                      - WebCodecs + HLS + m3u8-parse + FFmpeg suites
└── LICENSE                     - Apache-2.0
```


## 🛣 Roadmap

**✅ Done**
- W3C WebCodecs (encoders, decoders, all data classes) + MediaStream / MediaRecorder / Breakout Box / getUserMedia / getDisplayMedia / `installWebCodecsPolyfill`
- **Isomorphic operation** — same API over native WebCodecs (browser) or FFmpeg (Node)
- **Dual browser build** — ESM + UMD bundles (import · global · require · AMD)
- **HLS encoder** — TS + fMP4, LL-HLS parts, AES-128, CEA-608, WebVTT/IMSC, ABR, I-frame, HDR, multi-channel, ID3, SCTE-35/DateRange, Interstitials, EXT-X-DEFINE
- **HLS parser** — `parseMediaPlaylist` / `parseMasterPlaylist` (round-trip-symmetric with the writers)
- Hardware acceleration (NVENC/QSV/VAAPI/VideoToolbox/AMF) · SVC L1T2/L1T3 · 6 container readers + writers
- Demuxer (seek + auto config) · Muxer · MediaEncoder · FramePacer · VideoPlayer · bitstream utilities

**⏳ Planned**
- Alpha-channel encoding (dual FFmpeg processes) · TypeScript type definitions
- WebM/MKV container muxers · Sample-AES · W3C Web Platform Tests validation
- HLS parser option 3 (encryption keys, date-ranges, advanced fMP4 maps)


## ⚠️ Limitations & tradeoffs

These apply to the **Node/FFmpeg engine** (the browser engine uses native WebCodecs and has none of them):

- **Process overhead** — one FFmpeg process per encoder/decoder (~5–15 MB RSS, ~100 ms first-frame startup; steady-state is just pipe `read`/`write`).
- **Force keyframe via restart** — `encode(frame, { keyFrame: true })` ends and respawns FFmpeg (~50 ms one-time; no data lost). The only way to force IDR with the FFmpeg CLI.
- **No per-frame QP** — accepted for API compatibility, applied as global CRF.
- **Copy at pipe boundaries** — data crosses a pipe twice (inherent to child-process IPC); readers use pre-allocated flat buffers to limit GC pressure.
- **No zero-copy GPU path** — always via CPU memory; native bindings win for 4K+/multi-stream GPU workflows.
- **Process cleanup** — always call `close()` / `stop()` in cleanup handlers (SIGTERM → 2 s → SIGKILL); a `kill -9` can orphan FFmpeg.


## 📋 Compatibility matrix

**Node engine**

| Requirement | Minimum | Recommended |
|---|---|---|
| Node.js | 16.0+ | 20+ |
| FFmpeg | 4.4+ | 6.0+ (AV1 libaom, SVC) |
| GStreamer (optional) | 1.16+ | 1.20+ |
| OS | Linux, macOS, Windows | all equal |

**Browser engine** (WebCodecs availability varies by browser/platform — always check `await VideoEncoder.isConfigSupported(cfg)`):

| Codec | Chrome 94+ | Safari 16.4+ | Firefox 130+ |
|---|---|---|---|
| H.264 / AAC LC | ✅ / ✅ | ✅ / ✅ | ✅ / ✅ |
| H.265 (HEVC) | ✅ (HW) | ✅ | partial |
| VP9 | ✅ | partial | ✅ |
| AV1 | ✅ | ✅ (Apple Silicon) | ✅ |
| Opus (fMP4) | ✅ | ✅ | ✅ |

Encryption needs Web Crypto (all modern browsers); capture sources need `MediaStreamTrackProcessor`.


## ⚙️ How it works

**Browser:** `HLSEncoder` feeds frames to native `VideoEncoder` / `AudioEncoder`; encoded chunks flow into the pure-JS muxer (`writer_ts` / `writer_fmp4`) and playlist builder, which emit `'segment'` and `'manifest'` events.

**Node:** the same pipeline, except `VideoEncoder` / `AudioEncoder` are the FFmpeg-backed polyfill — each spawns FFmpeg and communicates over pipes:

```
encoder.encode(videoFrame)
  → raw I420 to FFmpeg stdin (pipe:0)
  → FFmpeg (libx264/libvpx/libaom) → encoded bitstream on pipe:3
  → reader (AnnexB/IVF/ADTS) parses into frames
  → output(EncodedVideoChunk, metadata)   → muxer → 'segment' / 'manifest'
```

Above the codec seam, the muxer, playlist writers, playlist parsers, and bitstream utilities are identical in both environments.


## 📜 License

**Apache License 2.0** — Copyright © 2025 colocohen.
Licensed under the Apache License, Version 2.0. See `LICENSE` for the full text.
