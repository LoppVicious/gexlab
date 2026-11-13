"""Pruebas sin red del report semanal: report_calc.py y el armado del paquete de report_semanal.py.
Uso: .venv/Scripts/python.exe pruebas/test_report.py"""
import math
import os
import sys
from datetime import date, timedelta

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import report_calc as rc  # noqa: E402


def laborables(n, desde="2024-01-01"):
    out, d = [], date.fromisoformat(desde)
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += timedelta(days=1)
    return out


def cierres(fechas, rets, inicio=100.0):
    """[(fecha, cierre)] con el primer cierre = inicio y luego cada retorno."""
    out, c = [(fechas[0], inicio)], inicio
    for f, r in zip(fechas[1:], rets):
        c *= 1 + r
        out.append((f, c))
    return out


def test_percentil():
    assert rc.percentil(5, list(range(1, 11)), minimo=1) == 50.0
    assert rc.percentil(0, [1, 2], minimo=1) == 0.0
    assert rc.percentil(None, [1]) is None and rc.percentil(1, []) is None
    assert rc.percentil(5, list(range(1, 11))) is None and rc.percentil(5, list(range(100))) == 6.0
    assert rc.extremo(10) and rc.extremo(90) and not rc.extremo(50) and not rc.extremo(None)


def test_vol_sub_baj():
    v = rc.vol_sub_baj([0.01, -0.02, 0.01, -0.02])
    assert v == {"sube": 15.9, "baja": 31.7, "cociente": 0.5}, v
    v = rc.vol_sub_baj([0.01])
    assert v["baja"] is None and v["cociente"] is None
    assert rc.vol_anual([0.01, -0.01]) == 15.9


def test_bloque_vol_real():
    f = laborables(420)
    hist = [0.005 if i % 2 else -0.005 for i in range(414)]
    semana = [0.001, -0.03, 0.001, -0.03, 0.001]
    rets = hist + semana
    spx = cierres(f, rets)
    vix = cierres(f, [-r * 3 for r in rets], 20.0)
    b = rc.bloque_vol_real({"SPX": spx}, vix, f[-5:])
    d = b["datos"]["SPX"]
    assert d["semana"]["cociente"] is not None and d["semana"]["cociente"] < 0.1, d["semana"]
    assert d["semana"]["pct"] == 0.0
    assert d["rvol20"]["pct"] >= 99   # las ventanas de los dias previos ya incluyen las caidas
    assert b["destacado"] and any("subida/bajada" in x for x in b["por_que"]), b["por_que"]
    assert len(d["mensual"]) <= 24 and d["mensual"][-1][0] == f[-1][:7]



def test_rebalanceo():
    assert math.isclose(rc.rebalanceo(1e9, 3, 0.01), 6e7)
    assert math.isclose(rc.rebalanceo(1e9, -3, 0.01), 1.2e8)


def test_bloque_etf():
    f = laborables(300)
    rets = [0.001 if i % 2 else -0.001 for i in range(294)] + [0.03] * 5
    b = rc.bloque_etf({"TQQQ": 2e10, "SQQQ": 5e9, "UPRO": 1e10}, {"QQQ": cierres(f, rets)}, f[-5:])
    d = b["datos"]
    assert d["dias"][-1]["total"] == round(rc.rebalanceo(2e10, 3, 0.03) + rc.rebalanceo(5e9, -3, 0.03)), d["dias"][-1]
    assert d["dias"][-1]["pct"] == 100.0 and d["semana"]["pct"] == 100.0
    assert "SOXL" in d["sin_aum"] and "UPRO" in d["sin_subyacente"]
    assert b["destacado"]
    try:
        rc.bloque_etf({}, {"QQQ": cierres(f, rets)}, f[-5:])
        raise AssertionError("sin AUM deberia fallar")
    except ValueError:
        pass

