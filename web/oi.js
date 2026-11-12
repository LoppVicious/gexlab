"use strict";
/* ============================================================ Open Interest
   OI, cambio de OI frente a la sesion anterior y volumen por strike del ticker de la barra superior, para los
   vencimientos elegidos. Calls hacia arriba y puts hacia abajo. Arriba: totales, ratio put/call y max pain; los
   vencimientos como barras que se eligen pulsando; al lado del grafico, los contratos que mas cambian. */

const oiv = {
  sym: "", ch: null, ctrl: null, built: false,
  metric: ["oi", "chg", "vol"].includes(store.get("oiTMetric", "oi")) ? store.get("oiTMetric", "oi") : "oi",       // oi | chg | vol
  range: [5, 10, 20].includes(+store.get("oiTRange", "10")) ? +store.get("oiTRange", "10") : 10,        // +-% alrededor del spot
  mode: ["all", "w1", "m1", "far"].includes(store.get("oiTMode", "all")) ? store.get("oiTMode", "all") : "all",          // all | w1 | m1 | far | pick
  pick: [],                                  // vencimientos elegidos a mano
};
const OI_MODES = [["all", "All"], ["w1", "Next 7 days"], ["m1", "8 to 45 days"], ["far", "Beyond 45 days"]];

// vencimientos vivos agrupados por fecha (SPX, NDX y RUT tienen el mensual AM y el semanal PM el mismo dia)
function oiDays() {
  const m = new Map();
  for (const e of oiv.ch.live) {
    const d = m.get(e.iso) || { iso: e.iso, days: e.days, monthly: false, idx: [] };
    d.idx.push(e.i); d.monthly = d.monthly || e.monthly; d.days = Math.min(d.days, e.days);
    m.set(e.iso, d);
  }
  return [...m.values()];
}
function oiSelected() {
  const f = { all: () => true, w1: (d) => d.days <= 7, m1: (d) => d.days > 7 && d.days <= 45, far: (d) => d.days > 45, pick: (d) => oiv.pick.includes(d.iso) }[oiv.mode] || (() => true);
  return new Set(oiDays().filter(f).flatMap((d) => d.idx));
}

/* ---------------------------------------------------------------- estructura */

/* ---------------------------------------------------------------- estructura
   Todo en una pantalla: cifras en fila, los vencimientos como barras que sirven de selector, el grafico por strike
   (alto ajustado a la ventana) y al lado los contratos que mas cambian o mas se negocian. */
