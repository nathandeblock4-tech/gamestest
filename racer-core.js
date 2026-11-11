// Trackstorm core: track building + rigid-body car physics. No rendering code in here (so it can be tested without a browser).
export const CELL = 32, ROADW = 13, HSTEP = 8, ROADY = 0.4;
const HW = ROADW / 2, RAILW = 0.6, RAILH = 1.15, PI = Math.PI;
const DX = [0, 1, 0, -1], DZ = [1, 0, -1, 0], LX = [1, 0, -1, 0], LZ = [0, -1, 0, 1];

// ---------- vector helpers ----------
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const len = a => Math.hypot(a[0], a[1], a[2]);
const norm = a => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const clamp = (x, a, b) => x < a ? a : x > b ? b : x;

// ---------- pieces (local frame: enter at the south edge heading +z, +x is left) ----------
const h = CELL / 2, sm = u => u * u * (3 - 2 * u);
const CURVES = {
  straight: u => ({ p: [0, 0, -h + CELL * u], t: [0, 0, 1], b: 0 }),
  left: u => { const a = u * PI / 2; return { p: [h - h * Math.cos(a), 0, -h + h * Math.sin(a)], t: [Math.sin(a), 0, Math.cos(a)], b: 0 }; },
  right: u => { const a = u * PI / 2; return { p: [-h + h * Math.cos(a), 0, -h + h * Math.sin(a)], t: [-Math.sin(a), 0, Math.cos(a)], b: 0 }; },
  bigleft: u => { const a = u * PI / 2, R = 1.5 * CELL; return { p: [R - R * Math.cos(a), 0, -h + R * Math.sin(a)], t: [Math.sin(a), 0, Math.cos(a)], b: 0 }; },
  bigright: u => { const a = u * PI / 2, R = 1.5 * CELL; return { p: [-R + R * Math.cos(a), 0, -h + R * Math.sin(a)], t: [-Math.sin(a), 0, Math.cos(a)], b: 0 }; },
  bankleft: u => { const c = CURVES.bigleft(u); c.b = 0.38 * Math.sin(PI * u); c.p[1] += (HW + RAILW) * Math.sin(c.b); return c; },   // lift the road so the low side stays above the ground
  bankright: u => { const c = CURVES.bigright(u); c.b = -0.38 * Math.sin(PI * u); c.p[1] += (HW + RAILW) * Math.sin(-c.b); return c; },
  up: u => ({ p: [0, HSTEP * sm(u), -h + CELL * u], t: [0, HSTEP * 6 * u * (1 - u), CELL], b: 0 }),
  down: u => ({ p: [0, -HSTEP * sm(u), -h + CELL * u], t: [0, -HSTEP * 6 * u * (1 - u), CELL], b: 0 }),
  jump: u => ({ p: [0, 3.4 * u * u, -h + CELL * u], t: [0, 6.8 * u, CELL], b: 0 })
};
const KIND = { start: 'straight', finish: 'straight', check: 'straight', boost: 'straight', land: 'straight' };
const SEGS = { straight: 4, left: 12, right: 12, bigleft: 22, bigright: 22, bankleft: 22, bankright: 22, up: 12, down: 12, jump: 10 };
// exit: [cells left, cells forward, turn (+1 = left), level change]; cells: extra occupied cells [left, forward]
const EXIT = { straight: [0, 1, 0, 0], left: [1, 0, 1, 0], right: [-1, 0, 3, 0], bigleft: [2, 1, 1, 0], bigright: [-2, 1, 3, 0], bankleft: [2, 1, 1, 0], bankright: [-2, 1, 3, 0], up: [0, 1, 0, 1], down: [0, 1, 0, -1], jump: [0, 1, 0, 0] };
const EXTRA = { bigleft: [[0, 1], [1, 1]], bigright: [[0, 1], [-1, 1]], bankleft: [[0, 1], [1, 1]], bankright: [[0, 1], [-1, 1]] };
const TOKEN = { S: 'straight', L: 'left', R: 'right', BL: 'bigleft', BR: 'bigright', KL: 'bankleft', KR: 'bankright', U: 'up', D: 'down', B: 'boost', C: 'check', F: 'finish' };

function toWorld(pc, lp) { const a = pc.d * PI / 2, c = Math.cos(a), s = Math.sin(a); return [pc.gx * CELL + lp[0] * c + lp[2] * s, pc.lv * HSTEP + ROADY + lp[1], pc.gz * CELL - lp[0] * s + lp[2] * c]; }
function toWorldDir(pc, lp) { const a = pc.d * PI / 2, c = Math.cos(a), s = Math.sin(a); return [lp[0] * c + lp[2] * s, lp[1], -lp[0] * s + lp[2] * c]; }

