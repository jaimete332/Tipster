// Pruebas del motor. Los datos de estas pruebas son sintéticos y sólo existen aquí:
// la aplicación nunca usa datos inventados en tiempo de ejecución.
import test from 'node:test';
import assert from 'node:assert/strict';
import { devigPower, devigMultiplicative, devigShin, overround, expectedValue, classifyEV, fairPriceFromDist } from '../shared/engine/odds.js';
import { kellyBinary, kellyDist, computeStake } from '../shared/engine/kelly.js';
import { scoreMatrix, matrix1X2, fitLambdas, ahDist, totalDist, settleLine, teamRatings, predictLambdas } from '../shared/engine/poisson.js';
import { allocate, bankrollState, betPL } from '../shared/engine/risk.js';
import { evaluateEvent } from '../shared/engine/value.js';
import { normCdf, normInv, eloRatings, elo1X2 } from '../shared/engine/elo.js';
import { normalizeName, similarity, bestMatch } from '../shared/engine/names.js';
import { summarize } from '../shared/engine/stats.js';

const close = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('EV y Kelly del ejemplo del enunciado', () => {
  close(expectedValue(0.5, 2.2), 0.10, 1e-9);
  close(kellyBinary(0.5, 2.2), 0.0833333, 1e-6);
  const r = computeStake({ dist: [{ p: 0.5, r: 1.2 }, { p: 0.5, r: -1 }], price: 2.2, confidence: 'alta', evConservative: 0.05 }, { bankroll: 500, kellyFraction: 0.25, maxStakePct: 2 });
  close(r.fullKelly, 0.0833333, 1e-6);
  close(r.fractional, 0.0208333, 1e-6);
  assert.equal(r.stake, 10);
});

test('Kelly negativo → stake 0', () => {
  assert.equal(kellyBinary(0.4, 2.2), 0);
  const r = computeStake({ dist: [{ p: 0.4, r: 1.2 }, { p: 0.6, r: -1 }], price: 2.2, confidence: 'alta', evConservative: -0.1 }, { bankroll: 500, kellyFraction: 0.25, maxStakePct: 2 });
  assert.equal(r.stake, 0);
});

test('kellyDist coincide con la fórmula binaria y gestiona devoluciones', () => {
  close(kellyDist([{ p: 0.55, r: 0.95 }, { p: 0.45, r: -1 }]), kellyBinary(0.55, 1.95), 1e-6);
  // Con devolución: Kelly = binario sobre probabilidades condicionadas
  const fPush = kellyDist([{ p: 0.44, r: 1.0 }, { p: 0.2, r: 0 }, { p: 0.36, r: -1 }]);
  close(fPush, kellyBinary(0.44 / 0.8, 2.0), 1e-6);
});

test('Eliminación del margen', () => {
  const prices = [2.1, 3.4, 3.6];
  assert.ok(overround(prices) > 0);
  for (const f of [devigPower, devigMultiplicative, devigShin]) close(f(prices).reduce((a, b) => a + b), 1, 1e-9);
  // método potencia penaliza más al outsider que el multiplicativo
  assert.ok(devigPower(prices)[2] < devigMultiplicative(prices)[2]);
});

test('Clasificación orientativa del EV', () => {
  assert.equal(classifyEV(0.01).key, 'descartar');
  assert.equal(classifyEV(0.03).key, 'bajo');
  assert.equal(classifyEV(0.06).key, 'interesante');
  assert.equal(classifyEV(0.10).key, 'alto');
  assert.equal(classifyEV(0.2).key, 'excepcional');
});

test('Poisson: ajuste a mercado y líneas asiáticas de cuarto', () => {
  const target = { home: 0.45, draw: 0.27, away: 0.28 };
  const lam = fitLambdas(target, { line: 2.5, over: 0.5, under: 0.5 });
  const r = matrix1X2(scoreMatrix(lam.home, lam.away));
  close(r.home, 0.45, 0.02); close(r.draw, 0.27, 0.02);
  // Liquidación de cuarto: -0.25 con empate = media pérdida
  close(settleLine(0, -0.25, 2), -0.5, 1e-9);
  close(settleLine(1, -0.75, 2), 0.5, 1e-9); // gana por 1 con -0.75 → media ganancia
  close(settleLine(0, 0, 2), 0, 1e-9);
  const m = scoreMatrix(lam.home, lam.away);
  const d = ahDist(m, -0.25, 'home', 2.0);
  close(d.reduce((a, x) => a + x.p, 0), 1, 1e-9);
  assert.ok(d.some((x) => x.r === -0.5));
  const t = totalDist(m, 2.25, 'over', 2.0);
  assert.ok(t.some((x) => x.r === -0.5));
  const fair = fairPriceFromDist((pr) => ahDist(m, -0.25, 'home', pr));
  assert.ok(fair > 1.5 && fair < 3);
});

