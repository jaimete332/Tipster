// Motor de detección: probabilidad de referencia sin margen, EV teórico y conservador,
// nivel de confianza, verificación, errores de cuota, diferencias entre casas y arbitrajes.

import { devig, mean, median, stdev, sum, isValidPrice, expectedValue, expectedValueDist, binaryDist, classifyEV, fairPriceFromDist, overround } from './odds.js';
import { scoreMatrix, matrix1X2, matrixBTTS, probOver, ahDist, totalDist, fitLambdas } from './poisson.js';
import { marketLabel, selectionLabel, MARKET_GROUP } from './names.js';

export const SHARP_BOOKS = new Set(['pinnacle', 'betfair_es', 'betfair_ex_eu', 'betfair_ex_uk', 'matchbook', 'smarkets', 'betfair']);
const EXCHANGES = /^(betfair|matchbook|smarkets)/;

/** Familia de una casa: dos claves de la misma casa (p. ej. betfair_es y betfair_ex_eu) nunca se usan como referencia mutua. */
export const bookFamily = (b) => (b.startsWith('betfair') ? 'betfair' : b.startsWith('matchbook') ? 'matchbook' : b.split('_')[0]);

/** Comisión (%) sobre ganancias netas: configurada por casa o, para exchanges no configurados, 5 %. */
export const commissionOf = (book, settings) => settings.commissions?.[book] ?? (EXCHANGES.test(book) ? 5 : 0);
/** Cuota neta de comisión: 1 + (cuota − 1)·(1 − c). */
export const netPrice = (price, book, settings) => 1 + (price - 1) * (1 - commissionOf(book, settings) / 100);
export const PARTITION_TYPES = new Set(['h2h3', 'h2h', 'btts', 'dnb', 'totals', 'ah', 'spread']);

export const DEFAULT_ENGINE_SETTINGS = {
  targetBooks: ['betfair_es', 'matchbook'],
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
};

const isQuarter = (l) => Math.abs((Math.abs(l) * 4) % 2 - 1) < 1e-9;
const isInteger = (l) => Math.abs(l - Math.round(l)) < 1e-9;
const ageMin = (ts, now) => (ts ? (now - new Date(ts).getTime()) / 60000 : Infinity);

/** Probabilidades sin margen de un mercado completo para cada casa con datos frescos. */
export function perBookFair(market, now, settings, exclude = new Set()) {
  const out = [];
  for (const [book, q] of Object.entries(market.quotes)) {
    if (exclude.has(book)) continue;
    const prices = market.sels.map((s) => q[s]?.price);
    if (!prices.every(isValidPrice)) continue;
    const age = Math.max(...market.sels.map((s) => ageMin(q[s].updatedAt, now)));
    if (age > settings.staleMinutes) continue;
    const margin = overround(prices);
    if (margin < -0.02 || margin > 0.25) continue; // datos incoherentes
    const fair = devig(prices, settings.devigMethod);
    out.push({ book, probs: Object.fromEntries(market.sels.map((s, i) => [s, fair[i]])), margin, sharp: SHARP_BOOKS.has(book), age });
  }
  return out;
}

/** Combina las referencias: casas sharp (Pinnacle / exchanges) pesan más que el consenso. */
export function combineFair(per, sels) {
  if (!per.length) return null;
  const sharp = per.filter((x) => x.sharp), soft = per.filter((x) => !x.sharp);
  const probs = {}, sd = {};
  for (const s of sels) {
    const all = per.map((x) => x.probs[s]);
    const sh = sharp.map((x) => x.probs[s]);
    const so = soft.map((x) => x.probs[s]);
    let p;
    if (sh.length && so.length >= 2) p = 0.65 * mean(sh) + 0.35 * median(so);
    else if (sh.length) p = 0.85 * mean(sh) + (so.length ? 0.15 * mean(so) : 0.15 * mean(sh));
    else p = 0.5 * median(all) + 0.5 * mean(all);
    probs[s] = p; sd[s] = stdev(all);
  }
  const tot = sum(Object.values(probs));
  for (const s of sels) probs[s] /= tot;
  return { probs, sd, n: per.length, sharpN: sharp.length, books: per.map((x) => x.book), sharpBooks: sharp.map((x) => x.book) };
}

