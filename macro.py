"""GEX Lab - contexto de mercado: curva de futuros del VIX y COT de la CFTC.

Fuentes gratuitas:
- Futuros VIX: cierres oficiales de CBOE Futures Exchange por contrato (un CSV por vencimiento).
- Indices de volatilidad (VIX9D, VIX, VIX3M, VIX6M, VIX1Y): cotizaciones diferidas de CBOE.
- COT: informe Traders in Financial Futures (solo futuros) de la CFTC, API publica Socrata.
"""
from __future__ import annotations

import csv
import io
import json
import os
import threading
import time
import urllib.request
from datetime import datetime, timedelta
from urllib.parse import quote

import numpy as np

import gex_engine as g

CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache")
VX_URL = "https://cdn.cboe.com/data/us/futures/market_statistics/historical_data/VX/VX_{d}.csv"
SETTLE_URL = "https://www.cboe.com/us/futures/market_statistics/settlement/csv?dt={d}"
VX_PAST = 14        # vencimientos ya liquidados que se descargan (historia de ~1 ano del M1/M2)
VX_AHEAD = 10       # vencimientos futuros como maximo
_lock = threading.Lock()


# ---------------------------------------------------------------- descarga generica
def fetch_text(url: str, retries: int = 3) -> str:
    """Descarga texto con el mismo control de ritmo y respaldo (curl del sistema) que los datos de opciones."""
    last = None
    for attempt in range(retries + 1):
        limited = False
        for fn in (g._fetch_python, g._fetch_system):
            try:
                g._throttle()
                return fn(url).decode("utf-8", "replace")
            except g.NotFound:
                raise
            except g.RateLimited:
                limited = True
                break
            except Exception as e:  # noqa: BLE001
                last = e
                continue
        if not limited:
            break
        if attempt < retries:
            time.sleep(3 * 2 ** attempt)
    raise ConnectionError(str(last) if last else "Too many requests in a row")


# ---------------------------------------------------------------- calendario de vencimientos VX
def _third_friday(y: int, m: int) -> datetime:
    d = datetime(y, m, 15)
    return d + timedelta(days=(4 - d.weekday()) % 7)


def vx_expiry(y: int, m: int) -> datetime:
    """Vencimiento del futuro VIX del mes (y, m): miercoles 30 dias antes del tercer viernes del mes siguiente.
    Si ese viernes es festivo se toma el dia habil anterior; si el miercoles es festivo, el dia habil anterior."""
    ny, nm = (y + 1, 1) if m == 12 else (y, m + 1)
    f = _third_friday(ny, nm)
    if not g.is_trading_day(f):
        f = g.prev_trading_day(f)
    w = f - timedelta(days=30)
    if not g.is_trading_day(w):
        w = g.prev_trading_day(w)
    return w


def vx_expiries(now: datetime) -> list[datetime]:
    y, m = now.year, now.month
    out = []
    for k in range(-VX_PAST - 1, VX_AHEAD + 1):
        mm = m + k
        yy = y + (mm - 1) // 12
        mm = (mm - 1) % 12 + 1
        out.append(vx_expiry(yy, mm))
    return sorted(out)


# ---------------------------------------------------------------- datos por contrato
def _parse_vx(text: str) -> dict[str, dict]:
    rows = {}
    rd = csv.DictReader(io.StringIO(text))
    for r in rd:
        try:
            st = float(r.get("Settle") or 0)
        except ValueError:
            continue
        if st <= 0:
            continue
        rows[r["Trade Date"][:10]] = {"settle": st, "vol": int(float(r.get("Total Volume") or 0)),
                                      "oi": int(float(r.get("Open Interest") or 0))}
    return rows


def _expected_last_settle(now: datetime) -> str:
    """Ultima sesion cuyo cierre oficial puede estar ya publicado. Desde las 16:00 ET se busca el de hoy en la liquidacion
    diaria de CBOE (sin filas VX hasta que lo publica; ver _settlements); los CSV por contrato llegan de madrugada."""
    d = now
    if not (g.is_trading_day(d) and (d.hour, d.minute) >= (16, 0)):
        d = g.prev_trading_day(d)
    return d.strftime("%Y-%m-%d")


