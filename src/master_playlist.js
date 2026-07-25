// Master Playlist generator for HLS.
//
// A master playlist (also called "multivariant playlist" in newer specs)
// references multiple media playlists — one per quality tier (variant)
// and optionally separate ones for alternative audio/subtitle tracks
// (renditions). Players parse it to choose which variant to play and
// to switch quality dynamically (ABR).
//
// HLS spec reference: RFC 8216 §4.3.4. The relevant directives are:
//
//   #EXT-X-MEDIA       — declares a rendition (alternative audio/subs/CC)
//   #EXT-X-STREAM-INF  — declares a variant (a media playlist)
//   #EXT-X-I-FRAME-STREAM-INF — declares an I-frame-only playlist (for
//                              trick-play / scrubbing). Not generated
//                              here; users who want trick-play can add
//                              it manually.
//
// Layout order matters in master playlists:
//   1. #EXTM3U (always first line)
//   2. #EXT-X-VERSION
//   3. #EXT-X-INDEPENDENT-SEGMENTS (optional global flag)
//   4. All #EXT-X-MEDIA lines (renditions) — must precede STREAM-INF
//   5. All #EXT-X-STREAM-INF lines (variants), each followed by URI
//
// Players are tolerant of variant order but renditions MUST come before
// the variant that references them.

/**
 * Build a master playlist from a list of variants and (optional) renditions.
 *
 * @param {object} opts
 * @param {Array}  opts.variants                 Required. Each variant
 *   describes one quality tier of an ABR ladder. Get them via
 *   HLSEncoder.prototype.getStreamInf or build manually for variants
 *   sourced from elsewhere (CDN, separate encoders, pre-existing files).
 *
 *   Variant fields:
 *     uri              (string,  required)  Path to the media playlist.
 *     bandwidth        (number,  required)  Peak bitrate (bps). HLS spec
 *                                           requires this — players use
 *                                           it for ABR decisions.
 *     averageBandwidth (number,  optional)  Mean bitrate (bps).
 *     resolution       (string,  optional)  "WxH" — strongly recommended
 *                                           for video.
 *     codecs           (string,  optional)  Comma-joined codec strings.
 *     frameRate        (number,  optional)  Decimal fps (e.g., 29.970).
 *     name             (string,  optional)  Display name (NAME=).
 *     audio            (string,  optional)  GROUP-ID of an audio rendition
 *                                           group; the variant is
 *                                           presented with that audio.
 *     subtitles        (string,  optional)  GROUP-ID of a subtitles group.
 *     closedCaptions   (string|null,
 *                       optional)            GROUP-ID, or null to set
 *                                           CLOSED-CAPTIONS=NONE.
 *
 * @param {Array}  [opts.audioRenditions]       Alternative audio tracks
 *   (i18n, audio descriptions). Variants opt in via `audio: groupId`.
 *
 *   Audio rendition fields:
 *     groupId    (string,  required)
 *     name       (string,  required)
 *     uri        (string,  required)   Media playlist with audio only.
 *     language   (string,  optional)   BCP-47 tag (e.g., 'en', 'es-MX').
 *     default    (boolean, optional)   At most one DEFAULT=YES per group.
 *     autoselect (boolean, optional)
 *     channels   (string,  optional)   Channel count (e.g., '2' or '6').
 *
 * @param {Array}  [opts.subtitleRenditions]    WebVTT subtitle tracks.
 *
 *   Subtitle rendition fields:
 *     groupId, name, uri, language, default, autoselect: same as audio.
 *     forced     (boolean, optional)   FORCED=YES → player shows even
 *                                      when subtitles are off (used for
 *                                      foreign-language passages in an
 *                                      otherwise native-language film).
 *
 * @param {Array}  [opts.closedCaptionsRenditions] CEA-608/708 closed-caption
 *   tracks. Variants opt in via `closedCaptions: groupId`. Captions are
 *   embedded inline in the video stream as SEI messages — there is NO
 *   separate URI (the spec forbids URI on CLOSED-CAPTIONS renditions).
 *
 *   Closed caption rendition fields:
 *     groupId    (string,  required)
 *     name       (string,  required)   User-facing name (e.g., 'English CC').
 *     instreamId (string,  required)   'CC1'..'CC4' for CEA-608 channels;
 *                                      'SERVICE1'..'SERVICE63' for CEA-708.
 *     language   (string,  optional)   BCP-47 tag.
 *     default    (boolean, optional)
 *     autoselect (boolean, optional)
 *     characteristics (string, optional)   Accessibility tags.
 *
 * @param {boolean} [opts.independentSegments]  Emit
 *                  #EXT-X-INDEPENDENT-SEGMENTS — promises that every
 *                  media segment is independently decodable. Required
 *                  by some players for byte-range / seek operations.
 *
 * @param {number}  [opts.version]               EXT-X-VERSION value.
 *                  Default: 6 (sufficient for all features we emit;
 *                  required for #EXT-X-MAP referenced by fMP4 variants).
 *
 * @returns {string}  m3u8 text content. Caller is responsible for
 *                    serving it with content-type
 *                    `application/vnd.apple.mpegurl` (or `.m3u8`).
 */

