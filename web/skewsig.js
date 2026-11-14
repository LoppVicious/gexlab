"use strict";
/* ============================================================ Señal de skew (Signals, Skew signal)
   Datos: /api/skew (skew.py, lo publica historial500.py tras cada cierre): skew a 30 dias de cada accion del
   historial diario (put de 25 delta − ATM del mensual mas cercano a 30 dias), su cambio en 5 sesiones, puntuacion
   transversal (0 barato, 1 caro) y la prueba en adelante (IC y diferencial a 5 y 20 sesiones). A la izquierda la
   prueba; a la derecha el ranking de hoy. Nombres con prefijo ssk/SigSkew: vol.js ya usa renderSkew. */

const ssk = { data: null, at: 0, ctrl: null, sort: "score", dir: -1 };

function sigSkewStatus() { return ssk.data ? `Skew signal, close of ${ddmm(ssk.data.date)}` : ""; }

function showSigSkew() {
  if (ssk.data) { renderSigSkew(); setStatus("", sigSkewStatus()); }
  if (!ssk.data || Date.now() - ssk.at > 300000) loadSigSkew();
}

async function loadSigSkew() {
  if (ssk.ctrl) ssk.ctrl.abort();
  ssk.ctrl = new AbortController();
  $("refreshBtn").classList.add("spin");
  setStatus("busy", "Loading the skew signal…");
  if (!ssk.data) $("sskBody").innerHTML = `<tr><td class="l" colspan="7"><div class="empty">Loading…</div></td></tr>`;
  try {
    const r = await fetch("/api/skew", { signal: ssk.ctrl.signal });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Could not load the skew signal");
    ssk.data = d; ssk.at = Date.now();
    if (state.mode === "skewsig") { renderSigSkew(); setStatus("", sigSkewStatus()); }
  } catch (e) {
    if (e.name === "AbortError") return;
    if (state.mode === "skewsig") {
      setStatus("err", ssk.data ? "Could not refresh" : "No data");
      if (!ssk.data) $("sskBody").innerHTML = `<tr><td class="l" colspan="7"><div class="empty">${esc(e.message === "Failed to fetch" ? "The local server is not responding. Open GEX Lab again." : e.message)}</div></td></tr>`;
    }
  } finally { $("refreshBtn").classList.remove("spin"); }
}

const sskPts = (v, sign) => (v == null ? "—" : (sign && v > 0 ? "+" : v < 0 ? "−" : "") + fmtNum(Math.abs(v) * 100, 1));
const SSK_TILT = { 5: ["Bearish tilt", "neg"], 4: ["Leaning bearish", "neg"], 3: ["Neutral", ""], 2: ["Leaning bullish", "pos"], 1: ["Bullish tilt", "pos"] };

function renderSigSkew() {
  const d = ssk.data;
  if (!d) return;
  const e5 = d.eval["5"], e20 = d.eval["20"], need = d.min_sessions;
  const ok = e20.enough || e5.enough, ev = e20.enough ? e20 : e5;
  const works = ok && ev.ic < 0 && ev.t != null && ev.t <= -2;
  const st = $("sskState");
  st.textContent = !ok ? "Collecting data" : works ? "Working" : ev.ic < 0 ? "Weak so far" : "Not working";
  st.className = "mstate " + (!ok ? "mixed" : works ? "contango" : "backwardation");
  $("sskSub").textContent = `${d.stocks} stocks, close of ${longDate(d.date)}. ${d.sessions} session${d.sessions === 1 ? "" : "s"} scored since ${ddmm(d.first)}`;
  $("sskRead").textContent = !ok
    ? `The forward test needs ${need} evaluated sessions per horizon before it says anything: today ${e5.n} at 5 sessions and ${e20.n} at 20. Until then the ranking is a watch list, not a signal.`
    : works
      ? "Stocks with expensive put skew have been underperforming the rest, as the research says. The ranking can tilt a swing book: favour longs at the bottom and avoid them at the top."
      : "In our own data, expensive put skew has not anticipated underperformance clearly enough. Treat the ranking as context, not as a signal.";
  const fact = (l, e) => {
    const v = e.n ? `IC ${e.ic > 0 ? "+" : e.ic < 0 ? "−" : ""}${fmtNum(Math.abs(e.ic), 3)}` : "—";
    const s = e.n ? `${e.n} sessions${e.t != null ? `, t ${fmtNum(e.t, 1)}` : ""}. Expensive − cheap quintile: ${e.spread > 0 ? "+" : e.spread < 0 ? "−" : ""}${fmtNum(Math.abs(e.spread) * 100, 2)}%` : `no sessions evaluated yet (needs ${need})`;
    return `<div class="fact"><span class="fl">${l}</span><strong>${v}</strong><span class="fs${e.n && !e.enough ? " warn" : ""}">${s}</span></div>`;
  };
  $("sskFacts").innerHTML = fact("Next 5 sessions", e5) + fact("Next 20 sessions", e20);

  const rows = [...d.rows];
  const k = ssk.sort, dir = ssk.dir;
  rows.sort((a, b) => {
    const x = a[k], y = b[k];
    if (k === "sym") return dir * String(x).localeCompare(String(y));
    if (x == null) return 1; if (y == null) return -1;
    return dir * (x - y);
  });
  $("sskBody").innerHTML = rows.map((r) => {
    const [tilt, cls] = SSK_TILT[r.q] || ["", ""];
    return `<tr data-s="${esc(r.sym)}" title="${esc(r.name || r.sym)}: open its volatility dashboard">
      <td class="l"><b>${esc(r.sym)}</b></td>
      <td>${sskPts(r.skew, true)}</td>
      <td>${sskPts(r.chg, true)}</td>
      <td>${fmtNum(r.atm * 100, 1)}%</td>
      <td><span class="ssk-bar"><i style="width:${fmtNum(r.score * 100, 0)}%"></i></span>${fmtNum(r.score * 100, 0)}</td>
      <td class="l"><span class="ssk-tilt ${cls}">${tilt}</span></td></tr>`;
  }).join("");
  document.querySelectorAll("#sskTable th[data-k]").forEach((th) => {
    th.classList.toggle("sorted", th.dataset.k === k);
    th.dataset.dir = th.dataset.k === k ? (dir > 0 ? "▲" : "▼") : "";
  });
  $("sskExcl").textContent = d.excluded.length ? `Left out (indices, ETFs and the VIX): ${d.excluded.join(", ")}.` : "";
}

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
