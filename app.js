/* Tineful — kalimba tuner app logic. */
(function () {
  'use strict';

  const P = window.TinefulPitch;
  const $ = (id) => document.getElementById(id);
  const N = 17;
  const CLARITY = 0.75;         // minimum periodicity to trust the start of a note
  const CLARITY_TAIL = 0.6;     // ...and while following a note that is already known
  const TAIL_GATE = 0.4;        // keep following a known note down to 40% of the normal level
  const LINGER_MS = 8000;       // how long the last reading stays up after a note fades
  const BLIP_MS = 120;          // one wobbly reading this short doesn't restart the in-tune count
  // How long a tine must stay in tune before it counts: 0.6 s for the low tines,
  // easing down to 0.3 s for the short, fast-fading high ones (1 kHz and up).
  function holdMs(f) { const t = Math.min(1, Math.max(0, Math.log2(f / 500))); return 600 - 300 * t; }

  /* ---------- tunings ---------- */
  const C_MAJOR = [60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79, 81, 83, 84, 86, 88];
  const PRESETS = [
    { id: 'c', label: 'C major, C4 to E6 (most common)', notes: C_MAJOR, acc: 'sharp' },
    { id: 'g', label: 'G major, F♯ instead of F', notes: C_MAJOR.map((m) => (m % 12 === 5 ? m + 1 : m)), acc: 'sharp' },
    { id: 'f', label: 'F major, B♭ instead of B', notes: C_MAJOR.map((m) => (m % 12 === 11 ? m - 1 : m)), acc: 'flat' },
    { id: 'b', label: 'B major, B3 to D♯6', notes: C_MAJOR.map((m) => m - 1), acc: 'sharp' }
  ];
  const SENS = { low: 0.012, normal: 0.0045, high: 0.0015 };

  const DEFAULTS = {
    preset: 'c', notes: C_MAJOR.slice(), a4: 440, tolerance: 5, autoAdvance: true,
    order: 'pitch', mirror: false, naming: 'letters', accidentals: 'sharp',
    theme: 'auto', sensitivity: 'normal', keepAwake: true, haptics: true
  };

  /* ---------- storage ---------- */
  const KEY_S = 'tineful.settings.v1';
  const KEY_P = 'tineful.progress.v1';
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } }
  };

  const settings = Object.assign({}, DEFAULTS, store.get(KEY_S) || {});
  if (!Array.isArray(settings.notes) || settings.notes.length !== N) settings.notes = C_MAJOR.slice();

  function freshProgress() {
    return { status: Array(N).fill('todo'), cents: Array(N).fill(null), current: null, at: Date.now() };
  }
  let prog = store.get(KEY_P);
  if (!prog || !Array.isArray(prog.status) || prog.status.length !== N || Date.now() - (prog.at || 0) > 12 * 3600e3) {
    prog = freshProgress();
  }
  function saveProgress() { prog.at = Date.now(); store.set(KEY_P, prog); }
  function saveSettings() { store.set(KEY_S, settings); }

  /* ---------- layout & naming ---------- */
  const CENTER = (N - 1) / 2;
  // Tine i is its rank in the standard layout: 0 = center, then alternating outwards.
  function slotOf(i) {
    if (i === 0) return CENTER;
    const k = Math.ceil(i / 2);
    let left = i % 2 === 1;
    if (settings.mirror) left = !left;
    return left ? CENTER - k : CENTER + k;
  }
  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function whereText(i) {
    const s = slotOf(i);
    if (s === CENTER) return 'Center tine';
    const k = Math.abs(s - CENTER), side = s < CENTER ? 'left' : 'right';
    if (k === CENTER) return `Outermost tine on the ${side}`;
    return `${ordinal(k)} tine on the ${side}`;
  }
  const lowerFirst = (t) => t.charAt(0).toLowerCase() + t.slice(1);
  function parts(m) { return P.noteParts(m, settings.naming, settings.accidentals); }
  function noteText(m) { const p = parts(m); return p.name + p.octave; }
  function noteHTML(m) { const p = parts(m); return `${p.name}<small>${p.octave}</small>`; }
  function targetFreq(i) { return P.midiToFreq(settings.notes[i], settings.a4); }

  function sequence() {
    const idx = [...Array(N).keys()];
    if (settings.order === 'ltr') return idx.sort((a, b) => slotOf(a) - slotOf(b));
    if (settings.order === 'rtl') return idx.sort((a, b) => slotOf(b) - slotOf(a));
    return idx.sort((a, b) => settings.notes[a] - settings.notes[b] || a - b);
  }
  function nextTodo(from) {
    const seq = sequence(), k = seq.indexOf(from);
    for (let s = 1; s <= seq.length; s++) {
      const j = seq[(k + s) % seq.length];
      if (prog.status[j] === 'todo') return j;
    }
    return -1;
  }

  /* ---------- runtime state ---------- */
  const S = {
    current: prog.current != null ? prog.current : sequence()[0],
    finished: false,
    listening: false,
    hearing: null,          // { freq, cents, midi }
    recent: [],
    disp: 0,                // smoothed cents for the meter
    inTuneSince: 0,
    outSince: 0,
    last: null,             // the reading from the note that just faded: { ...hearing, i, at }
    lastPitchAt: 0,
    muteUntil: 0,
    playingUntil: 0,
    ignore: null,           // { freq, until } — the tine we just left, still ringing
    celebrate: null,        // { i, until }
    advanceTimer: 0,
    resumeOnShow: false
  };
  if (prog.status.every((s) => s !== 'todo')) S.finished = true;

  /* ---------- audio ---------- */
  const A = { ctx: null, stream: null, src: null, hp: null, analyser: null, buf: null, det: null, noise: 0.001 };

  async function startAudio() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const e = new Error('insecure'); e.name = 'InsecureContext'; throw e;
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 }
    });
    if (!A.ctx) A.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    if (A.ctx.state !== 'running') await A.ctx.resume();
    stopStream();
    A.stream = stream;
    if (!A.analyser) {
      A.hp = A.ctx.createBiquadFilter();
      A.hp.type = 'highpass';
      A.hp.frequency.value = 70;
      A.analyser = A.ctx.createAnalyser();
      A.analyser.fftSize = A.ctx.sampleRate > 60000 ? 8192 : 4096;
      A.analyser.smoothingTimeConstant = 0;
      A.hp.connect(A.analyser);
      A.buf = new Float32Array(A.analyser.fftSize);
      A.det = new P.PitchDetector(A.ctx.sampleRate);
    }
    A.src = A.ctx.createMediaStreamSource(stream);
    A.src.connect(A.hp);
    S.listening = true;
    requestWake();
  }
  function stopStream() {
    if (A.src) { try { A.src.disconnect(); } catch (e) { /* already gone */ } A.src = null; }
    if (A.stream) { A.stream.getTracks().forEach((t) => t.stop()); A.stream = null; }
  }
  function pauseAudio() {
    stopStream();
    S.listening = false;
    dropSignal();
    if (A.ctx && A.ctx.state === 'running') A.ctx.suspend();
  }

  function dropSignal() {
    S.hearing = null;
    S.recent.length = 0;
    S.inTuneSince = 0;
    S.outSince = 0;
  }
  function rememberLast(now) {
    if (S.hearing) S.last = Object.assign({}, S.hearing, { i: S.current, at: now });
  }
  const median = (arr) => { const a = arr.slice().sort((x, y) => x - y); return a[a.length >> 1]; };

  function analyse(now) {
    A.analyser.getFloatTimeDomainData(A.buf);
    if (now < S.muteUntil || S.finished) { dropSignal(); return; }
    const r = A.det.detect(A.buf);
    const periodic = r.freq > 0 && r.clarity >= CLARITY;
    const gate = Math.max(SENS[settings.sensitivity] || SENS.normal, A.noise * 2.5);
    // Once a note is being followed, keep following it into its quiet tail,
    // as long as it is still the same note.
    const following = S.recent.length > 0 && r.freq > 0 && Math.abs(P.cents(r.freq, median(S.recent))) < 35;
    const ok = following
      ? r.clarity >= CLARITY_TAIL && r.rms >= gate * TAIL_GATE
      : periodic && r.rms >= gate;
    if (ok && !isIgnored(r.freq, now)) {
      onPitch(r.freq, now);
    } else {
      if (!periodic) A.noise = Math.min(0.05, A.noise * 0.97 + r.rms * 0.03);
      if (now - S.lastPitchAt > 300) { rememberLast(now); dropSignal(); }
    }
  }
  function isIgnored(f, now) {
    if (!S.ignore) return false;
    if (now > S.ignore.until) { S.ignore = null; return false; }
    return Math.abs(P.cents(f, S.ignore.freq)) < 40;
  }

  function onPitch(f, now) {
    S.lastPitchAt = now;
    const rc = S.recent;
    if (rc.length && Math.abs(P.cents(f, median(rc))) > 35) rc.length = 0;
    rc.push(f);
    if (rc.length > 7) rc.shift();
    if (rc.length < 2) return;
    const fm = median(rc);
    const c = P.cents(fm, targetFreq(S.current));
    const first = !S.hearing;
    S.hearing = { freq: fm, cents: c, midi: Math.round(P.freqToMidi(fm, settings.a4)) };
    if (first) S.disp = Math.max(-60, Math.min(60, c));
    if (Math.abs(c) <= settings.tolerance) {
      S.outSince = 0;
      if (!S.inTuneSince) S.inTuneSince = now;
      if (settings.autoAdvance && !S.celebrate && now - S.inTuneSince >= holdMs(targetFreq(S.current))) markTuned(true);
    } else if (S.inTuneSince) {
      if (!S.outSince) S.outSince = now;
      else if (now - S.outSince > BLIP_MS) { S.inTuneSince = 0; S.outSince = 0; }
    }
  }

  function playReference() {
    try {
      if (!A.ctx) A.ctx = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = A.ctx;
      if (ctx.state !== 'running') ctx.resume();
      const f = targetFreq(S.current), t0 = ctx.currentTime + 0.03, dur = 1.6;
      const env = (peak, attack, decay) => {
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
        g.connect(ctx.destination);
        return g;
      };
      const o1 = ctx.createOscillator(); o1.frequency.value = f; o1.connect(env(0.32, 0.008, dur));
      const o2 = ctx.createOscillator(); o2.frequency.value = f * 5.93; o2.connect(env(0.05, 0.004, 0.25));
      o1.start(t0); o2.start(t0); o1.stop(t0 + dur + 0.05); o2.stop(t0 + 0.3);
      const until = performance.now() + (dur + 0.35) * 1000;
      S.muteUntil = Math.max(S.muteUntil, until);
      S.playingUntil = until;
      dropSignal();
    } catch (e) { /* audio unavailable */ }
  }

  /* ---------- wake lock & haptics ---------- */
  let wakeLock = null;
  async function requestWake() {
    if (!settings.keepAwake || wakeLock || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) { wakeLock = null; }
  }
  function releaseWake() { if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; } }
  function haptic() { if (settings.haptics && navigator.vibrate) { try { navigator.vibrate([16, 60, 24]); } catch (e) { /* ignore */ } } }

  /* ---------- actions ---------- */
  function selectTine(i) {
    clearTimeout(S.advanceTimer);
    S.celebrate = null;
    S.last = null;
    S.current = i;
    S.finished = false;
    prog.current = i;
    dropSignal();
    S.muteUntil = Math.max(S.muteUntil, performance.now() + 200);
    saveProgress();
    renderAll();
  }
  function goNext() {
    const j = nextTodo(S.current);
    if (j < 0) finish(); else selectTine(j);
  }
  function finish() {
    clearTimeout(S.advanceTimer);
    S.celebrate = null;
    S.finished = true;
    S.last = null;
    dropSignal();
    renderAll();
  }
  function markTuned(auto) {
    if (S.finished) return;
    const i = S.current, now = performance.now();
    const reading = currentReading(now);
    prog.status[i] = 'tuned';
    prog.cents[i] = reading ? Math.round(reading.cents * 10) / 10 : null;
    S.last = null;
    saveProgress();
    haptic();
    const wait = auto ? 1000 : 600;
    S.celebrate = { i, until: now + wait };
    S.muteUntil = now + wait + 250;
    S.ignore = { freq: targetFreq(i), until: now + 4500 };
    dropSignal();
    flashTine(i);
    renderBoard();
    clearTimeout(S.advanceTimer);
    S.advanceTimer = setTimeout(() => { S.celebrate = null; goNext(); }, wait);
  }
  function skip() {
    if (S.finished) return;
    if (prog.status[S.current] !== 'tuned') prog.status[S.current] = 'skipped';
    saveProgress();
    goNext();
  }
  function newRound() {
    prog = freshProgress();
    S.last = null;
    S.current = sequence()[0];
    prog.current = S.current;
    S.finished = false;
    saveProgress();
    renderAll();
  }
  function revisitSkipped() {
    prog.status = prog.status.map((s) => (s === 'skipped' ? 'todo' : s));
    const first = sequence().find((j) => prog.status[j] === 'todo');
    saveProgress();
    if (first != null) selectTine(first); else renderAll();
  }

  /* ---------- rendering: board ---------- */
  const tinesEl = $('tines');
  let tineBtns = [];
  function buildTines() {
    tinesEl.innerHTML = '';
    tineBtns = Array(N);
    const fmin = Math.min(...settings.notes.map((m) => P.midiToFreq(m)));
    const bySlot = [...Array(N).keys()].sort((a, b) => slotOf(a) - slotOf(b));
    for (const i of bySlot) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tine';
      const len = Math.max(0.4, Math.sqrt(fmin / P.midiToFreq(settings.notes[i])));
      const p = parts(settings.notes[i]);
      b.innerHTML = `<span class="tine-bar" style="--len:${len.toFixed(3)}"><span class="tl">${p.name}<small>${p.octave}</small></span></span>`;
      b.addEventListener('click', () => selectTine(i));
      tinesEl.appendChild(b);
      tineBtns[i] = b;
    }
    renderBoard();
  }
  function renderBoard(live) {
    for (let i = 0; i < N; i++) {
      const b = tineBtns[i];
      if (!b) continue;
      const st = prog.status[i];
      const cur = !S.finished && i === S.current;
      b.classList.toggle('tuned', st === 'tuned');
      b.classList.toggle('skipped', st === 'skipped');
      b.classList.toggle('current', cur);
      b.classList.toggle('live-low', cur && live === 'low');
      b.classList.toggle('live-high', cur && live === 'high');
      b.classList.toggle('live-good', cur && (live === 'good' || live === 'tuned'));
      const label = `${noteText(settings.notes[i])}, ${lowerFirst(whereText(i))}` +
        (st === 'tuned' ? ', tuned' : st === 'skipped' ? ', skipped' : '') + (cur ? ', selected' : '');
      if (b.getAttribute('aria-label') !== label) b.setAttribute('aria-label', label);
    }
    const tuned = prog.status.filter((s) => s === 'tuned').length;
    setText($('progress'), 'progress', `${tuned} of ${N} tuned`);
  }
  function flashTine(i) {
    const b = tineBtns[i];
    if (!b) return;
    b.classList.remove('just-tuned');
    void b.offsetWidth;
    b.classList.add('just-tuned');
  }

  /* ---------- rendering: tuning card ---------- */
  const cache = {};
  function setText(el, key, val) { if (cache[key] !== val) { cache[key] = val; el.textContent = val; } }
  function setHTML(el, key, val) { if (cache[key] !== val) { cache[key] = val; el.innerHTML = val; } }
  function setAttr(el, key, attr, val) { if (cache[key] !== val) { cache[key] = val; el.setAttribute(attr, val); } }

  const ICONS = {
    pluck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>',
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16"/><path d="M12 20V9M8 12.5 12 8.5l4 4"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16"/><path d="M12 9v11M8 16.5l4 4 4-4"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
    mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>'
  };

  // The reading to show: the live one, or the last pluck's for a while after it fades,
  // so there's time to read the hint before picking up the hammer.
  function currentReading(now) {
    if (S.hearing) return Object.assign({ live: true }, S.hearing);
    const l = S.last;
    if (l && l.i === S.current && S.listening && now - l.at < LINGER_MS && now >= S.playingUntil) {
      return Object.assign({ live: false }, l);
    }
    return null;
  }
  function liveState(now) {
    if (S.celebrate && now < S.celebrate.until) return 'tuned';
    const r = currentReading(now);
    if (!r) return 'idle';
    const a = Math.abs(r.cents);
    if (a <= settings.tolerance) return 'good';
    return r.cents < 0 ? 'low' : 'high';
  }
  function amountWords(a) {
    if (a < 12) return ['A touch', 'a hair'];
    if (a < 35) return ['A little', 'a little'];
    if (a < 100) return ['Quite', 'a bit'];
    return ['Far too', 'a good way'];
  }
  function offsetWords(c) {
    const a = Math.abs(c), dir = c < 0 ? 'low' : 'high';
    if (a >= 100) return `${(a / 100).toFixed(1)} semitones ${dir}`;
    const n = Math.round(a);
    return `${n} ${n === 1 ? 'cent' : 'cents'} ${dir}`;
  }
  function otherTineFor(freq) {
    let best = -1, bestA = 35;
    for (let j = 0; j < N; j++) {
      if (j === S.current) continue;
      const a = Math.abs(P.cents(freq, targetFreq(j)));
      if (a < bestA) { bestA = a; best = j; }
    }
    return best;
  }

  const tuneCard = $('tuneCard');
  const els = {
    where: $('where'), note: $('note'), playLabel: $('playLabel'), offset: $('offset'), hearing: $('hearing'),
    hint: $('hint'), hintIcon: $('hintIcon'), hintTitle: $('hintTitle'), hintText: $('hintText'), suggest: $('suggest'),
    mTine: $('mTine'), mArrow: $('mArrow'), mBand: $('mBand')
  };
  let suggestTarget = -1;

  function renderLive(now) {
    if (S.finished) return;
    const i = S.current;
    const state = liveState(now);
    setAttr(tuneCard, 'state', 'data-state', state);
    renderBoard(state);

    setText(els.where, 'where', whereText(i));
    setHTML(els.note, 'note', noteHTML(settings.notes[i]));
    setText(els.playLabel, 'play', `Play ${noteText(settings.notes[i])}`);

    const h = currentReading(now), tf = targetFreq(i), tol = settings.tolerance;
    const lingering = !!h && !h.live && state !== 'tuned';
    if (cache.lingering !== lingering) { cache.lingering = lingering; tuneCard.classList.toggle('lingering', lingering); }
    // Far off, but matching another tine? Probably the wrong tine was plucked.
    const sj = h && state !== 'tuned' && Math.abs(h.cents) > 70 ? otherTineFor(h.freq) : -1;
    let offset, hearing = '', icon, title, text, clickable = false;
    if (state === 'tuned') {
      offset = 'Tuned';
      icon = 'check'; title = 'Tuned';
      const nx = nextTodo(i);
      text = nx >= 0 ? `Next up: ${noteText(settings.notes[nx])}, ${lowerFirst(whereText(nx))}` : 'That was the last one.';
    } else if (!S.listening) {
      offset = 'Paused';
      icon = 'mic'; title = 'Listening is paused'; text = 'Tap here to listen again'; clickable = true;
    } else if (!h) {
      offset = now < S.playingUntil ? 'Playing' : 'Listening';
      hearing = `Aiming for ${tf.toFixed(1)} Hz`;
      icon = 'pluck'; title = `Pluck the ${lowerFirst(whereText(i))}`; text = 'Let it ring for a moment.';
    } else {
      const a = Math.abs(h.cents);
      hearing = `${h.live ? 'Hearing' : 'Last pluck:'} ${noteText(h.midi)} at ${h.freq.toFixed(1)} Hz`;
      if (sj >= 0) {
        offset = offsetWords(h.cents);
        icon = 'pluck'; title = 'Is that the right tine?';
        text = `That note belongs to another tine. Pluck the ${lowerFirst(whereText(i))}.`;
      } else if (a <= tol) {
        offset = 'In tune';
        icon = 'check';
        if (!settings.autoAdvance) {
          title = 'In tune'; text = 'Tap Mark as tuned to move on.';
        } else if (h.live) {
          title = 'In tune, hold on'; text = 'Let it ring a moment longer.';
        } else {
          title = 'In tune, but it faded quickly'; text = 'Pluck again to confirm it, or tap Mark as tuned.';
        }
      } else {
        offset = offsetWords(h.cents);
        const [adj, amt] = amountWords(a);
        if (h.cents < 0) {
          icon = 'up'; title = `${adj} low`;
          text = `Tap the tip to slide it up ${amt}. Shorter sounds higher.`;
        } else {
          icon = 'down'; title = `${adj} high`;
          text = `Tap the top end to slide it down ${amt}. Longer sounds lower.`;
        }
      }
    }
    setText(els.offset, 'offset', offset);
    setText(els.hearing, 'hearing', hearing);
    setHTML(els.hintIcon, 'icon', ICONS[icon]);
    setText(els.hintTitle, 'title', title);
    setText(els.hintText, 'text', text);
    if (cache.clickable !== clickable) {
      cache.clickable = clickable;
      els.hint.classList.toggle('clickable', clickable);
      els.hint.tabIndex = clickable ? 0 : -1;
    }

    // "That sounds like another tine" suggestion
    if (sj !== suggestTarget) {
      suggestTarget = sj;
      els.suggest.hidden = sj < 0;
      if (sj >= 0) {
        els.suggest.innerHTML = `<b>Sounds like ${noteText(settings.notes[sj])}</b>, the ${lowerFirst(whereText(sj))}. Tap to switch to it.`;
      }
    }

    // meter
    const goal = h && state !== 'tuned' ? Math.max(-60, Math.min(60, h.cents)) : 0;
    S.disp += (goal - S.disp) * (h ? 0.28 : 0.1);
    drawMeter(S.disp, state);
  }

  const MT = { line: 140, x0: 42, x1: 70, max: 60 };
  function centsToPx(c) { const x = Math.min(1, Math.abs(c) / 50); return Math.sign(c) * MT.max * Math.pow(x, 0.75); }
  function layoutBand() {
    const t = Math.max(3, centsToPx(settings.tolerance));
    els.mBand.setAttribute('y', (MT.line - t).toFixed(1));
    els.mBand.setAttribute('height', (2 * t).toFixed(1));
  }
  function drawMeter(c, state) {
    const tip = MT.line - centsToPx(c);   // too low (c < 0) → longer tine → tip further down
    const r = 14, y = (tip - r).toFixed(1);
    setAttr(els.mTine, 'mt', 'd', `M${MT.x0} 12Q${MT.x0} 8 ${MT.x0 + 4} 8H${MT.x1 - 4}Q${MT.x1} 8 ${MT.x1} 12V${y}A${r} ${r} 0 0 1 ${MT.x0} ${y}Z`);
    let d = '';
    if (state === 'low') {
      const y0 = Math.max(tip - 4, MT.line + 22), y1 = MT.line + 7;
      d = `M90 ${y0.toFixed(1)}V${y1}M84 ${y1 + 6}L90 ${y1}L96 ${y1 + 6}`;
    } else if (state === 'high') {
      const y0 = Math.min(tip + 4, MT.line - 22), y1 = MT.line - 7;
      d = `M90 ${y0.toFixed(1)}V${y1}M84 ${y1 - 6}L90 ${y1}L96 ${y1 - 6}`;
    }
    if (d) setAttr(els.mArrow, 'ma', 'd', d);
  }

  function renderAll() {
    const done = S.finished;
    tuneCard.hidden = done;
    $('doneCard').hidden = !done;
    $('actions').hidden = done;
    if (done) {
      const tuned = prog.status.filter((s) => s === 'tuned').length;
      const skipped = prog.status.filter((s) => s === 'skipped').length;
      $('doneTitle').textContent = skipped ? `${tuned} of ${N} tines tuned` : `All ${N} tines tuned`;
      $('doneText').textContent = skipped
        ? `${skipped} ${skipped === 1 ? 'tine was' : 'tines were'} skipped. You can go back to ${skipped === 1 ? 'it' : 'them'} now or start over.`
        : 'Your kalimba is ready to play.';
      $('revisitBtn').hidden = !skipped;
      $('againBtn').className = skipped ? 'btn quiet' : 'btn main';
      renderBoard();
    } else {
      renderLive(performance.now());
    }
  }

  /* ---------- main loop ---------- */
  let lastAnalysis = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    if (S.listening && A.analyser && now - lastAnalysis >= 33) {
      lastAnalysis = now;
      analyse(now);
    }
    renderLive(now);
  }

  /* ---------- start screen ---------- */
  function showStart() {
    const tuned = prog.status.filter((s) => s === 'tuned').length;
    const touched = prog.status.some((s) => s !== 'todo');
    $('startBtn').textContent = touched ? 'Continue tuning' : 'Start tuning';
    $('freshBtn').hidden = !touched;
    if (touched) $('startText').textContent = `You've tuned ${tuned} of ${N} tines so far. Pick up where you left off.`;
    $('start').hidden = false;
  }
  function startError(e) {
    const box = $('startError');
    let msg = 'The microphone could not be started. Close other apps that might be using it, then tap Try again.';
    if (e && e.name === 'NotAllowedError') msg = 'Microphone access is blocked. Allow the microphone for Tineful in your browser or app settings, then tap Try again.';
    else if (e && e.name === 'NotFoundError') msg = 'No microphone was found on this device.';
    else if (e && e.name === 'InsecureContext') msg = 'The microphone only works when Tineful is opened from an https:// address or installed as an app.';
    box.textContent = msg;
    box.hidden = false;
    $('startBtn').textContent = 'Try again';
  }
  async function begin() {
    const btn = $('startBtn');
    btn.disabled = true;
    try {
      await startAudio();
      $('start').hidden = true;
      $('startError').hidden = true;
      renderAll();
    } catch (e) {
      startError(e);
    } finally {
      btn.disabled = false;
    }
  }

  /* ---------- settings sheet ---------- */
  const syncers = [];
  function seg(el, options, key, onSet) {
    el.innerHTML = '';
    for (const [val, label] of options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', () => { onSet ? onSet(val) : update(key, val); });
      b._val = val;
      el.appendChild(b);
    }
    syncers.push(() => el.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b._val === settings[key]))));
  }
  function sw(el, key) {
    el.addEventListener('click', () => update(key, !settings[key]));
    syncers.push(() => el.setAttribute('aria-checked', String(!!settings[key])));
  }
  function syncControls() {
    syncers.forEach((f) => f());
    $('a4Out').textContent = `${settings.a4} Hz`;
    $('preset').value = settings.preset;
    $('layoutHelp').textContent = `The second-lowest note sits just ${settings.mirror ? 'right' : 'left'} of the center tine.`;
  }
  function update(key, val) {
    settings[key] = val;
    saveSettings();
    if (key === 'theme') applyTheme();
    if (key === 'tolerance') layoutBand();
    if (key === 'keepAwake') { if (val) requestWake(); else releaseWake(); }
    if (['notes', 'mirror', 'naming', 'accidentals', 'preset'].includes(key)) { buildTines(); buildNotesList(); }
    syncControls();
    renderAll();
  }
  function applyPreset(id) {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    settings.notes = p.notes.slice();
    settings.accidentals = p.acc;
    update('preset', id);
  }
  function buildPresetSelect() {
    const sel = $('preset');
    sel.innerHTML = PRESETS.map((p) => `<option value="${p.id}">${p.label}</option>`).join('') + '<option value="custom">Custom</option>';
    sel.addEventListener('change', () => { if (sel.value !== 'custom') applyPreset(sel.value); else update('preset', 'custom'); });
  }
  function buildNotesList() {
    const list = $('notesList');
    list.innerHTML = '';
    const order = [...Array(N).keys()].sort((a, b) => slotOf(a) - slotOf(b));
    for (const i of order) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<div class="row-label">${whereText(i)}</div>
        <div class="stepper"><button aria-label="Lower by a semitone">−</button><output>${noteText(settings.notes[i])}</output><button aria-label="Raise by a semitone">+</button></div>`;
      const [dn, up] = row.querySelectorAll('button');
      dn.addEventListener('click', () => changeNote(i, -1));
      up.addEventListener('click', () => changeNote(i, +1));
      list.appendChild(row);
    }
  }
  function changeNote(i, d) {
    const m = settings.notes[i] + d;
    if (m < 36 || m > 100) return;
    settings.notes[i] = m;
    const match = PRESETS.find((p) => p.notes.every((n, k) => n === settings.notes[k]));
    update('preset', match ? match.id : 'custom');
  }

  let sheetOpen = false;
  function openSheet() {
    if (sheetOpen) return;
    sheetOpen = true;
    syncControls();
    $('sheet').classList.add('open');
    $('sheet').setAttribute('aria-hidden', 'false');
    $('backdrop').classList.add('open');
    try { history.pushState({ sheet: 1 }, ''); } catch (e) { /* ignore */ }
    setTimeout(() => $('closeSheet').focus(), 50);
  }
  function closeSheet(fromPop) {
    if (!sheetOpen) return;
    sheetOpen = false;
    $('sheet').classList.remove('open');
    $('sheet').setAttribute('aria-hidden', 'true');
    $('backdrop').classList.remove('open');
    if (!fromPop && history.state && history.state.sheet) history.back();
    $('settingsBtn').focus();
  }

  function applyTheme() {
    const dark = settings.theme === 'dark' || (settings.theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    $('themeColor').setAttribute('content', dark ? '#211A24' : '#F2EEF7');
  }

  let toastTimer = 0;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  /* ---------- wiring ---------- */
  function init() {
    applyTheme();
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

    buildPresetSelect();
    seg($('segLayout'), [[false, 'Standard'], [true, 'Mirrored']], 'mirror');
    seg($('segOrder'), [['pitch', 'Low to high'], ['ltr', 'Left to right'], ['rtl', 'Right to left']], 'order');
    seg($('segTol'), [[3, '±3 cents'], [5, '±5 cents'], [10, '±10 cents']], 'tolerance');
    seg($('segNaming'), [['letters', 'C D E'], ['solfege', 'Do Ré Mi']], 'naming');
    seg($('segAcc'), [['sharp', 'Sharps ♯'], ['flat', 'Flats ♭']], 'accidentals');
    seg($('segTheme'), [['auto', 'Match phone'], ['light', 'Light'], ['dark', 'Dark']], 'theme');
    seg($('segSens'), [['low', 'Low'], ['normal', 'Normal'], ['high', 'High']], 'sensitivity');
    sw($('swAuto'), 'autoAdvance');
    sw($('swAwake'), 'keepAwake');
    sw($('swHaptic'), 'haptics');
    $('a4Down').addEventListener('click', () => update('a4', Math.max(415, settings.a4 - 1)));
    $('a4Up').addEventListener('click', () => update('a4', Math.min(466, settings.a4 + 1)));
    $('resetBtn').addEventListener('click', () => { newRound(); closeSheet(); toast('Progress cleared'); });

    buildTines();
    buildNotesList();
    layoutBand();
    syncControls();

    $('settingsBtn').addEventListener('click', openSheet);
    $('closeSheet').addEventListener('click', () => closeSheet());
    $('backdrop').addEventListener('click', () => closeSheet());
    window.addEventListener('popstate', () => closeSheet(true));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

    $('skipBtn').addEventListener('click', skip);
    $('tunedBtn').addEventListener('click', () => markTuned(false));
    $('playBtn').addEventListener('click', playReference);
    $('hint').addEventListener('click', () => { if (!S.listening) startAudio().then(renderAll).catch(() => { showStart(); }); });
    $('suggest').addEventListener('click', () => { if (suggestTarget >= 0) selectTine(suggestTarget); });
    $('revisitBtn').addEventListener('click', revisitSkipped);
    $('againBtn').addEventListener('click', newRound);
    $('startBtn').addEventListener('click', begin);
    $('freshBtn').addEventListener('click', () => { newRound(); begin(); });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        if (S.listening) { S.resumeOnShow = true; pauseAudio(); }
        releaseWake();
      } else {
        if (S.resumeOnShow) {
          S.resumeOnShow = false;
          startAudio().then(renderAll).catch(() => renderAll());
        } else if (S.listening) requestWake();
      }
    });

    renderAll();
    showStart();
    requestAnimationFrame(frame);

    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      // When a new version takes over: switch straight away if tuning hasn't started yet.
      const hadController = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController) return;
        if (!$('start').hidden) location.reload();
        else toast('Tineful was updated. The new version opens next time.');
      });
      navigator.serviceWorker.register('sw.js').catch(() => { /* offline support unavailable */ });
    }
  }

  // Small hook for automated checks; harmless in normal use.
  window.__tineful = { state: S, progress: () => prog, settings };

  init();
})();
