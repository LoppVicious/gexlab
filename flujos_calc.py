"""Calculos puros de la nota diaria de flujos (Takes estilo "flujos mecanicos"), sin red ni R2. Los usa
flujos_diario.py; pruebas en pruebas/test_flujos.py. Diseno en docs/FLUJOS.md.
Bloques: cobertura de los dealers por escenario (del motor), rebalanceo de ETFs apalancados, fondos de control de
volatilidad, CTAs (tendencia), strikes con mas puts y la asimetria total de los flujos mecanicos a +-5 %.
Todo lo que no es dato (AUM de vol-control, convencion de los dealers, reglas de los modelos) es un supuesto fijo y
va en MODELO para que cada fila de la serie diga con que version se calculo."""
from __future__ import annotations

import math

import numpy as np

from report_calc import ETF_APAL, percentil, rebalanceo, retornos

VERSION = 1
P_BAJO, P_ALTO = 10, 90

# fondos de control de volatilidad: objetivo de vol, apalancamiento maximo y ventanas de vol realizada (se usa la
# mayor: venden deprisa cuando la vol sube y recompran despacio). El AUM no es publico: es un supuesto.
VC_OBJETIVO, VC_TOPE, VC_VENTANAS = 0.10, 1.5, (21, 63)
VC_AUM = 200e9
# CTAs: senal de tendencia por ventana = rentabilidad / (vol a 63 sesiones x raiz del plazo), recortada a +-1
CTA_VENTANAS = (21, 63, 126, 252)
# dealers: el motor desplaza la IV en paralelo; en el escenario de estres la IV sube 5 puntos en las bajadas y
# cae 2 en las subidas (en la rejilla SCEN_IV de gex_engine)
IV_BAJA, IV_SUBE = 5, -2
ESCENARIOS = (-5, -3, -1, 1, 3, 5)
COMPLEJOS = {"S&P 500": ("SPX", "SPY"), "Nasdaq 100": ("NDX", "QQQ"), "Russell 2000": ("RUT", "IWM")}
STRIKES_TOP, STRIKES_BANDA = 6, (0.85, 1.05)

MODELO = {"version": VERSION, "vc_objetivo": VC_OBJETIVO, "vc_tope": VC_TOPE, "vc_ventanas": list(VC_VENTANAS),
          "vc_aum": VC_AUM, "cta_ventanas": list(CTA_VENTANAS), "iv_estres": [IV_BAJA, IV_SUBE],
          "dealers": "convencion standard del motor Perfil: clientes compran puts y venden calls"}


def _r(x, n=0):
    if x is None or not math.isfinite(x):
        return None
    return int(round(x)) if n == 0 else round(float(x), n)


def _extremo(p):
    return p is not None and (p <= P_BAJO or p >= P_ALTO)


# ------------------------------------------------------------------ dealers
def dealers(res: dict) -> dict:
    """Resumen de un resultado de gex_engine.compute: flujo de cobertura por escenario de precio (+ compran, - venden),
    con la IV quieta y con la IV de estres, gamma por 1 % y niveles."""
    sc = res["scenarios"]
    i0, ib, isu = sc["iv"].index(0), sc["iv"].index(IV_BAJA), sc["iv"].index(IV_SUBE)
    flujo, estres = {}, {}
    for k, ds in enumerate(sc["spot"]):
        if ds in ESCENARIOS:
            flujo[str(ds)] = _r(sc["flow"][k][i0])
            estres[str(ds)] = _r(sc["flow"][k][ib if ds < 0 else isu])
    L, t = res["levels"], res["totals"]
    return {"spot": _r(res["spot"], 2), "net_per_pct": _r(t["net_per_pct"]), "regimen": res["regime"],
            "zero_gamma": _r(L.get("zero_gamma"), 2), "call_wall": L.get("call_wall"), "put_wall": L.get("put_wall"),
            "vanna_flow": _r(t.get("vanna_flow")), "charm_flow": _r(t.get("charm_flow")),
            "flujo": flujo, "estres": estres}


