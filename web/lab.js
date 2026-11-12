"use strict";
/* ============================================================ Options Lab (calculadora y estrategias en uno)
   Una o varias patas (opciones o acciones) valoradas por Black-Scholes-Merton, en dos modos:
   - Live: el ticker de la barra superior; cada pata sale de la cadena real (precio medio e IV de su contrato, carry
     del forward de su vencimiento).
   - Hypothetical: precio, tipo y dividendo inventados; cada pata con sus dias, strike e IV.
   Muestra lecturas (coste, maximos, puntos muertos, probabilidad), una frase con lo esencial, el P&L por precio al
   primer vencimiento, hoy y en la fecha elegida (con un cambio de IV), las griegas netas y una matriz de escenarios. */

/* Catalogo de estrategias por familia. Cada pata: [lado, tipo, strike en sigmas del movimiento a ~30 dias, opciones]
   (qty: contratos; far: vencimiento lejano). La galeria dibuja su perfil con el mismo modelo que el constructor. */
const LAB_CATS = [
  ["dir", "Directional", "Bet that the price will go up or down."],
  ["inc", "Income", "Earn premium by selling options."],
  ["vol", "Volatility", "Profit from how much the price moves, not where."],
  ["neu", "Neutral", "Profit if the price stays near a level."],
  ["hed", "Hedging", "Protect a stock position from losses."],
];
const LAB_STRATS = [
  ["dir", "lc", "Long call", "Buy a call: bet on a rise with limited risk.", "Bullish", [[1, "C", 0]]],
  ["dir", "lp", "Long put", "Buy a put: bet on a fall with limited risk.", "Bearish", [[1, "P", 0]]],
  ["dir", "bcs", "Bull call spread", "Buy a call, sell a higher one: a cheaper bet on a moderate rise, profit capped.", "Slightly bullish", [[1, "C", 0], [-1, "C", 0.6]]],
  ["dir", "bps", "Bear put spread", "Buy a put, sell a lower one: a cheaper bet on a moderate fall, profit capped.", "Slightly bearish", [[1, "P", 0], [-1, "P", -0.6]]],
  ["dir", "syl", "Synthetic long", "Long call plus short put: moves like owning the stock.", "Bullish", [[1, "C", 0], [-1, "P", 0]]],
  ["dir", "sys", "Synthetic short", "Long put plus short call: moves like shorting the stock.", "Bearish", [[1, "P", 0], [-1, "C", 0]]],
  ["inc", "sp", "Short put", "Sell a put: earn the premium if the price holds, or buy the stock cheaper.", "Slightly bullish", [[-1, "P", -0.6]]],
  ["inc", "sc", "Short call", "Sell a call: earn the premium if the price stays below the strike. Unlimited risk.", "Slightly bearish", [[-1, "C", 0.6]]],
  ["inc", "bups", "Bull put spread", "Sell a put, buy a lower one: earn premium if the price holds or rises.", "Slightly bullish", [[-1, "P", 0], [1, "P", -0.6]]],
  ["inc", "becs", "Bear call spread", "Sell a call, buy a higher one: earn premium if the price holds or falls.", "Slightly bearish", [[-1, "C", 0], [1, "C", 0.6]]],
  ["inc", "sstg", "Short strangle", "Sell a call and a put apart: earn premium if the price stays in a range. Unlimited risk.", "Range bound", [[-1, "C", 0.6], [-1, "P", -0.6]]],
  ["inc", "sstr", "Short straddle", "Sell a call and a put at one strike: most premium if the price does not move. Unlimited risk.", "Near strike", [[-1, "C", 0], [-1, "P", 0]]],
  ["inc", "ic", "Iron condor", "Sell two spreads: earn premium if the price stays in a range, with limited risk.", "Range bound", [[-1, "P", -0.6], [1, "P", -1.1], [-1, "C", 0.6], [1, "C", 1.1]]],
  ["inc", "ifly", "Iron butterfly", "Sell a straddle with wings: more premium, profit only near the strike.", "Near strike", [[-1, "P", 0], [-1, "C", 0], [1, "P", -0.8], [1, "C", 0.8]]],
  ["inc", "jl", "Jade lizard", "Short put plus a call spread: premium with no risk above.", "Slightly bullish", [[-1, "P", -0.6], [-1, "C", 0.6], [1, "C", 1.1]]],
  ["vol", "str", "Long straddle", "Buy a call and a put at one strike: bet on a big move either way.", "Either direction", [[1, "C", 0], [1, "P", 0]]],
  ["vol", "stg", "Long strangle", "Buy a call and a put apart: cheaper than a straddle, needs a bigger move.", "Either direction", [[1, "C", 0.6], [1, "P", -0.6]]],
  ["vol", "strap", "Strap", "Two calls plus a put: a big move, more likely up.", "Either direction", [[1, "C", 0, { qty: 2 }], [1, "P", 0]]],
  ["vol", "strip", "Strip", "Two puts plus a call: a big move, more likely down.", "Either direction", [[1, "C", 0], [1, "P", 0, { qty: 2 }]]],
  ["vol", "ric", "Reverse iron condor", "Buy two spreads: profit if the price leaves the range. Limited risk.", "Either direction", [[1, "P", -0.6], [-1, "P", -1.1], [1, "C", 0.6], [-1, "C", 1.1]]],
  ["neu", "fly", "Call butterfly", "Three call strikes: profit if the price ends near the middle one.", "Near strike", [[1, "C", -0.6], [-1, "C", 0, { qty: 2 }], [1, "C", 0.6]]],
  ["neu", "pfly", "Put butterfly", "Three put strikes: profit if the price ends near the middle one.", "Near strike", [[1, "P", 0.6], [-1, "P", 0, { qty: 2 }], [1, "P", -0.6]]],
  ["neu", "cal", "Call calendar", "Sell a near call, buy a later one: profit from time if the price stays near the strike.", "Near strike", [[-1, "C", 0], [1, "C", 0, { far: 1 }]]],
  ["neu", "pcal", "Put calendar", "Sell a near put, buy a later one: profit from time if the price stays near the strike.", "Near strike", [[-1, "P", 0], [1, "P", 0, { far: 1 }]]],
  ["hed", "pp", "Protective put", "Stock plus a put: insurance against a fall.", "Bullish", [[1, "S", 0], [1, "P", -0.6]]],
  ["hed", "cc", "Covered call", "Stock plus a short call: earn premium, give up the gains above the strike.", "Slightly bullish", [[1, "S", 0], [-1, "C", 0.6]]],
  ["hed", "col", "Collar", "Stock, a put below and a call sold above: protection paid by the call.", "Slightly bullish", [[1, "S", 0], [1, "P", -0.6], [-1, "C", 0.6]]],
  ["hed", "cp", "Covered put", "Short stock plus a short put: earn premium on a short position.", "Slightly bearish", [[-1, "S", 0], [-1, "P", -0.6]]],
].map(([cat, k, n, d, tag, legs]) => ({ cat, k, n, d, tag, legs }));
const labStrat = (k) => LAB_STRATS.find((s) => s.k === k);
const LAB_HYP = { S: 450, r: 4.5, q: 0, iv: 20 };

