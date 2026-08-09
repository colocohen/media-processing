/**
 * hls-encoder — User-facing HLS encoder built on WebCodecs.
 *
 * The single entry point of the library. Given raw frames (VideoFrame /
 * AudioData) or pre-encoded chunks, produces .ts segments and an m3u8
 * manifest, ready to upload to a CDN.
 *
 * Usage:
 *   var encoder = new HLSEncoder({
 *     segmentDuration: 6,
 *     mode: 'live',
 *     video: { codec: 'h264', width: 1280, height: 720,
 *              bitrate: 2_500_000, framerate: 30 },
 *     audio: { codec: 'aac',  sampleRate: 48000, channels: 2,
 *              bitrate: 128_000 },
 *   });
 *
 *   encoder.on('segment', function (info) {
 *     // info: { bytes:Uint8Array, uri, duration, sequence }
 *     uploadToCdn(info.uri, info.bytes);
 *   });
 *
 *   encoder.on('manifest', function (m3u8) {
 *     uploadToCdn('playlist.m3u8', m3u8);
 *   });
 *
 *   encoder.on('error', function (err) { console.error(err); });
 *
 *   // Drive it with frames, then finalize:
 *   cameraFrames.on('frame', function (frame) { encoder.feed(frame); });
 *   cameraFrames.on('ended', function () {
 *     encoder.end(function () {
 *       // Every segment has been emitted and the manifest carries
 *       // EXT-X-ENDLIST. Safe to play back or finish uploading here.
 *     });
 *   });
 *
 * end() also returns a Promise when no callback is given, for callers
 * who prefer that. Either way, the work is NOT finished when end()
 * returns — the final partial segment is emitted during it.
 *
 * Architecture (top-down):
 *
 *   feed(VideoFrame)         feed(AudioData)
 *        │                        │
 *        ▼                        ▼
 *   VideoEncoder              AudioEncoder
 *   (Annex-B output)          (ADTS output)
 *        │                        │
 *        └─────────┬──────────────┘
 *                  ▼
 *           SegmentBuilder    ◄──  decides when to seal a segment
 *                  │
 *                  ▼
 *           TSWriter          ◄──  produces .ts bytes
 *                  │
 *                  ▼
 *           Playlist          ◄──  m3u8 manifest, sliding window
 *                  │
 *                  ▼
 *           on('segment'), on('manifest')
 *
 * Encoder configuration choices:
 *   - We configure VideoEncoder with `avc:{format:'annexb'}` (or hevc
 *     equivalent), so output chunks are already in Annex-B format with
 *     SPS/PPS in-band at every keyframe. No avcC parsing or parameter-
 *     set injection is needed in our pipeline.
 *   - We configure AudioEncoder with `aac:{format:'adts'}`, so output
 *     chunks are already ADTS-wrapped. No aac-utils.wrapAdts call is
 *     needed in our pipeline.
 *   - These delegate the heavy lifting to the platform — both formats
 *     are widely supported (Chrome, Edge; Safari 16.4+ for video and
 *     newer Safari for AAC ADTS). Older browsers will fail at
 *     configure() time with a clear error.
 *
 * Keyframe forcing:
 *   - The encoder marks `keyFrame:true` on the first frame whose
 *     timestamp is at least `segmentDuration` seconds past the
 *     previous forced keyframe. This guarantees segments begin
 *     within one frame interval of the target boundary.
 *   - Caller can disable forcing via opts.forceKeyframes:false (e.g.
 *     for transmux scenarios where the source already has good GOPs).
 */

import TSWriter from './writer_ts.js';
import FMP4Writer from './writer_fmp4.js';
import Playlist from './playlist.js';
import SegmentBuilder from './segment_builder.js';
import EventEmitter from './core/events.js';
import { isValidVideoRange } from './utils/playlist_utils.js';
import { createEncryptor, ivFromHex, ivToHex } from './encryption.js';
import CEA608Encoder, { buildCea608SeiNalu } from './cea608_encoder.js';
import { injectSeiIntoAU, detectFormat, annexbToAvcc, buildAvcCFromAnnexB } from './utils/nalu_utils.js';


// Fallback frame duration when the encoder doesn't report chunk.duration.
// Used by the CEA-608 caption injection path to compute the frame's
// PTS window [pts, pts+frameDuration). 30fps (1/30s = 33,333 µs) is the
// safe NTSC default — a frame or two of imprecision in the cc_data
// pacing has no perceptible impact on caption rendering. Modern
// encoders (Chrome's WebCodecs, etc.) populate chunk.duration so this
// is rarely the active path.
var _DEFAULT_FRAME_DURATION_US = 33333;

// AAC LC samples per frame — fixed by the spec. Used to compute the
// uniform PTS step for audio chunks (see _onAudioChunk's restamping
// logic and the comment at _audioFirstChunkPtsUs in the constructor).
// Same value lives in aac-utils.js for parsed ADTS frames.
var _AAC_LC_SAMPLES_PER_FRAME = 1024;

// Default audio sample rate when neither caller config nor the
// encoder's metadata provides one. 48 kHz is the universal modern
// default (browsers, WebCodecs, Opus, AAC encoders all default here).
var _DEFAULT_AUDIO_SAMPLE_RATE = 48000;


// ── Codec string defaults ─────────────────────────────────
//
// WebCodecs requires a codec string in `codec.profile.level` form.
// We pick conservative defaults that accept a wide range of inputs
// and decode on every modern player. Caller can override via
// opts.video.codecString / opts.audio.codecString.

function _defaultVideoCodecString(codec, width, height) {
  if (codec === 'h265') {
    // HEVC Main profile, Tier Main, Level 4.0 — covers 1080p30.
    return 'hev1.1.6.L120.B0';
  }
  if (codec === 'vp9') {
    // VP9 Profile 0 (8-bit 4:2:0). Level chosen by max resolution.
    if (width > 1920 || height > 1080) return 'vp09.00.50.08';   // L5.0 → 4K30
    if (width > 1280 || height > 720)  return 'vp09.00.40.08';   // L4.0 → 1080p30
    return 'vp09.00.31.08';                                       // L3.1 → 720p30
  }
  if (codec === 'av1') {
    // AV1 Main profile, 8-bit. Level 4.0 covers 1920x1080@30,
    // Level 5.0 covers 4K@30. The 'M' suffix denotes Main tier.
    if (width > 1920 || height > 1080) return 'av01.0.05M.08';   // L5.0
    return 'av01.0.04M.08';                                       // L4.0
  }
  // H.264. Resolution-aware default level: H.264 Level 3.1 caps at
  // 1280x720@30, so anything bigger needs Level 4.0.
  if (width > 1280 || height > 720) {
    return 'avc1.640028';   // High profile, Level 4.0
  }
  return 'avc1.42E01F';     // Baseline profile, Level 3.1
}

function _defaultAudioCodecString(codec) {
  if (codec === 'opus') return 'opus';
  return 'mp4a.40.2';  // AAC-LC
}

/**
 * Derive AAC encoder priming (number of samples the decoder needs to
 * skip at the start of the track) from the codec string. The trailing
 * AOT (Audio Object Type) value tells us which AAC variant Chrome
 * will emit:
 *
 *   AOT 2  = AAC LC                — 1024 samples priming (one frame)
 *   AOT 5  = HE-AAC v1 (SBR)       — 2048 samples priming (SBR doubles
 *                                    output rate, so one "frame" of
 *                                    output is 2048 samples)
 *   AOT 29 = HE-AAC v2 (SBR + PS)  — 2048 samples priming
 *
 * Without an elst entry skipping these samples, the audible audio
 * starts ~21 ms (LC) or ~43 ms (HE-AAC) later than the first video
 * frame. Returns 1024 for any `mp4a.*` we don't recognize — that's
 * the safe LC default and matches what most encoders emit.
 */
function _aacEncoderDelay(codecString) {
  if (codecString === 'mp4a.40.5' || codecString === 'mp4a.40.29') {
    return 2048;
  }
  return 1024;
}

/**
 * Derive the canonical HLS `CODECS` string for a video track. Each
 * codec has a different format that signals capability requirements
 * to the player — a wrong string can lead to the player rejecting
 * the variant before even attempting to fetch it.
 *
 * Source preference, from best to fallback:
 *   1. Caller-provided `video.codecString`           (canonical, ALWAYS wins)
 *   2. avcC/hvcC bytes captured from the encoder     (h264/h265 only)
 *   3. Built-in defaults                             (common-case profiles)
 *
 * Returns null if we don't have enough info to construct anything
 * meaningful (e.g., no opts.video at all).
 */
function _deriveVideoCodecString(opts, capturedConfig) {
  if (!opts) return null;
  if (opts.codecString) return opts.codecString;

  var codec = opts.codec || 'h264';

  if (codec === 'h264' && capturedConfig && capturedConfig.length >= 4) {
    // avcC bytes 1..3 = profile_idc, profile_compatibility, level_idc.
    // Codec string format: avc1.PPCCLL (lowercase hex, zero-padded).
    var p  = capturedConfig[1].toString(16); if (p.length  < 2) p  = '0' + p;
    var cc = capturedConfig[2].toString(16); if (cc.length < 2) cc = '0' + cc;
    var lv = capturedConfig[3].toString(16); if (lv.length < 2) lv = '0' + lv;
    return 'avc1.' + p + cc + lv;
  }

  if (codec === 'h265' && capturedConfig && capturedConfig.length >= 13) {
    // hvcC parsing is more complex; for the general case we fall back
    // to a reasonable default unless the user gave us a codecString.
    // The structured form is: hvc1.PROFILE.PROFILE_COMPAT.LEVEL.CONSTRAINTS.
    // Most mobile encoders produce Main profile @ Level 4.0.
    return 'hvc1.1.6.L120.B0';
  }

  // Defaults by codec — generic enough that any decoder advertising
  // support for that codec accepts them. Caller can override via
  // opts.codecString if they need precision.
  if (codec === 'h264') return 'avc1.42e01e';   // Constrained Baseline 3.0
  if (codec === 'h265') return 'hvc1.1.6.L93.B0'; // Main profile, Level 3.1
  if (codec === 'vp9')  return 'vp09.00.10.08'; // Profile 0, Level 1.0, 8bit
  if (codec === 'av1')  return 'av01.0.04M.08'; // Main profile, Level 3.0, 8bit
  return null;
}

/**
 * Derive the HLS CODECS string for an audio track.
 */
function _deriveAudioCodecString(opts) {
  if (!opts) return null;
  if (opts.codecString) return opts.codecString;
  if (opts.codec === 'opus') return 'opus';
  return 'mp4a.40.2';  // AAC LC default
}

/**
 * Estimate peak segment bitrate from configured rates plus container
 * overhead. Used as the BANDWIDTH attribute before the first media
 * segment is emitted. After segments start flowing, the empirical
 * measurement (HLSEncoder._peakBpsObserved) takes over.
 *
 * Container overhead approximations:
 *   fMP4 (CMAF): ~5%  — per-fragment moof boxes are small relative
 *                       to mdat, plus init segment is amortized
 *   MPEG-TS:    ~10% — per-packet 4-byte headers on 184-byte payloads
 *                       (~2.2%) plus PES headers, PAT/PMT, and the
 *                       fact that AAC frames carry ADTS wrappers
 *
 * Audio bitrate defaults: AAC LC ~128k stereo, HE-AAC ~64k, Opus ~96k.
 * We err on the conservative (high) side so the estimate isn't beaten
 * by reality on the first segment, which would force an immediate jump.
 */
function _estimateBandwidth(videoOpts, audioOpts, format) {
  var bps = 0;
  if (videoOpts) {
    bps += videoOpts.bitrate || 2500000;
  }
  if (audioOpts) {
    if (audioOpts.bitrate) {
      bps += audioOpts.bitrate;
    } else if (audioOpts.codec === 'opus') {
      bps += 96000;
    } else if (audioOpts.codecString === 'mp4a.40.5' ||
               audioOpts.codecString === 'mp4a.40.29') {
      bps += 64000;  // HE-AAC nominal
    } else {
      bps += 128000; // AAC LC nominal
    }
  }
  var overhead = (format === 'ts') ? 1.10 : 1.05;
  return Math.round(bps * overhead);
}

