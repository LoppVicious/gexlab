# Nota diaria de flujos (Founder Takes)

Primera versión el 2026-11-25. Objetivo: una nota diaria en Research > Takes con la lectura de un estratega de
flujos. Qué harán los participantes mecánicos según por dónde vaya el mercado, qué lado es frágil y qué lo
cambiaría. Los datos los calcula Actions al cierre y el texto lo escribe Claude Code con `/take-flujos` como borrador.

## Flujo
1. `historial500.yml` (16:30 ET, unos 50 min) guarda las cadenas del cierre en `hist500/`.
2. Al acabar, `flujos.yml` ejecuta `flujos_diario.py`:
   - Recalcula con el motor Perfil (todos los vencimientos, posición estándar) las cadenas de SPY, QQQ e IWM de
     `hist500/`. Pone el reloj del motor 20 min después del cierre (`en_sesion`) y no escribe nada en disco.
   - SPX, NDX y RUT no están en `hist500`. Usa su cadena de ahora de Tradier, solo si es de la misma sesión.
   - Publica `flujos/{F}/paquete.json`, `flujos/{F}/g/*.png` y `flujos/ultimo.json`, y añade la fila del día a
     `flujos/_serie.json.gz`.
3. `/take-flujos` (skill en `.claude/skills/take-flujos/`) lee el paquete por el Worker, redacta en inglés y crea el
   borrador con `POST /api/flujos/{F}/take`. El Worker guarda además la tesis en `flujos/{F}/tesis.json`. La
   siguiente ejecución de `flujos_diario.py` la copia en la fila de ese día de la serie.
4. Una tarea programada de la app de Claude en el PC lanza `/take-flujos` los días laborables. El skill espera al
   paquete si aún no está.

## Bloques (`flujos_calc.py`)
- **dealers:** el flujo de cobertura por escenario lo da `gex_engine.compute` (`scenarios.flow`: lo que compran (+)
  o venden (-) los dealers si el precio se mueve X %), con vencimientos hasta 90 días (`DEALERS_DTE`, como el
  "full" de gexbot). Se dan dos versiones:
  - `flujo`: IV quieta.
  - `estres`: IV +5 puntos en las bajadas y -2 en las subidas, escalado por plazo (`compute(iv_term=True)`:
    `x min(1, raiz(30 días / T))`; la IV a un año se mueve un 28 % de lo que se mueve la de un mes).

  Antes (versión 1 del modelo) entraban todos los vencimientos y la IV se movía en paralelo: la gamma por 1 % del SPX
  salía un 30 % mayor que con el alcance de gexbot (mismas unidades, Γ · OI · S²) y el flujo a -1 % con estrés, más
  del doble, por la delta de las opciones largas. Aun así, el motor supone que los dealers tienen todo el OI (cortos
  de puts, largos de calls, sin neteo) y da una gamma unas 10 veces mayor que la que publican los bancos, que
  netean con su libro. Desde la versión 3 los dólares se escalan (`escala_dealers`, `escalar`): factor = gamma
  publicada / gamma del motor ese día (complejo S&P 500), mediana de los puntos de `CALIBRACION`, el mismo para los
  tres complejos. Primer punto: -7.300 millones por 1 % el 2026-11-17 (Nomura). SPX no está en `hist500`, así que la
  gamma del motor de ese día se estima con la de SPY recalculada x (SPX + SPY) / SPY del primer día que se calcula, y
  se guarda en `flujos/_calibracion.json`. Con cada cifra publicada nueva se añade un punto. La serie guarda la gamma
  sin escalar (`net`) y el factor (`escala`).

  Los complejos suman índice y ETF (SPX + SPY, NDX + QQQ, RUT + IWM), que son subyacentes distintos. Percentil de
  la gamma por 1 % (símbolos y complejos) y de la asimetría: de la serie, solo con filas de la versión actual del
  modelo (el índice de niveles de `hist500` usa todos los vencimientos y no es comparable).