function oiBuild() {
  $("oiView").innerHTML = `
  <header class="lab-head">
    <div class="lab-title"><span class="lab-sym" id="oiSym"></span></div>
    <div class="lab-keys" role="radiogroup" id="oiMetric" aria-label="Measure">
      <button role="radio" data-v="oi">Open interest</button><button role="radio" data-v="chg">Change</button><button role="radio" data-v="vol">Volume</button></div>
  </header>
  <div class="lab-stats" id="oiStats"></div>
  <section class="lab-panel oi-strip">
    <div class="oi-strip-h">
      <div class="lab-keys small" role="radiogroup" id="oiExps" aria-label="Expirations">${OI_MODES.map(([k, t]) => `<button role="radio" data-m="${k}">${t}</button>`).join("")}</div>
      <span class="oi-strip-say" id="oiSub"></span>
    </div>
    <div id="oiByExp"></div>
  </section>
  <div class="oi-main">
    <section class="lab-panel oi-plot">
      <div class="lab-tools">
        <span class="lab-legend lab-tleg" id="oiLeg"></span>
        <span class="lab-keys small" role="radiogroup" id="oiRange" aria-label="Strike range">
          <button role="radio" data-v="5">±5%</button><button role="radio" data-v="10">±10%</button><button role="radio" data-v="20">±20%</button></span>
      </div>
      <div class="oi-chart" id="oiChart" role="img" aria-label="Open interest by strike"></div>
    </section>
    <section class="lab-panel oi-side"><div class="oi-side-h"><b id="oiSideT"></b><span id="oiChgSub"></span></div><div id="oiMovers"></div></section>
  </div>
  <p class="tl-note">Open interest is published once a day, before the open: the contracts left open at the previous close. The change compares it with the session before; volume is today's so far. Max pain is the price at which the options of the chosen expirations would be worth the least at expiration.</p>`;
  const segSync = () => {
    for (const b of $("oiMetric").querySelectorAll("button")) b.setAttribute("aria-checked", String(b.dataset.v === oiv.metric));
    for (const b of $("oiRange").querySelectorAll("button")) b.setAttribute("aria-checked", String(+b.dataset.v === oiv.range));
    for (const b of $("oiExps").querySelectorAll("button")) b.setAttribute("aria-checked", String(b.dataset.m === oiv.mode));
  };
  oiv.segSync = segSync; segSync();
  $("oiMetric").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; oiv.metric = b.dataset.v; store.set("oiTMetric", oiv.metric); oiRender(); });
  $("oiRange").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; oiv.range = +b.dataset.v; store.set("oiTRange", String(oiv.range)); oiRender(); });
  $("oiExps").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    oiv.mode = b.dataset.m; oiv.pick = []; store.set("oiTMode", oiv.mode);
    oiRender();
  });
  $("oiByExp").addEventListener("click", (e) => { const r = e.target.closest("[data-k]"); if (r) { oiPick(r.dataset.k, e.shiftKey || e.ctrlKey || e.metaKey); oiRender(); } });
  $("oiChart").addEventListener("mousemove", oiProbe);
  $("oiChart").addEventListener("mouseleave", () => { toolTip($("oiChart"), null); const h = $("oiHover"); if (h) h.setAttribute("visibility", "hidden"); });
  oiv.built = true;
}
// elegir un vencimiento (con mayusculas o control, se suma a los elegidos)
function oiPick(k, add) {
  if (add && oiv.mode === "pick") {
    oiv.pick = oiv.pick.includes(k) ? oiv.pick.filter((x) => x !== k) : [...oiv.pick, k];
    if (!oiv.pick.length) oiv.mode = "all";
  } else if (oiv.mode === "pick" && oiv.pick.length === 1 && oiv.pick[0] === k) { oiv.mode = "all"; oiv.pick = []; }
  else { oiv.mode = "pick"; oiv.pick = [k]; }
}

/* ---------------------------------------------------------------- carga */
function showOI() {
  if (!oiv.built) oiBuild();
  const sym = state.symbol || "SPX";
  $("symbol").value = sym;
  if (!oiv.ch || oiv.sym !== sym) loadOI(); else { oiRender(); setStatus("", oiStatus()); }
}
function oiStatus() { return oiv.ch ? `Chain at ${nyHHMM(oiv.ch.generado)}` : ""; }
async function loadOI(refresh = false) {
  if (!oiv.built) oiBuild();
  const sym = (state.symbol || "SPX").toUpperCase();
  if (oiv.ctrl) oiv.ctrl.abort();
  oiv.ctrl = new AbortController();
  $("refreshBtn").classList.add("spin");
  setStatus("busy", `Loading the ${sym} chain…`);
  $("oiChart").classList.add("loading");
  try {
    const ch = await loadChain(sym, { refresh, signal: oiv.ctrl.signal });
    if (oiv.sym !== ch.symbol) { oiv.pick = []; if (oiv.mode === "pick") oiv.mode = "all"; }
    oiv.ch = ch; oiv.sym = ch.symbol;
    oiRender();
    setStatus("", oiStatus());
  } catch (e) {
    if (e.name === "AbortError") return;
    $("oiChart").innerHTML = `<div class="placeholder err"><div><div class="err-t">${esc(e.message)}</div></div></div>`;
    setStatus("err", e.message);
  } finally { $("refreshBtn").classList.remove("spin"); $("oiChart").classList.remove("loading"); }
}