/**
 * Parse a VP9 WebCodecs codec string into the parameters that go into
 * a VPCodecConfigurationRecord.
 *
 * Format (ISO/IEC 14496-15 §A.4):
 *   vp09.PP.LL.DD[.CC.cP.tC.mC.fR]
 *
 *   PP = profile (00..03)
 *   LL = level (10,11,20,21,30,31,40,41,50,51,52,60,61,62)
 *   DD = bit depth (08,10,12)
 *   CC = chroma subsampling (default 01 = 4:2:0 colocated with luma)
 *   cP = colour primaries  (default 01 = BT.709)
 *   tC = transfer chars     (default 01 = BT.709)
 *   mC = matrix coefficients (default 01 = BT.709)
 *   fR = full range flag    (default 00 = limited / studio swing)
 *
 * Trailing fields are optional. We default each to standard BT.709
 * values when missing — these match what every WebCodecs encoder
 * produces for typical YUV input.
 */
function _parseVp9CodecString(codecStr) {
  var parts = codecStr.split('.');
  if (parts.length < 4 || parts[0] !== 'vp09') {
    throw new Error("HLSEncoder: invalid VP9 codec string '" + codecStr + "'");
  }
  return {
    profile:                  parseInt(parts[1], 10),
    level:                    parseInt(parts[2], 10),
    bitDepth:                 parseInt(parts[3], 10),
    chromaSubsampling:        parts[4] !== undefined ? parseInt(parts[4], 10) : 1,
    colourPrimaries:          parts[5] !== undefined ? parseInt(parts[5], 10) : 1,
    transferCharacteristics:  parts[6] !== undefined ? parseInt(parts[6], 10) : 1,
    matrixCoefficients:       parts[7] !== undefined ? parseInt(parts[7], 10) : 1,
    videoFullRangeFlag:       parts[8] !== undefined ? parseInt(parts[8], 10) : 0,
  };
}

/**
 * Build the 8-byte VPCodecConfigurationRecord body that goes inside
 * the vpcC FullBox. codecIntializationDataSize is always 0 — VP9
 * keyframes are self-describing in fMP4.
 */
function _buildVp9ConfigRecord(p) {
  var rec = new Uint8Array(8);
  rec[0] = p.profile & 0xFF;
  rec[1] = p.level   & 0xFF;
  // Packed byte: bitDepth(4) | chromaSubsampling(3) | videoFullRangeFlag(1)
  rec[2] = ((p.bitDepth & 0x0F) << 4) |
           ((p.chromaSubsampling & 0x07) << 1) |
           (p.videoFullRangeFlag & 0x01);
  rec[3] = p.colourPrimaries          & 0xFF;
  rec[4] = p.transferCharacteristics  & 0xFF;
  rec[5] = p.matrixCoefficients       & 0xFF;
  // rec[6..7] = codecIntializationDataSize (u16 BE) = 0
  return rec;
}


// ── AV1 codec-string parsing & av1C fallback construction ──
//
// These exist because Chrome's WebCodecs AV1 encoder does not reliably
// emit `metadata.decoderConfig.description` in realtime mode (verified
// against current Chromium builds). Without that description, the
// writer has no av1C box and the fMP4 init segment can't be produced.
// We work around it by parsing the encoded chunk bytes directly: the
// first keyframe always carries a Sequence Header OBU, which is the
// only payload av1C needs (the surrounding fixed 4-byte header is
// fully derivable from the codec string).
//
// Format references:
//   - AV1 spec §5.3.2 (OBU syntax)
//   - "AV1 Codec ISO Media File Format Binding" §2.3.1 (av1C record)
//   - WebCodecs codec-string syntax: av01.P.LLT.DD[.M.CIPyy[…]]

function _parseAv1CodecString(codecStr) {
  var parts = codecStr.split('.');
  if (parts.length < 4 || parts[0] !== 'av01') {
    throw new Error("HLSEncoder: invalid AV1 codec string '" + codecStr + "'");
  }
  var levelStr = parts[2];
  if (levelStr.length < 3) {
    throw new Error("HLSEncoder: invalid AV1 level/tier in codec string '" + codecStr + "'");
  }
  // Spec defaults when the optional tail is omitted: color (mono=0),
  // 4:2:0 chroma (subX=subY=1), chroma_sample_position=0 (Unknown).
  var monochrome = 0, subX = 1, subY = 1, chromaPos = 0;
  if (parts[4] !== undefined) monochrome = parseInt(parts[4], 10) || 0;
  if (parts[5] !== undefined && parts[5].length >= 3) {
    subX      = parseInt(parts[5].charAt(0), 10) || 0;
    subY      = parseInt(parts[5].charAt(1), 10) || 0;
    chromaPos = parseInt(parts[5].charAt(2), 10) || 0;
  }
  return {
    profile:    parseInt(parts[1], 10),
    level:      parseInt(levelStr.substring(0, 2), 10),
    tier:       levelStr.charAt(2) === 'H' ? 1 : 0,
    bitdepth:   parseInt(parts[3], 10),
    monochrome: monochrome,
    subX:       subX,
    subY:       subY,
    chromaPos:  chromaPos,
  };
}

/**
 * Walk OBUs in an AV1 chunk to find the Sequence Header OBU (type=1),
 * then build an AV1CodecConfigurationRecord with the seq_hdr embedded
 * verbatim as configOBUs. Returns null if no seq_hdr is present (the
 * chunk wasn't a keyframe, or the bitstream is in a format we don't
 * parse — old-style "OBU without size field").
 *
 * OBU header byte layout (AV1 §5.3.2):
 *   bit 7   forbidden       (=0)
 *   bits 6-3 obu_type       (4 bits)
 *   bit 2   extension_flag  (=> +1 byte after header)
 *   bit 1   has_size_field  (always 1 in MP4 / "low-overhead" format)
 *   bit 0   reserved        (=0)
 */
function _extractAv1ConfigFromChunk(au, codecString) {
  var p = _parseAv1CodecString(codecString);

  var seqHdrStart = -1, seqHdrEnd = -1;
  var off = 0;
  while (off < au.length) {
    var headerByte = au[off];
    var obuType = (headerByte >> 3) & 0x0F;
    var hasExt  = (headerByte >> 2) & 0x01;
    var hasSize = (headerByte >> 1) & 0x01;
    var obuStart = off;
    off++;
    if (hasExt) off++;

    // Without size field we can't deterministically walk OBUs in the
    // chunk. WebCodecs' AV1 output uses low-overhead format so this
    // shouldn't happen — bail rather than guess.
    if (!hasSize) return null;

    // LEB128 size (up to 8 bytes per AV1 spec §4.10.5).
    var size = 0, shift = 0, lebBytes = 0;
    while (off < au.length && lebBytes < 8) {
      var b = au[off];
      off++; lebBytes++;
      size |= (b & 0x7F) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }

    if (obuType === 1) {  // OBU_SEQUENCE_HEADER
      seqHdrStart = obuStart;
      seqHdrEnd   = off + size;
      break;
    }
    off += size;
  }

  if (seqHdrStart < 0 || seqHdrEnd > au.length) return null;

  var seqHdr = au.subarray(seqHdrStart, seqHdrEnd);
  var rec = new Uint8Array(4 + seqHdr.length);

  // Byte 0: marker(1)=1 + version(7)=1
  rec[0] = 0x81;
  // Byte 1: seq_profile(3) | seq_level_idx_0(5)
  rec[1] = ((p.profile & 0x07) << 5) | (p.level & 0x1F);
  // Byte 2: tier(1) | high_bitdepth(1) | twelve_bit(1) | mono(1) |
  //         subX(1) | subY(1) | chromaPos(2)
  rec[2] = ((p.tier & 0x01) << 7) |
           (((p.bitdepth >= 10 ? 1 : 0) & 0x01) << 6) |
           (((p.bitdepth === 12 ? 1 : 0) & 0x01) << 5) |
           ((p.monochrome & 0x01) << 4) |
           ((p.subX & 0x01) << 3) |
           ((p.subY & 0x01) << 2) |
           (p.chromaPos & 0x03);
  // Byte 3: reserved(3)=0 | initial_presentation_delay_present(1)=0 |
  //         reserved(4)=0
  rec[3] = 0;

  rec.set(seqHdr, 4);
  return rec;
}


// ══════════════════════════════════════════════════════════
//   HLSEncoder
// ══════════════════════════════════════════════════════════

/**
 * @param {object} opts
 * @param {string} [opts.format='ts']         'ts' (MPEG-TS .ts segments) or
 *                                            'fmp4' (Fragmented MP4 .m4s
 *                                            segments + init.mp4). fMP4 is
 *                                            recommended for new deployments
 *                                            (CMAF, lower overhead, DRM
 *                                            compatibility); TS for
 *                                            broadest legacy reach.
 * @param {number} [opts.segmentDuration=6]   Target segment length in seconds.
 * @param {string} [opts.mode='live']         'vod' | 'live' | 'event'
 * @param {number} [opts.windowSize=6]        Sliding-window size for live mode.
 * @param {string} [opts.segmentUriPattern]   URI template; {n} → segment number.
 *                                            Defaults to 'seg{n}.ts' or
 *                                            'seg{n}.m4s' based on format.
 * @param {string} [opts.initSegmentUri]      URI for the fMP4 init segment.
 *                                            Defaults to 'init.mp4'. Ignored
 *                                            for TS (which has no init).
 * @param {boolean}[opts.forceKeyframes=true] Force IDR at segment boundaries.
 * @param {boolean}[opts.independentSegments] Passed to Playlist.
 * @param {object} [opts.video]               Video config, or omit for audio-only.
 * @param {string} opts.video.codec           'h264' | 'h265' | 'vp9' | 'av1'.
 *                                            VP9 and AV1 require format='fmp4'.
 *                                            H.265 in MPEG-TS is technically
 *                                            written by the underlying writer
 *                                            but is non-spec for HLS — most
 *                                            players (hls.js, Safari) refuse
 *                                            to play it.
 * @param {number} opts.video.width
 * @param {number} opts.video.height
 * @param {number} [opts.video.bitrate=2_500_000]
 * @param {number} [opts.video.framerate=30]
 * @param {string} [opts.video.codecString]   Override default codec string.
 * @param {string} [opts.video.hardwareAcceleration]
 *                                            Pass-through to WebCodecs:
 *                                            'no-preference' (default — UA
 *                                            picks, almost always hardware
 *                                            when available),
 *                                            'prefer-hardware' (fail
 *                                            configure() if no HW available),
 *                                            'prefer-software' (useful for
 *                                            deterministic CI / tests).
 * @param {object} [opts.audio]               Audio config, or omit for video-only.
 * @param {string} opts.audio.codec           'aac' | 'opus'.
 *                                            Opus requires format='fmp4'.
 * @param {number} [opts.audio.sampleRate=48000]
 * @param {number} [opts.audio.channels=2]
 * @param {number} [opts.audio.bitrate=128_000]
 * @param {string} [opts.audio.codecString]   Override default codec string.
 */
