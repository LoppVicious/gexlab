"use strict";
/* ============================================================ Mapa de liquidaciones (Crypto > Liquidations)
   Datos: /api/liq_markets (activos con perpetuos, pub/liq_mercados.json de cripto.py) y /api/liq (velas, OI y
   liquidaciones reales de Coinalyze por el Worker, que pone la clave; en el PC, liq_local.py). El modelo esta en
   web/liq-modelo.js (LQ_MODELO); aqui se pide, se calcula y se dibuja sobre Lightweight Charts (como la Trading
   Window): el calor es una capa propia debajo de las velas, el perfil de lo pendiente va pegado a la derecha y las
   liquidaciones reales en un panel debajo. Nombres con prefijo lq: los globales se comparten entre scripts. */

const LQ_LIB = "https://cdn.jsdelivr.net/npm/lightweight-charts@5.2.1/dist/lightweight-charts.standalone.production.js";
// marcos: intervalo de Coinalyze, segundos por vela, historia que se pide, vida media de una posicion (velas), cuantas
// velas se ven al abrir (como mapaliquidaciones.com: un dia en 5 min, una semana en 1 h, meses en diario) y que
// fraccion del rango de cada vela reparte sus niveles (am: en diario, menos, que una vela abarca mucho). suave: en el
// diseno Heatmap, desviacion (fraccion del precio) de un difuminado vertical leve: suaviza las rayas sin borrarlas
const LQ_TF = {
  "5m": { iv: "5min", s: 300, dias: 7, vida: 144, ver: 288, am: 0.6, nombre: "5 minutes", suave: 0.0005 },
  "15m": { iv: "15min", s: 900, dias: 20, vida: 96, ver: 288, am: 0.6, nombre: "15 minutes", suave: 0.0008 },
  "1h": { iv: "1hour", s: 3600, dias: 80, vida: 96, ver: 168, am: 0.6, nombre: "1 hour", suave: 0.0015 },
  "4h": { iv: "4hour", s: 14400, dias: 330, vida: 90, ver: 180, am: 0.3, nombre: "4 hours", suave: 0.003 },
  "1D": { iv: "daily", s: 86400, desde: 1567296000, vida: 45, ver: 240, am: 0.15, nombre: "daily", suave: 0.006 },
};
const LQ_BANDA = 2;   // alto en pixeles de cada fila del mapa y del perfil
const LQ_VIDA_MIN = 6;   // velas: un nivel que el precio toca antes no se pinta
// atajos: marco y apalancamientos de cada forma de operar
const LQ_PRESET = {
  swing: { tf: "1D", levOff: ["50", "100"] },   // posiciones que aguantan semanas: niveles lejos del precio
  scalp: { tf: "15m", levOff: ["5", "10"] },    // alto apalancamiento: niveles pegados al precio
};
const lq = {
  merc: null, sym: store.get("lqSym", "BTC"), tf: store.get("lqTf", "1D"),
  exOff: new Set(String(store.get("lqExOff", "")).split(",").filter(Boolean)),
  levOff: new Set(String(store.get("lqLevOff3", "")).split(",").filter(Boolean)),
  min: +store.get("lqMin6", 10), zonas: +store.get("lqZonas", 70), vida: "1", dis: store.get("lqDis", "heat") === "clasico" ? "clasico" : "heat",
  datos: null, clave: "", at: 0, res: null, resClave: "", img: null, imgClave: "",
  chart: null, serie: null, heat: null, prof: null, ctrl: null, error: "", rsi: null,
};
// diseno: "clasico" (escalones de color y perfil a la derecha) o "heat" (paleta continua, bandas que siguen hacia el
// futuro, sin perfil, maximo y minimo de la vista marcados y RSI debajo; colores en C.liqH)
const lqHeat = () => lq.dis === "heat";

function lqLib() {
  if (window.LightweightCharts) return Promise.resolve();
  if (typeof twLoadLib === "function") return twLoadLib();
  return new Promise((ok, ko) => {
    const s = document.createElement("script");
    s.src = LQ_LIB; s.async = true; s.onload = ok; s.onerror = () => ko(new Error("Could not load the chart library"));
    document.head.appendChild(s);
  });
}

const lqUsd = (v) => (v == null ? "—" : fmtBig(v, true));
const lqDec = (p) => (p >= 1000 ? 0 : p >= 10 ? 2 : p >= 0.1 ? 4 : 6);
const lqPx = (p) => (p == null ? "—" : "$" + fmtNum(p, lqDec(p)));
const lqActivo = () => (lq.merc ? lq.merc.activos.find((a) => a.sym === lq.sym) : null);

/* ---------- entrada: la llama renderCrypto cuando la pestana esta visible */
async function lqShow() {
  try {
    if (!lq.merc) {
      const r = await fetch("/api/liq_markets");
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Could not load the list of assets");
      lq.merc = d;
      if (!lqActivo()) lq.sym = (d.activos[0] || {}).sym || "BTC";
      lqControles();
    }
    await lqLib();
    if (!lq.chart) lqChart();
    lqTema();
    await lqCargar();
  } catch (e) {
    lqMensaje(e.message);
  }
}

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
  lq.serie.setData([]);
  for (const l of lq.lineas || []) lq.serie.removePriceLine(l);
  lq.lineas = []; lq.extremos = null;
  $("lqIman").textContent = ""; $("lqRead").innerHTML = "";
  lq.heat.redraw(); lq.prof.redraw();
}

