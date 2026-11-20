# Tipster Inteligente Pro: Value Bet Finder & Bankroll Manager

Analizador de apuestas deportivas que busca **apuestas de valor** (EV positivo) en **Bet365** y **Winamax**, detecta **posibles errores de cuota, diferencias entre casas y arbitrajes** y calcula **cuánto apostar** con Kelly fraccionado y límites de riesgo.

No es un apostador automático. Permanece **inactivo** hasta que pulsas **«INICIAR ANÁLISIS»** y nunca registra ni realiza apuestas por ti.

> **Sin datos inventados.** Sin claves API, la aplicación muestra «sin fuentes» y ninguna oportunidad. Las pruebas automáticas usan datos sintéticos que sólo existen en `test/`.

## Puesta en marcha

Requisitos: Node.js ≥ 20. No hay dependencias que instalar.

```bash
npm start            # http://127.0.0.1:8787
npm test             # 20 pruebas del motor y de los proveedores
```

1. Abre `http://127.0.0.1:8787`.
2. En **Configuración**, pega tus claves API. Se guardan sólo en el servidor local (`data/secrets.json`, permisos 600). También puedes usar `THE_ODDS_API_KEY` / `ODDSPAPI_KEY` en un archivo `.env` (ver `.env.example`).
3. En **Bankroll**, introduce tu bank inicial.
4. Pulsa **INICIAR ANÁLISIS**. Mientras esté activo, el análisis se repite cada 5 min (valor configurable). **DETENER ANÁLISIS** cancela las consultas en curso.

## Fuentes de datos: qué es real y qué no

| Fuente | Qué aporta | Acceso |
|---|---|---|
| [The Odds API](https://the-odds-api.com) | **Winamax FR/DE**, Pinnacle, Betfair Exchange y unas 25 casas europeas | Clave gratuita: 500 créditos/mes. Cada llamada cuesta 1 crédito por región y mercado |
| [OddsPapi](https://oddspapi.io) | **Bet365**, **Winamax FR/ES/DE** y Pinnacle | Gratis: ~250 peticiones/mes, 1 por partido. Para uso continuo hace falta un plan de pago |
| [football-data.co.uk](https://www.football-data.co.uk) | Resultados y xG de la temporada para el modelo de Poisson y el Elo | Gratuito y sin clave |

**Limitaciones importantes:**

- **Bet365 y Winamax no tienen API pública.** Extraer datos de sus webs (scraping, saltarse CAPTCHAs) vulneraría sus condiciones, así que no se hace. Se usan agregadores con licencia.
- **The Odds API no ofrece Bet365 en Europa.** Sin una clave de OddsPapi, sólo se analiza Winamax.
- **No hay fuente verificable de lesiones ni alineaciones.** La ficha de cada apuesta lo indica como factor de riesgo.
- **Mercados de jugadores, hándicap europeo y resultado por sets:** no se analizan, porque los proveedores no los ofrecen con suficiente fiabilidad o con semántica verificable.
- **El análisis no es continuo en segundo plano.** Sólo se ejecuta mientras la página está abierta y activada. Para vigilar 24/7 hace falta un proceso programado en un servidor (ver `docs/ARQUITECTURA.md`).

## Cómo calcula

- **Probabilidad de referencia.** Se elimina el margen de cada casa con mercado completo (método de potencia por defecto; también multiplicativo y Shin). Después se combinan las probabilidades: Pinnacle y los exchanges pesan un 65 % y la mediana de las demás casas un 35 %. **Bet365 y Winamax nunca se usan como referencia de sí mismas.**
- **Modelo estadístico (fútbol).** Poisson con fuerzas de ataque y defensa calculadas con goles y xG, ponderadas por antigüedad, con corrección Dixon-Coles y ajuste por rival. Se mezcla con el mercado con un peso del 20 % sólo si ambos equipos tienen al menos 6 partidos. El Elo se muestra como contraste.
- **Poisson ajustado al mercado.** Permite valorar líneas de cuarto (±0.25, ±0.75) y devoluciones: el modelo aporta la forma de la distribución y el mercado aporta el nivel.
- **EV:** `EV = Σ p·r` (en apuestas binarias, `p·cuota − 1`). Se muestran tres valores:
  - el EV teórico, calculado sólo con el mercado;
  - el EV estimado, con mercado y modelo;
  - el **EV conservador**, calculado con la probabilidad menos una desviación típica (1σ).
- **Incertidumbre (σ).** Combina la dispersión entre casas, el número de referencias, si hay o no referencia sharp y la discrepancia con el modelo. A partir de ahí se asigna una confianza alta, media o baja.
- **Stake.** Kelly `f = (p·cuota − 1)/(cuota − 1)`, generalizado a `max E[ln(1+f·r)]` cuando hay devolución o medias ganancias. Sobre ese valor se aplican, en este orden:
  - la fracción de Kelly elegida (¼ por defecto);
  - un multiplicador según la confianza (1 / 0,6 / 0,3);
  - un tope del 2 % del bank por apuesta;
  - un tope del 2 % por partido, para limitar las apuestas correlacionadas;
  - un tope del 5 % de exposición simultánea, que incluye las apuestas pendientes.

  El stake es 0 si el EV conservador no es positivo. Si el EV es excepcional (más del 12 %), el tope por apuesta se reduce a la mitad. Siempre se calcula sobre el **bank disponible**.

Ejemplo del enunciado, comprobado en las pruebas: bank de 500 €, cuota 2,20 y probabilidad del 50 % dan EV +10 %, Kelly 8,33 %, ¼ Kelly 2,08 %, tope 2 % y **stake de 10 €** (beneficio potencial de 12 €, pérdida potencial de 10 €).

## Secciones

1. **Dashboard:** botón principal, estado del sistema, fuentes, cuota restante, resumen del bank y mejores oportunidades.
2. **Escáner de cuotas:** cada evento y mercado con Bet365, Winamax, la mejor cuota, la cuota justa y el número de casas.
3. **Value Bets:** tabla ordenada por EV, con filtros y una ficha completa de cada oportunidad (cálculos, comparativa, evolución, factores, fuentes y verificación).
4. **Errores de cuota:** posibles errores de cotización, cuotas no actualizadas, diferencias Bet365/Winamax y arbitrajes, cada categoría por separado.
5. **Bankroll:** configuración, ingresos y retiradas, panel de gestión, gráfico y simulador (incluye Monte Carlo).
6. **Historial:** apuestas reales y simuladas (registro manual), resultado, cuota de cierre y CLV, junto con el registro de **todas** las oportunidades detectadas.
7. **Estadísticas:** aciertos, P/L, ROI, yield, EV medio y CLV por periodo, deporte, casa y mercado, más el CLV de las oportunidades no apostadas.
8. **Configuración:** claves, proveedores, competiciones, umbrales del motor, exportar/importar y registro de errores.

## Estructura

```
server/            Servidor HTTP local (sin dependencias), claves y persistencia
  providers/       theOddsApi.js · oddsPapi.js · footballData.js  (sustituibles)
  scanner.js       Ciclo de análisis: proveedores → fusión → modelos → motor → riesgo → registro
shared/engine/     Motor puro (servidor y navegador): odds, kelly, risk, poisson, elo, value, stats, names
public/            Interfaz (HTML/CSS/JS sin compilación)
test/              Pruebas (node --test)
data/              Estado local y claves (ignorado por git)
```

Juega con responsabilidad. Sólo mayores de 18 años. Las probabilidades son estimaciones con incertidumbre y ningún umbral garantiza rentabilidad.
