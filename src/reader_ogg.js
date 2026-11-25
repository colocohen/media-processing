/**
 * reader_ogg — OGG container reader for Opus audio.
 *
 * Parses OGG pages (RFC 3533), extracts the Opus packets of one logical
 * stream with their presentation times (RFC 7845 §4).
 *
 *  - Pages: capture pattern, version 0 and the CRC are checked; a page
 *    that fails is no page (the scan moves on a byte).
 *  - One logical stream: the first whose BOS page holds an OpusHead (or,
 *    with no headers — a stream joined mid-way — the first page's).
 *    Pages of other serials are skipped. After its EOS page, the next
 *    Opus BOS starts the next link of a chain.
 *  - Times: from the granule positions, minus the pre-skip, at 48 kHz;
 *    the links of a chain follow one another.
 *  - A stream RFC 7845 §4.5 calls invalid (the first audio page's granule
 *    under its samples, or an EOS one under the pre-skip): feed() throws,
 *    and that logical stream is not read on.
 */

import EventEmitter from './core/events.js';
import { readU32LE } from './core/bytes.js';
import ByteQueue from './core/byte_queue.js';
import { getOpusPacketDurationUs, parseOpusHead } from './utils/opus_utils.js';
import { oggCrc32 } from './writer_ogg.js';

function OggReader(opts) {
  if (!opts) opts = {};
  this._ee = new EventEmitter();
  this._q = new ByteQueue();
  this._sampleRate = opts.sampleRate || 48000;
  this._headersParsed = 0;
  // Segments of a packet that continued past the end of the previous
  // page. Ogg signals continuation with a final 255-byte segment; the
  // remainder arrives in the next page and must be joined to this.
  // null: no packet is pending.
  this._pendingSegments = null;
  // The logical stream being read (RFC 3533 §4): its serial, or null
  // before its first page / after its EOS. The pages of every logical
  // stream went through as one: in a file with two Opus streams (FFmpeg
  // -map 0 -map 1) the second one's OpusHead / OpusTags came out as audio
  // packets and both streams' packets were interleaved on one timeline;
  // a chained file's second link likewise.
  this._serial = null;
  this._skipSerials = {};  // other streams' serials (not Opus), and links that ended
  this._seq = null;        // the stream's last page sequence number
  this._preSkip = 0;       // the link's OpusHead pre-skip
  this._next = null;       // granule where the next packet starts (null: none yet in this link)
  this._base = 0;          // samples of the earlier links of a chain
}

OggReader.prototype.on = function (ev, fn) { this._ee.on(ev, fn); };
OggReader.prototype.off = function (ev, fn) { this._ee.off(ev, fn); };

