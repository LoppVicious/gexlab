# GEX Lab: contexto para Claude Code

Panel privado de exposición gamma (GEX) de opciones inspirado en SpotGamma, para dos usuarios.
Publicado en https://dashboard.gexlab.workers.dev con coste 0 €.

## Cómo trabajar con el propietario
- Escribe en **español**: directo, conciso y profesional, sin emojis.
- Quiere un resultado pulido, que se vea bien en la web y en el tema claro y oscuro.
- La estética de referencia es **SpotGamma**. La referencia de números para comparar niveles es **gexbot**.
- Antes de dar algo por hecho, **compruébalo con datos reales**: GitHub Actions sí llega a CBOE (ver "Pruebas").

## Reglas que no se pueden romper
- **El repositorio es público.** Nunca subas datos, historial, claves ni tokens. Los secretos solo van en GitHub Secrets.
- **No pidas al usuario que pegue secretos en el chat.** Si lo hace, recomiéndale regenerarlos.
- **Las contraseñas las crea el administrador** en el panel de la web. Nunca las ves ni las introduces.
- **El dinero:** todo tiene que seguir funcionando gratis (Cloudflare Workers/R2/D1 en plan gratuito y GitHub Actions en repo público).

## Arquitectura
```
GitHub Actions (motor.yml, repo público = minutos ilimitados)
  motor.py ciclo -> descarga Tradier (tiempo real; CBOE de respaldo), calcula, publica en R2 (Cloudflare)
Cloudflare Worker "dashboard" (nube/worker.js) + assets estáticos (web/)
  - auth (PBKDF2 en el cliente, sesión única por cuenta), prefs y listas en D1
  - cron */15: toca() decide si lanza motor.yml (días laborables 07:45-17:15 ET, 18:00, 20:00, sáb 10:00)
  - /api/pub/* sirve R2; /api/pedir lanza un ciclo para tickers nuevos
Navegador
  - web/nube.js intercepta fetch: usa las vistas precalculadas de R2 o calcula en el navegador
    con Pyodide (web/motor-web.js) ejecutando el MISMO gex_engine.py sobre el "paquete" del ticker
```
Modo PC (sin nube): `server.py` sirve la misma web y la misma API en local.

### Archivos clave
| Archivo | Qué hace |
|---|---|
| `gex_engine.py` | Todo el cálculo: cadena CBOE, gamma, niveles, perfil, mapa TRACE (`heatmap`), escáner, Compass, validación, histórico |
| `motor.py` | Ciclo en Actions: tickers, paquetes, vistas precalculadas, listas, macro, estado en R2 |
| `volatilidad.py` | Panel de volatilidad: smiles, estructura temporal con IV forward, matriz, bandas 10-90 |
| `eventos.py` | Calendario macro (Fed, BEA, Census, ForexFactory, FRED API) |
| `macro.py` | Curva VIX, COT (TFF de la CFTC), Resumen |
| `almacen.py` | R2 (boto3) o disco local; JSON con gzip |
| `fuente_tradier.py` | Cadena de Tradier en tiempo real con el formato de CBOE (IV propia desde el punto medio, límite 120/min) |
| `historial500.py` | Historial diario (`historial500.yml`): cadena al cierre y niveles de una lista fija de ~100 tickers |
| `nube/worker.js`, `nube/schema.sql`, `nube/desplegar.sh` | Worker, D1 y despliegue (desplegar.yml) |
| `web/app.js` | App principal: estado, TRACE, Por strike, Perfil, Escáner, Compass, COT, VIX, Informe, TradingView |
| `web/hub.js` | Equity Hub: Impacto calls y puts y ficha |
| `web/historico.js` | Barra de zoom y pestaña Histórico de niveles |
| `web/vol.js` | Panel de volatilidad |
| `web/sg.css`, `web/styles.css` | Estilo (tokens de tema en `:root`, oscuro y claro) |

