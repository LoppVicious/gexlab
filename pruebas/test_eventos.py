"""Pruebas sin red de eventos.py: normalizacion de Nasdaq, union de fuentes e instantes de aviso.
Uso: .venv/Scripts/python.exe pruebas/test_eventos.py"""
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import eventos as ev  # noqa: E402


def fila(country, name, gmt="08:30", actual="&nbsp;", consensus="&nbsp;", previous="&nbsp;"):
    return {"gmt": gmt, "country": country, "eventName": name, "actual": actual,
            "consensus": consensus, "previous": previous, "description": ""}


def test_normaliza():
    d = datetime(2026, 11, 13)
    e = ev.nasdaq_fila(fila("United States", "CPI", actual="0.3%", consensus="0.2%", previous="0.4%"), d)
    assert e == {"date": "2026-11-13", "time": "08:30", "name": "CPI (Oct)", "country": "US", "imp": 3,
                 "actual": "0.3%", "forecast": "0.2%", "previous": "0.4%"}, e
    # anclado: Core CPI Index no hereda la importancia del CPI
    e = ev.nasdaq_fila(fila("United States", "Core CPI Index"), d)
    assert e["imp"] == 1 and e["name"] == "Core CPI Index" and e["actual"] is None, e
    # pais de fuera de la lista: fuera
    assert ev.nasdaq_fila(fila("Brazil", "CPI"), d) is None
    # hora que no es hora
    assert ev.nasdaq_fila(fila("Euro Zone", "ECOFIN Meetings", gmt="All Day"), d)["time"] == ""
    # zona euro: misma etiqueta corta que EE. UU. pero otro pais
    e = ev.nasdaq_fila(fila("Euro Zone", "ECB Interest Rate Decision", gmt="08:15"), d)
    assert (e["country"], e["imp"], e["name"]) == ("EZ", 3, "ECB Interest Rate Decision"), e
    assert ev.nasdaq_fila(fila("United States", "Fed Interest Rate Decision", gmt="14:00"), d)["name"] == "FOMC"


if __name__ == "__main__":
    for nombre, fn in list(globals().items()):
        if nombre.startswith("test_"):
            fn()
            print("ok", nombre)