function HLSEncoder(opts) {
  if (!opts) opts = {};
  if (!opts.video && !opts.audio) {
    throw new Error('HLSEncoder: at least one of opts.video / opts.audio is required');
  }

  var format = opts.format || 'ts';
  if (format !== 'ts' && format !== 'fmp4') {
    throw new Error("HLSEncoder: format must be 'ts' or 'fmp4' (got '" + format + "')");
  }

  // Audio codec validation. Opus is valid only in fMP4 (CMAF). Carrying
  // Opus in MPEG-TS exists in some niches (RFC 7587 / TS streams from
  // ffmpeg with --copy_unknown), but no major HLS player decodes that
  // path reliably; refuse rather than silently produce broken streams.
  if (opts.audio && opts.audio.codec) {
    var ac = opts.audio.codec;
    if (ac !== 'aac' && ac !== 'opus') {
      throw new Error("HLSEncoder: audio.codec must be 'aac' or 'opus' (got '" + ac + "')");
    }
    if (ac === 'opus' && format === 'ts') {
      throw new Error("HLSEncoder: audio.codec 'opus' is not supported in MPEG-TS; use format: 'fmp4'");
    }

    // Channel-count validation. WebCodecs encoders typically support
    // up to 8 channels (7.1 surround). Above that, the AAC ASC and
    // Opus dOps formats both have hard limits (AAC channelConfig is
    // a 4-bit field with values 1..7; Opus mapping table fits any
    // count but no consumer player decodes >8). MPEG-TS AAC carriage
    // also caps at 7 effective channels (same channelConfig).
    var ch = opts.audio.channels;
    if (ch !== undefined && ch !== null) {
      if (typeof ch !== 'number' || ch < 1 || ch > 8 || (ch | 0) !== ch) {
        throw new Error(
          'HLSEncoder: audio.channels must be an integer 1..8 (got ' + ch + ')');
      }
      if (format === 'ts' && ch > 7) {
        // AAC channelConfig values 1..7 are defined; 8-ch is reachable
        // only via channelConfig=0 + program_config_element which we
        // don't synthesize. fMP4 has no such constraint.
        throw new Error(
          'HLSEncoder: audio.channels > 7 not supported in MPEG-TS; use format: \'fmp4\'');
      }
    }
  }

  // Video codec validation. VP9 and AV1 are fMP4-only (the MPEG-TS spec
  // doesn't define stream types for them). H.264 and H.265 work in both
  // containers.
  if (opts.video && opts.video.codec) {
    var vc = opts.video.codec;
    if (vc !== 'h264' && vc !== 'h265' && vc !== 'vp9' && vc !== 'av1') {
      throw new Error("HLSEncoder: video.codec must be 'h264', 'h265', 'vp9', or 'av1' (got '" + vc + "')");
    }
    if ((vc === 'vp9' || vc === 'av1') && format === 'ts') {
      throw new Error("HLSEncoder: video.codec '" + vc + "' is not supported in MPEG-TS; use format: 'fmp4'");
    }
    // VIDEO-RANGE / HDR signaling. Validated here so misspellings
    // ("HDR10" instead of "PQ") surface immediately. We do NOT cross-
    // check codec vs videoRange — Main10 HEVC is required for HDR but
    // can also legitimately carry SDR content, so the user controls
    // the tag.
    if (opts.video.videoRange !== undefined) {
      var vr = opts.video.videoRange;
      if (!isValidVideoRange(vr)) {
        throw new Error(
          "HLSEncoder: video.videoRange must be one of 'SDR', 'HLG', 'PQ' " +
          "(got '" + vr + "'). PQ covers HDR10, HDR10+, and Dolby Vision; " +
          "HLG is for HLG broadcast content; omit or use SDR for non-HDR.");
      }
    }
  }

  // ── Encryption validation ──
  // Validates the encryption option shape upfront so misconfiguration
  // surfaces at construction time. The actual key import (Web Crypto)
  // happens lazily during _ensureConfigured because it's async.
  if (opts.encryption) {
    var e = opts.encryption;
    if (typeof e !== 'object') {
      throw new Error('HLSEncoder: encryption must be an object');
    }
    if (e.method !== 'AES-128') {
      // Phase 1 supports AES-128 only. SAMPLE-AES needs sample-level
      // encryption (within mdat), which requires a different writer
      // path. AES-256-GCM is in RFC 8216bis-19 but Web Crypto for it
      // hasn't shipped uniformly. Both can extend later.
      throw new Error("HLSEncoder: encryption.method must be 'AES-128' " +
                      "(got '" + e.method + "'). SAMPLE-AES and " +
                      "AES-256-GCM are not yet implemented.");
    }
    if (!(e.key instanceof Uint8Array) || e.key.length !== 16) {
      throw new Error('HLSEncoder: encryption.key must be Uint8Array(16) ' +
                      '(raw 128-bit AES key)');
    }
    if (typeof e.keyUri !== 'string') {
      throw new Error('HLSEncoder: encryption.keyUri (string) required — ' +
                      'this is the URI from which players fetch the key');
    }
    // IV: either omit (sequence-derived, the default and most flexible),
    // or pass an explicit 16-byte Uint8Array (constant for all segments).
    // Hex string form is also accepted as a convenience.
    if (e.iv !== undefined && e.iv !== null) {
      if (typeof e.iv === 'string') {
        ivFromHex(e.iv);  // throws if invalid; result thrown away
      } else if (!(e.iv instanceof Uint8Array) || e.iv.length !== 16) {
        throw new Error('HLSEncoder: encryption.iv must be Uint8Array(16) ' +
                        'or "0x" + 32 hex digits (omit for sequence-derived)');
      }
    }
    // LL-HLS encryption requires per-part IV management which we don't
    // yet implement. Reject the combination upfront.
    if (opts.partDuration && opts.partDuration > 0) {
      throw new Error('HLSEncoder: encryption + LL-HLS partDuration is ' +
                      'not yet supported (each part would need its own IV)');
    }
  }

  this._opts = opts;
  this._format = format;
  // Codec injection (unified-library seam): the HLS layer is environment-
  // neutral, so the WebCodecs encoder classes are passed in. In the
  // browser these are the native globals; in Node they are this library's
  // FFmpeg-backed polyfills. Fall back to the globals when not injected,
  // preserving the original browser-only behavior.
  this._VideoEncoder = opts.VideoEncoder ||
    (typeof VideoEncoder !== 'undefined' ? VideoEncoder : null);
  this._AudioEncoder = opts.AudioEncoder ||
    (typeof AudioEncoder !== 'undefined' ? AudioEncoder : null);
  var segmentDurationSec = opts.segmentDuration || 6;
  this._segmentDurationUs  = segmentDurationSec * 1000000;
  this._segmentDurationSec = segmentDurationSec;
  // LL-HLS: partDuration is the target duration of partial segments,
  // in seconds. 0 / undefined disables LL-HLS (the default). Apple's
  // spec recommends parts be 200ms–1s, with PART-TARGET no more than
  // half the segment target — we validate the upper bound here.
  this._partDurationSec = opts.partDuration || 0;
  if (this._partDurationSec > 0) {
    if (this._partDurationSec > segmentDurationSec / 2) {
      throw new Error(
        'HLSEncoder: partDuration (' + this._partDurationSec +
        's) must be at most half of segmentDuration (' + segmentDurationSec + 's)');
    }
    if (format === 'ts') {
      throw new Error(
        "HLSEncoder: LL-HLS (partDuration) is not yet supported for format 'ts'; " +
        "use format: 'fmp4'");
    }
  }
  this._mode = opts.mode || 'live';
  this._forceKeyframes = opts.forceKeyframes !== false;

  // URI conventions per format. fMP4 uses CMAF-standard '.m4s' for media
  // segments and a single 'init.mp4' for the EXT-X-MAP target. TS uses
  // '.ts' and has no init segment.
  if (format === 'fmp4') {
    this._segmentUriPattern = opts.segmentUriPattern || 'seg{n}.m4s';
    this._initSegmentUri    = opts.initSegmentUri    || 'init.mp4';
  } else {
    this._segmentUriPattern = opts.segmentUriPattern || 'seg{n}.ts';
    this._initSegmentUri    = null;
  }

  this._ee = new EventEmitter();

  // Lazy state — populated on first feed() so the caller has time to
  // attach listeners after construction without missing early events.
  this._configured = false;
  this._videoEncoder = null;
  this._audioEncoder = null;
  this._writer = null;
  this._segmentBuilder = null;
  this._playlist = null;

  // For fMP4 format: track whether we've captured codec config from
  // the first encoder output of each track. Set once, never reset.
  this._videoConfigCaptured = false;
  this._audioConfigCaptured = false;

  // For TS format: tracks whether the writer's PMT has been rebuilt
  // to declare the metadata stream. Flipped to true on the first
  // feedMetadata() call. fMP4 doesn't need this (emsg is per-segment).
  this._tsMetadataEnabled = false;

  this._lastForcedKeyframeUs = null;

  // ── Bandwidth tracking (for getStreamInf / master playlist) ──
  // The HLS spec requires the BANDWIDTH attribute on EXT-X-STREAM-INF
  // to be the *peak* segment bitrate, monotonically non-decreasing.
  // We start with an estimate derived from configured bitrate values
  // and refine empirically as segments are emitted. AVERAGE-BANDWIDTH
  // (optional but recommended for player ABR) is the running average.
  //
  // _peakBpsObserved tracks measured peak; null until the first segment.
  // _totalSegmentBytes / _totalSegmentDurationSec accumulate for average.
  this._peakBpsObserved = null;
  this._totalSegmentBytes = 0;
  this._totalSegmentDurationSec = 0;

  // I-frame variant bandwidth tracking — same shape as the regular
  // bandwidth fields but for the I-frame byte ranges only. Initialized
  // here so getIFrameStreamInf works before any segment has been
  // emitted (it falls through to a config-based estimate).
  this._iFramePeakBpsObserved = null;
  this._iFrameTotalBytes = 0;
  this._iFrameTotalDurationSec = 0;

  // ── Input-timestamp tracking ──
  // Recent Chromium builds no longer guarantee that EncodedVideoChunk
  // .timestamp equals the input VideoFrame.timestamp — the encoder
  // may regenerate timestamps based on its declared framerate (see
  // w3c/webcodecs#809). For a camera running at 29.5 fps that we've
  // configured the encoder as 30 fps, this means output timestamps
  // advance ~1.7% slower than wall time, while audio timestamps stay
  // accurate — causing growing A/V drift over the course of a recording.
  //
  // Workaround: queue every input frame's timestamp on encode() and
  // dequeue on chunk output. With latencyMode='realtime' the encoder
  // doesn't reorder, so the FIFO mapping is exact.
  this._videoInputPtsQueue = [];

  // ── Audio timestamp normalization ──
  // Symmetric concern for audio: chunk.timestamp from AudioEncoder
  // and chunk.duration aren't always perfectly uniform either, and
  // even small per-chunk errors compound into hundreds of milliseconds
  // of drift across a 20-second recording. hls.js hides this for
  // MPEG-TS by restamping audio frames at uniform 1024-sample spacing
  // (dropping or inserting silence as needed) — but for fMP4 it
  // trusts our timestamps as-is, so the drift becomes visible.
  //
  // We do the restamping ourselves, here, before the chunks reach
  // the segment-builder. Both writers then receive perfectly uniform
  // audio timestamps and produce drift-free output. AAC LC is fixed
  // at exactly 1024 samples per frame, so the math is deterministic:
  // chunk N's PTS = first_chunk_pts + N * 1024 / sampleRate (in µs).
  this._audioFirstChunkPtsUs = null;
  this._audioChunksEmitted   = 0;
  this._ended = false;

  // CEA-608/708 closed-captions state. Caption cues are scheduled as
  // byte pairs; on each video frame we pull cc_data from the encoder
  // and inject a SEI NAL into the access unit. The NAL is prepended
  // to the AU just after the AUD (if present), before the SPS/PPS
  // and slice NALUs, per H.264 §7.4.1.2.3.
  //
  // Only enabled for h264/h265 in fMP4 or TS. Other codecs (vp9, av1)
  // do not have a SEI mechanism and will silently ignore captions —
  // we surface a configuration error in that case.
  if (opts.captions) {
    var cap = opts.captions;
    if (!opts.video) {
      throw new TypeError('HLSEncoder: captions require a video stream');
    }
    if (opts.video.codec !== 'h264' && opts.video.codec !== 'h265') {
      throw new TypeError(
        'HLSEncoder: captions only supported for h264/h265 (got ' +
        (opts.video.codec || 'undefined') + ')'
      );
    }
    var capType = cap.type || '608';
    if (capType !== '608') {
      throw new TypeError(
        'HLSEncoder: captions.type "' + capType +
        '" not supported (only "608" available currently)'
      );
    }
    // Channel validation: CC1 → field 1 ch 1; CC2 → field 1 ch 2.
    // CC3/CC4 require NTSC field 2 (cc_type=01) which we don't emit.
    var capChannel = cap.channel || 'CC1';
    if (capChannel !== 'CC1' && capChannel !== 'CC2') {
      throw new TypeError(
        'HLSEncoder: captions.channel "' + capChannel +
        '" not supported (only "CC1" or "CC2" available; CC3/CC4 ' +
        'would require NTSC field-2 cc_data which is not implemented)'
      );
    }
    this._cea608 = new CEA608Encoder({
      channel: capChannel === 'CC2' ? 2 : 1,
    });
    this._captionsConfig = {
      type:       '608',
      channel:    capChannel,
      language:   cap.language || 'en',
      groupId:    cap.groupId || 'cc',
      name:       cap.name || cap.language || 'English',
    };
    this._captionsIsH265 = opts.video.codec === 'h265';
  } else {
    this._cea608 = null;
    this._captionsConfig = null;
  }

  // Readiness state — a one-shot transition that completes when all
  // async setup has finished. Currently the only async setup is
  // Web Crypto importKey for encryption; for non-encrypted streams
  // readiness fires as soon as _ensureConfigured runs. The state
  // transitions exactly once: null → 'ok' (success) or null → Error
  // (failure). After transition, ready(cb) fires the callback on
  // next tick instead of queuing.
  this._readyState     = null;
  this._readyCallbacks = [];
}

