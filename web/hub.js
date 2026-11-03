"use strict";
/* ============================================================ Equity Hub (estilo SpotGamma)
   - Grafico "Impacto calls y puts": gamma total si el precio estuviera en cada nivel (linea), la del proximo
     vencimiento (linea) y la gamma neta por strike (barras, eje derecho), con los puntos de baja y alta
     volatilidad, el cierre anterior y, opcionalmente, los niveles clave.
   - Ficha del ticker a la derecha y la lista de seguimiento con precio y variacion. */

const hub = { scan: null, scanAt: 0, cmp: null, cmpAt: 0, busy: false };
const HUB_LAST = "#5b9dff";

/* ------------------------------------------------------------ grafico */
function renderImpact(d, W, H) {
  const P = d.profile;
  if (!P || !P.x || !P.x.length) return `<div class="placeholder">Sin perfil de gamma.</div>`;
  const narrow = W < 640, fs = narrow ? 10.5 : 11.5;
  const L = narrow ? 50 : 64, R = W - (narrow ? 46 : 64), B = H - 44;
  // filas: leyenda (1 o 2) y una fila por etiqueta de punto de volatilidad / cierre
  const legRows = narrow ? 3 : 1;
  const nLab = [d.hub && d.hub.low_vol_point, d.hub && d.hub.high_vol_point, d.prev_close].filter((v) => v != null).length;
  const T = 12 + legRows * (fs + 8) + nLab * (fs + 8) + 8;
  const x0 = P.x[0], x1 = P.x[P.x.length - 1];
  const xOf = (v) => L + ((v - x0) / (x1 - x0)) * (R - L);
  // curvas (eje izquierdo)
  const ys = P.y.concat(P.front || []);
  const lo = Math.min(0, ...ys), hi = Math.max(0, ...ys), pad = (hi - lo) * 0.08 || 1;
  const yt = niceTicks(lo - (lo < 0 ? pad : 0), hi + pad, 6);
  const yOf = (v) => B - ((v - yt.lo) / (yt.hi - yt.lo)) * (B - T);
  // barras por strike (eje derecho, misma posicion del cero)
  const ks = [], vs = [];
  d.strikes.forEach((k, i) => { if (k >= x0 && k <= x1) { ks.push(k); vs.push(d.net[i]); } });
  const bmax = Math.max(1, ...vs.map(Math.abs));
  const zf = (0 - yt.lo) / (yt.hi - yt.lo);               // fraccion de altura del cero
  const bUp = (B - T) * (1 - zf), bDn = (B - T) * zf;
  const bOf = (v) => (v >= 0 ? (v / bmax) * bUp : (v / bmax) * bDn);
  const y0 = yOf(0);
  let s = "";
  for (const v of yt.ticks) {
    const y = yOf(v);
    s += `<line x1="${L}" x2="${R}" y1="${y}" y2="${y}" stroke="${C.grid}" stroke-dasharray="2 4"/>` + txt(L - 8, y + 4, fmtAxis(v), { a: "end", fs, c: C.muted });
  }
  // eje derecho: barras
  [1, 0.5].forEach((f) => {
    if (bUp > 20) s += txt(R + 8, y0 - bUp * f + 4, fmtAxis(bmax * f), { fs, c: C.faint });
    if (bDn > 20) s += txt(R + 8, y0 + bDn * f + 4, fmtAxis(-bmax * f), { fs, c: C.faint });
  });
  const xt = niceTicks(x0, x1, narrow ? 4 : Math.max(5, Math.floor((R - L) / 95)));
  for (const v of xt.ticks) if (v >= x0 && v <= x1) s += txt(xOf(v), B + fs + 9, fmtSpot(v), { a: "middle", fs, c: C.muted });
  s += txt((L + R) / 2, H - 6, "Strike", { a: "middle", fs, c: C.faint });
  s += `<text transform="translate(${narrow ? 10 : 14},${(T + B) / 2}) rotate(-90)" text-anchor="middle" font-family="${SANS}" font-size="${fs}" fill="${C.faint}">Gamma total ($ por $1, línea)</text>`;
  s += `<text transform="translate(${W - (narrow ? 6 : 10)},${(T + B) / 2}) rotate(90)" text-anchor="middle" font-family="${SANS}" font-size="${fs}" fill="${C.faint}">Gamma por strike (barras)</text>`;

  // barras
  const step = d.step || (ks.length > 1 ? ks[1] - ks[0] : 1);
  const bw = Math.max(1.5, Math.min(14, ((R - L) / ((x1 - x0) / step)) * 0.62));
  ks.forEach((k, i) => {
    const h = bOf(vs[i]), x = xOf(k);
    if (Math.abs(h) < 0.4) return;
    s += `<rect x="${(x - bw / 2).toFixed(1)}" y="${(h >= 0 ? y0 - h : y0).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.abs(h).toFixed(1)}" rx="1" fill="${C.pos}" fill-opacity="0.55"/>`;
  });
  s += `<line x1="${L}" x2="${R}" y1="${y0}" y2="${y0}" stroke="${C.axis}" stroke-dasharray="2 3"/>`;

  // puntos de volatilidad, cierre anterior y spot
  const hb = d.hub || {};
  const vline = (v, col, label, row) => {
    if (v == null || v < x0 || v > x1) return "";
    const x = xOf(v), y = T - 8 - row * (fs + 8);
    return `<line x1="${x}" x2="${x}" y1="${T - 4}" y2="${B}" stroke="${col}" stroke-width="1.6"/>` +
      `<text x="${x + 5}" y="${y}" font-family="${SANS}" font-size="${fs}" font-weight="600" fill="${col}">${label}</text>`;
  };
  let row = 0;
  for (const [v, col, lab] of [[hb.low_vol_point, C.put, "Baja volatilidad"], [hb.high_vol_point, C.amber, "Alta volatilidad"], [d.prev_close, HUB_LAST, "Cierre anterior"]]) {
    if (v == null) continue;
    s += vline(v, col, `${lab} ${lab === "Cierre anterior" ? fmtSpot(v) : fmtLevel(v)}`, row++);
  }
  const sx = xOf(d.spot);
  if (d.spot >= x0 && d.spot <= x1) s += `<line x1="${sx}" x2="${sx}" y1="${T}" y2="${B}" stroke="${C.spotline}" stroke-dasharray="1 3" stroke-opacity=".8"/>`;
  // niveles clave (opcionales)
  if (state.showLevels) {
    let lastLx = -99;
    for (const it of levelItems(d).sort((a, b) => a.v - b.v)) {
      if (it.v < x0 || it.v > x1) continue;
      const x = xOf(it.v);
      const room = x - lastLx >= fs + 3;
      if (room) lastLx = x;
      s += `<line x1="${x}" x2="${x}" y1="${T}" y2="${B}" stroke="${it.c}" stroke-dasharray="4 4" stroke-opacity=".75"/>` +
        (room ? `<text transform="translate(${x - 4},${B - 6}) rotate(-90)" font-family="${SANS}" font-size="${fs - 0.5}" fill="${it.c}">${it.tag} ${fmtLevel(it.v)}</text>` : "");
    }
  }
  // curvas
  const path = (Y) => Y.map((v, i) => `${i ? "L" : "M"}${xOf(P.x[i]).toFixed(1)},${yOf(v).toFixed(1)}`).join("");
  if (P.front) s += `<path d="${path(P.front)}" fill="none" stroke="${C.neg}" stroke-width="2"/>`;
  s += `<path d="${path(P.y)}" fill="none" stroke="${C.pos}" stroke-width="2.4"/>`;
  // leyenda
  const leg = [["Gamma total (línea)", C.pos], [`Próximo vencimiento, ${ddmm(d.front_expiry)} (línea)`, C.neg], ["Gamma neta por strike (barras)", C.pos, "bar"]];
  let lx = L, ly = 16;
  for (const [lab, c, kind] of leg) {
    const w = textW(lab, fs) + 30;
    if (lx + w > R && lx > L) { lx = L; ly += fs + 8; }
    s += kind === "bar" ? `<rect x="${lx}" y="${ly - 6}" width="12" height="9" rx="1.5" fill="${c}" fill-opacity=".55"/>` : `<line x1="${lx}" x2="${lx + 16}" y1="${ly - 2}" y2="${ly - 2}" stroke="${c}" stroke-width="2.4"/>`;
    s += txt(lx + 22, ly + 2, lab, { fs, c: C.muted });
    lx += w;
  }
  s += `<g id="cross" visibility="hidden"><line id="crossL" y1="${T}" y2="${B}" stroke="${C.muted}" stroke-dasharray="2 3"/><circle id="crossC" r="4" fill="${C.pos}"/><circle id="crossF" r="3.5" fill="${C.neg}"/></g>`;
  s += watermark(d, L, B, fs, false);
  state.geo = { kind: "impact", left: L, right: R, top: T, bottom: B, xOf, yOf, x0, x1, ks, vs };
  return frame(W, H, s, d, false, "Impacto calls y puts");
}

