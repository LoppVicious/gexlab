// Pruebas de las rutas /api/takes* de nube/takes.js con el esquema real: D1 imitado con node:sqlite y R2 con un Map.
// Ejecutar: node --test pruebas/test_takes_api.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { takes } from "../nube/takes.js";

function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../nube/schema.sql", import.meta.url), "utf8"));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
  });
  return { db, prepare: (sql) => stmt(sql), batch: async (ss) => { const out = []; for (const s of ss) out.push(await s.run()); return out; } };
}

function r2() {
  const m = new Map();
  return {
    m,
    put: async (k, v, o) => { m.set(k, { bytes: v, ct: o.httpMetadata.contentType }); },
    get: async (k) => (m.has(k) ? { body: m.get(k).bytes, httpMetadata: { contentType: m.get(k).ct } } : null),
    delete: async (ks) => { for (const k of [].concat(ks)) m.delete(k); },
  };
}

const json = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: { "Content-Type": "application/json" } });
const body = async (req) => JSON.parse(await req.text());
const h = { json, body, SEC_HEADERS: { "X-Content-Type-Options": "nosniff" } };
const ADMIN = { user: "boss", admin: true }, CLAUDE = { user: "claude", admin: false }, LECTOR = { user: "reader", admin: false };
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function llama(env, me, method, path, data, files = []) {
  const url = new URL("https://x.test" + path);
  let init = { method };
  if (path.endsWith("/estado")) init = { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) };
  else if (data !== undefined) {   // como el editor: multipart con "datos" y los archivos
    const fd = new FormData();
    fd.append("datos", JSON.stringify(data));
    files.forEach(([k, name, bytes]) => fd.append(k, new Blob([bytes]), name));
    init.body = fd;
  }
  const req = new Request(url, init);
  try {
    const r = await takes(req, env, url, me, h);
    if (!r) return { status: 404, d: null };
    const ct = r.headers.get("Content-Type") || "";
    return { status: r.status, d: ct.includes("json") ? await r.json() : r, headers: r.headers };
  } catch (e) { return { status: 400, d: { error: e.message } }; }   // como el catch de worker.js
}

function entorno() {
  const env = { DB: d1(), R2: r2() };
  env.DB.db.exec("INSERT INTO takes_autores (usuario) VALUES ('claude')");
  return env;
}

test("un autor crea un borrador con adjuntos; el lector no lo ve hasta que el admin publica", async () => {
  const env = entorno();
  const c = await llama(env, CLAUDE, "POST", "/api/takes", {
    titulo: "Weekly", cuerpo: "Body **bold**", etiquetas: ["SPX", "test"],
    adjuntos: [{ tipo: "enlace", url: "https://x.com/a/status/1" }, { tipo: "pdf", archivo: "archivo0" }, { tipo: "imagen", archivo: "archivo1" }],
  }, [["archivo0", "doc.pdf", PDF], ["archivo1", "chart.png", PNG]]);
  assert.equal(c.status, 200, JSON.stringify(c.d));
  const id = c.d.id;
  assert.equal(env.R2.m.size, 2);

  assert.equal((await llama(env, LECTOR, "GET", `/api/takes/${id}`)).status, 404);
  assert.equal((await llama(env, LECTOR, "GET", "/api/takes")).d.takes.length, 0);
  const det = await llama(env, CLAUDE, "GET", `/api/takes/${id}`);
  assert.equal(det.d.adjuntos.length, 3);
  assert.equal(det.d.puede.editar, true);
  const src = det.d.adjuntos[1].src;
  assert.match(src, /^\/api\/takes\/archivo\/\d+\/[0-9a-f]{24}\.pdf$/);
  assert.equal((await llama(env, LECTOR, "GET", src)).status, 404);

  assert.equal((await llama(env, CLAUDE, "POST", `/api/takes/${id}/estado`, { estado: "publicado" })).status, 403);
  assert.equal((await llama(env, CLAUDE, "DELETE", `/api/takes/${id}`)).status, 403);
  assert.equal((await llama(env, ADMIN, "POST", `/api/takes/${id}/estado`, { estado: "publicado" })).status, 200);

  const lista = await llama(env, LECTOR, "GET", "/api/takes");
  assert.equal(lista.d.takes.length, 1);
  assert.equal(lista.d.puede.escribir, false);
  assert.equal(lista.d.takes[0].extracto, "Body bold");
  const f = await llama(env, LECTOR, "GET", src);
  assert.equal(f.status, 200);
  assert.equal(f.headers.get("Content-Type"), "application/pdf");
  assert.equal(f.headers.get("Content-Disposition"), "inline");

  // publicado: el autor ya no puede editarlo
  assert.equal((await llama(env, CLAUDE, "PUT", `/api/takes/${id}`, { cuerpo: "changed" })).status, 403);
});

