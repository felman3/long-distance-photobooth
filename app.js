/* Long Distance Photobooth
 *
 * How it works:
 *  1. The first person to open a booth link becomes the "host" and registers the
 *     booth code with the PeerJS server. The second person finds them by that code.
 *  2. The two browsers connect directly (WebRTC): one call for the live video and
 *     voice, plus one data channel for messages, reactions and photos.
 *  3. The host picks a start time. Both sides run the same countdown against the
 *     host's clock and snap their OWN camera at full quality.
 *  4. Each side sends its photos to the other, and both draw the same strip.
 *
 * A booth code can carry limits: "abcd-efgh-<expiry>-<strips>". The expiry (in
 * minutes since 1970, base 36) and the strip limit are part of the code itself,
 * so changing either one in the link leads to a different, empty booth.
 */
(() => {
  'use strict';

  const CFG = Object.assign(
    { peerOptions: {}, idPrefix: 'ldbooth-', defaultHours: 24, defaultStrips: 10 },
    window.BOOTH_CONFIG || {}
  );
  const $ = (id) => document.getElementById(id);

  // localStorage can throw (private windows, blocked storage), so wrap it.
  const store = {
    get(k, d) {
      try { const v = localStorage.getItem('ldb-' + k); return v === null ? d : v; } catch (e) { return d; }
    },
    set(k, v) {
      try { localStorage.setItem('ldb-' + k, v); } catch (e) { /* ignore */ }
    }
  };

  // Timing of a photo session, in milliseconds.
  const LEAD_MS = 1500;     // "Get ready" before the first countdown
  const BETWEEN_MS = 1500;  // pause between photos
  // Each person's photo is a 3:4 portrait; two of them side by side make one 3:2 picture.
  const SHOT_W = 600;
  const SHOT_H = 800;
  const CHUNK = 12000;      // photos are sent in pieces this many characters long

  const POSES = [2, 3, 4];
  const COUNTS = [3, 5, 10];

  /* ---------- Everything people can pick ---------- */

  const THEMES = [
    { id: 'blush', name: 'Blush', sw: '#FFB3CB', meta: '#FFE9F0' },
    { id: 'lilac', name: 'Lilac', sw: '#C4B1FF', meta: '#F0EAFF' },
    { id: 'mint', name: 'Mint', sw: '#9FE5C7', meta: '#E4F8EF' },
    { id: 'sky', name: 'Sky', sw: '#A9D3FF', meta: '#E6F2FF' },
    { id: 'peach', name: 'Peach', sw: '#FFC2A6', meta: '#FFEEE2' }
  ];

  const PAPERS = [
    { id: 'cream', name: 'Cream', bg: '#FFFAF3', ink: '#4A3B63' },
    { id: 'blush', name: 'Blush', bg: '#FFD6E2', ink: '#4A3B63' },
    { id: 'lilac', name: 'Lilac', bg: '#E2D8FF', ink: '#4A3B63' },
    { id: 'mint', name: 'Mint', bg: '#CFF3E3', ink: '#33483F' },
    { id: 'sky', name: 'Sky', bg: '#D3EAFF', ink: '#34405E' },
    { id: 'butter', name: 'Butter', bg: '#FFF0B8', ink: '#4F4330' },
    { id: 'peach', name: 'Peach', bg: '#FFDCC8', ink: '#4F3A33' },
    { id: 'night', name: 'Night', bg: '#3F3157', ink: '#FFF4F8' }
  ];

  const PATTERNS = [
    { id: 'plain', name: 'Plain' },
    { id: 'dots', name: 'Polka dots' },
    { id: 'stripes', name: 'Stripes' },
    { id: 'checks', name: 'Checks' },
    { id: 'hearts', name: 'Hearts' }
  ];

  const LAYOUTS = [{ id: 'strip', name: 'Strip' }, { id: 'grid', name: 'Grid' }];
  const SHAPES = [{ id: 'square', name: 'Square' }, { id: 'rounded', name: 'Rounded' }];

  const STICKERS = [
    { id: 'none', name: 'None' },
    { id: 'hearts', name: '♥ Hearts' },
    { id: 'stars', name: '★ Stars' },
    { id: 'sparkles', name: '✦ Sparkles' },
    { id: 'mix', name: 'Mix' }
  ];
  const STICKER_COLORS = ['#FF8FB1', '#B79CFF', '#6FD3AD', '#FFC85C', '#7DBDFF', '#FFA585'];

  const FONTS = [
    { id: 'hand', name: 'Handwritten', max: 108, font: (s) => '700 ' + s + 'px Caveat, "Segoe Print", "Bradley Hand", cursive' },
    { id: 'bubble', name: 'Bubbly', max: 80, font: (s) => '400 ' + s + 'px "Bagel Fat One", "Arial Rounded MT Bold", sans-serif' },
    { id: 'clean', name: 'Clean', max: 76, font: (s) => '600 ' + s + 'px Onest, system-ui, sans-serif' }
  ];

  // Colour filters. "css" is the live preview on the video; "m" is the matching
  // colour matrix used on the photos (out = m * [r, g, b] + offset).
  const ID_M = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
  function mul(a, b) { // a after b
    const o = [];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) {
        let v = c === 3 ? a[r * 4 + 3] : 0;
        for (let k = 0; k < 3; k++) v += a[r * 4 + k] * b[k * 4 + c];
        o[r * 4 + c] = v;
      }
    }
    return o;
  }
  const chain = (...ms) => ms.reduce((acc, m) => mul(m, acc), ID_M);
  const sat = (s) => {
    const lr = 0.2126 * (1 - s), lg = 0.7152 * (1 - s), lb = 0.0722 * (1 - s);
    return [lr + s, lg, lb, 0, lr, lg + s, lb, 0, lr, lg, lb + s, 0];
  };
  const con = (c) => { const t = 128 * (1 - c); return [c, 0, 0, t, 0, c, 0, t, 0, 0, c, t]; };
  const tint = (r, g, b, o) => [r, 0, 0, o[0], 0, g, 0, o[1], 0, 0, b, o[2]];
  const SEPIA = [0.393, 0.769, 0.189, 0, 0.349, 0.686, 0.168, 0, 0.272, 0.534, 0.131, 0];

  const FILTERS = [
    { id: 'none', name: 'Original', css: 'none', m: null },
    { id: 'bw', name: 'Black & white', css: 'grayscale(1) contrast(1.12)', m: chain(sat(0), con(1.12)) },
    { id: 'sepia', name: 'Sepia', css: 'sepia(1) contrast(1.05)', m: chain(SEPIA, con(1.05)) },
    { id: 'warm', name: 'Warm', css: 'sepia(.22) saturate(1.25) brightness(1.03)', m: chain(sat(1.15), tint(1.08, 1, 0.86, [8, 4, 0])) },
    { id: 'cool', name: 'Cool', css: 'saturate(.9) hue-rotate(8deg) brightness(1.04)', m: chain(tint(0.92, 1, 1.08, [0, 4, 12]), sat(0.9)) },
    { id: 'soft', name: 'Soft', css: 'contrast(.86) saturate(.75) brightness(1.08)', m: chain(sat(0.75), con(0.86), tint(1, 1, 1, [14, 14, 14])) },
    { id: 'pop', name: 'Pop', css: 'saturate(1.45) contrast(1.1)', m: chain(sat(1.45), con(1.1)) }
  ];

  const REACTIONS = ['❤️', '😂', '😍', '😮', '👏', '🎉'];

  const IDEAS = [
    'Big smiles!', 'Make a heart together', 'Silly faces', 'Look surprised',
    'Point at each other', 'Blow a kiss', 'Peace signs', 'Pretend to high five',
    'Your best serious face', 'Laugh out loud', 'Thumbs up', 'Wink at the camera',
    'Hands on your cheeks', 'Look away dramatically', 'Cheek to the screen',
    'Show your best dance move', 'Pretend to hold hands', 'Make a funny pose',
    'Act like a cat', 'Pretend it\'s really cold'
  ];

  const EXPIRY = [
    { id: '1', name: '1 hour' }, { id: '24', name: '1 day' },
    { id: '168', name: '1 week' }, { id: '0', name: 'No limit' }
  ];
  const LIMITS = [
    { id: '3', name: '3' }, { id: '5', name: '5' }, { id: '10', name: '10' }, { id: '0', name: 'No limit' }
  ];

  /* ---------- State ---------- */

  const views = ['home', 'door', 'booth', 'result', 'left', 'error'];
  const frame = $('frame');
  const vidMe = $('vid-me');
  const vidThem = $('vid-them');
  const cueEl = $('cue');
  const countEl = $('count');
  const ideaEl = $('idea');
  const startBtn = $('start');
  const stripCanvas = $('strip');
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let room = '';
  let booth = { exp: 0, limit: 0 }; // limits that come with the booth code
  let taken = 0;          // strips started in this booth so far
  let localStream = null;
  let peer = null;        // our PeerJS connection to the signalling server
  let conn = null;        // data channel to the other person
  let call = null;        // video and voice call to the other person
  let role = null;        // 'host' (left side) or 'guest' (right side)
  let partnerId = null;
  let connState = '';
  let clockOffset = 0;    // host clock minus our clock (always 0 for the host)
  let bestRtt = Infinity;
  let lastHeard = 0;
  let hbTimer = null;
  let partnerLeft = false;
  let poses = 4;
  let count = 3;          // countdown length in seconds
  let ideasOn = true;     // show a pose idea for each photo
  let session = null;     // the photo session in progress
  let tick = null;
  let startPending = false;
  let result = null;      // photos for the strip on the result screen
  let history = [];       // every strip taken during this visit, newest first
  let closed = false;     // true once we've left the booth
  let micOn = true;
  let speakerOn = true;
  let sfxOn = store.get('sfx', '1') === '1';
  let myName = cleanName(store.get('name', ''));
  let partnerName = '';
  let partnerMic = true;

  const DEFAULT_LOOK = {
    paper: 'cream', pattern: 'plain', layout: 'strip', filter: 'none',
    stickers: 'none', shape: 'square', font: 'hand', caption: '', date: true
  };
  let look = Object.assign({}, DEFAULT_LOOK, cleanLook(safeJson(store.get('look', '{}'))));
  look.caption = '';

  function safeJson(s) { try { return JSON.parse(s) || {}; } catch (e) { return {}; } }

  function cleanName(s) {
    return String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 16);
  }

  /* ---------- Sounds ----------
   * Booth sounds are made on the fly with the Web Audio API, so there are no
   * sound files to load. The same audio context also measures who is talking. */

  let actx = null;

  function audioCtx() {
    if (!actx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) { try { actx = new AC(); } catch (e) { actx = null; } }
    }
    if (actx && actx.state === 'suspended') actx.resume().catch(() => {});
    return actx;
  }

  function tone(freq, dur, opt) {
    const o = Object.assign({ type: 'sine', vol: 0.15, when: 0, slide: 0 }, opt);
    const a = sfxOn && audioCtx();
    if (!a) return;
    const t = a.currentTime + o.when;
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.type = o.type;
    osc.frequency.setValueAtTime(freq, t);
    if (o.slide) osc.frequency.exponentialRampToValueAtTime(freq * o.slide, t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(o.vol, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(a.destination);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  function noise(dur, opt) {
    const o = Object.assign({ vol: 0.3, when: 0, freq: 3000, kind: 'bandpass' }, opt);
    const a = sfxOn && audioCtx();
    if (!a) return;
    const t = a.currentTime + o.when;
    const len = Math.max(1, Math.floor(a.sampleRate * dur));
    const buf = a.createBuffer(1, len, a.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = a.createBufferSource();
    src.buffer = buf;
    const filt = a.createBiquadFilter();
    filt.type = o.kind;
    filt.frequency.value = o.freq;
    const gain = a.createGain();
    gain.gain.setValueAtTime(o.vol, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filt).connect(gain).connect(a.destination);
    src.start(t);
  }

  const SFX = {
    tick: () => tone(660, 0.12, { type: 'triangle', vol: 0.16 }),
    last: () => tone(990, 0.18, { type: 'triangle', vol: 0.2 }),
    shutter: () => {
      noise(0.05, { vol: 0.5, freq: 4200 });
      noise(0.08, { vol: 0.35, freq: 1800, when: 0.07 });
    },
    print: () => {
      for (let i = 0; i < 11; i++) noise(0.09, { vol: 0.1, freq: 700 + (i % 2) * 300, when: i * 0.11, kind: 'lowpass' });
      tone(180, 1.2, { type: 'sawtooth', vol: 0.02 });
    },
    join: () => { tone(523.25, 0.2, { vol: 0.13 }); tone(783.99, 0.3, { vol: 0.13, when: 0.13 }); },
    leave: () => { tone(659.25, 0.2, { vol: 0.11 }); tone(440, 0.32, { vol: 0.11, when: 0.13 }); },
    pop: () => tone(480, 0.13, { vol: 0.1, slide: 2 }),
    tada: () => [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, 0.35, { vol: 0.08, when: i * 0.08 }))
  };

  // Voice level meters, used to light up whoever is talking.
  const meters = { me: null, them: null };

  function meterFor(stream) {
    const a = audioCtx();
    if (!a || !stream || !stream.getAudioTracks().length) return null;
    try {
      const src = a.createMediaStreamSource(stream);
      const an = a.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      return { src, an, buf: new Uint8Array(an.fftSize) };
    } catch (e) {
      return null;
    }
  }

  function dropMeter(key) {
    const m = meters[key];
    meters[key] = null;
    if (m) { try { m.src.disconnect(); } catch (e) { /* ignore */ } }
  }

  function level(m) {
    if (!m) return 0;
    m.an.getByteTimeDomainData(m.buf);
    let sum = 0;
    for (let i = 0; i < m.buf.length; i++) {
      const x = (m.buf[i] - 128) / 128;
      sum += x * x;
    }
    return Math.sqrt(sum / m.buf.length);
  }

  setInterval(() => {
    if ($('view-booth').hidden) return;
    $('half-me').classList.toggle('speaking', micOn && level(meters.me) > 0.04);
    $('half-them').classList.toggle('speaking', speakerOn && level(meters.them) > 0.04);
  }, 120);

  /* ---------- Little helpers ---------- */

  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
  }

  function confetti() {
    if (reduceMotion) return;
    const box = document.createElement('div');
    box.className = 'confetti';
    box.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 46; i++) {
      const p = document.createElement('i');
      p.style.left = (Math.random() * 100) + '%';
      p.style.background = STICKER_COLORS[i % STICKER_COLORS.length];
      p.style.animationDelay = (Math.random() * 0.7) + 's';
      p.style.setProperty('--x', ((Math.random() - 0.5) * 240) + 'px');
      p.style.setProperty('--r', (Math.random() * 900 - 450) + 'deg');
      box.appendChild(p);
    }
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 4200);
  }

  function setRadio(name, value) {
    for (const i of document.querySelectorAll('input[name="' + name + '"]')) i.checked = i.value === String(value);
  }

  function chips(el, name, opts) {
    el.innerHTML = opts.map((o) =>
      '<label><input type="radio" name="' + name + '" value="' + o.id + '"><span>' + o.name + '</span></label>').join('');
  }

  function fmtLeft(ms) {
    const min = Math.max(1, Math.round(ms / 60000));
    if (min < 60) return min + (min === 1 ? ' minute' : ' minutes');
    const h = Math.round(min / 60);
    if (h < 48) return h + (h === 1 ? ' hour' : ' hours');
    return Math.round(h / 24) + ' days';
  }

  /* ---------- Views ---------- */

  function show(name) {
    for (const v of views) $('view-' + v).hidden = v !== name;
    const inBooth = (name === 'booth' || name === 'result') && !closed;
    $('status').hidden = !inBooth;
    $('leave').hidden = !inBooth;
    $('again').hidden = closed;
    if (name === 'booth') {
      vidMe.play().catch(() => {});
      playThem();
    }
    window.scrollTo(0, 0);
  }

  // Leave the booth completely: drop the connection and turn the camera off.
  function shutdown() {
    closed = true;
    clearInterval(hbTimer);
    const p = peer;
    peer = null;
    conn = null;
    call = null;
    partnerId = null;
    try { if (p) p.destroy(); } catch (e) { /* ignore */ }
    if (localStream) localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
    vidThem.srcObject = null;
    dropMeter('me');
    dropMeter('them');
  }

  function fail(title, text, label, action) {
    stopSession();
    shutdown();
    $('error-title').textContent = title;
    $('error-text').textContent = text;
    $('error-action').textContent = label || 'Try again';
    $('error-action').onclick = action || (() => location.reload());
    show('error');
  }

  const SIGNS = { connecting: 'Opening…', waiting: 'Booth open', connected: 'Two in the booth ♥' };

  function setStatus(state) {
    const was = connState;
    connState = state;
    document.body.dataset.conn = state;
    $('status-text').textContent = { connecting: 'Connecting', waiting: 'Waiting', connected: 'Connected' }[state];
    if (!document.body.classList.contains('shooting')) $('sign').textContent = SIGNS[state];

    const connected = state === 'connected';
    $('invite').hidden = connected;
    $('synced').hidden = !connected;
    updateStart();

    $('them-empty-text').textContent =
      connected ? 'Connected. Their video is loading.' :
      state === 'connecting' ? 'Connecting' :
      partnerLeft ? 'The other person left. They can come back with the same link.' :
      'Waiting for the other person';

    if (connected && was !== 'connected') {
      SFX.join();
      toast('You\'re connected. Say hi! 👋');
    }
  }

  function updateStart() {
    const connected = connState === 'connected';
    const out = !canShoot();
    startBtn.textContent = out ? 'No strips left' : connected ? 'Start photos' : 'Take photos alone';
    startBtn.disabled = out || startPending;
    startBtn.classList.toggle('btn-primary', connected && !out);
    startBtn.classList.toggle('btn-quiet', !connected || out);
    updateLimits();
  }

  /* ---------- Booth codes and limits ---------- */

  function newCode(hours, limit) {
    const letters = 'abcdefghjkmnpqrstuvwxyz23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const s = Array.from(bytes, (b) => letters[b % letters.length]).join('');
    const base = s.slice(0, 4) + '-' + s.slice(4);
    hours = Number(hours) || 0;
    limit = Number(limit) || 0;
    if (!hours && !limit) return base;
    const exp = hours ? Math.ceil((Date.now() + hours * 3600000) / 60000).toString(36) : '0';
    return base + '-' + exp + '-' + limit;
  }

  function parseRoom(code) {
    const m = /^[a-z0-9]{4}-[a-z0-9]{4}-([0-9a-z]{1,7})-(\d{1,3})$/.exec(code);
    if (!m) return { exp: 0, limit: 0 };
    return { exp: parseInt(m[1], 36) * 60000, limit: Number(m[2]) };
  }

  function cleanCode(raw) {
    return String(raw || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24);
  }

  function roomLink(code) {
    const u = new URL(location.href);
    u.search = '?room=' + code;
    u.hash = '';
    return u.toString();
  }

  function openNewBooth() {
    location.search = '?room=' + newCode(store.get('hours', String(CFG.defaultHours)), store.get('strips', String(CFG.defaultStrips)));
  }

  const expired = () => !!booth.exp && Date.now() > booth.exp;
  const canShoot = () => !booth.limit || taken < booth.limit;

  function setTaken(n) {
    if (!Number.isInteger(n) || n <= taken) return;
    taken = n;
    store.set('taken-' + room, String(taken));
    updateStart();
  }

  function limitText() {
    const parts = [];
    if (booth.exp) parts.push('link works for ' + fmtLeft(booth.exp - Date.now()) + ' more');
    if (booth.limit) parts.push(Math.max(0, booth.limit - taken) + ' of ' + booth.limit + ' strips left');
    return parts.join(' · ');
  }

  function updateLimits() {
    const el = $('limits');
    const text = limitText();
    el.hidden = !text;
    el.textContent = text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
    el.classList.toggle('out', !canShoot());
  }

  // Close the booth once its link runs out (but let a photo session finish first).
  function checkExpiry() {
    if (closed || !room) return;
    updateLimits();
    if (!expired() || (session && !session.done)) return;
    send({ type: 'bye' });
    const onResult = !$('view-result').hidden;
    stopSession();
    setTimeout(shutdown, 300);
    closed = true;
    if (onResult) {
      show('result');
      toast('This booth\'s link has expired. You can still save your strip.');
    } else {
      fail('This booth has closed', 'Its link has expired. Open a new booth to keep taking photos.', 'Open a new booth', openNewBooth);
    }
  }

  setInterval(checkExpiry, 15000);

  /* ---------- Camera and microphone ---------- */

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const e = new Error('unsupported');
      e.name = 'Unsupported';
      throw e;
    }
    const video = { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } };
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video, audio });
    } catch (err) {
      // The microphone may be blocked or missing. Carry on with video only.
      localStream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      toast('Your microphone is off, so they won\'t hear you. They can still see you.');
    }
    vidMe.srcObject = localStream;
    meters.me = meterFor(localStream);
    setMic(hasMic());
  }

  function cameraErrorText(err) {
    switch (err && err.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'The camera is blocked. Allow camera access for this site in your browser settings, then press the button again.';
      case 'NotFoundError':
      case 'OverconstrainedError':
        return 'No camera was found on this device.';
      case 'NotReadableError':
        return 'Another app is using the camera. Close it, then press the button again.';
      case 'Unsupported':
        return 'This browser can\'t use the camera here. Open the link in Chrome, Safari, Edge or Firefox.';
      default:
        return 'The camera didn\'t start. Press the button to try again.';
    }
  }

  const hasMic = () => !!(localStream && localStream.getAudioTracks().length);

  function setIcon(btn, id) { btn.querySelector('use').setAttribute('href', '#' + id); }

  function setMic(on) {
    micOn = !!on && hasMic();
    if (localStream) localStream.getAudioTracks().forEach((t) => { t.enabled = micOn; });
    const btn = $('mic');
    btn.disabled = !hasMic();
    btn.setAttribute('aria-pressed', String(micOn));
    btn.title = !hasMic() ? 'No microphone' : micOn ? 'Mute microphone (M)' : 'Unmute microphone (M)';
    setIcon(btn, micOn ? 'i-mic' : 'i-mic-off');
    $('tag-me').classList.toggle('muted', !micOn);
    hello();
  }

  function setSpeaker(on) {
    speakerOn = !!on;
    const btn = $('speaker');
    btn.setAttribute('aria-pressed', String(speakerOn));
    btn.title = speakerOn ? 'Mute their voice' : 'Unmute their voice';
    setIcon(btn, speakerOn ? 'i-speaker' : 'i-speaker-off');
    vidThem.muted = !speakerOn;
    if (speakerOn) playThem();
  }

  function setSfx(on) {
    sfxOn = !!on;
    store.set('sfx', sfxOn ? '1' : '0');
    const btn = $('sfx');
    btn.setAttribute('aria-pressed', String(sfxOn));
    btn.title = sfxOn ? 'Turn booth sounds off' : 'Turn booth sounds on';
    setIcon(btn, sfxOn ? 'i-note' : 'i-note-off');
  }

  // Play the other person's video with sound. Browsers sometimes refuse to
  // play sound until the page is tapped, so offer a button for that.
  function playThem() {
    if (!vidThem.srcObject) { $('hear').hidden = true; return; }
    vidThem.muted = !speakerOn;
    vidThem.play().then(() => { $('hear').hidden = true; }).catch(() => {
      if (!speakerOn) return;
      vidThem.muted = true;
      vidThem.play().catch(() => {});
      $('hear').hidden = false;
    });
  }

  /* ---------- Connecting the two browsers ---------- */

  const hostId = () => CFG.idPrefix + room;
  const isConnected = () => !!(conn && conn.open);

  function send(msg) {
    if (isConnected()) {
      try { conn.send(msg); } catch (e) { console.warn('send failed', e); }
    }
  }

  function hello() { send({ type: 'hello', name: myName, mic: micOn, taken }); }
  function sendSettings() { send({ type: 'settings', poses, count, ideas: ideasOn }); }
  function sendLook() { send(Object.assign({ type: 'look' }, look)); }

  // Time on the host's clock, which both sides use for the countdown.
  const hostNow = () => Date.now() + clockOffset;

  function applyRole() {
    frame.classList.toggle('is-guest', role === 'guest');
  }

  function peerError(err) {
    console.warn('peer error', err && err.type, err);
    if (isConnected()) return; // the two browsers are already linked; the server is no longer needed
    const type = err && err.type;
    if (type === 'browser-incompatible') {
      fail('This browser can\'t run the booth', 'Open the link in a recent version of Chrome, Safari, Edge or Firefox.');
    } else if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') {
      fail('Can\'t reach the connection service', 'Check your internet connection, then try again.');
    }
  }

  // Ask for their voice and video even if we have no microphone ourselves.
  const CALL_OPTS = { constraints: { offerToReceiveAudio: true, offerToReceiveVideo: true } };

  // First try to be the host. If the booth code is already taken, someone is
  // in there, so join them as the guest instead.
  function tryHost(attempt) {
    if (closed) return;
    setStatus('connecting');
    const p = new Peer(hostId(), CFG.peerOptions);
    peer = p;
    let opened = false;

    p.on('open', () => {
      opened = true;
      role = 'host';
      clockOffset = 0;
      applyRole();
      setStatus('waiting');
    });
    p.on('connection', (c) => {
      if (partnerId && partnerId !== c.peer) {
        // A third person: tell them the booth is full.
        c.on('open', () => {
          try { c.send({ type: 'full' }); } catch (e) { /* ignore */ }
          setTimeout(() => c.close(), 500);
        });
        return;
      }
      partnerId = c.peer;
      wireConn(c);
      setTimeout(() => {
        if (conn === c && !c.open) { conn = null; partnerId = null; }
      }, 15000);
    });
    p.on('call', (m) => {
      if (partnerId && partnerId !== m.peer) { m.close(); return; }
      partnerId = m.peer;
      m.answer(localStream);
      wireCall(m);
    });
    p.on('disconnected', () => {
      // Lost the signalling server (not the other person). Quietly reconnect.
      setTimeout(() => { if (opened && peer === p && !p.destroyed) p.reconnect(); }, 1500);
    });
    p.on('error', (err) => {
      if (err.type === 'unavailable-id' && !opened) {
        if (peer === p) peer = null;
        try { p.destroy(); } catch (e) { /* ignore */ }
        tryGuest(attempt);
        return;
      }
      if (peer === p) peerError(err);
    });
  }

  function tryGuest(attempt) {
    if (closed) return;
    const p = new Peer(undefined, CFG.peerOptions);
    peer = p;
    let opened = false;
    let gaveUp = false;

    p.on('open', () => {
      opened = true;
      role = 'guest';
      bestRtt = Infinity;
      applyRole();
      wireConn(p.connect(hostId(), { reliable: true, serialization: 'json' }));
      wireCall(p.call(hostId(), localStream, CALL_OPTS));
      setTimeout(() => {
        if (peer === p && !isConnected() && !gaveUp) {
          fail('Couldn\'t connect to the other person',
            'One of your networks may be blocking a direct connection. Switch to different Wi-Fi or mobile data, then open the link again.');
        }
      }, 20000);
    });
    p.on('disconnected', () => {
      setTimeout(() => { if (opened && peer === p && !p.destroyed) p.reconnect(); }, 1500);
    });
    p.on('error', (err) => {
      if (err.type === 'peer-unavailable') {
        // The host isn't there any more. Take over the booth ourselves.
        if (gaveUp) return;
        gaveUp = true;
        if (peer === p) peer = null;
        conn = null; call = null;
        try { p.destroy(); } catch (e) { /* ignore */ }
        if (attempt < 3) setTimeout(() => tryHost(attempt + 1), 1200);
        else fail('Couldn\'t get into the booth', 'Check your internet connection, then try again.');
        return;
      }
      if (peer === p) peerError(err);
    });
  }

  function wireConn(c) {
    conn = c;
    c.on('open', () => {
      if (conn !== c) return;
      lastHeard = Date.now();
      partnerLeft = false;
      setStatus('connected');
      clearInterval(hbTimer);
      hbTimer = setInterval(heartbeat, 2000);
      hello();
      if (role === 'guest') {
        // Measure the difference between the two device clocks a few times.
        for (let i = 0; i < 5; i++) setTimeout(() => send({ type: 'ping', t: Date.now() }), i * 250);
      } else {
        sendSettings();
        sendLook();
      }
    });
    c.on('data', onData);
    c.on('close', () => { if (conn === c) partnerGone(); });
    c.on('error', (e) => console.warn('connection error', e));
  }

  function wireCall(m) {
    call = m;
    m.on('stream', (stream) => {
      if (call !== m) return;
      if (vidThem.srcObject !== stream) {
        vidThem.srcObject = stream;
        dropMeter('them');
        meters.them = meterFor(stream);
      }
      playThem();
      frame.classList.add('has-them');
    });
    m.on('close', () => {
      if (call !== m) return;
      vidThem.srcObject = null;
      $('hear').hidden = true;
      dropMeter('them');
      frame.classList.remove('has-them');
    });
    m.on('error', (e) => console.warn('call error', e));
  }

  function heartbeat() {
    if (!isConnected()) return;
    if (Date.now() - lastHeard > 12000) { partnerGone(); return; }
    send(role === 'guest' ? { type: 'ping', t: Date.now() } : { type: 'hb' });
  }

  function partnerGone() {
    if (closed) return;
    const c = conn;
    const m = call;
    const wasGuest = role === 'guest';
    const who = partnerName || 'The other person';
    conn = null;
    call = null;
    partnerId = null;
    partnerLeft = true;
    clearInterval(hbTimer);
    try { if (c) c.close(); } catch (e) { /* ignore */ }
    try { if (m) m.close(); } catch (e) { /* ignore */ }
    vidThem.srcObject = null;
    $('hear').hidden = true;
    dropMeter('them');
    frame.classList.remove('has-them');
    setPartner('', true);
    SFX.leave();
    toast(who + ' left the booth');

    if (wasGuest) {
      // The host left. Take over the booth so they can rejoin with the same link.
      const p = peer;
      peer = null;
      try { if (p) p.destroy(); } catch (e) { /* ignore */ }
      setStatus('connecting');
      setTimeout(() => { if (!peer) tryHost(0); }, 900);
    } else {
      setStatus('waiting');
    }
  }

  function setPartner(name, mic) {
    partnerName = name;
    partnerMic = mic;
    $('name-them').textContent = partnerName || 'Them';
    $('tag-them').classList.toggle('muted', !partnerMic);
  }

  let reactTimes = [];

  function onData(d) {
    if (!d || typeof d !== 'object') return;
    lastHeard = Date.now();
    switch (d.type) {
      case 'ping':
        send({ type: 'pong', t: d.t, h: Date.now() });
        break;
      case 'pong': {
        const now = Date.now();
        const rtt = now - d.t;
        if (Number.isFinite(rtt) && Number.isFinite(d.h) && rtt >= 0 && rtt <= bestRtt) {
          bestRtt = rtt;
          clockOffset = d.h - (d.t + rtt / 2);
        }
        bestRtt *= 1.05; // let newer measurements replace old ones over time
        break;
      }
      case 'full':
        fail('This booth already has two people', 'Open a new booth and send that link instead.', 'Open a new booth', openNewBooth);
        break;
      case 'bye':
        partnerGone();
        break;
      case 'hello':
        setPartner(cleanName(d.name), d.mic !== false);
        if (Number.isInteger(d.taken)) setTaken(d.taken);
        break;
      case 'settings':
        applySettings(d);
        break;
      case 'look':
        Object.assign(look, cleanLook(d));
        lookToUI();
        if (!$('view-result').hidden) drawStrip(false);
        break;
      case 'react': {
        // At most a few per second, so a stuck button can't flood the screen.
        const now = Date.now();
        reactTimes = reactTimes.filter((t) => now - t < 1000);
        if (reactTimes.length >= 6 || !REACTIONS.includes(d.e)) break;
        reactTimes.push(now);
        floatReaction(d.e, false);
        break;
      }
      case 'please-start':
        if (role === 'host' && !(session && !session.done)) {
          applySettings(d);
          begin();
        }
        break;
      case 'start':
        if (role === 'guest') runSession(d);
        break;
      case 'photo':
        receivePhotoPiece(d);
        break;
      default:
        break;
    }
  }

  /* ---------- Settings, reactions ---------- */

  function applySettings(d) {
    if (POSES.includes(d.poses)) poses = d.poses;
    if (COUNTS.includes(d.count)) count = d.count;
    if (typeof d.ideas === 'boolean') ideasOn = d.ideas;
    setRadio('poses', poses);
    setRadio('count', count);
    $('ideas').checked = ideasOn;
  }

  function floatReaction(e, mine) {
    const layer = $('reactions');
    if (layer.childElementCount > 24) return;
    const hostSide = role !== 'guest';
    const onLeft = mine ? hostSide : !hostSide;
    const el = document.createElement('span');
    el.className = 'float-react';
    el.textContent = e;
    el.style.left = ((onLeft ? 6 : 56) + Math.random() * 32) + '%';
    el.style.setProperty('--drift', ((Math.random() - 0.5) * 6) + 'rem');
    el.addEventListener('animationend', () => el.remove());
    setTimeout(() => el.remove(), 3000);
    layer.appendChild(el);
    SFX.pop();
  }

  /* ---------- Taking the photos ---------- */

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function begin() {
    if (session && !session.done) return;
    if (!canShoot()) { toast('This booth has used all of its strips. Open a new booth for more.'); return; }
    const msg = {
      type: 'start',
      sid: Math.random().toString(36).slice(2, 10),
      t0: hostNow() + LEAD_MS,
      poses,
      count,
      ideas: ideasOn ? shuffle(IDEAS.map((_, i) => i)).slice(0, poses) : null,
      n: taken + 1
    };
    send(msg);
    runSession(msg);
  }

  const shotTime = (s, k) => s.t0 + s.countMs + k * (s.countMs + BETWEEN_MS);

  function runSession(m) {
    if (!m || !Number.isFinite(m.t0) || !POSES.includes(m.poses)) return;
    const c = COUNTS.includes(m.count) ? m.count : 3;
    const ideas = Array.isArray(m.ideas) && m.ideas.length === m.poses &&
      m.ideas.every((i) => Number.isInteger(i) && i >= 0 && i < IDEAS.length) ? m.ideas : null;
    stopSession();
    applySettings({ poses: m.poses, count: c });
    if (Number.isInteger(m.n)) setTaken(m.n);
    session = {
      sid: String(m.sid),
      t0: m.t0,
      poses: m.poses,
      countMs: c * 1000,
      ideas,
      k: 0,
      lastN: 0,
      mine: [],
      theirs: [],
      pieces: {},
      solo: !isConnected(),
      done: false
    };
    show('booth');
    document.body.classList.add('shooting');
    $('sign').textContent = 'Smile!';
    $('dots').innerHTML = '<i></i>'.repeat(m.poses);
    tick = setInterval(step, 40);
    step();
  }

  function stopSession() {
    clearInterval(tick);
    tick = null;
    if (session) session.done = true;
    document.body.classList.remove('shooting');
    cueEl.textContent = '';
    countEl.textContent = '';
    ideaEl.textContent = '';
    if (connState) $('sign').textContent = SIGNS[connState];
  }

  function step() {
    const s = session;
    if (!s || s.done) return;
    const remaining = shotTime(s, s.k) - hostNow();

    if (remaining <= 0) {
      capture(s, s.k);
      s.k += 1;
      s.lastN = 0;
      countEl.textContent = '';
      if (s.k >= s.poses) {
        clearInterval(tick);
        tick = null;
        ideaEl.textContent = '';
        develop(s);
      }
      return;
    }

    setText(ideaEl, s.ideas ? IDEAS[s.ideas[s.k]] : '');
    if (remaining > s.countMs) {
      countEl.textContent = '';
      setText(cueEl, s.k === 0 ? 'Get ready' : 'Next pose');
    } else {
      const n = Math.ceil(remaining / 1000);
      if (n !== s.lastN) {
        s.lastN = n;
        countEl.textContent = String(n);
        countEl.classList.remove('pop');
        void countEl.offsetWidth; // restart the animation
        countEl.classList.add('pop');
        if (n === 1) SFX.last(); else SFX.tick();
      }
      setText(cueEl, 'Photo ' + (s.k + 1) + ' of ' + s.poses);
    }
  }

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  // Snap our own camera, mirrored like the preview, cropped to a 3:4 portrait.
  function capture(s, k) {
    const c = document.createElement('canvas');
    c.width = SHOT_W;
    c.height = SHOT_H;
    const g = c.getContext('2d');
    const vw = vidMe.videoWidth;
    const vh = vidMe.videoHeight;
    g.fillStyle = '#D9CCFF';
    g.fillRect(0, 0, SHOT_W, SHOT_H);
    if (vw && vh) {
      const scale = Math.max(SHOT_W / vw, SHOT_H / vh);
      const dw = vw * scale;
      const dh = vh * scale;
      g.translate(SHOT_W, 0);
      g.scale(-1, 1);
      g.drawImage(vidMe, (SHOT_W - dw) / 2, (SHOT_H - dh) / 2, dw, dh);
    }
    const url = c.toDataURL('image/jpeg', 0.86);
    s.mine[k] = url;

    SFX.shutter();
    const flash = $('flash');
    flash.classList.remove('go');
    void flash.offsetWidth; // restart the animation
    flash.classList.add('go');
    const dot = $('dots').children[k];
    if (dot) dot.classList.add('done');

    if (!s.solo) {
      const n = Math.ceil(url.length / CHUNK);
      for (let i = 0; i < n; i++) {
        send({ type: 'photo', sid: s.sid, k, i, n, d: url.slice(i * CHUNK, (i + 1) * CHUNK) });
      }
    }
  }

  function receivePhotoPiece(d) {
    const s = session;
    if (!s || d.sid !== s.sid) return;
    const { k, i, n } = d;
    if (!Number.isInteger(k) || k < 0 || k >= s.poses) return;
    if (!Number.isInteger(n) || n < 1 || n > 200) return;
    if (!Number.isInteger(i) || i < 0 || i >= n || typeof d.d !== 'string') return;
    const parts = s.pieces[k] || (s.pieces[k] = new Array(n).fill(null));
    if (parts.length !== n) return;
    parts[i] = d.d;
    if (parts.every((p) => p !== null)) {
      const url = parts.join('');
      if (url.startsWith('data:image/jpeg;base64,')) s.theirs[k] = url;
      delete s.pieces[k];
    }
  }

  // Wait briefly for the other person's photos to arrive, then make the strip.
  function develop(s) {
    setText(cueEl, 'Printing your strip');
    $('sign').textContent = 'Printing…';
    const deadline = Date.now() + 8000;
    const wait = setInterval(() => {
      if (session !== s) { clearInterval(wait); return; }
      const got = s.theirs.filter(Boolean).length;
      if (s.solo || got === s.poses || Date.now() > deadline || !isConnected()) {
        clearInterval(wait);
        finish(s);
      }
    }, 100);
  }

  function finish(s) {
    s.done = true;
    document.body.classList.remove('shooting');
    cueEl.textContent = '';
    if (connState) $('sign').textContent = SIGNS[connState];
    $('dots').innerHTML = '';
    const haveTheirs = s.theirs.some(Boolean);
    const mineLeft = role !== 'guest';
    result = {
      seed: s.sid,
      rows: s.poses,
      solo: !haveTheirs,
      left: !haveTheirs ? s.mine : (mineLeft ? s.mine : s.theirs),
      right: !haveTheirs ? [] : (mineLeft ? s.theirs : s.mine),
      images: null,
      filtered: {}
    };
    history.unshift(result);
    if (history.length > 8) history.pop();
    showResult(true);
    SFX.print();
    setTimeout(() => { SFX.tada(); confetti(); }, 1250);
  }

  function showResult(animate) {
    $('view-result').classList.toggle('solo-strip', result.solo);
    renderGallery();
    show('result');
    drawStrip(animate);
  }

  function renderGallery() {
    const row = $('gallery');
    $('gallery-wrap').hidden = history.length < 2;
    row.innerHTML = '';
    history.forEach((r, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.title = 'Strip ' + (history.length - i);
      b.setAttribute('aria-label', 'Show strip ' + (history.length - i));
      if (r === result) b.setAttribute('aria-current', 'true');
      const im = document.createElement('img');
      im.alt = '';
      im.src = r.left[0] || '';
      b.appendChild(im);
      b.addEventListener('click', () => { result = r; showResult(true); });
      row.appendChild(b);
    });
  }

  /* ---------- The strip ---------- */

  function cleanLook(d) {
    const o = {};
    if (!d || typeof d !== 'object') return o;
    const pick = (key, list) => { if (list.some((x) => x.id === d[key])) o[key] = d[key]; };
    if (typeof d.paper === 'string' && (PAPERS.some((p) => p.id === d.paper) || /^#[0-9a-f]{6}$/i.test(d.paper))) {
      o.paper = d.paper.toLowerCase();
    }
    pick('pattern', PATTERNS);
    pick('layout', LAYOUTS);
    pick('filter', FILTERS);
    pick('stickers', STICKERS);
    pick('shape', SHAPES);
    pick('font', FONTS);
    if (typeof d.caption === 'string') o.caption = d.caption.replace(/[\u0000-\u001f]/g, '').slice(0, 28);
    if (typeof d.date === 'boolean') o.date = d.date;
    return o;
  }

  function paperOf(id) {
    const p = PAPERS.find((x) => x.id === id);
    if (p) return p;
    const n = parseInt(id.slice(1), 16);
    const lum = 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
    return { bg: id, ink: lum > 140 ? '#4A3B63' : '#FFF4F8' };
  }

  const filterOf = (id) => FILTERS.find((f) => f.id === id) || FILTERS[0];

  function loadImage(url) {
    return new Promise((resolve) => {
      if (!url) { resolve(null); return; }
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => resolve(null);
      im.src = url;
    });
  }

  function applyMatrix(a, m) {
    for (let i = 0; i < a.length; i += 4) {
      const r = a[i], g = a[i + 1], b = a[i + 2];
      a[i] = m[0] * r + m[1] * g + m[2] * b + m[3];
      a[i + 1] = m[4] * r + m[5] * g + m[6] * b + m[7];
      a[i + 2] = m[8] * r + m[9] * g + m[10] * b + m[11];
    }
  }

  // Photos with the chosen filter applied, worked out once per filter.
  function filteredImages(r, f) {
    if (r.filtered[f.id]) return r.filtered[f.id];
    const conv = (im) => {
      if (!im || !f.m) return im;
      const c = document.createElement('canvas');
      c.width = im.naturalWidth;
      c.height = im.naturalHeight;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(im, 0, 0);
      const px = g.getImageData(0, 0, c.width, c.height);
      applyMatrix(px.data, f.m);
      g.putImageData(px, 0, 0);
      return c;
    };
    r.filtered[f.id] = { left: r.images.left.map(conv), right: r.images.right.map(conv) };
    return r.filtered[f.id];
  }

  function rng(seed) {
    let h = 1779033703 ^ seed.length;
    for (let i = 0; i < seed.length; i++) {
      h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    let a = h >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function heartPath(g, s) {
    g.beginPath();
    g.moveTo(0, s * 0.9);
    g.bezierCurveTo(-s * 1.4, 0, -s * 0.7, -s * 1.1, 0, -s * 0.4);
    g.bezierCurveTo(s * 0.7, -s * 1.1, s * 1.4, 0, 0, s * 0.9);
    g.closePath();
  }

  function starPath(g, s) {
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? s * 0.45 : s;
      const a = -Math.PI / 2 + i * Math.PI / 5;
      g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    g.closePath();
  }

  function sparklePath(g, s) {
    g.beginPath();
    g.moveTo(0, -s);
    g.quadraticCurveTo(s * 0.15, -s * 0.15, s, 0);
    g.quadraticCurveTo(s * 0.15, s * 0.15, 0, s);
    g.quadraticCurveTo(-s * 0.15, s * 0.15, -s, 0);
    g.quadraticCurveTo(-s * 0.15, -s * 0.15, 0, -s);
    g.closePath();
  }

  const SHAPE_PATHS = { heart: heartPath, star: starPath, sparkle: sparklePath };

  function drawSticker(g, kind, x, y, s, color, rot) {
    g.save();
    g.translate(x, y);
    g.rotate(rot);
    SHAPE_PATHS[kind](g, s);
    g.lineJoin = 'round';
    g.lineWidth = s * 0.28;
    g.strokeStyle = '#fff';
    g.shadowColor = 'rgba(63, 49, 87, .28)';
    g.shadowBlur = s * 0.3;
    g.shadowOffsetY = s * 0.08;
    g.stroke();
    g.shadowColor = 'transparent';
    g.fillStyle = color;
    g.fill();
    g.restore();
  }

  function drawPattern(g, W, H, kind, ink) {
    if (kind === 'plain') return;
    g.save();
    g.fillStyle = ink;
    g.globalAlpha = 0.08;
    if (kind === 'dots') {
      const s = 44;
      for (let y = 0, row = 0; y < H + s; y += s, row++) {
        for (let x = row % 2 ? s / 2 : 0; x < W + s; x += s) {
          g.beginPath();
          g.arc(x, y, 7, 0, Math.PI * 2);
          g.fill();
        }
      }
    } else if (kind === 'stripes') {
      for (let x = -H; x < W; x += 56) {
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x + 22, 0);
        g.lineTo(x + 22 + H, H);
        g.lineTo(x + H, H);
        g.closePath();
        g.fill();
      }
    } else if (kind === 'checks') {
      const s = 40;
      for (let y = 0, row = 0; y < H; y += s, row++) {
        for (let x = (row % 2) * s; x < W; x += s * 2) g.fillRect(x, y, s, s);
      }
    } else if (kind === 'hearts') {
      const s = 80;
      for (let y = s / 2, row = 0; y < H + s; y += s, row++) {
        for (let x = row % 2 ? s : s / 2; x < W + s; x += s) {
          g.save();
          g.translate(x, y);
          g.rotate(row % 2 ? 0.2 : -0.2);
          heartPath(g, 14);
          g.fill();
          g.restore();
        }
      }
    }
    g.restore();
  }

  let drawToken = 0;

  async function drawStrip(animate) {
    const r = result;
    if (!r) return;
    const token = ++drawToken;

    if (!r.images) {
      r.images = {
        left: await Promise.all(Array.from({ length: r.rows }, (_, k) => loadImage(r.left[k]))),
        right: r.solo ? [] : await Promise.all(Array.from({ length: r.rows }, (_, k) => loadImage(r.right[k])))
      };
    }
    try {
      await Promise.all([
        document.fonts.load('700 100px Caveat'),
        document.fonts.load('500 30px Onest'),
        document.fonts.load('400 60px "Bagel Fat One"')
      ]);
    } catch (e) { /* fall back to system fonts */ }
    if (token !== drawToken || r !== result) return;

    const paper = paperOf(look.paper);
    const imgs = filteredImages(r, filterOf(look.filter));
    const font = FONTS.find((f) => f.id === look.font) || FONTS[0];
    const caption = look.caption.trim();
    const hasText = !!caption || look.date;

    const CW = 540, CH = 720, M = 48, GAP = 20;
    const FOOT = hasText ? 200 : 70;
    const cellW = CW * (r.solo ? 1 : 2);
    const gc = look.layout === 'grid' ? 2 : 1;
    const gr = Math.ceil(r.rows / gc);
    const W = M * 2 + gc * cellW + (gc - 1) * GAP;
    const H = M + gr * CH + (gr - 1) * GAP + FOOT;
    const cv = stripCanvas;
    cv.width = W;
    cv.height = H;
    const g = cv.getContext('2d');

    g.fillStyle = paper.bg;
    g.fillRect(0, 0, W, H);
    drawPattern(g, W, H, look.pattern, paper.ink);

    const cells = [];
    for (let k = 0; k < r.rows; k++) {
      const row = Math.floor(k / gc);
      const inRow = Math.min(gc, r.rows - row * gc);
      const col = k % gc;
      const x = M + col * (cellW + GAP) + (gc - inRow) * (cellW + GAP) / 2;
      const y = M + row * (CH + GAP);
      cells.push({ x, y, w: cellW, h: CH });

      g.save();
      if (look.shape === 'rounded') {
        roundRect(g, x, y, cellW, CH, 40);
        g.clip();
      }
      g.fillStyle = 'rgba(128, 128, 128, .3)';
      g.fillRect(x, y, cellW, CH);
      const l = imgs.left[k];
      if (l) g.drawImage(l, x, y, CW, CH);
      const rt = imgs.right[k];
      if (rt) g.drawImage(rt, x + CW, y, CW, CH);
      g.restore();
    }

    // Caption and date in the space at the bottom.
    const footTop = H - FOOT;
    const date = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
    const textW = W - M * 2 - (look.stickers !== 'none' ? 200 : 0);
    g.fillStyle = paper.ink;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    if (caption) {
      let size = font.max;
      do {
        g.font = font.font(size);
        size -= 4;
      } while (g.measureText(caption).width > textW && size > 24);
      g.fillText(caption, W / 2, footTop + FOOT * (look.date ? 0.4 : 0.5));
    }
    if (look.date) {
      g.globalAlpha = 0.75;
      g.font = '500 ' + (caption ? 32 : 38) + 'px Onest, system-ui, sans-serif';
      g.fillText(date, W / 2, footTop + FOOT * (caption ? 0.8 : 0.52));
      g.globalAlpha = 1;
    }

    // Stickers land in the same places on both screens, because they're placed
    // with a random generator seeded by the session.
    if (look.stickers !== 'none') {
      const rand = rng(r.seed + look.stickers);
      const kinds = look.stickers === 'mix' ? ['heart', 'star', 'sparkle'] :
        [{ hearts: 'heart', stars: 'star', sparkles: 'sparkle' }[look.stickers]];
      const colors = STICKER_COLORS.filter((c) => c.toLowerCase() !== paper.bg.toLowerCase());
      const put = (x, y, size) => drawSticker(g, kinds[Math.floor(rand() * kinds.length)], x, y, size,
        colors[Math.floor(rand() * colors.length)], (rand() - 0.5) * 0.9);
      for (const c of cells) {
        const corners = [[c.x, c.y], [c.x + c.w, c.y], [c.x, c.y + c.h], [c.x + c.w, c.y + c.h]];
        const n = rand() < 0.5 ? 1 : 2;
        for (let i = 0; i < n; i++) {
          const [x, y] = corners[Math.floor(rand() * 4)];
          put(x + (rand() - 0.5) * 30, y + (rand() - 0.5) * 30, 40 + rand() * 32);
        }
      }
      if (hasText) {
        put(M + 50 + rand() * 20, footTop + FOOT * 0.45, 36 + rand() * 14);
        put(W - M - 50 - rand() * 20, footTop + FOOT * 0.5, 36 + rand() * 14);
      }
    }

    if (animate) {
      cv.classList.remove('print');
      void cv.offsetWidth;
      cv.classList.add('print');
    }
  }

  function stripBlob() {
    return new Promise((resolve) => stripCanvas.toBlob(resolve, 'image/jpeg', 0.92));
  }

  function fileName() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return 'photobooth-' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      '-' + pad(d.getHours()) + pad(d.getMinutes()) + '.jpg';
  }

  /* ---------- Customizing ---------- */

  function lookToUI() {
    const custom = !PAPERS.some((p) => p.id === look.paper);
    setRadio('paper', custom ? '' : look.paper);
    $('custom-paper').classList.toggle('on', custom);
    if (custom) $('custom-color').value = look.paper;
    setRadio('pattern', look.pattern);
    setRadio('layout', look.layout);
    setRadio('filter-b', look.filter);
    setRadio('filter-r', look.filter);
    setRadio('stickers', look.stickers);
    setRadio('shape', look.shape);
    setRadio('font', look.font);
    if ($('caption').value !== look.caption) $('caption').value = look.caption;
    $('show-date').checked = look.date;
    frame.style.setProperty('--live-filter', filterOf(look.filter).css);
    $('view-result').classList.toggle('layout-grid', look.layout === 'grid');
  }

  // Change the look, show it, remember it, and tell the other person.
  function changeLook(patch) {
    Object.assign(look, cleanLook(patch));
    lookToUI();
    if (!$('view-result').hidden) drawStrip(false);
    store.set('look', JSON.stringify(Object.assign({}, look, { caption: '' })));
    sendLook();
  }

  $('papers').innerHTML = PAPERS.map((p) =>
    '<label title="' + p.name + '"><input type="radio" name="paper" value="' + p.id + '" aria-label="' + p.name +
    '"><span style="--sw:' + p.bg + '"></span></label>').join('') +
    '<label class="custom" id="custom-paper" title="Any colour"><input type="color" id="custom-color" value="#ffc6d9" ' +
    'aria-label="Pick any paper colour"><span aria-hidden="true">+</span></label>';
  chips($('patterns'), 'pattern', PATTERNS);
  chips($('layouts'), 'layout', LAYOUTS);
  chips($('filters-booth'), 'filter-b', FILTERS);
  chips($('filters-result'), 'filter-r', FILTERS);
  chips($('stickers'), 'stickers', STICKERS);
  chips($('shapes'), 'shape', SHAPES);
  chips($('fonts'), 'font', FONTS);

  const LOOK_INPUTS = {
    paper: 'paper', pattern: 'pattern', layout: 'layout', 'filter-b': 'filter',
    'filter-r': 'filter', stickers: 'stickers', shape: 'shape', font: 'font'
  };

  document.addEventListener('change', (e) => {
    const key = LOOK_INPUTS[e.target.name];
    if (key && e.target.checked) changeLook({ [key]: e.target.value });
  });
  $('custom-color').addEventListener('input', (e) => changeLook({ paper: e.target.value }));
  $('caption').addEventListener('input', (e) => changeLook({ caption: e.target.value }));
  $('show-date').addEventListener('change', (e) => changeLook({ date: e.target.checked }));

  // Tabs on the result screen
  const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
  function selectTab(tab) {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute('aria-controls')).hidden = !on;
    }
  }
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => selectTab(t));
    t.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      const next = tabs[(i + d + tabs.length) % tabs.length];
      selectTab(next);
      next.focus();
    });
  });

  // Colour themes for the site itself
  $('themes').insertAdjacentHTML('beforeend', THEMES.map((t) =>
    '<label title="' + t.name + '"><input type="radio" name="theme" value="' + t.id + '" aria-label="' + t.name +
    ' theme"><span style="--sw:' + t.sw + '"></span></label>').join(''));

  function setTheme(id) {
    const t = THEMES.find((x) => x.id === id) || THEMES[0];
    document.body.dataset.theme = t.id;
    document.querySelector('meta[name="theme-color"]').setAttribute('content', t.meta);
    setRadio('theme', t.id);
    store.set('theme', t.id);
  }
  $('themes').addEventListener('change', (e) => setTheme(e.target.value));

  // Booth options on the landing page
  chips($('opt-expiry'), 'opt-expiry', EXPIRY);
  chips($('opt-limit'), 'opt-limit', LIMITS);

  function optSummary() {
    const h = store.get('hours', String(CFG.defaultHours));
    const n = store.get('strips', String(CFG.defaultStrips));
    setRadio('opt-expiry', h);
    setRadio('opt-limit', n);
    const e = EXPIRY.find((x) => x.id === h);
    $('opt-summary').textContent = '· ' + (h === '0' ? 'link never expires' : 'link lasts ' + (e ? e.name : h + ' hours')) +
      ', ' + (n === '0' ? 'unlimited strips' : n + ' strips');
  }
  $('opt-expiry').addEventListener('change', (e) => { store.set('hours', e.target.value); optSummary(); });
  $('opt-limit').addEventListener('change', (e) => { store.set('strips', e.target.value); optSummary(); });

  /* ---------- Buttons ---------- */

  $('open-booth').addEventListener('click', openNewBooth);
  $('new-booth').addEventListener('click', openNewBooth);

  $('join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = $('join-code').value.trim();
    let code = raw;
    try {
      const u = new URL(raw);
      code = u.searchParams.get('room') || '';
    } catch (err) { /* not a link, treat it as a code */ }
    code = cleanCode(code);
    const error = $('join-error');
    if (code.length < 4) {
      error.textContent = 'That isn\'t a booth link or code. Paste the whole link the other person sent you.';
      error.hidden = false;
      return;
    }
    error.hidden = true;
    location.search = '?room=' + code;
  });

  function setMyName(v) {
    myName = cleanName(v);
    store.set('name', myName);
    $('name-me').textContent = myName || 'You';
    if ($('booth-name').value !== myName) $('booth-name').value = myName;
    hello();
  }

  $('my-name').value = myName;
  $('booth-name').value = myName;
  $('name-me').textContent = myName || 'You';
  $('booth-name').addEventListener('change', (e) => setMyName(e.target.value));

  $('enter').addEventListener('click', async () => {
    const btn = $('enter');
    const error = $('door-error');
    btn.disabled = true;
    error.hidden = true;
    setMyName($('my-name').value);
    audioCtx(); // unlock sound while we have a tap
    try {
      await startCamera();
    } catch (err) {
      error.textContent = cameraErrorText(err);
      error.hidden = false;
      btn.disabled = false;
      return;
    }
    if (typeof Peer === 'undefined') {
      fail('The booth didn\'t load completely', 'Check your internet connection, then try again.');
      return;
    }
    show('booth');
    tryHost(0);
  });

  $('copy-link').addEventListener('click', async () => {
    const input = $('invite-link');
    const btn = $('copy-link');
    try {
      await navigator.clipboard.writeText(input.value);
    } catch (err) {
      input.select();
      try { document.execCommand('copy'); } catch (e) { /* the link stays selected for manual copy */ }
    }
    btn.textContent = 'Link copied';
    toast('Link copied. Send it to the other person 💌');
    setTimeout(() => { btn.textContent = 'Copy link'; }, 2000);
  });

  $('invite-link').addEventListener('focus', (e) => e.target.select());

  for (const radio of document.querySelectorAll('input[name="poses"], input[name="count"]')) {
    radio.addEventListener('change', () => {
      if (radio.name === 'poses') poses = Number(radio.value);
      else count = Number(radio.value);
      sendSettings();
    });
  }
  $('ideas').addEventListener('change', (e) => { ideasOn = e.target.checked; sendSettings(); });

  function pressStart() {
    if (session && !session.done) return;
    if (!canShoot()) { toast('This booth has used all of its strips. Open a new booth for more.'); return; }
    if (role === 'guest' && isConnected()) {
      // The host owns the clock, so ask them to start for both of us.
      send({ type: 'please-start', poses, count, ideas: ideasOn });
      startPending = true;
      updateStart();
      setTimeout(() => { startPending = false; updateStart(); }, 2500);
    } else {
      begin();
    }
  }

  startBtn.addEventListener('click', pressStart);

  $('mic').addEventListener('click', () => setMic(!micOn));
  $('speaker').addEventListener('click', () => setSpeaker(!speakerOn));
  $('sfx').addEventListener('click', () => { setSfx(!sfxOn); SFX.pop(); });
  $('hear').addEventListener('click', () => {
    audioCtx();
    $('hear').hidden = true;
    vidThem.muted = !speakerOn;
    vidThem.play().catch(() => {});
  });

  const vol = Number(store.get('volume', '100'));
  $('volume').value = String(Number.isFinite(vol) ? vol : 100);
  vidThem.volume = Number($('volume').value) / 100;
  $('volume').addEventListener('input', (e) => {
    vidThem.volume = Number(e.target.value) / 100;
    store.set('volume', e.target.value);
    if (!speakerOn && vidThem.volume > 0) setSpeaker(true);
  });

  $('reacts').innerHTML = REACTIONS.map((e) =>
    '<button type="button" data-e="' + e + '" aria-label="Send ' + e + '">' + e + '</button>').join('');
  $('reacts').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    floatReaction(b.dataset.e, true);
    send({ type: 'react', e: b.dataset.e });
  });

  // Keyboard: Space starts the photos, M mutes the microphone.
  document.addEventListener('keydown', (e) => {
    if ($('view-booth').hidden || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON' || t.isContentEditable)) return;
    if (e.key === ' ') { e.preventDefault(); pressStart(); }
    else if (e.key === 'm' || e.key === 'M') setMic(!micOn);
  });

  // Paper colours etc. are wired above. Saving and sharing:
  $('save').addEventListener('click', async () => {
    const blob = await stripBlob();
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast('Strip saved 📸');
  });

  // Show "Share" only where the device can share image files (mostly phones).
  try {
    const probe = new File([new Blob(['x'], { type: 'image/jpeg' })], 'x.jpg', { type: 'image/jpeg' });
    if (navigator.canShare && navigator.canShare({ files: [probe] })) $('share').hidden = false;
  } catch (e) { /* sharing not available */ }

  $('share').addEventListener('click', async () => {
    const blob = await stripBlob();
    if (!blob) return;
    const file = new File([blob], fileName(), { type: 'image/jpeg' });
    try {
      await navigator.share({ files: [file], title: 'Our photo strip' });
    } catch (e) { /* the person closed the share sheet */ }
  });

  $('again').addEventListener('click', () => show('booth'));

  /* ---------- Leaving ---------- */

  function leave() {
    send({ type: 'bye' });
    stopSession();
    closed = true;
    clearInterval(hbTimer);
    if (localStream) localStream.getTracks().forEach((t) => t.stop());
    setTimeout(shutdown, 300); // give the goodbye message a moment to go out
    SFX.leave();
    $('rejoin').hidden = expired();
    $('see-strips').hidden = !history.length;
    $('left-text').textContent = 'Your camera and microphone are off.' +
      (expired() ? ' This booth\'s link has expired.' : ' You can go back in with the same link while it still works.');
    show('left');
  }

  const dialog = $('leave-dialog');
  $('leave').addEventListener('click', () => {
    if (dialog.showModal) dialog.showModal();
    else if (confirm('Leave the booth? Your camera and microphone will turn off.')) leave();
  });
  $('leave-no').addEventListener('click', () => dialog.close());
  $('leave-yes').addEventListener('click', () => { dialog.close(); leave(); });

  $('rejoin').addEventListener('click', () => location.reload());
  $('see-strips').addEventListener('click', () => {
    if (!history.length) return;
    result = result || history[0];
    showResult(false);
  });

  window.addEventListener('pagehide', () => {
    send({ type: 'bye' });
    try { if (peer) peer.destroy(); } catch (e) { /* ignore */ }
  });

  /* ---------- Start ---------- */

  setTheme(store.get('theme', 'blush'));
  setSfx(sfxOn);
  setSpeaker(true);
  applySettings({ poses, count, ideas: ideasOn });
  lookToUI();
  optSummary();

  room = cleanCode(new URLSearchParams(location.search).get('room'));
  if (room.length >= 4) {
    booth = parseRoom(room);
    taken = Number(store.get('taken-' + room, '0')) || 0;
    $('door-code').textContent = room.split('-').slice(0, 2).join('-');
    $('invite-link').value = roomLink(room);
    const lt = limitText();
    $('door-limits').textContent = lt ? ' · ' + lt : '';
    if (expired()) {
      fail('This booth has closed', 'The link was set to stop working after a while, and that time has passed. Open a new booth to take more photos.',
        'Open a new booth', openNewBooth);
    } else {
      setStatus('connecting');
      show('door');
    }
  } else {
    show('home');
  }
})();
