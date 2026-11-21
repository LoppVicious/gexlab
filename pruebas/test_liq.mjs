// Pruebas sin red del modelo del mapa de liquidaciones (web/liq-modelo.js). Uso: node --test pruebas/test_liq.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const M = require("../web/liq-modelo.js");

const vela = (t, p, extra = {}) => ({ t, o: p, h: p * 1.001, l: p * 0.999, c: p, v: 100, bv: 50, ...extra });

test("un largo a 10x se liquida cuando el precio cae un 10 % y cuenta como liquidacion prevista", () => {
  const velas = [vela(0, 100), vela(1, 100, { v: 100, bv: 100 })];   // en la vela 1 todo el volumen es comprador
  for (let i = 2; i < 30; i++) velas.push(vela(i, 100));
  velas.push({ t: 30, o: 100, h: 100, l: 85, c: 86, v: 100, bv: 50 });   // caida al 85
  const oi = velas.map((_, i) => (i >= 1 ? 1000 : 0));
  oi[0] = 0;
  const r = M.calcular(velas, oi, { levs: [{ L: 10, w: 1 }], vida: 1e9, mm: 0 });
  assert.ok(r.predL[30] > 999 && r.predL[30] < 1001, `prevista ${r.predL[30]}`);   // 1.000 USD de largos a 90
  assert.equal(r.predS.reduce((a, b) => a + b, 0), 0);   // sin cortos: bv = v en la vela 1
  const vivoAntes = r.gL.filter((_, k) => k % r.n === 29).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(vivoAntes - 1000) < 1e-6);
  assert.ok(r.finL.reduce((a, b) => a + b, 0) < 1e-6);   // ya no queda nada vivo
});

test("cuando baja el OI los niveles se reducen en proporcion y la vida media los apaga", () => {
  const velas = Array.from({ length: 10 }, (_, i) => vela(i, 100));
  const oi = [0, 1000, 1000, 500, 500, 500, 500, 500, 500, 500];
  const r = M.calcular(velas, oi, { levs: [{ L: 2, w: 1 }], vida: 1e9 });
  const vivo = (t) => { let s = 0; for (let b = 0; b < r.B; b++) s += r.gL[b * r.n + t] + r.gS[b * r.n + t]; return s; };
  assert.ok(Math.abs(vivo(2) - 1000) < 1e-6 && Math.abs(vivo(3) - 500) < 1e-6);
  const r2 = M.calcular(velas, [0, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000], { levs: [{ L: 2, w: 1 }], vida: 2 });
  let s = 0; for (let b = 0; b < r2.B; b++) s += r2.gL[b * r2.n + 3] + r2.gS[b * r2.n + 3];
  assert.ok(Math.abs(s - 500) < 1e-6);   // dos velas despues, la mitad
});

test("sin OI se usa el volumen calibrado con el tramo que si lo tiene", () => {
  const velas = Array.from({ length: 20 }, (_, i) => vela(i, 100));
  const oi = velas.map((_, i) => (i < 10 ? null : 1000 + (i - 10) * 100));
  const r = M.calcular(velas, oi, { levs: [{ L: 10, w: 1 }] });
  assert.equal(r.desdeOI, 10);
  assert.ok(r.calibrado && Math.abs(r.k - 100 / (100 * 100)) < 1e-9);   // 100 USD de OI nuevo por 10.000 negociados
});

test("presion, grupos y ajuste", () => {
  const velas = Array.from({ length: 40 }, (_, i) => vela(i, 100));
  const oi = velas.map((_, i) => i * 10);
  const r = M.calcular(velas, oi, { levs: [{ L: 10, w: 1 }], vida: 1e9 });
  const pr = M.presion(r, 100, 0.15);
  assert.ok(pr.arriba > 0 && pr.abajo > 0 && Math.abs(pr.ratio - 1) < 0.01);   // bv = v / 2: simetrico
  const g = M.grupos(r, 100);
  assert.ok(g.arriba[0].p > 108 && g.arriba[0].p < 112 && g.abajo[0].p > 88 && g.abajo[0].p < 92);
  const pred = Array.from({ length: 50 }, (_, i) => i), real = pred.map((x) => x * 2);
  assert.ok(M.ajuste(pred, real).r > 0.99);
  assert.equal(M.ajuste([1, 2], [1, 2]), null);   // pocas velas
});

test("con el OI de cada vela, la reduccion es la fraccion cerrada y lo vivo suma ese OI", () => {
  const velas = Array.from({ length: 10 }, (_, i) => vela(i, 100));
  const oi = [0, 1000, 1000, 500, 500, 500, 500, 500, 500, 500];
  const nivel = [5000, 6000, 6000, 5500, 5500, 5500, 5500, 5500, 5500, 5500];   // OI total: el cambio es neto
  const r = M.calcular(velas, oi, { levs: [{ L: 2, w: 1 }], vida: 1e9, nivel });
  const vivo = (t) => { let s = 0; for (let b = 0; b < r.B; b++) s += r.gL[b * r.n + t] + r.gS[b * r.n + t]; return s; };
  assert.ok(Math.abs(vivo(2) - 6000) < 1e-6 && Math.abs(vivo(3) - 5500) < 1e-6);   // escalado al OI de cada vela
  const fin = r.finL.reduce((a, b) => a + b, 0) + r.finS.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(fin - 5500) < 1e-6 && r.escalado);
});

test("sumar une simbolos por tiempo", () => {
  const m = M.sumar([{ history: [{ t: 1, c: 2 }, { t: 2, c: 3 }] }, { history: [{ t: 1, c: 5 }] }], "c");
  assert.equal(m.get(1), 7); assert.equal(m.get(2), 3);
});
