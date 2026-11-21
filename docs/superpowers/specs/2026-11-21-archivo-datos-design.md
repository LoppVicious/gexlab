# Archivo de datos para modelado y estadística

Fecha: 2026-11-21. Estado: propuesta de diseño, sin implementar. No cambia código.

## Objetivo

Guardar casi todo lo que GEX Lab descarga y calcula, para poder hacer modelos y estadística más adelante, sin salir
del coste 0 €. Prioridad: lo que no se puede volver a conseguir (cadenas intradía con OI, IV y cotizaciones; velas de
1 min de más de 20 días; flujo; consenso de ForexFactory; cadena de Deribit). Lo que se recalcula a partir de esas
entradas no hace falta guardarlo.

Principio: **archivar entradas, no vistas.** Niveles, mapa TRACE, escáner, Compass, superficie de volatilidad y
Validación salen de la cadena, las velas y el calendario con `gex_engine`. Si se guardan las entradas, cualquier vista
se rehace con cualquier versión del motor (y con motores nuevos). Las salidas solo se guardan cuando son muy pequeñas
y sirven para saber qué vio el usuario en su momento.

## Cifras medidas (2026-11-21)

- **Lista del historial diario: 529 tickers** (no 114). Última sesión completa (2026-11-19): 480/529, **7,7 MB** de
  `hist500/` en el día (unos 16 KB por ticker; SPY 185 KB, QQQ 159, AAPL 52, KO 18), 58 min.
- **R2 total: 0,49 GB en 5.166 archivos** (`estado/uso.json`, 2026-11-19).
- **Estado del motor: 46,9 MB** (`estado/estado.tar.gz`, ciclo del 2026-11-21) y se guardan 14 copias diarias
  (`estado/copias/`): unos 0,66 GB cuando estén todas. Ha crecido con la pasada post-cierre de los 529 tickers.
- **Cadenas de los 6 índices en tiempo real** (`fx/{SYM}.min.json` del paquete, Tradier, JSON gzip):
  SPX 530 KB (29.922 contratos), NDX 234, SPY 215, QQQ 181, RUT 162, IWM 80: **1,40 MB por foto de los 6**.
- **Formato en columnas** (prueba con las 82 cadenas de `cache/ultima_cadena/`, solo contratos con OI o volumen;
  enteros cuantizados: precios en centavos, IV en 1/10.000, strike en milésimas; bytes reordenados por columna y
  `lzma`): 1,55 MB frente a 3,66 MB en JSON gzip, **2,4 veces menos**. La parte fija del día (strike, vencimiento,
  tipo, OI) es el 22 %; la que cambia en cada foto (bid, ask, último, volumen, IV del proveedor) el 78 %.
- **Parte que cambia de los 6 índices por foto, en columnas**:

  | Contratos de la foto             | SPX    | NDX   | SPY   | QQQ   | RUT   | IWM   | Los 6   |
  |----------------------------------|--------|-------|-------|-------|-------|-------|---------|
  | Todos (con OI o volumen)         | 173 KB | 60 KB | 56 KB | 51 KB | 36 KB | 20 KB | 396 KB  |
  | ±10 % del precio y ≤ 60 días     | 68 KB  | 32 KB | 17 KB | 18 KB | 17 KB | 7 KB  | 159 KB  |
  | ±5 % del precio y ≤ 14 días      | 19 KB  | 13 KB | 7 KB  | 7 KB  | 6 KB  | 3 KB  | 55 KB   |

  Son cotas altas: una foto suelta. Codificando cada foto como diferencia de la anterior (el volumen casi no cambia
  de un minuto a otro en la mayoría de contratos) saldrá menos; no se ha medido.
- **Escrituras de clase A en R2.** La cifra de ~0,87 M/mes (ARQUITECTURA) se hizo con 114 tickers. Con 529 se suman,
  por sesión, unas 3 escrituras por ticker en `historial500.py` (día, `_niveles`, `_flujo`) y otras ~3 en la pasada
  post-cierre del motor (`paquete`, `vol`, `flujo`): ~3.200 al día, **~70.000 al mes**. Hoy estaríamos cerca de
  **0,94 M/mes**, con poco margen. Hay que medirlo en el panel de Cloudflare antes de añadir nada.

