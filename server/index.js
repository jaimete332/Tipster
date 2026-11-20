// Servidor local: sirve la interfaz y expone una API JSON.
// Las claves API viven sólo aquí (variables de entorno o data/secrets.json) y nunca se envían al navegador.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadState, saveState, replaceState, setKey, keyStatus, logError, DEFAULT_SETTINGS } from './store.js';
import { runScan, stopScan, progress } from './scanner.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';

function loadDotEnv() {
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* sin .env */ }
}

const STATIC = { '/': 'public/index.html' };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
async function readBody(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 10e6) throw new Error('Cuerpo demasiado grande'); }
  return raw ? JSON.parse(raw) : {};
}

function publicState() {
  const s = loadState();
  return {
    settings: s.settings, bankroll: s.bankroll, bets: s.bets, opportunityLog: s.opportunityLog, errors: s.errors.slice(0, 100),
    lastScan: s.lastScan, quota: s.quota, keys: keyStatus(), progress, oddsHistoryKeys: Object.keys(s.oddsHistory).length,
  };
}

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function sanitizeSettings(inc, cur) {
  const s = { ...cur, ...inc, providers: { ...cur.providers, ...(inc.providers || {}) } };
  s.kellyFraction = clamp(num(s.kellyFraction, 0.25), 0, 1);
  s.maxStakePct = clamp(num(s.maxStakePct, 2), 0, 100);
  s.maxExposurePct = clamp(num(s.maxExposurePct, 5), 0, 100);
  s.maxEventPct = clamp(num(s.maxEventPct, s.maxStakePct), 0, 100);
  s.minEV = clamp(num(s.minEV, 0.02), 0, 1);
  s.staleMinutes = clamp(num(s.staleMinutes, 20), 1, 1440);
  s.refreshSeconds = clamp(num(s.refreshSeconds, 300), 60, 3600);
  s.horizonHours = clamp(num(s.horizonHours, 48), 1, 240);
  s.minRefBooks = clamp(Math.round(num(s.minRefBooks, 3)), 2, 20);
  s.modelWeight = clamp(num(s.modelWeight, 0.2), 0, 0.5);
  if (!Array.isArray(s.targetBooks) || !s.targetBooks.length) s.targetBooks = DEFAULT_SETTINGS.targetBooks;
  s.commissions = { ...cur.commissions, ...(inc.commissions || {}) };
  for (const k of Object.keys(s.commissions)) s.commissions[k] = clamp(num(s.commissions[k], 5), 0, 50);
  s.minLiquidity = clamp(num(s.minLiquidity, 10), 0, 100000);
  return s;
}