def _contract(exp: datetime, now: datetime) -> dict | None:
    """Serie diaria de un contrato. Los vencidos se guardan para siempre; los vivos se refrescan
    cuando deberia haber un cierre nuevo (como mucho cada 30 min)."""
    key = exp.strftime("%Y-%m-%d")
    path = os.path.join(CACHE, "vx", f"VX_{key}.json")
    cached = g.read_json(path)
    expired = exp.date() < now.date() or (exp.date() == now.date() and now.hour >= 17)
    if cached is not None:
        if cached.get("missing") and time.time() - cached.get("t", 0) < 12 * 3600:
            return None
        rows = cached.get("rows") or {}
        if cached.get("final") or (rows and max(rows) >= _expected_last_settle(now)) or \
                time.time() - cached.get("t", 0) < 1800:
            return rows or None
    if os.environ.get("GEX_FIXTURE_DIR"):
        p = os.path.join(os.environ["GEX_FIXTURE_DIR"], f"VX_{key}.csv")
        if not os.path.exists(p):
            return None
        with open(p, encoding="utf-8") as f:
            rows = _parse_vx(f.read())
    else:
        try:
            rows = _parse_vx(fetch_text(VX_URL.format(d=key)))
        except g.NotFound:
            g.write_json(path, {"missing": True, "t": time.time()})
            return None
        except Exception:  # noqa: BLE001
            return (cached or {}).get("rows") or None
    if rows:
        g.write_json(path, {"rows": rows, "final": expired, "t": time.time()})
    return rows or None


def _settlements(day: str) -> dict[str, float]:
    """Liquidacion oficial de los futuros VX mensuales de un dia (vencimiento -> precio). CBOE la publica esa misma
    tarde, mientras que los CSV por contrato no recogen el cierre hasta la madrugada siguiente. Si el dia aun no esta
    publicado, CBOE devuelve sin avisar la ultima liquidacion que tenga: solo el nombre del archivo dice de que dia es."""
    req = urllib.request.Request(SETTLE_URL.format(d=day), headers={"User-Agent": g._UA})
    text = None
    for ctx in g._SSL_CTXS:
        try:
            g._throttle()
            with urllib.request.urlopen(req, timeout=30, context=ctx) as r:
                if f"_{day}." not in (r.headers.get("Content-Disposition") or ""):
                    return {}
                text = r.read().decode("utf-8", "replace")
            break
        except Exception:  # noqa: BLE001
            continue
    out = {}
    for r in csv.DictReader(io.StringIO(text or "")):
        if r.get("Product") != "VX" or not (r.get("Symbol") or "").startswith("VX/"):
            continue  # semanales fuera: la curva es de vencimientos mensuales
        try:
            v = float(r.get("Price") or 0)
        except ValueError:
            continue
        if v > 0:
            out[r.get("Expiration Date") or ""] = v
    return out


def _completar_ultimo_cierre(contracts: dict[str, dict], now: datetime) -> None:
    """Anade la liquidacion del ultimo dia a los contratos vivos que aun no la traen. Open interest: el de la sesion
    anterior (marcado), solo sirve para decidir si el punto va hueco; el volumen queda sin dato."""
    if os.environ.get("GEX_FIXTURE_DIR"):
        return
    day = _expected_last_settle(now)
    faltan = [ek for ek, rows in contracts.items() if ek > day and day not in rows]
    if not faltan:
        return
    precios = _settlements(day)
    for ek in faltan:
        if ek not in precios:
            continue
        rows = contracts[ek]
        prev = rows[max(rows)]
        # copia: las filas de la cache no deben quedarse con el cierre provisional
        contracts[ek] = {**rows, day: {"settle": precios[ek], "vol": None, "oi": prev["oi"], "oi_prev": True}}


_vix_cache: dict[str, tuple[float, dict]] = {}
VOL_TERM = [("VIX9D", 9), ("VIX", 30), ("VIX3M", 91), ("VIX6M", 182), ("VIX1Y", 365)]


def _interp30(points: list[tuple[int, float]]) -> float | None:
    """Futuro sintetico a 30 dias naturales, interpolando entre los dos vencimientos que lo rodean."""
    for (d1, v1), (d2, v2) in zip(points, points[1:]):
        if d1 <= 30 <= d2 and d2 > d1:
            w = (d2 - 30) / (d2 - d1)
            return v1 * w + v2 * (1 - w)
    return None