Límites gratuitos comprobados:

| Servicio | Límite gratis | Encaje |
|---|---|---|
| R2 | 10 GB-mes, 1 M clase A/mes, 10 M clase B/mes; borrar es gratis | Almacén caliente; el espacio es el límite |
| GitHub Releases (repo privado) | 2 GiB por archivo, hasta 1.000 por release, sin límite de tamaño total ni de ancho de banda según la documentación | **Archivo frío** recomendado |
| Git LFS (cuenta Free) | 10 GiB de almacenamiento y 10 GiB/mes de descarga; al pasar el tope sin tarjeta se cortan las descargas de LFS de toda la cuenta | Cabe unos años, pero las descargas de Actions cuentan |
| Repo Git normal | Recomendado < 1 GB, muy recomendado < 5 GB; push < 2 GB; archivos < 100 MB | Solo para cosas pequeñas |
| D1 (plan Free) | 5 GB por cuenta, 500 MB por base, 100.000 filas escritas/día (desde el 2026-09-01 falla al pasarlo) | Tablas compactas consultables, no cadenas |
| Artefactos de Actions | 90 días como máximo; en repo público los descarga cualquier usuario de GitHub | **Descartado**: datos públicos y caducan |
| Workers KV | 1 GB, 1.000 escrituras/día | Descartado |

## Inventario

Leyenda de frecuencia: **1 min** = modo rápido (6 índices, 09:30-16:15 ET; antes de abrir cada 5 min);
**15 min** = ciclo (tickers de las listas, 23 hoy); **cierre** = una vez por sesión. "Tar" = `estado/estado.tar.gz`.

### Entradas (lo que se descarga)

| Dato | Qué es | Dónde | ¿Se guarda? | Frecuencia | Retención | Clave |
|---|---|---|---|---|---|---|
| Cadena al cierre (529 tickers + VIX) | Cadena compacta con OI, IV, bid, ask, volumen, último, forward | `historial500.guardar_ticker` | Sí | cierre | **2 años** (`RETENCION_ANOS`); VIX siempre | `hist500/{SYM}/{fecha}.json.gz` |
| Cadena intradía (6 índices) | La misma cadena, cada pasada | `motor.paquete` | **No**: se sobrescribe | 1 min | Solo la última | `pub/t/{SYM}/paquete.json` |
| Cadena intradía (listas) | Ídem | `motor.paquete` | **No** | 15 min | Solo la última | ídem |
| Copia de la cadena del día | K, tipo, vencimiento, OI, IV, forward (sin cotizaciones) | `g.save_chain_snapshot` | Sí, pero una por día | cada 30 min, se sobrescribe | 10 sesiones | tar `history/chains/` |
| Última cadena buena | Para reparar cadenas incompletas | `g._reparar_cadena` | Solo la última | 10 min | — | tar `cache/ultima_cadena/` |
| Velas de 1 min | OHLCV de la sesión (6 índices de Tradier; resto de CBOE) | `motor.paquete`, `ft.velas`, `ft.velas_pre` | **No** | 1 min / 15 min | Solo la sesión | `fx/intraday_{SYM}.json` en el paquete |
| Velas diarias | Años de historia | Tradier `historico`, CSV de CBOE | No hace falta (se pueden volver a pedir) | — | — | caché `cache/hist/` |
| OI del día anterior por contrato | Cambio de OI | `g.oi_previo` (de `flow_`) | Sí | cierre | 8 sesiones | tar `history/flow_{SYM}` |
| Familia VIX (OHLC) y curva de futuros | VIX, VIX9D, VIX3M, VIX6M, VIX1Y, futuros | `guardar_indices_vol` | Sí | cierre | Siempre | `hist500/_indices_vol/` |
| Curva del VIX en directo | Futuros intradía | `macro._live_curve` | **No** | 15 min | — | `pub/vix.json` |
| COT | Posiciones CFTC | `macro.cot` | Caché | semanal | 3 años, recuperable | tar `cache/cot.json.gz` |
| SqueezeMetrics, COR, DSPX, SKEW, VVIX | Series diarias públicas | `macro` | No hace falta | — | — | recuperable |
| Calendario EE. UU. (actual, forecast) | Eventos con dato real | `eventos`, `reales` | Sí (pasados de EE. UU.) | horario | 3 años | `estado/eventos.json` |
| Calendario 11 países (ForexFactory) | Forecast y previous | `eventos.calendario` | **No** más allá de 14 días | horario | 14 días atrás | `pub/calendario.json` |
| Cripto: opciones de Deribit | Cadena BTC y ETH | `cripto.activo` | **No**: solo la foto derivada | 15 min | — | `pub/cripto.json` |
| Cripto: fotos derivadas | GEX, funding, OI, DVOL... | `cripto.main` | Sí | 1 al día (UTC) | Siempre | `cripto/hist.json` |
| Cripto: on-chain, funding, OKX | Series diarias | `cripto.diario` | Sí | 6-20 h | Siempre (OKX amplía 180 días) | `cripto/diario.json` |
| Cotizaciones cruzadas (social) | Índices, sectores, amplitud, cripto | `social_diario` | Sí | cierre | Siempre | `social/{F}/paquete.json` |

