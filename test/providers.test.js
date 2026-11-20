// Pruebas de normalización de proveedores con cargas con la forma documentada de cada API.
// Los precios son sintéticos y sólo existen en esta prueba.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvent } from '../server/providers/theOddsApi.js';
import * as MB from '../server/providers/matchbook.js';
import * as BF from '../server/providers/betfair.js';
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

// Forma real de la respuesta de Matchbook /edge/rest/events (comprobada contra la API pública).
const mbPrice = (odds, side = 'back', amt = 100) => ({ 'available-amount': amt, currency: 'EUR', 'odds-type': 'DECIMAL', odds, 'decimal-odds': odds, side, 'exchange-type': 'back-lay' });
const mbRunner = (name, handicap, prices) => ({ name, handicap, prices, status: 'open' });
const mbEvent = {
  id: 349, name: 'Real Betis vs Athletic Bilbao', 'sport-id': 15, start,
  'meta-tags': [{ name: 'Soccer', type: 'SPORT' }, { name: 'Spain', type: 'COUNTRY' }, { name: 'Spanish La Liga', type: 'COMPETITION' }],
  markets: [
    { name: 'Match Odds', 'market-type': 'one_x_two', status: 'open', runners: [mbRunner('Real Betis', null, [mbPrice(2.7), mbPrice(2.76, 'lay')]), mbRunner('Athletic Bilbao', null, [mbPrice(3.0)]), mbRunner('Draw', null, [mbPrice(3.3)])] },
    { name: 'Total', 'market-type': 'total', status: 'open', runners: [mbRunner('OVER 2.5', 2.5, [mbPrice(2.1)]), mbRunner('UNDER 2.5', 2.5, [mbPrice(1.8, 'back', 2)])] },
    { name: '1st Half Total', 'market-type': 'total', status: 'open', runners: [mbRunner('OVER 1.5', 1.5, [mbPrice(3.7)]), mbRunner('UNDER 1.5', 1.5, [mbPrice(1.3)])] },
    { name: 'Handicap', 'market-type': 'handicap', status: 'open', runners: [mbRunner('Real Betis (-0.0/0.5)', null, [mbPrice(2.0)]), mbRunner('Athletic Bilbao (+0.0/0.5)', null, [mbPrice(1.9)])] },
    { name: 'Double Chance', 'market-type': 'other', status: 'open', runners: [mbRunner('Real Betis or Draw', null, [mbPrice(1.4)]), mbRunner('Real Betis or Athletic Bilbao', null, [mbPrice(1.3)]), mbRunner('Draw or Athletic Bilbao', null, [mbPrice(1.6)])] },
  ],
};

test('Matchbook: equipos, hándicap de cuarto, liquidez y exclusión de primera parte', () => {
  assert.deepEqual(MB.parseTeams('Phoenix Suns at Utah Jazz'), { home: 'Utah Jazz', away: 'Phoenix Suns' });
  assert.equal(MB.parseSplitLine('Deportivo Cali (+0.5/1.0)'), 0.75);
  assert.equal(MB.parseSplitLine('Millonarios (-0.0/0.5)'), -0.25);
  const ev = MB.normalizeEvent(mbEvent, 5);
  assert.equal(ev.competition, 'Spanish La Liga');
  assert.equal(ev.markets.h2h3.quotes.matchbook.home.price, 2.7, 'mejor precio back, no lay');
  assert.equal(ev.markets['totals:2.5'].quotes.matchbook.under, undefined, 'sin liquidez mínima no se usa');
  assert.ok(!ev.markets['totals:1.5'], 'la primera parte no se mezcla con el partido');
  assert.equal(ev.markets['ah:-0.25'].quotes.matchbook.away.price, 1.9);
  assert.equal(ev.markets.dc.quotes.matchbook['1X'].price, 1.4);
});

test('Betfair: catálogo + libro → mercados internos', () => {
  assert.deepEqual(BF.parseTeams('Celtics @ Knicks'), { home: 'Knicks', away: 'Celtics' });
  const cat = { marketId: '1.2', event: { id: '9', name: 'Real Betis v Athletic Bilbao', openDate: start }, runners: [{ selectionId: 1, runnerName: 'Real Betis' }, { selectionId: 2, runnerName: 'Athletic Bilbao' }, { selectionId: 3, runnerName: 'The Draw' }] };
  const book = { marketId: '1.2', status: 'OPEN', inplay: false, runners: [{ selectionId: 1, status: 'ACTIVE', ex: { availableToBack: [{ price: 2.72, size: 300 }] } }, { selectionId: 2, status: 'ACTIVE', ex: { availableToBack: [{ price: 3.0, size: 2 }] } }, { selectionId: 3, status: 'ACTIVE', ex: { availableToBack: [{ price: 3.35, size: 80 }] } }] };
  const m = BF.mapMarket(cat, book, 'MATCH_ODDS', 'football', 5, now);
  assert.equal(m.def.key, 'h2h3');
  assert.equal(m.quotes.home.price, 2.72);
  assert.equal(m.quotes.away, undefined, 'liquidez insuficiente');
  const ou = BF.mapMarket({ ...cat, runners: [{ selectionId: 4, runnerName: 'Under 2.5 Goals' }, { selectionId: 5, runnerName: 'Over 2.5 Goals' }] }, { runners: [{ selectionId: 4, status: 'ACTIVE', ex: { availableToBack: [{ price: 1.8, size: 50 }] } }, { selectionId: 5, status: 'ACTIVE', ex: { availableToBack: [{ price: 2.1, size: 50 }] } }] }, 'OVER_UNDER_25', 'football', 5, now);
  assert.equal(ou.def.key, 'totals:2.5');
  assert.equal(ou.quotes.over.price, 2.1);
});

test('Fusión entre proveedores y detección de valor en Matchbook (neta de comisión)', () => {
  const a = normalizeEvent(toaEvent, 'football');
  const b = MB.normalizeEvent(mbEvent, 5);
  const merged = mergeEvents([[a], [b]]);
  assert.equal(merged.length, 1, 'el mismo partido de dos proveedores debe fusionarse');
  const ev = merged[0];
  assert.ok(ev.markets.h2h3.quotes.matchbook && ev.markets.h2h3.quotes.williamhill);
  assert.equal(divisionFor(ev), 'SP1');
  const r = evaluateEvent(ev, { settings: {} });
  const o = r.opportunities.find((x) => x.book === 'matchbook' && x.sel === 'home' && x.marketKey === 'h2h3');
  assert.ok(o, 'Matchbook 2.70 (2.63 neta) frente a justa ≈2.48 debería ser value');
  assert.ok(Math.abs(o.price - (1 + 1.7 * 0.96)) < 1e-9);
  assert.ok(o.refBooks.every((x) => x.book !== 'matchbook'), 'la casa objetivo no es referencia de sí misma');
});

test('football-data: lectura del CSV', () => {
  const csv = '﻿Div,Date,Time,HomeTeam,AwayTeam,FTHG,FTAG,FTR,HxG,AxG\nSP1,15/08/2026,18:30,Alaves,Getafe,3,0,H,1.93,0.24\nSP1,16/08/2026,20:00,Betis,Ath Bilbao,,,,,\n';
  const m = parseCSV(csv);
  assert.equal(m.length, 1);
  assert.equal(m[0].hxg, 1.93);
  assert.equal(m[0].date.getUTCMonth(), 7);
});
