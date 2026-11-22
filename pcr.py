"""Sentimiento por put/call (diseño en docs/SENTIMIENTO.md).

Con la cadena del cierre que guarda historial500.py, suma por tramo de vencimiento el volumen y el OI de calls y puts
fuera de dinero ponderados por |delta| (la del motor, la que guarda la cadena compacta). Fuera de dinero porque las
calls dentro del dinero que se compran antes del dividendo (KO, PFE) disparan el volumen sin decir nada del
sentimiento; |delta| para que una put lejana de 0,05 no pese lo mismo que una ATM. El spot se cancela en el ratio.

  t0: 0-7 días naturales (especulación), t1: 8-45 (mensual), t2: más de 45 (coberturas), all: todos.

Índice hist500/_pcr.json.gz = {fecha: {SYM: {t0|t1|t2|all: [vc, vp, oc, op] o None}}} (None: sin contratos fuera de
dinero en el tramo) y hist500/_pcr_exp.json.gz = {SYM: P/C por vencimiento del último día}. Puntuación de cada ticker:
z robusta de log(P/C de volumen) frente a sus VENTANA sesiones anteriores (mínimo MIN_SES), 1 + 99 × Φ(−z): 100 =
codicia (menos puts que lo normal), 1 = miedo. La combinada es la media de las z de t0 y t1 (hasta 45 días).

Divergencias: cierre en máximo (mínimo) de DIV_SES sesiones con la media de la puntuación de las DIV_MEDIA últimas
DIV_PUNTOS por debajo (encima) de la de las DIV_MEDIA anteriores. Mercado: puntuación de los índices, amplitud de las
acciones y el P/C sumado de todas las acciones (AGREGADO). La z combinada es también la señal "pcr" de skew.py.
Publica pub/pcr.json (/api/pcr), siempre después de skew (lee de pub/skew.json la prueba de la señal)."""
from __future__ import annotations

import math
import re

import numpy as np

import almacen
import gex_engine as g
import skew

INDICE = "hist500/_pcr.json.gz"
VENCIMIENTOS = "hist500/_pcr_exp.json.gz"
PUB = "pub/pcr.json"
TRAMOS = {"t0": (0, 7), "t1": (8, 45), "t2": (46, 100_000), "all": (0, 100_000)}
VENTANA = 60                    # sesiones de la referencia de cada ticker
MIN_SES = 20                    # sesiones con dato (contando la de hoy) para dar z
# volumen (u OI) × |delta| mínimo de cada pata para leer el ratio de un día: con casi nada de calls fuera de dinero
# el ratio se dispara (TRMB 330, JKHY 168 el 2026-11-20) y es ruido. Se aplica al leer, no al guardar: las sumas del
# índice quedan completas y el umbral se puede recalibrar sin reconstruir (pruebas/estudio_pcr.py)
MIN_PATA = 25.0
DIV_SES = 20                    # máximo o mínimo de cierre de estas sesiones
DIV_MEDIA = 5                   # sesiones de cada media de la puntuación
DIV_PUNTOS = 15                 # diferencia mínima entre las dos medias
CAMBIO = 5                      # sesiones del cambio de la puntuación
HORIZONTES = (10, 40)           # rendimiento tras una divergencia (los de skew)
INDICES = ("SPX", "SPY", "QQQ", "IWM")
AGREGADO = "_STOCKS"            # suma de todas las acciones (t0 y t1), como un ticker más
SERIE_MAX = 250                 # sesiones publicadas por ticker para el gráfico


# ---------------------------------------------------------------- sumas de la cadena
def _r(p: float, c: float) -> float | None:
    return round(p / c, 4) if p >= MIN_PATA and c >= MIN_PATA else None


def _base(ch: dict, spot: float, sesion: str):
    """Días naturales al vencimiento, máscara fuera de dinero y no vencido, peso |delta|."""
    dias = ch["exp"].astype("datetime64[D]")
    dte = (dias - np.datetime64(sesion)).astype(int)
    otm = np.where(ch["call"], ch["K"] > spot, ch["K"] < spot) & (dte >= 0)
    return dias, dte, otm, np.abs(ch["delta"])


def _cuatro(ch: dict, m: np.ndarray, w: np.ndarray) -> list[float]:
    """[volumen call, volumen put, OI call, OI put] ponderados por w."""
    C = ch["call"]
    return [round(float((ch[k][x] * w[x]).sum()), 2) for k in ("vol", "oi") for x in (m & C, m & ~C)]