### Salidas (lo que se calcula y se muestra)

| Vista | Qué es | Dónde | ¿Se guarda? | Frecuencia | Retención | Clave |
|---|---|---|---|---|---|---|
| Niveles al cierre (todos los filtros, 2 motores, 2 posiciones) | `_snap` + zero gamma, front, call/put por 1 % | `historial500` | Sí | cierre | 2 años | `hist500/{SYM}/{fecha}` (`levels`) e índice `hist500/_niveles/` |
| Niveles del día (última foto y ex ante, sufijo `a`) | `_snap` | `g.history_update` | Sí | 15 min (sobrescribe) | 3 años (`HISTORY_YEARS`) | tar `history/{SYM}.json` |
| **Niveles intradía** (sufijo `i`) | `[hora, spot, cw, pw, flip, vt]` por foto | `g.history_update` | Sí, pocos días | 15 min | **5 sesiones** (`INTRADIA_SESIONES`) | tar `history/{SYM}.json` |
| Vistas precalculadas (niveles y perfil) | `compute` completo por vista | `fase_vistas` | **No** | 15 min / 1 min | Solo la última | `pub/t/{SYM}/niveles/*` |
| **Mapa TRACE** | `heatmap` (lente Gamma) | `fase_vistas` | **No** | 15 min / 1 min | Solo la última | `pub/t/{SYM}/mapa/*` |
| **Escáner** | Filas por ticker y filtro | `g.scan` | **No** | 15 min | Solo la última | `pub/l/{lid}/escaner_{dte}.json` |
| **Compass** | Mapa de IV y RR por ticker | `g.compass` | **No** | 15 min | Solo la última | `pub/l/{lid}/compass.json` |
| **Validación** | Estadística de muros y rangos | `g.validation` | **No** (es un resultado sobre la historia) | 15 min / cierre | Solo la última | `pub/l/{lid}/validacion_*`, `pub/validacion500/` |
| **Superficie de volatilidad** | `vol.json`: smiles, matriz, término, bandas | `volatilidad.vol_data` | Solo un resumen: IV por plazo fijo (16) y skew por delta fija (6 × 14) | cierre | 3 años (252 × 3 sesiones) | tar `history/ivsurf_{SYM}.json` |
| Volatilidad resumida | IV30, RR25, RV20 | `g._vol_history` | Sí | cierre | 3 años | tar `history/vol_{SYM}.json` |
| **Flujo (serie de la sesión, UOA)** | Prima neta, delta y vega $ acumuladas | `flujo.tick` | **Solo la sesión en curso**: al empezar otra se borra | 15 min | 1 sesión | tar `history/flujo_{SYM}.json.gz` |
| Flujo por contrato al cierre | Volumen y lado | `historial500` | Sí | cierre | **8 sesiones** (`FLOW_DAYS`) | `hist500/_flujo/{SYM}.json.gz` |
| Señales de skew | ATM, put 25Δ, call−put, O/S | `skew.py` | Sí | cierre | Sin poda propia | `hist500/_skew.json.gz` |
| Curva y régimen del VIX, régimen de gamma, correlación, Summary | Estudios sobre series públicas | `macro` | No | 15 min | Solo la última | `pub/vix.json`, `pub/regimen.json`... |
| Report semanal y social | Paquetes, PNG, textos | `report_semanal`, `social_diario` | Sí | semanal / cierre | Siempre | `report/`, `social/` |

