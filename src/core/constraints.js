/**
 * constraints — W3C mediacapture-main constraint handling, shared by
 * getUserMedia and MediaStreamTrack.applyConstraints.
 *
 *   resolveConstraint(value[, opts])  one ConstrainXxx → one value
 *   selectSettings(cs, candidates, props)
 *                                     the spec's SelectSettings: pick a
 *                                     device + settings, or report the
 *                                     constraint that cannot be met
 *   fitnessDistance(cs, cand, props, bareExact)
 *                                     the fitness distance of one
 *                                     constraint set to one candidate
 *   overconstrainedError(name, msg)   OverconstrainedError (DOMException)
 */

import { domException } from './dom_exception.js';

/**
 * Resolve one ConstrainXxx value (a bare value, or {exact|ideal|min|max})
 * to the setting it asks for.
 *
 * Priority: exact > ideal (clamped into [min, max]) > a value in [min, max]
 * > min > max.
 *
 * For a {min, max} pair this returned the midpoint, fractional whenever
 * min + max is odd: width {min:640, max:1281} → 960.5, frameRate
 * {min:24, max:25} → 24.5, sampleRate {min:44100, max:48001} → 46050.5 —
 * invalid GStreamer caps ('width=960.5', 'framerate=24.5/1'), the
 * pipeline refused to start (C10). Now:
 *   opts.preferred  — the value to use when it lies in [min, max] (the
 *                     caller's default / native value), else clamped
 *   opts.integer    — round the result (ConstrainULong members)
 * Without opts, a pair of integer bounds still resolves to an integer.
 */
function resolveConstraint(value, opts) {
  if (value == null) return undefined;
  // Plain primitives — the most common case
  if (typeof value !== 'object') return _round(value, opts);
  // ConstrainXxx object form. An empty list is no constraint (W3C
  // SelectSettings: "If an empty list has been given as the value for a
  // constraint, it MUST be interpreted as if the constraint were not
  // specified"): {exact: []} set the setting to [].
  if ('exact' in value && !_emptyList(value.exact)) return _round(value.exact, opts);
  var hasMin = ('min' in value) && value.min != null;
  var hasMax = ('max' in value) && value.max != null;
  if ('ideal' in value && value.ideal != null && !_emptyList(value.ideal)) {
    var ideal = value.ideal;
    if (typeof ideal === 'number') {
      if (hasMin && ideal < value.min) ideal = value.min;
      if (hasMax && ideal > value.max) ideal = value.max;
    }
    return _round(ideal, opts);
  }
  if (hasMin && hasMax) {
    var lo = value.min, hi = value.max;
    var pref = opts && opts.preferred;
    if (typeof pref === 'number') return _round(Math.min(hi, Math.max(lo, pref)), opts);
    var mid = (lo + hi) / 2;
    if ((opts && opts.integer) || (Number.isInteger(lo) && Number.isInteger(hi))) {
      // Round toward the inside of the range.
      mid = Math.round(mid);
      if (mid > hi) mid = Math.floor(hi);
      if (mid < lo) mid = Math.ceil(lo);
    }
    return mid;
  }
  if (hasMin) return _round(value.min, opts);
  if (hasMax) return _round(value.max, opts);
  return undefined;
}

function _emptyList(v) { return Array.isArray(v) && v.length === 0; }

