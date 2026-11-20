// Ratings Elo para fútbol (contraste independiente del modelo de Poisson) y
// utilidades de distribución normal para márgenes de puntos (baloncesto).

export function eloRatings(matches, opts = {}) {
  const K = opts.k ?? 20;
  const HFA = opts.homeAdvantage ?? 60;
  const r = {};
  let draws = 0;
  const sorted = [...matches].sort((a, b) => a.date - b.date);
  for (const m of sorted) {
    const rh = r[m.home] ?? 1500, ra = r[m.away] ?? 1500;
    const exp = 1 / (1 + 10 ** ((ra - rh - HFA) / 400));
    const score = m.hg > m.ag ? 1 : m.hg === m.ag ? 0.5 : 0;
    if (m.hg === m.ag) draws++;
    const gd = Math.abs(m.hg - m.ag);
    const mult = gd <= 1 ? 1 : gd === 2 ? 1.5 : (11 + gd) / 8;
    const delta = K * mult * (score - exp);
    r[m.home] = rh + delta; r[m.away] = ra - delta;
  }
  return { ratings: r, homeAdvantage: HFA, drawRate: sorted.length ? draws / sorted.length : 0.26, n: sorted.length };
}

/** 1X2 aproximado a partir de Elo: E = pH + pD/2 con un modelo simple de empate. */
export function elo1X2(elo, home, away) {
  const rh = elo.ratings[home], ra = elo.ratings[away];
  if (rh == null || ra == null) return null;
  const dr = rh + elo.homeAdvantage - ra;
  const E = 1 / (1 + 10 ** (-dr / 400));
  const pD = Math.min(0.34, Math.max(0.12, elo.drawRate * 1.08 * Math.exp(-((dr / 600) ** 2))));
  let pH = E - pD / 2, pA = 1 - pH - pD;
  pH = Math.max(0.01, pH); pA = Math.max(0.01, pA);
  const s = pH + pD + pA;
  return { home: pH / s, draw: pD / s, away: pA / s, ratingHome: rh, ratingAway: ra };
}

// --- Normal -----------------------------------------------------------------
function erf(x) {
  // Abramowitz-Stegun 7.1.26 (error < 1.5e-7)
  const s = Math.sign(x); const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return s * y;
}
export const normCdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
export function normInv(p) {
  // Acklam
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) return -normInv(1 - p);
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Desviación típica aproximada del margen final por competición (puntos). */
export const MARGIN_SD = { basketball: 12 };