import { escapeQuoted, isValidVideoRange, isValidVariableName, isValidIvHex,
         isValidEncryptionMethod, parseAttributeList } from './utils/playlist_utils.js';

/**
 * Validate the common shape required of any variant entry (regular
 * variants and I-frame variants alike): uri (string), bandwidth
 * (positive number), and videoRange (if provided, one of SDR/HLG/PQ).
 *
 * Error messages include the array name + index so callers can
 * pinpoint the bad entry without dumping the whole config.
 *
 * @param {object} v       The variant entry to check.
 * @param {string} arrName 'variant' or 'iFrameVariants[N]'-style label.
 * @param {number} idx     Index for diagnostics.
 */
function _validateVariantShape(v, arrName, idx) {
  if (!v || typeof v.uri !== 'string') {
    throw new TypeError('buildMasterPlaylist: ' + arrName + '[' + idx + '].uri required');
  }
  if (typeof v.bandwidth !== 'number' || !(v.bandwidth > 0)) {
    throw new TypeError('buildMasterPlaylist: ' + arrName + '[' + idx +
                        '].bandwidth (positive number) required');
  }
  if (v.videoRange !== undefined && !isValidVideoRange(v.videoRange)) {
    throw new TypeError('buildMasterPlaylist: ' + arrName + '[' + idx +
      '].videoRange must be one of SDR/HLG/PQ (got "' + v.videoRange + '")');
  }
}

