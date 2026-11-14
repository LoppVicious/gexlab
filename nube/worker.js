// GEX Lab en Cloudflare Workers: web privada + API + reloj del motor.
// Enlaces (wrangler.toml): DB (D1), R2 (bucket gexlab), ASSETS (archivos de la web).
// Secretos: GEX_SETUP_CODE (alta del administrador), GH_DISPATCH_TOKEN (lanzar el motor en GitHub).
//
// Contrasenas: el navegador aplica PBKDF2-SHA256 (310.000 iteraciones, sal por usuario) y envia el resultado;
// aqui solo se guarda y se compara su SHA-256. La contrasena nunca sale del navegador y el servidor no gasta CPU.

import { takes } from "./takes.js";   // Founder Takes (wrangler lo empaqueta)
import { report } from "./report.js";   // report semanal: rutas con token propio, sin sesion

const ITER = 310000;
const SESSION_DAYS = 30;
const MAX_FAILS = 5;
const LOCK_S = 15 * 60;
const COOKIE = "gex_session";
const USER_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const DEFAULT_WATCH = ["SPX", "NDX", "RUT", "SPY", "QQQ", "IWM", "AAPL", "MSFT", "NVDA", "AMZN", "META", "TSLA"];
const MAX_WATCH = 40;
const REPO = "LoppVicious/gexlab";
const PUBLIC = new Set(["/login", "/login.html", "/setup", "/setup.html", "/favicon.ico", "/favicon.svg", "/favicon-32.png", "/apple-touch-icon.png", "/api/sal", "/api/login", "/api/setup", "/api/setup/estado"]);
const POPULAR = new Set(`SPX NDX RUT VIX XSP SPY QQQ IWM DIA TLT GLD SLV USO HYG XLF XLE XLK SMH SOXL TQQQ ARKK
AAPL MSFT NVDA AMZN GOOGL GOOG META TSLA AVGO AMD NFLX ORCL CRM ADBE INTC MU QCOM TSM ASML PLTR
COIN MSTR HOOD SHOP UBER ABNB SNOW PYPL SQ BA DIS JPM BAC GS MS WFC C V MA BRK.B XOM CVX
UNH LLY JNJ PFE MRK ABBV NVO WMT COST HD NKE KO PEP MCD SBUX F GM RIVN LCID SMCI ARM DELL
BABA PDD NIO GME AMC CVNA`.split(/\s+/));

// ------------------------------------------------------------------ utilidades
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
const randHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const nowS = () => Math.floor(Date.now() / 1000);
const stamp = () => new Date().toISOString().slice(0, 16).replace("T", " ");

function eq(a, b) { // comparacion en tiempo constante
  a = String(a); b = String(b);
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}

const SEC_HEADERS = {
  "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000", "X-Robots-Tag": "noindex, nofollow",
};

function json(code, obj, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status: code, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...SEC_HEADERS, ...extra },
  });
}

function redirect(to) {
  return new Response(null, { status: 302, headers: { Location: to, ...SEC_HEADERS } });
}

function cookieToken(req) {
  const m = (req.headers.get("Cookie") || "").match(/(?:^|;\s*)gex_session=([A-Za-z0-9_-]{20,})/);
  return m ? m[1] : null;
}

function normalize(s) {
  s = String(s || "").toUpperCase().trim().replace(/^[_^$]+/, "").replace(/[-/]/g, ".");
  return /^[A-Z][A-Z0-9.]{0,9}$/.test(s) ? s : null;
}

const ip = (req) => req.headers.get("CF-Connecting-IP") || "?";

async function body(req) {
  const ct = req.headers.get("Content-Type") || "";
  if (!ct.includes("application/json")) throw new Error("Invalid request");
  const t = await req.text();
  if (t.length > 100000) throw new Error("Request too large");
  return t ? JSON.parse(t) : {};
}

// ------------------------------------------------------------------ sesiones y bloqueos
async function sessionOf(req, env) {
  const tok = cookieToken(req);
  if (!tok) return null;
  const h = await sha256(tok);
  const r = await env.DB.prepare(
    "SELECT u.usuario, u.rol, u.lid FROM sesiones s JOIN usuarios u ON u.usuario = s.usuario WHERE s.h = ? AND s.exp > ? AND u.inactivo = 0",
  ).bind(h, nowS()).first();
  if (r) return { user: r.usuario, admin: r.rol === "admin", lid: r.lid, h };
  const c = await env.DB.prepare("SELECT motivo FROM sesiones_cerradas WHERE h = ?").bind(h).first();
  return c ? { closed: c.motivo } : null;
}

async function blocked(env, key) {
  const r = await env.DB.prepare("SELECT n, hasta FROM fallos WHERE clave = ?").bind(key).first();
  return r && r.hasta > nowS() ? r.hasta - nowS() : 0;
}

