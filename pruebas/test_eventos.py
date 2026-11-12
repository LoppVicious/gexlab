"""Pruebas sin red de eventos.py: normalizacion de ForexFactory, union de fuentes e instantes de aviso.
Uso: .venv/Scripts/python.exe pruebas/test_eventos.py"""
import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import eventos as ev  # noqa: E402


def ff(title, country="USD", date="2026-11-10T08:30:00-05:00", impact="High", forecast="", previous=""):
    return {"title": title, "country": country, "date": date, "impact": impact, "forecast": forecast, "previous": previous}


def test_ff_fila():
    e = ev.ff_fila(ff("CPI m/m", forecast="0.3%", previous="0.6%"))
    assert e == {"date": "2026-11-10", "time": "08:30", "name": "CPI (Oct)", "titulo": "CPI m/m", "country": "US",
                 "imp": 3, "forecast": "0.3%", "previous": "0.6%", "actual": None}, e
    e = ev.ff_fila(ff("German Prelim CPI m/m", "EUR", "2026-11-10T08:00:00-05:00", "Medium", "0.2%", "0.3%"))
    assert (e["country"], e["name"], e["imp"]) == ("DE", "German Prelim CPI m/m", 2) and "titulo" not in e, e
    assert ev.ff_fila(ff("CPI m/m", "EUR"))["country"] == "EZ"
    e = ev.ff_fila(ff("Empire State Manufacturing Index", impact="Low"))
    assert e["solo_cal"] is True and e["imp"] == 1 and e["name"] == "Empire State Manufacturing Index", e
    assert ev.ff_fila(ff("Bank Holiday", impact="Holiday")) is None
    assert ev.ff_fila(ff("CPI q/q", "NZD")) is None
    assert ev.ff_fila(ff("OPEC Meetings", date="2026-11-10T00:00:00-05:00", impact="Low"))["time"] == ""


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
    def e(name, time, imp=2, real=True, actual=None, country="US"):
        return {"date": "2026-11-13", "time": time, "name": name, "country": country, "imp": imp,
                "real": real, "actual": actual, "forecast": "0.2%", "previous": "0.4%"}
    evs = [e("CPI (Oct)", "08:30", 3), e("Retail sales (Oct)", "08:30"), e("Fed Chair speaks", "10:00", real=False),
           e("Minor", "09:00", 1), e("ECOFIN Meetings", "", country="EZ", real=False)]
    from datetime import timezone
    utc = lambda h, m: datetime(2026, 11, 13, h, m, tzinfo=timezone.utc)  # noqa: E731
    # solo avisan los eventos con fuente de dato real (real) que aun no lo tienen; el resto no (el modo calendario
    # no puede actualizarlos)
    assert ev.horas_aviso(evs, utc(13, 0)) == ["2026-11-13T13:31:00Z"]
    # sin dato real: el siguiente reintento (T+6, 16, 31, 61, 121) que no haya pasado
    assert ev.horas_aviso(evs, utc(13, 32)) == ["2026-11-13T13:36:00Z"]
    assert ev.horas_aviso(evs, utc(13, 40)) == ["2026-11-13T13:46:00Z"]
    assert ev.horas_aviso(evs, utc(15, 40)) == []
    for x in evs[:2]:
        x["actual"] = "0.3%"
    assert ev.horas_aviso(evs, utc(13, 32)) == []
    assert ev.horas_aviso(evs, utc(13, 0)) == []


def test_union_ff():
    known = {}
    oficial = {"date": "2026-11-13", "time": "08:30", "name": "CPI (Oct)", "country": "US", "imp": 2}
    ff_ = {"date": "2026-11-13", "time": "08:30", "name": "CPI (Oct)", "titulo": "CPI m/m", "country": "US", "imp": 3,
           "forecast": "0.3%", "previous": "0.6%", "actual": "0.4%"}
    ev.unir(known, [oficial], solo_nuevos=True)
    ev.unir(known, [ff_])
    ev.unir(known, [oficial], solo_nuevos=True)
    e = known["2026-11-13|US|CPI (Oct)"]
    assert (e["actual"], e["forecast"], e["titulo"], e["imp"]) == ("0.4%", "0.3%", "CPI m/m", 3), e
    ev.unir(known, [dict(ff_, actual=None, forecast="0.2%")])
    e = known["2026-11-13|US|CPI (Oct)"]
    assert (e["actual"], e["forecast"]) == ("0.4%", "0.2%"), e
    # solo_nuevos con otra etiqueta de mes: ya existe la publicacion, se salta
    ev.unir(known, [dict(oficial, name="CPI (Sep)")], solo_nuevos=True)
    assert list(known) == ["2026-11-13|US|CPI (Oct)"], known


def test_migracion():
    import json
    import tempfile
    import gex_engine
    hoy = gex_engine.now_ny()
    pasado = (hoy - timedelta(days=40)).strftime("%Y-%m-%d")
    futuro = (hoy + timedelta(days=40)).strftime("%Y-%m-%d")
    viejo = {"version": 3, "eventos": [
        {"date": pasado, "time": "08:30", "name": "CPI (Sep)", "imp": 3},
        {"date": pasado, "time": "08:30", "name": "Payrolls (NFP) (Sep)", "imp": 3},
        {"date": pasado, "time": "08:30", "name": "Retail sales (Sep)", "imp": 2},
        {"date": futuro, "time": "08:30", "name": "CPI (Dec)", "imp": 3}]}
    guardado = (ev.STATE, ev.fomc, ev.bea, ev.census, ev.fred, ev.forexfactory, ev.reales.rellenar)
    try:
        with tempfile.TemporaryDirectory() as d:
            ev.STATE = os.path.join(d, "eventos.json")
            with open(ev.STATE, "w", encoding="utf-8") as f:
                json.dump(viejo, f)
            ev.fomc = ev.bea = ev.census = ev.fred = ev.forexfactory = lambda: []
            ev.reales.rellenar = lambda evs: 0
            evs, _ = ev.actualizar()
    finally:
        ev.STATE, ev.fomc, ev.bea, ev.census, ev.fred, ev.forexfactory, ev.reales.rellenar = guardado
    assert sorted((e["name"], e["country"]) for e in evs) == [("CPI (Sep)", "US"), ("Payrolls (NFP) (Sep)", "US")], evs


if __name__ == "__main__":
    for nombre, fn in list(globals().items()):
        if nombre.startswith("test_"):
            fn()
            print("ok", nombre)