// ── Public API ────────────────────────────────────────────

HLSEncoder.prototype.on  = function (ev, fn) { this._ee.on(ev, fn);  return this; };
HLSEncoder.prototype.off = function (ev, fn) { this._ee.off(ev, fn); return this; };

/**
 * Push input into the pipeline. Auto-detects the type:
 *   - VideoFrame        → encoded by VideoEncoder
 *   - AudioData         → encoded by AudioEncoder
 *   - EncodedVideoChunk → passthrough (transmux mode)
 *   - EncodedAudioChunk → passthrough
 *
 * @param {VideoFrame|AudioData|EncodedVideoChunk|EncodedAudioChunk} input
 * @param {number} [ptsUs]
 *   Optional explicit timestamp override. If the input already carries
 *   a timestamp, providing ptsUs replaces it (a new VideoFrame is
 *   constructed wrapping the original). If the input has no timestamp
 *   (e.g. raw VideoFrame from a custom source), ptsUs is required.
 */
/**
 * Input classification for the shared feed() path. In the browser the
 * inputs are native WebCodecs globals, so instanceof works. In Node they
 * are this library's polyfills (and may even arrive from a different
 * module instance), so we also duck-type on the WebCodecs-defined shape.
 * Environment-neutral by design — this is the data-class half of the
 * codec-injection seam.
 */
function _looksLikeVideoFrame(x) {
  return !!x && typeof x === 'object' &&
    typeof x.codedWidth === 'number' && typeof x.format === 'string' &&
    typeof x.numberOfFrames !== 'number';
}
function _looksLikeAudioData(x) {
  return !!x && typeof x === 'object' &&
    typeof x.numberOfFrames === 'number' && typeof x.sampleRate === 'number';
}
function _looksLikeEncodedChunk(x) {
  return !!x && typeof x === 'object' &&
    typeof x.byteLength === 'number' && (x.type === 'key' || x.type === 'delta') &&
    typeof x.format !== 'string';
}

HLSEncoder.prototype.feed = function (input, ptsUs) {
  if (this._ended) {
    throw new Error('HLSEncoder.feed: cannot feed after end()');
  }
  this._ensureConfigured();

  if ((typeof VideoFrame !== 'undefined' && input instanceof VideoFrame) || _looksLikeVideoFrame(input)) {
    this._encodeVideoFrame(input, ptsUs);
    return;
  }
  if ((typeof AudioData !== 'undefined' && input instanceof AudioData) || _looksLikeAudioData(input)) {
    this._encodeAudioData(input, ptsUs);
    return;
  }
  if ((typeof EncodedVideoChunk !== 'undefined' && input instanceof EncodedVideoChunk) ||
      (typeof EncodedAudioChunk !== 'undefined' && input instanceof EncodedAudioChunk) ||
      _looksLikeEncodedChunk(input)) {
    throw new Error('HLSEncoder.feed: EncodedChunk passthrough not yet implemented');
  }

  throw new TypeError('HLSEncoder.feed: unsupported input type');
};

/**
 * Convenience alias for callers that prefer explicit method names
 * (e.g. when the input source is known and type-checking is overkill).
 */
HLSEncoder.prototype.feedVideo = function (input, ptsUs) {
  return this.feed(input, ptsUs);
};
HLSEncoder.prototype.feedAudio = function (input, ptsUs) {
  return this.feed(input, ptsUs);
};

/**
 * Push a timed-metadata frame into the stream. Currently supports ID3v2
 * frames carried via emsg boxes in fMP4 segments; ignored for TS output
 * (TS metadata streams aren't supported yet).
 *
 * Common use cases:
 *   - Track changes in a music stream
 *   - Server-side ad insertion markers
 *   - Custom application events synchronized to playback
 *
 * Players surface emsg events via the HLS API (e.g., hls.js's
 * `Hls.Events.FRAG_PARSING_METADATA`) at the playback time matching
 * `timestampUs`.
 *
 * @param {object}      opts
 * @param {Uint8Array}  opts.data         ID3v2 frame bytes. Caller is
 *                                        responsible for building a
 *                                        well-formed ID3 tag.
 * @param {number}      opts.timestampUs  Presentation time in microseconds.
 *                                        Should fall within (or very close
 *                                        to) the active segment's PTS range
 *                                        — events outside it are dropped
 *                                        the same way late audio/video is.
 * @param {number}      [opts.durationUs] Event duration in microseconds.
 *                                        0 (default) = instantaneous event.
 */
HLSEncoder.prototype.feedMetadata = function (opts) {
  if (this._ended) {
    throw new Error('HLSEncoder.feedMetadata: cannot feed after end()');
  }
  if (!opts || !(opts.data instanceof Uint8Array) || opts.data.length === 0) {
    throw new TypeError('HLSEncoder.feedMetadata: opts.data (non-empty Uint8Array) required');
  }
  if (typeof opts.timestampUs !== 'number') {
    throw new TypeError('HLSEncoder.feedMetadata: opts.timestampUs (number) required');
  }
  this._ensureConfigured();
  // For TS, enable the metadata stream on the writer (idempotent).
  // First call rebuilds the PMT template to declare the metadata
  // stream; subsequent segments carry it. fMP4 uses emsg boxes
  // and needs no upfront enable step.
  if (this._format === 'ts' && !this._tsMetadataEnabled) {
    this._writer.enableMetadata();
    this._tsMetadataEnabled = true;
  }
  this._segmentBuilder.pushMetadata(opts.data, {
    ptsUs:      opts.timestampUs,
    durationUs: opts.durationUs || 0,
  });
  return this;
};

/**
 * Add an EXT-X-DATERANGE entry to the playlist. The two main use cases:
 *
 * **SCTE-35 ad break markers** — pass `scte35Out` (CUE-OUT) at the start
 * of an ad break and `scte35In` (CUE-IN) at the end. Players use these
 * to trigger ad insertion logic.
 *
 * **Generic time-anchored metadata** — chapters, EPG events, custom
 * application markers via the `custom` map (X-… attributes).
 *
 * The directive is emitted in subsequent 'manifest' events. For LL-HLS
 * streams, the change is visible to polling players within one part
 * cycle (~partDuration).
 *
 * Direct passthrough to Playlist.addDateRange — see that method's
 * documentation for the full options reference.
 *
 * @returns {HLSEncoder} this, for chaining.
 */
HLSEncoder.prototype.addDateRange = function (opts) {
  this._ensureConfigured();
  this._playlist.addDateRange(opts);
  // Re-emit manifest immediately so subscribers (especially LL-HLS
  // pollers) pick up the new range without waiting for the next
  // segment or part.
  this._ee.emit('manifest', this._playlist.serialize());
  return this;
};

/**
 * Remove EXT-X-DATERANGE entries by ID. Useful for sliding-window
 * cleanup of ad markers older than the playlist window.
 *
 * @param {string} id  ID of the date range(s) to remove.
 * @returns {number}   Count of entries removed.
 */
HLSEncoder.prototype.removeDateRange = function (id) {
  if (!this._configured) return 0;
  var removed = this._playlist.removeDateRange(id);
  if (removed > 0) {
    this._ee.emit('manifest', this._playlist.serialize());
  }
  return removed;
};

/**
 * Schedule an HLS Interstitial (ad break or other secondary content).
 * Sugar over addDateRange — see Playlist.addInterstitial for the full
 * options shape. Re-emits the manifest immediately so live subscribers
 * pick up the schedule.
 *
 * @param {object} opts  See Playlist.addInterstitial.
 * @returns {HLSEncoder} this, for chaining.
 */
HLSEncoder.prototype.addInterstitial = function (opts) {
  this._ensureConfigured();
  this._playlist.addInterstitial(opts);
  this._ee.emit('manifest', this._playlist.serialize());
  return this;
};

/**
 * Add an EXT-X-DEFINE directive for variable substitution. See
 * Playlist.define for the three accepted forms (NAME+VALUE, IMPORT,
 * QUERYPARAM). Re-emits the manifest immediately.
 *
 * Most useful for live streams that need cacheable manifests with
 * per-session query parameters (e.g. AWS MediaTailor pattern).
 *
 * @param {object} def  See Playlist.define.
 * @returns {HLSEncoder} this, for chaining.
 */
HLSEncoder.prototype.define = function (def) {
  this._ensureConfigured();
  this._playlist.define(def);
  this._ee.emit('manifest', this._playlist.serialize());
  return this;
};

/**
 * Set or replace the EXT-X-START directive — the preferred playback
 * start position. See Playlist.setStart for the options shape.
 * Re-emits the manifest immediately so live subscribers pick up the
 * new offset.
 *
 * @param {object} opts  See Playlist.setStart.
 * @returns {HLSEncoder} this, for chaining.
 */
HLSEncoder.prototype.setStart = function (opts) {
  this._ensureConfigured();
  this._playlist.setStart(opts);
  this._ee.emit('manifest', this._playlist.serialize());
  return this;
};

/**
 * Add a closed-caption cue. Captions are encoded as CEA-608 byte
 * pairs and embedded into the H.264/H.265 video stream as SEI NAL
 * messages. Players that decode 608 (Safari, hls.js, ExoPlayer,
 * AVPlayer) will surface the captions through the standard subtitle
 * UI. Requires `captions` option in the HLSEncoder constructor.
 *
 * @param {object} cue
 * @param {number} cue.start  Start time in seconds (>= 0). The caption
 *                            becomes visible at this PTS.
 * @param {number} cue.end    End time in seconds (> start). The
 *                            caption disappears at this PTS.
 * @param {string} cue.text   Caption text. Multi-line via "\n".
 *                            Auto-wrapped to 32 cols × 4 rows max.
 *                            Latin-1 extended characters (à, Ç, ß,
 *                            ¿, etc.) emit ASCII fallback + 2-byte
 *                            escape sequences. Characters outside
 *                            the Latin Extended sets fall back to
 *                            "?" (no Cyrillic/Greek/CJK support).
 * @returns {HLSEncoder}      this, for chaining.
 */
HLSEncoder.prototype.addCaption = function (cue) {
  if (this._ended) {
    throw new Error('HLSEncoder.addCaption: cannot call after end()');
  }
  if (!this._cea608) {
    throw new Error(
      'HLSEncoder.addCaption: captions not enabled. Pass `captions` ' +
      'option to the HLSEncoder constructor.'
    );
  }
  this._cea608.addCue(cue);
  return this;
};

/**
 * Get the EXT-X-MEDIA descriptor for this encoder's closed-captions
 * stream. Suitable for buildMasterPlaylist's closedCaptionsRenditions
 * array. Returns null when captions are not configured.
 *
 * Players use the INSTREAM-ID (CC1/CC2) to find the right CEA-608
 * channel inside the video stream. Master playlist variants opt in
 * via their CLOSED-CAPTIONS attribute.
 *
 * @param {object} [opts]
 * @param {string} [opts.groupId]     Override default GROUP-ID.
 * @param {string} [opts.name]        Override default NAME.
 * @param {string} [opts.language]    Override default LANGUAGE.
 * @param {boolean} [opts.default]    DEFAULT=YES.
 * @param {boolean} [opts.autoselect] AUTOSELECT=YES (default true).
 * @returns {object|null}             Rendition descriptor or null.
 */
HLSEncoder.prototype.getClosedCaptionsRendition = function (opts) {
  if (!this._captionsConfig) return null;
  var c = this._captionsConfig;
  opts = opts || {};
  return {
    groupId:    opts.groupId  !== undefined ? opts.groupId  : c.groupId,
    name:       opts.name     !== undefined ? opts.name     : c.name,
    language:   opts.language !== undefined ? opts.language : c.language,
    instreamId: c.channel,
    default:    !!opts.default,
    autoselect: opts.autoselect !== false,   // default true
  };
};