def sumas(ch: dict, spot: float, sesion: str) -> dict:
    """{tramo: [vc, vp, oc, op] o None}."""
    _, dte, otm, w = _base(ch, spot, sesion)
    out = {}
    for t, (a, b) in TRAMOS.items():
        m = otm & (dte >= a) & (dte <= b)
        out[t] = _cuatro(ch, m, w) if m.any() else None
    return out


def por_vencimiento(ch: dict, spot: float, sesion: str) -> list[dict]:
    """P/C de volumen y de OI de cada vencimiento (mismos contratos y pesos que sumas)."""
    dias, dte, otm, w = _base(ch, spot, sesion)
    out = []
    for d in np.unique(dias[otm]):
        m = otm & (dias == d)
        vc, vp, oc, op = _cuatro(ch, m, w)
        out.append({"exp": str(d), "dte": int(dte[m][0]), "pc_vol": _r(vp, vc), "pc_oi": _r(op, oc)})
    return out


# ---------------------------------------------------------------- z y puntuación
def log_pc(s: list | None, oi: bool = False) -> float | None:
    """log(puts / calls) de unas sumas [vc, vp, oc, op]; None si alguna pata no llega a MIN_PATA."""
    if not s:
        return None
    c, p = (s[2], s[3]) if oi else (s[0], s[1])
    return math.log(p / c) if p >= MIN_PATA and c >= MIN_PATA else None


def serie_z(xs: list[float | None]) -> list[float | None]:
    """z robusta de cada valor frente a los VENTANA anteriores (posiciones de sesión; los None no cuentan):
    (x − mediana) / (1,4826 × MAD). Sin MIN_SES sesiones con dato contando la de hoy, o con MAD 0, None."""
    out: list[float | None] = []
    for i, x in enumerate(xs):
        prev = np.array([v for v in xs[max(0, i - VENTANA):i] if v is not None])
        if x is None or prev.size < MIN_SES - 1:
            out.append(None)
            continue
        med = float(np.median(prev))
        mad = float(np.median(np.abs(prev - med)))
        out.append((x - med) / (1.4826 * mad) if mad > 0 else None)
    return out


def puntuacion(z: float | None) -> int | None:
    """1 + 99 × Φ(−z): z alta (más puts que lo normal) = miedo, cerca de 1; z baja = codicia, cerca de 100."""
    return None if z is None else int(round(1 + 99 * 0.5 * (1 + math.erf(-z / math.sqrt(2)))))


# ---------------------------------------------------------------- divergencias
def divergencias(cierres: list, scores: list) -> tuple[list[tuple[int, str]], list[str | None]]:
    """flags: "bear"/"bull"/None por sesión; casos: (sesión, tipo) de la primera sesión de cada racha (otra del
    mismo tipo no cuenta hasta pasar 2 × DIV_MEDIA sesiones sin ella), para no repetir el mismo episodio."""
    n = len(scores)
    flags: list[str | None] = [None] * n
    casos, ultimo = [], {}
    for i in range(n):
        if i < max(DIV_SES, 2 * DIV_MEDIA) - 1:
            continue
        ven = cierres[i - DIV_SES + 1:i + 1]
        a = scores[i - DIV_MEDIA + 1:i + 1]
        b = scores[i - 2 * DIV_MEDIA + 1:i - DIV_MEDIA + 1]
        if any(x is None for x in (*ven, *a, *b)):
            continue
        d = float(np.mean(a) - np.mean(b))
        tipo = ("bear" if ven[-1] >= max(ven) and d <= -DIV_PUNTOS else
                "bull" if ven[-1] <= min(ven) and d >= DIV_PUNTOS else None)
        if not tipo:
            continue
        flags[i] = tipo
        if i - ultimo.get(tipo, -10**6) > 2 * DIV_MEDIA:
            casos.append((i, tipo))
        ultimo[tipo] = i
    return casos, flags


# ---------------------------------------------------------------- cálculo
def _media(zs: list) -> float | None:
    v = [z for z in zs if z is not None]
    return float(np.mean(v)) if v else None


def _red(x: float | None, nd: int = 4) -> float | None:
    return None if x is None else round(x, nd)


