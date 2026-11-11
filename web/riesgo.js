"use strict";
/* ============================================================ Risk Engine
   Una posicion de varias patas (opciones de la cadena real y acciones) sobre el ticker de la barra superior. Cada
   pata entra al precio medio actual con la IV de su contrato; se valora por Black-Scholes-Merton con el carry del
   forward de su vencimiento. Muestra el P&L por precio (al primer vencimiento, hoy y en la fecha elegida), las griegas
   netas, los maximos, los puntos muertos y una matriz de escenarios precio x fecha. La posicion se guarda por ticker. */

const risk = {
  sym: "", ch: null, legs: [], passed: 0, shift: 0, ctrl: null, built: false, nid: 1,
  saved: (() => { try { return JSON.parse(store.get("riskLegs", "{}")) || {}; } catch { return {}; } })(),
};

const RISK_PRESETS = [
  ["lc", "Long call"], ["lp", "Long put"], ["bcs", "Bull call spread"], ["bps", "Bear put spread"],
  ["str", "Straddle"], ["stg", "Strangle"], ["ic", "Iron condor"], ["fly", "Butterfly"], ["cal", "Calendar"],
  ["cc", "Covered call"], ["pp", "Protective put"],
];

// la nube guarda cada preferencia con 2.000 caracteres como maximo: patas compactas y los 3 ultimos tickers
function riskSave() {
  delete risk.saved[risk.sym];
  risk.saved[risk.sym] = risk.legs.map((l) => [l.side, l.qty, l.kind, l.exp, l.K, +l.iv.toFixed(4), +l.entry.toFixed(2)]);
  const keys = Object.keys(risk.saved);
  while (keys.length > 3) delete risk.saved[keys.shift()];
  let js = JSON.stringify(risk.saved);
  while (js.length > 1900 && Object.keys(risk.saved).length > 1) { delete risk.saved[Object.keys(risk.saved)[0]]; js = JSON.stringify(risk.saved); }
  store.set("riskLegs", js.length > 1900 ? "{}" : js);
}
function riskUnpack(a) { return Array.isArray(a) ? { side: a[0], qty: a[1], kind: a[2], exp: a[3], K: a[4], iv: a[5], entry: a[6] } : a; }

/* ---------------------------------------------------------------- patas */
function riskExp(l) { return risk.ch.exps.find((e) => e.key === l.exp); }
function riskNewLeg(side, kind, ei, K, qty = 1) {
  const ch = risk.ch, e = ch.exps[ei];
  const l = { id: risk.nid++, side, qty, kind, exp: e.key, K };
  if (kind === "S") { l.qty = qty * 100; l.entry = ch.spot; l.iv = 0; return l; }
  l.iv = ivAt(ch, ei, K, kind === "C");
  l.entry = midAt(ch, ei, K, kind === "C");
  return l;
}
function riskPreset(p) {
  const ch = risk.ch, S = ch.spot;
  const e = expNear(ch, 30), far = expNear(ch, Math.max(60, e.days + 25));
  const ks = strikesOf(ch, e.i);
  const sig = ivAt(ch, e.i, nearestStrike(ks, e.fwd), true) * Math.sqrt(Math.max(e.T, 1 / 365));
  const at = (k) => nearestStrike(ks, S * (1 + k * sig));
  const atm = at(0);
  const L = (side, kind, K, qty = 1, ei = e.i) => riskNewLeg(side, kind, ei, K, qty);
  const P = {
    lc: () => [L(1, "C", atm)],
    lp: () => [L(1, "P", atm)],
    bcs: () => [L(1, "C", atm), L(-1, "C", at(0.6))],
    bps: () => [L(1, "P", atm), L(-1, "P", at(-0.6))],
    str: () => [L(1, "C", atm), L(1, "P", atm)],
    stg: () => [L(1, "C", at(0.6)), L(1, "P", at(-0.6))],
    ic: () => [L(-1, "P", at(-0.6)), L(1, "P", at(-1.1)), L(-1, "C", at(0.6)), L(1, "C", at(1.1))],
    fly: () => [L(1, "C", at(-0.6)), L(-1, "C", atm, 2), L(1, "C", at(0.6))],
    cal: () => [L(-1, "C", atm), L(1, "C", nearestStrike(strikesOf(ch, far.i), S), 1, far.i)],
    cc: () => [L(1, "S", 0), L(-1, "C", at(0.6))],
    pp: () => [L(1, "S", 0), L(1, "P", at(-0.6))],
  };
  risk.legs = P[p]();
  risk.passed = 0;
  riskSave(); riskRender();
}

