"use strict";
/* ============================================================ Zoom de los graficos e Historico de niveles
   - Barra de zoom bajo el grafico (como SpotGamma): una miniatura de todo el rango con una ventana que se
     arrastra o se estrecha por los extremos. Vale para Por strike, Impacto calls y puts, Perfil e Historico.
   - Historico: los niveles de cada sesion guardada (Call Wall, Put Wall, Gamma Flip, Vol Trigger, Gamma
     absoluta) con el precio, con el mismo filtro de vencimientos y el mismo motor que la vista actual. */

const zoom = { v: {}, key: "", drag: null, raf: 0 };
const ZOOM_VIEWS = ["strike", "impact", "profile", "history"];
const ZMIN = 0.04; // ventana minima: 4% del rango

function zoomKey() { return `${state.symbol}|${state.dte}|${state.range}|${state.model}`; }
function zoomGet(view) {
  if (zoom.key !== zoomKey()) { zoom.v = {}; zoom.key = zoomKey(); }
  return zoom.v[view] || [0, 1];
}
function zoomIsFull(z) { return z[0] <= 0.0005 && z[1] >= 0.9995; }

// dominio completo de cada vista, en sus unidades (precio o indice de sesion)
function zoomDomain(d, view) {
  if (view === "strike") return d.strikes && d.strikes.length ? [d.strikes[0], d.strikes[d.strikes.length - 1]] : null;
  if (view === "impact") { const w = ((d.meta && d.meta.window_pct) || 5) / 100; return [d.spot * (1 - w), d.spot * (1 + w)]; }
  if (view === "profile") return d.profile && d.profile.x.length ? [d.profile.x[0], d.profile.x[d.profile.x.length - 1]] : null;
  if (view === "history") { const n = histRows(d).length; return n > 1 ? [0, n - 1] : null; }
  return null;
}

// copia de los datos recortada a la ventana de zoom de la vista
function zoomed(d, view) {
  if (!d || !ZOOM_VIEWS.includes(view)) return d;
  const z = zoomGet(view), dom = zoomDomain(d, view);
  if (!dom || zoomIsFull(z)) return d;
  const lo = dom[0] + (dom[1] - dom[0]) * z[0], hi = dom[0] + (dom[1] - dom[0]) * z[1];
  if (view === "strike") {
    const keep = d.strikes.map((k) => k >= lo - 1e-9 && k <= hi + 1e-9);
    if (keep.filter(Boolean).length < 3) return d;
    const o = { ...d };
    for (const k of ["strikes", "net", "calls", "puts", "front", "vanna", "charm"]) if (Array.isArray(d[k])) o[k] = d[k].filter((_, i) => keep[i]);
    return o;
  }
  if (view === "impact") return { ...d, _zoom: [lo, hi] };
  if (view === "profile") {
    const X = d.profile.x, idx = X.map((x, i) => i).filter((i) => X[i] >= lo && X[i] <= hi);
    if (idx.length < 3) return d;
    return { ...d, profile: { ...d.profile, x: idx.map((i) => X[i]), y: idx.map((i) => d.profile.y[i]) } };
  }
  if (view === "history") return { ...d, _hzoom: [Math.floor(lo), Math.ceil(hi)] };
  return d;
}

// ---------------------------------------------------------------- barra
function zoomBarSync() {
  const bar = $("zoomBar");
  if (!bar) return;
  const d = state.data, view = state.view;
  const on = state.mode !== "vol" && ZOOM_VIEWS.includes(view) && d && zoomDomain(d, view);
  bar.hidden = !on;
  if (!on) return;
  const z = zoomGet(view);
  const win = $("zbWin");
  win.style.left = (z[0] * 100) + "%";
  win.style.width = ((z[1] - z[0]) * 100) + "%";
  $("zbReset").hidden = zoomIsFull(z);
  const dom = zoomDomain(d, view), a = dom[0] + (dom[1] - dom[0]) * z[0], b = dom[0] + (dom[1] - dom[0]) * z[1];
  if (view === "history") {
    const rows = histRows(d);
    $("zbLab").textContent = rows.length ? `${histDate(rows[Math.round(a)].d)} – ${histDate(rows[Math.round(b)].d)}` : "";
  } else {
    $("zbLab").textContent = `${fmtSpot(a)} – ${fmtSpot(b)}`;
  }
  zoomMini(d, view);
}

