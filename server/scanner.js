// Orquestación de un ciclo de análisis: proveedores → normalización → fusión → modelos → motor → riesgo → registro.

import * as TOA from './providers/theOddsApi.js';
import * as MB from './providers/matchbook.js';
import * as BF from './providers/betfair.js';
import * as FD from './providers/footballData.js';
import { loadState, saveState, getKey, logError } from './store.js';
import { evaluateEvent } from '../shared/engine/value.js';
import { allocate, bankrollState } from '../shared/engine/risk.js';
import { normalizeName, similarity } from '../shared/engine/names.js';

export const progress = { running: false, phase: 'inactivo', detail: '', startedAt: null, steps: [] };
let controller = null;

function setPhase(phase, detail = '') {
  progress.phase = phase; progress.detail = detail;
  progress.steps.push({ at: new Date().toISOString(), phase, detail });
  if (progress.steps.length > 60) progress.steps.shift();
}

export function stopScan() {
  if (controller) controller.abort(new Error('detenido'));
  return { stopped: !!controller };
}

const eventId = (e) => `${e.sport}|${String(e.commence).slice(0, 10)}|${normalizeName(e.home)}|${normalizeName(e.away)}`;

/** Fusiona eventos de varios proveedores (mismo deporte, hora ±3 h y nombres equivalentes). */
export function mergeEvents(lists) {
  const merged = [];
  for (const ev of lists.flat()) {
    const t = new Date(ev.commence).getTime();
    let target = null, swapped = false;
    for (const m of merged) {
      if (m.sport !== ev.sport || Math.abs(new Date(m.commence).getTime() - t) > 3 * 3600e3) continue;
      if (similarity(m.home, ev.home) >= 0.7 && similarity(m.away, ev.away) >= 0.7) { target = m; break; }
      if (ev.sport === 'tennis' && similarity(m.home, ev.away) >= 0.7 && similarity(m.away, ev.home) >= 0.7) { target = m; swapped = true; break; }
    }
    if (!target) {
      merged.push({ id: eventId(ev), sport: ev.sport, competition: ev.competition, competitionKey: ev.competitionKey, home: ev.home, away: ev.away, commence: ev.commence, sources: { [ev.provider]: ev.providerEventId }, markets: structuredClone(ev.markets) });
      continue;
    }
    target.sources[ev.provider] = ev.providerEventId;
    if (!target.competitionKey && ev.competitionKey) target.competitionKey = ev.competitionKey;
    for (const [k, mk] of Object.entries(ev.markets)) {
      if (swapped && mk.type !== 'h2h') continue; // orden de jugadores distinto: sólo se fusiona el ganador
      const dst = (target.markets[k] ||= { ...mk, quotes: {} });
      if (mk.semanticsVerified === false) dst.semanticsVerified = false;
      for (const [book, q] of Object.entries(mk.quotes)) {
        const qq = swapped ? { home: q.away, away: q.home } : q;
        const cur = dst.quotes[book];
        const newer = !cur || Object.values(qq).some((x) => x && new Date(x.updatedAt) > new Date(Object.values(cur)[0]?.updatedAt || 0));
        if (newer) dst.quotes[book] = qq;
      }
    }
  }
  return merged;
}

