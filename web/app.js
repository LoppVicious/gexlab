"use strict";

/* ============================================================ estado */
// paletas del tema oscuro (por defecto) y claro; C se actualiza al cambiar de tema y se redibuja todo
const THEMES = {
  // oscuro "Bento" y claro "Daylight": los mismos tonos que los tokens de tema.css
  dark: {
    ink: "#000000", surface: "#121214", grid: "#1f1f23", axis: "#2e2e34",
    text: "#fafafa", muted: "#a1a1aa", faint: "#71717a",
    neg: "#ff2f7c", pos: "#9461ff", negFront: "#ff9cc0", posFront: "#c9b0ff", put: "#22c58b", amber: "#f2b632", call: "#ff5a5f",
    accent: "#34d3b0", hi: "#ffffff", candle: "#f4f4f5", spotline: "#d4d4d8",
    heat0: [14, 14, 16], heatNeg: [255, 40, 120], heatPos: [146, 76, 255],
  },
  light: {
    ink: "#f2f3f8", surface: "#ffffff", grid: "#eceef4", axis: "#d3d7e3",
    text: "#11142b", muted: "#4c5170", faint: "#8288a6",
    neg: "#e11d6a", pos: "#6a3df0", negFront: "#f193b8", posFront: "#b7a2f7", put: "#0b9b6a", amber: "#c27c0e", call: "#e5484d",
    accent: "#5145e5", hi: "#000000", candle: "#11142b", spotline: "#4c5170",
    heat0: [252, 252, 254], heatNeg: [225, 29, 106], heatPos: [106, 61, 240],
  },
};
// colores de apoyo que dependen del tema (lineas del mensual, indices de volatilidad, cierre anterior...)
const THEME_EXTRA = {
  // vt: Vol Trigger / Hedge Wall, naranja para no confundirlo con el Gamma Flip (ambar); bar: barras del Impacto;
  // area: opacidad del relleno del perfil
  dark: { purple: "#8b7cf0", month: "oklch(0.78 0.15 45)", xmonth: "oklch(0.74 0.12 300)", prevClose: "#5b9dff", vt: "#ff8a3d",
    bar: "#9461ff", barOp: 0.55, area: 0.16, vol: ["#34d3b0", "#9461ff", "#ff2f7c", "#f2b632", "#4fa3ff"] },
  light: { purple: "#6a3df0", month: "oklch(0.58 0.17 45)", xmonth: "oklch(0.48 0.16 300)", prevClose: "#1f63c2", vt: "#c2410c",
    bar: "#7b879c", barOp: 0.7, area: 0.22, vol: ["#5145e5", "#6a3df0", "#e11d6a", "#c27c0e", "#0b9b6a"] },
};
Object.keys(THEMES).forEach((k) => Object.assign(THEMES[k], THEME_EXTRA[k]));
const C = Object.assign({}, THEMES[document.documentElement.dataset.theme === "light" ? "light" : "dark"]);
// letra de los graficos (en pantalla tema.css aplica la del tema; esta vale para las imagenes exportadas)
const MONO = "'Manrope', -apple-system, 'Segoe UI', Roboto, sans-serif";
const SANS = "'Manrope', -apple-system, 'Segoe UI', Roboto, sans-serif";

// preferencias: en el servidor publicado son de cada usuario (llegan en me.js y se guardan en /api/prefs);
// en el PC, en el navegador
const ME = window.GEX_ME || null;
const store = ME ? {
  _p: Object.assign({}, ME.prefs || {}), _t: null,
  get(k, d) { return Object.prototype.hasOwnProperty.call(this._p, k) ? this._p[k] : d; },
  set(k, v) {
    if (this._p[k] === String(v)) return;
    this._p[k] = String(v);
    clearTimeout(this._t);
    this._t = setTimeout(() => fetch("/api/prefs", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefs: this._p }), keepalive: true }).catch(() => {}), 800);
  },
} : {
  get(k, d) { try { const v = localStorage.getItem("gexlab." + k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("gexlab." + k, v); } catch { /* sin almacenamiento */ } },
};
// sesion caducada: cualquier 401 de la API lleva al inicio de sesion
if (ME) {
  const _fetch = window.fetch.bind(window);
  window.fetch = (...a) => _fetch(...a).then((r) => {
    if (r.status === 401) r.clone().json().catch(() => ({})).then((d) => location.replace(d.motivo === "otro" ? "/login?motivo=otro" : "/login.html"));
    return r;
  });
  // un solo dispositivo por cuenta: si otro dispositivo entra con este usuario, este se entera en menos de un minuto
  if (ME.nube) setInterval(() => { if (!document.hidden) window.fetch("/api/sesion").catch(() => {}); }, 45000);
  document.addEventListener("visibilitychange", () => { if (ME && ME.nube && !document.hidden) window.fetch("/api/sesion").catch(() => {}); });
}

// valores por defecto nuevos (rango Auto y actualizacion automatica): se aplican una vez a todos
if (store.get("defs", "0") < "2") { store.set("range", "auto"); store.set("autoOn", "1"); }
if (store.get("defs", "0") < "3") { store.set("model", "spotgamma"); store.set("defs", "3"); }
// motor Auto para todos: Neto (gexbot) en 0DTE, Perfil (spotgamma) en el resto
if (store.get("defs", "0") < "4") { store.set("model", "auto"); store.set("defs", "4"); }
const state = {
  symbol: store.get("symbol", "SPX"),
  dte: store.get("dte", "45"),
  range: store.get("range", "auto"),
  view: store.get("view", "impact"),
  hubView: store.get("hubView", "impact"),
  bars: store.get("bars", "net"),
  mode: store.get("mode", "analysis"),
  regimeFilter: "all",
  showLevels: store.get("levels", "1") === "1",
  mapMode: store.get("mapMode", "strike"),
  mapSess: "auto",
  // mapa: lente (gamma, Delta Pressure, Charm Pressure), velas, escala de color, contornos y barras de la izquierda
  mapLens: store.get("mapLens", "gamma"),
  mapCandle: store.get("mapCandle", "5"),
  mapScale: store.get("mapScale", "auto"),
  mapContour: store.get("mapContour", "1") === "1",
  mapBars: store.get("mapBars", "gex"),
  mapBars0: store.get("mapBars0", "0") === "1",
  mapZoom: null,  // { sym, lo, hi }: zoom vertical del mapa (arrastrar; doble clic para volver)
  greek: store.get("greek", "gamma"),
  oiMode: store.get("oiMode", "total"),
  dbars: store.get("dbars", "net"),
  lines: (() => { try { return new Set(JSON.parse(store.get("lines", '["total"]'))); } catch { return new Set(["total"]); } })(),
  pos: store.get("pos", "standard"),
  model: store.get("model", "auto"),
  validMode: "standard",
  cmpTrail: store.get("cmpTrail", "5"),  // sesiones de historial que dibuja la estela del Compass (0 = sin estela)
  watch: null,
  combo: store.get("combo", "0") === "1",
  auto: false, autoTimer: null,
  heat: null, heatKey: "", heatImg: null, heatCtrl: null,
  scanView: store.get("scanView", "table"),
  data: null,
  geo: null,
  ctrl: null,
};

const $ = (id) => document.getElementById(id);

/* ============================================================ formato (en-US) */
function fmtNum(v, dec = 0) {
  if (v == null || !isFinite(v)) return "—";
  const neg = v < 0;
  const [i, d] = Math.abs(v).toFixed(dec).split(".");
  const int = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "−" : "") + int + (d ? "." + d : "");
}
function decFor(step) { return step >= 1 && Number.isInteger(step) ? 0 : (step * 10) % 1 === 0 ? 1 : 2; }
function fmtLevel(v) {
  if (v == null) return "—";
  const st = state.data ? state.data.step : 1;
  return fmtNum(v, Number.isInteger(v) ? 0 : decFor(st));
}
function fmtSpot(v) { return fmtNum(v, v >= 1000 ? 0 : v >= 100 ? 1 : 2); }
function fmtBig(v, cur = false) {
  if (v == null || !isFinite(v)) return "—";
  const a = Math.abs(v), s = v < 0 ? "−" : "", p = cur ? "$" : "";
  const unit = a >= 1e9 ? [1e9, "B"] : a >= 1e6 ? [1e6, "M"] : a >= 1e3 ? [1e3, "K"] : [1, ""];
  const x = a / unit[0];
  const dec = x >= 100 || unit[1] === "" ? 0 : x >= 10 ? 1 : 2;
  return s + p + fmtNum(x, dec) + unit[1];
}
function fmtAxis(v) {
  if (v === 0) return "0";
  const a = Math.abs(v), s = v < 0 ? "-" : "";
  if (a >= 1e9) return s + trimZ(a / 1e9) + "B";
  if (a >= 1e6) return s + trimZ(a / 1e6) + "M";
  if (a >= 1e3) return s + trimZ(a / 1e3) + "K";
  return s + trimZ(a);
}
function trimZ(x) { return fmtNum(x, x % 1 === 0 ? 0 : 1).replace("−", ""); }
// fechas cortas "Nov 13" y largas "Nov 13, 2026" (sin ambiguedad dia/mes)
const MESES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function ddmm(iso) { return iso ? `${MESES[+iso.slice(5, 7) - 1]} ${+iso.slice(8, 10)}` : ""; }
function fullDate(iso) { return iso ? `${ddmm(iso)}, ${iso.slice(0, 4)}` : ""; }
// vencimientos: "Fri Nov 13, weekly, 5 d" (tipo segun el motor: diario, semanal o mensual)
const DIAS_SEM = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const KIND_EN = { diario: "daily", semanal: "weekly", mensual: "monthly" };
function expDays(d, iso) {
  const ref = (d.computed_at || "").slice(0, 10) || d.session;   // dias desde hoy (NY), no desde la ultima sesion
  if (!iso || !ref) return null;
  return Math.round((Date.parse(iso + "T12:00:00Z") - Date.parse(ref + "T12:00:00Z")) / 86400e3);
}
function expText(d, iso, withKind = true) {
  if (!iso) return "";
  const e = (d.expiries || []).find((x) => x.date === iso);
  const n = expDays(d, iso);
  const wd = DIAS_SEM[new Date(iso + "T12:00:00Z").getUTCDay()];
  return `${wd} ${ddmm(iso)}${withKind && e ? `, ${KIND_EN[e.kind] || e.kind}` : ""}${n == null ? "" : n <= 0 ? ", today" : `, ${n} d`}`;
}
function ordinal(n) { const k = Math.round(n), t = k % 100, u = k % 10; return k + (t >= 11 && t <= 13 ? "th" : u === 1 ? "st" : u === 2 ? "nd" : u === 3 ? "rd" : "th"); }
function fmtPct(v) { return (v > 0 ? "+" : v < 0 ? "−" : "") + fmtNum(Math.abs(v), 2) + "%"; }
/* ============================================================ horas: el servidor trabaja en hora de Nueva York (ET)
   y CBOE da sus marcas en UTC; en pantalla todo se muestra en la hora local del dispositivo */
const _nyFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false,
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
function nyDate(str) {
  // "YYYY-MM-DD HH:MM" en hora de Nueva York -> Date
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(str || "");
  if (!m) return null;
  const want = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let t = want + 5 * 3600e3;
  for (let k = 0; k < 2; k++) {
    const p = Object.fromEntries(_nyFmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    const seen = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute);
    t += want - seen;
  }
  return new Date(t);
}
function utcDate(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(str || "");
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0))) : null;
}
function hhmm(dt) { return dt ? dt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : ""; }
function nyHHMM(str) { return hhmm(nyDate(str)); }
// hora local con el dia si no es hoy ("yesterday 22:00", "Fri 30 22:00")
function nyWhen(str) {
  const dt = nyDate(str);
  if (!dt) return "";
  const today = new Date(), y = new Date(Date.now() - 86400e3);
  const same = (a, b) => a.toDateString() === b.toDateString();
  const day = same(dt, today) ? "" : same(dt, y) ? "yesterday " : `${DIAS_SEM[dt.getDay()]} ${dt.getDate()} `;
  return day + hhmm(dt);
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

/* ============================================================ escalas */
function niceStep(range, target) {
  const raw = range / Math.max(1, target);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}
function niceTicks(lo, hi, target = 5) {
  if (lo === hi) { lo -= 1; hi += 1; }
  const st = niceStep(hi - lo, target);
  const a = Math.floor(lo / st) * st, b = Math.ceil(hi / st) * st;
  const ticks = [];
  for (let v = a; v <= b + st / 2; v += st) ticks.push(Math.round(v / st) * st);
  return { ticks, lo: a, hi: b };
}

/* ============================================================ etiquetas de nivel */
function levelItems(d) {
  const L = d.levels;
  return [
    { key: "put_wall", tag: "PUT WALL", name: "Put Wall", v: L.put_wall, c: C.put },
    d.is_index === false
      ? { key: "vt", tag: "HEDGE WALL", name: "Hedge Wall", v: L.vt, c: C.vt }
      : { key: "vt", tag: "VT", name: "Vol Trigger", v: L.vt, c: C.vt },
    { key: "flip", tag: "G-FLIP", name: "Gamma Flip", v: L.flip, c: C.amber },
    { key: "call_wall", tag: "CALL WALL", name: "Call Wall", v: L.call_wall, c: C.call },
  ].filter((x) => x.v != null);
}

function placeTags(items, xOf, left, right, fs) {
  const cw = fs * 0.61, padX = 12, h = fs + 14, gap = 10;
  const placed = items
    .map((it) => {
      const raw = xOf(it.v);
      const off = raw < left - 1 ? -1 : raw > right + 1 ? 1 : 0;
      const text = `${off < 0 ? "‹ " : ""}${it.tag} ${fmtLevel(it.v)}${off > 0 ? " ›" : ""}`;
      const w = text.length * cw + padX * 2;
      const x = off < 0 ? left : off > 0 ? right : raw;
      return { ...it, text, w, x, h, off, left: Math.min(Math.max(x - w / 2, left), right - w) };
    })
    .sort((a, b) => a.x - b.x);
  const rowsEnd = [];
  for (const t of placed) {
    let r = 0;
    while (r < rowsEnd.length && t.left < rowsEnd[r] + gap) r++;
    t.row = r;
    rowsEnd[r] = t.left + t.w;
  }
  return { tags: placed, rows: Math.max(1, rowsEnd.length), h };
}

function tagLine(t, y, plotBottom) {
  return `<line x1="${t.x}" y1="${y + t.h}" x2="${t.x}" y2="${plotBottom}" stroke="${t.c}" stroke-width="1.6" stroke-dasharray="5 4"/>`;
}
function tagBox(t, y, fs) {
  const cx = t.left + t.w / 2;
  const title = t.off ? `<title>${t.name} outside the visible range</title>` : "";
  return `<g opacity="${t.off ? (C.ink === THEMES.light.ink ? 0.85 : 0.7) : 1}">${title}
  <rect x="${t.left}" y="${y}" width="${t.w}" height="${t.h}" rx="7" fill="${C.surface}"/>
  <rect x="${t.left}" y="${y}" width="${t.w}" height="${t.h}" rx="7" fill="${t.c}" fill-opacity="0.09" stroke="${t.c}" stroke-width="1.4"/>
  <text x="${cx}" y="${y + t.h / 2 + fs * 0.36}" text-anchor="middle" font-family="${MONO}" font-size="${fs}" font-weight="600" fill="${t.c}">${esc(t.text)}</text></g>`;
}
function tagsSVG(pt, titleH, bottom, fs) {
  const yOfRow = (t) => titleH + 14 + t.row * (t.h + 8);
  return pt.tags.filter((t) => !t.off).map((t) => tagLine(t, yOfRow(t), bottom)).join("") + pt.tags.map((t) => tagBox(t, yOfRow(t), fs)).join("");
}

/* ============================================================ gráfico por strike */
// Agrupa strikes contiguos cuando hay demasiados para el ancho disponible (NDX: un strike cada 5 puntos).
// Cada grupo suma sus strikes y se centra en un multiplo redondo; devuelve {k, step, arrays}
const BUCKET_MULT = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500];
function bucketStrikes(ks, arrs, step, maxN) {
  if (!ks.length || !step || ks.length <= maxN) return { k: 1, step, ks: ks.slice(), arrs: arrs.map((a) => (a ? a.slice() : null)) };
  const span = (ks[ks.length - 1] - ks[0]) / step + 1;
  const k = BUCKET_MULT.find((m) => span / m <= maxN) || BUCKET_MULT[BUCKET_MULT.length - 1];
  const bs = k * step, idx = new Map(), out = [];
  ks.forEach((v, i) => {
    const c = Math.round(Math.round(v / bs) * bs * 1e4) / 1e4;
    if (!idx.has(c)) { idx.set(c, out.length); out.push(c); }
  });
  const res = arrs.map((a) => { const r = new Array(out.length).fill(0); if (a) ks.forEach((v, i) => { r[idx.get(Math.round(Math.round(v / bs) * bs * 1e4) / 1e4)] += a[i] || 0; }); return a ? r : null; });
  // grupos vacios intermedios: la rejilla queda regular
  const full = [], fullA = res.map((r) => (r ? [] : null));
  for (let c = out[0]; c <= out[out.length - 1] + bs / 2; c = Math.round((c + bs) * 1e4) / 1e4) {
    const j = idx.get(c);
    full.push(c);
    res.forEach((r, a) => { if (r) fullA[a].push(j == null ? 0 : r[j]); });
  }
  return { k, step: bs, ks: full, arrs: fullA };
}
function bucketData(d, maxN) {
  const keys = ["net", "calls", "puts", "front", "vanna", "charm"];
  const rows = d.by_exp ? d.by_exp.gex : [];
  const OIK = ["calls", "puts", "chg_calls", "chg_puts", "net_pos"], oiRows = OIK.map((x) => (d.oi && d.oi[x]) || null);
  const DK = ["net", "calls", "puts"], dRows = DK.map((x) => (d.delta && d.delta[x]) || null);
  const b = bucketStrikes(d.strikes, [...keys.map((x) => d[x] || null), ...oiRows, ...dRows, ...rows], d.step, maxN);
  if (b.k === 1) return d;
  const o = { ...d, strikes: b.ks, step: b.step, bucket: b.k, bucketStep: d.step };
  keys.forEach((x, i) => { if (b.arrs[i]) o[x] = b.arrs[i]; });
  let j = keys.length;
  if (d.oi) { o.oi = { ...d.oi }; OIK.forEach((x, i) => { o.oi[x] = b.arrs[j + i]; }); }
  j += OIK.length;
  if (d.delta) { o.delta = {}; DK.forEach((x, i) => { o.delta[x] = b.arrs[j + i]; }); }
  j += DK.length;
  if (d.by_exp) o.by_exp = { ...d.by_exp, gex: b.arrs.slice(j) };
  return o;
}

// "Barras: Vencimiento": un color por vencimiento en una sola gama (el mas proximo verde azulado, los lejanos violeta);
// los posteriores a los que tienen color propio, juntos en gris
// tres familias de color: el proximo vencimiento (verde azulado), los semanales (violetas, mas oscuros cuanto mas
// lejos) y los mensuales (corales); los posteriores, en gris. Los diarios van dentro del semanal o mensual de su semana
const expG = (d) => !!(d && d.by_exp && d.by_exp.groups);
function expColors(be) {
  const light = document.documentElement.dataset.theme === "light";
  const gs = be.groups, nW = gs.filter((g) => g.kind === "semanal").length, nM = gs.filter((g) => g.kind === "mensual").length;
  let iW = 0, iM = 0;
  const ramp = (i, n, L0, L1, C0, C1, h0, h1) => {
    const t = n > 1 ? i / (n - 1) : 0, dl = light ? -0.14 : 0;
    return `oklch(${(L0 + (L1 - L0) * t + dl).toFixed(3)} ${(C0 + (C1 - C0) * t).toFixed(3)} ${(h0 + (h1 - h0) * t).toFixed(1)})`;
  };
  return gs.map((g) => g.kind === "proximo" ? (light ? "oklch(0.66 0.14 172)" : "oklch(0.82 0.15 172)")
    : g.kind === "semanal" ? ramp(iW++, nW, 0.84, 0.56, 0.11, 0.2, 290, 300)
      : g.kind === "mensual" ? ramp(iM++, nM, 0.82, 0.66, 0.14, 0.17, 50, 32)
        : C.faint);
}
function expLabels(d) { // etiqueta de cada grupo
  return d.by_exp.groups.map((g) => {
    if (g.kind === "proximo") { const n = expDays(d, g.date); return `${n != null && n <= 0 ? "0DTE" : "Next"} ${expText(d, g.date, false)}`; }
    if (g.kind === "posteriores") return `Later ${ddmm(g.from)}–${ddmm(g.to)}`;
    const extra = g.from !== g.to ? " + dailies" : "";
    return `${g.kind === "mensual" ? "Monthly" : "Weekly"} ${expText(d, g.date, false)}${extra}`;
  });
}

// lineas sobre "Por strike" (como el Put & Call Impact de SpotGamma): la gamma o la delta total de los dealers si el
// precio estuviera en cada nivel, la del proximo vencimiento, la del mensual y el total sin cada uno de ellos
const LINE_DEF = [
  { k: "total", lab: "Total", c: () => C.text },
  { k: "next", lab: "Next expiration", c: () => C.accent },
  { k: "month", lab: "Monthly", c: () => C.month },
  { k: "xnext", lab: "Total ex next", c: () => C.amber, dash: true },
  { k: "xmonth", lab: "Total ex monthly", c: () => C.xmonth, dash: true },
];
function strikeLines(d) {
  const P = d.profile, g = state.greek;
  if (!P || (g !== "gamma" && g !== "delta") || !state.lines.size) return [];
  const tot = g === "gamma" ? P.y : P.d, nx = g === "gamma" ? P.next : P.d_next, mo = g === "gamma" ? P.month : P.d_month;
  if (!tot) return [];
  const val = { total: tot, next: nx, month: P.month_exp ? mo : null,
    xnext: nx ? tot.map((v, i) => v - nx[i]) : null, xmonth: P.month_exp && mo ? tot.map((v, i) => v - mo[i]) : null };
  return LINE_DEF.filter((l) => state.lines.has(l.k) && val[l.k]).map((l) => ({ ...l, color: l.c(), y: val[l.k] }));
}

function renderStrike(d0, W, H, exp = false) {
  const fs = exp ? 15 : 12.5, small = exp ? 13 : 11;
  const LN = strikeLines(d0);
  const left = exp ? 92 : 64, right = W - (exp ? 40 : 16) - (LN.length ? (exp ? 64 : 48) : 0);
  const d = bucketData(d0, Math.max(30, Math.floor((right - left) / (exp ? 7 : 6))));
  const n = d.strikes.length, step = d.step, s0 = d.strikes[0];
  const band = (right - left) / n;
  const xOf = (v) => left + ((v - s0) / step + 0.5) * band;

  const items = state.showLevels ? levelItems(d) : [];
  const pt = placeTags(items, xOf, left, right, fs);
  const titleH = exp ? 52 : 0;
  const top = titleH + 14 + pt.rows * (pt.h + 8) + 22;
  const bottom = H - (exp ? 92 : 74);

  // series segun el modo de barras
  const greek = state.greek;
  const OI = d.oi || {}, DL = d.delta;
  const mode = greek === "gamma" ? state.bars : greek === "delta" ? state.dbars
    : greek === "oi" ? ({ chg: "oichg", pos: "oipos" }[state.oiMode] || "oi") : "net";
  const oiNone = (mode === "oi" && !OI.calls) || (mode === "oichg" && !OI.chg_calls) || (mode === "oipos" && !OI.net_pos) || (greek === "delta" && !DL);
  const cArr = greek === "delta" && DL ? DL.calls : d.calls, pArr = greek === "delta" && DL ? DL.puts : d.puts;
  const series = mode === "oipos" ? OI.net_pos : greek === "delta" ? (DL ? DL.net : d.net) : greek === "gamma" || greek === "oi" ? d.net : (d[greek] || d.net);
  const rest = d.net.map((v, i) => v - (d.front ? d.front[i] : 0));
  let hiArr, loArr;
  if (oiNone) { hiArr = [1]; loArr = [0]; }
  else if (mode === "oi") { hiArr = OI.calls; loArr = OI.puts.map((v) => -v); }
  else if (mode === "oichg") { hiArr = OI.chg_calls.map((v, i) => Math.max(v, OI.chg_puts[i])); loArr = OI.chg_calls.map((v, i) => Math.min(v, OI.chg_puts[i])); }
  else if (mode === "split") { hiArr = cArr.map((v, i) => Math.max(v, pArr[i], 0)); loArr = cArr.map((v, i) => Math.min(v, pArr[i], 0)); }
  else if (mode === "expiry" && expG(d)) {
    hiArr = d.net.map((_, i) => d.by_exp.gex.reduce((a, r) => a + Math.max(0, r[i]), 0));
    loArr = d.net.map((_, i) => d.by_exp.gex.reduce((a, r) => a + Math.min(0, r[i]), 0));
  } else if (mode === "expiry") {
    hiArr = d.net.map((_, i) => Math.max(0, rest[i]) + Math.max(0, d.front[i]));
    loArr = d.net.map((_, i) => Math.min(0, rest[i]) + Math.min(0, d.front[i]));
  } else { hiArr = series; loArr = series; }
  let lo = Math.min(0, ...loArr), hi = Math.max(0, ...hiArr);
  const padY = (hi - lo) * 0.06 || 1;
  const yt = niceTicks(lo - (lo < 0 ? padY : 0), hi + (hi > 0 ? padY : 0), 6);
  const yOf = (v) => bottom - ((v - yt.lo) / (yt.hi - yt.lo)) * (bottom - top);
  const y0 = yOf(0);

  // ticks de strike
  const mult = [1, 2, 4, 5, 10, 20, 25, 40, 50, 100, 200, 250, 500, 1000];
  const target = exp ? 13 : Math.max(5, Math.floor((right - left) / 78));
  const k = mult.find((m) => n / m <= target) || 1000;
  const tickStep = k * step;

  let s = "";
  // rejilla
  for (const v of yt.ticks) {
    const y = yOf(v);
    s += `<line x1="${left}" x2="${right}" y1="${y}" y2="${y}" stroke="${C.grid}" stroke-width="1"/>`;
    s += `<text x="${left - 10}" y="${y + small * 0.35}" text-anchor="end" font-family="${MONO}" font-size="${small}" fill="${C.muted}">${fmtAxis(v)}</text>`;
  }
  const xt = [];
  for (let i = 0; i < n; i++) {
    const v = d.strikes[i];
    if (Math.abs(v / tickStep - Math.round(v / tickStep)) < 1e-6) xt.push(v);
  }
  for (const v of xt) {
    const x = xOf(v);
    s += `<line x1="${x}" x2="${x}" y1="${top}" y2="${bottom}" stroke="${C.grid}" stroke-width="1"/>`;
    s += `<text x="${x}" y="${bottom + small + 10}" text-anchor="middle" font-family="${MONO}" font-size="${small}" fill="${C.muted}">${fmtLevel(v)}</text>`;
  }
  // etiqueta eje Y
  s += `<text transform="translate(${exp ? 26 : 14},${(top + bottom) / 2}) rotate(-90)" text-anchor="middle" font-family="${MONO}" font-size="${small - 1}" fill="${C.faint}">${{ gamma: "$ delta per $1", delta: "$ of delta", vanna: "$ if IV drops 1 pt", charm: "$ per day", oi: mode === "oichg" ? "Change in contracts" : mode === "oipos" ? "Dealer net contracts" : "Contracts" }[greek]}</text>`;

  // banda de movimiento esperado
  s += emBand(d, xOf, top, bottom, small, left, right);

  // barras
  const bw = Math.max(1, Math.min(band * 0.64, 22));
  const rx = Math.min(2, bw / 4);
  const bar = (x, from, to, fill) => {
    const y = Math.min(yOf(from), yOf(to)), h = Math.max(0.8, Math.abs(yOf(to) - yOf(from)));
    return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${bw.toFixed(2)}" height="${h.toFixed(2)}" rx="${rx}" fill="${fill}"/>`;
  };
  const ecol = expG(d) ? expColors(d.by_exp) : null;
  s += `<rect id="hl" x="0" y="${top}" width="${band}" height="${bottom - top}" fill="${C.hi}" fill-opacity="0.04" visibility="hidden"/>`;
  for (let i = 0; i < n; i++) {
    const x = xOf(d.strikes[i]) - bw / 2;
    if (oiNone) break;
    if (mode === "oi") {
      if (OI.calls[i]) s += bar(x, 0, OI.calls[i], C.pos);
      if (OI.puts[i]) s += bar(x, 0, -OI.puts[i], C.neg);
    } else if (mode === "oichg" || (mode === "split" && greek === "delta")) {
      // dos barras finas por strike: calls a la izquierda, puts a la derecha (cambio de OI y delta, que pueden
      // tener el mismo signo y se taparian)
      const hw = bw / 2;
      const cv = mode === "oichg" ? OI.chg_calls[i] : cArr[i], pv = mode === "oichg" ? OI.chg_puts[i] : pArr[i];
      const half = (xx, v, fill) => { const y = Math.min(yOf(0), yOf(v)), h = Math.max(0.8, Math.abs(yOf(v) - yOf(0))); return `<rect x="${xx.toFixed(2)}" y="${y.toFixed(2)}" width="${(hw - 0.5).toFixed(2)}" height="${h.toFixed(2)}" rx="${Math.min(rx, hw / 4)}" fill="${fill}"/>`; };
      if (cv) s += half(x, cv, C.pos);
      if (pv) s += half(x + hw + 0.5, pv, C.neg);
    } else if (mode === "split") {
      if (cArr[i]) s += bar(x, 0, cArr[i], C.pos);
      if (pArr[i]) s += bar(x, 0, pArr[i], C.neg);
    } else if (mode === "expiry" && expG(d)) {
      // apiladas desde el eje: el vencimiento mas proximo pegado a cero, los lejanos por fuera
      let up = 0, dn = 0;
      d.by_exp.gex.forEach((r, j) => {
        const v = r[i];
        if (!v) return;
        if (v > 0) { s += bar(x, up, up + v, ecol[j]); up += v; } else { s += bar(x, dn, dn + v, ecol[j]); dn += v; }
      });
    } else if (mode === "expiry") {
      let up = 0, dn = 0;
      for (const [v, isFront] of [[rest[i], false], [d.front[i], true]]) {
        if (!v) continue;
        const fill = v > 0 ? (isFront ? C.posFront : C.pos) : (isFront ? C.negFront : C.neg);
        if (v > 0) { s += bar(x, up, up + v, fill); up += v; } else { s += bar(x, dn, dn + v, fill); dn += v; }
      }
    } else {
      const v = series[i];
      if (v) s += bar(x, 0, v, v > 0 ? C.pos : C.neg);
    }
  }
  s += `<line x1="${left}" x2="${right}" y1="${y0}" y2="${y0}" stroke="${C.axis}" stroke-width="1.2"/>`;
  if (LN.length && !oiNone) {
    const X = d0.profile.x, lo0 = s0 - step / 2, hi0 = d.strikes[n - 1] + step / 2;
    const idx = X.map((x, i) => i).filter((i) => X[i] >= lo0 && X[i] <= hi0);
    if (idx.length > 1) {
      let a2 = Infinity, b2 = -Infinity;
      LN.forEach((l) => idx.forEach((i) => { a2 = Math.min(a2, l.y[i]); b2 = Math.max(b2, l.y[i]); }));
      const pad2 = (b2 - a2) * 0.08 || 1;
      const t2 = niceTicks(Math.min(a2, 0) - pad2, Math.max(b2, 0) + pad2, 5);
      const y2 = (v) => bottom - ((v - t2.lo) / (t2.hi - t2.lo)) * (bottom - top);
      for (const v of t2.ticks) s += `<text x="${right + 8}" y="${y2(v) + small * 0.35}" font-family="${MONO}" font-size="${small}" fill="${C.faint}">${fmtAxis(v)}</text>`;
      if (t2.lo < 0 && t2.hi > 0) s += `<line x1="${left}" x2="${right}" y1="${y2(0)}" y2="${y2(0)}" stroke="${C.muted}" stroke-width="1" stroke-dasharray="2 4" opacity="0.6"/>`;
      for (const l of LN) {
        const dd = idx.map((i, j) => `${j ? "L" : "M"}${xOf(X[i]).toFixed(1)},${y2(l.y[i]).toFixed(1)}`).join("");
        s += `<path d="${dd}" fill="none" stroke="${l.color}" stroke-width="${exp ? 2.6 : 2}" ${l.dash ? 'stroke-dasharray="6 4"' : ""} stroke-linejoin="round"/>`;
      }
    }
  }
  if (oiNone) {
    const msg = greek === "delta" || mode === "oi" || mode === "oipos" ? "This data doesn't include this chart yet: it will appear after the next engine cycle"
      : "No previous-session open interest for this ticker. It is saved every day for the tickers in the lists";
    s += `<text x="${(left + right) / 2}" y="${(top + bottom) / 2}" text-anchor="middle" font-family="${SANS}" font-size="${fs}" fill="${C.muted}">${esc(msg)}</text>`;
  }

  // niveles
  s += tagsSVG(pt, titleH, bottom, fs);

  // spot
  s += spotSVG(d, xOf(d.spot), top - 8, bottom, fs, left, right, W, H, exp, legendItems(d));
  s += watermark(d, left, bottom, small, exp);

  state.geo = exp ? state.geo : { kind: "strike", left, right, band, top, bottom, n, xOf, data: d };
  return frame(W, H, s, d, exp, { gamma: "Gamma exposure by strike", delta: "Delta exposure by strike", vanna: "Vanna flow (IV −1 pt)", charm: "Charm flow (1 day)",
    oi: mode === "oichg" ? "Open interest change by strike" : mode === "oipos" ? "Dealer net positioning" : "Open interest by strike" }[greek]);
}

