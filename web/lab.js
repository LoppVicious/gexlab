"use strict";
/* ============================================================ Options Lab (calculadora y estrategias en uno)
   Una o varias patas (opciones o acciones) valoradas por Black-Scholes-Merton, en dos modos:
   - Live: el ticker de la barra superior; cada pata sale de la cadena real (precio medio e IV de su contrato, carry
     del forward de su vencimiento).
   - Hypothetical: precio, tipo y dividendo inventados; cada pata con sus dias, strike e IV.
   Muestra lecturas (coste, maximos, puntos muertos, probabilidad), una frase con lo esencial, el P&L por precio al
   primer vencimiento, hoy y en la fecha elegida (con un cambio de IV), las griegas netas y una matriz de escenarios. */

const LAB_PRESETS = [
  ["lc", "Long call"], ["lp", "Long put"], ["sc", "Short call"], ["sp", "Short put"], ["bcs", "Bull call spread"],
  ["bps", "Bear put spread"], ["str", "Straddle"], ["stg", "Strangle"], ["ic", "Iron condor"], ["fly", "Butterfly"],
  ["cal", "Calendar"], ["cc", "Covered call"], ["pp", "Protective put"],
];
const LAB_HYP = { S: 450, r: 4.5, q: 0, iv: 20 };

function labLoad(k, d) { try { const v = JSON.parse(store.get(k, "null")); return v == null ? d : v; } catch { return d; } }
const lab = {
  mode: store.get("labMode", "live") === "hyp" ? "hyp" : "live",
  hyp: Object.assign({}, LAB_HYP, labLoad("labHyp", {})),
  sym: "", ch: null, legs: [], hypLegs: null, passed: 0, shift: 0, ctrl: null, built: false, nid: 1,
  saved: labLoad("labLegs", {}),
};

/* ---------------------------------------------------------------- guardar (la nube corta cada preferencia a 2.000) */
const labPack = (l) => [l.side, l.qty, l.kind, l.exp || l.days, l.K, +(+l.iv).toFixed(4), +(+l.entry).toFixed(2), l.auto ? 1 : 0];
const labUnpack = (a, live) => ({ id: lab.nid++, side: a[0], qty: a[1], kind: a[2], [live ? "exp" : "days"]: a[3], K: a[4], iv: a[5], entry: a[6], auto: !!a[7] });
function labSave() {
  if (lab.mode === "live" && lab.sym) {
    delete lab.saved[lab.sym];
    lab.saved[lab.sym] = lab.legs.map(labPack);
    const keys = Object.keys(lab.saved);
    while (keys.length > 3) delete lab.saved[keys.shift()];
    let js = JSON.stringify(lab.saved);
    while (js.length > 1900 && Object.keys(lab.saved).length > 1) { delete lab.saved[Object.keys(lab.saved)[0]]; js = JSON.stringify(lab.saved); }
    store.set("labLegs", js.length > 1900 ? "{}" : js);
  } else if (lab.mode === "hyp") {
    const js = JSON.stringify(lab.legs.map(labPack));
    store.set("labHypLegs", js.length > 1900 ? "[]" : js);
  }
  store.set("labHyp", JSON.stringify(lab.hyp));
}

/* ---------------------------------------------------------------- parametros de cada modo */
const labLive = () => lab.mode === "live";
function labS() { return labLive() ? lab.ch.spot : lab.hyp.S; }
function labR() { return labLive() ? lab.ch.r : lab.hyp.r / 100; }
function labExp(l) { return lab.ch.exps.find((e) => e.key === l.exp); }
function labDays(l) { return l.kind === "S" ? Infinity : labLive() ? labExp(l).days : l.days; }
function labQ(l) { return labLive() ? labExp(l).q : lab.hyp.q / 100; }
function labMult(l) { return l.kind === "S" ? 1 : 100; }
function labStep(S) { return S >= 2000 ? 5 : S >= 500 ? 1 : S >= 50 ? 0.5 : 0.1; }
function labModel(l) { return BS.price(labS(), l.K, Math.max(labDays(l), 0) / 365, labR(), labQ(l), Math.max(l.iv, 0.005), l.kind === "C"); }

