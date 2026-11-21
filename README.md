# Tipster

**Tipster Hold'em**: mesa de Texas Hold'em en el navegador con asesor. Pones quién es el dealer y lo que apuesta cada jugador; la mesa pone las ciegas, lleva el bote, forma los botes aparte cuando alguien va con todo y actualiza las fichas de todos al final de cada mano. Cuando te toca, te recomienda la jugada y la cantidad.

Abre `index.html` en el navegador (no necesita servidor ni instalación).

## Cómo decide

- **Equity por Monte Carlo** (hasta 25.000 manos simuladas) contra el *rango* de cada rival, no contra cartas al azar.
- **Rangos preflop** según la acción del rival (limp, subida, 3-bet, 4-bet, all-in) y su estilo (tight, normal, loose, maníaco).
- **Lectura postflop**: cada acción del rival en flop, turn y river filtra su rango (quien apuesta fuerte tiene más manos hechas y menos aire).
- **Preflop**: rangos de apertura por posición, 3-bet de valor y de farol, defensa por pot odds y equity realizada, set-mining y push/fold con 15 bb o menos.
- **Postflop**: apuesta de valor con tamaño según textura del board, semifaroles con proyectos, c-bets, control del bote, pot odds, implied odds y SPR.

Las cantidades se muestran en fichas reales; por dentro el motor trabaja en ciegas grandes. La mesa se guarda en el navegador y se puede deshacer cualquier paso.

## Archivos

- `engine.js`: evaluador de manos, rangos, simulación y reglas de decisión (funciona también en Node).
- `index.html`: la interfaz.
