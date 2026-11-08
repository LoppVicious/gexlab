"""GEX Lab - cadena de opciones de Tradier (tiempo real) en el mismo formato que la de CBOE.

gex_engine.fetch_chain la usa si hay TRADIER_TOKEN en el entorno (en la nube: secreto de GitHub) y, si falla,
vuelve a CBOE (15 min de retraso). Devuelve {"timestamp", "source": "tradier", "data": {...}} con los mismos campos
que lee parse_chain: precio del subyacente, cierre anterior, y por contrato el simbolo OCC, bid, ask, ultimo precio,
volumen, open interest, delta e IV.

IV: Tradier publica sus griegas (ORATS) aproximadamente cada hora; los precios van en tiempo real. Para que la IV
sea del mismo instante que el precio, se calcula aqui por Black-Scholes a partir del punto medio bid/ask (como CBOE);
si no hay precio util o no tiene solucion (p. ej. americanas muy dentro de dinero), se usa la de Tradier.

Limite de la API: 120 peticiones por minuto. La cadena se pide por vencimiento (SPX tiene ~55), en paralelo,
respetando las cabeceras X-Ratelimit. El token nunca se escribe en los registros.
"""
from __future__ import annotations

import json
import math
import os
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import numpy as np

BASE = os.environ.get("TRADIER_BASE", "https://api.tradier.com/v1")
HILOS = 4
RESERVA = 3                 # peticiones que se dejan libres en cada minuto (otros procesos con el mismo token)


class TradierError(Exception):
    pass


class TokenInvalido(TradierError):
    pass


def token() -> str:
    return os.environ.get("TRADIER_TOKEN", "").strip()


def disponible() -> bool:
    return bool(token()) and os.environ.get("GEX_FUENTE", "").lower() != "cboe"


# ---------------------------------------------------------------- peticiones con limite
_lock = threading.Lock()
_cupo = {"libres": None, "renueva": 0.0}
peticiones = [0]


def _esperar_cupo() -> None:
    while True:
        with _lock:
            libres, renueva = _cupo["libres"], _cupo["renueva"]
            if libres is None or libres > RESERVA or time.time() >= renueva:
                if libres is not None:
                    _cupo["libres"] = libres - 1
                return
            espera = renueva - time.time() + 0.3
        time.sleep(min(max(espera, 0.2), 61))


def _get(path: str, intentos: int = 4) -> dict:
    import gex_engine as g  # certificados (mismo almacen que CBOE)
    url = BASE + path
    ultimo = None
    for i in range(intentos):
        _esperar_cupo()
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token()}", "Accept": "application/json",
                                                   "User-Agent": "gexlab"})
        try:
            with urllib.request.urlopen(req, timeout=20, context=g._SSL_CTXS[-1]) as r:
                peticiones[0] += 1
                h = r.headers
                with _lock:
                    if h.get("X-Ratelimit-Available") is not None:
                        _cupo["libres"] = int(h["X-Ratelimit-Available"])
                        _cupo["renueva"] = int(h.get("X-Ratelimit-Expiry") or 0) / 1000.0
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            peticiones[0] += 1
            if e.code in (401, 403):
                raise TokenInvalido(f"Tradier {e.code}") from e
            if e.code == 429 or e.code >= 500:
                ultimo = TradierError(f"Tradier {e.code}")
                if e.code == 429:
                    with _lock:
                        _cupo["libres"], _cupo["renueva"] = 0, time.time() + 15
                time.sleep(2 * (i + 1))
                continue
            raise TradierError(f"Tradier {e.code}") from e
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            ultimo = TradierError(f"Tradier sin conexion: {getattr(e, 'reason', e)}")
            time.sleep(2 * (i + 1))
    raise ultimo or TradierError("Tradier no responde")


def _lista(x) -> list:
    if x is None:
        return []
    return x if isinstance(x, list) else [x]


