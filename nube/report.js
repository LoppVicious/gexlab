// GEX Lab - report semanal y nota diaria de flujos: sirve el paquete y los graficos que dejan report_semanal.py
// (R2 report/{F}/) y flujos_diario.py (R2 flujos/{F}/) y crea el borrador del Take. Solo con
// "Authorization: Bearer <REPORT_TOKEN>" (secreto del Worker); sin el secreto configurado o con otro token, 404. No
// usa la sesion de usuario. Lo llaman los skills /report-semanal y /take-flujos de Claude Code. En flujos, el
// borrador guarda ademas la tesis de la nota en flujos/{F}/tesis.json (la anade a la serie flujos_diario.py).
import { validarTake, escribirTake } from "./takes.js";

export const AUTOR_REPORT = "claude";   // la cuenta Claude, con permiso de borradores en Takes
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const NOMBRE = /^[a-z0-9_]{1,40}$/;
const TESIS_MAX = 4000;   // bytes del JSON de la tesis

export async function tokenOk(req, env) {
  const t = env.REPORT_TOKEN;
  const m = /^Bearer (.+)$/.exec(req.headers.get("Authorization") || "");
  if (!t || !m) return false;
  const enc = new TextEncoder();   // se comparan los SHA-256: misma longitud y tiempo constante
  const [a, b] = await Promise.all([m[1], t].map((s) => crypto.subtle.digest("SHA-256", enc.encode(s))));
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

async function servir(env, key, tipo, h) {
  const obj = await env.R2.get(key);
  if (!obj) return h.json(404, { error: "Not found" });
  return new Response(obj.body, { headers: { "Content-Type": tipo, "Cache-Control": "no-store", ...h.SEC_HEADERS } });
}

export async function report(req, env, url, h) {
  if (!(await tokenOk(req, env))) return h.json(404, { error: "not found" });
  const m = /^\/api\/(report|flujos)\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (!m) return h.json(404, { error: "not found" });
  const base = m[1], f = m[2], resto = m[3] || "";
  if (f === "ultimo" && req.method === "GET" && !resto) return servir(env, `${base}/ultimo.json`, "application/json; charset=utf-8", h);
  if (!FECHA.test(f) || isNaN(Date.parse(f))) return h.json(400, { error: "Invalid date" });
  if (req.method === "GET" && !resto) return servir(env, `${base}/${f}/paquete.json`, "application/json; charset=utf-8", h);
  const g = /^\/g\/([^/]+)\.png$/.exec(resto);
  if (req.method === "GET" && g) {
    if (!NOMBRE.test(g[1])) return h.json(400, { error: "Invalid chart name" });
    return servir(env, `${base}/${f}/g/${g[1]}.png`, "image/png", h);
  }
  if (req.method === "POST" && resto === "/take") return crear(req, env, base, f, h);
  return h.json(404, { error: "not found" });
}

// JSON {titulo, cuerpo, etiquetas, graficos: [{nombre, titulo, nota}], tesis (solo flujos)} -> borrador de
// AUTOR_REPORT con los PNG
async function crear(req, env, base, f, h) {
  const d = await h.body(req);
  let tesis = null;
  if (base === "flujos" && d.tesis !== undefined) {
    if (!d.tesis || typeof d.tesis !== "object" || Array.isArray(d.tesis)) return h.json(400, { error: "Invalid thesis" });
    tesis = new TextEncoder().encode(JSON.stringify(d.tesis));
    if (tesis.length > TESIS_MAX) return h.json(400, { error: `Thesis too long (${TESIS_MAX} bytes max)` });
  }
  const graficos = Array.isArray(d.graficos) ? d.graficos : [];
  const archivos = new Map(), adjuntos = [];
  for (const [i, x] of graficos.entries()) {
    const nombre = String((x && x.nombre) || "");
    if (!NOMBRE.test(nombre)) return h.json(400, { error: `Invalid chart name: ${nombre.slice(0, 40)}` });
    const obj = await env.R2.get(`${base}/${f}/g/${nombre}.png`);
    if (!obj) return h.json(404, { error: `Chart not found: ${nombre}` });
    const campo = `archivo${i}`;
    archivos.set(campo, { nombre: `${nombre}.png`, bytes: new Uint8Array(await new Response(obj.body).arrayBuffer()) });
    adjuntos.push({ tipo: "imagen", archivo: campo, titulo: String(x.titulo || ""), texto: String(x.nota || "") });
  }
  const t = validarTake({ titulo: d.titulo, cuerpo: d.cuerpo, etiquetas: d.etiquetas, adjuntos }, archivos, new Map());
  const id = await escribirTake(env, AUTOR_REPORT, t, null, new Map());
  if (tesis) await env.R2.put(`flujos/${f}/tesis.json`, tesis, { httpMetadata: { contentType: "application/json; charset=utf-8" } });
  return h.json(200, { id });
}
