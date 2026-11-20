"""Pruebas sin red del social diario (social_diario.py y, si hay matplotlib, social_graficos.py).
Uso: .venv/Scripts/python.exe pruebas/test_social.py   (con SOCIAL_PNG=carpeta guarda los graficos para mirarlos)"""
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import social_diario as sd  # noqa: E402


def res_falso(spot=6800.0, chg=1.2, regime="negative", cw=6900, pw=6700, flip=6850):
    ks = [spot - 300 + 25 * i for i in range(25)]
    net = [(k - flip) * 1e6 for k in ks]
    return {"spot": spot, "prev_close": spot / (1 + chg / 100), "chg_pct": chg, "regime": regime,
            "levels": {"call_wall": cw, "put_wall": pw, "flip": flip, "vt": flip - 50, "abs_gamma": cw},
            "totals": {"net_per_pct": -2.5e9 if regime == "negative" else 3e9},
            "moves": {"d1": {"pct": 0.8, "lo": spot * 0.992, "hi": spot * 1.008, "session": "2026-11-20"},
                      "d5": {"pct": 1.9, "lo": spot * 0.981, "hi": spot * 1.019}},
            "front_expiry": "2026-11-20", "front_share": 0.21, "strikes": ks, "net": net, "timestamp": "2026-11-19 21:15:00"}


def test_indice():
    b = sd.bloque_indice(res_falso(chg=1.2), 0.6, {"regimen": "positive", "niveles": {"call_wall": 6950, "put_wall": 6700, "flip": 6850}})
    assert b["cambio_vs_esperado"] == 2.0
    assert "move_vs_implied_big" in b["motivos"] and "regime_flip" in b["motivos"] and b["destacado"]
    assert b["niveles_movidos"] == {"call_wall": [6950, 6900]}
    assert b["siguiente"]["sesion"] == "2026-11-20" and b["gamma_proximo_pct"] == 21.0
    calma = sd.bloque_indice(res_falso(chg=0.1, cw=6900, pw=6600), 0.8, None)
    assert calma["motivos"] == ["move_vs_implied_small"] and calma["regimen_previo"] is None
    cerca = sd.bloque_indice(res_falso(chg=0.5, cw=6820), None, None)
    assert cerca["cambio_vs_esperado"] is None and cerca["motivos"] == ["near_call_wall"]


def test_acciones():
    dias = [f"2026-10-{d:02d}" for d in range(1, 23)] + ["2026-11-18", "2026-11-19"]
    idx = {d: {"AAA": [0.32, 0.36, 100.0, 0.0, 1000.0, 1e6], "BBB": [32.0, 36.0, 50.0, 0.0, 500.0, 1e6],
               "VIX": [1.0, 1.0, 20.0, 0, 1, 1]} for d in dias}
    idx["2026-11-19"] = {"AAA": [0.40, 0.45, 106.0, 0.0, 5000.0, 1e6], "BBB": [33.0, 36.0, 49.5, 0.0, 600.0, 1e6],
                         "VIX": [1.0, 1.0, 30.0, 0, 1, 1]}
    b = sd.bloque_acciones(idx, "2026-11-19", excluir={"VIX"})
    a = b["mayor_sigma"][0]
    assert a["sym"] == "AAA" and b["n"] == 2 and b["suben"] == 1
    assert abs(a["z"] - 6.0 / (32 / 252 ** 0.5)) < 0.01   # 6 % con IV de 32 % -> 2,98 sigmas
    assert b["mayor_salto_iv"][0]["iv_cambio"] == 8.0      # la IV en % se normaliza igual que en tanto por uno
    assert b["mayor_volumen_opciones"][0]["opciones_vs_media"] == 5.0
    assert set(b["motivos"]) == {"big_sigma_move", "iv_jump", "options_volume_spike"}
    try:
        sd.bloque_acciones(idx, "2026-11-20")
        raise AssertionError("debia fallar sin la sesion")
    except ValueError:
        pass


def test_vix():
    cot = {"VIX": {"close": 22.0, "prev_day_close": 19.0}, "VIX9D": {"close": 24.0, "prev_day_close": 19.0},
           "VIX3M": {"current_price": 21.0, "prev_day_close": 20.0}, "VIX6M": {"close": 21.5}, "VIX1Y": {}}
    serie = [(f"d{i}", 12.0 + (i % 10)) for i in range(300)]
    v = sd.bloque_vix(cot, serie)
    assert round(v["cambio_pct"], 1) == 15.8 and v["invertida"] and v["percentil_1a"] == 100
    assert set(v["motivos"]) == {"big_vix_move", "term_structure_inverted", "vix_high_percentile"}
    assert v["curva_previa"]["VIX"] == 19.0 and v["curva"]["VIX1Y"] is None and v["curva"]["VIX3M"] == 21.0
    assert sd.bloque_vix({"VIX": {"close": 15.0}}, [])["curva_previa"] is None


def test_segunda_pasada():
    import tempfile
    import almacen
    st = almacen.Local(tempfile.mkdtemp())
    dias = [f"2026-10-{d:02d}" for d in range(1, 23)] + ["2026-11-18"]
    idx = {d: {"AAA": [0.32, 0.36, 100.0, 0.0, 1000.0, 1e6]} for d in dias}
    idx["2026-11-19"] = {"AAA": [0.40, 0.45, 106.0, 0.0, 5000.0, 1e6]}
    almacen.put_json(st, "hist500/_skew.json.gz", idx)
    paq = {"fecha": "2026-11-19", "indices": {"SPX": {"estado": "ok"}}, "acciones": {"estado": "ausente", "motivo": "x"}}
    graficos = sd.anadir_acciones(st, paq)
    assert paq["acciones"]["estado"] == "ok" and paq["acciones"]["mayor_sigma"][0]["sym"] == "AAA"
    assert paq["indices"] == {"SPX": {"estado": "ok"}} and "acciones_generado" in paq
    assert set(graficos) <= {"acciones_sigma"}


