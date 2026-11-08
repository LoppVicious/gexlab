"use strict";

/* ============================================================ estado */
// paletas del tema oscuro (por defecto) y claro; C se actualiza al cambiar de tema y se redibuja todo
const THEMES = {
  dark: {
    ink: "#0f0f12", surface: "#16161a", grid: "#232329", axis: "#34343d",
    text: "#f1f1f4", muted: "#a3a3ae", faint: "#6c6c78",
    neg: "#ff2f7c", pos: "#9461ff", negFront: "#ff9cc0", posFront: "#c9b0ff", put: "#22c58b", amber: "#f2b632", call: "#ff5a5f",
    accent: "#1fc8a6", hi: "#ffffff", candle: "#f2f2f5", spotline: "#d4d4dc",
    heat0: [15, 15, 18], heatNeg: [255, 40, 120], heatPos: [146, 76, 255],
  },
  light: {
    ink: "#f4f5f7", surface: "#ffffff", grid: "#eceef2", axis: "#d5d9e0",
    text: "#1b1f27", muted: "#5d6573", faint: "#959cab",
    neg: "#e5336f", pos: "#7c5cf0", negFront: "#f4a3c0", posFront: "#c3b5f7", put: "#13a874", amber: "#c98a00", call: "#e04848",
    accent: "#1fa98f", hi: "#000000", candle: "#1b1f27", spotline: "#4a5160",
    heat0: [252, 252, 253], heatNeg: [229, 51, 111], heatPos: [124, 92, 240],
  },
};
const C = Object.assign({}, THEMES[document.documentElement.dataset.theme === "light" ? "light" : "dark"]);
const MONO = "'Inter', -apple-system, 'Segoe UI', Roboto, sans-serif";
const SANS = "'Inter', -apple-system, 'Segoe UI', Roboto, sans-serif";

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
  greek: store.get("greek", "gamma"),
  pos: store.get("pos", "standard"),
  model: store.get("model", "spotgamma"),
  validMode: "standard",
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

