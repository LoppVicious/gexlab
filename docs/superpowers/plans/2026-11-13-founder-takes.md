# Founder Takes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Página «Founder Takes» en GEX Lab: el admin publica entradas con texto Markdown, etiquetas y adjuntos
(enlace, cita, PDF, imagen); la cuenta `Claude` puede dejar borradores; el resto de usuarios lee.

**Architecture:** Entradas en D1 (`takes`, `takes_adjuntos`, `takes_autores`), archivos en R2 bajo `takes/`. La lógica
del Worker va en un módulo propio `nube/takes.js` (validación pura + rutas), importado por `nube/worker.js`; wrangler
lo empaqueta solo. En la web, `web/takes-md.js` (Markdown seguro, sin dependencias), `web/takes.js` (página) y
`web/takes.css`. Spec: `docs/superpowers/specs/2026-11-13-founder-takes-design.md`.

**Tech Stack:** Cloudflare Workers (ES modules), D1, R2, JS sin framework, `node:test` (Node 22+) para las pruebas
de las funciones puras.

**Convenciones del repo (leer antes):** `CLAUDE.md` en la raíz. Textos de la web y errores de la API en inglés;
código y comentarios en español sin tildes en el código (como el resto). Colores solo con variables del tema
(`--surface`, `--line`, `--text`, `--muted`, `--faint`, `--accent`, `--accent-soft`, `--btn`, `--btn-hover`,
`--amber`, `--neg`). Sin «·» como separador en la web. Prefijo `tk` para todo global nuevo de la web (funciones,
clases CSS, claves de preferencias): los scripts de `web/` comparten el ámbito global.

**Commits:** uno por tarea, en `main` local. **No hacer push** hasta la Tarea 10, y solo con el visto bueno del usuario:
el push despliega en producción y debe llevar `CHANGELOG.md` actualizado en el mismo commit.

---

## Mapa de archivos

| Archivo | Acción | Responsabilidad |
|---|---|---|
| `nube/schema.sql` | modificar | tablas `takes`, `takes_adjuntos`, `takes_autores` |
| `nube/takes.js` | crear | validación pura (exportada) y rutas `/api/takes*` |
| `nube/worker.js` | modificar | importar y enrutar `takes`; Origin en PUT/DELETE; autores en `/api/admin/usuarios` |
| `web/takes-md.js` | crear | `tkMarkdown`, `tkInline`, `tkEsc` (Markdown mínimo que escapa todo el HTML) |
| `web/takes.js` | crear | página: listado, filtro, detalle, editor |
| `web/takes.css` | crear | estilos de la página |
| `web/index.html` | modificar | menú «Research → Takes», vista `takesView`, CSS y scripts |
| `web/app.js` | modificar | `NAV`, `currentNav`, `TOOLS` |
| `web/admin.js` | modificar | botón «Allow drafts» / «Revoke drafts» |
| `server.py` | modificar | `/api/takes` en modo PC: 404 con mensaje de «solo en la nube» |
| `pruebas/test_takes.mjs` | crear | pruebas `node:test` de `nube/takes.js` y `web/takes-md.js` |
| `docs/ARQUITECTURA.md`, `CLAUDE.md`, `CHANGELOG.md`, `docs/ESTADO.md` | modificar | documentación |

---

### Task 1: Esquema D1

**Files:**
- Modify: `nube/schema.sql` (añadir al final)

- [ ] **Step 1: Añadir las tablas**

Añadir al final de `nube/schema.sql`:

```sql
-- Founder Takes: entradas del admin (y borradores de autores), adjuntos y quien puede escribir borradores.
-- Archivos (pdf, imagen) en R2: takes/<take_id>/<24 hex>.<ext>
CREATE TABLE IF NOT EXISTS takes (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  titulo    TEXT NOT NULL DEFAULT '',
  cuerpo    TEXT NOT NULL DEFAULT '',     -- Markdown (subconjunto de web/takes-md.js)
  etiquetas TEXT NOT NULL DEFAULT '[]',   -- JSON, lista de cadenas
  estado    TEXT NOT NULL DEFAULT 'borrador',  -- 'borrador' | 'publicado'
  autor     TEXT NOT NULL,
  creado    TEXT NOT NULL,                -- ISO 8601 UTC
  editado   TEXT,
  publicado TEXT                          -- primera publicacion; orden del listado
);
CREATE INDEX IF NOT EXISTS takes_publicado ON takes(estado, publicado);
CREATE TABLE IF NOT EXISTS takes_adjuntos (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  take_id INTEGER NOT NULL,
  orden   INTEGER NOT NULL,
  tipo    TEXT NOT NULL,                  -- 'enlace' | 'pdf' | 'imagen' | 'cita'
  url     TEXT,                           -- enlace: obligatoria; cita: opcional
  r2      TEXT,                           -- pdf e imagen: clave en R2
  titulo  TEXT NOT NULL DEFAULT '',
  texto   TEXT NOT NULL DEFAULT '',       -- cita: el extracto; resto: nota corta
  fuente  TEXT NOT NULL DEFAULT ''        -- cita: autor o casa de research
);
CREATE INDEX IF NOT EXISTS takes_adjuntos_take ON takes_adjuntos(take_id, orden);
CREATE INDEX IF NOT EXISTS takes_adjuntos_r2 ON takes_adjuntos(r2);
CREATE TABLE IF NOT EXISTS takes_autores (usuario TEXT PRIMARY KEY);
```

- [ ] **Step 2: Comprobar la sintaxis con SQLite**

Run (PowerShell, desde `gexlab/`): `python -c "import sqlite3; c=sqlite3.connect(':memory:'); c.executescript(open('nube/schema.sql',encoding='utf-8').read()); c.executescript(open('nube/schema.sql',encoding='utf-8').read()); print(sorted(r[0] for r in c.execute(\"select name from sqlite_master where type='table'\")))"`

Expected: la lista incluye `takes`, `takes_adjuntos`, `takes_autores`, sin error (se aplica dos veces: idempotente).

- [ ] **Step 3: Commit**

```bash
git add nube/schema.sql
git commit -m "Takes: tablas en D1"
```

---

### Task 2: Validación pura en `nube/takes.js` (TDD)

**Files:**
- Create: `nube/takes.js`
- Create: `pruebas/test_takes.mjs`

- [ ] **Step 1: Escribir las pruebas que fallan**

Crear `pruebas/test_takes.mjs`:

```js
// Pruebas de Founder Takes (funciones puras). Ejecutar: node --test pruebas/test_takes.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { validarTake, tipoArchivo, limpiarEtiquetas, urlSegura, extracto, LIM } from "../nube/takes.js";

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const sinPrevios = new Map();

test("tipoArchivo reconoce PDF, PNG, JPEG y WebP por los primeros bytes", () => {
  assert.equal(tipoArchivo(PDF).ext, "pdf");
  assert.equal(tipoArchivo(PNG).ext, "png");
  assert.equal(tipoArchivo(JPG).ext, "jpg");
  assert.equal(tipoArchivo(WEBP).ext, "webp");
  assert.equal(tipoArchivo(SVG), null);
  assert.equal(tipoArchivo(new Uint8Array([])), null);
});

test("urlSegura solo deja http y https", () => {
  assert.equal(urlSegura("https://x.com/a/status/1"), "https://x.com/a/status/1");
  assert.equal(urlSegura("http://example.com"), "http://example.com/");
  assert.equal(urlSegura("javascript:alert(1)"), null);
  assert.equal(urlSegura("ftp://example.com"), null);
  assert.equal(urlSegura("no es una url"), null);
});

test("limpiarEtiquetas recorta, quita duplicados sin mirar mayusculas y limita", () => {
  assert.deepEqual(limpiarEtiquetas([" NVDA ", "nvda", "macro", "", "0DTE"]), ["NVDA", "macro", "0DTE"]);
  assert.deepEqual(limpiarEtiquetas(undefined), []);
  assert.throws(() => limpiarEtiquetas(Array.from({ length: 11 }, (_, i) => "t" + i)), /Too many tags/);
  assert.throws(() => limpiarEtiquetas(["x".repeat(31)]), /Tag too long/);
});

test("extracto quita el Markdown y corta con puntos suspensivos", () => {
  assert.equal(extracto("# Title\n\n**Bold** and [link](https://a.com)\n- item"), "Title Bold and link item");
  const largo = extracto("a ".repeat(400), 300);
  assert.equal(largo.length, 300);
  assert.ok(largo.endsWith("…"));
});

test("validarTake exige texto o algun adjunto", () => {
  assert.throws(() => validarTake({ titulo: "", cuerpo: "  ", adjuntos: [] }, new Map(), sinPrevios), /needs text or at least one attachment/);
});

test("validarTake acepta texto, enlace, cita, PDF e imagen", () => {
  const archivos = new Map([["archivo0", { nombre: "note.pdf", bytes: PDF }], ["archivo1", { nombre: "image.png", bytes: PNG }]]);
  const t = validarTake({
    titulo: " Weekly ", cuerpo: "Text", etiquetas: ["SPX"],
    adjuntos: [
      { tipo: "enlace", url: "https://x.com/u/status/1", titulo: "", texto: "good thread" },
      { tipo: "cita", texto: "quoted", fuente: "Bank", url: "" },
      { tipo: "pdf", archivo: "archivo0" },
      { tipo: "imagen", archivo: "archivo1", texto: "chart" },
    ],
  }, archivos, sinPrevios);
  assert.equal(t.titulo, "Weekly");
  assert.deepEqual(t.etiquetas, ["SPX"]);
  assert.deepEqual(t.adjuntos.map((a) => a.tipo), ["enlace", "cita", "pdf", "imagen"]);
  assert.equal(t.adjuntos[0].url, "https://x.com/u/status/1");
  assert.equal(t.adjuntos[1].url, null);
  assert.equal(t.adjuntos[2].nuevo.mime, "application/pdf");
  assert.equal(t.adjuntos[2].titulo, "note.pdf");
  assert.equal(t.adjuntos[3].nuevo.ext, "png");
});

test("validarTake rechaza enlaces peligrosos y citas vacias", () => {
  assert.throws(() => validarTake({ cuerpo: "x", adjuntos: [{ tipo: "enlace", url: "javascript:alert(1)" }] }, new Map(), sinPrevios), /Invalid link/);
  assert.throws(() => validarTake({ cuerpo: "x", adjuntos: [{ tipo: "enlace", url: "" }] }, new Map(), sinPrevios), /needs a URL/);
  assert.throws(() => validarTake({ cuerpo: "x", adjuntos: [{ tipo: "cita", texto: " " }] }, new Map(), sinPrevios), /quoted text/);
  assert.throws(() => validarTake({ cuerpo: "x", adjuntos: [{ tipo: "video" }] }, new Map(), sinPrevios), /Unknown attachment type/);
});

test("validarTake rechaza archivos que no son lo que dicen", () => {
  const f = (nombre, bytes) => new Map([["archivo0", { nombre, bytes }]]);
  const pdf = { cuerpo: "x", adjuntos: [{ tipo: "pdf", archivo: "archivo0" }] };
  const img = { cuerpo: "x", adjuntos: [{ tipo: "imagen", archivo: "archivo0" }] };
  assert.throws(() => validarTake(pdf, f("fake.pdf", PNG), sinPrevios), /Unsupported file/);
  assert.throws(() => validarTake(img, f("logo.svg", SVG), sinPrevios), /Unsupported file/);
  assert.throws(() => validarTake(img, f("photo.pdf", PNG), sinPrevios), /Unsupported file/);
  assert.doesNotThrow(() => validarTake(img, f("photo.JPEG", JPG), sinPrevios));
  assert.throws(() => validarTake(pdf, new Map(), sinPrevios), /Missing file/);
  const grande = new Uint8Array(LIM.bytes + 1); grande.set(PDF);
  assert.throws(() => validarTake(pdf, f("big.pdf", grande), sinPrevios), /File too large/);
});

test("validarTake limita el numero de archivos", () => {
  const archivos = new Map(), adjuntos = [];
  for (let i = 0; i <= LIM.archivos; i++) { archivos.set("archivo" + i, { nombre: `f${i}.pdf`, bytes: PDF }); adjuntos.push({ tipo: "pdf", archivo: "archivo" + i }); }
  assert.throws(() => validarTake({ cuerpo: "x", adjuntos }, archivos, sinPrevios), /Too many files/);
});

test("validarTake conserva adjuntos existentes por id y rechaza ids ajenos", () => {
  const previos = new Map([[7, { id: 7, tipo: "pdf", r2: "takes/3/aaaaaaaaaaaaaaaaaaaaaaaa.pdf", url: null }]]);
  const t = validarTake({ cuerpo: "x", adjuntos: [{ id: 7, tipo: "imagen", titulo: "Renamed" }] }, new Map(), previos);
  assert.equal(t.adjuntos[0].tipo, "pdf");          // el tipo no cambia al editar
  assert.equal(t.adjuntos[0].r2, previos.get(7).r2);
  assert.equal(t.adjuntos[0].nuevo, null);
  assert.equal(t.adjuntos[0].titulo, "Renamed");
  assert.throws(() => validarTake({ cuerpo: "x", adjuntos: [{ id: 99 }] }, new Map(), previos), /Attachment not found/);
});

test("validarTake limita longitudes", () => {
  assert.throws(() => validarTake({ titulo: "x".repeat(LIM.titulo + 1), cuerpo: "x" }, new Map(), sinPrevios), /Title too long/);
  assert.throws(() => validarTake({ cuerpo: "x".repeat(LIM.cuerpo + 1) }, new Map(), sinPrevios), /Text too long/);
});
```

- [ ] **Step 2: Ejecutar y ver que falla**

Run: `node --test pruebas/test_takes.mjs`
Expected: FAIL, `Cannot find module ... nube/takes.js`.

- [ ] **Step 3: Implementar la parte pura de `nube/takes.js`**

Crear `nube/takes.js`:

```js
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
```

- [ ] **Step 4: Ejecutar y ver que pasa**

Run: `node --test pruebas/test_takes.mjs`
Expected: todas las pruebas `ok`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add nube/takes.js pruebas/test_takes.mjs
git commit -m "Takes: validacion de entradas y archivos con pruebas"
```

---

### Task 3: Rutas `/api/takes*` en el Worker

**Files:**
- Modify: `nube/takes.js` (añadir al final)
- Modify: `nube/worker.js` (import arriba; `api()` antes del 404 final; `fetch()` comprobación de Origin; `admin()`)

- [ ] **Step 1: Añadir las rutas al final de `nube/takes.js`**

```js
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
```

- [ ] **Step 2: Enganchar en `nube/worker.js`**

a) Debajo del comentario de cabecera (antes de `const ITER = 310000;`):

```js
import { takes } from "./takes.js";
```

b) En `api()`, justo antes de la última línea `return json(404, { error: "not found" });`:

```js
  if (p === "/api/takes" || p.startsWith("/api/takes/")) {
    const r = await takes(req, env, url, me, { json, body, SEC_HEADERS });
    if (r) return r;
  }
