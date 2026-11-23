# Restyle de Crypto y del mapa de liquidaciones: plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que la página Crypto y el mapa de liquidaciones se lean de un vistazo: tira de resumen arriba, mapa con zonas en vez de rayas, una fila de controles y errores de carga claros.

**Architecture:** El modelo (`web/liq-modelo.js`) añade una rejilla de zonas `gZ` (suma de `gV` a ±`zona` en precio) y quita los niveles de vida corta; todo lo que se pinta y se lee sale de `gZ`. La UI (`web/liq.js`, `web/index.html`, `web/cripto.css`) se simplifica sin cambiar el cálculo. La columna izquierda de Crypto (`web/cripto.js`) pasa a una fila superior y a un panel de Overview.

**Tech Stack:** JS sin framework, Lightweight Charts 5.2.1, Cloudflare Worker, Python (`liq_local.py`), `node --test`.

Diseño: `docs/superpowers/specs/2026-11-23-crypto-restyle-design.md`. Todo se ejecuta desde `D:\Claude\GexLab\gexlab`. Otra sesión puede editar la carpeta a la vez: `git add` siempre con rutas explícitas, sin stash ni cambio de rama. La web está en inglés; código y comentarios en español. Sin «·» como separador en la web.

---

### Task 1: Zonas y niveles de vida corta en el modelo

**Files:**
- Modify: `web/liq-modelo.js` (rejilla de dibujo, `enMapa`, `ahora`, objeto devuelto)
- Test: `pruebas/test_liq.mjs`

- [ ] **Step 1: Pruebas que fallan** (al final de `pruebas/test_liq.mjs`)

```js
test("zonas: cada tramo de gZ suma los de gV a menos de la zona", () => {
  const velas = Array.from({ length: 60 }, (_, i) => vela(i, 100 + Math.sin(i / 4) * 3));
  const oi = velas.map((_, i) => i * 10 + (i % 7 === 0 ? 200 : 0));
  const r = M.calcular(velas, oi, { vida: 1e9, bins: 600, zona: 0.01 });
  assert.ok(r.rZ > 0);
  for (const t of [20, 59]) for (let b = 0; b < r.B; b += 37) {
    let s = 0;
    for (let c = Math.max(0, b - r.rZ); c <= Math.min(r.B - 1, b + r.rZ); c++) s += r.gV[c * r.n + t];
    assert.ok(Math.abs(s - r.gZ[b * r.n + t]) < 1e-3 * Math.max(1, s), `tramo ${b}, vela ${t}`);
  }
  const sinZona = M.calcular(velas, oi, { vida: 1e9, bins: 600 });
  assert.equal(sinZona.rZ, 0);
  assert.ok(r.topeV >= sinZona.topeV);   // la escala sale de las sumas
});

test("vidaMin: un nivel que el precio toca enseguida no se pinta; uno vivo al final si", () => {
  const velas = Array.from({ length: 12 }, (_, i) => vela(i, 100, i === 2 ? { l: 85 } : {}));
  const oi = [0, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000];
  const col = (r, t) => { let s = 0; for (let b = 0; b < r.B; b++) s += r.gV[b * r.n + t]; return s; };
  const base = M.calcular(velas, oi, { levs: [{ L: 10, w: 1 }], vida: 1e9 });
  const corta = M.calcular(velas, oi, { levs: [{ L: 10, w: 1 }], vida: 1e9, vidaMin: 3 });
  // en la vela 1 viven el largo (lo toca la vela 2) y el corto (nunca se toca)
  assert.ok(col(corta, 1) > 0 && col(corta, 1) < col(base, 1));
  assert.ok(Math.abs(col(corta, 11) - col(base, 11)) < 1e-6);   // el corto sigue igual
  const k = [...corta.niveles.lado].findIndex((x) => x === 0);   // el largo
  assert.equal(M.enMapa(corta, k, 1), 0);
});
```

Y en la prueba «grupos y presion salen de lo que pinta el mapa», cambiar `r.gV[binDe(x.p) * r.n + t]` por `r.gZ[binDe(x.p) * r.n + t]`.

