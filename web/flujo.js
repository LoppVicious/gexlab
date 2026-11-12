"use strict";
/* ============================================================ Options flow (estimacion)
   Datos: /api/flow?symbol= (flujo.tick): por tramos entre fotos del motor, el volumen nuevo de cada contrato
   clasificado como compra o venta por el cambio de su IV (BVC). Arriba, prima neta de calls y puts, delta y vega
   netas y cuanto volumen se ha clasificado, y una frase con la lectura; en el grafico, lo acumulado en la sesion con
   el precio; al lado, la actividad inusual (volumen de hoy por encima del open interest). Desde el lado del cliente. */

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

/* Todo en una pantalla: cifras en fila, una frase con la lectura, el acumulado de la sesion (alto ajustado a la
   ventana) y al lado la actividad inusual */
function renderFlow() {
  const d = flw.data;
  if (!d) return;
  $("fSym").textContent = d.symbol; $("fName").textContent = d.name && d.name !== d.symbol ? d.name : ""; $("fSpot").textContent = fmtSpot(d.spot);
  const s = d.series || [], last = s[s.length - 1] || { cp: 0, pp: 0, d: 0, vg: 0, v: 0 };
  const v = d.volume || {};
  // tarjetas: etiqueta (con el color de su linea si sale en el grafico), cifra y una linea que la explica
  const tile = (k, val, sub, col = "", tip = "") => `<div class="vstat f-tile"${tip ? ` title="${esc(tip)}"` : ""}><span class="k">${col ? `<i style="background:${col}"></i>` : ""}${k}</span><span class="v"${col ? ` style="color:${col}"` : ""}>${val}</span><span class="s">${sub}</span></div>`;
  const side = (x) => (x > 0 ? "bought" : x < 0 ? "sold" : "flat");
  const cov = v.total ? Math.min(1, v.classified / v.total) : 0;
  $("fSum").innerHTML = [
    tile("Call premium", fMoney(last.cp), `net ${side(last.cp)} by customers`, C.call, "Premium of calls bought minus calls sold by customers today."),
    tile("Put premium", fMoney(last.pp), `net ${side(last.pp)} by customers`, C.put, "Premium of puts bought minus puts sold by customers today."),
    tile("Net delta", fMoney(last.d), last.d > 0 ? "customers added long exposure" : last.d < 0 ? "customers added short exposure" : "flat", C.purple, "Delta of the classified trades in dollars, from the customer side: buying calls or selling puts adds, buying puts or selling calls subtracts. Dealers would hold the opposite."),
    tile("Net vega", fMoney(last.vg) + " /pt", last.vg > 0 ? "customers bought volatility" : last.vg < 0 ? "customers sold volatility" : "flat", "", "Vega of the classified trades in dollars per IV point, from the customer side."),
    tile("Volume", fmtBig(v.total || 0), `${fmtNum(cov * 100, 0)}% classified; calls ${fmtBig(v.calls || 0)}, puts ${fmtBig(v.puts || 0)}`, "", "Today's volume within ±35% of the price. Classified: the part that went through at least one engine snapshot."),
    tile("Slices", String(s.length), s.length ? `last ${last.t} ET${d.provisional ? " (provisional)" : ""}, ${last.m === "bvc" ? "by IV change" : "by last trade"}` : "none yet today", "", "Each slice is the volume between two engine snapshots (every 15 minutes). By IV change (BVC) when enough contracts traded in the slice; otherwise by where the last trade printed."),
  ].join("");
  // lectura en una frase: que domina y hacia donde empuja la delta
  const dom = Math.abs(last.cp) >= Math.abs(last.pp) ? ["calls", last.cp] : ["puts", last.pp];
  $("fSay").innerHTML = s.length
    ? `Customers have net ${side(last.cp)} <b>${fmtBig(Math.abs(last.cp), true)}</b> of calls and net ${side(last.pp)} <b>${fmtBig(Math.abs(last.pp), true)}</b> of puts today; the bigger flow is in <b>${dom[0]}</b>. Their net delta is <b>${fMoney(last.d)}</b>: ${last.d < 0 ? "they added short exposure, so dealers hold the long side" : last.d > 0 ? "they added long exposure, so dealers hold the short side" : "flat"}${last.vg ? `, and they ${last.vg > 0 ? "bought" : "sold"} volatility` : ""}.`
    : "No flow recorded yet for this session.";
  renderFlowChart();
  renderUoa();
  $("fNote").textContent = "Estimate. CBOE and Tradier give each contract's cumulative volume, not each trade with its side. The engine compares each snapshot of the chain with the previous one (every 15 minutes) and classifies the new volume of each contract by how much its implied volatility moved, against the rest of the contracts in that slice (bulk volume classification): an option whose IV rises was mostly bought. The first slice of the day, or one with few contracts, uses where the last trade printed. Customer side: dealers hold the opposite.";
}

// alto del grafico: lo que deja libre la ventana
function fFitH() {
  const el = $("fChart"), top = el.getBoundingClientRect().top + window.scrollY;
  return Math.round(Math.max(300, Math.min(620, window.innerHeight - top - 30)));
}