### Huecos confirmados

1. **Cadenas intradía**: solo se guarda la del cierre (`hist500/`). La copia del día (`history/chains/`) se
   sobrescribe y no tiene cotizaciones. Tradier no da OI ni IV pasados: lo que no se guarda hoy se pierde.
2. **Velas de 1 min**: Tradier solo da unos 20 días; nada se guarda.
3. **Flujo**: la serie intradía se borra al empezar la sesión siguiente; el detalle por contrato, 8 sesiones. Con la
   cadena del cierre guardada (volumen, último, bid, ask) el lado al cierre se recalcula, pero no el reparto por tramos
   del día: eso solo sale de cadenas intradía.
4. **Superficie de volatilidad**: `ivsurf_` es un resumen. Se recalcula entera con la cadena del cierre de `hist500`,
   así que con guardar las cadenas basta.
5. **Escáner, Compass, Validación, mapa TRACE, vistas**: no se guardan. Son derivados: se rehacen con las cadenas
   intradía y las velas si se archivan. La Validación es un resultado sobre la historia, no una entrada.
6. **Niveles intradía**: 5 sesiones. Para los 6 índices salen de las cadenas intradía; para el resto de las listas,
   barato guardarlos aparte.
7. **Retención de 2 años** en `hist500/` (`RETENCION_ANOS`) y 3 años en el tar (`HISTORY_YEARS`): para modelar,
   mejor no borrar nunca y mover lo viejo a un archivo frío.
8. **Consenso de ForexFactory** (forecast) fuera de EE. UU.: se pierde a los 14 días. Es la base de cualquier
   modelo de sorpresa macro.
9. **Cadena de Deribit**: no se guarda; las historias gratuitas de opciones cripto no existen.

## Opciones de tamaño y escrituras

Cuentas: 252 sesiones al año; ~405 pasadas por sesión en el modo rápido (09:30-16:15), 81 cada 5 min, 27 cada 15 min.
Escrituras: **una por trabajo de Actions agrupando todas las fotos y todos los tickers del trabajo** (R2 no tiene
"append"; un objeto por foto y ticker multiplicaría por 30 las escrituras).

| # | Qué | Cadencia y filtro | GB/año (columnas) | GB/año (JSON gzip actual) | Clase A/mes |
|---|---|---|---|---|---|
| A1 | Cadena intradía de los 6 índices | 1 min, todos los contratos | ~40 | ~143 | ~2.400 (1 por trabajo de 5 min) |
| A2 | ídem | 1 min, ±5 % y ≤ 14 días | ~5,6 | ~20 | ~2.400 |
| A3 | ídem | 5 min, ±10 % y ≤ 60 días | ~3,2 | ~11 | ~2.400 |
| A4 | ídem | 15 min, todos | ~2,7 | ~9,5 | ~900 |
| B | Cadena intradía de los otros tickers de las listas (17) | 15 min, todos | ~2,9 | ~7 | ~900 |
| C | Velas de 1 min (6 índices + listas, 23) | cierre | ~0,03 | ~0,2 | ~22 |
| C' | Velas de 1 min de los 529 | cierre | ~1 | ~4 | ~22 (más ~530 peticiones de Tradier al día) |
| D | Niveles intradía de las listas (todas las combinaciones de `_snap`) | 15 min | ~0,05 | ~0,05 | ~900 (o 22 con resumen diario) |
| E | Flujo de la sesión (`flujo.json` final) y escáner/Compass del cierre | cierre | < 0,01 | < 0,01 | ~22 |
| F | Calendario completo (`pub/calendario.json`) | 1 al día | < 0,01 | < 0,01 | ~30 |
| G | Cadena de Deribit (BTC y ETH) | 1 h (24/7) | ~0,9 (estimado, sin medir) | ~2 | ~30 con resumen diario |
| H | `hist500/` sin borrar nunca (529 tickers) | cierre | ~0,8 | **1,9** | igual que hoy |

Más la parte fija de cada cadena (strike, vencimiento, tipo, OI), una vez al día por ticker: ~0,1 GB/año para los 23.