- [ ] **Step 2: Comprobar que fallan**

Run: `node --test pruebas/test_liq.mjs`
Expected: FAIL en las dos pruebas nuevas (`r.rZ` y `r.gZ` no existen).

- [ ] **Step 3: Implementación**

En `calcular`, sustituir el bloque de la rejilla de dibujo, desde `const desdeE = ...` hasta el cálculo de `topeV` incluido, por:

```js
    const desdeE = Math.min(Math.max(0, o.escalaDesde || 0), n - 1);
    const cada = Math.max(1, Math.floor((B * (n - desdeE)) / 60000));
    // o.vidaMin: un nivel que el precio toca antes de esas velas no se pinta (ruido de pocas velas); si sigue vivo al
    // final, si
    const vidaMin = Math.max(0, o.vidaMin || 0);
    const corto = (i, toque) => toque < n && toque - i < vidaMin;
    const rejilla = (niveles) => {
      const g = new Float32Array(B * n);
      for (const [i, toque, pr, , a] of niveles) {
        if (corto(i, toque)) continue;
        const b = binDe(pr), aE = a * (escala[i] || 1), base = oiEf && oiEf[i] > 0 ? oiEf[i] : 0;
        if (b < 0) continue;
        let f = 1;
        for (let t = i; t < toque; t++) {
          if (base && oiEf[t] > 0 && oiEf[t] < base * f) f = oiEf[t] / base;
          g[b * n + t] += aE * f;
        }
      }
      return g;
    };
    // zonas (o.zona, fraccion del precio): cada tramo suma los de alrededor a menos de esa distancia en log, asi los
    // niveles cercanos forman una zona continua (como el «±0.45% zone» de Coinfuty). Sumas por prefijos por vela
    const rZ = Math.max(0, Math.round(Math.log(1 + (o.zona || 0)) / paso));
    const zonas = (g) => {
      if (!rZ) return g;
      const z = new Float32Array(B * n), ac = new Float64Array(B + 1);
      for (let t = 0; t < n; t++) {
        for (let b = 0; b < B; b++) ac[b + 1] = ac[b] + g[b * n + t];
        const eps = ac[B] * 1e-9;   // restos de redondeo de las restas
        for (let b = 0; b < B; b++) {
          const s = ac[Math.min(B, b + rZ + 1)] - ac[Math.max(0, b - rZ)];
          z[b * n + t] = s > eps ? s : 0;
        }
      }
      return z;
    };
    // escala fija (percentil 99,9 de las casillas con algo de las zonas, con todos los apalancamientos, desde
    // o.escalaDesde): no depende del zoom ni de los apalancamientos que se ven
    const todos = vis_.length === lista_.length;
    const gTodo = rejilla(lista_), zTodo = zonas(gTodo);
    const gV = todos ? gTodo : rejilla(vis_), gZ = todos ? zTodo : zonas(gV);
    const muestra = [];
    for (let b = 0; b < B; b++) for (let t = desdeE; t < n; t++) {
      const v = zTodo[b * n + t];
      if (v > 0 && (b * n + t) % cada === 0) muestra.push(v);
    }
    muestra.sort((x, y) => x - y);
    const topeV = muestra.length ? muestra[Math.min(muestra.length - 1, Math.floor(muestra.length * 0.999))] : 1;
```

En el objeto devuelto, añadir `gZ, rZ, vidaMin` junto a `gV`:

```js
    return { n, B, bordes, gL, gS, gV, gZ, rZ, vidaMin, topeV, predL, predS, ...
```

En `enMapa`, después de la primera comprobación:

```js
    if (t < i || t >= nv.toque[k]) return 0;
    if (nv.toque[k] < res.n && nv.toque[k] - i < (res.vidaMin || 0)) return 0;   // vida corta: no se pinta
```

En `ahora`, leer `res.gZ` en vez de `res.gV` y actualizar su comentario («la ultima columna de gZ»). Actualizar el comentario de cabecera del módulo con una línea: «Opciones `zona` y `vidaMin`: rejilla de zonas `gZ` (lo que se pinta y se lee) y niveles de vida corta fuera».