/* ---------------------------------------------------------------- calculo */
function oiAggregate() {
  const ch = oiv.ch, sel = oiSelected(), S = ch.spot;
  const rows = ch.rows.filter((x) => sel.has(x.e));
  const t = { cOI: 0, pOI: 0, cVol: 0, pVol: 0, cChg: 0, pChg: 0, known: 0 };
  const byK = new Map();
  for (const x of rows) {
    const b = byK.get(x.K) || { K: x.K, cOI: 0, pOI: 0, cPrev: 0, pPrev: 0, cVol: 0, pVol: 0, cChg: 0, pChg: 0 };
    const chg = x.prev == null ? 0 : x.oi - x.prev;
    if (x.call) { b.cOI += x.oi; b.cVol += x.vol; b.cPrev += x.prev == null ? x.oi : x.prev; b.cChg += chg; t.cOI += x.oi; t.cVol += x.vol; t.cChg += chg; }
    else { b.pOI += x.oi; b.pVol += x.vol; b.pPrev += x.prev == null ? x.oi : x.prev; b.pChg += chg; t.pOI += x.oi; t.pVol += x.vol; t.pChg += chg; }
    if (x.prev != null) t.known++;
    byK.set(x.K, b);
  }
  const strikes = [...byK.values()].sort((a, b) => a.K - b.K);
  // max pain: strike que minimiza lo que valen al vencimiento las opciones de los vencimientos elegidos
  let pain = null, best = Infinity;
  const cand = strikes.filter((b) => Math.abs(b.K / S - 1) < 0.3);
  for (const k of cand) {
    let v = 0;
    for (const b of strikes) v += b.cOI * Math.max(k.K - b.K, 0) + b.pOI * Math.max(b.K - k.K, 0);
    if (v < best) { best = v; pain = k.K; }
  }
  const near = strikes.filter((b) => Math.abs(b.K / S - 1) < 0.25);
  const cWall = near.reduce((a, b) => (b.cOI > (a ? a.cOI : -1) ? b : a), null);
  const pWall = near.reduce((a, b) => (b.pOI > (a ? a.pOI : -1) ? b : a), null);
  return { rows, strikes, t, pain, cWall, pWall, sel };
}


/* ---------------------------------------------------------------- pintar */
function oiRender() {
  if (!oiv.ch) return;
  const ch = oiv.ch;
  oiv.segSync();
  $("oiSym").innerHTML = spotLabel(ch);
  const nsel = oiDays().filter((d) => d.idx.some((i) => oiSelected().has(i))).length, nall = oiDays().length;
  $("oiSub").innerHTML = `${nsel === nall ? `All <b>${nall}</b> expirations` : `<b>${nsel}</b> of ${nall} expirations`}${ch.hasPrev ? `, change vs. <b>${shortDate(ch.prevDate)}</b>` : ""}. Click a bar to see one; Shift-click to add more.${oiv.metric === "chg" && !ch.hasPrev ? " No previous session is saved for this ticker yet." : ""}`;
  const a = oiAggregate();
  oiv.agg = a;
  oiStats(a);
  oiByExp();
  oiMovers(a);
  oiChart(a);
}

// alto del grafico: lo que deja libre la ventana, para ver cifras, vencimientos y grafico sin bajar
function oiFitH(W) {
  const q = (sel) => { const e = document.querySelector(sel); return e ? e.offsetHeight : 0; };
  const fit = window.innerHeight - (q("header.bar") + q("#oiView .lab-head") + q("#oiStats") + q(".oi-strip") + q(".oi-plot .lab-tools") + 104);
  return Math.round(Math.max(300, Math.min(W < 700 ? 380 : 620, fit)));
}