export function buildMasterPlaylist(opts) {
  if (!opts || typeof opts !== 'object') {
    throw new TypeError('buildMasterPlaylist: opts object required');
  }

  var variants = opts.variants;
  if (!Array.isArray(variants) || variants.length === 0) {
    throw new TypeError('buildMasterPlaylist: opts.variants (non-empty array) required');
  }
  for (var vi = 0; vi < variants.length; vi++) {
    _validateVariantShape(variants[vi], 'variant', vi);
  }

  // Cross-validate rendition group references. Catching this here gives
  // a clear error pointing at the master, not a silent producibility
  // failure where the player simply ignores broken references.
  var audioGroupIds    = _collectGroupIds(opts.audioRenditions);
  var subtitleGroupIds = _collectGroupIds(opts.subtitleRenditions);
  var ccGroupIds       = _collectGroupIds(opts.closedCaptionsRenditions,
                                          { uriRequired: false });
  for (var ci = 0; ci < variants.length; ci++) {
    var c = variants[ci];
    if (c.audio && !audioGroupIds[c.audio]) {
      throw new Error('buildMasterPlaylist: variant[' + ci +
        '].audio = "' + c.audio + '" but no audio rendition with that GROUP-ID');
    }
    if (c.subtitles && !subtitleGroupIds[c.subtitles]) {
      throw new Error('buildMasterPlaylist: variant[' + ci +
        '].subtitles = "' + c.subtitles + '" but no subtitle rendition with that GROUP-ID');
    }
    // CLOSED-CAPTIONS = string → group must exist IF caller provided
    //                            a closedCaptionsRenditions array. If
    //                            no array was passed, we trust the
    //                            caller is referencing renditions
    //                            declared elsewhere (for backwards
    //                            compatibility with manual master
    //                            playlist construction).
    // CLOSED-CAPTIONS = null   → opt-out (emit "CLOSED-CAPTIONS=NONE").
    if (typeof c.closedCaptions === 'string' &&
        Array.isArray(opts.closedCaptionsRenditions) &&
        !ccGroupIds[c.closedCaptions]) {
      throw new Error('buildMasterPlaylist: variant[' + ci +
        '].closedCaptions = "' + c.closedCaptions +
        '" but no closed-captions rendition with that GROUP-ID');
    }
  }

  var lines = [];
  lines.push('#EXTM3U');
  // EXT-X-VERSION may be auto-bumped by features below (e.g.
  // QUERYPARAM in DEFINE bumps to v11). Track minimum here.
  var minVersion = opts.version || 6;

  // EXT-X-DEFINE entries appear early so they're available for
  // substitution in any URI that follows. Validated upfront — bad
  // form is easier to fix at config time than after a player rejects.
  var serializedDefines = [];
  if (Array.isArray(opts.defines)) {
    for (var dii = 0; dii < opts.defines.length; dii++) {
      var def = opts.defines[dii];
      var defLine = _serializeDefineEntry(def, dii);
      serializedDefines.push(defLine);
      if (def.queryparam !== undefined && minVersion < 11) minVersion = 11;
    }
  }

  lines.push('#EXT-X-VERSION:' + minVersion);

  // Defines emitted right after VERSION — same convention as media playlist.
  for (var dei = 0; dei < serializedDefines.length; dei++) {
    lines.push(serializedDefines[dei]);
  }

  if (opts.independentSegments) {
    lines.push('#EXT-X-INDEPENDENT-SEGMENTS');
  }

  // EXT-X-SESSION-KEY (RFC 8216bis §4.4.5.1). Pre-fetched encryption
  // keys that apply to all variants. A multivariant-level
  // optimization — saves the player from refetching the same key
  // when switching variants. Same attribute set as EXT-X-KEY but
  // lives at the master level.
  if (Array.isArray(opts.sessionKeys)) {
    for (var ski = 0; ski < opts.sessionKeys.length; ski++) {
      lines.push(_serializeSessionKey(opts.sessionKeys[ski], ski));
    }
  }

  // EXT-X-SESSION-DATA (RFC 8216bis §4.4.5.2). Application-level
  // metadata — title, cast, chapters, custom IDs. Visible to the
  // player at startup before any media is fetched. Multiple entries
  // with the same DATA-ID can coexist for different LANGUAGEs.
  if (Array.isArray(opts.sessionData)) {
    for (var sdi = 0; sdi < opts.sessionData.length; sdi++) {
      lines.push(_serializeSessionData(opts.sessionData[sdi], sdi));
    }
  }

  // EXT-X-CONTENT-STEERING (RFC 8216bis §4.4.6.6). Multi-CDN failover
  // and traffic steering. Points the player at a Steering Manifest
  // (JSON) that lists ordered Pathways — alternative origins serving
  // the same content. The player polls the manifest periodically and
  // switches when the priority list changes.
  if (opts.contentSteering) {
    lines.push(_serializeContentSteering(opts.contentSteering));
  }

  // EXT-X-START on master applies to every variant — players seek to
  // the offset on initial playback regardless of which variant they
  // pick. Useful for mid-roll start, "last viewed" resume, etc.
  if (opts.start) {
    var startAttrs = 'TIME-OFFSET=' + opts.start.timeOffset;
    if (opts.start.precise) startAttrs += ',PRECISE=YES';
    lines.push('#EXT-X-START:' + startAttrs);
  }

  // Renditions before variants — the spec doesn't strictly require this
  // ordering globally, but every variant that references a group MUST
  // come after the group's MEDIA lines, and putting all MEDIA first is
  // the universal convention.
  if (Array.isArray(opts.audioRenditions)) {
    for (var ai = 0; ai < opts.audioRenditions.length; ai++) {
      lines.push(_serializeMediaRendition('AUDIO', opts.audioRenditions[ai]));
    }
  }
  if (Array.isArray(opts.subtitleRenditions)) {
    for (var si = 0; si < opts.subtitleRenditions.length; si++) {
      lines.push(_serializeMediaRendition('SUBTITLES', opts.subtitleRenditions[si]));
    }
  }
  // CLOSED-CAPTIONS use a slightly different EXT-X-MEDIA shape than
  // AUDIO/SUBTITLES — they carry INSTREAM-ID instead of URI, since
  // the captions live inline in the video stream as SEI messages.
  // Per RFC 8216 §4.4.6.1: "If TYPE is CLOSED-CAPTIONS, the URI
  // attribute MUST NOT be present."
  if (Array.isArray(opts.closedCaptionsRenditions)) {
    for (var cci = 0; cci < opts.closedCaptionsRenditions.length; cci++) {
      lines.push(_serializeClosedCaptionsRendition(
        opts.closedCaptionsRenditions[cci]));
    }
  }

  for (var i = 0; i < variants.length; i++) {
    var streamInf = _serializeStreamInf(variants[i]);
    lines.push(streamInf);
    lines.push(variants[i].uri);
  }

  // I-frame variants. Per RFC 8216 §4.4.6.3, EXT-X-I-FRAME-STREAM-INF
  // describes a Rendition consisting solely of I-frames — used for
  // trick-play (FF/RW, scrub thumbnails). Same attribute syntax as
  // STREAM-INF except URI is an attribute rather than the next line,
  // and FRAME-RATE/AUDIO/SUBTITLES/CLOSED-CAPTIONS aren't allowed.
  if (Array.isArray(opts.iFrameVariants)) {
    for (var ii = 0; ii < opts.iFrameVariants.length; ii++) {
      var iv = opts.iFrameVariants[ii];
      _validateVariantShape(iv, 'iFrameVariants', ii);
      lines.push(_serializeIFrameStreamInf(iv));
    }
  }

  return lines.join('\n') + '\n';
}

// ── Internal helpers ──────────────────────────────────────────

function _collectGroupIds(renditions, opts) {
  var map = {};
  if (!Array.isArray(renditions)) return map;
  // Per RFC 8216 §4.4.6.1, CLOSED-CAPTIONS renditions MUST NOT have a
  // URI — captions live inline in the video stream. AUDIO/SUBTITLES
  // renditions DO require URI. Caller passes { uriRequired: false }
  // for CLOSED-CAPTIONS; default is true.
  var uriRequired = !opts || opts.uriRequired !== false;
  for (var i = 0; i < renditions.length; i++) {
    var r = renditions[i];
    if (!r || typeof r.groupId !== 'string') {
      throw new TypeError('buildMasterPlaylist: rendition[' + i + '].groupId required');
    }
    if (typeof r.name !== 'string') {
      throw new TypeError('buildMasterPlaylist: rendition[' + i + '].name required');
    }
    if (uriRequired && typeof r.uri !== 'string') {
      throw new TypeError('buildMasterPlaylist: rendition[' + i + '].uri required');
    }
    map[r.groupId] = true;
  }
  return map;
}