/** Elige el total principal (más casas, preferiblemente .5) para ajustar el Poisson de mercado. */
function mainTotal(event) {
  const totals = Object.values(event.markets).filter((m) => m.type === 'totals' && !isInteger(m.line) && !isQuarter(m.line));
  totals.sort((a, b) => Object.keys(b.quotes).length - Object.keys(a.quotes).length || Math.abs(a.line - 2.5) - Math.abs(b.line - 2.5));
  return totals[0] || null;
}

function marketFitModel(event, now, settings, exclude) {
  if (event.sport !== 'football') return null;
  const m1 = Object.values(event.markets).find((m) => m.type === 'h2h3');
  if (!m1) return null;
  const f1 = combineFair(perBookFair(m1, now, settings, exclude), m1.sels);
  if (!f1 || f1.n < 2) return null;
  const mt = mainTotal(event);
  let ft = null;
  if (mt) { const c = combineFair(perBookFair(mt, now, settings, exclude), mt.sels); if (c && c.n >= 2) ft = { line: mt.line, over: c.probs.over, under: c.probs.under }; }
  const lam = fitLambdas(f1.probs, ft);
  return { lambdas: lam, matrix: scoreMatrix(lam.home, lam.away), source: 'Poisson ajustado al mercado sin margen (1X2' + (ft ? ` + total ${ft.line}` : '') + ')' };
}

/** Probabilidad de una selección según una matriz de Poisson (selecciones binarias / condicionales). */
function poissonSelProb(matrix, type, line, sel) {
  if (!matrix) return null;
  if (type === 'h2h3') return matrix1X2(matrix)[sel];
  if (type === 'btts') return matrixBTTS(matrix)[sel];
  if (type === 'dc') { const r = matrix1X2(matrix); return sel === '1X' ? r.home + r.draw : sel === 'X2' ? r.draw + r.away : r.home + r.away; }
  if (type === 'dnb') { const r = matrix1X2(matrix); return r[sel] / (r.home + r.away); }
  if (type === 'totals' && !isQuarter(line)) { const t = probOver(matrix, line); return sel === 'over' ? t.over / (t.over + t.under) : t.under / (t.over + t.under); }
  if (type === 'ah' && !isQuarter(line)) {
    const d = ahDist(matrix, line, sel, 2);
    const w = sum(d.filter((x) => x.r > 0).map((x) => x.p)), l = sum(d.filter((x) => x.r < 0).map((x) => x.p));
    return w / (w + l);
  }
  return null;
}

function pushProb(matrix, type, line) {
  if (!matrix || !isInteger(line)) return 0;
  if (type === 'totals') return probOver(matrix, line).push;
  if (type === 'ah') return sum(ahDist(matrix, line, 'home', 2).filter((x) => x.r === 0).map((x) => x.p));
  return 0;
}

/**
 * Evalúa un evento completo.
 * @param event  evento normalizado (ver server/scanner.js)
 * @param ctx    { now, settings, statModel?: {lambdas, matrix, source, details, quality}, books: {key:{title}} }
 */
