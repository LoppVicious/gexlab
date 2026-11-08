"""
GEX Lab - superficie de volatilidad implicita para el Panel de volatilidad.

Para cada ticker publica (motor -> pub/t/<SYM>/vol.json):
  - smiles: IV por strike (y delta) de cada vencimiento, con la opcion fuera de dinero de cada strike
  - term: IV ATM por vencimiento, IV forward entre vencimientos consecutivos y banda percentil 10-90
  - prev: las mismas curvas de la sesion anterior y de hace una semana (copias de la cadena del recolector)
  - matrix: IV por vencimiento x strike fijo y su cambio frente a la sesion anterior
  - bands: percentiles 10-90 del skew por delta, por plazo, para dibujar la banda de cada vencimiento

La historia (history/ivsurf_<SYM>.json) guarda cada dia la estructura temporal en plazos fijos y el skew
en deltas fijas: es lo que permite comparar un vencimiento de hoy con su historia aunque los vencimientos
cambien cada dia.
"""
from __future__ import annotations

import os
from datetime import date, datetime, timedelta

import numpy as np

import gex_engine as g

TERM_GRID = [1, 2, 3, 5, 7, 10, 14, 21, 30, 45, 60, 90, 120, 180, 270, 365]
TENORS = [7, 14, 30, 60, 90, 180]
DELTAS = [-0.05, -0.10, -0.15, -0.20, -0.25, -0.35, -0.45, 0.45, 0.35, 0.25, 0.20, 0.15, 0.10, 0.05]
MIN_BAND_DAYS = 15        # sesiones minimas para dibujar percentiles
MAX_SMILES = 30           # vencimientos con smile completo
HORIZON_DAYS = 190        # horizonte del panel: seis meses
DAY_MIN = 24 * 60.0


_erf = np.frompyfunc(__import__("math").erf, 1, 1)


def _erf_arr(x):
    return np.array(_erf(x), dtype=float)


def _dte(exp: np.datetime64, now64: np.datetime64) -> float:
    return float((exp - now64).astype("timedelta64[m]").astype(float) / DAY_MIN)


VIX_ROOTS = {"VIX", "VIXW"}


def _habil_anterior(d: date) -> date:
    while d.weekday() >= 5 or d.strftime("%Y-%m-%d") in g.NYSE_HOLIDAYS:
        d -= timedelta(days=1)
    return d


def _tercer_viernes(y: int, m: int) -> date:
    d = date(y, m, 15)
    return d + timedelta(days=(4 - d.weekday()) % 7)


def es_mensual(day: date, symbol: str = "") -> bool:
    """Vencimiento mensual estandar: el tercer viernes (el dia habil anterior si es festivo). En el VIX, el miercoles
    30 dias antes del tercer viernes del mes siguiente."""
    if symbol.upper() in VIX_ROOTS:
        y, m = (day.year + 1, 1) if day.month == 12 else (day.year, day.month + 1)
        return day == _habil_anterior(_tercer_viernes(y, m) - timedelta(days=30))
    return day == _habil_anterior(_tercer_viernes(day.year, day.month))


def _pick_expiries(exps: list, dtes: list[float], symbol: str = "") -> list[int]:
    """Solo vencimientos semanales y mensuales hasta HORIZON_DAYS: de cada semana, el ultimo vencimiento si es el
    viernes (o el jueves por festivo; en el VIX, miercoles o martes), mas los mensuales. Fuera los diarios y los de
    fin de mes."""
    dia_semanal = 2 if symbol.upper() in VIX_ROOTS else 4   # miercoles en el VIX, viernes en el resto
    semana: dict = {}
    for i, e in enumerate(exps):
        if dtes[i] > HORIZON_DAYS:
            continue
        d = date.fromisoformat(str(e)[:10])
        semana[d.isocalendar()[:2]] = (i, d)       # exps va ordenado: se queda el ultimo de cada semana
    # el ultimo de la semana solo cuenta como semanal si cae ese dia o el anterior (festivo); asi no entran los
    # de fin de mes o de trimestre (p. ej. un SPX que vence un martes 31)
    out = {i for i, d in semana.values() if d.weekday() in (dia_semanal, dia_semanal - 1)}
    out |= {i for i, e in enumerate(exps) if dtes[i] <= HORIZON_DAYS and es_mensual(date.fromisoformat(str(e)[:10]), symbol)}
    return sorted(out)[:MAX_SMILES]