OggReader.prototype.feed = function (chunk) {
  this._q.push(chunk);

  while (this._q.length >= 27) {
    // OGG page sync: 'OggS'
    if (this._q.byteAt(0) !== 0x4F || this._q.byteAt(1) !== 0x67 ||
        this._q.byteAt(2) !== 0x67 || this._q.byteAt(3) !== 0x53) {
      this._q.discard(1);
      continue;
    }

    var numSegments = this._q.byteAt(26);
    var headerLen = 27 + numSegments;
    if (this._q.length < headerLen) break;

    var header = this._q.peek(headerLen);

    // Calculate page body size from segment table
    var bodySize = 0;
    for (var i = 0; i < numSegments; i++) {
      bodySize += header[27 + i];
    }

    var totalPageSize = headerLen + bodySize;
    if (this._q.length < totalPageSize) break;

    var page = this._q.peek(totalPageSize);
    // stream_structure_version 0 and the CRC (RFC 3533 §6): neither was
    // checked, so a corrupt page was read as it came — its damaged
    // packets went out as audio. One that fails is not a page: the scan
    // goes on from the next byte, as libogg's sync does.
    if (page[4] !== 0 || _pageCrc(page) !== readU32LE(page, 22)) {
      this._q.discard(1);
      continue;
    }
    this._q.discard(totalPageSize);

    // Granule position (8 bytes, little-endian) at offset 6; all ones
    // (-1) on a page where no packet completes (RFC 7845 §4).
    var granLo = readU32LE(page, 6);
    var granHi = readU32LE(page, 10);
    var granule = granHi === 0xFFFFFFFF && granLo === 0xFFFFFFFF ? null : granHi * 0x100000000 + granLo;
    var serial = readU32LE(page, 14);
    var seq = readU32LE(page, 18);

    var headerType = page[5];
    var body = page.subarray(headerLen);

    // Which logical stream: the first Opus one (its BOS page's packet is
    // the OpusHead, RFC 7845 §3); a BOS page of another codec marks a
    // stream to skip. A first page that is no BOS is a stream joined
    // mid-way: read it.
    if (this._serial === null) {
      if (this._skipSerials[serial]) continue;
      if (headerType & 0x02) {
        if (!_isTag(body, 'OpusHead')) { this._skipSerials[serial] = true; continue; }
      }
      this._serial = serial;     // (_seq, _next: null since the last link's end)
      this._headersParsed = 0;
      this._preSkip = 0;
    } else if (serial !== this._serial) {
      // Another stream of the group (its BOS came before this one's data):
      // not read after this one ends either.
      this._skipSerials[serial] = true;
      continue;
    }

    // RFC 7845 §3: the first packet of a page with the 'continued' flag
    // is not decodable when nothing is pending for it (the first page
    // read, after a page lost or not read — sequence numbers not
    // consecutive), and a pending packet is not when the next page does
    // not continue it. The fragment went out as a packet: a stream joined
    // at a continued page began with a 15-byte 'Opus packet' (FFmpeg
    // -page_duration 5000000, 120 ms frames), and a pending packet was
    // joined to the next page's first.
    var gap = this._seq !== null && seq !== ((this._seq + 1) >>> 0);
    this._seq = seq;
    if (this._pendingSegments && (gap || !(headerType & 0x01))) this._pendingSegments = null;
    var dropFirst = !!(headerType & 0x01) && !this._pendingSegments;

    // Extract packets from segments.
    //
    // packetBuf carries over from the previous page. Ogg splits a packet
    // into 255-byte segments and terminates it with a segment of 0..254;
    // a page whose LAST segment is 255 means the packet continues into
    // the next page (RFC 3533 §6). packetBuf used to be re-initialised
    // per page, so every such continued packet was silently discarded
    // along with everything already collected for it. Opus packets at
    // 20 ms are well under 255 bytes so this never showed up in the
    // WebRTC path, but any larger frame — higher bitrate, longer frame
    // duration, or a non-Opus stream through the same reader — lost
    // audio without a word.
    var packets = [];
    var packetBuf = dropFirst ? null : (this._pendingSegments || []);   // null: segments dropped
    var segOff = 0;
    for (var s = 0; s < numSegments; s++) {
      var segSize = header[27 + s];
      if (packetBuf) packetBuf.push(body.subarray(segOff, segOff + segSize));
      segOff += segSize;
      // Segment < 255 terminates the packet; 255 means "continues".
      if (segSize < 255) {
        if (packetBuf) {
          // Fast path: single segment = no concat needed
          var pkt;
          if (packetBuf.length === 1) {
            pkt = packetBuf[0].slice();
          } else {
            var total = 0;
            for (var t = 0; t < packetBuf.length; t++) total += packetBuf[t].length;
            pkt = new Uint8Array(total);
            var pOff = 0;
            for (var t2 = 0; t2 < packetBuf.length; t2++) {
              pkt.set(packetBuf[t2], pOff);
              pOff += packetBuf[t2].length;
            }
          }
          packets.push(pkt);
        }
        packetBuf = [];
      }
    }
    // Whatever is left belongs to a packet continuing into the next page.
    this._pendingSegments = packetBuf && packetBuf.length ? packetBuf : null;

    // The first two PACKETS are the Opus headers (RFC 7845 §3): OpusHead
    // (§5.1, with the real libopus pre-skip — kept so the encoder can
    // surface it as decoderConfig.description, like the browser's
    // AudioEncoder) and OpusTags (§5.2). They were taken to be the first
    // two PAGES, but OpusTags may span pages (§3: "the comment header
    // packet ... MAY span multiple pages") — any tag over ~64 KB, e.g. a
    // cover image, does. Its continuation page then came out as an
    // audio packet (a 35052-byte 'Opus frame') and every timestamp after
    // it was off by one packet.
    while (packets.length && this._headersParsed < 2 && _isOpusHeader(packets[0])) {
      if (this._headersParsed === 0) {
        this._opusHead = packets[0];
        var oh = parseOpusHead(packets[0]);
        this._preSkip = oh ? oh.preSkip : 0;
      }
      this._headersParsed++;
      packets.shift();
    }
    if (packets.length) this._headersParsed = 2;   // audio from here (headers or not)

    var eos = !!(headerType & 0x04);
    if (!packets.length) {
      if (eos) this._endLink(granule !== null ? granule : this._next);
      continue;
    }

    // Per-packet duration comes from the Opus TOC byte (RFC 6716 §3.1)
    // via getOpusPacketDurationUs — NOT a hardcoded 960 samples. The
    // previous hardcode was correct for 20ms@48kHz only; it produced
    // 2x-3x drift for any other Opus configuration (10/40/60ms frames,
    // or non-48kHz sample rates) and is the bug that ROADMAP MP-10 was
    // supposed to address (in a different file — actual bug was here).
    var durs = [], sum = 0;
    for (var d = 0; d < packets.length; d++) {
      durs.push(Math.round(getOpusPacketDurationUs(packets[d]) * 48 / 1000));
      sum += durs[d];
    }

    // Times from the granule position (RFC 7845 §4): a page's granule is
    // where its last completed packet ends, so its packets start at the
    // granule minus their samples. The times were the TOC durations
    // summed from 0, so (§4.5) a stream that starts later — cropped, a
    // live stream joined, FFmpeg's -output_ts_offset 10 — still began at
    // 0 (ffprobe: 9.9935 s), and a page lost shifted every time after it.
    // The end-of-stream page is timed forwards from the page before it
    // (§4.4: its granule may end inside its last packet); one that is
    // also the first page, with a granule under its samples, from 0
    // (§4.5).
    // RFC 7845 §4.5: the first audio page's granule under its samples
    // means an invalid stream ("MUST treat any stream as invalid"), unless
    // the page is also the EOS page; an EOS one under the pre-skip too.
    // Such a stream was read with a negative start (as FFmpeg does). Now
    // an error: nothing more is read from it (the packets before stay
    // out; a chain's next link starts again).
    if (this._next === null && granule !== null) {
      if (!eos && granule < sum) this._invalid('the first audio page\'s granule position is under its samples');
      if (eos && granule < this._preSkip) this._invalid('the end-of-stream granule position is under the pre-skip');
    }

    var start;
    if (eos && this._next !== null) start = this._next;
    else if (granule !== null) {
      start = granule - sum;
      if (eos && start < 0) start = 0;
    } else start = this._next !== null ? this._next : 0;

    // Presentation time = granule − pre-skip (RFC 7845 §4.3). The
    // pre-skip was not taken off: every time was 6.5 ms late for
    // libopus' 312 (ffprobe: the first packet at −0.0065 s), and its
    // pre-skip samples, decoded and discarded, were counted as audio.
    var end = start;
    for (var p = 0; p < packets.length; p++) {
      var s0 = start, s1 = start + durs[p];
      // End trimming (RFC 7845 §4.4): the end-of-stream page's granule
      // position says where the audio ends, which may be inside its last
      // packet. The last packet went out whole (20000 µs where FFmpeg
      // says 6500).
      if (eos && p === packets.length - 1 && granule !== null && granule > s0 && granule < s1) s1 = granule;
      var ptsUs = Math.round((this._base + s0 - this._preSkip) * 1000000 / 48000);
      this._ee.emit('audio', {
        payload: packets[p],
        ptsUs: ptsUs,
        durationUs: Math.round((this._base + s1 - this._preSkip) * 1000000 / 48000) - ptsUs,
      });
      start += durs[p];
      end = s1;
    }
    this._next = start;
    if (eos) this._endLink(end);
  }
};

