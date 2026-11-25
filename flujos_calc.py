"""Calculos puros de la nota diaria de flujos (Takes estilo "flujos mecanicos"), sin red ni R2. Los usa
flujos_diario.py; pruebas en pruebas/test_flujos.py. Diseno en docs/FLUJOS.md.
Bloques: cobertura de los dealers por escenario (del motor), rebalanceo de ETFs apalancados, fondos de control de
volatilidad, CTAs (tendencia), strikes con mas puts y la asimetria total de los flujos mecanicos a +-5 %.
Todo lo que no es dato (AUM de vol-control, convencion de los dealers, reglas de los modelos) es un supuesto fijo y
va en MODELO para que cada fila de la serie diga con que version se calculo."""
from __future__ import annotations

import math

import numpy as np

from report_calc import percentil, rebalanceo, retornos

VERSION = 3   # 2: dealers con vencimientos hasta 90 dias y cambio de IV escalado por plazo; 3: ETFs por categoria
P_BAJO, P_ALTO = 10, 90

# fondos de control de volatilidad: objetivo de vol, apalancamiento maximo y ventanas de vol realizada (se usa la
# mayor: venden deprisa cuando la vol sube y recompran despacio). El AUM no es publico: es un supuesto.
VC_OBJETIVO, VC_TOPE, VC_VENTANAS = 0.10, 1.5, (21, 63)
VC_AUM = 200e9
# CTAs: senal de tendencia por ventana = rentabilidad / (vol a 63 sesiones x raiz del plazo), recortada a +-1
CTA_VENTANAS = (21, 63, 126, 252)
# dealers: vencimientos hasta 90 dias (como el "full" de gexbot; los largos casi no tienen gamma pero, con la IV
# movida, su delta pesaba mucho). En el escenario de estres la IV sube 5 puntos en las bajadas y cae 2 en las subidas
# (rejilla SCEN_IV de gex_engine), escalado por plazo: x min(1, raiz(30 dias / T)) (compute(iv_term=True))
DEALERS_DTE = 90
IV_BAJA, IV_SUBE = 5, -2
ESCENARIOS = (-5, -3, -1, 1, 3, 5)
COMPLEJOS = {"S&P 500": ("SPX", "SPY"), "Nasdaq 100": ("NDX", "QQQ"), "Russell 2000": ("RUT", "IWM")}
STRIKES_TOP, STRIKES_BANDA = 6, (0.85, 1.05)

# ETFs apalancados por categoria (las de las tablas de rebalanceo de los bancos): ETF -> (subyacente 1x con cierres
# diarios, apalancamiento, categoria, emisor). Los de una accion (Mag7) son 2x de Direxion; Bitcoin, sobre IBIT.
CATEGORIAS = ("Tech", "Semi", "SPX", "Mag7", "DJI", "RUT", "Gold", "Silver", "Bitcoin", "Financials")
ETFS = {
    "TQQQ": ("QQQ", 3, "Tech", "proshares"), "SQQQ": ("QQQ", -3, "Tech", "proshares"),
    "QLD": ("QQQ", 2, "Tech", "proshares"), "QID": ("QQQ", -2, "Tech", "proshares"),
    "TECL": ("XLK", 3, "Tech", "direxion"), "TECS": ("XLK", -3, "Tech", "direxion"),
    "ROM": ("XLK", 2, "Tech", "proshares"),
    "SOXL": ("SOXX", 3, "Semi", "direxion"), "SOXS": ("SOXX", -3, "Semi", "direxion"),
    "USD": ("SOXX", 2, "Semi", "proshares"),
    "UPRO": ("SPY", 3, "SPX", "proshares"), "SPXU": ("SPY", -3, "SPX", "proshares"),
    "SPXL": ("SPY", 3, "SPX", "direxion"), "SPXS": ("SPY", -3, "SPX", "direxion"),
    "SSO": ("SPY", 2, "SPX", "proshares"), "SDS": ("SPY", -2, "SPX", "proshares"),
    "NVDU": ("NVDA", 2, "Mag7", "direxion"), "TSLL": ("TSLA", 2, "Mag7", "direxion"),
    "AAPU": ("AAPL", 2, "Mag7", "direxion"), "AMZU": ("AMZN", 2, "Mag7", "direxion"),
    "GGLL": ("GOOGL", 2, "Mag7", "direxion"), "METU": ("META", 2, "Mag7", "direxion"),
    "MSFU": ("MSFT", 2, "Mag7", "direxion"),
    "UDOW": ("DIA", 3, "DJI", "proshares"), "SDOW": ("DIA", -3, "DJI", "proshares"),
    "DDM": ("DIA", 2, "DJI", "proshares"),
    "TNA": ("IWM", 3, "RUT", "direxion"), "TZA": ("IWM", -3, "RUT", "direxion"),
    "URTY": ("IWM", 3, "RUT", "proshares"), "UWM": ("IWM", 2, "RUT", "proshares"),
    "UGL": ("GLD", 2, "Gold", "proshares"), "GLL": ("GLD", -2, "Gold", "proshares"),
    "NUGT": ("GDX", 2, "Gold", "direxion"), "DUST": ("GDX", -2, "Gold", "direxion"),
    "AGQ": ("SLV", 2, "Silver", "proshares"), "ZSL": ("SLV", -2, "Silver", "proshares"),
    "BITU": ("IBIT", 2, "Bitcoin", "proshares"), "SBIT": ("IBIT", -2, "Bitcoin", "proshares"),
    "FAS": ("XLF", 3, "Financials", "direxion"), "FAZ": ("XLF", -3, "Financials", "direxion"),
    "UYG": ("XLF", 2, "Financials", "proshares"),
}