- [ ] **Step 4: Comprobar que pasan**

Run: `node --test pruebas/test_liq.mjs`
Expected: PASS, 17 pruebas.

- [ ] **Step 5: Commit**

```bash
git add web/liq-modelo.js pruebas/test_liq.mjs
git commit -m "Mapa de liquidaciones: rejilla de zonas y niveles de vida corta fuera"
```

### Task 2: El mapa pinta zonas

**Files:**
- Modify: `web/liq.js` (constantes, estado, `lqSet`, `lqCalcular`, `lqPintar`, `LqPerfil`, `lqTip`, eventos de `lqMin`)

- [ ] **Step 1: Constantes y estado.** Junto a `LQ_BANDA`:

```js
const LQ_BANDA = 4;   // alto en pixeles de cada fila del mapa y del perfil, sin hueco: las filas seguidas forman zonas
const LQ_ZONA = 0.004;   // cada fila suma lo que hay a +-0,4 % del precio
const LQ_VIDA_MIN = 6;   // velas: un nivel que el precio toca antes no se pinta
```

En `lq`: `min: +store.get("lqMin5", 20),`. Cambiar las otras dos apariciones de `"lqMin4"` (en `lqSet` y en el `change` de `#lqMin`) por `"lqMin5"`.

- [ ] **Step 2: `lqCalcular`** pasa las opciones nuevas:

```js
    lq.res = LQ_MODELO.calcular(d.velas, d.oi, { ver, vida: cfg.vida * +lq.vida, bins: 600, nivel: d.nivel,
      zona: LQ_ZONA, vidaMin: LQ_VIDA_MIN,
      escalaDesde: d.velas.length - cfg.ver });   // colores frente a lo que se ve al abrir, no a toda la historia
```

- [ ] **Step 3: `lqPintar`** lee `r.gZ` y llena toda la fila: `const nb = ..., g = r.gZ, lut = lq.lut;` y `const y0 = f * LQ_BANDA, y1 = Math.min(outH, y0 + LQ_BANDA);`. Actualizar su comentario (zonas de ±0,4 %, sin separación). En `LqHeat.draw`, la guarda pasa a `!r.gZ`.

- [ ] **Step 4: `LqPerfil.draw`**: `v = Math.max(v, r.gZ[b * r.n + t])`.

- [ ] **Step 5: `lqTip`** describe la zona del tramo más cargado de la fila. Sustituir desde `let mx = 0;` hasta la línea de `const lo = ..., hi = ...` por:

```js
  let mx = 0, bc = tr[0];
  for (let b = tr[0]; b <= tr[1]; b++) if (r.gZ[b * r.n + t] > mx) { mx = r.gZ[b * r.n + t]; bc = b; }
  if (!(mx > (lq.min / 100) * r.topeV)) return fuera();   // solo sobre lo que se ve pintado
  // la zona: +-LQ_ZONA alrededor del tramo mas cargado de la fila; su desglose suma lo mismo que el color
  const lo = r.bordes[Math.max(0, bc - r.rZ)], hi = r.bordes[Math.min(r.B, bc + r.rZ + 1)], nv = r.niveles, porL = new Map();
```

El bucle de niveles se queda igual (`enMapa` ya deja fuera los de vida corta).

- [ ] **Step 6: Comprobar**

Run: `node --check web/liq.js; node --test pruebas/test_liq.mjs`
Expected: sin salida del check; PASS.

- [ ] **Step 7: Commit**

```bash
git add web/liq.js
git commit -m "Mapa de liquidaciones: pinta zonas de +-0,4 % sin hueco entre filas"
```

### Task 3: Respuestas raras de la fuente y mapa vacío al fallar

**Files:**
- Modify: `nube/worker.js` (`liq`), `liq_local.py` (`_coinalyze`), `web/liq.js` (`lqPedir`, `lqMensaje`, `lqCargar`, `lqTraer`, nueva `lqVaciar`)
- Modify: `web/index.html` (mensaje con Retry; se hace en la Task 4 junto al resto del panel)

