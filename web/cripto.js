"use strict";
/* ============================================================ Crypto (BTC y ETH)
   Datos: /api/crypto (pub/cripto.json, cripto.py cada 15 min), /api/crypto_series (historias largas, pedidas al abrir
   la pagina) y /api/crypto_net?net= (actividad de una red, al elegirla). Diseno en docs/CRIPTO.md.
   A la izquierda la lectura por reglas y las cifras clave; a la derecha, pestanas (Overview, Derivatives, On-chain,
   Signals, Market). Los graficos de series se pueden ampliar (rango, escala logaritmica, series ocultables).
   Nombres con prefijo cx: los globales se comparten entre los scripts de web/. */

const cx = {
  data: null, at: 0, ctrl: null, series: null, seriesAt: 0, redes: {},
  sym: store.get("cxSym", "BTC"), filt: store.get("cxFilt", "all"), tab: store.get("cxTab", "overview"),
  net: store.get("cxNet", ""), met: store.get("cxMet", "dir"), sigFilt: store.get("cxSigFilt", "all"),
  sigSort: null, sigDir: -1, sigOpen: null, ocultas: {}, modal: null, geo: {},
};
const CX_NAME = { BTC: "Bitcoin", ETH: "Ether" };
const CX_FILT = { 7: "7 days", 30: "30 days", all: "All expirations" };
const CX_DAY = 86400000;

const cxPx = (v) => (v == null ? "—" : "$" + fmtNum(v, v >= 1000 ? 0 : v >= 1 ? 2 : 4));
const cxPct = (v, dec = 1) => (v == null ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "") + fmtNum(Math.abs(v), dec) + "%");
const cxTone = (t) => (t > 0 ? "pos" : t < 0 ? "neg" : "");

