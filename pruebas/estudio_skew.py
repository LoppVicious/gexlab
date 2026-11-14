"""Estudio (estudio.yml, script=estudio_skew.py): señal de skew con el historial real de la superficie.

Copia el historial de la superficie (history/ivsurf_*.json) del estado del motor a una carpeta temporal y calcula
skew.calcular con la lista del historial diario. Solo lee R2. Imprime cuántas sesiones hay, la evaluación en
adelante y los extremos del ranking de hoy (datos de mercado agregados)."""
import io
import os
import sys
import tarfile
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import almacen  # noqa: E402
import gex_engine as g  # noqa: E402
import historial500  # noqa: E402
import skew  # noqa: E402

g.HIST_DIR = tempfile.mkdtemp(prefix="hist_")
st = almacen.abrir()
with tarfile.open(fileobj=io.BytesIO(st.get("estado/estado.tar.gz")), mode="r:gz") as tf:
    for m in tf.getmembers():
        n = os.path.basename(m.name)
        if m.isfile() and m.name.startswith("history/ivsurf_"):
            with open(os.path.join(g.HIST_DIR, n), "wb") as f:
                f.write(tf.extractfile(m).read())
lista, origen = historial500.lista_tickers(st)
syms = []
for s in lista:
    try:
        syms.append(g.normalize(s))
    except ValueError:
        pass
dias = sorted(len(skew.serie(s)) for s in syms)
print(f"lista ({origen}): {len(syms)} tickers; sesiones con skew a 30 d: min {dias[0]}, mediana {dias[len(dias) // 2]}, max {dias[-1]}")
r = skew.calcular(syms)
print(f"acciones: {r['stocks']} el {r['date']}; sesiones puntuadas {r['sessions']} desde {r['first']}")
print("excluidos:", " ".join(r["excluded"]))
for h, e in r["eval"].items():
    print(f"{h} sesiones: {e}")
print("skew más caro:", ", ".join(f"{x['sym']} {x['skew'] * 100:+.1f} ({x['chg'] * 100 if x['chg'] is not None else 0:+.1f})" for x in r["rows"][:10]))
print("skew más barato:", ", ".join(f"{x['sym']} {x['skew'] * 100:+.1f} ({x['chg'] * 100 if x['chg'] is not None else 0:+.1f})" for x in r["rows"][-10:]))
