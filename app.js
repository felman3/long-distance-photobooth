/* Long Distance Photobooth
 *
 * How it works:
 *  1. The first person to open a booth link becomes the "host" and registers the
 *     booth code with the PeerJS server. The second person finds them by that code.
 *  2. The two browsers connect directly (WebRTC): one video call for the live
 *     preview, plus one data channel for messages and photos.
 *  3. The host picks a start time. Both sides run the same countdown against the
 *     host's clock and snap their OWN camera at full quality.
 *  4. Each side sends its photos to the other, and both draw the same strip.
 */
(() => {
  'use strict';

  const CFG = Object.assign({ peerOptions: {}, idPrefix: 'ldbooth-' }, window.BOOTH_CONFIG || {});
  const $ = (id) => document.getElementById(id);

  // Timing of a photo session, in milliseconds.
  const LEAD_MS = 1500;     // "Get ready" before the first countdown
  const COUNT_MS = 3000;    // 3, 2, 1
  const BETWEEN_MS = 1500;  // pause between photos
  // Each person's photo is a 3:4 portrait; two of them side by side make one 3:2 picture.
  const SHOT_W = 600;
  const SHOT_H = 800;
  const CHUNK = 12000;      // photos are sent in pieces this many characters long

  const PAPERS = [
    { id: 'white', name: 'White', bg: '#F6F7FB', ink: '#141A4D' },
    { id: 'black', name: 'Black', bg: '#15161C', ink: '#F6F7FB' },
    { id: 'blue', name: 'Blue', bg: '#2836B8', ink: '#F6F7FB' },
    { id: 'pink', name: 'Pink', bg: '#FF5C8A', ink: '#141A4D' },
    { id: 'yellow', name: 'Yellow', bg: '#FFD43B', ink: '#141A4D' }
  ];

  const views = ['home', 'door', 'booth', 'result', 'error'];
  const frame = $('frame');
  const vidMe = $('vid-me');
  const vidThem = $('vid-them');
  const cueEl = $('cue');
  const countEl = $('count');
  const startBtn = $('start');
  const stripCanvas = $('strip');

  let room = '';
  let localStream = null;
  let peer = null;        // our PeerJS connection to the signalling server
  let conn = null;        // data channel to the other person
  let call = null;        // video call to the other person
  let role = null;        // 'host' (left side) or 'guest' (right side)
  let partnerId = null;
  let clockOffset = 0;    // host clock minus our clock (always 0 for the host)
  let bestRtt = Infinity;
  let lastHeard = 0;
  let hbTimer = null;
  let partnerLeft = false;
  let poses = 4;
  let session = null;     // the photo session in progress
  let tick = null;
  let result = null;      // photos for the strip on the result screen
  let paper = PAPERS[0];
  let closed = false;     // true once we've shown an error and left the booth

  /* ---------- Views ---------- */

  function show(name) {
    for (const v of views) $('view-' + v).hidden = v !== name;
    $('status').hidden = !(name === 'booth' || name === 'result');
    if (name === 'booth') {
      vidMe.play().catch(() => {});
      if (vidThem.srcObject) vidThem.play().catch(() => {});
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

  function setStatus(state) {
    document.body.dataset.conn = state;
    const text = {
      connecting: 'Connecting',
      waiting: 'Waiting',
      connected: 'Connected'
    }[state];
    $('status-text').textContent = text;

    const connected = state === 'connected';
    $('invite').hidden = connected;
    startBtn.textContent = connected ? 'Start photos' : 'Take photos alone';
    startBtn.classList.toggle('btn-primary', connected);
    startBtn.classList.toggle('btn-quiet', !connected);

    $('them-empty-text').textContent =
      connected ? 'Connected. Their video is loading.' :
      state === 'connecting' ? 'Connecting' :
      partnerLeft ? 'The other person left. They can come back with the same link.' :
      'Waiting for the other person';
  }

  /* ---------- Booth codes ---------- */

  function newCode() {
    const letters = 'abcdefghjkmnpqrstuvwxyz23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const s = Array.from(bytes, (b) => letters[b % letters.length]).join('');
    return s.slice(0, 4) + '-' + s.slice(4);
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

  /* ---------- Camera ---------- */

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const e = new Error('unsupported');
      e.name = 'Unsupported';
      throw e;
    }
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }
    });
    vidMe.srcObject = localStream;
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

  /* ---------- Connecting the two browsers ---------- */

  const hostId = () => CFG.idPrefix + room;
  const isConnected = () => !!(conn && conn.open);

  function send(msg) {
    if (isConnected()) {
      try { conn.send(msg); } catch (e) { console.warn('send failed', e); }
    }
  }

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
      wireCall(p.call(hostId(), localStream));
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
      setStatus('connected');
      clearInterval(hbTimer);
      hbTimer = setInterval(heartbeat, 2000);
      if (role === 'guest') {
        // Measure the difference between the two device clocks a few times.
        for (let i = 0; i < 5; i++) setTimeout(() => send({ type: 'ping', t: Date.now() }), i * 250);
      } else {
        send({ type: 'poses', n: poses });
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
      vidThem.srcObject = stream;
      vidThem.play().catch(() => {});
      frame.classList.add('has-them');
    });
    m.on('close', () => {
      if (call !== m) return;
      vidThem.srcObject = null;
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
    conn = null;
    call = null;
    partnerId = null;
    partnerLeft = true;
    clearInterval(hbTimer);
    try { if (c) c.close(); } catch (e) { /* ignore */ }
    try { if (m) m.close(); } catch (e) { /* ignore */ }
    vidThem.srcObject = null;
    frame.classList.remove('has-them');

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
        fail('This booth already has two people', 'Open a new booth and send that link instead.', 'Open a new booth',
          () => { location.search = '?room=' + newCode(); });
        break;
      case 'poses':
        setPoses(d.n);
        break;
      case 'please-start':
        if (role === 'host' && !(session && !session.done)) {
          setPoses(d.poses);
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

  /* ---------- Taking the photos ---------- */

  function setPoses(n) {
    if (![2, 3, 4].includes(n)) return;
    poses = n;
    const radio = document.querySelector('input[name="poses"][value="' + n + '"]');
    if (radio) radio.checked = true;
  }

  function begin() {
    if (session && !session.done) return;
    const msg = {
      type: 'start',
      sid: Math.random().toString(36).slice(2, 10),
      t0: hostNow() + LEAD_MS,
      poses
    };
    send(msg);
    runSession(msg);
  }

  const shotTime = (s, k) => s.t0 + COUNT_MS + k * (COUNT_MS + BETWEEN_MS);

  function runSession(m) {
    if (!m || !Number.isFinite(m.t0) || ![2, 3, 4].includes(m.poses)) return;
    stopSession();
    setPoses(m.poses);
    session = {
      sid: String(m.sid),
      t0: m.t0,
      poses: m.poses,
      k: 0,
      mine: [],
      theirs: [],
      pieces: {},
      solo: !isConnected(),
      done: false
    };
    show('booth');
    document.body.classList.add('shooting');
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
  }

  function step() {
    const s = session;
    if (!s || s.done) return;
    const remaining = shotTime(s, s.k) - hostNow();

    if (remaining <= 0) {
      capture(s, s.k);
      s.k += 1;
      countEl.textContent = '';
      if (s.k >= s.poses) {
        clearInterval(tick);
        tick = null;
        develop(s);
      }
      return;
    }

    if (remaining > COUNT_MS) {
      countEl.textContent = '';
      setText(cueEl, s.k === 0 ? 'Get ready' : 'Next pose');
    } else {
      setText(countEl, String(Math.ceil(remaining / 1000)));
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
    g.fillStyle = '#1B257F';
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
    $('dots').innerHTML = '';
    const haveTheirs = s.theirs.some(Boolean);
    const mineLeft = role !== 'guest';
    result = {
      rows: s.poses,
      solo: !haveTheirs,
      left: !haveTheirs ? s.mine : (mineLeft ? s.mine : s.theirs),
      right: !haveTheirs ? [] : (mineLeft ? s.theirs : s.mine),
      images: null
    };
    $('view-result').classList.toggle('solo-strip', result.solo);
    show('result');
    drawStrip(true);
  }

  /* ---------- The strip ---------- */

  function loadImage(url) {
    return new Promise((resolve) => {
      if (!url) { resolve(null); return; }
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => resolve(null);
      im.src = url;
    });
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
        document.fonts.load('500 30px Onest')
      ]);
    } catch (e) { /* fall back to system fonts */ }
    if (token !== drawToken || r !== result) return;

    const CW = 540, CH = 720, M = 48, GAP = 20, FOOT = 200;
    const cols = r.solo ? 1 : 2;
    const W = M * 2 + CW * cols;
    const H = M + r.rows * CH + (r.rows - 1) * GAP + FOOT;
    const cv = stripCanvas;
    cv.width = W;
    cv.height = H;
    const g = cv.getContext('2d', { willReadFrequently: true });

    g.fillStyle = paper.bg;
    g.fillRect(0, 0, W, H);

    const bw = $('bw').checked;
    for (let k = 0; k < r.rows; k++) {
      const y = M + k * (CH + GAP);
      g.fillStyle = 'rgba(128, 128, 128, .35)';
      g.fillRect(M, y, CW * cols, CH);
      const l = r.images.left[k];
      if (l) g.drawImage(l, M, y, CW, CH);
      const rt = r.images.right[k];
      if (rt) g.drawImage(rt, M + CW, y, CW, CH);

      if (bw) {
        const px = g.getImageData(M, y, CW * cols, CH);
        const a = px.data;
        for (let i = 0; i < a.length; i += 4) {
          let v = 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2];
          v = (v - 128) * 1.12 + 128; // a touch more contrast
          a[i] = a[i + 1] = a[i + 2] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
        g.putImageData(px, M, y);
      }
    }

    // Caption and date in the white space at the bottom.
    const caption = $('caption').value.trim();
    const date = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
    const footTop = H - FOOT;
    g.fillStyle = paper.ink;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    if (caption) {
      let size = 108;
      do {
        g.font = '700 ' + size + 'px Caveat, "Segoe Print", "Bradley Hand", cursive';
        size -= 4;
      } while (g.measureText(caption).width > W - M * 2 && size > 28);
      g.fillText(caption, W / 2, footTop + FOOT * 0.4);
      g.globalAlpha = 0.75;
      g.font = '500 32px Onest, system-ui, sans-serif';
      g.fillText(date, W / 2, footTop + FOOT * 0.8);
    } else {
      g.globalAlpha = 0.8;
      g.font = '500 38px Onest, system-ui, sans-serif';
      g.fillText(date, W / 2, footTop + FOOT * 0.52);
    }
    g.globalAlpha = 1;

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
    return 'photobooth-' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '.jpg';
  }

  /* ---------- Buttons ---------- */

  $('open-booth').addEventListener('click', () => {
    location.search = '?room=' + newCode();
  });

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

  $('enter').addEventListener('click', async () => {
    const btn = $('enter');
    const error = $('door-error');
    btn.disabled = true;
    error.hidden = true;
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
    setTimeout(() => { btn.textContent = 'Copy link'; }, 2000);
  });

  $('invite-link').addEventListener('focus', (e) => e.target.select());

  for (const radio of document.querySelectorAll('input[name="poses"]')) {
    radio.addEventListener('change', () => {
      poses = Number(radio.value);
      send({ type: 'poses', n: poses });
    });
  }

  startBtn.addEventListener('click', () => {
    if (session && !session.done) return;
    if (role === 'guest' && isConnected()) {
      // The host owns the clock, so ask them to start for both of us.
      send({ type: 'please-start', poses });
      startBtn.disabled = true;
      setTimeout(() => { startBtn.disabled = false; }, 2500);
    } else {
      begin();
    }
  });

  // Paper colours
  $('papers').innerHTML = PAPERS.map((p, i) =>
    '<label title="' + p.name + '"><input type="radio" name="paper" value="' + p.id + '"' + (i === 0 ? ' checked' : '') +
    ' aria-label="' + p.name + '"><span style="--sw:' + p.bg + '"></span></label>').join('');
  $('papers').addEventListener('change', (e) => {
    paper = PAPERS.find((p) => p.id === e.target.value) || PAPERS[0];
    drawStrip(false);
  });
  $('bw').addEventListener('change', () => drawStrip(false));
  $('caption').addEventListener('input', () => drawStrip(false));

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

  window.addEventListener('pagehide', () => {
    try { if (peer) peer.destroy(); } catch (e) { /* ignore */ }
  });

  /* ---------- Start ---------- */

  room = cleanCode(new URLSearchParams(location.search).get('room'));
  if (room.length >= 4) {
    $('door-code').textContent = room;
    $('invite-link').value = roomLink(room);
    setStatus('connecting');
    show('door');
  } else {
    show('home');
  }
})();