/* ============================================================ gráfico de perfil */
function renderProfile(d, W, H, exp = false) {
  const fs = exp ? 15 : 12.5, small = exp ? 13 : 11;
  const X = d.profile.x, Y = d.profile.y;
  const left = exp ? 92 : 64, right = W - (exp ? 40 : 16);
  const x0 = X[0], x1 = X[X.length - 1];
  const xOf = (v) => left + ((v - x0) / (x1 - x0)) * (right - left);

  const items = levelItems(d);
  const pt = placeTags(items, xOf, left, right, fs);
  const titleH = exp ? 52 : 0;
  const top = titleH + 14 + pt.rows * (pt.h + 8) + 22;
  const bottom = H - (exp ? 92 : 74);

  const lo = Math.min(0, ...Y), hi = Math.max(0, ...Y);
  const pad = (hi - lo) * 0.08 || 1;
  const yt = niceTicks(lo - (lo < 0 ? pad : 0), hi + (hi > 0 ? pad : 0), 6);
  const yOf = (v) => bottom - ((v - yt.lo) / (yt.hi - yt.lo)) * (bottom - top);
  const y0 = yOf(0);

  let s = "";
  for (const v of yt.ticks) {
    const y = yOf(v);
    s += `<line x1="${left}" x2="${right}" y1="${y}" y2="${y}" stroke="${C.grid}"/>`;
    s += `<text x="${left - 10}" y="${y + small * 0.35}" text-anchor="end" font-family="${MONO}" font-size="${small}" fill="${C.muted}">${fmtAxis(v)}</text>`;
  }
  const xt = niceTicks(x0, x1, exp ? 12 : Math.max(5, Math.floor((right - left) / 90)));
  for (const v of xt.ticks) {
    if (v < x0 || v > x1) continue;
    const x = xOf(v);
    s += `<line x1="${x}" x2="${x}" y1="${top}" y2="${bottom}" stroke="${C.grid}"/>`;
    s += `<text x="${x}" y="${bottom + small + 10}" text-anchor="middle" font-family="${MONO}" font-size="${small}" fill="${C.muted}">${fmtSpot(v)}</text>`;
  }
  s += `<text transform="translate(${exp ? 26 : 14},${(top + bottom) / 2}) rotate(-90)" text-anchor="middle" font-family="${MONO}" font-size="${small - 1}" fill="${C.faint}">Total GEX if spot were…</text>`;

  s += emBand(d, xOf, top, bottom, small, left, right);
  const pts = X.map((x, i) => `${xOf(x).toFixed(2)},${yOf(Y[i]).toFixed(2)}`);
  const area = `M${xOf(x0)},${y0} L${pts.join(" L")} L${xOf(x1)},${y0} Z`;
  const line = `M${pts.join(" L")}`;
  const id = exp ? "e" : "s";
  s += `<defs>
    <clipPath id="up${id}"><rect x="${left}" y="${top - 10}" width="${right - left}" height="${y0 - top + 10}"/></clipPath>
    <clipPath id="dn${id}"><rect x="${left}" y="${y0}" width="${right - left}" height="${bottom - y0 + 10}"/></clipPath>
  </defs>`;
  s += `<path d="${area}" fill="${C.pos}" fill-opacity="${C.area}" clip-path="url(#up${id})"/>`;
  s += `<path d="${area}" fill="${C.neg}" fill-opacity="${C.area}" clip-path="url(#dn${id})"/>`;
  s += `<path d="${line}" fill="none" stroke="${C.pos}" stroke-width="2" clip-path="url(#up${id})"/>`;
  s += `<path d="${line}" fill="none" stroke="${C.neg}" stroke-width="2" clip-path="url(#dn${id})"/>`;
  s += `<line x1="${left}" x2="${right}" y1="${y0}" y2="${y0}" stroke="${C.axis}" stroke-width="1.2"/>`;
  if (d.levels.flip_exact) {
    const fx = xOf(d.levels.flip_exact);
    s += `<circle cx="${fx}" cy="${y0}" r="${exp ? 6 : 4.5}" fill="${C.surface}" stroke="${C.amber}" stroke-width="2"/>`;
  }

  s += tagsSVG(pt, titleH, bottom, fs);
  s += spotSVG(d, xOf(d.spot), top - 8, bottom, fs, left, right, W, H, exp,
    [{ colors: [C.neg], label: "Negative total GEX" }, { colors: [C.pos], label: "Positive total GEX" }]);
  s += `<g id="cross" visibility="hidden"><line id="crossL" y1="${top}" y2="${bottom}" stroke="${C.muted}" stroke-dasharray="2 3"/><circle id="crossC" r="4" fill="${C.text}"/></g>`;
  s += watermark(d, left, bottom, small, exp);

  if (!exp) state.geo = { kind: "profile", left, right, top, bottom, xOf, yOf, x0, x1 };
  return frame(W, H, s, d, exp, "Gamma profile");
}

/* ============================================================ piezas comunes */
function spotSVG(d, x, top, bottom, fs, left, right, W, H, exp, legend) {
  if (x < left - 1 || x > right + 1) return legendSVG(legend || [], H - (fs + 16) / 2 - (exp ? 22 : 12), fs, left, left - 40, left, right); // spot fuera del zoom
  const label = `${d.spot_manual ? "Manual spot" : d.spot_implied && d.spot_implied.use ? "Pre-market" : "Spot"} ≈ ${fmtSpot(d.spot)}`;
  const w = label.length * fs * 0.62 + 30, h = fs + 16;
  const px = Math.min(Math.max(x - w / 2, left), right - w);
  const py = H - h - (exp ? 22 : 12);
  // leyenda
  const lg = legendSVG(legend || [], py + h / 2, fs, px, px + w, left, right);
  return `
  <line x1="${x}" y1="${top}" x2="${x}" y2="${bottom}" stroke="${C.spotline}" stroke-width="1.3" stroke-dasharray="2 4"/>
  <line x1="${x}" y1="${bottom + fs + 12}" x2="${x}" y2="${py}" stroke="${C.spotline}" stroke-width="1.3" stroke-dasharray="2 4"/>
  <rect x="${px}" y="${py}" width="${w}" height="${h}" rx="8" fill="${C.surface}" stroke="${C.spotline}" stroke-width="1.3"/>
  <text x="${px + w / 2}" y="${py + h / 2 + fs * 0.36}" text-anchor="middle" font-family="${MONO}" font-size="${fs}" fill="${C.text}">${esc(label)}</text>${lg}`;
}

function legendItems(d) {
  const ln = state.view === "strike" ? strikeLines(d).map((l) => ({ colors: [l.color], label: l.lab })) : [];
  if (state.greek === "oi" && state.oiMode === "pos") return [{ colors: [C.pos], label: "Dealers long" }, { colors: [C.neg], label: "Dealers short" }];
  if (state.greek === "oi") return [{ colors: [C.pos], label: "Calls" }, { colors: [C.neg], label: "Puts" }];
  if (state.greek === "delta") return (state.dbars === "split" ? [{ colors: [C.pos], label: "Calls" }, { colors: [C.neg], label: "Puts" }]
    : [{ colors: [C.neg], label: "Negative delta" }, { colors: [C.pos], label: "Positive delta" }]).concat(ln);
  if (state.greek === "gamma" && state.bars !== "expiry") return (state.bars === "split" ? [{ colors: [C.pos], label: "Calls" }, { colors: [C.neg], label: "Puts" }]
    : [{ colors: [C.neg], label: "Negative gamma" }, { colors: [C.pos], label: "Positive gamma" }]).concat(ln);
  if (state.greek !== "gamma") return [{ colors: [C.pos], label: "Hedge buying" }, { colors: [C.neg], label: "Hedge selling" }];
  if (state.bars === "split") return [{ colors: [C.pos], label: "Calls" }, { colors: [C.neg], label: "Puts" }];
  if (state.bars === "expiry" && expG(d)) {
    // leyenda corta: una muestra por familia (el detalle esta bajo los botones)
    const gs = d.by_exp.groups, cols = expColors(d.by_exp), out = [];
    for (const [k, lab] of [["proximo", "Next"], ["semanal", "Weeklies"], ["mensual", "Monthlies"], ["posteriores", "Later"]]) {
      const c = cols.filter((_, j) => gs[j].kind === k);
      if (c.length) out.push({ colors: c.length > 1 ? [c[0], c[c.length - 1]] : [c[0]], label: lab });
    }
    return out.concat(ln);
  }
  if (state.bars === "expiry") {
    const items = [{ colors: [C.negFront, C.posFront], label: `Expires ${expText(d, d.front_expiry, false)}` }];
    if (!d.expiries || d.expiries.length > 1) items.unshift({ colors: [C.neg, C.pos], label: "Other" });
    return items;
  }
  return [{ colors: [C.neg], label: "Negative gamma" }, { colors: [C.pos], label: "Positive gamma" }];
}

function legendSVG(items, cy, fs, pl, pr, left, right) {
  if (!items.length) return "";
  const f = fs - 0.5, sq = f * 0.8, gap = 22;
  const widths = items.map((it) => it.label.length * f * 0.56 + it.colors.length * (sq + 3) + 6);
  const total = widths.reduce((a, b) => a + b, 0) + gap * (items.length - 1);
  let x = right - total;
  if (x < pr + 20) x = (pl - left > total + 20) ? left : -9999;
  if (x < -999) return "";
  let s = "";
  items.forEach((it, k) => {
    let xx = x;
    it.colors.forEach((c) => { s += `<rect x="${xx}" y="${cy - sq / 2}" width="${sq}" height="${sq}" rx="2" fill="${c}"/>`; xx += sq + 3; });
    s += `<text x="${xx + 5}" y="${cy + f * 0.35}" font-family="${SANS}" font-size="${f}" fill="${C.muted}">${esc(it.label)}</text>`;
    x += widths[k] + gap;
  });
  return s;
}

const FLIP_ZONE = 0.5; // % alrededor del flip sin efecto claro de amplificacion ni de freno
function flipSide(spot, fx, fr) {
  // fx: cruce exacto; fr: nivel redondeado al strike que se muestra. Cerca si lo esta cualquiera de los dos
  if (fx == null) return null;
  const dd = (spot / fx - 1) * 100, dr = fr ? (spot / fr - 1) * 100 : dd;
  return Math.min(Math.abs(dd), Math.abs(dr)) < FLIP_ZONE ? "near" : dd > 0 ? "above" : "below";
}
// con solo el 0DTE, el charm es el cambio hasta el vencimiento de hoy, no por un dia
/* ---------- gamma por tramo de vencimiento y matriz de escenarios (panel lateral) */
function renderBuckets(d) {
  const b = d.buckets || [];
  const cols = [C.posFront, C.accent, C.purple, C.faint];
  $("bkBar").innerHTML = b.map((x, i) => x.share > 0 ? `<i style="flex:${x.share};background:${cols[i % cols.length]}" title="${x.lab}: ${fmtNum(x.share * 100, 0)}%"></i>` : "").join("");
  $("bkLeg").innerHTML = b.map((x, i) => `<span><i style="background:${cols[i % cols.length]}"></i>${x.lab.replace("-", "–")} ${fmtNum(x.share * 100, 0)}%</span>`).join("");
}

let scenMode = store.get("scenMode", "gex");
function renderScen(d) {
  const s = d.scenarios;
  $("scenBox").hidden = !s;
  if (!s) return;
  $("scenSeg").querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === scenMode)));
  const m = s[scenMode] || s.gex;
  const mx = Math.max(1, ...m.flat().map(Math.abs));
  const i0 = s.spot.indexOf(0), j0 = s.iv.indexOf(0);
  const sgn = (v) => (v > 0 ? "+" : v < 0 ? "−" : "");
  const cell = (v, i, j) => {
    const a = Math.min(1, Math.abs(v) / mx) * 0.5;
    const bg = Math.abs(v) < 0.5 ? "" : `background:color-mix(in srgb, ${v > 0 ? C.pos : C.neg} ${(a * 100).toFixed(0)}%, transparent)`;
    return `<td class="${i === i0 && j === j0 ? "now" : ""}" style="${bg}">${scenMode === "flow" && i === i0 && j === j0 ? "0" : sgn(v) + fmtBig(Math.abs(v))}</td>`;
  };
  $("scenTable").innerHTML = `<table><thead><tr><th title="Rows: price move. Columns: parallel IV shift">IV →</th>${s.iv.map((v) => `<th>${v ? sgn(v) + Math.abs(v) + " pt" : "Now"}</th>`).join("")}</tr></thead>
    <tbody>${s.spot.map((p, i) => `<tr><th>${p ? sgn(p) + Math.abs(p) + "%" : "Now"}<small>${fmtSpot(d.spot * (1 + p / 100))}</small></th>${m[i].map((v, j) => cell(v, i, j)).join("")}</tr>`).join("")}</tbody></table>`;
  $("scenNote").textContent = scenMode === "gex" ? "Net GEX per 1% move at that price and IV. Violet: positive (dealers dampen moves); magenta: negative (they amplify them)."
    : "What dealers would buy (+) or sell (−) to stay hedged if the price and IV went there from now, in dollars.";
}
$("scenSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-v]");
  if (!b || !state.data) return;
  scenMode = b.dataset.v; store.set("scenMode", scenMode);
  renderScen(state.data);
});

function charmLabel(d) { return d.meta && d.meta.max_dte === 0 && d.front_expiry === d.session ? "Charm, to expiration" : "Charm, per day"; }
// selector de rango: Auto, botones fijos o valor manual (ningun boton marcado)
function syncRange(d) {
  const r = state.range;
  $("rangeSeg").querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === r)));
  const preset = ["auto", "3", "5", "8"].includes(r);
  $("rangeInput").parentElement.classList.toggle("on", !preset);
  if (!preset && document.activeElement !== $("rangeInput")) $("rangeInput").value = fmtNum(+r, +r % 1 ? 1 : 0);
  const w = d && d.meta && d.meta.window_auto ? d.meta.window_pct : null;
  $("rangeAuto").textContent = r === "auto" && w ? `Auto ±${fmtNum(w, w < 1 ? 2 : 1)}%` : "Auto";
}
function move1(d) { return d.moves && d.moves.d1; }
function sessLabel(iso) { return iso ? `${DIAS_SEM[new Date(iso + "T12:00:00").getDay()]} ${+iso.slice(8, 10)}` : ""; }
function rangeLabel(em) { return em ? (em.partial ? `rest of ${sessLabel(em.session)}` : sessLabel(em.session)) : "1 session"; }

function emBand(d, xOf, top, bottom, small, left, right) {
  const em = move1(d);
  if (!em) return "";
  const x1 = Math.max(left, xOf(em.lo)), x2 = Math.min(right, xOf(em.hi));
  if (x2 <= x1) return "";
  const label = `1σ ${rangeLabel(em)}  ±${fmtNum(em.pct, 2)}%`;
  const lw = label.length * small * 0.6;
  const lx = (x1 + x2) / 2;
  const fitsInside = x2 - x1 > lw + 12;
  return `
  <rect x="${x1}" y="${top}" width="${x2 - x1}" height="${bottom - top}" fill="${C.hi}" fill-opacity="0.035"/>
  <line x1="${x1}" x2="${x1}" y1="${top}" y2="${bottom}" stroke="${C.hi}" stroke-opacity="0.16" stroke-dasharray="1 3"/>
  <line x1="${x2}" x2="${x2}" y1="${top}" y2="${bottom}" stroke="${C.hi}" stroke-opacity="0.16" stroke-dasharray="1 3"/>
  ${fitsInside ? `<text x="${lx}" y="${bottom - 12}" text-anchor="middle" font-family="${MONO}" font-size="${small}" fill="${C.muted}">${esc(label)}</text>` : ""}`;
}

function watermark(d, left, bottom, small, exp) {
  const date = fullDate(d.session || (d.computed_at || "").slice(0, 10));
  return `<text x="${left + 10}" y="${bottom - 12}" text-anchor="start" font-family="${MONO}" font-size="${small}" fill="${C.faint}" fill-opacity="0.75">GEX Lab, ${esc(d.symbol)}, ${date}</text>`;
}

// logo de GEX Lab (el de la barra lateral) en (x, y) con lado `size`
// mono: de un solo color (la marca de agua grande, para que no se confunda con barras del grafico)
function brandMark(x, y, size, op = 1, mono = false) {
  const k = size / 22, n = mono ? C.text : C.neg, p = mono ? C.text : C.pos, a = mono ? C.text : C.accent;
  return `<g transform="translate(${x},${y}) scale(${k})" opacity="${op}">
    <rect x="2" y="11" width="3" height="8" rx="1" fill="${n}"/><rect x="7" y="11" width="3" height="5" rx="1" fill="${n}"/>
    <rect x="12" y="6" width="3" height="5" rx="1" fill="${p}"/><rect x="17" y="3" width="3" height="8" rx="1" fill="${p}"/>
    <line x1="1" y1="11" x2="21" y2="11" stroke="${a}" stroke-width="1.2"/></g>`;
}
// firma de las imagenes exportadas (Copiar, Informe): logo y nombre arriba a la derecha
function brandSign(right, y, fs) {
  const w = textW("GEX Lab", fs, 600, true);
  return brandMark(right - w - fs * 1.7, y - fs * 1.05, fs * 1.4) +
    `<text x="${right}" y="${y}" text-anchor="end" font-family="${SANS}" font-size="${fs}" font-weight="600" fill="${C.muted}">GEX Lab</text>`;
}

