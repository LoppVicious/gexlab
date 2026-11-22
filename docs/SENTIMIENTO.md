# Sentimiento por put/call (diseño)

Aprobado el 2026-11-22. Indicador de sentimiento de 1 a 100 por ticker a partir del ratio put/call por tramos de
vencimiento, con divergencias frente al precio, lectura de mercado y señal de swing validada con la prueba en adelante
de `skew.py`.

## Objetivo

Tres usos con los mismos datos:

1. **Sentimiento de cada ticker:** su P/C frente a su propia historia (z robusta) en escala 1-100.
2. **Swing por acciones:** la z comparada entre acciones cada sesión, como señal más de `skew.py`.
3. **Sentimiento de mercado:** índices, amplitud de las acciones y P/C agregado.

Escala: **100 = codicia** (pocas puts frente a calls respecto a lo normal del ticker), **1 = miedo**.

## Datos

Fuente: la cadena de cierre que `historial500.py` ya descarga y guarda en `hist500/{SYM}/{fecha}.json.gz` (OI y
volumen por contrato). Sin llamadas nuevas. Historia disponible desde el 2026-11-04; CBOE no da volumen de opciones por
ticker de días pasados, así que no se puede ir más atrás.

Índice nuevo `hist500/_pcr.json.gz`:

```
{fecha: {SYM: {"t0": [vc, vp, oc, op], "t1": [...], "t2": [...], "all": [...]}}}
```

- Tramos por días naturales al vencimiento: `t0` 0-7, `t1` 8-45, `t2` más de 45, `all` todos.
- `vc`/`vp`: suma de volumen × |delta| de calls/puts; `oc`/`op`: lo mismo con OI. Delta de cada contrato: la del motor,
  que ya guarda la cadena compacta (`ch["delta"]`).
- Solo contratos fuera de dinero (calls con K > spot, puts con K < spot): fuera las calls dentro del dinero del
  arbitraje de dividendo y el peso de delta deja las alas baratas en su sitio. El spot se cancela en el ratio, por eso
  no se multiplica.
- Se guardan sumas, no ratios, para poder probar otras definiciones sin reconstruir.
- Todos los tickers del historial, índices y ETF incluidos. Un tramo sin contratos fuera de dinero queda
  `None`; si solo falta una pata, las sumas guardan el 0 y el ratio de ese día queda sin lectura.
- El OI de CBOE es el del día anterior: la serie de OI va desfasada una sesión; solo la usa la prueba.

Alta diaria dentro de `historial500.guardar_ticker` (mismo patrón que `puntos` de skew). Reconstrucción con
`historial500.py --indice` (llama a `pcr.reconstruir`, como a `skew.reconstruir`), con los días guardados.

## Puntuación de cada ticker

- x = log(vp / vc) del tramo.
- z = (x − mediana) / (1,4826 × MAD) con las `VENTANA` = 60 sesiones anteriores (sin la de hoy), mínimo `MIN_SES` =
  20. Con MAD = 0, sin lectura.
- Puntuación = 1 + 99 × Φ(−z), redondeada a entero. z alta (más puts que lo normal) = miedo = cerca de 1.
- Puntuación por tramo (`t0`, `t1`, `t2`, `all`) y **combinada** = 1 + 99 × Φ(−media(z_t0, z_t1)) (con uno solo, ese).
- También z con OI (`zoi`) por tramo, publicada pero sin puntuación en pantalla.
- Con menos de 20 sesiones: sin cifra, estado `n/20`.

## Divergencias

Por ticker, con la puntuación combinada y los cierres del índice de skew (`hist500/_skew.json.gz`, campo cierre):

- **Bajista:** cierre en máximo de 20 sesiones y media de la puntuación de las 5 últimas sesiones al menos
  `DIV_PUNTOS` = 15 por debajo de la media de las 5 anteriores.
