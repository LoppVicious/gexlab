"use strict";
/* ============================================================ Panel de volatilidad (estilo Volatility Dashboard)
   Datos: /api/vol?symbol= (superficie del motor) y /api/eventos (calendario macro). Tres vistas:
   - Estructura temporal: IV ATM por vencimiento, IV forward, sesion anterior, hace una semana, banda 10-90 y eventos
   - Skew: IV por strike o por delta de los vencimientos elegidos, con la sesion anterior y la banda 10-90
   - Matriz por strike fijo: IV por vencimiento y strike, coloreada por el cambio frente a la sesion anterior */

const vol = {
  data: null, sym: "", at: 0, ctrl: null, events: null, geo: null,
  tab: store.get("volTab", "term"),
  axis: store.get("volAxis", "strike"),
  sel: [],                                   // vencimientos elegidos en el skew
  show: JSON.parse(store.get("volShow", '{"fwd":true,"d1":true,"w1":false,"band":true,"ev":true}')),
  mshow: store.get("volMat", "iv"),
};
const VOLC = ["#1fc8a6", "#9461ff", "#ff2f7c", "#f2b632", "#4fa3ff"];
const pct = (v, d = 1) => v == null ? "—" : fmtNum(v * 100, d) + "%";
const volDate = (iso) => { const d = new Date(iso + "T12:00:00"); return `${d.getDate()} ${MESES[d.getMonth()]}${d.getFullYear() !== new Date().getFullYear() ? " " + String(d.getFullYear()).slice(2) : ""}`; };

function volColors() { return { band: document.documentElement.dataset.theme === "light" ? "rgba(124,92,240,.16)" : "rgba(110,100,220,.30)" }; }

function showVol() {
  setVolTab(vol.tab, true);
  const sym = state.symbol || "SPX";
  $("symbol").value = sym;
  if (!vol.data || vol.sym !== sym || Date.now() - vol.at > 300000) loadVol(); else { renderVol(); setStatus("", volStatus()); }
}

function volStatus() { return vol.data ? `Volatilidad · ${nyHHMM(vol.data.generado)}` : ""; }