function frame(W, H, inner, d, exp, title) {
  let head = "";
  if (exp) {
    const dte = DTE_LABEL[state.dte] || "";
    head = `<rect x="0" y="0" width="${W}" height="${H}" rx="22" fill="${C.surface}"/>
      <text x="92" y="44" font-family="${SANS}" font-size="22" font-weight="600" fill="${C.text}">${esc(d.symbol)}</text>
      <text x="${92 + d.symbol.length * 14 + 14}" y="44" font-family="${SANS}" font-size="18" fill="${C.muted}">${esc(title)}, ${dte}</text>`;
    if (!state.inReport) {
      // marca de agua: firma arriba a la derecha y el logo grande y muy tenue en el centro, detras del grafico
      const z = Math.min(W, H) * 0.42;
      head += brandSign(W - 40, 44, 20) + brandMark(W / 2 - z / 2, H / 2 - z / 2, z, 0.035, true);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${head}${inner}</svg>`;
}

/* ============================================================ mapa (estilo TRACE) */
function heatColor(v, vmax) {
  // zona muerta cerca de cero (color de fondo) y transicion suave hacia el color pleno: magenta negativa, violeta positiva
  const t = Math.max(-1, Math.min(1, v / vmax));
  const x = Math.max(0, (Math.abs(t) - 0.06) / 0.94);
  const a = Math.pow(x, 0.8);
  const base = C.heat0, tgt = t >= 0 ? C.heatPos : C.heatNeg;
  const mid = base.map((c, i) => Math.round(c + (tgt[i] - c) * 0.42));
  const lerp = (p, q, k) => p.map((c, i) => Math.round(c + (q[i] - c) * k));
  return a < 0.5 ? lerp(base, mid, a * 2) : lerp(mid, tgt, (a - 0.5) * 2);
}

// lente del mapa que trae el resultado (las vistas precalculadas antiguas no la llevan: gamma)
function heatLens(hm) { return hm.lens || "gamma"; }
function heatZ(hm) { return heatLens(hm) !== "gamma" || state.mapMode === "total" || !hm.zk ? hm.z : hm.zk; }
const LENS_N = { gamma: "Gamma", delta: "Delta Pressure", charm: "Charm Pressure" };

// curvas de nivel (marching squares) de la rejilla Z (filas = precios, columnas = horas) en el valor lev.
// Devuelve segmentos [c0, r0, c1, r1] en coordenadas de la rejilla (columna y fila fraccionarias)
function contourSegs(Z, lev) {
  const out = [], rows = Z.length, cols = rows ? Z[0].length : 0;
  const cut = (a, b) => (a === b ? 0.5 : (lev - a) / (b - a));
  for (let r = 0; r < rows - 1; r++) {
    const z0 = Z[r], z1 = Z[r + 1];
    for (let c = 0; c < cols - 1; c++) {
      const a = z0[c], b = z0[c + 1], cc = z1[c + 1], d = z1[c];
      const A = a > lev, B = b > lev, CC = cc > lev, D = d > lev;
      if (A === B && B === CC && CC === D) continue;
      // puntos de corte en los cuatro lados de la celda: abajo (a-b), derecha (b-cc), arriba (d-cc), izquierda (a-d)
      const p = [];
      if (A !== B) p.push([c + cut(a, b), r]);
      if (B !== CC) p.push([c + 1, r + cut(b, cc)]);
      if (D !== CC) p.push([c + cut(d, cc), r + 1]);
      if (A !== D) p.push([c, r + cut(a, d)]);
      if (p.length >= 2) out.push([...p[0], ...p[1]]);
      if (p.length === 4) out.push([...p[2], ...p[3]]);
    }
  }
  return out;
}

function buildHeatImage(hm) {
  const Z = heatZ(hm);
  const rows = hm.prices.length, cols = hm.times.length;
  const abs = Z.flat().map(Math.abs).sort((a, b) => a - b);
  // escala de color: Auto (percentil alto, ignora los extremos) o una fraccion fija del maximo (baja = mas color)
  const SCALE = { low: 0.25, medium: 0.5, high: 1 };
  const vmax = (SCALE[state.mapScale] ? abs[abs.length - 1] * SCALE[state.mapScale]
    : abs[Math.floor(abs.length * (heatZ(hm) === hm.z && heatLens(hm) === "gamma" ? 0.985 : 0.99))]) || 1;
  // contornos a +-25, 50 y 75 % de la escala; en Delta y Charm tambien el cero (frontera entre compra y venta)
  const levs = [-0.75, -0.5, -0.25, 0.25, 0.5, 0.75].concat(heatLens(hm) === "gamma" ? [] : [0]);
  const contours = state.mapContour ? levs.map((f) => ({ f, segs: contourSegs(Z, f * vmax) })) : [];
  const cv = document.createElement("canvas");
  cv.width = cols; cv.height = rows;
  const ctx = cv.getContext("2d");
  const img = ctx.createImageData(cols, rows);
  for (let r = 0; r < rows; r++) {
    const src = Z[rows - 1 - r];  // fila 0 = precio más alto
    for (let c = 0; c < cols; c++) {
      const [R, G, B] = heatColor(src[c], vmax);
      const o = (r * cols + c) * 4;
      img.data[o] = R; img.data[o + 1] = G; img.data[o + 2] = B; img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { url: cv.toDataURL("image/png"), vmax, contours };
}

// velas agrupadas en tramos de n minutos (marcadas por su minuto de inicio). slot: minutos de cada vela dibujada,
// nunca menos que la resolucion de los datos (5 min en vistas antiguas)
function mapCandles(cs, n) {
  if (!cs || !cs.length) return { list: [], slot: n };
  let native = Infinity;
  for (let i = 1; i < cs.length; i++) native = Math.min(native, minutesOf(cs[i][0]) - minutesOf(cs[i - 1][0]));
  const slot = Math.max(n, isFinite(native) && native > 0 ? native : 1);
  const out = [], idx = new Map();
  for (const [t, o, h, l, c] of cs) {
    const m = Math.floor(minutesOf(t) / slot) * slot, k = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    if (!idx.has(k)) { idx.set(k, out.length); out.push([k, o, h, l, c]); continue; }
    const b = out[idx.get(k)];
    b[2] = Math.max(b[2], h); b[3] = Math.min(b[3], l); b[4] = c;
  }
  return { list: out, slot };
}

// proximo vencimiento de las barras del mapa: "0DTE" si vence en la sesion del mapa
function frontTag(hm, d) {
  const fe = hm.front_expiry || d.front_expiry;
  return fe && String(fe).slice(0, 10) === hm.session ? "0DTE" : `exp. ${ddmm(fe)}`;
}

// barras de la izquierda del mapa segun Ajustes: GEX (por 1 %), OI (calls y puts) o posicion neta de los dealers,
// de todos los vencimientos del filtro o solo del proximo. Agrupadas para que quepan (maxN barras)
function mapSideBars(d, hm, pLo, pHi, maxN) {
  let kind = state.mapBars;
  const f0 = state.mapBars0;
  const src = hm.strikes && hm.net && (kind === "gex" || hm.oi) ? hm : d, O = src.oi || {}, sp1 = (hm.spot || d.spot) / 100;
  let A = kind === "oi" ? (f0 ? O.front_calls : O.calls) : kind === "netoi" ? (f0 ? O.front_pos : O.net_pos) : null;
  const B = kind === "oi" && A ? (f0 ? O.front_puts : O.puts) : null;
  if (!A) { kind = "gex"; A = (f0 ? src.front : src.net).map((v) => v * sp1); }
  const ks = [], a = [], b = [];
  src.strikes.forEach((k, i) => { if (k >= pLo && k <= pHi) { ks.push(k); a.push(A[i] || 0); b.push(B ? B[i] || 0 : 0); } });
  const bk = bucketStrikes(ks, [a, b], hm.step || d.step, maxN);
  const right = bk.arrs[0], left = bk.arrs[1];
  const max = Math.max(1, ...right.map(Math.abs), ...(B ? left.map(Math.abs) : []));
  const label = { gex: "GEX by strike, 1%", oi: "Open interest", netoi: "Dealer net contracts" }[kind] + (f0 ? `, ${frontTag(hm, d)}` : "");
  return { kind, ks: bk.ks, right, left, split: !!B, max, step: bk.step, label };
}

// rotulo de la barra de color segun la lente
function heatScaleTitle(hm) {
  const ln = heatLens(hm);
  if (ln === "delta") return "Dealer hedge, $ (buy +, sell −)";
  if (ln === "charm") return "Charm hedge, $ next hour";
  return heatZ(hm) === hm.z ? "Total GEX per 1%" : "Gamma by strike, per 1%";
}

function minutesOf(hhmm) { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; }

function renderMap(d, hm, W, H, exp = false) {
  const fs = exp ? 15 : 12, small = exp ? 13 : 11;
  const titleH = exp ? 52 : 0;
  const top = titleH + 18, bottom = H - (exp ? 60 : 44);
  const narrow = !exp && W < 640;  // movil: sin panel de barras y barra de color estrecha
  const barsW = narrow ? 0 : Math.round(Math.min(260, Math.max(150, W * 0.17)));
  const barsL = exp ? 40 : narrow ? 0 : 12, barsR = barsL + barsW;
  const axisW = exp ? 70 : narrow ? 50 : 58;
  const lf = small + (narrow ? 0 : 1);  // letra de las etiquetas de nivel
  // barra de color: barra + numeros + titulo girado, todo dentro del ancho
  const cbBar = narrow ? 8 : 12, cbNum = Math.ceil(7 * small * 0.62) + 6, cbTitle = narrow ? 0 : small + 8;
  const cbW = cbBar + 6 + cbNum + cbTitle;
  // columna propia para las etiquetas de niveles, fuera del mapa: no tapan las velas
  // ancho segun la etiqueta mas larga (en NDX los niveles tienen 6 cifras)
  const heatL = barsR + axisW;
  const longest = state.showLevels ? Math.max(0, ...levelItems(d).map((it) => ((narrow ? 2 : it.tag.length) + 1 + fmtLevel(it.v).length))) : 0;
  const tagW = state.showLevels ? Math.ceil(longest * lf * 0.62 + 26) : 0;
  const cbGap = narrow ? 6 : 10, edge = exp ? 24 : narrow ? 2 : 8;
  const heatR = W - edge - cbW - cbGap - tagW;
  // rango de precios: el del mapa o el del zoom vertical (solo para este ticker)
  const fLo = hm.prices[0], fHi = hm.prices[hm.prices.length - 1];
  const zm = state.mapZoom && state.mapZoom.sym === hm.symbol ? state.mapZoom : null;
  const pLo = zm ? Math.max(fLo, zm.lo) : fLo, pHi = zm ? Math.min(fHi, zm.hi) : fHi;
  const yOf = (p) => bottom - ((p - pLo) / (pHi - pLo)) * (bottom - top);
  // el mapa de los indices empieza antes de la apertura (tramo previo con las velas del ETF)
  const m0 = minutesOf(hm.times[0] || "09:30"), m1 = minutesOf("16:00"), mOpen = minutesOf("09:30");
  const xOf = (hhmm) => heatL + ((minutesOf(hhmm) - m0) / (m1 - m0)) * (heatR - heatL);
  const lastX = xOf(hm.times[hm.times.length - 1]) + (heatR - heatL) * 5 / (m1 - m0);
  if (!state.heatImg) state.heatImg = buildHeatImage(hm);
  const { url, vmax } = state.heatImg;

  let s = "";
  // eje de precios
  const yt = niceTicks(pLo, pHi, exp ? 9 : 8);
  for (const v of yt.ticks) {
    if (v < pLo || v > pHi) continue;
    const y = yOf(v);
    s += `<line x1="${barsL}" x2="${barsR}" y1="${y}" y2="${y}" stroke="${C.grid}"/>`;
    if (Math.abs(y - yOf(hm.spot)) > small + 10)
      s += `<text x="${heatL - 10}" y="${y + small * 0.35}" text-anchor="end" font-family="${MONO}" font-size="${small}" fill="${C.muted}">${fmtSpot(v)}</text>`;
  }

  // barras por strike (horizontales), del propio mapa (cubren todo su rango de precios) o, si no vienen, del analisis.
  // GEX: neta de cada strike al precio actual, por 1% (la misma medida que el mapa y que gexbot; no la gamma "en el
  // strike" a la hora de la ultima vela: al cierre el 0DTE a punto de vencer la dispara). OI: calls a la derecha y
  // puts a la izquierda. Neta: contratos netos de los dealers. Con "solo 0DTE", solo el proximo vencimiento
  const sb = mapSideBars(d, hm, pLo, pHi, Math.max(20, Math.floor((bottom - top) / 4)));
  const ks = sb.ks, bmax = sb.max;
  const cx = (barsL + barsR) / 2, half = (barsR - barsL) / 2 - 4;
  const bh = Math.max(1.5, Math.min(10, ((bottom - top) / Math.max(1, (pHi - pLo) / sb.step)) * 0.7));
  if (!narrow) s += `<line x1="${cx}" x2="${cx}" y1="${top}" y2="${bottom}" stroke="${C.axis}"/>`;
  if (!narrow) ks.forEach((k, i) => {
    const y = (yOf(k) - bh / 2).toFixed(2);
    for (const [v, side] of sb.split ? [[sb.right[i], 1], [-sb.left[i], -1]] : [[sb.right[i], 0]]) {
      if (!v) continue;
      const w = (Math.abs(v) / bmax) * half, pos = side ? side > 0 : v > 0;
      s += `<rect x="${pos ? cx : cx - w}" y="${y}" width="${w.toFixed(2)}" height="${bh.toFixed(2)}" rx="1" fill="${pos ? C.pos : C.neg}"/>`;
    }
  });
  if (!narrow) {
    s += `<text x="${cx - half}" y="${bottom + small + 10}" font-family="${MONO}" font-size="${small}" fill="${C.muted}">${fmtAxis(sb.split ? bmax : -bmax)}</text>`;
    s += `<text x="${cx + half}" y="${bottom + small + 10}" text-anchor="end" font-family="${MONO}" font-size="${small}" fill="${C.muted}">${fmtAxis(bmax)}</text>`;
    // el rotulo va entre las dos cifras si cabe; si no, en una segunda linea
    const lab = sb.label, fits = textW(lab, small) + textW(fmtAxis(-bmax), small) + textW(fmtAxis(bmax), small) + 24 <= barsR - barsL;
    s += `<text x="${cx}" y="${bottom + small + 10 + (fits ? 0 : small + 5)}" text-anchor="middle" font-family="${SANS}" font-size="${small}" fill="${C.faint}">${lab}</text>`;
  }

  // mapa (con zoom, la imagen entera desplazada y recortada al recuadro), curvas de nivel y velas comparten el recorte
  const clip = `heatclip${exp ? "e" : "s"}`;
  s += `<clipPath id="${clip}"><rect x="${heatL}" y="${top}" width="${heatR - heatL}" height="${bottom - top}"/></clipPath>`;
  const iy = yOf(fHi), ih = yOf(fLo) - iy;
  s += `<g clip-path="url(#${clip})"><image href="${url}" x="${heatL}" y="${iy.toFixed(1)}" width="${lastX - heatL}" height="${ih.toFixed(1)}" preserveAspectRatio="none" style="image-rendering:auto"/>`;
  if (state.heatImg.contours.length) {
    const nr = hm.prices.length, nc = hm.times.length;
    const X = (c) => (heatL + ((c + 0.5) / nc) * (lastX - heatL)).toFixed(1), Y = (r) => yOf(fLo + (r / (nr - 1)) * (fHi - fLo)).toFixed(1);
    for (const { f, segs } of state.heatImg.contours) {
      if (!segs.length) continue;
      const dp = segs.map(([c0, r0, c1, r1]) => `M${X(c0)} ${Y(r0)}L${X(c1)} ${Y(r1)}`).join("");
      s += `<path d="${dp}" fill="none" stroke="${C.hi}" stroke-opacity="${f === 0 ? 0.7 : 0.28}" stroke-width="${f === 0 ? 1.3 : 0.8}" stroke-linecap="round"/>`;
    }
  }
  s += `</g>`;
  if (lastX < heatR) s += `<rect x="${lastX}" y="${top}" width="${heatR - lastX}" height="${bottom - top}" fill="${C.ink}" fill-opacity="0.6"/>`;
  s += `<rect x="${heatL}" y="${top}" width="${heatR - heatL}" height="${bottom - top}" fill="none" stroke="${C.line || C.axis}"/>`;

  // horas
  if (m0 < mOpen) {  // apertura: separa el tramo previo de la sesion
    const ox = xOf("09:30");
    s += `<line x1="${ox}" x2="${ox}" y1="${top}" y2="${bottom}" stroke="${C.muted}" stroke-opacity="0.6" stroke-dasharray="3 3"/>`;
  }
  for (let h = Math.ceil(m0 / 60) + (m0 < mOpen && narrow ? 1 : 0); h <= 16; h += narrow ? 2 : 1) {
    const hh = String(h).padStart(2, "0") + ":00", x = xOf(hh);
    s += `<line x1="${x}" x2="${x}" y1="${bottom}" y2="${bottom + 5}" stroke="${C.muted}"/>`;
    s += `<text x="${x}" y="${bottom + small + 10}" text-anchor="middle" font-family="${MONO}" font-size="${small}" fill="${C.muted}">${nyHHMM(hm.session + " " + hh) || hh}</text>`;
  }

  // niveles
  if (state.showLevels) {
    const SHORT = { "CALL WALL": "CW", "PUT WALL": "PW", "G-FLIP": "GF", "VT": "VT", "HEDGE WALL": "HW" };
    const lv = levelItems(d).filter((it) => it.v >= pLo && it.v <= pHi)
      .map((it) => ({ ...it, y: yOf(it.v), label: `${narrow ? SHORT[it.tag] || it.tag : it.tag} ${fmtLevel(it.v)}` }))
      .sort((a, b) => a.y - b.y);
    // apila las etiquetas sin solaparse y sin salirse por abajo
    const gap = lf + 10;
    lv.forEach((it, k) => { it.ly = it.y; if (k && it.ly < lv[k - 1].ly + gap) it.ly = lv[k - 1].ly + gap; });
    for (let k = lv.length - 1; k >= 0; k--) {
      const lim = k === lv.length - 1 ? bottom - small * 0.6 : lv[k + 1].ly - gap;
      if (lv[k].ly > lim) lv[k].ly = lim;
    }
    for (const it of lv) s += `<line x1="${heatL}" x2="${heatR}" y1="${it.y}" y2="${it.y}" stroke="${it.c}" stroke-width="1.3" stroke-dasharray="6 4" stroke-opacity="0.9"/>`;
    const tx = heatR + 6;
    for (const it of lv) {
      // conector del final de la linea a su etiqueta
      s += `<path d="M${heatR},${it.y} L${heatR + 3},${it.y} L${tx},${it.ly}" fill="none" stroke="${it.c}" stroke-width="1" stroke-opacity="0.8"/>`;
      s += `<rect x="${tx}" y="${it.ly - lf * 0.5 - 4.5}" width="${tagW - 10}" height="${lf + 9}" rx="4" fill="${C.ink}" stroke="${it.c}" stroke-opacity="0.55"/>`;
      s += `<text x="${tx + 7}" y="${it.ly + lf * 0.36}" font-family="${MONO}" font-size="${lf}" fill="${it.c}">${esc(it.label)}</text>`;
    }
  }

  // precio
  if (hm.spot >= pLo && hm.spot <= pHi) {
    const sy = yOf(hm.spot);
    s += `<line x1="${heatL}" x2="${heatR}" y1="${sy}" y2="${sy}" stroke="${C.spotline}" stroke-opacity="0.5" stroke-dasharray="2 4"/>`;
    s += `<rect x="${heatL - axisW + 6}" y="${sy - small * 0.85 - 3}" width="${axisW - 10}" height="${small + 7}" rx="4" fill="${C.spotline}"/>`;
    s += `<text x="${heatL - 10}" y="${sy + small * 0.35}" text-anchor="end" font-family="${MONO}" font-size="${small}" font-weight="500" fill="${C.ink}">${fmtSpot(hm.spot)}</text>`;
  }
  const mc = mapCandles(hm.candles, +state.mapCandle || 5);
  if (mc.list.length) {
    const slot = (heatR - heatL) * mc.slot / (m1 - m0);
    const cw = Math.max(1, slot * 0.62);
    let cs = "";
    for (const [t, o, h, l, c] of mc.list) {
      const x = xOf(t) + slot / 2;
      const up = c >= o;
      const yT = yOf(Math.max(o, c)), yB = yOf(Math.min(o, c));
      // antes de la apertura, atenuadas: son del ETF (escaladas al indice), no del indice
      const op = minutesOf(t) < mOpen ? ` opacity="0.45"` : "";
      cs += `<g${op}><line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${yOf(h).toFixed(1)}" y2="${yOf(l).toFixed(1)}" stroke="${C.candle}" stroke-width="1"/>`;
      cs += `<rect x="${(x - cw / 2).toFixed(1)}" y="${yT.toFixed(1)}" width="${cw.toFixed(1)}" height="${Math.max(1, yB - yT).toFixed(1)}" fill="${up ? C.candle : C.ink}" stroke="${C.candle}" stroke-width="0.9"/></g>`;
    }
    s += `<g clip-path="url(#${clip})">${cs}</g>`;
  }
  if (hm.live) {
    const nx = xOf(hm.now);
    if (nx > heatL && nx < heatR) s += `<line x1="${nx}" x2="${nx}" y1="${top}" y2="${bottom}" stroke="${C.candle}" stroke-opacity="0.35"/>`;
  }

  // barra de color
  const cbL = heatR + tagW + cbGap;
  s += `<defs><linearGradient id="cbg${exp ? "e" : "s"}" x1="0" y1="0" x2="0" y2="1">${[1, 0.5, 0.2, 0, -0.2, -0.5, -1].map((t) => {
    const [R, G, B] = heatColor(t, 1); return `<stop offset="${(1 - t) / 2}" stop-color="rgb(${R},${G},${B})"/>`; }).join("")}</linearGradient></defs>`;
  s += `<rect x="${cbL}" y="${top}" width="${cbBar}" height="${bottom - top}" rx="3" fill="url(#cbg${exp ? "e" : "s"})"/>`;
  [[1, vmax], [0.5, vmax / 2], [0, 0], [-0.5, -vmax / 2], [-1, -vmax]].forEach(([t, v]) => {
    const y = top + ((1 - t) / 2) * (bottom - top);
    if (!narrow || t === 1 || t === -1 || t === 0) s += `<text x="${cbL + cbBar + 4}" y="${y + small * 0.35}" font-family="${MONO}" font-size="${small - (narrow ? 1 : 0)}" fill="${C.muted}">${fmtAxis(v)}</text>`;
  });
  if (!narrow) s += `<text transform="translate(${cbL + cbBar + 6 + cbNum + small * 0.4},${(top + bottom) / 2}) rotate(90)" text-anchor="middle" font-family="${MONO}" font-size="${small - 1}" fill="${C.faint}">${heatScaleTitle(hm)}</text>`;

  // marca de agua
  if (!narrow) s += `<text x="${heatL + 10}" y="${bottom - 10}" font-family="${MONO}" font-size="${small}" fill="${C.hi}" fill-opacity="0.35">GEX Lab, ${esc(d.symbol)}, ${ddmm(hm.session)}</text>`;

  if (!exp) state.geo = { kind: "map", left: heatL, right: heatR, top, bottom, barsL, barsR, pLo, pHi, fLo, fHi, m0, m1, lastX, sb };
  return frame(W, H, s, d, exp, `${LENS_N[heatLens(hm)]} map ${ddmm(hm.session)}`);
}

// motores: ids internos gexbot / spotgamma; en pantalla, Neto / Perfil
const MOTOR_NOMBRE = { gexbot: "Net", spotgamma: "Profile" };
function effModel() {
  if (state.model === "gexbot" || state.model === "spotgamma") return state.model;
  return state.dte === "0" ? "gexbot" : "spotgamma";
}

const COMBO = { SPX: "SPY", XSP: "SPY", NDX: "QQQ", RUT: "IWM", DJX: "DIA" };
function extraParams() {
  const o = {};
  if (state.combo && COMBO[state.symbol]) o.combine = "1";
  if (state.pos === "flow") o.pos = "flow";
  o.model = effModel();
  return o;
}

function heatParams() {
  const p = new URLSearchParams({ symbol: state.symbol, dte: state.dte, range: state.range, session: state.mapSess, ...extraParams() });
  if (state.mapLens !== "gamma") p.set("lens", state.mapLens);
  const sp = $("spotInput").value.trim();
  if (sp) p.set("spot", sp.replace(/,/g, ""));
  return p.toString();
}

async function loadHeat() {
  const key = heatParams();
  if (state.heat && state.heatKey === key) { draw(); return; }
  if (state.heatCtrl) state.heatCtrl.abort();
  state.heatCtrl = new AbortController();
  $("chart").classList.add("loading");
  try {
    const r = await fetch("/api/heatmap?" + key, { signal: state.heatCtrl.signal });
    const hm = await r.json();
    if (!r.ok) throw new Error(hm.error || "Could not calculate the map");
    state.heat = hm; state.heatKey = key; state.heatImg = null;
    $("chart").classList.remove("loading");
    mapCaption();
    if (state.view === "map") draw();
  } catch (e) {
    if (e.name === "AbortError") return;
    $("chart").classList.remove("loading");
    $("chart").innerHTML = `<div class="placeholder err"><div><div class="err-t">${esc(e.message)}</div></div></div>`;
  }
}

function mapCaption() {
  const hm = state.heat;
  if (state.view !== "map" || !hm) return;
  const dt = new Date(hm.session + "T12:00:00");
  const dia = `${DIAS_SEM[dt.getDay()]} ${ddmm(hm.session)}`;
  if (state.mapKind !== hm.kind) { state.mapKind = hm.kind; if (!$("chartSet").hidden) renderSet(); }
  const cap = $("caption");
  const pre = hm.pre_src ? (hm.pre_src === hm.symbol ? ` Pre-market candles (faded) are extended-hours ${hm.pre_src}.`
    : ` Pre-market candles (faded) are ${hm.pre_src} scaled to ${hm.symbol}, rescaled at 09:40 so they join the index.`) : "";
  if (hm.pre) cap.textContent = `Pre-market (${dia}), with open interest from the previous close.` + pre;
  else if (hm.live) cap.textContent = `Today's session (${dia}), with open interest from the previous close.` + pre;
  else if (hm.kind === "next") cap.textContent = `Projection for ${dia}. Candles will appear when the session opens.`;
  else cap.textContent = `Session of ${dia}` + (hm.approx ? ". Approximate: CBOE no longer publishes the contracts that expired that day" : ".") + pre;
  cap.title = hm.approx ? "From now on the app saves a copy of the chain during each session, so future replays will be exact." : "";
  if (state.data) paintStrip(state.data);
}

/* ============================================================ pintar */
// detalle de "Barras: Vencimiento" bajo los botones: que vencimiento es el proximo y que hay en el resto
function expiryCaption(d) {
  if (state.view === "strike" && state.greek === "oi") {
    const o = d.oi;
    if (!o || !o.calls) return "";
    const nf = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
    const sum = (a) => a.reduce((x, v) => x + (v || 0), 0), f = (v) => (state.oiMode === "chg" && v > 0 ? "+" : "") + nf.format(v);
    if (state.oiMode === "pos") return o.net_pos ? `Estimated dealer net position at each strike, in contracts: ${state.pos === "flow" ? "as estimated by flow mode" : "standard convention, long calls and short puts"}. Total in range: <b>${f(sum(o.net_pos))}</b>` : "";
    if (state.oiMode !== "chg") return `Open contracts in range (previous close): calls <b>${f(sum(o.calls))}</b>, puts <b>${f(sum(o.puts))}</b>, put/call ratio <b>${fmtNum(sum(o.puts) / Math.max(1, sum(o.calls)), 2)}</b>`;
    if (!o.chg_calls) return "";
    return `Change in the ${ddmm(o.prev_date)} session (the OCC publishes it every morning): calls <b>${f(sum(o.chg_calls))}</b>, puts <b>${f(sum(o.chg_puts))}</b>. Up, new contracts; down, closed ones`;
  }
  // Gamma por vencimiento no lleva leyenda: el tooltip ya da cada vencimiento y la linea desplazaba el grafico
  return "";
}

function draw() {
  const d = state.data;
  const el = $("chart");
  if (!d) return;
  if (state.view === "strike") $("caption").innerHTML = expiryCaption(d);
  const W = Math.max(320, el.clientWidth), H = Math.max(360, el.clientHeight);
  if (state.view === "map") {
    if (!state.heat || state.heatKey !== heatParams()) { loadHeat(); return; }
    el.innerHTML = renderMap(d, state.heat, W, H);
    syncMapTools();
    el.setAttribute("aria-label", "Gamma map by price and time");
    return;
  }
  const z = typeof zoomed === "function" ? zoomed(d, state.view) : d;
  el.innerHTML = state.view === "impact" && typeof renderImpact === "function" ? renderImpact(z, W, H)
    : state.view === "history" && typeof renderHistory === "function" ? renderHistory(z, W, H)
    : state.view === "profile" ? renderProfile(z, W, H) : renderStrike(z, W, H);
  el.setAttribute("aria-label", state.view === "profile" ? "Gamma profile" : state.view === "history" ? "Level history" : "Gamma exposure by strike");
  if (typeof zoomBarSync === "function") zoomBarSync();
}

function paintSide(d) {
  if (typeof paintHub === "function") paintHub(d);
  $("hSym").textContent = d.symbol;
  $("hName").textContent = d.name || "";
  pushRecent(d.symbol, d.name);
  $("hSpot").textContent = fmtSpot(d.spot);
  const chg = d.chg_pct;
  const hc = $("hChg");
  const imp = d.spot_implied;
  if (d.spot_manual) { hc.textContent = "manual spot"; hc.className = "chg"; }
  else if (imp && imp.use) { hc.textContent = `pre-market via ${imp.proxy}`; hc.className = "chg"; }
  else if (chg != null && isFinite(chg)) { hc.textContent = fmtPct(chg); hc.className = "chg " + (chg >= 0 ? "up" : "dn"); }
  else { hc.textContent = ""; hc.className = "chg"; }

  const fx = d.levels.flip_exact;
  const fs = flipSide(d.spot, fx, d.levels.flip);
  const side = fs === "above" ? "Above the flip, d" : fs === "below" ? "Below the flip, d" : "";
  let reg = fs === "near"
    ? `<b class="${d.regime === "negative" ? "neg" : "pos"}">${d.regime === "negative" ? "Negative" : "Positive"} gamma, next to the flip.</b> Within ${fmtNum(FLIP_ZONE, 1)}% of the Gamma Flip: a transition zone, with no clear dealer effect in either direction.`
    : d.regime === "negative"
    ? `<b class="neg">Negative gamma.</b> ${side || "D"}ealer hedging tends to amplify moves.`
    : `<b class="pos">Positive gamma.</b> ${side || "D"}ealer hedging tends to dampen moves.`;
  if (imp && !imp.use && !d.spot_manual && Math.abs(imp.proxy_chg) > 0.01)
    reg += `<span class="implied">After hours, ${imp.proxy} implies ${fmtSpot(imp.value)} (${fmtPct(imp.proxy_chg)}).</span>`;
  $("regime").innerHTML = reg;

  const rows = levelItems(d).map((x) => ({ ...x }));
  const ag = d.levels.abs_gamma;
  if (ag != null && ag !== d.levels.put_wall && ag !== d.levels.call_wall)
    rows.push({ key: "abs", name: "Absolute gamma", v: ag, c: C.muted });
  const gk = (r) => r.key === "vt" ? (d.is_index === false ? "hedge" : "vt") : r.key;
  rows.push({ key: "spot", name: d.spot_manual ? "Manual spot" : "Spot", v: d.spot, spot: true });
  rows.sort((a, b) => b.v - a.v || (a.spot ? 1 : -1));
  $("levels").innerHTML = rows.map((r) => r.spot
    ? `<li class="spot"><span class="name" data-g="spot">${r.name}</span><span class="val">${fmtSpot(r.v)}</span></li>`
    : `<li style="--c:${r.c}"><span class="name" data-g="${gk(r)}">${r.name}</span><span class="val">${fmtLevel(r.v)}</span><span class="dist">${fmtPct((r.v / d.spot - 1) * 100)}</span>${prevLine(d, r)}</li>`
  ).join("");

  const t = d.totals;
  $("split").hidden = false;
  $("netPct").textContent = fmtBig(t.net_per_pct, true);
  paintStrip(d);
  const c = Math.abs(t.call_per_pct), p = Math.abs(t.put_per_pct), tot = c + p || 1;
  $("splitC").style.width = (c / tot) * 100 + "%";
  $("splitP").style.width = (p / tot) * 100 + "%";
  $("netPrev").textContent = d.prev && d.prev.net_per_pct != null ? `${ddmm(d.prev.date)}: ${fmtBig(d.prev.net_per_pct, true)}` : "";
  $("callPct").textContent = `Calls ${fmtBig(t.call_per_pct, true)}`;
  $("putPct").textContent = `Puts ${fmtBig(t.put_per_pct, true)}`;

  const em = move1(d), m5 = d.moves && d.moves.d5, st = d.expected_move;
  $("facts").hidden = false;
  $("emLabel").textContent = `1σ range, ${rangeLabel(em)}`;
  $("emVal").textContent = em ? `±${fmtNum(em.pct, 2)}%` : "—";
  $("emRange").textContent = em ? `${fmtSpot(em.lo)} – ${fmtSpot(em.hi)}${m5 ? ` (5 sessions ±${fmtNum(m5.pct, 2)}%)` : ""}` : "no ATM IV";
  $("emRange").title = `1 standard deviation range (68.3%) implied by options: ATM variance interpolated over market hours.` +
    (st ? ` ATM straddle for ${ddmm(st.expiry)}: ±${fmtNum(st.pct, 2)}% (average move, ≈ 0.8σ).` : "");
  const vf = t.vanna_flow, cf = t.charm_flow;
  $("vannaVal").textContent = fmtBig(Math.abs(vf), true);
  $("vannaSub").textContent = vf >= 0 ? "hedge buying" : "hedge selling";
  $("charmVal").textContent = fmtBig(Math.abs(cf), true);
  $("charmSub").textContent = cf >= 0 ? "hedge buying" : "hedge selling";
  $("charmLabel").textContent = charmLabel(d);
  $("frontLabel").textContent = `Expires ${ddmm(d.front_expiry)}`;
  $("frontVal").textContent = `${fmtNum(d.front_share * 100, 0)}%`;
  $("frontSub").textContent = t.net_per_pct_after != null ? `of the gamma. After it: GEX ${fmtBig(t.net_per_pct_after, true)} per 1%` : "of the filter's total gamma";
  const lq = d.liquidity;
  $("liqFact").hidden = !lq;
  if (lq) {
    const pa = (v) => `${fmtNum(Math.abs(v) * 100, Math.abs(v) < 0.1 ? 1 : 0)}%`;
    $("liqVal").textContent = `${pa(lq.gex_adv)} of ADV`;
    $("liqSub").textContent = `per 1% move, ≈ ${fmtNum(lq.impact_bp, 0)} bp ${t.net_per_pct >= 0 ? "against the move" : "with the move"}. Vanna ${pa(lq.vanna_adv)}, charm ${pa(lq.charm_adv)}`;
    $("liqSub").title = `Average daily volume ${fmtBig(lq.adv, true)} (20 sessions). Impact with the square-root law: daily volatility ${fmtNum(lq.sigma_d * 100, 2)}% × √(hedge / volume), as if the whole hedge traded in one session. An order of magnitude to compare tickers, not a forecast.`;
  }
  renderBuckets(d);
  renderScen(d);

  const m = d.meta;
  $("meta").innerHTML = `
    <dt>Contracts</dt><dd>${fmtNum(m.contracts)}</dd>
    <dt>Expirations</dt><dd>${m.expirations}</dd>
    ${d.levels.zero_gamma ? `<dt title="Price at which the recalculated total GEX would cross zero (SpotGamma convention)">Zero gamma (profile)</dt><dd>${fmtLevel(d.levels.zero_gamma)}</dd>` : ""}
    ${d.levels.window ? `<dt title="Range in which Call Wall, Put Wall, Flip and Vol Trigger are searched">Levels within</dt><dd>±${fmtNum(d.levels.window, d.levels.window < 1 ? 2 : 1)}%</dd>` : ""}
    <dt>Compared with</dt><dd>${d.prev ? ddmm(d.prev.date) : "no history yet"}</dd>
    ${d.combo ? `<dt>Combined</dt><dd>+ ${d.combo.proxy} (×${fmtNum(d.combo.ratio, 2)})</dd>` : ""}
    <dt>Dealers</dt><dd class="flowinfo">${d.positioning === "flow"
      ? (!d.flow_info || !d.flow_info.days ? "flow: no data yet, same as standard"
        : d.flow_info.days === 1 ? `flow: only the last session's volume (${fmtNum(d.flow_info.share_flipped * 100, 0)}% of the position adjusted)`
        : `flow, ${d.flow_info.days} sessions (${fmtNum(d.flow_info.share_flipped * 100, 0)}% adjusted)`)
      : "standard convention"}</dd>
    <dt>Risk-free rate</dt><dd title="${d.rate && d.rate.src === "IRX" ? "13-week Treasury bill (CBOE IRX), continuously compounded" : "Fixed value: the Treasury bill rate could not be read"}">${d.rate ? fmtNum(d.rate.r * 100, 2) + "%" + (d.rate.src === "IRX" ? " (13-wk bill)" : " (fixed)") : "—"}</dd>
    <dt>Data time</dt><dd>${esc(d.timestamp ? d.timestamp.slice(0, 16) + " UTC" : "—")}</dd>`;
}

function prevLine(d, r) {
  const p = d.prev;
  if (!p || !(r.key in p) || p[r.key] == null) return "";
  const was = p[r.key];
  if (Math.abs(was - r.v) < 1e-9) return `<span class="prev">same as ${ddmm(p.date)}</span>`;
  const up = r.v > was;
  return `<span class="prev">${ddmm(p.date)}: ${fmtLevel(was)} <b class="${up ? "up" : "dn"}">${up ? "▲" : "▼"} ${fmtLevel(Math.abs(r.v - was))}</b></span>`;
}

// Estado de los datos. Con el mercado abierto, la hora del calculo. Fuera de horario las opciones no cotizan: el
// calculo puede ser de ahora (precio pre-market y open interest del dia) pero sus precios e IV son los del cierre.
function dataClosed(d) {
  const c = nyDate(d.computed_at), q = nyDate(d.quote_time);
  return !!(c && q && c - q > 5 * 60e3);
}
function dataStatus(d) {
  if (!d.quote_time || !d.computed_at) return `Data ${nyWhen(d.quote_time || d.computed_at)}`;
  if (!dataClosed(d)) return `Data ${nyWhen(d.computed_at)}`;
  const pre = d.spot_implied && d.spot_implied.use ? " (pre-market)" : "";
  return `Calculated ${nyWhen(d.computed_at)}${pre}, options from the close at ${nyWhen(d.quote_time)}`;
}
function dataTitle(d) {
  const src = d.source !== "tradier" ? "CBOE (15 min delay)"
    : TIEMPO_REAL.has(d.symbol) ? "real-time Tradier; this index is recalculated every 5 min while the market is open"
    : "real-time Tradier at calculation time; recalculated every 15 min";
  const base = `Calculated ${nyWhen(d.computed_at)} (local time) with data from ${src}.`;
  if (!dataClosed(d)) return base;
  return `${base} Outside market hours options don't trade: their prices and IV are from the close (${nyWhen(d.quote_time)}). ` +
    (d.spot_implied && d.spot_implied.use ? `The price is the pre-market one (via ${d.spot_implied.proxy || "its ETF"}) and open interest is the latest published.` : "Open interest is the latest published.");
}

function anaStatus(kind, text) {
  if (state.mode === "analysis" || state.mode === "scanner") setStatus(kind, text);
}
function setStatus(kind, text) {
  const s = $("status");
  s.className = "status " + kind;
  s.innerHTML = `<span class="dot"></span>${esc(text)}`;
}

function showError(msg) {
  const el = $("chart");
  el.classList.remove("loading");
  el.innerHTML = `<div class="placeholder err"><div><div class="err-t">${esc(msg)}</div>
    ${/CBOE|certificate|server/i.test(msg) ? "" : `<div class="err-d">Check the ticker (indices have no prefix: SPX, NDX, RUT) or try another expiration filter.</div>`}</div></div>`;
  state.data = null;
  clearSide();
}

