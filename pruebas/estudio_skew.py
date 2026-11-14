"""Estudio (estudio.yml, script=estudio_skew.py): señal de skew con el índice real de hist500/_skew.json.gz.

Solo lee R2. Imprime cuántas sesiones y acciones hay, la prueba en adelante y los extremos del ranking de hoy
(datos de mercado agregados). El índice lo escribe historial500.py (cada cierre, o --indice para reconstruirlo)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import almacen  # noqa: E402
import gex_engine as g  # noqa: E402
import skew  # noqa: E402

idx = almacen.get_json(almacen.abrir(), skew.INDICE) or {}
print(f"indice: {len(idx)} sesiones" + (f" ({min(idx)} a {max(idx)})" if idx else ""))
for f in sorted(idx):
    print(f"  {f}: {len(idx[f])} tickers")
if idx:
    r = skew.calcular(idx, dict(g.load_symbols()))
    print(f"acciones: {r['stocks']} el {r['date']}; sesiones puntuadas {r['sessions']} desde {r['first']}")
    print("excluidos:", " ".join(r["excluded"]))
    for h, e in r["eval"].items():
        print(f"{h} sesiones: {e}")
    fmt = lambda x: f"{x['sym']} {x['skew'] * 100:+.1f}" + (f" ({x['chg'] * 100:+.1f})" if x["chg"] is not None else "")  # noqa: E731
    print("skew más caro:", ", ".join(fmt(x) for x in r["rows"][:10]))
    print("skew más barato:", ", ".join(fmt(x) for x in r["rows"][-10:]))
