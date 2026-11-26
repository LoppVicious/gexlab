"""Pruebas sin red de movimiento.py (movimiento esperado). Uso: python pruebas/test_movimiento.py"""
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import numpy as np  # noqa: E402

import gex_engine as g  # noqa: E402
import movimiento as m  # noqa: E402

SES = "2026-11-20"   # viernes
NOW = datetime.fromisoformat(SES + "T16:00")
S2 = 0.30 ** 2 / 252  # varianza por sesión de una volatilidad del 30 %


def cadena(evento: float, vencs=("2026-11-27", "2026-12-04", "2026-12-11"), fin_de_semana=m.FIN_DE_SEMANA,
           diarios: float = 1.0):
    """Cadena ATM con la IV que da varianza total S2 × tiempo efectivo + evento² en todos los vencimientos (evento
    antes del primero); el tiempo efectivo pesa cada día sin mercado `fin_de_semana` veces una sesión."""
    q = g.quote_time(NOW)
    filas = []
    for v in vencs:
        exd = datetime.fromisoformat(v + "T16:00")
        n = g.trading_minutes(q, exd) / g.SESSION_MIN
        dias = (exd - q).total_seconds() / 86400
        w = S2 * (n + fin_de_semana * max(0.0, dias - n)) + evento ** 2
        iv = np.sqrt(w * g.YEAR_MIN / ((exd - q).total_seconds() / 60)) * (1.0 if exd.weekday() == 4 else diarios)
        filas += [(k, c, v, iv) for k in (95, 100, 105) for c in (True, False)]
    return {"K": np.array([f[0] for f in filas], float), "call": np.array([f[1] for f in filas], bool),
            "exp": np.array([f[2] + "T16:00" for f in filas], dtype="datetime64[m]"),
            "iv": np.array([f[3] for f in filas], float)}


def test_evento_detectado():
    r = m.evento(cadena(0.08), 100.0, NOW)
    assert r is not None
    pct, exp, n = r
    assert abs(pct - 8.0) < 0.3, pct
    assert exp == "2026-11-27" and 3 < n < 4   # lunes a miércoles y el medio día del viernes


def test_sin_evento():
    assert m.evento(cadena(0.0), 100.0, NOW) is None


def test_festivo_y_fin_de_semana_no_son_evento():
    # caso del 2026-11-25: Acción de Gracias (el viernes 27 es medio día y su tramo dura 0,54 sesiones: se salta) y
    # diarios de lunes y miércoles. Ni los días sin mercado ni la sierra de los diarios son un evento
    ahora = datetime.fromisoformat("2026-11-25T16:00")
    global NOW
    antes, NOW = NOW, ahora
    try:
        # días sin mercado con más peso que el del detector (como en las cadenas reales de ese día): sin evento
        vencs = ("2026-11-27", "2026-11-30", "2026-12-02", "2026-12-04", "2026-12-07", "2026-12-11", "2026-12-18")
        ch = cadena(0.0, vencs, fin_de_semana=0.5)
        assert m.evento(ch, 100.0, ahora) is None
        # diarios de lunes y miércoles con un 8 % menos de IV que los viernes (MSFT ese día): sin el filtro de
        # semanales salía un evento del 2,8 % "by Dec 4"
        assert m.evento(cadena(0.0, vencs, diarios=0.92), 100.0, ahora) is None
        r = m.evento(cadena(0.06, vencs, diarios=0.92), 100.0, ahora)
        assert r is not None and abs(r[0] - 6.0) < 0.3 and r[1] == "2026-12-04", r
    finally:
        NOW = antes


def test_evento_lejano_fuera():
    # el salto está en el tramo que acaba a más de EVENTO_SESIONES sesiones
    r = m.evento(cadena(0.08, ("2026-12-18", "2026-12-24", "2027-01-08", "2027-01-15")), 100.0, NOW)
    assert r is None


def _datos(dias=30, n=30, seed=3):
    """Índices sintéticos: S{j} con O/S creciente en j y movimiento real creciente en j con el mismo implícito."""
    rng = np.random.default_rng(seed)
    fechas = [str(np.datetime64("2026-09-01") + np.timedelta64(i, "D")) for i in range(dias)]
    idx, sk = {}, {}
    precio = np.full(n, 100.0)
    for f in fechas:
        idx[f], sk[f] = {}, {}
        for j in range(n):
            s = f"S{j}"
            idx[f][s] = [1.0, 2.0, 5.0 if j == 0 else None, "2026-12-01" if j == 0 else None, 2.0 if j == 0 else None,
                         -1e6 * j, 101.0, float(precio[j])]
            sk[f][s] = [0.3, 0.35, float(precio[j]), 0.0, 100.0 * (1 + j), 1e6]
        precio *= np.exp(rng.normal(0, 0.002 + 0.0008 * np.arange(n)))
    return idx, sk, {f"S{j}": f"Empresa {j} Inc" for j in range(n)}


def test_calcular_prueba_e_indicadores():
    idx, sk, nombres = _datos()
    r = m.calcular(idx, sk, nombres)
    assert r["date"] == max(idx) and r["sessions"] == 30 and len(r["rows"]) == 30
    t = r["test"]
    assert t["heavy"]["n"] == 25 and t["heavy"]["ic"] > 0.5 and t["heavy"]["top"] > t["heavy"]["bottom"]
    # gamma más negativa en las que más se mueven: el indicador short también acierta
    assert t["short"]["ic"] > 0.5
    assert t["events"]["n"] == 25
    filas = {x["sym"]: x for x in r["rows"]}
    assert "heavy" in filas["S29"].get("flags", []) and "heavy" not in filas["S0"].get("flags", [])
    assert "short" in filas["S29"]["flags"]
    assert "short" not in filas["S0"].get("flags", [])   # gamma 0: no es negativa
    assert filas["S0"]["ev"] == 5.0 and filas["S0"]["ev_exp"] == "2026-12-01"
    assert filas["S3"]["below_flip"] is True
    assert abs(filas["S1"]["os"] - 0.02) < 1e-9


def test_fuera_fondos_e_indices():
    idx, sk, nombres = _datos(dias=8, n=25)
    nombres["S1"] = "Spdr S&P 500 ETF Trust"
    for f in idx:
        idx[f]["SPX"] = idx[f]["S2"]
    r = m.calcular(idx, sk, nombres)
    syms = {x["sym"] for x in r["rows"]}
    assert "S1" not in syms and "SPX" not in syms and "S2" in syms


if __name__ == "__main__":
    n = 0
    for nombre, f in list(globals().items()):
        if nombre.startswith("test_"):
            f()
            n += 1
    print(f"test_movimiento: {n} pruebas OK")
