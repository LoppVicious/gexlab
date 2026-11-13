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
    if (refresh && tk.abierto && !tk.editor) await tkAbre(tk.abierto.id, false);
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
  $("tkNew").hidden = !tk.puede.escribir || !!tk.editor || !!tk.abierto;
  $("tkQ").hidden = !!tk.editor || !!tk.abierto;
  if (tk.editor) { $("tkTags").innerHTML = ""; return tkPintaEditor(); }
  if (tk.abierto) { $("tkTags").innerHTML = ""; return tkPintaDetalle(); }
  if (tk.lista) tkPintaLista();
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
  for (const t of tk.lista) for (const e of t.etiquetas) {
    const k = e.toLowerCase();
    if (!cuenta.has(k)) cuenta.set(k, { n: 0, txt: e });
    cuenta.get(k).n++;
  }
  for (const f of [...tk.filtro]) if (!cuenta.has(f)) tk.filtro.delete(f);   // etiquetas que ya no existen
  const tags = [...cuenta.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]));
  $("tkTags").innerHTML = tags.map(([k, v]) =>
    `<button class="tk-chip${tk.filtro.has(k) ? " on" : ""}" data-tag="${esc(k)}" aria-pressed="${tk.filtro.has(k)}">${esc(v.txt)} <span>${v.n}</span></button>`).join("");
  if (!tk.lista.length) {
    $("tkBody").innerHTML = `<div class="empty">${tk.puede.escribir ? "No takes yet. Use New take to write the first one." : "No takes yet."}</div>`;
    return;
  }
  const vis = tkVisibles();
  if (!vis.length) { $("tkBody").innerHTML = `<div class="empty">No takes match the filter.</div>`; return; }
  $("tkBody").innerHTML = `<div class="tk-list">${vis.map((t) => {
    const titulo = t.titulo || t.extracto.split(" ").slice(0, 10).join(" ") || "Untitled";
    const tipos = [...new Set(t.adjuntos.map((a) => a.tipo))];
    return `<article class="tk-card" data-id="${t.id}" tabindex="0">
      <div class="tk-meta"><time>${esc(tkFecha(t.publicado || t.creado))}</time>${t.estado === "borrador" ? '<span class="tk-draft">Draft</span>' : ""}${t.estado === "borrador" && t.autor !== tk.yo ? `<span>by ${esc(t.autor)}</span>` : ""}</div>
      <h3>${esc(titulo)}</h3>
      ${t.extracto && t.titulo ? `<p>${esc(t.extracto)}</p>` : ""}
      ${t.etiquetas.length || tipos.length ? `<div class="tk-foot">${t.etiquetas.map((e) => `<span class="tk-tag">${esc(e)}</span>`).join("")}${tipos.map((x) => `<span class="tk-kind">${TK_ICON[x]}</span>`).join("")}</div>` : ""}
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
    return `<div class="tk-adj"><span class="tk-kind">PDF</span><span class="tk-adj-t">${esc(a.titulo)}</span><a class="ghost tk-open" href="${esc(a.src)}" target="_blank" rel="noopener">Open PDF</a>${nota}</div>`;
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
    <div class="tk-meta"><time>${esc(tkFecha(t.publicado || t.creado))}</time>${t.editado ? `<span>edited ${esc(tkFecha(t.editado))}</span>` : ""}${t.estado === "borrador" ? '<span class="tk-draft">Draft</span>' : ""}${t.autor !== tk.yo ? `<span>by ${esc(t.autor)}</span>` : ""}</div>
    ${t.titulo ? `<h1>${esc(t.titulo)}</h1>` : ""}
    ${t.etiquetas.length ? `<div class="tk-foot">${t.etiquetas.map((e) => `<span class="tk-tag">${esc(e)}</span>`).join("")}</div>` : ""}
    ${t.cuerpo ? `<div class="tk-md">${tkMarkdown(t.cuerpo)}</div>` : ""}
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