// valor por unidad de una pata con el subyacente en x, d dias despues de hoy
function labValue(l, x, d) {
  if (l.kind === "S") return x;
  const T = Math.max(labDays(l) - d, 0) / 365;
  return BS.price(x, l.K, T, labR(), labQ(l), Math.max(l.iv + lab.shift / 100, 0.005), l.kind === "C");
}
function labPnL(x, d) {
  let s = 0;
  for (const l of lab.legs) s += l.side * l.qty * labMult(l) * (labValue(l, x, d) - l.entry);
  return s;
}
const labOpts = () => lab.legs.filter((l) => l.kind !== "S");
function labFirst() { const o = labOpts(); return o.length ? o.reduce((a, b) => (labDays(a) <= labDays(b) ? a : b)) : null; }
function labLast() { const o = labOpts(); return o.length ? o.reduce((a, b) => (labDays(a) >= labDays(b) ? a : b)) : null; }
function labHorizon() { const f = labFirst(); return f ? Math.max(labDays(f), 0) : 30; }
// IV de referencia de una pata (la ATM de su vencimiento en Live; la suya en Hypothetical)
function labAtmIV(l) {
  if (!l) return lab.hyp.iv / 100;
  if (!labLive()) return l.iv;
  const e = labExp(l);
  return ivAt(lab.ch, e.i, nearestStrike(strikesOf(lab.ch, e.i), e.fwd), true);
}
function labWhen(l) {   // fecha de la pata para las etiquetas
  if (!l) return "";
  if (labLive()) return shortDate(labExp(l).iso);
  const t = new Date(Date.now() + l.days * 86400000);
  return `${MESES[t.getMonth()]} ${t.getDate()}`;
}

/* ---------------------------------------------------------------- patas y estrategias */
function labLeg(side, kind, K, opt = {}) {
  const l = { id: lab.nid++, side, qty: opt.qty || 1, kind, K };
  if (kind === "S") { l.qty = (opt.qty || 1) * 100; l.K = 0; l.iv = 0; l.entry = labS(); l.days = 0; if (labLive()) l.exp = lab.ch.live[0].key; return l; }
  if (labLive()) {
    const e = opt.e || expNear(lab.ch, 30);
    l.exp = e.key;
    l.K = nearestStrike(strikesOf(lab.ch, e.i), K);
    l.iv = ivAt(lab.ch, e.i, l.K, kind === "C");
    l.entry = midAt(lab.ch, e.i, l.K, kind === "C");
  } else {
    l.days = opt.days || 30;
    l.K = +(Math.round(K / labStep(lab.hyp.S)) * labStep(lab.hyp.S)).toFixed(2);
    l.iv = lab.hyp.iv / 100;
    l.auto = true;
    l.entry = labModel(l);
  }
  return l;
}
function labPreset(p) {
  const S = labS();
  let e = null, far = null, sig;
  if (labLive()) {
    e = expNear(lab.ch, 30); far = expNear(lab.ch, Math.max(60, e.days + 25));
    sig = ivAt(lab.ch, e.i, nearestStrike(strikesOf(lab.ch, e.i), e.fwd), true) * Math.sqrt(Math.max(e.T, 1 / 365));
  } else sig = lab.hyp.iv / 100 * Math.sqrt(30 / 365);
  const at = (k) => S * (1 + k * sig);
  const L = (side, kind, k, o = {}) => labLeg(side, kind, at(k), { e, ...o });
  const P = {
    lc: () => [L(1, "C", 0)], lp: () => [L(1, "P", 0)],
    sc: () => [L(-1, "C", 0.6)], sp: () => [L(-1, "P", -0.6)],
    bcs: () => [L(1, "C", 0), L(-1, "C", 0.6)], bps: () => [L(1, "P", 0), L(-1, "P", -0.6)],
    str: () => [L(1, "C", 0), L(1, "P", 0)], stg: () => [L(1, "C", 0.6), L(1, "P", -0.6)],
    ic: () => [L(-1, "P", -0.6), L(1, "P", -1.1), L(-1, "C", 0.6), L(1, "C", 1.1)],
    fly: () => [L(1, "C", -0.6), L(-1, "C", 0, { qty: 2 }), L(1, "C", 0.6)],
    cal: () => [L(-1, "C", 0), L(1, "C", 0, { e: far, days: 60 })],
    cc: () => [L(1, "S", 0), L(-1, "C", 0.6)], pp: () => [L(1, "S", 0), L(1, "P", -0.6)],
  };
  lab.legs = P[p]();
  lab.passed = 0;
  labSave(); labRender();
}

