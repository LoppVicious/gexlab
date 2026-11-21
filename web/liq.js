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
const LQ_VIDA = { "0.5": "short", 1: "normal", 2: "long" };
const lq = {
  merc: null, sym: store.get("lqSym", "BTC"), tf: store.get("lqTf", "1D"),
  exOff: new Set(String(store.get("lqExOff", "")).split(",").filter(Boolean)),
  // por defecto sin 5x ni 10x: sus niveles quedan lejos, casi nunca se tocan y llenan el historial
  levOff: new Set(String(store.get("lqLevOff2", "5,10")).split(",").filter(Boolean)),
  min: +store.get("lqMin3", 15), vida: String(store.get("lqVida", "1")), extra: 0,
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
  $("lqEx").innerHTML = Object.keys(ex).filter((e) => a && a.ex[e]).map((e) => `<button role="checkbox" data-v="${e}" aria-checked="${!lq.exOff.has(e)}">${esc(ex[e])}</button>`).join("");
  $("lqLev").innerHTML = LQ_MODELO.APAL.map((x) => `<button role="checkbox" data-v="${x.L}" aria-checked="${!lq.levOff.has(String(x.L))}" title="Weight ${Math.round(x.w * 100)}%">${x.L}x</button>`).join("");
  $("lqMin").value = lq.min; $("lqMinV").textContent = lq.min + "%";
  $("lqVida").value = lq.vida;
  $("lqMas").hidden = !!LQ_TF[lq.tf].desde;
}

function lqSet(cambio) {
  Object.assign(lq, cambio);
  store.set("lqSym", lq.sym); store.set("lqTf", lq.tf); store.set("lqMin3", lq.min); store.set("lqVida", lq.vida);
  store.set("lqExOff", [...lq.exOff].join(",")); store.set("lqLevOff2", [...lq.levOff].join(","));
  lqControles();
  lqCargar();
}

/* ---------- datos */
async function lqPedir(kind, symbols, cfg, desde, hasta) {
  const q = new URLSearchParams({ kind, interval: cfg.iv, symbols: symbols.join(","), from: desde, to: hasta });
  const r = await fetch(`/api/liq?${q}`, { signal: lq.ctrl.signal });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `The data source answered ${r.status}`);
  return d;
}

async function lqCargar(forzar = false) {
  const a = lqActivo(), cfg = LQ_TF[lq.tf];
  if (!a || !lq.chart) return;
  const exs = Object.keys(a.ex).filter((e) => !lq.exOff.has(e));
  const syms = exs.flatMap((e) => a.ex[e]);
  const hasta = Math.ceil(Date.now() / 1000 / cfg.s) * cfg.s;
  const desde = cfg.desde || hasta - cfg.dias * 86400 * (1 + lq.extra);
  const clave = [a.sym, lq.tf, syms.join(","), desde].join("|");
  if (!forzar && clave === lq.clave && lq.datos && Date.now() - lq.at < 60000) { lqCalcular(); return; }
  // la misma carga ya en curso: no se cancela ni se repite (cada peticion gasta del cupo de Coinalyze, 40 por minuto,
  // aunque el navegador la cancele)
  if (!forzar && clave === lq.enCurso) return;
  if (lq.ctrl) lq.ctrl.abort();
  lq.enCurso = clave;
  lq.ctrl = new AbortController();
  $("lqCarga").hidden = false;
  lqMensaje("");
  try {
    const [ohlcv, oi, liq] = await Promise.all([
      lqPedir("ohlcv", [a.velas], cfg, desde, hasta),
      syms.length ? lqPedir("oi", syms, cfg, desde, hasta) : [],
      syms.length ? lqPedir("liq", syms, cfg, desde, hasta).catch((e) => (e.name === "AbortError" ? Promise.reject(e) : { error: e.message })) : [],
    ]);
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
    lq.datos = { velas, oi: oiCum, nivel, conOI, exs, sym: a.sym, tf: lq.tf };
    lqReales(liq);
    lq.clave = clave; lq.at = Date.now(); lq.resClave = "";
    lqCalcular(true);
    // liquidaciones reales que fallaron (casi siempre por el cupo de Coinalyze): se reintentan una vez a los 30 s
    clearTimeout(lq.reintento);
    if (liq && liq.error) lq.reintento = setTimeout(async () => {
      if (lq.clave !== clave) return;
      try { lqReales(await lqPedir("liq", syms, cfg, desde, hasta)); lqSeries(false); lqLectura(); } catch { /* sigue sin ellas */ }
    }, 30000);
  } catch (e) {
    if (e.name !== "AbortError") lqMensaje(e.message === "Failed to fetch" ? "The server is not responding." : e.message);
  } finally {
    if (lq.enCurso === clave) lq.enCurso = "";
    $("lqCarga").hidden = true;
  }
}