```

c) En `fetch()`, la comprobación de Origin debe cubrir también PUT y DELETE. Sustituir:

```js
      if (req.method === "POST") { // las escrituras solo desde la propia web
```

por:

```js
      if (req.method !== "GET" && req.method !== "HEAD") { // las escrituras solo desde la propia web
```

d) En `admin()`, autores de borradores. En la consulta del `GET`, sustituir el trozo
`l.json AS lista FROM usuarios u` por:

```js
l.json AS lista, EXISTS(SELECT 1 FROM takes_autores ta WHERE ta.usuario = u.usuario) AS autor FROM usuarios u
```

En la cadena de acciones, antes de `} else throw new Error("Unknown action");`, añadir:

```js
    } else if (b.accion === "autor" || b.accion === "noautor") {
      await env.DB.prepare(b.accion === "autor" ? "INSERT OR IGNORE INTO takes_autores (usuario) VALUES (?)" : "DELETE FROM takes_autores WHERE usuario = ?").bind(u).run();
```

Y en la acción `borrar`, añadir `"takes_autores"` a la lista de tablas:

```js
      for (const t of ["sesiones", "prefs", "listas", "takes_autores", "usuarios"]) await env.DB.prepare(`DELETE FROM ${t} WHERE usuario = ?`).bind(u).run();
```

Nota: la línea `if (u === me.user && b.accion !== "contrasena") throw ...` impide al admin cambiarse a sí mismo; no
importa, el admin ya escribe siempre.

- [ ] **Step 3: Comprobar sintaxis y que el módulo carga**

Run: `node --check nube/worker.js; node --check nube/takes.js; node --test pruebas/test_takes.mjs`
Expected: sin salida de los `--check`; pruebas `# fail 0`.

Run: `node -e "import('./nube/takes.js').then(m => console.log(typeof m.takes))"`
Expected: `function`

- [ ] **Step 4: Commit**

```bash
git add nube/takes.js nube/worker.js
git commit -m "Takes: API en el Worker, autores de borradores y Origin en PUT/DELETE"
```

---

### Task 4: Markdown seguro `web/takes-md.js` (TDD)

**Files:**
- Create: `web/takes-md.js`
- Modify: `pruebas/test_takes.mjs` (añadir pruebas)

- [ ] **Step 1: Añadir las pruebas que fallan**

Al principio de `pruebas/test_takes.mjs`, debajo de los imports existentes:

```js
import { createRequire } from "node:module";
const { tkMarkdown } = createRequire(import.meta.url)("../web/takes-md.js");
```

Al final del archivo:

```js
test("tkMarkdown escapa todo el HTML", () => {
  const h = tkMarkdown('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">');
  assert.ok(!h.includes("<script"));
  assert.ok(!h.includes("<img"));
  assert.ok(h.includes("&lt;script&gt;"));
  assert.ok(h.includes("&quot;alert(1)&quot;"));
});

test("tkMarkdown no crea enlaces javascript:", () => {
  const h = tkMarkdown("[x](javascript:alert(1))");
  assert.ok(!h.includes("href"));
  assert.ok(h.includes("[x](javascript:alert(1))"));
});

test("tkMarkdown: titulos, listas, citas, negrita, cursiva y codigo", () => {
  assert.equal(tkMarkdown("# Big\n## Mid"), "<h2>Big</h2><h3>Mid</h3>");
  assert.equal(tkMarkdown("- a\n- b"), "<ul><li>a</li><li>b</li></ul>");
  assert.equal(tkMarkdown("1. a\n2. b"), "<ol><li>a</li><li>b</li></ol>");
  assert.equal(tkMarkdown("> quoted"), "<blockquote><p>quoted</p></blockquote>");
  assert.equal(tkMarkdown("**b** *i* _j_ `c`"), "<p><strong>b</strong> <em>i</em> <em>j</em> <code>c</code></p>");
  assert.equal(tkMarkdown("line 1\nline 2\n\npara 2"), "<p>line 1<br>line 2</p><p>para 2</p>");
});

test("tkMarkdown: enlaces con nueva pestana y URLs sueltas sin cursivas dentro", () => {
  const a = '<a href="https://a.com/x" target="_blank" rel="noopener noreferrer">';
  assert.equal(tkMarkdown("[see](https://a.com/x)"), `<p>${a}see</a></p>`);
  const h = tkMarkdown("thread https://x.com/some_user_name/status/1.");
  assert.ok(h.includes('href="https://x.com/some_user_name/status/1"'));
  assert.ok(!h.includes("<em>"));
  assert.ok(h.endsWith("</a>.</p>"));
});
```

- [ ] **Step 2: Ejecutar y ver que falla**

Run: `node --test pruebas/test_takes.mjs`
Expected: FAIL, `Cannot find module ... web/takes-md.js`.

- [ ] **Step 3: Implementar `web/takes-md.js`**

```js
"use strict";
/* GEX Lab - Founder Takes: Markdown minimo y seguro. Primero se escapa TODO el HTML; despues se reconocen titulos
   (# ## ###), listas (- * 1.), citas (>), negrita, cursiva, codigo en linea, enlaces [texto](url) y URLs sueltas,
   solo http y https. Lo usan takes.js (pagina y vista previa del editor) y pruebas/test_takes.mjs. */

function tkEsc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

function tkLink(href, texto) { return `<a href="${href}" target="_blank" rel="noopener noreferrer">${texto}</a>`; }

// una linea: el codigo y los enlaces se apartan en fichas para que las cursivas no entren en ellos
function tkInline(s) {
  const fichas = [];
  const guarda = (h) => `\u0000${fichas.push(h) - 1}\u0000`;
  let t = tkEsc(String(s).replace(/\u0000/g, ""));
  t = t.replace(/`([^`]+)`/g, (_, c) => guarda(`<code>${c}</code>`));
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, x, u) => guarda(tkLink(u, x)));
  t = t.replace(/https?:\/\/[^\s<]*[^\s<.,;:!?)]/g, (u) => guarda(tkLink(u, u)));
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^\w*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  t = t.replace(/(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, "$1<em>$2</em>");
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => fichas[+i]);
}