test('Ratings estadísticos a partir de resultados', () => {
  const teams = ['A', 'B', 'C', 'D', 'E', 'F'];
  const ms = [];
  let day = 0;
  for (let r = 0; r < 4; r++) for (const h of teams) for (const a of teams) if (h !== a) {
    const strong = (t) => (t === 'A' ? 2.2 : t === 'F' ? 0.6 : 1.2);
    ms.push({ date: new Date(Date.UTC(2026, 7, 1) + day++ * 3600e3), home: h, away: a, hg: Math.round(strong(h) * 1.1), ag: Math.round(strong(a) * 0.9) });
  }
  const R = teamRatings(ms, { asOf: new Date(Date.UTC(2026, 10, 1)) });
  const l = predictLambdas(R, 'A', 'F');
  assert.ok(l.home > l.away);
  const elo = eloRatings(ms);
  const p = elo1X2(elo, 'A', 'F');
  assert.ok(p.home > p.away);
});

test('Normal: CDF e inversa', () => {
  close(normCdf(0), 0.5, 1e-7); close(normCdf(1.96), 0.975, 1e-3); close(normInv(0.975), 1.96, 1e-3);
});

test('Nombres: normalización y emparejamiento', () => {
  assert.equal(normalizeName('Atlético Madrid'), 'ath madrid');
  assert.equal(normalizeName('Ath Madrid'), 'ath madrid');
  assert.equal(normalizeName("Nottingham Forest"), normalizeName("Nott'm Forest"));
  assert.ok(similarity('Real Madrid CF', 'Real Madrid') > 0.95);
  assert.equal(bestMatch('Manchester United', ['Man City', 'Man United', 'Arsenal']).name, 'Man United');
  assert.equal(bestMatch('Equipo Inexistente', ['Man City', 'Arsenal']), null);
});

test('Bankroll: estado, apuestas pendientes y P/L', () => {
  const bets = [
    { kind: 'real', stake: 10, odds: 2.2, result: 'ganada' },
    { kind: 'real', stake: 10, odds: 1.9, result: 'perdida' },
    { kind: 'real', stake: 8, odds: 2.0, result: 'pendiente' },
    { kind: 'simulada', stake: 50, odds: 3, result: 'perdida' },
  ];
  const s = bankrollState({ initial: 500, transactions: [{ type: 'deposit', amount: 100 }] }, bets);
  assert.equal(s.total, 602);
  assert.equal(s.committed, 8);
  assert.equal(s.available, 594);
  assert.equal(betPL({ stake: 10, odds: 2, result: 'media_ganada' }), 5);
  const sum = summarize(bets.filter((b) => b.kind === 'real'));
  assert.equal(sum.settled, 2); close(sum.pl, 2, 1e-9);
});

test('Asignación de cartera: límites por evento y exposición total', () => {
  const mk = (id, ev, p, price) => ({ id, eventId: ev, price, confidence: 'alta', evConservative: p * price - 1, dist: [{ p, r: price - 1 }, { p: 1 - p, r: -1 }] });
  const opps = [mk('a', 'e1', 0.6, 2.0), mk('b', 'e1', 0.6, 2.0), mk('c', 'e2', 0.6, 2.0), mk('d', 'e3', 0.6, 2.0), mk('e', 'e4', 0.6, 2.0)];
  const bank = { total: 1000, available: 1000 };
  const res = allocate(opps, { kellyFraction: 0.25, maxStakePct: 2, maxExposurePct: 5, maxEventPct: 2 }, bank, []);
  const total = [...res.values()].reduce((a, r) => a + r.stake, 0);
  assert.ok(total <= 50 + 1e-9, `exposición ${total}`);
  assert.ok(res.get('a').stake + res.get('b').stake <= 20 + 1e-9);
});

// --- Evaluación de un evento sintético --------------------------------------------
function quote(price, minsAgo = 1) { return { price, updatedAt: new Date(Date.now() - minsAgo * 60000).toISOString(), provider: 'test' }; }
function synthEvent(targetHomePrice) {
  const books = { pinnacle: [2.0, 3.6, 4.0], williamhill: [1.95, 3.5, 3.9], smarkets: [2.04, 3.7, 4.1], unibet_fr: [1.93, 3.5, 3.8], betsson: [1.96, 3.45, 3.85] };
  const quotes = {};
  for (const [b, [h, d, a]] of Object.entries(books)) quotes[b] = { home: quote(h), draw: quote(d), away: quote(a) };
  quotes.betfair_es = { home: { ...quote(targetHomePrice), size: 200 }, draw: { ...quote(3.4), size: 200 }, away: { ...quote(3.7), size: 200 } };
  quotes.matchbook = { home: { ...quote(1.97), size: 200 }, draw: { ...quote(3.5), size: 200 }, away: { ...quote(3.75), size: 200 } };
  return {
    id: 'football|2026-11-21|a|b', sport: 'football', competition: 'Test League', home: 'Equipo A', away: 'Equipo B', commence: new Date(Date.now() + 86400000).toISOString(),
    markets: { h2h3: { key: 'h2h3', type: 'h2h3', line: null, sels: ['home', 'draw', 'away'], quotes } },
  };
}

