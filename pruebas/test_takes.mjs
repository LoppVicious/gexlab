// Pruebas de Founder Takes (funciones puras). Ejecutar: node --test pruebas/test_takes.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { validarTake, tipoArchivo, limpiarEtiquetas, urlSegura, extracto, LIM } from "../nube/takes.js";
import { createRequire } from "node:module";
const { tkMarkdown } = createRequire(import.meta.url)("../web/takes-md.js");

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