function cxStatus() {
  const d = cx.data;
  if (!d) return "";
  const t = new Date(d.generado);
  return `Crypto, updated ${t.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
}

function showCrypto() {
  if (cx.data) { renderCrypto(); setStatus("", cxStatus()); }
  if (!cx.data || Date.now() - cx.at > 300000) loadCrypto();
}

async function loadCrypto() {
  if (cx.ctrl) cx.ctrl.abort();
  cx.ctrl = new AbortController();
  $("refreshBtn").classList.add("spin");
  setStatus("busy", "Loading crypto…");
  try {
    const r = await fetch("/api/crypto", { signal: cx.ctrl.signal });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Could not load the crypto data");
    cx.data = d; cx.at = Date.now();
    if (state.mode === "crypto") { renderCrypto(); setStatus("", cxStatus()); }
    cxLoadSeries();
  } catch (e) {
    if (e.name === "AbortError") return;
    if (state.mode === "crypto") {
      setStatus("err", cx.data ? "Could not refresh" : "No data");
      if (!cx.data) $("cxRead").innerHTML = `<div class="empty">${esc(e.message === "Failed to fetch" ? "The local server is not responding. Open GEX Lab again." : e.message)}</div>`;
    }
  } finally { $("refreshBtn").classList.remove("spin"); }
}

// historias largas: una vez por media hora (cambian unas 4 veces al dia)
async function cxLoadSeries() {
  if (cx.series && Date.now() - cx.seriesAt < 1800000) return;
  try {
    const r = await fetch("/api/crypto_series");
    if (!r.ok) return;
    cx.series = await r.json(); cx.seriesAt = Date.now(); cx.redes = {};
    if (state.mode === "crypto") renderCrypto();
  } catch { /* sin historias largas: los graficos usan las cortas de /api/crypto */ }
}

async function cxLoadNet(net) {
  if (cx.redes[net]) return cx.redes[net];
  const r = await fetch(`/api/crypto_net?net=${encodeURIComponent(net)}`);
  if (!r.ok) throw new Error("Could not load that network");
  cx.redes[net] = await r.json();
  return cx.redes[net];
}

const cxVisible = (el) => !el.closest("[hidden]") && el.offsetParent !== null;

function renderCrypto() {
  const d = cx.data;
  if (!d) return;
  if (!d.activos[cx.sym]) cx.sym = Object.keys(d.activos)[0];
  const a = d.activos[cx.sym], m = d.mercado || {};
  document.querySelectorAll("#cxSym button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === cx.sym)));
  document.querySelectorAll("#cxFilt button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === cx.filt)));
  document.querySelectorAll("#cxTabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.v === cx.tab)));
  document.querySelectorAll("#cryptoView .cx-panel").forEach((p) => {
    p.hidden = !(p.dataset.tabs || "").split(" ").includes(cx.tab) || (p.classList.contains("cx-btc") && cx.sym !== "BTC");
  });
  cxResumen(a, m, d);

  const vis = (id) => cxVisible($(id));
  if (vis("cxGex")) {
    const gf = a.gex[cx.filt] || a.gex.all;
    $("cxGexCap").textContent = `Dealer gamma by strike (bars) and net GEX if price moved there (line), ${CX_FILT[cx.filt].toLowerCase()}. ${gf.flip ? "Flip " + cxPx(gf.flip) : "No flip within 15%"}, Call Wall ${cxPx(gf.call_wall)}, Put Wall ${cxPx(gf.put_wall)}.`;
    cxGexChart(a, gf);
  }
  if (vis("cxLevels")) cxLevelsChart(a);
  for (const [id, kind] of [["cxCost", "cost"], ["cxDvol", "dvol"], ["cxFund", "fund"], ["cxLev", "lev"], ["cxMin", "min"], ["cxSopr", "sopr"]]) {
    if (vis(id)) cxDrawKind(id, kind);
  }
  if (vis("cxAct")) cxActivity();
  if (vis("cxTerm")) cxTermChart(a);
  cxTables(a, m);
  if (vis("cxSigBody")) cxSignals(a);
  cxStables(m);
  if (cx.modal) cxModalRender();
  if (cx.tab === "liquidations" && typeof lqShow === "function") lqShow();   // web/liq.js
}

/* ---------- tira de resumen (todas las pestanas) y lectura completa (Overview) */
function cxResumen(a, m, d) {
  const lec = a.lectura || {}, oc = a.onchain, v = a.vol || {}, f = a.futuros || {};
  const up = (x) => (x > 0 ? "pos" : x < 0 ? "neg" : "");
  $("cxTitle").textContent = CX_NAME[cx.sym] || cx.sym;
  $("cxPrice").textContent = cxPx(a.spot);
  $("cxPrice").title = "Deribit index";
  $("cxUpd").textContent = new Date(d.generado).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  $("cxUpd").title = "Updated every 15 minutes";
  $("cxSub").innerHTML = `<span><b class="${up(a.chg24)}">${cxPct(a.chg24, 2)}</b> 24h</span>` +
    (a.viejo ? `<span class="cx-old">Data from ${esc(new Date(a.viejo).toLocaleString("en-US"))}: the last update failed</span>` : "");
  $("cxSub").title = `${cxPct(a.chg7, 1)} in 7 days, ${cxPct(a.chg30, 1)} in 30 days`;
  const st = $("cxState");
  st.textContent = lec.resumen || "—";
  st.className = "mstate cx-state " + (lec.especial === "Capitulation zone" ? "mixed" : lec.tend > 0 ? "contango" : lec.tend < 0 ? "backwardation" : "mixed");
  const tonoT = lec.tend > 0 ? "pos" : lec.tend < 0 ? "neg" : "", tonoP = lec.pos > 0 ? "pos" : lec.pos < 0 ? "neg" : "";
  $("cxAxes").innerHTML = `<span class="cx-pill ${tonoT}" title="Price against the short-term holder cost and the gamma flip, and the 30-day change">Trend <b>${esc(lec.tendencia || "—")}</b></span>` +
    `<span class="cx-pill ${tonoP}" title="Crowding read as a contrarian: fear, funding, retail long/short, puts and exchange flows">Positioning <b>${esc(lec.posicion || "—")}</b></span>`;

  // lectura: primero la tendencia, luego lo que mas pesa; el resto, plegado
  const pts = (lec.puntos || []).filter((x) => x.eje !== "senal");
  pts.sort((p, q) => (p.eje === "tendencia" ? 0 : 1) - (q.eje === "tendencia" ? 0 : 1) || Math.abs(q.tono) - Math.abs(p.tono));
  const N = 4, todos = !!cx.verTodo;
  const punto = (x) => `<div class="cx-pt"><i class="${cxTone(x.tono)}"></i><div><span class="cx-bl">${esc(x.bloque)}</span> ${esc(x.texto)}</div></div>`;
  $("cxRead").innerHTML = (todos ? pts : pts.slice(0, N)).map(punto).join("") +
    (pts.length > N ? `<button class="cx-mas" id="cxMas">${todos ? "Show less" : `Show ${pts.length - N} more`}</button>` : "");

  // cifras clave: seis, con una linea de contexto
  const kpi = (l, val, s, cls = "") => `<div class="cx-kpi"><span class="kl">${l}</span><b class="${cls}">${val}</b><span class="ks">${s}</span></div>`;
  const fng = m.fng, g = a.gex.all;
  // tira: cuatro cifras que se ven en todas las pestanas
  const sk = (l, val, cls = "") => `<span class="cx-sk">${l} <b class="${cls}">${val}</b></span>`;
  $("cxStripKpis").innerHTML = [
    sk("Net GEX", fmtBig(g.total, true), up(g.total)),
    oc ? sk("MVRV", fmtNum(oc.mvrv, 2)) : "",
    v.dvol != null ? sk("DVOL", fmtNum(v.dvol, 1)) : "",
    fng ? sk("Fear & Greed", String(fng.valor), fng.valor <= 25 ? "neg" : fng.valor >= 75 ? "pos" : "") : "",
  ].join("");
  const coste = oc && oc.sth ? ["Short-term cost", oc.sth.valor] : oc ? ["Realized price", oc.rp] : null;
  $("cxKpis").innerHTML = [
    kpi("Net GEX", fmtBig(g.total, true), g.total < 0 ? "dealers short gamma" : "dealers long gamma", up(g.total)),
    oc ? kpi("MVRV", fmtNum(oc.mvrv, 2), `${ordinal(oc.mvrv_pct)} pct since 2015`) : "",
    coste ? kpi(coste[0], cxPx(coste[1]), `price ${cxPct((a.spot / coste[1] - 1) * 100)}`, up(a.spot - coste[1])) : "",
    v.dvol != null ? kpi("DVOL", fmtNum(v.dvol, 1), `${ordinal(v.dvol_pct)} pct of the year`) : "",
    f.funding_7d != null ? kpi("Funding 7d", cxPct(f.funding_7d), "a year, OKX", up(f.funding_7d)) : "",
    fng ? kpi("Fear & Greed", String(fng.valor), esc(fng.clase).toLowerCase(), fng.valor <= 25 ? "neg" : fng.valor >= 75 ? "pos" : "") : "",
  ].join("");

  // senales activas: un aviso que lleva a su pestana
  const hace30 = a.hace30 || "", act = (a.senales || []).filter((x) => x.hoy || (x.ultima && x.ultima >= hace30));
  const sl = $("cxSigLink");
  sl.hidden = !act.length;
  sl.innerHTML = act.length ? `<b>${act.length} signal${act.length === 1 ? "" : "s"} active or recent</b><span>${act.slice(0, 3).map((x) => esc(x.nombre)).join(", ")}${act.length > 3 ? "…" : ""}</span>` : "";

  // todas las cifras, plegadas
  const fact = (l, val, s, warn) => `<div class="fact"><span class="fl">${l}</span><strong>${val}</strong><span class="fs${warn ? " warn" : ""}">${s}</span></div>`;
  const pp = a.pct_propio || {}, mi = a.mineros, be = a.beneficio || {}, ac = a.actividad, lq = m.liquidez;
  const own = (k) => (pp[k] != null ? `. ${ordinal(pp[k])} percentile of our ${a.dias_propios} days` : "");
  $("cxFacts").innerHTML = [
    fact("Net GEX (Deribit)", fmtBig(g.total, true), `per 1% move, all expirations${own("gex")}. Open interest ${fmtBig(a.oi.nocional, true)}, put/call ${fmtNum(a.oi.pcr, 2)}`),
    oc ? fact("MVRV", fmtNum(oc.mvrv, 2), `${ordinal(oc.mvrv_pct)} percentile since 2015. Realized price ${cxPx(oc.rp)}`) : "",
    oc && oc.sth ? fact("Short-term holder cost", cxPx(oc.sth.valor), `${cxPct((a.spot / oc.sth.valor - 1) * 100)} from price. Data of ${ddmm(oc.sth.fecha)} (free source, a week behind)`, true) : "",
    be.sth_sopr ? fact("Short-term SOPR (7 d)", fmtNum(be.sth_sopr.m7, 3), `${be.sth_sopr.bajo ? "selling at a loss" : "selling at a profit"} for ${be.sth_sopr.dias} days. ${ordinal(be.sth_sopr.pct)} percentile since 2022`) : "",
    mi ? fact("Puell multiple", fmtNum(mi.puell, 2), `${ordinal(mi.puell_pct)} percentile since 2012. Hash ribbons: ${mi.estado}`) : "",
    ac ? fact("Active addresses (30 d)", fmtBig(ac.dir30), `${cxPct(ac.dir_chg)} against the yearly average. ${ordinal(ac.dir_pct)} percentile since 2015`) : "",
    v.dvol != null ? fact("DVOL", fmtNum(v.dvol, 1), `${v.dvol_pct != null ? ordinal(v.dvol_pct) + " percentile of the last year. " : ""}30-day realized ${fmtNum(v.rv30, 1)}`) : "",
    v.rr25_30 != null ? fact("25-delta risk reversal (30 d)", cxPct(v.rr25_30, 1).replace("%", ""), (v.rr25_30 < 0 ? "puts over calls, vol points" : "calls over puts, vol points") + own("rr25_30")) : "",
    f.funding_7d != null ? fact("Funding, 7-day average", cxPct(f.funding_7d), `a year (OKX). Now ${cxPct(f.funding)}${f.funding_deribit != null ? `, Deribit ${cxPct(f.funding_deribit)}` : ""}${own("funding_7d")}`) : "",
    f.oi_usd != null ? fact("Futures open interest (OKX)", fmtBig(f.oi_usd, true), `${cxPct(f.oi_chg7)} in 7 days. Long/short accounts ${fmtNum(f.lsr, 2)}${own("lsr")}`) : "",
    fng ? fact("Fear & Greed", String(fng.valor), `${esc(fng.clase)}${fng.semana != null ? `, ${fng.semana} a week ago` : ""}${fng.pct != null ? `. ${ordinal(fng.pct)} percentile since 2018` : ""}`) : "",
    lq ? fact("Stablecoin supply", fmtBig(lq.total, true), `${cxPct(lq.c7)} in 7 days, ${cxPct(lq.c30)} in 30: dry powder to buy`) : "",
    m.dom ? fact("Bitcoin dominance", fmtNum(m.dom.BTC, 1) + "%", `ether ${fmtNum(m.dom.ETH, 1)}%. Total market ${fmtBig(m.cap_total, true)}`) : "",
  ].join("") + (a.dias_propios != null && a.dias_propios < 30 ? `<p class="cx-q">Our own daily history of the derivatives has ${a.dias_propios} day${a.dias_propios === 1 ? "" : "s"}: their percentiles show from 30.</p>` : "");
  const errs = Object.keys(d.errores || {});
  $("cxErr").textContent = errs.length ? `Some sources failed this time (${errs.join(", ")}); the rest is current.` : "";
  $("cxErr").hidden = !errs.length;
}

/* ---------- series: definicion de cada grafico (historia larga si ya llego; si no, la corta de /api/crypto) */
function cxCols(kind) {
  // columnas del activo: fechas y valores alineados
  const s = cx.series && cx.series.activos && cx.series.activos[cx.sym];
  if (s && s.d) return s;
  const a = cx.data.activos[cx.sym], oc = a.onchain || {}, be = a.beneficio || {}, mi = a.mineros || {};
  // respaldo con las series cortas
  if (kind === "cost" && oc.serie) {
    const sth = new Map(oc.sth_serie || []), lth = new Map(oc.lth_serie || []);
    return { d: oc.serie.map((r) => r[0]), precio: oc.serie.map((r) => r[1]), rp: oc.serie.map((r) => r[2]),
      sth: oc.serie.map((r) => sth.get(r[0]) ?? null), lth: oc.serie.map((r) => lth.get(r[0]) ?? null) };
  }
  if (kind === "dvol" && a.vol.dvol_serie) return { d: a.vol.dvol_serie.map((r) => r[0]), dvol: a.vol.dvol_serie.map((r) => r[1]) };
  if (kind === "min" && mi.serie) return { d: mi.serie.map((r) => r[0]), hash30: mi.serie.map((r) => r[1]), hash60: mi.serie.map((r) => r[2]), puell: mi.serie.map((r) => r[3]) };
  if (kind === "sopr" && (be.sth_sopr_serie || be.sopr_serie)) {
    const base = be.sth_sopr_serie || be.sopr_serie, todos = new Map(be.sopr_serie || []);
    return { d: base.map((r) => r[0]), sth_sopr: be.sth_sopr_serie ? base.map((r) => r[1]) : null, sopr: base.map((r) => todos.get(r[0]) ?? null) };
  }
  return null;
}

const CX_KINDS = {
  cost: { title: "Price against cost basis", rango: 730, log: true, fmt: cxPx, fmtY: (v) => "$" + fmtAxis(v),
    series: () => [["precio", "Price", C.text, 1.8], ["rp", "Realized price", C.accent, 1.8], ["sth", "Short-term holders", C.purple, 1.5], ["lth", "Long-term holders", C.prevClose, 1.5, "4 3"]],
    cap: () => `Daily close against the average cost of all coins (realized price)${cx.sym === "BTC" ? " and of short- and long-term holders" : ""}. CoinMetrics${cx.sym === "BTC" ? " and bitcoin-data.com" : ""}.` },
  dvol: { title: "Implied against realized volatility", rango: 365, fmt: (v) => fmtNum(v, 1), fmtY: (v) => fmtNum(v, 0),
    series: () => [["dvol", "DVOL (implied)", C.purple, 1.8], ["rv30", "Realized, 30 days", C.muted, 1.4, "4 3"]],
    cap: () => { const v = cx.data.activos[cx.sym].vol; return v.dvol != null ? `DVOL (Deribit 30-day implied volatility index) against realized volatility of the last 30 days. Now ${fmtNum(v.dvol, 1)}, ${ordinal(v.dvol_pct)} percentile of the last year; ${v.vrp >= 0 ? "+" : "−"}${fmtNum(Math.abs(v.vrp), 1)} over realized.` : ""; } },
  fund: { title: "Perpetual funding", rango: 730, ref: 0, fmt: (v) => cxPct(v), fmtY: (v) => fmtNum(v, 0) + "%",
    series: () => [["funding", "Funding, 7-day average (% a year)", C.accent, 1.6]],
    cap: () => `Deribit perpetual funding, 7-day average, annualized. Positive: longs pay shorts. Over ${fmtNum(cx.data.umbrales.funding_alto, 0)}% longs are crowded; under 0 shorts pay to hold.` },
  lev: { title: "Leverage (OKX)", rango: 0, fmt: (v) => fmtBig(v, true), fmtY: (v) => "$" + fmtAxis(v), fmtR: (v) => fmtNum(v, 2),
    series: () => [["oi", "Futures open interest", C.accent, 1.8], ["lsr", "Long/short accounts (right)", C.amber, 1.4, "4 3", true]],
    cap: () => "Open interest of OKX futures in USD and long accounts for each short. OKX gives 180 days; we keep adding from November 2026." },
  min: { title: "Miners", rango: 730, log: true, fmt: (v) => fmtNum(v, 0) + " EH/s", fmtY: (v) => fmtNum(v, 0), fmtR: (v) => fmtNum(v, 2),
    series: () => [["hash30", "Hashrate, 30-day", C.accent, 1.8], ["hash60", "Hashrate, 60-day", C.purple, 1.5, "4 3"], ["puell", "Puell multiple (right)", C.amber, 1.2, "", true]],
    cap: () => { const mi = cx.data.activos[cx.sym].mineros; if (!mi) return ""; const est = { capitulation: `in capitulation for ${mi.dias} days (30-day under 60-day: miners switching off)`, recovery: `just recovered (buy signal on ${ddmm(mi.ultima_compra)})`, healthy: "healthy (30-day over 60-day)" }[mi.estado]; return `Hashrate in EH/s. Hash ribbons ${est}. Puell multiple ${fmtNum(mi.puell, 2)}: miner revenue against its yearly average (under 0.5 stress, over 3 past tops).`; } },
  sopr: { title: "Profit and loss of sellers", rango: 365, ref: 1, fmt: (v) => fmtNum(v, 3), fmtY: (v) => fmtNum(v, 2),
    series: () => [["sth_sopr", "Short-term holders", C.purple, 1.8], ["sopr", "All coins", C.muted, 1.3]],
    cap: () => { const s = (cx.data.activos[cx.sym].beneficio || {}).sth_sopr; return `SOPR, 7-day average: price at which coins sell against the price they were bought at. Over 1, sellers take profits; under 1, they sell at a loss.${s ? ` Data to ${ddmm(s.fecha)} (a week behind).` : ""}`; } },
};

function cxSpec(kind) {
  const k = CX_KINDS[kind], cols = cxCols(kind);
  if (!k || !cols) return null;
  const series = k.series().filter(([key]) => Array.isArray(cols[key]) && cols[key].some((v) => v != null))
    .map(([key, name, col, w, da, r]) => ({ key, name, col, w, da, r: !!r, v: cols[key] }));
  if (!series.length) return null;
  return { kind, x: cols.d, series, ref: k.ref, fmt: k.fmt, fmtY: k.fmtY, fmtR: k.fmtR, log: k.log, title: k.title };
}

function cxDrawKind(id, kind) {
  const spec = cxSpec(kind);
  const cap = { cxCost: "cxCostCap", cxDvol: "cxDvolCap", cxFund: "cxFundCap", cxLev: "cxLevCap", cxMin: "cxMinCap", cxSopr: "cxSoprCap" }[id];
  if (!spec) { $(id).innerHTML = `<div class="empty">${cx.series ? "No data" : "Loading…"}</div>`; if (cap) $(cap).textContent = ""; return; }
  if (cap) $(cap).textContent = CX_KINDS[kind].cap();
  cxChart(id, spec, { rango: CX_KINDS[kind].rango });
}

/* ---------- grafico de series generico: eje izquierdo y derecho, escala logaritmica, leyenda que oculta series,
   marcas (casos de una senal) y tooltip con todas las series en la fecha */
function cxLogTicks(lo, hi) {
  const out = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) {
    for (const m of [1, 2, 5]) { const v = m * 10 ** e; if (v >= lo && v <= hi) out.push(v); }
  }
  return out.length >= 2 ? out : [lo, hi];
}

function cxChart(id, spec, o = {}) {
  const el = $(id), W = Math.max(300, el.clientWidth), Ht = Math.max(170, el.clientHeight);
  const ocultas = cx.ocultas[spec.kind] || new Set();
  const vis = spec.series.filter((s) => !ocultas.has(s.key));
  const hayR = vis.some((s) => s.r);
  // rango: ultimos n dias de la serie (0 = todo)
  const n = spec.x.length;
  let i0 = 0;
  if (o.rango) {
    const corte = Date.parse(spec.x[n - 1]) - o.rango * CX_DAY;
    while (i0 < n - 1 && Date.parse(spec.x[i0]) < corte) i0++;
  }
  // sin datos al principio del rango (series que empiezan tarde): se recorta
  while (i0 < n - 1 && !vis.some((s) => s.v[i0] != null)) i0++;
  const H = Ht - (W < 560 ? 50 : 30);   // la leyenda va debajo, en HTML (dos filas en pantallas estrechas)
  const L = 58, R = W - (hayR ? 54 : 16), T = 12, B = H - 24;
  const log = !!(o.log && spec.log);
  const rango = (ser) => {
    let lo = Infinity, hi = -Infinity;
    for (const s of ser) for (let i = i0; i < n; i++) { const v = s.v[i]; if (v != null && (!log || v > 0)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
    return [lo, hi];
  };
  let [lo, hi] = rango(vis.filter((s) => !s.r));
  if (!isFinite(lo) && !hayR) { el.innerHTML = `<div class="empty">No data in this range</div>`; return null; }
  if (spec.ref != null && isFinite(lo)) { lo = Math.min(lo, spec.ref); hi = Math.max(hi, spec.ref); }
  let yOf, ticks;
  if (isFinite(lo)) {
    if (log) {
      const a = Math.log10(lo * 0.95), b = Math.log10(hi * 1.05);
      yOf = (v) => B - ((Math.log10(v) - a) / (b - a)) * (B - T);
      ticks = cxLogTicks(lo * 0.95, hi * 1.05);
    } else {
      const yt = niceTicks(lo, hi, Math.max(3, Math.round((B - T) / 42)));
      yOf = (v) => B - ((v - yt.lo) / (yt.hi - yt.lo)) * (B - T);
      ticks = yt.ticks;
    }
  }
  let yR = null, ticksR = [];
  if (hayR) {
    const [rl, rh] = rango(vis.filter((s) => s.r));
    if (isFinite(rl)) {
      const yt = niceTicks(rl, rh, Math.max(3, Math.round((B - T) / 42)));
      yR = (v) => B - ((v - yt.lo) / (yt.hi - yt.lo)) * (B - T);
      ticksR = yt.ticks;
    }
  }
  const t0 = Date.parse(spec.x[i0]), t1 = Date.parse(spec.x[n - 1]);
  const xOf = (i) => L + ((Date.parse(spec.x[i]) - t0) / (t1 - t0 || 1)) * (R - L);
  let s = "";
  if (yOf) s += ticks.map((v) => `<line x1="${L}" x2="${R}" y1="${yOf(v)}" y2="${yOf(v)}" stroke="${C.grid}"/>` + txt(L - 8, yOf(v) + 4, spec.fmtY ? spec.fmtY(v) : fmtNum(v), { a: "end", fs: 11 })).join("");
  if (yR) s += ticksR.map((v) => txt(R + 8, yR(v) + 4, spec.fmtR ? spec.fmtR(v) : fmtNum(v), { fs: 11, c: C.amber })).join("");
  if (spec.ref != null && yOf) s += `<line x1="${L}" x2="${R}" y1="${yOf(spec.ref)}" y2="${yOf(spec.ref)}" stroke="${C.amber}" stroke-width="1.2" stroke-dasharray="5 4"/>`;
  // muchos puntos: se dibuja uno de cada k para no pasar de ~2 por pixel
  const paso = Math.max(1, Math.floor((n - i0) / ((R - L) * 2)));
  for (const sr of vis) {
    const f = sr.r ? yR : yOf;
    if (!f) continue;
    let dd = "", pen = false;
    for (let i = i0; i < n; i += (i + paso < n ? paso : 1)) {
      const v = sr.v[i];
      if (v == null || (log && !sr.r && v <= 0)) { pen = false; continue; }
      dd += `${pen ? "L" : "M"}${xOf(i).toFixed(1)},${f(v).toFixed(1)}`; pen = true;
    }
    s += `<path d="${dd}" fill="none" stroke="${sr.col}" stroke-width="${sr.w || 1.6}"${sr.da ? ` stroke-dasharray="${sr.da}"` : ""} stroke-linejoin="round"/>`;
  }
  // marcas: casos de una senal sobre la primera serie
  for (const mk of o.marcas || []) {
    if (mk.i < i0 || !yOf || spec.series[0].v[mk.i] == null) continue;
    s += `<circle cx="${xOf(mk.i)}" cy="${yOf(spec.series[0].v[mk.i])}" r="5" fill="${mk.col}" stroke="${C.surface}" stroke-width="1.5"/>`;
  }
  // eje x: meses o anos segun el rango
  const dias = (t1 - t0) / CX_DAY, anual = dias > 900;
  let prev = "", last = -1e9;
  for (let i = i0; i < n; i++) {
    const d = spec.x[i], k = anual ? d.slice(0, 4) : d.slice(0, 7);
    if (k !== prev && xOf(i) - last >= (anual ? 40 : 52) && xOf(i) > L + 8) {
      s += txt(xOf(i), B + 18, anual ? k : MESES[+d.slice(5, 7) - 1] + (d.slice(5, 7) === "01" || last < 0 ? " '" + d.slice(2, 4) : ""), { a: "middle", fs: 11 });
      last = xOf(i);
    }
    prev = k;
  }
  s += `<line class="cx-hl" x1="0" x2="0" y1="${T}" y2="${B}" stroke="${C.spotline}" stroke-opacity=".6" visibility="hidden"/>`;
  const ley = spec.series.map((sr) => `<button class="cx-li${ocultas.has(sr.key) ? " off" : ""}" data-k="${sr.key}" title="Show or hide"><i style="border-color:${sr.col};${sr.da ? "border-top-style:dashed" : ""}"></i>${esc(sr.name)}</button>`).join("");
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${s}</svg><div class="cx-leg" data-kind="${spec.kind}">${ley}</div>`;
  cx.geo[id] = { L, R, i0, n, xOf, spec, tip: o.tip || "cxTip" };
  return cx.geo[id];
}

