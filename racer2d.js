// Trackstorm "Basic" graphics: draws the game with a plain 2D canvas, for computers where WebGL is turned off.
// Same physics, tracks, medals and ghosts as the 3D version; only the drawing is simpler.
import { buildTrack, newCar, stepCar, respawnCar, axes, botInput, TRACKS, CAR, ROADW } from './racer-core.js';

const $ = id => document.getElementById(id);
function ld(k, d) { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? d : v; } catch (e) { return d; } }
function sv(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
const fmt = t => Math.floor(t / 60) + ':' + (t % 60).toFixed(2).padStart(5, '0');
const MED = [['🥉', 'Bronze', 1.5], ['🥈', 'Silver', 1.22], ['🥇', 'Gold', 1.08], ['💎', 'Author', 1.0]];
const tid = i => { let h = 0; for (const ch of TRACKS[i].path) h = (h * 31 + ch.charCodeAt(0)) | 0; return TRACKS[i].name.replace(/\W/g, '') + (h >>> 0).toString(36); }, beats = (t, target) => Math.round(t * 100) <= Math.round(target * 100);
const par = i => TRACKS[i].par || 60, HW = ROADW / 2, RAILH = 1.15;
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp3 = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const THEMES = {
  meadow: { sky: ['#2f7fe8', '#cfe6fb'], fog: [207, 230, 251], ground: [92, 170, 76], leaf: [47, 143, 70], mount: [127, 159, 196] },
  desert: { sky: ['#2c7fd6', '#ffe6b8'], fog: [255, 230, 184], ground: [216, 174, 102], leaf: [79, 145, 64], mount: [201, 143, 88] },
  snow: { sky: ['#3f7fcf', '#eaf3fb'], fog: [234, 243, 251], ground: [233, 240, 248], leaf: [44, 110, 74], mount: [157, 179, 204] },
  sunset: { sky: ['#2b2f7a', '#ffd08a'], fog: [255, 208, 138], ground: [76, 133, 66], leaf: [42, 110, 60], mount: [122, 90, 134] },
  night: { sky: ['#04050d', '#25305f'], fog: [37, 48, 95], ground: [32, 50, 58], leaf: [23, 60, 45], mount: [31, 42, 74] }
};

const cv = $('c'), g = cv.getContext('2d');
let W = 800, H = 500, F = 500;
function resize() { const s = Math.min(1, 1000 / innerWidth); W = cv.width = Math.round(innerWidth * s); H = cv.height = Math.round(innerHeight * s); }
addEventListener('resize', resize); resize();

let track = null, trackIdx = 0, car = null, state = 'menu', acc = 0, rec = [], ghost = null, recN = 0, auto = false, flashT = 0, splits = [], bestSplits = null, camMode = ld('ts_cam', 0), showGhost = true, camB = 0;
let quads = [], trees = [], mounts = [], TH = THEMES.meadow, mapBase = null, mapXY = null, ghostP = null, ghostQ = null;

// ---------- build drawable geometry for a track ----------
function buildWorld(tr) {
  TH = THEMES[tr.theme] || THEMES.meadow; quads = [];
  const Q = (pts, col, kind) => { const c = [0, 0, 0]; for (const p of pts) { c[0] += p[0] / pts.length; c[1] += p[1] / pts.length; c[2] += p[2] / pts.length; } quads.push({ pts, col, c, kind: kind || 0 }); };
  let segN = 0;
  for (const pc of tr.pieces) {
    const fr = pc.frames, n = fr.length - 1, step = pc.kind === 'straight' ? 2 : 1;
    for (let i = 0; i < n; i += step) {
      const A = fr[i], B = fr[Math.min(n, i + step)], alt = (segN++ & 1);
      const P = (f, x, y) => [f.p[0] + f.l[0] * x + f.u[0] * y, f.p[1] + f.l[1] * x + f.u[1] * y, f.p[2] + f.l[2] * x + f.u[2] * y];
      let road = alt ? [52, 56, 68] : [59, 63, 76];
      if (pc.type === 'boost') road = alt ? [250, 200, 26] : [217, 158, 13];
      if ((pc.type === 'start' || pc.type === 'finish') && i === 0) road = [235, 235, 240];
      if (pc.type === 'check' && i === 0) road = [59, 155, 255];
      Q([P(A, HW, 0), P(A, -HW, 0), P(B, -HW, 0), P(B, HW, 0)], road);
      const rail = alt ? [219, 43, 51] : [242, 242, 245];
      Q([P(A, HW, 0), P(A, HW, RAILH), P(B, HW, RAILH), P(B, HW, 0)], rail);
      Q([P(A, -HW, 0), P(A, -HW, RAILH), P(B, -HW, RAILH), P(B, -HW, 0)], rail);
    }
    const mid = fr[Math.floor(n / 2)];
    if (pc.type === 'blockleft' || pc.type === 'blockright') { const s = pc.type === 'blockleft' ? 1 : -1, x1 = s * HW * 0.08, x2 = s * HW, hh = 2.3, B = (x, y, z) => [mid.p[0] + mid.l[0] * x + mid.u[0] * y + mid.f[0] * z, mid.p[1] + mid.l[1] * x + mid.u[1] * y + mid.f[1] * z, mid.p[2] + mid.l[2] * x + mid.u[2] * y + mid.f[2] * z];
      Q([B(x1, 0, -1.6), B(x2, 0, -1.6), B(x2, hh, -1.6), B(x1, hh, -1.6)], [250, 204, 26]); Q([B(x1, hh, -1.6), B(x2, hh, -1.6), B(x2, hh, 1.6), B(x1, hh, 1.6)], [200, 160, 20]); Q([B(x1, 0, -1.6), B(x1, 0, 1.6), B(x1, hh, 1.6), B(x1, hh, -1.6)], [40, 40, 46]); }
    if (pc.lv > 0 || pc.kind === 'up' || pc.kind === 'down') { const x = mid.p[0], z = mid.p[2], y = mid.p[1] - 0.7; Q([[x - 1.5, 0, z], [x + 1.5, 0, z], [x + 1.5, y, z], [x - 1.5, y, z]], [185, 192, 204]); Q([[x, 0, z - 1.5], [x, 0, z + 1.5], [x, y, z + 1.5], [x, y, z - 1.5]], [165, 172, 186]); }
  }
  for (const gt of tr.gates) { const col = gt.type === 'start' ? [52, 211, 153] : gt.type === 'finish' ? [255, 90, 54] : [59, 155, 255], G2 = (x, y) => [gt.p[0] + gt.l[0] * x, gt.p[1] + y, gt.p[2] + gt.l[2] * x];
    Q([G2(-HW - 1.5, 6.8), G2(HW + 1.5, 6.8), G2(HW + 1.5, 8.4), G2(-HW - 1.5, 8.4)], col);
    for (const s of [1, -1]) Q([G2(s * (HW + 0.6), 0), G2(s * (HW + 1.5), 0), G2(s * (HW + 1.5), 7), G2(s * (HW + 0.6), 7)], [232, 236, 243]); }
  for (const p of tr.pads) for (let k = -1; k <= 1; k++) { const c = add(p.p, mul(p.f, k * 8)), w = HW * 0.55, V = (x, z) => [c[0] + p.l[0] * x + p.f[0] * z, c[1] + 0.05, c[2] + p.l[2] * x + p.f[2] * z];
    Q([V(-w, -1.6), V(0, 0.8), V(0, 2.0), V(-w, -0.4)], [255, 255, 255]); Q([V(w, -1.6), V(0, 0.8), V(0, 2.0), V(w, -0.4)], [255, 255, 255]); }
  for (const tn of tr.tunnels) { const P2 = (f, a) => { const x = Math.cos(a) * (HW + 1.6), y = Math.sin(a) * 9.5; return [f.p[0] + f.l[0] * x + f.u[0] * y, f.p[1] + f.l[1] * x + f.u[1] * y, f.p[2] + f.l[2] * x + f.u[2] * y]; };
    for (let k = 0; k < 6; k++) { const a0 = k / 6 * Math.PI, a1 = (k + 1) / 6 * Math.PI; Q([P2(tn.a, a0), P2(tn.a, a1), P2(tn.b, a1), P2(tn.b, a0)], k % 2 ? [89, 96, 110] : [78, 84, 98]); } }
  // scenery
  let seed = 12345 + trackIdx * 977; const rnd = () => { seed = (seed * 1664525 + 1013904223) | 0; return ((seed >>> 8) & 0xffff) / 65536; };
  const b = tr.bounds, cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2; trees = []; mounts = [];
  const clear = (x, z, r) => { for (let k = 0; k < tr.samples.length; k += 3) { const s = tr.samples[k].p; if ((s[0] - x) ** 2 + (s[2] - z) ** 2 < r * r) return false; } return true; };
  for (let i = 0; i < 150; i++) { const x = b.minX - 120 + rnd() * (b.maxX - b.minX + 240), z = b.minZ - 120 + rnd() * (b.maxZ - b.minZ + 240); if (clear(x, z, HW + 10)) trees.push([x, z, 0.7 + rnd() * 0.9]); }
  for (let i = 0; i < 36; i++) { const a = i / 36 * Math.PI * 2 + rnd() * 0.1, r = 1900 + rnd() * 600; mounts.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r, 260 + rnd() * 400, 320 + rnd() * 240, i % 3]); }
  // minimap
  const mc = document.createElement('canvas'); mc.width = mc.height = 180; const g2 = mc.getContext('2d'), span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) + 40, k = 160 / span, ox = 90 + (b.maxX + b.minX) / 2 * k, oz = 90 + (b.maxZ + b.minZ) / 2 * k;
  mapXY = (x, z) => [ox - x * k, oz - z * k];
  const line = (w, c) => { g2.strokeStyle = c; g2.lineWidth = w; g2.lineJoin = g2.lineCap = 'round'; g2.beginPath(); tr.samples.forEach((s, i) => { const [x, y] = mapXY(s.p[0], s.p[2]); if (i) g2.lineTo(x, y); else g2.moveTo(x, y); }); g2.stroke(); };
  line(7, 'rgba(0,0,0,.6)'); line(4, '#fff');
  for (const gt of tr.gates) { const [x, y] = mapXY(gt.p[0], gt.p[2]); g2.fillStyle = gt.type === 'start' ? '#34d399' : gt.type === 'finish' ? '#ff5a36' : '#3b9bff'; g2.beginPath(); g2.arc(x, y, 5, 0, 7); g2.fill(); }
  mapBase = mc;
}

