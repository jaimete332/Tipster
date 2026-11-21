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
        if (pr > bRanks[0]) return [4, 'Overpair'];
        if (pr > (bRanks[1] ?? -1)) return [3, 'Pareja intermedia'];
        return [2, 'Pareja baja'];
      }
      if (pr === bRanks[0]) return kick >= 8 ? [4, 'Top pair, buen kicker'] : [3, 'Top pair, kicker débil'];
      if (pr === bRanks[1]) return [2, 'Segunda pareja'];
      return [2, 'Pareja baja'];
    };

    if (cat >= 4) { tier = score > bscore ? 5 : 0; label = tier ? CAT_ES[cat] : 'Juegas el board'; }
    else if (cat === 3) { if (bcat === 3) { tier = 0; label = 'Trío en el board'; } else { tier = 5; label = r1 === r2 ? 'Set' : 'Trío'; } }
    else if (cat === 2) {
      if (bcat === 0) { tier = 5; label = 'Doble pareja'; }
      else if (bcat === 2) { tier = 0; label = 'Doble pareja en el board'; }
      else [tier, label] = pairTier();
    } else if (cat === 1) {
      if (bcat === 1) { tier = 0; label = 'Pareja en el board'; } else [tier, label] = pairTier();
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

  function villainBand(action, type, stack) {
    const m = TYPE_MULT[type] || 1;
    const c = (lo, hi) => [lo, Math.min(1, hi * m)];
    switch (action) {
      case 'limp': return c(0.05, 0.45);
      case 'raise': return c(0, 0.18);
      case '3bet': return c(0, 0.07);
      case '4bet': return c(0, 0.03);
      case 'allin': return c(0, Math.min(0.6, Math.max(0.025, 2.2 / Math.max(stack, 1))));
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

  /* ---------- Decisión ---------- */
  const BLUFF_3BET = new Set(['A5s', 'A4s', 'A3s', 'A2s', 'K9s', 'QTs', 'J9s', 'T9s', '98s', '87s', '76s', '65s']);
  const r05 = (x) => Math.max(0.5, Math.round(x * 2) / 2);
  const pct = (x) => Math.round(x * 100) + '%';
  const bb = (x) => (Math.round(x * 10) / 10).toLocaleString('es-ES') + ' bb';

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
    const parts = [];
    if (maxSuit >= 3) parts.push(board.length === 3 ? 'monocolor' : 'color posible');
    else if (maxSuit === 2 && board.length === 3) parts.push('dos del mismo palo');
    if (conn) parts.push('conectado');
    if (paired) parts.push('emparejado');
    return { wet, paired, flushy, conn, label: parts.length ? parts.join(', ') : 'seco' };
  }

  function decide(ctx) {
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

    R(`${heroClass} está en el top ${pct(p)} de manos iniciales.`);

    if (preAction === 'none') {
      if (pos === 'BB') return out('CHECK', 0, 'Te llevas las ciegas', { note: 'Si nadie ha entrado, todos se han retirado ante ti.' });
      if (S <= 15) {
        const pp = pushPct(pos, players, S);
        R(`Con ${bb(S)} se juega push/fold: desde ${pos} se va all-in con el top ${pct(pp)}.`);
        return p <= pp ? out('ALLIN', S, `All-in ${bb(S)}`) : out('FOLD', 0, 'Retírate');
      }
      R(`Desde ${pos} con ${playersBehind(pos, players)} jugadores detrás, un profesional abre el top ${pct(rfi)}.`);
      if (p <= rfi) {
        const size = pos === 'SB' ? 3 : S <= 30 ? 2.2 : 2.5;
        const mix = p > rfi * 0.85 ? 'Mano límite: ábrela, pero retírate ante una resubida fuerte.' : null;
        return out('RAISE', size, `Sube a ${bb(size)}`, { mix });
      }
      if (pos === 'SB' && p <= 0.6 && S >= 30) return out('CALL', toCall, `Completa (${bb(toCall)})`, { mix: 'Alternativa: retirarse. Completar solo contra una ciega grande pasiva.' });
      return out('FOLD', 0, 'Retírate');
    }

    if (preAction === 'limp') {
      const iso = rfi * 0.75 || 0.12;
      if (S <= 15) {
        const pp = pushPct(pos, players, S) * 0.8;
        if (p <= pp) return out('ALLIN', S, `All-in ${bb(S)}`);
        return pos === 'BB' ? out('CHECK', 0, 'Pasa') : out('FOLD', 0, 'Retírate');
      }
      if (pos === 'BB') {
        if (p <= 0.12) { const sz = 4 + limpers; R('Con una mano fuerte castiga a los limpers.'); return out('RAISE', sz, `Sube a ${bb(sz)}`); }
        return out('CHECK', 0, 'Pasa', { note: 'Ves el flop gratis.' });
      }
      R(`Contra ${limpers} limper${limpers > 1 ? 's' : ''} se aísla con el top ${pct(iso)}.`);
      if (p <= iso) { const sz = (ip ? 3 : 4) + limpers; return out('RAISE', sz, `Sube a ${bb(sz)} (aislar)`); }
      if (p <= rfi * 1.3 + 0.05 && (pair || (suited && gap <= 2)) && S >= 40) {
        R('Manos especulativas: entrar barato buscando set, color o escalera.');
        return out('CALL', toCall, `Paga ${bb(toCall)} (limp)`);
      }
      if (pos === 'SB' && p <= 0.5) return out('CALL', toCall, `Completa ${bb(toCall)}`);
      return out('FOLD', 0, 'Retírate');
    }

    if (preAction === 'allin') {
      R(`Equity contra un rango de all-in: ${pct(eq)}. Necesitas ${pct(required)}.`);
      return eq >= required ? out('CALL', toCall, `Paga el all-in (${bb(toCall)})`) : out('FOLD', 0, 'Retírate');
    }

    const heroIn = posted(pos, players);
    if (preAction === 'raise') {
      const Rsz = toCall + heroIn;
      if (S <= 18) {
        const rejam = Math.min(0.35, 0.13 * (12 / S));
        R(`Stack corto (${bb(S)}): resube all-in o retírate. Rango de resubida: top ${pct(rejam)}.`);
        return p <= rejam ? out('ALLIN', S, `All-in ${bb(S)}`) : out('FOLD', 0, 'Retírate');
      }
      const value3 = ctx.type === 'tight' ? 0.025 : ctx.type === 'normal' ? 0.035 : 0.05;
      const real = ip ? 0.95 : pos === 'BB' ? 0.85 : 0.72;
      const implied = (pair || (suited && gap <= 2)) && S >= 50 ? 0.04 : 0;
      const callOk = eq * real + implied >= required;
      R(`Equity contra su rango de subida: ${pct(eq)}. ${ip ? 'En posición' : 'Fuera de posición'} realizas ~${pct(real)} de ella.`);
      if (p <= value3) {
        const to = r05(Rsz * (ip ? 3 : 4));
        R('Mano premium: resube por valor (3-bet).');
        return to >= S * 0.4 ? out('ALLIN', S, `All-in ${bb(S)}`) : out('RAISE', to, `3-bet a ${bb(to)}`);
      }
      if (BLUFF_3BET.has(heroClass) && (ip || pos === 'SB' || pos === 'BB') && S >= 40) {
        const to = r05(Rsz * (ip ? 3 : 4));
        return out('RAISE', to, `3-bet a ${bb(to)}`, { mix: `Farol de 3-bet: hazlo ~40% de las veces; el resto ${callOk ? 'paga' : 'retírate'}.`, bluff: true });
      }
      if (callOk) {
        R(`Pagar necesita ${pct(required)} de equity; la realizada más las implied odds llegan.`);
        return out('CALL', toCall, `Paga ${bb(toCall)}`);
      }
      R(`No alcanzas el ${pct(required)} que exige el bote.`);
      return out('FOLD', 0, 'Retírate');
    }

    if (preAction === '3bet') {
      const v3 = toCall + 2.5;
      R(`Equity contra un rango de 3-bet: ${pct(eq)}.`);
      if (p <= 0.026) {
        const to = r05(v3 * 2.25);
        R('Top de rango: 4-bet por valor.');
        return to >= S * 0.4 ? out('ALLIN', S, `All-in ${bb(S)}`) : out('RAISE', to, `4-bet a ${bb(to)}`);
      }
      const real = ip ? 0.9 : 0.75;
      const setMine = pair && S >= 15 * toCall ? 0.06 : 0;
      const implied = suited && gap <= 1 && S >= 80 ? 0.03 : 0;
      if (eq * real + setMine + implied >= required) {
        if (setMine) R('Pareja con stacks profundos: pagas buscando el set (implied odds).');
        return out('CALL', toCall, `Paga ${bb(toCall)}`);
      }
      R(`Necesitas ${pct(required)}; tu equity realizada no llega.`);
      return out('FOLD', 0, 'Retírate');
    }

    if (preAction === '4bet') {
      R(`Equity contra un rango de 4-bet: ${pct(eq)}.`);
      if (p <= 0.018) return out('ALLIN', S, `All-in ${bb(S)}`);
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

    R(`Equity estimada: ${pct(eq)} contra ${n === 1 ? 'el rango del rival' : n + ' rivales'} según su acción.`);
    if (strongDraw) R(`Proyecto con ${info.outs} outs${info.fd ? ' (color)' : ''}${info.oesd ? ' (escalera abierta)' : ''}.`);
    R(`Board ${tex.label}. SPR ${spr.toFixed(1)}.`);

    if (toCall <= 0) {
      if (eq >= vt) {
        if (spr <= 1.5) { R('SPR muy bajo: mete todo, ya estás comprometido.'); return out('ALLIN', S, `All-in ${bb(S)}`); }
        let frac = tex.wet ? 0.66 : 0.4;
        if (street === 'river') frac = eq >= 0.85 ? 0.75 : 0.5;
        if (street === 'turn' && eq >= 0.8) frac = 0.75;
        const a = betSize(frac);
        R(`Vas por delante: apuesta por valor${tex.wet ? ' y cobra a los proyectos' : ''}.`);
        const mix = street === 'flop' && eq >= 0.9 && !tex.wet && n === 1 ? 'Opción: pasar para inducir (slowplay) en board seco.' : null;
        return out(a >= S ? 'ALLIN' : 'BET', a, a >= S ? `All-in ${bb(S)}` : `Apuesta ${bb(a)} (${Math.round(frac * 100)}% del bote)`, { mix });
      }
      if (strongDraw && n <= 2 && (ip || aggressor || n === 1)) {
        const a = betSize(0.6);
        R('Semifarol: ganas si se retira y tienes outs si paga.');
        return out('BET', a, `Apuesta ${bb(a)} (semifarol)`);
      }
      if (street === 'flop' && aggressor && n === 1 && !tex.wet) {
        const a = betSize(0.33);
        R('Fuiste el agresor preflop: en board seco la apuesta de continuación pequeña funciona muy a menudo.');
        return out('BET', a, `Apuesta ${bb(a)} (c-bet 33%)`, { mix: eq < 0.35 ? 'Con aire puro, c-bet ~60% de las veces; el resto pasa.' : null, bluff: eq < 0.4 });
      }
      if (street === 'river' && n === 1 && ip && eq >= 0.55) {
        const a = betSize(0.35);
        R('Valor fino en el river: los rivales pagan con manos peores.');
        return out('BET', a, `Apuesta ${bb(a)} (valor fino)`);
      }
      if (street === 'river' && n === 1 && ip && villainChecked && eq < 0.2 && type !== 'loose' && type !== 'maniac') {
        const a = betSize(0.6);
        R('Tu mano no gana en showdown; el rival mostró debilidad.');
        return out('CHECK', 0, 'Pasa', { mix: `Farol opcional: apuesta ${bb(a)} ~1 de cada 3 veces.` });
      }
      R(eq >= 0.4 ? 'Mano de valor medio: controla el bote.' : 'Sin valor ni proyecto suficiente: no metas dinero.');
      return out('CHECK', 0, 'Pasa');
    }

    // Toca pagar
    const implied = strongDraw && spr > 2 ? (street === 'flop' ? 0.05 : 0.04) : 0;
    const callEV = eq * (pot + toCall) - toCall;
    R(`Necesitas ${pct(required)} para pagar (pot odds ${((pot) / toCall).toFixed(1)}:1). EV inmediato de pagar: ${callEV >= 0 ? '+' : ''}${bb(callEV)}.`);
    const raiseT = (n === 1 ? 0.72 : Math.max(vt + 0.12, 0.5)) + (street === 'river' ? 0.13 : street === 'turn' ? 0.06 : 0);
    if (eq >= raiseT) {
      const to = r05(toCall * 3 + (pot - toCall) * 0.3);
      if (spr <= 2 || to >= S * 0.45) { R('Mano muy fuerte y stacks cortos respecto al bote: all-in.'); return out('ALLIN', S, `All-in ${bb(S)}`); }
      R('Mano muy fuerte: sube para construir el bote.');
      return out('RAISE', to, `Sube a ${bb(to)}`, { mix: street === 'river' ? null : 'Contra rivales muy agresivos también vale solo pagar.' });
    }
    if (street === 'flop' && n === 1 && strongDraw && info.outs >= 12 && spr > 2) {
      const to = r05(toCall * 3 + (pot - toCall) * 0.3);
      R('Proyecto enorme: subir como semifarol maximiza tu equity de retirada.');
      return out(to >= S * 0.45 ? 'ALLIN' : 'RAISE', to >= S * 0.45 ? S : to, to >= S * 0.45 ? `All-in ${bb(S)}` : `Sube a ${bb(to)} (semifarol)`, { mix: 'Pagar también es correcto.' });
    }
    if (eq + implied >= required) {
      if (implied && eq < required) R('Pagas por implied odds: si ligas tu proyecto cobrarás más adelante.');
      if (spr <= 1 && eq >= required) return out('ALLIN', S, `All-in ${bb(S)}`);
      return out('CALL', toCall, `Paga ${bb(toCall)}`);
    }
    R('El precio es demasiado alto para tu equity.');
    return out('FOLD', 0, 'Retírate');
  }

  return {
    RANKS, SUITS, SUIT_SYM, CAT_ES, COMBOS, CLASS_ORDER, CLASS_END,
    card, rankOf, suitOf, cardStr, parseCard, evaluate, classify, classOf,
    POSITIONS, playersBehind, posted, rfiPct, pushPct,
    villainBand, bandWeights, buildRange, rangeBreakdown, equity, boardTexture, decide,
  };
});
