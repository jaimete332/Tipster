/* Tipster Hold'em — motor de decisión para Texas Hold'em.
 * Evaluador de 7 cartas, rangos preflop, lectura de rangos postflop,
 * equity por Monte Carlo y reglas de decisión.
 * Funciona en el navegador (window.PokerEngine) y en Node (module.exports). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PokerEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const RANKS = '23456789TJQKA';
  const SUITS = 'shdc';
  const SUIT_SYM = ['♠', '♥', '♦', '♣'];
  const CAT_ES = ['Carta alta', 'Pareja', 'Doble pareja', 'Trío', 'Escalera', 'Color', 'Full', 'Póker', 'Escalera de color'];

  const card = (r, s) => r * 4 + s;
  const rankOf = (c) => c >> 2;
  const suitOf = (c) => c & 3;
  const cardStr = (c) => RANKS[c >> 2] + SUITS[c & 3];
  function parseCard(str) {
    const r = RANKS.indexOf(str[0].toUpperCase());
    const s = SUITS.indexOf(str[1].toLowerCase());
    if (r < 0 || s < 0) throw new Error('Carta no válida: ' + str);
    return card(r, s);
  }

  /* ---------- Evaluador ---------- */
  const RC = new Int8Array(13), SC = new Int8Array(4), SM = new Int32Array(4);
  const highestBit = (b) => 31 - Math.clz32(b);

  function straightHigh(bits) {
    const b = (bits << 1) | ((bits >> 12) & 1); // el as también cuenta como 1
    for (let top = 13; top >= 4; top--) if (((b >> (top - 4)) & 31) === 31) return top - 1;
    return -1;
  }
  function topN(bits, n) {
    let out = 0, k = 0;
    for (let r = 12; r >= 0 && k < n; r--) if (bits & (1 << r)) { out = (out << 4) | r; k++; }
    while (k < n) { out <<= 4; k++; }
    return out;
  }

  /** Devuelve una puntuación comparable (mayor = mejor). Categoría = score >> 20. */
  function evaluate(cs, n) {
    if (n === undefined) n = cs.length;
    RC.fill(0); SC.fill(0); SM.fill(0);
    let mask = 0;
    for (let i = 0; i < n; i++) {
      const c = cs[i], r = c >> 2, s = c & 3;
      RC[r]++; SC[s]++; SM[s] |= 1 << r; mask |= 1 << r;
    }
    for (let s = 0; s < 4; s++) if (SC[s] >= 5) {
      const sf = straightHigh(SM[s]);
      if (sf >= 0) return (8 << 20) | sf;
      return (5 << 20) | topN(SM[s], 5);
    }
    let quad = -1, t1 = -1, t2 = -1, p1 = -1, p2 = -1;
    for (let r = 12; r >= 0; r--) {
      const k = RC[r];
      if (k === 4) quad = r;
      else if (k === 3) { if (t1 < 0) t1 = r; else if (t2 < 0) t2 = r; }
      else if (k === 2) { if (p1 < 0) p1 = r; else if (p2 < 0) p2 = r; }
    }
    if (quad >= 0) { const rest = mask & ~(1 << quad); return (7 << 20) | (quad << 4) | (rest ? highestBit(rest) : 0); }
    if (t1 >= 0 && (t2 >= 0 || p1 >= 0)) return (6 << 20) | (t1 << 4) | Math.max(t2, p1);
    const st = straightHigh(mask);
    if (st >= 0) return (4 << 20) | st;
    if (t1 >= 0) return (3 << 20) | (t1 << 8) | topN(mask & ~(1 << t1), 2);
    if (p1 >= 0 && p2 >= 0) {
      const rest = mask & ~(1 << p1) & ~(1 << p2);
      return (2 << 20) | (p1 << 8) | (p2 << 4) | (rest ? highestBit(rest) : 0);
    }
    if (p1 >= 0) return (1 << 20) | (p1 << 12) | topN(mask & ~(1 << p1), 3);
    return topN(mask, 5);
  }

  /* ---------- Clases preflop (169) ---------- */
  // Orden de mejor a peor, calculado por simulación (equity heads-up + 3 rivales, promediado).
  const CLASS_ORDER = 'AA KK QQ JJ TT 99 AKs 88 AQs AKo AJs KQs AQo ATs KJs 77 AJo A9s KTs ATo KQo QJs A8s KJo A7s 66 A9o KTo QTs A5s K9s A6s QJo A4s JTs Q9s A8o QTo A3s 55 K7s A7o K8s K9o J9s Q8s A2s K6s JTo A6o A5o K5s Q9o K8o J8s T9s A4o Q7s 44 K4s J9o Q6s T8s A3o K7o Q8o 98s K3s T9o J7s A2o K2s K6o Q5s Q4s K5o J8o 97s T7s 33 Q3s T8o Q7o J6s 87s K4o Q2s J5s T6s Q6o K3o J4s J7o 98o J3s 96s 86s 76s T7o K2o J2s T5s Q5o 22 T4s 97o Q4o 95s 65s 75s J6o T6o T3s Q3o 87o T2s J5o 85s 94s Q2o 96o 54s 86o 74s J4o 64s 76o T5o 93s 84s J3o 92s J2o T4o 53s 73s 95o 83s 85o T3o 63s 82s 75o 65o T2o 43s 94o 52s 54o 62s 93o 84o 42s 74o 64o 72s 92o 32s 53o 73o 83o 63o 82o 43o 62o 52o 72o 42o 32o'.split(' ');

  function classOf(c1, c2) {
    let r1 = c1 >> 2, r2 = c2 >> 2;
    if (r1 < r2) { const t = r1; r1 = r2; r2 = t; }
    if (r1 === r2) return RANKS[r1] + RANKS[r2];
    return RANKS[r1] + RANKS[r2] + ((c1 & 3) === (c2 & 3) ? 's' : 'o');
  }
  const classCombos = (name) => (name.length === 2 ? 6 : name[2] === 's' ? 4 : 12);

  const COMBOS = []; // [c1, c2]
  const COMBO_CLASS = [];
  for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) { COMBOS.push([a, b]); COMBO_CLASS.push(classOf(a, b)); }
  const NCOMBOS = COMBOS.length; // 1326

  const CLASS_START = {}, CLASS_END = {};
  (function () {
    let acc = 0;
    for (const name of CLASS_ORDER) {
      CLASS_START[name] = acc / NCOMBOS;
      acc += classCombos(name);
      CLASS_END[name] = acc / NCOMBOS;
    }
  })();

  /** Pesos 0..1 de cada combo según una banda de percentiles [lo, hi] del ranking. */
  function bandWeights(lo, hi) {
    const w = new Float64Array(NCOMBOS);
    for (let i = 0; i < NCOMBOS; i++) {
      const s = CLASS_START[COMBO_CLASS[i]], e = CLASS_END[COMBO_CLASS[i]];
      const ov = Math.min(e, hi) - Math.max(s, lo);
      w[i] = ov > 0 ? ov / (e - s) : 0;
    }
    return w;
  }

  /* ---------- Posiciones ---------- */
  const POSITIONS = {
    2: ['BTN', 'BB'],
    3: ['BTN', 'SB', 'BB'],
    4: ['CO', 'BTN', 'SB', 'BB'],
    5: ['HJ', 'CO', 'BTN', 'SB', 'BB'],
    6: ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'],
    7: ['UTG', 'MP', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
    8: ['UTG', 'UTG+1', 'MP', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
    9: ['UTG', 'UTG+1', 'UTG+2', 'MP', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
  };
  function playersBehind(pos, players) {
    const list = POSITIONS[players];
    return list.length - 1 - list.indexOf(pos);
  }
  function posted(pos, players) {
    if (pos === 'BB') return 1;
    if (pos === 'SB' || (players === 2 && pos === 'BTN')) return 0.5;
    return 0;
  }
  // % de manos para abrir según jugadores que quedan por hablar.
  const RFI = [0, 0.40, 0.44, 0.27, 0.21, 0.17, 0.15, 0.13, 0.115];
  const PUSH10 = [0, 0.60, 0.42, 0.30, 0.24, 0.19, 0.16, 0.14, 0.12];
  function rfiPct(pos, players) {
    if (players === 2) return pos === 'BTN' ? 0.80 : 0;
    return RFI[Math.min(8, playersBehind(pos, players))] || 0;
  }
  function pushPct(pos, players, stack) {
    const base = players === 2 ? 0.85 : PUSH10[Math.min(8, playersBehind(pos, players))] || 0;
    return Math.min(1, base * Math.pow(10 / Math.max(stack, 1), 0.8));
  }

  /* ---------- Lectura de la mano sobre el board ---------- */
  function classify(h1, h2, board) {
    const nb = board.length;
    const all = [h1, h2].concat(board);
    const score = evaluate(all, nb + 2), cat = score >> 20;
    const bscore = evaluate(board, nb), bcat = bscore >> 20;
    const r1 = h1 >> 2, r2 = h2 >> 2;
    let bmask = 0;
    for (let i = 0; i < nb; i++) bmask |= 1 << (board[i] >> 2);
    const bRanks = [];
    for (let r = 12; r >= 0; r--) if (bmask & (1 << r)) bRanks.push(r);

    let tier = 0, label = '';
    const pairTier = () => {
      let pr, kick, pocket = false;
      if (r1 === r2 && !(bmask & (1 << r1))) { pr = r1; pocket = true; }
      else {
        const m1 = !!(bmask & (1 << r1)), m2 = !!(bmask & (1 << r2));
        if (m1 && (!m2 || r1 >= r2)) { pr = r1; kick = r2; } else if (m2) { pr = r2; kick = r1; }
        else return [0, 'Nada'];
      }
      if (pocket) {
        if (pr > bRanks[0]) return [4, 'Pareja en mano más alta que la mesa'];
        if (pr > (bRanks[1] ?? -1)) return [3, 'Pareja mediana'];
        return [2, 'Pareja baja'];
      }
      if (pr === bRanks[0]) return kick >= 8 ? [4, 'Pareja con la carta más alta de la mesa'] : [3, 'Pareja con la carta más alta (acompañante bajo)'];
      if (pr === bRanks[1]) return [2, 'Segunda pareja'];
      return [2, 'Pareja baja'];
    };

    if (cat >= 4) { tier = score > bscore ? 5 : 0; label = tier ? CAT_ES[cat] : 'La jugada está en la mesa, no en tus cartas'; }
    else if (cat === 3) { if (bcat === 3) { tier = 0; label = 'El trío está en la mesa'; } else { tier = 5; label = 'Trío'; } }
    else if (cat === 2) {
      if (bcat === 0) { tier = 5; label = 'Doble pareja'; }
      else if (bcat === 2) { tier = 0; label = 'Las dos parejas están en la mesa'; }
      else [tier, label] = pairTier();
    } else if (cat === 1) {
      if (bcat === 1) { tier = 0; label = 'La pareja está en la mesa'; } else [tier, label] = pairTier();
    } else label = 'Carta alta';

    let fd = false, oesd = false, gut = false, outs = 0;
    if (nb < 5 && cat < 4) {
      let fdSuit = -1;
      for (let s = 0; s < 4; s++) {
        let cnt = 0;
        for (const c of all) if ((c & 3) === s) cnt++;
        if (cnt === 4 && ((h1 & 3) === s || (h2 & 3) === s)) { fd = true; fdSuit = s; }
      }
      const amask = bmask | (1 << r1) | (1 << r2);
      let sr = 0, sRanks = [];
      for (let x = 0; x < 13; x++) {
        if (amask & (1 << x)) continue;
        if (straightHigh(amask | (1 << x)) >= 0 && straightHigh(bmask | (1 << x)) < 0) { sr++; sRanks.push(x); }
      }
      oesd = sr >= 2; gut = sr === 1;
      outs = (fd ? 9 : 0) + sr * 4 - (fd ? sRanks.length : 0);
    }
    if (tier === 0 && (fd || oesd)) tier = 1;
    return { score, cat, tier, label, fd, oesd, gut, outs };
  }

  /* ---------- Rangos de los rivales ---------- */
  const TYPE_MULT = { tight: 0.7, normal: 1, loose: 1.45, maniac: 2 };
  const BLUFF_MULT = { tight: 0.6, normal: 1, loose: 1.3, maniac: 1.9 };

  function villainBand(action, type, stack, players) {
    const short = players && players <= 3; // mesas de 3 (p. ej. Expresso): rangos mucho más amplios
    const m = TYPE_MULT[type] || 1;
    const c = (lo, hi) => [lo, Math.min(1, hi * m)];
    switch (action) {
      case 'limp': return c(0.05, 0.45);
      case 'raise': return c(0, short ? 0.40 : 0.18);
      case '3bet': return c(0, 0.07);
      case '4bet': return c(0, 0.03);
      case 'allin': return c(0, short ? Math.min(0.75, Math.max(0.08, 4 / Math.max(stack, 1))) : Math.min(0.6, Math.max(0.025, 2.2 / Math.max(stack, 1))));
      case 'caller': return c(0.03, 0.30);
      default: return c(0.03, 0.32); // pagó tu subida
    }
  }

  // Probabilidad de que una mano de cada nivel tome esa acción.
  // niveles: 0 nada, 1 proyecto, 2 pareja débil, 3 media, 4 fuerte, 5 monstruo
  const ACCEPT = {
    check:     [1.00, 1.00, 1.00, 0.90, 0.55, 0.35],
    bet_small: [0.35, 0.75, 0.60, 0.85, 1.00, 1.00],
    bet_big:   [0.22, 0.60, 0.25, 0.60, 0.95, 1.00],
    raise:     [0.10, 0.45, 0.08, 0.25, 0.70, 1.00],
    allin:     [0.06, 0.35, 0.03, 0.12, 0.50, 1.00],
    call:      [0.12, 0.90, 0.60, 0.95, 0.90, 0.60],
  };
  function acceptance(action, info, type, river) {
    const t = ACCEPT[action];
    if (!t) return 1;
    let a = t[info.tier];
    const d = info.fd || info.oesd ? t[1] : info.gut ? t[1] * 0.5 : 0;
    if (d > a) a = d;
    if (action !== 'check' && info.tier <= 1) a = Math.min(1, a * (BLUFF_MULT[type] || 1) * (river && action !== 'call' ? 0.55 : 1));
    return a;
  }

  /**
   * Construye los pesos del rango de un rival.
   * spec: { band:[lo,hi], streets:[{action, board:[...]}], type }
   */
  function buildRange(spec, dead) {
    const w = bandWeights(spec.band[0], spec.band[1]);
    for (let i = 0; i < NCOMBOS; i++) {
      if (!w[i]) continue;
      const [a, b] = COMBOS[i];
      if (dead[a] || dead[b]) { w[i] = 0; continue; }
      for (const st of spec.streets) {
        if (!ACCEPT[st.action]) continue;
        w[i] *= acceptance(st.action, classify(a, b, st.board), spec.type, st.board.length === 5);
        if (!w[i]) break;
      }
    }
    return w;
  }

  /** Reparto del rango por niveles de fuerza sobre el board actual. */
  function rangeBreakdown(w, board) {
    const out = [0, 0, 0, 0, 0, 0];
    let tot = 0;
    for (let i = 0; i < NCOMBOS; i++) {
      if (!w[i]) continue;
      const t = board.length >= 3 ? classify(COMBOS[i][0], COMBOS[i][1], board).tier : 0;
      out[t] += w[i]; tot += w[i];
    }
    return tot ? out.map((x) => x / tot) : out;
  }

  /* ---------- Monte Carlo ---------- */
  function equity(hero, board, ranges, opts) {
    opts = opts || {};
    const maxIters = opts.iters || 20000, budget = opts.timeMs || 180;
    const dead = new Uint8Array(52);
    for (const c of hero) dead[c] = 1;
    for (const c of board) dead[c] = 1;
    const live = [];
    for (let c = 0; c < 52; c++) if (!dead[c]) live.push(c);

    const cums = ranges.map((w) => {
      const cum = new Float64Array(NCOMBOS);
      let s = 0;
      for (let i = 0; i < NCOMBOS; i++) { s += w[i]; cum[i] = s; }
      return { cum, total: s };
    });
    const pick = (cum, total) => {
      const x = Math.random() * total;
      let lo = 0, hi = NCOMBOS - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] > x) hi = mid; else lo = mid + 1; }
      return lo;
    };

    const used = new Int32Array(52);
    const nv = ranges.length, nb = board.length;
    const hand = new Array(7), vcards = new Array(nv * 2);
    const full = board.slice(); while (full.length < 5) full.push(0);
    let stamp = 0, eqSum = 0, wins = 0, ties = 0, it = 0;
    const t0 = Date.now();

    const randomLive = () => {
      for (let k = 0; k < 200; k++) { const c = live[(Math.random() * live.length) | 0]; if (used[c] !== stamp) return c; }
      for (const c of live) if (used[c] !== stamp) return c;
      return -1;
    };

    while (it < maxIters) {
      if ((it & 255) === 0 && it > 0 && Date.now() - t0 > budget) break;
      stamp++;
      for (let v = 0; v < nv; v++) {
        let ok = false;
        const { cum, total } = cums[v];
        if (total > 0) for (let tries = 0; tries < 40; tries++) {
          const [a, b] = COMBOS[pick(cum, total)];
          if (used[a] === stamp || used[b] === stamp) continue;
          used[a] = used[b] = stamp; vcards[v * 2] = a; vcards[v * 2 + 1] = b; ok = true; break;
        }
        if (!ok) {
          const a = randomLive(); used[a] = stamp;
          const b = randomLive(); used[b] = stamp;
          vcards[v * 2] = a; vcards[v * 2 + 1] = b;
        }
      }
      for (let i = nb; i < 5; i++) { const c = randomLive(); used[c] = stamp; full[i] = c; }
      for (let i = 0; i < 5; i++) hand[i] = full[i];
      hand[5] = hero[0]; hand[6] = hero[1];
      const hs = evaluate(hand, 7);
      let best = -1, nbest = 0;
      for (let v = 0; v < nv; v++) {
        hand[5] = vcards[v * 2]; hand[6] = vcards[v * 2 + 1];
        const s = evaluate(hand, 7);
        if (s > best) { best = s; nbest = 1; } else if (s === best) nbest++;
      }
      if (hs > best) { eqSum += 1; wins++; }
      else if (hs === best) { eqSum += 1 / (nbest + 1); ties++; }
      it++;
    }
    return { equity: it ? eqSum / it : 0, win: wins / it, tie: ties / it, iters: it };
  }

  /* ---------- Decisión (textos en lenguaje llano) ---------- */
  const BLUFF_3BET = new Set(['A5s', 'A4s', 'A3s', 'A2s', 'K9s', 'QTs', 'J9s', 'T9s', '98s', '87s', '76s', '65s']);
  const r05 = (x) => Math.max(0.5, Math.round(x * 2) / 2);
  const pct = (x) => Math.round(x * 100) + '%';
  let FMT = null; // formateador opcional (p. ej. convertir ciegas en fichas reales)
  const bb = (x) => { if (FMT) return FMT(x); const v = Math.round(x * 10) / 10; return v.toLocaleString('es-ES') + (v === 1 ? ' ciega' : ' ciegas'); };
  const POS_ES = {
    UTG: 'eres de los primeros en hablar', 'UTG+1': 'eres de los primeros en hablar', 'UTG+2': 'eres de los primeros en hablar',
    MP: 'estás en el medio de la mesa', HJ: 'estás en el medio de la mesa', CO: 'estás justo antes del botón',
    BTN: 'estás en el botón (hablas el último)', SB: 'estás en la ciega pequeña', BB: 'estás en la ciega grande',
  };
  const allin = (S) => `Ve con todo (${bb(S)})`;

  function boardTexture(board) {
    if (board.length < 3) return { wet: false, paired: false, label: '' };
    const sc = [0, 0, 0, 0];
    let mask = 0, paired = false;
    for (const c of board) { sc[c & 3]++; if (mask & (1 << (c >> 2))) paired = true; mask |= 1 << (c >> 2); }
    const maxSuit = Math.max(...sc);
    let conn = false;
    const m = (mask << 1) | ((mask >> 12) & 1);
    for (let lo = 0; lo <= 9; lo++) {
      let n = 0; for (let k = 0; k < 5; k++) if (m & (1 << (lo + k))) n++;
      if (n >= 3) conn = true;
    }
    const flushy = board.length === 3 ? maxSuit >= 2 : maxSuit >= 3;
    const wet = (flushy || conn) && !paired ? true : flushy && conn;
    let label;
    if (wet) label = 'La mesa es peligrosa: hay posibles colores o escaleras.';
    else if (paired) label = 'La mesa tiene una pareja.';
    else label = 'La mesa es tranquila: pocas jugadas peligrosas posibles.';
    return { wet, paired, flushy, conn, label };
  }

  function decide(ctx) {
    FMT = ctx.fmt || null;
    return ctx.board.length < 3 ? decidePreflop(ctx) : decidePostflop(ctx);
  }

  function decidePreflop(ctx) {
    const { pos, players, preAction, stack: S, toCall, pot, eq, heroClass, heroPct: p, ip, limpers } = ctx;
    const reasons = [], R = (t) => reasons.push(t);
    const required = toCall > 0 ? toCall / (pot + toCall) : 0;
    const pair = heroClass.length === 2, suited = heroClass[2] === 's';
    const gap = RANKS.indexOf(heroClass[0]) - RANKS.indexOf(heroClass[1]);
    const rfi = rfiPct(pos, players);
    const out = (action, amount, label, extra) => Object.assign({ action, amount, label, reasons, required }, extra || {});
    const where = POS_ES[pos] || '';

    R(`Tu mano está entre el ${Math.max(1, Math.round(p * 100))}% de mejores manos para empezar.`);

    if (preAction === 'none') {
      if (pos === 'BB') return out('CHECK', 0, 'Ganas las ciegas', { note: 'Si nadie ha entrado, todos se han retirado y el bote es tuyo.' });
      if (S <= 15) {
        const pp = pushPct(pos, players, S);
        R(`Te quedan pocas fichas (${bb(S)}): lo mejor es ir con todo o retirarse. Desde donde estás se va con todo con el ${pct(pp)} de mejores manos.`);
        return p <= pp ? out('ALLIN', S, allin(S)) : out('FOLD', 0, 'Retírate');
      }
      R(`Como ${where}, un buen jugador entra subiendo solo con el ${pct(rfi)} de mejores manos.`);
      if (p <= rfi) {
        const size = S <= 20 ? 2 : pos === 'SB' ? 3 : S <= 30 ? 2.2 : 2.5;
        const mix = p > rfi * 0.85 ? 'Mano justa: sube, pero si alguien vuelve a subir fuerte, retírate.' : null;
        return out('RAISE', size, `Sube a ${bb(size)}`, { mix });
      }
      if (pos === 'SB' && p <= 0.6 && S >= 30) return out('CALL', toCall, `Iguala la ciega (${bb(toCall)})`, { mix: 'También vale retirarse. Iguala solo si la ciega grande juega poco.' });
      R('Tu mano no es suficientemente buena para entrar desde aquí.');
      return out('FOLD', 0, 'Retírate');
    }

    if (preAction === 'limp') {
      const iso = rfi * 0.75 || 0.12;
      const who = limpers > 1 ? `${limpers} jugadores han entrado` : 'un jugador ha entrado';
      if (S <= 15) {
        const pp = pushPct(pos, players, S) * 0.8;
        R(`Te quedan pocas fichas (${bb(S)}): ve con todo o no juegues.`);
        if (p <= pp) return out('ALLIN', S, allin(S));
        return pos === 'BB' ? out('CHECK', 0, 'Pasa') : out('FOLD', 0, 'Retírate');
      }
      if (pos === 'BB') {
        if (p <= 0.12) { const sz = 4 + limpers; R(`${who[0].toUpperCase() + who.slice(1)} pagando lo mínimo. Con una mano tan buena, sube para que te paguen más.`); return out('RAISE', sz, `Sube a ${bb(sz)}`); }
        R('Ya has puesto la ciega grande: puedes ver las siguientes cartas sin pagar nada más.');
        return out('CHECK', 0, 'Pasa');
      }
      R(`${who[0].toUpperCase() + who.slice(1)} pagando solo lo mínimo, señal de manos flojas. Subir para jugar contra uno solo funciona con el ${pct(iso)} de mejores manos.`);
      if (p <= iso) { const sz = (ip ? 3 : 4) + limpers; return out('RAISE', sz, `Sube a ${bb(sz)}`); }
      if (p <= rfi * 1.3 + 0.05 && (pair || (suited && gap <= 2)) && S >= 40) {
        R('Tu mano puede convertirse en algo muy fuerte (trío, color o escalera). Entra pagando poco para verlo.');
        return out('CALL', toCall, `Paga ${bb(toCall)}`);
      }
      if (pos === 'SB' && p <= 0.5) return out('CALL', toCall, `Iguala la ciega (${bb(toCall)})`);
      return out('FOLD', 0, 'Retírate');
    }

    if (preAction === 'allin') {
      R(`Contra las manos con las que un jugador suele ir con todo, ganarías el ${pct(eq)} de las veces.`);
      R(`Para que pagar te salga a cuenta necesitas ganar al menos el ${pct(required)} de las veces.`);
      return eq >= required ? out('CALL', toCall, `Paga ${bb(toCall)} (vas con todo)`) : out('FOLD', 0, 'Retírate');
    }

    const heroIn = posted(pos, players);
    if (preAction === 'raise') {
      const Rsz = ctx.facing || (toCall + heroIn);
      if (S <= 18) {
        const rejam = Math.min(players <= 3 ? 0.5 : 0.35, 0.13 * (12 / S) * (players <= 3 ? 1.8 : 1));
        R(`Te quedan pocas fichas (${bb(S)}): o vas con todo o te retiras. Se va con todo con el ${pct(rejam)} de mejores manos.`);
        return p <= rejam ? out('ALLIN', S, allin(S)) : out('FOLD', 0, 'Retírate');
      }
      const value3 = ctx.type === 'tight' ? 0.025 : ctx.type === 'normal' ? 0.035 : 0.05;
      const real = ip ? 0.95 : pos === 'BB' ? 0.85 : 0.72;
      const implied = (pair || (suited && gap <= 2)) && S >= 50 ? 0.04 : 0;
      const callOk = eq * real + implied >= required;
      R(`Contra las manos con las que se suele subir, ganarías el ${pct(eq)} de las veces.`);
      if (!ip) R('Después tendrás que hablar antes que él, y eso es una desventaja.');
      if (p <= value3) {
        const to = r05(Rsz * (ip ? 3 : 4));
        R('Tienes de las mejores manos posibles: vuelve a subir para meter más dinero en el bote.');
        return to >= S * 0.4 ? out('ALLIN', S, allin(S)) : out('RAISE', to, `Vuelve a subir a ${bb(to)}`);
      }
      if (BLUFF_3BET.has(heroClass) && (ip || pos === 'SB' || pos === 'BB') && S >= 40) {
        const to = r05(Rsz * (ip ? 3 : 4));
        return out('RAISE', to, `Vuelve a subir a ${bb(to)}`, { mix: `Esto es un farol: hazlo más o menos 4 de cada 10 veces para no ser predecible. El resto de veces, ${callOk ? 'paga' : 'retírate'}.`, bluff: true });
      }
      if (callOk) {
        R(`Pagar te cuesta poco en comparación con lo que hay en el bote: solo necesitas ganar el ${pct(required)} de las veces.`);
        if (implied) R('Además, si ligas algo fuerte puedes ganar mucho más después.');
        return out('CALL', toCall, `Paga ${bb(toCall)}`);
      }
      R(`Para que pagar salga a cuenta necesitarías ganar el ${pct(required)} de las veces, y no llegas.`);
      return out('FOLD', 0, 'Retírate');
    }

    if (preAction === '3bet') {
      const v3 = ctx.facing || (toCall + 2.5);
      R(`Te han vuelto a subir. Contra las manos con las que se hace eso, ganarías el ${pct(eq)} de las veces.`);
      if (p <= 0.026) {
        const to = r05(v3 * 2.25);
        R('Tienes de las mejores manos posibles: sube otra vez.');
        return to >= S * 0.4 ? out('ALLIN', S, allin(S)) : out('RAISE', to, `Sube otra vez a ${bb(to)}`);
      }
      const real = ip ? 0.9 : 0.75;
      const setMine = pair && S >= 15 * toCall ? 0.06 : 0;
      const implied = suited && gap <= 1 && S >= 80 ? 0.03 : 0;
      if (eq * real + setMine + implied >= required) {
        if (setMine) R('Con una pareja y muchas fichas, pagas para intentar ligar un trío: si sale, puedes ganar un bote enorme.');
        return out('CALL', toCall, `Paga ${bb(toCall)}`);
      }
      R('Tu mano no es lo bastante buena para seguir ante tanta fuerza.');
      return out('FOLD', 0, 'Retírate');
    }

    if (preAction === '4bet') {
      R(`Te han subido por tercera vez: eso casi siempre son manos muy fuertes. Ganarías el ${pct(eq)} de las veces.`);
      if (p <= 0.018) return out('ALLIN', S, allin(S));
      if (p <= 0.045 && eq * 0.9 >= required) return out('CALL', toCall, `Paga ${bb(toCall)}`);
      return out('FOLD', 0, 'Retírate');
    }
    return out('FOLD', 0, 'Retírate');
  }

  function decidePostflop(ctx) {
    const { eq, info, pot, toCall, stack: S, opps: n, ip, aggressor, board, villainChecked, type } = ctx;
    const street = board.length === 3 ? 'flop' : board.length === 4 ? 'turn' : 'river';
    const reasons = [], R = (t) => reasons.push(t);
    const required = toCall > 0 ? toCall / (pot + toCall) : 0;
    const tex = boardTexture(board);
    const spr = S / Math.max(pot, 0.5);
    const vt = n === 1 ? 0.62 : Math.max(0.40, 1.75 / (n + 1));
    const strongDraw = street !== 'river' && (info.fd || info.oesd);
    const out = (action, amount, label, extra) => Object.assign({ action, amount, label, reasons, required, spr, texture: tex }, extra || {});
    const betSize = (frac) => { const a = r05(pot * frac); return a >= S * 0.7 ? S : a; };
    const frac = (f) => (f <= 0.35 ? 'un tercio del bote' : f <= 0.45 ? 'algo menos de la mitad del bote' : f <= 0.55 ? 'la mitad del bote' : 'dos tercios del bote');

    R(`Ganarías esta mano el ${pct(eq)} de las veces, teniendo en cuenta lo que ${n === 1 ? 'ha hecho tu rival' : `han hecho tus ${n} rivales`}.`);
    if (strongDraw) R(`Te falta una carta para ${info.fd ? 'hacer color' : 'hacer escalera'}: quedan ${info.outs} cartas en la baraja que te la dan.`);
    R(tex.label);

    if (toCall <= 0) {
      if (eq >= vt) {
        if (spr <= 1.5) { R('Te quedan pocas fichas comparado con el bote: métela todas ya.'); return out('ALLIN', S, allin(S)); }
        let f = tex.wet ? 0.66 : 0.4;
        if (street === 'river') f = eq >= 0.85 ? 0.75 : 0.5;
        if (street === 'turn' && eq >= 0.8) f = 0.75;
        const a = betSize(f);
        R(`Vas ganando: apuesta para que te paguen con manos peores${tex.wet ? ' y para que no vean gratis la carta que les podría ayudar' : ''}.`);
        const mix = street === 'flop' && eq >= 0.9 && !tex.wet && n === 1 ? 'Otra opción: pasar para hacerte el débil y que él apueste.' : null;
        return out(a >= S ? 'ALLIN' : 'BET', a, a >= S ? allin(S) : `Apuesta ${bb(a)}`, { mix: mix || `Es ${f >= 0.75 ? 'unas tres cuartas partes del bote' : frac(f)}.` });
      }
      if (strongDraw && n <= 2 && (ip || aggressor || n === 1)) {
        const a = betSize(0.6);
        R('Apostar aquí te da dos formas de ganar: que se retire ahora, o que te salga la carta que te falta.');
        return out('BET', a, `Apuesta ${bb(a)}`, { mix: 'Es un farol con posibilidades: aún no tienes nada, pero puedes ligar.' });
      }
      if (street === 'flop' && aggressor && n === 1 && !tex.wet) {
        const a = betSize(0.33);
        R('Fuiste tú quien subió antes del flop, así que el rival espera que tengas buena mano. En una mesa tranquila, una apuesta pequeña le hace retirarse muchas veces.');
        return out('BET', a, `Apuesta ${bb(a)}`, { mix: eq < 0.35 ? 'Si no tienes nada, hazlo unas 6 de cada 10 veces; las demás, pasa.' : 'Es un tercio del bote.', bluff: eq < 0.4 });
      }
      if (street === 'river' && n === 1 && ip && eq >= 0.55) {
        const a = betSize(0.35);
        R('Probablemente vas ganando: una apuesta pequeña hará que te pague con manos algo peores.');
        return out('BET', a, `Apuesta ${bb(a)}`);
      }
      if (street === 'river' && n === 1 && ip && villainChecked && eq < 0.2 && type !== 'loose' && type !== 'maniac') {
        const a = betSize(0.6);
        R('Si enseñáis las cartas, casi seguro pierdes. Pero tu rival ha pasado, lo que suele indicar que tampoco tiene mucho.');
        return out('CHECK', 0, 'Pasa', { mix: `Farol opcional: apuesta ${bb(a)} más o menos 1 de cada 3 veces.` });
      }
      R(eq >= 0.4 ? 'Tienes una mano regular: pasa para no hacer el bote demasiado grande.' : 'No tienes nada que valga la pena: no metas más fichas.');
      return out('CHECK', 0, 'Pasa');
    }

    // Toca pagar
    const implied = strongDraw && spr > 2 ? (street === 'flop' ? 0.05 : 0.04) : 0;
    const callEV = eq * (pot + toCall) - toCall;
    R(`Pagar te cuesta ${bb(toCall)} para optar a un bote de ${bb(pot + toCall)}: te sale a cuenta si ganas al menos el ${pct(required)} de las veces.`);
    R(callEV >= 0 ? `A la larga, pagar aquí te hace ganar unas ${bb(callEV)} de media cada vez.` : `A la larga, pagar aquí te hace perder unas ${bb(-callEV)} de media cada vez.`);
    const raiseT = (n === 1 ? 0.72 : Math.max(vt + 0.12, 0.5)) + (street === 'river' ? 0.13 : street === 'turn' ? 0.06 : 0);
    if (eq >= raiseT) {
      const to = r05(toCall * 3 + (pot - toCall) * 0.3);
      if (spr <= 2 || to >= S * 0.45) { R('Tu mano es muy fuerte y ya hay mucho en el bote: métela todo.'); return out('ALLIN', S, allin(S)); }
      R('Tu mano es muy fuerte: sube para ganar un bote más grande.');
      return out('RAISE', to, `Sube a ${bb(to)}`, { mix: street === 'river' ? null : 'Si tu rival apuesta mucho por su cuenta, también vale solo pagar y dejarle seguir apostando.' });
    }
    if (street === 'flop' && n === 1 && strongDraw && info.outs >= 12 && spr > 2) {
      const to = r05(toCall * 3 + (pot - toCall) * 0.3);
      R('Tienes muchísimas cartas que te ayudan: subir puede hacer que se retire, y si paga sigues teniendo muchas opciones de ligar.');
      return out(to >= S * 0.45 ? 'ALLIN' : 'RAISE', to >= S * 0.45 ? S : to, to >= S * 0.45 ? allin(S) : `Sube a ${bb(to)}`, { mix: 'Pagar también es una buena opción.' });
    }
    if (eq + implied >= required) {
      if (implied && eq < required) R('Ahora mismo el precio es algo caro, pero si te sale la carta que necesitas podrás ganar mucho más después.');
      if (spr <= 1 && eq >= required) return out('ALLIN', S, allin(S));
      return out('CALL', toCall, `Paga ${bb(toCall)}`);
    }
    R('Te piden demasiado para lo poco que ganas: retírate.');
    return out('FOLD', 0, 'Retírate');
  }

  return {
    RANKS, SUITS, SUIT_SYM, CAT_ES, COMBOS, CLASS_ORDER, CLASS_END,
    card, rankOf, suitOf, cardStr, parseCard, evaluate, classify, classOf,
    POSITIONS, playersBehind, posted, rfiPct, pushPct,
    villainBand, bandWeights, buildRange, rangeBreakdown, equity, boardTexture, decide,
  };
});