def vix_forwards(ch: dict, T: np.ndarray, now64: np.datetime64):
    """Las opciones del VIX van sobre el futuro del VIX de su vencimiento, no sobre el indice (que no se puede
    comprar): con backwardation o contango fuerte el futuro esta lejos del spot y, si se usa el spot, el skew
    salta al cambiar de puts a calls. Por vencimiento:
      - forward por paridad put-call con los puntos medios: F = K + e^(rT) (C - P), mediana de los 5 strikes con
        C y P mas parecidos (los mas cercanos al dinero);
      - IV de cada contrato por Black-76 sobre ese forward (la de CBOE esta calculada contra el spot).
    Devuelve (referencia por contrato, IV por contrato, {vencimiento: forward})."""
    from fuente_tradier import implied_vol
    K, C, E = ch["K"], ch["call"], ch["exp"]
    bid, ask = ch["bid"], ch["ask"]
    r = g.risk_free()
    mid = np.where((bid > 0) & (ask >= bid), (bid + ask) / 2, np.nan)
    ref = np.full(K.shape, np.nan)
    iv = np.full(K.shape, np.nan)
    fwd = {}
    for x in np.unique(E[E > now64]):
        m = E == x
        calls = {float(k): p for k, p in zip(K[m & C], mid[m & C]) if np.isfinite(p)}
        puts = {float(k): p for k, p in zip(K[m & ~C], mid[m & ~C]) if np.isfinite(p)}
        t = float(T[m][0])
        pares = sorted((abs(calls[k] - puts[k]), k + np.exp(r * t) * (calls[k] - puts[k])) for k in calls if k in puts)
        if len(pares) < 2:
            continue
        f = float(np.median([v for _, v in pares[:5]]))
        if f <= 0:
            continue
        fwd[str(x)] = f
        ref[m] = f
        iv[m] = implied_vol(mid[m], f * np.exp(-r * t), K[m], T[m], r, C[m])   # Black-76 = BS con S = F e^-rT
    iv = np.where(np.isfinite(iv), iv, 0.0)          # sin forward o sin precio: fuera (IV 0 no pasa el filtro)
    ref = np.where(np.isfinite(ref), ref, np.nanmedian(ref) if np.isfinite(ref).any() else 1.0)
    return ref, iv, fwd


def smiles_from_chain(ch: dict, spot: float, now: datetime) -> list[dict]:
    """Una curva por vencimiento: en cada strike la IV de la opcion fuera de dinero (put por debajo del spot,
    call por encima), que es la que tiene cotizaciones fiables."""
    now64 = np.datetime64(now.replace(second=0, microsecond=0))
    K, C, E, IV = ch["K"], ch["call"], ch["exp"], ch["iv"]
    bid = ch.get("bid")
    sym = str(ch.get("symbol") or "").upper()
    T = np.maximum((E - now64).astype("timedelta64[m]").astype(float), 1.0) / (365 * DAY_MIN)
    # precio de referencia de cada contrato: el spot o, en el VIX, el futuro de su vencimiento (ver vix_forwards)
    ref = np.full(K.shape, float(spot))
    fwd: dict = {}
    if sym in VIX_ROOTS and bid is not None:
        ref, IV, fwd = vix_forwards(ch, T, now64)
    # delta de Black-Scholes con la IV de cada strike (la misma regla para hoy y para las copias de dias
    # anteriores, que no guardan la delta de CBOE)
    sig = np.maximum(IV, 1e-4) * np.sqrt(T)
    d1 = (np.log(ref / K) + 0.5 * sig * sig) / sig
    nd1 = 0.5 * (1 + _erf_arr(d1 / np.sqrt(2)))
    D = np.where(C, nd1, nd1 - 1)
    alive = (E > now64) & (IV > 0.01) & (IV < 5)
    otm = np.where(C, K >= ref, K < ref)
    sel = alive & otm
    if bid is not None:
        sel &= (bid > 0) | (ch.get("oi", np.ones_like(K)) > 0)
    exps = sorted(set(E[sel].tolist()))
    exps = [np.datetime64(x, "m") for x in exps]
    # un solo vencimiento por dia: SPX, NDX o RUT tienen el mensual AM (SPX, 09:30) y el semanal PM (SPXW) el mismo
    # dia; se queda el mensual (el de hora mas temprana) si tiene strikes suficientes
    by_day: dict = {}
    for x in exps:
        n = int((sel & (E == x)).sum())
        dd = str(x)[:10]
        if dd not in by_day or (n >= 5 and (by_day[dd][1] < 5 or x < by_day[dd][0])):
            by_day[dd] = (x, n)
    exps = sorted(v[0] for v in by_day.values())
    dtes = [_dte(x, now64) for x in exps]
    out = []
    for i in _pick_expiries(exps, dtes, sym) if exps else []:
        m = sel & (E == exps[i])
        if m.sum() < 5:
            continue
        o = np.argsort(K[m])
        k, iv = K[m][o], IV[m][o]
        d = D[m][o]
        # sin alas extremas: deltas por debajo de 0,02 son ruido de horquilla
        keep = np.abs(d) >= 0.02
        k, iv, d = k[keep], iv[keep], d[keep]
        if k.size < 5:
            continue
        days = int((exps[i].astype("datetime64[D]") - now64.astype("datetime64[D]")).astype(int))
        f = fwd.get(str(exps[i]))
        out.append({"exp": str(exps[i])[:10], "dte": round(dtes[i], 3), "days": max(days, 0),
                    **({"fwd": round(f, 4)} if f else {}),
                    "monthly": es_mensual(date.fromisoformat(str(exps[i])[:10]), sym), "K": np.round(k, 3).tolist(),
                    "iv": np.round(iv, 5).tolist(), "delta": np.round(d, 4).tolist()})
    return out


