"""Prueba (GitHub Actions, prueba_tradier.yml con script=tradier_velas.py): velas de Tradier (1 min) de los indices
en tiempo real y su agrupacion en el mapa del TRACE. Solo escribe recuentos y horas, ningun dato de la cuenta."""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import fuente_tradier as ft  # noqa: E402
import gex_engine as g  # noqa: E402

for s in ["SPX", "NDX", "RUT", "SPY", "QQQ", "IWM"]:
    t = time.time()
    try:
        v = ft.velas(s)["data"]
        dias = sorted({b["datetime"][:10] for b in v})
        ult = [b for b in v if b["datetime"].startswith(dias[-1])]
        print(f"{s}: {len(v)} velas, {len(dias)} sesiones; ultima sesion {dias[-1]}: {len(ult)} velas "
              f"{ult[0]['datetime'][11:16]}-{ult[-1]['datetime'][11:16]}, cierre {ult[-1]['price']['close']} ({time.time() - t:.1f} s)")
    except Exception as e:  # noqa: BLE001
        print(f"{s}: ERROR {type(e).__name__}: {e}")
print(f"peticiones: {ft.peticiones[0]}")