// ---------- camera + drawing ----------
let cp = [0, 5, -10], cr = [1, 0, 0], cu = [0, 1, 0], cf = [0, 0, 1], camPos = null, camUp = [0, 1, 0], fov = 62;
const NEAR = 0.6, FAR = 440;
function setCam(pos, look, up) { cp = pos; cf = norm(sub(look, pos)); cr = norm(cross(cf, up)); cu = cross(cr, cf); F = (H / 2) / Math.tan(fov * Math.PI / 360); }
const toCam = p => { const d0 = p[0] - cp[0], d1 = p[1] - cp[1], d2 = p[2] - cp[2]; return [d0 * cr[0] + d1 * cr[1] + d2 * cr[2], d0 * cu[0] + d1 * cu[1] + d2 * cu[2], d0 * cf[0] + d1 * cf[1] + d2 * cf[2]]; };
function drawPoly(pts, style, stroke) { // pts in world space; clips against the near plane
  let v = pts.map(toCam), out = [];
  for (let i = 0; i < v.length; i++) { const a = v[i], b = v[(i + 1) % v.length], ia = a[2] >= NEAR, ib = b[2] >= NEAR; if (ia) out.push(a); if (ia !== ib) { const t = (NEAR - a[2]) / (b[2] - a[2]); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, NEAR]); } }
  if (out.length < 3) return;
  g.beginPath(); for (let i = 0; i < out.length; i++) { const p = out[i], x = W / 2 + p[0] * F / p[2], y = H / 2 - p[1] * F / p[2]; if (i) g.lineTo(x, y); else g.moveTo(x, y); } g.closePath();
  g.fillStyle = style; g.fill(); if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1; g.stroke(); }
}
const fogCol = (c, d) => { const k = Math.min(1, (d / FAR) * (d / FAR)) * 0.85, f = TH.fog; return 'rgb(' + ((c[0] + (f[0] - c[0]) * k) | 0) + ',' + ((c[1] + (f[1] - c[1]) * k) | 0) + ',' + ((c[2] + (f[2] - c[2]) * k) | 0) + ')'; };
function boxQuads(p, A, cx, cy, cz, w, h, l, col, list) { // a box in the car's local frame
  const X = A[0], Y = A[1], Z = A[2], P = (x, y, z) => [p[0] + X[0] * x + Y[0] * y + Z[0] * z, p[1] + X[1] * x + Y[1] * y + Z[1] * z, p[2] + X[2] * x + Y[2] * y + Z[2] * z];
  const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2, z0 = cz - l / 2, z1 = cz + l / 2, sh = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
  const add4 = (a, b, c2, d, k) => { const pts = [a, b, c2, d], c = [(a[0] + c2[0]) / 2, (a[1] + c2[1]) / 2, (a[2] + c2[2]) / 2]; list.push({ pts, col: sh(col, k), c }); };
  add4(P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y1, z1), 1); add4(P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1), 0.5);
  add4(P(x0, y0, z0), P(x0, y1, z0), P(x0, y1, z1), P(x0, y0, z1), 0.78); add4(P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), P(x1, y0, z1), 0.78);
  add4(P(x0, y0, z0), P(x1, y0, z0), P(x1, y1, z0), P(x0, y1, z0), 0.66); add4(P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1), 0.9);
}
function drawCar(p, q, c, ghostly) {
  const A = axes(q), list = [], col = ghostly ? [159, 208, 255] : [255, 90, 54], dark = [22, 27, 41];
  boxQuads(p, A, 0, 0, 0, 1.86, 0.4, 4.3, col, list); boxQuads(p, A, 0, 0.43, -0.2, 1.5, 0.46, 1.9, ghostly ? col : [36, 54, 79], list); boxQuads(p, A, 0, 0.7, -0.25, 1.54, 0.1, 1.5, col, list); boxQuads(p, A, 0, 0.74, -2.02, 2.05, 0.08, 0.52, ghostly ? col : dark, list);
  for (let i = 0; i < 4; i++) { const L = CAR.wheels[i], comp = c ? c.wheels[i].comp : 0.07; boxQuads(p, A, L[0], L[1] - (CAR.rayLen - comp - CAR.radius), L[2], 0.36, 0.66, 0.66, ghostly ? col : [22, 24, 29], list); }
  for (const f of list) { const d = toCam(f.c); f.z = d[2]; } list.sort((a, b) => b.z - a.z);
  if (ghostly) g.globalAlpha = 0.35;
  for (const f of list) drawPoly(f.pts, 'rgb(' + (f.col[0] | 0) + ',' + (f.col[1] | 0) + ',' + (f.col[2] | 0) + ')');
  g.globalAlpha = 1;
}
function render() {
  const sk = g.createLinearGradient(0, 0, 0, H); sk.addColorStop(0, TH.sky[0]); sk.addColorStop(0.62, TH.sky[1]); g.fillStyle = sk; g.fillRect(0, 0, W, H);
  // mountains, then the ground plane
  for (const m of mounts) { const col = 'rgb(' + TH.mount.map(v => v + (m[4] - 1) * 12).join(',') + ')'; drawPoly([[m[0] - m[3], 0, m[1]], [m[0] + m[3], 0, m[1]], [m[0], m[2], m[1]]], col); drawPoly([[m[0], 0, m[1] - m[3]], [m[0], 0, m[1] + m[3]], [m[0], m[2], m[1]]], col); }
  const R = 3000, gc = TH.ground; drawPoly([[cp[0] - R, 0, cp[2] - R], [cp[0] + R, 0, cp[2] - R], [cp[0] + R, 0, cp[2] + R], [cp[0] - R, 0, cp[2] + R]], 'rgb(' + gc.join(',') + ')');
  // everything else back to front
  const vis = [];
  for (const q of quads) { const dx = q.c[0] - cp[0], dy = q.c[1] - cp[1], dz = q.c[2] - cp[2], d2 = dx * dx + dy * dy + dz * dz; if (d2 > FAR * FAR) continue; if (dx * cf[0] + dy * cf[1] + dz * cf[2] < -30) continue; q.d = d2; vis.push(q); }
  for (const t of trees) { const dx = t[0] - cp[0], dz = t[1] - cp[2], d2 = dx * dx + dz * dz; if (d2 > 330 * 330 || dx * cf[0] + dz * cf[2] < 0) continue; vis.push({ tree: t, d: d2 }); }
  vis.sort((a, b) => b.d - a.d);
  for (const q of vis) {
    const d = Math.sqrt(q.d);
    if (q.tree) { const t = q.tree, s = t[2], x = t[0], z = t[1], w = 3.4 * s; drawPoly([[x - cr[0] * 0.5 * s, 0, z - cr[2] * 0.5 * s], [x + cr[0] * 0.5 * s, 0, z + cr[2] * 0.5 * s], [x + cr[0] * 0.5 * s, 3 * s, z + cr[2] * 0.5 * s], [x - cr[0] * 0.5 * s, 3 * s, z - cr[2] * 0.5 * s]], fogCol([122, 82, 48], d)); drawPoly([[x - cr[0] * w, 2.5 * s, z - cr[2] * w], [x + cr[0] * w, 2.5 * s, z + cr[2] * w], [x, 12 * s, z]], fogCol(TH.leaf, d)); }
    else drawPoly(q.pts, fogCol(q.col, d));
  }
  if (car) {
    const A = axes(car.q), s0 = add(car.p, mul(A[1], -0.36)), S = (x, z) => [s0[0] + A[0][0] * x + A[2][0] * z, s0[1] + A[0][1] * x + A[2][1] * z, s0[2] + A[0][2] * x + A[2][2] * z];
    if (car.grounded) drawPoly([S(-1.1, -2.3), S(1.1, -2.3), S(1.1, 2.3), S(-1.1, 2.3)], 'rgba(0,0,0,.28)');
    if (ghostP) drawCar(ghostP, ghostQ, null, true);
    if (camMode !== 2) drawCar(car.p, car.q, car, false);
    if (car.boosting > 0.3 && camMode !== 2) { const e = add(car.p, mul(A[2], -2.4)); drawPoly([add(e, mul(A[0], 0.6)), add(e, mul(A[0], -0.6)), add(e, mul(A[2], -1.5 - Math.random()))], 'rgba(255,170,40,.9)'); }
  }
}