FLAT_TOL = 0.005  # diferencias menores del 0,5% cuentan como tramo plano (evita cambios de etiqueta por centimos)


def _slope(a: float, b: float) -> int:
    r = b / a - 1
    return 0 if abs(r) < FLAT_TOL else (1 if r > 0 else -1)


def _shape(spot: float | None, m1: float, m2: float) -> dict:
    """Forma del tramo corto con el VIX al contado, M1 y M2. Cada tramo sube (+1), baja (-1) o es plano (0)."""
    s1 = _slope(spot, m1) if spot else None
    s2 = _slope(m1, m2)
    if s1 is None:
        code = "flat" if s2 == 0 else ("contango" if s2 > 0 else "backwardation")
    elif s1 == 0 and s2 == 0:
        code = "flat"
    elif s1 >= 0 and s2 >= 0:
        code = "contango"
    elif s1 <= 0 and s2 <= 0:
        code = "backwardation"
    elif s1 < 0:
        code = "front_inverted"
    else:
        code = "hump"
    labels = {"contango": "Contango", "backwardation": "Backwardation", "flat": "Flat",
              "front_inverted": "Inverted front end", "hump": "Front-end hump"}
    return {"code": code, "label": labels[code], "s1": s1, "s2": s2}


def vix_curve() -> dict:
    hit = _vix_cache.get("curve")
    if hit and time.time() - hit[0] < 300:
        return hit[1]
    with _lock:
        hit = _vix_cache.get("curve")
        if hit and time.time() - hit[0] < 300:
            return hit[1]
        res = _vix_curve()
        _vix_cache["curve"] = (time.time(), res)
        return res


def _live_curve(now: datetime, last: str, monthly: set[str], vix_now: float | None) -> dict | None:
    """Curva VX de la sesion en curso, implicita en las opciones del VIX: cada opcion va sobre el futuro de su
    vencimiento y la paridad put-call da su precio (gex_engine.implied_forwards). Solo entre la apertura de hoy y la
    publicacion de su liquidacion oficial: luego manda el cierre. Incluye los vencimientos semanales."""
    if not g.is_trading_day(now) or now < now.replace(hour=9, minute=30, second=0, microsecond=0):
        return None
    today = now.strftime("%Y-%m-%d")
    if last >= today:
        return None
    ch = g.parse_chain(g.fetch_chain("VIX"))
    _, _, fwd = g.implied_forwards(ch, g.quote_time(now))
    pts = []
    for ek, f in sorted(fwd.items()):
        e = ek[:10]
        dd = (datetime.strptime(e, "%Y-%m-%d") - datetime.strptime(today, "%Y-%m-%d")).days
        if e > today and dd <= 400:
            pts.append({"expiry": e, "days": dd, "price": round(f, 4), **({"monthly": True} if e in monthly else {})})
    if len(pts) < 2:
        return None
    return {"date": today, "time": ch.get("timestamp"), "vix": vix_now, "points": pts}


def _live_stats(lc: dict, spreads: list[float], streak: int, contango: bool) -> None:
    """Datos del panel con la curva en directo: forma, M1 y M2 (los dos primeros mensuales), pendiente M2/M1 y su
    percentil frente al ultimo ano de cierres, base sobre el VIX, futuro a 30 dias y racha contando la sesion de hoy."""
    mens = [p for p in lc["points"] if p.get("monthly")]
    if len(mens) < 2:
        return
    a, b = mens[0], mens[1]
    m1, m2, spot = a["price"], b["price"], lc.get("vix")
    sp = m2 / m1 - 1
    sigue = (sp >= 0) == contango
    lc.update({
        "m1": m1, "m2": m2, "m1_exp": a["expiry"], "m1_days": a["days"], "m2_exp": b["expiry"], "m2_days": b["days"],
        "spread": sp, "spread_pct_rank": 100.0 * sum(1 for s in spreads if s <= sp) / len(spreads),
        "basis": (m1 / spot - 1) if spot else None,
        "cm30": _interp30(([(0, spot)] if spot else []) + [(p["days"], p["price"]) for p in lc["points"]]),
        "shape": _shape(spot, m1, m2),
        "streak": streak + 1 if sigue else 1, "streak_contango": sp >= 0,
    })


