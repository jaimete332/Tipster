# Tipster Inteligente Pro: Value Bet Finder & Bankroll Manager

Analizador de apuestas deportivas que busca **apuestas de valor** (EV positivo) en dos casas con **API oficial y pública**, **Betfair Exchange España** y **Matchbook**. También detecta **posibles errores de cuota, diferencias entre casas y arbitrajes**, y calcula **cuánto apostar** con Kelly fraccionado y límites de riesgo.

No es un apostador automático. Permanece **inactivo** hasta que pulsas **«INICIAR ANÁLISIS»** y nunca registra ni realiza apuestas por ti.

> **Sin datos inventados.** Sin claves API, la aplicación muestra «sin fuentes» y ninguna oportunidad. Las pruebas automáticas usan datos sintéticos que sólo existen en `test/`.

## Puesta en marcha

Requisitos: Node.js ≥ 20. No hay dependencias que instalar.

```bash
npm start            # http://127.0.0.1:8787
npm test             # pruebas del motor y de los proveedores
```

1. Abre `http://127.0.0.1:8787`.
2. En **Configuración**, introduce:
   - la **Application Key**, el usuario y la contraseña de **betfair.es**;
   - la clave gratuita de **The Odds API**, que aporta las casas de referencia.

   **Matchbook** no necesita credenciales. Todo se guarda sólo en el servidor local (`data/secrets.json`, permisos 600). También puedes usar variables de entorno: ver `.env.example`.
3. En **Bankroll**, introduce tu bank inicial.
4. Pulsa **INICIAR ANÁLISIS**. Mientras esté activo, el análisis se repite cada 5 min (valor configurable). **DETENER ANÁLISIS** cancela las consultas en curso.

## Casas analizadas y fuentes de datos

Casi ninguna casa ofrece una API pública. Bet365, Winamax, Codere y similares no la tienen, y Pinnacle la cerró al público en julio de 2025. Las dos casas con API oficial que se pueden usar son:

| Casa | API | Acceso | Notas |
|---|---|---|---|
| **Betfair Exchange ES** | API-NG oficial: login en `identitysso.betfair.es` y consultas a `api.betfair.com` | Cuenta en betfair.es más una Application Key (la versión *delayed* es gratuita pero da precios retrasados) | Licencia DGOJ en España. Integra Match Odds, Más/Menos 1.5/2.5/3.5, Ambos marcan y Doble oportunidad. El hándicap asiático todavía no está integrado |
| **Matchbook** | API oficial (`api.matchbook.com/edge/rest/events`) | **La lectura de precios no requiere login** (comprobado con datos reales). Cobra 100 GBP por cada millón de consultas al mes | Fútbol, baloncesto y tenis: 1X2, ganador, totales, hándicaps (incluidas líneas de cuarto), BTTS, doble oportunidad y empate no apuesta. Comprueba si acepta residentes en España |

Fuentes auxiliares:

| Fuente | Uso |
|---|---|
| [The Odds API](https://the-odds-api.com) | **Referencias independientes**: Pinnacle y unas 25 casas europeas. Clave gratuita de 500 créditos al mes |
| [football-data.co.uk](https://www.football-data.co.uk) | Resultados y xG para el modelo de Poisson y el Elo |

**Lo que cambia al ser exchanges:**

- **Comisión.** Se cobra sobre la ganancia neta: 5 % por defecto en Betfair y 4 % en Matchbook, ambos configurables. El EV, Kelly, el beneficio potencial y los arbitrajes se calculan siempre con la **cuota neta**: `1 + (cuota − 1)·(1 − comisión)`.
- **Liquidez.** Sólo se usan precios *back* con al menos 10 € disponibles, y el stake recomendado nunca supera la liquidez del mejor precio.
- **Menos oportunidades.** Betfair y Matchbook son mercados eficientes (sharp), así que encontrar valor en ellos es más difícil que en una casa tradicional. Es lo esperable.
- **Casas de referencia.** Cada exchange se compara con Pinnacle, con las casas de The Odds API y con el otro exchange. Nunca se usa como referencia de sí mismo, ni siquiera a través de otra clave de la misma casa (como `betfair_ex_eu`).

**Otras limitaciones:**

- **Lesiones y alineaciones:** no hay una fuente verificable de lesiones ni alineaciones.
- **Smarkets:** también tiene API, pero bloquea las consultas automatizadas con Cloudflare y no se ha intentado sortear ese bloqueo.
- **Análisis continuo:** el análisis sólo se ejecuta mientras la página está abierta y activada.

## Cómo calcula

- **Probabilidad de referencia.** Se elimina el margen de cada casa con mercado completo (método de potencia por defecto; también multiplicativo y Shin). Después se combinan las probabilidades: las casas sharp (Pinnacle y el otro exchange) pesan un 65 % y la mediana de las demás un 35 %. **Cada casa objetivo nunca se usa como referencia de sí misma.**
- **Modelo estadístico (fútbol).** Poisson con fuerzas de ataque y defensa calculadas con goles y xG, ponderadas por antigüedad, con corrección Dixon-Coles y ajuste por rival. Se mezcla con el mercado con un peso del 20 % sólo si ambos equipos tienen al menos 6 partidos. El Elo se muestra como contraste.
- **Poisson ajustado al mercado.** Permite valorar líneas de cuarto (±0.25, ±0.75) y devoluciones: el modelo aporta la forma de la distribución y el mercado aporta el nivel.
- **EV:** `EV = Σ p·r` (en apuestas binarias, `p·cuota neta − 1`). Se muestran tres valores:
  - el EV teórico, calculado sólo con el mercado;
  - el EV estimado, con mercado y modelo;
  - el **EV conservador**, calculado con la probabilidad menos una desviación típica (1σ).
- **Incertidumbre (σ).** Combina la dispersión entre casas, el número de referencias, si hay o no referencia sharp y la discrepancia con el modelo. A partir de ahí se asigna una confianza alta, media o baja.
- **Stake.** Kelly `f = (p·cuota − 1)/(cuota − 1)`, generalizado a `max E[ln(1+f·r)]` cuando hay devolución o medias ganancias. Sobre ese valor se aplican, en este orden:
  - la fracción de Kelly elegida (¼ por defecto);
  - un multiplicador según la confianza (1 / 0,6 / 0,3);
  - un tope del 2 % del bank por apuesta;
  - un tope del 2 % por partido, para limitar las apuestas correlacionadas;
  - un tope del 5 % de exposición simultánea, que incluye las apuestas pendientes;
  - la liquidez disponible en el exchange.

  El stake es 0 si el EV conservador no es positivo. Si el EV es excepcional (más del 12 %), el tope por apuesta se reduce a la mitad. Siempre se calcula sobre el **bank disponible**.

Ejemplo del enunciado, comprobado en las pruebas: bank de 500 €, cuota 2,20 y probabilidad del 50 % dan EV +10 %, Kelly 8,33 %, ¼ Kelly 2,08 %, tope 2 % y **stake de 10 €** (beneficio potencial de 12 €, pérdida potencial de 10 €).

## Secciones

1. **Dashboard:** botón principal, estado del sistema, fuentes, cuota restante, resumen del bank y mejores oportunidades.
2. **Escáner de cuotas:** cada evento y mercado con Betfair ES, Matchbook, la mejor cuota, la cuota justa y el número de casas.
3. **Value Bets:** tabla ordenada por EV, con filtros y una ficha completa de cada oportunidad (cálculos, comparativa, evolución, factores, fuentes y verificación).
4. **Errores de cuota:** posibles errores de cotización, cuotas no actualizadas, diferencias Betfair/Matchbook y arbitrajes, cada categoría por separado.
5. **Bankroll:** configuración, ingresos y retiradas, panel de gestión, gráfico y simulador (incluye Monte Carlo).
6. **Historial:** apuestas reales y simuladas (registro manual), resultado, cuota de cierre y CLV, junto con el registro de **todas** las oportunidades detectadas.
7. **Estadísticas:** aciertos, P/L, ROI, yield, EV medio y CLV por periodo, deporte, casa y mercado, más el CLV de las oportunidades no apostadas.
8. **Configuración:** claves, proveedores, competiciones, umbrales del motor, exportar/importar y registro de errores.

## Estructura

```
server/            Servidor HTTP local (sin dependencias), claves y persistencia
  providers/       betfair.js · matchbook.js (casas objetivo) · theOddsApi.js (referencias) · footballData.js (modelo)
  scanner.js       Ciclo de análisis: proveedores → fusión → modelos → motor → riesgo → registro
shared/engine/     Motor puro (servidor y navegador): odds, kelly, risk, poisson, elo, value, stats, names
public/            Interfaz (HTML/CSS/JS sin compilación)
test/              Pruebas (node --test)
data/              Estado local y claves (ignorado por git)
```

Juega con responsabilidad. Sólo mayores de 18 años. Las probabilidades son estimaciones con incertidumbre y ningún umbral garantiza rentabilidad.
