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