def _vix_curve() -> dict:
    now = g.now_ny()
    exps = vx_expiries(now)
    contracts = {}
    for e in exps:
        rows = _contract(e, now)
        if rows:
            contracts[e.strftime("%Y-%m-%d")] = rows
    if not contracts:
        raise ConnectionError("Could not download VIX futures from CBOE")
    _completar_ultimo_cierre(contracts, now)
    exp_keys = sorted(contracts)

    vix_hist, _ = g.history_ohlc("VIX")
    vix_close = {d: v[3] for d, v in vix_hist.items()}

    # todas las sesiones con cierre de futuros
    dates = sorted({d for rows in contracts.values() for d in rows})
    # el historico diario del VIX puede no traer aun el cierre de hoy: se completa con la cotizacion
    if dates and dates[-1] not in vix_close:
        qv = g.fetch_quote("VIX") or {}
        qd = qv.get("data") or {}
        now_q = g.now_ny()
        if not g.market_open(now_q) and g.session_date(qv.get("timestamp")) == dates[-1] and float(qd.get("current_price") or 0) > 0:
            vix_close[dates[-1]] = float(qd["current_price"])

    def curve_on(day: str) -> list[dict]:
        out = []
        for ek in exp_keys:
            if ek <= day:
                continue  # vencido (el dia del vencimiento el contrato ya no es el de referencia)
            r = contracts[ek].get(day)
            if r:
                dd = (datetime.strptime(ek, "%Y-%m-%d") - datetime.strptime(day, "%Y-%m-%d")).days
                out.append({"expiry": ek, "days": dd, "settle": r["settle"], "oi": r["oi"], "vol": r["vol"],
                            **({"oi_prev": True} if r.get("oi_prev") else {})})
        return out

    # historia diaria del ultimo ano: M1, M2, contango M2/M1 y prima del sintetico a 30 dias sobre el VIX
    hist = []
    for d in dates[-260:]:
        cv = curve_on(d)
        if len(cv) < 2:
            continue
        m1, m2 = cv[0]["settle"], cv[1]["settle"]
        spot = vix_close.get(d)
        cm30 = _interp30([(0, spot)] + [(c["days"], c["settle"]) for c in cv] if spot else [(c["days"], c["settle"]) for c in cv])
        hist.append({"date": d, "m1": m1, "m2": m2, "vix": spot, "spread": m2 / m1 - 1,
                     "basis": (m1 / spot - 1) if spot else None, "cm30": cm30,
                     "shape": _shape(spot, m1, m2)["code"]})
    if not hist:
        raise LookupError("Not enough contracts with a settlement")

    last = hist[-1]["date"]
    cur = curve_on(last)

    def back(n: int) -> dict | None:
        i = len(hist) - 1 - n
        if i < 0:
            return None
        d = hist[i]["date"]
        return {"date": d, "vix": vix_close.get(d), "points": curve_on(d)}

    spreads = [h["spread"] for h in hist]
    cur_sp = hist[-1]["spread"]
    pct = 100.0 * sum(1 for s in spreads if s <= cur_sp) / len(spreads)
    streak = 0
    c0 = hist[-1]["spread"] >= 0
    for h in reversed(hist):
        if (h["spread"] >= 0) != c0:
            break
        streak += 1

    # estructura de los indices de volatilidad: en directo (15 min) con el mercado abierto; si no, el cierre oficial
    # de todos. CBOE calcula el VIX tambien en horario extendido (antes de la apertura), pero VIX9D, VIX3M, VIX6M y
    # VIX1Y no: mezclarlos daria una curva y un VIX/VIX3M de dos momentos distintos.
    live = g.market_open(g.now_ny())
    term = []
    for sym, days in VOL_TERM:
        qd = (g.fetch_quote(sym) or {}).get("data") or {}
        v = float((qd.get("current_price") if live else (qd.get("close") or qd.get("current_price"))) or 0)
        if v > 0:
            term.append({"symbol": sym, "days": days, "value": v,
                         "prev": float(qd.get("prev_day_close") or qd.get("close") or 0) or None})
    tmap = {t["symbol"]: t["value"] for t in term}
    vix_live = tmap.get("VIX")
    ratio = vix_live / tmap["VIX3M"] if vix_live and tmap.get("VIX3M") else None

    try:
        live_curve = _live_curve(now, last, set(exp_keys), tmap.get("VIX"))
    except Exception:  # noqa: BLE001
        live_curve = None
    if live_curve:
        _live_stats(live_curve, spreads, streak, c0)

    spot_last = vix_close.get(last)
    m1, m2 = cur[0]["settle"], cur[1]["settle"]
    res = {
        "date": last,
        "vix_close": spot_last,
        "points": cur,
        "prev": back(1), "week": back(5), "live": live_curve,
        "shape": _shape(spot_last, m1, m2),
        "m1": m1, "m2": m2,
        "spread": cur_sp, "spread_pct_rank": pct,
        "basis": (m1 / spot_last - 1) if spot_last else None,
        "cm30": hist[-1]["cm30"],
        "streak": streak, "streak_contango": c0,
        "contango_share": sum(1 for s in spreads if s >= 0) / len(spreads),
        "history": hist,
        "term": term, "vix_vix3m": ratio,
        "term_time": (g.fetch_quote("VIX") or {}).get("timestamp") if live else None,  # sin hora: son cierres
        "term_live": live,
        "computed_at": now.strftime("%Y-%m-%d %H:%M"),
        "flat_tol": FLAT_TOL,
    }
    return res


