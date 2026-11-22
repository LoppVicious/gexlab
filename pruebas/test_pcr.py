"""Pruebas sin red de pcr.py (sentimiento por put/call). Uso: python pruebas/test_pcr.py"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import numpy as np  # noqa: E402

import pcr  # noqa: E402

SES = "2026-11-20"


def cadena(filas):
    """filas: (strike, es_call, vencimiento 'AAAA-MM-DD', vol, oi, delta)."""
    return {"K": np.array([f[0] for f in filas], float), "call": np.array([f[1] for f in filas], bool),
            "exp": np.array([f[2] + "T16:00" for f in filas], dtype="datetime64[m]"),
            "vol": np.array([f[3] for f in filas], float), "oi": np.array([f[4] for f in filas], float),
            "delta": np.array([f[5] for f in filas], float)}


# ---------------------------------------------------------------- sumas
def test_sumas_otm_y_delta():
    ch = cadena([
        (110, True, "2026-11-27", 100, 1000, 0.30),    # call fuera de dinero, t0 (7 días)
        (90, True, "2026-11-27", 5000, 9000, 0.95),    # call dentro de dinero (dividendo): fuera
        (90, False, "2026-11-27", 200, 500, -0.25),    # put fuera de dinero, t0
        (110, False, "2026-11-27", 50, 50, -0.90),     # put dentro de dinero: fuera
        (95, False, "2026-12-18", 40, 400, -0.40),     # put fuera de dinero, t1 (28 días)
        (130, True, "2027-06-18", 10, 300, 0.10),      # call fuera de dinero, t2
    ])
    s = pcr.sumas(ch, 100.0, SES)
    assert s["t0"] == [30.0, 50.0, 300.0, 125.0]
    assert s["t1"] == [0.0, 16.0, 0.0, 160.0]
    assert s["t2"] == [1.0, 0.0, 30.0, 0.0]
    assert s["all"] == [31.0, 66.0, 330.0, 285.0]


def test_sumas_tramo_vacio_y_vencido():
    ch = cadena([(110, True, "2026-11-19", 100, 100, 0.3),   # vencido antes de la sesión: fuera
                 (110, True, "2026-11-20", 10, 0, 0.2)])     # vence hoy: t0
    s = pcr.sumas(ch, 100.0, SES)
    assert s["t0"] == [2.0, 0.0, 0.0, 0.0] and s["t1"] is None and s["t2"] is None


def test_por_vencimiento():
    ch = cadena([(110, True, "2026-11-27", 100, 1000, 0.30), (90, False, "2026-11-27", 200, 500, -0.25),
                 (95, False, "2026-12-18", 40, 400, -0.40)])
    v = pcr.por_vencimiento(ch, 100.0, SES)
    assert v == [{"exp": "2026-11-27", "dte": 7, "pc_vol": round(50 / 30, 4), "pc_oi": round(125 / 300, 4)},
                 {"exp": "2026-12-18", "dte": 28, "pc_vol": None, "pc_oi": None}]


# ---------------------------------------------------------------- z y puntuación
def test_serie_z_minimo_y_mad():
    xs = [0.0, 1.0] * 10                          # 20 valores: mediana 0,5, MAD 0,5
    z = pcr.serie_z(xs + [2.0])
    assert all(v is None for v in z[:20])         # sin 20 sesiones previas, sin z
    assert abs(z[20] - (2.0 - 0.5) / (1.4826 * 0.5)) < 1e-9
    assert pcr.serie_z([1.0] * 21)[20] is None    # MAD 0: sin lectura
    assert pcr.serie_z([None] * 5 + [0.0, 1.0] * 10 + [None])[-1] is None   # hoy sin dato


def test_serie_z_ventana():
    xs = [5.0] * 40 + [0.0, 1.0] * 30 + [0.5]     # las 40 primeras quedan fuera de la ventana de 60
    assert abs(pcr.serie_z(xs)[-1]) < 1e-9


def test_puntuacion_escala():
    assert pcr.puntuacion(0.0) in (50, 51)
    assert pcr.puntuacion(3.0) == 1               # muchas más puts que lo normal: miedo
    assert pcr.puntuacion(-3.0) == 100            # muchas menos puts: codicia
    assert pcr.puntuacion(1.0) < pcr.puntuacion(0.0) < pcr.puntuacion(-1.0)
    assert pcr.puntuacion(None) is None


def test_log_pc():
    assert pcr.log_pc([10.0, 20.0, 5.0, 5.0]) == math.log(2.0)
    assert pcr.log_pc([10.0, 20.0, 5.0, 10.0], oi=True) == math.log(2.0)
    assert pcr.log_pc([0.0, 20.0, 5.0, 5.0]) is None and pcr.log_pc(None) is None


# ---------------------------------------------------------------- divergencias
def test_divergencia_bajista_y_racha():
    cierres = [100.0 + i for i in range(30)]                  # máximos de 20 sesiones cada día
    scores = [70] * 20 + [40] * 10                            # la puntuación se hunde
    casos, flags = pcr.divergencias(cierres, scores)
    # i = 21: media 58 frente a 70 (−12), aún no; i = 22: 52 frente a 70 (−18), sí
    assert flags[21] is None and flags[22] == "bear"
    assert casos == [(22, "bear")]                            # la racha (22 a 26) cuenta una vez
    assert flags[29] is None                                  # 40 frente a 40: sin diferencia


def test_divergencia_alcista():
    cierres = [200.0 - i for i in range(25)]
    scores = [30] * 20 + [60] * 5
    casos, _ = pcr.divergencias(cierres, scores)
    assert casos and casos[0][1] == "bull"


def test_sin_divergencia_con_huecos():
    cierres = [100.0 + i for i in range(30)]
    cierres[15] = None                                        # falta un cierre en la ventana: no se evalúa
    casos, flags = pcr.divergencias(cierres, [70] * 20 + [40] * 10)
    assert all(f is None for f in flags[15:35]) and not casos


# ---------------------------------------------------------------- cálculo completo
def _idx_sintetico(n=30):
    """AAPL con P/C estable y un salto de puts el último día; SPY estable; cierres en el índice de skew."""
    rng = np.random.default_rng(1)
    idx, sk = {}, {}
    for i in range(n):
        f = f"2026-{9 + i // 28:02d}-{1 + i % 28:02d}"
        pa = 1.0 + 0.1 * rng.standard_normal() if i < n - 1 else 3.0
        idx[f] = {"AAPL": {"t0": [100.0, 100 * pa, 10.0, 10.0], "t1": [50.0, 50 * pa, 5.0, 5.0], "t2": None,
                           "all": [150.0, 150 * pa, 15.0, 15.0]},
                  "SPY": {"t0": [100.0, 150 + rng.standard_normal(), 1.0, 1.0], "t1": None, "t2": None, "all": None}}
        sk[f] = {"AAPL": [None, None, 100.0 + i, None, None, None], "SPY": [None, None, 500.0, None, None, None]}
    return idx, sk


def test_calcular():
    idx, sk = _idx_sintetico()
    assert len(idx) == 30
    r = pcr.calcular(idx, sk, {"AAPL": "Apple Inc", "SPY": "SPDR S&P 500 ETF Trust"}, {"AAPL": [{"exp": "x"}]},
                     {"sign": -1, "sessions": 3, "eval": {}})
    filas = {x["sym"]: x for x in r["rows"]}
    a = filas["AAPL"]
    assert a["stock"] and not filas["SPY"]["stock"]
    assert a["score"] is not None and a["score"] <= 5          # salto de puts: miedo
    assert a["tranches"]["t0"]["score"] <= 5 and a["tranches"]["t2"]["score"] is None
    assert a["n"] == 30 and r["sessions"] == 30
    assert r["market"]["indices"]["SPY"]["score"] is not None
    assert r["market"]["breadth"]["n"] == 1 and r["market"]["breadth"]["fear_pct"] == 100.0
    assert r["market"]["stocks"]["score"] == a["score"]         # una sola acción: el agregado es ella
    assert r["series"]["AAPL"][-1] == [max(idx), 129.0, a["score"]]
    assert r["expiries"] == {"AAPL": [{"exp": "x"}]} and r["swing"]["sign"] == -1
    assert "_STOCKS" not in filas


def test_zetas_y_vacio():
    idx, _ = _idx_sintetico()
    z = pcr.zetas(idx)
    assert z[max(idx)]["AAPL"] > 3 and min(idx) not in z
    try:
        pcr.calcular({}, {}, {})
        raise AssertionError("sin historia debe fallar")
    except LookupError:
        pass


# ---------------------------------------------------------------- señal en skew.py
def test_skew_con_pcr():
    import skew
    idx = {"2026-11-20": {s: [0.3, 0.35, 100.0, 0.0, 1000.0, 1e6] for s in [f"S{i}" for i in range(25)]}}
    pcrz = {"2026-11-20": {f"S{i}": i / 10 for i in range(25)}}
    r = skew.calcular(idx, {f"S{i}": f"Stock {i} Inc" for i in range(25)}, None, pcrz)
    filas = {x["sym"]: x for x in r["rows"]}
    assert filas["S24"]["pcr"]["v"] == 2.4 and filas["S24"]["pcr"]["score"] > filas["S0"]["pcr"]["score"]
    assert r["signals"]["pcr"]["sign"] == -1


if __name__ == "__main__":
    n = 0
    for nombre, f in list(globals().items()):
        if nombre.startswith("test_"):
            f()
            n += 1
    print(f"test_pcr: {n} pruebas OK")