def cot_falsas():
    c = lambda u, p: {"ultimo": u, "previo": p, "cambio_pct": (u / p - 1) * 100}
    out = {"TNX": c(42.5, 41.2), "TLT": c(80.0, 81.0), "IEF": c(91.0, 91.2), "HYG": c(78.0, 78.5), "UUP": c(28.0, 27.9),
           "GLD": c(380.0, 370.0), "SLV": c(40.0, 40.2), "USO": c(70.0, 71.0), "IBIT": c(35.0, 37.0),
           "SPY": c(717.0, 732.0), "RSP": c(180.0, 184.5), "QQQ": c(645.0, 660.0), "IWM": c(272.0, 278.0)}
    for i, s in enumerate(sd.SECTORES):
        out[s] = c(100.0 - i * 0.3 - (0 if s != "XLU" else -2), 100.0)
    return out


def test_mercados():
    m = sd.bloque_mercados(cot_falsas(), {"BTC": {"ultimo": 62018, "cambio_24h_pct": -2.7}})
    tnx = m["grupos"]["Rates"][0]
    assert tnx["rendimiento_pct"] == 4.25 and tnx["cambio_pb"] == 13.0
    assert set(m["grandes"]) == {"TNX", "GLD", "IBIT"} and "big_cross_asset_move" in m["motivos"]
    assert m["amplitud"]["sectores_total"] == 11 and m["amplitud"]["sectores_suben"] == 1
    assert "broad_selloff" in m["motivos"] and m["amplitud"]["rsp_vs_spy"] == -0.39
    assert m["grupos"]["Crypto spot"][0]["sym"] == "BTC" and m["sectores"][0]["sym"] == "XLU"
    assert "ETHA" not in [x["sym"] for x in m["grupos"]["Crypto"]]
    try:
        sd.bloque_mercados({})
        raise AssertionError("debia fallar sin datos")
    except ValueError:
        pass


def test_manana():
    evs = [{"date": "2026-11-20", "time": "10:00", "titulo": "UoM", "imp": 2},
           {"date": "2026-11-20", "time": "08:30", "titulo": "CPI", "imp": 3},
           {"date": "2026-11-20", "time": "09:00", "titulo": "Minor", "imp": 1},
           {"date": "2026-11-21", "time": "08:30", "titulo": "Otro", "imp": 3}]
    m = sd.bloque_manana(evs, "2026-11-20")
    assert [e["evento"] for e in m["eventos"]] == ["CPI", "UoM"] and m["opex_mensual"]
    assert set(m["motivos"]) == {"monthly_opex", "high_impact_event"} and m["dia"] == "Friday"
    assert not sd.bloque_manana([], "2026-11-23")["destacado"]


def test_sesion_cerrada():
    assert sd.ultima_sesion_cerrada(datetime(2026, 11, 19, 17, 30)) == "2026-11-19"
    assert sd.ultima_sesion_cerrada(datetime(2026, 11, 19, 3, 0)) == "2026-11-18"
    assert sd.ultima_sesion_cerrada(datetime(2026, 11, 22, 12, 0)) == "2026-11-20"   # domingo


def test_graficos():
    try:
        import social_graficos as sg
    except ImportError:
        print("sin matplotlib: graficos sin probar")
        return
    r = res_falso()
    b = sd.bloque_indice(r, 0.6, None)
    b2 = sd.bloque_indice(res_falso(spot=25100, chg=-0.4, regime="positive", cw=25500, pw=24800, flip=24900), 0.9, None)
    idx = {"SPX": b, "NDX": b2, "RUT": b}
    acc = [{"sym": s, "cambio_pct": c, "z": z} for s, c, z in (("NVDA", 6.2, 3.1), ("TSLA", -5.0, -2.2), ("AAPL", 1.1, 0.9))]
    v = {"cierre": 22.0, "cambio_pct": 15.8, "percentil_1a": 91, "curva": {"VIX9D": 24, "VIX": 22, "VIX3M": 21, "VIX6M": 21.5, "VIX1Y": 22},
         "curva_previa": {"VIX9D": 19, "VIX": 19, "VIX3M": 20, "VIX6M": 21, "VIX1Y": 21.8}}
    pngs = {"indices_niveles": sg.tabla_indices("2026-11-19", "2026-11-20", idx), "perfil_spx": sg.perfil("SPX", r, b, "2026-11-20"),
            "acciones_sigma": sg.acciones("2026-11-19", acc), "vix_curva": sg.vix("2026-11-19", v),
            "playbook": sg.playbook("2026-11-19", "2026-11-20", idx, {"estado": "ok", "opex_mensual": True,
                                                                     "eventos": [{"hora": "10:00", "evento": "UoM sentiment"}]}),
            "mercados": sg.mercados("2026-11-19", sd.bloque_mercados(cot_falsas()))}
    for n, png in pngs.items():
        assert png[:8] == b"\x89PNG\r\n\x1a\n", n
    if os.environ.get("SOCIAL_PNG"):
        for n, png in pngs.items():
            with open(os.path.join(os.environ["SOCIAL_PNG"], n + ".png"), "wb") as f:
                f.write(png)


if __name__ == "__main__":
    for k, f in list(globals().items()):
        if k.startswith("test_"):
            f()
            print("ok", k)
