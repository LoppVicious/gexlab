"use strict";
/* ============================================================ Calendario economico
   - Tarjeta (Summary y Calendar): al pasar el raton o tocar un evento, Actual, Forecast y Previous.
   - Pagina Calendar: 11 paises de 14 dias atras a 28 adelante, filtro de paises e importancia (preferencias).
   Datos: /api/calendario (motor: eventos.py con ForexFactory y fuentes oficiales; reales.py, BLS y FRED). Los
   elementos con data-cal="clave" abren la tarjeta. Solo EE. UU. tiene dato real (e.real). */

const CAL_PAISES = [["US", "United States"], ["EZ", "Euro Area"], ["DE", "Germany"], ["FR", "France"], ["IT", "Italy"],
  ["GB", "United Kingdom"], ["JP", "Japan"], ["CN", "China"], ["CA", "Canada"], ["AU", "Australia"], ["CH", "Switzerland"]];
const CAL_NOMBRE = Object.fromEntries(CAL_PAISES);
const CAL_IMP = ["", "Low", "Medium", "High"];
const calEv = new Map();   // clave -> evento, para la tarjeta

const calKey = (e) => `${e.country || "US"}|${e.date}|${e.time}|${e.name}`;
function calReg(e) { const k = calKey(e); calEv.set(k, e); return esc(k); }
const calWhen = (e) => (e.time ? nyDate(`${e.date} ${e.time}`) : null);
const calTitle = (e) => e.titulo || e.name;

// "194K", "-0.4%", "1,710K", "15.6B" -> {v, u}; null si no es una cifra
function calNum(s) {
  const m = /^(-?[\d,]*\.?\d+)\s*([%KMBT]?)$/i.exec(String(s || "").trim());
  return m ? { v: parseFloat(m[1].replace(/,/g, "")), u: m[2].toUpperCase() } : null;
}
// direccion del dato frente al consenso (no dice si es bueno o malo)
function calCmp(e) {
  const a = calNum(e.actual), f = calNum(e.forecast);
  if (!a || !f || a.u !== f.u || a.v === f.v) return "";
  return a.v > f.v ? "pos" : "neg";
}
function calActual(e) {
  if (e.actual) return `<b class="${calCmp(e)}">${esc(e.actual)}</b>`;
  const t = calWhen(e);
  return e.real && t && t <= new Date() ? `<b class="pend">Pending</b>` : "<b>—</b>";
}
function calImpBars(imp) { return `<i class="imp i${imp}" title="${CAL_IMP[imp] || ""} impact"><u></u><u></u><u></u></i>`; }

function calCard(e) {
  const t = calWhen(e), d = suDate(e.date);
  const cuando = `${SU_DIA[d.getDay()]} ${SU_MES[d.getMonth()]} ${d.getDate()}${t ? ", " + hhmm(t) : ""}`;
  return `<div class="cal-tip-h"><b>${esc(calTitle(e))}</b>${calImpBars(e.imp)}</div>
    <div class="cal-tip-s">${esc(CAL_NOMBRE[e.country || "US"] || e.country)}, ${cuando}</div>
    <dl class="cal-tip-n"><div><dt>Actual</dt><dd>${calActual(e)}</dd></div>
    <div><dt>Forecast</dt><dd>${esc(e.forecast || "—")}</dd></div><div><dt>Previous</dt><dd>${esc(e.previous || "—")}</dd></div></dl>`;
}