- [ ] **Step 1: Worker.** Tras `const txt = await r.text();`:

```js
  // Coinalyze responde una lista; cualquier otra cosa (un aviso, un objeto de error) no se guarda ni se sirve
  if (!txt.trimStart().startsWith("[")) return json(502, { error: "The data source sent an unexpected answer" });
```

- [ ] **Step 2: `liq_local.py`.** Tras `d = json.loads(...)` (fuera del `with`, antes de cachear):

```python
    if not isinstance(d, list):
        return 502, {"error": "The data source sent an unexpected answer"}
```

- [ ] **Step 3: `lqPedir`.** Cambiar `if (r.ok) return d;` por:

```js
    if (r.ok) {
      if (!Array.isArray(d)) throw new Error("The data source sent an unexpected answer.");
      return d;
    }
```

- [ ] **Step 4: Mensaje con Retry y mapa vacío.** Sustituir `lqMensaje` por:

```js
// aviso encima del mapa; con `reintentar`, boton Retry (carga fallida sin copia que ensenar)
function lqMensaje(t, reintentar = false) {
  lq.error = t || "";
  $("lqMsg").textContent = lq.error;
  $("lqMsgW").hidden = !lq.error;
  $("lqRetry").hidden = !reintentar;
}

// sin datos del activo o marco pedido: fuera el mapa anterior, para que no pase por el pedido
function lqVaciar() {
  Object.assign(lq, { datos: null, res: null, clave: "", resClave: "" });
  if (!lq.chart) return;
  lq.serie.setData([]); lq.hist.setData([]);
  for (const l of lq.lineas || []) lq.serie.removePriceLine(l);
  lq.lineas = [];
  $("lqIman").textContent = ""; $("lqRead").innerHTML = "";
  lq.heat.redraw(); lq.prof.redraw();
}
```

En `lqCargar`: `try { lqMontar(hit, k); } catch (e) { lqVaciar(); lqMensaje(e.message, true); }`.
En el `catch` de `lqTraer`, la rama sin copia:

```js
    if (hit) lqMensaje(`Could not refresh (${m}) Showing data from ${Math.round((Date.now() - hit.at) / 60000)} min ago.`);
    else { lqVaciar(); lqMensaje(m, true); }
```

Y `lqMontar(e, k)` dentro de `lqTraer` va en su propio `try`: si lanza (p. ej. «Not enough daily history»), `LQ_CACHE.delete(clave); lqVaciar(); lqMensaje(x.message, true); lqEstado(""); return;`.
Evento: `$("lqRetry").addEventListener("click", () => { lqMensaje(""); lqCargar(); });`.

- [ ] **Step 5: Comprobar**

Run: `node --check nube/worker.js; node --check web/liq.js; python -c "import liq_local"`
Expected: sin errores.

- [ ] **Step 6: Commit** (junto con la Task 4, porque los ids `lqMsgW` y `lqRetry` se crean allí).

### Task 4: Una fila de controles, Settings y pie del mapa

**Files:**
- Modify: `web/index.html` (panel `#lqPanel`), `web/liq.js` (`lqControles`, `lqClave`, `lqLectura`, eventos; fuera `lqGrande`, `lqMas`, `lq.extra`, `lqQuick`), `web/cripto.css` (estilos `lq-*`)

- [ ] **Step 1: HTML.** El interior de `#lqPanel` queda:

```html
      <div class="lq-bar">
        <span class="lq-asset-w"><input id="lqSym" class="lq-asset" list="lqList" autocomplete="off" spellcheck="false" aria-label="Asset" title="Type or pick any coin with perpetual futures"><datalist id="lqList"></datalist></span>
        <div class="seg boxed" role="radiogroup" aria-label="Candles" id="lqTf"><button role="radio" data-v="5m">5m</button><button role="radio" data-v="15m">15m</button><button role="radio" data-v="1h">1h</button><button role="radio" data-v="4h">4h</button><button role="radio" data-v="1D">1D</button></div>
        <span class="lq-acc">
          <details class="lq-drop" id="lqAjustes"><summary>Settings</summary>
            <div class="lq-pop">
              <div class="lq-row"><span class="lq-lab">Preset</span><div class="seg boxed" role="radiogroup" aria-label="Presets" id="lqPreset"><button role="radio" data-v="swing" title="Daily candles, 5x to 25x: positions that stay open for weeks">Swing</button><button role="radio" data-v="scalp" title="15-minute candles, 25x to 100x: levels close to the price">Scalp</button></div></div>
              <div class="lq-row"><span class="lq-lab">Leverage</span><div class="cx-chips" role="group" aria-label="Leverage" id="lqLev"></div></div>
              <label class="lq-row lq-ctl" title="Hide the weakest zones"><span class="lq-lab">Min. intensity</span><input type="range" id="lqMin" min="0" max="80" step="5"> <b id="lqMinV"></b></label>
              <div class="lq-row"><span class="lq-lab">Exchanges <b id="lqExN"></b></span><div class="cx-chips" role="group" aria-label="Exchanges" id="lqEx"></div></div>
            </div>
          </details>
          <button class="cx-exp" id="lqCopiar" title="Copy the map as an image (paste it with Ctrl+V)">Copy image</button>
          <button class="cx-exp" id="lqFull" title="Full screen">Full screen</button>
        </span>
      </div>
      <div class="lq-msg" id="lqMsgW" hidden><span id="lqMsg"></span> <button class="cx-exp" id="lqRetry" hidden>Retry</button></div>
      <div class="lq-wrap">
        <div class="lq-leg" id="lqLeg"></div>
        <div class="lq-chart" id="lqChart" role="img" aria-label="Liquidation map"></div>
        <div class="lq-tip" id="lqTip" hidden></div>
        <div class="lq-carga" id="lqCarga" hidden>Loading…</div>
      </div>
      <div class="lq-pie">
        <span class="lq-escala" id="lqEscala" title="Color scale: money that would be liquidated in each zone"><i id="lqEscalaBarra"></i><span id="lqEscalaTxt"></span></span>
        <p class="lq-iman" id="lqIman"></p>
      </div>
      <details class="lq-det"><summary>Details</summary>
        <p class="chart-caption" id="lqCap"></p>
        <div class="lq-read" id="lqRead"></div>
        <p class="lq-how" id="lqHow"></p>
      </details>
```

- [ ] **Step 2: JS, quitar lo que sobra.** Borrar: la línea de `$("lqQuick").innerHTML` en `lqControles`, `$("lqMas").hidden = ...`, el listener de `#lqQuick`, el de `#lqMas`, la función `lqGrande` con su listener y el de `keydown` de Esc del modal, la llamada `lqGrande(false)` en `#lqFull`, el campo `extra: 0` de `lq` y todos los `lq.extra = 0;` de los listeners. En `lqClave`: `const desde = cfg.desde || hasta - cfg.dias * 86400;`.

- [ ] **Step 3: JS, Settings.** Sustituir el listener que cerraba `#lqExDrop` por:

```js
// Settings se cierra al pulsar fuera o con Esc
document.addEventListener("click", (e) => { const d = $("lqAjustes"); if (d.open && !d.contains(e.target)) d.open = false; });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("lqAjustes").open = false; });
```

En `lqControles`, el texto de exchanges: `$("lqExN").textContent = activos === exs.length ? "(all)" : \`(${activos} of ${exs.length})\`;`. Al enfocar el activo se selecciona el texto para escribir encima: `$("lqSym").addEventListener("focus", (e) => e.target.select());`.

- [ ] **Step 4: JS, pie y Details en `lqLectura`.** La línea de imanes lleva el veredicto delante:

```js
  $("lqIman").innerHTML = `<b class="${cls}">${veredicto}</b>. Nearest liquidity: ${iman(g.arriba[0], "above")}, ${iman(g.abajo[0], "below")}.`;
```

Las tarjetas de `#lqRead` se quedan (van dentro de Details). `#lqCap` y `#lqHow` se rellenan igual que hoy.

