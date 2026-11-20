"use strict";
/* ============================================================ Crypto (BTC y ETH)
   Datos: /api/crypto (pub/cripto.json, lo publica cripto.py cada 15 min; diseno en docs/CRIPTO.md).
   A la izquierda la lectura por reglas (tendencia y posicionamiento) y las cifras clave; a la derecha GEX de
   Deribit, mapa de niveles, coste on-chain, volatilidad, vencimientos, futuros y mercado.
   Nombres con prefijo cx: los globales se comparten entre los scripts de web/. */

const cx = { data: null, at: 0, ctrl: null, sym: store.get("cxSym", "BTC"), filt: store.get("cxFilt", "all"), geo: {} };
const CX_NAME = { BTC: "Bitcoin", ETH: "Ether" };
const CX_FILT = { 7: "7 days", 30: "30 days", all: "All expirations" };

const cxPx = (v) => (v == null ? "—" : "$" + fmtNum(v, v >= 1000 ? 0 : 2));
const cxPct = (v, dec = 1) => (v == null ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "") + fmtNum(Math.abs(v), dec) + "%");
const cxTone = (t) => (t > 0 ? "pos" : t < 0 ? "neg" : "");

function cxStatus() {
  const d = cx.data;
  if (!d) return "";
  const t = new Date(d.generado);
  return `Crypto, updated ${t.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
}

function showCrypto() {
  if (cx.data) { renderCrypto(); setStatus("", cxStatus()); }
  if (!cx.data || Date.now() - cx.at > 300000) loadCrypto();
}

async function loadCrypto() {
  if (cx.ctrl) cx.ctrl.abort();
  cx.ctrl = new AbortController();
  $("refreshBtn").classList.add("spin");
  setStatus("busy", "Loading crypto…");
  try {
    const r = await fetch("/api/crypto", { signal: cx.ctrl.signal });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Could not load the crypto data");
    cx.data = d; cx.at = Date.now();
    if (state.mode === "crypto") { renderCrypto(); setStatus("", cxStatus()); }
  } catch (e) {
    if (e.name === "AbortError") return;
    if (state.mode === "crypto") {
      setStatus("err", cx.data ? "Could not refresh" : "No data");
      if (!cx.data) $("cxRead").innerHTML = `<div class="empty">${esc(e.message === "Failed to fetch" ? "The local server is not responding. Open GEX Lab again." : e.message)}</div>`;
    }
  } finally { $("refreshBtn").classList.remove("spin"); }
}

function renderCrypto() {
  const d = cx.data;
  if (!d) return;
  if (!d.activos[cx.sym]) cx.sym = Object.keys(d.activos)[0];
  const a = d.activos[cx.sym], m = d.mercado || {}, lec = a.lectura || {}, oc = a.onchain, v = a.vol || {}, f = a.futuros || {};
  document.querySelectorAll("#cxSym button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === cx.sym)));
  document.querySelectorAll("#cxFilt button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === cx.filt)));

  $("cxTitle").textContent = `${CX_NAME[cx.sym] || cx.sym} ${cxPx(a.spot)}`;
  $("cxTitle").title = "Deribit index";
  const st = $("cxState");
  st.textContent = lec.resumen || "—";
  st.className = "mstate " + (lec.especial === "Capitulation zone" ? "mixed" : lec.tend > 0 ? "contango" : lec.tend < 0 ? "backwardation" : "mixed");
  $("cxSub").innerHTML = `${cxPct(a.chg24, 2)} in 24 h, ${cxPct(a.chg7)} in 7 days, ${cxPct(a.chg30)} in 30 days${a.viejo ? `. <b class="neg">Data from ${esc(new Date(a.viejo).toLocaleString("en-US"))}: the last update failed</b>` : ""}`;
  $("cxAxes").innerHTML = `<span><b>Trend</b> ${esc(lec.tendencia || "—")}</span><span><b>Positioning</b> ${esc(lec.posicion || "—")}</span>`;
  const grupos = [["tendencia", "Trend"], ["posicion", "Positioning and value"]];
  $("cxRead").innerHTML = grupos.map(([k, t]) => {
    const p = (lec.puntos || []).filter((x) => x.eje === k);
    return p.length ? `<div class="cx-rg">${t}</div>` + p.map((x) => `<div class="cx-pt"><i class="${cxTone(x.tono)}"></i><div><span class="cx-bl">${esc(x.bloque)}</span> ${esc(x.texto)}</div></div>`).join("") : "";
  }).join("");

  const g = a.gex.all, fact = (l, val, s, warn) => `<div class="fact"><span class="fl">${l}</span><strong>${val}</strong><span class="fs${warn ? " warn" : ""}">${s}</span></div>`;
  const fng = m.fng;
  $("cxFacts").innerHTML = [
    fact("Net GEX (Deribit)", fmtBig(g.total, true), `per 1% move, all expirations. Open interest ${fmtBig(a.oi.nocional, true)}, put/call ${fmtNum(a.oi.pcr, 2)}`),
    oc ? fact("MVRV", fmtNum(oc.mvrv, 2), `${ordinal(oc.mvrv_pct)} percentile since 2015. Realized price ${cxPx(oc.rp)}`) : "",
    oc && oc.sth ? fact("Short-term holder cost", cxPx(oc.sth.valor), `${cxPct((a.spot / oc.sth.valor - 1) * 100)} from price. Data of ${ddmm(oc.sth.fecha)} (free source, a week behind)`, true) : "",
    v.dvol != null ? fact("DVOL", fmtNum(v.dvol, 1), `${v.dvol_pct != null ? ordinal(v.dvol_pct) + " percentile of the last year. " : ""}30-day realized ${fmtNum(v.rv30, 1)}`) : "",
    v.rr25_30 != null ? fact("25-delta risk reversal (30 d)", cxPct(v.rr25_30, 1).replace("%", ""), v.rr25_30 < 0 ? "puts over calls, vol points" : "calls over puts, vol points") : "",
    f.funding_7d != null ? fact("Funding, 7-day average", cxPct(f.funding_7d), `a year (OKX). Now ${cxPct(f.funding)}${f.funding_deribit != null ? `, Deribit ${cxPct(f.funding_deribit)}` : ""}`) : "",
    f.oi_usd != null ? fact("Futures open interest (OKX)", fmtBig(f.oi_usd, true), `${cxPct(f.oi_chg7)} in 7 days. Long/short accounts ${fmtNum(f.lsr, 2)}`) : "",
    fng ? fact("Fear & Greed", String(fng.valor), `${esc(fng.clase)}${fng.semana != null ? `, ${fng.semana} a week ago` : ""}`) : "",
    m.stables ? fact("Stablecoin supply", fmtBig(m.stables.total, true), `${cxPct(m.stables.chg30)} in 30 days: dry powder to buy`) : "",
    m.dom ? fact("Bitcoin dominance", fmtNum(m.dom.BTC, 1) + "%", `ether ${fmtNum(m.dom.ETH, 1)}%. Total market ${fmtBig(m.cap_total, true)}`) : "",
  ].join("");
  const errs = Object.keys(d.errores || {});
  $("cxErr").textContent = errs.length ? `Sources that failed this time: ${errs.join(", ")}. The rest is current.` : "";
  $("cxErr").hidden = !errs.length;

  const gf = a.gex[cx.filt] || g;
  $("cxGexCap").textContent = `Dealer gamma by strike (bars) and net GEX if price moved there (line), ${CX_FILT[cx.filt].toLowerCase()}. ${gf.flip ? "Flip " + cxPx(gf.flip) : "No flip within 15%"}, Call Wall ${cxPx(gf.call_wall)}, Put Wall ${cxPx(gf.put_wall)}.`;
  cxGexChart(a, gf);
  cxLevelsChart(a);
  if (oc && oc.serie) {
    $("cxCostCap").textContent = `Daily close against the average cost of all coins (realized price)${oc.sth_serie ? " and of short- and long-term holders" : ""}, last two years. CoinMetrics${oc.sth_serie ? " and bitcoin-data.com" : ""}.`;
    cxCostChart(a);
  } else { $("cxCost").innerHTML = `<div class="empty">No on-chain data</div>`; $("cxCostCap").textContent = ""; }
  cxTermChart(a);
  cxDvolChart(a);
  cxTables(a, m);
}

/* ---------- GEX por strike y perfil */
function cxGexChart(a, gf) {
  const el = $("cxGex"), W = Math.max(320, el.clientWidth), H = Math.max(240, el.clientHeight);
  const L = 58, R = W - 58, T = 14, B = H - 30;
  const bars = gf.barras || [];
  if (!bars.length) { el.innerHTML = `<div class="empty">No open interest in this filter</div>`; return; }
  const lo = a.spot * 0.8, hi = a.spot * 1.2;
  const vb = bars.filter((b) => b[0] >= lo && b[0] <= hi);
  const xOf = (x) => L + ((x - lo) / (hi - lo)) * (R - L);
  const bm = Math.max(1, ...vb.map((b) => Math.max(b[1], -b[2])));
  const yb = niceTicks(-bm, bm, 4), yB = (v) => B - ((v - yb.lo) / (yb.hi - yb.lo)) * (B - T);
  const pp = gf.xs.map((x, i) => [x, gf.perfil[i]]).filter((p) => p[0] >= lo && p[0] <= hi);
  const pm = Math.max(1, ...pp.map((p) => Math.abs(p[1])));
  const yp = niceTicks(-pm, pm, 4), yP = (v) => B - ((v - yp.lo) / (yp.hi - yp.lo)) * (B - T);
  let s = yb.ticks.map((v) => `<line x1="${L}" x2="${R}" y1="${yB(v)}" y2="${yB(v)}" stroke="${C.grid}"/>` + txt(L - 8, yB(v) + 4, fmtBig(v), { a: "end", fs: 11 })).join("");
  s += yp.ticks.map((v) => txt(R + 8, yP(v) + 4, fmtBig(v), { fs: 11, c: C.accent })).join("");
  s += `<line x1="${L}" x2="${R}" y1="${yB(0)}" y2="${yB(0)}" stroke="${C.axis}"/>`;
  const steps = vb.map((b) => b[0]).sort((p, q) => p - q);
  let minGap = Infinity;
  for (let i = 1; i < steps.length; i++) minGap = Math.min(minGap, steps[i] - steps[i - 1]);
  const bw = Math.max(2, Math.min(18, ((isFinite(minGap) ? minGap : (hi - lo) / 40) / (hi - lo)) * (R - L) * 0.38));
  for (const [k, c, p] of vb) {
    const x = xOf(k);
    if (c) s += `<rect x="${(x - bw).toFixed(1)}" y="${yB(c).toFixed(1)}" width="${bw.toFixed(1)}" height="${(yB(0) - yB(c)).toFixed(1)}" fill="${C.pos}" fill-opacity=".8"/>`;
    if (p) s += `<rect x="${x.toFixed(1)}" y="${yB(0).toFixed(1)}" width="${bw.toFixed(1)}" height="${(yB(p) - yB(0)).toFixed(1)}" fill="${C.neg}" fill-opacity=".8"/>`;
  }
  s += `<path d="${pp.map((p, i) => `${i ? "L" : "M"}${xOf(p[0]).toFixed(1)},${yP(p[1]).toFixed(1)}`).join("")}" fill="none" stroke="${C.accent}" stroke-width="2"/>`;
  const vline = (x, col, lab, da, row) => {
    if (x == null || x < lo || x > hi) return "";
    const X = xOf(x);
    return `<line x1="${X}" x2="${X}" y1="${T}" y2="${B}" stroke="${col}" stroke-width="1.4"${da ? ` stroke-dasharray="${da}"` : ""}/>` + txt(X + 4, T + 10 + row * 13, lab, { fs: 11, c: col, w: 600 });
  };
  s += vline(gf.put_wall, C.put, "Put Wall", "4 3", 1) + vline(gf.call_wall, C.call, "Call Wall", "4 3", 1) + vline(gf.flip, C.amber, "Flip", "", 2);
  s += vline(a.spot, C.spotline, "Spot", "2 3", 0);
  const xt = niceTicks(lo, hi, Math.max(4, Math.round((R - L) / 90)));
  for (const v of xt.ticks) if (v >= lo && v <= hi) s += txt(xOf(v), B + 18, fmtNum(v), { a: "middle", fs: 11 });
  cx.geo.gex = { L, R, lo, hi, vb };
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${s}</svg>`;
}