let calTipEl = null;
function calTip(el) {
  const e = el && calEv.get(el.dataset.cal);
  if (!e) { if (calTipEl) calTipEl.hidden = true; return; }
  if (!calTipEl) { calTipEl = document.createElement("div"); calTipEl.className = "cal-tip"; calTipEl.setAttribute("role", "tooltip"); document.body.appendChild(calTipEl); }
  calTipEl.innerHTML = calCard(e);
  calTipEl.hidden = false;
  const r = el.getBoundingClientRect(), w = calTipEl.offsetWidth, h = calTipEl.offsetHeight;
  const x = Math.max(8, Math.min(r.left, innerWidth - w - 8));
  const y = r.bottom + 6 + h > innerHeight ? r.top - h - 6 : r.bottom + 6;
  calTipEl.style.left = `${x}px`; calTipEl.style.top = `${Math.max(8, y)}px`;
}
document.addEventListener("pointerover", (ev) => { if (ev.pointerType !== "touch") calTip(ev.target.closest("[data-cal]")); });
document.addEventListener("focusin", (ev) => calTip(ev.target.closest("[data-cal]")));
document.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-cal]");
  calTip(el && !(calTipEl && !calTipEl.hidden && calTipEl.dataset.k === el.dataset.cal) ? el : null);
  if (calTipEl) calTipEl.dataset.k = el && !calTipEl.hidden ? el.dataset.cal : "";
});
addEventListener("scroll", () => calTip(null), { passive: true, capture: true });

// ------------------------------------------------------------ pagina Calendar
const cal = { data: null, at: 0, ctrl: null, lunes: null };
const calLunes = (iso) => { const d = suDate(iso); return suAdd(iso, -((d.getDay() + 6) % 7)); };
function calPaisesSel() {
  try { const a = JSON.parse(store.get("calPaises", "null")); if (Array.isArray(a)) return new Set(a); } catch { /* */ }
  return new Set(CAL_PAISES.map((p) => p[0]));
}
const calImpMin = () => +store.get("calImp", "2");
// fecha de hoy en Nueva York (YYYY-MM-DD)
function calHoyNY() { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date()); }

// estado de la barra superior: "YYYY-MM-DD HH:MM" en UTC
const calStatusTxt = () => (cal.data && cal.data.actualizado ? `Calendar updated ${localTime(cal.data.actualizado.replace(" ", "T") + ":00Z", true)}` : "Calendar");

function showCal() {
  if (cal.data) { renderCal(); setStatus("", calStatusTxt()); }
  if (!cal.data || Date.now() - cal.at > 60000) loadCal();
}

async function loadCal(refresh = false) {
  if (cal.ctrl) cal.ctrl.abort();
  cal.ctrl = new AbortController();
  $("refreshBtn").classList.add("spin");
  setStatus("busy", "Loading the calendar…");
  if (!cal.data) $("calTable").innerHTML = `<tbody><tr><td class="empty">Loading the calendar…</td></tr></tbody>`;
  try {
    const r = await fetch("/api/calendario" + (refresh ? "?refresh=1" : ""), { signal: cal.ctrl.signal });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Could not load the calendar");
    cal.data = d; cal.at = Date.now();
    if (state.mode === "calendar") { renderCal(); setStatus("", calStatusTxt()); }
  } catch (e) {
    if (e.name === "AbortError") return;
    if (state.mode === "calendar") {
      setStatus("err", cal.data ? "Could not refresh" : "No data");
      if (!cal.data) $("calTable").innerHTML = `<tbody><tr><td class="empty">${esc(e.message === "Failed to fetch" ? "The local server is not responding. Open GEX Lab again." : e.message)}</td></tr></tbody>`;
    }
  } finally { $("refreshBtn").classList.remove("spin"); }
}