- [ ] **Step 5: CSS** en `web/cripto.css`. Borrar las reglas de `.lq-bar2`, `.lq-cap`, `.lq-how summary`, `.lq-how[open]`, `.lq-drop[open] > .cx-chips`, `.lq-panel.lq-grande` (dos reglas y su media query) y, en la media query de 600px, `.lq-drop[open] > .cx-chips`. Añadir:

```css
.lq-asset-w { position: relative; display: inline-flex; }
.lq-asset-w::after { content: ""; position: absolute; right: 12px; top: 50%; border: 4px solid transparent; border-top-color: var(--muted); transform: translateY(-2px); pointer-events: none; }
.lq-asset { padding-right: 28px; }
.lq-drop > .lq-pop { display: none; }
.lq-drop[open] > .lq-pop { display: flex; flex-direction: column; gap: 10px; position: absolute; top: calc(100% + 6px); right: 0; z-index: 8;
  width: max-content; max-width: min(420px, 90vw); padding: 12px 14px; border-radius: 12px; background: var(--panel, var(--surface));
  border: 1px solid var(--line); box-shadow: 0 10px 30px rgba(0, 0, 0, .18); }
.lq-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.lq-row .lq-lab { min-width: 92px; }
.lq-row .cx-chips { margin: 0; }
.lq-msg { display: flex; align-items: center; gap: 10px; margin: 0 2px 8px; font-size: 12.5px; color: var(--amber); }
.lq-msg[hidden] { display: none; }
.lq-pie { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 18px; margin: 10px 2px 0; }
.lq-pie .lq-iman { margin: 0; flex: 1; min-width: 260px; text-align: right; }
.lq-iman b.pos { color: var(--put); } .lq-iman b.neg { color: var(--call); }
.lq-det { margin: 10px 2px 0; }
.lq-det summary { cursor: pointer; font-size: 12.5px; font-weight: 500; color: var(--muted); list-style: none; }
.lq-det summary::-webkit-details-marker { display: none; }
.lq-det summary::before { content: "+"; display: inline-block; width: 16px; color: var(--faint); }
.lq-det[open] summary::before { content: "−"; }
.lq-how { margin: 8px 0 0; max-width: 900px; font-size: 12.5px; line-height: 1.5; color: var(--muted); }
@media (max-width: 600px) { .lq-pie .lq-iman { text-align: left; } }
```

Cambiar la regla de pantalla completa del gráfico a `calc(100vh - 200px)` (hay menos controles).

- [ ] **Step 6: Comprobar**

Run: `node --check web/liq.js; node --test pruebas/test_liq.mjs`; después `grep -n "lqQuick\|lqMas\|lqGrande\|lqExDrop\|lq.extra\|lqMin4" web/liq.js web/index.html web/cripto.css`
Expected: check sin salida, PASS y el grep sin resultados.

- [ ] **Step 7: Commit**

```bash
git add web/liq.js web/index.html web/cripto.css nube/worker.js liq_local.py
git commit -m "Mapa de liquidaciones: una fila de controles con Settings, pie con leyenda y veredicto, errores de carga claros"
```

### Task 5: Crypto, tira de resumen y lectura en Overview

**Files:**
- Modify: `web/index.html` (`#cryptoView`), `web/cripto.js` (`cxSide`), `web/cripto.css` (cabecera y reglas `.cx-side`)

- [ ] **Step 1: HTML.** Sustituir `<aside class="cx-side">…</aside>` por la tira y, como primer hijo de `<section class="cx-main">` tras `#cxTabs`, el panel de lectura:

```html
  <div class="cx-strip" id="cxStrip">
    <div class="seg boxed" role="radiogroup" aria-label="Asset" id="cxSym"><button role="radio" data-v="BTC" aria-checked="true">BTC</button><button role="radio" data-v="ETH" aria-checked="false">ETH</button></div>
    <span class="cx-pname" id="cxTitle">—</span><span class="cx-pval" id="cxPrice">—</span>
    <span class="cx-chg" id="cxSub"></span>
    <span class="mstate cx-state" id="cxState">—</span>
    <span class="cx-skpis" id="cxStripKpis"></span>
    <span class="cx-upd" id="cxUpd"></span>
    <span class="cx-err" id="cxErr" hidden></span>
  </div>
```