function tkMarkdown(md) {
  const lineas = String(md || "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let par = [], lista = null, cita = [];
  const cierra = () => {
    if (par.length) { out.push(`<p>${par.map(tkInline).join("<br>")}</p>`); par = []; }
    if (lista) { out.push(`<${lista.tag}>${lista.items.map((x) => `<li>${tkInline(x)}</li>`).join("")}</${lista.tag}>`); lista = null; }
    if (cita.length) { out.push(`<blockquote>${tkMarkdown(cita.join("\n"))}</blockquote>`); cita = []; }
  };
  for (const l of lineas) {
    let m;
    if (!l.trim()) { cierra(); continue; }
    if ((m = l.match(/^>\s?(.*)$/))) { if (!cita.length) cierra(); cita.push(m[1]); continue; }
    if (cita.length) cierra();
    if ((m = l.match(/^(#{1,3})\s+(.+)$/))) { cierra(); const n = m[1].length + 1; out.push(`<h${n}>${tkInline(m[2])}</h${n}>`); continue; }
    if ((m = l.match(/^\s*([-*]|\d{1,3}[.)])\s+(.+)$/))) {
      const tag = /\d/.test(m[1]) ? "ol" : "ul";
      if (par.length || (lista && lista.tag !== tag)) cierra();
      if (!lista) lista = { tag, items: [] };
      lista.items.push(m[2]);
      continue;
    }
    if (lista) cierra();
    par.push(l);
  }
  cierra();
  return out.join("");
}

if (typeof module !== "undefined") module.exports = { tkMarkdown, tkInline, tkEsc };
```

- [ ] **Step 4: Ejecutar y ver que pasa**

Run: `node --test pruebas/test_takes.mjs; node --check web/takes-md.js`
Expected: `# fail 0`; sin salida del `--check`.

- [ ] **Step 5: Commit**

```bash
git add web/takes-md.js pruebas/test_takes.mjs
git commit -m "Takes: Markdown seguro para la web con pruebas"
```

---

### Task 5: Modo PC (`server.py`)

**Files:**
- Modify: `server.py` (en `do_GET`, antes de `if url.path != "/api/gex":`)

- [ ] **Step 1: Responder a `/api/takes` con el aviso**

Antes de la línea `if url.path != "/api/gex":` en `do_GET`, añadir:

```python
        if url.path == "/api/takes" or url.path.startswith("/api/takes/"):
            return self._json(404, {"error": "Founder Takes are available in the cloud version."})
```

- [ ] **Step 2: Comprobar**

Run: `python -c "import ast; ast.parse(open('server.py', encoding='utf-8').read()); print('ok')"`
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add server.py
git commit -m "Takes: aviso de solo en la nube en el modo PC"
```

---

### Task 6: Autores de borradores en `/admin`

**Files:**
- Modify: `web/admin.js` (`loadUsers` y el manejador de clics de `#users`)

- [ ] **Step 1: Botón por usuario no admin**

En `loadUsers()`, dentro de la plantilla de la fila, sustituir el bloque de botones para otros usuarios:

```js
          `<button class="linkbtn" data-a="${u.inactivo ? "activar" : "desactivar"}" data-u="${esc(u.usuario)}">${u.inactivo ? "Enable" : "Disable"}</button><button class="linkbtn danger" data-a="borrar" data-u="${esc(u.usuario)}">Delete</button>`}</td></tr>`;
```

por:

```js
          `${u.rol === "admin" ? "" : `<button class="linkbtn" data-a="${u.autor ? "noautor" : "autor"}" data-u="${esc(u.usuario)}" title="Founder Takes: can create and edit their own drafts">${u.autor ? "Revoke drafts" : "Allow drafts"}</button>`}<button class="linkbtn" data-a="${u.inactivo ? "activar" : "desactivar"}" data-u="${esc(u.usuario)}">${u.inactivo ? "Enable" : "Disable"}</button><button class="linkbtn danger" data-a="borrar" data-u="${esc(u.usuario)}">Delete</button>`}</td></tr>`;
```

Y en el primer `<td>` de la fila, tras la insignia de admin, mostrar la de autor. Sustituir:

```js
${u.rol === "admin" ? '<span class="badge adm">admin</span>' : ""}
```

por:

```js
${u.rol === "admin" ? '<span class="badge adm">admin</span>' : ""}${u.autor && u.rol !== "admin" ? '<span class="badge">drafts</span>' : ""}
```

- [ ] **Step 2: Mensajes de las acciones nuevas**

En el manejador de clics, en el objeto de mensajes `{ activar: ..., desactivar: ..., borrar: ... }[a]`, añadir dos claves:

```js
autor: `${u} can now write Founder Takes drafts.`, noautor: `${u} can no longer write Founder Takes drafts.`,
```

- [ ] **Step 3: Comprobar**

Run: `node --check web/admin.js`
Expected: sin salida.

- [ ] **Step 4: Commit**

```bash
git add web/admin.js
git commit -m "Takes: permiso de borradores en la administracion"
```

---

### Task 7: Página: menú, vista, listado y detalle

**Files:**
- Modify: `web/index.html`
- Modify: `web/app.js` (`TOOLS`, `NAV`, `currentNav`)
- Create: `web/takes.js`

- [ ] **Step 1: Menú, vista, CSS y scripts en `web/index.html`**

a) En `<nav>`, justo antes de `<div class="sec">Console</div>`, añadir la sección:

```html
    <div class="sec">Research</div>
      <button class="item" id="navTakes" data-title="Founder Takes" title="Founder Takes"><svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3.5h7l3 3V16a.5.5 0 0 1-.5.5h-9.5a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5z"/><path d="M12 3.5V7h3M7.5 10h5M7.5 13h3.5"/></svg><span class="lbl">Takes</span></button>
```

b) Tras el `</main>` que cierra `corrView`, añadir la vista:

```html
<main class="macro tk" id="takesView" hidden>
  <div class="scan-bar tk-bar">
    <input class="tk-q" id="tkQ" type="search" placeholder="Search takes" aria-label="Search takes" autocomplete="off">
    <button class="ghost tk-primary" id="tkNew" hidden>New take</button>
  </div>
  <div class="tk-tags" id="tkTags" role="group" aria-label="Filter by tag"></div>
  <div class="tk-body" id="tkBody"></div>
</main>
```

c) En el `<head>`, tras `<link rel="stylesheet" href="herramientas.css">` y antes de `tema.css`:

```html
<link rel="stylesheet" href="takes.css">
```

d) Tras `<script src="corr.js"></script>`:

```html
<script src="takes-md.js"></script>
<script src="takes.js"></script>
```

- [ ] **Step 2: Registrar la página en `web/app.js`**

a) En `TOOLS`, tras la línea de `corr`:

```js
  takes: { view: "takesView", ticker: false, show: () => showTakes(), render: () => renderTakes(), load: (r) => loadTakes(r) },
```

b) En `NAV`, tras `navCorr`:

```js
  navTakes: { t: "Founder Takes", go: () => setMode("takes") },
```

c) En `currentNav()`, tras `if (m === "corr") return "navCorr";`:

```js
  if (m === "takes") return "navTakes";
```

- [ ] **Step 3: Crear `web/takes.js` con listado y detalle**

```js
"use strict";
/* ============================================================ Founder Takes (Research, Takes)
   Datos: /api/takes (lista), /api/takes/:id (detalle), escritura con multipart (ver nube/takes.js). Una sola pagina
   con tres estados en #tkBody: listado (filtro por etiquetas y busqueda), detalle y editor. El Markdown lo pinta
   tkMarkdown (takes-md.js), que escapa todo el HTML. Globales con prefijo tk. */

const tk = { lista: null, puede: { escribir: false, publicar: false }, yo: "", at: 0, ctrl: null,
  abierto: null, editor: null, q: "", filtro: new Set() };
try { for (const x of JSON.parse(store.get("tkFiltro", "[]"))) tk.filtro.add(String(x)); } catch { /* sin filtro guardado */ }

const TK_ICON = { enlace: "Link", pdf: "PDF", imagen: "Image", cita: "Quote" };
const tkFecha = (iso) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "");
const tkDominio = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
function tkStatus() { return tk.lista ? `${tk.lista.length} take${tk.lista.length === 1 ? "" : "s"}` : ""; }
function tkGuardaFiltro() { store.set("tkFiltro", JSON.stringify([...tk.filtro])); }

function showTakes() {
  if (tk.lista) { renderTakes(); setStatus("", tkStatus()); }
  if (!tk.lista || Date.now() - tk.at > 300000) loadTakes();
}

async function loadTakes(refresh = false) {
  if (tk.ctrl) tk.ctrl.abort();
  tk.ctrl = new AbortController();
  $("refreshBtn").classList.add("spin");
  setStatus("busy", "Loading takes…");
  if (!tk.lista) $("tkBody").innerHTML = `<div class="empty">Loading takes…</div>`;
  try {
    const r = await fetch("/api/takes", { signal: tk.ctrl.signal });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Could not load the takes");
    tk.lista = d.takes; tk.puede = d.puede; tk.yo = d.yo; tk.at = Date.now();
    if (refresh && tk.abierto) await tkAbre(tk.abierto.id, false);
    if (state.mode === "takes") { renderTakes(); setStatus("", tkStatus()); }
  } catch (e) {
    if (e.name === "AbortError") return;
    if (state.mode === "takes") {
      setStatus("err", tk.lista ? "Could not refresh" : "No data");
      if (!tk.lista) $("tkBody").innerHTML = `<div class="empty">${esc(e.message === "Failed to fetch" ? "The server is not responding." : e.message)}</div>`;
    }
  } finally { $("refreshBtn").classList.remove("spin"); }
}

function renderTakes() {
  $("tkNew").hidden = !tk.puede.escribir || !!tk.editor;
  $("tkQ").hidden = !!tk.editor || !!tk.abierto;
  if (tk.editor) { $("tkTags").innerHTML = ""; return tkPintaEditor(); }
  if (tk.abierto) { $("tkTags").innerHTML = ""; return tkPintaDetalle(); }
  tkPintaLista();
}

function tkVisibles() {
  const q = tk.q.trim().toLowerCase();
  return (tk.lista || []).filter((t) => {
    const et = t.etiquetas.map((e) => e.toLowerCase());
    if ([...tk.filtro].some((f) => !et.includes(f))) return false;
    return !q || `${t.titulo} ${t.extracto} ${t.etiquetas.join(" ")}`.toLowerCase().includes(q);
  });
}

function tkPintaLista() {
  const cuenta = new Map();
  for (const t of tk.lista || []) for (const e of t.etiquetas) {
    const k = e.toLowerCase();
    if (!cuenta.has(k)) cuenta.set(k, { n: 0, txt: e });
    cuenta.get(k).n++;
  }
  for (const f of [...tk.filtro]) if (!cuenta.has(f)) tk.filtro.delete(f);   // etiquetas que ya no existen
  const tags = [...cuenta.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]));
  $("tkTags").innerHTML = tags.map(([k, v]) =>
    `<button class="tk-chip${tk.filtro.has(k) ? " on" : ""}" data-tag="${esc(k)}" aria-pressed="${tk.filtro.has(k)}">${esc(v.txt)} <span>${v.n}</span></button>`).join("");
  const vis = tkVisibles();
  if (!tk.lista.length) {
    $("tkBody").innerHTML = `<div class="empty">${tk.puede.escribir ? "No takes yet. Use New take to write the first one." : "No takes yet."}</div>`;
    return;
  }
  if (!vis.length) { $("tkBody").innerHTML = `<div class="empty">No takes match the filter.</div>`; return; }
  $("tkBody").innerHTML = `<div class="tk-list">${vis.map((t) => {
    const titulo = t.titulo || t.extracto.split(" ").slice(0, 8).join(" ") || "Untitled";
    const tipos = [...new Set(t.adjuntos.map((a) => a.tipo))];
    return `<article class="tk-card" data-id="${t.id}" tabindex="0">
      <div class="tk-meta"><time>${esc(tkFecha(t.publicado || t.creado))}</time>${t.estado === "borrador" ? '<span class="tk-draft">Draft</span>' : ""}${t.autor !== tk.yo && t.estado === "borrador" ? `<span>by ${esc(t.autor)}</span>` : ""}</div>
      <h3>${esc(titulo)}</h3>
      ${t.extracto && t.titulo ? `<p>${esc(t.extracto)}</p>` : ""}
      <div class="tk-foot">${t.etiquetas.map((e) => `<span class="tk-tag">${esc(e)}</span>`).join("")}${tipos.map((x) => `<span class="tk-kind">${TK_ICON[x]}</span>`).join("")}</div>
    </article>`;
  }).join("")}</div>`;
}

async function tkAbre(id, pinta = true) {
  setStatus("busy", "Loading take…");
  try {
    const r = await fetch(`/api/takes/${id}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Could not load the take");
    tk.abierto = d;
    if (pinta) { renderTakes(); window.scrollTo(0, 0); }
    setStatus("", tkStatus());
  } catch (e) { setStatus("err", e.message); }
}