def cadena(iv_base, sesion="2026-11-13", dte=30):
    K = np.arange(80.0, 121.0)
    n = K.size
    dc = np.clip(0.5 - (K - 100) * 0.025, 0.01, 0.99)
    iv = iv_base + 0.002 * (100 - K)
    exp = np.datetime64(sesion, "D") + np.timedelta64(dte, "D")
    return {"K": np.concatenate([K, K]), "call": np.array([True] * n + [False] * n),
            "exp": np.array([exp.astype("datetime64[m]") + np.timedelta64(16 * 60, "m")] * (2 * n)),
            "iv": np.concatenate([iv, iv]), "delta": np.concatenate([dc, dc - 1]),
            "fwd": np.full(2 * n, 100.0), "spot": 100.0}


def test_bloque_vol_strike():
    b = rc.bloque_vol_strike({"SPY": (cadena(0.20), cadena(0.18))}, "2026-11-13")
    filas = b["datos"]["SPY"]
    assert [f["tenor"] for f in filas] == ["1m"], filas
    c = filas[0]["celdas"]
    assert c["25P"]["strike"] == 90.0 and c["25P"]["iv"] == 22.0, c["25P"]
    assert c["50"]["cambio"] == 2.0 and filas[0]["skew_25_cambio"] == 0.0, (c["50"], filas[0])
    assert b["destacado"] and "ATM" in b["por_que"][0]


def test_bloque_gamma():
    s = lambda spot, flip, cw: {"spot": spot, "flip": flip, "call_wall": cw, "put_wall": 95.0, "net_per_pct": 0.5}
    semanas = {"SPY": {"previa": ("2026-11-06", s(100.0, 99.0, 105.0)),
                       "dias": [("2026-11-09", s(101.0, 99.0, 105.0)), ("2026-11-10", s(98.0, 99.0, 110.0))]}}
    b = rc.bloque_gamma(semanas, {"SPY": [float(x) for x in range(1, 101)]})
    d = b["datos"]["SPY"]
    assert d["regimen"] == "negativa" and d["cruces"] == [{"fecha": "2026-11-10", "a": "negativa"}], d
    assert d["cambio"]["call_wall"] == 4.8 and d["net_pct"] == 0.0 and d["net_n"] == 100, d
    assert b["destacado"] and len(b["por_que"]) == 3, b["por_que"]

def test_graficos():
    try:
        import matplotlib  # noqa: F401
    except ImportError:
        print("  (sin matplotlib: se comprueba en Actions)")
        return
    import report_graficos as rg
    f = laborables(420)
    rets = [0.005 if i % 2 else -0.005 for i in range(419)]
    vr = rc.bloque_vol_real({"SPX": cierres(f, rets)}, cierres(f, [-r for r in rets], 20.0), f[-5:])
    s = lambda spot: {"spot": spot, "flip": 99.0, "call_wall": 105.0, "put_wall": 95.0, "net_per_pct": 0.5}
    gm = rc.bloque_gamma({"SPY": {"previa": ("2026-11-06", s(100.0)), "dias": [("2026-11-09", s(101.0))]}}, {})
    vs = rc.bloque_vol_strike({"SPY": (cadena(0.20), cadena(0.18))}, "2026-11-13")
    et = rc.bloque_etf({"TQQQ": 2e10}, {"QQQ": cierres(f, rets)}, f[-5:])
    pngs = [rg.gamma("SPY", gm["datos"]["SPY"]), rg.vol_real("SPX", vr["datos"]["SPX"]),
            rg.vol_strike("SPY", vs["datos"]["SPY"]), rg.etf(et["datos"])]
    assert all(p[:8] == b"\x89PNG\r\n\x1a\n" for p in pngs)

def test_aum_parsers():
    import report_semanal as rs
    ps = ("Date,ProShares Name,Ticker,NAV,Prior NAV,NAV Change (%),NAV Change ($),Shares Outstanding (000),Assets Under Management\n"
          "11/11/2026,ProShares UltraPro QQQ,TQQQ,60.4329,56.5589,6.84950,3.874,563150,34032787635\n"
          "11/12/2026,ProShares UltraPro QQQ,TQQQ,59.8834,60.4329,-0.90927,-0.5495,561300,33612552420\n")
    assert rs._aum_proshares(ps) == 33612552420.0
    dx = ('Direxion Daily Small Cap Bull 3X ETF\nTNA\nShares Outstanding:21050001\n\n\n'
          '"TradeDate","AccountTicker","StockTicker","SecurityDescription","Shares","Price","MarketValue","Cusip","HoldingsPercent"\n'
          '"11/13/2026 12:00:00 AM","TNA","","DREYFUS GOVT CASH MAN INS","274120843.95","1.0000","274120843.9500","X9USDDGCM","23.1440568346"\n'
          '"11/13/2026 12:00:00 AM","TNA","IWM","ISHARES RUSSELL 2000 ETF","2948652.0000","278.4400","821022662.8800","464287655","69.3190452007"\n')
    assert abs(rs._aum_direxion(dx) - 821022662.88 * 100 / 69.3190452007) < 1