```html
    <div class="cx-panel cx-wide cx-reading" data-tabs="overview">
      <div class="cx-axes" id="cxAxes"></div>
      <div class="cx-rgrid">
        <div class="cx-read" id="cxRead"></div>
        <div><div class="cx-kpis" id="cxKpis"></div><button class="cx-siglink" id="cxSigLink" hidden></button></div>
      </div>
      <details class="cx-more"><summary>All numbers</summary><div class="facts" id="cxFacts"></div></details>
      <details class="cx-more"><summary>How to read this page</summary><p class="mnote cx-note">(el mismo texto de hoy, sin cambios)</p></details>
    </div>
```

(El párrafo de «How to read this page» se mueve tal cual desde el `aside`.)

- [ ] **Step 2: JS (`cxSide` en `web/cripto.js`).** Renombrar a `cxResumen` (y su llamada en `renderCrypto`). Cambios:

```js
  $("cxSub").innerHTML = `<b class="${up(a.chg24)}">${cxPct(a.chg24, 2)}</b> 24h` +
    (a.viejo ? ` <span class="cx-old">Data from ${esc(new Date(a.viejo).toLocaleString("en-US"))}: the last update failed</span>` : "");
  $("cxSub").title = `${cxPct(a.chg7, 1)} in 7 days, ${cxPct(a.chg30, 1)} in 30 days`;
```

`st.className = "mstate cx-state " + (...)` (mismo cálculo de tono). Tras calcular `g`, `oc`, `v`, `fng`:

```js
  // tira: cuatro cifras que se ven en todas las pestanas
  const sk = (l, val, cls = "") => `<span class="cx-sk">${l} <b class="${cls}">${val}</b></span>`;
  $("cxStripKpis").innerHTML = [
    sk("Net GEX", fmtBig(g.total, true), up(g.total)),
    oc ? sk("MVRV", fmtNum(oc.mvrv, 2)) : "",
    v.dvol != null ? sk("DVOL", fmtNum(v.dvol, 1)) : "",
    fng ? sk("Fear & Greed", String(fng.valor), fng.valor <= 25 ? "neg" : fng.valor >= 75 ? "pos" : "") : "",
  ].join("");
```

Mover la declaración de `fng` y `g` antes de este bloque si hace falta. El resto (`cxAxes`, `cxRead`, `cxKpis`, `cxSigLink`, `cxFacts`, `cxErr`) no cambia.

- [ ] **Step 3: CSS.** En `web/cripto.css`: comentario de cabecera «tira de resumen arriba, paneles debajo»; `#cryptoView { display: flex; flex-direction: column; gap: 14px; padding-bottom: 24px; }`; el selector `.cx-side, .cx-panel` y el de sombra clara pasan a `.cx-strip, .cx-panel`; borrar `.cx-side {…}`, `.cx-side > *`, `.cx-top`, `.cx-price`, `.cx-side .mstate` y, en la media query de 900px, `#cryptoView {…}` y `.cx-side {…}`. Añadir:

```css
.cx-strip { position: sticky; top: 62px; z-index: 6; display: flex; align-items: center; flex-wrap: wrap; gap: 6px 18px; padding: 10px 18px; }
.cx-strip .cx-pval { font-size: 20px; }
.cx-strip .cx-chg { margin: 0; font-size: 12.5px; }
.cx-strip .cx-state { font-size: 14px; line-height: 1.3; margin: 0; }
.cx-skpis { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12.5px; color: var(--faint); }
.cx-sk b { font-weight: 600; color: var(--text); font-variant-numeric: tabular-nums; }
.cx-sk b.pos { color: var(--put); } .cx-sk b.neg { color: var(--call); }
.cx-strip .cx-upd { margin-left: auto; }
.cx-strip .cx-err { margin: 0; flex-basis: 100%; }
.cx-reading { padding: 16px 20px; }
.cx-rgrid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 380px); gap: 18px; align-items: start; }
.cx-reading .cx-kpis { margin-top: 14px; }
@media (max-width: 900px) { .cx-strip { position: static; } .cx-rgrid { grid-template-columns: 1fr; } .cx-strip .cx-upd { margin-left: 0; } }
```