- **letf:** rebalanceo al cierre `AUM x L x (L-1) x r` de 41 ETFs de ProShares y Direxion (`ETFS`), por categoría
  como las tablas de los bancos: Tech (QQQ, XLK), Semi (SOXX), SPX, Mag7 (los 2x de Direxion sobre cada acción),
  DJI, RUT, Gold (GLD, GDX), Silver, Bitcoin (IBIT) y Financials. AUM del día de la web del emisor. Sensibilidad por
  cada 1 % más y escenarios con el mismo movimiento en todos los subyacentes. Percentil con signo (bajo = mucha
  venta) frente a 252 sesiones, con el AUM guardado de cada día cuando está y, si no, el de hoy. Con el AUM del
  2026-11-25 y un -3,3 % del Nasdaq, Tech sale unos -7.600 millones (Nomura dio -8.800 con ese movimiento y su universo).
- **vol_control:** exposición = min(1,5; 10 % / la mayor de las vol realizadas a 21 y 63 sesiones del SPX). Cambio
  en dólares con un AUM supuesto de 200.000 millones (no es público). Escenarios para la próxima sesión (±3 %, ±5 %
  y dos semanas de ±0,5 %). Un día de 5 % en cualquier sentido les hace vender.
- **cta:** CTA genérico de tendencia. Señal por ventana (1, 3, 6 y 12 meses) = rentabilidad / (vol a 63 sesiones x
  raíz del plazo), recortada a ±1; la posición es la media. Los giros son el nivel del SPX que da la vuelta a cada
  señal mañana (el cierre de hace w sesiones). No da dólares.
- **strikes:** strikes del SPX con más interés abierto en puts entre -15 % y +5 % del precio, con su vencimiento
  principal. Con la convención de que los dealers están cortos de las puts de cada strike, calcula lo que
  recomprarían (+) o venderían (-) en futuros si el SPX cerrara en ese strike, por el cambio de delta de esas puts
  (Black-Scholes con la IV de cada contrato). Solo las del strike: tomar todas las puts de la cadena como cortas de
  los dealers daba billones el primer día (parte del OI son spreads y puts vendidas por clientes).
- **asimetria:** suma a -5 % y +5 % de dealers (estrés), ETFs apalancados y vol-control; cociente venta/compra.
- **destacados:** percentiles ≤ 10 o ≥ 90, cociente ≥ 1,5 o ≤ 0,67 y strike con puts hasta un 3 % por encima del
  precio.

Los supuestos van en `flujos_calc.MODELO`; cada fila de la serie guarda `modelo` (`VERSION`). Si cambia un
supuesto, se sube `VERSION`.

## Serie `flujos/_serie.json.gz`
`{fecha: fila}`. Guarda lo que no se puede reconstruir después:
- el AUM diario de cada ETF apalancado;
- las cifras tal como se calcularon (dealers y complejos con su flujo a ±5 %, rebalanceo y sensibilidad,
  exposición de vol-control, posición de CTA, strikes, asimetría);
- la versión del modelo;
- la tesis de la nota (`sesgo`, `lado_fragil`, `niveles`, `escenario`, `invalidacion`).

Pesa unos pocos KB por día. Sirve para:
- percentiles propios (asimetría y complejos, desde unas 30 sesiones);
- comparar el rebalanceo previsto con el cambio de participaciones del día siguiente (AUM y precio);
- medir si las tesis aciertan (por ejemplo, si se movió el lado frágil).

## Pruebas
- Sin red: `python pruebas/test_flujos.py` (los gráficos solo con matplotlib) y `node --test pruebas/test_report_api.mjs`
  (rutas `/api/flujos/*`).
- Real: `flujos.yml` a mano (`gh api -X POST repos/LoppVicious/gexlab/actions/workflows/flujos.yml/dispatches -f ref=main`,
  con `-f 'inputs[forzar]=true'` para rehacer). Para SPX, NDX y RUT solo sirve el mismo día de la sesión, antes de
  la apertura siguiente.

## Pendiente
- Revisar los umbrales de destacado y el AUM supuesto de vol-control tras las primeras semanas.
- Con unas 60 sesiones en la serie: comparar el rebalanceo previsto con el real y puntuar las tesis.
- Posible: guardar SPX, NDX y RUT en `hist500` (espacio en R2) para poder rehacer días pasados.
