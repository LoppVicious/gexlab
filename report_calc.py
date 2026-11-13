"""Calculos puros del report semanal, sin red ni R2. Los usa report_semanal.py; pruebas en pruebas/test_report.py.
Bloques: gamma y niveles, vol realizada y spot-vol, rebalanceo de ETFs apalancados y vol a strike fijo.
Cada bloque devuelve {"destacado": bool, "por_que": [textos], "datos": {...}}. Los umbrales son fijos (spec del
2026-11-13) para que lo que entra en el report no dependa del LLM."""
from __future__ import annotations

import math
from datetime import date

import numpy as np

P_BAJO, P_ALTO = 10, 90        # percentiles extremos (gamma neta, cociente subida/bajada, spot-vol)
P_RVOL = 85                    # vol realizada a 20 sesiones
P_REBAL = 90                   # rebalanceo de ETFs apalancados (dia o semana, en valor absoluto)
UMBRAL_WALL = 0.02             # movimiento relativo de una wall en la semana
UMBRAL_ATM_1M = 1.5            # puntos de IV ATM a 1 mes, a strike fijo
UMBRAL_SKEW_1M = 1.0           # puntos de skew 25P-25C a 1 mes


def _r(x, n=1):
    return None if x is None or not math.isfinite(x) else round(float(x), n)


def percentil(x, serie):
    """Percentil (0-100) de x en la serie: % de valores <= x. None sin dato o sin serie."""
    if x is None or not math.isfinite(x):
        return None
    s = np.asarray([v for v in serie if v is not None and math.isfinite(v)], dtype=float)
    if not s.size:
        return None
    return round(100.0 * float((s <= x).mean()), 1)


def extremo(p, bajo=P_BAJO, alto=P_ALTO) -> bool:
    return p is not None and (p <= bajo or p >= alto)


def retornos(cierres):
    """[(fecha, cierre)] ordenado -> [(fecha, retorno simple)]."""
    return [(cierres[i][0], cierres[i][1] / cierres[i - 1][1] - 1)
            for i in range(1, len(cierres)) if cierres[i - 1][1]]


def vol_anual(rs):
    """Vol realizada anualizada en % (media cero, 252 sesiones)."""
    return _r(100 * math.sqrt(252 * sum(r * r for r in rs) / len(rs))) if rs else None


def vol_sub_baj(rs):
    """Vol realizada de los dias de subida y de los de bajada, y su cociente."""
    s = vol_anual([r for r in rs if r > 0])
    b = vol_anual([r for r in rs if r < 0])
    return {"sube": s, "baja": b, "cociente": _r(s / b, 2) if s and b else None}


def correlacion(a, b):
    if len(a) < 5:
        return None
    a, b = np.asarray(a, float), np.asarray(b, float)
    if a.std() == 0 or b.std() == 0:
        return None
    return float(np.corrcoef(a, b)[0, 1])


def _semana_iso(f):
    y, w, _ = date.fromisoformat(f).isocalendar()
    return y, w


