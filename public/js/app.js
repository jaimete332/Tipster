// Tipster Inteligente Pro — interfaz.
// El análisis sólo se ejecuta mientras esta página está abierta y el usuario lo ha iniciado.

import { $, $$, esc, eur, pct, spct, odd, num, cls, when, ago, until, toast, lineChart, CONF_BADGE, EVCLASS_BADGE, PALETTE } from './ui.js';
import { allocate, bankrollState, betPL } from '/shared/engine/risk.js';
import { kellyDist, kellyBinary, KELLY_FRACTIONS } from '/shared/engine/kelly.js';
import { expectedValueDist } from '/shared/engine/odds.js';
import { summarize, groupBy, bankrollCurve, filterPeriod, PERIODS, opportunityCLV, clv } from '/shared/engine/stats.js';
import { SPORT_LABEL, MARKET_TYPES } from '/shared/engine/names.js';

const S = {
  data: null, view: 'dashboard', active: false, phase: 'inactivo', detail: '', nextAt: null,
  abort: null, timer: null, pollTimer: null, tick: null,
  filters: { sport: '', book: '', minEV: 2, confidence: '', market: '', oddsMin: '', oddsMax: '', next24: false, stakeMin: '', stakeMax: '', verified: false, errors: false },
  errTab: 'error', period: 'all', histKind: 'real', scanSport: '', scanSearch: '', scanLimit: 40,
};

// ---------------------------------------------------------------- API
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
async function refresh() { S.data = await api('/api/state'); render(); }

// ---------------------------------------------------------------- Derivados
const settings = () => S.data.settings;
const bank = () => bankrollState(S.data.bankroll, S.data.bets);
const pendingBets = () => S.data.bets.filter((b) => b.kind === 'real' && b.result === 'pendiente');
const scan = () => S.data.lastScan;
const BOOKS = { bet365: 'Bet365', bet365_es: 'Bet365 ES', winamax_fr: 'Winamax FR', winamax_es: 'Winamax ES', winamax_de: 'Winamax DE', pinnacle: 'Pinnacle', betfair_ex_eu: 'Betfair Exchange', betfair_ex_uk: 'Betfair Exchange UK' };
const bookName = (k) => BOOKS[k] || scan()?.books?.[k] || k;
const isWinamax = (k) => k.startsWith('winamax');

function opportunities() {
  const sc = scan();
  if (!sc?.opportunities) return [];
  const alloc = allocate(sc.opportunities, settings(), bank(), pendingBets());
  return sc.opportunities.map((o) => ({ ...o, stake: alloc.get(o.id) }));
}

// ---------------------------------------------------------------- Ciclo de análisis
function setStatus(phase, detail = '') {
  S.phase = phase; S.detail = detail;
  const el = $('#status');
  const map = { inactivo: 'INACTIVO', analizando: 'ANALIZANDO', esperando: 'ESPERANDO DATOS', terminado: 'TERMINADO', error: 'ERROR' };
  el.dataset.s = phase;
  $('.status-label', el).textContent = map[phase] || phase.toUpperCase();
  $('.status-detail', el).textContent = detail;
  const btn = $('#toggle');
  btn.textContent = S.active ? 'DETENER ANÁLISIS' : 'INICIAR ANÁLISIS';
  btn.classList.toggle('stop', S.active);
  $$('.js-toggle').forEach((b) => { b.textContent = btn.textContent; b.classList.toggle('stop', S.active); });
  const live = $('#live-phase'); if (live) live.innerHTML = phaseBlock();
}

async function startAnalysis() {
  if (S.active) return;
  S.active = true;
  setStatus('esperando', 'Conectando con los proveedores…');
  cycle();
}

async function cycle() {
  if (!S.active) return;
  clearTimeout(S.timer); clearInterval(S.tick);
  S.abort = new AbortController();
  S.pollTimer = setInterval(pollProgress, 900);
  setStatus('esperando', 'Consultando proveedores de cuotas…');
  try {
    const r = await api('/api/scan', { method: 'POST', signal: S.abort.signal });
    clearInterval(S.pollTimer);
    if (!S.active) return;
    await refresh();
    if (!r.ok) { setStatus('error', r.error); toast(r.error, 5000); }
    else {
      const sc = r.scan;
      const msg = sc.dataStatus === 'sin_datos' ? 'Sin datos: no hay fuentes disponibles' : `${sc.opportunities.length} oportunidades · ${sc.eventsAnalyzed} eventos`;
      setStatus('terminado', msg);
    }
    scheduleNext();
  } catch (e) {
    clearInterval(S.pollTimer);
    if (S.active) { setStatus('error', e.message); scheduleNext(); }
  }
}

function scheduleNext() {
  if (!S.active) return;
  const secs = settings().refreshSeconds;
  S.nextAt = Date.now() + secs * 1000;
  S.timer = setTimeout(cycle, secs * 1000);
  S.tick = setInterval(() => {
    const left = Math.max(0, Math.round((S.nextAt - Date.now()) / 1000));
    const base = S.detail.split(' · próxima')[0];
    if (S.phase === 'terminado' || S.phase === 'error') { S.detail = `${base} · próxima actualización en ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`; $('.status-detail').textContent = S.detail; }
  }, 1000);
}

async function pollProgress() {
  try {
    const p = await api('/api/progress');
    if (!S.active || !p.running) return;
    const waiting = ['obteniendo_eventos', 'consultando_cuotas', 'modelos'].includes(p.phase);
    setStatus(waiting ? 'esperando' : 'analizando', p.detail);
  } catch { /* silencioso */ }
}

async function stopAnalysis() {
  S.active = false;
  clearTimeout(S.timer); clearInterval(S.tick); clearInterval(S.pollTimer);
  S.abort?.abort();
  try { await api('/api/scan/stop', { method: 'POST' }); } catch { /* */ }
  setStatus('inactivo', 'Análisis detenido');
  toast('Análisis detenido: no se realizarán más consultas');
}
const toggle = () => (S.active ? stopAnalysis() : startAnalysis());

// ---------------------------------------------------------------- Render
function render() {
  if (!S.data) return;
  renderKPIs();
  const opps = opportunities();
  $('#c-value').textContent = opps.length || '';
  $('#c-err').textContent = (scan()?.anomalies || []).filter((a) => a.category === 'error' || a.category === 'desactualizada').length || '';
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === S.view));
  const views = { dashboard: vDashboard, escaner: vScanner, value: vValue, errores: vErrors, bankroll: vBankroll, historial: vHistory, estadisticas: vStats, config: vConfig };
  const main = $('#main');
  main.innerHTML = (views[S.view] || vDashboard)();
  bind(main);
  document.documentElement.style.setProperty('--topbar-h', `${$('.topbar').offsetHeight}px`);
}

function renderKPIs() {
  const sc = scan(); const b = bank();
  const items = [
    ['Eventos analizados', sc ? num(sc.eventsAnalyzed) : '—'],
    ['Oportunidades', sc ? num(sc.opportunities.length) : '—'],
    ['Mejor EV', sc?.bestEV != null ? `<span class="pos">${spct(sc.bestEV)}</span>` : '—'],
    ['Bank actual', eur(b.total)],
    ['Comprometido', eur(b.committed)],
    ['Última actualización', sc ? when(sc.at) : 'nunca'],
  ];
  $('#kpis').innerHTML = items.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
}

function phaseBlock() {
  const sc = scan();
  return `<div class="muted">Estado: <b>${esc({ inactivo: 'Inactivo — sin consultas ni consumo de recursos', analizando: 'Analizando', esperando: 'Esperando datos de los proveedores', terminado: 'Análisis terminado', error: 'Error' }[S.phase] || S.phase)}</b>${S.detail ? ` · ${esc(S.detail)}` : ''}</div>
    <div class="muted">Último análisis: <b>${sc ? `${when(sc.at)} (${ago(sc.at)})` : 'ninguno'}</b>${sc ? ` · duración ${num(sc.durationMs / 1000, 1)} s` : ''}</div>`;
}

