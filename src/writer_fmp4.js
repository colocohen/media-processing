/**
 * writer-fmp4 — Fragmented MP4 (ISO BMFF) container writer for HLS / CMAF.
 *
 * Symmetric counterpart to reader_fmp4.js. Produces the two file kinds
 * defined by the fMP4 streaming model:
 *
 *   1. INIT SEGMENT (`ftyp` + `moov`) — one per stream. Holds codec
 *      configuration: SPS/PPS for video, AudioSpecificConfig for audio,
 *      track timescales, dimensions. Referenced from the m3u8 by
 *      `#EXT-X-MAP:URI="init.mp4"`. Players load it once before any
 *      media segment, then keep it cached.
 *
 *   2. MEDIA SEGMENT (`moof` + `mdat`) — one per HLS segment. Holds
 *      one fragment's worth of samples (a sequence number, per-sample
 *      timing info, raw sample bytes). Self-contained as long as the
 *      init segment is present.
 *
 * Usage:
 *   var w = new FMP4Writer({
 *     video: { codec: 'h264', width: 1280, height: 720 },
 *     audio: { codec: 'aac',  sampleRate: 48000, channels: 2 },
 *   });
 *
 *   // Set codec configs once (HLSEncoder pulls them from
 *   // VideoEncoder/AudioEncoder metadata.decoderConfig.description).
 *   w.setVideoConfig(avcCBytes);
 *   w.setAudioConfig(audioSpecificConfigBytes);
 *
 *   var initBytes = w.writeInit();              // emit once
 *   var segBytes  = w.writeSegment(vidChunks, audChunks);  // per segment
 *
 * Input format:
 *   - Video chunks: Uint8Array AUs in **AVCC format** (length-prefixed
 *     NAL units, NOT Annex-B). This is what WebCodecs' VideoEncoder
 *     emits with `avc:{format:'avc'}` (the default). Do NOT pass
 *     Annex-B here — fMP4 expects each sample in mdat to be the
 *     decoder-ready AVCC bytes.
 *   - Audio chunks: Uint8Array RAW AAC frames (NOT ADTS-wrapped).
 *     This is what WebCodecs' AudioEncoder emits with `aac:{format:'aac'}`
 *     (the default).
 *
 * The format mismatch between TS (Annex-B + ADTS) and fMP4 (AVCC + raw
 * AAC) is the only externally visible difference between the writers.
 * HLSEncoder handles this by configuring the WebCodecs encoders with
 * different output formats based on the chosen container.
 *
 * Box layout reference: ISO/IEC 14496-12 (BMFF), 14496-14 (MP4 file),
 * 14496-15 (NAL-based codecs in MP4).
 */

import { writeU16BE, writeU32BE, writeU64BE, concat, fromAscii } from './core/bytes.js';


// ── Box helpers ────────────────────────────────────────────
//
// Every box is `[size:4][type:4][payload...]`. Boxes whose size
// exceeds 2^32 use an extended-size form (size=1 + 8 extra bytes);
// we never produce that — fMP4 fragments are far smaller.

/**
 * Build a basic box with the given 4-char type and payload bytes.
 */
function _box(type, payload) {
  var typeBytes = fromAscii(type);  // length 4
  var size = 8 + payload.length;
  var out = new Uint8Array(size);
  writeU32BE(out, 0, size);
  out.set(typeBytes, 4);
  out.set(payload, 8);
  return out;
}

/**
 * Build a "full box" — basic box plus 1-byte version + 3-byte flags.
 * Most boxes inside `moov` and `moof` are full boxes.
 */
function _fullBox(type, version, flags, payload) {
  var typeBytes = fromAscii(type);
  var size = 8 + 4 + payload.length;
  var out = new Uint8Array(size);
  writeU32BE(out, 0, size);
  out.set(typeBytes, 4);
  out[8] = version & 0xFF;
  out[9]  = (flags >> 16) & 0xFF;
  out[10] = (flags >> 8)  & 0xFF;
  out[11] = flags & 0xFF;
  out.set(payload, 12);
  return out;
}

/**
 * Build a container box (only contains other boxes — no payload of its
 * own). Just concats the children and wraps.
 */
function _container(type, children) {
  return _box(type, concat(children));
}


// ── ftyp ───────────────────────────────────────────────────

/**
 * File Type Box (ISO 14496-12 §4.3). Declares the major brand and
 * compatible brands. Every fMP4 file begins with this.
 *
 * We use `iso5` as major — the brand mandated for fMP4 with
 * `default_base_is_moof` (which we set in tfhd). The compatible
 * brands list is a superset that most parsers will accept.
 */
function _ftyp() {
  var brands = ['iso5', 'iso6', 'mp41', 'mp42', 'avc1'];
  var majorBrand = fromAscii('iso5');
  var minorVersion = new Uint8Array([0, 0, 0, 1]);
  var compat = concat(brands.map(fromAscii));
  return _box('ftyp', concat([majorBrand, minorVersion, compat]));
}


// ── moov hierarchy ─────────────────────────────────────────

/**
 * Movie Header Box. The "header for the entire presentation". Most of
 * its fields are largely vestigial for fragmented streams (duration is
 * 0, modification times are 0), but the box must be present and
 * structurally valid.
 *
 * Field layout (version 0):
 *   creation_time(4) | modification_time(4) | timescale(4) |
 *   duration(4) | rate(4) | volume(2) | reserved(10) |
 *   matrix(36) | pre_defined(24) | next_track_ID(4)
 */
function _mvhd(timescale, nextTrackId) {
  var p = new Uint8Array(96);
  // creation/modification times = 0
  // timescale at offset 8
  writeU32BE(p, 8, timescale);
  // duration = 0 (fragmented — declared via mvex/trex)
  // rate at offset 16 (16.16 fixed) = 1.0 = 0x00010000
  writeU32BE(p, 16, 0x00010000);
  // volume at offset 20 (8.8 fixed) = 1.0 = 0x0100
  p[20] = 0x01; p[21] = 0x00;
  // reserved 10 bytes
  // unity matrix at offset 32 (9 × 4 bytes = 36)
  //   { 1, 0, 0, 0, 1, 0, 0, 0, 16384 } in 16.16/2.30 fixed-point
  var matrix = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
  for (var i = 0; i < 9; i++) writeU32BE(p, 32 + i * 4, matrix[i]);
  // pre_defined 24 bytes at offset 68
  // next_track_ID at offset 92
  writeU32BE(p, 92, nextTrackId);
  return _fullBox('mvhd', 0, 0, p);
}

/**
 * Track Header Box. Per-track metadata. Like mvhd, mostly structural
 * for fMP4 — the actual decode-time info comes from the per-fragment
 * tfdt and trun.
 *
 * Field layout (version 0):
 *   creation_time(4)     [0..3]
 *   modification_time(4) [4..7]
 *   track_ID(4)          [8..11]
 *   reserved(4)          [12..15]
 *   duration(4)          [16..19]
 *   reserved(8)          [20..27]
 *   layer(2)             [28..29]
 *   alternate_group(2)   [30..31]
 *   volume(2)            [32..33]   — 1.0 for audio, 0 for video
 *   reserved(2)          [34..35]
 *   matrix(36)           [36..71]
 *   width(4 — 16.16)     [72..75]
 *   height(4 — 16.16)    [76..79]
 *
 * Total: 80 bytes. flags = 0x000003 (track_enabled | track_in_movie).
 */
function _tkhd(trackId, width, height, isAudio) {
  var p = new Uint8Array(80);
  writeU32BE(p, 8, trackId);
  if (isAudio) { p[32] = 0x01; p[33] = 0x00; }
  var matrix = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
  for (var i = 0; i < 9; i++) writeU32BE(p, 36 + i * 4, matrix[i]);
  if (!isAudio) {
    writeU32BE(p, 72, (width  | 0) << 16);
    writeU32BE(p, 76, (height | 0) << 16);
  }
  return _fullBox('tkhd', 0, 0x000003, p);
}

/**
 * Media Header Box. Per-track timescale and duration. Timescale here
 * is the unit used by the track's tfdt and trun — for video we use
 * 90000 (matches MPEG-TS PTS), for audio we use the actual sample rate
 * (so frame durations are exact integers and there's no drift).
 */