async function loadVol(refresh = false) {
  const sym = (state.symbol || "SPX").toUpperCase();
  if (vol.ctrl) vol.ctrl.abort();
  vol.ctrl = new AbortController();
  $("refreshBtn").classList.add("spin");
  setStatus("busy", `Cargando la volatilidad de ${sym}…`);
  $("volChart").classList.add("loading");
  try {
    const [r, ev] = await Promise.all([
      fetch(`/api/vol?symbol=${encodeURIComponent(sym)}${refresh ? "&refresh=1" : ""}`, { signal: vol.ctrl.signal }),
      vol.events ? Promise.resolve(null) : fetch("/api/eventos", { signal: vol.ctrl.signal }).then((x) => (x.ok ? x.json() : [])).catch(() => []),
    ]);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "No se pudo leer la volatilidad");
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
  const pts = d.term || [];
  if (pts.length < 2) return `<div class="placeholder">Sin vencimientos suficientes para la estructura temporal.</div>`;
  const narrow = W < 640, fs = narrow ? 10.5 : 11.5;
  const evs = sh.ev ? (vol.events || []).filter((e) => e.imp >= 2) : [];
  const L = narrow ? 44 : 58, R = W - (narrow ? 12 : 24), T = 34, B = H - (sh.ev && evs.length ? (narrow ? 120 : 150) : 44);
  const t0 = new Date(pts[0].exp + "T12:00:00").getTime() - 86400000 * Math.max(1, pts[0].dte);
  const t1 = new Date(pts[pts.length - 1].exp + "T12:00:00").getTime();
  // escala de tiempo comprimida (raiz) para que los vencimientos cercanos no se amontonen
  const f = (t) => Math.sqrt(Math.max(0, (t - t0) / 86400000));
  const xOf = (iso) => L + (f(new Date(iso + "T12:00:00").getTime()) / f(t1)) * (R - L);
  const prevT = (k) => (d.prev && d.prev[k] && d.prev[k].term) || [];
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
  // eje X: fechas de vencimiento (sin solapar)
  let lx = -99;
  for (const p of pts) {
    const x = xOf(p.exp), lab = volDate(p.exp), w = textW(lab, fs);
    if (x - lx < w + 10) continue;
    lx = x;
    s += txt(x, B + fs + 8, lab, { a: "middle", fs });
  }
  s += txt(R, B + fs * 2 + 14, "Vencimiento", { a: "end", fs, c: C.faint });
  s += `<text transform="translate(${narrow ? 10 : 14},${(T + B) / 2}) rotate(-90)" text-anchor="middle" font-family="${SANS}" font-size="${fs}" fill="${C.faint}">Volatilidad implícita</text>`;
  s += `<line id="vhl" x1="0" x2="0" y1="${T}" y2="${B}" stroke="${C.spotline}" stroke-opacity=".6" visibility="hidden"/>`;
  vol.geo = { kind: "term", pts: pts.map((p) => ({ p, x: xOf(p.exp) })), T, B };
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
  if (!sms.length) return `<div class="placeholder">Elige al menos un vencimiento.</div>`;
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
  if (!ys.length) return `<div class="placeholder">Sin datos en este rango.</div>`;
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
    const col = VOLC[j % VOLC.length];
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
  s += txt(R, B + fs * 2 + 14, byDelta ? "Delta (puts a la izquierda, calls a la derecha)" : "Strike", { a: "end", fs, c: C.faint });
  s += `<text transform="translate(${narrow ? 10 : 14},${(T + B) / 2}) rotate(-90)" text-anchor="middle" font-family="${SANS}" font-size="${fs}" fill="${C.faint}">Volatilidad implícita</text>`;
  s += `<line id="vhl" x1="0" x2="0" y1="${T}" y2="${B}" stroke="${C.spotline}" stroke-opacity=".6" visibility="hidden"/>`;
  vol.geo = { kind: "skew", sms, xOf, lo, hi, L, R, T, B, byDelta, prevOf };
  return volFrame(W, H, s);
}

/* ------------------------------------------------------------ matriz */
function renderMatrix() {
  const m = vol.data.matrix;
  if (!m || !m.rows || !m.rows.length) return `<div class="placeholder">Sin datos para la matriz.</div>`;
  const chgMax = Math.max(0.005, ...m.rows.flatMap((r) => r.chg.filter((x) => x != null).map(Math.abs)));
  const showChg = vol.mshow === "chg";
  const cell = (iv, ch) => {
    if (iv == null) return `<td class="na">—</td>`;
    let bg = "";
    if (ch != null) {
      const a = Math.min(1, Math.abs(ch) / chgMax) * 0.55;
      bg = ` style="background:${ch > 0 ? `rgba(31,200,166,${a.toFixed(3)})` : `rgba(255,47,124,${a.toFixed(3)})`}"`;
    }
    const v = showChg ? (ch == null ? "—" : (ch > 0 ? "+" : ch < 0 ? "−" : "") + fmtNum(Math.abs(ch * 100), 2)) : fmtNum(iv * 100, 1);
    return `<td${bg} title="IV ${pct(iv, 2)}${ch != null ? `, ${ch > 0 ? "+" : ""}${fmtNum(ch * 100, 2)} pts frente a la sesión anterior` : ""}">${v}</td>`;
  };
  const spotIdx = m.strikes.reduce((bi, k, i) => (Math.abs(k - vol.data.spot) < Math.abs(m.strikes[bi] - vol.data.spot) ? i : bi), 0);
  return `<table class="scan vmat"><thead><tr><th class="l">Vencimiento</th>${m.strikes.map((k, i) => `<th class="${i === spotIdx ? "atm" : ""}">${fmtNum(k, k < 100 ? 1 : 0)}</th>`).join("")}</tr></thead>
    <tbody>${m.rows.map((r) => `<tr><td class="l"><b>${volDate(r.exp)}</b><span class="ds">${fmtNum(r.dte, r.dte < 2 ? 1 : 0)} d</span></td>${r.iv.map((v, i) => cell(v, r.chg[i])).join("")}</tr>`).join("")}</tbody></table>`;
}

