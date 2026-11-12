"use strict";
/* ============================================================ Base comun de las herramientas de opciones
   (Open Interest, Risk Engine y la calculadora Strike Studio):
   - Black-Scholes-Merton con rendimiento continuo q (precio y griegas analiticas)
   - cadena completa de /api/chain (la cadena compacta del motor, el OI de la sesion anterior y el tipo de interes)
   - utilidades de grafico SVG (escalas, marcas de eje, formato) */

const LAB_MONO = "'Manrope', -apple-system, 'Segoe UI', Roboto, sans-serif";

const BS = {
  ncdf(x) {   // Abramowitz-Stegun 7.1.26 (error < 1.5e-7), como el motor
    const z = Math.abs(x) / Math.SQRT2, t = 1 / (1 + 0.3275911 * z);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
    return 0.5 * (1 + Math.sign(x) * y);
  },
  npdf(x) { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); },
  /* Precio y griegas por accion. T en anos, r y q continuos, v en tanto por uno.
     theta por dia natural, vega y rho por 1 punto (1 %). Con T <= 0, valor intrinseco. */
  greeks(S, K, T, r, q, v, call) {
    if (!(S > 0) || !(K > 0)) return { price: 0, delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0 };
    if (T <= 1e-6 || v <= 1e-6) {
      const iv = call ? Math.max(S - K, 0) : Math.max(K - S, 0);
      return { price: iv, delta: call ? (S > K ? 1 : 0) : (S < K ? -1 : 0), gamma: 0, theta: 0, vega: 0, rho: 0 };
    }
    const sq = Math.sqrt(T), sw = v * sq;
    const d1 = (Math.log(S / K) + (r - q + 0.5 * v * v) * T) / sw, d2 = d1 - sw;
    const dq = Math.exp(-q * T), dr = Math.exp(-r * T), pdf = BS.npdf(d1);
    const N = BS.ncdf;
    const gamma = dq * pdf / (S * sw);
    const vega = S * dq * pdf * sq / 100;
    const decay = -S * dq * pdf * v / (2 * sq);
    if (call) {
      return { price: S * dq * N(d1) - K * dr * N(d2), delta: dq * N(d1), gamma, vega,
        theta: (decay - r * K * dr * N(d2) + q * S * dq * N(d1)) / 365, rho: K * T * dr * N(d2) / 100 };
    }
    return { price: K * dr * N(-d2) - S * dq * N(-d1), delta: -dq * N(-d1), gamma, vega,
      theta: (decay + r * K * dr * N(-d2) - q * S * dq * N(-d1)) / 365, rho: -K * T * dr * N(-d2) / 100 };
  },
  price(S, K, T, r, q, v, call) { return BS.greeks(S, K, T, r, q, v, call).price; },
  /* Probabilidad (neutral al riesgo, lognormal) de que el subyacente acabe por encima de X en T anos */
  probAbove(S, X, T, r, q, v) {
    if (!(X > 0)) return 1;
    if (T <= 0 || v <= 0) return S > X ? 1 : 0;
    const sw = v * Math.sqrt(T);
    return BS.ncdf((Math.log(S / X) + (r - q - 0.5 * v * v) * T) / sw);
  },
};

/* ---------------------------------------------------------------- tiempo de Nueva York */
// minutos de diferencia entre Nueva York y UTC en ese instante (−300 en invierno, −240 en verano)
function nyOffsetMin(ms) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const o = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Math.round((Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour % 24, +o.minute) - ms) / 60000);
}
// "2026-11-13T16:00" (hora de Nueva York) -> milisegundos UTC
function nyToMs(s) {
  const naive = Date.parse(s.slice(0, 16) + ":00Z");
  return naive - nyOffsetMin(naive) * 60000;
}
/* Instante al que corresponden las IV de la cadena (como gex_engine.quote_time): ahora con el mercado abierto; si no,
   el ultimo cierre (16:00 del ultimo dia laborable; los festivos no se descuentan). El tiempo hasta cada vencimiento se
   cuenta desde ahi, para que el modelo devuelva el precio medio con la IV de la cadena. */
