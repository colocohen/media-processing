/**
 * dom_exception — Shared DOMException factory, isomorphic.
 *
 * Per W3C, several WebCodecs / WebRTC errors should be DOMException
 * instances with named codes ('InvalidStateError', 'NotSupportedError',
 * 'OperationError', etc.). Browsers and Node 17+ provide DOMException
 * as a global; older runtimes fall back to a tagged Error — same
 * try/catch ergonomics, just not strictly the spec-required class.
 *
 * Unifies the fallback logic used across the data classes
 * (audio_data, video_frame, media_stream) that was previously
 * duplicated.
 *
 * @param {string} msg
 * @param {string} [name='InvalidStateError']
 * @returns {DOMException|Error}
 */
export function domException(msg, name) {
  if (typeof DOMException !== 'undefined') {
    return new DOMException(msg, name || 'InvalidStateError');
  }
  // Fallback for environments without a DOMException global. Use Error
  // (not TypeError — name confusion would be worse than the type
  // mismatch). Set .name to match what callers check.
  var e = new Error(msg);
  e.name = name || 'InvalidStateError';
  return e;
}