// ---------------------------------------------------------------- Dashboard
function vDashboard() {
  const sc = scan(); const b = bank(); const opps = opportunities();
  const keys = S.data.keys;
  const noKeys = !keys.theoddsapi.configured && !keys.oddspapi.configured;
  const notice = noKeys
    ? `<div class="notice bad"><b>No hay fuentes de cuotas configuradas.</b><p>La aplicación no muestra datos inventados: hasta que añadas al menos una clave API (The Odds API para Winamax/Pinnacle y OddsPapi para Bet365) no habrá oportunidades. <a href="#config">Ir a Configuración</a>.</p></div>`
    : !keys.oddspapi.configured ? `<div class="notice"><b>Bet365 no está conectado.</b> The Odds API no ofrece Bet365 en Europa. Añade una clave de OddsPapi para incluir Bet365. Mientras tanto se analizan Winamax y las casas de referencia.</div>` : '';
  const curve = bankrollCurve(S.data.bankroll, S.data.bets);
  return `${notice}
  ${S.data.bankroll.initial ? '' : `<div class="notice info">Configura tu <b>bank inicial</b> en <a href="#bankroll">Bankroll</a> para que el sistema calcule los stakes recomendados.</div>`}
  <div class="grid g-side">
    <section class="panel bigstart">
      <h2>${S.active ? 'Análisis activo' : 'Sistema en reposo'}</h2>
      <button class="btn-run js-toggle ${S.active ? 'stop' : ''}" type="button">${S.active ? 'DETENER ANÁLISIS' : 'INICIAR ANÁLISIS'}</button>
      <div id="live-phase">${phaseBlock()}</div>
      <p class="faint" style="max-width:640px;margin:0">El análisis sólo se ejecuta mientras esta página está abierta y activada. Se repite cada ${num(settings().refreshSeconds / 60, 1)} min mientras esté activo (cada ciclo consume créditos de las APIs).</p>
    </section>
    <section class="panel">
      <h4>Fuentes en el último análisis</h4>
      ${sc ? sourcesList(sc) : '<div class="muted">Sin análisis todavía.</div>'}
      ${quotaBlock()}
    </section>
  </div>
  <div class="grid g4" style="margin-top:14px">
    ${card('Bank actual', eur(b.total), `Disponible ${eur(b.available)}`)}
    ${card('Beneficio acumulado', `<span class="${cls(b.settledPL)}">${eur(b.settledPL)}</span>`, `Rentabilidad ${spct(b.returnPct)}`)}
    ${card('Comprometido', eur(b.committed), `${pendingBets().length} apuestas pendientes`)}
    ${card('Oportunidades', num(opps.length), sc ? `${opps.filter((o) => o.verified).length} verificadas · ${(sc.anomalies || []).length} anomalías` : 'Sin análisis')}
  </div>
  <div class="grid g-side" style="margin-top:14px">
    <section class="panel">
      <div class="panel-head"><h3>Mejores oportunidades del último análisis</h3><a href="#value">Ver todas →</a></div>
      ${oppTable(opps.slice(0, 6), true)}
    </section>
    <section class="panel">
      <h3>Evolución del bankroll</h3>
      ${curve.length > 1 ? lineChart([{ name: 'Bankroll', color: PALETTE[0], points: curve.map((p) => ({ x: new Date(p.at).getTime(), y: p.v })) }], { yFmt: (v) => eur(v, 0), title: 'Evolución del bankroll' }) : '<div class="empty">Aún no hay apuestas liquidadas.</div>'}
    </section>
  </div>`;
}
const card = (label, value, sub = '') => `<div class="panel card"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;

function sourcesList(sc) {
  const st = { ok: 'b-green', error: 'b-red', sin_clave: 'b-amber' };
  return `<table><tbody>${sc.sources.map((s) => `<tr><td>${esc(s.provider)}</td><td><span class="badge ${st[s.status] || 'b-grey'}">${esc(s.status === 'sin_clave' ? 'sin clave' : s.status)}</span></td><td class="n">${s.events != null ? `${num(s.events)} eventos` : ''}</td></tr><tr class="sub"><td colspan="3" class="wrap">${esc(s.detail || '')}</td></tr>`).join('')}
    <tr><td>football-data.co.uk</td><td><span class="badge ${settings().providers.footballdata.enabled ? 'b-green' : 'b-grey'}">${settings().providers.footballdata.enabled ? 'modelo' : 'off'}</span></td><td class="n">${sc.modelCoverage ? `${sc.modelCoverage.matched} partidos` : ''}</td></tr>
    </tbody></table>
    ${sc.errors?.length ? `<details style="margin-top:8px"><summary>${sc.errors.length} errores en el último análisis</summary><ul class="factors">${sc.errors.slice(0, 20).map((e) => `<li class="neg">${esc(e)}</li>`).join('')}</ul></details>` : ''}`;
}
function quotaBlock() {
  const q = S.data.quota || {};
  const rows = [];
  if (q.theoddsapi) rows.push(`The Odds API: <b>${num(q.theoddsapi.remaining)}</b> créditos restantes (usados ${num(q.theoddsapi.used)})`);
  if (q.oddspapi) rows.push(`OddsPapi: <b>${q.oddspapi.remaining != null ? num(q.oddspapi.remaining) : '?'}</b> peticiones restantes`);
  return rows.length ? `<div class="muted" style="margin-top:10px;font-size:.8rem">${rows.join('<br>')}</div>` : '';
}

// ---------------------------------------------------------------- Value Bets
function filteredOpps() {
  const f = S.filters; const now = Date.now();
  const confRank = { baja: 0, media: 1, alta: 2 };
  return opportunities().filter((o) =>
    (!f.sport || o.sport === f.sport) &&
    (!f.book || (f.book === 'winamax' ? isWinamax(o.book) : o.book === f.book)) &&
    o.evTheoretical * 100 >= (Number(f.minEV) || 0) &&
    (!f.confidence || confRank[o.confidence] >= confRank[f.confidence]) &&
    (!f.market || o.marketGroup === f.market) &&
    (!f.oddsMin || o.price >= Number(f.oddsMin)) && (!f.oddsMax || o.price <= Number(f.oddsMax)) &&
    (!f.next24 || new Date(o.commence).getTime() - now <= 86400e3) &&
    (!f.stakeMin || o.stake.stake >= Number(f.stakeMin)) && (!f.stakeMax || o.stake.stake <= Number(f.stakeMax)) &&
    (!f.verified || o.verified) && (!f.errors || o.flags.length || o.exceptional));
}

function filtersBar() {
  const f = S.filters;
  const books = [...new Set(opportunities().map((o) => o.book))];
  const opt = (v, l, cur) => `<option value="${v}" ${String(cur) === String(v) ? 'selected' : ''}>${l}</option>`;
  return `<form class="form panel" id="filters" style="margin-bottom:14px">
    <label class="f">Deporte<select name="sport">${opt('', 'Todos', f.sport)}${Object.entries(SPORT_LABEL).map(([k, v]) => opt(k, v, f.sport)).join('')}</select></label>
    <label class="f">Casa<select name="book">${opt('', 'Todas', f.book)}${opt('bet365', 'Bet365', f.book)}${opt('winamax', 'Winamax (todas)', f.book)}${books.filter((b) => b !== 'bet365').map((b) => opt(b, bookName(b), f.book)).join('')}</select></label>
    <label class="f">EV mínimo (%)<input type="number" name="minEV" step="0.5" value="${f.minEV}"></label>
    <label class="f">Confianza mínima<select name="confidence">${opt('', 'Cualquiera', f.confidence)}${opt('media', 'Media o alta', f.confidence)}${opt('alta', 'Alta', f.confidence)}</select></label>
    <label class="f">Mercado<select name="market">${opt('', 'Todos', f.market)}${opt('ganador', 'Ganador / DNB', f.market)}${opt('doble', 'Doble oportunidad', f.market)}${opt('handicap', 'Hándicap', f.market)}${opt('totales', 'Más/menos', f.market)}${opt('btts', 'Ambos marcan', f.market)}</select></label>
    <label class="f">Cuota mín.<input type="number" step="0.01" name="oddsMin" value="${f.oddsMin}"></label>
    <label class="f">Cuota máx.<input type="number" step="0.01" name="oddsMax" value="${f.oddsMax}"></label>
    <label class="f">Stake mín. (€)<input type="number" step="0.5" name="stakeMin" value="${f.stakeMin}"></label>
    <label class="f">Stake máx. (€)<input type="number" step="0.5" name="stakeMax" value="${f.stakeMax}"></label>
    <label class="chk"><input type="checkbox" name="next24" ${f.next24 ? 'checked' : ''}>Próximas 24 h</label>
    <label class="chk"><input type="checkbox" name="verified" ${f.verified ? 'checked' : ''}>Sólo verificadas</label>
    <label class="chk"><input type="checkbox" name="errors" ${f.errors ? 'checked' : ''}>Posibles errores de cuota</label>
  </form>`;
}

function vValue() {
  const sc = scan();
  const list = filteredOpps();
  return `${dataBanner()}
  <div class="panel-head"><h2>Value Bets</h2><span class="muted">${list.length} de ${opportunities().length} · ordenadas por EV · bank disponible ${eur(bank().available)}</span></div>
  ${filtersBar()}
  ${oppTable(list)}
  <p class="faint" style="font-size:.78rem;margin-top:10px">Clasificación orientativa: &lt;2% descartar · 2–5% bajo · 5–8% interesante · 8–12% alto · &gt;12% excepcional (verificar). No son garantías de rentabilidad. «EV» es el EV estimado (mercado sin margen ${settings().modelWeight ? `+ ${pct(settings().modelWeight, 0)} modelo estadístico` : ''}); el stake se anula si el EV conservador (estimación − 1σ) no es positivo.</p>
  ${sc?.issues?.length ? `<details><summary>${sc.issues.length} mercados descartados por datos insuficientes</summary><ul class="factors faint">${sc.issues.slice(0, 50).map((i) => `<li>${esc(i)}</li>`).join('')}</ul></details>` : ''}`;
}

function dataBanner() {
  const sc = scan();
  if (!sc) return `<div class="notice info">Todavía no se ha realizado ningún análisis. Pulsa <b>INICIAR ANÁLISIS</b>.</div>`;
  const age = (Date.now() - new Date(sc.at).getTime()) / 60000;
  if (sc.dataStatus === 'sin_datos') return `<div class="notice bad">El último análisis no obtuvo datos reales de ninguna fuente. No se muestran oportunidades.</div>`;
  if (age > settings().staleMinutes) return `<div class="notice">Datos del ${when(sc.at)} (${ago(sc.at)}). <b>Las cuotas pueden haber cambiado</b>: vuelve a analizar antes de apostar.</div>`;
  return '';
}

function oppTable(list, compact = false) {
  if (!list.length) return `<div class="empty">${scan() ? 'Ninguna oportunidad cumple los criterios mínimos de calidad. Esto es normal: el sistema prioriza pocas apuestas bien justificadas.' : 'Sin análisis todavía.'}</div>`;
  const head = compact
    ? ['Evento', 'Mercado', 'Selección', 'Casa', 'Cuota', 'EV', 'Conf.', 'Stake']
    : ['Deporte', 'Competición', 'Evento', 'Mercado', 'Selección', 'Casa', 'Cuota actual', 'Cuota ref.', 'Prob. est.', 'Prob. impl.', 'EV %', 'Confianza', 'Stake €', 'Stake %', 'Benef. neto', 'Pérdida', 'Actualizado', 'Estado'];
  const numeric = new Set(['Cuota', 'EV', 'Stake', 'Cuota actual', 'Cuota ref.', 'Prob. est.', 'Prob. impl.', 'EV %', 'Stake €', 'Stake %', 'Benef. neto', 'Pérdida']);
  const rows = list.map((o) => {
    const st = o.stake;
    const evCell = `<span class="${cls(o.evTheoretical)}">${spct(o.evTheoretical, 2)}</span>`;
    const stakeCell = st.stake > 0 ? eur(st.stake) : '<span class="faint">0 €</span>';
    if (compact) return `<tr class="click" data-opp="${esc(o.id)}"><td>${esc(o.event)}<div class="faint">${until(o.commence)}</div></td><td>${esc(o.market)}</td><td>${esc(o.selection)}</td><td>${esc(bookName(o.book))}</td><td class="n">${odd(o.price)}</td><td class="n">${evCell}</td><td><span class="badge ${CONF_BADGE[o.confidence]}">${o.confidence}</span></td><td class="n">${stakeCell}</td></tr>`;
    return `<tr class="click" data-opp="${esc(o.id)}">
      <td>${esc(SPORT_LABEL[o.sport] || o.sport)}</td><td>${esc(o.competition)}</td><td>${esc(o.event)}<div class="faint">${when(o.commence)} · ${until(o.commence)}</div></td>
      <td>${esc(o.market)}</td><td>${esc(o.selection)}</td><td>${esc(bookName(o.book))}</td>
      <td class="n"><b>${odd(o.price)}</b></td><td class="n">${odd(o.refOdds)}</td><td class="n">${pct(o.pEst)}</td><td class="n">${pct(o.pImplied)}</td>
      <td class="n">${evCell}<div><span class="badge ${EVCLASS_BADGE[o.evClass] || 'b-grey'}">${esc(o.evClassLabel)}</span></div></td>
      <td><span class="badge ${CONF_BADGE[o.confidence]}">${o.confidence}</span></td>
      <td class="n">${stakeCell}</td><td class="n">${pct(st.stakePct, 2)}</td><td class="n pos">${eur(st.profit)}</td><td class="n neg">${eur(st.loss)}</td>
      <td>${when(o.quoteUpdatedAt, false)}<div class="faint">${ago(o.quoteUpdatedAt)}</div></td>
      <td>${o.verified ? '<span class="badge b-green">verificada</span>' : '<span class="badge b-amber">pendiente</span>'}${o.flags.includes('posible_error') ? ' <span class="badge b-violet">posible error</span>' : ''}</td></tr>`;
  }).join('');
  return `<div class="table-wrap"><table><thead><tr>${head.map((h) => `<th class="${numeric.has(h) ? 'n' : ''}">${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

// ---------------------------------------------------------------- Ficha
async function openOpp(id) {
  const o = opportunities().find((x) => x.id === id);
  if (!o) return;
  const st = o.stake; const b = bank();
  const histKey = `${o.eventId}|${o.marketKey}|${o.sel}`;
  const favorable = [], risks = [];
  favorable.push(`Cuota ${odd(o.price)} en ${bookName(o.book)} frente a cuota justa estimada ${odd(o.refOdds)} (${spct(o.price / o.refOdds - 1)}).`);
  if (o.sharpN) favorable.push(`Referencia de mercado eficiente: ${o.refBooks.filter((r) => r.sharp).map((r) => bookName(r.book)).join(', ')}.`);
  favorable.push(`${o.nRefs} casas independientes usadas como referencia (sin contar Bet365/Winamax).`);
  if (o.pModel != null) (Math.abs(o.pModel - o.pMarket) < 0.04 ? favorable : risks).push(`Modelo estadístico independiente: ${pct(o.pModel)} vs mercado ${pct(o.pMarket)}.`);
  if (o.seenCount > 1) favorable.push(`Oportunidad persistente en ${o.seenCount} análisis consecutivos.`);
  if (o.bestOther && o.price >= o.bestOther.price) favorable.push(`Es la mejor cuota del mercado (siguiente: ${odd(o.bestOther.price)} en ${bookName(o.bestOther.book)}).`);
  for (const c of o.checks.filter((c) => !c.ok && !(o.exceptional && c.name.startsWith('EV no anómalo')))) risks.push(`${c.name}: ${c.detail}.`);
  if (o.exceptional) risks.push('EV superior al 12%: típico de errores de cotización o información no recogida (lesiones, alineaciones). La casa puede corregir o anular.');
  if (o.modelNote) risks.push(o.modelNote + '.');
  risks.push('Lesiones, bajas y alineaciones: no hay una fuente verificable conectada; compruébalas antes de apostar.');
  if (o.quoteAgeMin > 5) risks.push(`La cuota se observó hace ${num(o.quoteAgeMin, 0)} min; puede haber cambiado.`);

  const books = [...o.allPrices].sort((a, b) => b.price - a.price);
  const pDist = o.dist;
  $('#modal-body').innerHTML = `
  <div class="modal-head">
    <div>
      <div class="muted">${esc(SPORT_LABEL[o.sport] || o.sport)} · ${esc(o.competition)} · ${when(o.commence)} (${until(o.commence)})</div>
      <h2 style="margin:.2rem 0">${esc(o.event)}</h2>
      <div>${esc(o.market)} · <b>${esc(o.selection)}</b> · ${esc(bookName(o.book))} @ <b class="num">${odd(o.price)}</b></div>
      <div class="btn-row" style="margin-top:8px">
        ${o.verified ? '<span class="badge b-green">VERIFICADA</span>' : '<span class="badge b-amber">PENDIENTE DE CONFIRMACIÓN</span>'}
        <span class="badge ${CONF_BADGE[o.confidence]}">confianza ${o.confidence}</span>
        <span class="badge ${EVCLASS_BADGE[o.evClass] || 'b-grey'}">${esc(o.evClassLabel)}</span>
        ${o.flags.map((f) => `<span class="badge b-violet">${esc(f.replace(/_/g, ' '))}</span>`).join('')}
      </div>
    </div>
    <button class="b" data-close>Cerrar</button>
  </div>
  <div class="grid g2">
    <section>
      <h4>Cálculo del EV</h4>
      <div class="calc">
        <div class="row"><span>Cuota decimal</span><span>${odd(o.price)}</span></div>
        <div class="row"><span>Probabilidad implícita (1/cuota)</span><span>${pct(o.pImplied, 2)}</span></div>
        <div class="row"><span>Prob. mercado sin margen (${esc(settings().devigMethod)})</span><span>${pct(o.pMarket, 2)}</span></div>
        ${o.pModel != null ? `<div class="row"><span>Prob. modelo estadístico</span><span>${pct(o.pModel, 2)}</span></div>` : ''}
        <div class="row"><span>Probabilidad estimada</span><span>${pct(o.pEst, 2)} ± ${pct(o.se, 2)}</span></div>
        ${o.pushP ? `<div class="row"><span>Prob. devolución</span><span>${pct(o.pushP, 2)}</span></div>` : ''}
        <div class="row"><span>EV teórico (sólo mercado)</span><span class="${cls(o.evMarketOnly)}">${spct(o.evMarketOnly, 2)}</span></div>
        <div class="row total"><span>EV estimado = Σ p·r ${pDist.length === 2 ? `= ${num(o.pEst, 4)} × ${odd(o.price)} − 1` : ''}</span><span class="${cls(o.evTheoretical)}">${spct(o.evTheoretical, 2)}</span></div>
        <div class="row"><span>Intervalo (±1σ)</span><span>${spct(o.evConservative, 2)} … ${spct(o.evOptimistic, 2)}</span></div>
      </div>
      ${o.distNote ? `<p class="faint" style="font-size:.78rem">${esc(o.distNote)}</p>` : ''}
      ${pDist.length > 2 ? `<div class="table-wrap" style="margin-top:6px"><table><thead><tr><th>Resultado</th><th class="n">Prob.</th><th class="n">Retorno/u</th></tr></thead><tbody>${pDist.map((d) => `<tr><td>${esc(d.label || (d.r > 0 ? 'gana' : d.r < 0 ? 'pierde' : 'devolución'))}</td><td class="n">${pct(d.p, 2)}</td><td class="n">${num(d.r, 3)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    </section>
    <section>
      <h4>Cálculo del stake</h4>
      <div class="calc">
        <div class="row"><span>BANK disponible</span><span>${eur(st.bankroll)}</span></div>
        ${st.steps.map((s) => `<div class="row"><span>${esc(s.k)}</span><span>${pct(s.v, 2)}</span></div>`).join('')}
        <div class="row"><span>Límite máximo por apuesta</span><span>${num(settings().maxStakePct, 1)}%</span></div>
        <div class="row total"><span>Stake recomendado</span><span>${eur(st.stake)} (${pct(st.stakePct, 2)})</span></div>
        <div class="row"><span>Beneficio neto potencial</span><span class="pos">${eur(st.profit)}</span></div>
        <div class="row"><span>Pérdida potencial</span><span class="neg">${eur(st.loss)}</span></div>
        <div class="row"><span>Bank si gana / si pierde</span><span>${eur(b.total + st.profit)} / ${eur(b.total - st.loss)}</span></div>
      </div>
      ${st.reasons.length ? `<ul class="factors faint" style="font-size:.78rem">${st.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
      <p class="faint" style="font-size:.78rem">Kelly: f = (p·cuota − 1)/(cuota − 1)${pDist.length > 2 ? ', generalizado a la distribución real de resultados (maximiza E[ln(1+f·r)])' : ''}. Se aplica ${pct(settings().kellyFraction, 1)} de Kelly, multiplicador por confianza y límites de cartera.</p>
    </section>
  </div>
  <div class="grid g2" style="margin-top:14px">
    <section><h4>Comparación de cuotas (${books.length} casas)</h4>
      <div class="table-wrap" style="max-height:300px;overflow:auto"><table><thead><tr><th>Casa</th><th class="n">Cuota</th><th class="n">vs justa</th><th>Actualizada</th></tr></thead><tbody>
      ${books.map((x) => `<tr ${x.book === o.book ? 'style="background:var(--green-bg)"' : ''}><td>${esc(bookName(x.book))}${o.refBooks.some((r) => r.book === x.book && r.sharp) ? ' <span class="badge b-blue">sharp</span>' : ''}</td><td class="n">${odd(x.price)}</td><td class="n ${cls(x.price / o.refOdds - 1)}">${spct(x.price / o.refOdds - 1)}</td><td>${ago(x.updatedAt)}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="faint" style="font-size:.78rem">Cuota media de referencia: ${odd(o.refMeanOdds)} · Cuota justa (1/p estimada): ${odd(o.refOdds)}</p>
    </section>
    <section><h4>Evolución de la cuota</h4><div id="hist-chart"><div class="empty">Cargando…</div></div></section>
  </div>
  <div class="grid g2" style="margin-top:14px">
    <section><h4>Factores favorables</h4><ul class="factors">${favorable.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></section>
    <section><h4>Factores de riesgo</h4><ul class="factors">${risks.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></section>
  </div>
  <section style="margin-top:14px"><h4>Por qué existe valor (posibles causas)</h4>
    <p>La cuota de ${esc(bookName(o.book))} implica ${pct(o.pImplied)}, mientras que el mercado de referencia sin margen estima ${pct(o.pMarket)}${o.sharpN ? ' (con peso mayor para casas sharp)' : ''}: una diferencia de ${num((o.pMarket - o.pImplied) * 100, 2)} p.p. Suele deberse a que la casa no ha ajustado su precio tras un movimiento del mercado eficiente, a un margen repartido de forma asimétrica o a un error de cotización. No es una garantía: el mercado de referencia también puede equivocarse.</p>
  </section>
  <div class="grid g2" style="margin-top:14px">
    <section><h4>Justificación de la probabilidad y comprobaciones</h4>
      <ul class="factors">${o.checks.map((c) => `<li class="${c.ok ? 'check-ok' : 'check-ko'}">${esc(c.name)} <span class="faint">— ${esc(c.detail)}</span></li>`).join('')}</ul>
      ${o.model ? `<p style="font-size:.82rem;margin-top:8px"><b>Modelo:</b> ${esc(o.model.source)}.<br>λ local ${num(o.model.details.lambdaHome, 2)} · λ visitante ${num(o.model.details.lambdaAway, 2)} · partidos ${o.model.details.matchesHome}/${o.model.details.matchesAway} · equipos «${esc(o.model.details.teams.home)}» / «${esc(o.model.details.teams.away)}»${o.model.details.elo ? `<br>Elo: ${num(o.model.details.elo.ratingHome)} vs ${num(o.model.details.elo.ratingAway)} → 1X2 ${pct(o.model.details.elo.home)} / ${pct(o.model.details.elo.draw)} / ${pct(o.model.details.elo.away)} (contraste, no se mezcla)` : ''}</p>` : ''}
      ${o.marketModel ? `<p class="faint" style="font-size:.78rem">${esc(o.marketModel.source)}: λ ${num(o.marketModel.lambdas.home, 2)} / ${num(o.marketModel.lambdas.away, 2)}</p>` : ''}
    </section>
    <section><h4>Fuentes y fecha de los datos</h4>
      <dl class="kv"><dt>Detectada</dt><dd>${when(o.detectedAt)}</dd><dt>Cuota observada</dt><dd>${when(o.quoteUpdatedAt)} (${ago(o.quoteUpdatedAt)})</dd><dt>Proveedor de la cuota</dt><dd>${esc(o.provider)}</dd></dl>
      <ul class="factors" style="margin-top:8px">${(o.sources || []).map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a> <span class="faint">${esc(s.ref)}</span></li>`).join('')}</ul>
    </section>
  </div>
  <div class="btn-row" style="margin-top:16px;border-top:1px solid var(--line);padding-top:12px">
    <button class="b primary" data-register="real">Registrar apuesta realizada</button>
    <button class="b" data-register="simulada">Registrar como simulada</button>
    <span class="faint" style="font-size:.78rem">El sistema nunca registra apuestas automáticamente.</span>
  </div>`;
  const dlg = $('#modal'); if (!dlg.open) dlg.showModal();
  $('[data-close]', dlg).onclick = () => dlg.close();
  $$('[data-register]', dlg).forEach((btn) => (btn.onclick = () => openBetForm(o, btn.dataset.register)));
  try {
    const h = await api(`/api/history/${encodeURIComponent(histKey)}`);
    const pts = h.points || [];
    const series = [];
    const add = (key, name, color, dashed) => { const p = pts.filter((x) => x[key] > 1).map((x) => ({ x: x.t, y: x[key] })); if (p.length) series.push({ name, color, points: p, dashed }); };
    add(o.book, bookName(o.book), PALETTE[0]);
    for (const k of settings().targetBooks.filter((k) => k !== o.book)) add(k, bookName(k), PALETTE[1 + (series.length % 4)]);
    add('fair', 'Cuota justa', '#9aa5b1', true);
    add('best', 'Mejor cuota', PALETTE[2], true);
    $('#hist-chart').innerHTML = pts.length >= 2 ? lineChart(series, { height: 200, yFmt: (v) => odd(v), title: 'Evolución de la cuota' }) : `<div class="empty">${pts.length ? 'Sólo hay una observación.' : 'Todavía no hay observaciones.'} El historial se construye con cada análisis mientras el sistema está activo.</div>`;
  } catch { $('#hist-chart').innerHTML = '<div class="empty">Sin historial.</div>'; }
}

function openBetForm(o, kind) {
  const st = o?.stake;
  const dlg = $('#modal');
  $('#modal-body').innerHTML = `<div class="modal-head"><h2>${kind === 'real' ? 'Registrar apuesta realizada' : 'Registrar apuesta simulada'}</h2><button class="b" data-close>Cerrar</button></div>
  <form id="bet-form" class="form">
    <label class="f" style="grid-column:1/-1">Evento<input name="event" required value="${esc(o?.event || '')}"></label>
    <label class="f">Deporte<select name="sport">${Object.entries(SPORT_LABEL).map(([k, v]) => `<option value="${k}" ${o?.sport === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    <label class="f">Mercado<input name="market" required value="${esc(o?.market || '')}"></label>
    <label class="f">Selección<input name="selection" required value="${esc(o?.selection || '')}"></label>
    <label class="f">Casa de apuestas<input name="book" required value="${esc(o ? bookName(o.book) : 'Bet365')}"></label>
    <label class="f">Cuota tomada<input name="odds" type="number" step="0.01" min="1.01" required value="${o ? o.price : ''}"></label>
    <label class="f">Stake real (€)<input name="stake" type="number" step="0.01" min="0.01" required value="${st?.stake || ''}"></label>
    <label class="f">Cuota de cierre (opcional)<input name="closingOdds" type="number" step="0.01"></label>
    <label class="f" style="grid-column:1/-1">Nota<input name="note"></label>
    <div id="bet-ev" style="grid-column:1/-1" class="muted"></div>
    <div class="btn-row" style="grid-column:1/-1"><button class="b primary" type="submit">Guardar</button></div>
  </form>`;
  if (!dlg.open) dlg.showModal();
  $('[data-close]', dlg).onclick = () => dlg.close();
  const form = $('#bet-form');
  const evInfo = () => {
    if (!o) return;
    const newOdds = Number(form.odds.value);
    if (!(newOdds > 1)) return;
    const d = o.dist.map((x) => ({ ...x, r: x.r > 0 ? (x.r * (newOdds - 1)) / (o.price - 1) : x.r }));
    const ev = expectedValueDist(d);
    $('#bet-ev').innerHTML = `Con cuota ${odd(newOdds)}: EV estimado <b class="${cls(ev)}">${spct(ev, 2)}</b> · Kelly completo ${pct(kellyDist(d), 2)}${ev <= 0 ? ' — <b class="neg">la apuesta ya no tiene valor esperado positivo: no se recomienda.</b>' : ''}${Number(form.stake.value) > (st?.stake || Infinity) ? ' — <b class="warn">stake superior al recomendado.</b>' : ''}`;
    form.dataset.ev = ev;
  };
  form.oninput = evInfo; evInfo();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    try {
      await api('/api/bets', { method: 'POST', body: { ...fd, kind, odds: Number(fd.odds), stake: Number(fd.stake), closingOdds: fd.closingOdds ? Number(fd.closingOdds) : null,
        opportunityId: o?.id, eventId: o?.eventId, marketKey: o?.marketKey, sel: o?.sel, eventStart: o?.commence, competition: o?.competition, marketGroup: o?.marketGroup,
        pAtBet: o?.pEst, evAtBet: o ? Number(form.dataset.ev) : null, recommendedStake: st?.stake } });
      dlg.close(); toast('Apuesta registrada'); await refresh();
    } catch (err) { toast(err.message, 4000); }
  };
}

// ---------------------------------------------------------------- Escáner
function vScanner() {
  const sc = scan();
  if (!sc) return dataBanner();
  const q = S.scanSearch.toLowerCase();
  const evs = sc.rows.filter((r) => (!S.scanSport || r.sport === S.scanSport) && (!q || r.event.toLowerCase().includes(q) || r.competition.toLowerCase().includes(q)));
  const targets = settings().targetBooks;
  const shown = evs.slice(0, S.scanLimit);
  return `${dataBanner()}
  <div class="panel-head"><h2>Escáner de cuotas</h2><span class="muted">${evs.length} eventos · ${num(sc.marketsAnalyzed)} mercados · ${when(sc.at)}</span></div>
  <div class="btn-row" style="margin-bottom:12px">
    <div class="seg" id="scan-sport">${[['', 'Todos'], ...Object.entries(SPORT_LABEL)].map(([k, v]) => `<button data-v="${k}" class="${S.scanSport === k ? 'on' : ''}">${v}</button>`).join('')}</div>
    <input id="scan-search" placeholder="Buscar equipo o competición" value="${esc(S.scanSearch)}" style="min-width:220px">
  </div>
  ${shown.map((ev) => `<details class="panel" style="margin-bottom:8px" ${evs.length <= 3 ? 'open' : ''}>
    <summary><b>${esc(ev.event)}</b> <span class="muted">· ${esc(SPORT_LABEL[ev.sport])} · ${esc(ev.competition)} · ${when(ev.commence)} · ${ev.nBooks} casas · fuentes: ${ev.sources.join(', ')}</span></summary>
    <div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>Mercado</th><th>Selección</th>${targets.map((t) => `<th class="n">${esc(bookName(t))}</th>`).join('')}<th class="n">Mejor</th><th>Casa</th><th class="n">Justa</th><th class="n">Prob.</th><th class="n">Casas</th></tr></thead><tbody>
    ${ev.markets.map((m) => m.sels.map((s, i) => `<tr><td>${i ? '' : esc(m.label)}</td><td>${esc(s.label)}</td>${targets.map((t) => { const q = s.targets[t]; const v = q && s.fair ? q.price / s.fair - 1 : null; return `<td class="n ${v != null && v > 0.02 ? 'pos' : ''}">${q ? odd(q.price) : '<span class="faint">—</span>'}</td>`; }).join('')}<td class="n">${s.best ? odd(s.best.price) : '—'}</td><td>${s.best ? esc(bookName(s.best.book)) : ''}</td><td class="n">${odd(s.fair)}</td><td class="n">${pct(s.p)}</td><td class="n">${i ? '' : m.nBooks}</td></tr>`).join('')).join('')}
    </tbody></table></div></details>`).join('')}
  ${evs.length > shown.length ? `<button class="b" id="scan-more">Mostrar más (${evs.length - shown.length})</button>` : ''}
  ${!evs.length ? '<div class="empty">Sin eventos.</div>' : ''}`;
}

// ---------------------------------------------------------------- Errores de cuota
function vErrors() {
  const sc = scan();
  if (!sc) return dataBanner();
  const all = sc.anomalies || [];
  const tabs = [['error', 'Posibles errores de cotización'], ['desactualizada', 'Cuotas no actualizadas'], ['diferencia', 'Diferencias Bet365 / Winamax'], ['arbitraje', 'Arbitrajes']];
  const list = all.filter((a) => a.category === S.errTab);
  const explain = {
    error: 'Cuota de Bet365/Winamax muy superior a la media del mercado (≥ ' + settings().errorThresholdPct + '% y z ≥ 2,5). Puede ser un error de la casa: es habitual que se corrija o se anule la apuesta.',
    desactualizada: 'La casa no ha cambiado su precio desde hace ≥ ' + settings().staleGapMinutes + ' min mientras el resto del mercado sí, y su cuota está ≥ 4% por encima de la media.',
    diferencia: 'Diferencia ≥ ' + settings().diffThresholdPct + '% entre Bet365 y Winamax para la misma selección. Una diferencia NO implica valor: compárala con la cuota justa.',
    arbitraje: 'Combinación de mejores cuotas de distintas casas cuya suma de probabilidades implícitas es < 100%. Riesgos: cambios de cuota antes de completar todas las patas, límites y anulaciones.',
  };
  let table;
  if (S.errTab === 'arbitraje') {
    table = list.length ? `<div class="table-wrap"><table><thead><tr><th>Evento</th><th>Mercado</th><th class="n">Margen</th><th>Patas (reparto por 100 €)</th><th>Implica casa objetivo</th><th>Detectado</th><th>Verificación</th></tr></thead><tbody>
      ${list.map((a) => `<tr><td>${esc(a.event)}<div class="faint">${when(a.commence)}</div></td><td>${esc(a.market)}</td><td class="n pos">${pct(a.margin, 2)}</td><td class="wrap">${a.legs.map((l) => `${esc(l.label)} @ <b>${odd(l.price)}</b> ${esc(bookName(l.book))} → ${eur(100 * l.share)}`).join('<br>')}</td><td>${a.involvesTarget ? 'sí' : 'no'}</td><td>${when(a.detectedAt, false)}</td><td><span class="badge b-amber">${esc(a.verification)}</span></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No se han detectado arbitrajes.</div>';
  } else {
    table = list.length ? `<div class="table-wrap"><table><thead><tr><th>Evento</th><th>Mercado</th><th>Selección</th><th>Casa</th><th class="n">Bet365</th><th class="n">Winamax</th><th class="n">Mejor</th><th class="n">Media ref.</th><th class="n">Diferencia</th><th class="n">Prob. est.</th><th class="n">EV</th><th>Detectado</th><th>Cuota observada</th><th>Verificación</th></tr></thead><tbody>
      ${list.map((a) => {
        const tp = a.targetPrices || {};
        const wm = Object.entries(tp).filter(([k]) => isWinamax(k)).map(([, v]) => v);
        const best = Math.max(...Object.values(tp));
        const nonTarget = Object.entries(tp).filter(([k]) => !settings().targetBooks.includes(k)).map(([, v]) => v);
        const refMean = a.refMean ?? (nonTarget.length ? nonTarget.reduce((x, y) => x + y, 0) / nonTarget.length : null);
        const diff = a.diffPct;
        return `<tr><td>${esc(a.event)}<div class="faint">${when(a.commence)}</div></td><td>${esc(a.market)}</td><td>${esc(a.selection)}</td><td>${esc(bookName(a.book))}</td>
        <td class="n">${tp.bet365 ? odd(tp.bet365) : '—'}</td><td class="n">${wm.length ? odd(Math.max(...wm)) : '—'}</td><td class="n">${odd(best)}</td><td class="n">${odd(refMean)}</td>
        <td class="n pos">${spct(diff)}</td><td class="n">${pct(a.pEst)}</td><td class="n ${cls(a.evTheoretical)}">${spct(a.evTheoretical)}</td>
        <td>${when(a.detectedAt, false)}</td><td>${ago(a.quoteUpdatedAt)}${a.gapMin ? `<div class="faint">sin cambios ${num(a.gapMin)} min</div>` : ''}</td><td><span class="badge ${a.seenCount > 1 ? 'b-blue' : 'b-amber'}">${esc(a.verification)}</span></td></tr>`;
      }).join('')}</tbody></table></div>` : '<div class="empty">No se han detectado casos en el último análisis.</div>';
  }
  return `${dataBanner()}<div class="panel-head"><h2>Errores de cuota y discrepancias</h2></div>
  <div class="notice info">Se distinguen cuatro cosas: <b>value bet estadística</b> (sección Value Bets), <b>diferencia de cuota entre casas</b>, <b>posible error de cotización</b> y <b>arbitraje</b>. Una diferencia de cuotas no es una apuesta de valor garantizado.</div>
  <div class="seg" id="err-tabs" style="margin-bottom:12px">${tabs.map(([k, v]) => `<button data-v="${k}" class="${S.errTab === k ? 'on' : ''}">${v} (${all.filter((a) => a.category === k).length})</button>`).join('')}</div>
  <p class="muted">${esc(explain[S.errTab])}</p>${table}`;
}

// ---------------------------------------------------------------- Bankroll
function vBankroll() {
  const b = bank(); const s = settings(); const bets = S.data.bets.filter((x) => x.kind === 'real');
  const sum = summarize(bets, b.invested);
  const curve = bankrollCurve(S.data.bankroll, S.data.bets);
  const txs = [...(S.data.bankroll.transactions || [])].reverse();
  return `<div class="panel-head"><h2>Gestión del bankroll</h2></div>
  <div class="grid g4">
    ${card('Bank inicial', eur(b.initial))}${card('Bank actual', eur(b.total), `Movimientos netos ${eur(b.deposits - b.withdrawals + b.adjustments)}`)}
    ${card('Beneficio acumulado', `<span class="${cls(b.settledPL)}">${eur(b.settledPL)}</span>`, `Rentabilidad ${spct(b.returnPct)}`)}
    ${card('Comprometido / disponible', `${eur(b.committed)}`, `Disponible ${eur(b.available)}`)}
    ${card('Apuestas realizadas', num(sum.n), `${sum.pending} pendientes`)}${card('Stake medio', eur(sum.avgStake))}
    ${card('EV medio', spct(sum.avgEV, 2))}${card('Yield', spct(sum.yield, 2), `ROI ${spct(sum.roi, 2)}`)}
  </div>
  <div class="grid g2" style="margin-top:14px">
    <section class="panel"><h3>Configuración del bank</h3>
      <form id="bank-form" class="form">
        <label class="f">Bank inicial (€)<input type="number" step="0.01" min="0" name="initial" value="${b.initial || ''}"></label>
        <label class="f">Bank actual (€)<input type="number" step="0.01" min="0" name="current" value="${b.total || ''}"><span class="faint">si difiere, se registra un ajuste</span></label>
        <label class="f">Stake máximo por apuesta (%)<input type="number" step="0.1" min="0" name="maxStakePct" value="${s.maxStakePct}"></label>
        <label class="f">Exposición máx. simultánea (%)<input type="number" step="0.1" min="0" name="maxExposurePct" value="${s.maxExposurePct}"></label>
        <label class="f">Máx. por evento (%)<input type="number" step="0.1" min="0" name="maxEventPct" value="${s.maxEventPct}"></label>
        <label class="f">Estrategia<select name="strategy"><option value="kelly" ${s.strategy === 'kelly' ? 'selected' : ''}>Kelly fraccionado</option><option value="flat" ${s.strategy === 'flat' ? 'selected' : ''}>Stake plano (%)</option></select></label>
        <label class="f">Fracción de Kelly<select name="kellyFraction">${KELLY_FRACTIONS.map((k) => `<option value="${k.value}" ${Number(s.kellyFraction) === k.value ? 'selected' : ''}>${k.label} (${k.value * 100}%)</option>`).join('')}</select></label>
        <label class="f">Stake plano (%)<input type="number" step="0.1" min="0" name="flatStakePct" value="${s.flatStakePct}"></label>
        <label class="f">Stake mínimo (€)<input type="number" step="0.5" min="0" name="minStake" value="${s.minStake}"></label>
        <div class="btn-row"><button class="b primary" type="submit">Guardar</button></div>
      </form>
      <p class="faint" style="font-size:.78rem">El stake se calcula sobre el bank disponible (no el inicial). Nunca se aumenta el stake para recuperar pérdidas.</p>
    </section>
    <section class="panel"><h3>Añadir o retirar dinero</h3>
      <form id="tx-form" class="form">
        <label class="f">Tipo<select name="type"><option value="deposit">Ingreso</option><option value="withdraw">Retirada</option></select></label>
        <label class="f">Importe (€)<input type="number" step="0.01" min="0.01" name="amount" required></label>
        <label class="f">Nota<input name="note"></label>
        <div class="btn-row"><button class="b" type="submit">Registrar</button></div>
      </form>
      <div class="table-wrap" style="margin-top:10px;max-height:200px;overflow:auto"><table><thead><tr><th>Fecha</th><th>Tipo</th><th class="n">Importe</th><th>Nota</th></tr></thead><tbody>
      ${txs.length ? txs.map((t) => `<tr><td>${when(t.date)}</td><td>${{ deposit: 'Ingreso', withdraw: 'Retirada', adjust: 'Ajuste' }[t.type]}</td><td class="n ${t.type === 'withdraw' ? 'neg' : cls(t.amount)}">${eur(t.type === 'withdraw' ? -t.amount : t.amount)}</td><td>${esc(t.note)}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">Sin movimientos</td></tr>'}
      </tbody></table></div>
    </section>
  </div>
  <section class="panel" style="margin-top:14px"><h3>Evolución del bankroll</h3>
    ${curve.length > 1 ? lineChart([{ name: 'Bankroll', color: PALETTE[0], points: curve.map((p) => ({ x: new Date(p.at).getTime(), y: p.v })) }], { yFmt: (v) => eur(v, 0), width: 1500, height: 300 }) : '<div class="empty">Aún no hay apuestas liquidadas.</div>'}
  </section>
  ${simulator()}`;
}

function simulator() {
  const b = bank(); const sim = S.sim || (S.sim = { odds: 2.2, p: 50, stake: '', n: 200 });
  const p = sim.p / 100, o = sim.odds;
  const fk = kellyBinary(p, o);
  const bk = b.total || 0;
  const rec = Math.min(fk * settings().kellyFraction, settings().maxStakePct / 100) * bk;
  const stake = sim.stake !== '' ? Number(sim.stake) : rec;
  const ev = p * o - 1;
  const rows = [0.005, 0.01, 0.02, 0.03, 0.05].map((f) => ({ k: `${num(f * 100, 1)}% del bank`, s: bk * f }))
    .concat(KELLY_FRACTIONS.map((k) => ({ k: k.label, s: bk * fk * k.value })));
  return `<section class="panel" style="margin-top:14px"><h3>Simulador de bankroll</h3>
    <form id="sim-form" class="form">
      <label class="f">Cuota<input type="number" step="0.01" min="1.01" name="odds" value="${sim.odds}"></label>
      <label class="f">Probabilidad estimada (%)<input type="number" step="0.1" min="0.1" max="99.9" name="p" value="${sim.p}"></label>
      <label class="f">Stake (€) <input type="number" step="0.5" min="0" name="stake" value="${sim.stake}" placeholder="${num(rec, 2)} (recomendado)"></label>
      <label class="f">Nº de apuestas (evolución)<input type="number" step="10" min="10" max="2000" name="n" value="${sim.n}"></label>
    </form>
    <div class="grid g3" style="margin-top:12px">
      <div class="calc"><div class="row"><span>Bank actual</span><span>${eur(bk)}</span></div><div class="row"><span>EV</span><span class="${cls(ev)}">${spct(ev, 2)}</span></div><div class="row"><span>Kelly completo</span><span>${pct(fk, 2)}</span></div>
        <div class="row total"><span>Si gana</span><span class="pos">+${eur(stake * (o - 1))} → ${eur(bk + stake * (o - 1))}</span></div>
        <div class="row"><span>Si pierde</span><span class="neg">−${eur(stake)} → ${eur(bk - stake)}</span></div>
        <div class="row"><span>Resultado esperado</span><span class="${cls(ev)}">${eur(stake * ev)}</span></div></div>
      <div class="table-wrap" style="grid-column:span 2"><table><thead><tr><th>Stake</th><th class="n">€</th><th class="n">Gana</th><th class="n">Pierde</th><th class="n">Bank tras pérdida</th><th class="n">Esperado</th></tr></thead><tbody>
        ${rows.map((r) => `<tr><td>${r.k}</td><td class="n">${eur(r.s)}</td><td class="n pos">${eur(r.s * (o - 1))}</td><td class="n neg">${eur(-r.s)}</td><td class="n">${eur(bk - r.s)}</td><td class="n ${cls(ev)}">${eur(r.s * ev)}</td></tr>`).join('')}
      </tbody></table></div>
    </div>
    <h4 style="margin-top:14px">Evolución simulada (Monte Carlo, ${sim.n} apuestas idénticas, 400 trayectorias)</h4>
    <div id="mc">${monteCarlo(bk || 1000, p, o, sim.n)}</div>
    <p class="faint" style="font-size:.78rem">Supone que la probabilidad estimada es correcta. Si el modelo sobreestima la ventaja, Kelly completo puede llevar a pérdidas grandes: por eso se usa Kelly fraccionado.</p>
  </section>`;
}

function monteCarlo(bk, p, o, n) {
  const fk = kellyBinary(p, o);
  const strategies = [
    { name: `Cuarto de Kelly`, f: fk * 0.25, color: PALETTE[0] },
    { name: `Medio Kelly`, f: fk * 0.5, color: PALETTE[2] },
    { name: `Kelly completo`, f: fk, color: PALETTE[6] },
  ];
  if (!(fk > 0)) return '<div class="empty">Con EV ≤ 0 Kelly recomienda no apostar (stake 0).</div>';
  let seed = 12345; const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const paths = 400, step = Math.max(1, Math.floor(n / 60));
  const series = []; const summary = [];
  for (const st of strategies) {
    const qs = []; let below = 0; const finals = [];
    const snaps = Array.from({ length: Math.floor(n / step) + 1 }, () => []);
    for (let k = 0; k < paths; k++) {
      let v = bk; snaps[0].push(v);
      for (let i = 1; i <= n; i++) { const s = v * st.f; v += rnd() < p ? s * (o - 1) : -s; if (i % step === 0) snaps[i / step].push(v); }
      finals.push(v); if (v < bk) below++;
    }
    snaps.forEach((arr, i) => { arr.sort((a, b) => a - b); qs.push({ x: i * step, p10: arr[Math.floor(arr.length * 0.1)], p50: arr[Math.floor(arr.length * 0.5)], p90: arr[Math.floor(arr.length * 0.9)] }); });
    series.push({ name: `${st.name} (mediana, banda p10–p90)`, color: st.color, points: qs.map((q) => ({ x: q.x, y: q.p50 })), band: qs.map((q) => ({ x: q.x, lo: q.p10, hi: q.p90 })) });
    finals.sort((a, b) => a - b);
    summary.push(`<tr><td>${st.name}</td><td class="n">${pct(st.f, 2)}</td><td class="n">${eur(finals[Math.floor(paths / 2)])}</td><td class="n">${eur(finals[Math.floor(paths * 0.1)])}</td><td class="n">${pct(below / paths, 0)}</td></tr>`);
  }
  return lineChart(series, { xType: 'n', yFmt: (v) => eur(v, 0), height: 320, width: 1500 }) +
    `<div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>Estrategia</th><th class="n">Fracción</th><th class="n">Mediana final</th><th class="n">Percentil 10</th><th class="n">P(acabar en pérdidas)</th></tr></thead><tbody>${summary.join('')}</tbody></table></div>`;
}

// ---------------------------------------------------------------- Historial
function vHistory() {
  const bets = S.data.bets.filter((b) => b.kind === S.histKind).slice().reverse();
  const results = [['pendiente', 'Pendiente'], ['ganada', 'Ganada'], ['perdida', 'Perdida'], ['anulada', 'Anulada'], ['media_ganada', '½ ganada'], ['media_perdida', '½ perdida']];
  const log = [...S.data.opportunityLog].reverse().slice(0, 300);
  return `<div class="panel-head"><h2>Historial de apuestas</h2><div class="btn-row"><div class="seg" id="hist-kind"><button data-v="real" class="${S.histKind === 'real' ? 'on' : ''}">Realizadas</button><button data-v="simulada" class="${S.histKind === 'simulada' ? 'on' : ''}">Simuladas</button></div><button class="b primary" id="new-bet">+ Registrar apuesta manual</button></div></div>
  <div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Evento</th><th>Mercado</th><th>Selección</th><th>Casa</th><th class="n">Cuota</th><th class="n">Stake</th><th class="n">EV al apostar</th><th>Resultado</th><th class="n">P/L</th><th class="n">Cuota cierre</th><th class="n">CLV</th><th></th></tr></thead><tbody>
  ${bets.length ? bets.map((b) => { const c = clv(b); return `<tr>
    <td>${when(b.createdAt)}</td><td>${esc(b.event)}</td><td>${esc(b.market)}</td><td>${esc(b.selection)}</td><td>${esc(b.book)}</td>
    <td class="n">${odd(b.odds)}</td><td class="n">${eur(b.stake)}${b.recommendedStake != null && b.stake > b.recommendedStake + 0.01 ? ' <span class="badge b-amber" title="Superior al recomendado">↑</span>' : ''}</td><td class="n">${spct(b.evAtBet, 2)}</td>
    <td><select data-result="${b.id}">${results.map(([k, v]) => `<option value="${k}" ${b.result === k ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
    <td class="n ${cls(betPL(b))}">${b.result === 'pendiente' ? '—' : eur(betPL(b))}</td>
    <td class="n"><input data-close-odds="${b.id}" type="number" step="0.01" style="width:78px" value="${b.closingOdds ?? ''}" title="${esc(b.closingSource || 'Cuota de cierre (manual o capturada automáticamente si el análisis estaba activo)')}"></td>
    <td class="n ${cls(c)}">${spct(c, 1)}</td><td><button class="b sm danger" data-del="${b.id}" aria-label="Eliminar">✕</button></td></tr>`; }).join('') : '<tr><td colspan="13" class="empty">Sin apuestas registradas.</td></tr>'}
  </tbody></table></div>
  <p class="faint" style="font-size:.78rem">El bankroll se actualiza al marcar el resultado. Las apuestas simuladas no afectan al bank.</p>
  <div class="panel-head" style="margin-top:22px"><h3>Oportunidades detectadas (aunque no se apostaran)</h3><span class="muted">${S.data.opportunityLog.length} registradas</span></div>
  <div class="table-wrap" style="max-height:480px;overflow:auto"><table><thead><tr><th>Detectada</th><th>Evento</th><th>Mercado</th><th>Selección</th><th>Casa</th><th class="n">Cuota</th><th class="n">EV</th><th>Conf.</th><th class="n">Visto</th><th>Estado</th><th class="n">Cierre justo</th><th class="n">CLV</th></tr></thead><tbody>
  ${log.length ? log.map((o) => { const c = o.closingFairOdds ? o.price / o.closingFairOdds - 1 : null; return `<tr><td>${when(o.firstSeen)}</td><td>${esc(o.event)}</td><td>${esc(o.market)}</td><td>${esc(o.selection)}</td><td>${esc(bookName(o.book))}</td><td class="n">${odd(o.price)}</td><td class="n ${cls(o.evTheoretical)}">${spct(o.evTheoretical, 2)}</td><td><span class="badge ${CONF_BADGE[o.confidence]}">${o.confidence}</span></td><td class="n">${o.seenCount}×</td><td>${esc(o.status)}</td><td class="n">${odd(o.closingFairOdds)}</td><td class="n ${cls(c)}">${spct(c)}</td></tr>`; }).join('') : '<tr><td colspan="12" class="empty">Sin oportunidades registradas todavía.</td></tr>'}
  </tbody></table></div>`;
}

// ---------------------------------------------------------------- Estadísticas
function vStats() {
  const per = PERIODS.find((p) => p.key === S.period);
  const real = filterPeriod(S.data.bets.filter((b) => b.kind === 'real'), per.days);
  const simu = filterPeriod(S.data.bets.filter((b) => b.kind === 'simulada'), per.days);
  const s = summarize(real, bank().invested);
  const ss = summarize(simu);
  const oc = opportunityCLV(filterPeriod(S.data.opportunityLog, per.days, 'firstSeen'));
  const groupTable = (title, groups, labelFn = (k) => k) => `<section class="panel"><h3>${title}</h3>${groups.length ? `<div class="table-wrap"><table><thead><tr><th></th><th class="n">Apuestas</th><th class="n">Aciertos</th><th class="n">P/L</th><th class="n">Yield</th><th class="n">EV medio</th><th class="n">CLV medio</th></tr></thead><tbody>${groups.map((g) => `<tr><td>${esc(labelFn(g.key))}</td><td class="n">${g.n}</td><td class="n">${pct(g.hitRate)}</td><td class="n ${cls(g.pl)}">${eur(g.pl)}</td><td class="n ${cls(g.yield)}">${spct(g.yield)}</td><td class="n">${spct(g.avgEV)}</td><td class="n ${cls(g.avgCLV)}">${spct(g.avgCLV)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Sin datos.</div>'}</section>`;
  return `<div class="panel-head"><h2>Estadísticas y rentabilidad</h2><div class="seg" id="period">${PERIODS.map((p) => `<button data-v="${p.key}" class="${S.period === p.key ? 'on' : ''}">${p.label}</button>`).join('')}</div></div>
  <div class="grid g4">
    ${card('Apuestas', num(s.n), `${s.settled} liquidadas · ${s.pending} pendientes`)}${card('% aciertos', pct(s.hitRate))}
    ${card('Beneficio / pérdida', `<span class="${cls(s.pl)}">${eur(s.pl)}</span>`, `Esperado según EV: ${eur(s.expectedPL)}`)}${card('ROI', spct(s.roi, 2), 'sobre capital aportado')}
    ${card('Yield', spct(s.yield, 2), `sobre ${eur(s.staked)} apostados`)}${card('EV medio', spct(s.avgEV, 2))}
    ${card('CLV medio', `<span class="${cls(s.avgCLV)}">${spct(s.avgCLV, 2)}</span>`, s.clvN ? `${s.clvN} con cuota de cierre · ${pct(s.clvPositive, 0)} baten el cierre` : 'Sin cuotas de cierre')}
    ${card('Modelo: CLV de oportunidades', `<span class="${cls(oc.avgCLV)}">${spct(oc.avgCLV, 2)}</span>`, `${oc.measured} de ${oc.n} medidas · ${pct(oc.beatClose, 0)} baten el cierre`)}
  </div>
  <div class="notice info" style="margin-top:14px">El <b>CLV</b> (cuota tomada frente a la de cierre) es el mejor indicador temprano de si el modelo encuentra valor real: con pocas apuestas el beneficio está dominado por la varianza. El cierre se captura automáticamente sólo si el análisis estaba activo cerca del inicio del evento; si no, puedes introducirlo a mano en el historial.</div>
  <div class="grid g2" style="margin-top:14px">
    ${groupTable('Por deporte', groupBy(real, (b) => b.sport || '—'), (k) => SPORT_LABEL[k] || k)}
    ${groupTable('Por casa de apuestas', groupBy(real, (b) => b.book || '—'))}
    ${groupTable('Por mercado', groupBy(real, (b) => b.marketGroup || b.market || '—'))}
    <section class="panel"><h3>Apuestas simuladas</h3><dl class="kv"><dt>Apuestas</dt><dd>${ss.n}</dd><dt>Aciertos</dt><dd>${pct(ss.hitRate)}</dd><dt>P/L</dt><dd class="${cls(ss.pl)}">${eur(ss.pl)}</dd><dt>Yield</dt><dd>${spct(ss.yield)}</dd><dt>EV medio</dt><dd>${spct(ss.avgEV)}</dd><dt>CLV medio</dt><dd>${spct(ss.avgCLV)}</dd></dl></section>
  </div>`;
}

// ---------------------------------------------------------------- Configuración
function vConfig() {
  const s = settings(); const k = S.data.keys; const p = s.providers;
  const allTargets = ['bet365', 'bet365_es', 'winamax_fr', 'winamax_es', 'winamax_de'];
  return `<div class="panel-head"><h2>Configuración</h2></div>
  <div class="grid g2">
    <section class="panel"><h3>Claves API (se guardan sólo en el servidor local)</h3>
      <form id="keys-form" class="form" autocomplete="off">
        <label class="f" style="grid-column:1/-1">The Odds API — Winamax FR/DE, Pinnacle, Betfair y ~25 casas
          <input type="password" name="theoddsapi" placeholder="${k.theoddsapi.configured ? `Configurada (${esc(k.theoddsapi.hint)}, ${esc(k.theoddsapi.source)})` : 'Pega tu clave'}"></label>
        <label class="f" style="grid-column:1/-1">OddsPapi — Bet365, Winamax FR/ES/DE y Pinnacle
          <input type="password" name="oddspapi" placeholder="${k.oddspapi.configured ? `Configurada (${esc(k.oddspapi.hint)}, ${esc(k.oddspapi.source)})` : 'Pega tu clave'}"></label>
        <div class="btn-row"><button class="b primary" type="submit">Guardar claves</button><button class="b danger" type="button" id="clear-keys">Borrar claves guardadas</button></div>
      </form>
      <p class="faint" style="font-size:.78rem">Las claves nunca se envían al navegador ni se incluyen en el código cliente: el servidor las guarda en <code>data/secrets.json</code> (permisos 600) o las lee de <code>THE_ODDS_API_KEY</code>/<code>ODDSPAPI_KEY</code>.</p>
      <details><summary>¿Por qué estas fuentes?</summary>
        <ul class="factors" style="font-size:.82rem">
          <li><b>Bet365</b> y <b>Winamax</b> no ofrecen API pública. Extraer datos de sus webs vulneraría sus condiciones, así que se usan agregadores con licencia.</li>
          <li><b>The Odds API</b> (the-odds-api.com): incluye winamax_fr y winamax_de en la región EU, además de Pinnacle y Betfair Exchange como referencias. No incluye Bet365 en Europa. Plan gratuito: 500 créditos/mes (1 crédito por región y mercado).</li>
          <li><b>OddsPapi</b> (oddspapi.io): incluye bet365 y winamax (FR/ES/DE). Plan gratuito ≈ 250 peticiones/mes (1 por partido): para uso continuo hace falta un plan de pago.</li>
          <li><b>football-data.co.uk</b>: resultados y xG gratuitos para el modelo de Poisson y el Elo (ligas domésticas europeas).</li>
        </ul></details>
    </section>
    <section class="panel"><h3>Proveedores y escaneo</h3>
      <form id="prov-form" class="form">
        <label class="chk"><input type="checkbox" name="toa" ${p.theoddsapi.enabled ? 'checked' : ''}>The Odds API</label>
        <label class="chk"><input type="checkbox" name="op" ${p.oddspapi.enabled ? 'checked' : ''}>OddsPapi</label>
        <label class="chk"><input type="checkbox" name="fd" ${p.footballdata.enabled ? 'checked' : ''}>Modelo football-data</label>
        <label class="chk"><input type="checkbox" name="tennis" ${p.theoddsapi.includeActiveTennis ? 'checked' : ''}>Tenis (torneos activos)</label>
        <label class="f">Regiones The Odds API<input name="regions" value="${esc(p.theoddsapi.regions.join(','))}"></label>
        <label class="f">Mercados The Odds API<input name="markets" value="${esc(p.theoddsapi.markets.join(','))}"></label>
        <label class="f">Máx. partidos OddsPapi/escaneo<input type="number" min="1" max="200" name="maxFixtures" value="${p.oddspapi.maxFixtures}"></label>
        <label class="f">Horizonte (horas)<input type="number" min="1" max="240" name="horizonHours" value="${s.horizonHours}"></label>
        <label class="f">Actualización (segundos)<input type="number" min="60" max="3600" name="refreshSeconds" value="${s.refreshSeconds}"></label>
        <label class="f" style="grid-column:1/-1">Competiciones The Odds API (claves separadas por comas)<textarea name="sports" rows="3">${esc(p.theoddsapi.sports.join(', '))}</textarea></label>
        <div class="btn-row"><button class="b primary" type="submit">Guardar</button></div>
      </form>
      <p class="faint" style="font-size:.78rem">Coste aproximado por ciclo en The Odds API: competiciones activas × mercados × regiones = hasta ${p.theoddsapi.sports.length * p.theoddsapi.markets.length * p.theoddsapi.regions.length} créditos (más el tenis activo).</p>
    </section>
    <section class="panel"><h3>Motor de detección</h3>
      <form id="engine-form" class="form">
        <div style="grid-column:1/-1" class="btn-row">${allTargets.map((t) => `<label class="chk"><input type="checkbox" name="t_${t}" ${s.targetBooks.includes(t) ? 'checked' : ''}>${bookName(t)}</label>`).join('')}</div>
        <label class="f">EV mínimo (%)<input type="number" step="0.5" name="minEV" value="${s.minEV * 100}"></label>
        <label class="f">Cuota obsoleta tras (min)<input type="number" name="staleMinutes" value="${s.staleMinutes}"></label>
        <label class="f">Casas de referencia mín.<input type="number" min="2" name="minRefBooks" value="${s.minRefBooks}"></label>
        <label class="f">Método sin margen<select name="devigMethod">${['power', 'multiplicative', 'shin'].map((m) => `<option ${s.devigMethod === m ? 'selected' : ''} value="${m}">${{ power: 'Potencia', multiplicative: 'Multiplicativo', shin: 'Shin' }[m]}</option>`).join('')}</select></label>
        <label class="f">Peso modelo estadístico<input type="number" step="0.05" min="0" max="0.5" name="modelWeight" value="${s.modelWeight}"></label>
        <label class="f">Umbral error de cuota (%)<input type="number" name="errorThresholdPct" value="${s.errorThresholdPct}"></label>
        <label class="f">Umbral diferencia casas (%)<input type="number" name="diffThresholdPct" value="${s.diffThresholdPct}"></label>
        <label class="f">EV excepcional (%)<input type="number" name="exceptionalEV" value="${s.exceptionalEV * 100}"></label>
        <label class="f">Cuota mínima<input type="number" step="0.01" name="minOdds" value="${s.minOdds}"></label>
        <label class="f">Cuota máxima<input type="number" step="0.01" name="maxOdds" value="${s.maxOdds}"></label>
        <div class="btn-row"><button class="b primary" type="submit">Guardar</button></div>
      </form>
    </section>
    <section class="panel"><h3>Datos y registro de errores</h3>
      <div class="btn-row"><a class="b" href="/api/export" download="tipster-copia.json" style="text-decoration:none">Exportar copia (JSON)</a><label class="b" style="cursor:pointer">Importar copia<input type="file" id="import" accept="application/json" class="sr"></label><button class="b" id="clear-errors">Vaciar registro</button></div>
      <div class="table-wrap" style="margin-top:10px;max-height:260px;overflow:auto"><table><thead><tr><th>Fecha</th><th>Origen</th><th>Mensaje</th></tr></thead><tbody>
      ${S.data.errors.length ? S.data.errors.map((e) => `<tr><td>${when(e.at)}</td><td>${esc(e.source)}</td><td class="wrap">${esc(e.message)}</td></tr>`).join('') : '<tr><td colspan="3" class="empty">Sin errores.</td></tr>'}
      </tbody></table></div>
    </section>
  </div>`;
}

// ---------------------------------------------------------------- Eventos
function bind(root) {
  $$('.js-toggle', root).forEach((b) => (b.onclick = toggle));
  $$('[data-opp]', root).forEach((tr) => (tr.onclick = () => openOpp(tr.dataset.opp)));
  const f = $('#filters', root);
  if (f) f.oninput = () => {
    const d = Object.fromEntries(new FormData(f));
    Object.assign(S.filters, d, { next24: !!d.next24, verified: !!d.verified, errors: !!d.errors });
    const pos = f.querySelector(':focus')?.name;
    render();
    if (pos) $(`#filters [name="${pos}"]`)?.focus();
  };
  const seg = (id, key) => { const el = $(`#${id}`, root); if (el) $$('button', el).forEach((b) => (b.onclick = () => { S[key] = b.dataset.v; render(); })); };
  seg('err-tabs', 'errTab'); seg('period', 'period'); seg('hist-kind', 'histKind'); seg('scan-sport', 'scanSport');
  const ss = $('#scan-search', root); if (ss) ss.onchange = () => { S.scanSearch = ss.value; render(); };
  const more = $('#scan-more', root); if (more) more.onclick = () => { S.scanLimit += 40; render(); };

  const form = (id, fn) => { const el = $(`#${id}`, root); if (el) el.onsubmit = async (e) => { e.preventDefault(); try { await fn(Object.fromEntries(new FormData(el)), el); toast('Guardado'); await refresh(); } catch (err) { toast(err.message, 4000); } }; };
  form('bank-form', async (d) => {
    const b = bank();
    if (d.initial !== '' && Number(d.initial) !== b.initial) await api('/api/bankroll', { method: 'PUT', body: { initial: Number(d.initial) } });
    const after = bankrollState({ ...S.data.bankroll, initial: Number(d.initial || b.initial) }, S.data.bets);
    if (d.current !== '' && Math.abs(Number(d.current) - after.total) > 0.005) await api('/api/bankroll/tx', { method: 'POST', body: { type: 'adjust', amount: +(Number(d.current) - after.total).toFixed(2), note: 'Ajuste manual del bank actual' } });
    await api('/api/settings', { method: 'PUT', body: { maxStakePct: +d.maxStakePct, maxExposurePct: +d.maxExposurePct, maxEventPct: +d.maxEventPct, strategy: d.strategy, kellyFraction: +d.kellyFraction, flatStakePct: +d.flatStakePct, minStake: +d.minStake } });
  });
  form('tx-form', (d) => api('/api/bankroll/tx', { method: 'POST', body: { type: d.type, amount: Number(d.amount), note: d.note } }));
  form('keys-form', (d) => { const body = {}; if (d.theoddsapi) body.theoddsapi = d.theoddsapi; if (d.oddspapi) body.oddspapi = d.oddspapi; return api('/api/keys', { method: 'PUT', body }); });
  const ck = $('#clear-keys', root); if (ck) ck.onclick = async () => { if (confirm('¿Borrar las claves guardadas en el servidor?')) { await api('/api/keys', { method: 'PUT', body: { theoddsapi: '', oddspapi: '' } }); await refresh(); } };
  form('prov-form', (d) => {
    const p = structuredClone(settings().providers);
    p.theoddsapi.enabled = !!d.toa; p.oddspapi.enabled = !!d.op; p.footballdata.enabled = !!d.fd; p.theoddsapi.includeActiveTennis = !!d.tennis;
    p.theoddsapi.regions = d.regions.split(',').map((x) => x.trim()).filter(Boolean);
    p.theoddsapi.markets = d.markets.split(',').map((x) => x.trim()).filter(Boolean);
    p.theoddsapi.sports = d.sports.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
    p.oddspapi.maxFixtures = Number(d.maxFixtures);
    return api('/api/settings', { method: 'PUT', body: { providers: p, horizonHours: +d.horizonHours, refreshSeconds: +d.refreshSeconds } });
  });
  form('engine-form', (d) => api('/api/settings', { method: 'PUT', body: {
    targetBooks: Object.keys(d).filter((k) => k.startsWith('t_')).map((k) => k.slice(2)),
    minEV: d.minEV / 100, staleMinutes: +d.staleMinutes, minRefBooks: +d.minRefBooks, devigMethod: d.devigMethod, modelWeight: +d.modelWeight,
    errorThresholdPct: +d.errorThresholdPct, diffThresholdPct: +d.diffThresholdPct, exceptionalEV: d.exceptionalEV / 100, minOdds: +d.minOdds, maxOdds: +d.maxOdds,
  } }));
  const sim = $('#sim-form', root);
  if (sim) sim.oninput = () => { const d = Object.fromEntries(new FormData(sim)); S.sim = { odds: Number(d.odds) || 2, p: Number(d.p) || 50, stake: d.stake, n: Math.min(2000, Math.max(10, Number(d.n) || 200)) }; const focus = document.activeElement?.name; render(); if (focus) $(`#sim-form [name="${focus}"]`)?.focus(); };
  $$('[data-result]', root).forEach((s) => (s.onchange = async () => { await api(`/api/bets/${s.dataset.result}`, { method: 'PATCH', body: { result: s.value } }); toast('Resultado guardado: bankroll actualizado'); await refresh(); }));
  $$('[data-close-odds]', root).forEach((i) => (i.onchange = async () => { await api(`/api/bets/${i.dataset.closeOdds}`, { method: 'PATCH', body: { closingOdds: i.value ? Number(i.value) : null } }); await refresh(); }));
  $$('[data-del]', root).forEach((b) => (b.onclick = async () => { if (confirm('¿Eliminar esta apuesta del historial?')) { await api(`/api/bets/${b.dataset.del}`, { method: 'DELETE' }); await refresh(); } }));
  const nb = $('#new-bet', root); if (nb) nb.onclick = () => openBetForm(null, S.histKind);
  const imp = $('#import', root); if (imp) imp.onchange = async () => { try { const data = JSON.parse(await imp.files[0].text()); await api('/api/import', { method: 'POST', body: data }); toast('Copia importada'); await refresh(); } catch (e) { toast(e.message, 4000); } };
  const ce = $('#clear-errors', root); if (ce) ce.onclick = async () => { await api('/api/errors', { method: 'DELETE' }); await refresh(); };
}

function route() {
  const v = location.hash.slice(1) || 'dashboard';
  S.view = v; render(); window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- Inicio
$('#toggle').onclick = toggle;
window.addEventListener('hashchange', route);
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') e.target.close(); });
window.addEventListener('beforeunload', () => { if (S.active) navigator.sendBeacon?.('/api/scan/stop'); });
(async () => {
  try { await refresh(); route(); setStatus('inactivo', 'Pulsa «INICIAR ANÁLISIS» para empezar'); }
  catch (e) { $('#main').innerHTML = `<div class="notice bad">No se puede conectar con el servidor local: ${esc(e.message)}. Ejecuta <code>npm start</code>.</div>`; }
})();
