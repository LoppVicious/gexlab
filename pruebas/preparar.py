"""Descarga datos reales de CBOE en fx/ (formato de fixtures), mide el motor nativo y el tamano del paquete compacto."""
import gzip, json, os, sys, time
sys.path.insert(0, os.getcwd())
import numpy as np
import gex_engine as g
os.makedirs("fx", exist_ok=True)
for sym in ("SPX", "SPY"):
    raw = g.fetch_chain(sym)
    json.dump(raw, open(f"fx/{sym}.json", "w"))
    for kind in ("intraday", "historical"):
        d = g.fetch_aux(kind, sym)
        if d: json.dump(d, open(f"fx/{kind}_{sym}.json", "w"))
for q in ("SPY", "IRX"):
    d = g.fetch_quote(q)
    if d: json.dump(d, open(f"fx/quote_{q}.json", "w"))
print("Datos descargados")
os.environ["GEX_FIXTURE_DIR"] = "fx"
g._cache.clear(); g._aux_cache.clear(); g._heat_cache.clear()
for sym in ("SPX", "SPY"):
    for dte in (45, None):
        t = time.time(); r = g.compute(sym, max_dte=dte, window_pct=5.0); a = time.time() - t
        t = time.time(); h = g.heatmap(sym, max_dte=dte, window_pct=5.0); b = time.time() - t
        print(f"NATIVO {sym} dte={dte}: niveles {a:.2f} s, mapa {b:.2f} s, flip {r['levels'].get('flip')}, mapa {len(json.dumps(h))//1000} KB")
ch = g.parse_chain(json.load(open("fx/SPX.json")))
keep = ch["oi"] > 0
comp = {}
for k, v in ch.items():
    if isinstance(v, np.ndarray):
        v = v[keep]
        comp[k] = v.astype(str).tolist() if v.dtype.kind == "M" else v.astype(int).tolist() if v.dtype.kind == "b" else np.round(v, 5).tolist()
b = gzip.compress(json.dumps(comp, separators=(",", ":")).encode())
print(f"Cadena SPX: cruda {os.path.getsize('fx/SPX.json')/1e6:.1f} MB, compacta con gzip {len(b)/1e6:.2f} MB ({keep.sum()} contratos con OI)")
