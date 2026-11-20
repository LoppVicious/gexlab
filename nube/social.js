// GEX Lab - social diario: sirve el paquete y los graficos del cierre que deja social_diario.py en R2 (social/{F}/)
// y guarda los textos para X que escribe Claude Code con /x-diario (social/{F}/textos.json: la conclusion del dia y el
// playbook de la sesion siguiente, en hilos). Solo el admin (sesion de la web, pagina Research > Social) o el skill con
// "Authorization: Bearer <REPORT_TOKEN>"; la autorizacion la decide worker.js.
//   GET  /api/social/dias                 -> {dias: [F...]} (la mas reciente primero)
//   GET  /api/social/{F}                  -> {paquete, textos}
//   GET  /api/social/{F}/g/{nombre}.png
//   PUT  /api/social/{F}/textos           <- {piezas: [{id, titulo, texto, hilo, graficos, alt}]}
//                                            (conserva la marca de publicado de cada id)
//   POST /api/social/{F}/publicado        <- {id, publicado}
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const NOMBRE = /^[a-z0-9_]{1,40}$/;
export const MAX_CARACTERES = 280;
const MAX_PIEZAS = 12, MAX_IMAGENES = 4, MAX_HILO = 4;

// longitud como la cuenta X para texto sin enlaces: por puntos de codigo (un emoji o un ideograma cuentan 2 en X,
// pero el estilo no los usa)
export const largo = (s) => [...String(s)].length;

function textoValido(t, donde) {
  const x = String(t || "").trim();
  if (!x) throw new Error(`${donde}: empty text`);
  if (largo(x) > MAX_CARACTERES) throw new Error(`${donde}: ${largo(x)} characters (max ${MAX_CARACTERES})`);
  return x;
}

export function validarPiezas(d, nombres) {
  const piezas = Array.isArray(d && d.piezas) ? d.piezas : null;
  if (!piezas || !piezas.length) throw new Error("piezas must be a non-empty list");
  if (piezas.length > MAX_PIEZAS) throw new Error(`At most ${MAX_PIEZAS} posts`);
  const ids = new Set();
  return piezas.map((p, i) => {
    const id = String((p && p.id) || "");
    if (!NOMBRE.test(id) || ids.has(id)) throw new Error(`Post ${i + 1}: invalid or repeated id`);
    ids.add(id);
    const texto = textoValido(p.texto, `Post ${id}`);
    const hilo = Array.isArray(p.hilo) ? p.hilo : [];
    if (hilo.length > MAX_HILO) throw new Error(`Post ${id}: at most ${MAX_HILO} replies`);
    const respuestas = hilo.map((t, j) => textoValido(t, `Post ${id}, reply ${j + 1}`));
    const graficos = Array.isArray(p.graficos) ? p.graficos.map(String) : [];
    if (graficos.length > MAX_IMAGENES) throw new Error(`Post ${id}: at most ${MAX_IMAGENES} images`);
    for (const n of graficos) if (!nombres.has(n)) throw new Error(`Post ${id}: chart not found: ${n.slice(0, 40)}`);
    return { id, titulo: String(p.titulo || "").slice(0, 80), texto, hilo: respuestas, graficos, alt: String(p.alt || "").slice(0, 1000) };
  });
}

async function leerJson(env, key) {
  const o = await env.R2.get(key);
  return o ? o.json() : null;
}

const guardar = (env, key, obj) => env.R2.put(key, JSON.stringify(obj), { httpMetadata: { contentType: "application/json; charset=utf-8" } });

async function dias(env) {
  const out = new Set();
  let cursor;
  do {
    const r = await env.R2.list({ prefix: "social/", delimiter: "/", cursor });
    for (const p of r.delimitedPrefixes || []) { const f = p.slice(7, -1); if (FECHA.test(f)) out.add(f); }
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  return [...out].sort().reverse();
}

// h: {json, body, SEC_HEADERS}. La autorizacion la decide quien llama (worker.js).
export async function social(req, env, url, h) {
  const p = url.pathname;
  if (p === "/api/social/dias" && req.method === "GET") return h.json(200, { dias: await dias(env) });
  const m = /^\/api\/social\/([^/]+)(\/.*)?$/.exec(p);
  const f = m ? m[1] : "", resto = (m && m[2]) || "";
  if (!FECHA.test(f) || isNaN(Date.parse(f))) return h.json(400, { error: "Invalid date" });
  const base = `social/${f}/`;
  if (req.method === "GET" && !resto) {
    const [paquete, textos] = await Promise.all([leerJson(env, base + "paquete.json"), leerJson(env, base + "textos.json")]);
    if (!paquete) return h.json(404, { error: "No data for that day" });
    return h.json(200, { paquete, textos });
  }
  const g = /^\/g\/([^/]+)\.png$/.exec(resto);
  if (req.method === "GET" && g) {
    if (!NOMBRE.test(g[1])) return h.json(400, { error: "Invalid chart name" });
    const obj = await env.R2.get(`${base}g/${g[1]}.png`);
    if (!obj) return h.json(404, { error: "Not found" });
    return new Response(obj.body, { headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=86400", ...h.SEC_HEADERS } });
  }
  if (req.method === "PUT" && resto === "/textos") {
    if (!(await leerJson(env, base + "paquete.json"))) return h.json(404, { error: "No data for that day" });
    const nombres = new Set();
    const listado = await env.R2.list({ prefix: base + "g/" });
    for (const o of listado.objects || []) nombres.add(o.key.slice(base.length + 2).replace(/\.png$/, ""));
    let piezas;
    try { piezas = validarPiezas(await h.body(req), nombres); } catch (e) { return h.json(400, { error: e.message }); }
    const antes = (await leerJson(env, base + "textos.json")) || {};
    const pub = new Map((antes.piezas || []).map((x) => [x.id, x.publicado || null]));
    const textos = { fecha: f, escrito: new Date().toISOString(), piezas: piezas.map((x) => ({ ...x, publicado: pub.get(x.id) || null })) };
    await guardar(env, base + "textos.json", textos);
    return h.json(200, { ok: true, piezas: textos.piezas.length });
  }
  if (req.method === "POST" && resto === "/publicado") {
    const d = await h.body(req);
    const textos = await leerJson(env, base + "textos.json");
    const x = textos && (textos.piezas || []).find((y) => y.id === String(d.id || ""));
    if (!x) return h.json(404, { error: "Post not found" });
    x.publicado = d.publicado ? new Date().toISOString() : null;
    await guardar(env, base + "textos.json", textos);
    return h.json(200, { ok: true, publicado: x.publicado });
  }
  return h.json(404, { error: "not found" });
}