// liquidaciones reales por vela (suma de los perpetuos elegidos); si la peticion fallo, quedan sin dato y se avisa
function lqReales(liq) {
  const d = lq.datos, ts = d.velas.map((v) => v.t);
  d.liqError = liq && liq.error ? liq.error : "";
  const L = LQ_MODELO.sumar(d.liqError ? [] : liq, "l"), S = LQ_MODELO.sumar(d.liqError ? [] : liq, "s");
  const t0 = Math.min(...[...L.keys(), ...S.keys(), Infinity]);
  d.realL = ts.map((t) => (t >= t0 ? L.get(t) || 0 : null)); d.realS = ts.map((t) => (t >= t0 ? S.get(t) || 0 : null));
}

/* ---------- modelo y dibujo */
function lqCalcular(nuevos = false) {
  const d = lq.datos;
  if (!d) return;
  const cfg = LQ_TF[d.tf];
  const levs = LQ_MODELO.APAL.map((x) => ({ ...x, w: lq.levOff.has(String(x.L)) ? 0 : x.w }));
  const clave = [lq.clave, levs.map((x) => x.w).join(","), lq.vida].join("|");
  if (clave !== lq.resClave) {
    lq.res = LQ_MODELO.calcular(d.velas, d.oi, { levs, vida: cfg.vida * +lq.vida, bins: 600, nivel: d.nivel });
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
  if (nuevos) {
    const n = d.velas.length, ver = LQ_TF[d.tf].ver;
    // margen a la derecha: el perfil queda despues de la ultima vela, sin taparla
    lq.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - ver), to: n + Math.ceil(Math.min(n, ver) * 0.16) });
  }
}

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
}

// tramos de precio (de menor a mayor) que caen entre dos filas de pantalla
function lqTramosEntre(serie, yArriba, yAbajo) {
  const pA = serie.coordinateToPrice(yArriba), pB = serie.coordinateToPrice(yAbajo);
  if (!(pA > 0) || !(pB > 0)) return null;
  const B = lq.res.B, hi = Math.floor((Math.log(pA) - lq.lLo) / lq.paso), lo = Math.floor((Math.log(pB) - lq.lLo) / lq.paso);
  if (hi < 0 || lo >= B) return null;
  return [Math.max(0, Math.min(lo, hi)), Math.min(B - 1, Math.max(lo, hi))];
}

// mapa de la vista, como Bitunix: filas de LQ_BANDA pixeles con la suma de los niveles vivos de sus tramos de precio
// (a su tamano al nacer, r.gV) y una columna por vela visible (o por pixel si hay mas velas que pixeles), con 1 px de
// separacion entre filas. Color frente al maximo de lo que se ve: azul tenue lo flojo, verde, amarillo y rojo
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
  let tope = 0;
  for (let f = 0; f < nb; f++) {
    const tr = lqTramosEntre(serie, f * LQ_BANDA, (f + 1) * LQ_BANDA);
    if (!tr) continue;
    for (let k = 0; k < outW; k++) {
      const t = colDe[k];
      let v = 0;
      for (let b = tr[0]; b <= tr[1]; b++) v += g[b * n + t];
      val[f * outW + k] = v;
      if (v > tope) tope = v;
    }
  }
  // escala frente al maximo de lo visible: lo normal queda bajo (azul tenue) y solo destacan los grupos
  if (!(tope > 0)) tope = 1;
  const umbral = (lq.min / 100) * tope;
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