function cxGexTip(e) {
  const g = cx.geo.gex;
  if (!g) return;
  const r = $("cxGex").getBoundingClientRect(), x = e.clientX - r.left;
  if (x < g.L || x > g.R || !g.vb.length) return macroTip("cxTip", null, e, "");
  const k = g.lo + ((x - g.L) / (g.R - g.L)) * (g.hi - g.lo);
  const b = g.vb.reduce((p, q) => (Math.abs(q[0] - k) < Math.abs(p[0] - k) ? q : p));
  macroTip("cxTip", null, e, `<div class="t">Strike ${cxPx(b[0])}</div>
    <div class="r">Calls <b style="color:${C.pos}">${fmtBig(b[1], true)}</b></div>
    <div class="r">Puts <b style="color:${C.neg}">${fmtBig(b[2], true)}</b></div>
    <div class="r">Net <b>${fmtBig(b[1] + b[2], true)}</b></div>`);
}

/* ---------- mapa de niveles: opciones y on-chain sobre el mismo eje de precio */
function cxLevelsChart(a) {
  const el = $("cxLevels"), W = Math.max(320, el.clientWidth), H = Math.max(120, el.clientHeight);
  const nv = a.niveles || [];
  if (!nv.length) { el.innerHTML = ""; return; }
  const L = 24, R = W - 24, Y = Math.round(H * 0.5);
  const ps = nv.map((n) => n.precio).concat(a.spot);
  const lo = Math.min(...ps) * 0.97, hi = Math.max(...ps) * 1.03, xOf = (x) => L + ((x - lo) / (hi - lo)) * (R - L);
  const col = { cw: C.call, pw: C.put, flip: C.amber, mp: C.muted, sth: C.purple, rp: C.accent, lth: C.prevClose };
  let s = `<line x1="${L}" x2="${R}" y1="${Y}" y2="${Y}" stroke="${C.axis}" stroke-width="2"/>`;
  // cuatro carriles de etiquetas (arriba, abajo, y un segundo nivel de cada uno): cada nivel, de izquierda a
  // derecha, va al primer carril donde no pisa a la etiqueta anterior
  const lanes = [{ up: true, d: 0 }, { up: false, d: 0 }, { up: true, d: 30 }, { up: false, d: 30 }].map((l) => ({ ...l, end: -1e9 }));
  const marcas = [];
  nv.slice().sort((p, q) => p.precio - q.precio).forEach((n) => {
    const X = xOf(n.precio), c = col[n.id] || C.muted;
    const lab1 = n.nombre, lab2 = `${cxPx(n.precio)} (${cxPct(n.dist)})`;
    const w = Math.max(textW(lab1, 11, 600), textW(lab2, 11)) + 12;
    const cx0 = Math.min(Math.max(X, L + w / 2 - 20), R - w / 2 + 20);   // dentro del grafico
    const lane = lanes.find((l) => cx0 - w / 2 >= l.end) || lanes.reduce((p, q) => (q.end < p.end ? q : p));
    lane.end = cx0 + w / 2;
    const y1 = lane.up ? Y - 30 - lane.d : Y + 24 + lane.d;
    s += `<line x1="${X}" x2="${X}" y1="${lane.up ? y1 + 17 : Y}" y2="${lane.up ? Y : y1 - 11}" stroke="${c}" stroke-width="1.2" stroke-opacity=".7"/>`;
    s += txt(cx0, y1, esc(lab1), { a: "middle", fs: 11, c, w: 600 }) + txt(cx0, y1 + 13, lab2, { a: "middle", fs: 11, c: C.muted });
    marcas.push(`<circle cx="${X}" cy="${Y}" r="4.5" fill="${C.surface}" stroke="${c}" stroke-width="2"/>`);
  });
  s += marcas.join("");
  const X = xOf(a.spot);
  s += `<rect x="${X - 2}" y="${Y - 11}" width="4" height="22" rx="2" fill="${C.text}"/>`;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${s}</svg>`;
}

/* ---------- grafico de lineas generico (fechas o numeros en el eje x) */
function cxLines(id, series, o = {}) {
  const el = $(id), W = Math.max(300, el.clientWidth), H = Math.max(170, el.clientHeight);
  const L = 56, R = W - 16, T = 12, B = H - (o.legend ? 44 : 28);
  const fx = o.dates ? (d) => Date.parse(d) : (x) => (o.sqrt ? Math.sqrt(Math.max(x, 0)) : x);
  const all = series.flatMap((sr) => sr.pts.filter((p) => p[1] != null));
  if (all.length < 2) { el.innerHTML = `<div class="empty">No data</div>`; return null; }
  const xs = all.map((p) => fx(p[0])), x0 = Math.min(...xs), x1 = Math.max(...xs);
  const ys = all.map((p) => p[1]);
  const yt = niceTicks(Math.min(...ys), Math.max(...ys), Math.max(3, Math.round((B - T) / 40)));
  const xOf = (x) => L + ((fx(x) - x0) / (x1 - x0 || 1)) * (R - L), yOf = (v) => B - ((v - yt.lo) / (yt.hi - yt.lo)) * (B - T);
  let s = yt.ticks.map((v) => `<line x1="${L}" x2="${R}" y1="${yOf(v)}" y2="${yOf(v)}" stroke="${C.grid}"/>` + txt(L - 8, yOf(v) + 4, o.fmtY ? o.fmtY(v) : fmtNum(v), { a: "end", fs: 11 })).join("");
  for (const sr of series) {
    let dd = "", pen = false;
    sr.pts.forEach((p) => { if (p[1] == null) { pen = false; return; } dd += `${pen ? "L" : "M"}${xOf(p[0]).toFixed(1)},${yOf(p[1]).toFixed(1)}`; pen = true; });
    s += `<path d="${dd}" fill="none" stroke="${sr.col}" stroke-width="${sr.w || 1.6}"${sr.da ? ` stroke-dasharray="${sr.da}"` : ""}/>`;
    if (sr.dots) s += sr.pts.filter((p) => p[1] != null).map((p) => `<circle cx="${xOf(p[0])}" cy="${yOf(p[1])}" r="3" fill="${C.surface}" stroke="${sr.col}" stroke-width="1.6"/>`).join("");
  }
  if (o.dates) {
    let prevM = "", last = -1e9;
    const ref = series[0].pts;
    ref.forEach((p) => {
      const m = p[0].slice(0, 7);
      if (m !== prevM && xOf(p[0]) - last >= 52 && xOf(p[0]) > L + 10) {
        s += txt(xOf(p[0]), B + 18, MESES[+m.slice(5) - 1] + (m.slice(5) === "01" || last < 0 ? " '" + m.slice(2, 4) : ""), { a: "middle", fs: 11 });
        last = xOf(p[0]);
      }
      prevM = m;
    });
  } else if (o.xlabels) {
    let last = -1e9;
    for (const [x, lab] of o.xlabels) { const X = xOf(x); if (X - last >= 46) { s += txt(X, B + 18, lab, { a: "middle", fs: 11 }); last = X; } }
  }
  if (o.legend) s += legendRows(series.filter((sr) => sr.name).map((sr) => [sr.name, sr.col, sr.da]), L, R, H - 10, 12);
  s += `<line class="cx-hl" x1="0" x2="0" y1="${T}" y2="${B}" stroke="${C.spotline}" stroke-opacity=".6" visibility="hidden"/>`;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${s}</svg>`;
  return { L, R, xOf };
}

