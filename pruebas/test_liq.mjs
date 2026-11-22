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

test("con ancho, cada nivel se reparte en la franja de entradas posibles de su vela", () => {
  const velas = [vela(0, 100), { t: 1, o: 95, h: 105, l: 95, c: 100, v: 100, bv: 100 }];
  for (let i = 2; i < 6; i++) velas.push(vela(i, 100));
  const r = M.calcular(velas, [0, 1000, 1000, 1000, 1000, 1000], { levs: [{ L: 10, w: 1 }], vida: 1e9, mm: 0, bins: 400, ancho: 0.5 });
  const llenos = []; for (let b = 0; b < r.B; b++) if (r.finL[b] > 0) llenos.push(b);
  assert.ok(llenos.length >= 3, `tramos ${llenos.length}`);   // de 97,5 a 102,5 por 0,9: varios tramos
  const lo = r.bordes[llenos[0]], hi = r.bordes[llenos[llenos.length - 1] + 1];
  assert.ok(lo < 90 && hi > 90 && lo > 86 && hi < 94, `${lo} - ${hi}`);
  assert.ok(Math.abs(r.finL.reduce((a, b) => a + b, 0) - 1000) < 1e-3);   // la cantidad no cambia
});

test("sumar une simbolos por tiempo", () => {
  const m = M.sumar([{ history: [{ t: 1, c: 2 }, { t: 2, c: 3 }] }, { history: [{ t: 1, c: 5 }] }], "c");
  assert.equal(m.get(1), 7); assert.equal(m.get(2), 3);
});

test("lista de niveles: termina al tocarlo el precio o cuando la memoria lo da por cerrado", () => {
  const velas = [vela(0, 100), vela(1, 100)];
  for (let i = 2; i < 30; i++) velas.push(vela(i, 100));
  velas[20] = { t: 20, o: 100, h: 100, l: 89, c: 95, v: 100, bv: 50 };   // toca el largo a 10x (90)
  const oi = velas.map((_, i) => (i >= 1 ? 1000 : 0));
  const r = M.calcular(velas, oi, { levs: [{ L: 10, w: 1 }], vida: 1e9, mm: 0 });
  const nv = r.niveles, k = [...Array(nv.N).keys()].find((j) => nv.lado[j] === 0);
  assert.equal(nv.i[k], 1); assert.equal(nv.fin[k], 20); assert.ok(Math.abs(nv.p[k] - 90) < 0.5);
  assert.ok(Math.abs(nv.a[k] - 500) < 1e-6);   // la mitad del OI nuevo (bv = v / 2)
  const r2 = M.calcular(velas, oi, { levs: [{ L: 10, w: 1 }], vida: 2, mm: 0 });   // vida media de 2 velas
  const k2 = [...Array(r2.niveles.N).keys()].find((j) => r2.niveles.lado[j] === 1);   // el corto (110), sin tocar
  assert.equal(r2.niveles.fin[k2], 6);   // a las 4 velas le queda 1/4: se da por cerrado
});

test("rejilla de dibujo: tamano constante mientras el nivel vive", () => {
  const velas = [vela(0, 100), vela(1, 100)];
  for (let i = 2; i < 30; i++) velas.push(vela(i, 100));
  velas[20] = { t: 20, o: 100, h: 100, l: 89, c: 95, v: 100, bv: 50 };
  const oi = velas.map((_, i) => (i >= 1 ? 1000 : 0));
  const r = M.calcular(velas, oi, { levs: [{ L: 10, w: 1 }], vida: 10, mm: 0 });
  const col = (t) => { let s = 0; for (let b = 0; b < r.B; b++) s += r.gV[b * r.n + t]; return s; };
  assert.ok(Math.abs(col(2) - 1000) < 1e-3 && Math.abs(col(15) - 1000) < 1e-3);   // sin decaer: largo + corto
  assert.ok(Math.abs(col(21) - 500) < 1e-3);   // el largo, tocado en la vela 20; el corto sigue
});

test("ocultar apalancamientos solo quita sus franjas: tamanos y escala de color no cambian", () => {
  const velas = [];
  for (let i = 0; i < 80; i++) velas.push(vela(i, 100 + 5 * Math.sin(i / 6), { bv: 30 + (i % 7) * 5 }));
  const oi = velas.map((_, i) => 1000 + i * 40 - (i % 9 === 0 ? 150 : 0));
  const nivel = oi.map((x) => x * 3);
  const todo = M.calcular(velas, oi, { vida: 30, nivel });
  const poco = M.calcular(velas, oi, { vida: 30, nivel, ver: [5, 10] });
  assert.equal(poco.topeV, todo.topeV);   // misma escala de color
  for (let k = 0; k < poco.niveles.N; k++) {   // cada nivel visible, con el mismo tamano que con todos
    const j = [...Array(todo.niveles.N).keys()].find((q) => todo.niveles.i[q] === poco.niveles.i[k]
      && todo.niveles.p[q] === poco.niveles.p[k] && todo.niveles.lado[q] === poco.niveles.lado[k]);
    assert.ok(j != null && Math.abs(todo.niveles.a[j] - poco.niveles.a[k]) < 1e-6);
  }
  assert.ok(poco.niveles.N < todo.niveles.N && poco.niveles.N > 0);
  const suma = (r) => r.finL.reduce((a, b) => a + b, 0) + r.finS.reduce((a, b) => a + b, 0);
  assert.ok(suma(poco) < suma(todo));   // lo vivo visible es una parte, no todo el OI
  assert.deepEqual(Array.from(poco.predL), Array.from(todo.predL));   // previstas: todos los apalancamientos
  assert.equal(M.calcular(velas, oi, { ver: [] }), null);
});