// perfil de lo pendiente ahora, por intensidad (la misma paleta), con lo acumulado desde el precio hacia arriba
// (cortos que se liquidarian si sube) y hacia abajo (largos si baja)
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
      const H = mediaSize.height, W = Math.round(Math.min(170, Math.max(70, mediaSize.width * 0.14))), right = mediaSize.width - 2;
      const precio = d.velas[d.velas.length - 1].c, yP = p.series.priceToCoordinate(precio);
      const paso = LQ_BANDA, filas = [];
      let mx = 0;
      for (let y = 0; y < H; y += paso) {
        const tr = lqTramosEntre(p.series, y, y + paso);
        let v = 0;
        if (tr) for (let b = tr[0]; b <= tr[1]; b++) v += r.finL[b] + r.finS[b];
        filas.push([y, v]); mx = Math.max(mx, v);
      }
      if (!mx) return;
      ctx.save();
      ctx.fillStyle = C.surface; ctx.globalAlpha = 0.6;
      ctx.fillRect(right - W, 0, W, H);
      ctx.globalAlpha = 1;
      for (const [y, v] of filas) {
        if (v <= 0) continue;
        const i = Math.min(255, Math.floor((v / mx) * 255)) * 4, l = lq.lut;
        ctx.fillStyle = `rgba(${l[i]},${l[i + 1]},${l[i + 2]},${Math.max(0.35, l[i + 3] / 255)})`;
        const wv = (v / mx) * W * 0.92;
        ctx.fillRect(right - wv, y, wv, paso - 1);
      }
      // acumulados desde el precio: arriba (cortos, verde) y abajo (largos, rojo), escala propia
      if (yP != null) {
        const arriba = filas.filter(([y]) => y < yP).reverse(), abajo = filas.filter(([y]) => y >= yP);
        const acum = (lista) => { let s = 0; return lista.map(([y, v]) => [y, (s += v)]); };
        const cA = acum(arriba), cB = acum(abajo), cm = Math.max(1, ...cA.map((x) => x[1]), ...cB.map((x) => x[1]));
        for (const [lista, col] of [[cA, C.put], [cB, C.call]]) {
          if (!lista.length) continue;
          ctx.beginPath(); ctx.moveTo(right - W, yP);
          for (const [y, s] of lista) ctx.lineTo(right - W + (s / cm) * W, y);
          ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.globalAlpha = 0.9; ctx.stroke();
          ctx.lineTo(right - W, lista[lista.length - 1][0]); ctx.closePath();
          ctx.fillStyle = col; ctx.globalAlpha = 0.12; ctx.fill();
        }
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
  lq.chart.subscribeCrosshairMove(lqLeyenda);
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

/* ---------- lectura debajo del grafico */
function lqLectura() {
  const d = lq.datos, r = lq.res, cfg = LQ_TF[d.tf], n = d.velas.length;
  const precio = d.velas[n - 1].c, pct = d.tf === "1D" ? 0.15 : d.tf === "4h" ? 0.1 : 0.05;
  const pr = LQ_MODELO.presion(r, precio, pct), g = LQ_MODELO.grupos(r, precio, 3, pct * 2);
  lqNivelesClave(g);
  let veredicto, cls = "";
  if (pr.ratio == null || (pr.arriba + pr.abajo) === 0) veredicto = "No clear pull";
  else if (pr.ratio >= 1.5) { veredicto = "Pull up: more short liquidations above"; cls = "pos"; }
  else if (pr.ratio <= 1 / 1.5) { veredicto = "Pull down: more long liquidations below"; cls = "neg"; }
  else veredicto = "No clear pull: liquidity on both sides";
  const fila = (x) => `<div class="lq-g"><span>${lqPx(x.p)}</span><span class="lq-d">${cxPct((x.p / precio - 1) * 100)}</span><b>${lqUsd(x.a)}</b></div>`;
  // acierto solo donde hay OI: antes, el mapa sale del volumen y no es el modelo que se juzga
  const i0 = Math.max(0, r.desdeOI);
  const aj = LQ_MODELO.ajuste(d.realL.map((x, i) => (x == null || i < i0 ? 0 : r.predL[i] + r.predS[i])),
    d.realL.map((x, i) => (x == null || i < i0 ? null : x + d.realS[i])));
  const calidad = d.liqError ? "real liquidations unavailable right now (the data source is busy); retrying in 30 seconds"
    : !aj ? "not enough real liquidation data" : aj.r >= 0.5 ? "good" : aj.r >= 0.3 ? "fair" : "weak";
  const desde = r.desdeOI >= 0 ? new Date(d.velas[r.desdeOI].t * 1000).toISOString().slice(0, 10) : null;
  const ex = (lq.merc.exchanges || {});
  $("lqRead").innerHTML = `
    <div class="lq-card"><span class="kl">Within ${Math.round(pct * 100)}% of the price</span><b class="${cls}">${veredicto}</b>
      <span class="ks">Shorts above ${lqUsd(pr.arriba)}, longs below ${lqUsd(pr.abajo)}. Price tends to travel toward the heavier side: those forced orders feed the move.</span></div>
    <div class="lq-card"><span class="kl">Biggest clusters above (short liquidations)</span>${g.arriba.map(fila).join("") || "<span class='ks'>None</span>"}</div>
    <div class="lq-card"><span class="kl">Biggest clusters below (long liquidations)</span>${g.abajo.map(fila).join("") || "<span class='ks'>None</span>"}</div>
    <div class="lq-card"><span class="kl">Model against real liquidations</span><b>${aj ? "r = " + fmtNum(aj.r, 2) : "—"}</b>
      <span class="ks">${aj ? `Correlation between the liquidations the model expected in each candle and the real ones (${fmtNum(aj.n)} candles with open interest): ${calidad}.` : calidad}</span></div>`;
  $("lqCap").textContent = `${d.sym}, ${cfg.nombre} candles. Estimated liquidation levels of open leveraged positions: brighter means more size. ` +
    (desde ? `Open interest of ${d.exs.map((e) => ex[e]).join(", ")} since ${desde}${r.desdeOI > 0 ? "; before that, volume-based" : ""}.` : "No open interest for this choice: volume-based estimate.") +
    (r.escalado ? " Sizes scaled so the live levels add up to the open interest of each candle." : "") +
    ` Position memory: half-life of ${fmtNum(cfg.vida * +lq.vida)} candles. Bottom panel: real liquidations (longs down, shorts up).`;
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
  Object.assign(lq, { levOff: s }); store.set("lqLevOff2", [...s].join(",")); lqControles(); lqCalcular();
});
$("lqMin").addEventListener("input", (e) => { lq.min = +e.target.value; $("lqMinV").textContent = lq.min + "%"; lqImagen(); if (lq.heat) { lq.heat.redraw(); lq.prof.redraw(); } });
$("lqMin").addEventListener("change", () => store.set("lqMin3", lq.min));
$("lqVida").addEventListener("change", (e) => { lq.vida = e.target.value; store.set("lqVida", lq.vida); lqCalcular(); });
$("lqMas").addEventListener("click", () => { lq.extra += 1; lqCargar(); });
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