// TRACE: franja sobre el mapa con lo que se mira durante la sesion. El precio, la zona de gamma, el nivel de abajo y
// el de arriba con su distancia (y el precio situado a escala entre los dos), el resto de niveles y el estado del mapa
function paintStrip(d) {
  const box = $("traceStrip");
  if (!d) { box.innerHTML = ""; return; }
  const g = [];  // niveles con el mismo valor, juntos (Vol Trigger y Put Wall suelen coincidir)
  levelItems(d).forEach((x) => { const o = g.find((y) => y.v === x.v); if (o) o.name += ", " + x.name; else g.push({ ...x }); });
  const up = g.filter((x) => x.v > d.spot).sort((a, b) => a.v - b.v)[0];
  const dn = g.filter((x) => x.v <= d.spot).sort((a, b) => b.v - a.v)[0];
  // distancia en puntos (enteros en los indices) y en %
  const dist = (x) => { const v = x.v - d.spot; return `${v > 0 ? "+" : v < 0 ? "−" : ""}${fmtNum(Math.abs(v), d.spot >= 1000 ? 0 : 2)} <small>${fmtPct((x.v / d.spot - 1) * 100)}</small>`; };
  const end = (x, lab, cls) => x ? `<div class="ts-end ${cls}"><span class="k">${lab}</span><span class="n"><i style="background:${x.c}"></i>${x.name}</span>`
    + `<span class="v"><b>${fmtLevel(x.v)}</b><em>${dist(x)}</em></span></div>` : `<div class="ts-end ${cls}"><span class="k">${lab}</span><span class="n">none in range</span></div>`;
  const f = up && dn ? Math.min(1, Math.max(0, (d.spot - dn.v) / (up.v - dn.v))) : 0.5;
  const near = flipSide(d.spot, d.levels.flip_exact, d.levels.flip) === "near", neg = d.regime === "negative";
  const hc = $("hChg");
  const hm = state.heat, est = !hm ? "" : hm.pre ? "Pre-market" : hm.live ? "Live" : hm.kind === "next" ? "Next session" : "Replay";
  box.innerHTML = `<div class="ts-px"><span class="s">${esc(d.symbol)}</span><b>${fmtSpot(d.spot)}</b><span class="${hc.className}">${hc.textContent}</span></div>`
    + `<div class="ts-zone ${neg ? "neg" : "pos"}"><b>${neg ? "Negative" : "Positive"} gamma</b><span>${near ? "next to the flip, no clear effect" : neg ? "moves tend to accelerate" : "moves tend to be dampened"}</span></div>`
    + `<div class="ts-span">${end(dn, "Next below", "l")}<div class="ts-track"><span class="seg" style="--a:${dn ? dn.c : C.axis};--b:${up ? up.c : C.axis}"></span>`
    + `<span class="dot" style="left:${(f * 100).toFixed(1)}%"><b>${fmtSpot(d.spot)}</b></span></div>${end(up, "Next above", "r")}</div>`
    + `<div class="ts-rest">${g.filter((x) => x !== up && x !== dn).map((x) => `<span><i style="background:${x.c}"></i>${x.name} <b>${fmtLevel(x.v)}</b></span>`).join("")}`
    + `<span>Net GEX 1% <b>${fmtBig(d.totals.net_per_pct, true)}</b></span></div>`
    + (est ? `<div class="ts-clock"><b>${est}</b><span>${esc($("caption").textContent.replace(/\.$/, ""))}</span></div>` : "");
}

function clearSide() {
  paintStrip(null);
  $("hSym").textContent = $("symbol").value.trim().toUpperCase() || "—";
  $("hName").textContent = "";
  $("hSpot").textContent = "—";
  $("hChg").textContent = "";
  $("regime").textContent = "";
  $("levels").innerHTML = "";
  $("split").hidden = true;
  $("facts").hidden = true;
  $("meta").innerHTML = "";
  document.title = "GEX Lab";
}

/* ============================================================ carga */
async function load(refresh = false, silent = false) {
  let sym = $("symbol").value.trim().toUpperCase();
  if (!sym) { $("symbol").focus(); return; }
  if (/\s/.test(sym) || sym.length > 10) {
    try {
      const r = await fetch("/api/search?q=" + encodeURIComponent(sym)).then((x) => x.json());
      if (r.results && r.results.length) { sym = r.results[0].symbol; $("symbol").value = sym; }
    } catch { /* sigue con lo escrito */ }
  }
  state.symbol = sym; store.set("symbol", sym);
  markQuick();
  if (state.mode === "vol" && typeof loadVol === "function") { loadVol(refresh); return; }
  if (TOOLS[state.mode]) { TOOLS[state.mode].load(refresh); return; }
  if (state.ctrl) state.ctrl.abort();
  state.ctrl = new AbortController();

  syncCombo();
  $("refreshBtn").classList.add("spin");
  if (!silent) $("chart").classList.add("loading");
  anaStatus("busy", `Loading ${sym}…`);
  $("tip").hidden = true;

  const p = new URLSearchParams({ symbol: sym, dte: state.dte, range: state.range, ...extraParams() });
  const sp = $("spotInput").value.trim();
  if (sp) p.set("spot", sp.replace(/,/g, ""));
  if (refresh) p.set("refresh", "1");

  try {
    const r = await fetch("/api/gex?" + p, { signal: state.ctrl.signal });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Could not calculate the data");
    const prevData = state.data;
    state.data = d;
    if (silent) checkCrossings(prevData, d);
    if (state.heatKey !== heatParams() || refresh || silent) { state.heat = null; state.heatKey = ""; }
    $("chart").classList.remove("loading");
    paintSide(d);
    syncRange(d);
    draw();
    $("refreshBtn").classList.remove("spin");
    anaStatus("", dataStatus(d));
    $("status").title = dataTitle(d);
    document.title = `${d.symbol} ${fmtSpot(d.spot)} - GEX Lab`;
  } catch (e) {
    if (e.name === "AbortError") return;
    $("refreshBtn").classList.remove("spin");
    if (silent && state.data) { anaStatus("err", "Could not refresh; keeping the previous data"); return; }
    showError(e.message === "Failed to fetch" ? "The local server is not responding. Open GEX Lab again." : e.message);
    anaStatus("err", "No data");
  }
}

/* ============================================================ interacción */
// barra de vencimientos: pasos acumulados (los mismos filtros que gex_engine.DTE_FILTERS)
const DTE_STEPS = ["0", "1", "7", "14", "30", "45", "all"];
const DTE_LABEL = { "0": "0DTE", "1": "≤ 1DTE", "7": "≤ 7 days", "14": "≤ 14 days", "30": "≤ 30 days", "45": "≤ 45 days", all: "all expirations" };

function bindDte(onChange) {
  const range = $("dteRange"), ticks = $("dteTicks");
  const btns = [...ticks.querySelectorAll("button")];
  const names = btns.map((b) => b.textContent);
  btns.forEach((b) => b.style.setProperty("--i", b.dataset.i));
  if (!DTE_STEPS.includes(state.dte)) state.dte = "45";
  const paint = (i) => {
    $("dteSlider").style.setProperty("--p", String(i / (DTE_STEPS.length - 1)));
    btns.forEach((b) => { b.setAttribute("aria-current", String(+b.dataset.i === i)); b.toggleAttribute("data-on", +b.dataset.i <= i); });
    range.setAttribute("aria-valuetext", names[i]);
  };
  const commit = (i) => {
    paint(i);
    const v = DTE_STEPS[i];
    if (v === state.dte) return;
    state.dte = v; store.set("dte", v); onChange();
  };
  range.value = String(DTE_STEPS.indexOf(state.dte));
  paint(+range.value);
  range.addEventListener("input", () => paint(+range.value));   // mientras se arrastra solo se pinta
  range.addEventListener("change", () => commit(+range.value)); // al soltar (o con el teclado) se calcula
  ticks.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    range.value = b.dataset.i; commit(+b.dataset.i);
  });
}

// opciones del grafico (boton con el resumen de lo elegido) y menu Exportar
const GREEK_N = { gamma: "Gamma", delta: "Delta", vanna: "Vanna", charm: "Charm", oi: "Open interest" };
// panel de opciones: secciones segun la vista y el tipo de grafico. "one" = una opcion de la lista (interruptor
// excluyente), "multi" = varias a la vez, "flag" = si/no. Cada fila tiene su (i) con la explicacion
function setSections() {
  const v = state.view, g = state.greek, d = state.data || {}, P = d.profile || {};
  const G = g === "delta" ? "Delta" : "Gamma", gg = G.toLowerCase();
  const nx = P.next_exp ? ` (${ddmm(P.next_exp)})` : "", mo = P.month_exp ? ` (${ddmm(P.month_exp)})` : "";
  const S = [];
  if (v === "strike") {
    S.push({ type: "seg", title: "Chart type", key: "greek", opts: [["gamma", "Gamma"], ["delta", "Delta"], ["vanna", "Vanna"], ["charm", "Charm"], ["oi", "OI"]] });
    if (g === "gamma" || g === "delta") S.push({ type: "multi", title: "Lines", key: "lines", opts: [
      ["total", `Total ${gg}`, `Dealer ${gg} summing every expiration in the filter if the price were at each level (right axis).${g === "gamma" ? " Where it crosses zero is the Gamma Flip." : ""}`],
      ["next", `Next-expiration ${gg}${nx}`, `Only the nearest expiration. For indices it is usually the 0DTE, the one that moves the session the most.`],
      ["month", `Monthly-expiration ${gg}${mo}`, P.month_exp ? `Only the next monthly expiration (third Friday), the one with the most structural weight.` : `There is no monthly expiration inside the expiration filter.`, !P.month_exp],
      ["xnext", `Total ${gg} ex next`, `The total minus the next expiration: what ${gg} will look like once it expires.`],
      ["xmonth", `Total ${gg} ex monthly`, P.month_exp ? `The total minus the monthly: the structure left after the monthly expiration.` : `There is no monthly expiration inside the expiration filter.`, !P.month_exp],
    ] });
    if (g === "gamma") S.push({ type: "one", title: "Bars", key: "bars", opts: [
      ["net", "Total gamma", "Net GEX at each strike: call gamma minus put gamma, in $ of delta per $1 move."],
      ["split", "Call and put gamma", "Calls up and puts down, each one separately."],
      ["expiry", "Gamma by expiration", "Each bar split into the next expiration, each weekly and each monthly, with its share of gamma."]] });
    if (g === "delta") S.push({ type: "one", title: "Bars", key: "dbars", opts: [
      ["net", "Total delta", "Dealer delta at each strike, in $: what they would have to sell (positive) or buy (negative) to be neutral."],
      ["split", "Call and put delta", "Call delta and put delta, each one separately."]] });
    if (g === "oi") S.push({ type: "one", title: "Bars", key: "oiMode", opts: [
      ["total", "Total open interest", "Open contracts at the previous close: calls up and puts down."],
      ["chg", "Daily change", "Contracts opened (up) or closed (down) in the last session, calls and puts side by side. Only for the tickers in the lists."],
      ["pos", "Net positioning", "Dealer net contracts at each strike: long (up) or short (down). With “Dealers: flow”, the position estimated from flow."]] });
  } else if (v === "map") {
    if (state.mapLens === "gamma") S.push({ type: "one", title: "Map color", key: "mapMode", opts: [
      ["strike", "By strike", "Gamma concentrated at each strike, like TRACE."],
      ["total", "Total", "Total market GEX if the price were at that level."]] });
    S.push({ type: "one", title: "Session", key: "mapSess", cur: state.mapKind || state.mapSess, opts: [
      ["last", "Last session", "Replays the last session with its candles."],
      ["next", "Next", "Projection of the next session."]] });
    S.push({ type: "one", title: "Color scale", key: "mapScale", opts: [
      ["auto", "Auto", "Adapts to each map and ignores the most extreme values."],
      ["low", "Low", "Full color at a quarter of the largest value: shows the weaker zones."],
      ["medium", "Medium", "Full color at half of the largest value."],
      ["high", "High", "Full color only at the largest value: just the strongest zones stand out."]] });
    S.push({ type: "flag", key: "mapContour", lab: "Contour lines", info: "Lines at 25, 50 and 75% of the color scale. Where they bunch up, the value changes quickly. In Delta and Charm the brighter line marks where buying turns into selling." });
  }
  return S;
}
function renderSet() {
  const row = (role, k, val, on, lab, info, off = false) => {
    const id = `csd_${k}_${val}`;
    return `<div class="cs-r${off ? " off" : ""}"><button class="cs-tg" role="${role}" aria-checked="${on}" data-k="${k}" data-v="${val}"${off ? " disabled" : ""}><i aria-hidden="true"></i><span>${esc(lab)}</span></button>` +
      (info ? `<button class="cs-i" data-i="${id}" aria-expanded="false" aria-controls="${id}" title="What is this">i</button></div><p class="cs-d" id="${id}" hidden>${esc(info)}</p>` : "</div>");
  };
  $("chartSet").innerHTML = setSections().map((sec) => {
    if (sec.type === "seg") return `<div class="cs-type"><div class="cs-t">${sec.title}</div><div class="cs-segs" role="radiogroup" aria-label="${sec.title}">${
      sec.opts.map(([v, l]) => `<button role="radio" aria-checked="${state[sec.key] === v}" data-k="${sec.key}" data-v="${v}" title="${v === "oi" ? "Open interest" : l}">${l}</button>`).join("")}</div></div>`;
    if (sec.type === "flag") return `<div class="cs-sec cs-flag">${row("switch", sec.key, "1", !!state[sec.key], sec.lab, sec.info)}</div>`;
    const cur = sec.cur || state[sec.key];
    return `<div class="cs-sec" role="${sec.type === "one" ? "radiogroup" : "group"}" aria-label="${sec.title}"><div class="cs-t">${sec.title}</div>${
      sec.opts.map(([v, l, info, off]) => row(sec.type === "one" ? "radio" : "switch", sec.key, v,
        sec.type === "multi" ? state.lines.has(v) && !off : cur === v, l, info, off)).join("")}</div>`;
  }).join("");
}
function setChoose(k, v) {
  if (k === "lines") {
    state.lines.has(v) ? state.lines.delete(v) : state.lines.add(v);
    store.set("lines", JSON.stringify([...state.lines]));
  } else if (k === "showLevels") {
    state.showLevels = !state.showLevels; store.set("levels", state.showLevels ? "1" : "0");
  } else if (k === "mapSess") {
    state.mapSess = v;
  } else if (k === "mapContour" || k === "mapBars0") {
    state[k] = !state[k]; store.set(k, state[k] ? "1" : "0");
    if (k === "mapContour") state.heatImg = null;
  } else {
    state[k] = v; store.set(k, v);
    if (k === "mapMode" || k === "mapScale") state.heatImg = null;
  }
  syncSet(); renderSet(); syncMapTools(); draw();
}
function syncSet() {
  const v = state.view, strike = v === "strike";
  $("setBtn").parentElement.hidden = !strike && v !== "map";
  $("levelsTg").hidden = !strike && v !== "map" && v !== "impact";
  $("levelsTg").setAttribute("aria-checked", String(state.showLevels));
  const BN = { net: "Total", split: "Calls and puts", expiry: "By expiration" };
  const nl = (state.greek === "gamma" || state.greek === "delta") ? state.lines.size : 0;
  $("setLab").textContent = strike ? GREEK_N[state.greek] +
    (state.greek === "gamma" ? `, ${BN[state.bars]}` : state.greek === "delta" ? `, ${BN[state.dbars]}` : state.greek === "oi" ? `, ${{ chg: "Daily change", pos: "Dealer net" }[state.oiMode] || "Total"}` : "") +
    (nl ? `, ${nl} line${nl > 1 ? "s" : ""}` : "")
    : v === "map" ? "Settings" : "Levels";
  if (!$("chartSet").hidden) renderSet();
}
/* barra del mapa: desplegables de lente, velas y barras de la izquierda, interruptor del proximo vencimiento y zoom */
const LENS_OPTS = [
  ["gamma", "Gamma", "Violet: dealers long gamma, calmer moves and pinning. Magenta: short gamma, faster moves."],
  ["delta", "Delta Pressure", "What dealers would buy (violet) or sell (magenta) to stay hedged if the price got there. Long gamma: they hold the price; short gamma: they push it."],
  ["charm", "Charm Pressure", "What dealers would buy or sell over the next hour just from time passing. Into the close, the bright zero line marks pinning zones."]];
const CANDLE_OPTS = [["1", "1 minute"], ["5", "5 minutes"], ["15", "15 minutes"]];
const BARS_OPTS = [
  ["gex", "GEX", "Net gamma exposure at each strike, per 1% move."],
  ["oi", "Open interest", "Open contracts at the previous close: calls to the right, puts to the left."],
  ["netoi", "Dealer net contracts", "Estimated dealer position at each strike: long to the right, short to the left."]];
const CARET = `<svg viewBox="0 0 10 6" width="10" height="6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
function ddFill(btn, menu, key, opts, prefix, short) {
  const cur = opts.find((o) => o[0] === state[key]) || opts[0];
  $(btn).innerHTML = `<span class="dd-k">${prefix}</span><b>${esc(short ? short(cur) : cur[1])}</b>${CARET}`;
  $(menu).innerHTML = opts.map(([v, l, sub]) => `<button role="menuitemradio" aria-checked="${state[key] === v}" data-k="${key}" data-v="${v}"><span class="dd-t">${esc(l)}</span>${sub ? `<span class="dd-s">${esc(sub)}</span>` : ""}</button>`).join("");
}
function syncMapTools() {
  ddFill("lensBtn", "lensMenu", "mapLens", LENS_OPTS, "Lens");
  ddFill("candleBtn", "candleMenu", "mapCandle", CANDLE_OPTS, "Candles", (o) => `${o[0]}m`);
  ddFill("barsBtn", "barsMenu", "mapBars", BARS_OPTS, "Bars", (o) => ({ gex: "GEX", oi: "OI", netoi: "Net OI" })[o[0]]);
  const hm = state.heat, d = state.data;
  $("bars0Tg").setAttribute("aria-checked", String(state.mapBars0));
  $("bars0Lab").textContent = hm && d && frontTag(hm, d) !== "0DTE" ? "Next expiration" : "0DTE";
  const zoomed = !!(hm && state.mapZoom && state.mapZoom.sym === hm.symbol);
  $("zoomReset").hidden = !zoomed; $("zoomHint").hidden = zoomed;
  // sin columna de barras (pantalla estrecha) no tiene sentido elegir que muestran
  const g = state.geo, narrow = !!(g && g.kind === "map" && g.barsR - g.barsL < 20);
  $("mtBars").style.visibility = narrow ? "hidden" : "";
}

function bindPopovers() {
  const pairs = [["setBtn", "chartSet"], ["expBtn", "expMenu"], ["lensBtn", "lensMenu"], ["candleBtn", "candleMenu"], ["barsBtn", "barsMenu"], ["trailBtn", "trailMenu"]];
  const close = (except) => pairs.forEach(([b, p]) => { if (p !== except) { $(p).hidden = true; $(b).setAttribute("aria-expanded", "false"); } });
  pairs.forEach(([b, p]) => {
    $(b).addEventListener("click", (e) => {
      e.stopPropagation();
      const open = $(p).hidden;
      close(p);
      if (p === "chartSet" && open) renderSet();
      $(p).hidden = !open; $(b).setAttribute("aria-expanded", String(open));
    });
    $(p).addEventListener("click", (e) => e.stopPropagation());
  });
  // el menu Exportar se cierra al elegir; las opciones del grafico siguen abiertas para probar varias
  $("expMenu").addEventListener("click", (e) => { if (e.target.closest("button")) close(); });
  // los desplegables del mapa se cierran al elegir
  for (const m of ["lensMenu", "candleMenu", "barsMenu"]) $(m).addEventListener("click", (e) => {
    const b = e.target.closest("button[data-k]");
    if (b) { close(); setChoose(b.dataset.k, b.dataset.v); }
  });
  document.addEventListener("click", () => close());
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
}

function bindSeg(id, key, onChange) {
  const box = $(id);
  const sync = () => box.querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === state[key])));
  box.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    state[key] = b.dataset.v; store.set(key, b.dataset.v); sync(); onChange();
  });
  sync();
}

function syncCombo() {
  const px = COMBO[state.symbol];
  $("comboRow").hidden = !px;
  if (px) {
    $("comboTitle").textContent = `Add ${px}`;
    $("comboHelp").textContent = `Adds the ${px} options to ${state.symbol}, converted to its units, like combo levels.`;
  }
  $("comboToggle").setAttribute("aria-checked", String(state.combo && !!px));
  renderChips();
}

/* etiquetas con los ajustes del modelo que no están en su valor por defecto */
function renderChips() {
  const chips = [];
  if (state.model !== "auto") chips.push({ k: "model", t: `Engine: ${MOTOR_NOMBRE[effModel()]}` });
  if (state.pos === "flow") chips.push({ k: "pos", t: "Dealers: flow" });
  if (state.combo && COMBO[state.symbol]) chips.push({ k: "combo", t: `+ ${COMBO[state.symbol]}` });
  const sp = $("spotInput").value.trim();
  if (sp) {
    const v = parseFloat(sp.replace(/,/g, ""));
    chips.push({ k: "spot", t: `Spot ${isFinite(v) ? fmtSpot(v) : sp}` });
  }
  // con todo por defecto no se muestra nada: solo aparecen los ajustes cambiados
  $("chips").innerHTML = chips.map((c) => `<span class="chip">${esc(c.t)}<button data-k="${c.k}" title="Remove" aria-label="Remove ${esc(c.t)}">×</button></span>`).join("");
}

function clearChip(k) {
  if (k === "pos") { state.pos = "standard"; store.set("pos", "standard"); $("posSeg").querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === "standard"))); }
  if (k === "combo") { state.combo = false; store.set("combo", "0"); }
  if (k === "model") { state.model = "auto"; store.set("model", "auto"); $("modelSeg").querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === "auto"))); }
  if (k === "spot") $("spotInput").value = "";
  syncCombo();
  load();
}

function toggleSettings(open) {
  const p = $("settingsPanel"), b = $("settingsBtn");
  const willOpen = open ?? p.hidden;
  p.hidden = !willOpen;
  b.setAttribute("aria-expanded", String(willOpen));
}

/* ============================================================ avisos y actualización automática */
function toast(title, body) {
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<b>${esc(title)}</b>${esc(body)}`;
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), 12000);
  try {
    if (window.Notification && Notification.permission === "granted") new Notification(title, { body });
  } catch { /* sin notificaciones del sistema */ }
}

function checkCrossings(prev, d) {
  if (!prev || prev.symbol !== d.symbol || prev.spot_manual || d.spot_manual) return;
  const a = prev.spot, b = d.spot;
  if (a === b) return;
  for (const it of levelItems(d)) {
    const lv = it.v;
    if ((a < lv && b >= lv) || (a > lv && b <= lv)) {
      const up = b > a;
      toast(`${d.symbol} ${up ? "breaks above" : "drops below"} ${it.name} ${fmtLevel(lv)}`,
        `Price ${fmtSpot(b)} (was ${fmtSpot(a)}). ${it.key === "flip" ? (up ? "Entering positive gamma territory." : "Entering negative gamma territory.") : ""}`);
    }
  }
}

// indices en tiempo real: en la nube el motor los recalcula cada 5 min (motor.py rapido); el resto, cada 15
const TIEMPO_REAL = new Set(["SPX", "NDX", "RUT", "SPY", "QQQ", "IWM"]);

function setAuto(on, quiet = false) {
  state.auto = on;
  store.set("autoOn", on ? "1" : "0");
  $("autoToggle").setAttribute("aria-checked", String(on));
  clearInterval(state.autoTimer);
  if (on) {
    // cada minuto mira si toca: los indices en tiempo real (en la nube) cada minuto, para ver cada vela nueva en
    // cuanto el motor la publica; lo demas, cada 5 minutos
    let tick = 0;
    state.autoTimer = setInterval(() => {
      tick++;
      const rt = ME && ME.nube && state.mode !== "scanner" && TIEMPO_REAL.has(state.symbol);
      if (!rt && tick % 5) return;
      if (state.mode === "scanner") { if (state.scanView === "table") runScan(); else if (state.scanView === "compass") loadCompass(true); }
      else load(false, true);
    }, 60 * 1000);
    if (quiet) return;
    try { if (window.Notification && Notification.permission === "default") Notification.requestPermission(); } catch { /* */ }
    toast("Auto refresh on", "Reloads the data as soon as the engine publishes it (every 5 min for SPX, NDX, RUT, SPY, QQQ and IWM; every 15 for the rest) and alerts you when the price crosses a level.");
  }
}

function markQuick() {
  document.querySelectorAll("#quick button").forEach((b) => b.classList.toggle("on", b.dataset.s === state.symbol));
}

function setView(v) {
  state.view = v; store.set("view", v);
  if (v !== "map") { state.hubView = v; store.set("hubView", v); }
  syncNav();
  $("tabImpact").setAttribute("aria-selected", String(v === "impact"));
  $("tabStrike").setAttribute("aria-selected", String(v === "strike"));
  document.body.classList.toggle("view-map", v === "map");
  $("tabProfile").setAttribute("aria-selected", String(v === "profile"));
  $("tabHistory").setAttribute("aria-selected", String(v === "history"));
  $("tabMap").setAttribute("aria-selected", String(v === "map"));
  syncSet();
  $("caption").textContent = v === "history" ? "Levels at the close of each saved session, with this expiration filter and this engine. Click the legend to show or hide each line"
    : v === "profile" ? "Total GEX recalculated at each hypothetical underlying price"
    : v === "impact" ? "Lines: total gamma of the filter's expirations and of the next weekly expiration if the price were at each level. Bars: net gamma at each strike at the current price" : "";
  mapCaption();
  if (typeof placeHub === "function") placeHub();
  $("tip").hidden = true;
  draw();
}

function onMove(e) {
  const d = state.data, g = state.geo, tip = $("tip");
  if (!d || !g) return;
  const svg = $("chart").querySelector("svg");
  if (!svg) return;
  const rect = svg.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  if (g.kind === "map") return mapTip(e, x, y, g, svg);
  if (x < g.left || x > g.right || y < g.top - 10 || y > g.bottom) return hideTip();

  let html;
  if (g.kind === "strike") {
    const i = Math.floor((x - g.left) / g.band), b = g.data || d;
    if (i < 0 || i >= g.n) return hideTip();
    const hl = svg.querySelector("#hl");
    hl.setAttribute("x", g.left + i * g.band); hl.setAttribute("visibility", "visible");
    const k = b.strikes[i], h = b.bucket ? (b.step - b.bucketStep) / 2 : 0;
    html = `<div class="t">${b.bucket ? `Strikes ${fmtLevel(k - h)}–${fmtLevel(k + h)}` : `Strike ${fmtLevel(k)}`}</div>
      <div class="r">Net <b>${fmtBig(b.net[i], true)}</b></div>
      <div class="r">Calls <b>${fmtBig(b.calls[i], true)}</b></div>
      <div class="r">Puts <b>${fmtBig(b.puts[i], true)}</b></div>
      ${state.greek === "delta" && b.delta ? `<div class="tsep"></div><div class="r">Net delta <b>${fmtBig(b.delta.net[i], true)}</b></div><div class="r">Delta calls <b>${fmtBig(b.delta.calls[i], true)}</b></div><div class="r">Delta puts <b>${fmtBig(b.delta.puts[i], true)}</b></div>` : ""}
      ${lineTip(b, k)}
      ${state.greek === "oi" && b.oi && b.oi.calls ? oiTip(b, i) : state.greek === "gamma" && state.bars === "expiry" && expG(b) ? expTip(b, i) : `<div class="r">Expires ${ddmm(b.front_expiry)} <b>${fmtBig(b.front[i], true)}</b></div>`}`;
  } else if (g.kind === "history" && typeof historyTip === "function") {
    html = historyTip(d, g, x, svg);
    if (!html) return hideTip();
  } else if (g.kind === "impact" && typeof impactTip === "function") {
    html = impactTip(d, g, x, svg);
    if (!html) return hideTip();
  } else {
    const X = d.profile.x, Y = d.profile.y;
    const v = g.x0 + ((x - g.left) / (g.right - g.left)) * (g.x1 - g.x0);
    let j = X.findIndex((xx) => xx >= v); if (j <= 0) j = 1;
    const t = (v - X[j - 1]) / (X[j] - X[j - 1]);
    const yv = Y[j - 1] + t * (Y[j] - Y[j - 1]);
    const cr = svg.querySelector("#cross");
    cr.setAttribute("visibility", "visible");
    svg.querySelector("#crossL").setAttribute("x1", x); svg.querySelector("#crossL").setAttribute("x2", x);
    svg.querySelector("#crossC").setAttribute("cx", x); svg.querySelector("#crossC").setAttribute("cy", g.yOf(yv));
    html = `<div class="t">Spot ${fmtSpot(v)}</div><div class="r">Total GEX <b>${fmtBig(yv, true)}</b></div>
      <div class="r">Distance <b>${fmtPct((v / d.spot - 1) * 100)}</b></div>`;
  }
  tip.innerHTML = html; tip.hidden = false;
  const wr = $("chart").getBoundingClientRect(), pr = tip.offsetParent.getBoundingClientRect();
  let tx = e.clientX - pr.left + 16, ty = e.clientY - pr.top - tip.offsetHeight - 10;
  if (tx + tip.offsetWidth > pr.width - 8) tx = e.clientX - pr.left - tip.offsetWidth - 16;
  if (ty < wr.top - pr.top) ty = e.clientY - pr.top + 16;
  tip.style.left = tx + "px"; tip.style.top = ty + "px";
}
function lineTip(b, k) {
  const LN = strikeLines(b);
  if (!LN.length) return "";
  const X = b.profile.x;
  let j = X.findIndex((x) => x >= k); if (j <= 0) j = 1;
  const t = (k - X[j - 1]) / (X[j] - X[j - 1]);
  return `<div class="tsep"></div>` + LN.map((l) => `<div class="r"><span class="capsw" style="background:${l.color}"></span>${esc(l.lab)} <b>${fmtBig(l.y[j - 1] + t * (l.y[j] - l.y[j - 1]), true)}</b></div>`).join("");
}
function oiTip(b, i) {
  const o = b.oi, n = (v) => fmtNum(v || 0), c = (v) => (v > 0 ? "+" : "") + fmtNum(v || 0);
  return `<div class="tsep"></div>${o.net_pos ? `<div class="r">Dealer net <b>${c(o.net_pos[i])}</b></div>` : ""}<div class="r">OI calls <b>${n(o.calls[i])}</b></div><div class="r">OI puts <b>${n(o.puts[i])}</b></div>` +
    (o.chg_calls ? `<div class="r">Call change <b>${c(o.chg_calls[i])}</b></div><div class="r">Put change <b>${c(o.chg_puts[i])}</b></div>` : "");
}
function expTip(b, i) {
  const cols = expColors(b.by_exp), labs = expLabels(b);
  const rows = b.by_exp.gex.map((r, j) => [j, r[i]]).filter(([, v]) => Math.abs(v) > 0);
  if (!rows.length) return "";
  return `<div class="tsep"></div>` + rows.map(([j, v]) =>
    `<div class="r"><span class="capsw" style="background:${cols[j]}"></span>${esc(labs[j])} <b>${fmtBig(v, true)}</b></div>`).join("");
}
function placeTip(e) {
  const tip = $("tip");
  const wr = $("chart").getBoundingClientRect(), pr = tip.offsetParent.getBoundingClientRect();
  let tx = e.clientX - pr.left + 16, ty = e.clientY - pr.top - tip.offsetHeight - 10;
  if (tx + tip.offsetWidth > pr.width - 8) tx = e.clientX - pr.left - tip.offsetWidth - 16;
  if (ty < wr.top - pr.top) ty = e.clientY - pr.top + 16;
  tip.style.left = tx + "px"; tip.style.top = ty + "px";
}