def bloque_vol_real(indices: dict, vix: list, sesiones: list) -> dict:
    """indices: {nombre: [(fecha, cierre)]}; vix: [(fecha, cierre)]; sesiones: las de la semana del report."""
    ultimo, sem, mes = sesiones[-1], set(sesiones), sesiones[-1][:7]
    actual = _semana_iso(ultimo)
    dvix = {f: c - p for (_, p), (f, c) in zip(vix, vix[1:])}
    datos, por_que = {}, []
    for nombre, serie in indices.items():
        rs = [(f, r) for f, r in retornos(serie) if f <= ultimo]
        if len(rs) < 300:
            raise ValueError(f"Serie de {nombre} demasiado corta ({len(rs)} sesiones)")
        por_sem, por_mes = {}, {}
        for f, r in rs:
            if _semana_iso(f) != actual:
                por_sem.setdefault(_semana_iso(f), []).append(r)
            if f[:7] != mes:
                por_mes.setdefault(f[:7], []).append(r)
        vs = vol_sub_baj([r for f, r in rs if f in sem])
        vm = vol_sub_baj([r for f, r in rs if f[:7] == mes])
        vs["pct"] = percentil(vs["cociente"], [vol_sub_baj(v)["cociente"] for v in por_sem.values()])
        vm["pct"] = percentil(vm["cociente"], [vol_sub_baj(v)["cociente"] for v in por_mes.values()])
        solo = [r for _, r in rs]
        v20 = [vol_anual(solo[i - 20:i]) for i in range(20, len(solo) + 1)]
        rv = {"valor": v20[-1], "pct": percentil(v20[-1], v20[:-1])}
        par = [(r, dvix[f]) for f, r in rs if f in dvix]
        c20 = [correlacion([p[0] for p in par[i - 20:i]], [p[1] for p in par[i - 20:i]]) for i in range(20, len(par) + 1)]
        cv = {"valor": _r(c20[-1], 2) if c20 else None, "pct": percentil(c20[-1], c20[:-1]) if c20 else None}
        mensual = [[m, vol_sub_baj(v)["sube"], vol_sub_baj(v)["baja"]] for m, v in sorted(por_mes.items())[-23:]]
        mensual.append([mes, vm["sube"], vm["baja"]])
        datos[nombre] = {"semana": vs, "mes": vm, "rvol20": rv, "corr_spot_vol_20": cv, "mensual": mensual}
        if extremo(vs["pct"]):
            por_que.append(f"{nombre}: cociente vol subida/bajada de la semana {vs['cociente']} (percentil {vs['pct']})")
        if extremo(vm["pct"]):
            por_que.append(f"{nombre}: cociente vol subida/bajada del mes {vm['cociente']} (percentil {vm['pct']})")
        if rv["pct"] is not None and rv["pct"] >= P_RVOL:
            por_que.append(f"{nombre}: vol realizada a 20 sesiones {rv['valor']}% (percentil {rv['pct']})")
        if extremo(cv["pct"]):
            por_que.append(f"{nombre}: correlacion spot-vol a 20 sesiones {cv['valor']} (percentil {cv['pct']})")
    return {"destacado": bool(por_que), "por_que": por_que, "datos": datos}


# ------------------------------------------------------------------ ETFs apalancados
ETF_APAL = {  # ETF: (ETF 1x del subyacente guardado en hist500, apalancamiento)
    "TQQQ": ("QQQ", 3), "SQQQ": ("QQQ", -3), "QLD": ("QQQ", 2),
    "UPRO": ("SPY", 3), "SPXL": ("SPY", 3), "SPXU": ("SPY", -3), "SSO": ("SPY", 2),
    "SOXL": ("SOXX", 3), "SOXS": ("SOXX", -3),
    "TNA": ("IWM", 3), "TZA": ("IWM", -3),
}


def rebalanceo(aum, L, r):
    """Dolares que el ETF compra (+) o vende (-) al cierre para volver a su apalancamiento: AUM x L x (L-1) x r."""
    return aum * L * (L - 1) * r


def bloque_etf(aum: dict, spots: dict, sesiones: list) -> dict:
    """aum: {ETF: dolares}; spots: {ETF 1x: [(fecha, cierre)]}. Percentiles frente a 252 sesiones con el AUM actual."""
    con_aum = {e: a for e, a in aum.items() if e in ETF_APAL and a}
    if not con_aum:
        raise ValueError("Sin AUM de ningun ETF apalancado")
    rets = {s: dict(retornos(c)) for s, c in spots.items()}
    usados = {e: a for e, a in con_aum.items() if ETF_APAL[e][0] in rets}
    if not usados:
        raise ValueError("Sin precios de los subyacentes de los ETFs apalancados")

    def por_indice(f):
        out = {}
        for e, a in usados.items():
            sub, L = ETF_APAL[e]
            r = rets[sub].get(f)
            if r is not None:
                out[sub] = out.get(sub, 0.0) + rebalanceo(a, L, r)
        return out

    fechas = sorted({f for d in rets.values() for f in d if f < sesiones[0]})[-252:]
    tot = [sum(por_indice(f).values()) for f in fechas]
    abs_dia = [abs(x) for x in tot]
    abs_sem = [abs(sum(tot[i - len(sesiones):i])) for i in range(len(sesiones), len(tot) + 1)]
    dias, por_que = [], []
    for f in sesiones:
        p = por_indice(f)
        t = sum(p.values())
        dias.append({"fecha": f, "por_indice": {k: round(v) for k, v in p.items()}, "total": round(t),
                     "pct": percentil(abs(t), abs_dia)})
        if dias[-1]["pct"] is not None and dias[-1]["pct"] >= P_REBAL:
            por_que.append(f"{f}: rebalanceo estimado {t / 1e9:+.1f} mil millones (percentil {dias[-1]['pct']})")
    st = sum(d["total"] for d in dias)
    semana = {"total": st, "pct": percentil(abs(st), abs_sem)}
    if semana["pct"] is not None and semana["pct"] >= P_REBAL:
        por_que.append(f"Semana: rebalanceo acumulado {st / 1e9:+.1f} mil millones (percentil {semana['pct']})")
    return {"destacado": bool(por_que), "por_que": por_que, "datos": {
        "dias": dias, "semana": semana, "aum": {e: round(a) for e, a in usados.items()},
        "sin_aum": sorted(set(ETF_APAL) - set(con_aum)), "sin_subyacente": sorted(set(con_aum) - set(usados)),
        "nota": "Percentiles frente a 252 sesiones con el AUM actual: no hay historico de AUM"}}