/* ---------------------------------------------------------------- valoracion */
function riskMult(l) { return l.kind === "S" ? 1 : 100; }
// valor por unidad de una pata con el subyacente en x, d dias despues de hoy
function riskLegValue(l, x, d) {
  if (l.kind === "S") return x;
  const e = riskExp(l);
  const T = Math.max(e.days - d, 0) / 365;
  return BS.price(x, l.K, T, risk.ch.r, e.q, Math.max(l.iv + risk.shift / 100, 0.005), l.kind === "C");
}
function riskPnL(x, d) {
  let s = 0;
  for (const l of risk.legs) s += l.side * l.qty * riskMult(l) * (riskLegValue(l, x, d) - l.entry);
  return s;
}
function riskHorizon() {   // dias hasta el primer vencimiento de las opciones (o 30 si solo hay acciones)
  const ds = risk.legs.filter((l) => l.kind !== "S").map((l) => riskExp(l).days);
  return ds.length ? Math.max(Math.min(...ds), 0) : 30;
}
function riskGreeks() {
  const g = { delta: 0, gamma: 0, theta: 0, vega: 0 };
  for (const l of risk.legs) {
    const n = l.side * l.qty * riskMult(l);
    if (l.kind === "S") { g.delta += n; continue; }
    const e = riskExp(l);
    const x = BS.greeks(risk.ch.spot, l.K, Math.max(e.T, 0), risk.ch.r, e.q, Math.max(l.iv + risk.shift / 100, 0.005), l.kind === "C");
    g.delta += n * x.delta; g.gamma += n * x.gamma; g.theta += n * x.theta; g.vega += n * x.vega;
  }
  return g;
}
// maximos, puntos muertos y probabilidad de ganar en el primer vencimiento
function riskStats() {
  const S = risk.ch.spot, H = riskHorizon();
  // rango realista: +-5 sigmas del ultimo vencimiento (y los strikes), mas el precio cero
  const opts = risk.legs.filter((l) => l.kind !== "S").map(riskExp);
  const last = opts.length ? opts.reduce((a, b) => (a.days >= b.days ? a : b)) : null;
  const sL = last ? Math.min(0.9, Math.max(0.1, ivAt(risk.ch, last.i, nearestStrike(strikesOf(risk.ch, last.i), last.fwd), true) * Math.sqrt(Math.max(last.T, 1 / 365)))) : 0.3;
  const ks = risk.legs.filter((l) => l.kind !== "S").map((l) => l.K);
  const lo = Math.max(0.0001, Math.min(S * (1 - 5 * sL), ...ks.map((k) => k * 0.8))), hi = Math.max(S * (1 + 5 * sL), ...ks.map((k) => k * 1.2));
  const N = 1200;
  let mx = -Infinity, mn = Infinity;
  const pts = [];
  for (let i = 0; i <= N; i++) { const x = lo + (hi - lo) * i / N, v = riskPnL(x, H); pts.push([x, v]); mx = Math.max(mx, v); mn = Math.min(mn, v); }
  for (const x of [0.0001, ...ks]) { const v = riskPnL(x, H); mx = Math.max(mx, v); mn = Math.min(mn, v); }   // extremos exactos en los strikes
  // ilimitado: al subir el precio, la posicion sigue ganando o perdiendo al menos como una accion
  const slope = (pts[N][1] - pts[N - 1][1]) / (pts[N][0] - pts[N - 1][0]);
  const gainInf = slope >= 1, lossInf = slope <= -1;
  const bes = [];
  for (let i = 1; i <= N; i++) {
    const [x0, v0] = pts[i - 1], [x1, v1] = pts[i];
    if ((v0 < 0 && v1 >= 0) || (v0 > 0 && v1 <= 0)) bes.push(x0 + (x1 - x0) * (0 - v0) / (v1 - v0));
  }
  // probabilidad lognormal (neutral al riesgo) de acabar en zona de ganancia, con la IV ATM del primer vencimiento
  let pop = null;
  const opt = risk.legs.filter((l) => l.kind !== "S");
  if (opt.length) {
    const first = opt.map(riskExp).reduce((a, b) => (a.days <= b.days ? a : b));
    const T = Math.max(first.T, 1 / (365 * 24));
    const v = ivAt(risk.ch, first.i, nearestStrike(strikesOf(risk.ch, first.i), first.fwd), true) + risk.shift / 100;
    const cuts = [0, ...bes, Infinity];
    pop = 0;
    for (let i = 0; i < cuts.length - 1; i++) {
      const a = cuts[i], b = cuts[i + 1];
      const mid = b === Infinity ? a * 1.5 + 1 : (a + b) / 2;
      if (riskPnL(mid, H) > 0) pop += BS.probAbove(S, a, T, risk.ch.r, first.q, v) - (b === Infinity ? 0 : BS.probAbove(S, b, T, risk.ch.r, first.q, v));
    }
  }
  const cost = risk.legs.reduce((s, l) => s + l.side * l.qty * riskMult(l) * l.entry, 0);
  return { mx: gainInf ? Infinity : mx, mn: lossInf ? -Infinity : mn, bes, pop, cost, H };
}

