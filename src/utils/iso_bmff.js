/**
 * iso_bmff — shared parsing for the ISO Base Media File Format (MP4,
 * MOV / QuickTime, 3GP, fMP4 / CMAF): box headers, box lookup, and the
 * movie-fragment boxes (tfhd / tfdt / trun) and sample flags.
 *
 * Used by reader_fmp4 (a fragmented stream, fed in order) and reader_mp4
 * (a whole file, read at any offset). Pure Uint8Array parsing — browser
 * and Node alike.
 *
 * Offsets are absolute in `buf`. A box: { type, start, end, size,
 * headerSize, dataStart } — dataStart is past the header (and, for a
 * full box, NOT past its version/flags: callers read those).
 */

import { readU32BE, readS32BE, readU64BE, toAscii } from '../core/bytes.js';


// ── Boxes ──

/**
 * The box header at `off`, within [off, end). null when it doesn't fit
 * or is malformed. `allowOpen`: a size of 0 (the box runs to the end —
 * a top-level mdat) is taken as `end`; otherwise it's malformed.
 */
export function readBoxHeader(buf, off, end, allowOpen) {
  if (end == null) end = buf.length;
  if (off + 8 > end) return null;
  var size = readU32BE(buf, off);
  var type = toAscii(buf, off + 4, off + 8);
  var headerSize = 8;
  if (size === 1) {
    if (off + 16 > end) return null;
    size = readU64BE(buf, off + 8);
    headerSize = 16;
  } else if (size === 0) {
    if (!allowOpen) return null;
    size = end - off;
  }
  if (size < headerSize || off + size > end) return null;
  return { type: type, start: off, end: off + size, size: size, headerSize: headerSize, dataStart: off + headerSize };
}

/** The first box of `type` among the boxes in [from, to). null if none. */
export function findBox(buf, from, to, type) {
  var off = from;
  while (off + 8 <= to) {
    var b = readBoxHeader(buf, off, to, false);
    if (!b) return null;
    if (b.type === type) return b;
    off = b.end;
  }
  return null;
}

/** Every box of `type` among the boxes in [from, to). */
export function findBoxes(buf, from, to, type) {
  var out = [];
  var off = from;
  while (off + 8 <= to) {
    var b = readBoxHeader(buf, off, to, false);
    if (!b) break;
    if (b.type === type) out.push(b);
    off = b.end;
  }
  return out;
}

/** A box found by path ('mdia/minf/stbl') under the container box `parent`. */
export function findPath(buf, parent, path) {
  var cur = parent;
  var parts = path.split('/');
  for (var i = 0; i < parts.length && cur; i++) {
    cur = findBox(buf, cur.dataStart, cur.end, parts[i]);
  }
  return cur || null;
}

/** A full box's version and flags. */
export function fullBoxHeader(buf, box) {
  var o = box.dataStart;
  return { version: buf[o], flags: (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3], dataStart: o + 4 };
}


// ── Movie fragments (ISO/IEC 14496-12 §8.8) ──

/**
 * tfhd → { trackId, flags, baseDataOffset (null when absent),
 *          defaultBaseIsMoof, sampleDescriptionIndex, defaultSampleDuration,
 *          defaultSampleSize, defaultSampleFlags } — the absent ones null,
 *          for the caller's own defaults (trex) to fill.
 */
export function parseTfhd(buf, box) {
  var h = fullBoxHeader(buf, box);
  var p = h.dataStart;
  var out = {
    trackId: readU32BE(buf, p), flags: h.flags,
    baseDataOffset: null, defaultBaseIsMoof: !!(h.flags & 0x020000),
    sampleDescriptionIndex: null, defaultSampleDuration: null,
    defaultSampleSize: null, defaultSampleFlags: null,
  };
  p += 4;
  if (h.flags & 0x000001) { out.baseDataOffset = readU64BE(buf, p); p += 8; }
  if (h.flags & 0x000002) { out.sampleDescriptionIndex = readU32BE(buf, p); p += 4; }
  if (h.flags & 0x000008) { out.defaultSampleDuration = readU32BE(buf, p); p += 4; }
  if (h.flags & 0x000010) { out.defaultSampleSize = readU32BE(buf, p); p += 4; }
  if (h.flags & 0x000020) { out.defaultSampleFlags = readU32BE(buf, p); p += 4; }
  return out;
}

/** tfdt → the fragment's base decode time (track timescale). */
export function parseTfdt(buf, box) {
  var h = fullBoxHeader(buf, box);
  return h.version === 1 ? readU64BE(buf, h.dataStart) : readU32BE(buf, h.dataStart);
}

/**
 * trun → { flags, dataOffset (null when absent), firstSampleFlags (null
 * when absent), samples: [{ duration, size, flags, compositionOffset }] }.
 * A field a sample doesn't carry is null — the caller's default applies.
 * composition offsets are read signed (version 1 says so; version 0
 * writers put negatives there too).
 */
export function parseTrun(buf, box) {
  var h = fullBoxHeader(buf, box);
  var f = h.flags;
  var p = h.dataStart;
  var count = readU32BE(buf, p); p += 4;
  var out = { flags: f, dataOffset: null, firstSampleFlags: null, samples: [] };
  if (f & 0x000001) { out.dataOffset = readS32BE(buf, p); p += 4; }
  if (f & 0x000004) { out.firstSampleFlags = readU32BE(buf, p); p += 4; }
  var hasDur = f & 0x000100, hasSize = f & 0x000200, hasFlags = f & 0x000400, hasCto = f & 0x000800;
  for (var i = 0; i < count; i++) {
    if (p > box.end) break;
    var s = { duration: null, size: null, flags: null, compositionOffset: 0 };
    if (hasDur)   { s.duration = readU32BE(buf, p); p += 4; }
    if (hasSize)  { s.size = readU32BE(buf, p); p += 4; }
    if (hasFlags) { s.flags = readU32BE(buf, p); p += 4; }
    if (hasCto)   { s.compositionOffset = readS32BE(buf, p); p += 4; }
    out.samples.push(s);
  }
  return out;
}

/**
 * Is a sample with these sample_flags a sync (random-access) sample?
 * (§8.6.4.3 / §8.8.3.1) sample_depends_on 2 → yes, 1 → no, otherwise
 * sample_is_non_sync_sample decides.
 */
export function isSyncSampleFlags(flags) {
  var dependsOn = (flags >> 24) & 0x03;
  if (dependsOn === 2) return true;
  if (dependsOn === 1) return false;
  return ((flags >> 16) & 0x01) === 0;
}
