"""GEX Lab - seccion Crypto: descarga, calcula (cripto_calc.py) y publica pub/cripto.json.

Lo lanza cripto.yml cada 15 min (cron del Worker, 24/7). Fuentes gratis y sin clave: Deribit, OKX, CoinGecko,
CoinMetrics Community, bitcoin-data.com, DefiLlama y alternative.me. Los datos diarios se guardan en
cripto/diario.json y solo se renuevan cuando caducan. Diseno en docs/CRIPTO.md.

Uso: GEX_ALMACEN=r2 python cripto.py   (en local: GEX_ALMACEN=local:./data/x)
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.parse
from datetime import datetime, timedelta, timezone

import almacen
import cripto_calc as cc
import gex_engine as g

ACTIVOS = ("BTC", "ETH")
CG_ID = {"BTC": "bitcoin", "ETH": "ethereum"}
PUB = "pub/cripto.json"
DIARIO = "cripto/diario.json"
CADUCA_H = 6        # datos diarios: se renuevan si tienen mas de 6 h
CADUCA_BD_H = 20    # bitcoin-data: 15 peticiones al dia; dos por dia como mucho
REINTENTO_H = 2     # tras un fallo de una fuente diaria
DIARIO_V = 2        # forma de cripto/diario.json; al cambiarla se renuevan CoinMetrics, DVOL y Fear & Greed
HIST = "cripto/hist.json"   # una foto diaria de los derivados (fecha UTC): percentiles propios y backtests futuros
CM_METRICAS = ("PriceUSD,CapMrktCurUSD,CapMVRVCur,SplyCur,FlowInExUSD,FlowOutExUSD,SplyExNtv,"
               "HashRate,IssTotUSD,AdrActCnt,TxCnt")
CM_DESDE = "2012-01-01"
DVOL_DESDE = datetime(2021, 3, 24, tzinfo=timezone.utc)   # primer dia del DVOL
# bitcoin-data.com: 4 peticiones al dia como mucho (cupo de 15)
BD_SERIES = (("bd_sth", "sth-realized-price", "sthRealizedPrice"), ("bd_lth", "lth-realized-price", "lthRealizedPrice"),
             ("bd_sopr", "sopr", "sopr"), ("bd_sth_sopr", "sth-sopr", "sthSopr"))
DERIBIT = "https://www.deribit.com/api/v2/public/"
OKX = "https://www.okx.com/api/v5/"
SERIES = "pub/cripto_series.json"   # historias largas para ampliar graficos y las senales (la web lo pide al usarlo)
# mapa de liquidaciones: activos con perpetuos en estos exchanges (codigos de Coinalyze); la web pide los datos por
# el Worker (/api/liq), que pone la clave COINALYZE_API_KEY
LIQ_MERCADOS = "pub/liq_mercados.json"
LIQ_EXCH = {"A": "Binance", "6": "Bybit", "3": "OKX", "H": "Hyperliquid"}
COINALYZE = "https://api.coinalyze.net/v1/"
FUNDING_DESDE = datetime(2019, 5, 1, tzinfo=timezone.utc)   # funding horario del perpetuo de Deribit
# redes con direcciones activas y transacciones gratis en CoinMetrics (SOL, BNB y DOT no lo estan)
REDES = {"BTC": "Bitcoin", "ETH": "Ethereum", "TRX": "Tron", "XRP": "XRP Ledger", "LTC": "Litecoin",
         "DOGE": "Dogecoin", "BCH": "Bitcoin Cash", "XLM": "Stellar", "ADA": "Cardano"}


def http_json(url: str):
    try:
        b = g._fetch_python(url)
    except g.NotFound:
        raise
    except Exception:  # noqa: BLE001  (certificados o red: el curl del sistema)
        b = g._fetch_system(url)
    return json.loads(b.decode("utf-8"))


def deribit(metodo: str, **q):
    d = http_json(DERIBIT + metodo + "?" + urllib.parse.urlencode(q))
    if "result" not in d:
        raise ValueError(f"Deribit {metodo}: {d.get('error')}")
    return d["result"]


def okx(ruta: str, **q):
    d = http_json(OKX + ruta + "?" + urllib.parse.urlencode(q))
    if str(d.get("code")) != "0":
        raise ValueError(f"OKX {ruta}: {d.get('msg')}")
    time.sleep(0.3)   # rubik: 5 peticiones cada 2 s
    return d["data"]


def _ms(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)


def _dia(ms) -> str:
    return datetime.fromtimestamp(int(ms) / 1000, timezone.utc).strftime("%Y-%m-%d")


def dvol_historia(a: str, ahora: datetime) -> list:
    """DVOL diario desde su primer dia; Deribit devuelve por tramos (`continuation`)."""
    filas, fin = {}, _ms(ahora)
    for _ in range(10):
        r = deribit("get_volatility_index_data", currency=a, resolution="1D", start_timestamp=_ms(DVOL_DESDE),
                    end_timestamp=fin)
        for x in r["data"]:
            filas[_dia(x[0])] = x[4]
        if not r.get("continuation"):
            break
        fin = int(r["continuation"])
    return sorted([d, v] for d, v in filas.items())


def funding_historia(a: str, prev: list | None, ahora: datetime) -> list:
    """Funding diario del perpetuo de Deribit desde 2019, ampliando lo guardado: solo pide desde el ultimo dia
    completo (31 dias por peticion: la primera vez, unas 90)."""
    prev = prev or []
    desde = datetime.fromisoformat(prev[-1][0]).replace(tzinfo=timezone.utc) if prev else FUNDING_DESDE
    horas, t = [], desde
    while t < ahora:
        fin = min(t + timedelta(days=31), ahora)
        horas += deribit("get_funding_rate_history", instrument_name=f"{a}-PERPETUAL",
                         start_timestamp=_ms(t), end_timestamp=_ms(fin))
        t = fin
        time.sleep(0.1)
    nuevos = dict(cc.funding_diario(horas))
    out = dict(prev)
    out.update(nuevos)
    return sorted([d, v] for d, v in out.items())


def okx_historia(a: str, prev: dict | None) -> dict:
    """OI (USD) y ratio de cuentas long/short diarios de OKX: la API da 180 dias; se guardan y se amplian."""
    out = dict(prev or {})
    oi = okx("rubik/stat/contracts/open-interest-volume", ccy=a, period="1D")
    lsr = {_dia(x[0]): float(x[1]) for x in okx("rubik/stat/contracts/long-short-account-ratio", ccy=a, period="1D")}
    for x in oi:
        d = _dia(x[0])
        out[d] = [float(x[1]), lsr.get(d)]
    return dict(sorted(out.items()))


# ---------------------------------------------------------------- datos diarios
def _caducado(bloque: dict | None, horas: float, ahora: datetime) -> bool:
    if not bloque or not bloque.get("at"):
        return True
    return ahora - datetime.fromisoformat(bloque["at"]) > timedelta(hours=horas)


def diario(st, ahora: datetime, errores: dict) -> dict:
    d = almacen.get_json(st, DIARIO, {}) or {}
    cambio = False
    hace_1a = ahora - timedelta(days=400)

    def renovar(clave, horas, fn, inc=False):
        """inc: fn recibe el valor anterior y lo amplia (fuentes que se guardan por tramos)."""
        nonlocal cambio
        b = d.get(clave) or {}
        if inc:
            fn = (lambda f, prev: (lambda: f(prev)))(fn, b.get("v"))
        if not _caducado(b, horas, ahora):
            return
        # tras un fallo, espera antes de reintentar (bitcoin-data: 15 peticiones al dia)
        if b.get("fallo") and ahora - datetime.fromisoformat(b["fallo"]) < timedelta(hours=REINTENTO_H):
            if not b.get("v"):
                errores[clave] = "waiting to retry"
            return
        try:
            d[clave] = {"at": ahora.isoformat(), "v": fn()}
        except Exception as e:  # noqa: BLE001  (se queda el anterior)
            errores[clave] = str(e)[:200]
            d[clave] = {**b, "fallo": ahora.isoformat()}
        cambio = True

    if d.get("_v") != DIARIO_V:   # cambio de forma de los datos: se renuevan los que cambiaron
        for k in [k for k in d if k.startswith(("cm_", "dvol_", "fng"))]:
            d.pop(k)
        d["_v"] = DIARIO_V
        cambio = True

    for a in ACTIVOS:
        def cm(a=a):
            url = ("https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?" + urllib.parse.urlencode(
                {"assets": a.lower(), "metrics": CM_METRICAS, "start_time": CM_DESDE, "page_size": 10000}))
            filas = http_json(url)["data"]
            if len(filas) < 1000:
                raise ValueError(f"CoinMetrics {a}: {len(filas)} filas")
            # sin los campos de estado (flash/reviewed): la mitad de tamano
            return [{k: v for k, v in r.items() if not k.endswith(("-status", "-status-time"))} for r in filas]
        renovar(f"cm_{a}", CADUCA_H, cm)
        renovar(f"dvol_{a}", CADUCA_H, lambda a=a: dvol_historia(a, ahora))
        renovar(f"velas_{a}", CADUCA_H, lambda a=a: (lambda r: [[_dia(t), c] for t, c in zip(r["ticks"], r["close"])])(
            deribit("get_tradingview_chart_data", instrument_name=f"{a}-PERPETUAL", resolution="1D",
                    start_timestamp=_ms(hace_1a), end_timestamp=_ms(ahora))))
    for clave, serie, campo in BD_SERIES:
        renovar(clave, CADUCA_BD_H, lambda serie=serie, campo=campo: [
            [x["d"], float(x[campo])] for x in http_json(f"https://bitcoin-data.com/v1/{serie}") if x.get(campo)])
    # Fear & Greed completo (desde 2018): para su backtest
    renovar("fng", CADUCA_H, lambda: [[_dia(int(x["timestamp"]) * 1000), int(x["value"]), x["value_classification"]]
                                      for x in reversed(http_json("https://api.alternative.me/fng/?limit=0")["data"])])
    renovar("stables", CADUCA_H, lambda: [[_dia(int(x["date"]) * 1000), x["totalCirculatingUSD"].get("peggedUSD")]
                                          for x in http_json("https://stablecoins.llama.fi/stablecoincharts/all")[-400:]])
    for a in ACTIVOS:
        renovar(f"fund_{a}", CADUCA_H, lambda prev, a=a: funding_historia(a, prev, ahora), inc=True)
        renovar(f"okx_{a}", CADUCA_H, lambda prev, a=a: okx_historia(a, prev), inc=True)
    for r in REDES:
        if r in ACTIVOS:
            continue   # BTC y ETH salen de cm_
        def red(r=r):
            url = ("https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?" + urllib.parse.urlencode(
                {"assets": r.lower(), "metrics": "PriceUSD,AdrActCnt,TxCnt", "start_time": "2015-01-01", "page_size": 10000}))
            time.sleep(0.7)   # CoinMetrics Community: 10 peticiones cada 6 s
            return [[str(x["time"])[:10], cc._f(x.get("PriceUSD")), cc._f(x.get("AdrActCnt")), cc._f(x.get("TxCnt"))]
                    for x in http_json(url)["data"]]
        renovar(f"red_{r}", CADUCA_H * 2, red)
    # activos del mapa de liquidaciones (Coinalyze y CoinGecko), una vez al dia
    renovar("liq_activos", 24, lambda: liq_mercados(ahora))   # clave nueva: sin stablecoins
    if d.pop("liq_mercados", None) is not None:   # la clave anterior (con stablecoins)
        cambio = True
    renovar("stables_det", CADUCA_H, lambda: [
        {k: p.get(k) for k in ("symbol", "name", "circulating", "circulatingPrevWeek", "circulatingPrevMonth")}
        for p in http_json("https://stablecoins.llama.fi/stablecoins?includePrices=false")["peggedAssets"]])
    if cambio:
        almacen.put_json(st, DIARIO, d)
    return {k: v.get("v") for k, v in d.items() if isinstance(v, dict)}, cambio


# ---------------------------------------------------------------- en directo
def mercado(dia: dict, errores: dict) -> dict:
    out = {}
    try:
        top = http_json("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&per_page=15&page=1"
                        "&price_change_percentage=24h,7d,30d")
        out["top"] = [{"sym": c["symbol"].upper(), "nombre": c["name"], "id": c["id"], "precio": c["current_price"],
                       "cap": c["market_cap"], "vol": c["total_volume"],
                       "c24": c.get("price_change_percentage_24h_in_currency"),
                       "c7": c.get("price_change_percentage_7d_in_currency"),
                       "c30": c.get("price_change_percentage_30d_in_currency"),
                       "ath_dist": c.get("ath_change_percentage")} for c in top]
    except Exception as e:  # noqa: BLE001
        errores["coingecko"] = str(e)[:200]
    try:
        gl = http_json("https://api.coingecko.com/api/v3/global")["data"]
        out["cap_total"] = gl["total_market_cap"]["usd"]
        out["cap_chg24"] = gl.get("market_cap_change_percentage_24h_usd")
        out["dom"] = {k.upper(): v for k, v in gl["market_cap_percentage"].items() if k in ("btc", "eth")}
    except Exception as e:  # noqa: BLE001
        errores["coingecko_global"] = str(e)[:200]
    f = dia.get("fng") or []
    if f:   # [[fecha, valor, clase]], de mas antiguo a mas reciente
        out["fng"] = {"valor": f[-1][1], "clase": f[-1][2], "semana": f[-8][1] if len(f) > 7 else None,
                      "pct": cc.percentil([x[1] for x in f], f[-1][1]), "serie": [x[:2] for x in f[-365:]]}
    s = [x for x in dia.get("stables") or [] if x[1]]
    if len(s) > 30:
        out["stables"] = {"total": s[-1][1], "chg30": round((s[-1][1] / s[-31][1] - 1) * 100, 2)}
    lq = cc.liquidez(dia.get("stables_det") or [], s)
    if lq:
        out["liquidez"] = lq
    return out


def futuros(a: str, indice: float, ahora: datetime, errores: dict) -> dict:
    out = {}
    try:
        filas = deribit("get_book_summary_by_currency", currency=a, kind="future")
        out["basis"] = cc.basis(filas, indice, ahora)
        perp = next((f for f in filas if f["instrument_name"] == f"{a}-PERPETUAL"), None)
        if perp:
            out["perp_oi_usd"] = perp.get("open_interest")
            if perp.get("funding_8h") is not None:
                out["funding_deribit"] = round(perp["funding_8h"] * 3 * 365 * 100, 2)
    except Exception as e:  # noqa: BLE001
        errores[f"deribit_futuros_{a}"] = str(e)[:200]
    inst = f"{a}-USDT-SWAP"
    try:
        out["funding"] = round(float(okx("public/funding-rate", instId=inst)[0]["fundingRate"]) * 3 * 365 * 100, 2)
        h = [float(x["fundingRate"]) for x in okx("public/funding-rate-history", instId=inst, limit=21)]
        out["funding_7d"] = round(sum(h) / len(h) * 3 * 365 * 100, 2) if h else None
    except Exception as e:  # noqa: BLE001
        errores[f"okx_funding_{a}"] = str(e)[:200]
    try:
        oi = okx("rubik/stat/contracts/open-interest-volume", ccy=a, period="1D")   # mas reciente primero
        out["oi_usd"] = float(oi[0][1])
        if len(oi) > 7 and float(oi[7][1]):
            out["oi_chg7"] = round((float(oi[0][1]) / float(oi[7][1]) - 1) * 100, 2)
    except Exception as e:  # noqa: BLE001
        errores[f"okx_oi_{a}"] = str(e)[:200]
    try:
        out["lsr"] = round(float(okx("rubik/stat/contracts/long-short-account-ratio", ccy=a, period="1D")[0][1]), 2)
    except Exception as e:  # noqa: BLE001
        errores[f"okx_lsr_{a}"] = str(e)[:200]
    return out


def activo(a: str, ahora: datetime, dia: dict, merc: dict, errores: dict, hist: dict) -> dict:
    filas = deribit("get_book_summary_by_currency", currency=a, kind="option")
    spot = next((f["estimated_delivery_price"] for f in filas if f.get("estimated_delivery_price")), None)
    if not spot:
        raise ValueError(f"Deribit {a}: sin precio del indice")
    ch = cc.cadena(filas, ahora)
    out = {"sym": a, "spot": round(spot, 2)}
    cg = next((c for c in merc.get("top") or [] if c["id"] == CG_ID[a]), None)
    velas = [c for _, c in dia.get(f"velas_{a}") or []]
    if cg:
        out.update(chg24=cg["c24"], chg7=cg["c7"], chg30=cg["c30"])
    elif len(velas) > 31:
        out.update(chg24=round((spot / velas[-2] - 1) * 100, 2), chg7=round((spot / velas[-8] - 1) * 100, 2),
                   chg30=round((spot / velas[-31] - 1) * 100, 2))

    out["gex"] = {k: cc.gex(cc.filtro(ch, ahora, d), spot) for k, d in cc.FILTROS.items()}
    out["venc"] = cc.vencimientos(ch, ahora, spot)
    oi_c, oi_p = float(ch["oi"][ch["call"]].sum()), float(ch["oi"][~ch["call"]].sum())
    out["oi"] = {"calls": round(oi_c, 1), "puts": round(oi_p, 1), "pcr": round(oi_p / oi_c, 2) if oi_c else None,
                 "nocional": round((oi_c + oi_p) * spot)}

    term = cc.estructura(ch, ahora)
    vol = {"term": term, "atm30": cc.a_plazo(term, "atm"), "rr25_30": cc.a_plazo(term, "rr25"),
           "bf25_30": cc.a_plazo(term, "bf25")}
    try:
        vol["dvol"] = round(deribit("get_index_price", index_name=f"{a.lower()}dvol_usdc")["index_price"], 2)
    except Exception as e:  # noqa: BLE001
        errores[f"dvol_{a}"] = str(e)[:200]
    dv = dia.get(f"dvol_{a}") or []
    if dv:
        vol["dvol"] = vol.get("dvol") or dv[-1][1]
        ano = [v for _, v in dv[-365:]]
        vol["dvol_pct"] = cc.percentil(ano, vol["dvol"])
        vol["dvol_serie"] = dv[-365:]
    vol["rv30"] = cc.vol_realizada(velas[:-1] + [spot]) if velas else None   # la vela de hoy, con el precio actual
    if vol.get("dvol") is not None and vol["rv30"] is not None:
        vol["vrp"] = round(vol["dvol"] - vol["rv30"], 2)
    out["vol"] = vol
    out["futuros"] = futuros(a, spot, ahora, errores)

    btc = a == "BTC"   # bitcoin-data y mineros (prueba de trabajo): solo BTC
    sth, lth = (dia.get("bd_sth"), dia.get("bd_lth")) if btc else (None, None)
    cm = dia.get(f"cm_{a}") or []
    out["onchain"] = cc.onchain(cm, spot, sth, lth)
    out["mineros"] = cc.mineros(cm) if btc else None
    out["beneficio"] = cc.beneficio(dia.get("bd_sopr"), dia.get("bd_sth_sopr")) if btc else None
    out["actividad"] = cc.actividad(cm)
    fng = [x[:2] for x in dia.get("fng") or []]
    out["senales"] = cc.senales(cm, sth=sth, sth_sopr=dia.get("bd_sth_sopr") if btc else None, fng=fng,
                                dvol=dia.get(f"dvol_{a}"), mineria=btc, funding=dia.get(f"fund_{a}"),
                                okx=dia.get(f"okx_{a}"), hist=hist, sym=a)
    out["hace30"] = (ahora - timedelta(days=30)).strftime("%Y-%m-%d")
    out["niveles"] = cc.niveles(spot, out["gex"]["all"], out["onchain"], out["venc"])
    out["lectura"] = cc.lectura(out, merc)
    return out


def series(dia: dict, ahora: datetime) -> tuple[dict, dict]:
    """pub/cripto_series.json: historias por activo (cripto_calc.series_largas) y la lista de redes; y la actividad
    de cada red aparte (pub/cripto_red/{RED}.json, unos 60 KB cada una: la web la pide al elegirla)."""
    out = {"generado": ahora.isoformat(), "activos": {}, "redes": {}}
    redes = {}
    for a in ACTIVOS:
        btc = a == "BTC"
        out["activos"][a] = cc.series_largas(
            dia.get(f"cm_{a}") or [], sth=dia.get("bd_sth") if btc else None, lth=dia.get("bd_lth") if btc else None,
            sopr=dia.get("bd_sopr") if btc else None, sth_sopr=dia.get("bd_sth_sopr") if btc else None,
            dvol=dia.get(f"dvol_{a}"), funding=dia.get(f"fund_{a}"), okx=dia.get(f"okx_{a}"), mineria=btc)
    for r, nombre in REDES.items():
        if r in ACTIVOS:
            s = out["activos"][r]
            filas = [[d, p, x, t] for d, p, x, t in zip(s.get("d", []), s.get("precio", []), s.get("dir", []), s.get("tx", []))
                     if d >= "2015-01-01"]
        else:
            filas = dia.get(f"red_{r}") or []
        filas = [f for f in filas if f[2] or f[3]]
        if filas:
            redes[r] = {"nombre": nombre, "d": [f[0] for f in filas], "p": [f[1] for f in filas],
                        "dir": [f[2] for f in filas], "tx": [f[3] for f in filas]}
            out["redes"][r] = {"nombre": nombre, "desde": filas[0][0], "hasta": filas[-1][0]}
    for a in ACTIVOS:   # direcciones y transacciones viajan en el archivo de su red
        out["activos"][a].pop("dir", None)
        out["activos"][a].pop("tx", None)
    return out, redes


def coinalyze(ruta: str, **q):
    """Coinalyze con la clave como parametro (la cabecera api_key la descartan algunos intermediarios)."""
    clave = os.environ.get("COINALYZE_API_KEY")
    if not clave:
        raise RuntimeError("sin COINALYZE_API_KEY")
    return http_json(COINALYZE + ruta + "?" + urllib.parse.urlencode({**q, "api_key": clave}))


def liq_mercados(ahora: datetime) -> dict:
    """Activos del top 250 de CoinGecko con perpetuos en LIQ_EXCH: simbolos de Coinalyze por exchange y el de las
    velas (el primero con volumen comprador, preferido Binance en USDT)."""
    mk = coinalyze("future-markets")
    url = "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&per_page=250&page=1"
    try:
        cg = http_json(url)
    except Exception:  # noqa: BLE001  (CoinGecko gratis limita a pocas peticiones por minuto: un reintento)
        time.sleep(30)
        cg = http_json(url)
    rango = {}
    for c in cg:   # el primero (mayor capitalizacion) gana si dos comparten simbolo
        p = c.get("current_price") or 0
        if "USD" in c["symbol"].upper() and 0.97 < p < 1.03:   # stablecoins: sin interes para el mapa
            continue
        rango.setdefault(c["symbol"].upper(), (c["market_cap_rank"] or 9999, c["name"]))
    por = {}
    for m in mk:
        b, ex = str(m.get("base_asset") or "").upper(), str(m.get("exchange") or "")
        if not m.get("is_perpetual") or ex not in LIQ_EXCH or b not in rango:
            continue
        por.setdefault(b, {}).setdefault(ex, []).append(m)
    activos = []
    for b, exs in por.items():
        cand = [m for e in ("A", "6", "3", "H") for m in exs.get(e, []) if m.get("has_ohlcv_data") and m.get("has_buy_sell_data")]
        cand.sort(key=lambda m: (m["exchange"] != "A", m.get("quote_asset") != "USDT"))
        if not cand:
            continue
        activos.append({"sym": b, "nombre": rango[b][1], "rank": rango[b][0], "velas": cand[0]["symbol"],
                        "ex": {e: [m["symbol"] for m in ms][:6] for e, ms in exs.items()}})
    activos.sort(key=lambda x: x["rank"])
    return {"generado": ahora.isoformat(), "exchanges": LIQ_EXCH, "activos": activos}


def main() -> int:
    st = almacen.abrir()
    ahora = datetime.now(timezone.utc).replace(microsecond=0)
    errores: dict = {}
    dia, cambio = diario(st, ahora, errores)
    hist = almacen.get_json(st, HIST, {}) or {}
    merc = mercado(dia, errores)
    previo = almacen.get_json(st, PUB, {}) or {}
    activos = {}
    for a in ACTIVOS:
        try:
            activos[a] = activo(a, ahora, dia, merc, errores, hist)
        except Exception as e:  # noqa: BLE001  (se publica el anterior, marcado)
            errores[f"activo_{a}"] = str(e)[:200]
            if (previo.get("activos") or {}).get(a):
                activos[a] = {**previo["activos"][a], "viejo": previo.get("generado")}
    if not activos:
        print("cripto: sin datos", json.dumps(errores), file=sys.stderr)
        return 1
    # historial propio: una foto por dia UTC (la primera pasada del dia); percentiles con 30 dias o mas
    hoy = ahora.strftime("%Y-%m-%d")
    frescos = {a: x for a, x in activos.items() if not x.get("viejo")}
    if hoy not in hist and frescos:
        hist[hoy] = {a: cc.foto(x) for a, x in frescos.items()}
        almacen.put_json(st, HIST, hist)
    for a, x in frescos.items():
        x["pct_propio"] = cc.percentiles_propios(hist, a, cc.foto(x))
        x["dias_propios"] = sum(1 for h in hist.values() if a in h)
    out = {"generado": ahora.isoformat(), "activos": activos, "mercado": merc, "errores": errores,
           "umbrales": cc.UMBRALES}
    n = almacen.put_json(st, PUB, out)
    if cambio:   # historias largas: solo cuando cambian los datos diarios (unas 4 veces al dia)
        if dia.get("liq_activos"):
            almacen.put_json(st, LIQ_MERCADOS, dia["liq_activos"])
        principal, redes = series(dia, ahora)
        n2 = almacen.put_json(st, SERIES, principal)
        for r, x in redes.items():
            n2 += almacen.put_json(st, f"pub/cripto_red/{r}.json", x)
        print(f"{SERIES} y {len(redes)} redes: {n2 / 1024:.0f} KB")
    for a, x in activos.items():
        lec = x.get("lectura") or {}
        print(f"{a} {x['spot']:,.0f}  GEX {x['gex']['all']['total'] / 1e6:+,.1f} M$/1%  flip {x['gex']['all']['flip']}"
              f"  CW {x['gex']['all']['call_wall']}  PW {x['gex']['all']['put_wall']}  -> {lec.get('resumen')}")
    print(f"pub/cripto.json {n / 1024:.0f} KB, errores: {json.dumps(errores) if errores else 'ninguno'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