def complejos(por_sym: dict) -> dict:
    """Suma indice + ETF (SPX + SPY...): son subyacentes distintos con dealers distintos."""
    out = {}
    for nombre, syms in COMPLEJOS.items():
        d = [por_sym[s] for s in syms if s in por_sym]
        if not d:
            continue
        suma = lambda campo, k: _r(sum(x[campo].get(k) or 0 for x in d))   # noqa: E731
        out[nombre] = {"simbolos": [s for s in syms if s in por_sym],
                       "net_per_pct": _r(sum(x["net_per_pct"] or 0 for x in d)),
                       "flujo": {k: suma("flujo", k) for k in d[0]["flujo"]},
                       "estres": {k: suma("estres", k) for k in d[0]["estres"]}}
    return out


# ------------------------------------------------------------------ ETFs apalancados
def letf(aum: dict, cierres: dict, fecha: str, aum_hist: dict | None = None) -> dict:
    """aum: {ETF: $} de hoy; cierres: {ETF 1x: [(fecha, cierre)]}; aum_hist: {fecha: {ETF: $}} de la serie.
    Rebalanceo de hoy, sensibilidad por 1 % y percentil frente a 252 sesiones (con el AUM guardado de cada dia si
    lo hay; si no, el de hoy)."""
    aum_hist = aum_hist or {}
    rets = {s: dict(retornos(c)) for s, c in cierres.items()}
    usados = {e: a for e, a in aum.items() if a and e in ETF_APAL and ETF_APAL[e][0] in rets}
    if not usados:
        raise ValueError("Sin AUM ni precios de los ETFs apalancados")

    def dia(f, aums):
        out = {}
        for e, a in aums.items():
            sub, L = ETF_APAL.get(e, (None, None))
            r = rets.get(sub, {}).get(f)
            if r is not None:
                out[sub] = out.get(sub, 0.0) + rebalanceo(a, L, r)
        return out

    hoy = dia(fecha, usados)
    if not hoy:
        raise ValueError(f"Sin retorno de los subyacentes el {fecha}")
    sens = {}
    for e, a in usados.items():
        sub, L = ETF_APAL[e]
        sens[sub] = sens.get(sub, 0.0) + rebalanceo(a, L, 0.01)
    previas = sorted({f for d in rets.values() for f in d if f < fecha})[-252:]
    hist = [abs(sum(dia(f, {**usados, **{e: a for e, a in (aum_hist.get(f) or {}).items() if a}}).values()))
            for f in previas]
    total = sum(hoy.values())
    return {"total": _r(total), "por_subyacente": {k: _r(v) for k, v in hoy.items()},
            "retornos_pct": {s: _r(100 * rets[s][fecha], 2) for s in hoy},
            "por_1pct": _r(sum(sens.values())), "por_1pct_subyacente": {k: _r(v) for k, v in sens.items()},
            "escenarios": {str(p): _r(sum(sens.values()) * p) for p in ESCENARIOS},
            "pct": percentil(abs(total), hist), "aum": {e: _r(a) for e, a in usados.items()},
            "nota": "Escenarios con el mismo movimiento en todos los subyacentes; los semis suelen moverse mas"}


# ------------------------------------------------------------------ control de volatilidad
def _vol(rs, n):
    x = np.asarray(rs[-n:], float)
    return float(math.sqrt(252 * float((x * x).mean()))) if x.size >= n else None


def exposicion_vc(rs) -> float | None:
    v = [_vol(rs, n) for n in VC_VENTANAS]
    if any(x is None for x in v):
        return None
    return min(VC_TOPE, VC_OBJETIVO / max(max(v), 1e-6))


