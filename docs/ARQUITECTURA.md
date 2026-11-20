# Arquitectura y decisiones

## 1. Qué fuentes se pueden integrar realmente (comprobado en noviembre de 2026)

- **Bet365:** no tiene API pública, documentación para desarrolladores ni claves de autoservicio. Se accede a sus cuotas a través de agregadores:
  - **OddsPapi** (`slug` `bet365`) ← integrado.
  - Sports Game Odds, OpticOdds, LSports y Sportradar: alternativas de pago.
- **Winamax:** tampoco tiene API pública. Opciones:
  - **The Odds API**: `winamax_fr` y `winamax_de` en la región `eu` ← integrado.
  - **OddsPapi**: `winamax-fr`, `winamax-es` y `winamax-de` ← integrado. Las claves exactas se descubren en tiempo de ejecución con `/v4/bookmakers`.
- **Referencias independientes:** Pinnacle y Betfair Exchange, más unas 25 casas a través de The Odds API, y Pinnacle (con 30 s de retraso) a través de OddsPapi.
- **Estadística:** football-data.co.uk (CSV de resultados, cuotas y xG, gratuito).
- **Descartado:** el scraping de las webs de las casas, porque vulnera sus condiciones de servicio y sus controles de acceso.

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
- **Fusión de eventos entre proveedores:** se fusionan si coinciden el deporte, la hora (±3 h) y el nombre de ambos equipos (Dice ≥ 0,7).
  - En tenis, si el orden de los jugadores está invertido, sólo se fusiona el mercado de ganador.
  - Los hándicaps de OddsPapi y los totales de baloncesto o tenis no se mezclan con los de otro proveedor, porque la semántica (signo de la línea, prórroga) no está verificada. Se marcan como «semántica no confirmada» y nunca salen como verificados.
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
- **Planes de pago:** OddsPapi para bet365 a frecuencia útil; opcionalmente, un plan superior de The Odds API.
- **Notificaciones** (correo, Telegram o push) cuando aparezca una oportunidad verificada.
- **Base de datos** (SQLite o PostgreSQL) en lugar de `state.json`, si el historial crece mucho.
- **Fuente de lesiones y alineaciones** con licencia (por ejemplo, API-Football o Sportmonks), para incorporarla como factor del modelo.