function cxSeriesTip(id, e, rows, fmtRow) {
  const g = cx.geo[id];
  if (!g || !rows.length) return;
  const el = $(id), r = el.getBoundingClientRect(), x = e.clientX - r.left, hl = el.querySelector(".cx-hl");
  if (x < g.L - 4 || x > g.R + 4) { if (hl) hl.setAttribute("visibility", "hidden"); return macroTip("cxTip", null, e, ""); }
  const best = rows.reduce((p, q) => (Math.abs(g.xOf(q[0]) - x) < Math.abs(g.xOf(p[0]) - x) ? q : p));
  if (hl) { const X = g.xOf(best[0]); hl.setAttribute("x1", X); hl.setAttribute("x2", X); hl.setAttribute("visibility", "visible"); }
  macroTip("cxTip", null, e, fmtRow(best));
}

function cxCostChart(a) {
  const oc = a.onchain, sth = new Map(oc.sth_serie || []), lth = new Map(oc.lth_serie || []);
  const rows = oc.serie.map(([d, p, rp]) => [d, p, rp, sth.get(d) ?? null, lth.get(d) ?? null]);
  const sr = [{ name: "Price", col: C.text, w: 1.8, pts: rows.map((r) => [r[0], r[1]]) },
    { name: "Realized price", col: C.accent, w: 1.8, pts: rows.map((r) => [r[0], r[2]]) }];
  if (oc.sth_serie) sr.push({ name: "Short-term holders", col: C.purple, w: 1.5, pts: rows.map((r) => [r[0], r[3]]) });
  if (oc.lth_serie) sr.push({ name: "Long-term holders", col: C.prevClose, w: 1.5, da: "4 3", pts: rows.map((r) => [r[0], r[4]]) });
  cx.geo.cxCost = cxLines("cxCost", sr, { dates: true, legend: true, fmtY: (v) => "$" + fmtAxis(v) });
  cx.geo.costRows = rows;
}