/* ---------------------------------------------------------------- estructura */
function riskBuild() {
  $("riskView").innerHTML = `
  <header class="tl-head">
    <div class="tl-brand"><svg class="re-mark" viewBox="0 0 28 28" aria-hidden="true"><rect x="1" y="1" width="26" height="26" rx="7"/><path d="M5 18c3 0 4-9 9-9s6 9 9 9"/><path d="M5 22h18" opacity=".5"/></svg>
      <div><h1>Risk Engine <span class="re-sym" id="reSym"></span></h1><p>Build a position from live prices, then stress it by price, time and volatility.</p></div></div>
    <div class="re-presets" id="rePresets" role="group" aria-label="Strategies">${RISK_PRESETS.map(([k, t]) => `<button type="button" data-p="${k}">${t}</button>`).join("")}</div>
  </header>
  <div class="re-grid">
    <section class="tl-card re-main">
      <div class="ss-verdict" id="reVerdict"></div>
      <div class="ss-chart" id="reChart" role="img" aria-label="Position profit and loss by underlying price"></div>
      <div class="ss-sliders">
        <label class="ss-sl"><span class="ss-sl-h">Date <b id="rePassedV"></b></span><input type="range" id="rePassed" min="0" max="30" step="1" value="0"></label>
        <label class="ss-sl"><span class="ss-sl-h">Implied volatility moves <b id="reShiftV"></b></span><input type="range" id="reShift" min="-20" max="20" step="1" value="0"></label>
      </div>
    </section>
    <aside class="tl-card re-side">
      <div class="re-legs-h"><h2>Position</h2><button type="button" class="ss-btn ghost" id="reAdd">Add leg</button></div>
      <div id="reLegs"></div>
      <div class="re-greeks" id="reGreeks"></div>
    </aside>
  </div>
  <section class="tl-card re-matrix-card">
    <div class="re-legs-h"><h2>Scenarios <small>P&amp;L by underlying move and date, with the IV change above</small></h2></div>
    <div class="re-matrix" id="reMatrix"></div>
  </section>
  <p class="tl-note">Each leg enters at the current bid/ask midpoint with its own implied volatility, and is valued with Black-Scholes-Merton on the forward of its expiration (dividends and carry included). Options are treated as European. The chance of profit uses the at-the-money IV of the first expiration.</p>`;
  $("rePresets").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b && risk.ch) riskPreset(b.dataset.p); });
  $("rePassed").addEventListener("input", (e) => { risk.passed = +e.target.value; riskDraw(); });
  $("reShift").addEventListener("input", (e) => { risk.shift = +e.target.value; riskDraw(); });
  $("reAdd").addEventListener("click", () => {
    if (!risk.ch) return;
    const e = risk.legs.length ? riskExp(risk.legs[risk.legs.length - 1]) : expNear(risk.ch, 30);
    risk.legs.push(riskNewLeg(1, "C", e.i, nearestStrike(strikesOf(risk.ch, e.i), risk.ch.spot)));
    riskSave(); riskRender();
  });
  const legs = $("reLegs");
  legs.addEventListener("click", (e) => {
    const b = e.target.closest("[data-a]"); if (!b) return;
    const i = risk.legs.findIndex((l) => l.id === +b.closest("[data-id]").dataset.id); if (i < 0) return;
    const l = risk.legs[i];
    if (b.dataset.a === "side") l.side = -l.side;
    else if (b.dataset.a === "del") risk.legs.splice(i, 1);
    else if (b.dataset.a === "kind") {
      const nk = { C: "P", P: "S", S: "C" }[l.kind];
      const e = riskExp(l);
      Object.assign(l, riskNewLeg(l.side, nk, e.i, nk === "S" ? 0 : nearestStrike(strikesOf(risk.ch, e.i), l.K || risk.ch.spot), nk === "S" || l.kind === "S" ? 1 : l.qty), { id: l.id });
    }
    riskSave(); riskRender();
  });
  legs.addEventListener("change", (e) => {
    const el = e.target, row = el.closest("[data-id]"); if (!row) return;
    const l = risk.legs.find((x) => x.id === +row.dataset.id); if (!l) return;
    const f = el.dataset.f;
    if (f === "qty") l.qty = Math.max(1, Math.round(+el.value || 1));
    if (f === "entry") { const v = parseFloat(el.value.replace(/,/g, "")); if (isFinite(v) && v >= 0) l.entry = v; }
    if (f === "exp" || f === "K") {
      const e = risk.ch.exps.find((x) => x.key === (f === "exp" ? el.value : l.exp));
      l.exp = e.key;
      l.K = nearestStrike(strikesOf(risk.ch, e.i), f === "K" ? +el.value : l.K);
      l.iv = ivAt(risk.ch, e.i, l.K, l.kind === "C");
      l.entry = midAt(risk.ch, e.i, l.K, l.kind === "C");
    }
    riskSave(); riskRender();
  });
  risk.built = true;
}