/* ---------- controles */
function lqControles() {
  const ms = lq.merc.activos;
  $("lqList").innerHTML = ms.map((a) => `<option value="${esc(a.sym)}">${esc(a.nombre)}</option>`).join("");
  $("lqSym").value = lq.sym;
  document.querySelectorAll("#lqTf button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === lq.tf)));
  document.querySelectorAll("#lqDis button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === lq.dis)));
  const a = lqActivo(), ex = lq.merc.exchanges || {};
  const exs = Object.keys(ex).filter((e) => a && a.ex[e]), activos = exs.filter((e) => !lq.exOff.has(e)).length;
  $("lqEx").innerHTML = exs.map((e) => `<button role="checkbox" data-v="${e}" aria-checked="${!lq.exOff.has(e)}">${esc(ex[e])}</button>`).join("");
  $("lqExN").textContent = activos === exs.length ? "(all)" : `(${activos} of ${exs.length})`;
  const off = [...lq.levOff].sort().join(",");
  document.querySelectorAll("#lqPreset button").forEach((b) => {
    const x = LQ_PRESET[b.dataset.v];
    b.setAttribute("aria-checked", String(x.tf === lq.tf && [...x.levOff].sort().join(",") === off));
  });
  $("lqLev").innerHTML = LQ_MODELO.APAL.map((x) => `<button role="checkbox" data-v="${x.L}" aria-checked="${!lq.levOff.has(String(x.L))}" title="Weight ${Math.round(x.w * 100)}%">${x.L}x</button>`).join("");
  // el deslizador: en Classic, intensidad minima (fraccion del mas cargado); en Heatmap, zonas que se ven (percentil)
  const h = lqHeat(), sl = $("lqMin");
  Object.assign(sl, h ? { min: 10, max: 100, step: 5 } : { min: 0, max: 80, step: 5 });
  sl.value = h ? lq.zonas : lq.min; $("lqMinV").textContent = (h ? lq.zonas : lq.min) + "%";
  $("lqMinLab").textContent = h ? "Zones shown" : "Min. intensity";
  sl.parentElement.title = h ? "Share of the loaded zones in view that are painted: lower hides the weakest" : "Hide the weakest zones";
}

function lqSet(cambio) {
  Object.assign(lq, cambio);
  if (cambio.sym && typeof cxTiraLiq === "function") cxTiraLiq();   // la tira de Crypto sigue al activo
  store.set("lqSym", lq.sym); store.set("lqTf", lq.tf); store.set("lqMin6", lq.min);
  store.set("lqExOff", [...lq.exOff].join(",")); store.set("lqLevOff3", [...lq.levOff].join(","));
  lqControles();
  lqCargar();
}

/* ---------- datos
   Coinalyze cuenta cada simbolo como una llamada y admite 40 por minuto por clave. Por eso: solo los perpetuos
   principales de cada exchange, cache en el navegador por activo y marco (volver a uno visto es inmediato), y ante el
   limite (429) se espera lo que pide la fuente y se reintenta, sin error. */
const LQ_CACHE = new Map();   // clave -> { at, ohlcv, oi, liq }
const LQ_CACHE_MAX = 24;
const LQ_TTL = { "5m": 60, "15m": 120, "1h": 300, "4h": 900, "1D": 1800 };   // segundos: los del Worker

// un perpetuo por exchange, el de mas OI: en USDT si lo hay, si no el inverso en USD (USDC, USD1 y similares apenas
// suman). Con el cupo compartido entre usuarios, cada simbolo de mas resta cargas por minuto.
function lqSimbolos(a, e) {
  const xs = a.ex[e] || [];
  const s = xs.find((x) => /USDT(_PERP)?\.[A-Z0-9]$/.test(x)) || xs.find((x) => /USD(_PERP)?\.[A-Z0-9]$/.test(x)) || xs[0];
  return s ? [s] : [];
}

function lqEstado(t) {
  $("lqCarga").textContent = t || "";
  $("lqCarga").hidden = !t;
}

// espera abortable; con aviso, cuenta atras en la capa de carga
function lqEsperar(s, signal, aviso) {
  const fin = Date.now() + s * 1000;
  return new Promise((ok, ko) => {
    const tick = () => {
      if (signal.aborted) { clearInterval(iv); ko(new DOMException("Aborted", "AbortError")); return; }
      const q = Math.ceil((fin - Date.now()) / 1000);
      if (aviso) lqEstado(`Data source limit reached, retrying in ${Math.max(q, 0)} s…`);
      if (q <= 0) { clearInterval(iv); ok(); }
    };
    const iv = setInterval(tick, 500);
    tick();
  });
}

async function lqPedir(kind, symbols, cfg, desde, hasta, signal, aviso = true) {
  const q = new URLSearchParams({ kind, interval: cfg.iv, symbols: symbols.join(","), from: desde, to: hasta });
  for (let intento = 0; ; intento++) {
    const r = await fetch(`/api/liq?${q}`, { signal });
    const d = await r.json().catch(() => ({}));
    if (r.ok) {
      if (!Array.isArray(d)) throw new Error("The data source sent an unexpected answer.");
      return d;
    }
    if (r.status !== 429 || intento >= 3) throw new Error(d.error || `The data source answered ${r.status}`);
    await lqEsperar(Math.min(+d.retry || +r.headers.get("Retry-After") || 20, 65) + 1, signal, aviso);
    if (aviso) lqEstado("Loading…");
  }
}

function lqClave() {
  const a = lqActivo(), cfg = LQ_TF[lq.tf];
  const syms = Object.keys(a.ex).filter((e) => !lq.exOff.has(e)).flatMap((e) => lqSimbolos(a, e));
  const hasta = Math.ceil(Date.now() / 1000 / cfg.s) * cfg.s;
  const desde = cfg.desde || hasta - cfg.dias * 86400;
  return { a, cfg, syms, desde, hasta, clave: [a.sym, lq.tf, syms.join(","), desde].join("|") };
}

// pinta al momento lo que haya en cache y, si no esta al dia, lo pide (con una pausa corta: los clics seguidos no
// gastan cupo)
function lqCargar() {
  if (!lqActivo() || !lq.chart) return;
  const k = lqClave(), hit = LQ_CACHE.get(k.clave);
  lqMensaje("");
  if (hit && k.clave !== lq.clave) {
    try { lqMontar(hit, k); } catch (e) { lqVaciar(); lqMensaje(e.message, true); }
  } else if (k.clave === lq.clave && lq.datos) lqCalcular();
  clearTimeout(lq.tCarga);
  if (k.clave === lq.enCurso) return;   // ya en camino: no se repite
  if (lq.ctrl && lq.enCurso) { lq.ctrl.abort(); lq.enCurso = ""; }
  if (hit && Date.now() - hit.at < LQ_TTL[lq.tf] * 1000) { lqEstado(""); return; }
  lqEstado(hit ? "" : "Loading…");
  lq.tCarga = setTimeout(() => lqTraer(k, hit), hit ? 0 : 200);
}

async function lqTraer(k, hit) {
  const { a, cfg, syms, desde, hasta, clave } = k;
  if (lq.ctrl) lq.ctrl.abort();
  lq.enCurso = clave;
  const ctrl = (lq.ctrl = new AbortController());
  try {
    const [ohlcv, oi] = await Promise.all([
      lqPedir("ohlcv", [a.velas], cfg, desde, hasta, ctrl.signal, !hit),
      syms.length ? lqPedir("oi", syms, cfg, desde, hasta, ctrl.signal, !hit) : [],
    ]);
    const e = { at: Date.now(), ohlcv, oi, liq: hit && hit.liq && !hit.liq.error ? hit.liq : null };
    LQ_CACHE.delete(clave); LQ_CACHE.set(clave, e);
    while (LQ_CACHE.size > LQ_CACHE_MAX) LQ_CACHE.delete(LQ_CACHE.keys().next().value);
    try { lqMontar(e, k); } catch (x) {
      LQ_CACHE.delete(clave); lqVaciar(); lqMensaje(x.message, true); lqEstado("");
      return;
    }
    lqEstado("");
    if (lq.enCurso === clave) lq.enCurso = "";
    // liquidaciones reales despues del mapa: no lo retrasan, si la fuente esta al limite se esperan en silencio y no
    // se cancelan al cambiar de activo (el cupo ya esta gastado; quedan en la cache para cuando se vuelva)
    if (!syms.length) return;
    try { e.liq = await lqPedir("liq", syms, cfg, desde, hasta, new AbortController().signal, false); }
    catch (x) { if (!e.liq) e.liq = { error: x.message }; }
    if (lq.clave === clave && LQ_CACHE.get(clave) === e) { lqReales(e.liq); lqSeries(false); lqLectura(); }
  } catch (x) {
    if (x.name === "AbortError") return;
    const m = x.message === "Failed to fetch" ? "The server is not responding." : x.message;
    if (hit) lqMensaje(`Could not refresh (${m}) Showing data from ${Math.round((Date.now() - hit.at) / 60000)} min ago.`);
    else { lqVaciar(); lqMensaje(m, true); }
    lqEstado("");
  } finally {
    if (lq.enCurso === clave) lq.enCurso = "";
  }
}

// de las respuestas (velas, OI y liquidaciones reales) a lq.datos, y dibujo
function lqMontar(e, k) {
  const { a, cfg, clave } = k, ohlcv = e.ohlcv, oi = e.oi;
  const velas = ((ohlcv[0] || {}).history || []).filter((v) => v.h > 0 && v.l > 0).sort((p, q) => p.t - q.t);
  if (velas.length < 20) throw new Error(`Not enough ${cfg.nombre} history for ${a.sym}`);
  // OI: se suma el cambio de cada simbolo (no el nivel), para que un exchange que empieza tarde no cree un salto
  const ts = velas.map((v) => v.t), dOI = new Array(ts.length).fill(null), nivel = new Array(ts.length).fill(0);
  const conOI = [];
  for (const s of oi) {
    const m = new Map((s.history || []).map((p) => [p.t, p.c]));
    if (m.size) conOI.push(s.symbol);
    for (let i = 0; i < ts.length; i++) {
      const x = m.get(ts[i]), y = i > 0 ? m.get(ts[i - 1]) : null;
      if (x != null) nivel[i] += x;   // OI total de la vela: para la fraccion que se cierra
      if (x != null && y != null) dOI[i] = (dOI[i] || 0) + (x - y);
    }
  }
  const oiCum = new Array(ts.length).fill(null);
  let acc = null;
  for (let i = 0; i < ts.length; i++) {
    if (dOI[i] != null) { acc = (acc ?? 0) + dOI[i]; if (oiCum[i - 1] == null && i > 0) oiCum[i - 1] = acc - dOI[i]; }
    oiCum[i] = acc;
  }
  const exs = Object.keys(a.ex).filter((x) => !lq.exOff.has(x));
  lq.datos = { velas, oi: oiCum, nivel, conOI, exs, sym: a.sym, tf: lq.tf };
  if (typeof cxTiraLiq === "function") cxTiraLiq();   // precio de la tira con las velas nuevas
  lqReales(e.liq);
  lq.clave = clave; lq.resClave = "";
  lqCalcular(true);
}

// liquidaciones reales por vela (suma de los perpetuos elegidos); si la peticion fallo, quedan sin dato y se avisa
function lqReales(liq) {
  const d = lq.datos, ts = d.velas.map((v) => v.t);
  d.liqPend = !liq;   // aun en camino
  d.liqError = liq && liq.error ? liq.error : "";
  const lista = !liq || d.liqError ? [] : liq;
  const L = LQ_MODELO.sumar(lista, "l"), S = LQ_MODELO.sumar(lista, "s");
  const t0 = Math.min(...[...L.keys(), ...S.keys(), Infinity]);
  d.realL = ts.map((t) => (t >= t0 ? L.get(t) || 0 : null)); d.realS = ts.map((t) => (t >= t0 ? S.get(t) || 0 : null));
}

/* ---------- modelo y dibujo */
// Heatmap: en vez de 5 apalancamientos, muchos (de 3x a 125x, repartidos en log): cada posicion deja una banda gruesa
// hecha de rayas finas con su parte mas cargada en el centro, no cinco rayas sueltas. Cada uno hereda el peso del
// apalancamiento de APAL mas cercano (en log), a partes iguales entre los que le tocan, y se oculta con su boton
const lqGrupo = (L) => LQ_MODELO.APAL.reduce((a, x) => (Math.abs(Math.log(x.L / L)) < Math.abs(Math.log(a.L / L)) ? x : a)).L;
const LQ_DENSO = (() => {
  const Ls = [];
  for (let k = 0; k < 28; k++) { const L = Math.round(3 * Math.pow(125 / 3, k / 27)); if (!Ls.includes(L)) Ls.push(L); }
  const cuantos = new Map();
  for (const L of Ls) cuantos.set(lqGrupo(L), (cuantos.get(lqGrupo(L)) || 0) + 1);
  return Ls.map((L) => ({ L, w: LQ_MODELO.APAL.find((x) => x.L === lqGrupo(L)).w / cuantos.get(lqGrupo(L)) }));
})();

function lqCalcular(nuevos = false) {
  const d = lq.datos;
  if (!d) return;
  const cfg = LQ_TF[d.tf], h = lqHeat();
  // ocultar un apalancamiento solo quita sus franjas: el reparto y los colores siguen calculados con todos
  const ver = (h ? LQ_DENSO : LQ_MODELO.APAL).map((x) => x.L).filter((L) => !lq.levOff.has(String(lqGrupo(L))));
  const clave = [lq.clave, ver.join(","), lq.vida, lq.dis].join("|");
  if (clave !== lq.resClave) {
    lq.res = LQ_MODELO.calcular(d.velas, d.oi, { ver, levs: h ? LQ_DENSO : undefined, vida: cfg.vida * +lq.vida,
      bins: h ? 1000 : 600, nivel: d.nivel,
      anchoMapa: cfg.am, vidaMin: LQ_VIDA_MIN, lado: 0.5,
      escalaDesde: d.velas.length - cfg.ver });   // colores frente a lo que se ve al abrir, no a toda la historia
    lq.resClave = clave; lq.imgClave = "";
  }
  if (!lq.res) { lqMensaje("Choose at least one leverage."); return; }
  lqSeries(nuevos);
  lqImagen();
  lqLectura();
  lq.heat.redraw();
}

function lqSeries(nuevos) {
  const d = lq.datos, p = d.velas[d.velas.length - 1].c, dec = lqDec(p);
  lq.serie.applyOptions({ priceFormat: { type: "price", precision: dec, minMove: 1 / 10 ** dec } });
  lq.serie.setData(d.velas.map((v) => ({ time: v.t, open: v.o, high: v.h, low: v.l, close: v.c })));
  lq.chart.applyOptions({ timeScale: { timeVisible: d.tf !== "1D", secondsVisible: false } });
  lqRsiSerie();
  if (nuevos) lqVista();
}

// vista inicial: las ultimas velas del marco y, a la derecha, sitio para el perfil. Con el ancho ya maquetado (el
// siguiente fotograma: al abrir la pestana el grafico aun no tiene su tamano)
function lqVista() {
  requestAnimationFrame(() => {
    const d = lq.datos;
    if (!d) return;
    // Heatmap: casi un tercio del ancho para las bandas que siguen hacia el futuro
    const n = d.velas.length, ancho = lq.chart.timeScale().width() || 800, W = lqHeat() ? Math.round(ancho * 0.3) : lqAnchoPerfil(ancho) + 20;
    // en pantallas estrechas, menos velas (la libreria no las junta a menos de medio pixel); margen en velas que deja
    // el ancho del perfil (mas un respiro) despues de la ultima vela
    const ver = Math.min(n, LQ_TF[d.tf].ver, Math.floor((ancho - W) / 0.6)), margen = Math.ceil((ver * W) / Math.max(1, ancho - W));
    lq.chart.timeScale().setVisibleLogicalRange({ from: n - ver, to: n + margen });
    // si se habia arrastrado o ampliado el eje de precios, la libreria apaga el ajuste automatico y el eje se quedaba
    // en los precios del activo anterior: con datos nuevos vuelve a ajustarse
    lq.serie.priceScale().applyOptions({ autoScale: true });
  });
}

// ancho en pixeles del perfil de la derecha (lo usa tambien el margen de la vista)
const lqAnchoPerfil = (ancho) => Math.round(Math.min(170, Math.max(60, ancho * 0.14)));

// paleta por escalones, como mapaliquidaciones.com (colores del tema, C.liq): morado algo mas claro que el fondo para lo
// flojo, azul marino, azul, verde, amarillo y rojo. La posicion es la fraccion del mas cargado de la vista
function lqHex(c) { const n = parseInt(String(c).slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function lqPaleta() {
  const e = C.liq.escalones;
  return [0, 0.25, 0.4, 0.56, 0.75, 0.92].map((x, j) => [x, lqHex(e[j])]);
}
// Heatmap: tabla de 256 colores interpolados entre las paradas de C.liqH.paleta
function lqTabla() {
  const st = C.liqH.paleta.map(([x, c]) => [x, lqHex(c)]), t = [];
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    let j = 0;
    while (j < st.length - 2 && x > st[j + 1][0]) j++;
    const [x0, a] = st[j], [x1, b] = st[j + 1], f = Math.min(1, Math.max(0, (x - x0) / (x1 - x0 || 1)));
    t.push(a.map((v, k) => Math.round(v + (b[k] - v) * f)));
  }
  return t;
}
// Heatmap: curva de la fraccion antes de la paleta (por encima de 1, casi todo queda morado y solo lo muy cargado se
// enciende, como en la referencia)
const LQ_CURVA = 1.15;
// color de una fraccion (0-1) del mas cargado: su escalon o, en Heatmap, su punto de la paleta continua (con LQ_CURVA)
const lqColor = (x) => {
  if (lqHeat()) return lq.tabla[Math.min(255, Math.max(0, Math.round(Math.pow(x, LQ_CURVA) * 255)))];
  const e = lq.escalones; let j = 0; while (j < e.length - 1 && x >= e[j + 1][0]) j++; return e[j][1];
};

// paleta y rejilla de precios: se rehacen al cambiar el calculo, la intensidad minima o el tema. El dibujo (y la
// escala de color, frente a lo que se ve) se hace en lqPintar, con la vista de cada momento
function lqImagen() {
  if (!lq.res) return;
  const r = lq.res, clave = [lq.resClave, lq.min, lq.zonas, document.documentElement.dataset.theme, lq.dis].join("|");
  if (clave === lq.imgClave) return;
  const B = r.B;
  lq.escalones = lqPaleta(); lq.tabla = lqTabla();
  lq.lLo = Math.log(r.bordes[0]); lq.paso = (Math.log(r.bordes[B]) - lq.lLo) / B;
  lq.imgClave = clave; lq.pintado = null; lq.mxEscala = null;
  lqEscala();
}

// leyenda: los cinco escalones y, en dolares, desde donde empieza el rojo en la vista
function lqEscala() {
  if (!lq.escalones) return;
  const e = lq.escalones, rgb = (c) => `rgb(${c.join(",")})`, mx = lq.mxVista || 0;
  if (lqHeat()) {
    $("lqEscalaBarra").style.background = `linear-gradient(90deg, ${C.liqH.paleta.map(([x, c]) => `${c} ${Math.round(Math.pow(x, 1 / LQ_CURVA) * 100)}%`).join(", ")})`;
    $("lqEscalaTxt").textContent = mx > 0 ? `Least to most loaded in view (yellow: ${lqUsd(mx)}+)` : "Least to most loaded in view";
    return;
  }
  const w = 100 / e.length;
  $("lqEscalaBarra").style.background = `linear-gradient(90deg, ${e.map((x, j) => `${rgb(x[1])} ${j * w}% ${(j + 1) * w}%`).join(", ")})`;
  $("lqEscalaTxt").textContent = mx > 0 ? `Least to most loaded in view (red: ${lqUsd(mx * e[e.length - 1][0])}+)` : "Least to most loaded in view";
}

// tramos de precio (de menor a mayor) que caen entre dos filas de pantalla
function lqTramosEntre(serie, yArriba, yAbajo) {
  const pA = serie.coordinateToPrice(yArriba), pB = serie.coordinateToPrice(yAbajo);
  if (!(pA > 0) || !(pB > 0)) return null;
  const B = lq.res.B, hi = Math.floor((Math.log(pA) - lq.lLo) / lq.paso), lo = Math.floor((Math.log(pB) - lq.lLo) / lq.paso);
  if (hi < 0 || lo >= B) return null;
  return [Math.max(0, Math.min(lo, hi)), Math.min(B - 1, Math.max(lo, hi))];
}

// mapa de la vista: filas de LQ_BANDA pixeles con el tramo mas cargado de cada una (r.gZ) y una columna por vela
// visible (o por pixel si hay mas velas que pixeles). Como en mapaliquidaciones.com, el color es relativo a lo que se
// ve: el mas cargado de la vista es rojo y cada casilla toma el escalon de su fraccion; la intensidad minima, igual
function lqPintar(serie, ancho, alto, c0, c1) {
  const r = lq.res, n = r.n, cols = c1 - c0 + 1;
  const pTop = serie.coordinateToPrice(0), pBot = serie.coordinateToPrice(alto);
  const clave = [lq.imgClave, c0, c1, Math.round(ancho), Math.round(alto), pTop, pBot].join("|");
  if (lq.pintado && lq.pintado.clave === clave) return lq.pintado;
  const outW = Math.max(1, Math.min(cols, Math.ceil(ancho))), outH = Math.max(1, Math.ceil(alto));
  const nb = Math.ceil(outH / LQ_BANDA), g = r.gZ;
  const colDe = new Int32Array(outW);
  for (let k = 0; k < outW; k++) colDe[k] = Math.min(n - 1, c0 + Math.floor(((k + 0.5) * cols) / outW));
  const val = new Float64Array(nb * outW);
  let mx = 0;
  for (let f = 0; f < nb; f++) {
    const tr = lqTramosEntre(serie, f * LQ_BANDA, (f + 1) * LQ_BANDA);
    if (!tr) continue;
    for (let k = 0; k < outW; k++) {
      const t = colDe[k];
      // el tramo mas cargado de la fila (no la suma): al alejar el zoom una fila abarca mas tramos
      let v = 0;
      for (let b = tr[0]; b <= tr[1]; b++) if (g[b * n + t] > v) v = g[b * n + t];
      val[f * outW + k] = v;
      if (v > mx) mx = v;
    }
  }
  // Heatmap: bandas difuminadas en vertical, se ve el `zonas` % mas cargado de lo pintado y el amarillo empieza en el
  // percentil 99,5 (no en el maximo: si no, una sola banda se lleva el amarillo y el resto queda azul)
  let umbral = (lq.min / 100) * mx, fA = -1, fB = -1;
  if (lqHeat() && mx > 0) {
    for (let f = 0; f < nb && fA < 0; f++) for (let k = 0; k < outW; k++) if (val[f * outW + k] > 0) { fA = f; break; }
    for (let f = nb - 1; f >= 0 && fB < 0; f--) for (let k = 0; k < outW; k++) if (val[f * outW + k] > 0) { fB = f; break; }
    const lA = Math.log(pTop), lB = Math.log(pBot);
    const sig = (LQ_TF[lq.datos.tf].suave * nb) / Math.max(1e-9, Math.abs(lA - lB));   // filas por desviacion
    lqDifuminar(val, nb, outW, sig);
    const m = [], paso = Math.max(1, Math.floor((nb * outW) / 40000));
    for (let x = 0; x < val.length; x += paso) if (val[x] > 0) m.push(val[x]);
    m.sort((a, b) => a - b);
    // lo difuminado casi nulo no cuenta como zona
    const util = m.length ? m.slice(m.findIndex((v) => v > m[m.length - 1] * 0.004)) : m;
    mx = util.length ? util[Math.min(util.length - 1, Math.floor(util.length * 0.995))] : 0;
    umbral = util.length ? util[Math.min(util.length - 1, Math.floor(util.length * (1 - lq.zonas / 100)))] * (lq.zonas >= 100 ? 0 : 1) : 0;
    if (lq.zonas >= 100) umbral = util.length ? util[0] * 0.999 : 0;
    const extra = Math.ceil(sig * 2);
    fA = fA < 0 ? -1 : Math.max(0, fA - extra); fB = fB < 0 ? -1 : Math.min(nb - 1, fB + extra);
  }
  lq.mxVista = mx; lq.umbralVista = umbral;
  if (mx !== lq.mxEscala) { lq.mxEscala = mx; lqEscala(); }
  const cv = lq.pintado ? lq.pintado.cv : document.createElement("canvas");
  cv.width = outW; cv.height = outH;
  const ctx = cv.getContext("2d"), im = ctx.createImageData(outW, outH), px = im.data;
  if (mx > 0) for (let f = 0; f < nb; f++) {
    const y0 = f * LQ_BANDA, y1 = Math.min(outH, y0 + LQ_BANDA);
    for (let k = 0; k < outW; k++) {
      const v = val[f * outW + k];
      if (!(v > umbral)) continue;
      const c = lqColor(Math.min(1, v / mx));
      for (let y = y0; y < y1; y++) {
        const o = (y * outW + k) * 4;
        px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255;
      }
    }
  }
  ctx.putImageData(im, 0, 0);
  lq.pintado = { clave, cv, yA: fA < 0 ? 0 : fA * LQ_BANDA, yB: fB < 0 ? outH : (fB + 1) * LQ_BANDA };
  return lq.pintado;
}

// difuminado vertical de cada columna (tres pasadas de media movil, casi gaussiano) con `sig` filas de desviacion
function lqDifuminar(val, nb, outW, sig) {
  const r = Math.round(sig * 0.9);
  if (r < 1) return;
  const col = new Float64Array(nb), ac = new Float64Array(nb + 1);
  for (let k = 0; k < outW; k++) {
    for (let f = 0; f < nb; f++) col[f] = val[f * outW + k];
    for (let pasada = 0; pasada < 3; pasada++) {
      for (let f = 0; f < nb; f++) ac[f + 1] = ac[f] + col[f];
      for (let f = 0; f < nb; f++) {
        const a = Math.max(0, f - r), b = Math.min(nb, f + r + 1);
        col[f] = (ac[b] - ac[a]) / (2 * r + 1);
      }
    }
    for (let f = 0; f < nb; f++) val[f * outW + k] = col[f];
  }
}

class LqHeat {
  constructor() { this.p = null; this.view = { zOrder: () => "bottom", renderer: () => ({ draw: (t) => this.draw(t) }) }; }
  attached(p) { this.p = p; }
  detached() { this.p = null; }
  paneViews() { return [this.view]; }
  redraw() { if (this.p) this.p.requestUpdate(); }
  draw(target) {
    const r = lq.res, p = this.p;
    if (!r || !p || !lq.escalones || !r.gZ) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const ts = lq.chart.timeScale(), vr = ts.getVisibleLogicalRange();
      if (!vr) return;
      const c0 = Math.max(0, Math.floor(vr.from)), c1 = Math.min(r.n - 1, Math.ceil(vr.to));
      if (c1 < c0) return;
      const xA = ts.logicalToCoordinate(c0), xB = ts.logicalToCoordinate(c0 + 1);
      if (xA == null || xB == null) return;
      const w = xB - xA, left = xA - w / 2, ancho = w * (c1 - c0 + 1);
      const img = lqPintar(p.series, Math.min(ancho, mediaSize.width), mediaSize.height, c0, c1);
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      // Heatmap: base morada desde la primera vela con datos; fuera, el fondo del grafico
      // y en vertical solo donde hay liquidez (fuera, el fondo negro)
      if (lqHeat()) { ctx.fillStyle = C.liqH.base; ctx.fillRect(Math.max(0, left), img.yA, mediaSize.width, img.yB - img.yA); }
      ctx.drawImage(img.cv, left, 0, ancho, mediaSize.height);
      // Heatmap: lo pendiente en la ultima vela sigue hasta el borde derecho (las bandas que el precio no ha barrido)
      const x0 = left + ancho;
      if (lqHeat() && c1 === r.n - 1 && x0 < mediaSize.width) ctx.drawImage(img.cv, img.cv.width - 1, 0, 1, img.cv.height, x0, 0, mediaSize.width - x0, mediaSize.height);
      ctx.restore();
    });
  }
}

// perfil: resume toda la vista (como mapaliquidaciones.com): en cada fila, la suma de lo vivo en las velas que se ven,
// con su propia escala (su barra mayor es roja); la intensidad minima, frente a esa barra
class LqPerfil {
  constructor() { this.p = null; this.view = { zOrder: () => "top", renderer: () => ({ draw: (t) => this.draw(t) }) }; }
  attached(p) { this.p = p; }
  detached() { this.p = null; }
  paneViews() { return [this.view]; }
  redraw() { if (this.p) this.p.requestUpdate(); }
  draw(target) {
    const r = lq.res, p = this.p, d = lq.datos;
    if (!r || !p || !d || !lq.escalones || lqHeat()) return;
    const vr = lq.chart.timeScale().getVisibleLogicalRange();
    if (!vr) return;
    const c0 = Math.max(0, Math.floor(vr.from)), c1 = Math.min(r.n - 1, Math.ceil(vr.to));
    if (c1 < c0) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const H = mediaSize.height, W = lqAnchoPerfil(mediaSize.width), right = mediaSize.width - 2;
      const paso = LQ_BANDA, filas = [], g = r.gZ, n = r.n;
      let mx = 0;
      for (let y = 0; y < H; y += paso) {
        const tr = lqTramosEntre(p.series, y, y + paso);
        let v = 0;
        if (tr) for (let t = c0; t <= c1; t++) {
          let m = 0;
          for (let b = tr[0]; b <= tr[1]; b++) if (g[b * n + t] > m) m = g[b * n + t];
          v += m;
        }
        filas.push([y, v]); mx = Math.max(mx, v);
      }
      ctx.save();
      ctx.fillStyle = C.liq.fondo;
      ctx.fillRect(right - W, 0, W + 2, H);
      for (const [y, v] of filas) {
        if (!(mx > 0) || v <= (lq.min / 100) * mx) continue;
        ctx.fillStyle = `rgb(${lqColor(v / mx).join(",")})`;
        const wv = (v / mx) * W * 0.95;
        ctx.fillRect(right - wv, y, wv, paso);
      }
      ctx.restore();
    });
  }
}