def test_armar_paquete():
    import tempfile
    import almacen
    import report_semanal as rs

    st = almacen.Local(tempfile.mkdtemp())
    f = laborables(420, "2025-03-03")
    sesiones, previa = f[-5:], f[-6]
    for d in f[-30:]:
        st.put(f"hist500/_dias/{d}.json", b"{}", "application/json")
    lv = lambda spot: {"standard": {"spotgamma": {"all": {"spot": spot, "flip": spot - 1, "call_wall": spot + 5,
                                                         "put_wall": spot - 5, "net_per_pct": 0.3}}}}

    def mini(iv_base):   # mismo vencimiento (F + 30 dias) en todas las sesiones, para comparar a strike fijo
        ch = cadena(iv_base, sesiones[-1], 30)
        return {"symbol": "SPY", "spot": 100.0, "exps": [str(np.unique(ch["exp"])[0])], "e": [0] * ch["K"].size,
                "fwds": [100.0], "call": ch["call"].astype(int).tolist(), "K": ch["K"].tolist(),
                "oi": [1] * ch["K"].size, "vol": [0] * ch["K"].size, "iv": ch["iv"].tolist(),
                "iv_raw": ch["iv"].tolist(), "delta": ch["delta"].tolist(), "bid": [1.0] * ch["K"].size,
                "ask": [1.1] * ch["K"].size, "last": [1.0] * ch["K"].size}

    for d in [previa] + sesiones:
        almacen.put_json(st, f"hist500/SPY/{d}.json.gz", {"levels": lv(100.0), "chain": mini(0.20 if d != previa else 0.18)})
    almacen.put_json(st, "hist500/_niveles/SPY.json.gz", {d: lv(100.0 + i * 0.1) for i, d in enumerate(f[-300:])})
    rets = [0.005 if i % 2 else -0.005 for i in range(419)]
    almacen.put_json(st, "hist500/_indices_vol/historico.json.gz",
                     {"series": {"VIX": [[d, 0, 0, 0, c] for d, c in cierres(f, [-r for r in rets], 20.0)]}})
    fred = lambda serie: cierres(f, rets)
    p, graficos = rs.armar(st, sesiones[-1], fred=fred, aum=lambda sym: None,
                         precios=lambda sym: cierres(f, rets), dibujar=False)
    b = p["bloques"]
    assert p["fecha"] == sesiones[-1] and p["sesiones"] == sesiones and p["previa"] == previa
    assert b["gamma"]["estado"] == "ok" and "SPY" in b["gamma"]["datos"], b["gamma"]
    assert b["vol_strike"]["estado"] == "ok" and b["vol_strike"]["destacado"], b["vol_strike"]
    assert b["vol_real"]["estado"] == "ok" and set(b["vol_real"]["datos"]) == {"SPX", "NDX"}
    assert b["etf_apal"]["estado"] == "ausente" and "AUM" in b["etf_apal"]["motivo"], b["etf_apal"]
    assert graficos == {}
    rs.publicar(st, p, {"x": b"\x89PNG"})
    assert almacen.get_json(st, f"report/{sesiones[-1]}/paquete.json")["fecha"] == sesiones[-1]
    assert almacen.get_json(st, "report/ultimo.json") == {"fecha": sesiones[-1]}
    assert st.get(f"report/{sesiones[-1]}/g/x.png") == b"\x89PNG"


if __name__ == "__main__":
    for nombre, fn in list(globals().items()):
        if nombre.startswith("test_") and callable(fn):
            fn()
            print("ok", nombre)
