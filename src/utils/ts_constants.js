/**
 * ts_constants — shared MPEG-TS (ISO 13818-1) format constants.
 *
 * Single source of truth for both writer_ts (muxing) and reader_ts
 * (demuxing). Previously writer_ts defined these as named constants
 * while reader_ts hard-coded 188 / 0x47 inline; centralizing removes
 * that duplicated knowledge. Pure values, no state — lives in utils/
 * alongside the other format constants (cf. aac_utils' ADTS tables).
 */

// ── TS packet framing ──────────────────────────────────────
export var PACKET_SIZE = 188;   // fixed transport-stream packet size
export var SYNC_BYTE   = 0x47;  // every packet begins with this

// ── PIDs (Packet Identifiers) ──────────────────────────────
// PAT is mandated at PID 0. All other PIDs are arbitrary as long as
// they're consistent and listed in PMT. We use round numbers that
// appear in countless example streams, including FFmpeg's defaults.
export var PID_PAT      = 0x0000;
export var PID_PMT      = 0x1000;
export var PID_VIDEO    = 0x0100;
export var PID_AUDIO    = 0x0101;
// Timed metadata stream (ID3v2). Apple's "Adopting HLS" guide and
// FFmpeg's id3v2_apic muxer both use 0x102 here. Players don't care
// about the specific value as long as it's consistent and listed in PMT.
export var PID_METADATA = 0x0102;

// ── PES stream IDs (ISO 13818-1 Table 2-22) ────────────────
// Video uses 0xE0..0xEF (we pick the first), audio uses 0xC0..0xDF.
// Metadata-in-PES uses 0xFC ("metadata stream"), per ISO 13818-1 §2.4.3.7.
export var STREAM_ID_VIDEO    = 0xE0;
export var STREAM_ID_AUDIO    = 0xC0;
export var STREAM_ID_METADATA = 0xFC;

// ── PMT stream types (ISO 13818-1 Table 2-29 + amendments) ──
export var STREAM_TYPE_H264     = 0x1B;
export var STREAM_TYPE_H265     = 0x24;
export var STREAM_TYPE_AAC      = 0x0F;
// 0x15 = "Metadata carried in PES packets", per ISO 13818-1 Amendment 3.
// This is the stream_type Apple HLS uses for ID3 timed metadata. The
// format is identified by a registration_descriptor in the stream's
// ES_info loop carrying format_identifier "ID3 ".
export var STREAM_TYPE_METADATA = 0x15;