// ---------- build a track from a turtle string ----------
export function buildTrack(def) {
  const pieces = [], occ = new Map();
  let gx = 0, gz = 0, lv = def.level || 0, d = 0;
  const claim = (x, z, l, i) => { const k = x + ',' + z + ',' + l; if (occ.has(k)) throw new Error('Track "' + def.name + '" overlaps itself at ' + k + ' (piece ' + i + ')'); occ.set(k, i); };
  function put(type) {
    const kind = KIND[type] || type, pc = { type, kind, gx, gz, lv, d, i: pieces.length }; pieces.push(pc);
    const ex = EXIT[kind];
    claim(gx, gz, lv, pc.i); if (kind === 'up') claim(gx, gz, lv + 1, pc.i); if (kind === 'down') claim(gx, gz, lv - 1, pc.i);
    for (const e of EXTRA[kind] || []) claim(gx + e[0] * LX[d] + e[1] * DX[d], gz + e[0] * LZ[d] + e[1] * DZ[d], lv, pc.i);
    gx += ex[0] * LX[d] + ex[1] * DX[d]; gz += ex[0] * LZ[d] + ex[1] * DZ[d]; lv += ex[3]; d = (d + ex[2]) % 4;
    if (lv < 0) throw new Error('Track "' + def.name + '" goes below ground');
    return pc;
  }
  put('start');
  for (const tok of def.path.trim().split(/\s+/)) {
    const m = /^([A-Z]+)(\d*)$/.exec(tok); if (!m) throw new Error('Bad token ' + tok);
    const n = m[2] ? +m[2] : 1;
    if (m[1] === 'J') { const j = put('jump'); j.gap = n; gx += n * DX[d]; gz += n * DZ[d]; put('land'); }
    else { const t = TOKEN[m[1]]; if (!t) throw new Error('Bad token ' + tok); for (let k = 0; k < n; k++) put(t); }
  }
  if (pieces[pieces.length - 1].type !== 'finish') put('finish');

  // geometry
  const tris = [], mats = [], rp = [], rc = [], samples = [], gates = [], pads = [], pillars = [];
  const nrm = [];
  const quad = (a, b, c2, d2, col, mat, ref) => {
    if (mat != null) { tris.push(a, b, d2, a, d2, c2); mats.push(mat, mat); nrm.push(ref, ref); }
    if (col) { rp.push(a, b, d2, a, d2, c2); rc.push(col, col, col, col, col, col); }
  };
  const C_ROAD = [0.20, 0.22, 0.27], C_ROAD2 = [0.23, 0.25, 0.30], C_LINE = [0.92, 0.93, 0.95], C_RED = [0.86, 0.17, 0.20], C_WHITE = [0.95, 0.95, 0.96], C_SIDE = [0.42, 0.45, 0.52], C_UNDER = [0.30, 0.32, 0.38], C_BOOST = [0.98, 0.78, 0.10], C_CHK = [0.10, 0.10, 0.12];
  let segN = 0, dist = 0;
  for (const pc of pieces) {
    const f = CURVES[pc.kind], n = SEGS[pc.kind], frames = [];
    for (let i = 0; i <= n; i++) {
      const u = i / n, c = f(u), p = toWorld(pc, c.p), fw = norm(toWorldDir(pc, c.t));
      let l = norm(cross([0, 1, 0], fw)), up = cross(fw, l);
      if (c.b) { const cb = Math.cos(c.b), sb = Math.sin(c.b), l2 = sub(mul(l, cb), mul(up, sb)), u2 = add(mul(up, cb), mul(l, sb)); l = l2; up = u2; }
      frames.push({ p, f: fw, l, u: up });
    }
    pc.frames = frames; pc.y = toWorld(pc, f(0.5).p)[1];
    const P = (fr, x, y) => [fr.p[0] + fr.l[0] * x + fr.u[0] * y, fr.p[1] + fr.l[1] * x + fr.u[1] * y, fr.p[2] + fr.l[2] * x + fr.u[2] * y];
    for (let i = 0; i < n; i++) {
      const A = frames[i], B = frames[i + 1], alt = (segN++ & 1);
      const strip = (x1, y1, x2, y2, col, mat, ref) => quad(P(A, x1, y1), P(A, x2, y2), P(B, x1, y1), P(B, x2, y2), col, mat, ref);
      let road = alt ? C_ROAD : C_ROAD2;
      if (pc.type === 'boost') road = alt ? C_BOOST : [0.85, 0.62, 0.05];
      if ((pc.type === 'start' || pc.type === 'finish') && i === 1) road = null;
      strip(-HW, 0, HW, 0, null, 0, A.u);                                 // collision: whole road
      if (road) { strip(-HW + 1.0, 0, HW - 1.0, 0, road); } else { for (let k = 0; k < 8; k++) { const x1 = -HW + 1 + k * (ROADW - 2) / 8, x2 = x1 + (ROADW - 2) / 8; strip(x1, 0, x2, 0, (k & 1) ? C_CHK : C_WHITE); } }
      strip(-HW, 0, -HW + 0.6, 0, road || C_ROAD); strip(-HW + 0.6, 0, -HW + 1.0, 0, C_LINE);
      strip(HW - 1.0, 0, HW - 0.6, 0, C_LINE); strip(HW - 0.6, 0, HW, 0, road || C_ROAD);
      const rail = alt ? C_RED : C_WHITE;
      for (const s of [1, -1]) {
        strip(s * HW, 0, s * HW, RAILH, rail, 1, mul(A.l, -s));                     // inner face
        strip(s * HW, RAILH, s * (HW + RAILW), RAILH, rail, 1, A.u);         // top
        strip(s * (HW + RAILW), RAILH, s * (HW + RAILW), -0.7, C_SIDE);  // outer skirt
      }
      strip(-HW - RAILW, -0.7, HW + RAILW, -0.7, C_UNDER);
      // centerline samples every ~2.5 m
      const segLen = len(sub(B.p, A.p)), ns = Math.max(1, Math.round(segLen / 2.5));
      for (let k = 0; k < ns; k++) { const u = k / ns; samples.push({ p: add(A.p, mul(sub(B.p, A.p), u)), f: A.f, pc: pc.i, d: dist + segLen * u }); }
      dist += segLen;
    }
    if (pc.kind === 'jump') { // end cap + air samples over the gap
      const E = frames[n], nx = pieces[pc.i + 1], L0 = toWorld(nx, CURVES.straight(0).p), gap = len(sub(L0, E.p)), ns = Math.round(gap / 2.5);
      for (let k = 0; k < ns; k++) { const u = k / ns; const p = add(E.p, mul(sub(L0, E.p), u)); p[1] += 5 * Math.sin(PI * u); samples.push({ p, f: E.f, pc: pc.i, d: dist + gap * u, air: true }); }
      dist += gap;
    }
    const mid = frames[Math.floor(n / 2)];
    if (pc.type === 'start' || pc.type === 'finish' || pc.type === 'check') gates.push({ type: pc.type, p: frames[1].p, f: frames[1].f, l: frames[1].l, pc: pc.i });
    if (pc.type === 'boost') pads.push({ p: mid.p, f: mid.f, l: mid.l });
    if (pc.lv > 0 || pc.kind === 'up' || pc.kind === 'down') pillars.push({ x: mid.p[0], z: mid.p[2], y: mid.p[1] - 0.7 });
  }
  // spatial grid for collision
  const T = new Float32Array(tris.length * 3); for (let i = 0; i < tris.length; i++) { T[i * 3] = tris[i][0]; T[i * 3 + 1] = tris[i][1]; T[i * 3 + 2] = tris[i][2]; }
  const nT = tris.length / 3, grid = new Map(), G = 8, NR = new Float32Array(nT * 3);
  for (let t = 0; t < nT; t++) { const a = tris[t * 3], b = tris[t * 3 + 1], c3 = tris[t * 3 + 2]; let n = norm(cross(sub(b, a), sub(c3, a))); if (dot(n, nrm[t]) < 0) n = mul(n, -1); NR[t * 3] = n[0]; NR[t * 3 + 1] = n[1]; NR[t * 3 + 2] = n[2]; }
  for (let t = 0; t < nT; t++) {
    const o = t * 9, x0 = Math.floor(Math.min(T[o], T[o + 3], T[o + 6]) / G), x1 = Math.floor(Math.max(T[o], T[o + 3], T[o + 6]) / G), z0 = Math.floor(Math.min(T[o + 2], T[o + 5], T[o + 8]) / G), z1 = Math.floor(Math.max(T[o + 2], T[o + 5], T[o + 8]) / G);
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) { const k = (x + 2048) * 4096 + z + 2048; let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(t); }
  }
  // piece lookup by cell
  const cells = new Map();
  for (const [k, i] of occ) { const [x, z] = k.split(','); const kk = x + ',' + z; let a = cells.get(kk); if (!a) cells.set(kk, a = []); if (a.indexOf(i) < 0) a.push(i); }
  const st = pieces[0], sp = toWorld(st, [0, 0, -h + 7]), sd = [DX[st.d], 0, DZ[st.d]];
  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9; for (const s of samples) { minX = Math.min(minX, s.p[0]); maxX = Math.max(maxX, s.p[0]); minZ = Math.min(minZ, s.p[2]); maxZ = Math.max(maxZ, s.p[2]); }
  return { name: def.name, pieces, T, NR, mats, nT, grid, G, cells, samples, gates, pads, pillars, rend: { pos: rp, col: rc }, start: { p: sp, f: sd }, nCheck: pieces.filter(p => p.type === 'check').length, length: dist, bounds: { minX, maxX, minZ, maxZ } };
}