export async function runScan() {
  if (progress.running) throw new Error('Ya hay un análisis en curso');
  const state = loadState();
  const settings = state.settings;
  controller = new AbortController();
  const signal = controller.signal;
  Object.assign(progress, { running: true, startedAt: new Date().toISOString(), steps: [] });
  const t0 = Date.now();
  const errors = [];
  const sourcesReport = [];
  try {
    setPhase('obteniendo_eventos', 'Consultando proveedores de cuotas');
    const lists = []; const books = {};
    const tasks = [];
    if (settings.providers.theoddsapi.enabled) {
      const key = getKey('theoddsapi');
      if (!key) sourcesReport.push({ provider: TOA.label, status: 'sin_clave', detail: 'Falta la clave API: sin ella no hay casas de referencia independientes (Pinnacle, etc.)' });
      else tasks.push(TOA.fetchOdds({ key, settings, signal, progress: (d) => setPhase('consultando_cuotas', d) }).then((r) => {
        lists.push(r.events); Object.assign(books, r.books); errors.push(...r.errors);
        if (r.quota) state.quota.theoddsapi = r.quota;
        sourcesReport.push({ provider: TOA.label, status: r.errors.length && !r.events.length ? 'error' : 'ok', events: r.events.length, detail: `Competiciones: ${r.sportsQueried.length}. Sin actividad: ${r.sportsInactive.join(', ') || '—'}`, quota: r.quota });
      }).catch((e) => { if (signal.aborted) throw e; errors.push(e.message); sourcesReport.push({ provider: TOA.label, status: 'error', detail: e.message }); }));
    }
    const report = (P, r) => {
      lists.push(r.events); Object.assign(books, r.books); errors.push(...r.errors);
      sourcesReport.push({ provider: P.label, status: r.errors.length && !r.events.length ? 'error' : 'ok', events: r.events.length, detail: r.errors[0] || 'Precios back con liquidez mínima' });
    };
    const fail = (P) => (e) => { if (signal.aborted) throw e; errors.push(e.message); sourcesReport.push({ provider: P.label, status: 'error', detail: e.message }); };
    if (settings.providers.matchbook.enabled) {
      tasks.push(MB.fetchOdds({ settings, signal, progress: (d) => setPhase('consultando_cuotas', d) }).then((r) => report(MB, r)).catch(fail(MB)));
    }
    if (settings.providers.betfair.enabled) {
      const creds = { appKey: getKey('betfair_appkey'), username: getKey('betfair_username'), password: getKey('betfair_password') };
      if (!creds.appKey || !creds.username || !creds.password) sourcesReport.push({ provider: BF.label, status: 'sin_clave', detail: 'Faltan Application Key, usuario o contraseña de betfair.es (Configuración)' });
      else tasks.push(BF.fetchOdds({ creds, settings, signal, progress: (d) => setPhase('consultando_cuotas', d) }).then((r) => report(BF, r)).catch(fail(BF)));
    }
    await Promise.all(tasks);
    if (signal.aborted) throw new Error('Análisis detenido por el usuario');

    setPhase('fusionando', 'Verificando que eventos, mercados y selecciones coinciden entre fuentes');
    const events = mergeEvents(lists);

    let statFor = () => null;
    if (settings.providers.footballdata.enabled && events.some((e) => e.sport === 'football')) {
      setPhase('modelos', 'Cargando estadísticas históricas (football-data.co.uk)');
      statFor = await FD.prepareModels(events, { signal, progress: (d) => setPhase('modelos', d), errors });
    }

    setPhase('calculando_valor', `Evaluando ${events.length} eventos`);
    const now = Date.now();
    let opportunities = [], anomalies = [], rows = [], issues = [];
    const modelCoverage = { matched: 0, unmatched: [], none: 0 };
    for (const ev of events) {
      if (signal.aborted) throw new Error('Análisis detenido por el usuario');
      if (new Date(ev.commence).getTime() < now) continue; // sólo pre-partido
      const stat = statFor(ev);
      if (stat?.matrix) modelCoverage.matched++; else if (stat?.unmatched) modelCoverage.unmatched.push(stat.detail); else if (ev.sport === 'football') modelCoverage.none++;
      const r = evaluateEvent(ev, { now, settings, statModel: stat?.matrix ? stat : null });
      for (const o of r.opportunities) { o.modelNote = stat?.unmatched ? stat.detail : !stat && ev.sport === 'football' ? 'Competición sin modelo estadístico propio (sólo mercado)' : ev.sport !== 'football' ? 'Sin modelo estadístico independiente para este deporte: estimación basada en mercado sharp/consenso' : null; o.sources = sourcesFor(ev, o); }
      opportunities.push(...r.opportunities); anomalies.push(...r.anomalies);
      rows.push({ id: ev.id, sport: ev.sport, competition: ev.competition, event: `${ev.home} vs ${ev.away}`, commence: ev.commence, sources: Object.keys(ev.sources), markets: r.rows, nBooks: new Set(Object.values(ev.markets).flatMap((m) => Object.keys(m.quotes))).size });
      issues.push(...r.issues);
    }

    // Deduplicación: misma selección y casa en varias fuentes: se conserva la de mayor EV conservador.
    const byKey = new Map();
    for (const o of opportunities) {
      const k = `${o.eventId}|${o.marketKey.replace('|op', '')}|${o.sel}|${o.book.split('_')[0]}`;
      const cur = byKey.get(k);
      if (!cur || o.evConservative > cur.evConservative) byKey.set(k, o);
    }
    opportunities = [...byKey.values()];
    // Si se apuesta a ambos lados del mismo mercado sería incoherente: se mantiene sólo el mejor lado.
    const sideKey = new Map();
    for (const o of opportunities) { const k = `${o.eventId}|${o.marketKey}`; const cur = sideKey.get(k); if (!cur || o.evConservative > cur.evConservative) sideKey.set(k, o); }
    opportunities = opportunities.filter((o) => sideKey.get(`${o.eventId}|${o.marketKey}`) === o);
    opportunities.sort((a, b) => b.evTheoretical - a.evTheoretical);

    setPhase('gestion_riesgo', 'Calculando stakes (Kelly fraccionado y límites)');
    const bank = bankrollState(state.bankroll, state.bets);
    const pending = state.bets.filter((b) => b.kind === 'real' && b.result === 'pendiente');
    const alloc = allocate(opportunities, settings, bank, pending);
    for (const o of opportunities) o.stakeAtDetection = alloc.get(o.id)?.stake ?? 0;

    // Persistencia en escaneos sucesivos
    const prevIds = new Set((state.lastScan?.opportunities || []).map((o) => o.id));
    const seen = state.seenCounts || {};
    const nextSeen = {};
    for (const o of opportunities) { nextSeen[o.id] = prevIds.has(o.id) ? (seen[o.id] || 1) + 1 : 1; o.seenCount = nextSeen[o.id]; }
    state.seenCounts = nextSeen;
    for (const a of anomalies) { a.seenCount = (state.lastScan?.anomalies || []).some((x) => x.id === a.id) ? 2 : 1; if (a.seenCount > 1) a.verification = 'confirmada en escaneos sucesivos'; }

    recordHistory(state, rows, now);
    recordOpportunities(state, opportunities, now);
    updateClosing(state, now);

    const best = opportunities[0]?.evTheoretical ?? null;
    const scan = {
      at: new Date(now).toISOString(), durationMs: Date.now() - t0,
      eventsAnalyzed: rows.length, marketsAnalyzed: rows.reduce((a, r) => a + r.markets.length, 0),
      opportunities, anomalies, rows, sources: sourcesReport, errors, issues: issues.slice(0, 200), modelCoverage,
      bestEV: best, books,
      dataStatus: !sourcesReport.some((s) => s.status === 'ok') ? 'sin_datos' : 'ok',
    };
    state.lastScan = scan;
    for (const e of errors) logError('escaneo', e);
    saveState(true);
    setPhase('terminado', `${opportunities.length} oportunidades en ${rows.length} eventos`);
    return scan;
  } catch (e) {
    setPhase(signal.aborted ? 'detenido' : 'error', e.message);
    if (!signal.aborted) logError('escaneo', e.message);
    throw e;
  } finally {
    progress.running = false; controller = null;
  }
}

