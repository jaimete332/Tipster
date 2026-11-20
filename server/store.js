// Persistencia local en JSON (carpeta data/, excluida de git).
// - data/state.json   : configuración, bankroll, apuestas, historial de oportunidades, cuotas.
// - data/secrets.json : claves y credenciales (permisos 600). Nunca se envían al navegador.
// - data/cache/       : catálogos y resultados históricos descargados.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.TIPSTER_DATA_DIR || path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const SECRETS_FILE = path.join(DATA_DIR, 'secrets.json');
export const CACHE_DIR = path.join(DATA_DIR, 'cache');

fs.mkdirSync(CACHE_DIR, { recursive: true });

export const DEFAULT_SETTINGS = {
  // Bankroll
  kellyFraction: 0.25,
  maxStakePct: 2,
  maxExposurePct: 5,
  maxEventPct: 2,
  minStake: 0,
  strategy: 'kelly', // kelly | flat
  flatStakePct: 1,
  // Motor
  targetBooks: ['betfair_es', 'matchbook'],
  // Comisión sobre ganancias netas de cada exchange (%). Se descuenta de la cuota antes de calcular EV y stake.
  commissions: { betfair_es: 5, matchbook: 4 },
  minLiquidity: 10,
  minEV: 0.02,
  staleMinutes: 20,
  devigMethod: 'power',
  minRefBooks: 3,
  modelWeight: 0.2,
  errorThresholdPct: 15,
  diffThresholdPct: 5,
  staleGapMinutes: 10,
  minOdds: 1.3,
  maxOdds: 8,
  exceptionalEV: 0.12,
  // Escaneo
  horizonHours: 48,
  refreshSeconds: 300,
  providers: {
    theoddsapi: {
      enabled: true,
      regions: ['eu'],
      markets: ['h2h', 'totals', 'spreads'],
      sports: [
        'soccer_spain_la_liga', 'soccer_epl', 'soccer_italy_serie_a', 'soccer_germany_bundesliga', 'soccer_france_ligue_one',
        'soccer_uefa_champs_league', 'soccer_uefa_europa_league', 'basketball_nba', 'basketball_euroleague',
      ],
      includeActiveTennis: true,
    },
    matchbook: { enabled: true, sports: [15, 4, 9], maxPages: 6, minLiquidity: 5 },
    betfair: { enabled: true, eventTypes: [1, 7522, 2], maxMarketsPerType: 300, minLiquidity: 5 },
    footballdata: { enabled: true },
  },
};

const DEFAULT_STATE = () => ({
  version: 1,
  settings: structuredClone(DEFAULT_SETTINGS),
  bankroll: { initial: 0, startedAt: new Date().toISOString(), transactions: [] },
  bets: [],
  opportunityLog: [],
  oddsHistory: {},
  lastScan: null,
  errors: [],
  quota: {},
});

function deepMerge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) out[k] = typeof v === 'object' && v && !Array.isArray(v) && typeof base[k] === 'object' && !Array.isArray(base[k]) ? deepMerge(base[k], v) : v;
  return out;
}

let state = null;
export function loadState() {
  if (state) return state;
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state = deepMerge(DEFAULT_STATE(), raw);
    state.settings = deepMerge(structuredClone(DEFAULT_SETTINGS), raw.settings || {});
    // Migración: las casas objetivo pasan a ser exchanges con API oficial (Betfair ES y Matchbook).
    if (!state.settings.targetBooks.some((b) => b === 'betfair_es' || b === 'matchbook')) state.settings.targetBooks = [...DEFAULT_SETTINGS.targetBooks];
    delete state.settings.providers.oddspapi;
  } catch { state = DEFAULT_STATE(); }
  return state;
}

let saveTimer = null;
export function saveState(now = false) {
  const write = () => {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATE_FILE);
  };
  if (now) { clearTimeout(saveTimer); write(); return; }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(write, 300);
}

export function replaceState(next) {
  state = deepMerge(DEFAULT_STATE(), next);
  state.settings = deepMerge(structuredClone(DEFAULT_SETTINGS), next.settings || {});
  saveState(true);
}

export function logError(source, message) {
  const s = loadState();
  s.errors.unshift({ at: new Date().toISOString(), source, message: String(message).slice(0, 500) });
  s.errors = s.errors.slice(0, 200);
  saveState();
}

// --- Secretos -----------------------------------------------------------------
const ENV_KEYS = { theoddsapi: 'THE_ODDS_API_KEY', betfair_appkey: 'BETFAIR_APP_KEY', betfair_username: 'BETFAIR_USERNAME', betfair_password: 'BETFAIR_PASSWORD' };
function readSecrets() { try { return JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8')); } catch { return {}; } }
export function getKey(provider) { return process.env[ENV_KEYS[provider]] || readSecrets()[provider] || null; }
export function setKey(provider, value) {
  if (!ENV_KEYS[provider]) throw new Error('Proveedor desconocido');
  const s = readSecrets();
  if (value) s[provider] = String(value).trim(); else delete s[provider];
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(s), { mode: 0o600 });
  try { fs.chmodSync(SECRETS_FILE, 0o600); } catch { /* sistemas sin chmod */ }
}
export function keyStatus() {
  const out = {};
  for (const p of Object.keys(ENV_KEYS)) {
    const k = getKey(p);
    out[p] = { configured: !!k, source: process.env[ENV_KEYS[p]] ? 'variable de entorno' : k ? 'data/secrets.json' : null, hint: k ? (p === 'betfair_username' ? `${k.slice(0, 2)}…` : p === 'betfair_password' ? '••••' : `…${k.slice(-4)}`) : null };
  }
  return out;
}

// --- Caché en disco ---------------------------------------------------------------
export function cacheGet(name, maxAgeMs) {
  const f = path.join(CACHE_DIR, name);
  try { const st = fs.statSync(f); if (Date.now() - st.mtimeMs > maxAgeMs) return null; return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}
export function cacheSet(name, value) { fs.writeFileSync(path.join(CACHE_DIR, name), JSON.stringify(value)); }
