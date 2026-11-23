# Crypto: diseño

Página **Crypto** (sección propia en la barra lateral) para BTC y ETH: derivados a fondo, on-chain y una lectura
por reglas con umbrales fijos. Todo gratis y sin claves.

## Fuentes (probadas desde Actions el 2026-11-20)

| Fuente | Uso | Notas |
|---|---|---|
| Deribit | cadena de opciones (OI, `mark_iv`, forward por vencimiento), futuros, perpetuo, DVOL, velas diarias | sin límite práctico |
| OKX | funding (actual e histórico), OI agregado y ratio de cuentas long/short | |
| CoinMetrics Community | precio, capitalización, MVRV, oferta, flujos de exchanges, saldo en exchanges, direcciones activas | diario; SOPR, NUPL, NVT y cohortes no son gratis |
| bitcoin-data.com | STH y LTH realized price, SOPR y STH-SOPR (solo BTC, desde 2022) | 15 peticiones al día, 10 por hora, datos con 7 días de retraso; usamos 4 al día |
| CoinGecko | top por capitalización, dominancia | |
| DefiLlama | oferta total de stablecoins | |
| alternative.me | Fear & Greed | |

Bloqueadas desde Actions (IP de EE. UU.): Bybit (403) y Binance (451). Prueba: `pruebas/cripto_fuentes.py` en
`comparar.yml`.

## Cálculo (`cripto.py`)

`cripto_calc.py` tiene el cálculo puro (sin red, probado en `pruebas/test_cripto.py`); `cripto.py` descarga y
publica.

- **GEX** con la metodología del motor Perfil, no con `gex_engine.compute` (atado al horario de NYSE):
  IV de cada contrato (`mark_iv`), tiempo natural hasta el vencimiento (08:00 UTC) con mínimo de 1 h, gamma de
  Black-76 sobre el forward de cada vencimiento (`underlying_price` de Deribit) con r = q = 0. Las opciones de
  Deribit son inversas (prima en la moneda), pero su valor en USD es el de una opción lineal, así que la gamma en
  USD es la de Black-Scholes. Contrato = 1 BTC o 1 ETH.
  - GEX = signo · Γ · OI · F² · 1 %; dealers largos de calls y cortos de puts (convención estándar).
  - Perfil en ±25 % del spot moviendo todos los forwards en proporción (IV fija por strike).
  - Flip: cruce por cero del perfil más cercano al spot dentro de ±15 %. Call Wall: mayor GEX de calls por encima
    del spot; Put Wall: mayor GEX de puts por debajo, ambos en ±20 %.
  - Filtros: 7 días, 30 días y todos.
  - Max pain por vencimiento; nocional y max pain del siguiente vencimiento grande.
  - Solo Deribit: no incluye CME ni las opciones de los ETF (IBIT).
- **Volatilidad**: DVOL con su percentil del último año, volatilidad realizada a 30 días (velas diarias del
  perpetuo), prima de varianza (DVOL − RV30), y por vencimiento IV ATM (en el forward), risk reversal y butterfly
  de 25 delta.
- **Futuros y perpetuos**: basis anualizada de cada futuro de Deribit, funding de OKX (actual y media de 7 días,
  anualizados), OI de OKX y su cambio en 7 días, ratio de cuentas long/short.
- **On-chain**: realized price = capitalización / MVRV / oferta (CoinMetrics); MVRV en directo = spot / realized
  price; percentil del MVRV desde 2015; flujo neto a exchanges en 7 días y cambio del saldo en 30; STH y LTH
  realized price (BTC).
- **Mapa de niveles**: on-chain (LTH RP, RP, STH RP) y opciones (Put Wall, flip, Call Wall, max pain) ordenados por
  precio con su distancia al spot.

## Lectura

Dos ejes separados, porque mezclan cosas distintas:

1. **Tendencia** (estructura): precio frente al STH realized price, frente al flip de gamma y cambio a 30 días.
2. **Posicionamiento** (contrarian): Fear & Greed, funding, ratio long/short, risk reversal de 25 delta y prima
   de varianza. Miedo extremo, funding negativo y puts caras puntúan al alza.

Cada punto lleva texto, tono (+1, 0, −1) y bloque. Casos especiales: **capitulación** (precio por debajo del
realized price o MVRV < 1, con Fear & Greed < 20) y **sobrecalentamiento** (MVRV > 3, o funding anualizado > 30 %
con Fear & Greed > 80). Umbrales en `cripto_calc.UMBRALES`.

## Publicación

- `cripto.yml` cada 15 min, lanzado por el cron del Worker (`tocaCripto`, 24/7). Escribe `pub/cripto.json`
  (~2.900 escrituras al mes).
- Datos diarios (CoinMetrics, bitcoin-data, DVOL de un año, velas, Fear & Greed, stablecoins) en
  `cripto/diario.json`; se renuevan si tienen más de 6 h (bitcoin-data, más de 20 h: 2 peticiones al día).
- Web: `/api/crypto` → `pub/cripto.json` (`nube.js`); en el PC, `server.py` lo lee del almacén.

## Fase 2: mineros, beneficio, actividad y liquidez

- **Mineros** (`mineros`, solo BTC): hash ribbons (media de 30 días del hashrate frente a la de 60; capitulación si
  queda por debajo, "recovery" en los 30 días tras volver a cruzar por encima con al menos 10 días por debajo) y
  múltiplo de Puell (emisión diaria en USD / su media de 365 días). CoinMetrics `HashRate` (TH/s) e `IssTotUSD`.
- **Beneficio** (`beneficio`, solo BTC): SOPR y STH-SOPR de bitcoin-data, media de 7 días y días seguidos por debajo de 1.
- **Actividad** (`actividad`): direcciones activas y transacciones, media de 30 días frente a la de 365.
- **Liquidez** (`liquidez`): stablecoins de DefiLlama, total y las 5 mayores con cambio a 7 y 30 días.
- Percentiles frente a su historia: MVRV (desde 2015), Puell (2012), direcciones (2015), SOPR (2022), DVOL (último año),
  Fear & Greed (2018).

## Fase 3: señales con su historia

`senales` + `backtest`: un caso es el primer día en que se cumple la condición (en las de cruce, tras al menos 10 o 14
días sin cumplirse), con 30 días como mínimo desde el caso anterior. Para 30 y 90 días: mediana, media, % al alza, peor
y mejor; y la referencia, cualquier día del mismo periodo (desde el primer dato de la señal). Precio: cierre diario
de CoinMetrics. Las ventanas de 90 días se solapan y hay pocos casos: es contexto, no prueba.

| Señal | Condición | Desde |
|---|---|---|
| `mvrv_bajo` / `mvrv_alto` | MVRV < 1 / > 3 | 2012 (ETH 2015) |
| `sth_recupera` / `sth_pierde` | cierre por encima / debajo del STH realized price tras 14 días al otro lado | 2022 (BTC) |
| `hash_compra` | media 30 d del hashrate cruza sobre la de 60 d tras 10 días por debajo | 2012 (BTC) |
| `puell_bajo` | Puell < 0,5 | 2012 (BTC) |
| `sth_sopr_recupera` | media 7 d del STH-SOPR > 1 tras 14 días por debajo | 2022 (BTC) |
| `miedo` / `codicia` | Fear & Greed ≤ 15 / ≥ 85 | 2018 |
| `dvol_alto` | DVOL en el percentil 90 de su último año o más | 2022 |

En la lectura entran las activas hoy (señales de estado) o con un caso en los últimos 30 días, con tono según su
historia frente a la referencia (no según la lectura habitual).