// niveles clave: el grupo mas cargado por encima y por debajo, como lineas con su etiqueta en el eje
function lqNivelesClave(g) {
  for (const l of lq.lineas || []) lq.serie.removePriceLine(l);
  lq.lineas = [];
  const linea = (x, col, titulo) => lq.lineas.push(lq.serie.createPriceLine({ price: x.p, color: col, lineWidth: 1, lineStyle: 2,
    axisLabelVisible: true, title: `${titulo} ${lqUsd(x.a)}` }));
  const arriba = g.arriba.slice().sort((p, q) => q.a - p.a)[0], abajo = g.abajo.slice().sort((p, q) => q.a - p.a)[0];
  // color neutro: el rojo y el verde quedan solo para la carga de las bandas (antes chocaban con el lado). En Heatmap no
  // hay lineas: los grupos se leen en la paleta y en la lectura de debajo
  if (arriba && !lqHeat()) linea(arriba, C.text, "Shorts");
  if (abajo && !lqHeat()) linea(abajo, C.text, "Longs");
  // el eje de precios llega hasta esos dos grupos (como en mapaliquidaciones.com): si no, el mayor de cada lado
  // quedaba fuera del grafico cuando estaba lejos de las velas (BTC diario: los largos de 54.679, a un 11 %)
  const antes = lq.extremos;
  lq.extremos = { lo: abajo ? abajo.p * 0.99 : null, hi: arriba ? arriba.p * 1.01 : null };
  if (!antes || antes.lo !== lq.extremos.lo || antes.hi !== lq.extremos.hi) lq.serie.priceScale().applyOptions({ autoScale: true });
}