# ================================================================ COT (CFTC)
COT_URL = "https://publicreporting.cftc.gov/resource/gpe5-46if.json"
COT_MARKETS = [
    # clave, nombre, codigo CFTC, grupo, precio de referencia (CBOE), nota del precio
    ("ES", "S&P 500", "13874+", "Indices and VIX", "SPX", "E-mini and Micro E-mini combined"),
    ("NQ", "Nasdaq 100", "20974+", "Indices and VIX", "NDX", "E-mini and Micro E-mini combined"),
    ("RTY", "Russell 2000", "239742", "Indices and VIX", "RUT", "E-mini"),
    ("YM", "Dow Jones", "12460+", "Indices and VIX", "DJX", "E-mini and Micro combined"),
    ("VX", "VIX", "1170E1", "Indices and VIX", "VIX", "CFE VIX futures"),
    ("ZT", "2-year note", "042601", "Treasuries", "SHY", ""),
    ("ZF", "5-year note", "044601", "Treasuries", "IEI", ""),
    ("ZN", "10-year note", "043602", "Treasuries", "IEF", ""),
    ("TN", "Ultra 10-year", "043607", "Treasuries", "IEF", ""),
    ("ZB", "T-Bond", "020601", "Treasuries", "TLT", ""),
    ("UB", "Ultra T-Bond", "020604", "Treasuries", "TLT", ""),
]
COT_GROUPS = [
    ("asset_mgr", "Asset managers", "asset_mgr_positions_long", "asset_mgr_positions_short"),
    ("lev_money", "Leveraged funds", "lev_money_positions_long", "lev_money_positions_short"),
    ("dealer", "Dealers", "dealer_positions_long_all", "dealer_positions_short_all"),
    ("other", "Other reportables", "other_rept_positions_long", "other_rept_positions_short"),
    ("nonrept", "Non-reportables", "nonrept_positions_long_all", "nonrept_positions_short_all"),
]
COT_YEARS = 3
_cot_mem: dict[str, tuple[float, dict]] = {}


def _cot_due(now: datetime, last_report: str | None) -> bool:
    """Hay un informe nuevo pendiente: el del martes siguiente al ultimo, publicado el viernes a las 15:30 ET."""
    if not last_report:
        return True
    nxt = datetime.strptime(last_report, "%Y-%m-%d") + timedelta(days=7)
    release = nxt + timedelta(days=3, hours=15, minutes=35)
    return now >= release


