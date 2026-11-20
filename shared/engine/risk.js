// Gestión del riesgo de cartera: límites por apuesta, por evento (apuestas correlacionadas)
// y exposición total simultánea, incluyendo las apuestas ya registradas como pendientes.

import { computeStake, roundStake, payoff } from './kelly.js';

/**
 * Estado del bankroll a partir de movimientos y apuestas registradas.
 * Sólo las apuestas reales (no simuladas) afectan al bank.
 */
export function bankrollState(bankroll, bets) {
  const initial = Number(bankroll.initial) || 0;
  const txs = bankroll.transactions || [];
  const deposits = txs.filter((t) => t.type === 'deposit').reduce((a, t) => a + t.amount, 0);
  const withdrawals = txs.filter((t) => t.type === 'withdraw').reduce((a, t) => a + t.amount, 0);
  const adjustments = txs.filter((t) => t.type === 'adjust').reduce((a, t) => a + t.amount, 0);
  const real = bets.filter((b) => b.kind === 'real');
  const settledPL = real.reduce((a, b) => a + betPL(b), 0);
  const committed = real.filter((b) => b.result === 'pendiente').reduce((a, b) => a + b.stake, 0);
  const total = initial + deposits - withdrawals + adjustments + settledPL;
  const invested = initial + deposits - withdrawals + adjustments;
  return {
    initial, deposits, withdrawals, adjustments, settledPL, committed,
    total: round2(total), available: round2(total - committed), invested: round2(invested),
    returnPct: invested > 0 ? settledPL / invested : 0,
  };
}

export function betPL(b) {
  switch (b.result) {
    case 'ganada': return round2(b.stake * (b.odds - 1));
    case 'media_ganada': return round2((b.stake * (b.odds - 1)) / 2);
    case 'perdida': return -b.stake;
    case 'media_perdida': return round2(-b.stake / 2);
    default: return 0; // pendiente / anulada
  }
}

export const round2 = (x) => Math.round(x * 100) / 100;

/**
 * Asigna stakes a una lista de oportunidades respetando:
 *  - límite por apuesta (computeStake),
 *  - límite por evento (riesgo conjunto de mercados del mismo partido),
 *  - exposición total máxima (contando apuestas pendientes ya realizadas).
 * El Kelly se calcula sobre el bankroll disponible (no el inicial).
 */
export function allocate(opps, settings, bank, pendingBets = []) {
  const bankroll = Math.max(0, bank.available);
  const s = {
    bankroll,
    kellyFraction: settings.kellyFraction,
    maxStakePct: settings.maxStakePct,
    strategy: settings.strategy || 'kelly',
    flatStakePct: settings.flatStakePct ?? 1,
  };
  const maxExposure = (bank.total * settings.maxExposurePct) / 100;
  const maxEvent = (bank.total * (settings.maxEventPct ?? settings.maxStakePct)) / 100;
  let exposure = pendingBets.reduce((a, b) => a + b.stake, 0);
  const eventExposure = {};
  for (const b of pendingBets) if (b.eventId) eventExposure[b.eventId] = (eventExposure[b.eventId] || 0) + b.stake;

  // Prioriza las oportunidades más robustas (EV conservador) al repartir el presupuesto de riesgo.
  const order = [...opps].sort((a, b) => b.evConservative - a.evConservative);
  const result = new Map();
  for (const o of order) {
    const base = computeStake(o, s);
    let stake = base.stake;
    const reasons = [...base.reasons];
    const steps = [...base.steps];
    const evUsed = eventExposure[o.eventId] || 0;
    const sameEvent = opps.filter((x) => x.eventId === o.eventId).length;
    if (stake > 0 && evUsed + stake > maxEvent) {
      stake = roundStake(Math.max(0, maxEvent - evUsed));
      reasons.push(`Riesgo conjunto del evento (${sameEvent} oportunidades/apuestas en el mismo partido, límite ${settings.maxEventPct ?? settings.maxStakePct}%)`);
    }
    if (stake > 0 && exposure + stake > maxExposure) {
      stake = roundStake(Math.max(0, maxExposure - exposure));
      reasons.push(`Exposición simultánea máxima (${settings.maxExposurePct}%) alcanzada`);
    }
    if (stake > 0 && o.liquidity != null && stake > o.liquidity) {
      stake = roundStake(o.liquidity);
      reasons.push(`Limitado a la liquidez disponible en el exchange (${o.liquidity.toFixed(0)} €)`);
    }
    if (stake < (settings.minStake ?? 0)) {
      if (stake > 0) reasons.push(`Por debajo del stake mínimo (${settings.minStake} €)`);
      stake = 0;
    }
    if (stake !== base.stake) steps.push({ k: 'Tras límites de cartera', v: bankroll > 0 ? stake / bankroll : 0, fmt: 'pct' });
    exposure += stake;
    eventExposure[o.eventId] = evUsed + stake;
    result.set(o.id, {
      ...base, stake, stakePct: bankroll > 0 ? stake / bankroll : 0, reasons, steps,
      bankroll, ...payoff(stake, o.price), correlatedCount: sameEvent,
    });
  }
  return result;
}
