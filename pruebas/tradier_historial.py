"""Que historial intradia ofrece Tradier (velas por minuto del subyacente y de un contrato). Solo recuentos y fechas."""
import os, sys
from datetime import datetime, timedelta
sys.path.insert(0, os.getcwd())
import gex_engine as g
import fuente_tradier as ft

hoy = g.now_ny().date()


def rango(path, key1="series", key2="data"):
    try:
        d = ft._get(path.replace(" ", "%20"))
        rows = ft._lista(((d or {}).get(key1) or {}).get(key2))
        if not rows:
            return "vacio"
        f = lambda r: r.get("date") or r.get("time")  # noqa: E731
        return f"{len(rows)} filas, de {f(rows[0])} a {f(rows[-1])}"
    except Exception as e:  # noqa: BLE001
        return f"ERROR {type(e).__name__}: {e}"


for dias in (0, 5, 10, 20, 30, 60):
    d = hoy - timedelta(days=dias)
    for iv in ("1min", "5min", "15min"):
        print(f"SPY {iv:5s} hace {dias:>2} dias ({d}):", rango(f"/markets/timesales?symbol=SPY&interval={iv}&start={d} 09:30&end={d} 16:00&session_filter=open"))
exps = ft._vencimientos("SPY")
e = next((x for x in exps if (datetime.strptime(x, "%Y-%m-%d").date() - hoy).days >= 25), exps[-1])
o = min(ft._opciones("SPY", e), key=lambda o: abs(float(o["strike"]) - 736))
for dias in (0, 5, 20):
    d = hoy - timedelta(days=dias)
    print(f"opcion {o['symbol']} 1min hace {dias} dias:", rango(f"/markets/timesales?symbol={o['symbol']}&interval=1min&start={d} 09:30&end={d} 16:00"))