def _cot_raw(force: bool = False) -> dict:
    path = os.path.join(CACHE, "cot.json.gz")
    cached = g.read_json(path)
    now = g.now_ny()
    if cached and not force:
        age = time.time() - cached.get("t", 0)
        if age < 1800 or (age < 7 * 86400 and not _cot_due(now, cached.get("last"))):
            return cached
    if os.environ.get("GEX_FIXTURE_DIR"):
        p = os.path.join(os.environ["GEX_FIXTURE_DIR"], "cot.json")
        rows = json.load(open(p, encoding="utf-8")) if os.path.exists(p) else []
    else:
        since = (now - timedelta(days=int(COT_YEARS * 365.25) + 21)).strftime("%Y-%m-%dT00:00:00.000")
        codes = ",".join(f"'{m[2]}'" for m in COT_MARKETS)
        fields = ["cftc_contract_market_code", "report_date_as_yyyy_mm_dd", "open_interest_all"] + \
                 [f for _, _, lo, sh in COT_GROUPS for f in (lo, sh)]
        q = (f"?$select={','.join(fields)}&$where=" +
             quote(f"cftc_contract_market_code in({codes}) AND report_date_as_yyyy_mm_dd >= '{since}'") +
             "&$order=report_date_as_yyyy_mm_dd&$limit=10000")
        try:
            rows = json.loads(fetch_text(COT_URL + q))
        except Exception as e:  # noqa: BLE001
            if cached:
                return cached
            raise ConnectionError(f"Could not download the CFTC COT report: {e}") from e
    data: dict[str, dict] = {}
    for r in rows:
        code = r.get("cftc_contract_market_code")
        d = (r.get("report_date_as_yyyy_mm_dd") or "")[:10]
        if not code or not d:
            continue
        rec = {"oi": int(float(r.get("open_interest_all") or 0))}
        for k, _, lo, sh in COT_GROUPS:
            rec[k] = [int(float(r.get(lo) or 0)), int(float(r.get(sh) or 0))]
        data.setdefault(code, {})[d] = rec
    last = max((max(v) for v in data.values() if v), default=None)
    out = {"t": time.time(), "last": last, "data": data}
    if data:
        try:
            g.write_json(path, out)
        except OSError:
            pass
    return out


def _cot_index(series: list[float]) -> float | None:
    """Indice COT clasico: posicion de la neta actual dentro de su rango (0 = minimo, 100 = maximo)."""
    if len(series) < 26:
        return None
    lo, hi = min(series), max(series)
    return 100.0 * (series[-1] - lo) / (hi - lo) if hi > lo else 50.0


def cot(force: bool = False) -> dict:
    hit = _cot_mem.get("cot")
    if hit and not force and time.time() - hit[0] < 600:
        return hit[1]
    raw = _cot_raw(force)
    markets = []
    for key, name, code, group, px, note in COT_MARKETS:
        ser = raw["data"].get(code) or {}
        dates = sorted(ser)[-int(COT_YEARS * 52.2):]
        if len(dates) < 2:
            markets.append({"key": key, "name": name, "group": group, "error": "No data"})
            continue
        last, prev = ser[dates[-1]], ser[dates[-2]]
        groups = {}
        for gk, glabel, _, _ in COT_GROUPS:
            nets = [ser[d][gk][0] - ser[d][gk][1] for d in dates]
            one_y = nets[-52:]
            groups[gk] = {
                "label": glabel, "long": last[gk][0], "short": last[gk][1], "net": nets[-1],
                "chg": nets[-1] - nets[-2], "pct_oi": nets[-1] / last["oi"] if last["oi"] else None,
                "index3y": _cot_index(nets), "index1y": _cot_index(one_y),
            }
        markets.append({
            "key": key, "name": name, "group": group, "code": code, "note": note, "price_ref": px,
            "date": dates[-1], "oi": last["oi"], "oi_chg": last["oi"] - prev["oi"], "groups": groups,
            "weeks": len(dates),
        })
    res = {"report_date": raw.get("last"), "markets": markets,
           "groups": [{"key": k, "label": l} for k, l, _, _ in COT_GROUPS],
           "release": _release_of(raw.get("last")), "years": COT_YEARS}
    _cot_mem["cot"] = (time.time(), res)
    return res


def _release_of(report: str | None) -> str | None:
    if not report:
        return None
    return (datetime.strptime(report, "%Y-%m-%d") + timedelta(days=3)).strftime("%Y-%m-%d")


def cot_history(key: str) -> dict:
    m = next((x for x in COT_MARKETS if x[0] == key), None)
    if not m:
        raise LookupError("Unknown market")
    raw = _cot_raw()
    ser = raw["data"].get(m[2]) or {}
    dates = sorted(ser)[-int(COT_YEARS * 52.2):]
    series = {gk: [ser[d][gk][0] - ser[d][gk][1] for d in dates] for gk, *_ in COT_GROUPS}
    price, src = {}, None
    try:
        ohlc, src = g.history_ohlc(m[4])
        if ohlc:
            ks = sorted(ohlc)
            for d in dates:  # cierre del martes del informe (o el anterior disponible)
                i = int(np.searchsorted(ks, d, side="right")) - 1
                if i >= 0:
                    price[d] = ohlc[ks[i]][3]
    except Exception:  # noqa: BLE001
        price = {}
    return {"key": key, "name": m[1], "dates": dates, "oi": [ser[d]["oi"] for d in dates], "net": series,
            "price": [price.get(d) for d in dates], "price_ref": (src or m[4]) if price else None}