export function evaluateEvent(event, ctx) {
  const now = ctx.now ?? Date.now();
  const settings = { ...DEFAULT_ENGINE_SETTINGS, ...ctx.settings };
  const targets = new Set(settings.targetBooks);
  const opportunities = [], anomalies = [], rows = [], issues = [];
  const fitAll = marketFitModel(event, now, settings, new Set()); // sólo aporta la forma; el nivel se calibra con referencias independientes
  const stat = ctx.statModel || null;
  const h2h3 = Object.values(event.markets).find((m) => m.type === 'h2h3');

  for (const market of Object.values(event.markets)) {
    const marketKey = market.key;
    const books = Object.keys(market.quotes);
    // Fila del escáner (todas las casas, referencias globales sin excluir)
    const fairAll = PARTITION_TYPES.has(market.type) ? combineFair(perBookFair(market, now, settings, targets), market.sels) : null;
    const row = { eventId: event.id, marketKey, type: market.type, line: market.line, label: marketLabel(market.type, market.line, event.sport), nBooks: books.length, sels: [] };

    for (const sel of market.sels) {
      const fresh = books.map((b) => ({ book: b, ...market.quotes[b][sel] })).filter((q) => isValidPrice(q.price) && ageMin(q.updatedAt, now) <= settings.staleMinutes);
      const best = fresh.reduce((a, q) => (!a || q.price > a.price ? q : a), null);
      row.sels.push({
        sel, label: selectionLabel(sel, event, market.type, market.line),
        targets: Object.fromEntries([...targets].filter((t) => market.quotes[t]?.[sel]).map((t) => [t, { price: market.quotes[t][sel].price, updatedAt: market.quotes[t][sel].updatedAt, age: ageMin(market.quotes[t][sel].updatedAt, now) }])),
        best: best ? { book: best.book, price: best.price } : null,
        fair: fairAll ? 1 / fairAll.probs[sel] : null, p: fairAll?.probs[sel] ?? null,
      });
    }
    rows.push(row);

    // --- Diferencias entre casas objetivo y posibles errores ------------------------
    for (const sel of market.sels) {
      const tq = [...targets].filter((t) => isValidPrice(market.quotes[t]?.[sel]?.price)).map((t) => ({ book: t, ...market.quotes[t][sel] }));
      if (tq.length >= 2) {
        for (const x of tq) x.price = netPrice(x.price, x.book, settings); // comparación con cuotas netas de comisión
        const hi = tq.reduce((a, b) => (b.price > a.price ? b : a)), lo = tq.reduce((a, b) => (b.price < a.price ? b : a));
        const diff = hi.price / lo.price - 1;
        if (diff * 100 >= settings.diffThresholdPct && hi.book.slice(0, 4) !== lo.book.slice(0, 4)) {
          anomalies.push(baseAnomaly('diferencia', event, market, sel, { book: hi.book, price: hi.price, updatedAt: hi.updatedAt }, { diffPct: diff, low: { book: lo.book, price: lo.price } }));
        }
      }
    }

    // --- Arbitraje entre casas -----------------------------------------------------
    if (PARTITION_TYPES.has(market.type) && market.type !== 'dc') {
      const legs = market.sels.map((sel) => {
        const c = books.map((b) => ({ book: b, ...market.quotes[b][sel] })).filter((q) => isValidPrice(q.price) && ageMin(q.updatedAt, now) <= settings.staleMinutes).map((q) => ({ ...q, rawPrice: q.price, price: netPrice(q.price, q.book, settings) }));
        return c.reduce((a, q) => (!a || q.price > a.price ? q : a), null);
      });
      if (legs.every(Boolean) && new Set(legs.map((l) => l.book)).size > 1) {
        const inv = sum(legs.map((l) => 1 / l.price));
        if (inv < 0.995) {
          anomalies.push({
            id: `arb|${event.id}|${marketKey}`, category: 'arbitraje', eventId: event.id, event: `${event.home} vs ${event.away}`, sport: event.sport, competition: event.competition, commence: event.commence,
            marketKey, market: marketLabel(market.type, market.line, event.sport), margin: 1 - inv,
            legs: legs.map((l, i) => ({ sel: market.sels[i], label: selectionLabel(market.sels[i], event, market.type, market.line), book: l.book, price: l.price, updatedAt: l.updatedAt, share: (1 / l.price) / inv })),
            involvesTarget: legs.some((l) => targets.has(l.book)), detectedAt: new Date(now).toISOString(),
            verification: 'pendiente',
            note: 'Arbitraje teórico: requiere colocar todas las patas a la vez; las casas pueden limitar o anular. No equivale a una apuesta de valor.',
          });
        }
      }
    }

    // --- Value bets para cada casa objetivo -----------------------------------------
    for (const T of targets) {
      const tq = market.quotes[T];
      if (!tq) continue;
      // Referencias independientes: nunca la propia casa (ni otras claves de la misma casa).
      const exclude = new Set(Object.keys(market.quotes).concat(h2h3 ? Object.keys(h2h3.quotes) : []).filter((b) => bookFamily(b) === bookFamily(T)));
      let fair = null;
      if (PARTITION_TYPES.has(market.type)) fair = combineFair(perBookFair(market, now, settings, exclude), market.sels);
      // Mercados derivados del 1X2
      let fair1x2 = null;
      if ((market.type === 'dc' || market.type === 'dnb') && h2h3) fair1x2 = combineFair(perBookFair(h2h3, now, settings, exclude), h2h3.sels);

      for (const sel of market.sels) {
        const q = tq[sel];
        if (!q || !isValidPrice(q.price)) continue;
        const rawPrice = q.price;
        const commission = commissionOf(T, settings);
        const price = netPrice(rawPrice, T, settings); // EV y Kelly siempre con la cuota neta de comisión
        if (price <= 1.0001) continue;
        const age = ageMin(q.updatedAt, now);
        const checks = [];
        const flags = [];
        let pMarket = null, sd = 0, n = 0, sharpN = 0, refBooks = [], dist = null, distNote = null, pushP = 0;

        if (market.type === 'dc') {
          if (!fair1x2) { issues.push(`${event.home}-${event.away} ${marketKey}: sin 1X2 de referencia`); continue; }
          const parts = sel === '1X' ? ['home', 'draw'] : sel === 'X2' ? ['draw', 'away'] : ['home', 'away'];
          pMarket = parts.reduce((a, s) => a + fair1x2.probs[s], 0);
          sd = Math.sqrt(parts.reduce((a, s) => a + fair1x2.sd[s] ** 2, 0));
          n = fair1x2.n; sharpN = fair1x2.sharpN; refBooks = fair1x2.books;
          dist = (p) => binaryDist(p, price);
        } else if (market.type === 'dnb') {
          const src = fair && fair.n >= (fair1x2?.n ?? 0) ? fair : null;
          if (!src && !fair1x2) continue;
          const pDraw = fair1x2 ? fair1x2.probs.draw : (fitAll ? matrix1X2(fitAll.matrix).draw : 0.26);
          const qCond = src ? src.probs[sel] : fair1x2.probs[sel] / (fair1x2.probs.home + fair1x2.probs.away);
          pMarket = qCond; sd = src ? src.sd[sel] : fair1x2.sd[sel]; n = (src || fair1x2).n; sharpN = (src || fair1x2).sharpN; refBooks = (src || fair1x2).books;
          pushP = pDraw;
          dist = (p) => [{ p: p * (1 - pushP), r: price - 1 }, { p: pushP, r: 0 }, { p: (1 - p) * (1 - pushP), r: -1 }];
          distNote = `Devolución si hay empate (p ≈ ${(pushP * 100).toFixed(1)}%)`;
        } else if (fair) {
          pMarket = fair.probs[sel]; sd = fair.sd[sel]; n = fair.n; sharpN = fair.sharpN; refBooks = fair.books;
          if ((market.type === 'ah' || market.type === 'totals') && isQuarter(market.line)) {
            if (!fitAll) { issues.push(`${event.home}-${event.away} ${marketKey}: línea de cuarto sin modelo de Poisson; descartada`); continue; }
            const side = sel;
            const mkDist = (pr) => (market.type === 'ah' ? ahDist(fitAll.matrix, market.line, side, pr) : totalDist(fitAll.matrix, market.line, side, pr));
            const modelFair = fairPriceFromDist(mkDist);
            const marketFair = 1 / pMarket;
            const gap = Math.abs(modelFair / marketFair - 1);
            checks.push({ name: 'Coherencia línea de cuarto (Poisson vs mercado)', ok: gap < 0.04, detail: `Cuota justa Poisson ${modelFair.toFixed(3)} vs mercado ${marketFair.toFixed(3)}` });
            // El Poisson aporta la FORMA (medias ganancias / devoluciones); el NIVEL se calibra
            // para que la cuota justa coincida con la del mercado sin margen (1/pMarket).
            let lo = 0.2, hi = 3;
            for (let it = 0; it < 80; it++) {
              const mid = (lo + hi) / 2;
              if (expectedValueDist(rescaleWin(mkDist(marketFair), mid)) > 0) hi = mid; else lo = mid;
            }
            const calib = (lo + hi) / 2;
            dist = (p) => rescaleWin(mkDist(price), calib * (p / pMarket));
            distNote = `Línea de cuarto: la apuesta se divide en dos mitades (medias ganancias / medias pérdidas). Distribución de Poisson calibrada a la cuota justa del mercado (factor ${calib.toFixed(3)}). Kelly sobre la distribución completa.`;
          } else if ((market.type === 'ah' || market.type === 'totals' || market.type === 'spread') && isInteger(market.line)) {
            pushP = pushProb(fitAll?.matrix, market.type, market.line);
            dist = (p) => [{ p: p * (1 - pushP), r: price - 1 }, { p: pushP, r: 0 }, { p: (1 - p) * (1 - pushP), r: -1 }];
            distNote = pushP > 0 ? `Línea entera: devolución si se iguala la línea (p ≈ ${(pushP * 100).toFixed(1)}%)` : 'Línea entera: probabilidades condicionadas a que no haya devolución';
          } else {
            dist = (p) => binaryDist(p, price);
          }
        } else continue;

        if (!(pMarket > 0 && pMarket < 1)) continue;

        // --- Modelo estadístico independiente (football-data) ---
        let pModel = null, modelInfo = null;
        if (stat?.matrix && (market.type !== 'ah' || !isQuarter(market.line))) {
          pModel = poissonSelProb(stat.matrix, market.type, market.line, sel);
          if (pModel != null) modelInfo = { p: pModel, source: stat.source, details: stat.details, quality: stat.quality };
        }
        const w = pModel != null && stat.quality === 'ok' ? settings.modelWeight : 0;
        const pEst = (1 - w) * pMarket + w * (pModel ?? pMarket);

        // --- Incertidumbre ---
        const floor = sharpN > 0 ? 0.008 : 0.015;
        const disagreement = pModel != null ? Math.abs(pModel - pMarket) : 0;
        const se = Math.sqrt((n > 1 ? sd ** 2 / n : 0.03 ** 2) + floor ** 2 + (0.3 * disagreement) ** 2 + (n < settings.minRefBooks ? 0.02 ** 2 : 0));
        const pLow = Math.max(0.0001, pEst - se), pHigh = Math.min(0.9999, pEst + se);

        const dTheo = dist(pEst);
        const evTheoretical = expectedValueDist(dTheo);
        const evMarketOnly = expectedValueDist(dist(pMarket));
        const evConservative = expectedValueDist(dist(pLow));
        const evOptimistic = expectedValueDist(dist(pHigh));

        // --- Comprobaciones de calidad ---
        checks.push({ name: 'Mercado y selección normalizados', ok: market.semanticsVerified !== false, detail: market.semanticsVerified === false ? 'Semántica del hándicap no confirmada en este proveedor' : 'Mismo mercado, línea y selección en todas las casas' });
        checks.push({ name: `Cuota reciente (≤ ${settings.staleMinutes} min)`, ok: age <= settings.staleMinutes, detail: Number.isFinite(age) ? `Antigüedad ${age.toFixed(1)} min` : 'Sin marca de tiempo' });
        if (q.size != null) checks.push({ name: `Liquidez disponible (≥ ${settings.minLiquidity} €)`, ok: q.size >= settings.minLiquidity, detail: `${q.size.toFixed(0)} € al mejor precio` });
        checks.push({ name: `Referencias independientes (≥ ${settings.minRefBooks})`, ok: n >= settings.minRefBooks, detail: `${n} casas de referencia` });
        checks.push({ name: 'Referencia sharp (Pinnacle / exchange)', ok: sharpN > 0, detail: sharpN ? `${sharpN} referencia(s) sharp` : 'Sin referencia sharp' });
        checks.push({ name: 'Dispersión entre casas baja', ok: sd < 0.03, detail: `σ = ${(sd * 100).toFixed(2)} p.p.` });
        if (pModel != null) checks.push({ name: 'Modelo estadístico coherente', ok: disagreement < 0.06, detail: `Modelo ${(pModel * 100).toFixed(1)}% vs mercado ${(pMarket * 100).toFixed(1)}%` });
        checks.push({ name: 'EV robusto (EV conservador > 0)', ok: evConservative > 0, detail: `EV conservador ${(evConservative * 100).toFixed(2)}%` });
        checks.push({ name: `EV no anómalo (≤ ${settings.exceptionalEV * 100}%)`, ok: evTheoretical <= settings.exceptionalEV, detail: evTheoretical > settings.exceptionalEV ? 'Posible error de cotización: la casa puede corregir o anular' : 'Dentro de rango normal' });

        let confidence = 'baja';
        if (sharpN > 0 && n >= Math.max(4, settings.minRefBooks) && se <= 0.022 && age <= settings.staleMinutes / 2) confidence = 'alta';
        else if (n >= settings.minRefBooks && se <= 0.035 && age <= settings.staleMinutes) confidence = 'media';
        if (checks.some((c) => c.name.startsWith('Coherencia línea') && !c.ok)) confidence = 'baja';
        if (pModel != null && disagreement >= 0.08 && confidence === 'alta') confidence = 'media';

        // --- Posibles errores de cuota y cuotas no actualizadas ---
        const others = Object.entries(market.quotes).filter(([b]) => bookFamily(b) !== bookFamily(T)).map(([b, qq]) => ({ book: b, ...qq[sel] })).filter((x) => isValidPrice(x.price) && ageMin(x.updatedAt, now) <= settings.staleMinutes);
        if (others.length >= 2) {
          const ps = others.map((x) => x.price);
          const refMean = mean(ps), sdP = stdev(ps);
          const diffPct = rawPrice / refMean - 1;
          const z = sdP > 0 ? (rawPrice - refMean) / sdP : Infinity;
          // Se usa la hora del último cambio de precio cuando el proveedor la ofrece.
          const tsOf = (x) => new Date(x.changedAt || x.updatedAt).getTime();
          const newest = Math.max(...others.map(tsOf));
          const gapMin = (newest - tsOf(q)) / 60000;
          const extra = { diffPct, refMean, z, refN: others.length, pEst, evTheoretical, bestOther: others.reduce((a, b) => (b.price > a.price ? b : a)) };
          if (diffPct * 100 >= settings.errorThresholdPct && others.length >= 3 && z >= 2.5) {
            anomalies.push(baseAnomaly('error', event, market, sel, { book: T, price: rawPrice, updatedAt: q.updatedAt }, extra));
            flags.push('posible_error');
          } else if (gapMin >= settings.staleGapMinutes && diffPct >= 0.04) {
            anomalies.push(baseAnomaly('desactualizada', event, market, sel, { book: T, price: rawPrice, updatedAt: q.updatedAt }, { ...extra, gapMin }));
            flags.push('cuota_no_actualizada');
          }
        }

        // --- Filtro de calidad mínimo ---
        const evClass = classifyEV(evTheoretical);
        const critical = ['Mercado y selección normalizados', `Cuota reciente (≤ ${settings.staleMinutes} min)`, `Liquidez disponible (≥ ${settings.minLiquidity} €)`];
        const passesMin = evTheoretical >= settings.minEV && n >= 2 && critical.every((c) => checks.find((x) => x.name === c)?.ok ?? true) && rawPrice >= settings.minOdds && rawPrice <= settings.maxOdds;
        if (!passesMin) continue;
        const verified = checks.every((c) => c.ok) && confidence !== 'baja';

        const refList = refBooks.map((b) => ({ book: b, price: market.quotes[b]?.[sel]?.price, updatedAt: market.quotes[b]?.[sel]?.updatedAt, sharp: SHARP_BOOKS.has(b) })).filter((x) => x.price);
        const allPrices = Object.entries(market.quotes).map(([b, qq]) => ({ book: b, price: qq[sel]?.price, updatedAt: qq[sel]?.updatedAt, provider: qq[sel]?.provider })).filter((x) => isValidPrice(x.price));
        const refMeanAll = mean(refList.map((x) => x.price));

        opportunities.push({
          id: `${event.id}|${marketKey}|${sel}|${T}`,
          category: 'value',
          eventId: event.id, sport: event.sport, competition: event.competition, commence: event.commence,
          event: `${event.home} vs ${event.away}`, home: event.home, away: event.away,
          marketKey, marketType: market.type, marketGroup: MARKET_GROUP[market.type], line: market.line,
          market: marketLabel(market.type, market.line, event.sport),
          sel, selection: selectionLabel(sel, event, market.type, market.line),
          book: T, price, rawPrice, commission, liquidity: q.size ?? null, quoteUpdatedAt: q.updatedAt, quoteAgeMin: age, provider: q.provider,
          refOdds: 1 / pEst, refMeanOdds: refMeanAll, bestOther: allPrices.filter((x) => x.book !== T).reduce((a, b) => (!a || b.price > a.price ? b : a), null),
          pMarket, pModel, pEst, pLow, pHigh, se, pImplied: 1 / rawPrice,
          evTheoretical, evConservative, evOptimistic, evMarketOnly,
          evClass: evClass.key, evClassLabel: evClass.label,
          confidence, verified, verification: verified ? 'verificada' : 'pendiente',
          exceptional: evTheoretical > settings.exceptionalEV,
          nRefs: n, sharpN, refBooks: refList, allPrices,
          dist: dTheo, distNote, pushP,
          model: modelInfo, marketModel: fitAll ? { lambdas: fitAll.lambdas, source: fitAll.source } : null,
          checks, flags,
          detectedAt: new Date(now).toISOString(),
        });
      }
    }
  }
  return { opportunities, anomalies, rows, issues, marketModel: fitAll ? fitAll.lambdas : null };
}

