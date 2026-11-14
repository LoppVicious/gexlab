"use strict";
/* ============================================================ Señales de skew (Signals, Skew signal)
   Datos: /api/skew (skew.py, lo publica historial500.py tras cada cierre). Dos señales transversales sobre las
   acciones del historial diario, en el mensual mas cercano a 30 dias:
     skew: IV put 25 delta − ATM; la hipotesis espera IC negativo (puts caras, la accion va peor)
     cp:   IV call − IV put del mismo strike (CBOE, ponderada por OI); la hipotesis espera IC positivo
   Cada una con su puntuacion (nivel y cambio en 5 sesiones) y su prueba en adelante a 5 y 20 sesiones.
   A la izquierda la prueba de la señal elegida; a la derecha el ranking de hoy.
   Nombres con prefijo ssk/SigSkew: vol.js ya usa renderSkew. */

const ssk = { data: null, at: 0, ctrl: null, sig: store.get("sskSig", "combo"), sort: "score", dir: -1 };
const SSK_BEAR = { 5: ["Bearish tilt", "neg"], 4: ["Leaning bearish", "neg"], 3: ["Neutral", ""], 2: ["Leaning bullish", "pos"], 1: ["Bullish tilt", "pos"] };
const SSK_BULL = { 5: ["Bullish tilt", "pos"], 4: ["Leaning bullish", "pos"], 3: ["Neutral", ""], 2: ["Leaning bearish", "neg"], 1: ["Bearish tilt", "neg"] };
const sskPts = (v) => (v == null ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "") + fmtNum(Math.abs(v) * 100, 1));
const SSK_SIG = {
  combo: { name: "Consensus", caption: "Stocks where at least two signals agree and none disagrees.",
    works: "Stocks where the signals agree have moved the way they point. The matches can tilt a swing book: favour longs among the bullish ones and avoid them among the bearish ones." },
  skew: { name: "Put skew", level: "Skew", levelTip: "25-delta put IV minus ATM IV, about 30 days (volatility points)",
    caption: "Levels and changes in volatility points.", fmt: sskPts, fmtChg: sskPts,
    works: "Stocks with expensive puts have been lagging the rest, as the research says. The ranking can tilt a swing book: avoid longs at the top, favour them at the bottom.",
    tilt: SSK_BEAR },
  cp: { name: "Call−put IV", level: "Call − put", levelTip: "Open-interest-weighted call IV minus put IV at the same strikes, within 5% of the price and with tight quotes on both legs (volatility points)",
    caption: "Levels and changes in volatility points.", fmt: sskPts, fmtChg: sskPts,
    works: "Stocks with calls rich against puts have been beating the rest, as the research says. The ranking can tilt a swing book: favour longs at the top, avoid them at the bottom.",
    tilt: SSK_BULL },
  // el nivel es log(O/S): en pantalla, el ratio y su cambio en %
  os: { name: "Options volume", level: "O/S", levelTip: "Option contracts traded × 100 / shares traded, on the day: the share of trading that went through options",
    caption: "O/S: option contracts × 100 / shares traded. Change: against 5 sessions ago.",
    fmt: (v) => (v == null ? "—" : fmtNum(Math.exp(v), 2)),
    fmtChg: (v) => (v == null ? "—" : sskSigned((Math.exp(v) - 1) * 100, 0) + "%"),
    works: "Stocks with heavy option trading against their share volume have been lagging the rest, as the research says. The ranking can tilt a swing book: avoid longs at the top, favour them at the bottom.",
    tilt: SSK_BEAR },
};

function sigSkewStatus() { return ssk.data ? `Skew signals, close of ${ddmm(ssk.data.date)}` : ""; }

function showSigSkew() {
  if (ssk.data) { renderSigSkew(); setStatus("", sigSkewStatus()); }
  if (!ssk.data || Date.now() - ssk.at > 300000) loadSigSkew();
}