def atm_iv(sm: dict, spot: float) -> float | None:
    spot = sm.get("fwd") or spot   # VIX: en el dinero respecto al futuro de ese vencimiento
    k, iv = np.array(sm["K"]), np.array(sm["iv"])
    if k.size < 2 or spot < k[0] or spot > k[-1]:
        return None
    return float(np.interp(spot, k, iv))


def iv_at_delta(sm: dict, d: float) -> float | None:
    if not sm.get("delta"):
        return None
    dl, iv = np.array(sm["delta"]), np.array(sm["iv"])
    side = dl < 0 if d < 0 else dl > 0
    if side.sum() < 2:
        return None
    x, y = dl[side], iv[side]
    o = np.argsort(x)
    x, y = x[o], y[o]
    if d < x[0] - 1e-9 or d > x[-1] + 1e-9:
        return None
    return float(np.interp(d, x, y))


def term_structure(smiles: list[dict], spot: float) -> list[dict]:
    pts = []
    for sm in smiles:
        a = atm_iv(sm, spot)
        if a:
            pts.append({"exp": sm["exp"], "dte": sm["dte"], "atm": round(a, 5)})
    # IV forward entre vencimientos consecutivos: sqrt((s2^2 T2 - s1^2 T1) / (T2 - T1))
    for p0, p1 in zip(pts[:-1], pts[1:]):
        t0, t1 = max(p0["dte"], 1e-3) / 365, p1["dte"] / 365
        v = p1["atm"] ** 2 * t1 - p0["atm"] ** 2 * t0
        p1["fwd"] = round(float(np.sqrt(v / (t1 - t0))), 5) if v > 0 and t1 > t0 else None
    if pts:
        pts[0]["fwd"] = pts[0]["atm"]
    return pts


def grid_snapshot(smiles: list[dict], spot: float) -> dict:
    """Estructura temporal en plazos fijos y skew en deltas fijas, interpolados entre vencimientos."""
    ts = [(sm["dte"], atm_iv(sm, spot)) for sm in smiles]
    ts = [(d, v) for d, v in ts if v]
    t = {}
    if len(ts) >= 2:
        x, y = np.array([a for a, _ in ts]), np.array([b for _, b in ts])
        for n in TERM_GRID:
            if x[0] <= n <= x[-1]:
                t[str(n)] = round(float(np.interp(n, x, y)), 5)
    s = {}
    for ten in TENORS:
        lo = [sm for sm in smiles if sm["dte"] <= ten]
        hi = [sm for sm in smiles if sm["dte"] >= ten]
        if not lo or not hi:
            continue
        a, b = lo[-1], hi[0]
        row = {}
        for dl in DELTAS:
            va, vb = iv_at_delta(a, dl), iv_at_delta(b, dl)
            if va is None or vb is None:
                continue
            w = 0.0 if b["dte"] == a["dte"] else (ten - a["dte"]) / (b["dte"] - a["dte"])
            row[f"{dl:+.2f}"] = round(va + (vb - va) * w, 5)
        if row:
            s[str(ten)] = row
    return {"t": t, "s": s}


def _hist_path(sym: str) -> str:
    return os.path.join(g.HIST_DIR, f"ivsurf_{sym.replace('.', '_')}.json")


def history(sym: str, today: str | None = None, snap: dict | None = None) -> dict:
    return g._vol_history_rw(_hist_path(sym), today or g.now_ny().strftime("%Y-%m-%d"), snap)


