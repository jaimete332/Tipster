// Casa objetivo: Betfair Exchange España — API oficial (Betfair Exchange API-NG).
// Requisitos: cuenta en betfair.es + Application Key (se crea gratis en la cuenta; la clave "delayed"
// sirve para desarrollo con precios retrasados, la "live" da precios en tiempo real).
// Login España: POST https://identitysso.betfair.es/api/login (sesión de 20 min). Con el token obtenido,
// las consultas se envían a api.betfair.com y devuelven automáticamente los mercados del Exchange español.
// Mercados: Match Odds (1X2 / ganador), Over/Under 1.5-2.5-3.5 y Ambos marcan. El hándicap asiático
// de Betfair (doble línea) no se integra todavía.

import { getJSON, sleep, ProviderError } from '../http.js';

export const id = 'betfair';
export const label = 'Betfair Exchange ES (API oficial)';
const LOGIN = 'https://identitysso.betfair.es/api/login';
const API = 'https://api.betfair.com/exchange/betting/rest/v1.0';
export const EVENT_TYPES = { 1: 'football', 2: 'tennis', 7522: 'basketball' };
const BOOK = 'betfair_es';
const SOCCER_TYPES = ['MATCH_ODDS', 'OVER_UNDER_15', 'OVER_UNDER_25', 'OVER_UNDER_35', 'BOTH_TEAMS_TO_SCORE', 'DOUBLE_CHANCE'];

let session = null; // { token, at, user }

async function login(creds, signal) {
  if (session && session.user === creds.username && Date.now() - session.at < 15 * 60e3) return session.token;
  const { body } = await getJSON(id, LOGIN, {
    signal, method: 'POST',
    headers: { 'X-Application': creds.appKey, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ username: creds.username, password: creds.password }).toString(),
  });
  if (body.status !== 'SUCCESS' || !body.token) throw new ProviderError(id, `Betfair: login rechazado (${body.status}${body.error ? `: ${body.error}` : ''})`, 401, body);
  session = { token: body.token, at: Date.now(), user: creds.username };
  return session.token;
}