function lqChart() {
  const L = window.LightweightCharts;
  lq.chart = L.createChart($("lqChart"), {
    autoSize: true, localization: { locale: "en-US" },
    timeScale: { rightOffset: 4, shiftVisibleRangeOnNewBar: false },
    crosshair: { mode: L.CrosshairMode.Normal },
    rightPriceScale: { scaleMargins: { top: 0.05, bottom: 0.05 } },
  });
  lq.serie = lq.chart.addSeries(L.CandlestickSeries, { priceLineVisible: true, lastValueVisible: true,
    // ajuste automatico: las velas y los dos grupos mayores (lq.extremos, de lqNivelesClave)
    autoscaleInfoProvider: (base) => {
      const r = base(), x = lq.extremos;
      if (!r || !r.priceRange || !x) return r;
      if (x.lo != null) r.priceRange.minValue = Math.min(r.priceRange.minValue, x.lo);
      if (x.hi != null) r.priceRange.maxValue = Math.max(r.priceRange.maxValue, x.hi);
      return r;
    } });
  lq.heat = new LqHeat(); lq.serie.attachPrimitive(lq.heat);
  lq.prof = new LqPerfil(); lq.serie.attachPrimitive(lq.prof);
  lq.marcas = new LqMarcas(); lq.serie.attachPrimitive(lq.marcas);
  lq.chart.subscribeCrosshairMove((prm) => { lqLeyenda(prm); lqTip(prm); });
}

