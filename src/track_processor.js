/**
 * MediaStreamTrackProcessor / MediaStreamTrackGenerator
 *
 * "Breakout Box" API — bridges MediaStreamTrack and Web Streams.
 * Spec: https://www.w3.org/TR/mediacapture-transform/
 *
 * MediaStreamTrackProcessor:
 *   Takes a MediaStreamTrack, exposes a ReadableStream of VideoFrame/AudioData.
 *   var processor = new MediaStreamTrackProcessor({ track: videoTrack });
 *   var reader = processor.readable.getReader();
 *   var { value: frame, done } = await reader.read();
 *
 * MediaStreamTrackGenerator:
 *   Creates a MediaStreamTrack fed by a WritableStream.
 *   var generator = new MediaStreamTrackGenerator({ kind: 'video' });
 *   var writer = generator.writable.getWriter();
 *   await writer.write(videoFrame);
 *   stream.addTrack(generator);  // generator IS a track
 *
 * Use cases:
 *   - WebRTC insertable streams / processing pipelines
 *   - Transform frames between capture and encoding
 *   - Pipe Node.js streams into MediaStreamTrack
 */

import { MediaStreamTrack } from './media_stream.js';

// ═══════════════════════════════════════
//  MediaStreamTrackProcessor
// ═══════════════════════════════════════

/**
 * @param {object} init
 * @param {MediaStreamTrack} init.track — source track to read from
 * @param {number} [init.maxBufferSize=15] — max queued frames before backpressure
 */
function MediaStreamTrackProcessor(init) {
  if (!init || !init.track) {
    throw new TypeError('MediaStreamTrackProcessor: track required');
  }
  // DUCK-TYPED (not instanceof) — the preserve-symlinks landmine, third
  // sighting: sibling packages hold DIFFERENT class identities for this
  // same source file, so a genuine track resolved through webrtc-server
  // fails instanceof here. Shape is identity.
  var _looksLikeTrack = init.track && typeof init.track === 'object' &&
    (init.track.kind === 'audio' || init.track.kind === 'video') &&
    typeof init.track.id === 'string';
  if (!(init.track instanceof MediaStreamTrack) && !_looksLikeTrack) {
    throw new TypeError('MediaStreamTrackProcessor: expected MediaStreamTrack');
  }

  var track = init.track;
  // A track that has ended can deliver nothing and will never end again:
  // the stream stayed open and every read() waited forever. Spec: "If
  // init.track is a MediaStreamTrack that is not valid, throw a
  // TypeError" (Chromium: "Input track cannot be ended").
  if (track.readyState === 'ended') {
    throw new TypeError('MediaStreamTrackProcessor: track is ended');
  }
  // mediacapture-transform: maxBufferSize starts at 1 and takes the
  // application's value only when it is more than 1. The member is
  // `[EnforceRange] unsigned short`: WebIDL converts it (ToNumber, a
  // TypeError when not finite or outside 0..65535, then truncated), so
  // 2.5 is 2 and "5" is 5 — both were taken as 1.
  var maxBuffer = 1;
  if (init.maxBufferSize !== undefined) {
    var mb = Number(init.maxBufferSize);
    if (!Number.isFinite(mb)) throw new TypeError('MediaStreamTrackProcessor: maxBufferSize is not a finite number');
    mb = Math.trunc(mb);
    if (mb < 0 || mb > 65535) throw new TypeError('MediaStreamTrackProcessor: maxBufferSize is outside the range of unsigned short');
    if (mb > 1) maxBuffer = mb;
  }
  var eventName = track.kind === 'video' ? 'frame' : 'data';
  var handler = null, onEnded = null;
  var queue = [];            // [[queue]]: owned clones, oldest first
  var pendingPull = null;    // controller waiting in pull() for a frame
  var ctl = null;
  var self = this;
  this.discardedFrames = 0;  // [[numDiscardedFrames]]
  this.totalFrames = 0;      // [[numTotalFrames]]: every frame received, the discarded ones too (it was missing)

  // The queue is the spec's own, not the ReadableStream's. When it was the
  // stream's (CountQueuingStrategy, default 15), a full queue DROPPED THE
  // NEW FRAME — the consumer was fed the oldest ones, up to 15 frames
  // (half a second at 30 fps) behind live. handleNewFrame (§2.1.5) does the
  // opposite: dequeue and close the OLDEST, enqueue the new one, so a
  // queued frame is always among the most recent.
  function deliver() {
    if (pendingPull && queue.length) {
      var c = pendingPull; pendingPull = null;
      c.enqueue(queue.shift());
    }
  }
  function detach() {
    if (handler) { track.off(eventName, handler); handler = null; }
    if (onEnded) { track.off('_stopped', onEnded); onEnded = null; }
  }
  // processorClose: "Empty processor.[[queue]]" — the frames still queued
  // are our clones: release them. On the track's end they stayed queued,
  // unreadable (the stream is closed) and holding their buffers.
  function emptyQueue() {
    while (queue.length) {
      var f = queue.shift();
      try { if (f && typeof f.close === 'function') f.close(); } catch (e) {}
    }
  }

  this.readable = new ReadableStream({
    start: function (controller) {
      ctl = controller;
      handler = function (data) {
        // Clone before queueing. EventEmitter delivers the same VideoFrame /
        // AudioData object to every listener, all sharing one ref-counted
        // buffer; a sibling listener may close() it before our reader pulls.
        // clone() only bumps the refcount (W3C), so this is cheap.
        // Media only: a dispatchEvent({type: 'frame'}) reaches this
        // listener too, and its Event object was queued and read as if it
        // were a frame (mediacapture-transform: the chunks are VideoFrame /
        // AudioData objects).
        if (!data || typeof data.clone !== 'function') return;
        var owned = data.clone();
        if (queue.length >= maxBuffer) {
          var dropped = queue.shift();
          try { if (dropped && typeof dropped.close === 'function') dropped.close(); } catch (e) {}
          self.discardedFrames++;
        }
        self.totalFrames++;
        queue.push(owned);
        deliver();
      };
      // prependListener (not on()) so this handler ALWAYS fires first when
      // multiple listeners are attached: cloning has to happen before any
      // sibling listener calls close() — clone() on a detached frame throws.
      if (typeof track.prependListener === 'function') {
        track.prependListener(eventName, handler);
      } else {
        track.on(eventName, handler);
      }
      // End the stream when the track ends. Kept as a reference so cancel()
      // can remove it — it leaked one 'ended' listener per processor.
      onEnded = function () {
        detach();
        pendingPull = null;
        try { controller.close(); } catch (e) {}
        emptyQueue();
      };
      // '_stopped' covers the track's own stop(), which fires no 'ended'
      // (mediacapture-main) but ends the processor's stream all the same.
      track.on('_stopped', onEnded);
    },
    pull: function (controller) {
      pendingPull = controller;
      deliver();
    },
    cancel: function () {
      detach();
      pendingPull = null;
      // Frames still queued are ours (clones): release them. They were
      // left holding their buffers' refcounts.
      emptyQueue();
    },
  }, { highWaterMark: 0 });
}