const routes = {
  'GET /api/state': () => publicState(),
  'GET /api/progress': () => progress,
  'POST /api/scan': async (req, res) => {
    // Si el usuario cierra la conexión o pulsa DETENER, se cancelan las consultas.
    res.on('close', () => { if (!res.writableFinished) stopScan(); });
    try { const scan = await runScan(); return { ok: true, scan }; }
    catch (e) { return { ok: false, error: e.message, progress }; }
  },
  'POST /api/scan/stop': () => stopScan(),
  'PUT /api/settings': async (req) => {
    const s = loadState();
    s.settings = sanitizeSettings(await readBody(req), s.settings);
    saveState(true); return { ok: true, settings: s.settings };
  },
  'PUT /api/bankroll': async (req) => {
    const b = await readBody(req); const s = loadState();
    if (b.initial != null) { s.bankroll.initial = Math.max(0, num(b.initial, 0)); if (!s.bankroll.startedAt) s.bankroll.startedAt = new Date().toISOString(); }
    saveState(true); return { ok: true, bankroll: s.bankroll };
  },
  'POST /api/bankroll/tx': async (req) => {
    const b = await readBody(req); const s = loadState();
    if (!['deposit', 'withdraw', 'adjust'].includes(b.type)) throw new Error('Tipo de movimiento no válido');
    const amount = num(b.amount, NaN);
    if (!Number.isFinite(amount) || (b.type !== 'adjust' && amount <= 0)) throw new Error('Importe no válido');
    s.bankroll.transactions.push({ id: crypto.randomUUID(), type: b.type, amount, note: String(b.note || '').slice(0, 200), date: b.date || new Date().toISOString() });
    saveState(true); return { ok: true, bankroll: s.bankroll };
  },
  'POST /api/bets': async (req) => {
    const b = await readBody(req); const s = loadState();
    const odds = num(b.odds, NaN), stake = num(b.stake, NaN);
    if (!(odds > 1) || !(stake > 0)) throw new Error('Cuota y stake deben ser válidos');
    const bet = {
      id: crypto.randomUUID(), createdAt: new Date().toISOString(), kind: b.kind === 'simulada' ? 'simulada' : 'real',
      opportunityId: b.opportunityId || null, eventId: b.eventId || null, marketKey: b.marketKey || null, sel: b.sel || null, eventStart: b.eventStart || null,
      sport: b.sport || '', competition: b.competition || '', event: String(b.event || '').slice(0, 200), market: String(b.market || '').slice(0, 120), marketGroup: b.marketGroup || '',
      selection: String(b.selection || '').slice(0, 200), book: String(b.book || '').slice(0, 60), odds, stake,
      pAtBet: Number.isFinite(b.pAtBet) ? b.pAtBet : null, evAtBet: Number.isFinite(b.evAtBet) ? b.evAtBet : null,
      recommendedStake: Number.isFinite(b.recommendedStake) ? b.recommendedStake : null,
      closingOdds: b.closingOdds ? num(b.closingOdds, null) : null, result: 'pendiente', settledAt: null, note: String(b.note || '').slice(0, 300),
    };
    s.bets.push(bet); saveState(true); return { ok: true, bet };
  },
  'PATCH /api/bets/:id': async (req, _res, id) => {
    const b = await readBody(req); const s = loadState();
    const bet = s.bets.find((x) => x.id === id);
    if (!bet) throw new Error('Apuesta no encontrada');
    if (b.result) {
      if (!['pendiente', 'ganada', 'perdida', 'anulada', 'media_ganada', 'media_perdida'].includes(b.result)) throw new Error('Resultado no válido');
      bet.result = b.result; bet.settledAt = b.result === 'pendiente' ? null : new Date().toISOString();
    }
    if (b.closingOdds !== undefined) { bet.closingOdds = b.closingOdds ? num(b.closingOdds, null) : null; bet.closingSource = 'manual'; }
    if (b.odds) bet.odds = num(b.odds, bet.odds);
    if (b.stake) bet.stake = num(b.stake, bet.stake);
    if (b.note !== undefined) bet.note = String(b.note).slice(0, 300);
    saveState(true); return { ok: true, bet };
  },
  'DELETE /api/bets/:id': (req, _res, id) => {
    const s = loadState(); s.bets = s.bets.filter((x) => x.id !== id); saveState(true); return { ok: true };
  },
  'GET /api/history/:key': (req, _res, key) => {
    const s = loadState(); return s.oddsHistory[decodeURIComponent(key)] || { points: [] };
  },
  'PUT /api/keys': async (req) => {
    const b = await readBody(req);
    for (const p of ['theoddsapi', 'betfair_appkey', 'betfair_username', 'betfair_password']) if (b[p] !== undefined) setKey(p, b[p]);
    return { ok: true, keys: keyStatus() };
  },
  'GET /api/export': () => { const s = loadState(); const { oddsHistory, ...rest } = s; return rest; },
  'POST /api/import': async (req) => {
    const b = await readBody(req);
    if (!b || typeof b !== 'object' || !b.settings) throw new Error('Archivo de copia no válido');
    const cur = loadState();
    replaceState({ ...b, oddsHistory: cur.oddsHistory });
    return { ok: true };
  },
  'DELETE /api/errors': () => { const s = loadState(); s.errors = []; saveState(true); return { ok: true }; },
};

function match(method, url) {
  for (const [k, fn] of Object.entries(routes)) {
    const [m, pattern] = k.split(' ');
    if (m !== method) continue;
    if (pattern === url) return [fn, null];
    if (pattern.endsWith('/:id') || pattern.endsWith('/:key')) {
      const base = pattern.slice(0, pattern.lastIndexOf('/') + 1);
      if (url.startsWith(base) && url.length > base.length && !url.slice(base.length).includes('/')) return [fn, url.slice(base.length)];
    }
  }
  return [null, null];
}

function serveStatic(req, res, pathname) {
  let rel = STATIC[pathname] || pathname.slice(1);
  if (!(rel.startsWith('public/') || rel.startsWith('shared/'))) rel = 'public/' + rel;
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(path.join(ROOT, 'public')) && !file.startsWith(path.join(ROOT, 'shared'))) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('No encontrado'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);
  // Protección CSRF básica: sólo peticiones del mismo origen pueden modificar datos.
  if (req.method !== 'GET' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return send(res, 403, { error: 'Origen no permitido' });
  const [fn, param] = match(req.method, pathname);
  if (!fn) return send(res, 404, { error: 'Ruta no encontrada' });
  try {
    const out = await fn(req, res, param);
    if (!res.writableEnded) send(res, 200, out);
  } catch (e) {
    logError('api', `${req.method} ${pathname}: ${e.message}`);
    if (!res.writableEnded) send(res, 400, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Tipster Inteligente Pro escuchando en http://${HOST}:${PORT}`);
  console.log('Estado: INACTIVO — no se realizará ninguna consulta hasta pulsar «INICIAR ANÁLISIS».');
});