function lqTema() {
  if (!lq.chart) return;
  const font = getComputedStyle(document.body).fontFamily, h = lqHeat(), H = C.liqH;
  $("lqChart").parentElement.classList.toggle("lq-heat", h);
  const eje = h ? H.eje : C.axis, cruz = h ? H.cruz : C.faint, etq = h ? H.etiqueta : C.surface;
  lq.chart.applyOptions({
    layout: { background: { type: "solid", color: h ? H.fondo : C.liq.fondo }, textColor: h ? H.texto : C.muted, fontFamily: font, fontSize: 12,
      panes: { separatorColor: eje, separatorHoverColor: h ? H.cruz : C.grid } },
    grid: { vertLines: { color: "rgba(0,0,0,0)" }, horzLines: { color: "rgba(0,0,0,0)" } },
    rightPriceScale: { borderColor: eje }, timeScale: { borderColor: eje },
    crosshair: { vertLine: { color: cruz, labelBackgroundColor: etq }, horzLine: { color: cruz, labelBackgroundColor: etq } },
  });
  const up = h ? H.sube : C.liq.sube, dn = h ? H.baja : C.liq.baja;
  lq.serie.applyOptions({ upColor: up, downColor: dn, borderUpColor: up, borderDownColor: dn,
    wickUpColor: up, wickDownColor: dn, priceLineColor: h ? H.precio : C.amber });
  lqRsiSerie();
  if (lq.res) { lq.imgClave = ""; lqImagen(); lqSeries(false); lqLectura(); lq.heat.redraw(); }
}

