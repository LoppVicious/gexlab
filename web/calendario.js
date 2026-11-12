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
