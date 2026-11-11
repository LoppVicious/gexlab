"use strict";
/* ============================================================ Panel de volatilidad (estilo Volatility Dashboard)
   Datos: /api/vol?symbol= (superficie del motor) y /api/eventos (calendario macro). Resumen arriba (IV30 sin
   modelo, realizada, prima de varianza, estructura, skew 30d y evento descontado) y cinco vistas:
   - Estructura temporal: IV ATM por vencimiento, IV forward, sesion anterior, hace una semana, banda 10-90, eventos
     del calendario y codos de la curva (movimiento de evento descontado)
   - Skew: IV por strike o por delta de los vencimientos elegidos, con la sesion anterior y la banda 10-90
   - Skew por vencimiento: risk reversal y butterfly de 25 delta
   - Realizada frente a implicita: cono de Yang-Zhang del ultimo ano con la IV ATM del mismo plazo
   - Matriz por strike fijo: IV por vencimiento y strike, coloreada por el cambio frente a la sesion anterior */

const vol = {
  data: null, sym: "", at: 0, ctrl: null, events: null, geo: null,
  tab: store.get("volTab", "term"),
  axis: store.get("volAxis", "strike"),
  sel: [],                                   // vencimientos elegidos en el skew
  show: Object.assign({ fwd: true, d1: true, w1: false, band: true, ev: true, cc: true, iv: true }, JSON.parse(store.get("volShow", "{}"))),
  mshow: store.get("volMat", "iv"),
  hor: store.get("volHor", "3m"),
};
const volH = () => ({ "1m": 32, "3m": 100, "6m": 190 }[vol.hor] || 100);   // horizonte en dias
const MTAG = '<span class="vm" title="Monthly expiration">M</span>';
const inH = (x) => x.dte <= volH();
// dias naturales hasta el vencimiento (sin decimales)
function volDays(x) {
  if (x.days != null) return x.days;
  const t = new Date(); const today = Date.UTC(t.getFullYear(), t.getMonth(), t.getDate());
  return Math.max(0, Math.round((Date.parse(x.exp + "T00:00:00Z") - today) / 86400000));
}
function horSeg() {
  return `<div class="seg boxed" role="radiogroup" id="volHorSeg" aria-label="Horizon"><button role="radio" data-v="1m" aria-checked="${vol.hor === "1m"}">1 month</button><button role="radio" data-v="3m" aria-checked="${vol.hor === "3m"}">3 months</button><button role="radio" data-v="6m" aria-checked="${vol.hor === "6m"}">6 months</button></div>`;
}
const volC = (j) => C.vol[j % C.vol.length];   // color de cada vencimiento del skew, segun el tema
const pct = (v, d = 1) => v == null ? "—" : fmtNum(v * 100, d) + "%";
const volDate = (iso) => { const d = new Date(iso + "T12:00:00"); return `${MESES[d.getMonth()]} ${d.getDate()}${d.getFullYear() !== new Date().getFullYear() ? " '" + String(d.getFullYear()).slice(2) : ""}`; };

function volColors() { return { band: document.documentElement.dataset.theme === "light" ? "rgba(124,92,240,.16)" : "rgba(110,100,220,.30)" }; }

function showVol() {
  setVolTab(vol.tab, true);
  const sym = state.symbol || "SPX";
  $("symbol").value = sym;
  if (!vol.data || vol.sym !== sym || Date.now() - vol.at > 300000) loadVol(); else { renderVol(); setStatus("", volStatus()); }
}

function volStatus() { return vol.data ? `Volatility at ${nyHHMM(vol.data.generado)}` : ""; }

async function loadVol(refresh = false) {
  const sym = (state.symbol || "SPX").toUpperCase();
  if (vol.ctrl) vol.ctrl.abort();
  vol.ctrl = new AbortController();
  $("refreshBtn").classList.add("spin");
  setStatus("busy", `Loading ${sym} volatility…`);
  $("volChart").classList.add("loading");
  try {
    const [r, ev] = await Promise.all([
      fetch(`/api/vol?symbol=${encodeURIComponent(sym)}${refresh ? "&refresh=1" : ""}`, { signal: vol.ctrl.signal }),
      vol.events ? Promise.resolve(null) : fetch("/api/eventos", { signal: vol.ctrl.signal }).then((x) => (x.ok ? x.json() : [])).catch(() => []),
    ]);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Could not read the volatility data");
    if (ev) vol.events = Array.isArray(ev) ? ev : (ev.eventos || []);
    const changed = vol.sym !== d.symbol;
    vol.data = d; vol.sym = d.symbol; vol.at = Date.now();
    if (changed || !vol.sel.length) vol.sel = defaultSkew(d);
    else vol.sel = vol.sel.filter((e) => d.smiles.some((s) => s.exp === e));
    if (!vol.sel.length) vol.sel = defaultSkew(d);
    $("volChart").classList.remove("loading");
    renderVol();
    setStatus("", volStatus());
  } catch (e) {
    if (e.name === "AbortError") return;
    $("volChart").classList.remove("loading");
    $("volChart").innerHTML = `<div class="placeholder err"><div><div class="err-t">${esc(e.message)}</div></div></div>`;
    setStatus("err", e.message);
  } finally { $("refreshBtn").classList.remove("spin"); }
}

function defaultSkew(d) {
  // el vencimiento mas cercano y el mas proximo a 30 dias
  const s = d.smiles || [];
  if (!s.length) return [];
  const near30 = s.reduce((a, b) => (Math.abs(b.dte - 30) < Math.abs(a.dte - 30) ? b : a));
  return [...new Set([s[0].exp, near30.exp])];
}

function setVolTab(t, silent) {
  vol.tab = t; store.set("volTab", t);
  $("volTabs").querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.v === t)));
  if (!silent) renderVol();
}