(`.cx-panel` ya tiene su padding; si `.cx-reading` hereda uno, quitar esa línea.)

- [ ] **Step 4: Comprobar**

Run: `node --check web/cripto.js; grep -n "cx-side\|cxSide" web/*.js web/*.css web/index.html`
Expected: sin salida del check y el grep sin resultados.

- [ ] **Step 5: Commit**

```bash
git add web/index.html web/cripto.js web/cripto.css
git commit -m "Crypto: tira de resumen arriba y lectura completa en Overview"
```

### Task 6: Ajuste con datos y revisión visual

**Files:**
- Modify (si hace falta): `web/liq.js` (`LQ_VIDA_MIN`, valor por defecto de `lq.min`)

- [ ] **Step 1:** Arrancar el modo PC con `preview_start` (`gexlab-py`, puerto 8765; sin clave, datos públicos de Binance) e iniciar sesión si lo pide.
- [ ] **Step 2:** En Crypto > Liquidations, para BTC y ETH en 1D y 15m, contar las zonas de la última vela con:

```js
const r = lq.res, t = r.n - 1, u = (lq.min / 100) * r.topeV; let z = 0, dentro = false;
for (let b = 0; b < r.B; b++) { const s = r.gZ[b * r.n + t] > u; if (s && !dentro) z++; dentro = s; } z
```

Objetivo: de 10 a 20. Si salen más, subir `lq.min` por defecto (de 5 en 5) o `LQ_VIDA_MIN`; si menos, bajarlos. Cambiar a la vez la clave (`lqMin5` → `lqMin6`) si cambia el valor por defecto después de publicado.
- [ ] **Step 3:** Capturas en tema oscuro y claro y en móvil (`resize_window` 375×812): tira, Overview, Liquidations con Settings abierto y Details abierto. Consola sin errores.
- [ ] **Step 4:** Commit de los ajustes si los hay (`git add web/liq.js`).

### Task 7: Documentación, CHANGELOG y push

**Files:**
- Modify: `docs/CRIPTO.md` (sección del mapa y de la página), `CHANGELOG.md` (entrada 2026-11-23), `CLAUDE.md` solo si cambia algo del mapa de archivos (no debería)

- [ ] **Step 1:** `docs/CRIPTO.md`: rejilla `gZ` (zona ±0,4 %, `rZ`, sumas por prefijos), `vidaMin` (6 velas), `topeV` desde `gZ`, `ahora` lee `gZ`; controles (una fila, Settings, sin Older ni Expand); errores (solo listas en caché, Retry); página con tira y lectura en Overview.
- [ ] **Step 2:** `CHANGELOG.md`, entrada nueva arriba: `## 2026-11-23 — Crypto más limpio: tira de resumen arriba, mapa de liquidaciones por zonas y una fila de controles`, con **Cambiado** (tira, lectura en Overview, zonas, controles, intensidad mínima por defecto) y **Corregido** («oi is not iterable» y el mapa que se quedaba con el activo anterior al fallar). Si otra sesión ya abrió la entrada del día, ampliarla.
- [ ] **Step 3:** Pruebas finales: `node --test pruebas/test_liq.mjs`, `node --check` de `web/liq.js`, `web/liq-modelo.js`, `web/cripto.js`, `nube/worker.js`.
- [ ] **Step 4:** Commit y push:

```bash
git add docs/CRIPTO.md CHANGELOG.md docs/superpowers/plans/2026-11-23-crypto-restyle.md
git commit -m "Crypto y mapa de liquidaciones: documentacion y CHANGELOG del restyle"
git push origin main
```

- [ ] **Step 5:** Esperar a `Desplegar` (`gh api "repos/LoppVicious/gexlab/actions/runs?head_sha=<sha>"`) y, si producción responde, comprobar BTC y ETH en 1D allí.
