"use strict";
/* ============================================================ Sentimiento por put/call (Signals, Sentiment)
   Datos: /api/pcr (pcr.py, lo publica historial500.py tras cada cierre). Puntuacion 1-100 de cada ticker frente a su
   propia historia (100 = codicia: menos puts que lo normal), por tramos de vencimiento, con divergencias frente al
   precio. A la izquierda el mercado; a la derecha el grafico del ticker elegido y la tabla.
   Nombres con prefijo sen: los scripts de web/ comparten globales. */

const sen = { data: null, at: 0, ctrl: null, sym: store.get("senSym", "SPY"), sort: "score", dir: 1 };
const senLabel = (s) => (s == null ? "" : s <= 20 ? "Fear" : s < 40 ? "Leaning fear" : s <= 60 ? "Neutral" : s < 80 ? "Leaning greed" : "Greed");
const senCls = (s) => (s == null ? "" : s < 40 ? "neg" : s > 60 ? "pos" : "");
const senNum = (s) => (s == null ? "—" : fmtNum(s, 0));
const senSigned = (v) => (v == null ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "") + fmtNum(Math.abs(v), 0));

function senStatus() { return sen.data ? `Put/call sentiment, close of ${ddmm(sen.data.date)}` : ""; }

function showSent() {
  if (sen.data) { renderSent(); setStatus("", senStatus()); }
  if (!sen.data || Date.now() - sen.at > 300000) loadSent();
}

async function loadSent() {
  if (sen.ctrl) sen.ctrl.abort();
  sen.ctrl = new AbortController();
  $("refreshBtn").classList.add("spin");
  setStatus("busy", "Loading the put/call sentiment…");
  if (!sen.data) $("senBody").innerHTML = `<tr><td class="l" colspan="7"><div class="empty">Loading…</div></td></tr>`;
  try {
    const r = await fetch("/api/pcr", { signal: sen.ctrl.signal });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Could not load the sentiment");
    sen.data = d; sen.at = Date.now();
    if (state.mode === "sentiment") { renderSent(); setStatus("", senStatus()); }
  } catch (e) {
    if (e.name === "AbortError") return;
    if (state.mode === "sentiment") {
      setStatus("err", sen.data ? "Could not refresh" : "No data");
      if (!sen.data) $("senBody").innerHTML = `<tr><td class="l" colspan="7"><div class="empty">${esc(e.message === "Failed to fetch" ? "The local server is not responding. Open GEX Lab again." : e.message)}</div></td></tr>`;
    }
  } finally { $("refreshBtn").classList.remove("spin"); }
}