/* ------------------------------------------------------------ utilidades de dibujo */
function volFrame(W, H, inner) { return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${inner}</svg>`; }
function yGrid(yt, yOf, L, R, fs) {
  return yt.ticks.map((v) => `<line x1="${L}" x2="${R}" y1="${yOf(v)}" y2="${yOf(v)}" stroke="${C.grid}" stroke-dasharray="2 4"/>` +
    txt(L - 8, yOf(v) + 4, fmtNum(v * 100, v < 0.1 ? 1 : 0) + "%", { a: "end", fs })).join("");
}
function chip(id, label, on, color) {
  return `<button class="vchip${on ? " on" : ""}" data-k="${id}"${color ? ` style="--c:${color}"` : ""}><i></i>${label}</button>`;
}

/* ------------------------------------------------------------ estructura temporal */
function bandAt(d, dte) {
  const b = d.bands && d.bands.term;
  if (!b) return null;
  const xs = (d.term_grid || []).filter((n) => b[n]);
  if (xs.length < 2 || dte < xs[0] || dte > xs[xs.length - 1]) return null;
  let i = 0; while (i < xs.length - 2 && xs[i + 1] < dte) i++;
  const a = xs[i], c = xs[i + 1], w = (dte - a) / (c - a);
  return [b[a][0] + (b[c][0] - b[a][0]) * w, b[a][1] + (b[c][1] - b[a][1]) * w];
}

function renderTerm(W, H) {
  const d = vol.data, sh = vol.show;
  const pts = (d.term || []).filter(inH);
  if (pts.length < 2) return `<div class="placeholder">Not enough expirations for the term structure.</div>`;
  const narrow = W < 640, fs = narrow ? 10.5 : 11.5;
  const evs = sh.ev ? (vol.events || []).filter((e) => e.imp >= 2) : [];
  const L = narrow ? 44 : 58, R = W - (narrow ? 12 : 24), T = 34, B = H - (sh.ev && evs.length ? (narrow ? 120 : 150) : 44);
  const t0 = new Date(pts[0].exp + "T12:00:00").getTime() - 86400000 * Math.max(1, pts[0].dte);
  const t1 = new Date(pts[pts.length - 1].exp + "T12:00:00").getTime();
  // escala de tiempo comprimida (raiz) para que los vencimientos cercanos no se amontonen
  const f = (t) => Math.sqrt(Math.max(0, (t - t0) / 86400000));
  const xOf = (iso) => L + (f(new Date(iso + "T12:00:00").getTime()) / f(t1)) * (R - L);
  const lastExp0 = pts[pts.length - 1].exp;
  const prevT = (k) => ((d.prev && d.prev[k] && d.prev[k].term) || []).filter((p) => p.exp <= lastExp0);
  const series = [pts.map((p) => p.atm)];
  if (sh.fwd) series.push(pts.map((p) => p.fwd));
  if (sh.d1) series.push(prevT("1d").map((p) => p.atm));
  if (sh.w1) series.push(prevT("1w").map((p) => p.atm));
  const bands = sh.band ? pts.map((p) => bandAt(d, p.dte)) : [];
  const all = series.flat().concat(bands.filter(Boolean).flat()).filter((v) => v != null && isFinite(v));
  const yt = niceTicks(Math.min(...all) * 0.95, Math.max(...all) * 1.04, 5);
  const yOf = (v) => B - ((v - yt.lo) / (yt.hi - yt.lo)) * (B - T);
  let s = yGrid(yt, yOf, L, R, fs);
  // eventos macro: linea vertical y etiqueta girada abajo (como SpotGamma)
  const lastExp = pts[pts.length - 1].exp, today = new Date().toISOString().slice(0, 10);
  const shown = evs.filter((e) => e.date >= today && e.date <= lastExp);
  let lastX = -99;
  for (const e of shown) {
    const x = xOf(e.date);
    if (x - lastX < fs + 2) continue;
    lastX = x;
    s += `<line x1="${x}" x2="${x}" y1="${T}" y2="${B}" stroke="${C.axis}" stroke-width="1" stroke-dasharray="1 3"/>`;
    s += `<text transform="translate(${x + 4},${H - 6}) rotate(-90)" font-family="${SANS}" font-size="${fs}" fill="${e.imp >= 3 ? C.muted : C.faint}">${esc(e.name)}</text>`;
  }
  if (sh.band && bands.some(Boolean)) {
    const up = [], dn = [];
    pts.forEach((p, i) => { if (bands[i]) { up.push(`${xOf(p.exp)},${yOf(bands[i][1])}`); dn.unshift(`${xOf(p.exp)},${yOf(bands[i][0])}`); } });
    s += `<polygon points="${up.concat(dn).join(" ")}" fill="${volColors().band}"/>`;
  }
  const line = (arr, key, col, o = {}) => {
    const p = arr.filter((q) => q[key] != null);
    if (p.length < 2) return "";
    const path = p.map((q, i) => `${i ? "L" : "M"}${xOf(q.exp).toFixed(1)},${yOf(q[key]).toFixed(1)}`).join("");
    let out = `<path d="${path}" fill="none" stroke="${col}" stroke-width="${o.w || 2}" ${o.da ? `stroke-dasharray="${o.da}"` : ""} stroke-opacity="${o.op || 1}"/>`;
    if (o.dots) out += p.map((q) => `<circle cx="${xOf(q.exp)}" cy="${yOf(q[key])}" r="3.2" fill="${C.surface}" stroke="${col}" stroke-width="1.8"/>`).join("");
    return out;
  };
  if (sh.w1) s += line(prevT("1w"), "atm", C.faint, { da: "2 4", w: 1.6 });
  if (sh.d1) s += line(prevT("1d"), "atm", C.muted, { w: 1.6, op: 0.75 });
  if (sh.fwd) s += line(pts, "fwd", C.accent, { w: 1.4, op: 0.45 });
  s += line(pts, "atm", C.accent, { w: 2.4, dots: true });
  // tramos con un evento descontado (codo de la curva): movimiento de un dia que se paga de mas
  pts.filter((p) => p.event).forEach((p) => {
    const x = xOf(p.exp), y = yOf(p.atm);
    s += `<circle cx="${x}" cy="${y}" r="7" fill="none" stroke="${C.amber}" stroke-width="1.6"/>` + txt(x, y - 13, `±${fmtNum(p.event * 100, 1)}%`, { a: "middle", fs, c: C.amber });
  });
  // eje X: fechas de vencimiento (sin solapar)
  let lx = -99;
  for (const p of pts) {
    const x = xOf(p.exp), lab = volDate(p.exp), w = textW(lab, fs);
    if (x - lx < w + 10) continue;
    lx = x;
    // la ultima fecha no se sale por la derecha
    const cx = Math.min(x, W - 6 - w / 2);
    s += txt(cx, B + fs + 8, lab, { a: "middle", fs });
  }
  s += txt(R, B + fs * 2 + 14, "Expiration", { a: "end", fs, c: C.faint });
  s += `<text transform="translate(${narrow ? 10 : 14},${(T + B) / 2}) rotate(-90)" text-anchor="middle" font-family="${SANS}" font-size="${fs}" fill="${C.faint}">Implied volatility</text>`;
  s += `<line id="vhl" x1="0" x2="0" y1="${T}" y2="${B}" stroke="${C.spotline}" stroke-opacity=".6" visibility="hidden"/>`;
  vol.geo = { kind: "term", pts: pts.map((p) => ({ p, x: xOf(p.exp) })), T, B };
  return volFrame(W, H, s);
}

/* ------------------------------------------------------------ resumen de la superficie */
const pts2 = (v) => v == null ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "") + fmtNum(Math.abs(v * 100), 1) + " pts";
function volSummary() {
  const d = vol.data, s = d.summary;
  if (!s) return "";
  const tile = (k, v, sub, cls = "", tip = "") => `<div class="vstat"${tip ? ` title="${esc(tip)}"` : ""}><span class="k">${k}</span><span class="v ${cls}">${v}</span><span class="s">${sub}</span></div>`;
  const out = [];
  out.push(tile("IV30", pct(s.iv30 ?? s.atm30), s.iv30 != null ? `Model-free, like the ${d.symbol === "VIX" ? "VVIX" : "VIX"}. ATM: ${pct(s.atm30)}` : "ATM (no model-free value)",
    "", "30-day implied volatility from the whole strip of out-of-the-money options, with the VIX formula. On the SPX it matches the VIX."));
  if (d.realized) {
    const px = d.realized.proxy ? ` (from ${d.realized.proxy})` : "";
    out.push(tile("Realized 20d", pct(s.cc20), `Close-to-close${px}. Yang-Zhang: ${pct(s.rv20)}`, "",
      "Yang-Zhang also uses the open, high and low, but it barely counts a day that opens at the high and closes at the low."));
    out.push(tile("Variance premium", pts2(s.vrp), s.vrp == null ? "" : s.vrp >= 0 ? "Options price more than realized" : "Options price less than realized",
      s.vrp == null ? "" : s.vrp >= 0 ? "up" : "dn", "IV30 minus realized close-to-close volatility over the last 20 sessions."));
  }
  if (s.atm30 != null && s.atm90 != null) {
    const inv = s.atm30 > s.atm90, front = s.atm7 != null && s.atm7 > s.atm30;
    out.push(tile("Term structure", inv ? "Inverted" : front ? "Front-end bump" : "Upward", `7d ${pct(s.atm7)}, 30d ${pct(s.atm30)}, 90d ${pct(s.atm90)}`,
      inv ? "up" : "", "ATM implied volatility at 7, 30 and 90 days. Inverted (30 days above 90) is typical of stress or of an event close by."));
  }
  if (s.rr25 != null) out.push(tile("Skew 30d", pts2(s.rr25), `25Δ risk reversal. Butterfly: ${pts2(s.bf25)}`, "",
    "Risk reversal: IV of the 25-delta call minus the 25-delta put (negative: puts cost more). Butterfly: average of both wings minus ATM (the smile's curvature)."));
  out.push(tile("Event priced", s.event ? `±${fmtNum(s.event.move * 100, 1)}%` : "None", s.event ? `Stretch up to ${volDate(s.event.exp)}` : "No kink in the term structure",
    s.event ? "up" : "", "One-day move the options price on top of the normal variance of the term structure, in the stretch that ends at that expiration (earnings, Fed...)."));
  return out.join("");
}

/* ------------------------------------------------------------ forma del skew por vencimiento */
function renderShape(W, H) {
  const d = vol.data, sh = vol.show;
  const pts = (d.term || []).filter(inH).filter((p) => p.rr25 != null);
  if (pts.length < 2) return `<div class="placeholder">Not enough expirations with 25-delta options.</div>`;
  const narrow = W < 640, fs = narrow ? 10.5 : 11.5;
  const L = narrow ? 50 : 64, R = W - (narrow ? 12 : 24), T = 30, B = H - 44, gap = 34;
  const mid = T + (B - T - gap) / 2;
  const t0 = new Date(pts[0].exp + "T12:00:00").getTime() - 86400000 * Math.max(1, pts[0].dte);
  const t1 = new Date(pts[pts.length - 1].exp + "T12:00:00").getTime();
  const f = (t) => Math.sqrt(Math.max(0, (t - t0) / 86400000));
  const xOf = (iso) => L + (f(new Date(iso + "T12:00:00").getTime()) / f(t1)) * (R - L);
  const prev = ((d.prev && d.prev["1d"] && d.prev["1d"].term) || []).filter((p) => p.exp <= pts[pts.length - 1].exp && p.rr25 != null);
  let s = "";
  const panel = (key, top, bot, title, col) => {
    const vals = pts.map((p) => p[key]).concat(sh.d1 ? prev.map((p) => p[key]) : []).filter((v) => v != null);
    const yt = niceTicks(Math.min(0, ...vals), Math.max(0, ...vals), 4);
    const yOf = (v) => bot - ((v - yt.lo) / (yt.hi - yt.lo)) * (bot - top);
    let o = yt.ticks.map((v) => `<line x1="${L}" x2="${R}" y1="${yOf(v)}" y2="${yOf(v)}" stroke="${v === 0 ? C.axis : C.grid}" stroke-dasharray="${v === 0 ? "" : "2 4"}"/>` +
      txt(L - 8, yOf(v) + 4, (v > 0 ? "+" : v < 0 ? "−" : "") + fmtNum(Math.abs(v * 100), 1), { a: "end", fs })).join("");
    o += txt(L, top - 10, title, { fs, c: C.muted });
    const line = (arr, c, w, da, dots) => {
      const p = arr.filter((q) => q[key] != null);
      if (p.length < 2) return "";
      let r = `<path d="${p.map((q, i) => `${i ? "L" : "M"}${xOf(q.exp).toFixed(1)},${yOf(q[key]).toFixed(1)}`).join("")}" fill="none" stroke="${c}" stroke-width="${w}"${da ? ` stroke-dasharray="${da}"` : ""}/>`;
      if (dots) r += p.map((q) => `<circle cx="${xOf(q.exp)}" cy="${yOf(q[key])}" r="3" fill="${C.surface}" stroke="${c}" stroke-width="1.7"/>`).join("");
      return r;
    };
    if (sh.d1) o += line(prev, C.muted, 1.5, "3 3");
    return o + line(pts, col, 2.3, "", true);
  };
  s += panel("rr25", T, mid, "25Δ risk reversal (call IV − put IV, pts)", C.accent);
  s += panel("bf25", mid + gap, B, "25Δ butterfly (wings − ATM, pts)", C.purple);
  let lx = -99;
  for (const p of pts) {
    const x = xOf(p.exp), lab = volDate(p.exp), w = textW(lab, fs);
    if (x - lx < w + 10) continue;
    lx = x;
    s += txt(Math.min(x, W - 6 - w / 2), B + fs + 8, lab, { a: "middle", fs });
  }
  s += txt(R, B + fs * 2 + 14, "Expiration", { a: "end", fs, c: C.faint });
  s += `<line id="vhl" x1="0" x2="0" y1="${T}" y2="${B}" stroke="${C.spotline}" stroke-opacity=".6" visibility="hidden"/>`;
  vol.geo = { kind: "term", pts: pts.map((p) => ({ p, x: xOf(p.exp) })), T, B };
  return volFrame(W, H, s);
}

/* ------------------------------------------------------------ cono de volatilidad realizada */
// IV ATM a n sesiones (n * 365 / 252 dias naturales), interpolada en la estructura temporal
function atmAt(n) {
  const t = (vol.data.term || []).filter((p) => p.atm != null), x = (n * 365) / 252;
  if (t.length < 2 || x < t[0].dte || x > t[t.length - 1].dte) return null;
  let i = 0; while (i < t.length - 2 && t[i + 1].dte < x) i++;
  const a = t[i], b = t[i + 1];
  return a.atm + ((b.atm - a.atm) * (x - a.dte)) / (b.dte - a.dte || 1);
}

function renderRealized(W, H) {
  const d = vol.data, rv = d.realized, sh = vol.show;
  if (!rv) return `<div class="placeholder">${d.symbol === "VIX" || /^VIX|^VX/.test(d.symbol) ? "VIX options are priced on its futures, not on the index: the realized volatility of the index does not compare." : "No price history for this ticker."}</div>`;
  const ws = (rv.windows || []).filter((n) => rv.cone[n]);
  if (ws.length < 2) return `<div class="placeholder">Not enough price history for the cone.</div>`;
  const narrow = W < 640, fs = narrow ? 10.5 : 11.5;
  const L = narrow ? 44 : 58, R = W - (narrow ? 16 : 34), T = 30, B = H - 46;
  const xOf = (i) => L + (i / (ws.length - 1)) * (R - L);
  const iv = ws.map(atmAt);
  const all = ws.flatMap((n) => [rv.cone[n][0], rv.cone[n][4], rv.yz[n], sh.cc ? rv.cc[n] : null]).concat(sh.iv ? iv : []).filter((v) => v != null);
  const yt = niceTicks(Math.min(...all) * 0.92, Math.max(...all) * 1.05, 5);
  const yOf = (v) => B - ((v - yt.lo) / (yt.hi - yt.lo)) * (B - T);
  let s = yGrid(yt, yOf, L, R, fs);
  const band = (a, b, op) => `<polygon points="${ws.map((n, i) => `${xOf(i)},${yOf(rv.cone[n][b])}`).concat(ws.map((n, i) => `${xOf(i)},${yOf(rv.cone[n][a])}`).reverse()).join(" ")}" fill="${C.purple}" fill-opacity="${op}"/>`;
  s += band(0, 4, 0.08) + band(1, 3, 0.16);
  const line = (vals, c, w, da, dots) => {
    const p = vals.map((v, i) => [i, v]).filter(([, v]) => v != null);
    if (p.length < 2) return "";
    let o = `<path d="${p.map(([i, v], j) => `${j ? "L" : "M"}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`).join("")}" fill="none" stroke="${c}" stroke-width="${w}"${da ? ` stroke-dasharray="${da}"` : ""}/>`;
    if (dots) o += p.map(([i, v]) => `<circle cx="${xOf(i)}" cy="${yOf(v)}" r="3.2" fill="${C.surface}" stroke="${c}" stroke-width="1.8"/>`).join("");
    return o;
  };
  s += line(ws.map((n) => rv.cone[n][2]), C.purple, 1.3, "4 4");
  if (sh.cc) s += line(ws.map((n) => rv.cc[n]), C.muted, 1.6, "3 3", true);
  s += line(ws.map((n) => rv.yz[n]), C.text, 2.2, "", true);
  if (sh.iv) s += line(iv, C.accent, 2.4, "", true);
  ws.forEach((n, i) => { s += txt(xOf(i), B + fs + 8, `${n}d`, { a: "middle", fs }); });
  s += txt(R, B + fs * 2 + 14, "Window (sessions)", { a: "end", fs, c: C.faint });
  s += `<text transform="translate(${narrow ? 10 : 14},${(T + B) / 2}) rotate(-90)" text-anchor="middle" font-family="${SANS}" font-size="${fs}" fill="${C.faint}">Volatility</text>`;
  s += `<line id="vhl" x1="0" x2="0" y1="${T}" y2="${B}" stroke="${C.spotline}" stroke-opacity=".6" visibility="hidden"/>`;
  vol.geo = { kind: "rv", pts: ws.map((n, i) => ({ n, x: xOf(i), iv: iv[i] })), T, B };
  return volFrame(W, H, s);
}

/* ------------------------------------------------------------ skew */
function smileBand(d, sm) {
  const b = d.bands && d.bands.skew;
  if (!b) return null;
  const tens = (d.tenors || []).filter((t) => b[t]);
  if (!tens.length) return null;
  const ten = tens.reduce((a, t) => (Math.abs(t - sm.dte) < Math.abs(a - sm.dte) ? t : a));
  if (Math.abs(ten - sm.dte) > Math.max(5, sm.dte * 0.5)) return null;
  // banda por delta llevada al eje elegido con la relacion delta-strike de hoy de ese vencimiento
  const out = [];
  for (const [k, v] of Object.entries(b[ten])) {
    const dl = parseFloat(k);
    const side = sm.delta.map((x, i) => [x, sm.K[i]]).filter(([x]) => (dl < 0 ? x < 0 : x > 0)).sort((a, c) => a[0] - c[0]);
    if (side.length < 2 || dl < side[0][0] || dl > side[side.length - 1][0]) continue;
    let i = 0; while (i < side.length - 2 && side[i + 1][0] < dl) i++;
    const w = (dl - side[i][0]) / (side[i + 1][0] - side[i][0] || 1);
    const K = side[i][1] + (side[i + 1][1] - side[i][1]) * w;
    out.push({ x: vol.axis === "delta" ? dl : K, lo: v[0], hi: v[1] });
  }
  return out.length >= 3 ? out.sort((a, c) => (vol.axis === "delta" ? dAxis(a.x) - dAxis(c.x) : a.x - c.x)) : null;
}
// eje de delta continuo de puts a calls: -0,05 ... -0,45 | 0,45 ... 0,05  ->  0 ... 1
function dAxis(dl) { return dl < 0 ? -dl : 1 - dl; }

function renderSkew(W, H) {
  const d = vol.data, sh = vol.show;
  const sms = vol.sel.map((e) => d.smiles.find((s) => s.exp === e)).filter(Boolean);
  if (!sms.length) return `<div class="placeholder">Pick at least one expiration.</div>`;
  const narrow = W < 640, fs = narrow ? 10.5 : 11.5;
  const L = narrow ? 44 : 58, R = W - (narrow ? 12 : 24), T = 30, B = H - 46;
  const byDelta = vol.axis === "delta";
  const xv = (sm) => sm.K.map((k, i) => (byDelta ? dAxis(sm.delta[i]) : k));
  // rango del eje: en strikes, lo que cubren las curvas acotado a ~2 desviaciones del primer vencimiento elegido
  let xs = sms.flatMap(xv);
  let lo = Math.min(...xs), hi = Math.max(...xs);
  if (!byDelta) {
    const ref = sms[sms.length - 1], sig = (ref.iv[Math.floor(ref.iv.length / 2)] || 0.2) * Math.sqrt(Math.max(ref.dte, 1) / 365);
    lo = Math.max(lo, d.spot * Math.exp(-2.6 * sig)); hi = Math.min(hi, d.spot * Math.exp(2.0 * sig));
  }
  const xOf = (v) => L + ((v - lo) / (hi - lo || 1)) * (R - L);
  const inX = (v) => v >= lo && v <= hi;
  const prevOf = (sm) => { const p = d.prev && d.prev["1d"]; return p ? p.smiles.find((s) => s.exp === sm.exp) : null; };
  const bands = sh.band ? sms.map((sm) => smileBand(d, sm)) : [];
  const ys = [];
  sms.forEach((sm, j) => {
    xv(sm).forEach((x, i) => { if (inX(x)) ys.push(sm.iv[i]); });
    const p = sh.d1 && prevOf(sm);
    if (p && !byDelta) p.K.forEach((k, i) => { if (inX(k)) ys.push(p.iv[i]); });
    (bands[j] || []).forEach((b) => { if (inX(b.x)) ys.push(b.lo, b.hi); });
  });
  if (!ys.length) return `<div class="placeholder">No data in this range.</div>`;
  const yt = niceTicks(Math.min(...ys) * 0.95, Math.max(...ys) * 1.04, 5);
  const yOf = (v) => B - ((v - yt.lo) / (yt.hi - yt.lo)) * (B - T);
  let s = yGrid(yt, yOf, L, R, fs);
  // eje X
  if (byDelta) {
    [[-0.05, "5Δp"], [-0.10, "10Δp"], [-0.25, "25Δp"], [-0.45, "ATM"], [0.25, "25Δc"], [0.10, "10Δc"], [0.05, "5Δc"]].forEach(([dl, lab]) => {
      const v = dAxis(dl); if (inX(v)) s += txt(xOf(v), B + fs + 8, lab, { a: "middle", fs });
    });
  } else {
    niceTicks(lo, hi, narrow ? 4 : 8).ticks.filter(inX).forEach((v) => { s += txt(xOf(v), B + fs + 8, fmtNum(v, v < 100 ? 1 : 0), { a: "middle", fs }); });
    const sx = xOf(d.spot);
    s += `<line x1="${sx}" x2="${sx}" y1="${T}" y2="${B}" stroke="${C.spotline}" stroke-dasharray="2 4" stroke-opacity=".7"/>` + txt(sx + 5, T + fs, `Spot ${fmtSpot(d.spot)}`, { fs, c: C.muted });
  }
  sms.forEach((sm, j) => {
    const col = volC(j);
    const b = bands[j];
    if (b) {
      const pb = b.filter((q) => inX(q.x));
      if (pb.length >= 2) s += `<polygon points="${pb.map((q) => `${xOf(q.x)},${yOf(q.hi)}`).concat(pb.slice().reverse().map((q) => `${xOf(q.x)},${yOf(q.lo)}`)).join(" ")}" fill="${col}" fill-opacity=".12"/>`;
    }
    const p = sh.d1 && prevOf(sm);
    if (p && !byDelta) {
      const pp = p.K.map((k, i) => [k, p.iv[i]]).filter(([k]) => inX(k));
      if (pp.length > 1) s += `<path d="${pp.map(([k, v], i) => `${i ? "L" : "M"}${xOf(k).toFixed(1)},${yOf(v).toFixed(1)}`).join("")}" fill="none" stroke="${col}" stroke-width="1.4" stroke-dasharray="3 3" stroke-opacity=".7"/>`;
    }
    const xsm = xv(sm);
    const pts = xsm.map((x, i) => [x, sm.iv[i]]).filter(([x]) => inX(x)).sort((a, c) => a[0] - c[0]);
    s += `<path d="${pts.map(([x, v], i) => `${i ? "L" : "M"}${xOf(x).toFixed(1)},${yOf(v).toFixed(1)}`).join("")}" fill="none" stroke="${col}" stroke-width="2.2"/>`;
  });
  s += txt(R, B + fs * 2 + 14, byDelta ? "Delta (puts on the left, calls on the right)" : "Strike", { a: "end", fs, c: C.faint });
  s += `<text transform="translate(${narrow ? 10 : 14},${(T + B) / 2}) rotate(-90)" text-anchor="middle" font-family="${SANS}" font-size="${fs}" fill="${C.faint}">Implied volatility</text>`;
  s += `<line id="vhl" x1="0" x2="0" y1="${T}" y2="${B}" stroke="${C.spotline}" stroke-opacity=".6" visibility="hidden"/>`;
  vol.geo = { kind: "skew", sms, xOf, lo, hi, L, R, T, B, byDelta, prevOf };
  return volFrame(W, H, s);
}

/* ------------------------------------------------------------ matriz */
function renderMatrix() {
  const m = vol.data.matrix;
  if (!m || !m.rows || !m.rows.length) return `<div class="placeholder">No data for the matrix.</div>`;
  const chgMax = Math.max(0.005, ...m.rows.flatMap((r) => r.chg.filter((x) => x != null).map(Math.abs)));
  const showChg = vol.mshow === "chg";
  const cell = (iv, ch) => {
    if (iv == null) return `<td class="na">—</td>`;
    let bg = "";
    if (ch != null) {
      const a = Math.min(1, Math.abs(ch) / chgMax) * 0.55;
      bg = ` style="background:color-mix(in srgb, ${ch > 0 ? C.accent : C.neg} ${(a * 100).toFixed(1)}%, transparent)"`;
    }
    const v = showChg ? (ch == null ? "—" : (ch > 0 ? "+" : ch < 0 ? "−" : "") + fmtNum(Math.abs(ch * 100), 2)) : fmtNum(iv * 100, 1);
    return `<td${bg} title="IV ${pct(iv, 2)}${ch != null ? `, ${ch > 0 ? "+" : ""}${fmtNum(ch * 100, 2)} pts vs. the previous session` : ""}">${v}</td>`;
  };
  const spotIdx = m.strikes.reduce((bi, k, i) => (Math.abs(k - vol.data.spot) < Math.abs(m.strikes[bi] - vol.data.spot) ? i : bi), 0);
  return `<table class="scan vmat"><thead><tr><th class="l">Expiration</th>${m.strikes.map((k, i) => `<th class="${i === spotIdx ? "atm" : ""}">${fmtNum(k, k < 100 ? 1 : 0)}</th>`).join("")}</tr></thead>
    <tbody>${m.rows.filter(inH).map((r) => `<tr><td class="l"><b>${volDate(r.exp)}</b>${r.monthly ? MTAG : ""}<span class="ds">${volDays(r)} d</span></td>${r.iv.map((v, i) => cell(v, r.chg[i])).join("")}</tr>`).join("")}</tbody></table>`;
}

/* ------------------------------------------------------------ controles y pintado */
function volControls() {
  const d = vol.data, sh = vol.show;
  const hasPrev = d.prev && d.prev["1d"], hasW = d.prev && d.prev["1w"];
  const bandOk = d.bands && d.bands.days >= 15;
  if (vol.tab === "term") {
    return `<div class="vrow">${horSeg()}${chip("atm", "Today", true, C.accent)}${chip("fwd", "Forward IV", sh.fwd, C.accent)}${hasPrev ? chip("d1", `Previous session (${ddmm(d.prev["1d"].date)})`, sh.d1, C.muted) : ""}${hasW ? chip("w1", `1 week ago (${ddmm(d.prev["1w"].date)})`, sh.w1, C.faint) : ""}${chip("band", "10th–90th percentile", sh.band && bandOk, volColors().band)}${chip("ev", "Events", sh.ev, C.muted)}</div>`;
  }
  if (vol.tab === "shape") return `<div class="vrow">${horSeg()}${hasPrev ? chip("d1", `Previous session (${ddmm(d.prev["1d"].date)})`, sh.d1, C.muted) : ""}</div>`;
  if (vol.tab === "realized") {
    if (!d.realized) return "";
    return `<div class="vrow">${chip("yz", "Realized, Yang-Zhang", true, C.text)}${chip("cc", "Realized, close-to-close", sh.cc, C.muted)}${chip("iv", "Implied (ATM, same horizon)", sh.iv, C.accent)}<span class="vleg"><i style="background:color-mix(in srgb, ${C.purple} 32%, transparent)"></i>Last year: 10th–90th percentile, min–max and median (dashed)</span></div>`;
  }
  if (vol.tab === "skew") {
    const ex = d.smiles.filter(inH).map((s) => {
      const k = vol.sel.indexOf(s.exp);
      return `<button class="vexp${k >= 0 ? " on" : ""}" data-e="${s.exp}"${k >= 0 ? ` style="--c:${volC(k)}"` : ""}>${volDate(s.exp)}${s.monthly ? MTAG : ""}<small>${volDays(s)}d</small></button>`;
    }).join("");
    return `<div class="vrow">${horSeg()}<div class="seg boxed" role="radiogroup" id="volAxisSeg"><button role="radio" data-v="strike" aria-checked="${vol.axis === "strike"}">Strike</button><button role="radio" data-v="delta" aria-checked="${vol.axis === "delta"}">Delta</button></div>
      ${hasPrev ? chip("d1", "Previous session (dashed)", sh.d1, C.muted) : ""}${chip("band", "10th–90th percentile", sh.band && bandOk, volColors().band)}</div>
      <div class="vrow vexps" aria-label="Expirations (up to 5)">${ex}</div>`;
  }
  return `<div class="vrow">${horSeg()}<div class="seg boxed" role="radiogroup" id="volMatSeg"><button role="radio" data-v="iv" aria-checked="${vol.mshow === "iv"}">IV (%)</button><button role="radio" data-v="chg" aria-checked="${vol.mshow === "chg"}">Daily change (pts)</button></div>
    <span class="vleg"><i class="up"></i>Up vs. the previous session <i class="dn"></i>Down</span></div>`;
}

function volNote() {
  const d = vol.data, b = d.bands || {};
  const band = b.days >= 15 ? `The band is the range between the 10th and 90th percentiles of the last ${b.days} sessions.` :
    `The percentile band will appear once 15 sessions are saved (there are ${b.days || 0} today).`;
  if (vol.tab === "term") return `ATM IV for each expiration (that of the out-of-the-money option at each strike, interpolated at the implied forward). Forward IV is the implied volatility between one expiration and the previous one: it isolates what the market prices for that stretch, for example an event. Amber circles: stretches whose forward variance stands out from the normal one and from their neighbors; the figure is the one-day move priced on top. ${band} Events: Fed, BEA, Census and the current week from ForexFactory.`;
  if (vol.tab === "shape") return "Shape of the smile at each expiration. Risk reversal: IV of the 25-delta call minus that of the 25-delta put (negative means puts cost more; in the VIX it is usually positive). Butterfly: average of both 25-delta wings minus ATM IV, the curvature of the smile, which grows when the market pays for large moves either way. The dashed line is the previous session.";
  if (vol.tab === "realized") {
    const rv = d.realized;
    return rv ? `Volatility cone: for each window, the range of realized volatility over the last ${rv.days} sessions (Yang-Zhang, which also uses the open, high and low). On top, today's realized volatility and the ATM implied volatility for the same horizon. Implied near the top of the cone means options are expensive compared with what the ticker usually moves; near the bottom, cheap.${rv.proxy ? ` Prices from ${rv.proxy}: CBOE does not publish the index history.` : ""}` : "";
  }
  const vixNote = vol.data && vol.data.symbol === "VIX" ? " For the VIX, that forward is the future of each expiration." : "";
  if (vol.tab === "skew") return `Implied volatility of the out-of-the-money option at each strike (puts below the forward, calls above). The forward is the price the options of each expiration imply (put-call parity), and the IV is calculated from the bid/ask midpoint against it (Black-76), so puts and calls agree at the money.${vixNote} The dashed line is the previous session; the band, the 10th–90th percentile for the same tenor and delta. ${band}`;
  return "IV of each expiration at fixed strikes around the spot. The color shows the change from the last copy of the chain in the previous session: green, up; magenta, down.";
}

