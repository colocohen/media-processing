/**
 * dom_exception.js — Shared DOMException factory.
 *
 * Per W3C, several WebCodecs / WebRTC errors should be DOMException
 * instances with named codes ('InvalidStateError', 'NotSupportedError',
 * 'OperationError', etc.). Node 17+ provides DOMException as a global;
 * older Node falls back to a TypeError with a .name property — same
 * try/catch ergonomics, just not strictly the spec-required class.
 *
 * This helper unifies the fallback logic across audio_data.js,
 * video_frame.js, and media_stream.js (was duplicated).
 *
 * @param {string} msg
 * @param {string} [name='InvalidStateError']
 * @returns {DOMException|Error}
 */
export function domException(msg, name) {
  if (typeof DOMException !== 'undefined') {
    return new DOMException(msg, name || 'InvalidStateError');
  }
  // Fallback for environments without DOMException global. Use Error
  // (not TypeError — name confusion would be worse than the type
  // mismatch). Set .name to match what callers check.
  var e = new Error(msg);
  e.name = name || 'InvalidStateError';
  return e;
}