// Validation regexes for closed-captions INSTREAM-ID. Per RFC 8216
// §4.4.6.1.1, INSTREAM-ID identifies a logical channel within the
// inline caption data:
//   "CC1".."CC4"            — CEA-608 channels 1-4
//   "SERVICE1".."SERVICE63" — CEA-708 service blocks
// Compiled once at module load to avoid re-allocation on each call.
var _RE_INSTREAM_CEA608 = /^CC[1-4]$/;
var _RE_INSTREAM_CEA708 = /^SERVICE([1-9]|[1-5][0-9]|6[0-3])$/;

/**
 * Render a CLOSED-CAPTIONS EXT-X-MEDIA line. The shape differs from
 * audio/subtitle renditions:
 *   - INSTREAM-ID (required) tells the player which channel of the
 *     inline caption data to use ('CC1'..'CC4' for CEA-608,
 *     'SERVICE1'..'SERVICE63' for CEA-708)
 *   - URI is FORBIDDEN (captions are in the video stream)
 *   - FORCED, CHANNELS are not applicable
 */
function _serializeClosedCaptionsRendition(r) {
  // groupId/name already validated by _collectGroupIds when caller
  // passed closedCaptionsRenditions; we revalidate here so the function
  // is safe to call with raw input too.
  if (typeof r.groupId !== 'string') {
    throw new TypeError('closed-captions rendition: groupId required');
  }
  if (typeof r.name !== 'string') {
    throw new TypeError('closed-captions rendition: name required');
  }
  if (typeof r.instreamId !== 'string') {
    throw new TypeError('closed-captions rendition: instreamId required');
  }
  var instreamId = r.instreamId;
  if (!_RE_INSTREAM_CEA608.test(instreamId) &&
      !_RE_INSTREAM_CEA708.test(instreamId)) {
    throw new RangeError(
      'closed-captions instreamId must be "CC1"..."CC4" or ' +
      '"SERVICE1"..."SERVICE63" (got: ' + instreamId + ')');
  }

  var attrs = [];
  attrs.push('TYPE=CLOSED-CAPTIONS');
  attrs.push('GROUP-ID="' + escapeQuoted(r.groupId) + '"');
  attrs.push('NAME="' + escapeQuoted(r.name) + '"');
  if (r.stableRenditionId) {
    attrs.push('STABLE-RENDITION-ID="' + escapeQuoted(r.stableRenditionId) + '"');
  }
  if (r.language)        attrs.push('LANGUAGE="' + escapeQuoted(r.language) + '"');
  if (r.assocLanguage)   attrs.push('ASSOC-LANGUAGE="' + escapeQuoted(r.assocLanguage) + '"');
  if (r.default)         attrs.push('DEFAULT=YES');
  if (r.autoselect)      attrs.push('AUTOSELECT=YES');
  if (r.characteristics) {
    attrs.push('CHARACTERISTICS="' + escapeQuoted(r.characteristics) + '"');
  }
  // INSTREAM-ID is the key distinguishing attribute; emit unquoted? No —
  // per RFC 8216 §4.4.6.1.1 it's a quoted-string.
  attrs.push('INSTREAM-ID="' + escapeQuoted(instreamId) + '"');

  return '#EXT-X-MEDIA:' + attrs.join(',');
}

function _serializeMediaRendition(type, r) {
  // EXT-X-MEDIA layout per RFC 8216 §4.3.4.1. Order of attributes
  // is not significant to parsers, but we follow Apple's example
  // output (which most tools mirror) for friendliness when humans
  // diff manifest output.
  var attrs = [];
  attrs.push('TYPE=' + type);
  attrs.push('GROUP-ID="' + escapeQuoted(r.groupId) + '"');
  attrs.push('NAME="' + escapeQuoted(r.name) + '"');

  // STABLE-RENDITION-ID (RFC 8216bis §4.4.6.1). Persistent ID for
  // this rendition across master-playlist refreshes. Lets clients
  // remember the user's manual rendition selection (e.g., audio
  // language) when the playlist gets reordered or re-bandwidth'd.
  if (r.stableRenditionId) {
    attrs.push('STABLE-RENDITION-ID="' + escapeQuoted(r.stableRenditionId) + '"');
  }
  if (r.language)        attrs.push('LANGUAGE="' + escapeQuoted(r.language) + '"');
  if (r.assocLanguage)   attrs.push('ASSOC-LANGUAGE="' + escapeQuoted(r.assocLanguage) + '"');
  if (r.default)         attrs.push('DEFAULT=YES');
  if (r.autoselect)      attrs.push('AUTOSELECT=YES');
  // FORCED is only valid for SUBTITLES per spec.
  if (type === 'SUBTITLES' && r.forced) {
    attrs.push('FORCED=YES');
  }
  // CHARACTERISTICS (RFC 8216 §4.3.4.1.1). Comma-separated list of
  // Uniform Type Identifiers describing rendition capabilities.
  // Common values: "public.accessibility.transcribes-spoken-dialog"
  // (CC for the deaf), "public.accessibility.describes-music-and-
  // sound" (descriptive audio), "public.easy-to-read" (simplified
  // dialogue). Required for accessibility compliance.
  if (r.characteristics) {
    attrs.push('CHARACTERISTICS="' + escapeQuoted(r.characteristics) + '"');
  }
  if (r.channels)        attrs.push('CHANNELS="' + escapeQuoted(r.channels) + '"');
  attrs.push('URI="' + escapeQuoted(r.uri) + '"');

  return '#EXT-X-MEDIA:' + attrs.join(',');
}