# ================================================================ resumen de mercado
SUMMARY_INDICES = ["SPX", "NDX", "RUT"]


def _ny_to_utc(local: datetime) -> datetime:
    from datetime import timezone
    guess = local.replace(tzinfo=timezone.utc) + timedelta(hours=5)
    return (local - g._ny_offset(guess)).replace(tzinfo=timezone.utc)


def session_info() -> dict:
    now = g.now_ny()
    if g.market_open(now):
        nxt = None
    else:
        d = now if (g.is_trading_day(now) and (now.hour, now.minute) < (9, 30)) else g.next_trading_day(now)
        nxt = d.replace(hour=9, minute=30, second=0, microsecond=0)
    return {"open": g.market_open(now), "now_ny": now.strftime("%Y-%m-%d %H:%M"),
            "next_open_utc": _ny_to_utc(nxt).strftime("%Y-%m-%dT%H:%M:00Z") if nxt else None,
            "close_utc": _ny_to_utc(g.close_time(now)).strftime("%Y-%m-%dT%H:%M:00Z") if g.market_open(now) else None}


def _index_card(sym: str, refresh: bool) -> dict:
    try:
        r = g.compute(sym, max_dte=45, window_pct=5.0, force=refresh)
    except Exception as e:  # noqa: BLE001
        return {"symbol": sym, "error": str(e)}
    L, s = r["levels"], r["spot"]
    dist = lambda v: None if v is None else (v / s - 1) * 100  # noqa: E731
    prev = r.get("prev") or {}
    return {"symbol": r["symbol"], "name": r["name"], "spot": s, "chg": r["chg_pct"], "regime": r["regime"],
            "net_per_pct": r["totals"]["net_per_pct"], "prev_net": prev.get("net_per_pct"), "prev_date": prev.get("date"),
            "levels": {k: {"v": L[k], "d": dist(L[k]), "prev": prev.get(k)} for k in ("call_wall", "flip", "vt", "put_wall")},
            "flip_exact": L["flip_exact"], "em": r.get("expected_move"), "moves": r.get("moves"), "step": r["step"],
            "abs_gamma": {"v": L["abs_gamma"], "d": dist(L["abs_gamma"])}, "is_index": r["is_index"],
            "implied": (r.get("spot_implied") or {}).get("use", False), "quote_time": r["quote_time"],
            "front_share": r["front_share"], "front_expiry": r["front_expiry"]}


def summary(refresh: bool = False) -> dict:
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=5) as ex:
        fut_idx = [ex.submit(_index_card, s, refresh) for s in SUMMARY_INDICES]
        fut_vix = ex.submit(vix_curve)
        fut_cot = ex.submit(cot)
        cards = [f.result() for f in fut_idx]
        try:
            v = fut_vix.result()
            vix = {k: v.get(k) for k in ("date", "vix_close", "shape", "m1", "m2", "spread", "spread_pct_rank", "basis",
                                           "vix_vix3m", "streak", "streak_contango", "flat_tol")}
            vix["points"] = [{"days": 0, "v": v["vix_close"]}] + [{"days": p["days"], "v": p["settle"]} for p in v["points"]]
            vix["m1_exp"], vix["m2_exp"] = v["points"][0]["expiry"], v["points"][1]["expiry"]
        except Exception as e:  # noqa: BLE001
            vix = {"error": str(e)}
        try:
            c = fut_cot.result()
            ext = []
            for m in c["markets"]:
                for gk in ("asset_mgr", "lev_money", "dealer"):
                    gr = (m.get("groups") or {}).get(gk)
                    if gr and gr.get("index3y") is not None and (gr["index3y"] >= 90 or gr["index3y"] <= 10):
                        ext.append({"key": m["key"], "name": m["name"], "group": gr["label"], "index": gr["index3y"],
                                    "net": gr["net"], "chg": gr["chg"]})
            ext.sort(key=lambda x: -abs(x["index"] - 50))
            cotd = {"report_date": c["report_date"], "extremes": ext}
        except Exception as e:  # noqa: BLE001
            cotd = {"error": str(e)}
    return {"session": session_info(), "indices": cards, "vix": vix, "cot": cotd, "rate": g.rate_info(),
            "computed_at": g.now_ny().strftime("%Y-%m-%d %H:%M")}


