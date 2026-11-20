// Pruebas de normalización de proveedores con cargas con la forma documentada de cada API.
// Los precios son sintéticos y sólo existen en esta prueba.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvent } from '../server/providers/theOddsApi.js';
import { normalizeOdds, mapMarket, canonicalBook } from '../server/providers/oddsPapi.js';
import { parseCSV, divisionFor } from '../server/providers/footballData.js';
import { mergeEvents } from '../server/scanner.js';
import { evaluateEvent } from '../shared/engine/value.js';

const now = new Date().toISOString();
const start = new Date(Date.now() + 26 * 3600e3).toISOString();
const bm = (key, h, d, a, ah, ov) => ({
  key, title: key, last_update: now,
  markets: [
    { key: 'h2h', last_update: now, outcomes: [{ name: 'Real Betis', price: h }, { name: 'Draw', price: d }, { name: 'Athletic Bilbao', price: a }] },
    { key: 'spreads', last_update: now, outcomes: [{ name: 'Real Betis', price: ah[0], point: -0.25 }, { name: 'Athletic Bilbao', price: ah[1], point: 0.25 }] },
    { key: 'totals', last_update: now, outcomes: [{ name: 'Over', price: ov[0], point: 2.5 }, { name: 'Under', price: ov[1], point: 2.5 }] },
  ],
});
const toaEvent = {
  id: 'abc123', sport_key: 'soccer_spain_la_liga', sport_title: 'La Liga - Spain', commence_time: start, home_team: 'Real Betis', away_team: 'Athletic Bilbao',
  bookmakers: [
    bm('pinnacle', 2.45, 3.3, 3.05, [1.98, 1.94], [2.1, 1.8]),
    bm('betfair_ex_eu', 2.5, 3.35, 3.1, [2.0, 1.96], [2.14, 1.84]),
    bm('williamhill', 2.35, 3.2, 2.95, [1.92, 1.9], [2.05, 1.75]),
    bm('unibet_fr', 2.38, 3.25, 2.95, [1.93, 1.88], [2.05, 1.76]),
    bm('betsson', 2.4, 3.2, 3.0, [1.95, 1.87], [2.06, 1.77]),
    bm('winamax_fr', 2.42, 3.3, 3.0, [1.96, 1.9], [2.08, 1.78]),
  ],
};

test('The Odds API: normaliza 1X2, hándicap asiático y totales', () => {
  const ev = normalizeEvent(toaEvent, 'football');
  assert.equal(ev.markets.h2h3.sels.length, 3);
  assert.equal(ev.markets.h2h3.quotes.pinnacle.draw.price, 3.3);
  assert.equal(ev.markets['ah:-0.25'].quotes.winamax_fr.away.price, 1.9);
  assert.equal(ev.markets['totals:2.5'].quotes.betsson.under.price, 1.77);
});

