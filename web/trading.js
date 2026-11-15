"use strict";
/* ============================================================ Trading Window
   El mapa TRACE a pantalla completa sobre Lightweight Charts (TradingView, Apache 2.0; el logo enlaza a su web, como
   pide la licencia), pensada para operar en el dia. Usa lo que ya carga la app (state.heat del mapa y state.data de
   los niveles): el motor publica cada minuto los indices en tiempo real y la ventana recarga como el Auto (cada minuto esos,
   cada 5 el resto). Entre recargas, la vela en curso se mueve con /api/precio (Tradier, compartido 5 s en el Worker).
   - Panel 0: mapa (capa propia bajo las velas), barras de gamma por strike a la derecha, niveles como escalones con su
     historia en la sesion (d.levels_intraday), referencias (cierre, maximo y minimo de ayer, apertura, rango de los
     primeros 30 min), eventos macro de hoy como lineas verticales y marcas donde el cierre de una vela cruza un nivel.
   - Panel 1: flujo de opciones de la sesion (/api/flow, como la pagina Flow).
   - Lateral: plan de sesion (regimen, rango que queda, niveles cercanos en sigmas, cobertura de los dealers si el
     precio se mueve, strike 0DTE mas grande cerca), eventos de hoy, flujo y referencias.
   Horas: el eje de LWC va en UTC, asi que cada hora de Nueva York se pasa como si fuera UTC (twT). Todos los puntos de
   todas las series caen en la rejilla de velas (twSnap): asi el indice logico de cada vela sirve para colocar el mapa. */

const TW_LIB = "https://cdn.jsdelivr.net/npm/lightweight-charts@5.2.1/dist/lightweight-charts.standalone.production.js";
const TW_POLL_MS = 5000;
const TW_OR_MIN = 30;   // rango de apertura: primeros 30 min
// formato de precios del panel 0 (cada serie el suyo: el del panel de flujo va en $)
const TW_PRICE = { type: "custom", minMove: 0.01, formatter: (p) => fmtNum(p, 2) };
const TW_NY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit",
  day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
// columna de cada nivel en las filas de d.levels_intraday: [hora, spot, call_wall, put_wall, flip, vt]
const TW_LV_COL = { call_wall: 2, put_wall: 3, flip: 4, vt: 5 };
const TW_LV_SHORT = { call_wall: "CW", put_wall: "PW", flip: "FLIP", vt: "VT" };
const twin = {
  el: null, chart: null, series: null, heat: null, bars: null, events: null, markers: null, lvS: {}, refLines: [],
  flowS: null, grid: null, hm: null, lvPts: {},
  ticks: new Map(), tickKey: "", quote: null, quoteAt: 0, live: false, noLive: new Set(), lastPx: null,
  flow: null, flowKey: "", flowAt: 0, ev: null, evAt: 0,
  poll: null, timer: null, lib: null,
  showBars: store.get("twBars", "1") === "1", showRefs: store.get("twRefs", "1") === "1",
  sound: store.get("twSound", "0") === "1",
};

function twLoadLib() {
  if (window.LightweightCharts) return Promise.resolve();
  if (!twin.lib) twin.lib = new Promise((ok, ko) => {
    const s = document.createElement("script");
    s.src = TW_LIB; s.async = true;
    s.onload = () => ok();
    s.onerror = () => { twin.lib = null; ko(new Error("Could not load the chart library")); };
    document.head.appendChild(s);
  });
  return twin.lib;
}