function labLoad(k, d) { try { const v = JSON.parse(store.get(k, "null")); return v == null ? d : v; } catch { return d; } }
const lab = {
  mode: store.get("labMode", "live") === "hyp" ? "hyp" : "live",
  hyp: Object.assign({}, LAB_HYP, labLoad("labHyp", {})),
  sym: "", ch: null, legs: [], hypLegs: null, passed: 0, shift: 0, ctrl: null, built: false, nid: 1,
  saved: labLoad("labLegs", {}), greek: store.get("labGreek", "none"), zoom: 1,
  page: store.get("labPage", "pick") === "build" ? "build" : "pick", strats: labLoad("labStrats", {}),
};
function labPage(p) {
  lab.page = p; store.set("labPage", p);
  $("labPick").hidden = p !== "pick"; $("labBuildPane").hidden = p !== "build";
  $("labView").classList.toggle("lab-on-build", p === "build");
  if (p === "pick") labGallery(); else labRender();
  window.scrollTo(0, 0);
}
// nombre de la estrategia de cada ticker (y de Hypothetical), junto a sus patas guardadas
const labKey = () => (labLive() ? lab.sym : "~hyp");
const labCur = () => lab.strats[labKey()] || "";
function labSetStrat(k) {
  const key = labKey(); delete lab.strats[key];
  if (k) lab.strats[key] = k;
  const ks = Object.keys(lab.strats); while (ks.length > 8) delete lab.strats[ks.shift()];
  store.set("labStrats", JSON.stringify(lab.strats));
}

/* ---------------------------------------------------------------- guardar (la nube corta cada preferencia a 2.000) */
const labPack = (l) => [l.side, l.qty, l.kind, l.exp || l.days, l.K, +(+l.iv).toFixed(4), +(+l.entry).toFixed(2), l.auto ? 1 : 0, l.off ? 1 : 0];
const labUnpack = (a, live) => ({ id: lab.nid++, side: a[0], qty: a[1], kind: a[2], [live ? "exp" : "days"]: a[3], K: a[4], iv: a[5], entry: a[6], auto: !!a[7], off: !!a[8] });
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
// patas activas: el ojo de la tabla saca una pata del grafico y de las cifras sin borrarla
const labOn = () => lab.legs.filter((l) => !l.off);
function labPnL(x, d) {
  let s = 0;
  for (const l of labOn()) s += l.side * l.qty * labMult(l) * (labValue(l, x, d) - l.entry);
  return s;
}
const labOpts = () => labOn().filter((l) => l.kind !== "S");
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
  const s = labStrat(p) || labStrat("lc");
  lab.legs = s.legs.map(([side, kind, k, o = {}]) => labLeg(side, kind, S * (1 + k * sig), { e: o.far ? far : e, days: o.far ? 60 : 30, qty: o.qty }));
  lab.passed = 0;
  labSetStrat(s.k);
  labSave();
  if (lab.page !== "build") labPage("build"); else labRender();
}