// miniatura de todo el dominio dentro de la barra
function zoomMini(d, view) {
  const el = $("zbMini"), W = Math.max(100, el.clientWidth), H = el.clientHeight || 26;
  let s = "";
  if (view === "strike" || view === "impact") {
    const dom = zoomDomain(d, view), ks = [], vs = [];
    d.strikes.forEach((k, i) => { if (k >= dom[0] && k <= dom[1]) { ks.push(k); vs.push(d.net[i]); } });
    const m = Math.max(1e-9, ...vs.map(Math.abs)), bw = Math.max(1, W / Math.max(ks.length, 1) * 0.7);
    ks.forEach((k, i) => {
      const x = ((k - dom[0]) / (dom[1] - dom[0] || 1)) * W, h = Math.abs(vs[i]) / m * (H / 2 - 2);
      s += `<rect x="${(x - bw / 2).toFixed(1)}" y="${(vs[i] > 0 ? H / 2 - h : H / 2).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.5, h).toFixed(1)}" fill="${vs[i] > 0 ? C.pos : C.neg}" fill-opacity="0.75"/>`;
    });
  } else if (view === "profile") {
    const X = d.profile.x, Y = d.profile.y, m = Math.max(1e-9, ...Y.map(Math.abs));
    s += `<path d="M${X.map((x, i) => `${((i / (X.length - 1)) * W).toFixed(1)},${(H / 2 - Y[i] / m * (H / 2 - 2)).toFixed(1)}`).join(" L")}" fill="none" stroke="${C.pos}" stroke-width="1.2"/>`;
  } else if (view === "history") {
    const rows = histRows(d), px = rows.map((r) => r.px).filter((v) => v != null);
    if (px.length > 1) {
      const lo = Math.min(...px), hi = Math.max(...px);
      s += `<path d="M${rows.map((r, i) => r.px == null ? null : `${((i / (rows.length - 1)) * W).toFixed(1)},${(H - 2 - (r.px - lo) / (hi - lo || 1) * (H - 4)).toFixed(1)}`).filter(Boolean).join(" L")}" fill="none" stroke="${C.muted}" stroke-width="1.2"/>`;
    }
  }
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="100%" preserveAspectRatio="none">${s}</svg>`;
}

function zoomSet(view, a, b) {
  a = Math.max(0, Math.min(1 - ZMIN, a)); b = Math.min(1, Math.max(a + ZMIN, b));
  zoomGet(view);
  zoom.v[view] = [a, b];
  cancelAnimationFrame(zoom.raf);
  zoom.raf = requestAnimationFrame(() => { zoomBarSync(); draw(); });
}

function bindZoomBar() {
  const track = $("zbTrack");
  if (!track) return;
  const frac = (e) => { const r = track.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
  track.addEventListener("pointerdown", (e) => {
    const view = state.view, z = zoomGet(view), f = frac(e);
    const h = e.target.closest(".zb-h");
    let mode = h ? (h.classList.contains("l") ? "l" : "r") : e.target.closest("#zbWin") ? "move" : "new";
    if (mode === "new") { // clic fuera de la ventana: la centra ahi con el mismo ancho
      const w = z[1] - z[0];
      zoomSet(view, f - w / 2, f + w / 2);
      mode = "move";
    }
    zoom.drag = { mode, f0: f, z0: zoomGet(view).slice(), view };
    track.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  track.addEventListener("pointermove", (e) => {
    const g = zoom.drag; if (!g) return;
    const df = frac(e) - g.f0, [a, b] = g.z0;
    if (g.mode === "l") zoomSet(g.view, Math.min(a + df, b - ZMIN), b);
    else if (g.mode === "r") zoomSet(g.view, a, Math.max(b + df, a + ZMIN));
    else { const w = b - a, na = Math.min(1 - w, Math.max(0, a + df)); zoomSet(g.view, na, na + w); }
  });
  const end = () => { zoom.drag = null; };
  track.addEventListener("pointerup", end);
  track.addEventListener("pointercancel", end);
  track.addEventListener("dblclick", () => zoomSet(state.view, 0, 1));
  $("zbReset").addEventListener("click", () => zoomSet(state.view, 0, 1));
  // rueda del raton sobre el grafico: acerca o aleja alrededor del cursor
  $("chart").addEventListener("wheel", (e) => {
    const view = state.view;
    if (!e.ctrlKey && !e.shiftKey) return; // sin modificador la rueda desplaza la pagina
    if (!ZOOM_VIEWS.includes(view) || !state.data || !state.geo) return;
    e.preventDefault();
    const g = state.geo, rect = $("chart").getBoundingClientRect();
    const p = Math.min(1, Math.max(0, ((e.clientX - rect.left) - g.left) / ((g.right - g.left) || 1)));
    const z = zoomGet(view), w = z[1] - z[0], c = z[0] + p * w;
    const nw = Math.min(1, Math.max(ZMIN, w * (e.deltaY > 0 ? 1.2 : 1 / 1.2)));
    zoomSet(view, c - p * nw, c - p * nw + nw);
  }, { passive: false });
}

/* ============================================================ Historico de niveles */
const HIST_SERIES = [
  { k: "px", name: "Precio", c: () => C.text, w: 1.6 },
  { k: "cw", name: "Call Wall", c: () => C.call, w: 1.8, step: true },
  { k: "pw", name: "Put Wall", c: () => C.put, w: 1.8, step: true },
  { k: "flip", name: "Gamma Flip", c: () => C.amber, w: 1.6, step: true },
  { k: "vt", name: "Vol Trigger", c: () => "#d08a3a", w: 1.4, step: true, dash: "5 4" },
  { k: "abs", name: "Gamma absoluta", c: () => C.muted, w: 1.2, step: true, dash: "2 4" },
];
function histShown() {
  try { const v = JSON.parse(store.get("histShow", "null")); if (Array.isArray(v)) return new Set(v); } catch { /* */ }
  return new Set(["px", "cw", "pw", "flip", "vt"]);
}
function histDate(iso) { return iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}` : ""; }