function _mdhd(timescale) {
  var p = new Uint8Array(20);
  // creation_time(4), modification_time(4) — both 0
  writeU32BE(p, 8, timescale);
  // duration(4) = 0 (fragmented)
  // language(2) — 'und' = 0x55C4 (3 × 5-bit packed: u=21, n=14, d=4)
  p[16] = 0x55; p[17] = 0xC4;
  // pre_defined(2) = 0
  return _fullBox('mdhd', 0, 0, p);
}

/**
 * Handler Reference Box. Identifies the track type via a 4-CC handler
 * ('vide' for video, 'soun' for audio).
 */
function _hdlr(handlerType, name) {
  var nameBytes = fromAscii(name);
  var p = new Uint8Array(20 + nameBytes.length + 1);
  // pre_defined(4) = 0 at offset 0
  // handler_type(4) at offset 4
  p.set(fromAscii(handlerType), 4);
  // reserved(12) at offset 8
  // name (UTF-8 + null terminator) at offset 20
  p.set(nameBytes, 20);
  // null terminator already 0
  return _fullBox('hdlr', 0, 0, p);
}

/**
 * Video Media Header Box. Required for video tracks. The flags field
 * MUST be 1 (signals VMHD; pre-2008 spec quirk).
 */
function _vmhd() {
  var p = new Uint8Array(8);
  // graphicsmode(2) = 0, opcolor(6) = {0,0,0}
  return _fullBox('vmhd', 0, 0x000001, p);
}

/**
 * Sound Media Header Box. Required for audio tracks.
 */
function _smhd() {
  var p = new Uint8Array(4);
  // balance(2) = 0, reserved(2) = 0
  return _fullBox('smhd', 0, 0, p);
}

/**
 * Data Reference Box. Specifies where the sample data lives. For
 * self-contained fMP4, the sole entry is a "data reference URL" with
 * flag 1 ("data is in the same file") and an empty URL.
 */
function _dref() {
  // entry_count(4) = 1, then one url box
  var url = _fullBox('url ', 0, 0x000001, new Uint8Array(0));
  var entryCount = new Uint8Array(4);
  writeU32BE(entryCount, 0, 1);
  return _fullBox('dref', 0, 0, concat([entryCount, url]));
}

function _dinf() {
  return _container('dinf', [_dref()]);
}


// ── Sample description (avc1 / mp4a) ──────────────────────

/**
 * AVC Configuration Box. Wraps the AVCDecoderConfigurationRecord
 * (which is exactly what WebCodecs' VideoEncoder hands us via
 * metadata.decoderConfig.description in 'avc' format mode). No
 * massaging needed — pass the bytes through.
 *
 * For HEVC, the equivalent box is hvcC and the bytes are the
 * HEVCDecoderConfigurationRecord.
 */
function _avcC(avcCBytes) { return _box('avcC', avcCBytes); }
function _hvcC(hvcCBytes) { return _box('hvcC', hvcCBytes); }

/**
 * VP Codec Configuration Box (vpcC). Per ISO/IEC 14496-15 §A.2.
 * FullBox(version=1, flags=0) wrapping a 8-byte VPCodecConfigurationRecord
 * (codecIntializationDataSize=0 for VP9 in fMP4 — VP9 keyframes carry
 * their own setup info inline, so no out-of-band initialization data
 * is needed).
 *
 * Record layout (caller pre-fills these 8 bytes):
 *   profile(1)  level(1)
 *   bitDepth(4 bits) | chromaSubsampling(3 bits) | videoFullRangeFlag(1 bit)  (1 byte)
 *   colourPrimaries(1)
 *   transferCharacteristics(1)
 *   matrixCoefficients(1)
 *   codecIntializationDataSize(2 BE) = 0
 */
function _vpcC(recordBytes) { return _fullBox('vpcC', 1, 0, recordBytes); }

/**
 * AV1 Codec Configuration Box (av1C). Per AV1-ISOBMFF §2.3.
 * Plain Box (NOT a FullBox) wrapping the AV1CodecConfigurationRecord
 * bytes verbatim. The record contains both the marker/version fields
 * AND the Sequence Header OBU (configOBUs), which the encoder must
 * provide — players can't decode AV1 without seeing the seqHdr OBU
 * once before the first frame.
 *
 * WebCodecs AV1 encoders emit this complete record via
 * metadata.decoderConfig.description, so we just wrap and forward.
 */
function _av1C(recordBytes) { return _box('av1C', recordBytes); }

/**
 * Visual Sample Entry header (ISO 14496-12 §8.5.2, AVC1/HEV1 in §15
 * of 14496-15). 78 bytes of mostly-fixed fields, followed by codec-
 * specific config boxes.
 *
 * Layout:
 *   reserved(6) | data_reference_index(2) |
 *   pre_defined(2) | reserved(2) | pre_defined(12) |
 *   width(2) | height(2) |
 *   horizresolution(4 — 16.16) | vertresolution(4 — 16.16) |
 *   reserved(4) | frame_count(2) |
 *   compressorname(32 — Pascal-style fixed-length) |
 *   depth(2) | pre_defined(2)
 */
function _visualSampleEntry(type, width, height, configBox) {
  var hdr = new Uint8Array(78);
  // reserved(6) — zeros
  // data_reference_index(2) at offset 6 = 1
  hdr[6] = 0; hdr[7] = 1;
  // pre_defined(2) at 8, reserved(2) at 10, pre_defined(12) at 12 — all 0
  // width at 24
  writeU16BE(hdr, 24, width);
  // height at 26
  writeU16BE(hdr, 26, height);
  // horizresolution at 28 = 0x00480000 (72 dpi)
  writeU32BE(hdr, 28, 0x00480000);
  // vertresolution at 32 = 0x00480000
  writeU32BE(hdr, 32, 0x00480000);
  // reserved(4) at 36
  // frame_count(2) at 40 = 1
  hdr[40] = 0; hdr[41] = 1;
  // compressorname at 42 — 32-byte fixed string. First byte = length.
  // Leave empty (length=0, padded with zeros).
  // depth(2) at 74 = 0x0018 (24-bit color)
  hdr[74] = 0x00; hdr[75] = 0x18;
  // pre_defined(2) at 76 = -1 (0xFFFF)
  hdr[76] = 0xFF; hdr[77] = 0xFF;
  return _box(type, concat([hdr, configBox]));
}

/**
 * Elementary Stream Descriptor Box (esds). Wraps the MPEG-4 Systems
 * descriptor structure that carries AAC's AudioSpecificConfig. Each
 * level is a tag + length-encoded body, where length uses MPEG-4's
 * variable-length scheme (continuation bit in the high bit of each
 * byte). For our (small) sizes one byte suffices everywhere.
 *
 * Hierarchy:
 *   ES_Descriptor (tag 0x03)
 *     ES_ID(2) | flags(1)
 *     DecoderConfigDescriptor (tag 0x04)
 *       objectTypeIndication(1)=0x40 | streamType(1)=0x15 |
 *       bufferSizeDB(3) | maxBitrate(4) | avgBitrate(4)
 *       DecoderSpecificInfo (tag 0x05)
 *         AudioSpecificConfig bytes
 *     SLConfigDescriptor (tag 0x06)
 *       predefined(1)=0x02
 */
function _esds(audioSpecificConfig) {
  var asc = audioSpecificConfig;
  var ascLen = asc.length;
  // DecoderSpecificInfo: tag(1) + len(1) + asc
  var dsi = new Uint8Array(2 + ascLen);
  dsi[0] = 0x05; dsi[1] = ascLen;
  dsi.set(asc, 2);

  // DecoderConfigDescriptor: tag(1) + len(1) + 13 fixed bytes + dsi
  var dcdLen = 13 + dsi.length;
  var dcd = new Uint8Array(2 + dcdLen);
  dcd[0] = 0x04; dcd[1] = dcdLen;
  dcd[2] = 0x40;            // objectTypeIndication = MPEG-4 Audio
  dcd[3] = 0x15;            // streamType = Audio (5) << 2 | upStream(0) | reserved(1)
  // bufferSizeDB(3) at 4..6 = 0
  // maxBitrate(4) at 7..10 = 0 (unknown / VBR)
  // avgBitrate(4) at 11..14 = 0
  dcd.set(dsi, 15);

  // SLConfigDescriptor: tag(1) + len(1) + 1 byte
  var slc = new Uint8Array([0x06, 0x01, 0x02]);

  // ES_Descriptor: tag(1) + len(1) + ES_ID(2) + flags(1) + dcd + slc
  var esdLen = 3 + dcd.length + slc.length;
  var esd = new Uint8Array(2 + esdLen);
  esd[0] = 0x03; esd[1] = esdLen;
  // ES_ID(2) at 2..3 = 0
  // flags(1) at 4 = 0
  esd.set(dcd, 5);
  esd.set(slc, 5 + dcd.length);

  return _fullBox('esds', 0, 0, esd);
}

