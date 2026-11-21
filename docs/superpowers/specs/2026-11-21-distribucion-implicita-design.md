# Distribución implícita y probabilidades de los niveles

Fecha: 2026-11-21. Estado: diseño aprobado, pendiente de plan de implementación.

## Objetivo

Dar, para cada ticker y vencimiento, la distribución de precios al vencimiento que descuentan las opciones
(neutral al riesgo) y, con ella, la probabilidad de que el precio cierre más allá de los niveles del motor (Call
Wall, Put Wall, flip) o los toque antes. Hoy la web da el rango de 1σ (`moves`) y el smile (`/api/vol`), pero no
cuánta probabilidad pone el mercado en cada zona ni la asimetría de las colas.

Idea tomada de una pantalla "IV Walls" de otra web; solo se adopta la distribución. No se copian sus trayectorias
simuladas ni su "True IV wall" (sin definición contrastable).

Fuera de alcance: comparar en la Validación la frecuencia real con la implícita (se hará cuando haya 20-30
sesiones guardadas), animaciones, trayectorias Monte Carlo.

## Enfoque

Cálculo en el motor (`gex_engine.py`, numpy puro, válido en Pyodide). Descartados: calcularlo solo en el navegador
con los smiles de `/api/vol` (sin vencimientos diarios, así que sin 0DTE en los índices; la vista del ticker no carga
`/api/vol`; no se guardaría) y un proceso nuevo en Actions (más llamadas a Tradier y escrituras en R2, ya al límite).

## Cálculo: `implied_distribution`

`gex_engine.implied_distribution(ch, spot, now, exp) -> dict | None` para un vencimiento:

1. Contratos vivos de `exp` con IV entre 0,01 y 5. Por strike, la IV de la opción fuera de dinero respecto al
   forward (`ch["fwd"]`, si no el spot; en el VIX, el futuro), la misma regla que `volatilidad.smiles_from_chain`.
   Sin alas de |delta| < 0,02.
2. Si quedan menos de 5 strikes o faltan menos de 30 minutos de mercado para el vencimiento: `None`.
3. Rejilla de 400 precios entre F·exp(−5σ√T) y F·exp(+5σ√T), con σ la IV ATM. IV interpolada linealmente en
   log-strike; fuera del primer y último strike cotizado, plana.
4. Precio de call no descontado de Black (forward F, T del contrato, la misma convención de T que la IV) en cada
   punto. Densidad = segunda derivada numérica respecto al strike (Breeden-Litzenberger).
5. Densidades negativas a 0 y normalización a masa 1. Se guarda la masa negativa recortada (`clip`) como control de
   calidad; si supera el 5 %, la salida lleva `"noisy": true`.

Salida:

```
{"exp": "2026-11-21", "days": 0, "T": 0.0012, "fwd": 671.2, "atm_iv": 0.435,
 "x": [...400], "pdf": [...400], "logn": [...400],      # logn: lognormal con la IV ATM, para ver el sesgo
 "q": {"5": .., "25": .., "50": .., "75": .., "95": ..},
 "clip": 0.004, "noisy": false}
```

Funciones auxiliares, también en `gex_engine`:
- `prob_beyond(dist, level, side)`: probabilidad de cerrar por encima (`"up"`) o por debajo (`"down"`) de `level`,
  integrando la densidad (CDF acumulada e interpolación).
- `prob_touch(p_close)`: `min(1, 2 · p_close)` (regla de reflexión, sin deriva). Es una estimación; la web la marca
  con ≈.

## Probabilidades de los niveles (resultado del ticker)

En el resultado de `compute` (junto a `moves`), bloque `level_probs`:

```
"level_probs": [
  {"exp": "2026-11-21", "days": 0,
   "call_wall": {"close": 0.12, "touch": 0.24},    # por encima
   "put_wall":  {"close": 0.18, "touch": 0.36},    # por debajo
   "flip":      {"side": "down", "close": 0.41, "touch": 0.82}},   # lado del flip respecto al spot
  {"exp": "2026-11-21", ...}                       # viernes de la semana, solo si es otro vencimiento
]
```

