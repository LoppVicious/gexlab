"use strict";
/* ============================================================ Social (Research, solo el administrador)
   Posts para X de cada cierre: la conclusion del dia y el playbook de la sesion siguiente, en hilos, mas posts
   sueltos (acciones, VIX). Datos y graficos de social_diario.py (hacia las 16:25 ET; las acciones, al acabar el
   historial diario); textos de /x-diario en Claude Code. Rutas /api/social/* (nube/social.js). Copiar texto o imagen,
   descargar el PNG y marcar lo publicado. Globales con prefijo soc. */

const soc = { dias: null, dia: null, datos: null, at: 0, ctrl: null };
const SOC_MAX = 280;
const socLargo = (s) => [...String(s)].length;   // como nube/social.js
const SOC_MOTIVO = {
  move_vs_implied_big: "moved more than implied", move_vs_implied_small: "moved less than implied",
  regime_flip: "gamma regime flipped", near_call_wall: "close near the Call Wall", near_put_wall: "close near the Put Wall",
  big_sigma_move: "big move in sigmas", iv_jump: "IV jump", options_volume_spike: "options volume spike",
  big_vix_move: "big VIX move", term_structure_inverted: "VIX curve inverted", vix_high_percentile: "VIX high vs last year",
  monthly_opex: "monthly opex", high_impact_event: "high-impact event", narrow_breadth: "narrow breadth",
  broad_selloff: "broad selloff", broad_rally: "broad rally", big_cross_asset_move: "big cross-asset move",
};
const socFecha = (iso) => { const d = new Date(iso + "T12:00:00Z"); return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }); };
const socPng = (n) => `/api/social/${soc.dia}/g/${encodeURIComponent(n)}.png`;
const socPct = (v) => (v == null ? "-" : `${v >= 0 ? "+" : ""}${v}%`);
const socMotivos = (b) => (b.motivos && b.motivos.length ? ", " + b.motivos.map((m) => esc(SOC_MOTIVO[m] || m)).join(", ") : "");

function showSocial() {
  if (soc.dias) { renderSocial(); setStatus("", socStatus()); }
  if (!soc.dias || Date.now() - soc.at > 300000) loadSocial();
}
function socStatus() { return soc.datos ? `Close of ${socFecha(soc.dia)}` : ""; }

