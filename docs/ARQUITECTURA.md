# GEX Lab: referencia técnica

Detalle que no cabe en CLAUDE.md. Léelo solo para la parte que toques.

## Arquitectura
```
GitHub Actions (motor.yml, repo público = minutos ilimitados)
  motor.py ciclo -> descarga Tradier (tiempo real; CBOE de respaldo), calcula, publica en R2 (Cloudflare)
Cloudflare Worker "dashboard" (nube/worker.js) + assets estáticos (web/)
  - auth (PBKDF2 en el cliente, sesión única por cuenta), prefs y listas en D1
  - cron */5: toca() lanza motor.yml modo ciclo cada 15 min (días laborables 07:45-17:15 ET, 18:00, 20:00, sáb 10:00);
    tocaRapido() lanza modo rapido cada 5 min de 07:05 a 16:15 ET (de 07:05 a 09:30, el tramo previo a la apertura).
  - **Tiempo real** (`motor.py rapido`, `TIEMPO_REAL` = SPX NDX RUT SPY QQQ IWM): cadena y velas de 1 min de Tradier
    (`fuente_tradier.velas`, solo cerradas y hasta el cierre, formato de CBOE intraday; `VELAS_TRADIER`). Tradier no
    da velas de NDX ni RUT, ni su precio al día (cotización sin `trade_date`): el spot sale de la paridad put-call del
    vencimiento más cercano (`gex_engine._spot_paridad`, con `spot_paridad` en la cadena), tras el cierre el oficial
    de la vela diaria (NDX), el cierre anterior de RUT del CSV de CBOE, y las velas son las de QQQ e IWM escaladas
    (`fuente_tradier.velas_indice`, `VELAS_ETF`: cociente de cierres de cada día y, hoy, spot entre la última vela del
    ETF). Paquete y vistas; lee el estado pero no lo guarda
    (historial de niveles y flujo, en el ciclo de 15 min, que vuelve a descargar esos 6: el cupo de Tradier alcanza).
    Escribe `pub/rapido.json`. Sale sin hacer nada fuera de 07:00-cierre + 15 min (festivos, cierre a las 13:00).
    Resto de tickers: velas de CBOE. La web (Auto) recarga cada minuto esos 6 y cada 5 el resto.
    - **Una pasada por minuto** de 09:30 a 16:15 ET (`TRAS_CIERRE_MIN`): cada trabajo de 5 min hace una al empezar
      y otra a los `PASADA_SEG` s de cada minuto hasta la del final de su tramo; el siguiente espera en la cola
      (`concurrency` de `motor.yml`) y arranca al terminar este. Cada pasada vuelve a leer el estado. Antes de la
      apertura, una sola pasada por trabajo. `vol.json` solo en la primera pasada de cada trabajo.
    - **Cupo de Tradier** (medido con `pruebas/tradier_cupo.py`): la cadena completa de los 6 son 233 peticiones
      (57 SPX, 44 NDX, 32 RUT, 35 SPY, 32 QQQ, 33 IWM, con cotización, vencimientos y velas). `fuente_tradier`
      reutiliza los vencimientos de más de `CERCA_DIAS` (14) durante `LEJOS_S` (290 s): las demás pasadas son
      70 peticiones. ~583 por trabajo de 5 min (~117/min). El límite publicado es 120/min; en la prueba del
      2026-11-15 Tradier no lo aplicaba (699 en 24 s sin 429). Al día, ~82.000 peticiones con el ciclo.
    - **Escrituras en R2** (tope gratis: 1 M/mes de clase A): ~61 por pasada con 4 vistas; con el ciclo, ~0,87 M
      al mes. Por eso el tramo previo a la apertura sigue cada 5 min.
  - **Tramo previo a la apertura del TRACE** (`gex_engine.PRE_PROXY`, desde `PRE_OPEN` = 07:00): el mapa de SPX, NDX,
    RUT y sus ETF empieza a las 07:00. `fuente_tradier.velas_pre` añade a `fx/intraday_SYM.json` las velas de 1 min del
    ETF (Tradier, `session_filter=all`) escaladas al índice (`pre_src` = ETF). Ratio: índice / ETF al cierre de la vela
    de 09:35-09:40 (la primera vela del índice lleva precios de ayer); antes, el de los cierres anteriores (RUT no tiene
    `prevclose` en Tradier: última vela anterior o `last` antes de abrir). Antes de las 09:30 el `spot` del paquete es
    el cierre de la última vela escalada. La gamma no consume varianza fuera de horas de mercado: en ese tramo el mapa
    cambia solo con el precio (el open interest es el del cierre anterior). Prueba: `pruebas/premarket_mapa.py`.
  - **Calendario económico** (`eventos.py`, `reales.py`): ForexFactory da la semana en curso de 11 países con
    importancia, forecast y previous (sin dato real; como mucho una petición por hora, en el ciclo); Fed, BEA, Census y
    FRED, las fechas de EE. UU. a meses vista. El dato real solo es de EE. UU.: BLS (CPI, nóminas, paro, salario, PPI,
    JOLTS) al minuto y FRED (ventas minoristas, PCE, peticiones de desempleo, PIB de avance, bienes duraderos,
    vivienda) con 3 min a 2 h de retraso; vale solo si la última observación es del periodo esperado.
    Alarma: Durable Object `RelojCalendario` (binding `RELOJ`, SQLite). El cron */5 le pasa `pub/eventos_horas.json`
    (eventos de EE. UU. de importancia 2+ de hoy y mañana con fuente de dato real y sin él: hora + 1, 6, 16, 31, 61 y
    121 min) y la alarma lanza `motor.yml` con `modo=calendario` (`motor.py calendario`: solo el dato real sobre el
    estado guardado; sin tickers ni ForexFactory; no escribe nada si no hay estado).
  - /api/pub/* sirve R2; /api/pedir lanza un ciclo para tickers nuevos
Navegador
  - web/nube.js intercepta fetch: usa las vistas precalculadas de R2 o calcula en el navegador
    con Pyodide (web/motor-web.js) ejecutando el MISMO gex_engine.py sobre el "paquete" del ticker
```
Modo PC (sin nube): `server.py` sirve la misma web y la misma API en local.

