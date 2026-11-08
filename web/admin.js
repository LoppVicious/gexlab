// GEX Lab - pagina de administracion (/admin): estado del sistema, usuarios, configuracion, acciones y cambios.
// Solo la sirve el Worker al administrador. Las contrasenas se derivan aqui (PBKDF2) y nunca salen del navegador.
"use strict";
(function () {
  const ME = window.GEX_ME || {};
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmtN = (v, d = 0) => v == null || !isFinite(v) ? "—" : Number(v).toLocaleString("es-ES", { minimumFractionDigits: d, maximumFractionDigits: d });
  const bytes = (b) => b == null ? "—" : b >= 1e9 ? `${fmtN(b / 1e9, 2)} GB` : b >= 1e6 ? `${fmtN(b / 1e6, 1)} MB` : `${fmtN(b / 1e3, 0)} KB`;
  const ddmm = (iso) => iso ? iso.slice(8, 10) + "/" + iso.slice(5, 7) : "";
  if (ME.user) $("who").textContent = ME.user;

  async function call(path, body, raw) {
    const r = await fetch(path, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": raw ? "application/gzip" : "application/json" }, body: raw ? body : JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (r.status === 401) { location.href = "/login"; throw new Error("Sesión caducada"); }
    if (!r.ok) throw new Error(d.error || `Error ${r.status}`);
    return d;
  }
  const say = (el, t, err) => { el.textContent = t; el.className = "msg" + (err ? " err" : ""); };

  // ---------------------------------------------------------------- horas de Nueva York
  const NY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  function et(dt) { // {d: "2026-11-08", min: minutos desde medianoche, hm: "09:30"}
    const p = Object.fromEntries(NY.formatToParts(new Date(dt)).map((x) => [x.type, x.value]));
    const h = +p.hour % 24, m = +p.minute;
    return { d: `${p.year}-${p.month}-${p.day}`, min: h * 60 + m, hm: `${String(h).padStart(2, "0")}:${p.minute}` };
  }
  function edad(s) { // "2026-11-08 10:15 ET" -> minutos hasta ahora
    const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})/.exec(s || "");
    if (!m) return null;
    const n = et(Date.now());
    const dias = Math.round((Date.parse(n.d + "T00:00:00Z") - Date.parse(m[1] + "T00:00:00Z")) / 864e5);
    return dias * 1440 + n.min - (+m[2] * 60 + +m[3]);
  }
  const hace = (min) => min == null ? "" : min < 1 ? "ahora" : min < 60 ? `hace ${min} min` : min < 1440 ? `hace ${Math.floor(min / 60)} h ${min % 60 ? `${min % 60} min` : ""}`.trim() : `hace ${Math.floor(min / 1440)} d`;
  const durS = (a, b) => a && b ? Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000)) : null;
  const durTxt = (s) => s == null ? "—" : s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60 ? `${s % 60} s` : ""}`.trim();

  // ---------------------------------------------------------------- estado
  const T0 = 7 * 60, T1 = 21 * 60; // la pista va de 07:00 a 21:00 ET
  const xp = (min) => `${((Math.min(T1, Math.max(T0, min)) - T0) / (T1 - T0) * 100).toFixed(2)}%`;

  function drawDay(e) {
    const runs = (e.ejecuciones && e.ejecuciones.motor) || [];
    const hoy = et(Date.now()).d;
    const dias = [...new Set(runs.map((r) => et(r.inicio).d))].sort();
    const dia = dias.includes(hoy) || !dias.length ? hoy : dias[dias.length - 1];
    const delDia = runs.filter((r) => et(r.inicio).d === dia);
    const esRap = (r) => /rapido/i.test(r.titulo || "");
    const nRap = delDia.filter(esRap).length;
    const wd = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"][new Date(dia + "T12:00:00Z").getUTCDay()];
    $("dayT").textContent = dia === hoy ? "Ciclos del motor hoy" : `Ciclos del motor del ${wd} ${ddmm(dia)}`;
    // arriba el ciclo completo (cada 15 min), abajo el ligero de los indices en tiempo real (cada 5 min)
    const okN = delDia.filter((r) => r.resultado === "success").length, badN = delDia.filter((r) => r.resultado && r.resultado !== "success" && r.resultado !== "cancelled").length;
    $("dayS").textContent = e.ejecuciones.motor == null ? "GitHub no ha devuelto las ejecuciones" :
      `${delDia.length - nRap} completos y ${nRap} de índices · ${okN} terminados${badN ? ` · ${badN} con error` : ""} · hora de Nueva York`;
    const hist = e.historial && e.historial.session === dia;
    let h = `<div class="mkt" style="left:${xp(570)};right:calc(100% - ${xp(960)})" title="Mercado abierto 09:30–16:00 ET"></div>`;
    h += `<div class="hist${hist ? " done" : ""}" style="left:${xp(990)}" title="${hist ? `Historial diario guardado (${esc(e.historial.saved || "")})` : "Historial diario: 16:30 ET"}"></div>`;
    for (const r of delDia) {
      const a = et(r.inicio), b = r.fin ? et(r.fin) : et(Date.now());
      const cls = r.estado !== "completed" ? "live" : r.resultado === "success" ? "" : r.resultado === "cancelled" ? "" : "err";
      const w = Math.max(0, b.min - a.min);
      const tip = `${esRap(r) ? "Índices en tiempo real" : "Ciclo completo"} · ${a.hm} ET · ${r.estado !== "completed" ? "en marcha" : r.resultado === "success" ? "terminado" : r.resultado} · ${durTxt(durS(r.inicio, r.fin))}${r.evento === "workflow_dispatch" ? " · lanzado por la web" : ""}`;
      h += `<a class="run ${cls}${esRap(r) ? " rap" : ""}" href="${esc(r.url)}" target="_blank" rel="noopener" style="left:${xp(a.min)};width:calc(${(w / (T1 - T0) * 100).toFixed(2)}% )" title="${esc(tip)}" aria-label="${esc(tip)}"></a>`;
    }
    if (dia === hoy) { const n = et(Date.now()).min; if (n > T0 && n < T1) h += `<div class="now" style="left:${xp(n)}" title="Ahora (${et(Date.now()).hm} ET)"></div>`; }
    $("track").innerHTML = h;
    $("axis").innerHTML = [7, 9, 11, 13, 15, 17, 19, 21].map((x) => `<span style="left:${xp(x * 60)}">${x}:00</span>`).join("");
  }

  function drawFacts(e) {
    const m = e.motor || {}, hi = e.historial, u = e.uso;
    const em = edad(m.ultimo_ciclo);
    const nerr = (m.errores || []).length;
    // el motor corre cada 15 min de 07:45 a 17:15 ET en dias laborables: mas de 40 min sin ciclo en ese horario es raro
    const n = et(Date.now()), wd = new Date(n.d + "T12:00:00Z").getUTCDay();
    const enHorario = wd >= 1 && wd <= 5 && n.min >= 480 && n.min <= 1035;
    const mState = em == null ? "err" : enHorario && em > 40 ? "err" : nerr ? "warn" : "ok";
    const tick = (m.tickers || []).length;
    const fM = `<div class="kf"><h3><span class="state ${mState}"></span>Motor</h3>
      <div class="big">${esc((m.ultimo_ciclo || "—").slice(11, 16))}<small>${esc(hace(em))}</small></div>
      <dl><dt>Último ciclo</dt><dd>${esc(m.ultimo_ciclo ? ddmm(m.ultimo_ciclo.slice(0, 10)) + " " + m.ultimo_ciclo.slice(11) : "—")}</dd>
      <dt>Duración</dt><dd>${durTxt(m.segundos != null ? Math.round(m.segundos) : null)}</dd>
      <dt>Tickers calculados</dt><dd>${tick}${e.config ? ` de ${e.config.universo + e.config.fijos + 1}` : ""}</dd>
      <dt>Errores</dt><dd>${nerr}</dd>
      <dt>Vistas guardadas</dt><dd>${e.config ? e.config.vistas : "—"}</dd>
      <dt title="Ciclo ligero de SPX, NDX, RUT, SPY, QQQ e IWM cada 5 min con el mercado abierto">Índices en tiempo real</dt><dd>${
        e.rapido ? `${esc(e.rapido.ultimo_ciclo.slice(11, 16))} · ${(e.rapido.tickers || []).length}/6${(e.rapido.errores || []).length ? ` · ${e.rapido.errores.length} err.` : ""}` : "—"}</dd></dl></div>`;
    const hOk = hi ? (hi.ok || []).length : 0, hBad = hi ? (hi.errores || []).length : 0;
    const hState = !hi ? "err" : hBad ? "warn" : "ok";
    const fH = `<div class="kf"><h3><span class="state ${hState}"></span>Historial diario</h3>
      <div class="big">${hi ? ddmm(hi.session) : "—"}<small>${hi ? "última sesión" : "sin datos"}</small></div>
      <dl><dt>Tickers guardados</dt><dd>${hi ? `${hOk} de ${hOk + hBad}` : "—"}</dd>
      <dt>Fallidos</dt><dd title="${esc(hi ? (hi.errores || []).join(", ") : "")}">${hi ? (hBad ? esc((hi.errores || []).slice(0, 4).join(", ") + (hBad > 4 ? "…" : "")) : "ninguno") : "—"}</dd>
      <dt>Tamaño del día</dt><dd>${bytes(hi && hi.bytes)}</dd>
      <dt>Duración</dt><dd>${durTxt(hi && hi.segundos != null ? Math.round(hi.segundos) : null)}</dd>
      <dt>Sesiones guardadas</dt><dd>${fmtN(e.historial_dias)}</dd></dl></div>`;
    const LIM = 10e9; // R2 gratis: 10 GB
    const top = u ? Object.entries(u.por || {}).slice(0, 4) : [];
    const pct = u ? Math.min(100, u.total / LIM * 100) : 0;
    const uState = !u ? "" : pct > 85 ? "err" : pct > 65 ? "warn" : "ok";
    const fU = `<div class="kf"><h3><span class="state ${uState}"></span>Almacenamiento</h3>
      <div class="big">${u ? fmtN(u.total / 1e9, 2) : "—"}<small>GB de 10 gratis</small></div>
      <div class="meter" role="img" aria-label="${fmtN(pct, 0)} % del espacio gratuito"><i style="width:${pct.toFixed(1)}%"></i></div>
      <dl>${top.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${bytes(v.bytes)} · ${fmtN(v.n)}</dd>`).join("") ||
        "<dt>Sin medir</dt><dd>se mide al guardar el historial diario</dd>"}
      ${u ? `<dt>Medido</dt><dd>${esc(u.fecha || "")}</dd>` : ""}</dl></div>`;
    $("facts").innerHTML = fM + fH + fU;
    const us = e.usuarios || {};
    $("usuSum").textContent = `${us.activos || 0} activos de ${us.total || 0} · ${us.conectados || 0} con sesión abierta`;
  }

  function drawErrs(e) {
    const errs = (e.motor && e.motor.errores) || [];
    $("errs").innerHTML = errs.length ? errs.slice().reverse().map((x) => {
      const i = x.indexOf(": ");
      return `<li>${i > 0 ? `<b>${esc(x.slice(0, i))}</b>${esc(x.slice(i + 2))}` : esc(x)}</li>`;
    }).join("") : `<li class="mute">Ninguno: el último ciclo terminó sin errores.</li>`;
  }

  function drawRuns(e) {
    const r = e.ejecuciones || {};
    if (!r.motor && !r.historial) { $("runs").innerHTML = `<tr><td class="mute">GitHub no ha devuelto las ejecuciones. Comprueba que el token GH_DISPATCH_TOKEN tenga permiso de lectura de Actions.</td></tr>`; return; }
    const all = [...(r.motor || []).slice(0, 12).map((x) => ({ ...x, q: /rapido/i.test(x.titulo || "") ? "Índices" : "Motor" })), ...(r.historial || []).slice(0, 4).map((x) => ({ ...x, q: "Historial" }))]
      .sort((a, b) => Date.parse(b.inicio) - Date.parse(a.inicio)).slice(0, 8);
    const res = (x) => x.estado !== "completed" ? `<span class="state warn"></span>En marcha` : x.resultado === "success" ? `<span class="state ok"></span>Terminado`
      : x.resultado === "cancelled" ? `<span class="state"></span>Cancelado` : `<span class="state err"></span>Error`;
    $("runs").innerHTML = all.map((x) => { const a = et(x.inicio); return `<tr><td>${x.q}</td><td>${ddmm(a.d)} ${a.hm}</td><td>${res(x)}</td>
      <td class="r">${durTxt(durS(x.inicio, x.fin))}</td><td class="r"><a href="${esc(x.url)}" target="_blank" rel="noopener">registro</a></td></tr>`; }).join("");
  }

  async function loadEstado() {
    $("estWhen").textContent = "Cargando…";
    try {
      const e = await call("/api/admin/estado");
      drawDay(e); drawFacts(e); drawErrs(e); drawRuns(e);
      $("estWhen").textContent = `Leído a las ${et(Date.now()).hm} ET`;
    } catch (x) { $("estWhen").textContent = x.message; }
  }

  // ---------------------------------------------------------------- usuarios
  const ITER = 310000;
  const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
  async function derive(pw, salHex) {
    const sal = new Uint8Array(salHex.match(/../g).map((h) => parseInt(h, 16)));
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
    return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: sal, iterations: ITER }, key, 256));
  }
  const nuevaSal = () => hex(crypto.getRandomValues(new Uint8Array(16)));
  const umsg = (t, err) => say($("usuMsg"), t, err);

  async function loadUsers() {
    try {
      const d = await call("/api/admin/usuarios");
      $("users").innerHTML = d.usuarios.map((u) => {
        const yo = u.usuario === ME.user;
        return `<tr class="${u.inactivo ? "off" : ""}"><td>${esc(u.usuario)}${u.rol === "admin" ? '<span class="badge adm">admin</span>' : ""}${u.inactivo ? '<span class="badge">desactivado</span>' : ""}</td>
        <td>${esc((u.creado || "").slice(0, 10))}</td><td>${esc(u.ultimo ? u.ultimo.slice(0, 16) : "—")}</td><td class="n">${u.tickers}</td>
        <td class="n">${u.sesiones ? '<span class="on-dot" title="Sesión abierta"></span>' : '<span class="mute">—</span>'}</td>
        <td class="act"><button class="linkbtn" data-a="contrasena" data-u="${esc(u.usuario)}">Contraseña</button>${yo ? "" :
          `<button class="linkbtn" data-a="${u.inactivo ? "activar" : "desactivar"}" data-u="${esc(u.usuario)}">${u.inactivo ? "Activar" : "Desactivar"}</button><button class="linkbtn danger" data-a="borrar" data-u="${esc(u.usuario)}">Borrar</button>`}</td></tr>`;
      }).join("");
    } catch (x) { umsg(x.message, true); }
  }

  function pedirClave(user) {
    return new Promise((resolve) => {
      const dlg = $("pwDlg");
      $("pwT").textContent = `Nueva contraseña para ${user}`;
      $("pw1").value = ""; $("pw2").value = ""; say($("pwMsg"), "");
      const ok = (e) => {
        if ($("pw1").value.length < 10) { e.preventDefault(); say($("pwMsg"), "Mínimo 10 caracteres.", true); return; }
        if ($("pw1").value !== $("pw2").value) { e.preventDefault(); say($("pwMsg"), "No coinciden.", true); return; }
      };
      $("pwOk").addEventListener("click", ok);
      dlg.addEventListener("close", function fin() {
        dlg.removeEventListener("close", fin); $("pwOk").removeEventListener("click", ok);
        resolve(dlg.returnValue === "ok" ? $("pw1").value : null);
      });
      dlg.returnValue = "";
      dlg.showModal(); $("pw1").focus();
    });
  }

  $("users").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-a]");
    if (!b) return;
    const a = b.dataset.a, u = b.dataset.u;
    try {
      if (a === "contrasena") {
        const pw = await pedirClave(u); if (!pw) return;
        umsg("Guardando…");
        const sal = nuevaSal();
        await call("/api/admin/usuarios", { accion: a, usuario: u, sal, clave: await derive(pw, sal) });
        umsg(u === ME.user ? "Contraseña cambiada. Tus otras sesiones se han cerrado." : `Contraseña de ${u} cambiada; sus sesiones abiertas se han cerrado.`);
      } else {
        if (a === "borrar" && prompt(`Se borrará la cuenta de ${u} con su lista y sus preferencias. Escribe ${u} para confirmarlo:`) !== u) return;
        await call("/api/admin/usuarios", { accion: a, usuario: u });
        umsg({ activar: `${u} activado.`, desactivar: `${u} desactivado; sus sesiones se han cerrado.`, borrar: `${u} borrado.` }[a]);
      }
      loadUsers();
    } catch (x) { umsg(x.message, true); }
  });

  $("newUser").addEventListener("submit", async (e) => {
    e.preventDefault();
    const u = $("nuName").value.trim().toLowerCase(), pw = $("nuPw").value;
    if (pw.length < 10) { umsg("La contraseña debe tener al menos 10 caracteres.", true); return; }
    $("nuGo").disabled = true; umsg("Creando…");
    try {
      const sal = nuevaSal();
      await call("/api/admin/usuarios", { accion: "crear", usuario: u, sal, clave: await derive(pw, sal) });
      $("newUser").reset();
      umsg(`Usuario ${u} creado. Pásale su usuario y contraseña en persona.`);
      loadUsers();
    } catch (x) { umsg(x.message, true); } finally { $("nuGo").disabled = false; }
  });

  // ---------------------------------------------------------------- listas editables (historial diario, tickers fijos)
  function normalize(s) {
    s = String(s || "").toUpperCase().trim().replace(/^[_^$]+/, "").replace(/[-/]/g, ".");
    return /^[A-Z][A-Z0-9.]{0,9}$/.test(s) ? s : null;
  }
  function editor({ api, list, cnt, form, input, msg, fijos = [], vacia }) {
    let syms = [];
    const m = (t, err) => say($(msg), t, err);
    const draw = () => {
      $(cnt).textContent = `${syms.length} tickers`;
      $(list).innerHTML = fijos.map((s) => `<span class="tk fixed" title="Siempre incluido">${esc(s)}</span>`).join("") + (syms.length
        ? syms.map((s) => `<span class="tk">${esc(s)}<button type="button" data-s="${esc(s)}" aria-label="Quitar ${esc(s)}" title="Quitar">✕</button></span>`).join("")
        : `<span class="mute">${vacia}</span>`);
    };
    const save = async (nueva, okText) => {
      const d = await call(api, { symbols: nueva });
      syms = d.symbols; draw();
      const bad = (d.invalidos || []).length ? ` Sin opciones o no válidos: ${d.invalidos.join(", ")}.` : "";
      m((typeof okText === "function" ? okText() : okText) + bad, !!bad);
    };
    $(list).addEventListener("click", async (e) => {
      const b = e.target.closest("button[data-s]"); if (!b) return;
      try { await save(syms.filter((x) => x !== b.dataset.s), `${b.dataset.s} quitado.`); } catch (x) { m(x.message, true); }
    });
    $(form).addEventListener("submit", async (e) => {
      e.preventDefault();
      const go = $(form).querySelector("button");
      const nuevos = $(input).value.split(/[\s,;]+/).map(normalize).filter((s) => s && !syms.includes(s) && !fijos.includes(s));
      if (!nuevos.length) { m("Escribe uno o varios tickers que no estén ya en la lista.", true); return; }
      go.disabled = true; m("Guardando…");
      try {
        await save([...syms, ...nuevos], () => { const ok = nuevos.filter((s) => syms.includes(s)); return ok.length ? `Añadido: ${ok.join(", ")}.` : "No se ha añadido ninguno."; });
        $(input).value = "";
      } catch (x) { m(x.message, true); } finally { go.disabled = false; }
    });
    call(api).then((d) => {
      syms = d.symbols || []; draw();
      if (d.origen === "ejecucion") m(`Lista de la última ejecución (${d.actualizado}). Al editarla se guarda aquí.`);
    }).catch((x) => m(x.message, true));
  }
  editor({ api: "/api/admin/historial", list: "hisList", cnt: "hisCnt", form: "hisForm", input: "hisAdd", msg: "hisMsg", vacia: "Sin tickers todavía." });
  editor({ api: "/api/admin/fijos", list: "fijList", cnt: "fijCnt", form: "fijForm", input: "fijAdd", msg: "fijMsg", fijos: ["VIX"],
    vacia: "Ninguno más: solo se calculan los de las listas de los usuarios." });

  // ---------------------------------------------------------------- acciones
  document.querySelectorAll("button[data-lanzar]").forEach((b) => b.addEventListener("click", async () => {
    const m = b.parentElement.querySelector(".msg");
    const que = b.dataset.lanzar;
    b.disabled = true; say(m, "Lanzando…");
    try {
      await call("/api/admin/lanzar", { que, forzar: que === "historial" && $("forzar").checked });
      say(m, que === "ciclo" ? "Lanzado. Aparecerá en la pista de ciclos en unos segundos." : "Lanzado. Si la sesión ya estaba guardada y no marcas «rehacer», terminará sin hacer nada.");
      setTimeout(loadEstado, 8000);
    } catch (x) { say(m, x.message, true); } finally { setTimeout(() => { b.disabled = false; }, 4000); }
  }));

  $("impForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = $("impFile").files[0], go = $("impForm").querySelector("button");
    if (!f) return;
    go.disabled = true; say($("impMsg"), "Subiendo…");
    try {
      const d = await call("/api/admin/importar", f, true);
      say($("impMsg"), `Subido (${(d.bytes / 1e6).toFixed(1)} MB). ${d.lanzado ? "El motor lo mezclará en 1–2 minutos." : "Se mezclará en el próximo ciclo del motor."}`);
    } catch (x) { say($("impMsg"), x.message, true); } finally { go.disabled = false; }
  });

  // ---------------------------------------------------------------- registro de cambios (CHANGELOG.md)
  function md(s) { // solo lo que usa el CHANGELOG: **negrita** y `codigo`
    return esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  }
  async function loadLog() {
    try {
      const r = await fetch("/CHANGELOG.md", { cache: "no-cache" });
      if (!r.ok) throw new Error();
      const entries = [];
      let cur = null, li = null;
      for (const line of (await r.text()).split(/\r?\n/)) {
        let m;
        if ((m = /^## (.+)$/.exec(line))) { cur = { t: m[1], body: [] }; entries.push(cur); li = null; continue; }
        if (!cur) continue;
        if ((m = /^\*\*(.+)\*\*\s*$/.exec(line))) { cur.body.push({ h: m[1] }); li = null; }
        else if ((m = /^- (.+)$/.exec(line))) { li = { li: m[1] }; cur.body.push(li); }
        else if (line.trim() && li) li.li += " " + line.trim();
      }
      if (!entries.length) throw new Error();
      const render = (n) => entries.slice(0, n).map((x) => {
        const [d, ...t] = x.t.split(" — ");
        let h = `<h3><span class="d">${esc(d)}</span>${md(t.join(" — "))}</h3>`, open = false;
        for (const b of x.body) {
          if (b.h) { if (open) h += "</ul>"; h += `<h4>${md(b.h)}</h4><ul>`; open = true; }
          else { if (!open) { h += "<ul>"; open = true; } h += `<li>${md(b.li)}</li>`; }
        }
        return h + (open ? "</ul>" : "");
      }).join("") + (entries.length > n ? `<button class="ab ghost more" id="logMore">Ver los ${entries.length} cambios</button>` : "");
      $("log").innerHTML = render(5);
      $("log").addEventListener("click", (e) => { if (e.target.id === "logMore") $("log").innerHTML = render(entries.length); });
    } catch { $("log").innerHTML = `<p class="mute">El registro de cambios se publica con cada despliegue; aquí no está disponible.</p>`; }
  }

  // ---------------------------------------------------------------- indice: marca la seccion visible
  const links = [...document.querySelectorAll(".an a")];
  const io = new IntersectionObserver((ents) => {
    for (const en of ents) if (en.isIntersecting) links.forEach((a) => a.classList.toggle("on", a.getAttribute("href") === "#" + en.target.id));
  }, { rootMargin: "-30% 0px -60% 0px" });
  document.querySelectorAll(".am section").forEach((s) => io.observe(s));

  $("reload").addEventListener("click", () => { loadEstado(); loadUsers(); });
  loadEstado(); loadUsers(); loadLog();
  setInterval(() => { if (!document.hidden) loadEstado(); }, 60000);
})();
