"use strict";
/* ============================================================ Strike Studio (Options Calculator)
   Una opcion (call o put, compra o venta) por Black-Scholes-Merton. El formulario es una frase editable; debajo, el
   P&L por precio (al vencimiento, hoy y en una fecha intermedia), las griegas traducidas a dolares de la posicion y
   el resumen (coste, punto muerto, maximos y probabilidad de ganar). Puede tomar el precio, el tipo, el forward y la
   IV de la cadena real de un ticker (/api/chain). */

const CALC_DEF = { side: 1, qty: 1, call: true, S: 450, K: 455, days: 30, iv: 20, r: 4.5, q: 0, entry: null, passed: 0, shift: 0 };
const calc = {
  st: (() => { try { return Object.assign({}, CALC_DEF, JSON.parse(store.get("calc", "{}")), { passed: 0, shift: 0 }); } catch { return { ...CALC_DEF }; } })(),
  link: null,        // {sym, ch, ei}: datos de mercado enlazados
  built: false, saveT: null,
};

function calcSave() {
  clearTimeout(calc.saveT);
  calc.saveT = setTimeout(() => { const { passed, shift, ...keep } = calc.st; store.set("calc", JSON.stringify(keep)); }, 600);
}

function calcStep(S) { return S >= 2000 ? 5 : S >= 500 ? 1 : S >= 100 ? 0.5 : S >= 20 ? 0.5 : 0.1; }
function calcRoundK(x) {
  if (calc.link) return nearestStrike(strikesOf(calc.link.ch, calc.link.ei), x);
  const s = calcStep(calc.st.S);
  return +(Math.round(x / s) * s).toFixed(2);
}

/* ---------------------------------------------------------------- calculo */
function calcModel() {
  const s = calc.st;
  const T = Math.max(s.days, 0) / 365, r = s.r / 100, q = s.q / 100, v = Math.max(s.iv, 0.1) / 100;
  const g = BS.greeks(s.S, s.K, T, r, q, v, s.call);
  const entry = s.entry != null && s.entry >= 0 ? s.entry : g.price;
  const n = s.side * s.qty * 100;                       // acciones equivalentes con signo
  const vS = Math.max(s.iv + s.shift, 0.1) / 100;       // IV del escenario
  const left = Math.max(s.days - s.passed, 0) / 365;
  const be = s.call ? s.K + entry : s.K - entry;
  const cost = entry * s.qty * 100;
  let gain, loss;
  if (s.call) { gain = s.side > 0 ? Infinity : cost; loss = s.side > 0 ? -cost : -Infinity; }
  else { gain = s.side > 0 ? (s.K - entry) * s.qty * 100 : cost; loss = s.side > 0 ? -cost : -(s.K - entry) * s.qty * 100; }
  // probabilidad (neutral al riesgo) de acabar en beneficio al vencimiento
  const pAbove = BS.probAbove(s.S, be, T, r, q, v);
  const pop = s.call ? (s.side > 0 ? pAbove : 1 - pAbove) : (s.side > 0 ? 1 - pAbove : pAbove);
  return { s, T, r, q, v, vS, left, g, entry, n, be, cost, gain, loss, pop, em: s.S * v * Math.sqrt(T) };
}
// P&L de la posicion con el subyacente en x: al vencimiento, hoy (con el cambio de IV) o tras los dias elegidos
function calcPnL(m, x, which) {
  const s = m.s;
  let val;
  if (which === "exp") val = s.call ? Math.max(x - s.K, 0) : Math.max(s.K - x, 0);
  else val = BS.price(x, s.K, which === "now" ? m.T : m.left, m.r, m.q, m.vS, s.call);
  return m.n * (val - m.entry);
}