async function socPide(ruta, datos) {
  const r = await fetch(ruta, datos === undefined ? { signal: soc.ctrl && soc.ctrl.signal } : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(datos) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Error ${r.status}`);
  return d;
}

async function loadSocial() {
  if (soc.ctrl) soc.ctrl.abort();
  soc.ctrl = new AbortController();
  $("refreshBtn").classList.add("spin");
  setStatus("busy", "Loading posts…");
  if (!soc.dias) $("socBody").innerHTML = `<div class="empty">Loading posts…</div>`;
  try {
    soc.dias = (await socPide("/api/social/dias")).dias;
    if (!soc.dia || !soc.dias.includes(soc.dia)) soc.dia = soc.dias[0] || null;
    soc.datos = soc.dia ? await socPide(`/api/social/${soc.dia}`) : null;
    soc.at = Date.now();
    if (state.mode === "social") { renderSocial(); setStatus("", socStatus()); }
  } catch (e) {
    if (e.name === "AbortError") return;
    if (state.mode === "social") {
      setStatus("err", "No data");
      $("socBody").innerHTML = `<div class="empty">${esc(e.message === "Failed to fetch" ? "The server is not responding." : e.message)}</div>`;
    }
  } finally {
    $("refreshBtn").classList.remove("spin");
  }
}

function socResumen(paq) {
  const chips = [];
  for (const [sym, b] of Object.entries(paq.indices || {})) {
    if (b.estado !== "ok") { chips.push(`<span class="soc-chip off">${esc(sym)}: no data</span>`); continue; }
    chips.push(`<span class="soc-chip"><b>${esc(sym)}</b> ${socPct(b.cambio_pct)}${socMotivos(b)}</span>`);
  }
  const v = paq.vix || {};
  chips.push(v.estado === "ok" ? `<span class="soc-chip"><b>VIX</b> ${esc(v.cierre)} (${socPct(v.cambio_pct)})${socMotivos(v)}</span>` : `<span class="soc-chip off">VIX: no data</span>`);
  const m = paq.mercados || {};
  if (m.estado === "ok") {
    for (const [grupo, filas] of Object.entries(m.grupos || {})) {
      const fila = (x) => (x.rendimiento_pct != null ? `10Y ${x.rendimiento_pct}%${x.cambio_pb != null ? ` (${x.cambio_pb >= 0 ? "+" : ""}${x.cambio_pb} bp)` : ""}` : `${esc(x.sym)} ${socPct(x.cambio_pct)}`);
      if (filas.length) chips.push(`<span class="soc-chip"><b>${esc(grupo)}</b> ${filas.map(fila).join(", ")}</span>`);
    }
    const a = m.amplitud || {};
    if (a.sectores_total) chips.push(`<span class="soc-chip"><b>Sectors</b> ${a.sectores_suben}/${a.sectores_total} up${a.rsp_vs_spy != null ? `, RSP vs SPY ${socPct(a.rsp_vs_spy)}` : ""}${socMotivos(m)}</span>`);
  } else chips.push(`<span class="soc-chip off">Cross-asset: no data</span>`);
  const acc = paq.acciones || {};
  chips.push(acc.estado === "ok" ? `<span class="soc-chip"><b>Stocks</b> ${acc.suben} up, ${acc.bajan} down${socMotivos(acc)}</span>`
    : `<span class="soc-chip off">Stocks: after the daily history</span>`);
  const n = paq.manana || {};
  if (n.estado === "ok") chips.push(`<span class="soc-chip"><b>${esc(socFecha(n.sesion))}</b> ${(n.eventos || []).length ? n.eventos.map((e) => `${esc(e.hora || "")} ${esc(e.evento)}`).join(", ") : "no major events"}${n.opex_mensual ? ", monthly opex" : ""}</span>`);
  return `<div class="soc-chips">${chips.join("")}</div>`;
}

function socImagen(n, alt) {
  return `<figure class="soc-img"><img src="${socPng(n)}" alt="${esc(alt || n)}" loading="lazy" width="1600" height="900">
    <figcaption><button class="ghost" data-soc-img="${esc(n)}">Copy image</button>
      <a class="ghost" href="${socPng(n)}" download="gexlab_${esc(soc.dia)}_${esc(n)}.png">Download</a></figcaption></figure>`;
}

function socTexto(t, etiqueta) {
  const n = socLargo(t);
  return `<div class="soc-txt"><div class="soc-lbl">${etiqueta}</div>
    <textarea rows="${Math.min(9, Math.max(4, String(t).split("\n").length + 1))}" spellcheck="true" aria-label="${etiqueta}">${esc(t)}</textarea>
    <div class="soc-acc"><span class="soc-n${n > SOC_MAX ? " over" : ""}">${n}/${SOC_MAX}</span><button class="ghost soc-copy" data-soc-txt>Copy text</button></div></div>`;
}

function socPieza(p) {
  const hilo = p.hilo || [];
  return `<article class="soc-post${p.publicado ? " done" : ""}" data-id="${esc(p.id)}">
    <header><h3>${esc(p.titulo || p.id)}${hilo.length ? `<span class="soc-hilo">Thread, ${hilo.length + 1} posts</span>` : ""}</h3>
      <label class="soc-pub"><input type="checkbox" data-soc-pub ${p.publicado ? "checked" : ""}> Posted</label></header>
    <div class="soc-grid">
      <div class="soc-imgs">${(p.graficos || []).map((g) => socImagen(g, p.alt)).join("") || '<p class="soc-mute">Text only</p>'}</div>
      <div class="soc-textos">${socTexto(p.texto, hilo.length ? "Post 1" : "Post")}${hilo.map((t, i) => socTexto(t, `Reply ${i + 1}`)).join("")}
        ${p.alt ? `<p class="soc-alt"><b>Alt text:</b> ${esc(p.alt)}</p>` : ""}</div>
    </div></article>`;
}

function renderSocial() {
  const body = $("socBody");
  $("socDia").innerHTML = (soc.dias || []).map((d) => `<option value="${d}"${d === soc.dia ? " selected" : ""}>${esc(socFecha(d))}</option>`).join("");
  if (!soc.dias || !soc.dias.length) { body.innerHTML = `<div class="empty">Nothing yet. The first package is made after the next close, around 16:25 ET.</div>`; return; }
  const paq = (soc.datos || {}).paquete, textos = (soc.datos || {}).textos;
  if (!paq) { body.innerHTML = `<div class="empty">No data for this day.</div>`; return; }
  const usados = new Set((textos && textos.piezas || []).flatMap((p) => p.graficos || []));
  const bloques = [...Object.values(paq.indices || {}), paq.acciones, paq.vix, paq.mercados];
  const sueltos = [...new Set(bloques.flatMap((b) => (b && b.graficos) || []))].filter((n) => !usados.has(n));
  body.innerHTML = `<p class="soc-when">Close of ${esc(socFecha(paq.fecha))}, data generated ${esc(paq.generado)}${paq.acciones_generado ? `, stocks ${esc(paq.acciones_generado.slice(11))}` : ""}. Playbook for ${esc(socFecha(paq.siguiente_sesion))}.</p>`
    + socResumen(paq)
    + (textos ? textos.piezas.map(socPieza).join("")
      : `<div class="soc-vacio">No texts yet. Run <code>/x-diario</code> in Claude Code to write the recap and the playbook.</div>`)
    + (sueltos.length ? `<h3 class="soc-h">${textos ? "Other charts" : "Charts"}</h3><div class="soc-imgs soc-suelta">${sueltos.map((n) => socImagen(n)).join("")}</div>` : "");
}

function socAviso(btn, txt) {
  const antes = btn.textContent;
  btn.textContent = txt;
  setTimeout(() => { btn.textContent = antes; }, 1400);
}

function socInit() {
  if (!$("socialView")) return;
  $("socDia").addEventListener("change", async () => {
    soc.dia = $("socDia").value;
    $("socBody").innerHTML = `<div class="empty">Loading…</div>`;
    try { soc.datos = await socPide(`/api/social/${soc.dia}`); renderSocial(); setStatus("", socStatus()); }
    catch (e) { $("socBody").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  });
  const body = $("socBody");
  body.addEventListener("input", (e) => {
    if (e.target.tagName !== "TEXTAREA") return;
    const n = socLargo(e.target.value), el = e.target.closest(".soc-txt").querySelector(".soc-n");
    el.textContent = `${n}/${SOC_MAX}`;
    el.classList.toggle("over", n > SOC_MAX);
  });
  body.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    try {
      if (b.hasAttribute("data-soc-txt")) {
        await navigator.clipboard.writeText(b.closest(".soc-txt").querySelector("textarea").value);
        socAviso(b, "Copied");
      } else if (b.dataset.socImg) {
        const blob = fetch(socPng(b.dataset.socImg)).then((r) => { if (!r.ok) throw new Error("Image not found"); return r.blob(); });
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        socAviso(b, "Copied");
      }
    } catch (err) {
      socAviso(b, "Failed");
      console.warn("social:", err);
    }
  });
  body.addEventListener("change", async (e) => {
    if (!e.target.hasAttribute("data-soc-pub")) return;
    const art = e.target.closest(".soc-post");
    try {
      await socPide(`/api/social/${soc.dia}/publicado`, { id: art.dataset.id, publicado: e.target.checked });
      art.classList.toggle("done", e.target.checked);
      const p = soc.datos.textos && soc.datos.textos.piezas.find((x) => x.id === art.dataset.id);
      if (p) p.publicado = e.target.checked ? new Date().toISOString() : null;
    } catch (err) {
      e.target.checked = !e.target.checked;
      setStatus("err", err.message);
    }
  });
}
socInit();