/* ---------------------------------------------------------------- estadisticas */
function labStats() {
  const S = labS(), H = labHorizon(), last = labLast();
  const sL = Math.min(0.9, Math.max(0.1, labAtmIV(last) * Math.sqrt(Math.max(last ? labDays(last) : 30, 1) / 365)));
  const ks = labOpts().map((l) => l.K);
  const lo = Math.max(0.0001, Math.min(S * (1 - 5 * sL), ...ks.map((k) => k * 0.8))), hi = Math.max(S * (1 + 5 * sL), ...ks.map((k) => k * 1.2));
  const N = 1200, pts = [];
  let mx = -Infinity, mn = Infinity;
  for (let i = 0; i <= N; i++) { const x = lo + (hi - lo) * i / N, v = labPnL(x, H); pts.push([x, v]); mx = Math.max(mx, v); mn = Math.min(mn, v); }
  for (const x of [0.0001, ...ks]) { const v = labPnL(x, H); mx = Math.max(mx, v); mn = Math.min(mn, v); }
  // ilimitado: al subir el precio, la posicion sigue ganando o perdiendo al menos como una accion
  const slope = (pts[N][1] - pts[N - 1][1]) / (pts[N][0] - pts[N - 1][0]);
  const bes = [];
  for (let i = 1; i <= N; i++) {
    const [x0, v0] = pts[i - 1], [x1, v1] = pts[i];
    if ((v0 < 0 && v1 >= 0) || (v0 > 0 && v1 <= 0)) bes.push(x0 + (x1 - x0) * (0 - v0) / (v1 - v0));
  }
  // probabilidad (neutral al riesgo, lognormal) de acabar en zona de ganancia en el primer vencimiento
  const f = labFirst();
  let pop = null;
  const zones = [];
  if (f) {
    const T = Math.max(H, 1 / 24) / 365, v = labAtmIV(f) + lab.shift / 100, q = labQ(f), r = labR();
    const cuts = [0, ...bes, Infinity];
    pop = 0;
    for (let i = 0; i < cuts.length - 1; i++) {
      const a = cuts[i], b = cuts[i + 1], mid = b === Infinity ? a * 1.5 + 1 : (a + b) / 2;
      const win = labPnL(mid, H) > 0;
      zones.push({ a, b, win });
      if (win) pop += BS.probAbove(S, a, T, r, q, v) - (b === Infinity ? 0 : BS.probAbove(S, b, T, r, q, v));
    }
  }
  const cost = lab.legs.reduce((s, l) => s + l.side * l.qty * labMult(l) * l.entry, 0);
  const now = lab.legs.reduce((s, l) => s + l.side * l.qty * labMult(l) * labValue(l, S, 0), 0);
  return { mx: slope >= 1 ? Infinity : mx, mn: slope <= -1 ? -Infinity : mn, bes, pop, zones, cost, now, H, first: f };
}
function labGreeks() {
  const g = { delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0 };
  for (const l of lab.legs) {
    const n = l.side * l.qty * labMult(l);
    if (l.kind === "S") { g.delta += n; continue; }
    const x = BS.greeks(labS(), l.K, Math.max(labDays(l), 0) / 365, labR(), labQ(l), Math.max(l.iv + lab.shift / 100, 0.005), l.kind === "C");
    for (const k of Object.keys(g)) g[k] += n * x[k];
  }
  return g;
}
// frase con lo esencial: que pagas o cobras y en que zona ganas al primer vencimiento
function labSentence(st) {
  if (!lab.legs.length) return "";
  const pay = st.cost >= 0 ? `You pay <b>${money(st.cost, 0)}</b>` : `You collect <b>${money(-st.cost, 0)}</b>`;
  const when = st.first ? ` at the ${labWhen(st.first)} expiration` : "";
  const z = st.zones.filter((x) => x.win);
  let where = "";
  if (z.length === 1) {
    const { a, b } = z[0];
    where = a <= 0.001 && b === Infinity ? "you make money at any price" : a <= 0.001 ? `you make money below <b>${px(b)}</b>` : b === Infinity ? `you make money above <b>${px(a)}</b>` : `you make money between <b>${px(a)}</b> and <b>${px(b)}</b>`;
  } else if (z.length > 1) where = `you make money ${z.map(({ a, b }) => (a <= 0.001 ? `below <b>${px(b)}</b>` : b === Infinity ? `above <b>${px(a)}</b>` : `between <b>${px(a)}</b> and <b>${px(b)}</b>`)).join(" or ")}`;
  else where = "this position does not end in profit at any price";
  const p = st.pop != null && z.length ? ` (a <b>${fmtNum(st.pop * 100, 0)}%</b> chance by the option prices)` : "";
  return `${pay}. ${where[0].toUpperCase()}${where.slice(1)}${when}${p}.`;
}