/* ------------------------------------------------------------ editor (admin y autores de borradores) */
const TK_MB = 20 * 1024 * 1024;
const TK_TIPOS = { "application/pdf": "pdf", "image/png": "imagen", "image/jpeg": "imagen", "image/webp": "imagen" };

function tkEditor(t) {
  tk.editor = t ? {
    id: t.id, titulo: t.titulo, cuerpo: t.cuerpo, etiquetas: [...t.etiquetas], vista: "write", msg: "", guardando: false,
    adjuntos: t.adjuntos.map((a) => ({ id: a.id, tipo: a.tipo, url: a.url || "", titulo: a.titulo, texto: a.texto, fuente: a.fuente })),
  } : { id: null, titulo: "", cuerpo: "", etiquetas: [], adjuntos: [], vista: "write", msg: "", guardando: false };
  renderTakes(); window.scrollTo(0, 0);
}

function tkCampoAdj(a, i) {
  const f = (k, ph, val, area) => area
    ? `<textarea data-adj="${i}" data-k="${k}" rows="3" placeholder="${ph}" aria-label="${ph}">${esc(val || "")}</textarea>`
    : `<input data-adj="${i}" data-k="${k}" placeholder="${ph}" aria-label="${ph}" value="${esc(val || "")}">`;
  let campos;
  if (a.tipo === "enlace") campos = f("url", "Link (https://…)", a.url) + f("titulo", "Title (optional: the domain is shown)", a.titulo) + f("texto", "Note (optional)", a.texto);
  else if (a.tipo === "cita") campos = f("texto", "Quoted text", a.texto, true) + f("fuente", "Source (author or research house)", a.fuente) + f("url", "Link to the original (optional)", a.url);
  else campos = (a.file ? `<span class="tk-file">${esc(a.file.name)}</span>` : "") + f("titulo", "Title", a.titulo) + f("texto", a.tipo === "imagen" ? "Caption (optional)" : "Note (optional)", a.texto);
  const n = tk.editor.adjuntos.length;
  return `<div class="tk-ed-adj"><div class="tk-ed-adj-h"><span class="tk-kind">${TK_ICON[a.tipo]}</span>
    <span class="tk-actions"><button type="button" class="ghost" data-tk="subir" data-i="${i}" aria-label="Move up"${i ? "" : " disabled"}>↑</button><button type="button" class="ghost" data-tk="bajar" data-i="${i}" aria-label="Move down"${i < n - 1 ? "" : " disabled"}>↓</button><button type="button" class="ghost" data-tk="quitar" data-i="${i}" aria-label="Remove attachment">×</button></span></div>${campos}</div>`;
}