function mapTip(e, x, y, g) {
  const d = state.data, hm = state.heat, tip = $("tip");
  if (!hm || y < g.top || y > g.bottom) return hideTip();
  const price = g.pLo + ((g.bottom - y) / (g.bottom - g.top)) * (g.pHi - g.pLo);
  let html;
  if (x >= g.barsL && x <= g.barsR && g.sb) {
    // barra mas cercana, con los mismos valores (y agrupacion) que se dibujan
    const sb = g.sb;
    let bi = -1, bd = Infinity;
    sb.ks.forEach((k, i) => { const dd = Math.abs(k - price); if (dd < bd) { bd = dd; bi = i; } });
    if (bi < 0) return hideTip();
    const rows = sb.kind === "oi" ? `<div class="r">Calls <b>${fmtNum(sb.right[bi])}</b></div><div class="r">Puts <b>${fmtNum(sb.left[bi])}</b></div>`
      : sb.kind === "netoi" ? `<div class="r">Dealers ${sb.right[bi] >= 0 ? "long" : "short"} <b>${fmtNum(Math.abs(sb.right[bi]))}</b></div>`
      : `<div class="r">GEX per 1% <b>${fmtBig(sb.right[bi], true)}</b></div>`;
    html = `<div class="t">Strike ${fmtLevel(sb.ks[bi])}${state.mapBars0 ? `, ${frontTag(hm, d)}` : ""}</div>${rows}`;
  } else if (x >= g.left && x <= Math.min(g.right, g.lastX)) {
    const mins = g.m0 + ((x - g.left) / (g.right - g.left)) * (g.m1 - g.m0);
    const c = Math.max(0, Math.min(hm.times.length - 1, Math.round((mins - g.m0) / 5)));
    const r = Math.max(0, Math.min(hm.prices.length - 1, Math.round(((price - g.fLo) / (g.fHi - g.fLo)) * (hm.prices.length - 1))));
    const v = heatZ(hm)[r][c], ln = heatLens(hm);
    const val = ln === "delta" ? `<div class="r">Dealers would ${v >= 0 ? "buy" : "sell"} <b>${fmtBig(Math.abs(v), true)}</b></div>`
      : ln === "charm" ? `<div class="r">Next hour, dealers ${v >= 0 ? "buy" : "sell"} <b>${fmtBig(Math.abs(v), true)}</b></div>`
      : `<div class="r">${heatZ(hm) === hm.z ? "Total GEX" : "Gamma at strike"} <b>${fmtBig(v, true)}</b></div>`;
    html = `<div class="t">${nyHHMM(hm.session + " " + hm.times[c])}, price ${fmtSpot(price)}</div>${val}
      <div class="r">Distance <b>${fmtPct((price / hm.spot - 1) * 100)}</b></div>`;
  } else return hideTip();
  tip.innerHTML = html; tip.hidden = false;
  placeTip(e);
}

function mapZoomStart(e) {
  const g = state.geo, svg = $("chart").querySelector("svg");
  if (e.button !== 0 || state.view !== "map" || !g || g.kind !== "map" || !state.heat || !svg) return;
  const rect = svg.getBoundingClientRect(), x = e.clientX - rect.left, y0 = e.clientY - rect.top;
  if (x < g.left || x > g.right || y0 < g.top || y0 > g.bottom) return;
  e.preventDefault();
  const sel = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  for (const [k, v] of Object.entries({ x: g.left, y: y0, width: g.right - g.left, height: 0, fill: C.hi, "fill-opacity": 0.08, stroke: C.hi, "stroke-opacity": 0.45 }))
    sel.setAttribute(k, v);
  svg.appendChild(sel);
  let y1 = y0;
  const move = (ev) => {
    y1 = Math.max(g.top, Math.min(g.bottom, ev.clientY - rect.top));
    sel.setAttribute("y", Math.min(y0, y1)); sel.setAttribute("height", Math.abs(y1 - y0));
    hideTip();
  };
  const up = () => {
    window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up);
    sel.remove();
    if (Math.abs(y1 - y0) < 10) return;
    const pOf = (y) => g.pLo + ((g.bottom - y) / (g.bottom - g.top)) * (g.pHi - g.pLo);
    state.mapZoom = { sym: state.heat.symbol, lo: pOf(Math.max(y0, y1)), hi: pOf(Math.min(y0, y1)) };
    draw();
  };
  window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
}

function hideTip() {
  $("tip").hidden = true;
  const svg = $("chart").querySelector("svg");
  if (!svg) return;
  svg.querySelector("#hl")?.setAttribute("visibility", "hidden");
  svg.querySelector("#cross")?.setAttribute("visibility", "hidden");
}

/* ============================================================ copiar imagen */
// imagen del grafico visible como Blob PNG
function chartPngBlob() {
  const d = typeof zoomed === "function" ? zoomed(state.data, state.view) : state.data;
  const isMap = state.view === "map" && state.heat;
  const W = 2000, H = isMap ? 1000 : 680, scale = 1.5;
  const geo = state.geo;
  const svg = isMap ? renderMap(d, state.heat, W, H, true)
    : state.view === "impact" ? renderImpact(d, W, H, true)
    : state.view === "history" ? renderHistory(d, W, H, true)
    : state.view === "profile" ? renderProfile(d, W, H, true) : renderStrike(d, W, H, true);
  state.geo = geo;
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement("canvas");
      cv.width = W * scale; cv.height = H * scale;
      const ctx = cv.getContext("2d");
      ctx.fillStyle = C.ink; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0, W, H);
      URL.revokeObjectURL(url);
      cv.toBlob((bl) => (bl ? resolve(bl) : reject(new Error("Could not create the image"))), "image/png");
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not create the image")); };
    img.src = url;
  });
}

// copia la imagen al portapapeles: la escritura se pide dentro del clic (con la imagen como promesa),
// que es lo que exige el navegador
function copyPNG() {
  if (!state.data) return;
  const btn = $("copyBtn");
  if (!navigator.clipboard || !window.ClipboardItem) { toast("Can't copy", "This browser doesn't allow copying images."); return; }
  btn.disabled = true;
  navigator.clipboard.write([new ClipboardItem({ "image/png": chartPngBlob() })])
    .then(() => toast("Image copied", "Paste it with Ctrl+V."))
    .catch((e) => toast("Could not copy", e && e.message ? e.message : "The browser blocked the clipboard."))
    .finally(() => { btn.disabled = false; });
}

// niveles para el indicador de TradingView: una linea "precio, etiqueta" por nivel, de mayor a menor.
// Las etiquetas llevan las palabras que el indicador usa para el color (call wall, put wall, flip, sigma, spot)
function tvLevels(d) {
  const L = d.levels, dec = decFor(d.step), num = (v, n) => Number(v).toFixed(n);
  const rows = [];
  const add = (v, lab, n = dec) => { if (v != null && isFinite(v)) rows.push([+v, `${num(v, n)}, ${lab}`]); };
  add(L.call_wall, "Call Wall");
  add(L.flip, "Gamma Flip");
  add(L.vt, d.is_index === false ? "Hedge Wall" : "Vol Trigger");
  add(L.put_wall, "Put Wall");
  if (L.abs_gamma != null && ![L.call_wall, L.put_wall].includes(L.abs_gamma)) add(L.abs_gamma, "Absolute Gamma");
  if (L.zero_gamma != null && Math.abs(L.zero_gamma - (L.flip || 0)) > 1e-9) add(L.zero_gamma, "Zero Gamma");
  add(d.spot, "Spot", 2);
  const m1 = d.moves && d.moves.d1, m5 = d.moves && d.moves.d5;
  if (m1) { add(m1.hi, "+1 Sigma", 2); add(m1.lo, "-1 Sigma", 2); }
  if (m5) { add(m5.hi, "+1 Sigma 5d", 2); add(m5.lo, "-1 Sigma 5d", 2); }
  return rows.sort((a, b) => b[0] - a[0]).map((r) => r[1]).join("\n");
}

async function copyTV() {
  const d = state.data;
  if (!d) return;
  const text = tvLevels(d), btn = $("tvBtn");
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch {
    // navegadores sin acceso al portapapeles: copia con un campo de texto temporal
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
  }
  if (!ok) { toast("Could not copy", "The browser blocked the clipboard."); return; }
  toast(`${d.symbol} levels copied`, `${text.split("\n").length} levels. In TradingView: indicator Settings ▸ Inputs ▸ paste into the text box.`);
}

function svgToPng(svg, W, H, filename, scale = 1.5) {
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    const cv = document.createElement("canvas");
    cv.width = W * scale; cv.height = H * scale;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = C.ink; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, W, H);
    URL.revokeObjectURL(url);
    cv.toBlob((b) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(b); a.download = filename; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }, "image/png");
  };
  img.onerror = () => { URL.revokeObjectURL(url); setStatus("err", "Could not create the image"); console.error("svgToPng: la imagen SVG no se pudo cargar"); };
  img.src = url;
}

/* informe: resumen de niveles + gráfico por strike + mapa, en una sola imagen */
async function exportReport() {
  const d = state.data;
  if (!d) return;
  setStatus("busy", "Preparing report…");
  if (!state.heat || state.heatKey !== heatParams()) {
    try {
      const r = await fetch("/api/heatmap?" + heatParams());
      const hm = await r.json();
      if (!r.ok) throw new Error(hm.error);
      state.heat = hm; state.heatKey = heatParams(); state.heatImg = null;
    } catch (e) { setStatus("err", "Could not calculate the map for the report"); return; }
  }
  // Informe con la misma estetica que la web: tarjetas sobre el fondo, cabecera con precio, regimen y niveles
  // (con su cambio frente a la sesion anterior), Impacto calls y puts con la ficha, barras por strike y TRACE
  const W = 2000, G = 24, headH = 400, impH = 760, chartH = 700, mapH = 920, footH = 70;
  const yImp = headH + G, yStrike = yImp + impH + G, yMap = yStrike + chartH + G, H = yMap + mapH + footH;
  const cardW = 600, impW = W - cardW - G;
  const geo = state.geo, greek = state.greek, mapMode = state.mapMode;
  state.greek = "gamma"; state.heatImg = null; state.inReport = true;
  const impSvg = typeof renderImpact === "function" ? renderImpact(d, impW, impH, true).replace("<svg ", `<svg x="0" y="${yImp}" `) : "";
  const strikeSvg = renderStrike(d, W, chartH, true).replace("<svg ", `<svg x="0" y="${yStrike}" `);
  const mapSvg = renderMap(d, state.heat, W, mapH, true).replace("<svg ", `<svg x="0" y="${yMap}" `);
  state.greek = greek; state.mapMode = mapMode; state.geo = geo; state.heatImg = null; state.inReport = false;

  const L = d.levels, t = d.totals, em = move1(d), hb = d.hub || {};
  const dte = DTE_LABEL[state.dte] || "";
  const neg = d.regime === "negative";
  const T = (x, y, str, o = {}) => `<text x="${x}" y="${y}" text-anchor="${o.a || "start"}" font-family="${SANS}" font-size="${o.fs || 22}" font-weight="${o.w || 400}" fill="${o.c || C.text}">${str}</text>`;
  const card = (x, y, w, h) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="22" fill="${C.surface}" stroke="${C.axis}" stroke-opacity="0.6"/>`;
  let s = `<rect width="${W}" height="${H}" fill="${C.ink}"/>` + card(0, 0, W, headH);

  // --- cabecera: identidad, precio y regimen
  const date = fullDate(d.session || (d.computed_at || "").slice(0, 10));
  s += T(56, 74, esc(d.symbol), { fs: 46, w: 700 });
  s += T(56 + textW(d.symbol, 46, 700, true) + 20, 74, `${esc(d.name || "")}${d.combo ? ` + ${esc(d.combo.proxy)}` : ""}`, { fs: 22, c: C.muted });
  s += T(56, 112, `${dte}, ${date}, ${state.pos === "flow" ? "dealers from flow" : "standard convention"}`, { fs: 19, c: C.faint });
  s += T(56, 200, fmtSpot(d.spot), { fs: 76, w: 600 });
  const chg = d.chg_pct;
  if (chg != null && !d.spot_manual) s += T(56 + textW(fmtSpot(d.spot), 76, 600, true) + 22, 200, fmtPct(chg), { fs: 28, w: 500, c: chg >= 0 ? C.put : C.call });
  // pastilla: 30 px a la izquierda (punto) y 18 a la derecha del texto
  s += `<rect x="56" y="232" width="${textW(neg ? "Negative gamma" : "Positive gamma", 20, 600, true) + 48}" height="38" rx="19" fill="${neg ? C.neg : C.pos}" fill-opacity="0.16"/>`;
  s += `<circle cx="74" cy="251" r="5" fill="${neg ? C.neg : C.pos}"/>` + T(86, 258, neg ? "Negative gamma" : "Positive gamma", { fs: 20, w: 600, c: neg ? C.neg : C.pos });
  s += T(56, 300, neg ? "Below the flip: dealer hedging tends" : "Above the flip: dealer hedging tends", { fs: 20, c: C.muted });
  s += T(56, 326, neg ? "to amplify moves." : "to dampen moves.", { fs: 20, c: C.muted });
  // GEX neta con la barra calls/puts
  const cA = Math.abs(t.call_per_pct || 0), pA = Math.abs(t.put_per_pct || 0), tot = cA + pA || 1;
  s += T(56, 356, "Net GEX per 1%", { fs: 19, c: C.muted }) + T(600, 356, fmtBig(t.net_per_pct, true), { a: "end", fs: 24, w: 600 });
  s += `<rect x="56" y="370" width="${544 * cA / tot - 2}" height="8" rx="4" fill="${C.pos}"/><rect x="${56 + 544 * cA / tot + 2}" y="370" width="${544 * pA / tot - 2}" height="8" rx="4" fill="${C.neg}"/>`;

  // --- niveles con distancia y cambio frente a la sesion anterior
  const rows = levelItems(d);
  if (L.abs_gamma != null && !rows.some((r) => r.v === L.abs_gamma)) rows.push({ key: "abs_gamma", name: "Absolute gamma", v: L.abs_gamma, c: C.muted });
  rows.push({ key: "spot", name: "Spot", v: d.spot, c: C.text, spot: true });
  rows.sort((a, b) => b.v - a.v);
  const lx = 700, ly0 = 64, lh = Math.min(50, (headH - 90) / Math.max(1, rows.length));
  s += T(lx, 40, "LEVELS", { fs: 16, w: 600, c: C.faint });
  rows.forEach((r, i) => {
    const y = ly0 + 18 + i * lh;
    s += r.spot ? `<circle cx="${lx + 8}" cy="${y - 7}" r="8" fill="${C.text}"/>` : `<circle cx="${lx + 8}" cy="${y - 7}" r="8" fill="none" stroke="${r.c}" stroke-width="3"/>`;
    s += T(lx + 30, y, r.name, { fs: 22, c: r.spot ? C.text : C.muted, w: r.spot ? 600 : 400 });
    s += T(lx + 400, y, r.spot ? fmtSpot(r.v) : fmtLevel(r.v), { a: "end", fs: 24, w: 600 });
    if (!r.spot) s += T(lx + 500, y, fmtPct((r.v / d.spot - 1) * 100), { a: "end", fs: 18, c: C.faint });
    const p = d.prev;
    if (!r.spot && p && r.key in p && p[r.key] != null) {
      const was = p[r.key], same = Math.abs(was - r.v) < 1e-9, up = r.v > was;
      s += same ? T(lx + 530, y, `same as ${ddmm(p.date)}`, { fs: 17, c: C.faint })
        : T(lx + 530, y, `${ddmm(p.date)}: ${fmtLevel(was)}`, { fs: 17, c: C.faint }) +
          T(lx + 530 + textW(`${ddmm(p.date)}: ${fmtLevel(was)}`, 17, 400, true) + 10, y, `${up ? "▲" : "▼"} ${fmtLevel(Math.abs(r.v - was))}`, { fs: 17, w: 600, c: up ? C.put : C.call });
    }
  });

  // --- cifras clave
  const m5 = d.moves && d.moves.d5;
  const facts = [
    [`1σ range, ${rangeLabel(em)}`, em ? `±${fmtNum(em.pct, 2)}%` : "—", em ? `${fmtSpot(em.lo)} – ${fmtSpot(em.hi)}` : ""],
    ["1σ range, 5 sessions", m5 ? `±${fmtNum(m5.pct, 2)}%` : "—", m5 ? `${fmtSpot(m5.lo)} – ${fmtSpot(m5.hi)}` : ""],
    ["Vanna (IV −1 pt)", `${t.vanna_flow >= 0 ? "+" : "−"}${fmtBig(Math.abs(t.vanna_flow), true)}`, ""],
    [charmLabel(d), `${t.charm_flow >= 0 ? "+" : "−"}${fmtBig(Math.abs(t.charm_flow), true)}`, ""],
    ["Zero gamma (profile)", L.zero_gamma != null ? fmtLevel(L.zero_gamma) : "—", ""],
  ];
  const fx = 1480, fr = W - 56;
  s += T(fx, 40, "KEY FIGURES", { fs: 16, w: 600, c: C.faint });
  facts.forEach(([k, v, sub], i) => {
    const y = 84 + i * 62;
    s += T(fx, y, esc(k), { fs: 20, c: C.muted }) + T(fr, y, esc(v), { a: "end", fs: 26, w: 600 });
    if (sub) s += T(fr, y + 22, sub, { a: "end", fs: 16, c: C.faint });
  });

  // --- ficha (como en el Equity Hub)
  const cr = ((typeof hub !== "undefined" && hub.cmp) || (cmp.data && cmp.data.rows) || []).find((r) => r.symbol === d.symbol);
  const pc = (v) => (v == null ? "—" : fmtNum(v * 100, 1) + "%");
  const exd = (iso) => (iso ? fullDate(iso) : "—");
  const vp = (v, edge) => (v != null ? fmtLevel(v) : edge && hb.range ? (edge === "up" ? `above ${fmtSpot(hb.range[1])}` : `below ${fmtSpot(hb.range[0])}`) : "—");
  const ficha = [
    ["Previous close", fmtSpot(d.prev_close)],
    ["IV rank", cr && cr.y != null ? fmtNum(cr.y, 0) + "%" : "—"],
    ["30-day IV", pc(hb.iv30)],
    ["20-day realized vol", pc(hb.rv20)],
    ["Low volatility point", vp(hb.low_vol_point, hb.low_vol_edge)],
    ["High volatility point", vp(hb.high_vol_point, hb.high_vol_edge)],
    ["Call gamma (1%)", fmtBig(t.call_per_pct, true)],
    ["Put gamma (1%)", fmtBig(t.put_per_pct, true)],
    ["Exp. with most gamma", exd(hb.top_gamma_exp)],
    ["Exp. with most delta", exd(hb.top_delta_exp)],
    ["Call / put volume", `${hb.call_vol != null ? fmtBig(hb.call_vol) : "—"} / ${hb.put_vol != null ? fmtBig(hb.put_vol) : "—"}`],
    ["Put/call ratio (OI)", hb.pc_oi != null ? fmtNum(hb.pc_oi, 2) : "—"],
  ];
  const cx0 = impW + G;
  s += card(cx0, yImp, cardW, impH) + T(cx0 + 36, yImp + 52, "PROFILE", { fs: 16, w: 600, c: C.faint });
  const rh = (impH - 100) / ficha.length;
  ficha.forEach(([k, v], i) => {
    const y = yImp + 100 + i * rh;
    s += T(cx0 + 36, y, esc(k), { fs: 21, c: C.muted }) + T(cx0 + cardW - 36, y, esc(v), { a: "end", fs: 22, w: 600 });
    if (i < ficha.length - 1) s += `<line x1="${cx0 + 36}" x2="${cx0 + cardW - 36}" y1="${y + rh / 2 - 6}" y2="${y + rh / 2 - 6}" stroke="${C.grid}"/>`;
  });

  // --- pie
  // la firma va en el pie: arriba a la derecha se montaba sobre las cifras clave
  s += brandSign(W - 56, H - 26, 22);
  s += T(56, H - 28, `Generated ${fullDate(new Date().toISOString().slice(0, 10))} ${hhmm(new Date())}. Options from ${d.source === "tradier" ? "Tradier (real time at calculation)" : "CBOE (~15 min delay)"}, open interest from the previous close. Not financial advice`, { fs: 17, c: C.faint });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${s}${impSvg}${strikeSvg}${mapSvg}</svg>`;
  svgToPng(svg, W, H, `Report_${d.symbol}_${d.session || ""}.png`, 1.25);
  setStatus("", `${d.symbol} report generated`);
  draw();
}

/* ============================================================ buscador */
const sug = { items: [], i: -1, t: null, ctrl: null };

function recents() {
  try { return JSON.parse(store.get("recent", "[]")) || []; } catch { return []; }
}
function pushRecent(symbol, name) {
  const r = recents().filter((x) => x.symbol !== symbol);
  r.unshift({ symbol, name: name || "" });
  store.set("recent", JSON.stringify(r.slice(0, 6)));
}

function renderSuggest(items, heading) {
  const ul = $("suggest");
  sug.items = items; sug.i = -1;
  if (!items.length) { closeSuggest(); return; }
  const q = $("symbol").value.trim();
  const hi = (s) => {
    if (!q) return esc(s);
    const k = s.toUpperCase().indexOf(q.toUpperCase());
    return k < 0 ? esc(s) : esc(s.slice(0, k)) + "<mark>" + esc(s.slice(k, k + q.length)) + "</mark>" + esc(s.slice(k + q.length));
  };
  ul.innerHTML = (heading ? `<span class="h">${heading}</span>` : "") + items.map((x, k) =>
    `<li role="option" id="opt${k}" data-k="${k}" aria-selected="false"><span class="s">${hi(x.symbol)}</span><span class="n">${hi(x.name || "")}</span></li>`).join("");
  ul.hidden = false;
  $("symbol").setAttribute("aria-expanded", "true");
}
function closeSuggest() {
  $("suggest").hidden = true; sug.items = []; sug.i = -1;
  $("symbol").setAttribute("aria-expanded", "false");
  $("symbol").removeAttribute("aria-activedescendant");
}
function moveSuggest(d) {
  if (!sug.items.length) return;
  sug.i = (sug.i + d + sug.items.length) % sug.items.length;
  $("suggest").querySelectorAll("li").forEach((li, k) => li.setAttribute("aria-selected", String(k === sug.i)));
  $("symbol").setAttribute("aria-activedescendant", "opt" + sug.i);
}
function pickSuggest(k) {
  const x = sug.items[k];
  if (!x) return;
  $("symbol").value = x.symbol; $("spotInput").value = "";
  closeSuggest(); load();
}
async function querySuggest() {
  const q = $("symbol").value.trim();
  if (!q) { renderSuggest(recents(), recents().length ? "Recent" : ""); return; }
  if (sug.ctrl) sug.ctrl.abort();
  sug.ctrl = new AbortController();
  try {
    const r = await fetch("/api/search?q=" + encodeURIComponent(q), { signal: sug.ctrl.signal });
    const d = await r.json();
    if (document.activeElement === $("symbol")) renderSuggest(d.results || []);
  } catch { /* abortada */ }
}

function bindSearch() {
  const inp = $("symbol");
  inp.addEventListener("input", () => { clearTimeout(sug.t); sug.t = setTimeout(querySuggest, 110); });
  inp.addEventListener("focus", () => { inp.select(); querySuggest(); });
  inp.addEventListener("blur", () => setTimeout(closeSuggest, 120));
  inp.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); moveSuggest(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveSuggest(-1); }
    else if (e.key === "Escape") { closeSuggest(); }
    else if (e.key === "Enter" && sug.i >= 0) { e.preventDefault(); pickSuggest(sug.i); }
    else if (e.key === "Enter") { closeSuggest(); }
  });
  $("suggest").addEventListener("mousedown", (e) => {
    const li = e.target.closest("li"); if (!li) return;
    e.preventDefault(); pickSuggest(+li.dataset.k);
  });
}

/* ============================================================ escáner */
const DEFAULT_WATCH = ["SPX", "NDX", "RUT", "SPY", "QQQ", "IWM", "AAPL", "MSFT", "NVDA", "AMZN", "META", "TSLA"];
const scanState = { rows: [], sortK: null, sortDir: 1, ctrl: null, loadedFor: "" };

