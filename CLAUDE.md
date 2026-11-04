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
  motor.py ciclo -> descarga CBOE, calcula, publica en R2 (Cloudflare)
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

**Claves de vista:** `{dte}_{range}_{pos}_{combo}` + `_gb` si el motor es gexbot + `_{sess}` en el mapa.
El rango canónico es `auto` o un número sin ceros sobrantes. El motor borra las vistas que ya no calcula.

### Secretos (solo los nombres)
`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
`GH_DISPATCH_TOKEN`, `GEX_SETUP_CODE`, `FRED_API_KEY`, `TRADIER_TOKEN`.
El de Tradier ahora mismo responde 401 (token inválido). Ver "Pendiente".

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
- **Vol Trigger:** strike más alto por debajo del flip con GEX neta ≤ −25 % del máximo.
- **Rango Auto:** 1σ implícita. En 0DTE, de lo que queda de sesión; con el resto de filtros, de una sesión completa. Mínimo 0,4 %, máximo 10 %.
- **Histórico:** clave `fecha|filtro+variante`, con `c` (combo), `f` (flujo) y `s` (SpotGamma); `|a` = foto ex ante.

## Pruebas (con datos reales)
- Desde el contenedor de Claude no se llega a CBOE ni a Tradier. Desde GitHub Actions, sí.
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
- **Datos:** Tradier como fuente principal (tiempo real) con CBOE de respaldo, cuando haya un token válido. Ya existe `pruebas/tradier.py` + `prueba_tradier.yml`.
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