// medidor 1-100 del agregado de las acciones: rojo de miedo (1-20), neutro, verde de codicia (80-100)
function senGauge(s) {
  const W = 220, H = 120, r = 90, cx = W / 2, cy = 105;
  const pt = (v, rr = r) => { const a = Math.PI * (1 - (v - 1) / 99); return [cx + rr * Math.cos(a), cy - rr * Math.sin(a)]; };
  const arc = (a, b, col) => { const [x1, y1] = pt(a), [x2, y2] = pt(b); return `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} A${r} ${r} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}" stroke="${col}" stroke-width="12" fill="none"/>`; };
  let g = arc(1, 20, C.neg) + arc(20, 80, C.axis) + arc(80, 100, C.pos);
  if (s != null) {
    const [x, y] = pt(s, r - 22);
    g += `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${C.text}" stroke-width="2.5" stroke-linecap="round"/><circle cx="${cx}" cy="${cy}" r="4" fill="${C.text}"/>`;
  }
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">${g}</svg>
    <div class="sen-gval"><b>${senNum(s)}</b><span class="ssk-tilt ${senCls(s)}">${senLabel(s) || "Building history"}</span></div>`;
}

// la señal de swing (skew.py) ya tiene sesiones suficientes a 40 sesiones
function senValidated(d) {
  const e = d.swing && d.swing.eval && d.swing.eval["40"];
  return !!(e && e.enough);
}

function renderSent() {
  const d = sen.data;
  if (!d) return;
  const m = d.market, stk = m.stocks || {}, b = m.breadth;
  const falta = Math.max(0, d.min_sessions - d.sessions);
  const st = $("senState");
  st.textContent = falta ? "Collecting data" : senValidated(d) ? "Tested" : "Not validated yet";
  st.className = "mstate " + (falta || !senValidated(d) ? "mixed" : "contango");
  $("senSub").textContent = `${d.rows.length} tickers, close of ${longDate(d.date)}. ${d.sessions} session${d.sessions === 1 ? "" : "s"} since ${ddmm(d.first)}`;
  $("senGauge").innerHTML = senGauge(stk.score);
  $("senRead").textContent = stk.score == null
    ? `Each ticker needs ${d.min_sessions} sessions of its own history before it gets a score${falta ? `: ${falta} more to go` : ""}. Until then the table shows the raw put/call ratios.`
    : `Stocks as a whole: ${senLabel(stk.score).toLowerCase()}.${b.n ? ` ${fmtNum(b.fear_pct, 0)}% of the stocks in fear (under 20) and ${fmtNum(b.greed_pct, 0)}% in greed (over 80).` : ""}`;
  const fact = (l, v, s) => `<div class="fact"><span class="fl">${l}</span><strong>${v}</strong><span class="fs">${s}</span></div>`;
  const ix = Object.entries(m.indices).map(([s, x]) => fact(s, senNum(x.score),
    x.score == null ? `${x.n} of ${d.min_sessions} sessions` : `${senLabel(x.score)}, 5d ${senSigned(x.chg5)}`)).join("");
  const dl = (k, t) => {
    const x = d.divergences[k];
    const h = x.n40 ? [40, x.ret40, x.hit40] : x.n10 ? [10, x.ret10, x.hit10] : null;
    return fact(t, String(x.n), h ? `after ${h[0]} sessions ${fmtNum(h[1] * 100, 1)}% on average, ${fmtNum(h[2] * 100, 0)}% right` : "too recent to judge");
  };
  $("senFacts").innerHTML = fact("Median stock", senNum(b.median), `${b.n} stocks with a score`) + ix +
    dl("bear", "Bearish divergences") + dl("bull", "Bullish divergences");
  renderSentTable(d);
  renderSentTicker(d);
}

function renderSentTable(d) {
  const k = sen.sort, dir = sen.dir;
  const val = (r) => (k === "sym" ? r.sym : k === "div" ? (r.div ? r.div.type : null)
    : k === "score" || k === "chg5" ? r[k] : r.tranches[k].score);
  const rows = [...d.rows].sort((a, b) => {
    const x = val(a), y = val(b);
    if (k === "sym" || k === "div") return dir * String(x ?? "~").localeCompare(String(y ?? "~"));
    if (x == null) return 1; if (y == null) return -1;
    return dir * (x - y);
  });
  // sin historia suficiente, el P/C bruto del tramo
  const cell = (t) => (t.score != null ? `<span class="ssk-bar"><i style="width:${t.score}%"></i></span>${senNum(t.score)}`
    : t.pc != null ? `<span class="ssk-tilt">P/C ${fmtNum(t.pc, 2)}</span>` : "—");
  $("senBody").innerHTML = rows.map((r) => `<tr data-s="${esc(r.sym)}" class="${r.sym === sen.sym ? "on" : ""}" title="${esc(r.name || r.sym)}">
    <td class="l"><b>${esc(r.sym)}</b></td>
    <td><span class="ssk-tilt ${senCls(r.score)}">${r.score == null ? `${r.n}/${d.min_sessions}` : senNum(r.score)}</span></td>
    ${["t0", "t1", "t2"].map((t) => `<td>${cell(r.tranches[t])}</td>`).join("")}
    <td>${senSigned(r.chg5)}</td>
    <td class="l">${r.div ? `<span class="ssk-tilt ${r.div.type === "bear" ? "neg" : "pos"}">${r.div.type === "bear" ? "▼ Bearish" : "▲ Bullish"}, ${ddmm(r.div.date)}</span>` : ""}</td></tr>`).join("");
  document.querySelectorAll("#senTable th[data-k]").forEach((th) => {
    th.classList.toggle("sorted", th.dataset.k === k);
    th.dataset.dir = th.dataset.k === k ? (dir > 0 ? "▲" : "▼") : "";
  });
  $("senFoot").textContent = "Until a ticker has its own history the cells show its raw put/call ratio (delta-weighted, out of the money). The swing test of this signal is on the Skew signal page (Put/call).";
}

// precio arriba, puntuacion abajo (bandas 20 y 80), con el mismo eje de fechas
function renderSentTicker(d) {
  const ser = d.series[sen.sym] || [];
  const row = d.rows.find((r) => r.sym === sen.sym);
  $("senChartTitle").textContent = row ? `${sen.sym}: price and sentiment` : "Click a ticker";
  const el = $("senChart");
  if (!row || ser.length < 2) {
    el.innerHTML = `<div class="empty">${row ? `Not enough history for ${esc(sen.sym)} yet.` : "Click a ticker in the table."}</div>`;
    $("senExp").innerHTML = ""; $("senCap").textContent = "";
    return;
  }
  const W = Math.max(320, el.clientWidth || 640), H = 260, L = 48, R = 12, T = 10, mid = 150, B = 22;
  const x = (i) => L + (i / (ser.length - 1)) * (W - L - R);
  const ps = ser.map((p) => p[1]).filter((v) => v != null);
  const lo = Math.min(...ps), hi = Math.max(...ps), sp = hi - lo || 1;
  const yp = (v) => T + (1 - (v - lo) / sp) * (mid - T - 14);
  const ys = (v) => mid + 8 + (1 - (v - 1) / 99) * (H - B - mid - 8);
  const path = (k, y) => {
    let s = "", on = false;
    ser.forEach((p, i) => { if (p[k] == null) { on = false; return; } s += `${on ? "L" : "M"}${x(i).toFixed(1)} ${y(p[k]).toFixed(1)}`; on = true; });
    return s;
  };
  const lab = (v) => fmtNum(v, v < 100 ? 2 : 0);
  let g = `<line x1="${L}" x2="${W - R}" y1="${ys(80)}" y2="${ys(80)}" stroke="${C.pos}" stroke-dasharray="3 3" opacity=".6"/>
    <line x1="${L}" x2="${W - R}" y1="${ys(20)}" y2="${ys(20)}" stroke="${C.neg}" stroke-dasharray="3 3" opacity=".6"/>
    <text x="${L - 6}" y="${ys(80) + 4}" text-anchor="end" fill="${C.faint}" font-size="10">80</text>
    <text x="${L - 6}" y="${ys(20) + 4}" text-anchor="end" fill="${C.faint}" font-size="10">20</text>
    ${ps.length ? `<text x="${L - 6}" y="${yp(hi) + 4}" text-anchor="end" fill="${C.faint}" font-size="10">${lab(hi)}</text>
    <text x="${L - 6}" y="${yp(lo) + 4}" text-anchor="end" fill="${C.faint}" font-size="10">${lab(lo)}</text>
    <path d="${path(1, yp)}" stroke="${C.text}" stroke-width="1.6" fill="none"/>` : ""}
    <path d="${path(2, ys)}" stroke="${C.accent}" stroke-width="1.8" fill="none"/>
    <text x="${L}" y="${H - 6}" fill="${C.faint}" font-size="10">${ddmm(ser[0][0])}</text>
    <text x="${W - R}" y="${H - 6}" text-anchor="end" fill="${C.faint}" font-size="10">${ddmm(ser[ser.length - 1][0])}</text>`;
  if (row.div) {
    const i = ser.findIndex((p) => p[0] === row.div.date);
    if (i >= 0 && ser[i][1] != null) g += `<circle cx="${x(i).toFixed(1)}" cy="${yp(ser[i][1]).toFixed(1)}" r="5" fill="none" stroke="${row.div.type === "bear" ? C.neg : C.pos}" stroke-width="2"/>`;
  }
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${g}</svg>`;
  const ex = (d.expiries[sen.sym] || []).slice(0, 12);
  $("senExp").innerHTML = ex.length ? `<table class="scan sen-exp-t"><thead><tr><th class="l">Expiration</th><th>Days</th><th>P/C volume</th><th>P/C open interest</th></tr></thead><tbody>${ex.map((e) =>
    `<tr><td class="l">${ddmm(e.exp)}</td><td>${e.dte}</td><td>${e.pc_vol == null ? "—" : fmtNum(e.pc_vol, 2)}</td><td>${e.pc_oi == null ? "—" : fmtNum(e.pc_oi, 2)}</td></tr>`).join("")}</tbody></table>` : "";
  $("senCap").textContent = `Price (top) and combined score (bottom, 1 to 100; dashed lines at 20 and 80). Put/call by expiration on ${ddmm(d.date)}: out-of-the-money options weighted by delta.`;
}

$("senTable").querySelector("thead").addEventListener("click", (e) => {
  const th = e.target.closest("th[data-k]"); if (!th) return;
  if (sen.sort === th.dataset.k) sen.dir = -sen.dir; else { sen.sort = th.dataset.k; sen.dir = 1; }
  renderSent();
});
$("senBody").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-s]"); if (!tr) return;
  sen.sym = tr.dataset.s; store.set("senSym", sen.sym);
  renderSent();
});