/* ---------------------------------------------------------------- carga */
function showRisk() {
  if (!risk.built) riskBuild();
  const sym = state.symbol || "SPX";
  $("symbol").value = sym;
  if (!risk.ch || risk.sym !== sym) loadRisk(); else { riskRender(); setStatus("", riskStatus()); }
}
function riskStatus() { return risk.ch ? `Chain at ${nyHHMM(risk.ch.generado)}` : ""; }
async function loadRisk(refresh = false) {
  if (!risk.built) riskBuild();
  const sym = (state.symbol || "SPX").toUpperCase();
  if (risk.ctrl) risk.ctrl.abort();
  risk.ctrl = new AbortController();
  $("refreshBtn").classList.add("spin");
  setStatus("busy", `Loading the ${sym} chain…`);
  $("reChart").classList.add("loading");
  try {
    const ch = await loadChain(sym, { refresh, signal: risk.ctrl.signal });
    if (!ch.live.length) throw new Error(`${sym} has no live expirations`);
    const changed = risk.sym !== ch.symbol;
    risk.ch = ch; risk.sym = ch.symbol;
    if (changed) {
      risk.passed = 0;
      const keep = (risk.saved[ch.symbol] || []).map(riskUnpack).filter((l) => ch.exps.some((e) => e.key === l.exp && e.days > 0));
      risk.legs = keep.map((l) => ({ ...l, id: risk.nid++ }));
      if (!risk.legs.length) { riskPreset("lc"); setStatus("", riskStatus()); return; }
    }
    riskRender();
    setStatus("", riskStatus());
  } catch (e) {
    if (e.name === "AbortError") return;
    $("reChart").innerHTML = `<div class="placeholder err"><div><div class="err-t">${esc(e.message)}</div></div></div>`;
    setStatus("err", e.message);
  } finally { $("refreshBtn").classList.remove("spin"); $("reChart").classList.remove("loading"); }
}

