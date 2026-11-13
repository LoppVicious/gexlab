// GEX Lab - Founder Takes en el Worker: entradas en D1 (takes, takes_adjuntos, takes_autores) y archivos en R2
// (takes/<take_id>/<24 hex>.<ext>). Escribe el admin; los usuarios de takes_autores crean y editan sus borradores;
// el resto lee lo publicado. Las funciones puras se exportan para pruebas/test_takes.mjs.

export const LIM = {
  titulo: 200, cuerpo: 50000, cita: 5000, nota: 500, url: 2000,
  etiquetas: 10, etiqueta: 30, adjuntos: 30, archivos: 8,
  bytes: 20 * 1024 * 1024,       // por archivo
  peticion: 95 * 1024 * 1024,    // el plan gratuito de Cloudflare corta en 100 MB
};
const TIPOS = new Set(["enlace", "pdf", "imagen", "cita"]);

// tipo real del archivo por sus primeros bytes (no por la extension ni por lo que diga el navegador). SVG no: puede llevar scripts
export function tipoArchivo(b) {
  const s = (i, n) => String.fromCharCode(...b.subarray(i, i + n));
  if (b.length >= 5 && s(0, 5) === "%PDF-") return { tipo: "pdf", ext: "pdf", mime: "application/pdf" };
  if (b.length >= 8 && b[0] === 0x89 && s(1, 3) === "PNG") return { tipo: "imagen", ext: "png", mime: "image/png" };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { tipo: "imagen", ext: "jpg", mime: "image/jpeg" };
  if (b.length >= 12 && s(0, 4) === "RIFF" && s(8, 4) === "WEBP") return { tipo: "imagen", ext: "webp", mime: "image/webp" };
  return null;
}

export function urlSegura(s) {
  s = String(s || "").trim();
  if (!s || s.length > LIM.url) return null;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch { return null; }
}

export function limpiarEtiquetas(lista) {
  const out = [], vistas = new Set();
  for (const x of Array.isArray(lista) ? lista : []) {
    const t = String(x ?? "").trim().replace(/\s+/g, " ");
    if (!t) continue;
    if (t.length > LIM.etiqueta) throw new Error(`Tag too long (${LIM.etiqueta} characters max): ${t.slice(0, 40)}`);
    const k = t.toLowerCase();
    if (vistas.has(k)) continue;
    vistas.add(k); out.push(t);
  }
  if (out.length > LIM.etiquetas) throw new Error(`Too many tags (${LIM.etiquetas} max)`);
  return out;
}

