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
  if (!(init.track instanceof MediaStreamTrack)) {
    throw new TypeError('MediaStreamTrackProcessor: expected MediaStreamTrack');
  }

  var track = init.track;
  var maxBuffer = init.maxBufferSize || 15;
  var eventName = track.kind === 'video' ? 'frame' : 'data';
  var handler = null;

  /**
   * ReadableStream that yields VideoFrame (video) or AudioData (audio)
   * from the source track. Backpressure is handled by the stream's
   * internal queue — when the queue is full, frames are dropped.
   */
  this.readable = new ReadableStream({
    start: function (controller) {
      handler = function (data) {
        if (controller.desiredSize !== null && controller.desiredSize <= 0) {
          // Backpressure: consumer is slow, drop frame
          return;
        }
        // Clone before enqueue. EventEmitter delivers the same VideoFrame /
        // AudioData object to every listener, all sharing one ref-counted
        // buffer. If a sibling listener calls close() before our async reader
        // pulls from the queue, copyTo on the queued object throws
        // "VideoFrame is detached". Per W3C WebCodecs, .clone() is cheap —
        // it just bumps the underlying resource's refcount; pixel/sample
        // data is not duplicated. This makes the processor independent of
        // other consumers' lifetimes.
        var owned = (typeof data.clone === 'function') ? data.clone() : data;
        controller.enqueue(owned);
      };
      // prependListener (not on()) so this handler ALWAYS fires first when
      // multiple listeners are attached. Cloning has to happen before any
      // sibling listener calls close() — clone() on a detached frame throws.
      // EventEmitter calls listeners in registration order; if a diag/log
      // listener was attached BEFORE the processor and closes the frame,
      // a plain on() handler would receive an already-detached frame and
      // clone() would fail. prependListener guarantees we run first
      // regardless of when the processor was constructed.
      if (typeof track.prependListener === 'function') {
        track.prependListener(eventName, handler);
      } else {
        track.on(eventName, handler);
      }

      // End the stream when the track stops
      track.on('ended', function () {
        try { controller.close(); } catch (e) {}
      });
    },
    cancel: function () {
      if (handler) {
        track.off(eventName, handler);
        handler = null;
      }
    },
  }, new CountQueuingStrategy({ highWaterMark: maxBuffer }));
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
    close: function () {
      self.stop();
    },
    abort: function () {
      self.stop();
    },
  });
}

// Inherit from MediaStreamTrack
MediaStreamTrackGenerator.prototype = Object.create(MediaStreamTrack.prototype);
MediaStreamTrackGenerator.prototype.constructor = MediaStreamTrackGenerator;

export { MediaStreamTrackProcessor, MediaStreamTrackGenerator };
