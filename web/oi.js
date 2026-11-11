"use strict";
/* ============================================================ Open Interest
   OI, cambio de OI frente a la sesion anterior y volumen por strike del ticker de la barra superior, para los
   vencimientos elegidos. Calls hacia arriba y puts hacia abajo. Al lado: totales, ratio put/call, max pain y los
   strikes con mas OI; debajo, el OI por vencimiento (se puede elegir pulsando) y los contratos con mas altas y bajas. */

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
function oiBuild() {
  $("oiView").innerHTML = `
  <header class="lab-head">
    <div class="lab-title"><h1>Open Interest</h1><span class="lab-sym" id="oiSym"></span></div>
    <div class="lab-keys" role="radiogroup" id="oiMetric" aria-label="Measure">
      <button role="radio" data-v="oi">Open interest</button><button role="radio" data-v="chg">Change</button><button role="radio" data-v="vol">Volume</button></div>
  </header>
  <p class="lab-say" id="oiSub"></p>
  <div class="oi-exps" id="oiExps" role="group" aria-label="Expirations"></div>
  <div class="lab-read oi-read" id="oiStats"></div>
  <section class="lab-panel">
    <div class="lab-cap"><span id="oiLeg"></span>
      <span class="lab-keys small" role="radiogroup" id="oiRange" aria-label="Strike range">
        <button role="radio" data-v="5">±5%</button><button role="radio" data-v="10">±10%</button><button role="radio" data-v="20">±20%</button></span></div>
    <div class="ss-chart oi-chart" id="oiChart" role="img" aria-label="Open interest by strike"></div>
  </section>
  <div class="oi-grid2">
    <section class="lab-panel"><div class="lab-cap"><span>By expiration</span><span>click a bar to see only that one</span></div><div class="oi-bxw" id="oiByExp"></div></section>
    <section class="lab-panel"><div class="lab-cap"><span>Biggest changes</span><span id="oiChgSub"></span></div><div id="oiMovers"></div></section>
  </div>
  <p class="tl-note">Open interest is published once a day, before the open: the contracts left open at the previous close. The change compares it with the session before; volume is today's so far. Max pain is the price at which the options of the chosen expirations would be worth the least at expiration.</p>`;
  const segSync = () => {
    for (const b of $("oiMetric").querySelectorAll("button")) b.setAttribute("aria-checked", String(b.dataset.v === oiv.metric));
    for (const b of $("oiRange").querySelectorAll("button")) b.setAttribute("aria-checked", String(+b.dataset.v === oiv.range));
  };
  oiv.segSync = segSync; segSync();
  $("oiMetric").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; oiv.metric = b.dataset.v; store.set("oiTMetric", oiv.metric); segSync(); oiRender(); });
  $("oiRange").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; oiv.range = +b.dataset.v; store.set("oiTRange", String(oiv.range)); segSync(); oiRender(); });
  $("oiExps").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.m) { oiv.mode = b.dataset.m; oiv.pick = []; }
    else oiPick(b.dataset.k, e.shiftKey || e.ctrlKey || e.metaKey);
    store.set("oiTMode", oiv.mode === "pick" ? "all" : oiv.mode);
    oiRender();
  });
  $("oiByExp").addEventListener("click", (e) => { const r = e.target.closest("[data-k]"); if (r) { oiPick(r.dataset.k, e.shiftKey || e.ctrlKey || e.metaKey); oiRender(); } });
  $("oiChart").addEventListener("mousemove", oiProbe);
  $("oiChart").addEventListener("mouseleave", () => toolTip($("oiChart"), null));
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
  const ch = oiv.ch, S = ch.spot;
  $("oiSym").innerHTML = spotLabel(ch);
  const nsel = oiSelected().size, nall = ch.live.length;
  $("oiSub").innerHTML = `Where ${esc(ch.symbol)} options are open${nsel === nall ? " across all expirations" : `, in ${nsel} of ${nall} expirations`}${ch.hasPrev ? `, and what changed since the <b>${shortDate(ch.prevDate)}</b> session` : ""}.${oiv.metric === "chg" && !ch.hasPrev ? " No previous session is saved for this ticker yet: the change appears after its next daily update." : ""}`;
  // vencimientos
  const live = oiDays().slice(0, 18);
  $("oiExps").innerHTML = OI_MODES.map(([k, t]) => `<button type="button" data-m="${k}" class="mode" aria-pressed="${oiv.mode === k}">${t}</button>`).join("") +
    `<span class="oi-sep"></span>` + live.map((d) => `<button type="button" data-k="${d.iso}" aria-pressed="${oiv.mode === "pick" && oiv.pick.includes(d.iso)}" title="Shift-click to add more expirations">${shortDate(d.iso)}${d.monthly ? '<i class="vm">M</i>' : ""}<small>${fmtNum(Math.max(d.days, 0), d.days < 1 ? 1 : 0)}d</small></button>`).join("");
  const a = oiAggregate();
  oiv.agg = a;
  oiChart(a);
  oiStats(a);
  oiByExp();
  oiMovers(a);
}

