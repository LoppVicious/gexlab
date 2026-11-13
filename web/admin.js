// GEX Lab - pagina de administracion (/admin): estado del sistema, usuarios, configuracion, acciones y cambios.
// Solo la sirve el Worker al administrador. Las contrasenas se derivan aqui (PBKDF2) y nunca salen del navegador.
"use strict";
(function () {
  const ME = window.GEX_ME || {};
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmtN = (v, d = 0) => v == null || !isFinite(v) ? "—" : Number(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  const bytes = (b) => b == null ? "—" : b >= 1e9 ? `${fmtN(b / 1e9, 2)} GB` : b >= 1e6 ? `${fmtN(b / 1e6, 1)} MB` : `${fmtN(b / 1e3, 0)} KB`;
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const ddmm = (iso) => iso ? `${MON[+iso.slice(5, 7) - 1]} ${+iso.slice(8, 10)}` : "";
  if (ME.user) $("who").textContent = ME.user;

  async function call(path, body, raw) {
    const r = await fetch(path, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": raw ? "application/gzip" : "application/json" }, body: raw ? body : JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (r.status === 401) { location.href = "/login"; throw new Error("Session expired"); }
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
  const hace = (min) => min == null ? "" : min < 1 ? "now" : min < 60 ? `${min} min ago` : min < 1440 ? `${Math.floor(min / 60)} h ${min % 60 ? `${min % 60} min ` : ""}ago` : `${Math.floor(min / 1440)} d ago`;
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
    const wd = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date(dia + "T12:00:00Z").getUTCDay()];
    $("dayT").textContent = dia === hoy ? "Engine cycles today" : `Engine cycles on ${wd}, ${ddmm(dia)}`;
    // arriba el ciclo completo (cada 15 min), abajo el ligero de los indices en tiempo real (cada 5 min)
    const okN = delDia.filter((r) => r.resultado === "success").length, badN = delDia.filter((r) => r.resultado && r.resultado !== "success" && r.resultado !== "cancelled").length;
    $("dayS").textContent = e.ejecuciones.motor == null ? "GitHub did not return the runs" :
      `${delDia.length - nRap} full and ${nRap} index runs, ${okN} finished${badN ? `, ${badN} failed` : ""} (New York time)`;
    const hist = e.historial && e.historial.session === dia;
    let h = `<div class="mkt" style="left:${xp(570)};right:calc(100% - ${xp(960)})" title="Market open 09:30–16:00 ET"></div>`;
    h += `<div class="hist${hist ? " done" : ""}" style="left:${xp(990)}" title="${hist ? `Daily history saved (${esc(e.historial.saved || "")})` : "Daily history: 16:30 ET"}"></div>`;
    for (const r of delDia) {
      const a = et(r.inicio), b = r.fin ? et(r.fin) : et(Date.now());
      const cls = r.estado !== "completed" ? "live" : r.resultado === "success" ? "" : r.resultado === "cancelled" ? "" : "err";
      const w = Math.max(0, b.min - a.min);
      const tip = `${esRap(r) ? "Real-time indices" : "Full cycle"}, ${a.hm} ET, ${r.estado !== "completed" ? "running" : r.resultado === "success" ? "finished" : r.resultado}, ${durTxt(durS(r.inicio, r.fin))}${r.evento === "workflow_dispatch" ? ", launched from the web" : ""}`;
      h += `<a class="run ${cls}${esRap(r) ? " rap" : ""}" href="${esc(r.url)}" target="_blank" rel="noopener" style="left:${xp(a.min)};width:calc(${(w / (T1 - T0) * 100).toFixed(2)}% )" title="${esc(tip)}" aria-label="${esc(tip)}"></a>`;
    }
    if (dia === hoy) { const n = et(Date.now()).min; if (n > T0 && n < T1) h += `<div class="now" style="left:${xp(n)}" title="Now (${et(Date.now()).hm} ET)"></div>`; }
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
      <dl><dt>Last cycle</dt><dd>${esc(m.ultimo_ciclo ? ddmm(m.ultimo_ciclo.slice(0, 10)) + " " + m.ultimo_ciclo.slice(11) : "—")}</dd>
      <dt>Duration</dt><dd>${durTxt(m.segundos != null ? Math.round(m.segundos) : null)}</dd>
      <dt>Tickers calculated</dt><dd>${tick}${e.config ? ` of ${e.config.universo + e.config.fijos + 1}` : ""}</dd>
      <dt>Errors</dt><dd>${nerr}</dd>
      <dt>Saved views</dt><dd>${e.config ? e.config.vistas : "—"}</dd>
      <dt title="Light cycle for SPX, NDX, RUT, SPY, QQQ and IWM every 5 min while the market is open">Real-time indices</dt><dd>${
        e.rapido ? `${esc(e.rapido.ultimo_ciclo.slice(11, 16))}, ${(e.rapido.tickers || []).length}/6${(e.rapido.errores || []).length ? `, ${e.rapido.errores.length} err.` : ""}` : "—"}</dd></dl></div>`;
    const hOk = hi ? (hi.ok || []).length : 0, hBad = hi ? (hi.errores || []).length : 0;
    const hState = !hi ? "err" : hBad ? "warn" : "ok";
    const fH = `<div class="kf"><h3><span class="state ${hState}"></span>Daily history</h3>
      <div class="big">${hi ? ddmm(hi.session) : "—"}<small>${hi ? "last session" : "no data"}</small></div>
      <dl><dt>Tickers saved</dt><dd>${hi ? `${hOk} of ${hOk + hBad}` : "—"}</dd>
      <dt>Failed</dt><dd title="${esc(hi ? (hi.errores || []).join(", ") : "")}">${hi ? (hBad ? esc((hi.errores || []).slice(0, 4).join(", ") + (hBad > 4 ? "…" : "")) : "none") : "—"}</dd>
      <dt>Size of the day</dt><dd>${bytes(hi && hi.bytes)}</dd>
      <dt>Duration</dt><dd>${durTxt(hi && hi.segundos != null ? Math.round(hi.segundos) : null)}</dd>
      <dt>Saved sessions</dt><dd>${fmtN(e.historial_dias)}</dd></dl></div>`;
    const LIM = 10e9; // R2 gratis: 10 GB
    const top = u ? Object.entries(u.por || {}).slice(0, 4) : [];
    const pct = u ? Math.min(100, u.total / LIM * 100) : 0;
    const uState = !u ? "" : pct > 85 ? "err" : pct > 65 ? "warn" : "ok";
    const fU = `<div class="kf"><h3><span class="state ${uState}"></span>Storage</h3>
      <div class="big">${u ? fmtN(u.total / 1e9, 2) : "—"}<small>GB of 10 free</small></div>
      <div class="meter" role="img" aria-label="${fmtN(pct, 0)}% of the free space"><i style="width:${pct.toFixed(1)}%"></i></div>
      <dl>${top.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${bytes(v.bytes)} in ${fmtN(v.n)} files</dd>`).join("") ||
        "<dt>Not measured</dt><dd>measured when the daily history is saved</dd>"}
      ${u ? `<dt>Measured</dt><dd>${esc(u.fecha || "")}</dd>` : ""}</dl></div>`;
    $("facts").innerHTML = fM + fH + fU;
    const us = e.usuarios || {};
    $("usuSum").textContent = `${us.activos || 0} active of ${us.total || 0}, ${us.conectados || 0} signed in`;
  }

  function drawErrs(e) {
    const errs = (e.motor && e.motor.errores) || [];
    $("errs").innerHTML = errs.length ? errs.slice().reverse().map((x) => {
      const i = x.indexOf(": ");
      return `<li>${i > 0 ? `<b>${esc(x.slice(0, i))}</b>${esc(x.slice(i + 2))}` : esc(x)}</li>`;
    }).join("") : `<li class="mute">None: the last cycle finished without errors.</li>`;
  }

  function drawRuns(e) {
    const r = e.ejecuciones || {};
    if (!r.motor && !r.historial) { $("runs").innerHTML = `<tr><td class="mute">GitHub did not return the runs. Check that the GH_DISPATCH_TOKEN token has read access to Actions.</td></tr>`; return; }
    const all = [...(r.motor || []).slice(0, 12).map((x) => ({ ...x, q: /rapido/i.test(x.titulo || "") ? "Indices" : "Engine" })), ...(r.historial || []).slice(0, 4).map((x) => ({ ...x, q: "History" }))]
      .sort((a, b) => Date.parse(b.inicio) - Date.parse(a.inicio)).slice(0, 8);
    const res = (x) => x.estado !== "completed" ? `<span class="state warn"></span>Running` : x.resultado === "success" ? `<span class="state ok"></span>Finished`
      : x.resultado === "cancelled" ? `<span class="state"></span>Cancelled` : `<span class="state err"></span>Error`;
    $("runs").innerHTML = all.map((x) => { const a = et(x.inicio); return `<tr><td>${x.q}</td><td>${ddmm(a.d)} ${a.hm}</td><td>${res(x)}</td>
      <td class="r">${durTxt(durS(x.inicio, x.fin))}</td><td class="r"><a href="${esc(x.url)}" target="_blank" rel="noopener">log</a></td></tr>`; }).join("");
  }

  async function loadEstado() {
    $("estWhen").textContent = "Loading…";
    try {
      const e = await call("/api/admin/estado");
      drawDay(e); drawFacts(e); drawErrs(e); drawRuns(e);
      $("estWhen").textContent = `Read at ${et(Date.now()).hm} ET`;
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
        return `<tr class="${u.inactivo ? "off" : ""}"><td>${esc(u.usuario)}${u.rol === "admin" ? '<span class="badge adm">admin</span>' : ""}${u.autor && u.rol !== "admin" ? '<span class="badge">drafts</span>' : ""}${u.inactivo ? '<span class="badge">disabled</span>' : ""}</td>
        <td>${esc((u.creado || "").slice(0, 10))}</td><td>${esc(u.ultimo ? u.ultimo.slice(0, 16) : "—")}</td><td class="n">${u.tickers}</td>
        <td class="n">${u.sesiones ? '<span class="on-dot" title="Signed in"></span>' : '<span class="mute">—</span>'}</td>
        <td class="act"><button class="linkbtn" data-a="contrasena" data-u="${esc(u.usuario)}">Password</button>${yo ? "" :
          `${u.rol === "admin" ? "" : `<button class="linkbtn" data-a="${u.autor ? "noautor" : "autor"}" data-u="${esc(u.usuario)}" title="Founder Takes: can create and edit their own drafts">${u.autor ? "Revoke drafts" : "Allow drafts"}</button>`}<button class="linkbtn" data-a="${u.inactivo ? "activar" : "desactivar"}" data-u="${esc(u.usuario)}">${u.inactivo ? "Enable" : "Disable"}</button><button class="linkbtn danger" data-a="borrar" data-u="${esc(u.usuario)}">Delete</button>`}</td></tr>`;
      }).join("");
    } catch (x) { umsg(x.message, true); }
  }

  function pedirClave(user) {
    return new Promise((resolve) => {
      const dlg = $("pwDlg");
      $("pwT").textContent = `New password for ${user}`;
      $("pw1").value = ""; $("pw2").value = ""; say($("pwMsg"), "");
      const ok = (e) => {
        if ($("pw1").value.length < 10) { e.preventDefault(); say($("pwMsg"), "At least 10 characters.", true); return; }
        if ($("pw1").value !== $("pw2").value) { e.preventDefault(); say($("pwMsg"), "They don't match.", true); return; }
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
        umsg("Saving…");
        const sal = nuevaSal();
        await call("/api/admin/usuarios", { accion: a, usuario: u, sal, clave: await derive(pw, sal) });
        umsg(u === ME.user ? "Password changed. Your other sessions have been closed." : `${u}'s password changed; their open sessions have been closed.`);
      } else {
        if (a === "borrar" && prompt(`The account ${u} will be deleted along with its list and preferences. Type ${u} to confirm:`) !== u) return;
        await call("/api/admin/usuarios", { accion: a, usuario: u });
        umsg({ activar: `${u} enabled.`, desactivar: `${u} disabled; their sessions have been closed.`, borrar: `${u} deleted.`,
          autor: `${u} can now write Founder Takes drafts.`, noautor: `${u} can no longer write Founder Takes drafts.` }[a]);
      }
      loadUsers();
    } catch (x) { umsg(x.message, true); }
  });

  $("newUser").addEventListener("submit", async (e) => {
    e.preventDefault();
    const u = $("nuName").value.trim().toLowerCase(), pw = $("nuPw").value;
    if (pw.length < 10) { umsg("The password must be at least 10 characters long.", true); return; }
    $("nuGo").disabled = true; umsg("Creating…");
    try {
      const sal = nuevaSal();
      await call("/api/admin/usuarios", { accion: "crear", usuario: u, sal, clave: await derive(pw, sal) });
      $("newUser").reset();
      umsg(`User ${u} created. Give them their username and password in person.`);
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
      $(list).innerHTML = fijos.map((s) => `<span class="tk fixed" title="Always included">${esc(s)}</span>`).join("") + (syms.length
        ? syms.map((s) => `<span class="tk">${esc(s)}<button type="button" data-s="${esc(s)}" aria-label="Remove ${esc(s)}" title="Remove">✕</button></span>`).join("")
        : `<span class="mute">${vacia}</span>`);
    };
    const save = async (nueva, okText) => {
      const d = await call(api, { symbols: nueva });
      syms = d.symbols; draw();
      const bad = (d.invalidos || []).length ? ` No options or invalid: ${d.invalidos.join(", ")}.` : "";
      m((typeof okText === "function" ? okText() : okText) + bad, !!bad);
    };
    $(list).addEventListener("click", async (e) => {
      const b = e.target.closest("button[data-s]"); if (!b) return;
      try { await save(syms.filter((x) => x !== b.dataset.s), `${b.dataset.s} removed.`); } catch (x) { m(x.message, true); }
    });
    $(form).addEventListener("submit", async (e) => {
      e.preventDefault();
      const go = $(form).querySelector("button");
      const nuevos = $(input).value.split(/[\s,;]+/).map(normalize).filter((s) => s && !syms.includes(s) && !fijos.includes(s));
      if (!nuevos.length) { m("Type one or more tickers that aren't in the list yet.", true); return; }
      go.disabled = true; m("Saving…");
      try {
        await save([...syms, ...nuevos], () => { const ok = nuevos.filter((s) => syms.includes(s)); return ok.length ? `Added: ${ok.join(", ")}.` : "None added."; });
        $(input).value = "";
      } catch (x) { m(x.message, true); } finally { go.disabled = false; }
    });
    call(api).then((d) => {
      syms = d.symbols || []; draw();
      if (d.origen === "ejecucion") m(`List from the last run (${d.actualizado}). Editing it saves it here.`);
    }).catch((x) => m(x.message, true));
  }
  editor({ api: "/api/admin/historial", list: "hisList", cnt: "hisCnt", form: "hisForm", input: "hisAdd", msg: "hisMsg", vacia: "No tickers yet." });
  editor({ api: "/api/admin/fijos", list: "fijList", cnt: "fijCnt", form: "fijForm", input: "fijAdd", msg: "fijMsg", fijos: ["VIX"],
    vacia: "None else: only the tickers in the users' lists are calculated." });

  // ---------------------------------------------------------------- acciones
  document.querySelectorAll("button[data-lanzar]").forEach((b) => b.addEventListener("click", async () => {
    const m = b.parentElement.querySelector(".msg");
    const que = b.dataset.lanzar;
    b.disabled = true; say(m, "Launching…");
    try {
      await call("/api/admin/lanzar", { que, forzar: que === "historial" && $("forzar").checked });
      say(m, que === "ciclo" ? "Launched. It will show up in the cycle track in a few seconds." : "Launched. If the session was already saved and you don't tick “redo”, it will finish without doing anything.");
      setTimeout(loadEstado, 8000);
    } catch (x) { say(m, x.message, true); } finally { setTimeout(() => { b.disabled = false; }, 4000); }
  }));

  $("impForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = $("impFile").files[0], go = $("impForm").querySelector("button");
    if (!f) return;
    go.disabled = true; say($("impMsg"), "Uploading…");
    try {
      const d = await call("/api/admin/importar", f, true);
      say($("impMsg"), `Uploaded (${(d.bytes / 1e6).toFixed(1)} MB). ${d.lanzado ? "The engine will merge it in 1–2 minutes." : "It will be merged in the next engine cycle."}`);
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
      }).join("") + (entries.length > n ? `<button class="ab ghost more" id="logMore">See all ${entries.length} changes</button>` : "");
      $("log").innerHTML = render(5);
      $("log").addEventListener("click", (e) => { if (e.target.id === "logMore") $("log").innerHTML = render(entries.length); });
    } catch { $("log").innerHTML = `<p class="mute">The changelog is published with each deployment; it isn't available here.</p>`; }
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