// ═══════════════════════════════════════
//  MediaStreamTrackGenerator
// ═══════════════════════════════════════

/**
 * A MediaStreamTrack that is fed from a WritableStream.
 * The generator IS a MediaStreamTrack — it inherits all track methods.
 *
 * @param {object} init
 * @param {string} init.kind — 'video' or 'audio'
 */
function MediaStreamTrackGenerator(init) {
  if (!init || !init.kind) {
    throw new TypeError('MediaStreamTrackGenerator: kind required');
  }

  var kind = init.kind;
  if (kind !== 'video' && kind !== 'audio') {
    throw new TypeError('MediaStreamTrackGenerator: kind must be "video" or "audio"');
  }

  // Create the underlying track
  MediaStreamTrack.call(this, { kind: kind, label: 'MediaStreamTrackGenerator' });

  var self = this;

  /**
   * WritableStream that accepts VideoFrame (video) or AudioData (audio).
   * Each write() pushes the data through the track to any connected sinks.
   *
   * As the spec's writeFrame (VideoTrackGenerator; the AudioData case the
   * same): "If frame is not a VideoFrame object, return a promise rejected
   * with a TypeError. If the value of frame's [[Detached]] internal slot is
   * true, return a promise rejected with a TypeError", then a clone to each
   * live track and "Run the Close VideoFrame algorithm with frame" — the
   * writer's object is closed once written. Before: anything was pushed (an
   * AudioData down a video track, a closed frame), and the writer's own
   * object was the one the last track's consumers got, still open in the
   * writer's hands.
   *
   * The source ends when its last track does ("When the last track sourced
   * from a VideoTrackGenerator ends, that VideoTrackGenerator's writable is
   * closed"): writes then fail. They failed as soon as the generator
   * itself was stopped, also while a clone of it was live.
   */
  this.writable = new WritableStream({
    write: function (data) {
      var isVideo = !!data && typeof data === 'object' && typeof data.codedWidth === 'number' &&
        typeof data.numberOfFrames !== 'number' && typeof data.clone === 'function';
      var isAudio = !!data && typeof data === 'object' && typeof data.numberOfFrames === 'number' &&
        typeof data.sampleRate === 'number' && typeof data.clone === 'function';
      if (kind === 'video' ? !isVideo : !isAudio) {
        throw new TypeError('MediaStreamTrackGenerator: expected ' + (kind === 'video' ? 'a VideoFrame' : 'an AudioData'));
      }
      if (data.format == null) {
        throw new TypeError('MediaStreamTrackGenerator: ' + (kind === 'video' ? 'VideoFrame' : 'AudioData') + ' is closed');
      }
      if (self._source ? self._source.stopped : self.readyState === 'ended') {
        throw new TypeError('MediaStreamTrackGenerator: track is ended');
      }
      var copy = data.clone();
      data.close();
      self._push(copy);
    },
    // Closing (or aborting) the writable ends the generator's source:
    // the track and its clones end and fire 'ended' (mediacapture-
    // transform), which a stop() would not.
    close: function () {
      self._endSource();
    },
    abort: function () {
      self._endSource();
    },
  });
}

// Inherit from MediaStreamTrack
MediaStreamTrackGenerator.prototype = Object.create(MediaStreamTrack.prototype);
MediaStreamTrackGenerator.prototype.constructor = MediaStreamTrackGenerator;

export { MediaStreamTrackProcessor, MediaStreamTrackGenerator };