**Trading Window** (`web/trading.js`, `web/trading.css`): el mapa TRACE (`state.heat`) y los niveles (`state.data`)
sobre Lightweight Charts 5.2.1 (jsDelivr, se carga al abrirla). El mapa es una capa propia de la libreria debajo de las
velas; las horas de Nueva York van como UTC. La app llama a `twSync` al recibir el mapa o los datos y al cambiar de
tema. Precio en vivo: `/api/precio?symbol=` (Worker; en el PC, `server.py` si hay `TRADIER_TOKEN`) pide la
cotizacion a Tradier y la comparte 5 s en memoria; la ventana la consulta cada 5 s solo con la sesion abierta y
mueve la vela en curso. Secreto del Worker `TRADIER_TOKEN` (lo sube `desplegar.sh` desde GitHub Secrets); sin el,
404 y la ventana se queda con las velas del motor. Datos del calculo que usa: `levels_intraday` (filas
`[hora, spot, cw, pw, flip, vt]` de la sesion, clave `fecha|filtro|i` del historico, una por foto con el mercado
abierto; se guardan `INTRADIA_SESIONES`), `prev_day` (OHLC de la sesion anterior, `prev_day_ohlc`; None en NDX y RUT),
`profile.d`/`d_next` (cobertura de los dealers si el precio se mueve, igual que `scenarios.flow`), `/api/flow` y
`/api/eventos`. Todas las series se colocan en la rejilla de velas (`twSnap`): el mapa se situa por indice logico.

Herramientas de opciones (Open Interest, `web/oi.js`, y Options Lab, `web/lab.js`) calculan en JavaScript, sin Pyodide:
`/api/chain?symbol=` devuelve la cadena compacta (`chain_to_min`, con `fwds`), el OI de la sesión anterior por
contrato (`oi_previo`) y el tipo de interés. En el PC la arma `gex_engine.chain_payload`; en la nube, `nube.js` con
los archivos del paquete del ticker (`fx/SYM.min.json`, `fx/oiprev_SYM.json`, `fx/rate.json`). `web/opciones.js`
tiene lo común (Black-Scholes-Merton con griegas, lectura de la cadena, gráfico de P&L); el subyacente es el que
implican las opciones (forward del vencimiento más cercano) y el tiempo se cuenta desde `quote_time`, como en el motor.
El motor calcula siempre el VIX (`motor.SIEMPRE`), esté o no en las listas de los usuarios.

**Pasada post-cierre (`motor.fase_cierre`):** los tickers del historial diario (`config/historial500.json`) que no
están en ninguna lista se calculan una vez por sesión, a partir de las 16:20 ET (cierre + 20 min), dentro de los ciclos
de 15 min y con el mismo `_ticker` que las listas: historial de niveles, flujo, copia de la cadena (la del cierre:
`save_chain_snapshot` guarda tras el cierre si la sesión aún no tiene copia), punto de volatilidad (`ivsurf_`),
paquete y `vol.json`. Va por turnos hasta `CIERRE_PRESUPUESTO_S` del ciclo; los hechos se marcan en
`history/_cierre.json`. Así el Volatility dashboard (cambio diario de la matriz, sesión anterior, percentiles 10-90),
el Histórico y el flujo acumulan historia para toda la lista, y la web abre esos tickers al instante con el último
cierre (y lo renueva en segundo plano en sesión). El cálculo puntual (`motor.py ticker`, al abrir un ticker sin
paquete) no guarda estado: solo el ciclo lo escribe, en cola.


## R2
- `estado/estado.tar.gz`: carpetas `history/` y `cache/` (copias diarias en `estado/copias/`, se guardan 14).
- `pub/t/SYM/{paquete,vol}.json`, `pub/t/SYM/niveles/*`, `pub/t/SYM/mapa/*`: vistas precalculadas.
- `pub/l/{lid}/escaner_{dte}.json`, `compass.json`, `validacion_{dte}_{mode}_{model}.json`.
- `config/config.json`: listas y vistas que escribe el Worker.
- `estado/eventos.json`: estado del calendario, fuera del tar (lo escriben el ciclo y el modo calendario; manda sobre
  `cache/eventos.json` del tar). Al cambiar `eventos.VERSION` se conservan los eventos pasados de EE. UU. que usa la
  Validación. Publica `pub/eventos.json` (EE. UU.: Summary y estructura de volatilidad), `pub/calendario.json`
  (11 países, de 14 días atrás a 28 adelante: página Calendar) y `pub/eventos_horas.json` (avisos de la alarma).
- Secretos del calendario: `FRED_API_KEY` y `BLS_API_KEY` (500 consultas al día; sin ella, 25). Pruebas en Actions:
  `pruebas/prueba_fred.py` (retraso de cada serie) y `pruebas/prueba_bls.py`; sin red: `pruebas/test_eventos.py`,
  `pruebas/test_reales.py`.