function cxTermChart(a) {
  // sin los vencimientos de menos de un dia: su IV la mueve el ultimo tramo hasta la liquidacion
  const t = (a.vol.term || []).filter((r) => r.atm != null && r.dias >= 1);
  cx.geo.termRows = t.map((r) => [r.dias, r]);
  cx.geo.cxTerm = cxLines("cxTerm", [{ col: C.accent, w: 2.2, dots: true, pts: t.map((r) => [r.dias, r.atm]) }],
    { sqrt: true, xlabels: t.map((r) => [r.dias, ddmm(r.exp)]), fmtY: (v) => fmtNum(v, 0) });
  const v = a.vol;
  $("cxTermCap").textContent = `At-the-money implied volatility by expiration (Deribit). 30 days: ATM ${fmtNum(v.atm30, 1)}, 25-delta risk reversal ${fmtNum(v.rr25_30, 1)}, butterfly ${fmtNum(v.bf25_30, 1)}.`;
}

function cxDvolChart(a) {
  const s = a.vol.dvol_serie || [];
  cx.geo.dvolRows = s;
  cx.geo.cxDvol = cxLines("cxDvol", [{ col: C.purple, w: 1.8, pts: s }], { dates: true, fmtY: (v) => fmtNum(v, 0) });
  const v = a.vol;
  $("cxDvolCap").textContent = v.dvol != null ? `DVOL (30-day implied volatility index), last year. Now ${fmtNum(v.dvol, 1)}, ${ordinal(v.dvol_pct)} percentile; ${v.vrp >= 0 ? "+" : "−"}${fmtNum(Math.abs(v.vrp), 1)} over realized.` : "";
}