function tkAdjunto(a) {
  const nota = a.texto ? `<span class="tk-adj-n">${esc(a.texto)}</span>` : "";
  if (a.tipo === "enlace") {
    return `<a class="tk-adj" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer"><span class="tk-kind">Link</span><span class="tk-adj-t">${esc(a.titulo || tkDominio(a.url))}</span><span class="tk-adj-d">${esc(tkDominio(a.url))}</span>${nota}</a>`;
  }
  if (a.tipo === "pdf") {
    return `<div class="tk-adj"><span class="tk-kind">PDF</span><span class="tk-adj-t">${esc(a.titulo)}</span>${nota}<a class="ghost tk-open" href="${esc(a.src)}" target="_blank" rel="noopener">Open PDF</a></div>`;
  }
  if (a.tipo === "imagen") {
    return `<figure class="tk-img"><a href="${esc(a.src)}" target="_blank" rel="noopener" title="Open full size"><img src="${esc(a.src)}" alt="${esc(a.titulo || a.texto || "Image")}" loading="lazy"></a>${a.texto ? `<figcaption>${esc(a.texto)}</figcaption>` : ""}</figure>`;
  }
  return `<blockquote class="tk-quote"><p>${esc(a.texto).replace(/\n/g, "<br>")}</p>${a.fuente || a.url ? `<footer>${esc(a.fuente)}${a.url ? ` <a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">Source</a>` : ""}</footer>` : ""}</blockquote>`;
}

function tkPintaDetalle() {
  const t = tk.abierto;
  const acciones = [
    t.puede.editar ? `<button class="ghost" data-tk="editar">Edit</button>` : "",
    t.puede.publicar ? `<button class="ghost" data-tk="${t.estado === "publicado" ? "despublicar" : "publicar"}">${t.estado === "publicado" ? "Unpublish" : "Publish"}</button>` : "",
    t.puede.publicar ? `<button class="ghost tk-danger" data-tk="borrar">Delete</button>` : "",
  ].join("");
  $("tkBody").innerHTML = `<article class="tk-detail">
    <div class="tk-detail-bar"><button class="ghost" data-tk="volver">‹ All takes</button><span class="tk-actions">${acciones}</span></div>
    <div class="tk-meta"><time>${esc(tkFecha(t.publicado || t.creado))}</time>${t.editado ? `<span>edited ${esc(tkFecha(t.editado))}</span>` : ""}${t.estado === "borrador" ? '<span class="tk-draft">Draft</span>' : ""}</div>
    ${t.titulo ? `<h1>${esc(t.titulo)}</h1>` : ""}
    ${t.etiquetas.length ? `<div class="tk-foot">${t.etiquetas.map((e) => `<span class="tk-tag">${esc(e)}</span>`).join("")}</div>` : ""}
    <div class="tk-md">${tkMarkdown(t.cuerpo)}</div>
    ${t.adjuntos.length ? `<div class="tk-adjs">${t.adjuntos.map(tkAdjunto).join("")}</div>` : ""}
  </article>`;
}

async function tkEstado(estado) {
  const t = tk.abierto;
  try {
    const r = await fetch(`/api/takes/${t.id}/estado`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ estado }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Could not change the state");
    await tkAbre(t.id); loadTakes();
  } catch (e) { setStatus("err", e.message); }
}

async function tkBorra() {
  const t = tk.abierto;
  if (!confirm(`Delete “${t.titulo || "this take"}” and its files? This can't be undone.`)) return;
  try {
    const r = await fetch(`/api/takes/${t.id}`, { method: "DELETE" });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Could not delete the take");
    tk.abierto = null; await loadTakes();
  } catch (e) { setStatus("err", e.message); }
}

$("tkQ").addEventListener("input", (e) => { tk.q = e.target.value; tkPintaLista(); });
$("tkTags").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tag]"); if (!b) return;
  const k = b.dataset.tag;
  if (tk.filtro.has(k)) tk.filtro.delete(k); else tk.filtro.add(k);
  tkGuardaFiltro(); tkPintaLista();
});
$("tkBody").addEventListener("click", (e) => {
  const card = !tk.editor && !tk.abierto && e.target.closest(".tk-card");
  if (card) return void tkAbre(+card.dataset.id);
  const b = e.target.closest("[data-tk]"); if (!b) return;
  const a = b.dataset.tk;
  if (a === "volver") { tk.abierto = null; renderTakes(); }
  else if (a === "editar") tkEditor(tk.abierto);
  else if (a === "publicar") tkEstado("publicado");
  else if (a === "despublicar") tkEstado("borrador");
  else if (a === "borrar") tkBorra();
  else tkAccionEditor(a, b);
});
$("tkBody").addEventListener("keydown", (e) => {
  const card = e.key === "Enter" && !tk.editor && !tk.abierto && e.target.closest(".tk-card");
  if (card) tkAbre(+card.dataset.id);
});
$("tkNew").addEventListener("click", () => tkEditor(null));
```

(`tkEditor`, `tkPintaEditor` y `tkAccionEditor` llegan en la Tarea 8; hasta entonces, pulsar «New take» falla en
consola. No hacer push entre las tareas 7 y 8.)

- [ ] **Step 4: Comprobar sintaxis**

Run: `node --check web/takes.js; node --check web/app.js`
Expected: sin salida.

- [ ] **Step 5: Commit**

```bash
git add web/index.html web/app.js web/takes.js
git commit -m "Takes: pagina con listado, filtro por etiquetas y detalle"
```

---

### Task 8: Editor

**Files:**
- Modify: `web/takes.js` (añadir al final)

- [ ] **Step 1: Añadir el editor al final de `web/takes.js`**

```js
/* ------------------------------------------------------------ editor (admin y autores de borradores) */
const TK_MB = 20 * 1024 * 1024;
const TK_TIPOS = { "application/pdf": "pdf", "image/png": "imagen", "image/jpeg": "imagen", "image/webp": "imagen" };