- `hist500/{SYM}/{fecha}.json.gz`: historial diario para backtests, fuera del estado. Lo lanza el Worker a las 16:30 ET
  (cron de GitHub de respaldo); `hist500/_dias/{fecha}.json` marca la sesión hecha. Se conservan 2 años.
  - `chain`: cadena compacta (`chain_to_min`, contratos con OI o volumen); se recalcula con `parse_chain({"_min": chain})`.
  - `levels[posición][motor][filtro]`: los mismos campos que el histórico (`_snap`), rango 5 %, estándar y flujo, calculados
    tras el cierre. Todos los filtros de la barra; el 0DTE solo con vencimientos diarios (≥4 en 7 días).
  - `hist500/_niveles/{SYM}.json.gz`: índice `{fecha: levels}` con los campos que usa la Validación (`CAMPOS_INDICE`),
    flip y probabilidades implícitas de cierre (`pc_*`; al reconstruirlo, `g.completar_probs` las calcula con la cadena
    guardada para los días anteriores al 2026-11-21).
    Se actualiza con cada sesión y se reconstruye con todos los días si falta (`historial500.py --indice`, o el
    workflow con `indice`). `motor.fase_listas` lo lee para los tickers de las listas y `g.validation(extra=...)` lo
    usa para las sesiones que falten en `history/{SYM}.json` (foto tras el cierre, como la clave `fecha|filtro`).
  - `pub/validacion500/{filtro}_{posición}.json`: Validación de toda la lista (motor Perfil) con el índice de niveles
    (`historial500.publicar_validacion`), tras guardar cada sesión, con `--indice` o solo con `--validacion` (input
    `validacion` del workflow). Guarda `sesion` y `vela` (si CBOE ya tenía la vela diaria de esa sesión); sin ella,
    el cron de la noche la rehace (`validacion_pendiente`). La web la pide con `/api/validation?scope=all` y `nube.js` la lee por `/api/pub/`.
    Sin fotos ex ante: el histórico del motor no se carga en este workflow.
  - `hist500/_flujo/{SYM}.json.gz`: volumen y lado por contrato de las últimas 8 sesiones (modo flujo).
  - `hist500/_skew.json.gz`: `{fecha: {SYM: [IV ATM, IV put 25Δ, cierre, IV call − IV put, contratos, acciones]}}`
    (`skew.fila`: IV del mensual más cercano a 30 días con `skew.punto`, volúmenes del día; None donde no se puede
    medir); lo escribe `historial500.py` con cada sesión (volumen de la acción, de `data.volume` de la cadena) y
    `--indice` lo reconstruye (volumen de días pasados, del histórico diario de CBOE). De él sale `pub/skew.json`.
    La reconstrucción añade además `PREHIST` (45) sesiones previas al primer día guardado solo con el cierre de CBOE,
    para la volatilidad realizada de Vol premium; las demás señales las ignoran.
  - `hist500/_mov.json.gz`: movimiento esperado de cada acción (`movimiento.py`; ver Movimiento esperado). De él
    sale `pub/movimiento.json`.
  - `hist500/_pcr.json.gz`: `{fecha: {SYM: {t0|t1|t2|all: [vol call, vol put, OI call, OI put] o None}}}`, sumas
    × |delta| de contratos fuera de dinero (`pcr.sumas`); `hist500/_pcr_exp.json.gz`: P/C por vencimiento del último
    día (`pcr.por_vencimiento`). Los escribe `historial500.py` con cada sesión y `--indice` los reconstruye con las
    cadenas guardadas. De ellos sale `pub/pcr.json`.
  - VIX siempre (`SIEMPRE`), aunque no esté en la lista de la web, y sin límite de años (`NUNCA_BORRAR`).
  - `hist500/_indices_vol/{fecha}.json`: OHLC de VIX, VIX9D, VIX3M, VIX6M y VIX1Y y curva de futuros del VIX;
    `_indices_vol/historico.json.gz`: su serie diaria completa de CBOE (VIX desde 1990). No se borran nunca.
  - Lista de tickers: la edita el administrador en la web (`/admin` ▸ Configuración, `/api/admin/historial`) y se guarda
    en R2 `config/historial500.json` (máx. 200; los nuevos deben estar en `pub/simbolos.json`). Si no existe, `TICKERS` del script.
    Prueba local: `GEX_ALMACEN=local:./data/x python historial500.py --forzar AAPL`.

**Panel de administración (`/admin`, solo admin):** `web/admin.html|js|css`. Estado (`/api/admin/estado`: `pub/motor.json`,
último `hist500/_dias/`, `estado/uso.json` que escribe `historial500.py` con `almacen.uso`, y ejecuciones de GitHub con
`GH_DISPATCH_TOKEN`), usuarios, listas editables (historial diario y tickers fijos del motor en `config/fijos.json`, que
`motor.leer_config` suma al universo), lanzar ciclo o historial (`/api/admin/lanzar`) y el CHANGELOG (se copia a `dist/`).

**Founder Takes (Research ▸ Takes):** entradas del admin con texto Markdown, etiquetas y adjuntos (enlace, cita, PDF,
imagen). Solo en la nube (en el PC, `/api/takes` responde que no está). Código: `nube/takes.js` (validación y rutas;
lo importa `worker.js` y wrangler lo empaqueta), `web/takes.js` (página: listado, detalle y editor),
`web/takes-md.js` (Markdown mínimo que escapa todo el HTML; solo enlaces http/https) y `web/takes.css`.
- D1: `takes` (estado `borrador` o `publicado`; `publicado` es la fecha de la primera publicación), `takes_adjuntos`
  (por orden) y `takes_autores` (usuarios que pueden escribir borradores; el admin los marca en `/admin`).
- R2: `takes/<take_id>/<24 hex>.<ext>`, solo PDF, PNG, JPEG y WebP, comprobados por los primeros bytes y la extensión
  (SVG no); 20 MB por archivo, 8 por Take. Se sirven por `/api/takes/archivo/<take_id>/<archivo>` solo si el Take es
  visible para quien lo pide.
- Rutas: `GET /api/takes` (lista sin cuerpo, con extracto), `GET /api/takes/:id`, `POST /api/takes` y
  `PUT /api/takes/:id` (multipart: campo `datos` en JSON y `archivoN`; al editar, los adjuntos existentes se conservan
  por `id` y los quitados se borran de R2), `POST /api/takes/:id/estado` y `DELETE /api/takes/:id` (solo admin).
- Permisos: todos leen lo publicado; el autor ve y edita sus borradores (no los publica); el admin, todo. Las
  escrituras (POST, PUT, DELETE) exigen el mismo origen.
- Pruebas sin red: `node --test pruebas/test_takes.mjs pruebas/test_takes_api.mjs` (la segunda ejecuta las rutas con el
  esquema real sobre `node:sqlite` y R2 imitado).

**Report semanal (borrador de Take):** `/report-semanal` en Claude Code (`.claude/skills/report-semanal/`) lanza
`report.yml`, que ejecuta `report_semanal.py` (lectura y paquete), `report_calc.py` (cálculos y umbrales de
destacado) y `report_graficos.py` (PNG, paleta Daylight). Lee `hist500/` (niveles, cadenas al cierre, familia VIX),
FRED (`SP500`, `NASDAQ100`) y las webs de ProShares y Direxion (AUM de ETFs apalancados).
- R2: `report/{F}/paquete.json`, `report/{F}/g/{nombre}.png` y `report/ultimo.json` (`{"fecha": F}`). No se borran.
- Worker (`nube/report.js`): `GET /api/report/ultimo`, `GET /api/report/{F}`, `GET /api/report/{F}/g/{nombre}.png`
  y `POST /api/report/{F}/take` (crea un borrador de la cuenta `claude` con los PNG elegidos, con
  `validarTake`/`escribirTake` de `nube/takes.js`). Solo con `Authorization: Bearer <REPORT_TOKEN>`; sin el secreto,
  404. Secreto de GitHub `REPORT_TOKEN` (lo pone `desplegar.sh` en el Worker) y, en el PC, `GEXLAB_REPORT_TOKEN`.
- Pruebas: `python pruebas/test_report.py` (sin red; los gráficos solo si hay matplotlib) y
  `node --test pruebas/test_report_api.mjs`. Spec y plan en `docs/superpowers/`.