function impactTip(d, g, x, svg) {
  const X = d.profile.x, Y = d.profile.y, F = d.profile.front;
  const v = g.x0 + ((x - g.left) / (g.right - g.left)) * (g.x1 - g.x0);
  let j = X.findIndex((xx) => xx >= v); if (j <= 0) j = 1;
  const t = (v - X[j - 1]) / (X[j] - X[j - 1]);
  const yv = Y[j - 1] + t * (Y[j] - Y[j - 1]);
  const fv = F ? F[j - 1] + t * (F[j] - F[j - 1]) : null;
  let bi = -1, bd = Infinity;
  g.ks.forEach((k, i) => { const dd = Math.abs(k - v); if (dd < bd) { bd = dd; bi = i; } });
  const cr = svg.querySelector("#cross");
  cr.setAttribute("visibility", "visible");
  svg.querySelector("#crossL").setAttribute("x1", x); svg.querySelector("#crossL").setAttribute("x2", x);
  svg.querySelector("#crossC").setAttribute("cx", x); svg.querySelector("#crossC").setAttribute("cy", g.yOf(yv));
  if (fv != null) { svg.querySelector("#crossF").setAttribute("cx", x); svg.querySelector("#crossF").setAttribute("cy", g.yOf(fv)); }
  return `<div class="t">Strike ${fmtSpot(bi >= 0 ? g.ks[bi] : v)}</div>
    <div class="r"><span style="color:${C.pos}">Gamma total (línea)</span><b>${fmtBig(yv, true)}</b></div>
    ${fv != null ? `<div class="r"><span style="color:${C.neg}">Próximo vencimiento</span><b>${fmtBig(fv, true)}</b></div>` : ""}
    ${bi >= 0 ? `<div class="r">Gamma neta en ${fmtLevel(g.ks[bi])} (barra)<b>${fmtBig(g.vs[bi], true)}</b></div>` : ""}
    <div class="r">Distancia al spot <b>${fmtPct((v / d.spot - 1) * 100)}</b></div>`;
}

