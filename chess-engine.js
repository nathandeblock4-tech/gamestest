// Game Room chess engine (runs in a Web Worker).
// 0x88 board, zobrist hashing, transposition table, PVS + null move + LMR, quiescence, tapered eval.
(function (root) {
  'use strict';
  const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6, BLACK = 8;
  const MATE = 30000, INF = 32000, MAXPLY = 96;
  const N_OFF = [-33, -31, -18, -14, 14, 18, 31, 33], K_OFF = [-17, -16, -15, -1, 1, 15, 16, 17];
  const B_OFF = [-17, -15, 15, 17], R_OFF = [-16, -1, 1, 16];
  const FILES = 'abcdefgh';

  // ---------- zobrist ----------
  let seed = 0x9e3779b9 | 0;
  function rnd() { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed | 0; }
  const ZLO = new Int32Array(16 * 128), ZHI = new Int32Array(16 * 128);
  for (let i = 0; i < ZLO.length; i++) { ZLO[i] = rnd(); ZHI[i] = rnd(); }
  const ZCL = new Int32Array(16), ZCH = new Int32Array(16); for (let i = 0; i < 16; i++) { ZCL[i] = rnd(); ZCH[i] = rnd(); }
  const ZEL = new Int32Array(128), ZEH = new Int32Array(128); for (let i = 0; i < 128; i++) { ZEL[i] = rnd(); ZEH[i] = rnd(); }
  const ZSL = rnd(), ZSH = rnd();

  // ---------- state ----------
  const board = new Int8Array(128);
  let side = 0, castle = 0, ep = -1, half = 0, hlo = 0, hhi = 0;
  const ksq = [0, 0];
  const CMASK = new Int8Array(128).fill(15);
  CMASK[0x70] = 13; CMASK[0x77] = 14; CMASK[0x74] = 12; CMASK[0x00] = 7; CMASK[0x07] = 11; CMASK[0x04] = 3;
  const uCap = new Int8Array(1024), uCas = new Int8Array(1024), uEp = new Int16Array(1024), uHalf = new Int16Array(1024), uLo = new Int32Array(1024), uHi = new Int32Array(1024);
  let sp = 0;
  const hisLo = new Int32Array(4096), hisHi = new Int32Array(4096); let hp = 0;

  function xp(p, sq) { const i = (p << 7) | sq; hlo ^= ZLO[i]; hhi ^= ZHI[i]; }
  function computeHash() {
    hlo = 0; hhi = 0;
    for (let sq = 0; sq < 128; sq++) { if (sq & 0x88) { sq += 7; continue; } if (board[sq]) xp(board[sq], sq); }
    hlo ^= ZCL[castle]; hhi ^= ZCH[castle];
    if (ep >= 0) { hlo ^= ZEL[ep]; hhi ^= ZEH[ep]; }
    if (side) { hlo ^= ZSL; hhi ^= ZSH; }
  }
  const PCH = { p: PAWN, n: KNIGHT, b: BISHOP, r: ROOK, q: QUEEN, k: KING };
  function loadFen(fen) {
    board.fill(0);
    const parts = fen.trim().split(/\s+/); let r = 0, f = 0;
    for (const ch of parts[0]) {
      if (ch === '/') { r++; f = 0; continue; }
      if (ch >= '1' && ch <= '8') { f += +ch; continue; }
      const lo = ch.toLowerCase(), p = PCH[lo] | (ch === lo ? BLACK : 0), sq = r * 16 + f;
      board[sq] = p; if ((p & 7) === KING) ksq[p >> 3] = sq; f++;
    }
    side = parts[1] === 'b' ? BLACK : 0;
    const cs = parts[2] || '-'; castle = (cs.indexOf('K') >= 0 ? 1 : 0) | (cs.indexOf('Q') >= 0 ? 2 : 0) | (cs.indexOf('k') >= 0 ? 4 : 0) | (cs.indexOf('q') >= 0 ? 8 : 0);
    ep = parts[3] && parts[3] !== '-' ? (8 - +parts[3][1]) * 16 + FILES.indexOf(parts[3][0]) : -1;
    half = +(parts[4] || 0);
    sp = 0; computeHash();
  }

  // ---------- attacks ----------
  function attacked(sq, by) {
    if (by === 0) { let s = sq + 15; if (!(s & 0x88) && board[s] === PAWN) return true; s = sq + 17; if (!(s & 0x88) && board[s] === PAWN) return true; }
    else { let s = sq - 15; if (!(s & 0x88) && board[s] === (PAWN | BLACK)) return true; s = sq - 17; if (!(s & 0x88) && board[s] === (PAWN | BLACK)) return true; }
    const kn = KNIGHT | by, kg = KING | by, bi = BISHOP | by, ro = ROOK | by, qu = QUEEN | by;
    for (let i = 0; i < 8; i++) { const s = sq + N_OFF[i]; if (!(s & 0x88) && board[s] === kn) return true; }
    for (let i = 0; i < 8; i++) { const s = sq + K_OFF[i]; if (!(s & 0x88) && board[s] === kg) return true; }
    for (let i = 0; i < 4; i++) { const d = B_OFF[i]; let s = sq + d; while (!(s & 0x88)) { const p = board[s]; if (p) { if (p === bi || p === qu) return true; break; } s += d; } }
    for (let i = 0; i < 4; i++) { const d = R_OFF[i]; let s = sq + d; while (!(s & 0x88)) { const p = board[s]; if (p) { if (p === ro || p === qu) return true; break; } s += d; } }
    return false;
  }
  const inCheck = () => attacked(ksq[side >> 3], side ^ BLACK);

  // ---------- moves: from | to<<7 | promo<<14 | flag<<17 (1 double, 2 ep, 3 castle) ----------
  const MV = new Int32Array(256 * MAXPLY), MS = new Int32Array(256 * MAXPLY);
  function gen(base, caps) {
    let n = base; const us = side, them = side ^ BLACK;
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const p = board[sq]; if (!p || (p & BLACK) !== us) continue;
      const t = p & 7;
      if (t === PAWN) {
        const dir = us ? 16 : -16, to = sq + dir, last = us ? 7 : 0, row = sq >> 4;
        if (!board[to]) {
          if ((to >> 4) === last) { MV[n++] = sq | to << 7 | QUEEN << 14; if (!caps) { MV[n++] = sq | to << 7 | KNIGHT << 14; MV[n++] = sq | to << 7 | ROOK << 14; MV[n++] = sq | to << 7 | BISHOP << 14; } }
          else if (!caps) { MV[n++] = sq | to << 7; if (row === (us ? 1 : 6) && !board[to + dir]) MV[n++] = sq | (to + dir) << 7 | 1 << 17; }
        }
        for (let k = -1; k <= 1; k += 2) {
          const c = to + k; if (c & 0x88) continue; const q = board[c];
          if (q && (q & BLACK) === them) {
            if ((c >> 4) === last) { MV[n++] = sq | c << 7 | QUEEN << 14; if (!caps) { MV[n++] = sq | c << 7 | KNIGHT << 14; MV[n++] = sq | c << 7 | ROOK << 14; MV[n++] = sq | c << 7 | BISHOP << 14; } }
            else MV[n++] = sq | c << 7;
          } else if (c === ep) MV[n++] = sq | c << 7 | 2 << 17;
        }
      } else if (t === KNIGHT || t === KING) {
        const off = t === KNIGHT ? N_OFF : K_OFF;
        for (let i = 0; i < 8; i++) { const to = sq + off[i]; if (to & 0x88) continue; const q = board[to]; if (!q) { if (!caps) MV[n++] = sq | to << 7; } else if ((q & BLACK) === them) MV[n++] = sq | to << 7; }
        if (t === KING && !caps) {
          if (!us) {
            if ((castle & 1) && !board[0x75] && !board[0x76] && board[0x77] === ROOK && !attacked(0x74, them) && !attacked(0x75, them) && !attacked(0x76, them)) MV[n++] = 0x74 | 0x76 << 7 | 3 << 17;
            if ((castle & 2) && !board[0x73] && !board[0x72] && !board[0x71] && board[0x70] === ROOK && !attacked(0x74, them) && !attacked(0x73, them) && !attacked(0x72, them)) MV[n++] = 0x74 | 0x72 << 7 | 3 << 17;
          } else {
            if ((castle & 4) && !board[0x05] && !board[0x06] && board[0x07] === (ROOK | BLACK) && !attacked(0x04, them) && !attacked(0x05, them) && !attacked(0x06, them)) MV[n++] = 0x04 | 0x06 << 7 | 3 << 17;
            if ((castle & 8) && !board[0x03] && !board[0x02] && !board[0x01] && board[0x00] === (ROOK | BLACK) && !attacked(0x04, them) && !attacked(0x03, them) && !attacked(0x02, them)) MV[n++] = 0x04 | 0x02 << 7 | 3 << 17;
          }
        }
      } else {
        const off = t === BISHOP ? B_OFF : t === ROOK ? R_OFF : K_OFF, nd = off.length;
        for (let i = 0; i < nd; i++) {
          const d = off[i]; let to = sq + d;
          while (!(to & 0x88)) { const q = board[to]; if (!q) { if (!caps) MV[n++] = sq | to << 7; } else { if ((q & BLACK) === them) MV[n++] = sq | to << 7; break; } to += d; }
        }
      }
    }
    return n - base;
  }

  function make(m) {
    const from = m & 127, to = (m >> 7) & 127, pr = (m >> 14) & 7, fl = (m >> 17) & 3, p = board[from], cap = board[to];
    uCap[sp] = cap; uCas[sp] = castle; uEp[sp] = ep; uHalf[sp] = half; uLo[sp] = hlo; uHi[sp] = hhi; sp++;
    hisLo[hp] = hlo; hisHi[hp] = hhi; hp++;
    xp(p, from); board[from] = 0;
    if (cap) xp(cap, to);
    if (fl === 2) { const cs = side ? to - 16 : to + 16; xp(board[cs], cs); board[cs] = 0; }
    const np = pr ? (pr | side) : p; board[to] = np; xp(np, to);
    if (fl === 3) {
      let rf, rt; if (to === 0x76) { rf = 0x77; rt = 0x75; } else if (to === 0x72) { rf = 0x70; rt = 0x73; } else if (to === 0x06) { rf = 0x07; rt = 0x05; } else { rf = 0x00; rt = 0x03; }
      const rk = board[rf]; xp(rk, rf); board[rf] = 0; board[rt] = rk; xp(rk, rt);
    }
    if ((p & 7) === KING) ksq[side >> 3] = to;
    hlo ^= ZCL[castle]; hhi ^= ZCH[castle]; castle &= CMASK[from] & CMASK[to]; hlo ^= ZCL[castle]; hhi ^= ZCH[castle];
    if (ep >= 0) { hlo ^= ZEL[ep]; hhi ^= ZEH[ep]; }
    ep = fl === 1 ? (from + to) >> 1 : -1;
    if (ep >= 0) { hlo ^= ZEL[ep]; hhi ^= ZEH[ep]; }
    half = ((p & 7) === PAWN || cap || fl === 2) ? 0 : half + 1;
    side ^= BLACK; hlo ^= ZSL; hhi ^= ZSH;
  }
  function unmake(m) {
    const from = m & 127, to = (m >> 7) & 127, pr = (m >> 14) & 7, fl = (m >> 17) & 3;
    sp--; hp--; side ^= BLACK;
    castle = uCas[sp]; ep = uEp[sp]; half = uHalf[sp]; hlo = uLo[sp]; hhi = uHi[sp];
    const np = board[to], p = pr ? (PAWN | side) : np;
    board[from] = p; board[to] = uCap[sp];
    if (fl === 2) { const cs = side ? to - 16 : to + 16; board[cs] = PAWN | (side ^ BLACK); }
    if (fl === 3) {
      let rf, rt; if (to === 0x76) { rf = 0x77; rt = 0x75; } else if (to === 0x72) { rf = 0x70; rt = 0x73; } else if (to === 0x06) { rf = 0x07; rt = 0x05; } else { rf = 0x00; rt = 0x03; }
      board[rf] = board[rt]; board[rt] = 0;
    }
    if ((p & 7) === KING) ksq[side >> 3] = from;
  }
  function makeNull() {
    uCas[sp] = castle; uEp[sp] = ep; uHalf[sp] = half; uLo[sp] = hlo; uHi[sp] = hhi; sp++;
    hisLo[hp] = hlo; hisHi[hp] = hhi; hp++;
    if (ep >= 0) { hlo ^= ZEL[ep]; hhi ^= ZEH[ep]; } ep = -1; half++;
    side ^= BLACK; hlo ^= ZSL; hhi ^= ZSH;
  }
  function unmakeNull() { sp--; hp--; side ^= BLACK; castle = uCas[sp]; ep = uEp[sp]; half = uHalf[sp]; hlo = uLo[sp]; hhi = uHi[sp]; }

  const sqName = s => FILES[s & 7] + (8 - (s >> 4));
  const PRC = ['', '', 'n', 'b', 'r', 'q'];
  function toUci(m) { return sqName(m & 127) + sqName((m >> 7) & 127) + PRC[(m >> 14) & 7]; }
  function legalMoves() {
    const n = gen(0, false), out = [];
    for (let i = 0; i < n; i++) { const m = MV[i]; make(m); if (!attacked(ksq[(side ^ BLACK) >> 3], side)) out.push(m); unmake(m); }
    return out;
  }
  function perft(d) {
    if (d === 0) return 1;
    const base = d * 256, n = gen(base, false); let c = 0;
    for (let i = 0; i < n; i++) { const m = MV[base + i]; make(m); if (!attacked(ksq[(side ^ BLACK) >> 3], side)) c += perft(d - 1); unmake(m); }
    return c;
  }

  // ---------- evaluation ----------
  const MGV = [0, 82, 337, 365, 477, 1025, 0], EGV = [0, 94, 281, 297, 512, 936, 0];
  const PH = [0, 0, 1, 1, 2, 4, 0];
  // tables indexed a8..h1 from White's point of view
  const T = {
    Pm: [0, 0, 0, 0, 0, 0, 0, 0, 98, 134, 61, 95, 68, 126, 34, -11, -6, 7, 26, 31, 65, 56, 25, -20, -14, 13, 6, 21, 23, 12, 17, -23, -27, -2, -5, 12, 17, 6, 10, -25, -26, -4, -4, -10, 3, 3, 33, -12, -35, -1, -20, -23, -15, 24, 38, -22, 0, 0, 0, 0, 0, 0, 0, 0],
    Pe: [0, 0, 0, 0, 0, 0, 0, 0, 178, 173, 158, 134, 147, 132, 165, 187, 94, 100, 85, 67, 56, 53, 82, 84, 32, 24, 13, 5, -2, 4, 17, 17, 13, 9, -3, -7, -7, -8, 3, -1, 4, 7, -6, 1, 0, -5, -1, -8, 13, 8, 8, 10, 13, 0, 2, -7, 0, 0, 0, 0, 0, 0, 0, 0],
    Nm: [-167, -89, -34, -49, 61, -97, -15, -107, -73, -41, 72, 36, 23, 62, 7, -17, -47, 60, 37, 65, 84, 129, 73, 44, -9, 17, 19, 53, 37, 69, 18, 22, -13, 4, 16, 13, 28, 19, 21, -8, -23, -9, 12, 10, 19, 17, 25, -16, -29, -53, -12, -3, -1, 18, -14, -19, -105, -21, -58, -33, -17, -28, -19, -23],
    Ne: [-58, -38, -13, -28, -31, -27, -63, -99, -25, -8, -25, -2, -9, -25, -24, -52, -24, -20, 10, 9, -1, -9, -19, -41, -17, 3, 22, 22, 22, 11, 8, -18, -18, -6, 16, 25, 16, 17, 4, -18, -23, -3, -1, 15, 10, -3, -20, -22, -42, -20, -10, -5, -2, -20, -23, -44, -29, -51, -23, -15, -22, -18, -50, -64],
    Bm: [-29, 4, -82, -37, -25, -42, 7, -8, -26, 16, -18, -13, 30, 59, 18, -47, -16, 37, 43, 40, 35, 50, 37, -2, -4, 5, 19, 50, 37, 37, 7, -2, -6, 13, 13, 26, 34, 12, 10, 4, 0, 15, 15, 15, 14, 27, 18, 10, 4, 15, 16, 0, 7, 21, 33, 1, -33, -3, -14, -21, -13, -12, -39, -21],
    Be: [-14, -21, -11, -8, -7, -9, -17, -24, -8, -4, 7, -12, -3, -13, -4, -14, 2, -8, 0, -1, -2, 6, 0, 4, -3, 9, 12, 9, 14, 10, 3, 2, -6, 3, 13, 19, 7, 10, -3, -9, -12, -3, 8, 10, 13, 3, -7, -15, -14, -18, -7, -1, 4, -9, -15, -27, -23, -9, -23, -5, -9, -16, -5, -17],
    Rm: [32, 42, 32, 51, 63, 9, 31, 43, 27, 32, 58, 62, 80, 67, 26, 44, -5, 19, 26, 36, 17, 45, 61, 16, -24, -11, 7, 26, 24, 35, -8, -20, -36, -26, -12, -1, 9, -7, 6, -23, -45, -25, -16, -17, 3, 0, -5, -33, -44, -16, -20, -9, -1, 11, -6, -71, -19, -13, 1, 17, 16, 7, -37, -26],
    Re: [13, 10, 18, 15, 12, 12, 8, 5, 11, 13, 13, 11, -3, 3, 8, 3, 7, 7, 7, 5, 4, -3, -5, -3, 4, 3, 13, 1, 2, 1, -1, 2, 3, 5, 8, 4, -5, -6, -8, -11, -4, 0, -5, -1, -7, -12, -8, -16, -6, -6, 0, 2, -9, -9, -11, -3, -9, 2, 3, -1, -5, -13, 4, -20],
    Qm: [-28, 0, 29, 12, 59, 44, 43, 45, -24, -39, -5, 1, -16, 57, 28, 54, -13, -17, 7, 8, 29, 56, 47, 57, -27, -27, -16, -16, -1, 17, -2, 1, -9, -26, -9, -10, -2, -4, 3, -3, -14, 2, -11, -2, -5, 2, 14, 5, -35, -8, 11, 2, 8, 15, -3, 1, -1, -18, -9, 10, -15, -25, -31, -50],
    Qe: [-9, 22, 22, 27, 27, 19, 10, 20, -17, 20, 32, 41, 58, 25, 30, 0, -20, 6, 9, 49, 47, 35, 19, 9, 3, 22, 24, 45, 57, 40, 57, 36, -18, 28, 19, 47, 31, 34, 39, 23, -16, -27, 15, 6, 9, 17, 10, 5, -22, -23, -30, -16, -16, -23, -36, -32, -33, -28, -22, -43, -5, -32, -20, -41],
    Km: [-65, 23, 16, -15, -56, -34, 2, 13, 29, -1, -20, -7, -8, -4, -38, -29, -9, 24, 2, -16, -20, 6, 22, -22, -17, -20, -12, -27, -30, -25, -14, -36, -49, -1, -27, -39, -46, -44, -33, -51, -14, -14, -22, -46, -44, -30, -15, -27, 1, 7, -8, -64, -43, -16, 9, 8, -15, 36, 12, -54, 8, -28, 24, 14],
    Ke: [-74, -35, -18, -18, -11, 15, 4, -17, -12, 17, 14, 17, 17, 38, 23, 11, 10, 17, 23, 15, 20, 45, 44, 13, -8, 22, 24, 27, 26, 33, 26, 3, -18, -4, 21, 24, 27, 23, 9, -11, -19, -3, 11, 21, 23, 16, 7, -9, -27, -11, 4, 13, 14, 4, -5, -17, -53, -34, -21, -11, -28, -14, -24, -43]
  };
  const MGT = [null, T.Pm, T.Nm, T.Bm, T.Rm, T.Qm, T.Km], EGT = [null, T.Pe, T.Ne, T.Be, T.Re, T.Qe, T.Ke];
  const PASS_MG = [0, 5, 10, 15, 25, 45, 70, 0], PASS_EG = [0, 10, 18, 30, 55, 90, 140, 0];
  const wMax = new Int8Array(10), bMin = new Int8Array(10), wCnt = new Int8Array(10), bCnt = new Int8Array(10);
  function evaluate() {
    let mg = 0, eg = 0, phase = 0, wb = 0, bb = 0, wnp = 0, bnp = 0;
    wMax.fill(-1); bMin.fill(8); wCnt.fill(0); bCnt.fill(0);
    for (let sq = 0; sq < 120; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const p = board[sq]; if ((p & 7) !== PAWN) continue;
      const f = (sq & 7) + 1, r = sq >> 4;
      if (p & BLACK) { bCnt[f]++; if (r < bMin[f]) bMin[f] = r; } else { wCnt[f]++; if (r > wMax[f]) wMax[f] = r; }
    }
    // need min row of white pawns and max row of black pawns for passers too
    for (let sq = 0; sq < 120; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const p = board[sq]; if (!p) continue;
      const t = p & 7, f = sq & 7, r = sq >> 4, i = r * 8 + f, black = p & BLACK, ix = black ? i ^ 56 : i;
      let m = MGV[t] + MGT[t][ix], e = EGV[t] + EGT[t][ix];
      phase += PH[t];
      if (t === PAWN) {
        const F = f + 1;
        if (!black) {
          if (!anyBlackPawnAhead(F, r)) { const a = 6 - r; m += PASS_MG[a]; e += PASS_EG[a]; }
          if (!wCnt[F - 1] && !wCnt[F + 1]) { m -= 10; e -= 14; }
          if (wCnt[F] > 1) { m -= 6; e -= 12; }
        } else {
          if (!anyWhitePawnAhead(F, r)) { const a = r - 1; m += PASS_MG[a]; e += PASS_EG[a]; }
          if (!bCnt[F - 1] && !bCnt[F + 1]) { m -= 10; e -= 14; }
          if (bCnt[F] > 1) { m -= 6; e -= 12; }
        }
      } else if (t !== KING) {
        if (black) bnp += MGV[t]; else wnp += MGV[t];
        if (t === BISHOP) { if (black) bb++; else wb++; }
        // mobility
        let mob = 0; const us = black;
        if (t === KNIGHT) { for (let k = 0; k < 8; k++) { const s = sq + N_OFF[k]; if (!(s & 0x88) && (!board[s] || (board[s] & BLACK) !== us)) mob++; } m += 4 * (mob - 4); e += 4 * (mob - 4); }
        else {
          const off = t === BISHOP ? B_OFF : t === ROOK ? R_OFF : K_OFF;
          for (let k = 0; k < off.length; k++) { let s = sq + off[k]; while (!(s & 0x88)) { const q = board[s]; if (!q) mob++; else { if ((q & BLACK) !== us) mob++; break; } s += off[k]; } }
          if (t === BISHOP) { m += 5 * (mob - 7); e += 5 * (mob - 7); }
          else if (t === ROOK) {
            m += 2 * (mob - 7); e += 4 * (mob - 7);
            const F = f + 1, own = black ? bCnt[F] : wCnt[F], opp = black ? wCnt[F] : bCnt[F];
            if (!own) { if (!opp) { m += 25; e += 10; } else { m += 12; e += 5; } }
          } else { m += 1 * (mob - 14); e += 2 * (mob - 14); }
        }
      } else {
        // king shelter (middlegame)
        if (f <= 2 || f >= 5) {
          const dir = black ? 16 : -16, own = PAWN | black; let miss = 0;
          for (let df = -1; df <= 1; df++) { const ff = f + df; if (ff < 0 || ff > 7) continue; const s1 = sq + dir + df, s2 = sq + 2 * dir + df; if (!((s1 & 0x88) === 0 && board[s1] === own) && !((s2 & 0x88) === 0 && board[s2] === own)) miss++; }
          m -= 18 * miss;
        }
      }
      if (black) { mg -= m; eg -= e; } else { mg += m; eg += e; }
    }
    if (wb >= 2) { mg += 30; eg += 50; } if (bb >= 2) { mg -= 30; eg -= 50; }
    if (phase > 24) phase = 24;
    let s = ((mg * phase + eg * (24 - phase)) / 24) | 0;
    // mop-up: help convert won endgames
    if (phase <= 8 && Math.abs(s) > 400) {
      const strong = s > 0 ? 0 : 1, wk = ksq[strong], lk = ksq[strong ^ 1];
      const lf = lk & 7, lr = lk >> 4, cd = Math.max(3 - lf, lf - 4) + Math.max(3 - lr, lr - 4);
      const dist = Math.abs((wk & 7) - lf) + Math.abs((wk >> 4) - lr);
      const bonus = cd * 12 + (14 - dist) * 5;
      s += strong === 0 ? bonus : -bonus;
    }
    // drawish: no pawns and only a minor piece ahead
    const wp = wCntSum(), bp = bCntSum();
    if (s > 0 && !wp && wnp - bnp <= 365) s = s >> 3; else if (s < 0 && !bp && bnp - wnp <= 365) s = -((-s) >> 3);
    s = side ? -s : s;
    return s + 12;
  }
  function wCntSum() { let n = 0; for (let i = 1; i <= 8; i++) n += wCnt[i]; return n; }
  function bCntSum() { let n = 0; for (let i = 1; i <= 8; i++) n += bCnt[i]; return n; }
  // exact passed-pawn checks (bMin/wMax give quick filters; these confirm)
  function anyBlackPawnAhead(F, r) { for (let ff = F - 2; ff <= F; ff++) { if (ff < 0 || ff > 7) continue; for (let rr = r - 1; rr >= 1; rr--) if (board[rr * 16 + ff] === (PAWN | BLACK)) return true; } return false; }
  function anyWhitePawnAhead(F, r) { for (let ff = F - 2; ff <= F; ff++) { if (ff < 0 || ff > 7) continue; for (let rr = r + 1; rr <= 6; rr++) if (board[rr * 16 + ff] === PAWN) return true; } return false; }

  // ---------- transposition table ----------
  const TTN = 1 << 19, TTM = TTN - 1;
  const ttKey = new Int32Array(TTN), ttMove = new Int32Array(TTN), ttScore = new Int32Array(TTN), ttDepth = new Int8Array(TTN), ttFlag = new Int8Array(TTN);
  function ttStore(depth, flag, score, move, ply) {
    const i = hlo & TTM;
    if (ttKey[i] === hhi && ttDepth[i] > depth && flag !== 1) return;
    if (score > MATE - 500) score += ply; else if (score < -MATE + 500) score -= ply;
    ttKey[i] = hhi; ttMove[i] = move; ttScore[i] = score; ttDepth[i] = depth; ttFlag[i] = flag;
  }

  // ---------- search ----------
  const killers = new Int32Array(MAXPLY * 2), history = new Int32Array(2 * 128 * 128);
  let nodes = 0, stop = false, deadline = 0, rootHp = 0;
  const VICT = [0, 100, 320, 330, 500, 900, 2000];
  function isRep() {
    const lim = Math.max(0, hp - half);
    for (let i = hp - 2; i >= lim; i -= 2) if (hisLo[i] === hlo && hisHi[i] === hhi) return true;
    return false;
  }
  function scoreMoves(base, n, ttm, ply) {
    const k1 = killers[ply * 2], k2 = killers[ply * 2 + 1], hb = side ? 16384 : 0;
    for (let i = base; i < base + n; i++) {
      const m = MV[i], to = (m >> 7) & 127, pr = (m >> 14) & 7, fl = (m >> 17) & 3, cap = board[to];
      if (m === ttm) MS[i] = 3000000;
      else if (cap || fl === 2) MS[i] = 1000000 + VICT[cap ? cap & 7 : 1] * 10 - (board[m & 127] & 7);
      else if (pr) MS[i] = pr === QUEEN ? 950000 : -100000;
      else if (m === k1) MS[i] = 900000;
      else if (m === k2) MS[i] = 800000;
      else MS[i] = history[hb + ((m & 127) << 7) + to];
    }
  }
  function pick(i, end) {
    let b = i, bs = MS[i];
    for (let j = i + 1; j < end; j++) if (MS[j] > bs) { bs = MS[j]; b = j; }
    if (b !== i) { const tm = MV[i]; MV[i] = MV[b]; MV[b] = tm; const ts = MS[i]; MS[i] = MS[b]; MS[b] = ts; }
    return MV[i];
  }
  function nonPawn(s) { for (let sq = 0; sq < 120; sq++) { if (sq & 0x88) { sq += 7; continue; } const p = board[sq]; if (p && (p & BLACK) === s && (p & 7) !== PAWN && (p & 7) !== KING) return true; } return false; }

  function qs(alpha, beta, ply) {
    if ((++nodes & 2047) === 0 && Date.now() > deadline) stop = true;
    if (stop) return 0;
    const stand = evaluate();
    if (ply >= MAXPLY - 1) return stand;
    if (stand >= beta) return stand;
    if (stand > alpha) alpha = stand;
    const base = ply * 256, n = gen(base, true);
    scoreMoves(base, n, 0, ply);
    let best = stand;
    for (let i = base; i < base + n; i++) {
      const m = pick(i, base + n), to = (m >> 7) & 127, cap = board[to], pr = (m >> 14) & 7;
      if (!pr && stand + VICT[cap ? cap & 7 : 1] + 180 < alpha) continue;
      make(m);
      if (attacked(ksq[(side ^ BLACK) >> 3], side)) { unmake(m); continue; }
      const s = -qs(-beta, -alpha, ply + 1);
      unmake(m);
      if (stop) return 0;
      if (s > best) { best = s; if (s > alpha) { alpha = s; if (s >= beta) return s; } }
    }
    return best;
  }

  function search(depth, alpha, beta, ply, allowNull) {
    if ((++nodes & 2047) === 0 && Date.now() > deadline) stop = true;
    if (stop) return 0;
    const pv = beta - alpha > 1;
    if (half >= 100 || isRep()) return 0;
    // mate distance pruning
    if (alpha < -MATE + ply) alpha = -MATE + ply; if (beta > MATE - ply - 1) beta = MATE - ply - 1; if (alpha >= beta) return alpha;
    const chk = inCheck();
    if (chk) depth++;
    if (depth <= 0) return qs(alpha, beta, ply);
    if (ply >= MAXPLY - 2) return evaluate();
    const ti = hlo & TTM; let ttm = 0;
    if (ttKey[ti] === hhi) {
      ttm = ttMove[ti];
      if (!pv && ttDepth[ti] >= depth) {
        let s = ttScore[ti]; if (s > MATE - 500) s -= ply; else if (s < -MATE + 500) s += ply;
        const f = ttFlag[ti];
        if (f === 1 || (f === 2 && s >= beta) || (f === 3 && s <= alpha)) return s;
      }
    }
    const ev = chk ? -INF : evaluate();
    if (!pv && !chk) {
      if (depth <= 4 && ev - 85 * depth >= beta && Math.abs(beta) < MATE - 500) return ev;
      if (allowNull && depth >= 3 && ev >= beta && nonPawn(side)) {
        const R = 3 + (depth >= 7 ? 1 : 0);
        makeNull(); const s = -search(depth - 1 - R, -beta, -beta + 1, ply + 1, false); unmakeNull();
        if (stop) return 0;
        if (s >= beta) return s > MATE - 500 ? beta : s;
      }
    }
    const base = ply * 256, n = gen(base, false);
    scoreMoves(base, n, ttm, ply);
    let best = -INF, bestM = 0, legal = 0; const a0 = alpha, hb = side ? 16384 : 0;
    for (let i = base; i < base + n; i++) {
      const m = pick(i, base + n), to = (m >> 7) & 127, quiet = !board[to] && !((m >> 14) & 7) && ((m >> 17) & 3) !== 2;
      if (!pv && !chk && quiet && legal > 0 && depth <= 3 && ev + 110 * depth + 60 <= alpha) continue;
      make(m);
      if (attacked(ksq[(side ^ BLACK) >> 3], side)) { unmake(m); continue; }
      legal++;
      const gives = attacked(ksq[side >> 3], side ^ BLACK);
      let s;
      if (legal === 1) s = -search(depth - 1, -beta, -alpha, ply + 1, true);
      else {
        let R = 0;
        if (depth >= 3 && quiet && !chk && !gives && legal > 3) {
          R = 1 + (legal > 8 ? 1 : 0) + (depth >= 7 ? 1 : 0);
          if (pv) R--; if (m === killers[ply * 2] || m === killers[ply * 2 + 1]) R--; if (R < 0) R = 0; if (R > depth - 2) R = depth - 2;
        }
        s = -search(depth - 1 - R, -alpha - 1, -alpha, ply + 1, true);
        if (s > alpha && R > 0) s = -search(depth - 1, -alpha - 1, -alpha, ply + 1, true);
        if (s > alpha && s < beta) s = -search(depth - 1, -beta, -alpha, ply + 1, true);
      }
      unmake(m);
      if (stop) return 0;
      if (s > best) {
        best = s; bestM = m;
        if (s > alpha) {
          alpha = s;
          if (s >= beta) {
            if (quiet) {
              if (killers[ply * 2] !== m) { killers[ply * 2 + 1] = killers[ply * 2]; killers[ply * 2] = m; }
              const hi = hb + ((m & 127) << 7) + to; history[hi] += depth * depth; if (history[hi] > 700000) for (let k = 0; k < history.length; k++) history[k] >>= 1;
            }
            break;
          }
        }
      }
    }
    if (!legal) return chk ? -MATE + ply : 0;
    ttStore(depth, best >= beta ? 2 : best > a0 ? 1 : 3, best, bestM, ply);
    return best;
  }

  // ---------- levels ----------
  // d = max depth, ms = think time, sigma = random error (centipawns), blunder = chance of a careless move
  const LEVELS = [
    null,
    { d: 1, ms: 250, sigma: 320, blunder: 0.40, all: 1 },
    { d: 1, ms: 300, sigma: 200, blunder: 0.22, all: 1 },
    { d: 2, ms: 350, sigma: 140, blunder: 0.12, all: 1 },
    { d: 2, ms: 450, sigma: 95, blunder: 0.07, all: 1, book: 1 },
    { d: 3, ms: 550, sigma: 60, blunder: 0.035, all: 1, book: 1 },
    { d: 4, ms: 700, sigma: 38, blunder: 0.015, all: 1, book: 1 },
    { d: 5, ms: 900, sigma: 22, blunder: 0, all: 1, book: 1 },
    { d: 6, ms: 1000, sigma: 12, blunder: 0, all: 1, book: 1 },
    { d: 9, ms: 1500, sigma: 0, blunder: 0, book: 1 },
    { d: 64, ms: 3500, sigma: 0, blunder: 0, book: 1 }
  ];
  const BOOK = {
    '': ['e2e4', 'e2e4', 'd2d4', 'd2d4', 'c2c4', 'g1f3'],
    'e2e4': ['e7e5', 'e7e5', 'c7c5', 'c7c5', 'e7e6', 'c7c6'],
    'e2e4 e7e5': ['g1f3', 'g1f3', 'b1c3'], 'e2e4 e7e5 g1f3': ['b8c6', 'b8c6', 'g8f6'], 'e2e4 e7e5 g1f3 b8c6': ['f1b5', 'f1c4', 'd2d4'],
    'e2e4 e7e5 g1f3 b8c6 f1b5': ['a7a6', 'g8f6'], 'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6': ['b5a4'], 'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4': ['g8f6'],
    'e2e4 e7e5 g1f3 b8c6 f1c4': ['f8c5', 'g8f6'], 'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5': ['c2c3', 'd2d3', 'e1g1'],
    'e2e4 e7e5 g1f3 b8c6 d2d4': ['e5d4'], 'e2e4 e7e5 g1f3 b8c6 d2d4 e5d4': ['f3d4'], 'e2e4 e7e5 g1f3 g8f6': ['f3e5', 'b1c3'],
    'e2e4 e7e5 b1c3': ['g8f6', 'b8c6'],
    'e2e4 c7c5': ['g1f3', 'g1f3', 'b1c3'], 'e2e4 c7c5 g1f3': ['d7d6', 'b8c6', 'e7e6'], 'e2e4 c7c5 g1f3 d7d6': ['d2d4'], 'e2e4 c7c5 g1f3 d7d6 d2d4': ['c5d4'], 'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4': ['f3d4'],
    'e2e4 c7c5 g1f3 b8c6': ['d2d4', 'f1b5'], 'e2e4 c7c5 g1f3 e7e6': ['d2d4'], 'e2e4 c7c5 b1c3': ['b8c6', 'd7d6'],
    'e2e4 e7e6': ['d2d4'], 'e2e4 e7e6 d2d4': ['d7d5'], 'e2e4 e7e6 d2d4 d7d5': ['b1c3', 'e4e5', 'b1d2'],
    'e2e4 c7c6': ['d2d4'], 'e2e4 c7c6 d2d4': ['d7d5'], 'e2e4 c7c6 d2d4 d7d5': ['b1c3', 'e4e5'],
    'd2d4': ['d7d5', 'g8f6', 'g8f6'], 'd2d4 d7d5': ['c2c4', 'g1f3'], 'd2d4 d7d5 c2c4': ['e7e6', 'c7c6', 'd5c4'], 'd2d4 d7d5 c2c4 e7e6': ['b1c3', 'g1f3'], 'd2d4 d7d5 c2c4 c7c6': ['g1f3', 'b1c3'],
    'd2d4 d7d5 g1f3': ['g8f6'], 'd2d4 g8f6': ['c2c4', 'g1f3'], 'd2d4 g8f6 c2c4': ['e7e6', 'g7g6'], 'd2d4 g8f6 c2c4 e7e6': ['g1f3', 'b1c3'], 'd2d4 g8f6 c2c4 g7g6': ['b1c3'], 'd2d4 g8f6 g1f3': ['g7g6', 'e7e6', 'd7d5'],
    'c2c4': ['e7e5', 'g8f6', 'c7c5'], 'c2c4 e7e5': ['b1c3'], 'c2c4 g8f6': ['b1c3', 'g1f3'],
    'g1f3': ['d7d5', 'g8f6'], 'g1f3 d7d5': ['d2d4', 'g2g3'], 'g1f3 g8f6': ['c2c4', 'g2g3', 'd2d4']
  };
  function gauss() { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

  function think(req) {
    const lv = LEVELS[Math.max(1, Math.min(10, req.level | 0 || 10))];
    const maxD = req.depth || lv.d, ms = req.ms || lv.ms;
    // repetition history from previous game positions
    hp = 0;
    if (req.hist) for (const f of req.hist.slice(-100)) { loadFen(f); hisLo[hp] = hlo; hisHi[hp] = hhi; hp++; }
    loadFen(req.fen); rootHp = hp;
    const root = legalMoves();
    if (!root.length) return { uci: null, score: inCheck() ? -MATE : 0, depth: 0 };
    // opening book
    if (!req.noBook && lv.book && req.moves && req.moves.length < 12) {
      const opts = BOOK[req.moves.join(' ')];
      if (opts) { const u = opts[Math.floor(Math.random() * opts.length)]; if (root.some(m => toUci(m) === u)) return { uci: u, score: 0, depth: 0, book: true }; }
    }
    if (root.length === 1 && !req.analyze) return { uci: toUci(root[0]), score: 0, depth: 0 };
    if (!req.analyze && lv.blunder && Math.random() < lv.blunder) return { uci: toUci(root[Math.floor(Math.random() * root.length)]), score: 0, depth: 0 };
    nodes = 0; stop = false; deadline = Date.now() + ms; killers.fill(0);
    for (let k = 0; k < history.length; k++) history[k] >>= 2;
    let order = root.slice(), scores = new Array(root.length).fill(0), done = null, doneScores = null, doneDepth = 0;
    const multi = lv.all && !req.analyze;
    const t0 = Date.now();
    for (let d = 1; d <= maxD; d++) {
      let alpha = -INF, beta = INF; const sc = new Array(order.length).fill(-INF);
      let bestI = 0;
      for (let i = 0; i < order.length; i++) {
        const m = order[i]; make(m);
        let s;
        if (multi || i === 0) s = -search(d - 1, -INF, multi ? INF : -alpha, 1, true);
        else { s = -search(d - 1, -alpha - 1, -alpha, 1, true); if (s > alpha && !stop) s = -search(d - 1, -INF, -alpha, 1, true); }
        unmake(m);
        if (stop) break;
        sc[i] = s;
        if (s > alpha) { alpha = s; bestI = i; }
      }
      if (stop && d > 1) {
        // keep partial result only if a new best move was fully searched
        if (bestI > 0 && sc[bestI] > (doneScores ? doneScores[0] : -INF)) { done = [order[bestI]].concat(done.filter(m => m !== order[bestI])); }
        break;
      }
      const idx = order.map((m, i) => i).sort((a, b) => sc[b] - sc[a]);
      order = idx.map(i => order[i]); doneScores = idx.map(i => sc[i]); done = order.slice(); doneDepth = d;
      if (Math.abs(doneScores[0]) > MATE - 200 && !multi) break;
      if (!req.analyze && Date.now() - t0 > ms * 0.5) break;
      if (stop) break;
    }
    let pickI = 0;
    if (lv.sigma && !req.analyze) {
      let top = -Infinity;
      for (let i = 0; i < done.length; i++) {
        let s = doneScores[i];
        if (s < -MATE + 200 && doneScores[0] > -MATE + 200 && req.level >= 3) continue; // don't walk into mate
        const v = s + gauss() * lv.sigma; if (v > top) { top = v; pickI = i; }
      }
      if (doneScores[0] > MATE - 200 && req.level >= 3) pickI = 0; // always take a found mate
    }
    let sc = doneScores ? doneScores[pickI] : 0;
    return { uci: toUci(done[pickI]), score: sc, depth: doneDepth, nodes: nodes };
  }

  function toFen() {
    let s = '';
    for (let r = 0; r < 8; r++) { let e = 0; for (let f = 0; f < 8; f++) { const p = board[r * 16 + f]; if (!p) { e++; continue; } if (e) { s += e; e = 0; } const c = ' pnbrqk'[p & 7]; s += p & BLACK ? c : c.toUpperCase(); } if (e) s += e; if (r < 7) s += '/'; }
    const cs = (castle & 1 ? 'K' : '') + (castle & 2 ? 'Q' : '') + (castle & 4 ? 'k' : '') + (castle & 8 ? 'q' : '');
    return s + ' ' + (side ? 'b' : 'w') + ' ' + (cs || '-') + ' ' + (ep >= 0 ? sqName(ep) : '-') + ' ' + half + ' 1';
  }
  function playUci(u) { const m = legalMoves().find(x => toUci(x) === u); if (m) make(m); return !!m; }
  const api = { toFen, playUci, inCheck, half: () => half, loadFen, perft, legalMoves, toUci, think, evaluate: () => evaluate(), MATE };
  root.CHESS_ENGINE = api;
  if (typeof root.postMessage === 'function' && typeof root.document === 'undefined') {
    root.onmessage = function (e) {
      const d = e.data || {};
      let r; try { r = think(d); } catch (err) { r = { uci: null, err: String(err) }; }
      // score from White's point of view
      const stm = (d.fen || '').split(' ')[1] === 'b' ? -1 : 1;
      root.postMessage({ id: d.id, kind: d.kind, uci: r.uci, score: (r.score || 0) * stm, depth: r.depth, book: !!r.book, mate: Math.abs(r.score || 0) > MATE - 200 });
    };
  }
})(typeof self !== 'undefined' ? self : this);
