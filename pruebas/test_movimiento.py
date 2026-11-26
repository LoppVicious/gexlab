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


def test_movimiento_a_un_mes():
    # 30 % de volatilidad: un mes (21 sesiones) es unos 30 % × raíz(21/252) = 8,7 %, por encima del de 5 sesiones
    vencs = ("2026-11-27", "2026-12-04", "2026-12-11", "2026-12-18", "2026-12-24", "2027-01-08", "2027-01-15",
             "2027-01-22", "2027-02-19")
    p = m.punto(cadena(0.0, vencs), 100.0, SES, None)
    assert p is not None and len(p) == 9
    assert 7.5 < p[8] < 10.0 and p[8] > p[1], p


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
    assert filas["S0"]["m21"] is None   # filas del índice anteriores al movimiento a un mes
    assert filas["S0"]["ev"] == 5.0 and filas["S0"]["ev_exp"] == "2026-12-01"
    assert filas["S3"]["below_flip"] is True
    assert abs(filas["S1"]["os"] - 0.02) < 1e-9


def _velas(fechas, n, hoy_vela):
    """Velas con ADV sesiones previas iguales (volumen 1e6, rango 2) y, el último día, la de hoy_vela {SYM: (máximo,
    mínimo, cierre, acciones)}; S{j} con j par tiene volumen doble todos los días de la prueba (RVol alto)."""
    previas = [str(np.datetime64(fechas[0]) - np.timedelta64(m.ADV - k, "D")) for k in range(m.ADV)]
    out = {}
    for j in range(n):
        s = f"S{j}"
        filas = [(101.0, 99.0, 100.0, 1e6)] * m.ADV
        filas += [(101.0, 99.0, 100.0, 2e6 if j % 2 == 0 else 1e6) for _ in fechas[:-1]]
        filas.append(hoy_vela.get(s, (101.0, 99.0, 100.0, 1e6)))
        fs = previas + fechas
        out[s] = {"i": {f: k for k, f in enumerate(fs)}, "a": np.array(filas)}
    return out


def test_vela_y_etiquetas_de_volumen():
    idx, sk, nombres = _datos()
    fechas = sorted(idx)
    # S29: volumen 2,5 veces la media, rango 4 (2 veces), cierre en el 90 % del rango: confirmada. S28: O/S en el
    # quinto alto (heavy) con la acción a 0,8 veces su volumen: options. S27: volumen alto pero cierre en el mínimo
    vl = _velas(fechas, 30, {"S29": (102.0, 98.0, 101.6, 2.5e6), "S28": (101.0, 99.0, 100.0, 8e5),
                             "S27": (102.0, 98.0, 98.0, 3e6)})
    x = m._vela(vl["S29"], fechas[-1])
    assert abs(x["rvol"] - 2.5) < 1e-9 and abs(x["range"] - 2.0) < 1e-9 and abs(x["pos"] - 0.9) < 1e-9
    assert m._vela(vl["S29"], "2020-01-01") is None
    r = m.calcular(idx, sk, nombres, vl)
    filas = {f["sym"]: f for f in r["rows"]}
    assert "confirmed" in filas["S29"]["flags"] and "options" not in filas["S29"]["flags"]
    assert "options" in filas["S28"]["flags"] and "confirmed" not in filas["S28"].get("flags", [])
    assert "confirmed" not in filas["S27"].get("flags", [])
    assert filas["S29"]["rvol"] == 2.5 and filas["S29"]["candle_date"] == fechas[-1]
    t = r["test"]
    # las pares van a 2 veces su volumen hasta que la media lo recoge (desde ahí todas a 1 y el día no puntúa);
    # ninguna confirmada: rango normal y cierre a media vela
    assert t["rvol"]["n"] == 20 and t["confirmed"]["n"] == 0
    # options en la prueba: heavy (S24-S29) con RVol ≤ 1: las impares cada día, y también las pares desde el día 21
    assert t["options"]["n"] == 25 * 3 + 5 * 3 and t["options"]["ratio"] is not None
    assert t["options"]["sessions"] == 25 and t["options"]["enough"]
    assert m._casos([(1.0, 0.5, "2026-11-01")] * 30)["enough"] is False   # 30 casos de un solo día
    # sin velas: ni columna ni etiquetas
    sin = {f["sym"]: f for f in m.calcular(idx, sk, nombres)["rows"]}
    assert sin["S29"]["rvol"] is None and "confirmed" not in sin["S29"].get("flags", [])


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