/* ------------------------------------------------------------ controles y pintado */
function volControls() {
  const d = vol.data, sh = vol.show;
  const hasPrev = d.prev && d.prev["1d"], hasW = d.prev && d.prev["1w"];
  const bandOk = d.bands && d.bands.days >= 15;
  if (vol.tab === "term") {
    return `<div class="vrow">${chip("atm", "Hoy", true, C.accent)}${chip("fwd", "IV forward", sh.fwd, C.accent)}${hasPrev ? chip("d1", `Sesión anterior (${ddmm(d.prev["1d"].date)})`, sh.d1, C.muted) : ""}${hasW ? chip("w1", `Hace una semana (${ddmm(d.prev["1w"].date)})`, sh.w1, C.faint) : ""}${chip("band", "Percentil 10–90", sh.band && bandOk, volColors().band)}${chip("ev", "Eventos", sh.ev, C.axis)}</div>`;
  }
  if (vol.tab === "skew") {
    const ex = d.smiles.map((s) => {
      const k = vol.sel.indexOf(s.exp);
      return `<button class="vexp${k >= 0 ? " on" : ""}" data-e="${s.exp}"${k >= 0 ? ` style="--c:${VOLC[k % VOLC.length]}"` : ""}>${volDate(s.exp)}<small>${fmtNum(s.dte, s.dte < 2 ? 1 : 0)}d</small></button>`;
    }).join("");
    return `<div class="vrow"><div class="seg boxed" role="radiogroup" id="volAxisSeg"><button role="radio" data-v="strike" aria-checked="${vol.axis === "strike"}">Strike</button><button role="radio" data-v="delta" aria-checked="${vol.axis === "delta"}">Delta</button></div>
      ${hasPrev ? chip("d1", "Sesión anterior (discontinua)", sh.d1, C.muted) : ""}${chip("band", "Percentil 10–90", sh.band && bandOk, volColors().band)}</div>
      <div class="vrow vexps" aria-label="Vencimientos (hasta 5)">${ex}</div>`;
  }
  return `<div class="vrow"><div class="seg boxed" role="radiogroup" id="volMatSeg"><button role="radio" data-v="iv" aria-checked="${vol.mshow === "iv"}">IV (%)</button><button role="radio" data-v="chg" aria-checked="${vol.mshow === "chg"}">Cambio diario (pts)</button></div>
    <span class="vleg"><i class="up"></i>Sube frente a la sesión anterior <i class="dn"></i>Baja</span></div>`;
}

function volNote() {
  const d = vol.data, b = d.bands || {};
  const band = b.days >= 15 ? `La banda es el rango entre los percentiles 10 y 90 de las últimas ${b.days} sesiones.` :
    `La banda de percentiles aparecerá con 15 sesiones guardadas (hoy hay ${b.days || 0}).`;
  if (vol.tab === "term") return `IV ATM de cada vencimiento (la de la opción fuera de dinero en cada strike, interpolada en el spot). La IV forward es la volatilidad implícita entre un vencimiento y el anterior: aísla lo que el mercado descuenta para ese tramo, por ejemplo un evento. ${band} Eventos: Fed, BEA, Census y la semana en curso de ForexFactory.`;
  if (vol.tab === "skew") return `Volatilidad implícita de la opción fuera de dinero de cada strike (puts por debajo del spot, calls por encima). La línea discontinua es la sesión anterior; la banda, el percentil 10–90 del mismo plazo y delta. ${band}`;
  return "IV de cada vencimiento en strikes fijos alrededor del spot. El color indica el cambio frente a la última copia de la cadena de la sesión anterior: verde, sube; magenta, baja.";
}