- **Alcista:** cierre en mínimo de 20 sesiones y la media sube al menos 15.
- Se publica la última divergencia de cada ticker (tipo y fecha) y el registro de casos con el rendimiento a 10 y 40
  sesiones cuando ya existe (n, media y tasa de acierto por tipo). Sin veredicto hasta tener casos suficientes.

## Mercado

- Puntuación propia de SPX, SPY, QQQ e IWM (los que estén en el historial). En pantalla se avisa de que en índices el P/C
  es sobre todo cobertura y su extremo suele leerse a la contra.
- Amplitud de las acciones (`skew.es_accion`): mediana de la puntuación combinada y % por debajo de 20 y por encima
  de 80.
- P/C agregado de las acciones: suma de vp y vc de todas las acciones del día (tramos `t0`+`t1`), con su z y puntuación
  como si fuera un ticker más (`_STOCKS`).

## Swing en `skew.py`

- `SENALES["pcr"]`: nivel = z combinada de volumen (más puts que lo normal = valor alto), signo esperado −1 (más
  puts, peor rendimiento; Pan y Poteshman, 2006, con la salvedad de que aquí no hay volumen de apertura comprador).
- `skew` lee el índice de `pcr` y añade la z a sus filas antes de puntuar; reutiliza puntuación transversal, prueba a
  10 y 40 sesiones, diagnóstico y consenso. No hay motor de prueba nuevo.
- Si la prueba sale con el signo contrario de forma consistente, se cambia el signo con el dato delante.

## Publicación

`pub/pcr.json` (`/api/pcr` en el Worker y en `server.py`, como `/api/skew`):

```
{date, window, min_sessions,
 market: {indices: {SYM: {score, z}}, breadth: {median, fear_pct, greed_pct, n}, stocks: {score, z}},
 rows: [{sym, name, n, score, chg5, tranches: {t0|t1|t2|all: {pc, z, zoi, score}}, div: {type, date} | null}],
 expiries: {SYM: [{exp, dte, pc_vol, pc_oi}]},          // último día, por vencimiento
 series: {SYM: [[fecha, cierre, score], ...]},           // para el gráfico
 divergences: {bear: {n, ret10, ret40, hit10, hit40}, bull: {...}}}
```

Lo publica `historial500.py` tras el día y en `--indice`, siempre después de `publicar_skew` (lee de
`pub/skew.json` la prueba de la señal `pcr`).

## Web (en inglés)

Página **Sentiment** en el menú, junto a Skew signal (`web/sentiment.js`, `web/sentiment.css`):

- Tarjeta de mercado: medidor 1-100 de las acciones, amplitud, índices con su nota de lectura.
- Tabla de tickers ordenable: combinada, `t0`, `t1`, `t2`, cambio en 5 sesiones, divergencia.
- Al pulsar un ticker: precio con la puntuación debajo (escala 1-100, bandas 20 y 80) y P/C por vencimiento del día.
- Etiqueta "Not validated yet" mientras la señal de swing no tenga `enough` a 40 sesiones.
- Línea de sentimiento de mercado en Summary (`web/resumen.js`).
- Colores de `C`, temas claro y oscuro; sin «·» como separador; nombres globales propios (prefijo `sen`).

## Pruebas

- `pruebas/test_pcr.py` con cadenas sintéticas: exclusión de contratos dentro del dinero, peso por delta, tramos,
  z robusta y MAD 0, escala invertida (más puts, menos puntuación), mínimo de sesiones, divergencias en ambos sentidos,
  agregado de mercado.
- Ejecución real en Actions (`comparar.yml`) con la reconstrucción y la publicación; revisar a mano tickers conocidos.
- `node --check` de los JS tocados.

## Límites y calendario

- Puntuaciones con cifra hacia mediados de diciembre de 2026 (20 sesiones); veredicto del swing a 40 sesiones hacia
  febrero de 2027; las divergencias, cuando haya casos suficientes.
- Coste: un archivo pequeño más en R2 y unos segundos más en el historial diario. Sigue gratis.