async function fail(env, key) {
  const r = await env.DB.prepare("SELECT n, hasta FROM fallos WHERE clave = ?").bind(key).first();
  let n = r ? r.n : 0;
  if (r && r.hasta && r.hasta <= nowS() && n >= MAX_FAILS) n = 0;
  n += 1;
  const hasta = n >= MAX_FAILS ? nowS() + LOCK_S : 0;
  await env.DB.prepare("INSERT INTO fallos (clave, n, hasta) VALUES (?, ?, ?) ON CONFLICT(clave) DO UPDATE SET n = excluded.n, hasta = excluded.hasta")
    .bind(key, n, hasta).run();
}

async function newSession(env, user, req) {
  // un solo dispositivo por cuenta: el nuevo inicio de sesion cierra los anteriores
  await env.DB.prepare("INSERT OR REPLACE INTO sesiones_cerradas (h, motivo, t) SELECT h, 'otro', ? FROM sesiones WHERE usuario = ?").bind(nowS(), user).run();
  await env.DB.prepare("DELETE FROM sesiones WHERE usuario = ?").bind(user).run();
  await env.DB.prepare("DELETE FROM sesiones_cerradas WHERE t < ?").bind(nowS() - 30 * 86400).run();
  const tok = randHex(32);
  await env.DB.prepare("INSERT INTO sesiones (h, usuario, exp, creada, ip) VALUES (?, ?, ?, ?, ?)")
    .bind(await sha256(tok), user, nowS() + SESSION_DAYS * 86400, stamp(), ip(req)).run();
  await env.DB.prepare("DELETE FROM sesiones WHERE exp < ?").bind(nowS()).run();
  return `${COOKIE}=${tok}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

// ------------------------------------------------------------------ configuracion del motor (R2 config/config.json)
async function readConfig(env) {
  const o = await env.R2.get("config/config.json");
  if (!o) return {};
  try { return JSON.parse(await o.text()); } catch { return {}; }
}

async function syncConfig(env) {
  const rows = (await env.DB.prepare(
    "SELECT u.lid, l.json AS lista, p.json AS prefs FROM usuarios u LEFT JOIN listas l ON l.usuario = u.usuario LEFT JOIN prefs p ON p.usuario = u.usuario WHERE u.inactivo = 0",
  ).all()).results || [];
  const listas = {};
  const vistas = [];
  const seen = new Set();
  for (const r of rows) {
    let syms = DEFAULT_WATCH;
    try { const d = JSON.parse(r.lista || "null"); if (d && Array.isArray(d.symbols)) syms = d.symbols; } catch { /* lista por defecto */ }
    listas[r.lid] = syms;
    let p = {};
    try { p = JSON.parse(r.prefs || "{}"); } catch { /* sin preferencias */ }
    const v = { dte: p.dte || "45", range: p.range || "auto", pos: p.pos || "standard", combo: p.combo || "0", sess: "auto",
      model: p.model === "gexbot" || (p.model !== "spotgamma" && (p.dte || "45") === "0") ? "gexbot" : "spotgamma" };
    const k = JSON.stringify(v);
    if (!seen.has(k)) { seen.add(k); vistas.push(v); }
  }
  const old = await readConfig(env);
  const cfg = { listas, vistas, actualizado: stamp() };
  await env.R2.put("config/config.json", JSON.stringify(cfg), { httpMetadata: { contentType: "application/json" } });
  const oldU = new Set(Object.values(old.listas || {}).flat());
  const nuevos = [...new Set(Object.values(listas).flat())].filter((s) => !oldU.has(s));
  return nuevos;
}

// ------------------------------------------------------------------ motor (GitHub Actions)
async function dispatch(env, inputs, workflow = "motor.yml") {
  if (!env.GH_DISPATCH_TOKEN) return false;
  const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`, Accept: "application/vnd.github+json",
      "User-Agent": "gexlab", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: "main", inputs }),
  });
  return r.status === 204;
}

// Tickers que no estan en el directorio de CBOE (los que tienen opciones): el motor nunca los calcula, ni puntuales
// ni en las listas; una errata (APPL) lo haria fallar en cada refresco. Si el directorio no se pudo descargar
// (solo trae los indices), no se filtra
async function desconocidosDe(env, syms) {
  const dir = await symbols(env);
  if (dir.length <= 100) return [];
  const conocidos = new Set(dir.map(([s]) => s));
  return syms.filter((s) => !conocidos.has(s));
}