// ---------- collision queries ----------
function rayTrack(tr, o, d, maxT) { // returns {t, n, mat} for the closest hit, or null (also tests the ground plane y = 0)
  let best = maxT, bn = null, bm = 0;
  const ex = o[0] + d[0] * maxT, ez = o[2] + d[2] * maxT, G = tr.G;
  const x0 = Math.floor(Math.min(o[0], ex) / G), x1 = Math.floor(Math.max(o[0], ex) / G), z0 = Math.floor(Math.min(o[2], ez) / G), z1 = Math.floor(Math.max(o[2], ez) / G), T = tr.T;
  for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) {
    const a = tr.grid.get((gx + 2048) * 4096 + gz + 2048); if (!a) continue;
    for (let i = 0; i < a.length; i++) {
      const t = a[i], q = t * 9;
      const e1x = T[q + 3] - T[q], e1y = T[q + 4] - T[q + 1], e1z = T[q + 5] - T[q + 2], e2x = T[q + 6] - T[q], e2y = T[q + 7] - T[q + 1], e2z = T[q + 8] - T[q + 2];
      const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x, det = e1x * px + e1y * py + e1z * pz;
      if (det > -1e-9 && det < 1e-9) continue;
      const inv = 1 / det, tx = o[0] - T[q], ty = o[1] - T[q + 1], tz = o[2] - T[q + 2], u = (tx * px + ty * py + tz * pz) * inv; if (u < -1e-4 || u > 1.0001) continue;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x, v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv; if (v < -1e-4 || u + v > 1.0001) continue;
      const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (tt >= 0 && tt < best) { best = tt; let n = norm([e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x]); if (dot(n, d) > 0) n = mul(n, -1); bn = n; bm = tr.mats[t]; }
    }
  }
  if (d[1] < -1e-6) { const tg = -o[1] / d[1]; if (tg >= 0 && tg < best) { best = tg; bn = [0, 1, 0]; bm = 2; } }
  return bn ? { t: best, n: bn, mat: bm } : null;
}
function closestOnTri(T, q, p) {
  const ax = T[q], ay = T[q + 1], az = T[q + 2], abx = T[q + 3] - ax, aby = T[q + 4] - ay, abz = T[q + 5] - az, acx = T[q + 6] - ax, acy = T[q + 7] - ay, acz = T[q + 8] - az;
  const apx = p[0] - ax, apy = p[1] - ay, apz = p[2] - az, d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return [ax, ay, az];
  const bpx = apx - abx, bpy = apy - aby, bpz = apz - abz, d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return [ax + abx, ay + aby, az + abz];
  const vc = d1 * d4 - d3 * d2; if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return [ax + abx * v, ay + aby * v, az + abz * v]; }
  const cpx = apx - acx, cpy = apy - acy, cpz = apz - acz, d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return [ax + acx, ay + acy, az + acz];
  const vb = d5 * d2 - d1 * d6; if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return [ax + acx * w, ay + acy * w, az + acz * w]; }
  const va = d3 * d6 - d5 * d4; if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + d5 - d6); return [ax + abx + (acx - abx) * w, ay + aby + (acy - aby) * w, az + abz + (acz - abz) * w]; }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den; return [ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w];
}

