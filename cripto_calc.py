"""GEX Lab - calculo de la seccion Crypto (BTC y ETH), sin red.

Lo usa cripto.py (descarga y publica) y lo prueba pruebas/test_cripto.py. Diseno en docs/CRIPTO.md.

GEX con la metodologia del motor Perfil: IV de cada contrato, tiempo natural con minimo de 1 h, gamma de
Black-76 sobre el forward de cada vencimiento (r = q = 0). Las opciones de Deribit son inversas (prima en la
moneda), pero su valor en USD es el de una opcion lineal: la gamma en USD es la de Black-Scholes. Contrato = 1
unidad de la moneda.
"""
from __future__ import annotations

import math
from datetime import datetime, timezone

import numpy as np

from gex_engine import bs_gamma

MESES = {m: i + 1 for i, m in enumerate("JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC".split())}
ANIO_S = 365.0 * 86400
MIN_T = 1.0 / (365 * 24)      # una hora, como el motor Perfil
PERFIL_SPAN = 0.25            # perfil de GEX en +-25 % del spot
PERFIL_PUNTOS = 201
FLIP_SPAN = 0.15              # el flip se busca en +-15 %
MURO_SPAN = 0.20              # Call Wall y Put Wall en +-20 %
BARRAS_SPAN = 0.30            # barras por strike que viajan a la web
FILTROS = {"7": 7, "30": 30, "all": None}
VENC_GRANDE = 0.10            # vencimiento "grande": al menos el 10 % del nocional total

# Umbrales de la lectura (docs/CRIPTO.md). Tono: +1 alcista, -1 bajista.
UMBRALES = {
    "mvrv_bajo": 1.0, "mvrv_alto": 3.0,
    "funding_alto": 30.0, "funding_tenso": 15.0,      # % anualizado
    "fng_miedo": 20, "fng_codicia": 80,
    "lsr_alto": 2.5, "lsr_bajo": 1.0,                  # cuentas largas / cortas
    "rr_puts": -3.0, "rr_calls": 3.0,                  # risk reversal 25 delta a ~30 dias, puntos de vol
    "vrp_cara": 10.0, "vrp_barata": 0.0,               # DVOL - RV30, puntos
    "tendencia_30d": 10.0,                             # % de cambio a 30 dias
    "flujo_ex_pct": 0.5,                               # flujo neto 7 d frente al saldo en exchanges, %
    "actividad_pct": 10.0,                             # direcciones activas (30 d) frente a su media de 365 d, %
    "puell_bajo": 0.5, "puell_alto": 3.0,
    "stables_pct": 3.0,                                # cambio de la oferta de stablecoins en 30 dias, %
    # senales con su historia
    "vrp_senal": 20.0,                                 # DVOL - RV30, puntos
    "oi_flush": 15.0,                                  # caida del OI de OKX en 7 dias, %
    "lsr_senal": 3.0,                                  # cuentas largas / cortas en OKX
    "rr_senal": -8.0,                                  # risk reversal 25 delta a 30 dias, puntos
}


# ---------------------------------------------------------------- utilidades
def _f(v):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def percentil(serie, valor) -> float | None:
    """Percentil (0-100) de `valor` dentro de `serie` (fraccion de valores menores o iguales)."""
    xs = [x for x in (_f(s) for s in serie) if x is not None]
    if not xs or valor is None:
        return None
    return round(100.0 * sum(1 for x in xs if x <= valor) / len(xs), 1)


def vencimiento(code: str) -> datetime:
    """'24SEP27' o '4DEC26' -> 08:00 UTC de ese dia (liquidacion de Deribit)."""
    d, m, y = int(code[:-5]), MESES[code[-5:-2]], 2000 + int(code[-2:])
    return datetime(y, m, d, 8, 0, tzinfo=timezone.utc)


def _norm_cdf(x):
    return 0.5 * (1.0 + np.vectorize(math.erf)(np.asarray(x, dtype=float) / math.sqrt(2.0)))


# ---------------------------------------------------------------- cadena de Deribit
def cadena(rows: list[dict], ahora: datetime) -> dict:
    """Book summary de opciones de Deribit -> arrays. Descarta vencidos, sin IV o sin forward."""
    K, C, E, OI, IV, F, VOL = [], [], [], [], [], [], []
    for r in rows:
        partes = str(r.get("instrument_name", "")).split("-")
        if len(partes) != 4 or partes[3] not in ("C", "P"):
            continue
        try:
            exp = vencimiento(partes[1])
            k = float(partes[2].replace("d", "."))
        except (KeyError, ValueError):
            continue
        iv, fw = _f(r.get("mark_iv")), _f(r.get("underlying_price"))
        if exp <= ahora or not iv or iv <= 1 or not fw or fw <= 0:
            continue
        K.append(k); C.append(partes[3] == "C"); E.append(exp.timestamp())
        OI.append(_f(r.get("open_interest")) or 0.0); IV.append(iv / 100.0); F.append(fw)
        VOL.append(_f(r.get("volume")) or 0.0)
    a = lambda x, t=float: np.array(x, dtype=t)  # noqa: E731
    T = np.maximum((a(E) - ahora.timestamp()) / ANIO_S, MIN_T) if E else a([])
    return {"K": a(K), "call": a(C, bool), "exp": a(E), "oi": a(OI), "iv": a(IV), "F": a(F), "T": T, "vol": a(VOL)}


def _sub(ch: dict, m: np.ndarray) -> dict:
    return {k: v[m] for k, v in ch.items()}


def filtro(ch: dict, ahora: datetime, dias) -> dict:
    if dias is None:
        return ch
    return _sub(ch, ch["exp"] <= ahora.timestamp() + dias * 86400)


def max_pain(K, call, oi) -> float | None:
    """Strike de liquidacion que minimiza lo que cobran los compradores de opciones."""
    if K.size == 0 or oi.sum() <= 0:
        return None
    cand = np.unique(K)
    pago = [float(np.sum(np.where(call, np.maximum(x - K, 0), np.maximum(K - x, 0)) * oi)) for x in cand]
    return float(cand[int(np.argmin(pago))])


