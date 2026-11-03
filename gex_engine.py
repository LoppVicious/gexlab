"""
GEX Lab - motor de calculo de exposicion gamma (GEX).

Fuente: CBOE delayed quotes (gratuito, ~15 min de retraso, OI del cierre anterior).
Convencion de signos "naive" (SqueezeMetrics 2017): dealers largos de calls
(gamma +) y cortos de puts (gamma -).

Unidad principal: $ de delta por cada $1 de movimiento = Gamma * OI * 100 * S
"""
from __future__ import annotations

import json
import math
import os
import re
import shutil
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

import numpy as np

CBOE_HOSTS = ("https://cdn-api.cboe.com", "https://cdn.cboe.com")
CBOE_PATH = "/api/global/delayed_quotes/options/{sym}.json"
INDEX_SYMBOLS = {"SPX", "NDX", "RUT", "VIX", "XSP", "DJX", "OEX", "XND", "MRUT", "XEO"}
AM_SETTLED_ROOTS = {"SPX", "NDX", "RUT", "DJX", "OEX", "VIX", "VIXW"}  # liquidacion AM (precio de apertura)
# ETF que cotizan fuera de horario y sirven para estimar el pre-market de cada indice
INDEX_PROXY = {"SPX": "SPY", "XSP": "SPY", "NDX": "QQQ", "RUT": "IWM", "DJX": "DIA"}
YEAR_MIN = 365.0 * 24 * 60
# Calendario oficial NYSE (NYSE Group, dic-2025). Actualizar cada ano.
NYSE_HOLIDAYS = {
    "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03",
    "2026-09-07", "2026-11-26", "2026-12-25",
    "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05",
    "2027-09-06", "2027-11-25", "2027-12-24",
    "2028-01-17", "2028-02-21", "2028-04-14", "2028-05-29", "2028-06-19", "2028-07-04", "2028-09-04",
    "2028-11-23", "2028-12-25",
}
NYSE_EARLY_CLOSE = {"2026-11-27", "2026-12-24", "2027-11-26", "2028-07-03", "2028-11-24"}  # cierre 13:00
_HOL64 = np.array(sorted(NYSE_HOLIDAYS), dtype="datetime64[D]")
SESSION_MIN = 390.0  # 09:30-16:00
OCC_RE = re.compile(r"^([A-Z0-9.]+?)(\d{6})([CP])(\d{8})$")

RISK_FREE = 0.04  # respaldo si no se puede leer la letra del Tesoro
LEVEL_WINDOW_PCT = 10.0  # rango (+-%) en el que se buscan walls y VT
CACHE_TTL = 90  # segundos
_cache: dict[str, tuple[float, dict]] = {}


# ---------------------------------------------------------------- hora de Nueva York
def _ny_offset(dt_utc: datetime) -> timedelta:
    """Desfase de Nueva York sin depender de tzdata (Windows no lo trae)."""
    y = dt_utc.year
    # DST: segundo domingo de marzo 02:00 local -> primer domingo de noviembre 02:00 local
    march = datetime(y, 3, 8, tzinfo=timezone.utc)
    dst_start = march + timedelta(days=(6 - march.weekday()) % 7)
    nov = datetime(y, 11, 1, tzinfo=timezone.utc)
    dst_end = nov + timedelta(days=(6 - nov.weekday()) % 7)
    start_utc = dst_start + timedelta(hours=7)   # 02:00 EST = 07:00 UTC
    end_utc = dst_end + timedelta(hours=6)       # 02:00 EDT = 06:00 UTC
    return timedelta(hours=-4) if start_utc <= dt_utc < end_utc else timedelta(hours=-5)


def now_ny() -> datetime:
    now = datetime.now(timezone.utc)
    return (now + _ny_offset(now)).replace(tzinfo=None)


# ---------------------------------------------------------------- tiempo y varianza
def is_trading_day(d: datetime) -> bool:
    return d.weekday() < 5 and d.strftime("%Y-%m-%d") not in NYSE_HOLIDAYS


def close_time(d: datetime) -> datetime:
    """Hora de cierre de la sesion de ese dia (13:00 en cierres anticipados)."""
    h = 13 if d.strftime("%Y-%m-%d") in NYSE_EARLY_CLOSE else 16
    return d.replace(hour=h, minute=0, second=0, microsecond=0)


def prev_trading_day(d: datetime) -> datetime:
    d = d.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=1)
    while not is_trading_day(d):
        d -= timedelta(days=1)
    return d


def next_trading_day(d: datetime) -> datetime:
    d = d.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
    while not is_trading_day(d):
        d += timedelta(days=1)
    return d


def last_close(now: datetime) -> datetime:
    """Cierre de la ultima sesion terminada."""
    if is_trading_day(now) and now >= close_time(now):
        return close_time(now)
    return close_time(prev_trading_day(now))


def quote_time(now: datetime) -> datetime:
    """Momento al que corresponden las IV de CBOE: ahora con el mercado abierto; si no, el ultimo cierre."""
    return now if market_open(now) else last_close(now)


def market_open(now: datetime) -> bool:
    return is_trading_day(now) and now.replace(hour=9, minute=30, second=0, microsecond=0) <= now < close_time(now)


def _day_minutes(day_start: datetime, a: datetime, b: datetime) -> float:
    if not is_trading_day(day_start):
        return 0.0
    o, c = day_start.replace(hour=9, minute=30), close_time(day_start)
    lo, hi = max(a, o), min(b, c)
    return max(0.0, (hi - lo).total_seconds() / 60)


def trading_minutes(a: datetime, b: datetime) -> float:
    """Minutos de mercado entre a y b segun el calendario NYSE (festivos y cierres anticipados)."""
    if b <= a:
        return 0.0
    da, db = a.replace(hour=0, minute=0, second=0, microsecond=0), b.replace(hour=0, minute=0, second=0, microsecond=0)
    if da == db:
        return _day_minutes(da, a, b)
    total = _day_minutes(da, a, da + timedelta(days=1)) + _day_minutes(db, db, b)
    d1, d2 = (da + timedelta(days=1)).date(), db.date()
    mid = int(np.busday_count(d1, d2, holidays=_HOL64))
    early = sum(1 for x in NYSE_EARLY_CLOSE if str(d1) <= x < str(d2))
    return total + mid * SESSION_MIN - early * 180


def variance_to_expiry(iv: np.ndarray, exp: np.ndarray, q: datetime, t: datetime):
    """Varianza total (sigma^2 * T) que queda hasta el vencimiento en el instante t.
    CBOE cotiza la IV en dias naturales desde q; la varianza solo se consume en horas de mercado,
    asi que se reparte en proporcion al tiempo de negociacion restante. Devuelve (w, T natural)."""
    exp_u, inv = np.unique(exp, return_inverse=True)
    t64, q64 = np.datetime64(t.replace(second=0, microsecond=0)), np.datetime64(q.replace(second=0, microsecond=0))
    tq = np.maximum((exp_u - q64).astype("timedelta64[m]").astype(float), 5.0) / YEAR_MIN
    tt = np.maximum((exp_u - t64).astype("timedelta64[m]").astype(float), 5.0) / YEAR_MIN
    ratio = np.empty(exp_u.size)
    for i, ex in enumerate(exp_u):
        exd = ex.astype("datetime64[m]").astype(datetime)
        bq = max(trading_minutes(q, exd), 5.0)
        bt = max(trading_minutes(t, exd), 5.0) if t != q else bq
        ratio[i] = bt / bq
    return iv * iv * (tq * ratio)[inv], tt[inv]


def vanna_charm_w(S, K, w, T, r=None):
    """Vanna (dDelta/dsigma, por 1,00 de vol) y charm (-dDelta/dT, por ano) con varianza total w.
    Sin dividendos; iguales para call y put."""
    r = risk_free() if r is None else r
    sw = np.sqrt(w)
    sig = sw / np.sqrt(T)
    d1 = (np.log(S / K) + r * T + 0.5 * w) / sw
    d2 = d1 - sw
    pdf = _norm_pdf(d1)
    vanna = -pdf * d2 / sig
    charm = -pdf * (2 * r * T - d2 * sw) / (2 * T * sw)
    return vanna, charm


def gamma_w(S, K, w, T, r=None):
    """Gamma Black-Scholes a partir de la varianza total w = sigma^2 * T. S puede ser columna (N,1)."""
    r = risk_free() if r is None else r
    sw = np.sqrt(w)
    d1 = (np.log(S / K) + r * T + 0.5 * w) / sw
    return _norm_pdf(d1) / (S * sw)


# ---------------------------------------------------------------- descarga
def _ssl_contexts() -> list:
    """Almacen del sistema primero (en Windows incluye los certificados de antivirus/proxy),
    certifi como respaldo (Python de python.org en Mac)."""
    ctxs = [ssl.create_default_context()]
    try:
        import certifi
        ctxs.append(ssl.create_default_context(cafile=certifi.where()))
    except Exception:  # noqa: BLE001
        pass
    return ctxs


_SSL_CTXS = _ssl_contexts()


_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")


class NotFound(Exception):
    pass


class RateLimited(Exception):
    """CBOE devolvio 429: demasiadas peticiones seguidas."""


_rate_lock = threading.Lock()
_last_request = [0.0]
MIN_REQUEST_GAP = 0.35  # segundos minimos entre peticiones a CBOE (todas las hebras)


def _throttle() -> None:
    with _rate_lock:
        wait = _last_request[0] + MIN_REQUEST_GAP - time.time()
        if wait > 0:
            time.sleep(wait)
        _last_request[0] = time.time()