/* ---------------------------------------------------------------- estructura */
function labBuild() {
  $("labView").innerHTML = `
  <header class="lab-head">
    <div class="lab-title"><h1>Options Lab</h1><span class="lab-sym" id="labSym"></span></div>
    <div class="lab-keys" role="radiogroup" aria-label="Prices" id="labMode">
      <button role="radio" data-v="live">Live chain</button><button role="radio" data-v="hyp">Hypothetical</button></div>
  </header>
  <div class="lab-hyp" id="labHyp" hidden>
    <label>Underlying <input data-h="S" inputmode="decimal"></label>
    <label>Implied vol <input data-h="iv" inputmode="decimal"><i>%</i></label>
    <label>Rate <input data-h="r" inputmode="decimal"><i>%</i></label>
    <label>Dividend yield <input data-h="q" inputmode="decimal"><i>%</i></label>
  </div>
  <section class="lab-panel lab-legs-panel">
    <div class="lab-cap"><span>Position</span><span class="lab-presets" id="labPresets" role="group" aria-label="Strategies">${LAB_PRESETS.map(([k, t]) => `<button type="button" data-p="${k}">${t}</button>`).join("")}</span></div>
    <div id="labLegs"></div>
  </section>
  <div class="lab-read" id="labRead"></div>
  <p class="lab-say" id="labSay"></p>
  <div class="lab-grid">
    <section class="lab-panel">
      <div class="lab-cap"><span>Profit and loss by price</span><span id="labCapR"></span></div>
      <div class="ss-chart lab-scope" id="labChart" role="img" aria-label="Position profit and loss by underlying price"></div>
      <div class="lab-faders">
        <label class="lab-fader"><span>Date <b id="labPassedV"></b></span><input type="range" id="labPassed" min="0" max="30" step="1" value="0"></label>
        <label class="lab-fader"><span>Implied volatility <b id="labShiftV"></b></span><input type="range" id="labShift" min="-20" max="20" step="1" value="0"></label>
      </div>
    </section>
    <section class="lab-panel lab-greeks-panel">
      <div class="lab-cap"><span>Greeks now</span><span>whole position</span></div>
      <div id="labGreeks"></div>
    </section>
  </div>
  <section class="lab-panel">
    <div class="lab-cap"><span>Scenarios</span><span>P&amp;L by price move and date, with the volatility change above</span></div>
    <div class="re-matrix" id="labMatrix"></div>
  </section>
  <p class="tl-note">Black-Scholes-Merton with European exercise. In Live, each leg enters at the bid/ask midpoint with its own implied volatility and is valued on the forward of its expiration (dividends and carry included). The chance of profit is the one the option prices imply, not a forecast. Commissions and slippage are not included.</p>`;
  $("labMode").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b && b.dataset.v !== lab.mode) labSetMode(b.dataset.v); });
  $("labHyp").addEventListener("change", (e) => {
    const el = e.target.closest("[data-h]"); if (!el) return;
    const v = parseFloat(el.value.replace(/,/g, "")), k = el.dataset.h;
    const lim = { S: [0.01, 1e7], iv: [0.5, 300], r: [-5, 30], q: [-5, 50] }[k];
    if (isFinite(v)) lab.hyp[k] = Math.min(lim[1], Math.max(lim[0], v));
    if (k === "iv") for (const l of lab.legs) if (l.kind !== "S") l.iv = lab.hyp.iv / 100;
    labAuto(); labSave(); labRender();
  });
  $("labPresets").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b && (lab.ch || !labLive())) labPreset(b.dataset.p); });
  $("labPassed").addEventListener("input", (e) => { lab.passed = +e.target.value; labDraw(); });
  $("labShift").addEventListener("input", (e) => { lab.shift = +e.target.value; labDraw(); });
  const legs = $("labLegs");
  legs.addEventListener("click", (e) => {
    const b = e.target.closest("[data-a]"); if (!b) return;
    if (b.dataset.a === "add") {
      const last = lab.legs[lab.legs.length - 1];
      lab.legs.push(labLeg(1, "C", labS(), labLive() ? { e: last && last.kind !== "S" ? labExp(last) : expNear(lab.ch, 30) } : { days: last && last.kind !== "S" ? last.days : 30 }));
      labSave(); labRender(); return;
    }
    const i = lab.legs.findIndex((l) => l.id === +b.closest("[data-id]").dataset.id); if (i < 0) return;
    const l = lab.legs[i];
    if (b.dataset.a === "side") l.side = -l.side;
    else if (b.dataset.a === "del") lab.legs.splice(i, 1);
    else if (b.dataset.a === "kind") {
      const nk = { C: "P", P: "S", S: "C" }[l.kind];
      const o = labLive() ? { e: l.kind !== "S" ? labExp(l) : expNear(lab.ch, 30) } : { days: l.days || 30 };
      lab.legs[i] = Object.assign(labLeg(l.side, nk, l.K || labS(), { ...o, qty: l.kind === "S" ? 1 : l.qty }), { id: l.id });
    }
    labSave(); labRender();
  });
  legs.addEventListener("change", (e) => {
    const el = e.target, row = el.closest("[data-id]"); if (!row) return;
    const l = lab.legs.find((x) => x.id === +row.dataset.id); if (!l) return;
    const f = el.dataset.f, v = parseFloat(String(el.value).replace(/,/g, ""));
    if (f === "qty" && isFinite(v)) l.qty = Math.max(1, Math.round(v));
    if (f === "entry" && isFinite(v) && v >= 0) { l.entry = v; l.auto = false; }
    if (f === "iv" && isFinite(v) && v > 0) { l.iv = v / 100; if (l.auto) l.entry = labModel(l); }
    if (f === "days" && isFinite(v)) { l.days = Math.max(0, Math.min(3650, v)); if (l.auto) l.entry = labModel(l); }
    if (f === "K" && isFinite(v) && v > 0) {
      if (labLive()) { const ex = labExp(l); l.K = nearestStrike(strikesOf(lab.ch, ex.i), v); l.iv = ivAt(lab.ch, ex.i, l.K, l.kind === "C"); l.entry = midAt(lab.ch, ex.i, l.K, l.kind === "C"); }
      else { l.K = v; if (l.auto) l.entry = labModel(l); }
    }
    if (f === "exp") {
      const ex = lab.ch.exps.find((x) => x.key === el.value);
      l.exp = ex.key; l.K = nearestStrike(strikesOf(lab.ch, ex.i), l.K);
      l.iv = ivAt(lab.ch, ex.i, l.K, l.kind === "C"); l.entry = midAt(lab.ch, ex.i, l.K, l.kind === "C");
    }
    labSave(); labRender();
  });
  lab.built = true;
}
// en Hypothetical, las patas sin precio de entrada propio siguen al modelo
function labAuto() { if (!labLive()) for (const l of lab.legs) if (l.auto) l.entry = l.kind === "S" ? lab.hyp.S : labModel(l); }