function quoteMs(now) {
  const ny = new Date(now + nyOffsetMin(now) * 60000);       // campos UTC = hora local de Nueva York
  const wd = ny.getUTCDay(), min = ny.getUTCHours() * 60 + ny.getUTCMinutes(), lab = wd >= 1 && wd <= 5;
  if (lab && min >= 570 && min < 960) return now;
  let d = Date.UTC(ny.getUTCFullYear(), ny.getUTCMonth(), ny.getUTCDate());
  if (!(lab && min >= 960)) do { d -= 86400000; } while ([0, 6].includes(new Date(d).getUTCDay()));
  return nyToMs(new Date(d).toISOString().slice(0, 10) + "T16:00");
}
// mensual: tercer viernes (o el jueves anterior si el viernes es festivo)
function isMonthly(iso) {
  const d = new Date(iso + "T12:00:00Z"), dd = d.getUTCDate(), wd = d.getUTCDay();
  return (wd === 5 && dd >= 15 && dd <= 21) || (wd === 4 && dd >= 14 && dd <= 20);
}
function shortDate(iso) {
  const d = new Date(iso + "T12:00:00Z");
  const y = d.getUTCFullYear() !== new Date().getUTCFullYear() ? ` '${String(d.getUTCFullYear()).slice(2)}` : "";
  return `${MESES[d.getUTCMonth()]} ${d.getUTCDate()}${y}`;
}

/* ---------------------------------------------------------------- cadena */
const chainCache = {};
async function loadChain(sym, { refresh = false, signal } = {}) {
  const hit = chainCache[sym];
  if (hit && !refresh && Date.now() - hit.at < 90000) return hit.data;
  const r = await fetch(`/api/chain?symbol=${encodeURIComponent(sym)}${refresh ? "&refresh=1" : ""}`, { signal });
  const p = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(p.error || `Could not load the ${sym} option chain`);
  const data = decodeChain(p);
  chainCache[sym] = { data, at: Date.now() };
  return data;
}

/* De la cadena compacta (columnas) a una estructura comoda: vencimientos vivos con su forward y dias, y por contrato
   strike, tipo, OI, OI anterior, volumen, IV, delta y precio medio. */
function decodeChain(p) {
  const c = p.chain, real = Date.now(), now = quoteMs(real);
  const r = p.rate && p.rate.r != null ? +p.rate.r : 0.04;
  const quoted = +c.spot;
  // precio del subyacente que implican las opciones: el forward del vencimiento vivo mas cercano, descontado. Con el
  // mercado cerrado el ultimo precio del indice se queda en el cierre mientras las opciones (SPX de noche) ya se mueven
  let spot = quoted;
  if (c.fwds) {
    for (let i = 0; i < c.exps.length; i++) {
      const T0 = (nyToMs(c.exps[i]) - now) / (365 * 86400000);
      if (T0 <= 0 || !(c.fwds[i] > 0)) continue;
      const s0 = c.fwds[i] * Math.exp(-r * T0);
      if (Math.abs(s0 / quoted - 1) < 0.08) spot = s0;
      break;
    }
  }
  const exps = c.exps.map((key, i) => {
    const ms = nyToMs(key);
    const T = Math.max((ms - now) / (365 * 86400000), 0);
    const fwd = c.fwds && c.fwds[i] > 0 ? +c.fwds[i] : spot * Math.exp(r * T);
    // carry implicito del forward: q = r - ln(F/S)/T (dividendos del indice o del ETF, o el futuro en el VIX)
    const q = T > 2 / 365 && spot > 0 ? r - Math.log(fwd / spot) / T : 0;
    return { i, key, iso: key.slice(0, 10), ms, T, days: (ms - now) / 86400000, fwd, q: isFinite(q) ? q : 0,
      monthly: isMonthly(key.slice(0, 10)) };
  });
  const prevOI = p.oiprev && p.oiprev.oi ? p.oiprev.oi : null;
  const n = c.K.length, rows = new Array(n);
  for (let j = 0; j < n; j++) {
    const e = exps[c.e[j]], K = +c.K[j], call = !!c.call[j];
    const bid = +c.bid[j] || 0, ask = +c.ask[j] || 0, last = +c.last[j] || 0;
    const key = `${e.key.slice(0, 16)}|${K.toFixed(3)}|${call ? "C" : "P"}`;
    rows[j] = { e: e.i, K, call, oi: +c.oi[j] || 0, vol: +c.vol[j] || 0,
      prev: prevOI ? (key in prevOI ? +prevOI[key] : null) : undefined,
      iv: +c.iv[j] || 0, ivOwn: +c.iv_raw[j] || 0, delta: +c.delta[j] || 0,
      bid, ask, mid: ask > 0 && ask >= bid ? (bid + ask) / 2 : last };
  }
  return { symbol: p.symbol, name: p.name || p.symbol, generado: p.generado, timestamp: c.timestamp, spot, quoted, r,
    prevDate: p.oiprev ? p.oiprev.date : null, hasPrev: !!prevOI, exps, rows,
    live: exps.filter((e) => e.ms > real), asOf: now };
}