function renderVol() {
  const d = vol.data;
  if (!d) return;
  $("vSym").textContent = d.symbol; $("vName").textContent = d.name || ""; $("vSpot").textContent = fmtSpot(d.spot);
  $("volCtl").innerHTML = volControls();
  $("volNote").textContent = volNote();
  const isM = vol.tab === "matrix";
  $("volMatrix").hidden = !isM; $("volChart").hidden = isM;
  $("volTip").hidden = true;
  if (isM) { $("volMatrix").innerHTML = renderMatrix(); return; }
  const el = $("volChart");
  const W = Math.max(320, el.clientWidth), H = Math.max(340, el.clientHeight);
  el.innerHTML = vol.tab === "term" ? renderTerm(W, H) : renderSkew(W, H);
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
    html = `<div class="t">Vencimiento ${volDate(p.exp)}</div>
      <div class="r">Días al vencimiento <b>${fmtNum(p.dte, 2)}</b></div>
      ${b ? `<div class="r">Percentil 10 <b>${pct(b[0], 2)}</b></div><div class="r">Percentil 90 <b>${pct(b[1], 2)}</b></div>` : ""}
      <div class="r">Hoy <b style="color:${C.accent}">${pct(p.atm, 2)}</b></div>
      ${p.fwd != null ? `<div class="r">IV forward <b>${pct(p.fwd, 2)}</b></div>` : ""}
      ${prev("1d") != null ? `<div class="r">Sesión anterior <b>${pct(prev("1d"), 2)}</b></div>` : ""}
      ${prev("1w") != null ? `<div class="r">Hace una semana <b>${pct(prev("1w"), 2)}</b></div>` : ""}
      ${ev.length ? `<div class="r">Ese día <b>${esc(ev.map((z) => z.name).join(", "))}</b></div>` : ""}`;
    if (hl) { hl.setAttribute("x1", best.x); hl.setAttribute("x2", best.x); hl.setAttribute("visibility", "visible"); }
  } else {
    if (x < g.L || x > g.R) { $("volTip").hidden = true; if (hl) hl.setAttribute("visibility", "hidden"); return; }
    const v = g.lo + ((x - g.L) / (g.R - g.L)) * (g.hi - g.lo);
    const rows = g.sms.map((sm, j) => {
      const xs = sm.K.map((k, i) => (g.byDelta ? dAxis(sm.delta[i]) : k));
      let bi = 0; xs.forEach((z, i) => { if (Math.abs(z - v) < Math.abs(xs[bi] - v)) bi = i; });
      const p = vol.show.d1 && g.prevOf(sm);
      const pi = p ? p.K.indexOf(sm.K[bi]) : -1;
      return `<div class="r"><span style="color:${VOLC[j % VOLC.length]}">${volDate(sm.exp)}</span><b>${pct(sm.iv[bi], 2)}${pi >= 0 ? ` <span class="vt-prev">(${pct(p.iv[pi], 2)})</span>` : ""}</b></div>
        <div class="r vt-sub">Strike ${fmtNum(sm.K[bi], sm.K[bi] < 100 ? 1 : 0)} · Δ ${fmtNum(sm.delta[bi], 2)}</div>`;
    }).join("");
    html = `<div class="t">${g.byDelta ? "IV por delta" : "IV por strike"}</div>${rows}`;
    if (hl) { hl.setAttribute("x1", x); hl.setAttribute("x2", x); hl.setAttribute("visibility", "visible"); }
  }
  macroTip("volTip", el, e, html);
}

function bindVol() {
  $("volTabs").addEventListener("click", (e) => { const b = e.target.closest("button[data-v]"); if (b) setVolTab(b.dataset.v); });
  $("volCtl").addEventListener("click", (e) => {
    const c = e.target.closest(".vchip");
    if (c && c.dataset.k !== "atm") {
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
    const mt = e.target.closest("#volMatSeg button");
    if (mt) { vol.mshow = mt.dataset.v; store.set("volMat", vol.mshow); renderVol(); }
  });
  $("volChart").addEventListener("mousemove", volTip);
  $("volChart").addEventListener("mouseleave", () => { $("volTip").hidden = true; const hl = $("volChart").querySelector("#vhl"); if (hl) hl.setAttribute("visibility", "hidden"); });
}
bindVol();