### R2
- `estado/estado.tar.gz`: carpetas `history/` y `cache/` (copias diarias en `estado/copias/`, se guardan 14).
- `pub/t/SYM/{paquete,vol}.json`, `pub/t/SYM/niveles/*`, `pub/t/SYM/mapa/*`: vistas precalculadas.
- `pub/l/{lid}/escaner_{dte}.json`, `compass.json`, `validacion_{dte}_{mode}_{model}.json`.
- `config/config.json`: listas y vistas que escribe el Worker.
- `hist500/{SYM}/{fecha}.json.gz`: historial diario para backtests, fuera del estado. Lo lanza el Worker a las 16:30 ET
  (cron de GitHub de respaldo); `hist500/_dias/{fecha}.json` marca la sesión hecha. Se conservan 2 años.
  - `chain`: cadena compacta (`chain_to_min`, contratos con OI o volumen); se recalcula con `parse_chain({"_min": chain})`.
  - `levels[posición][motor][filtro]`: los mismos campos que el histórico (`_snap`), rango 5 %, estándar y flujo, calculados
    tras el cierre. Todos los filtros de la barra; el 0DTE solo en los ETFs (`ETFS`), no en acciones.
  - `hist500/_flujo/{SYM}.json.gz`: volumen y lado por contrato de las últimas 8 sesiones (modo flujo).
  - La lista de tickers está en `TICKERS` dentro del script. Prueba local: `GEX_ALMACEN=local:./data/x python historial500.py --forzar AAPL`.

**Claves de vista:** `{dte}_{range}_{pos}_{combo}` + `_gb` si el motor es gexbot + `_{sess}` en el mapa.
El rango canónico es `auto` o un número sin ceros sobrantes. El motor borra las vistas que ya no calcula.

### Secretos (solo los nombres)
`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
`GH_DISPATCH_TOKEN`, `GEX_SETUP_CODE`, `FRED_API_KEY`, `TRADIER_TOKEN`.
El de Tradier es válido (renovado el 5-11-2026); solo lo recibe `motor.yml`.

## Los dos motores de cálculo (Ajustes ▸ Motor; SpotGamma por defecto)
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
- Call Wall: mayor GEX de calls por encima del precio (±10 % o el rango, si es mayor).
- Put Wall: mayor GEX de puts por debajo.
- Flip: cruce por cero de la GEX total recalculada en ±15 %, el más cercano al spot.

Los dos:
- **Filtro de vencimientos** (barra deslizante, acumulado; `gex_engine.DTE_FILTERS` y `expiry_filter`): 0DTE = primer
  vencimiento vivo; 1DTE = ese y los de la sesión siguiente; 7, 14, 30 y 45 = hasta N días naturales; Todos.
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

## Pendiente / ideas apuntadas por el usuario (para más adelante)
- **Dealer Hedge Ratio** (en espera): COT TFF de dealers en ES y VX (en % del OI, z-score de 3 años) + pendiente de la curva del VIX.
  - Va como tarjeta en COT y alerta en Resumen.
  - Validar antes con el histórico de la CFTC desde 2010.
- **Motor SpotGamma:**
  - Superficie sticky-delta al recalcular el perfil.
  - Vol Trigger alternativo = flip con solo los vencimientos de ≤ 5 días.
  - Descartado: peso e^(−dte/20).
- **Modo flujo automático:** flujo en 0DTE y estándar en el resto.
- **Niveles del 0DTE fijados a la apertura** (opción).
- **Elegir un vencimiento concreto**, además de los filtros acumulados.
- **Modelo "OI + volumen" como gexbot**, solo para comparar.
- **Filtro "90 días"** equivalente al "full" de gexbot.
- **Utilidades estilo SpotGamma:** Risk Reversal por vencimiento, Composite View, OI y volumen por strike con cambio de OI.
- **Importador de histórico de cadenas** (ThetaData, ORATS, CBOE DataShop…).
  - Por contrato y día: fecha, raíz, vencimiento, strike, C/P, OI vigente al abrir, IV (o bid/ask), bid, ask, volumen.
  - Además, OHLC del subyacente.
  - Con eso se recalculan el Histórico y la Validación con cualquier motor.
- **Desplazamiento índice → futuro** (ES/NQ) al copiar niveles a TradingView.
