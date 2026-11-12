"use strict";
/* ============================================================ Calendario economico
   - Tarjeta (Summary y Calendar): al pasar el raton o tocar un evento, Actual, Forecast y Previous.
   - Pagina Calendar: 11 paises de 14 dias atras a 28 adelante, filtro de paises e importancia (preferencias).
     Los dias y las horas van en la hora local del usuario (un dato de Japon a las 18:50 de Nueva York es el dia
     siguiente en Europa).
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
const calImp = (e) => +e.imp | 0;
// fecha local (YYYY-MM-DD) de un Date
const calIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// dia local del evento; los de dia entero se quedan en su fecha
const calDia = (e) => { const t = calWhen(e); return t ? calIso(t) : e.date; };

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
  const t = calWhen(e), d = suDate(calDia(e));
  const cuando = `${SU_DIA[d.getDay()]} ${SU_MES[d.getMonth()]} ${d.getDate()}${t ? ", " + hhmm(t) : ""}`;
  return `<div class="cal-tip-h"><b>${esc(calTitle(e))}</b>${calImpBars(calImp(e))}</div>
    <div class="cal-tip-s">${esc(CAL_NOMBRE[e.country || "US"] || e.country)}, ${cuando}</div>
    <dl class="cal-tip-n"><div><dt>Actual</dt><dd>${calActual(e)}</dd></div>
    <div><dt>Forecast</dt><dd>${esc(e.forecast || "—")}</dd></div><div><dt>Previous</dt><dd>${esc(e.previous || "—")}</dd></div></dl>`;
}

let calTipEl = null, calTipK = "";   // clave del evento de la tarjeta abierta
function calTip(el) {
  const e = el && calEv.get(el.dataset.cal);
  if (!e) { if (calTipEl) calTipEl.hidden = true; calTipK = ""; return; }
  if (!calTipEl) { calTipEl = document.createElement("div"); calTipEl.className = "cal-tip"; calTipEl.setAttribute("role", "tooltip"); document.body.appendChild(calTipEl); }
  calTipK = el.dataset.cal;
  calTipEl.innerHTML = calCard(e);
  calTipEl.hidden = false;
  const r = el.getBoundingClientRect(), w = calTipEl.offsetWidth, h = calTipEl.offsetHeight;
  const x = Math.max(8, Math.min(r.left, innerWidth - w - 8));
  const y = r.bottom + 6 + h > innerHeight ? r.top - h - 6 : r.bottom + 6;
  calTipEl.style.left = `${x}px`; calTipEl.style.top = `${Math.max(8, y)}px`;
}
// tras volver a pintar (recarga de datos), la tarjeta abierta toma los datos nuevos del mismo evento
function calTipRefresh() {
  if (!calTipEl || calTipEl.hidden || !calTipK) return;
  const e = calEv.get(calTipK);
  if (e) calTipEl.innerHTML = calCard(e); else calTip(null);
}
document.addEventListener("pointerover", (ev) => { if (ev.pointerType !== "touch") calTip(ev.target.closest("[data-cal]")); });
document.addEventListener("focusin", (ev) => calTip(ev.target.closest("[data-cal]")));
// con el raton la tarjeta ya sale al pasar por encima; el clic solo abre y cierra en pantallas tactiles
document.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-cal]");
  if (el && ev.pointerType === "mouse") return;
  calTip(el && el.dataset.cal !== calTipK ? el : null);
});
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  calTip(null);
  const d = $("calPaisesBox");
  if (d && d.open) { d.open = false; d.querySelector("summary").focus(); }
});
addEventListener("scroll", () => calTip(null), { passive: true, capture: true });

// ------------------------------------------------------------ pagina Calendar
// lunes: semana que se ve (fecha local); movida: el usuario ha cambiado de semana con las flechas
const cal = { data: null, at: 0, ctrl: null, lunes: null, movida: false };
const calLunes = (iso) => { const d = suDate(iso); return suAdd(iso, -((d.getDay() + 6) % 7)); };
function calPaisesSel() {
  try { const a = JSON.parse(store.get("calPaises", "null")); if (Array.isArray(a)) return new Set(a); } catch { /* */ }
  return new Set(CAL_PAISES.map((p) => p[0]));
}
const calImpMin = () => +store.get("calImp", "2");

// estado de la barra superior: "YYYY-MM-DD HH:MM" en UTC
const calStatusTxt = () => (cal.data && cal.data.actualizado ? `Calendar updated ${localTime(cal.data.actualizado.replace(" ", "T") + ":00Z", true)}` : "Calendar");

function showCal() {
  renderCal();   // con o sin datos: deja la semana, los filtros y las flechas listos
  if (cal.data) setStatus("", calStatusTxt());
  if (!cal.data || Date.now() - cal.at > 60000) loadCal();
}