**Historial propio:** `cripto/hist.json`, una foto por día UTC (`foto`: spot, GEX, flip, IV ATM, risk reversal,
butterfly, DVOL, realizada, funding, OI, long/short, put/call) en la primera pasada del día. Con 30 días o más, la
web muestra su percentil (`percentiles_propios`). Servirá para backtestear las señales de derivados.

## Señales de derivados

Grupo `derivados` en `senales` (los demás: `onchain`, `sentimiento`). Con historia pública:

| Señal | Condición | Desde | Fuente |
|---|---|---|---|
| `dvol_alto` | DVOL en el percentil 90 de su último año o más | 2022 | Deribit |
| `vrp_negativo` / `vrp_alto` | DVOL − volatilidad realizada a 30 días < 0 / ≥ 20 (`vrp_senal`) | 2021 | Deribit y CoinMetrics |
| `funding_negativo` | media 7 d del funding del perpetuo < 0 tras 14 días por encima | 2019 | Deribit (`get_funding_rate_history`) |
| `funding_alto` | media 7 d del funding ≥ 30 % anual | 2019 | Deribit |
| `oi_flush` | OI de OKX −15 % o más en 7 días con el precio a la baja | 2026-05 (180 días y se amplía) | OKX |
| `lsr_alto` | 3 o más cuentas largas por cada corta | 2026-05 (ídem) | OKX |

Sin historia pública (risk reversal y GEX): `puts_caras` (risk reversal 25 delta a 30 días ≤ −8) y `gex_negativo`
(GEX neta < 0) usan nuestra foto diaria; la tabla las muestra "collecting since" hasta que haya casos con 30 y 90
días por delante.

## Web

- Arriba, una tira de resumen en todas las pestañas (`cxResumen`): BTC/ETH, precio, cambio en 24 h (7 y 30 días al
  pasar el ratón), estado y cuatro cifras (Net GEX, MVRV, DVOL, Fear & Greed). La lectura completa (ejes, puntos, seis
  cifras con contexto, señales activas y todas las cifras) es el primer panel de Overview; los paneles ocupan todo el
  ancho. En Liquidations la tira sigue al activo del mapa (`cxTiraLiq`, llamada desde `lqSet` y `lqMontar`):
  BTC y ETH cambian `cx.sym`; otros, `cxTiraMapa` (nombre, precio y cambio en 24 h de las velas del mapa).
- Pestañas: Overview (GEX, niveles, coste on-chain, volatilidad), Derivatives (GEX, estructura temporal, funding,
  basis, apalancamiento de OKX, vencimientos), On-chain (coste, mineros, SOPR, actividad de redes, stablecoins),
  Signals y Market. Se recuerda la última pestaña.
- Gráficos de series ampliables (`cxChart`, `cxOpenModal`): rango 3M a todo, escala logarítmica donde tiene sentido
  (coste, mineros, actividad), eje derecho, leyenda que oculta series y tooltip con todas las series del día.
- Actividad de red: BTC, ETH, TRX, XRP, LTC, DOGE, BCH, XLM y ADA (SOL, BNB y DOT no son gratis en CoinMetrics),
  direcciones activas o transacciones, medias de 30 y 365 días y precio.
- Señales: filtro por grupo o activas, orden por columna y, al abrir una, sus casos sobre el precio (verde si 90 días
  después estaba más arriba) con la lista de casos.

## Mapa de liquidaciones (pestaña Liquidations)

Estimación de dónde están los precios de liquidación de las posiciones apalancadas abiertas, como Coinglass o Hyblock,
para cualquier activo del top 250 de CoinGecko con perpetuos en Binance, Bybit, OKX o Hyperliquid.

- **Datos:** Coinalyze (clave gratuita, secreto `COINALYZE_API_KEY`): velas con volumen comprador, OI y liquidaciones
  reales de cada perpetuo. Historia probada (BTCUSDT de Binance): velas diarias desde 2019, OI diario desde octubre de
  2022, liquidaciones diarias desde 2020; OI cada 4 h unos 11 meses, cada hora unos 3 meses, cada 5 min 7 días (unos
  2.000 puntos por petición: cada marco ya pide ese máximo).