# ---------------------------------------------------------------- cadena
def _vencimientos(sym: str) -> list[str]:
    d = _get(f"/markets/options/expirations?symbol={sym}&includeAllRoots=true&strikes=false")
    return [str(x) for x in _lista(((d or {}).get("expirations") or {}).get("date"))]


def _opciones(sym: str, exp: str) -> list[dict]:
    d = _get(f"/markets/options/chains?symbol={sym}&expiration={exp}&greeks=true")
    return _lista(((d or {}).get("options") or {}).get("option"))


def cadena(symbol: str) -> dict:
    """Cadena completa de Tradier en el formato de CBOE (lo que espera gex_engine.parse_chain)."""
    import gex_engine as g
    sym = symbol.upper()
    q = _lista(((_get(f"/markets/quotes?symbols={sym}&greeks=false") or {}).get("quotes") or {}).get("quote"))
    q = q[0] if q else {}
    spot = float(q.get("last") or q.get("close") or q.get("prevclose") or 0)
    if spot <= 0:
        raise TradierError(f"Tradier no tiene precio de {sym}")
    exps = _vencimientos(sym)
    if not exps:
        raise TradierError(f"Tradier no tiene opciones de {sym}")
    with ThreadPoolExecutor(max_workers=HILOS) as pool:
        partes = list(pool.map(lambda e: _opciones(sym, e), exps))
    opts = [o for p in partes for o in p if o.get("symbol")]
    if not opts:
        raise TradierError(f"Tradier no devuelve contratos de {sym}")

    # IV del instante actual a partir del punto medio
    now = g.now_ny().replace(second=0, microsecond=0)
    r = g.risk_free()
    K, T, call, mid, iv_t = [], [], [], [], []
    for o in opts:
        m = g.OCC_RE.match(o["symbol"])
        root, ymd = (m.group(1), m.group(2)) if m else (o.get("root_symbol") or sym, "")
        ds = f"20{ymd[:2]}-{ymd[2:4]}-{ymd[4:6]}" if ymd else str(o.get("expiration_date"))
        hh, mm = (9, 30) if root in g.AM_SETTLED_ROOTS else ((13, 0) if ds in g.NYSE_EARLY_CLOSE else (16, 0))
        exp = datetime.strptime(ds, "%Y-%m-%d").replace(hour=hh, minute=mm)
        T.append(max((exp - now).total_seconds() / 60.0, 5.0) / g.YEAR_MIN)
        K.append(float(o.get("strike") or 0))
        call.append(o.get("option_type") == "call")
        b, a = float(o.get("bid") or 0), float(o.get("ask") or 0)
        mid.append((b + a) / 2 if a > 0 and a >= b else np.nan)
        gk = o.get("greeks") or {}
        iv_t.append(float(gk.get("mid_iv") or gk.get("smv_vol") or 0))
    iv = g.implied_vol(np.array(mid), spot, np.array(K), np.array(T), r, np.array(call))
    iv = np.where(np.isfinite(iv), iv, np.array(iv_t))

    options = []
    for o, v in zip(opts, iv):
        gk = o.get("greeks") or {}
        options.append({
            "option": o["symbol"], "bid": o.get("bid") or 0, "ask": o.get("ask") or 0,
            "last_trade_price": o.get("last") or 0, "volume": o.get("volume") or 0,
            "open_interest": o.get("open_interest") or 0, "delta": gk.get("delta") or 0, "iv": float(v) if v > 0 else 0,
        })
    td = q.get("trade_date") or 0
    ts = datetime.fromtimestamp(td / 1000, tz=timezone.utc) if td else datetime.now(timezone.utc)
    prev = float(q.get("prevclose") or 0) or spot
    data = {
        "symbol": sym, "current_price": spot, "close": spot, "prev_day_close": prev,
        "price_change_percent": q.get("change_percentage"), "iv30": None,
        "last_trade_time": ts.strftime("%Y-%m-%dT%H:%M:%S"), "options": options,
    }
    return {"timestamp": ts.strftime("%Y-%m-%d %H:%M:%S"), "source": "tradier", "data": data}
