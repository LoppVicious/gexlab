// Prueba de viabilidad: el mismo gex_engine.py ejecutado con Pyodide (Python en WebAssembly, como en un navegador)
import { loadPyodide } from "pyodide";
const t0 = Date.now();
const py = await loadPyodide();
await py.loadPackage(["numpy", "ssl"]);
console.log(`Pyodide + numpy cargados en ${((Date.now() - t0) / 1000).toFixed(1)} s`);
py.FS.mkdir("/app");
py.FS.mount(py.FS.filesystems.NODEFS, { root: process.cwd() }, "/app");
const out = py.runPython(`
import os, sys, time, json
os.environ["GEX_FIXTURE_DIR"] = "/app/fx"
sys.path.insert(0, "/app")
os.chdir("/tmp")
import gex_engine as g
g.HIST_DIR = "/tmp/history"; g.CACHE_DIR = "/tmp/cache"
res = []
for sym in ("SPX", "SPY"):
    for dte in (45, None):
        t = time.time(); r = g.compute(sym, max_dte=dte, window_pct=5.0); a = time.time() - t
        t = time.time(); h = g.heatmap(sym, max_dte=dte, window_pct=5.0); b = time.time() - t
        res.append(f"WASM   {sym} dte={dte}: niveles {a:.2f} s, mapa {b:.2f} s, flip {r['levels'].get('flip')}")
"\\n".join(res)
`);
console.log(out);
