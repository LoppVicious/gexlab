"use strict";
/* ============================================================ Correlacion implicita (Volatility, Correlation)
   Datos: /api/corr (macro.correlation): indices de correlacion implicita de CBOE (COR10D a COR1Y), indice de
   dispersion DSPX y VIX, con percentil del ultimo ano, banda 10-90 y dos anos de historia. A la izquierda la
   lectura del regimen; a la derecha la estructura temporal (hoy, hace una semana y la banda del ano) y la historia. */

const crv = { data: null, at: 0, ctrl: null, curveGeo: null, histGeo: null };
const CR_LABEL = { COR10D: "10 days", COR1M: "1 month", COR3M: "3 months", COR6M: "6 months", COR9M: "9 months", COR1Y: "1 year" };

function corrStatus() { return crv.data ? `Correlation ${crv.data.live ? "live" : "at the close of " + ddmm(crv.data.date)}` : ""; }

function showCorr() {
  if (crv.data) { renderCorr(); setStatus("", corrStatus()); }
  if (!crv.data || Date.now() - crv.at > 300000) loadCorr();
}

async function loadCorr(refresh = false) {
  if (crv.ctrl) crv.ctrl.abort();
  crv.ctrl = new AbortController();
  $("refreshBtn").classList.add("spin");
  setStatus("busy", "Loading implied correlation…");
  if (!crv.data) $("crCurve").innerHTML = `<div class="empty">Downloading the CBOE correlation indices…</div>`;
  try {
    const r = await fetch("/api/corr" + (refresh ? "?refresh=1" : ""), { signal: crv.ctrl.signal });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Could not load the correlation data");
    crv.data = d; crv.at = Date.now();
    if (state.mode === "corr") { renderCorr(); setStatus("", corrStatus()); }
  } catch (e) {
    if (e.name === "AbortError") return;
    if (state.mode === "corr") {
      setStatus("err", crv.data ? "Could not refresh" : "No data");
      if (!crv.data) $("crCurve").innerHTML = `<div class="empty">${esc(e.message === "Failed to fetch" ? "The local server is not responding. Open GEX Lab again." : e.message)}</div>`;
    }
  } finally { $("refreshBtn").classList.remove("spin"); }
}

const crTerm = (s) => (crv.data.term || []).find((t) => t.symbol === s);
const crChg = (a, b) => (a == null || b == null ? "—" : (a - b > 0 ? "+" : a - b < 0 ? "−" : "") + fmtNum(Math.abs(a - b), 1));

function renderCorr() {
  const d = crv.data;
  if (!d) return;
  const c3 = crTerm("COR3M"), c1 = crTerm("COR1M"), ds = d.dspx, vx = d.vix;
  // regimen por el percentil del ultimo ano de la correlacion a 3 meses
  const p = c3.pct, low = p != null && p <= 20, high = p != null && p >= 80;
  const st = $("crState");
  st.textContent = `${fmtNum(c3.value, 1)}, ${low ? "low" : high ? "high" : "normal"}`;
  st.className = "mstate " + (high ? "backwardation" : low ? "mixed" : "contango");
  $("crSub").textContent = `${d.live ? "Live (15 min)" : "Close of " + longDate(d.date)}, ${ordinal(p)} percentile of the last year`;
  const dHigh = ds && ds.pct >= 60, front = c1 && c1.value > c3.value;
  let read;
  if (high) read = "Stocks are moving as a block: a macro or risk-off market, where the index carries most of the risk. Index options are expensive compared with single stocks, and diversification inside the index helps little.";
  else if (low) read = `Stocks are moving on their own stories${dHigh ? ", with high expected dispersion" : ""}. Index volatility stays contained even when single stocks move a lot, because their moves cancel out. A macro shock tends to push correlation up quickly, and index volatility with it: that is the fragility of this regime.`;
  else read = "Correlation within its usual range for the last year: neither a block market nor one driven only by single-stock stories.";
  if (front) read += " The 1-month correlation is above the 3-month one: the market expects the stocks to move together in the short term (an event or stress close by).";
  $("crRead").textContent = read;
  const fact = (l, v, s, warn, g) => `<div class="fact"><span class="fl"${g ? ` data-g="${g}"` : ""}>${l}</span><strong>${v}</strong><span class="fs${warn ? " warn" : ""}">${s}</span></div>`;
  $("crFacts").innerHTML = [
    fact("3 months (COR3M)", fmtNum(c3.value, 2), `${crChg(c3.value, c3.week)} in a week. Median since 2006: ${fmtNum(c3.median_all, 1)}`, false, "corr"),
    c1 ? fact("1 month (COR1M)", fmtNum(c1.value, 2), `${ordinal(c1.pct)} percentile, ${crChg(c1.value, c1.week)} in a week`) : "",
    c1 ? fact("1M minus 3M", crChg(c1.value, c3.value), front ? "short term above: near-term stress" : "short term below: normal structure", front) : "",
    ds ? fact("Dispersion (DSPX)", fmtNum(ds.value, 2), `${ordinal(ds.pct)} percentile, ${crChg(ds.value, ds.week)} in a week`, false, "dspx") : "",
    vx ? fact("VIX", fmtNum(vx.value, 2), `${ordinal(vx.pct)} percentile of the last year`, false, "vix") : "",
  ].join("");
  $("crCap").textContent = `Today${d.term[0].week != null ? ", one week ago (dashed)" : ""} and the 10th–90th percentile band of the last year for each tenor, with its median.`;
  $("crHistCap").textContent = "Implied correlation at 3 months (line) and 1 month (thin), and dispersion DSPX (right axis).";
  renderCorrCurve();
  renderCorrHist();
}

