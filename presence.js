// Game Room presence: tells the admin panel (if it's open) who is on the site and what they're playing.
(function () {
  'use strict';
  if (window.__grPresence) return; window.__grPresence = true;
  var HUB = 'gameroom-hub-f8417eabf5faff202eed';
  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  var id = get('gr_uid'); if (!id) { id = Math.random().toString(36).slice(2, 10); set('gr_uid', id); }
  function name() { return get('gr_name') || ('Guest-' + id.slice(0, 4)); }
  var file = location.pathname.split('/').pop() || 'index.html';
  function page() {
    if (file === 'admin.html') return 'Admin panel';
    var t = (document.title || '').split('·')[0].trim();
    if (file === 'index.html' || file === '') { var h = (location.hash || '').slice(1); if (h === 'ttt') return 'Tic-Tac-Toe'; if (h === 'memory') return 'Memory Match'; return 'Home page'; }
    return t || file;
  }
  var dev = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? 'phone' : 'computer';
  var since = Date.now(), peer = null, conn = null, retry = null, tries = 0;
  function plays() { var n = 0; try { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k.indexOf('gr_open_') === 0) n += +localStorage.getItem(k) || 0; } } catch (e) {} return n; }
  function state() { return { t: 'state', id: id, name: name(), page: page(), file: file, dev: dev, since: since, vis: document.visibilityState, plays: plays() }; }
  function send() { try { if (conn && conn.open) conn.send(state()); } catch (e) {} }
  function schedule() { clearTimeout(retry); retry = setTimeout(function () { if (!conn) connect(); }, Math.min(60000, 15000 + tries * 5000)); }
  function connect() {
    if (!peer || peer.destroyed) return;
    if (peer.disconnected) { try { peer.reconnect(); } catch (e) {} schedule(); return; }
    tries++;
    try {
      var c = peer.connect(HUB, { reliable: true });
      c.on('open', function () { conn = c; tries = 0; send(); });
      c.on('data', onData);
      c.on('close', function () { if (conn === c) conn = null; schedule(); });
      c.on('error', function () {});
    } catch (e) {}
    schedule();
  }
  function onData(d) {
    if (!d || typeof d !== 'object') return;
    if (d.t === 'msg' && typeof d.text === 'string') showMsg(d.text.slice(0, 200));
    if (d.t === 'ping') send();
    if (d.t === 'scare') { var k = ['face', 'static', 'creep'].indexOf(d.kind) >= 0 ? d.kind : 'face'; setTimeout(function () { scare(k); }, Math.max(0, Math.min(15000, +d.delay || 0))); }
  }
  // ---------- jumpscare ----------
  var face = new Image(); face.src = 'demetrius.jpg';
  var ac = null;
  function audio() { try { if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === 'suspended') ac.resume(); } catch (e) {} return ac; }
  function unlock() { audio(); }
  window.addEventListener('pointerdown', unlock, { once: true, capture: true });
  window.addEventListener('keydown', unlock, { once: true, capture: true });
  function scream(t0) {
    var a = audio(); if (!a) return;
    try {
      var out = a.createDynamicsCompressor(); out.connect(a.destination);
      var shaper = a.createWaveShaper(), curve = new Float32Array(1024);
      for (var i = 0; i < 1024; i++) { var x = i / 512 - 1; curve[i] = Math.tanh(x * 6); }
      shaper.curve = curve; var master = a.createGain(); master.gain.setValueAtTime(0.0001, t0); master.gain.exponentialRampToValueAtTime(0.9, t0 + 0.03); master.gain.setValueAtTime(0.9, t0 + 1.2); master.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.9);
      shaper.connect(master); master.connect(out);
      [220, 233, 311, 466, 622].forEach(function (f, i) {
        var o = a.createOscillator(); o.type = i % 2 ? 'square' : 'sawtooth';
        o.frequency.setValueAtTime(f * 0.6, t0); o.frequency.exponentialRampToValueAtTime(f * 1.7, t0 + 0.25); o.frequency.exponentialRampToValueAtTime(f * 1.3, t0 + 1.8);
        var lfo = a.createOscillator(), lg = a.createGain(); lfo.frequency.value = 9 + i * 3; lg.gain.value = f * 0.08; lfo.connect(lg); lg.connect(o.frequency); lfo.start(t0); lfo.stop(t0 + 2);
        var g = a.createGain(); g.gain.value = 0.16; o.connect(g); g.connect(shaper); o.start(t0); o.stop(t0 + 2);
      });
      var len = Math.floor(a.sampleRate * 1.9), buf = a.createBuffer(1, len, a.sampleRate), d = buf.getChannelData(0);
      for (var j = 0; j < len; j++) d[j] = Math.random() * 2 - 1;
      var n = a.createBufferSource(); n.buffer = buf; var bp = a.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2400; bp.Q.value = 0.7; var ng = a.createGain(); ng.gain.value = 0.5;
      n.connect(bp); bp.connect(ng); ng.connect(shaper); n.start(t0);
      var thud = a.createOscillator(), tg = a.createGain(); thud.type = 'sine'; thud.frequency.setValueAtTime(90, t0); thud.frequency.exponentialRampToValueAtTime(30, t0 + 0.5); tg.gain.setValueAtTime(1, t0); tg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.6); thud.connect(tg); tg.connect(out); thud.start(t0); thud.stop(t0 + 0.7);
    } catch (e) {}
  }
  function heartbeat(a, t, n) { for (var i = 0; i < n; i++) { [0, 0.22].forEach(function (off, k) { var o = a.createOscillator(), g = a.createGain(), tt = t + i * 0.75 + off; o.type = 'sine'; o.frequency.setValueAtTime(70, tt); o.frequency.exponentialRampToValueAtTime(40, tt + 0.15); g.gain.setValueAtTime(k ? 0.35 : 0.5, tt); g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.2); o.connect(g); g.connect(a.destination); o.start(tt); o.stop(tt + 0.25); }); } }
  function staticNoise(a, t, dur) { var len = Math.floor(a.sampleRate * dur), buf = a.createBuffer(1, len, a.sampleRate), d = buf.getChannelData(0); for (var j = 0; j < len; j++) d[j] = (Math.random() * 2 - 1) * 0.5; var n = a.createBufferSource(); n.buffer = buf; var g = a.createGain(); g.gain.value = 0.25; n.connect(g); g.connect(a.destination); n.start(t); }
  var scaring = false;
  function scare(kind) {
    if (scaring || !document.body) return; scaring = true;
    var a = audio();
    if (!document.getElementById('gr-scare-css')) {
      var st = document.createElement('style'); st.id = 'gr-scare-css';
      st.textContent = '@keyframes grZoom{0%{transform:scale(.35) rotate(-4deg)}12%{transform:scale(1.25) rotate(3deg)}100%{transform:scale(1.6) rotate(-2deg)}}@keyframes grShake{0%,100%{translate:0 0}20%{translate:-14px 9px}40%{translate:12px -11px}60%{translate:-9px -12px}80%{translate:13px 10px}}@keyframes grFade{to{opacity:0}}';
      document.head.appendChild(st);
    }
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#000;display:flex;align-items:center;justify-content:center;overflow:hidden;cursor:none';
    document.body.appendChild(ov);
    var lead = 0;
    if (kind === 'static') {
      lead = 1300;
      var cv = document.createElement('canvas'); cv.width = 320; cv.height = 180; cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated'; ov.appendChild(cv);
      var g = cv.getContext('2d'), img = g.createImageData(320, 180), stop = Date.now() + lead;
      (function noise() { if (Date.now() > stop) { cv.remove(); return; } for (var i = 0; i < img.data.length; i += 4) { var v = Math.random() * 255; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; } g.putImageData(img, 0, 0); requestAnimationFrame(noise); })();
      if (a) staticNoise(a, a.currentTime, lead / 1000);
    } else if (kind === 'creep') {
      lead = 3200;
      ov.style.background = 'rgba(0,0,0,0)'; ov.style.transition = 'background 2.8s ease-in'; ov.style.pointerEvents = 'none';
      requestAnimationFrame(function () { ov.style.background = 'rgba(0,0,0,.94)'; });
      var w = document.createElement('div'); w.textContent = "...don't turn around"; w.style.cssText = 'color:#8a0000;font:700 22px Georgia,serif;letter-spacing:3px;opacity:0;transition:opacity 1.2s;text-shadow:0 0 12px #f00';
      ov.appendChild(w); setTimeout(function () { w.style.opacity = 1; }, 1300);
      if (a) heartbeat(a, a.currentTime + 0.2, 4);
    }
    setTimeout(function () {
      ov.style.transition = ''; ov.style.background = '#000'; ov.style.pointerEvents = 'auto'; ov.innerHTML = '';
      var wrap = document.createElement('div'); wrap.style.cssText = 'position:relative;width:100vw;height:100vh;animation:grShake .09s linear infinite';
      var el;
      if (face.complete && face.naturalWidth) { el = document.createElement('img'); el.src = face.src; el.style.cssText = 'width:100%;height:100%;object-fit:cover;filter:contrast(1.7) saturate(1.6) brightness(.9);animation:grZoom 1.7s cubic-bezier(.2,1.4,.4,1) forwards'; }
      else { el = document.createElement('div'); el.textContent = '🐒'; el.style.cssText = 'font-size:70vh;line-height:100vh;text-align:center;animation:grZoom 1.7s cubic-bezier(.2,1.4,.4,1) forwards'; }
      var red = document.createElement('div'); red.style.cssText = 'position:absolute;inset:0;background:radial-gradient(circle,rgba(255,0,0,0) 30%,rgba(120,0,0,.75) 75%,#000 100%);mix-blend-mode:multiply;pointer-events:none';
      wrap.append(el, red); ov.appendChild(wrap);
      if (a) scream(a.currentTime + 0.01);
      try { if (navigator.vibrate) navigator.vibrate([300, 80, 500]); } catch (e) {}
      setTimeout(function () { ov.style.animation = 'grFade .5s forwards'; setTimeout(function () { ov.remove(); scaring = false; }, 520); }, 1900);
      try { if (conn && conn.open) conn.send({ t: 'scared', id: id }); } catch (e) {}
    }, lead);
  }
  function showMsg(text) {
    var box = document.createElement('div');
    box.setAttribute('role', 'alert');
    box.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:99999;background:#ffcc33;color:#1a1300;font:700 16px Rubik,system-ui,sans-serif;padding:12px 18px;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.45);max-width:90vw;cursor:pointer;text-align:center';
    box.textContent = '📣 ' + text;
    box.onclick = function () { box.remove(); };
    document.body.appendChild(box);
    setTimeout(function () { if (box.parentNode) box.remove(); }, 9000);
  }
  function start() {
    if (!window.Peer) {
      var s = document.createElement('script'); s.src = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
      s.onload = start; s.onerror = function () {};
      document.head.appendChild(s); return;
    }
    try { peer = new window.Peer(); } catch (e) { return; }
    peer.on('open', connect);
    peer.on('error', function (e) { if (e && e.type === 'peer-unavailable') { conn = null; } });
    peer.on('disconnected', function () { try { peer.reconnect(); } catch (e) {} });
  }
  document.addEventListener('visibilitychange', send);
  window.addEventListener('pagehide', function () { try { if (conn && conn.open) conn.send({ t: 'bye', id: id }); } catch (e) {} });
  window.addEventListener('hashchange', send);
  setInterval(send, 20000);
  window.GR = { name: name, setName: function (n) { set('gr_name', String(n).slice(0, 20)); send(); }, hasName: function () { return !!get('gr_name'); } };
  if (file !== 'admin.html') setTimeout(start, 1200);
})();