function rescaleWin(dist, scale) {
  // Ajusta la masa ganadora proporcionalmente y la compensa con la perdedora (mantiene Σp = 1).
  const win = dist.filter((x) => x.r > 0), lose = dist.filter((x) => x.r < 0), flat = dist.filter((x) => x.r === 0);
  const pw = sum(win.map((x) => x.p)), pl = sum(lose.map((x) => x.p));
  const newPw = Math.min(pw + pl - 1e-6, pw * scale);
  const k = pl > 0 ? (pl - (newPw - pw)) / pl : 1;
  return [...win.map((x) => ({ ...x, p: x.p * (newPw / pw || 0) })), ...flat, ...lose.map((x) => ({ ...x, p: x.p * k }))];
}

function baseAnomaly(category, event, market, sel, quote, extra) {
  return {
    id: `${category}|${event.id}|${market.key}|${sel}|${quote.book}`,
    category, eventId: event.id, event: `${event.home} vs ${event.away}`, sport: event.sport, competition: event.competition, commence: event.commence,
    marketKey: market.key, market: marketLabel(market.type, market.line, event.sport), sel, selection: selectionLabel(sel, event, market.type, market.line),
    book: quote.book, price: quote.price, quoteUpdatedAt: quote.updatedAt,
    targetPrices: Object.fromEntries(Object.entries(market.quotes).filter(([, q]) => q[sel]).map(([b, q]) => [b, q[sel].price])),
    detectedAt: new Date().toISOString(), verification: 'pendiente', ...extra,
  };
}

export { expectedValue };
