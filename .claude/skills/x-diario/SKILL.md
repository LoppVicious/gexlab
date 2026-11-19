---
name: x-diario
description: Escribe los posts del dia para X (Twitter) de GEX Lab tras el cierre. Lee el paquete social del dia (indices, acciones, VIX, proxima sesion) y sus graficos, redacta en ingles posts de 280 caracteres como maximo y los guarda en la seccion Social de /admin. Usar cuando el usuario escriba /x-diario o pida los tweets o posts del dia.
---

# Posts del dia para X

Argumento opcional: la sesion (`YYYY-MM-DD`). Sin argumento, la ultima cerrada.
Todo en Git Bash desde `gexlab/`. Base: `https://dashboard.gexlab.workers.dev`. Ficheros temporales: el scratchpad.

## 1. Token

`test -n "$GEXLAB_REPORT_TOKEN" && echo ok`. Si falta, para y explica lo mismo que en `/report-semanal` (secreto
`REPORT_TOKEN` en GitHub, redesplegar y variable de entorno `GEXLAB_REPORT_TOKEN` en el PC). Que no lo pegue en el chat.

## 2. Asegurar el paquete del dia

```bash
A="Authorization: Bearer $GEXLAB_REPORT_TOKEN"; B=https://dashboard.gexlab.workers.dev/api/social
F=${ARG:-$(.venv/Scripts/python.exe -c "import social_diario as s, gex_engine as g; print(s.ultima_sesion_cerrada(g.now_ny()))")}
curl -sf -H "$A" $B/dias
```

Si `F` esta en `dias`, sigue al paso 3. Si no:
- El paquete se hace en dos pasadas: a las 16:20 ET (lo lanza el Worker; listo hacia las 16:25) con indices, VIX
  y proxima sesion, y al acabar el historial diario (hacia las 17:10 ET) con las acciones.
  Mira si `social.yml` esta en marcha: `gh api "repos/LoppVicious/gexlab/actions/workflows/social.yml/runs?per_page=1" --jq '.workflow_runs[0] | "\(.status) \(.conclusion) \(.created_at)"'`.
- Si no esta en marcha, lanzalo tu: `gh api -X POST repos/LoppVicious/gexlab/actions/workflows/social.yml/dispatches -f ref=main`
  (con un `F` anterior que ya existe y hay que rehacer: `-f 'inputs[forzar]=true'`; solo entre las 16:20 y las
  17:15 ET, porque despues CBOE ya no publica las cadenas de los indices).
- Espera en segundo plano (`run_in_background`) hasta que `F` aparezca en `dias`:

```bash
for i in $(seq 1 60); do curl -sf -H "$A" $B/dias | grep -q "\"$F\"" && { echo listo; exit 0; }; sleep 30; done; echo timeout; exit 1
```

Si da timeout, ensena al usuario la ultima ejecucion de `social.yml` (`.../workflows/social.yml/runs?per_page=1`, `html_url`).

## 3. Leer el paquete y los graficos

```bash
curl -sf -H "$A" "$B/$F" -o "<scratchpad>/social.json"
```

Lee `social.json` (`paquete` y, si ya habia, `textos`). Descarga todos los graficos que listan los campos
`graficos` de los bloques (`curl -sf -H "$A" "$B/$F/g/<nombre>.png" -o "<scratchpad>/<nombre>.png"`) y miralos con Read.
Bloques: `indices.{SPX,NDX,RUT}`, `acciones`, `vix`, `manana`. Cada uno trae `estado` (`ok` o `ausente`), `motivos`
y `destacado`. Si un bloque esta `ausente`, no se menciona.

## 4. Contexto (opcional)

Si un indice o una accion se movio mucho (`move_vs_implied_big`, `big_sigma_move`), busca en la web (WebSearch,
modo standard) la causa del dia. Solo si hay una fuente clara; si no, el post habla del posicionamiento, no de la causa.

## 5. Elegir y redactar

Sigue `guia-estilo.md` (en esta carpeta). Siempre:
1. Un post de los indices (obligatorio cada dia), con `indices_niveles` o el `perfil_*` del indice mas destacado.
2. Uno a tres posts mas, de lo que mas destaque del dia, por este orden de preferencia: un `perfil_*` si un indice
   cambio de regimen o cerro junto a un muro; una accion (`acciones`) con un movimiento fuera de lo normal; el VIX;
   la proxima sesion (`manana`: vencimiento mensual o evento de importancia 3). Un dia tranquilo, uno solo extra.
Si `acciones` esta `ausente` (primera pasada), escribe ya el resto y dile al usuario que, cuando acabe el historial
diario, `/x-diario` otra vez anade el post de acciones (al reescribir, conserva los mismos `id` de los posts que ya
tenia para no perder su marca de publicado).
Cifras solo del paquete. Comprueba la longitud de cada texto antes de guardar:
`.venv/Scripts/python.exe -c "import json,sys; [print(p['id'], len(p['texto'])) for p in json.load(open(sys.argv[1]))['piezas']]" <scratchpad>/textos.json`
(maximo 280; el Worker rechaza lo que pase).

## 6. Guardar

Escribe `<scratchpad>/textos.json`:
`{"piezas": [{"id": "indices", "titulo": "Index levels", "texto": "...", "graficos": ["indices_niveles"], "alt": "..."}]}`
(`id` en minusculas con `_`, unico; como mucho 4 graficos por post; `alt`: descripcion de la imagen para X).

```bash
curl -sf -X PUT -H "$A" -H "Content-Type: application/json" --data-binary @"<scratchpad>/textos.json" "$B/$F/textos"
```

Si falla, ensena el error (`curl -s` sin `-f` para verlo). Al reescribir un dia se conserva la marca de publicado de
cada `id`. Termina diciendo al usuario que los tiene en `/admin` > Social y pega tambien cada texto en el chat.
