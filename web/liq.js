"use strict";
/* ============================================================ Mapa de liquidaciones (Crypto > Liquidations)
   Datos: /api/liq_markets (activos con perpetuos, pub/liq_mercados.json de cripto.py) y /api/liq (velas, OI y
   liquidaciones reales de Coinalyze por el Worker, que pone la clave; en el PC, liq_local.py). El modelo esta en
   web/liq-modelo.js (LQ_MODELO); aqui se pide, se calcula y se dibuja sobre Lightweight Charts (como la Trading
   Window): el calor es una capa propia debajo de las velas, el perfil de lo pendiente va pegado a la derecha y las
   liquidaciones reales en un panel debajo. Nombres con prefijo lq: los globales se comparten entre scripts. */

const LQ_LIB = "https://cdn.jsdelivr.net/npm/lightweight-charts@5.2.1/dist/lightweight-charts.standalone.production.js";
// marcos: intervalo de Coinalyze, segundos por vela, historia que se pide, vida media de una posicion (velas) y
// cuantas velas se ven al abrir
const LQ_TF = {
  "5m": { iv: "5min", s: 300, dias: 7, vida: 144, ver: 288, nombre: "5 minutes" },
  "15m": { iv: "15min", s: 900, dias: 20, vida: 96, ver: 288, nombre: "15 minutes" },
  "1h": { iv: "1hour", s: 3600, dias: 80, vida: 96, ver: 500, nombre: "1 hour" },
  "4h": { iv: "4hour", s: 14400, dias: 330, vida: 90, ver: 540, nombre: "4 hours" },
  "1D": { iv: "daily", s: 86400, desde: 1567296000, vida: 45, ver: 400, nombre: "daily" },
};
const LQ_BANDA = 8;   // alto en pixeles de cada franja del mapa y del perfil
// atajos: marco y apalancamientos de cada forma de operar
const LQ_PRESET = {
  swing: { tf: "1D", levOff: ["50", "100"] },   // posiciones que aguantan semanas: niveles lejos del precio
  scalp: { tf: "15m", levOff: ["5", "10"] },    // alto apalancamiento: niveles pegados al precio
};
const lq = {
  merc: null, sym: store.get("lqSym", "BTC"), tf: store.get("lqTf", "1D"),
  exOff: new Set(String(store.get("lqExOff", "")).split(",").filter(Boolean)),
  levOff: new Set(String(store.get("lqLevOff3", "")).split(",").filter(Boolean)),
  min: +store.get("lqMin3", 15), vida: "1", extra: 0,
  datos: null, clave: "", at: 0, res: null, resClave: "", img: null, imgClave: "",
  chart: null, serie: null, hist: null, heat: null, prof: null, ctrl: null, error: "",
};

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

function lqMensaje(t) {
  lq.error = t || "";
  $("lqMsg").textContent = lq.error;
  $("lqMsg").hidden = !lq.error;
}

/* ---------- controles */
function lqControles() {
  const ms = lq.merc.activos;
  $("lqList").innerHTML = ms.map((a) => `<option value="${esc(a.sym)}">${esc(a.nombre)}</option>`).join("");
  $("lqSym").value = lq.sym;
  $("lqQuick").innerHTML = ms.slice(0, 10).map((a) => `<button role="radio" data-v="${esc(a.sym)}" aria-checked="${a.sym === lq.sym}">${esc(a.sym)}</button>`).join("");
  document.querySelectorAll("#lqTf button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === lq.tf)));
  const a = lqActivo(), ex = lq.merc.exchanges || {};
  const exs = Object.keys(ex).filter((e) => a && a.ex[e]), activos = exs.filter((e) => !lq.exOff.has(e)).length;
  $("lqEx").innerHTML = exs.map((e) => `<button role="checkbox" data-v="${e}" aria-checked="${!lq.exOff.has(e)}">${esc(ex[e])}</button>`).join("");
  $("lqExN").textContent = activos === exs.length ? "All" : `${activos} of ${exs.length}`;
  const off = [...lq.levOff].sort().join(",");
  document.querySelectorAll("#lqPreset button").forEach((b) => {
    const x = LQ_PRESET[b.dataset.v];
    b.setAttribute("aria-checked", String(x.tf === lq.tf && [...x.levOff].sort().join(",") === off));
  });
  $("lqLev").innerHTML = LQ_MODELO.APAL.map((x) => `<button role="checkbox" data-v="${x.L}" aria-checked="${!lq.levOff.has(String(x.L))}" title="Weight ${Math.round(x.w * 100)}%">${x.L}x</button>`).join("");
  $("lqMin").value = lq.min; $("lqMinV").textContent = lq.min + "%";
  $("lqMas").hidden = !!LQ_TF[lq.tf].desde;
}

function lqSet(cambio) {
  Object.assign(lq, cambio);
  store.set("lqSym", lq.sym); store.set("lqTf", lq.tf); store.set("lqMin3", lq.min);
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
    if (r.ok) return d;
    if (r.status !== 429 || intento >= 3) throw new Error(d.error || `The data source answered ${r.status}`);
    await lqEsperar(Math.min(+d.retry || +r.headers.get("Retry-After") || 20, 65) + 1, signal, aviso);
    if (aviso) lqEstado("Loading…");
  }
}