function renderCal() {
  const evs = (cal.data && cal.data.eventos) || [];
  const hoy = calHoyNY();
  if (!cal.lunes) cal.lunes = calLunes(hoy);
  const fin = suAdd(cal.lunes, 6), sel = calPaisesSel(), min = calImpMin();
  const lo = evs.length ? calLunes(evs[0].date) : cal.lunes, hi = evs.length ? evs[evs.length - 1].date : fin;
  $("calPrev").disabled = cal.lunes <= lo; $("calNext").disabled = fin >= hi;
  const a = suDate(cal.lunes), b = suDate(fin);
  $("calWeek").textContent = `${SU_MES[a.getMonth()]} ${a.getDate()} to ${SU_MES[b.getMonth()]} ${b.getDate()}`;
  $("calPaisesN").textContent = sel.size === CAL_PAISES.length ? "(all)" : `(${sel.size})`;
  $("calPaises").innerHTML = CAL_PAISES.map(([c, n]) => `<label><input type="checkbox" value="${c}"${sel.has(c) ? " checked" : ""}> ${esc(n)}</label>`).join("");
  document.querySelectorAll("#calImpSeg button").forEach((x) => x.setAttribute("aria-checked", String(+x.dataset.v === min)));
  const vis = evs.filter((e) => e.date >= cal.lunes && e.date <= fin && sel.has(e.country || "US") && e.imp >= min);
  const ahora = new Date(), prox = vis.find((e) => { const t = calWhen(e); return t && t > ahora; });
  let html = `<thead><tr><th>Time</th><th>Country</th><th>Event</th><th>Impact</th><th>Actual</th><th>Forecast</th><th>Previous</th></tr></thead>`;
  for (let i = 0; i < 7; i++) {
    const x = suAdd(cal.lunes, i), dia = vis.filter((e) => e.date === x);
    if (!dia.length) continue;
    const D = suDate(x);
    html += `<tbody${x === hoy ? ' class="hoy"' : ""}><tr class="cal-dia"><th colspan="7">${x === hoy ? "Today, " : ""}${SU_DIA[D.getDay()]} ${SU_MES[D.getMonth()]} ${D.getDate()}</th></tr>`
      + dia.map((e) => { const t = calWhen(e);
        return `<tr data-cal="${calReg(e)}" class="i${e.imp}${e === prox ? " prox" : ""}"><td class="num">${t ? hhmm(t) : "All day"}</td><td><span class="cal-pais">${esc(e.country || "US")}</span></td>`
          + `<td class="cal-ev">${esc(calTitle(e))}<span class="cal-fp">F ${esc(e.forecast || "—")}, P ${esc(e.previous || "—")}</span></td><td>${calImpBars(e.imp)}</td>`
          + `<td class="num">${calActual(e)}</td><td class="num cal-f">${esc(e.forecast || "—")}</td><td class="num cal-f">${esc(e.previous || "—")}</td></tr>`; }).join("")
      + `</tbody>`;
  }
  if (!vis.length) html += `<tbody><tr><td class="empty" colspan="7">No releases for these countries and impact this week.</td></tr></tbody>`;
  $("calTable").innerHTML = html;
}

function bindCal() {
  $("calPrev").addEventListener("click", () => { cal.lunes = suAdd(cal.lunes, -7); renderCal(); });
  $("calNext").addEventListener("click", () => { cal.lunes = suAdd(cal.lunes, 7); renderCal(); });
  $("calToday").addEventListener("click", () => { cal.lunes = null; renderCal(); });
  $("calPaises").addEventListener("change", () => {
    store.set("calPaises", JSON.stringify([...document.querySelectorAll("#calPaises input:checked")].map((x) => x.value)));
    renderCal();
  });
  document.querySelector(".cal-paises-all").addEventListener("click", (e) => {
    const b = e.target.closest("[data-todos]");
    if (!b) return;
    store.set("calPaises", JSON.stringify(b.dataset.todos === "1" ? CAL_PAISES.map((p) => p[0]) : []));
    renderCal();
  });
  $("calImpSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]");
    if (b) { store.set("calImp", b.dataset.v); renderCal(); }
  });
  document.addEventListener("click", (e) => { const d = $("calPaisesBox"); if (d.open && !d.contains(e.target)) d.open = false; });
  // abierta: se recarga cada minuto (el motor publica el dato real un par de minutos despues del evento)
  setInterval(() => { if (state.mode === "calendar" && !document.hidden) loadCal(); }, 60000);
}
document.addEventListener("DOMContentLoaded", bindCal);
