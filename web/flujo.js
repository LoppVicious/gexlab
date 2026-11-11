"use strict";
/* ============================================================ Options flow (estimacion)
   Datos: /api/flow?symbol= (flujo.tick): por tramos entre fotos del motor, el volumen nuevo de cada contrato
   clasificado como compra o venta por el cambio de su IV (BVC). Arriba, prima neta de calls y puts, delta y vega
   netas y cuanto volumen se ha clasificado; en el grafico, lo acumulado en la sesion con el precio; abajo, la
   actividad inusual (volumen de hoy por encima del open interest). Siempre desde el lado del cliente. */

const flw = { data: null, sym: "", at: 0, ctrl: null, geo: null };

function flowStatus() { return flw.data ? `Flow at ${nyHHMM(flw.data.generado)}` : ""; }

function showFlow() {
  const sym = state.symbol || "SPX";
  $("symbol").value = sym;
  if (!flw.data || flw.sym !== sym || Date.now() - flw.at > 300000) loadFlow(); else { renderFlow(); setStatus("", flowStatus()); }
}

async function loadFlow(refresh = false) {
  const sym = (state.symbol || "SPX").toUpperCase();
  if (flw.ctrl) flw.ctrl.abort();
  flw.ctrl = new AbortController();
  $("refreshBtn").classList.add("spin");
  setStatus("busy", `Loading ${sym} flow…`);
  try {
    const r = await fetch(`/api/flow?symbol=${encodeURIComponent(sym)}${refresh ? "&refresh=1" : ""}`, { signal: flw.ctrl.signal });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Could not load the flow");
    flw.data = d; flw.sym = d.symbol; flw.at = Date.now();
    if (state.mode === "flow") { renderFlow(); setStatus("", flowStatus()); }
  } catch (e) {
    if (e.name === "AbortError") return;
    flw.data = null; flw.sym = sym;
    $("fSum").innerHTML = ""; $("fUoa").innerHTML = "";
    $("fSym").textContent = sym; $("fName").textContent = ""; $("fSpot").textContent = "";
    $("fChart").innerHTML = `<div class="empty">${esc(e.message === "Failed to fetch" ? "The local server is not responding. Open GEX Lab again." : e.message)}</div>`;
    setStatus("err", e.message);
  } finally { $("refreshBtn").classList.remove("spin"); }
}

const fSgn = (v) => (v > 0 ? "+" : v < 0 ? "−" : "");
const fMoney = (v) => (v == null ? "—" : fSgn(v) + fmtBig(Math.abs(v), true));

function renderFlow() {
  const d = flw.data;
  if (!d) return;
  $("fSym").textContent = d.symbol; $("fName").textContent = d.name || ""; $("fSpot").textContent = fmtSpot(d.spot);
  const s = d.series || [], last = s[s.length - 1] || { cp: 0, pp: 0, d: 0, vg: 0, v: 0 };
  const v = d.volume || {};
  const tile = (k, val, sub, cls = "", tip = "") => `<div class="vstat"${tip ? ` title="${esc(tip)}"` : ""}><span class="k">${k}</span><span class="v ${cls}">${val}</span><span class="s">${sub}</span></div>`;
  const side = (x) => (x > 0 ? "net bought" : x < 0 ? "net sold" : "flat");
  const cov = v.total ? Math.min(1, v.classified / v.total) : 0;
  $("fSum").innerHTML = [
    tile("Call premium", fMoney(last.cp), side(last.cp), last.cp > 0 ? "dn" : last.cp < 0 ? "up" : "", "Premium of calls bought minus calls sold by customers today."),
    tile("Put premium", fMoney(last.pp), side(last.pp), last.pp > 0 ? "up" : last.pp < 0 ? "dn" : "", "Premium of puts bought minus puts sold by customers today."),
    tile("Net delta", fMoney(last.d), last.d > 0 ? "customers added long exposure" : last.d < 0 ? "customers added short exposure" : "", "", "Delta of the classified trades in dollars, from the customer side: buying calls or selling puts adds, buying puts or selling calls subtracts. Dealers would hold the opposite."),
    tile("Net vega", fMoney(last.vg) + " /pt", last.vg > 0 ? "customers bought volatility" : last.vg < 0 ? "customers sold volatility" : "", "", "Vega of the classified trades in dollars per IV point, from the customer side."),
    tile("Volume", fmtBig(v.total || 0), `${fmtNum(cov * 100, 0)}% classified. Calls ${fmtBig(v.calls || 0)}, puts ${fmtBig(v.puts || 0)}`, "", "Today's volume within ±35% of the price. Classified: the part that went through at least one engine snapshot."),
    tile("Slices", String(s.length), s.length ? `last ${last.t} ET${d.provisional ? " (provisional)" : ""}, ${last.m === "bvc" ? "by IV change" : "by last trade"}` : "none yet today", "", "Each slice is the volume between two engine snapshots (every 15 minutes). By IV change (BVC) when enough contracts traded in the slice; otherwise by where the last trade printed."),
  ].join("");
  $("fCap").textContent = "Customer net premium of calls and puts (left axis) and net delta (right axis, dashed). Gray: the price.";
  renderFlowChart();
  renderUoa();
  $("fNote").textContent = "Estimate. CBOE and Tradier give each contract's cumulative volume, not each trade with its side. The engine compares each snapshot of the chain with the previous one (every 15 minutes) and classifies the new volume of each contract by how much its implied volatility moved, against the rest of the contracts in that slice (bulk volume classification): an option whose IV rises was mostly bought. The first slice of the day, or one with few contracts, uses where the last trade printed. Customer side: dealers hold the opposite.";
}

