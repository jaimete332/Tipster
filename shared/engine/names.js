// Normalización de nombres de equipos/jugadores y etiquetas de mercado.

const STOP = new Set(['fc', 'cf', 'cd', 'ud', 'sd', 'rcd', 'ca', 'ac', 'as', 'ssc', 'afc', 'sc', 'sv', 'vfl', 'vfb', 'tsg', 'fsv', 'bc', 'bk', 'kk', 'club', 'de', 'del', 'la', 'the', 'and', '1899', '1909', '1846', '04', '05']);

// Alias frecuentes entre proveedores de cuotas y football-data.co.uk (ya normalizados).
export const TEAM_ALIASES = {
  'atletico madrid': 'ath madrid', 'atletico': 'ath madrid', 'athletic bilbao': 'ath bilbao', 'athletic': 'ath bilbao',
  'rayo vallecano': 'vallecano', 'celta vigo': 'celta', 'real sociedad': 'sociedad', 'espanyol': 'espanol',
  'deportivo alaves': 'alaves', 'real betis': 'betis', 'real oviedo': 'oviedo', 'elche': 'elche', 'girona': 'girona',
  'manchester united': 'man united', 'manchester city': 'man city', 'tottenham hotspur': 'tottenham',
  'wolverhampton wanderers': 'wolves', 'wolverhampton': 'wolves', 'newcastle united': 'newcastle', 'nottingham forest': 'nottm forest',
  'brighton hove albion': 'brighton', 'west ham united': 'west ham', 'leeds united': 'leeds', 'afc bournemouth': 'bournemouth',
  'sheffield united': 'sheffield united', 'leicester city': 'leicester', 'ipswich town': 'ipswich',
  'inter milan': 'inter', 'internazionale': 'inter', 'ac milan': 'milan', 'as roma': 'roma', 'hellas verona': 'verona', 'napoli': 'napoli',
  'bayern munich': 'bayern munich', 'bayern munchen': 'bayern munich', 'borussia dortmund': 'dortmund', 'borussia monchengladbach': 'mgladbach',
  'bayer leverkusen': 'leverkusen', 'eintracht frankfurt': 'ein frankfurt', 'rb leipzig': 'rb leipzig', '1 koln': 'fc koln', 'koln': 'fc koln',
  'fc st pauli': 'st pauli', 'mainz': 'mainz', 'hoffenheim': 'hoffenheim', 'werder bremen': 'werder bremen', 'union berlin': 'union berlin',
  'paris saint germain': 'paris sg', 'psg': 'paris sg', 'olympique marseille': 'marseille', 'olympique lyonnais': 'lyon', 'as monaco': 'monaco',
  'saint etienne': 'st etienne', 'stade rennais': 'rennes', 'rc lens': 'lens', 'stade brestois': 'brest',
};

export function normalizeName(s) {
  if (!s) return '';
  let n = String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/['’.]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  n = n.split(' ').filter((t) => t && !STOP.has(t)).join(' ');
  return TEAM_ALIASES[n] || n;
}

function bigrams(s) {
  const t = ` ${s} `; const out = new Map();
  for (let i = 0; i < t.length - 1; i++) { const b = t.slice(i, i + 2); out.set(b, (out.get(b) || 0) + 1); }
  return out;
}
/** Coeficiente de Dice sobre bigramas (0..1). */
export function similarity(a, b) {
  const A = normalizeName(a), B = normalizeName(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  if (A.length > 3 && B.length > 3 && (A.includes(B) || B.includes(A))) return 0.9;
  const ba = bigrams(A), bb = bigrams(B);
  let inter = 0, total = 0;
  for (const [k, v] of ba) { inter += Math.min(v, bb.get(k) || 0); total += v; }
  for (const v of bb.values()) total += v;
  return (2 * inter) / total;
}

/** Busca el mejor equivalente en una lista; exige umbral y que sea único. */
export function bestMatch(name, candidates, threshold = 0.72) {
  let best = null, bestS = 0, second = 0;
  for (const c of candidates) {
    const s = similarity(name, c);
    if (s > bestS) { second = bestS; bestS = s; best = c; } else if (s > second) second = s;
  }
  if (bestS >= threshold && bestS - second >= 0.05) return { name: best, score: bestS };
  return null;
}

// --- Mercados ----------------------------------------------------------------
export const MARKET_TYPES = {
  h2h3: 'Ganador (1X2)',
  h2h: 'Ganador del partido',
  dc: 'Doble oportunidad',
  dnb: 'Empate no apuesta',
  btts: 'Ambos marcan',
  totals: 'Más/menos',
  ah: 'Hándicap asiático',
  spread: 'Hándicap',
};
export const MARKET_GROUP = { h2h3: 'ganador', h2h: 'ganador', dc: 'doble', dnb: 'ganador', btts: 'btts', totals: 'totales', ah: 'handicap', spread: 'handicap' };

export function marketLabel(type, line, sport) {
  let base = MARKET_TYPES[type] || type;
  if (type === 'totals') base = sport === 'football' ? 'Más/menos goles' : sport === 'basketball' ? 'Más/menos puntos' : sport === 'tennis' ? 'Más/menos juegos' : 'Más/menos';
  if (type === 'spread' && sport === 'tennis') base = 'Hándicap de juegos';
  if (type === 'spread' && sport === 'basketball') base = 'Hándicap de puntos';
  return line != null ? `${base} ${fmtLine(line, type)}` : base;
}
export const fmtLine = (l, type) => (type === 'totals' ? `${l}` : l > 0 ? `+${l}` : `${l}`);

export function selectionLabel(sel, ev, type, line) {
  switch (sel) {
    case 'home': return type === 'ah' || type === 'spread' ? `${ev.home} ${fmtLine(line)}` : ev.home;
    case 'away': return type === 'ah' || type === 'spread' ? `${ev.away} ${fmtLine(-line)}` : ev.away;
    case 'draw': return 'Empate';
    case 'over': return `Más de ${line}`;
    case 'under': return `Menos de ${line}`;
    case 'yes': return 'Sí';
    case 'no': return 'No';
    case '1X': return `${ev.home} o empate`;
    case 'X2': return `Empate o ${ev.away}`;
    case '12': return `${ev.home} o ${ev.away}`;
    default: return sel;
  }
}

export const SPORT_LABEL = { football: 'Fútbol', basketball: 'Baloncesto', tennis: 'Tenis' };