test("el lector no puede escribir y los borradores del admin no se ven desde otra cuenta", async () => {
  const env = entorno();
  assert.equal((await llama(env, LECTOR, "POST", "/api/takes", { cuerpo: "x" })).status, 403);
  const a = await llama(env, ADMIN, "POST", "/api/takes", { cuerpo: "admin draft", adjuntos: [{ tipo: "imagen", archivo: "archivo0" }] }, [["archivo0", "a.png", PNG]]);
  const src = (await llama(env, ADMIN, "GET", `/api/takes/${a.d.id}`)).d.adjuntos[0].src;
  assert.equal((await llama(env, CLAUDE, "GET", `/api/takes/${a.d.id}`)).status, 404);
  assert.equal((await llama(env, CLAUDE, "GET", src)).status, 404);
  assert.equal((await llama(env, CLAUDE, "PUT", `/api/takes/${a.d.id}`, { cuerpo: "hijack" })).status, 404);
});

test("editar conserva adjuntos por id, borra de R2 los quitados y borrar el Take limpia todo", async () => {
  const env = entorno();
  const c = await llama(env, ADMIN, "POST", "/api/takes", {
    cuerpo: "x", adjuntos: [{ tipo: "pdf", archivo: "archivo0" }, { tipo: "imagen", archivo: "archivo1" }],
  }, [["archivo0", "a.pdf", PDF], ["archivo1", "b.png", PNG]]);
  const id = c.d.id;
  const [pdf, img] = (await llama(env, ADMIN, "GET", `/api/takes/${id}`)).d.adjuntos;
  const e = await llama(env, ADMIN, "PUT", `/api/takes/${id}`, { titulo: "Edited", cuerpo: "y", adjuntos: [{ id: img.id, titulo: "Chart" }] });
  assert.equal(e.status, 200, JSON.stringify(e.d));
  const det = (await llama(env, ADMIN, "GET", `/api/takes/${id}`)).d;
  assert.equal(det.titulo, "Edited");
  assert.ok(det.editado);
  assert.deepEqual(det.adjuntos.map((a) => [a.tipo, a.titulo]), [["imagen", "Chart"]]);
  assert.equal(det.adjuntos[0].src, img.src);
  assert.equal(env.R2.m.size, 1);
  assert.equal((await llama(env, ADMIN, "GET", pdf.src)).status, 404);

  assert.equal((await llama(env, ADMIN, "DELETE", `/api/takes/${id}`)).status, 200);
  assert.equal(env.R2.m.size, 0);
  assert.equal((await llama(env, ADMIN, "GET", `/api/takes/${id}`)).status, 404);
  assert.equal((await llama(env, ADMIN, "DELETE", `/api/takes/${id}`)).status, 404);
});

test("publicar fija la fecha una vez; despublicar la conserva", async () => {
  const env = entorno();
  const id = (await llama(env, ADMIN, "POST", "/api/takes", { cuerpo: "x" })).d.id;
  await llama(env, ADMIN, "POST", `/api/takes/${id}/estado`, { estado: "publicado" });
  const p1 = (await llama(env, ADMIN, "GET", `/api/takes/${id}`)).d.publicado;
  assert.ok(p1);
  await llama(env, ADMIN, "POST", `/api/takes/${id}/estado`, { estado: "borrador" });
  await llama(env, ADMIN, "POST", `/api/takes/${id}/estado`, { estado: "publicado" });
  assert.equal((await llama(env, ADMIN, "GET", `/api/takes/${id}`)).d.publicado, p1);
  assert.equal((await llama(env, ADMIN, "POST", `/api/takes/${id}/estado`, { estado: "otro" })).status, 400);
});

test("rechazos: SVG, PDF falso, enlace javascript y rutas de archivo raras", async () => {
  const env = entorno();
  const svg = new TextEncoder().encode("<svg></svg>");
  const r1 = await llama(env, ADMIN, "POST", "/api/takes", { cuerpo: "x", adjuntos: [{ tipo: "imagen", archivo: "archivo0" }] }, [["archivo0", "logo.svg", svg]]);
  assert.equal(r1.status, 400); assert.match(r1.d.error, /Unsupported file/);
  const r2_ = await llama(env, ADMIN, "POST", "/api/takes", { cuerpo: "x", adjuntos: [{ tipo: "pdf", archivo: "archivo0" }] }, [["archivo0", "fake.pdf", PNG]]);
  assert.equal(r2_.status, 400);
  const r3 = await llama(env, ADMIN, "POST", "/api/takes", { cuerpo: "x", adjuntos: [{ tipo: "enlace", url: "javascript:alert(1)" }] });
  assert.equal(r3.status, 400); assert.match(r3.d.error, /Invalid link/);
  assert.equal((await llama(env, ADMIN, "GET", "/api/takes")).d.takes.length, 0);   // nada a medias
  assert.equal((await llama(env, ADMIN, "GET", "/api/takes/archivo/1/config.json")).status, 400);
  assert.equal((await llama(env, ADMIN, "GET", "/api/takes/archivo/../config/config.json")).status, 404);   // la URL ya quita el ..
  assert.equal(env.R2.m.size, 0);
});
