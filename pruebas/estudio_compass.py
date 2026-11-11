"""Estudio (estudio.yml, script=estudio_compass.py): estelas del Compass con el historial real del motor.

Copia el historial de volatilidad (history/vol_*.json) del estado del motor a una carpeta temporal, cuenta las
sesiones guardadas y calcula el Compass de una lista de prueba para ver cuantas sesiones de estela salen por ticker.
Solo lee R2: el Compass escribe la foto de hoy en la carpeta temporal, nunca en el estado. Los registros son publicos:
solo tickers y ranks de volatilidad, que son datos de mercado."""
import io
import os
import sys
import tarfile
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import almacen  # noqa: E402
import gex_engine as g  # noqa: E402

LISTA = ["AAPL", "AMZN", "AVGO", "GOOG", "META", "MSFT", "NFLX", "NVDA", "TSLA", "SPY", "QQQ", "IWM"]

g.HIST_DIR = tempfile.mkdtemp(prefix="hist_")
st = almacen.abrir()
dias = {}
with tarfile.open(fileobj=io.BytesIO(st.get("estado/estado.tar.gz")), mode="r:gz") as tf:
    for m in tf.getmembers():
        n = os.path.basename(m.name)
        if m.isfile() and m.name.startswith("history/vol_") and n.endswith(".json"):
            with open(os.path.join(g.HIST_DIR, n), "wb") as f:
                f.write(tf.extractfile(m).read())
            dias[n[4:-5]] = len(g.read_json(os.path.join(g.HIST_DIR, n)) or {})
cuenta = sorted(dias.values())
print(f"historial de volatilidad: {len(dias)} tickers, sesiones min {cuenta[0] if cuenta else 0}, "
      f"mediana {cuenta[len(cuenta) // 2] if cuenta else 0}, max {cuenta[-1] if cuenta else 0}")
print("lista:", ", ".join(f"{s} {dias.get(s.replace('.', '_'), 0)}" for s in LISTA))

res = g.compass(LISTA)
for r in res["rows"]:
    if "error" in r:
        print(f"{r['symbol']:5} error {r['error']}")
        continue
    tr = " ".join(f"{t['date'][5:]}({t['x']:.0f},{t['y']:.0f})" for t in r["trail"])
    print(f"{r['symbol']:5} hoy ({r['x']:.0f},{r['y']:.0f}) x={r['x_src']} y={r['y_src']} dias={r['days']} "
          f"estela {len(r['trail'])}: {tr}")
