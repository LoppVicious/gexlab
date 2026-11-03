// GEX Lab - motor del navegador (Web Worker). Ejecuta el mismo gex_engine.py con Pyodide (Python en WebAssembly)
// sobre los paquetes que publica el motor de la nube, para las combinaciones que no estan precalculadas.
"use strict";
const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/";
importScripts(PYODIDE + "pyodide.js");

let py = null;
let ready = null;
const loaded = {};   // simbolo -> marca del paquete cargado

async function init() {
  py = await loadPyodide({ indexURL: PYODIDE });
  await py.loadPackage(["numpy", "ssl"]);
  const src = await (await fetch("/gex_engine.py", { credentials: "same-origin", cache: "no-cache" })).text();
  py.FS.mkdirTree("/app");
  py.FS.mkdirTree("/fx");
  py.FS.mkdirTree("/hist/chains");
  py.FS.writeFile("/app/gex_engine.py", src);
  py.runPython(`
import os, sys, json, math
os.environ["GEX_FIXTURE_DIR"] = "/fx"
sys.path.insert(0, "/app")
import gex_engine as g
g.HIST_DIR = "/hist"
g.CACHE_DIR = "/tmp/cache"

def _clean(o):
    if isinstance(o, float):
        return o if math.isfinite(o) else None
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    return o

def _reset(names):
    g._cache.clear(); g._aux_cache.clear(); g._heat_cache.clear(); g._flow_mem.clear()
    g._rate["t"] = 0.0
    g._symbols = list(g.INDEX_NAMES) + [tuple(x) for x in json.loads(names)]

def _run(op, kw):
    kw = json.loads(kw)
    f = g.compute if op == "compute" else g.heatmap
    return json.dumps(_clean(f(**kw)), separators=(",", ":"))
`);
}

function writePaquete(p) {
  for (const [rel, obj] of Object.entries(p.files || {})) {
    let path = rel.startsWith("fx/") ? "/fx/" + rel.slice(3) : rel.startsWith("hist/") ? "/hist/" + rel.slice(5) : null;
    if (!path || path.includes("..")) continue;
    if (path.endsWith(".gz")) path = path.slice(0, -3); // el motor lee tambien la version sin comprimir
    py.FS.mkdirTree(path.slice(0, path.lastIndexOf("/")));
    py.FS.writeFile(path, JSON.stringify(obj));
  }
}

function pyError(e) {
  // de la traza de Python, la ultima linea ("LookupError: No hay contratos ...") sin el tipo
  const lines = String((e && e.message) || e).trim().split("\n").filter(Boolean);
  const last = lines[lines.length - 1] || "Error en el motor del navegador";
  return last.replace(/^[A-Za-z_.]*(Error|Exception):\s*/, "");
}

const names = {};
self.onmessage = async (ev) => {
  const { id, op, args, paquetes } = ev.data;
  try {
    if (op === "warm") { ready = ready || init(); await ready; postMessage({ id, ok: true }); return; }
    ready = ready || init();
    await ready;
    let changed = false;
    for (const p of paquetes || []) {
      names[p.symbol] = p.name || p.symbol;
      if (loaded[p.symbol] === p.generado) continue;
      writePaquete(p);
      loaded[p.symbol] = p.generado;
      changed = true;
    }
    if (changed) py.globals.get("_reset")(JSON.stringify(Object.entries(names)));
    const out = py.globals.get("_run")(op, JSON.stringify(args));
    postMessage({ id, ok: true, json: out });
  } catch (e) {
    postMessage({ id, ok: false, error: pyError(e) });
  }
};