**Nota diaria de flujos (borrador de Take):** `flujos.yml` (al acabar el historial diario) ejecuta
`flujos_diario.py` (lectura, paquete y serie), `flujos_calc.py` (cálculos y supuestos) y `flujos_graficos.py`
(PNG, misma paleta que el report). Cadenas al cierre de `hist500/` para SPY, QQQ e IWM (recalculadas con el reloj
del motor en el cierre) y de Tradier en directo para SPX, NDX y RUT. Diseño completo en `docs/FLUJOS.md`.
- R2: `flujos/{F}/paquete.json`, `flujos/{F}/g/{nombre}.png`, `flujos/ultimo.json`, `flujos/{F}/tesis.json` (la
  escribe el Worker) y `flujos/_serie.json.gz` (una fila por sesión: AUM de ETFs apalancados, cifras, versión del
  modelo y tesis). No se borran.
- Worker: las mismas rutas que el report con `/api/flujos/` (`nube/report.js`, mismo token); `POST .../take`
  acepta además `tesis` (objeto JSON, 4 KB como mucho).
- `/take-flujos` en Claude Code (`.claude/skills/take-flujos/`) escribe el texto; una tarea programada del PC lo
  lanza los días laborables.
- Pruebas: `python pruebas/test_flujos.py` y `node --test pruebas/test_report_api.mjs`.

**Social diario (posts para X, solo admin):** página Research > Social (`web/social.js|css`, modo `social` de
`TOOLS`; el botón y el modo solo existen con `ME.admin` en la nube). Cada cierre, la conclusión del día y el playbook
de la sesión siguiente. `social.yml` ejecuta `social_diario.py` en dos pasadas:
- **Cierre** (16:20 ET, cron del Worker `tocaSocial`): SPX, NDX y RUT con la cadena de Tradier al cierre (CBOE de respaldo) (motor Perfil,
  todos los vencimientos, posición estándar; no están en `hist500`), familia VIX de `fetch_quote` y su serie
  histórica (CSV de CBOE), mercados cruzados (`MERCADOS`, `SECTORES`, `AMPLITUD`: una petición a Tradier con
  `fuente_tradier.cotizaciones`; sin
  token, `fetch_quote` símbolo a símbolo; el 10 años, TNX, siempre del CSV de CBOE porque Tradier no lo tiene), bitcoin y ether al contado (CoinGecko, sin clave) y eventos de la sesión siguiente
  (`pub/eventos.json`). Movimiento implícito de hoy: el del paquete anterior o, el primer día, `m1_pct` de SPY, QQQ e
  IWM en `hist500/_niveles/`. R2 `social/{F}/paquete.json` y `social/ultimo.json`.
- **Acciones** (al acabar el historial diario, `workflow_run` de "Historial diario" si acabó bien y
  `hist500/_dias/{F}.json` existe): añade al paquete el bloque de acciones con `hist500/_skew.json.gz` (movimiento en
  sigmas con la IV de ayer, salto de IV, volumen de opciones frente a su media de 20 sesiones, valores al alza y a la
  baja) y los niveles de las citadas. No recalcula los índices: CBOE deja de publicar las cadenas hacia las 17:15 ET.
  `forzar` lo rehace todo, así que solo funciona entre las 16:20 y las 17:15 ET.
Cada bloque trae `motivos` y `destacado`. Gráficos en `social_graficos.py` (1600 x 900, paleta Bento oscura):
`indices_niveles`, `perfil_{sym}`, `playbook`, `mercados`, `vix_curva` y `acciones_sigma`. Los textos los escribe
`/x-diario` en Claude Code (`.claude/skills/x-diario/`, con su guía de estilo).
- R2: además, `social/{F}/g/{nombre}.png` y `social/{F}/textos.json` (`{piezas: [{id, titulo, texto, hilo: [{texto, graficos, alt}],
  graficos, alt, publicado}]}`). No se borran.
- Worker (`nube/social.js`): `GET /api/social/dias`, `GET /api/social/{F}` (`{paquete, textos}`),
  `GET /api/social/{F}/g/{nombre}.png`, `PUT /api/social/{F}/textos` (máx. 12 piezas, hilos de hasta 4 respuestas,
  280 caracteres por post, 4 imágenes; conserva la marca de publicado por `id`) y `POST /api/social/{F}/publicado`.
  Con sesión de admin o con `Authorization: Bearer <REPORT_TOKEN>` (el skill); si no, 403/404.
- Pruebas: `python pruebas/test_social.py` (sin red; los gráficos solo si hay matplotlib),
  `node --test pruebas/test_social_api.mjs` y, con red, `pruebas/tradier_mercados.py` en `prueba_tradier.yml`.

**Crypto (BTC y ETH, `docs/CRIPTO.md`):** `cripto.yml` cada 15 min, todos los días (cron del Worker `tocaCripto`, a
los 5 min de cada cuarto), ejecuta `cripto.py`: Deribit (opciones, futuros, DVOL, velas), OKX (funding, OI, long/short),
CoinGecko, CoinMetrics Community (desde 2012), bitcoin-data.com (STH y LTH realized price, SOPR y STH-SOPR: 4 de las
15 peticiones al día; se renueva cada 20 h y espera 2 h tras un fallo), DefiLlama y alternative.me (Fear & Greed desde
2018). Sin claves. Bybit y Binance bloquean las IP de Actions.
- R2: `pub/cripto.json` (la web, `/api/crypto`), `cripto/diario.json` (fuentes diarias, renovadas cada 6 h; `DIARIO_V`
  fuerza a renovarlas si cambia su forma) y `cripto/hist.json` (una foto diaria de los derivados, no se borra).
- Además, en `cripto/diario.json`: funding diario del perpetuo de Deribit desde 2019 (`fund_{A}`, se amplía por tramos
  de 31 días; la primera vez, unas 90 peticiones por activo), OI y long/short de OKX (`okx_{A}`: la API da 180 días y se
  guardan y amplían) y actividad de otras redes de CoinMetrics (`red_{RED}`, cada 12 h).
- `pub/cripto_series.json` (historias largas en columnas, `cripto_calc.series_largas`; la web lo pide al abrir Crypto)
  y `pub/cripto_red/{RED}.json` (direcciones y transacciones de cada red, al elegirla). Se escriben solo cuando cambian
  los datos diarios. Rutas: `/api/crypto_series` y `/api/crypto_net?net=` (`nube.js` y `server.py`).
- Señales con su historia y backtest (`cripto_calc.senales`), mineros, SOPR, actividad y stablecoins: `docs/CRIPTO.md`.
- **Mapa de liquidaciones:** `/api/liq` (Worker, intermediario de Coinalyze con el secreto `COINALYZE_API_KEY`, que
  `desplegar.sh` sube al Worker; sin él, 404) y `pub/liq_mercados.json` (lista de activos, `cripto.py` una vez al día,
  también con la clave en `cripto.yml`). Modelo en el navegador (`web/liq-modelo.js`), vista `web/liq.js` sobre
  Lightweight Charts; en el PC, `liq_local.py`. Detalle en `docs/CRIPTO.md`.
