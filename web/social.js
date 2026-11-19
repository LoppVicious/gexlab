// GEX Lab - seccion Social de /admin: publicaciones para X de cada cierre (graficos de social_diario.py y textos
// de /x-diario). Copiar texto o imagen, descargar el PNG y marcar lo publicado. Solo el admin (rutas /api/social/).
"use strict";
(function () {
  const $ = (id) => document.getElementById(id);
  const cuerpo = $("socBody"), selDia = $("socDia");
  if (!cuerpo || !selDia) return;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const MAX = 280;
  const largo = (s) => [...String(s)].length;   // como nube/social.js
  const MES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const DIA = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const fecha = (iso) => { const d = new Date(iso + "T12:00:00Z"); return `${DIA[d.getUTCDay()]} ${MES[d.getUTCMonth()]} ${d.getUTCDate()}`; };
  const MOTIVO = {
    move_vs_implied_big: "moved more than implied", move_vs_implied_small: "moved less than implied", regime_flip: "gamma regime flipped",
    near_call_wall: "close near the Call Wall", near_put_wall: "close near the Put Wall", big_sigma_move: "big move in sigmas",
    iv_jump: "IV jump", options_volume_spike: "options volume spike", big_vix_move: "big VIX move",
    term_structure_inverted: "VIX curve inverted", vix_high_percentile: "VIX high vs last year", monthly_opex: "monthly opex",
    high_impact_event: "high-impact event",
  };

  async function pedir(ruta, datos) {
    const r = await fetch(ruta, datos === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(datos) });
    const d = await r.json().catch(() => ({}));
    if (r.status === 401) { location.href = "/login"; throw new Error("Session expired"); }
    if (!r.ok) throw new Error(d.error || `Error ${r.status}`);
    return d;
  }
  const png = (f, n) => `/api/social/${f}/g/${encodeURIComponent(n)}.png`;

  function resumen(paq) {
    const chips = [];
    for (const [sym, b] of Object.entries(paq.indices || {})) {
      if (b.estado !== "ok") { chips.push(`<span class="soc-chip off">${esc(sym)}: no data</span>`); continue; }
      chips.push(`<span class="soc-chip"><b>${esc(sym)}</b> ${b.cambio_pct >= 0 ? "+" : ""}${esc(b.cambio_pct)}%${b.motivos.length ? ", " + b.motivos.map((m) => esc(MOTIVO[m] || m)).join(", ") : ""}</span>`);
    }
    for (const [k, nombre] of [["acciones", "Stocks"], ["vix", "VIX"], ["manana", "Next session"]]) {
      const b = paq[k] || {};
      if (b.estado !== "ok") chips.push(`<span class="soc-chip off">${nombre}: no data</span>`);
      else if (b.motivos.length) chips.push(`<span class="soc-chip"><b>${nombre}</b> ${b.motivos.map((m) => esc(MOTIVO[m] || m)).join(", ")}</span>`);
    }
    return `<div class="soc-chips">${chips.join("")}</div>`;
  }

  function imagen(f, n, alt) {
    return `<figure class="soc-img"><img src="${png(f, n)}" alt="${esc(alt || n)}" loading="lazy" width="1600" height="900">
      <figcaption><button class="ab ghost" data-copiar-img="${esc(n)}">Copy image</button>
        <a class="ab ghost" href="${png(f, n)}" download="gexlab_${esc(f)}_${esc(n)}.png">Download</a></figcaption></figure>`;
  }

  function pieza(f, p) {
    const n = largo(p.texto);
    return `<article class="soc-post${p.publicado ? " done" : ""}" data-id="${esc(p.id)}">
      <header><h3>${esc(p.titulo || p.id)}</h3>
        <label class="soc-pub"><input type="checkbox" data-publicado ${p.publicado ? "checked" : ""}> Posted</label></header>
      <div class="soc-grid">
        <div class="soc-imgs">${(p.graficos || []).map((g) => imagen(f, g, p.alt)).join("") || '<p class="mute">Text only</p>'}</div>
        <div class="soc-txt">
          <textarea rows="7" spellcheck="true" aria-label="Post text">${esc(p.texto)}</textarea>
          <div class="soc-acc"><span class="soc-n${n > MAX ? " over" : ""}">${n}/${MAX}</span>
            <button class="ab" data-copiar-txt>Copy text</button></div>
          ${p.alt ? `<p class="soc-alt"><b>Alt text:</b> ${esc(p.alt)}</p>` : ""}
        </div>
      </div></article>`;
  }

  async function cargar(f) {
    cuerpo.innerHTML = '<p class="mute">Loading…</p>';
    try {
      const { paquete, textos } = await pedir(`/api/social/${f}`);
      const usados = new Set((textos && textos.piezas || []).flatMap((p) => p.graficos || []));
      const todos = ["indices", "acciones", "vix"].flatMap((k) => k === "indices"
        ? Object.values(paquete.indices || {}).flatMap((b) => b.graficos || []) : (paquete[k] || {}).graficos || []);
      const sueltos = [...new Set(todos)].filter((n) => !usados.has(n));
      cuerpo.innerHTML = `<p class="when">Data for ${esc(fecha(paquete.fecha))} close, generated ${esc(paquete.generado)}. Next session ${esc(fecha(paquete.siguiente_sesion))}.</p>`
        + resumen(paquete)
        + (textos ? textos.piezas.map((p) => pieza(f, p)).join("")
          : '<p class="soc-vacio">No texts yet for this day. Run <code>/x-diario</code> in Claude Code to write them.</p>')
        + (sueltos.length ? `<h3 class="soc-h">${textos ? "Other charts" : "Charts"}</h3><div class="soc-imgs suelta">${sueltos.map((n) => imagen(f, n)).join("")}</div>` : "");
    } catch (e) {
      cuerpo.innerHTML = `<p class="msg err">${esc(e.message)}</p>`;
    }
  }

  async function avisar(btn, txt) {
    const antes = btn.textContent;
    btn.textContent = txt;
    setTimeout(() => { btn.textContent = antes; }, 1400);
  }

  cuerpo.addEventListener("input", (e) => {
    if (e.target.tagName !== "TEXTAREA") return;
    const n = largo(e.target.value), el = e.target.closest(".soc-txt").querySelector(".soc-n");
    el.textContent = `${n}/${MAX}`;
    el.classList.toggle("over", n > MAX);
  });
  cuerpo.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    try {
      if (b.hasAttribute("data-copiar-txt")) {
        await navigator.clipboard.writeText(b.closest(".soc-txt").querySelector("textarea").value);
        avisar(b, "Copied");
      } else if (b.dataset.copiarImg) {
        const blob = fetch(png(selDia.value, b.dataset.copiarImg)).then((r) => { if (!r.ok) throw new Error("Image not found"); return r.blob(); });
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        avisar(b, "Copied");
      }
    } catch (err) {
      avisar(b, "Failed");
      console.warn("social:", err);
    }
  });
  cuerpo.addEventListener("change", async (e) => {
    if (!e.target.hasAttribute("data-publicado")) return;
    const art = e.target.closest(".soc-post");
    try {
      await pedir(`/api/social/${selDia.value}/publicado`, { id: art.dataset.id, publicado: e.target.checked });
      art.classList.toggle("done", e.target.checked);
    } catch (err) {
      e.target.checked = !e.target.checked;
      alert(err.message);
    }
  });
  selDia.addEventListener("change", () => cargar(selDia.value));

  (async () => {
    try {
      const { dias } = await pedir("/api/social/dias");
      if (!dias.length) { cuerpo.innerHTML = '<p class="mute">Nothing yet. The first package is made after the next close.</p>'; return; }
      selDia.innerHTML = dias.map((d) => `<option value="${d}">${esc(fecha(d))}</option>`).join("");
      cargar(dias[0]);
    } catch (e) {
      cuerpo.innerHTML = `<p class="msg err">${esc(e.message)}</p>`;
    }
  })();
})();
