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
const LQ_VIDA = { "0.5": "short", 1: "normal", 2: "long" };
const lq = {
  merc: null, sym: store.get("lqSym", "BTC"), tf: store.get("lqTf", "1D"),
  exOff: new Set(String(store.get("lqExOff", "")).split(",").filter(Boolean)),
  levOff: new Set(String(store.get("lqLevOff", "")).split(",").filter(Boolean)),
  min: +store.get("lqMin", 20), vida: String(store.get("lqVida", "1")), extra: 0,
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
  store.set("lqSym", lq.sym); store.set("lqTf", lq.tf); store.set("lqMin", lq.min); store.set("lqVida", lq.vida);
  store.set("lqExOff", [...lq.exOff].join(",")); store.set("lqLevOff", [...lq.levOff].join(","));
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
  if (lq.ctrl) lq.ctrl.abort();
  lq.ctrl = new AbortController();
  $("lqCarga").hidden = false;
  lqMensaje("");
  try {
    const [ohlcv, oi, liq] = await Promise.all([
      lqPedir("ohlcv", [a.velas], cfg, desde, hasta),
      syms.length ? lqPedir("oi", syms, cfg, desde, hasta) : [],
      syms.length ? lqPedir("liq", syms, cfg, desde, hasta).catch(() => []) : [],
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
    const L = LQ_MODELO.sumar(liq, "l"), S = LQ_MODELO.sumar(liq, "s");
    const t0 = Math.min(...[...L.keys(), ...S.keys(), Infinity]);
    const realL = ts.map((t) => (t >= t0 ? L.get(t) || 0 : null)), realS = ts.map((t) => (t >= t0 ? S.get(t) || 0 : null));
    lq.datos = { velas, oi: oiCum, nivel, realL, realS, conOI, exs, sym: a.sym, tf: lq.tf };
    lq.clave = clave; lq.at = Date.now(); lq.resClave = "";
    lqCalcular(true);
  } catch (e) {
    if (e.name !== "AbortError") lqMensaje(e.message === "Failed to fetch" ? "The server is not responding." : e.message);
  } finally { $("lqCarga").hidden = true; }
}

/* ---------- modelo y dibujo */
function lqCalcular(nuevos = false) {
  const d = lq.datos;
  if (!d) return;
  const cfg = LQ_TF[d.tf];
  const levs = LQ_MODELO.APAL.map((x) => ({ ...x, w: lq.levOff.has(String(x.L)) ? 0 : x.w }));
  const clave = [lq.clave, levs.map((x) => x.w).join(","), lq.vida].join("|");
  if (clave !== lq.resClave) {
    lq.res = LQ_MODELO.calcular(d.velas, d.oi, { levs, vida: cfg.vida * +lq.vida, bins: 240, nivel: d.nivel });
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
    lq.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - ver), to: n + 4 });
  }
}

// imagen de una casilla por pixel (vela x tramo de precio), con la escala del tema
function lqHex(c) { const n = parseInt(String(c).slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function lqImagen() {
  if (!lq.res) return;
  const r = lq.res, clave = [lq.resClave, lq.min, document.documentElement.dataset.theme].join("|");
  if (clave === lq.imgClave && lq.img) return;
  const { n, B, gL, gS } = r;
  // escala: percentil 99 de las casillas con algo (muestra), para que un pico no apague el resto
  const muestra = [];
  const paso = Math.max(1, Math.floor((n * B) / 40000));
  for (let k = 0; k < n * B; k += paso) { const v = gL[k] + gS[k]; if (v > 0) muestra.push(v); }
  muestra.sort((a, b) => a - b);
  const tope = muestra.length ? muestra[Math.floor(muestra.length * 0.995)] : 1, umbral = (lq.min / 100) * tope;
  const paradas = [C.purple, C.accent, C.amber, C.call].map(lqHex);
  const cv = document.createElement("canvas");
  cv.width = n; cv.height = B;
  const ctx = cv.getContext("2d"), im = ctx.createImageData(n, B), px = im.data;
  for (let b = 0; b < B; b++) {
    const fila = B - 1 - b;
    for (let t = 0; t < n; t++) {
      const v = gL[b * n + t] + gS[b * n + t];
      if (!(v > umbral)) continue;
      // lineal: los grupos grandes destacan y lo flojo queda tenue (transparencia segun la intensidad)
      const u = Math.min(1, v / tope), x = u * (paradas.length - 1), i0 = Math.min(paradas.length - 2, Math.floor(x)), f = x - i0;
      const a = paradas[i0], c = paradas[i0 + 1], o = (fila * n + t) * 4;
      px[o] = a[0] + (c[0] - a[0]) * f; px[o + 1] = a[1] + (c[1] - a[1]) * f; px[o + 2] = a[2] + (c[2] - a[2]) * f;
      px[o + 3] = 35 + 215 * Math.pow(u, 0.6);
    }
  }
  ctx.putImageData(im, 0, 0);
  lq.img = cv; lq.imgClave = clave;
}

class LqHeat {
  constructor() { this.p = null; this.view = { zOrder: () => "bottom", renderer: () => ({ draw: (t) => this.draw(t) }) }; }
  attached(p) { this.p = p; }
  detached() { this.p = null; }
  paneViews() { return [this.view]; }
  redraw() { if (this.p) this.p.requestUpdate(); }
  draw(target) {
    const r = lq.res, img = lq.img, p = this.p;
    if (!r || !img || !p) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const ts = lq.chart.timeScale(), x0 = ts.logicalToCoordinate(0), x1 = ts.logicalToCoordinate(1);
      if (x0 == null || x1 == null) return;
      const w = x1 - x0, left = x0 - w / 2, ancho = w * r.n;
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      for (let b = 0; b < r.B; b++) {
        const yA = p.series.priceToCoordinate(r.bordes[b + 1]), yB = p.series.priceToCoordinate(r.bordes[b]);
        if (yA == null || yB == null || yB < 0 || yA > mediaSize.height) continue;
        ctx.drawImage(img, 0, r.B - 1 - b, r.n, 1, left, yA, ancho, Math.max(1, yB - yA));
      }
      ctx.restore();
    });
  }
}