def gex(ch: dict, spot: float) -> dict:
    """Perfil de GEX ($ por 1 % de movimiento), barras por strike, flip y muros. `ch` ya filtrada."""
    m = ch["oi"] > 0
    K, Cc, OI, IV, F, T = ch["K"][m], ch["call"][m], ch["oi"][m], ch["iv"][m], ch["F"][m], ch["T"][m]
    if K.size == 0:
        return {"total": 0.0, "xs": [], "perfil": [], "barras": [], "flip": None, "call_wall": None, "put_wall": None}
    sign = np.where(Cc, 1.0, -1.0)
    rel = F / spot   # el forward de cada vencimiento se mueve en proporcion al spot

    def g_en(x):
        fx = rel * x
        return sign * OI * bs_gamma(fx, K, T, IV, r=0.0) * fx * fx * 0.01

    g0 = g_en(spot)
    xs = np.linspace(spot * (1 - PERFIL_SPAN), spot * (1 + PERFIL_SPAN), PERFIL_PUNTOS)
    perfil = np.array([g_en(x).sum() for x in xs])

    # flip: cruce por cero mas cercano al spot dentro de +-15 %
    flip = None
    dentro = np.abs(xs / spot - 1) <= FLIP_SPAN
    cruces = [i for i in range(len(xs) - 1) if dentro[i] and dentro[i + 1] and perfil[i] * perfil[i + 1] < 0]
    if cruces:
        i = min(cruces, key=lambda j: abs(xs[j] - spot))
        a, b = perfil[i], perfil[i + 1]
        flip = float(xs[i] + (xs[i + 1] - xs[i]) * a / (a - b))

    ks = np.unique(K)
    gc = np.array([g0[(K == k) & Cc].sum() for k in ks])
    gp = np.array([g0[(K == k) & ~Cc].sum() for k in ks])
    cw = pw = None
    arriba = (ks > spot) & (ks <= spot * (1 + MURO_SPAN))
    abajo = (ks < spot) & (ks >= spot * (1 - MURO_SPAN))
    if arriba.any() and gc[arriba].max() > 0:
        cw = float(ks[arriba][int(np.argmax(gc[arriba]))])
    if abajo.any() and gp[abajo].min() < 0:
        pw = float(ks[abajo][int(np.argmin(gp[abajo]))])
    vis = np.abs(ks / spot - 1) <= BARRAS_SPAN
    return {
        "total": round(float(g0.sum())),
        "xs": [round(float(x), 2) for x in xs],
        "perfil": [round(float(v)) for v in perfil],
        "barras": [[float(k), round(float(c)), round(float(p))] for k, c, p in zip(ks[vis], gc[vis], gp[vis])],
        "flip": round(flip, 2) if flip else None,
        "call_wall": cw, "put_wall": pw,
    }


def vencimientos(ch: dict, ahora: datetime, spot: float) -> list[dict]:
    """Por vencimiento: dias, OI y nocional (USD), put/call de OI, max pain."""
    out = []
    total = float((ch["oi"] * spot).sum()) or 1.0
    for e in np.unique(ch["exp"]):
        m = ch["exp"] == e
        oi_c, oi_p = float(ch["oi"][m & ch["call"]].sum()), float(ch["oi"][m & ~ch["call"]].sum())
        if oi_c + oi_p <= 0:
            continue
        nocional = (oi_c + oi_p) * spot
        out.append({
            "exp": datetime.fromtimestamp(float(e), timezone.utc).strftime("%Y-%m-%d"),
            "dias": round((float(e) - ahora.timestamp()) / 86400, 2),
            "oi": round(oi_c + oi_p, 1), "nocional": round(nocional),
            "pcr": round(oi_p / oi_c, 2) if oi_c else None,
            "max_pain": max_pain(ch["K"][m], ch["call"][m], ch["oi"][m]),
            "grande": nocional / total >= VENC_GRANDE,
        })
    return out


def _iv_en_delta(d, iv, objetivo):
    """IV interpolada en una delta objetivo (d ordenable, monotona dentro de la pata)."""
    o = np.argsort(d)
    d, iv = d[o], iv[o]
    if d.size < 2 or not (d[0] <= objetivo <= d[-1]):
        return None
    return float(np.interp(objetivo, d, iv))


def estructura(ch: dict, ahora: datetime) -> list[dict]:
    """Por vencimiento: IV ATM (en el forward), risk reversal y butterfly de 25 delta, en puntos de vol."""
    out = []
    for e in np.unique(ch["exp"]):
        m = ch["exp"] == e
        K, Cc, IV, F, T = ch["K"][m], ch["call"][m], ch["iv"][m], ch["F"][m], ch["T"][m]
        fw = float(np.median(F))
        otm = np.where(Cc, K >= fw, K <= fw)
        if otm.sum() < 4:
            continue
        K, Cc, IV, T = K[otm], Cc[otm], IV[otm], T[otm]
        o = np.argsort(K)
        atm = float(np.interp(fw, K[o], IV[o])) if K.min() <= fw <= K.max() else None
        d1 = (np.log(fw / K) + 0.5 * IV * IV * T) / (IV * np.sqrt(T))
        dc = _norm_cdf(d1)
        c25 = _iv_en_delta(dc[Cc], IV[Cc], 0.25)
        p25 = _iv_en_delta(dc[~Cc] - 1.0, IV[~Cc], -0.25)
        fila = {"exp": datetime.fromtimestamp(float(e), timezone.utc).strftime("%Y-%m-%d"),
                "dias": round((float(e) - ahora.timestamp()) / 86400, 2), "fwd": round(fw, 2),
                "atm": round(atm * 100, 2) if atm else None, "rr25": None, "bf25": None}
        if c25 and p25:
            fila["rr25"] = round((c25 - p25) * 100, 2)
            if atm:
                fila["bf25"] = round(((c25 + p25) / 2 - atm) * 100, 2)
        out.append(fila)
    return out


def a_plazo(filas: list[dict], campo: str, dias: float = 30.0):
    """Valor interpolado a `dias` (los vencimientos de menos de 2 dias se ignoran)."""
    p = [(f["dias"], f[campo]) for f in filas if f.get(campo) is not None and f["dias"] >= 2]
    if not p:
        return None
    xs, ys = zip(*sorted(p))
    if dias <= xs[0]:
        return round(ys[0], 2)
    if dias >= xs[-1]:
        return round(ys[-1], 2)
    return round(float(np.interp(dias, xs, ys)), 2)


def vol_realizada(cierres: list[float], n: int = 30) -> float | None:
    """Volatilidad realizada anualizada (365 dias) de los ultimos n rendimientos diarios, en %."""
    c = [x for x in (_f(v) for v in cierres) if x and x > 0]
    if len(c) < n + 1:
        return None
    r = np.diff(np.log(np.array(c[-(n + 1):])))
    return round(float(r.std(ddof=1) * math.sqrt(365) * 100), 2)


