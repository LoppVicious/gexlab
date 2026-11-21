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


def test_level_dists_proximo_y_viernes():
    exps = ["2026-12-02T16:00", "2026-12-04T16:00", "2026-12-11T16:00"]
    ds = g.level_dists(cadena(exps, lambda k: 0.20), 100.0, AHORA, "SPX")
    assert [d["exp"] for d in ds] == ["2026-12-02", "2026-12-04"]
    # el proximo ya es viernes: solo uno
    ds = g.level_dists(cadena(["2026-12-04T16:00", "2026-12-11T16:00"], lambda k: 0.20), 100.0, AHORA, "SPY")
    assert [d["exp"] for d in ds] == ["2026-12-04"]
    # VIX: miercoles
    ds = g.level_dists(cadena(["2026-12-01T16:00", "2026-12-02T16:00", "2026-12-04T16:00"], lambda k: 0.8, F=18.0,
                              ks=np.arange(10.0, 40.05, 0.1)), 18.0, AHORA, "VIX")
    assert [d["exp"] for d in ds] == ["2026-12-01", "2026-12-02"]


def test_level_probs():
    ds = g.level_dists(cadena([VTO], lambda k: 0.20), 100.0, AHORA, "SPY")
    lp = g.level_probs(ds, 100.0, {"call_wall": 105.0, "put_wall": 95.0, "flip": 98.0})
    r = lp[0]
    assert r["exp"] == "2026-12-11"
    assert 0 < r["call_wall"]["close"] < 0.5 and abs(r["call_wall"]["touch"] - 2 * r["call_wall"]["close"]) < 2e-4
    assert 0 < r["put_wall"]["close"] < 0.5
    assert r["flip"]["side"] == "down" and r["flip"]["close"] > r["put_wall"]["close"]
    # spot ya por encima del Call Wall: sin toque; nivel ausente: fuera
    lp = g.level_probs(ds, 100.0, {"call_wall": 99.0, "put_wall": None, "flip": None})
    assert "touch" not in lp[0]["call_wall"] and "put_wall" not in lp[0] and "flip" not in lp[0]


def test_probs_snap():
    lp = [{"exp": "2026-12-11", "days": 10, "call_wall": {"close": 0.12, "touch": 0.24},
           "put_wall": {"close": 0.18, "touch": 0.36}, "flip": {"side": "down", "close": 0.41, "touch": 0.82}}]
    assert g.probs_snap(lp) == {"pc_exp": "2026-12-11", "pc_cw": 0.12, "pc_pw": 0.18, "pc_flip": 0.41}
    assert g.probs_snap([]) == {"pc_exp": None, "pc_cw": None, "pc_pw": None, "pc_flip": None}


def test_completar_probs_rellena_dias_antiguos():
    ch = cadena(["2026-12-02T16:00", "2026-12-04T16:00"], lambda k: 0.20)
    viejo = {"spot": 100.0, "call_wall": 101.0, "put_wall": 99.0, "flip": 99.5}   # vencimiento a un dia: sigma ~1 %
    nuevo = {"spot": 100.0, "call_wall": 105.0, "put_wall": 95.0, "flip": 98.0, "pc_cw": 0.5}
    doc = {"symbol": "SPY", "session": "2026-12-01", "chain": {"falso": True},
           "levels": {"standard": {"spotgamma": {"0": viejo, "45": nuevo}}}}
    orig = g.chain_from_min
    g.chain_from_min = lambda d: ch
    try:
        g.completar_probs(doc)
    finally:
        g.chain_from_min = orig
    assert viejo["pc_exp"] == "2026-12-02" and 0 < viejo["pc_cw"] < 0.5 and viejo["pc_flip"] > 0
    assert nuevo["pc_cw"] == 0.5          # los que ya lo tienen no se tocan


def test_alas_sin_bid_y_picos_fuera():
    # alas como las del SPX de Tradier: calls lejanas sin bid con IV de 170-500 % y un pico suelto con bid
    limpia = g.implied_distribution(cadena([VTO], lambda k: 0.20), 100.0, AHORA, VTO)
    ch = cadena([VTO], lambda k: 0.20)
    ch["bid"] = np.ones(ch["K"].shape)
    lejos = (ch["K"] >= 112) & (ch["K"] <= 116)
    ch["iv"][lejos] = 3.0
    ch["bid"][lejos] = 0.0
    ch["iv"][(ch["K"] == 92.0)] = 0.45
    d = g.implied_distribution(ch, 100.0, AHORA, VTO)
    assert d["clip"] < 0.01, d["clip"]
    assert abs(d["q"]["50"] - limpia["q"]["50"]) < 0.05 and abs(d["q"]["5"] - limpia["q"]["5"]) < 0.1


def test_dist_json_y_dist_for_day():
    import json
    ch = cadena(["2026-12-02T16:00", "2026-12-11T16:00"], lambda k: 0.20)
    d = g.dist_for_day(ch, 100.0, AHORA, "2026-12-11", n=200)
    assert d and d["exp"] == "2026-12-11"
    j = g.dist_json(d)
    assert len(j["x"]) == 200 and max(j["pdf"]) == 1.0 and j["cdf"][-1] == 1.0
    assert set(j) == {"exp", "days", "T", "fwd", "atm_iv", "x", "pdf", "logn", "cdf", "q", "clip", "noisy"}
    json.dumps(j)                         # serializable
    assert g.dist_for_day(ch, 100.0, AHORA, "2026-12-09") is None


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