/* ---------- Heatmap: RSI debajo y maximo y minimo de la vista */
// RSI de Wilder sobre los cierres
function lqRsiCalc(velas, p = 14) {
  const out = [];
  let ganan = 0, pierden = 0;
  for (let i = 1; i < velas.length; i++) {
    const x = velas[i].c - velas[i - 1].c, g = Math.max(0, x), l = Math.max(0, -x);
    if (i <= p) { ganan += g / p; pierden += l / p; if (i < p) continue; }
    else { ganan = (ganan * (p - 1) + g) / p; pierden = (pierden * (p - 1) + l) / p; }
    out.push({ time: velas[i].t, value: pierden > 0 ? 100 - 100 / (1 + ganan / pierden) : 100 });
  }
  return out;
}

// panel del RSI: solo en Heatmap (al volver a Classic se quita la serie y la libreria quita su panel)
function lqRsiSerie() {
  if (!lq.chart) return;
  const L = window.LightweightCharts;
  if (!lqHeat()) {
    if (lq.rsi) { lq.chart.removeSeries(lq.rsi); lq.rsi = null; }
    return;
  }
  if (!lq.rsi) {
    lq.rsi = lq.chart.addSeries(L.LineSeries, { lineWidth: 1, priceLineVisible: false, lastValueVisible: true,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 }, crosshairMarkerVisible: false,
      autoscaleInfoProvider: () => ({ priceRange: { minValue: 10, maxValue: 90 } }) }, 1);
    lq.rsi.attachPrimitive(new LqRsiZonas());
    const pane = lq.chart.panes()[1];
    if (pane) pane.setHeight(Math.round($("lqChart").clientHeight * 0.16));
  }
  lq.rsi.applyOptions({ color: C.liqH.rsi });
  lq.rsi.setData(lq.datos ? lqRsiCalc(lq.datos.velas) : []);
}

// zonas del RSI: por encima de 70 y por debajo de 30 sombreadas, con sus lineas, y el nombre arriba a la izquierda
class LqRsiZonas {
  constructor() { this.p = null; this.view = { zOrder: () => "bottom", renderer: () => ({ draw: (t) => this.draw(t) }) }; }
  attached(p) { this.p = p; }
  detached() { this.p = null; }
  paneViews() { return [this.view]; }
  draw(target) {
    const p = this.p;
    if (!p) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const H = C.liqH, y70 = p.series.priceToCoordinate(70), y30 = p.series.priceToCoordinate(30);
      if (y70 == null || y30 == null) return;
      const W = mediaSize.width;
      ctx.save();
      ctx.fillStyle = H.sobre; ctx.fillRect(0, 0, W, y70);
      ctx.fillStyle = H.bajo; ctx.fillRect(0, y30, W, mediaSize.height - y30);
      ctx.strokeStyle = H.nivel; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
      for (const y of [y70, y30]) { ctx.beginPath(); ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(W, Math.round(y) + 0.5); ctx.stroke(); }
      ctx.setLineDash([]);
      ctx.fillStyle = H.texto; ctx.font = `11px ${getComputedStyle(document.body).fontFamily}`; ctx.textBaseline = "top";
      ctx.fillText("RSI 14", 8, 5);
      ctx.restore();
    });
  }
}

// maximo y minimo de las velas que se ven, con su precio (como las marcas de un terminal)
class LqMarcas {
  constructor() { this.p = null; this.view = { zOrder: () => "top", renderer: () => ({ draw: (t) => this.draw(t) }) }; }
  attached(p) { this.p = p; }
  detached() { this.p = null; }
  paneViews() { return [this.view]; }
  draw(target) {
    const d = lq.datos, p = this.p;
    if (!d || !p || !lqHeat()) return;
    const ts = lq.chart.timeScale(), vr = ts.getVisibleLogicalRange();
    if (!vr) return;
    const n = d.velas.length, c0 = Math.max(0, Math.ceil(vr.from)), c1 = Math.min(n - 1, Math.floor(vr.to));
    if (c1 <= c0) return;
    let iH = c0, iL = c0;
    for (let i = c0; i <= c1; i++) { if (d.velas[i].h > d.velas[iH].h) iH = i; if (d.velas[i].l < d.velas[iL].l) iL = i; }
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const H = C.liqH, dec = lqDec(d.velas[n - 1].c);
      ctx.save();
      ctx.font = `600 11px ${getComputedStyle(document.body).fontFamily}`;
      for (const [i, precio, arriba] of [[iH, d.velas[iH].h, true], [iL, d.velas[iL].l, false]]) {
        const x = ts.logicalToCoordinate(i), y = p.series.priceToCoordinate(precio);
        if (x == null || y == null) continue;
        const txt = fmtNum(precio, dec), w = ctx.measureText(txt).width + 10, yy = arriba ? y - 9 : y + 9;
        // a la izquierda si no cabe a la derecha
        const der = x + 8 + w < mediaSize.width, bx = der ? x + 8 : x - 8 - w;
        ctx.strokeStyle = H.texto; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, Math.round(y) + 0.5); ctx.lineTo(x, Math.round(yy) + 0.5); ctx.lineTo(der ? bx : bx + w, Math.round(yy) + 0.5); ctx.stroke();
        ctx.fillStyle = H.etiqueta; ctx.fillRect(bx, yy - 8, w, 16);
        ctx.fillStyle = H.precio; ctx.textBaseline = "middle"; ctx.fillText(txt, bx + 5, yy + 0.5);
      }
      ctx.restore();
    });
  }
}