/* ------------------------------------------------------------ ficha y lista */
function hubFetchExtras() {
  // escaner (precio y variacion de la lista) y compass (IV rank) de la lista del usuario, como mucho cada 5 min
  if (hub.busy || Date.now() - hub.scanAt < 300000) return;
  hub.busy = true;
  const list = watchlist();
  const sc = fetch(`/api/scan?dte=45&symbols=${encodeURIComponent(list.join(","))}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  // en el PC el Compass se calcula al momento (lento): solo se usa si ya esta cargado
  const cp = ME && ME.nube ? fetch("/api/compass?symbols=" + encodeURIComponent(list.join(","))).then((r) => (r.ok ? r.json() : null)).catch(() => null) : Promise.resolve(cmp.data);
  Promise.all([sc, cp]).then(([a, b]) => {
    if (a && a.rows) { hub.scan = a.rows; hub.scanAt = Date.now(); }
    if (b && b.rows) { hub.cmp = b.rows; hub.cmpAt = Date.now(); }
    hub.busy = false;
    if (state.data) paintHub(state.data);
  });
}

function hubRow(label, value, sub, g) {
  return `<div class="hrow"><span${g ? ` data-g="${g}"` : ""}>${label}</span><b>${value}</b>${sub ? `<em>${sub}</em>` : ""}</div>`;
}

function paintHub(d) {
  const card = $("hubCard"), wl = $("hubWatch");
  if (!card) return;
  const hb = d.hub || {};
  const cr = (hub.cmp || (cmp.data && cmp.data.rows) || []).find((r) => r.symbol === d.symbol);
  const m1 = d.moves && d.moves.d1;
  const ex = (iso) => (iso ? `${ddmm(iso)}/${iso.slice(2, 4)}` : "—");
  const k = (v) => (v == null ? "—" : fmtBig(v));
  const p = (v) => (v == null ? "—" : fmtNum(v * 100, 1) + "%");
  card.innerHTML = `<div class="htitle">Ficha</div>
    ${hubRow("Cierre anterior", fmtSpot(d.prev_close))}
    ${hubRow("IV rank", cr && cr.y != null ? fmtNum(cr.y, 0) + "%" : "—", cr && cr.y_src ? (cr.y_src === "provisional" ? "provisional" : cr.y_src === "propio" ? "histórico propio" : cr.y_src) : "")}
    ${hubRow("IV 30 días", p(hb.iv30))}
    ${hubRow("Vol. realizada 20 días", p(hb.rv20))}
    ${hubRow("Movimiento implícito", m1 ? "±" + fmtSpot(d.spot * m1.pct / 100) : "—", m1 ? "±" + fmtNum(m1.pct, 2) + "%" : "", "range1s")}
    ${hubRow("Punto de baja volatilidad", hb.low_vol_point != null ? fmtLevel(hb.low_vol_point) : "fuera de rango", "", "lowvol")}
    ${hubRow("Punto de alta volatilidad", hb.high_vol_point != null ? fmtLevel(hb.high_vol_point) : "fuera de rango", "", "highvol")}
    ${hubRow("Gamma de calls", fmtBig(d.totals.call_per_pct, true), "por 1%")}
    ${hubRow("Gamma de puts", fmtBig(d.totals.put_per_pct, true), "por 1%")}
    ${hubRow("Venc. con más gamma", ex(hb.top_gamma_exp))}
    ${hubRow("Venc. con más delta", ex(hb.top_delta_exp))}
    ${hubRow("Volumen de calls", k(hb.call_vol))}
    ${hubRow("Volumen de puts", k(hb.put_vol))}
    ${hubRow("Ratio put/call (OI)", hb.pc_oi != null ? fmtNum(hb.pc_oi, 2) : "—")}`;
  card.hidden = false;
  const rows = (hub.scan || []).filter((r) => !r.error);
  wl.innerHTML = `<div class="htitle">Lista de seguimiento</div>` + (rows.length
    ? `<table class="hwl"><thead><tr><th class="l">Ticker</th><th>Precio</th><th>Var.</th></tr></thead><tbody>${rows.map((r) =>
      `<tr data-s="${esc(r.symbol)}" class="${r.symbol === d.symbol ? "on" : ""}"><td class="l">${esc(r.symbol)}</td><td>${fmtSpot(r.spot)}</td><td class="${r.chg > 0 ? "up" : r.chg < 0 ? "dn" : ""}">${r.chg != null ? fmtPct(r.chg) : "—"}</td></tr>`).join("")}</tbody></table>`
    : `<p class="hempty">Cargando…</p>`);
  wl.hidden = false;
  hubFetchExtras();
}

$("hubWatch").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-s]"); if (!tr) return;
  $("symbol").value = tr.dataset.s; $("spotInput").value = ""; load();
});