def vol_control(cierres: list, fecha: str) -> dict:
    """cierres: [(fecha, cierre)] del indice (SPX) hasta fecha. Exposicion de los fondos (veces el capital), cambio en
    dolares con VC_AUM y escenarios para la proxima sesion."""
    c = [x for x in cierres if x[0] <= fecha]
    rs = [r for _, r in retornos(c)]
    e = exposicion_vc(rs)
    if e is None or c[-1][0] != fecha:
        raise ValueError(f"Sin cierres suficientes del indice hasta {fecha}")
    n = max(VC_VENTANAS)
    serie = [exposicion_vc(rs[i - n:i]) for i in range(max(n, len(rs) - 2520), len(rs) + 1)]   # 10 anos
    e1, e5 = serie[-2], serie[-6]
    d = lambda a, b: _r((a - b) * VC_AUM)   # noqa: E731
    esc = {str(p): d(exposicion_vc(rs + [p / 100]), e) for p in (-5, -3, 3, 5)}
    esc["calma"] = d(exposicion_vc(rs + [0.005, -0.005] * 5), e)   # dos semanas de +-0,5 %
    vols = {str(n): _r(100 * _vol(rs, n), 1) for n in VC_VENTANAS}
    fechas = [f for f, _ in c[1:]][-len(serie):]
    return {"exposicion": _r(e, 3), "pct": percentil(e, serie[:-1]),
            "historia": [[f, _r(x, 3)] for f, x in list(zip(fechas, serie))[-252:]], "cambio_1d": d(e, e1), "cambio_5d": d(e, e5),
            "vol_realizada": vols, "vol_para_tope": _r(100 * VC_OBJETIVO / VC_TOPE, 1),
            "escenarios": esc, "aum_supuesto": VC_AUM,
            "nota": "Estimacion: AUM supuesto y regla generica (vol objetivo 10 %, la mayor de 1 y 3 meses, tope 1,5x)"}


# ------------------------------------------------------------------ CTAs
def _cta_pos(c) -> tuple[float, dict] | None:
    rs = [r for _, r in retornos(c)]
    v = _vol(rs, 63)
    if v is None or len(c) <= max(CTA_VENTANAS):
        return None
    sen = {}
    for w in CTA_VENTANAS:
        ret = math.log(c[-1][1] / c[-1 - w][1])
        sen[str(w)] = max(-1.0, min(1.0, ret / (v * math.sqrt(w / 252))))
    return sum(sen.values()) / len(sen), sen


def cta(cierres: list, fecha: str) -> dict:
    """Posicion de un CTA generico de tendencia (-1 a 1) y los niveles del indice que dan la vuelta a cada senal en la
    proxima sesion (el cierre de hace w sesiones, contando manana)."""
    c = [x for x in cierres if x[0] <= fecha]
    p = _cta_pos(c[-(max(CTA_VENTANAS) + 2):])
    if p is None or c[-1][0] != fecha:
        raise ValueError(f"Sin cierres suficientes del indice hasta {fecha}")
    pos, sen = p
    n = max(CTA_VENTANAS) + 2
    hf = [(c[i - 1][0], q[0]) for i in range(max(n, len(c) - 2520), len(c)) if (q := _cta_pos(c[i - n:i]))]
    hist = [x for _, x in hf]
    previo = _cta_pos(c[-5 - n:-5])
    S = c[-1][1]
    giros = {str(w): {"nivel": _r(c[-w][1], 2), "dist_pct": _r(100 * (c[-w][1] / S - 1), 2)} for w in CTA_VENTANAS}
    esc = {}
    for x in (-5, -3, 3, 5):
        q = _cta_pos(c[-n:] + [("x", S * (1 + x / 100))])
        esc[str(x)] = _r(q[0], 2) if q else None
    return {"posicion": _r(pos, 2), "senales": {k: _r(v, 2) for k, v in sen.items()}, "pct": percentil(pos, hist),
            "historia": [[f, _r(x, 2)] for f, x in hf[-251:]] + [[fecha, _r(pos, 2)]],
            "cambio_5d": _r(pos - previo[0], 2) if previo else None, "giros": giros, "escenarios": esc,
            "nota": "Estimacion de un CTA generico (tendencia 1, 3, 6 y 12 meses); sin dolares: el tamano no es publico"}


