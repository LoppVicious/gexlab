// Pruebas de las rutas /api/social/* de nube/social.js con R2 imitado (Map). La autorizacion (admin o token) la
// decide worker.js y no se prueba aqui. Ejecutar: node --test pruebas/test_social_api.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { social, validarPiezas, largo } from "../nube/social.js";

function r2() {
  const m = new Map();
  const obj = (k) => ({ body: m.get(k), json: async () => JSON.parse(typeof m.get(k) === "string" ? m.get(k) : new TextDecoder().decode(m.get(k))) });
  return {
    m,
    put: async (k, v) => { m.set(k, v); },
    get: async (k) => (m.has(k) ? obj(k) : null),
    list: async ({ prefix, delimiter }) => {
      const keys = [...m.keys()].filter((k) => k.startsWith(prefix));
      if (!delimiter) return { objects: keys.map((key) => ({ key })), truncated: false };
      const pre = new Set(keys.map((k) => k.slice(prefix.length)).filter((r) => r.includes(delimiter)).map((r) => prefix + r.split(delimiter)[0] + delimiter));
      return { objects: [], delimitedPrefixes: [...pre], truncated: false };
    },
  };
}

const json = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: { "Content-Type": "application/json" } });
const body = async (req) => JSON.parse(await req.text());
const h = { json, body, SEC_HEADERS: { "X-Content-Type-Options": "nosniff" } };
const F = "2026-11-19";

function entorno() {
  const env = { R2: r2() };
  env.R2.m.set(`social/${F}/paquete.json`, JSON.stringify({ fecha: F }));
  env.R2.m.set(`social/2026-11-18/paquete.json`, JSON.stringify({ fecha: "2026-11-18" }));
  env.R2.m.set(`social/ultimo.json`, JSON.stringify({ fecha: F }));
  env.R2.m.set(`social/${F}/g/indices_niveles.png`, new Uint8Array([0x89, 0x50]));
  return env;
}
const pedir = (env, metodo, ruta, datos) => {
  const url = new URL("https://x" + ruta);
  return social(new Request(url, { method: metodo, body: datos === undefined ? undefined : JSON.stringify(datos) }), env, url, h);
};
const pieza = (o = {}) => ({ id: "indices", titulo: "Index levels", texto: "$SPX closed at 6,800.", graficos: ["indices_niveles"], ...o });

test("dias y paquete", async () => {
  const env = entorno();
  assert.deepEqual(await (await pedir(env, "GET", "/api/social/dias")).json(), { dias: [F, "2026-11-18"] });
  const r = await (await pedir(env, "GET", `/api/social/${F}`)).json();
  assert.equal(r.paquete.fecha, F);
  assert.equal(r.textos, null);
  assert.equal((await pedir(env, "GET", "/api/social/2026-11-17")).status, 404);
  assert.equal((await pedir(env, "GET", "/api/social/abc")).status, 400);
  const png = await pedir(env, "GET", `/api/social/${F}/g/indices_niveles.png`);
  assert.equal(png.headers.get("Content-Type"), "image/png");
  assert.equal((await pedir(env, "GET", `/api/social/${F}/g/../x.png`)).status, 404);
});

test("textos: guardar, marcar publicado y conservarlo al reescribir", async () => {
  const env = entorno();
  let r = await pedir(env, "PUT", `/api/social/${F}/textos`, { piezas: [pieza(), pieza({ id: "vix", graficos: [] })] });
  assert.equal(r.status, 200);
  r = await pedir(env, "POST", `/api/social/${F}/publicado`, { id: "vix", publicado: true });
  assert.ok((await r.json()).publicado);
  await pedir(env, "PUT", `/api/social/${F}/textos`, { piezas: [pieza({ texto: "New text" }), pieza({ id: "vix", graficos: [] })] });
  const t = (await (await pedir(env, "GET", `/api/social/${F}`)).json()).textos;
  assert.equal(t.piezas[0].texto, "New text");
  assert.equal(t.piezas[0].publicado, null);
  assert.ok(t.piezas[1].publicado);
  assert.equal((await pedir(env, "POST", `/api/social/${F}/publicado`, { id: "nada", publicado: true })).status, 404);
});

test("validacion de piezas", () => {
  const n = new Set(["indices_niveles"]);
  assert.throws(() => validarPiezas({ piezas: [] }, n), /non-empty/);
  assert.throws(() => validarPiezas({ piezas: [pieza({ texto: "x".repeat(281) })] }, n), /281 characters/);
  assert.equal(validarPiezas({ piezas: [pieza({ texto: "σ".repeat(280) })] }, n)[0].texto.length, 280);
  assert.throws(() => validarPiezas({ piezas: [pieza({ graficos: ["otro"] })] }, n), /chart not found/);
  assert.throws(() => validarPiezas({ piezas: [pieza(), pieza()] }, n), /repeated/);
  assert.throws(() => validarPiezas({ piezas: [pieza({ id: "Mal id" })] }, n), /invalid/);
  assert.equal(largo("1σ move"), 7);
});

test("textos rechazados", async () => {
  const env = entorno();
  const r = await pedir(env, "PUT", `/api/social/${F}/textos`, { piezas: [pieza({ texto: "x".repeat(300) })] });
  assert.equal(r.status, 400);
  assert.equal((await pedir(env, "PUT", "/api/social/2026-11-10/textos", { piezas: [pieza()] })).status, 404);
});
