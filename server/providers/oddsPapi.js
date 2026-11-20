// Proveedor: OddsPapi (https://oddspapi.io) — API v4.
// Cobertura relevante: bet365 y Winamax (FR/ES/DE) además de Pinnacle (con 30 s de retraso en planes self-serve).
// Coste: 1 petición por llamada a /fixtures y por cada /odds (una por partido). Plan gratuito: ~250 peticiones/mes.
// Tiempos mínimos entre llamadas: /fixtures 2 s, /odds 0,5 s, /markets y /bookmakers 1 s.

import { getJSON, sleep, ProviderError } from '../http.js';
import { cacheGet, cacheSet } from '../store.js';

const BASE = 'https://api.oddspapi.io/v4';
export const id = 'oddspapi';
export const label = 'OddsPapi';
const SPORTS = { 10: 'football', 11: 'basketball', 12: 'tennis' };
const ACCEPTED_PERIODS = new Set(['fulltime', 'ft', 'full time', 'match', 'result', 'regular time', 'regulartime']);

/** Slug de OddsPapi → clave canónica interna (compatible con The Odds API). */
export function canonicalBook(slug) {
  const s = String(slug).toLowerCase();
  if (s.startsWith('pinnacle')) return 'pinnacle';
  const m = s.match(/^(bet365|winamax)(?:[-_.]?(es|fr|de|it|uk|gr|nl|ar))?$/);
  if (m) return m[2] ? `${m[1]}_${m[2]}` : m[1];
  return s.replace(/[^a-z0-9]+/g, '_');
}

async function call(path, key, signal, retry = true) {
  const sep = path.includes('?') ? '&' : '?';
  try {
    return (await getJSON(id, `${BASE}${path}${sep}apiKey=${encodeURIComponent(key)}`, { signal })).body;
  } catch (e) {
    const code = e.body?.error?.code;
    if (retry && e.status === 429 && code === 'RATE_LIMITED') {
      await sleep(Math.min(5000, Number(e.body?.error?.retryMs) || 1500), signal);
      return call(path, key, signal, false);
    }
    if (e.status === 429 && code === 'REQUEST_LIMIT_EXCEEDED') throw new ProviderError(id, 'OddsPapi: cuota mensual agotada', 429, e.body);
    throw e;
  }
}

async function bookmakers(key, signal) {
  let list = cacheGet('oddspapi-bookmakers.json', 24 * 3600e3);
  if (!list) { list = await call('/bookmakers', key, signal); cacheSet('oddspapi-bookmakers.json', list); await sleep(1100, signal); }
  return Array.isArray(list) ? list : [];
}
async function marketsCatalog(key, signal) {
  let list = cacheGet('oddspapi-markets.json', 7 * 24 * 3600e3);
  if (!list) { list = await call('/markets', key, signal); cacheSet('oddspapi-markets.json', list); await sleep(1100, signal); }
  const map = new Map();
  for (const m of Array.isArray(list) ? list : []) map.set(String(m.marketId), m);
  return map;
}

export async function account(key, signal) {
  try { return await call('/account', key, signal, false); } catch { return null; }
}