function _round(v, opts) {
  if (opts && opts.integer && typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  return v;
}

/** W3C OverconstrainedError: a DOMException named 'OverconstrainedError' with .constraint. */
function overconstrainedError(constraint, message) {
  var e = domException(message || ('Constraint not satisfiable: ' + constraint), 'OverconstrainedError');
  try {
    Object.defineProperty(e, 'constraint', { value: constraint, enumerable: true });
  } catch (x) { e.constraint = constraint; }
  return e;
}

// ── SelectSettings ──
//
// props: { name: { type: 'ulong'|'double'|'string'|'boolean', def } }
//   — the constrainable properties this kind of source supports. Constraint
//   names not listed are ignored (spec: unsupported constraints are ignored).
//
// candidates: [{ device, caps }]
//   caps per property: numeric → {min, max}; string → string | string[];
//   boolean → boolean[]. A property absent from caps is not supported by
//   that device (a required constraint on it fails). caps === null means
//   "nothing is known" (no device probe): every constraint is treated as
//   satisfiable, and only the constraint's own bounds limit the setting.

function _isObj(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }

function _num(v) {
  if (v == null) return undefined;
  var n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Normalize one numeric ConstrainXxx into {exact,min,max,ideal}. bareExact: advanced sets. */
function _numSpec(cv, bareExact) {
  if (!_isObj(cv)) {
    var n = _num(cv);
    if (n === undefined) return null;
    return bareExact ? { exact: n } : { ideal: n };
  }
  return { exact: _num(cv.exact), min: _num(cv.min), max: _num(cv.max), ideal: _num(cv.ideal) };
}

/** The [lo, hi] range a numeric constraint + capability allow, or null if empty. */
function _numRange(spec, cap) {
  var lo = -Infinity, hi = Infinity;
  if (cap) {
    if (typeof cap.min === 'number') lo = cap.min;
    if (typeof cap.max === 'number') hi = cap.max;
  }
  if (spec.exact !== undefined) {
    if (spec.exact < lo || spec.exact > hi) return null;
    lo = hi = spec.exact;
  }
  if (spec.min !== undefined) lo = Math.max(lo, spec.min);
  if (spec.max !== undefined) hi = Math.min(hi, spec.max);
  if (lo > hi) return null;
  return [lo, hi];
}

// An empty list is no constraint (see resolveConstraint): it gave
// {exact: []} an infinite distance and {ideal: []} a distance of 1.
function _strList(v) {
  if (v == null || _emptyList(v)) return null;
  return Array.isArray(v) ? v.map(String) : [String(v)];
}

function _strSpec(cv, bareExact) {
  if (!_isObj(cv)) {
    var l = _strList(cv);
    if (!l) return null;
    return bareExact ? { exact: l } : { ideal: l };
  }
  var ex = _strList(cv.exact) || undefined, id = _strList(cv.ideal) || undefined;
  // {exact: []} / {ideal: []} alone: no constraint at all.
  if (ex === undefined && id === undefined && (_emptyList(cv.exact) || _emptyList(cv.ideal))) return null;
  return { exact: ex, ideal: id };
}

function _boolSpec(cv, bareExact) {
  if (!_isObj(cv)) {
    if (typeof cv !== 'boolean') return null;
    return bareExact ? { exact: cv } : { ideal: cv };
  }
  return {
    exact: typeof cv.exact === 'boolean' ? cv.exact : undefined,
    ideal: typeof cv.ideal === 'boolean' ? cv.ideal : undefined,
  };
}

function _isRequired(spec) {
  return spec && (spec.exact !== undefined || spec.min !== undefined || spec.max !== undefined);
}

/**
 * Fitness distance of one constraint against one candidate's capability
 * (spec §"fitness distance"). Infinity = a required part cannot be met.
 * capKnown=false: nothing is known about the device → 0.
 */
function _distance(type, spec, cap, capKnown, matchFn) {
  if (!spec) return 0;
  if (!capKnown) return 0;
  // A device without the property: W3C "If the settings dictionary's
  // constraintName member does not exist, the fitness distance is 1"
  // (infinity when required). It was 0, so a device lacking the property
  // tied with one meeting the ideal exactly, and the first probed won.
  if (cap === undefined) return _isRequired(spec) ? Infinity : 1;

  if (type === 'ulong' || type === 'double') {
    var r = _numRange(spec, cap);
    if (!r) return Infinity;
    if (spec.ideal === undefined) return 0;
    var actual = Math.min(r[1], Math.max(r[0], spec.ideal));
    if (actual === spec.ideal) return 0;
    return Math.abs(actual - spec.ideal) / Math.max(Math.abs(actual), Math.abs(spec.ideal));
  }
  if (type === 'string') {
    var have = _strList(cap) || [];
    // matchFn: a looser, non-standard match (a label substring for
    // deviceId — back-compat for { device: 'Integrated Camera' }); only
    // for ideal / bare values, an exact deviceId must be the deviceId.
    var hit = function (want, loose) {
      for (var i = 0; i < want.length; i++) {
        if (have.indexOf(want[i]) >= 0) return true;
        if (loose && matchFn && matchFn(want[i])) return true;
      }
      return false;
    };
    if (spec.exact && !hit(spec.exact, false)) return Infinity;
    if (spec.ideal && !hit(spec.ideal, true)) return 1;
    return 0;
  }
  if (type === 'boolean') {
    var vals = Array.isArray(cap) ? cap : [cap];
    if (spec.exact !== undefined && vals.indexOf(spec.exact) < 0) return Infinity;
    if (spec.ideal !== undefined && vals.indexOf(spec.ideal) < 0) return 1;
    return 0;
  }
  return 0;
}

function _specFor(type, cv, bareExact) {
  if (type === 'ulong' || type === 'double') return _numSpec(cv, bareExact);
  if (type === 'string') return _strSpec(cv, bareExact);
  if (type === 'boolean') return _boolSpec(cv, bareExact);
  return null;
}

/**
 * Fitness distance of a whole constraint set; { d, failed } where failed
 * lists every constraint name with an infinite distance, in order (the
 * spec's failedConstraint is one that fails for every candidate, so each
 * one is needed, not only the first).
 */
function _setDistance(cs, cand, props, bareExact) {
  var total = 0, failed = [];
  for (var name in cs) {
    if (!Object.prototype.hasOwnProperty.call(cs, name)) continue;
    var p = props[name];
    if (!p) continue;   // unsupported constraint: ignored
    var spec = _specFor(p.type, cs[name], bareExact);
    var capKnown = cand.caps !== null;
    var cap = capKnown ? cand.caps[name] : undefined;
    var d = _distance(p.type, spec, cap, capKnown, p.match ? function (want) { return p.match(cand.device, want); } : null);
    if (d === Infinity) failed.push(name);
    total += d;
  }
  return { d: failed.length ? Infinity : total, failed: failed };
}

/** The fitness distance of constraint set `cs` (no 'advanced') to one candidate. */
function fitnessDistance(cs, cand, props, bareExact) {
  return _setDistance(_isObj(cs) ? cs : {}, cand, props, !!bareExact);
}

/**
 * The spec's SelectSettings. Returns
 *   { candidate, settings }              on success
 *   { failed: '<constraint name>' }      when no candidate satisfies the
 *                                        required constraints (→ reject
 *                                        with OverconstrainedError)
 * settings: one concrete value per numeric/boolean property — the ideal
 * (or bare) value, else the property's default, clamped into what the
 * constraints and the chosen device allow; ULong values are integers.
 */
function selectSettings(cs, candidates, props) {
  cs = _isObj(cs) ? cs : {};
  var basic = {};
  for (var k in cs) {
    if (Object.prototype.hasOwnProperty.call(cs, k) && k !== 'advanced') basic[k] = cs[k];
  }

  // Required constraints of the basic set: drop candidates that fail.
  var feasible = [];
  var failCount = {};
  for (var i = 0; i < candidates.length; i++) {
    var r = _setDistance(basic, candidates[i], props, false);
    if (r.d === Infinity) {
      for (var fi = 0; fi < r.failed.length; fi++) failCount[r.failed[fi]] = (failCount[r.failed[fi]] || 0) + 1;
    } else {
      feasible.push({ cand: candidates[i], d: r.d });
    }
  }
  if (!feasible.length) {
    // W3C ApplyConstraints: "let failedConstraint be any required
    // constraint whose fitness distance was infinity for all settings
    // dictionaries examined while executing the SelectSettings
    // algorithm, or "" if there isn't one". It was the first candidate's
    // first failure when none failed for all — a constraint another
    // candidate met — and counted only each candidate's first failure.
    for (var f in basic) {
      if (Object.prototype.hasOwnProperty.call(basic, f) && failCount[f] === candidates.length) return { failed: f };
    }
    return { failed: '' };
  }

  // Advanced sets, in order: each one that leaves at least one candidate
  // narrows the candidate list; one that leaves none is skipped.
  var applied = [];
  var adv = Array.isArray(cs.advanced) ? cs.advanced : [];
  for (var a = 0; a < adv.length; a++) {
    if (!_isObj(adv[a])) continue;
    var keep = [];
    for (var j = 0; j < feasible.length; j++) {
      if (_setDistance(adv[a], feasible[j].cand, props, true).d !== Infinity) keep.push(feasible[j]);
    }
    if (keep.length) { feasible = keep; applied.push(adv[a]); }
  }

  // Lowest fitness distance of the basic set wins; ties keep probe order.
  var best = feasible[0];
  for (var b = 1; b < feasible.length; b++) if (feasible[b].d < best.d) best = feasible[b];

  return { candidate: best.cand, settings: _settingsFor(basic, applied, best.cand, props) };
}

function _settingsFor(basic, applied, cand, props) {
  var out = {};
  var capKnown = cand.caps !== null;
  for (var name in props) {
    if (!Object.prototype.hasOwnProperty.call(props, name)) continue;
    var p = props[name];
    var cap = capKnown ? cand.caps[name] : undefined;
    var specs = [];
    var s0 = _specFor(p.type, basic[name], false);
    if (s0) specs.push(s0);
    for (var a = 0; a < applied.length; a++) {
      var sa = _specFor(p.type, applied[a][name], true);
      if (sa) specs.push(sa);
    }

    if (p.type === 'ulong' || p.type === 'double') {
      var lo = -Infinity, hi = Infinity, target = undefined;   // (var: reset per property)
      if (cap && typeof cap.min === 'number') lo = cap.min;
      if (cap && typeof cap.max === 'number') hi = cap.max;
      for (var i = 0; i < specs.length; i++) {
        var r = _numRange(specs[i], { min: lo, max: hi });
        if (r) { lo = r[0]; hi = r[1]; }
        if (specs[i].exact !== undefined) target = specs[i].exact;
        else if (specs[i].ideal !== undefined && target === undefined) target = specs[i].ideal;
      }
      if (target === undefined) target = p.def;
      if (target === undefined) continue;
      var v = Math.min(hi, Math.max(lo, target));
      if (p.type === 'ulong') {
        v = Math.round(v);
        if (v > hi) v = Math.floor(hi);
        if (v < lo) v = Math.ceil(lo);
      }
      out[name] = v;
    } else if (p.type === 'boolean') {
      var bv = undefined;
      for (var bi = 0; bi < specs.length; bi++) {
        if (specs[bi].exact !== undefined) bv = specs[bi].exact;
        else if (specs[bi].ideal !== undefined && bv === undefined) bv = specs[bi].ideal;
      }
      if (bv === undefined) bv = p.def;
      if (bv !== undefined) out[name] = bv;
    }
    // string properties (deviceId, groupId, facingMode, ...) come from
    // the chosen device, not from the constraint.
  }
  return out;
}

export { resolveConstraint, selectSettings, fitnessDistance, overconstrainedError };