function oiChart(a) {
  const box = $("oiChart"), S = oiv.ch.spot, met = oiv.metric;
  const lo = S * (1 - oiv.range / 100), hi = S * (1 + oiv.range / 100);
  let bins = a.strikes.filter((b) => b.K >= lo && b.K <= hi);
  const W = Math.max(320, box.clientWidth), H = oiFitH(W);
  const pad = { l: 54, r: 12, t: 30, b: 28 };
  // demasiados strikes para el ancho: se agrupan en tramos redondos
  const maxBars = Math.floor((W - pad.l - pad.r) / 6);
  if (bins.length > maxBars) {
    const step = axisTicks(0, (hi - lo) / maxBars * 1.0001, 1)[1] || (hi - lo) / maxBars;
    const m = new Map();
    for (const b of bins) {
      const k = Math.round(b.K / step) * step;
      const g = m.get(k) || { K: k, cOI: 0, pOI: 0, cPrev: 0, pPrev: 0, cVol: 0, pVol: 0, cChg: 0, pChg: 0, from: b.K, to: b.K };
      for (const f of ["cOI", "pOI", "cPrev", "pPrev", "cVol", "pVol", "cChg", "pChg"]) g[f] += b[f];
      g.from = Math.min(g.from, b.K); g.to = Math.max(g.to, b.K);
      m.set(k, g);
    }
    bins = [...m.values()].sort((x, y) => x.K - y.K);
  }
  oiLegend(a, met);
  if (!bins.length) { box.innerHTML = `<div class="placeholder"><div>No open interest in this range.</div></div>`; oiv.geo = null; return; }
  const up = (b) => (met === "oi" ? b.cOI : met === "vol" ? b.cVol : b.cChg);
  const dn = (b) => (met === "oi" ? -b.pOI : met === "vol" ? -b.pVol : b.pChg);
  let y0 = 0, y1 = 0;
  for (const b of bins) {
    if (met === "chg") { y0 = Math.min(y0, up(b), dn(b)); y1 = Math.max(y1, up(b), dn(b)); }
    else { y1 = Math.max(y1, up(b), met === "oi" ? b.cPrev : 0); y0 = Math.min(y0, dn(b), met === "oi" ? -b.pPrev : 0); }
  }
  if (y0 === 0 && y1 === 0) { y0 = -1; y1 = 1; }
  const sp = y1 - y0; y1 += sp * 0.08; y0 -= sp * 0.08;
  const X = scale(lo, hi, pad.l, W - pad.r), Y = scale(y0, y1, H - pad.b, pad.t), zy = Y(0);
  const keys = bins.map((b) => b.K);
  let gap = Infinity; for (let i = 1; i < keys.length; i++) gap = Math.min(gap, keys[i] - keys[i - 1]);
  if (!isFinite(gap)) gap = (hi - lo) / 40;
  const bw = Math.max(1.5, Math.min(22, (X(lo + gap) - X(lo)) * 0.72)), rx = Math.min(3, bw / 3);
  const yt = axisTicks(y0, y1, 6), xt = axisTicks(lo, hi, Math.max(4, Math.round(W / 100)));
  // barras de cada lado: un rectangulo redondeado solo por fuera (el lado del cero queda recto)
  const bar = (x, w, v, col, op) => {
    if (!v) return "";
    const y = Y(v), h = Math.max(Math.abs(y - zy), 1), top = v > 0;
    const r = Math.min(rx, h / 2, w / 2), x2 = x + w;
    const d = top ? `M${x},${zy}V${y + r}Q${x},${y} ${x + r},${y}H${x2 - r}Q${x2},${y} ${x2},${y + r}V${zy}Z`
      : `M${x},${zy}V${zy + h - r}Q${x},${zy + h} ${x + r},${zy + h}H${x2 - r}Q${x2},${zy + h} ${x2},${zy + h - r}V${zy}Z`;
    return `<path d="${d}" fill="${col}" opacity="${op}"/>`;
  };
  const cTop = met === "oi" && a.cWall ? a.cWall.K : null, pTop = met === "oi" && a.pWall ? a.pWall.K : null;
  let bars = "";
  for (const b of bins) {
    const x = X(b.K), hot = (k) => k != null && (b.from != null ? k >= b.from && k <= b.to : k === b.K);
    if (met === "chg") {
      const hw = bw / 2;
      bars += bar(x - hw, hw, up(b), C.call, 0.9) + bar(x, hw, dn(b), C.put, 0.9);
    } else {
      bars += bar(x - bw / 2, bw, up(b), C.call, hot(cTop) ? 1 : 0.78) + bar(x - bw / 2, bw, dn(b), C.put, hot(pTop) ? 1 : 0.78);
      if (met === "oi" && oiv.ch.hasPrev && bw >= 3) {   // OI de la sesion anterior: una marca sobre cada barra
        if (b.cPrev !== b.cOI) bars += `<line x1="${x - bw / 2 - 1.5}" x2="${x + bw / 2 + 1.5}" y1="${Y(b.cPrev)}" y2="${Y(b.cPrev)}" stroke="${C.text}" stroke-width="1.4" opacity=".55"/>`;
        if (b.pPrev !== b.pOI) bars += `<line x1="${x - bw / 2 - 1.5}" x2="${x + bw / 2 + 1.5}" y1="${Y(-b.pPrev)}" y2="${Y(-b.pPrev)}" stroke="${C.text}" stroke-width="1.4" opacity=".55"/>`;
      }
    }
  }
  // cifra encima del strike con mas calls y debajo del de mas puts
  const tag = (k, v, col, below) => (k == null || k < lo || k > hi ? "" : `<text x="${X(k)}" y="${below ? Y(v) + 14 : Y(v) - 6}" fill="${col}" font-size="11" font-weight="700" text-anchor="middle">${fmtNum(k, k % 1 ? 1 : 0)}</text>`);
  const tags = met === "oi" ? tag(cTop, a.cWall.cOI, C.call, false) + tag(pTop, -a.pWall.pOI, C.put, true) : "";
  // lineas verticales con su etiqueta en pastilla arriba
  const pill = (v, col, lab, row, dash) => {
    if (v < lo || v > hi) return "";
    const x = X(v), w = lab.length * 6.3 + 14, bx = Math.max(pad.l, Math.min(W - pad.r - w, x - w / 2)), by = 4 + row * 0;
    return `<line x1="${x}" x2="${x}" y1="${pad.t - 6}" y2="${H - pad.b}" stroke="${col}" stroke-dasharray="${dash}" stroke-width="1.2"/>
      <rect x="${bx}" y="${by}" width="${w}" height="18" rx="9" fill="${col}"/><text x="${bx + w / 2}" y="${by + 12.5}" fill="${C.surface}" font-size="11" font-weight="700" text-anchor="middle">${lab}</text>`;
  };
  const painLab = a.pain != null ? `Max pain ${px(a.pain)}` : "", spotLab = `${px(S)}`;
  // si las dos pastillas se pisan, max pain se desplaza a un lado
  const near = a.pain != null && Math.abs(X(a.pain) - X(S)) < (painLab.length + spotLab.length) * 3.3 + 18;
  const painPill = a.pain == null ? "" : near
    ? (() => { const x = X(a.pain); return `<line x1="${x}" x2="${x}" y1="${pad.t - 6}" y2="${H - pad.b}" stroke="${C.amber}" stroke-dasharray="5 4" stroke-width="1.2"/><text x="${x + (a.pain >= S ? 6 : -6)}" y="${pad.t + 6}" fill="${C.amber}" font-size="11" font-weight="700" text-anchor="${a.pain >= S ? "start" : "end"}">${painLab}</text>`; })()
    : pill(a.pain, C.amber, painLab, 0, "5 4");
  box.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${LAB_MONO}">
    ${yt.map((v) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="${C.grid}"/><text x="${pad.l - 8}" y="${Y(v) + 4}" fill="${C.faint}" font-size="11" text-anchor="end">${fmtBig(Math.abs(v))}</text>`).join("")}
    ${xt.map((v) => `<text x="${X(v)}" y="${H - pad.b + 18}" fill="${C.faint}" font-size="11" text-anchor="middle">${fmtNum(v, hi - lo < 20 ? 1 : 0)}</text>`).join("")}
    <rect id="oiHover" y="${pad.t - 6}" height="${H - pad.b - pad.t + 6}" width="${Math.max(bw + 8, 10)}" rx="6" fill="${C.text}" opacity=".07" visibility="hidden"/>
    ${bars}
    <line x1="${pad.l}" x2="${W - pad.r}" y1="${zy}" y2="${zy}" stroke="${C.muted}"/>
    ${tags}
    ${painPill}${pill(S, C.text, spotLab, 0, "2 3")}
  </svg>`;
  oiv.geo = { X, Y, bins, lo, hi, pad, bw };
}
function oiLegend(a, met) {
  const sq = (c) => `<i style="background:${c}"></i>`;
  $("oiLeg").innerHTML = met === "chg"
    ? `<span>${sq(C.call)}Calls added or closed</span><span>${sq(C.put)}Puts added or closed</span><span class="oi-leg-t">since the previous session, by strike</span>`
    : `<span>${sq(C.call)}Calls</span><span>${sq(C.put)}Puts</span>${met === "oi" && oiv.ch.hasPrev ? `<span><i class="oi-tick"></i>Previous session</span>` : ""}${a.pain != null ? `<span><i class="dash" style="border-color:${C.amber}"></i>Max pain</span>` : ""}<span class="oi-leg-t">${met === "oi" ? "contracts open by strike" : "contracts traded today by strike"}</span>`;
}

function oiProbe(e) {
  const g = oiv.geo, box = $("oiChart"); if (!g) return;
  const svg = box.querySelector("svg"); if (!svg) return;
  const mx = e.clientX - svg.getBoundingClientRect().left, hv = $("oiHover");
  if (mx < g.pad.l || mx > g.X(g.hi)) { toolTip(box, null); if (hv) hv.setAttribute("visibility", "hidden"); return; }
  const x = g.X.inv(mx);
  const b = g.bins.reduce((p, q) => (Math.abs(q.K - x) < Math.abs(p.K - x) ? q : p));
  hv.setAttribute("x", g.X(b.K) - Math.max(g.bw + 8, 10) / 2); hv.setAttribute("visibility", "visible");
  const ch = (v) => (!oiv.ch.hasPrev ? "" : v > 0 ? `<em class="up">+${fmtNum(v)}</em>` : v < 0 ? `<em class="dn">−${fmtNum(-v)}</em>` : `<em>0</em>`);
  const lab = b.from != null && b.from !== b.to ? `${px(b.from)} to ${px(b.to)}` : px(b.K);
  const pc = b.cOI ? fmtNum(b.pOI / b.cOI, 2) : "—", S = oiv.ch.spot;
  toolTip(box, `<div class="tt-h">Strike ${lab} <small>${b.K >= S ? "+" : "−"}${fmtNum(Math.abs(b.K / S - 1) * 100, 1)}%</small></div>
    <div class="tt-r"><span><i style="background:${C.call}"></i>Call OI</span><b>${fmtNum(b.cOI)} ${ch(b.cChg)}</b></div>
    <div class="tt-r"><span><i style="background:${C.put}"></i>Put OI</span><b>${fmtNum(b.pOI)} ${ch(b.pChg)}</b></div>
    <div class="tt-r"><span>Volume, calls and puts</span><b>${fmtNum(b.cVol)} / ${fmtNum(b.pVol)}</b></div>
    <div class="tt-r"><span>Put/call at this strike</span><b>${pc}</b></div>`, mx, e.clientY - svg.getBoundingClientRect().top);
}

function oiStats(a) {
  const t = a.t, ch = oiv.ch, S = ch.spot;
  const pc = t.cOI ? t.pOI / t.cOI : null, pcv = t.cVol ? t.pVol / t.cVol : null;
  const chg = (v) => (ch.hasPrev ? ` <small class="${v > 0 ? "up" : v < 0 ? "dn" : ""}">${v > 0 ? "+" : v < 0 ? "−" : ""}${fmtBig(Math.abs(v))}</small>` : "");
  const it = (k, v, cls = "", hint = "") => `<div class="lab-st ${cls}"${hint ? ` title="${esc(hint)}"` : ""}><span>${k}</span><b>${v}</b></div>`;
  $("oiStats").innerHTML =
    it("Call OI", fmtBig(t.cOI) + chg(t.cChg), "", ch.hasPrev ? "Change since the previous session in small" : "") +
    it("Put OI", fmtBig(t.pOI) + chg(t.pChg), "", ch.hasPrev ? "Change since the previous session in small" : "") +
    it("Put/call OI", pc == null ? "—" : fmtNum(pc, 2), pc == null ? "" : pc > 1.2 ? "up" : pc < 0.7 ? "dn" : "", "Puts open per call open") +
    it("Put/call volume", pcv == null ? "—" : fmtNum(pcv, 2), "", "Puts traded per call traded today") +
    it("Volume", t.cVol + t.pVol ? fmtBig(t.cVol + t.pVol) : "—", "", "Contracts traded today in the chosen expirations") +
    it("Max pain", a.pain == null ? "—" : `${px(a.pain)} <small>${a.pain >= S ? "+" : "−"}${fmtNum(Math.abs(a.pain / S - 1) * 100, 1)}%</small>`, "amb", "Price at which the chosen options would be worth the least at expiration") +
    it("Top call strike", a.cWall ? `${px(a.cWall.K)} <small>${fmtBig(a.cWall.cOI)}</small>` : "—", "", "Strike with the most call contracts open, within 25% of the price") +
    it("Top put strike", a.pWall ? `${px(a.pWall.K)} <small>${fmtBig(a.pWall.pOI)}</small>` : "—", "", "Strike with the most put contracts open, within 25% of the price");
}

// OI de cada vencimiento (calls arriba, puts abajo, en raiz cuadrada para que se vean los pequenos); sirven para elegir fechas
function oiByExp() {
  const box = $("oiByExp"), ch = oiv.ch, sel = oiSelected();
  const live = oiDays().slice(0, 30);
  const tot = live.map((e) => {
    let c = 0, p = 0;
    const ix = new Set(e.idx);
    for (const x of ch.rows) if (ix.has(x.e)) { if (x.call) c += x.oi; else p += x.oi; }
    return { e, c, p };
  });
  const mc = Math.max(1, ...tot.map((x) => x.c)), mp = Math.max(1, ...tot.map((x) => x.p));
  box.innerHTML = `<div class="oi-bx">${tot.map(({ e, c, p }) => {
    const on = e.idx.some((i) => sel.has(i));
    return `<button type="button" data-k="${e.iso}" class="${on ? "on" : "off"}" title="${shortDate(e.iso)}: ${fmtNum(c)} calls, ${fmtNum(p)} puts open">
      <span class="oi-bx-c"><i style="height:${(Math.sqrt(c / mc) * 100).toFixed(1)}%;background:${C.call}"></i></span>
      <span class="oi-bx-p"><i style="height:${(Math.sqrt(p / mp) * 100).toFixed(1)}%;background:${C.put}"></i></span>
      <span class="oi-bx-l">${shortDate(e.iso).replace(/ '\d\d$/, "")}</span><span class="oi-bx-d">${e.monthly ? "M " : ""}${fmtNum(Math.max(e.days, 0), 0)}d</span></button>`;
  }).join("")}</div>`;
}

// al lado: contratos abiertos y cerrados (OI y cambio) o los mas negociados (volumen)
function oiMovers(a) {
  const box = $("oiMovers"), ch = oiv.ch;
  const row = (x, val, cls = "") => {
    const e = ch.exps[x.e];
    return `<tr><td class="l"><b>${fmtNum(x.K, x.K % 1 ? 1 : 0)}</b> <i class="oi-cp ${x.call ? "c" : "p"}">${x.call ? "C" : "P"}</i><small>${shortDate(e.iso).replace(/ '\d\d$/, "")}</small></td><td>${fmtNum(x.oi)}</td><td class="${cls}">${val}</td></tr>`;
  };
  if (oiv.metric === "vol") {
    $("oiSideT").textContent = "Most traded today"; $("oiChgSub").textContent = "contracts";
    const top = a.rows.filter((x) => x.vol > 0).sort((p, q) => q.vol - p.vol).slice(0, 14);
    box.innerHTML = top.length ? `<table class="oi-t"><thead><tr><th class="l">Contract</th><th>OI</th><th>Volume</th></tr></thead><tbody>${top.map((x) => row(x, `${fmtNum(x.vol)}${x.oi && x.vol > x.oi ? ' <em class="oi-hot" title="More contracts traded today than were open: mostly new positions">&gt; OI</em>' : ""}`)).join("")}</tbody></table>` : `<p class="re-empty">No volume yet today.</p>`;
    return;
  }
  $("oiSideT").textContent = "Biggest changes";
  if (!ch.hasPrev) { $("oiChgSub").textContent = ""; box.innerHTML = `<p class="re-empty">No previous session saved for ${esc(ch.symbol)} yet.</p>`; return; }
  $("oiChgSub").textContent = `vs. ${shortDate(ch.prevDate)}`;
  const rows = a.rows.filter((x) => x.prev != null && x.oi !== x.prev).map((x) => ({ ...x, d: x.oi - x.prev }));
  const add = rows.filter((x) => x.d > 0).sort((p, q) => q.d - p.d).slice(0, 7);
  const cut = rows.filter((x) => x.d < 0).sort((p, q) => p.d - q.d).slice(0, 7);
  const tbl = (t, list) => `<h4>${t}</h4>${list.length ? `<table class="oi-t"><thead><tr><th class="l">Contract</th><th>OI</th><th>Change</th></tr></thead><tbody>${list.map((x) => row(x, `${x.d > 0 ? "+" : "−"}${fmtNum(Math.abs(x.d))}`, x.d > 0 ? "up" : "dn")).join("")}</tbody></table>` : `<p class="re-empty">None</p>`}`;
  box.innerHTML = tbl("Opened", add) + tbl("Closed", cut);
}
function renderOI() { if (oiv.built && oiv.ch) oiRender(); }