async function loadCal(refresh = false) {
  if (cal.ctrl) cal.ctrl.abort();
  cal.ctrl = new AbortController();
  $("refreshBtn").classList.add("spin");
  // la recarga de cada minuto no cambia el estado: solo la primera carga y la que pide el usuario
  if (!cal.data || refresh) setStatus("busy", "Loading the calendar…");
  if (!cal.data) $("calTable").innerHTML = `<tbody><tr><td class="empty">Loading the calendar…</td></tr></tbody>`;
  try {
    const r = await fetch("/api/calendario" + (refresh ? "?refresh=1" : ""), { signal: cal.ctrl.signal });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !Array.isArray(d.eventos)) throw new Error(d.error || "Could not load the calendar");
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

// casillas de paises: se crean una vez; al pintar solo se marcan (asi no se pierde el foco del teclado)
function calPaisesInit() {
  $("calPaises").innerHTML = CAL_PAISES.map(([c, n]) => `<label><input type="checkbox" value="${c}"> ${esc(n)}</label>`).join("");
}

function renderCal() {
  const evs = (cal.data && cal.data.eventos) || [];
  const hoy = calIso(new Date());
  // pestaña abierta de un dia para otro: si el usuario no ha navegado, se pasa a la semana nueva
  if (!cal.lunes || (!cal.movida && cal.lunes !== calLunes(hoy))) { cal.lunes = calLunes(hoy); cal.movida = false; }
  const fin = suAdd(cal.lunes, 6), sel = calPaisesSel(), min = calImpMin();
  const dias = evs.map(calDia).sort();
  const lo = dias.length ? calLunes(dias[0]) : cal.lunes, hi = dias.length ? dias[dias.length - 1] : fin;
  $("calPrev").disabled = cal.lunes <= lo; $("calNext").disabled = fin >= hi;
  const a = suDate(cal.lunes), b = suDate(fin);
  $("calWeek").textContent = `${SU_MES[a.getMonth()]} ${a.getDate()} to ${SU_MES[b.getMonth()]} ${b.getDate()}`;
  $("calPaisesN").textContent = sel.size === CAL_PAISES.length ? "(all)" : `(${sel.size})`;
  document.querySelectorAll("#calPaises input").forEach((x) => { x.checked = sel.has(x.value); });
  document.querySelectorAll("#calImpSeg button").forEach((x) => x.setAttribute("aria-checked", String(+x.dataset.v === min)));
  const vis = evs.filter((e) => { const d = calDia(e); return d >= cal.lunes && d <= fin && sel.has(e.country || "US") && calImp(e) >= min; });
  const ahora = new Date(), cuando = (e) => { const t = calWhen(e); return t ? t.getTime() : -Infinity; };
  const prox = vis.filter((e) => cuando(e) > ahora.getTime()).sort((x, y) => cuando(x) - cuando(y))[0];
  let html = `<thead><tr><th>Time</th><th>Country</th><th>Event</th><th>Impact</th><th>Actual</th><th>Forecast</th><th>Previous</th></tr></thead>`;
  for (let i = 0; i < 7; i++) {
    const x = suAdd(cal.lunes, i), dia = vis.filter((e) => calDia(e) === x).sort((p, q) => cuando(p) - cuando(q) || calImp(q) - calImp(p));
    if (!dia.length) continue;
    const D = suDate(x);
    html += `<tbody${x === hoy ? ' class="hoy"' : ""}><tr class="cal-dia"><th colspan="7">${x === hoy ? "Today, " : ""}${SU_DIA[D.getDay()]} ${SU_MES[D.getMonth()]} ${D.getDate()}</th></tr>`
      + dia.map((e) => { const t = calWhen(e), imp = calImp(e);
        return `<tr data-cal="${calReg(e)}" class="i${imp}${e === prox ? " prox" : ""}"><td class="num">${t ? hhmm(t) : "All day"}</td><td><span class="cal-pais">${esc(e.country || "US")}</span></td>`
          + `<td class="cal-ev">${esc(calTitle(e))}<span class="cal-fp">F ${esc(e.forecast || "—")}, P ${esc(e.previous || "—")}</span></td><td>${calImpBars(imp)}</td>`
          + `<td class="num">${calActual(e)}</td><td class="num cal-f">${esc(e.forecast || "—")}</td><td class="num cal-f">${esc(e.previous || "—")}</td></tr>`; }).join("")
      + `</tbody>`;
  }
  if (!vis.length) html += `<tbody><tr><td class="empty" colspan="7">${cal.data ? "No releases for these countries and impact this week." : "Loading the calendar…"}</td></tr></tbody>`;
  $("calTable").innerHTML = html;
  calTipRefresh();
}

function bindCal() {
  calPaisesInit();
  const mover = (n) => { if (!cal.lunes) return; cal.lunes = suAdd(cal.lunes, n); cal.movida = true; renderCal(); };
  $("calPrev").addEventListener("click", () => mover(-7));
  $("calNext").addEventListener("click", () => mover(7));
  $("calToday").addEventListener("click", () => { cal.lunes = null; cal.movida = false; renderCal(); });
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