def basis(futuros: list[dict], indice: float, ahora: datetime) -> list[dict]:
    """Basis anualizada de los futuros con vencimiento de Deribit (el perpetuo va aparte)."""
    out = []
    for r in futuros:
        n = str(r.get("instrument_name", ""))
        partes = n.split("-")
        mark = _f(r.get("mark_price"))
        if len(partes) != 2 or partes[1] == "PERPETUAL" or not mark or not indice:
            continue
        try:
            exp = vencimiento(partes[1])
        except (KeyError, ValueError):
            continue
        dias = (exp - ahora).total_seconds() / 86400
        if dias < 3:   # a pocos dias la anualizacion no significa nada
            continue
        prima = mark / indice - 1
        out.append({"exp": exp.strftime("%Y-%m-%d"), "dias": round(dias, 1), "prima": round(prima * 100, 3),
                    "anual": round(prima * 365 / dias * 100, 2), "oi_usd": round(_f(r.get("open_interest")) or 0)})
    return sorted(out, key=lambda x: x["dias"])


# ---------------------------------------------------------------- on-chain (CoinMetrics y bitcoin-data)
def onchain(filas: list[dict], spot: float | None, sth=None, lth=None) -> dict | None:
    """Filas diarias de CoinMetrics (PriceUSD, CapMrktCurUSD, CapMVRVCur, SplyCur, FlowInExUSD, FlowOutExUSD,
    SplyExNtv) -> realized price, MVRV en directo y su percentil desde 2015, flujos de exchanges.
    `sth`/`lth`: series [[fecha, precio]] de bitcoin-data (solo BTC)."""
    serie = []
    for r in filas:
        cap, mvrv, sply = _f(r.get("CapMrktCurUSD")), _f(r.get("CapMVRVCur")), _f(r.get("SplyCur"))
        if not cap or not mvrv or not sply:
            continue
        serie.append({"d": str(r["time"])[:10], "precio": _f(r.get("PriceUSD")), "rp": cap / mvrv / sply,
                      "mvrv": mvrv, "fin": _f(r.get("FlowInExUSD")), "fout": _f(r.get("FlowOutExUSD")),
                      "saldo": _f(r.get("SplyExNtv"))})
    if not serie:
        return None
    u = serie[-1]
    mv_hist = [s["mvrv"] for s in serie if s["d"] >= "2015-01-01"]
    mvrv_vivo = spot / u["rp"] if spot else u["mvrv"]
    flujo = [(s["fin"] or 0) - (s["fout"] or 0) for s in serie[-7:] if s["fin"] is not None and s["fout"] is not None]
    saldo = [s["saldo"] for s in serie if s["saldo"] is not None]
    out = {
        "fecha": u["d"], "rp": round(u["rp"], 2), "mvrv": round(mvrv_vivo, 3), "mvrv_cierre": round(u["mvrv"], 3),
        "mvrv_pct": percentil(mv_hist, mvrv_vivo),
        "flujo7": round(sum(flujo)) if len(flujo) == 7 else None,
        "saldo_ex": round(saldo[-1]) if saldo else None,
        "saldo_chg30": round((saldo[-1] / saldo[-31] - 1) * 100, 2) if len(saldo) > 30 and saldo[-31] else None,
        # dos anos para el grafico de precio frente a realized price
        "serie": [[s["d"], round(s["precio"], 2) if s["precio"] else None, round(s["rp"], 2)] for s in serie[-730:]],
    }
    if out["flujo7"] is not None and out["saldo_ex"] and spot:
        out["flujo7_pct"] = round(out["flujo7"] / (out["saldo_ex"] * spot) * 100, 3)
    for nombre, s in (("sth", sth), ("lth", lth)):
        if s:
            out[nombre] = {"fecha": s[-1][0], "valor": round(s[-1][1], 2)}
            out[nombre + "_serie"] = [[d, round(v, 2)] for d, v in s[-730:]]
    return out


# ---------------------------------------------------------------- fase 2: mineros, beneficio, actividad, liquidez
def _sma(xs: list, n: int) -> list:
    """Media movil simple; None hasta tener n valores."""
    out, acc = [], 0.0
    for i, x in enumerate(xs):
        acc += x
        if i >= n:
            acc -= xs[i - n]
        out.append(acc / n if i >= n - 1 else None)
    return out


def _cm(filas: list[dict], campo: str) -> tuple[list[str], list[float]]:
    d, v = [], []
    for r in filas:
        x = _f(r.get(campo))
        if x is not None:
            d.append(str(r["time"])[:10]); v.append(x)
    return d, v


def _racha(xs: list[bool]) -> int:
    """Dias seguidos al final de la lista con el mismo valor que el ultimo."""
    n = 0
    for x in reversed(xs):
        if x != xs[-1]:
            break
        n += 1
    return n


def mineros(filas: list[dict]) -> dict | None:
    """Hash ribbons (media de 30 dias del hashrate frente a la de 60) y multiplo de Puell (emision diaria en USD
    frente a su media de 365 dias). CoinMetrics: HashRate en TH/s, IssTotUSD."""
    d, h = _cm(filas, "HashRate")
    di, iss = _cm(filas, "IssTotUSD")
    if len(h) < 400 or len(iss) < 400:
        return None
    s30, s60 = _sma(h, 30), _sma(h, 60)
    ok = [i for i in range(len(h)) if s60[i] is not None]
    bajo = [s30[i] < s60[i] for i in ok]
    compra = None   # ultimo cruce al alza tras al menos 10 dias por debajo
    for j in range(len(ok) - 1, 10, -1):
        if not bajo[j] and all(bajo[j - 10:j]):
            compra = d[ok[j]]
            break
    m365 = _sma(iss, 365)
    puell = [(di[i], iss[i] / m365[i]) for i in range(len(iss)) if m365[i]]
    estado = "capitulation" if bajo[-1] else (
        "recovery" if compra and (datetime.fromisoformat(d[-1]) - datetime.fromisoformat(compra)).days <= 30 else "healthy")
    ph = {x: v for x, v in puell}
    return {
        "fecha": d[-1], "hash": round(h[-1] / 1e6, 1), "hash30": round(s30[-1] / 1e6, 1), "hash60": round(s60[-1] / 1e6, 1),
        "estado": estado, "dias": _racha(bajo), "ultima_compra": compra,
        "puell": round(puell[-1][1], 3), "puell_pct": percentil([v for _, v in puell], puell[-1][1]),
        # hashrate en EH/s (CoinMetrics da TH/s)
        "serie": [[d[i], round(s30[i] / 1e6, 1), round(s60[i] / 1e6, 1),
                   round(ph[d[i]], 3) if d[i] in ph else None] for i in ok[-730:]],
    }