function labSetMode(m) {
  if (labLive()) labSave();
  lab.mode = m; store.set("labMode", m);
  lab.passed = 0;
  if (m === "hyp") {
    lab.legs = labLoad("labHypLegs", []).map((a) => labUnpack(a, false));
    if (!lab.legs.length) { labSync(); labPreset("lc"); return; }
    labAuto(); labSync(); labRender(); setStatus("", "");
  } else { lab.sym = ""; loadLab(); }
}
function labSync() {
  for (const b of $("labMode").querySelectorAll("button")) b.setAttribute("aria-checked", String(b.dataset.v === lab.mode));
  $("labHyp").hidden = labLive();
  for (const el of $("labHyp").querySelectorAll("[data-h]")) if (el !== document.activeElement) el.value = String(lab.hyp[el.dataset.h]);
  document.body.classList.toggle("lab-hyp-mode", !labLive());
}

/* ---------------------------------------------------------------- carga */
function showLab() {
  if (!lab.built) labBuild();
  labSync();
  if (!labLive()) { if (!lab.legs.length || lab.legs.some((l) => l.exp)) labSetMode("hyp"); else labRender(); return; }
  const sym = state.symbol || "SPX";
  $("symbol").value = sym;
  if (!lab.ch || lab.sym !== sym) loadLab(); else { labRender(); setStatus("", labStatus()); }
}
function labStatus() { return lab.ch && labLive() ? `Chain at ${nyHHMM(lab.ch.generado)}` : ""; }
async function loadLab(refresh = false) {
  if (!lab.built) labBuild();
  if (!labLive()) { lab.mode = "live"; store.set("labMode", "live"); }
  labSync();
  const sym = (state.symbol || "SPX").toUpperCase();
  if (lab.ctrl) lab.ctrl.abort();
  lab.ctrl = new AbortController();
  $("refreshBtn").classList.add("spin");
  setStatus("busy", `Loading the ${sym} chain…`);
  $("labChart").classList.add("loading");
  try {
    const ch = await loadChain(sym, { refresh, signal: lab.ctrl.signal });
    if (!ch.live.length) throw new Error(`${sym} has no live expirations`);
    const changed = lab.sym !== ch.symbol;
    lab.ch = ch; lab.sym = ch.symbol;
    if (changed) {
      lab.passed = 0;
      lab.legs = (lab.saved[ch.symbol] || []).map((a) => labUnpack(a, true)).filter((l) => ch.exps.some((e) => e.key === l.exp && (l.kind === "S" || e.days > 0)));
      if (!lab.legs.length) { labPreset("lc"); setStatus("", labStatus()); return; }
    }
    labRender();
    setStatus("", labStatus());
  } catch (e) {
    if (e.name === "AbortError") return;
    $("labChart").innerHTML = `<div class="placeholder err"><div><div class="err-t">${esc(e.message)}</div></div></div>`;
    setStatus("err", e.message);
  } finally { $("refreshBtn").classList.remove("spin"); $("labChart").classList.remove("loading"); }
}