function renderVol() {
  const d = vol.data;
  if (!d) return;
  $("vSym").textContent = d.symbol; $("vName").textContent = d.name || ""; $("vSpot").textContent = fmtSpot(d.spot);
  $("volSum").innerHTML = volSummary();
  $("volCtl").innerHTML = volControls();
  $("volNote").textContent = volNote();
  const isM = vol.tab === "matrix";
  $("volMatrix").hidden = !isM; $("volChart").hidden = isM;
  $("volTip").hidden = true;
  if (isM) { $("volMatrix").innerHTML = renderMatrix(); return; }
  const el = $("volChart");
  const W = Math.max(320, el.clientWidth), H = Math.max(340, el.clientHeight);
  const draw = { term: renderTerm, shape: renderShape, realized: renderRealized }[vol.tab] || renderSkew;
  el.innerHTML = draw(W, H);
}

function volTip(e) {
  const g = vol.geo, el = $("volChart");
  if (!g || !vol.data) return;
  const r = el.getBoundingClientRect(), x = e.clientX - r.left;
  const hl = el.querySelector("#vhl");
  let html = "";
  if (g.kind === "term") {
    if (!g.pts.length) return;
    const best = g.pts.reduce((a, b) => (Math.abs(b.x - x) < Math.abs(a.x - x) ? b : a));
    if (Math.abs(best.x - x) > 40) { $("volTip").hidden = true; if (hl) hl.setAttribute("visibility", "hidden"); return; }
    const p = best.p, b = bandAt(vol.data, p.dte);
    const prev = (k) => { const q = vol.data.prev && vol.data.prev[k]; const t = q && q.term.find((z) => z.exp === p.exp); return t ? t.atm : null; };
    const ev = (vol.events || []).filter((z) => z.date === p.exp);
    const smp = vol.data.smiles.find((s) => s.exp === p.exp) || {}, mens = smp.monthly;
    html = `<div class="t">Expiration ${volDate(p.exp)}${mens ? " (monthly)" : ""}</div>
      <div class="r">Days to expiration <b>${volDays(p)}</b></div>
      ${smp.fwd ? `<div class="r">Future (forward) <b>${fmtNum(smp.fwd, 2)}</b></div>` : ""}
      ${b ? `<div class="r">10th percentile <b>${pct(b[0], 2)}</b></div><div class="r">90th percentile <b>${pct(b[1], 2)}</b></div>` : ""}
      <div class="r">Today <b style="color:${C.accent}">${pct(p.atm, 2)}</b></div>
      ${p.mf != null ? `<div class="r">Model-free IV <b>${pct(p.mf, 2)}</b></div>` : ""}
      ${p.fwd != null ? `<div class="r">Forward IV <b>${pct(p.fwd, 2)}</b></div>` : ""}
      ${p.rr25 != null ? `<div class="r">25Δ risk reversal <b>${pts2(p.rr25)}</b></div><div class="r">25Δ butterfly <b>${pts2(p.bf25)}</b></div>` : ""}
      ${p.event ? `<div class="r">Event priced <b style="color:${C.amber}">±${fmtNum(p.event * 100, 1)}%</b></div>` : ""}
      ${prev("1d") != null ? `<div class="r">Previous session <b>${pct(prev("1d"), 2)}</b></div>` : ""}
      ${prev("1w") != null ? `<div class="r">1 week ago <b>${pct(prev("1w"), 2)}</b></div>` : ""}
      ${ev.length ? `<div class="r">That day <b>${esc(ev.map((z) => z.name).join(", "))}</b></div>` : ""}`;
    if (hl) { hl.setAttribute("x1", best.x); hl.setAttribute("x2", best.x); hl.setAttribute("visibility", "visible"); }
  } else if (g.kind === "rv") {
    const best = g.pts.reduce((a, b) => (Math.abs(b.x - x) < Math.abs(a.x - x) ? b : a));
    const rv = vol.data.realized, c = rv.cone[best.n];
    html = `<div class="t">${best.n}-session window</div>
      ${best.iv != null ? `<div class="r">Implied (ATM) <b style="color:${C.accent}">${pct(best.iv, 2)}</b></div>` : ""}
      <div class="r">Realized, Yang-Zhang <b>${pct(rv.yz[best.n], 2)}</b></div>
      <div class="r">Realized, close-to-close <b>${pct(rv.cc[best.n], 2)}</b></div>
      <div class="r">Last year: max <b>${pct(c[4], 1)}</b></div><div class="r">90th percentile <b>${pct(c[3], 1)}</b></div>
      <div class="r">Median <b>${pct(c[2], 1)}</b></div><div class="r">10th percentile <b>${pct(c[1], 1)}</b></div><div class="r">Min <b>${pct(c[0], 1)}</b></div>`;
    if (hl) { hl.setAttribute("x1", best.x); hl.setAttribute("x2", best.x); hl.setAttribute("visibility", "visible"); }
  } else {
    if (x < g.L || x > g.R) { $("volTip").hidden = true; if (hl) hl.setAttribute("visibility", "hidden"); return; }
    const v = g.lo + ((x - g.L) / (g.R - g.L)) * (g.hi - g.lo);
    const rows = g.sms.map((sm, j) => {
      const xs = sm.K.map((k, i) => (g.byDelta ? dAxis(sm.delta[i]) : k));
      let bi = 0; xs.forEach((z, i) => { if (Math.abs(z - v) < Math.abs(xs[bi] - v)) bi = i; });
      const p = vol.show.d1 && g.prevOf(sm);
      const pi = p ? p.K.indexOf(sm.K[bi]) : -1;
      return `<div class="r"><span style="color:${volC(j)}">${volDate(sm.exp)}</span><b>${pct(sm.iv[bi], 2)}${pi >= 0 ? ` <span class="vt-prev">(${pct(p.iv[pi], 2)})</span>` : ""}</b></div>
        <div class="r vt-sub">Strike ${fmtNum(sm.K[bi], sm.K[bi] < 100 ? 1 : 0)}, Δ ${fmtNum(sm.delta[bi], 2)}</div>`;
    }).join("");
    html = `<div class="t">${g.byDelta ? "IV by delta" : "IV by strike"}</div>${rows}`;
    if (hl) { hl.setAttribute("x1", x); hl.setAttribute("x2", x); hl.setAttribute("visibility", "visible"); }
  }
  macroTip("volTip", el, e, html);
}

