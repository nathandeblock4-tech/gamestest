// Arcade online system: presence, history, admin messages, jumpscares and trolls.
// Uses the Firebase Realtime Database when FB is set (saves history for everyone, all the time),
// otherwise falls back to a direct browser-to-browser link to an open admin panel.
(function () {
  'use strict';
  if (window.__grPresence) return; window.__grPresence = true;
  var FB = 'https://game-site-2a81e-default-rtdb.firebaseio.com';
  var HUB = 'gameroom-hub-f8417eabf5faff202eed';
  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  var id = get('gr_uid'); if (!id) { id = Math.random().toString(36).slice(2, 10); set('gr_uid', id); }
  function name() { return get('gr_name') || ('Guest-' + id.slice(0, 4)); }
  var file = location.pathname.split('/').pop() || 'index.html';
  var isAdmin = file === 'admin.html';
  function page() {
    if (isAdmin) return 'Admin panel';
    var t = (document.title || '').split('·')[0].trim();
    if (file === 'index.html' || file === '') { var h = (location.hash || '').slice(1); if (h === 'ttt') return 'Tic-Tac-Toe'; return 'Home page'; }
    if (file === 'casino.html' && location.hash.length > 1) return 'Casino: ' + location.hash.slice(1);
    return t || file;
  }
  var dev = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? 'phone' : /CrOS/.test(navigator.userAgent) ? 'chromebook' : 'computer';
  var since = Date.now(), offset = null;
  function plays() { var n = 0; try { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k.indexOf('gr_open_') === 0) n += +localStorage.getItem(k) || 0; } } catch (e) {} return n; }
  function serverNow() { return Date.now() + (offset || 0); }
  var SV = { '.sv': 'timestamp' }, INC = function (n) { return { '.sv': { increment: n } }; };
  function key(s) { return String(s).replace(/[.#$\[\]\/]/g, '_').slice(0, 60) || '_'; }

  // =============== Firebase transport ===============
  function fb(path, method, body, keep) {
    return fetch(FB + '/' + path + '.json', { method: method || 'GET', body: body == null ? undefined : JSON.stringify(body), keepalive: !!keep, headers: body == null ? undefined : { 'Content-Type': 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }
  var sess = null, lastBeat = Date.now(), curPage = page();
  function beat(final) {
    var now = Date.now(), visible = document.visibilityState !== 'hidden', dt = Math.round((now - lastBeat) / 1000); lastBeat = now;
    var body = { name: name(), page: curPage, file: file, dev: dev, vis: document.visibilityState, since: since, last: SV, plays: plays(), online: !final };
    if (visible && dt > 0 && dt < 120) body.secs = INC(dt);
    fb('u/' + id, 'PATCH', body, final).then(function (r) { if (r && typeof r.last === 'number') offset = r.last - Date.now(); });
    if (sess && sess.key) fb('h/' + id + '/' + sess.key, 'PATCH', { d: Math.round((now - sess.start) / 1000) }, final);
  }
  function startSession() {
    curPage = page(); sess = { start: Date.now(), key: null };
    var s = sess;
    fb('h/' + id, 'POST', { p: curPage, s: SV, d: 0 }).then(function (r) { if (r && r.name) s.key = r.name; });
    var up = { visits: INC(1) }; if (curPage !== 'Home page') { up['games/' + key(curPage)] = INC(1); }
    fb('u/' + id, 'PATCH', up);
    fb('ev', 'POST', { k: 'page', uid: id, name: name(), page: curPage, t: SV });
  }
  function listen(path) {
    if (!window.EventSource) return;
    var es, seen = {}, first = true;
    function exec(k, c) { if (seen[k]) return; seen[k] = 1; if (!c || typeof c !== 'object') return; if (typeof c.t === 'number' && offset != null && serverNow() - c.t > 45000) return; handle(c); }
    function open() {
      es = new EventSource(FB + '/' + path + '.json');
      es.addEventListener('put', function (e) {
        var m; try { m = JSON.parse(e.data); } catch (x) { return; }
        if (m.path === '/') { var d = m.data || {}; if (first) { first = false; for (var k in d) seen[k] = 1; return; } for (var k2 in d) exec(k2, d[k2]); return; }
        var parts = m.path.split('/'); if (parts.length === 2 && m.data) exec(parts[1], m.data);
      });
      es.addEventListener('patch', function (e) { var m; try { m = JSON.parse(e.data); } catch (x) { return; } if (m.path === '/' && m.data) for (var k in m.data) exec(k, m.data[k]); });
    }
    open();
  }
  function ack(what) {
    if (FB) fb('ev', 'POST', { k: 'got', uid: id, name: name(), what: what, page: curPage, t: SV });
    else try { if (conn && conn.open) conn.send({ t: 'scared', id: id, what: what }); } catch (e) {}
  }
  function startFB() {
    startSession(); beat();
    setInterval(beat, 20000);
    document.addEventListener('visibilitychange', function () { beat(); });
    window.addEventListener('pagehide', function () { beat(true); });
    window.addEventListener('hashchange', function () { if (page() !== curPage) { beat(); startSession(); } });
    listen('cmd/all'); listen('cmd/' + id);
  }

  // =============== direct (PeerJS) fallback ===============
  var peer = null, conn = null, retry = null, tries = 0;
  function state() { return { t: 'state', id: id, name: name(), page: page(), file: file, dev: dev, since: since, vis: document.visibilityState, plays: plays() }; }
  function send() { try { if (conn && conn.open) conn.send(state()); } catch (e) {} }
  function schedule() { clearTimeout(retry); retry = setTimeout(function () { if (!conn) connect(); }, Math.min(30000, 6000 + tries * 2000)); }
  function connect() {
    if (!peer || peer.destroyed) return;
    if (peer.disconnected) { try { peer.reconnect(); } catch (e) {} schedule(); return; }
    tries++;
    try { var c = peer.connect(HUB, { reliable: true }); c.on('open', function () { conn = c; tries = 0; send(); }); c.on('data', function (d) { if (d && d.t === 'ping') send(); else handle(d); }); c.on('close', function () { if (conn === c) conn = null; schedule(); }); c.on('error', function () {}); } catch (e) {}
    schedule();
  }
  function startPeer() {
    if (!window.Peer) { var s = document.createElement('script'); s.src = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js'; s.onload = startPeer; s.onerror = function () {}; document.head.appendChild(s); return; }
    try { peer = new window.Peer({ config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] } }); } catch (e) { return; }
    peer.on('open', connect); peer.on('error', function (e) { if (e && e.type === 'peer-unavailable') conn = null; }); peer.on('disconnected', function () { try { peer.reconnect(); } catch (e) {} });
    document.addEventListener('visibilitychange', send); window.addEventListener('hashchange', send); setInterval(send, 20000);
    window.addEventListener('pagehide', function () { try { if (conn && conn.open) conn.send({ t: 'bye', id: id }); } catch (e) {} });
  }

  // =============== commands ===============
  function handle(d) {
    if (!d || typeof d !== 'object') return;
    var k = d.k || d.t;
    if (k === 'msg' && typeof d.text === 'string') { showMsg(d.text.slice(0, 300), d.style); ack('message'); }
    else if (k === 'scare') { var kind = SCARES[d.kind] ? d.kind : 'face'; setTimeout(function () { scare(kind); }, Math.max(0, Math.min(20000, +d.delay || 0))); }
    else if (k === 'troll' && TROLLS[d.kind]) { setTimeout(function () { troll(d.kind, Math.max(3, Math.min(120, +d.dur || 15)), d.text); }, Math.max(0, Math.min(20000, +d.delay || 0))); }
    else if (k === 'goto' && typeof d.file === 'string' && /^[a-z0-9_-]+\.html(#[a-z0-9_-]*)?$/i.test(d.file)) { ack('sent to ' + d.file); setTimeout(function () { location.href = d.file; }, 300); }
    else if (k === 'rename' && typeof d.name === 'string' && d.name.trim()) { set('gr_name', d.name.trim().slice(0, 20)); ack('renamed'); if (FB) beat(); else send(); }
    else if (k === 'reload') location.reload();
  }

  // =============== audio ===============
  var ac = null;
  function audio() { try { if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === 'suspended') ac.resume(); } catch (e) {} return ac; }
  window.addEventListener('pointerdown', function () { audio(); }, { capture: true });
  window.addEventListener('keydown', function () { audio(); }, { capture: true });
  function noiseBuf(a, dur, shape) { var len = Math.max(1, Math.floor(a.sampleRate * dur)), b = a.createBuffer(1, len, a.sampleRate), d = b.getChannelData(0); for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (shape ? shape(i / len) : 1); return b; }
  function out(a) { var c = a.createDynamicsCompressor(); c.threshold.value = -18; c.ratio.value = 8; c.connect(a.destination); return c; }
  function scream(t0, len) {
    var a = audio(); if (!a) return; len = len || 2.2;
    try {
      var o = out(a), shaper = a.createWaveShaper(), curve = new Float32Array(2048);
      for (var i = 0; i < 2048; i++) { var x = i / 1024 - 1; curve[i] = Math.tanh(x * 9); }
      shaper.curve = curve; var master = a.createGain(); master.gain.setValueAtTime(0.0001, t0); master.gain.exponentialRampToValueAtTime(1, t0 + 0.02); master.gain.setValueAtTime(1, t0 + len - 0.6); master.gain.exponentialRampToValueAtTime(0.0001, t0 + len);
      shaper.connect(master); master.connect(o);
      // shrieking voices
      [180, 247, 311, 415, 587, 830, 1240].forEach(function (f, i) {
        var os = a.createOscillator(); os.type = i % 3 === 0 ? 'sawtooth' : i % 3 === 1 ? 'square' : 'triangle';
        os.frequency.setValueAtTime(f * 0.5, t0); os.frequency.exponentialRampToValueAtTime(f * 2.1, t0 + 0.18); os.frequency.exponentialRampToValueAtTime(f * 1.4, t0 + len);
        var lfo = a.createOscillator(), lg = a.createGain(); lfo.frequency.value = 7 + i * 4.3; lg.gain.value = f * 0.14; lfo.connect(lg); lg.connect(os.frequency); lfo.start(t0); lfo.stop(t0 + len);
        var g = a.createGain(); g.gain.value = 0.13; os.connect(g); g.connect(shaper); os.start(t0); os.stop(t0 + len);
      });
      // breath / distortion noise
      var n = a.createBufferSource(); n.buffer = noiseBuf(a, len); var bp = a.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.setValueAtTime(1200, t0); bp.frequency.exponentialRampToValueAtTime(4200, t0 + 0.3); bp.Q.value = 0.9; var ng = a.createGain(); ng.gain.value = 0.7; n.connect(bp); bp.connect(ng); ng.connect(shaper); n.start(t0);
      // bass hit
      var th = a.createOscillator(), tg = a.createGain(); th.type = 'sine'; th.frequency.setValueAtTime(120, t0); th.frequency.exponentialRampToValueAtTime(28, t0 + 0.6); tg.gain.setValueAtTime(1.2, t0); tg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.8); th.connect(tg); tg.connect(o); th.start(t0); th.stop(t0 + 0.9);
      var cr = a.createBufferSource(); cr.buffer = noiseBuf(a, 0.25, function (u) { return Math.pow(1 - u, 2); }); var cg = a.createGain(); cg.gain.value = 1; cr.connect(cg); cg.connect(o); cr.start(t0);
    } catch (e) {}
  }
  function heartbeat(t, n, speedup) { var a = audio(); if (!a) return; var tt = t; for (var i = 0; i < n; i++) { [0, 0.2].forEach(function (off, k) { var o = a.createOscillator(), g = a.createGain(), x = tt + off; o.type = 'sine'; o.frequency.setValueAtTime(65, x); o.frequency.exponentialRampToValueAtTime(38, x + 0.15); g.gain.setValueAtTime(k ? 0.45 : 0.7, x); g.gain.exponentialRampToValueAtTime(0.0001, x + 0.22); o.connect(g); g.connect(a.destination); o.start(x); o.stop(x + 0.25); }); tt += Math.max(0.35, 0.8 - i * (speedup || 0)); } }
  function staticNoise(t, dur, vol) { var a = audio(); if (!a) return; var n = a.createBufferSource(); n.buffer = noiseBuf(a, dur); var g = a.createGain(); g.gain.value = vol || 0.3; n.connect(g); g.connect(a.destination); n.start(t); }
  function knock(t, n) { var a = audio(); if (!a) return; for (var i = 0; i < n; i++) { var x = t + i * 0.32 + (i % 3 === 2 ? 0.25 : 0); var s = a.createBufferSource(); s.buffer = noiseBuf(a, 0.09, function (u) { return Math.pow(1 - u, 6); }); var f = a.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 520; var g = a.createGain(); g.gain.value = 2.4; s.connect(f); f.connect(g); g.connect(a.destination); s.start(x); var o = a.createOscillator(), og = a.createGain(); o.frequency.setValueAtTime(110, x); o.frequency.exponentialRampToValueAtTime(60, x + 0.1); og.gain.setValueAtTime(0.6, x); og.gain.exponentialRampToValueAtTime(0.0001, x + 0.12); o.connect(og); og.connect(a.destination); o.start(x); o.stop(x + 0.13); } }
  function whisperSnd(t, dur) { var a = audio(); if (!a) return; var n = a.createBufferSource(); n.buffer = noiseBuf(a, dur, function (u) { return 0.5 + 0.5 * Math.sin(u * dur * 9) * Math.sin(u * dur * 2.3); }); var f = a.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 3000; f.Q.value = 2.5; var g = a.createGain(); g.gain.value = 0.9; n.connect(f); f.connect(g); g.connect(a.destination); n.start(t); }
  function drone(t, dur) { var a = audio(); if (!a) return; [55, 58.3, 82.4].forEach(function (fq) { var o = a.createOscillator(), g = a.createGain(); o.type = 'sawtooth'; o.frequency.value = fq; var lp = a.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 300; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.12, t + dur * 0.8); g.gain.setValueAtTime(0.12, t + dur - 0.05); g.gain.exponentialRampToValueAtTime(0.0001, t + dur); o.connect(lp); lp.connect(g); g.connect(a.destination); o.start(t); o.stop(t + dur + 0.05); }); }

  // =============== jumpscares ===============
  var faceA = new Image(), faceB = new Image(); faceA.src = 'demetrius_nightmare.jpg'; faceB.src = 'demetrius.jpg';
  function css() {
    if (document.getElementById('gr-fx-css')) return;
    var st = document.createElement('style'); st.id = 'gr-fx-css';
    st.textContent = '@keyframes grShake{0%,100%{translate:0 0}20%{translate:-22px 14px}40%{translate:18px -16px}60%{translate:-14px -18px}80%{translate:20px 15px}}@keyframes grFade{to{opacity:0}}@keyframes grSpin{to{rotate:360deg}}@keyframes grWob{0%,100%{rotate:-3deg;scale:1.02}50%{rotate:3deg;scale:.98}}@keyframes grHue{to{filter:hue-rotate(360deg) saturate(2)}}@keyframes grJit{0%,100%{translate:0 0}25%{translate:-3px 2px}50%{translate:3px -2px}75%{translate:-2px -3px}}@keyframes grBlink{0%,92%,100%{opacity:1}95%{opacity:0}}';
    document.head.appendChild(st);
  }
  function overlay(bg) { var ov = document.createElement('div'); ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:' + (bg || '#000') + ';display:flex;align-items:center;justify-content:center;overflow:hidden;cursor:none;user-select:none'; document.documentElement.appendChild(ov); return ov; }
  function proceduralFace(g, w, h, t) { // fallback creepy face
    g.fillStyle = '#0a0000'; g.fillRect(0, 0, w, h); var cx = w / 2, cy = h / 2, s = Math.min(w, h) * (0.45 + t * 0.4);
    g.fillStyle = '#d9cfc4'; g.beginPath(); g.ellipse(cx, cy, s * 0.62, s * 0.82, 0, 0, 7); g.fill();
    g.fillStyle = '#000'; [-1, 1].forEach(function (k) { g.beginPath(); g.ellipse(cx + k * s * 0.24, cy - s * 0.15, s * 0.14, s * 0.2, k * 0.2, 0, 7); g.fill(); g.fillStyle = '#ff0000'; g.beginPath(); g.arc(cx + k * s * 0.24, cy - s * 0.12, s * 0.025, 0, 7); g.fill(); g.fillStyle = '#000'; });
    g.beginPath(); g.ellipse(cx, cy + s * 0.38, s * 0.26, s * 0.3, 0, 0, 7); g.fill();
    g.fillStyle = '#e8e2d0'; for (var i = -4; i <= 4; i++) { g.beginPath(); g.moveTo(cx + i * s * 0.055 - s * 0.025, cy + s * 0.12); g.lineTo(cx + i * s * 0.055 + s * 0.025, cy + s * 0.12); g.lineTo(cx + i * s * 0.055, cy + s * 0.24); g.fill(); }
  }
  function showFace(ov, done) {
    ov.innerHTML = ''; ov.style.background = '#000'; ov.style.pointerEvents = 'auto';
    var cv = document.createElement('canvas'), W = Math.min(1600, innerWidth), H = Math.round(W * innerHeight / innerWidth); cv.width = W; cv.height = H;
    cv.style.cssText = 'width:100vw;height:100vh;animation:grShake .07s linear infinite'; ov.appendChild(cv);
    var g = cv.getContext('2d'), img = faceA.complete && faceA.naturalWidth ? faceA : faceB.complete && faceB.naturalWidth ? faceB : null, t0 = performance.now(), D = 2100;
    scream(audio() ? audio().currentTime + 0.01 : 0);
    try { if (navigator.vibrate) navigator.vibrate([400, 80, 600]); } catch (e) {}
    (function frame(now) {
      var u = (now - t0) / D; if (u >= 1) { ov.style.animation = 'grFade .35s forwards'; setTimeout(function () { ov.remove(); done(); }, 360); return; }
      var z = 1.05 + Math.min(1, u * 5) * 0.55 + u * 0.4; // lunge toward the screen
      if (img) { var r = Math.max(W / img.naturalWidth, H / img.naturalHeight) * z, iw = img.naturalWidth * r, ih = img.naturalHeight * r; g.drawImage(img, (W - iw) / 2 + (Math.random() - .5) * 30, (H - ih) / 2 + (Math.random() - .5) * 30, iw, ih); }
      else proceduralFace(g, W, H, u);
      // glitch slices
      for (var i = 0; i < 6; i++) { var y = Math.random() * H, hh = 8 + Math.random() * 60, dx = (Math.random() - .5) * 120; try { g.drawImage(cv, 0, y, W, hh, dx, y, W, hh); } catch (e) {} }
      g.globalCompositeOperation = 'multiply'; g.fillStyle = 'rgba(190,0,0,' + (0.35 + Math.random() * 0.3) + ')'; g.fillRect(0, 0, W, H); g.globalCompositeOperation = 'source-over';
      var vg = g.createRadialGradient(W / 2, H / 2, H * 0.2, W / 2, H / 2, H * 0.8); vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.9)'); g.fillStyle = vg; g.fillRect(0, 0, W, H);
      if (Math.random() < 0.12) { g.globalCompositeOperation = 'difference'; g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.globalCompositeOperation = 'source-over'; }
      if (Math.random() < 0.06) { g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); }
      requestAnimationFrame(frame);
    })(t0);
    ack('jumpscare');
  }
  function typeText(el, text, ms, cb) { var i = 0; (function step() { el.textContent = text.slice(0, ++i); if (i < text.length) setTimeout(step, ms); else if (cb) cb(); })(); }
  var SCARES = {
    face: function (ov, go) { go(); },
    static: function (ov, go) { var cv = document.createElement('canvas'); cv.width = 320; cv.height = 180; cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated'; ov.appendChild(cv); var g = cv.getContext('2d'), im = g.createImageData(320, 180), stop = Date.now() + 1500; staticNoise(audio() && audio().currentTime, 1.5, 0.35); (function n() { if (Date.now() > stop) return go(); for (var i = 0; i < im.data.length; i += 4) { var v = Math.random() * 255; im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = 255; } g.putImageData(im, 0, 0); requestAnimationFrame(n); })(); },
    creep: function (ov, go) { ov.style.background = 'rgba(0,0,0,0)'; ov.style.transition = 'background 3s ease-in'; ov.style.pointerEvents = 'none'; requestAnimationFrame(function () { ov.style.background = 'rgba(0,0,0,.95)'; }); var w = document.createElement('div'); w.style.cssText = 'color:#8a0000;font:700 24px Georgia,serif;letter-spacing:4px;text-shadow:0 0 14px #f00'; ov.appendChild(w); setTimeout(function () { typeText(w, "...don't turn around", 90); }, 900); var a = audio(); if (a) { heartbeat(a.currentTime + 0.2, 6, 0.06); drone(a.currentTime, 3.6); } setTimeout(go, 3800); },
    glitch: function (ov, go) { ov.style.background = 'transparent'; ov.style.pointerEvents = 'none'; var b = document.body, steps = 0; var old = b.style.filter; staticNoise(audio() && audio().currentTime, 2.2, 0.15);
      var iv = setInterval(function () { steps++; b.style.filter = 'hue-rotate(' + Math.random() * 360 + 'deg) contrast(' + (1 + Math.random() * 3) + ')' + (Math.random() < 0.3 ? ' invert(1)' : ''); b.style.transform = 'translate(' + (Math.random() - .5) * 40 + 'px,' + (Math.random() - .5) * 20 + 'px) skewX(' + (Math.random() - .5) * 20 + 'deg)'; if (steps === 14) { ov.style.background = '#000'; var t = document.createElement('div'); t.style.cssText = 'color:#ff1a1a;font:900 min(9vw,90px) Impact,sans-serif;letter-spacing:6px;text-align:center;animation:grJit .06s infinite;text-shadow:4px 0 #0ff,-4px 0 #f0f'; t.textContent = 'I SEE YOU, ' + name().toUpperCase(); ov.appendChild(t); } if (steps > 24) { clearInterval(iv); b.style.filter = old; b.style.transform = ''; go(); } }, 90); },
    crash: function (ov, go) { ov.style.background = '#fff'; ov.style.cursor = 'default'; ov.innerHTML = '<div style="font-family:Segoe UI,system-ui,sans-serif;color:#5f6368;max-width:520px;padding:20px"><div style="font-size:64px;margin-bottom:24px">🙁</div><div style="font-size:26px;color:#202124;margin-bottom:12px">Aw, Snap!</div><div style="font-size:15px;margin-bottom:6px">Something went wrong while displaying this webpage.</div><div style="font-size:13px;margin:16px 0">Error code: STATUS_ACCESS_VIOLATION</div><button style="background:#1a73e8;color:#fff;border:none;border-radius:4px;padding:9px 20px;font-size:14px">Reload</button></div>'; setTimeout(go, 2600); },
    hallway: function (ov, go) { var a = audio(); if (a) drone(a.currentTime, 4); var eyes = document.createElement('div'); eyes.style.cssText = 'position:absolute;left:50%;top:48%;transform:translate(-50%,-50%) scale(.2);transition:transform .08s;display:flex;gap:60px'; eyes.innerHTML = '<span style="width:30px;height:16px;border-radius:50%;background:#f00;box-shadow:0 0 30px #f00,0 0 60px #f00"></span><span style="width:30px;height:16px;border-radius:50%;background:#f00;box-shadow:0 0 30px #f00,0 0 60px #f00"></span>'; ov.appendChild(eyes); var sc = [0.25, 0.6, 1.3, 2.6]; sc.forEach(function (s, i) { setTimeout(function () { eyes.style.opacity = 1; eyes.style.transform = 'translate(-50%,-50%) scale(' + s + ')'; if (a) knock(a.currentTime, 1); setTimeout(function () { eyes.style.opacity = 0; }, 260); }, 600 + i * 900); }); setTimeout(go, 600 + sc.length * 900); },
    whisper: function (ov, go) { var a = audio(); if (a) whisperSnd(a.currentTime, 3.4); var t = document.createElement('div'); t.style.cssText = 'color:#ddd;font:italic 400 26px Georgia,serif;letter-spacing:2px;opacity:.85;text-align:center;line-height:2'; ov.appendChild(t); typeText(t, name().toLowerCase() + '... ' + name().toLowerCase() + '...\nlook behind you', 95, function () { setTimeout(go, 500); }); t.style.whiteSpace = 'pre'; },
    knock: function (ov, go) { ov.style.background = 'rgba(0,0,0,.0)'; ov.style.pointerEvents = 'none'; ov.style.transition = 'background .6s'; var a = audio(); if (a) { knock(a.currentTime + 0.3, 3); knock(a.currentTime + 2.2, 3); } setTimeout(function () { ov.style.background = 'rgba(0,0,0,.6)'; }, 2000); setTimeout(go, 4000); },
    blackout: function (ov, go) { var a = audio(); if (a) { drone(a.currentTime, 3); heartbeat(a.currentTime + 0.4, 4, 0.08); } var t = document.createElement('div'); t.style.cssText = 'color:#555;font:600 14px monospace'; t.textContent = 'connection lost'; ov.appendChild(t); setTimeout(function () { t.textContent = ''; }, 1500); setTimeout(go, 3000); }
  };
  var scaring = false;
  function scare(kind) {
    if (scaring || !document.body) return; scaring = true; css(); audio();
    var ov = overlay();
    try { SCARES[kind](ov, function () { showFace(ov, function () { scaring = false; }); }); } catch (e) { showFace(ov, function () { scaring = false; }); }
  }

  // =============== trolls ===============
  function sty(text) { var s = document.createElement('style'); s.textContent = text; document.head.appendChild(s); return function () { s.remove(); }; }
  function fart() { var a = audio(); if (!a) return; var t = a.currentTime, o = a.createOscillator(), g = a.createGain(), f = a.createBiquadFilter(); o.type = 'sawtooth'; o.frequency.setValueAtTime(95 + Math.random() * 40, t); o.frequency.linearRampToValueAtTime(55, t + 0.5); var l = a.createOscillator(), lg = a.createGain(); l.frequency.value = 22 + Math.random() * 14; lg.gain.value = 30; l.connect(lg); lg.connect(o.frequency); f.type = 'lowpass'; f.frequency.value = 700; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.6, t + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55); o.connect(f); f.connect(g); g.connect(a.destination); o.start(t); l.start(t); o.stop(t + 0.6); l.stop(t + 0.6); }
  function crashSound() { var a = audio(); if (!a) return; var n = a.createBufferSource(); n.buffer = noiseBuf(a, 0.7, function (u) { return Math.pow(1 - u, 3) * (Math.random() < 0.3 ? 1 : 0.3); }); var f = a.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 1800; var g = a.createGain(); g.gain.value = 1.2; n.connect(f); f.connect(g); g.connect(a.destination); n.start(); }
  function htmlStyle(prop, val) { var el = document.documentElement, old = el.style[prop]; el.style[prop] = val; return function () { el.style[prop] = old; }; }
  function box(html, extra) { var d = document.createElement('div'); d.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2147483646;background:#fff;color:#111;border-radius:10px;box-shadow:0 20px 60px rgba(0,0,0,.6);font:500 15px Segoe UI,system-ui,sans-serif;padding:22px 26px;min-width:320px;max-width:90vw;text-align:center;' + (extra || ''); d.innerHTML = html; document.documentElement.appendChild(d); return d; }
  var TROLLS = {
    flip: function () { document.documentElement.style.transition = 'transform 1s'; return htmlStyle('transform', 'rotate(180deg)'); },
    mirror: function () { return htmlStyle('transform', 'scaleX(-1)'); },
    spin: function () { css(); return htmlStyle('animation', 'grSpin 3s linear infinite'); },
    shake: function () { css(); return htmlStyle('animation', 'grShake .12s linear infinite'); },
    drunk: function () { css(); var a = htmlStyle('animation', 'grWob 2.4s ease-in-out infinite'), b = htmlStyle('filter', 'blur(1.4px)'); return function () { a(); b(); }; },
    invert: function () { return htmlStyle('filter', 'invert(1) hue-rotate(180deg)'); },
    blur: function () { return htmlStyle('filter', 'blur(5px)'); },
    rainbow: function () { css(); return htmlStyle('animation', 'grHue 2s linear infinite'); },
    tiny: function () { document.documentElement.style.transition = 'transform .8s'; return htmlStyle('transform', 'scale(.3)'); },
    giant: function () { document.documentElement.style.transition = 'transform .8s'; return htmlStyle('transform', 'scale(2.6)'); },
    zoom: function (dur) { document.documentElement.style.transition = 'transform ' + dur + 's linear'; var r = htmlStyle('transform', 'scale(1)'); requestAnimationFrame(function () { document.documentElement.style.transform = 'scale(2.2) rotate(8deg)'; }); return function () { document.documentElement.style.transition = ''; r(); }; },
    comic: function () { return sty('*{font-family:"Comic Sans MS","Comic Sans",cursive !important}'); },
    blink: function () { css(); return htmlStyle('animation', 'grBlink 1.3s infinite'); },
    gravity: function () {
      var els = Array.prototype.slice.call(document.querySelectorAll('button,a,h1,h2,h3,h4,p,img,canvas,input,select,.card,.pc,.tile,span.chip,label')).filter(function (e) { var r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4 && r.width < innerWidth * 0.9 && r.bottom > 0 && r.top < innerHeight; }).slice(0, 90);
      var st = els.map(function (e) { var r = e.getBoundingClientRect(); return { e: e, y: 0, vy: -Math.random() * 3, rot: 0, vr: (Math.random() - .5) * 6, bottom: r.bottom, old: e.style.transform, delay: Math.random() * 40 }; }), on = true;
      (function f() { if (!on) return; st.forEach(function (s) { if (s.delay > 0) { s.delay--; return; } s.vy += 0.6; s.y += s.vy; s.rot += s.vr; if (s.bottom + s.y > innerHeight) { s.y = innerHeight - s.bottom; s.vy *= -0.35; s.vr *= 0.6; } s.e.style.transform = 'translateY(' + s.y + 'px) rotate(' + s.rot + 'deg)'; }); requestAnimationFrame(f); })();
      return function () { on = false; st.forEach(function (s) { s.e.style.transform = s.old; }); };
    },
    runaway: function () {
      var off = new Map(), h = function (e) { document.querySelectorAll('button,a,input,select,.tile,.card,.gcard').forEach(function (b) { var r = b.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2, dx = cx - e.clientX, dy = cy - e.clientY, d = Math.hypot(dx, dy); if (d < 140) { var o = off.get(b) || { x: 0, y: 0, old: b.style.transform }; var bl = r.left - o.x, bt = r.top - o.y; o.x += dx / (d || 1) * 60; o.y += dy / (d || 1) * 60; o.x = Math.max(-bl, Math.min(innerWidth - bl - r.width, o.x)); o.y = Math.max(-bt, Math.min(innerHeight - bt - r.height, o.y)); off.set(b, o); b.style.transition = 'transform .15s'; b.style.transform = 'translate(' + o.x + 'px,' + o.y + 'px)'; } }); };
      addEventListener('mousemove', h, true); return function () { removeEventListener('mousemove', h, true); off.forEach(function (o, b) { b.style.transform = o.old; }); };
    },
    spiders: function () {
      var bugs = [], on = true; for (var i = 0; i < 14; i++) { var d = document.createElement('div'); d.textContent = '🕷️'; d.style.cssText = 'position:fixed;z-index:2147483646;font-size:' + (26 + Math.random() * 26) + 'px;pointer-events:none;left:0;top:0'; document.documentElement.appendChild(d); bugs.push({ d: d, x: Math.random() * innerWidth, y: -40 - Math.random() * 300, a: Math.PI / 2 + (Math.random() - .5), v: 1.5 + Math.random() * 2.5 }); }
      (function f() { if (!on) return; bugs.forEach(function (b) { b.a += (Math.random() - .5) * 0.35; b.x += Math.cos(b.a) * b.v; b.y += Math.sin(b.a) * b.v; if (b.x < 0 || b.x > innerWidth) b.a = Math.PI - b.a; if (b.y > innerHeight + 40) { b.y = -40; } if (b.y < -60) b.a = Math.PI / 2; b.d.style.transform = 'translate(' + b.x + 'px,' + b.y + 'px) rotate(' + (b.a + Math.PI / 2) + 'rad)'; }); requestAnimationFrame(f); })();
      return function () { on = false; bugs.forEach(function (b) { b.d.remove(); }); };
    },
    crack: function () {
      crashSound(); var ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg'); svg.setAttribute('width', '100%'); svg.setAttribute('height', '100%'); svg.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none';
      var cx = innerWidth * (0.3 + Math.random() * 0.4), cy = innerHeight * (0.3 + Math.random() * 0.4), path = '';
      for (var i = 0; i < 16; i++) { var a = i / 16 * Math.PI * 2 + Math.random() * 0.3, x = cx, y = cy; path += 'M' + x + ' ' + y; for (var k = 0; k < 7; k++) { a += (Math.random() - .5) * 0.5; var L = 30 + Math.random() * 90; x += Math.cos(a) * L; y += Math.sin(a) * L; path += 'L' + x + ' ' + y; } }
      for (var r = 30; r < 200; r += 45) { path += 'M' + (cx + r) + ' ' + cy; for (var q = 1; q <= 12; q++) { var aa = q / 12 * Math.PI * 2, rr = r * (0.8 + Math.random() * 0.4); path += 'L' + (cx + Math.cos(aa) * rr) + ' ' + (cy + Math.sin(aa) * rr); } }
      [['rgba(0,0,0,.55)', 3.5], ['rgba(255,255,255,.85)', 1.2]].forEach(function (p) { var e = document.createElementNS(ns, 'path'); e.setAttribute('d', path); e.setAttribute('stroke', p[0]); e.setAttribute('stroke-width', p[1]); e.setAttribute('fill', 'none'); svg.appendChild(e); });
      document.documentElement.appendChild(svg); return function () { svg.remove(); };
    },
    fart: function () { var h = function () { fart(); }; addEventListener('pointerdown', h, true); addEventListener('keydown', h, true); fart(); return function () { removeEventListener('pointerdown', h, true); removeEventListener('keydown', h, true); }; },
    freeze: function () { var ov = document.createElement('div'); ov.style.cssText = 'position:fixed;inset:0;z-index:2147483646;cursor:wait;background:rgba(255,255,255,.08)'; ov.addEventListener('pointerdown', function (e) { e.preventDefault(); e.stopPropagation(); }, true); document.documentElement.appendChild(ov); var t = document.title; document.title = t + ' (Not Responding)'; var f = htmlStyle('filter', 'grayscale(.6) brightness(.85)'); var k = function (e) { e.preventDefault(); e.stopPropagation(); }; addEventListener('keydown', k, true); return function () { ov.remove(); document.title = t; f(); removeEventListener('keydown', k, true); }; },
    loading: function (dur, text) { var d = box('<div style="font-weight:700;font-size:17px;margin-bottom:12px">' + esc(text || 'Deleting homework folder…') + '</div><div style="height:14px;background:#e6e6e6;border-radius:7px;overflow:hidden"><div id="grbar" style="height:100%;width:0;background:#e5484d;transition:width .3s"></div></div><div id="grpct" style="margin-top:8px;font-weight:700">0%</div>'); var p = 0, iv = setInterval(function () { p = Math.min(100, p + Math.random() * 100 / (dur * 2.5)); d.querySelector('#grbar').style.width = p + '%'; d.querySelector('#grpct').textContent = Math.floor(p) + '%'; if (p >= 100) { clearInterval(iv); d.querySelector('#grpct').textContent = 'Done. 100 files deleted… jk 😜'; } }, 400); return function () { clearInterval(iv); d.remove(); }; },
    typeit: function (dur, text) { var phrase = (text || 'conner is the goat').slice(0, 60), ov = document.createElement('div'); ov.style.cssText = 'position:fixed;inset:0;z-index:2147483645;background:rgba(0,0,0,.7)'; document.documentElement.appendChild(ov); var d = box('<div style="font-weight:800;font-size:18px;margin-bottom:6px">🔒 Verification required</div><div style="margin-bottom:12px">Type <b>' + esc(phrase) + '</b> to keep playing</div><input style="width:100%;font:600 16px system-ui;padding:9px;border:2px solid #ccc;border-radius:8px" autocomplete="off"><div style="color:#c00;font-size:13px;margin-top:6px;min-height:16px"></div>'); var inp = d.querySelector('input'), err = d.querySelector('div:last-child'); setTimeout(function () { inp.focus(); }, 50); var close = function () { ov.remove(); d.remove(); }; inp.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Enter') { if (inp.value.trim().toLowerCase() === phrase.toLowerCase()) { close(); ack('typed it'); } else { err.textContent = 'Wrong. Try again.'; inp.select(); } } }, true); return close; },
    ban: function (dur) { var ov = overlay('#111'); ov.style.cursor = 'default'; ov.innerHTML = '<div style="text-align:center;color:#fff;font-family:system-ui"><div style="font-size:70px">⛔</div><div style="font:900 34px system-ui;margin:10px 0;color:#ff4d4d">You have been banned</div><div style="color:#aaa">Reason: being too good at games<br>Ban ends in <b id="grban">' + dur + '</b> seconds</div></div>'; var n = dur, iv = setInterval(function () { n--; var e = ov.querySelector('#grban'); if (e) e.textContent = Math.max(0, n); }, 1000); return function () { clearInterval(iv); ov.innerHTML = '<div style="color:#fff;font:800 40px system-ui">jk 😜</div>'; setTimeout(function () { ov.remove(); }, 1200); }; },
    popups: function () { var list = [], spawn = function () { if (list.length > 28) return; var d = box('<div style="font-weight:700;margin-bottom:12px">' + ['Are you sure?', 'Are you REALLY sure?', 'Error: success', 'Click OK to continue', 'Your computer is too cool', 'Task failed successfully'][Math.floor(Math.random() * 6)] + '</div><button style="background:#1a73e8;color:#fff;border:none;border-radius:6px;padding:8px 22px;font-weight:700;cursor:pointer">OK</button>', 'left:' + (10 + Math.random() * 60) + '%;top:' + (10 + Math.random() * 60) + '%;transform:none;min-width:240px'); list.push(d); d.querySelector('button').onclick = function () { d.remove(); spawn(); spawn(); }; }; spawn(); return function () { list.forEach(function (d) { d.remove(); }); list = []; spawn = function () {}; }; },
    cursors: function () { var cs = [], pos = [], on = true, mx = innerWidth / 2, my = innerHeight / 2; var mv = function (e) { mx = e.clientX; my = e.clientY; }; addEventListener('mousemove', mv, true); for (var i = 0; i < 10; i++) { var d = document.createElement('div'); d.innerHTML = '<svg width="18" height="26" viewBox="0 0 18 26"><path d="M1 1 L1 20 L6 15 L10 24 L13 23 L9 14 L16 14 Z" fill="#fff" stroke="#000" stroke-width="1.5"/></svg>'; d.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483646;pointer-events:none'; document.documentElement.appendChild(d); cs.push(d); pos.push([mx, my, Math.random() * 6.28]); }
      (function f() { if (!on) return; cs.forEach(function (d, i) { var p = pos[i]; p[2] += 0.03 + i * 0.004; var tx = mx + Math.cos(p[2] * (i % 2 ? 1 : -1)) * (40 + i * 18), ty = my + Math.sin(p[2]) * (30 + i * 14); p[0] += (tx - p[0]) * 0.08; p[1] += (ty - p[1]) * 0.08; d.style.transform = 'translate(' + p[0] + 'px,' + p[1] + 'px)'; }); requestAnimationFrame(f); })();
      return function () { on = false; removeEventListener('mousemove', mv, true); cs.forEach(function (d) { d.remove(); }); }; },
    monkeys: function () { var on = true, list = [], iv = setInterval(function () { var d = document.createElement('div'); d.textContent = ['🐒', '🙈', '🍌', '🐵'][Math.floor(Math.random() * 4)]; d.style.cssText = 'position:fixed;top:-60px;left:' + Math.random() * 100 + 'vw;z-index:2147483646;font-size:' + (30 + Math.random() * 40) + 'px;pointer-events:none;transition:transform ' + (2 + Math.random() * 2) + 's linear'; document.documentElement.appendChild(d); list.push(d); requestAnimationFrame(function () { d.style.transform = 'translateY(' + (innerHeight + 120) + 'px) rotate(' + (Math.random() * 720 - 360) + 'deg)'; }); setTimeout(function () { d.remove(); }, 4200); }, 120); return function () { clearInterval(iv); list.forEach(function (d) { d.remove(); }); }; },
    party: function () { css(); var a = htmlStyle('animation', 'grHue 1s linear infinite'), m = TROLLS.monkeys(); var au = audio(); if (au) [523, 659, 784, 1046, 784, 1046].forEach(function (f, i) { var o = au.createOscillator(), g = au.createGain(), t = au.currentTime + i * 0.13; o.type = 'square'; o.frequency.value = f; g.gain.setValueAtTime(0.06, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12); o.connect(g); g.connect(au.destination); o.start(t); o.stop(t + 0.13); }); return function () { a(); m(); }; },
    knock: function () { var a = audio(); if (a) { knock(a.currentTime + 0.1, 3); knock(a.currentTime + 2.5, 3); } return function () {}; },
    whisper: function () { var a = audio(); if (a) whisperSnd(a.currentTime, 3); var d = document.createElement('div'); d.style.cssText = 'position:fixed;left:50%;bottom:8%;transform:translateX(-50%);z-index:2147483646;color:rgba(160,0,0,.85);font:italic 22px Georgia,serif;letter-spacing:3px;pointer-events:none;text-shadow:0 0 10px #f00'; document.documentElement.appendChild(d); typeText(d, name().toLowerCase() + '... i can see you', 110); return function () { d.remove(); }; },
    upside: function () { return sty('body *{transform:rotate(180deg)}'); },
    lag: function () { var on = true; (function f() { if (!on) return; var t = Date.now() + 120 + Math.random() * 250; while (Date.now() < t) {} setTimeout(f, 300 + Math.random() * 700); })(); return function () { on = false; }; }
  };
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var active = {};
  function troll(kind, dur, text) {
    if (!document.body) return; if (active[kind]) { clearTimeout(active[kind].t); active[kind].stop(); }
    var stop = function () {}; try { stop = TROLLS[kind](dur, text) || stop; } catch (e) {}
    active[kind] = { stop: stop, t: setTimeout(function () { try { stop(); } catch (e) {} delete active[kind]; }, dur * 1000) };
    ack(kind);
  }

  function showMsg(text, style) {
    var b = document.createElement('div'); b.setAttribute('role', 'alert');
    if (style === 'big') { b.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;padding:30px;cursor:pointer'; var t = document.createElement('div'); t.style.cssText = 'color:#fff;font:900 min(7vw,64px) system-ui,sans-serif;text-align:center;text-shadow:0 4px 0 #000'; t.textContent = text; b.appendChild(t); }
    else { b.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:2147483646;background:#ffcc33;color:#1a1300;font:700 16px system-ui,sans-serif;padding:12px 18px;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.45);max-width:90vw;cursor:pointer;text-align:center'; b.textContent = '📣 ' + text; }
    b.onclick = function () { b.remove(); }; document.documentElement.appendChild(b); setTimeout(function () { if (b.parentNode) b.remove(); }, style === 'big' ? 6000 : 9000);
  }

  window.GR = { name: name, setName: function (n) { set('gr_name', String(n).slice(0, 20)); if (FB) beat(); else send(); }, hasName: function () { return !!get('gr_name'); }, id: id, FB: FB, test: { scare: scare, troll: troll, msg: showMsg, list: function () { return { scares: Object.keys(SCARES), trolls: Object.keys(TROLLS) }; } } };
  if (!isAdmin) setTimeout(function () { if (FB) startFB(); else startPeer(); }, 800);
})();