/**
 * Audio Sample Entry header (mp4a). 28 bytes.
 *
 *   reserved(6) | data_reference_index(2) |
 *   reserved(8) | channelcount(2) | samplesize(2) |
 *   pre_defined(2) | reserved(2) |
 *   sample_rate(4) — high 16 bits = integer rate, low 16 = 0
 */
function _audioSampleEntry(channels, sampleRate, esdsBox) {
  var hdr = new Uint8Array(28);
  // reserved(6)
  // data_reference_index(2) at 6 = 1
  hdr[6] = 0; hdr[7] = 1;
  // reserved(8) at 8..15
  // channelcount(2) at 16
  writeU16BE(hdr, 16, channels);
  // samplesize(2) at 18 = 16
  writeU16BE(hdr, 18, 16);
  // pre_defined(2) at 20, reserved(2) at 22
  // sample_rate at 24 — top 16 bits hold the integer rate. The 16.16
  // fixed-point format can only represent rates up to 65535. For studio
  // rates (96000, 192000) we write 0 here; players read the actual rate
  // from esds (AAC AudioSpecificConfig) or dOps (Opus) anyway, both of
  // which carry the full 32-bit sample rate. This matches FFmpeg's
  // behavior for high-rate audio in MP4.
  if (sampleRate <= 0xFFFF) {
    writeU16BE(hdr, 24, sampleRate);
  }
  // else: leave bytes 24..27 as 0 — esds/dOps is authoritative
  return _box('mp4a', concat([hdr, esdsBox]));
}

/**
 * Opus Specific Box (dOps). Carries the Opus decoder configuration
 * inside an fMP4 sample entry — the equivalent of esds for AAC.
 *
 * Spec: https://opus-codec.org/docs/opus_in_isobmff.html
 *
 *   Version(1) = 0  (NB: dOps Version is 0, NOT the OpusHead Version=1)
 *   OutputChannelCount(1)
 *   PreSkip(2 BE)
 *   InputSampleRate(4 BE)
 *   OutputGain(2 BE signed) — almost always 0
 *   ChannelMappingFamily(1) — 0 for mono/stereo (no mapping table)
 *   [if family != 0: StreamCount(1), CoupledCount(1), ChannelMapping[N](1 each)]
 *
 * dOps is a regular Box (not a FullBox), so no version/flags prefix.
 *
 * @param {Uint8Array|null} opusHead  Optional OpusHead bytes from
 *   WebCodecs metadata.decoderConfig.description (RFC 7845 §5.1, LE
 *   encoding). When provided, PreSkip / InputSampleRate / OutputGain /
 *   ChannelMappingFamily are read from it (and byte-swapped LE→BE).
 *   When null, sensible defaults are used (PreSkip=312, the standard
 *   Opus encoder pre-skip at 48kHz).
 * @param {number} fallbackChannels   Used when opusHead is null.
 * @param {number} fallbackSampleRate Used when opusHead is null.
 */
function _dOps(opusHead, fallbackChannels, fallbackSampleRate) {
  var channels, preSkip, sampleRate, outputGain, family;
  var mappingTable = null;

  if (opusHead && opusHead.length >= 19) {
    // OpusHead layout (LE):
    //   0..7:  "OpusHead" magic
    //   8:     Version (always 1 in OpusHead)
    //   9:     OutputChannelCount
    //  10..11: PreSkip (LE u16)
    //  12..15: InputSampleRate (LE u32)
    //  16..17: OutputGain (LE i16)
    //  18:     ChannelMappingFamily
    //  [if family != 0: 19=StreamCount, 20=CoupledCount, 21..21+N-1=ChannelMapping]
    channels   = opusHead[9];
    preSkip    = opusHead[10] | (opusHead[11] << 8);
    sampleRate = (opusHead[12]) | (opusHead[13] << 8) |
                 (opusHead[14] << 16) | (opusHead[15] << 24);
    sampleRate = sampleRate >>> 0;  // unsigned
    var gainLE = opusHead[16] | (opusHead[17] << 8);
    // Sign-extend the LE 16-bit value
    outputGain = (gainLE & 0x8000) ? gainLE - 0x10000 : gainLE;
    family     = opusHead[18];

    if (family !== 0 && opusHead.length >= 21 + channels) {
      mappingTable = new Uint8Array(2 + channels);
      mappingTable[0] = opusHead[19];           // StreamCount
      mappingTable[1] = opusHead[20];           // CoupledCount
      for (var mi = 0; mi < channels; mi++) {
        mappingTable[2 + mi] = opusHead[21 + mi];
      }
    }
  } else {
    // No OpusHead: build defaults. PreSkip=312 is the standard pre-skip
    // for libopus at 48kHz (the encoder's lookahead), used by every
    // modern Opus encoder including Chrome's WebCodecs implementation.
    channels   = fallbackChannels   || 2;
    preSkip    = 312;
    sampleRate = fallbackSampleRate || 48000;
    outputGain = 0;

    if (channels <= 2) {
      // 1-2 channels: ChannelMappingFamily=0 is the simplest form
      // (no mapping table). RFC 7845 §5.1.1 reserves Family=0 for
      // exactly this — implicit Vorbis-like layout for mono/stereo.
      family = 0;
    } else {
      // 3+ channels: must use Family=1 (Vorbis-style) per RFC 7845.
      // We build the standard libopus mapping for the most common
      // multi-channel configurations:
      //
      //   5.1 (6ch): streams=4, coupled=2, mapping=[0,4,1,5,2,3]
      //   7.1 (8ch): streams=5, coupled=3, mapping=[0,6,1,2,7,3,4,5]
      //
      // For 3, 4, 5, 7 channels (uncommon), fall back to all-
      // uncoupled (StreamCount=channels, CoupledCount=0,
      // mapping=identity). Decoders accept this; producers wanting
      // better quality should provide their own OpusHead via
      // setAudioConfig().
      family = 1;
      mappingTable = new Uint8Array(2 + channels);
      if (channels === 6) {
        mappingTable[0] = 4; mappingTable[1] = 2;
        mappingTable[2] = 0; mappingTable[3] = 4;
        mappingTable[4] = 1; mappingTable[5] = 5;
        mappingTable[6] = 2; mappingTable[7] = 3;
      } else if (channels === 8) {
        mappingTable[0] = 5; mappingTable[1] = 3;
        mappingTable[2] = 0; mappingTable[3] = 6;
        mappingTable[4] = 1; mappingTable[5] = 2;
        mappingTable[6] = 7; mappingTable[7] = 3;
        mappingTable[8] = 4; mappingTable[9] = 5;
      } else {
        // Generic: all uncoupled, identity mapping
        mappingTable[0] = channels;  // StreamCount
        mappingTable[1] = 0;         // CoupledCount
        for (var i = 0; i < channels; i++) mappingTable[2 + i] = i;
      }
    }
  }

  var bodySize = 11 + (mappingTable ? mappingTable.length : 0);
  var body = new Uint8Array(bodySize);
  body[0] = 0;          // Version (dOps requires 0, not the OpusHead's 1)
  body[1] = channels;
  body[2] = (preSkip >>> 8) & 0xFF;
  body[3] =  preSkip        & 0xFF;
  body[4] = (sampleRate >>> 24) & 0xFF;
  body[5] = (sampleRate >>> 16) & 0xFF;
  body[6] = (sampleRate >>> 8)  & 0xFF;
  body[7] =  sampleRate         & 0xFF;
  // OutputGain as signed 16-bit BE
  var gainU16 = outputGain < 0 ? outputGain + 0x10000 : outputGain;
  body[8] = (gainU16 >>> 8) & 0xFF;
  body[9] =  gainU16        & 0xFF;
  body[10] = family;
  if (mappingTable) body.set(mappingTable, 11);

  return _box('dOps', body);
}