- Vencimientos: el próximo (0DTE en los índices) y el viernes de esa misma semana si es distinto (en el VIX, el
  miércoles; jueves o martes si el día habitual es festivo).
- Niveles: los del filtro y motor activos (`levels`). Call Wall siempre "por encima", Put Wall siempre "por debajo",
  flip hacia el lado donde está respecto al spot. Si el spot ya está más allá del nivel, `touch` se omite (ya lo ha
  tocado) y solo se da `close`. Un nivel ausente se omite.
- Coste: dos distribuciones por cálculo; el resultado solo lleva las probabilidades, no la rejilla.

## Web

**Vista del ticker** (`web/app.js`, tarjeta del rango de 1σ, `#facts`): una línea bajo el rango, p. ej.
`Close above Call Wall 12% (touch ≈24%), below Put Wall 18% (≈36%)`, con el vencimiento del primer bloque; el
`title` explica el método y da el segundo vencimiento. Sin dato: la línea no aparece.

**Volatility dashboard** (`web/vol.js`): vista nueva `Distribution` (pestaña y tarjeta en Overview).
- Datos: `/api/vol` añade `dists`: la distribución del próximo vencimiento (aunque sea diario) y de cada smile
  (semanales y mensuales del horizonte), con la rejilla reducida a 200 puntos.
- Gráfico: densidad del vencimiento elegido (selector como el del skew), lognormal discontinua, banda de ±1σ y línea
  del spot. Si el ticker está cargado en la app (`state.data` del mismo símbolo), líneas de Call Wall, Put Wall y
  flip con su probabilidad.
- Tabla de percentiles 5/25/50/75/95 y, al pasar el cursor, probabilidad por encima y por debajo de ese precio.
- Colores de `C` (tema); comprobada en Bento oscuro y Daylight. Textos en inglés, cifras en-US, sin «·».
- `"noisy": true`: aviso "Sparse quotes, shape approximate".

## Histórico

- `gex_engine._snap` añade `pc_cw`, `pc_pw`, `pc_flip` (probabilidad de cierre del primer bloque de `level_probs`) y
  `pc_exp`.
- `historial500.CAMPOS_INDICE` las incluye, así que entran en `hist500/_niveles/{SYM}.json.gz` cada día.
  `--indice` las rellena para los días pasados recalculando con la cadena guardada en `hist500/{SYM}/{fecha}`.
- La cadena del cierre ya se guarda, así que cualquier distribución pasada se puede recalcular; no se guarda la
  rejilla.

## Errores y casos límite

- Sin IV, pocos strikes o vencimiento a punto de expirar: `None`, y la web no muestra nada de ese vencimiento.
- Cadena de CBOE de respaldo sin `fwd`: se usa el spot.
- Índices AM (SPX mensual): se usa el vencimiento que eligió `smiles_from_chain` (un solo vencimiento por día).

## Pruebas

`pruebas/test_dist.py` (local, sin red):
- IV plana: la densidad coincide con la lognormal exacta (error máximo < 1 % del pico) y `prob_beyond` con
  N(d2) (< 0,5 puntos).
- Masa total 1, media dentro del 0,2 % del forward, percentiles ordenados.
- Smile con sesgo de puts: cola izquierda más pesada que la lognormal (q5 por debajo).
- `prob_touch` acotada en 1.

Con datos reales (`comparar.yml`): SPX, QQQ, NVDA y VIX; comprobar que q50 queda cerca del forward, que `clip` es
pequeño y que la probabilidad de cerrar fuera del rango de 1σ ronda el 32 %.
Comprobación en la web (local con `server.py` y en producción tras el despliegue): las dos vistas en los dos temas.