# ------------------------------------------------------------------ vol a strike fijo
TENORES = (("1w", 7), ("2w", 14), ("1m", 30), ("2m", 61), ("3m", 91), ("6m", 182), ("1y", 365))
DELTAS = (("10P", -0.10), ("25P", -0.25), ("40P", -0.40), ("50", None), ("40C", 0.40), ("25C", 0.25), ("10C", 0.10))


def _serie(ch, x, call):
    m = (ch["exp"] == x) & (ch["call"] == call) & (ch["iv"] > 0.01) & np.isfinite(ch["delta"])
    o = np.argsort(ch["K"][m])
    return ch["K"][m][o], ch["iv"][m][o], ch["delta"][m][o]


def strike_de_delta(ch, x, d):
    """Strike del vencimiento x con esa delta (interpolada); d None = ATM (el forward del vencimiento)."""
    if d is None:
        fw = ch["fwd"][ch["exp"] == x]
        return float(fw[0]) if fw.size else float(ch["spot"])
    K, _, de = _serie(ch, x, d > 0)
    if K.size < 2:
        return None
    o = np.argsort(de)
    if not (de[o][0] <= d <= de[o][-1]):
        return None
    return float(np.interp(d, de[o], K[o]))


def iv_en(ch, x, K, call):
    """IV en % del vencimiento x en el strike K (interpolada entre strikes); None fuera de rango."""
    Ks, iv, _ = _serie(ch, x, call)
    if Ks.size < 2 or not (Ks[0] <= K <= Ks[-1]):
        return None
    return float(np.interp(K, Ks, iv)) * 100


def vencimientos(ch, sesion):
    """[(tenor, vencimiento, dias)]: el vencimiento mas cercano a cada tenor, si esta a menos del 35 % (min. 3 dias)."""
    d0 = np.datetime64(sesion, "D")
    exps = np.unique(ch["exp"])
    dte = (exps.astype("datetime64[D]") - d0).astype(int)
    out, vistos = [], set()
    for nombre, obj in TENORES:
        dif = np.where(dte >= 1, np.abs(dte - obj), 10 ** 6)
        i = int(np.argmin(dif))
        if dif[i] <= max(3, obj * 0.35) and exps[i] not in vistos:
            vistos.add(exps[i])
            out.append((nombre, exps[i], int(dte[i])))
    return out


def _iv_atm(ch, x, K):
    v = [a for a in (iv_en(ch, x, K, True), iv_en(ch, x, K, False)) if a is not None]
    return sum(v) / len(v) if v else None