/* ---------------------------------------------------------------- estructura (una vez) */
function calcTok(k, v, w, label) {
  return `<input class="ss-in" data-k="${k}" value="${esc(v)}" size="${w}" inputmode="decimal" spellcheck="false" aria-label="${esc(label)}">`;
}
function calcBuild() {
  const box = $("calcView");
  box.innerHTML = `
  <header class="tl-head">
    <div class="tl-brand"><svg class="ss-mark" viewBox="0 0 28 28" aria-hidden="true"><rect x="1" y="1" width="26" height="26" rx="7"/><path d="M5 19h9l9-11"/><circle cx="14" cy="19" r="2.2"/></svg>
      <div><h1>Strike Studio</h1><p>Price one option and see how it behaves before you trade it.</p></div></div>
    <form class="ss-market" id="ssMarket" autocomplete="off">
      <span class="ss-linked" id="ssLinked" hidden></span>
      <label class="sr" for="ssSym">Ticker for market data</label>
      <input id="ssSym" placeholder="Ticker" maxlength="10" spellcheck="false" value="${esc(state.symbol || "SPX")}">
      <button type="submit" class="ss-btn">Use market data</button>
    </form>
  </header>
  <div class="ss-sentence" id="ssSentence">
    <button type="button" class="ss-tok" data-t="side" aria-label="Buy or sell"></button>
    ${calcTok("qty", calc.st.qty, 2, "Contracts")}
    <button type="button" class="ss-tok" data-t="type" aria-label="Call or put"></button>
    <span>with strike</span> ${calcTok("K", calc.st.K, 6, "Strike")}<span>, expiring in</span>
    ${calcTok("days", calc.st.days, 3, "Days to expiration")} <span>days.</span>
    <span class="ss-br">The underlying trades at</span> ${calcTok("S", calc.st.S, 7, "Underlying price")}
    <span>and implied volatility is</span> ${calcTok("iv", calc.st.iv, 4, "Implied volatility (%)")}<span>%.</span>
  </div>
  <div class="ss-more">
    <label>Risk-free rate ${calcTok("r", calc.st.r, 4, "Risk-free rate (%)")}%</label>
    <label>Dividend yield ${calcTok("q", calc.st.q, 4, "Dividend yield (%)")}%</label>
    <label>Entry price <input class="ss-in" data-k="entry" id="ssEntry" value="${calc.st.entry != null ? esc(calc.st.entry) : ""}" size="11" inputmode="decimal" spellcheck="false" aria-label="Entry price per share (blank for the model price)"> per share</label>
    <span class="ss-presets" role="group" aria-label="Examples">
      <button type="button" data-p="lc">Long ATM call</button><button type="button" data-p="lp">Long ATM put</button>
      <button type="button" data-p="sc">Short 5% OTM call</button><button type="button" data-p="sp">Short 5% OTM put</button>
    </span>
  </div>
  <div class="ss-grid">
    <section class="tl-card ss-main">
      <div class="ss-verdict" id="ssVerdict"></div>
      <div class="ss-chart" id="ssChart" role="img" aria-label="Profit and loss by underlying price"></div>
      <div class="ss-sliders">
        <label class="ss-sl"><span class="ss-sl-h">Time passes <b id="ssPassedV"></b></span>
          <input type="range" id="ssPassed" min="0" max="30" step="1" value="0"></label>
        <label class="ss-sl"><span class="ss-sl-h">Implied volatility moves <b id="ssShiftV"></b></span>
          <input type="range" id="ssShift" min="-20" max="20" step="1" value="0"></label>
      </div>
    </section>
    <aside class="tl-card ss-greeks" id="ssGreeks" aria-label="Price and Greeks"></aside>
  </div>
  <p class="tl-note">Black-Scholes-Merton with constant volatility and European exercise: a model estimate, not a quote. American options (stocks and ETFs) can be worth a little more deep in the money or before a dividend. Commissions and slippage are not included.</p>`;

  const sent = $("ssSentence");
  sent.addEventListener("click", (e) => {
    const t = e.target.closest(".ss-tok"); if (!t) return;
    if (t.dataset.t === "side") calc.st.side = -calc.st.side;
    else { calc.st.call = !calc.st.call; calcRelink(); }
    calcChanged();
  });
  box.addEventListener("input", (e) => {
    const el = e.target.closest(".ss-in"); if (!el) return;
    el.size = Math.max(el.dataset.k === "entry" ? 11 : 2, el.value.length + 1);
    const k = el.dataset.k, raw = el.value.replace(/,/g, "").trim();
    if (k === "entry") { calc.st.entry = raw === "" ? null : (isFinite(+raw) && +raw >= 0 ? +raw : calc.st.entry); calcChanged(); return; }
    const v = parseFloat(raw);
    if (!isFinite(v)) return;
    const lim = { qty: [1, 10000], K: [0.01, 1e7], days: [0, 3650], S: [0.01, 1e7], iv: [0.1, 500], r: [-5, 30], q: [-5, 50] }[k];
    calc.st[k] = Math.min(lim[1], Math.max(lim[0], k === "qty" ? Math.round(v) : v));
    if (k === "S" || k === "iv" || k === "q" || k === "r") calcUnlink();
    if (k === "K" || k === "days") calcRelink();
    calcChanged();
  });
  box.addEventListener("change", (e) => {    // al salir del campo, se muestra el valor que se usa
    const el = e.target.closest(".ss-in"); if (!el || el.dataset.k === "entry") return;
    el.value = String(calc.st[el.dataset.k]); el.size = Math.max(2, el.value.length + 1);
  });
  box.querySelector(".ss-presets").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    const S = calc.st.S, p = b.dataset.p;
    Object.assign(calc.st, { side: p[0] === "l" ? 1 : -1, call: p[1] === "c", entry: null });
    calc.st.K = calcRoundK(p[0] === "l" ? S : S * (p[1] === "c" ? 1.05 : 0.95));
    calcRelink(); calcSync(); calcChanged();
  });
  $("ssPassed").addEventListener("input", (e) => { calc.st.passed = +e.target.value; calcUpdate(); });
  $("ssShift").addEventListener("input", (e) => { calc.st.shift = +e.target.value; calcUpdate(); });
  $("ssMarket").addEventListener("submit", (e) => { e.preventDefault(); calcLink($("ssSym").value.trim().toUpperCase()); });
  $("ssLinked").addEventListener("click", (e) => { if (e.target.closest("button")) { calcUnlink(); calcUpdate(); } });
  calc.built = true;
}