function tkEditor(t) {
  tk.editor = t ? {
    id: t.id, titulo: t.titulo, cuerpo: t.cuerpo, etiquetas: [...t.etiquetas], vista: "write", msg: "", guardando: false,
    adjuntos: t.adjuntos.map((a) => ({ id: a.id, tipo: a.tipo, url: a.url || "", titulo: a.titulo, texto: a.texto, fuente: a.fuente, src: a.src })),
  } : { id: null, titulo: "", cuerpo: "", etiquetas: [], adjuntos: [], vista: "write", msg: "", guardando: false };
  renderTakes(); window.scrollTo(0, 0);
}

function tkCampoAdj(a, i) {
  const f = (k, ph, val, area) => area
    ? `<textarea data-adj="${i}" data-k="${k}" rows="3" placeholder="${ph}">${esc(val || "")}</textarea>`
    : `<input data-adj="${i}" data-k="${k}" placeholder="${ph}" value="${esc(val || "")}">`;
  let cuerpo;
  if (a.tipo === "enlace") cuerpo = f("url", "https://…", a.url) + f("titulo", "Title (optional: the domain is shown)", a.titulo) + f("texto", "Note (optional)", a.texto);
  else if (a.tipo === "cita") cuerpo = f("texto", "Quoted text", a.texto, true) + f("fuente", "Source (author or research house)", a.fuente) + f("url", "Link to the original (optional)", a.url);
  else cuerpo = `<span class="tk-file">${esc(a.file ? a.file.name : a.titulo)}</span>` + f("titulo", "Title", a.titulo) + f("texto", a.tipo === "imagen" ? "Caption (optional)" : "Note (optional)", a.texto);
  return `<div class="tk-ed-adj"><div class="tk-ed-adj-h"><span class="tk-kind">${TK_ICON[a.tipo]}</span>
    <span class="tk-actions"><button class="ghost" data-tk="subir" data-i="${i}" aria-label="Move up"${i ? "" : " disabled"}>↑</button><button class="ghost" data-tk="bajar" data-i="${i}" aria-label="Move down"${i < tk.editor.adjuntos.length - 1 ? "" : " disabled"}>↓</button><button class="ghost" data-tk="quitar" data-i="${i}" aria-label="Remove attachment">×</button></span></div>${cuerpo}</div>`;
}

function tkPintaEditor() {
  const ed = tk.editor;
  const todas = [...new Set((tk.lista || []).flatMap((t) => t.etiquetas))];
  const hayPdf = ed.adjuntos.some((a) => a.tipo === "pdf");
  $("tkBody").innerHTML = `<form class="tk-editor" id="tkForm" novalidate>
    <div class="tk-detail-bar"><button type="button" class="ghost" data-tk="cancelar">‹ Cancel</button><span class="tk-actions">
      <button type="submit" class="ghost tk-primary"${ed.guardando ? " disabled" : ""}>${ed.guardando ? "Saving…" : "Save draft"}</button></span></div>
    <input class="tk-ed-title" id="tkEdTitulo" placeholder="Title (optional)" maxlength="200" value="${esc(ed.titulo)}">
    <div class="seg tk-ed-tabs" role="radiogroup" aria-label="Editor view"><button type="button" role="radio" data-tk="write" aria-checked="${ed.vista === "write"}">Write</button><button type="button" role="radio" data-tk="preview" aria-checked="${ed.vista === "preview"}">Preview</button></div>
    ${ed.vista === "write"
      ? `<textarea class="tk-ed-body" id="tkEdCuerpo" rows="14" placeholder="Write in Markdown: # title, **bold**, *italic*, - lists, > quotes, [text](https://…). Paste an image to attach it.">${esc(ed.cuerpo)}</textarea>`
      : `<div class="tk-md tk-ed-preview">${tkMarkdown(ed.cuerpo) || '<p class="tk-faint">Nothing to preview.</p>'}</div>`}
    <div class="tk-ed-tags">${ed.etiquetas.map((e, i) => `<span class="tk-tag">${esc(e)}<button type="button" data-tk="sintag" data-i="${i}" aria-label="Remove tag ${esc(e)}">×</button></span>`).join("")}
      <input id="tkEdTag" list="tkEdTags" placeholder="Add tag and press Enter" maxlength="30"><datalist id="tkEdTags">${todas.map((e) => `<option value="${esc(e)}">`).join("")}</datalist></div>
    <div class="tk-ed-adjs">${ed.adjuntos.map(tkCampoAdj).join("")}</div>
    ${hayPdf ? `<p class="tk-warn">Only upload PDFs you own or that are freely shareable. For paid research, quote a short excerpt and link to the source.</p>` : ""}
    <div class="tk-ed-add" id="tkDrop">
      <button type="button" class="ghost" data-tk="addlink">+ Link</button><button type="button" class="ghost" data-tk="addquote">+ Quote</button>
      <label class="ghost tk-filebtn">+ File<input type="file" id="tkFile" accept="application/pdf,image/png,image/jpeg,image/webp" multiple hidden></label>
      <span class="tk-faint">or drop PDFs and images here (20 MB max each)</span>
    </div>
    <p class="tk-msg${ed.msg ? " on" : ""}" role="status">${esc(ed.msg)}</p>
  </form>`;
}

function tkLeeCampos() {   // copia lo escrito al estado antes de repintar
  const ed = tk.editor; if (!ed) return;
  const t = $("tkEdTitulo"), c = $("tkEdCuerpo");
  if (t) ed.titulo = t.value;
  if (c) ed.cuerpo = c.value;
}

function tkAnadeArchivos(files) {
  const ed = tk.editor; if (!ed) return;
  const malos = [];
  for (const f of files) {
    const tipo = TK_TIPOS[f.type];
    if (!tipo) { malos.push(`${f.name}: PDF, PNG, JPEG or WebP only`); continue; }
    if (f.size > TK_MB) { malos.push(`${f.name}: 20 MB max`); continue; }
    ed.adjuntos.push({ id: null, tipo, file: f, url: "", titulo: f.name.replace(/\.[a-z0-9]+$/i, ""), texto: "", fuente: "" });
  }
  ed.msg = malos.join(". ");
  tkLeeCampos(); tkPintaEditor();
}

function tkAccionEditor(a, b) {
  const ed = tk.editor; if (!ed) return;
  tkLeeCampos();
  const i = +b.dataset.i, L = ed.adjuntos;
  if (a === "cancelar") { tk.editor = null; renderTakes(); return; }   // vuelve al detalle (si se editaba) o al listado
  if (a === "write" || a === "preview") ed.vista = a;
  else if (a === "addlink") L.push({ id: null, tipo: "enlace", url: "", titulo: "", texto: "", fuente: "" });
  else if (a === "addquote") L.push({ id: null, tipo: "cita", url: "", titulo: "", texto: "", fuente: "" });
  else if (a === "quitar") L.splice(i, 1);
  else if (a === "subir" && i > 0) [L[i - 1], L[i]] = [L[i], L[i - 1]];
  else if (a === "bajar" && i < L.length - 1) [L[i + 1], L[i]] = [L[i], L[i + 1]];
  else if (a === "sintag") ed.etiquetas.splice(i, 1);
  else return;
  tkPintaEditor();
}

