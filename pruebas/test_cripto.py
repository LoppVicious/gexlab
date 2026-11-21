"""Pruebas sin red de cripto_calc.py (seccion Crypto). Uso: python pruebas/test_cripto.py"""
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import numpy as np  # noqa: E402

import cripto_calc as cc  # noqa: E402

AHORA = datetime(2026, 11, 20, 12, 0, tzinfo=timezone.utc)


def fila(nombre, oi, iv, fw):
    return {"instrument_name": nombre, "open_interest": oi, "mark_iv": iv, "underlying_price": fw, "volume": 1}


def test_vencimiento():
    assert cc.vencimiento("4DEC26") == datetime(2026, 12, 4, 8, 0, tzinfo=timezone.utc)
    assert cc.vencimiento("24SEP27") == datetime(2027, 9, 24, 8, 0, tzinfo=timezone.utc)


def test_cadena_descarta():
    ch = cc.cadena([fila("BTC-27NOV26-60000-C", 10, 50, 61000), fila("BTC-19NOV26-60000-C", 10, 50, 61000),
                    fila("BTC-27NOV26-60000-P", 10, 0, 61000), fila("BTC-PERPETUAL", 1, 1, 1),
                    fila("XRP_USDC-27NOV26-2d5-C", 10, 80, 2.4)], AHORA)
    assert ch["K"].tolist() == [60000.0, 2.5]     # vencido, sin IV y perpetuo fuera
    assert abs(ch["iv"][0] - 0.5) < 1e-12


def test_max_pain():
    K = np.array([90.0, 100.0, 110.0, 90.0, 100.0, 110.0])
    call = np.array([True, True, True, False, False, False])
    oi = np.array([1.0, 5.0, 1.0, 1.0, 5.0, 1.0])
    assert cc.max_pain(K, call, oi) == 100.0


def test_gex_signo_y_flip():
    # puts grandes por debajo y calls grandes por encima: GEX negativa abajo, positiva arriba, flip entre medias
    rows = [fila("BTC-25DEC26-55000-P", 5000, 50, 60000), fila("BTC-25DEC26-65000-C", 5000, 50, 60000)]
    ch = cc.cadena(rows, AHORA)
    g = cc.gex(ch, 60000.0)
    assert g["call_wall"] == 65000.0 and g["put_wall"] == 55000.0
    assert g["perfil"][0] < 0 < g["perfil"][-1]
    assert g["flip"] and 55000 < g["flip"] < 65000


def test_estructura_rr():
    # sonrisa con puts mas caras: RR25 negativo
    rows = []
    for k in range(40000, 82000, 2000):
        iv = 50 + max(0, (60000 - k) / 1000) * 0.8 + max(0, (k - 60000) / 1000) * 0.2
        rows += [fila(f"BTC-25DEC26-{k}-C", 10, iv, 60000), fila(f"BTC-25DEC26-{k}-P", 10, iv, 60000)]
    t = cc.estructura(cc.cadena(rows, AHORA), AHORA)
    assert len(t) == 1 and abs(t[0]["atm"] - 50) < 0.5 and t[0]["rr25"] < -2


def test_vol_realizada_y_percentil():
    assert cc.vol_realizada([100.0] * 31) == 0.0
    assert cc.vol_realizada([100.0] * 10) is None
    assert cc.percentil([1, 2, 3, 4], 3) == 75.0


def test_onchain_y_lectura():
    filas = [{"time": f"2026-{1 + i // 28:02d}-{1 + i % 28:02d}", "PriceUSD": 60000, "CapMrktCurUSD": 1.2e12,
              "CapMVRVCur": 1.2, "SplyCur": 2e7, "FlowInExUSD": 1e8, "FlowOutExUSD": 3e8, "SplyExNtv": 2.7e6}
             for i in range(60)]
    oc = cc.onchain(filas, 40000.0, sth=[["2026-11-13", 75000.0]], lth=[["2026-11-13", 48000.0]])
    assert abs(oc["rp"] - 50000) < 1e-6 and oc["mvrv"] == 0.8 and oc["flujo7"] == -1.4e9
    a = {"spot": 40000.0, "chg7": -10.0, "chg30": -25.0, "onchain": oc,
         "gex": {"all": {"flip": 45000.0}}, "vol": {"rr25_30": -6.0}, "futuros": {"funding_7d": -3.0}}
    lec = cc.lectura(a, {"fng": {"valor": 10}})
    assert lec["especial"] == "Capitulation zone" and lec["tend"] == -3 and lec["pos"] >= 3
    caro = {**oc, "mvrv": 3.5}
    assert cc.lectura({**a, "onchain": caro}, {"fng": {"valor": 50}})["especial"] == "Overheated"
    nv = cc.niveles(40000.0, {"flip": 45000.0, "call_wall": 50000.0, "put_wall": 38000.0}, oc, [])
    assert [n["id"] for n in nv] == ["sth", "cw", "rp", "lth", "flip", "pw"]   # de mayor a menor precio
    assert nv[-1]["dist"] == -5.0


