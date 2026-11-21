"""GEX Lab - mapa de liquidaciones en el modo PC (server.py).

Con COINALYZE_API_KEY en el entorno, hace lo mismo que /api/liq del Worker (pone la clave y reenvia). Sin ella,
responde con el mismo formato que Coinalyze a partir de los datos publicos de Binance futuros (velas con volumen
comprador y 30 dias de OI), solo para los simbolos de Binance (sufijo .A); los demas exchanges salen vacios y no hay
liquidaciones reales. Binance bloquea las IP de EE. UU.: sirve desde el PC del usuario, no desde Actions.
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.parse

import gex_engine as g

RUTAS = {"oi": "open-interest-history", "ohlcv": "ohlcv-history", "liq": "liquidation-history"}
BINANCE_IV = {"5min": "5m", "15min": "15m", "1hour": "1h", "4hour": "4h", "daily": "1d"}
IV_S = {"5min": 300, "15min": 900, "1hour": 3600, "4hour": 14400, "daily": 86400}
FAPI = "https://fapi.binance.com"
_cache: dict = {}


def _get(url: str):
    hit = _cache.get(url)
    if hit and time.time() - hit[0] < 60:
        return hit[1]
    try:
        b = g._fetch_python(url)
    except g.NotFound:
        raise
    except Exception:  # noqa: BLE001
        b = g._fetch_system(url)
    d = json.loads(b.decode("utf-8"))
    if len(_cache) > 200:
        _cache.clear()
    _cache[url] = (time.time(), d)
    return d


def _valido(q: dict):
    kind, iv = q.get("kind"), q.get("interval")
    syms = [s for s in str(q.get("symbols") or "").split(",") if s]
    try:
        desde, hasta = int(q.get("from")), int(q.get("to"))
    except (TypeError, ValueError):
        return None
    if (kind not in RUTAS or iv not in IV_S or not syms or len(syms) > 20
            or not all(re.fullmatch(r"[A-Za-z0-9_.\-]{2,40}", s) for s in syms) or desde < 1262304000 or hasta <= desde):
        return None
    return kind, iv, syms, desde, hasta


def _binance(sym: str) -> str | None:
    """BTCUSDT_PERP.A -> BTCUSDT (solo los lineales de Binance)."""
    m = re.fullmatch(r"([A-Z0-9]+USDT)_PERP\.A", sym)
    return m.group(1) if m else None


def _velas(bsym: str, iv: str, desde: int, hasta: int) -> list:
    out, t = [], desde * 1000
    while t < hasta * 1000 and len(out) < 6000:
        q = urllib.parse.urlencode({"symbol": bsym, "interval": BINANCE_IV[iv], "startTime": t, "endTime": hasta * 1000,
                                    "limit": 1500})
        k = _get(f"{FAPI}/fapi/v1/klines?{q}")
        if not k:
            break
        out += [{"t": x[0] // 1000, "o": float(x[1]), "h": float(x[2]), "l": float(x[3]), "c": float(x[4]),
                 "v": float(x[5]), "bv": float(x[9])} for x in k]
        t = k[-1][0] + IV_S[iv] * 1000
    return out


def _oi(bsym: str, iv: str, desde: int, hasta: int) -> list:
    """Binance da 30 dias de OI (sumOpenInterestValue, en USD), 500 por peticion."""
    out, fin = {}, hasta * 1000
    inicio = max(desde, int(time.time()) - 29 * 86400) * 1000
    while fin > inicio:
        q = urllib.parse.urlencode({"symbol": bsym, "period": BINANCE_IV[iv], "startTime": inicio, "endTime": fin,
                                    "limit": 500})
        r = _get(f"{FAPI}/futures/data/openInterestHist?{q}")
        if not isinstance(r, list) or not r:
            break
        for x in r:
            v = float(x["sumOpenInterestValue"])
            out[x["timestamp"] // 1000] = {"t": x["timestamp"] // 1000, "o": v, "h": v, "l": v, "c": v}
        nuevo = r[0]["timestamp"] - 1
        if nuevo >= fin:
            break
        fin = nuevo
    return [out[k] for k in sorted(out)]


def responder(q: dict) -> tuple[int, object]:
    v = _valido(q)
    if not v:
        return 400, {"error": "Invalid request"}
    kind, iv, syms, desde, hasta = v
    clave = os.environ.get("COINALYZE_API_KEY")
    if clave:
        p = {"symbols": ",".join(syms), "interval": iv, "from": desde, "to": hasta, "api_key": clave}
        if kind != "ohlcv":
            p["convert_to_usd"] = "true"
        return 200, _get(f"https://api.coinalyze.net/v1/{RUTAS[kind]}?{urllib.parse.urlencode(p)}")
    out = []
    for s in syms:
        b = _binance(s)
        hist = []
        if b and kind == "ohlcv":
            hist = _velas(b, iv, desde, hasta)
        elif b and kind == "oi":
            hist = _oi(b, iv, desde, hasta)
        out.append({"symbol": s, "history": hist})
    return 200, out


def mercados() -> dict:
    """Sin clave: los perpetuos lineales de Binance con mas volumen (los 60 primeros)."""
    t = _get(f"{FAPI}/fapi/v1/ticker/24hr")
    filas = sorted((x for x in t if x["symbol"].endswith("USDT") and float(x["quoteVolume"]) > 0),
                   key=lambda x: -float(x["quoteVolume"]))[:60]
    activos = []
    for i, x in enumerate(filas):
        b = x["symbol"][:-4]
        activos.append({"sym": b, "nombre": b, "rank": i + 1, "velas": f"{x['symbol']}_PERP.A",
                        "ex": {"A": [f"{x['symbol']}_PERP.A"]}})
    return {"generado": None, "exchanges": {"A": "Binance"}, "activos": activos, "local": True}
