// Criterio de Kelly.
// - kellyBinary: fórmula cerrada f = (p·cuota − 1) / (cuota − 1).
// - kellyDist: maximiza E[ln(1 + f·r)] para distribuciones con devolución,
//   medias ganancias/pérdidas (hándicap asiático, DNB, líneas enteras...).

import { expectedValueDist } from './odds.js';

export const KELLY_FRACTIONS = [
  { key: 'full', label: 'Kelly completo', value: 1 },
  { key: 'half', label: 'Medio Kelly', value: 0.5 },
  { key: 'quarter', label: 'Cuarto de Kelly', value: 0.25 },
  { key: 'eighth', label: 'Octavo de Kelly', value: 0.125 },
];

export function kellyBinary(p, price) {
  if (!(price > 1) || !(p > 0)) return 0;
  const f = (p * price - 1) / (price - 1);
  return f > 0 ? f : 0;
}

/**
 * Kelly general. dist = [{p, r}] con Σp = 1 y r = retorno neto por unidad
 * (gana: cuota−1, media ganancia: (cuota−1)/2, devolución: 0, media pérdida: −0.5, pierde: −1).
 * g'(f) = Σ p·r/(1+f·r) es decreciente; se busca su raíz por bisección.
 */
export function kellyDist(dist) {
  const d = dist.filter((o) => o.p > 0);
  if (expectedValueDist(d) <= 0) return 0;
  const worst = Math.min(...d.map((o) => o.r));
  const fMax = worst < 0 ? Math.min(1, (1 / -worst) * 0.999999) : 1;
  const g1 = (f) => d.reduce((a, o) => a + (o.p * o.r) / (1 + f * o.r), 0);
  if (g1(fMax) > 0) return fMax;
  let lo = 0, hi = fMax;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (g1(mid) > 0) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Tasa de crecimiento logarítmico esperada al apostar la fracción f. */
export function growthRate(dist, f) {
  return dist.reduce((a, o) => a + (o.p > 0 ? o.p * Math.log(1 + f * o.r) : 0), 0);
}

export const CONFIDENCE_MULTIPLIER = { alta: 1, media: 0.6, baja: 0.3 };

/**
 * Stake recomendado para una oportunidad aislada.
 * @param {object} o  { dist, price, confidence, evConservative, exceptional }
 * @param {object} s  { bankroll, kellyFraction, maxStakePct }
 */
export function computeStake(o, s) {
  const steps = [];
  const fullKelly = kellyDist(o.dist);
  steps.push({ k: 'Kelly completo', v: fullKelly, fmt: 'pct' });
  const fractional = fullKelly * s.kellyFraction;
  steps.push({ k: `Kelly × ${s.kellyFraction}`, v: fractional, fmt: 'pct' });
  const confMult = CONFIDENCE_MULTIPLIER[o.confidence] ?? 0.3;
  let f = fractional * confMult;
  if (s.strategy === 'flat') {
    // Stake plano: % fijo del bank sólo cuando Kelly confirma valor positivo.
    f = fullKelly > 0 ? (s.flatStakePct / 100) * confMult : 0;
    steps.push({ k: `Estrategia plana ${s.flatStakePct}% (Kelly sólo como filtro)`, v: f, fmt: 'pct' });
  }
  if (confMult !== 1 && s.strategy !== 'flat') steps.push({ k: `Ajuste por confianza ${o.confidence} (× ${confMult})`, v: f, fmt: 'pct' });
  const cap = s.maxStakePct / 100;
  const reasons = [];
  if (o.exceptional) {
    const exCap = cap / 2;
    if (f > exCap) { f = exCap; reasons.push('EV excepcional: límite reducido a la mitad hasta verificar manualmente'); }
  }
  if (f > cap) { f = cap; reasons.push(`Límite máximo por apuesta (${s.maxStakePct}%)`); }
  if (!(o.evConservative > 0)) { f = 0; reasons.push('EV conservador ≤ 0: la ventaja no es robusta frente a la incertidumbre'); }
  if (fullKelly <= 0) { f = 0; reasons.push('Kelly ≤ 0: sin valor esperado positivo'); }
  steps.push({ k: 'Fracción aplicada', v: f, fmt: 'pct' });
  const bank = Math.max(0, s.bankroll);
  const stake = roundStake(bank * f);
  return { fullKelly, fractional, confMult, fraction: f, stake, stakePct: bank > 0 ? stake / bank : 0, reasons, steps };
}

export const roundStake = (x) => (x >= 1 ? Math.floor(x * 2) / 2 : Math.floor(x * 100) / 100);

/** Beneficio neto si gana y pérdida si pierde (casos extremos de la distribución). */
export function payoff(stake, price) {
  return { profit: +(stake * (price - 1)).toFixed(2), loss: +stake.toFixed(2) };
}