/* ---------------------------------------------------------------- pintar */
function labRender() {
  if (labLive() && !lab.ch) return;
  $("labSym").innerHTML = labLive() ? spotLabel(lab.ch) : `Hypothetical underlying at ${px(lab.hyp.S)}`;
  const live = labLive() ? lab.ch.live.slice(0, 40) : [];
  const num = (f, v, label, w = "") => `<input class="lab-in ${w}" data-f="${f}" value="${esc(v)}" inputmode="decimal" aria-label="${label}">`;
  const rows = lab.legs.map((l) => {
    const isS = l.kind === "S";
    let when = "", strike = "";
    if (!isS && labLive()) {
      const e = labExp(l), ks = strikesOf(lab.ch, e.i).filter((k) => Math.abs(k / lab.ch.spot - 1) < 0.35 || k === l.K);
      when = `<select class="lab-in" data-f="exp" aria-label="Expiration">${live.map((x) => `<option value="${x.key}" ${x.key === l.exp ? "selected" : ""}>${shortDate(x.iso)}, ${fmtNum(Math.max(x.days, 0), x.days < 1 ? 1 : 0)}d</option>`).join("")}</select>`;
      strike = `<select class="lab-in" data-f="K" aria-label="Strike">${ks.map((k) => `<option value="${k}" ${k === l.K ? "selected" : ""}>${fmtNum(k, k % 1 ? 1 : 0)}</option>`).join("")}</select>`;
    } else if (!isS) {
      when = `<span class="lab-unit">${num("days", l.days, "Days to expiration")}<i>days</i></span>`;
      strike = `<span class="lab-unit"><i>K</i>${num("K", l.K, "Strike")}</span>`;
    } else when = `<span class="lab-dim">shares of the underlying</span>`;
    const val = labValue(l, labS(), 0);
    return `<div class="lab-leg ${l.side > 0 ? "long" : "short"} k${l.kind}" data-id="${l.id}">
      <button type="button" class="lab-key bs" data-a="side" title="Switch between buy and sell">${l.side > 0 ? "Buy" : "Sell"}</button>
      ${num("qty", l.qty, l.kind === "S" ? "Shares" : "Contracts", "qty")}
      <button type="button" class="lab-key kind" data-a="kind" title="Call, put or shares">${{ C: "Call", P: "Put", S: "Shares" }[l.kind]}</button>
      <span class="lab-when">${when}</span><span class="lab-k">${strike}</span>
      <span class="lab-unit lab-ivc">${isS ? "" : `${num("iv", +(l.iv * 100).toFixed(1), "Implied volatility (%)")}<i>% IV</i>`}</span>
      <span class="lab-unit lab-px" title="Entry price per ${isS ? "share" : "share of the option"}; worth ${fmtNum(val, 2)} now"><i>@</i>${num("entry", fmtNum(l.entry, 2).replace(/,/g, ""), "Entry price")}</span>
      <button type="button" class="lab-del" data-a="del" aria-label="Remove leg">×</button>
    </div>`;
  }).join("");
  $("labLegs").innerHTML = `${rows || `<p class="re-empty">Pick a strategy above, or add a leg.</p>`}<button type="button" class="lab-add" data-a="add">Add leg</button>`;
  labDraw();
}