/* ---------------------------------------------------------------- galeria: perfil de cada estrategia al vencimiento */
function labShape(s) {
  const S = 100, v = 0.25, T = 30 / 365, sig = v * Math.sqrt(T), r = 0.03;
  const legs = s.legs.map(([side, kind, k, o = {}]) => {
    const K = S * (1 + k * sig), t = o.far ? 60 / 365 : T, qty = o.qty || 1;
    return { side, kind, K, t, qty, entry: kind === "S" ? S : BS.price(S, K, t, r, 0, v, kind === "C") };
  });
  const pnl = (x) => legs.reduce((a, l) => a + l.side * l.qty * ((l.kind === "S" ? x : l.t - T > 1e-9 ? BS.price(x, l.K, l.t - T, r, 0, v, l.kind === "C") : Math.max(0, l.kind === "C" ? x - l.K : l.K - x)) - l.entry), 0);
  const W = 200, H = 84, lo = S * (1 - 3.4 * sig), hi = S * (1 + 3.4 * sig), n = 120;
  const pts = Array.from({ length: n + 1 }, (_, i) => { const x = lo + (hi - lo) * i / n; return [x, pnl(x)]; });
  let ymax = Math.max(0, ...pts.map((p) => p[1])), ymin = Math.min(0, ...pts.map((p) => p[1]));
  const span = (ymax - ymin) || 1; ymax += span * 0.06; ymin -= span * 0.06;
  const X = (x) => ((x - lo) / (hi - lo)) * W, Y = (y) => 4 + ((ymax - y) / (ymax - ymin)) * (H - 8);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)} ${Y(p[1]).toFixed(1)}`).join("");
  const z = Y(0).toFixed(1), area = `${line}L${W} ${z}L0 ${z}Z`, id = `lsh-${s.k}`;
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <clipPath id="${id}u"><rect x="0" y="0" width="${W}" height="${z}"/></clipPath><clipPath id="${id}d"><rect x="0" y="${z}" width="${W}" height="${H}"/></clipPath>
    <line class="lsh-mid" x1="${W / 2}" x2="${W / 2}" y1="0" y2="${H}"/><line class="lsh-zero" x1="0" x2="${W}" y1="${z}" y2="${z}"/>
    <path class="lsh-a up" d="${area}" clip-path="url(#${id}u)"/><path class="lsh-a dn" d="${area}" clip-path="url(#${id}d)"/>
    <path class="lsh-l up" d="${line}" clip-path="url(#${id}u)"/><path class="lsh-l dn" d="${line}" clip-path="url(#${id}d)"/></svg>`;
}
const LAB_TAG = { Bullish: "up", "Slightly bullish": "up", Bearish: "dn", "Slightly bearish": "dn", "Range bound": "nt", "Near strike": "nt", "Either direction": "vo" };
function labGallery() {
  const cur = lab.legs.length ? (labStrat(labCur())?.n || "Custom strategy") : "";
  $("labPick").innerHTML = `
    <div class="lab-pick-head"><div><h2>Strategies${lab.sym && labLive() ? ` for ${esc(lab.sym)}` : ""}</h2>
      <p>Pick a ready-made strategy and adjust it, or build one from scratch. Strikes start around the expected move to the nearest monthly expiration.</p></div>
      <div class="lab-pick-go">${cur ? `<button type="button" class="lab-pill on" data-a="resume">Back to ${esc(cur)}</button>` : ""}<button type="button" class="lab-pill" data-a="scratch">Build from scratch</button></div></div>
    ${LAB_CATS.map(([c, t, d]) => `<section class="lab-fam"><h3>${t}</h3><p>${d}</p><div class="lab-cards">${LAB_STRATS.filter((s) => s.cat === c).map((s) => `
      <button type="button" class="lab-card${s.k === labCur() && lab.legs.length ? " cur" : ""}" data-p="${s.k}">
        <span class="lab-shape">${labShape(s)}</span><b>${s.n}</b><span class="lab-cd">${s.d}</span><i class="lab-tag ${LAB_TAG[s.tag] || ""}">${s.tag}</i></button>`).join("")}</div></section>`).join("")}`;
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
  const cost = labOn().reduce((s, l) => s + l.side * l.qty * labMult(l) * l.entry, 0);
  const now = labOn().reduce((s, l) => s + l.side * l.qty * labMult(l) * labValue(l, S, 0), 0);
  return { mx: slope >= 1 ? Infinity : mx, mn: slope <= -1 ? -Infinity : mn, bes, pop, zones, cost, now, H, first: f };
}
// griega de la posicion con el subyacente en x, d dias despues de hoy (para el grafico)
function labGreekAt(x, d, k) {
  let s = 0;
  for (const l of labOn()) {
    const n = l.side * l.qty * labMult(l);
    if (l.kind === "S") { if (k === "delta") s += n; continue; }
    s += n * BS.greeks(x, l.K, Math.max(labDays(l) - d, 0) / 365, labR(), labQ(l), Math.max(l.iv + lab.shift / 100, 0.005), l.kind === "C")[k];
  }
  return s;
}
function labGreeks() {
  const g = { delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0 };
  for (const l of labOn()) {
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
  <div id="labPick" class="lab-pick"></div>
  <div id="labBuildPane" class="lab-build">
  <div class="lab-stick">
  <div class="lab-bhead">
    <button type="button" class="lab-back" data-a="pick" aria-label="Back to strategies"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
    <span class="lab-bshape" id="labBShape"></span>
    <div><h2 id="labName"></h2><p id="labDesc"></p></div>
  </div>
  <div class="lab-stats" id="labRead"></div>
  </div>
  <section class="lab-panel lab-plot">
    <div class="lab-tools">
      <details class="lab-dd" id="labWhatIf"><summary>What-if<b id="labWhatV"></b></summary>
        <div class="lab-pop">
          <div class="lab-wi"><div class="lab-wi-h"><span>Date</span><b id="labPassedV"></b></div>
            <div class="lab-chips" id="labDateChips"></div>
            <input type="range" class="lab-range" id="labPassed" min="0" max="30" step="1" value="0" aria-label="Days from today"></div>
          <div class="lab-wi"><div class="lab-wi-h"><span>Implied volatility</span><b id="labShiftV"></b></div>
            <div class="lab-chips" id="labIvChips">${[-10, -5, 0, 5, 10].map((v) => `<button type="button" data-iv="${v}">${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v) || "Now"}</button>`).join("")}</div>
            <input type="range" class="lab-range" id="labShift" min="-20" max="20" step="1" value="0" aria-label="Change in implied volatility, points"></div>
          <button type="button" class="lab-pill" id="labWhatReset">Back to today</button>
        </div></details>
      <details class="lab-dd" id="labGreekDd"><summary>Greek<b id="labGreekV"></b></summary>
        <div class="lab-pop lab-opts">${[["none", "None"], ["delta", "Delta"], ["gamma", "Gamma"], ["theta", "Theta"], ["vega", "Vega"]].map(([k, t]) => `<button type="button" data-g="${k}">${t}</button>`).join("")}<small>Drawn on the right axis, for the whole position.</small></div></details>
      <span class="lab-legend lab-tleg" id="labLegend"></span>
      <span class="lab-tools-r"><span id="labCapR"></span>
        <span class="lab-zoom" role="group" aria-label="Zoom"><button type="button" data-z="out" aria-label="Zoom out">−</button><button type="button" data-z="in" aria-label="Zoom in">+</button><button type="button" data-z="reset" aria-label="Reset zoom"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 8a5 5 0 1 0 1.6-3.7M3 2.5v2.8h2.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button></span></span>
    </div>
    <div class="lab-chart" id="labChart" role="img" aria-label="Position profit and loss by underlying price"></div>
  </section>
  <section class="lab-panel lab-legs-panel">
    <div class="lab-tablewrap"><table class="lab-tbl" id="labLegs"></table></div>
    <div class="lab-legs-foot"><button type="button" class="lab-pill on" data-a="add">+ Add position</button><span>Long/Short and Call/Put switch on click; the eye leaves a leg out of the chart and the figures.</span></div>
  </section>
  <p class="lab-say" id="labSay"></p>
  <section class="lab-panel">
    <div class="lab-cap"><span>Scenarios</span><span>P&amp;L by price move and date, with the volatility change above</span></div>
    <div class="re-matrix" id="labMatrix"></div>
  </section>
  </div>
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
  $("labPick").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b || (labLive() && !lab.ch)) return;
    if (b.dataset.p) labPreset(b.dataset.p);
    else if (b.dataset.a === "resume") labPage("build");
    else if (b.dataset.a === "scratch") { lab.legs = []; lab.passed = 0; labSetStrat(""); labSave(); labPage("build"); }
  });
  $("labBuildPane").querySelector(".lab-back").addEventListener("click", () => labPage("pick"));
  $("labPassed").addEventListener("input", (e) => { lab.passed = +e.target.value; labDraw(); });
  $("labWhatIf").addEventListener("click", (e) => {
    const b = e.target.closest("[data-d], [data-iv]"); if (!b) return;
    if (b.dataset.d != null) lab.passed = +b.dataset.d; else { lab.shift = +b.dataset.iv; $("labShift").value = String(lab.shift); }
    labDraw();
  });
  // la cabecera con las cifras se queda fija al bajar; compacta mientras esta pegada
  const stick = $("labBuildPane").querySelector(".lab-stick");
  window.addEventListener("scroll", () => {
    if (lab.page !== "build" || state.mode !== "lab") return;
    stick.classList.toggle("stuck", stick.getBoundingClientRect().top <= parseFloat(getComputedStyle(stick).top) + 1);
  }, { passive: true });
  $("labWhatReset").addEventListener("click", () => { lab.passed = 0; lab.shift = 0; $("labShift").value = "0"; labDraw(); });
  $("labGreekDd").addEventListener("click", (e) => {
    const b = e.target.closest("[data-g]"); if (!b) return;
    lab.greek = b.dataset.g; store.set("labGreek", lab.greek); $("labGreekDd").open = false; labDraw();
  });
  $("labBuildPane").querySelector(".lab-zoom").addEventListener("click", (e) => {
    const b = e.target.closest("[data-z]"); if (!b) return;
    lab.zoom = b.dataset.z === "reset" ? 1 : Math.min(4, Math.max(0.25, lab.zoom * (b.dataset.z === "in" ? 1 / 1.4 : 1.4)));
    labDraw();
  });
  // los desplegables se cierran al pulsar fuera
  document.addEventListener("click", (e) => { if (!e.target.isConnected) return; for (const d of document.querySelectorAll(".lab-dd[open]")) if (!d.contains(e.target)) d.open = false; });
  $("labShift").addEventListener("input", (e) => { lab.shift = +e.target.value; labDraw(); });
  const legs = $("labBuildPane").querySelector(".lab-legs-panel");
  legs.addEventListener("click", (e) => {
    const b = e.target.closest("[data-a]"); if (!b) return;
    if (b.dataset.a === "add") {
      const last = lab.legs[lab.legs.length - 1];
      lab.legs.push(labLeg(1, "C", labS(), labLive() ? { e: last && last.kind !== "S" ? labExp(last) : expNear(lab.ch, 30) } : { days: last && last.kind !== "S" ? last.days : 30 }));
      labSetStrat(""); labSave(); labRender(); return;
    }
    const i = lab.legs.findIndex((l) => l.id === +b.closest("[data-id]").dataset.id); if (i < 0) return;
    const l = lab.legs[i];
    if (b.dataset.a === "off") { l.off = !l.off; labSave(); labRender(); return; }
    if (b.dataset.a === "side") l.side = -l.side;
    else if (b.dataset.a === "del") lab.legs.splice(i, 1);
    else if (b.dataset.a === "kind") {
      const nk = { C: "P", P: "S", S: "C" }[l.kind];
      const o = labLive() ? { e: l.kind !== "S" ? labExp(l) : expNear(lab.ch, 30) } : { days: l.days || 30 };
      lab.legs[i] = Object.assign(labLeg(l.side, nk, l.K || labS(), { ...o, qty: l.kind === "S" ? 1 : l.qty }), { id: l.id });
    }
    labSetStrat(""); labSave(); labRender();
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
    labAuto(); labSync(); labShowPage(); setStatus("", "");
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
  if (!labLive()) { if (!lab.legs.length || lab.legs.some((l) => l.exp)) labSetMode("hyp"); else labShowPage(); return; }
  const sym = state.symbol || "SPX";
  $("symbol").value = sym;
  if (!lab.ch || lab.sym !== sym) loadLab(); else { labShowPage(); setStatus("", labStatus()); }
}
// sin patas solo tiene sentido la galeria, salvo si se empieza de cero
function labShowPage() { labPage(lab.legs.length || (lab.page === "build" && labCur() === "") ? lab.page : "pick"); }
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
    }
    labShowPage();
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
  if (lab.page !== "build") { labGallery(); return; }
  const st0 = labStrat(labCur());
  $("labName").textContent = st0 ? st0.n : "Custom strategy";
  $("labDesc").textContent = st0 ? st0.d : "Your own combination of legs. Add, remove or change any of them below.";
  $("labBShape").innerHTML = st0 ? labShape(st0) : "";
  $("labSym").innerHTML = labLive() ? spotLabel(lab.ch) : `Hypothetical underlying at ${px(lab.hyp.S)}`;
  const live = labLive() ? lab.ch.live.slice(0, 40) : [];
  const num = (f, v, label, w = "") => `<input class="lab-in ${w}" data-f="${f}" value="${esc(v)}" inputmode="decimal" aria-label="${label}">`;
  const S = labS(), dash = `<span class="lab-dim">—</span>`;
  const gk = (v, d = 2) => (isFinite(v) ? (v < -1e-9 ? "−" : "") + fmtNum(Math.abs(v), d) : "—");
  const rows = lab.legs.map((l) => {
    const isS = l.kind === "S", call = l.kind === "C";
    let when = dash, strike = dash, q = null;
    if (!isS && labLive()) {
      const e = labExp(l), ks = strikesOf(lab.ch, e.i).filter((k) => Math.abs(k / lab.ch.spot - 1) < 0.35 || k === l.K);
      when = `<select class="lab-in" data-f="exp" aria-label="Expiration">${live.map((x) => `<option value="${x.key}" ${x.key === l.exp ? "selected" : ""}>${shortDate(x.iso)}, ${fmtNum(Math.max(x.days, 0), x.days < 1 ? 1 : 0)}d</option>`).join("")}</select>`;
      strike = `<select class="lab-in" data-f="K" aria-label="Strike">${ks.map((k) => `<option value="${k}" ${k === l.K ? "selected" : ""}>${fmtNum(k, 2)}</option>`).join("")}</select>`;
      q = lab.ch.rows.find((y) => y.e === e.i && y.K === l.K && y.call === call);
    } else if (!isS) {
      when = `<span class="lab-unit">${num("days", l.days, "Days to expiration")}<i>days</i></span>`;
      strike = num("K", l.K, "Strike");
    }
    const T = isS ? 0 : Math.max(labDays(l), 0) / 365;
    const g = isS ? { price: S, delta: 1, gamma: 0, vega: 0, theta: 0, rho: 0 } : BS.greeks(S, l.K, T, labR(), labQ(l), Math.max(l.iv + lab.shift / 100, 0.005), call);
    const pnl = l.side * l.qty * labMult(l) * (labValue(l, S, 0) - l.entry);
    return `<tr class="${l.off ? "off" : ""}" data-id="${l.id}">
      <td class="lab-ks">${strike}</td>
      <td><button type="button" class="lab-chip kind" data-a="kind" title="Call, put or shares">${{ C: "Call", P: "Put", S: "Shares" }[l.kind]}</button></td>
      <td class="lab-ex">${when}</td>
      <td><button type="button" class="lab-chip ${l.side > 0 ? "long" : "short"}" data-a="side" title="Switch between long and short">${l.side > 0 ? "Long" : "Short"}</button></td>
      <td class="n">${num("qty", l.qty, isS ? "Shares" : "Contracts", "qty")}</td>
      <td class="n">${num("entry", fmtNum(l.entry, 2).replace(/,/g, ""), "Entry price")}</td>
      <td class="n">${isS ? dash : `<span class="lab-unit">${num("iv", +(l.iv * 100).toFixed(1), "Implied volatility (%)")}<i>%</i></span>`}</td>
      <td class="n ${pnl > 0.5 ? "up" : pnl < -0.5 ? "dn" : ""}">${signedMoney(pnl, 0)}</td>
      <td class="n">${gk(g.delta)}</td>
      <td class="n">${fmtNum(g.price, 2)}</td>
      <td class="n">${q ? fmtNum(q.bid, 2) : "—"}</td>
      <td class="n">${q ? fmtNum(q.ask, 2) : "—"}</td>
      <td class="n">${gk(g.gamma, 3)}</td>
      <td class="n">${gk(g.vega)}</td>
      <td class="n">${gk(g.theta)}</td>
      <td class="n">${gk(g.rho)}</td>
      <td class="lab-act"><button type="button" class="lab-ico${l.off ? " on" : ""}" data-a="off" aria-label="${l.off ? "Show" : "Hide"} this leg" title="${l.off ? "Show" : "Hide"} this leg"><svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" stroke-width="1.4"/></svg></button><button type="button" class="lab-ico del" data-a="del" aria-label="Remove leg" title="Remove leg"><svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg></button></td>
    </tr>`;
  }).join("");
  const th = ["Strike", "Type", "Expiration", "Side", "Size", "Price", "IV", "P&amp;L", "Delta", "Theor.", "Bid", "Ask", "Gamma", "Vega", "Theta", "Rho", ""];
  $("labLegs").innerHTML = `<thead><tr>${th.map((t, i) => `<th class="${i >= 4 && i < 16 ? "n" : ""}">${t}</th>`).join("")}</tr></thead>
    <tbody>${rows || `<tr><td colspan="${th.length}" class="re-empty">Pick a strategy, or add a position.</td></tr>`}</tbody>`;
  labDraw();
}