/* ---------------------------------------------------------------- pintar */
function riskRender() {
  if (!risk.ch) return;
  const ch = risk.ch;
  $("reSym").innerHTML = spotLabel(ch);
  const live = ch.live.slice(0, 40);
  $("reLegs").innerHTML = risk.legs.length ? `<div class="re-legs">${risk.legs.map((l) => {
    const e = riskExp(l), ks = l.kind === "S" ? [] : strikesOf(ch, e.i).filter((k) => Math.abs(k / ch.spot - 1) < 0.35 || k === l.K);
    const val = riskLegValue(l, ch.spot, 0);
    return `<div class="re-leg ${l.side > 0 ? "long" : "short"}" data-id="${l.id}">
      <button type="button" class="re-bs" data-a="side" title="Switch between buy and sell">${l.side > 0 ? "Buy" : "Sell"}</button>
      <input class="re-qty" data-f="qty" value="${l.qty}" inputmode="numeric" aria-label="Quantity" title="${l.kind === "S" ? "Shares" : "Contracts"}">
      <button type="button" class="re-kind k${l.kind}" data-a="kind" title="Call, put or shares">${{ C: "Call", P: "Put", S: "Shares" }[l.kind]}</button>
      ${l.kind === "S" ? `<span class="re-stock">${esc(ch.symbol)} at</span>` : `<select data-f="exp" aria-label="Expiration">${live.map((x) => `<option value="${x.key}" ${x.key === l.exp ? "selected" : ""}>${shortDate(x.iso)}, ${fmtNum(Math.max(x.days, 0), x.days < 1 ? 1 : 0)}d</option>`).join("")}</select>
      <select data-f="K" aria-label="Strike">${ks.map((k) => `<option value="${k}" ${k === l.K ? "selected" : ""}>${fmtNum(k, k % 1 ? 1 : 0)}</option>`).join("")}</select>`}
      <input class="re-px" data-f="entry" value="${fmtNum(l.entry, 2).replace(/,/g, "")}" inputmode="decimal" aria-label="Entry price" title="Entry price per ${l.kind === "S" ? "share" : "share of the option"}; now ${fmtNum(val, 2)}">
      <span class="re-iv" title="Implied volatility of this contract">${l.kind === "S" ? "" : fmtNum(l.iv * 100, 1) + "%"}</span>
      <button type="button" class="re-del" data-a="del" aria-label="Remove leg">×</button>
    </div>`;
  }).join("")}</div>` : `<p class="re-empty">Pick a strategy above or add a leg to start.</p>`;
  riskDraw();
}