def bloque_vol_strike(cadenas: dict, sesion: str) -> dict:
    """cadenas: {ticker: (cadena de la sesion, cadena de la ultima sesion de la semana anterior)}."""
    datos, por_que = {}, []
    for sym, (ch, prev) in cadenas.items():
        filas = []
        for tenor, x, dte in vencimientos(ch, sesion):
            celdas = {}
            for et, d in DELTAS:
                K = strike_de_delta(ch, x, d)
                if K is None:
                    continue
                if d is None:
                    ahora, antes = _iv_atm(ch, x, K), _iv_atm(prev, x, K)
                else:
                    ahora, antes = iv_en(ch, x, K, d > 0), iv_en(prev, x, K, d > 0)
                celdas[et] = {"strike": _r(K, 2), "iv": _r(ahora),
                              "cambio": _r(ahora - antes, 2) if ahora is not None and antes is not None else None}
            fila = {"tenor": tenor, "vencimiento": str(x)[:10], "dte": dte, "celdas": celdas,
                    "skew_25": None, "skew_25_cambio": None}
            p, c = celdas.get("25P"), celdas.get("25C")
            if p and c and p["iv"] is not None and c["iv"] is not None:
                fila["skew_25"] = _r(p["iv"] - c["iv"])
                if p["cambio"] is not None and c["cambio"] is not None:
                    fila["skew_25_cambio"] = _r(p["cambio"] - c["cambio"], 2)
            filas.append(fila)
        if not filas:
            continue
        datos[sym] = filas
        m1 = next((f for f in filas if f["tenor"] == "1m"), None)
        if m1:
            atm = (m1["celdas"].get("50") or {}).get("cambio")
            if atm is not None and abs(atm) >= UMBRAL_ATM_1M:
                por_que.append(f"{sym}: IV ATM a 1 mes {atm:+.1f} puntos a strike fijo en la semana")
            sk = m1["skew_25_cambio"]
            if sk is not None and abs(sk) >= UMBRAL_SKEW_1M:
                por_que.append(f"{sym}: skew 25P-25C a 1 mes {sk:+.1f} puntos en la semana")
    if not datos:
        raise ValueError("Sin cadenas utiles para la vol a strike fijo")
    return {"destacado": bool(por_que), "por_que": por_que, "datos": datos}


# ------------------------------------------------------------------ gamma y niveles
CAMPOS_GAMMA = ("spot", "flip", "call_wall", "put_wall", "net_per_pct")


def regimen(s):
    if not s or s.get("flip") is None or s.get("spot") is None:
        return None
    return "positiva" if s["spot"] >= s["flip"] else "negativa"


def bloque_gamma(semanas: dict, hist_net: dict) -> dict:
    """semanas: {ticker: {"previa": (fecha, snap) o None, "dias": [(fecha, snap)]}}, snap con CAMPOS_GAMMA;
    hist_net: {ticker: [gamma neta (net_per_pct) del ultimo ano]}."""
    datos, por_que = {}, []
    for sym, w in semanas.items():
        dias = w["dias"]
        if not dias:
            continue
        serie = ([w["previa"]] if w.get("previa") else []) + dias
        cruces, antes = [], None
        for f, s in serie:
            r = regimen(s)
            if antes is not None and r is not None and r != antes:
                cruces.append({"fecha": f, "a": r})
            antes = r if r is not None else antes
        ult, prev = dias[-1][1], (w["previa"][1] if w.get("previa") else None)
        cambio = {}
        for k in ("call_wall", "put_wall"):
            a, b = (prev or {}).get(k), ult.get(k)
            cambio[k] = _r(100 * (b / a - 1)) if a and b else None
        net_pct = percentil(ult.get("net_per_pct"), hist_net.get(sym, []))
        datos[sym] = {"dias": [{"fecha": f, **{k: s.get(k) for k in CAMPOS_GAMMA}} for f, s in dias],
                      "previa": ({"fecha": w["previa"][0], **{k: prev.get(k) for k in CAMPOS_GAMMA}} if prev else None),
                      "regimen": regimen(ult), "cruces": cruces, "cambio": cambio, "net_pct": net_pct}
        for c in cruces:
            por_que.append(f"{sym}: el spot paso a gamma {c['a']} el {c['fecha']}")
        for k, v in cambio.items():
            if v is not None and abs(v) >= 100 * UMBRAL_WALL:
                por_que.append(f"{sym}: {k} {v:+.1f} % en la semana")
        if extremo(net_pct):
            por_que.append(f"{sym}: gamma neta en el percentil {net_pct} del ultimo ano")
    if not datos:
        raise ValueError("Sin niveles de ningun ticker esta semana")
    return {"destacado": bool(por_que), "por_que": por_que, "datos": datos}