/* ---------- tablas */
function cxTables(a, m) {
  const term = new Map((a.vol.term || []).map((r) => [r.exp, r]));
  const big = (r) => (r.grande ? ` class="cx-big"` : "");
  $("cxExpBody").innerHTML = (a.venc || []).filter((r) => r.dias >= 0).slice(0, 14).map((r) => {
    const t = term.get(r.exp) || {};
    return `<tr${big(r)}><td class="l">${ddmm(r.exp)} ${r.exp.slice(2, 4)}</td><td>${fmtNum(r.dias, r.dias < 2 ? 1 : 0)}</td><td>${fmtBig(r.nocional, true)}</td>
      <td>${fmtNum(r.pcr, 2)}</td><td>${cxPx(r.max_pain)}</td><td>${cxPct((r.max_pain / a.spot - 1) * 100)}</td><td>${fmtNum(t.atm, 1)}</td><td>${t.rr25 == null ? "—" : fmtNum(t.rr25, 1)}</td></tr>`;
  }).join("");
  const f = a.futuros || {};
  $("cxBasisBody").innerHTML = (f.basis || []).map((r) => `<tr><td class="l">${ddmm(r.exp)} ${r.exp.slice(2, 4)}</td><td>${fmtNum(r.dias, 0)}</td>
    <td>${cxPct(r.prima, 2)}</td><td>${cxPct(r.anual, 1)}</td><td>${r.oi_usd ? fmtBig(r.oi_usd, true) : "—"}</td></tr>`).join("") || `<tr><td class="l" colspan="5">No data</td></tr>`;
  const cell = (v) => `<td class="${v > 0 ? "cx-up" : v < 0 ? "cx-dn" : ""}">${cxPct(v)}</td>`;
  $("cxMktBody").innerHTML = (m.top || []).map((c, i) => `<tr><td class="l">${i + 1}</td><td class="l"><b>${esc(c.sym)}</b> <span class="cx-nm">${esc(c.nombre)}</span></td>
    <td>${cxPx(c.precio)}</td>${cell(c.c24)}${cell(c.c7)}${cell(c.c30)}<td>${fmtBig(c.cap, true)}</td><td>${cxPct(c.ath_dist, 0)}</td></tr>`).join("") || `<tr><td class="l" colspan="8">No data</td></tr>`;
}