- GEX con la metodología del motor Perfil en `cripto_calc.py`, no con `gex_engine.compute` (atado al horario de NYSE).
- Pruebas: `python pruebas/test_cripto.py` (sin red); con red, `pruebas/cripto_fuentes.py` y `pruebas/cripto_actions.py`
  (todo `cripto.py` con almacén local) en `comparar.yml`.

**Claves de vista:** `{dte}_{range}_{pos}_{combo}` + `_gb` si el motor es gexbot + `_{sess}` en el mapa.
El motor solo precalcula la lente Gamma del mapa. Las lentes `delta` y `charm` (`heatmap(lens=...)`, clave con
`_delta`/`_charm` en `nube.js`) no están en R2: el navegador las calcula con el paquete y las guarda en memoria hasta
que cambia el paquete (`generado`). Para ir rápido, la delta exacta (N(d1)) solo se evalúa en los contratos casi
vencidos; en el resto sale integrando su gamma en el eje de precios (Delta) o por derivada en W y T (Charm).
El rango canónico es `auto` o un número sin ceros sobrantes. El motor borra las vistas que ya no calcula.


## Los dos motores de cálculo (Ajustes ▸ Motor)
En pantalla se llaman **Neto** (id interno `gexbot`) y **Perfil** (id `spotgamma`); los ids no cambian (claves `_gb`,
archivos). Por defecto **Auto** (`state.model = "auto"`, `effModel()` en app.js): Neto en 0DTE y Perfil en el resto; el Worker
aplica la misma regla a las vistas. Escáner, Compass y Validación usan siempre Perfil.

Común a los dos:
- GEX = signo · Γ · posición · 100 · S² · 1 %.
- Tipo libre de riesgo: letra a 13 semanas (IRX de CBOE, último cierre del CSV de `daily_prices`).
- Posición de los dealers: estándar (largos de calls, cortos de puts) o "flujo" (OI + 0,5 · volumen del día clasificado por bid/ask).

**gexbot**
- IV de la opción fuera de dinero del strike; la varianza solo se consume en horas de mercado; sin dividendo.
- Call Wall: mayor GEX neta positiva en el precio o por encima, dentro del rango elegido.
- Put Wall: la más negativa en el precio o por debajo.
- Flip: frontera de signo de las barras por strike.

**SpotGamma**
- IV de cada contrato; tiempo natural con mínimo de 1 h.
- Dividendo implícito por paridad put-call (mediana de 7 a 180 días), solo en índices europeos; 0 en ETFs y acciones.
- Call Wall: mayor GEX de calls por encima del precio; Put Wall: mayor GEX de puts por debajo. Se buscan en un
  rango fijo por activo, sea cual sea el rango visible (`wall_window_pct`): índices y sus ETF ±10 %, acciones ±20 %,
  VIX ±100 %.
- Put Wall: mayor GEX de puts por debajo.
- Flip: cruce por cero de la GEX total recalculada en ±15 %, el más cercano al spot.

Los dos:
- **Filtro de vencimientos** (barra deslizante, acumulado; `gex_engine.DTE_FILTERS` y `expiry_filter`): 0DTE = primer
  vencimiento vivo; 1DTE = ese y los de la sesión siguiente; 7, 14, 30 y 45 = hasta N días naturales; Todos.
- **IV, delta y forward** (`parse_chain` → `_iv_forward`, para Tradier y CBOE): forward de cada vencimiento por
  paridad put-call (`implied_forwards`; sin pares, S·e^(rT)), IV por Black-76 sobre ese forward con el punto medio
  bid/ask (respaldo: la del proveedor) y delta forward con esa IV. La IV "fuera de dinero" de cada strike se elige
  respecto al forward. Así put y call cuadran en el dinero aunque el spot esté parado (antes de la apertura) o haya
  dividendos. El forward viaja en el paquete (`fwds`, uno por vencimiento) y en las copias de la cadena (`F`).
  La gamma de los dos motores sigue calculándose sobre el spot.
- **Raíces** (`standard_roots`): solo la del símbolo y las series de `SERIES_ROOTS` (SPXW, NDXP, RUTW, VIXW). Las
  ajustadas (HON2, BABA2...) y productos raros (B1SPY, SPXO) se descartan en `parse_chain`, para Tradier y CBOE.
- **VIX** (`FUTURES_OPTIONS`): sus opciones van sobre el futuro de cada vencimiento, que es su forward implícito;
  gamma, perfil, mapa y panel de volatilidad usan ese futuro (q = r).
- **Vol Trigger:** strike más alto por debajo del flip con GEX neta ≤ −25 % del máximo.
- **Rango Auto:** 1σ implícita. En 0DTE, de lo que queda de sesión; con el resto de filtros, de una sesión completa. Mínimo 0,4 %, máximo 10 %.
- **Validación** (`validation`): un muro aguanta si el cierre queda dentro (la mecha no cuenta), frente a una
  referencia (`_base_prob`: fracción de las 500 sesiones previas del ticker cuyo movimiento de cierre a cierre, en
  unidades de su volatilidad realizada de 20 sesiones, no pasó de la distancia del muro), rango frente a la media de sus 20 rangos previos, y pruebas agrupadas por día (`_clustered_test`, mínimo
  `VAL_MIN_DAYS`). Días con evento: vencimiento mensual y FOMC, IPC y empleo de EE. UU. del calendario (`cache/eventos.json`, 3 años).
- **Flujo** (`flujo.tick`, `pub/t/{SYM}/flujo.json`, `/api/flow`, `web/flujo.js`): estado por ticker en
  `history/flujo_{SYM}.json.gz` (volumen e IV de la última foto, serie de la sesión y volumen firmado por contrato).
  Lo llama `motor._ticker`; solo guarda el ciclo (`save`), el modo rápido publica un punto provisional.
- **Correlación** (`macro.correlation`, `pub/correlacion.json`, `/api/corr`, `web/corr.js`): índices COR y DSPX de
  CBOE (en `CBOE_VOL_INDICES`) con la cotización de hoy, percentil y banda del último año y 504 sesiones de historia.
  La publica `fase_macro`.
