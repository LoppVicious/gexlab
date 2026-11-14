# GEX Lab

Panel privado de exposición gamma (GEX) de opciones, estética SpotGamma, para dos usuarios. En producción en
https://dashboard.gexlab.workers.dev, coste 0 €. Referencia de números para comparar niveles: gexbot.

## Stack
Python 3 (numpy, boto3) · GitHub Actions (motor, repo público) · Cloudflare Worker + R2 + D1 · web en JS sin framework,
con Pyodide para calcular en el navegador. Datos: Tradier (tiempo real, token solo en Actions) y CBOE de respaldo.

## Comandos (PowerShell, desde la raíz)
- Local: doble clic en `Abrir GEX Lab.bat` (crea `.venv`) o `.venv\Scripts\python.exe server.py` → http://127.0.0.1:8765
- Comprobar: `node --check web\app.js` (cada JS tocado); Python: `python -c "import gex_engine"`.
  Takes: `node --test pruebas/test_takes.mjs pruebas/test_takes_api.mjs`.
  Report semanal: `python pruebas/test_report.py` y `node --test pruebas/test_report_api.mjs`; se genera con `/report-semanal` en Claude Code.
- Historial local: `$env:GEX_ALMACEN="local:./data/x"; python historial500.py --forzar AAPL`
- Deploy: push a `main` (`web/**`, `nube/**` o `gex_engine.py` lanza `desplegar.yml`). El usuario recarga con Ctrl+F5.
- Pruebas reales en Actions: `gh api -X POST repos/LoppVicious/gexlab/actions/workflows/comparar.yml/dispatches -f ref=main -f 'inputs[script]=motores.py'`
  (cualquier `pruebas/*.py`; Tradier con `prueba_tradier.yml`; ciclo manual: `motor.yml` con `inputs[modo]=ciclo`).
- `gh`: solo `gh api` REST; GraphQL y `gh workflow run` fallan.

## Mapa
- `gex_engine.py` — todo el cálculo (cadena, gamma, niveles, perfil, mapa TRACE, escáner, Compass, histórico); lo usa también el navegador
- `motor.py` — ciclo de Actions (cada 15 min) y modo `rapido` (cada 5 min, 6 índices); publica en R2
- `fuente_tradier.py` · `almacen.py` (R2 o disco) · `historial500.py` (historial diario a R2 `hist500/`)
- `volatilidad.py`, `macro.py` (VIX, COT), `eventos.py` (calendario macro: ForexFactory y fuentes oficiales de EE. UU.), `reales.py` (dato real de EE. UU. con BLS y FRED)
- `nube/worker.js` — Worker: auth, D1, crons que lanzan el motor, `/api/*`, `/admin`; `nube/takes.js` — API de Founder Takes; `nube/report.js` — rutas del report semanal (token propio)
- `skew.py` — señal de skew a 30 días para swings en acciones (índice `hist500/_skew.json.gz`, `pub/skew.json`)
- `report_semanal.py` (paquete y PNG en R2 `report/`), `report_calc.py` (cálculos y umbrales), `report_graficos.py` (matplotlib); skill `.claude/skills/report-semanal/`
- `web/` — `app.js` (app principal), `nube.js` (intercepta fetch), `motor-web.js` (Pyodide), `styles.css`/`sg.css` (estructura), `tema.css` (temas Bento oscuro y Daylight claro: misma letra y formas, distintos colores; los colores de gráfico de `THEMES` en `app.js` deben coincidir), `resumen.js` (Summary), `skewsig.js` (Skew signal), `calendario.js` (tarjeta de eventos y página Calendar), `takes.js`/`takes-md.js`/`takes.css` (Founder Takes)
- `server.py` — modo PC: misma web y API en local · `pruebas/` — scripts para `comparar.yml`
- `docs/ARQUITECTURA.md` — flujo completo, claves de R2, los dos motores, pruebas. Leer antes de tocar motor o Worker.

## Reglas
- Escribe en español, directo, sin emojis. Resultado pulido en tema claro y oscuro.
- La web está en inglés (textos, mensajes de error del motor y del Worker, formato de cifras en-US). Código,
  comentarios, docs y CHANGELOG siguen en español. Colores de gráficos: siempre de `C` (tema), nunca fijos.
- Comprueba con datos reales antes de dar algo por hecho.
- **Repo público:** nunca subir datos, historial, claves ni tokens; secretos solo en GitHub Secrets (nombres en ARQUITECTURA).
  No pidas secretos en el chat; si el usuario los pega, recomienda regenerarlos. Las contraseñas las crea el admin en la web.
- Todo debe seguir gratis (Cloudflare plan gratuito, Actions de repo público).
- Cada push a `main` actualiza `CHANGELOG.md` en el mismo commit: una entrada por día, la más reciente arriba,
  Añadido / Cambiado / Corregido; si ya hay entrada del día, se amplía y reescribe al estado final.
- Motores: en pantalla **Neto** (id `gexbot`, claves `_gb`) y **Perfil** (id `spotgamma`). No renombrar los ids.
  Auto = Neto en 0DTE, Perfil en el resto. Escáner, Compass y Validación usan siempre Perfil.
- El motor calcula siempre VIX (`motor.SIEMPRE`). `prueba_visual.yml` crea la rama `prueba-visual`: el usuario la borra en GitHub.

## No tocar
`history/`, `cache/`, `data/`, `salida/`, `estado/`, `.venv/`, `nube/dist/`, `nube/.wrangler/`, `nube/wrangler.toml`,
`servidor/servidor.txt`, `watchlist.json`. `servidor/`: despliegue alternativo en VPS propio; producción es Cloudflare.

## Estado
Pendientes e ideas en `docs/ESTADO.md`.