/* la lista vive en el servidor (watchlist.json) para que el recolector use la misma */
function watchlist() { return (state.watch && state.watch.length ? state.watch : DEFAULT_WATCH).slice(); }
function saveWatch(w) {
  state.watch = w.slice();
  fetch("/api/watchlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbols: w }) })
    .then((r) => r.json()).then((d) => { if (d.symbols) state.watch = d.symbols; }).catch(() => {});
}
async function initWatchlist() {
  try {
    const d = await fetch("/api/watchlist").then((r) => r.json());
    state.watch = d.symbols;
    // primera vez: trae la lista que ya tenias en el navegador
    let local = null;
    try { local = JSON.parse(store.get("watch", "null")); } catch { /* */ }
    if (!ME && d.default && Array.isArray(local) && local.length) saveWatch(local);
  } catch { state.watch = null; }
}

async function loadCollector() {
  const el = $("collector");
  try {
    const d = await fetch("/api/collector").then((r) => r.json());
    const u = d.ultima_recogida;
    if (d.instalado === false && !u) { el.innerHTML = `<span class="cdot off"></span>Collector not installed`; el.title = "Run “Instalar recolector.bat” in the app folder"; return; }
    if (!u) { el.innerHTML = `<span class="cdot"></span>Collector installed, no runs yet`; return; }
    const errs = Object.keys(u.errores || {});
    el.innerHTML = `<span class="cdot ${errs.length ? "warn" : ""}"></span>Collector: ${({ cierre: "close", apertura: "open", intradia: "intraday", reintento: "retry" })[u.tipo] || u.tipo} of ${ddmm(u.sesion)}, ${u.ok}/${u.total} tickers`;
    el.title = `Time: ${nyWhen(u.hora)}. ${errs.length ? "Failed: " + errs.join(", ") : "No errors"}.${d.instalado === false ? " The Windows tasks are not installed." : ""}`;
  } catch { el.textContent = ""; }
}

/* herramientas (oi.js, lab.js): vista, funciones y si usan el ticker de la barra superior */
const TOOLS = {
  oi: { view: "oiView", ticker: true, show: () => showOI(), render: () => renderOI(), load: (r) => loadOI(r) },
  lab: { view: "labView", ticker: true, show: () => showLab(), render: () => renderLab(), load: (r) => loadLab(r) },
  flow: { view: "flowView", ticker: true, show: () => showFlow(), render: () => renderFlow(), load: (r) => loadFlow(r) },
  corr: { view: "corrView", ticker: false, show: () => showCorr(), render: () => renderCorr(), load: (r) => loadCorr(r) },
};
function setMode(m) {
  if (m === "risk" || m === "calc") m = "lab";   // secciones anteriores, unidas en Options Lab
  state.mode = m; store.set("mode", m);
  syncNav();
  const tool = TOOLS[m];
  // booleano siempre: classList.toggle con undefined invierte la clase en vez de quitarla
  const macro = m === "vix" || m === "cot" || m === "summary" || !!(tool && !tool.ticker);
  document.body.classList.toggle("scan", m === "scanner" || macro || m === "vol" || !!tool);
  document.body.classList.toggle("macro-mode", macro);
  document.body.classList.toggle("vol-mode", m === "vol" || !!(tool && tool.ticker));
  document.body.classList.toggle("tool-mode", !!tool);
  for (const [k, t] of Object.entries(TOOLS)) $(t.view).hidden = m !== k;
  document.body.classList.toggle("ana-mode", m === "analysis");
  $("volView").hidden = m !== "vol";
  $("scanner").hidden = m !== "scanner";
  $("vixView").hidden = m !== "vix";
  $("cotView").hidden = m !== "cot";
  $("sumView").hidden = m !== "summary";
  $("modeSummary").setAttribute("aria-selected", String(m === "summary"));
  $("modeAnalysis").setAttribute("aria-selected", String(m === "analysis"));
  $("modeScanner").setAttribute("aria-selected", String(m === "scanner"));
  $("modeVix").setAttribute("aria-selected", String(m === "vix"));
  $("modeCot").setAttribute("aria-selected", String(m === "cot"));
  // al volver a una pestaña con datos de hace mas de 5 min, se pinta lo guardado y se refresca en segundo plano
  if (m === "summary") { if (sm.data) { renderSummary(); setStatus("", sumStatus()); } if (!sm.data || Date.now() - sm.at > 300000) loadSummary(); return; }
  if (m === "vix") { if (vx.data) { renderVix(); setStatus("", vixStatus()); } if (!vx.data || Date.now() - vx.at > 300000) loadVix(); return; }
  if (m === "cot") { if (cot.data) { renderCot(); setStatus("", cotStatus()); } if (!cot.data || Date.now() - cot.at > 300000) loadCot(); return; }
  if (m === "vol") { if (typeof showVol === "function") showVol(); return; }
  if (tool) { tool.show(); return; }
  if (state.data) setStatus("", dataStatus(state.data));
  if (m === "scanner") {
    loadCollector();
    setScanView(state.scanView);
    const key = watchlist().join(",") + "|" + state.dte;
    if (state.scanView === "table") { if (scanState.loadedFor !== key) runScan(); else renderScan(); }
  } else {
    if (state.data) draw(); else load();
  }
}

async function runScan() {
  const list = watchlist();
  scanState.loadedFor = list.join(",") + "|" + state.dte;
  if (scanState.ctrl) scanState.ctrl.abort();
  scanState.ctrl = new AbortController();
  $("scanBtn").disabled = true;
  $("scanStatus").textContent = `Calculating ${list.length} tickers…`;
  const known = Object.fromEntries(scanState.rows.map((r) => [r.symbol, r]));
  scanState.rows = list.map((s) => known[s] ? { ...known[s], stale: true } : { symbol: s, loading: true });
  renderScan();
  try {
    const r = await fetch(`/api/scan?dte=${state.dte}&symbols=${encodeURIComponent(list.join(","))}`, { signal: scanState.ctrl.signal });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Scanner error");
    // en la nube el escaner es el del ultimo ciclo: los tickers recien anadidos aparecen como pendientes y se
    // vuelve a consultar cada 15 s hasta que el motor los incluye (1-2 min)
    const have = new Set(d.rows.map((x) => x.symbol));
    const missing = list.filter((s) => !have.has(s));
    scanState.rows = d.rows.concat(missing.map((s) => ({ symbol: s, loading: true })));
    const ok = d.rows.filter((x) => !x.error).length;
    $("scanStatus").textContent = missing.length && ME && ME.nube
      ? `Calculating ${missing.join(", ")} in the cloud (1–2 min)…`
      : `${ok} of ${d.rows.length} tickers${d.computed_at ? `, calculated ${nyWhen(d.computed_at)}` : ""}`;
    clearTimeout(scanState.retry);
    if (missing.length && ME && ME.nube && (scanState.tries = (scanState.tries || 0) + 1) <= 20) {
      scanState.retry = setTimeout(() => { if (state.mode === "scanner") runScan(); }, 15000);
    } else if (!missing.length) scanState.tries = 0;
  } catch (e) {
    if (e.name === "AbortError") return;
    $("scanStatus").textContent = e.message === "Failed to fetch" ? "The local server is not responding" : e.message;
    scanState.rows = scanState.rows.map((x) => x.loading ? { symbol: x.symbol, error: "No data" } : x);
  } finally {
    $("scanBtn").disabled = false;
  }
  renderScan();
}

// barra del escaner: del Put Wall al Call Wall con el precio (punto) y el flip (marca ambar); debajo los tres niveles
// con su distancia y una flecha si cambiaron desde la sesion guardada anterior
function scanLevels(r) {
  const p = r.prev || {}, vs = [r.put_wall, r.call_wall, r.flip, r.spot].filter((v) => v != null);
  if (r.put_wall == null || r.call_wall == null) return "—";
  const lo = Math.min(...vs), hi = Math.max(...vs), X = (v) => (((v - lo) / (hi - lo || 1)) * 100).toFixed(1) + "%";
  const dec = (v) => (Number.isInteger(v) ? 0 : decFor(r.step || 1));
  const lab = (cls, name, v, dist, prev) => {
    if (v == null) return "";
    const mv = prev != null && Math.abs(prev - v) > 1e-9 ? `<b class="mv ${v > prev ? "up" : "dn"}" title="Was ${fmtNum(prev, dec(prev))}">${v > prev ? "▲" : "▼"}</b>` : "";
    return `<span class="${cls}${dist != null && Math.abs(dist) < 0.5 ? " near" : ""}">${name}${fmtNum(v, dec(v))}${mv}<em>${dist == null ? "" : fmtPct(dist)}</em></span>`;
  };
  return `<div class="sx-lv"><div class="sx-bar">${r.flip != null ? `<i class="fl" style="left:${X(r.flip)}"></i>` : ""}<i class="sp" style="left:${X(r.spot)}"></i></div>
    <div class="lb">${lab("pw", "", r.put_wall, r.put_dist, p.put_wall)}${lab("ff", "flip ", r.flip, r.flip_dist, p.flip)}${lab("cw", "", r.call_wall, r.call_dist, p.call_wall)}</div></div>`;
}
// GEX por 1 %: la cifra y una barra que sale del cero (violeta positiva, magenta negativa), a escala de la lista
function scanGex(v, gmax) {
  if (v == null) return "—";
  const w = Math.min(50, (Math.abs(v) / (gmax || 1)) * 50).toFixed(1);
  return `<div class="sx-gex"><span>${fmtBig(v, true)}</span><div class="sx-bar"><i class="${v < 0 ? "n" : "p"}" style="${v < 0 ? "right" : "left"}:50%;width:${w}%"></i></div></div>`;
}

function renderScan() {
  const body = $("scanBody");
  let rows = scanState.rows.slice();
  if (state.regimeFilter !== "all") rows = rows.filter((r) => r.regime === state.regimeFilter || r.loading);
  const k = scanState.sortK;
  if (k) {
    rows.sort((a, b) => {
      const va = a[k], vb = b[k];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "string") return va.localeCompare(vb) * scanState.sortDir;
      return (k.endsWith("_dist") ? Math.abs(va) - Math.abs(vb) : va - vb) * scanState.sortDir;
    });
  }
  document.querySelectorAll("#scanTable th[data-k]").forEach((th) => {
    th.classList.toggle("sorted", th.dataset.k === k);
    th.dataset.dir = th.dataset.k === k ? (scanState.sortDir > 0 ? "▲" : "▼") : "";
  });
  if (!rows.length) {
    body.innerHTML = `<tr class="err"><td colspan="9" class="l">${scanState.rows.length ? "No ticker matches the filter." : "Add tickers to get started."}</td></tr>`;
    return;
  }
  const ok = rows.filter((r) => !r.loading && !r.error);
  const gmax = Math.max(0, ...ok.map((r) => Math.abs(r.net_per_pct || 0))), emax = Math.max(0, ...ok.map((r) => r.em_pct || 0)) || 1;
  body.innerHTML = rows.map((r) => {
    const rm = `<td><button class="rm" data-rm="${esc(r.symbol)}" title="Remove ${esc(r.symbol)}" aria-label="Remove ${esc(r.symbol)}">×</button></td>`;
    if (r.loading) return `<tr class="loading"><td class="l"><span class="tk">${esc(r.symbol)}</span></td><td colspan="7" class="l">Calculating…</td>${rm}</tr>`;
    if (r.error) return `<tr class="err"><td class="l"><span class="tk">${esc(r.symbol)}</span></td><td colspan="7" class="l">${esc(r.error)}</td>${rm}</tr>`;
    const neg = r.regime === "negative";
    return `<tr data-s="${esc(r.symbol)}"${r.stale ? ' style="opacity:.55"' : ""}>
      <td class="l"><span class="tk">${esc(r.symbol)}</span><span class="nm">${esc(r.name || "")}</span></td>
      <td><b class="sx-px">${fmtSpot(r.spot)}</b><span class="sx-chg ${r.chg >= 0 ? "up" : "dn"}">${r.chg == null ? "—" : fmtPct(r.chg)}</span></td>
      <td class="l"><span class="rg ${neg ? "neg" : "pos"}"><i></i>${neg ? "Negative" : "Positive"}</span></td>
      <td class="l sx-wide">${scanLevels(r)}</td>
      <td>${scanGex(r.net_per_pct, gmax)}</td>
      <td class="l">${r.em_pct == null ? "—" : `<div class="sx-em"><div class="sx-bar"><i style="width:${Math.min(100, (r.em_pct / emax) * 100).toFixed(0)}%"></i></div><span>±${fmtNum(r.em_pct, 2)}%</span></div>`}</td>
      <td>${fmtNum((r.front_share || 0) * 100, 0)}%</td>
      <td${r.impact_bp != null ? ` title="≈ ${fmtNum(r.impact_bp, 0)} bp of price impact per 1% move"` : ""}>${r.gex_adv == null ? "—" : fmtNum(r.gex_adv * 100, r.gex_adv < 0.1 ? 1 : 0) + "%"}</td>
      ${rm}</tr>`;
  }).join("");
}

/* ============================================================ compass */
const cmp = { data: null, key: "", ctrl: null, geo: null, find: "" };
// tickers ocultos en el Compass (preferencia de cada usuario). Sin preferencia y con muchos tickers, se ven los 25 primeros
const CMP_DEFAULT_MAX = 25;
function cmpHidden() {
  try { const v = JSON.parse(store.get("cmpHidden", "null")); if (Array.isArray(v)) return new Set(v); } catch { /* */ }
  const rows = (cmp.data && cmp.data.rows) || [];
  return new Set(rows.length > CMP_DEFAULT_MAX ? rows.slice(CMP_DEFAULT_MAX).map((r) => r.symbol) : []);
}
function setCmpHidden(set) { store.set("cmpHidden", JSON.stringify([...set])); renderCompass(); }
function renderCside() {
  const d = cmp.data; if (!d) return;
  const hid = cmpHidden(), q = cmp.find.trim().toUpperCase();
  const rows = d.rows.filter((r) => !q || r.symbol.includes(q) || (r.name || "").toUpperCase().includes(q));
  const eye = (on) => `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">${on
    ? '<path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10z"/><circle cx="10" cy="10" r="2.4"/>'
    : '<path d="M3 3l14 14M8.3 5.1A8.6 8.6 0 0 1 10 4.5c5 0 8 5.5 8 5.5a14 14 0 0 1-2.6 3.2M5.2 6.6A14 14 0 0 0 2 10s3 5.5 8 5.5c1.1 0 2.1-.3 3-.7"/>'}</svg>`;
  const list = rows.map((r) => {
    const on = !hid.has(r.symbol), bad = r.error || r.x == null || r.y == null;
    return `<tr class="${on ? "" : "off"}${bad ? " bad" : ""}" data-s="${esc(r.symbol)}"><td class="x"><button class="eye" aria-pressed="${on}" title="${on ? "Hide" : "Show"} ${esc(r.symbol)}">${eye(on)}</button></td>
      <td class="l"><span class="tk">${esc(r.symbol)}</span></td><td>${r.iv30 != null ? fmtNum(r.iv30 * 100, 1) + "%" : "—"}</td>
      <td>${r.x != null ? fmtNum(r.x, 0) : "—"}</td><td>${r.y != null ? fmtNum(r.y, 0) : "—"}</td></tr>`;
  }).join("");
  // lo escrito no esta en la lista: se ofrece anadirlo (tambien con Enter)
  const qs = q.replace(/[-/]/g, ".");
  const canAdd = /^[A-Z][A-Z0-9.]{0,9}$/.test(qs) && !d.rows.some((r) => r.symbol === qs);
  $("cBody").innerHTML = (canAdd ? `<tr class="addrow"><td colspan="5"><button data-add="${esc(qs)}">+ Add ${esc(qs)} to your list</button></td></tr>` : "") +
    (list || (canAdd ? "" : `<tr><td colspan="5" class="l na">No matches</td></tr>`));
  const vis = d.rows.filter((r) => !hid.has(r.symbol) && !r.error && r.x != null).length;
  $("cCount").textContent = `${vis} of ${d.rows.length} tickers visible`;
}

function setScanView(v) {
  state.scanView = v; store.set("scanView", v);
  syncNav();
  $("svTable").setAttribute("aria-selected", String(v === "table"));
  $("svCompass").setAttribute("aria-selected", String(v === "compass"));
  $("svValid").setAttribute("aria-selected", String(v === "valid"));
  document.body.classList.toggle("scan-compass", v !== "table");
  $("compassWrap").hidden = v !== "compass";
  $("validWrap").hidden = v !== "valid";
  $("tableWrap").hidden = v !== "table";
  if (v === "compass") loadCompass();
  else if (v === "valid") loadValidation();
  else renderScan();
}

async function loadValidation() {
  const body = $("validBody");
  body.innerHTML = `<tr class="loading"><td colspan="7" class="l">Calculating…</td></tr>`;
  try {
    const r = await fetch(`/api/validation?dte=${state.dte}&mode=${state.validMode}&model=spotgamma&symbols=${encodeURIComponent(watchlist().join(","))}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Validation error");
    const na = `<span class="na">—</span>`;
    const pct = (v, n) => v == null ? na : `${fmtNum(v, 0)}%${n != null ? `<span class="ds">${n} sess.</span>` : ""}`;
    // rango en % y, debajo, frente al rango normal del ticker (media de sus 20 rangos previos)
    const rng = (v, rr, n) => v == null ? na : `${fmtNum(v, 2)}%<span class="ds">${rr != null ? `${fmtNum(rr, 2)}× normal, ` : ""}${n} sess.</span>`;
    // muro: aguantó, y debajo lo que habría aguantado un nivel cualquiera a la misma distancia
    const wall = (v, base) => v == null ? na : `${fmtNum(v, 0)}%${base != null ? `<span class="ds">baseline ${fmtNum(base, 0)}%</span>` : ""}`;
    const row = (x, cls = "") => `<tr class="${cls}"><td class="l"><span class="tk">${esc(x.symbol)}</span></td>
      <td>${x.n}</td><td>${rng(x.range_pos, x.rr_pos, x.n_pos)}</td><td>${rng(x.range_neg, x.rr_neg, x.n_neg)}</td>
      <td>${wall(x.cw_held, x.cw_exp)}</td><td>${wall(x.pw_held, x.pw_exp)}</td><td>${pct(x.em_hit, x.n_em)}</td></tr>`;
    body.innerHTML = d.rows.map((x) => row(x)).join("") + row({ ...d.total, symbol: "Total" }, "total");
    $("validTests").innerHTML = d.tests ? validTestsHtml(d) : "";
    $("scanStatus").textContent = d.total.n ? `${d.total.n} sessions on ${d.n_days ?? "?"} days evaluated (${d.total.n_ante} with levels from before the open)` : "No saved sessions to evaluate yet";
  } catch (e) {
    body.innerHTML = `<tr class="err"><td colspan="7" class="l">${esc(e.message)}</td></tr>`;
    $("validTests").innerHTML = "";
  }
}

/* Pruebas de la Validación (gex_engine._val_tests): cada una agrupa las sesiones por día y solo da veredicto con
   min_days días distintos. Veredicto: pocos días, sin diferencia medible, mejor o peor que la referencia. */
function validVerdict(t, minDays, better, calib = false) {
  if (!t || t.n_days == null || t.n_days === 0) return { cls: "wait", txt: "No data" };
  if (t.n_days < minDays) return { cls: "wait", txt: `Too few days (${t.n_days} of ${minDays})` };
  if (t.p == null) return { cls: "wait", txt: "Not testable" };
  const p = t.p < 0.001 ? "p < 0.001" : `p = ${fmtNum(t.p, t.p < 0.01 ? 3 : 2)}`;
  // en el rango de 1σ lo bueno es no apartarse del 68,3 %
  if (calib) return t.p >= 0.05 ? { cls: "ok", txt: `Consistent with theory (${p})` } : { cls: "bad", txt: `Off target (${p})` };
  if (t.p >= 0.05) return { cls: "none", txt: `No measurable difference (${p})` };
  return better ? { cls: "ok", txt: `Confirmed (${p})` } : { cls: "bad", txt: `Against (${p})` };
}

function validTestsHtml(d) {
  const T = d.tests, tot = d.total, min = T.min_days;
  // con pocos días la estimación del tamaño necesario tampoco es fiable: solo se da cuando ya hay días suficientes
  const need = (t, unit) => t && t.needed && t.n_days >= min && t.p != null && t.p >= 0.05
    ? `<span class="vtest-need">An effect this size would need about ${fmtNum(t.needed)} ${unit} to be told apart from chance.</span>` : "";
  const line = (name, val, t, better, calib = false, unit = "sessions") => {
    const v = validVerdict(t, min, better, calib);
    return `<div class="vtest-row"><div class="vtest-name">${name}</div><div class="vtest-val">${val}${need(t, unit)}</div>
      <div class="vtest-verd ${v.cls}">${v.txt}</div></div>`;
  };
  const diff = (a, b) => (a == null || b == null ? "" : ` (${a - b >= 0 ? "+" : "−"}${fmtNum(Math.abs(a - b), 0)} pts)`);
  const wallVal = (held, base) => held == null ? "No sessions" : base == null
    ? `Held ${fmtNum(held, 0)}% (no baseline: price history too short)`
    : `Held ${fmtNum(held, 0)}% against ${fmtNum(base, 0)}% for any level at the same distance${diff(held, base)}`;
  const rg = T.regime || {};
  const regVal = rg.ratio == null ? "Needs days with both regimes"
    : `On the same day, the range with negative gamma was ${fmtNum(rg.ratio, 2)}× the range with positive gamma, each relative to its ticker's normal range`;
  const emVal = tot.em_hit == null ? "No sessions" : `Close inside the range ${fmtNum(tot.em_hit, 0)}% of the time, against 68.3% in theory${diff(tot.em_hit, 68.3)}`;
  let h = `<div class="vtest-head">Is it better than chance?</div>`;
  h += line("Call Wall", wallVal(tot.cw_obs_b ?? tot.cw_held, tot.cw_exp), T.cw, (T.cw?.effect ?? 0) > 0);
  h += line("Put Wall", wallVal(tot.pw_obs_b ?? tot.pw_held, tot.pw_exp), T.pw, (T.pw?.effect ?? 0) > 0);
  h += line("Gamma regime", regVal, rg, (rg.ratio ?? 1) > 1, false, "days");
  h += line("1σ range", emVal, T.em, false, true);
  const bd = d.by_day;
  if (bd && (bd.event?.n || bd.normal?.n)) {
    const cell = (x, k, b) => x[k] == null ? "—" : `${fmtNum(x[k], 0)}%${b && x[b] != null ? ` <span class="vtest-dim">(${fmtNum(x[b], 0)}%)</span>` : ""}`;
    const rr = (x) => x.rr_pos == null || x.rr_neg == null ? "—" : `${fmtNum(x.rr_neg / x.rr_pos, 2)}×`;
    const r = (lbl, x) => `<tr><td class="l">${lbl}</td><td>${x.n}</td><td>${rr(x)}</td><td>${cell(x, "cw_held", "cw_exp")}</td>
      <td>${cell(x, "pw_held", "pw_exp")}</td><td>${cell(x, "em_hit")}</td></tr>`;
    h += `<div class="vtest-sub">Event days (monthly expiration, FOMC, CPI, payrolls) against the rest. Baseline in parentheses.</div>
      <table class="scan vtest-tab"><thead><tr><th class="l">Days</th><th>Sessions</th><th>Range, gamma − / +</th>
      <th>Call Wall held</th><th>Put Wall held</th><th>Inside 1σ</th></tr></thead>
      <tbody>${r("Normal", bd.normal)}${r("Event", bd.event)}</tbody></table>`;
  }
  return h;
}

async function loadCompass(force = false) {
  const key = watchlist().join(",");
  if (!force && cmp.data && cmp.key === key) { renderCompass(); return; }
  if (cmp.ctrl) cmp.ctrl.abort();
  cmp.ctrl = new AbortController();
  $("compass").innerHTML = `<div class="placeholder">Calculating volatility for ${watchlist().length} tickers…</div>`;
  $("scanStatus").textContent = "Calculating Compass…";
  try {
    const r = await fetch("/api/compass?symbols=" + encodeURIComponent(key), { signal: cmp.ctrl.signal });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Compass error");
    cmp.data = d; cmp.key = key;
    const ok = d.rows.filter((x) => !x.error).length;
    $("scanStatus").textContent = `${ok} of ${d.rows.length} tickers in the Compass`;
    renderCompass();
  } catch (e) {
    if (e.name === "AbortError") return;
    $("compass").innerHTML = `<div class="placeholder err"><div class="err-t">${esc(e.message)}</div></div>`;
  }
}

function renderCompass() {
  const el = $("compass"), d = cmp.data;
  if (!d) return;
  renderCside(); // primero la lista: al llenarse cambia la altura de la fila y, con ella, la del grafico
  const W = Math.max(360, el.clientWidth), H = Math.max(420, el.clientHeight);
  cmp.size = `${W}x${H}`;
  const pad = { l: 64, r: 64, t: 40, b: 56 };
  const L = pad.l, R = W - pad.r, T = pad.t, B = H - pad.b;
  const xOf = (v) => L + ((5 + v * 0.9) / 100) * (R - L), yOf = (v) => B - ((6 + v * 0.88) / 100) * (B - T);
  const mx = xOf(50), my = yOf(50);
  const f = 12.5;
  let s = `<defs><linearGradient id="cmpbg" x1="0" x2="1" y1="0" y2="0">
      <stop offset="0" stop-color="${C.accent}" stop-opacity="0.34"/><stop offset="0.5" stop-color="${C.pos}" stop-opacity="0.14"/>
      <stop offset="1" stop-color="${C.neg}" stop-opacity="0.34"/></linearGradient></defs>
    <rect x="${L}" y="${T}" width="${R - L}" height="${B - T}" fill="url(#cmpbg)" rx="6"/>
    <line x1="${L}" x2="${R}" y1="${my}" y2="${my}" stroke="${C.muted}" stroke-opacity="0.6"/>
    <line x1="${mx}" x2="${mx}" y1="${T}" y2="${B}" stroke="${C.muted}" stroke-opacity="0.6"/>`;
  const q = (x, y, a, b, anchor) => `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="${SANS}" font-size="${f}" fill="${C.faint}">
      <tspan x="${x}" dy="0">${a}</tspan><tspan x="${x}" dy="17">${b}</tspan></text>`;
  s += q((L + mx) / 2, T + 34, "Expensive volatility", "upside potential", "middle");
  s += q((mx + R) / 2, T + 34, "Expensive volatility", "downside potential", "middle");
  s += q((L + mx) / 2, B - 40, "Cheap volatility", "upside potential", "middle");
  s += q((mx + R) / 2, B - 40, "Cheap volatility", "downside potential", "middle");
  s += `<text x="${mx}" y="${T - 14}" text-anchor="middle" font-family="${SANS}" font-size="${f}" fill="${C.muted}">High IV rank</text>`;
  s += `<text x="${mx}" y="${B + 26}" text-anchor="middle" font-family="${SANS}" font-size="${f}" fill="${C.muted}">Low IV rank</text>`;
  s += `<text transform="translate(${L - 24},${my}) rotate(-90)" text-anchor="middle" font-family="${SANS}" font-size="${f}" fill="${C.muted}">Low risk reversal rank</text>`;
  s += `<text transform="translate(${R + 24},${my}) rotate(90)" text-anchor="middle" font-family="${SANS}" font-size="${f}" fill="${C.muted}">High risk reversal rank</text>`;

  // leyenda de estados
  const lg = (cx, label, kind) => `<circle cx="${cx}" cy="${H - 16}" r="5" fill="${kind === "full" ? C.purple : C.surface}" stroke="${C.purple}" stroke-width="${kind === "full" ? 1 : 2}"/>` +
    (kind === "half" ? `<path d="M${cx} ${H - 21} A5 5 0 0 0 ${cx} ${H - 11} Z" fill="${C.purple}"/>` : "") +
    `<text x="${cx + 11}" y="${H - 12}" font-family="${SANS}" font-size="12" fill="${C.muted}">${label}</text>`;
  s += lg(L, "Both axes against their own history", "full") + lg(L + 250, "IV rank with its history, provisional RR", "half") + lg(L + 520, "Provisional (vs. the list)", "empty");
  const hid = cmpHidden();
  const pts = d.rows.filter((r) => !r.error && r.x != null && r.y != null && !hid.has(r.symbol));
  const placed = [];
  cmp.geo = [];
  for (const r of pts) {
    const x = xOf(r.x), y = yOf(r.y);
    let tr = "";
    const past = cmpTrail(r);
    if (past.length) {
      // estela de la sesion mas antigua a hoy: cada tramo y cada punto mas opacos cuanto mas recientes
      const chain = [...past, { x: r.x, y: r.y }], n = chain.length - 1;
      tr = chain.slice(1).map((t, k) => `<line x1="${xOf(chain[k].x)}" y1="${yOf(chain[k].y)}" x2="${xOf(t.x)}" y2="${yOf(t.y)}" stroke="${C.purple}" stroke-opacity="${(0.2 + 0.55 * (k + 1) / n).toFixed(2)}" stroke-width="1.6" stroke-linecap="round"/>`).join("") +
        past.map((t, k) => `<circle cx="${xOf(t.x)}" cy="${yOf(t.y)}" r="${k ? 2.5 : 3.5}" fill="${C.purple}" fill-opacity="${(0.25 + 0.5 * k / n).toFixed(2)}"/>`).join("");
    }
    // etiqueta sin solaparse
    let ly = y - 12;
    for (let k = 0; k < 6 && placed.some((p) => Math.abs(p.x - x) < 44 && Math.abs(p.y - ly) < 14); k++) ly += (k % 2 ? -1 : 1) * 14 * (k + 1);
    placed.push({ x, y: ly });
    const own = r.full;
    const half = !own && r.y_src && r.y_src !== "provisional";
    s += `<g class="cpt" data-s="${esc(r.symbol)}">${tr}
      <circle class="dot" cx="${x}" cy="${y}" r="6" fill="${own ? C.purple : C.surface}" stroke="${C.purple}" stroke-width="${own ? 1 : 2}"/>
      ${half ? `<path d="M${x} ${y - 6} A6 6 0 0 0 ${x} ${y + 6} Z" fill="${C.purple}"/>` : ""}
      <text x="${x}" y="${ly}" text-anchor="middle" font-family="${SANS}" font-size="13" font-weight="600" fill="${C.text}">${esc(r.symbol)}</text></g>`;
    cmp.geo.push({ x, y, r });
  }
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${s}</svg>`;

  const prov = pts.filter((r) => !r.full);
  const errs = d.rows.filter((r) => r.error).map((r) => r.symbol);
  $("compassNote").textContent = (prov.length
    ? `A provisional axis compares the ticker with the rest of your list; it switches to its own history once it has ${d.min_days} saved sessions. The IV rank of SPX, SPY, NDX, QQQ, DIA, AAPL, AMZN, GOOGL and a few more already uses one year of its CBOE volatility index (VIX, VXN, VXAPL…). `
    : "Ranks calculated against each ticker's saved history. ") +
    (errs.length ? `No data: ${errs.join(", ")}.` : "") +
    (d.vol_index_missing && d.vol_index_missing.length ? ` CBOE isn't serving the history of ${d.vol_index_missing.join(", ")} right now: those tickers use the provisional rank until it comes back.` : "") +
    " Click a point to open its analysis.";
}

// sesiones anteriores de la estela segun el selector (las ultimas N, de la mas antigua a la mas reciente)
const TRAIL_OPTS = [["0", "Off", "Only today's point"], ["3", "3 days"], ["5", "5 days"], ["10", "10 days"]];
function syncTrail() {
  ddFill("trailBtn", "trailMenu", "cmpTrail", TRAIL_OPTS, "History", (o) => (o[0] === "0" ? "Off" : `${o[0]} days`));
}
const ICO_MAX = '<svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5V3h4.5M17 7.5V3h-4.5M3 12.5V17h4.5M17 12.5V17h-4.5"/></svg>';
const ICO_MIN = '<svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 3v4.5H3M12.5 3v4.5H17M7.5 17v-4.5H3M12.5 17v-4.5H17"/></svg>';
function cmpMax(on) {
  $("cgrid").classList.toggle("max", on);
  document.body.classList.toggle("cmp-max", on);
  const b = $("cmpMax");
  b.setAttribute("aria-pressed", String(on)); b.title = on ? "Exit full screen (Esc)" : "Expand";
  b.setAttribute("aria-label", on ? "Exit full screen" : "Expand the Compass");
  b.innerHTML = on ? ICO_MIN : ICO_MAX;
}
// anade un ticker a la lista del usuario desde el buscador del Compass
function cmpAdd(v) {
  v = v.trim().toUpperCase().replace(/[-/]/g, ".");
  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(v)) return;
  const w = watchlist();
  if (!w.includes(v)) { w.push(v); saveWatch(w); scanState.tries = 0; }
  cmp.find = ""; $("cFind").value = "";
  loadCompass(true);
}

function cmpTrail(r) {
  const n = +state.cmpTrail || 0;
  return n && r.trail ? r.trail.filter((t) => t.x != null && t.y != null).slice(-n) : [];
}

function compassTip(e) {
  if (!cmp.geo) return;
  const rect = $("compass").getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  let best = null, bd = 14;
  for (const g of cmp.geo) { const dd = Math.hypot(g.x - x, g.y - y); if (dd < bd) { bd = dd; best = g; } }
  const tip = $("ctip");
  if (!best) { tip.hidden = true; return; }
  const r = best.r;
  // comparacion con el inicio de la estela: si la volatilidad esta mas cara o mas barata que hace unos dias
  const ago = (x) => {
    const p = cmpTrail(x)[0]; if (!p) return "";
    const d = new Date(p.date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const ch = (a, b) => `${fmtNum(a, 0)} → ${fmtNum(b, 0)} <span style="color:var(--muted);font-weight:400">(${b - a >= 0 ? "+" : "−"}${fmtNum(Math.abs(b - a), 0)})</span>`;
    return `<div class="r">Since ${d}, IV rank <b>${ch(p.y, x.y)}</b></div><div class="r">Since ${d}, RR rank <b>${ch(p.x, x.x)}</b></div>`;
  };
  tip.innerHTML = `<div class="t">${esc(r.symbol)} <span style="color:var(--muted);font-weight:400">${esc(r.name || "")}</span></div>
    <div class="r">30-day IV <b>${r.iv30 != null ? fmtNum(r.iv30 * 100, 1) + "%" : "—"}</b></div>
    <div class="r">20d realized vol <b>${r.rv20 != null ? fmtNum(r.rv20 * 100, 1) + "%" : "—"}</b></div>
    <div class="r">IV / realized <b>${r.vrp != null ? fmtNum(r.vrp, 2) : "—"}</b></div>
    <div class="r">Risk reversal 25Δ <b>${r.rr25 != null ? (r.rr25 > 0 ? "+" : "−") + fmtNum(Math.abs(r.rr25 * 100), 1) + " pts" : "—"}</b></div>
    <div class="r">IV rank <b>${fmtNum(r.y, 0)} ${r.y_src === "provisional" ? "(provisional)" : r.y_src === "propio" ? "(own history)" : `(${r.y_src}, 1 year)`}</b></div>
    <div class="r">RR rank <b>${fmtNum(r.x, 0)} ${r.x_src === "provisional" ? "(provisional)" : "(own history)"}</b></div>
    ${r.vol_index ? `<div class="r">${r.vol_index.index} <b>${fmtNum(r.vol_index.value, 2)} (range ${fmtNum(r.vol_index.lo, 1)}–${fmtNum(r.vol_index.hi, 1)})</b></div>` : ""}
    ${ago(r)}
    <div class="r">Saved history <b>${r.days}/${cmp.data.min_days} sessions</b></div>`;
  tip.hidden = false;
  let tx = x + 16, ty = y - tip.offsetHeight - 10;
  if (tx + tip.offsetWidth > rect.width - 8) tx = x - tip.offsetWidth - 16;
  if (ty < 0) ty = y + 16;
  // el tooltip cuelga del recuadro (cabecera incluida), no del grafico
  const pr = tip.offsetParent ? tip.offsetParent.getBoundingClientRect() : rect;
  tip.style.left = tx + rect.left - pr.left + "px"; tip.style.top = ty + rect.top - pr.top + "px";
}

function bindCompassSide() {
  // el grafico se dibuja a la medida exacta del recuadro: si el recuadro cambia, se vuelve a dibujar
  if (window.ResizeObserver) {
    let raf = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const el = $("compass");
        if (!cmp.data || !el.offsetParent) return;
        if (cmp.size !== `${Math.max(360, el.clientWidth)}x${Math.max(420, el.clientHeight)}`) renderCompass();
      });
    }).observe($("compass"));
  }
  $("cFind").addEventListener("input", (e) => { cmp.find = e.target.value; renderCside(); });
  $("cFind").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { const b = $("cBody").querySelector("[data-add]"); if (b) cmpAdd(b.dataset.add); }
  });
  syncTrail();
  $("trailMenu").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-k]"); if (!b) return;
    state.cmpTrail = b.dataset.v; store.set("cmpTrail", b.dataset.v);
    $("trailMenu").hidden = true; $("trailBtn").setAttribute("aria-expanded", "false");
    syncTrail(); renderCompass();
  });
  $("cmpMax").addEventListener("click", () => cmpMax(!$("cgrid").classList.contains("max")));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("cgrid").classList.contains("max") && $("trailMenu").hidden) cmpMax(false); }, true);
  $("cBody").addEventListener("click", (e) => {
    const ad = e.target.closest("[data-add]"); if (ad) { cmpAdd(ad.dataset.add); return; }
    const tr = e.target.closest("tr[data-s]"); if (!tr) return;
    const h = cmpHidden(), s = tr.dataset.s;
    if (h.has(s)) h.delete(s); else h.add(s);
    setCmpHidden(h);
  });
  $("cShowAll").addEventListener("click", () => {
    const h = cmpHidden(); const q = cmp.find.trim().toUpperCase();
    (cmp.data ? cmp.data.rows : []).forEach((r) => { if (!q || r.symbol.includes(q)) h.delete(r.symbol); });
    setCmpHidden(h);
  });
  $("cHideAll").addEventListener("click", () => {
    const h = cmpHidden(); const q = cmp.find.trim().toUpperCase();
    (cmp.data ? cmp.data.rows : []).forEach((r) => { if (!q || r.symbol.includes(q)) h.add(r.symbol); });
    setCmpHidden(h);
  });
}

