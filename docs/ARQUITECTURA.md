# Arquitectura y decisiones

## 1. Casas con API pública (comprobado en noviembre de 2026)

- **Bet365, Winamax:** no tienen API pública. Hace un tiempo se integraron a través del agregador OddsPapi; se han sustituido a petición del usuario.
- **Pinnacle:** cerró su API al público el 23 de julio de 2025.
- **Betfair Exchange (España):** tiene API-NG oficial ← **casa objetivo**.
  - Login: `POST https://identitysso.betfair.es/api/login` con las cabeceras `X-Application` y `Content-Type: application/x-www-form-urlencoded`. Responde con `token` y `status`. La sesión dura 20 min.
  - Consultas: `POST https://api.betfair.com/exchange/betting/rest/v1.0/{listMarketCatalogue|listMarketBook}/` con las cabeceras `X-Application` y `X-Authentication`. Con un token .es, se devuelven los mercados del Exchange español.
  - Límite: `listMarketBook` con `EX_BEST_OFFERS` (peso 5) admite hasta 40 mercados por petición (200 puntos).
- **Matchbook:** tiene API oficial ← **casa objetivo**.
  - Consultas: `GET https://api.matchbook.com/edge/rest/events?include-prices=true…`, sin autenticación. Se ha comprobado con datos reales: 358 eventos y 6.428 mercados en un escaneo de 8 s.
  - Límites y coste: 700 peticiones/min; 100 GBP por cada millón de consultas GET al mes.
- **Smarkets:** tiene API, pero `api.smarkets.com` responde con un desafío de Cloudflare a las peticiones automatizadas. No se ha intentado sortearlo.
- **Referencias independientes:** The Odds API (Pinnacle y unas 25 casas).
- **Estadística:** football-data.co.uk.

## 2. Diseño

```
Navegador (public/)  ──HTTP──▶  Servidor local (server/index.js)
  · estado, filtros, fichas          · claves API (nunca al cliente)
  · stakes recalculados en vivo      · scanner.js (un ciclo por petición, cancelable)
    con shared/engine                · providers/* → modelo normalizado
                                     · data/state.json (bank, apuestas, historial)
```

- **Modelo normalizado de evento:** `{ sport, competition, home, away, commence, markets: { [key]: { type, line, sels, quotes: { [book]: { [sel]: { price, updatedAt, changedAt, provider } } } } } }`.
- **Añadir un proveedor:** basta con crear `server/providers/x.js` con una función `fetchOdds({key, settings, signal, progress})` que devuelva eventos normalizados y registrarlo en `scanner.js`.
- **Exchanges:** las cuotas se convierten a netas de comisión antes de calcular el EV, Kelly y los arbitrajes. Se descartan los precios con liquidez inferior a la mínima, y el stake se limita a la liquidez disponible.
- **Fusión de eventos entre proveedores:** se fusionan si coinciden el deporte, la hora (±3 h) y el nombre de ambos equipos (Dice ≥ 0,7).
  - En tenis, si el orden de los jugadores está invertido, sólo se fusiona el mercado de ganador.
- **Cancelación:** «DETENER» aborta la petición del navegador y llama a `/api/scan/stop`, que dispara el `AbortController` compartido por todas las consultas del ciclo.

## 3. Probabilidades

1. Para cada casa con el mercado completo y cuotas recientes (≤ 20 min), se elimina el margen con el método de **potencia**: se busca `k` tal que `Σ(1/cuota)^k = 1`.
2. Se combinan las referencias: 65 % la media de las sharp y 35 % la mediana de las demás. Si no hay sharp, se usa la mitad de la mediana más la mitad de la media.
3. En fútbol, se mezcla con el modelo de Poisson independiente (peso de 0,2 por defecto) cuando la calidad del modelo es suficiente.
4. La incertidumbre es `σ = √(σ_casas²/n + suelo² + (0,3·|modelo − mercado|)² + penalización por pocas referencias)`.

## 4. EV y verificación

- `EV = Σ p_i · r_i`, donde `r` es el retorno neto por unidad: gana `cuota−1`, media ganancia `(cuota−1)/2`, devolución `0`, media pérdida `−0,5` y pierde `−1`.
- Se calculan el **EV teórico** (sólo mercado), el **EV estimado** (mercado + modelo) y el **EV conservador** (`p − σ`).
- Una oportunidad aparece sólo si cumple todo esto:
  - EV ≥ 2 %;
  - cuota reciente;
  - al menos 2 referencias;
  - semántica del mercado verificada;
  - cuota entre 1,30 y 8.
- Se marca como **verificada** sólo si pasa todas las comprobaciones (referencias suficientes, sharp presente, dispersión baja, coherencia con el modelo, EV conservador > 0, EV ≤ 12 %) y la confianza no es baja.

## 5. Gestión del riesgo

- `allocate()` reparte el presupuesto de riesgo por orden de EV conservador. Aplica el límite por apuesta, el límite por partido (apuestas correlacionadas, incluidas las pendientes ya registradas) y la exposición total máxima.
- El stake se recalcula en el navegador cada vez que cambian el bank, la configuración o la cuota.
- Si el usuario registra una cuota tomada peor que la detectada, el formulario recalcula el EV y avisa si ha dejado de ser positivo.

## 6. Qué haría falta para un análisis 24/7

La aplicación funciona de verdad, pero sólo mientras está abierta. Para tener alertas continuas:

- **Servidor siempre encendido** (VPS o contenedor) que ejecute `runScan()` periódicamente, respetando la cuota de cada API.
- **Clave *live* de Betfair** para tener precios en tiempo real, y opcionalmente un plan superior de The Odds API para disponer de más referencias.
- **Notificaciones** (correo, Telegram o push) cuando aparezca una oportunidad verificada.
- **Base de datos** (SQLite o PostgreSQL) en lugar de `state.json`, si el historial crece mucho.
- **Fuente de lesiones y alineaciones** con licencia (por ejemplo, API-Football o Sportmonks), para incorporarla como factor del modelo.