- **Lista de activos:** `cripto.py` (`liq_mercados`) una vez al día: `future-markets` de Coinalyze cruzado con el top
  250 de CoinGecko; para cada activo, sus perpetuos por exchange y el símbolo de las velas (Binance en USDT si existe).
  R2 `pub/liq_mercados.json`, ruta `/api/liq_markets`.
- **Intermediario:** `/api/liq?kind=ohlcv|oi|liq&interval=&symbols=&from=&to=` en el Worker: lista cerrada de
  parámetros, pone la clave (como parámetro: la cabecera `api_key` la descarta algún intermediario), guarda la
  respuesta en memoria de 1 a 30 min según el intervalo (la Cache API no funciona en workers.dev). La clave nunca llega
  al navegador. Coinalyze: 40 llamadas por minuto, y **cada símbolo cuenta como una llamada**: cada mapa pide las velas
  (1) y el OI y las liquidaciones de un perpetuo por exchange (el de USDT, o el inverso en USD si no hay;
  `lqSimbolos`: BTC son 1 + 4 + 4). La clave es una sola para todos los usuarios. Al límite (429), el Worker devuelve la copia anterior si la tiene o `retry` con los segundos
  de `Retry-After`, y la web espera y reintenta con cuenta atrás. La web guarda en memoria lo ya cargado por activo,
  marco y exchanges (24 entradas, frescas lo mismo que en el Worker) y pide las liquidaciones reales después del mapa.
  El Worker y `liq_local.py` solo guardan y sirven listas JSON (otra respuesta de Coinalyze es un 502); si una carga
  falla sin copia que enseñar, el mapa se vacía y sale el error con Retry (`lqVaciar`), en vez de quedarse el anterior.
- **Modelo** (`web/liq-modelo.js`, pruebas en `pruebas/test_liq.mjs`):
  1. Posiciones nuevas de cada vela: subida del OI sumando el cambio de cada perpetuo (no el nivel, para que un
     exchange que empieza tarde no cree un salto). Antes del primer OI, volumen × factor calibrado con el tramo con OI.
  2. Largos = parte compradora del volumen agresor (bv / v); cortos, el resto.
  3. Apalancamientos 5x, 10x, 25x, 50x y 100x con pesos 10/30/30/20/10 %; liquidación de un largo
     precio × (1 − 1/L + 0,5 %), de un corto precio × (1 + 1/L − 0,5 %); precio de entrada (máx + mín + cierre) / 3.
  4. Un nivel vive hasta que el precio lo toca; entonces cuenta como liquidación prevista de esa vela.
  5. Si baja el OI, lo vivo se reduce en proporción; y todo decae con una vida media (5 min: 12 h; 15 min: 1 día;
     1 h: 4 días; 4 h: 15 días; diario: 45 días; fija, sin selector en la web).
  6. Rejilla de 600 tramos de precio logarítmicos; recurrencia por tramo (decae, se reduce, suma altas, resta tocadas).
     Con la opción `ancho`, cada nivel se reparte en la parte central del rango de su vela (no se usa en la web).
- **Niveles sueltos** (`niveles` del modelo): inicio, fin (vela en que el precio lo toca o en que le queda menos de
  `VIVO_MIN`, una cuarta parte, por memoria y OI cerrado), precio, lado y tamaño al nacer con la escala del OI.
