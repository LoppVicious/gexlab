"""Estudio (estudio.yml): inventario del historial disponible para comparar configuraciones del 0DTE de SPX.
Solo lee R2. Escribe recuentos y fechas, nunca datos de cuentas."""
import gzip
import io
import json
import os
import sys
import tarfile
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import almacen  # noqa: E402

st = almacen.abrir()
b = st.get("estado/estado.tar.gz")
print(f"estado: {len(b) / 1e6:.1f} MB" if b else "estado: no hay")
miembros = {}
with tarfile.open(fileobj=io.BytesIO(b), mode="r:gz") as tf:
    for m in tf.getmembers():
        if m.isfile():
            miembros[m.name] = tf.extractfile(m).read()


def js(raw: bytes):
    try:
        return json.loads(gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw)
    except Exception:  # noqa: BLE001
        return None


for sym in ("SPX", "SPY", "NDX", "QQQ"):
    h = js(miembros.get(f"history/{sym}.json", b"")) if f"history/{sym}.json" in miembros else None
    if h:
        dias = sorted({k.split("|")[0] for k in h if "|" in k})
        clv = Counter("|".join(k.split("|")[1:]) for k in h if "|" in k)
        print(f"\nhistory/{sym}.json: {len(dias)} sesiones {dias[0]} -> {dias[-1]}")
        print("  claves (filtro|variante|a):", dict(sorted(clv.items())))
        k0 = next((k for k in h if k.endswith("|0|a")), None)
        print("  ejemplo ex ante 0DTE:", k0, sorted((h.get(k0) or {}).keys()) if k0 else None)
    ch = sorted(n for n in miembros if n.startswith(f"history/chains/{sym}_"))
    print(f"  copias de la cadena: {len(ch)} {[n[-18:-8] for n in ch]}")
    fl = js(miembros[f"history/flow_{sym}.json.gz"]) if f"history/flow_{sym}.json.gz" in miembros else None
    if fl:
        print(f"  flujo: {len(fl)} sesiones {sorted(fl)[:1]} -> {sorted(fl)[-1:]}")

print("\nhist500:")
for sym in ("SPX", "SPY", "NDX", "QQQ"):
    ks = sorted(st.list(f"hist500/{sym}/"))
    print(f"  {sym}: {len(ks)} sesiones {[k.split('/')[-1][:10] for k in ks]}")
d = js(st.get(sorted(st.list("hist500/SPX/"))[-1])) if st.list("hist500/SPX/") else None
if d:
    print("  niveles guardados:", {p: {m: sorted(v) for m, v in d["levels"][p].items()} for p in d["levels"]})