# ------------------------------------------------------------------ strikes con puts
def _ncdf(x):
    return 0.5 * (1 + np.vectorize(math.erf)(np.asarray(x, float) / math.sqrt(2)))


def delta_put(S, K, iv, T, r=0.04):
    iv, T = np.maximum(iv, 0.01), np.maximum(T, 1 / (365 * 24))
    d1 = (np.log(S / K) + (r + iv * iv / 2) * T) / (iv * np.sqrt(T))
    return _ncdf(d1) - 1


def strikes_puts(ch: dict, spot: float, t0, r=0.04) -> dict:
    """ch: cadena (gex_engine.chain_from_min) del indice al cierre; t0: datetime64 del cierre. Strikes con mas puts
    cerca del precio, su vencimiento principal y lo que los dealers (cortos de esas puts) recomprarian (+) o
    venderian (-) en futuros si el indice cerrara en ese strike, por el cambio de delta de todas las puts."""
    K, oi, iv, exp = ch["K"], ch["oi"], ch["iv"], ch["exp"]
    vivo = (~ch["call"]) & (oi > 0) & (exp > t0)
    T = (exp - t0).astype("timedelta64[m]").astype(float) / (365 * 24 * 60)
    K, oi, iv, exp, T = K[vivo], oi[vivo], iv[vivo], exp[vivo], T[vivo]
    lo, hi = spot * STRIKES_BANDA[0], spot * STRIKES_BANDA[1]
    banda = (K >= lo) & (K <= hi)
    ks = np.unique(K[banda])
    tot = np.array([oi[banda & (K == k)].sum() for k in ks])
    top = ks[np.argsort(tot)[::-1][:STRIKES_TOP]]
    d0 = np.abs(delta_put(spot, K, iv, T, r))
    cobertura = float((oi * 100 * d0).sum() * spot)   # futuros vendidos por los dealers contra todas las puts

    def flujo_en(L):
        return float((oi * 100 * (d0 - np.abs(delta_put(L, K, iv, T, r)))).sum() * L)

    filas = []
    for k in sorted(top):
        m = K == k
        por_exp = {}
        for e, o in zip(exp[m], oi[m]):
            f = str(e.astype("datetime64[D]"))
            por_exp[f] = por_exp.get(f, 0.0) + float(o)
        principal = max(por_exp, key=por_exp.get)
        filas.append({"strike": _r(k, 2), "oi": _r(oi[m].sum()), "nocional": _r(oi[m].sum() * 100 * k),
                      "dist_pct": _r(100 * (k / spot - 1), 2), "vencimiento": principal,
                      "vencimiento_pct": _r(100 * por_exp[principal] / oi[m].sum(), 1),
                      "flujo_si_cierra_aqui": _r(flujo_en(k))})
    venc = {}
    for e, h in zip(exp, oi * 100 * d0 * spot):
        f = str(e.astype("datetime64[D]"))
        venc[f] = venc.get(f, 0.0) + float(h)
    venc = sorted(venc.items(), key=lambda x: -x[1])[:5]
    return {"spot": _r(spot, 2), "strikes": filas, "cobertura_total": _r(cobertura),
            "cobertura_por_vencimiento": [{"vencimiento": f, "cobertura": _r(v)} for f, v in venc],
            "nota": "Supone dealers cortos de todas las puts (convencion standard); la cobertura se deshace al vencer"}