def beneficio(sopr=None, sth_sopr=None) -> dict | None:
    """SOPR (todas las monedas) y STH-SOPR (menos de 155 dias) de bitcoin-data, media de 7 dias. > 1: se vende con
    beneficio; < 1: con perdida."""
    out = {}
    for nombre, s in (("sopr", sopr), ("sth_sopr", sth_sopr)):
        if not s or len(s) < 30:
            continue
        v = [x for _, x in s]
        m7 = _sma(v, 7)
        out[nombre] = {"fecha": s[-1][0], "valor": round(v[-1], 4), "m7": round(m7[-1], 4),
                       "pct": percentil(v, v[-1]), "dias": _racha([x is not None and x < 1 for x in m7]),
                       "bajo": m7[-1] < 1}
        out[nombre + "_serie"] = [[s[i][0], round(m7[i], 4)] for i in range(len(s)) if m7[i] is not None][-365:]
    return out or None


def actividad(filas: list[dict]) -> dict | None:
    """Direcciones activas y transacciones: media de 30 dias frente a la de 365, percentil desde 2015."""
    d, a = _cm(filas, "AdrActCnt")
    if len(a) < 400:
        return None
    a30, a365 = _sma(a, 30), _sma(a, 365)
    out = {"fecha": d[-1], "dir30": round(a30[-1]), "dir_chg": round((a30[-1] / a365[-1] - 1) * 100, 2),
           "dir_pct": percentil([x for x, f in zip(a30, d) if x and f >= "2015-01-01"], a30[-1]),
           "serie": [[d[i], round(a30[i]), round(a365[i]) if a365[i] else None] for i in range(len(d)) if a30[i]][-730:]}
    dt, t = _cm(filas, "TxCnt")
    if len(t) >= 400:
        t30, t365 = _sma(t, 30), _sma(t, 365)
        out.update(tx30=round(t30[-1]), tx_chg=round((t30[-1] / t365[-1] - 1) * 100, 2))
    return out


def liquidez(pegged: list[dict], chart: list | None) -> dict | None:
    """Stablecoins de DefiLlama: total y cambios a 7 y 30 dias; las 5 mayores."""
    filas = []
    for p in pegged or []:
        c = _f((p.get("circulating") or {}).get("peggedUSD"))
        if not c:
            continue
        w = _f((p.get("circulatingPrevWeek") or {}).get("peggedUSD"))
        m = _f((p.get("circulatingPrevMonth") or {}).get("peggedUSD"))
        filas.append({"sym": p.get("symbol"), "nombre": p.get("name"), "total": c,
                      "c7": round((c / w - 1) * 100, 2) if w else None, "c30": round((c / m - 1) * 100, 2) if m else None,
                      "_w": w or c, "_m": m or c})
    if not filas:
        return None
    tot = sum(f["total"] for f in filas)
    tw, tm = sum(f["_w"] for f in filas), sum(f["_m"] for f in filas)
    top = sorted(filas, key=lambda f: -f["total"])[:5]
    for f in top:
        f.pop("_w"); f.pop("_m")
        f["cuota"] = round(f["total"] / tot * 100, 1)
    out = {"total": round(tot), "c7": round((tot / tw - 1) * 100, 2), "c30": round((tot / tm - 1) * 100, 2), "top": top}
    if chart:
        out["serie"] = [x for x in chart if x[1]][-365:]
    return out


# ---------------------------------------------------------------- fase 3: senales con su historia
HORIZONTES = (30, 90)
ENFRIAMIENTO = 30   # dias minimos entre dos casos de la misma senal


def backtest(fechas: list[str], precios: list[float], activa: list, previo: int = 0) -> dict:
    """Casos: primer dia en que `activa` es cierta, tras al menos `previo` dias sin serlo (y `ENFRIAMIENTO` desde el
    caso anterior). Para cada horizonte, rendimiento del precio desde el cierre del caso, y la referencia: todos los dias
    del mismo periodo (desde el primer dia con dato de la senal)."""
    n = len(fechas)
    ini = next((i for i, x in enumerate(activa) if x is not None), n)
    casos, ultimo = [], -10 ** 9
    for i in range(ini + 1, n):
        if not activa[i] or activa[i - 1]:
            continue
        atras = activa[max(ini, i - previo):i]
        if previo and (len(atras) < previo or any(atras)):
            continue
        if i - ultimo < ENFRIAMIENTO:
            continue
        casos.append(i)
        ultimo = i
    # hoy: solo en las senales de estado (sin `previo`); en las de cruce cuenta la fecha del ultimo caso
    out = {"desde": fechas[ini] if ini < n else None, "casos": [fechas[i] for i in casos],
           "tipo": "cruce" if previo else "estado",
           "hoy": bool(activa[-1]) if n and not previo and activa[-1] is not None else None,
           "ultima": fechas[casos[-1]] if casos else None, "h": {}}
    for h in HORIZONTES:
        r = [precios[i + h] / precios[i] - 1 for i in casos if i + h < n]
        base = [precios[i + h] / precios[i] - 1 for i in range(ini, n - h)]
        e = {"n": len(r)}
        if r:
            e.update(mediana=round(float(np.median(r)) * 100, 1), media=round(float(np.mean(r)) * 100, 1),
                     pos=round(100 * sum(1 for x in r if x > 0) / len(r)), peor=round(min(r) * 100, 1),
                     mejor=round(max(r) * 100, 1))
        if base:
            e.update(base_mediana=round(float(np.median(base)) * 100, 1),
                     base_pos=round(100 * sum(1 for x in base if x > 0) / len(base)))
        out["h"][str(h)] = e
    return out


def _alinear(fechas: list[str], serie) -> list:
    """Serie [[fecha, valor]] en el calendario `fechas` (None donde falta)."""
    m = {d: v for d, v in serie or []}
    return [m.get(d) for d in fechas]


def _vr30(precios: list[float]) -> list:
    """Volatilidad realizada a 30 dias (anualizada, %) de cada dia, con los cierres diarios."""
    r = np.diff(np.log(np.array(precios)))
    out = [None] * len(precios)
    for i in range(30, len(precios)):
        out[i] = float(r[i - 30:i].std(ddof=1) * math.sqrt(365) * 100)
    return out