/**
 * Opus Sample Entry ('Opus'). Inherits AudioSampleEntry — same 28-byte
 * header as mp4a — but carries dOps instead of esds.
 *
 * The HLS / CMAF authoring spec requires this exact layout for Opus
 * audio in fMP4 segments. Codec string in CODECS attribute: "opus".
 */
function _opusSampleEntry(channels, sampleRate, dOpsBox) {
  var hdr = new Uint8Array(28);
  hdr[6] = 0; hdr[7] = 1;            // data_reference_index = 1
  writeU16BE(hdr, 16, channels);
  writeU16BE(hdr, 18, 16);            // samplesize = 16
  // sample_rate (16.16) — same constraint as _audioSampleEntry: top
  // 16 bits hold the integer, max representable is 65535. Above that
  // we leave it 0; dOps's InputSampleRate (32-bit) is authoritative.
  if (sampleRate <= 0xFFFF) {
    writeU16BE(hdr, 24, sampleRate);
  }
  return _box('Opus', concat([hdr, dOpsBox]));
}

function _stsd(entryBox) {
  var entryCount = new Uint8Array(4);
  writeU32BE(entryCount, 0, 1);
  return _fullBox('stsd', 0, 0, concat([entryCount, entryBox]));
}

// Empty time/size/chunk tables required by the box hierarchy. For
// fMP4 all real timing info lives in the per-fragment trun.
function _emptyFullBox(type) {
  // entry_count(4) = 0
  return _fullBox(type, 0, 0, new Uint8Array(4));
}
function _stsz() {
  // sample_size(4)=0 + sample_count(4)=0
  return _fullBox('stsz', 0, 0, new Uint8Array(8));
}

function _stbl(stsdEntry) {
  return _container('stbl', [
    _stsd(stsdEntry),
    _emptyFullBox('stts'),
    _emptyFullBox('stsc'),
    _stsz(),
    _emptyFullBox('stco'),
  ]);
}

function _minf(isAudio, stsdEntry) {
  return _container('minf', [
    isAudio ? _smhd() : _vmhd(),
    _dinf(),
    _stbl(stsdEntry),
  ]);
}

function _mdia(timescale, isAudio, stsdEntry) {
  return _container('mdia', [
    _mdhd(timescale),
    _hdlr(isAudio ? 'soun' : 'vide', isAudio ? 'SoundHandler' : 'VideoHandler'),
    _minf(isAudio, stsdEntry),
  ]);
}

/**
 * Edit List Box (ISO 14496-12 §8.6.6). Tells the player how to map
 * presentation time to media time — most importantly, that the first
 * `mediaTime` ticks of the track are encoder-side priming and should
 * be DECODED but NOT presented.
 *
 * For AAC LC, Chrome's WebCodecs encoder (and most native encoders)
 * front-load 1024 samples of priming/lookahead in the first chunk.
 * Without an elst, the player presents that priming as 21 ms of
 * decoder noise/silence at the start, which shifts the audible
 * audio 21 ms later than the video — a perceptible A/V lag.
 *
 * For Opus, priming is encoded in OpusHead's pre_skip and handled
 * by the dOps box; no elst needed.
 *
 * Layout (FullBox v0):
 *   entry_count(4)
 *   per entry:
 *     segment_duration(4)    — 0 ⇒ "rest of track" (correct for live
 *                              fMP4 where total duration is unknown)
 *     media_time(4, signed)  — track-timescale ticks to skip from start
 *     media_rate_integer(2)  — 1 (normal speed)
 *     media_rate_fraction(2) — 0
 */
function _elst(mediaTime) {
  var p = new Uint8Array(4 + 12);
  writeU32BE(p, 0, 1);              // entry_count = 1
  writeU32BE(p, 4, 0);              // segment_duration = 0 (until track end)
  writeU32BE(p, 8, mediaTime);      // media_time = priming samples to skip
  writeU16BE(p, 12, 1);             // media_rate_integer = 1
  writeU16BE(p, 14, 0);             // media_rate_fraction = 0
  return _fullBox('elst', 0, 0, p);
}

function _edts(mediaTime) {
  return _container('edts', [_elst(mediaTime)]);
}

function _trak(trackId, timescale, isAudio, width, height, stsdEntry, encoderDelay) {
  // edts goes between tkhd and mdia (ISO 14496-12 §8.3.1 trak layout).
  // Only emitted when encoderDelay > 0 (currently AAC only).
  var children = [_tkhd(trackId, width, height, isAudio)];
  if (encoderDelay && encoderDelay > 0) {
    children.push(_edts(encoderDelay));
  }
  children.push(_mdia(timescale, isAudio, stsdEntry));
  return _container('trak', children);
}

/**
 * Track Extends Box. Declares default sample params per track for use
 * in fragments. Required for fMP4 — its presence is what tells the
 * parser "this file is fragmented, look for moof boxes".
 *
 *   track_ID(4) | default_sample_description_index(4) |
 *   default_sample_duration(4) | default_sample_size(4) |
 *   default_sample_flags(4)
 */
function _trex(trackId) {
  var p = new Uint8Array(20);
  writeU32BE(p, 0, trackId);
  writeU32BE(p, 4, 1);   // sample_description_index = 1 (entry in stsd)
  // others = 0; we set per-sample values in trun.
  return _fullBox('trex', 0, 0, p);
}

function _mvex(trackIds) {
  return _container('mvex', trackIds.map(_trex));
}


// ── Media segment: moof + mdat ─────────────────────────────
//
// Earlier revisions of this file had _mfhd / _tfhd / _tfdt / _trun
// helpers that each allocated a Uint8Array, wrote their fields, and
// wrapped the result in _fullBox — itself another allocation. With
// ~10 of these per segment plus a per-traf concat plus a moof concat,
// every segment cost a dozen small allocations of metadata bytes.
//
// They've all been replaced by _writeMfhdInto / _writeTfhdInto /
// _writeTfdtInto / _writeVideoTrunInto / _writeAudioTrunInto / etc.
// further down. The Into-variants take a target buffer and offset and
// write directly into the segment's final buffer, so the moof comes
// out of writeSegment without any intermediate per-box Uint8Arrays.

// Note: there's no _mdat() helper any more. mdat is the largest box in
// every segment, and going through _box would mean (a) concatenating the
// payload from per-track buffers and (b) copying the whole thing into a
// new wrapper Uint8Array. writeSegment instead writes the mdat header
// (size + 'mdat' tag) directly into the final segment buffer and copies
// each chunk's bytes into place — see the inline assembly there.

// ── In-place fragment helpers ─────────────────────────────
//
// Per-segment moof construction was previously done by composing
// _box / _fullBox / _container, each of which allocates a fresh
// Uint8Array and concatenates. Per segment that's roughly 10 small
// allocations plus 4 concats (per-traf, then moof). The Into-variants
// below write directly into a caller-provided buffer at a given
// offset and return the new offset, avoiding all the intermediate
// allocations. Used only by writeSegment; the init-segment path
// stays on the simpler _box helpers since it runs once per stream.

function _writeMfhdInto(buf, off, sequenceNumber) {
  // Full box: size(4) + 'mfhd'(4) + version+flags(4) + seq(4) = 16 bytes.
  writeU32BE(buf, off, 16);
  buf[off + 4] = 0x6D; buf[off + 5] = 0x66; buf[off + 6] = 0x68; buf[off + 7] = 0x64;  // 'mfhd'
  buf[off + 8] = 0;                  // version
  buf[off + 9]  = 0;                 // flags hi
  buf[off + 10] = 0;
  buf[off + 11] = 0;
  writeU32BE(buf, off + 12, sequenceNumber);
  return off + 16;
}

