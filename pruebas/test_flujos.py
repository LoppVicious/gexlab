"""Pruebas sin red de la nota diaria de flujos: flujos_calc.py y el armado del paquete de flujos_diario.py.
Uso: .venv/Scripts/python.exe pruebas/test_flujos.py"""
import math
import os
import sys
from datetime import date, timedelta

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import flujos_calc as fc  # noqa: E402


def laborables(n, desde="2015-01-01"):
    out, d = [], date.fromisoformat(desde)
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += timedelta(days=1)
    return out


def cierres(fechas, rets, inicio=100.0):
    out, c = [(fechas[0], inicio)], inicio
    for f, r in zip(fechas[1:], rets):
        c *= 1 + r
        out.append((f, c))
    return out


def res_motor(escala=1.0, spot=7000.0):
    """Resultado minimo de gex_engine.compute: flujo = -escala x 1e9 x movimiento (gamma negativa) y mas venta con IV alta."""
    spots, ivs = [-5, -3, -2, -1, 0, 1, 2, 3, 5], [-5, -2, 0, 2, 5]
    flow = [[escala * 1e9 * (s + (0.2 * s if v > 0 and s < 0 else 0)) for v in ivs] for s in spots]
    return {"spot": spot, "scenarios": {"spot": spots, "iv": ivs, "flow": flow, "gex": []}, "regime": "positive",
            "levels": {"zero_gamma": 6900, "call_wall": 7200, "put_wall": 6800},
            "totals": {"net_per_pct": escala * 2e9, "vanna_flow": 1e8, "charm_flow": -2e8}}


def test_dealers_y_complejos():
    d = fc.dealers(res_motor())
    assert d["flujo"]["-5"] == -5e9 and d["flujo"]["5"] == 5e9
    assert d["estres"]["-5"] == -6e9 and d["estres"]["5"] == 5e9   # IV +5 en la bajada, -2 en la subida
    c = fc.complejos({"SPX": d, "SPY": fc.dealers(res_motor(0.5)), "NDX": d})
    assert c["S&P 500"]["simbolos"] == ["SPX", "SPY"] and c["S&P 500"]["estres"]["-5"] == -9e9
    assert c["Nasdaq 100"]["simbolos"] == ["NDX"] and "Russell 2000" not in c


def test_letf():
    f = laborables(300)
    c = {"QQQ": cierres(f, [0.001] * 298 + [-0.02]), "XLK": cierres(f, [0.001] * 298 + [-0.01]),
         "SPY": cierres(f, [0.0] * 299)}
    r = fc.letf({"TQQQ": 1e9, "SQQQ": 1e9, "TECL": 1e9, "UPRO": 1e9, "XXX": 5e9, "SOXL": 1e9}, c, f[-1])
    # TQQQ: 1e9 x 3 x 2 x -0.02 = -0.12e9; SQQQ: 1e9 x -3 x -4 x -0.02 = -0.24e9; TECL: -0.06e9; UPRO: 0
    cats = {x["categoria"]: x for x in r["categorias"]}
    assert list(cats) == ["Tech", "SPX"] and math.isclose(cats["Tech"]["hoy"], -0.42e9) and cats["SPX"]["hoy"] == 0
    assert cats["Tech"]["pct"] == 0.0 and cats["Tech"]["etfs"] == ["SQQQ", "TECL", "TQQQ"]   # con signo: la mayor venta
    assert math.isclose(r["por_1pct"], (6 + 12 + 6 + 6) * 1e7) and r["escenarios"]["-5"] == -5 * r["por_1pct"]
    assert "XXX" not in r["aum"] and "SOXL" in r["sin_aum"] and r["retornos_pct"]["QQQ"] == -2.0
    # con AUM guardado de un dia pasado, ese dia usa el suyo
    c2 = {"QQQ": cierres(f, [0.001] * 298 + [0.002])}
    assert fc.letf({"TQQQ": 1e9}, c2, f[-1])["pct"] == 100.0
    assert fc.letf({"TQQQ": 1e9}, c2, f[-1], {f[-2]: {"TQQQ": 1e12}})["pct"] < 100


def test_escala_dealers():
    orig = fc.CALIBRACION
    fc.CALIBRACION = [{"fecha": "a", "complejo": "S&P 500", "gamma_1pct": -7e9},
                      {"fecha": "b", "complejo": "S&P 500", "gamma_1pct": -9e9}]
    try:
        e = fc.escala_dealers({"a": -70e9, "b": -60e9, "c": -1e9})
        assert math.isclose(e["factor"], 0.125) and len(e["puntos"]) == 2   # mediana de 0,1 y 0,15
        assert fc.escala_dealers({"a": 5e9}) is None and fc.escala_dealers({}) is None   # signo distinto: no vale
    finally:
        fc.CALIBRACION = orig
    por = {"SPX": fc.dealers(res_motor())}
    b = fc.escalar({"simbolos": por, "complejos": fc.complejos(por)}, 0.1)
    x = b["simbolos"]["SPX"]
    assert x["net_motor"] == 2e9 and x["net_per_pct"] == 2e8 and x["estres"]["-5"] == -6e8 and x["estres_motor"]["-5"] == -6e9
    assert b["complejos"]["S&P 500"]["flujo"]["5"] == 5e8 and b["escala"] == 0.1
    assert fc.fila_serie({"bloques": {"dealers": {"estado": "ok", **b}}})["complejos"]["S&P 500"]["net"] == 2e9