function cxChartTip(id, e) {
  const g = cx.geo[id];
  if (!g) return;
  const el = $(id), r = el.getBoundingClientRect(), x = e.clientX - r.left, hl = el.querySelector(".cx-hl");
  if (x < g.L - 4 || x > g.R + 4 || e.target.closest(".cx-leg")) { if (hl) hl.setAttribute("visibility", "hidden"); return macroTip(g.tip, null, e, ""); }
  // busqueda binaria del dia mas cercano
  let a = g.i0, b = g.n - 1;
  while (b - a > 1) { const m = (a + b) >> 1; if (g.xOf(m) < x) a = m; else b = m; }
  const i = Math.abs(g.xOf(a) - x) < Math.abs(g.xOf(b) - x) ? a : b;
  if (hl) { const X = g.xOf(i); hl.setAttribute("x1", X); hl.setAttribute("x2", X); hl.setAttribute("visibility", "visible"); }
  const sp = g.spec, ocultas = cx.ocultas[sp.kind] || new Set();
  const filas = sp.series.filter((s) => !ocultas.has(s.key) && s.v[i] != null)
    .map((s) => `<div class="r">${esc(s.name.replace(" (right)", ""))} <b style="color:${s.col}">${(s.r && sp.fmtR ? sp.fmtR : sp.fmt)(s.v[i])}</b></div>`).join("");
  macroTip(g.tip, null, e, `<div class="t">${longDate(sp.x[i])}</div>${filas}${sp.extra ? sp.extra(i) : ""}`);
}