def _ticker(fechas: list[str], idx: dict, sym: str):
    """z, z de OI y P/C de cada tramo por sesión, z combinada (media de t0 y t1) y sesiones con dato."""
    filas = [idx[f].get(sym) or {} for f in fechas]
    z, zoi, pc = {}, {}, {}
    for t in TRAMOS:
        xs = [log_pc(r.get(t)) for r in filas]
        z[t] = serie_z(xs)
        zoi[t] = serie_z([log_pc(r.get(t), oi=True) for r in filas])
        pc[t] = [None if x is None else math.exp(x) for x in xs]
    comb = [_media([z["t0"][i], z["t1"][i]]) for i in range(len(fechas))]
    n = sum(1 for r in filas if log_pc(r.get("t0")) is not None or log_pc(r.get("t1")) is not None)
    return z, zoi, pc, comb, n


def _con_agregado(idx: dict, acciones: set[str]) -> dict:
    """Añade AGREGADO a cada sesión: suma de t0 y t1 de todas las acciones."""
    out = {}
    for f, d in idx.items():
        agg = {}
        for t in ("t0", "t1"):
            v = [d[s][t] for s in d if s in acciones and d[s].get(t)]
            agg[t] = [round(sum(x[k] for x in v), 2) for k in range(4)] if v else None
        out[f] = {**d, AGREGADO: agg}
    return out


def zetas(idx: dict) -> dict:
    """{fecha: {SYM: z combinada}} para la señal de swing de skew.py (más puts que lo normal = alto)."""
    fechas = sorted(idx)
    out: dict = {}
    for s in {s for d in idx.values() for s in d}:
        for f, z in zip(fechas, _ticker(fechas, idx, s)[3]):
            if z is not None:
                out.setdefault(f, {})[s] = round(z, 4)
    return out


def _ret(c: list, i: int, h: int) -> float | None:
    j = i + h
    if j >= len(c) or not c[i] or not c[j] or abs(c[j] / c[i] - 1) >= skew.SALTO:
        return None
    return c[j] / c[i] - 1


def _resumen_div(lista: list[tuple], signo: int) -> dict:
    """Casos de un tipo: cuántos, rendimiento medio y tasa de acierto (en el sentido del signo) a cada horizonte."""
    out = {"n": len(lista)}
    for k, h in enumerate(HORIZONTES):
        r = [x[k] for x in lista if x[k] is not None]
        out[f"n{h}"] = len(r)
        out[f"ret{h}"] = round(float(np.mean(r)), 5) if r else None
        out[f"hit{h}"] = round(sum(1 for x in r if x * signo > 0) / len(r), 3) if r else None
    return out


def calcular(idx: dict, idx_skew: dict, nombres: dict, venc: dict | None = None, swing: dict | None = None) -> dict:
    """idx: índice de put/call; idx_skew: índice de skew (cierres en v[2]); venc: P/C por vencimiento del último día;
    swing: prueba de la señal pcr de skew.py."""
    if not idx:
        raise LookupError("Not enough history yet: the put/call index is empty.")
    fechas = sorted(idx)
    hoy = fechas[-1]
    u = len(fechas) - 1
    syms = sorted({s for d in idx.values() for s in d})
    acciones = {s for s in syms if skew.es_accion(s, nombres)}
    idx = _con_agregado(idx, acciones)
    rows, series, casos_tipo = [], {}, {"bear": [], "bull": []}
    for sym in syms + [AGREGADO]:
        if not any((idx[hoy].get(sym) or {}).values()):   # sin dato hoy: fuera de la tabla
            continue
        z, zoi, pc, comb, n = _ticker(fechas, idx, sym)
        sc = [puntuacion(x) for x in comb]
        row = {"sym": sym, "name": nombres.get(sym, ""), "stock": sym in acciones, "n": n,
               "score": sc[u], "z": _red(comb[u]),
               "chg5": sc[u] - sc[u - CAMBIO] if u >= CAMBIO and sc[u] is not None and sc[u - CAMBIO] is not None else None,
               "tranches": {t: {"pc": _red(pc[t][u]), "z": _red(z[t][u]), "zoi": _red(zoi[t][u]),
                                "score": puntuacion(z[t][u])} for t in TRAMOS},
               "div": None}
        if sym != AGREGADO:
            cier = [((idx_skew.get(f) or {}).get(sym) or [None] * 3)[2] for f in fechas]
            casos, flags = divergencias(cier, sc)
            rec = [(i, t) for i, t in enumerate(flags) if t and i > u - DIV_MEDIA]
            if rec:
                row["div"] = {"type": rec[-1][1], "date": fechas[rec[-1][0]]}
            for i, t in casos:
                casos_tipo[t].append(tuple(_ret(cier, i, h) for h in HORIZONTES))
            series[sym] = [[fechas[i], cier[i], sc[i]] for i in range(max(0, len(fechas) - SERIE_MAX), len(fechas))
                           if cier[i] is not None or sc[i] is not None]
        rows.append(row)
    por = {r["sym"]: r for r in rows}
    agg = por.get(AGREGADO)
    rows = [r for r in rows if r["sym"] != AGREGADO]
    st = [r["score"] for r in rows if r["stock"] and r["score"] is not None]

    def pct(cond) -> float | None:
        return round(100 * sum(1 for x in st if cond(x)) / len(st), 1) if st else None

    market = {
        "indices": {s: {k: por[s][k] for k in ("score", "z", "chg5", "n")} for s in INDICES if s in por},
        "breadth": {"n": len(st), "median": float(np.median(st)) if st else None,
                    "fear_pct": pct(lambda x: x < 20), "greed_pct": pct(lambda x: x > 80)},
        "stocks": {k: agg[k] for k in ("score", "z", "chg5", "n")} if agg else None,
    }
    # lead: sesiones con dato del ticker que más lleva (los añadidos después al historial diario van por detrás)
    return {"date": hoy, "first": fechas[0], "sessions": len(fechas), "window": VENTANA, "min_sessions": MIN_SES,
            "lead": max((r["n"] for r in rows), default=0), "min_leg": MIN_PATA,
            "market": market, "rows": rows, "expiries": venc or {}, "series": series,
            "divergences": {"bear": _resumen_div(casos_tipo["bear"], -1), "bull": _resumen_div(casos_tipo["bull"], 1),
                            "rule": {"sessions": DIV_SES, "mean": DIV_MEDIA, "points": DIV_PUNTOS}},
            "swing": swing}