// ---------- car ----------
export const CAR = {
  mass: 1200, inertia: [1500, 1900, 520],           // about left (pitch), up (yaw), forward (roll) axes
  wheels: [[0.92, -0.18, 1.42], [-0.92, -0.18, 1.42], [0.92, -0.18, -1.38], [-0.92, -0.18, -1.38]], // FL FR RL RR
  radius: 0.37, rayLen: 0.98, k: 62000, damp: 5200,
  gravity: 21, mu: 1.75, muGrass: 0.85, slipPeak: 0.11,
  engine: 17500, power: 640000, brake: 34000, reverse: 9000, drag: 1.02, roll: 60, downforce: 5.2,
  maxSteer: 0.52, steerSpeedRef: 21, steerRate: 5.5, steerReturn: 8, boost: 52000, vmax: 118,
  spheres: [[0.82, 0.02, 1.95, 0.42], [-0.82, 0.02, 1.95, 0.42], [0.82, 0.02, -1.95, 0.42], [-0.82, 0.02, -1.95, 0.42], [0.62, 0.62, 0.7, 0.42], [-0.62, 0.62, 0.7, 0.42], [0.62, 0.62, -1.0, 0.42], [-0.62, 0.62, -1.0, 0.42], [0, 0.1, 0, 0.5]]
};
export function newCar(tr) {
  const c = { p: [0, 0, 0], q: [0, 0, 0, 1], v: [0, 0, 0], w: [0, 0, 0], steer: 0, wheels: [0, 1, 2, 3].map(() => ({ comp: 0.3, hit: false, spin: 0, mat: 0, slip: 0 })), time: 0, cp: 0, cpSet: new Set(), finished: false, finishTime: 0, started: false, grounded: 0, boosting: 0, speed: 0, sIdx: 0, respawn: null, hitT: 0 };
  placeCar(c, tr.start.p, tr.start.f); c.respawn = { p: tr.start.p.slice(), f: tr.start.f.slice() };
  return c;
}
export function placeCar(c, p, f) {
  const yaw = Math.atan2(f[0], f[2]);
  c.p = [p[0], p[1] + 0.85, p[2]]; c.q = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]; c.v = [0, 0, 0]; c.w = [0, 0, 0]; c.steer = 0;
}
export function axes(q) { // body axes in world space: [left, up, forward]
  const x = q[0], y = q[1], z = q[2], w = q[3];
  return [[1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)], [2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w)], [2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)]];
}
function applyImpulse(c, A, r, J) { // J: impulse vector, r: offset from centre of mass
  c.v[0] += J[0] / CAR.mass; c.v[1] += J[1] / CAR.mass; c.v[2] += J[2] / CAR.mass;
  const t = cross(r, J);
  for (let i = 0; i < 3; i++) { const k = dot(t, A[i]) / CAR.inertia[i]; c.w[0] += A[i][0] * k; c.w[1] += A[i][1] * k; c.w[2] += A[i][2] * k; }
}
function invMassAt(A, r, n) { const rn = cross(r, n); let s = 1 / CAR.mass; for (let i = 0; i < 3; i++) { const k = dot(rn, A[i]); s += k * k / CAR.inertia[i]; } return s; }