def _fetch_python(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": _UA, "Accept": "application/json"})
    last = None
    for ctx in _SSL_CTXS:
        try:
            with urllib.request.urlopen(req, timeout=30, context=ctx) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (403, 404):
                raise NotFound(str(e.code)) from e
            if e.code == 429:
                raise RateLimited("429") from e
            raise
        except urllib.error.URLError as e:
            last = e
            if "CERTIFICATE" not in str(getattr(e, "reason", e)).upper():
                raise
    raise last


def _fetch_system(url: str) -> bytes:
    """Respaldo: descarga con curl.exe (Windows 10+, macOS) usando la red y los certificados del sistema."""
    curl = shutil.which("curl.exe") or shutil.which("curl")
    if not curl:
        raise OSError("curl no disponible")
    fd, tmp = tempfile.mkstemp(suffix=".json")
    os.close(fd)
    try:
        flags = 0x08000000 if sys.platform == "win32" else 0  # CREATE_NO_WINDOW
        p = subprocess.run([curl, "-sS", "-L", "--max-time", "60", "-A", _UA, "-o", tmp,
                            "-w", "%{http_code}", url],
                           capture_output=True, text=True, timeout=75, creationflags=flags)
        code = (p.stdout or "").strip()[-3:]
        if code in ("403", "404"):
            raise NotFound(code)
        if code == "429":
            raise RateLimited("429")
        if p.returncode != 0 or code != "200":
            raise OSError((p.stderr or f"HTTP {code}").strip())
        with open(tmp, "rb") as f:
            return f.read()
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


_method = {"name": None}  # recuerda el metodo que funciono


def _fetch_json(path: str, retries: int = 4) -> dict:
    """Prueba Python y, si falla la conexion, el curl del sistema. Devuelve el JSON.
    Si CBOE limita las peticiones (429), espera y reintenta con espera creciente (3, 6, 12, 24 s)."""
    methods = [("python", _fetch_python), ("sistema", _fetch_system)]
    if _method["name"] == "sistema":
        methods.reverse()
    for attempt in range(retries + 1):
        errors = []
        limited = False
        for name, fn in methods:
            for host in CBOE_HOSTS:
                try:
                    _throttle()
                    data = json.loads(fn(host + path).decode("utf-8"))
                    _method["name"] = name
                    return data
                except NotFound:
                    raise
                except RateLimited:
                    limited = True
                    break
                except Exception as e:  # noqa: BLE001
                    errors.append(f"{name}: {getattr(e, 'reason', e)}")
                    continue
            if limited:
                break
        if not limited:
            raise ConnectionError(" | ".join(dict.fromkeys(errors)))
        if attempt < retries:
            time.sleep(3 * 2 ** attempt)
    raise ConnectionError("CBOE limita las peticiones (429). Prueba de nuevo en un minuto.")


def _explain(detail: str) -> str:
    d = detail.upper()
    if "CERTIFICATE" in d:
        hint = "Un antivirus o proxy esta interceptando HTTPS."
    elif "10013" in d or "PERMISSIONS" in d:
        hint = "El firewall esta bloqueando a Python: permite python.exe en el Firewall de Windows."
    elif "GETADDRINFO" in d or "RESOLVE" in d:
        hint = "No se resuelve el dominio de CBOE: revisa la conexion o el DNS."
    elif "UNKNOWN URL TYPE" in d or "SSL" in d and "MODULE" in d:
        hint = "Este Python no tiene soporte SSL (pasa con algunos entornos de Anaconda)."
    elif "429" in d or "LIMITA" in d:
        return detail
    else:
        hint = "No se pudo conectar con CBOE."
    return f"{hint} Detalle: {detail}"


# ---------------------------------------------------------------- buscador de tickers
SYMBOL_DIR_URL = "https://www.cboe.com/us/options/symboldir/equity_index_options/?download=csv"
CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache")
INDEX_NAMES = [
    ("SPX", "S&P 500 Index"), ("NDX", "Nasdaq-100 Index"), ("RUT", "Russell 2000 Index"),
    ("VIX", "Cboe Volatility Index"), ("XSP", "Mini-SPX Index"), ("DJX", "Dow Jones Industrial Average 1/100"),
    ("SPY", "SPDR S&P 500 ETF"), ("QQQ", "Invesco QQQ Trust"), ("IWM", "iShares Russell 2000 ETF"),
]
_symbols: list[tuple[str, str]] = []
POPULAR = set("""SPX NDX RUT VIX XSP SPY QQQ IWM DIA TLT GLD SLV USO HYG XLF XLE XLK SMH SOXL TQQQ ARKK
AAPL MSFT NVDA AMZN GOOGL GOOG META TSLA AVGO AMD NFLX ORCL CRM ADBE INTC MU QCOM TSM ASML PLTR
COIN MSTR HOOD SHOP UBER ABNB SNOW PYPL SQ BA DIS JPM BAC GS MS WFC C V MA BRK.B XOM CVX
UNH LLY JNJ PFE MRK ABBV NVO WMT COST HD NKE KO PEP MCD SBUX F GM RIVN LCID SMCI ARM DELL
BABA PDD NIO GME AMC CVNA""".split())


def s_not_pop(s: str) -> bool:
    return s not in POPULAR


def _title(name: str) -> str:
    drop = {"COM", "NEW", "DEL", "SHS", "ORD", "STK", "CAP", "USD", "SPONSORED", "REGISTERED", "COMMON", "STOCK", "PAR"}
    upper = {"ETF", "ADR", "REIT", "SPDR", "USA", "US", "AI", "LP", "NV", "SA", "AG", "SE", "PLC", "II", "III", "IV", "ETN"}
    out = []
    for w in name.replace(" CL ", " CLASS ").split():
        u = w.upper().strip(",")
        if u in drop:
            continue
        if u in upper or "&" in u or any(ch.isdigit() for ch in u) or len(u) == 1:
            out.append(u)
        else:
            out.append(w.capitalize())
    return " ".join(out)


def load_symbols() -> list[tuple[str, str]]:
    """Directorio de CBOE (cache en disco 7 dias). Si no se puede descargar, solo indices."""
    global _symbols
    if _symbols:
        return _symbols
    path = os.path.join(CACHE_DIR, "cboe_symbols.csv")
    text = None
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < 7 * 86400:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    if text is None and not os.environ.get("GEX_FIXTURE_DIR"):
        for fn in (_fetch_python, _fetch_system):
            try:
                text = fn(SYMBOL_DIR_URL).decode("utf-8", "replace")
                os.makedirs(CACHE_DIR, exist_ok=True)
                with open(path, "w", encoding="utf-8") as f:
                    f.write(text)
                break
            except Exception:  # noqa: BLE001
                continue
    if text is None and os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            text = f.read()
    out = list(INDEX_NAMES)
    seen = {s for s, _ in out}
    if text:
        import csv
        import io
        rows = csv.reader(io.StringIO(text))
        next(rows, None)
        for r in rows:
            if len(r) >= 2:
                sym = r[1].strip().upper()
                if sym and sym not in seen:
                    seen.add(sym)
                    out.append((sym, _title(r[0].strip())))
        _symbols = out
    return out


def search(q: str, limit: int = 8) -> list[dict]:
    q = q.strip().upper()
    if not q:
        return []
    syms = load_symbols()
    exact, prefix, name_hits = [], [], []
    for s, n in syms:
        if s == q:
            exact.append((s, n))
        elif s.startswith(q):
            prefix.append((s, n))
        elif len(q) >= 2 and any(w.startswith(q) for w in n.upper().split()) or len(q) >= 4 and q in n.upper():
            name_hits.append((s, n))
    rank = lambda s: (s not in POPULAR, len(s), s)  # noqa: E731
    prefix.sort(key=lambda x: rank(x[0]))
    name_hits.sort(key=lambda x: (not x[1].upper().startswith(q), s_not_pop(x[0]), len(x[0])))
    return [{"symbol": s, "name": n} for s, n in (exact + prefix + name_hits)[:limit]]


def name_of(symbol: str) -> str:
    for s, n in (_symbols or INDEX_NAMES):
        if s == symbol:
            return n
    return ""


def normalize(symbol: str) -> str:
    s = symbol.upper().strip().lstrip("_^$").replace("-", ".").replace("/", ".")
    if not re.fullmatch(r"[A-Z][A-Z0-9.]{0,9}", s):
        raise ValueError("Ticker no valido")
    return s


CBOE_VOL_INDICES = {"IRX", "TNX", "FVX", "VIX", "VIX9D", "VIX3M", "VIX6M", "VIX1Y", "VXN", "VXD", "VXAPL", "VXAZN", "VXGOG", "VXGS", "VXIBM", "VXEEM", "GVZ", "OVX", "RVX"}


def _cboe_symbol(symbol: str) -> str:
    return f"_{symbol}" if symbol in INDEX_SYMBOLS or symbol in CBOE_VOL_INDICES else symbol


_aux_cache: dict[str, tuple[float, dict]] = {}


def fetch_aux(kind: str, symbol: str, ttl: float = 120) -> dict | None:
    """Endpoints auxiliares de CBOE: 'intraday' (velas de 1 min) o 'historical' (cierres diarios)."""
    symbol = normalize(symbol)
    key = f"{kind}:{symbol}"
    hit = _aux_cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    fixture_dir = os.environ.get("GEX_FIXTURE_DIR")
    try:
        if fixture_dir:
            path = os.path.join(fixture_dir, f"{kind}_{symbol}.json")
            if not os.path.exists(path):
                return None
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        else:
            data = _fetch_json(f"/api/global/delayed_quotes/charts/{kind}/{_cboe_symbol(symbol)}.json")
        if kind == "historical" and not (data or {}).get("data"):
            raise ValueError("historico vacio")
    except Exception:  # noqa: BLE001
        # CBOE a veces publica el historico vacio durante unas horas: se usa la ultima copia buena
        if kind == "historical":
            disk = read_json(os.path.join(CACHE_DIR, "hist", f"{symbol.replace('.', '_')}.json.gz"))
            if disk and disk.get("data"):
                _aux_cache[key] = (time.time() - ttl + 600, disk)  # reintenta la descarga en 10 min
                return disk
        return None
    if kind == "historical" and not os.environ.get("GEX_FIXTURE_DIR"):
        try:
            write_json(os.path.join(CACHE_DIR, "hist", f"{symbol.replace('.', '_')}.json.gz"), data)
        except OSError:
            pass
    _aux_cache[key] = (time.time(), data)
    return data


def fetch_quote(symbol: str, ttl: float = 60) -> dict | None:
    key = f"quote:{symbol}"
    hit = _aux_cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    if os.environ.get("GEX_FIXTURE_DIR"):
        path = os.path.join(os.environ["GEX_FIXTURE_DIR"], f"quote_{symbol}.json")
        data = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else None
    else:
        try:
            data = _fetch_json(f"/api/global/delayed_quotes/quotes/{_cboe_symbol(symbol)}.json")
        except Exception:  # noqa: BLE001
            data = None
    _aux_cache[key] = (time.time(), data)
    return data


_rate = {"r": RISK_FREE, "t": 0.0, "src": None, "yield": None}
_rf_lock = threading.Lock()  # distinto del candado de ritmo de peticiones (_rate_lock), que se usa dentro


def risk_free() -> float:
    """Tipo libre de riesgo continuo a partir de la letra del Tesoro a 13 semanas (indice IRX de CBOE,
    tipo de descuento x10). Se refresca cada 6 horas; si no se puede leer, 4%."""
    if time.time() - _rate["t"] < 6 * 3600:
        return _rate["r"]
    with _rf_lock:
        if time.time() - _rate["t"] < 6 * 3600:
            return _rate["r"]
        _rate["t"] = time.time()
        if os.environ.get("GEX_FIXTURE_DIR"):
            fx = read_json(os.path.join(os.environ["GEX_FIXTURE_DIR"], "rate.json"))  # tipo que uso el motor
            if fx and fx.get("r"):
                _rate.update(r=float(fx["r"]), src=fx.get("src"), **{"yield": fx.get("yield")})
            return _rate["r"]
        try:
            d = float(((fetch_quote("IRX", ttl=3600) or {}).get("data") or {}).get("current_price") or 0) / 1000
            if 0 < d < 0.2:
                bey = 365 * d / (360 - 91 * d)                      # descuento -> rendimiento equivalente
                r = math.log(1 + bey * 91 / 365) * 365 / 91         # -> continuo
                _rate.update(r=r, src="IRX", **{"yield": bey})
        except Exception:  # noqa: BLE001
            pass
        return _rate["r"]


def rate_info() -> dict:
    risk_free()
    return {"r": _rate["r"], "src": _rate["src"] or "fijo", "yield": _rate["yield"]}


def implied_index_spot(symbol: str, index_close: float, now: datetime) -> dict | None:
    """Fuera de horario el indice no cotiza; su ETF si (pre-market y after-hours).
    Spot implicito = cierre del indice x (precio actual del ETF / cierre del ETF)."""
    proxy = INDEX_PROXY.get(symbol)
    if not proxy or market_open(now) or index_close <= 0:
        return None
    qd = fetch_quote(proxy)
    d = (qd or {}).get("data") or {}
    cur, close = float(d.get("current_price") or 0), float(d.get("close") or 0)
    if cur <= 0 or close <= 0:
        return None
    pre = now.weekday() < 5 and (4, 0) <= (now.hour, now.minute) < (9, 30)
    return {"value": index_close * cur / close, "proxy": proxy, "proxy_chg": (cur / close - 1) * 100,
            "use": pre and abs(cur / close - 1) > 1e-5}


def fetch_chain(symbol: str, force: bool = False) -> dict:
    symbol = normalize(symbol)
    hit = _cache.get(symbol)
    if hit and not force and time.time() - hit[0] < CACHE_TTL:
        return hit[1]

    fixture_dir = os.environ.get("GEX_FIXTURE_DIR")
    if fixture_dir:  # sin red: pruebas, o el motor del navegador con el paquete del ticker
        mpath = os.path.join(fixture_dir, f"{symbol}.min.json")
        path = os.path.join(fixture_dir, f"{symbol}.json")
        if os.path.exists(mpath):
            with open(mpath, encoding="utf-8") as f:
                raw = {"_min": json.load(f)}
        elif os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                raw = json.load(f)
        else:
            raise LookupError(f"No hay datos de opciones para {symbol}")
    else:
        candidates = [f"_{symbol}"] if symbol in INDEX_SYMBOLS else [symbol, f"_{symbol}"]
        raw = None
        for c in candidates:
            try:
                raw = _fetch_json(CBOE_PATH.format(sym=c))
            except NotFound:
                continue
            except ConnectionError as e:
                raise ConnectionError(_explain(str(e))) from e
            if raw.get("data", {}).get("options"):
                break
            raw = None
        if raw is None:
            raise LookupError(f"CBOE no publica opciones para {symbol}")

    _cache[symbol] = (time.time(), raw)
    return raw


# ---------------------------------------------------------------- calculo
def _norm_pdf(x):
    return np.exp(-0.5 * x * x) / math.sqrt(2 * math.pi)


def bs_gamma(S, K, T, iv, r=None, q=0.0):
    """Gamma Black-Scholes vectorizada. S puede ser escalar o columna (N,1)."""
    sqT = np.sqrt(T)
    d1 = (np.log(S / K) + (r - q + 0.5 * iv * iv) * T) / (iv * sqT)
    return np.exp(-q * T) * _norm_pdf(d1) / (S * iv * sqT)


_MIN_ROUND = {"K": 3, "oi": 0, "vol": 0, "iv": 6, "iv_raw": 6, "delta": 6, "bid": 4, "ask": 4, "last": 4}


def chain_to_min(ch: dict) -> dict:
    """Cadena ya interpretada en formato compacto (columnas, vencimientos indexados). Es el paquete que usan el
    motor en la nube y el motor del navegador: los dos calculan sobre exactamente los mismos numeros."""
    exps, eidx = np.unique(ch["exp"], return_inverse=True)
    d = {k: ch[k] for k in ("symbol", "spot", "prev_close", "chg_pct", "close", "timestamp", "iv30")}
    d["exps"] = [str(x) for x in exps]
    d["e"] = eidx.astype(int).tolist()
    d["call"] = ch["call"].astype(int).tolist()
    for k, nd in _MIN_ROUND.items():
        v = np.round(ch[k], nd)
        d[k] = v.astype(int).tolist() if nd == 0 else v.tolist()
    return d


def chain_from_min(d: dict) -> dict:
    exps = np.array(d["exps"], dtype="datetime64[m]")
    ch = {k: d.get(k) for k in ("symbol", "spot", "prev_close", "chg_pct", "close", "timestamp", "iv30")}
    ch["exp"] = exps[np.array(d["e"], dtype=int)] if d["e"] else np.array([], dtype="datetime64[m]")
    ch["call"] = np.array(d["call"], dtype=bool)
    for k in _MIN_ROUND:
        ch[k] = np.array(d[k], dtype=float)
    return ch


def parse_chain(raw: dict) -> dict:
    if "_min" in raw:  # paquete compacto (motor en la nube y navegador)
        return chain_from_min(raw["_min"])
    data = raw["data"]
    opts = data["options"]
    n = len(opts)
    strikes = np.empty(n)
    is_call = np.empty(n, dtype=bool)
    expiry = np.empty(n, dtype="datetime64[m]")
    oi = np.empty(n)
    iv = np.empty(n)
    bid = np.zeros(n)
    ask = np.zeros(n)
    delta = np.zeros(n)
    vol = np.zeros(n)
    last = np.zeros(n)
    keep = np.ones(n, dtype=bool)

    for i, o in enumerate(opts):
        m = OCC_RE.match(o.get("option", ""))
        if not m:
            keep[i] = False
            continue
        root, ymd, cp, k = m.groups()
        strikes[i] = int(k) / 1000.0
        is_call[i] = cp == "C"
        ds = f"20{ymd[:2]}-{ymd[2:4]}-{ymd[4:6]}"
        hh, mm = (9, 30) if root in AM_SETTLED_ROOTS else ((13, 0) if ds in NYSE_EARLY_CLOSE else (16, 0))
        expiry[i] = np.datetime64(f"{ds}T{hh:02d}:{mm:02d}")
        oi[i] = float(o.get("open_interest") or 0)
        iv[i] = float(o.get("iv") or 0)
        bid[i] = float(o.get("bid") or 0)
        ask[i] = float(o.get("ask") or 0)
        delta[i] = float(o.get("delta") or 0)
        vol[i] = float(o.get("volume") or 0)
        last[i] = float(o.get("last_trade_price") or 0)

    iv_pos = iv[keep & (iv > 0)]
    if iv_pos.size and np.median(iv_pos) > 3:  # vino en porcentaje
        iv = iv / 100.0

    spot = float(data.get("current_price") or data.get("close") or 0)

    # IV de la opcion fuera de dinero en cada strike para las dos patas (paridad put-call):
    # las IV de opciones dentro de dinero salen de horquillas anchas y son ruido
    K_, C_, E_, IV_ = strikes[keep], is_call[keep], expiry[keep], iv[keep].copy()
    if K_.size:
        key = E_.astype("int64") * 10_000_000 + np.round(K_ * 1000).astype("int64")
        otm = np.where(C_, K_ >= spot, K_ <= spot) & (IV_ > 0.01)
        order = np.argsort(key)
        ks = key[order]
        ref = dict(zip(ks[otm[order]], IV_[order][otm[order]]))
        IV_ = np.array([ref.get(k, v) for k, v in zip(key, IV_)])
    chg = data.get("price_change_percent")
    return {
        "symbol": data.get("symbol", "").lstrip("^_"),
        "spot": spot,
        "prev_close": float(data.get("prev_day_close") or data.get("close") or spot),
        "chg_pct": float(chg) if chg is not None else None,
        "close": float(data.get("close") or spot),
        "timestamp": raw.get("timestamp") or data.get("last_trade_time"),
        "K": strikes[keep], "call": is_call[keep], "exp": expiry[keep],
        "oi": oi[keep], "iv": IV_, "iv_raw": iv[keep], "bid": bid[keep], "ask": ask[keep], "delta": delta[keep],
        "vol": vol[keep], "last": last[keep],
        "iv30": float(data.get("iv30") or 0) / 100.0,
    }


def _strike_step(K: np.ndarray, spot: float) -> float:
    """Paso de la rejilla: el mayor valor que divide todos los strikes cercanos al spot,
    para que cada strike caiga exactamente en su barra (p. ej. 0,5 si conviven strikes de 1 y 2,5)."""
    near = np.unique(K[np.abs(K / spot - 1) < 0.10])
    if near.size < 2:
        near = np.unique(K)
    milli = np.unique(np.round(near * 1000).astype(np.int64))
    if milli.size < 2:
        return 1.0
    g = int(np.gcd.reduce(np.diff(milli)))
    step = max(g, 1) / 1000
    # si hay strikes sueltos que fuerzan un paso diminuto, usa el paso habitual
    d = np.diff(milli) / 1000
    vals, counts = np.unique(d, return_counts=True)
    mode = float(vals[np.argmax(counts)])
    return mode if mode / step > 10 else step


def _nice_round(x: float, step: float) -> float:
    return round(round(x / step) * step, 4)


def _straddle_at(ch, sel, k):
    c = sel & (ch["K"] == k) & ch["call"]
    p = sel & (ch["K"] == k) & ~ch["call"]
    if not c.any() or not p.any():
        return None
    ci, pi = np.argmax(c), np.argmax(p)
    cb, ca, pb, pa = ch["bid"][ci], ch["ask"][ci], ch["bid"][pi], ch["ask"][pi]
    if cb > 0 and ca >= cb and pb > 0 and pa >= pb and (ca - cb) < 0.5 * ca and (pa - pb) < 0.5 * pa:
        return (cb + ca) / 2 + (pb + pa) / 2
    return None


def expected_move(ch: dict, spot: float, now: datetime) -> dict | None:
    """Movimiento esperado del vencimiento mas proximo = precio del straddle ATM (movimiento absoluto
    esperado). Se interpola entre los dos strikes que rodean al spot. Sin cotizaciones validas se estima
    con la IV: S * sqrt(w) * sqrt(2/pi), que es el mismo concepto en el modelo lognormal."""
    q = quote_time(now)
    now64 = np.datetime64(now.replace(second=0, microsecond=0))
    alive = ch["exp"] > now64
    if not alive.any():
        return None
    for ex in np.unique(ch["exp"][alive])[:3]:
        sel = alive & (ch["exp"] == ex)
        ks = np.unique(ch["K"][sel])
        if ks.size == 0:
            continue
        below, above = ks[ks <= spot], ks[ks >= spot]
        k1 = below.max() if below.size else ks.min()
        k2 = above.min() if above.size else ks.max()
        s1, s2 = _straddle_at(ch, sel, k1), _straddle_at(ch, sel, k2)
        method, k_ref = "straddle", float(ks[np.argmin(np.abs(ks - spot))])
        if s1 is not None and s2 is not None and k2 > k1:
            # el straddle vale minimo en el strike = spot: interpola sin el valor intrinseco
            f = (spot - k1) / (k2 - k1)
            move = (s1 - (spot - k1)) * (1 - f) + (s2 - (k2 - spot)) * f
        elif s1 is not None or s2 is not None:
            move = s1 if s1 is not None else s2
        else:
            idx = sel & (ch["K"] == k_ref)
            iv = float(ch["iv"][idx].mean()) if idx.any() else 0.0
            if iv <= 0:
                continue
            w, _ = variance_to_expiry(np.array([iv]), np.array([ex]), q, max(now, q))
            move = spot * math.sqrt(float(w[0])) * math.sqrt(2 / math.pi)
            method = "iv"
        if move <= 0:
            continue
        return {"expiry": str(ex.astype("datetime64[D]")), "move": float(move), "pct": float(move / spot * 100),
                "lo": float(spot - move), "hi": float(spot + move), "strike": k_ref, "method": method}
    return None


MOVE_SESSIONS = (1, 5)
AUTO_SIGMAS = 3.0  # rango automatico: 3 desviaciones tipicas de la proxima sesion (o de lo que queda de hoy)


def auto_window(moves: dict | None) -> float:
    """Ventana visible automatica en % del spot: se adapta a la volatilidad, util con 0DTE."""
    d1 = (moves or {}).get("d1") or {}
    pct = d1.get("pct")
    if not pct:
        return 3.0
    return float(min(10.0, max(0.6, round(AUTO_SIGMAS * pct, 2))))


def resolve_window(window_pct, ch: dict, spot: float, now: datetime) -> tuple[float, bool]:
    if isinstance(window_pct, str):
        return auto_window(implied_moves(ch, spot, now)), True
    return float(window_pct), False
INDEX_LIKE = INDEX_SYMBOLS | {"SPY", "QQQ", "IWM", "DIA"}  # productos de indice: Vol Trigger; acciones: Hedge Wall


def implied_moves(ch: dict, spot: float, now: datetime) -> dict | None:
    """Rango de 1 desviacion tipica (68,3%) para 1 y 5 sesiones, implicito en las opciones.
    Varianza ATM de cada vencimiento (IV de CBOE x tiempo natural), interpolada en minutos de mercado:
    w(H) para un horizonte de H minutos de negociacion. 1 sigma = S * sqrt(w(H))."""
    q = quote_time(now)
    alive = (ch["exp"] > np.datetime64(q.replace(second=0, microsecond=0))) & (ch["iv"] > 0.01)
    pts = []
    for ex in np.unique(ch["exp"][alive]):
        sel = alive & (ch["exp"] == ex)
        ks = np.unique(ch["K"][sel])
        lo, hi = ks[ks <= spot], ks[ks >= spot]
        if not lo.size or not hi.size:
            continue
        k1, k2 = lo.max(), hi.min()
        iv1 = float(ch["iv"][sel & (ch["K"] == k1)].mean())
        iv2 = float(ch["iv"][sel & (ch["K"] == k2)].mean())
        iv = iv1 if k2 == k1 else iv1 + (iv2 - iv1) * (spot - k1) / (k2 - k1)
        exd = ex.astype("datetime64[m]").astype(datetime)
        mins = trading_minutes(q, exd)
        if mins < 30 or iv <= 0:
            continue  # vencimientos a punto de expirar: su IV es ruido
        w = iv * iv * max((exd - q).total_seconds() / 60, 5.0) / YEAR_MIN
        pts.append((mins, w))
        if len(pts) >= 8 and mins > SESSION_MIN * 10:
            break
    if not pts:
        return None
    pts.sort()
    out = {}
    rest = trading_minutes(now, close_time(now)) if market_open(now) else 0.0
    for n in MOVE_SESSIONS:
        # con el mercado abierto, la sesion de hoy cuenta solo por lo que le queda
        H = (rest + SESSION_MIN * (n - 1)) if rest > 0 else SESSION_MIN * n
        prev_m, prev_w = 0.0, 0.0
        w = None
        for m_, w_ in pts:
            if m_ >= H:
                w = prev_w + (w_ - prev_w) * (H - prev_m) / (m_ - prev_m)
                break
            prev_m, prev_w = m_, w_
        if w is None:  # horizonte mas alla del ultimo vencimiento: varianza por minuto del ultimo
            w = pts[-1][1] * H / pts[-1][0]
        sig = spot * math.sqrt(max(w, 0.0))
        out[f"d{n}"] = {"sessions": n, "sigma": sig, "pct": sig / spot * 100, "lo": spot - sig, "hi": spot + sig}
    # sesion a la que se refiere el movimiento de 1 dia: hoy con el mercado abierto o antes de abrir; si no, la siguiente
    d = now if (is_trading_day(now) and now < close_time(now)) else next_trading_day(now)
    out["d1"]["session"] = d.strftime("%Y-%m-%d")
    out["d1"]["partial"] = rest > 0
    out["d1"]["minutes"] = rest if rest > 0 else SESSION_MIN
    return out


# ---------------------------------------------------------------- almacenamiento
def read_json(path: str, default=None):
    """Lee JSON plano o comprimido (.gz). Si existe la version antigua sin comprimir, tambien la lee."""
    import gzip
    for p in (path, path[:-3] if path.endswith(".gz") else path + ".gz"):
        if not os.path.exists(p):
            continue
        try:
            if p.endswith(".gz"):
                with gzip.open(p, "rt", encoding="utf-8") as f:
                    return json.load(f)
            with open(p, encoding="utf-8") as f:
                return json.load(f)
        except Exception:  # noqa: BLE001
            continue
    return default


def write_json(path: str, obj) -> None:
    """Escritura atomica; comprime si la ruta acaba en .gz y borra la version antigua sin comprimir."""
    import gzip
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    data = json.dumps(obj, separators=(",", ":"))
    if path.endswith(".gz"):
        with gzip.open(tmp, "wt", encoding="utf-8", compresslevel=6) as f:
            f.write(data)
    else:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(data)
    os.replace(tmp, path)
    old = path[:-3] if path.endswith(".gz") else None
    if old and os.path.exists(old):
        try:
            os.remove(old)
        except OSError:
            pass


HISTORY_YEARS = 3

# ---------------------------------------------------------------- lista de seguimiento (compartida con el recolector)
WATCHLIST_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "watchlist.json")
DEFAULT_WATCH = ["SPX", "NDX", "RUT", "SPY", "QQQ", "IWM", "AAPL", "MSFT", "NVDA", "AMZN", "META", "TSLA"]
_watch_lock = threading.Lock()


