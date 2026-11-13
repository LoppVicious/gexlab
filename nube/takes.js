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
