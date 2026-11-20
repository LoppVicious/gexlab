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
