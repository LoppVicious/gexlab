# GEX Lab: referencia técnica

Detalle que no cabe en CLAUDE.md. Léelo solo para la parte que toques.

## Arquitectura
```
GitHub Actions (motor.yml, repo público = minutos ilimitados)
  motor.py ciclo -> descarga Tradier (tiempo real; CBOE de respaldo), calcula, publica en R2 (Cloudflare)
Cloudflare Worker "dashboard" (nube/worker.js) + assets estáticos (web/)
  - auth (PBKDF2 en el cliente, sesión única por cuenta), prefs y listas en D1
  - cron */5: toca() lanza motor.yml modo ciclo cada 15 min (días laborables 07:45-17:15 ET, 18:00, 20:00, sáb 10:00);
    tocaRapido() lanza modo rapido cada 5 min de 09:35 a 16:05 ET.
  - **Tiempo real** (`motor.py rapido`, `TIEMPO_REAL` = SPX NDX RUT SPY QQQ IWM): cadena y velas de 5 min de Tradier
    (`fuente_tradier.velas`, solo cerradas y hasta el cierre, formato de CBOE intraday; solo `VELAS_TRADIER`:
    Tradier no da velas de NDX ni RUT), paquete y vistas; lee el estado pero no lo guarda
    (historial de niveles y flujo, en el ciclo de 15 min, que vuelve a descargar esos 6: el cupo de Tradier alcanza).
    Escribe `pub/rapido.json`. Sale sin hacer nada si el mercado está cerrado (festivos, cierre a las 13:00). Resto de
    tickers: velas de CBOE. La web (Auto) recarga cada minuto esos 6 y cada 5 el resto.
  - /api/pub/* sirve R2; /api/pedir lanza un ciclo para tickers nuevos
Navegador
  - web/nube.js intercepta fetch: usa las vistas precalculadas de R2 o calcula en el navegador
    con Pyodide (web/motor-web.js) ejecutando el MISMO gex_engine.py sobre el "paquete" del ticker
```
Modo PC (sin nube): `server.py` sirve la misma web y la misma API en local.
El motor calcula siempre el VIX (`motor.SIEMPRE`), esté o no en las listas de los usuarios.


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
- **VIX** (`FUTURES_OPTIONS`): sus opciones van sobre el futuro de cada vencimiento. `futures_forwards` saca el forward
  por paridad put-call y la IV por Black-76; gamma, perfil, mapa y panel de volatilidad usan ese futuro (q = r).
- **Vol Trigger:** strike más alto por debajo del flip con GEX neta ≤ −25 % del máximo.
- **Rango Auto:** 1σ implícita. En 0DTE, de lo que queda de sesión; con el resto de filtros, de una sesión completa. Mínimo 0,4 %, máximo 10 %.
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

