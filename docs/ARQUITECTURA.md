# GEX Lab: referencia técnica

Detalle que no cabe en CLAUDE.md. Léelo solo para la parte que toques.

## Arquitectura
```
GitHub Actions (motor.yml, repo público = minutos ilimitados)
  motor.py ciclo -> descarga Tradier (tiempo real; CBOE de respaldo), calcula, publica en R2 (Cloudflare)
Cloudflare Worker "dashboard" (nube/worker.js) + assets estáticos (web/)
  - auth (PBKDF2 en el cliente, sesión única por cuenta), prefs y listas en D1
  - cron */5: toca() lanza motor.yml modo ciclo cada 15 min (días laborables 07:45-17:15 ET, 18:00, 20:00, sáb 10:00);
    tocaRapido() lanza modo rapido cada 5 min de 07:05 a 16:05 ET (de 07:05 a 09:30, el tramo previo a la apertura).
  - **Tiempo real** (`motor.py rapido`, `TIEMPO_REAL` = SPX NDX RUT SPY QQQ IWM): cadena y velas de 1 min de Tradier
    (`fuente_tradier.velas`, solo cerradas y hasta el cierre, formato de CBOE intraday; solo `VELAS_TRADIER`:
    Tradier no da velas de NDX ni RUT), paquete y vistas; lee el estado pero no lo guarda
    (historial de niveles y flujo, en el ciclo de 15 min, que vuelve a descargar esos 6: el cupo de Tradier alcanza).
    Escribe `pub/rapido.json`. Sale sin hacer nada fuera de 07:00-cierre (festivos, cierre a las 13:00). Resto de
    tickers: velas de CBOE. La web (Auto) recarga cada minuto esos 6 y cada 5 el resto.
  - **Tramo previo a la apertura del TRACE** (`gex_engine.PRE_PROXY`, desde `PRE_OPEN` = 07:00): el mapa de SPX, NDX,
    RUT y sus ETF empieza a las 07:00. `fuente_tradier.velas_pre` añade a `fx/intraday_SYM.json` las velas de 1 min del
    ETF (Tradier, `session_filter=all`) escaladas al índice (`pre_src` = ETF). Ratio: índice / ETF al cierre de la vela
    de 09:35-09:40 (la primera vela del índice lleva precios de ayer); antes, el de los cierres anteriores (RUT no tiene
    `prevclose` en Tradier: última vela anterior o `last` antes de abrir). Antes de las 09:30 el `spot` del paquete es
    el cierre de la última vela escalada. La gamma no consume varianza fuera de horas de mercado: en ese tramo el mapa
    cambia solo con el precio (el open interest es el del cierre anterior). Prueba: `pruebas/premarket_mapa.py`.
  - /api/pub/* sirve R2; /api/pedir lanza un ciclo para tickers nuevos
Navegador
  - web/nube.js intercepta fetch: usa las vistas precalculadas de R2 o calcula en el navegador
    con Pyodide (web/motor-web.js) ejecutando el MISMO gex_engine.py sobre el "paquete" del ticker
```
Modo PC (sin nube): `server.py` sirve la misma web y la misma API en local.

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
- `hist500/{SYM}/{fecha}.json.gz`: historial diario para backtests, fuera del estado. Lo lanza el Worker a las 16:30 ET
  (cron de GitHub de respaldo); `hist500/_dias/{fecha}.json` marca la sesión hecha. Se conservan 2 años.
  - `chain`: cadena compacta (`chain_to_min`, contratos con OI o volumen); se recalcula con `parse_chain({"_min": chain})`.
  - `levels[posición][motor][filtro]`: los mismos campos que el histórico (`_snap`), rango 5 %, estándar y flujo, calculados
    tras el cierre. Todos los filtros de la barra; el 0DTE solo con vencimientos diarios (≥4 en 7 días).
  - `hist500/_niveles/{SYM}.json.gz`: índice `{fecha: levels}` con los campos que usa la Validación (`CAMPOS_INDICE`).
    Se actualiza con cada sesión y se reconstruye con todos los días si falta (`historial500.py --indice`, o el
    workflow con `indice`). `motor.fase_listas` lo lee para los tickers de las listas y `g.validation(extra=...)` lo
    usa para las sesiones que falten en `history/{SYM}.json` (foto tras el cierre, como la clave `fecha|filtro`).
  - `hist500/_flujo/{SYM}.json.gz`: volumen y lado por contrato de las últimas 8 sesiones (modo flujo).
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
- Tipo libre de riesgo: letra a 13 semanas (IRX de CBOE).
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
- **Validación** (`validation`): muros frente a una referencia (`_base_prob`: fracción de las 500 sesiones previas
  del ticker cuyo máximo o mínimo, en unidades de su volatilidad realizada de 20 sesiones, no pasó de la distancia del
  muro), rango frente a la media de sus 20 rangos previos, y pruebas agrupadas por día (`_clustered_test`, mínimo
  `VAL_MIN_DAYS`). Días con evento: vencimiento mensual y FOMC, IPC y empleo de `cache/eventos.json` (3 años).
- **Flujo** (`flujo.tick`, `pub/t/{SYM}/flujo.json`, `/api/flow`, `web/flujo.js`): estado por ticker en
  `history/flujo_{SYM}.json.gz` (volumen e IV de la última foto, serie de la sesión y volumen firmado por contrato).
  Lo llama `motor._ticker`; solo guarda el ciclo (`save`), el modo rápido publica un punto provisional.
- **Correlación** (`macro.correlation`, `pub/correlacion.json`, `/api/corr`, `web/corr.js`): índices COR y DSPX de
  CBOE (en `CBOE_VOL_INDICES`) con la cotización de hoy, percentil y banda del último año y 504 sesiones de historia.
  La publica `fase_macro`.
- **Posicionamiento en `compute`:** `scenarios` (GEX por 1 % y flujo de cobertura en la rejilla `SCEN_SPOT` ×
  `SCEN_IV`; la IV se desplaza reescalando la varianza total de cada contrato), `buckets` (`EXP_BUCKETS`),
  `totals.net_per_pct_after` (sin el próximo vencimiento) y `liquidity` (ADV$ de 20 sesiones de CBOE, flujos en % del
  ADV e impacto por la raíz cuadrada; `None` en índices). El Escáner lleva `gex_adv` e `impact_bp`.
- **Panel de volatilidad** (`volatilidad.vol_data`, `vol.json`): por vencimiento, IV ATM, `mf` (varianza sin modelo
  con el método del VIX, `model_free_vol`), `rr25`/`bf25` y `event` (movimiento de un día del codo de la curva:
  varianza forward del tramo por encima de la mediana y de un vecino, `EVENT_RATIO`). `summary`: IV30 sin modelo (en
  el SPX da el VIX), realizada, prima de varianza frente a la de cierre a cierre de 20 sesiones, forma y evento.
  `realized`: Yang-Zhang y cierre a cierre por ventana, y cono del último año; no se calcula en el VIX y su familia.
- **Histórico:** clave `fecha|filtro+variante`, con `c` (combo), `f` (flujo) y `s` (SpotGamma); `|a` = foto ex ante.

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

