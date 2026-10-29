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