/** Traduce un mercado del catálogo de OddsPapi al modelo interno. Devuelve null si no es fiable. */
export function mapMarket(cat, sport) {
  if (!cat || cat.playerProp) return null;
  const period = String(cat.period || '').toLowerCase();
  if (!ACCEPTED_PERIODS.has(period)) return null;
  const t = String(cat.marketType || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const h = Number(cat.handicap) || 0;
  const outName = (o) => String(o.outcomeName || '').trim().toLowerCase();
  const sel = {};
  const sfx = sport === 'football' ? '' : '|op'; // en baloncesto/tenis no se mezcla con otro proveedor (prórroga/semántica)
  let def;
  if (t === '1x2') { def = { key: 'h2h3', type: 'h2h3', line: null, sels: ['home', 'draw', 'away'] }; Object.assign(sel, { '1': 'home', 'x': 'draw', '2': 'away' }); }
  else if (t === 'moneyline') { def = { key: 'h2h', type: 'h2h', line: null, sels: ['home', 'away'] }; Object.assign(sel, { '1': 'home', '2': 'away' }); }
  else if (t === 'totals') { def = { key: `totals:${h}${sfx}`, type: 'totals', line: h, sels: ['over', 'under'] }; Object.assign(sel, { over: 'over', under: 'under' }); }
  else if (t === 'spreads') { const type = sport === 'football' ? 'ah' : 'spread'; def = { key: `${type}:${h}|op`, type, line: h, sels: ['home', 'away'], semanticsVerified: false }; Object.assign(sel, { '1': 'home', '2': 'away' }); }
  else if (t === 'bothteamsscore') { def = { key: 'btts', type: 'btts', line: null, sels: ['yes', 'no'] }; Object.assign(sel, { yes: 'yes', no: 'no' }); }
  else if (t === 'doublechance') { def = { key: 'dc', type: 'dc', line: null, sels: ['1X', '12', 'X2'] }; Object.assign(sel, { '1x': '1X', '12': '12', 'x2': 'X2' }); }
  else if (t === 'drawnobet') { def = { key: 'dnb', type: 'dnb', line: null, sels: ['home', 'away'] }; Object.assign(sel, { '1': 'home', '2': 'away' }); }
  else return null;
  const outcomes = {};
  for (const o of cat.outcomes || []) { const s = sel[outName(o)]; if (s) outcomes[String(o.outcomeId)] = s; }
  if (Object.keys(outcomes).length !== def.sels.length) return null; // nombres de selección no reconocidos → no fiable
  return { ...def, outcomes };
}

export async function fetchOdds({ key, settings, signal, progress }) {
  const cfg = settings.providers.oddspapi;
  const errors = [];
  progress?.('OddsPapi: catálogo de casas y mercados');
  const bms = await bookmakers(key, signal);
  const slugs = bms.map((b) => b.slug).filter(Boolean);
  const wantedTargets = slugs.filter((s) => /^(bet365|winamax)([-_.]?(es|fr|de))?$/i.test(s));
  const refs = slugs.filter((s) => cfg.referenceBooks.some((r) => s.toLowerCase().startsWith(r)));
  const useBooks = [...new Set([...wantedTargets, ...refs])];
  if (!wantedTargets.length) errors.push('OddsPapi: no se encontraron bet365/winamax en /bookmakers para esta clave');
  const catalog = await marketsCatalog(key, signal);

  const now = Date.now();
  const fromIso = new Date(now).toISOString().replace(/\.\d+Z$/, 'Z');
  const toIso = new Date(now + Math.min(settings.horizonHours, 9 * 24) * 3600e3).toISOString().replace(/\.\d+Z$/, 'Z');
  let fixtures = [];
  for (const sportId of cfg.sports) {
    if (signal?.aborted) break;
    progress?.(`OddsPapi: partidos de ${SPORTS[sportId] || sportId}`);
    try {
      const list = await call(`/fixtures?sportId=${sportId}&from=${fromIso}&to=${toIso}&statusId=0&hasOdds=true&bookmakers=${encodeURIComponent(useBooks.join(','))}`, key, signal);
      fixtures = fixtures.concat((Array.isArray(list) ? list : []).filter((f) => SPORTS[f.sportId]));
    } catch (e) { if (signal?.aborted) throw e; errors.push(e.message); if (e.status === 401 || e.status === 429) break; }
    await sleep(2100, signal);
  }
  fixtures.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  fixtures = fixtures.slice(0, cfg.maxFixtures);

  const events = []; const books = {};
  let i = 0;
  for (const f of fixtures) {
    if (signal?.aborted) break;
    progress?.(`OddsPapi: cuotas ${++i}/${fixtures.length}`);
    try {
      const odds = await call(`/odds?fixtureId=${encodeURIComponent(f.fixtureId)}&bookmakers=${encodeURIComponent(useBooks.join(','))}&oddsFormat=decimal`, key, signal);
      const ev = normalizeOdds(odds, catalog, books);
      if (ev) events.push(ev);
    } catch (e) { if (signal?.aborted) throw e; errors.push(e.message); if (e.status === 401 || e.status === 429) break; }
    await sleep(600, signal);
  }
  const acc = await account(key, signal);
  const quota = acc ? { remaining: acc.request_limit != null && acc.request_count != null ? acc.request_limit - acc.request_count : null, used: acc.request_count ?? null, limit: acc.request_limit ?? null, at: new Date().toISOString() } : null;
  return { events, quota, errors, books, fixturesFound: fixtures.length, bookSlugs: useBooks };
}

export function normalizeOdds(o, catalog, books = {}, fetchedAt = new Date().toISOString()) {
  const sport = SPORTS[o.sportId];
  if (!sport || !o.participant1Name || !o.participant2Name) return null;
  const out = {
    provider: id, providerEventId: o.fixtureId, sport, competition: o.tournamentName ? `${o.tournamentName}${o.categoryName ? ` (${o.categoryName})` : ''}` : o.sportName,
    competitionKey: o.tournamentSlug, home: o.participant1Name, away: o.participant2Name, commence: o.startTime, markets: {},
  };
  for (const [slug, bo] of Object.entries(o.bookmakerOdds || {})) {
    if (bo.bookmakerIsActive === false || bo.suspended) continue;
    const book = canonicalBook(slug);
    books[book] = slug;
    for (const [marketId, mk] of Object.entries(bo.markets || {})) {
      if (mk.marketActive === false) continue;
      const def = mapMarket(catalog.get(String(marketId)), sport);
      if (!def) continue;
      for (const [outcomeId, oc] of Object.entries(mk.outcomes || {})) {
        const sel = def.outcomes[String(outcomeId)];
        if (!sel) continue;
        const pl = Object.values(oc.players || {})[0];
        if (!pl || pl.active === false || !(pl.price > 1)) continue;
        const m = (out.markets[def.key] ||= { key: def.key, type: def.type, line: def.line, sels: def.sels, quotes: {}, semanticsVerified: def.semanticsVerified !== false });
        // changedAt = último cambio de precio; el precio se considera vigente en el momento de la consulta.
        (m.quotes[book] ||= {})[sel] = { price: Number(pl.price), updatedAt: fetchedAt, changedAt: pl.changedAt || pl.bookmakerChangedAt || null, provider: id, limit: pl.limit ?? null };
      }
    }
  }
  return out;
}