// The link's EOS page: the stream ends at granule `end`. A chain's next
// link follows it (RFC 7845 §7.2: its own pre-skip makes the join); the
// stream that ended is not read again (RFC 3533: no page after EOS).
OggReader.prototype._endLink = function (end) {
  if (end !== null) this._base += end - this._preSkip;
  this._skipSerials[this._serial] = true;
  this._serial = null;
  this._seq = null;
  this._pendingSegments = null;
  this._next = null;
};

// An invalid logical stream (RFC 7845 §4.5): not read on, and an Error
// (as reader_ivf / reader_flv for what they cannot read).
OggReader.prototype._invalid = function (why) {
  this._skipSerials[this._serial] = true;
  this._serial = null;
  this._seq = null;
  this._pendingSegments = null;
  this._next = null;
  throw new Error('OggReader: invalid stream (RFC 7845 §4.5): ' + why);
};

// 'OpusHead' / 'OpusTags': an Opus header packet, not audio.
function _isOpusHeader(pkt) {
  return _isTag(pkt, 'OpusHead') || _isTag(pkt, 'OpusTags');
}

function _isTag(b, s) {
  if (b.length < s.length) return false;
  for (var i = 0; i < s.length; i++) if (b[i] !== s.charCodeAt(i)) return false;
  return true;
}

// The CRC of a page, computed with its CRC field as zeros.
function _pageCrc(page) {
  var c = page.slice();
  c[22] = c[23] = c[24] = c[25] = 0;
  return oggCrc32(c);
}

OggReader.prototype.flush = function () {
  this._q.reset();
  this._pendingSegments = null;
};

export default OggReader;