function bindScanner() {
  bindCompassSide();
  $("svTable").addEventListener("click", () => setScanView("table"));
  $("svCompass").addEventListener("click", () => setScanView("compass"));
  $("svValid").addEventListener("click", () => setScanView("valid"));
  bindSeg("validModeSeg", "validMode", loadValidation);
  $("compass").addEventListener("mousemove", compassTip);
  $("compass").addEventListener("mouseleave", () => { $("ctip").hidden = true; });
  $("compass").addEventListener("click", (e) => {
    const g = e.target.closest(".cpt"); if (!g) return;
    $("symbol").value = g.dataset.s; $("spotInput").value = "";
    setMode("analysis"); load();
  });
  $("modeAnalysis").addEventListener("click", () => setMode("analysis"));
  $("modeScanner").addEventListener("click", () => setMode("scanner"));
  $("modeVix").addEventListener("click", () => setMode("vix"));
  $("modeSummary").addEventListener("click", () => setMode("summary"));
  bindSummary();
  $("modeCot").addEventListener("click", () => setMode("cot"));
  bindMacro();
  $("scanBtn").addEventListener("click", () => (state.scanView === "compass" ? loadCompass(true) : state.scanView === "valid" ? loadValidation() : runScan()));
  bindSeg("regimeSeg", "regimeFilter", renderScan);
  $("addForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $("addInput").value.trim().toUpperCase().replace(/[-/]/g, ".");
    if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(v)) return;
    const w = watchlist();
    if (!w.includes(v)) { w.push(v); saveWatch(w); scanState.tries = 0; }
    $("addInput").value = "";
    if (state.scanView === "compass") loadCompass(true); else runScan();
  });
  $("scanTable").querySelector("thead").addEventListener("click", (e) => {
    const th = e.target.closest("th[data-k]"); if (!th) return;
    const k = th.dataset.k;
    if (scanState.sortK === k) scanState.sortDir *= -1; else { scanState.sortK = k; scanState.sortDir = k.endsWith("_dist") || k === "symbol" || k === "regime" ? 1 : -1; }
    renderScan();
  });
  $("scanBody").addEventListener("click", (e) => {
    const rm = e.target.closest("[data-rm]");
    if (rm) {
      e.stopPropagation();
      const w = watchlist().filter((x) => x !== rm.dataset.rm);
      saveWatch(w);
      scanState.rows = scanState.rows.filter((x) => x.symbol !== rm.dataset.rm);
      scanState.loadedFor = w.join(",") + "|" + state.dte;
      renderScan();
      return;
    }
    const tr = e.target.closest("tr[data-s]"); if (!tr) return;
    $("symbol").value = tr.dataset.s; $("spotInput").value = "";
    setMode("analysis"); load();
  });
}

/* ============================================================ curva VIX */
const vx = { data: null, at: 0, ctrl: null, curveGeo: null, histGeo: null };
function monLabel(iso) { return MESES[+iso.slice(5, 7) - 1] + " " + iso.slice(2, 4); }
function sgnPct(v, dec = 1) { return v == null || !isFinite(v) ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "") + fmtNum(Math.abs(v * 100), dec) + "%"; }
function longDate(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long" });
}
const _measure = document.createElement("canvas").getContext("2d");
// ancho de un texto; img: en las imagenes exportadas (SVG cargado como imagen) no llega la fuente web y el navegador
// dibuja con la de respaldo, asi que se mide con esa
const IMG_SANS = SANS.replace("'Manrope', ", "");
function textW(s, fs, w = 400, img = false) {
  _measure.font = `${w} ${fs}px ${img ? IMG_SANS : SANS}`;
  return _measure.measureText(s).width;
}
// leyenda en linea que salta de fila si no cabe (moviles); alineada a la derecha si cabe en una
function legendRows(items, L, R, y0, fs = 12) {
  const ws = items.map(([lab]) => textW(lab, fs) + 44);
  const total = ws.reduce((a, b) => a + b, 0);
  let out = "", x = total <= R - L ? R - total : L, y = y0;
  items.forEach(([lab, c, da], k) => {
    if (x + ws[k] > R + 4 && x > L) { x = L; y += fs + 8; }
    out += `<line x1="${x}" x2="${x + 18}" y1="${y}" y2="${y}" stroke="${c}" stroke-width="2.2"${da ? ` stroke-dasharray="${da}"` : ""}/>` + txt(x + 24, y + 4, lab, { fs, c: C.muted });
    x += ws[k];
  });
  return out;
}
function txt(x, y, s, o = {}) {
  return `<text x="${x}" y="${y}" text-anchor="${o.a || "start"}" font-family="${o.mono ? MONO : SANS}" font-size="${o.fs || 12}" fill="${o.c || C.faint}"${o.w ? ` font-weight="${o.w}"` : ""}>${s}</text>`;
}
function macroTip(tipId, wrapEl, e, html) {
  const tip = $(tipId);
  if (!html) { tip.hidden = true; return; }
  tip.innerHTML = html; tip.hidden = false;
  const pr = tip.offsetParent.getBoundingClientRect();
  let tx = e.clientX - pr.left + 16, ty = e.clientY - pr.top - tip.offsetHeight - 10;
  if (tx + tip.offsetWidth > pr.width - 8) tx = e.clientX - pr.left - tip.offsetWidth - 16;
  if (ty < 4) ty = e.clientY - pr.top + 16;
  tip.style.left = tx + "px"; tip.style.top = ty + "px";
}
function vixStatus() {
  const d = vx.data;
  if (!d) return "";
  const t = d.term_time ? `, indices ${hhmm(utcDate(d.term_time))}` : "";
  return `Close ${ddmm(d.date)}${t}`;
}

async function loadVix(refresh = false) {
  if (vx.ctrl) vx.ctrl.abort();
  vx.ctrl = new AbortController();
  $("refreshBtn").classList.add("spin");
  setStatus("busy", "Loading the VIX curve…");
  if (!vx.data) $("vxCurve").innerHTML = `<div class="empty">Downloading VIX futures from CBOE. The first time takes a few seconds.</div>`;
  try {
    const r = await fetch("/api/vix" + (refresh ? "?refresh=1" : ""), { signal: vx.ctrl.signal });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Could not load the curve");
    vx.data = d; vx.at = Date.now();
    if (state.mode === "vix") { renderVix(); setStatus("", vixStatus()); }
  } catch (e) {
    if (e.name === "AbortError") return;
    if (state.mode === "vix") {
      setStatus("err", vx.data ? "Could not refresh" : "No data");
      if (!vx.data) $("vxCurve").innerHTML = `<div class="empty">${esc(e.message === "Failed to fetch" ? "The local server is not responding. Open GEX Lab again." : e.message)}</div>`;
    }
  } finally { $("refreshBtn").classList.remove("spin"); }
}

const SHAPE_CLASS = { contango: "contango", backwardation: "backwardation", front_inverted: "mixed", hump: "mixed", flat: "mixed" };
const SHAPE_COLOR = (code) => ({ contango: C.put, backwardation: C.call }[code] || C.amber);
const SHAPE_LABEL = { contango: "Contango", backwardation: "Backwardation", front_inverted: "Inverted front end", hump: "Front-end hump", flat: "Flat" };

function renderVix() {
  const d = vx.data;
  if (!d) return;
  // con la sesion abierta, el panel usa la curva de hoy (implicita en las opciones); si no, el cierre oficial
  const lv = d.live && d.live.m1 != null ? d.live : null;
  const v = lv || d;
  const sh = v.shape.code;
  const m1x = lv ? { expiry: lv.m1_exp, days: lv.m1_days } : d.points[0], m2x = lv ? { expiry: lv.m2_exp, days: lv.m2_days } : d.points[1];
  const st = $("vxState");
  st.textContent = SHAPE_LABEL[sh] || v.shape.label; st.className = "mstate " + SHAPE_CLASS[sh];
  $("vxSub").textContent = lv ? `Live ${hhmm(utcDate(lv.time))}, implied by VIX options` : `Official close, ${longDate(d.date)}`;
  const spr = `<b>${sgnPct(v.spread)}</b>`, bas = `<b>${sgnPct(v.basis)}</b>`;
  const reads = {
    contango: `The second expiration trades ${spr} over the first, and the first ${bas} over the VIX. Normal structure: the market isn't pricing immediate stress and futures tend to converge down toward the VIX.`,
    backwardation: `The first expiration trades above the second (${spr}) and the VIX above the first. Immediate protection costs more than protection further out: the signature of stress episodes. A return to contango usually comes with normalization.`,
    front_inverted: `Spot VIX is above the first future (${bas}), but the curve rises again after it (${spr}). Very short-term stress that the market expects to ease.`,
    hump: `The first future is above the VIX (${bas}) and above the second (${spr}). The market concentrates risk in the next expiration: it usually reflects a specific event in that window (elections, the Fed, data).`,
    flat: `The VIX, the first and the second expiration are within ${fmtNum((d.flat_tol || 0.005) * 100, 1)}% of each other (${bas} and ${spr}). Flat curve: a transition between regimes; watch which way it resolves.`,
  };
  $("vxRead").innerHTML = reads[sh];
  const live = (d.term || []).find((t) => t.symbol === "VIX");
  const ratio = d.vix_vix3m;
  const fact = (l, v, s, warn, g) => `<div class="fact"><span class="fl"${g ? ` data-g="${g}"` : ""}>${l}</span><strong>${v}</strong><span class="fs${warn ? " warn" : ""}">${s}</span></div>`;
  $("vxFacts").innerHTML = [
    lv && lv.vix ? fact("VIX", fmtNum(lv.vix, 2), `now (close ${fmtNum(d.vix_close, 2)})`, false, "vix")
      : fact("VIX", fmtNum(d.vix_close, 2), live && Math.abs(live.value - d.vix_close) > 0.005 ? `at the close (now ${fmtNum(live.value, 2)})` : "at the close", false, "vix"),
    fact(`M1 ${monLabel(m1x.expiry)}`, fmtNum(v.m1, 2), `${m1x.days} days, ${sgnPct(v.basis)} over the VIX`, false, "m1"),
    fact(`M2 ${monLabel(m2x.expiry)}`, fmtNum(v.m2, 2), `${m2x.days} days`, false, "m2"),
    fact("M2 / M1 slope", sgnPct(v.spread), `${ordinal(v.spread_pct_rank)} percentile of the last year`, false, "slope"),
    fact("30-day future", fmtNum(v.cm30, 2), "interpolated between expirations", false, "cm30"),
    fact("VIX / VIX3M", ratio ? fmtNum(ratio, 2) : "—", ratio ? (ratio >= 1 ? "above 1: short-term stress" : "below 1: normal structure") : "no data", ratio >= 1, "vix3m"),
    fact("Streak", `${v.streak} ${v.streak === 1 ? "session" : "sessions"}`, `${lv ? "counting today, " : ""}in ${v.streak_contango ? "contango" : "backwardation"} (M2/M1), ${fmtNum(d.contango_share * 100, 0)}% of the year in contango`, false, "streak"),
  ].join("");
  const idx = d.term_live === false ? "at the close (market closed)" : "live (15 min)";
  const lvNote = d.live ? " Today: each future implied by VIX options (put-call parity) until the settlement is published; small points, weekly expirations." : "";
  $("vxCap").textContent = `Official CBOE settlements. VIX9D to VIX1Y indices ${idx}. Hollow points: expirations with fewer than 1,000 open contracts.${lvNote}`;
  renderVixCurve();
  renderVixHist();
}

function interpAt(arr, days) {
  for (let k = 1; k < arr.length; k++) {
    const a = arr[k - 1], b = arr[k];
    if (a.days <= days && days <= b.days) return a.v + (b.v - a.v) * (days - a.days) / Math.max(1e-9, b.days - a.days);
  }
  return null;
}
function renderVixCurve() {
  const d = vx.data, el = $("vxCurve");
  const W = Math.max(300, el.clientWidth), H = Math.max(240, el.clientHeight);
  const pad = { l: 52, r: 22, t: W < 640 ? 54 : 34, b: 34 };
  const L = pad.l, R = W - pad.r, T = pad.t, B = H - pad.b;
  const series = (c) => (c ? [...(c.vix ? [{ days: 0, v: c.vix }] : []), ...c.points.map((x) => ({ days: x.days, v: x.settle }))] : []);
  const today = [{ days: 0, v: d.vix_close, spot: true }, ...d.points.map((x) => ({ days: x.days, v: x.settle, x }))];
  const prev = series(d.prev), week = series(d.week);
  const term = (d.term || []).map((t) => ({ days: t.days, v: t.value, sym: t.symbol }));
  const xlim = Math.max(...[...today, ...term].map((x) => x.days));
  // curva de la sesion en curso, implicita en las opciones del VIX (hasta que CBOE publique la liquidacion)
  const live = d.live ? [...(d.live.vix ? [{ days: 0, v: d.live.vix, spot: true }] : []),
    ...d.live.points.filter((x) => x.days <= xlim).map((x) => ({ days: x.days, v: x.price, lx: x }))] : [];
  // con la sesion abierta, la curva de hoy (en directo) es la principal y el ultimo cierre oficial, la sesion anterior
  const isLive = live.length > 0;
  const main = isLive ? live : today;
  const prevLine = isLive ? today : prev;
  const prevLab = isLive ? `Previous session (${ddmm(d.date)})` : d.prev ? `Previous session (${ddmm(d.prev.date)})` : "";
  const all = [...today, ...prev, ...week, ...term, ...live].map((x) => x.v).filter((v) => v != null);
  const xmax = xlim * 1.04 + 4;
  const yt = niceTicks(Math.min(...all) - 0.4, Math.max(...all) + 0.4, Math.max(3, Math.round((B - T) / 55)));
  const xOf = (v) => L + (v / xmax) * (R - L), yOf = (v) => B - ((v - yt.lo) / (yt.hi - yt.lo)) * (B - T);
  let s = "";
  for (const v of yt.ticks) {
    s += `<line x1="${L}" x2="${R}" y1="${yOf(v)}" y2="${yOf(v)}" stroke="${C.grid}"/>`;
    s += txt(L - 8, yOf(v) + 4, fmtNum(v, v % 1 ? 1 : 0), { a: "end", mono: true, fs: 11.5 });
  }
  // eje x: contado y meses de cada vencimiento
  s += txt(xOf(0), B + 20, "VIX", { a: "middle", fs: 11.5 });
  let lastX = xOf(0);
  for (const pt of today.slice(1)) {
    const x = xOf(pt.days);
    if (x - lastX < 38) continue;
    s += `<line x1="${x}" x2="${x}" y1="${B}" y2="${B + 4}" stroke="${C.axis}"/>` + txt(x, B + 20, monLabel(pt.x.expiry), { a: "middle", fs: 11.5 });
    lastX = x;
  }
  s += `<line x1="${L}" x2="${R}" y1="${B}" y2="${B}" stroke="${C.axis}"/>`;
  const path = (arr) => arr.map((q, k) => `${k ? "L" : "M"}${xOf(q.days).toFixed(1)},${yOf(q.v).toFixed(1)}`).join("");
  if (week.length) s += `<path d="${path(week)}" fill="none" stroke="${C.faint}" stroke-width="1.4" stroke-dasharray="2 4"/>`;
  if (prevLine.length) s += `<path d="${path(prevLine)}" fill="none" stroke="${C.muted}" stroke-width="1.6" stroke-opacity="0.75"/>`;
  if (term.length) {
    s += `<path d="${path(term)}" fill="none" stroke="${C.purple}" stroke-width="1.5" stroke-opacity="0.85"/>`;
    for (const q of term) {
      s += `<rect x="${xOf(q.days) - 3.5}" y="${yOf(q.v) - 3.5}" width="7" height="7" rx="1.5" fill="${C.surface}" stroke="${C.purple}" stroke-width="1.5"/>`;
      if (q.sym !== "VIX") {
        const fut = interpAt(main, q.days);
        const above = fut == null || q.v >= fut;
        s += txt(xOf(q.days), yOf(q.v) + (above ? -10 : 19), q.sym, { a: "middle", fs: 11, c: C.purple });
      }
    }
  }
  const col = SHAPE_COLOR((isLive && d.live.shape ? d.live.shape : d.shape).code);
  s += `<path d="${path(main)}" fill="none" stroke="${col}" stroke-width="2.2"/>`;
  vx.curveGeo = [];
  let lastLab = -1e9;
  main.forEach((q, k) => {
    const x = xOf(q.days), y = yOf(q.v);
    const thin = q.x && q.x.oi < 1000, weekly = q.lx && !q.lx.monthly;
    s += `<circle cx="${x}" cy="${y}" r="${q.spot ? 5 : weekly ? 2.6 : 4}" fill="${thin ? C.surface : col}" stroke="${col}" stroke-width="${thin ? 1.6 : 1}"/>`;
    if (k <= 10 && !weekly && x - lastLab > 34) { s += txt(x, y - 11, fmtNum(q.v, 2), { a: "middle", mono: true, fs: 11.5, c: C.text }); lastLab = x; }
    vx.curveGeo.push(isLive ? { x, y, live: q } : { x, y, q });
  });
  if (isLive) for (const q of today) vx.curveGeo.push({ x: xOf(q.days), y: yOf(q.v), q });   // tooltip del cierre
  for (const q of term) vx.curveGeo.push({ x: xOf(q.days), y: yOf(q.v), term: q });
  // leyenda
  const items = [[isLive ? `Today (live, ${hhmm(utcDate(d.live.time))})` : `Last close (${ddmm(d.date)})`, col, ""], [prevLab, C.muted, ""], ["1 week ago", C.faint, "2 4"], ["VIX9D–VIX1Y indices", C.purple, ""]]
    .filter((it, k) => (k === 1 ? prevLine.length : k === 2 ? week.length : k === 3 ? term.length : true));
  s += legendRows(items, W < 640 ? 8 : L, R, 14);
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${s}</svg>`;
}

function renderVixHist() {
  const d = vx.data, el = $("vxHist"), h = d.history;
  const W = Math.max(320, el.clientWidth), H = Math.max(170, el.clientHeight);
  const pad = { l: 52, r: 46, t: 12, b: 28 };
  const L = pad.l, R = W - pad.r, T = pad.t, B = H - pad.b;
  const sp = h.map((x) => x.spread * 100);
  const yt = niceTicks(Math.min(0, ...sp), Math.max(0, ...sp), Math.max(3, Math.round((B - T) / 42)));
  const vixs = h.map((x) => x.vix).filter((v) => v != null);
  const vt = vixs.length ? niceTicks(Math.min(...vixs), Math.max(...vixs), 4) : null;
  const n = h.length, bw = (R - L) / n;
  const xOf = (i) => L + (i + 0.5) * bw, yOf = (v) => B - ((v - yt.lo) / (yt.hi - yt.lo)) * (B - T);
  const vOf = (v) => B - ((v - vt.lo) / (vt.hi - vt.lo)) * (B - T);
  let s = "";
  for (const v of yt.ticks) {
    s += `<line x1="${L}" x2="${R}" y1="${yOf(v)}" y2="${yOf(v)}" stroke="${v === 0 ? C.axis : C.grid}"/>`;
    s += txt(L - 8, yOf(v) + 4, (v > 0 ? "+" : v < 0 ? "−" : "") + fmtNum(Math.abs(v), 0) + "%", { a: "end", mono: true, fs: 11 });
  }
  const y0 = yOf(0);
  h.forEach((x, i) => {
    const y = yOf(x.spread * 100);
    s += `<rect x="${(L + i * bw).toFixed(2)}" y="${Math.min(y, y0).toFixed(1)}" width="${Math.max(bw - 0.4, 0.8).toFixed(2)}" height="${Math.max(Math.abs(y - y0), 0.8).toFixed(1)}" fill="${Math.abs(x.spread) < (d.flat_tol || 0.005) ? C.muted : x.spread >= 0 ? C.put : C.call}" fill-opacity="0.75"/>`;
  });
  if (vt) {
    const pts = h.map((x, i) => (x.vix != null ? `${xOf(i).toFixed(1)},${vOf(x.vix).toFixed(1)}` : null)).filter(Boolean);
    s += `<polyline points="${pts.join(" ")}" fill="none" stroke="${C.text}" stroke-opacity="0.55" stroke-width="1.2"/>`;
    for (const v of vt.ticks) if (v >= vt.lo && v <= vt.hi) s += txt(R + 8, vOf(v) + 4, fmtNum(v, 0), { mono: true, fs: 11 });
  }
  let prevM = "", lastLab = -1e9;
  h.forEach((x, i) => {
    const m = x.date.slice(0, 7);
    if (m !== prevM && i > 2 && xOf(i) - lastLab >= 30) { s += txt(xOf(i), B + 18, MESES[+m.slice(5) - 1], { a: "middle", fs: 11 }); lastLab = xOf(i); }
    prevM = m;
  });
  vx.histGeo = { L, R, bw, n };
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${s}</svg>`;
}

function vixCurveTip(e) {
  if (!vx.curveGeo) return;
  const rect = $("vxCurve").getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  let best = null, bd = 30;
  for (const g of vx.curveGeo) { const dd = Math.hypot(g.x - x, (g.y - y) * 0.6); if (dd < bd) { bd = dd; best = g; } }
  if (!best) return macroTip("vxTip", null, e, "");
  const d = vx.data;
  let html;
  if (best.live) {
    const q = best.live, c = q.lx;
    const set = c ? d.points.find((z) => z.expiry === c.expiry) : null;
    html = q.spot
      ? `<div class="t">Spot VIX now</div><div class="r">Value <b>${fmtNum(q.v, 2)}</b></div><div class="r">Previous session <b>${fmtNum(d.vix_close, 2)}</b></div>`
      : `<div class="t">${c.monthly ? `${monLabel(c.expiry)} future` : "Weekly expiration"} <span style="color:var(--muted);font-weight:400">expires ${ddmm(c.expiry)}</span></div>
      <div class="r">Implied price now <b>${fmtNum(c.price, 2)}</b></div>
      <div class="r">Days to expiration <b>${c.days}</b></div>
      ${set ? `<div class="r">Previous session <b>${fmtNum(set.settle, 2)}</b></div><div class="r">Change <b>${c.price - set.settle >= 0 ? "+" : "−"}${fmtNum(Math.abs(c.price - set.settle), 2)}</b></div>` : ""}
      <div class="r" style="color:var(--muted)">${c.monthly ? "From VIX options (put-call parity)" : "Weekly VIX options; no monthly future"}</div>`;
  } else if (best.term) {
    const t = d.term.find((z) => z.symbol === best.term.sym);
    html = `<div class="t">${best.term.sym}</div><div class="r">SPX ${best.term.days}-day implied volatility <b>${fmtNum(t.value, 2)}</b></div>` +
      (t.prev ? `<div class="r">Previous close <b>${fmtNum(t.prev, 2)}</b></div>` : "");
  } else if (best.q.spot) {
    html = `<div class="t">Spot VIX</div><div class="r">Close <b>${fmtNum(d.vix_close, 2)}</b></div>` +
      (d.prev && d.prev.vix ? `<div class="r">Previous session <b>${fmtNum(d.prev.vix, 2)}</b></div>` : "") +
      (d.week && d.week.vix ? `<div class="r">1 week ago <b>${fmtNum(d.week.vix, 2)}</b></div>` : "");
  } else {
    const c = best.q.x;
    const old = (b) => (b ? (b.points.find((z) => z.expiry === c.expiry) || {}).settle : null);
    const p = old(d.prev), w = old(d.week);
    html = `<div class="t">${monLabel(c.expiry)} future <span style="color:var(--muted);font-weight:400">expires ${ddmm(c.expiry)}</span></div>
      <div class="r">Settle <b>${fmtNum(c.settle, 2)}</b></div>
      <div class="r">Days to expiration <b>${c.days}</b></div>
      ${p ? `<div class="r">Previous session <b>${fmtNum(p, 2)}</b></div>` : ""}
      ${w ? `<div class="r">1 week ago <b>${fmtNum(w, 2)}</b></div>` : ""}
      <div class="r">Open interest${c.oi_prev ? " (previous session)" : ""} <b>${fmtNum(c.oi)}</b></div>
      <div class="r">Volume <b>${c.vol == null ? "pending" : fmtNum(c.vol)}</b></div>`;
  }
  macroTip("vxTip", null, e, html);
}

function vixHistTip(e) {
  const g = vx.histGeo;
  if (!g) return;
  const rect = $("vxHist").getBoundingClientRect();
  const i = Math.floor((e.clientX - rect.left - g.L) / g.bw);
  if (i < 0 || i >= g.n) return macroTip("vxTip", null, e, "");
  const x = vx.data.history[i];
  const lab = SHAPE_LABEL[x.shape] || x.shape;
  macroTip("vxTip", null, e, `<div class="t">${fullDate(x.date)}</div>
    <div class="r">VIX <b>${x.vix != null ? fmtNum(x.vix, 2) : "—"}</b></div>
    <div class="r">M1 <b>${fmtNum(x.m1, 2)}</b></div><div class="r">M2 <b>${fmtNum(x.m2, 2)}</b></div>
    <div class="r">M2 / M1 <b>${sgnPct(x.spread)}</b></div><div class="r">Shape <b>${lab}</b></div>`);
}

/* ============================================================ COT */
const cot = { data: null, at: 0, sel: store.get("cotSel", "ES"), win: store.get("cotWin", "3y"), hist: {}, ctrl: null, geo: null };
const COT_SHOW = [["asset_mgr", "pos"], ["lev_money", "neg"], ["dealer", "put"]];   // grupo y color del tema
const COT_LABEL = { asset_mgr: "Asset managers", lev_money: "Leveraged funds", dealer: "Dealers", other: "Other reportables", nonrept: "Non-reportables" };
function cotStatus() { return cot.data && cot.data.report_date ? `COT of ${ddmm(cot.data.report_date)}` : ""; }

async function loadCot(refresh = false) {
  if (cot.ctrl) cot.ctrl.abort();
  cot.ctrl = new AbortController();
  $("refreshBtn").classList.add("spin");
  setStatus("busy", "Loading the COT…");
  if (!cot.data) $("cotBody").innerHTML = `<tr class="loading"><td colspan="8" class="l">Downloading the CFTC report…</td></tr>`;
  try {
    const r = await fetch("/api/cot" + (refresh ? "?refresh=1" : ""), { signal: cot.ctrl.signal });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Could not load the COT");
    cot.data = d; cot.at = Date.now();
    if (refresh) cot.hist = {};
    if (state.mode === "cot") { renderCot(); setStatus("", cotStatus()); }
  } catch (e) {
    if (e.name === "AbortError") return;
    if (state.mode === "cot") {
      setStatus("err", cot.data ? "Could not refresh" : "No data");
      if (!cot.data) $("cotBody").innerHTML = `<tr class="err"><td colspan="8" class="l">${esc(e.message === "Failed to fetch" ? "The local server is not responding. Open GEX Lab again." : e.message)}</td></tr>`;
    }
  } finally { $("refreshBtn").classList.remove("spin"); }
}

function cotIdx(g) {
  const v = cot.win === "1y" ? g.index1y : g.index3y;
  if (v == null) return `<span class="cidx"><span class="cbar"></span><b>—</b></span>`;
  const ext = v >= 90 || v <= 10;
  return `<span class="cidx${ext ? " ext" : ""}" title="${ext ? "Extreme for the period" : ""}"><span class="cbar"><i style="left:${v.toFixed(1)}%"></i></span><b>${fmtNum(v, 0)}</b></span>`;
}