/* ------------------------------------------------------------ horas y rejilla */
// hora de Nueva York "HH:MM" del dia `day` como segundos UTC (el eje de la libreria no tiene zona horaria)
function twT(day, hhmm) {
  const [y, m, d] = day.split("-").map(Number), [h, mi] = hhmm.split(":").map(Number);
  return Date.UTC(y, m - 1, d, h, mi) / 1000;
}
function twHHMM(min) { return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`; }
function twMinOf(time) { return Math.round((time % 86400) / 60); }
// minuto -> tiempo de la vela de la rejilla que lo contiene (dentro de la rejilla)
function twSnap(min) {
  const g = twin.grid;
  const m = Math.min(Math.max(Math.floor((min - g.start) / g.slot) * g.slot + g.start, g.start), g.end - g.slot);
  return twT(twin.hm.session, twHHMM(m));
}
// x de un minuto en el panel (cada vela ocupa media barra a cada lado de su indice logico)
function twX(min) {
  const ts = twin.chart.timeScale(), g = twin.grid;
  const x0 = ts.logicalToCoordinate(0), x1 = ts.logicalToCoordinate(1);
  if (x0 == null || x1 == null) return null;
  return x0 + ((min - g.start) / g.slot - 0.5) * (x1 - x0);
}
function twAlpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
function twNow() {
  const p = Object.fromEntries(TW_NY.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute };
}

/* ------------------------------------------------------------ capas propias del panel de precios */
// mapa (debajo de todo) con sus curvas de nivel
class TwHeat {
  constructor() {
    this.p = null; this.img = null; this.url = ""; this.hm = null; this.contours = [];
    this.view = { zOrder: () => "bottom", renderer: () => ({ draw: (t) => this.draw(t) }) };
  }
  attached(p) { this.p = p; }
  detached() { this.p = null; }
  paneViews() { return [this.view]; }
  // rango de precios del autoajuste: las velas (la libreria las suma) y el rango esperado
  autoscaleInfo() {
    const hm = this.hm, d = state.data;
    if (!hm) return null;
    const spot = twPrice();
    const sg = (d && d.moves && d.moves.d1 && d.moves.d1.sigma) || spot * 0.01;
    return { priceRange: { minValue: spot - sg, maxValue: spot + sg } };
  }
  set(hm) {
    this.hm = hm;
    if (!state.heatImg) state.heatImg = buildHeatImage(hm);
    const { url, contours } = state.heatImg;
    this.contours = contours;
    if (url !== this.url) {
      this.url = url;
      const img = new Image();
      img.onload = () => { if (this.url === url) { this.img = img; this.redraw(); } };
      img.src = url;
    }
    this.redraw();
  }
  redraw() { if (this.p) this.p.requestUpdate(); }
  draw(target) {
    const hm = this.hm, p = this.p;
    if (!hm || !twin.grid || !p || !this.img || !hm.times.length) return;
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      const s = p.series, nt = hm.times.length;
      const stepM = nt > 1 ? minutesOf(hm.times[1]) - minutesOf(hm.times[0]) : 5;
      const left = twX(minutesOf(hm.times[0])), right = twX(minutesOf(hm.times[nt - 1]) + stepM);
      const fLo = hm.prices[0], fHi = hm.prices[hm.prices.length - 1];
      const top = s.priceToCoordinate(fHi), bot = s.priceToCoordinate(fLo);
      if (left == null || top == null || bot == null) return;
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.img, left, top, right - left, bot - top);
      const nr = hm.prices.length;
      const X = (c) => left + ((c + 0.5) / nt) * (right - left), Y = (r) => top + (1 - r / (nr - 1)) * (bot - top);
      ctx.lineCap = "round";
      for (const { f, segs } of this.contours) {
        if (!segs.length) continue;
        ctx.strokeStyle = C.hi; ctx.globalAlpha = f === 0 ? 0.7 : 0.28; ctx.lineWidth = f === 0 ? 1.3 : 0.8;
        ctx.beginPath();
        for (const [c0, r0, c1, r1] of segs) { ctx.moveTo(X(c0), Y(r0)); ctx.lineTo(X(c1), Y(r1)); }
        ctx.stroke();
      }
      ctx.restore();
    });
  }
}

// barras por strike pegadas a la escala de precios (las mismas que el mapa de la app: GEX, OI o neta, segun Ajustes)
class TwBars {
  constructor() { this.p = null; this.view = { zOrder: () => "bottom", renderer: () => ({ draw: (t) => this.draw(t) }) }; }
  attached(p) { this.p = p; }
  detached() { this.p = null; }
  paneViews() { return [this.view]; }
  redraw() { if (this.p) this.p.requestUpdate(); }
  draw(target) {
    const d = state.data, hm = twin.hm, p = this.p;
    if (!twin.showBars || !d || !hm || !p || !d.strikes) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const s = p.series, H = mediaSize.height;
      const pHi = s.coordinateToPrice(0), pLo = s.coordinateToPrice(H);
      if (pHi == null || pLo == null || pHi <= pLo) return;
      const sb = mapSideBars(d, hm, pLo, pHi, Math.max(16, Math.floor(H / 9)));
      if (!sb.ks.length) return;
      const W = Math.round(Math.min(200, Math.max(110, mediaSize.width * 0.16)));
      const right = mediaSize.width - 4, cx = right - W / 2, half = W / 2 - 2;
      const pxPer = H / (pHi - pLo), bh = Math.max(2, Math.min(10, sb.step * pxPer * 0.75));
      ctx.save();
      ctx.strokeStyle = C.axis; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, H); ctx.stroke();
      sb.ks.forEach((k, i) => {
        const y = s.priceToCoordinate(k);
        if (y == null) return;
        for (const [v, side] of sb.split ? [[sb.right[i], 1], [-sb.left[i], -1]] : [[sb.right[i], 0]]) {
          if (!v) continue;
          const w = (Math.abs(v) / sb.max) * half, pos = side ? side > 0 : v > 0;
          ctx.fillStyle = pos ? C.pos : C.neg; ctx.globalAlpha = 0.9;
          ctx.fillRect(pos ? cx : cx - w, y - bh / 2, Math.max(1, w), bh);
        }
      });
      ctx.globalAlpha = 1; ctx.fillStyle = C.faint; ctx.font = `11px ${getComputedStyle(document.body).fontFamily}`;
      ctx.textAlign = "center";
      ctx.fillText(sb.label.length > 26 ? sb.label.slice(0, 25) + "…" : sb.label, cx, H - 8);
      ctx.restore();
    });
  }
}

// eventos macro de hoy: linea vertical y nombre arriba
class TwEvents {
  constructor() { this.p = null; this.list = []; this.view = { zOrder: () => "normal", renderer: () => ({ draw: (t) => this.draw(t) }) }; }
  attached(p) { this.p = p; }
  detached() { this.p = null; }
  paneViews() { return [this.view]; }
  set(list) { this.list = list; if (this.p) this.p.requestUpdate(); }
  draw(target) {
    if (!this.list.length || !twin.grid) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();
      ctx.font = `600 11px ${getComputedStyle(document.body).fontFamily}`;
      ctx.textBaseline = "top";
      let lastX = -1e9, row = 0;
      for (const e of this.list) {
        const x = twX(minutesOf(e.time));
        if (x == null || x < 0 || x > mediaSize.width) continue;
        const col = e.imp >= 3 ? C.amber : C.faint;
        ctx.strokeStyle = col; ctx.globalAlpha = 0.85; ctx.setLineDash([3, 4]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, mediaSize.height); ctx.stroke();
        ctx.setLineDash([]);
        row = x - lastX < 120 ? row + 1 : 0; lastX = x;
        const txt = `${e.time} ${e.name}`, w = ctx.measureText(txt).width + 10, y = 34 + row * 20;
        ctx.globalAlpha = 1; ctx.fillStyle = C.surface; ctx.fillRect(x + 3, y, w, 17);
        ctx.strokeStyle = col; ctx.strokeRect(x + 3.5, y + 0.5, w - 1, 16);
        ctx.fillStyle = col; ctx.fillText(txt, x + 8, y + 3);
      }
      ctx.restore();
    });
  }
}

/* ------------------------------------------------------------ velas: las del motor y, despues, las del precio en vivo */
function twBars(hm) {
  const raw = (hm.candles || []).slice();
  const lastOff = raw.length ? raw[raw.length - 1][0] : "";
  if (twin.tickKey === `${hm.symbol}|${hm.session}`)
    for (const [t, b] of [...twin.ticks].sort((a, b) => (a[0] < b[0] ? -1 : 1))) if (t > lastOff) raw.push([t, ...b]);
  const { list, slot } = mapCandles(raw, +state.mapCandle || 5);
  const first = Math.min(minutesOf(hm.times[0] || "09:30"), list.length ? minutesOf(list[0][0]) : Infinity);
  const start = Math.floor(first / slot) * slot, end = 16 * 60;
  const byT = new Map(list.map((b) => [b[0], b]));
  const fade = { color: twAlpha(C.candle, 0.35), borderColor: twAlpha(C.candle, 0.35), wickColor: twAlpha(C.candle, 0.35) };
  const data = [];
  // rejilla continua hasta el cierre (huecos vacios): el mapa se ve entero, como en TRACE
  for (let m = start; m < end; m += slot) {
    const k = twHHMM(m), b = byT.get(k), time = twT(hm.session, k);
    if (!b) { data.push({ time }); continue; }
    const bar = { time, open: b[1], high: b[2], low: b[3], close: b[4] };
    data.push(hm.pre_src && k < "09:30" ? Object.assign(bar, fade) : bar);
  }
  return { data, start, end, slot, list, last: list.length ? list[list.length - 1] : null };
}

// precio de referencia: el vivo si lo hay; si no, la ultima vela de la sesion o el spot del calculo
function twPrice() {
  const hm = twin.hm, q = twin.quote;
  if (twin.live && q && Date.now() - twin.quoteAt < 3 * TW_POLL_MS) return q.last;
  if (twin.grid && twin.grid.last && hm && (hm.live || hm.kind === "last")) return twin.grid.last[4];
  return hm ? hm.spot : state.data ? state.data.spot : 0;
}

/* ------------------------------------------------------------ ventana */
function twBuild() {
  const el = document.createElement("div");
  el.id = "twin"; el.className = "twin"; el.hidden = true;
  el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "Trading window");
  el.innerHTML = `
  <header class="tw-top">
    <div class="tw-syms" id="twSyms" role="group" aria-label="Ticker"></div>
    <div class="tw-quote"><span class="tw-sym" id="twSym"></span><b class="tw-px" id="twPx"></b><span class="tw-chg" id="twChg"></span>
      <span class="tw-live" id="twLive"><i aria-hidden="true"></i><span></span></span></div>
    <div class="tw-ctl">
      <div class="tw-seg" id="twDte" role="group" aria-label="Expirations"></div>
      <div class="tw-seg" id="twCandle" role="group" aria-label="Candle interval"></div>
      <div class="tw-seg" id="twLens" role="group" aria-label="Map lens"></div>
      <div class="tw-seg" id="twTg" role="group" aria-label="Show"></div>
      <button class="ghost tw-ib" id="twFull" title="Full screen (F)" aria-label="Full screen"><svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4"/></svg></button>
      <button class="ghost tw-ib" id="twClose" title="Close (Esc)" aria-label="Close"><svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15"/></svg></button>
    </div>
  </header>
  <div class="tw-body">
    <div class="tw-main"><div class="tw-chart" id="twChart"></div><div class="tw-legend" id="twLegend"></div>
      <div class="tw-flowleg" id="twFlowLeg"></div><div class="tw-alerts" id="twAlerts" aria-live="polite"></div>
      <div class="tw-msg" id="twMsg" hidden></div></div>
    <aside class="tw-side" id="twSide"></aside>
  </div>`;
  document.body.appendChild(el);
  twin.el = el;
  $("twClose").addEventListener("click", twClose);
  $("twFull").addEventListener("click", twFullscreen);
  $("twSyms").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-s]");
    if (!b || b.dataset.s === state.symbol) return;
    $("symbol").value = b.dataset.s;
    twin.quote = null; twin.live = false; twin.lastPx = null;
    load();
  });
  for (const id of ["twCandle", "twLens"]) $(id).addEventListener("click", (e) => {
    const b = e.target.closest("button[data-k]");
    if (!b || state[b.dataset.k] === b.dataset.v) return;
    setChoose(b.dataset.k, b.dataset.v);
    twSync(true);   // las velas no recargan el mapa; la lente si, y vuelve a llamar a twSync al llegar
  });
  // vencimientos: 0DTE o el filtro de antes (el deslizador de la app hace la recarga)
  $("twDte").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]");
    if (!b) return;
    const v = b.dataset.v === "0" ? "0" : store.get("twDteAll", "45");
    if (v === state.dte) return;
    if (state.dte !== "0") store.set("twDteAll", state.dte);
    const r = $("dteRange");
    r.value = String(DTE_STEPS.indexOf(v));
    r.dispatchEvent(new Event("change"));
  });
  $("twTg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-t]");
    if (!b) return;
    const k = b.dataset.t;
    twin[k] = !twin[k];
    store.set({ showBars: "twBars", showRefs: "twRefs", sound: "twSound" }[k], twin[k] ? "1" : "0");
    if (k === "sound" && twin.sound) twBeep();
    twSync();
  });
  document.addEventListener("keydown", (e) => {
    if (twin.el.hidden || e.target.closest("input, textarea, select")) return;
    if (e.key === "Escape" && !document.fullscreenElement) twClose();
    else if (e.key === "f" || e.key === "F") twFullscreen();
  });
  document.addEventListener("fullscreenchange", () => $("twFull").setAttribute("aria-pressed", String(document.fullscreenElement === twin.el)));
  document.addEventListener("visibilitychange", () => { if (!document.hidden && twin.el && !twin.el.hidden) twPoll(); });
}

function twMakeChart() {
  const L = window.LightweightCharts;
  twin.chart = L.createChart($("twChart"), {
    autoSize: true,
    localization: { locale: "en-US" },
    timeScale: { timeVisible: true, secondsVisible: false, rightOffset: 0, shiftVisibleRangeOnNewBar: false },
    crosshair: { mode: L.CrosshairMode.Normal },
    rightPriceScale: { scaleMargins: { top: 0.06, bottom: 0.06 } },
  });
  twin.series = twin.chart.addSeries(L.CandlestickSeries, { priceLineVisible: true, lastValueVisible: true, priceFormat: TW_PRICE });
  twin.heat = new TwHeat(); twin.series.attachPrimitive(twin.heat);
  twin.bars = new TwBars(); twin.series.attachPrimitive(twin.bars);
  twin.events = new TwEvents(); twin.series.attachPrimitive(twin.events);
  twin.markers = L.createSeriesMarkers(twin.series, []);
  twin.chart.subscribeCrosshairMove(twLegend);
  new ResizeObserver(() => twFlowLegPos()).observe($("twChart"));
}

// colores del tema (al abrir y al cambiar de tema)
function twTheme() {
  const font = getComputedStyle(document.body).fontFamily;
  twin.chart.applyOptions({
    layout: { background: { type: "solid", color: C.ink }, textColor: C.muted, fontFamily: font, fontSize: 12,
      panes: { separatorColor: C.axis, separatorHoverColor: C.grid } },
    grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
    rightPriceScale: { borderColor: C.axis },
    timeScale: { borderColor: C.axis },
    crosshair: { vertLine: { color: C.faint, labelBackgroundColor: C.surface }, horzLine: { color: C.faint, labelBackgroundColor: C.surface } },
  });
  twin.series.applyOptions({
    upColor: C.candle, downColor: C.ink, borderUpColor: C.candle, borderDownColor: C.candle,
    wickUpColor: C.candle, wickDownColor: C.candle, priceLineColor: C.spotline,
  });
}

async function twOpen() {
  if (!twin.el) twBuild();
  if (state.mode !== "analysis") setMode("analysis");
  if (state.view !== "map") setView("map");
  twin.el.hidden = false;
  document.body.classList.add("tw-on");
  twMsg("Loading the chart…");
  try {
    await twLoadLib();
  } catch (e) { twMsg(e.message); return; }
  if (!twin.chart) twMakeChart();
  twTheme();
  twSync(true);
  clearInterval(twin.poll); clearInterval(twin.timer);
  twin.poll = setInterval(twPoll, TW_POLL_MS);
  // sin el Auto de la app, la ventana recarga por su cuenta al mismo ritmo
  let tick = 0;
  twin.timer = setInterval(() => {
    tick++;
    twSide();   // cuentas atras de los eventos
    if (state.auto || document.hidden) return;
    if (TIEMPO_REAL.has(state.symbol) || tick % 5 === 0) load(false, true);
  }, 60 * 1000);
  twPoll();
}

function twClose() {
  if (!twin.el) return;
  if (document.fullscreenElement === twin.el) document.exitFullscreen().catch(() => {});
  twin.el.hidden = true;
  document.body.classList.remove("tw-on");
  clearInterval(twin.poll); clearInterval(twin.timer);
  draw();
}

function twFullscreen() {
  if (!twin.el || twin.el.hidden) return;
  if (document.fullscreenElement === twin.el) document.exitFullscreen().catch(() => {});
  else if (twin.el.requestFullscreen) twin.el.requestFullscreen().catch(() => {});
}

function twMsg(t) {
  const m = $("twMsg");
  if (!m) return;
  m.hidden = !t; m.textContent = t || "";
}

// lo llama la app al recibir el mapa o los datos, y al cambiar de tema; fit: encuadrar la sesion entera
function twSync(fit = false) {
  if (!twin.el || twin.el.hidden || !twin.chart) return;
  twTheme();
  twControls();
  const hm = state.heat, d = state.data;
  if (!hm || !d) return;
  const key = `${hm.symbol}|${hm.session}`;
  if (twin.tickKey !== key) { twin.ticks.clear(); twin.tickKey = key; twin.lastPx = null; fit = true; }
  if (!twin.hm || twin.hm.symbol !== hm.symbol) fit = true;
  twin.hm = hm;
  const g = twBars(hm);
  const changed = !twin.grid || twin.grid.start !== g.start || twin.grid.slot !== g.slot;
  twin.grid = g;
  twin.series.setData(g.data);
  twin.heat.set(hm);
  twLevels(d);
  twRefs(d);
  twMarkers();
  twin.bars.redraw();
  twEvents();
  twFlow();
  if (fit || changed) twin.chart.timeScale().fitContent();
  twMsg(hm.kind === "next" ? "Projection for the next session: candles appear when it opens." : "");
  twQuoteUi();
  twLegend(null);
}

/* ------------------------------------------------------------ niveles: escalones con su historia en la sesion */
function twLevels(d) {
  const L = window.LightweightCharts, g = twin.grid, hm = twin.hm;
  const items = state.showLevels ? levelItems(d) : [];
  const keep = new Set(items.map((it) => it.key));
  for (const k of Object.keys(twin.lvS)) if (!keep.has(k)) { twin.chart.removeSeries(twin.lvS[k]); delete twin.lvS[k]; }
  const rows = (d.levels_intraday || []).filter((r) => r && r[0] >= "09:30" && r[0] < "16:00" && d.session === hm.session);
  const tEnd = twT(hm.session, twHHMM(g.end - g.slot));
  // tiempo de la ultima vela (o del inicio si aun no hay): el valor actual vale desde ahi hasta el cierre
  const tNow = g.last ? twSnap(minutesOf(g.last[0])) : twT(hm.session, twHHMM(g.start));
  twin.lvPts = {};
  for (const it of items) {
    let s = twin.lvS[it.key];
    if (!s) {
      s = twin.chart.addSeries(L.LineSeries, { lineType: L.LineType.WithSteps, lineStyle: L.LineStyle.Dashed, lineWidth: 2,
        priceLineVisible: false, crosshairMarkerVisible: false, autoscaleInfoProvider: () => null, priceFormat: TW_PRICE });
      twin.lvS[it.key] = s;
    }
    s.applyOptions({ color: it.c, title: it.tag, lastValueVisible: true });
    const pts = new Map();
    const col = TW_LV_COL[it.key];
    for (const r of rows) if (r[col] != null) pts.set(twSnap(minutesOf(r[0])), r[col]);
    if (!pts.size) pts.set(twT(hm.session, twHHMM(g.start)), it.v);
    pts.set(Math.max(tNow, [...pts.keys()].pop()), it.v);
    pts.set(tEnd, it.v);
    const data = [...pts].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, value }));
    s.setData(data);
    twin.lvPts[it.key] = data;
  }
}

// valor de un nivel en un instante (el ultimo escalon anterior)
function twLvAt(key, time) {
  const pts = twin.lvPts[key];
  if (!pts || !pts.length) return null;
  let v = pts[0].value;
  for (const p of pts) { if (p.time > time) break; v = p.value; }
  return v;
}

/* ------------------------------------------------------------ referencias intradia */
// cierre, maximo y minimo de la sesion anterior, apertura y rango de los primeros 30 min
function twRefData(d) {
  const g = twin.grid, pd = d.prev_day, out = [];
  const pdc = pd ? pd.close : d.prev_close;
  if (pdc) out.push({ t: "PDC", name: "Previous close", v: pdc, c: C.prevClose });
  if (pd) { out.push({ t: "PDH", name: "Previous high", v: pd.high, c: C.faint }); out.push({ t: "PDL", name: "Previous low", v: pd.low, c: C.faint }); }
  const reg = (g.list || []).filter((b) => b[0] >= "09:30");
  if (reg.length) {
    out.push({ t: "OPEN", name: "Today's open", v: reg[0][1], c: C.muted });
    const orEnd = twHHMM(minutesOf("09:30") + TW_OR_MIN), or = reg.filter((b) => b[0] < orEnd);
    const done = reg[reg.length - 1][0] >= orEnd;
    out.push({ t: "ORH", name: `Opening range high (${TW_OR_MIN} min${done ? "" : ", forming"})`, v: Math.max(...or.map((b) => b[2])), c: C.accent });
    out.push({ t: "ORL", name: `Opening range low (${TW_OR_MIN} min${done ? "" : ", forming"})`, v: Math.min(...or.map((b) => b[3])), c: C.accent });
  }
  return out;
}
function twRefs(d) {
  for (const l of twin.refLines) twin.series.removePriceLine(l);
  twin.refLines = !twin.showRefs ? [] : twRefData(d).map((r) => twin.series.createPriceLine({
    price: r.v, color: r.c, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.SparseDotted, axisLabelVisible: true, title: r.t,
  }));
}

/* ------------------------------------------------------------ cruces de niveles */
// marca en la vela cuyo cierre cruza un nivel (con el valor del nivel en esa vela); como mucho una por nivel cada 15 min
function twMarkers() {
  const d = state.data, out = [];
  if (!state.showLevels || !d) { twin.markers.setMarkers([]); return; }
  const bars = twin.series.data().filter((b) => b.close != null && twMinOf(b.time) >= minutesOf("09:30"));
  const items = levelItems(d), lastT = {};
  for (let i = 1; i < bars.length; i++) {
    const a = bars[i - 1].close, b = bars[i].close, t = bars[i].time;
    for (const it of items) {
      const L = twLvAt(it.key, t);
      if (L == null || !((a < L && b >= L) || (a > L && b <= L))) continue;
      if (lastT[it.key] && t - lastT[it.key] < 15 * 60) continue;
      lastT[it.key] = t;
      const up = b > a;
      out.push({ time: t, position: up ? "belowBar" : "aboveBar", shape: up ? "arrowUp" : "arrowDown", color: it.c,
        text: TW_LV_SHORT[it.key] || it.tag });
    }
  }
  twin.markers.setMarkers(out.sort((x, y) => x.time - y.time));
}

// aviso en la ventana (y sonido si esta activado) cuando el precio en vivo cruza un nivel
function twCheckLive(prev, px) {
  if (prev == null || prev === px || !state.data) return;
  for (const it of levelItems(state.data)) {
    const L = it.v;
    if (!((prev < L && px >= L) || (prev > L && px <= L))) continue;
    const up = px > prev;
    twAlert(`${twin.hm.symbol} ${up ? "breaks above" : "drops below"} ${it.name} ${fmtLevel(L)}`,
      it.key === "flip" ? (up ? "Entering positive gamma: moves tend to slow down." : "Entering negative gamma: moves tend to speed up.")
        : `Price ${fmtNum(px, 2)}.`, it.c);
  }
}
function twAlert(title, body, color) {
  const box = $("twAlerts");
  if (!box) return;
  const el = document.createElement("div");
  el.className = "tw-alert"; el.style.borderLeftColor = color || C.amber;
  el.innerHTML = `<b>${esc(title)}</b><span>${esc(body)}</span>`;
  box.prepend(el);
  while (box.children.length > 4) box.lastChild.remove();
  setTimeout(() => el.remove(), 15000);
  if (twin.sound) twBeep();
}
function twBeep() {
  try {
    const ac = twin.ac || (twin.ac = new (window.AudioContext || window.webkitAudioContext)());
    const o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = 880; g.gain.setValueAtTime(0.0001, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.15, ac.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.35);
    o.connect(g).connect(ac.destination); o.start(); o.stop(ac.currentTime + 0.4);
  } catch { /* sin audio */ }
}

/* ------------------------------------------------------------ eventos macro de hoy */
async function twEvents() {
  const hm = twin.hm;
  if (!twin.ev || Date.now() - twin.evAt > 30 * 60 * 1000) {
    twin.evAt = Date.now();
    try {
      const r = await fetch("/api/eventos");
      if (r.ok) twin.ev = (await r.json()).eventos || [];
    } catch { /* sin eventos */ }
  }
  const list = (twin.ev || []).filter((e) => e.date === hm.session && e.country === "US" && e.imp >= 2 && e.time
    && minutesOf(e.time) >= twin.grid.start && minutesOf(e.time) < twin.grid.end).sort((a, b) => (a.time < b.time ? -1 : 1));
  twin.evToday = list;
  twin.events.set(list);
  twSide();
}

/* ------------------------------------------------------------ flujo de opciones (panel de abajo) */
async function twFlow() {
  const hm = twin.hm, sym = hm.symbol, key = `${sym}|${hm.session}`;
  if (twin.flowKey !== key || Date.now() - twin.flowAt > 60 * 1000) {
    twin.flowAt = Date.now();
    try {
      const r = await fetch(`/api/flow?symbol=${encodeURIComponent(sym)}`);
      const f = r.ok ? await r.json() : null;
      if (twin.hm.symbol !== sym) return;
      twin.flow = f && f.session === hm.session && (f.series || []).length ? f : null;
      twin.flowKey = key;
    } catch { twin.flow = null; }
  }
  twFlowSeries();
  twSide();
}
function twFlowSeries() {
  const L = window.LightweightCharts, f = twin.flow;
  if (!f) {
    if (twin.flowS) { for (const s of Object.values(twin.flowS)) twin.chart.removeSeries(s); twin.flowS = null; }
    $("twFlowLeg").hidden = true;
    return;
  }
  if (!twin.flowS) {
    const money = { type: "custom", formatter: (v) => fmtBig(v, true), minMove: 1 };
    twin.flowS = {
      cp: twin.chart.addSeries(L.LineSeries, { lineWidth: 2, priceFormat: money, priceLineVisible: false, title: "Calls" }, 1),
      pp: twin.chart.addSeries(L.LineSeries, { lineWidth: 2, priceFormat: money, priceLineVisible: false, title: "Puts" }, 1),
      d: twin.chart.addSeries(L.LineSeries, { lineWidth: 1, lineStyle: L.LineStyle.Dashed, priceFormat: money, priceLineVisible: false,
        priceScaleId: "flowDelta", lastValueVisible: false }, 1),
    };
    const pane = twin.chart.panes()[1];
    if (pane) pane.setHeight(Math.round($("twChart").clientHeight * 0.2));
  }
  twin.flowS.cp.applyOptions({ color: C.call }); twin.flowS.pp.applyOptions({ color: C.put }); twin.flowS.d.applyOptions({ color: C.purple });
  const pick = (k) => {
    const m = new Map();
    for (const p of f.series) if (p.t >= "09:30" && p[k] != null) m.set(twSnap(minutesOf(p.t)), p[k]);
    return [...m].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, value }));
  };
  twin.flowS.cp.setData(pick("cp")); twin.flowS.pp.setData(pick("pp")); twin.flowS.d.setData(pick("d"));
  const last = f.series[f.series.length - 1];
  const leg = $("twFlowLeg");
  leg.hidden = false;
  leg.innerHTML = `<b>Options flow</b><span style="color:${C.call}">Calls ${fMoney(last.cp)}</span><span style="color:${C.put}">Puts ${fMoney(last.pp)}</span>`
    + `<span style="color:${C.purple}">Net delta ${fMoney(last.d)}</span><span>at ${esc(last.t)}</span>`;
  twFlowLegPos();
}
// arriba a la izquierda del panel de flujo (tras el reparto de alturas, que la libreria aplica en el siguiente cuadro)
function twFlowLegPos() {
  requestAnimationFrame(() => {
    const leg = $("twFlowLeg"), panes = twin.chart && twin.chart.panes();
    if (!leg || leg.hidden || !panes || panes.length < 2) return;
    const el = panes[1].getHTMLElement && panes[1].getHTMLElement();
    const top = el ? el.getBoundingClientRect().top - $("twChart").getBoundingClientRect().top : panes[0].getHeight() + 1;
    leg.style.top = `${Math.round(top) + 6}px`;
  });
}

/* ------------------------------------------------------------ precio en vivo */
async function twPoll() {
  const hm = twin.hm;
  if (!hm || document.hidden || !twin.el || twin.el.hidden) return;
  const sym = hm.symbol;
  // solo con la sesion abierta (antes de las 09:30 el indice cotiza el cierre de ayer) y si hay fuente
  if (!hm.live || hm.pre || twin.noLive.has(sym)) { twin.live = false; twQuoteUi(); return; }
  try {
    const r = await fetch(`/api/precio?symbol=${encodeURIComponent(sym)}`);
    if (r.status === 404) { twin.noLive.add(sym); twin.live = false; twQuoteUi(); return; }
    const q = await r.json();
    if (!r.ok || !(q.last > 0) || !twin.hm || twin.hm.symbol !== sym) return;
    twin.quote = q; twin.quoteAt = Date.now();
    twTick(q);
  } catch { /* sin red: sigue con lo del motor */ }
  twQuoteUi();
}

function twTick(q) {
  const hm = twin.hm;
  const parts = Object.fromEntries(TW_NY.formatToParts(new Date(q.time || Date.now())).map((p) => [p.type, p.value]));
  const day = `${parts.year}-${parts.month}-${parts.day}`, t = `${parts.hour}:${parts.minute}`;
  twin.live = day === hm.session && t >= "09:30" && t < "16:00";
  if (!twin.live) return;
  const px = q.last, b = twin.ticks.get(t);
  twCheckLive(twin.lastPx, px);
  twin.lastPx = px;
  if (b) { b[1] = Math.max(b[1], px); b[2] = Math.min(b[2], px); b[3] = px; } else twin.ticks.set(t, [px, px, px, px]);
  // solo la vela en curso: se recalcula su tramo con las velas del motor y los ticks de ese tramo
  const g = twBars(hm), slot = g.slot, m = Math.floor(minutesOf(t) / slot) * slot;
  if (g.start !== twin.grid.start || slot !== twin.grid.slot) { twSync(); return; }
  const bar = g.data[(m - g.start) / slot];
  const newBar = !twin.grid.last || g.last[0] !== twin.grid.last[0];
  twin.grid = g;
  if (bar && bar.open != null) twin.series.update(bar, true);
  if (newBar) { twLevels(state.data); twRefs(state.data); twMarkers(); }
  twin.heat.redraw();
}

function twQuoteUi() {
  const hm = twin.hm, q = twin.quote;
  const fresh = twin.live && q && Date.now() - twin.quoteAt < 3 * TW_POLL_MS;
  const px = hm ? twPrice() : null;
  $("twSym").textContent = hm ? hm.symbol : "";
  $("twPx").textContent = px != null ? fmtNum(px, 2) : "—";
  const chg = $("twChg"), pc = state.data && (state.data.prev_day ? state.data.prev_day.close : state.data.prev_close);
  const dv = fresh && q.change != null ? q.change : px != null && pc ? px - pc : null;
  if (dv != null && hm && hm.kind !== "next") {
    const base = fresh && q.prevclose ? q.prevclose : pc;
    chg.textContent = `${dv >= 0 ? "+" : "−"}${fmtNum(Math.abs(dv), 2)} (${dv >= 0 ? "+" : "−"}${fmtNum(Math.abs(dv / base) * 100, 2)}%)`;
    chg.dataset.s = dv >= 0 ? "up" : "dn";
  } else { chg.textContent = ""; delete chg.dataset.s; }
  const lv = $("twLive");
  lv.dataset.s = fresh ? "live" : "eng";
  lv.querySelector("span").textContent = fresh ? "Live" : hm ? (hm.kind === "next" ? "Next session" : hm.live || hm.pre ? `Engine ${hm.now} ET` : "Closed") : "";
  lv.title = fresh ? "Live price from Tradier, every 5 s. The map and levels come from the engine (every minute for the real-time indices)."
    : twin.noLive.has(hm && hm.symbol) ? "No live price for this ticker: candles from the engine."
    : "Candles and levels from the engine.";
  twSide();
}

/* ------------------------------------------------------------ barra de controles */
function twControls() {
  const syms = [...TIEMPO_REAL];
  if (!TIEMPO_REAL.has(state.symbol)) syms.push(state.symbol);
  $("twSyms").innerHTML = syms.map((s) => `<button data-s="${esc(s)}" aria-pressed="${s === state.symbol}">${esc(s)}</button>`).join("");
  const seg = (key, opts, lab) => opts.map((o) => `<button data-k="${key}" data-v="${o[0]}" aria-pressed="${state[key] === o[0]}" title="${esc(o[2] || o[1])}">${esc(lab(o))}</button>`).join("");
  const z = state.dte === "0";
  $("twDte").innerHTML = `<button data-v="0" aria-pressed="${z}" title="Only options that expire today (Net engine)">0DTE</button>`
    + `<button data-v="all" aria-pressed="${!z}" title="Expirations up to ${esc(DTE_LABEL[z ? store.get("twDteAll", "45") : state.dte] || "")} (Profile engine)">${z ? "All" : esc(DTE_LABEL[state.dte] || "All").replace("≤ ", "≤")}</button>`;
  $("twCandle").innerHTML = seg("mapCandle", CANDLE_OPTS, (o) => `${o[0]}m`);
  $("twLens").innerHTML = seg("mapLens", LENS_OPTS, (o) => ({ gamma: "Gamma", delta: "Delta", charm: "Charm" })[o[0]]);
  const tg = (k, lab, tip) => `<button data-t="${k}" aria-pressed="${twin[k]}" title="${tip}">${lab}</button>`;
  $("twTg").innerHTML = tg("showBars", "Bars", "Gamma by strike next to the price scale")
    + tg("showRefs", "Refs", "Previous close, high and low, today's open and the 30-minute opening range")
    + tg("sound", "Sound", "Beep when the live price crosses a level");
}

/* ------------------------------------------------------------ panel lateral: plan de sesion */
// delta de los dealers en acciones a un precio (perfil del calculo: $ de delta / precio), interpolada
function twShares(d, x, key = "d") {
  const X = d.profile.x, Y = d.profile[key];
  if (!Y) return null;
  if (x <= X[0]) return Y[0] / X[0];
  if (x >= X[X.length - 1]) return Y[Y.length - 1] / X[X.length - 1];
  let i = 1;
  while (X[i] < x) i++;
  const t = (x - X[i - 1]) / (X[i] - X[i - 1]);
  return (Y[i - 1] / X[i - 1]) * (1 - t) + (Y[i] / X[i]) * t;
}
// lo que comprarian (+) o venderian (-) los dealers para seguir cubiertos si el precio fuera de px a x
// (igual que los escenarios del motor: -(acciones en x - acciones ahora) x precio)
function twHedge(d, px, x, key = "d") {
  const a = twShares(d, px, key), b = twShares(d, x, key);
  return a == null || b == null ? null : -(b - a) * x;
}

function twSide() {
  const box = $("twSide"), d = state.data, hm = twin.hm;
  if (!box) return;
  if (!d || !hm) { box.innerHTML = ""; return; }
  const px = twPrice(), big = px >= 1000, dp = big ? 0 : 2;
  const em = d.moves && d.moves.d1, sg = em && em.sigma ? em.sigma : null;
  const L = d.levels;
  const fs = flipSide(px, L.flip_exact, L.flip);
  const items = levelItems(d);
  const above = items.filter((x) => x.v > px).sort((a, b) => a.v - b.v)[0];
  const below = items.filter((x) => x.v <= px).sort((a, b) => b.v - a.v)[0];
  const front0 = d.front_expiry && String(d.front_expiry).slice(0, 10) === d.session;

  // strike del proximo vencimiento con mas gamma cerca del precio (dentro del rango que queda)
  let pin = null;
  if (d.front && d.strikes) {
    const w = sg || px * 0.01;
    d.strikes.forEach((k, i) => {
      if (Math.abs(k - px) <= w && d.front[i] && (!pin || Math.abs(d.front[i]) > Math.abs(pin.v))) pin = { k, v: d.front[i] };
    });
  }
  const nowNY = twNow(), lateDay = hm.live && nowNY.min >= 15 * 60;

  // lectura: reglas fijas segun el regimen, los niveles cercanos y la hora
  const lv = (x) => (x ? `${x.name} ${fmtLevel(x.v)}` : "");
  let read;
  if (fs === "near") read = `Next to the Gamma Flip ${fmtLevel(L.flip)}: no clear dealer effect. A move away from it sets the tone: above, moves tend to slow down; below, they tend to speed up.`;
  else if (fs === "above") read = `Positive gamma: dealer hedging leans against the move. Moves toward ${lv(above) || "the levels above"} or ${lv(below) || "the levels below"} tend to stall; fading the extremes usually works better than chasing breakouts.`;
  else read = `Negative gamma: dealer hedging adds to the move. A break of ${lv(below) || "the level below"} can extend quickly; rallies toward ${lv(above) || "the level above"} can also run. Ranges tend to be wider.`;
  if (lateDay && pin && front0) read += ` Last hour: 0DTE gamma decays fast; the price is often pulled toward large 0DTE strikes such as ${fmtLevel(pin.k)}.`;

  const regime = fs == null ? "" : `<div class="tw-reg" data-s="${fs === "below" ? "neg" : fs === "near" ? "near" : "pos"}">
    <b>${fs === "near" ? "At the Gamma Flip" : fs === "above" ? "Positive gamma" : "Negative gamma"}</b><span>${esc(read)}</span></div>`;

  // rango que queda y distancia a los niveles en sigmas
  const sgTxt = sg ? `<div class="tw-kv"><span>${em.partial ? "Expected range, rest of session" : "Expected range, 1 day"}</span><b>±${fmtNum(sg, dp)}</b>
    <em>${fmtNum(px - sg, dp)} to ${fmtNum(px + sg, dp)} (1σ, ${fmtNum((sg / px) * 100, 2)}%)</em></div>` : "";
  const dist = (x) => { const v = x.v - px; return `${v >= 0 ? "+" : "−"}${fmtNum(Math.abs(v), dp)}${sg ? `, ${fmtNum(Math.abs(v) / sg, 1)}σ` : ""}`; };
  const rows = items.slice().sort((a, b) => b.v - a.v);
  let lvRows = "", done = false;
  const spotRow = `<li class="tw-spot"><i></i><span>Price</span><b>${fmtNum(px, 2)}</b><em></em></li>`;
  for (const it of rows) {
    if (!done && px > it.v) { lvRows += spotRow; done = true; }
    lvRows += `<li${it === above || it === below ? ' class="tw-near"' : ""}><i style="background:${it.c}"></i><span>${esc(it.name)}</span><b>${fmtLevel(it.v)}</b><em>${dist(it)}</em></li>`;
  }
  if (!done) lvRows += spotRow;

  // cobertura de los dealers si el precio se mueve
  let hedge = "";
  if (d.profile && d.profile.d) {
    const steps = sg ? [[-1, sg], [-0.5, sg], [0.5, sg], [1, sg]].map(([k, s]) => [k, px + k * s, `${k > 0 ? "+" : "−"}${Math.abs(k) === 1 ? "1" : "½"}σ`])
      : [-1, -0.5, 0.5, 1].map((k) => [k, px * (1 + k / 100), `${k > 0 ? "+" : "−"}${Math.abs(k)}%`]);
    const fr = d.profile.d_next && state.dte !== "0" ? (front0 ? "0DTE" : "Next exp.") : null;
    const f = (v) => v == null ? "—" : `<b class="${v >= 0 ? "buy" : "sell"}">${v >= 0 ? "buy" : "sell"} ${fmtBig(Math.abs(v), true)}</b>`;
    hedge = `<div class="tw-sec"><h4>Dealer hedging if the price moves</h4><table class="tw-hedge"><thead><tr><th>Move</th><th>To</th><th>All</th>${fr ? `<th>${fr}</th>` : ""}</tr></thead><tbody>`
      + steps.map(([, x, lab]) => `<tr><td>${lab}</td><td>${fmtNum(x, dp)}</td><td>${f(twHedge(d, px, x))}</td>${fr ? `<td>${f(twHedge(d, px, x, "d_next"))}</td>` : ""}</tr>`).join("")
      + `</tbody></table><p class="tw-note">What dealers would buy or sell to stay hedged, with the open interest of the previous close. Buying into a rally or selling into a drop adds to the move.</p></div>`;
  }

  const pinTxt = pin ? `<div class="tw-kv"><span>Largest ${front0 ? "0DTE" : "next-expiration"} strike nearby</span><b>${fmtLevel(pin.k)}</b>
    <em>${fmtBig(pin.v * px / 100, true)} gamma per 1%${lateDay && front0 ? ", likely pin into the close" : ""}</em></div>` : "";

  // eventos de hoy con cuenta atras
  const ev = twin.evToday || [];
  const evTxt = ev.length ? `<div class="tw-sec"><h4>Today's events (ET)</h4><ul class="tw-ev">${ev.map((e) => {
    const mins = minutesOf(e.time) - nowNY.min, today = nowNY.day === hm.session;
    const when = !today ? "" : mins > 0 ? `in ${mins >= 60 ? `${Math.floor(mins / 60)}h ` : ""}${mins % 60}m` : "done";
    return `<li data-imp="${e.imp}"><b>${esc(e.time)}</b><span>${esc(e.name)}</span><em>${when}</em></li>`;
  }).join("")}</ul></div>` : "";

  const f = twin.flow, fl = f && f.series[f.series.length - 1];
  const flowTxt = fl ? `<div class="tw-sec"><h4>Options flow at ${esc(fl.t)} ET</h4>
    <div class="tw-kv"><span>Call premium</span><b style="color:${C.call}">${fMoney(fl.cp)}</b></div>
    <div class="tw-kv"><span>Put premium</span><b style="color:${C.put}">${fMoney(fl.pp)}</b></div>
    <div class="tw-kv"><span>Net delta</span><b style="color:${C.purple}">${fMoney(fl.d)}</b><em>Bought minus sold by customers today (estimate).</em></div></div>` : "";

  const refs = twRefData(d);
  const refTxt = refs.length ? `<div class="tw-sec"><h4>Reference prices</h4>${refs.map((r) => `<div class="tw-kv"><span>${esc(r.name)}</span><b>${fmtNum(r.v, 2)}</b></div>`).join("")}</div>` : "";

  box.innerHTML = `
    <h3>${esc(hm.name || hm.symbol)} <small>${esc(state.dte === "0" ? "0DTE" : DTE_LABEL[state.dte] || "")}</small></h3>
    ${regime}
    <ul class="tw-lv">${lvRows}</ul>
    ${sgTxt}${pinTxt}${hedge}${evTxt}${flowTxt}${refTxt}
    <p class="tw-note">Map and levels from the engine at ${esc(hm.now)} ET; dashed steps show how each level moved during the session. Arrows mark candles that closed across a level.</p>`;
}

// leyenda arriba a la izquierda: vela bajo el cursor (o la ultima) y valor del mapa en ese punto
function twLegend(param) {
  const box = $("twLegend"), hm = twin.hm;
  if (!box || !hm) return;
  let bar = null, price = null, time = null;
  if (param && param.time != null && param.point) {
    bar = param.seriesData.get(twin.series) || null;
    price = twin.series.coordinateToPrice(param.point.y);
    time = param.time;
  } else {
    const g = twin.grid;
    if (g && g.last) { const b = g.last; bar = { open: b[1], high: b[2], low: b[3], close: b[4] }; time = twT(hm.session, b[0]); }
  }
  const hh = time != null ? twHHMM(twMinOf(time)) : "";
  let s = `<b>${esc(hm.symbol)}</b><span>${hh}</span>`;
  if (bar && bar.open != null) {
    const f = (v) => fmtNum(v, 2);
    s += `<span>O <b>${f(bar.open)}</b></span><span>H <b>${f(bar.high)}</b></span><span>L <b>${f(bar.low)}</b></span><span>C <b>${f(bar.close)}</b></span>`;
  }
  // valor del mapa: columna por hora y fila por precio
  if (price != null && time != null && hm.times.length) {
    const m = twMinOf(time), Z = heatZ(hm);
    let c = -1;
    for (let j = 0; j < hm.times.length; j++) if (minutesOf(hm.times[j]) <= m) c = j;
    const P = hm.prices, r = Math.round(((price - P[0]) / (P[P.length - 1] - P[0])) * (P.length - 1));
    if (c >= 0 && r >= 0 && r < P.length) {
      const v = Z[r][c];
      s += `<span class="tw-hv">${esc(LENS_N[heatLens(hm)] || "Gamma")} at ${fmtNum(price, 2)}: <b style="color:${v >= 0 ? C.pos : C.neg}">${fmtAxis(v)}</b></span>`;
    }
  }
  box.innerHTML = s;
}

if ($("twOpen")) $("twOpen").addEventListener("click", twOpen);