/**
 * Add or update an EXT-X-RENDITION-REPORT entry pointing at another
 * rendition. For LL-HLS multi-rendition setups, this is the mechanism
 * that lets players switch renditions without re-syncing.
 *
 * Typical wiring with two encoders (one video, one alt-language audio):
 *
 *   videoEnc.on('part', (info) => {
 *     audioEnc.setRenditionReport({
 *       uri:      'video/playlist.m3u8',
 *       lastMsn:  info.segmentSequence,
 *       lastPart: info.partIndex,
 *     });
 *   });
 *   audioEnc.on('part', (info) => {
 *     videoEnc.setRenditionReport({
 *       uri:      'audio/playlist.m3u8',
 *       lastMsn:  info.segmentSequence,
 *       lastPart: info.partIndex,
 *     });
 *   });
 *
 * Direct passthrough to Playlist.setRenditionReport — see that
 * method's documentation for the full options reference.
 *
 * @returns {HLSEncoder} this, for chaining.
 */
HLSEncoder.prototype.setRenditionReport = function (opts) {
  this._ensureConfigured();
  this._playlist.setRenditionReport(opts);
  this._ee.emit('manifest', this._playlist.serialize());
  return this;
};

/**
 * Remove a rendition report by URI. Returns true if removed, false
 * if no report existed for that URI.
 */
HLSEncoder.prototype.removeRenditionReport = function (uri) {
  if (!this._configured) return false;
  var removed = this._playlist.removeRenditionReport(uri);
  if (removed) {
    this._ee.emit('manifest', this._playlist.serialize());
  }
  return removed;
};

/**
 * Build a variant descriptor for use in a master playlist. The returned
 * object plugs directly into `buildMasterPlaylist({ variants: [...] })`
 * and contains everything the master needs to describe this encoder's
 * stream as one quality tier of an ABR ladder.
 *
 * Auto-derived fields:
 *   bandwidth         — peak segment bitrate (HLS spec requirement).
 *                       Before any segment is emitted, this is an
 *                       estimate based on video.bitrate + audio.bitrate
 *                       + container overhead. After segments flow, it
 *                       becomes the empirical max of `bytes * 8 / dur`.
 *                       Per spec, this value is monotonically non-
 *                       decreasing — we never report a value lower
 *                       than the highest peak ever seen.
 *   averageBandwidth  — running mean over all emitted segments.
 *                       Optional in the spec but useful for player ABR.
 *   resolution        — "WxH" derived from video.width/height.
 *   codecs            — comma-joined HLS codec strings derived from
 *                       configured codecs and (when available) the
 *                       captured avcC/hvcC bytes for accurate profile.
 *   frameRate         — from video.framerate (default 30).
 *
 * The caller can override any field. Common reasons:
 *   - `bandwidth` is known precisely from a previous run
 *   - `name` for human-readable display in player UIs
 *   - `audio` / `subtitles` to reference rendition GROUP-IDs
 *
 * For best accuracy, call this AFTER at least one segment has been
 * emitted (so the empirical bandwidth measurement has data). Calling
 * earlier is fine but you'll get the estimate.
 *
 * @param {object}        opts
 * @param {string}        opts.uri                    Required. Path to the variant's media playlist.
 * @param {number}        [opts.bandwidth]            Override the auto-computed peak.
 * @param {number}        [opts.averageBandwidth]     Override the auto-computed average.
 * @param {string}        [opts.resolution]           Override "WxH".
 * @param {string}        [opts.codecs]               Override the joined codec string.
 * @param {number}        [opts.frameRate]            Override the framerate.
 * @param {string}        [opts.name]                 Optional display name.
 * @param {string}        [opts.audio]                GROUP-ID of an audio rendition group.
 * @param {string}        [opts.subtitles]            GROUP-ID of a subtitle rendition group.
 * @returns {object}      Variant descriptor.
 */
HLSEncoder.prototype.getStreamInf = function (opts) {
  if (!opts || typeof opts.uri !== 'string') {
    throw new TypeError('HLSEncoder.getStreamInf: opts.uri (string) required');
  }

  var v = this._opts.video;
  var a = this._opts.audio;

  // Bandwidth: empirical peak if we have one, else the upfront estimate.
  // The empirical value is set in _onSegment as segments stream out.
  var bandwidth;
  if (opts.bandwidth !== undefined) {
    bandwidth = opts.bandwidth;
  } else if (this._peakBpsObserved !== null) {
    bandwidth = Math.round(this._peakBpsObserved);
  } else {
    bandwidth = _estimateBandwidth(v, a, this._format);
  }

  // Average bandwidth: only meaningful after at least one segment.
  // Before that, fall back to the peak (estimate) — players use it
  // for ABR decisions and a missing value is worse than an approximate.
  var averageBandwidth;
  if (opts.averageBandwidth !== undefined) {
    averageBandwidth = opts.averageBandwidth;
  } else if (this._totalSegmentDurationSec > 0) {
    averageBandwidth = Math.round(
      (this._totalSegmentBytes * 8) / this._totalSegmentDurationSec);
  } else {
    averageBandwidth = bandwidth;
  }

  // Codecs: video first, then audio. Per HLS RFC 8216 §4.3.4.2 this is
  // a comma-separated list, no whitespace. The captured avcC/hvcC
  // (videoConfig on the writer) is non-null only after the first chunk.
  var capturedConfig = (this._writer && this._writer.getVideoConfig)
    ? this._writer.getVideoConfig() : null;
  var vCodecStr = _deriveVideoCodecString(v, capturedConfig);
  var aCodecStr = _deriveAudioCodecString(a);
  var codecsStr;
  if (vCodecStr && aCodecStr) {
    codecsStr = vCodecStr + ',' + aCodecStr;
  } else {
    codecsStr = vCodecStr || aCodecStr || '';
  }

  // Resolution from the originally configured video size. (After the
  // encoder runs, the actual coded size may differ slightly — but
  // since we forced realtime mode and h264/265 require even pixel
  // dims, the values should match what was passed in.)
  var resolution;
  if (v && v.width && v.height) {
    resolution = v.width + 'x' + v.height;
  }

  var streamInf = {
    uri:              opts.uri,
    bandwidth:        bandwidth,
    averageBandwidth: averageBandwidth,
    codecs:           opts.codecs    !== undefined ? opts.codecs    : codecsStr,
    resolution:       opts.resolution !== undefined ? opts.resolution : resolution,
  };
  // FRAME-RATE only belongs on a variant that has video. RFC 8216
  // §4.3.4.2 scopes it to variants with video, and the previous
  // `(v && v.framerate) || 30` fell through to 30 when there was no
  // video config at all — so an audio-only variant advertised
  // FRAME-RATE=30.000 next to no RESOLUTION. Harmless to most players,
  // but it is a claim about a video stream that does not exist, and
  // ABR logic that keys on FRAME-RATE has no reason to expect it.
  if (opts.frameRate !== undefined) {
    streamInf.frameRate = opts.frameRate;
  } else if (v && v.framerate) {
    streamInf.frameRate = v.framerate;
  } else if (v) {
    // Video configured but no explicit framerate — the encoder's own
    // default applies, so advertising it is still correct.
    streamInf.frameRate = 30;
  }
  // HDR signaling. videoRange indicates the transfer function
  // (SDR/HLG/PQ); supplementalCodecs carries optional Dolby Vision
  // or HDR10+ profile info as a backwards-compatible add-on. Both
  // are sourced from video config but overridable per-call.
  var resolvedVideoRange = opts.videoRange !== undefined ?
    opts.videoRange : (v && v.videoRange);
  if (resolvedVideoRange) streamInf.videoRange = resolvedVideoRange;
  var resolvedSuppCodecs = opts.supplementalCodecs !== undefined ?
    opts.supplementalCodecs : (v && v.supplementalCodecs);
  if (resolvedSuppCodecs) streamInf.supplementalCodecs = resolvedSuppCodecs;
  // Override-able overrides for non-auto fields. Only emit if the
  // caller asked for them — otherwise we'd write empty attribute values.
  if (opts.name)      streamInf.name      = opts.name;
  if (opts.audio)     streamInf.audio     = opts.audio;
  if (opts.subtitles) streamInf.subtitles = opts.subtitles;
  return streamInf;
};

/**
 * Build an I-frame variant descriptor for use in a master playlist's
 * `iFrameVariants` array. Mirrors getStreamInf but for the I-frame
 * playlist — the output renders as `#EXT-X-I-FRAME-STREAM-INF`.
 *
 * Bandwidth defaults to the empirical I-frame data rate (peak bps of
 * the keyframe byte ranges divided by segment duration). Resolution
 * and codecs come from the same source as the parent variant.
 *
 * Throws if the encoder wasn't constructed with `iFramePlaylist: true`.
 *
 * @param {object} opts
 * @param {string} opts.uri                Required. Path to the I-frame
 *                                          playlist file (the .m3u8 the
 *                                          caller is uploading).
 * @param {number} [opts.bandwidth]        Override the auto-computed peak.
 * @param {number} [opts.averageBandwidth] Override the auto average.
 * @param {string} [opts.resolution]       Override "WxH".
 * @param {string} [opts.codecs]           Override the codec string.
 * @param {string} [opts.name]             Optional display name.
 * @returns {object}                       I-frame variant descriptor.
 */
HLSEncoder.prototype.getIFrameStreamInf = function (opts) {
  if (!this._opts.iFramePlaylist) {
    throw new Error('HLSEncoder.getIFrameStreamInf: encoder was not ' +
                    'constructed with iFramePlaylist: true');
  }
  if (!opts || typeof opts.uri !== 'string') {
    throw new TypeError('HLSEncoder.getIFrameStreamInf: opts.uri (string) required');
  }

  var v = this._opts.video;

  // Bandwidth: empirical peak of I-frame data if we have any, else
  // estimate as a fraction of the regular variant's bandwidth.
  // Typical I-frame-only data is 5-15% of the full stream rate;
  // we default to 10% as the pre-segment estimate.
  var bandwidth;
  if (opts.bandwidth !== undefined) {
    bandwidth = opts.bandwidth;
  } else if (this._iFramePeakBpsObserved !== null) {
    bandwidth = Math.round(this._iFramePeakBpsObserved);
  } else if (this._peakBpsObserved !== null) {
    bandwidth = Math.round(this._peakBpsObserved * 0.10);
  } else {
    bandwidth = Math.round(_estimateBandwidth(v, null, this._format) * 0.10);
  }

  var averageBandwidth;
  if (opts.averageBandwidth !== undefined) {
    averageBandwidth = opts.averageBandwidth;
  } else if (this._iFrameTotalDurationSec > 0) {
    averageBandwidth = Math.round(
      (this._iFrameTotalBytes * 8) / this._iFrameTotalDurationSec);
  } else {
    averageBandwidth = bandwidth;
  }

  // Codecs: only video — I-frame variant has no audio.
  var capturedConfig = (this._writer && this._writer.getVideoConfig)
    ? this._writer.getVideoConfig() : null;
  var vCodecStr = _deriveVideoCodecString(v, capturedConfig);

  var resolution;
  if (v && v.width && v.height) {
    resolution = v.width + 'x' + v.height;
  }

  var iVariant = {
    uri:              opts.uri,
    bandwidth:        bandwidth,
    averageBandwidth: averageBandwidth,
    codecs:           opts.codecs    !== undefined ? opts.codecs    : (vCodecStr || ''),
    resolution:       opts.resolution !== undefined ? opts.resolution : resolution,
  };
  // HDR signaling — same source (video config) as getStreamInf, since
  // the I-frame variant is just a different view of the same video.
  // A player that picked the HDR I-frame variant for thumbnails MUST
  // know to render PQ/HLG correctly.
  var resolvedIVR = opts.videoRange !== undefined ?
    opts.videoRange : (v && v.videoRange);
  if (resolvedIVR) iVariant.videoRange = resolvedIVR;
  var resolvedISC = opts.supplementalCodecs !== undefined ?
    opts.supplementalCodecs : (v && v.supplementalCodecs);
  if (resolvedISC) iVariant.supplementalCodecs = resolvedISC;
  if (opts.name) iVariant.name = opts.name;
  return iVariant;
};

