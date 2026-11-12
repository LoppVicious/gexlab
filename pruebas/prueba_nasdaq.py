"""Prueba en Actions: la peticion de eventos.nasdaq_dia tal cual (sin cambios de cabeceras) desde un runner de GitHub.
Imprime el resultado por dia, el conteo por pais y los eventos de importancia 2 o mas."""
import os
import sys
from collections import Counter
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import eventos as ev  # noqa: E402
import gex_engine as g  # noqa: E402

hoy = g.now_ny().replace(hour=0, minute=0, second=0, microsecond=0)
todos = []
for i in (-1, 0, 1, 2):
    d = hoy + timedelta(days=i)
    try:
        evs = ev.nasdaq_dia(d)
        print(f"{d:%Y-%m-%d}: {len(evs)} eventos")
        todos += evs
    except Exception as e:  # noqa: BLE001
        print(f"{d:%Y-%m-%d}: {type(e).__name__}: {e}")
print(Counter(e["country"] for e in todos))
for e in todos:
    if e["imp"] >= 2:
        print(e)
