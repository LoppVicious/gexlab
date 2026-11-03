// GEX Lab en Cloudflare Workers: web privada + API + reloj del motor.
// Enlaces (wrangler.toml): DB (D1), R2 (bucket gexlab), ASSETS (archivos de la web).
// Secretos: GEX_SETUP_CODE (alta del administrador), GH_DISPATCH_TOKEN (lanzar el motor en GitHub).
//
// Contrasenas: el navegador aplica PBKDF2-SHA256 (310.000 iteraciones, sal por usuario) y envia el resultado;
// aqui solo se guarda y se compara su SHA-256. La contrasena nunca sale del navegador y el servidor no gasta CPU.

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
  if (!ct.includes("application/json")) throw new Error("Peticion no valida");
  const t = await req.text();
  if (t.length > 100000) throw new Error("Peticion demasiado grande");
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
    const v = { dte: p.dte || "45", range: p.range || "auto", pos: p.pos || "standard", combo: p.combo || "0", sess: "auto" };
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
async function dispatch(env, inputs) {
  if (!env.GH_DISPATCH_TOKEN) return false;
  const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/motor.yml/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`, Accept: "application/vnd.github+json",
      "User-Agent": "gexlab", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: "main", inputs }),
  });
  return r.status === 204;
}

async function pedir(env, syms) {
  // calculo puntual de tickers sin paquete; como mucho un lanzamiento cada 4 min por ticker
  const fresh = [];
  for (const s of syms.slice(0, 10)) {
    const r = await env.DB.prepare("SELECT t FROM pedidos WHERE simbolo = ?").bind(s).first();
    if (r && nowS() - r.t < 240) continue;
    fresh.push(s);
    await env.DB.prepare("INSERT INTO pedidos (simbolo, t) VALUES (?, ?) ON CONFLICT(simbolo) DO UPDATE SET t = excluded.t").bind(s, nowS()).run();
  }
  const ok = fresh.length ? await dispatch(env, { modo: "ticker", tickers: fresh.join(" ") }) : true;
  return { ok, symbols: syms.slice(0, 10), lanzados: fresh };
}

// ------------------------------------------------------------------ datos publicados por el motor (R2 pub/)
async function fromR2(req, env, key) {
  const o = await env.R2.get(key, { onlyIf: req.headers });
  if (o === null) return json(404, { error: "Todavia no hay datos para esto", pendiente: true });
  const h = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-cache", ETag: o.httpEtag, ...SEC_HEADERS });
  if (!("body" in o) || !o.body) return new Response(null, { status: 304, headers: h });
  if (o.httpMetadata && o.httpMetadata.contentEncoding === "gzip") h.set("Content-Encoding", "gzip");
  if (o.uploaded) h.set("X-Edad", String(Math.max(0, Math.round((Date.now() - o.uploaded.getTime()) / 1000))));
  return new Response(o.body, { headers: h, encodeBody: "manual" });
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
  if (!USER_RE.test(usuario)) throw new Error("Usuario no valido: minusculas, numeros, punto, guion o guion bajo (2-32)");
  if (!/^[0-9a-f]{32}$/.test(sal) || !HEX64.test(clave)) throw new Error("Datos de contrasena no validos");
  const ex = await env.DB.prepare("SELECT 1 FROM usuarios WHERE usuario = ?").bind(usuario).first();
  if (ex) throw new Error(`El usuario ${usuario} ya existe`);
  await env.DB.prepare("INSERT INTO usuarios (usuario, sal, verif, rol, lid, inactivo, creado) VALUES (?, ?, ?, ?, ?, 0, ?)")
    .bind(usuario, sal, await sha256(clave), rol, randHex(6), stamp()).run();
  await env.DB.prepare("INSERT INTO listas (usuario, json) VALUES (?, ?) ON CONFLICT(usuario) DO NOTHING")
    .bind(usuario, JSON.stringify({ symbols: DEFAULT_WATCH })).run();
}

async function admin(req, env, me) {
  if (req.method === "GET") {
    const rows = (await env.DB.prepare(
      "SELECT u.usuario, u.rol, u.inactivo, u.creado, u.cambiado, (SELECT COUNT(*) FROM sesiones s WHERE s.usuario = u.usuario AND s.exp > ?) AS sesiones FROM usuarios u ORDER BY u.creado",
    ).bind(nowS()).all()).results || [];
    return json(200, { usuarios: rows });
  }
  const b = await body(req);
  const u = String(b.usuario || "").trim().toLowerCase();
  if (b.accion === "crear") {
    await createUser(env, u, String(b.sal || ""), String(b.clave || ""), b.rol === "admin" ? "admin" : "usuario");
  } else {
    const ex = await env.DB.prepare("SELECT usuario FROM usuarios WHERE usuario = ?").bind(u).first();
    if (!ex) throw new Error(`El usuario ${u} no existe`);
    if (u === me.user && b.accion !== "contrasena") throw new Error("No puedes desactivar ni borrar tu propia cuenta");
    if (b.accion === "contrasena") {
      if (!/^[0-9a-f]{32}$/.test(b.sal || "") || !HEX64.test(b.clave || "")) throw new Error("Datos de contrasena no validos");
      await env.DB.prepare("UPDATE usuarios SET sal = ?, verif = ?, cambiado = ? WHERE usuario = ?").bind(b.sal, await sha256(b.clave), stamp(), u).run();
      await env.DB.prepare("DELETE FROM sesiones WHERE usuario = ? AND h != ?").bind(u, u === me.user ? me.h : "").run();
    } else if (b.accion === "desactivar" || b.accion === "activar") {
      await env.DB.prepare("UPDATE usuarios SET inactivo = ? WHERE usuario = ?").bind(b.accion === "desactivar" ? 1 : 0, u).run();
      if (b.accion === "desactivar") await env.DB.prepare("DELETE FROM sesiones WHERE usuario = ?").bind(u).run();
    } else if (b.accion === "borrar") {
      for (const t of ["sesiones", "prefs", "listas", "usuarios"]) await env.DB.prepare(`DELETE FROM ${t} WHERE usuario = ?`).bind(u).run();
    } else throw new Error("Accion desconocida");
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
    if (s.length > 50000) throw new Error("Preferencias demasiado grandes");
    await env.DB.prepare("INSERT INTO prefs (usuario, json) VALUES (?, ?) ON CONFLICT(usuario) DO UPDATE SET json = excluded.json").bind(me.user, s).run();
    await syncConfig(env);
    return json(200, clean);
  }
  if (p === "/api/watchlist") {
    if (req.method === "POST") {
      const b = await body(req);
      const syms = [];
      for (const x of b.symbols || []) { const s = normalize(x); if (s && !syms.includes(s)) syms.push(s); }
      const d = { symbols: syms.slice(0, MAX_WATCH), updated: stamp().slice(0, 10) };
      await env.DB.prepare("INSERT INTO listas (usuario, json) VALUES (?, ?) ON CONFLICT(usuario) DO UPDATE SET json = excluded.json").bind(me.user, JSON.stringify(d)).run();
      const nuevos = await syncConfig(env);
      // tickers nuevos en la lista: un ciclo completo del motor (paquete, escaner, Compass y Validacion de la lista).
      // Si ya hay uno en marcha, GitHub deja este en cola y empieza al terminar
      const ciclo = nuevos.length ? await dispatch(env, { modo: "ciclo" }) : false;
      return json(200, { ...d, nuevos, ciclo });
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
    if (!syms.length) return json(400, { error: "Ticker no valido" });
    return json(200, await pedir(env, syms));
  }
  if (p.startsWith("/api/pub/")) {
    const rest = p.slice(9);
    if (!SAFE_PATH.test(rest) || rest.includes("..") || rest.startsWith("l/")) return json(400, { error: "Ruta no valida" });
    return fromR2(req, env, "pub/" + rest);
  }
  if (p.startsWith("/api/lista/")) {
    const f = p.slice(11);
    if (!/^[a-z_0-9]+\.json$/.test(f)) return json(400, { error: "Ruta no valida" });
    return fromR2(req, env, `pub/l/${me.lid}/${f}`);
  }
  if (p === "/api/admin/importar" && req.method === "POST") {
    // historial del PC (history.tar.gz): lo mezcla el motor en su siguiente ciclo
    if (!me.admin) return json(403, { error: "Solo el administrador" });
    const buf = await req.arrayBuffer();
    const b = new Uint8Array(buf);
    if (b.length < 20 || b[0] !== 0x1f || b[1] !== 0x8b) return json(400, { error: "El archivo no es un .tar.gz" });
    if (b.length > 50 * 1024 * 1024) return json(400, { error: "Archivo demasiado grande (máximo 50 MB)" });
    await env.R2.put("importar/historial.tar.gz", buf, { httpMetadata: { contentType: "application/gzip" } });
    const lanzado = await dispatch(env, { modo: "ciclo" });
    return json(200, { ok: true, bytes: b.length, lanzado });
  }
  if (p === "/api/admin/usuarios") {
    if (!me.admin) return json(403, { error: "Solo el administrador" });
    return admin(req, env, me);
  }
  return json(404, { error: "no encontrado" });
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
  if (req.method !== "POST") return json(405, { error: "Metodo no permitido" });
  const b = await body(req);
  if (p === "/api/login") {
    const u = String(b.usuario || "").trim().toLowerCase();
    for (const k of [`u:${u}`, `ip:${ip(req)}`]) {
      const w = await blocked(env, k);
      if (w) return json(429, { error: `Demasiados intentos. Vuelve a probar en ${Math.ceil(w / 60)} min.` });
    }
    const r = USER_RE.test(u) ? await env.DB.prepare("SELECT verif, inactivo FROM usuarios WHERE usuario = ?").bind(u).first() : null;
    const ok = r && !r.inactivo && HEX64.test(String(b.clave || "")) && eq(await sha256(String(b.clave)), r.verif);
    if (!ok) {
      await fail(env, `u:${u}`); await fail(env, `ip:${ip(req)}`);
      return json(401, { error: "Usuario o contraseña incorrectos" });
    }
    await env.DB.prepare("DELETE FROM fallos WHERE clave IN (?, ?)").bind(`u:${u}`, `ip:${ip(req)}`).run();
    return json(200, { ok: true }, { "Set-Cookie": await newSession(env, u, req) });
  }
  if (p === "/api/setup") {
    const k = `setup:${ip(req)}`;
    const w = await blocked(env, k);
    if (w) return json(429, { error: `Demasiados intentos. Vuelve a probar en ${Math.ceil(w / 60)} min.` });
    if ((await countUsers(env)) > 0) return json(403, { error: "La cuenta de administrador ya existe" });
    if (!env.GEX_SETUP_CODE || !eq(String(b.codigo || ""), env.GEX_SETUP_CODE)) {
      await fail(env, k);
      return json(401, { error: "Código de alta incorrecto" });
    }
    const u = String(b.usuario || "").trim().toLowerCase();
    await createUser(env, u, String(b.sal || ""), String(b.clave || ""), "admin");
    await syncConfig(env);
    return json(200, { ok: true }, { "Set-Cookie": await newSession(env, u, req) });
  }
  return json(404, { error: "no encontrado" });
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
  if (weekday && min >= 7 * 60 + 45 && min <= 17 * 60 + 15) return true;
  if (weekday && (min === 18 * 60 || min === 20 * 60)) return true;
  if (wd === "Sat" && min === 10 * 60) return true;
  return false;
}


export default {
  async scheduled(event, env, ctx) {
    const d = new Date(event.scheduledTime);
    d.setUTCSeconds(0, 0);
    if (toca(d)) ctx.waitUntil(dispatch(env, { modo: "ciclo" }));
  },

  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (req.method === "POST") { // las escrituras solo desde la propia web
        const o = req.headers.get("Origin");
        if (o && o !== url.origin) return json(403, { error: "Origen no permitido" });
      }
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
        const msg = otro ? "Se ha iniciado sesión con tu cuenta en otro dispositivo" : "Sesión caducada: vuelve a iniciar sesión";
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