function bindVol() {
  $("volTabs").addEventListener("click", (e) => { const b = e.target.closest("button[data-v]"); if (b) setVolTab(b.dataset.v); });
  $("volCtl").addEventListener("click", (e) => {
    const c = e.target.closest(".vchip");
    if (c && c.dataset.k !== "atm" && c.dataset.k !== "yz") {
      vol.show[c.dataset.k] = !vol.show[c.dataset.k];
      store.set("volShow", JSON.stringify(vol.show));
      renderVol(); return;
    }
    const x = e.target.closest(".vexp");
    if (x) {
      const i = vol.sel.indexOf(x.dataset.e);
      if (i >= 0) { if (vol.sel.length > 1) vol.sel.splice(i, 1); } else if (vol.sel.length < 5) vol.sel.push(x.dataset.e);
      vol.sel.sort();
      renderVol(); return;
    }
    const ax = e.target.closest("#volAxisSeg button");
    if (ax) { vol.axis = ax.dataset.v; store.set("volAxis", vol.axis); renderVol(); return; }
    const hz = e.target.closest("#volHorSeg button");
    if (hz) {
      vol.hor = hz.dataset.v; store.set("volHor", vol.hor);
      vol.sel = vol.sel.filter((x) => { const sm = vol.data.smiles.find((q) => q.exp === x); return sm && inH(sm); });
      if (!vol.sel.length) vol.sel = defaultSkew(vol.data);
      renderVol(); return;
    }
    const mt = e.target.closest("#volMatSeg button");
    if (mt) { vol.mshow = mt.dataset.v; store.set("volMat", vol.mshow); renderVol(); }
  });
  $("volChart").addEventListener("mousemove", volTip);
  $("volChart").addEventListener("mouseleave", () => { $("volTip").hidden = true; const hl = $("volChart").querySelector("#vhl"); if (hl) hl.setAttribute("visibility", "hidden"); });
}
bindVol();
