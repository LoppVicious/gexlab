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
EVENT_RATIO = 1.4         # varianza forward de un tramo frente a la normal para marcar un evento
EVENT_HORIZON = 90        # dias: tramos que cuentan para la varianza normal y para los eventos
YZ_WINDOWS = [10, 20, 30, 60, 90, 120]   # ventanas de la vol realizada y su cono (sesiones)
CONE_DAYS = 252           # el cono usa el ultimo ano


_erf = np.frompyfunc(__import__("math").erf, 1, 1)


def _erf_arr(x):
    return np.array(_erf(x), dtype=float)


def _dte(exp: np.datetime64, now64: np.datetime64) -> float:
    return float((exp - now64).astype("timedelta64[m]").astype(float) / DAY_MIN)


VIX_ROOTS = {"VIX", "VIXW"}


es_mensual = g.es_mensual


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


def model_free_vol(K, C, bid, ask, F: float, T: float) -> float | None:
    """Volatilidad sin modelo de un vencimiento con el metodo del VIX (CBOE):
    sigma^2 = 2/T sum(dK/K^2 e^rT Q(K)) - 1/T (F/K0 - 1)^2, con Q el punto medio de la opcion fuera de dinero,
    K0 el primer strike por debajo del forward (media de call y put) y las alas cortadas tras dos strikes seguidos
    sin bid. Con la cadena del SPX da el VIX."""
    ks = np.unique(K)
    if ks.size < 5 or T <= 0:
        return None
    below = ks[ks <= F]
    K0 = float(below.max() if below.size else ks.min())
    mid = (bid + ask) / 2
    q: dict[float, float] = {}
    for is_call, wing in ((False, sorted((float(k) for k in ks if k < K0), reverse=True)),
                          (True, sorted(float(k) for k in ks if k > K0))):
        quotes = {float(k): (b, p) for k, b, p in zip(K[C == is_call], bid[C == is_call], mid[C == is_call])}
        zeros = 0
        for k in wing:
            b, p = quotes.get(k, (0.0, 0.0))
            if b <= 0:
                zeros += 1
                if zeros >= 2:
                    break
                continue
            zeros = 0
            q[k] = float(p)
    at = [float(mid[(K == K0) & (C == c) & (bid > 0)][0]) for c in (True, False) if ((K == K0) & (C == c) & (bid > 0)).any()]
    if not at:
        return None
    q[K0] = float(np.mean(at))
    kk = np.array(sorted(q))
    if kk.size < 5:
        return None
    dk = np.empty_like(kk)
    dk[1:-1] = (kk[2:] - kk[:-2]) / 2
    dk[0], dk[-1] = kk[1] - kk[0], kk[-1] - kk[-2]
    s2 = (2 / T * float(np.sum(dk / kk ** 2 * np.array([q[k] for k in kk]))) * float(np.exp(g.risk_free() * T))
          - (F / K0 - 1) ** 2 / T)
    return float(np.sqrt(s2)) if s2 > 0 else None