function lqLeyenda(prm) {
  const d = lq.datos, el = $("lqLeg");
  if (!d || !prm || prm.logical == null) { el.innerHTML = ""; return; }
  const i = Math.round(prm.logical), v = d.velas[i];
  if (!v) { el.innerHTML = ""; return; }
  const fecha = new Date(v.t * 1000).toLocaleString("en-US", d.tf === "1D" ? { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" } : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  const r = lq.res, real = d.realL[i] != null ? ` Real liquidations: longs <b class="neg">${lqUsd(d.realL[i])}</b>, shorts <b class="pos">${lqUsd(d.realS[i])}</b>.` : "";
  const prev = r ? ` Model: longs ${lqUsd(r.predL[i])}, shorts ${lqUsd(r.predS[i])}.` : "";
  el.innerHTML = `<b>${esc(d.sym)}</b> ${fecha} UTC. O ${lqPx(v.o)} H ${lqPx(v.h)} L ${lqPx(v.l)} C ${lqPx(v.c)}.${real}${prev}`;
}

// al pasar por una franja: precio, dinero que se liquidaria en esa fila, distancia y de que apalancamientos se compone
function lqTip(prm) {
  const el = $("lqTip"), r = lq.res, d = lq.datos;
  const fuera = () => { el.hidden = true; };
  if (!r || !d || !prm || !prm.point || prm.logical == null || prm.paneIndex) return fuera();
  // en Heatmap, a la derecha de la ultima vela se lee lo pendiente (lo que pinta la extension de las bandas)
  const t = lqHeat() ? Math.min(r.n - 1, Math.round(prm.logical)) : Math.round(prm.logical);
  if (t < 0 || t >= r.n) return fuera();
  const fila = Math.floor(prm.point.y / LQ_BANDA), tr = lqTramosEntre(lq.serie, fila * LQ_BANDA, (fila + 1) * LQ_BANDA);
  if (!tr) return fuera();
  let mx = 0;
  for (let b = tr[0]; b <= tr[1]; b++) mx = Math.max(mx, r.gZ[b * r.n + t]);
  if (lqHeat()) {   // las bandas estan difuminadas: se mira la banda de alrededor del cursor
    const tz = lqTramosEntre(lq.serie, prm.point.y - 8, prm.point.y + 8) || tr;
    for (let b = tz[0]; b <= tz[1]; b++) mx = Math.max(mx, r.gZ[b * r.n + t]);
    if (!(mx > 0)) return fuera();
  } else if (!(mx > (lq.min / 100) * (lq.mxVista || 0))) return fuera();   // solo sobre lo que se ve pintado
  // el desglose: los niveles de la banda alrededor del cursor (8 px a cada lado; cada nivel se reparte en varios
  // tramos, asi que una fila de 2 px casi nunca contiene su precio central)
  const ancho = lqTramosEntre(lq.serie, prm.point.y - 8, prm.point.y + 8) || tr;
  const lo = r.bordes[ancho[0]], hi = r.bordes[ancho[1] + 1], nv = r.niveles, porL = new Map();
  let suma = 0, nace0 = Infinity, nace1 = -Infinity, cortos = 0;
  for (let k = 0; k < nv.N; k++) {
    if (nv.p[k] < lo || nv.p[k] >= hi || t < nv.i[k] || t >= nv.toque[k]) continue;
    const a = LQ_MODELO.enMapa(r, k, t);
    if (!(a > 0)) continue;
    const gL = lqGrupo(nv.L[k]);   // en Heatmap, cada apalancamiento fino cuenta en el de APAL mas cercano
    suma += a; porL.set(gL, (porL.get(gL) || 0) + a);
    if (nv.lado[k]) cortos += a;
    nace0 = Math.min(nace0, nv.i[k]); nace1 = Math.max(nace1, nv.i[k]);
  }
  if (!(suma > 0)) return fuera();
  const precio = d.velas[d.velas.length - 1].c, medio = Math.sqrt(lo * hi);   // distancia desde el precio actual
  const lado = cortos >= suma / 2 ? "Short liquidations: hit if price rises here" : "Long liquidations: hit if price falls here";
  const comp = [...porL].sort((p, q) => p[0] - q[0]).map(([L, a]) => `${L}x ${Math.round((a / suma) * 100)}%`).join(", ");
  const dia = (i) => new Date(d.velas[i].t * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: d.tf === "1D" ? "numeric" : undefined, timeZone: "UTC" });
  el.innerHTML = `<b>${lqPx(lo)} to ${lqPx(hi)}</b> <span class="lq-d">${cxPct((medio / precio - 1) * 100)} from now</span>
    <div><b>${lqUsd(suma)}</b> would be liquidated</div><div class="ks">${lado}</div>
    <div class="ks">Leverage: ${comp}</div><div class="ks">Opened ${nace0 === nace1 ? dia(nace0) : `${dia(nace0)} to ${dia(nace1)}`}</div>`;
  el.hidden = false;
  const caja = $("lqChart").getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
  const x = prm.point.x + 16 + w > caja.width - 10 ? prm.point.x - w - 16 : prm.point.x + 16;
  el.style.left = Math.max(4, x) + "px";
  el.style.top = Math.max(4, Math.min(prm.point.y + 14, caja.height - h - 4)) + "px";
}

/* ---------- lectura debajo del grafico */
function lqLectura() {
  const d = lq.datos, r = lq.res, cfg = LQ_TF[d.tf], n = d.velas.length;
  const precio = d.velas[n - 1].c, pct = d.tf === "1D" ? 0.15 : d.tf === "4h" ? 0.1 : 0.05;
  // lo mismo que pinta el mapa ahora (con la intensidad minima): las lineas y los grupos siempre caen sobre una franja
  let mxUlt = 0;
  for (let b = 0; b < r.B; b++) mxUlt = Math.max(mxUlt, r.gZ[b * r.n + r.n - 1]);
  const umbral = lqHeat() ? 0 : (lq.min / 100) * mxUlt;
  const pr = LQ_MODELO.presion(r, precio, pct, umbral), g = LQ_MODELO.grupos(r, precio, 3, pct * 2, umbral);
  lqNivelesClave(g);
  let veredicto, cls = "";
  if (pr.ratio == null || (pr.arriba + pr.abajo) === 0) veredicto = "No clear pull";
  else if (pr.ratio >= 1.5) { veredicto = "Pull up"; cls = "pos"; }
  else if (pr.ratio <= 1 / 1.5) { veredicto = "Pull down"; cls = "neg"; }
  else veredicto = "No clear pull";
  const detalle = cls === "pos" ? "More short liquidations above than long ones below."
    : cls === "neg" ? "More long liquidations below than short ones above." : "Similar liquidity above and below.";
  const fila = (x) => `<div class="lq-g"><span>${lqPx(x.p)}</span><span class="lq-d">${cxPct((x.p / precio - 1) * 100)}</span><b>${lqUsd(x.a)}</b></div>`;
  // imanes: el mas cercano de los grandes grupos por encima y por debajo
  const iman = (x, lado) => (x ? `<b>${lqPx(x.p)}</b> ${lado} (${cxPct((x.p / precio - 1) * 100)}, ${lqUsd(x.a)})` : `nothing big ${lado}`);
  $("lqIman").innerHTML = `<b class="${cls}">${veredicto}</b>. Nearest liquidity: ${iman(g.arriba[0], "above")}, ${iman(g.abajo[0], "below")}.`;
  // acierto solo donde hay OI: antes, el mapa sale del volumen y no es el modelo que se juzga
  const i0 = Math.max(0, r.desdeOI);
  const aj = LQ_MODELO.ajuste(d.realL.map((x, i) => (x == null || i < i0 ? 0 : r.predL[i] + r.predS[i])),
    d.realL.map((x, i) => (x == null || i < i0 ? null : x + d.realS[i])));
  const nota = d.liqPend ? "Loading" : d.liqError ? "Unavailable" : !aj ? "Not enough data" : aj.r >= 0.5 ? "Good" : aj.r >= 0.3 ? "Fair" : "Weak";
  const porQue = d.liqPend ? "Waiting for the real liquidations." : d.liqError ? `Real liquidations unavailable right now (${d.liqError}).`
    : !aj ? "Too few candles with real liquidations to judge." :
    `How well the liquidations the model expected each candle match the real ones (correlation r = ${fmtNum(aj.r, 2)} over ${fmtNum(aj.n)} candles). Use the map for zones, not exact amounts.`;
  const desde = r.desdeOI >= 0 ? new Date(d.velas[r.desdeOI].t * 1000).toISOString().slice(0, 10) : null;
  const ex = (lq.merc.exchanges || {});
  $("lqRead").innerHTML = `
    <div class="lq-card"><span class="kl">Within ${Math.round(pct * 100)}% of the price</span><b class="lq-big ${cls}">${veredicto}</b>
      <span class="ks">${detalle} Shorts above ${lqUsd(pr.arriba)}, longs below ${lqUsd(pr.abajo)}.</span></div>
    <div class="lq-card"><span class="kl">Biggest clusters above (shorts)</span>${g.arriba.map(fila).join("") || "<span class='ks'>None</span>"}</div>
    <div class="lq-card"><span class="kl">Biggest clusters below (longs)</span>${g.abajo.map(fila).join("") || "<span class='ks'>None</span>"}</div>
    <div class="lq-card"><span class="kl">Model reliability</span><b>${nota}</b><span class="ks">${esc(porQue)}</span></div>`;
  $("lqCap").textContent = `${d.sym}, ${cfg.nombre} candles. Where leveraged positions would be liquidated: brighter means more money.`;
  $("lqHow").textContent = "Each band is a price where open leveraged positions would be force-closed, estimated from new open " +
    "interest, the buy/sell split of volume and typical leverage (5x to 100x), spread over the entry prices of each candle. " +
    "Bands above the price are shorts, below are longs. A band grows while positions keep opening there and stays until price " +
    `sweeps it (it shrinks if open interest falls); levels that price hit within ${LQ_VIDA_MIN} candles are left out. Colors are ` +
    "relative to what is on screen, from blue (least) to red (the most loaded in view), so they change when you zoom or scroll; " +
    "Min. intensity in Settings hides the weaker bands. Price tends to travel toward big bands: the forced orders feed the move. " +
    "Hover a band to see its size, distance and leverage mix. " +
    (lqHeat() ? "Bands that run past the last candle are still pending now (Heatmap design: continuous colors, RSI 14 below). "
      : "The right profile is what is still pending now. ") + "Real liquidations of each candle show in the legend at the top when you hover it. " +
    (desde ? `Open interest of ${d.exs.map((e) => ex[e]).join(", ")} since ${desde}${r.desdeOI > 0 ? "; before that, estimated from volume" : ""}.`
      : "No open interest for this choice: estimated from volume.");
}

/* ---------- eventos */
$("lqSym").addEventListener("change", (e) => {
  const v = e.target.value.trim().toUpperCase();
  if (lq.merc && lq.merc.activos.some((a) => a.sym === v)) { lqSet({ sym: v }); } else e.target.value = lq.sym;
});
$("lqTf").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { lqSet({ tf: b.dataset.v }); } });
// cambio de diseno: mismo calculo, otro dibujo
$("lqDis").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b || b.dataset.v === lq.dis) return;
  lq.dis = b.dataset.v; store.set("lqDis", lq.dis);
  lqControles(); lqTema();
  if (lq.datos) { lqCalcular(); lqVista(); lq.prof.redraw(); }
});
$("lqEx").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const s = new Set(lq.exOff); if (s.has(b.dataset.v)) s.delete(b.dataset.v); else s.add(b.dataset.v);
  lqSet({ exOff: s });
});
$("lqLev").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const s = new Set(lq.levOff); if (s.has(b.dataset.v)) s.delete(b.dataset.v); else s.add(b.dataset.v);
  Object.assign(lq, { levOff: s }); store.set("lqLevOff3", [...s].join(",")); lqControles(); lqCalcular();
});
$("lqMin").addEventListener("input", (e) => {
  const v = +e.target.value;
  if (lqHeat()) lq.zonas = v; else lq.min = v;
  $("lqMinV").textContent = v + "%"; lqImagen();
  if (lq.heat) { lq.heat.redraw(); lq.prof.redraw(); }
  if (lq.datos && lq.res) lqLectura();   // lineas y grupos: solo lo que se ve
});
$("lqMin").addEventListener("change", () => { store.set("lqMin6", lq.min); store.set("lqZonas", lq.zonas); });
$("lqPreset").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const x = LQ_PRESET[b.dataset.v];
  lqSet({ tf: x.tf, levOff: new Set(x.levOff) });
});
// Settings se cierra al pulsar fuera o con Esc
// (por la ruta del evento: al marcar un apalancamiento su boton se redibuja y ya no esta dentro)
document.addEventListener("click", (e) => { const d = $("lqAjustes"); if (d.open && !e.composedPath().includes(d)) d.open = false; });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("lqAjustes").open = false; });
$("lqSym").addEventListener("focus", (e) => e.target.select());   // escribir encima del activo actual
$("lqRetry").addEventListener("click", () => { lqMensaje(""); lqCargar(); });
$("lqChart").addEventListener("mouseleave", () => { $("lqTip").hidden = true; });