function _serializeStreamInf(v) {
  var attrs = [];
  // BANDWIDTH must appear first per spec recommendation. Required.
  attrs.push('BANDWIDTH=' + (v.bandwidth | 0));

  if (typeof v.averageBandwidth === 'number') {
    attrs.push('AVERAGE-BANDWIDTH=' + (v.averageBandwidth | 0));
  }
  // SCORE (RFC 8216bis §4.4.6.2). Used by ABR clients to break ties
  // among variants with similar BANDWIDTH. Higher score = preferred.
  // Useful when two variants have similar bitrates but one has a
  // better codec or PSNR. decimal-floating-point, non-negative.
  if (typeof v.score === 'number') {
    attrs.push('SCORE=' + v.score.toFixed(3));
  }
  if (v.codecs)             attrs.push('CODECS="' + escapeQuoted(v.codecs) + '"');
  // SUPPLEMENTAL-CODECS (RFC 8216bis-13 §4.4.6.2.2) — enables backwards-
  // compatible Dolby Vision and HDR10+ signaling. Older players see
  // CODECS only; newer players read both and pick the richest profile
  // their hardware supports.
  if (v.supplementalCodecs) {
    attrs.push('SUPPLEMENTAL-CODECS="' + escapeQuoted(v.supplementalCodecs) + '"');
  }
  if (v.resolution)         attrs.push('RESOLUTION=' + v.resolution);
  if (typeof v.frameRate === 'number') {
    // Three decimal places per spec (e.g., "29.970", "59.940").
    attrs.push('FRAME-RATE=' + v.frameRate.toFixed(3));
  }
  // VIDEO-RANGE (RFC 8216bis-13 §4.4.6.2.1) — enumerated-string,
  // unquoted. Must be SDR / HLG / PQ. Telling the player whether
  // this variant is HDR is the difference between correct color
  // reproduction and a flat washed-out image on HDR displays.
  if (v.videoRange) {
    attrs.push('VIDEO-RANGE=' + v.videoRange);
  }
  // ALLOWED-CPC (RFC 8216bis §4.4.6.2). Content Protection
  // Configuration — comma-separated list of DRM schemes this
  // variant uses. Format: "<keyformat>:<cpc-label-list>". Players
  // that can't handle the schemes won't pick the variant. Typical
  // value: "com.apple.streamingkeydelivery:SMART-TV-2020,..."
  if (v.allowedCpc) {
    attrs.push('ALLOWED-CPC="' + escapeQuoted(v.allowedCpc) + '"');
  }
  // STABLE-VARIANT-ID (RFC 8216bis §4.4.6.2). Persistent ID for
  // this variant across master-playlist refreshes. Lets players
  // remember "the user picked this variant" when the playlist gets
  // a new BANDWIDTH estimate or rendition reorder. quoted-string.
  if (v.stableVariantId) {
    attrs.push('STABLE-VARIANT-ID="' + escapeQuoted(v.stableVariantId) + '"');
  }
  // PATHWAY-ID (RFC 8216bis §4.4.6.2). Used with EXT-X-CONTENT-
  // STEERING — declares which pathway (CDN/origin) this variant
  // belongs to. The Steering Manifest can change which pathway is
  // preferred, and clients pick variants matching the active one.
  if (v.pathwayId) {
    attrs.push('PATHWAY-ID="' + escapeQuoted(v.pathwayId) + '"');
  }
  if (v.name)               attrs.push('NAME="' + escapeQuoted(v.name) + '"');
  if (v.audio)              attrs.push('AUDIO="' + escapeQuoted(v.audio) + '"');
  if (v.subtitles)          attrs.push('SUBTITLES="' + escapeQuoted(v.subtitles) + '"');
  if (v.closedCaptions === null) {
    attrs.push('CLOSED-CAPTIONS=NONE');
  } else if (typeof v.closedCaptions === 'string') {
    attrs.push('CLOSED-CAPTIONS="' + escapeQuoted(v.closedCaptions) + '"');
  }

  return '#EXT-X-STREAM-INF:' + attrs.join(',');
}