async function pedir(env, syms) {
  // calculo puntual de tickers sin paquete; como mucho un lanzamiento cada 4 min por ticker
  const desconocidos = await desconocidosDe(env, syms);
  syms = syms.filter((s) => !desconocidos.includes(s));
  const fresh = [];
  for (const s of syms.slice(0, 10)) {
    const r = await env.DB.prepare("SELECT t FROM pedidos WHERE simbolo = ?").bind(s).first();
    if (r && nowS() - r.t < 240) continue;
    fresh.push(s);
    await env.DB.prepare("INSERT INTO pedidos (simbolo, t) VALUES (?, ?) ON CONFLICT(simbolo) DO UPDATE SET t = excluded.t").bind(s, nowS()).run();
  }
  const ok = fresh.length ? await dispatch(env, { modo: "ticker", tickers: fresh.join(" ") }) : true;
  return { ok, symbols: syms.slice(0, 10), lanzados: fresh, desconocidos };
}

// ------------------------------------------------------------------ datos publicados por el motor (R2 pub/)
async function fromR2(req, env, key) {
  const o = await env.R2.get(key, { onlyIf: req.headers });
  if (o === null) return json(404, { error: "No data for this yet", pendiente: true });
  const h = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-cache", ETag: o.httpEtag, ...SEC_HEADERS });
  if (!("body" in o) || !o.body) return new Response(null, { status: 304, headers: h });
  if (o.httpMetadata && o.httpMetadata.contentEncoding === "gzip") h.set("Content-Encoding", "gzip");
  if (o.uploaded) h.set("X-Edad", String(Math.max(0, Math.round((Date.now() - o.uploaded.getTime()) / 1000))));
  return new Response(o.body, { headers: h, encodeBody: "manual" });
}

// ------------------------------------------------------------------ lista del historial diario (historial500.py)
// La edita el administrador en la web; el trabajo diario la lee de R2. Mientras nadie la haya editado, se muestra
// la de la ultima ejecucion (hist500/_dias/), que es la del codigo.
const HIST_KEY = "config/historial500.json";
const MAX_HIST = 600;  // ~560 (S&P 500 + lista propia) caben en los 10 GB gratis de R2 con 2 años de retención

async function r2json(env, key) {
  const o = await env.R2.get(key);
  if (!o) return null;
  let b = new Uint8Array(await o.arrayBuffer());
  if (b[0] === 0x1f && b[1] === 0x8b) b = new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  try { return JSON.parse(new TextDecoder().decode(b)); } catch { return null; }
}

async function histLista(env) {
  const d = await r2json(env, HIST_KEY);
  if (d && Array.isArray(d.symbols)) return { symbols: d.symbols, actualizado: d.actualizado || null, origen: "web" };
  const keys = ((await env.R2.list({ prefix: "hist500/_dias/" })).objects || []).map((x) => x.key).sort();
  const u = keys.length ? await r2json(env, keys[keys.length - 1]) : null;
  if (u) return { symbols: [...(u.ok || []), ...(u.errores || [])], actualizado: u.session || null, origen: "ejecucion" };
  return { symbols: [], actualizado: null, origen: "vacia" };
}

const FIJOS_KEY = "config/fijos.json";
const MAX_FIJOS = 60;

async function fijosLista(env) {
  const d = await r2json(env, FIJOS_KEY);
  return { symbols: d && Array.isArray(d.symbols) ? d.symbols : [], actualizado: (d && d.actualizado) || null, origen: "web" };
}

async function historial(req, env, me) {
  return editarLista(req, env, me, HIST_KEY, MAX_HIST, histLista);
}

async function fijos(req, env, me) {
  return editarLista(req, env, me, FIJOS_KEY, MAX_FIJOS, fijosLista);
}

async function editarLista(req, env, me, KEY, MAX, leer) {
  if (req.method === "GET") return json(200, await leer(env));
  const b = await body(req);
  const actual = new Set((await leer(env)).symbols);
  const conOpciones = new Set((await symbols(env)).map((x) => x[0]));
  const syms = [], invalidos = [];
  for (const x of b.symbols || []) {
    const s = normalize(x);
    if (!s) { invalidos.push(String(x).slice(0, 12)); continue; }
    if (syms.includes(s)) continue;
    // los nuevos tienen que tener opciones en CBOE (evita erratas); los que ya estaban se respetan
    if (!actual.has(s) && conOpciones.size && !conOpciones.has(s)) { invalidos.push(s); continue; }
    syms.push(s);
  }
  if (syms.length > MAX) throw new Error(`At most ${MAX} tickers`);
  const d = { symbols: syms, actualizado: stamp(), por: me.user };
  await env.R2.put(KEY, JSON.stringify(d), { httpMetadata: { contentType: "application/json" } });
  return json(200, { symbols: syms, actualizado: d.actualizado, origen: "web", invalidos });
}