// perfil de lo pendiente ahora: largos (por debajo, se liquidan al bajar) y cortos (por encima)
class LqPerfil {
  constructor() { this.p = null; this.view = { zOrder: () => "top", renderer: () => ({ draw: (t) => this.draw(t) }) }; }
  attached(p) { this.p = p; }
  detached() { this.p = null; }
  paneViews() { return [this.view]; }
  redraw() { if (this.p) this.p.requestUpdate(); }
  draw(target) {
    const r = lq.res, p = this.p;
    if (!r || !p) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const W = Math.round(Math.min(150, Math.max(70, mediaSize.width * 0.12))), right = mediaSize.width - 2;
      let mx = 0;
      const filas = [];
      for (let b = 0; b < r.B; b++) {
        const yA = p.series.priceToCoordinate(r.bordes[b + 1]), yB = p.series.priceToCoordinate(r.bordes[b]);
        if (yA == null || yB == null || yB < 0 || yA > mediaSize.height) continue;
        filas.push([yA, yB, r.finL[b], r.finS[b]]);
        mx = Math.max(mx, r.finL[b] + r.finS[b]);
      }
      if (!mx) return;
      ctx.save();
      ctx.fillStyle = C.surface; ctx.globalAlpha = 0.55;
      ctx.fillRect(right - W, 0, W, mediaSize.height);
      for (const [yA, yB, l, s] of filas) {
        const h = Math.max(1, yB - yA - 0.5), wl = (l / mx) * W, ws = (s / mx) * W;
        ctx.globalAlpha = 0.85;
        if (wl > 0.3) { ctx.fillStyle = C.call; ctx.fillRect(right - wl, yA, wl, h); }
        if (ws > 0.3) { ctx.fillStyle = C.put; ctx.fillRect(right - wl - ws, yA, ws, h); }
      }
      ctx.restore();
    });
  }
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
  if (lq.res) { lq.imgClave = ""; lqImagen(); lqSeries(false); lq.heat.redraw(); }
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
  const pr = LQ_MODELO.presion(r, precio, pct), g = LQ_MODELO.grupos(r, precio, 3);
  let veredicto, cls = "";
  if (pr.ratio == null || (pr.arriba + pr.abajo) === 0) veredicto = "No clear pull";
  else if (pr.ratio >= 1.5) { veredicto = "Pull up: more short liquidations above"; cls = "pos"; }
  else if (pr.ratio <= 1 / 1.5) { veredicto = "Pull down: more long liquidations below"; cls = "neg"; }
  else veredicto = "No clear pull: liquidity on both sides";
  const fila = (x) => `<div class="lq-g"><span>${lqPx(x.p)}</span><span class="lq-d">${cxPct((x.p / precio - 1) * 100)}</span><b>${lqUsd(x.a)}</b></div>`;
  const aj = LQ_MODELO.ajuste(d.realL.map((x, i) => (x == null ? 0 : r.predL[i] + r.predS[i])), d.realL.map((x, i) => (x == null ? null : x + d.realS[i])));
  const calidad = !aj ? "not enough real liquidation data" : aj.r >= 0.5 ? "good" : aj.r >= 0.3 ? "fair" : "weak";
  const desde = r.desdeOI >= 0 ? new Date(d.velas[r.desdeOI].t * 1000).toISOString().slice(0, 10) : null;
  const ex = (lq.merc.exchanges || {});
  $("lqRead").innerHTML = `
    <div class="lq-card"><span class="kl">Within ${Math.round(pct * 100)}% of the price</span><b class="${cls}">${veredicto}</b>
      <span class="ks">Shorts above ${lqUsd(pr.arriba)}, longs below ${lqUsd(pr.abajo)}. Price tends to travel toward the heavier side: those forced orders feed the move.</span></div>
    <div class="lq-card"><span class="kl">Biggest clusters above (short liquidations)</span>${g.arriba.map(fila).join("") || "<span class='ks'>None</span>"}</div>
    <div class="lq-card"><span class="kl">Biggest clusters below (long liquidations)</span>${g.abajo.map(fila).join("") || "<span class='ks'>None</span>"}</div>
    <div class="lq-card"><span class="kl">Model against real liquidations</span><b>${aj ? "r = " + fmtNum(aj.r, 2) : "—"}</b>
      <span class="ks">${aj ? `Correlation between the liquidations the model expected in each candle and the real ones (${fmtNum(aj.n)} candles): ${calidad}.` : calidad}</span></div>`;
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
  Object.assign(lq, { levOff: s }); store.set("lqLevOff", [...s].join(",")); lqControles(); lqCalcular();
});
$("lqMin").addEventListener("input", (e) => { lq.min = +e.target.value; $("lqMinV").textContent = lq.min + "%"; lqImagen(); if (lq.heat) lq.heat.redraw(); });
$("lqMin").addEventListener("change", () => store.set("lqMin", lq.min));
$("lqVida").addEventListener("change", (e) => { lq.vida = e.target.value; store.set("lqVida", lq.vida); lqCalcular(); });
$("lqMas").addEventListener("click", () => { lq.extra += 1; lqCargar(); });
$("lqFull").addEventListener("click", () => {
  const el = $("lqPanel");
  if (document.fullscreenElement) document.exitFullscreen(); else if (el.requestFullscreen) el.requestFullscreen();
});