async function loadSigSkew() {
  if (ssk.ctrl) ssk.ctrl.abort();
  ssk.ctrl = new AbortController();
  $("refreshBtn").classList.add("spin");
  setStatus("busy", "Loading the skew signals…");
  if (!ssk.data) $("sskBody").innerHTML = `<tr><td class="l" colspan="6"><div class="empty">Loading…</div></td></tr>`;
  try {
    const r = await fetch("/api/skew", { signal: ssk.ctrl.signal });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Could not load the skew signals");
    if (!d.signals) throw new Error("The skew signals are being rebuilt. Try again in a few minutes.");
    ssk.data = d; ssk.at = Date.now();
    if (state.mode === "skewsig") { renderSigSkew(); setStatus("", sigSkewStatus()); }
  } catch (e) {
    if (e.name === "AbortError") return;
    if (state.mode === "skewsig") {
      setStatus("err", ssk.data ? "Could not refresh" : "No data");
      if (!ssk.data) $("sskBody").innerHTML = `<tr><td class="l" colspan="6"><div class="empty">${esc(e.message === "Failed to fetch" ? "The local server is not responding. Open GEX Lab again." : e.message)}</div></td></tr>`;
    }
  } finally { $("refreshBtn").classList.remove("spin"); }
}

const sskSigned = (v, dec) => (v > 0 ? "+" : v < 0 ? "−" : "") + fmtNum(Math.abs(v), dec);