// texto plano para el listado: sin sintaxis de Markdown, espacios juntados y corte con "…"
export function extracto(md, n = 300) {
  const t = String(md || "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,3}|>|[-*]|\d{1,3}[.)])\s+/gm, "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
}

function largo(s, n, que) {
  s = String(s ?? "");
  if (s.length > n) throw new Error(`${que} too long (${n.toLocaleString("en-US")} characters max)`);
  return s;
}

// datos: JSON del editor. archivos: Map campo -> {nombre, bytes}. previos: Map id -> fila de takes_adjuntos del Take.
// Devuelve {titulo, cuerpo, etiquetas, adjuntos: [{id, tipo, url, r2, nuevo, titulo, texto, fuente}]}; lanza Error si algo no vale
export function validarTake(datos, archivos, previos) {
  if (!datos || typeof datos !== "object") throw new Error("Invalid request");
  const titulo = largo(datos.titulo, LIM.titulo, "Title").trim();
  const cuerpo = largo(datos.cuerpo, LIM.cuerpo, "Text").trim();
  const etiquetas = limpiarEtiquetas(datos.etiquetas);
  const lista = Array.isArray(datos.adjuntos) ? datos.adjuntos : [];
  if (lista.length > LIM.adjuntos) throw new Error(`Too many attachments (${LIM.adjuntos} max)`);
  const adjuntos = [], usados = new Set();
  let nArchivos = 0;
  for (const a of lista) {
    if (!a || typeof a !== "object") throw new Error("Invalid attachment");
    const previo = a.id != null ? previos.get(Number(a.id)) : null;
    if (a.id != null && !previo) throw new Error("Attachment not found");
    const tipo = previo ? previo.tipo : String(a.tipo || "");
    if (!TIPOS.has(tipo)) throw new Error("Unknown attachment type");
    const cita = tipo === "cita";
    const x = {
      id: previo ? previo.id : null, tipo, url: null, r2: previo ? previo.r2 : null, nuevo: null,
      titulo: largo(a.titulo, LIM.titulo, "Attachment title").trim(),
      texto: largo(a.texto, cita ? LIM.cita : LIM.nota, cita ? "Quote" : "Note").trim(),
      fuente: largo(a.fuente, LIM.titulo, "Source").trim(),
    };
    if (tipo === "enlace" || cita) {
      const u = String(a.url || "").trim();
      x.url = u ? urlSegura(u) : null;
      if (u && !x.url) throw new Error(`Invalid link (only http and https): ${u.slice(0, 80)}`);
      if (tipo === "enlace" && !x.url) throw new Error("A link attachment needs a URL");
      if (cita && !x.texto) throw new Error("A quote needs the quoted text");
    } else {
      nArchivos++;
      if (!previo) {
        const campo = String(a.archivo || "");
        const f = archivos.get(campo);
        if (!f || usados.has(campo)) throw new Error("Missing file for an attachment");
        usados.add(campo);
        if (f.bytes.length > LIM.bytes) throw new Error(`File too large (20 MB max): ${f.nombre}`);
        const det = tipoArchivo(f.bytes);
        const ext = ((String(f.nombre).match(/\.([a-z0-9]+)$/i) || [])[1] || "").toLowerCase();
        const extOk = det && (ext === det.ext || (det.ext === "jpg" && ext === "jpeg"));
        if (!det || det.tipo !== tipo || !extOk) throw new Error(`Unsupported file: ${f.nombre} (PDF, PNG, JPEG or WebP only)`);
        x.nuevo = { bytes: f.bytes, ext: det.ext, mime: det.mime };
        if (!x.titulo) x.titulo = String(f.nombre).slice(0, LIM.titulo);
      }
    }
    adjuntos.push(x);
  }
  if (nArchivos > LIM.archivos) throw new Error(`Too many files (${LIM.archivos} max per take)`);
  if (!cuerpo && !adjuntos.length) throw new Error("A take needs text or at least one attachment");
  return { titulo, cuerpo, etiquetas, adjuntos };
}

// ------------------------------------------------------------------ rutas
// h: utilidades de worker.js {json, body, SEC_HEADERS}. Devuelve null si la ruta o el metodo no existen
const ahora = () => new Date().toISOString();
const rand = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");
const dominio = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const srcDe = (r2) => "/api/takes/archivo/" + r2.slice(6);   // quita "takes/"
const visible = (t, me) => t.estado === "publicado" || me.admin || t.autor === me.user;

async function esAutor(env, me) {
  if (me.admin) return true;
  return !!(await env.DB.prepare("SELECT 1 FROM takes_autores WHERE usuario = ?").bind(me.user).first());
}

export async function takes(req, env, url, me, h) {
  const p = url.pathname, m = req.method;
  if (p === "/api/takes") {
    if (m === "GET") return lista(env, me, h);
    if (m === "POST") return guardar(req, env, me, null, h);
    return null;
  }
  if (p.startsWith("/api/takes/archivo/")) return m === "GET" ? archivo(env, me, p.slice(19), h) : null;
  const mm = p.match(/^\/api\/takes\/(\d{1,9})(\/estado)?$/);
  if (!mm) return null;
  const id = Number(mm[1]);
  if (mm[2]) return m === "POST" ? estado(req, env, me, id, h) : null;
  if (m === "GET") return uno(env, me, id, h);
  if (m === "PUT") return guardar(req, env, me, id, h);
  if (m === "DELETE") return borrar(env, me, id, h);
  return null;
}

async function lista(env, me, h) {
  const filas = (await env.DB.prepare(
    "SELECT id, titulo, substr(cuerpo, 1, 1200) AS ini, etiquetas, estado, autor, creado, editado, publicado FROM takes " +
    "WHERE estado = 'publicado' OR ?1 = 1 OR autor = ?2 ORDER BY COALESCE(publicado, creado) DESC",
  ).bind(me.admin ? 1 : 0, me.user).all()).results || [];
  const ids = new Set(filas.map((t) => t.id));
  const porTake = new Map();
  for (const a of (await env.DB.prepare("SELECT take_id, tipo, titulo, url FROM takes_adjuntos ORDER BY take_id, orden").all()).results || []) {
    if (!ids.has(a.take_id)) continue;
    if (!porTake.has(a.take_id)) porTake.set(a.take_id, []);
    porTake.get(a.take_id).push({ tipo: a.tipo, titulo: a.titulo || (a.url ? dominio(a.url) : "") });
  }
  const out = filas.map((t) => ({
    id: t.id, titulo: t.titulo, extracto: extracto(t.ini), etiquetas: JSON.parse(t.etiquetas || "[]"),
    estado: t.estado, autor: t.autor, creado: t.creado, editado: t.editado, publicado: t.publicado,
    adjuntos: porTake.get(t.id) || [],
  }));
  return h.json(200, { takes: out, puede: { escribir: await esAutor(env, me), publicar: !!me.admin }, yo: me.user });
}

async function uno(env, me, id, h) {
  const t = await env.DB.prepare("SELECT * FROM takes WHERE id = ?").bind(id).first();
  if (!t || !visible(t, me)) return h.json(404, { error: "Take not found" });
  const adj = (await env.DB.prepare("SELECT id, tipo, url, r2, titulo, texto, fuente FROM takes_adjuntos WHERE take_id = ? ORDER BY orden").bind(id).all()).results || [];
  const editable = me.admin || (t.autor === me.user && t.estado === "borrador" && await esAutor(env, me));
  return h.json(200, {
    id: t.id, titulo: t.titulo, cuerpo: t.cuerpo, etiquetas: JSON.parse(t.etiquetas || "[]"), estado: t.estado,
    autor: t.autor, creado: t.creado, editado: t.editado, publicado: t.publicado,
    adjuntos: adj.map((a) => ({ id: a.id, tipo: a.tipo, url: a.url, titulo: a.titulo, texto: a.texto, fuente: a.fuente, src: a.r2 ? srcDe(a.r2) : null })),
    puede: { editar: editable, publicar: !!me.admin },
  });
}

async function guardar(req, env, me, id, h) {
  if (!(await esAutor(env, me))) return h.json(403, { error: "Your account can't write takes" });
  const previos = new Map();
  if (id != null) {
    const t = await env.DB.prepare("SELECT estado, autor FROM takes WHERE id = ?").bind(id).first();
    if (!t || !visible(t, me)) return h.json(404, { error: "Take not found" });
    if (!me.admin && (t.autor !== me.user || t.estado !== "borrador")) return h.json(403, { error: "Only the administrator can edit this take" });
    for (const a of (await env.DB.prepare("SELECT * FROM takes_adjuntos WHERE take_id = ?").bind(id).all()).results || []) previos.set(a.id, a);
  }
  if (!(req.headers.get("Content-Type") || "").includes("multipart/form-data")) return h.json(400, { error: "Invalid request" });
  if (Number(req.headers.get("Content-Length") || 0) > LIM.peticion) return h.json(413, { error: "Too much data in one save (95 MB max)" });
  const fd = await req.formData();
  let datos;
  try { datos = JSON.parse(String(fd.get("datos") || "")); } catch { return h.json(400, { error: "Invalid request" }); }
  const archivos = new Map();
  for (const [k, v] of fd.entries()) {
    if (/^archivo\d{1,2}$/.test(k) && v && typeof v === "object" && typeof v.arrayBuffer === "function") {
      archivos.set(k, { nombre: String(v.name || ""), bytes: new Uint8Array(await v.arrayBuffer()) });
    }
  }
  const t = validarTake(datos, archivos, previos);   // un Error aqui lo convierte worker.js en 400 con su mensaje
  const ts = ahora();
  if (id == null) {
    const r = await env.DB.prepare("INSERT INTO takes (titulo, cuerpo, etiquetas, estado, autor, creado) VALUES (?, ?, ?, 'borrador', ?, ?) RETURNING id")
      .bind(t.titulo, t.cuerpo, JSON.stringify(t.etiquetas), me.user, ts).first();
    id = r.id;
  } else {
    await env.DB.prepare("UPDATE takes SET titulo = ?, cuerpo = ?, etiquetas = ?, editado = ? WHERE id = ?")
      .bind(t.titulo, t.cuerpo, JSON.stringify(t.etiquetas), ts, id).run();
  }
  // primero los archivos nuevos a R2; luego la lista de adjuntos de una vez; al final se borran los quitados
  for (const a of t.adjuntos) {
    if (!a.nuevo) continue;
    a.r2 = `takes/${id}/${rand()}.${a.nuevo.ext}`;
    await env.R2.put(a.r2, a.nuevo.bytes, { httpMetadata: { contentType: a.nuevo.mime } });
  }
  const sigue = new Set(t.adjuntos.filter((a) => a.id != null).map((a) => a.id));
  const quitar = [...previos.values()].filter((a) => !sigue.has(a.id) && a.r2).map((a) => a.r2);
  const ins = "INSERT INTO takes_adjuntos (take_id, orden, tipo, url, r2, titulo, texto, fuente) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
  await env.DB.batch([
    env.DB.prepare("DELETE FROM takes_adjuntos WHERE take_id = ?").bind(id),
    ...t.adjuntos.map((a, i) => env.DB.prepare(ins).bind(id, i, a.tipo, a.url, a.r2, a.titulo, a.texto, a.fuente)),
  ]);
  if (quitar.length) await env.R2.delete(quitar);
  return h.json(200, { id });
}

async function estado(req, env, me, id, h) {
  if (!me.admin) return h.json(403, { error: "Administrator only" });
  const b = await h.body(req);
  const e = b.estado === "publicado" || b.estado === "borrador" ? b.estado : null;
  if (!e) return h.json(400, { error: "Unknown state" });
  const r = await env.DB.prepare(
    "UPDATE takes SET estado = ?1, publicado = CASE WHEN ?1 = 'publicado' THEN COALESCE(publicado, ?2) ELSE publicado END WHERE id = ?3",
  ).bind(e, ahora(), id).run();
  if (!r.meta.changes) return h.json(404, { error: "Take not found" });
  return h.json(200, { ok: true });
}

async function borrar(env, me, id, h) {
  if (!me.admin) return h.json(403, { error: "Administrator only" });
  const claves = ((await env.DB.prepare("SELECT r2 FROM takes_adjuntos WHERE take_id = ? AND r2 IS NOT NULL").bind(id).all()).results || []).map((a) => a.r2);
  const r = await env.DB.batch([
    env.DB.prepare("DELETE FROM takes_adjuntos WHERE take_id = ?").bind(id),
    env.DB.prepare("DELETE FROM takes WHERE id = ?").bind(id),
  ]);
  if (!r[1].meta.changes) return h.json(404, { error: "Take not found" });
  if (claves.length) await env.R2.delete(claves);
  return h.json(200, { ok: true });
}

async function archivo(env, me, resto, h) {
  if (!/^\d{1,9}\/[0-9a-f]{24}\.(pdf|png|jpg|webp)$/.test(resto)) return h.json(400, { error: "Invalid path" });
  const clave = "takes/" + resto;
  const t = await env.DB.prepare("SELECT t.estado, t.autor FROM takes_adjuntos a JOIN takes t ON t.id = a.take_id WHERE a.r2 = ?").bind(clave).first();
  if (!t || !visible(t, me)) return h.json(404, { error: "File not found" });
  const o = await env.R2.get(clave);
  if (!o) return h.json(404, { error: "File not found" });
  return new Response(o.body, {
    headers: {
      ...h.SEC_HEADERS, "Content-Type": (o.httpMetadata && o.httpMetadata.contentType) || "application/octet-stream",
      "Content-Disposition": "inline", "Cache-Control": "private, max-age=86400",
    },
  });
}