export function stepCar(c, inp, dt, tr) {
  const P = CAR, A = axes(c.q), ax = A[0], ay = A[1], az = A[2];
  const vf = dot(c.v, az); c.speed = len(c.v);
  // steering (less lock at speed), smoothed
  const lock = P.maxSteer / (1 + Math.pow(Math.abs(vf) / P.steerSpeedRef, 1.35)), target = clamp(inp.steer || 0, -1, 1);
  const rate = (Math.abs(target) < Math.abs(c.steer) || target * c.steer < 0) ? P.steerReturn : P.steerRate;
  c.steer += clamp(target - c.steer, -rate * dt, rate * dt);
  const sa = c.steer * lock, hs = Math.sin(sa), hc = Math.cos(sa);
  const thr = c.finished ? 0 : clamp(inp.throttle || 0, 0, 1), brk = c.finished ? 1 : clamp(inp.brake || 0, 0, 1);
  // boost pads / checkpoints by cell
  const cellK = Math.round(c.p[0] / CELL) + ',' + Math.round(c.p[2] / CELL), here = tr.cells.get(cellK);
  let onBoost = false;
  if (here) for (const i of here) { const pc = tr.pieces[i]; if (Math.abs(c.p[1] - pc.y) > 5) continue;
    if (pc.type === 'boost') onBoost = true;
    else if (pc.type === 'check' && !c.cpSet.has(i)) { c.cpSet.add(i); c.cp++; const g = tr.gates.find(g => g.pc === i); c.respawn = { p: g.p.slice(), f: g.f.slice() }; c.event = 'check'; }
    else if (pc.type === 'finish' && !c.finished && c.cp >= tr.nCheck) { const g = tr.gates.find(g => g.pc === i); if (dot(sub(c.p, g.p), g.f) > 0) { c.finished = true; c.finishTime = c.time; c.event = 'finish'; } } }
  let F = [0, -P.mass * P.gravity, 0], Tq = [0, 0, 0], grounded = 0;
  const addF = (f, at) => { F[0] += f[0]; F[1] += f[1]; F[2] += f[2]; const r = sub(at, c.p), t = cross(r, f); Tq[0] += t[0]; Tq[1] += t[1]; Tq[2] += t[2]; };
  const down = [-ay[0], -ay[1], -ay[2]];
  for (let i = 0; i < 4; i++) {
    const wl = c.wheels[i], L = P.wheels[i], O = [c.p[0] + ax[0] * L[0] + ay[0] * L[1] + az[0] * L[2], c.p[1] + ax[1] * L[0] + ay[1] * L[1] + az[1] * L[2], c.p[2] + ax[2] * L[0] + ay[2] * L[1] + az[2] * L[2]];
    const hit = rayTrack(tr, O, down, P.rayLen);
    if (!hit || hit.mat === 1) { wl.hit = false; wl.comp += (0 - wl.comp) * Math.min(1, dt * 12); wl.slip = 0; continue; }
    wl.hit = true; wl.mat = hit.mat; grounded++;
    const comp = P.rayLen - hit.t, n = hit.n, cp = [O[0] + down[0] * hit.t, O[1] + down[1] * hit.t, O[2] + down[2] * hit.t], r = sub(cp, c.p), vc = add(c.v, cross(c.w, r));
    wl.comp = comp;
    const N = Math.max(0, P.k * comp - P.damp * dot(vc, n)) * Math.max(0, dot(n, ay));
    // wheel heading on the contact plane
    let hd = i < 2 ? [az[0] * hc + ax[0] * hs, az[1] * hc + ax[1] * hs, az[2] * hc + ax[2] * hs] : az;
    const f = norm(sub(hd, mul(n, dot(hd, n)))), s = cross(n, f), vl = dot(vc, f), vs = dot(vc, s);
    const grass = hit.mat === 2, mu = grass ? P.muGrass : P.mu, maxF = mu * N;
    let Fx = 0;
    if (thr > 0) Fx += thr * Math.min(P.engine, P.power / Math.max(8, Math.abs(vf))) / 4 * (vf > P.vmax * 0.66 ? Math.max(0, 1 - (vf - P.vmax * 0.66) / (P.vmax * 0.06)) : 1);
    if (brk > 0) { if (vl > 1.5) Fx -= brk * P.brake / 4; else if (!c.finished) Fx -= brk * P.reverse / 4 * (vf < -14 ? 0 : 1); else Fx -= vl * 900; }
    Fx -= vl * (grass ? 420 : P.roll);
    if (onBoost) Fx += P.boost / 4;
    let Fy = -maxF * clamp((vs / (Math.abs(vl) + 3.5)) / P.slipPeak, -1, 1);
    const cap = Math.abs(vs) * (P.mass / 4) / dt * 0.8; Fy = clamp(Fy, -cap, cap);
    const m = Math.hypot(Fx, Fy); wl.slip = maxF > 1 ? Math.min(2, m / maxF) * Math.min(1, Math.abs(vs) / 4) : 0;
    if (m > maxF && m > 0) { const k = maxF / m; Fx *= k + (1 - k) * 0.35; Fy *= k; }
    addF(mul(n, N), cp);
    const lift = dot(sub(c.p, cp), ay) * 0.72, tp = [cp[0] + ay[0] * lift, cp[1] + ay[1] * lift, cp[2] + ay[2] * lift];
    addF([f[0] * Fx + s[0] * Fy, f[1] * Fx + s[1] * Fy, f[2] * Fx + s[2] * Fy], tp);
    wl.spin += vl / P.radius * dt;
  }
  c.grounded = grounded; c.boosting = onBoost && grounded ? 1 : Math.max(0, c.boosting - dt * 2);
  // aero
  const sp = c.speed; F[0] -= c.v[0] * sp * P.drag; F[1] -= c.v[1] * sp * P.drag * 0.25; F[2] -= c.v[2] * sp * P.drag;
  if (grounded >= 2) { const df = P.downforce * vf * vf; F[0] -= ay[0] * df; F[1] -= ay[1] * df; F[2] -= ay[2] * df; }
  // integrate
  c.v[0] += F[0] / P.mass * dt; c.v[1] += F[1] / P.mass * dt; c.v[2] += F[2] / P.mass * dt;
  const wl = [dot(c.w, ax), dot(c.w, ay), dot(c.w, az)], tl = [dot(Tq, ax), dot(Tq, ay), dot(Tq, az)], I = P.inertia;
  wl[0] += (tl[0] - (I[2] - I[1]) * wl[1] * wl[2]) / I[0] * dt; wl[1] += (tl[1] - (I[0] - I[2]) * wl[2] * wl[0]) / I[1] * dt; wl[2] += (tl[2] - (I[1] - I[0]) * wl[0] * wl[1]) / I[2] * dt;
  if (grounded === 0) { // air: light damping, small pitch/roll control, gentle self-levelling
    const k = Math.exp(-0.5 * dt); wl[0] *= k; wl[1] *= Math.exp(-1.2 * dt); wl[2] *= k;
    wl[0] += ((inp.brake || 0) - (inp.throttle || 0)) * 0.9 * dt * 0; wl[2] += -ax[1] * 2.2 * dt; wl[0] += az[1] * 0.6 * dt;
  } else { const k = Math.exp(-0.9 * dt); wl[0] *= k; wl[2] *= k; wl[1] *= Math.exp(-0.25 * dt); }
  c.w = [ax[0] * wl[0] + ay[0] * wl[1] + az[0] * wl[2], ax[1] * wl[0] + ay[1] * wl[1] + az[1] * wl[2], ax[2] * wl[0] + ay[2] * wl[1] + az[2] * wl[2]];
  // chassis collisions (spheres against track triangles and the ground)
  for (const S of P.spheres) {
    const r = [ax[0] * S[0] + ay[0] * S[1] + az[0] * S[2], ax[1] * S[0] + ay[1] * S[1] + az[1] * S[2], ax[2] * S[0] + ay[2] * S[1] + az[2] * S[2]], ctr = add(c.p, r), rad = S[3];
    const contact = (n, pen, fr) => {
      const rc = sub(r, mul(n, rad)), vc = add(c.v, cross(c.w, rc)), vn = dot(vc, n);
      if (vn < 0) { const j = -(1.12) * vn / invMassAt(A, rc, n); applyImpulse(c, A, rc, mul(n, j)); const vt = sub(vc, mul(n, vn)), vtl = len(vt); if (vtl > 0.01) { const tdir = mul(vt, 1 / vtl), jt = Math.min(fr * j, vtl / invMassAt(A, rc, tdir)); applyImpulse(c, A, rc, mul(tdir, -jt)); } if (vn < -6) c.hitT = 0.25; }
      const push = Math.min(pen, 0.5) * 0.7; c.p[0] += n[0] * push; c.p[1] += n[1] * push; c.p[2] += n[2] * push;
    };
    if (ctr[1] < rad) contact([0, 1, 0], rad - ctr[1], 0.5);
    const G = tr.G, x0 = Math.floor((ctr[0] - rad) / G), x1 = Math.floor((ctr[0] + rad) / G), z0 = Math.floor((ctr[2] - rad) / G), z1 = Math.floor((ctr[2] + rad) / G);
    for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) {
      const a = tr.grid.get((gx + 2048) * 4096 + gz + 2048); if (!a) continue;
      for (let i = 0; i < a.length; i++) {
        const t = a[i], cpt = closestOnTri(tr.T, t * 9, ctr), dv = sub(ctr, cpt), d2 = dot(dv, dv), fr = tr.mats[t] === 1 ? 0.12 : 0.5;
        const n = [tr.NR[t * 3], tr.NR[t * 3 + 1], tr.NR[t * 3 + 2]], side = dot(dv, n);
        if (side < 0) { if (side > -1.3 && d2 - side * side < 0.01) contact(n, rad - side, fr); }   // centre got behind the surface: push back out the front
        else if (d2 < rad * rad && d2 > 1e-10) { const d = Math.sqrt(d2); contact(mul(dv, 1 / d), rad - d, fr); }
      }
    }
  }
  const vm = len(c.v); if (vm > P.vmax) c.v = mul(c.v, P.vmax / vm);
  const wm = len(c.w); if (wm > 9) c.w = mul(c.w, 9 / wm);
  c.p[0] += c.v[0] * dt; c.p[1] += c.v[1] * dt; c.p[2] += c.v[2] * dt;
  const q = c.q, w = c.w, hx = w[0] * dt * 0.5, hy = w[1] * dt * 0.5, hz = w[2] * dt * 0.5;
  const nq = [q[0] + hx * q[3] + hy * q[2] - hz * q[1], q[1] + hy * q[3] + hz * q[0] - hx * q[2], q[2] + hz * q[3] + hx * q[1] - hy * q[0], q[3] - hx * q[0] - hy * q[1] - hz * q[2]];
  const ql = Math.hypot(nq[0], nq[1], nq[2], nq[3]); c.q = [nq[0] / ql, nq[1] / ql, nq[2] / ql, nq[3] / ql];
  c.hitT = Math.max(0, c.hitT - dt);
  if (c.started && !c.finished) c.time += dt;
}
export function respawnCar(c) { placeCar(c, c.respawn.p, c.respawn.f); }