async function call(method, payload, creds, token, signal) {
  const { body } = await getJSON(id, `${API}/${method}/`, {
    signal, method: 'POST',
    headers: { 'X-Application': creds.appKey, 'X-Authentication': token, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  });
  return body;
}

/** "Local v Visitante" / "Visitante @ Local" (formato EE. UU.). */
export function parseTeams(name) {
  let m = String(name).match(/^(.*?)\s+v\s+(.*)$/i);
  if (m) return { home: m[1].trim(), away: m[2].trim() };
  m = String(name).match(/^(.*?)\s+@\s+(.*)$/);
  if (m) return { home: m[2].trim(), away: m[1].trim() };
  return null;
}

/** Traduce un mercado (catálogo + libro) al modelo interno. */
export function mapMarket(cat, book, typeCode, sport, minLiquidity, fetchedAt) {
  const teams = parseTeams(cat.event?.name);
  if (!teams) return null;
  const byId = new Map((book.runners || []).map((r) => [r.selectionId, r]));
  const price = (sel) => {
    const r = byId.get(sel.selectionId);
    if (!r || r.status !== 'ACTIVE') return null;
    const b = (r.ex?.availableToBack || []).filter((x) => x.price > 1 && x.size >= minLiquidity)[0];
    return b ? { price: b.price, size: b.size, updatedAt: fetchedAt, changedAt: book.lastMatchTime || null, provider: id } : null;
  };
  const runners = cat.runners || [];
  const name = (r) => String(r.runnerName || '').trim().toLowerCase();
  const sels = {};
  let def;
  if (typeCode === 'MATCH_ODDS') {
    const home = runners.find((r) => name(r) === teams.home.toLowerCase()), away = runners.find((r) => name(r) === teams.away.toLowerCase());
    const draw = runners.find((r) => name(r) === 'the draw');
    if (!home || !away) return null;
    if (sport === 'football') { if (!draw) return null; def = { key: 'h2h3', type: 'h2h3', line: null, sels: ['home', 'draw', 'away'] }; Object.assign(sels, { home, draw, away }); }
    else { def = { key: 'h2h', type: 'h2h', line: null, sels: ['home', 'away'] }; Object.assign(sels, { home, away }); }
  } else if (/^OVER_UNDER_(\d)5$/.test(typeCode)) {
    const line = Number(typeCode.match(/^OVER_UNDER_(\d)5$/)[1]) + 0.5;
    const over = runners.find((r) => name(r).startsWith(`over ${line}`)), under = runners.find((r) => name(r).startsWith(`under ${line}`));
    if (!over || !under) return null;
    def = { key: `totals:${line}`, type: 'totals', line, sels: ['over', 'under'] }; Object.assign(sels, { over, under });
  } else if (typeCode === 'BOTH_TEAMS_TO_SCORE') {
    const yes = runners.find((r) => name(r) === 'yes'), no = runners.find((r) => name(r) === 'no');
    if (!yes || !no) return null;
    def = { key: 'btts', type: 'btts', line: null, sels: ['yes', 'no'] }; Object.assign(sels, { yes, no });
  } else if (typeCode === 'DOUBLE_CHANCE') {
    const f = (n) => runners.find((r) => name(r) === n);
    const a = f('home or draw'), b = f('home or away'), c = f('draw or away');
    if (!a || !b || !c) return null;
    def = { key: 'dc', type: 'dc', line: null, sels: ['1X', '12', 'X2'] }; Object.assign(sels, { '1X': a, '12': b, X2: c });
  } else return null;
  const quotes = {};
  for (const [sel, r] of Object.entries(sels)) { const q = price(r); if (q) quotes[sel] = q; }
  if (!Object.keys(quotes).length) return null;
  return { teams, def, quotes };
}

export async function fetchOdds({ creds, settings, signal, progress }) {
  const cfg = settings.providers.betfair;
  progress?.('Betfair: iniciando sesión (betfair.es)');
  const token = await login(creds, signal);
  const now = Date.now();
  const range = { from: new Date(now + 60e3).toISOString(), to: new Date(now + settings.horizonHours * 3600e3).toISOString() };
  const fetchedAt = new Date().toISOString();
  const catalogue = []; // { cat, typeCode, sport }
  const errors = [];
  const jobs = [];
  for (const et of cfg.eventTypes) {
    const sport = EVENT_TYPES[et];
    const types = sport === 'football' ? SOCCER_TYPES : ['MATCH_ODDS'];
    for (const t of types) jobs.push({ et, sport, t });
  }
  for (const j of jobs) {
    if (signal?.aborted) break;
    progress?.(`Betfair: catálogo ${j.sport} ${j.t}`);
    try {
      const cats = await call('listMarketCatalogue', {
        filter: { eventTypeIds: [String(j.et)], marketTypeCodes: [j.t], marketStartTime: range, inPlayOnly: false },
        marketProjection: ['EVENT', 'COMPETITION', 'RUNNER_DESCRIPTION', 'MARKET_START_TIME'],
        sort: 'FIRST_TO_START', maxResults: cfg.maxMarketsPerType,
      }, creds, token, signal);
      for (const c of cats || []) catalogue.push({ cat: c, typeCode: j.t, sport: j.sport });
    } catch (e) { if (signal?.aborted) throw e; errors.push(e.message); if (e.status === 401 || e.status === 403) break; }
  }
  // Precios: lotes de 40 mercados (EX_BEST_OFFERS pesa 5 → 5 × 40 = 200 puntos, el máximo por petición)
  const books = new Map();
  for (let i = 0; i < catalogue.length; i += 40) {
    if (signal?.aborted) break;
    progress?.(`Betfair: precios ${Math.min(i + 40, catalogue.length)}/${catalogue.length}`);
    try {
      const res = await call('listMarketBook', {
        marketIds: catalogue.slice(i, i + 40).map((x) => x.cat.marketId),
        priceProjection: { priceData: ['EX_BEST_OFFERS'], exBestOffersOverrides: { bestPricesDepth: 1 } },
      }, creds, token, signal);
      for (const b of res || []) books.set(b.marketId, b);
    } catch (e) { if (signal?.aborted) throw e; errors.push(e.message); }
    await sleep(120, signal);
  }
  const events = new Map();
  for (const { cat, typeCode, sport } of catalogue) {
    const book = books.get(cat.marketId);
    if (!book || book.status !== 'OPEN' || book.inplay) continue;
    const m = mapMarket(cat, book, typeCode, sport, settings.providers.betfair.minLiquidity, fetchedAt);
    if (!m) continue;
    const evId = cat.event?.id;
    const ev = events.get(evId) || { provider: id, providerEventId: String(evId), sport, competition: cat.competition?.name || 'Betfair', competitionKey: null, home: m.teams.home, away: m.teams.away, commence: cat.event?.openDate || cat.marketStartTime, markets: {} };
    const mk = (ev.markets[m.def.key] ||= { ...m.def, quotes: {}, semanticsVerified: true });
    mk.quotes[BOOK] = m.quotes;
    events.set(evId, ev);
  }
  return { events: [...events.values()], errors, books: { [BOOK]: 'Betfair Exchange ES' }, quota: null };
}