async function tkGuarda() {
  const ed = tk.editor;
  tkLeeCampos();
  const fd = new FormData();
  let n = 0;
  const adjuntos = ed.adjuntos.map((a) => {
    const x = { tipo: a.tipo, url: a.url, titulo: a.titulo, texto: a.texto, fuente: a.fuente };
    if (a.id != null) x.id = a.id;
    if (a.file) { x.archivo = "archivo" + n; fd.append(x.archivo, a.file, a.file.name); n++; }
    return x;
  });
  fd.append("datos", JSON.stringify({ titulo: ed.titulo, cuerpo: ed.cuerpo, etiquetas: ed.etiquetas, adjuntos }));
  ed.guardando = true; ed.msg = ""; tkPintaEditor();
  try {
    const r = await fetch(ed.id ? `/api/takes/${ed.id}` : "/api/takes", { method: ed.id ? "PUT" : "POST", body: fd });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `Error ${r.status}`);
    tk.editor = null;
    await tkAbre(d.id, false);
    await loadTakes();
  } catch (e) {
    ed.guardando = false; ed.msg = e.message; tkPintaEditor();
  }
}

$("tkBody").addEventListener("submit", (e) => { if (e.target.id === "tkForm") { e.preventDefault(); tkGuarda(); } });
$("tkBody").addEventListener("input", (e) => {   // campos de adjuntos: al estado sin repintar (no se pierde el foco)
  const el = e.target;
  if (tk.editor && el.dataset.adj != null) tk.editor.adjuntos[+el.dataset.adj][el.dataset.k] = el.value;
});
$("tkBody").addEventListener("change", (e) => {
  if (e.target.id === "tkFile") { tkAnadeArchivos([...e.target.files]); e.target.value = ""; }
});
$("tkBody").addEventListener("keydown", (e) => {
  if (e.target.id !== "tkEdTag" || (e.key !== "Enter" && e.key !== ",")) return;
  e.preventDefault();
  const v = e.target.value.trim().replace(/,+$/, "");
  const ed = tk.editor;
  if (v && !ed.etiquetas.some((x) => x.toLowerCase() === v.toLowerCase())) {
    if (ed.etiquetas.length >= 10) ed.msg = "10 tags max";
    else ed.etiquetas.push(v.slice(0, 30));
  }
  tkLeeCampos(); tkPintaEditor(); $("tkEdTag").focus();
});
$("tkBody").addEventListener("paste", (e) => {
  if (!tk.editor) return;
  const files = [...(e.clipboardData ? e.clipboardData.files : [])].filter((f) => TK_TIPOS[f.type]);
  if (files.length) { e.preventDefault(); tkAnadeArchivos(files); }
});
$("tkBody").addEventListener("dragover", (e) => { if (tk.editor) { e.preventDefault(); $("tkDrop").classList.add("on"); } });
$("tkBody").addEventListener("dragleave", (e) => { if (tk.editor && e.target.id === "tkDrop") $("tkDrop").classList.remove("on"); });
$("tkBody").addEventListener("drop", (e) => {
  if (!tk.editor) return;
  e.preventDefault();
  tkAnadeArchivos([...e.dataTransfer.files]);
});
```

Nota sobre el `keydown` del listado (Tarea 7) y el del editor: son dos manejadores distintos sobre `#tkBody` y no
chocan (uno mira `.tk-card`, el otro `#tkEdTag`).

- [ ] **Step 2: Comprobar sintaxis**

Run: `node --check web/takes.js`
Expected: sin salida.

- [ ] **Step 3: Commit**

```bash
git add web/takes.js
git commit -m "Takes: editor con adjuntos, etiquetas, vista previa, pegar y arrastrar"
```

---

### Task 9: Estilos `web/takes.css`

**Files:**
- Create: `web/takes.css`

Se reutilizan clases que ya existen: `.ghost` (botones, `styles.css` y `sg.css`), `.seg` con `aria-checked`
(segmentos) y `.scan-bar` (barra superior). `.empty` solo tiene estilo dentro de otros contenedores: se le da uno
propio con `.tk-body .empty`.

- [ ] **Step 1: Crear `web/takes.css`**

```css
/* GEX Lab - Founder Takes (takes.js). Pagina de lectura: columna de texto comoda, tarjetas sobrias.
   Solo tokens del tema (sg.css y tema.css): igual en claro y en oscuro. Clases con prefijo tk-. */
.tk-bar { display: flex; gap: 10px; align-items: center; }
.tk-q { flex: 1; max-width: 420px; padding: 7px 12px; border-radius: 10px; border: 1px solid var(--line);
  background: var(--surface); color: var(--text); font: inherit; }
.tk-q:focus-visible, .tk-editor input:focus-visible, .tk-editor textarea:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
.tk-primary { margin-left: auto; color: var(--accent); border-color: var(--accent); }
.tk-tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0; }
.tk-tags:empty { display: none; }
.tk-body .empty { color: var(--faint); padding: 40px; text-align: center; max-width: 820px; }
.tk-chip { padding: 4px 10px; border-radius: 999px; border: 1px solid var(--line); background: var(--btn); color: var(--muted);
  font: inherit; font-size: 12.5px; cursor: pointer; }
.tk-chip span { color: var(--faint); font-variant-numeric: tabular-nums; }
.tk-chip:hover { background: var(--btn-hover); }
.tk-chip.on { background: var(--accent-soft); border-color: var(--accent); color: var(--text); }

.tk-list { display: grid; gap: 12px; max-width: 820px; margin-bottom: 32px; }
.tk-card { padding: 16px 18px; border-radius: 14px; border: 1px solid var(--line); background: var(--surface); cursor: pointer; }
.tk-card:hover { border-color: var(--line-strong); }
.tk-card:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.tk-card h3 { margin: 6px 0 4px; font-size: 16px; font-weight: 600; color: var(--text); }
.tk-card p { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.5; }
.tk-meta { display: flex; gap: 10px; align-items: center; color: var(--faint); font-size: 12.5px; }
.tk-draft { padding: 1px 8px; border-radius: 999px; border: 1px solid var(--amber); color: var(--amber); font-size: 11.5px; }
.tk-foot { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.tk-tag { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px; background: var(--surface-2);
  color: var(--muted); font-size: 12px; }
.tk-tag button { border: 0; background: none; color: var(--faint); cursor: pointer; padding: 0 2px; font: inherit; }
.tk-kind { padding: 2px 8px; border-radius: 6px; border: 1px solid var(--line); color: var(--faint); font-size: 11.5px; }

.tk-detail, .tk-editor { max-width: 760px; margin-bottom: 40px; }
.tk-detail-bar { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 14px; }
.tk-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.tk-danger { color: var(--neg); }
.tk-detail h1 { margin: 8px 0 6px; font-size: 26px; line-height: 1.25; font-weight: 600; color: var(--text); }
.tk-md { color: var(--text); font-size: 15.5px; line-height: 1.65; margin-top: 16px; overflow-wrap: anywhere; }
.tk-md h2 { font-size: 20px; margin: 22px 0 8px; }
.tk-md h3 { font-size: 17px; margin: 18px 0 6px; }
.tk-md h4 { font-size: 15.5px; margin: 16px 0 6px; }
.tk-md p, .tk-md ul, .tk-md ol { margin: 0 0 12px; }
.tk-md a { color: var(--accent); }
.tk-md code { padding: 1px 5px; border-radius: 5px; background: var(--surface-2); font-size: .92em; }
.tk-md blockquote, .tk-quote { margin: 0 0 14px; padding: 4px 0 4px 14px; border-left: 3px solid var(--accent); color: var(--muted); }
.tk-quote footer { margin-top: 6px; font-size: 13px; color: var(--faint); }
.tk-quote a { color: var(--accent); }

.tk-adjs { display: grid; gap: 10px; margin-top: 20px; }
.tk-adj { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 4px 12px; padding: 12px 14px; border-radius: 12px;
  border: 1px solid var(--line); background: var(--surface); color: var(--text); text-decoration: none; }
a.tk-adj:hover { border-color: var(--line-strong); }
.tk-adj-t { font-weight: 600; overflow-wrap: anywhere; }
.tk-adj-d { color: var(--faint); font-size: 12.5px; }
.tk-adj-n { grid-column: 2 / -1; color: var(--muted); font-size: 14px; }
.tk-open { text-decoration: none; }
.tk-img { margin: 0; }
.tk-img img { display: block; max-width: 100%; height: auto; border-radius: 12px; border: 1px solid var(--line); }
.tk-img figcaption { margin-top: 6px; color: var(--faint); font-size: 13px; }

.tk-editor input, .tk-editor textarea { width: 100%; box-sizing: border-box; padding: 8px 12px; border-radius: 10px;
  border: 1px solid var(--line); background: var(--surface); color: var(--text); font: inherit; }
.tk-ed-title { font-size: 18px; font-weight: 600; margin-bottom: 10px; }
.tk-ed-tabs { margin-bottom: 8px; }
.tk-ed-body { min-height: 260px; resize: vertical; line-height: 1.55; }
.tk-ed-preview { min-height: 260px; padding: 8px 12px; border-radius: 10px; border: 1px dashed var(--line); margin-top: 0; }
.tk-ed-tags { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 12px 0; }
.tk-ed-tags input { width: auto; flex: 1; min-width: 180px; }
.tk-ed-adjs { display: grid; gap: 10px; }
.tk-ed-adj { display: grid; gap: 6px; padding: 12px; border-radius: 12px; border: 1px solid var(--line); background: var(--surface-2); }
.tk-ed-adj-h { display: flex; justify-content: space-between; align-items: center; }
.tk-file { color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
.tk-ed-add { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 12px; padding: 12px; border-radius: 12px;
  border: 1px dashed var(--line); }
.tk-ed-add.on { border-color: var(--accent); background: var(--accent-soft); }
.tk-filebtn { cursor: pointer; }
.tk-faint { color: var(--faint); font-size: 13px; }
.tk-warn { margin: 10px 0 0; padding: 8px 12px; border-radius: 10px; border: 1px solid var(--amber); color: var(--amber); font-size: 13px; }
.tk-msg { min-height: 1.4em; margin: 10px 0 0; color: var(--neg); font-size: 13.5px; }
.tk-msg:not(.on) { visibility: hidden; }

@media (max-width: 640px) {
  .tk-q { max-width: none; }
  .tk-card { padding: 14px; }
  .tk-detail h1 { font-size: 22px; }
  .tk-adj { grid-template-columns: 1fr; }
  .tk-adj-n { grid-column: 1; }
}
```