// copia los valores del estado a los campos (tras un ejemplo o datos de mercado)
function calcSync() {
  for (const el of $("calcView").querySelectorAll(".ss-in")) {
    const k = el.dataset.k, v = calc.st[k];
    el.value = v == null ? "" : String(v);
    el.size = Math.max(k === "entry" ? 11 : 2, el.value.length + 1);
  }
}

/* ---------------------------------------------------------------- datos de mercado */
async function calcLink(sym) {
  if (!sym) return;
  const btn = $("ssMarket").querySelector("button");
  btn.disabled = true; btn.textContent = `Loading ${sym}…`;
  try {
    const ch = await loadChain(sym);
    if (!ch.live.length) throw new Error(`${sym} has no live expirations`);
    const mny = calc.st.K / calc.st.S;
    calc.link = { sym: ch.symbol, ch, ei: 0 };
    calc.st.S = +ch.spot.toFixed(2);
    calc.st.r = +(ch.r * 100).toFixed(2);
    calc.st.K = mny;    // se ajusta en calcRelink al strike real mas cercano
    calcRelink(true);
    calc.st.entry = null;
    calcSync(); calcChanged();
  } catch (e) {
    $("ssLinked").hidden = false;
    $("ssLinked").innerHTML = `<span class="ss-err">${esc(e.message)}</span>`;
  } finally { btn.disabled = false; btn.textContent = "Use market data"; }
}
// con datos enlazados: vencimiento mas cercano a los dias, strike real, IV de la cadena y carry del forward
function calcRelink(fromMoneyness = false) {
  const L = calc.link; if (!L) return;
  const e = expNear(L.ch, calc.st.days);
  L.ei = e.i;
  const ks = strikesOf(L.ch, e.i);
  const target = fromMoneyness ? calc.st.S * calc.st.K : calc.st.K;
  calc.st.K = nearestStrike(ks, target);
  if (fromMoneyness) calc.st.days = +Math.max(e.days, 0).toFixed(1);
  calc.st.iv = +(ivAt(L.ch, e.i, calc.st.K, calc.st.call) * 100).toFixed(1);
  calc.st.q = +(e.q * 100).toFixed(2);
  for (const k of ["K", "iv", "q", "days"]) {
    const el = $("calcView").querySelector(`.ss-in[data-k="${k}"]`);
    if (el && el !== document.activeElement) { el.value = String(calc.st[k]); el.size = Math.max(2, el.value.length + 1); }
  }
}
function calcUnlink() { calc.link = null; }