- **Señales de skew** (`skew.py`, `pub/skew.json`, `/api/skew`, `web/skewsig.js`, página Skew signal): tres señales
  transversales sobre las acciones del historial diario, con la cadena del cierre de `hist500` (skew y call-put, en el
  mensual estándar más cercano a 30 días entre 14 y 60: los semanales de acciones poco líquidas daban alas absurdas):
  - put skew = IV put 25Δ − ATM, solo con contratos de horquilla de como mucho el 35 % (`SK_HORQUILLA`; el
    vencimiento se elige con la cadena completa) (Xing, Zhang y Zhao, 2010; se espera IC negativo). Sin el filtro,
    GILD salía primera (+5,0) con puts de horquilla del 61 %;
  - call − put = media ponderada por OI de IV call − IV put del mismo strike a ±5 % del spot, solo con horquilla de
    como mucho el 25 % en las dos patas (Cremers y Weinbaum, 2010; se espera IC positivo). Usa la IV de CBOE
    (`iv_raw`): la del motor sale del forward por paridad y la diferencia es cero por construcción; con un forward
    sin dividendos salen desvíos de varios puntos por el desfase entre el cierre del subyacente y el de las opciones.
    Sin el filtro de horquilla, las opciones dentro del dinero de acciones poco líquidas eran ruido (GILD +1,8 y
    BKNG −7,1 el 2026-11-13); con él se quedan sin lectura;
  - O/S = log(contratos × 100 / acciones negociadas) del día, todas las series (Johnson y So, 2012; se espera IC
    negativo).
  Puntuación = media de los percentiles transversales del nivel y de su cambio en 5 sesiones; solo acciones (fuera
  índices, VIX y ETF, por el nombre del directorio de símbolos). Prueba en adelante con los cierres del índice: IC de
  rangos a 10 y 40 sesiones (plazos de swing; t de Newey-West) y diferencial entre quintiles; veredicto desde 20
  sesiones evaluadas y nunca menos que el horizonte (`need`: 40 a 40 sesiones, porque las ventanas se solapan).
  Diagnóstico (`diag`, solo en el JSON y en `pruebas/estudio_skew.py`): la misma prueba solo con el nivel (`level`),
  solo con el cambio (`change`) y con la puntuación neutralizada por el rendimiento de las 5 sesiones previas
  (`neutral`, residuo de la regresión transversal de rangos), y `past`, la correlación media entre puntuación y ese
  rendimiento previo. Sirve para saber si una señal que va al revés es solo reversión a corto plazo.
  `missing`: acciones de la lista sin lectura ese día. La publica `historial500.py` tras cada cierre.
  Consenso (`consenso`, `combinar`, señal `combo`, pestaña por defecto): cada señal vota alcista o bajista si está en
  los dos quintiles extremos de su lado; hay coincidencia (`match`) con al menos dos votos en el mismo sentido y
  ninguno en contra. Su prueba en adelante usa la media de las direcciones de las señales con dato (±1) de cada sesión.
  Vol premium (`SENALES_VOL`, señal `vrp`, Goyal y Saretto, 2009): IV ATM a 30 días − volatilidad realizada de
  `RV_DIAS` (20) sesiones con los cierres del índice, sin el mayor movimiento de la ventana (`_con_rv`, en v[6]: un
  salto de resultados no se repite; INTC +33,7 % en un día dejaba su RV20 en el 143 %). La IV sí incluye la prima de
  unos resultados antes del vencimiento, y esas acciones salen caras. No es direccional: no vota en el consenso y
  su prueba en adelante (`evaluar(..., objetivo="rv")`, `target: "rv"`) mide la prima cobrada, IV de la sesión −
  volatilidad realizada de las h sesiones siguientes; se espera IC positivo.
  Put/call (señal `pcr`, Pan y Poteshman, 2006; se espera IC negativo): la z combinada de `pcr.py` (`pcr.zetas`, en
  v[7] por `_con_pcr`); `skew.publicar` la lee de `hist500/_pcr.json.gz`. Sin dato hasta 20 sesiones por acción. Vota
  en el consenso como las demás.
- **Sentimiento por put/call** (`pcr.py`, `pub/pcr.json`, `/api/pcr`, `web/sentiment.js`, página Sentiment; diseño
  en `docs/SENTIMIENTO.md`): de la cadena del cierre, volumen y OI × |delta| de calls y puts fuera de dinero por
  tramo (`t0` 0-7 días, `t1` 8-45, `t2` más de 45, `all`). Puntuación 1-100 de cada ticker = 1 + 99 × Φ(−z), con z
  robusta (mediana y MAD) de log(P/C de volumen) frente a sus 60 sesiones anteriores, 20 sesiones con lectura contando
  la de hoy y las dos patas de al menos `MIN_PATA` (25, volumen × |delta|; calibración con `pruebas/estudio_pcr.py`
  en estudio.yml): 100 = codicia. `lead` (en el JSON): sesiones del ticker que más historia lleva. La
  combinada es la media de las z de `t0` y `t1`. Divergencias: cierre en máximo (mínimo) de 20 sesiones con la media
  de la puntuación de 5 sesiones 15 puntos por debajo (encima) de la de las 5 anteriores; estadística de los casos a
  10 y 40 sesiones. Mercado: SPX, SPY, QQQ e IWM, amplitud de las acciones y `_STOCKS` (suma de todas las acciones).
  Orden en `historial500.py`: `pcr.actualizar` → skew → `publicar_skew` → `publicar_pcr` (lee la prueba de la señal
  `pcr` de `pub/skew.json`). Prueba: `python pruebas/test_pcr.py`.