/**
 * Render one EXT-X-I-FRAME-STREAM-INF line. Same attribute set as
 * STREAM-INF except:
 *   - URI is an attribute on the line itself (not a separate URI line)
 *   - FRAME-RATE, AUDIO, SUBTITLES, CLOSED-CAPTIONS are forbidden
 *     (an I-frame variant has no audio/CC/timing semantics)
 *
 * BANDWIDTH for I-frame variants is the peak rate of the I-frame
 * data only — much smaller than the parent variant's bandwidth.
 */
function _serializeIFrameStreamInf(v) {
  var attrs = [];
  attrs.push('BANDWIDTH=' + (v.bandwidth | 0));
  if (typeof v.averageBandwidth === 'number') {
    attrs.push('AVERAGE-BANDWIDTH=' + (v.averageBandwidth | 0));
  }
  if (v.codecs)             attrs.push('CODECS="' + escapeQuoted(v.codecs) + '"');
  if (v.supplementalCodecs) {
    attrs.push('SUPPLEMENTAL-CODECS="' + escapeQuoted(v.supplementalCodecs) + '"');
  }
  if (v.resolution)         attrs.push('RESOLUTION=' + v.resolution);
  // VIDEO-RANGE on I-frame variants helps players match the trick-play
  // resource to the right display capability — an SDR display fetching
  // from an HDR I-frame variant would render incorrectly.
  if (v.videoRange) {
    attrs.push('VIDEO-RANGE=' + v.videoRange);
  }
  if (v.name)               attrs.push('NAME="' + escapeQuoted(v.name) + '"');
  // URI goes last by convention — easy to find when grepping
  attrs.push('URI="' + escapeQuoted(v.uri) + '"');
  return '#EXT-X-I-FRAME-STREAM-INF:' + attrs.join(',');
}

/**
 * Render one EXT-X-DEFINE entry. Three forms — exactly one set of
 * fields must be present per the spec:
 *   - { name, value }     literal substitution
 *   - { import: name }    pull from another playlist (used only in
 *                         media playlists; included here for symmetry
 *                         in case callers reuse the entry shape)
 *   - { queryparam: name } extract from playlist URL (HLS v11+)
 */
function _serializeDefineEntry(def, idx) {
  if (!def || typeof def !== 'object') {
    throw new TypeError('buildMasterPlaylist: defines[' + idx + '] must be an object');
  }
  var hasName  = typeof def.name === 'string';
  var hasValue = typeof def.value === 'string';
  var hasImport = typeof def['import'] === 'string';
  var hasQuery  = typeof def.queryparam === 'string';

  var formCount = (hasName && hasValue ? 1 : 0) +
                  (hasImport ? 1 : 0) +
                  (hasQuery ? 1 : 0);
  if (formCount !== 1) {
    throw new TypeError('buildMasterPlaylist: defines[' + idx + '] requires exactly ' +
                        'one of {name+value}, {import}, {queryparam}');
  }

  if (hasName) {
    if (!isValidVariableName(def.name)) {
      throw new TypeError('buildMasterPlaylist: defines[' + idx + '].name "' +
                          def.name + '" must match [A-Za-z0-9_-]+');
    }
    return '#EXT-X-DEFINE:NAME="' + escapeQuoted(def.name) +
           '",VALUE="' + escapeQuoted(def.value) + '"';
  }
  if (hasImport) {
    if (!isValidVariableName(def['import'])) {
      throw new TypeError('buildMasterPlaylist: defines[' + idx + '].import invalid');
    }
    return '#EXT-X-DEFINE:IMPORT="' + escapeQuoted(def['import']) + '"';
  }
  if (!isValidVariableName(def.queryparam)) {
    throw new TypeError('buildMasterPlaylist: defines[' + idx + '].queryparam invalid');
  }
  return '#EXT-X-DEFINE:QUERYPARAM="' + escapeQuoted(def.queryparam) + '"';
}

/**
 * Render one EXT-X-SESSION-DATA entry. Either VALUE (inline) or URI
 * (external resource, optionally with FORMAT). LANGUAGE optional.
 *
 * DATA-ID convention is reverse-DNS (e.g. "com.example.title") to
 * avoid collisions when multiple parties contribute metadata. We
 * don't validate the format — the spec allows any string.
 */