/* ---------------------------------------------------------------- pintar */
function calcChanged() { calcSave(); calcUpdate(); }

function showCalc() {
  if (!calc.built) { calcBuild(); calcSync(); }
  setStatus("", calc.link ? `Market data: ${calc.link.sym} at ${nyHHMM(calc.link.ch.generado)}` : "");
  calcUpdate();
}
function renderCalc() { if (calc.built) calcUpdate(); }

function calcUpdate() {
  const m = calcModel(), s = m.s;
  // frase
  const sent = $("ssSentence");
  const side = sent.querySelector('[data-t="side"]'), type = sent.querySelector('[data-t="type"]');
  side.textContent = s.side > 0 ? "Buy" : "Sell"; side.classList.toggle("short", s.side < 0);
  type.textContent = `${s.call ? "call" : "put"}${s.qty === 1 ? "" : "s"}`; type.classList.toggle("put", !s.call);
  $("ssEntry").placeholder = `model ${fmtNum(m.g.price, 2)}`;
  // enlace con el mercado
  const lk = $("ssLinked");
  if (calc.link) {
    const e = calc.link.ch.exps[calc.link.ei];
    lk.hidden = false;
    lk.innerHTML = `<span class="ss-live"></span>${esc(calc.link.sym)} ${shortDate(e.iso)} expiration, IV from the chain <button type="button" aria-label="Stop using market data">Unlink</button>`;
  } else if (!lk.querySelector(".ss-err")) lk.hidden = true;
  // deslizadores
  const ps = $("ssPassed");
  ps.max = String(Math.max(1, Math.floor(s.days)));
  if (s.passed > +ps.max) { s.passed = +ps.max; }
  ps.value = String(s.passed);
  $("ssPassedV").textContent = s.passed ? `${s.passed} ${s.passed === 1 ? "day" : "days"} (${fmtNum(Math.max(s.days - s.passed, 0), s.days % 1 ? 1 : 0)} left)` : "not yet";
  $("ssShiftV").textContent = s.shift ? `${s.shift > 0 ? "+" : "−"}${Math.abs(s.shift)} pts (to ${fmtNum(Math.max(s.iv + s.shift, 0.1), 1)}%)` : "no change";
  calcVerdict(m);
  calcGreeks(m);
  calcChart(m);
}