function _writeTfhdInto(buf, off, trackId) {
  // Full box: size(4) + 'tfhd'(4) + version+flags(4) + track_id(4) = 16 bytes.
  // Flag 0x020000 = default_base_is_moof.
  writeU32BE(buf, off, 16);
  buf[off + 4] = 0x74; buf[off + 5] = 0x66; buf[off + 6] = 0x68; buf[off + 7] = 0x64;  // 'tfhd'
  buf[off + 8] = 0;                  // version
  buf[off + 9]  = 0x02;              // flags hi (0x020000)
  buf[off + 10] = 0x00;
  buf[off + 11] = 0x00;
  writeU32BE(buf, off + 12, trackId);
  return off + 16;
}

function _writeTfdtInto(buf, off, baseDecodeTime) {
  // Full box version=1: size(4) + 'tfdt'(4) + version+flags(4) + dts(8) = 20 bytes.
  writeU32BE(buf, off, 20);
  buf[off + 4] = 0x74; buf[off + 5] = 0x66; buf[off + 6] = 0x64; buf[off + 7] = 0x74;  // 'tfdt'
  buf[off + 8] = 1;                  // version
  buf[off + 9]  = 0;                 // flags
  buf[off + 10] = 0;
  buf[off + 11] = 0;
  writeU64BE(buf, off + 12, baseDecodeTime);
  return off + 20;
}

function _writeVideoTrunInto(buf, off, chunks, dtsTicks, ptsTicks, dataOffset, endPtsUs) {
  var perSample = 16;
  var size = 20 + chunks.length * perSample;
  // flags: data_offset + per-sample duration/size/flags + composition_time_offset
  var flags = 0x000001 | 0x000100 | 0x000200 | 0x000400 | 0x000800;

  writeU32BE(buf, off, size);
  buf[off + 4] = 0x74; buf[off + 5] = 0x72; buf[off + 6] = 0x75; buf[off + 7] = 0x6E;  // 'trun'
  buf[off + 8] = 1;                                          // version=1 (signed CTO)
  buf[off + 9]  = (flags >>> 16) & 0xFF;
  buf[off + 10] = (flags >>> 8) & 0xFF;
  buf[off + 11] = flags & 0xFF;
  writeU32BE(buf, off + 12, chunks.length);
  writeU32BE(buf, off + 16, dataOffset);

  var n = chunks.length;
  var endTicks = (endPtsUs !== undefined && endPtsUs !== null)
    ? _usToTicks(endPtsUs, VIDEO_TIMESCALE)
    : -1;

  var p = off + 20;
  for (var i = 0; i < n; i++) {
    var c = chunks[i];
    var dts_i = dtsTicks[i];

    // duration = next DTS - this DTS. Last sample uses endPtsUs (next
    // segment boundary) when available, otherwise the previous frame's
    // interval. See the longer comment in writeSegment for why this
    // matters — under-counting the last sample's duration leaves
    // audio-leads-video drift across segment boundaries.
    var durTicks;
    if (i + 1 < n) {
      durTicks = dtsTicks[i + 1] - dts_i;
    } else if (endTicks > dts_i) {
      durTicks = endTicks - dts_i;
    } else if (n >= 2) {
      durTicks = dts_i - dtsTicks[i - 1];
    } else {
      durTicks = VIDEO_FALLBACK_FRAME_TICKS;
    }

    // CTO = PTS - DTS. Pre-computed ptsTicks read avoids a per-sample
    // _usToTicks() call (Math.round + mul + div) inside the hot loop.
    var ctoTicks = ptsTicks[i] - dts_i;

    writeU32BE(buf, p,     durTicks);
    writeU32BE(buf, p + 4, c.au.length);
    writeU32BE(buf, p + 8, c.isKey ? 0 : (1 << 16));  // _sampleFlags inlined
    writeU32BE(buf, p + 12, ctoTicks >>> 0);
    p += perSample;
  }
  return off + size;
}

function _writeAudioTrunInto(buf, off, chunks, dataOffset, samplesPerFrame) {
  // Audio trun: no composition offset (PTS == DTS for all audio frames),
  // and every frame in this segment is exactly samplesPerFrame samples
  // = samplesPerFrame ticks at the track's sampleRate timescale (we
  // deliberately ignore chunk.duration here — see the comment in
  // writeSegment for the drift rationale).
  //
  // samplesPerFrame is codec-dependent: AAC LC = 1024, Opus default = 960.
  var perSample = 12;
  var size = 20 + chunks.length * perSample;
  var flags = 0x000001 | 0x000100 | 0x000200 | 0x000400;

  writeU32BE(buf, off, size);
  buf[off + 4] = 0x74; buf[off + 5] = 0x72; buf[off + 6] = 0x75; buf[off + 7] = 0x6E;  // 'trun'
  buf[off + 8] = 1;
  buf[off + 9]  = (flags >>> 16) & 0xFF;
  buf[off + 10] = (flags >>> 8) & 0xFF;
  buf[off + 11] = flags & 0xFF;
  writeU32BE(buf, off + 12, chunks.length);
  writeU32BE(buf, off + 16, dataOffset);

  var n = chunks.length;
  var p = off + 20;
  for (var i = 0; i < n; i++) {
    var c = chunks[i];
    writeU32BE(buf, p,     samplesPerFrame);  // duration (one audio frame)
    writeU32BE(buf, p + 4, c.data.length);    // size in bytes
    writeU32BE(buf, p + 8, 0);                // every audio frame is a sync sample
    p += perSample;
  }
  return off + size;
}

function _writeVideoTrafInto(buf, off, baseDts, chunks, dtsTicks, ptsTicks, dataOffset, endPtsUs) {
  var trafBase = off;
  off += 8;  // reserve space for traf header (size + 'traf'); patched below
  off = _writeTfhdInto(buf, off, VIDEO_TRACK_ID);
  off = _writeTfdtInto(buf, off, baseDts);
  off = _writeVideoTrunInto(buf, off, chunks, dtsTicks, ptsTicks, dataOffset, endPtsUs);
  writeU32BE(buf, trafBase, off - trafBase);
  buf[trafBase + 4] = 0x74; buf[trafBase + 5] = 0x72; buf[trafBase + 6] = 0x61; buf[trafBase + 7] = 0x66;  // 'traf'
  return off;
}

function _writeAudioTrafInto(buf, off, baseDts, chunks, dataOffset, samplesPerFrame) {
  var trafBase = off;
  off += 8;
  off = _writeTfhdInto(buf, off, AUDIO_TRACK_ID);
  off = _writeTfdtInto(buf, off, baseDts);
  off = _writeAudioTrunInto(buf, off, chunks, dataOffset, samplesPerFrame);
  writeU32BE(buf, trafBase, off - trafBase);
  buf[trafBase + 4] = 0x74; buf[trafBase + 5] = 0x72; buf[trafBase + 6] = 0x61; buf[trafBase + 7] = 0x66;  // 'traf'
  return off;
}


// ── DASH Event Message Box (emsg) — for ID3 timed metadata ──
//
// HLS carries ID3 metadata in fMP4 via emsg boxes per ISO/IEC 23001-18
// (the DASHEventMessageBox). We use version 1 (absolute presentation
// time, not delta) — simpler to reason about across segments because
// the time field is the actual track tfdt-equivalent in ticks.
//
// Layout (FullBox v1):
//   timescale(4)              — VIDEO_TIMESCALE so player timeline matches
//   presentation_time(8)      — absolute presentation time in ticks
//   event_duration(4)         — 0 = "instantaneous"
//   id(4)                     — unique event ID (sequential)
//   scheme_id_uri (null-term) — "https://aomedia.org/emsg/ID3" for ID3
//   value (null-term)         — empty string for ID3
//   message_data[]            — the actual ID3v2 frame bytes
//
// Per CMAF spec, emsg boxes go BEFORE moof in the segment.

var ID3_SCHEME_URI = fromAscii('https://aomedia.org/emsg/ID3\x00');
var EMSG_VALUE_EMPTY = fromAscii('\x00');

function _emsgSize(messageDataLen) {
  // FullBox(12) + timescale(4) + presentation_time(8) + event_duration(4)
  // + id(4) + scheme_id_uri(N+1) + value(1) + message_data(M)
  return 12 + 4 + 8 + 4 + 4 + ID3_SCHEME_URI.length + EMSG_VALUE_EMPTY.length + messageDataLen;
}