/**
 * Notify when the encoder is ready to receive frames.
 *
 * "Ready" means: lazy configuration has run (writer + playlist +
 * segment-builder + WebCodecs encoders constructed) AND any async
 * setup steps have completed (currently only the Web Crypto importKey
 * for encryption — for non-encrypted streams readiness fires as soon
 * as setup runs).
 *
 * The callback is invoked exactly once with `(err)`:
 *   - `null` when setup succeeded
 *   - an Error when async setup failed (e.g., bad encryption key,
 *     Web Crypto unavailable). The same error is also emitted via
 *     the 'error' event for listeners using the event-stream model.
 *
 * Calling ready() multiple times registers multiple callbacks; each
 * fires once. Calling after readiness has already resolved fires
 * the callback on the next tick with the cached state.
 *
 * Symmetric with end(callback) — start with ready, finish with end:
 *
 *   encoder.ready(function (err) {
 *     if (err) return console.error('setup failed:', err);
 *     // start feeding...
 *   });
 *
 * Calling ready() also triggers _ensureConfigured, so it doubles as
 * the explicit "go ahead and set up" trigger for callers that want
 * setup errors before the first feed().
 *
 * @param {Function} callback  callback(err)
 * @returns {HLSEncoder}       this, for chaining.
 */
HLSEncoder.prototype.ready = function (callback) {
  if (typeof callback !== 'function') {
    throw new TypeError('HLSEncoder.ready: callback function required');
  }

  // Trigger configuration if it hasn't run yet. The async setup
  // inside (encryption key import or the immediate-resolve path)
  // calls _resolveReady when it completes.
  this._ensureConfigured();

  // Already resolved — fire on next tick to maintain consistent
  // async cadence (a callback that sometimes fires sync, sometimes
  // async, is a footgun).
  if (this._readyState !== null) {
    var cb = callback;
    var state = this._readyState;
    setTimeout(function () {
      cb(state === 'ok' ? null : state);
    }, 0);
    return this;
  }

  // Pending — queue and wait for _resolveReady.
  this._readyCallbacks.push(callback);
  return this;
};

/**
 * Internal: transition from pending to resolved (success or error)
 * and fire all queued ready() callbacks. Idempotent — extra calls
 * after the first transition are silently ignored.
 *
 * @param {Error|null} err  null on success, Error on failure.
 */
HLSEncoder.prototype._resolveReady = function (err) {
  if (this._readyState !== null) return;  // already resolved
  this._readyState = err ? err : 'ok';

  // Drain the callback list. Take a local reference so a callback
  // that re-registers (unusual but legal) lands in a fresh array
  // and gets fired on the next resolution rather than this one.
  var callbacks = this._readyCallbacks;
  this._readyCallbacks = [];
  for (var i = 0; i < callbacks.length; i++) {
    try {
      callbacks[i](err || null);
    } catch (e) {
      if (typeof console !== 'undefined' && console.error) {
        console.error('HLSEncoder.ready: callback threw:', e);
      }
    }
  }
};

/**
 * Drain the encoders, flush any final segment, and mark the playlist
 * as ended (writes EXT-X-ENDLIST). Idempotent — calling end() twice
 * is a no-op the second time.
 *
 * Calls the provided callback once the final 'manifest' event has
 * fired and the encoders are closed. The callback receives no
 * arguments — errors are surfaced through the 'error' event so the
 * normal stream-of-events listener model applies. If no callback is
 * provided, end() simply runs to completion without notification.
 *
 * Internal flow:
 *   1. Drain WebCodecs encoders (their flush() returns a Promise —
 *      bridged here to a callback at the function boundary).
 *   2. Force segment-builder to emit any tail content.
 *   3. Wait for the encryption queue to drain (callback chain).
 *   4. Finalize playlist + close encoders + fire user callback.
 *
 * @param {Function} [callback]  Called when end has fully completed.
 */
HLSEncoder.prototype.end = function (callback) {
  // Dual-mode: callback, or a Promise when none is given.
  //
  // end() used to return undefined always. The usage example at the top
  // of this file — and every caller who followed it — writes
  // `await encoder.end()`, and awaiting undefined resolves on the very
  // next microtask. Meanwhile the real work (drain the WebCodecs
  // encoders, flush SegmentBuilder, wait for encryption, close the
  // playlist) is asynchronous, so the FINAL partial segment and the
  // EXT-X-ENDLIST manifest were still to come.
  //
  // The visible symptom is a recording that plays short: everything up
  // to the last whole segment boundary is there, the tail is missing,
  // and the manifest's EXTINF total undercounts the real duration.
  // Measured: 150 frames in (5.00s), 120 out (4.00s) — the trailing
  // second silently absent, with no error anywhere.
  //
  // Same shape as base_coder's flush() and Muxer.finalize(): callers
  // passing a callback are unaffected.
  if (typeof callback !== 'function') {
    var self_end = this;
    return new Promise(function (resolve) { self_end.end(resolve); });
  }
  var done = function () { callback(); };

  if (this._ended) { done(); return; }
  this._ended = true;
  if (!this._configured) {
    // Nothing was ever fed. Skip the drain steps but still call back.
    done();
    return;
  }

  var self = this;

  // Step 1 — drain WebCodecs encoders.
  // VideoEncoder/AudioEncoder.flush() is platform-async (returns a
  // Promise). We bridge it to a callback at this single boundary;
  // the rest of the chain uses callbacks. AudioEncoder is lazy-
  // configured, so skip flush if no AudioData ever arrived.
  var pending = [];
  if (self._videoEncoder && self._videoEncoder.state === 'configured') {
    pending.push(self._videoEncoder.flush());
  }
  if (self._audioEncoder && self._audioEncoder.state === 'configured') {
    pending.push(self._audioEncoder.flush());
  }

  function afterFlush() {
    // Step 2 — force any tail content out as the final segment.
    self._segmentBuilder.flush();

    // Step 3 — drain the encryption queue. onEncryptionDrained fires
    // its callback on the next tick when nothing's queued, so the
    // shape is identical whether encryption is on or off.
    self._segmentBuilder.onEncryptionDrained(function () {
      // Step 4 — finalize and fire the user's callback.
      self._playlist.end();
      self._ee.emit('manifest', self._playlist.serialize());

      if (self._videoEncoder && self._videoEncoder.state !== 'closed') {
        self._videoEncoder.close();
      }
      if (self._audioEncoder && self._audioEncoder.state !== 'closed') {
        self._audioEncoder.close();
      }

      done();
    });
  }

  if (pending.length === 0) {
    // Defer to next tick so end() never invokes its callback
    // synchronously — keeps caller cadence consistent.
    setTimeout(afterFlush, 0);
  } else {
    Promise.all(pending).then(afterFlush, function (err) {
      // Encoder flush failed. Surface via the events bus and continue
      // the shutdown — the partial manifest is still useful.
      self._ee.emit('error', err);
      afterFlush();
    });
  }
};


// ── Lazy configuration ────────────────────────────────────

/**
 * Configure encoders, writer, builder and playlist on first feed().
 * Lazy so the caller can set up listeners between `new HLSEncoder()`
 * and the first feed() — synchronous setup in the constructor would
 * race with listener attachment when the input source emits frames
 * immediately on hookup.
 */
HLSEncoder.prototype._ensureConfigured = function () {
  if (this._configured) return;
  this._configured = true;

  var opts = this._opts;
  var self = this;

  // 1. Writer — TS or fMP4 depending on format choice
  if (this._format === 'fmp4') {
    // For AAC: detect HE-AAC vs LC from the codec string and pass the
    // appropriate priming (encoderDelay) to the writer. The writer
    // bakes it into the audio track's edts/elst — without it, audible
    // audio starts ~21–43 ms after the first video frame.
    var audioCfg;
    if (opts.audio) {
      audioCfg = {
        codec:      opts.audio.codec === 'opus' ? 'opus' : 'aac',
        sampleRate: opts.audio.sampleRate,
        channels:   opts.audio.channels,
      };
      if (audioCfg.codec === 'aac') {
        var aacCs = opts.audio.codecString || _defaultAudioCodecString('aac');
        audioCfg.encoderDelay = _aacEncoderDelay(aacCs);
      }
    }
    this._writer = new FMP4Writer({
      video: opts.video ? {
        codec:  opts.video.codec || 'h264',
        width:  opts.video.width,
        height: opts.video.height,
      } : undefined,
      audio: audioCfg,
    });
  } else {
    var writerCfg = {};
    if (opts.video) {
      writerCfg.video = { codec: opts.video.codec === 'h265' ? 'h265' : 'h264' };
    }
    if (opts.audio) {
      writerCfg.audio = { codec: 'aac' };  // Opus rejected above for TS
    }
    this._writer = new TSWriter(writerCfg);
  }

  // 2. Playlist. partDuration enables LL-HLS — Playlist emits the
  // associated directives (PART-INF, SERVER-CONTROL, EXT-X-PART).
  this._playlist = new Playlist({
    mode: this._mode,
    targetDuration: Math.ceil(this._segmentDurationSec),
    windowSize: opts.windowSize || 6,
    independentSegments: opts.independentSegments,
    initSegmentUri: this._initSegmentUri,  // null for TS
    partTargetDuration: this._partDurationSec,
    partHoldBack: opts.partHoldBack,
  });

  // 2b. I-frame playlist (optional). When iFramePlaylist is true,
  // we maintain a parallel Playlist of EXT-X-I-FRAMES-ONLY entries —
  // each pointing at the keyframe byte range within the corresponding
  // media segment. Used by players for trick-play (FF/RW, scrub
  // thumbnails). Sliding-window matches the main playlist.
  this._iFramePlaylistEnabled = !!opts.iFramePlaylist;
  if (this._iFramePlaylistEnabled) {
    this._iFramePlaylist = new Playlist({
      mode: this._mode,
      targetDuration: Math.ceil(this._segmentDurationSec),
      windowSize: opts.windowSize || 6,
      independentSegments: opts.independentSegments,
      initSegmentUri: this._initSegmentUri,
      iFramesOnly: true,
    });
    // For TS, the writer needs a heads-up so it tracks keyframe ranges.
    if (this._format === 'ts') {
      this._writer.enableIFramePlaylist();
    }
    // Bandwidth tracking fields live on `this` and are initialized in
    // the constructor — getIFrameStreamInf can be called pre-configure.
  } else {
    this._iFramePlaylist = null;
  }

  // 3. SegmentBuilder
  // Encryption setup. createEncryptor is callback-based; the import
  // takes negligible wall-clock but is platform-async so we wire it
  // up declaratively. When the callback fires we attach the encryptor
  // to the builder via setEncryptor — any segments queued in the
  // meantime drain at that point.
  var encryptionForBuilder = null;
  if (opts.encryption) {
    var ivBytes = null;
    if (opts.encryption.iv) {
      ivBytes = (typeof opts.encryption.iv === 'string') ?
        ivFromHex(opts.encryption.iv) : opts.encryption.iv;
    }
    // Pre-populate the slot with iv but no encryptor — segment-builder
    // queues until we call setEncryptor below. Once Web Crypto's
    // importKey resolves, the queue drains.
    encryptionForBuilder = { encryptor: null, iv: ivBytes };

    // Wire the EXT-X-KEY directive into the playlist immediately. The
    // tag goes at the top of every serialize() call so even the first
    // (potentially empty) manifest snapshot is properly marked.
    var keyOpts = {
      method: 'AES-128',
      uri:    opts.encryption.keyUri,
    };
    if (ivBytes) keyOpts.iv = ivToHex(ivBytes);
    if (opts.encryption.keyFormat !== undefined) {
      keyOpts.keyFormat = opts.encryption.keyFormat;
    }
    if (opts.encryption.keyFormatVersions !== undefined) {
      keyOpts.keyFormatVersions = opts.encryption.keyFormatVersions;
    }
    this._playlist.setKey(keyOpts);
  }

  this._segmentBuilder = new SegmentBuilder({
    writer: this._writer,
    segmentDuration: this._segmentDurationSec,
    partDuration: this._partDurationSec,
    iFramePlaylist: this._iFramePlaylistEnabled,
    hasVideo: !!opts.video,
    encryption: encryptionForBuilder,
    onSegment: function (info) { self._onSegment(info); },
    onPart:    function (info) { self._onPart(info); },
    onError:   function (e) { self._ee.emit('error', e); },
  });

  // Now that the builder exists, trigger the async key import. When
  // it completes, attach the encryptor and drain any queued work.
  // Segments produced before this point are buffered in the queue.
  if (opts.encryption) {
    createEncryptor({ key: opts.encryption.key }, function (err, encryptor) {
      if (err) {
        self._ee.emit('error', err);
        // Release anything waiting on the encryption queue. Without
        // this the builder holds queued segments forever and end()
        // never completes, even though the caller was just told about
        // the failure.
        if (self._segmentBuilder && self._segmentBuilder.failEncryption) {
          self._segmentBuilder.failEncryption(err);
        }
        self._resolveReady(err);
        return;
      }
      self._segmentBuilder.setEncryptor(encryptor);
      self._resolveReady(null);
    });
  } else {
    // No encryption — readiness is achieved as soon as setup runs.
    // Defer to next tick so ready(cb) callers consistently see async
    // delivery regardless of whether encryption is configured.
    setTimeout(function () { self._resolveReady(null); }, 0);
  }

  // 4. WebCodecs encoders
  if (opts.video) this._configureVideoEncoder();
  if (opts.audio) this._configureAudioEncoder();
};

