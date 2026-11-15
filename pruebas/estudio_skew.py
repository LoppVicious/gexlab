"""Estudio (estudio.yml, script=estudio_skew.py): señales de skew y call-put con el índice de hist500/_skew.json.gz.

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
    print(f"acciones: {r['stocks']} el {r['date']}; sin lectura: {' '.join(r['missing'])}")
    print("excluidos:", " ".join(r["excluded"]))
    for k, sg in r["signals"].items():
        print(f"{k} (signo esperado {sg['sign']:+d}): {sg['sessions']} sesiones puntuadas")
        for h, e in sg["eval"].items():
            print(f"  {h} sesiones: {e}")
        dg = sg.get("diag") or {}
        print(f"  diagnóstico: correlación con el rendimiento de las {skew.CAMBIO} sesiones previas {dg.get('past')}")
        for parte in ("level", "change", "neutral"):
            for h, e in (dg.get(parte) or {}).items():
                print(f"    {parte} {h}: IC {e['ic']} t {e['t']} n {e['n']}/{e['need']}")
        if k == "combo":  # la fila del consenso no tiene puntuación propia: votos y media de direcciones
            continue
        filas = sorted((x for x in r["rows"] if k in x), key=lambda x: -x[k]["score"])
        fmt = lambda x: f"{x['sym']} {x[k]['v'] * 100:+.1f}"  # noqa: E731
        print("  arriba:", ", ".join(fmt(x) for x in filas[:8]))
        print("  abajo:", ", ".join(fmt(x) for x in filas[-8:]))