Conclusión de las cuentas:
- **Escrituras no son el problema** si se agrupa: todo el plan suma unos 4.000-5.000 al mes (0,5 % del tope).
  El tope ya está cerca por lo que existe hoy (~0,94 M), y eso se arregla aparte (ver "Riesgos").
- **El espacio sí**: R2 tiene 10 GB y ya va camino de 4-5 GB (hist500 a 2 años en JSON, ~3,9 GB, más 0,66 GB de
  copias del estado). Ninguna cadena intradía cabe a largo plazo en R2.

## Alternativas valoradas

1. **Un solo objeto por trabajo o por día** (agrupar): imprescindible por las escrituras. Hecho de una de dos formas:
   el trabajo del modo rápido junta sus ~5 pasadas en un objeto; el día se consolida una vez por la noche.
2. **Formato en columnas comprimido**: 2,4 veces menos que el JSON gzip. Para el archivo frío, **Parquet con zstd**
   (pandas, DuckDB y polars lo leen directamente; diccionario en strikes y vencimientos; una fila por contrato y foto).
   Exige `pyarrow` en el workflow de archivo (no en el motor ni en Pyodide). En caliente, npz o JSON en columnas con
   gzip vale y no añade dependencias.
3. **Repo privado de datos con Git LFS**: 10 GiB de espacio y 10 GiB/mes de descarga; si se pasa sin tarjeta,
   se cortan las descargas de LFS de toda la cuenta. Cabe A3 + H unos 2 años. Peor que Releases.
4. **Releases de un repo privado** (`LoppVicious/gexlab-datos`): un release por mes con un Parquet por tipo de dato
   (`cadenas_6idx_2026-12.parquet`, `hist500_2026-12.parquet`...). Sin límite total ni de descarga según la
   documentación, 2 GiB por archivo (un mes de A1 completo serían ~3,3 GB: se parte por índice). El workflow del repo
   público sube con un token de grano fino solo con `contents:write` en ese repo (secreto `DATOS_TOKEN`); los
   registros solo escriben nombres y tamaños. **Recomendado como archivo frío.** Riesgo: las condiciones de GitHub
   piden no usarlo como almacén masivo; con unos GB al año es razonable, pero conviene una copia de seguridad.
5. **D1**: 500 MB por base y 100.000 filas al día. Útil solo para tablas compactas consultables desde el Worker
   (niveles intradía D: ~9.000 filas al día, ~330 MB/año). No para cadenas. Opcional.
6. **Artefactos de Actions**: descartado (90 días y públicos en un repo público).
7. **Copia en el PC del usuario** (`D:`): gratis y sin límite; un script descarga cada mes los Parquet del release.
   Recomendado como segunda copia del archivo frío.

## Diseño propuesto

```
modo rápido / ciclo / historial500  ──(1 objeto por trabajo, columnas+gzip)──►  R2 arch/  (caliente, 45 días)
                                                                                     │
archivo.yml (cada noche y el día 1 de cada mes) ── consolida a Parquet+zstd ──►  Release AAAA-MM del repo privado
                                                   comprueba sha256, luego borra de R2 lo de más de 45 días
PC del usuario ── descarga mensual ──► D:\GexLab-datos\  (segunda copia)
```

- **R2 `arch/` (nuevo prefijo, fuera de `pub/` y de `hist500/`):**
  - `arch/rt/{fecha}/{HHMM}.npz.gz` o `.json.gz`: fotos del trabajo de 5 min del modo rápido, los 6 índices, parte
    que cambia en columnas. Una escritura por trabajo.
  - `arch/rt/{fecha}/fija_{SYM}.json.gz`: parte fija del día (strike, tipo, vencimiento, OI, forward por
    vencimiento) en la primera pasada; se reescribe solo si aparecen contratos nuevos.
  - `arch/ciclo/{fecha}/{HHMM}.json.gz`: por ciclo, los `_snap` de todas las combinaciones de las listas (D) y, si se
    elige, la cadena de los 17 tickers (B).
  - `arch/dia/{fecha}.json.gz`: velas de 1 min (C), `flujo.json` final, escáner y Compass del cierre (E),
    calendario (F), resumen de Deribit (G). Lo escribe `historial500.py` al terminar (1-3 escrituras).