// ---------- game flow (same rules as the 3D version) ----------
function drawMap() {
  const m = $('map').getContext('2d'); m.clearRect(0, 0, 180, 180); if (!mapBase) return; m.drawImage(mapBase, 0, 0);
  if (ghostP) { const [x, y] = mapXY(ghostP[0], ghostP[2]); m.fillStyle = '#9fd0ff'; m.beginPath(); m.arc(x, y, 4, 0, 7); m.fill(); }
  const A = axes(car.q), [x, y] = mapXY(car.p[0], car.p[2]), a = Math.atan2(-A[2][0], -A[2][2]);
  m.save(); m.translate(x, y); m.rotate(-a); m.fillStyle = '#ffe14d'; m.strokeStyle = '#000'; m.lineWidth = 1.5; m.beginPath(); m.moveTo(0, -8); m.lineTo(5.5, 6); m.lineTo(-5.5, 6); m.closePath(); m.fill(); m.stroke(); m.restore();
}
function loadTrack(i) {
  trackIdx = i; track = buildTrack(TRACKS[i]); buildWorld(track);
  const gh = ld('ts2_ghost_' + tid(i), null); ghost = gh && gh.length > 20 ? gh : null; bestSplits = ld('ts2_split_' + tid(i), null);
  state = 'play'; restart(); $('menu').classList.remove('on'); $('fin').classList.remove('on'); document.querySelectorAll('.hud').forEach(h => h.classList.add('on'));
}
function restart() {
  car = newCar(track); acc = 0; rec = []; recN = 0; camPos = null; camB = 0; splits = []; ghostP = null; $('fin').classList.remove('on'); if (state === 'done') state = 'play';
  const best = ld('ts2_best_' + tid(trackIdx), 0), nextM = MED.find(m => !best || !beats(best, par(trackIdx) * m[2]));
  $('sub').textContent = TRACKS[trackIdx].name + (best ? ' · best ' + fmt(best) : '') + (nextM ? ' · next ' + nextM[0] + ' ' + fmt(par(trackIdx) * nextM[2]) : ' · all medals 💎');
}
function flash(html) { const f = $('flash'); f.innerHTML = html; f.style.opacity = 1; flashT = 1.6; }
const diffHtml = d => ' <b class="' + (d <= 0 ? 'dn' : 'up') + '">' + (d <= 0 ? '−' : '+') + Math.abs(d).toFixed(2) + '</b>';
let ac = null, eng = null;
function audio() { if (ac) return; try { ac = new (window.AudioContext || window.webkitAudioContext)(); const o = ac.createOscillator(), f = ac.createBiquadFilter(), gn = ac.createGain(); o.type = 'sawtooth'; f.type = 'lowpass'; f.frequency.value = 700; gn.gain.value = 0; o.connect(f); f.connect(gn); gn.connect(ac.destination); o.start(); eng = { o, f, g: gn }; } catch (e) { ac = null; } }
function beep(fr, d, v) { if (!ac) return; try { const t = ac.currentTime, o = ac.createOscillator(), gn = ac.createGain(); o.type = 'triangle'; o.frequency.value = fr; gn.gain.setValueAtTime(v || 0.1, t); gn.gain.exponentialRampToValueAtTime(0.0001, t + d); o.connect(gn); gn.connect(ac.destination); o.start(t); o.stop(t + d + 0.02); } catch (e) {} }
function engineSound(on, thr) { if (!eng) return; const t = ac.currentTime; if (!on || !car) { eng.g.gain.setTargetAtTime(0, t, 0.05); return; } const rpm = Math.min(1, car.rpm / CAR.rpmMax); eng.o.frequency.setTargetAtTime(38 + rpm * 165, t, 0.04); eng.f.frequency.setTargetAtTime(380 + rpm * 900 + (thr ? 500 : 0), t, 0.05); eng.g.gain.setTargetAtTime(car.shiftT > 0 ? 0.02 : thr ? 0.06 : 0.03, t, 0.03); }
const keys = {};
addEventListener('keydown', e => { audio(); const k = e.key.toLowerCase(); keys[k] = true; if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault(); if (e.repeat) return;
  if (state === 'play' || state === 'done') { if (k === 'r') restart(); else if (k === 'enter' && state === 'play') { respawnCar(car); camPos = null; } else if (k === 'escape') menu(); else if (k === 'c') { camMode = (camMode + 1) % 3; sv('ts_cam', camMode); camPos = null; flash(['Chase camera', 'Far camera', 'Hood camera'][camMode]); } else if (k === 'g') { showGhost = !showGhost; flash('Ghost ' + (showGhost ? 'on' : 'off')); } } });
addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
function input() { if (auto) return botInput(car, track, 1); return { throttle: keys.w || keys.arrowup ? 1 : 0, brake: keys.s || keys.arrowdown ? 1 : 0, hand: !!keys[' '], steer: (keys.a || keys.arrowleft ? 1 : 0) - (keys.d || keys.arrowright ? 1 : 0) }; }
function finish() {
  state = 'done'; const t = car.finishTime, id = tid(trackIdx), best = ld('ts2_best_' + id, 0), pb = !best || t < best; splits.push(t);
  if (pb) { sv('ts2_best_' + id, +t.toFixed(3)); sv('ts2_ghost_' + id, rec); sv('ts2_split_' + id, splits.map(x => +x.toFixed(3))); ghost = rec.slice(); bestSplits = splits.slice(); }
  let got = null; for (const m of MED) if (beats(t, par(trackIdx) * m[2])) got = m;
  $('finName').textContent = TRACKS[trackIdx].name; $('finTime').textContent = fmt(t); $('finMedal').textContent = got ? got[0] : '🏁';
  $('finNote').innerHTML = (got ? got[1] + ' medal! ' : 'Finished. ') + (pb ? (best ? 'New personal best' + diffHtml(t - best) : 'First finish!') : 'Best: ' + fmt(best) + diffHtml(t - best));
  $('finMedals').innerHTML = MED.map(m => '<div class="' + (beats(t, par(trackIdx) * m[2]) ? 'got' : '') + '">' + m[0] + ' ' + m[1] + ' ' + fmt(par(trackIdx) * m[2]) + '</div>').join('');
  $('next').style.display = trackIdx < TRACKS.length - 1 ? '' : 'none'; $('fin').classList.add('on'); [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => beep(f, 0.3), i * 110));
}
const DT = 1 / 120; let last = 0;
function frame(now) {
  const dtR = last ? Math.min(0.1, (now - last) / 1000) : 0.016; last = now;
  if ((state === 'play' || state === 'done') && car) {
    acc += dtR; let n = 0;
    while (acc >= DT && n++ < 24) {
      acc -= DT; const inp = input(); if (!car.started && (inp.throttle || auto)) car.started = true;
      stepCar(car, inp, DT, track);
      if (car.started && !car.finished && (recN++ % 6) === 0) rec.push(+car.p[0].toFixed(2), +car.p[1].toFixed(2), +car.p[2].toFixed(2), +car.q[0].toFixed(3), +car.q[1].toFixed(3), +car.q[2].toFixed(3), +car.q[3].toFixed(3));
      if (car.event === 'check') { car.event = null; splits.push(car.time); const bs = bestSplits && bestSplits[splits.length - 1]; flash('CHECKPOINT ' + car.cp + '/' + track.nCheck + (bs ? diffHtml(car.time - bs) : '')); beep(880, 0.15); setTimeout(() => beep(1320, 0.2), 90); }
      if (car.event === 'finish') { car.event = null; finish(); }
    }
    if (acc > DT * 4) acc = 0;
    engineSound(state === 'play', keys.w || keys.arrowup || auto);
    ghostP = null;
    if (ghost && showGhost && car.started && state === 'play') { const f = car.time * 20, i = Math.floor(f), u = f - i; if ((i + 1) * 7 + 6 < ghost.length) { const a = i * 7, b = a + 7, L = k => ghost[a + k] + (ghost[b + k] - ghost[a + k]) * u; ghostP = [L(0), L(1), L(2)]; ghostQ = [L(3), L(4), L(5), L(6)]; const ql = Math.hypot(ghostQ[0], ghostQ[1], ghostQ[2], ghostQ[3]) || 1; ghostQ = ghostQ.map(v => v / ql); } }
    const A = axes(car.q), up3 = A[1], fw3 = A[2], sp = car.speed, steep = car.grounded >= 2 && A[1][1] < 0.72; camB += ((steep ? 1 : 0) - camB) * Math.min(1, dtR * (steep ? 9 : 3.5));
    let fw = norm([A[2][0], 0, A[2][2]]); const vl = Math.hypot(car.v[0], car.v[2]); if (vl > 12) fw = norm(lerp3(fw, [car.v[0] / vl, 0, car.v[2] / vl], 0.4));
    const dir = norm(lerp3(fw, fw3, camB)); camUp = norm(lerp3(camUp, norm(lerp3([0, 1, 0], up3, camB)), Math.min(1, dtR * 10)));
    fov = (camMode === 2 ? 74 : 62) + Math.min(26, sp * 0.3) + car.boosting * 7;
    if (camMode === 2) setCam(add(add(car.p, mul(fw3, 0.75)), mul(up3, 0.95)), add(add(car.p, mul(fw3, 12)), mul(up3, 0.7)), up3);
    else { const dist = (camMode === 1 ? 14 : 8.4) + sp * 0.03, hgt = (camMode === 1 ? 6.2 : 3.4) + sp * 0.01, want = add(add(car.p, mul(dir, -dist)), mul(camUp, hgt));
      camPos = camPos ? lerp3(camPos, want, 1 - Math.exp(-dtR * (7 + camB * 8))) : want; if (camB < 0.3 && camPos[1] < 0.8) camPos[1] = 0.8;
      setCam(camPos, add(add(car.p, mul(dir, 5)), mul(camUp, 1.4)), camUp); }
    render();
    $('time').textContent = fmt(car.finished ? car.finishTime : car.time); $('speed').firstChild.textContent = Math.round(sp * 3.6); $('gearN').textContent = car.gear; $('rpmFill').style.width = Math.min(100, car.rpm / CAR.rpmMax * 100) + '%'; $('rpmFill').style.background = car.rpm > CAR.rpmMax * 0.9 ? '#ff5a36' : '#ffe14d';
    $('cp').textContent = '🚩 ' + car.cp + ' / ' + track.nCheck; drawMap();
    if (flashT > 0) { flashT -= dtR; if (flashT <= 0) $('flash').style.opacity = 0; }
  } else if (state === 'menu' && track) { engineSound(false); const t = now / 1000 * 0.12, b = track.bounds, cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2, r = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) * 0.6 + 70; fov = 62; const sc = car; car = null; setCam([cx + Math.cos(t) * r, 75, cz + Math.sin(t) * r], [cx, 0, cz], [0, 1, 0]); render(); car = sc; }
  requestAnimationFrame(frame);
}
function medalFor(i) { const b = ld('ts2_best_' + tid(i), 0); if (!b) return ''; let m = ''; for (const x of MED) if (beats(b, par(i) * x[2])) m = x[0]; return m || '✔'; }
function menu() {
  state = 'menu'; $('fin').classList.remove('on'); $('menu').classList.add('on'); document.querySelectorAll('.hud').forEach(h => h.classList.remove('on'));
  const el = $('tracks'); el.innerHTML = ''; const cnt = { '🥉': 0, '🥈': 0, '🥇': 0, '💎': 0 }; let done = 0;
  TRACKS.forEach((t, i) => { const b = ld('ts2_best_' + tid(i), 0), md = medalFor(i), d = document.createElement('button'); if (b) done++; if (md) for (const x of MED) { cnt[x[0]]++; if (x[0] === md) break; }
    d.className = 'tk'; d.innerHTML = '<span class="md">' + md + '</span><b>' + (i + 1) + '. ' + t.name + '</b><small>' + (b ? 'Best ' + fmt(b) : 'Not finished yet') + ' · 🥇 ' + fmt(par(i) * 1.08) + '</small>'; d.onclick = () => loadTrack(i); el.appendChild(d); });
  $('medalCount').textContent = 'Finished ' + done + ' / ' + TRACKS.length + ' · 🥉 ' + cnt['🥉'] + ' · 🥈 ' + cnt['🥈'] + ' · 🥇 ' + cnt['🥇'] + ' · 💎 ' + cnt['💎'];
  $('gfx').textContent = 'Graphics: Basic (no WebGL)' + (window.__noGL ? '' : ' · click for 3D');
}
$('gfx').onclick = () => { if (!window.__noGL) { sv('ts_soft', false); location.reload(); } };
$('again').onclick = restart; $('toMenu').onclick = menu; $('next').onclick = () => loadTrack(trackIdx + 1);
window.__ts = { load: loadTrack, auto: v => { auto = v; }, cam: m => { camMode = m; camPos = null; }, st: () => ({ state, t: car && car.time, sp: car && car.speed, cp: car && car.cp, fin: car && car.finished, p: car && car.p, up: car && axes(car.q)[1][1], soft: true }) };
trackIdx = 0; track = buildTrack(TRACKS[0]); buildWorld(track); menu(); window.__tsReady = true; requestAnimationFrame(frame);