def senales(filas: list[dict], sth=None, sth_sopr=None, fng=None, dvol=None, mineria: bool = True,
            funding=None, okx=None, hist=None, sym: str = "") -> list[dict]:
    """Senales de BTC o ETH con su historia en el precio diario de CoinMetrics. Cada una: id, grupo (onchain,
    derivados o sentimiento), nombre, que espera la lectura habitual (sentido +1 alcista, -1 bajista, 0 sin direccion)
    y su backtest. `mineria`: solo con prueba de trabajo (BTC; el hashrate de ETH es de antes del Merge).
    `funding`: [[fecha, % anual]] diario del perpetuo de Deribit; `okx`: {fecha: [oi_usd, long/short]};
    `hist`: fotos diarias propias (cripto/hist.json), para las senales sin historia publica."""
    fechas, precios = _cm(filas, "PriceUSD")
    if len(precios) < 400:
        return []
    out = []
    U = UMBRALES

    def add(id_, grupo, nombre, que, sentido, activa, previo=0, siempre=False):
        if not siempre and not any(x for x in activa if x):
            return
        out.append({"id": id_, "grupo": grupo, "nombre": nombre, "que": que, "sentido": sentido,
                    **backtest(fechas, precios, activa, previo)})

    mv = _alinear(fechas, [[str(r["time"])[:10], _f(r.get("CapMVRVCur"))] for r in filas])
    add("mvrv_bajo", "onchain", "MVRV under 1", "Price falls under the average cost of all coins (realized price).", 1,
        [None if x is None else x < 1 for x in mv])
    add("mvrv_alto", "onchain", "MVRV over 3", "Holders sit on three times their cost on average.", -1,
        [None if x is None else x > 3 for x in mv])
    if sth:
        s = _alinear(fechas, sth)
        sobre = [None if b is None else p > b for p, b in zip(precios, s)]
        add("sth_recupera", "onchain", "Price reclaims short-term holder cost",
            "First close above the short-term holder cost after 14 days or more below.", 1, sobre, 14)
        add("sth_pierde", "onchain", "Price loses short-term holder cost",
            "First close below the short-term holder cost after 14 days or more above.", -1,
            [None if x is None else not x for x in sobre], 14)
    d, h = _cm(filas, "HashRate") if mineria else ([], [])
    if len(h) >= 400:
        s30, s60 = _sma(h, 30), _sma(h, 60)
        arriba = {d[i]: s30[i] > s60[i] for i in range(len(h)) if s60[i] is not None}
        add("hash_compra", "onchain", "Hash ribbon buy",
            "The 30-day hashrate average crosses back over the 60-day after 10 days or more of miner capitulation.", 1,
            [arriba.get(x) for x in fechas], 10)
    di, iss = _cm(filas, "IssTotUSD") if mineria else ([], [])
    if len(iss) >= 400:
        m365 = _sma(iss, 365)
        pu = {di[i]: iss[i] / m365[i] < 0.5 for i in range(len(iss)) if m365[i]}
        add("puell_bajo", "onchain", "Puell multiple under 0.5",
            "Miner revenue falls to half its yearly average: miners under stress.", 1, [pu.get(x) for x in fechas])
    if sth_sopr:
        v = [x for _, x in sth_sopr]
        m7 = dict(zip([x for x, _ in sth_sopr], _sma(v, 7)))
        add("sth_sopr_recupera", "onchain", "Short-term SOPR back over 1",
            "The 7-day average of short-term holder SOPR goes back over 1 after 14 days or more of selling at a loss.", 1,
            [None if m7.get(x) is None else m7[x] > 1 for x in fechas], 14)
    if fng:
        f = _alinear(fechas, fng)
        add("miedo", "sentimiento", "Extreme fear (15 or less)", "Fear & Greed at 15 or less.", 1,
            [None if x is None else x <= 15 for x in f])
        add("codicia", "sentimiento", "Extreme greed (85 or more)", "Fear & Greed at 85 or more.", -1,
            [None if x is None else x >= 85 for x in f])

    # --- derivados
    if dvol and len(dvol) > 400:
        dv = [x for _, x in dvol]
        alto = {}
        for i in range(365, len(dv)):
            alto[dvol[i][0]] = dv[i] >= float(np.percentile(dv[i - 365:i], 90))
        add("dvol_alto", "derivados", "Implied volatility spike", "DVOL at the 90th percentile of its last year or higher.", 1,
            [alto.get(x) for x in fechas])
        rv = dict(zip(fechas, _vr30(precios)))
        dvm = dict(dvol)
        vrp = [None if dvm.get(x) is None or rv.get(x) is None else dvm[x] - rv[x] for x in fechas]
        add("vrp_negativo", "derivados", "Options cheap against realized",
            "DVOL under the 30-day realized volatility: the market moves more than options price.", 0,
            [None if x is None else x < 0 for x in vrp])
        add("vrp_alto", "derivados", "Options rich against realized",
            f"DVOL {U['vrp_senal']:.0f} points or more over the 30-day realized volatility: traders pay a large premium for protection.", 1,
            [None if x is None else x >= U["vrp_senal"] for x in vrp])
    if funding and len(funding) > 60:
        v = [x for _, x in funding]
        m7 = dict(zip([x for x, _ in funding], _sma(v, 7)))
        add("funding_negativo", "derivados", "Funding turns negative",
            "The 7-day average of perpetual funding (Deribit) goes under 0 after 14 days or more over it: shorts start paying longs.", 1,
            [None if m7.get(x) is None else m7[x] < 0 for x in fechas], 14)
        add("funding_alto", "derivados", f"Funding over {U['funding_alto']:.0f}% a year",
            f"The 7-day average of perpetual funding (Deribit) at {U['funding_alto']:.0f}% a year or more: crowded longs.", -1,
            [None if m7.get(x) is None else m7[x] >= U["funding_alto"] for x in fechas])
    if okx and len(okx) > 30:
        dias = sorted(okx)
        oi = {x: okx[x][0] for x in dias if okx[x][0]}
        pmap = dict(zip(fechas, precios))
        flush = {}
        for i, x in enumerate(dias):
            a, b = x, dias[i - 7] if i >= 7 else None
            if b and oi.get(a) and oi.get(b) and pmap.get(a) and pmap.get(b):
                flush[a] = oi[a] / oi[b] - 1 <= -U["oi_flush"] / 100 and pmap[a] < pmap[b]
        add("oi_flush", "derivados", "Leverage flush",
            f"OKX futures open interest down {U['oi_flush']:.0f}% or more in 7 days with price down: forced selling cleans out longs.", 1,
            [flush.get(x) for x in fechas], siempre=True)
        lsr = {x: okx[x][1] for x in dias if okx[x][1] is not None}
        add("lsr_alto", "derivados", f"Retail long {U['lsr_senal']:.0f} to 1 or more",
            f"{U['lsr_senal']:.0f} or more long accounts for each short on OKX.", -1,
            [None if lsr.get(x) is None else lsr[x] >= U["lsr_senal"] for x in fechas], siempre=True)
    if hist is not None:
        # sin historia publica: solo con nuestras fotos diarias desde que existen
        rr = {f: (h.get(sym) or {}).get("rr25_30") for f, h in hist.items()}
        gx = {f: (h.get(sym) or {}).get("gex") for f, h in hist.items()}
        add("puts_caras", "derivados", f"Puts {abs(U['rr_senal']):.0f} vol points over calls",
            f"30-day 25-delta risk reversal at {U['rr_senal']:.0f} or lower: protection in heavy demand.", 1,
            [None if rr.get(x) is None else rr[x] <= U["rr_senal"] for x in fechas], siempre=True)
        add("gex_negativo", "derivados", "Dealers short gamma",
            "Net GEX of Deribit options below zero: dealer hedging amplifies moves.", -1,
            [None if gx.get(x) is None else gx[x] < 0 for x in fechas], siempre=True)
    for s in out:   # sin dato aun: desde la primera foto propia
        if s["desde"] is None and hist:
            s["desde"] = min(hist)
    return out