# escala de los dealers: el motor supone que los dealers tienen todo el OI (cortos de puts, largos de calls, sin
# neteo) y da una gamma unas 10 veces mayor que la de los bancos, que netean con su propio libro. Se calibra con
# cifras publicadas de la gamma de los dealers del S&P 500 ($ por 1 %): factor = publicada / la del motor ese dia
# (complejo S&P 500). Se aplica el mismo factor a los tres complejos. Anadir puntos aqui cuando haya cifras nuevas.
CALIBRACION = [{"fecha": "2026-11-17", "complejo": "S&P 500", "gamma_1pct": -7.3e9,
                "fuente": "Nomura (McElligott), nota del 2026-11-17: exposicion de los dealers a la vol del S&P 500"}]

MODELO = {"version": VERSION, "calibracion": CALIBRACION, "vc_objetivo": VC_OBJETIVO, "vc_tope": VC_TOPE, "vc_ventanas": list(VC_VENTANAS),
          "vc_aum": VC_AUM, "cta_ventanas": list(CTA_VENTANAS), "iv_estres": [IV_BAJA, IV_SUBE],
          "dealers_dte": DEALERS_DTE, "iv_estres_por_plazo": "x min(1, raiz(30 dias / T))",
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
    """aum: {ETF: $} de hoy; cierres: {subyacente: [(fecha, cierre)]}; aum_hist: {fecha: {ETF: $}} de la serie.
    Rebalanceo al cierre AUM x L x (L-1) x r por categoria, sensibilidad por 1 % y percentil (con signo: bajo = mucha
    venta) frente a 252 sesiones, con el AUM guardado de cada dia si lo hay; si no, el de hoy."""
    aum_hist = aum_hist or {}
    rets = {s: dict(retornos(c)) for s, c in cierres.items()}
    usados = {e: a for e, a in aum.items() if a and e in ETFS and ETFS[e][0] in rets}
    if not usados:
        raise ValueError("Sin AUM ni precios de los ETFs apalancados")

    def dia(f, aums):
        out = {}
        for e, a in aums.items():
            sub, L, cat, _ = ETFS[e]
            r = rets.get(sub, {}).get(f)
            if r is not None:
                out[cat] = out.get(cat, 0.0) + rebalanceo(a, L, r)
        return out

    hoy = dia(fecha, usados)
    if not hoy:
        raise ValueError(f"Sin retorno de los subyacentes el {fecha}")
    sens = {}
    for e, a in usados.items():
        sub, L, cat, _ = ETFS[e]
        sens[cat] = sens.get(cat, 0.0) + rebalanceo(a, L, 0.01)
    previas = sorted({f for d in rets.values() for f in d if f < fecha})[-252:]
    hist = [dia(f, {**usados, **{e: a for e, a in (aum_hist.get(f) or {}).items() if a and e in ETFS}})
            for f in previas]
    total = sum(hoy.values())
    cats = [c for c in CATEGORIAS if c in hoy]
    subs = sorted({ETFS[e][0] for e in usados if ETFS[e][0] in rets and fecha in rets[ETFS[e][0]]})
    return {"total": _r(total), "pct": percentil(total, [sum(h.values()) for h in hist]),
            "categorias": [{"categoria": c, "hoy": _r(hoy[c]), "por_1pct": _r(sens.get(c)),
                            "pct": percentil(hoy[c], [h.get(c, 0.0) for h in hist]),
                            "etfs": sorted(e for e in usados if ETFS[e][2] == c)} for c in cats],
            "retornos_pct": {s: _r(100 * rets[s][fecha], 2) for s in subs},
            "por_1pct": _r(sum(sens.values())),
            "escenarios": {str(p): _r(sum(sens.values()) * p) for p in ESCENARIOS},
            "aum": {e: _r(a) for e, a in usados.items()}, "sin_aum": sorted(set(ETFS) - set(usados)),
            "nota": "Percentil con signo (bajo = mucha venta). Escenarios con el mismo movimiento en todos los "
                    "subyacentes; semis y acciones sueltas suelen moverse mas"}


# ------------------------------------------------------------------ escala de los dealers
def escala_dealers(motor_en_fecha: dict) -> dict | None:
    """motor_en_fecha: {fecha: gamma por 1 % del motor del complejo de CALIBRACION}. Factor = mediana de
    publicada / motor en las fechas con dato; None si no hay ninguna."""
    pares = [(c, motor_en_fecha.get(c["fecha"])) for c in CALIBRACION]
    pares = [(c, m) for c, m in pares if m and m * c["gamma_1pct"] > 0]
    if not pares:
        return None
    f = float(np.median([c["gamma_1pct"] / m for c, m in pares]))
    return {"factor": round(f, 4), "puntos": [{"fecha": c["fecha"], "publicada": c["gamma_1pct"], "motor": _r(m)}
                                             for c, m in pares]}


def escalar(bloque: dict, factor: float) -> dict:
    """Aplica el factor a gamma y flujos de simbolos y complejos; guarda la cifra del motor en *_motor."""
    for grupo in ("simbolos", "complejos"):
        for x in (bloque.get(grupo) or {}).values():
            x["net_motor"] = x["net_per_pct"]
            x["net_per_pct"] = _r(x["net_per_pct"] * factor)
            for k in ("flujo", "estres"):
                x[f"{k}_motor"] = x[k]
                x[k] = {e: _r(v * factor) if v is not None else None for e, v in x[k].items()}
            for k in ("vanna_flow", "charm_flow"):
                if x.get(k) is not None:
                    x[k] = _r(x[k] * factor)
    bloque["escala"] = factor
    return bloque


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
    cerca del precio, su vencimiento principal y lo que los dealers (cortos de las puts de ese strike) recomprarian (+)
    o venderian (-) en futuros si el indice cerrara en el strike, por el cambio de delta de esas puts. Solo las del
    strike: sumar todas las puts de la cadena como cortas de los dealers da billones (parte del OI son spreads y puts
    vendidas por clientes)."""
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

    filas = []
    for k in sorted(top):
        m = K == k
        por_exp = {}
        for e, o in zip(exp[m], oi[m]):
            f = str(e.astype("datetime64[D]"))
            por_exp[f] = por_exp.get(f, 0.0) + float(o)
        principal = max(por_exp, key=por_exp.get)
        cambio = d0[m] - np.abs(delta_put(k, K[m], iv[m], T[m], r))
        filas.append({"strike": _r(k, 2), "oi": _r(oi[m].sum()), "nocional": _r(oi[m].sum() * 100 * k),
                      "dist_pct": _r(100 * (k / spot - 1), 2), "vencimiento": principal,
                      "vencimiento_pct": _r(100 * por_exp[principal] / oi[m].sum(), 1),
                      "delta_hoy": _r(float((oi[m] * d0[m]).sum() / oi[m].sum()), 2),
                      "flujo_si_cierra_aqui": _r(float((oi[m] * 100 * cambio).sum() * k))})
    return {"spot": _r(spot, 2), "strikes": filas,
            "nota": "Supone dealers cortos de las puts de cada strike (convencion standard); se deshace al vencer"}


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
        x["pct"] = percentil(x.get("net_motor", x["net_per_pct"]), hist_net.get(sym) or [])
    for n, c in (b["dealers"].get("complejos") or {}).items():
        p = percentil(c.get("net_motor", c["net_per_pct"]), hist_net.get(n) or [])
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
    for c in ((b.get("letf") or {}).get("categorias") or []):
        if _extremo(c.get("pct")) and abs(c["hoy"] or 0) >= 0.5e9:
            out.append(f"Leveraged ETFs {c['categoria']}: {c['hoy'] / 1e9:+.1f}B (percentile {c['pct']})")
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
        "escala": (d or {}).get("escala"),
        "dealers": {s: {"net": x.get("net_motor", x["net_per_pct"]), "f-5": x["estres"].get("-5"), "f5": x["estres"].get("5"),
                        "spot": x["spot"]} for s, x in (d or {}).get("simbolos", {}).items()},
        "complejos": {n: {"net": c.get("net_motor", c["net_per_pct"]), "f-5": c["estres"].get("-5"), "f5": c["estres"].get("5")}
                      for n, c in (d or {}).get("complejos", {}).items()},
        "aum": (et or {}).get("aum"), "letf": (et or {}).get("total"), "letf_1pct": (et or {}).get("por_1pct"),
        "letf_cat": {c["categoria"]: c["hoy"] for c in (et or {}).get("categorias", [])},
        "vc": (vc or {}).get("exposicion"), "cta": (ct or {}).get("posicion"),
        "strikes": [[s["strike"], s["oi"], s["vencimiento"]] for s in (st or {}).get("strikes", [])],
        "asim": {"-5": a["-5"]["total"], "5": a["5"]["total"], "cociente": a["cociente"]} if a else None,
    }
