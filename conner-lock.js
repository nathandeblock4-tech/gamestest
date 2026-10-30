// Shared password lock for Conner games. Usage: connerLock('Game Title', '#accent', img => { ...start... })
(function () {
  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function save(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  async function decrypt(file, pw) {
    const raw = new Uint8Array(await (await fetch(file, { cache: 'no-store' })).arrayBuffer());
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: raw.slice(0, 16), iterations: 200000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(16, 28) }, key, raw.slice(28));
    return URL.createObjectURL(new Blob([plain], { type: 'image/jpeg' }));
  }
  window.connerLock = function (title, accent, cb) {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;inset:0;z-index:100;background:#10111f;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;text-align:center;padding:16px;font-family:Rubik,system-ui,sans-serif;color:#fff';
    d.innerHTML = '<div style="font-size:54px">🔒</div><h2 style="font-weight:900;font-size:22px;letter-spacing:2px"></h2><div style="color:#9aa0c7">This game is locked. Enter the password.</div>' +
      '<form style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center"><input type="password" placeholder="Password" autocomplete="off" style="background:#1a1c35;border:2px solid #2c3060;border-radius:10px;color:#fff;font:700 18px Rubik,sans-serif;padding:10px 14px;width:220px;text-align:center">' +
      '<button style="border:none;border-radius:10px;padding:11px 20px;font:800 16px Rubik,sans-serif;cursor:pointer;color:#111">Unlock</button></form><div class="m" style="font-weight:700;min-height:20px"></div>' +
      '<a href="index.html" style="color:#fff;background:#24274a;padding:8px 14px;border-radius:10px;text-decoration:none;font-weight:700">← Back</a>';
    d.querySelector('h2').textContent = title; d.querySelector('h2').style.color = accent; d.querySelector('button').style.background = accent;
    document.body.appendChild(d);
    const msg = d.querySelector('.m'), inp = d.querySelector('input');
    async function tryPw(pw, remember) {
      msg.style.color = '#9aa0c7'; msg.textContent = 'Checking...';
      try {
        const url = await decrypt('conner_tung.bin', pw);
        const img = new Image(); img.onload = () => { d.remove(); cb(img); }; img.src = url;
        if (remember) save('fnac_pw', pw);
      } catch (e) { msg.style.color = '#ff8a8a'; msg.textContent = 'Wrong password.'; try { localStorage.removeItem('fnac_pw'); } catch (er) {} }
    }
    d.querySelector('form').addEventListener('submit', e => { e.preventDefault(); tryPw(inp.value, true); });
    if (load('fnac_pw')) tryPw(load('fnac_pw'), false); else setTimeout(() => inp.focus(), 100);
  };
  // draws the photo face clipped to an ellipse
  window.drawConnerHead = function (g, img, x, y, w, rot, ring) {
    const h = w * 1.2; g.save(); g.translate(x, y); if (rot) g.rotate(rot);
    g.beginPath(); g.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
    if (ring) { g.lineWidth = ring; g.strokeStyle = '#111'; g.stroke(); }
    g.clip(); g.drawImage(img, -w / 2, -h / 2, w, h); g.restore();
  };
})();
