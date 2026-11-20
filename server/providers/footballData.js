// Fuente estadística: football-data.co.uk — resultados, goles y xG de la temporada actual
// (CSV públicos y gratuitos). Alimenta el modelo de Poisson independiente y el Elo.
// Sólo ligas domésticas: las competiciones europeas no tienen modelo propio (se usa el mercado).

import { getText } from '../http.js';
import { cacheGet, cacheSet } from '../store.js';
import { teamRatings, predictLambdas, scoreMatrix } from '../../shared/engine/poisson.js';
import { eloRatings, elo1X2 } from '../../shared/engine/elo.js';
import { bestMatch } from '../../shared/engine/names.js';

export const id = 'footballdata';
export const label = 'football-data.co.uk';

// Claves de competición (The Odds API) → código de división de football-data.
export const LEAGUES = {
  soccer_epl: 'E0', soccer_efl_champ: 'E1', soccer_spain_la_liga: 'SP1', soccer_spain_segunda_division: 'SP2',
  soccer_italy_serie_a: 'I1', soccer_italy_serie_b: 'I2', soccer_germany_bundesliga: 'D1', soccer_germany_bundesliga2: 'D2',
  soccer_france_ligue_one: 'F1', soccer_france_ligue_two: 'F2', soccer_netherlands_eredivisie: 'N1', soccer_portugal_primeira_liga: 'P1',
  soccer_belgium_first_div: 'B1', soccer_turkey_super_league: 'T1', soccer_greece_super_league: 'G1', soccer_spl: 'SC0',
};
// Nombres de torneo (OddsPapi u otros) → división, por coincidencia de texto.
const NAME_RULES = [
  [/laliga(?! 2)|la liga(?! 2)|primera division/i, /spain|espa/i, 'SP1'], [/laliga 2|segunda/i, /spain|espa/i, 'SP2'],
  [/premier league/i, /england/i, 'E0'], [/championship/i, /england/i, 'E1'],
  [/serie a/i, /italy|ital/i, 'I1'], [/bundesliga(?! 2)/i, /germany|aleman/i, 'D1'], [/ligue 1/i, /france|fran/i, 'F1'],
  [/eredivisie/i, /./, 'N1'], [/primeira|liga portugal/i, /./, 'P1'],
];

export function divisionFor(event) {
  if (LEAGUES[event.competitionKey]) return LEAGUES[event.competitionKey];
  for (const [re, cat, div] of NAME_RULES) if (re.test(event.competition || '') && cat.test(event.competition || '')) return div;
  return null;
}

function seasonCode(d = new Date()) {
  const y = d.getUTCFullYear() % 100, m = d.getUTCMonth() + 1;
  const start = m >= 7 ? y : y - 1;
  return `${String(start).padStart(2, '0')}${String(start + 1).padStart(2, '0')}`;
}

export function parseCSV(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const head = lines.shift().split(',');
  const idx = (n) => head.indexOf(n);
  const iD = idx('Date'), iH = idx('HomeTeam'), iA = idx('AwayTeam'), iHG = idx('FTHG'), iAG = idx('FTAG'), iHX = idx('HxG'), iAX = idx('AxG');
  const out = [];
  for (const l of lines) {
    const c = l.split(',');
    if (!c[iH] || c[iHG] === '' || c[iHG] == null) continue;
    const [dd, mm, yy] = c[iD].split('/');
    const year = yy.length === 2 ? 2000 + Number(yy) : Number(yy);
    const num = (i) => (i >= 0 && c[i] !== '' && c[i] != null ? Number(c[i]) : null);
    out.push({ date: new Date(Date.UTC(year, Number(mm) - 1, Number(dd))), home: c[iH], away: c[iA], hg: Number(c[iHG]), ag: Number(c[iAG]), hxg: num(iHX), axg: num(iAX) });
  }
  return out;
}

async function loadDivision(div, signal) {
  const season = seasonCode();
  const name = `fd-${season}-${div}.json`;
  const cached = cacheGet(name, 12 * 3600e3);
  if (cached) return cached.map((m) => ({ ...m, date: new Date(m.date) }));
  let matches = parseCSV(await getText(id, `https://www.football-data.co.uk/mmz4281/${season}/${div}.csv`, { signal }));
  // Al inicio de temporada se complementa con la anterior (ponderada por antigüedad en el modelo).
  if (matches.length < 80) {
    const y = Number(season.slice(0, 2)) - 1;
    const prev = `${String(y).padStart(2, '0')}${String(y + 1).padStart(2, '0')}`;
    try { matches = parseCSV(await getText(id, `https://www.football-data.co.uk/mmz4281/${prev}/${div}.csv`, { signal })).concat(matches); } catch { /* opcional */ }
  }
  cacheSet(name, matches);
  return matches;
}

/**
 * Prepara modelos para los eventos de fútbol. Devuelve una función event → statModel | null.
 */
export async function prepareModels(events, { signal, progress, errors }) {
  const divs = new Set(events.filter((e) => e.sport === 'football').map(divisionFor).filter(Boolean));
  const models = {};
  for (const div of divs) {
    if (signal?.aborted) break;
    progress?.(`football-data.co.uk: resultados ${div}`);
    try {
      const matches = await loadDivision(div, signal);
      const ratings = teamRatings(matches, { asOf: new Date() });
      const elo = eloRatings(matches);
      models[div] = { ratings, elo, teams: Object.keys(ratings?.teams || {}), n: matches.length, lastDate: matches.length ? matches[matches.length - 1].date : null };
    } catch (e) { errors.push(`football-data ${div}: ${e.message}`); }
  }
  return (event) => {
    const div = divisionFor(event);
    const M = div && models[div];
    if (!M?.ratings) return null;
    const h = bestMatch(event.home, M.teams), a = bestMatch(event.away, M.teams);
    if (!h || !a || h.name === a.name) return { unmatched: true, division: div, detail: `Equipos no identificados en football-data (${event.home} → ${h?.name ?? '—'}, ${event.away} → ${a?.name ?? '—'})` };
    const lam = predictLambdas(M.ratings, h.name, a.name);
    if (!lam) return null;
    const quality = lam.nHome >= 6 && lam.nAway >= 6 ? 'ok' : 'baja';
    const elo = elo1X2(M.elo, h.name, a.name);
    return {
      matrix: scoreMatrix(lam.home, lam.away), lambdas: lam, quality, division: div,
      source: `Poisson (ataque/defensa con goles y xG, ponderado por recencia) · football-data.co.uk ${div}`,
      details: {
        teams: { home: h.name, away: a.name, matchScore: [h.score, a.score] },
        lambdaHome: lam.home, lambdaAway: lam.away, matchesHome: lam.nHome, matchesAway: lam.nAway, leagueMatches: M.n,
        lastResult: M.lastDate, elo,
      },
    };
  };
}
