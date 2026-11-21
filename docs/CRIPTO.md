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
  2.000 puntos por petición; el botón Older pide tramos anteriores).
- **Lista de activos:** `cripto.py` (`liq_mercados`) una vez al día: `future-markets` de Coinalyze cruzado con el top
  250 de CoinGecko; para cada activo, sus perpetuos por exchange y el símbolo de las velas (Binance en USDT si existe).
  R2 `pub/liq_mercados.json`, ruta `/api/liq_markets`.
- **Intermediario:** `/api/liq?kind=ohlcv|oi|liq&interval=&symbols=&from=&to=` en el Worker: lista cerrada de
  parámetros, pone la clave (como parámetro: la cabecera `api_key` la descarta algún intermediario), guarda la
  respuesta en memoria de 1 a 30 min según el intervalo (la Cache API no funciona en workers.dev). La clave nunca llega
  al navegador. Coinalyze: 40 peticiones por minuto; cada mapa son 3.
- **Modelo** (`web/liq-modelo.js`, pruebas en `pruebas/test_liq.mjs`):
  1. Posiciones nuevas de cada vela: subida del OI sumando el cambio de cada perpetuo (no el nivel, para que un
     exchange que empieza tarde no cree un salto). Antes del primer OI, volumen × factor calibrado con el tramo con OI.
  2. Largos = parte compradora del volumen agresor (bv / v); cortos, el resto.
  3. Apalancamientos 5x, 10x, 25x, 50x y 100x con pesos 10/30/30/20/10 %; liquidación de un largo
     precio × (1 − 1/L + 0,5 %), de un corto precio × (1 + 1/L − 0,5 %); precio de entrada (máx + mín + cierre) / 3.
  4. Un nivel vive hasta que el precio lo toca; entonces cuenta como liquidación prevista de esa vela.
  5. Si baja el OI, lo vivo se reduce en proporción; y todo decae con una vida media (5 min: 12 h; 15 min: 1 día;
     1 h: 4 días; 4 h: 15 días; diario: 45 días; Memory la multiplica por 0,5 o 2).
  6. Rejilla de 600 tramos de precio logarítmicos; recurrencia por tramo (decae, se reduce, suma altas, resta tocadas).
     Con la opción `ancho`, cada nivel se reparte en la parte central del rango de su vela (no se usa en la web).
- **Niveles sueltos** (`niveles` del modelo): inicio, fin (vela en que el precio lo toca o en que le queda menos de
  `VIVO_MIN`, una cuarta parte, por memoria y OI cerrado), precio, lado y tamaño al nacer con la escala del OI.
- **Rejilla de dibujo** (`gV`): en cada tramo y vela, la suma de los niveles vivos a su tamaño al nacer (diferencias
  por tramo y suma acumulada). No decae por el camino: cada banda mantiene el color hasta que cambia lo que contiene.
- **Dibujo** (`lqPintar`), como Bitunix: filas de 8 px (`LQ_BANDA`) con la suma de los tramos que caen en cada una y
  1 px de separación, una columna por vela visible. Color sólido frente al percentil 99 de lo visible (azul apagado,
  verde, amarillo, rojo: colores del tema); solo lo que pasa la intensidad mínima (40 %). Perfil
  con las mismas franjas, curvas de lo acumulado y los dos grupos mayores como líneas con etiqueta en el eje.
- **Lectura:** presión (cortos por encima frente a largos por debajo a ±5 %, ±10 % en 4 h y ±15 % en diario), los tres
  grupos más cargados a cada lado y el acierto del modelo: correlación (log) entre liquidaciones previstas y reales por
  vela.
- **Modo PC** (`liq_local.py`): con `COINALYZE_API_KEY` en el entorno, igual que el Worker; sin ella, datos públicos
  de Binance (velas con volumen comprador y 30 días de OI), sin liquidaciones reales.

## Pendiente

- Flujos de los ETF spot (no hay fuente gratuita estable).
