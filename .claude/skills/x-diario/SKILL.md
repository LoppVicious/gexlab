---
name: x-diario
description: Escribe los posts del cierre para X (Twitter) de GEX Lab - la conclusion del dia (SPX, NDX, VIX, amplitud, bonos, oro, crypto) y el playbook de la sesion siguiente, en hilos de 280 caracteres por post, con lectura y tono propios - y los guarda en Research > Social. Usar cuando el usuario escriba /x-diario o pida los tweets, el cierre o el playbook del dia.
---

# Posts del cierre para X

Argumento opcional: la sesion (`YYYY-MM-DD`); sin el, la ultima cerrada. Todo en Git Bash desde `gexlab/`.
Base: `https://dashboard.gexlab.workers.dev`. Temporales: el scratchpad.

Cada dia, dos entregas obligatorias: **la conclusion del dia** y **el playbook de la proxima sesion**. Mas uno o dos
posts sueltos cuando algo lo merezca (acciones, VIX, mercados cruzados).

## 1. Token

`test -n "$GEXLAB_REPORT_TOKEN" && echo ok`. Si falta, para y explica lo mismo que en `/report-semanal` (secreto
`REPORT_TOKEN` en GitHub, redesplegar y variable de entorno `GEXLAB_REPORT_TOKEN` en el PC). Que no lo pegue en el chat.

## 2. Asegurar los datos

```bash
A="Authorization: Bearer $GEXLAB_REPORT_TOKEN"; B=https://dashboard.gexlab.workers.dev/api/social
F=${ARG:-$(.venv/Scripts/python.exe -c "import social_diario as s, gex_engine as g; print(s.ultima_sesion_cerrada(g.now_ny()))")}
curl -s -o /dev/null -w '%{http_code}\n' -H "$A" "$B/$F"
```

`social.yml` lo hace solo en dos pasadas: a las 16:20 ET (lo lanza el Worker; listo hacia las 16:25) con indices,
VIX, mercados cruzados y proxima sesion, y al acabar el historial diario (17:10-17:30 ET) anade las acciones.
Si da 404, mira si `social.yml` esta en marcha
(`gh api "repos/LoppVicious/gexlab/actions/workflows/social.yml/runs?per_page=1" --jq '.workflow_runs[0] | "\(.status) \(.conclusion) \(.created_at)"'`);
si no, lanzalo (`gh api -X POST repos/LoppVicious/gexlab/actions/workflows/social.yml/dispatches -f ref=main`; para
rehacer, `-f 'inputs[forzar]=true'`, solo entre las 16:20 y las 17:15 ET porque despues CBOE retira las cadenas).
Espera en segundo plano (`run_in_background`) comprobando cada 30 s hasta que responda 200.

## 3. Leer datos y graficos

`curl -sf -H "$A" "$B/$F" -o "<scratchpad>/social.json"` (`paquete` y, si ya habia, `textos`). Descarga los graficos
de los campos `graficos` de cada bloque (el `playbook` va en `manana`; `curl -sf -H "$A" "$B/$F/g/<nombre>.png" -o "<scratchpad>/<nombre>.png"`) y
miralos con Read antes de escribir. Bloques:
- `indices.{SPX,NDX,RUT}`: cambio, `cambio_vs_esperado`, regimen (y el de ayer), niveles y distancias, niveles que se
  movieron, rango de 1σ de manana (`siguiente`) y de la semana, gamma que vence en el proximo vencimiento.
- `vix`: cierre, cambio, percentil de 1 ano, curva de hoy y de ayer, si esta invertida.
- `mercados`: `grupos` (Rates con el 10 anos en % y pb, Credit, Dollar, Commodities, Crypto y Crypto spot 24 h),
  `sectores` ordenados y `amplitud` (RSP, IWM y QQQ frente a SPY, sectores en verde).
- `acciones`: suben/bajan de ~470 valores, mayores movimientos en sigmas, saltos de IV y volumen de opciones.
  `ausente` hasta que acaba el historial diario.
- `manana`: eventos de la proxima sesion con hora y prevision, vencimiento mensual.
Cada bloque trae `estado`, `motivos` y `destacado`. Lo `ausente` no se menciona.
Lee tambien los textos del dia anterior (`$B/<dia anterior>`) para no repetir arranques, y su playbook para decir
si se cumplio cuando aporte.

