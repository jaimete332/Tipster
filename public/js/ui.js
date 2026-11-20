// Utilidades de interfaz: formato, escape HTML, gráficos SVG sin dependencias.

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const nf = (d) => new Intl.NumberFormat('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d });
export const eur = (x, d = 2) => (Number.isFinite(x) ? `${nf(d).format(x)} €` : '—');
export const pct = (x, d = 1) => (Number.isFinite(x) ? `${nf(d).format(x * 100)}%` : '—');
export const spct = (x, d = 1) => (Number.isFinite(x) ? `${x > 0 ? '+' : ''}${nf(d).format(x * 100)}%` : '—');
export const odd = (x) => (Number.isFinite(x) ? nf(2).format(x) : '—');
export const num = (x, d = 0) => (Number.isFinite(x) ? nf(d).format(x) : '—');
export const cls = (x) => (x > 0 ? 'pos' : x < 0 ? 'neg' : '');

export function when(ts, withDate = true) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString('es-ES', withDate ? { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
export function ago(ts) {
  if (!ts) return '—';
  const m = (Date.now() - new Date(ts).getTime()) / 60000;
  if (m < 1) return 'hace <1 min';
  if (m < 60) return `hace ${Math.round(m)} min`;
  if (m < 1440) return `hace ${Math.round(m / 60)} h`;
  return `hace ${Math.round(m / 1440)} d`;
}
export function until(ts) {
  const m = (new Date(ts).getTime() - Date.now()) / 60000;
  if (m < 0) return 'empezado';
  if (m < 60) return `en ${Math.round(m)} min`;
  if (m < 1440) return `en ${Math.floor(m / 60)} h ${Math.floor(m % 60)} min`;
  return `en ${Math.round(m / 1440)} d`;
}

export function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

export const CONF_BADGE = { alta: 'b-green', media: 'b-amber', baja: 'b-red' };
export const EVCLASS_BADGE = { bajo: 'b-grey', interesante: 'b-blue', alto: 'b-green', excepcional: 'b-violet' };

/**
 * Gráfico de líneas SVG.
 * series: [{name, color, points:[{x, y}], dashed?, band?: [{x, lo, hi}]}]
 */
export function lineChart(series, { height = 220, width = 760, xType = 'time', yFmt = (v) => num(v, 2), title = '' } = {}) {
  const W = width, H = height, L = 52, R = 12, T = 12, B = 26;
  const pts = series.flatMap((s) => s.points.concat((s.band || []).flatMap((b) => [{ x: b.x, y: b.lo }, { x: b.x, y: b.hi }])));
  if (pts.length < 2) return `<div class="empty">Sin datos suficientes para el gráfico</div>`;
  let x0 = Math.min(...pts.map((p) => p.x)), x1 = Math.max(...pts.map((p) => p.x));
  let y0 = Math.min(...pts.map((p) => p.y)), y1 = Math.max(...pts.map((p) => p.y));
  if (x0 === x1) { x0 -= 1; x1 += 1; }
  const pad = (y1 - y0) * 0.08 || Math.abs(y0) * 0.05 || 1; y0 -= pad; y1 += pad;
  const sx = (x) => L + ((x - x0) / (x1 - x0)) * (W - L - R);
  const sy = (y) => T + (1 - (y - y0) / (y1 - y0)) * (H - T - B);
  const ticks = 4;
  let g = '';
  for (let i = 0; i <= ticks; i++) {
    const v = y0 + ((y1 - y0) * i) / ticks;
    g += `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${sy(v)}" y2="${sy(v)}"/><text class="axis" x="${L - 6}" y="${sy(v) + 3}" text-anchor="end">${esc(yFmt(v))}</text>`;
  }
  for (let i = 0; i <= 4; i++) {
    const v = x0 + ((x1 - x0) * i) / 4;
    const lab = xType === 'time' ? new Date(v).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: x1 - x0 < 3 * 86400e3 ? '2-digit' : undefined, minute: x1 - x0 < 3 * 86400e3 ? '2-digit' : undefined }) : num(v);
    g += `<text class="axis" x="${sx(v)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}">${esc(lab)}</text>`;
  }
  let s = '';
  for (const se of series) {
    if (se.band?.length) {
      const up = se.band.map((b) => `${sx(b.x)},${sy(b.hi)}`).join(' ');
      const dn = [...se.band].reverse().map((b) => `${sx(b.x)},${sy(b.lo)}`).join(' ');
      s += `<polygon class="band" fill="${se.color}" points="${up} ${dn}"/>`;
    }
    if (se.points.length) {
      const d = se.points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join('');
      s += `<path class="series" d="${d}" stroke="${se.color}" ${se.dashed ? 'stroke-dasharray="5 4"' : ''}/>`;
      if (se.points.length < 40) s += se.points.map((p) => `<circle cx="${sx(p.x)}" cy="${sy(p.y)}" r="2.6" fill="${se.color}"><title>${esc(se.name)}: ${esc(yFmt(p.y))}${xType === 'time' ? ' · ' + new Date(p.x).toLocaleString('es-ES') : ''}</title></circle>`).join('');
    }
  }
  const legend = `<div class="legend">${series.map((se) => `<span><i style="background:${se.color}"></i>${esc(se.name)}</span>`).join('')}</div>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${g}${s}</svg>${series.length > 1 ? legend : ''}`;
}

export const PALETTE = ['#34d399', '#60a5fa', '#fbbf24', '#a78bfa', '#f472b6', '#22d3ee', '#f87171'];