function oiChart(a) {
  const box = $("oiChart"), S = oiv.ch.spot, met = oiv.metric;
  const lo = S * (1 - oiv.range / 100), hi = S * (1 + oiv.range / 100);
  let bins = a.strikes.filter((b) => b.K >= lo && b.K <= hi);
  const W = Math.max(320, box.clientWidth), H = Math.max(320, Math.min(480, Math.round(W * 0.42)));
  const pad = { l: 62, r: 16, t: 26, b: 34 };
  // demasiados strikes para el ancho: se agrupan en tramos redondos
  const maxBars = Math.floor((W - pad.l - pad.r) / 5);
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
  if (!bins.length) { box.innerHTML = `<div class="placeholder"><div>No open interest in this range.</div></div>`; return; }
  const up = (b) => (met === "oi" ? b.cOI : met === "vol" ? b.cVol : b.cChg);
  const dn = (b) => (met === "oi" ? -b.pOI : met === "vol" ? -b.pVol : b.pChg);
  let y0 = 0, y1 = 0;
  for (const b of bins) {
    if (met === "chg") { y0 = Math.min(y0, up(b), dn(b)); y1 = Math.max(y1, up(b), dn(b)); }
    else { y1 = Math.max(y1, up(b), met === "oi" ? b.cPrev : 0); y0 = Math.min(y0, dn(b), met === "oi" ? -b.pPrev : 0); }
  }
  if (y0 === 0 && y1 === 0) { y0 = -1; y1 = 1; }
  const sp = y1 - y0; y1 += sp * 0.06; y0 -= sp * 0.06;
  const X = scale(lo, hi, pad.l, W - pad.r), Y = scale(y0, y1, H - pad.b, pad.t), zy = Y(0);
  const keys = bins.map((b) => b.K);
  let gap = Infinity; for (let i = 1; i < keys.length; i++) gap = Math.min(gap, keys[i] - keys[i - 1]);
  if (!isFinite(gap)) gap = (hi - lo) / 40;
  const bw = Math.max(1.2, Math.min(18, (X(lo + gap) - X(lo)) * 0.78));
  const yt = axisTicks(y0, y1, 6);
  let bars = "";
  for (const b of bins) {
    const x = X(b.K);
    if (met === "chg") {
      const hw = bw / 2;
      const r = (v, col, dx) => `<rect x="${(x + dx).toFixed(1)}" y="${Math.min(Y(v), zy).toFixed(1)}" width="${hw.toFixed(1)}" height="${Math.max(Math.abs(Y(v) - zy), v ? 0.8 : 0).toFixed(1)}" fill="${col}"/>`;
      bars += r(up(b), C.call, -hw) + r(dn(b), C.put, 0);
    } else {
      bars += `<rect x="${(x - bw / 2).toFixed(1)}" y="${Y(up(b)).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(zy - Y(up(b)), up(b) ? 0.8 : 0).toFixed(1)}" fill="${C.call}" opacity=".85"/>`;
      bars += `<rect x="${(x - bw / 2).toFixed(1)}" y="${zy.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(Y(dn(b)) - zy, dn(b) ? 0.8 : 0).toFixed(1)}" fill="${C.put}" opacity=".85"/>`;
      if (met === "oi" && oiv.ch.hasPrev && bw >= 3) {   // OI de la sesion anterior: una marca sobre cada barra
        if (b.cPrev !== b.cOI) bars += `<line x1="${x - bw / 2 - 1}" x2="${x + bw / 2 + 1}" y1="${Y(b.cPrev)}" y2="${Y(b.cPrev)}" stroke="${C.muted}" stroke-width="1.4"/>`;
        if (b.pPrev !== b.pOI) bars += `<line x1="${x - bw / 2 - 1}" x2="${x + bw / 2 + 1}" y1="${Y(-b.pPrev)}" y2="${Y(-b.pPrev)}" stroke="${C.muted}" stroke-width="1.4"/>`;
      }
    }
  }
  const vline = (v, col, lab, dash, row) => (v >= lo && v <= hi ? `<line x1="${X(v)}" x2="${X(v)}" y1="${pad.t - 6}" y2="${H - pad.b}" stroke="${col}" stroke-dasharray="${dash}" stroke-width="1.2"/><text x="${X(v) + 5}" y="${pad.t - 10 + row * 12}" fill="${col}" font-size="11.5">${lab}</text>` : "");
  const xt = axisTicks(lo, hi, Math.max(4, Math.round(W / 110)));
  box.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${LAB_MONO}">
    <defs>${graphPaper("oi", pad.l, pad.t)}</defs>
    <rect x="${pad.l}" y="${pad.t}" width="${W - pad.l - pad.r}" height="${H - pad.t - pad.b}" fill="url(#oiGP)"/>
    <rect x="${pad.l}" y="${pad.t}" width="${W - pad.l - pad.r}" height="${H - pad.t - pad.b}" fill="none" stroke="${C.axis}"/>
    ${yt.map((v) => `<text x="${pad.l - 8}" y="${Y(v) + 4}" fill="${C.faint}" font-size="11" text-anchor="end">${fmtBig(Math.abs(v))}</text>`).join("")}
    ${xt.map((v) => `<text x="${X(v)}" y="${H - pad.b + 18}" fill="${C.faint}" font-size="11.5" text-anchor="middle">${fmtNum(v, hi - lo < 20 ? 1 : 0)}</text>`).join("")}
    <text x="${pad.l + 6}" y="${pad.t + 14}" fill="${C.call}" font-size="11.5" font-weight="600" font-family="${SANS}">${met === "chg" ? "Calls (left)" : "Calls"}</text>
    <text x="${pad.l + 6}" y="${H - pad.b - 7}" fill="${C.put}" font-size="11.5" font-weight="600" font-family="${SANS}">${met === "chg" ? "Puts (right)" : "Puts"}</text>
    ${bars}
    <line x1="${pad.l}" x2="${W - pad.r}" y1="${zy}" y2="${zy}" stroke="${C.muted}"/>
    ${vline(S, C.spotline, `Spot ${px(S)}`, "1 3", 0)}
    ${a.pain != null ? vline(a.pain, C.amber, `Max pain ${px(a.pain)}`, "5 4", 1) : ""}
    <line id="oiHover" y1="${pad.t}" y2="${H - pad.b}" stroke="${C.muted}" visibility="hidden"/>
  </svg>`;
  $("oiLeg").innerHTML = met === "oi" ? `Contracts open by strike${oiv.ch.hasPrev ? `<span class="oi-tick"></span>previous session` : ""}` :
    met === "vol" ? "Contracts traded today by strike" : "Contracts added (up) or closed (down) since the previous session";
  oiv.geo = { X, Y, bins, lo, hi, pad };
}

function oiProbe(e) {
  const g = oiv.geo, box = $("oiChart"); if (!g) return;
  const svg = box.querySelector("svg"); if (!svg) return;
  const px = e.clientX - svg.getBoundingClientRect().left, hv = $("oiHover");
  if (px < g.pad.l || px > g.X(g.hi)) { toolTip(box, null); if (hv) hv.setAttribute("visibility", "hidden"); return; }
  const x = g.X.inv(px);
  const b = g.bins.reduce((p, q) => (Math.abs(q.K - x) < Math.abs(p.K - x) ? q : p));
  hv.setAttribute("x1", g.X(b.K)); hv.setAttribute("x2", g.X(b.K)); hv.setAttribute("visibility", "visible");
  const ch = (v) => (v > 0 ? `<em class="up">+${fmtNum(v)}</em>` : v < 0 ? `<em class="dn">−${fmtNum(-v)}</em>` : `<em>0</em>`);
  const lab = b.from != null && b.from !== b.to ? `${px(b.from)} to ${px(b.to)}` : px(b.K);
  toolTip(box, `<div class="tt-h">Strike ${lab}</div>
    <div class="tt-r"><span><i style="background:${C.call}"></i>Call OI</span><b>${fmtNum(b.cOI)} ${oiv.ch.hasPrev ? ch(b.cChg) : ""}</b></div>
    <div class="tt-r"><span><i style="background:${C.put}"></i>Put OI</span><b>${fmtNum(b.pOI)} ${oiv.ch.hasPrev ? ch(b.pChg) : ""}</b></div>
    <div class="tt-r"><span>Volume calls / puts</span><b>${fmtNum(b.cVol)} / ${fmtNum(b.pVol)}</b></div>`, px, e.clientY - svg.getBoundingClientRect().top);
}

function oiStats(a) {
  const t = a.t, ch = oiv.ch, S = ch.spot;
  const pc = t.cOI ? t.pOI / t.cOI : null, pcv = t.cVol ? t.pVol / t.cVol : null;
  const chg = (v) => (ch.hasPrev ? `<em class="${v > 0 ? "up" : v < 0 ? "dn" : ""}">${v > 0 ? "+" : v < 0 ? "−" : ""}${fmtBig(Math.abs(v))}</em>` : "");
  const cell = (k, v, sub, cls = "") => `<div class="lab-r ${cls}"><span>${k}</span><b>${v}</b><small>${sub}</small></div>`;
  $("oiStats").innerHTML =
    cell('<i class="lamp" style="background:var(--call)"></i>Call OI', fmtBig(t.cOI), `${chg(t.cChg)} ${ch.hasPrev ? "since last session" : ""}`) +
    cell('<i class="lamp" style="background:var(--put)"></i>Put OI', fmtBig(t.pOI), `${chg(t.pChg)} ${ch.hasPrev ? "since last session" : ""}`) +
    cell("Put/call", pc == null ? "—" : fmtNum(pc, 2), pcv == null ? "no volume yet" : `${fmtNum(pcv, 2)} in today's volume`) +
    cell("Max pain", a.pain == null ? "—" : px(a.pain), a.pain == null ? "" : `${a.pain >= S ? "+" : "−"}${fmtNum(Math.abs(a.pain / S - 1) * 100, 1)}% from ${px(S)}`, "amb") +
    cell("Top call strike", a.cWall ? px(a.cWall.K) : "—", a.cWall ? `${fmtBig(a.cWall.cOI)} contracts` : "") +
    cell("Top put strike", a.pWall ? px(a.pWall.K) : "—", a.pWall ? `${fmtBig(a.pWall.pOI)} contracts` : "");
}