function lqClave() {
  const a = lqActivo(), cfg = LQ_TF[lq.tf];
  const syms = Object.keys(a.ex).filter((e) => !lq.exOff.has(e)).flatMap((e) => lqSimbolos(a, e));
  const hasta = Math.ceil(Date.now() / 1000 / cfg.s) * cfg.s;
  const desde = cfg.desde || hasta - cfg.dias * 86400 * (1 + lq.extra);
  return { a, cfg, syms, desde, hasta, clave: [a.sym, lq.tf, syms.join(","), desde].join("|") };
}

// pinta al momento lo que haya en cache y, si no esta al dia, lo pide (con una pausa corta: los clics seguidos no
// gastan cupo)
function lqCargar() {
  if (!lqActivo() || !lq.chart) return;
  const k = lqClave(), hit = LQ_CACHE.get(k.clave);
  lqMensaje("");
  if (hit && k.clave !== lq.clave) {
    try { lqMontar(hit, k); } catch (e) { lqMensaje(e.message); }
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
    lqMontar(e, k);
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
    lqMensaje(hit ? `Could not refresh (${m}) Showing data from ${Math.round((Date.now() - hit.at) / 60000)} min ago.` : m);
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
function lqCalcular(nuevos = false) {
  const d = lq.datos;
  if (!d) return;
  const cfg = LQ_TF[d.tf];
  // ocultar un apalancamiento solo quita sus franjas: el reparto y los colores siguen calculados con todos
  const ver = LQ_MODELO.APAL.map((x) => x.L).filter((L) => !lq.levOff.has(String(L)));
  const clave = [lq.clave, ver.join(","), lq.vida].join("|");
  if (clave !== lq.resClave) {
    lq.res = LQ_MODELO.calcular(d.velas, d.oi, { ver, vida: cfg.vida * +lq.vida, bins: 600, nivel: d.nivel,
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
  lq.hist.setData(d.velas.map((v, i) => {
    const l = d.realL[i], s = d.realS[i];
    if (l == null && s == null) return { time: v.t };
    // la barra mayor manda: largos hacia abajo (rojo), cortos hacia arriba (verde)
    return (s || 0) >= (l || 0) ? { time: v.t, value: s || 0, color: C.put } : { time: v.t, value: -(l || 0), color: C.call };
  }));
  lq.chart.applyOptions({ timeScale: { timeVisible: d.tf !== "1D", secondsVisible: false } });
  if (nuevos) lqVista();
}

// vista inicial: las ultimas velas del marco y, a la derecha, sitio para el perfil. Con el ancho ya maquetado (el
// siguiente fotograma: al abrir la pestana el grafico aun no tiene su tamano)
function lqVista() {
  requestAnimationFrame(() => {
    const d = lq.datos;
    if (!d) return;
    const n = d.velas.length, ancho = lq.chart.timeScale().width() || 800, W = lqAnchoPerfil(ancho) + 20;
    // en pantallas estrechas, menos velas (la libreria no las junta a menos de medio pixel); margen en velas que deja
    // el ancho del perfil (mas un respiro) despues de la ultima vela
    const ver = Math.min(n, LQ_TF[d.tf].ver, Math.floor((ancho - W) / 0.6)), margen = Math.ceil((ver * W) / Math.max(1, ancho - W));
    lq.chart.timeScale().setVisibleLogicalRange({ from: n - ver, to: n + margen });
    // si se habia arrastrado o ampliado el eje de precios, la libreria apaga el ajuste automatico y el eje se quedaba
    // en los precios del activo anterior: con datos nuevos vuelve a ajustarse
    lq.serie.priceScale().applyOptions({ autoScale: true });
    lq.hist.priceScale().applyOptions({ autoScale: true });
  });
}

// ancho en pixeles del perfil de la derecha (lo usa tambien el margen de la vista)
const lqAnchoPerfil = (ancho) => Math.round(Math.min(170, Math.max(60, ancho * 0.14)));

// paleta de los niveles con los colores del tema, solida: de lo flojo (azul apagado hacia el fondo) a lo fuerte (rojo)
function lqHex(c) { const n = parseInt(String(c).slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function lqPaleta() {
  // [posicion, color, opacidad]: lo flojo, azul marino casi transparente (se funde con el fondo); los grupos, verde,
  // amarillo y rojo solidos. Asi el mapa se lee de un vistazo, como mapaliquidaciones.com
  const fondo = lqHex(C.surface), azul = lqHex(C.prevClose), mez = (a, f) => a.map((x, i) => x * f + fondo[i] * (1 - f));
  const paradas = [[0, mez(azul, 0.3), 0.18], [0.3, mez(azul, 0.6), 0.5], [0.5, lqHex(C.put), 0.95], [0.72, lqHex(C.amber), 1], [1, lqHex(C.call), 1]];
  const lut = new Uint8ClampedArray(256 * 4);
  for (let k = 0; k < 256; k++) {
    const u = k / 255;
    let j = 0;
    while (j < paradas.length - 2 && u > paradas[j + 1][0]) j++;
    const [u0, c0, a0] = paradas[j], [u1, c1, a1] = paradas[j + 1], f = Math.min(1, Math.max(0, (u - u0) / (u1 - u0)));
    for (let q = 0; q < 3; q++) lut[k * 4 + q] = c0[q] + (c1[q] - c0[q]) * f;
    lut[k * 4 + 3] = 255 * (a0 + (a1 - a0) * f);
  }
  return lut;
}

// paleta y rejilla de precios: se rehacen al cambiar el calculo, la intensidad minima o el tema. El dibujo (y la
// escala de color, frente a lo que se ve) se hace en lqPintar, con la vista de cada momento
function lqImagen() {
  if (!lq.res) return;
  const r = lq.res, clave = [lq.resClave, lq.min, document.documentElement.dataset.theme].join("|");
  if (clave === lq.imgClave) return;
  const B = r.B;
  lq.lut = lqPaleta();
  lq.colores = Array.from({ length: 256 }, (_, k) => `rgba(${lq.lut[k * 4]},${lq.lut[k * 4 + 1]},${lq.lut[k * 4 + 2]},${(lq.lut[k * 4 + 3] / 255).toFixed(3)})`);
  lq.lLo = Math.log(r.bordes[0]); lq.paso = (Math.log(r.bordes[B]) - lq.lLo) / B;
  lq.imgClave = clave; lq.pintado = null;
  lqEscala();
}

// barra de la escala de color: desde la intensidad minima (lo que se pinta) hasta el tope, en dolares
function lqEscala() {
  const r = lq.res;
  if (!r || !lq.colores) return;
  const k0 = Math.floor((lq.min / 100) * 255), pasos = [];
  for (let k = k0; k <= 255; k += Math.max(1, Math.round((255 - k0) / 12))) pasos.push(lq.colores[k]);
  pasos.push(lq.colores[255]);
  $("lqEscalaBarra").style.background = `linear-gradient(90deg, ${pasos.join(", ")})`;
  $("lqEscalaTxt").textContent = lq.min > 0 ? `${lqUsd((lq.min / 100) * r.topeV)} to ${lqUsd(r.topeV)}+` : `up to ${lqUsd(r.topeV)}+`;
}

// tramos de precio (de menor a mayor) que caen entre dos filas de pantalla
function lqTramosEntre(serie, yArriba, yAbajo) {
  const pA = serie.coordinateToPrice(yArriba), pB = serie.coordinateToPrice(yAbajo);
  if (!(pA > 0) || !(pB > 0)) return null;
  const B = lq.res.B, hi = Math.floor((Math.log(pA) - lq.lLo) / lq.paso), lo = Math.floor((Math.log(pB) - lq.lLo) / lq.paso);
  if (hi < 0 || lo >= B) return null;
  return [Math.max(0, Math.min(lo, hi)), Math.min(B - 1, Math.max(lo, hi))];
}

// mapa de la vista: filas de LQ_BANDA pixeles con el tramo de precio mas cargado de cada una (niveles vivos a su
// tamano al nacer, r.gV) y una columna por vela visible (o por pixel si hay mas velas que pixeles), con 1 px de
// separacion entre filas. Color frente a la escala fija del activo (r.topeV): azul tenue lo flojo, verde, amarillo y rojo
// los grupos; lo que no pasa la intensidad minima no se pinta
function lqPintar(serie, ancho, alto, c0, c1) {
  const r = lq.res, n = r.n, cols = c1 - c0 + 1;
  const pTop = serie.coordinateToPrice(0), pBot = serie.coordinateToPrice(alto);
  const clave = [lq.imgClave, c0, c1, Math.round(ancho), Math.round(alto), pTop, pBot].join("|");
  if (lq.pintado && lq.pintado.clave === clave) return lq.pintado;
  const outW = Math.max(1, Math.min(cols, Math.ceil(ancho))), outH = Math.max(1, Math.ceil(alto));
  const nb = Math.ceil(outH / LQ_BANDA), g = r.gV, lut = lq.lut;
  const colDe = new Int32Array(outW);
  for (let k = 0; k < outW; k++) colDe[k] = Math.min(n - 1, c0 + Math.floor(((k + 0.5) * cols) / outW));
  const val = new Float64Array(nb * outW);
  for (let f = 0; f < nb; f++) {
    const tr = lqTramosEntre(serie, f * LQ_BANDA, (f + 1) * LQ_BANDA);
    if (!tr) continue;
    for (let k = 0; k < outW; k++) {
      const t = colDe[k];
      // el tramo mas cargado de la fila (no la suma): al alejar el zoom una fila abarca mas tramos y no debe encenderse
      let v = 0;
      for (let b = tr[0]; b <= tr[1]; b++) if (g[b * n + t] > v) v = g[b * n + t];
      val[f * outW + k] = v;
    }
  }
  // escala fija del activo y el marco (r.topeV, del modelo): el zoom cambia la resolucion, nunca los colores
  const tope = r.topeV > 0 ? r.topeV : 1, umbral = (lq.min / 100) * tope;
  const cv = lq.pintado ? lq.pintado.cv : document.createElement("canvas");
  cv.width = outW; cv.height = outH;
  const ctx = cv.getContext("2d"), im = ctx.createImageData(outW, outH), px = im.data;
  for (let f = 0; f < nb; f++) {
    const y0 = f * LQ_BANDA, y1 = Math.min(outH, y0 + LQ_BANDA - 1);   // la ultima fila de cada franja, vacia
    for (let k = 0; k < outW; k++) {
      const v = val[f * outW + k];
      if (!(v > umbral)) continue;
      const i = Math.floor(Math.min(1, v / tope) * 255) * 4;
      for (let y = y0; y < y1; y++) {
        const o = (y * outW + k) * 4;
        px[o] = lut[i]; px[o + 1] = lut[i + 1]; px[o + 2] = lut[i + 2]; px[o + 3] = lut[i + 3];
      }
    }
  }
  ctx.putImageData(im, 0, 0);
  lq.pintado = { clave, cv };
  return lq.pintado;
}

class LqHeat {
  constructor() { this.p = null; this.view = { zOrder: () => "bottom", renderer: () => ({ draw: (t) => this.draw(t) }) }; }
  attached(p) { this.p = p; }
  detached() { this.p = null; }
  paneViews() { return [this.view]; }
  redraw() { if (this.p) this.p.requestUpdate(); }
  draw(target) {
    const r = lq.res, p = this.p;
    if (!r || !p || !lq.lut || !r.gV) return;
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
      ctx.drawImage(img.cv, left, 0, ancho, mediaSize.height);
      ctx.restore();
    });
  }
}

// perfil de lo pendiente ahora: la ultima columna del mapa, con su misma paleta
class LqPerfil {
  constructor() { this.p = null; this.view = { zOrder: () => "top", renderer: () => ({ draw: (t) => this.draw(t) }) }; }
  attached(p) { this.p = p; }
  detached() { this.p = null; }
  paneViews() { return [this.view]; }
  redraw() { if (this.p) this.p.requestUpdate(); }
  draw(target) {
    const r = lq.res, p = this.p, d = lq.datos;
    if (!r || !p || !d || !lq.lut) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const H = mediaSize.height, W = lqAnchoPerfil(mediaSize.width), right = mediaSize.width - 2;
      // barras: la ultima columna del mapa (mismo valor por fila, el tramo mas cargado, y misma escala de color e
      // intensidad minima), para que el color diga lo mismo que las franjas
      const paso = LQ_BANDA, filas = [], t = r.n - 1, tope = r.topeV > 0 ? r.topeV : 1, umbral = (lq.min / 100) * tope;
      let mx = 0;
      for (let y = 0; y < H; y += paso) {
        const tr = lqTramosEntre(p.series, y, y + paso);
        let v = 0;
        if (tr) for (let b = tr[0]; b <= tr[1]; b++) v = Math.max(v, r.gV[b * r.n + t]);
        if (v <= umbral) v = 0;
        filas.push([y, v]); mx = Math.max(mx, v);
      }
      ctx.save();
      ctx.fillStyle = C.surface; ctx.globalAlpha = 0.6;
      ctx.fillRect(right - W, 0, W, H);
      ctx.globalAlpha = 1;
      for (const [y, v] of filas) {
        if (v <= 0) continue;
        const i = Math.min(255, Math.floor(Math.min(1, v / tope) * 255)) * 4, l = lq.lut;
        ctx.fillStyle = `rgba(${l[i]},${l[i + 1]},${l[i + 2]},${Math.max(0.35, l[i + 3] / 255)})`;
        const wv = (v / mx) * W * 0.92;
        ctx.fillRect(right - wv, y, wv, paso - 1);
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
  if (arriba) linea(arriba, C.put, "Shorts");
  if (abajo) linea(abajo, C.call, "Longs");
}

function lqChart() {
  const L = window.LightweightCharts;
  lq.chart = L.createChart($("lqChart"), {
    autoSize: true, localization: { locale: "en-US" },
    timeScale: { rightOffset: 4, shiftVisibleRangeOnNewBar: false },
    crosshair: { mode: L.CrosshairMode.Normal },
    rightPriceScale: { scaleMargins: { top: 0.05, bottom: 0.05 } },
  });
  lq.serie = lq.chart.addSeries(L.CandlestickSeries, { priceLineVisible: true, lastValueVisible: true });
  lq.heat = new LqHeat(); lq.serie.attachPrimitive(lq.heat);
  lq.prof = new LqPerfil(); lq.serie.attachPrimitive(lq.prof);
  lq.hist = lq.chart.addSeries(L.HistogramSeries, { priceLineVisible: false, lastValueVisible: false,
    priceFormat: { type: "custom", formatter: (v) => lqUsd(Math.abs(v)) } }, 1);
  try { lq.chart.panes()[1].setHeight(110); } catch { /* version sin paneles redimensionables */ }
  lq.chart.subscribeCrosshairMove((prm) => { lqLeyenda(prm); lqTip(prm); });
}

function lqTema() {
  if (!lq.chart) return;
  const font = getComputedStyle(document.body).fontFamily;
  lq.chart.applyOptions({
    layout: { background: { type: "solid", color: C.surface }, textColor: C.muted, fontFamily: font, fontSize: 12,
      panes: { separatorColor: C.axis, separatorHoverColor: C.grid } },
    grid: { vertLines: { color: "rgba(0,0,0,0)" }, horzLines: { color: C.grid } },
    rightPriceScale: { borderColor: C.axis }, timeScale: { borderColor: C.axis },
    crosshair: { vertLine: { color: C.faint, labelBackgroundColor: C.surface }, horzLine: { color: C.faint, labelBackgroundColor: C.surface } },
  });
  lq.serie.applyOptions({ upColor: C.candle, downColor: C.surface, borderUpColor: C.candle, borderDownColor: C.candle,
    wickUpColor: C.candle, wickDownColor: C.candle, priceLineColor: C.spotline });
  if (lq.res) { lq.imgClave = ""; lqImagen(); lqSeries(false); lqLectura(); lq.heat.redraw(); }
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
  const t = Math.round(prm.logical);
  if (t < 0 || t >= r.n) return fuera();
  const fila = Math.floor(prm.point.y / LQ_BANDA), tr = lqTramosEntre(lq.serie, fila * LQ_BANDA, (fila + 1) * LQ_BANDA);
  if (!tr) return fuera();
  let mx = 0;
  for (let b = tr[0]; b <= tr[1]; b++) mx = Math.max(mx, r.gV[b * r.n + t]);
  if (!(mx > (lq.min / 100) * r.topeV)) return fuera();   // solo sobre lo que se ve pintado
  const lo = r.bordes[tr[0]], hi = r.bordes[tr[1] + 1], nv = r.niveles, porL = new Map();
  let suma = 0, nace0 = Infinity, nace1 = -Infinity, cortos = 0;
  for (let k = 0; k < nv.N; k++) {
    if (nv.p[k] < lo || nv.p[k] >= hi || t < nv.i[k] || t >= nv.toque[k]) continue;
    const a = LQ_MODELO.enMapa(r, k, t);
    if (!(a > 0)) continue;
    suma += a; porL.set(nv.L[k], (porL.get(nv.L[k]) || 0) + a);
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
  const pr = LQ_MODELO.presion(r, precio, pct), g = LQ_MODELO.grupos(r, precio, 3, pct * 2);
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
  $("lqIman").innerHTML = `Nearest liquidity: ${iman(g.arriba[0], "above")}, ${iman(g.abajo[0], "below")}.`;
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
  $("lqHow").textContent = "Each band is a price where open leveraged positions would be force-closed, estimated from new open interest, " +
    "the buy/sell split of volume and typical leverage (5x to 100x). Bands above the price are shorts, below are longs. " +
    "A band stays until price reaches it, and shrinks if open interest falls (those positions were closed). Price tends to travel " +
    "toward big bands: the forced orders feed the move. Hover a band to see its size, distance and leverage mix. The right profile is " +
    "what is still pending now; the bottom panel shows real liquidations (longs down, shorts up). " +
    (desde ? `Open interest of ${d.exs.map((e) => ex[e]).join(", ")} since ${desde}${r.desdeOI > 0 ? "; before that, estimated from volume" : ""}.`
      : "No open interest for this choice: estimated from volume.");
}

/* ---------- eventos */
$("lqSym").addEventListener("change", (e) => {
  const v = e.target.value.trim().toUpperCase();
  if (lq.merc && lq.merc.activos.some((a) => a.sym === v)) { lq.extra = 0; lqSet({ sym: v }); } else e.target.value = lq.sym;
});
$("lqQuick").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { lq.extra = 0; lqSet({ sym: b.dataset.v }); } });
$("lqTf").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { lq.extra = 0; lqSet({ tf: b.dataset.v }); } });
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
$("lqMin").addEventListener("input", (e) => { lq.min = +e.target.value; $("lqMinV").textContent = lq.min + "%"; lqImagen(); if (lq.heat) { lq.heat.redraw(); lq.prof.redraw(); } });
$("lqMin").addEventListener("change", () => store.set("lqMin3", lq.min));
$("lqPreset").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const x = LQ_PRESET[b.dataset.v];
  lq.extra = 0; lqSet({ tf: x.tf, levOff: new Set(x.levOff) });
});
// el desplegable de exchanges se cierra al pulsar fuera
document.addEventListener("click", (e) => { const d = $("lqExDrop"); if (d.open && !d.contains(e.target)) d.open = false; });
$("lqChart").addEventListener("mouseleave", () => { $("lqTip").hidden = true; });
$("lqMas").addEventListener("click", () => { lq.extra += 1; lqCargar(); });

// imagen del mapa como en pantalla (velas, franjas, perfil, lineas y panel de liquidaciones reales) con una cabecera:
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
  lqGrande(false);
  // el navegador solo deja entrar en pantalla completa desde un clic real: si lo rechaza, no pasa nada
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
});
// Expand: el panel ocupa la ventana dentro de la pagina, con el resto oscurecido (sin pantalla completa del sistema)
function lqGrande(on) {
  const el = $("lqPanel"), b = $("lqGrande");
  el.classList.toggle("lq-grande", on);
  document.body.classList.toggle("cx-noscroll", on);
  b.setAttribute("aria-pressed", String(on));
  b.textContent = on ? "Close" : "Expand";
}
$("lqGrande").addEventListener("click", () => lqGrande(!$("lqPanel").classList.contains("lq-grande")));
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("lqPanel").classList.contains("lq-grande")) lqGrande(false); });