def test_vol_control_y_cta():
    f = laborables(1500)
    rng = np.random.default_rng(1)
    rets = list(rng.normal(0.0004, 0.006, 1400)) + list(rng.normal(-0.004, 0.025, 99))
    c = cierres(f, rets)
    v = fc.vol_control(c, f[-1])
    assert v["exposicion"] < 0.5 and v["pct"] < 10           # vol alta: exposicion baja
    assert v["escenarios"]["-5"] < 0 and v["escenarios"]["5"] < 0   # un dia de 5 % hace vender en los dos sentidos
    assert v["escenarios"]["calma"] >= 0 and len(v["historia"]) == 252 and v["historia"][-1][0] == f[-1]
    t = fc.cta(c, f[-1])
    assert -1 <= t["posicion"] < 0 and t["historia"][-1] == [f[-1], t["posicion"]]
    assert t["giros"]["21"]["nivel"] == round(c[-21][1], 2)
    assert t["escenarios"]["5"] >= t["escenarios"]["-5"]
    try:
        fc.vol_control(c, "2030-01-01")
        assert False
    except ValueError:
        pass


def cadena(spot=7000.0):
    t0 = np.datetime64("2026-11-24T16:00")
    K = np.array([6500, 6800, 7000, 7250, 7250, 7500, 7000], float)
    call = np.array([False, False, False, False, False, False, True])
    oi = np.array([10000, 30000, 20000, 50000, 10000, 5000, 40000], float)
    exp = np.array(["2026-12-18T16:15", "2026-12-18T16:15", "2026-11-28T16:15", "2026-12-31T16:15",
                    "2026-12-18T16:15", "2027-03-19T16:15", "2026-12-18T16:15"], dtype="datetime64[m]")
    return {"K": K, "call": call, "oi": oi, "iv": np.full(7, 0.2), "exp": exp}, t0


def test_strikes_puts():
    ch, t0 = cadena()
    s = fc.strikes_puts(ch, 7000.0, t0)
    ks = [x["strike"] for x in s["strikes"]]
    assert ks == [6500, 6800, 7000, 7250]   # 7500 queda fuera de la banda (+5 %)
    k = next(x for x in s["strikes"] if x["strike"] == 7250)
    assert k["oi"] == 60000 and k["vencimiento"] == "2026-12-31" and math.isclose(k["vencimiento_pct"], 83.3)
    assert k["flujo_si_cierra_aqui"] > 0                          # por encima del precio: los dealers recompran
    assert next(x for x in s["strikes"] if x["strike"] == 6800)["flujo_si_cierra_aqui"] < 0
    # solo las puts del strike: 7250 por encima del precio, ITM (|delta| > 0,5) que pasan a ATM
    assert 0.5 < k["delta_hoy"] < 0.8 and k["flujo_si_cierra_aqui"] < 60000 * 100 * 0.5 * 7250
    assert next(x for x in s["strikes"] if x["strike"] == 7000)["flujo_si_cierra_aqui"] == 0
    d = fc.delta_put(7000.0, np.array([7000.0]), np.array([0.2]), np.array([0.5]))
    assert -0.5 < d[0] < -0.4


def test_asimetria_destacados_y_fila():
    comp = fc.complejos({"SPX": fc.dealers(res_motor())})
    et = {"escenarios": {"-5": -3e9, "5": 3e9}}
    vc = {"escenarios": {"-5": -2e9, "5": -2e9}}
    a = fc.asimetria(comp, et, vc)
    assert a["-5"]["total"] == -11e9 and a["5"]["total"] == 6e9 and a["cociente"] == 1.83
    assert fc.asimetria(comp, None, None)["-5"]["fuentes"] == {"Dealers S&P 500": -6e9}
    ch, t0 = cadena()
    paq = {"bloques": {"dealers": {"estado": "ok", "simbolos": {"SPX": fc.dealers(res_motor())}, "complejos": comp},
                       "asimetria": {"estado": "ok", **a}, "letf": {"estado": "ok", "pct": 95, "total": 1, "aum": {},
                                                                     "por_1pct": 2},
                       "vol_control": {"estado": "ausente", "motivo": "x"}, "cta": {"estado": "ok", "pct": 50, "posicion": 0.1},
                       "strikes": {"estado": "ok", **fc.strikes_puts(ch, 7100.0, t0)}}}
    m = fc.destacados(paq, {"S&P 500": list(np.linspace(-5e9, 1e9, 100))}, [1.0] * 50)
    assert any("Dealer gamma S&P 500" in x for x in m) and any("Asymmetry" in x for x in m)
    assert any("Leveraged ETF" in x for x in m) and not any("CTA" in x for x in m)
    assert any("7,250" in x for x in m)
    fila = fc.fila_serie(paq)
    assert fila["vc"] is None and fila["cta"] == 0.1 and fila["asim"]["cociente"] == 1.83
    assert fila["complejos"]["S&P 500"]["f-5"] == -6e9 and fila["strikes"][0][0] == 6500