function labDraw() {
  if (labLive() && !lab.ch) return;
  const S = labS();
  const st = labOn().length ? labStats() : null;
  const H = st ? st.H : 30;
  const ps = $("labPassed"), maxD = Math.max(1, Math.floor(H));
  ps.max = String(maxD);
  if (lab.passed > maxD) lab.passed = maxD;
  ps.value = String(lab.passed);
  const dateOf = (d) => { const t = new Date(Date.now() + d * 86400000); return `${MESES[t.getMonth()]} ${t.getDate()}`; };
  $("labPassedV").textContent = lab.passed ? `${dateOf(lab.passed)}, in ${lab.passed} ${lab.passed === 1 ? "day" : "days"}` : "Today";
  $("labShiftV").textContent = lab.shift ? `${lab.shift > 0 ? "+" : "−"}${Math.abs(lab.shift)} points` : "As now";
  ps.style.setProperty("--p", `${(lab.passed / maxD) * 100}%`);
  $("labShift").style.setProperty("--p", `${((lab.shift + 20) / 40) * 100}%`);
  const dd = [...new Set([0, 1, 7, 14, 30, maxD].filter((d) => d <= maxD))];
  $("labDateChips").innerHTML = dd.map((d) => `<button type="button" data-d="${d}" aria-pressed="${d === lab.passed}">${d === 0 ? "Today" : d === maxD ? "Expiry" : d === 1 ? "Tomorrow" : d === 7 ? "1 week" : d === 14 ? "2 weeks" : "1 month"}</button>`).join("");
  for (const b of $("labIvChips").children) b.setAttribute("aria-pressed", String(+b.dataset.iv === lab.shift));
  document.documentElement.style.setProperty("--lab-top", `${document.querySelector("header.bar")?.offsetHeight || 0}px`);
  $("labWhatV").textContent = lab.passed || lab.shift ? [lab.passed ? dateOf(lab.passed) : "", lab.shift ? `IV ${lab.shift > 0 ? "+" : "−"}${Math.abs(lab.shift)}` : ""].filter(Boolean).join(", ") : "";
  $("labWhatIf").classList.toggle("set", !!(lab.passed || lab.shift));
  $("labGreekV").textContent = lab.greek !== "none" ? lab.greek[0].toUpperCase() + lab.greek.slice(1) : "";
  $("labGreekDd").classList.toggle("set", lab.greek !== "none");
  for (const b of $("labGreekDd").querySelectorAll("[data-g]")) b.setAttribute("aria-pressed", String(b.dataset.g === lab.greek));
  if (!st) { for (const id of ["labRead", "labSay", "labChart", "labMatrix", "labCapR"]) $(id).innerHTML = ""; return; }

  const when = st.first ? labWhen(st.first) : "";
  const g = labGreeks(), nb = st.bes.length ? st.bes.reduce((m, x) => (Math.abs(x - S) < Math.abs(m - S) ? x : m)) / S - 1 : null;
  const it = (t, v, cls = "", hint = "") => `<div class="lab-st ${cls}"${hint ? ` title="${esc(hint)}"` : ""}><span>${t}</span><b>${v}</b></div>`;
  const gv = (v) => (Math.abs(v) < 0.005 ? "0" : (v > 0 ? "" : "−") + fmtNum(Math.abs(v), Math.abs(v) >= 100 ? 0 : 2));
  $("labRead").innerHTML =
    it(st.cost >= 0 ? "Net debit" : "Net credit", money(Math.abs(st.cost), 0), st.cost >= 0 ? "dn" : "up", st.now >= 0 ? `Worth ${money(st.now, 0)} now` : `${money(-st.now, 0)} to close now`) +
    it("Max loss", st.mn === -Infinity ? "Unlimited" : money(st.mn, 0), "dn", when ? `At the ${when} expiration` : "") +
    it("Max profit", st.mx === Infinity ? "Unlimited" : money(st.mx, 0), "up", when ? `At the ${when} expiration` : "") +
    it("Win rate", st.pop == null ? "—" : `${fmtNum(st.pop * 100, 1)}%`, "", "Chance of ending in profit at the first expiration, implied by the option prices") +
    it(st.bes.length > 1 ? "Breakevens" : "Breakeven", st.bes.length ? st.bes.slice(0, 2).map(px).join(" / ") + (st.bes.length > 2 ? "…" : "") : "None") +
    it("To breakeven", nb == null ? "—" : `${nb >= 0 ? "+" : "−"}${fmtNum(Math.abs(nb) * 100, 2)}%`, "", "Move from the price now to the nearest breakeven") +
    it(labLive() ? "Underlying price" : "Price", `${px(S)}${labLive() ? " <small>USD</small>" : ""}`) +
    it("Delta", gv(g.delta), "", `Like ${fmtNum(Math.abs(g.delta), 0)} shares ${g.delta >= 0 ? "long" : "short"}`) +
    it("Gamma", gv(g.gamma), "", "Change in delta when the underlying moves $1") +
    it("Theta", gv(g.theta), "", `${signedMoney(g.theta, 0)} a day from time alone`) +
    it("Vega", gv(g.vega), "", `${signedMoney(g.vega, 0)} per +1 point of implied volatility`) +
    it("Rho", gv(g.rho), "", `${signedMoney(g.rho, 0)} per +1% in rates`);
  $("labSay").innerHTML = labSentence(st);

  // grafico: rango de +-3 sigma alrededor del precio, con el zoom de la barra
  const f = st.first;
  const sig = f ? labAtmIV(f) * Math.sqrt(Math.max(labDays(f), 1 / 24) / 365) : 0.05;
  const w = Math.min(0.6, Math.max(0.05, 3 * sig));
  const ks = labOpts().map((l) => l.K);
  let lo = Math.min(S * (1 - w), ...ks.map((k) => k * 0.97)), hi = Math.max(S * (1 + w), ...ks.map((k) => k * 1.03));
  lo = Math.max(0, S - (S - lo) * lab.zoom); hi = S + (hi - S) * lab.zoom;
  $("labCapR").textContent = labLive() ? `${lab.ch.symbol} to the ${when || "first"} expiration` : `To the ${when || "first"} expiration`;
  labPlot({ S, H, lo, hi, f, when, ks, bes: st.bes, dateOf });

  // matriz de escenarios
  const stepP = [0.5, 1, 2, 2.5, 5, 10, 15, 20].reduce((a, b) => (Math.abs(b - sig * 50) < Math.abs(a - sig * 50) ? b : a));
  const moves = [-4, -3, -2, -1, 0, 1, 2, 3, 4].map((k) => k * stepP / 100);
  const days = [0, H * 0.25, H * 0.5, H * 0.75, H];
  const vals = moves.map((mv) => days.map((d) => labPnL(S * (1 + mv), d)));
  const top = Math.max(1, ...vals.flat().map(Math.abs));
  const head = days.map((d, i) => `<th>${i === 0 ? "Today" : i === days.length - 1 && f ? when : dateOf(d)}</th>`).join("");
  $("labMatrix").innerHTML = `<table><thead><tr><th class="l">Price</th>${head}</tr></thead><tbody>${moves.map((mv, i) => `<tr class="${mv === 0 ? "now" : ""}"><td class="l"><b>${px(S * (1 + mv))}</b><small>${mv === 0 ? "unchanged" : `${mv > 0 ? "+" : "−"}${fmtNum(Math.abs(mv) * 100, Math.round(Math.abs(mv) * 1000) % 10 ? 1 : 0)}%`}</small></td>${vals[i].map((v) => {
    const a = Math.min(1, Math.abs(v) / top);
    return `<td style="--a:${(0.06 + a * 0.5).toFixed(2)};--c:${v >= 0 ? C.put : C.call}">${signedMoney(v, 0)}</td>`;
  }).join("")}</tr>`).join("")}</tbody></table>`;
}
/* grafico del constructor: P&L al vencimiento con su zona de ganancia y de perdida, hoy (discontinua), la fecha
   del What-if y, si se elige, una griega en el eje derecho. Al pasar el raton: P&L, precio y probabilidad a cada lado */
