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
    # el CSV oficial de CBOE suele traer el cierre del día antes que el histórico diario (y _csv_cierres, el de hoy
    # con la sesión cerrada antes que el CSV)
    try:
        for d, v in _csv_cierres("VIX").items():
            vix_close.setdefault(d, v)
    except Exception:  # noqa: BLE001
        pass

    # todas las sesiones con cierre de futuros
    dates = sorted({d for rows in contracts.values() for d in rows})

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
    syms = [s for s, _ in VOL_TERM] + ["VVIX", "SKEW"]
    try:
        vals, term_time = indices_vol(syms, live)
    except Exception:  # noqa: BLE001
        vals, term_time = {}, None
    term = [{"symbol": sym, "days": days, **vals[sym]} for sym, days in VOL_TERM if sym in vals]
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
        "regime": _regimen_curva(ratio, tmap["VIX9D"] / vix_live if vix_live and tmap.get("VIX9D") else None),
        "volreg": _volreg_seguro({s: v["value"] for s, v in vals.items()} if live else None),
        "scatter": _nubes_seguro({**vals, **_spx_vivo()} if live else None),
        "term_time": term_time if live else None,  # sin hora: son cierres
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
    imp = r.get("spot_implied") or {}
    chg = imp["proxy_chg"] if imp.get("use") else r["chg_pct"]  # pre-market: cambio frente al cierre de ayer
    return {"symbol": r["symbol"], "name": r["name"], "spot": s, "chg": chg, "regime": r["regime"],
            "net_per_pct": r["totals"]["net_per_pct"], "prev_net": prev.get("net_per_pct"), "prev_date": prev.get("date"),
            "levels": {k: {"v": L[k], "d": dist(L[k]), "prev": prev.get(k)} for k in ("call_wall", "flip", "vt", "put_wall")},
            "flip_exact": L["flip_exact"], "em": r.get("expected_move"), "moves": r.get("moves"), "step": r["step"],
            "abs_gamma": {"v": L["abs_gamma"], "d": dist(L["abs_gamma"])}, "is_index": r["is_index"],
            "implied": imp.get("use", False), "quote_time": r["quote_time"],
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
    vivo = bool(q.get("today")) and g.market_open(g.now_ny())
    if closes and closes[-1][0] == day:
        return closes[:-1] + [(day, v)], vivo
    return closes + [(day, v)], vivo


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


# ---------------------------------------------------------------- regimen de gamma del SPX
SM_URL = "https://squeezemetrics.com/monitor/static/DIX.csv"
REG_VENTANA = 252                 # percentil del GEX frente al ultimo ano (el GEX crece con el mercado)
REG_SIGMA = 0.6827                # cuantil de |rendimiento| / sigma que da el rango de 1 sigma ajustado
_reg_cache: dict[str, tuple[float, dict]] = {}


def gamma_regime() -> dict:
    hit = _reg_cache.get("r")
    if hit and time.time() - hit[0] < 3600:
        return hit[1]
    res = _gamma_regime()
    _reg_cache["r"] = (time.time(), res)
    return res


def _gex_percentil() -> tuple[list[str], np.ndarray, np.ndarray]:
    """GEX diario de SqueezeMetrics: fechas, valores y percentil de cada día frente a las REG_VENTANA sesiones previas
    (NaN mientras no hay ventana completa). Se descarga una vez por hora."""
    hit = _reg_cache.get("gex")
    if hit and time.time() - hit[0] < 3600:
        return hit[1]
    filas = csv.DictReader(io.StringIO(fetch_text(SM_URL)))
    serie = sorted((f["date"], float(f["gex"])) for f in filas if f.get("date") and f.get("gex"))
    if len(serie) < REG_VENTANA + 50:
        raise ValueError("SqueezeMetrics GEX history is too short")
    fechas = [d for d, _ in serie]
    G = np.array([v for _, v in serie])
    pct = np.full(len(G), np.nan)
    for k in range(REG_VENTANA, len(G)):
        pct[k] = (G[k - REG_VENTANA:k] < G[k]).mean()
    _reg_cache["gex"] = (time.time(), (fechas, G, pct))
    return fechas, G, pct


def _gamma_regime() -> dict:
    """Regimen de gamma del SPX con el GEX diario de SqueezeMetrics (CSV publico desde 2011) y su calibracion.

    El GEX de la fecha t sale del cierre de t y vale para la sesion siguiente. El regimen es el quintil del percentil
    del GEX frente a las 252 sesiones previas. Para cada quintil, con toda la historia: el cuantil 68,3 % de
    |rendimiento de cierre a cierre| / sigma del VIX del dia anterior (VIX / raiz(252)) es el factor que convierte el
    rango implicito de 1 sigma en el que de verdad contuvo el 68,3 % de los cierres, y `breaks` es la fraccion de
    dias que cerraron fuera del rango implicito. Estudio completo: pruebas/regimen_gamma.py."""
    fechas, G, pct = _gex_percentil()
    quint = {fechas[k]: int(min(4, pct[k] * 5)) for k in range(REG_VENTANA, len(G))}
    hoy = quint[fechas[-1]]
    spx = _calibrar_quintiles("SPX", "VIX", quint, hoy)
    # Nasdaq-100: el mismo régimen (GEX del SPX) calibrado con QQQ (CBOE no publica el histórico del NDX) y el VXN;
    # en el estudio separa sus días casi igual que los del SPX (fuera del 1σ: 33,5 % con gamma muy baja, 13,1 % muy alta)
    try:
        ndx = {**_calibrar_quintiles("QQQ", "VXN", quint, hoy), "proxy": "QQQ", "vol": "VXN"}
    except Exception:  # noqa: BLE001  (sin históricos del Nasdaq, el SPX sigue)
        ndx = None
    gaps = {}
    for clave, precio, vol in (("spx", "SPY", "VIX"), ("ndx", "QQQ", "VXN")):
        try:
            gaps[clave] = gap_tramos(precio, vol)
        except Exception:  # noqa: BLE001
            pass
    return {"date": fechas[-1], "gex": float(G[-1]), "pct": round(float(pct[-1]) * 100, 1), "q": hoy + 1, **spx,
            "since": fechas[REG_VENTANA], "source": "SqueezeMetrics", "ndx": ndx, "gaps": gaps}


def _calibrar_quintiles(precio: str, vol: str, quint: dict[str, int], hoy: int) -> dict:
    """Por quintil del GEX del día anterior: cuantil 68,3 % de |rendimiento| / sigma de `vol` (`ratio`) y fracción de
    cierres fuera del 1σ (`breaks`), más la probabilidad de la sesión siguiente (`p1s`)."""
    px, _ = g.history_ohlc(precio)
    vv, _ = g.history_ohlc(vol)
    dias = sorted(set(px) & set(vv))
    z, q = [], []
    for a, b in zip(dias, dias[1:]):
        if a not in quint or px[a][3] <= 0 or vv[a][3] <= 0:
            continue
        sig = vv[a][3] / 100 / np.sqrt(252)
        z.append(abs(np.log(px[b][3] / px[a][3])) / sig)
        q.append(quint[a])
    z, q = np.array(z), np.array(q)
    grupos = [{"q": k + 1, "n": int((q == k).sum()),
               "ratio": round(float(np.quantile(z[q == k], REG_SIGMA)), 3),
               "breaks": round(float((z[q == k] > 1).mean()), 4)} for k in range(5)]
    return {"ratio": grupos[hoy]["ratio"], "breaks": grupos[hoy]["breaks"],
            "all": {"n": int(len(z)), "ratio": round(float(np.quantile(z, REG_SIGMA)), 3),
                    "breaks": round(float((z > 1).mean()), 4)},
            "groups": grupos, "p1s": prob_1sigma(precio, vol)}


# ---------------------------------------------------------------- régimen de la curva del VIX
TRAMOS_3M = ((0, 0.80), (0.80, 0.88), (0.88, 0.95), (0.95, 1.00), (1.00, 9.0))   # VIX/VIX3M
TRAMOS_9D = ((0, 0.85), (0.85, 0.95), (0.95, 1.05), (1.05, 9.0))                 # VIX9D/VIX


def curva_tramos(desde: str | None = None, hasta: str | None = None) -> dict:
    """Qué hizo el SPX tras cada tramo de la curva del VIX (cierres diarios de CBOE, VIX3M desde 2009 y VIX9D desde
    2011). Señal del cierre de t; desde ese cierre: rendimiento del SPX a 5 y 20 sesiones y volatilidad realizada de
    las 20 sesiones siguientes (cierre a cierre, anualizada) menos el VIX de t (negativo: la prima se cobró).
    Estudio con las dos mitades y la t de cada tramo: pruebas/regimen_vix.py."""
    def cierres(sym):
        d, _ = g.history_ohlc(sym)
        return {k: v[3] for k, v in d.items() if v[3] > 0}
    spx, vix, v3, v9 = (cierres(s) for s in ("SPX", "VIX", "VIX3M", "VIX9D"))
    fechas = sorted(set(spx) & set(vix) & set(v3))
    C = np.array([spx[f] for f in fechas])
    V = np.array([vix[f] for f in fechas])
    ratios = {"3m": V / np.array([v3[f] for f in fechas]),
              "9d": np.array([v9[f] / vix[f] if f in v9 else np.nan for f in fechas])}
    n = len(fechas)
    lr = np.diff(np.log(C))
    f5, f20, rv = (np.full(n, np.nan) for _ in range(3))
    for i in range(n):
        if i + 5 < n:
            f5[i] = C[i + 5] / C[i] - 1
        if i + 20 < n:
            f20[i] = C[i + 20] / C[i] - 1
            rv[i] = lr[i:i + 20].std(ddof=1) * np.sqrt(252) * 100
    F = np.array(fechas)
    per = np.ones(n, bool) if desde is None else F >= desde
    if hasta is not None:
        per &= F < hasta
    out = {"since": str(F[per][0]) if per.any() else None, "last": fechas[-1]}
    for clave, tramos in (("3m", TRAMOS_3M), ("9d", TRAMOS_9D)):
        R = ratios[clave]
        filas = []
        for lo, hi in tramos:
            m = per & np.isfinite(R) & (R >= lo) & (R < hi)
            m20 = m & np.isfinite(f20)
            filas.append({"lo": lo, "hi": hi, "n": int(m.sum()), "n20": int(m20.sum()),
                          "r5": _r(np.nanmean(f5[m & np.isfinite(f5)])) if m.any() else None,
                          "r20": _r(f20[m20].mean()) if m20.any() else None,
                          "up20": _r(float(np.mean(f20[m20] > 0))) if m20.any() else None,
                          "vrp": _r(float(np.mean(rv[m20] - V[m20])), 2) if m20.any() else None})
        out[clave] = filas
    return out


def _r(x, d: int = 5):
    return None if x is None or not np.isfinite(x) else round(float(x), d)


# ---------------------------------------------------------------- nubes del VIX (gráficos de dispersión)
SKEW_AJUSTE_ANOS = 5   # el SKEW sube de fondo (115 en los 90, 145 hoy): su recta frente al VIX, solo con los últimos años


def _saltos(fechas: list[str]) -> list[int]:
    """Días naturales desde la fecha anterior (la web rehace las fechas; el primero, 0)."""
    d = [datetime.strptime(f, "%Y-%m-%d") for f in fechas]
    return [0] + [(q - p).days for p, q in zip(d, d[1:])]


def _nube_ajuste(vix: dict, y_de, fechas: list[str], hoy_xy: tuple | None, hoy: dict | None, desde: str | None = None,
                 dec: int = 3) -> dict:
    """Nube del VIX (eje x) frente a y_de(fecha) con la recta y = a + b·ln(VIX) por mínimos cuadrados (solo con las
    fechas >= `desde` si se da) y la desviación de sus residuos (`sd`); `today` con su residuo en σ (`z`)."""
    X = np.array([vix[f] for f in fechas])
    Y = np.array([y_de(f) for f in fechas])
    m = np.ones(len(fechas), bool) if desde is None else np.array([f >= desde for f in fechas])
    b, a = np.polyfit(np.log(X[m]), Y[m], 1)
    sd = float((Y[m] - (a + b * np.log(X[m]))).std(ddof=2))
    if hoy and hoy_xy:
        hoy = {**hoy, "x": hoy_xy[0], "y": hoy_xy[1], "z": round(float((hoy_xy[1] - (a + b * np.log(hoy_xy[0]))) / sd), 2)}
    else:
        hoy = None
    return {"since": fechas[0], "last": fechas[-1], "fit_since": desde or fechas[0], "d": _saltos(fechas),
            "x": [round(float(v), 2) for v in X], "y": [round(float(v), dec) for v in Y],
            "a": round(float(a), 5), "b": round(float(b), 5), "sd": round(sd, 5), "today": hoy}


def nubes_vix(vivo: dict[str, dict] | None = None) -> dict:
    """Puntos diarios de los gráficos de dispersión de la página del VIX, con los CSV de CBOE (SPX desde 1975,
    VIX y SKEW desde 1990, VIX3M desde 2009), y el punto de hoy aparte (no entra en la nube):
    - `move`: cambio del SPX (%) y del VIX (puntos) de cada sesión frente a la anterior.
    - `term`: VIX3M/VIX frente al VIX, recta a + b·ln(VIX) con toda la historia (el ajuste logarítmico deja menos
      residuo que el lineal o 1/VIX).
    - `skew`: SKEW frente al VIX; recta con los últimos SKEW_AJUSTE_ANOS años, porque el SKEW ha subido de fondo y con
      toda la historia cualquier día reciente saldría caro (correlación con ln(VIX) de −0,5 en 5 años, −0,18 en 36).
    `vivo` ({SYM: {"value", "prev"}} de indices_vol con la sesión abierta): hoy en directo; si no, el último cierre."""
    spx, vix, v3, sk = (_csv_cierres(s) for s in ("SPX", "VIX", "VIX3M", "SKEW"))
    hoy = None
    if vivo and all(s in vivo and vivo[s].get("value") and vivo[s].get("prev") for s in ("SPX", "VIX")):
        hoy = g.now_ny().strftime("%Y-%m-%d")
    f1 = [f for f in sorted(set(spx) & set(vix)) if f != hoy]
    f3 = [f for f in sorted(set(vix) & set(v3)) if f != hoy]
    fk = [f for f in sorted(set(vix) & set(sk)) if f != hoy]
    # sin sesión en directo, hoy es el último cierre (el de VIX3M/VIX y el del SKEW, solo si son del mismo día)
    ult1 = None
    h3 = hk = None
    if hoy:
        sx, vx = vivo["SPX"], vivo["VIX"]
        h1 = {"date": hoy, "live": True, "x": sx["value"] / sx["prev"] * 100 - 100, "y": vx["value"] - vx["prev"]}
        h = {"date": hoy, "live": True}
        if (vivo.get("VIX3M") or {}).get("value"):
            h3 = (vx["value"], vivo["VIX3M"]["value"] / vx["value"])
        if (vivo.get("SKEW") or {}).get("value"):
            hk = (vx["value"], vivo["SKEW"]["value"])
    else:
        ult1 = f1.pop()
        h1 = {"date": ult1, "live": False, "x": spx[ult1] / spx[f1[-1]] * 100 - 100, "y": vix[ult1] - vix[f1[-1]]}
        h = {"date": ult1, "live": False}
        if f3 and f3[-1] == ult1:
            f3.pop()
            h3 = (vix[ult1], v3[ult1] / vix[ult1])
        if fk and fk[-1] == ult1:
            fk.pop()
            hk = (vix[ult1], sk[ult1])
    dx = [round(spx[b] / spx[a] * 100 - 100, 2) for a, b in zip(f1, f1[1:])]
    dy = [round(vix[b] - vix[a], 2) for a, b in zip(f1, f1[1:])]
    desde = (datetime.strptime(fk[-1], "%Y-%m-%d") - timedelta(days=round(365.25 * SKEW_AJUSTE_ANOS))).strftime("%Y-%m-%d")
    return {"move": {"since": f1[1], "last": f1[-1], "d": _saltos(f1[1:]), "x": dx, "y": dy, "today": h1},
            "term": _nube_ajuste(vix, lambda f: v3[f] / vix[f], f3, h3, h),
            "skew": _nube_ajuste(vix, lambda f: sk[f], fk, hk, h, desde, dec=1)}


def _spx_vivo() -> dict[str, dict]:
    try:
        return indices_vol(["SPX"], True)[0]
    except Exception:  # noqa: BLE001
        return {}


def _nubes_seguro(vivo: dict | None) -> dict | None:
    try:
        return nubes_vix(vivo)
    except Exception:  # noqa: BLE001  (sin los CSV de CBOE la página sigue sin los gráficos)
        return None


def _regimen_curva(r3: float | None, r9: float | None) -> dict | None:
    """Tabla de curva_tramos con el tramo de hoy (VIX/VIX3M y VIX9D/VIX en directo o al cierre)."""
    try:
        t = curva_tramos()
    except Exception:  # noqa: BLE001  (sin históricos de CBOE la página sigue sin la tarjeta)
        return None
    def tramo(r, filas):
        return next((k for k, f in enumerate(filas) if r is not None and f["lo"] <= r < f["hi"]), None)
    return {**t, "r3": r3, "r9": r9, "q3": tramo(r3, t["3m"]), "q9": tramo(r9, t["9d"])}


# ---------------------------------------------------------------- régimen de volatilidad (salud del mercado)
# Indicadores de los gráficos semanales del usuario, con cierres diarios de CBOE. Cortes elegidos con el backtest de
# episodios desde 1990 (primer cierre que cruza el nivel tras 20 sesiones sin hacerlo; SPX a 20/60/120 sesiones y
# caída adicional en 60): VIX >= 35 y VVIX >= 140 marcan el miedo que históricamente dio buenas entradas (VIX >= 30 y
# VVIX >= 120 llegan antes, con un 4-5 % de caída extra típica); SKEW/VIX <= 5 llega a mitad de corrección (4,5 es
# mejor); VIX3M/VIX <= 1 no da ventaja a 60 sesiones, <= 0,90 sí a 120; VIX3M/VIX >= 1,25 y SKEW/VIX >= 12 rinden por
# debajo de la media (complacencia). Series: CSV de daily_prices de CBOE (gex_engine.daily_csv).
VOLREG_DESDE = "2010-01-01"      # el SKEW sube de nivel con los años: antes de 2010 el SKEW/VIX no es comparable
VOLREG = (
    # clave, nombre, cortes (ascendentes), zonas (nombre, tono) de abajo arriba
    ("vix", "VIX", (20, 30, 35),
     (("Calm", "calm"), ("Stress", "watch"), ("High stress", "alert"), ("Fear, buy zone", "buy"))),
    ("vvix", "VVIX", (80, 120, 140),
     (("Calm", "calm"), ("Normal", "calm"), ("Stress", "alert"), ("Panic, buy zone", "buy"))),
    ("term", "VIX3M / VIX", (0.90, 1.00, 1.25),
     (("Deep inversion, buy zone", "buy"), ("Inverted", "alert"), ("Normal", "calm"), ("Complacency", "complacent"))),
    ("skew", "SKEW / VIX", (4.5, 5.5, 12),
     (("Capitulation, buy zone", "buy"), ("Stress", "alert"), ("Normal", "calm"), ("Complacency", "complacent"))),
)
_volreg_cache: dict[str, tuple[float, dict]] = {}


def _csv_cierres(sym: str, ttl: float = 3600) -> dict[str, float]:
    """Cierres diarios {aaaa-mm-dd: valor} del CSV de CBOE (gex_engine.daily_csv). CBOE sube el CSV horas después
    del cierre: con la sesión ya cerrada, el de hoy sale de la cotización de Tradier mientras el CSV no lo traiga."""
    out = {r["date"]: r["close"] for r in g.daily_csv(sym, ttl)}
    if not out:
        raise ConnectionError(f"No {sym} history from CBOE")
    ahora = g.now_ny()
    hoy = ahora.strftime("%Y-%m-%d")
    # el VIX cotiza también antes de la apertura: solo a partir de su cierre (16:15 ET), no un precio de pre-market
    if hoy not in out and g.is_trading_day(ahora) and ahora >= g.close_time(ahora) + timedelta(minutes=15):
        q = g.fetch_quote(sym) or {}
        v = float((q.get("data") or {}).get("close") or 0)
        if q.get("source") == "tradier" and q.get("today") and v > 0:
            out[hoy] = v
    return out


def indices_vol(syms: list[str], live: bool) -> tuple[dict[str, dict], str | None]:
    """Valor y cierre anterior de índices de volatilidad: {SYM: {"value", "prev"}} y la hora (UTC) de la cotización.
    Con la sesión abierta, en directo: la cotización de hoy (Tradier, gex_engine.fetch_quote). Con la sesión
    cerrada, el último cierre oficial de todos (CSV de CBOE) en la misma fecha: el VIX cotiza también en horario
    extendido y VIX3M, VVIX o SKEW no, y mezclarlos daría ratios de dos momentos distintos (TradingView lo hace)."""
    out: dict[str, dict] = {}
    if live:
        ts = None
        for s in syms:
            q = g.fetch_quote(s) or {}
            qd = q.get("data") or {}
            # solo si cotizó hoy: un índice sin cálculo en directo devolvería el cierre de ayer
            if q.get("today") and qd.get("current_price"):
                out[s] = {"value": float(qd["current_price"]), "prev": float(qd.get("prev_day_close") or 0) or None}
                ts = ts or q.get("timestamp")
        return out, ts
    series = {}
    for s in syms:
        try:
            series[s] = _csv_cierres(s)
        except Exception:  # noqa: BLE001
            continue
    if "VIX" not in series:
        return out, None
    dia = max(series["VIX"])
    for s, c in series.items():
        if dia in c:
            ant = [f for f in c if f < dia]
            out[s] = {"value": c[dia], "prev": c[max(ant)] if ant else None}
    return out, None


def _volreg_seguro(vivo: dict[str, float] | None = None) -> dict | None:
    """regimen_vol con los valores en directo (sesión abierta) encima de los del último cierre."""
    try:
        res = regimen_vol()
    except Exception:  # noqa: BLE001  (sin los CSV de CBOE la página sigue sin la tarjeta)
        return None
    if vivo and vivo.get("VIX"):
        res = _volreg_vivo(res, vivo)
    try:
        res = {**res, "analogs": analogos_vol({it["key"]: it["value"] for it in res["items"]})}
    except Exception as e:  # noqa: BLE001  (la tarjeta del régimen sale igual, sin los días parecidos)
        print(f"analogos_vol: {e}", flush=True)
    return res


def _volreg_vivo(res: dict, vivo: dict[str, float]) -> dict:
    vx = vivo["VIX"]
    ahora = {"vix": vx, "vvix": vivo.get("VVIX"),
             "term": vivo["VIX3M"] / vx if vivo.get("VIX3M") else None,
             "skew": vivo["SKEW"] / vx if vivo.get("SKEW") else None}
    cortes = {k: c for k, _, c, _ in VOLREG}
    items = []
    for it in res["items"]:
        v = ahora.get(it["key"])
        items.append(it if v is None else {**it, "value": round(v, 4), "live": True,
                                           "zone": int(np.searchsorted(cortes[it["key"]], v, side="right"))})
    return {**res, "items": items,
            "buy": sum(1 for it in items if it["zones"][it["zone"]]["tone"] == "buy")}


def _volreg_base() -> dict:
    """Series de los cuatro indicadores sobre las sesiones del SPX desde VOLREG_DESDE, con el rendimiento del SPX a
    20, 60 y 120 sesiones y su caída adicional máxima en 60. La comparten regimen_vol y analogos_vol."""
    hit = _volreg_cache.get("base")
    if hit and time.time() - hit[0] < 3600:
        return hit[1]
    vix, v3, vv, sk = (_csv_cierres(s) for s in ("VIX", "VIX3M", "VVIX", "SKEW"))
    spx = {k: v[3] for k, v in g.history_ohlc("SPX")[0].items() if v[3] > 0}
    series = {"vix": vix, "vvix": vv,
              "term": {f: v3[f] / vix[f] for f in v3 if vix.get(f)},
              "skew": {f: sk[f] / vix[f] for f in sk if vix.get(f)}}
    F = [f for f in sorted(spx) if f >= VOLREG_DESDE]
    C = np.array([spx[f] for f in F])
    n = len(C)
    res = {
        # todas las zonas del mismo día: CBOE no sube los cuatro CSV a la vez (el VVIX puede llevar el cierre de hoy y
        # el VIX aún el de ayer) y mezclarlos daría una fila de otra sesión
        "dia": min(max(vix), max(v3), max(vv), max(sk)),
        "series": series, "F": F,
        "X": np.array([[series[k].get(f, np.nan) for k, *_ in VOLREG] for f in F]),
        "fwd": {h: np.array([C[i + h] / C[i] - 1 if i + h < n else np.nan for i in range(n)]) for h in (20, 60, 120)},
        "dd": np.array([C[i + 1:i + 61].min() / C[i] - 1 if i + 60 < n else np.nan for i in range(n)]),
    }
    _volreg_cache["base"] = (time.time(), res)
    return res


def regimen_vol() -> dict:
    """Zona de hoy de cada indicador (último cierre de CBOE) y qué hizo el SPX desde 2010 tras los días de cada zona:
    rendimiento medio a 60 y 120 sesiones, % al alza a 60 y mediana de la caída adicional máxima en 60 sesiones."""
    hit = _volreg_cache.get("r")
    if hit and time.time() - hit[0] < 3600:
        return hit[1]
    b = _volreg_base()
    dia, series, F, fwd, dd = b["dia"], b["series"], b["F"], b["fwd"], b["dd"]
    n = len(F)

    def stats(m):
        m = m & np.isfinite(fwd[60])
        if not m.any():
            return {"n": 0}
        m2 = m & np.isfinite(fwd[120])
        return {"n": int(m.sum()), "r60": _r(fwd[60][m].mean()), "up60": _r(float(np.mean(fwd[60][m] > 0))),
                "r120": _r(fwd[120][m2].mean()) if m2.any() else None, "dd60": _r(float(np.median(dd[m])))}

    items = []
    for key, nombre, cortes, zonas in VOLREG:
        s = series[key]
        X = np.array([s.get(f, np.nan) for f in F])
        bordes = (-np.inf, *cortes, np.inf)
        filas = []
        for k, (zn, tono) in enumerate(zonas):
            lo, hi = bordes[k], bordes[k + 1]
            filas.append({"lo": None if k == 0 else lo, "hi": None if k == len(zonas) - 1 else hi,
                          "label": zn, "tone": tono, **stats(np.isfinite(X) & (X >= lo) & (X < hi))})
        ult = max(f for f in s if f <= dia)
        v = s[ult]
        items.append({"key": key, "name": nombre, "value": round(v, 4), "date": ult,
                      "zone": int(np.searchsorted(cortes, v, side="right")), "zones": filas})
    res = {"since": F[0], "last": F[-1], "items": items, "base": stats(np.ones(n, bool)),
           "buy": sum(1 for it in items if it["zones"][it["zone"]]["tone"] == "buy")}
    _volreg_cache["r"] = (time.time(), res)
    return res


# ---------------------------------------------------------------- días parecidos (los cuatro indicadores a la vez)
# Cada indicador pasa a su percentil histórico (pesan igual) y se buscan los ANALOGOS_K días más cercanos a hoy en
# esos cuatro percentiles. Vienen en racimos (una misma crisis da días seguidos): se agrupan en episodios separados por
# más de ANALOGOS_GAP sesiones y cada episodio cuenta una vez, con su día más parecido. Ventanas que se solapan y pocos
# episodios (unos 20): una inclinación, no una probabilidad.
ANALOGOS_K = 120
ANALOGOS_GAP = 20
ANALOGOS_H = (20, 60, 120)


def analogos_vol(ahora: dict[str, float]) -> dict | None:
    """Episodios desde 2010 con VIX, VVIX, VIX3M/VIX y SKEW/VIX parecidos a `ahora` ({clave de VOLREG: valor}) y qué
    hizo el SPX después: mediana y veces al alza a 20, 60 y 120 sesiones y caída adicional en 60, frente a cualquier
    día. También los días con la misma combinación de zonas exacta."""
    keys = [k for k, *_ in VOLREG]
    if any(ahora.get(k) is None for k in keys):
        return None
    b = _volreg_base()
    F, X, fwd, dd = b["F"], b["X"], b["fwd"], b["dd"]
    n = len(F)
    x0 = np.array([ahora[k] for k in keys], float)
    ok = np.all(np.isfinite(X), axis=1) & np.isfinite(fwd[60])   # con 60 sesiones de recorrido
    if ok.sum() < ANALOGOS_K:
        return None
    P = np.full_like(X, np.inf)
    p0 = np.empty(len(keys))
    for j in range(len(keys)):
        col = np.sort(X[ok, j])
        P[ok, j] = np.searchsorted(col, X[ok, j]) / len(col)
        p0[j] = np.searchsorted(col, x0[j]) / len(col)
    dist = np.sqrt(((P - p0) ** 2).sum(axis=1))
    sel = np.sort(np.argsort(dist)[:ANALOGOS_K])

    def grupos(idx) -> list[int]:
        """Un día por racimo (días a menos de ANALOGOS_GAP sesiones entre sí): el más parecido a hoy."""
        ep, prev = [], None
        for i in idx:
            if prev is None or i - prev > ANALOGOS_GAP:
                ep.append(int(i))
            elif dist[i] < dist[ep[-1]]:
                ep[-1] = int(i)
            prev = i
        return ep

    def resumen(idx) -> dict:
        idx = np.asarray(idx, int)
        out = {}
        for h in ANALOGOS_H:
            v = fwd[h][idx]
            v = v[np.isfinite(v)]
            out[str(h)] = {"n": int(len(v)), "med": _r(float(np.median(v))) if len(v) else None,
                           "up": int((v > 0).sum())}
        out["dd60"] = {"med": _r(float(np.median(dd[idx]))), "min": _r(float(dd[idx].min()))}
        return out

    ep = grupos(sel)
    val = lambda a, i: _r(a[i])   # noqa: E731
    episodios = [{"date": F[i], "dist": _r(dist[i], 3), **{k: _r(X[i, j], 4) for j, k in enumerate(keys)},
                  **{f"r{h}": val(fwd[h], i) for h in ANALOGOS_H}, "dd60": val(dd, i)} for i in reversed(ep)]
    base = {}
    for h in ANALOGOS_H:
        v = fwd[h][np.isfinite(fwd[h])]
        base[str(h)] = {"med": _r(float(np.median(v))), "up": _r(float(np.mean(v > 0)))}
    # misma combinación de zonas que hoy (cortes de VOLREG)
    zona = np.stack([np.searchsorted(c, X[:, j], side="right") for j, (_, _, c, _) in enumerate(VOLREG)], axis=1)
    z0 = np.array([np.searchsorted(c, x0[j], side="right") for j, (_, _, c, _) in enumerate(VOLREG)])
    mz = np.where(ok & np.all(zona == z0, axis=1))[0]
    return {"since": F[0], "k": ANALOGOS_K, "gap": ANALOGOS_GAP, "episodes": episodios, "stats": resumen(ep),
            "base": base, "zones": {"days": int(len(mz)), "episodes": len(grupos(mz)), "first": F[int(mz[0])] if len(mz) else None,
                                    **(resumen(mz) if len(mz) else {})}}


# ---------------------------------------------------------------- probabilidad de cerrar fuera del 1σ (modelo 1)
SIGMA1_VARS = ["gex", "r9", "r3", "rv5", "lvix"]
# variables del modelo publicado: fuera de muestra (2012-2019 -> 2020-hoy) solo el GEX y VIX9D/VIX aportan; con las
# cinco el Brier es 0,1473 y con estas dos 0,1469, frente a 0,1539 de la frecuencia fija (y aguanta al reves)
SIGMA1_MODELO = ["gex", "r9"]


def datos_1sigma(precio: str = "SPX", vol: str = "VIX") -> tuple[np.ndarray, np.ndarray, np.ndarray, list[str]]:
    """Filas (variables del cierre de t-1), objetivo (`precio` cerró en t fuera del 1σ de `vol` en t-1: el SPX con el
    VIX, el QQQ con el VXN) y fechas t. El GEX es siempre el del SPX (SqueezeMetrics) y la curva, la del VIX; `lvix`
    es el log de `vol`. Variables en SIGMA1_VARS; estudio en pruebas/modelo_1sigma.py."""
    fg, _, pg = _gex_percentil()
    gex = {f: p for f, p in zip(fg, pg) if np.isfinite(p)}

    def cierres(sym):
        d, _ = g.history_ohlc(sym)
        return {k: v[3] for k, v in d.items() if v[3] > 0}
    px, vix, v3, v9, vv = (cierres(s) for s in (precio, "VIX", "VIX3M", "VIX9D", vol))
    dias = [f for f in sorted(px) if f in vix and f in v3 and f in v9 and f in gex and f in vv]
    C = np.array([px[f] for f in dias])
    V = np.array([vv[f] for f in dias])
    sig = V / 100 / np.sqrt(252)
    ar = np.abs(np.r_[np.nan, np.diff(np.log(C))])
    filas = []
    for i in range(5, len(dias)):
        f = dias[i]
        filas.append([gex[f], v9[f] / vix[f], vix[f] / v3[f], np.mean(ar[i - 4:i + 1]) / sig[i], np.log(V[i])])
    Xall = np.array(filas)                       # fila k: variables del cierre de dias[k + 5]
    X, Y, F = Xall[:-1], (ar[6:] > sig[5:-1]).astype(float), np.array(dias[6:])
    return X, Y, F, list(SIGMA1_VARS)


def _vars_hoy() -> tuple[str, dict[str, float]]:
    """Variables de SIGMA1_MODELO del último cierre con GEX y curva del VIX (no dependen del subyacente: el histórico
    de QQQ llega con una sesión de retraso)."""
    fg, _, pg = _gex_percentil()
    fecha, p = next((f, x) for f, x in zip(reversed(fg), reversed(pg)) if np.isfinite(x))
    q = {s: (g.history_ohlc(s)[0].get(fecha) or (0, 0, 0, 0))[3] for s in ("VIX", "VIX9D", "VIX3M")}
    if not all(q.values()):
        raise LookupError(f"no VIX family close for {fecha}")
    return fecha, {"gex": float(p), "r9": q["VIX9D"] / q["VIX"], "r3": q["VIX"] / q["VIX3M"]}


def logit_fit(X: np.ndarray, y: np.ndarray, l2: float = 1e-3, iters: int = 50) -> dict:
    """Regresión logística por Newton con variables estandarizadas y una penalización L2 mínima."""
    mu, sd = X.mean(0), X.std(0)
    sd[sd == 0] = 1
    Z = np.column_stack([np.ones(len(X)), (X - mu) / sd])
    w = np.zeros(Z.shape[1])
    for _ in range(iters):
        p = 1 / (1 + np.exp(-Z @ w))
        H = Z.T @ (Z * (p * (1 - p))[:, None]) + l2 * np.eye(len(w))
        paso = np.linalg.solve(H, Z.T @ (y - p) - l2 * w)
        w += paso
        if np.abs(paso).max() < 1e-8:
            break
    return {"mu": mu, "sd": sd, "w": w}


def logit_prob(X: np.ndarray, m: dict) -> np.ndarray:
    Z = np.column_stack([np.ones(len(X)), (X - m["mu"]) / m["sd"]])
    return 1 / (1 + np.exp(-Z @ m["w"]))


def prob_1sigma(precio: str = "SPX", vol: str = "VIX") -> dict | None:
    """Probabilidad de que `precio` cierre la sesión siguiente fuera del 1σ de `vol`, con la logística de
    SIGMA1_MODELO ajustada con toda la historia. `base`: frecuencia de toda la historia; `p10`/`p90`: rango
    habitual del modelo."""
    try:
        X, y, f, nombres = datos_1sigma(precio, vol)
        fecha, hoy = _vars_hoy()
    except Exception:  # noqa: BLE001  (sin históricos la línea del Equity Hub sigue sin la probabilidad)
        return None
    i = [nombres.index(c) for c in SIGMA1_MODELO]
    m = logit_fit(X[:, i], y)
    p = float(logit_prob(np.array([[hoy[c] for c in SIGMA1_MODELO]]), m)[0])
    ph = logit_prob(X[:, i], m)
    return {"p": round(p, 4), "date": fecha, "base": round(float(y.mean()), 4),
            "p10": round(float(np.quantile(ph, 0.1)), 4), "p90": round(float(np.quantile(ph, 0.9)), 4),
            "vars": {c: round(hoy[c], 4) for c in SIGMA1_MODELO}, "since": str(f[0])}


# ---------------------------------------------------------------- gaps de apertura
GAP_VARS = ["gap", "dir", "gex", "r9", "prev"]
GAP_TRAMOS = ((0.1, 0.3), (0.3, 0.6), (0.6, 1.0), (1.0, 99.0))   # |gap| en sigmas diarias


def datos_gaps(precio: str, vol: str) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Gaps de apertura de `precio` (SPY o QQQ: sus aperturas son operaciones reales; en el SPX de CBOE hay años con la
    apertura igual al cierre anterior) de más de 0,1 σ del índice de volatilidad `vol` del día anterior. Devuelve las
    variables de GAP_VARS conocidas en la apertura (|gap| en σ, dirección, percentil del GEX y VIX9D/VIX del día
    anterior, rendimiento del día anterior en σ con el signo del gap), si el gap se cerró en la sesión, si el día siguió
    en la dirección del gap y la fecha. Estudio: pruebas/estudio_gaps.py."""
    fg, _, pg = _gex_percentil()
    gex = {f: p for f, p in zip(fg, pg) if np.isfinite(p)}
    px, _ = g.history_ohlc(precio)
    cier = {s_: {k: v[3] for k, v in g.history_ohlc(s_)[0].items() if v[3] > 0} for s_ in (vol, "VIX", "VIX9D")}
    dias = [f for f in sorted(px) if all(f in c for c in cier.values()) and f in gex]
    X, cierra, sigue, F = [], [], [], []
    for a0, a, b in zip(dias, dias[1:], dias[2:]):
        o, h, lo, c = px[b]
        c1, c0 = px[a][3], px[a0][3]
        sig = cier[vol][a] / 100 / np.sqrt(252)
        if min(o, h, lo, c, c1, c0) <= 0 or abs(o - c1) < 1e-9:
            continue
        gap = np.log(o / c1) / sig
        if abs(gap) < 0.1:
            continue
        d = 1.0 if gap > 0 else -1.0
        X.append([abs(gap), d, gex[a], cier["VIX9D"][a] / cier["VIX"][a], d * np.log(c1 / c0) / sig])
        cierra.append(float(lo <= c1 if d > 0 else h >= c1))
        sigue.append(float(d * (c - o) > 0))
        F.append(b)
    return np.array(X), np.array(cierra), np.array(sigue), np.array(F)


def gap_tramos(precio: str, vol: str) -> dict:
    """Por tamaño del gap (en σ): fracción de gaps que se cerraron en la sesión y de días que siguieron al gap. El
    estudio fuera de muestra muestra que el tamaño explica casi todo (Brier 0,249 -> 0,213 frente a la frecuencia fija)
    y que la gamma no añade nada; seguir al gap es una moneda al aire (51 %)."""
    X, cierra, sigue, F = datos_gaps(precio, vol)
    filas = []
    for lo, hi in GAP_TRAMOS:
        m = (X[:, 0] >= lo) & (X[:, 0] < hi)
        filas.append({"lo": lo, "hi": hi, "n": int(m.sum()), "fill": _r(float(cierra[m].mean()), 4),
                      "trend": _r(float(sigue[m].mean()), 4)})
    return {"proxy": precio, "vol": vol, "since": str(F[0]), "rows": filas,
            "fill": _r(float(cierra.mean()), 4), "trend": _r(float(sigue.mean()), 4)}