// ------------------------------------------------------------------ panel de administracion: estado del sistema
async function ejecuciones(env, workflow, n) {
  if (!env.GH_DISPATCH_TOKEN) return null;
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${workflow}/runs?per_page=${n}`, {
      headers: { Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "gexlab", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!r.ok) return null;
    const d = await r.json();
    return (d.workflow_runs || []).map((x) => ({
      id: x.id, estado: x.status, resultado: x.conclusion, evento: x.event, titulo: x.display_title || x.name || "",
      inicio: x.run_started_at || x.created_at, fin: x.status === "completed" ? x.updated_at : null, url: x.html_url,
    }));
  } catch { return null; }
}

async function estado(env) {
  const dias = ((await env.R2.list({ prefix: "hist500/_dias/" })).objects || []).map((x) => x.key).sort();
  const [motor, recolector, uso, hist, runsMotor, runsHist, fij, hl] = await Promise.all([
    r2json(env, "pub/motor.json"), r2json(env, "pub/recolector.json"), r2json(env, "estado/uso.json"),
    dias.length ? r2json(env, dias[dias.length - 1]) : null,
    ejecuciones(env, "motor.yml", 100), ejecuciones(env, "historial500.yml", 10), fijosLista(env), histLista(env),
  ]);
  const rapido = await r2json(env, "pub/rapido.json");
  const cfg = await readConfig(env);
  const u = await env.DB.prepare(
    "SELECT COUNT(*) AS n, SUM(CASE WHEN inactivo = 0 THEN 1 ELSE 0 END) AS activos FROM usuarios").first();
  const s = await env.DB.prepare("SELECT COUNT(DISTINCT usuario) AS n FROM sesiones WHERE exp > ?").bind(nowS()).first();
  return {
    ahora: new Date().toISOString(),
    motor, rapido, recolector: recolector && { ultima_recogida: recolector.ultima_recogida, cierre: recolector.cierre },
    historial: hist, historial_dias: dias.length, uso,
    ejecuciones: { motor: runsMotor, historial: runsHist },
    config: {
      universo: [...new Set(Object.values(cfg.listas || {}).flat())].length, listas: Object.keys(cfg.listas || {}).length,
      vistas: (cfg.vistas || []).length, fijos: fij.symbols.length, historial: hl.symbols.length,
    },
    usuarios: { total: (u && u.n) || 0, activos: (u && u.activos) || 0, conectados: (s && s.n) || 0 },
  };
}

const SAFE_PATH = /^[A-Za-z0-9_][A-Za-z0-9_.\-/]{0,200}$/;

// ------------------------------------------------------------------ buscador
let _syms = null, _symsT = 0;
async function symbols(env) {
  if (_syms && Date.now() - _symsT < 3600e3) return _syms;
  const o = await env.R2.get("pub/simbolos.json");
  if (!o) return [];
  const ds = new DecompressionStream("gzip");
  const txt = await new Response(o.body.pipeThrough(ds)).text();
  _syms = JSON.parse(txt); _symsT = Date.now();
  return _syms;
}

async function search(env, q) {
  q = String(q || "").trim().toUpperCase();
  if (!q) return [];
  const exact = [], prefix = [], names = [];
  for (const [s, n] of await symbols(env)) {
    const N = String(n).toUpperCase();
    if (s === q) exact.push([s, n]);
    else if (s.startsWith(q)) prefix.push([s, n]);
    else if ((q.length >= 2 && N.split(/\s+/).some((w) => w.startsWith(q))) || (q.length >= 4 && N.includes(q))) names.push([s, n]);
  }
  const rk = (s) => [POPULAR.has(s) ? 0 : 1, s.length, s];
  const cmp = (a, b) => { for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1; } return 0; };
  prefix.sort((a, b) => cmp(rk(a[0]), rk(b[0])));
  names.sort((a, b) => cmp([String(a[1]).toUpperCase().startsWith(q) ? 0 : 1, POPULAR.has(a[0]) ? 0 : 1, a[0].length],
    [String(b[1]).toUpperCase().startsWith(q) ? 0 : 1, POPULAR.has(b[0]) ? 0 : 1, b[0].length]));
  return [...exact, ...prefix, ...names].slice(0, 8).map(([symbol, name]) => ({ symbol, name }));
}

// ------------------------------------------------------------------ usuarios
async function countUsers(env) {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM usuarios").first();
  return r ? r.n : 0;
}

async function createUser(env, usuario, sal, clave, rol) {
  if (!USER_RE.test(usuario)) throw new Error("Invalid username: lowercase letters, digits, dot, hyphen or underscore (2-32)");
  if (!/^[0-9a-f]{32}$/.test(sal) || !HEX64.test(clave)) throw new Error("Invalid password data");
  const ex = await env.DB.prepare("SELECT 1 FROM usuarios WHERE usuario = ?").bind(usuario).first();
  if (ex) throw new Error(`User ${usuario} already exists`);
  await env.DB.prepare("INSERT INTO usuarios (usuario, sal, verif, rol, lid, inactivo, creado) VALUES (?, ?, ?, ?, ?, 0, ?)")
    .bind(usuario, sal, await sha256(clave), rol, randHex(6), stamp()).run();
  await env.DB.prepare("INSERT INTO listas (usuario, json) VALUES (?, ?) ON CONFLICT(usuario) DO NOTHING")
    .bind(usuario, JSON.stringify({ symbols: DEFAULT_WATCH })).run();
}

async function admin(req, env, me) {
  if (req.method === "GET") {
    const rows = (await env.DB.prepare(
      "SELECT u.usuario, u.rol, u.inactivo, u.creado, u.cambiado, (SELECT COUNT(*) FROM sesiones s WHERE s.usuario = u.usuario AND s.exp > ?) AS sesiones, (SELECT MAX(s.creada) FROM sesiones s WHERE s.usuario = u.usuario) AS ultimo, l.json AS lista, EXISTS(SELECT 1 FROM takes_autores ta WHERE ta.usuario = u.usuario) AS autor FROM usuarios u LEFT JOIN listas l ON l.usuario = u.usuario ORDER BY u.creado",
    ).bind(nowS()).all()).results || [];
    for (const r of rows) {
      let n = DEFAULT_WATCH.length;
      try { const d = JSON.parse(r.lista || "null"); if (d && Array.isArray(d.symbols)) n = d.symbols.length; } catch { /* lista por defecto */ }
      r.tickers = n; delete r.lista;
    }
    return json(200, { usuarios: rows });
  }
  const b = await body(req);
  const u = String(b.usuario || "").trim().toLowerCase();
  if (b.accion === "crear") {
    await createUser(env, u, String(b.sal || ""), String(b.clave || ""), b.rol === "admin" ? "admin" : "usuario");
  } else {
    const ex = await env.DB.prepare("SELECT usuario FROM usuarios WHERE usuario = ?").bind(u).first();
    if (!ex) throw new Error(`User ${u} does not exist`);
    if (u === me.user && b.accion !== "contrasena") throw new Error("You can't disable or delete your own account");
    if (b.accion === "contrasena") {
      if (!/^[0-9a-f]{32}$/.test(b.sal || "") || !HEX64.test(b.clave || "")) throw new Error("Invalid password data");
      await env.DB.prepare("UPDATE usuarios SET sal = ?, verif = ?, cambiado = ? WHERE usuario = ?").bind(b.sal, await sha256(b.clave), stamp(), u).run();
      await env.DB.prepare("DELETE FROM sesiones WHERE usuario = ? AND h != ?").bind(u, u === me.user ? me.h : "").run();
    } else if (b.accion === "desactivar" || b.accion === "activar") {
      await env.DB.prepare("UPDATE usuarios SET inactivo = ? WHERE usuario = ?").bind(b.accion === "desactivar" ? 1 : 0, u).run();
      if (b.accion === "desactivar") await env.DB.prepare("DELETE FROM sesiones WHERE usuario = ?").bind(u).run();
    } else if (b.accion === "borrar") {
      for (const t of ["sesiones", "prefs", "listas", "takes_autores", "usuarios"]) await env.DB.prepare(`DELETE FROM ${t} WHERE usuario = ?`).bind(u).run();
    } else if (b.accion === "autor" || b.accion === "noautor") {   // Founder Takes: puede crear y editar sus borradores
      await env.DB.prepare(b.accion === "autor" ? "INSERT OR IGNORE INTO takes_autores (usuario) VALUES (?)" : "DELETE FROM takes_autores WHERE usuario = ?").bind(u).run();
    } else throw new Error("Unknown action");
  }
  const nuevos = await syncConfig(env);
  if (nuevos.length) await pedir(env, nuevos);
  return json(200, { ok: true });
}

// ------------------------------------------------------------------ API
async function api(req, env, url, me) {
  const p = url.pathname;
  if (p === "/api/logout" && req.method === "POST") {
    await env.DB.prepare("DELETE FROM sesiones WHERE h = ?").bind(me.h).run();
    return json(200, { ok: true }, { "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
  }
  if (p === "/api/prefs" && req.method === "POST") {
    const b = await body(req);
    const clean = {};
    for (const [k, v] of Object.entries(b.prefs || {}).slice(0, 80)) clean[String(k).slice(0, 40)] = String(v).slice(0, 2000);
    const s = JSON.stringify(clean);
    if (s.length > 50000) throw new Error("Preferences too large");
    await env.DB.prepare("INSERT INTO prefs (usuario, json) VALUES (?, ?) ON CONFLICT(usuario) DO UPDATE SET json = excluded.json").bind(me.user, s).run();
    await syncConfig(env);
    return json(200, clean);
  }
  if (p === "/api/watchlist") {
    if (req.method === "POST") {
      const b = await body(req);
      const syms = [];
      for (const x of b.symbols || []) { const s = normalize(x); if (s && !syms.includes(s)) syms.push(s); }
      const desconocidos = await desconocidosDe(env, syms);
      const d = { symbols: syms.filter((s) => !desconocidos.includes(s)).slice(0, MAX_WATCH), updated: stamp().slice(0, 10) };
      await env.DB.prepare("INSERT INTO listas (usuario, json) VALUES (?, ?) ON CONFLICT(usuario) DO UPDATE SET json = excluded.json").bind(me.user, JSON.stringify(d)).run();
      const nuevos = await syncConfig(env);
      // tickers nuevos en la lista: un ciclo completo del motor (paquete, escaner, Compass y Validacion de la lista).
      // Si ya hay uno en marcha, GitHub deja este en cola y empieza al terminar
      const ciclo = nuevos.length ? await dispatch(env, { modo: "ciclo" }) : false;
      return json(200, { ...d, nuevos, ciclo, desconocidos });
    }
    const r = await env.DB.prepare("SELECT json FROM listas WHERE usuario = ?").bind(me.user).first();
    let d = { symbols: DEFAULT_WATCH };
    try { if (r) d = JSON.parse(r.json); } catch { /* por defecto */ }
    return json(200, { symbols: d.symbols || DEFAULT_WATCH, updated: d.updated, default: false });
  }
  if (p === "/api/search") return json(200, { results: await search(env, url.searchParams.get("q")) });
  if (p === "/api/pedir" && req.method === "POST") {
    const b = await body(req);
    const syms = [...new Set((b.symbols || []).map(normalize).filter(Boolean))];
    if (!syms.length) return json(400, { error: "Invalid ticker" });
    const r = await pedir(env, syms);
    if (!r.symbols.length) return json(404, { error: `${r.desconocidos.join(", ")} has no listed options (check the ticker)` });
    return json(200, r);
  }
  if (p.startsWith("/api/pub/")) {
    const rest = p.slice(9);
    if (!SAFE_PATH.test(rest) || rest.includes("..") || rest.startsWith("l/")) return json(400, { error: "Invalid path" });
    return fromR2(req, env, "pub/" + rest);
  }
  if (p.startsWith("/api/lista/")) {
    const f = p.slice(11);
    if (!/^[a-z_0-9]+\.json$/.test(f)) return json(400, { error: "Invalid path" });
    return fromR2(req, env, `pub/l/${me.lid}/${f}`);
  }
  if (p === "/api/admin/importar" && req.method === "POST") {
    // historial del PC (history.tar.gz): lo mezcla el motor en su siguiente ciclo
    if (!me.admin) return json(403, { error: "Administrator only" });
    const buf = await req.arrayBuffer();
    const b = new Uint8Array(buf);
    if (b.length < 20 || b[0] !== 0x1f || b[1] !== 0x8b) return json(400, { error: "The file is not a .tar.gz" });
    if (b.length > 50 * 1024 * 1024) return json(400, { error: "File too large (50 MB max)" });
    await env.R2.put("importar/historial.tar.gz", buf, { httpMetadata: { contentType: "application/gzip" } });
    const lanzado = await dispatch(env, { modo: "ciclo" });
    return json(200, { ok: true, bytes: b.length, lanzado });
  }
  if (p === "/api/admin/historial") {
    if (!me.admin) return json(403, { error: "Administrator only" });
    return historial(req, env, me);
  }
  if (p === "/api/admin/fijos") {
    if (!me.admin) return json(403, { error: "Administrator only" });
    return fijos(req, env, me);
  }
  if (p === "/api/admin/estado") {
    if (!me.admin) return json(403, { error: "Administrator only" });
    return json(200, await estado(env));
  }
  if (p === "/api/admin/lanzar" && req.method === "POST") {
    if (!me.admin) return json(403, { error: "Administrator only" });
    const b = await body(req);
    const ok = b.que === "historial" ? await dispatch(env, b.forzar ? { forzar: "true" } : {}, "historial500.yml")
      : b.que === "ciclo" ? await dispatch(env, { modo: "ciclo" }) : null;
    if (ok === null) return json(400, { error: "Unknown action" });
    if (!ok) return json(502, { error: "GitHub did not accept the launch (check the GH_DISPATCH_TOKEN token)" });
    return json(200, { ok: true });
  }
  if (p === "/api/admin/usuarios") {
    if (!me.admin) return json(403, { error: "Administrator only" });
    return admin(req, env, me);
  }
  if (p === "/api/takes" || p.startsWith("/api/takes/")) {
    const r = await takes(req, env, url, me, { json, body, SEC_HEADERS });
    if (r) return r;
  }
  return json(404, { error: "not found" });
}

// ------------------------------------------------------------------ entrada
async function publicApi(req, env, url) {
  const p = url.pathname;
  if (p === "/api/setup/estado") return json(200, { necesario: (await countUsers(env)) === 0 });
  if (p === "/api/sal") {
    const u = String(url.searchParams.get("usuario") || "").trim().toLowerCase();
    const r = USER_RE.test(u) ? await env.DB.prepare("SELECT sal FROM usuarios WHERE usuario = ?").bind(u).first() : null;
    // usuario inexistente: sal falsa pero estable, para no revelar que usuarios existen
    const sal = r ? r.sal : (await hmacHex(env.GEX_SETUP_CODE || "gexlab", "sal|" + u)).slice(0, 32);
    return json(200, { sal, iter: ITER });
  }
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  const b = await body(req);
  if (p === "/api/login") {
    const u = String(b.usuario || "").trim().toLowerCase();
    for (const k of [`u:${u}`, `ip:${ip(req)}`]) {
      const w = await blocked(env, k);
      if (w) return json(429, { error: `Too many attempts. Try again in ${Math.ceil(w / 60)} min.` });
    }
    const r = USER_RE.test(u) ? await env.DB.prepare("SELECT verif, inactivo FROM usuarios WHERE usuario = ?").bind(u).first() : null;
    const ok = r && !r.inactivo && HEX64.test(String(b.clave || "")) && eq(await sha256(String(b.clave)), r.verif);
    if (!ok) {
      await fail(env, `u:${u}`); await fail(env, `ip:${ip(req)}`);
      return json(401, { error: "Wrong username or password" });
    }
    await env.DB.prepare("DELETE FROM fallos WHERE clave IN (?, ?)").bind(`u:${u}`, `ip:${ip(req)}`).run();
    return json(200, { ok: true }, { "Set-Cookie": await newSession(env, u, req) });
  }
  if (p === "/api/setup") {
    const k = `setup:${ip(req)}`;
    const w = await blocked(env, k);
    if (w) return json(429, { error: `Too many attempts. Try again in ${Math.ceil(w / 60)} min.` });
    if ((await countUsers(env)) > 0) return json(403, { error: "The administrator account already exists" });
    if (!env.GEX_SETUP_CODE || !eq(String(b.codigo || ""), env.GEX_SETUP_CODE)) {
      await fail(env, k);
      return json(401, { error: "Wrong setup code" });
    }
    const u = String(b.usuario || "").trim().toLowerCase();
    await createUser(env, u, String(b.sal || ""), String(b.clave || ""), "admin");
    await syncConfig(env);
    return json(200, { ok: true }, { "Set-Cookie": await newSession(env, u, req) });
  }
  return json(404, { error: "not found" });
}

// ------------------------------------------------------------------ reloj del motor
// Dias de mercado (hora de Nueva York): 07:45-17:15 cada 15 min y 18:00, 20:00 (reintentos del cierre);
// sabado a las 10:00 un ciclo para dejar el estado al dia.
function nyParts(d) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const o = Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
  return { wd: o.weekday, min: parseInt(o.hour, 10) * 60 + parseInt(o.minute, 10) };
}

function toca(d) {
  const { wd, min } = nyParts(d);
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(wd);
  if (min % 15) return false; // el reloj va cada 5 min; el ciclo completo, cada 15
  if (weekday && min >= 7 * 60 + 45 && min <= 17 * 60 + 15) return true;
  if (weekday && (min === 18 * 60 || min === 20 * 60)) return true;
  if (wd === "Sat" && min === 10 * 60) return true;
  return false;
}

// ciclo ligero de los indices en tiempo real (motor.py rapido): cada 5 min de 07:05 a 16:05 ET en dias laborables,
// justo tras cerrar cada vela de 5 min (de 07:05 a 09:30, el tramo previo a la apertura con las velas del ETF;
// la de 16:05 recoge la ultima de la sesion); el motor descarta festivos
function tocaRapido(d) {
  const { wd, min } = nyParts(d);
  return ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(wd) && min % 5 === 0 && min >= 7 * 60 + 5 && min <= 16 * 60 + 5;
}

// historial diario (historial500.yml): dias laborables a las 16:30 ET; el script descarta festivos
function tocaHistorial(d) {
  const { wd, min } = nyParts(d);
  return ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(wd) && min === 16 * 60 + 30;
}


// ------------------------------------------------------------------ alarma del calendario (Durable Object)
// Una sola instancia guarda los instantes de aviso que publica el motor (pub/eventos_horas.json: hora de cada
// evento + 1 min y reintentos mientras falte el dato real) y pone la alarma en el proximo. Al sonar lanza el motor
// en modo calendario (solo eventos). El cron */5 le vuelve a pasar la lista: si se pierde la alarma, vuelve en 5 min.
export class RelojCalendario {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }

  async fetch(req) {
    const lista = await req.json().catch(() => []);
    const ts = [...new Set((Array.isArray(lista) ? lista : []).map((s) => Date.parse(s)))]
      .filter((t) => Number.isFinite(t) && t > Date.now()).sort((a, b) => a - b).slice(0, 200);
    await this.ctx.storage.put("ts", ts);
    const cur = await this.ctx.storage.getAlarm();
    if (ts.length && cur !== ts[0]) await this.ctx.storage.setAlarm(ts[0]);
    else if (!ts.length && cur != null) await this.ctx.storage.deleteAlarm();
    return new Response(JSON.stringify({ proxima: ts[0] ? new Date(ts[0]).toISOString() : null }));
  }

  async alarm() {
    const ok = await dispatch(this.env, { modo: "calendario" });
    if (!ok) throw new Error("calendario: dispatch fallido"); // Cloudflare reintenta alarm() con espera creciente
    const ts = ((await this.ctx.storage.get("ts")) || []).filter((t) => t > Date.now() + 1000);
    await this.ctx.storage.put("ts", ts);
    if (ts.length) await this.ctx.storage.setAlarm(ts[0]);
  }
}

async function programarCalendario(env) {
  if (!env.RELOJ) return;
  const d = await r2json(env, "pub/eventos_horas.json");
  if (!d || !Array.isArray(d.horas)) return;
  const reloj = env.RELOJ.get(env.RELOJ.idFromName("calendario"));
  await reloj.fetch("https://reloj/programar", { method: "POST", body: JSON.stringify(d.horas) });
}

export default {
  async scheduled(event, env, ctx) {
    const d = new Date(event.scheduledTime);
    d.setUTCSeconds(0, 0);
    if (toca(d)) ctx.waitUntil(dispatch(env, { modo: "ciclo" }));
    if (tocaRapido(d)) ctx.waitUntil(dispatch(env, { modo: "rapido" }));
    if (tocaHistorial(d)) ctx.waitUntil(dispatch(env, {}, "historial500.yml"));
    ctx.waitUntil(programarCalendario(env).catch((e) => console.log("calendario:", e.message)));
  },

  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (req.method !== "GET" && req.method !== "HEAD") { // las escrituras solo desde la propia web
        const o = req.headers.get("Origin");
        if (o && o !== url.origin) return json(403, { error: "Origin not allowed" });
      }
      if (p.startsWith("/api/report/")) return await report(req, env, url, { json, body, SEC_HEADERS });
      if (PUBLIC.has(p)) {
        if (p.startsWith("/api/")) return await publicApi(req, env, url);
        // las paginas se sirven sin ".html" (/login, /setup)
        if (p.startsWith("/setup") && (await countUsers(env)) > 0) return redirect("/login");
        if (p.startsWith("/login") && (await countUsers(env)) === 0) return redirect("/setup");
        return env.ASSETS.fetch(req);
      }
      const ses = await sessionOf(req, env);
      const me = ses && !ses.closed ? ses : null;
      if (!me) {
        const otro = ses && ses.closed === "otro";
        const msg = otro ? "Your account was signed in on another device" : "Session expired: sign in again";
        if (p.startsWith("/api/")) return json(401, { error: msg, login: true, motivo: otro ? "otro" : "caducada" });
        return redirect((await countUsers(env)) === 0 ? "/setup" : otro ? "/login?motivo=otro" : "/login");
      }
      if (p === "/api/sesion") return json(200, { ok: true });
      if (p === "/me.js") {
        const r = await env.DB.prepare("SELECT json FROM prefs WHERE usuario = ?").bind(me.user).first();
        let prefs = {};
        try { prefs = r ? JSON.parse(r.json) : {}; } catch { /* sin preferencias */ }
        const js = "window.GEX_ME = " + JSON.stringify({ user: me.user, admin: me.admin, prefs, nube: true }) + ";";
        return new Response(js, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store", ...SEC_HEADERS } });
      }
      if (p.startsWith("/api/")) return await api(req, env, url, me);
      if (/^\/admin(\.html|\.js|\.css)?$/.test(p) && !me.admin) return redirect("/");
      const res = await env.ASSETS.fetch(req);
      const h = new Headers(res.headers);
      for (const [k, v] of Object.entries(SEC_HEADERS)) h.set(k, v);
      if (/\.(html|js|css|py)$/.test(p) || p === "/") h.set("Cache-Control", "no-cache");
      return new Response(res.body, { status: res.status, headers: h });
    } catch (e) {
      return json(400, { error: String(e && e.message || e) });
    }
  },
};