/* ---------- actividad de la red: red y medida elegibles */
async function cxActivity(target = "cxAct", rango = 730, tip = "cxTip", log = false) {
  const lista = (cx.series && cx.series.redes) || {};
  const nets = Object.keys(lista);
  if (!nets.length) { $(target).innerHTML = `<div class="empty">${cx.series ? "No data" : "Loading…"}</div>`; return; }
  if (!lista[cx.net]) cx.net = lista[cx.sym] ? cx.sym : nets[0];
  const chips = nets.map((k) => `<button role="radio" data-v="${k}" aria-checked="${k === cx.net}" title="${esc(lista[k].nombre)}, since ${lista[k].desde.slice(0, 4)}">${k}</button>`).join("");
  $("cxNets").innerHTML = chips;
  if (cx.modal && cx.modal.kind === "act") $("cxModalNets").innerHTML = chips;
  document.querySelectorAll("#cxActMet button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === cx.met)));
  let r;
  try { r = await cxLoadNet(cx.net); } catch (e) { $(target).innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const v = r[cx.met] || [], n = v.length;
  // medias de 30 y 365 dias (ignoran los dias sin dato)
  const media = (k) => {
    const out = new Array(n).fill(null);
    let s = 0, c = 0;
    for (let i = 0; i < n; i++) {
      if (v[i] != null) { s += v[i]; c++; }
      if (i >= k && v[i - k] != null) { s -= v[i - k]; c--; }
      if (i >= k - 1 && c > k * 0.8) out[i] = s / c;
    }
    return out;
  };
  const m30 = media(30), m365 = media(365);
  const nombre = cx.met === "dir" ? "Active addresses" : "Transactions";
  const spec = { kind: "act", x: r.d, fmt: (x) => fmtNum(x), fmtY: fmtAxis, fmtR: cxPx, log: true,
    series: [{ key: "m30", name: `${nombre}, 30-day`, col: C.accent, w: 1.8, v: m30 },
      { key: "m365", name: `${nombre}, 365-day`, col: C.muted, w: 1.4, da: "4 3", v: m365 },
      { key: "p", name: "Price (right)", col: C.amber, w: 1.1, r: true, v: r.p }],
    extra: (i) => (v[i] != null ? `<div class="r">That day <b>${fmtNum(v[i])}</b></div>` : "") };
  const ult = m30[n - 1], ultA = m365[n - 1];
  const txtCap = `${esc(r.nombre)}: ${nombre.toLowerCase()} per day (CoinMetrics), 30-day average ${fmtBig(ult)}, ${cxPct(ult && ultA ? (ult / ultA - 1) * 100 : null)} against the yearly average. Price on the right axis.`;
  $("cxActCap").textContent = txtCap;
  if (target === "cxModalChart") $("cxModalCap").textContent = txtCap;
  cxChart(target, spec, { rango, tip, log });
}

function cxTermChart(a) {
  // sin los vencimientos de menos de un dia: su IV la mueve el ultimo tramo hasta la liquidacion
  const t = (a.vol.term || []).filter((r) => r.atm != null && r.dias >= 1);
  const el = $("cxTerm"), W = Math.max(300, el.clientWidth), H = Math.max(170, el.clientHeight);
  const L = 48, R = W - 16, T = 12, B = H - 28;
  if (t.length < 2) { el.innerHTML = `<div class="empty">No data</div>`; return; }
  const f = (x) => Math.sqrt(x), x0 = f(t[0].dias), x1 = f(t[t.length - 1].dias);
  const xOf = (x) => L + ((f(x) - x0) / (x1 - x0 || 1)) * (R - L);
  const yt = niceTicks(Math.min(...t.map((r) => r.atm)), Math.max(...t.map((r) => r.atm)), 4);
  const yOf = (v) => B - ((v - yt.lo) / (yt.hi - yt.lo)) * (B - T);
  let s = yt.ticks.map((v) => `<line x1="${L}" x2="${R}" y1="${yOf(v)}" y2="${yOf(v)}" stroke="${C.grid}"/>` + txt(L - 8, yOf(v) + 4, fmtNum(v, 0), { a: "end", fs: 11 })).join("");
  s += `<path d="${t.map((r, i) => `${i ? "L" : "M"}${xOf(r.dias).toFixed(1)},${yOf(r.atm).toFixed(1)}`).join("")}" fill="none" stroke="${C.accent}" stroke-width="2.2"/>`;
  s += t.map((r) => `<circle cx="${xOf(r.dias)}" cy="${yOf(r.atm)}" r="3" fill="${C.surface}" stroke="${C.accent}" stroke-width="1.6"/>`).join("");
  let last = -1e9;
  for (const r of t) { const X = xOf(r.dias); if (X - last >= 46) { s += txt(X, B + 18, ddmm(r.exp), { a: "middle", fs: 11 }); last = X; } }
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${s}</svg>`;
  cx.geo.term = { t, xOf };
  const v = a.vol;
  $("cxTermCap").textContent = `At-the-money implied volatility by expiration (Deribit). 30 days: ATM ${fmtNum(v.atm30, 1)}, 25-delta risk reversal ${fmtNum(v.rr25_30, 1)}, butterfly ${fmtNum(v.bf25_30, 1)}.`;
}

/* ---------- ampliar un grafico */
function cxOpenModal(kind) {
  // store guarda texto (en la nube, "false" seria verdadero): se convierte
  cx.modal = { kind, rango: +store.get("cxR_" + kind, kind === "act" ? 1825 : 0) || 0, log: String(store.get("cxLog_" + kind, false)) === "true" };
  $("cxModal").hidden = false;
  document.body.classList.add("cx-noscroll");
  cxModalRender();
  $("cxModalClose").focus();
}
function cxCloseModal() {
  cx.modal = null;
  $("cxModal").hidden = true; $("cxMTip").hidden = true;
  document.body.classList.remove("cx-noscroll");
}
function cxModalRender() {
  const md = cx.modal;
  if (!md) return;
  const k = md.kind;
  $("cxModalTitle").textContent = k === "act" ? "Network activity" : `${CX_KINDS[k].title}, ${CX_NAME[cx.sym]}`;
  document.querySelectorAll("#cxRange button").forEach((b) => b.setAttribute("aria-checked", String(+b.dataset.v === md.rango)));
  const logOk = k === "act" || (CX_KINDS[k] && CX_KINDS[k].log);
  $("cxLogWrap").hidden = !logOk; $("cxLog").checked = !!md.log;
  $("cxModalNets").hidden = k !== "act";
  if (k === "act") { cxActivity("cxModalChart", md.rango, "cxMTip", md.log); return; }
  const spec = cxSpec(k);
  $("cxModalCap").textContent = CX_KINDS[k].cap();
  if (!spec) { $("cxModalChart").innerHTML = `<div class="empty">No data</div>`; return; }
  cxChart("cxModalChart", spec, { rango: md.rango, log: md.log, tip: "cxMTip" });
}

/* ---------- senales con su historia: filtros, orden y casos sobre el precio */
function cxSigVal(x, k) {
  const e30 = x.h["30"] || {}, e90 = x.h["90"] || {};
  return { nombre: x.nombre, ultima: x.hoy ? "9999" : x.ultima || "", n: x.casos.length, m30: e30.mediana, p30: e30.pos,
    m90: e90.mediana, p90: e90.pos, edge: e90.mediana == null ? null : e90.mediana - (e90.base_mediana || 0) }[k];
}

function cxSignals(a) {
  const hace30 = a.hace30 || "";
  const on = (x) => x.hoy || (x.ultima && x.ultima >= hace30);
  let s = (a.senales || []).filter((x) => cx.sigFilt === "all" || (cx.sigFilt === "on" ? on(x) : x.grupo === cx.sigFilt));
  if (cx.sigSort) {
    const k = cx.sigSort, d = cx.sigDir;
    s = s.slice().sort((p, q) => {
      const x = cxSigVal(p, k), y = cxSigVal(q, k);
      if (x == null) return 1; if (y == null) return -1;
      return (x < y ? -1 : x > y ? 1 : 0) * d;
    });
  }
  document.querySelectorAll("#cxSigFilt button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === cx.sigFilt)));
  document.querySelectorAll(".cx-sig th").forEach((th) => th.classList.toggle("cx-sorted", th.dataset.k === cx.sigSort));
  const num = (v) => (v == null ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "") + fmtNum(Math.abs(v), 0) + "%");
  const col = (v, base) => (v == null || base == null ? "" : v > base ? "cx-up" : v < base ? "cx-dn" : "");
  const lectura = { 1: "bullish", "-1": "bearish", 0: "no direction (volatility)" };
  $("cxSigBody").innerHTML = s.map((x) => {
    const e30 = x.h["30"] || {}, e90 = x.h["90"] || {};
    const ahora = x.hoy ? "Active now" : x.ultima ? `${ddmm(x.ultima)}, ${x.ultima.slice(0, 4)}` : x.casos.length ? "" : "Not yet";
    const sinDatos = !x.casos.length && !e90.n;
    const nota = sinDatos ? `collecting since ${ddmm(x.desde)}, ${(x.desde || "").slice(0, 4)}` : `since ${x.desde ? x.desde.slice(0, 4) : "—"}${(e90.n || 0) < 5 ? ", few" : ""}`;
    const abierta = cx.sigOpen === x.id;
    const fila = `<tr class="cx-sr${on(x) ? " cx-on" : ""}${abierta ? " cx-open" : ""}" data-id="${x.id}" tabindex="0" aria-expanded="${abierta}"><td class="l"><b>${esc(x.nombre)}</b><span class="cx-q">${esc(x.que)} Usual reading: ${lectura[x.sentido]}.</span></td>
      <td class="l">${ahora}</td><td>${x.casos.length}<span class="cx-q">${nota}</span></td>
      <td class="${col(e30.mediana, e30.base_mediana)}">${num(e30.mediana)}</td><td class="${col(e30.pos, e30.base_pos)}">${e30.n ? e30.pos + "%" : "—"}</td>
      <td class="${col(e90.mediana, e90.base_mediana)}">${num(e90.mediana)}</td><td class="${col(e90.pos, e90.base_pos)}">${e90.n ? e90.pos + "%" : "—"}</td>
      <td class="cx-vs">${e90.base_pos == null ? "—" : `${num(e90.base_mediana)}, ${e90.base_pos}%`}</td></tr>`;
    return fila + (abierta ? `<tr class="cx-det"><td colspan="8"><div class="cx-detw"><div class="cx-chart cx-sigc" id="cxSigChart"></div><div class="cx-cases" id="cxSigCases"></div></div></td></tr>` : "");
  }).join("") || `<tr><td class="l" colspan="8">No signals in this filter</td></tr>`;
  if (cx.sigOpen && $("cxSigChart")) cxSigDetail(s.find((x) => x.id === cx.sigOpen));
}

function cxSigDetail(x) {
  if (!x) return;
  const cols = cx.series && cx.series.activos && cx.series.activos[cx.sym];
  if (!cols) { $("cxSigChart").innerHTML = `<div class="empty">Loading the price history…</div>`; return; }
  const idx = new Map(cols.d.map((d, i) => [d, i])), p = cols.precio;
  const fwd = (i, h) => (i + h < p.length && p[i] && p[i + h] ? (p[i + h] / p[i] - 1) * 100 : null);
  const casos = x.casos.map((d) => ({ d, i: idx.get(d) })).filter((c) => c.i != null).map((c) => ({ ...c, r30: fwd(c.i, 30), r90: fwd(c.i, 90) }));
  const marcas = casos.map((c) => ({ i: c.i, col: c.r90 == null ? C.muted : c.r90 > 0 ? C.put : C.call }));
  const desde = idx.get(x.desde) ?? 0;
  const spec = { kind: "sig_" + x.id, x: cols.d, log: true, fmt: cxPx, fmtY: (v) => "$" + fmtAxis(v),
    series: [{ key: "precio", name: `${cx.sym} price`, col: C.text, w: 1.4, v: p }] };
  const dias = (Date.parse(cols.d[cols.d.length - 1]) - Date.parse(cols.d[desde])) / CX_DAY;
  cxChart("cxSigChart", spec, { rango: Math.ceil(dias) + 1, log: true, marcas });
  const fila = (c) => `<tr><td class="l">${ddmm(c.d)}, ${c.d.slice(0, 4)}</td><td>${cxPx(p[c.i])}</td><td class="${c.r30 > 0 ? "cx-up" : c.r30 < 0 ? "cx-dn" : ""}">${cxPct(c.r30, 0)}</td><td class="${c.r90 > 0 ? "cx-up" : c.r90 < 0 ? "cx-dn" : ""}">${cxPct(c.r90, 0)}</td></tr>`;
  $("cxSigCases").innerHTML = casos.length
    ? `<p class="cx-q">Dots on the price: green, higher 90 days later; red, lower; grey, too recent to tell.</p><table class="cx-ctab"><thead><tr><th class="l">Case</th><th>Price</th><th>30 d</th><th>90 d</th></tr></thead><tbody>${casos.slice().reverse().map(fila).join("")}</tbody></table>`
    : `<p class="cx-q">No cases yet: ${x.grupo === "derivados" ? "this signal uses our own daily history, which started " + ddmm(x.desde) + "." : "the condition has not happened since the data starts."}</p>`;
}

/* ---------- GEX por strike y perfil */
function cxGexChart(a, gf) {
  const el = $("cxGex"), W = Math.max(320, el.clientWidth), H = Math.max(240, el.clientHeight);
  const L = 58, R = W - 58, T = 14, B = H - 30;
  const bars = gf.barras || [];
  if (!bars.length) { el.innerHTML = `<div class="empty">No open interest in this filter</div>`; return; }
  const lo = a.spot * 0.8, hi = a.spot * 1.2;
  const vb = bars.filter((b) => b[0] >= lo && b[0] <= hi);
  const xOf = (x) => L + ((x - lo) / (hi - lo)) * (R - L);
  const bm = Math.max(1, ...vb.map((b) => Math.max(b[1], -b[2])));
  const yb = niceTicks(-bm, bm, 4), yB = (v) => B - ((v - yb.lo) / (yb.hi - yb.lo)) * (B - T);
  const pp = gf.xs.map((x, i) => [x, gf.perfil[i]]).filter((p) => p[0] >= lo && p[0] <= hi);
  const pm = Math.max(1, ...pp.map((p) => Math.abs(p[1])));
  const yp = niceTicks(-pm, pm, 4), yP = (v) => B - ((v - yp.lo) / (yp.hi - yp.lo)) * (B - T);
  let s = yb.ticks.map((v) => `<line x1="${L}" x2="${R}" y1="${yB(v)}" y2="${yB(v)}" stroke="${C.grid}"/>` + txt(L - 8, yB(v) + 4, fmtBig(v), { a: "end", fs: 11 })).join("");
  s += yp.ticks.map((v) => txt(R + 8, yP(v) + 4, fmtBig(v), { fs: 11, c: C.accent })).join("");
  s += `<line x1="${L}" x2="${R}" y1="${yB(0)}" y2="${yB(0)}" stroke="${C.axis}"/>`;
  const steps = vb.map((b) => b[0]).sort((p, q) => p - q);
  let minGap = Infinity;
  for (let i = 1; i < steps.length; i++) minGap = Math.min(minGap, steps[i] - steps[i - 1]);
  const bw = Math.max(2, Math.min(18, ((isFinite(minGap) ? minGap : (hi - lo) / 40) / (hi - lo)) * (R - L) * 0.38));
  for (const [k, c, p] of vb) {
    const x = xOf(k);
    if (c) s += `<rect x="${(x - bw).toFixed(1)}" y="${yB(c).toFixed(1)}" width="${bw.toFixed(1)}" height="${(yB(0) - yB(c)).toFixed(1)}" fill="${C.pos}" fill-opacity=".8"/>`;
    if (p) s += `<rect x="${x.toFixed(1)}" y="${yB(0).toFixed(1)}" width="${bw.toFixed(1)}" height="${(yB(p) - yB(0)).toFixed(1)}" fill="${C.neg}" fill-opacity=".8"/>`;
  }
  s += `<path d="${pp.map((p, i) => `${i ? "L" : "M"}${xOf(p[0]).toFixed(1)},${yP(p[1]).toFixed(1)}`).join("")}" fill="none" stroke="${C.accent}" stroke-width="2"/>`;
  const vline = (x, col, lab, da, row) => {
    if (x == null || x < lo || x > hi) return "";
    const X = xOf(x);
    return `<line x1="${X}" x2="${X}" y1="${T}" y2="${B}" stroke="${col}" stroke-width="1.4"${da ? ` stroke-dasharray="${da}"` : ""}/>` + txt(X + 4, T + 10 + row * 13, lab, { fs: 11, c: col, w: 600 });
  };
  s += vline(gf.put_wall, C.put, "Put Wall", "4 3", 1) + vline(gf.call_wall, C.call, "Call Wall", "4 3", 1) + vline(gf.flip, C.amber, "Flip", "", 2);
  s += vline(a.spot, C.spotline, "Spot", "2 3", 0);
  const xt = niceTicks(lo, hi, Math.max(4, Math.round((R - L) / 90)));
  for (const v of xt.ticks) if (v >= lo && v <= hi) s += txt(xOf(v), B + 18, fmtNum(v), { a: "middle", fs: 11 });
  cx.geo.gex = { L, R, lo, hi, vb };
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${s}</svg>`;
}

function cxGexTip(e) {
  const g = cx.geo.gex;
  if (!g) return;
  const r = $("cxGex").getBoundingClientRect(), x = e.clientX - r.left;
  if (x < g.L || x > g.R || !g.vb.length) return macroTip("cxTip", null, e, "");
  const k = g.lo + ((x - g.L) / (g.R - g.L)) * (g.hi - g.lo);
  const b = g.vb.reduce((p, q) => (Math.abs(q[0] - k) < Math.abs(p[0] - k) ? q : p));
  macroTip("cxTip", null, e, `<div class="t">Strike ${cxPx(b[0])}</div>
    <div class="r">Calls <b style="color:${C.pos}">${fmtBig(b[1], true)}</b></div>
    <div class="r">Puts <b style="color:${C.neg}">${fmtBig(b[2], true)}</b></div>
    <div class="r">Net <b>${fmtBig(b[1] + b[2], true)}</b></div>`);
}

function cxTermTip(e) {
  const g = cx.geo.term;
  if (!g) return;
  const x = e.clientX - $("cxTerm").getBoundingClientRect().left;
  const r = g.t.reduce((p, q) => (Math.abs(g.xOf(q.dias) - x) < Math.abs(g.xOf(p.dias) - x) ? q : p));
  macroTip("cxTip", null, e, `<div class="t">${longDate(r.exp)}</div>
    <div class="r">ATM IV <b style="color:${C.accent}">${fmtNum(r.atm, 1)}</b></div>
    <div class="r">25-delta risk reversal <b>${r.rr25 == null ? "—" : fmtNum(r.rr25, 1)}</b></div>
    <div class="r">25-delta butterfly <b>${r.bf25 == null ? "—" : fmtNum(r.bf25, 1)}</b></div>
    <div class="r">Forward <b>${cxPx(r.fwd)}</b></div>`);
}

/* ---------- mapa de niveles: opciones y on-chain sobre el mismo eje de precio */
function cxLevelsChart(a) {
  const el = $("cxLevels"), W = Math.max(320, el.clientWidth), H = Math.max(120, el.clientHeight);
  const nv = a.niveles || [];
  if (!nv.length) { el.innerHTML = ""; return; }
  const L = 24, R = W - 24, Y = Math.round(H * 0.5);
  const ps = nv.map((n) => n.precio).concat(a.spot);
  const lo = Math.min(...ps) * 0.97, hi = Math.max(...ps) * 1.03, xOf = (x) => L + ((x - lo) / (hi - lo)) * (R - L);
  const col = { cw: C.call, pw: C.put, flip: C.amber, mp: C.muted, sth: C.purple, rp: C.accent, lth: C.prevClose };
  let s = `<line x1="${L}" x2="${R}" y1="${Y}" y2="${Y}" stroke="${C.axis}" stroke-width="2"/>`;
  // cuatro carriles de etiquetas (arriba, abajo, y un segundo nivel de cada uno): cada nivel, de izquierda a
  // derecha, va al primer carril donde no pisa a la etiqueta anterior
  const lanes = [{ up: true, d: 0 }, { up: false, d: 0 }, { up: true, d: 30 }, { up: false, d: 30 }].map((l) => ({ ...l, end: -1e9 }));
  const marcas = [];
  nv.slice().sort((p, q) => p.precio - q.precio).forEach((n) => {
    const X = xOf(n.precio), c = col[n.id] || C.muted;
    const lab1 = n.nombre, lab2 = `${cxPx(n.precio)} (${cxPct(n.dist)})`;
    const w = Math.max(textW(lab1, 11, 600), textW(lab2, 11)) + 12;
    const cx0 = Math.min(Math.max(X, L + w / 2 - 20), R - w / 2 + 20);   // dentro del grafico
    const lane = lanes.find((l) => cx0 - w / 2 >= l.end) || lanes.reduce((p, q) => (q.end < p.end ? q : p));
    lane.end = cx0 + w / 2;
    const y1 = lane.up ? Y - 30 - lane.d : Y + 24 + lane.d;
    s += `<line x1="${X}" x2="${X}" y1="${lane.up ? y1 + 17 : Y}" y2="${lane.up ? Y : y1 - 11}" stroke="${c}" stroke-width="1.2" stroke-opacity=".7"/>`;
    s += txt(cx0, y1, esc(lab1), { a: "middle", fs: 11, c, w: 600 }) + txt(cx0, y1 + 13, lab2, { a: "middle", fs: 11, c: C.muted });
    marcas.push(`<circle cx="${X}" cy="${Y}" r="4.5" fill="${C.surface}" stroke="${c}" stroke-width="2"/>`);
  });
  s += marcas.join("");
  const X = xOf(a.spot);
  s += `<rect x="${X - 2}" y="${Y - 11}" width="4" height="22" rx="2" fill="${C.text}"/>`;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${s}</svg>`;
}

/* ---------- tablas */
function cxTables(a, m) {
  const term = new Map((a.vol.term || []).map((r) => [r.exp, r]));
  const big = (r) => (r.grande ? ` class="cx-big"` : "");
  $("cxExpBody").innerHTML = (a.venc || []).filter((r) => r.dias >= 0).slice(0, 14).map((r) => {
    const t = term.get(r.exp) || {};
    return `<tr${big(r)}><td class="l">${ddmm(r.exp)} ${r.exp.slice(2, 4)}</td><td>${fmtNum(r.dias, r.dias < 2 ? 1 : 0)}</td><td>${fmtBig(r.nocional, true)}</td>
      <td>${fmtNum(r.pcr, 2)}</td><td>${cxPx(r.max_pain)}</td><td>${cxPct((r.max_pain / a.spot - 1) * 100)}</td><td>${fmtNum(t.atm, 1)}</td><td>${t.rr25 == null ? "—" : fmtNum(t.rr25, 1)}</td></tr>`;
  }).join("");
  const f = a.futuros || {};
  $("cxBasisBody").innerHTML = (f.basis || []).map((r) => `<tr><td class="l">${ddmm(r.exp)} ${r.exp.slice(2, 4)}</td><td>${fmtNum(r.dias, 0)}</td>
    <td>${cxPct(r.prima, 2)}</td><td>${cxPct(r.anual, 1)}</td><td>${r.oi_usd ? fmtBig(r.oi_usd, true) : "—"}</td></tr>`).join("") || `<tr><td class="l" colspan="5">No data</td></tr>`;
  const cell = (v) => `<td class="${v > 0 ? "cx-up" : v < 0 ? "cx-dn" : ""}">${cxPct(v)}</td>`;
  $("cxMktBody").innerHTML = (m.top || []).map((c, i) => `<tr><td class="l">${i + 1}</td><td class="l"><b>${esc(c.sym)}</b> <span class="cx-nm">${esc(c.nombre)}</span></td>
    <td>${cxPx(c.precio)}</td>${cell(c.c24)}${cell(c.c7)}${cell(c.c30)}<td>${fmtBig(c.cap, true)}</td><td>${cxPct(c.ath_dist, 0)}</td></tr>`).join("") || `<tr><td class="l" colspan="8">No data</td></tr>`;
}

function cxStables(m) {
  const lq = m.liquidez;
  if (!lq) { $("cxStbBody").innerHTML = `<tr><td class="l" colspan="5">No data</td></tr>`; $("cxStbCap").textContent = ""; return; }
  const cell = (v) => `<td class="${v > 0 ? "cx-up" : v < 0 ? "cx-dn" : ""}">${cxPct(v)}</td>`;
  $("cxStbCap").textContent = "Dollar stablecoins (DefiLlama): money parked inside crypto, ready to buy. Growing supply has gone with rising prices; shrinking, with money leaving.";
  $("cxStbBody").innerHTML = `<tr><td class="l"><b>All</b></td><td>${fmtBig(lq.total, true)}</td><td>100%</td>${cell(lq.c7)}${cell(lq.c30)}</tr>` +
    lq.top.map((x) => `<tr><td class="l"><b>${esc(x.sym)}</b> <span class="cx-nm">${esc(x.nombre)}</span></td><td>${fmtBig(x.total, true)}</td><td>${fmtNum(x.cuota, 1)}%</td>${cell(x.c7)}${cell(x.c30)}</tr>`).join("");
}

/* ---------- controles */
const cxSeg = (id, fn) => $(id).addEventListener("click", (e) => { const b = e.target.closest("button"); if (b && b.dataset.v != null) fn(b.dataset.v); });
$("cxRead").addEventListener("click", (e) => { if (e.target.id === "cxMas") { cx.verTodo = !cx.verTodo; renderCrypto(); } });
$("cxSigLink").addEventListener("click", () => { cx.tab = "signals"; cx.sigFilt = "on"; store.set("cxTab", "signals"); store.set("cxSigFilt", "on"); renderCrypto(); $("cxTabs").scrollIntoView({ block: "nearest" }); });
cxSeg("cxSym", (v) => { cx.sym = v; store.set("cxSym", v); cx.sigOpen = null; renderCrypto(); });
cxSeg("cxFilt", (v) => { cx.filt = v; store.set("cxFilt", v); renderCrypto(); });
cxSeg("cxTabs", (v) => { cx.tab = v; store.set("cxTab", v); renderCrypto(); });
cxSeg("cxActMet", (v) => { cx.met = v; store.set("cxMet", v); cxActivity(); });
cxSeg("cxNets", (v) => { cx.net = v; store.set("cxNet", v); cxActivity(); });
cxSeg("cxModalNets", (v) => { cx.net = v; store.set("cxNet", v); cxActivity(); cxModalRender(); });
cxSeg("cxSigFilt", (v) => { cx.sigFilt = v; store.set("cxSigFilt", v); cxSignals(cx.data.activos[cx.sym]); });
cxSeg("cxRange", (v) => { cx.modal.rango = +v; store.set("cxR_" + cx.modal.kind, +v); cxModalRender(); });
$("cxLog").addEventListener("change", (e) => { cx.modal.log = e.target.checked; store.set("cxLog_" + cx.modal.kind, e.target.checked); cxModalRender(); });
$("cxTabs").addEventListener("keydown", (e) => {
  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
  const bs = [...$("cxTabs").querySelectorAll("button")], i = bs.findIndex((b) => b.dataset.v === cx.tab);
  const b = bs[(i + (e.key === "ArrowRight" ? 1 : bs.length - 1)) % bs.length];
  cx.tab = b.dataset.v; store.set("cxTab", cx.tab); renderCrypto(); b.focus();
});
// solo los botones con data-chart: Older, Expand y Full screen del mapa de liquidaciones comparten el estilo pero no esto
document.querySelectorAll("#cryptoView .cx-exp[data-chart]").forEach((b) => b.addEventListener("click", () => cxOpenModal(b.dataset.chart)));
$("cxModalClose").addEventListener("click", cxCloseModal);
$("cxModal").addEventListener("click", (e) => { if (e.target.id === "cxModal") cxCloseModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && cx.modal) cxCloseModal(); });
// leyenda: oculta o muestra una serie (se recuerda por grafico)
$("cryptoView").addEventListener("click", (e) => {
  const li = e.target.closest(".cx-li");
  if (!li) return;
  const kind = li.closest(".cx-leg").dataset.kind, set = cx.ocultas[kind] || (cx.ocultas[kind] = new Set());
  if (set.has(li.dataset.k)) set.delete(li.dataset.k); else set.add(li.dataset.k);
  if (kind === "act") { cxActivity(); if (cx.modal) cxModalRender(); } else renderCrypto();
});
// senales: ordenar por columna y abrir los casos de una
document.querySelector(".cx-sig thead").addEventListener("click", (e) => {
  const th = e.target.closest("th");
  if (!th || !th.dataset.k) return;
  cx.sigDir = cx.sigSort === th.dataset.k ? -cx.sigDir : th.dataset.k === "nombre" ? 1 : -1;
  cx.sigSort = th.dataset.k;
  cxSignals(cx.data.activos[cx.sym]);
});
const cxSigToggle = (tr) => { cx.sigOpen = cx.sigOpen === tr.dataset.id ? null : tr.dataset.id; cxSignals(cx.data.activos[cx.sym]); };
$("cxSigBody").addEventListener("click", (e) => { const tr = e.target.closest("tr.cx-sr"); if (tr) cxSigToggle(tr); });
$("cxSigBody").addEventListener("keydown", (e) => { const tr = e.target.closest("tr.cx-sr"); if (tr && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); cxSigToggle(tr); } });
// tooltips
$("cxGex").addEventListener("mousemove", cxGexTip);
$("cxTerm").addEventListener("mousemove", cxTermTip);
for (const id of ["cxCost", "cxDvol", "cxFund", "cxLev", "cxMin", "cxSopr", "cxAct", "cxModalChart"]) {
  $(id).addEventListener("mousemove", (e) => cxChartTip(id, e));
}
$("cryptoView").addEventListener("mousemove", (e) => { if (e.target.closest("#cxSigChart")) cxChartTip("cxSigChart", e); });
$("cxSigBody").addEventListener("mouseleave", () => { $("cxTip").hidden = true; });
for (const id of ["cxGex", "cxTerm", "cxCost", "cxDvol", "cxFund", "cxLev", "cxMin", "cxSopr", "cxAct", "cxModalChart"]) {
  $(id).addEventListener("mouseleave", () => {
    $("cxTip").hidden = true; $("cxMTip").hidden = true;
    const hl = $(id).querySelector(".cx-hl"); if (hl) hl.setAttribute("visibility", "hidden");
  });
}
