// GEX Lab - adaptador de la version en la nube. Solo actua si el servidor es el de Cloudflare (GEX_ME.nube).
// La app sigue llamando a las mismas rutas /api/... que en el PC; aqui se traducen:
//   - niveles y mapa: lo precalculado por el motor si existe; si no, se calcula en el navegador (motor-web.js)
//   - escaner, validacion, compass: los archivos de la lista del usuario
//   - curva VIX, COT, resumen, recolector: los archivos publicados por el motor
"use strict";
(function () {
  const ME = window.GEX_ME;
  if (!ME || !ME.nube) return;
  const realFetch = window.fetch.bind(window);
  const PROXY = { SPX: "SPY", XSP: "SPY", NDX: "QQQ", RUT: "IWM", DJX: "DIA" };
  const json = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: { "Content-Type": "application/json" } });
  const status = (t) => { try { if (typeof setStatus === "function") setStatus("", t); } catch { /* sin barra de estado */ } };

  function normalize(s) {
    s = String(s || "").toUpperCase().trim().replace(/^[_^$]+/, "").replace(/[-/]/g, ".");
    return /^[A-Z][A-Z0-9.]{0,9}$/.test(s) ? s : null;
  }
  // mismo criterio que motor.py (rango_canon / vista_canon)
  function rango(r) {
    r = String(r == null ? "5" : r).trim().toLowerCase().replace(",", ".");
    if (r === "auto") return "auto";
    const v = Math.min(30, Math.max(0.3, parseFloat(r) || 5));
    return v.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  }
  function vista(q, sym) {
    let dte = q.get("dte") || "45";
    if (!["0", "7", "45", "all"].includes(dte)) dte = "45";
    const combo = q.get("combine") === "1" && PROXY[sym] ? "1" : "0";
    const pos = q.get("pos") === "flow" && combo === "0" ? "flow" : "standard";
    const s = q.get("session");
    const sess = ["auto", "last", "next"].includes(s) ? s : "auto";
    const model = q.get("model") === "gexbot" ? "gexbot" : "spotgamma";
    return { dte, range: rango(q.get("range")), pos, combo, sess, model };
  }

  // ------------------------------------------------------------ motor del navegador
  let worker = null, seq = 0, warmed = false;
  const pending = new Map();
  function motor(op, args, paquetes) {
    if (!worker) {
      worker = new Worker("/motor-web.js");
      worker.onmessage = (e) => {
        const p = pending.get(e.data.id);
        if (!p) return;
        pending.delete(e.data.id);
        e.data.ok ? p.resolve(e.data.json) : p.reject(new Error(e.data.error));
      };
      worker.onerror = (e) => { for (const p of pending.values()) p.reject(new Error("El motor del navegador no ha podido arrancar")); pending.clear(); worker = null; console.error(e); };
    }
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, op, args, paquetes });
    });
  }

  // ------------------------------------------------------------ paquetes de cada ticker
  const paqMem = {};
  const sleep = (ms, signal) => new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    if (signal) signal.addEventListener("abort", () => { clearTimeout(t); rej(new DOMException("Aborted", "AbortError")); }, { once: true });
  });

  // datos viejos: los tickers de alguna lista se renuevan en cada ciclo; los demas solo cuando alguien los mira.
  // Si lo publicado es antiguo se ensena igualmente y se pide a la nube una version nueva en segundo plano.
  function viejo(edadS) {
    if (edadS == null || isNaN(edadS)) return false;
    const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    const o = Object.fromEntries(f.formatToParts(new Date()).map((x) => [x.type, x.value]));
    const min = parseInt(o.hour, 10) * 60 + parseInt(o.minute, 10);
    const sesion = !["Sat", "Sun"].includes(o.weekday) && min >= 9 * 60 && min <= 16 * 60 + 45;
    return sesion ? edadS > 25 * 60 : edadS > 12 * 3600;
  }
  const renovando = {};
  async function renovar(sym) {
    if (renovando[sym]) return;
    renovando[sym] = true;
    try {
      const antes = paqMem[sym] && paqMem[sym].data.generado;
      const pr = await realFetch("/api/pedir", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbols: [sym] }) });
      if (!pr.ok) return;
      for (let i = 0; i < 16; i++) {          // hasta 4 min
        await sleep(15000);
        const r = await realFetch(`/api/pub/t/${encodeURIComponent(sym)}/paquete.json`);
        if (!r.ok) continue;
        const data = await r.json();
        if (data.generado === antes) continue;
        paqMem[sym] = { data, at: Date.now() };
        // si sigue en pantalla, se recarga en silencio con los datos nuevos
        try { if (typeof state !== "undefined" && state.symbol === sym && state.mode === "analysis" && typeof load === "function") load(false, true); } catch { /* */ }
        return;
      }
    } finally { renovando[sym] = false; }
  }

  async function paquete(sym, signal, fresh) {
    const hit = paqMem[sym];
    if (hit && !fresh && Date.now() - hit.at < 60000) return hit.data;
    let pedido = false;
    const t0 = Date.now();
    for (;;) {
      const r = await realFetch(`/api/pub/t/${encodeURIComponent(sym)}/paquete.json`, { signal });
      if (r.ok) {
        const data = await r.json();
        paqMem[sym] = { data, at: Date.now() };
        if (viejo(parseInt(r.headers.get("X-Edad"), 10))) renovar(sym);
        return data;
      }
      if (r.status !== 404) throw new Error((await r.json().catch(() => ({}))).error || "No se pudieron leer los datos");
      if (!pedido) {
        const pr = await realFetch("/api/pedir", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbols: [sym] }), signal });
        const d = await pr.json().catch(() => ({}));
        if (!pr.ok || d.ok === false) throw new Error(d.error || "No se pudo pedir el cálculo en la nube");
        pedido = true;
      }
      if (Date.now() - t0 > 240000) throw new Error(`El cálculo de ${sym} en la nube está tardando más de lo normal. Vuelve a intentarlo en un par de minutos.`);
      status(`Descargando ${sym} en la nube (la primera vez tarda 1–2 min)…`);
      await sleep(8000, signal);
    }
  }

  async function analisis(kind, q, signal) {
    const sym = normalize(q.get("symbol"));
    if (!sym) return json(400, { error: "Ticker no valido" });
    const v = vista(q, sym);
    const spot = q.get("spot");
    const refresh = q.get("refresh") === "1";
    if (!spot && !refresh) {
      const key = `${v.dte}_${v.range}_${v.pos}_${v.combo}` + (v.model === "gexbot" ? "_gb" : "") + (kind === "heat" ? `_${v.sess}` : "");
      const r = await realFetch(`/api/pub/t/${encodeURIComponent(sym)}/${kind === "heat" ? "mapa" : "niveles"}/${key}.json`, { signal });
      if (r.ok) {
        // una vista precalculada antigua no se usa: se recalcula aqui con el paquete (y se pide renovarlo)
        if (!viejo(parseInt(r.headers.get("X-Edad"), 10))) return r;
        renovar(sym);
      }
    }
    const paqs = [await paquete(sym, signal, refresh)];
    if (v.combo === "1") paqs.push(await paquete(PROXY[sym], signal, refresh));
    const args = {
      symbol: sym, max_dte: v.dte === "all" ? null : parseInt(v.dte, 10), window_pct: v.range === "auto" ? "auto" : parseFloat(v.range),
      spot_override: spot ? parseFloat(spot) : null, combine: v.combo === "1", positioning: v.pos, model: v.model,
    };
    if (kind === "heat") args.which = v.sess;
    if (!warmed) status("Preparando el cálculo en el navegador (solo la primera vez)…");
    try {
      const out = await motor(kind === "heat" ? "heatmap" : "compute", args, paqs);
      warmed = true;
      if (signal && signal.aborted) throw new DOMException("Aborted", "AbortError");
      return new Response(out, { headers: { "Content-Type": "application/json" } });
    } catch (e) {
      if (e.name === "AbortError") throw e;
      return json(400, { error: e.message });
    }
  }

  async function lista(file, signal, what) {
    const r = await realFetch(`/api/lista/${file}`, { signal });
    if (r.status === 404) return json(503, { error: `${what}: se calcula con tu lista en el próximo ciclo del motor (como mucho 15 min).` });
    return r;
  }
  async function pub(file, signal, what) {
    const r = await realFetch(`/api/pub/${file}`, { signal });
    if (r.status === 404) return json(503, { error: `${what}: todavía no hay datos del motor.` });
    return r;
  }

  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.origin);
    if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) return realFetch(input, init);
    const q = url.searchParams, s = init.signal;
    switch (url.pathname) {
      case "/api/gex": return analisis("gex", q, s);
      case "/api/heatmap": return analisis("heat", q, s);
      case "/api/scan": return lista(`escaner_${q.get("dte") || "45"}.json`, s, "Escáner");
      case "/api/validation": return lista(`validacion_${q.get("dte") || "45"}_${q.get("mode") === "flow" ? "flow" : "standard"}_${q.get("model") === "gexbot" ? "gexbot" : "spotgamma"}.json`, s, "Validación");
      case "/api/compass": return lista("compass.json", s, "Compass");
      case "/api/vix": return pub("vix.json", s, "Curva VIX");
      case "/api/cot": return pub("cot.json", s, "COT");
      case "/api/cot_history": return pub(`cot_hist/${encodeURIComponent(q.get("key") || "ES")}.json`, s, "COT");
      case "/api/summary": return pub("resumen.json", s, "Resumen");
      case "/api/eventos": return pub("eventos.json", s, "Calendario");
      case "/api/vol": {
        const sym = normalize(q.get("symbol"));
        if (!sym) return json(400, { error: "Ticker no valido" });
        const url = `/api/pub/t/${encodeURIComponent(sym)}/vol.json`;
        let r = await realFetch(url, { signal: s });
        if (r.status === 404) {
          await paquete(sym, s, true);
          for (let i = 0; i < 4 && r.status === 404; i++) { await sleep(i ? 3000 : 0, s); r = await realFetch(url, { signal: s }); }
        }
        if (r.ok && viejo(parseInt(r.headers.get("X-Edad"), 10))) renovar(sym);
        return r;
      }
      case "/api/collector": return pub("recolector.json", s, "Recolector");
      default: return realFetch(input, init);
    }
  };

  // ------------------------------------------------------------ administracion de usuarios (solo el administrador)
  if (!ME.admin) return;
  const ITER = 310000;
  const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
  async function derive(pw, salHex) {
    const sal = new Uint8Array(salHex.match(/../g).map((h) => parseInt(h, 16)));
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
    return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: sal, iterations: ITER }, key, 256));
  }
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const css = document.createElement("style");
  css.textContent = `
  .adm-back { position: fixed; inset: 0; background: rgba(5,8,13,.66); display: flex; align-items: flex-start; justify-content: center; z-index: 60; padding: 8vh 16px 16px; }
  .adm { width: 100%; max-width: 560px; background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 20px 22px; max-height: 84vh; overflow: auto; }
  .adm h2 { margin: 0 0 4px; font-size: 16px; font-weight: 600; }
  .adm .sub { color: var(--faint); font-size: 12.5px; margin: 0 0 16px; }
  .adm table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 18px; }
  .adm th { text-align: left; color: var(--faint); font-weight: 500; font-size: 12px; padding: 6px 6px; border-bottom: 1px solid var(--line); }
  .adm td { padding: 8px 6px; border-bottom: 1px solid var(--line-soft); vertical-align: middle; }
  .adm td.act { text-align: right; white-space: nowrap; }
  .adm .tag { font-size: 11px; color: var(--muted); border: 1px solid var(--line); border-radius: 5px; padding: 1px 6px; margin-left: 6px; }
  .adm .off { color: var(--faint); }
  .adm form { display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; align-items: end; }
  .adm label { display: block; color: var(--muted); font-size: 12px; margin: 0 0 4px 2px; }
  .adm input { width: 100%; background: var(--ink); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; outline: none; }
  .adm input:focus { border-color: #33415a; }
  .adm .btn { background: #26344a; border: 0; border-radius: 8px; padding: 8px 12px; cursor: pointer; }
  .adm .btn:hover { background: #2e3f59; }
  .adm .btn:disabled { opacity: .55; cursor: default; }
  .adm .msg { min-height: 18px; font-size: 12.5px; margin: 10px 2px 0; color: var(--muted); }
  .adm .msg.err { color: var(--call); }
  .adm .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
  @media (max-width: 640px) { .adm form { grid-template-columns: 1fr; } .adm { padding: 16px; } }`;
  document.head.appendChild(css);

  async function adminCall(body) {
    const r = await realFetch("/api/admin/usuarios", { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "No se pudo completar");
    return d;
  }

  function askPassword(user) {
    const pw = prompt(`Nueva contraseña para ${user} (mínimo 10 caracteres):`);
    if (pw == null) return null;
    if (pw.length < 10) { alert("La contraseña debe tener al menos 10 caracteres."); return null; }
    if (prompt("Repítela:") !== pw) { alert("No coinciden."); return null; }
    return pw;
  }

  async function openAdmin() {
    const back = document.createElement("div");
    back.className = "adm-back";
    back.innerHTML = `<div class="adm" role="dialog" aria-modal="true" aria-labelledby="admT">
      <div class="top"><div><h2 id="admT">Usuarios</h2><p class="sub">Cada usuario tiene su propia lista y sus preferencias. Las contraseñas no se guardan: solo una huella que no permite recuperarlas.</p></div>
      <button class="linkbtn" id="admClose" aria-label="Cerrar">Cerrar</button></div>
      <div id="admList">Cargando…</div>
      <form id="admForm" autocomplete="off">
        <div><label for="admUser">Nuevo usuario</label><input id="admUser" autocapitalize="none" spellcheck="false" placeholder="nombre" required></div>
        <div><label for="admPw">Contraseña (mín. 10)</label><input id="admPw" type="password" autocomplete="new-password" minlength="10" required></div>
        <button class="btn" id="admGo" type="submit">Crear</button>
      </form>
      <p class="msg" id="admMsg" role="status"></p>
      <h2 style="margin-top:18px">Historial del PC</h2>
      <p class="sub">Sube el archivo <code>historial_para_nube.tar.gz</code> para añadir el historial que guardó el recolector del PC. Se mezcla con el de la nube en el siguiente ciclo del motor (1–2 min); lo que ya existe en la nube no se pierde.</p>
      <form id="impForm" style="grid-template-columns:1fr auto"><input id="impFile" type="file" accept=".gz,.tgz,application/gzip" required><button class="btn" id="impGo" type="submit">Subir</button></form>
      <p class="msg" id="impMsg" role="status"></p></div>`;
    document.body.appendChild(back);
    const close = () => back.remove();
    back.addEventListener("click", (e) => { if (e.target === back) close(); });
    back.querySelector("#admClose").addEventListener("click", close);
    document.addEventListener("keydown", function k(e) { if (e.key === "Escape") { close(); document.removeEventListener("keydown", k); } });
    const msg = (t, err) => { const m = back.querySelector("#admMsg"); m.textContent = t; m.className = "msg" + (err ? " err" : ""); };

    async function refresh() {
      try {
        const d = await adminCall();
        back.querySelector("#admList").innerHTML = `<table><thead><tr><th>Usuario</th><th>Alta</th><th>Sesiones</th><th></th></tr></thead><tbody>${
          d.usuarios.map((u) => `<tr class="${u.inactivo ? "off" : ""}"><td>${esc(u.usuario)}${u.rol === "admin" ? '<span class="tag">admin</span>' : ""}${u.inactivo ? '<span class="tag">desactivado</span>' : ""}</td>
          <td>${esc((u.creado || "").slice(0, 10))}</td><td>${u.sesiones}</td>
          <td class="act"><button class="linkbtn" data-a="contrasena" data-u="${esc(u.usuario)}">Contraseña</button>${u.usuario === ME.user ? "" :
            `<button class="linkbtn" data-a="${u.inactivo ? "activar" : "desactivar"}" data-u="${esc(u.usuario)}">${u.inactivo ? "Activar" : "Desactivar"}</button><button class="linkbtn" data-a="borrar" data-u="${esc(u.usuario)}">Borrar</button>`}</td></tr>`).join("")}</tbody></table>`;
      } catch (e) { msg(e.message, true); }
    }
    back.querySelector("#admList").addEventListener("click", async (e) => {
      const b = e.target.closest("button[data-a]");
      if (!b) return;
      const a = b.dataset.a, u = b.dataset.u;
      try {
        if (a === "contrasena") {
          const pw = askPassword(u); if (!pw) return;
          msg("Guardando…");
          const sal = hex(crypto.getRandomValues(new Uint8Array(16)));
          await adminCall({ accion: a, usuario: u, sal, clave: await derive(pw, sal) });
          msg(u === ME.user ? "Contraseña cambiada. Tus otras sesiones se han cerrado." : `Contraseña de ${u} cambiada; sus sesiones abiertas se han cerrado.`);
        } else {
          if (a === "borrar" && prompt(`Escribe ${u} para borrar la cuenta:`) !== u) return;
          await adminCall({ accion: a, usuario: u });
          msg({ activar: `${u} activado.`, desactivar: `${u} desactivado.`, borrar: `${u} borrado.` }[a]);
        }
        refresh();
      } catch (x) { msg(x.message, true); }
    });
    back.querySelector("#admForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const u = back.querySelector("#admUser").value.trim().toLowerCase(), pw = back.querySelector("#admPw").value;
      if (pw.length < 10) { msg("La contraseña debe tener al menos 10 caracteres.", true); return; }
      const go = back.querySelector("#admGo"); go.disabled = true; msg("Creando…");
      try {
        const sal = hex(crypto.getRandomValues(new Uint8Array(16)));
        await adminCall({ accion: "crear", usuario: u, sal, clave: await derive(pw, sal) });
        back.querySelector("#admForm").reset();
        msg(`Usuario ${u} creado. Pásale su usuario y contraseña en persona.`);
        refresh();
      } catch (x) { msg(x.message, true); } finally { go.disabled = false; }
    });
    back.querySelector("#impForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = back.querySelector("#impFile").files[0], m = back.querySelector("#impMsg"), go = back.querySelector("#impGo");
      if (!f) return;
      go.disabled = true; m.className = "msg"; m.textContent = "Subiendo…";
      try {
        const r = await realFetch("/api/admin/importar", { method: "POST", headers: { "Content-Type": "application/gzip" }, body: f });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || "No se pudo subir");
        m.textContent = `Subido (${(d.bytes / 1e6).toFixed(1)} MB). ${d.lanzado ? "El motor lo mezclará en 1–2 minutos." : "Se mezclará en el próximo ciclo del motor."}`;
      } catch (x) { m.className = "msg err"; m.textContent = x.message; } finally { go.disabled = false; }
    });
    refresh();
    back.querySelector("#admUser").focus();
  }

  window.gexOpenAdmin = openAdmin;
})();
