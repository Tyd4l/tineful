/*
 * Tineful — pitch detection.
 *
 * Two stages:
 *  1. YIN on a decimated copy of the signal gives a robust, octave-correct
 *     coarse estimate plus a "clarity" (periodicity) score.
 *  2. The coarse estimate is refined by searching for the exact peak of the
 *     Hann-windowed spectrum around it. Kalimba tines have strong inharmonic
 *     overtones (~6x the fundamental) that bias time-domain methods by several
 *     cents; the spectral peak of the fundamental is immune to them, which gives
 *     sub-cent precision across the whole C4–E6 range.
 */
(function (root) {
  'use strict';

  function PitchDetector(sampleRate, opts) {
    opts = opts || {};
    this.sr = sampleRate;
    this.minFreq = opts.minFreq || 90;
    this.maxFreq = opts.maxFreq || 2400;
    this.threshold = opts.threshold || 0.12;
    this.dec = sampleRate > 66000 ? 4 : sampleRate > 33000 ? 2 : 1;
    this._n = 0;
  }

  PitchDetector.prototype._alloc = function (n) {
    if (this._n === n) return;
    this._n = n;
    var nd = Math.floor(n / this.dec);
    var srd = this.sr / this.dec;
    this._x = new Float64Array(n);
    this._xd = new Float64Array(nd);
    this._xw = new Float64Array(n);
    this._w = new Float64Array(n);
    for (var i = 0; i < n; i++) this._w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    this._W = Math.floor(nd / 2);
    this._tauMax = Math.min(Math.ceil(srd / this.minFreq), nd - this._W - 2);
    this._tauMin = Math.max(2, Math.floor(srd / this.maxFreq));
    this._d = new Float64Array(this._tauMax + 2);
    this._cm = new Float64Array(this._tauMax + 2);
  };

  /**
   * Analyse one block of samples (most recent last).
   * Returns { freq, clarity, rms } — freq is 0 when no clear pitch is found.
   */
  PitchDetector.prototype.detect = function (buf) {
    var n = buf.length;
    this._alloc(n);
    var x = this._x;
    var mean = 0, i;
    for (i = 0; i < n; i++) mean += buf[i];
    mean /= n;
    var e = 0;
    for (i = 0; i < n; i++) {
      var v = buf[i] - mean;
      x[i] = v;
      e += v * v;
    }
    var rms = Math.sqrt(e / n);
    var out = { freq: 0, clarity: 0, rms: rms };
    if (rms < 1e-5) return out;

    var coarse = this._yin();
    if (!coarse) return out;
    out.clarity = coarse.clarity;
    out.coarse = coarse.freq;
    var f = this._refine(coarse.freq);
    out.freq = f > 0 && Math.abs(Math.log2(f / coarse.freq)) < 0.05 ? f : coarse.freq;
    return out;
  };

  PitchDetector.prototype._yin = function () {
    var D = this.dec, x = this._x, xd = this._xd, nd = xd.length;
    var i, k, t;
    for (i = 0; i < nd; i++) {
      var s0 = 0;
      for (k = 0; k < D; k++) s0 += x[i * D + k];
      xd[i] = s0 / D;
    }
    var W = this._W, tMax = this._tauMax, tMin = this._tauMin, d = this._d, cm = this._cm;
    var off = nd - W - tMax - 1; // compare the most recent samples
    for (t = 1; t <= tMax + 1; t++) {
      var s = 0;
      for (var j = 0; j < W; j++) {
        var v = xd[off + j] - xd[off + j + t];
        s += v * v;
      }
      d[t] = s;
    }
    cm[0] = 1;
    var run = 0;
    for (t = 1; t <= tMax + 1; t++) {
      run += d[t];
      cm[t] = run > 0 ? (d[t] * t) / run : 1;
    }
    var tau = -1;
    for (t = tMin; t <= tMax; t++) {
      if (cm[t] < this.threshold) {
        while (t + 1 <= tMax && cm[t + 1] < cm[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau < 0) {
      var best = Infinity, bt = -1;
      for (t = tMin; t <= tMax; t++) if (cm[t] < best) { best = cm[t]; bt = t; }
      if (best > 0.35) return null;
      tau = bt;
    }
    if (tau <= tMin || tau >= tMax) return null;
    var a = d[tau - 1], b = d[tau], c = d[tau + 1];
    var den = a - 2 * b + c;
    var shift = den > 0 ? (0.5 * (a - c)) / den : 0;
    shift = Math.max(-1, Math.min(1, shift));
    return { freq: this.sr / ((tau + shift) * D), clarity: Math.max(0, 1 - cm[tau]) };
  };

  PitchDetector.prototype._refine = function (fc) {
    var n = this._n, x = this._x, w = this._w, xw = this._xw, sr = this.sr;
    for (var i = 0; i < n; i++) xw[i] = x[i] * w[i];

    function power(f) {
      var om = (2 * Math.PI * f) / sr, c = Math.cos(om), s = Math.sin(om);
      var cr = 1, ci = 0, re = 0, im = 0;
      for (var i = 0; i < n; i++) {
        var v = xw[i];
        re += v * cr;
        im += v * ci;
        var t = cr * c - ci * s;
        ci = cr * s + ci * c;
        cr = t;
      }
      return re * re + im * im;
    }

    var bin = sr / n, span = 2 * bin, steps = 16;
    var bestF = fc, bestP = -1;
    for (var k = 0; k <= steps; k++) {
      var f = fc - span + (2 * span * k) / steps;
      if (f <= 0) continue;
      var p = power(f);
      if (p > bestP) { bestP = p; bestF = f; }
    }
    var step = (2 * span) / steps;
    var lo = bestF - step, hi = bestF + step, g = 0.6180339887498949;
    var m1 = hi - g * (hi - lo), m2 = lo + g * (hi - lo);
    var p1 = power(m1), p2 = power(m2);
    for (var it = 0; it < 16; it++) {
      if (p1 < p2) { lo = m1; m1 = m2; p1 = p2; m2 = lo + g * (hi - lo); p2 = power(m2); }
      else { hi = m2; m2 = m1; p2 = p1; m1 = hi - g * (hi - lo); p1 = power(m1); }
    }
    return (lo + hi) / 2;
  };

  /* ---------- note helpers ---------- */
  var LETTERS = {
    sharp: ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'],
    flat: ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B']
  };
  var SOLFEGE = {
    sharp: ['Do', 'Do♯', 'Ré', 'Ré♯', 'Mi', 'Fa', 'Fa♯', 'Sol', 'Sol♯', 'La', 'La♯', 'Si'],
    flat: ['Do', 'Ré♭', 'Ré', 'Mi♭', 'Mi', 'Fa', 'Sol♭', 'Sol', 'La♭', 'La', 'Si♭', 'Si']
  };

  function midiToFreq(m, a4) { return (a4 || 440) * Math.pow(2, (m - 69) / 12); }
  function freqToMidi(f, a4) { return 69 + 12 * Math.log2(f / (a4 || 440)); }
  function cents(f, ref) { return 1200 * Math.log2(f / ref); }

  /** { name: 'C♯', octave: 4 } — solfège uses the French octave convention (Do3 = C4). */
  function noteParts(m, naming, accidentals) {
    var pc = ((m % 12) + 12) % 12;
    var acc = accidentals === 'flat' ? 'flat' : 'sharp';
    var sci = Math.floor(m / 12) - 1;
    if (naming === 'solfege') return { name: SOLFEGE[acc][pc], octave: sci - 1 };
    return { name: LETTERS[acc][pc], octave: sci };
  }

  var api = {
    PitchDetector: PitchDetector,
    midiToFreq: midiToFreq,
    freqToMidi: freqToMidi,
    cents: cents,
    noteParts: noteParts
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TinefulPitch = api;
})(typeof self !== 'undefined' ? self : this);
