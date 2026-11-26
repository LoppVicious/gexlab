"use strict";
/* ============================================================ Movimiento esperado (Signals, Expected moves)
   Datos: /api/moves (movimiento.py, lo publica historial500.py tras cada cierre). Magnitud, no direccion:
     m1, m5, m21: movimiento implicito de 1 sigma a 1, 5 y 21 sesiones (un mes) (%); m5 es el ranking principal
     ev, ev_exp, ev_n: evento que cotiza la estructura temporal (salto de varianza a plazo; resultados u otro)
     gadv: gamma de dealers ($ por 1 %) / volumen medio en $ de 20 sesiones; os: contratos × 100 / acciones
     flags: "heavy" (O/S en el quinto alto) y "short" (gamma negativa en el quinto mas negativo), indicadores en
     prueba: test.heavy y test.short traen su prueba en adelante (realizado / implicito a 5 sesiones)
   Prefijo emv: los nombres globales se comparten entre los scripts de web/. */

const emv = { data: null, at: 0, ctrl: null, tab: store.get("emvTab", "all"), sort: "m5", dir: -1 };
const EMV_FLAGS = {
  heavy: ["Heavy volume", "Option trading high against share volume (top fifth today)"],
  short: ["Short gamma", "Dealers short gamma, large against the stock's daily dollar volume (most negative fifth today): their hedging adds to moves"],
  confirmed: ["Volume confirmed", "Shares traded well above their 20-session average, a wide range and a close near the high: the move has stock volume behind it"],
  options: ["Options-led", "Heavy option trading while share volume is at or below its 20-session average: moves like this tend to stay contained"],
};
const emvPct = (v, dec = 1) => (v == null ? "—" : "±" + fmtNum(v, dec) + "%");
const emvX = (v) => (v == null ? "—" : fmtNum(v, 2) + "×");

function emvStatus() { return emv.data ? `Expected moves, close of ${ddmm(emv.data.date)}` : ""; }

function showMoves() {
  if (emv.data) { renderMoves(); setStatus("", emvStatus()); }
  if (!emv.data || Date.now() - emv.at > 300000) loadMoves();
}

async function loadMoves() {
  if (emv.ctrl) emv.ctrl.abort();
  emv.ctrl = new AbortController();
  $("refreshBtn").classList.add("spin");
  setStatus("busy", "Loading the expected moves…");
  if (!emv.data) $("emvBody").innerHTML = `<tr><td class="l" colspan="10"><div class="empty">Loading…</div></td></tr>`;
  try {
    const r = await fetch("/api/moves", { signal: emv.ctrl.signal });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Could not load the expected moves");
    emv.data = d; emv.at = Date.now();
    if (state.mode === "moves") { renderMoves(); setStatus("", emvStatus()); }
  } catch (e) {
    if (e.name === "AbortError") return;
    if (state.mode === "moves") {
      setStatus("err", emv.data ? "Could not refresh" : "No data");
      if (!emv.data) $("emvBody").innerHTML = `<tr><td class="l" colspan="10"><div class="empty">${esc(e.message === "Failed to fetch" ? "The local server is not responding. Open GEX Lab again." : e.message)}</div></td></tr>`;
    }
  } finally { $("refreshBtn").classList.remove("spin"); }
}

// veredicto de un indicador en prueba: IC en el sentido esperado con t de al menos 2 y sesiones suficientes
function emvVerdict(t) {
  if (!t || !t.n) return ["Collecting data", "mixed"];
  if (!t.enough) return ["In test", "mixed"];
  return t.ic > 0 && t.t != null && t.t >= 2 ? ["Holding up", "contango"] : ["Not holding", "backwardation"];
}