- **Movimiento esperado** (`movimiento.py`, `pub/movimiento.json`, `/api/moves`, `web/moves.js`, página Expected
  moves): magnitud, no dirección, de las acciones del historial diario al cierre. Estudio de base:
  `pruebas/estudio_movimiento.py` en estudio.yml (2026-11-26, 487 acciones; resultados en el docstring del módulo).
  - Movimiento implícito de 1σ a 1 y 5 sesiones (`g.implied_moves`): el ranking principal.
  - Evento (`evento`): varianza ATM a plazo de cada tramo entre vencimientos por tiempo efectivo (sesiones +
    `FIN_DE_SEMANA`, 0,3, por día sin mercado; sin él, Acción de Gracias daba eventos falsos; calibración con
    `pruebas/estudio_evento.py`), solo con vencimientos semanales (`semanal`: viernes, o jueves con el viernes
    festivo; los diarios de lunes y miércoles cotizan menos IV y la sierra daba eventos falsos) y saltando los que
    acaban a menos de 0,9 sesiones del anterior; si el primer tramo que acaba dentro de `EVENTO_SESIONES` (10) tiene `EVENTO_X`
    (2) veces la del siguiente, el exceso es el evento (resultados u otro) y su vencimiento, el "by" de la web.
  - Indicadores en prueba (quinto extremo del día): `heavy`, O/S alto (del índice de skew; si el volumen de la acción
    de hoy aún no está, el del día anterior); `short`, gamma del motor Perfil (estándar, 45 días, `net_per_pct`)
    negativa frente al volumen medio en $ de 20 sesiones (acciones × cierre del índice de skew).
  - Prueba en adelante en `test`: IC de rangos entre cada indicador y realizado/implícito a `H` (5) sesiones, t de
    Newey-West, cociente medio en el quinto alto y el bajo; veredicto desde 20 sesiones. `events`: mediana del mayor
    |rendimiento| diario de las 5 sesiones siguientes frente al evento implícito. `ratio`: mediana de realizado / implícito.
  - Índice `hist500/_mov.json.gz` (`punto`): `{fecha: {SYM: [m1, m5, evento %, vencimiento, sesiones, gamma $ por 1 %,
    flip, cierre]}}`. `historial500.py` lo actualiza tras pcr y skew (la primera vez lo reconstruye) y publica;
    `--movimiento` (input `movimiento` del workflow) solo lo reconstruye y publica; `--indice` también lo rehace.
    Prueba: `python pruebas/test_movimiento.py`.
- **Régimen de gamma del SPX** (`macro.gamma_regime`, `pub/regimen.json`, `/api/regimen`): GEX diario de
  SqueezeMetrics (CSV público desde 2011), percentil frente a las 252 sesiones previas y quintil. Para cada quintil,
  con toda la historia, el cuantil 68,3 % de |rendimiento| / σ del VIX (`ratio`) y la fracción de cierres fuera del
  rango implícito (`breaks`). La web multiplica el rango de 1σ de SPX, SPY y XSP por `ratio` (`paintEmRegime`) si el
  GEX es de antes de la sesión del rango. La publica `fase_macro`. Estudio: `pruebas/regimen_gamma.py`.
  `p1s` (`prob_1sigma`): probabilidad de que el SPX cierre la sesión siguiente fuera del 1σ del VIX, logística
  (`logit_fit`, Newton) sobre el percentil del GEX y VIX9D/VIX (`SIGMA1_MODELO`) ajustada con toda la historia
  (`datos_1sigma`). Estudio fuera de muestra con las cinco variables candidatas: `pruebas/modelo_1sigma.py` (Brier
  0,1469 frente a 0,1539 de la frecuencia fija en 2020-hoy entrenando con 2012-2019; aguanta al revés y está
  calibrado). Sin eventos macro: no hay calendario histórico anterior a 2026.
  `ndx`: el mismo régimen (GEX del SPX) calibrado con QQQ y el VXN (`_calibrar_quintiles`, `prob_1sigma("QQQ", "VXN")`;
  CBOE no publica el histórico del NDX); la web lo aplica a NDX, QQQ y XND. Fuera del 1σ del VXN: 33,5 % con gamma
  muy baja, 13,1 % muy alta; Brier 0,1745 frente a 0,1805 (y al revés 0,1606 frente a 0,1668). El Russell no tiene:
  CBOE no da histórico del RVX. Las variables del día (`_vars_hoy`) solo usan el GEX y la familia VIX.
  `gaps` (`gap_tramos`, `datos_gaps`): por tamaño del gap de apertura en σ (SPY con el VIX, QQQ con el VXN; sus
  aperturas son operaciones reales), fracción cerrada en la sesión (`fill`) y que siguió al gap (`trend`). La web
  la usa en el pre-mercado de SPX, XSP y NDX (`spot_implied`). Estudio: `pruebas/estudio_gaps.py` (el tamaño baja
  el Brier de 0,249 a 0,213; gamma, VIX9D/VIX, dirección y el día anterior añaden un 1-2 %; seguir al gap, 51 %).
- **Régimen de la curva del VIX** (`macro.curva_tramos`, campo `regime` de `vix_curve`, `renderVixRegime`): con los
  cierres de CBOE (VIX3M desde 2009, VIX9D desde 2011), por tramos de VIX/VIX3M y de VIX9D/VIX, rendimiento del SPX a 5
  y 20 sesiones, % al alza y volatilidad realizada de las 20 sesiones siguientes menos el VIX; `q3`/`q9`: tramo de hoy
  con los índices en directo. Estudio con las dos mitades y la t de cada tramo: `pruebas/regimen_vix.py` (cuanto más
  plana o invertida la curva, mejor el SPX a 20 sesiones, t de 1,4 a 1,9; con VIX9D/VIX > 1,05 la prima de
  volatilidad cobrada cae a la mitad, y desde 2018 casi a cero).
- **Nubes del VIX** (`macro.nubes_vix`, campo `scatter` de `vix_curve`, `renderVixScatter`): CSV de CBOE (SPX desde
  1975, VIX y SKEW desde 1990, VIX3M desde 2009). `move`: cambio del SPX (%) y del VIX (puntos) de cada sesión; `term`
  y `skew` (`_nube_ajuste`): VIX frente a VIX3M/VIX o al SKEW con el ajuste `a + b·ln(VIX)` y `sd` de los residuos (el
  logarítmico deja menos residuo que el lineal o 1/VIX). El del SKEW solo con los últimos `SKEW_AJUSTE_ANOS` (5,
  `fit_since`): ha subido de 115 en los 90 a 145, y con toda la historia cualquier día reciente saldría caro
  (correlación con ln(VIX) de −0,5 en 5 años, −0,18 en 36). Fechas como saltos en días naturales (`d`) para no inflar
  `vix.json` (~300 KB sin comprimir). El punto de
  hoy (`today`) va aparte: en directo con la sesión abierta (`indices_vol`, también el SPX), si no el último cierre.
  La web calcula la recta del SPX, el titular (días que superan al de hoy en la dirección de su residuo) y el tooltip.
- **Régimen de volatilidad** (`macro.regimen_vol`, campo `volreg` de `vix_curve`, `volRegParts` en la curva del VIX y
  el Summary): zona de hoy de VIX, VVIX, VIX3M/VIX y SKEW/VIX (cortes en `VOLREG`), en directo con la sesión abierta
  (`_volreg_seguro`) y si no al último cierre, y qué hizo el SPX desde 2010 tras los días de
  cada zona (60 y 120 sesiones, % al alza, mediana de la caída adicional en 60). VVIX y SKEW dan 403 en el histórico
  JSON de CBOE: se leen los CSV de `daily_prices` (`gex_engine.daily_csv`), caché de 1 h. Cortes elegidos con el estudio de
  episodios `pruebas/niveles_vol.py` (VIX ≥ 35 y VVIX ≥ 140 como zona de compra; VIX3M/VIX ≥ 1,25 y SKEW/VIX ≥ 12,
  complacencia).
