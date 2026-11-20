// Cliente HTTP con timeout, cancelación (AbortSignal) y registro sin exponer claves.

export class ProviderError extends Error {
  constructor(provider, message, status, body) { super(message); this.provider = provider; this.status = status; this.body = body; }
}

export const redact = (url) => String(url).replace(/(apiKey|api_key|key)=[^&]+/gi, '$1=***');

export async function getJSON(provider, url, { signal, timeoutMs = 20000, headers = {}, method = 'GET', body: reqBody } = {}) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  try {
    const res = await fetch(url, { method, body: reqBody, signal: ctrl.signal, headers: { 'Accept': 'application/json', 'Accept-Encoding': 'gzip', 'User-Agent': 'tipster-inteligente/1.0', ...headers } });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    if (!res.ok) {
      const msg = typeof body === 'object' ? (body.message || body.error?.message || body.detail?.APINGException?.errorCode || JSON.stringify(body).slice(0, 200)) : String(body).slice(0, 200);
      throw new ProviderError(provider, `HTTP ${res.status} en ${redact(url)}: ${msg}`, res.status, body);
    }
    return { body, headers: res.headers };
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    if (signal?.aborted) throw new ProviderError(provider, 'Consulta cancelada por el usuario', 0);
    throw new ProviderError(provider, `Error de red en ${redact(url)}: ${e.message || e}`, 0);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function getText(provider, url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20000);
  opts.signal?.addEventListener('abort', () => ctrl.abort(), { once: true });
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'tipster-inteligente/1.0' } });
    if (!res.ok) throw new ProviderError(provider, `HTTP ${res.status} en ${url}`, res.status);
    return await res.text();
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError(provider, `Error de red en ${url}: ${e.message || e}`, 0);
  } finally { clearTimeout(timer); }
}

export const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new ProviderError('scan', 'Consulta cancelada por el usuario', 0)); }, { once: true });
});