test('Detecta value bet cuando la cuota objetivo supera claramente la referencia sin margen', () => {
  const { opportunities } = evaluateEvent(synthEvent(2.32), { settings: {} });
  const o = opportunities.find((x) => x.book === 'betfair_es' && x.sel === 'home');
  assert.ok(Math.abs(o.price - (1 + 1.32 * 0.95)) < 1e-9, 'EV calculado con cuota neta de comisión (5 %)');
  assert.ok(o, 'debería detectarse');
  assert.ok(o.evTheoretical > 0.05 && o.evTheoretical < 0.2);
  assert.ok(o.pEst > 0.45 && o.pEst < 0.52);
  assert.equal(o.sharpN, 3, 'pinnacle, smarkets y matchbook (otro exchange) son referencia');
  assert.ok(o.evConservative < o.evTheoretical);
});

test('No muestra apuestas sin valor', () => {
  const { opportunities } = evaluateEvent(synthEvent(2.05), { settings: {} });
  assert.equal(opportunities.filter((x) => x.sel === 'home' && x.book === 'betfair_es').length, 0, '2.05 bruta ≈ 2.00 neta: sin valor');
});

test('Marca posible error de cuota y no lo da por verificado', () => {
  const { opportunities, anomalies } = evaluateEvent(synthEvent(2.8), { settings: {} });
  assert.ok(anomalies.some((a) => a.category === 'error' && a.book === 'betfair_es'));
  const o = opportunities.find((x) => x.book === 'betfair_es' && x.sel === 'home');
  assert.equal(o.exceptional, true);
  assert.equal(o.verified, false);
});

test('Excluye cuotas obsoletas', () => {
  const ev = synthEvent(2.32);
  ev.markets.h2h3.quotes.betfair_es.home = { ...quote(2.32, 120), size: 200 };
  const { opportunities } = evaluateEvent(ev, { settings: {} });
  assert.equal(opportunities.filter((x) => x.book === 'betfair_es' && x.sel === 'home').length, 0);
});

test('Excluye precios sin liquidez suficiente y limita el stake a la liquidez', () => {
  const ev = synthEvent(2.32);
  ev.markets.h2h3.quotes.betfair_es.home.size = 4;
  assert.equal(evaluateEvent(ev, { settings: {} }).opportunities.filter((x) => x.book === 'betfair_es' && x.sel === 'home').length, 0);
  ev.markets.h2h3.quotes.betfair_es.home.size = 12;
  const o = evaluateEvent(ev, { settings: {} }).opportunities.find((x) => x.book === 'betfair_es' && x.sel === 'home');
  const st = allocate([o], { kellyFraction: 1, maxStakePct: 10, maxExposurePct: 10, maxEventPct: 10 }, { total: 10000, available: 10000 }, []).get(o.id);
  assert.equal(st.stake, 12);
});

test('Línea de cuarto: a la cuota justa del mercado el EV es ≈ 0 (Poisson sólo aporta la forma)', () => {
  const q = (p) => ({ price: p, updatedAt: new Date().toISOString(), provider: 'test' });
  const books = { pinnacle: [1.8, 3.8, 4.6, 1.62, 2.4], betfair_ex_eu: [1.82, 3.9, 4.7, 1.64, 2.42], williamhill: [1.75, 3.7, 4.4, 1.6, 2.3], betsson: [1.77, 3.75, 4.5, 1.6, 2.32] };
  const h2h = {}, ah = {};
  for (const [b, [h, d, a, ahh, aha]] of Object.entries(books)) { h2h[b] = { home: q(h), draw: q(d), away: q(a) }; ah[b] = { home: q(ahh), away: q(aha) }; }
  const ev = { id: 'x', sport: 'football', competition: 'T', home: 'A', away: 'B', commence: new Date(Date.now() + 864e5).toISOString(), markets: {
    h2h3: { key: 'h2h3', type: 'h2h3', line: null, sels: ['home', 'draw', 'away'], quotes: h2h },
    'ah:-0.25': { key: 'ah:-0.25', type: 'ah', line: -0.25, sels: ['home', 'away'], quotes: { ...ah, matchbook: { home: { ...q(1.78), size: 100 }, away: { ...q(2.2), size: 100 } } } } } };
  const r = evaluateEvent(ev, { settings: {} });
  const o = r.opportunities.find((x) => x.marketKey === 'ah:-0.25' && x.sel === 'home');
  assert.ok(o, '1.78 (1.75 neta de 4 %) frente a justa ≈1.64 debe detectarse');
  assert.ok(o.evTheoretical > 0.02 && o.evTheoretical < 0.1, `EV ${o.evTheoretical}`);
  assert.ok(o.dist.some((d) => d.r === -0.5), 'incluye media pérdida');
});
