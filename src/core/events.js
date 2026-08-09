/**
 * events — Minimal Node-style EventEmitter, isomorphic.
 *
 * Replaces `import { EventEmitter } from 'node:events'` everywhere in
 * the library so the same code runs in the browser bundle. The
 * platform's EventTarget uses addEventListener/Event objects — heavier
 * than the lightweight .on()/.emit() pattern the rest of the library
 * relies on.
 *
 * This is the entire surface we need: subscribe, unsubscribe, fire.
 * Errors thrown by listeners are caught and logged so a single
 * misbehaving subscriber can't break delivery to the others.
 *
 * NOTE — behavioral difference vs Node's EventEmitter:
 *   - Listener exceptions are caught + logged (not rethrown).
 *   - There is no special 'error' event semantics (Node throws on an
 *     unhandled 'error' emit; this does not). Callers that previously
 *     relied on that should call their error callback directly.
 */

function EventEmitter() {
  this._listeners = {};
}

EventEmitter.prototype.on = function (event, fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('EventEmitter.on: listener must be a function');
  }
  if (!this._listeners[event]) this._listeners[event] = [];
  this._listeners[event].push(fn);
  return this;
};

EventEmitter.prototype.off = function (event, fn) {
  var arr = this._listeners[event];
  if (!arr) return this;
  var idx = arr.indexOf(fn);
  if (idx < 0) {
    // once() registers a wrapper, not the caller's function, and tags it
    // with _original so identity can be recovered here. That tag existed
    // and was documented as "preserve identity for off()" — but off()
    // only ever did indexOf(fn), so removing a once() listener before it
    // fired silently did nothing and the listener stayed armed. Node's
    // EventEmitter matches the wrapper by its original; so do we now.
    for (var i = 0; i < arr.length; i++) {
      if (arr[i]._original === fn) { idx = i; break; }
    }
  }
  if (idx >= 0) arr.splice(idx, 1);
  return this;
};

// Node aliases: Node's EventEmitter exposes addListener/removeListener
// as aliases for on/off. Some Node-side consumers (e.g. ffmpeg_process)
// call removeListener directly, so we mirror the full Node surface to
// stay a faithful drop-in.
EventEmitter.prototype.addListener = EventEmitter.prototype.on;
EventEmitter.prototype.removeListener = EventEmitter.prototype.off;

EventEmitter.prototype.once = function (event, fn) {
  var self = this;
  function wrapper() {
    self.off(event, wrapper);
    fn.apply(null, arguments);
  }
  // Preserve identity for off() by exposing the original.
  wrapper._original = fn;
  return this.on(event, wrapper);
};

EventEmitter.prototype.prependListener = function (event, fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('EventEmitter.prependListener: listener must be a function');
  }
  if (!this._listeners[event]) this._listeners[event] = [];
  this._listeners[event].unshift(fn);
  return this;
};

EventEmitter.prototype.emit = function (event /* , ...args */) {
  var arr = this._listeners[event];
  if (!arr || arr.length === 0) return false;

  // Snapshot so listeners can safely off() during iteration.
  var snapshot = arr.slice();
  var args = Array.prototype.slice.call(arguments, 1);

  for (var i = 0; i < snapshot.length; i++) {
    try {
      snapshot[i].apply(null, args);
    } catch (err) {
      // A listener crashing must not prevent others from running.
      if (typeof console !== 'undefined' && console.error) {
        console.error('EventEmitter listener error for "' + event + '":', err);
      }
    }
  }
  return true;
};

EventEmitter.prototype.removeAllListeners = function (event) {
  if (event === undefined) {
    this._listeners = {};
  } else {
    delete this._listeners[event];
  }
  return this;
};

EventEmitter.prototype.listenerCount = function (event) {
  return this._listeners[event] ? this._listeners[event].length : 0;
};

export default EventEmitter;