function oiByExp() {
  const box = $("oiByExp"), ch = oiv.ch, sel = oiSelected(), all = oiv.mode === "all";
  const live = oiDays().slice(0, 24);
  const tot = live.map((e) => {
    let c = 0, p = 0;
    const ix = new Set(e.idx);
    for (const x of ch.rows) if (ix.has(x.e)) { if (x.call) c += x.oi; else p += x.oi; }
    return { e, c, p };
  });
  const mx = Math.max(1, ...tot.map((x) => x.c + x.p));
  box.innerHTML = `<div class="oi-bx">${tot.map(({ e, c, p }) => `<button type="button" data-k="${e.iso}" class="${!all && e.idx.some((i) => sel.has(i)) ? "on" : ""}" title="${shortDate(e.iso)}: ${fmtNum(c)} calls, ${fmtNum(p)} puts">
      <span class="oi-bx-bar"><i style="height:${(c / mx * 100).toFixed(1)}%;background:${C.call}"></i><i style="height:${(p / mx * 100).toFixed(1)}%;background:${C.put}"></i></span>
      <span class="oi-bx-l">${shortDate(e.iso).replace(/ '\d\d$/, "")}${e.monthly ? '<i class="vm">M</i>' : ""}</span></button>`).join("")}</div>`;
}

function oiMovers(a) {
  const box = $("oiMovers"), ch = oiv.ch;
  if (!ch.hasPrev) { $("oiChgSub").textContent = ""; box.innerHTML = `<p class="re-empty">No previous session saved for ${esc(ch.symbol)} yet.</p>`; return; }
  $("oiChgSub").textContent = `contracts, vs. ${shortDate(ch.prevDate)}`;
  const rows = a.rows.filter((x) => x.prev != null && x.oi !== x.prev).map((x) => ({ ...x, d: x.oi - x.prev }));
  const add = rows.filter((x) => x.d > 0).sort((p, q) => q.d - p.d).slice(0, 7);
  const cut = rows.filter((x) => x.d < 0).sort((p, q) => p.d - q.d).slice(0, 7);
  const tr = (x) => {
    const e = ch.exps[x.e];
    return `<tr><td class="l"><b>${fmtNum(x.K, x.K % 1 ? 1 : 0)} ${x.call ? "call" : "put"}</b><small>${shortDate(e.iso)}</small></td><td>${fmtNum(x.oi)}</td><td class="${x.d > 0 ? "up" : "dn"}">${x.d > 0 ? "+" : "−"}${fmtNum(Math.abs(x.d))}</td><td>${fmtNum(x.vol)}</td></tr>`;
  };
  const tbl = (t, list) => `<div><h4>${t}</h4>${list.length ? `<table class="oi-t"><thead><tr><th class="l">Contract</th><th>OI</th><th>Change</th><th>Volume</th></tr></thead><tbody>${list.map(tr).join("")}</tbody></table>` : `<p class="re-empty">None</p>`}</div>`;
  box.innerHTML = `<div class="oi-movers">${tbl("Opened", add)}${tbl("Closed", cut)}</div>`;
}
function renderOI() { if (oiv.built && oiv.ch) oiRender(); }