def _fechas(n):
    from datetime import date, timedelta
    return [(date(2020, 1, 1) + timedelta(days=i)).isoformat() for i in range(n)]


def test_backtest():
    f = _fechas(300)
    p = [100.0 * 1.001 ** i for i in range(300)]                 # sube siempre
    act = [None] * 10 + [False] * 40 + [True] * 5 + [False] * 245
    b = cc.backtest(f, p, act)
    assert b["casos"] == [f[50]] and b["desde"] == f[10] and b["hoy"] is False and b["tipo"] == "estado"
    e = b["h"]["30"]
    assert e["n"] == 1 and e["pos"] == 100 and abs(e["mediana"] - (1.001 ** 30 - 1) * 100) < 0.1
    # cruce: hace falta `previo` dias sin la condicion y 30 de enfriamiento entre casos
    act2 = [False] * 20 + [True] * 2 + [False] * 3 + [True] * 2 + [False] * 273
    b2 = cc.backtest(f, p, act2, previo=14)
    assert b2["casos"] == [f[20]] and b2["hoy"] is None and b2["tipo"] == "cruce"


def test_mineros_y_senales():
    f = _fechas(800)
    filas = [{"time": d, "PriceUSD": 100 + i, "HashRate": 1e8 * (0.5 if 500 <= i < 560 else 1.0),
              "IssTotUSD": 1e7, "CapMVRVCur": 1.5} for i, d in enumerate(f)]
    m = cc.mineros(filas)
    assert m["estado"] == "healthy" and m["ultima_compra"] is not None and abs(m["puell"] - 1) < 1e-9
    ids = [s["id"] for s in cc.senales(filas)]
    assert "hash_compra" in ids
    assert "hash_compra" not in [s["id"] for s in cc.senales(filas, mineria=False)]


def test_liquidez():
    peg = [{"symbol": "USDT", "name": "Tether", "circulating": {"peggedUSD": 110}, "circulatingPrevWeek": {"peggedUSD": 100},
            "circulatingPrevMonth": {"peggedUSD": 100}},
           {"symbol": "USDC", "name": "USD Coin", "circulating": {"peggedUSD": 90}, "circulatingPrevWeek": {"peggedUSD": 100},
            "circulatingPrevMonth": {"peggedUSD": 100}}]
    lq = cc.liquidez(peg, None)
    assert lq["total"] == 200 and lq["c30"] == 0.0 and lq["top"][0]["sym"] == "USDT" and lq["top"][0]["c7"] == 10.0


def test_funding_diario():
    t0 = int(datetime(2026, 1, 1, tzinfo=timezone.utc).timestamp() * 1000)
    horas = [{"timestamp": t0 + h * 3600000, "interest_1h": 0.00001} for h in range(24 + 5)]   # dia completo + 5 h
    f = cc.funding_diario(horas)
    assert f == [["2026-01-01", round(24 * 0.00001 * 365 * 100, 3)]]


def test_senales_derivados_y_series():
    f = _fechas(800)
    filas = [{"time": d, "PriceUSD": 100 * (1.001 ** i), "CapMVRVCur": 1.5, "CapMrktCurUSD": 1e9, "SplyCur": 1e7}
             for i, d in enumerate(f)]
    funding = [[d, 10.0 if i < 400 or i >= 420 else -5.0] for i, d in enumerate(f)]
    okx = {d: [1e9 if i < 700 else 8e8, 3.5 if i > 750 else 2.0] for i, d in enumerate(f)}
    hist = {f[-1]: {"BTC": {"rr25_30": -10.0, "gex": -5.0}}}
    s = {x["id"]: x for x in cc.senales(filas, funding=funding, okx=okx, hist=hist, sym="BTC")}
    assert s["funding_negativo"]["grupo"] == "derivados" and s["funding_negativo"]["casos"]
    assert "oi_flush" in s and "lsr_alto" in s and s["lsr_alto"]["hoy"] is True
    assert s["puts_caras"]["hoy"] is True and s["puts_caras"]["h"]["90"]["n"] == 0   # sin historia aun
    ls = cc.series_largas(filas, funding=funding, okx=okx, mineria=False)
    assert len(ls["d"]) == 800 and len(ls["funding"]) == 800 and ls["rp"][-1] == round(1e9 / 1.5 / 1e7, 2)
    assert ls["rv30"][0] is None and ls["rv30"][-1] is not None


if __name__ == "__main__":
    n = 0
    for nombre, f in list(globals().items()):
        if nombre.startswith("test_"):
            f()
            n += 1
    print(f"test_cripto: {n} pruebas OK")
