// Proveedor: The Odds API (https://the-odds-api.com) — v4.
// Papel: casas de REFERENCIA independientes (Pinnacle y ~25 casas europeas) para estimar la probabilidad justa.
// Sus precios de Betfair/Matchbook se descartan como referencia cuando esas casas son el objetivo.
// Coste: 1 crédito por región y mercado en cada llamada a /odds. /sports es gratuito.

import { getJSON } from '../http.js';

const BASE = 'https://api.the-odds-api.com/v4';
export const id = 'theoddsapi';
export const label = 'The Odds API';

const sportOf = (key) => (key.startsWith('soccer_') ? 'football' : key.startsWith('basketball_') ? 'basketball' : key.startsWith('tennis_') ? 'tennis' : null);
const BOOK_ALIAS = { betfair_ex_eu: 'betfair_ex_eu', betfair_ex_uk: 'betfair_ex_uk' };

function quotaFrom(headers) {
  const r = headers.get('x-requests-remaining'), u = headers.get('x-requests-used'), l = headers.get('x-requests-last');
  return r == null ? null : { remaining: Number(r), used: Number(u), last: Number(l), at: new Date().toISOString() };
}

export async function listSports(key, signal) {
  const { body } = await getJSON(id, `${BASE}/sports/?apiKey=${encodeURIComponent(key)}`, { signal });
  return body;
}

/**
 * Descarga y normaliza cuotas.
 * @returns {{events: NormalizedEvent[], quota, calls, books}}
 */
export async function fetchOdds({ key, settings, signal, progress }) {
  const cfg = settings.providers.theoddsapi;
  const sports = await listSports(key, signal);
  const active = new Set(sports.filter((s) => s.active).map((s) => s.key));
  let wanted = cfg.sports.filter((k) => active.has(k));
  if (cfg.includeActiveTennis) wanted = wanted.concat(sports.filter((s) => s.active && s.group === 'Tennis' && !s.has_outrights).map((s) => s.key));
  wanted = [...new Set(wanted)];
  const skipped = cfg.sports.filter((k) => !active.has(k));
  const now = Date.now();
  const to = new Date(now + settings.horizonHours * 3600e3).toISOString().replace(/\.\d+Z$/, 'Z');
  const from = new Date(now).toISOString().replace(/\.\d+Z$/, 'Z');
  const events = []; let quota = null; const errors = []; const books = {};
  let i = 0;
  for (const sk of wanted) {
    if (signal?.aborted) break;
    progress?.(`The Odds API: ${sk} (${++i}/${wanted.length})`);
    const sport = sportOf(sk);
    // Mercados admitidos por deporte (en tenis los totales/hándicaps de juegos suelen no estar en la región EU)
    const markets = cfg.markets.filter((m) => sport !== 'tennis' || m === 'h2h' || m === 'totals' || m === 'spreads');
    const url = `${BASE}/sports/${sk}/odds/?apiKey=${encodeURIComponent(key)}&regions=${cfg.regions.join(',')}&markets=${markets.join(',')}&oddsFormat=decimal&dateFormat=iso&commenceTimeFrom=${from}&commenceTimeTo=${to}`;
    try {
      const { body, headers } = await getJSON(id, url, { signal });
      quota = quotaFrom(headers) || quota;
      for (const ev of body) {
        const n = normalizeEvent(ev, sport, books);
        if (n) events.push(n);
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      errors.push(e.message);
      if (e.status === 401 || e.status === 429) break; // clave inválida o cuota agotada
    }
  }
  return { events, quota, errors, books, sportsQueried: wanted, sportsInactive: skipped };
}

export function normalizeEvent(ev, sport, books = {}) {
  if (!sport || !ev.home_team || !ev.away_team) return null;
  const out = {
    provider: id, providerEventId: ev.id, sport, competition: ev.sport_title, competitionKey: ev.sport_key,
    home: ev.home_team, away: ev.away_team, commence: ev.commence_time, markets: {},
  };
  for (const bm of ev.bookmakers || []) {
    const book = BOOK_ALIAS[bm.key] || bm.key;
    books[book] = bm.title;
    for (const mk of bm.markets || []) {
      const updatedAt = mk.last_update || bm.last_update;
      const add = (key, type, line, sels, sel, price) => {
        const m = (out.markets[key] ||= { key, type, line, sels, quotes: {}, semanticsVerified: true });
        (m.quotes[book] ||= {})[sel] = { price, updatedAt, provider: id };
      };
      if (mk.key === 'h2h') {
        const hasDraw = mk.outcomes.some((o) => o.name === 'Draw');
        for (const o of mk.outcomes) {
          const sel = o.name === ev.home_team ? 'home' : o.name === ev.away_team ? 'away' : o.name === 'Draw' ? 'draw' : null;
          if (!sel) continue;
          if (hasDraw) add('h2h3', 'h2h3', null, ['home', 'draw', 'away'], sel, o.price);
          else add('h2h', 'h2h', null, ['home', 'away'], sel, o.price);
        }
      } else if (mk.key === 'spreads') {
        const h = mk.outcomes.find((o) => o.name === ev.home_team), a = mk.outcomes.find((o) => o.name === ev.away_team);
        if (!h || !a || h.point == null || Math.abs(h.point + a.point) > 1e-9) continue; // líneas incoherentes
        const type = sport === 'football' ? 'ah' : 'spread';
        const key = `${type}:${h.point}`;
        add(key, type, h.point, ['home', 'away'], 'home', h.price);
        add(key, type, h.point, ['home', 'away'], 'away', a.price);
      } else if (mk.key === 'totals') {
        const ov = mk.outcomes.find((o) => o.name === 'Over'), un = mk.outcomes.find((o) => o.name === 'Under');
        if (!ov || !un || ov.point !== un.point) continue;
        const key = `totals:${ov.point}`;
        add(key, 'totals', ov.point, ['over', 'under'], 'over', ov.price);
        add(key, 'totals', ov.point, ['over', 'under'], 'under', un.price);
      } else if (mk.key === 'btts') {
        for (const o of mk.outcomes) { const sel = o.name === 'Yes' ? 'yes' : o.name === 'No' ? 'no' : null; if (sel) add('btts', 'btts', null, ['yes', 'no'], sel, o.price); }
      } else if (mk.key === 'draw_no_bet') {
        for (const o of mk.outcomes) { const sel = o.name === ev.home_team ? 'home' : o.name === ev.away_team ? 'away' : null; if (sel) add('dnb', 'dnb', null, ['home', 'away'], sel, o.price); }
      }
    }
  }
  return out;
}