function _serializeSessionData(sd, idx) {
  if (!sd || typeof sd.dataId !== 'string') {
    throw new TypeError('buildMasterPlaylist: sessionData[' + idx +
                        '].dataId (string) required');
  }
  var hasValue = typeof sd.value === 'string';
  var hasUri   = typeof sd.uri === 'string';
  if (hasValue === hasUri) {
    // Both or neither — both invalid.
    throw new TypeError('buildMasterPlaylist: sessionData[' + idx +
                        '] requires exactly one of {value} or {uri}');
  }

  var attrs = 'DATA-ID="' + escapeQuoted(sd.dataId) + '"';
  if (hasValue) {
    attrs += ',VALUE="' + escapeQuoted(sd.value) + '"';
  } else {
    attrs += ',URI="' + escapeQuoted(sd.uri) + '"';
    if (sd.format !== undefined) {
      // Per spec, FORMAT is "JSON" or "RAW". Default JSON if URI is
      // present and format omitted (matches spec default behavior).
      var f = sd.format;
      if (f !== 'JSON' && f !== 'RAW') {
        throw new TypeError('buildMasterPlaylist: sessionData[' + idx +
                            '].format must be JSON or RAW (got "' + f + '")');
      }
      attrs += ',FORMAT=' + f;
    }
  }
  if (sd.language !== undefined) {
    attrs += ',LANGUAGE="' + escapeQuoted(sd.language) + '"';
  }
  return '#EXT-X-SESSION-DATA:' + attrs;
}

/**
 * Render one EXT-X-SESSION-KEY entry. Same attribute set as the
 * media-playlist EXT-X-KEY, but a master-level pre-fetch directive.
 * METHOD is required and validated; URI required for non-NONE methods.
 *
 * Methods recognized: AES-128, SAMPLE-AES, AES-256-GCM (added in
 * RFC 8216bis-19 January 2026), SAMPLE-AES-CTR. NONE is excluded —
 * it's pointless at the session level.
 */
function _serializeSessionKey(sk, idx) {
  if (!sk || typeof sk.method !== 'string') {
    throw new TypeError('buildMasterPlaylist: sessionKeys[' + idx +
                        '].method (string) required');
  }
  var m = sk.method;
  if (!isValidEncryptionMethod(m)) {
    throw new TypeError('buildMasterPlaylist: sessionKeys[' + idx +
                        '].method "' + m + '" must be AES-128, SAMPLE-AES, ' +
                        'AES-256-GCM, or SAMPLE-AES-CTR');
  }
  if (typeof sk.uri !== 'string') {
    throw new TypeError('buildMasterPlaylist: sessionKeys[' + idx +
                        '].uri (string) required');
  }

  var attrs = 'METHOD=' + m;
  attrs += ',URI="' + escapeQuoted(sk.uri) + '"';
  if (sk.iv !== undefined) {
    // IV is a hex string. Per spec it MUST be prefixed with 0x or 0X
    // and contain exactly 32 hex digits (128 bits).
    var iv = String(sk.iv);
    if (!isValidIvHex(iv)) {
      throw new TypeError('buildMasterPlaylist: sessionKeys[' + idx +
                          '].iv must be 0x followed by 32 hex digits');
    }
    attrs += ',IV=' + iv;
  }
  if (sk.keyFormat !== undefined) {
    attrs += ',KEYFORMAT="' + escapeQuoted(sk.keyFormat) + '"';
  }
  if (sk.keyFormatVersions !== undefined) {
    attrs += ',KEYFORMATVERSIONS="' + escapeQuoted(sk.keyFormatVersions) + '"';
  }
  return '#EXT-X-SESSION-KEY:' + attrs;
}

/**
 * Render EXT-X-CONTENT-STEERING (RFC 8216bis §4.4.6.6). Tells the
 * player where to fetch the Steering Manifest — a JSON file that
 * lists CDN pathways in priority order. PATHWAY-ID is optional but
 * lets the steering manifest reference this manifest's "home" pathway.
 *
 * @param {object} cs
 * @param {string} cs.serverUri    URI of the steering manifest (JSON).
 * @param {string} [cs.pathwayId]  Pathway identifier for this playlist.
 *                                  Reverse-DNS is the convention. The
 *                                  steering manifest can reorder which
 *                                  pathway is preferred at any moment.
 */
function _serializeContentSteering(cs) {
  if (!cs || typeof cs.serverUri !== 'string') {
    throw new TypeError('buildMasterPlaylist: contentSteering.serverUri (string) required');
  }
  var attrs = 'SERVER-URI="' + escapeQuoted(cs.serverUri) + '"';
  if (cs.pathwayId !== undefined) {
    attrs += ',PATHWAY-ID="' + escapeQuoted(cs.pathwayId) + '"';
  }
  return '#EXT-X-CONTENT-STEERING:' + attrs;
}

export default buildMasterPlaylist;


// ── Parsing (read half of the future merged read+write master playlist) ──

function _toNum(s)  { return s === undefined ? undefined : Number(s); }
function _toBool(s) { return s === 'YES'; }

/**
 * Map a parsed EXT-X-STREAM-INF (or I-FRAME-STREAM-INF) attribute object
 * to the variant shape buildMasterPlaylist() consumes (camelCase fields).
 */