function _writeEmsgInto(buf, off, presentationTimeTicks, eventDurationTicks, eventId, messageData) {
  var size = _emsgSize(messageData.length);

  writeU32BE(buf, off, size);
  buf[off + 4] = 0x65; buf[off + 5] = 0x6D; buf[off + 6] = 0x73; buf[off + 7] = 0x67;  // 'emsg'
  buf[off + 8] = 1;                          // version = 1
  buf[off + 9] = 0; buf[off + 10] = 0; buf[off + 11] = 0;  // flags = 0

  writeU32BE(buf, off + 12, VIDEO_TIMESCALE);
  writeU64BE(buf, off + 16, presentationTimeTicks);
  writeU32BE(buf, off + 24, eventDurationTicks | 0);
  writeU32BE(buf, off + 28, eventId | 0);

  var p = off + 32;
  buf.set(ID3_SCHEME_URI, p);   p += ID3_SCHEME_URI.length;
  buf.set(EMSG_VALUE_EMPTY, p); p += EMSG_VALUE_EMPTY.length;
  buf.set(messageData, p);

  return off + size;
}


// ══════════════════════════════════════════════════════════
//   FMP4Writer
// ══════════════════════════════════════════════════════════

var VIDEO_TRACK_ID = 1;
var AUDIO_TRACK_ID = 2;
var VIDEO_TIMESCALE = 90000;  // matches MPEG-TS PTS — convenient

// Fallback per-sample duration when none of the standard hints work
// (no next-sample DTS to subtract from, no endPtsUs boundary, only
// one sample in the segment). 30fps in VIDEO_TIMESCALE ticks. Computed
// once at module load.
var VIDEO_FALLBACK_FRAME_TICKS = Math.round(VIDEO_TIMESCALE / 30);

/**
 * @param {object} opts
 * @param {object} [opts.video]  { codec: 'h264'|'h265', width, height }
 * @param {object} [opts.audio]  { codec: 'aac'|'opus', sampleRate, channels }
 *
 * setVideoConfig() must be called with codec config bytes (from
 * WebCodecs decoderConfig.description) before writeInit().
 *
 * setAudioConfig() must be called for AAC (carries the
 * AudioSpecificConfig). For Opus it is optional — if the encoder
 * provides an OpusHead in metadata.decoderConfig.description, pass it
 * through; otherwise we synthesize a valid dOps box from sampleRate /
 * channels alone.
 */
function FMP4Writer(opts) {
  if (!opts) opts = {};
  if (!opts.video && !opts.audio) {
    throw new Error('FMP4Writer: at least one of video/audio must be configured');
  }
  if (opts.video) {
    var vc = opts.video.codec;
    if (vc !== 'h264' && vc !== 'h265' && vc !== 'vp9' && vc !== 'av1') {
      throw new Error("FMP4Writer: video codec must be 'h264', 'h265', 'vp9', or 'av1' (got '" + vc + "')");
    }
  }
  if (opts.audio && opts.audio.codec !== 'aac' && opts.audio.codec !== 'opus') {
    throw new Error('FMP4Writer: audio codec must be aac or opus');
  }

  this._video = opts.video || null;
  this._audio = opts.audio || null;

  this._videoConfig = null;  // avcC / hvcC bytes (DecoderConfigurationRecord)
  this._audioConfig = null;  // AAC: AudioSpecificConfig bytes; Opus: OpusHead bytes (or null)

  this._sequenceNumber = 1;

  // ── Audio cumulative sample tracking ──
  // hls.js (and players in general) trust fMP4 audio tfdt values
  // as-is. They don't restamp the way they do for AAC inside MPEG-TS
  // (where hls.js forces uniform 1024-sample spacing — see the
  // `forceKeyFrameOnDiscontinuity` / audio restamping notes in the
  // hls.js docs). So if our chunk timestamps drift from perfectly
  // uniform 1024-sample spacing — which happens whenever Chrome's
  // AudioEncoder regenerates timestamps based on its declared
  // sample rate while the actual capture rate differs — the drift
  // becomes visible in fMP4 playback but is hidden in TS.
  //
  // To match hls.js's TS behavior, we compute audio tfdt for every
  // segment after the first by adding samplesPerFrame ticks per chunk
  // emitted so far. Within a segment, every audio frame gets its
  // duration declared as samplesPerFrame ticks. This forces the
  // audio timeline to be perfectly uniform regardless of input
  // timestamp jitter.
  //
  // samplesPerFrame is codec-dependent and in some cases
  // configurable: AAC LC = 1024 fixed, Opus = 960 default (20ms at
  // 48kHz) but reconfigurable to 120/240/480/960/1920/2880 by the
  // encoder. We derive it from the first audio chunk's durationUs
  // (microseconds) and track-timescale (= sampleRate), which works
  // regardless of codec. Cached for the lifetime of the writer to
  // avoid drift across segments.
  this._audioFirstChunkBaseTicks = null;
  this._audioCumulativeSamples = 0;
  this._audioSamplesPerFrame = null;

  // Sequential ID for emsg events. Players use this to dedupe events
  // when the same segment is delivered more than once (e.g., on retry
  // after a network blip). Doesn't need to be globally unique — just
  // unique within a single track.
  this._emsgIdCounter = 1;
}

/**
 * Provide the video codec configuration. This is the bytes of
 * `metadata.decoderConfig.description` from VideoEncoder (configured
 * with `avc:{format:'avc'}` for H.264, or `hevc:{format:'hev1'}` for
 * H.265). Must be called once before writeInit().
 *
 * @param {Uint8Array} configBytes
 * @param {object}     [opts]
 * @param {number}     [opts.width]   Override the width passed at construction
 *                                    (useful if the encoder picked a different
 *                                    resolution than requested).
 * @param {number}     [opts.height]  Override the height.
 */
FMP4Writer.prototype.setVideoConfig = function (configBytes, opts) {
  if (!this._video) {
    throw new Error('FMP4Writer: setVideoConfig called but writer has no video track');
  }
  this._videoConfig = configBytes;
  if (opts) {
    if (opts.width)  this._video.width  = opts.width;
    if (opts.height) this._video.height = opts.height;
  }
};

/**
 * Provide the audio codec configuration.
 *
 * AAC: configBytes is the AudioSpecificConfig (required — players
 * cannot decode without it).
 *
 * Opus: configBytes is the OpusHead (RFC 7845 §5.1) from
 * metadata.decoderConfig.description, when the encoder provides it.
 * May be null — _dOps will synthesize sensible defaults from
 * sampleRate / channels alone.
 *
 * @param {Uint8Array|null} configBytes
 * @param {object}     [opts]
 * @param {number}     [opts.sampleRate]  Override the sample rate. Critical
 *                                        for fMP4 — the audio track's mdhd
 *                                        timescale equals this rate, and a
 *                                        wrong value causes audio to play
 *                                        too fast or slow.
 * @param {number}     [opts.channels]    Override the channel count.
 */
FMP4Writer.prototype.setAudioConfig = function (configBytes, opts) {
  if (!this._audio) {
    throw new Error('FMP4Writer: setAudioConfig called but writer has no audio track');
  }
  this._audioConfig = configBytes;  // may be null for Opus
  if (opts) {
    if (opts.sampleRate) this._audio.sampleRate = opts.sampleRate;
    if (opts.channels)   this._audio.channels   = opts.channels;
  }
};

/**
 * True once enough setXxxConfig() calls have been made that
 * writeInit() will succeed. Caller can poll this if it wants to defer
 * init emission.
 */
/**
 * The captured avcC / hvcC bytes, or null before the first keyframe.
 *
 * Exists because HLSEncoder needs the DecoderConfigurationRecord to
 * derive the playlist's CODECS attribute, and was reaching in for
 * `writer._videoConfig` directly — the only cross-file private access in
 * hls_encoder.js, and a hole in this file's own "the writer owns the
 * format" boundary. A reader keeps the boundary intact and lets the
 * field be renamed without breaking a caller.
 */
FMP4Writer.prototype.getVideoConfig = function () {
  return this._videoConfig || null;
};

