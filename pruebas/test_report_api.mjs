// Pruebas de las rutas /api/report/* de nube/report.js: D1 imitado con node:sqlite y R2 con un Map.
// Ejecutar: node --test pruebas/test_report_api.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { report } from "../nube/report.js";

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
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const F = "2026-11-13";

function entorno(token = "secreto-de-prueba") {
  const env = { DB: d1(), R2: r2(), REPORT_TOKEN: token };
  const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
  env.R2.m.set(`report/${F}/paquete.json`, { bytes: enc({ fecha: F, bloques: {} }), ct: "application/json" });
  env.R2.m.set("report/ultimo.json", { bytes: enc({ fecha: F }), ct: "application/json" });
  env.R2.m.set(`report/${F}/g/gamma_spy.png`, { bytes: PNG, ct: "image/png" });
  env.R2.m.set(`report/${F}/g/falso.png`, { bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), ct: "image/png" });
  return env;
}

async function llama(env, method, path, data, token = "secreto-de-prueba") {
  const url = new URL("https://x.test" + path);
  const headers = { Authorization: `Bearer ${token}` };
  const init = { method, headers };
  if (data !== undefined) { headers["Content-Type"] = "application/json"; init.body = JSON.stringify(data); }
  try {
    const r = await report(new Request(url, init), env, url, h);
    const ct = r.headers.get("Content-Type") || "";
    return { status: r.status, ct, d: ct.includes("json") ? await r.json() : new Uint8Array(await r.arrayBuffer()) };
  } catch (e) { return { status: 400, d: { error: e.message } }; }   // como el catch de worker.js
}

test("sin secreto configurado o con token incorrecto: 404", async () => {
  assert.equal((await llama(entorno(""), "GET", `/api/report/${F}`)).status, 404);
  assert.equal((await llama(entorno(), "GET", `/api/report/${F}`, undefined, "otro")).status, 404);
});

test("lee el ultimo, el paquete y un grafico; valida fecha y nombre", async () => {
  const env = entorno();
  assert.deepEqual((await llama(env, "GET", "/api/report/ultimo")).d, { fecha: F });
  const p = await llama(env, "GET", `/api/report/${F}`);
  assert.equal(p.status, 200);
  assert.equal(p.d.fecha, F);
  const g = await llama(env, "GET", `/api/report/${F}/g/gamma_spy.png`);
  assert.equal(g.status, 200);
  assert.equal(g.ct, "image/png");
  assert.equal(g.d.length, PNG.length);
  assert.equal((await llama(env, "GET", "/api/report/2026-13")).status, 400);
  assert.equal((await llama(env, "GET", `/api/report/${F}/g/Mal-Nombre.png`)).status, 400);
  assert.equal((await llama(env, "GET", "/api/report/2026-11-06")).status, 404);
});

test("crea un borrador de claude con los graficos copiados a takes/", async () => {
  const env = entorno();
  const r = await llama(env, "POST", `/api/report/${F}/take`, {
    titulo: "Weekly: test", cuerpo: "Body", etiquetas: ["Weekly", "Auto"],
    graficos: [{ nombre: "gamma_spy", titulo: "SPY gamma", nota: "Spot vs levels" }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const t = env.DB.db.prepare("SELECT * FROM takes WHERE id = ?").get(r.d.id);
  assert.equal(t.estado, "borrador");
  assert.equal(t.autor, "claude");
  const a = env.DB.db.prepare("SELECT * FROM takes_adjuntos WHERE take_id = ?").all(r.d.id);
  assert.equal(a.length, 1);
  assert.equal(a[0].tipo, "imagen");
  assert.equal(a[0].texto, "Spot vs levels");
  assert.match(a[0].r2, new RegExp(`^takes/${r.d.id}/[0-9a-f]{24}\\.png$`));
  assert.ok(env.R2.m.has(a[0].r2));
});

test("un PNG falso o un grafico que no existe no crean nada", async () => {
  const env = entorno();
  const falso = await llama(env, "POST", `/api/report/${F}/take`, { titulo: "x", cuerpo: "y", graficos: [{ nombre: "falso" }] });
  assert.equal(falso.status, 400);
  assert.match(falso.d.error, /Unsupported file/);
  const no = await llama(env, "POST", `/api/report/${F}/take`, { titulo: "x", cuerpo: "y", graficos: [{ nombre: "no_existe" }] });
  assert.equal(no.status, 404);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM takes").get().n, 0);
});
