---
name: take-flujos
description: Escribe la nota diaria de flujos de GEX Lab como borrador de Founder Take - cobertura de los dealers, ETFs apalancados, vol-control, CTAs, strikes con puts y la asimetria de los flujos mecanicos a +-5 %, con conclusiones y escenarios en los dos sentidos - a partir del paquete del cierre. Usar cuando el usuario escriba /take-flujos o pida la nota de flujos, la nota del cierre para Takes o "un Take tipo McElligott".
---

# Nota diaria de flujos

Argumento opcional: la sesion (`YYYY-MM-DD`); sin el, la ultima cerrada. Todo en Git Bash desde `gexlab/`.
Base: `https://dashboard.gexlab.workers.dev`. Temporales: el scratchpad. Diseno: `docs/FLUJOS.md`.

## 1. Token

`test -n "$GEXLAB_REPORT_TOKEN" && echo ok`. Si falta, para y explica lo mismo que en `/report-semanal` (secreto
`REPORT_TOKEN` en GitHub, redesplegar y variable de entorno `GEXLAB_REPORT_TOKEN` en el PC). Que no lo pegue en el chat.

## 2. Esperar el paquete

```bash
A="Authorization: Bearer $GEXLAB_REPORT_TOKEN"; B=https://dashboard.gexlab.workers.dev/api/flujos
F=${ARG:-$(.venv/Scripts/python.exe -c "import social_diario as s, gex_engine as g; print(s.ultima_sesion_cerrada(g.now_ny()))")}
curl -s -o /dev/null -w '%{http_code}\n' -H "$A" "$B/$F"
```

`flujos.yml` se lanza solo al acabar el historial diario (este empieza a las 16:30 ET y tarda unos 50 min; el
paquete suele estar hacia las 17:30 ET). Si da 404, mira el estado de los dos:
`gh api "repos/LoppVicious/gexlab/actions/workflows/<historial500.yml|flujos.yml>/runs?per_page=1" --jq '.workflow_runs[0] | "\(.status) \(.conclusion) \(.created_at) \(.html_url)"'`.
Si alguno sigue en marcha, espera en segundo plano (`run_in_background`) comprobando cada 60 s hasta 200, como mucho
90 min. Si `flujos.yml` acabo en error, para y da el enlace. Si el historial acabo bien y `flujos.yml` no corrio,
lanzalo (`gh api -X POST repos/LoppVicious/gexlab/actions/workflows/flujos.yml/dispatches -f ref=main`).

## 3. Leer el paquete, los graficos y la nota anterior

```bash
curl -sf -H "$A" "$B/$F" -o "<scratchpad>/flujos.json"
```

Bloques (cada uno con `estado`; lo `ausente` no se menciona):
- `dealers.simbolos.{SPX,SPY,NDX,QQQ,RUT,IWM}` y `dealers.complejos` (indice + ETF): `net_per_pct` (gamma por 1 %,
  `pct` = percentil de 1 ano), `flujo` (compran + / venden - si el indice se mueve X % con la IV quieta), `estres`
  (con la IV +5 en las bajadas y -2 en las subidas), `zero_gamma`, walls, `vanna_flow`, `charm_flow`.
- `letf`: rebalanceo de hoy al cierre (`total`, `por_subyacente`), `por_1pct` (cuanto suma cada 1 % mas),
  `escenarios`, `pct` (percentil de 252 sesiones), `aum`.
- `vol_control`: `exposicion` (veces el capital), `pct` (10 anos), `cambio_1d`/`cambio_5d` en dolares,
  `vol_realizada`, `escenarios` (-5, -3, 3, 5 y `calma` = dos semanas de +-0,5 %). AUM supuesto: decirlo.
- `cta`: `posicion` (-1 a 1), `senales` por ventana, `giros` (nivel del SPX que da la vuelta a cada senal manana),
  `escenarios`, `pct`. Sin dolares.
- `strikes`: strikes del SPX con mas puts cerca del precio, vencimiento principal, `flujo_si_cierra_aqui` (lo que los
  dealers recomprarian o venderian por las puts), `cobertura_por_vencimiento` (coberturas que se deshacen al vencer).
- `asimetria`: total y por fuente a -5 % y +5 %, `cociente` y `pct`.
- `destacados`: lo extremo de hoy. `previa`: la fila de la sesion anterior (con su `tesis` si la hubo).

Descarga los graficos de los campos `graficos` (`curl -sf -H "$A" "$B/$F/g/<nombre>.png" -o "<scratchpad>/<nombre>.png"`)
y miralos con Read. Si la sesion anterior tuvo nota, comprueba su tesis con lo que paso hoy: es lo primero que se
cuenta si fallo o si se cumplio de forma clara.

## 4. Contexto

Busca en la web (WebSearch, modo standard) que movio el mercado hoy y que hay en los proximos dias (macro, Fed,
resultados grandes, vencimientos, VIX). Solo con fuente de ese dia; guarda los enlaces.

## 5. Redactar

Sigue `guia-estilo.md`. Las cifras salen solo del paquete. Antes de escribir, decide la tesis: que lado es fragil,
por que (que flujos lo empujan), que lo cambiaria y que niveles importan.

## 6. Crear el borrador

Escribe `<scratchpad>/take.json`:

```json
{"titulo": "...", "cuerpo": "...", "etiquetas": ["Flows", "Auto"],
 "graficos": [{"nombre": "asimetria", "titulo": "...", "nota": "..."}],
 "tesis": {"sesgo": "bajista|alcista|neutral", "lado_fragil": "bajada|subida|ninguno",
           "niveles": [{"indice": "SPX", "nivel": 7250, "por_que": "put strike, recompra de dealers"}],
           "escenario": "una frase", "invalidacion": "una frase"}}
```

`tesis` en espanol, corta: se guarda en la serie para medir despues si las lecturas aciertan. Graficos en el orden
en que se citan, maximo 8.

```bash
curl -sf -X POST -H "$A" -H "Content-Type: application/json" --data-binary @"<scratchpad>/take.json" "$B/$F/take"
```

Responde `{"id": N}`. Dile al usuario que el borrador N esta en Research > Takes para revisarlo y publicarlo, con
la tesis en una linea y los enlaces de contexto. Si ya habia un borrador de esa sesion, recuerdale que borre el que
sobre. Si el POST falla, ensena el error.
