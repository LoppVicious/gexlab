"""Estudio (estudio.yml, script=estudio_evento.py): tramos de varianza a plazo de movimiento.evento en la última
sesión guardada de unas acciones, para calibrar el detector de eventos. Solo lee R2.
Acciones: variable EVENTO_SYMS (separadas por comas) o las de abajo."""
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import numpy as np  # noqa: E402

import almacen  # noqa: E402
import gex_engine as g  # noqa: E402
import movimiento  # noqa: E402

SYMS = os.environ.get("EVENTO_SYMS") or "AAPL,GOOGL,AMZN,TSLA,CRM,KR,MSFT,NVDA"
st = almacen.abrir()
for sym in SYMS.split(","):
    claves = sorted(k for k in st.list(f"hist500/{sym}/") if k.endswith(".json.gz"))
    if not claves:
        print(sym, "sin datos")
        continue
    d = almacen.get_json(st, claves[-1])
    dia = claves[-1].rsplit("/", 1)[1][:10]
    ch = g.parse_chain({"_min": d["chain"]})
    spot = float(d["spot"])
    now = datetime.fromisoformat(dia + "T16:00")
    q = g.quote_time(now)
    print(f"\n{sym} {dia} spot {spot} quote_time {q} -> evento {movimiento.evento(ch, spot, now)}")
    vivos = (ch["exp"] > np.datetime64(q.replace(second=0, microsecond=0))) & (ch["iv"] > 0.01)
    previo = (0.0, 0.0)
    for ex in np.unique(ch["exp"][vivos])[:8]:
        sel = vivos & (ch["exp"] == ex)
        ks = np.unique(ch["K"][sel])
        lo, hi = ks[ks <= spot], ks[ks >= spot]
        if not lo.size or not hi.size:
            continue
        k1, k2 = lo.max(), hi.min()
        iv = float(np.mean([ch["iv"][sel & (ch["K"] == k)].mean() for k in (k1, k2)]))
        exd = ex.astype("datetime64[m]").astype(datetime)
        n = g.trading_minutes(q, exd) / g.SESSION_MIN
        w = iv * iv * (exd - q).total_seconds() / 60 / g.YEAR_MIN
        f = (w - previo[1]) / (n - previo[0]) if n - previo[0] > 0 else float("nan")
        print(f"  {ex}  sesiones {n:5.2f}  dias {(exd - q).total_seconds() / 86400:5.2f}  IV {iv:.3f}  "
              f"var/sesion a plazo {f * 1e4:7.2f} bp2")
        if n - previo[0] >= 0.9:
            previo = (n, w)