function renderFlowChart() {
  const d = flw.data, el = $("fChart"), s = d.series || [];
  if (s.length < 1) { el.innerHTML = `<div class="empty">No flow recorded yet for this session. The engine records a slice every 15 minutes while the market is open, for the tickers in the lists.</div>`; flw.geo = null; return; }
  const pts = [{ t: "09:30", s: null, cp: 0, pp: 0, d: 0 }, ...s];
  const W = Math.max(320, el.clientWidth), H = Math.max(260, el.clientHeight);
  const narrow = W < 640, fs = narrow ? 10.5 : 11.5;
  const L = narrow ? 52 : 64, R = W - (narrow ? 52 : 66), T = 14, B = H - 30;
  const mins = (t) => +t.slice(0, 2) * 60 + +t.slice(3, 5);
  const t0 = 570, t1 = Math.max(960, mins(pts[pts.length - 1].t));
  const xOf = (t) => L + ((mins(t) - t0) / (t1 - t0)) * (R - L);
  const pv = pts.flatMap((p) => [p.cp, p.pp]).concat([0]);
  // si la delta tiene un signo que la prima no tiene, se deja sitio en ese lado del eje
  const pm = Math.max(1, ...pv.map(Math.abs));
  if (pts.some((p) => p.d > 0)) pv.push(pm * 0.25);
  if (pts.some((p) => p.d < 0)) pv.push(-pm * 0.25);
  const yt = niceTicks(Math.min(...pv), Math.max(...pv), 5);
  const yOf = (v) => B - ((v - yt.lo) / (yt.hi - yt.lo || 1)) * (B - T);
  // eje derecho (delta) con el mismo cero que el izquierdo: escala k tal que delta = k x prima en cada linea
  const dv = pts.map((p) => p.d);
  const k = Math.max(1e-9, ...dv.map((v) => (v > 0 ? v / Math.max(yt.hi, 1e-9) : v < 0 ? v / Math.min(yt.lo, -1e-9) : 0)));
  const dt = { ticks: yt.ticks.map((v) => v * k) };
  const dOf = (v) => yOf(v / k);
  const sp = s.map((p) => p.s).filter((v) => v != null);
  const smin = Math.min(...sp), smax = Math.max(...sp), sOf = (v) => B - ((v - smin) / (smax - smin || 1)) * (B - T) * 0.9 - (B - T) * 0.05;
  let o = yt.ticks.map((v) => `<line x1="${L}" x2="${R}" y1="${yOf(v)}" y2="${yOf(v)}" stroke="${v === 0 ? C.axis : C.grid}"${v === 0 ? "" : ' stroke-dasharray="2 4"'}/>` + txt(L - 8, yOf(v) + 4, fSgn(v) + fmtBig(Math.abs(v), true), { a: "end", fs })).join("");
  dt.ticks.forEach((v) => { o += txt(R + 8, dOf(v) + 4, fSgn(v) + fmtBig(Math.abs(v), true), { fs, c: C.purple }); });
  for (let h = 10; h <= 16; h++) { const x = xOf(`${h}:00`); if (x >= L && x <= R) o += txt(x, B + fs + 8, `${h}:00`, { a: "middle", fs }); }
  if (sp.length > 1) o += `<path d="${s.map((p, i) => `${i ? "L" : "M"}${xOf(p.t).toFixed(1)},${sOf(p.s).toFixed(1)}`).join("")}" fill="none" stroke="${C.muted}" stroke-width="1.2" stroke-opacity=".6"/>`;
  const line = (key, f, col, w, da) => `<path d="${pts.map((p, i) => `${i ? "L" : "M"}${xOf(p.t).toFixed(1)},${f(p[key]).toFixed(1)}`).join("")}" fill="none" stroke="${col}" stroke-width="${w}"${da ? ` stroke-dasharray="${da}"` : ""}/>` +
    pts.slice(1).map((p) => `<circle cx="${xOf(p.t)}" cy="${f(p[key])}" r="2.6" fill="${C.surface}" stroke="${col}" stroke-width="1.5"/>`).join("");
  o += line("d", dOf, C.purple, 1.6, "4 3");
  o += line("cp", yOf, C.call, 2.2);
  o += line("pp", yOf, C.put, 2.2);
  const lg = [["Calls", C.call, ""], ["Puts", C.put, ""], ["Net delta", C.purple, "4 3"], ["Price", C.muted, ""]];
  let lx = L + 6;
  lg.forEach(([lab, col, da]) => { o += `<line x1="${lx}" x2="${lx + 16}" y1="${T + 6}" y2="${T + 6}" stroke="${col}" stroke-width="2"${da ? ` stroke-dasharray="${da}"` : ""}/>` + txt(lx + 21, T + 10, lab, { fs, c: C.muted }); lx += 30 + textW(lab, fs); });
  o += `<line id="fHl" x1="0" x2="0" y1="${T}" y2="${B}" stroke="${C.spotline}" stroke-opacity=".6" visibility="hidden"/>`;
  flw.geo = { pts: s.map((p) => ({ p, x: xOf(p.t) })), L, R };
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${o}</svg>`;
}

function renderUoa() {
  const u = flw.data.uoa || [];
  if (!u.length) { $("fUoa").innerHTML = `<div class="empty">No contract has traded above its open interest today.</div>`; return; }
  const row = (x) => {
    const b = x.bought;
    return `<tr><td class="l"><span class="cp ${x.c ? "c" : "p"}">${fmtNum(x.k, x.k < 100 ? 1 : 0)} ${x.c ? "C" : "P"}</span></td>
      <td class="l">${ddmm(x.exp)}${x.exp.slice(0, 4) !== String(new Date().getFullYear()) ? " '" + x.exp.slice(2, 4) : ""}</td>
      <td>${fmtNum(x.vol)}</td><td>${fmtNum(x.oi)}</td><td>${x.oi ? fmtNum(x.vol / x.oi, x.vol / x.oi >= 10 ? 0 : 1) + "×" : "new"}</td>
      <td>${fmtNum(x.iv * 100, 1)}%</td><td>${fmtBig(x.prem, true)}</td><td>${fMoney(x.delta)}</td><td>${fmtBig(x.vega, true)}</td>
      <td>${b == null ? "—" : `${fmtNum(b * 100, 0)}%<span class="bar"><i style="width:${(b * 100).toFixed(0)}%"></i></span>`}</td></tr>`;
  };
  $("fUoa").innerHTML = `<table><thead><tr><th class="l">Contract</th><th class="l">Expires</th><th>Volume</th><th>Open int.</th><th>Vol / OI</th><th>IV</th><th>Premium</th><th title="Delta of today's volume in dollars, as if bought">Delta $</th><th title="Vega of today's volume in dollars per IV point">Vega $</th><th title="Share of the classified volume estimated as customer buying">Bought (est.)</th></tr></thead><tbody>${u.map(row).join("")}</tbody></table>`;
}

function flowTip(e) {
  const g = flw.geo;
  if (!g || !g.pts.length) return;
  const r = $("fChart").getBoundingClientRect(), x = e.clientX - r.left;
  const hl = $("fChart").querySelector("#fHl");
  const best = g.pts.reduce((a, b) => (Math.abs(b.x - x) < Math.abs(a.x - x) ? b : a));
  if (x < g.L - 10 || x > g.R + 10 || Math.abs(best.x - x) > 60) { $("fTip").hidden = true; if (hl) hl.setAttribute("visibility", "hidden"); return; }
  const p = best.p;
  if (hl) { hl.setAttribute("x1", best.x); hl.setAttribute("x2", best.x); hl.setAttribute("visibility", "visible"); }
  macroTip("fTip", null, e, `<div class="t">${p.t} ET <span style="color:var(--muted);font-weight:400">${p.m === "bvc" ? "by IV change" : "by last trade"}</span></div>
    <div class="r">Price <b>${fmtSpot(p.s)}</b></div>
    <div class="r">Call premium <b style="color:${C.call}">${fMoney(p.cp)}</b></div>
    <div class="r">Put premium <b style="color:${C.put}">${fMoney(p.pp)}</b></div>
    <div class="r">Net delta <b style="color:${C.purple}">${fMoney(p.d)}</b></div>
    <div class="r">Net vega <b>${fMoney(p.vg)} /pt</b></div>
    <div class="r">Volume classified <b>${fmtBig(p.v)}</b></div>`);
}
$("fChart").addEventListener("mousemove", flowTip);
$("fChart").addEventListener("mouseleave", () => { $("fTip").hidden = true; const hl = $("fChart").querySelector("#fHl"); if (hl) hl.setAttribute("visibility", "hidden"); });
