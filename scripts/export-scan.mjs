// Ejecuta un análisis completo y guarda un resumen compacto en JSON para el artefacto «Tipster».
// Uso: NODE_USE_ENV_PROXY=1 THE_ODDS_API_KEY=... node scripts/export-scan.mjs salida.json
// Las claves nunca se escriben en el JSON.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TIPSTER_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'tipster-'));
const { runScan } = await import('../server/scanner.js');

const out = process.argv[2] || 'scan.json';
const r2 = (x, d = 4) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x ?? null);

const s = await runScan();
const opp = (o) => ({
  id: o.id, eventId: o.eventId, sport: o.sport, competition: o.competition, event: o.event, commence: o.commence,
  market: o.market, marketGroup: o.marketGroup, selection: o.selection, book: o.book,
  price: r2(o.price), rawPrice: r2(o.rawPrice), commission: o.commission, liquidity: r2(o.liquidity, 0),
  refOdds: r2(o.refOdds), refMeanOdds: r2(o.refMeanOdds), pMarket: r2(o.pMarket), pModel: r2(o.pModel), pEst: r2(o.pEst), se: r2(o.se), pImplied: r2(o.pImplied),
  evTheoretical: r2(o.evTheoretical), evMarketOnly: r2(o.evMarketOnly), evConservative: r2(o.evConservative), evOptimistic: r2(o.evOptimistic),
  evClass: o.evClass, evClassLabel: o.evClassLabel, confidence: o.confidence, verified: o.verified, exceptional: o.exceptional,
  nRefs: o.nRefs, sharpN: o.sharpN, quoteUpdatedAt: o.quoteUpdatedAt, detectedAt: o.detectedAt, distNote: o.distNote, pushP: r2(o.pushP),
  dist: o.dist.map((d) => ({ p: r2(d.p, 5), r: r2(d.r, 5), label: d.label || null })),
  checks: o.checks.map((c) => ({ name: c.name, ok: c.ok, detail: c.detail })), flags: o.flags, modelNote: o.modelNote || null,
  refBooks: o.refBooks.slice(0, 14).map((b) => ({ book: b.book, price: b.price, sharp: b.sharp })),
});
const anomaly = (a) => ({
  id: a.id, category: a.category, event: a.event, sport: a.sport, competition: a.competition, commence: a.commence, market: a.market,
  selection: a.selection ?? null, book: a.book ?? null, price: r2(a.price), diffPct: r2(a.diffPct), refMean: r2(a.refMean), pEst: r2(a.pEst), evTheoretical: r2(a.evTheoretical),
  margin: r2(a.margin), involvesTarget: a.involvesTarget ?? null, verification: a.verification,
  legs: a.legs ? a.legs.map((l) => ({ label: l.label, book: l.book, price: r2(l.price), rawPrice: r2(l.rawPrice), share: r2(l.share) })) : null,
  low: a.low ?? null,
});
// Escáner: sólo eventos con casas de referencia y los mercados principales.
const events = s.rows
  .filter((r) => r.sources.includes('theoddsapi') && r.sources.length > 1)
  .slice(0, 80)
  .map((r) => ({
    id: r.id, sport: r.sport, competition: r.competition, event: r.event, commence: r.commence, nBooks: r.nBooks,
    markets: r.markets.filter((m) => ['h2h3', 'h2h', 'btts'].includes(m.type) || m.key === 'totals:2.5' || (m.type === 'totals' && m.nBooks >= 4)).slice(0, 6).map((m) => ({
      label: m.label, nBooks: m.nBooks,
      sels: m.sels.map((x) => ({ label: x.label, targets: Object.fromEntries(Object.entries(x.targets).map(([k, v]) => [k, r2(v.price, 3)])), best: x.best ? { book: x.best.book, price: x.best.price } : null, fair: r2(x.fair, 3), p: r2(x.p) })),
    })),
  }));

const payload = {
  at: s.at, durationMs: s.durationMs, eventsAnalyzed: s.eventsAnalyzed, marketsAnalyzed: s.marketsAnalyzed, bestEV: r2(s.bestEV),
  dataStatus: s.dataStatus, eventsWithReferences: s.rows.filter((r) => r.sources.includes('theoddsapi') && r.sources.length > 1).length,
  sources: s.sources.map((x) => ({ provider: x.provider, status: x.status, events: x.events ?? null, detail: x.detail || null, remaining: x.quota?.remaining ?? null })),
  errors: s.errors.slice(0, 10), modelMatched: s.modelCoverage.matched,
  opportunities: s.opportunities.slice(0, 60).map(opp),
  anomalies: s.anomalies.slice(0, 60).map(anomaly),
  events,
};
fs.writeFileSync(out, JSON.stringify(payload));
console.log(`OK ${out}: ${payload.eventsAnalyzed} eventos, ${payload.opportunities.length} oportunidades, ${payload.anomalies.length} anomalías, ${(fs.statSync(out).size / 1024).toFixed(1)} KiB`);
process.exit(0);
