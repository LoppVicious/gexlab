"use strict";
/* ============================================================ Equity Hub (estilo SpotGamma)
   - Grafico "Impacto calls y puts": gamma total si el precio estuviera en cada nivel (linea), la del proximo
     vencimiento (linea) y la gamma neta por strike (barras, eje derecho), con los puntos de baja y alta
     volatilidad, el cierre anterior y, opcionalmente, los niveles clave.
   - Ficha del ticker a la derecha y la lista de seguimiento con precio y variacion. */

const hub = { scan: null, scanAt: 0, cmp: null, cmpAt: 0, busy: false };


/* ------------------------------------------------------------ grafico */
function impactRange(d) {
  if (d._zoom) return d._zoom; // ventana de la barra de zoom
  // el rango elegido (±%), centrado en el spot: el mismo que ves en los controles
  const w = ((d.meta && d.meta.window_pct) || 5) / 100;
  return [d.spot * (1 - w), d.spot * (1 + w)];
}

function renderImpact(d, W, H, exp = false) {
  const P = d.profile;
  if (!P || !P.x || !P.x.length) return `<div class="placeholder">No gamma profile.</div>`;
  const narrow = !exp && W < 640, fs = exp ? 15 : narrow ? 10.5 : 11.5;
  const titleH = exp ? 62 : 0;
  const L = exp ? 104 : narrow ? 50 : 64, R = W - (exp ? 104 : narrow ? 46 : 64), B = H - (exp ? 70 : 44);
  const [x0, x1] = impactRange(d);
  const idx = P.x.map((x, i) => i).filter((i) => P.x[i] >= x0 - 1e-9 && P.x[i] <= x1 + 1e-9);
  if (idx.length < 3) return `<div class="placeholder">No gamma profile in this range.</div>`;
  const X = idx.map((i) => P.x[i]), Y = idx.map((i) => P.y[i]), Wk = P.week ? idx.map((i) => P.week[i]) : null;
  const hb = d.hub || {};
  const labs = [[hb.low_vol_point, C.put, "Low volatility"], [hb.high_vol_point, C.amber, "High volatility"], [d.prev_close, C.prevClose, "Previous close"]]
    .filter(([v]) => v != null && v >= x0 && v <= x1);
  const legRows = narrow ? 3 : 1;
  const T = titleH + 12 + legRows * (fs + 8) + labs.length * (fs + 8) + 10;
  const xOf = (v) => L + ((v - x0) / (x1 - x0)) * (R - L);
  // eje izquierdo: lineas, siempre con el cero
  const ys = Y.concat(Wk || []);
  // barras por strike dentro del rango (se necesitan antes para reservar sitio a cada lado del cero)
  const ks0 = [], vs0 = [];
  d.strikes.forEach((k, i) => { if (k >= x0 && k <= x1) { ks0.push(k); vs0.push(d.net[i]); } });
  // con muchos strikes (NDX) se agrupan para que cada barra tenga unos pixeles de ancho
  const bk = bucketStrikes(ks0, [vs0], d.step || 1, Math.max(30, Math.floor((R - L) / 6)));
  const ks = bk.ks, vs = bk.arrs[0];
  const mp = Math.max(0, ...vs), mn = Math.max(0, ...vs.map((v) => -v));
  let lo = Math.min(0, ...ys), hi = Math.max(0, ...ys);
  const pad = (hi - lo) * 0.08 || 1;
  // si las lineas no tienen parte positiva (o negativa) pero hay barras de ese signo, deja espacio para ellas
  if (mp > 0 && hi <= 0) hi = (hi - lo) * 0.3 || 1;
  if (mn > 0 && lo >= 0) lo = -((hi - lo) * 0.3 || 1);
  const yt = niceTicks(lo - (lo < 0 ? pad : 0), hi + (hi > 0 ? pad : 0), 6);
  const yOf = (v) => B - ((v - yt.lo) / (yt.hi - yt.lo)) * (B - T);
  const y0 = yOf(0);
  // barras por strike (eje derecho): mismo cero; la mas alta llega como mucho al 88% del espacio de su lado
  const up = y0 - T, dn = B - y0;
  const kf = Math.min(mp > 0 ? (0.88 * up) / mp : Infinity, mn > 0 ? (0.88 * dn) / mn : Infinity);
  const k = isFinite(kf) && kf > 0 ? kf : 1;
  const bY = (v) => y0 - v * k;
  let s = `<defs><clipPath id="impclip${exp ? "e" : ""}"><rect x="${L}" y="${T}" width="${R - L}" height="${B - T}"/></clipPath></defs>`;
  for (const v of yt.ticks) {
    const y = yOf(v);
    s += `<line x1="${L}" x2="${R}" y1="${y}" y2="${y}" stroke="${C.grid}" stroke-dasharray="2 4"/>` + txt(L - 8, y + 4, fmtAxis(v), { a: "end", fs, c: C.muted });
  }
  // ticks del eje derecho en valores redondos de las barras
  const bm = Math.max(mp, mn);
  const st = bm > 0 ? niceStep(bm, 3) : 0;
  if (st > 0 && isFinite(st)) {
    for (let v = st; v * k <= up + 0.5 && v <= bm * 4; v += st) s += txt(R + 8, bY(v) + 4, fmtAxis(v), { fs, c: C.faint });
    for (let v = st; v * k <= dn + 0.5 && v <= bm * 4; v += st) s += txt(R + 8, bY(-v) + 4, fmtAxis(-v), { fs, c: C.faint });
    s += txt(R + 8, y0 + 4, "0", { fs, c: C.faint });
  }
  const xt = niceTicks(x0, x1, exp ? 12 : narrow ? 4 : Math.max(5, Math.floor((R - L) / 95)));
  for (const v of xt.ticks) if (v >= x0 && v <= x1) s += txt(xOf(v), B + fs + 9, fmtSpot(v), { a: "middle", fs, c: C.muted });
  s += txt((L + R) / 2, H - (exp ? 18 : 6), "Strike", { a: "middle", fs, c: C.faint });
  s += `<text transform="translate(${exp ? 30 : narrow ? 10 : 14},${(T + B) / 2}) rotate(-90)" text-anchor="middle" font-family="${SANS}" font-size="${fs}" fill="${C.faint}">Total gamma ($ per $1, lines)</text>`;
  s += `<text transform="translate(${W - (exp ? 30 : narrow ? 6 : 10)},${(T + B) / 2}) rotate(90)" text-anchor="middle" font-family="${SANS}" font-size="${fs}" fill="${C.faint}">Net gamma by strike (bars)</text>`;

  // barras
  const step = bk.step || (ks.length > 1 ? ks[1] - ks[0] : 1);
  const bw = Math.max(1.5, Math.min(exp ? 22 : 14, ((R - L) / ((x1 - x0) / step)) * 0.62));
  let bars = "";
  ks.forEach((kk, i) => {
    const h = vs[i] * k, x = xOf(kk);
    if (Math.abs(h) < 0.4) return;
    bars += `<rect x="${(x - bw / 2).toFixed(1)}" y="${(h >= 0 ? y0 - h : y0).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.abs(h).toFixed(1)}" rx="1" fill="${C.bar}" fill-opacity="${C.barOp}"/>`;
  });
  s += `<g clip-path="url(#impclip${exp ? "e" : ""})">${bars}</g>`;
  s += `<line x1="${L}" x2="${R}" y1="${y0}" y2="${y0}" stroke="${C.axis}" stroke-dasharray="2 3"/>`;

  // puntos de volatilidad y cierre anterior (con su etiqueta en filas sobre el grafico)
  labs.forEach(([v, col, lab], row) => {
    const x = xOf(v), y = T - 10 - row * (fs + 8);
    const t = `${lab} ${lab === "Previous close" ? fmtSpot(v) : fmtLevel(v)}`;
    const tx = Math.min(x + 5, R - textW(t, fs, 600, exp) - 2);
    s += `<line x1="${x}" x2="${x}" y1="${y + 4}" y2="${B}" stroke="${col}" stroke-width="1.6"/>` +
      `<text x="${tx}" y="${y}" font-family="${SANS}" font-size="${fs}" font-weight="600" fill="${col}">${t}</text>`;
  });
  const sx = xOf(d.spot);
  s += `<line x1="${sx}" x2="${sx}" y1="${T}" y2="${B}" stroke="${C.spotline}" stroke-dasharray="1 3" stroke-opacity=".8"/>`;
  s += txt(sx + 4, B - 6, `Spot ${fmtSpot(d.spot)}`, { fs: fs - 0.5, c: C.muted });
  // niveles clave (opcionales)
  if (state.showLevels) {
    let lastLx = -99;
    for (const it of levelItems(d).sort((a, c) => a.v - c.v)) {
      if (it.v < x0 || it.v > x1) continue;
      const x = xOf(it.v), room = x - lastLx >= fs + 3;
      if (room) lastLx = x;
      s += `<line x1="${x}" x2="${x}" y1="${T}" y2="${B}" stroke="${it.c}" stroke-width="1.4" stroke-dasharray="4 4"/>` +
        (room ? `<text transform="translate(${x - 4},${B - 22}) rotate(-90)" font-family="${SANS}" font-size="${fs - 0.5}" font-weight="600" fill="${it.c}">${it.tag} ${fmtLevel(it.v)}</text>` : "");
    }
  }
  // lineas
  const path = (A) => A.map((v, i) => `${i ? "L" : "M"}${xOf(X[i]).toFixed(1)},${yOf(v).toFixed(1)}`).join("");
  const wkLab = `Expiration ${expText(d, P.week_exp || d.front_expiry)}`;
  s += `<g clip-path="url(#impclip${exp ? "e" : ""})">`;
  if (Wk) s += `<path d="${path(Wk)}" fill="none" stroke="${C.neg}" stroke-width="2"/>`;
  s += `<path d="${path(Y)}" fill="none" stroke="${C.pos}" stroke-width="2.4"/></g>`;
  // leyenda
  const leg = [["Total gamma, all expirations in the filter", C.pos], [wkLab, C.neg], ["Net gamma by strike", C.bar, "bar"]];
  let lx = L, ly = titleH + 16;
  for (const [lab, c, kind] of leg) {
    const w = textW(lab, fs) + 30;
    if (lx + w > R && lx > L) { lx = L; ly += fs + 8; }
    s += kind === "bar" ? `<rect x="${lx}" y="${ly - 6}" width="12" height="9" rx="1.5" fill="${c}" fill-opacity="${C.barOp}"/>` : `<line x1="${lx}" x2="${lx + 16}" y1="${ly - 2}" y2="${ly - 2}" stroke="${c}" stroke-width="2.4"/>`;
    s += txt(lx + 22, ly + 2, lab, { fs, c: C.muted });
    lx += w;
  }
  if (!exp) s += `<g id="cross" visibility="hidden"><line id="crossL" y1="${T}" y2="${B}" stroke="${C.muted}" stroke-dasharray="2 3"/><circle id="crossC" r="4" fill="${C.pos}"/><circle id="crossF" r="3.5" fill="${C.neg}"/></g>`;
  s += watermark(d, L, B, fs, exp);
  if (!exp) state.geo = { kind: "impact", left: L, right: R, top: T, bottom: B, xOf, yOf, x0, x1, ks, vs, X, Y, Wk, wkLab };
  return frame(W, H, s, d, exp, "Call & put impact");
}