function renderSigSkew() {
  const d = ssk.data;
  if (!d) return;
  if (!SSK_SIG[ssk.sig] || !d.signals[ssk.sig]) ssk.sig = d.signals.combo ? "combo" : "skew";
  const key = ssk.sig, cfg = SSK_SIG[key], sg = d.signals[key];
  document.querySelectorAll("#sskSeg button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === key)));

  // prueba en adelante: "funciona" si el IC va en el sentido de la hipotesis con t de al menos 2
  const e5 = sg.eval["5"], e20 = sg.eval["20"], need = d.min_sessions;
  const ok = e20.enough || e5.enough, ev = e20.enough ? e20 : e5;
  const right = ok && ev.ic * sg.sign > 0, works = right && ev.t != null && ev.t * sg.sign >= 2;
  $("sskTitle").textContent = `${cfg.name}, forward test`;
  const st = $("sskState");
  st.textContent = !ok ? "Collecting data" : works ? "Working" : right ? "Weak so far" : "Not working";
  st.className = "mstate " + (!ok ? "mixed" : works ? "contango" : "backwardation");
  // cada señal llega hasta su ultima sesion con datos (el volumen de la accion de un dia pasado tarda una sesion)
  const sd = sg.date || d.date, rowsN = d.rows.filter((r) => r[key]).length;
  $("sskSub").textContent = `${rowsN} stocks, close of ${longDate(sd)}${sd !== d.date ? " (the share volume of " + ddmm(d.date) + " is not out yet)" : ""}. ${sg.sessions} session${sg.sessions === 1 ? "" : "s"} scored${sg.first ? " since " + ddmm(sg.first) : ""}`;
  $("sskRead").textContent = !ok
    ? `The forward test needs ${need} evaluated sessions per horizon before it says anything: today ${e5.n} at 5 sessions and ${e20.n} at 20. Until then the ranking is a watch list, not a signal.`
    : works ? cfg.works
      : `In our own data this signal has not ${right ? "been strong enough yet" : "pointed the way the research expects"}. Treat the ranking as context, not as a signal.`;
  const want = sg.sign < 0 ? "negative" : "positive";
  const fact = (l, e) => {
    const v = e.n ? `IC ${sskSigned(e.ic, 3)}` : "—";
    // la t con pocas sesiones solapadas no significa nada: solo se muestra con el minimo de la prueba
    const s = e.n ? `${e.n} session${e.n === 1 ? "" : "s"}${e.enough && e.t != null ? `, t ${fmtNum(e.t, 1)}` : ", too few to judge"}. Top − bottom quintile: ${sskSigned(e.spread * 100, 2)}%`
      : `no sessions evaluated yet (needs ${need})`;
    return `<div class="fact"><span class="fl">${l}</span><strong>${v}</strong><span class="fs${e.n && !e.enough ? " warn" : ""}">${s}</span></div>`;
  };
  $("sskFacts").innerHTML = fact("Next 5 sessions", e5) + fact("Next 20 sessions", e20) +
    (key === "combo"
      ? `<div class="fact"><span class="fl">If the signals add up</span><strong>IC positive</strong><span class="fs">the more bullish the combined score, the stronger the stock afterwards</span></div>`
      : `<div class="fact"><span class="fl">The research expects</span><strong>IC ${want}</strong><span class="fs">${sg.sign < 0 ? "a high score, then a weaker stock" : "a high score, then a stronger stock"}</span></div>`);

  $("sskCap").textContent = `${cfg.caption} Click a stock to open its volatility dashboard.`;
  if (key === "combo") { renderSskConsensus(d); return; }
  sskHead([["sym", "Ticker", "l"], ["v", cfg.level, "", cfg.levelTip], ["chg", "5d change", "", "Change over 5 sessions"],
    ["atm", "ATM IV", "", "At-the-money implied volatility, about 30 days"],
    ["score", "Score", "", "Average of the cross-sectional rank by level and by its change (100 = highest)"],
    ["q", "Reading", "l", "Quintile of the score, read in the direction the research expects"]]);
  const val = (r, k) => (k === "sym" ? r.sym : k === "atm" ? r.atm : (r[key] || {})[k]);
  const rows = d.rows.filter((r) => r[key]);
  const k = ssk.sort, dir = ssk.dir;
  rows.sort((a, b) => {
    const x = val(a, k), y = val(b, k);
    if (k === "sym") return dir * String(x).localeCompare(String(y));
    if (x == null) return 1; if (y == null) return -1;
    return dir * (x - y);
  });
  $("sskBody").innerHTML = rows.map((r) => {
    const s = r[key], [tilt, cls] = cfg.tilt[s.q] || ["", ""];
    return `<tr data-s="${esc(r.sym)}" title="${esc(r.name || r.sym)}: open its volatility dashboard">
      <td class="l"><b>${esc(r.sym)}</b></td>
      <td>${cfg.fmt(s.v)}</td>
      <td>${cfg.fmtChg(s.chg)}</td>
      <td>${r.atm == null ? "—" : fmtNum(r.atm * 100, 1) + "%"}</td>
      <td><span class="ssk-bar"><i style="width:${fmtNum(s.score * 100, 0)}%"></i></span>${fmtNum(s.score * 100, 0)}</td>
      <td class="l"><span class="ssk-tilt ${cls}">${tilt}</span></td></tr>`;
  }).join("");
  document.querySelectorAll("#sskTable th[data-k]").forEach((th) => {
    th.classList.toggle("sorted", th.dataset.k === k);
    th.dataset.dir = th.dataset.k === k ? (dir > 0 ? "▲" : "▼") : "";
  });
  const sin = d.rows.filter((r) => !r[key]).map((r) => r.sym).concat(d.missing || []);
  $("sskFoot").textContent = [
    sin.length ? `No reading today (options too thin, or no usable strikes on the monthly): ${[...new Set(sin)].sort().join(", ")}.` : "",
    d.excluded.length ? `Left out (indices, ETFs and the VIX): ${d.excluded.join(", ")}.` : "",
  ].filter(Boolean).join(" ");
}

function sskHead(cols, sortable = true) {
  $("sskTable").querySelector("thead").innerHTML = `<tr>${cols.map(([k, t, cls, tip]) =>
    `<th${sortable ? ` data-k="${k}"` : ""}${cls ? ` class="${cls}"` : ""}${tip ? ` title="${esc(tip)}"` : ""}>${t}</th>`).join("")}</tr>`;
}

// Consenso: solo las acciones con al menos dos señales en el mismo sentido y ninguna en contra (skew.consenso);
// primero las alcistas, de mas a menos, y despues las bajistas
function renderSskConsensus(d) {
  sskHead([["sym", "Ticker", "l"], ["skew", "Put skew", "", "Vote of the put skew signal"], ["cp", "Call−put IV", "", "Vote of the call−put signal"],
    ["os", "Options volume", "", "Vote of the O/S signal"], ["v", "Combined", "", "Average direction of the signals with a reading: +100 all as bullish as possible, −100 all as bearish"],
    ["m", "Reading", "l"]], false);
  const vote = (r, k) => {
    const v = ((r.combo || {}).votes || {})[k];
    return v == null ? `<span class="ssk-tilt">no reading</span>` : v > 0 ? `<span class="ssk-tilt pos">▲ Bullish</span>`
      : v < 0 ? `<span class="ssk-tilt neg">▼ Bearish</span>` : `<span class="ssk-tilt">Neutral</span>`;
  };
  const m = d.rows.filter((r) => r.combo && r.combo.match);
  const bull = m.filter((r) => r.combo.match === "bull").sort((a, b) => b.combo.v - a.combo.v);
  const bear = m.filter((r) => r.combo.match === "bear").sort((a, b) => a.combo.v - b.combo.v);
  const row = (r) => {
    const c = r.combo, n = Object.values(c.votes).filter((v) => (c.match === "bull" ? v > 0 : v < 0)).length;
    return `<tr data-s="${esc(r.sym)}" title="${esc(r.name || r.sym)}: open its volatility dashboard">
      <td class="l"><b>${esc(r.sym)}</b></td><td>${vote(r, "skew")}</td><td>${vote(r, "cp")}</td><td>${vote(r, "os")}</td>
      <td>${sskSigned(c.v * 100, 0)}</td>
      <td class="l"><span class="ssk-tilt ${c.match === "bull" ? "pos" : "neg"}"><b>${c.match === "bull" ? "Bullish" : "Bearish"}</b>, ${n} of ${c.n} agree</span></td></tr>`;
  };
  const group = (t, list) => `<tr class="ssk-group"><td class="l" colspan="6">${t} (${list.length})</td></tr>` +
    (list.length ? list.map(row).join("") : `<tr><td class="l" colspan="6"><span class="ssk-tilt">None today.</span></td></tr>`);
  $("sskBody").innerHTML = group("Bullish matches", bull) + group("Bearish matches", bear);
  const both = d.rows.filter((r) => r.combo).length;
  $("sskSub").textContent = `${m.length} matches among ${both} stocks with at least two signals, close of ${longDate(d.date)}. ${d.signals.combo.sessions} sessions scored`;
  $("sskFoot").textContent = "A match needs at least two signals in the outer two fifths of their own ranking pointing the same way, and none against. Put skew and options volume vote bearish when high; call−put votes bullish when high." +
    (d.excluded.length ? ` Left out (indices, ETFs and the VIX): ${d.excluded.join(", ")}.` : "");
}

$("sskSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-v]"); if (!b || b.dataset.v === ssk.sig) return;
  ssk.sig = b.dataset.v; store.set("sskSig", ssk.sig);
  renderSigSkew();
});
$("sskTable").querySelector("thead").addEventListener("click", (e) => {
  const th = e.target.closest("th[data-k]"); if (!th) return;
  if (ssk.sort === th.dataset.k) ssk.dir = -ssk.dir; else { ssk.sort = th.dataset.k; ssk.dir = th.dataset.k === "sym" ? 1 : -1; }
  renderSigSkew();
});
$("sskBody").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-s]"); if (!tr) return;
  state.symbol = tr.dataset.s; store.set("symbol", state.symbol);
  $("symbol").value = state.symbol; $("spotInput").value = "";
  setMode("vol");
});