function tkPintaEditor() {
  const ed = tk.editor;
  const todas = [...new Set((tk.lista || []).flatMap((t) => t.etiquetas))];
  const hayPdf = ed.adjuntos.some((a) => a.tipo === "pdf");
  $("tkBody").innerHTML = `<form class="tk-editor" id="tkForm" novalidate>
    <div class="tk-detail-bar"><button type="button" class="ghost" data-tk="cancelar">‹ Cancel</button><span class="tk-actions">
      <button type="submit" class="ghost tk-primary"${ed.guardando ? " disabled" : ""}>${ed.guardando ? "Saving…" : "Save draft"}</button></span></div>
    <input class="tk-ed-title" id="tkEdTitulo" placeholder="Title (optional)" aria-label="Title" maxlength="200" value="${esc(ed.titulo)}">
    <div class="seg tk-ed-tabs" role="radiogroup" aria-label="Editor view"><button type="button" role="radio" data-tk="write" aria-checked="${ed.vista === "write"}">Write</button><button type="button" role="radio" data-tk="preview" aria-checked="${ed.vista === "preview"}">Preview</button></div>
    ${ed.vista === "write"
      ? `<textarea class="tk-ed-body" id="tkEdCuerpo" rows="14" aria-label="Text" placeholder="Write in Markdown: # title, **bold**, *italic*, - lists, > quotes, [text](https://…). Paste an image to attach it.">${esc(ed.cuerpo)}</textarea>`
      : `<div class="tk-md tk-ed-preview">${tkMarkdown(ed.cuerpo) || '<p class="tk-faint">Nothing to preview.</p>'}</div>`}
    <div class="tk-ed-tags">${ed.etiquetas.map((e, i) => `<span class="tk-tag">${esc(e)}<button type="button" data-tk="sintag" data-i="${i}" aria-label="Remove tag ${esc(e)}">×</button></span>`).join("")}
      <input id="tkEdTag" list="tkEdTags" placeholder="Add a tag and press Enter" aria-label="Add a tag" maxlength="30"><datalist id="tkEdTags">${todas.map((e) => `<option value="${esc(e)}">`).join("")}</datalist></div>
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
  tkLeeCampos();
  const malos = [];
  for (const f of files) {
    const tipo = TK_TIPOS[f.type];
    if (!tipo) { malos.push(`${f.name}: PDF, PNG, JPEG or WebP only`); continue; }
    if (f.size > TK_MB) { malos.push(`${f.name}: 20 MB max`); continue; }
    ed.adjuntos.push({ id: null, tipo, file: f, url: "", titulo: f.name.replace(/\.[a-z0-9]+$/i, ""), texto: "", fuente: "" });
  }
  ed.msg = malos.join(". ");
  tkPintaEditor();
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

/* ------------------------------------------------------------ eventos */
$("tkQ").addEventListener("input", (e) => { tk.q = e.target.value; tkPintaLista(); });
$("tkTags").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tag]"); if (!b) return;
  const k = b.dataset.tag;
  if (tk.filtro.has(k)) tk.filtro.delete(k); else tk.filtro.add(k);
  tkGuardaFiltro(); tkPintaLista();
});
$("tkNew").addEventListener("click", () => tkEditor(null));
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
  if (e.key === "Enter" && !tk.editor && !tk.abierto) {
    const card = e.target.closest(".tk-card");
    if (card) tkAbre(+card.dataset.id);
    return;
  }
  if (e.target.id !== "tkEdTag" || (e.key !== "Enter" && e.key !== ",")) return;
  e.preventDefault();
  const ed = tk.editor, v = e.target.value.trim().replace(/,+$/, "");
  tkLeeCampos();
  ed.msg = "";
  if (v && !ed.etiquetas.some((x) => x.toLowerCase() === v.toLowerCase())) {
    if (ed.etiquetas.length >= 10) ed.msg = "10 tags max";
    else ed.etiquetas.push(v.slice(0, 30));
  }
  tkPintaEditor(); $("tkEdTag").focus();
});
$("tkBody").addEventListener("submit", (e) => { if (e.target.id === "tkForm") { e.preventDefault(); tkGuarda(); } });
$("tkBody").addEventListener("input", (e) => {   // campos de adjuntos: al estado sin repintar (no se pierde el foco)
  const el = e.target;
  if (tk.editor && el.dataset.adj != null) tk.editor.adjuntos[+el.dataset.adj][el.dataset.k] = el.value;
});
$("tkBody").addEventListener("change", (e) => {
  if (e.target.id === "tkFile") { tkAnadeArchivos([...e.target.files]); e.target.value = ""; }
});
$("tkBody").addEventListener("paste", (e) => {
  if (!tk.editor) return;
  const files = [...(e.clipboardData ? e.clipboardData.files : [])].filter((f) => TK_TIPOS[f.type]);
  if (files.length) { e.preventDefault(); tkAnadeArchivos(files); }
});
$("tkBody").addEventListener("dragover", (e) => { if (tk.editor) { e.preventDefault(); const d = $("tkDrop"); if (d) d.classList.add("on"); } });
$("tkBody").addEventListener("dragleave", (e) => { if (tk.editor && e.target.id === "tkDrop") e.target.classList.remove("on"); });
$("tkBody").addEventListener("drop", (e) => {
  if (!tk.editor) return;
  e.preventDefault();
  tkAnadeArchivos([...e.dataTransfer.files]);
});