/* ============================================================ formato (es-ES) */
function fmtNum(v, dec = 0) {
  if (v == null || !isFinite(v)) return "—";
  const neg = v < 0;
  const [i, d] = Math.abs(v).toFixed(dec).split(".");
  const int = i.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return (neg ? "−" : "") + int + (d ? "," + d : "");
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
function ddmm(iso) { return iso ? iso.slice(8, 10) + "/" + iso.slice(5, 7) : ""; }
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
function hhmm(dt) { return dt ? dt.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" }) : ""; }
function nyHHMM(str) { return hhmm(nyDate(str)); }
// hora local con el dia si no es hoy ("ayer 22:00", "vie 30 22:00")
function nyWhen(str) {
  const dt = nyDate(str);
  if (!dt) return "";
  const today = new Date(), y = new Date(Date.now() - 86400e3);
  const same = (a, b) => a.toDateString() === b.toDateString();
  const day = same(dt, today) ? "" : same(dt, y) ? "ayer " : dt.toLocaleDateString("es-ES", { weekday: "short", day: "numeric" }) + " ";
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
      ? { key: "vt", tag: "HEDGE WALL", name: "Hedge Wall", v: L.vt, c: C.amber }
      : { key: "vt", tag: "VT", name: "Vol Trigger", v: L.vt, c: C.amber },
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
  const title = t.off ? `<title>${t.name} fuera del rango visible</title>` : "";
  return `<g opacity="${t.off ? 0.7 : 1}">${title}
  <rect x="${t.left}" y="${y}" width="${t.w}" height="${t.h}" rx="7" fill="${C.surface}"/>
  <rect x="${t.left}" y="${y}" width="${t.w}" height="${t.h}" rx="7" fill="${t.c}" fill-opacity="0.09" stroke="${t.c}" stroke-width="1.4"/>
  <text x="${cx}" y="${y + t.h / 2 + fs * 0.36}" text-anchor="middle" font-family="${MONO}" font-size="${fs}" fill="${t.c}">${esc(t.text)}</text></g>`;
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
  const b = bucketStrikes(d.strikes, keys.map((x) => d[x] || null), d.step, maxN);
  if (b.k === 1) return d;
  const o = { ...d, strikes: b.ks, step: b.step, bucket: b.k, bucketStep: d.step };
  keys.forEach((x, i) => { if (b.arrs[i]) o[x] = b.arrs[i]; });
  return o;
}

function renderStrike(d0, W, H, exp = false) {
  const fs = exp ? 15 : 12.5, small = exp ? 13 : 11;
  const left = exp ? 92 : 64, right = W - (exp ? 40 : 16);
  const d = bucketData(d0, Math.max(30, Math.floor((right - left) / (exp ? 7 : 6))));
  const n = d.strikes.length, step = d.step, s0 = d.strikes[0];
  const band = (right - left) / n;
  const xOf = (v) => left + ((v - s0) / step + 0.5) * band;

  const items = levelItems(d);
  const pt = placeTags(items, xOf, left, right, fs);
  const titleH = exp ? 52 : 0;
  const top = titleH + 14 + pt.rows * (pt.h + 8) + 22;
  const bottom = H - (exp ? 92 : 74);

  // series segun el modo de barras
  const greek = state.greek;
  const mode = greek === "gamma" ? state.bars : "net";
  const series = greek === "gamma" ? d.net : (d[greek] || d.net);
  const rest = d.net.map((v, i) => v - (d.front ? d.front[i] : 0));
  let hiArr, loArr;
  if (mode === "split") { hiArr = d.calls; loArr = d.puts; }
  else if (mode === "expiry") {
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
  s += `<text transform="translate(${exp ? 26 : 14},${(top + bottom) / 2}) rotate(-90)" text-anchor="middle" font-family="${MONO}" font-size="${small - 1}" fill="${C.faint}">${{ gamma: "$ delta por $1", vanna: "$ si la IV cae 1 pt", charm: "$ por un día" }[greek]}</text>`;

  // banda de movimiento esperado
  s += emBand(d, xOf, top, bottom, small, left, right);

  // barras
  const bw = Math.max(1, Math.min(band * 0.64, 22));
  const rx = Math.min(2, bw / 4);
  const bar = (x, from, to, fill) => {
    const y = Math.min(yOf(from), yOf(to)), h = Math.max(0.8, Math.abs(yOf(to) - yOf(from)));
    return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${bw.toFixed(2)}" height="${h.toFixed(2)}" rx="${rx}" fill="${fill}"/>`;
  };
  s += `<rect id="hl" x="0" y="${top}" width="${band}" height="${bottom - top}" fill="${C.hi}" fill-opacity="0.04" visibility="hidden"/>`;
  for (let i = 0; i < n; i++) {
    const x = xOf(d.strikes[i]) - bw / 2;
    if (mode === "split") {
      if (d.calls[i]) s += bar(x, 0, d.calls[i], C.pos);
      if (d.puts[i]) s += bar(x, 0, d.puts[i], C.neg);
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

  // niveles
  s += tagsSVG(pt, titleH, bottom, fs);

  // spot
  s += spotSVG(d, xOf(d.spot), top - 8, bottom, fs, left, right, W, H, exp, legendItems(d));
  s += watermark(d, left, bottom, small, exp);

  state.geo = exp ? state.geo : { kind: "strike", left, right, band, top, bottom, n, xOf, data: d };
  return frame(W, H, s, d, exp, { gamma: "Exposición gamma por strike", vanna: "Flujo por vanna (IV −1 pt)", charm: "Flujo por charm (1 día)" }[greek]);
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
  s += `<text transform="translate(${exp ? 26 : 14},${(top + bottom) / 2}) rotate(-90)" text-anchor="middle" font-family="${MONO}" font-size="${small - 1}" fill="${C.faint}">GEX total si el spot fuera…</text>`;

  s += emBand(d, xOf, top, bottom, small, left, right);
  const pts = X.map((x, i) => `${xOf(x).toFixed(2)},${yOf(Y[i]).toFixed(2)}`);
  const area = `M${xOf(x0)},${y0} L${pts.join(" L")} L${xOf(x1)},${y0} Z`;
  const line = `M${pts.join(" L")}`;
  const id = exp ? "e" : "s";
  s += `<defs>
    <clipPath id="up${id}"><rect x="${left}" y="${top - 10}" width="${right - left}" height="${y0 - top + 10}"/></clipPath>
    <clipPath id="dn${id}"><rect x="${left}" y="${y0}" width="${right - left}" height="${bottom - y0 + 10}"/></clipPath>
  </defs>`;
  s += `<path d="${area}" fill="${C.pos}" fill-opacity="0.16" clip-path="url(#up${id})"/>`;
  s += `<path d="${area}" fill="${C.neg}" fill-opacity="0.16" clip-path="url(#dn${id})"/>`;
  s += `<path d="${line}" fill="none" stroke="${C.pos}" stroke-width="2" clip-path="url(#up${id})"/>`;
  s += `<path d="${line}" fill="none" stroke="${C.neg}" stroke-width="2" clip-path="url(#dn${id})"/>`;
  s += `<line x1="${left}" x2="${right}" y1="${y0}" y2="${y0}" stroke="${C.axis}" stroke-width="1.2"/>`;
  if (d.levels.flip_exact) {
    const fx = xOf(d.levels.flip_exact);
    s += `<circle cx="${fx}" cy="${y0}" r="${exp ? 6 : 4.5}" fill="${C.surface}" stroke="${C.amber}" stroke-width="2"/>`;
  }

  s += tagsSVG(pt, titleH, bottom, fs);
  s += spotSVG(d, xOf(d.spot), top - 8, bottom, fs, left, right, W, H, exp,
    [{ colors: [C.neg], label: "GEX total negativa" }, { colors: [C.pos], label: "GEX total positiva" }]);
  s += `<g id="cross" visibility="hidden"><line id="crossL" y1="${top}" y2="${bottom}" stroke="${C.muted}" stroke-dasharray="2 3"/><circle id="crossC" r="4" fill="${C.text}"/></g>`;
  s += watermark(d, left, bottom, small, exp);

  if (!exp) state.geo = { kind: "profile", left, right, top, bottom, xOf, yOf, x0, x1 };
  return frame(W, H, s, d, exp, "Perfil de gamma");
}

/* ============================================================ piezas comunes */
function spotSVG(d, x, top, bottom, fs, left, right, W, H, exp, legend) {
  if (x < left - 1 || x > right + 1) return legendSVG(legend || [], H - (fs + 16) / 2 - (exp ? 22 : 12), fs, left, left - 40, left, right); // spot fuera del zoom
  const label = `${d.spot_manual ? "Spot manual" : d.spot_implied && d.spot_implied.use ? "Pre-market" : "Spot"} ≈ ${fmtSpot(d.spot)}`;
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
  if (state.greek !== "gamma") return [{ colors: [C.pos], label: "Compras de cobertura" }, { colors: [C.neg], label: "Ventas de cobertura" }];
  if (state.bars === "split") return [{ colors: [C.pos], label: "Calls" }, { colors: [C.neg], label: "Puts" }];
  if (state.bars === "expiry") return [
    { colors: [C.neg, C.pos], label: "Resto de vencimientos" },
    { colors: [C.negFront, C.posFront], label: `Vence ${ddmm(d.front_expiry)}` },
  ];
  return [{ colors: [C.neg], label: "Gamma negativa" }, { colors: [C.pos], label: "Gamma positiva" }];
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
function charmLabel(d) { return d.meta && d.meta.max_dte === 0 && d.front_expiry === d.session ? "Charm, hasta el vencimiento" : "Charm, por un día"; }
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
function sessLabel(iso) { return iso ? new Date(iso + "T12:00:00").toLocaleDateString("es-ES", { weekday: "short", day: "numeric" }) : ""; }
function rangeLabel(em) { return em ? (em.partial ? `resto del ${sessLabel(em.session)}` : sessLabel(em.session)) : "1 sesión"; }

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
  const date = (d.session || (d.computed_at || "").slice(0, 10)).split("-").reverse().join("/");
  return `<text x="${left + 10}" y="${bottom - 12}" text-anchor="start" font-family="${MONO}" font-size="${small}" fill="${C.faint}" fill-opacity="0.75">GEX Lab, ${esc(d.symbol)}, ${date}</text>`;
}

function frame(W, H, inner, d, exp, title) {
  let head = "";
  if (exp) {
    const dte = DTE_LABEL[state.dte] || "";
    head = `<rect x="0" y="0" width="${W}" height="${H}" rx="22" fill="${C.surface}"/>
      <text x="92" y="44" font-family="${SANS}" font-size="22" font-weight="600" fill="${C.text}">${esc(d.symbol)}</text>
      <text x="${92 + d.symbol.length * 14 + 14}" y="44" font-family="${SANS}" font-size="18" fill="${C.muted}">${title}, ${dte}</text>`;
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

function heatZ(hm) { return state.mapMode === "total" || !hm.zk ? hm.z : hm.zk; }

function buildHeatImage(hm) {
  const Z = heatZ(hm);
  const rows = hm.prices.length, cols = hm.times.length;
  const abs = Z.flat().map(Math.abs).sort((a, b) => a - b);
  const vmax = abs[Math.floor(abs.length * (state.mapMode === "total" ? 0.985 : 0.99))] || 1;
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
  return { url: cv.toDataURL("image/png"), vmax };
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
  const pLo = hm.prices[0], pHi = hm.prices[hm.prices.length - 1];
  const yOf = (p) => bottom - ((p - pLo) / (pHi - pLo)) * (bottom - top);
  const m0 = minutesOf("09:30"), m1 = minutesOf("16:00");
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

  // barras GEX por strike (horizontales)
  // barras del propio mapa (cubren todo su rango de precios); si no vienen, las del analisis
  // modo "por strike": la misma medida que el color del mapa (gamma en cada strike) a la hora actual o de la
  // ultima vela; modo "total": GEX neta por strike al precio actual
  // en los dos modos: GEX neta de cada strike al precio actual, por 1% (la misma medida que el mapa y que gexbot).
  // No se usa la gamma "en el strike" a la hora de la ultima vela: al cierre el 0DTE a punto de vencer la dispara
  const ks = [], vs = [];
  const src = hm.strikes && hm.net ? hm : d, sp1 = (hm.spot || d.spot) / 100;
  src.strikes.forEach((k, i) => { if (k >= pLo && k <= pHi) { ks.push(k); vs.push(src.net[i] * sp1); } });
  const sideB = bucketStrikes(ks, [vs], hm.step || d.step, Math.max(20, Math.floor((bottom - top) / 4)));
  ks.length = 0; vs.length = 0; ks.push(...sideB.ks); vs.push(...sideB.arrs[0]);
  const bmax = Math.max(1, ...vs.map(Math.abs));
  const cx = (barsL + barsR) / 2, half = (barsR - barsL) / 2 - 4;
  const bh = Math.max(1.5, Math.min(10, ((bottom - top) / Math.max(1, (pHi - pLo) / sideB.step)) * 0.7));
  if (!narrow) s += `<line x1="${cx}" x2="${cx}" y1="${top}" y2="${bottom}" stroke="${C.axis}"/>`;
  if (!narrow) ks.forEach((k, i) => {
    const v = vs[i]; if (!v) return;
    const w = (Math.abs(v) / bmax) * half, y = yOf(k) - bh / 2;
    s += `<rect x="${v > 0 ? cx : cx - w}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${bh.toFixed(2)}" rx="1" fill="${v > 0 ? C.pos : C.neg}"/>`;
  });
  if (!narrow) {
    s += `<text x="${cx - half}" y="${bottom + small + 10}" font-family="${MONO}" font-size="${small}" fill="${C.muted}">${fmtAxis(-bmax)}</text>`;
    s += `<text x="${cx + half}" y="${bottom + small + 10}" text-anchor="end" font-family="${MONO}" font-size="${small}" fill="${C.muted}">${fmtAxis(bmax)}</text>`;
    s += `<text x="${cx}" y="${bottom + small + 10}" text-anchor="middle" font-family="${SANS}" font-size="${small}" fill="${C.faint}">GEX por strike, 1%</text>`;
  }

  // mapa
  s += `<image href="${url}" x="${heatL}" y="${top}" width="${lastX - heatL}" height="${bottom - top}" preserveAspectRatio="none" style="image-rendering:auto"/>`;
  if (lastX < heatR) s += `<rect x="${lastX}" y="${top}" width="${heatR - lastX}" height="${bottom - top}" fill="${C.ink}" fill-opacity="0.6"/>`;
  s += `<rect x="${heatL}" y="${top}" width="${heatR - heatL}" height="${bottom - top}" fill="none" stroke="${C.line || C.axis}"/>`;

  // horas
  for (let h = 10; h <= 16; h += narrow ? 2 : 1) {
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
  const sy = yOf(hm.spot);
  s += `<line x1="${heatL}" x2="${heatR}" y1="${sy}" y2="${sy}" stroke="${C.spotline}" stroke-opacity="0.5" stroke-dasharray="2 4"/>`;
  s += `<rect x="${heatL - axisW + 6}" y="${sy - small * 0.85 - 3}" width="${axisW - 10}" height="${small + 7}" rx="4" fill="${C.spotline}"/>`;
  s += `<text x="${heatL - 10}" y="${sy + small * 0.35}" text-anchor="end" font-family="${MONO}" font-size="${small}" font-weight="500" fill="${C.ink}">${fmtSpot(hm.spot)}</text>`;
  if (hm.candles && hm.candles.length) {
    const slot = (heatR - heatL) * 5 / (m1 - m0);
    const cw = Math.max(1.5, slot * 0.62);
    let cs = "";
    for (const [t, o, h, l, c] of hm.candles) {
      const x = xOf(t) + slot / 2;
      const up = c >= o;
      const yT = yOf(Math.max(o, c)), yB = yOf(Math.min(o, c));
      cs += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${yOf(h).toFixed(1)}" y2="${yOf(l).toFixed(1)}" stroke="${C.candle}" stroke-width="1"/>`;
      cs += `<rect x="${(x - cw / 2).toFixed(1)}" y="${yT.toFixed(1)}" width="${cw.toFixed(1)}" height="${Math.max(1, yB - yT).toFixed(1)}" fill="${up ? C.candle : C.ink}" stroke="${C.candle}" stroke-width="0.9"/>`;
    }
    s += `<g clip-path="url(#heatclip${exp ? "e" : "s"})">${cs}</g>`;
    s += `<clipPath id="heatclip${exp ? "e" : "s"}"><rect x="${heatL}" y="${top}" width="${heatR - heatL}" height="${bottom - top}"/></clipPath>`;
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
  if (!narrow) s += `<text transform="translate(${cbL + cbBar + 6 + cbNum + small * 0.4},${(top + bottom) / 2}) rotate(90)" text-anchor="middle" font-family="${MONO}" font-size="${small - 1}" fill="${C.faint}">${state.mapMode === "total" ? "GEX total por 1%" : "Gamma por strike, por 1%"}</text>`;

  // marca de agua
  if (!narrow) s += `<text x="${heatL + 10}" y="${bottom - 10}" font-family="${MONO}" font-size="${small}" fill="${C.hi}" fill-opacity="0.35">GEX Lab, ${esc(d.symbol)}, ${ddmm(hm.session)}</text>`;

  if (!exp) state.geo = { kind: "map", left: heatL, right: heatR, top, bottom, barsL, barsR, pLo, pHi, m0, m1, lastX };
  return frame(W, H, s, d, exp, `Mapa de gamma ${ddmm(hm.session)}`);
}

const COMBO = { SPX: "SPY", XSP: "SPY", NDX: "QQQ", RUT: "IWM", DJX: "DIA" };
function extraParams() {
  const o = {};
  if (state.combo && COMBO[state.symbol]) o.combine = "1";
  if (state.pos === "flow") o.pos = "flow";
  o.model = state.model === "gexbot" ? "gexbot" : "spotgamma";
  return o;
}

function heatParams() {
  const p = new URLSearchParams({ symbol: state.symbol, dte: state.dte, range: state.range, session: state.mapSess, ...extraParams() });
  const sp = $("spotInput").value.trim();
  if (sp) p.set("spot", sp.replace(/\./g, "").replace(",", "."));
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
    if (!r.ok) throw new Error(hm.error || "No se pudo calcular el mapa");
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
  const dias = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
  const dt = new Date(hm.session + "T12:00:00");
  const dia = `${dias[dt.getDay()]} ${ddmm(hm.session)}`;
  document.querySelectorAll("#sessSeg button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === hm.kind)));
  const cap = $("caption");
  if (hm.live) cap.textContent = `Sesión de hoy (${dia}), con el open interest del cierre anterior`;
  else if (hm.kind === "next") cap.textContent = `Proyección para el ${dia}. Las velas aparecerán cuando abra la sesión`;
  else cap.textContent = `Sesión del ${dia}` + (hm.approx ? ". Aproximada: CBOE ya no publica los contratos que vencieron ese día" : "");
  cap.title = hm.approx ? "Desde ahora la app guarda una copia de la cadena durante cada sesión, así que las próximas repeticiones serán exactas." : "";
}

/* ============================================================ pintar */
function draw() {
  const d = state.data;
  const el = $("chart");
  if (!d) return;
  const W = Math.max(320, el.clientWidth), H = Math.max(360, el.clientHeight);
  if (state.view === "map") {
    if (!state.heat || state.heatKey !== heatParams()) { loadHeat(); return; }
    el.innerHTML = renderMap(d, state.heat, W, H);
    el.setAttribute("aria-label", "Mapa de gamma por precio y hora");
    return;
  }
  const z = typeof zoomed === "function" ? zoomed(d, state.view) : d;
  el.innerHTML = state.view === "impact" && typeof renderImpact === "function" ? renderImpact(z, W, H)
    : state.view === "history" && typeof renderHistory === "function" ? renderHistory(z, W, H)
    : state.view === "profile" ? renderProfile(z, W, H) : renderStrike(z, W, H);
  el.setAttribute("aria-label", state.view === "profile" ? "Perfil de gamma" : state.view === "history" ? "Histórico de niveles" : "Exposición gamma por strike");
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
  if (d.spot_manual) { hc.textContent = "spot manual"; hc.className = "chg"; }
  else if (imp && imp.use) { hc.textContent = `pre-market vía ${imp.proxy}`; hc.className = "chg"; }
  else if (chg != null && isFinite(chg)) { hc.textContent = fmtPct(chg); hc.className = "chg " + (chg >= 0 ? "up" : "dn"); }
  else { hc.textContent = ""; hc.className = "chg"; }

  const fx = d.levels.flip_exact;
  const fs = flipSide(d.spot, fx, d.levels.flip);
  const side = fs === "above" ? "Por encima del flip, l" : fs === "below" ? "Por debajo del flip, l" : "";
  let reg = fs === "near"
    ? `<b class="${d.regime === "negative" ? "neg" : "pos"}">Gamma ${d.regime === "negative" ? "negativa" : "positiva"}, junto al flip.</b> A menos de un ${fmtNum(FLIP_ZONE, 1)}% del Gamma Flip: zona de transición, sin efecto claro de los dealers en ninguno de los dos sentidos.`
    : d.regime === "negative"
    ? `<b class="neg">Gamma negativa.</b> ${side || "L"}a cobertura de los dealers tiende a amplificar los movimientos.`
    : `<b class="pos">Gamma positiva.</b> ${side || "L"}a cobertura de los dealers tiende a frenar los movimientos.`;
  if (imp && !imp.use && !d.spot_manual && Math.abs(imp.proxy_chg) > 0.01)
    reg += `<span class="implied">Fuera de horario ${imp.proxy} implica ${fmtSpot(imp.value)} (${fmtPct(imp.proxy_chg)}).</span>`;
  $("regime").innerHTML = reg;

  const rows = levelItems(d).map((x) => ({ ...x }));
  const ag = d.levels.abs_gamma;
  if (ag != null && ag !== d.levels.put_wall && ag !== d.levels.call_wall)
    rows.push({ key: "abs", name: "Gamma absoluta", v: ag, c: C.muted });
  const gk = (r) => r.key === "vt" ? (d.is_index === false ? "hedge" : "vt") : r.key;
  rows.push({ key: "spot", name: d.spot_manual ? "Spot manual" : "Spot", v: d.spot, spot: true });
  rows.sort((a, b) => b.v - a.v || (a.spot ? 1 : -1));
  $("levels").innerHTML = rows.map((r) => r.spot
    ? `<li class="spot"><span class="name" data-g="spot">${r.name}</span><span class="val">${fmtSpot(r.v)}</span></li>`
    : `<li style="--c:${r.c}"><span class="name" data-g="${gk(r)}">${r.name}</span><span class="val">${fmtLevel(r.v)}</span><span class="dist">${fmtPct((r.v / d.spot - 1) * 100)}</span>${prevLine(d, r)}</li>`
  ).join("");

  const t = d.totals;
  $("split").hidden = false;
  $("netPct").textContent = fmtBig(t.net_per_pct, true);
  const c = Math.abs(t.call_per_pct), p = Math.abs(t.put_per_pct), tot = c + p || 1;
  $("splitC").style.width = (c / tot) * 100 + "%";
  $("splitP").style.width = (p / tot) * 100 + "%";
  $("netPrev").textContent = d.prev && d.prev.net_per_pct != null ? `${ddmm(d.prev.date)}: ${fmtBig(d.prev.net_per_pct, true)}` : "";
  $("callPct").textContent = `Calls ${fmtBig(t.call_per_pct, true)}`;
  $("putPct").textContent = `Puts ${fmtBig(t.put_per_pct, true)}`;

  const em = move1(d), m5 = d.moves && d.moves.d5, st = d.expected_move;
  $("facts").hidden = false;
  $("emLabel").textContent = `Rango 1σ, ${rangeLabel(em)}`;
  $("emVal").textContent = em ? `±${fmtNum(em.pct, 2)}%` : "—";
  $("emRange").textContent = em ? `${fmtSpot(em.lo)} – ${fmtSpot(em.hi)}${m5 ? ` · 5 sesiones ±${fmtNum(m5.pct, 2)}%` : ""}` : "sin IV ATM";
  $("emRange").title = `Rango de 1 desviación típica (68,3%) implícito en las opciones: varianza ATM interpolada en horas de mercado.` +
    (st ? ` Straddle ATM del ${ddmm(st.expiry)}: ±${fmtNum(st.pct, 2)}% (movimiento medio, ≈ 0,8σ).` : "");
  const vf = t.vanna_flow, cf = t.charm_flow;
  $("vannaVal").textContent = fmtBig(Math.abs(vf), true);
  $("vannaSub").textContent = vf >= 0 ? "compras de cobertura" : "ventas de cobertura";
  $("charmVal").textContent = fmtBig(Math.abs(cf), true);
  $("charmSub").textContent = cf >= 0 ? "compras de cobertura" : "ventas de cobertura";
  $("charmLabel").textContent = charmLabel(d);
  $("frontLabel").textContent = `Vence ${ddmm(d.front_expiry)}`;
  $("frontVal").textContent = `${fmtNum(d.front_share * 100, 0)}%`;

  const m = d.meta;
  $("meta").innerHTML = `
    <dt>Contratos</dt><dd>${fmtNum(m.contracts)}</dd>
    <dt>Vencimientos</dt><dd>${m.expirations}</dd>
    ${d.levels.zero_gamma ? `<dt title="Precio en el que la GEX total recalculada cruzaría cero (convención SpotGamma)">Zero gamma (perfil)</dt><dd>${fmtLevel(d.levels.zero_gamma)}</dd>` : ""}
    ${d.levels.window ? `<dt title="Rango en el que se buscan Call Wall, Put Wall, Flip y Vol Trigger">Niveles en</dt><dd>±${fmtNum(d.levels.window, d.levels.window < 1 ? 2 : 1)}%</dd>` : ""}
    <dt>Comparado con</dt><dd>${d.prev ? ddmm(d.prev.date) : "sin histórico aún"}</dd>
    ${d.combo ? `<dt>Combinado</dt><dd>+ ${d.combo.proxy} (×${fmtNum(d.combo.ratio, 2)})</dd>` : ""}
    <dt>Dealers</dt><dd class="flowinfo">${d.positioning === "flow"
      ? (!d.flow_info || !d.flow_info.days ? "flujo: aún sin datos, igual que la estándar"
        : d.flow_info.days === 1 ? `flujo: solo el volumen de la última sesión (${fmtNum(d.flow_info.share_flipped * 100, 0)}% de la posición ajustada)`
        : `flujo, ${d.flow_info.days} sesiones (${fmtNum(d.flow_info.share_flipped * 100, 0)}% ajustada)`)
      : "convención estándar"}</dd>
    <dt>Tipo sin riesgo</dt><dd title="${d.rate && d.rate.src === "IRX" ? "Letra del Tesoro a 13 semanas (IRX de CBOE), en tipo continuo" : "Valor fijo: no se pudo leer la letra del Tesoro"}">${d.rate ? fmtNum(d.rate.r * 100, 2) + "%" + (d.rate.src === "IRX" ? " · letra 13 sem." : " · fijo") : "—"}</dd>
    <dt>Datos CBOE</dt><dd>${esc(d.timestamp ? d.timestamp.slice(0, 16) + " UTC" : "—")}</dd>`;
}

function prevLine(d, r) {
  const p = d.prev;
  if (!p || !(r.key in p) || p[r.key] == null) return "";
  const was = p[r.key];
  if (Math.abs(was - r.v) < 1e-9) return `<span class="prev">igual que el ${ddmm(p.date)}</span>`;
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
  if (!d.quote_time || !d.computed_at) return `Datos ${nyWhen(d.quote_time || d.computed_at)}`;
  if (!dataClosed(d)) return `Datos ${nyWhen(d.computed_at)}`;
  const pre = d.spot_implied && d.spot_implied.use ? " · pre-market" : "";
  return `Calculado ${nyWhen(d.computed_at)}${pre} · opciones: cierre ${nyWhen(d.quote_time)}`;
}
function dataTitle(d) {
  const src = d.source === "tradier" ? "Tradier (tiempo real al calcular)" : "CBOE (15 min de retraso)";
  const base = `Calculado ${nyWhen(d.computed_at)} (hora local) con datos de ${src}.`;
  if (!dataClosed(d)) return base;
  return `${base} Fuera del horario de mercado las opciones no cotizan: sus precios e IV son los del cierre (${nyWhen(d.quote_time)}). ` +
    (d.spot_implied && d.spot_implied.use ? `El precio es el de pre-market (vía ${d.spot_implied.proxy || "su ETF"}) y el open interest, el último publicado.` : "El open interest es el último publicado.");
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
    ${/CBOE|certificado|servidor/.test(msg) ? "" : `<div class="err-d">Comprueba el ticker (los índices van sin prefijo: SPX, NDX, RUT) o prueba otro filtro de vencimientos.</div>`}</div></div>`;
  state.data = null;
  clearSide();
}

function clearSide() {
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
  if (state.ctrl) state.ctrl.abort();
  state.ctrl = new AbortController();

  syncCombo();
  $("refreshBtn").classList.add("spin");
  if (!silent) $("chart").classList.add("loading");
  anaStatus("busy", `Cargando ${sym}…`);
  $("tip").hidden = true;

  const p = new URLSearchParams({ symbol: sym, dte: state.dte, range: state.range, ...extraParams() });
  const sp = $("spotInput").value.trim();
  if (sp) p.set("spot", sp.replace(/\./g, "").replace(",", ".") );
  if (refresh) p.set("refresh", "1");

  try {
    const r = await fetch("/api/gex?" + p, { signal: state.ctrl.signal });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "No se pudieron calcular los datos");
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
    document.title = `${d.symbol} ${fmtSpot(d.spot)} · GEX Lab`;
  } catch (e) {
    if (e.name === "AbortError") return;
    $("refreshBtn").classList.remove("spin");
    if (silent && state.data) { anaStatus("err", "No se pudo actualizar; se mantienen los datos anteriores"); return; }
    showError(e.message === "Failed to fetch" ? "El servidor local no responde. Vuelve a abrir GEX Lab." : e.message);
    anaStatus("err", "Sin datos");
  }
}

/* ============================================================ interacción */
// barra de vencimientos: pasos acumulados (los mismos filtros que gex_engine.DTE_FILTERS)
const DTE_STEPS = ["0", "1", "7", "14", "30", "45", "all"];
const DTE_LABEL = { "0": "0DTE", "1": "≤ 1DTE", "7": "≤ 7 días", "14": "≤ 14 días", "30": "≤ 30 días", "45": "≤ 45 días", all: "todos los vencimientos" };

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
    $("comboTitle").textContent = `Sumar ${px}`;
    $("comboHelp").textContent = `Añade las opciones de ${px} a ${state.symbol}, convertidas a sus unidades, como los niveles combo.`;
  }
  $("comboToggle").setAttribute("aria-checked", String(state.combo && !!px));
  renderChips();
}

/* etiquetas con los ajustes del modelo que no están en su valor por defecto */
function renderChips() {
  const chips = [];
  if (state.model === "gexbot") chips.push({ k: "model", t: "Motor: gexbot" });
  if (state.pos === "flow") chips.push({ k: "pos", t: "Dealers: flujo" });
  if (state.combo && COMBO[state.symbol]) chips.push({ k: "combo", t: `+ ${COMBO[state.symbol]}` });
  const sp = $("spotInput").value.trim();
  if (sp) {
    const v = parseFloat(sp.replace(/\./g, "").replace(",", "."));
    chips.push({ k: "spot", t: `Spot ${isFinite(v) ? fmtSpot(v) : sp}` });
  }
  $("chips").innerHTML = chips.length
    ? chips.map((c) => `<span class="chip">${esc(c.t)}<button data-k="${c.k}" title="Quitar" aria-label="Quitar ${esc(c.t)}">×</button></span>`).join("")
    : `<span class="chip-default">Motor SpotGamma, convención estándar</span>`;
}

function clearChip(k) {
  if (k === "pos") { state.pos = "standard"; store.set("pos", "standard"); $("posSeg").querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === "standard"))); }
  if (k === "combo") { state.combo = false; store.set("combo", "0"); }
  if (k === "model") { state.model = "spotgamma"; store.set("model", "spotgamma"); $("modelSeg").querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === "spotgamma"))); }
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
      toast(`${d.symbol} ${up ? "supera" : "pierde"} ${it.name} ${fmtLevel(lv)}`,
        `Precio ${fmtSpot(b)} (antes ${fmtSpot(a)}). ${it.key === "flip" ? (up ? "Entra en zona de gamma positiva." : "Entra en zona de gamma negativa.") : ""}`);
    }
  }
}

function setAuto(on, quiet = false) {
  state.auto = on;
  store.set("autoOn", on ? "1" : "0");
  $("autoToggle").setAttribute("aria-checked", String(on));
  clearInterval(state.autoTimer);
  if (on) {
    state.autoTimer = setInterval(() => {
      if (state.mode === "scanner") { if (state.scanView === "table") runScan(); else if (state.scanView === "compass") loadCompass(true); }
      else load(false, true);
    }, 5 * 60 * 1000);
    if (quiet) return;
    try { if (window.Notification && Notification.permission === "default") Notification.requestPermission(); } catch { /* */ }
    toast("Actualización automática activada", "Recalcula cada 5 minutos y avisa cuando el precio cruce un nivel.");
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
  $("barsSeg").hidden = v !== "strike" || state.greek !== "gamma";
  $("greekSeg").hidden = v !== "strike";
  $("levelsToggle").hidden = v !== "map" && v !== "impact";
  $("mapSeg").hidden = v !== "map";
  $("sessSeg").hidden = v !== "map";
  $("caption").textContent = v === "history" ? "Niveles al cierre de cada sesión guardada, con este filtro de vencimientos y este motor. Haz clic en la leyenda para mostrar u ocultar cada línea"
    : v === "profile" ? "GEX total recalculada en cada nivel hipotético del subyacente"
    : v === "impact" ? "Líneas: gamma total de los vencimientos del filtro y del próximo vencimiento semanal si el precio estuviera en cada nivel. Barras: gamma neta de cada strike al precio actual" : "";
  mapCaption();
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
      <div class="r">Neta <b>${fmtBig(b.net[i], true)}</b></div>
      <div class="r">Calls <b>${fmtBig(b.calls[i], true)}</b></div>
      <div class="r">Puts <b>${fmtBig(b.puts[i], true)}</b></div>
      <div class="r">Vence ${ddmm(b.front_expiry)} <b>${fmtBig(b.front[i], true)}</b></div>`;
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
    html = `<div class="t">Spot ${fmtSpot(v)}</div><div class="r">GEX total <b>${fmtBig(yv, true)}</b></div>
      <div class="r">Distancia <b>${fmtPct((v / d.spot - 1) * 100)}</b></div>`;
  }
  tip.innerHTML = html; tip.hidden = false;
  const wr = $("chart").getBoundingClientRect(), pr = tip.offsetParent.getBoundingClientRect();
  let tx = e.clientX - pr.left + 16, ty = e.clientY - pr.top - tip.offsetHeight - 10;
  if (tx + tip.offsetWidth > pr.width - 8) tx = e.clientX - pr.left - tip.offsetWidth - 16;
  if (ty < wr.top - pr.top) ty = e.clientY - pr.top + 16;
  tip.style.left = tx + "px"; tip.style.top = ty + "px";
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
  if (x >= g.barsL && x <= g.barsR) {
    let bi = -1, bd = Infinity;
    d.strikes.forEach((k, i) => { const dd = Math.abs(k - price); if (dd < bd) { bd = dd; bi = i; } });
    if (bi < 0) return hideTip();
    html = `<div class="t">Strike ${fmtLevel(d.strikes[bi])}</div><div class="r">GEX neta <b>${fmtBig(d.net[bi], true)}</b></div>
      <div class="r">Vence ${ddmm(d.front_expiry)} <b>${fmtBig(d.front[bi], true)}</b></div>`;
  } else if (x >= g.left && x <= Math.min(g.right, g.lastX)) {
    const mins = g.m0 + ((x - g.left) / (g.right - g.left)) * (g.m1 - g.m0);
    const c = Math.max(0, Math.min(hm.times.length - 1, Math.round((mins - g.m0) / 5)));
    const r = Math.max(0, Math.min(hm.prices.length - 1, Math.round(((price - g.pLo) / (g.pHi - g.pLo)) * (hm.prices.length - 1))));
    html = `<div class="t">${nyHHMM(hm.session + " " + hm.times[c])}, precio ${fmtSpot(price)}</div>
      <div class="r">${state.mapMode === "total" ? "GEX total" : "Gamma en el strike"} <b>${fmtBig(heatZ(hm)[r][c], true)}</b></div>
      <div class="r">Distancia <b>${fmtPct((price / hm.spot - 1) * 100)}</b></div>`;
  } else return hideTip();
  tip.innerHTML = html; tip.hidden = false;
  placeTip(e);
}

function hideTip() {
  $("tip").hidden = true;
  const svg = $("chart").querySelector("svg");
  if (!svg) return;
  svg.querySelector("#hl")?.setAttribute("visibility", "hidden");
  svg.querySelector("#cross")?.setAttribute("visibility", "hidden");
}

/* ============================================================ exportar PNG */
// imagen del grafico visible (mismo formato que Exportar PNG) como Blob
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
      cv.toBlob((bl) => (bl ? resolve(bl) : reject(new Error("No se pudo generar la imagen"))), "image/png");
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("No se pudo generar la imagen")); };
    img.src = url;
  });
}

async function exportPNG() {
  const d = state.data;
  if (!d) return;
  const b = await chartPngBlob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(b);
  a.download = `GEX_${d.symbol}_${(d.computed_at || "").slice(0, 10)}_${{ profile: "perfil", map: "mapa", impact: "impacto" }[state.view] || "strikes"}.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// copia la imagen al portapapeles: la escritura se pide dentro del clic (con la imagen como promesa),
// que es lo que exige el navegador
function copyPNG() {
  if (!state.data) return;
  const btn = $("copyBtn");
  if (!navigator.clipboard || !window.ClipboardItem) { toast("No se puede copiar", "Este navegador no permite copiar imágenes; usa Exportar PNG."); return; }
  btn.disabled = true;
  navigator.clipboard.write([new ClipboardItem({ "image/png": chartPngBlob() })])
    .then(() => { btn.textContent = "Copiado"; setTimeout(() => { btn.textContent = "Copiar"; }, 1600); })
    .catch((e) => toast("No se pudo copiar", e && e.message ? e.message : "El navegador bloqueó el portapapeles."))
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
  if (L.abs_gamma != null && ![L.call_wall, L.put_wall].includes(L.abs_gamma)) add(L.abs_gamma, "Gamma Absoluta");
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
  if (!ok) { toast("No se pudo copiar", "El navegador bloqueó el portapapeles."); return; }
  btn.textContent = "Copiado"; setTimeout(() => { btn.textContent = "TradingView"; }, 1600);
  toast(`Niveles de ${d.symbol} copiados`, `${text.split("\n").length} niveles. En TradingView: Ajustes del indicador ▸ Entradas ▸ pega en el cuadro de texto.`);
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
  img.onerror = () => { URL.revokeObjectURL(url); setStatus("err", "No se pudo generar la imagen"); console.error("svgToPng: la imagen SVG no se pudo cargar"); };
  img.src = url;
}

/* informe: resumen de niveles + gráfico por strike + mapa, en una sola imagen */
async function exportReport() {
  const d = state.data;
  if (!d) return;
  setStatus("busy", "Preparando informe…");
  if (!state.heat || state.heatKey !== heatParams()) {
    try {
      const r = await fetch("/api/heatmap?" + heatParams());
      const hm = await r.json();
      if (!r.ok) throw new Error(hm.error);
      state.heat = hm; state.heatKey = heatParams(); state.heatImg = null;
    } catch (e) { setStatus("err", "No se pudo calcular el mapa para el informe"); return; }
  }
  // Informe con la misma estetica que la web: tarjetas sobre el fondo, cabecera con precio, regimen y niveles
  // (con su cambio frente a la sesion anterior), Impacto calls y puts con la ficha, barras por strike y TRACE
  const W = 2000, G = 24, headH = 400, impH = 760, chartH = 700, mapH = 920, footH = 70;
  const yImp = headH + G, yStrike = yImp + impH + G, yMap = yStrike + chartH + G, H = yMap + mapH + footH;
  const cardW = 600, impW = W - cardW - G;
  const geo = state.geo, greek = state.greek, mapMode = state.mapMode;
  state.greek = "gamma"; state.heatImg = null;
  const impSvg = typeof renderImpact === "function" ? renderImpact(d, impW, impH, true).replace("<svg ", `<svg x="0" y="${yImp}" `) : "";
  const strikeSvg = renderStrike(d, W, chartH, true).replace("<svg ", `<svg x="0" y="${yStrike}" `);
  const mapSvg = renderMap(d, state.heat, W, mapH, true).replace("<svg ", `<svg x="0" y="${yMap}" `);
  state.greek = greek; state.mapMode = mapMode; state.geo = geo; state.heatImg = null;

  const L = d.levels, t = d.totals, em = move1(d), hb = d.hub || {};
  const dte = DTE_LABEL[state.dte] || "";
  const neg = d.regime === "negative";
  const T = (x, y, str, o = {}) => `<text x="${x}" y="${y}" text-anchor="${o.a || "start"}" font-family="${SANS}" font-size="${o.fs || 22}" font-weight="${o.w || 400}" fill="${o.c || C.text}">${str}</text>`;
  const card = (x, y, w, h) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="22" fill="${C.surface}" stroke="${C.axis}" stroke-opacity="0.6"/>`;
  let s = `<rect width="${W}" height="${H}" fill="${C.ink}"/>` + card(0, 0, W, headH);

  // --- cabecera: identidad, precio y regimen
  const date = (d.session || (d.computed_at || "").slice(0, 10)).split("-").reverse().join("/");
  s += T(56, 74, esc(d.symbol), { fs: 46, w: 700 });
  s += T(56 + textW(d.symbol, 46) * 1.05 + 20, 74, `${esc(d.name || "")}${d.combo ? ` + ${esc(d.combo.proxy)}` : ""}`, { fs: 22, c: C.muted });
  s += T(56, 112, `${dte} · ${date} · ${state.pos === "flow" ? "dealers según el flujo" : "convención estándar"}`, { fs: 19, c: C.faint });
  s += T(56, 200, fmtSpot(d.spot), { fs: 76, w: 600 });
  const chg = d.chg_pct;
  if (chg != null && !d.spot_manual) s += T(56 + textW(fmtSpot(d.spot), 76) * 1.02 + 22, 200, fmtPct(chg), { fs: 28, w: 500, c: chg >= 0 ? C.put : C.call });
  s += `<rect x="56" y="232" width="${textW(neg ? "Gamma negativa" : "Gamma positiva", 20) + 34}" height="38" rx="19" fill="${neg ? C.neg : C.pos}" fill-opacity="0.16"/>`;
  s += `<circle cx="74" cy="251" r="5" fill="${neg ? C.neg : C.pos}"/>` + T(86, 258, neg ? "Gamma negativa" : "Gamma positiva", { fs: 20, w: 600, c: neg ? C.neg : C.pos });
  s += T(56, 300, neg ? "Por debajo del flip: la cobertura de los dealers" : "Por encima del flip: la cobertura de los dealers", { fs: 20, c: C.muted });
  s += T(56, 326, neg ? "tiende a amplificar los movimientos." : "tiende a frenar los movimientos.", { fs: 20, c: C.muted });
  // GEX neta con la barra calls/puts
  const cA = Math.abs(t.call_per_pct || 0), pA = Math.abs(t.put_per_pct || 0), tot = cA + pA || 1;
  s += T(56, 356, "GEX neta por 1%", { fs: 19, c: C.muted }) + T(600, 356, fmtBig(t.net_per_pct, true), { a: "end", fs: 24, w: 600 });
  s += `<rect x="56" y="370" width="${544 * cA / tot - 2}" height="8" rx="4" fill="${C.pos}"/><rect x="${56 + 544 * cA / tot + 2}" y="370" width="${544 * pA / tot - 2}" height="8" rx="4" fill="${C.neg}"/>`;

  // --- niveles con distancia y cambio frente a la sesion anterior
  const rows = levelItems(d);
  if (L.abs_gamma != null && !rows.some((r) => r.v === L.abs_gamma)) rows.push({ key: "abs_gamma", name: "Gamma absoluta", v: L.abs_gamma, c: C.muted });
  rows.push({ key: "spot", name: "Spot", v: d.spot, c: C.text, spot: true });
  rows.sort((a, b) => b.v - a.v);
  const lx = 700, ly0 = 64, lh = Math.min(50, (headH - 90) / Math.max(1, rows.length));
  s += T(lx, 40, "NIVELES", { fs: 16, w: 600, c: C.faint });
  rows.forEach((r, i) => {
    const y = ly0 + 18 + i * lh;
    s += r.spot ? `<circle cx="${lx + 8}" cy="${y - 7}" r="8" fill="${C.text}"/>` : `<circle cx="${lx + 8}" cy="${y - 7}" r="8" fill="none" stroke="${r.c}" stroke-width="3"/>`;
    s += T(lx + 30, y, r.name, { fs: 22, c: r.spot ? C.text : C.muted, w: r.spot ? 600 : 400 });
    s += T(lx + 400, y, r.spot ? fmtSpot(r.v) : fmtLevel(r.v), { a: "end", fs: 24, w: 600 });
    if (!r.spot) s += T(lx + 500, y, fmtPct((r.v / d.spot - 1) * 100), { a: "end", fs: 18, c: C.faint });
    const p = d.prev;
    if (!r.spot && p && r.key in p && p[r.key] != null) {
      const was = p[r.key], same = Math.abs(was - r.v) < 1e-9, up = r.v > was;
      s += same ? T(lx + 530, y, `igual que el ${ddmm(p.date)}`, { fs: 17, c: C.faint })
        : T(lx + 530, y, `${ddmm(p.date)}: ${fmtLevel(was)}`, { fs: 17, c: C.faint }) +
          T(lx + 530 + textW(`${ddmm(p.date)}: ${fmtLevel(was)}`, 17) + 10, y, `${up ? "▲" : "▼"} ${fmtLevel(Math.abs(r.v - was))}`, { fs: 17, w: 600, c: up ? C.put : C.call });
    }
  });

  // --- cifras clave
  const m5 = d.moves && d.moves.d5;
  const facts = [
    [`Rango 1σ, ${rangeLabel(em)}`, em ? `±${fmtNum(em.pct, 2)}%` : "—", em ? `${fmtSpot(em.lo)} – ${fmtSpot(em.hi)}` : ""],
    ["Rango 1σ, 5 sesiones", m5 ? `±${fmtNum(m5.pct, 2)}%` : "—", m5 ? `${fmtSpot(m5.lo)} – ${fmtSpot(m5.hi)}` : ""],
    ["Vanna (IV −1 pt)", `${t.vanna_flow >= 0 ? "+" : "−"}${fmtBig(Math.abs(t.vanna_flow), true)}`, ""],
    [charmLabel(d), `${t.charm_flow >= 0 ? "+" : "−"}${fmtBig(Math.abs(t.charm_flow), true)}`, ""],
    ["Zero gamma (perfil)", L.zero_gamma != null ? fmtLevel(L.zero_gamma) : "—", ""],
  ];
  const fx = 1480, fr = W - 56;
  s += T(fx, 40, "CIFRAS", { fs: 16, w: 600, c: C.faint });
  facts.forEach(([k, v, sub], i) => {
    const y = 84 + i * 62;
    s += T(fx, y, esc(k), { fs: 20, c: C.muted }) + T(fr, y, esc(v), { a: "end", fs: 26, w: 600 });
    if (sub) s += T(fr, y + 22, sub, { a: "end", fs: 16, c: C.faint });
  });

  // --- ficha (como en el Equity Hub)
  const cr = ((typeof hub !== "undefined" && hub.cmp) || (cmp.data && cmp.data.rows) || []).find((r) => r.symbol === d.symbol);
  const pc = (v) => (v == null ? "—" : fmtNum(v * 100, 1) + "%");
  const exd = (iso) => (iso ? `${ddmm(iso)}/${iso.slice(2, 4)}` : "—");
  const vp = (v, edge) => (v != null ? fmtLevel(v) : edge && hb.range ? (edge === "up" ? `por encima de ${fmtSpot(hb.range[1])}` : `por debajo de ${fmtSpot(hb.range[0])}`) : "—");
  const ficha = [
    ["Cierre anterior", fmtSpot(d.prev_close)],
    ["IV rank", cr && cr.y != null ? fmtNum(cr.y, 0) + "%" : "—"],
    ["IV 30 días", pc(hb.iv30)],
    ["Vol. realizada 20 días", pc(hb.rv20)],
    ["Punto de baja volatilidad", vp(hb.low_vol_point, hb.low_vol_edge)],
    ["Punto de alta volatilidad", vp(hb.high_vol_point, hb.high_vol_edge)],
    ["Gamma de calls (1%)", fmtBig(t.call_per_pct, true)],
    ["Gamma de puts (1%)", fmtBig(t.put_per_pct, true)],
    ["Venc. con más gamma", exd(hb.top_gamma_exp)],
    ["Venc. con más delta", exd(hb.top_delta_exp)],
    ["Volumen calls / puts", `${hb.call_vol != null ? fmtBig(hb.call_vol) : "—"} / ${hb.put_vol != null ? fmtBig(hb.put_vol) : "—"}`],
    ["Ratio put/call (OI)", hb.pc_oi != null ? fmtNum(hb.pc_oi, 2) : "—"],
  ];
  const cx0 = impW + G;
  s += card(cx0, yImp, cardW, impH) + T(cx0 + 36, yImp + 52, "FICHA", { fs: 16, w: 600, c: C.faint });
  const rh = (impH - 100) / ficha.length;
  ficha.forEach(([k, v], i) => {
    const y = yImp + 100 + i * rh;
    s += T(cx0 + 36, y, esc(k), { fs: 21, c: C.muted }) + T(cx0 + cardW - 36, y, esc(v), { a: "end", fs: 22, w: 600 });
    if (i < ficha.length - 1) s += `<line x1="${cx0 + 36}" x2="${cx0 + cardW - 36}" y1="${y + rh / 2 - 6}" y2="${y + rh / 2 - 6}" stroke="${C.grid}"/>`;
  });

  // --- pie
  s += T(56, H - 28, "GEX Lab · datos de CBOE diferidos (~15 min) · open interest del cierre anterior · no es asesoramiento financiero", { fs: 17, c: C.faint });
  s += T(W - 56, H - 28, `Generado ${new Date().toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" })}`, { a: "end", fs: 17, c: C.faint });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${s}${impSvg}${strikeSvg}${mapSvg}</svg>`;
  svgToPng(svg, W, H, `Informe_${d.symbol}_${d.session || ""}.png`, 1.25);
  setStatus("", `Informe de ${d.symbol} generado`);
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
  if (!q) { renderSuggest(recents(), recents().length ? "Recientes" : ""); return; }
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
    if (d.instalado === false && !u) { el.innerHTML = `<span class="cdot off"></span>Recolector no instalado`; el.title = "Ejecuta «Instalar recolector.bat» en la carpeta de la app"; return; }
    if (!u) { el.innerHTML = `<span class="cdot"></span>Recolector instalado, sin recogidas aún`; return; }
    const errs = Object.keys(u.errores || {});
    el.innerHTML = `<span class="cdot ${errs.length ? "warn" : ""}"></span>Recolector: ${({ cierre: "cierre", apertura: "apertura", intradia: "intradía", reintento: "reintento" })[u.tipo] || u.tipo} del ${ddmm(u.sesion)}, ${u.ok}/${u.total} tickers`;
    el.title = `Hora: ${nyWhen(u.hora)}. ${errs.length ? "Con error: " + errs.join(", ") : "Sin errores"}.${d.instalado === false ? " Las tareas de Windows no están instaladas." : ""}`;
  } catch { el.textContent = ""; }
}

function setMode(m) {
  state.mode = m; store.set("mode", m);
  syncNav();
  const macro = m === "vix" || m === "cot" || m === "summary";
  document.body.classList.toggle("scan", m === "scanner" || macro || m === "vol");
  document.body.classList.toggle("macro-mode", macro);
  document.body.classList.toggle("vol-mode", m === "vol");
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
  $("scanStatus").textContent = `Calculando ${list.length} tickers…`;
  const known = Object.fromEntries(scanState.rows.map((r) => [r.symbol, r]));
  scanState.rows = list.map((s) => known[s] ? { ...known[s], stale: true } : { symbol: s, loading: true });
  renderScan();
  try {
    const r = await fetch(`/api/scan?dte=${state.dte}&symbols=${encodeURIComponent(list.join(","))}`, { signal: scanState.ctrl.signal });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Error en el escáner");
    // en la nube el escaner es el del ultimo ciclo: los tickers recien anadidos aparecen como pendientes y se
    // vuelve a consultar cada 15 s hasta que el motor los incluye (1-2 min)
    const have = new Set(d.rows.map((x) => x.symbol));
    const missing = list.filter((s) => !have.has(s));
    scanState.rows = d.rows.concat(missing.map((s) => ({ symbol: s, loading: true })));
    const ok = d.rows.filter((x) => !x.error).length;
    $("scanStatus").textContent = missing.length && ME && ME.nube
      ? `Calculando ${missing.join(", ")} en la nube (1–2 min)…`
      : `${ok} de ${d.rows.length} tickers, calculado ${nyWhen(d.computed_at)}`;
    clearTimeout(scanState.retry);
    if (missing.length && ME && ME.nube && (scanState.tries = (scanState.tries || 0) + 1) <= 20) {
      scanState.retry = setTimeout(() => { if (state.mode === "scanner") runScan(); }, 15000);
    } else if (!missing.length) scanState.tries = 0;
  } catch (e) {
    if (e.name === "AbortError") return;
    $("scanStatus").textContent = e.message === "Failed to fetch" ? "El servidor local no responde" : e.message;
    scanState.rows = scanState.rows.map((x) => x.loading ? { symbol: x.symbol, error: "Sin datos" } : x);
  } finally {
    $("scanBtn").disabled = false;
  }
  renderScan();
}

function levelCell(v, dist, prevV, step) {
  if (v == null) return `<td>—</td>`;
  const dec = Number.isInteger(v) ? 0 : decFor(step || 1);
  let mv = "";
  if (prevV != null && Math.abs(prevV - v) > 1e-9) {
    const up = v > prevV;
    mv = `<span class="mv ${up ? "up" : "dn"}" title="Antes ${fmtNum(prevV, Number.isInteger(prevV) ? 0 : dec)}">${up ? "▲" : "▼"}</span>`;
  }
  const near = dist != null && Math.abs(dist) < 0.5 ? " near" : "";
  return `<td><span class="lv">${fmtNum(v, dec)}</span>${mv}<span class="ds${near}">${dist == null ? "" : fmtPct(dist)}</span></td>`;
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
    body.innerHTML = `<tr class="err"><td colspan="11" class="l">${scanState.rows.length ? "Ningún ticker cumple el filtro." : "Añade tickers para empezar."}</td></tr>`;
    return;
  }
  body.innerHTML = rows.map((r) => {
    const rm = `<td><button class="rm" data-rm="${esc(r.symbol)}" title="Quitar ${esc(r.symbol)}" aria-label="Quitar ${esc(r.symbol)}">×</button></td>`;
    if (r.loading) return `<tr class="loading"><td class="l"><span class="tk">${esc(r.symbol)}</span></td><td colspan="9" class="l">Calculando…</td>${rm}</tr>`;
    if (r.error) return `<tr class="err"><td class="l"><span class="tk">${esc(r.symbol)}</span></td><td colspan="9" class="l">${esc(r.error)}</td>${rm}</tr>`;
    const p = r.prev || {};
    const neg = r.regime === "negative";
    return `<tr data-s="${esc(r.symbol)}"${r.stale ? ' style="opacity:.55"' : ""}>
      <td class="l"><span class="tk">${esc(r.symbol)}</span><span class="nm">${esc(r.name || "")}</span></td>
      <td>${fmtSpot(r.spot)}</td>
      <td class="chg ${r.chg >= 0 ? "up" : "dn"}">${r.chg == null ? "—" : fmtPct(r.chg)}</td>
      <td class="l"><span class="rg ${neg ? "neg" : "pos"}"><i></i>${neg ? "Negativa" : "Positiva"}</span></td>
      ${levelCell(r.flip, r.flip_dist, p.flip, r.step)}
      ${levelCell(r.call_wall, r.call_dist, p.call_wall, r.step)}
      ${levelCell(r.put_wall, r.put_dist, p.put_wall, r.step)}
      <td>${fmtBig(r.net_per_pct, true)}</td>
      <td>${r.em_pct == null ? "—" : "±" + fmtNum(r.em_pct, 2) + "%"}</td>
      <td>${fmtNum((r.front_share || 0) * 100, 0)}%</td>
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
  $("cBody").innerHTML = rows.map((r) => {
    const on = !hid.has(r.symbol), bad = r.error || r.x == null || r.y == null;
    return `<tr class="${on ? "" : "off"}${bad ? " bad" : ""}" data-s="${esc(r.symbol)}"><td class="x"><button class="eye" aria-pressed="${on}" title="${on ? "Ocultar" : "Mostrar"} ${esc(r.symbol)}">${eye(on)}</button></td>
      <td class="l"><span class="tk">${esc(r.symbol)}</span></td><td>${r.iv30 != null ? fmtNum(r.iv30 * 100, 1) + "%" : "—"}</td>
      <td>${r.x != null ? fmtNum(r.x, 0) : "—"}</td><td>${r.y != null ? fmtNum(r.y, 0) : "—"}</td></tr>`;
  }).join("") || `<tr><td colspan="5" class="l na">Sin coincidencias</td></tr>`;
  const vis = d.rows.filter((r) => !hid.has(r.symbol) && !r.error && r.x != null).length;
  $("cCount").textContent = `${vis} de ${d.rows.length} tickers visibles`;
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
  body.innerHTML = `<tr class="loading"><td colspan="7" class="l">Calculando…</td></tr>`;
  try {
    const r = await fetch(`/api/validation?dte=${state.dte}&mode=${state.validMode}&model=${state.model === "gexbot" ? "gexbot" : "spotgamma"}&symbols=${encodeURIComponent(watchlist().join(","))}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Error en la validación");
    const pct = (v, n) => v == null ? `<span class="na">—</span>` : `${fmtNum(v, 0)}%${n != null ? `<span class="ds">${n} ses.</span>` : ""}`;
    const rng = (v, n) => v == null ? `<span class="na">—</span>` : `${fmtNum(v, 2)}%<span class="ds">${n} ses.</span>`;
    const row = (x, cls = "") => `<tr class="${cls}"><td class="l"><span class="tk">${esc(x.symbol)}</span></td>
      <td>${x.n}</td><td>${rng(x.range_pos, x.n_pos)}</td><td>${rng(x.range_neg, x.n_neg)}</td>
      <td>${pct(x.cw_held)}</td><td>${pct(x.pw_held)}</td><td>${pct(x.em_hit, x.n_em)}</td></tr>`;
    body.innerHTML = d.rows.map((x) => row(x)).join("") + row({ ...d.total, symbol: "Total" }, "total");
    $("scanStatus").textContent = d.total.n ? `${d.total.n} sesiones evaluadas (${d.total.n_ante} con niveles de antes de la apertura)` : "Aún no hay sesiones guardadas para evaluar";
  } catch (e) {
    body.innerHTML = `<tr class="err"><td colspan="7" class="l">${esc(e.message)}</td></tr>`;
  }
}

async function loadCompass(force = false) {
  const key = watchlist().join(",");
  if (!force && cmp.data && cmp.key === key) { renderCompass(); return; }
  if (cmp.ctrl) cmp.ctrl.abort();
  cmp.ctrl = new AbortController();
  $("compass").innerHTML = `<div class="placeholder">Calculando volatilidad de ${watchlist().length} tickers…</div>`;
  $("scanStatus").textContent = "Calculando Compass…";
  try {
    const r = await fetch("/api/compass?symbols=" + encodeURIComponent(key), { signal: cmp.ctrl.signal });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Error en el Compass");
    cmp.data = d; cmp.key = key;
    const ok = d.rows.filter((x) => !x.error).length;
    $("scanStatus").textContent = `${ok} de ${d.rows.length} tickers en el Compass`;
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
  s += q((L + mx) / 2, T + 34, "Volatilidad cara", "potencial alcista", "middle");
  s += q((mx + R) / 2, T + 34, "Volatilidad cara", "potencial bajista", "middle");
  s += q((L + mx) / 2, B - 40, "Volatilidad barata", "potencial alcista", "middle");
  s += q((mx + R) / 2, B - 40, "Volatilidad barata", "potencial bajista", "middle");
  s += `<text x="${mx}" y="${T - 14}" text-anchor="middle" font-family="${SANS}" font-size="${f}" fill="${C.muted}">IV rank alto</text>`;
  s += `<text x="${mx}" y="${B + 26}" text-anchor="middle" font-family="${SANS}" font-size="${f}" fill="${C.muted}">IV rank bajo</text>`;
  s += `<text transform="translate(${L - 24},${my}) rotate(-90)" text-anchor="middle" font-family="${SANS}" font-size="${f}" fill="${C.muted}">Risk reversal rank bajo</text>`;
  s += `<text transform="translate(${R + 24},${my}) rotate(90)" text-anchor="middle" font-family="${SANS}" font-size="${f}" fill="${C.muted}">Risk reversal rank alto</text>`;

  // leyenda de estados
  const lg = (cx, label, kind) => `<circle cx="${cx}" cy="${H - 16}" r="5" fill="${kind === "full" ? "#8b7cf0" : C.surface}" stroke="#8b7cf0" stroke-width="${kind === "full" ? 1 : 2}"/>` +
    (kind === "half" ? `<path d="M${cx} ${H - 21} A5 5 0 0 0 ${cx} ${H - 11} Z" fill="#8b7cf0"/>` : "") +
    `<text x="${cx + 11}" y="${H - 12}" font-family="${SANS}" font-size="12" fill="${C.muted}">${label}</text>`;
  s += lg(L, "Los dos ejes con su propia historia", "full") + lg(L + 250, "IV rank con su historia, RR provisional", "half") + lg(L + 520, "Provisional (frente a la lista)", "empty");
  const hid = cmpHidden();
  const pts = d.rows.filter((r) => !r.error && r.x != null && r.y != null && !hid.has(r.symbol));
  const placed = [];
  cmp.geo = [];
  for (const r of pts) {
    const x = xOf(r.x), y = yOf(r.y);
    let tr = "";
    if (r.trail && r.trail.length) {
      const chain = [...r.trail.filter((t) => t.x != null && t.y != null), { x: r.x, y: r.y }];
      tr = `<polyline points="${chain.map((t) => `${xOf(t.x)},${yOf(t.y)}`).join(" ")}" fill="none" stroke="${C.pos}" stroke-opacity="0.45" stroke-width="1.5"/>` +
        chain.slice(0, -1).map((t, k) => `<circle cx="${xOf(t.x)}" cy="${yOf(t.y)}" r="2.5" fill="${C.pos}" fill-opacity="${0.25 + 0.15 * k}"/>`).join("");
    }
    // etiqueta sin solaparse
    let ly = y - 12;
    for (let k = 0; k < 6 && placed.some((p) => Math.abs(p.x - x) < 44 && Math.abs(p.y - ly) < 14); k++) ly += (k % 2 ? -1 : 1) * 14 * (k + 1);
    placed.push({ x, y: ly });
    const own = r.full;
    const half = !own && r.y_src && r.y_src !== "provisional";
    s += `<g class="cpt" data-s="${esc(r.symbol)}">${tr}
      <circle class="dot" cx="${x}" cy="${y}" r="6" fill="${own ? "#8b7cf0" : C.surface}" stroke="#8b7cf0" stroke-width="${own ? 1 : 2}"/>
      ${half ? `<path d="M${x} ${y - 6} A6 6 0 0 0 ${x} ${y + 6} Z" fill="#8b7cf0"/>` : ""}
      <text x="${x}" y="${ly}" text-anchor="middle" font-family="${SANS}" font-size="13" font-weight="600" fill="${C.text}">${esc(r.symbol)}</text></g>`;
    cmp.geo.push({ x, y, r });
  }
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${s}</svg>`;

  const prov = pts.filter((r) => !r.full);
  const errs = d.rows.filter((r) => r.error).map((r) => r.symbol);
  $("compassNote").textContent = (prov.length
    ? `Un eje provisional compara el ticker con el resto de tu lista; pasa a compararse con su propia historia al tener ${d.min_days} sesiones guardadas. El IV rank de SPX, SPY, NDX, QQQ, DIA, AAPL, AMZN, GOOGL y algunos más ya usa un año de su índice de volatilidad de CBOE (VIX, VXN, VXAPL…). `
    : "Ranks calculados frente al histórico guardado de cada ticker. ") +
    (errs.length ? `Sin datos: ${errs.join(", ")}.` : "") +
    (d.vol_index_missing && d.vol_index_missing.length ? ` CBOE no está sirviendo ahora el histórico de ${d.vol_index_missing.join(", ")}: esos tickers usan el rank provisional hasta que vuelva.` : "") +
    " Haz clic en un punto para abrir su análisis.";
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
  tip.innerHTML = `<div class="t">${esc(r.symbol)} <span style="color:var(--muted);font-weight:400">${esc(r.name || "")}</span></div>
    <div class="r">IV 30 días <b>${r.iv30 != null ? fmtNum(r.iv30 * 100, 1) + "%" : "—"}</b></div>
    <div class="r">Vol. realizada 20d <b>${r.rv20 != null ? fmtNum(r.rv20 * 100, 1) + "%" : "—"}</b></div>
    <div class="r">IV / realizada <b>${r.vrp != null ? fmtNum(r.vrp, 2) : "—"}</b></div>
    <div class="r">Risk reversal 25Δ <b>${r.rr25 != null ? (r.rr25 > 0 ? "+" : "−") + fmtNum(Math.abs(r.rr25 * 100), 1) + " pts" : "—"}</b></div>
    <div class="r">IV rank <b>${fmtNum(r.y, 0)} ${r.y_src === "provisional" ? "(provisional)" : r.y_src === "propio" ? "(histórico propio)" : `(${r.y_src}, 1 año)`}</b></div>
    <div class="r">RR rank <b>${fmtNum(r.x, 0)} ${r.x_src === "provisional" ? "(provisional)" : "(histórico propio)"}</b></div>
    ${r.vol_index ? `<div class="r">${r.vol_index.index} <b>${fmtNum(r.vol_index.value, 2)} (rango ${fmtNum(r.vol_index.lo, 1)}–${fmtNum(r.vol_index.hi, 1)})</b></div>` : ""}
    <div class="r">Histórico guardado <b>${r.days}/${cmp.data.min_days} sesiones</b></div>`;
  tip.hidden = false;
  let tx = x + 16, ty = y - tip.offsetHeight - 10;
  if (tx + tip.offsetWidth > rect.width - 8) tx = x - tip.offsetWidth - 16;
  if (ty < 0) ty = y + 16;
  tip.style.left = tx + "px"; tip.style.top = ty + "px";
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
  $("cBody").addEventListener("click", (e) => {
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
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const PURPLE = "#8b7cf0";
function monLabel(iso) { return MESES[+iso.slice(5, 7) - 1] + " " + iso.slice(2, 4); }
function sgnPct(v, dec = 1) { return v == null || !isFinite(v) ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "") + fmtNum(Math.abs(v * 100), dec) + "%"; }
function longDate(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" });
}
const _measure = document.createElement("canvas").getContext("2d");
function textW(s, fs) { _measure.font = `${fs}px ${SANS}`; return _measure.measureText(s).width; }
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
  const t = d.term_time ? ` · índices ${hhmm(utcDate(d.term_time))}` : "";
  return `Cierre ${ddmm(d.date)}${t}`;
}

async function loadVix(refresh = false) {
  if (vx.ctrl) vx.ctrl.abort();
  vx.ctrl = new AbortController();
  $("refreshBtn").classList.add("spin");
  setStatus("busy", "Cargando la curva del VIX…");
  if (!vx.data) $("vxCurve").innerHTML = `<div class="empty">Descargando los futuros del VIX de CBOE. La primera vez tarda unos segundos.</div>`;
  try {
    const r = await fetch("/api/vix" + (refresh ? "?refresh=1" : ""), { signal: vx.ctrl.signal });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "No se pudo cargar la curva");
    vx.data = d; vx.at = Date.now();
    if (state.mode === "vix") { renderVix(); setStatus("", vixStatus()); }
  } catch (e) {
    if (e.name === "AbortError") return;
    if (state.mode === "vix") {
      setStatus("err", vx.data ? "No se pudo actualizar" : "Sin datos");
      if (!vx.data) $("vxCurve").innerHTML = `<div class="empty">${esc(e.message === "Failed to fetch" ? "El servidor local no responde. Vuelve a abrir GEX Lab." : e.message)}</div>`;
    }
  } finally { $("refreshBtn").classList.remove("spin"); }
}

const SHAPE_CLASS = { contango: "contango", backwardation: "backwardation", front_inverted: "mixed", hump: "mixed", flat: "mixed" };
const SHAPE_COLOR = { contango: C.put, backwardation: C.call, front_inverted: C.amber, hump: C.amber, flat: C.amber };
const SHAPE_LABEL = { contango: "Contango", backwardation: "Backwardation", front_inverted: "Invertida en el tramo corto", hump: "Joroba", flat: "Plana" };

function renderVix() {
  const d = vx.data;
  if (!d) return;
  const sh = d.shape.code, p = d.points;
  const st = $("vxState");
  st.textContent = d.shape.label; st.className = "mstate " + SHAPE_CLASS[sh];
  $("vxSub").textContent = `Cierre oficial del ${longDate(d.date)}`;
  const spr = `<b>${sgnPct(d.spread)}</b>`, bas = `<b>${sgnPct(d.basis)}</b>`;
  const reads = {
    contango: `El segundo vencimiento cotiza ${spr} sobre el primero y el primero ${bas} sobre el VIX. Estructura normal: el mercado no descuenta estrés inmediato y los futuros tienden a converger a la baja hacia el VIX.`,
    backwardation: `El primer vencimiento cotiza por encima del segundo (${spr}) y el VIX por encima del primero. Se paga más por protección inmediata que a plazo: es la firma de los episodios de estrés. La vuelta a contango suele acompañar a la normalización.`,
    front_inverted: `El VIX al contado está por encima del primer futuro (${bas}), pero la curva vuelve a subir después (${spr}). Tensión a muy corto plazo que el mercado espera que se relaje.`,
    hump: `El primer futuro está por encima del VIX (${bas}) y del segundo (${spr}). El mercado concentra el riesgo en el próximo vencimiento: suele reflejar un evento concreto en esa ventana (elecciones, Fed, datos).`,
    flat: `El VIX, el primer y el segundo vencimiento están a menos de un ${fmtNum((d.flat_tol || 0.005) * 100, 1)}% entre sí (${bas} y ${spr}). Curva plana: transición entre regímenes; conviene vigilar hacia qué lado se resuelve.`,
  };
  $("vxRead").innerHTML = reads[sh];
  const live = (d.term || []).find((t) => t.symbol === "VIX");
  const ratio = d.vix_vix3m;
  const fact = (l, v, s, warn, g) => `<div class="fact"><span class="fl"${g ? ` data-g="${g}"` : ""}>${l}</span><strong>${v}</strong><span class="fs${warn ? " warn" : ""}">${s}</span></div>`;
  $("vxFacts").innerHTML = [
    fact("VIX", fmtNum(d.vix_close, 2), live && Math.abs(live.value - d.vix_close) > 0.005 ? `al cierre · ahora ${fmtNum(live.value, 2)}` : "al cierre", false, "vix"),
    fact(`M1 · ${monLabel(p[0].expiry)}`, fmtNum(d.m1, 2), `${p[0].days} días · ${sgnPct(d.basis)} sobre el VIX`, false, "m1"),
    fact(`M2 · ${monLabel(p[1].expiry)}`, fmtNum(d.m2, 2), `${p[1].days} días`, false, "m2"),
    fact("Pendiente M2 / M1", sgnPct(d.spread), `percentil ${fmtNum(d.spread_pct_rank, 0)} del último año`, false, "slope"),
    fact("Futuro a 30 días", fmtNum(d.cm30, 2), "interpolado entre vencimientos", false, "cm30"),
    fact("VIX / VIX3M", ratio ? fmtNum(ratio, 2) : "—", ratio ? (ratio >= 1 ? "por encima de 1: tensión a corto plazo" : "por debajo de 1: estructura normal") : "sin dato", ratio >= 1, "vix3m"),
    fact("Racha", `${d.streak} ${d.streak === 1 ? "sesión" : "sesiones"}`, `en ${d.streak_contango ? "contango" : "backwardation"} (M2/M1) · ${fmtNum(d.contango_share * 100, 0)}% del año en contango`, false, "streak"),
  ].join("");
  const idx = d.term_live === false ? "al cierre (con el mercado cerrado)" : "en directo (15 min)";
  $("vxCap").textContent = `Cierres oficiales de CBOE. Índices VIX9D a VIX1Y ${idx}. Puntos huecos: vencimientos con menos de 1.000 contratos abiertos.`;
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
  const week = series(d.week), month = series(d.month);
  const term = (d.term || []).map((t) => ({ days: t.days, v: t.value, sym: t.symbol }));
  const all = [...today, ...week, ...month, ...term].map((x) => x.v).filter((v) => v != null);
  const xmax = Math.max(...[...today, ...term].map((x) => x.days)) * 1.04 + 4;
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
  if (month.length) s += `<path d="${path(month)}" fill="none" stroke="${C.faint}" stroke-width="1.4" stroke-dasharray="2 4"/>`;
  if (week.length) s += `<path d="${path(week)}" fill="none" stroke="${C.muted}" stroke-width="1.4" stroke-dasharray="6 4" stroke-opacity="0.8"/>`;
  if (term.length) {
    s += `<path d="${path(term)}" fill="none" stroke="${PURPLE}" stroke-width="1.5" stroke-opacity="0.85"/>`;
    for (const q of term) {
      s += `<rect x="${xOf(q.days) - 3.5}" y="${yOf(q.v) - 3.5}" width="7" height="7" rx="1.5" fill="${C.surface}" stroke="${PURPLE}" stroke-width="1.5"/>`;
      if (q.sym !== "VIX") {
        const fut = interpAt(today, q.days);
        const above = fut == null || q.v >= fut;
        s += txt(xOf(q.days), yOf(q.v) + (above ? -10 : 19), q.sym, { a: "middle", fs: 11, c: PURPLE });
      }
    }
  }
  const col = SHAPE_COLOR[d.shape.code];
  s += `<path d="${path(today)}" fill="none" stroke="${col}" stroke-width="2.2"/>`;
  vx.curveGeo = [];
  today.forEach((q, k) => {
    const x = xOf(q.days), y = yOf(q.v);
    const thin = q.x && q.x.oi < 1000;
    s += `<circle cx="${x}" cy="${y}" r="${q.spot ? 5 : 4}" fill="${thin ? C.surface : col}" stroke="${col}" stroke-width="${thin ? 1.6 : 1}"/>`;
    if (k <= 8 && (k === 0 || x - xOf(today[k - 1].days) > 34)) s += txt(x, y - 11, fmtNum(q.v, 2), { a: "middle", mono: true, fs: 11.5, c: C.text });
    vx.curveGeo.push({ x, y, q });
  });
  for (const q of term) vx.curveGeo.push({ x: xOf(q.days), y: yOf(q.v), term: q });
  // leyenda
  const items = [["Hoy", col, ""], ["Hace 1 semana", C.muted, "6 4"], ["Hace 1 mes", C.faint, "2 4"], ["Índices VIX9D–VIX1Y", PURPLE, ""]]
    .filter((it, k) => (k === 1 ? week.length : k === 2 ? month.length : k === 3 ? term.length : true));
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
  if (best.term) {
    const t = d.term.find((z) => z.symbol === best.term.sym);
    html = `<div class="t">${best.term.sym}</div><div class="r">Volatilidad implícita del SPX a ${best.term.days} días <b>${fmtNum(t.value, 2)}</b></div>` +
      (t.prev ? `<div class="r">Cierre anterior <b>${fmtNum(t.prev, 2)}</b></div>` : "");
  } else if (best.q.spot) {
    html = `<div class="t">VIX al contado</div><div class="r">Cierre <b>${fmtNum(d.vix_close, 2)}</b></div>` +
      (d.week && d.week.vix ? `<div class="r">Hace 1 semana <b>${fmtNum(d.week.vix, 2)}</b></div>` : "") +
      (d.month && d.month.vix ? `<div class="r">Hace 1 mes <b>${fmtNum(d.month.vix, 2)}</b></div>` : "");
  } else {
    const c = best.q.x;
    const old = (b) => (b ? (b.points.find((z) => z.expiry === c.expiry) || {}).settle : null);
    const w = old(d.week), m = old(d.month);
    html = `<div class="t">Futuro ${monLabel(c.expiry)} <span style="color:var(--muted);font-weight:400">vence ${ddmm(c.expiry)}</span></div>
      <div class="r">Cierre <b>${fmtNum(c.settle, 2)}</b></div>
      <div class="r">Días al vencimiento <b>${c.days}</b></div>
      ${w ? `<div class="r">Hace 1 semana <b>${fmtNum(w, 2)}</b></div>` : ""}
      ${m ? `<div class="r">Hace 1 mes <b>${fmtNum(m, 2)}</b></div>` : ""}
      <div class="r">Open interest <b>${fmtNum(c.oi)}</b></div>
      <div class="r">Volumen <b>${fmtNum(c.vol)}</b></div>`;
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
  macroTip("vxTip", null, e, `<div class="t">${new Date(x.date + "T12:00:00").toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric" })}</div>
    <div class="r">VIX <b>${x.vix != null ? fmtNum(x.vix, 2) : "—"}</b></div>
    <div class="r">M1 <b>${fmtNum(x.m1, 2)}</b></div><div class="r">M2 <b>${fmtNum(x.m2, 2)}</b></div>
    <div class="r">M2 / M1 <b>${sgnPct(x.spread)}</b></div><div class="r">Forma <b>${lab}</b></div>`);
}

/* ============================================================ COT */
const cot = { data: null, at: 0, sel: store.get("cotSel", "ES"), win: store.get("cotWin", "3y"), hist: {}, ctrl: null, geo: null };
const COT_SHOW = [["asset_mgr", C.pos], ["lev_money", C.neg], ["dealer", C.put]];
function cotStatus() { return cot.data && cot.data.report_date ? `COT del ${ddmm(cot.data.report_date)}` : ""; }

async function loadCot(refresh = false) {
  if (cot.ctrl) cot.ctrl.abort();
  cot.ctrl = new AbortController();
  $("refreshBtn").classList.add("spin");
  setStatus("busy", "Cargando el COT…");
  if (!cot.data) $("cotBody").innerHTML = `<tr class="loading"><td colspan="8" class="l">Descargando el informe de la CFTC…</td></tr>`;
  try {
    const r = await fetch("/api/cot" + (refresh ? "?refresh=1" : ""), { signal: cot.ctrl.signal });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "No se pudo cargar el COT");
    cot.data = d; cot.at = Date.now();
    if (refresh) cot.hist = {};
    if (state.mode === "cot") { renderCot(); setStatus("", cotStatus()); }
  } catch (e) {
    if (e.name === "AbortError") return;
    if (state.mode === "cot") {
      setStatus("err", cot.data ? "No se pudo actualizar" : "Sin datos");
      if (!cot.data) $("cotBody").innerHTML = `<tr class="err"><td colspan="8" class="l">${esc(e.message === "Failed to fetch" ? "El servidor local no responde. Vuelve a abrir GEX Lab." : e.message)}</td></tr>`;
    }
  } finally { $("refreshBtn").classList.remove("spin"); }
}

function cotIdx(g) {
  const v = cot.win === "1y" ? g.index1y : g.index3y;
  if (v == null) return `<span class="cidx"><span class="cbar"></span><b>—</b></span>`;
  const ext = v >= 90 || v <= 10;
  return `<span class="cidx${ext ? " ext" : ""}" title="${ext ? "Extremo del periodo" : ""}"><span class="cbar"><i style="left:${v.toFixed(1)}%"></i></span><b>${fmtNum(v, 0)}</b></span>`;
}

function renderCot() {
  const d = cot.data;
  if (!d) return;
  $("cotDate").innerHTML = d.report_date
    ? `Posiciones del <b>${longDate(d.report_date)}</b> · publicado el ${longDate(d.release)}`
    : "Sin informe";
  $("cotWinSeg").querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === cot.win)));
  let html = "", grp = "";
  for (const m of d.markets) {
    if (m.group !== grp) { grp = m.group; html += `<tr class="sec"><td colspan="8" class="l">${esc(grp)}</td></tr>`; }
    if (m.error) { html += `<tr class="err"><td class="l"><span class="tk">${esc(m.name)}</span></td><td colspan="7" class="l">${esc(m.error)}</td></tr>`; continue; }
    const cells = COT_SHOW.map(([k]) => {
      const g = m.groups[k];
      const dc = g.chg > 0 ? "up" : g.chg < 0 ? "dn" : "";
      return `<td class="gs" title="Largos ${fmtNum(g.long)} · cortos ${fmtNum(g.short)} · neta ${fmtNum(g.net)} (${g.pct_oi != null ? sgnPct(g.pct_oi) : "—"} del open interest)"><span class="lv">${fmtBig(g.net)}</span><span class="dl ${dc}">${g.chg > 0 ? "+" : ""}${fmtBig(g.chg)}</span></td><td class="l">${cotIdx(g)}</td>`;
    }).join("");
    html += `<tr data-k="${m.key}" class="${m.key === cot.sel ? "sel" : ""}"><td class="l"><span class="tk">${esc(m.name)}</span><span class="nm">${esc(m.key)}${m.note ? " · " + esc(m.note) : ""}</span></td>
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
    $("cotChart").innerHTML = `<div class="empty">Cargando…</div>`;
    try {
      const r = await fetch("/api/cot_history?key=" + encodeURIComponent(key));
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      cot.hist[key] = d;
    } catch (e) { $("cotChart").innerHTML = `<div class="empty">${esc(e.message || "Sin datos")}</div>`; return; }
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
  $("cotTitle").textContent = `${h.name}: posición neta por grupo, ${oneY ? "último año" : cot.data.years + " años"}`;
  $("cotCap").textContent = h.price_ref ? `Contratos. Línea blanca: ${h.price_ref} al cierre del martes de cada informe${/^(SHY|IEI|IEF|TLT|QQQ|IWM|DIA)$/.test(h.price_ref) ? " (ETF de referencia)" : ""}.` : "Contratos.";
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
  for (const [k, c] of COT_SHOW) {
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
  const litems = COT_SHOW.map(([k, c]) => [(cot.data.groups.find((g) => g.key === k) || {}).label || k, c, ""]);
  const lgW = litems.reduce((a, [lab]) => a + textW(lab, 12) + 44, 0);
  s += lgW <= R - L ? legendRows(litems, L, L + lgW, 12) : legendRows(litems, 8, W - 8, 12);
  cot.geo = { L, R, n, xOf };
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${s}</svg>`;
  if (m.weeks && m.weeks < 52) $("cotCap").textContent += " Historia corta: el índice es poco fiable.";
}

function cotTip(e) {
  const g = cot.geo;
  if (!cot.hist[cot.sel] || !g) return;
  const h = cotWindow(cot.hist[cot.sel]);
  const rect = $("cotChart").getBoundingClientRect();
  const i = Math.round(((e.clientX - rect.left - g.L) / (g.R - g.L)) * (g.n - 1));
  if (i < 0 || i >= g.n) return macroTip("cotTip", null, e, "");
  const rows = COT_SHOW.map(([k, c]) => {
    const lab = (cot.data.groups.find((x) => x.key === k) || {}).label;
    return `<div class="r"><span><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${c};margin-right:6px"></i>${lab}</span><b>${fmtNum(h.net[k][i])}</b></div>`;
  }).join("");
  macroTip("cotTip", null, e, `<div class="t">${new Date(h.dates[i] + "T12:00:00").toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric" })}</div>${rows}
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
const SUM_LV = [["call_wall", "Call Wall", C.call], ["flip", "Gamma Flip", C.amber], ["vt", "Vol Trigger", C.amber], ["put_wall", "Put Wall", C.put]];
function sumStatus() { const d = sm.data; return d ? `Resumen · ${nyHHMM(d.computed_at)}` : ""; }

async function loadSummary(refresh = false) {
  if (sm.ctrl) sm.ctrl.abort();
  sm.ctrl = new AbortController();
  $("refreshBtn").classList.add("spin");
  setStatus("busy", "Preparando el resumen…");
  if (!sm.data) $("sumIdx").innerHTML = SUMMARY_SYMS.map((s) => `<section class="scard"><div class="st">${s}</div><p class="empty">Cargando…</p></section>`).join("");
  try {
    const r = await fetch("/api/summary" + (refresh ? "?refresh=1" : ""), { signal: sm.ctrl.signal });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "No se pudo preparar el resumen");
    sm.data = d; sm.at = Date.now();
    if (state.mode === "summary") { renderSummary(); setStatus("", sumStatus()); }
  } catch (e) {
    if (e.name === "AbortError") return;
    if (state.mode === "summary") {
      setStatus("err", sm.data ? "No se pudo actualizar" : "Sin datos");
      if (!sm.data) $("sumIdx").innerHTML = `<section class="scard"><p class="empty">${esc(e.message === "Failed to fetch" ? "El servidor local no responde. Vuelve a abrir GEX Lab." : e.message)}</p></section>`;
    }
  } finally { $("refreshBtn").classList.remove("spin"); }
}
const SUMMARY_SYMS = ["SPX", "NDX", "RUT"];

function localTime(iso, withDay) {
  const dt = new Date(iso);
  const t = dt.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  if (!withDay) return t;
  const today = new Date(); const tm = new Date(Date.now() + 86400000);
  const same = (a, b) => a.toDateString() === b.toDateString();
  const day = same(dt, today) ? "hoy" : same(dt, tm) ? "mañana" : dt.toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" });
  return `${day} a las ${t}`;
}

function sumIndexCard(c) {
  if (c.error) return `<section class="scard"><div class="st">${esc(c.symbol)}</div><p class="empty">${esc(c.error)}</p></section>`;
  const neg = c.regime === "negative";
  const dec = c.spot >= 1000 ? 0 : 2;
  const lv = (v) => (v == null ? "—" : fmtNum(v, Number.isInteger(v) ? 0 : decFor(c.step)));
  const f = c.flip_exact;
  const fd = f ? (c.spot / f - 1) * 100 : null;
  let read;
  const fs = flipSide(c.spot, f, c.levels.flip.v);
  if (f == null) read = `Sin cruce de gamma en el rango: el régimen es <b>${neg ? "negativo" : "positivo"}</b> en todo el entorno del precio.`;
  else if (fs === "near") read = `Junto al Gamma Flip (<b>${lv(c.levels.flip.v)}</b>, ${sgnPct(fd / 100)}): zona de transición, sin efecto claro de los dealers. Vigila hacia qué lado sale.`;
  else read = `${fd >= 0 ? "Por encima" : "Por debajo"} del Gamma Flip (<b>${lv(c.levels.flip.v)}</b>, ${sgnPct(fd / 100)}). ` +
    (neg ? "Los dealers amplifican los movimientos: más volatilidad y tendencia." : "Los dealers amortiguan los movimientos: rangos más estrechos y vuelta a la media.");
  const rows = SUM_LV.map(([k, name, col]) => ({ k, name: k === "vt" && c.is_index === false ? "Hedge Wall" : name, col, ...c.levels[k] })).filter((x) => x.v != null);
  const ag = c.abs_gamma;
  if (ag && ag.v != null && !rows.some((x) => x.v === ag.v)) rows.push({ k: "abs", name: "Gamma absoluta", col: C.muted, ...ag });
  rows.push({ k: "spot", name: c.implied ? "Precio (implícito)" : "Precio", v: c.spot, d: null });
  rows.sort((a, b) => b.v - a.v);
  const li = rows.map((x) => x.k === "spot"
    ? `<li class="spot"><span class="n" data-g="spot"><i></i>${x.name}</span><span class="v">${fmtNum(x.v, dec)}</span><span class="d"></span></li>`
    : `<li><span class="n" data-g="${x.k === "vt" && c.is_index === false ? "hedge" : x.k}"><i style="background:${x.col}"></i>${x.name}</span><span class="v">${lv(x.v)}</span><span class="d">${sgnPct(x.d / 100)}</span></li>`).join("");
  const em = c.moves && c.moves.d1, m5 = c.moves && c.moves.d5;
  const emTxt = em ? `±${fmtNum(em.pct, 2)}% <span style="color:var(--faint)">${fmtNum(em.lo, dec)}–${fmtNum(em.hi, dec)}</span>` : "—";
  const m5Txt = m5 ? `±${fmtNum(m5.pct, 2)}% <span style="color:var(--faint)">${fmtNum(m5.lo, dec)}–${fmtNum(m5.hi, dec)}</span>` : "—";
  const chg = c.chg;
  return `<section class="scard link" data-sym="${esc(c.symbol)}">
    <div class="sh"><span class="st">${esc(c.symbol)}<small>${esc(c.name || "")}</small></span><span class="sc ${chg > 0 ? "up" : chg < 0 ? "dn" : ""}">${chg != null ? fmtPct(chg) : ""}</span></div>
    <div class="srow"><span class="sp">${fmtNum(c.spot, dec)}</span><span class="pill ${neg ? "neg" : "pos"}"><i></i>Gamma ${neg ? "negativa" : "positiva"}</span></div>
    <p class="sread">${read}</p>
    <ul class="slv">${li}</ul>
    <div class="sfoot"><span data-g="range1s">Rango 1σ, ${rangeLabel(em)}</span><b>${emTxt}</b></div>
    <div class="sfoot"><span data-g="range1s">Rango 1σ, 5 sesiones</span><b>${m5Txt}</b></div>
    <div class="sfoot"><span data-g="gex1">GEX por 1%</span><b>${fmtBig(c.net_per_pct, true)}${c.prev_net != null ? ` <span style="color:var(--faint);font-weight:400">· ${ddmm(c.prev_date)} ${fmtBig(c.prev_net, true)}</span>` : ""}</b></div>
  </section>`;
}

function sumSpark(points, col, W = 300) {
  const H = 70, p = 6;
  const xs = points.map((q) => q.days), ys = points.map((q) => q.v);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const xOf = (v) => p + ((v - x0) / Math.max(1, x1 - x0)) * (W - 2 * p);
  const yOf = (v) => H - p - ((v - y0) / Math.max(1e-9, y1 - y0)) * (H - 2 * p);
  const d = points.map((q, k) => `${k ? "L" : "M"}${xOf(q.days).toFixed(1)},${yOf(q.v).toFixed(1)}`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><path d="${d}" fill="none" stroke="${col}" stroke-width="2"/>` +
    points.map((q, k) => `<circle cx="${xOf(q.days)}" cy="${yOf(q.v)}" r="${k ? 2.5 : 3.5}" fill="${col}"/>`).join("") + `</svg>`;
}

function renderSummary() {
  const d = sm.data;
  if (!d) return;
  const s = d.session;
  const dateTxt = d.indices.find((c) => !c.error);
  $("sumSub").textContent = dateTxt ? `Datos de CBOE de las ${nyHHMM(dateTxt.quote_time)} del ${longDate(dateTxt.quote_time.slice(0, 10))} · tipo sin riesgo ${fmtNum(d.rate.r * 100, 2)}%` : "";
  $("sumSess").innerHTML = s.open ? `Mercado abierto · cierra a las <b>${localTime(s.close_utc)}</b>` : `Mercado cerrado · abre <b>${localTime(s.next_open_utc, true)}</b>`;
  $("sumIdx").innerHTML = d.indices.map(sumIndexCard).join("");

  const v = d.vix;
  if (v.error) $("sumVix").innerHTML = `<div class="st">Curva VIX</div><p class="empty">${esc(v.error)}</p>`;
  else {
    const col = SHAPE_COLOR[v.shape.code];
    $("sumVix").innerHTML = `<div class="sh"><span class="st">Curva de futuros del VIX<small>cierre ${ddmm(v.date)}</small></span><span class="pill ${SHAPE_CLASS[v.shape.code]}"><i></i>${esc(v.shape.label)}</span></div>
      <div class="sspark" id="sumSpark"></div>
      <div class="sfacts">
        <div><span data-g="vix">VIX</span><b>${fmtNum(v.vix_close, 2)}</b></div>
        <div><span data-g="m1">M1 · ${monLabel(v.m1_exp)}</span><b>${fmtNum(v.m1, 2)}</b></div>
        <div><span data-g="slope">M2 / M1</span><b>${sgnPct(v.spread)}</b></div>
        <div><span data-g="vix3m">VIX / VIX3M</span><b style="color:${v.vix_vix3m >= 1 ? C.amber : C.text}">${v.vix_vix3m ? fmtNum(v.vix_vix3m, 2) : "—"}</b></div>
      </div>
      <p class="sread">Pendiente en el percentil <b>${fmtNum(v.spread_pct_rank, 0)}</b> del último año. ${v.streak} ${v.streak === 1 ? "sesión" : "sesiones"} en ${v.streak_contango ? "contango" : "backwardation"} (M2/M1).</p>`;
  }
  if (!v.error) { const sp = $("sumSpark"); sp.innerHTML = sumSpark(v.points, SHAPE_COLOR[v.shape.code], Math.max(200, sp.clientWidth)); }
  const c = d.cot;
  if (c.error) $("sumCot").innerHTML = `<div class="st">COT</div><p class="empty">${esc(c.error)}</p>`;
  else {
    const list = c.extremes.slice(0, 7).map((x) => `<li data-k="${x.key}"><span>${esc(x.name)} · ${esc(x.group)}</span><em>neta ${fmtBig(x.net)} (${x.chg > 0 ? "+" : ""}${fmtBig(x.chg)})</em><b>${fmtNum(x.index, 0)}</b></li>`).join("");
    $("sumCot").innerHTML = `<div class="sh"><span class="st">Extremos del COT<small>índice de 3 años · ${c.report_date ? ddmm(c.report_date) : ""}</small></span><span class="pill"><i style="background:var(--amber)"></i>${c.extremes.length} ${c.extremes.length === 1 ? "extremo" : "extremos"}</span></div>
      ${list ? `<ul class="sext">${list}</ul>` : `<p class="empty">Ningún grupo está por encima de 90 ni por debajo de 10 en su rango de 3 años.</p>`}
      <p class="sread">Por encima de 90, la posición neta más larga del periodo; por debajo de 10, la más corta. En extremos, el posicionamiento especulativo suele leerse a la contra.</p>`;
  }
}

function bindSummary() {
  $("sumView").addEventListener("click", (e) => {
    const ck = e.target.closest(".sext li[data-k]");
    if (ck) { cot.sel = ck.dataset.k; store.set("cotSel", ck.dataset.k); setMode("cot"); return; }
    const card = e.target.closest(".scard.link");
    if (!card) return;
    if (card.dataset.sym) { $("symbol").value = card.dataset.sym; $("spotInput").value = ""; setMode("analysis"); load(); return; }
    if (card.dataset.go) setMode(card.dataset.go);
  });
}

/* ============================================================ glosario flotante */
const GLOSSARY = {
  lowvol: { t: "Punto de baja volatilidad", c: C.put,
    what: "El nivel de precio en el que la gamma total de los dealers sería máxima (el pico de la línea de gamma total).",
    use: "Cerca de este precio la cobertura de los dealers frena más los movimientos: es donde se espera menos volatilidad realizada y donde el precio tiende a quedarse.",
    calc: "Máximo de la gamma total recalculada en cada precio hipotético dentro del rango elegido (±%). Si el máximo cae en el borde del rango, se indica fuera de rango: amplía el rango para verlo." },
  highvol: { t: "Punto de alta volatilidad", c: C.amber,
    what: "El nivel de precio en el que la gamma total sería más negativa (el valle de la línea de gamma total).",
    use: "Cerca de este precio la cobertura de los dealers amplifica los movimientos: es la zona donde se espera más volatilidad realizada.",
    calc: "Mínimo de la gamma total recalculada en cada precio hipotético dentro del rango elegido (±%). Si cae en el borde del rango, se indica fuera de rango: amplía el rango para verlo." },
  call_wall: { t: "Call Wall", c: C.call,
    what: "El strike con más gamma neta positiva por encima del precio: la mayor concentración de calls, una vez descontadas las puts del mismo strike.",
    use: "Resistencia y techo del rango esperado. Cerca de él, la cobertura de los dealers vende en las subidas y las frena. Si el precio lo supera con fuerza, la resistencia puede pasar a ser soporte y el techo se desplaza al siguiente strike con calls.",
    calc: "Motor gexbot: mayor barra positiva de GEX neta (calls − puts) en el precio o por encima, dentro del rango elegido. Motor SpotGamma: strike con más GEX solo de calls por encima del precio, en ±10% o en el rango si es mayor." },
  put_wall: { t: "Put Wall", c: C.put,
    what: "El strike con más gamma neta negativa por debajo del precio: la mayor concentración de puts, una vez descontadas las calls del mismo strike.",
    use: "Soporte y suelo del rango esperado; muchas coberturas se cierran ahí y eso suele frenar las caídas. Si se pierde con claridad, ese apoyo desaparece y la caída puede acelerarse: es una señal de alerta, no solo un nivel técnico roto.",
    calc: "Motor gexbot: mayor barra negativa de GEX neta (calls − puts) en el precio o por debajo, dentro del rango elegido. Motor SpotGamma: strike con más GEX solo de puts por debajo del precio, en ±10% o en el rango si es mayor." },
  flip: { t: "Gamma Flip (Zero Gamma)", c: C.amber,
    what: "El precio en el que la gamma total de los dealers pasa de positiva a negativa. No es un soporte ni una resistencia: marca el régimen.",
    use: "Por encima, los dealers compran caídas y venden subidas: menos volatilidad y vuelta a la media. Por debajo hacen lo contrario y amplifican los movimientos. Muy cerca del flip (a menos de un 0,5%) no se espera un efecto claro en ningún sentido.",
    calc: "Motor gexbot: frontera de signo de la GEX neta por strike dentro del rango elegido, el precio que deja la menor gamma positiva por debajo y negativa por encima. Motor SpotGamma: el cruce por cero de la GEX total recalculada en cada precio (±15%), el más cercano al precio." },
  vt: { t: "Volatility Trigger", c: C.amber,
    what: "El último soporte importante por encima del Put Wall, en el borde bajista del Gamma Flip.",
    use: "Por debajo, la cobertura de los dealers deja de sostener el precio y empieza a acompañarlo: la volatilidad realizada suele expandirse. Si solo vigilas un nivel, que sea este. Por encima, entorno más estable.",
    calc: "Aproximación propia: el strike más alto por debajo del flip con gamma neta negativa de al menos el 25% de la mayor barra. El de SpotGamma es un modelo propietario." },
  hedge: { t: "Hedge Wall", c: C.amber,
    what: "El equivalente del Volatility Trigger en acciones individuales.",
    use: "Marca el punto a partir del cual se espera más volatilidad realizada. Por encima suelen funcionar mejor las estrategias de vuelta a la media; por debajo, las de momentum. Que suba de un día a otro es una señal alcista; que baje, bajista.",
    calc: "El mismo cálculo que el Volatility Trigger: strike más alto por debajo del flip con gamma neta negativa relevante." },
  abs: { t: "Gamma absoluta", c: C.muted,
    what: "El strike con más gamma total, sumando la de calls y la de puts sin signo. Es donde más contratos sensibles al precio hay.",
    use: "Actúa como imán: con gamma positiva el precio tiende a quedarse pegado a él (pin), sobre todo cerca del vencimiento. También es soporte o resistencia fuerte. Suele estar cerca del flip, no en los extremos del rango. Si no aparece, es porque coincide con el Call Wall o el Put Wall.",
    calc: "Strike con mayor |gamma de calls| + |gamma de puts| dentro del rango elegido." },
  spot: { t: "Precio", c: C.text,
    what: "El precio del subyacente con el que se calculan los niveles.",
    use: "Con el mercado cerrado es el último cierre. En el pre-market de SPX, NDX, RUT y DJX se estima con su ETF, y en Ajustes puedes fijar un spot manual (por ejemplo, el implícito por futuros).",
    calc: "Cotización diferida de CBOE (~15 min)." },
  gex1: { t: "GEX neta por 1%", c: C.pos,
    what: "Los dólares de subyacente que los dealers tendrían que comprar o vender para cubrirse por cada 1% que se mueva el precio.",
    use: "El signo da el régimen: positivo, los dealers frenan los movimientos; negativo, los amplifican. El tamaño, comparado con días anteriores del mismo ticker, indica cuánto pesa ese efecto.",
    calc: "Σ Γ × OI × 100 × S² × 1%, con calls positivas y puts negativas (convención estándar) o con la posición estimada por flujo." },
  range1s: { t: "Rango 1σ", c: C.text,
    what: "El rango de una desviación típica que descuentan las opciones: el precio debería cerrar dentro el 68,3% de las veces.",
    use: "Para dimensionar stops y objetivos, o colocar las alas de un iron condor de corto plazo. Un cierre fuera del rango es un movimiento poco habitual. El de 5 sesiones sirve para la semana.",
    calc: "Varianza implícita ATM de cada vencimiento, repartida en horas de mercado, hasta 1 sesión (390 min) y 5 sesiones; con el mercado abierto, la de hoy cuenta solo por lo que le queda. 1σ = S × √varianza. SpotGamma ajusta los suyos además con historia." },
  vanna: { t: "Vanna", c: C.text,
    what: "Lo que los dealers comprarían o venderían para cubrirse si la volatilidad implícita cae 1 punto.",
    use: "Cuando la volatilidad baja (después de un evento o en subidas tranquilas), un vanna positivo se traduce en compras: es uno de los motores de las subidas tras un susto. Con vanna negativo, la caída de la volatilidad trae ventas.",
    calc: "Σ vanna × posición × 100 × S × 0,01, con el signo de la cobertura de los dealers." },
  charm: { t: "Charm", c: C.text,
    what: "Lo que los dealers comprarían o venderían solo por el paso de un día, sin que se mueva el precio, porque las deltas cambian al acercarse el vencimiento.",
    use: "Explica parte del flujo de las tardes y de las semanas de vencimiento. Un charm positivo grande antes de un vencimiento mensual suele dar soporte.",
    calc: "Σ charm × posición × 100 × S / 365, con el signo de la cobertura de los dealers. En contratos que vencen antes de un día se usa el cambio real de delta hasta el vencimiento (hacia 0 o 1), no la tasa extrapolada a 24 h." },
  front: { t: "Peso del próximo vencimiento", c: C.text,
    what: "La parte de la gamma total del filtro que vence en el próximo vencimiento.",
    use: "Si es alta, los niveles cambiarán mucho cuando venza: tras el vencimiento las walls pueden moverse o perder fuerza. Si es baja, los niveles son más estables.",
    calc: "|GEX| del próximo vencimiento / |GEX| total." },
  vix: { t: "VIX", c: C.text,
    what: "La volatilidad implícita a 30 días del S&P 500.",
    use: "Es el punto de partida de la curva: los futuros se comparan con él para saber si el mercado espera más o menos volatilidad que la actual.",
    calc: "Cierre oficial de CBOE; el panel indica también el valor en directo si es distinto." },
  m1: { t: "M1 (primer futuro)", c: C.text,
    what: "El futuro del VIX que vence antes: lo que el mercado paga hoy por la volatilidad de ese mes.",
    use: "Si está por encima del VIX (prima positiva), lo normal; si está por debajo, hay tensión inmediata. La prima se deshace a medida que el futuro converge al VIX en su vencimiento.",
    calc: "Cierre oficial de CBOE Futures Exchange." },
  m2: { t: "M2 (segundo futuro)", c: C.text,
    what: "El futuro del VIX del mes siguiente al M1.",
    use: "Compararlo con el M1 da la pendiente del tramo corto, la referencia clásica de contango y backwardation.",
    calc: "Cierre oficial de CBOE Futures Exchange." },
  slope: { t: "Pendiente M2 / M1", c: C.text,
    what: "Cuánto cotiza el segundo futuro por encima (contango) o por debajo (backwardation) del primero.",
    use: "Positiva y amplia: mercado tranquilo y quien vende volatilidad cobra por mantener la posición. Negativa: estrés. El percentil indica si el valor de hoy es habitual en el último año.",
    calc: "M2 / M1 − 1. Menos del 0,5% cuenta como tramo plano." },
  cm30: { t: "Futuro a 30 días", c: C.text,
    what: "Un futuro sintético con vencimiento fijo a 30 días, comparable con el VIX día a día.",
    use: "Evita los saltos que provoca el cambio de M1 al vencer cada contrato. Si está por encima del VIX, la estructura es normal.",
    calc: "Interpolación entre los dos vencimientos que rodean los 30 días." },
  vix3m: { t: "VIX / VIX3M", c: C.text,
    what: "La volatilidad implícita a 30 días frente a la de 3 meses.",
    use: "Por debajo de 1, estructura normal. Por encima de 1, el mercado paga más por protección inmediata que a plazo: señal clásica de estrés, y su vuelta por debajo de 1 suele marcar la normalización.",
    calc: "Cotizaciones de CBOE casi en directo (15 min)." },
  streak: { t: "Racha", c: C.text,
    what: "Cuántas sesiones seguidas lleva la pendiente M2/M1 en el mismo signo.",
    use: "Una racha larga de contango que se rompe es un primer aviso de cambio de régimen. Junto al porcentaje del año en contango, muestra si la situación actual es excepcional.",
    calc: "Cuenta de cierres consecutivos con M2 ≥ M1 o M2 < M1." },
  asset_mgr: { t: "Gestoras", c: C.pos,
    what: "Gestoras de activos: fondos de pensiones, fondos de inversión, aseguradoras. Dinero real con horizontes largos.",
    use: "Sus posiciones cambian despacio y siguen la tendencia de fondo. En índices suelen estar largas; los cambios de tendencia en su neta son más relevantes que el nivel.",
    calc: "Largos − cortos del informe Traders in Financial Futures de la CFTC (solo futuros)." },
  lev_money: { t: "Fondos apalancados", c: C.neg,
    what: "Hedge funds y CTA: el dinero especulativo.",
    use: "Siguen tendencias y se mueven rápido. En extremos de su rango suelen leerse a la contra: cuando todos están en el mismo lado, queda poco combustible para seguir. En bonos están cortos de forma estructural por el basis trade.",
    calc: "Largos − cortos del informe Traders in Financial Futures de la CFTC (solo futuros)." },
  dealer: { t: "Dealers", c: C.put,
    what: "Bancos y creadores de mercado.",
    use: "Normalmente están en el lado contrario de sus clientes, así que su posición es el espejo del resto. Sirve para confirmar lo que hacen gestoras y fondos.",
    calc: "Largos − cortos del informe Traders in Financial Futures de la CFTC (solo futuros)." },
  cot_index: { t: "Índice COT", c: C.amber,
    what: "Dónde está la posición neta actual dentro de su rango del periodo elegido: 0 es la más corta, 100 la más larga.",
    use: "Compara cada grupo consigo mismo, no por el signo. Por encima de 90 o por debajo de 10 es un extremo: posicionamiento saturado, a menudo antes de giros.",
    calc: "(neta − mínimo) / (máximo − mínimo) × 100, con 3 años o 1 año de informes semanales." },
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
  card.innerHTML = `<div class="glt"><i style="background:${g.c}"></i>${esc(g.t)}</div>
    <p class="glw">${esc(g.what)}</p>
    <div class="gls">Para qué sirve</div><p>${esc(g.use)}</p>
    <div class="gls">Cómo se calcula aquí</div><p class="glc">${esc(g.calc)}</p>`;
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
  navSummary: { t: "Resumen", go: () => setMode("summary") },
  navTrace: { t: "TRACE", go: () => { setMode("analysis"); if (state.view !== "map") setView("map"); } },
  navHub: { t: "Equity Hub", go: () => { setMode("analysis"); if (state.view === "map") setView(state.hubView || "impact"); } },
  navVol: { t: "Panel de volatilidad", go: () => setMode("vol") },
  navVix: { t: "Curva VIX", go: () => setMode("vix") },
  navScan: { t: "Escáner", go: () => { setMode("scanner"); setScanView("table"); } },
  navCompass: { t: "Compass", go: () => { setMode("scanner"); setScanView("compass"); } },
  navValid: { t: "Validación", go: () => { setMode("scanner"); setScanView("valid"); } },
  navCot: { t: "COT", go: () => setMode("cot") },
};
function currentNav() {
  const m = state.mode;
  if (m === "summary") return "navSummary";
  if (m === "analysis") return state.view === "map" ? "navTrace" : "navHub";
  if (m === "vol") return "navVol";
  if (m === "vix") return "navVix";
  if (m === "cot") return "navCot";
  if (m === "scanner") return state.scanView === "compass" ? "navCompass" : state.scanView === "valid" ? "navValid" : "navScan";
  return "navHub";
}
function syncNav() {
  const id = currentNav();
  for (const k of Object.keys(NAV)) { const b = $(k); if (b) { if (k === id) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); } }
  const b = $(id), pt = $("pageTitle");
  if (pt && b) { pt.innerHTML = b.querySelector("svg").outerHTML + `<span>${esc(NAV[id].t)}</span>`; document.title = `${NAV[id].t} · GEX Lab`; }
}
function applyTheme(t) {
  t = t === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem("gexlab.theme", t); } catch { /* sin almacenamiento */ }
  Object.assign(C, THEMES[t]);
  const lbl = $("themeLbl"); if (lbl) lbl.textContent = t === "dark" ? "Tema claro" : "Tema oscuro";
  const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.setAttribute("content", C.ink);
  state.heatImg = null;
  redrawAll();
}
function redrawAll() {
  if (state.mode === "analysis") draw();
  else if (state.mode === "scanner" && state.scanView === "compass" && typeof renderCompass === "function") renderCompass();
  else if (state.mode === "vix" && vx.data) renderVix();
  else if (state.mode === "cot" && cot.data) renderCotChart();
  else if (state.mode === "summary" && sm.data) renderSummary();
  else if (state.mode === "vol" && typeof renderVol === "function") renderVol();
}
function shellInit() {
  for (const [id, n] of Object.entries(NAV)) {
    const b = $(id); if (!b) continue;
    b.addEventListener("click", () => { document.body.classList.remove("side-open"); n.go(); });
  }
  $("themeBtn").addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"));
  $("themeLbl").textContent = document.documentElement.dataset.theme === "light" ? "Tema oscuro" : "Tema claro";
  const setMin = (on) => { document.body.classList.toggle("side-min", on); try { localStorage.setItem("gexlab.sidemin", on ? "1" : "0"); } catch { /* */ } };
  try { setMin(localStorage.getItem("gexlab.sidemin") === "1"); } catch { /* */ }
  $("sideMin").addEventListener("click", () => { setMin(!document.body.classList.contains("side-min")); setTimeout(redrawAll, 220); });
  $("burger").addEventListener("click", () => document.body.classList.add("side-open"));
  $("sideBack").addEventListener("click", () => document.body.classList.remove("side-open"));
  if (ME) {
    $("whoBox").hidden = false; $("whoName").textContent = ME.user; $("whoAv").textContent = (ME.user || "?").slice(0, 1);
    $("logoutNav").hidden = false;
    $("logoutNav").addEventListener("click", () => $("logoutBtn").click());
    if (ME.admin && window.gexOpenAdmin) { $("usersNav").hidden = false; $("usersNav").addEventListener("click", () => window.gexOpenAdmin()); }
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
  bindDte(() => (state.mode === "scanner" ? runScan() : load()));
  bindSeg("barsSeg", "bars", () => draw());
  bindSeg("greekSeg", "greek", () => { $("barsSeg").hidden = state.view !== "strike" || state.greek !== "gamma"; draw(); });
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
    const c = Math.min(30, Math.max(0.3, v));
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
    if (state.mode !== "scanner") return load(true);
    if (state.scanView === "compass") loadCompass(true); else if (state.scanView === "valid") loadValidation(); else runScan();
  });
  $("tabImpact").addEventListener("click", () => setView("impact"));
  $("tabStrike").addEventListener("click", () => setView("strike"));
  $("tabHistory").addEventListener("click", () => setView("history"));
  $("tabProfile").addEventListener("click", () => setView("profile"));
  $("tabMap").addEventListener("click", () => setView("map"));
  bindSeg("mapSeg", "mapMode", () => { state.heatImg = null; draw(); });
  $("sessSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    state.mapSess = b.dataset.v; draw();
  });
  $("levelsToggle").setAttribute("aria-pressed", String(state.showLevels));
  $("levelsToggle").addEventListener("click", () => {
    state.showLevels = !state.showLevels; store.set("levels", state.showLevels ? "1" : "0");
    $("levelsToggle").setAttribute("aria-pressed", String(state.showLevels)); draw();
  });
  $("exportBtn").addEventListener("click", exportPNG);
  $("copyBtn").addEventListener("click", copyPNG);
  $("tvBtn").addEventListener("click", copyTV);
  $("chart").addEventListener("mousemove", onMove);
  $("chart").addEventListener("mouseleave", hideTip);
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
  }, 80); });
  // curva VIX y COT abiertas: se refrescan solas cada 5 min (el servidor solo descarga si hay datos nuevos)
  setInterval(() => {
    if (document.hidden) return;
    if (state.mode === "vix") loadVix(); else if (state.mode === "cot") loadCot(); else if (state.mode === "summary") loadSummary();
  }, 5 * 60 * 1000);
  setView(state.view);
  if (state.mode === "scanner") { load(); setMode("scanner"); } else if (["vix", "cot", "summary", "vol"].includes(state.mode)) { setMode(state.mode); } else { setMode("analysis"); }
}
init();