def test_armado():
    """flujos_diario.armar con almacen en memoria y el motor sustituido."""
    import flujos_diario as fd

    class St:
        def __init__(self):
            self.d = {}

        def put(self, k, v, ct=None, **kw):
            self.d[k] = v

    f = laborables(1500)
    rng = np.random.default_rng(2)
    c = cierres(f, list(rng.normal(0.0003, 0.01, 1499)))
    F = f[-1]
    ch, _ = cadena()
    orig = (fd.calcular, fd._doc, fd.almacen.get_json, fd.g.chain_from_min, fd.g.risk_free)
    fd.calcular = lambda sym, cad, F: res_motor()
    fd._doc = lambda st, sym, F: {"chain": {"x": 1}} if sym == "SPY" else None
    vistos = []

    def directo(sym, F):   # SPX, NDX y RUT no estan en hist500: cadena de ahora
        vistos.append(sym)
        if sym == "RUT":
            raise ValueError("la cadena de ahora es de otro dia")
        return res_motor(), {"x": 1}
    fd.almacen.get_json = lambda st, k, default=None: default
    fd.g.chain_from_min = lambda d: ch
    fd.g.risk_free = lambda: 0.04
    cal = fc.CALIBRACION
    fc.CALIBRACION = [{"fecha": "2026-11-17", "complejo": "S&P 500", "gamma_1pct": 0.4e9}]
    try:
        paq, gr = fd.armar(St(), F, {f[-2]: {"asim": {"cociente": 1.0}, "aum": {"TQQQ": 1e9}}},
                           aum=lambda e: 1e9, precios=lambda s: c, dibujar=False, directo=directo)
    finally:
        fd.calcular, fd._doc, fd.almacen.get_json, fd.g.chain_from_min, fd.g.risk_free = orig
        fc.CALIBRACION = cal
    b = paq["bloques"]
    assert all(b[k]["estado"] == "ok" for k in ("dealers", "letf", "vol_control", "cta", "strikes", "asimetria")), b
    assert set(b["dealers"]["simbolos"]) == {"SPX", "SPY", "NDX", "QQQ", "IWM"} and paq["previa"]["fecha"] == f[-2]
    assert "SPY" not in vistos and {"SPX", "NDX", "RUT", "QQQ"} <= set(vistos)
    assert paq["siguiente_sesion"] > F and gr == {}
    # calibracion sin la fila de ese dia: SPY de esa fecha x (SPX + SPY) / SPY de hoy = 2e9 x 2 = 4e9 -> factor 0,1
    assert b["dealers"]["escala"] == 0.1 and b["dealers"]["simbolos"]["SPX"]["net_motor"] == 2e9


def test_en_sesion():
    import flujos_diario as fd
    antes = fd.g.now_ny
    with fd.en_sesion("2026-11-24"):
        assert fd.g.now_ny().strftime("%Y-%m-%d %H:%M") == "2026-11-24 16:20"
        assert fd.g.quote_time(fd.g.now_ny()).hour == 16 and not fd.g.flow_valid("x", None)
    assert fd.g.now_ny is antes


def test_graficos():
    try:
        import flujos_graficos as fg
    except ImportError:   # sin matplotlib en el PC
        return
    comp = fc.complejos({"SPX": fc.dealers(res_motor()), "QQQ": fc.dealers(res_motor(0.3))})
    a = fc.asimetria(comp, {"escenarios": {"-5": -3e9, "5": 3e9}}, None)
    ch, t0 = cadena()
    f = laborables(1500)
    c = cierres(f, list(np.random.default_rng(3).normal(0.0003, 0.01, 1499)))
    subs = {v[0] for v in fc.ETFS.values()}
    et = fc.letf({e: 2e9 for e in fc.ETFS}, {s: c for s in subs}, f[-1])
    paq = {"fecha": "2026-11-24", "bloques": {"letf": {"estado": "ok", **et},
        "asimetria": {"estado": "ok", **a}, "dealers": {"estado": "ok", "complejos": comp},
        "strikes": {"estado": "ok", **fc.strikes_puts(ch, 7000.0, t0)},
        "vol_control": {"estado": "ok", **fc.vol_control(c, f[-1])}, "cta": {"estado": "ok", **fc.cta(c, f[-1])}}}
    out = fg.todos(paq)
    assert set(out) == {"asimetria", "dealers", "strikes_puts", "sistematicos", "letf"}
    assert all(v[:4] == b"\x89PNG" for v in out.values()) and paq["bloques"]["cta"]["graficos"] == ["sistematicos"]
    if os.environ.get("FLUJOS_PNG"):
        for k, v in out.items():
            open(os.path.join(os.environ["FLUJOS_PNG"], f"{k}.png"), "wb").write(v)


if __name__ == "__main__":
    n = 0
    for nombre, fn in sorted(globals().items()):
        if nombre.startswith("test_") and callable(fn):
            fn()
            n += 1
    print(f"ok: {n} pruebas")