def _r(v, dec):
    return None if v is None else round(v, dec)


def series_largas(filas: list[dict], sth=None, lth=None, sopr=None, sth_sopr=None, dvol=None, funding=None,
                  okx=None, mineria: bool = True) -> dict:
    """Historias diarias en columnas sobre el calendario de CoinMetrics (pub/cripto_series.json): la web las usa
    para ampliar los graficos y para los casos de cada senal. None donde no hay dato."""
    fechas, precios = _cm(filas, "PriceUSD")
    if not fechas:
        return {}
    col = lambda serie, dec: [_r(v, dec) for v in _alinear(fechas, serie)]  # noqa: E731
    rp = []
    for r in filas:
        cap, mv, sp = _f(r.get("CapMrktCurUSD")), _f(r.get("CapMVRVCur")), _f(r.get("SplyCur"))
        if cap and mv and sp and r.get("PriceUSD") is not None:
            rp.append([str(r["time"])[:10], cap / mv / sp])
    mvrv = [[str(r["time"])[:10], _f(r.get("CapMVRVCur"))] for r in filas]
    out = {"d": fechas, "precio": [_r(p, 2) for p in precios], "rp": col(rp, 2), "mvrv": col(mvrv, 3)}
    if mineria:
        d, h = _cm(filas, "HashRate")
        if h:
            s30, s60 = _sma(h, 30), _sma(h, 60)
            out["hash30"] = col([[d[i], s30[i] / 1e6] for i in range(len(d)) if s30[i]], 1)
            out["hash60"] = col([[d[i], s60[i] / 1e6] for i in range(len(d)) if s60[i]], 1)
        di, iss = _cm(filas, "IssTotUSD")
        if iss:
            m365 = _sma(iss, 365)
            out["puell"] = col([[di[i], iss[i] / m365[i]] for i in range(len(di)) if m365[i]], 3)
    for nombre, s, dec in (("sth", sth, 2), ("lth", lth, 2)):
        if s:
            out[nombre] = col(s, dec)
    for nombre, s in (("sopr", sopr), ("sth_sopr", sth_sopr)):
        if s:
            m7 = _sma([x for _, x in s], 7)
            out[nombre] = col([[s[i][0], m7[i]] for i in range(len(s)) if m7[i] is not None], 4)
    rv = _vr30(precios)
    out["rv30"] = [_r(v, 2) for v in rv]
    if dvol:
        out["dvol"] = col(dvol, 2)
        out["vrp"] = [None if a is None or b is None else round(a - b, 2) for a, b in zip(out["dvol"], rv)]
    if funding:
        m7 = _sma([x for _, x in funding], 7)
        out["funding"] = col([[funding[i][0], m7[i]] for i in range(len(funding)) if m7[i] is not None], 2)
    if okx:
        out["oi"] = col([[d, v[0]] for d, v in okx.items()], 0)
        out["lsr"] = col([[d, v[1]] for d, v in okx.items() if v[1] is not None], 2)
    d, a = _cm(filas, "AdrActCnt")
    _, t = _cm(filas, "TxCnt")
    if a:
        out["dir"] = col(list(zip(d, a)), 0)
    if t:
        out["tx"] = col(list(zip(_cm(filas, "TxCnt")[0], t)), 0)
    return out


def funding_diario(horas: list[dict]) -> list:
    """Funding horario de Deribit (`interest_1h`) -> [[fecha UTC, % anualizado del dia]], solo dias completos."""
    por = {}
    for h in horas:
        d = datetime.fromtimestamp(h["timestamp"] / 1000, timezone.utc).strftime("%Y-%m-%d")
        v = _f(h.get("interest_1h"))
        if v is not None:
            por.setdefault(d, []).append(v)
    return [[d, round(sum(v) * 365 * 100, 3)] for d, v in sorted(por.items()) if len(v) >= 23]


# ---------------------------------------------------------------- historial propio (una foto diaria)
CAMPOS_FOTO = ("spot", "gex", "flip", "atm30", "rr25_30", "bf25_30", "dvol", "rv30", "funding_7d", "oi_usd", "lsr", "pcr")


def foto(a: dict) -> dict:
    g, v, f = a["gex"]["all"], a["vol"], a["futuros"]
    return {"spot": a["spot"], "gex": g["total"], "flip": g["flip"], "atm30": v.get("atm30"), "rr25_30": v.get("rr25_30"),
            "bf25_30": v.get("bf25_30"), "dvol": v.get("dvol"), "rv30": v.get("rv30"), "funding_7d": f.get("funding_7d"),
            "oi_usd": f.get("oi_usd"), "lsr": f.get("lsr"), "pcr": a["oi"]["pcr"]}