def smiles_from_chain(ch: dict, spot: float, now: datetime) -> list[dict]:
    """Una curva por vencimiento: en cada strike la IV de la opcion fuera de dinero (put por debajo del forward,
    call por encima), que es la que tiene cotizaciones fiables."""
    now64 = np.datetime64(now.replace(second=0, microsecond=0))
    K, C, E, IV = ch["K"], ch["call"], ch["exp"], ch["iv"]
    bid = ch.get("bid")
    sym = str(ch.get("symbol") or "").upper()
    T = np.maximum((E - now64).astype("timedelta64[m]").astype(float), 1.0) / (365 * DAY_MIN)
    # precio de referencia de cada contrato: el forward implicito de su vencimiento (gex_engine.parse_chain; en el VIX,
    # el futuro), con el que ya esta calculada la IV; en copias antiguas sin forward, el spot
    Fc = ch.get("fwd")
    ref = (np.where(np.isfinite(Fc) & (Fc > 0), Fc, float(spot)) if Fc is not None and len(Fc) == len(K)
           else np.full(K.shape, float(spot)))
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
        f = float(ref[m][0]) if Fc is not None else None
        mf = None
        if bid is not None and ch.get("ask") is not None and f:
            e = E == exps[i]
            mf = model_free_vol(K[e], C[e], bid[e], ch["ask"][e], f, float(T[e][0]))
        out.append({"exp": str(exps[i])[:10], "dte": round(dtes[i], 3), "days": max(days, 0),
                    **({"fwd": round(f, 4)} if f else {}), **({"mf": round(mf, 5)} if mf else {}),
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
            c25, p25 = iv_at_delta(sm, 0.25), iv_at_delta(sm, -0.25)
            shp = {"rr25": round(c25 - p25, 5), "bf25": round((c25 + p25) / 2 - a, 5)} if c25 and p25 else {}
            pts.append({"exp": sm["exp"], "dte": sm["dte"], "atm": round(a, 5), **shp,
                        **({"mf": sm["mf"]} if sm.get("mf") else {})})
    # IV forward entre vencimientos consecutivos: sqrt((s2^2 T2 - s1^2 T1) / (T2 - T1))
    for p0, p1 in zip(pts[:-1], pts[1:]):
        t0, t1 = max(p0["dte"], 1e-3) / 365, p1["dte"] / 365
        v = p1["atm"] ** 2 * t1 - p0["atm"] ** 2 * t0
        p1["fwd"] = round(float(np.sqrt(v / (t1 - t0))), 5) if v > 0 and t1 > t0 else None
    if pts:
        pts[0]["fwd"] = pts[0]["atm"]
    _mark_events(pts)
    return pts


def _mark_events(pts: list[dict]) -> None:
    """Movimiento de evento que descuenta cada tramo de la estructura temporal (el "codo" de la curva): varianza
    forward del tramo por encima de la normal (mediana de los tramos hasta EVENT_HORIZON dias), por la duracion del
    tramo. Solo se marca si la varianza forward supera EVENT_RATIO veces la normal. Es el movimiento de un dia que
    el mercado paga de mas en ese tramo (resultados, FOMC...), no una prediccion."""
    fv, prev = [], (0.0, 0.0)
    for p in pts:
        t, w = p["dte"] / 365, p["atm"] ** 2 * p["dte"] / 365
        fv.append((w - prev[1]) / (t - prev[0]) if t > prev[0] else None)
        prev = (t, w)
    base = [v for v, p in zip(fv, pts) if v is not None and v > 0 and p["dte"] <= EVENT_HORIZON]
    if len(base) < 4:
        return
    norm = float(np.median(base))
    t0 = 0.0
    for i, (v, p) in enumerate(zip(fv, pts)):
        t = p["dte"] / 365
        # codo: por encima de la normal y de al menos uno de los tramos vecinos (una curva solo invertida no cuenta)
        nb = [fv[j] for j in (i - 1, i + 1) if 0 <= j < len(fv) and fv[j] is not None]
        local = max(norm, min(nb)) if nb else norm
        if v is not None and v > EVENT_RATIO * local and 1 <= p["dte"] <= EVENT_HORIZON:
            p["event"] = round(float(np.sqrt((v - norm) * (t - t0))), 5)
        t0 = t


def _yang_zhang(o, h, l, c, prev_c) -> float | None:
    """Volatilidad realizada de Yang-Zhang (anualizada): salto de apertura + intradia de Rogers-Satchell. Usa
    apertura, maximo y minimo, asi que con pocas sesiones es mas precisa que la de cierre a cierre."""
    n = len(c)
    if n < 5:
        return None
    ro = np.log(o / prev_c)
    rc = np.log(c / o)
    rs = np.log(h / c) * np.log(h / o) + np.log(l / c) * np.log(l / o)
    k = 0.34 / (1.34 + (n + 1) / (n - 1))
    v = ro.var(ddof=1) + k * rc.var(ddof=1) + (1 - k) * rs.mean()
    return float(np.sqrt(v * 252)) if v > 0 else None


def realized(sym: str) -> dict | None:
    """Vol realizada de Yang-Zhang a varias ventanas y su cono del ultimo ano (min, p10, mediana, p90, max de la
    misma ventana movil), mas la de cierre a cierre a 20 dias. NDX y RUT usan su ETF (CBOE no da su historico)."""
    ohlc, src = g.history_ohlc(sym)
    rows = [v for _, v in sorted(ohlc.items())][-(CONE_DAYS + max(YZ_WINDOWS) + 1):]
    if len(rows) < 30:
        return None
    a = np.array(rows, dtype=float)
    o, h, l, c = a[1:, 0], a[1:, 1], a[1:, 2], a[1:, 3]
    pc = a[:-1, 3]
    ok = (o > 0) & (h >= l) & (l > 0) & (pc > 0)
    o, h, l, c, pc = o[ok], h[ok], l[ok], c[ok], pc[ok]
    now, cone, cc = {}, {}, {}
    lr = np.log(c / pc)
    for n in YZ_WINDOWS:
        if len(c) < n:
            continue
        now[str(n)] = _yang_zhang(o[-n:], h[-n:], l[-n:], c[-n:], pc[-n:])
        cc[str(n)] = round(float(lr[-n:].std(ddof=1) * np.sqrt(252)), 5)
        roll = [_yang_zhang(o[i - n:i], h[i - n:i], l[i - n:i], c[i - n:i], pc[i - n:i])
                for i in range(max(n, len(c) - CONE_DAYS), len(c) + 1)]
        roll = [x for x in roll if x]
        if len(roll) >= 20:
            cone[str(n)] = [round(float(x), 5) for x in np.percentile(roll, [0, 10, 50, 90, 100])]
    return {"proxy": src, "windows": YZ_WINDOWS, "yz": {k: round(v, 5) for k, v in now.items() if v},
            "cc": cc, "cone": cone, "days": int(min(len(c), CONE_DAYS))}


def _at_dte(pts: list[dict], key: str, dte: float) -> float | None:
    xy = [(p["dte"], p[key]) for p in pts if p.get(key) is not None]
    if len(xy) < 2 or not xy[0][0] <= dte <= xy[-1][0]:
        return None
    return float(np.interp(dte, [x for x, _ in xy], [y for _, y in xy]))


def iv30_model_free(pts: list[dict]) -> float | None:
    """IV a 30 dias sin modelo como el VIX: varianza total interpolada entre los vencimientos que rodean los 30
    dias (el primero con al menos 7)."""
    xs = [p for p in pts if p.get("mf") and p["dte"] >= 7]
    lo = [p for p in xs if p["dte"] <= 30]
    hi = [p for p in xs if p["dte"] > 30]
    if not lo or not hi:
        return None
    a, b = lo[-1], hi[0]
    w = (b["dte"] - 30) / (b["dte"] - a["dte"])
    v = (a["mf"] ** 2 * a["dte"] * w + b["mf"] ** 2 * b["dte"] * (1 - w)) / 30
    return round(float(np.sqrt(v)), 5)


def summary(term: list[dict], rv: dict | None) -> dict:
    """Lecturas de la superficie para la cabecera del panel."""
    iv30 = iv30_model_free(term)
    atm30 = _at_dte(term, "atm", 30)
    a7, a90 = _at_dte(term, "atm", 7), _at_dte(term, "atm", 90)
    yz20 = (rv or {}).get("yz", {}).get("20")
    cc20 = (rv or {}).get("cc", {}).get("20")
    ref = iv30 or atm30
    ev = max((p for p in term if p.get("event")), key=lambda p: p["event"], default=None)
    rnd = lambda v: None if v is None else round(v, 5)  # noqa: E731
    # prima de varianza frente a la de cierre a cierre: Yang-Zhang apenas cuenta un dia que abre en maximos y cierra
    # en minimos (lo toma por tendencia), y eso es justo lo que una opcion tiene que pagar
    return {"iv30": iv30, "atm30": rnd(atm30), "atm7": rnd(a7), "atm90": rnd(a90),
            "rr25": rnd(_at_dte(term, "rr25", 30)), "bf25": rnd(_at_dte(term, "bf25", 30)),
            "rv20": yz20, "cc20": cc20, "vrp": rnd(ref - cc20) if ref and cc20 else None,
            "event": {"exp": ev["exp"], "move": ev["event"]} if ev else None}


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
    ch = {"K": snap["K"], "call": snap["call"], "exp": snap["exp"], "iv": snap["iv"], "oi": snap["oi"],
          **({"fwd": snap["fwd"]} if "fwd" in snap else {})}
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
        raise LookupError("No expirations with implied volatility")
    today = g.now_ny().strftime("%Y-%m-%d")
    snap = grid_snapshot(sm, spot)
    h = history(sym, today, snap if save and g.is_trading_day(now) else None)
    p1, p5 = _prev_days(now)
    prev = {}
    for key, day in (("1d", p1), ("1w", p5)):
        ps, pspot = _snapshot_smiles(sym, day, now)
        if ps:
            prev[key] = {"date": day, "spot": pspot, "smiles": ps, "term": term_structure(ps, pspot)}
    term = term_structure(sm, spot)
    rv = None
    if sym not in g.CBOE_VOL_INDICES:   # las opciones del VIX van sobre el futuro: la realizada del indice no compara
        try:
            rv = realized(sym)
        except Exception:  # noqa: BLE001  (sin historico de precios el resto del panel sigue)
            rv = None
    return {
        "symbol": sym, "name": g.name_of(sym), "spot": spot, "generado": now.strftime("%Y-%m-%d %H:%M ET"),
        "timestamp": ch["timestamp"], "smiles": sm, "term": term, "prev": prev,
        "realized": rv, "summary": summary(term, rv),
        "matrix": matrix(sm, (prev.get("1d") or {}).get("smiles", []), spot),
        "bands": bands(h, today), "tenors": TENORS, "deltas": DELTAS, "term_grid": TERM_GRID,
    }