## 4. Contexto

Busca en la web (WebSearch, modo standard) que movio el mercado ese dia (macro, Fed, resultados, geopolitica) y la
causa de los movimientos grandes (`move_vs_implied_big`, `big_sigma_move`, `big_cross_asset_move`). Solo con fuente
clara de ese dia; sin ella, se habla de posicionamiento y no se especula. Guarda los enlaces para el chat.

## 5. Redactar

Sigue `guia-estilo.md`. Antes de escribir, decide la **lectura del dia** (alcista, bajista o de transicion) con las
senales de la guia y escribela en una frase para ti: todo sostiene esa lectura.

1. `cierre` (obligatorio): hilo de 3-4 posts, `indices_niveles` en el primero. Como acabaron SPX y NDX (y RUT si
   destaca) y si fue un dia de compradores o de vendedores; que cambio en el posicionamiento; el VIX; la amplitud
   (sectores, igual ponderado, small caps, valores al alza) y los mercados cruzados (10 anos, bonos, dolar, oro,
   crypto) cuando cuenten algo. Cierra con la conclusion del dia.
2. `playbook` (obligatorio): hilo de 3-4 posts, `playbook` en el primero. Lectura base para manana y el nivel que la
   cambia; mapa de niveles por indice con lo que se espera en cada uno; rango de 1σ; escenarios ("if we open above X…",
   "lose Y and…"); agenda con horas ET y opex.
3. Uno o dos posts sueltos si lo merecen: `acciones` (`acciones_sigma`), `vix` (`vix_curva`), `mercados` (`mercados`)
   o un `perfil_*`. Si `acciones` aun esta `ausente`, escribe el resto y dile al usuario que vuelva a lanzar
   `/x-diario` tras el historial; al reescribir conserva los `id` ya usados (la marca de publicado va por `id`).

**Una imagen en cada post del hilo**, la que ilustre lo que dice ese post; sin repetir dentro del mismo hilo.
Reparto orientativo (adaptalo a lo que haya y a lo que cuente cada post):
- Conclusion: 1) `indices_niveles`; 2) posicionamiento: `perfil_spx` (o el del indice protagonista); 3) VIX:
  `vix_curva`; 4) amplitud y mercados cruzados: `mercados` (o `acciones_sigma` si la amplitud es la historia).
- Playbook: 1) `playbook`; 2) mapa del SPX: `perfil_spx`; 3) NDX y RUT: `perfil_ndx` o `perfil_rut`; 4) agenda y
  escenarios: el grafico que quede mas util (`indices_niveles`, `vix_curva`).
Si no hay grafico para un post, puede ir sin imagen, pero es la excepcion.

Cifras solo de los datos. Comprueba longitudes antes de guardar (maximo 280 cada post y cada respuesta):
`.venv/Scripts/python.exe -c "import json,sys; [print(p['id'], [(len(r['texto']), r.get('graficos')) for r in [p]+p.get('hilo',[])]) for p in json.load(open(sys.argv[1], encoding='utf-8'))['piezas']]" <scratchpad>/textos.json`

## 6. Guardar

`<scratchpad>/textos.json`: `{"piezas": [{"id": "cierre", "titulo": "...", "texto": "post 1", "graficos": ["indices_niveles"],
"alt": "...", "hilo": [{"texto": "post 2", "graficos": ["perfil_spx"], "alt": "..."}, ...]}]}` (`id` en minusculas
con `_`; `hilo` hasta 4 respuestas; cada post, hasta 4 graficos; `alt`: descripcion de su imagen).

```bash
curl -s -X PUT -H "$A" -H "Content-Type: application/json" --data-binary @"<scratchpad>/textos.json" "$B/$F/textos"
```

Si falla, ensena el error. Termina diciendo que estan en Research > Social y pega cada post en el chat, con las
fuentes que usaste.

## 7. Mejora continua

Si el usuario corrige el tono, una expresion o el enfoque, anade la leccion a `guia-estilo.md` (seccion "Aprendido")
en el mismo turno, para que valga los dias siguientes.