function impactTip(d, g, x, svg) {
  const X = g.X, Y = g.Y, F = g.Wk;
  const v = g.x0 + ((x - g.left) / (g.right - g.left)) * (g.x1 - g.x0);
  let j = X.findIndex((xx) => xx >= v); if (j <= 0) j = 1; if (j >= X.length) j = X.length - 1;
  const t = Math.max(0, Math.min(1, (v - X[j - 1]) / (X[j] - X[j - 1])));
  const yv = Y[j - 1] + t * (Y[j] - Y[j - 1]);
  const fv = F ? F[j - 1] + t * (F[j] - F[j - 1]) : null;
  let bi = -1, bd = Infinity;
  g.ks.forEach((k, i) => { const dd = Math.abs(k - v); if (dd < bd) { bd = dd; bi = i; } });
  const cr = svg.querySelector("#cross");
  cr.setAttribute("visibility", "visible");
  svg.querySelector("#crossL").setAttribute("x1", x); svg.querySelector("#crossL").setAttribute("x2", x);
  svg.querySelector("#crossC").setAttribute("cx", x); svg.querySelector("#crossC").setAttribute("cy", g.yOf(yv));
  if (fv != null) { svg.querySelector("#crossF").setAttribute("cx", x); svg.querySelector("#crossF").setAttribute("cy", g.yOf(fv)); }
  return `<div class="t">Price ${fmtSpot(v)} <span style="color:var(--faint);font-weight:400">(${fmtPct((v / d.spot - 1) * 100)})</span></div>
    <div class="r"><span style="color:${C.pos}">Total gamma</span><b>${fmtBig(yv, true)}</b></div>
    ${fv != null ? `<div class="r"><span style="color:${C.neg}">${g.wkLab}</span><b>${fmtBig(fv, true)}</b></div>` : ""}
    ${bi >= 0 ? `<div class="r">Strike ${fmtLevel(g.ks[bi])} bar<b>${fmtBig(g.vs[bi], true)}</b></div>` : ""}`;
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

function volPt(v, edge, range, none) {
  if (v != null) return fmtLevel(v);
  if (edge && range) return edge === "up" ? `above ${fmtSpot(range[1])}` : `below ${fmtSpot(range[0])}`;
  return none;
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
  const ex = (iso) => (iso ? fullDate(iso) : "—");
  const k = (v) => (v == null ? "—" : fmtBig(v));
  const p = (v) => (v == null ? "—" : fmtNum(v * 100, 1) + "%");
  card.innerHTML = `<div class="htitle">Profile</div>
    ${hubRow("Previous close", fmtSpot(d.prev_close))}
    ${hubRow("IV rank", cr && cr.y != null ? fmtNum(cr.y, 0) + "%" : "—", cr && cr.y_src ? (cr.y_src === "provisional" ? "provisional" : cr.y_src === "propio" ? "own history" : cr.y_src) : "")}
    ${hubRow("30-day IV", p(hb.iv30))}
    ${hubRow("20-day realized vol", p(hb.rv20))}
    ${hubRow("Implied move", m1 ? "±" + fmtSpot(d.spot * m1.pct / 100) : "—", m1 ? "±" + fmtNum(m1.pct, 2) + "%" : "", "range1s")}
    ${hubRow("Low volatility point", volPt(hb.low_vol_point, hb.low_vol_edge, hb.range, "no positive gamma in range"), hb.low_vol_edge ? "widen the range to see it" : "", "lowvol")}
    ${hubRow("High volatility point", volPt(hb.high_vol_point, hb.high_vol_edge, hb.range, "no negative gamma in range"), hb.high_vol_edge ? "widen the range to see it" : "", "highvol")}
    ${hubRow("Call gamma", fmtBig(d.totals.call_per_pct, true), "per 1%")}
    ${hubRow("Put gamma", fmtBig(d.totals.put_per_pct, true), "per 1%")}
    ${hubRow("Exp. with most gamma", ex(hb.top_gamma_exp))}
    ${hubRow("Exp. with most delta", ex(hb.top_delta_exp))}
    ${hubRow("Call volume", k(hb.call_vol))}
    ${hubRow("Put volume", k(hb.put_vol))}
    ${hubRow("Put/call ratio (OI)", hb.pc_oi != null ? fmtNum(hb.pc_oi, 2) : "—")}
    ${d.model === "spotgamma" ? hubRow("Implied dividend", d.dividend && d.dividend.ref != null ? fmtNum(d.dividend.ref * 100, 2) + "%" : "not measured", d.dividend && d.dividend.n ? `put-call parity, ${d.dividend.n} exp.` : "European indices only") : ""}`;
  card.hidden = false;
  const rows = (hub.scan || []).filter((r) => !r.error);
  wl.innerHTML = `<div class="htitle">Watchlist</div>` + (rows.length
    ? `<table class="hwl"><thead><tr><th class="l">Ticker</th><th>Price</th><th>Chg.</th></tr></thead><tbody>${rows.map((r) =>
      `<tr data-s="${esc(r.symbol)}" class="${r.symbol === d.symbol ? "on" : ""}"><td class="l">${esc(r.symbol)}</td><td>${fmtSpot(r.spot)}</td><td class="${r.chg > 0 ? "up" : r.chg < 0 ? "dn" : ""}">${r.chg != null ? fmtPct(r.chg) : "—"}</td></tr>`).join("")}</tbody></table>`
    : `<p class="hempty">Loading…</p>`);
  wl.hidden = false;
  hubFetchExtras();
}

$("hubWatch").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-s]"); if (!tr) return;
  $("symbol").value = tr.dataset.s; $("spotInput").value = ""; load();
});