function calcVerdict(m) {
  const s = m.s, long = s.side > 0;
  const cell = (t, v, cls = "", sub = "") => `<div class="ss-v ${cls}"><span>${t}</span><b>${v}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;
  const what = `${long ? "Long" : "Short"} ${s.call ? "call" : "put"}`;
  const mny = s.call ? (s.S > s.K ? "in the money" : s.S < s.K ? "out of the money" : "at the money")
    : (s.S < s.K ? "in the money" : s.S > s.K ? "out of the money" : "at the money");
  $("ssVerdict").innerHTML =
    cell(long ? "You pay" : "You collect", money(m.cost, 0), long ? "" : "pos", `${what}, ${mny}`) +
    cell("Breakeven at expiry", px(m.be), "", `${m.be >= s.S ? "+" : "−"}${fmtNum(Math.abs(m.be / s.S - 1) * 100, 1)}% from here`) +
    cell("Max gain", m.gain === Infinity ? "Unlimited" : money(m.gain, 0), "pos") +
    cell("Max loss", m.loss === -Infinity ? "Unlimited" : money(m.loss, 0), "neg") +
    cell("Chance of profit", `${fmtNum(m.pop * 100, 0)}%`, "", "at expiry, from the IV");
}

function calcGreeks(m) {
  const s = m.s, g = m.g, n = m.n, sd = s.side;
  const row = (name, val, dec, line, hint) => `<div class="ss-g" title="${esc(hint)}"><span class="ss-gn">${name}</span><b>${val == null ? "—" : (val > 0 ? "+" : val < 0 ? "−" : "") + fmtNum(Math.abs(val), dec)}</b><small>${line}</small></div>`;
  $("ssGreeks").innerHTML = `
    <div class="ss-price"><span>Model price</span><b>${money(g.price)}</b><small>${money(g.price * 100)} per contract${s.entry != null ? `, you entered ${money(m.entry)}` : ""}</small></div>
    ${row("Delta", g.delta * sd, 4, `${signedMoney(g.delta * n)} per +$1 in the underlying`, "How much the position gains or loses for each $1 the underlying moves.")}
    ${row("Gamma", g.gamma * sd, 4, `delta moves ${fmtNum(Math.abs(g.gamma * n), 1)} shares per $1`, "How fast delta changes as the underlying moves. Largest at the money and near expiration.")}
    ${row("Theta", g.theta * sd, 3, `${signedMoney(g.theta * n)} per day from time alone`, "What one day of time costs (or pays) if nothing else changes.")}
    ${row("Vega", g.vega * sd, 3, `${signedMoney(g.vega * n)} per +1 point of IV`, "How much the position gains or loses when implied volatility rises one point.")}
    ${row("Rho", g.rho * sd, 3, `${signedMoney(g.rho * n)} per +1% in rates`, "Sensitivity to interest rates. Small unless the option is long-dated.")}
    <p class="ss-gnote">Greeks are per share, signed for your side; the line below each one is the whole position (${fmtNum(Math.abs(n), 0)} shares).</p>`;
}

function calcChart(m) {
  const box = $("ssChart"), s = m.s;
  const w = Math.min(0.6, Math.max(0.07, 3 * m.v * Math.sqrt(Math.max(m.T, 1 / 365))));
  let lo = Math.min(s.S * (1 - w), s.K * 0.96, m.be * 0.97), hi = Math.max(s.S * (1 + w), s.K * 1.04, m.be * 1.03);
  lo = Math.max(lo, 0);
  const N = 160, xs = Array.from({ length: N + 1 }, (_, i) => lo + (hi - lo) * i / N);
  const curves = [
    { label: "At expiration", color: C.text, main: true, pts: xs.map((x) => [x, calcPnL(m, x, "exp")]) },
    { label: `Today${s.shift ? ` (IV ${s.shift > 0 ? "+" : "−"}${Math.abs(s.shift)})` : ""}`, color: C.accent, pts: xs.map((x) => [x, calcPnL(m, x, "now")]) },
  ];
  if (s.passed > 0) curves.push({ label: `In ${s.passed} ${s.passed === 1 ? "day" : "days"}`, color: C.amber, dash: "6 4", pts: xs.map((x) => [x, calcPnL(m, x, "mid")]) });
  const kRight = s.K >= s.S;
  payoffChart(box, {
    lo, hi, curves, ref: s.S, bes: [m.be],
    marks: [
      { x: s.S, label: `Spot ${px(s.S)}`, color: C.spotline, dash: "1 3", side: kRight ? "end" : "start" },
      { x: s.K, label: `Strike ${px(s.K)}`, color: C.faint, side: kRight ? "start" : "end" },
    ],
    band: m.em > 0 ? [s.S - m.em, s.S + m.em] : null, bandLabel: `±1σ move by expiry (${px(m.em)})`,
    probe: (x) => [
      { label: "At expiration", v: calcPnL(m, x, "exp"), color: C.text },
      { label: "Today", v: calcPnL(m, x, "now"), color: C.accent },
      ...(s.passed > 0 ? [{ label: `In ${s.passed} days`, v: calcPnL(m, x, "mid"), color: C.amber }] : []),
    ],
  });
}
