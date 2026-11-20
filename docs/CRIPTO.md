# Crypto: diseño

Página **Crypto** (sección propia en la barra lateral) para BTC y ETH: derivados a fondo, on-chain y una lectura
por reglas con umbrales fijos. Todo gratis y sin claves.

## Fuentes (probadas desde Actions el 2026-11-20)

| Fuente | Uso | Notas |
|---|---|---|
| Deribit | cadena de opciones (OI, `mark_iv`, forward por vencimiento), futuros, perpetuo, DVOL, velas diarias | sin límite práctico |
| OKX | funding (actual e histórico), OI agregado y ratio de cuentas long/short | |
| CoinMetrics Community | precio, capitalización, MVRV, oferta, flujos de exchanges, saldo en exchanges, direcciones activas | diario; SOPR, NUPL, NVT y cohortes no son gratis |
| bitcoin-data.com | STH y LTH realized price (solo BTC) | 15 peticiones al día, 10 por hora, datos con 7 días de retraso |
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

## Fases

1. Hecha: derivados, mapa de niveles, MVRV, realized price, STH y LTH, flujos de exchanges y lectura.
2. SOPR y STH-SOPR, hash ribbons y Puell (CoinMetrics: hashrate y emisión), direcciones activas, stablecoins en
   detalle, percentiles de todo.
3. Historial diario propio en R2 y señales con su backtest (rentabilidad a 30 y 90 días de cada señal).