HLSEncoder.prototype._configureVideoEncoder = function () {
  var v = this._opts.video;
  var self = this;

  if (!this._VideoEncoder) {
    throw new Error('HLSEncoder: VideoEncoder is not available in this environment');
  }

  var codec = v.codecString || _defaultVideoCodecString(v.codec, v.width, v.height);

  this._videoEncoder = new this._VideoEncoder({
    output: function (chunk, metadata) { self._onVideoChunk(chunk, metadata); },
    error:  function (err) { self._ee.emit('error', err); },
  });

  var cfg = {
    codec: codec,
    width: v.width,
    height: v.height,
    bitrate: v.bitrate || 2_500_000,
    framerate: v.framerate || 30,
    // 'realtime' tells the encoder not to buffer frames for lookahead /
    // B-frame reordering. The default ('quality') can introduce 100+ ms
    // of pipeline delay before the first chunk is emitted, which causes
    // two problems for HLS streaming:
    //   1. The audio encoder runs at real time; while the video encoder
    //      is buffering, audio chunks pour in but get dropped because
    //      no first IDR has arrived yet (segment-builder requires a
    //      keyframe before keeping any audio). When the first IDR
    //      finally lands, the kept audio is the chunk after the
    //      backlog — so audio tfdt ends up later than video tfdt by
    //      the lookahead duration. The result is "video lags audio"
    //      in playback.
    //   2. B-frames carried in the chunks would have DTS != PTS, which
    //      our writer doesn't currently express in trun.
    // Realtime mode also produces simpler bitstreams (no B-frames),
    // which match what most HLS decoders expect.
    latencyMode: 'realtime',
  };

  // Optional hardware-acceleration pass-through. WebCodecs default is
  // 'no-preference', which already lets the User Agent pick hardware
  // when available — and Chrome almost always does for typical 720p+
  // workloads. We only set the field if the caller specified a
  // preference, so the default behavior is preserved verbatim.
  // 'prefer-hardware' will cause configure() to throw if HW isn't
  // available; 'prefer-software' is useful for deterministic test runs.
  if (v.hardwareAcceleration) {
    cfg.hardwareAcceleration = v.hardwareAcceleration;
  }

  // Output format choice depends on container.
  //
  // TS path: configure 'annexb' for h264/h265. The writer-ts.js expects
  //   Annex-B AUs with SPS/PPS in-band at every keyframe, and that's
  //   exactly what the platform produces in this mode — chunks pass
  //   straight through with no post-processing. (VP9 and AV1 don't run
  //   here — they're rejected for TS at construction time.)
  //
  // fMP4 path:
  //   - h264/h265: leave as default ('avc' for H.264, 'hev1' for H.265),
  //     which produces AVCC-style length-prefixed NALUs and emits
  //     SPS/PPS out-of-band via metadata.decoderConfig.description on
  //     the first chunk. We capture that description and hand it to the
  //     writer's avcC/hvcC box in the init segment.
  //   - vp9: chunks are raw VP9 frames; vpcC bytes are derived from the
  //     codec string (no encoder-provided description needed).
  //   - av1: chunks are raw AV1 OBU frames; av1C bytes come from the
  //     encoder via metadata.decoderConfig.description (contains the
  //     Sequence Header OBU).
  if (this._format === 'ts') {
    if (v.codec === 'h265') {
      cfg.hevc = { format: 'annexb' };
    } else if (v.codec === 'h264' || !v.codec) {
      cfg.avc = { format: 'annexb' };
    }
  }
  // For fMP4: don't set; defaults give us AVCC bytes + out-of-band config.

  this._videoEncoder.configure(cfg);
};

HLSEncoder.prototype._configureAudioEncoder = function () {
  var a = this._opts.audio;
  var self = this;

  if (!this._AudioEncoder) {
    throw new Error('HLSEncoder: AudioEncoder is not available in this environment');
  }

  // Construct the encoder eagerly so we can attach callbacks, but
  // defer configure() until the first AudioData arrives. This lets us
  // pull sampleRate / channels from the actual input — WebCodecs
  // requires AudioEncoder.configure() to match the AudioData being
  // fed exactly, and the input format usually isn't known up front
  // (mic hardware decides; typical values are 48000 or 44100, mono
  // or stereo). If the caller passes sampleRate / channels in opts,
  // those win and override the input — caller is responsible for
  // ensuring the data matches.
  this._audioEncoder = new this._AudioEncoder({
    output: function (chunk, metadata) { self._onAudioChunk(chunk, metadata); },
    error:  function (err) { self._ee.emit('error', err); },
  });
  this._audioEncoderConfigured = false;
};

HLSEncoder.prototype._configureAudioEncoderForInput = function (audioData) {
  var a = this._opts.audio;
  var sampleRate = a.sampleRate || audioData.sampleRate;
  var channels   = a.channels   || audioData.numberOfChannels;
  var codec      = a.codec === 'opus' ? 'opus' : 'aac';

  var cfg = {
    codec:            a.codecString || _defaultAudioCodecString(codec),
    sampleRate:       sampleRate,
    numberOfChannels: channels,
    bitrate:          a.bitrate     || 128000,
  };

  // Output format choice depends on container and codec.
  //
  // AAC + TS: 'adts' — ADTS-wrapped AAC frames are what writer-ts.js
  //   expects (each frame self-describes its sample rate / profile /
  //   channels in the 7-byte header).
  //
  // AAC + fMP4: 'aac' (default) — raw AAC frames go straight into
  //   mdat. Per-frame headers aren't needed; AudioSpecificConfig in
  //   the init segment's esds box describes the stream once.
  //
  // Opus + fMP4: WebCodecs emits raw Opus packets per chunk. Default
  //   frame duration is 20ms (960 samples at 48kHz) — explicitly set
  //   here so the writer's PreSkip math and our PTS step calculations
  //   stay deterministic across browsers. Opus + TS is rejected up
  //   front (see HLSEncoder constructor).
  if (codec === 'aac' && this._format === 'ts') {
    cfg.aac = { format: 'adts' };
  } else if (codec === 'opus') {
    cfg.opus = { frameDuration: 20000 };  // 20 ms = 960 samples @ 48kHz
  }

  this._audioEncoder.configure(cfg);

  // Remember the resolved values so the fMP4 writer can use them in
  // mp4a / Opus sample-entry headers and the mdhd timescale (set when
  // the first encoded chunk arrives — see _onAudioChunk).
  this._resolvedAudioCodec      = codec;
  this._resolvedAudioSampleRate = sampleRate;
  this._resolvedAudioChannels   = channels;

  this._audioEncoderConfigured = true;
};


// ── Input handlers (raw frames → encoders) ────────────────

HLSEncoder.prototype._encodeVideoFrame = function (frame, ptsUsOverride) {
  // Resolve timestamp.
  var hasOverride = ptsUsOverride !== undefined && ptsUsOverride !== null;
  var ts;
  if (hasOverride) {
    ts = ptsUsOverride;
  } else if (frame.timestamp !== null && frame.timestamp !== undefined) {
    ts = frame.timestamp;
  } else {
    throw new Error('HLSEncoder.feed: VideoFrame has no timestamp; pass ptsUs as 2nd arg');
  }

  // Decide whether to force a keyframe at this frame.
  var forceKey = false;
  if (this._forceKeyframes) {
    forceKey = (this._lastForcedKeyframeUs === null) ||
               (ts - this._lastForcedKeyframeUs >= this._segmentDurationUs);
  }

  // If the user supplied a timestamp override that differs from the
  // frame's own timestamp, we wrap into a new VideoFrame. The new
  // frame shares the underlying buffer (zero-copy) and is closed
  // immediately after encode() takes its data.
  this._videoInputPtsQueue.push(ts);
  if (hasOverride && ts !== frame.timestamp) {
    // Re-wrap with the overridden timestamp. Use the incoming frame's
    // OWN constructor rather than a global `VideoFrame` — in Node the
    // global doesn't exist; this way the wrap works whether `frame` is
    // a native browser VideoFrame or this library's polyfill (codec-
    // injection seam). Shares the underlying buffer (zero-copy).
    var VF = frame.constructor;
    var wrapped = new VF(frame, { timestamp: ts });
    this._videoEncoder.encode(wrapped, { keyFrame: forceKey });
    wrapped.close();
  } else {
    this._videoEncoder.encode(frame, { keyFrame: forceKey });
  }

  if (forceKey) this._lastForcedKeyframeUs = ts;
};

HLSEncoder.prototype._encodeAudioData = function (audioData, ptsUsOverride) {
  // AudioData lacks a clean way to override timestamp — there's no
  // "wrap with new init" constructor like VideoFrame. If the caller
  // provides ptsUsOverride, we'd have to copyTo a buffer and rebuild
  // an AudioData — expensive and rarely needed. For now we require
  // the caller to set audioData.timestamp before feeding.
  if (ptsUsOverride !== undefined && ptsUsOverride !== null && ptsUsOverride !== audioData.timestamp) {
    throw new Error('HLSEncoder.feed: AudioData timestamp override not supported; ' +
                    'set audioData.timestamp at construction time');
  }
  if (audioData.timestamp === null || audioData.timestamp === undefined) {
    throw new Error('HLSEncoder.feed: AudioData has no timestamp');
  }

  // Lazy configure on first frame so we can match the input's actual
  // sampleRate / channels (see _configureAudioEncoder for why).
  if (!this._audioEncoderConfigured) {
    this._configureAudioEncoderForInput(audioData);
  }

  this._audioEncoder.encode(audioData);
};


// ── Output handlers (encoder chunks → builder) ────────────