// imagen del mapa como en pantalla (velas, franjas, perfil y lineas) con una cabecera:
// activo, marco, fecha de la ultima vela, precio y la linea de liquidez mas cercana
function lqPngBlob() {
  // la captura sale a la densidad de la pantalla: la cabecera, igual
  const d = lq.datos, src = lq.chart.takeScreenshot(), k = Math.max(1, window.devicePixelRatio || 1), pad = 14, cab = 64;
  const cv = document.createElement("canvas");
  const W = src.width, H = src.height + Math.round(cab * k);
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d"), font = getComputedStyle(document.body).fontFamily;
  ctx.fillStyle = C.surface; ctx.fillRect(0, 0, W, H);
  ctx.drawImage(src, 0, Math.round(cab * k));
  ctx.scale(k, k);
  const v = d.velas[d.velas.length - 1];
  const fecha = new Date(v.t * 1000).toLocaleString("en-US", d.tf === "1D" ? { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" } : { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  ctx.textBaseline = "top";
  ctx.fillStyle = C.text; ctx.font = `700 16px ${font}`;
  ctx.fillText(`${d.sym} liquidation map, ${LQ_TF[d.tf].nombre} candles`, pad, 8);
  ctx.fillStyle = C.muted; ctx.font = `12px ${font}`;
  ctx.fillText(`${fecha}${d.tf === "1D" ? "" : " UTC"}, price ${lqPx(v.c)}`, pad, 28);
  ctx.fillText($("lqIman").textContent, pad, 45);
  ctx.textAlign = "right"; ctx.fillStyle = C.faint;
  ctx.fillText("GEX Lab", W / k - pad, 10);
  return new Promise((ok, ko) => cv.toBlob((b) => (b ? ok(b) : ko(new Error("Could not create the image"))), "image/png"));
}

// si el navegador no deja copiar, la imagen se descarga
async function lqDescargar() {
  const url = URL.createObjectURL(await lqPngBlob()), a = document.createElement("a");
  a.href = url; a.download = `${lq.datos.sym}-liquidations-${lq.datos.tf}.png`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast("Image downloaded", "This browser blocked copying to the clipboard, so it was saved as a file.");
}

// al portapapeles: la escritura se pide dentro del clic, con la imagen como promesa (lo exige el navegador)
$("lqCopiar").addEventListener("click", () => {
  if (!lq.datos || !lq.chart) return;
  const b = $("lqCopiar");
  b.disabled = true;
  const copia = navigator.clipboard && window.ClipboardItem
    ? navigator.clipboard.write([new ClipboardItem({ "image/png": lqPngBlob() })]).then(() => toast("Image copied", "Paste it with Ctrl+V."))
    : Promise.reject(new Error("no clipboard"));
  copia.catch(() => lqDescargar().catch((e) => toast("Could not copy", e.message)))
    .finally(() => { b.disabled = false; });
});
$("lqFull").addEventListener("click", () => {
  const el = $("lqPanel");
  // el navegador solo deja entrar en pantalla completa desde un clic real: si lo rechaza, no pasa nada
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
});