function renderCot() {
  const d = cot.data;
  if (!d) return;
  $("cotDate").innerHTML = d.report_date
    ? `Positions as of <b>${longDate(d.report_date)}</b>, published ${longDate(d.release)}`
    : "No report";
  $("cotWinSeg").querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === cot.win)));
  let html = "", grp = "";
  for (const m of d.markets) {
    if (m.group !== grp) { grp = m.group; html += `<tr class="sec"><td colspan="8" class="l">${esc(grp)}</td></tr>`; }
    if (m.error) { html += `<tr class="err"><td class="l"><span class="tk">${esc(m.name)}</span></td><td colspan="7" class="l">${esc(m.error)}</td></tr>`; continue; }
    const cells = COT_SHOW.map(([k]) => {
      const g = m.groups[k];
      const dc = g.chg > 0 ? "up" : g.chg < 0 ? "dn" : "";
      return `<td class="gs" title="Long ${fmtNum(g.long)}, short ${fmtNum(g.short)}, net ${fmtNum(g.net)} (${g.pct_oi != null ? sgnPct(g.pct_oi) : "—"} of open interest)"><span class="lv">${fmtBig(g.net)}</span><span class="dl ${dc}">${g.chg > 0 ? "+" : ""}${fmtBig(g.chg)}</span></td><td class="l">${cotIdx(g)}</td>`;
    }).join("");
    html += `<tr data-k="${m.key}" class="${m.key === cot.sel ? "sel" : ""}"><td class="l"><span class="tk">${esc(m.name)}</span><span class="nm">${esc(m.key)}${m.note ? " (" + esc(m.note) + ")" : ""}</span></td>
      <td><span class="lv">${fmtBig(m.oi)}</span><span class="dl ${m.oi_chg > 0 ? "up" : m.oi_chg < 0 ? "dn" : ""}">${m.oi_chg > 0 ? "+" : ""}${fmtBig(m.oi_chg)}</span></td>${cells}</tr>`;
  }
  $("cotBody").innerHTML = html;
  loadCotHist(cot.sel);
}

async function loadCotHist(key) {
  cot.sel = key; store.set("cotSel", key);
  $("cotBody").querySelectorAll("tr[data-k]").forEach((tr) => tr.classList.toggle("sel", tr.dataset.k === key));
  $("cotDetail").hidden = false;
  if (!cot.hist[key]) {
    $("cotChart").innerHTML = `<div class="empty">Loading…</div>`;
    try {
      const r = await fetch("/api/cot_history?key=" + encodeURIComponent(key));
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      cot.hist[key] = d;
    } catch (e) { $("cotChart").innerHTML = `<div class="empty">${esc(e.message || "No data")}</div>`; return; }
  }
  if (cot.sel === key) renderCotChart();
}

function cotWindow(full) {
  // misma ventana que el índice COT elegido: 3 años o las últimas 52 semanas
  const n = full.dates.length, a = cot.win === "1y" ? Math.max(0, n - 52) : 0;
  const cut = (arr) => arr.slice(a);
  const net = {};
  for (const k in full.net) net[k] = cut(full.net[k]);
  return { ...full, dates: cut(full.dates), oi: cut(full.oi), price: cut(full.price), net };
}

function renderCotChart() {
  const full = cot.hist[cot.sel], el = $("cotChart");
  if (!full || $("cotDetail").hidden) return;
  const h = cotWindow(full);
  const oneY = cot.win === "1y";
  const m = cot.data.markets.find((x) => x.key === cot.sel) || {};
  $("cotTitle").textContent = `${h.name}: net position by group, ${oneY ? "last year" : cot.data.years + " years"}`;
  $("cotCap").textContent = h.price_ref ? `Contracts. ${document.documentElement.dataset.theme === "light" ? "Gray" : "White"} line: ${h.price_ref} at Tuesday's close for each report${/^(SHY|IEI|IEF|TLT|QQQ|IWM|DIA)$/.test(h.price_ref) ? " (reference ETF)" : ""}.` : "Contracts.";
  const W = Math.max(320, el.clientWidth), H = Math.max(260, el.clientHeight);
  const pad = { l: 60, r: h.price_ref ? 58 : 20, t: W < 640 ? 46 : 30, b: 28 };
  const L = pad.l, R = W - pad.r, T = pad.t, B = H - pad.b;
  const n = h.dates.length;
  const vals = COT_SHOW.flatMap(([k]) => h.net[k]);
  const yt = niceTicks(Math.min(0, ...vals), Math.max(0, ...vals), Math.max(3, Math.round((B - T) / 50)));
  const xOf = (i) => L + (i / Math.max(1, n - 1)) * (R - L), yOf = (v) => B - ((v - yt.lo) / (yt.hi - yt.lo)) * (B - T);
  let s = "";
  for (const v of yt.ticks) {
    s += `<line x1="${L}" x2="${R}" y1="${yOf(v)}" y2="${yOf(v)}" stroke="${v === 0 ? C.axis : C.grid}"/>`;
    s += txt(L - 8, yOf(v) + 4, fmtBig(v), { a: "end", mono: true, fs: 11 });
  }
  const pr = h.price.filter((v) => v != null);
  if (pr.length > 2) {
    const pt = niceTicks(Math.min(...pr), Math.max(...pr), 4);
    const pOf = (v) => B - ((v - pt.lo) / (pt.hi - pt.lo)) * (B - T);
    const pts = h.price.map((v, i) => (v != null ? `${xOf(i).toFixed(1)},${pOf(v).toFixed(1)}` : null)).filter(Boolean);
    s += `<polyline points="${pts.join(" ")}" fill="none" stroke="${C.text}" stroke-opacity="0.35" stroke-width="1.2"/>`;
    for (const v of pt.ticks) if (v >= pt.lo && v <= pt.hi) s += txt(R + 8, pOf(v) + 4, fmtSpot(v), { mono: true, fs: 11 });
  }
  for (const [k, ck] of COT_SHOW) {
    const c = C[ck];
    const pts = h.net[k].map((v, i) => `${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`).join(" ");
    s += `<polyline points="${pts}" fill="none" stroke="${c}" stroke-width="1.8"/>`;
    const lv = h.net[k][n - 1];
    s += `<circle cx="${xOf(n - 1)}" cy="${yOf(lv)}" r="3.5" fill="${c}"/>`;
  }
  let prevY = "";
  h.dates.forEach((dt, i) => {
    const y = dt.slice(0, 4), mo = dt.slice(5, 7);
    const show = oneY ? true : mo === "01" || mo === "07";
    if (i > 0 && show && dt.slice(0, 7) !== prevY) s += txt(xOf(i), B + 18, mo === "01" ? y : MESES[+mo - 1], { a: "middle", fs: 11 });
    prevY = dt.slice(0, 7);
  });
  const litems = COT_SHOW.map(([k, ck]) => [COT_LABEL[k] || k, C[ck], ""]);
  const lgW = litems.reduce((a, [lab]) => a + textW(lab, 12) + 44, 0);
  s += lgW <= R - L ? legendRows(litems, L, L + lgW, 12) : legendRows(litems, 8, W - 8, 12);
  cot.geo = { L, R, n, xOf };
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${s}</svg>`;
  if (m.weeks && m.weeks < 52) $("cotCap").textContent += " Short history: the index is unreliable.";
}

function cotTip(e) {
  const g = cot.geo;
  if (!cot.hist[cot.sel] || !g) return;
  const h = cotWindow(cot.hist[cot.sel]);
  const rect = $("cotChart").getBoundingClientRect();
  const i = Math.round(((e.clientX - rect.left - g.L) / (g.R - g.L)) * (g.n - 1));
  if (i < 0 || i >= g.n) return macroTip("cotTip", null, e, "");
  const rows = COT_SHOW.map(([k, ck]) => {
    const lab = COT_LABEL[k], c = C[ck];
    return `<div class="r"><span><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${c};margin-right:6px"></i>${lab}</span><b>${fmtNum(h.net[k][i])}</b></div>`;
  }).join("");
  macroTip("cotTip", null, e, `<div class="t">${fullDate(h.dates[i])}</div>${rows}
    <div class="r">Open interest <b>${fmtNum(h.oi[i])}</b></div>${h.price[i] != null ? `<div class="r">${esc(h.price_ref)} <b>${fmtSpot(h.price[i])}</b></div>` : ""}`);
}

function bindMacro() {
  $("vxCurve").addEventListener("mousemove", vixCurveTip);
  $("vxHist").addEventListener("mousemove", vixHistTip);
  for (const id of ["vxCurve", "vxHist"]) $(id).addEventListener("mouseleave", () => { $("vxTip").hidden = true; });
  $("cotChart").addEventListener("mousemove", cotTip);
  $("cotChart").addEventListener("mouseleave", () => { $("cotTip").hidden = true; });
  $("cotBody").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-k]"); if (tr) loadCotHist(tr.dataset.k); });
  $("cotWinSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    cot.win = b.dataset.v; store.set("cotWin", cot.win); renderCot();
  });
}

/* ============================================================ resumen */
const sm = { data: null, at: 0, ctrl: null };
function sumStatus() { const d = sm.data; return d ? `Summary at ${nyHHMM(d.computed_at)}` : ""; }

async function loadSummary(refresh = false) {
  if (sm.ctrl) sm.ctrl.abort();
  sm.ctrl = new AbortController();
  $("refreshBtn").classList.add("spin");
  setStatus("busy", "Preparing the summary…");
  if (!sm.data) $("sumBody").innerHTML = `<p class="empty">Loading…</p>`;
  try {
    const r = await fetch("/api/summary" + (refresh ? "?refresh=1" : ""), { signal: sm.ctrl.signal });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Could not prepare the summary");
    sm.data = d; sm.at = Date.now();
    if (state.mode === "summary") { renderSummary(); setStatus("", sumStatus()); }
  } catch (e) {
    if (e.name === "AbortError") return;
    if (state.mode === "summary") {
      setStatus("err", sm.data ? "Could not refresh" : "No data");
      if (!sm.data) $("sumBody").innerHTML = `<p class="empty">${esc(e.message === "Failed to fetch" ? "The local server is not responding. Open GEX Lab again." : e.message)}</p>`;
    }
  } finally { $("refreshBtn").classList.remove("spin"); }
}
const SUMMARY_SYMS = ["SPX", "NDX", "RUT"];

function localTime(iso, withDay) {
  const dt = new Date(iso);
  const t = hhmm(dt);
  if (!withDay) return t;
  const today = new Date(); const tm = new Date(Date.now() + 86400000);
  const same = (a, b) => a.toDateString() === b.toDateString();
  const day = same(dt, today) ? "today" : same(dt, tm) ? "tomorrow" : dt.toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long" });
  return `${day} at ${t}`;
}


/* ============================================================ glosario flotante */
const GLOSSARY = {
  lowvol: { t: "Low volatility point", c: "put",
    what: "The price level at which total dealer gamma would peak (the top of the total gamma line).",
    use: "Near this price dealer hedging dampens moves the most: it is where the least realized volatility is expected and where the price tends to settle." },
  highvol: { t: "High volatility point", c: "amber",
    what: "The price level at which total gamma would be most negative (the trough of the total gamma line).",
    use: "Near this price dealer hedging amplifies moves: it is the zone where the most realized volatility is expected." },
  call_wall: { t: "Call Wall", c: "call",
    what: "The strike with the most positive net gamma above the price: the largest concentration of calls, net of the puts at the same strike.",
    use: "Resistance and the ceiling of the expected range. Near it, dealer hedging sells into rallies and slows them down. If the price breaks through it decisively, resistance can turn into support and the ceiling moves to the next strike with calls." },
  put_wall: { t: "Put Wall", c: "put",
    what: "The strike with the most negative net gamma below the price: the largest concentration of puts, net of the calls at the same strike.",
    use: "Support and the floor of the expected range; many hedges are closed there, which tends to slow down selloffs. If it is clearly lost, that support disappears and the drop can accelerate: it is a warning sign, not just a broken technical level." },
  flip: { t: "Gamma Flip (Zero Gamma)", c: "amber",
    what: "The price at which total dealer gamma turns from positive to negative. It is neither support nor resistance: it marks the regime.",
    use: "Above it, dealers buy dips and sell rallies: less volatility and mean reversion. Below it they do the opposite and amplify moves. Very close to the flip (within 0.5%) no clear effect is expected in either direction." },
  vt: { t: "Volatility Trigger", c: "vt",
    what: "The last major support above the Put Wall, on the bearish edge of the Gamma Flip.",
    use: "Below it, dealer hedging stops supporting the price and starts to go with it: realized volatility tends to expand. If you only watch one level, make it this one. Above it, a more stable environment." },
  hedge: { t: "Hedge Wall", c: "vt",
    what: "The equivalent of the Volatility Trigger for single stocks.",
    use: "It marks the point beyond which more realized volatility is expected. Above it mean-reversion strategies tend to work better; below it, momentum. A rise from one day to the next is a bullish sign; a drop, bearish." },
  abs: { t: "Absolute gamma", c: "muted",
    what: "The strike with the most total gamma, adding call and put gamma without sign. It is where the most price-sensitive contracts are.",
    use: "It acts as a magnet: with positive gamma the price tends to stick to it (pinning), especially near expiration. It is also strong support or resistance. It is usually near the flip, not at the edges of the range. If it doesn't show up, it coincides with the Call Wall or the Put Wall." },
  spot: { t: "Price", c: "text",
    what: "The underlying price used to calculate the levels.",
    use: "With the market closed it is the last close. In the SPX, NDX, RUT and DJX pre-market it is estimated from their ETF, and in Settings you can set a manual spot (for example, the one implied by futures)." },
  gex1: { t: "Net GEX per 1%", c: "pos",
    what: "The dollars of underlying that dealers would have to buy or sell to hedge for every 1% the price moves.",
    use: "The sign gives the regime: positive, dealers dampen moves; negative, they amplify them. The size, compared with previous days for the same ticker, shows how much that effect weighs." },
  range1s: { t: "1σ range", c: "text",
    what: "The one standard deviation range priced by options: the price should close inside it 68.3% of the time.",
    use: "To size stops and targets, or place the wings of a short-term iron condor. A close outside the range is an unusual move. The 5-session one is for the week." },
  vanna: { t: "Vanna", c: "text",
    what: "What dealers would buy or sell to hedge if implied volatility drops 1 point.",
    use: "When volatility falls (after an event or during quiet rallies), positive vanna turns into buying: it is one of the engines of rallies after a scare. With negative vanna, falling volatility brings selling." },
  charm: { t: "Charm", c: "text",
    what: "What dealers would buy or sell just from one day passing, without the price moving, because deltas change as expiration approaches.",
    use: "It explains part of the afternoon flows and of expiration weeks. A large positive charm before a monthly expiration tends to provide support." },
  front: { t: "Next-expiration weight", c: "text",
    what: "The share of the filter's total gamma that expires at the next expiration, and the net GEX per 1% that would be left without it.",
    use: "If it is high, the levels will change a lot when it expires: after expiration the walls can move or lose strength. If it is low, the levels are more stable." },
  liq: { t: "Hedging vs. volume", c: "text",
    what: "Dealer hedging for a 1% move as a share of the stock's average daily dollar volume (20 sessions), with the price impact that flow would have by the square-root law. Below, vanna (IV −1 pt) and charm (one day) in the same terms.",
    use: "It makes tickers comparable: the same GEX weighs much more in a thin stock than in a liquid one. A few percent of the volume already moves the price; with positive gamma that pushes against the move (pinning), with negative gamma it adds to it. Not shown for cash indices, which are hedged mostly with futures." },
  buckets: { t: "Gamma by expiration", c: "text",
    what: "How the filter's gamma is split by days to expiration.",
    use: "Gamma that expires soon is the most powerful but disappears fast: if most of it is in 0–7 days, the levels can change a lot within the week. Gamma further out is weaker but more stable." },
  uoa: { t: "Unusual activity", c: "text",
    what: "Contracts whose volume today is above their open interest (at least 100 contracts), sorted by premium traded. Delta $ and vega $ are those of today's whole volume; Bought is the share of the classified volume estimated as customer buying.",
    use: "Volume above open interest means most of it is new positioning, not closing. Large premium in short-dated out-of-the-money contracts is the classic sign of a directional bet; the same in long-dated in-the-money contracts is often a stock replacement or a roll." },
  corr: { t: "Implied correlation", c: "text",
    what: "CBOE index (COR) of how much the 50 largest S&P 500 stocks are expected to move together over the period, derived from the implied volatility of the index against that of its components. 0 means independent, 100 means they move as one.",
    use: "Low correlation: stocks move on their own stories and their moves cancel out, which keeps index volatility contained; it is a fragile calm, because a macro shock lifts correlation and index volatility at once. High correlation: a block market, macro or risk-off, where the index carries the risk." },
  dspx: { t: "Dispersion (DSPX)", c: "text",
    what: "CBOE index of the expected dispersion of the S&P 500 components over the next 30 days: how far apart their returns are expected to be.",
    use: "High dispersion with low correlation is a stock-picker's market: big single-stock moves (earnings, themes) under a quiet index. When dispersion falls and correlation rises, the market starts trading as a block." },
  scen: { t: "Scenarios", c: "text",
    what: "Net GEX per 1% and dealer hedge flow if the price moved (rows) and implied volatility shifted in parallel (columns). Hedge flow is what dealers would buy (+) or sell (−) to stay hedged on the way there.",
    use: "It shows where the regime flips and how big the forced flows would be: for example a drop with rising IV in negative gamma. The highlighted cell is today. Same dealer convention as the rest of the panel." },
  vix: { t: "VIX", c: "text",
    what: "The 30-day implied volatility of the S&P 500.",
    use: "It is the starting point of the curve: futures are compared with it to see whether the market expects more or less volatility than now." },
  m1: { t: "M1 (front future)", c: "text",
    what: "The VIX future that expires first: what the market pays today for that month's volatility.",
    use: "Above the VIX (positive premium) is normal; below it, there is immediate stress. The premium unwinds as the future converges to the VIX at expiration." },
  m2: { t: "M2 (second future)", c: "text",
    what: "The VIX future for the month after M1.",
    use: "Comparing it with M1 gives the slope of the front end, the classic reference for contango and backwardation." },
  slope: { t: "M2 / M1 slope", c: "text",
    what: "How far the second future trades above (contango) or below (backwardation) the first.",
    use: "Positive and wide: a calm market, and volatility sellers get paid to hold the position. Negative: stress. The percentile shows whether today's value is usual for the last year." },
  cm30: { t: "30-day future", c: "text",
    what: "A synthetic future with a fixed 30-day maturity, comparable with the VIX day by day.",
    use: "It avoids the jumps caused by the M1 roll as each contract expires. If it is above the VIX, the structure is normal." },
  vix3m: { t: "VIX / VIX3M", c: "text",
    what: "30-day implied volatility versus 3-month implied volatility.",
    use: "Below 1, normal structure. Above 1, the market pays more for immediate protection than for protection further out: a classic stress signal, and its return below 1 usually marks normalization." },
  streak: { t: "Streak", c: "text",
    what: "How many consecutive sessions the M2/M1 slope has kept the same sign.",
    use: "A long contango streak that breaks is an early warning of a regime change. Together with the share of the year in contango, it shows whether the current situation is exceptional." },
  asset_mgr: { t: "Asset managers", c: "pos",
    what: "Pension funds, mutual funds, insurers. Real money with long horizons.",
    use: "Their positions change slowly and follow the underlying trend. In indices they are usually long; trend changes in their net matter more than the level." },
  lev_money: { t: "Leveraged funds", c: "neg",
    what: "Hedge funds and CTAs: the speculative money.",
    use: "They follow trends and move fast. At the extremes of their range they are usually read as a contrarian signal: when everyone is on the same side, there is little fuel left. In bonds they are structurally short because of the basis trade." },
  dealer: { t: "Dealers", c: "put",
    what: "Banks and market makers.",
    use: "They are usually on the other side of their clients, so their position mirrors everyone else's. It helps confirm what asset managers and funds are doing." },
  cot_index: { t: "COT index", c: "amber",
    what: "Where the current net position sits within its range for the chosen period: 0 is the shortest, 100 the longest.",
    use: "Compare each group with itself, not by its sign. Above 90 or below 10 is an extreme: crowded positioning, often ahead of reversals." },
};
const GL_DELAY = 1500;
const gl = { timer: null, el: null };

function glossaryInit() {
  const card = document.createElement("div");
  card.className = "glcard"; card.id = "glcard"; card.hidden = true;
  card.setAttribute("role", "tooltip");
  document.body.appendChild(card);
  document.addEventListener("mouseover", (e) => {
    const t = e.target.closest("[data-g]");
    if (t === gl.el) return;
    glossaryHide();
    if (!t || !GLOSSARY[t.dataset.g]) return;
    gl.el = t;
    t.classList.add("glwait");
    gl.timer = setTimeout(() => glossaryShow(t.dataset.g), GL_DELAY);
  });
  document.addEventListener("scroll", glossaryHide, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") glossaryHide(); });
  document.addEventListener("mousedown", glossaryHide);
}
function glossaryShow(k) {
  const g = GLOSSARY[k], card = $("glcard");
  card.innerHTML = `<div class="glt"><i style="background:${C[g.c]}"></i>${esc(g.t)}</div>
    <p class="glw">${esc(g.what)}</p>
    <div class="gls">How to use it</div><p>${esc(g.use)}</p>`;
  card.hidden = false;
  requestAnimationFrame(() => card.classList.add("on"));
}
function glossaryHide() {
  clearTimeout(gl.timer);
  if (gl.el) gl.el.classList.remove("glwait");
  gl.el = null;
  const card = $("glcard");
  if (card) { card.classList.remove("on"); card.hidden = true; }
}

/* ============================================================ barra lateral y tema */
const NAV = {
  navSummary: { t: "Summary", go: () => setMode("summary") },
  navTrace: { t: "TRACE", go: () => { setMode("analysis"); if (state.view !== "map") setView("map"); } },
  navHub: { t: "Equity Hub", go: () => { setMode("analysis"); if (state.view === "map") setView(state.hubView || "impact"); } },
  navVol: { t: "Volatility dashboard", go: () => setMode("vol") },
  navVix: { t: "VIX curve", go: () => setMode("vix") },
  navCorr: { t: "Correlation", go: () => setMode("corr") },
  navScan: { t: "Scanner", go: () => { setMode("scanner"); setScanView("table"); } },
  navCompass: { t: "Compass", go: () => { setMode("scanner"); setScanView("compass"); } },
  navValid: { t: "Validation", go: () => { setMode("scanner"); setScanView("valid"); } },
  navCot: { t: "COT", go: () => setMode("cot") },
  navOI: { t: "Open Interest", go: () => setMode("oi") },
  navFlow: { t: "Options flow", go: () => setMode("flow") },
  navLab: { t: "Options Lab", go: () => setMode("lab") },
};
function currentNav() {
  const m = state.mode;
  if (m === "summary") return "navSummary";
  if (m === "analysis") return state.view === "map" ? "navTrace" : "navHub";
  if (m === "vol") return "navVol";
  if (m === "vix") return "navVix";
  if (m === "corr") return "navCorr";
  if (m === "cot") return "navCot";
  if (m === "oi") return "navOI";
  if (m === "flow") return "navFlow";
  if (m === "lab") return "navLab";
  if (m === "scanner") return state.scanView === "compass" ? "navCompass" : state.scanView === "valid" ? "navValid" : "navScan";
  return "navHub";
}
function syncNav() {
  const id = currentNav();
  for (const k of Object.keys(NAV)) { const b = $(k); if (b) { if (k === id) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); } }
  const b = $(id), pt = $("pageTitle");
  if (pt && b) { pt.innerHTML = b.querySelector("svg").outerHTML + `<span>${esc(NAV[id].t)}</span>`; document.title = `${NAV[id].t} - GEX Lab`; }
}
function applyTheme(t) {
  t = t === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem("gexlab.theme", t); } catch { /* sin almacenamiento */ }
  Object.assign(C, THEMES[t]);
  const lbl = $("themeLbl"); if (lbl) lbl.textContent = t === "dark" ? "Light theme" : "Dark theme";
  const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.setAttribute("content", C.ink);
  state.heatImg = null;
  redrawAll();
}
function redrawAll() {
  if (state.mode === "analysis") draw();
  else if (state.mode === "scanner" && state.scanView === "compass" && typeof renderCompass === "function") renderCompass();
  else if (state.mode === "vix" && vx.data) renderVix();
  else if (state.mode === "cot" && cot.data) renderCot();
  else if (state.mode === "summary" && sm.data) renderSummary();
  else if (state.mode === "vol" && typeof renderVol === "function") renderVol();
  else if (TOOLS[state.mode]) TOOLS[state.mode].render();
}
function shellInit() {
  for (const [id, n] of Object.entries(NAV)) {
    const b = $(id); if (!b) continue;
    b.addEventListener("click", () => { document.body.classList.remove("side-open"); n.go(); });
  }
  $("themeBtn").addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"));
  $("themeLbl").textContent = document.documentElement.dataset.theme === "light" ? "Dark theme" : "Light theme";
  const setMin = (on) => { document.body.classList.toggle("side-min", on); try { localStorage.setItem("gexlab.sidemin", on ? "1" : "0"); } catch { /* */ } };
  try { setMin(localStorage.getItem("gexlab.sidemin") === "1"); } catch { /* */ }
  $("sideMin").addEventListener("click", () => { setMin(!document.body.classList.contains("side-min")); setTimeout(redrawAll, 220); });
  $("burger").addEventListener("click", () => document.body.classList.add("side-open"));
  $("sideBack").addEventListener("click", () => document.body.classList.remove("side-open"));
  if (ME) {
    $("whoBox").hidden = false; $("whoName").textContent = ME.user; $("whoAv").textContent = (ME.user || "?").slice(0, 1);
    $("logoutNav").hidden = false;
    $("logoutNav").addEventListener("click", () => $("logoutBtn").click());
    if (ME.admin && ME.nube) { $("usersNav").hidden = false; $("usersNav").addEventListener("click", () => { location.href = "/admin"; }); }
  }
  syncNav();
}

/* ============================================================ arranque */
async function init() {
  shellInit();
  glossaryInit();
  if (ME) {
    $("userBox").hidden = false;
    $("userName").textContent = ME.user;
    $("logoutBtn").addEventListener("click", async () => {
      await fetch("/api/logout", { method: "POST" }).catch(() => {});
      location.replace("/login.html");
    });
  }
  await initWatchlist();
  $("symbol").value = state.symbol;
  bindSearch();
  $("tickerForm").addEventListener("submit", (e) => { e.preventDefault(); load(); });
  $("quick").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    $("symbol").value = b.dataset.s; $("spotInput").value = ""; load();
  });
  bindDte(() => { renderChips(); return state.mode === "scanner" ? runScan() : load(); });
  bindPopovers();
  $("levelsTg").addEventListener("click", () => setChoose("showLevels"));
  $("chartSet").addEventListener("click", (e) => {
    const i = e.target.closest(".cs-i");
    if (i) { const p = $(i.dataset.i); p.hidden = !p.hidden; i.setAttribute("aria-expanded", String(!p.hidden)); return; }
    const b = e.target.closest("button[data-k]");
    if (b && !b.disabled) setChoose(b.dataset.k, b.dataset.v);
  });
  bindSeg("posSeg", "pos", () => { renderChips(); load(); });
  bindSeg("modelSeg", "model", () => { state.heat = null; renderChips(); load(); });
  $("comboToggle").addEventListener("click", () => { state.combo = !state.combo; store.set("combo", state.combo ? "1" : "0"); syncCombo(); load(); });
  $("settingsBtn").addEventListener("click", (e) => { e.stopPropagation(); toggleSettings(); });
  $("settingsPanel").addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => toggleSettings(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") toggleSettings(false); });
  $("chips").addEventListener("click", (e) => { const b = e.target.closest("button[data-k]"); if (b) clearChip(b.dataset.k); });
  $("spotInput").addEventListener("input", renderChips);
  $("autoToggle").addEventListener("click", () => setAuto(!state.auto));
  if (store.get("autoOn", "1") === "1") setAuto(true, true);
  $("reportBtn").addEventListener("click", exportReport);
  bindScanner();
  bindSeg("rangeSeg", "range", () => { $("rangeInput").value = ""; syncRange(); load(); });
  const applyRange = () => {
    const v = parseFloat($("rangeInput").value.replace(",", "."));
    if (!isFinite(v)) { syncRange(); return; }
    const c = Math.min(75, Math.max(0.3, v));
    state.range = String(c); store.set("range", state.range);
    syncRange(); load();
  };
  $("rangeInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); applyRange(); $("rangeInput").blur(); } });
  $("rangeInput").addEventListener("change", applyRange);
  syncRange();
  $("spotInput").addEventListener("keydown", (e) => { if (e.key === "Enter") load(); });
  $("spotInput").addEventListener("change", () => load());
  $("refreshBtn").addEventListener("click", () => {
    if (state.mode === "summary") return loadSummary(true);
    if (state.mode === "vix") return loadVix(true);
    if (state.mode === "cot") return loadCot(true);
    if (state.mode === "vol") return loadVol(true);
    if (TOOLS[state.mode]) return TOOLS[state.mode].load(true);
    if (state.mode !== "scanner") return load(true);
    if (state.scanView === "compass") loadCompass(true); else if (state.scanView === "valid") loadValidation(); else runScan();
  });
  $("tabImpact").addEventListener("click", () => setView("impact"));
  $("tabStrike").addEventListener("click", () => setView("strike"));
  $("tabHistory").addEventListener("click", () => setView("history"));
  $("tabProfile").addEventListener("click", () => setView("profile"));
  $("tabMap").addEventListener("click", () => setView("map"));
  $("copyBtn").addEventListener("click", copyPNG);
  $("tvBtn").addEventListener("click", copyTV);
  $("chart").addEventListener("mousemove", onMove);
  $("chart").addEventListener("mouseleave", hideTip);
  // zoom vertical del mapa: arrastrar arriba o abajo sobre el mapa; doble clic para volver
  $("chart").addEventListener("mousedown", mapZoomStart);
  $("chart").addEventListener("dblclick", () => { if (state.view === "map" && state.mapZoom) { state.mapZoom = null; draw(); } });
  $("zoomReset").addEventListener("click", () => { state.mapZoom = null; draw(); });
  $("bars0Tg").addEventListener("click", () => setChoose("mapBars0"));
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement.tagName !== "INPUT") { e.preventDefault(); $("symbol").select(); }
  });
  let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => {
    draw();
    if (state.mode === "scanner" && state.scanView === "compass") renderCompass();
    if (state.mode === "vix") renderVix();
    if (state.mode === "cot") renderCotChart();
    if (state.mode === "summary") renderSummary();
    if (state.mode === "vol" && typeof renderVol === "function") renderVol();
    if (TOOLS[state.mode]) TOOLS[state.mode].render();
  }, 80); });
  // curva VIX y COT abiertas: se refrescan solas cada 5 min (el servidor solo descarga si hay datos nuevos)
  setInterval(() => {
    if (document.hidden) return;
    if (state.mode === "vix") loadVix(); else if (state.mode === "cot") loadCot(); else if (state.mode === "summary") loadSummary();
  }, 5 * 60 * 1000);
  setView(state.view);
  if (state.mode === "scanner") { load(); setMode("scanner"); } else if (["vix", "cot", "summary", "vol", "risk", "calc", ...Object.keys(TOOLS)].includes(state.mode)) { setMode(state.mode); } else { setMode("analysis"); }
}
// se arranca cuando todos los scripts de la pagina han cargado (hub.js, resumen.js, lab.js... definen partes que init usa)
document.addEventListener("DOMContentLoaded", init);