/* ---------- controles y tooltips */
$("cxSym").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; cx.sym = b.dataset.v; store.set("cxSym", cx.sym); renderCrypto(); });
$("cxFilt").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; cx.filt = b.dataset.v; store.set("cxFilt", cx.filt); renderCrypto(); });
$("cxGex").addEventListener("mousemove", cxGexTip);
$("cxCost").addEventListener("mousemove", (e) => cxSeriesTip("cxCost", e, cx.geo.costRows || [], (r) => `<div class="t">${longDate(r[0])}</div>
  <div class="r">Price <b>${cxPx(r[1])}</b></div><div class="r">Realized price <b style="color:${C.accent}">${cxPx(r[2])}</b></div>
  ${r[3] != null ? `<div class="r">Short-term holders <b style="color:${C.purple}">${cxPx(r[3])}</b></div>` : ""}
  ${r[4] != null ? `<div class="r">Long-term holders <b style="color:${C.prevClose}">${cxPx(r[4])}</b></div>` : ""}`));
$("cxTerm").addEventListener("mousemove", (e) => cxSeriesTip("cxTerm", e, cx.geo.termRows || [], ([, r]) => `<div class="t">${longDate(r.exp)}</div>
  <div class="r">ATM IV <b style="color:${C.accent}">${fmtNum(r.atm, 1)}</b></div>
  <div class="r">25-delta risk reversal <b>${r.rr25 == null ? "—" : fmtNum(r.rr25, 1)}</b></div>
  <div class="r">25-delta butterfly <b>${r.bf25 == null ? "—" : fmtNum(r.bf25, 1)}</b></div>
  <div class="r">Forward <b>${cxPx(r.fwd)}</b></div>`));
$("cxDvol").addEventListener("mousemove", (e) => cxSeriesTip("cxDvol", e, cx.geo.dvolRows || [], (r) => `<div class="t">${longDate(r[0])}</div><div class="r">DVOL <b style="color:${C.purple}">${fmtNum(r[1], 1)}</b></div>`));
for (const id of ["cxGex", "cxCost", "cxTerm", "cxDvol"]) {
  $(id).addEventListener("mouseleave", () => { $("cxTip").hidden = true; const hl = $(id).querySelector(".cx-hl"); if (hl) hl.setAttribute("visibility", "hidden"); });
}
