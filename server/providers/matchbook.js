// Casa objetivo: Matchbook Exchange — API oficial (https://developers.matchbook.com).
// La lectura de eventos y precios no requiere login (endpoints con "security": []).
// Límites por defecto: 700 peticiones/min al grupo Events. Coste: 100 GBP por cada millón de GET al mes
// (cargado en la cuenta de Matchbook), es decir, prácticamente gratis al ritmo de esta herramienta.
// Se usa el mejor precio "back" disponible (lo que tú puedes apostar a favor) y su liquidez.

import { getJSON, sleep } from '../http.js';

const BASE = 'https://api.matchbook.com/edge/rest';
export const id = 'matchbook';
export const label = 'Matchbook (API oficial)';
export const SPORTS = { 15: 'football', 4: 'basketball', 9: 'tennis' };
const BOOK = 'matchbook';

/** Hándicap asiático de cuarto en notación de Matchbook: "(+0.5/1.0)" → +0.75, "(-0.0/0.5)" → -0.25. */
export function parseSplitLine(name) {
  const m = String(name).match(/\(([+-])(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\)\s*$/);
  if (!m) return null;
  const v = (Number(m[2]) + Number(m[3])) / 2;
  return m[1] === '-' ? -v : v;
}

/** "A vs B" → local A; "A at B" (formato EE. UU.) → local B. */
export function parseTeams(name) {
  let m = String(name).match(/^(.*?)\s+(?:vs\.?|v)\s+(.*)$/i);
  if (m) return { home: m[1].trim(), away: m[2].trim() };
  m = String(name).match(/^(.*?)\s+at\s+(.*)$/i);
  if (m) return { home: m[2].trim(), away: m[1].trim() };
  return null;
}

function bestBack(runner, minLiquidity) {
  const backs = (runner.prices || []).filter((p) => p.side === 'back' && p['decimal-odds'] > 1 && p['available-amount'] >= minLiquidity);
  if (!backs.length) return null;
  return backs.reduce((a, b) => (b['decimal-odds'] > a['decimal-odds'] ? b : a));
}

const startsWithName = (runnerName, team) => runnerName.toLowerCase().startsWith(team.toLowerCase());

export function normalizeEvent(e, minLiquidity = 5, fetchedAt = new Date().toISOString()) {
  const sport = SPORTS[e['sport-id']];
  const teams = parseTeams(e.name);
  if (!sport || !teams) return null;
  const tags = (e['meta-tags'] || []).filter((t) => !['SPORT', 'DATE', 'COUNTRY'].includes(t.type) && !/live betting/i.test(t.name));
  const out = { provider: id, providerEventId: String(e.id), sport, competition: tags[tags.length - 1]?.name || 'Matchbook', competitionKey: null, home: teams.home, away: teams.away, commence: e.start, markets: {} };
  const add = (key, type, line, sels, sel, p, extra = {}) => {
    const m = (out.markets[key] ||= { key, type, line, sels, quotes: {}, semanticsVerified: true, ...extra });
    (m.quotes[BOOK] ||= {})[sel] = { price: p['decimal-odds'], size: p['available-amount'], updatedAt: fetchedAt, changedAt: null, provider: id };
  };
  for (const m of e.markets || []) {
    if (m.status !== 'open') continue;
    const rs = m.runners || [];
    const home = rs.find((r) => startsWithName(r.name, teams.home));
    const away = rs.find((r) => startsWithName(r.name, teams.away));
    if (m.name === 'Match Odds' && m['market-type'] === 'one_x_two') {
      const draw = rs.find((r) => /^draw$/i.test(r.name));
      if (!home || !away || !draw) continue;
      for (const [sel, r] of [['home', home], ['draw', draw], ['away', away]]) { const p = bestBack(r, minLiquidity); if (p) add('h2h3', 'h2h3', null, ['home', 'draw', 'away'], sel, p); }
    } else if (m.name === 'Moneyline' && m['market-type'] === 'money_line') {
      if (!home || !away) continue;
      for (const [sel, r] of [['home', home], ['away', away]]) { const p = bestBack(r, minLiquidity); if (p) add('h2h', 'h2h', null, ['home', 'away'], sel, p); }
    } else if (m.name === 'Total' && m['market-type'] === 'total') {
      const ov = rs.find((r) => /^over /i.test(r.name)), un = rs.find((r) => /^under /i.test(r.name));
      if (!ov || !un || ov.handicap == null || ov.handicap !== un.handicap) continue;
      const key = `totals:${ov.handicap}`;
      for (const [sel, r] of [['over', ov], ['under', un]]) { const p = bestBack(r, minLiquidity); if (p) add(key, 'totals', ov.handicap, ['over', 'under'], sel, p); }
    } else if (m.name === 'Handicap' && m['market-type'] === 'handicap') {
      if (!home || !away) continue;
      const line = home.handicap != null ? Number(home.handicap) : parseSplitLine(home.name);
      const awayLine = away.handicap != null ? Number(away.handicap) : parseSplitLine(away.name);
      if (line == null || awayLine == null || Math.abs(line + awayLine) > 1e-9) continue; // líneas incoherentes → descartar
      const type = sport === 'football' ? 'ah' : 'spread';
      const key = `${type}:${line}`;
      for (const [sel, r] of [['home', home], ['away', away]]) { const p = bestBack(r, minLiquidity); if (p) add(key, type, line, ['home', 'away'], sel, p); }
    } else if (m.name === 'Both Teams To Score' && m['market-type'] === 'both_to_score') {
      for (const r of rs) { const sel = /^yes$/i.test(r.name) ? 'yes' : /^no$/i.test(r.name) ? 'no' : null; const p = sel && bestBack(r, minLiquidity); if (p) add('btts', 'btts', null, ['yes', 'no'], sel, p); }
    } else if (m.name === 'Double Chance') {
      for (const r of rs) {
        const n = r.name.toLowerCase(); const h = teams.home.toLowerCase(), a = teams.away.toLowerCase();
        const sel = n === `${h} or draw` ? '1X' : n === `draw or ${a}` ? 'X2' : n === `${h} or ${a}` ? '12' : null;
        const p = sel && bestBack(r, minLiquidity); if (p) add('dc', 'dc', null, ['1X', '12', 'X2'], sel, p);
      }
    } else if (m.name === 'Draw No Bet') {
      if (!home || !away) continue;
      for (const [sel, r] of [['home', home], ['away', away]]) { const p = bestBack(r, minLiquidity); if (p) add('dnb', 'dnb', null, ['home', 'away'], sel, p); }
    }
  }
  return out;
}

export async function fetchOdds({ settings, signal, progress }) {
  const cfg = settings.providers.matchbook;
  const after = Math.floor(Date.now() / 1000) + 60; // sólo pre-partido
  const before = Math.floor(Date.now() / 1000 + settings.horizonHours * 3600);
  const events = []; const errors = [];
  for (const sid of cfg.sports) {
    let offset = 0;
    for (let page = 0; page < cfg.maxPages; page++) {
      if (signal?.aborted) break;
      progress?.(`Matchbook: ${SPORTS[sid] || sid} (página ${page + 1})`);
      const url = `${BASE}/events?sport-ids=${sid}&states=open&after=${after}&before=${before}&include-prices=true&price-depth=1&odds-type=DECIMAL&exchange-type=back-lay&currency=EUR&per-page=50&offset=${offset}`;
      try {
        const { body } = await getJSON(id, url, { signal });
        for (const e of body.events || []) { const n = normalizeEvent(e, cfg.minLiquidity); if (n && Object.keys(n.markets).length) events.push(n); }
        offset += body['per-page'] || 50;
        if (offset >= (body.total || 0)) break;
      } catch (e) { if (signal?.aborted) throw e; errors.push(e.message); break; }
      await sleep(250, signal);
    }
  }
  return { events, errors, books: { [BOOK]: 'Matchbook' }, quota: null };
}