/* ------------------------------------------------------------ distribucion del Hub: watchlist a la izquierda,
   niveles a la derecha y el detalle en pestanas bajo el grafico. Flujos, escenarios y datos se pintan en la
   columna de niveles (app.js) y TRACE los sigue mostrando ahi: se mueven al cajon solo mientras se ve el Hub. */
const DRAWER = { flows: "facts", scen: "scenBox", data: "meta" };
function placeHub() {
  const enHub = !document.body.classList.contains("view-map");
  const pane = (p) => document.querySelector(`#hubDrawer .dpane[data-p="${p}"]`);
  if (enHub) Object.entries(DRAWER).forEach(([p, id]) => pane(p).append($(id)));
  else { $("split").after($("facts"), $("scenBox")); document.querySelector(".ladder").append($("meta")); }
  // en el Hub la explicacion del grafico pasa a un icono; en By strike se queda porque es la leyenda de vencimientos
  const info = enHub && state.view !== "strike" && !!$("caption").textContent;
  $("caption").classList.toggle("asinfo", info);
  $("capInfo").title = info ? $("caption").textContent : "";
  $("capInfo").setAttribute("aria-label", $("capInfo").title);
  $("capInfo").hidden = !info;
}
function drawerTab(p) {
  document.querySelectorAll("#drawerTabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.p === p)));
  document.querySelectorAll("#hubDrawer .dpane").forEach((d) => (d.hidden = d.dataset.p !== p));
  store.set("hubTab", p);
}
$("drawerTabs").addEventListener("click", (e) => { const b = e.target.closest("button[data-p]"); if (b) drawerTab(b.dataset.p); });
drawerTab(store.get("hubTab", "profile"));
placeHub();