function renderCorrCurve() {
  const d = crv.data, el = $("crCurve"), t = d.term;
  const W = Math.max(320, el.clientWidth), H = Math.max(240, el.clientHeight);
  const L = 52, R = W - 24, T = 16, B = H - 34;
  const days = t.map((x) => x.days), f = (x) => Math.sqrt(x);
  const xOf = (x) => L + ((f(x) - f(days[0])) / (f(days[days.length - 1]) - f(days[0]))) * (R - L);
  const all = t.flatMap((x) => [x.value, x.week, ...(x.band || [])]).filter((v) => v != null);
  const yt = niceTicks(Math.min(...all) * 0.9, Math.max(...all) * 1.08, 5);
  const yOf = (v) => B - ((v - yt.lo) / (yt.hi - yt.lo)) * (B - T);
  let s = yt.ticks.map((v) => `<line x1="${L}" x2="${R}" y1="${yOf(v)}" y2="${yOf(v)}" stroke="${C.grid}" stroke-dasharray="2 4"/>` + txt(L - 8, yOf(v) + 4, fmtNum(v, 0), { a: "end", fs: 11 })).join("");
  const bd = t.filter((x) => x.band);
  if (bd.length > 1) {
    s += `<polygon points="${bd.map((x) => `${xOf(x.days)},${yOf(x.band[2])}`).concat(bd.slice().reverse().map((x) => `${xOf(x.days)},${yOf(x.band[0])}`)).join(" ")}" fill="${C.purple}" fill-opacity=".12"/>`;
    s += `<path d="${bd.map((x, i) => `${i ? "L" : "M"}${xOf(x.days).toFixed(1)},${yOf(x.band[1]).toFixed(1)}`).join("")}" fill="none" stroke="${C.purple}" stroke-width="1.2" stroke-dasharray="4 4" stroke-opacity=".8"/>`;
  }
  const line = (key, col, w, da, dots) => {
    const p = t.filter((x) => x[key] != null);
    let o = `<path d="${p.map((x, i) => `${i ? "L" : "M"}${xOf(x.days).toFixed(1)},${yOf(x[key]).toFixed(1)}`).join("")}" fill="none" stroke="${col}" stroke-width="${w}"${da ? ` stroke-dasharray="${da}"` : ""}/>`;
    if (dots) o += p.map((x) => `<circle cx="${xOf(x.days)}" cy="${yOf(x[key])}" r="3.4" fill="${C.surface}" stroke="${col}" stroke-width="1.8"/>`).join("");
    return o;
  };
  s += line("week", C.muted, 1.5, "3 3", false);
  s += line("value", C.accent, 2.4, "", true);
  t.forEach((x) => { s += txt(xOf(x.days), B + 20, CR_LABEL[x.symbol] || x.symbol, { a: "middle", fs: 11 }); });
  crv.curveGeo = t.map((x) => ({ x: xOf(x.days), y: yOf(x.value), t: x }));
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${s}</svg>`;
}

function renderCorrHist() {
  const d = crv.data, el = $("crHist"), h = d.history || [];
  if (h.length < 2) { el.innerHTML = ""; return; }
  const W = Math.max(320, el.clientWidth), H = Math.max(170, el.clientHeight);
  const L = 52, R = W - 46, T = 12, B = H - 28;
  const cv = h.flatMap((x) => [x.cor3m, x.cor1m]).filter((v) => v != null);
  const yt = niceTicks(Math.min(...cv), Math.max(...cv), Math.max(3, Math.round((B - T) / 42)));
  const dv = h.map((x) => x.dspx).filter((v) => v != null);
  const dt = dv.length ? niceTicks(Math.min(...dv), Math.max(...dv), 4) : null;
  const n = h.length, xOf = (i) => L + (i / (n - 1)) * (R - L);
  const yOf = (v) => B - ((v - yt.lo) / (yt.hi - yt.lo)) * (B - T);
  const dOf = (v) => B - ((v - dt.lo) / (dt.hi - dt.lo)) * (B - T);
  let s = yt.ticks.map((v) => `<line x1="${L}" x2="${R}" y1="${yOf(v)}" y2="${yOf(v)}" stroke="${C.grid}"/>` + txt(L - 8, yOf(v) + 4, fmtNum(v, 0), { a: "end", fs: 11 })).join("");
  const path = (key, f, col, w, op) => {
    let o = "", pen = false;
    h.forEach((x, i) => { if (x[key] == null) { pen = false; return; } o += `${pen ? "L" : "M"}${xOf(i).toFixed(1)},${f(x[key]).toFixed(1)}`; pen = true; });
    return `<path d="${o}" fill="none" stroke="${col}" stroke-width="${w}" stroke-opacity="${op}"/>`;
  };
  if (dt) {
    s += path("dspx", dOf, C.purple, 1.3, 0.75);
    for (const v of dt.ticks) if (v >= dt.lo && v <= dt.hi) s += txt(R + 8, dOf(v) + 4, fmtNum(v, 0), { fs: 11, c: C.purple });
  }
  s += path("cor1m", yOf, C.muted, 1, 0.7);
  s += path("cor3m", yOf, C.accent, 1.8, 1);
  let prevM = "", lastLab = -1e9;
  h.forEach((x, i) => {
    const m = x.date.slice(0, 7);
    if (m !== prevM && i > 2 && xOf(i) - lastLab >= 44) {
      s += txt(xOf(i), B + 18, MESES[+m.slice(5) - 1] + (m.slice(5) === "01" || lastLab < 0 ? " '" + m.slice(2, 4) : ""), { a: "middle", fs: 11 });
      lastLab = xOf(i);
    }
    prevM = m;
  });
  s += `<line id="crHl" x1="0" x2="0" y1="${T}" y2="${B}" stroke="${C.spotline}" stroke-opacity=".6" visibility="hidden"/>`;
  crv.histGeo = { L, R, n };
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${s}</svg>`;
}

