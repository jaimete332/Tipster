// Estadísticas de rendimiento: aciertos, beneficio, ROI, yield, EV medio, CLV y desgloses.

import { betPL } from './risk.js';

export const PERIODS = [
  { key: '7', label: 'Últimos 7 días', days: 7 },
  { key: '30', label: 'Últimos 30 días', days: 30 },
  { key: '90', label: 'Últimos 90 días', days: 90 },
  { key: 'all', label: 'Histórico completo', days: null },
];

export function filterPeriod(items, days, field = 'createdAt', now = Date.now()) {
  if (!days) return items;
  const from = now - days * 86400000;
  return items.filter((x) => new Date(x[field]).getTime() >= from);
}

export function clv(b) {
  if (!(b.closingOdds > 1)) return null;
  return b.odds / b.closingOdds - 1;
}

export function summarize(bets, invested = null) {
  const settled = bets.filter((b) => !['pendiente', 'anulada'].includes(b.result));
  const wins = settled.filter((b) => b.result === 'ganada' || b.result === 'media_ganada').length;
  const staked = settled.reduce((a, b) => a + b.stake, 0);
  const pl = settled.reduce((a, b) => a + betPL(b), 0);
  const evs = bets.filter((b) => Number.isFinite(b.evAtBet)).map((b) => b.evAtBet);
  const clvs = bets.map(clv).filter((x) => x != null);
  const expected = settled.filter((b) => Number.isFinite(b.evAtBet)).reduce((a, b) => a + b.evAtBet * b.stake, 0);
  return {
    n: bets.length, settled: settled.length, pending: bets.filter((b) => b.result === 'pendiente').length,
    wins, hitRate: settled.length ? wins / settled.length : null,
    staked, pl, yield: staked > 0 ? pl / staked : null,
    roi: invested ? pl / invested : (staked > 0 ? pl / staked : null),
    avgStake: bets.length ? bets.reduce((a, b) => a + b.stake, 0) / bets.length : 0,
    avgOdds: bets.length ? bets.reduce((a, b) => a + b.odds, 0) / bets.length : 0,
    avgEV: evs.length ? evs.reduce((a, b) => a + b, 0) / evs.length : null,
    expectedPL: expected,
    avgCLV: clvs.length ? clvs.reduce((a, b) => a + b, 0) / clvs.length : null, clvN: clvs.length,
    clvPositive: clvs.length ? clvs.filter((x) => x > 0).length / clvs.length : null,
  };
}

export function groupBy(bets, keyFn) {
  const g = {};
  for (const b of bets) (g[keyFn(b)] ||= []).push(b);
  return Object.entries(g).map(([k, v]) => ({ key: k, ...summarize(v) })).sort((a, b) => b.n - a.n);
}

/** Curva del bankroll: movimientos + apuestas reales liquidadas en orden cronológico. */
export function bankrollCurve(bankroll, bets) {
  const pts = [];
  const events = [];
  for (const t of bankroll.transactions || []) events.push({ at: t.date, delta: t.type === 'withdraw' ? -t.amount : t.amount, label: t.type });
  for (const b of bets.filter((x) => x.kind === 'real' && !['pendiente', 'anulada'].includes(x.result))) events.push({ at: b.settledAt || b.createdAt, delta: betPL(b), label: b.selection });
  events.sort((a, b) => new Date(a.at) - new Date(b.at));
  let v = Number(bankroll.initial) || 0;
  pts.push({ at: bankroll.startedAt || (events[0]?.at ?? new Date().toISOString()), v });
  for (const e of events) { v += e.delta; pts.push({ at: e.at, v: Math.round(v * 100) / 100, label: e.label }); }
  return pts;
}

/** Evaluación de las oportunidades detectadas (aunque no se apostaran) mediante CLV. */
export function opportunityCLV(log) {
  const withClose = log.filter((o) => o.closingFairOdds > 1);
  const vals = withClose.map((o) => o.price / o.closingFairOdds - 1);
  return {
    n: log.length, measured: vals.length,
    avgCLV: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null,
    beatClose: vals.length ? vals.filter((x) => x > 0).length / vals.length : null,
  };
}