- **Sin la API `delayed_quotes` de CBOE** (403 desde el 2026-11-20 en cotizaciones, gráficos e históricos, desde Actions
  y desde el PC; los CSV de `us_indices/daily_prices` siguen abiertos):
  - `fetch_quote` devuelve el mismo formato (`data.current_price`, `close`, `prev_day_close`, OHLC, `timestamp` UTC) más
    `source` (`tradier` o `csv`) y `today`. Tradier (solo con token) si la última operación es de hoy o no es un índice;
    si no, el último cierre oficial del CSV (`daily_csv`, fechado a las 16:15 ET): fuera de la sesión Tradier ya pasa los
    índices al día siguiente (previo = último, sin OHLC) y no tiene IRX, TNX, VXN, RVX, VXAPL ni COR. Sin `iv30`:
    `iv30_atm` la saca de la cadena (IV ATM del vencimiento más cercano a 30 días).
  - `fetch_aux` (`_aux_alt`): histórico de los índices de CBOE del CSV (si trae OHLC) y del resto (SPX, NDX, acciones,
    ETF) de `fuente_tradier.historico` desde 2010; intradía con `fuente_tradier.velas` (no hay de NDX ni RUT). Sin token
    (PC, `historial500.yml`) solo quedan los CSV y la caché del disco.
- **Índices de volatilidad en directo** (`macro.indices_vol`, `term` de `vix_curve`): con la sesión abierta, la
  cotización de `fetch_quote` solo si es de hoy (VIX3M, VVIX o SKEW sin cálculo darían el cierre de ayer). Con la sesión
  cerrada, cierres de los CSV de CBOE, todos de la misma fecha: el VIX cotiza en horario extendido y los demás no.
- **Posicionamiento en `compute`:** `scenarios` (GEX por 1 % y flujo de cobertura en la rejilla `SCEN_SPOT` ×
  `SCEN_IV`; la IV se desplaza reescalando la varianza total de cada contrato), `buckets` (`EXP_BUCKETS`),
  `totals.net_per_pct_after` (sin el próximo vencimiento) y `liquidity` (ADV$ de 20 sesiones de CBOE, flujos en % del
  ADV e impacto por la raíz cuadrada; `None` en índices). El Escáner lleva `gex_adv` e `impact_bp`.
- **Panel de volatilidad** (`volatilidad.vol_data`, `vol.json`): por vencimiento, IV ATM, `mf` (varianza sin modelo
  con el método del VIX, `model_free_vol`), `rr25`/`bf25` y `event` (movimiento de un día del codo de la curva:
  varianza forward del tramo por encima de la mediana y de un vecino, `EVENT_RATIO`). `summary`: IV30 sin modelo (en
  el SPX da el VIX), realizada, prima de varianza frente a la de cierre a cierre de 20 sesiones, forma y evento.
  `realized`: Yang-Zhang y cierre a cierre por ventana, y cono del último año; no se calcula en el VIX y su familia.
  `dists`: distribución implícita del próximo vencimiento (aunque sea diario) y de cada smile (`g.dist_json`, rejilla
  de 200 puntos, densidad relativa a su máximo y CDF).
- **Distribución implícita** (`g.implied_distribution`, Breeden-Litzenberger): IV fuera de dinero por strike (sin
  |delta| < 0,02), interpolada en log-strike, plana fuera de los strikes y suavizada (gaussiana de `DIST_SMOOTH` = 0,2σ
  ATM: sin ella el ruido de strikes contiguos de SPX y NDX daba un 10-20 % de densidad negativa), sin opciones sin bid
  y sin saltos de IV de más de `DIST_OUTLIER` (35 %) hacia las alas (Tradier da 170-500 % en calls lejanas del SPX); calls de Black sobre
  el forward y segunda derivada. `clip` = masa negativa recortada (`noisy` > 5 %). `compute` añade `level_probs`
  (`level_dists`: próximo vencimiento y el semanal de esa semana; probabilidad de cerrar más allá de Call Wall, Put Wall
  y flip y de tocarlos, estimada como el doble). `_snap` guarda `pc_exp`, `pc_cw`, `pc_pw` y `pc_flip`.
- **Histórico:** clave `fecha|filtro+variante`, con `c` (combo), `f` (flujo) y `s` (SpotGamma); `|a` = foto ex ante;
  `|i` = niveles durante la sesión (Trading Window), lista de filas; quien lea el histórico debe saltarla.

## Pruebas (con datos reales)
- Desde el PC del usuario se llega a CBOE; el token de Tradier solo está en GitHub, así que Tradier se prueba en Actions:
  `prueba_tradier.yml` con `inputs[script]=tradier_motor.py` (Tradier frente a CBOE) o `tradier_historial.py`.
- Fuente de la cadena: Tradier si hay `TRADIER_TOKEN` (y `GEX_FUENTE` no es `cboe`); si falla, CBOE. El resultado lleva `source`.
  El historial diario (`historial500.yml`) usa CBOE: no recibe el token (114 tickers no caben en 120 peticiones/min).
- Historial de Tradier: velas diarias de años (subyacente) y de cada contrato desde que cotiza; 1 min unos 20 días,
  5 y 15 min unos 40 días. No da OI ni IV pasados, así que los niveles pasados solo salen del historial propio.
- **`comparar.yml`** (input `script`) ejecuta cualquier `pruebas/*.py`, por ejemplo:
  `gh api -X POST repos/LoppVicious/gexlab/actions/workflows/comparar.yml/dispatches -f ref=main -f 'inputs[script]=motores.py'`
- **`prueba_visual.yml`** levanta `server.py`, recorre la web con Playwright y sube las capturas a la rama `prueba-visual`.
  - Es temporal: hay que borrarla después.
  - El proxy de esta sesión no deja borrar ramas por API; se borra en GitHub ▸ Branches.
- **Ciclo manual del motor:** `.../workflows/motor.yml/dispatches` con `inputs[modo]=ciclo`.
- **Comandos de `gh`:** usar `gh api` REST. GraphQL no está disponible; `gh workflow run` falla.
- **Despliegue:** cada push a `web/**`, `nube/**` o `gex_engine.py` lanza `desplegar.yml`. El usuario recarga con Ctrl+F5.
- **Comprobación de JS:** `node --check`. Para Python, importar el módulo.

