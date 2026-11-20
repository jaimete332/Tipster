// Utilidades de cuotas: probabilidad implícita, margen (overround) y eliminación del margen.
// Módulo puro (sin dependencias) usado por servidor y navegador.

export const sum = (xs) => xs.reduce((a, b) => a + b, 0);
export const mean = (xs) => (xs.length ? sum(xs) / xs.length : NaN);
export function median(xs) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1));
}

export const isValidPrice = (p) => typeof p === 'number' && Number.isFinite(p) && p > 1.0001 && p < 1000;

/** Probabilidad implícita = 1 / cuota decimal. */
export const impliedProb = (price) => 1 / price;

/** Margen de la casa: Σ(1/cuota) − 1 sobre un mercado completo. */
export const overround = (prices) => sum(prices.map((p) => 1 / p)) - 1;

/** Normalización proporcional (método multiplicativo). */
export function devigMultiplicative(prices) {
  const inv = prices.map((p) => 1 / p);
  const s = sum(inv);
  return inv.map((x) => x / s);
}

/**
 * Método potencia: busca k tal que Σ(1/cuota)^k = 1. Corrige mejor el sesgo
 * favorito/sorpresa que el método multiplicativo.
 */
export function devigPower(prices) {
  const inv = prices.map((p) => 1 / p);
  const s0 = sum(inv);
  if (Math.abs(s0 - 1) < 1e-9) return inv;
  let lo = 0.2, hi = 5;
  for (let i = 0; i < 100; i++) {
    const k = (lo + hi) / 2;
    const s = sum(inv.map((x) => x ** k));
    if (s > 1) lo = k; else hi = k;
  }
  const k = (lo + hi) / 2;
  const out = inv.map((x) => x ** k);
  const s = sum(out);
  return out.map((x) => x / s);
}

/**
 * Método de Shin (modelo con apostantes informados). Resuelve z por bisección.
 */
export function devigShin(prices) {
  const inv = prices.map((p) => 1 / p);
  const S = sum(inv);
  if (S <= 1) return inv.map((x) => x / S);
  const probs = (z) => inv.map((q) => (Math.sqrt(z * z + 4 * (1 - z) * (q * q) / S) - z) / (2 * (1 - z)));
  let lo = 0, hi = 0.5;
  for (let i = 0; i < 100; i++) {
    const z = (lo + hi) / 2;
    const s = sum(probs(z));
    if (s > 1) lo = z; else hi = z;
  }
  const p = probs((lo + hi) / 2);
  const s = sum(p);
  return p.map((x) => x / s);
}

export function devig(prices, method = 'power') {
  if (method === 'multiplicative') return devigMultiplicative(prices);
  if (method === 'shin') return devigShin(prices);
  return devigPower(prices);
}

/** Valor esperado por unidad apostada en una apuesta binaria: p·cuota − 1. */
export const expectedValue = (p, price) => p * price - 1;

/** Valor esperado para una distribución de resultados [{p, r}] (r = retorno neto por unidad). */
export const expectedValueDist = (dist) => sum(dist.map((o) => o.p * o.r));

/** Distribución binaria (gana/pierde) para una cuota decimal. */
export const binaryDist = (p, price) => [
  { p, r: price - 1, label: 'gana' },
  { p: 1 - p, r: -1, label: 'pierde' },
];

/** Cuota justa de una distribución: la cuota con EV = 0. */
export function fairPriceFromDist(distFn) {
  // distFn(price) -> dist; EV es creciente en la cuota.
  let lo = 1.0001, hi = 1000;
  for (let i = 0; i < 200; i++) {
    const mid = Math.sqrt(lo * hi);
    if (expectedValueDist(distFn(mid)) > 0) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

/** Clasificación orientativa del EV (no garantiza rentabilidad). */
export function classifyEV(ev) {
  if (!(ev >= 0.02)) return { key: 'descartar', label: 'Descartar', order: 0 };
  if (ev < 0.05) return { key: 'bajo', label: 'Valor bajo', order: 1 };
  if (ev < 0.08) return { key: 'interesante', label: 'Valor interesante', order: 2 };
  if (ev < 0.12) return { key: 'alto', label: 'Valor alto', order: 3 };
  return { key: 'excepcional', label: 'Excepcional (verificar)', order: 4 };
}