function _streamInfToVariant(a) {
  var v = { uri: a.URI || null };               // URI present only on I-frame variants
  if (a.BANDWIDTH !== undefined)            v.bandwidth = _toNum(a.BANDWIDTH);
  if (a['AVERAGE-BANDWIDTH'] !== undefined) v.averageBandwidth = _toNum(a['AVERAGE-BANDWIDTH']);
  if (a.SCORE !== undefined)                v.score = _toNum(a.SCORE);
  if (a.CODECS !== undefined)               v.codecs = a.CODECS;
  if (a['SUPPLEMENTAL-CODECS'] !== undefined) v.supplementalCodecs = a['SUPPLEMENTAL-CODECS'];
  if (a.RESOLUTION !== undefined)           v.resolution = a.RESOLUTION;
  if (a['FRAME-RATE'] !== undefined)        v.frameRate = _toNum(a['FRAME-RATE']);
  if (a['VIDEO-RANGE'] !== undefined)       v.videoRange = a['VIDEO-RANGE'];
  if (a.AUDIO !== undefined)                v.audio = a.AUDIO;
  if (a.SUBTITLES !== undefined)            v.subtitles = a.SUBTITLES;
  if (a['CLOSED-CAPTIONS'] !== undefined)   v.closedCaptions = a['CLOSED-CAPTIONS'];
  return v;
}

/**
 * Map a parsed EXT-X-MEDIA attribute object to the rendition shape the
 * writer's serializer consumes.
 */
function _attrsToRendition(a) {
  var r = {
    type: a.TYPE || null,
    groupId: a['GROUP-ID'] || null,
    name: a.NAME || null,
  };
  if (a.URI !== undefined)             r.uri = a.URI;
  if (a.LANGUAGE !== undefined)        r.language = a.LANGUAGE;
  if (a['ASSOC-LANGUAGE'] !== undefined) r.assocLanguage = a['ASSOC-LANGUAGE'];
  if (a.DEFAULT !== undefined)         r.default = _toBool(a.DEFAULT);
  if (a.AUTOSELECT !== undefined)      r.autoselect = _toBool(a.AUTOSELECT);
  if (a.FORCED !== undefined)          r.forced = _toBool(a.FORCED);
  if (a.CHANNELS !== undefined)        r.channels = a.CHANNELS;
  if (a.CHARACTERISTICS !== undefined) r.characteristics = a.CHARACTERISTICS;
  if (a['INSTREAM-ID'] !== undefined)  r.instreamId = a['INSTREAM-ID'];
  if (a['STABLE-RENDITION-ID'] !== undefined) r.stableRenditionId = a['STABLE-RENDITION-ID'];
  return r;
}

/**
 * Parse an HLS Master (multivariant) Playlist into a structured object
 * whose shape mirrors buildMasterPlaylist()'s inputs — variants and
 * renditions use the same camelCase field names, so a parsed master
 * playlist can round-trip back through the writer. Read half of the
 * future merged read+write master playlist.
 *
 * Scope: EXT-X-STREAM-INF variants (bandwidth, average bandwidth, codecs,
 * resolution, frame rate, video range, group references), I-frame
 * variants, EXT-X-MEDIA renditions (audio / subtitles / closed-captions),
 * and the global version / independent-segments flags.
 *
 * @param {string} text  the full master .m3u8 text
 * @returns {{
 *   version:?number, independentSegments:boolean,
 *   variants:Array<Object>, iFrameVariants:Array<Object>,
 *   audioRenditions:Array<Object>, subtitleRenditions:Array<Object>,
 *   closedCaptionsRenditions:Array<Object>
 * }}
 */
export function parseMasterPlaylist(text) {
  var lines = String(text).split(/\r?\n/);
  var out = {
    version: null,
    independentSegments: false,
    variants: [],
    iFrameVariants: [],
    audioRenditions: [],
    subtitleRenditions: [],
    closedCaptionsRenditions: [],
  };

  var pendingVariant = null;   // STREAM-INF awaiting its URI on the next line

  for (var li = 0; li < lines.length; li++) {
    var line = lines[li].trim();
    if (line === '') continue;

    if (line.charCodeAt(0) !== 35 /* '#' */) {
      if (pendingVariant) {
        pendingVariant.uri = line;
        out.variants.push(pendingVariant);
        pendingVariant = null;
      }
      continue;
    }

    if (line.indexOf('#EXT-X-STREAM-INF:') === 0) {
      pendingVariant = _streamInfToVariant(parseAttributeList(line.slice(18)));
    } else if (line.indexOf('#EXT-X-I-FRAME-STREAM-INF:') === 0) {
      out.iFrameVariants.push(_streamInfToVariant(parseAttributeList(line.slice(26))));
    } else if (line.indexOf('#EXT-X-MEDIA:') === 0) {
      var r = _attrsToRendition(parseAttributeList(line.slice(13)));
      if (r.type === 'AUDIO') out.audioRenditions.push(r);
      else if (r.type === 'SUBTITLES') out.subtitleRenditions.push(r);
      else if (r.type === 'CLOSED-CAPTIONS') out.closedCaptionsRenditions.push(r);
    } else if (line.indexOf('#EXT-X-VERSION:') === 0) {
      out.version = parseInt(line.slice(15), 10);
    } else if (line === '#EXT-X-INDEPENDENT-SEGMENTS') {
      out.independentSegments = true;
    }
    // Unknown tags ignored (forward-compatible).
  }

  return out;
}
