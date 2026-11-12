"use strict";
/* ============================================================ Summary: parte de mercado antes y durante la sesion
   - Cabecera: cuenta atras hasta la apertura (o "Market open"), la semana con los datos macro y los vencimientos.
   - Indices (SPX, NDX, RUT): terreno de gamma (perfil de gamma total por precio, coloreado como el mapa de TRACE) con
     muros, flip, precio y banda de 1 sigma; GEX por 1 %, 1 sigma de la semana, gamma que vence y niveles movidos.
   - Volatilidad (curva del VIX, estructura, IV frente a RV de SPX), correlacion implicita y dispersion (un ano, con
     percentiles), mapa de regimen de la watchlist, flujo de opciones de SPX y extremos del COT.
   Datos: /api/summary (app.js, sm), y aqui /api/eventos, /api/vix, /api/vol, /api/corr, /api/flow, /api/gex (vista
   por defecto, precalculada) y el escaner de la watchlist (hub.js). Cada bloque se pinta en cuanto llegan sus datos. */

const su = { at: 0, busy: false, ev: null, vix: null, vol: null, corr: null, flow: null, prof: {}, timer: null };
const SU_DIA = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SU_MES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const suDate = (iso) => new Date(iso + "T12:00:00");
const suAdd = (iso, n) => { const d = suDate(iso); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const suThirdFri = (y, m) => { const d = new Date(y, m, 1, 12); return new Date(y, m, 1 + ((5 - d.getDay() + 7) % 7) + 14, 12).toISOString().slice(0, 10); };
const suV = (o) => (o == null ? null : typeof o === "object" ? o.v : o);
const suQ = (a, p) => { const s = [...a].sort((x, y) => x - y), i = (s.length - 1) * p, f = Math.floor(i); return s[f] + (s[Math.min(f + 1, s.length - 1)] - s[f]) * (i - f); };
const suWait = (t) => `<p class="empty">${t}</p>`;

// ------------------------------------------------------------ carga de los bloques extra (como mucho cada 5 min)
function suLoad(force) {
  if (su.busy || (!force && Date.now() - su.at < 300000)) return;
  su.busy = true; su.at = Date.now();
  const get = (u) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const paint = () => { if (state.mode === "summary" && sm.data) renderSummary(); };
  const jobs = [
    get("/api/eventos").then((d) => { su.ev = d ? d.eventos || d : su.ev; }),
    get("/api/vix").then((d) => { su.vix = d || su.vix; }),
    get("/api/vol?symbol=SPX").then((d) => { su.vol = d || su.vol; }),
    get("/api/corr").then((d) => { su.corr = d || su.corr; }),
    get("/api/flow?symbol=SPX").then((d) => { su.flow = d || su.flow; }),
    ...SUMMARY_SYMS.map((s) => get("/api/gex?" + new URLSearchParams({ symbol: s, dte: "45", range: "auto", model: "spotgamma" }))
      .then((d) => { if (d && d.profile) su.prof[s] = d.profile; })),
  ].map((p) => p.then(paint));
  Promise.allSettled(jobs).then(() => { su.busy = false; });
  // la watchlist sale del escaner del Hub
  if (typeof hubFetchExtras === "function") {
    hubFetchExtras();
    let n = 0; const t = setInterval(() => { if (!hub.busy || ++n > 60) { clearInterval(t); paint(); } }, 1000);
  }
}

// ------------------------------------------------------------ cabecera: sesion y semana
function suHero(d) {
  const s = d.session, today = s.now_ny.slice(0, 10);
  const days = []; for (let k = 0; days.length < 5 && k < 10; k++) { const x = suAdd(today, k), w = suDate(x).getDay(); if (w && w < 6) days.push(x); }
  const t0 = suDate(today), opex = [suThirdFri(t0.getFullYear(), t0.getMonth()), suThirdFri(t0.getFullYear(), t0.getMonth() + 1)];
  const vixExp = d.vix && d.vix.m1_exp, evs = su.ev || [];
  const day = (x) => {
    const D = suDate(x);
    const it = evs.filter((e) => e.date === x).map((e) => `<div class="ev i${e.imp}" data-cal="${calReg(e)}" tabindex="0"><span>${esc(e.name)}</span><i class="imp"><u></u><u></u><u></u></i><time>${nyHHMM(x + " " + e.time) || e.time}</time></div>`);
    const tags = []; if (opex.includes(x)) tags.push("Monthly OPEX"); if (x === vixExp) tags.push("VIX expiration");
    return `<div class="su-day${x === today ? " on" : ""}"><b>${x === today ? "Today" : SU_DIA[D.getDay()]}<small>${SU_MES[D.getMonth()]} ${D.getDate()}</small></b>`
      + (it.join("") || (tags.length ? "" : `<span class="none">${su.ev ? "No releases" : "…"}</span>`)) + tags.map((t) => `<span class="tag">${t}</span>`).join("") + `</div>`;
  };
  const next = evs.filter((e) => e.date > days[days.length - 1] && e.imp >= 2)[0];
  const nd = next && suDate(next.date);
  return `<section class="su-hero"><div class="su-clock" id="suClock">${suClock(s)}</div><div class="su-week">${days.map(day).join("")}</div>
    <div class="su-next"><span>Next major release</span>${next ? `<b>${esc(next.name)}</b><em>${SU_DIA[nd.getDay()]} ${SU_MES[nd.getMonth()]} ${nd.getDate()}</em>` : "<b>—</b>"}</div></section>`;
}
function suClock(s) {
  if (s.open) return `<span class="live"><i></i>Market open</span><em>closes at ${localTime(s.close_utc)} your time</em>`;
  const ms = Math.max(0, Date.parse(s.next_open_utc) - Date.now()), h = Math.floor(ms / 3.6e6), m = Math.floor(ms / 6e4) % 60;
  return `<span>Opens in</span><b>${h}h ${String(m).padStart(2, "0")}m</b><em>${localTime(s.next_open_utc, true)} your time</em>`;
}

// ------------------------------------------------------------ indices: terreno de gamma
function suTerrain(x, prof, W = 400, H = 150) {
  const sp = x.spot, L = x.levels, d1 = x.moves && x.moves.d1;
  const lv = [["Call Wall", suV(L.call_wall), C.call], ["Put Wall", suV(L.put_wall), C.put], [x.is_index === false ? "Hedge Wall" : "Vol Trigger", suV(L.vt), C.vt]].filter((l) => l[1] != null);
  const far = Math.max(...lv.map((l) => Math.abs(l[1] / sp - 1)), d1 ? (d1.pct / 100) * 1.6 : 0.02);
  const r = Math.min(0.06, Math.max(0.022, far * 1.12)), lo = sp * (1 - r), hi = sp * (1 + r);
  const P = prof.x.map((px, i) => [px, prof.y[i]]).filter((p) => p[0] >= lo && p[0] <= hi);
  if (P.length < 3) return "";
  const ym = Math.max(...P.map((p) => Math.abs(p[1]))) || 1;
  const Lx = 8, Rx = W - 8, T = 22, B = 92, mid = (T + B) / 2;
  const X = (v) => Lx + ((v - lo) / (hi - lo)) * (Rx - Lx), Y = (y) => mid - (y / ym) * ((B - T) / 2) * 0.92;
  const gid = "suTg" + x.symbol;
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" font-size="11" style="display:block;overflow:visible" role="img" aria-label="${esc(x.symbol)} gamma profile by price">`;
  s += `<defs><linearGradient id="${gid}" x1="0" x2="1">${P.map((p) => { const [R, G, Bc] = heatColor(Math.max(-1, Math.min(1, p[1] / ym)), 1); return `<stop offset="${((p[0] - lo) / (hi - lo)).toFixed(4)}" stop-color="rgb(${R},${G},${Bc})"/>`; }).join("")}</linearGradient>
    <clipPath id="c${gid}"><rect x="${Lx}" y="${T}" width="${Rx - Lx}" height="${B - T}" rx="6"/></clipPath></defs>`;
  s += `<rect x="${Lx}" y="${T}" width="${Rx - Lx}" height="${B - T}" rx="6" fill="url(#${gid})"/>`;
  s += `<g clip-path="url(#c${gid})"><line x1="${Lx}" x2="${Rx}" y1="${mid}" y2="${mid}" stroke="${C.hi}" stroke-opacity=".18"/>`;
  s += `<path d="${P.map((p, i) => (i ? "L" : "M") + X(p[0]).toFixed(1) + " " + Y(p[1]).toFixed(1)).join("")}" fill="none" stroke="${C.hi}" stroke-opacity=".85" stroke-width="1.5"/>`;
  if (d1) s += `<rect x="${X(d1.lo)}" y="${T}" width="${X(d1.hi) - X(d1.lo)}" height="${B - T}" fill="${C.hi}" fill-opacity=".07"/>`;
  s += `</g>`;
  // flip: donde el perfil cruza el cero
  let fx = null;
  for (let i = 1; i < P.length; i++) if (Math.sign(P[i][1]) !== Math.sign(P[i - 1][1])) { const [a, ya] = P[i - 1], [b, yb] = P[i]; fx = a + (b - a) * (ya / (ya - yb)); break; }
  if (fx == null) fx = suV(L.flip);
  const items = [...lv, ["Gamma Flip", fx, C.amber]].filter((l) => l[1] != null && l[1] >= lo && l[1] <= hi).sort((a, b) => a[1] - b[1]);
  const rows = [B + 16, B + 31], ends = [-1e9, -1e9];
  items.forEach(([n, v, c]) => {
    const xx = X(v), w = `${n} ${fmtLevel(v)}`.length * 5.9, flip = n === "Gamma Flip";
    s += `<line x1="${xx}" x2="${xx}" y1="${T - 2}" y2="${B + 4}" stroke="${c}" stroke-width="${flip ? 1.2 : 2}"${flip ? ' stroke-dasharray="3 3"' : ""}/>`;
    let a = xx - w / 2, anc = "middle"; if (a < 0) { a = xx; anc = "start"; } else if (xx + w / 2 > W) { a = xx - w; anc = "end"; }
    const k = a > ends[0] + 8 ? 0 : 1; ends[k] = a + w;
    s += `<text x="${xx}" y="${rows[k]}" text-anchor="${anc}" fill="${c}"><tspan font-weight="600">${fmtLevel(v)}</tspan><tspan fill="${C.muted}"> ${n}</tspan></text>`;
  });
  const px = X(sp);
  s += `<line x1="${px}" x2="${px}" y1="${T - 4}" y2="${B + 4}" stroke="${C.text}" stroke-width="1.6"/>`;
  s += `<rect x="${px - 30}" y="2" width="60" height="17" rx="4" fill="${C.text}"/><text x="${px}" y="14.5" text-anchor="middle" fill="${C.ink}" font-weight="700" font-size="11.5">${fmtSpot(sp)}</text>`;
  if (d1) s += `<path d="M${X(d1.lo)} ${B + 40}v4h${X(d1.hi) - X(d1.lo)}v-4" fill="none" stroke="${C.muted}"/><text x="${(X(d1.lo) + X(d1.hi)) / 2}" y="${B + 56}" text-anchor="middle" fill="${C.muted}">1σ ${rangeLabel(d1)} ±${fmtNum(d1.pct, 2)}%</text>`;
  return s + "</svg>";
}
function suIndex(x) {
  if (x.error) return `<article class="su-ix" data-sym="${esc(x.symbol)}"><header><h2>${esc(x.symbol)}</h2></header>${suWait(esc(x.error))}</article>`;
  const neg = x.regime === "negative", L = x.levels, dg = x.prev_net != null ? x.net_per_pct - x.prev_net : null;
  const mv = [["Call Wall", "call_wall"], ["Flip", "flip"], ["Put Wall", "put_wall"]].filter(([, k]) => L[k] && L[k].prev != null && L[k].prev !== L[k].v)
    .map(([t, k]) => `${t} <s>${fmtLevel(L[k].prev)}</s> ${fmtLevel(L[k].v)}`);
  const prof = su.prof[x.symbol], m5 = x.moves && x.moves.d5;
  return `<article class="su-ix ${neg ? "neg" : "pos"}" data-sym="${esc(x.symbol)}" title="Open ${esc(x.symbol)} in the Equity Hub">
    <header><div><h2>${esc(x.symbol)}</h2><span>${esc(x.name || "")}</span></div><div class="px"><b>${fmtSpot(x.spot)}</b><em class="${x.chg >= 0 ? "up" : "dn"}">${x.chg != null ? fmtPct(x.chg) : ""}</em></div></header>
    <div class="reg"><span class="dot"></span><b>${neg ? "Negative" : "Positive"} gamma</b><span>${neg ? "dealers amplify moves" : "dealers dampen moves"}</span></div>
    <div class="ter">${prof ? suTerrain(x, prof) : suWait("Loading the gamma profile…")}</div>
    <dl><div><dt>GEX per 1%</dt><dd class="${x.net_per_pct < 0 ? "dn" : "up"}">${fmtBig(x.net_per_pct, true)}</dd>${dg != null ? `<small>${dg >= 0 ? "▲" : "▼"} ${fmtBig(Math.abs(dg), true)} vs ${ddmm(x.prev_date)}</small>` : ""}</div>
      <div><dt>1σ this week</dt><dd>${m5 ? `±${fmtNum(m5.pct, 2)}%` : "—"}</dd>${m5 ? `<small>${fmtSpot(m5.lo)} – ${fmtSpot(m5.hi)}</small>` : ""}</div>
      <div><dt>Next expiration</dt><dd>${x.front_share != null ? fmtNum(x.front_share * 100, 0) + "%" : "—"}</dd><small>of gamma${x.front_expiry ? ", " + ddmm(x.front_expiry) : ""}</small></div></dl>
    ${mv.length ? `<p class="mv">Since ${ddmm(x.prev_date)}: ${mv.join(", ")}</p>` : ""}</article>`;
}

// ------------------------------------------------------------ graficos pequenos
// area con etiquetas al final de cada linea (en lugar de leyenda)
function suArea(series, W, H, o = {}) {
  series = series.filter((s) => s.pts.length > 1);
  if (!series.length) return "";
  const xs = series.flatMap((s) => s.pts.map((p) => p[0])), ys = series.flatMap((s) => s.pts.map((p) => p[1]));
  const x0 = Math.min(...xs), x1 = Math.max(...xs); let y0 = Math.min(...ys), y1 = Math.max(...ys); const py = (y1 - y0) * 0.14 || 1; y0 -= py; y1 += py;
  const L = 6, R = W - (o.r ?? 64), T = 6, B = H - 20;
  const X = (x) => L + ((x - x0) / (x1 - x0 || 1)) * (R - L), Y = (y) => B - ((y - y0) / (y1 - y0)) * (B - T);
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" font-size="11" style="display:block">`;
  for (let k = 0; k < 4; k++) { const y = T + ((B - T) * k) / 3; s += `<line x1="${L}" x2="${R}" y1="${y}" y2="${y}" stroke="${C.grid}"${k === 3 ? "" : ' stroke-dasharray="2 4"'}/>`; }
  (o.xt || []).forEach(([x, t]) => { s += `<text x="${X(x)}" y="${H - 4}" text-anchor="middle" fill="${C.faint}">${t}</text>`; });
  const ends = [];
  series.forEach((sr, i) => {
    const d = sr.pts.map((p, j) => (j ? "L" : "M") + X(p[0]).toFixed(1) + " " + Y(p[1]).toFixed(1)).join("");
    if (sr.fill) {
      const id = `suGa${o.id || ""}${i}`;
      s += `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sr.c}" stop-opacity=".32"/><stop offset="1" stop-color="${sr.c}" stop-opacity="0"/></linearGradient></defs>`;
      s += `<path d="${d}L${X(sr.pts[sr.pts.length - 1][0])} ${B}L${X(sr.pts[0][0])} ${B}Z" fill="url(#${id})"/>`;
    }
    s += `<path d="${d}" fill="none" stroke="${sr.c}" stroke-width="${sr.w || 1.8}"${sr.dash ? ` stroke-dasharray="${sr.dash}"` : ""} stroke-linejoin="round" stroke-linecap="round"/>`;
    if (sr.end) { const p = sr.pts[sr.pts.length - 1]; ends.push({ y: Y(p[1]), c: sr.c, t: sr.end, x: X(p[0]) }); }
  });
  ends.sort((a, b) => a.y - b.y).forEach((e, k, arr) => {
    if (k && e.y < arr[k - 1].y + 14) e.y = arr[k - 1].y + 14;
    s += `<circle cx="${e.x}" cy="${e.y}" r="3.2" fill="${e.c}"/><text x="${R + 8}" y="${e.y + 4}" fill="${e.c}" font-weight="600">${e.t}</text>`;
  });
  return s + "</svg>";
}
// banda de un ano: rango, zona p10-p90, mediana y valor actual con su percentil
function suRange(label, cur, arr, fmt) {
  const a = arr.filter((v) => v != null && isFinite(v));
  if (a.length < 20 || cur == null || !isFinite(cur)) return "";
  const mn = Math.min(...a, cur), mx = Math.max(...a, cur), X = (v) => (((v - mn) / (mx - mn || 1)) * 100).toFixed(2) + "%";
  const pc = (a.filter((v) => v <= cur).length / a.length) * 100;
  return `<div class="su-rg"><div class="t"><span>${label}</span><b>${fmt(cur)}</b><em>${ordinal(pc)} pct</em></div>
    <div class="b"><i class="band" style="left:${X(suQ(a, 0.1))};right:calc(100% - ${X(suQ(a, 0.9))})"></i><i class="med" style="left:${X(suQ(a, 0.5))}"></i><i class="cur${pc > 80 ? " hi" : pc < 20 ? " lo" : ""}" style="left:${X(cur)}"></i></div>
    <div class="s"><span>${fmt(mn)}</span><span>${fmt(mx)}</span></div></div>`;
}
// mapa de regimen: distancia al flip frente a la variacion del dia; etiquetas sin tapar puntos ni otras etiquetas
function suRegimeMap(rows, W = 520, H = 300) {
  const xm = Math.min(12, Math.max(3, ...rows.map((r) => Math.abs(r.flip_dist)))) * 1.1, ym = Math.max(1, ...rows.map((r) => Math.abs(r.chg || 0))) * 1.2;
  const L = 40, R = W - 12, T = 12, B = H - 30, X = (v) => L + ((v + xm) / (2 * xm)) * (R - L), Y = (v) => B - ((v + ym) / (2 * ym)) * (B - T);
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" font-size="11" style="display:block" role="img" aria-label="Watchlist regime map">`;
  s += `<rect x="${L}" y="${T}" width="${X(0) - L}" height="${B - T}" fill="${C.neg}" fill-opacity=".07"/><rect x="${X(0)}" y="${T}" width="${R - X(0)}" height="${B - T}" fill="${C.pos}" fill-opacity=".07"/>`;
  s += `<line x1="${X(0)}" x2="${X(0)}" y1="${T}" y2="${B}" stroke="${C.amber}" stroke-dasharray="3 3"/><line x1="${L}" x2="${R}" y1="${Y(0)}" y2="${Y(0)}" stroke="${C.axis}"/>`;
  s += `<text x="${L + 8}" y="${T + 14}" fill="${C.neg}" font-weight="600">Below the flip</text><text x="${R - 8}" y="${T + 14}" text-anchor="end" fill="${C.pos}" font-weight="600">Above the flip</text>`;
  [-1, -0.5, 0.5, 1].forEach((f) => { const v = (f * xm) / 1.1; s += `<text x="${X(v)}" y="${B + 16}" text-anchor="middle" fill="${C.faint}">${fmtNum(v, 0)}%</text>`; });
  s += `<text x="${X(0)}" y="${B + 16}" text-anchor="middle" fill="${C.amber}">flip</text>`;
  s += `<text x="${L - 6}" y="${Y(ym / 1.2) + 4}" text-anchor="end" fill="${C.faint}">+${fmtNum(ym / 1.2, 1)}%</text><text x="${L - 6}" y="${Y(-ym / 1.2) + 4}" text-anchor="end" fill="${C.faint}">−${fmtNum(ym / 1.2, 1)}%</text>`;
  s += `<text transform="translate(12,${(T + B) / 2}) rotate(-90)" text-anchor="middle" fill="${C.faint}">Change today</text>`;
  const pts = rows.map((r) => ({ r, x: X(Math.max(-xm, Math.min(xm, r.flip_dist))), y: Y(r.chg || 0), rad: r.is_index ? 6.5 : 5 }));
  pts.forEach((p) => { s += `<circle cx="${p.x}" cy="${p.y}" r="${p.rad}" fill="${p.r.regime === "negative" ? C.neg : C.pos}" fill-opacity=".9" stroke="${C.surface}" stroke-width="1.5"><title>${esc(p.r.symbol)}: ${fmtPct(p.r.flip_dist)} from the flip, ${fmtPct(p.r.chg || 0)} today</title></circle>`; });
  const boxes = pts.map((p) => [p.x - p.rad - 1, p.y - p.rad - 1, p.x + p.rad + 1, p.y + p.rad + 1]);
  const hit = (b) => b[0] < L || b[2] > R || b[1] < T || b[3] > B || boxes.some((o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]);
  pts.sort((a, b) => a.x - b.x).forEach((p) => {
    const w = p.r.symbol.length * 7 + 2, h = 12, cand = [];
    for (const d of [0, 14, 26, 40]) cand.push([p.x + 9 + d * 0.3, p.y - h / 2 - d], [p.x - 9 - w, p.y - h / 2 - d], [p.x + 9, p.y - h / 2 + d], [p.x - 9 - w, p.y - h / 2 + d], [p.x - w / 2, p.y - p.rad - 4 - h - d], [p.x - w / 2, p.y + p.rad + 4 + d]);
    const [bx, by] = cand.find(([a, b]) => !hit([a, b, a + w, b + h])) || cand[0];
    boxes.push([bx, by, bx + w, by + h]);
    if (Math.hypot(bx + w / 2 - p.x, by + h / 2 - p.y) > 26) s += `<line x1="${p.x}" y1="${p.y}" x2="${bx < p.x ? bx + w : bx}" y2="${by + h / 2}" stroke="${C.faint}" stroke-width=".8"/>`;
    s += `<text x="${bx + 1}" y="${by + h - 2}" fill="${C.text}" font-weight="600">${esc(p.r.symbol)}</text>`;
  });
  return s + "</svg>";
}

// ------------------------------------------------------------ bloques de abajo
function suVol(d) {
  const V = su.vix, sv = su.vol && su.vol.summary;
  const head = `<header><h3>Volatility</h3>${d.vix && d.vix.shape ? `<span class="pill ${SHAPE_CLASS[d.vix.shape.code] || ""}"><i></i>${esc(SHAPE_LABEL[d.vix.shape.code] || d.vix.shape.label)}</span>` : ""}</header>`;
  if (!V || V.error) return `<section class="su-card su-vol" data-go="vix">${head}${suWait(V && V.error ? esc(V.error) : "Loading the VIX curve…")}</section>`;
  const vp = V.points || [], cv = (pts, spot) => [[0, spot]].concat((pts || []).map((p) => [p.days, p.settle]));
  const dv = V.prev ? V.vix_close - V.prev.vix : null, last = vp.length ? vp[vp.length - 1].days : 0;
  const series = [];
  if (V.week) series.push({ pts: cv(V.week.points, V.week.vix), c: C.faint, dash: "2 4", w: 1.2, end: ddmm(V.week.date) });
  if (V.prev) series.push({ pts: cv(V.prev.points, V.prev.vix), c: C.muted, dash: "5 4", w: 1.2, end: ddmm(V.prev.date) });
  series.push({ pts: cv(vp, V.vix_close), c: C.accent, fill: true, w: 2.2, end: "Today" });
  return `<section class="su-card su-vol" data-go="vix" title="Open the VIX curve">${head}
    <div class="su-kpis"><div><span>VIX</span><b>${fmtNum(V.vix_close, 2)}</b><em class="${dv > 0 ? "dn" : "up"}">${dv != null ? (dv >= 0 ? "+" : "−") + fmtNum(Math.abs(dv), 2) + " vs prev." : ""}</em></div>
      <div><span>VIX / VIX3M</span><b>${V.vix_vix3m ? fmtNum(V.vix_vix3m, 2) : "—"}</b><em>${V.vix_vix3m >= 1 ? "stress: front above back" : "calm term structure"}</em></div>
      <div><span>Curve slope M2/M1</span><b>${sgnPct(V.spread)}</b><em>${ordinal(V.spread_pct_rank)} pct of the year</em></div></div>
    <div class="su-chart">${suArea(series, 600, 180, { id: "v", xt: [[0, "spot"], [30, "30d"], [90, "90d"], [180, "180d"]].filter((t) => t[0] <= last) })}</div>
    <div class="su-term">${(V.term || []).map((t) => `<div><span>${esc(t.symbol)}</span><b>${fmtNum(t.value, 2)}</b></div>`).join("")}</div>
    ${sv ? `<p class="su-read"><b>SPX</b> 30-day IV <b>${fmtNum(sv.iv30 * 100, 1)}%</b> vs realized <b>${fmtNum(sv.rv20 * 100, 1)}%</b>: options pay a premium of <b>${fmtNum((sv.iv30 - sv.rv20) * 100, 1)} pts</b>. Skew 25Δ <b>${fmtNum(sv.rr25 * 100, 1)} pts</b>.</p>` : ""}</section>`;
}
function suCorr() {
  const K = su.corr, head = `<header><h3>Correlation and dispersion</h3><span class="sub">Implied correlation of the S&P 500 and the dispersion index, last year</span></header>`;
  if (!K || K.error || !K.history) return `<section class="su-card su-corr" data-go="corr">${head}${suWait(K && K.error ? esc(K.error) : "Loading…")}</section>`;
  const h = K.history.slice(-252), last = h[h.length - 1] || {};
  const tick = []; h.forEach((r, i) => { const m = +r.date.slice(5, 7); if (i && r.date.slice(5, 7) !== h[i - 1].date.slice(5, 7) && m % 3 === 1) tick.push([i, SU_MES[m - 1]]); });
  const dp = K.dspx || {};
  return `<section class="su-card su-corr" data-go="corr" title="Open Correlation">${head}
    <div class="su-chart">${suArea([
      { pts: h.map((r, i) => [i, r.dspx]).filter((p) => p[1] != null), c: C.amber, w: 1.6, end: "DSPX " + fmtNum(dp.value ?? last.dspx, 1) },
      { pts: h.map((r, i) => [i, r.cor1m]).filter((p) => p[1] != null), c: C.pos, fill: true, w: 2, end: "COR1M " + fmtNum(last.cor1m, 1) }], 600, 200, { id: "c", xt: tick, r: 92 })}</div>
    <div class="su-rgs">${suRange("COR1M", last.cor1m, h.map((r) => r.cor1m), (v) => fmtNum(v, 1))}
      ${suRange("COR3M", last.cor3m, h.map((r) => r.cor3m), (v) => fmtNum(v, 1))}
      ${suRange("DSPX", dp.value ?? last.dspx, h.map((r) => r.dspx), (v) => fmtNum(v, 1))}
      <p class="su-read">${dp.pct > 70 ? "Single stocks are expected to move far more than the index: the index stays calm while names diverge." : dp.pct < 30 ? "Stocks are expected to move together: index risk dominates." : "Dispersion in its usual range."}</p></div></section>`;
}
function suRadar() {
  const rows = ((typeof hub !== "undefined" && hub.scan) || []).filter((r) => !r.error && r.flip && r.flip_dist != null);
  return `<section class="su-card su-radar"><header><h3>Watchlist regime map</h3><span class="sub">Distance to the Gamma Flip against today's change</span></header>
    ${rows.length ? suRegimeMap(rows) : suWait("Loading the watchlist…")}</section>`;
}
function suFlow() {
  const F = su.flow, head = (sub) => `<header><h3>SPX options flow</h3><span class="sub">${sub}</span></header>`;
  if (!F || F.error || !F.series || !F.series.length) return `<section class="su-card su-flow" data-go="flow">${head("estimated")}${suWait(F && F.error ? esc(F.error) : "Loading…")}</section>`;
  const fl = F.series[F.series.length - 1], tot = Math.abs(fl.cp) + Math.abs(fl.pp) || 1, top = (F.uoa || []).slice(0, 5), mx = top.length ? top[0].prem : 1;
  return `<section class="su-card su-flow" data-go="flow" title="Open Options flow">${head(`${ddmm(F.session)}, estimated`)}
    <div class="su-cp"><div><span>Calls bought</span><b class="up">${fmtBig(fl.cp, true)}</b></div><div class="r"><span>Puts bought</span><b class="dn">${fmtBig(fl.pp, true)}</b></div></div>
    <div class="su-cpb"><i style="flex:${Math.abs(fl.cp) / tot};background:${C.put}"></i><i style="flex:${Math.abs(fl.pp) / tot};background:${C.call}"></i></div>
    <div class="su-nd"><span>Net customer delta</span><b>${fmtBig(fl.d, true)}</b></div>
    <h4>Largest unusual trades</h4>
    <table class="su-uoa">${top.map((u) => `<tr><td><b class="${u.c ? "up" : "dn"}">${fmtNum(u.k, 0)}${u.c ? "C" : "P"}</b></td><td>${ddmm(u.exp)}</td><td>${u.oi ? fmtNum(u.vol / u.oi, 1) + "× OI" : "new"}</td><td><span class="su-mini"><i style="width:${((u.prem / mx) * 100).toFixed(0)}%"></i></span></td><td>${fmtBig(u.prem, true)}</td></tr>`).join("")}</table></section>`;
}
function suCot(c) {
  const head = `<header><h3>COT extremes</h3><span class="sub">3-year positioning index${c && c.report_date ? `, report ${ddmm(c.report_date)}` : ""}. Near 0 or 100 is an extreme.</span></header>`;
  if (!c || c.error) return `<section class="su-card su-cot">${head}${suWait(c ? esc(c.error) : "—")}</section>`;
  if (!c.extremes.length) return `<section class="su-card su-cot">${head}${suWait("No group is above 90 or below 10 in its 3-year range.")}</section>`;
  return `<section class="su-card su-cot">${head}${c.extremes.slice(0, 7).map((e) => `<div class="su-g" data-k="${esc(e.key)}" title="net ${fmtBig(e.net)} (${e.chg > 0 ? "+" : ""}${fmtBig(e.chg)})">
    <div class="t"><b>${esc(e.name)}</b><span>${esc(e.group)}</span></div><div class="b"><i style="left:${e.index}%" class="${e.index >= 90 ? "hi" : e.index <= 10 ? "lo" : ""}"></i></div><em>${fmtNum(e.index, 0)}</em></div>`).join("")}</section>`;
}

// ------------------------------------------------------------ pintar y eventos
function renderSummary() {
  const d = sm.data;
  if (!d) return;
  const s = d.session, q0 = d.indices.find((c) => !c.error);
  $("sumSub").textContent = q0 ? `Options data from ${nyHHMM(q0.quote_time)} on ${longDate(q0.quote_time.slice(0, 10))}, risk-free rate ${fmtNum(d.rate.r * 100, 2)}%` : "";
  $("sumSess").innerHTML = s.open ? `Market open, closes at <b>${localTime(s.close_utc)}</b>` : `Market closed, opens <b>${localTime(s.next_open_utc, true)}</b>`;
  $("sumBody").innerHTML = suHero(d) + `<div class="su-idx">${d.indices.map(suIndex).join("")}</div>`
    + `<div class="su-g2">${suVol(d)}${suCorr()}</div><div class="su-g3">${suRadar()}${suFlow()}${suCot(d.cot)}</div>`;
  suLoad();
  if (!su.timer) su.timer = setInterval(() => { if (state.mode === "summary" && sm.data && $("suClock")) $("suClock").innerHTML = suClock(sm.data.session); }, 30000);
}
function bindSummary() {
  $("sumView").addEventListener("click", (e) => {
    const g = e.target.closest(".su-g[data-k]");
    if (g) { cot.sel = g.dataset.k; store.set("cotSel", g.dataset.k); setMode("cot"); return; }
    const ix = e.target.closest(".su-ix[data-sym]");
    if (ix) { $("symbol").value = ix.dataset.sym; $("spotInput").value = ""; setMode("analysis"); load(); return; }
    const go = e.target.closest("[data-go]");
    if (go) setMode(go.dataset.go);
  });
}
