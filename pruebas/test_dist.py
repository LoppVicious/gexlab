"""Pruebas sin red de la distribucion implicita (gex_engine). Uso: python pruebas/test_dist.py"""
import math
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import numpy as np  # noqa: E402

import gex_engine as g  # noqa: E402

AHORA = datetime(2026, 12, 1, 10, 0)          # martes, mercado abierto (hora de Nueva York, sin zona)
VTO = np.datetime64("2026-12-11T16:00")       # viernes, ~10 dias naturales


def cadena(exps, iv_fn, F=100.0, ks=None):
    """Cadena sintetica: call y put en cada strike de cada vencimiento, IV = iv_fn(K), forward F."""
    ks = np.arange(60.0, 140.5, 1.0) if ks is None else np.asarray(ks, float)
    K, C, E = [], [], []
    for e in exps:
        for k in ks:
            for c in (True, False):
                K.append(k); C.append(c); E.append(np.datetime64(e, "m"))
    K = np.array(K); C = np.array(C); E = np.array(E, dtype="datetime64[m]")
    return {"K": K, "call": C, "exp": E, "iv": np.array([iv_fn(k) for k in K]), "fwd": np.full(K.shape, F)}


def _ncdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def test_lognormal_con_iv_plana():
    ch = cadena([VTO], lambda k: 0.20)
    d = g.implied_distribution(ch, 100.0, AHORA, VTO)
    assert d is not None
    x, pdf, s = np.array(d["x"]), np.array(d["pdf"]), 0.20 * math.sqrt(d["T"])
    z = (np.log(x / 100.0) + 0.5 * s * s) / s
    exacta = np.exp(-0.5 * z * z) / (x * s * math.sqrt(2 * math.pi))
    assert np.max(np.abs(pdf - exacta)) < 0.01 * exacta.max(), np.max(np.abs(pdf - exacta)) / exacta.max()
    assert np.max(np.abs(np.array(d["logn"]) - exacta)) < 1e-6 * exacta.max() + 1e-12


def test_masa_media_y_percentiles():
    ch = cadena([VTO], lambda k: 0.20)
    d = g.implied_distribution(ch, 100.0, AHORA, VTO)
    x, pdf = np.array(d["x"]), np.array(d["pdf"])
    assert abs(g._trap(pdf, x) - 1) < 1e-9
    assert abs(g._trap(pdf * x, x) / 100.0 - 1) < 0.002
    q = d["q"]
    assert q["5"] < q["25"] < q["50"] < q["75"] < q["95"]
    assert d["clip"] < 0.01 and d["noisy"] is False


def test_prob_beyond_iv_plana():
    ch = cadena([VTO], lambda k: 0.20)
    d = g.implied_distribution(ch, 100.0, AHORA, VTO)
    s = 0.20 * math.sqrt(d["T"])
    for K in (95.0, 100.0, 105.0):
        d2 = (math.log(100.0 / K) - 0.5 * s * s) / s
        assert abs(g.prob_beyond(d, K, "up") - _ncdf(d2)) < 0.005, K
        assert abs(g.prob_beyond(d, K, "down") - (1 - _ncdf(d2))) < 0.005, K
    assert g.prob_beyond(d, 1e6, "up") == 0.0 and g.prob_beyond(d, 1e6, "down") == 1.0


def test_sesgo_de_puts_engorda_la_cola_izquierda():
    plana = g.implied_distribution(cadena([VTO], lambda k: 0.20), 100.0, AHORA, VTO)
    sesgo = g.implied_distribution(cadena([VTO], lambda k: 0.20 + 0.8 * max(0.0, math.log(100.0 / k))), 100.0, AHORA, VTO)
    assert sesgo["q"]["5"] < plana["q"]["5"]


def test_prob_touch_acotada():
    assert g.prob_touch(0.1) == 0.2
    assert g.prob_touch(0.7) == 1.0


def test_sin_dato():
    pocos = cadena([VTO], lambda k: 0.20, ks=[99.0, 100.0, 101.0])
    assert g.implied_distribution(pocos, 100.0, AHORA, VTO) is None
    casi = np.datetime64("2026-12-01T16:00")
    ch = cadena([casi], lambda k: 0.20)
    assert g.implied_distribution(ch, 100.0, datetime(2026, 12, 1, 15, 45), casi) is None


if __name__ == "__main__":
    fallos = 0
    for nombre, f in sorted(globals().items()):
        if nombre.startswith("test_") and callable(f):
            try:
                f()
                print("ok  ", nombre)
            except AssertionError as e:
                fallos += 1
                print("FALLO", nombre, e)
    sys.exit(1 if fallos else 0)