- [ ] **Step 2: Probar en local que la página aparece y avisa de «solo en la nube»**

Arrancar el servidor local con la configuración de `.claude/launch.json` (o crearla con
`.venv\Scripts\python.exe server.py`, puerto 8765) mediante `preview_start`. Abrir Research → Takes.
Expected: la página muestra «Founder Takes are available in the cloud version.» sin errores en consola, en tema
oscuro y claro.

- [ ] **Step 3: Commit**

```bash
git add web/takes.css
git commit -m "Takes: estilos en los dos temas y movil"
```

---

### Task 10: Documentación, push y verificación en producción

**Files:**
- Modify: `docs/ARQUITECTURA.md`, `CLAUDE.md`, `CHANGELOG.md`, `docs/ESTADO.md`

- [ ] **Step 1: Documentar**

- `docs/ARQUITECTURA.md`: en la parte del Worker y D1, un apartado «Founder Takes» con las tres tablas, las rutas
  `/api/takes*` y quién puede usarlas (tabla de permisos del spec), la clave de R2 `takes/<take_id>/<24 hex>.<ext>`,
  y que `nube/takes.js` lo importa `worker.js` (wrangler lo empaqueta). Pruebas: `node --test pruebas/test_takes.mjs`.
- `CLAUDE.md`, sección Mapa, tras la línea de `web/`: añadir `takes.js`/`takes-md.js`/`takes.css` (Founder Takes) a
  la lista de `web/`, y `nube/takes.js` junto a `nube/worker.js`. En Comandos, `node --test pruebas/test_takes.mjs`.
- `docs/ESTADO.md`: en ideas, «Founder Takes, siguientes pasos posibles: tarjeta en Summary, Takes por ticker,
  avisos; decidir cuando haya 30-40 entradas qué etiquetas merecen filtro propio».
- `CHANGELOG.md`: entrada de 2026-11-13 (o ampliar la del día si ya existe), sección Añadido: página Founder Takes
  (texto Markdown, etiquetas, enlaces, citas, PDFs e imágenes; borradores y publicación por el admin; permiso de
  borradores en `/admin`). Sección Cambiado: las escrituras PUT y DELETE también exigen el mismo origen.

- [ ] **Step 2: Comprobación final**

Run: `node --test pruebas/test_takes.mjs; node --check nube/worker.js; node --check nube/takes.js; node --check web/takes.js; node --check web/takes-md.js; node --check web/app.js; node --check web/admin.js`
Expected: `# fail 0` y ningún error de sintaxis.

- [ ] **Step 3: Commit de docs**

```bash
git add docs/ARQUITECTURA.md CLAUDE.md CHANGELOG.md docs/ESTADO.md
git commit -m "Takes: documentacion y changelog"
```

- [ ] **Step 4: Pedir permiso al usuario y hacer push**

Preguntar al usuario antes. Con su sí: `git push origin main`. El push lanza `desplegar.yml`, que aplica
`schema.sql` (tablas nuevas) y despliega. Vigilar el run:
`gh api repos/LoppVicious/gexlab/actions/workflows/desplegar.yml/runs?per_page=1 --jq ".workflow_runs[0] | {status, conclusion, html_url}"`
Expected: `conclusion: success`.

- [ ] **Step 5: Verificar en producción (navegador integrado, cuenta `Claude`)**

Pedir al usuario: en `/admin`, «Allow drafts» para `claude`; recargar con Ctrl+F5. Después, en
https://dashboard.gexlab.workers.dev con la sesión de `Claude`:

1. Research → Takes: lista vacía, botón «New take» visible.
2. Crear un borrador con cuerpo Markdown (título, lista, cita, enlace suelto), etiquetas `test` y `SPX`, un enlace,
   una cita, una imagen PNG pequeña (generar en el scratchpad) y un PDF mínimo. Guardar: se abre el detalle con todo
   pintado; la imagen carga; «Open PDF» abre el visor.
3. Cuerpo con `<script>alert(1)</script>`, `<img src=x onerror=alert(1)>` y `[x](javascript:alert(1))`: se ven como
   texto (comprobar con `read_page` que no hay `<script>` ni `href="javascript:`).
4. Con `javascript_tool`, comprobar los rechazos (cada uno devuelve 400 con mensaje):
   - un archivo `logo.svg` como imagen;
   - un `fake.pdf` con bytes de PNG;
   - un enlace `javascript:alert(1)`.
5. Permisos con `javascript_tool`: `POST /api/takes/<id>/estado` → 403; `DELETE /api/takes/<id>` → 403.
6. Pedir al usuario que, como admin, cree un borrador propio y anote su id: `GET /api/takes/<ese id>` desde `Claude`
   → 404; su archivo → 404. Que lo publique: ahora → 200 y aparece en la lista.
7. Que el usuario publique el borrador de `Claude` y lo borre después; comprobar que `GET` de sus archivos da 404.
8. Capturas del listado, detalle y editor en tema oscuro y claro, y en móvil (`resize_window` preset mobile;
   volver a desktop al acabar).

Anotar cualquier fallo, corregir con su propio commit (con CHANGELOG ampliado) y repetir la verificación del punto
afectado.