// filas de un vencimiento, ordenadas por strike
function chainSlice(ch, ei) { return ch.rows.filter((x) => x.e === ei).sort((a, b) => a.K - b.K || a.call - b.call); }

/* IV de un strike en un vencimiento: la del propio contrato si cotiza; si no, la de la sonrisa (opcion fuera de
   dinero) interpolada en el strike */
function ivAt(ch, ei, K, call) {
  const s = chainSlice(ch, ei);
  const own = s.find((x) => x.K === K && x.call === call);
  if (own && own.ivOwn > 0.01 && own.ivOwn < 5) return own.ivOwn;
  const pts = [];
  for (const x of s) if (x.iv > 0.01 && x.iv < 5 && (!pts.length || pts[pts.length - 1][0] !== x.K)) pts.push([x.K, x.iv]);
  if (!pts.length) return 0.2;
  if (K <= pts[0][0]) return pts[0][1];
  if (K >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  for (let i = 1; i < pts.length; i++) {
    if (K <= pts[i][0]) { const [k0, v0] = pts[i - 1], [k1, v1] = pts[i]; return v0 + (v1 - v0) * (K - k0) / (k1 - k0); }
  }
  return pts[pts.length - 1][1];
}
// precio medio de un contrato (o del modelo si no cotiza)
function midAt(ch, ei, K, call) {
  const x = ch.rows.find((y) => y.e === ei && y.K === K && y.call === call);
  if (x && x.mid > 0) return x.mid;
  const e = ch.exps[ei];
  return BS.price(ch.spot, K, e.T, ch.r, e.q, ivAt(ch, ei, K, call), call);
}
// strikes de un vencimiento y el mas cercano a un precio
function strikesOf(ch, ei) { return [...new Set(chainSlice(ch, ei).map((x) => x.K))]; }
function nearestStrike(list, x) { return list.reduce((a, b) => (Math.abs(b - x) < Math.abs(a - x) ? b : a), list[0]); }
// vencimiento vivo mas cercano a N dias
function expNear(ch, days) { return ch.live.reduce((a, b) => (Math.abs(b.days - days) < Math.abs(a.days - days) ? b : a), ch.live[0]); }

/* ---------------------------------------------------------------- formato y grafico */
const money = (v, dec = 2) => (v == null || !isFinite(v) ? "—" : (v < 0 ? "−$" : "$") + fmtNum(Math.abs(v), dec));
const signedMoney = (v, dec = 2) => (v == null || !isFinite(v) ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "") + "$" + fmtNum(Math.abs(v), dec));
// cifras grandes de P&L: $12.4k
function moneyK(v) {
  if (v == null || !isFinite(v)) return "—";
  const a = Math.abs(v), s = v < 0 ? "−" : "";
  if (a >= 1e6) return `${s}$${fmtNum(a / 1e6, a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e4) return `${s}$${fmtNum(a / 1e3, a >= 1e5 ? 0 : 1)}k`;
  return `${s}$${fmtNum(a, 0)}`;
}
const priceDec = (x) => (x >= 1000 ? 0 : x >= 100 ? 1 : 2);
// precio con los decimales que hacen falta (hasta 2; sin decimales por encima de 10.000): 450, 463.75, 7,560
function px(x) {
  if (x == null || !isFinite(x)) return "—";
  if (Math.abs(x) >= 10000) return fmtNum(x, 0);
  const r = Math.round(x * 100) / 100;
  return fmtNum(r, r % 1 === 0 ? 0 : Math.round(r * 10) / 10 === r ? 1 : 2);
}

function axisTicks(lo, hi, n = 6) {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / n, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
  const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}
function scale(d0, d1, r0, r1) { const k = (r1 - r0) / ((d1 - d0) || 1); const f = (v) => r0 + (v - d0) * k; f.inv = (p) => d0 + (p - r0) / k; return f; }
// trazo SVG de una serie [[x, y], ...]
function pathOf(pts, X, Y) { return pts.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(""); }

/* tarjeta flotante de los graficos de herramientas: un div .ttip dentro del contenedor del grafico */
function toolTip(box, html, x, y) {
  let t = box.querySelector(".ttip");
  if (!t) { t = document.createElement("div"); t.className = "ttip"; box.appendChild(t); }
  if (html == null) { t.hidden = true; return; }
  t.innerHTML = html; t.hidden = false;
  const bw = box.clientWidth, tw = t.offsetWidth;
  t.style.left = `${Math.max(4, Math.min(bw - tw - 4, x + 14 + tw > bw ? x - tw - 14 : x + 14))}px`;
  t.style.top = `${Math.max(4, y - 10)}px`;
}

/* ---------------------------------------------------------------- grafico de P&L por precio (comun)
   Estetica de instrumento: papel milimetrado, la curva principal como trazo de osciloscopio (con halo) y los strikes
   como marcas sobre el eje.
   o = {lo, hi, curves: [{label, pts, color, dash, main}], marks: [{x, label, color, dash, side}], ticks: [strikes],
        bes: [x], band: [a, b], bandLabel, probe(x) -> [{label, v, color}], ref: precio para el % del tooltip}
   La curva "main" lleva el relleno de ganancia (verde) y perdida (rojo). Devuelve la geometria para la sonda. */
function graphPaper(id, x0, y0) {
  const light = document.documentElement.dataset.theme === "light";
  return `<pattern id="${id}Gp" width="10" height="10" patternUnits="userSpaceOnUse" x="${x0}" y="${y0}"><path d="M10 0H0V10" fill="none" stroke="${C.grid}" stroke-width="${light ? 0.6 : 0.5}" opacity="${light ? 0.75 : 0.55}"/></pattern>
    <pattern id="${id}GP" width="50" height="50" patternUnits="userSpaceOnUse" x="${x0}" y="${y0}"><rect width="50" height="50" fill="url(#${id}Gp)"/><path d="M50 0H0V50" fill="none" stroke="${C.grid}" stroke-width="1"/></pattern>
    <filter id="${id}Glow" x="-5%" y="-20%" width="110%" height="140%"><feGaussianBlur stdDeviation="${light ? 1.4 : 2.6}"/></filter>`;
}
function payoffChart(box, o) {
  const W = Math.max(320, box.clientWidth), H = Math.max(300, Math.min(460, Math.round(W * 0.46)));
  const pad = { l: 66, r: 16, t: 26, b: 40 };
  let y0 = Infinity, y1 = -Infinity;
  for (const c of o.curves) for (const p of c.pts) if (isFinite(p[1])) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
  if (!isFinite(y0)) { y0 = -1; y1 = 1; }
  y0 = Math.min(y0, 0); y1 = Math.max(y1, 0);
  const sp = (y1 - y0) || 1; y0 -= sp * 0.08; y1 += sp * 0.1;
  const X = scale(o.lo, o.hi, pad.l, W - pad.r), Y = scale(y0, y1, H - pad.b, pad.t), zy = Y(0);
  const xt = axisTicks(o.lo, o.hi, Math.max(4, Math.round(W / 120))), yt = axisTicks(y0, y1, 5);
  const xdec = o.hi - o.lo < 8 ? 2 : o.hi - o.lo < 40 ? 1 : 0;
  const main = o.curves.find((c) => c.main) || o.curves[0];
  const area = `${pathOf(main.pts, X, Y)}L${X(o.hi).toFixed(1)},${zy.toFixed(1)}L${X(o.lo).toFixed(1)},${zy.toFixed(1)}Z`;
  const id = box.id || "pc", pw = W - pad.l - pad.r, ph = H - pad.t - pad.b, ax = H - pad.b;
  const marks = (o.marks || []).filter((k) => k.x >= o.lo && k.x <= o.hi).map((k) => {
    const x = X(k.x), right = k.side !== "end";
    return `<line x1="${x}" x2="${x}" y1="${pad.t}" y2="${ax}" stroke="${k.color}" stroke-width="1" stroke-dasharray="${k.dash || "3 4"}"/>
      <text x="${x + (right ? 5 : -5)}" y="${pad.t + 11}" fill="${k.color}" font-size="11.5" text-anchor="${right ? "start" : "end"}">${k.label}</text>`;
  }).join("");
  // strikes: una marca triangular sobre el eje y su cifra, sin lineas que crucen el grafico
  const ticks = (o.ticks || []).filter((k) => k >= o.lo && k <= o.hi).map((k) =>
    `<path d="M${X(k)} ${ax - 7}l-4 7h8z" fill="${C.muted}"/><text x="${X(k)}" y="${ax - 10}" fill="${C.muted}" font-size="10.5" text-anchor="middle" font-family="${LAB_MONO}">${fmtNum(k, k % 1 ? 1 : 0)}</text>`).join("");
  const inR = (o.bes || []).filter((x) => x >= o.lo && x <= o.hi);
  const bes = inR.map((x) => `<circle cx="${X(x)}" cy="${zy}" r="4.5" fill="${C.surface}" stroke="${C.amber}" stroke-width="2"><title>Breakeven ${px(x)}</title></circle>
    <text x="${X(x)}" y="${zy + (y1 > -y0 ? 18 : -10)}" fill="${C.amber}" font-size="11" text-anchor="middle" font-family="${LAB_MONO}">${px(x)}</text>`).join("");
  const band = o.band && o.band[1] > o.band[0]
    ? `<rect x="${X(Math.max(o.band[0], o.lo))}" y="${pad.t}" width="${Math.max(0, X(Math.min(o.band[1], o.hi)) - X(Math.max(o.band[0], o.lo)))}" height="${ph}" fill="${C.accent}" opacity=".06"/>` : "";
  const trace = (c) => { const d = pathOf(c.pts.filter((p) => isFinite(p[1])), X, Y); return c.main
    ? `<path d="${d}" fill="none" stroke="${c.color}" stroke-width="5" opacity=".45" filter="url(#${id}Glow)"/><path d="${d}" fill="none" stroke="${c.color}" stroke-width="2.2" stroke-linejoin="round"/>`
    : `<path d="${d}" fill="none" stroke="${c.color}" stroke-width="1.6" ${c.dash ? `stroke-dasharray="${c.dash}"` : ""} stroke-linejoin="round" opacity=".9"/>`; };
  box.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${LAB_MONO}">
    <defs>${graphPaper(id, pad.l, pad.t)}<clipPath id="${id}Up"><rect x="0" y="0" width="${W}" height="${Math.max(0, zy)}"/></clipPath><clipPath id="${id}Dn"><rect x="0" y="${zy}" width="${W}" height="${Math.max(0, H - zy)}"/></clipPath><clipPath id="${id}Pl"><rect x="${pad.l}" y="${pad.t}" width="${pw}" height="${ph}"/></clipPath></defs>
    <rect x="${pad.l}" y="${pad.t}" width="${pw}" height="${ph}" fill="url(#${id}GP)"/>
    ${band}
    ${yt.map((v) => `<text x="${pad.l - 8}" y="${Y(v) + 4}" fill="${C.faint}" font-size="11" text-anchor="end">${moneyK(v)}</text>`).join("")}
    ${xt.map((v) => `<text x="${X(v)}" y="${ax + 18}" fill="${C.faint}" font-size="11" text-anchor="middle">${fmtNum(v, xdec)}</text>`).join("")}
    <g clip-path="url(#${id}Pl)"><path d="${area}" fill="${C.put}" opacity=".13" clip-path="url(#${id}Up)"/><path d="${area}" fill="${C.call}" opacity=".12" clip-path="url(#${id}Dn)"/></g>
    <line x1="${pad.l}" x2="${W - pad.r}" y1="${zy}" y2="${zy}" stroke="${C.muted}" stroke-width="1"/>
    <rect x="${pad.l}" y="${pad.t}" width="${pw}" height="${ph}" fill="none" stroke="${C.axis}" stroke-width="1"/>
    ${marks}${ticks}
    <g clip-path="url(#${id}Pl)">${o.curves.slice().reverse().map(trace).join("")}</g>
    ${bes}
    <g id="${id}Probe" visibility="hidden"><line y1="${pad.t}" y2="${ax}" stroke="${C.muted}" stroke-width="1"/></g>
  </svg>
  <div class="lab-legend">${o.curves.map((c) => `<span><i ${c.dash ? `class="dash" style="border-color:${c.color}"` : `style="background:${c.color}"`}></i>${c.label}</span>`).join("")}${band ? `<span><i class="band"></i>${o.bandLabel || "±1σ move"}</span>` : ""}${inR.length ? `<span><i class="be"></i>Breakeven</span>` : ""}${(o.ticks || []).length ? `<span><i class="tk"></i>Strikes</span>` : ""}</div>`;
  box._geo = { X, Y, pad, lo: o.lo, hi: o.hi, probe: o.probe, ref: o.ref, id };
  if (!box._probeOn) {
    box._probeOn = true;
    box.addEventListener("mousemove", (e) => payoffProbe(box, e));
    box.addEventListener("mouseleave", () => payoffProbe(box, null));
  }
  return box._geo;
}
function payoffProbe(box, e) {
  const g = box._geo, pr = g && box.querySelector(`#${g.id}Probe`);
  if (!pr) return;
  const svg = box.querySelector("svg");
  const px = e ? e.clientX - svg.getBoundingClientRect().left : -1;
  if (!e || px < g.pad.l || px > g.X(g.hi)) { pr.setAttribute("visibility", "hidden"); toolTip(box, null); return; }
  const x = g.X.inv(px), rows = g.probe(x);
  pr.setAttribute("visibility", "visible");
  const ln = pr.querySelector("line"); ln.setAttribute("x1", px); ln.setAttribute("x2", px);
  pr.querySelectorAll("circle").forEach((c) => c.remove());
  for (const r of rows) {
    if (!isFinite(r.v)) continue;
    const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    c.setAttribute("cx", px); c.setAttribute("cy", g.Y(r.v)); c.setAttribute("r", "3.5"); c.setAttribute("fill", r.color);
    pr.appendChild(c);
  }
  const cls = (y) => (y > 0 ? "up" : y < 0 ? "dn" : "");
  const pct = g.ref ? ` <small>${x >= g.ref ? "+" : "−"}${fmtNum(Math.abs(x / g.ref - 1) * 100, 1)}%</small>` : "";
  toolTip(box, `<div class="tt-h">Underlying at ${px(x)}${pct}</div>` +
    rows.map((r) => `<div class="tt-r"><span><i style="background:${r.color}"></i>${r.label}</span><b class="${cls(r.v)}">${signedMoney(r.v, 0)}</b></div>`).join(""),
  px, g.Y(Math.max(...rows.map((r) => (isFinite(r.v) ? r.v : -Infinity)))));
}

// cabecera "SPX 7,584" y, si el ultimo precio no coincide con el que implican las opciones, una nota con los dos
function spotLabel(ch) {
  const off = Math.abs(ch.spot / ch.quoted - 1) > 0.001;
  return `${esc(ch.symbol)} ${px(ch.spot)}${off ? `<small class="tl-imp" title="Price the option quotes imply (forward of the nearest expiration), used for every calculation here so that the model matches the quotes. Outside market hours the last trade and the option quotes can be from different moments.">from option quotes; last trade ${px(ch.quoted)}</small>` : ""}`;
}