def percentiles_propios(hist: dict, sym: str, actual: dict, minimo: int = 30) -> dict:
    """Percentil de cada campo de la foto de hoy frente a las fotos diarias guardadas (con `minimo` dias o mas)."""
    out = {}
    for c in CAMPOS_FOTO:
        serie = [h[sym][c] for h in hist.values() if (h.get(sym) or {}).get(c) is not None]
        if len(serie) >= minimo and actual.get(c) is not None:
            out[c] = percentil(serie, actual[c])
    return out


# ---------------------------------------------------------------- niveles y lectura
def niveles(spot: float, g: dict, oc: dict | None, venc: list[dict]) -> list[dict]:
    """Mapa de niveles on-chain y de opciones, de mayor a menor precio, con su distancia al spot."""
    nv = []
    add = lambda id_, nombre, p, tipo: p and nv.append(  # noqa: E731
        {"id": id_, "nombre": nombre, "precio": round(p, 2), "tipo": tipo, "dist": round((p / spot - 1) * 100, 2)})
    add("cw", "Call Wall", g.get("call_wall"), "opciones")
    add("flip", "Gamma flip", g.get("flip"), "opciones")
    add("pw", "Put Wall", g.get("put_wall"), "opciones")
    grande = next((v for v in venc if v["grande"] and v["dias"] >= 0.5), None)
    if grande:
        add("mp", f"Max pain {grande['exp'][5:]}", grande["max_pain"], "opciones")
    if oc:
        add("sth", "Short-term holder cost", (oc.get("sth") or {}).get("valor"), "onchain")
        add("rp", "Realized price", oc.get("rp"), "onchain")
        add("lth", "Long-term holder cost", (oc.get("lth") or {}).get("valor"), "onchain")
    return sorted(nv, key=lambda x: -x["precio"])


def _p(bloque, texto, tono, eje):
    return {"bloque": bloque, "texto": texto, "tono": tono, "eje": eje}


def _usd(x):
    a = abs(x)
    s = f"${a / 1e9:,.2f}B" if a >= 1e9 else f"${a / 1e6:,.0f}M" if a >= 1e6 else f"${a:,.0f}"
    return ("-" if x < 0 else "") + s


def _precio(x):
    return f"${x:,.0f}" if x >= 1000 else f"${x:,.2f}"


