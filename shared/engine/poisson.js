// Modelo de Poisson bivariante (independiente + corrección Dixon-Coles) para fútbol.
// Dos usos:
//  1) fitLambdas: ajusta λ local/visitante a las probabilidades sin margen del mercado
//     (1X2 + total principal). Permite valorar de forma coherente líneas asiáticas
//     de cuarto (±0.25, ±0.75), devoluciones, BTTS, etc.
//  2) teamRatings/predictLambdas: modelo estadístico independiente del mercado,
//     basado en resultados (y xG cuando existen) de football-data.co.uk.

const MAX_GOALS = 10;

function logFactorial(n) { let s = 0; for (let i = 2; i <= n; i++) s += Math.log(i); return s; }
export const poissonPmf = (k, lambda) => Math.exp(k * Math.log(lambda) - lambda - logFactorial(k));

function dcTau(x, y, lh, la, rho) {
  if (x === 0 && y === 0) return 1 - lh * la * rho;
  if (x === 0 && y === 1) return 1 + lh * rho;
  if (x === 1 && y === 0) return 1 + la * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

/** Matriz de probabilidades de marcador m[x][y]. */
export function scoreMatrix(lh, la, rho = -0.06, max = MAX_GOALS) {
  const ph = [], pa = [];
  for (let i = 0; i <= max; i++) { ph.push(poissonPmf(i, lh)); pa.push(poissonPmf(i, la)); }
  const m = [];
  let tot = 0;
  for (let x = 0; x <= max; x++) {
    m.push([]);
    for (let y = 0; y <= max; y++) {
      const v = Math.max(0, ph[x] * pa[y] * dcTau(x, y, lh, la, rho));
      m[x].push(v); tot += v;
    }
  }
  for (let x = 0; x <= max; x++) for (let y = 0; y <= max; y++) m[x][y] /= tot;
  return m;
}

export function matrix1X2(m) {
  let h = 0, d = 0, a = 0;
  m.forEach((row, x) => row.forEach((v, y) => { if (x > y) h += v; else if (x === y) d += v; else a += v; }));
  return { home: h, draw: d, away: a };
}

export function matrixBTTS(m) {
  let yes = 0;
  m.forEach((row, x) => row.forEach((v, y) => { if (x > 0 && y > 0) yes += v; }));
  return { yes, no: 1 - yes };
}

/** Distribución por suma de goles y por diferencia (local − visitante). */
export function matrixMarginals(m) {
  const totals = new Map(), diffs = new Map();
  m.forEach((row, x) => row.forEach((v, y) => {
    totals.set(x + y, (totals.get(x + y) || 0) + v);
    diffs.set(x - y, (diffs.get(x - y) || 0) + v);
  }));
  return { totals, diffs };
}

/** Liquidación por unidad para una línea simple (entera o .5): +1 gana, 0 devolución, −1 pierde. */
const settleSimple = (adj) => (adj > 1e-9 ? 1 : adj < -1e-9 ? -1 : 0);

/**
 * Retorno neto por unidad para un valor ajustado (margen + línea), admitiendo
 * líneas de cuarto (se divide el stake en dos mitades a líneas ±0.25).
 */
export function settleLine(value, line, price) {
  const isQuarter = Math.abs((Math.abs(line) * 4) % 2 - 1) < 1e-9; // x.25 / x.75
  const one = (l) => {
    const s = settleSimple(value + l);
    return s > 0 ? price - 1 : s < 0 ? -1 : 0;
  };
  if (isQuarter) return 0.5 * one(line - 0.25) + 0.5 * one(line + 0.25);
  return one(line);
}

function aggregate(entries) {
  const byR = new Map();
  for (const [r, p] of entries) {
    const k = Math.round(r * 1e6) / 1e6;
    byR.set(k, (byR.get(k) || 0) + p);
  }
  return [...byR.entries()].map(([r, p]) => ({ p, r, label: labelFor(r) }));
}
function labelFor(r) {
  if (r === -1) return 'pierde';
  if (r === -0.5) return 'media pérdida';
  if (r === 0) return 'devolución';
  return r > 0 ? 'gana / media ganancia' : 'pierde';
}

/** Distribución de resultados de un hándicap asiático. side: 'home' | 'away'; line = hándicap del local. */
export function ahDist(m, homeLine, side, price) {
  const { diffs } = matrixMarginals(m);
  const entries = [];
  for (const [d, p] of diffs) {
    const value = side === 'home' ? d : -d;
    const line = side === 'home' ? homeLine : -homeLine;
    entries.push([settleLine(value, line, price), p]);
  }
  return aggregate(entries);
}

/** Distribución de resultados de un total (más/menos). */
export function totalDist(m, line, side, price) {
  const { totals } = matrixMarginals(m);
  const entries = [];
  for (const [t, p] of totals) {
    // over: gana si t − line > 0 ; under: gana si line − t > 0
    const value = side === 'over' ? t : -t;
    const l = side === 'over' ? -line : line;
    entries.push([settleLine(value, l, price), p]);
  }
  return aggregate(entries);
}

export const probOver = (m, line) => {
  const { totals } = matrixMarginals(m);
  let over = 0, push = 0;
  for (const [t, p] of totals) { if (t > line + 1e-9) over += p; else if (Math.abs(t - line) < 1e-9) push += p; }
  return { over, push, under: 1 - over - push };
};

/** Nelder-Mead 2D minimalista. */
function nelderMead(f, x0, step = 0.3, iters = 300) {
  let simplex = [x0, [x0[0] + step, x0[1]], [x0[0], x0[1] + step]].map((x) => ({ x, v: f(x) }));
  for (let i = 0; i < iters; i++) {
    simplex.sort((a, b) => a.v - b.v);
    const [b, g, w] = simplex;
    const c = [(b.x[0] + g.x[0]) / 2, (b.x[1] + g.x[1]) / 2];
    const xr = [2 * c[0] - w.x[0], 2 * c[1] - w.x[1]]; const vr = f(xr);
    if (vr < b.v) {
      const xe = [3 * c[0] - 2 * w.x[0], 3 * c[1] - 2 * w.x[1]]; const ve = f(xe);
      simplex[2] = ve < vr ? { x: xe, v: ve } : { x: xr, v: vr };
    } else if (vr < g.v) simplex[2] = { x: xr, v: vr };
    else {
      const xc = [(c[0] + w.x[0]) / 2, (c[1] + w.x[1]) / 2]; const vc = f(xc);
      if (vc < w.v) simplex[2] = { x: xc, v: vc };
      else simplex = simplex.map((s, j) => (j === 0 ? s : { x: [(s.x[0] + b.x[0]) / 2, (s.x[1] + b.x[1]) / 2], v: f([(s.x[0] + b.x[0]) / 2, (s.x[1] + b.x[1]) / 2]) }));
    }
  }
  simplex.sort((a, b) => a.v - b.v);
  return simplex[0];
}

/**
 * Ajusta λ a probabilidades de mercado sin margen.
 * @param {{home,draw,away}} p1x2
 * @param {{line, over, under}|null} total  probabilidades condicionadas (sin devolución)
 */
export function fitLambdas(p1x2, total = null, rho = -0.06) {
  const f = ([a, b]) => {
    const lh = Math.exp(a), la = Math.exp(b);
    const m = scoreMatrix(lh, la, rho);
    const r = matrix1X2(m);
    let err = (r.home - p1x2.home) ** 2 + (r.draw - p1x2.draw) ** 2 + (r.away - p1x2.away) ** 2;
    if (total) {
      const t = probOver(m, total.line);
      const cond = t.over / (t.over + t.under);
      err += 1.5 * (cond - total.over) ** 2;
    }
    return err;
  };
  const best = nelderMead(f, [Math.log(1.4), Math.log(1.1)]);
  return { home: Math.exp(best.x[0]), away: Math.exp(best.x[1]), rmse: Math.sqrt(best.v / (total ? 4 : 3)) };
}

// ---------------------------------------------------------------------------
// Modelo estadístico independiente (fuerzas de ataque/defensa)
// ---------------------------------------------------------------------------

/**
 * @param {Array<{date:Date, home, away, hg, ag, hxg?, axg?}>} matches  partidos terminados
 * @param {{halfLifeDays?, prior?, xgWeight?, asOf?}} opts
 */
export function teamRatings(matches, opts = {}) {
  const halfLife = opts.halfLifeDays ?? 150;
  const prior = opts.prior ?? 4; // partidos ficticios en la media de la liga (regularización)
  const xgW = opts.xgWeight ?? 0.5;
  const asOf = opts.asOf ?? new Date();
  const metric = (g, xg) => (xg != null && Number.isFinite(xg) ? (1 - xgW) * g + xgW * xg : g);
  const valid = matches.filter((m) => m.date <= asOf);
  if (valid.length < 20) return null;
  const w = (d) => Math.pow(0.5, (asOf - d) / 86400000 / halfLife);
  let sw = 0, sh = 0, sa = 0;
  for (const m of valid) { const ww = w(m.date); sw += ww; sh += ww * metric(m.hg, m.hxg); sa += ww * metric(m.ag, m.axg); }
  const homeAvg = sh / sw, awayAvg = sa / sw;
  const acc = {};
  const team = (t) => (acc[t] ||= { att: 0, def: 0, w: 0, n: 0 });
  for (const m of valid) {
    const ww = w(m.date);
    const hgm = metric(m.hg, m.hxg), agm = metric(m.ag, m.axg);
    const H = team(m.home), A = team(m.away);
    H.att += ww * (hgm / homeAvg); H.def += ww * (agm / awayAvg); H.w += ww; H.n++;
    A.att += ww * (agm / awayAvg); A.def += ww * (hgm / homeAvg); A.w += ww; A.n++;
  }
  // Una pasada de ajuste por rival (corrige calendario) partiendo de las medias brutas.
  const raw = {};
  for (const [t, v] of Object.entries(acc)) raw[t] = { att: (v.att + prior) / (v.w + prior), def: (v.def + prior) / (v.w + prior), n: v.n };
  const adj = {};
  for (const t of Object.keys(acc)) adj[t] = { att: 0, def: 0, w: 0 };
  for (const m of valid) {
    const ww = w(m.date);
    const hgm = metric(m.hg, m.hxg), agm = metric(m.ag, m.axg);
    adj[m.home].att += ww * (hgm / (homeAvg * raw[m.away].def)); adj[m.home].def += ww * (agm / (awayAvg * raw[m.away].att)); adj[m.home].w += ww;
    adj[m.away].att += ww * (agm / (awayAvg * raw[m.home].def)); adj[m.away].def += ww * (hgm / (homeAvg * raw[m.home].att)); adj[m.away].w += ww;
  }
  const teams = {};
  for (const [t, v] of Object.entries(adj)) teams[t] = { att: (v.att + prior) / (v.w + prior), def: (v.def + prior) / (v.w + prior), n: raw[t].n };
  return { homeAvg, awayAvg, teams, matches: valid.length };
}

export function predictLambdas(ratings, home, away) {
  const H = ratings.teams[home], A = ratings.teams[away];
  if (!H || !A) return null;
  return { home: ratings.homeAvg * H.att * A.def, away: ratings.awayAvg * A.att * H.def, nHome: H.n, nAway: A.n };
}