function sourcesFor(ev, o) {
  const src = [];
  if (ev.sources.theoddsapi) src.push({ name: 'The Odds API', ref: `evento ${ev.sources.theoddsapi}`, url: 'https://the-odds-api.com' });
  if (ev.sources.matchbook) src.push({ name: 'Matchbook API', ref: `evento ${ev.sources.matchbook}`, url: 'https://developers.matchbook.com' });
  if (ev.sources.betfair) src.push({ name: 'Betfair Exchange API (ES)', ref: `evento ${ev.sources.betfair}`, url: 'https://developer.betfair.com' });
  if (o.model) src.push({ name: 'football-data.co.uk', ref: o.model.source, url: 'https://www.football-data.co.uk' });
  return src;
}

const histKey = (eventId, marketKey, sel) => `${eventId}|${marketKey}|${sel}`;

function recordHistory(state, rows, now) {
  const H = state.oddsHistory;
  for (const ev of rows) {
    for (const m of ev.markets) {
      for (const s of m.sels) {
        if (!Object.keys(s.targets).length && !s.p) continue;
        const k = histKey(ev.id, m.marketKey, s.sel);
        const arr = (H[k] ||= { commence: ev.commence, points: [] }).points;
        const pt = { t: now, fair: s.fair ? +s.fair.toFixed(3) : null, best: s.best?.price ?? null };
        for (const [b, q] of Object.entries(s.targets)) pt[b] = q.price;
        arr.push(pt);
        if (arr.length > 80) arr.splice(0, arr.length - 80);
      }
    }
  }
  // Limpieza: eventos empezados hace más de 4 días
  for (const [k, v] of Object.entries(H)) if (new Date(v.commence).getTime() < now - 4 * 86400e3) delete H[k];
}