def lectura(a: dict, mercado: dict) -> dict:
    """Lectura por reglas en dos ejes: tendencia (estructura) y posicionamiento (contrarian). Textos en ingles."""
    U, pts = UMBRALES, []
    spot, g, vol, fut, oc = a["spot"], a["gex"]["all"], a["vol"], a["futuros"], a.get("onchain")
    fng = (mercado.get("fng") or {}).get("valor")

    # --- tendencia
    if oc and oc.get("sth"):
        sth = oc["sth"]["valor"]
        if spot > sth:
            pts.append(_p("On-chain", f"Price is above the short-term holder cost ({_precio(sth)}): recent buyers are in profit, the usual state of an uptrend. Dips toward that cost tend to be bought.", 1, "tendencia"))
        else:
            pts.append(_p("On-chain", f"Price is below the short-term holder cost ({_precio(sth)}): recent buyers are underwater, the usual state of a downtrend. Rallies toward that cost tend to meet selling from holders getting out at breakeven.", -1, "tendencia"))
    if g.get("flip"):
        if spot > g["flip"]:
            pts.append(_p("Gamma", f"Above the gamma flip ({_precio(g['flip'])}): dealers are long gamma and their hedging dampens moves.", 1, "tendencia"))
        else:
            pts.append(_p("Gamma", f"Below the gamma flip ({_precio(g['flip'])}): dealers are short gamma and their hedging amplifies moves.", -1, "tendencia"))
    c30 = a.get("chg30")
    if c30 is not None:
        t = 1 if c30 >= U["tendencia_30d"] else -1 if c30 <= -U["tendencia_30d"] else 0
        pts.append(_p("Price", f"{'+' if c30 >= 0 else ''}{c30:.1f}% over 30 days.", t, "tendencia"))

    # --- posicionamiento (contrarian: el exceso de un lado suele corregirse en su contra)
    if fng is not None:
        if fng <= U["fng_miedo"]:
            pts.append(_p("Sentiment", f"Fear & Greed at {fng}, extreme fear: historically closer to bottoms than to tops.", 1, "posicion"))
        elif fng >= U["fng_codicia"]:
            pts.append(_p("Sentiment", f"Fear & Greed at {fng}, extreme greed: the crowd is all in.", -1, "posicion"))
    fa = fut.get("funding_7d")
    if fa is not None:
        if fa < 0:
            pts.append(_p("Leverage", f"Perpetual funding is negative ({fa:+.1f}% a year, 7-day average): shorts pay to hold. Crowded shorts fuel squeezes.", 1, "posicion"))
        elif fa >= U["funding_alto"]:
            pts.append(_p("Leverage", f"Funding at {fa:.0f}% a year: longs pay a lot to stay in. Crowded longs are fuel for a flush.", -1, "posicion"))
        elif fa >= U["funding_tenso"]:
            pts.append(_p("Leverage", f"Funding at {fa:.0f}% a year: longs are getting crowded.", -1, "posicion"))
    lsr = fut.get("lsr")
    if lsr is not None:
        if lsr >= U["lsr_alto"]:
            pts.append(_p("Leverage", f"{lsr:.2f} long accounts for each short on OKX: retail leans long, which tends to be wrong at extremes.", -1, "posicion"))
        elif lsr <= U["lsr_bajo"]:
            pts.append(_p("Leverage", f"More short than long accounts on OKX ({lsr:.2f}): retail leans short.", 1, "posicion"))
    oi7, p7 = fut.get("oi_chg7"), a.get("chg7")
    if oi7 is not None and p7 is not None and abs(oi7) >= 5:
        txt = {(1, 1): "new longs are opening", (1, -1): "new shorts are pressing", (-1, 1): "shorts are covering", (-1, -1): "longs are closing"}[(1 if oi7 > 0 else -1, 1 if p7 >= 0 else -1)]
        pts.append(_p("Leverage", f"Open interest {oi7:+.0f}% over 7 days with price {p7:+.1f}%: {txt}.", 0, "posicion"))
    rr = vol.get("rr25_30")
    if rr is not None:
        if rr <= U["rr_puts"]:
            pts.append(_p("Options", f"30-day 25-delta puts trade {abs(rr):.1f} vol points over calls: traders pay up for protection.", 1, "posicion"))
        elif rr >= U["rr_calls"]:
            pts.append(_p("Options", f"30-day 25-delta calls trade {rr:.1f} vol points over puts: traders chase upside.", -1, "posicion"))
    vrp = vol.get("vrp")
    if vrp is not None:
        if vrp >= U["vrp_cara"]:
            pts.append(_p("Options", f"Implied volatility (DVOL {vol['dvol']:.0f}) is {vrp:.0f} points over 30-day realized: options are rich.", 0, "posicion"))
        elif vrp <= U["vrp_barata"]:
            pts.append(_p("Options", f"Implied volatility (DVOL {vol['dvol']:.0f}) is under 30-day realized ({vol['rv30']:.0f}): options are cheap for the moves the market is making.", 0, "posicion"))

    # --- on-chain de fondo (valoracion y flujos)
    if oc:
        mv = oc["mvrv"]
        if mv < U["mvrv_bajo"]:
            pts.append(_p("On-chain", f"MVRV at {mv:.2f}: price is under the average cost of all coins ({_precio(oc['rp'])}). Historically a zone of long-term value.", 1, "posicion"))
        elif mv > U["mvrv_alto"]:
            pts.append(_p("On-chain", f"MVRV at {mv:.2f}: holders sit on large unrealized gains, the zone of past cycle tops.", -1, "posicion"))
        fp = oc.get("flujo7_pct")
        if fp is not None and abs(fp) >= U["flujo_ex_pct"]:
            if fp < 0:
                pts.append(_p("On-chain", f"Net outflow from exchanges of {_usd(-oc['flujo7'])} over 7 days: coins moving to self-custody, a sign of accumulation.", 1, "posicion"))
            else:
                pts.append(_p("On-chain", f"Net inflow to exchanges of {_usd(oc['flujo7'])} over 7 days: coins moving to where they can be sold.", -1, "posicion"))

    # --- fase 2: beneficio de los holders recientes, actividad, mineros y liquidez
    be = a.get("beneficio") or {}
    ss = be.get("sth_sopr")
    if ss:
        if ss["m7"] >= 1:
            pts.append(_p("On-chain", f"Short-term holders sell at a profit (SOPR {ss['m7']:.3f}, 7-day average): demand absorbs their coins.", 1, "tendencia"))
        else:
            pts.append(_p("On-chain", f"Short-term holders sell at a loss (SOPR {ss['m7']:.3f}, 7-day average, {ss['dias']} days in a row): weak hands are leaving.", -1, "tendencia"))
    ac = a.get("actividad")
    if ac and abs(ac["dir_chg"]) >= U["actividad_pct"]:
        sube = ac["dir_chg"] > 0
        pts.append(_p("Network", f"Active addresses {ac['dir_chg']:+.0f}% over their yearly average (30-day average): network use {'growing' if sube else 'shrinking'}.", 1 if sube else -1, "tendencia"))
    mi = a.get("mineros")
    if mi:
        if mi["estado"] == "capitulation":
            pts.append(_p("Miners", f"Hash ribbons in capitulation for {mi['dias']} days: miners are switching off machines and selling. Past bottoms came as this ended.", 0, "posicion"))
        elif mi["estado"] == "recovery":
            pts.append(_p("Miners", f"Hash ribbon buy on {mi['ultima_compra']}: miner capitulation just ended.", 1, "posicion"))
        if mi["puell"] <= U["puell_bajo"]:
            pts.append(_p("Miners", f"Puell multiple at {mi['puell']:.2f}: miner revenue at a fraction of its yearly average, historically a value zone.", 1, "posicion"))
        elif mi["puell"] >= U["puell_alto"]:
            pts.append(_p("Miners", f"Puell multiple at {mi['puell']:.2f}: miners earn far above their yearly average, a zone of past tops.", -1, "posicion"))
    lq = mercado.get("liquidez")
    if lq and abs(lq["c30"]) >= U["stables_pct"]:
        sube = lq["c30"] > 0
        pts.append(_p("Liquidity", f"Stablecoin supply {lq['c30']:+.1f}% in 30 days: {'new money is coming in to buy' if sube else 'money is leaving the crypto market'}.", 1 if sube else -1, "posicion"))

    # --- senales con historia: las de los ultimos 30 dias o las que siguen activas hoy
    for s in a.get("senales") or []:
        if not (s.get("hoy") or (s.get("ultima") and s["ultima"] >= a.get("hace30", ""))):
            continue
        e = s["h"].get("90") or {}
        if e.get("n", 0) >= 3:
            txt = (f"{s['nombre']} ({'active' if s.get('hoy') else 'on ' + s['ultima']}). In {e['n']} past cases since "
                   f"{s['desde'][:4]}, price was higher 90 days later {e['pos']}% of the time (median {e['mediana']:+.0f}%, "
                   f"against {e['base_pos']}% and {e['base_mediana']:+.0f}% for any day).")
            tono = 1 if e["mediana"] > e["base_mediana"] and e["pos"] > e["base_pos"] else -1 if e["mediana"] < e["base_mediana"] and e["pos"] < e["base_pos"] else 0
        else:
            txt = f"{s['nombre']} ({'active' if s.get('hoy') else 'on ' + s['ultima']}): too few past cases to judge ({e.get('n', 0)})."
            tono = 0
        pts.append(_p("Signal", txt, tono, "senal"))

    tend = sum(p["tono"] for p in pts if p["eje"] == "tendencia")
    pos = sum(p["tono"] for p in pts if p["eje"] == "posicion")
    regimen = "Uptrend" if tend >= 2 else "Downtrend" if tend <= -2 else "No clear trend"
    posicion = ("Washed out" if pos >= 2 else "Leaning washed out" if pos == 1
                else "Crowded" if pos <= -2 else "Leaning crowded" if pos == -1 else "Balanced")
    especial = None
    if oc and fng is not None and oc["mvrv"] < U["mvrv_bajo"] and fng < U["fng_miedo"]:   # precio < realized price
        especial = "Capitulation zone"
    elif oc and (oc["mvrv"] > U["mvrv_alto"] or ((fa or 0) > U["funding_alto"] and (fng or 0) > U["fng_codicia"])):
        especial = "Overheated"
    if especial:
        resumen = especial
    elif tend <= -2 and pos >= 2:
        resumen = "Downtrend with sellers exhausted"
    elif tend >= 2 and pos <= -2:
        resumen = "Uptrend running hot"
    else:
        resumen = f"{regimen}, {posicion.lower()} positioning"
    return {"resumen": resumen, "tendencia": regimen, "posicion": posicion, "especial": especial,
            "tend": tend, "pos": pos, "puntos": pts}
