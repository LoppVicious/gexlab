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


def test_union():
    known = {}
    oficial = {"date": "2026-11-13", "time": "08:30", "name": "CPI (Oct)", "country": "US", "imp": 3}
    ez = {"date": "2026-11-13", "time": "05:00", "name": "CPI", "country": "EZ", "imp": 3,
          "actual": None, "forecast": "2.1%", "previous": "2.2%"}
    nas = dict(oficial, actual="0.3%", forecast="0.2%", previous="0.4%")
    ev.unir(known, [oficial, ez])
    ev.unir(known, [nas])
    assert len(known) == 2, known  # oficial y Nasdaq de EE. UU. son el mismo evento; el de la zona euro, otro
    assert known["2026-11-13|US|CPI (Oct)"]["actual"] == "0.3%"
    assert known["2026-11-13|EZ|CPI"]["forecast"] == "2.1%"
    # misma publicacion con otra etiqueta de mes: se queda la nueva
    ev.unir(known, [dict(nas, name="CPI (Sep)")])
    assert "2026-11-13|US|CPI (Oct)" not in known and "2026-11-13|US|CPI (Sep)" in known
    # publicaciones hermanas del mismo dia no se pisan
    ev.unir(known, [dict(ez, name="CPI, n.s.a"), dict(ez, name="CPI ex Tobacco")])
    ev.unir(known, [ez])
    assert {"2026-11-13|EZ|CPI", "2026-11-13|EZ|CPI, n.s.a", "2026-11-13|EZ|CPI ex Tobacco"} <= set(known), known


def test_avisos():
    # 2026-11-13 es viernes; en noviembre Nueva York es UTC-5
    evs = [
        {"date": "2026-11-13", "time": "08:30", "name": "CPI (Oct)", "country": "US", "imp": 3,
         "actual": None, "forecast": "0.2%", "previous": "0.4%"},
        {"date": "2026-11-13", "time": "08:30", "name": "Retail sales (Oct)", "country": "US", "imp": 2,
         "actual": None, "forecast": "0.1%", "previous": "0.0%"},
        {"date": "2026-11-13", "time": "10:00", "name": "Fed Chair speaks", "country": "US", "imp": 2,
         "actual": None, "forecast": None, "previous": None},
        {"date": "2026-11-13", "time": "09:00", "name": "Minor", "country": "US", "imp": 1,
         "actual": None, "forecast": None, "previous": None},
        {"date": "2026-11-13", "time": "", "name": "ECOFIN Meetings", "country": "EZ", "imp": 2,
         "actual": None, "forecast": None, "previous": None},
    ]
    from datetime import timezone
    antes = datetime(2026, 11, 13, 13, 0, tzinfo=timezone.utc)   # 08:00 ET
    assert ev.horas_aviso(evs, antes) == ["2026-11-13T13:31:00Z", "2026-11-13T15:01:00Z"], ev.horas_aviso(evs, antes)
    # 08:32 ET sin actual: reintento a T+6 (una vez); el discurso no reintenta
    durante = datetime(2026, 11, 13, 13, 32, tzinfo=timezone.utc)
    assert ev.horas_aviso(evs, durante) == ["2026-11-13T13:36:00Z", "2026-11-13T15:01:00Z"], ev.horas_aviso(evs, durante)
    # con actual ya publicado, no hay reintento
    for e in evs[:2]:
        e["actual"] = "0.3%"
    assert ev.horas_aviso(evs, durante) == ["2026-11-13T15:01:00Z"]


if __name__ == "__main__":
    for nombre, fn in list(globals().items()):
        if nombre.startswith("test_"):
            fn()
            print("ok", nombre)