test("en el mapa un nivel no vale mas que el OI que sigue abierto desde que nacio", () => {
  const velas = Array.from({ length: 30 }, (_, i) => vela(i, 100));
  const oi = velas.map((_, i) => (i >= 1 ? 1000 : 0));
  const nivel = velas.map((_, i) => (i < 10 ? 4000 : i < 20 ? 1000 : 4000));   // el OI total cae a la cuarta parte y vuelve
  nivel[5] = 100;   // una vela suelta (hueco de datos): no cuenta
  const r = M.calcular(velas, oi, { levs: [{ L: 10, w: 1 }], vida: 1e9, mm: 0, nivel });
  const col = (t) => { let s = 0; for (let b = 0; b < r.B; b++) s += r.gV[b * r.n + t]; return s; };
  assert.ok(Math.abs(col(8) / col(3) - 1) < 1e-6);      // el hueco de la vela 5 no lo recorta
  assert.ok(Math.abs(col(12) / col(8) - 0.25) < 1e-6);   // un cuarto del OI: un cuarto del tamano
  assert.ok(Math.abs(col(25) / col(12) - 1) < 1e-6);     // aunque el OI vuelva, esas posiciones no reaparecen
});

test("enMapa da por nivel lo mismo que la rejilla del mapa (para el tooltip)", () => {
  const velas = [];
  for (let i = 0; i < 60; i++) velas.push(vela(i, 100 + 4 * Math.sin(i / 5), { bv: 40 + (i % 5) * 5 }));
  const oi = velas.map((_, i) => 1000 + i * 30);
  const nivel = velas.map((_, i) => (i < 30 ? 5000 + i * 50 : 3000));
  const r = M.calcular(velas, oi, { vida: 20, nivel });
  const t = 50, porBin = new Map();
  const lP = Math.log(r.bordes[0]), paso = Math.log(r.bordes[1]) - lP;
  for (let k = 0; k < r.niveles.N; k++) {
    const b = Math.floor((Math.log(r.niveles.p[k]) - lP) / paso);
    porBin.set(b, (porBin.get(b) || 0) + M.enMapa(r, k, t));
  }
  for (const [b, s] of porBin) assert.ok(Math.abs(s - r.gV[b * r.n + t]) < 1e-3 * Math.max(1, s), `tramo ${b}`);
  assert.ok([...r.niveles.L].every((L) => M.APAL.some((x) => x.L === L)));
});

test("la escala de color sale de la ventana pedida, no de toda la historia", () => {
  const velas = Array.from({ length: 60 }, (_, i) => vela(i, i < 30 ? 100 : 50));
  const oi = velas.map((_, i) => (i < 30 ? i * 1000 : 30000 + (i - 30) * 10));
  const todo = M.calcular(velas, oi, { vida: 30 });
  const fin = M.calcular(velas, oi, { vida: 30, escalaDesde: 40 });
  assert.ok(fin.topeV > 0 && fin.topeV <= todo.topeV);
});

test("en el mapa un nivel solo desaparece cuando el precio lo toca, no por la memoria", () => {
  const velas = Array.from({ length: 60 }, (_, i) => vela(i, 100));
  const oi = velas.map((_, i) => (i >= 1 ? 1000 : 0));
  const r = M.calcular(velas, oi, { levs: [{ L: 10, w: 1 }], vida: 2, mm: 0 });   // memoria muy corta
  let s = 0; for (let b = 0; b < r.B; b++) s += r.gV[b * r.n + 59];
  assert.ok(Math.abs(s - 1000) < 1e-3);   // largo y corto siguen en el mapa: el precio no los ha tocado
  assert.ok(r.niveles.fin[0] < 59);       // pero la memoria los da por cerrados para la lectura
  assert.ok(r.topeV > 0);
});

test("grupos y presion salen de lo que pinta el mapa: siempre sobre una franja que pasa el umbral", () => {
  const velas = Array.from({ length: 60 }, (_, i) => vela(i, 100 + Math.sin(i / 4) * 3));
  const oi = velas.map((_, i) => i * 10 + (i % 7 === 0 ? 200 : 0));
  const r = M.calcular(velas, oi, { vida: 1e9 });
  const t = r.n - 1, precio = velas[t].c, umbral = r.topeV * 0.05;
  const binDe = (p) => { for (let b = 0; b < r.B; b++) if (p >= r.bordes[b] && p < r.bordes[b + 1]) return b; return -1; };
  const g = M.grupos(r, precio, 3, Infinity, umbral);
  for (const x of [...g.arriba, ...g.abajo]) assert.ok(r.gV[binDe(x.p) * r.n + t] > umbral, `grupo en ${x.p}`);
  // sin nada que pase el umbral no hay grupos ni presion
  const nada = M.presion(r, precio, 1, Infinity);
  assert.equal(nada.arriba + nada.abajo, 0);
  assert.equal(M.grupos(r, precio, 3, Infinity, Infinity).arriba.length, 0);
});
