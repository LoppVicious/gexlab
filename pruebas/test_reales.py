"""Pruebas sin red de reales.py. Uso: .venv/Scripts/python.exe pruebas/test_reales.py"""
import os
import sys
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import reales as r  # noqa: E402


def ev(titulo, fecha, previous, forecast=None):
    return {"titulo": titulo, "name": titulo, "date": fecha, "previous": previous, "forecast": forecast}


def test_formato():
    assert r.formato(0.3503, "0.6%") == "0.4%"
    assert r.formato(-0.21, "-0.4%") == "-0.2%"
    assert r.formato(165000, "119K") == "165K"
    assert r.formato(7523000, "7.19M") == "7.52M"
    assert r.formato(1221000, "1,288K") == "1,221K"
    assert r.formato(5, "n/a") is None
    assert r.formato(-0.01, "0.3%") == "0.0%"


def test_regla():
    assert r.regla("CPI m/m")[1] == "CUSR0000SA0"
    assert r.regla("Advance GDP q/q")[1] == "A191RL1Q225SBEA"
    assert r.regla("Prelim GDP q/q") is None and r.regla("Final GDP q/q") is None
    assert r.regla("ISM Manufacturing PMI") is None


def test_actual():
    cpi = [(date(2026, 10, 1), 337.476), (date(2026, 9, 1), 336.298)]
    assert r.actual(ev("CPI m/m", "2026-11-10", "0.6%"), cpi) == "0.4%"
    # dato aun del mes anterior: no es el nuevo
    assert r.actual(ev("CPI m/m", "2026-12-10", "0.4%"), cpi) is None
    nfp = [(date(2026, 10, 1), 159293), (date(2026, 9, 1), 159128)]
    assert r.actual(ev("Non-Farm Employment Change", "2026-11-06", "119K"), nfp) == "165K"
    claims = [(date(2026, 11, 7), 205000), (date(2026, 10, 31), 189000)]
    assert r.actual(ev("Unemployment Claims", "2026-11-12", "189K"), claims) == "205K"
    assert r.actual(ev("Unemployment Claims", "2026-11-19", "205K"), claims) is None
    gdp = [(date(2026, 7, 1), 3.4), (date(2026, 4, 1), 2.2)]
    assert r.actual(ev("Prelim GDP q/q", "2026-11-26", "2.2%"), gdp) is None
    assert r.actual(ev("Advance GDP q/q", "2026-10-29", "2.2%"), gdp) == "3.4%"
    yy = [(date(2026, 10, 1), 337.511)] + [(date(2026, m, 1), 330.0) for m in range(9, 0, -1)] + \
         [(date(2025, m, 1), 327.0) for m in range(12, 9, -1)]
    assert r.actual(ev("CPI y/y", "2026-11-10", "3.0%"), yy) == "3.2%"


def test_correcciones():
    # JOLTS: dia >= 20 -> mes anterior; si no, dos meses antes
    jolts = lambda f, o: r.actual(ev("JOLTS Job Openings", f, "7.2M"), [(o, 7523)])  # noqa: E731
    assert jolts("2025-04-29", date(2025, 3, 1)) == "7.5M"
    assert jolts("2025-11-04", date(2025, 9, 1)) == "7.5M"
    assert jolts("2025-04-29", date(2025, 2, 1)) is None
    # mm y dif exigen mes consecutivo
    cpi = [(date(2026, 10, 1), 337.476), (date(2026, 8, 1), 336.298)]
    assert r.actual(ev("CPI m/m", "2026-11-10", "0.6%"), cpi) is None
    nfp = [(date(2026, 10, 1), 159293), (date(2026, 8, 1), 159128)]
    assert r.actual(ev("Non-Farm Employment Change", "2026-11-06", "119K"), nfp) is None
    # muestra con mas decimales
    cpi = [(date(2026, 10, 1), 337.476), (date(2026, 9, 1), 336.298)]
    assert r.actual(ev("CPI m/m", "2026-11-10", "0.6%", "0.25%"), cpi) == "0.35%"
    # rellenar: si BLS falla, FRED rellena igualmente; si todo falla, error
    antes = (r._bls, r._fred)
    try:
        def malo(_):
            raise RuntimeError("bls caido")
        r._bls = malo
        r._fred = lambda s: [(date(2026, 11, 7), 205000), (date(2026, 10, 31), 189000)]
        a, b = ev("Unemployment Claims", "2026-11-12", "189K"), ev("CPI m/m", "2026-11-10", "0.6%")
        assert r.rellenar([a, b]) == 1 and a["actual"] == "205K" and "actual" not in b
        r._fred = lambda s: (_ for _ in ()).throw(RuntimeError("fred caido"))
        try:
            r.rellenar([a, b])
            assert False
        except RuntimeError as ex:
            assert "bls caido" in str(ex)
    finally:
        r._bls, r._fred = antes


if __name__ == "__main__":
    for nombre, fn in list(globals().items()):
        if nombre.startswith("test_"):
            fn()
            print("ok", nombre)