function renderMoves() {
  const d = emv.data;
  if (!d) return;
  const t = d.test || {}, rows = d.rows || [], evs = rows.filter((r) => r.ev);
  document.querySelectorAll("#emvSeg button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === emv.tab)));

  $("emvState").textContent = `${evs.length} event${evs.length === 1 ? "" : "s"} ahead`;
  $("emvSub").textContent = `${rows.length} stocks, close of ${longDate(d.date)}. ${d.sessions} session${d.sessions === 1 ? "" : "s"} recorded since ${ddmm(d.first)}`;
  const top = [...rows].filter((r) => r.m5 != null).sort((a, b) => b.m5 - a.m5).slice(0, 3).map((r) => r.sym);
  $("emvRead").textContent = (top.length ? `Largest 5-day moves priced in: ${top.join(", ")}. ` : "") +
    (evs.length ? `${evs.length} stock${evs.length === 1 ? " has" : "s have"} an event priced within ${d.thresholds.event_sessions} sessions, most often earnings.` : "No events priced within the next two weeks.");

  const fact = (label, value, sub, warn) => `<div class="fact"><span class="fl">${label}</span><strong>${value}</strong><span class="fs${warn ? " warn" : ""}">${sub}</span></div>`;
  const flagFact = (k) => {
    const x = t[k] || {}, [v] = emvVerdict(x);
    const sub = !x.n ? `no sessions evaluated yet (needs ${x.need ?? 20})`
      : `stocks in the top fifth moved ${emvX(x.top)} what their options priced over the next ${d.horizon} sessions, the bottom fifth ${emvX(x.bottom)}. ${x.n} session${x.n === 1 ? "" : "s"}${x.enough && x.t != null ? `, t ${fmtNum(x.t, 1)}` : `, too few to judge (needs ${x.need})`}`;
    return fact(`${k === "heavy" ? "Heavy options volume" : k === "rvol" ? "Share volume (RVol)" : EMV_FLAGS[k][0]}: ${v.toLowerCase()}`, x.ic == null ? "—" : `IC ${x.ic > 0 ? "+" : x.ic < 0 ? "−" : ""}${fmtNum(Math.abs(x.ic), 2)}`, sub, x.n && !x.enough);
  };
  // casos de una etiqueta: rendimiento a 5 sesiones frente a la media de las demás acciones del día
  const caseFact = (k) => {
    const x = t[k] || {};
    const sub = !x.n ? "no cases with a result yet"
      : `${x.n} case${x.n === 1 ? "" : "s"} over the next ${d.horizon} sessions: moved ${emvX(x.ratio)} what options priced, ${x.hit == null ? "—" : fmtNum(x.hit * 100, 0) + "%"} beat the day's average stock${x.enough ? "" : `. Too few to judge (needs ${x.need})`}`;
    return fact(`${EMV_FLAGS[k][0]}, return vs other stocks`, x.excess == null ? "—" : `${x.excess > 0 ? "+" : x.excess < 0 ? "−" : ""}${fmtNum(Math.abs(x.excess), 2)} pts`, sub, x.n && !x.enough);
  };
  const ev = t.events || {};
  $("emvFacts").innerHTML =
    fact("Events, move vs priced", ev.median == null ? "—" : emvX(ev.median),
      ev.n ? `largest daily move in the ${d.horizon} sessions after an event priced within them, against the event move. ${ev.n} cases: options have tended to overprice events` : "no events with a result yet") +
    fact("All stocks, move vs priced", t.ratio == null ? "—" : emvX(t.ratio), `median realized ${d.horizon}-session move against the 5-day move priced at the close`) +
    flagFact("heavy") + flagFact("short") + flagFact("rvol") + caseFact("confirmed") + caseFact("options");

  // tabla
  const tab = emv.tab;
  let list = tab === "events" ? evs : tab === "flags" ? rows.filter((r) => r.flags && r.flags.length) : rows;
  const k = emv.sort, dir = emv.dir;
  const val = (r) => (k === "flags" ? (r.flags || []).length : r[k]);
  list = [...list].sort((a, b) => {
    if (k === "sym") return dir * a.sym.localeCompare(b.sym);
    const x = val(a), y = val(b);
    if (x == null) return 1; if (y == null) return -1;
    return dir * (x - y) || a.sym.localeCompare(b.sym);
  });
  $("emvBody").innerHTML = list.length ? list.map((r) => {
    const g = r.gadv == null ? "—" : `<span class="${r.gadv < 0 ? "neg" : r.gadv > 0 ? "pos" : ""}">${r.gadv > 0 ? "+" : r.gadv < 0 ? "−" : ""}${fmtNum(Math.abs(r.gadv) * 100, 2)}%</span>`;
    const flip = r.below_flip == null ? "" : r.below_flip ? `Below the gamma flip (${fmtNum(r.flip, 2)}). ` : `Above the gamma flip (${fmtNum(r.flip, 2)}). `;
    return `<tr data-s="${esc(r.sym)}" title="${esc(r.name || r.sym)}: open its TRACE">
      <td class="l"><b>${esc(r.sym)}</b></td>
      <td>${r.spot == null ? "—" : fmtNum(r.spot, 2)}</td>
      <td>${emvPct(r.m1)}</td>
      <td><span class="ssk-bar"><i style="width:${Math.min(100, (r.m5 || 0) / 20 * 100).toFixed(0)}%"></i></span>${emvPct(r.m5)}</td>
      <td>${emvPct(r.m21)}</td>
      <td class="l">${r.ev ? `<b>${emvPct(r.ev)}</b> <span class="ssk-tilt">by ${ddmm(r.ev_exp)}</span>` : `<span class="ssk-tilt">—</span>`}</td>
      <td title="${esc(flip)}Dealer gamma per 1% move, in % of the average daily dollar volume (20 sessions)">${g}</td>
      <td title="${r.os_date && r.os_date !== d.date ? "Share volume of " + ddmm(r.os_date) : ""}">${r.os == null ? "—" : fmtNum(r.os, 2)}</td>
      <td title="${r.rvol == null ? "" : esc(`${r.candle_date && r.candle_date !== d.date ? "Candle of " + ddmm(r.candle_date) + ". " : ""}Shares traded ${emvX(r.rvol)} their 20-session average. Day's range ${emvX(r.range)} its average, close at ${fmtNum(r.close_pos * 100, 0)}% of the range.`)}">${r.rvol == null ? "—" : r.rvol >= d.thresholds.rvol_min ? `<b>${emvX(r.rvol)}</b>` : emvX(r.rvol)}</td>
      <td class="l">${(r.flags || []).map((f) => `<span class="emv-flag" title="${esc(EMV_FLAGS[f][1])}">${EMV_FLAGS[f][0]}</span>`).join("")}</td></tr>`;
  }).join("") : `<tr><td class="l" colspan="10"><div class="empty">${tab === "events" ? "No events priced within the next two weeks." : "No stocks flagged today."}</div></td></tr>`;
  document.querySelectorAll("#emvTable th[data-k]").forEach((th) => {
    th.classList.toggle("sorted", th.dataset.k === k);
    th.dataset.dir = th.dataset.k === k ? (dir > 0 ? "▲" : "▼") : "";
  });
  $("emvCap").textContent = tab === "events"
    ? "Event move: the extra variance priced between two expirations, beyond the stock's usual daily variance. “By” is the expiration that first includes it."
    : "1-sigma moves priced at the close (about 68% of outcomes fall inside). Size, not direction.";
  $("emvFoot").textContent = "Click a stock to open its TRACE. Flags are in test: they come from a short sample and show here with their own forward test until it has enough sessions. Low realized volatility did not lead to larger moves in 11 years of daily data, so the page does not flag it.";
}

$("emvSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-v]"); if (!b || b.dataset.v === emv.tab) return;
  emv.tab = b.dataset.v; store.set("emvTab", emv.tab);
  if (emv.tab === "events" && emv.sort === "m5") emv.sort = "ev";
  else if (emv.tab !== "events" && emv.sort === "ev") emv.sort = "m5";
  renderMoves();
});
$("emvTable").querySelector("thead").addEventListener("click", (e) => {
  const th = e.target.closest("th[data-k]"); if (!th) return;
  if (emv.sort === th.dataset.k) emv.dir = -emv.dir; else { emv.sort = th.dataset.k; emv.dir = th.dataset.k === "sym" ? 1 : -1; }
  renderMoves();
});
$("emvBody").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-s]"); if (!tr) return;
  $("symbol").value = tr.dataset.s; $("spotInput").value = "";
  setMode("analysis");
  if (state.view !== "map") setView("map");
  load();
});