function corrCurveTip(e) {
  if (!crv.curveGeo) return;
  const r = $("crCurve").getBoundingClientRect(), x = e.clientX - r.left;
  const best = crv.curveGeo.reduce((a, b) => (Math.abs(b.x - x) < Math.abs(a.x - x) ? b : a));
  if (Math.abs(best.x - x) > 40) return macroTip("crTip", null, e, "");
  const t = best.t;
  macroTip("crTip", null, e, `<div class="t">${t.symbol} <span style="color:var(--muted);font-weight:400">${CR_LABEL[t.symbol] || ""}</span></div>
    <div class="r">Today <b style="color:${C.accent}">${fmtNum(t.value, 2)}</b></div>
    ${t.prev != null ? `<div class="r">Previous session <b>${fmtNum(t.prev, 2)}</b></div>` : ""}
    ${t.week != null ? `<div class="r">One week ago <b>${fmtNum(t.week, 2)}</b></div>` : ""}
    ${t.band ? `<div class="r">Last year: 10th / median / 90th <b>${t.band.map((v) => fmtNum(v, 1)).join(" / ")}</b></div>` : ""}
    <div class="r">Percentile, last year <b>${ordinal(t.pct)}</b></div>
    <div class="r">Median since 2006 <b>${fmtNum(t.median_all, 1)}</b></div>`);
}

function corrHistTip(e) {
  const g = crv.histGeo;
  if (!g) return;
  const r = $("crHist").getBoundingClientRect(), x = e.clientX - r.left;
  const hl = $("crHist").querySelector("#crHl");
  if (x < g.L || x > g.R) { if (hl) hl.setAttribute("visibility", "hidden"); return macroTip("crTip", null, e, ""); }
  const i = Math.round(((x - g.L) / (g.R - g.L)) * (g.n - 1)), p = crv.data.history[i];
  if (hl) { const px = g.L + (i / (g.n - 1)) * (g.R - g.L); hl.setAttribute("x1", px); hl.setAttribute("x2", px); hl.setAttribute("visibility", "visible"); }
  macroTip("crTip", null, e, `<div class="t">${longDate(p.date)}</div>
    <div class="r">3-month correlation <b style="color:${C.accent}">${p.cor3m == null ? "—" : fmtNum(p.cor3m, 2)}</b></div>
    <div class="r">1-month correlation <b>${p.cor1m == null ? "—" : fmtNum(p.cor1m, 2)}</b></div>
    <div class="r">Dispersion (DSPX) <b style="color:${C.purple}">${p.dspx == null ? "—" : fmtNum(p.dspx, 2)}</b></div>
    <div class="r">VIX <b>${p.vix == null ? "—" : fmtNum(p.vix, 2)}</b></div>`);
}

$("crCurve").addEventListener("mousemove", corrCurveTip);
$("crCurve").addEventListener("mouseleave", () => { $("crTip").hidden = true; });
$("crHist").addEventListener("mousemove", corrHistTip);
$("crHist").addEventListener("mouseleave", () => { $("crTip").hidden = true; const hl = $("crHist").querySelector("#crHl"); if (hl) hl.setAttribute("visibility", "hidden"); });