FMP4Writer.prototype.canWriteInit = function () {
  if (this._video && !this._videoConfig) return false;
  // For AAC the AudioSpecificConfig is mandatory in esds — players
  // refuse to decode without it. For Opus we can synthesize a valid
  // dOps box from sampleRate / channels alone (PreSkip defaults to 312,
  // OutputGain to 0, ChannelMappingFamily to 0). So Opus writers don't
  // need to wait for the encoder to deliver a description.
  if (this._audio && this._audio.codec !== 'opus' && !this._audioConfig) return false;
  return true;
};

/**
 * Build and return the init segment (ftyp + moov). Required before
 * any media segment can be played.
 */
FMP4Writer.prototype.writeInit = function () {
  if (!this.canWriteInit()) {
    throw new Error('FMP4Writer.writeInit: codec config not yet provided ' +
                    '(call setVideoConfig / setAudioConfig first)');
  }

  var traks = [];
  var trackIds = [];

  if (this._video) {
    var vCodec = this._video.codec;
    var configBox, entryType;
    if (vCodec === 'h265') {
      configBox = _hvcC(this._videoConfig);
      entryType = 'hev1';
    } else if (vCodec === 'vp9') {
      configBox = _vpcC(this._videoConfig);
      entryType = 'vp09';
    } else if (vCodec === 'av1') {
      configBox = _av1C(this._videoConfig);
      entryType = 'av01';
    } else {
      configBox = _avcC(this._videoConfig);
      entryType = 'avc1';
    }
    var visualEntry = _visualSampleEntry(entryType,
      this._video.width  || 0,
      this._video.height || 0,
      configBox);

    traks.push(_trak(
      VIDEO_TRACK_ID,
      VIDEO_TIMESCALE,
      false,
      this._video.width  || 0,
      this._video.height || 0,
      visualEntry
    ));
    trackIds.push(VIDEO_TRACK_ID);
  }

  if (this._audio) {
    var audioChannels   = this._audio.channels   || 2;
    var audioSampleRate = this._audio.sampleRate || 48000;
    var audioEntry;
    if (this._audio.codec === 'opus') {
      // For Opus the configBytes (when provided) is the OpusHead from
      // the encoder's metadata.decoderConfig.description. _dOps handles
      // both the populated case and the null case (defaults).
      audioEntry = _opusSampleEntry(
        audioChannels,
        audioSampleRate,
        _dOps(this._audioConfig, audioChannels, audioSampleRate)
      );
    } else {
      // AAC: configBytes is AudioSpecificConfig, wrapped in esds.
      audioEntry = _audioSampleEntry(
        audioChannels,
        audioSampleRate,
        _esds(this._audioConfig)
      );
    }

    // AAC carries `encoderDelay` samples of priming/lookahead at the
    // start of the track that the decoder produces but shouldn't be
    // presented. The amount depends on profile: 1024 for LC (one
    // frame), 2048 for HE-AAC (SBR doubles output rate). Without an
    // elst entry telling the player to skip them, the audible audio
    // starts ~21–43 ms later than the first video frame. The caller
    // (HLSEncoder) sets this from the codec string. Opus handles
    // its own priming via OpusHead's pre_skip in the dOps box.
    var encoderDelay = (this._audio.codec === 'aac')
      ? (this._audio.encoderDelay || 1024)
      : 0;
    traks.push(_trak(
      AUDIO_TRACK_ID,
      audioSampleRate,  // audio timescale = sample rate
      true,
      0,
      0,
      audioEntry,
      encoderDelay
    ));
    trackIds.push(AUDIO_TRACK_ID);
  }

  // next_track_ID for mvhd: highest track ID + 1.
  var nextTrackId = Math.max.apply(null, trackIds) + 1;

  var moov = _container('moov', [
    _mvhd(VIDEO_TIMESCALE, nextTrackId),  // movie timescale = video timescale
  ].concat(traks).concat([
    _mvex(trackIds),
  ]));

  return concat([_ftyp(), moov]);
};

/**
 * Build and return a media segment from the chunks accumulated for
 * this fragment.
 *
 * @param {Array}  videoChunks  [{ au:Uint8Array, ptsUs, dtsUs, isKey }]
 *   `au` must be in **AVCC** format (length-prefixed NAL units), NOT
 *   Annex-B. WebCodecs' VideoEncoder gives us AVCC by default.
 * @param {Array}  audioChunks  [{ data:Uint8Array, ptsUs, durationUs }]
 *   `data` must be **raw AAC** (NOT ADTS-wrapped). WebCodecs'
 *   AudioEncoder gives us raw AAC by default.
 * @param {number} [endPtsUs]   Boundary PTS for last-sample duration math.
 * @param {Array}  [metadataChunks]  [{ data:Uint8Array, ptsUs, durationUs }]
 *   ID3v2 frames to embed via emsg boxes. Each becomes one emsg before
 *   the moof. Pass empty/undefined for streams without metadata.
 */