// ---------- simple driver (used to check every track can be finished and to set medal times) ----------
export function botInput(c, tr, skill) {
  const S = tr.samples, A = axes(c.q), sp = c.speed, k = skill || 1;
  let bi = c.sIdx, bd = 1e9; for (let i = Math.max(0, c.sIdx - 5); i < Math.min(S.length, c.sIdx + 60); i++) { const d = (S[i].p[0] - c.p[0]) ** 2 + (S[i].p[2] - c.p[2]) ** 2 + (S[i].p[1] - c.p[1]) ** 2 * 4; if (d < bd) { bd = d; bi = i; } }
  c.sIdx = bi;
  const look = 9 + sp * 0.42, ti = Math.min(S.length - 1, bi + Math.round(look / 2.5)), tp = S[ti].p, rel = sub(tp, c.p);
  let steer = clamp(Math.atan2(dot(rel, A[0]), dot(rel, A[2])) * 2.4, -1, 1);
  if (c.grounded === 0) steer = 0;
  // speed planning from curvature ahead
  let allow = 1e9; const horizon = Math.min(S.length - 2, bi + Math.round((30 + sp * 2.6) / 2.5));
  for (let i = bi + 2; i < horizon; i += 2) {
    const a = S[i], b = S[Math.min(S.length - 1, i + 4)]; if (a.air || b.air) continue;
    const turn = Math.abs(Math.atan2(a.f[0] * b.f[2] - a.f[2] * b.f[0], a.f[0] * b.f[0] + a.f[2] * b.f[2]));
    if (turn < 0.02) continue;
    const R = (b.d - a.d) / turn, vmax = Math.sqrt((27 + R * 0.38) * k * R), dist = Math.max(0, a.d - S[bi].d - 6);
    allow = Math.min(allow, Math.sqrt(vmax * vmax + 2 * 17 * k * dist));
  }
  const inp = { steer, throttle: 0, brake: 0 };
  if (sp > allow + 1.5) inp.brake = 1; else if (sp < allow) inp.throttle = 1;
  return inp;
}