- **`archivo.yml`** (nuevo, repo público, sin datos en el repo): lee `arch/` y `hist500/` del mes, escribe Parquet,
  sube al release, comprueba el sha256 de lo subido descargándolo y solo entonces borra de R2. Idempotente: si el
  asset existe con el mismo sha256, no hace nada. Las lecturas son de clase B (decenas de miles al mes frente a 10 M).
- **Lectura para modelar:** `pruebas/` o un cuaderno local con DuckDB sobre los Parquet del PC; el motor no lee el
  archivo frío. Lo caliente (45 días) sigue disponible para la web si algún día se quiere repetir un mapa intradía.
- **Esquema Parquet de cadenas:** `ts` (UTC), `sym`, `exp`, `k`, `cp`, `bid`, `ask`, `last`, `vol`, `iv_prov`, y en
  la tabla fija del día `oi`, `fwd`, `spot`, `fuente` (`tradier`/`cboe`), `motor_v` (hash del commit de
  `gex_engine.py`), para saber con qué versión se vio cada dato.

## Plan priorizado (por valor para modelos)

1. **Cadenas intradía de los 6 índices (A3, luego A2).** Lo más valioso e irrecuperable: dinámica intradía de gamma,
   0DTE, flujo por tramos, deriva de muros. Empezar con A3 (5 min, ±10 %, ≤ 60 días: ~3,2 GB/año, ~13 MB/día) en
   el primer paso de cada trabajo; añadir A2 (1 min, ±5 %, ≤ 14 días, ~5,6 GB/año) cuando el archivo frío funcione.
   No cabe en R2 más de ~45 días: necesita el paso 3.
2. **Velas de 1 min (C) y niveles intradía de las listas (D).** Baratísimo; las velas son la variable objetivo de casi
   cualquier modelo intradía y caducan a los 20 días en Tradier. Ampliar a C' (los 529) solo si el cupo de Tradier del
   historial diario lo permite.
3. **Archivo frío en Releases privados + copia en el PC**, y con él **quitar la poda de 2 años de `hist500/`**
   (H): lo de más de N meses vive en Parquet en el release y deja de ocupar R2. Mover también al Parquet mensual las
   cadenas del cierre en formato columnas (2,4 veces menos).
4. **Calendario completo (F) y flujo de la sesión, escáner y Compass del cierre (E).** Casi gratis; F da la serie de
   sorpresas macro (actual − forecast) de 11 países.
5. **Cadena de Deribit cada hora (G).** Medir antes el tamaño real; irrecuperable pero de uso secundario.
6. **Cadenas intradía de los otros tickers de las listas (B)**, si tras un mes de A3 el espacio y el tiempo del
   ciclo lo permiten.
7. No se archiva: mapas TRACE, vistas precalculadas, Validación, superficie de volatilidad completa, curvas y
   regímenes macro (se rehacen con las entradas o con series públicas).

## Riesgos y comprobaciones previas

- **Escrituras de clase A ya cerca del tope** (~0,94 M estimadas con 529 tickers). Antes de nada, ver la cifra real en
  Cloudflare. Ahorro fácil: en `historial500.py`, juntar `_niveles/{SYM}` y `_flujo/{SYM}` de los 529 en uno o pocos
  objetos (−1.000 escrituras al día, ~22.000 al mes).
- **Copias del estado**: 14 × 47 MB = 0,66 GB en R2. Bajar a 7 o sacar `history/chains/` del tar (lo cubre el archivo)
  libera espacio.
- **Duración de las pasadas del modo rápido**: serializar y subir la foto no debe alargar la pasada por encima de 60 s;
  hacerlo en el hilo de subidas (`motor.subir`) y solo en la primera pasada para A3.
- **Repo público**: nada del archivo pasa por el repo ni por los registros de Actions; el token del repo privado solo
  en GitHub Secrets.
- **Condiciones de GitHub** sobre Releases como almacén: mantener la copia en el PC; alternativa si hiciera falta,
  Backblaze B2 (10 GB gratis, compatible S3, se usaría con el mismo `almacen.R2` cambiando el endpoint).
- **Cifras sin medir**: compresión por diferencias entre fotos, tamaño de la cadena de Deribit, escrituras reales del
  mes. Medirlas en la primera semana con `pruebas/` antes de fijar la cadencia A2.