# ---------------------------------------------------------------- correlacion implicita (CBOE)
COR_TERM = [("COR10D", 10), ("COR1M", 30), ("COR3M", 91), ("COR6M", 182), ("COR9M", 273), ("COR1Y", 365)]
COR_HIST_DAYS = 504          # dos anos para el grafico
COR_RANK_DAYS = 252          # percentil del ultimo ano
_cor_cache: dict[str, tuple[float, dict]] = {}


def _closes(sym: str) -> list[tuple[str, float]]:
    ohlc, _ = g.history_ohlc(sym)
    return [(d, v[3]) for d, v in sorted(ohlc.items()) if v[3] > 0]


def _with_quote(sym: str, closes: list[tuple[str, float]]) -> tuple[list[tuple[str, float]], bool]:
    """Anade la cotizacion de hoy (en directo con el mercado abierto, o el cierre si aun no esta en el historico).
    Devuelve la serie y si el ultimo valor es en directo."""
    q = g.fetch_quote(sym) or {}
    qd = q.get("data") or {}
    v = float(qd.get("current_price") or 0)
    day = g.session_date(q.get("timestamp")) if q.get("timestamp") else None
    if v <= 0 or not day or (closes and day < closes[-1][0]):
        return closes, False
    if closes and closes[-1][0] == day:
        return closes[:-1] + [(day, v)], g.market_open(g.now_ny())
    return closes + [(day, v)], g.market_open(g.now_ny())


def _stats(vals: list[float]) -> dict:
    cur = vals[-1]
    year = vals[-COR_RANK_DAYS - 1:-1] or vals[:-1]
    return {"value": cur, "prev": vals[-2] if len(vals) > 1 else None, "week": vals[-6] if len(vals) > 5 else None,
            "pct": round(100.0 * sum(1 for x in year if x <= cur) / len(year), 1) if year else None,
            "band": [round(float(np.percentile(year, p)), 2) for p in (10, 50, 90)] if len(year) >= 20 else None,
            "median_all": round(float(np.median(vals)), 2)}


def correlation() -> dict:
    hit = _cor_cache.get("c")
    if hit and time.time() - hit[0] < 300:
        return hit[1]
    res = _correlation()
    _cor_cache["c"] = (time.time(), res)
    return res


def _correlation() -> dict:
    """Correlacion implicita de CBOE (cuanto se espera que se muevan juntas las 50 mayores acciones del S&P 500, de la
    IV del indice frente a la de sus componentes) a 10 dias, 1, 3, 6 y 9 meses y 1 ano, el indice de dispersion
    DSPX y el VIX. Con el percentil del ultimo ano, la banda 10-90 y el historico de dos anos."""
    series, live = {}, False
    for sym in [s for s, _ in COR_TERM] + ["DSPX", "VIX"]:
        c, lv = _with_quote(sym, _closes(sym))
        if len(c) >= 30:
            series[sym] = c
            live = live or lv
    if "COR3M" not in series:
        raise ConnectionError("Could not download the implied correlation indices from CBOE")
    term = [{"symbol": s, "days": d, **_stats([v for _, v in series[s]])} for s, d in COR_TERM if s in series]
    days = [d for d, _ in series["COR3M"]][-COR_HIST_DAYS:]
    by = {s: dict(series[s]) for s in ("COR1M", "COR3M", "DSPX", "VIX") if s in series}
    hist = [{"date": d, **{k.lower(): by[k].get(d) for k in by}} for d in days]
    out = {"date": days[-1], "live": live, "term": term, "history": hist,
           "dspx": _stats([v for _, v in series["DSPX"]]) if "DSPX" in series else None,
           "vix": _stats([v for _, v in series["VIX"]]) if "VIX" in series else None,
           "computed_at": g.now_ny().strftime("%Y-%m-%d %H:%M")}
    return out