const catalog = new Map([
  ['101', { marketId: 101, marketType: '1x2', period: 'fulltime', handicap: 0, playerProp: false, outcomes: [{ outcomeId: 101, outcomeName: '1' }, { outcomeId: 102, outcomeName: 'X' }, { outcomeId: 103, outcomeName: '2' }] }],
  ['104', { marketId: 104, marketType: 'bothteamsscore', period: 'fulltime', handicap: 0, playerProp: false, outcomes: [{ outcomeId: 104, outcomeName: 'Yes' }, { outcomeId: 105, outcomeName: 'No' }] }],
  ['106', { marketId: 106, marketType: 'totals', period: 'fulltime', handicap: 2.5, playerProp: false, outcomes: [{ outcomeId: 106, outcomeName: 'Over' }, { outcomeId: 107, outcomeName: 'Under' }] }],
  ['999', { marketId: 999, marketType: 'totals', period: '1sthalf', handicap: 1.5, playerProp: false, outcomes: [{ outcomeId: 1, outcomeName: 'Over' }, { outcomeId: 2, outcomeName: 'Under' }] }],
]);
const pl = (price) => ({ players: { 0: { active: true, price, changedAt: now, bookmakerChangedAt: now, limit: null } } });
const opOdds = {
  fixtureId: 'id1000', sportId: 10, tournamentName: 'LaLiga', categoryName: 'Spain', tournamentSlug: 'laliga', startTime: start,
  participant1Name: 'Real Betis Sevilla', participant2Name: 'Athletic Club', sportName: 'Soccer',
  bookmakerOdds: {
    bet365: { bookmakerIsActive: true, markets: { 101: { outcomes: { 101: pl(2.7), 102: pl(3.2), 103: pl(2.9) } }, 106: { outcomes: { 106: pl(2.0), 107: pl(1.8) } }, 999: { outcomes: { 1: pl(1.5), 2: pl(2.5) } } } },
    'winamax-es': { bookmakerIsActive: true, markets: { 101: { outcomes: { 101: pl(2.45), 102: pl(3.25), 103: pl(2.95) } } } },
    'pinnacle+30': { bookmakerIsActive: true, markets: { 101: { outcomes: { 101: pl(2.46), 102: pl(3.3), 103: pl(3.04) } } } },
  },
};

test('OddsPapi: slugs canónicos, catálogo de mercados y periodo', () => {
  assert.equal(canonicalBook('pinnacle+30'), 'pinnacle');
  assert.equal(canonicalBook('winamax-es'), 'winamax_es');
  assert.equal(canonicalBook('bet365'), 'bet365');
  assert.equal(mapMarket(catalog.get('999'), 'football'), null, 'primera parte no se mezcla con partido completo');
  const ev = normalizeOdds(opOdds, catalog);
  assert.equal(ev.markets.h2h3.quotes.bet365.home.price, 2.7);
  assert.equal(ev.markets.h2h3.quotes.pinnacle.away.price, 3.04);
  assert.equal(ev.markets['totals:2.5'].quotes.bet365.over.price, 2.0);
  assert.equal(Object.keys(ev.markets).length, 2);
});

test('Fusión entre proveedores y detección de valor en bet365', () => {
  const a = normalizeEvent(toaEvent, 'football');
  const b = normalizeOdds(opOdds, catalog);
  const merged = mergeEvents([[a], [b]]);
  assert.equal(merged.length, 1, 'el mismo partido de dos proveedores debe fusionarse');
  const ev = merged[0];
  assert.ok(ev.markets.h2h3.quotes.bet365 && ev.markets.h2h3.quotes.williamhill);
  assert.equal(divisionFor(ev), 'SP1');
  const r = evaluateEvent(ev, { settings: {} });
  const o = r.opportunities.find((x) => x.book === 'bet365' && x.sel === 'home' && x.marketKey === 'h2h3');
  assert.ok(o, 'bet365 2.70 frente a justa ≈2.5 debería ser value');
  assert.ok(o.evTheoretical > 0.05);
  assert.ok(o.refBooks.every((x) => !x.book.startsWith('winamax') && x.book !== 'bet365'), 'las casas objetivo no son referencia');
  // Línea de cuarto valorada con Poisson ajustado al mercado
  assert.ok(r.marketModel && r.marketModel.home > 0);
  assert.ok(r.anomalies.some((x) => x.category === 'diferencia'), 'diferencia bet365/winamax ≥ 5%');
});

test('football-data: lectura del CSV', () => {
  const csv = '﻿Div,Date,Time,HomeTeam,AwayTeam,FTHG,FTAG,FTR,HxG,AxG\nSP1,15/08/2026,18:30,Alaves,Getafe,3,0,H,1.93,0.24\nSP1,16/08/2026,20:00,Betis,Ath Bilbao,,,,,\n';
  const m = parseCSV(csv);
  assert.equal(m.length, 1);
  assert.equal(m[0].hxg, 1.93);
  assert.equal(m[0].date.getUTCMonth(), 7);
});