function riskDraw() {
  if (!risk.ch) return;
  const ch = risk.ch, S = ch.spot;
  const st = risk.legs.length ? riskStats() : null;
  const H = st ? st.H : 30;
  const ps = $("rePassed");
  const maxD = Math.max(1, Math.floor(H));
  ps.max = String(maxD);
  if (risk.passed > maxD) risk.passed = maxD;
  ps.value = String(risk.passed);
  const firstIso = (() => { const o = risk.legs.filter((l) => l.kind !== "S").map(riskExp); return o.length ? o.reduce((a, b) => (a.days <= b.days ? a : b)).iso : null; })();
  const dateOf = (d) => { const t = new Date(Date.now() + d * 86400000); return `${MESES[t.getMonth()]} ${t.getDate()}`; };
  $("rePassedV").textContent = risk.passed ? `${dateOf(risk.passed)} (in ${risk.passed} ${risk.passed === 1 ? "day" : "days"})` : "today";
  $("reShiftV").textContent = risk.shift ? `${risk.shift > 0 ? "+" : "−"}${Math.abs(risk.shift)} pts on every leg` : "no change";
  if (!st) { $("reVerdict").innerHTML = ""; $("reChart").innerHTML = ""; $("reGreeks").innerHTML = ""; $("reMatrix").innerHTML = ""; return; }

  const cell = (t, v, cls = "", sub = "") => `<div class="ss-v ${cls}"><span>${t}</span><b${String(v).length > 12 ? ' class="two"' : ""}>${v}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;
  const at = firstIso ? `at ${shortDate(firstIso)}` : "";
  $("reVerdict").innerHTML =
    cell(st.cost >= 0 ? "You pay" : "You collect", money(Math.abs(st.cost), 0), st.cost < 0 ? "pos" : "", `${risk.legs.length} ${risk.legs.length === 1 ? "leg" : "legs"}`) +
    cell("Max gain", st.mx === Infinity ? "Unlimited" : money(st.mx, 0), "pos", at) +
    cell("Max loss", st.mn === -Infinity ? "Unlimited" : money(st.mn, 0), "neg", at) +
    cell("Breakeven", st.bes.length ? st.bes.slice(0, 2).map((x) => px(x)).join(" / ") + (st.bes.length > 2 ? "…" : "") : "None", "", at) +
    cell("Chance of profit", st.pop == null ? "—" : `${fmtNum(st.pop * 100, 0)}%`, "", at || "");

  // grafico
  const opt = risk.legs.filter((l) => l.kind !== "S");
  const sig = opt.length ? (() => { const e = opt.map(riskExp).reduce((a, b) => (a.days <= b.days ? a : b)); return ivAt(ch, e.i, nearestStrike(strikesOf(ch, e.i), e.fwd), true) * Math.sqrt(Math.max(e.T, 1 / 365)); })() : 0.05;
  const w = Math.min(0.6, Math.max(0.05, 3 * sig));
  const strikes = opt.map((l) => l.K);
  let lo = Math.min(S * (1 - w), ...strikes.map((k) => k * 0.97)), hi = Math.max(S * (1 + w), ...strikes.map((k) => k * 1.03));
  lo = Math.max(lo, 0);
  const xs = Array.from({ length: 181 }, (_, i) => lo + (hi - lo) * i / 180);
  const curves = [
    { label: firstIso ? `At ${shortDate(firstIso)} expiration` : "In 30 days", color: C.text, main: true, pts: xs.map((x) => [x, riskPnL(x, H)]) },
    { label: `Today${risk.shift ? ` (IV ${risk.shift > 0 ? "+" : "−"}${Math.abs(risk.shift)})` : ""}`, color: C.accent, pts: xs.map((x) => [x, riskPnL(x, 0)]) },
  ];
  if (risk.passed > 0 && risk.passed < H) curves.push({ label: dateOf(risk.passed), color: C.amber, dash: "6 4", pts: xs.map((x) => [x, riskPnL(x, risk.passed)]) });
  const uk = [...new Set(strikes)].sort((a, b) => a - b);
  payoffChart($("reChart"), {
    lo, hi, curves, ref: S, bes: st.bes,
    marks: [{ x: S, label: `Spot ${px(S)}`, color: C.spotline, dash: "1 3", side: "end" },
      ...uk.slice(0, 6).map((k) => ({ x: k, label: fmtNum(k, k % 1 ? 1 : 0), color: C.faint, side: "start" }))],
    band: [S * (1 - sig), S * (1 + sig)], bandLabel: `±1σ move by ${firstIso ? shortDate(firstIso) : "expiry"}`,
    probe: (x) => curves.map((c, i) => ({ label: c.label, color: c.color, v: riskPnL(x, i === 0 ? H : i === 1 ? 0 : risk.passed) })),
  });

  // griegas netas
  const g = riskGreeks();
  const gr = (t, v, line, hint) => `<div class="ss-g" title="${esc(hint)}"><span class="ss-gn">${t}</span><b>${(Math.abs(v) < 0.005 ? "" : v > 0 ? "+" : "−") + fmtNum(Math.abs(v), Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 1 ? 1 : 2)}</b><small>${line}</small></div>`;
  $("reGreeks").innerHTML = `<h3>Net Greeks now</h3>
    ${gr("Delta", g.delta, `${signedMoney(g.delta, 0)} per +$1, like ${fmtNum(Math.abs(g.delta), 0)} shares ${g.delta >= 0 ? "long" : "short"}`, "Shares-equivalent exposure to the underlying.")}
    ${gr("Gamma", g.gamma, "change in delta per +$1", "How fast the position's delta changes when the underlying moves $1.")}
    ${gr("Theta", g.theta, `${signedMoney(g.theta, 0)} per day from time alone`, "Daily time decay of the whole position.")}
    ${gr("Vega", g.vega, `${signedMoney(g.vega, 0)} per +1 point of IV`, "Gain or loss if implied volatility rises one point on every leg.")}`;

  // matriz de escenarios: movimientos en sigmas del primer vencimiento, fechas de hoy a ese vencimiento
  const moves = [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2].map((k) => k * sig);
  const days = [0, H * 0.25, H * 0.5, H * 0.75, H];
  const vals = moves.map((mv) => days.map((d) => riskPnL(S * (1 + mv), d)));
  const top = Math.max(1, ...vals.flat().map(Math.abs));
  const head = days.map((d, i) => `<th>${i === 0 ? "Today" : i === days.length - 1 ? (firstIso ? shortDate(firstIso) : dateOf(d)) : dateOf(d)}</th>`).join("");
  $("reMatrix").innerHTML = `<table><thead><tr><th class="l">Underlying</th>${head}</tr></thead><tbody>${moves.map((mv, i) => `<tr class="${mv === 0 ? "now" : ""}"><td class="l"><b>${fmtNum(S * (1 + mv), priceDec(S))}</b><small>${mv === 0 ? "unchanged" : `${mv > 0 ? "+" : "−"}${fmtNum(Math.abs(mv) * 100, 1)}%`}</small></td>${vals[i].map((v) => {
    const a = Math.min(1, Math.abs(v) / top);
    const col = v >= 0 ? C.put : C.call;
    return `<td style="--a:${(0.08 + a * 0.5).toFixed(2)};--c:${col}" class="${v > 0 ? "up" : v < 0 ? "dn" : ""}">${signedMoney(v, 0)}</td>`;
  }).join("")}</tr>`).join("")}</tbody></table>`;
}
function renderRisk() { if (risk.built && risk.ch) riskDraw(); }