function renderFlowChart() {
  const d = flw.data, el = $("fChart"), s = d.series || [];
  $("fLeg").innerHTML = `<span><i style="background:${C.call}"></i>Calls</span><span><i style="background:${C.put}"></i>Puts</span><span><i class="dash" style="border-color:${C.purple}"></i>Net delta (right)</span><span><i style="background:${C.muted}"></i>Price</span>`;
  $("fCap").textContent = "customer net premium, cumulative";
  if (s.length < 1) { el.innerHTML = `<div class="empty">No flow recorded yet for this session. The engine records a slice every 15 minutes while the market is open, for the tickers in the lists.</div>`; flw.geo = null; return; }
  const pts = [{ t: "09:30", s: null, cp: 0, pp: 0, d: 0 }, ...s];
  const W = Math.max(320, el.clientWidth), H = fFitH();
  const narrow = W < 640, fs = 11;
  const L = narrow ? 52 : 62, R = W - (narrow ? 52 : 64), T = 16, B = H - 28;
  const mins = (t) => +t.slice(0, 2) * 60 + +t.slice(3, 5);
  const t0 = 570, t1 = Math.max(960, mins(pts[pts.length - 1].t));
  const xOf = (t) => L + ((mins(t) - t0) / (t1 - t0)) * (R - L);
  const pv = pts.flatMap((p) => [p.cp, p.pp]).concat([0]);
  // si la delta tiene un signo que la prima no tiene, se deja sitio en ese lado del eje
  const pm = Math.max(1, ...pv.map(Math.abs));
  if (pts.some((p) => p.d > 0)) pv.push(pm * 0.25);
  if (pts.some((p) => p.d < 0)) pv.push(-pm * 0.25);
  const yt = niceTicks(Math.min(...pv), Math.max(...pv), 6);
  const yOf = (v) => B - ((v - yt.lo) / (yt.hi - yt.lo || 1)) * (B - T);
  // eje derecho (delta) con el mismo cero que el izquierdo: escala k tal que delta = k x prima en cada linea
  const dv = pts.map((p) => p.d);
  const k = Math.max(1e-9, ...dv.map((v) => (v > 0 ? v / Math.max(yt.hi, 1e-9) : v < 0 ? v / Math.min(yt.lo, -1e-9) : 0)));
  const dOf = (v) => yOf(v / k);
  const sp = s.map((p) => p.s).filter((v) => v != null);
  const smin = Math.min(...sp), smax = Math.max(...sp), sOf = (v) => B - ((v - smin) / (smax - smin || 1)) * (B - T) * 0.9 - (B - T) * 0.05;
  const zy = yOf(0);
  let o = yt.ticks.map((v) => `<line x1="${L}" x2="${R}" y1="${yOf(v)}" y2="${yOf(v)}" stroke="${v === 0 ? C.muted : C.grid}"/>` + txt(L - 8, yOf(v) + 4, fSgn(v) + fmtBig(Math.abs(v), true), { a: "end", fs })).join("");
  yt.ticks.forEach((v) => { o += txt(R + 8, dOf(v * k) + 4, fSgn(v * k) + fmtBig(Math.abs(v * k), true), { fs, c: C.purple }); });
  for (let h = 10; h <= 16; h++) { const x = xOf(`${h}:00`); if (x >= L && x <= R) o += `<line x1="${x}" x2="${x}" y1="${T}" y2="${B}" stroke="${C.grid}" stroke-dasharray="2 4"/>` + txt(x, B + 19, `${h}:00`, { a: "middle", fs }); }
  // zonas bajo cada linea de prima, muy suaves, para que se vea de un vistazo quien domina
  const area = (key, col) => `<path d="${pts.map((p, i) => `${i ? "L" : "M"}${xOf(p.t).toFixed(1)},${yOf(p[key]).toFixed(1)}`).join("")}L${xOf(pts[pts.length - 1].t).toFixed(1)},${zy}L${xOf(pts[0].t).toFixed(1)},${zy}Z" fill="${col}" opacity=".09"/>`;
  o += area("cp", C.call) + area("pp", C.put);
  if (sp.length > 1) o += `<path d="${s.map((p, i) => `${i ? "L" : "M"}${xOf(p.t).toFixed(1)},${sOf(p.s).toFixed(1)}`).join("")}" fill="none" stroke="${C.muted}" stroke-width="1.3" stroke-opacity=".7"/>`;
  const line = (key, f, col, w, da) => `<path d="${pts.map((p, i) => `${i ? "L" : "M"}${xOf(p.t).toFixed(1)},${f(p[key]).toFixed(1)}`).join("")}" fill="none" stroke="${col}" stroke-width="${w}" stroke-linejoin="round"${da ? ` stroke-dasharray="${da}"` : ""}/>`;
  o += line("d", dOf, C.purple, 1.7, "4 3") + line("cp", yOf, C.call, 2.4) + line("pp", yOf, C.put, 2.4);
  // el ultimo valor de cada linea, al final
  const lp = pts[pts.length - 1], lx = xOf(lp.t);
  o += `<circle cx="${lx}" cy="${yOf(lp.cp)}" r="4" fill="${C.call}" stroke="${C.surface}" stroke-width="1.5"/><circle cx="${lx}" cy="${yOf(lp.pp)}" r="4" fill="${C.put}" stroke="${C.surface}" stroke-width="1.5"/>`;
  o += `<g id="fProbe" visibility="hidden"><line y1="${T}" y2="${B}" stroke="${C.muted}"/></g>`;
  flw.geo = { pts: s.map((p) => ({ p, x: xOf(p.t) })), L, R, yOf, dOf, sOf };
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${o}</svg>`;
}

// actividad inusual: lista compacta (contrato, vencimiento, volumen frente al OI, prima y cuanto se compro)
function renderUoa() {
  const u = flw.data.uoa || [];
  if (!u.length) { $("fUoa").innerHTML = `<p class="re-empty">No contract has traded above its open interest today.</p>`; return; }
  const yr = String(new Date().getFullYear());
  const row = (x) => {
    const b = x.bought, r = x.oi ? x.vol / x.oi : null;
    return `<tr title="Open interest ${fmtNum(x.oi)}; delta ${fMoney(x.delta)}, vega ${fmtBig(x.vega, true)} per point">
      <td class="l"><b>${fmtNum(x.k, x.k < 100 ? 1 : 0)}</b> <i class="oi-cp ${x.c ? "c" : "p"}">${x.c ? "C" : "P"}</i><small>${ddmm(x.exp)}${x.exp.slice(0, 4) !== yr ? " '" + x.exp.slice(2, 4) : ""}</small></td>
      <td>${fmtBig(x.vol)}<small class="f-x">${r == null ? "new" : fmtNum(r, r >= 10 ? 0 : 1) + "×"}</small></td>
      <td>${fmtNum(x.iv * 100, 1)}%</td>
      <td>${fmtBig(x.prem, true)}</td>
      <td>${b == null ? "—" : `<span class="f-bt"><span class="f-bb"><i style="width:${(b * 100).toFixed(0)}%"></i></span>${fmtNum(b * 100, 0)}%</span>`}</td></tr>`;
  };
  $("fUoa").innerHTML = `<table class="oi-t"><thead><tr><th class="l">Contract</th><th title="Today's volume and how many times the open interest">Volume</th><th>IV</th><th>Premium</th><th title="Share of the classified volume estimated as customer buying">Bought</th></tr></thead><tbody>${u.map(row).join("")}</tbody></table>`;
}

function flowTip(e) {
  const g = flw.geo, el = $("fChart");
  if (!g || !g.pts.length) return;
  const r = el.getBoundingClientRect(), x = e.clientX - r.left;
  const pr = el.querySelector("#fProbe");
  const best = g.pts.reduce((a, b) => (Math.abs(b.x - x) < Math.abs(a.x - x) ? b : a));
  if (x < g.L - 10 || x > g.R + 10 || Math.abs(best.x - x) > 60) { toolTip(el, null); if (pr) pr.setAttribute("visibility", "hidden"); return; }
  const p = best.p;
  if (pr) {
    pr.setAttribute("visibility", "visible");
    const ln = pr.querySelector("line"); ln.setAttribute("x1", best.x); ln.setAttribute("x2", best.x);
    pr.querySelectorAll("circle").forEach((c) => c.remove());
    for (const [y, col] of [[g.yOf(p.cp), C.call], [g.yOf(p.pp), C.put], [g.dOf(p.d), C.purple]]) {
      const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      c.setAttribute("cx", best.x); c.setAttribute("cy", y); c.setAttribute("r", "4"); c.setAttribute("fill", col); c.setAttribute("stroke", C.surface); c.setAttribute("stroke-width", "1.5");
      pr.appendChild(c);
    }
  }
  toolTip(el, `<div class="tt-h">${p.t} ET <small>${p.m === "bvc" ? "by IV change" : "by last trade"}</small></div>
    <div class="tt-r"><span><i style="background:${C.call}"></i>Call premium</span><b>${fMoney(p.cp)}</b></div>
    <div class="tt-r"><span><i style="background:${C.put}"></i>Put premium</span><b>${fMoney(p.pp)}</b></div>
    <div class="tt-r"><span><i style="background:${C.purple}"></i>Net delta</span><b>${fMoney(p.d)}</b></div>
    <div class="tt-r"><span>Net vega</span><b>${fMoney(p.vg)} /pt</b></div>
    <div class="tt-r"><span>Price</span><b>${fmtSpot(p.s)}</b></div>
    <div class="tt-r"><span>Volume classified</span><b>${fmtBig(p.v)}</b></div>`, best.x, e.clientY - r.top);
}
$("fChart").addEventListener("mousemove", flowTip);
$("fChart").addEventListener("mouseleave", () => { toolTip($("fChart"), null); const pr = $("fChart").querySelector("#fProbe"); if (pr) pr.setAttribute("visibility", "hidden"); });