// filas con el precio de cierre (o el spot guardado si no hay cierre de ese dia)
function histRows(d) {
  const h = d && d.history;
  if (!h || !h.rows) return [];
  const cl = new Map((h.closes || []).map(([dd, v]) => [dd, v]));
  return h.rows.map((r) => ({ ...r, px: cl.has(r.d) ? cl.get(r.d) : r.spot }));
}

function renderHistory(d0, W, H, exp = false) {
  const d = d0, all = histRows(d);
  const model = d.model === "gexbot" ? "gexbot" : "SpotGamma";
  if (all.length < 2) {
    return `<div class="placeholder"><div><b>Histórico en construcción</b><br>Se guarda una foto de los niveles al cierre de cada sesión, con este filtro de vencimientos y el motor ${model}.<br>Hay ${all.length} ${all.length === 1 ? "sesión guardada" : "sesiones guardadas"}: el gráfico aparece a partir de la segunda.</div></div>`;
  }
  const [i0, i1] = d._hzoom || [0, all.length - 1];
  const rows = all.slice(Math.max(0, i0), Math.min(all.length, i1 + 1));
  const show = histShown();
  const fs = exp ? 15 : 12, small = exp ? 13 : 11;
  const titleH = exp ? 52 : 0;
  const L = exp ? 92 : 64, R = W - (exp ? 40 : 20), T = titleH + 46, B = H - (exp ? 70 : 46);
  const vals = [];
  rows.forEach((r) => HIST_SERIES.forEach((sr) => { if (show.has(sr.k) && r[sr.k] != null) vals.push(r[sr.k]); }));
  if (!vals.length) vals.push(...rows.map((r) => r.px).filter((v) => v != null));
  const lo = Math.min(...vals), hi = Math.max(...vals), pad = (hi - lo) * 0.06 || hi * 0.01;
  const yt = niceTicks(lo - pad, hi + pad, 6);
  const n = rows.length;
  const xOf = (i) => L + (n === 1 ? 0.5 : i / (n - 1)) * (R - L);
  const yOf = (v) => B - ((v - yt.lo) / (yt.hi - yt.lo)) * (B - T);
  let s = "";
  for (const v of yt.ticks) {
    const y = yOf(v);
    s += `<line x1="${L}" x2="${R}" y1="${y}" y2="${y}" stroke="${C.grid}" stroke-dasharray="2 4"/>`;
    s += txt(L - 8, y + 4, fmtSpot(v), { a: "end", fs: small, c: C.muted });
  }
  // fechas sin solaparse
  const lab = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((R - L) / 80))));
  rows.forEach((r, i) => { if (i % lab === 0 || i === n - 1) s += txt(xOf(i), B + small + 10, histDate(r.d), { a: "middle", fs: small, c: C.muted }); });
  // series
  for (const sr of HIST_SERIES) {
    if (!show.has(sr.k)) continue;
    let p = "", pen = false;
    rows.forEach((r, i) => {
      const v = r[sr.k];
      if (v == null) { pen = false; return; }
      const x = xOf(i), y = yOf(v);
      if (!pen) { p += `M${x.toFixed(1)},${y.toFixed(1)}`; pen = true; return; }
      if (sr.step) p += ` H${x.toFixed(1)} V${y.toFixed(1)}`;
      else p += ` L${x.toFixed(1)},${y.toFixed(1)}`;
    });
    if (p) s += `<path d="${p}" fill="none" stroke="${sr.c()}" stroke-width="${sr.w}"${sr.dash ? ` stroke-dasharray="${sr.dash}"` : ""} stroke-linejoin="round"/>`;
  }
  // leyenda con interruptores (en la exportacion, solo las visibles)
  let lx = L;
  const ly = titleH + 20;
  for (const sr of HIST_SERIES) {
    const on = show.has(sr.k);
    if (exp && !on) continue;
    const w = textW(sr.name, fs) + 34;
    s += `<g class="hleg" data-k="${sr.k}" style="cursor:pointer" opacity="${on ? 1 : 0.4}"><rect x="${lx}" y="${ly - fs}" width="${w - 8}" height="${fs + 10}" fill="transparent"/>`;
    s += `<line x1="${lx}" x2="${lx + 18}" y1="${ly - fs * 0.35}" y2="${ly - fs * 0.35}" stroke="${sr.c()}" stroke-width="2.4"${sr.dash ? ` stroke-dasharray="${sr.dash}"` : ""}/>`;
    s += txt(lx + 24, ly, sr.name, { fs, c: on ? C.text : C.faint }) + `</g>`;
    lx += w + 6;
  }
  s += `<g id="hcross" visibility="hidden"><line id="hcrossL" y1="${T}" y2="${B}" stroke="${C.muted}" stroke-dasharray="2 3"/></g>`;
  s += watermark(d, L, B, small, exp);
  if (!exp) state.geo = { kind: "history", left: L, right: R, top: T, bottom: B, rows, xOf };
  return frame(W, H, s, d, exp, `Histórico de niveles (${model})`);
}

function historyTip(d, g, x, svg) {
  const n = g.rows.length; if (!n) return "";
  const i = Math.max(0, Math.min(n - 1, Math.round(((x - g.left) / ((g.right - g.left) || 1)) * (n - 1))));
  const r = g.rows[i], cx = g.xOf(i);
  const cr = svg.querySelector("#hcross");
  if (cr) { cr.setAttribute("visibility", "visible"); const l = svg.querySelector("#hcrossL"); l.setAttribute("x1", cx); l.setAttribute("x2", cx); }
  return `<div class="t">${histDate(r.d)}</div>` + HIST_SERIES.filter((sr) => r[sr.k] != null)
    .map((sr) => `<div class="r"><span style="color:${sr.c()}">●</span> ${sr.name} <b>${sr.k === "px" ? fmtSpot(r[sr.k]) : fmtLevel(r[sr.k])}</b></div>`).join("");
}

document.addEventListener("click", (e) => {
  const g = e.target.closest && e.target.closest(".hleg");
  if (!g) return;
  const s = histShown(), k = g.dataset.k;
  if (s.has(k)) { if (s.size > 1) s.delete(k); } else s.add(k);
  store.set("histShow", JSON.stringify([...s]));
  draw();
});
bindZoomBar();