def bands(h: dict, today: str) -> dict:
    """Percentiles 10 y 90 de cada plazo (estructura temporal) y de cada plazo x delta (skew)."""
    days = [d for d in sorted(h) if d < today]
    out = {"days": len(days), "term": {}, "skew": {}}
    if len(days) < MIN_BAND_DAYS:
        return out
    for n in TERM_GRID:
        v = [h[d]["t"].get(str(n)) for d in days if h[d].get("t")]
        v = [x for x in v if x]
        if len(v) >= MIN_BAND_DAYS:
            out["term"][str(n)] = [round(float(np.percentile(v, 10)), 5), round(float(np.percentile(v, 90)), 5)]
    for ten in TENORS:
        row = {}
        for dl in DELTAS:
            k = f"{dl:+.2f}"
            v = [((h[d].get("s") or {}).get(str(ten)) or {}).get(k) for d in days]
            v = [x for x in v if x]
            if len(v) >= MIN_BAND_DAYS:
                row[k] = [round(float(np.percentile(v, 10)), 5), round(float(np.percentile(v, 90)), 5)]
        if row:
            out["skew"][str(ten)] = row
    return out


def _snapshot_smiles(sym: str, day: str, now: datetime) -> tuple[list[dict], float | None]:
    snap = g.load_chain_snapshot(sym, day)
    if not snap:
        return [], None
    ref = snap.get("saved_at") or now
    ch = {"K": snap["K"], "call": snap["call"], "exp": snap["exp"], "iv": snap["iv"], "oi": snap["oi"]}
    return smiles_from_chain(ch, snap["spot"], ref), snap["spot"]


def _prev_days(now: datetime) -> tuple[str, str]:
    d = now.replace(hour=0, minute=0, second=0, microsecond=0)
    p1 = g.prev_trading_day(d)
    p5 = d
    for _ in range(5):
        p5 = g.prev_trading_day(p5)
    return p1.strftime("%Y-%m-%d"), p5.strftime("%Y-%m-%d")


def matrix(smiles: list[dict], prev: list[dict], spot: float, n_strikes: int = 15) -> dict:
    """IV por vencimiento y strike fijo alrededor del spot, con el cambio frente a la sesion anterior."""
    if not smiles:
        return {}
    allk = sorted(set(k for sm in smiles[:10] for k in sm["K"]))
    if not allk:
        return {}
    # strikes que existen en la mayoria de los vencimientos (los redondos), los mas cercanos al spot
    counts = {k: sum(1 for sm in smiles[:10] if k in sm["K"]) for k in allk}
    common = [k for k in allk if counts[k] >= max(2, min(6, len(smiles[:10])) // 2)] or allk
    common.sort(key=lambda k: abs(k - spot))
    ks = sorted(common[:n_strikes])
    pmap = {sm["exp"]: dict(zip(sm["K"], sm["iv"])) for sm in prev}
    rows = []
    for sm in smiles[:10]:
        cur = dict(zip(sm["K"], sm["iv"]))
        pv = pmap.get(sm["exp"], {})
        rows.append({"exp": sm["exp"], "dte": sm["dte"], "days": sm.get("days"), "monthly": sm.get("monthly"),
                     "iv": [cur.get(k) for k in ks],
                     "chg": [round(cur[k] - pv[k], 5) if k in cur and k in pv else None for k in ks]})
    return {"strikes": ks, "rows": rows}


def vol_data(sym: str, save: bool = True) -> dict:
    sym = g.normalize(sym)
    ch = g.parse_chain(g.fetch_chain(sym))
    now = g.now_ny()
    spot = ch["spot"]
    implied = g.implied_index_spot(sym, ch["close"], now)
    if implied and implied.get("use"):
        spot = implied["value"]
    sm = smiles_from_chain(ch, spot, now)
    if not sm:
        raise LookupError("Sin vencimientos con volatilidad implícita")
    today = g.now_ny().strftime("%Y-%m-%d")
    snap = grid_snapshot(sm, spot)
    h = history(sym, today, snap if save and g.is_trading_day(now) else None)
    p1, p5 = _prev_days(now)
    prev = {}
    for key, day in (("1d", p1), ("1w", p5)):
        ps, pspot = _snapshot_smiles(sym, day, now)
        if ps:
            prev[key] = {"date": day, "spot": pspot, "smiles": ps, "term": term_structure(ps, pspot)}
    return {
        "symbol": sym, "name": g.name_of(sym), "spot": spot, "generado": now.strftime("%Y-%m-%d %H:%M ET"),
        "timestamp": ch["timestamp"], "smiles": sm, "term": term_structure(sm, spot), "prev": prev,
        "matrix": matrix(sm, (prev.get("1d") or {}).get("smiles", []), spot),
        "bands": bands(h, today), "tenors": TENORS, "deltas": DELTAS, "term_grid": TERM_GRID,
    }