// par = fastest clean run by the test driver (the "author" time)
export const TRACKS = [
  { name: 'First Lap', par: 14.85, path: 'S3 BL S2 C BL S3 BL S F' },
  { name: 'Twister', par: 17.36, path: 'S R S L S BL C S L S R S BR S2 F' },
  { name: 'Boost Alley', par: 18.31, path: 'S B S B S4 BL S C B S3 BR S2 R S L S F' },
  { name: 'Hill Climb', par: 19.39, path: 'S U U S C D D S R S L S U S C BL D S F' },
  { name: 'Bankers', par: 17.23, path: 'S B S KL S2 C KL B S KR S C KR S2 F' },
  { name: 'Big Air', par: 21.35, path: 'S B S J1 S2 BL S C B J2 S2 BL S3 C BL S F' },
  { name: 'Snake Pass', par: 17.9, path: 'S L R S R L S C L S R R S C L R S F' },
  { name: 'Sky Bridge', par: 26.39, path: 'S4 BR S C BR U S BR S4 D S C L S U BL S D S F' },
  { name: 'Canyon Run', par: 30.97, path: 'S B S KR S U S B J1 S C D S L S R S BL S B S KL C S U S BR D S R S F' },
  { name: 'Gauntlet', par: 36.42, path: 'S B L R S B J2 S C R R S U L S D B S KL S C L R L S B J1 S BR U S D R S F' }
];