# ------------------------------------------------------------------ asimetria total
def asimetria(comp: dict, et: dict | None, vc: dict | None) -> dict:
    """Flujos mecanicos estimados si el mercado cae o sube un 5 % en una sesion: dealers con IV de estres, ETFs
    apalancados y control de volatilidad. + compran, - venden."""
    out = {}
    for k in ("-5", "5"):
        fuentes = {f"Dealers {n}": c["estres"].get(k) for n, c in comp.items()}
        if et:
            fuentes["Leveraged ETFs"] = et["escenarios"].get(k)
        if vc:
            fuentes["Vol control"] = vc["escenarios"].get(k)
        fuentes = {f: v for f, v in fuentes.items() if v is not None}
        out[k] = {"total": _r(sum(fuentes.values())), "fuentes": fuentes}
    v, c = out["-5"]["total"], out["5"]["total"]
    out["cociente"] = _r(abs(v) / abs(c), 2) if c else None
    return out


# ------------------------------------------------------------------ destacados
def destacados(paq: dict, hist_net: dict, hist_asim: list) -> list:
    """Motivos por los que hoy merece la pena una nota (percentiles extremos). hist_net: {simbolo o complejo:
    [net_per_pct]}; hist_asim: [cociente de dias anteriores]."""
    b, out = paq["bloques"], []
    for sym, x in (b["dealers"].get("simbolos") or {}).items():
        x["pct"] = percentil(x["net_per_pct"], hist_net.get(sym) or [])
    for n, c in (b["dealers"].get("complejos") or {}).items():
        p = percentil(c["net_per_pct"], hist_net.get(n) or [])
        c["pct"] = p
        if _extremo(p):
            out.append(f"Dealer gamma {n}: {c['net_per_pct'] / 1e9:+.1f}B per 1% (percentile {p})")
    a = b.get("asimetria")
    if a and a.get("cociente") is not None:
        a["pct"] = percentil(a["cociente"], hist_asim)
        if a["cociente"] >= 1.5 or a["cociente"] <= 0.67 or _extremo(a["pct"]):
            out.append(f"Asymmetry -5%/+5%: {a['cociente']}x")
    for k, et in (("letf", "Leveraged ETF rebalance"), ("vol_control", "Vol control exposure"), ("cta", "CTA trend")):
        x = b.get(k)
        if x and _extremo(x.get("pct")):
            out.append(f"{et}: percentile {x['pct']}")
    for s in (b.get("strikes") or {}).get("strikes") or []:
        if 0 < s["dist_pct"] <= 3:
            out.append(f"Put strike {s['strike']:,.0f} ({s['dist_pct']:+.1f}%, {s['vencimiento']}) above spot")
            break
    return out


def fila_serie(paq: dict) -> dict:
    """Fila compacta de flujos/_serie.json.gz: lo que no se puede reconstruir despues (AUM del dia) y las cifras tal
    como se calcularon, con la version del modelo."""
    b = paq["bloques"]
    ok = lambda k: b.get(k) if b.get(k) and "motivo" not in b[k] else None   # noqa: E731
    d, et, vc, ct, st, a = ok("dealers"), ok("letf"), ok("vol_control"), ok("cta"), ok("strikes"), ok("asimetria")
    return {
        "modelo": VERSION,
        "dealers": {s: {"net": x["net_per_pct"], "f-5": x["estres"].get("-5"), "f5": x["estres"].get("5"),
                        "spot": x["spot"]} for s, x in (d or {}).get("simbolos", {}).items()},
        "complejos": {n: {"net": c["net_per_pct"], "f-5": c["estres"].get("-5"), "f5": c["estres"].get("5")}
                      for n, c in (d or {}).get("complejos", {}).items()},
        "aum": (et or {}).get("aum"), "letf": (et or {}).get("total"), "letf_1pct": (et or {}).get("por_1pct"),
        "vc": (vc or {}).get("exposicion"), "cta": (ct or {}).get("posicion"),
        "strikes": [[s["strike"], s["oi"], s["vencimiento"]] for s in (st or {}).get("strikes", [])],
        "asim": {"-5": a["-5"]["total"], "5": a["5"]["total"], "cociente": a["cociente"]} if a else None,
    }