function labPlot(o) {
  const box = $("labChart");
  // alto: lo que deja libre la ventana para ver cabecera, cifras, grafico y patas sin bajar (como un terminal)
  const W = Math.max(320, box.clientWidth), H = labFitH(W);
  const gk = lab.greek !== "none" ? lab.greek : null;
  const pad = { l: 64, r: gk ? 60 : 18, t: 22, b: 36 };
  const n = 240, xs = Array.from({ length: n + 1 }, (_, i) => o.lo + (o.hi - o.lo) * i / n);
  const wi = lab.passed > 0 && lab.passed < o.H;
  const exp = xs.map((x) => [x, labPnL(x, o.H)]), now = xs.map((x) => [x, labPnL(x, 0)]), mid = wi ? xs.map((x) => [x, labPnL(x, lab.passed)]) : null;
  let y0 = 0, y1 = 0;
  for (const c of [exp, now, mid]) if (c) for (const p of c) if (isFinite(p[1])) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
  const sp = (y1 - y0) || 1; y0 -= sp * 0.06; y1 += sp * 0.08;
  const X = scale(o.lo, o.hi, pad.l, W - pad.r), Y = scale(y0, y1, H - pad.b, pad.t), zy = Y(0), ax = H - pad.b;
  const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
  const xt = axisTicks(o.lo, o.hi, Math.max(4, Math.round(W / 90))), yt = axisTicks(y0, y1, 7);
  const xdec = o.hi - o.lo < 8 ? 2 : o.hi - o.lo < 40 ? 1 : 0;
  const line = pathOf(exp, X, Y), area = `${line}L${X(o.hi).toFixed(1)},${zy.toFixed(1)}L${X(o.lo).toFixed(1)},${zy.toFixed(1)}Z`;
  let gpart = "", G = null, gpts = null;
  if (gk) {
    gpts = xs.map((x) => [x, labGreekAt(x, wi ? lab.passed : 0, gk)]);
    let g0 = Math.min(0, ...gpts.map((p) => p[1])), g1 = Math.max(0, ...gpts.map((p) => p[1]));
    const gs = (g1 - g0) || 1; g0 -= gs * 0.08; g1 += gs * 0.08;
    G = scale(g0, g1, ax, pad.t);
    gpart = `<path d="${pathOf(gpts, X, G)}" fill="none" stroke="${C.pos}" stroke-width="1.6" stroke-dasharray="1 3" stroke-linecap="round"/>` +
      axisTicks(g0, g1, 6).map((v) => `<text x="${W - pad.r + 8}" y="${G(v) + 4}" fill="${C.pos}" font-size="11">${fmtNum(v, Math.abs(g1 - g0) < 0.1 ? 3 : Math.abs(g1 - g0) < 10 ? 2 : 0)}</text>`).join("");
  }
  const strikes = [...new Set(o.ks)].filter((k) => k >= o.lo && k <= o.hi).map((k) => `<path d="M${X(k)} ${ax - 6}l-4 6h8z" fill="${C.faint}"><title>Strike ${fmtNum(k, 2)}</title></path>`).join("");
  const bes = o.bes.filter((x) => x >= o.lo && x <= o.hi).map((x) => `<circle cx="${X(x)}" cy="${zy}" r="4" fill="${C.surface}" stroke="${C.text}" stroke-width="1.6"><title>Breakeven ${px(x)}</title></circle>`).join("");
  const sx = X(o.S);
  box.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${LAB_MONO}">
    <defs><clipPath id="lpUp"><rect x="${pad.l}" y="0" width="${pw}" height="${Math.max(0, zy)}"/></clipPath><clipPath id="lpDn"><rect x="${pad.l}" y="${zy}" width="${pw}" height="${Math.max(0, H - zy)}"/></clipPath><clipPath id="lpPl"><rect x="${pad.l}" y="${pad.t}" width="${pw}" height="${ph}"/></clipPath></defs>
    ${yt.map((v) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="${C.grid}" stroke-width="1"/><text x="${pad.l - 10}" y="${Y(v) + 4}" fill="${C.faint}" font-size="11" text-anchor="end">${fmtNum(v, Math.abs(y1 - y0) < 20 ? 2 : 0)}</text>`).join("")}
    ${xt.map((v) => `<line x1="${X(v)}" x2="${X(v)}" y1="${pad.t}" y2="${ax}" stroke="${C.grid}" stroke-width="1" stroke-dasharray="2 4"/><text x="${X(v)}" y="${ax + 20}" fill="${C.faint}" font-size="11" text-anchor="middle">${fmtNum(v, xdec)}</text>`).join("")}
    <path d="${area}" fill="${C.put}" opacity=".16" clip-path="url(#lpUp)"/><path d="${area}" fill="${C.call}" opacity=".14" clip-path="url(#lpDn)"/>
    <line x1="${pad.l}" x2="${W - pad.r}" y1="${zy}" y2="${zy}" stroke="${C.muted}" stroke-width="1"/>
    ${o.S >= o.lo && o.S <= o.hi ? `<line x1="${sx}" x2="${sx}" y1="${pad.t}" y2="${ax}" stroke="${C.text}" stroke-width="1" stroke-dasharray="3 3" opacity=".55"/><text x="${sx}" y="${pad.t - 7}" fill="${C.muted}" font-size="11" text-anchor="middle">${px(o.S)}</text>` : ""}
    <g clip-path="url(#lpPl)">
      ${gpart}
      ${mid ? `<path d="${pathOf(mid, X, Y)}" fill="none" stroke="${C.amber}" stroke-width="1.6" stroke-dasharray="6 4"/>` : ""}
      <path d="${pathOf(now, X, Y)}" fill="none" stroke="${C.accent}" stroke-width="1.8" stroke-dasharray="3 4" stroke-linecap="round"/>
      <path d="${line}" fill="none" stroke="${C.put}" stroke-width="2.4" stroke-linejoin="round" clip-path="url(#lpUp)"/>
      <path d="${line}" fill="none" stroke="${C.call}" stroke-width="2.4" stroke-linejoin="round" clip-path="url(#lpDn)"/>
    </g>
    ${strikes}${bes}
    <g id="lpProbe" visibility="hidden"><line y1="${pad.t}" y2="${ax}" stroke="${C.muted}" stroke-width="1"/></g>
  </svg>`;
  $("labLegend").innerHTML = `
    <span><i style="background:linear-gradient(90deg, ${C.call} 50%, ${C.put} 50%)"></i>At ${o.when || "first"} expiration</span>
    <span><i class="dash" style="border-color:${C.accent}"></i>Today${lab.shift ? ` (IV ${lab.shift > 0 ? "+" : "−"}${Math.abs(lab.shift)})` : ""}</span>
    ${mid ? `<span><i class="dash" style="border-color:${C.amber}"></i>${o.dateOf(lab.passed)}</span>` : ""}
    ${gk ? `<span><i class="dash" style="border-color:${C.pos}"></i>${gk[0].toUpperCase() + gk.slice(1)} (right axis)</span>` : ""}
    ${o.bes.length ? `<span><i class="be lab-be"></i>Breakeven</span>` : ""}${o.ks.length ? `<span><i class="tk"></i>Strikes</span>` : ""}`;
  box._g = { X, Y, G, pad, o, gk, wi, ax };
  if (!box._on) {
    box._on = true;
    box.addEventListener("mousemove", (e) => labProbe(box, e));
    box.addEventListener("mouseleave", () => labProbe(box, null));
  }
}
function labFitH(W) {
  const q = (sel) => { const e = document.querySelector(sel); return e && !e.hidden ? e.offsetHeight : 0; };
  const stick = document.querySelector(".lab-stick");
  if (stick && !stick.classList.contains("stuck")) lab.stickH = stick.offsetHeight;
  const used = q("header.bar") + q("#labView .lab-head") + q("#labHyp") + (lab.stickH || 0) + q(".lab-tools") + q(".lab-legs-panel") + 84;
  const fit = window.innerHeight - used;
  return Math.round(Math.max(260, Math.min(W < 700 ? 360 : 640, fit)));
}
function labProbe(box, e) {
  const g = box._g, pr = g && box.querySelector("#lpProbe");
  if (!pr) return;
  const svg = box.querySelector("svg"), mx = e ? e.clientX - svg.getBoundingClientRect().left : -1;
  if (!e || mx < g.pad.l || mx > g.X(g.o.hi)) { pr.setAttribute("visibility", "hidden"); toolTip(box, null); return; }
  const x = g.X.inv(mx), o = g.o;
  const rows = [{ t: "Current P&L", v: labPnL(x, 0), c: C.accent }];
  if (g.wi) rows.push({ t: `P&L on ${o.dateOf(lab.passed)}`, v: labPnL(x, lab.passed), c: C.amber });
  const ve = labPnL(x, o.H);
  rows.push({ t: "Expiration P&L", v: ve, c: ve >= 0 ? C.put : C.call });
  pr.setAttribute("visibility", "visible");
  const ln = pr.querySelector("line"); ln.setAttribute("x1", mx); ln.setAttribute("x2", mx);
  pr.querySelectorAll("circle").forEach((c) => c.remove());
  for (const r of rows) {
    const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    c.setAttribute("cx", mx); c.setAttribute("cy", g.Y(r.v)); c.setAttribute("r", "4"); c.setAttribute("fill", r.c);
    c.setAttribute("stroke", C.surface); c.setAttribute("stroke-width", "1.5");
    pr.appendChild(c);
  }
  let prob = "";
  if (o.f) {
    const T = Math.max(o.H, 1 / 24) / 365, up = BS.probAbove(o.S, x, T, labR(), labQ(o.f), Math.max(labAtmIV(o.f) + lab.shift / 100, 0.005));
    prob = `<div class="lt-p"><span>← ${fmtNum((1 - up) * 100, 1)}%</span><span>${fmtNum(up * 100, 1)}% →</span></div><div class="lt-s">Chance of ending below or above, ${o.when}</div>`;
  }
  const gr = g.gk ? `<div class="lt-r"><span><i style="background:${C.pos}"></i>${g.gk[0].toUpperCase() + g.gk.slice(1)}</span><b>${fmtNum(labGreekAt(x, g.wi ? lab.passed : 0, g.gk), 2)}</b></div>` : "";
  toolTip(box, `<div class="lab-tt">${rows.map((r) => `<div class="lt-r"><span><i style="background:${r.c}"></i>${r.t}</span><b class="${r.v > 0 ? "up" : r.v < 0 ? "dn" : ""}">${signedMoney(r.v, 2)}</b></div>`).join("")}${gr}
    <div class="lt-x"><b>${px(x)}</b><span>Underlying price, ${x >= o.S ? "+" : "−"}${fmtNum(Math.abs(x / o.S - 1) * 100, 2)}%</span></div>${prob}</div>`,
  mx, Math.min(...rows.map((r) => g.Y(r.v))));
}
function renderLab() { if (lab.built) labDraw(); }