# ---------------------------------------------------------------- índice en R2
def actualizar(st, sesion: str, filas: dict, venc: dict) -> int:
    """filas: {SYM: sumas}; venc: {SYM: por_vencimiento} del día (sustituye al anterior)."""
    idx = almacen.get_json(st, INDICE) or {}
    idx[sesion] = filas
    almacen.put_json(st, INDICE, dict(sorted(idx.items())))
    if venc:
        almacen.put_json(st, VENCIMIENTOS, venc)
    return len(idx)


def _dias(st, sym: str):
    """Sumas de todos los días guardados de un ticker y el desglose por vencimiento del último."""
    rx = re.compile(r"/(\d{4}-\d{2}-\d{2})\.json\.gz$")
    res, ultimo = {}, None
    for k in sorted(k for k in st.list(f"hist500/{sym}/") if rx.search(k)):
        dia = rx.search(k).group(1)
        d = almacen.get_json(st, k) or {}
        if not d.get("chain") or not d.get("spot"):
            continue
        try:
            ch = g.parse_chain({"_min": d["chain"]})
            s = float(d["spot"])
            res[dia] = sumas(ch, s, dia)
            ultimo = por_vencimiento(ch, s, dia)
        except Exception:  # noqa: BLE001  (un día roto no para el resto)
            continue
    return sym, res, ultimo


def reconstruir(st, syms: list[str]) -> int:
    """Índice desde todas las cadenas guardadas en hist500/{SYM}/ (8 lecturas en paralelo: cada una tarda ~1 s)."""
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=8) as ex:
        partes = list(ex.map(lambda s: _dias(st, s), syms))
    idx, venc = {}, {}
    for sym, res, ult in partes:
        for dia, s in res.items():
            idx.setdefault(dia, {})[sym] = s
        if ult is not None:
            venc[sym] = ult
    almacen.put_json(st, INDICE, dict(sorted(idx.items())))
    almacen.put_json(st, VENCIMIENTOS, venc)
    return len(idx)


def publicar(st) -> dict | None:
    """pub/pcr.json con el índice, los cierres del índice de skew y la prueba de la señal pcr de pub/skew.json
    (por eso se publica después de skew)."""
    idx = almacen.get_json(st, INDICE) or {}
    if not idx:
        return None
    sg = ((almacen.get_json(st, "pub/skew.json") or {}).get("signals") or {}).get("pcr")
    swing = {k: sg[k] for k in ("sign", "sessions", "eval")} if sg else None
    res = calcular(idx, almacen.get_json(st, skew.INDICE) or {}, dict(g.load_symbols()),
                   almacen.get_json(st, VENCIMIENTOS) or {}, swing)
    almacen.put_json(st, PUB, res)
    return res