def load_watchlist(path: str | None = None) -> dict:
    d = read_json(path or WATCHLIST_PATH)
    if not d or not isinstance(d.get("symbols"), list):
        return {"symbols": list(DEFAULT_WATCH), "removed": {}, "default": True}
    d.setdefault("removed", {})
    return d


def save_watchlist(symbols: list[str], removed_override: dict | None = None, path: str | None = None) -> dict:
    """Guarda la lista; anota la fecha en que se quita cada ticker (sus datos pesados se borran a los 30 dias)."""
    with _watch_lock:
        clean = []
        for s in symbols:
            try:
                n = normalize(s)
            except ValueError:
                continue
            if n not in clean:
                clean.append(n)
        old = load_watchlist(path)
        removed = dict(removed_override if removed_override is not None else old.get("removed", {}))
        today = now_ny().strftime("%Y-%m-%d")
        for s in old["symbols"]:
            if s not in clean and s not in removed:
                removed[s] = today
        for s in clean:
            removed.pop(s, None)
        d = {"symbols": clean, "removed": removed, "updated": today}
        write_json(path or WATCHLIST_PATH, d)
        return d


# ---------------------------------------------------------------- historico diario
HIST_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "history")
_hist_lock = threading.Lock()


def session_date(ts) -> str:
    """Sesion (Nueva York) a la que pertenecen los precios y volumenes de CBOE: la ultima que ya ha abierto.
    De madrugada y en el pre-market los datos siguen siendo los de la sesion anterior. El timestamp viene en UTC."""
    try:
        t = datetime.strptime(str(ts)[:19].replace("T", " "), "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        local = (t + _ny_offset(t)).replace(tzinfo=None)
    except Exception:  # noqa: BLE001
        local = now_ny()
    if is_trading_day(local) and (local.hour, local.minute) >= (9, 30):
        return local.strftime("%Y-%m-%d")
    return prev_trading_day(local).strftime("%Y-%m-%d")


def premarket(now: datetime) -> bool:
    """Franja previa a la apertura (04:00-09:30 ET de un dia de mercado): el open interest ya es el del cierre
    anterior, asi que los niveles que se calculan aqui son los de la sesion que va a empezar (ex ante)."""
    return is_trading_day(now) and (4, 0) <= (now.hour, now.minute) < (9, 30)


def flow_valid(session: str, now: datetime) -> bool:
    """El volumen y el lado de las operaciones de una sesion se pueden guardar hasta las 04:00 ET del siguiente
    dia de mercado; despues CBOE puede haber publicado ya el open interest nuevo y se mezclarian dos dias."""
    nxt = next_trading_day(datetime.strptime(session, "%Y-%m-%d")).replace(hour=4)
    return now < nxt


def _snap(res: dict) -> dict:
    L = res["levels"]
    return {"spot": res["spot"], "call_wall": L["call_wall"], "put_wall": L["put_wall"], "flip": L["flip"],
            "vt": L["vt"], "abs_gamma": L["abs_gamma"], "net_per_pct": res["totals"]["net_per_pct"],
            "em_pct": (res.get("expected_move") or {}).get("pct"),
            "em_same_day": (res.get("expected_move") or {}).get("expiry") == res.get("session"),
            "em_expiry": (res.get("expected_move") or {}).get("expiry"),
            "m1_pct": ((res.get("moves") or {}).get("d1") or {}).get("pct"),
            "m1_session": ((res.get("moves") or {}).get("d1") or {}).get("session"),
            "saved": now_ny().strftime("%Y-%m-%d %H:%M")}


def history_update(res: dict, max_dte, save: bool = True, variant: str = "") -> dict | None:
    """Guarda la foto del dia y devuelve la de la sesion anterior (mismo filtro de vencimientos).
    Claves: 'fecha|filtro' = ultima foto de esa sesion (se sobrescribe hasta el cierre);
    'fecha|filtro|a' = foto ex ante de esa sesion (pre-market o primeros 15 min), la que usa la validacion."""
    key_dte = ("all" if max_dte is None else str(max_dte)) + variant
    path = os.path.join(HIST_DIR, f"{res['symbol'].replace('.', '_')}.json")
    now = now_ny()
    pre = premarket(now)
    early = market_open(now) and (now.hour, now.minute) < (9, 45)
    today_ny = now.strftime("%Y-%m-%d")
    with _hist_lock:
        try:
            with open(path, encoding="utf-8") as f:
                hist = json.load(f)
        except Exception:  # noqa: BLE001
            hist = {}
        today = res["session"]
        base = today_ny if pre else today  # en el pre-market se compara con la sesion de ayer
        prev_keys = sorted(k for k in hist if k.endswith("|" + key_dte) and k.split("|")[0] < base)
        prev = None
        if prev_keys:
            prev = dict(hist[prev_keys[-1]])
            prev["date"] = prev_keys[-1].split("|")[0]
        if save:
            snap = _snap(res)
            if not pre:
                hist[f"{today}|{key_dte}"] = snap
            if pre or early:
                hist[f"{today_ny}|{key_dte}|a"] = snap
            cutoff = f"{int(today[:4]) - HISTORY_YEARS}{today[4:]}"
            for k in [k for k in hist if k.split("|")[0] < cutoff]:
                hist.pop(k)
            try:
                write_json(path, hist)
            except OSError:
                pass
    return prev


# ---------------------------------------------------------------- posicionamiento estimado por flujo
FLOW_KAPPA = 0.5   # fraccion del volumen de hoy (clasificado) que se asume que abre posiciones nuevas
FLOW_DAYS = 8


def _contract_keys(K, C, E) -> list[str]:
    return [f"{str(e)[:16]}|{k:.3f}|{'C' if c else 'P'}" for k, c, e in zip(K, C, E)]


def _classify(last, bid, ask) -> np.ndarray:
    """+1 si la ultima operacion se cruzo cerca del ask (cliente compra), -1 cerca del bid (cliente vende),
    0 si fue en medio o no hay datos. Es la regla de cotizacion de Lee-Ready aplicada a la ultima operacion."""
    spread = ask - bid
    ok = (last > 0) & (bid > 0) & (ask > bid)
    s = np.zeros(last.size)
    s[ok & (last >= ask - 0.25 * spread)] = 1
    s[ok & (last <= bid + 0.25 * spread)] = -1
    return s


def record_flow(symbol: str, ch: dict, session: str, force: bool = False) -> None:
    """Guarda por contrato el OI (del cierre anterior), el volumen del dia y el lado de la ultima operacion."""
    if os.environ.get("GEX_FIXTURE_DIR") and not os.environ.get("GEX_FLOW_TEST"):
        return
    spot = ch["spot"]
    sel = ((ch["oi"] > 0) | (ch["vol"] > 0)) & (np.abs(ch["K"] / spot - 1) < 0.25)
    if not sel.any():
        return
    keys = _contract_keys(ch["K"][sel], ch["call"][sel], ch["exp"][sel])
    s = _classify(ch["last"][sel], ch["bid"][sel], ch["ask"][sel])
    day = {"oi": dict(zip(keys, ch["oi"][sel].astype(int).tolist())),
           "vol": dict(zip(keys, ch["vol"][sel].astype(int).tolist())),
           "s": dict(zip(keys, s.astype(int).tolist()))}
    path = os.path.join(HIST_DIR, f"flow_{symbol.replace('.', '_')}.json.gz")
    with _hist_lock:
        h = dict(_flow_read(path))  # copia: la cache la pueden estar leyendo otras hebras
        # la sesion ya guardada solo se reescribe con datos nuevos: como mucho cada 10 min con el mercado
        # abierto, o siempre que lo pida el recolector / el boton de actualizar (force)
        if session in h and not force:
            if h[session] == day:
                return
            mt = os.path.getmtime(path) if os.path.exists(path) else 0
            if time.time() - mt < FLOW_WRITE_GAP:
                return
        h[session] = day
        for k in sorted(h)[:-FLOW_DAYS]:
            h.pop(k)
        try:
            write_json(path, h)
            _flow_mem[path] = (os.path.getmtime(path), h)
        except OSError:
            pass


FLOW_WRITE_GAP = 600
_flow_mem: dict[str, tuple[float, dict]] = {}


def _flow_read(path: str) -> dict:
    """Lee el historico de flujo con cache en memoria (se invalida si el archivo cambia, p. ej. por el recolector)."""
    real = path if os.path.exists(path) else path[:-3]
    try:
        mt = os.path.getmtime(real)
    except OSError:
        return {}
    hit = _flow_mem.get(path)
    if hit and hit[0] == mt:
        return hit[1]
    h = read_json(path, {}) or {}
    _flow_mem[path] = (mt, h)
    return h


def _flow_pre(symbol: str, cc: dict) -> dict | None:
    fx = os.environ.get("GEX_FIXTURE_DIR")
    if not fx:
        return None
    d = read_json(os.path.join(fx, f"flowpos_{symbol.replace('.', '_')}.json"))
    if not d or len(d.get("pos", [])) != cc["K"].size:
        return None
    return {"pos": np.array(d["pos"], dtype=float), "info": d.get("info") or {}}


def flow_positions_all(symbol: str, ch: dict) -> dict:
    """Posiciones por flujo de todos los contratos de la cadena (para el paquete del navegador)."""
    sign = np.where(ch["call"], 1.0, -1.0)
    m = np.ones(ch["K"].size, dtype=bool)
    pos, info = flow_positions(symbol, ch, m, sign * ch["oi"])
    return {"pos": np.round(pos, 2).tolist(), "info": {k: info[k] for k in ("days", "first", "kappa", "gaps") if k in info}}


def flow_positions(symbol: str, cc: dict, m: np.ndarray, std_pos: np.ndarray):
    """Posicion estimada de los dealers por contrato.
    Parte de la convencion estandar en el primer dia guardado y la corrige cada noche: el cambio de OI
    de cada contrato se atribuye al lado de la ultima operacion del dia anterior (si el cliente compro,
    los dealers quedan cortos de esas opciones, sea call o put). Se anade el FLOW_KAPPA del volumen de hoy.
    La posicion se limita a +/- OI."""
    pre = _flow_pre(symbol, cc)
    if pre is not None:  # posiciones ya calculadas por el motor (navegador): mismo resultado sin el historico
        pos = pre["pos"][m]
        std_sign = np.sign(std_pos)
        info = dict(pre["info"])
        info["changed"] = int((np.sign(pos) != std_sign).sum())
        info["share_flipped"] = float(np.abs(pos - std_pos).sum() / max(np.abs(std_pos).sum(), 1e-9))
        return pos, info
    h = _flow_read(os.path.join(HIST_DIR, f"flow_{symbol.replace('.', '_')}.json.gz"))
    days = sorted(h)
    info = {"days": len(days), "first": days[0] if days else None, "kappa": FLOW_KAPPA, "changed": 0, "gaps": 0}
    if not days:
        return std_pos, info
    keys = _contract_keys(cc["K"][m], cc["call"][m], cc["exp"][m])
    std_sign = np.sign(std_pos)
    oi_now = np.abs(std_pos)
    # pares de sesiones consecutivas; si entre ellas faltan dias de mercado, el cambio de OI de ese
    # tramo se reparte con la convencion estandar (sin datos no se inventa una direccion)
    pairs = []
    for a, b in zip(days[:-1], days[1:]):
        nxt = next_trading_day(datetime.strptime(a, "%Y-%m-%d")).strftime("%Y-%m-%d")
        pairs.append((a, b, nxt == b))
    info["gaps"] = sum(1 for p in pairs if not p[2])
    pos = np.empty(len(keys))
    for i, k in enumerate(keys):
        d0 = h[days[0]]
        p = std_sign[i] * d0["oi"].get(k, 0)
        for a, b, contiguous in pairs:
            da, db = h[a], h[b]
            doi = db["oi"].get(k, 0) - da["oi"].get(k, 0)
            if doi:
                s = da["s"].get(k, 0) if contiguous else 0
                p += -s * abs(doi) if s else std_sign[i] * doi
        today = h[days[-1]]
        s_t, v_t = today["s"].get(k, 0), today["vol"].get(k, 0)
        p += -s_t * v_t * FLOW_KAPPA
        pos[i] = float(np.clip(p, -oi_now[i], oi_now[i])) if oi_now[i] > 0 else 0.0
    info["changed"] = int((np.sign(pos) != std_sign).sum())
    info["share_flipped"] = float(np.abs(pos - std_pos).sum() / max(np.abs(std_pos).sum(), 1e-9))
    return pos, info


# ---------------------------------------------------------------- escaner
def scan(symbols: list[str], max_dte, workers: int = 4) -> list[dict]:
    from concurrent.futures import ThreadPoolExecutor

    def one(sym):
        try:
            r = compute(sym, max_dte=max_dte, window_pct=5.0)
            L, s = r["levels"], r["spot"]
            pct = lambda v: None if v is None else (v / s - 1) * 100  # noqa: E731
            em = (r.get("moves") or {}).get("d1") or {}
            prev = r.get("prev") or {}
            return {"symbol": r["symbol"], "name": r["name"], "spot": s,
                    "chg": r["chg_pct"],
                    "regime": r["regime"], "net_per_pct": r["totals"]["net_per_pct"],
                    "flip": L["flip"], "flip_dist": pct(L["flip_exact"]),
                    "call_wall": L["call_wall"], "call_dist": pct(L["call_wall"]),
                    "put_wall": L["put_wall"], "put_dist": pct(L["put_wall"]),
                    "vt": L["vt"], "em_pct": em.get("pct"), "front_share": r["front_share"], "is_index": r["is_index"],
                    "step": r["step"], "prev": {k: prev.get(k) for k in ("date", "call_wall", "put_wall", "flip", "net_per_pct")} if prev else None}
        except Exception as e:  # noqa: BLE001
            return {"symbol": sym.upper(), "error": str(e)}

    with ThreadPoolExecutor(max_workers=workers) as ex:
        return list(ex.map(one, symbols))


def combine_with_proxy(symbol: str, ch: dict, force: bool = False):
    """Suma las opciones del ETF al indice (SPX+SPY, NDX+QQQ, RUT+IWM), como los niveles 'combo'.
    Cada contrato del ETF se lleva a unidades del indice con r = spot_indice / spot_ETF:
    strike K*r y OI/r (mismo multiplicador 100), de modo que su GEX en $ se conserva."""
    proxy = INDEX_PROXY.get(symbol)
    if not proxy:
        return ch, None
    ech = parse_chain(fetch_chain(proxy, force=force))
    if ech["spot"] <= 0 or ch["spot"] <= 0:
        return ch, None
    r = ch["spot"] / ech["spot"]
    cc = dict(ch)
    for k, fn in (("K", lambda a: a * r), ("call", None), ("exp", None), ("oi", lambda a: a / r), ("iv", None)):
        cc[k] = np.concatenate([ch[k], fn(ech[k]) if fn else ech[k]])
    cc["is_proxy"] = np.concatenate([np.zeros(ch["K"].size, bool), np.ones(ech["K"].size, bool)])
    return cc, {"proxy": proxy, "ratio": r, "contracts": int((ech["oi"] > 0).sum())}


def compute(symbol: str, max_dte: int | None = 45, window_pct: float = 5.0,
            spot_override: float | None = None, force: bool = False, combine: bool = False,
            positioning: str = "standard") -> dict:
    raw = fetch_chain(symbol, force=force)
    ch = parse_chain(raw)
    save_chain_snapshot(normalize(symbol), ch)
    sess = session_date(ch["timestamp"])
    if flow_valid(sess, now_ny()):
        record_flow(normalize(symbol), ch, sess, force=force)
    spot_mkt = ch["spot"]
    implied = implied_index_spot(normalize(symbol), ch["close"], now_ny())
    if spot_override:
        spot = float(spot_override)
    elif implied and implied["use"]:
        spot = implied["value"]  # pre-market: el indice aun no cotiza
    else:
        spot = spot_mkt
    if spot <= 0:
        raise ValueError("Sin precio del subyacente")

    now_dt = now_ny().replace(second=0, microsecond=0)
    q_dt = quote_time(now_dt)  # instante de las IV (ahora, o el ultimo cierre si el mercado esta cerrado)
    now = np.datetime64(now_dt)
    window_pct, window_auto = resolve_window(window_pct, ch, spot, now_dt)
    index_K = ch["K"]
    cc, combo = combine_with_proxy(normalize(symbol), ch, force) if combine else (ch, None)
    alive = cc["exp"] > np.datetime64(q_dt)
    dte = np.floor((cc["exp"].astype("datetime64[D]") - now.astype("datetime64[D]")).astype(float))

    # filtro de vencimientos
    if max_dte == 0:
        exps_alive = np.unique(cc["exp"][alive].astype("datetime64[D]"))
        first = exps_alive.min() if exps_alive.size else None
        exp_mask = cc["exp"].astype("datetime64[D]") == first if first is not None else alive
    elif max_dte is None:
        exp_mask = np.ones_like(alive)
    else:
        exp_mask = dte <= max_dte

    m = alive & exp_mask & (cc["oi"] > 0) & (cc["iv"] > 0.01) & (np.abs(cc["K"] / spot - 1) < 0.35)
    if not m.any():
        raise LookupError("No hay contratos con open interest en ese filtro")

    K, C, OI, IV = cc["K"][m], cc["call"][m], cc["oi"][m], cc["iv"][m]
    EXP = cc["exp"][m]
    W, TT = variance_to_expiry(IV, EXP, q_dt, q_dt)
    front_exp = EXP.min()
    FRONT = EXP == front_exp
    sign = np.where(C, 1.0, -1.0)
    n_exp = int(np.unique(cc["exp"][m]).size)

    # --- GEX por contrato a spot actual ($ delta por $1)
    # posicion de los dealers por contrato (en contratos): convencion estandar o estimada por flujo
    pos = sign * OI
    flow_info = None
    if positioning == "flow" and not combine:
        pos, flow_info = flow_positions(normalize(symbol), cc, m, sign * OI)
    g = gamma_w(spot, K, W, TT)
    gex = pos * g * 100.0 * spot
    va, chm = vanna_charm_w(spot, K, W, TT)
    vex = pos * va * 0.01 * 100.0 * spot          # cambio de delta ($) de los dealers si la IV sube 1 punto
    # cambio de delta ($) de los dealers por un dia que pasa. Si el contrato vence antes de un dia, la tasa
    # instantanea extrapolada a 24 h no tiene sentido (la delta solo puede ir hasta 0 o 1): se usa el cambio
    # real hasta el vencimiento, delta al vencer menos delta actual
    day_move = chm / 365.0
    short = TT < 1.0 / 365.0
    if short.any():
        from math import erf as _erf
        d1s = (np.log(spot / K[short]) + risk_free() * TT[short] + 0.5 * W[short]) / np.sqrt(W[short])
        ncdf = 0.5 * (1 + np.vectorize(_erf)(d1s / math.sqrt(2)))
        call_s = C[short]
        delta_now = np.where(call_s, ncdf, ncdf - 1)
        delta_exp = np.where(call_s, (spot > K[short]).astype(float), -(spot < K[short]).astype(float))
        day_move = day_move.copy()
        day_move[short] = delta_exp - delta_now
    cex = pos * day_move * 100.0 * spot

    # --- rejilla de strikes amplia (los niveles se calculan aqui, no en la ventana visible)
    step = _strike_step(index_K[np.isin(index_K, K)] if combine else K, spot)
    wide = max(LEVEL_WINDOW_PCT, window_pct)
    g_lo = math.floor(spot * (1 - wide / 100) / step) * step
    g_hi = math.ceil(spot * (1 + wide / 100) / step) * step
    wgrid = np.round(np.arange(g_lo, g_hi + step / 2, step), 4)
    idx = np.round((K - g_lo) / step).astype(int)
    inw = (idx >= 0) & (idx < wgrid.size)
    wnet = np.zeros(wgrid.size); wcalls = np.zeros(wgrid.size); wputs = np.zeros(wgrid.size)
    np.add.at(wnet, idx[inw], gex[inw])
    np.add.at(wcalls, idx[inw & C], gex[inw & C])
    np.add.at(wputs, idx[inw & ~C], gex[inw & ~C])
    wfront = np.zeros(wgrid.size)
    np.add.at(wfront, idx[inw & FRONT], gex[inw & FRONT])
    # flujos de cobertura (lo que harian los dealers): vanna si la IV CAE 1 punto, charm por un dia
    wvanna = np.zeros(wgrid.size); wcharm = np.zeros(wgrid.size)
    np.add.at(wvanna, idx[inw], vex[inw])
    np.add.at(wcharm, idx[inw], -cex[inw])

    # ventana visible
    vis = (wgrid >= math.floor(spot * (1 - window_pct / 100) / step) * step - 1e-9) & \
          (wgrid <= math.ceil(spot * (1 + window_pct / 100) / step) * step + 1e-9)
    grid, net, calls, puts, front = wgrid[vis], wnet[vis], wcalls[vis], wputs[vis], wfront[vis]
    vanna_s, charm_s = wvanna[vis], wcharm[vis]

    # --- perfil: GEX total en spots hipoteticos
    span = max(window_pct * 2.0, 8.0) / 100
    xs = np.linspace(spot * (1 - span), spot * (1 + span), 161)
    prof = np.empty(xs.size)
    chunk = 20
    for a in range(0, xs.size, chunk):
        S = xs[a:a + chunk, None]
        prof[a:a + chunk] = (pos * gamma_w(S, K, W, TT) * 100.0 * S).sum(axis=1)

    # --- gamma flip: cruce por cero mas cercano al spot
    flip_exact = None
    sc = np.where(np.sign(prof[:-1]) * np.sign(prof[1:]) < 0)[0]
    if sc.size:
        cands = [xs[i] - prof[i] * (xs[i + 1] - xs[i]) / (prof[i + 1] - prof[i]) for i in sc]
        flip_exact = float(min(cands, key=lambda v: abs(v - spot)))
    flip = _nice_round(flip_exact, step) if flip_exact else None

    # --- walls
    # Call Wall: strike con mayor GEX neta positiva por encima del spot.
    # Put Wall: strike con mayor GEX neta negativa por debajo del spot.
    # Si un lado no tiene barras de ese signo, se usa la gamma de calls / puts sola.
    up, dn = wgrid > spot, wgrid < spot

    def _pick(mask, primary, fallback, best):
        for arr in (primary, fallback):
            vals = np.where(mask, arr, 0.0)
            v = best(vals)
            if (vals[v] > 0) if best is np.argmax else (vals[v] < 0):
                return float(wgrid[v])
        return None

    call_wall = _pick(up, wnet, wcalls, np.argmax) or _pick(np.ones_like(up), wcalls, wcalls, np.argmax)
    put_wall = _pick(dn, wnet, wputs, np.argmin) or _pick(np.ones_like(dn), wputs, wputs, np.argmin)
    abs_g = float(wgrid[np.argmax(np.abs(wcalls) + np.abs(wputs))])

    # --- volatility trigger (aproximacion propia): el strike mas alto con gamma neta negativa
    # significativa (>= 25% del maximo absoluto) por debajo del gamma flip, es decir, la ultima
    # concentracion de gamma negativa antes de entrar en la zona positiva
    vt = None
    peak = np.abs(wnet).max()
    if peak > 0 and flip_exact is not None:
        cand = np.where((wgrid <= flip_exact) & (wnet < 0) & (np.abs(wnet) >= 0.25 * peak))[0]
        if cand.size:
            vt = float(wgrid[cand.max()])

    net_total = float(gex.sum())
    res = {
        "symbol": normalize(symbol),
        "name": name_of(normalize(symbol)),
        "spot": spot, "spot_market": spot_mkt, "spot_manual": bool(spot_override),
        "spot_implied": implied,
        "prev_close": ch["prev_close"],
        "chg_pct": ch["chg_pct"] if ch["chg_pct"] is not None else (spot_mkt / ch["prev_close"] - 1) * 100,
        "timestamp": ch["timestamp"],
        "quote_time": q_dt.strftime("%Y-%m-%d %H:%M"),
        "computed_at": now_ny().strftime("%Y-%m-%d %H:%M ET"),
        "step": step,
        "strikes": grid.tolist(),
        "net": net.tolist(), "calls": calls.tolist(), "puts": puts.tolist(), "front": front.tolist(),
        "vanna": vanna_s.tolist(), "charm": charm_s.tolist(),
        "combo": combo, "positioning": positioning if not (positioning == "flow" and combine) else "standard",
        "flow_info": flow_info,
        "front_expiry": str(front_exp.astype("datetime64[D]")),
        "front_share": float(np.abs(gex[FRONT]).sum() / max(np.abs(gex).sum(), 1e-12)),
        "expected_move": expected_move(ch, spot, now_dt),
        "moves": implied_moves(ch, spot, now_dt),
        "is_index": normalize(symbol) in INDEX_LIKE,
        "profile": {"x": xs.tolist(), "y": prof.tolist()},
        "levels": {"call_wall": call_wall, "put_wall": put_wall, "flip": flip,
                   "flip_exact": flip_exact, "vt": vt, "abs_gamma": abs_g},
        "totals": {
            "net_per_dollar": net_total,
            "net_per_pct": net_total * spot * 0.01,
            "call_per_pct": float(gex[C].sum()) * spot * 0.01,
            "put_per_pct": float(gex[~C].sum()) * spot * 0.01,
            "vanna_flow": float(vex.sum()),     # $ que comprarian (+) / venderian (-) si la IV cae 1 punto
            "charm_flow": float(-cex.sum()),    # $ que comprarian (+) / venderian (-) por el paso de un dia
        },
        "regime": "positive" if net_total > 0 else "negative",
        "rate": rate_info(),
        "meta": {"contracts": int(m.sum()), "expirations": n_exp,
                 "max_dte": max_dte, "window_pct": window_pct, "window_auto": window_auto},
    }
    res["session"] = session_date(ch["timestamp"])
    res["prev"] = history_update(res, max_dte, save=not spot_override,
                                 variant=("c" if combo else "") + ("f" if res["positioning"] == "flow" else ""))
    return res


# ================================================================ mapa de calor (estilo TRACE)
def map_session(now: datetime, which: str = "auto") -> tuple[datetime, str]:
    """Sesion del mapa. 'next': hoy si es dia de mercado y no ha cerrado; si no, el siguiente.
    'last': la sesion de hoy si ya ha empezado, o la anterior. 'auto': 'next' antes del cierre, 'last' despues."""
    d = now.replace(hour=0, minute=0, second=0, microsecond=0)
    before_close = is_trading_day(now) and now < close_time(now)
    if which == "auto":
        which = "next" if before_close else "last"
    if which == "next":
        return (d if before_close else next_trading_day(d)), "next"
    if is_trading_day(now) and now >= now.replace(hour=9, minute=30, second=0, microsecond=0):
        return d, "last"
    return prev_trading_day(d), "last"


# ---------------------------------------------------------------- copias de la cadena por sesion
CHAIN_SESSIONS = 10


def _snap_path(symbol: str, day: str) -> str:
    return os.path.join(HIST_DIR, "chains", f"{symbol.replace('.', '_')}_{day}.json.gz")


def save_chain_snapshot(symbol: str, ch: dict) -> None:
    """Durante la sesion guarda la cadena (strikes, OI, IV, vencimientos) para poder repetir el mapa
    despues, cuando CBOE ya haya borrado los contratos vencidos. Como mucho una vez cada 30 min."""
    now = now_ny()
    if not market_open(now) or os.environ.get("GEX_FIXTURE_DIR"):
        return
    path = _snap_path(symbol, now.strftime("%Y-%m-%d"))
    try:
        if os.path.exists(path) and time.time() - os.path.getmtime(path) < 1800:
            return
        keep = ch["oi"] > 0
        data = {"saved_at": now.strftime("%Y-%m-%d %H:%M"), "spot": ch["spot"], "K": ch["K"][keep].tolist(), "C": ch["call"][keep].astype(int).tolist(),
                "E": [str(x) for x in ch["exp"][keep]], "OI": ch["oi"][keep].tolist(),
                "IV": np.round(ch["iv"][keep], 5).tolist()}
        write_json(path, data)
        # conserva solo las 10 ultimas sesiones de cada ticker
        pref = os.path.basename(path).rsplit("_", 1)[0] + "_"
        rx = re.compile(re.escape(pref) + r"\d{4}-\d{2}-\d{2}\.json(\.gz)?$")
        olds = sorted(x for x in os.listdir(os.path.dirname(path)) if rx.match(x))
        for x in olds[:-CHAIN_SESSIONS]:
            os.remove(os.path.join(os.path.dirname(path), x))
    except Exception:  # noqa: BLE001
        pass


def load_chain_snapshot(symbol: str, day: str) -> dict | None:
    d = read_json(_snap_path(symbol, day))
    if not d:
        return None
    saved = None
    if d.get("saved_at"):
        try:
            saved = datetime.strptime(d["saved_at"], "%Y-%m-%d %H:%M")
        except ValueError:
            saved = None
    return {"saved_at": saved, "spot": d["spot"], "K": np.array(d["K"], float), "call": np.array(d["C"], bool),
            "exp": np.array(d["E"], dtype="datetime64[m]"), "oi": np.array(d["OI"], float), "iv": np.array(d["IV"], float)}


_heat_cache: dict[str, tuple[float, dict]] = {}


def heatmap(symbol: str, max_dte: int | None = 45, window_pct: float = 5.0,
            spot_override: float | None = None, rows: int = 140, step_min: int = 5, which: str = "auto",
            combine: bool = False, positioning: str = "standard") -> dict:
    """GEX total (por 1%) si el subyacente estuviera en cada precio a cada hora de la sesion.
    El open interest es el del cierre anterior: el mapa cambia con el tiempo y el precio, no con el flujo."""
    symbol = normalize(symbol)
    key = f"{symbol}|{max_dte}|{window_pct}|{spot_override}|{which}|{combine}|{positioning}"
    hit = _heat_cache.get(key)
    if hit and time.time() - hit[0] < CACHE_TTL:
        return hit[1]

    ch = parse_chain(fetch_chain(symbol))
    spot = float(spot_override) if spot_override else ch["spot"]
    now = now_ny()
    window_pct, _ = resolve_window(window_pct, ch, spot, now)
    sess, kind = map_session(now, which)
    day = sess.strftime("%Y-%m-%d")
    approx = False
    q = quote_time(now)  # instante de las IV usadas
    if day < now.strftime("%Y-%m-%d") or (kind == "last" and not market_open(now)):
        snap = load_chain_snapshot(symbol, day)
        if snap is not None:
            ch = {**ch, **snap}
            q = snap.get("saved_at") or q
        elif day < now.strftime("%Y-%m-%d"):
            approx = True  # sin copia de esa sesion: faltan los contratos que vencieron ese dia
    if combine:
        ch, _ = combine_with_proxy(symbol, ch)
    t0, t1 = sess.replace(hour=9, minute=30), close_time(sess) - timedelta(minutes=5)
    times = []
    t = t0
    while t <= t1:
        times.append(t)
        t += timedelta(minutes=step_min)

    exp_d = ch["exp"].astype("datetime64[D]")
    dte_sess = (exp_d - np.datetime64(sess.date())).astype(int)
    alive = ch["exp"] > np.datetime64(t0)
    if max_dte == 0:
        first = exp_d[alive].min() if alive.any() else None
        f = exp_d == first if first is not None else alive
    elif max_dte is None:
        f = np.ones_like(alive)
    else:
        f = dte_sess <= max_dte
    m = alive & f & (ch["oi"] > 0) & (ch["iv"] > 0.01) & (np.abs(ch["K"] / spot - 1) < max(0.2, window_pct * 3 / 100))
    if not m.any():
        raise LookupError("No hay contratos con open interest en ese filtro")
    K, C, OI, IV, EXP = ch["K"][m], ch["call"][m], ch["oi"][m], ch["iv"][m], ch["exp"][m]
    sign = np.where(C, 1.0, -1.0)
    pos = sign * OI
    if positioning == "flow" and not combine:
        pos, _ = flow_positions(symbol, ch, m, sign * OI)
    w = pos * 100.0

    # velas de 5 minutos de la sesion
    candles = []
    raw = fetch_aux("intraday", symbol, ttl=60)
    if raw:
        buckets: dict[str, list] = {}
        for b in raw.get("data", []):
            dt = str(b.get("datetime", ""))
            p = b.get("price") or {}
            if not dt.startswith(day) or not p.get("close"):
                continue
            hh, mm = int(dt[11:13]), int(dt[14:16])
            mins = hh * 60 + mm - 1  # la vela de 09:31 cubre 09:30-09:31
            k5 = f"{mins // 60:02d}:{(mins % 60) // 5 * 5:02d}"
            o, h, l, c = (float(p.get(x) or p["close"]) for x in ("open", "high", "low", "close"))
            if k5 not in buckets:
                buckets[k5] = [o, h, l, c]
            else:
                bk = buckets[k5]
                bk[1], bk[2], bk[3] = max(bk[1], h), min(bk[2], l), c
        candles = [[k, *v] for k, v in sorted(buckets.items())]

    lo, hi = spot * (1 - window_pct / 100), spot * (1 + window_pct / 100)
    if candles:  # que el rango incluya todo el dia
        lo = min(lo, min(c[3] for c in candles) * 0.998)
        hi = max(hi, max(c[2] for c in candles) * 1.002)
    ys = np.linspace(lo, hi, rows)
    S = ys[:, None]
    Z = np.zeros((rows, len(times)), dtype=np.float64)
    ZK = np.zeros((rows, len(times)), dtype=np.float64)
    # gamma concentrada en cada strike: gamma ATM de los contratos de ese strike (precio = strike),
    # repartida en vertical con un nucleo gaussiano para dibujar franjas continuas como TRACE
    step = _strike_step(K, spot)
    # ancho de cada franja: nunca menor que dos filas del mapa (evita el patron de rayas por muestreo)
    # y del orden del 2% del rango visible, para leer zonas en lugar de strikes sueltos
    sigma = max(step * 2.0, (hi - lo) / rows * 2.0, (hi - lo) * 0.02)
    # call y put del mismo strike y vencimiento comparten IV (paridad), asi que su gamma es identica:
    # se agrupan sumando posiciones (resultado exacto, la mitad de calculo)
    keyarr = np.rec.fromarrays([K, EXP.astype("datetime64[m]").astype(np.int64), IV])
    _, first_idx, grp = np.unique(keyarr, return_index=True, return_inverse=True)
    wg = np.bincount(grp.ravel(), weights=w, minlength=first_idx.size)
    K, EXP, IV, w = K[first_idx], EXP[first_idx], IV[first_idx], wg
    kern = np.exp(-0.5 * ((ys[:, None] - K[None, :]) / sigma) ** 2)
    # log(S/K) no cambia con la hora: se calcula una vez. float32 basta para un mapa de color
    log_sk = np.log(S / K[None, :]).astype(np.float32)
    # columna de referencia para las barras laterales del modo "por strike": la hora actual con el mercado
    # abierto o la ultima vela de la sesion repetida; sin velas, la primera columna (la proxima sesion)
    live_now = market_open(now) and sess.date() == now.date()
    if live_now:
        jref = max(0, min(len(times) - 1, int(((now - t0).total_seconds() / 60) // step_min)))
    elif candles:
        hh, mm = map(int, candles[-1][0].split(":"))
        jref = max(0, min(len(times) - 1, ((hh * 60 + mm) - (9 * 60 + 30)) // step_min))
    else:
        jref = 0
    kbar = None
    for j, tt in enumerate(times):
        live = EXP > np.datetime64(tt.replace(second=0, microsecond=0))
        if not live.any():
            continue
        # varianza restante en cada instante: se consume solo en horas de mercado (ver variance_to_expiry)
        Wl, Tl = variance_to_expiry(IV[live], EXP[live], q, tt)
        sw = np.sqrt(Wl)
        lsk = log_sk if live.all() else log_sk[:, live]
        d1 = lsk + (risk_free() * Tl + 0.5 * Wl).astype(np.float32)
        d1 *= (1.0 / sw).astype(np.float32)
        np.square(d1, out=d1)
        d1 *= -0.5
        np.exp(d1, out=d1)
        # gamma = pdf(d1) / (S * sqrt(w)); la division por S se aplica despues de sumar
        Z[:, j] = (d1 @ (w[live] / (math.sqrt(2 * math.pi) * sw)).astype(np.float32)).astype(np.float64) * ys * 0.01  # $ por 1%
        gk = gamma_w(K[live], K[live], Wl, Tl) * w[live] * K[live] * K[live] * 0.01
        ZK[:, j] = kern[:, live] @ gk
        if j == jref:
            kbar = (K[live], gk)

    # barras laterales en la misma medida que el mapa "por strike": gamma en cada strike (si el precio estuviera ahi)
    strike_bars = None
    if kbar is not None:
        ku, inv = np.unique(np.round(kbar[0], 4), return_inverse=True)
        vu = np.bincount(inv.ravel(), weights=kbar[1], minlength=ku.size)
        inside = (ku >= lo) & (ku <= hi)
        strike_bars = {"k": ku[inside].tolist(), "v": np.round(vu[inside], 0).tolist(), "time": times[jref].strftime("%H:%M")}

    # las barras del panel lateral deben cubrir todo el rango de precios del mapa (que se amplia con las velas)
    cover = max(window_pct, (spot / lo - 1) * 100, (hi / spot - 1) * 100) + 0.1
    lev = compute(symbol, max_dte=max_dte, window_pct=cover, spot_override=spot_override,
                  combine=combine, positioning=positioning)
    res = {
        "symbol": symbol, "spot": spot, "session": day, "kind": kind, "approx": approx,
        "live": market_open(now) and sess.date() == now.date(),
        "now": now.strftime("%H:%M"),
        "times": [t.strftime("%H:%M") for t in times],
        "prices": ys.tolist(), "z": np.round(Z, 0).tolist(), "zk": np.round(ZK, 0).tolist(),
        "candles": candles, "levels": lev["levels"], "step": lev["step"], "strike_bars": strike_bars,
        "strikes": lev["strikes"], "net": lev["net"], "front": lev["front"],
        "front_expiry": lev["front_expiry"], "expected_move": lev["expected_move"], "name": lev["name"],
    }
    _heat_cache[key] = (time.time(), res)
    return res


# ================================================================ volatilidad (Compass)
def history_ohlc(symbol: str) -> tuple[dict, str | None]:
    """Cierres diarios {fecha: (o, h, l, c)}. CBOE no publica el historico de NDX ni RUT:
    en ese caso usa su ETF (QQQ, IWM) e indica cual."""
    for sym, src in ((symbol, None), (INDEX_PROXY.get(symbol), INDEX_PROXY.get(symbol))):
        if not sym:
            continue
        raw = fetch_aux("historical", sym, ttl=6 * 3600)
        out = {}
        for r in (raw or {}).get("data", []):
            try:
                c = float(r["close"])
                out[r["date"]] = (float(r.get("open") or c), float(r.get("high") or c), float(r.get("low") or c), c)
            except (KeyError, ValueError):
                continue
        if out:
            return out, src
    return {}, None


def _realized_vol(symbol: str, n: int = 20) -> float | None:
    ohlc, _ = history_ohlc(symbol)
    raw = {"data": [{"close": str(v[3])} for _, v in sorted(ohlc.items())]} if ohlc else None
    if not raw:
        return None
    closes = [float(r["close"]) for r in raw.get("data", [])[-(n + 1):] if float(r.get("close") or 0) > 0]
    if len(closes) < n // 2:
        return None
    r = np.diff(np.log(np.array(closes)))
    return float(r.std(ddof=1) * math.sqrt(252))


def vol_metrics(symbol: str) -> dict:
    """IV a 30 dias, risk reversal 25 delta (~30 dias) y volatilidad realizada a 20 dias."""
    ch = parse_chain(fetch_chain(symbol))
    now = np.datetime64(now_ny().replace(second=0, microsecond=0))
    alive = (ch["exp"] > now) & (ch["iv"] > 0.01) & (ch["delta"] != 0)
    exps = np.unique(ch["exp"][alive])
    if exps.size == 0:
        raise LookupError("Sin vencimientos validos")
    dtes = (exps - now).astype("timedelta64[m]").astype(float) / (24 * 60)
    ex = exps[np.argmin(np.abs(dtes - 30))]
    sel = alive & (ch["exp"] == ex)
    c = sel & ch["call"]
    p = sel & ~ch["call"]
    rr = None
    if c.any() and p.any():
        ci = np.where(c)[0][np.argmin(np.abs(ch["delta"][c] - 0.25))]
        pi = np.where(p)[0][np.argmin(np.abs(ch["delta"][p] + 0.25))]
        rr = float(ch["iv"][ci] - ch["iv"][pi])
    iv30 = ch["iv30"]
    if not iv30:  # sin IV30 publicada: IV ATM del vencimiento ~30d
        k = sel & (np.abs(ch["K"] - ch["spot"]) == np.abs(ch["K"][sel] - ch["spot"]).min())
        iv30 = float(ch["iv"][k].mean()) if k.any() else None
    rv = _realized_vol(symbol)
    return {"iv30": iv30, "rr25": rr, "rv20": rv, "rr_dte": float(dtes[np.argmin(np.abs(dtes - 30))])}


def _vol_history(symbol: str, today: str, snap: dict | None) -> dict:
    path = os.path.join(HIST_DIR, f"vol_{symbol.replace('.', '_')}.json")
    return _vol_history_rw(path, today, snap)


def _vol_history_rw(path: str, today: str, snap: dict | None) -> dict:
    with _hist_lock:
        try:
            with open(path, encoding="utf-8") as f:
                h = json.load(f)
        except Exception:  # noqa: BLE001
            h = {}
        # solo dias de mercado: una foto con fecha de fin de semana duplicaria la del viernes en los ranks
        bad = [k for k in h if not is_trading_day(datetime.strptime(k, "%Y-%m-%d"))]
        for k in bad:
            h.pop(k)
        if snap and is_trading_day(datetime.strptime(today, "%Y-%m-%d")):
            h[today] = snap
        if snap or bad:
            for k in sorted(h)[:-(252 * HISTORY_YEARS)]:
                h.pop(k)
            try:
                write_json(path, h)
            except OSError:
                pass
    return h


def _rank(v, arr):
    arr = [a for a in arr if a is not None]
    if v is None or len(arr) < 2:
        return None
    lo, hi = min(arr), max(arr)
    return 50.0 if hi == lo else float((v - lo) / (hi - lo) * 100)


MIN_HIST_DAYS = 60
# indices de volatilidad de CBOE con historico gratuito: dan un IV rank de un ano desde el primer dia
VOL_INDEX = {"SPX": "VIX", "SPY": "VIX", "XSP": "VIX", "NDX": "VXN", "QQQ": "VXN", "DJX": "VXD", "DIA": "VXD",
             "AAPL": "VXAPL", "AMZN": "VXAZN", "GOOG": "VXGOG", "GOOGL": "VXGOG", "GS": "VXGS", "IBM": "VXIBM",
             "EEM": "VXEEM", "GLD": "GVZ"}


def vol_index_rank(symbol: str, days: int = 252) -> dict | None:
    """IV rank con el indice de volatilidad de CBOE: (actual - min) / (max - min) del ultimo ano."""
    idx = VOL_INDEX.get(symbol)
    if not idx:
        return None
    raw = fetch_aux("historical", idx, ttl=6 * 3600)
    closes = []
    for r in (raw or {}).get("data", [])[-days:]:
        try:
            v = float(r["close"])
            if v > 0:
                closes.append((r["date"], v))
        except (KeyError, ValueError):
            continue
    if len(closes) < days // 2:
        return None
    cur = closes[-1][1]
    qd = (fetch_quote(idx) or {}).get("data") or {}
    if float(qd.get("current_price") or 0) > 0:
        cur = float(qd["current_price"])
    vals = [v for _, v in closes] + [cur]
    lo, hi = min(vals), max(vals)
    rank = 50.0 if hi == lo else (cur - lo) / (hi - lo) * 100
    trail = []
    for d, v in closes[-4:-1]:
        trail.append({"date": d, "y": 50.0 if hi == lo else (v - lo) / (hi - lo) * 100})
    return {"index": idx, "value": cur, "rank": float(rank), "lo": lo, "hi": hi, "trail": trail}


def compass(symbols: list[str], workers: int = 4) -> dict:
    """Puntos del Compass. Eje Y: IV rank. Eje X: risk reversal rank.
    Con >= MIN_HIST_DAYS sesiones guardadas se usa el historico propio del ticker;
    si no, un rank provisional frente al resto de la lista (IV/realizada y RR/IV)."""
    from concurrent.futures import ThreadPoolExecutor
    ckey = ",".join(symbols)
    hit = _compass_cache.get(ckey)
    if hit and time.time() - hit[0] < CACHE_TTL:
        return hit[1]
    res = _compass(symbols, workers)
    _compass_cache[ckey] = (time.time(), res)
    return res


_compass_cache: dict[str, tuple[float, dict]] = {}


def _compass(symbols: list[str], workers: int = 4) -> dict:
    from concurrent.futures import ThreadPoolExecutor
    now = now_ny()
    today = (now if market_open(now) else last_close(now)).strftime("%Y-%m-%d")  # fecha de la sesion de los datos

    def one(sym):
        try:
            vm = vol_metrics(sym)
            h = _vol_history(sym, today, {k: vm[k] for k in ("iv30", "rr25", "rv20")})
            return {"symbol": sym, "name": name_of(sym), **vm, "hist": h}
        except Exception as e:  # noqa: BLE001
            return {"symbol": sym, "error": str(e)}

    with ThreadPoolExecutor(max_workers=workers) as ex:
        rows = list(ex.map(one, symbols))
    ok = [r for r in rows if "error" not in r]

    # proxies para el rank provisional (comparables entre tickers)
    def vrp(r):
        return r["iv30"] / r["rv20"] if r.get("iv30") and r.get("rv20") else None

    def skew(r):
        return r["rr25"] / r["iv30"] if r.get("rr25") is not None and r.get("iv30") else None

    vrps = [vrp(r) for r in ok]
    skews = [skew(r) for r in ok]
    out = []
    for r in rows:
        if "error" in r:
            out.append(r)
            continue
        dates = sorted(r["hist"])
        ivs = [r["hist"][d].get("iv30") for d in dates][-252:]
        rrs = [r["hist"][d].get("rr25") for d in dates][-252:]
        own = len(dates) >= MIN_HIST_DAYS
        vix = vol_index_rank(r["symbol"])
        # eje Y (IV rank): indice de volatilidad de CBOE si existe; si no, historico propio; si no, provisional
        if vix:
            y, y_src = vix["rank"], vix["index"]
        elif own:
            y, y_src = _rank(r["iv30"], ivs), "propio"
        else:
            y, y_src = _percentile(vrp(r), vrps), "provisional"
        # eje X (RR rank): historico propio o provisional
        x, x_src = (_rank(r["rr25"], rrs), "propio") if own else (_percentile(skew(r), skews), "provisional")
        trail = []
        if own:
            for d in dates[-4:-1]:
                hv = r["hist"][d]
                ty = next((t["y"] for t in (vix or {}).get("trail", []) if t["date"] == d), None) if vix else _rank(hv.get("iv30"), ivs)
                trail.append({"date": d, "x": _rank(hv.get("rr25"), rrs), "y": ty})
        out.append({
            "symbol": r["symbol"], "name": r["name"], "iv30": r["iv30"], "rr25": r["rr25"], "rv20": r["rv20"],
            "vrp": vrp(r), "x": x, "y": y, "x_src": x_src, "y_src": y_src,
            "vol_index": {k: vix[k] for k in ("index", "value", "lo", "hi")} if vix else None,
            "own_history": own and True, "full": x_src != "provisional" and y_src != "provisional",
            "days": len(dates), "trail": trail,
        })
    missing = sorted({VOL_INDEX[r["symbol"]] for r in out if "error" not in r and r["symbol"] in VOL_INDEX and not r.get("vol_index")})
    return {"rows": out, "min_days": MIN_HIST_DAYS, "vol_index_missing": missing}


def _percentile(v, arr):
    arr = sorted(a for a in arr if a is not None)
    if v is None or len(arr) < 2:
        return None
    below = sum(1 for a in arr if a < v)
    equal = sum(1 for a in arr if a == v)
    return float((below + 0.5 * (equal - 1)) / (len(arr) - 1) * 100)


# ================================================================ validacion historica
def validation(symbols: list[str], max_dte="45", mode: str = "standard") -> dict:
    """Contrasta los niveles guardados de cada sesion con el precio de esa misma sesion
    (los niveles de la sesion d usan el OI del cierre de d-1, asi que son ex ante para d):
      - rango intradia (max-min)/cierre anterior segun el regimen (GEX neta + / -)
      - % de sesiones en que el maximo no supero el Call Wall / el minimo no perforo el Put Wall
      - % de sesiones en que el cierre quedo dentro del movimiento esperado (si era del mismo dia)."""
    key_dte = ("all" if max_dte in (None, "all") else str(max_dte)) + ("f" if mode == "flow" else "")
    rows, agg = [], {"pos": [], "neg": [], "cw": [], "pw": [], "em": []}
    for sym in symbols:
        path = os.path.join(HIST_DIR, f"{sym.replace('.', '_')}.json")
        try:
            with open(path, encoding="utf-8") as f:
                hist = json.load(f)
        except Exception:  # noqa: BLE001
            hist = {}
        reg, ante = {}, {}
        for k, v in hist.items():
            parts = k.split("|")
            if len(parts) >= 2 and parts[1] == key_dte:
                (ante if len(parts) == 3 and parts[2] == "a" else reg)[parts[0]] = v
        ohlc, proxy_src = history_ohlc(sym) if (reg or ante) else ({}, None)
        if proxy_src:
            # precios del ETF llevados al indice: relacion indice / ETF de las fotos guardadas tras el cierre
            ratios = {}
            for d, sn in reg.items():
                if d in ohlc and sn.get("spot") and ohlc[d][3] and str(sn.get("saved", "")) >= f"{d} 16:00":
                    ratios[d] = sn["spot"] / ohlc[d][3]
            if not ratios:
                ohlc = {}
            else:
                rk = sorted(ratios)
                scaled = {}
                for d, (o_, h_, l_, c_) in ohlc.items():
                    j = max(0, int(np.searchsorted(rk, d, side="right")) - 1)
                    f = ratios[rk[j]]
                    scaled[d] = (o_ * f, h_ * f, l_ * f, c_ * f)
                ohlc = scaled
        dates = sorted(ohlc)
        res = {"symbol": sym, "n": 0, "n_ante": 0, "pos_range": [], "neg_range": [], "cw": [], "pw": [], "em": []}
        for i, d in enumerate(dates):
            if i == 0:
                continue
            # niveles conocidos antes de la sesion: la foto ex ante de ese dia o, si no, la ultima de la sesion anterior
            sn = ante.get(d)
            if sn is not None:
                res["n_ante"] += 1
            else:
                sn = reg.get(dates[i - 1])
            if sn is None:
                continue
            prev_c = ohlc[dates[i - 1]][3]
            o, hi, lo, c = ohlc[d]
            if prev_c <= 0 or hi <= 0:
                continue
            rng = (hi - lo) / prev_c * 100
            (res["pos_range"] if (sn.get("net_per_pct") or 0) > 0 else res["neg_range"]).append(rng)
            if sn.get("call_wall"):
                res["cw"].append(hi <= sn["call_wall"])
            if sn.get("put_wall"):
                res["pw"].append(lo >= sn["put_wall"])
            if sn.get("m1_pct") and sn.get("m1_session") == d:
                res["em"].append(abs(c / prev_c - 1) * 100 <= sn["m1_pct"])
            res["n"] += 1
        mean = lambda a: float(np.mean(a)) if a else None  # noqa: E731
        rate = lambda a: float(np.mean(a) * 100) if a else None  # noqa: E731
        rows.append({"symbol": sym, "n": res["n"], "n_ante": res["n_ante"],
                     "range_pos": mean(res["pos_range"]), "n_pos": len(res["pos_range"]),
                     "range_neg": mean(res["neg_range"]), "n_neg": len(res["neg_range"]),
                     "cw_held": rate(res["cw"]), "pw_held": rate(res["pw"]),
                     "em_hit": rate(res["em"]), "n_em": len(res["em"])})
        agg["pos"] += res["pos_range"]; agg["neg"] += res["neg_range"]
        agg["cw"] += res["cw"]; agg["pw"] += res["pw"]; agg["em"] += res["em"]
    total = {"n": sum(r["n"] for r in rows), "n_ante": sum(r["n_ante"] for r in rows),
             "range_pos": float(np.mean(agg["pos"])) if agg["pos"] else None, "n_pos": len(agg["pos"]),
             "range_neg": float(np.mean(agg["neg"])) if agg["neg"] else None, "n_neg": len(agg["neg"]),
             "cw_held": float(np.mean(agg["cw"]) * 100) if agg["cw"] else None,
             "pw_held": float(np.mean(agg["pw"]) * 100) if agg["pw"] else None,
             "em_hit": float(np.mean(agg["em"]) * 100) if agg["em"] else None, "n_em": len(agg["em"])}
    return {"rows": rows, "total": total}