function labDraw() {
  if (labLive() && !lab.ch) return;
  const S = labS();
  const st = lab.legs.length ? labStats() : null;
  const H = st ? st.H : 30;
  const ps = $("labPassed"), maxD = Math.max(1, Math.floor(H));
  ps.max = String(maxD);
  if (lab.passed > maxD) lab.passed = maxD;
  ps.value = String(lab.passed);
  const dateOf = (d) => { const t = new Date(Date.now() + d * 86400000); return `${MESES[t.getMonth()]} ${t.getDate()}`; };
  $("labPassedV").textContent = lab.passed ? `${dateOf(lab.passed)}, in ${lab.passed} ${lab.passed === 1 ? "day" : "days"}` : "today";
  $("labShiftV").textContent = lab.shift ? `${lab.shift > 0 ? "+" : "−"}${Math.abs(lab.shift)} points on every leg` : "unchanged";
  if (!st) { for (const id of ["labRead", "labSay", "labChart", "labGreeks", "labMatrix", "labCapR"]) $(id).innerHTML = ""; return; }

  const when = st.first ? labWhen(st.first) : "";
  const cell = (t, v, cls = "", sub = "") => `<div class="lab-r ${cls}"><span>${t}</span><b>${v}</b><small>${sub}</small></div>`;
  $("labRead").innerHTML =
    cell(st.cost >= 0 ? "Net debit" : "Net credit", money(Math.abs(st.cost), 0), st.cost < 0 ? "pos" : "", st.now >= 0 ? `worth ${money(st.now, 0)} now` : `${money(-st.now, 0)} to close now`) +
    cell("Max gain", st.mx === Infinity ? "Unlimited" : money(st.mx, 0), "pos", when ? `at ${when}` : "") +
    cell("Max loss", st.mn === -Infinity ? "Unlimited" : money(st.mn, 0), "neg", when ? `at ${when}` : "") +
    cell(st.bes.length > 1 ? "Breakevens" : "Breakeven", st.bes.length ? st.bes.slice(0, 2).map(px).join(" / ") + (st.bes.length > 2 ? "…" : "") : "None", st.bes.length > 1 ? "two" : "", when ? `at ${when}` : "") +
    cell("Chance of profit", st.pop == null ? "—" : `${fmtNum(st.pop * 100, 0)}%`, "", "implied by the options");
  $("labSay").innerHTML = labSentence(st);

  // grafico
  const f = st.first;
  const sig = f ? labAtmIV(f) * Math.sqrt(Math.max(labDays(f), 1 / 24) / 365) : 0.05;
  const w = Math.min(0.6, Math.max(0.05, 3 * sig));
  const ks = labOpts().map((l) => l.K);
  let lo = Math.min(S * (1 - w), ...ks.map((k) => k * 0.97)), hi = Math.max(S * (1 + w), ...ks.map((k) => k * 1.03));
  lo = Math.max(lo, 0);
  const xs = Array.from({ length: 181 }, (_, i) => lo + (hi - lo) * i / 180);
  const curves = [
    { label: f ? `At ${when} expiration` : "In 30 days", color: C.accent, main: true, pts: xs.map((x) => [x, labPnL(x, H)]) },
    { label: `Today${lab.shift ? ` (IV ${lab.shift > 0 ? "+" : "−"}${Math.abs(lab.shift)})` : ""}`, color: C.text, dash: "5 4", pts: xs.map((x) => [x, labPnL(x, 0)]) },
  ];
  if (lab.passed > 0 && lab.passed < H) curves.push({ label: dateOf(lab.passed), color: C.amber, dash: "2 3", pts: xs.map((x) => [x, labPnL(x, lab.passed)]) });
  $("labCapR").textContent = labLive() ? `${lab.ch.symbol}, ±1σ to ${when || "expiry"} shaded` : `±1σ to ${when || "expiry"} shaded`;
  payoffChart($("labChart"), {
    lo, hi, curves, ref: S, bes: st.bes, ticks: [...new Set(ks)].sort((a, b) => a - b),
    marks: [{ x: S, label: `${labLive() ? "Spot" : "Price"} ${px(S)}`, color: C.spotline, dash: "1 3", side: "end" }],
    band: [S * (1 - sig), S * (1 + sig)], bandLabel: `±1σ by ${when || "expiry"}`,
    probe: (x) => curves.map((c, i) => ({ label: c.label, color: c.color, v: labPnL(x, i === 0 ? H : i === 1 ? 0 : lab.passed) })),
  });

  // griegas netas
  const g = labGreeks();
  const gr = (t, v, line, hint) => `<div class="lab-g" title="${esc(hint)}"><span>${t}</span><b class="${v > 0.005 ? "up" : v < -0.005 ? "dn" : ""}">${(Math.abs(v) < 0.005 ? "" : v > 0 ? "+" : "−") + fmtNum(Math.abs(v), Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 1 ? 1 : 2)}</b><small>${line}</small></div>`;
  $("labGreeks").innerHTML =
    gr("Delta", g.delta, `${signedMoney(g.delta, 0)} per +$1; like ${fmtNum(Math.abs(g.delta), 0)} shares ${g.delta >= 0 ? "long" : "short"}`, "Shares-equivalent exposure to the underlying.") +
    gr("Gamma", g.gamma, "change in delta per +$1", "How fast delta changes when the underlying moves $1.") +
    gr("Theta", g.theta, `${signedMoney(g.theta, 0)} per day from time alone`, "What one day costs (or pays) if nothing else changes.") +
    gr("Vega", g.vega, `${signedMoney(g.vega, 0)} per +1 point of IV`, "Gain or loss if implied volatility rises one point on every leg.") +
    gr("Rho", g.rho, `${signedMoney(g.rho, 0)} per +1% in rates`, "Sensitivity to interest rates; small unless long-dated.");

  // matriz de escenarios
  const moves = [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2].map((k) => k * sig);
  const days = [0, H * 0.25, H * 0.5, H * 0.75, H];
  const vals = moves.map((mv) => days.map((d) => labPnL(S * (1 + mv), d)));
  const top = Math.max(1, ...vals.flat().map(Math.abs));
  const head = days.map((d, i) => `<th>${i === 0 ? "Today" : i === days.length - 1 && f ? when : dateOf(d)}</th>`).join("");
  $("labMatrix").innerHTML = `<table><thead><tr><th class="l">Price</th>${head}</tr></thead><tbody>${moves.map((mv, i) => `<tr class="${mv === 0 ? "now" : ""}"><td class="l"><b>${px(S * (1 + mv))}</b><small>${mv === 0 ? "unchanged" : `${mv > 0 ? "+" : "−"}${fmtNum(Math.abs(mv) * 100, 1)}%`}</small></td>${vals[i].map((v) => {
    const a = Math.min(1, Math.abs(v) / top);
    return `<td style="--a:${(0.06 + a * 0.5).toFixed(2)};--c:${v >= 0 ? C.put : C.call}">${signedMoney(v, 0)}</td>`;
  }).join("")}</tr>`).join("")}</tbody></table>`;
}
function renderLab() { if (lab.built) labDraw(); }