FMP4Writer.prototype.writeSegment = function (videoChunks, audioChunks, endPtsUs, metadataChunks) {
  videoChunks = videoChunks || [];
  audioChunks = audioChunks || [];
  // Don't allocate `[]` when no metadata is provided — the common case.
  // Length checks below short-circuit on `null`/`undefined` via &&.
  var metaLen = metadataChunks ? metadataChunks.length : 0;

  if (videoChunks.length === 0 && audioChunks.length === 0) {
    throw new Error('FMP4Writer.writeSegment: at least one chunk required');
  }

  // ── Phase 1: sort and inventory both tracks. ──
  // We only build small bookkeeping data here (sorted views, dtsTicks
  // for video, total byte counts). The trun's per-sample fields are
  // computed and written directly during phase 3 — no intermediate
  // sample-object array is allocated.

  var videoSorted = null, videoSize = 0, videoBaseDts = 0;
  var videoDtsTicks = null, videoPtsTicks = null;
  if (videoChunks.length > 0) {
    // fMP4 trun is a decode-order list, so we need DTS-ascending. Inputs
    // come from the segment-builder which doesn't reorder; in WebCodecs
    // 'realtime' mode the encoder is FIFO too. So the common case is
    // "already sorted" — detect it in O(n) and skip the slice+sort.
    var v = videoChunks;
    for (var si = 1; si < v.length; si++) {
      if (v[si].dtsUs < v[si - 1].dtsUs) {
        v = videoChunks.slice().sort(function (a, b) { return a.dtsUs - b.dtsUs; });
        break;
      }
    }
    videoSorted = v;

    // Pre-convert DTS *and* PTS to ticks, plus accumulate total bytes,
    // in one pass over the chunks. _writeVideoTrunInto reads dtsTicks[i+1]
    // - dtsTicks[i] for per-sample durations and ptsTicks[i] - dtsTicks[i]
    // for composition-time offsets — doing the conversion here lets the
    // trun loop be pure byte writes (no Math.round or div). Float64Array
    // is monomorphic; equivalent to V8's PACKED_DOUBLE_ELEMENTS but
    // signals intent.
    videoDtsTicks = new Float64Array(v.length);
    videoPtsTicks = new Float64Array(v.length);
    for (var vi = 0; vi < v.length; vi++) {
      var vc = v[vi];
      videoDtsTicks[vi] = _usToTicks(vc.dtsUs, VIDEO_TIMESCALE);
      videoPtsTicks[vi] = _usToTicks(vc.ptsUs, VIDEO_TIMESCALE);
      videoSize += vc.au.length;
    }
    videoBaseDts = videoDtsTicks[0];
  }

  var audioSorted = null, audioSize = 0, audioBaseDts = 0;
  if (audioChunks.length > 0) {
    var aTimescale = (this._audio && this._audio.sampleRate) || 48000;

    var a = audioChunks;
    for (var asi = 1; asi < a.length; asi++) {
      if (a[asi].ptsUs < a[asi - 1].ptsUs) {
        a = audioChunks.slice().sort(function (x, y) { return x.ptsUs - y.ptsUs; });
        break;
      }
    }
    audioSorted = a;

    // Detect samples-per-frame on the very first audio chunk we ever
    // see (cached for the lifetime of the writer). AAC LC: ~21333µs at
    // 48kHz = 1024 samples. Opus 20ms: 20000µs at 48kHz = 960 samples.
    // Computed as round(durationUs * sampleRate / 1e6) so floating-point
    // drift in the encoder's reported duration doesn't escape into our
    // tick math (Chrome reports 21333 for AAC, but 21333 * 48000 / 1e6
    // rounds cleanly to 1024).
    if (this._audioSamplesPerFrame === null) {
      var firstDurUs = a[0].durationUs;
      if (firstDurUs && firstDurUs > 0) {
        this._audioSamplesPerFrame = Math.round(firstDurUs * aTimescale / 1000000);
      } else {
        // No duration on the chunk — assume AAC LC (1024). This matches
        // existing behavior for callers who never populated durationUs.
        this._audioSamplesPerFrame = 1024;
      }
    }
    var samplesPerFrame = this._audioSamplesPerFrame;

    // Anchor audio at the first segment's first chunk PTS, then advance
    // by samplesPerFrame ticks per chunk for every subsequent segment.
    // See the explanation at _audioFirstChunkBaseTicks in the
    // constructor for why we restamp instead of trusting per-chunk PTS
    // values across segments. We deliberately ignore chunk.duration
    // here because encoders occasionally report rounded values that
    // accumulate into A/V drift over long recordings.
    if (this._audioFirstChunkBaseTicks === null) {
      this._audioFirstChunkBaseTicks = _usToTicks(a[0].ptsUs, aTimescale);
    }
    audioBaseDts = this._audioFirstChunkBaseTicks + this._audioCumulativeSamples;
    this._audioCumulativeSamples += a.length * samplesPerFrame;

    for (var aii = 0; aii < a.length; aii++) {
      audioSize += a[aii].data.length;
    }
  }

  // ── Phase 2: compute box sizes and laid-out byte offsets. ──
  //
  // Per-trun data_offset is the byte distance from the start of MOOF
  // (not the start of the file) to the track's first sample inside
  // mdat. emsg boxes prepend the moof but don't affect that offset —
  // the spec defines data_offset relative to moof, not segment start.
  // We lay out video samples first, then audio samples, in mdat.

  // Sum emsg box sizes. Most segments have no metadata at all — fast-
  // path the empty case so the JIT keeps the no-emsg writeSegment
  // identical to the pre-emsg version (single write to out[0..7]
  // instead of out[moofBase..moofBase+7]).
  var emsgTotalSize = 0;
  if (metaLen > 0) {
    for (var emi = 0; emi < metaLen; emi++) {
      emsgTotalSize += _emsgSize(metadataChunks[emi].data.length);
    }
  }

  // 8 = moof header, 16 = mfhd (full box: 8 + 4 ver/flags + 4 seq).
  // Each traf size is added directly without a temporary array — saves
  // ~3 allocations per segment (the array, plus the reduce closure).
  var moofSize = 24;
  if (videoSorted) moofSize += _trafSize(videoSorted.length, true);
  if (audioSorted) moofSize += _trafSize(audioSorted.length, false);

  var mdatHeaderSize = 8;
  var dataOffsetVideo = moofSize + mdatHeaderSize;
  var dataOffsetAudio = dataOffsetVideo + videoSize;

  // ── Phase 3: allocate the final segment buffer once and fill it. ──
  // Earlier this method built sample-metadata objects (one per video and
  // audio frame), then built moof as a separate Uint8Array via _box /
  // _container, then concatenated moof+mdat. That meant ~308 transient
  // objects + ~10 small box allocations + a 700KB-class concat per
  // segment. Now everything lands in `out` directly.
  var mdatSize = mdatHeaderSize + videoSize + audioSize;
  var totalSize = emsgTotalSize + moofSize + mdatSize;
  var out = new Uint8Array(totalSize);

  // emsg boxes go BEFORE moof per CMAF / HLS spec. Each gets a unique
  // sequential id — players use it to dedupe events when a segment is
  // delivered more than once (e.g., on retry). When there's no
  // metadata (the common case), moofBase stays at 0 — V8 then
  // constant-folds out[moofBase + N] back to out[N].
  var moofBase = 0;
  if (metaLen > 0) {
    var ep = 0;
    for (var ei = 0; ei < metaLen; ei++) {
      var meta = metadataChunks[ei];
      var ptTicks  = _usToTicks(meta.ptsUs, VIDEO_TIMESCALE);
      var durTicks = meta.durationUs ? _usToTicks(meta.durationUs, VIDEO_TIMESCALE) : 0;
      ep = _writeEmsgInto(out, ep, ptTicks, durTicks, this._emsgIdCounter++, meta.data);
    }
    moofBase = ep;
  }

  // moof header: size + 'moof'. Children written below.
  writeU32BE(out, moofBase, moofSize);
  out[moofBase + 4] = 0x6D; out[moofBase + 5] = 0x6F;
  out[moofBase + 6] = 0x6F; out[moofBase + 7] = 0x66;  // 'moof'

  var mp = moofBase + 8;
  mp = _writeMfhdInto(out, mp, this._sequenceNumber++);
  if (videoSorted) {
    mp = _writeVideoTrafInto(out, mp, videoBaseDts, videoSorted,
                             videoDtsTicks, videoPtsTicks,
                             dataOffsetVideo, endPtsUs);
  }
  if (audioSorted) {
    mp = _writeAudioTrafInto(out, mp, audioBaseDts, audioSorted,
                             dataOffsetAudio, this._audioSamplesPerFrame);
  }

  // Sanity check: our pre-computed moofSize must match the actual bytes
  // we just wrote — otherwise our data_offset is wrong and playback
  // will fail in subtle ways.
  if (mp - moofBase !== moofSize) {
    throw new Error('FMP4Writer: moof size mismatch ' +
                    '(expected ' + moofSize + ', got ' + (mp - moofBase) + '). ' +
                    'This is an internal bug in writer-fmp4.');
  }

  // mdat header: size(4) + 'mdat'(4)
  var mdatBase = moofBase + moofSize;
  writeU32BE(out, mdatBase, mdatSize);
  out[mdatBase + 4] = 0x6D;  // m
  out[mdatBase + 5] = 0x64;  // d
  out[mdatBase + 6] = 0x61;  // a
  out[mdatBase + 7] = 0x74;  // t

  // mdat payload: video AUs first, then audio frames. Order matches
  // dataOffsetVideo / dataOffsetAudio computed above (relative to
  // moofBase, which is what data_offset means per fMP4 spec).
  var p = mdatBase + mdatHeaderSize;
  if (videoSorted) {
    for (var vi2 = 0; vi2 < videoSorted.length; vi2++) {
      out.set(videoSorted[vi2].au, p);
      p += videoSorted[vi2].au.length;
    }
  }
  if (audioSorted) {
    for (var ai = 0; ai < audioSorted.length; ai++) {
      out.set(audioSorted[ai].data, p);
      p += audioSorted[ai].data.length;
    }
  }

  return out;
};

/**
 * Reset between segments. fMP4 fragments share a continuous decode
 * timeline (tfdt is absolute, not relative to segment start), so the
 * sequence number is the only state that matters across segments.
 * The caller's segment boundaries are reflected in the increasing
 * tfdt values, not in any reset here — but we expose the method for
 * symmetry with TSWriter.
 */
FMP4Writer.prototype.reset = function () {
  // Sequence number stays monotonic across resets; it identifies the
  // fragment within the stream and players use it to detect drops.
};


// ── Pre-flight size computation for trun.data_offset ──────

/**
 * Compute the exact byte size a traf will occupy, given how many
 * samples its trun will carry. We must know this before building the
 * trun so we can populate the trun.data_offset field correctly (it
 * points into mdat, which sits AFTER moof, whose size depends on
 * exactly this).
 *
 * Layout:
 *   traf header                                 8
 *   tfhd: full box hdr 12 + 4 (track_id)        16
 *   tfdt: full box hdr 12 + 8 (decode time v1)  20
 *   trun: full box hdr 12 + 8 (sample_count + data_offset)
 *         + per-sample bytes                    20 + perSample × N
 *
 * Total: 64 + perSample × N
 */
function _trafSize(sampleCount, isVideo) {
  var perSample = isVideo ? 16 : 12;
  return 64 + perSample * sampleCount;
}


// ── µs → timescale ticks ──────────────────────────────────

function _usToTicks(us, timescale) {
  // Round to nearest tick. For typical timescales (90000, 48000) this
  // gives sub-millisecond precision and avoids accumulating drift.
  return Math.round(us * timescale / 1000000);
}


export default FMP4Writer;
