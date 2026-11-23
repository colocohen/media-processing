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
  // mediacapture-transform: maxBufferSize starts at 1 and takes the
  // application's value only when it is an integer > 1.
  var maxBuffer = (Number.isInteger(init.maxBufferSize) && init.maxBufferSize > 1) ? init.maxBufferSize : 1;
  var eventName = track.kind === 'video' ? 'frame' : 'data';
  var handler = null, onEnded = null;
  var queue = [];            // [[queue]]: owned clones, oldest first
  var pendingPull = null;    // controller waiting in pull() for a frame
  var ctl = null;
  var self = this;
  this.discardedFrames = 0;  // [[numDiscardedFrames]]

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

  this.readable = new ReadableStream({
    start: function (controller) {
      ctl = controller;
      handler = function (data) {
        // Clone before queueing. EventEmitter delivers the same VideoFrame /
        // AudioData object to every listener, all sharing one ref-counted
        // buffer; a sibling listener may close() it before our reader pulls.
        // clone() only bumps the refcount (W3C), so this is cheap.
        var owned = (typeof data.clone === 'function') ? data.clone() : data;
        if (queue.length >= maxBuffer) {
          var dropped = queue.shift();
          try { if (dropped && typeof dropped.close === 'function') dropped.close(); } catch (e) {}
          self.discardedFrames++;
        }
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
        try { controller.close(); } catch (e) {}
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
      while (queue.length) {
        var f = queue.shift();
        try { if (f && typeof f.close === 'function') f.close(); } catch (e) {}
      }
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
   */
  this.writable = new WritableStream({
    write: function (data) {
      if (self.readyState === 'ended') {
        throw new Error('MediaStreamTrackGenerator: track is ended');
      }
      self._push(data);
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