HLSEncoder.prototype._onVideoChunk = function (chunk, metadata) {
  // Materialize the chunk bytes upfront. Two reasons:
  //   1) pushVideo() needs them.
  //   2) The AV1 OBU fallback (below) parses them when the browser
  //      doesn't emit decoderConfig.description — which Chrome doesn't,
  //      reliably, for AV1 in 'realtime' mode. Doing the copy first
  //      lets the fallback see the same bytes the writer will see.
  var au = new Uint8Array(chunk.byteLength);
  chunk.copyTo(au);

  // fMP4 mdat samples must be length-prefixed (AVCC form), never
  // Annex-B (writer_fmp4 header comment, ISO 14496-15 §5.3.2). The
  // browser encoder already emits AVCC in the fMP4 config (we don't
  // set avc.format there); the Node FFmpeg-backed encoder emits
  // Annex-B regardless — detect and convert. No-op when already AVCC.
  if (this._format === 'fmp4') {
    var _vc = this._opts.video && this._opts.video.codec;
    if (_vc === 'h264' || _vc === 'h265' || !_vc) {
      if (detectFormat(au) === 'annexb') {
        au = annexbToAvcc(au, _vc === 'h265');
      }
    }
  }

  // For fMP4: capture the codec config from the first chunk's metadata
  // (or, for AV1 only, by parsing the chunk's Sequence Header OBU).
  //
  // h264: metadata.decoderConfig.description = AVCDecoderConfigurationRecord (avcC)
  // h265: metadata.decoderConfig.description = HEVCDecoderConfigurationRecord (hvcC)
  // vp9:  derived from codec string — vpcC body is profile/level/etc.
  // av1:  metadata.decoderConfig.description = AV1CodecConfigurationRecord,
  //       OR (Chrome quirk) absent — extract Seq Header OBU from chunk
  //       and build the record from codec-string + that OBU.
  if (this._format === 'fmp4' && !this._videoConfigCaptured) {
    var v = this._opts.video;
    var vCodec = v && v.codec;
    // Pull decoderConfig out once. Used for description (the typical
    // path) and for codedWidth/codedHeight (preferred over our config
    // values when the encoder reports a different actual size).
    var dcfg = metadata && metadata.decoderConfig;
    var configBytes = null;

    if (vCodec === 'vp9') {
      var vp9CodecStr = v.codecString || _defaultVideoCodecString('vp9', v.width, v.height);
      configBytes = _buildVp9ConfigRecord(_parseVp9CodecString(vp9CodecStr));
    } else if (dcfg && dcfg.description) {
      // h264 / h265 / av1 with encoder-provided description.
      // Browser WebCodecs emits the proper DecoderConfigurationRecord
      // (avcC/hvcC/av1C) — pass through. The Node FFmpeg-backed encoder
      // emits SPS/PPS in Annex-B form (MP-39); detect and convert so
      // the avcC box in the init segment is spec-valid either way.
      configBytes = new Uint8Array(dcfg.description);
      if ((vCodec === 'h264' || vCodec === 'h265' || !vCodec) &&
          detectFormat(configBytes) === 'annexb') {
        if (vCodec === 'h265') {
          // hvcC (ISO 14496-15 §8.3.3.1) needs VPS/SPS bit-level parsing
          // (general_profile_space, constraint flags, chroma format…) —
          // not implemented yet. Better a loud failure than a broken
          // init segment that players reject cryptically.
          console.warn('[HLSEncoder] H.265 fMP4 with Annex-B description: ' +
            'hvcC record building not implemented (Node encoder path). ' +
            'Use format=ts for H.265, or h264 for fMP4.');
          configBytes = null;
        } else {
          var rec = buildAvcCFromAnnexB(configBytes);
          if (rec) configBytes = rec;
        }
      }
    } else if (vCodec === 'av1' && chunk.type === 'key') {
      // AV1 fallback: keyframes always carry a Sequence Header OBU.
      // Build av1C from the codec string + that OBU. Wrapped in try/catch
      // so a malformed codec string doesn't crash the encoder mid-stream;
      // the next keyframe gets another shot.
      var av1CodecStr = v.codecString || _defaultVideoCodecString('av1', v.width, v.height);
      try {
        configBytes = _extractAv1ConfigFromChunk(au, av1CodecStr);
      } catch (e) { /* leave configBytes null, retry on next chunk */ }
    }

    if (configBytes) {
      this._writer.setVideoConfig(configBytes, {
        width:  (dcfg && dcfg.codedWidth)  || v.width,
        height: (dcfg && dcfg.codedHeight) || v.height,
      });
      this._videoConfigCaptured = true;
    }
  }

  // Use the input frame's PTS, not chunk.timestamp — see the comment
  // at _videoInputPtsQueue in the constructor for why. With realtime
  // mode the queue is FIFO (no reordering), so shift() always pairs
  // the next chunk with its original input PTS.
  var ptsUs = this._videoInputPtsQueue.shift();
  if (ptsUs === undefined) {
    // Defensive: should never happen in practice. Fall back to
    // chunk.timestamp so we still produce output rather than crash.
    ptsUs = chunk.timestamp;
  }

  // CEA-608 closed-caption injection. Pull cc_data triples scheduled
  // for this frame's PTS window, wrap them in an ATSC A/53 SEI NAL,
  // and prepend to the AU. The SEI sits BEFORE any VCL NALU (slice/
  // IDR) but AFTER the AUD if one is present, per H.264 §7.4.1.2.3.
  //
  // We pull triples for the window [ptsUs, ptsUs + frameDurationUs)
  // — using chunk.duration when the encoder reports it, otherwise
  // falling back to a 30fps frame duration. The CEA608 encoder paces
  // its output to fit into one frame's worth of cc_data (max 2
  // triples at NTSC rates), so this gives every queued byte-pair a
  // home without dropping any.
  if (this._cea608) {
    var frameDurUs = (chunk.duration && chunk.duration > 0)
      ? chunk.duration : _DEFAULT_FRAME_DURATION_US;
    var triples = this._cea608.getCcDataForFrame(ptsUs, ptsUs + frameDurUs);
    if (triples.length > 0) {
      var seiNal = buildCea608SeiNalu(triples, this._captionsIsH265);
      au = injectSeiIntoAU(au, seiNal, this._captionsIsH265);
    }
  }

  this._segmentBuilder.pushVideo(au, {
    ptsUs: ptsUs,
    isKey: chunk.type === 'key',
  });
};

HLSEncoder.prototype._onAudioChunk = function (chunk, metadata) {
  // For fMP4: capture audio decoder config from the first chunk.
  //
  // AAC: metadata.decoderConfig.description is the AudioSpecificConfig.
  //      Required by the writer (esds box can't be built without it).
  // Opus: metadata.decoderConfig.description (when present) is the
  //       OpusHead per WebCodecs spec / RFC 7845 §5.1. Optional —
  //       writer can synthesize a valid dOps from sampleRate/channels
  //       alone. Some browsers don't populate description for Opus, so
  //       we still call setAudioConfig with null bytes when missing.
  if (this._format === 'fmp4' && !this._audioConfigCaptured) {
    var dcfg = metadata && metadata.decoderConfig;
    var desc = (dcfg && dcfg.description) ? new Uint8Array(dcfg.description) : null;
    if (desc || this._resolvedAudioCodec === 'opus') {
      this._writer.setAudioConfig(desc, {
        sampleRate: (dcfg && dcfg.sampleRate)       || this._resolvedAudioSampleRate,
        channels:   (dcfg && dcfg.numberOfChannels) || this._resolvedAudioChannels,
      });
      this._audioConfigCaptured = true;
    }
  }

  // For TS: chunk is ADTS-wrapped (AAC). For fMP4: chunk is raw AAC or raw Opus.
  var data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);

  // Restamp to perfectly uniform spacing — see the comment at
  // _audioFirstChunkPtsUs in the constructor for why. The very first
  // chunk anchors the timeline at its real timestamp; every chunk
  // after that gets exactly first + N * step µs.
  //
  // Step is codec-dependent:
  //   AAC LC: 1024 samples / sampleRate seconds. At 48kHz = 21333.33µs.
  //   Opus  : 20ms (960 samples at 48kHz) by default. The encoder
  //           reports this via chunk.duration; we trust it for Opus
  //           because Opus frame timing is exact (each packet's
  //           duration is one of {2.5,5,10,20,40,60}ms).
  //
  // For AAC we deliberately *override* chunk.duration with the
  // computed 1024/sampleRate because Chrome's reported duration has
  // small rounding errors that compound over thousands of frames.
  if (this._audioFirstChunkPtsUs === null) {
    this._audioFirstChunkPtsUs = chunk.timestamp;
    var sampleRate = this._resolvedAudioSampleRate || _DEFAULT_AUDIO_SAMPLE_RATE;
    if (this._resolvedAudioCodec === 'opus' && chunk.duration > 0) {
      this._audioPtsStepUs  = chunk.duration;
      this._audioDurationUs = chunk.duration;
    } else {
      this._audioPtsStepUs  = _AAC_LC_SAMPLES_PER_FRAME * 1000000 / sampleRate;
      this._audioDurationUs = Math.round(this._audioPtsStepUs);
    }
  }
  var ptsUs = this._audioFirstChunkPtsUs +
              Math.round(this._audioChunksEmitted * this._audioPtsStepUs);
  var durationUs = this._audioDurationUs;

  this._audioChunksEmitted++;

  this._segmentBuilder.pushAudio(data, {
    ptsUs: ptsUs,
    durationUs: durationUs,
  });
};


// ── Segment delivery ──────────────────────────────────────

HLSEncoder.prototype._onSegment = function (info) {
  // Init segment (fMP4 only). Fire 'segment' event with the init URI
  // so the caller can upload it once. Do NOT add it to the playlist's
  // segment list — it's referenced via #EXT-X-MAP, set on the
  // Playlist constructor.
  if (info.kind === 'init') {
    this._ee.emit('segment', {
      kind:  'init',
      bytes: info.bytes,
      uri:   this._initSegmentUri,
    });
    return;
  }

  // Media segment.
  var uri = this._segmentUriPattern.replace('{n}', info.sequence);

  this._playlist.addSegment({
    uri: uri,
    duration: info.duration,
  });

  // Update bandwidth tracking. Per HLS RFC 8216 §4.3.4.2 BANDWIDTH is
  // "the peak segment bit rate" — a monotonic max. Init segment is
  // excluded (loaded once, not per-segment). Duration is in seconds
  // already, bytes count includes all box overhead (moof + mdat + emsg
  // for fMP4, full TS packets for ts).
  if (info.duration > 0) {
    var segBps = (info.bytes.length * 8) / info.duration;
    if (this._peakBpsObserved === null || segBps > this._peakBpsObserved) {
      this._peakBpsObserved = segBps;
    }
    this._totalSegmentBytes       += info.bytes.length;
    this._totalSegmentDurationSec += info.duration;
  }

  this._ee.emit('segment', {
    kind:       'media',
    bytes:      info.bytes,
    uri:        uri,
    duration:   info.duration,
    sequence:   info.sequence,
    parts:      info.parts,   // present only in LL-HLS mode; undefined otherwise
    iFrame:     info.iFrame,  // present only when iFramePlaylist enabled
  });

  // I-frame playlist update. The keyframe of every segment becomes
  // one entry in the parallel I-frame playlist with byte range
  // pointing at the keyframe within the parent file.
  if (this._iFramePlaylistEnabled && info.iFrame) {
    this._iFramePlaylist.addSegment({
      uri:      uri,
      duration: info.duration,
      byterange: {
        length: info.iFrame.byteLength,
        offset: info.iFrame.byteOffset,
      },
    });
    // Bandwidth tracking for I-frame variant (peak + average). The
    // bytes are the I-frame range only, the duration is the segment's
    // duration (since the keyframe represents the entire segment from
    // a trick-play perspective).
    if (info.duration > 0) {
      var iFrameBps = (info.iFrame.byteLength * 8) / info.duration;
      if (this._iFramePeakBpsObserved === null ||
          iFrameBps > this._iFramePeakBpsObserved) {
        this._iFramePeakBpsObserved = iFrameBps;
      }
      this._iFrameTotalBytes       += info.iFrame.byteLength;
      this._iFrameTotalDurationSec += info.duration;
    }
    this._ee.emit('iframe-playlist', this._iFramePlaylist.serialize());
  }

  // LL-HLS: tell the playlist where the FIRST part of the next segment
  // will live. Players use this for PRELOAD-HINT — they request the
  // first byte of that URI before any part exists, and the server
  // holds the request open. Predicting the URI is safe: we always use
  // sequence + 1 (the segment URI pattern is stable).
  if (this._partDurationSec > 0) {
    var nextUri = this._segmentUriPattern.replace('{n}', info.sequence + 1);
    this._playlist.setNextSegmentUri(nextUri);
  }

  this._ee.emit('manifest', this._playlist.serialize());
};

/**
 * LL-HLS: forward a partial segment to the caller as it's emitted.
 * Parts arrive at ~partDuration intervals during a segment; the full
 * 'segment' event still fires once the segment closes.
 *
 * The playlist is updated and re-serialized on every part so polling
 * players see the new EXT-X-PART entries within a refresh cycle. This
 * is the lever that delivers low latency — players that block on the
 * playlist (CAN-BLOCK-RELOAD) get woken up immediately when a new
 * part is available.
 */
HLSEncoder.prototype._onPart = function (info) {
  // The segment URI is the eventual file the parts belong to. We
  // compute it the same way as in _onSegment, using the segment
  // sequence the part was emitted under.
  var uri = this._segmentUriPattern.replace('{n}', info.segmentSequence);

  this._playlist.addPart({
    uri:         uri,
    duration:    info.duration,
    byteOffset:  info.byteOffset,
    byteLength:  info.byteLength,
    independent: info.independent,
  });

  this._ee.emit('part', {
    bytes:           info.bytes,
    uri:             uri,
    duration:        info.duration,
    segmentSequence: info.segmentSequence,
    partIndex:       info.partIndex,
    byteOffset:      info.byteOffset,
    byteLength:      info.byteLength,
    independent:     info.independent,
    final:           info.final,
  });

  // Re-emit the manifest so polling clients see the new part. This
  // is the rapid-update path that gives LL-HLS its latency edge.
  this._ee.emit('manifest', this._playlist.serialize());
};


export default HLSEncoder;
