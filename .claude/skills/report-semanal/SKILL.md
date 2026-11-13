---
name: report-semanal
description: Genera el report semanal de GEX Lab como borrador de Founder Take. Lanza report.yml en Actions, lee el paquete de datos y los graficos, redacta el texto en ingles y crea el borrador. Usar cuando el usuario escriba /report-semanal o pida el report semanal.
---

# Report semanal

Argumento opcional: la ultima sesion de la semana (`YYYY-MM-DD`). Sin argumento, la ultima guardada.
Todo en Git Bash desde `gexlab/`. Base: `https://dashboard.gexlab.workers.dev`. Ficheros temporales: el scratchpad.

## 1. Token

`test -n "$GEXLAB_REPORT_TOKEN" && echo ok`. Si falta, para y explica al usuario: crear un token largo aleatorio,
guardarlo como secreto `REPORT_TOKEN` en GitHub (Settings > Secrets > Actions), redesplegar (`desplegar.yml`) y
ponerlo en su PC como variable de entorno de usuario `GEXLAB_REPORT_TOKEN`. Que no lo pegue en el chat.

## 2. Lanzar el calculo y esperar

```bash
T0=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh api -X POST repos/LoppVicious/gexlab/actions/workflows/report.yml/dispatches -f ref=main -f "inputs[fecha]=FECHA_O_VACIO"
```

Espera con este bucle en segundo plano (`run_in_background`), que acaba cuando la ejecucion nueva termina:

```bash
for i in $(seq 1 40); do
  r=$(gh api "repos/LoppVicious/gexlab/actions/workflows/report.yml/runs?per_page=1" --jq '.workflow_runs[0] | "\(.created_at) \(.status) \(.conclusion) \(.html_url)"')
  set -- $r
  if [ "$1" \> "$T0" ] || [ "$1" = "$T0" ]; then [ "$2" = completed ] && { echo "$r"; exit 0; }; fi
  sleep 30
done; echo "timeout $r"; exit 1
```

Si `conclusion` no es `success`, para y da al usuario el enlace de la ejecucion.

## 3. Leer el paquete y los graficos

```bash
A="Authorization: Bearer $GEXLAB_REPORT_TOKEN"; B=https://dashboard.gexlab.workers.dev/api/report
F=$(curl -sf -H "$A" $B/ultimo | .venv/Scripts/python.exe -c "import json,sys; print(json.load(sys.stdin)['fecha'])")
curl -sf -H "$A" "$B/$F" -o "<scratchpad>/paquete.json"
```

Lee `paquete.json`. Para cada bloque con `estado` `ok` y `destacado` true, descarga sus `graficos`
(`curl -sf -H "$A" "$B/$F/g/<nombre>.png" -o "<scratchpad>/<nombre>.png"`) y miralos con Read.
Si ningun bloque esta destacado, dilo al usuario con el resumen de una linea por bloque y para: no hay report.

## 4. Contexto de la semana (opcional)

Busca en la web (WebSearch, modo standard) que movio el mercado esa semana, solo para explicar los bloques
destacados. Usa solo lo que tenga fuente; guarda los enlaces.

## 5. Redactar

Sigue `guia-estilo.md` (en esta carpeta). Las cifras salen solo del paquete.

## 6. Crear el borrador

Escribe `<scratchpad>/take.json`:
`{"titulo": "...", "cuerpo": "...", "etiquetas": ["Weekly", "Auto"], "graficos": [{"nombre": "...", "titulo": "...", "nota": "..."}]}`
(maximo 8 graficos, en el orden en que se citan en el texto).

```bash
curl -sf -X POST -H "$A" -H "Content-Type: application/json" --data-binary @"<scratchpad>/take.json" "$B/$F/take"
```

Responde `{"id": N}`. Dile al usuario que el borrador N esta en Research > Takes para revisarlo y publicarlo.
Si ya habia un borrador de esa semana, recuerdale que borre el que sobre. Si el POST falla, ensena el error.