- **Rejilla de dibujo** (`gV`), como mapaliquidaciones.com: cada nivel se reparte entre los precios de liquidación de
  las entradas posibles de su vela (`anchoMapa`, la fracción del rango a cada lado del precio medio: 0,6 hasta 1 h, 0,3
  en 4 h y 0,15 en diario), con su OI nuevo, topado por el OI que sigue abierto (mínimo del OI total desde que nació
  frente al de entonces). Un nivel crece mientras se abren posiciones a ese precio y se mantiene hasta que el precio lo
  barre: no se apaga con la edad. Con el OI total (`nivel`), todo va por un factor `G` que hace que lo vivo en la última
  vela sume el OI de ese momento (sin ningún ajuste ya daba el 92 % en ETH de 1 h). Antes cada nivel se escalaba con la
  memoria, que en 15 min se vacía en un día, y ETH de 15 min sumaba $69B con $7,7B de OI; luego se probó repartir el
  OI de cada vela con la memoria, que apagaba las bandas con la edad y las dejaba a trozos. Sin OI total, tamaño al
  nacer con la escala de la memoria. `enMapa` da lo mismo por nivel (sin `anchoMapa`, exacto), para el tooltip. Los
  niveles que el precio toca antes de `vidaMin` velas (`LQ_VIDA_MIN`, 6) no entran. La memoria (`finL`, `finS`) ya no
  se enseña. El modelo admite aún `zona` (suma de tramos a ±zona, `gZ`), que la web ya no usa: `gZ` es `gV`.
- **Dibujo** (`lqPintar`), como mapaliquidaciones.com: filas de 2 px (`LQ_BANDA`) con el tramo más cargado de los que
  caen en cada una, una columna por vela visible, y color relativo a la vista: el más cargado de lo que se ve es rojo
  y cada casilla toma el escalón de su fracción (`lqPaleta`, colores del tema: azul casi del fondo, azul, verde, ámbar
  y rojo, desde 0, 30, 50, 72 y 92 %). Al hacer zoom o desplazarse se recalcula. La intensidad mínima (10 % por
  defecto, `lqMin6`) también es relativa a la vista. La vista inicial: un día en 5 min, tres en 15 min, una semana en
  1 h, un mes en 4 h y ocho meses en diario. Leyenda: los cinco escalones y desde cuántos dólares es rojo en la vista.
  Por defecto, todos los apalancamientos (`lqLevOff3`); ocultar uno solo quita sus franjas. Perfil: la última columna
  con su propia escala (su barra mayor es roja); el grupo mayor a cada lado como línea con etiqueta en el eje (Longs,
  Shorts), con la intensidad mínima frente al más cargado de la última vela. El ajuste automático del eje de precios incluye esos
  dos grupos (`lq.extremos`, `autoscaleInfoProvider` de la serie de velas).
- **Controles:** una fila: activo (caja con lista y buscador), marco, Settings (popover con los atajos Swing, diario
  5x a 25x, y Scalp, 15 min 25x a 100x, apalancamientos, intensidad mínima y exchanges; se cierra al pulsar fuera o con
  Esc), Copy image y Full screen. Debajo del mapa, la leyenda de color en dólares (de la intensidad mínima al tope) y
  el veredicto con la liquidez más cercana; las tarjetas y la explicación, en Details. Tooltip al pasar por una franja (rango de precio, dólares, distancia al precio actual, lado, mezcla de
  apalancamientos y fechas en que se abrieron). La vista inicial deja sitio al perfil según el ancho. Copy image
  (`lqPngBlob`: `takeScreenshot` de la librería con cabecera; si el portapapeles falla, descarga el PNG).
- **Lectura:** bajo el mapa, el veredicto de presión (cortos por encima frente a largos por debajo a ±5 %, ±10 % en
  4 h y ±15 % en diario) y «Nearest liquidity» (el más cercano de los grandes grupos a cada lado); en Details, los tres grupos más
  cargados a cada lado y la fiabilidad del modelo (Good, Fair o Weak según la correlación, en log, entre liquidaciones
  previstas y reales por vela; la r va en el texto).
- **Modo PC** (`liq_local.py`): con `COINALYZE_API_KEY` en el entorno, igual que el Worker; sin ella, datos públicos
  de Binance (velas con volumen comprador y 30 días de OI), sin liquidaciones reales.

## Pendiente

- Flujos de los ETF spot (no hay fuente gratuita estable).