function recordOpportunities(state, opps, now) {
  const log = state.opportunityLog;
  const index = new Map(log.map((o, i) => [o.id, i]));
  const active = new Set(opps.map((o) => o.id));
  for (const o of opps) {
    const entry = {
      id: o.id, eventId: o.eventId, marketKey: o.marketKey, sel: o.sel, sport: o.sport, competition: o.competition, event: o.event, commence: o.commence,
      market: o.market, marketGroup: o.marketGroup, selection: o.selection, book: o.book,
      price: o.price, pEst: o.pEst, evTheoretical: o.evTheoretical, evConservative: o.evConservative, confidence: o.confidence,
      verification: o.verification, stake: o.stakeAtDetection, lastSeen: new Date(now).toISOString(), status: 'activa',
    };
    if (index.has(o.id)) {
      const cur = log[index.get(o.id)];
      Object.assign(cur, { lastPrice: o.price, lastEV: o.evTheoretical, lastSeen: entry.lastSeen, status: 'activa', seenCount: (cur.seenCount || 1) + 1, verification: o.verification });
    } else {
      log.push({ ...entry, firstSeen: entry.lastSeen, seenCount: 1 });
    }
  }
  for (const e of log) if (e.status === 'activa' && !active.has(e.id) && new Date(e.commence).getTime() > now) e.status = 'expirada';
  if (log.length > 5000) log.splice(0, log.length - 5000);
}

/** Cuota de cierre: último precio justo registrado antes del inicio (sólo si el análisis estuvo activo). */
function updateClosing(state, now) {
  const H = state.oddsHistory;
  const closeFor = (eventId, marketKey, sel, commence, book) => {
    const h = H[histKey(eventId, marketKey, sel)];
    if (!h) return null;
    const start = new Date(commence).getTime();
    const pts = h.points.filter((p) => p.t <= start);
    const last = pts[pts.length - 1];
    if (!last) return null;
    return { fair: last.fair, book: book ? last[book] ?? null : null, at: new Date(last.t).toISOString(), minutesBefore: Math.round((start - last.t) / 60000) };
  };
  for (const o of state.opportunityLog) {
    if (o.closingFairOdds || new Date(o.commence).getTime() > now) continue;
    const c = closeFor(o.eventId, o.marketKey, o.sel, o.commence);
    if (c?.fair) { o.closingFairOdds = c.fair; o.closingMinutesBefore = c.minutesBefore; if (o.status === 'activa') o.status = 'cerrada'; }
  }
  for (const b of state.bets) {
    if (b.closingOdds || !b.eventId || new Date(b.eventStart || 0).getTime() > now) continue;
    const c = closeFor(b.eventId, b.marketKey, b.sel, b.eventStart, b.book);
    if (c?.book || c?.fair) { b.closingOdds = c.book || c.fair; b.closingSource = c.book ? `cuota de ${b.book} ${c.minutesBefore} min antes del inicio` : `cuota justa de referencia ${c.minutesBefore} min antes del inicio`; }
  }
}
