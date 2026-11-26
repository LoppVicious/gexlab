"""Movimiento esperado de las acciones del historial diario (página Expected moves).

Magnitud, no dirección. Estudio de base: pruebas/estudio_movimiento.py (2026-11-26, 487 acciones):
- el movimiento implícito de las opciones a 1 y 5 sesiones ordena muy bien el movimiento real (IC de rangos +0,46 y
  +0,78): es el ranking principal;
- el salto de varianza a plazo entre dos vencimientos detecta eventos sin calendario (resultados): correlación +0,61
  con el mayor movimiento diario siguiente, que fue de mediana 0,71 veces el implícito del evento;
- dos señales anticipaban moverse más de lo que cotizan las opciones a 5 sesiones, con solo 16 sesiones: O/S alto y
  gamma de dealers negativa frente al volumen en $. Salen como indicadores en prueba, con su prueba en adelante;
- la compresión de volatilidad (RV5/RV60 baja) no anticipa expansión: va al revés, y queda fuera.

Índice hist500/_mov.json.gz: {fecha: {SYM: [m1, m5, evento %, vencimiento del evento, sesiones hasta él,
gamma $ por 1 %, flip, cierre]}}. Lo escribe historial500.py con cada sesión (`punto`) y lo reconstruye con las
cadenas guardadas (`reconstruir`, `historial500.py --movimiento` o `--indice`). El volumen de opciones y de la
acción y los cierres salen del índice de skew (hist500/_skew.json.gz). Publica pub/movimiento.json."""
import re
from datetime import datetime

import numpy as np

import almacen
import gex_engine as g
import skew

INDICE = "hist500/_mov.json.gz"
PUB = "pub/movimiento.json"
GAMMA = ("standard", "spotgamma", "45")   # motor Perfil, posición estándar, vencimientos hasta 45 días
EVENTO_X = 2.0           # varianza a plazo de un tramo frente a la del siguiente para llamarlo evento
EVENTO_SESIONES = 10     # solo eventos dentro de las próximas 10 sesiones
H = 5                    # horizonte de la prueba en adelante (sesiones)
ADV = 20                 # sesiones del volumen medio en $
MIN_ACCIONES = 20        # acciones mínimas para puntuar una sesión
MIN_FECHAS = 20          # sesiones evaluadas para dar un veredicto
QUINTIL = 0.2            # indicadores: quintil extremo del día


# ---------------------------------------------------------------- de la cadena
def evento(ch: dict, spot: float, now: datetime) -> tuple[float, str, float] | None:
    """Evento que cotiza la estructura temporal: varianza ATM a plazo por sesión de cada tramo entre vencimientos;
    si la del primer tramo con salto es EVENTO_X veces la del tramo siguiente, el exceso es la varianza del evento.
    Devuelve (movimiento del evento en %, vencimiento que lo recoge, sesiones hasta él) o None."""
    q = g.quote_time(now)
    vivos = (ch["exp"] > np.datetime64(q.replace(second=0, microsecond=0))) & (ch["iv"] > 0.01)
    pts = []
    for ex in np.unique(ch["exp"][vivos]):
        sel = vivos & (ch["exp"] == ex)
        ks = np.unique(ch["K"][sel])
        lo, hi = ks[ks <= spot], ks[ks >= spot]
        if not lo.size or not hi.size:
            continue
        k1, k2 = lo.max(), hi.min()
        iv1, iv2 = (float(ch["iv"][sel & (ch["K"] == k)].mean()) for k in (k1, k2))
        iv = iv1 if k2 == k1 else iv1 + (iv2 - iv1) * (spot - k1) / (k2 - k1)
        exd = ex.astype("datetime64[m]").astype(datetime)
        n = g.trading_minutes(q, exd) / g.SESSION_MIN
        if n < 0.5 or iv <= 0:
            continue
        pts.append((n, iv * iv * (exd - q).total_seconds() / 60 / g.YEAR_MIN, str(ex.astype("datetime64[D]"))))
        if n > EVENTO_SESIONES + 15:
            break
    pts.sort()
    previo = (0.0, 0.0)
    tramos = []  # (sesiones al final del tramo, duración, varianza a plazo por sesión, vencimiento)
    for n, w, ex in pts:
        if n - previo[0] >= 0.9:   # vencimientos del mismo día o casi: el tramo no mide nada
            tramos.append((n, n - previo[0], (w - previo[1]) / (n - previo[0]), ex))
            previo = (n, w)
    for (n, dn, f, ex), (_, _, f2, _) in zip(tramos, tramos[1:]):
        if n > EVENTO_SESIONES:
            break
        if f2 > 0 and f > EVENTO_X * f2:
            return float(np.sqrt((f - f2) * dn) * 100), ex, float(n)
    return None


def punto(ch: dict, spot: float, sesion: str, niveles: dict | None) -> list | None:
    """Fila del índice de una acción al cierre de `sesion`."""
    now = datetime.fromisoformat(sesion + "T16:00")
    mv = g.implied_moves(ch, spot, now) or {}
    m1, m5 = ((mv.get(k) or {}).get("pct") for k in ("d1", "d5"))
    if not m1 and not m5:
        return None
    ev = evento(ch, spot, now)
    lv = (((niveles or {}).get(GAMMA[0]) or {}).get(GAMMA[1]) or {}).get(GAMMA[2]) or {}
    r = lambda x, n=4: None if x is None else round(float(x), n)  # noqa: E731
    return [r(m1), r(m5), r(ev[0]) if ev else None, ev[1] if ev else None, r(ev[2], 2) if ev else None,
            r(lv.get("net_per_pct"), 0), r(lv.get("flip")), r(spot)]


# ---------------------------------------------------------------- índice en R2
def actualizar(st, sesion: str, filas: dict[str, list]) -> int:
    idx = almacen.get_json(st, INDICE) or {}
    idx[sesion] = filas
    almacen.put_json(st, INDICE, dict(sorted(idx.items())))
    return len(idx)


def _dias(st, sym: str) -> tuple[str, dict]:
    rx = re.compile(r"/(\d{4}-\d{2}-\d{2})\.json\.gz$")
    out = {}
    for k in st.list(f"hist500/{sym}/"):
        m = rx.search(k)
        if not m:
            continue
        d = almacen.get_json(st, k) or {}
        if not d.get("chain") or not d.get("spot"):
            continue
        try:
            p = punto(g.parse_chain({"_min": d["chain"]}), float(d["spot"]), m.group(1), d.get("levels"))
        except Exception:  # noqa: BLE001  (un día roto no para el resto)
            continue
        if p:
            out[m.group(1)] = p
    return sym, out


def reconstruir(st, syms: list[str]) -> int:
    """Índice desde todas las cadenas guardadas (16 lecturas en paralelo: cada una tarda ~1 s desde GitHub)."""
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=16) as ex:
        partes = list(ex.map(lambda s: _dias(st, s), syms))
    idx: dict[str, dict] = {}
    for sym, dias in partes:
        for dia, p in dias.items():
            idx.setdefault(dia, {})[sym] = p
    almacen.put_json(st, INDICE, dict(sorted(idx.items())))
    return len(idx)


# ---------------------------------------------------------------- cálculo
def _rangos(x: np.ndarray) -> np.ndarray:
    return np.argsort(np.argsort(x, kind="stable"), kind="stable").astype(float)


def _os(fila: list | None) -> float | None:
    """log(O/S) de una fila del índice de skew (contratos × 100 / acciones)."""
    return float(np.log(fila[4] * 100 / fila[5])) if fila and len(fila) > 5 and fila[4] and fila[5] else None


def _adv(sk: dict, fechas: list[str], i: int, sym: str) -> float | None:
    """Volumen medio en $ de las ADV sesiones hasta fechas[i] (acciones × cierre del índice de skew)."""
    dv = []
    for f in fechas[max(0, i - ADV + 1):i + 1]:
        v = (sk.get(f) or {}).get(sym)
        if v and len(v) > 5 and v[2] and v[5]:
            dv.append(v[2] * v[5])
    return float(np.mean(dv)) if len(dv) >= 5 else None


def _evaluar(x: list[np.ndarray], y: list[np.ndarray], signo: int) -> dict:
    """IC de rangos por sesión entre la señal (×signo: alto = se espera más movimiento) y realizado/implícito, t de
    Newey-West y media del cociente en el quintil alto y en el bajo."""
    ics, alto, bajo = [], [], []
    for a, b in zip(x, y):
        m = np.isfinite(a) & np.isfinite(b)
        if m.sum() < MIN_ACCIONES or np.ptp(a[m]) == 0:
            continue
        s, r = a[m] * signo, b[m]
        ics.append(float(np.corrcoef(_rangos(s), _rangos(r))[0, 1]))
        q = _rangos(s) / max(m.sum() - 1, 1)
        alto += list(r[q >= 1 - QUINTIL])
        bajo += list(r[q <= QUINTIL])
    ic = np.array(ics)
    t = skew._t_nw(ic, H) if ic.size >= 3 else None
    return {"n": int(ic.size), "need": MIN_FECHAS, "enough": ic.size >= MIN_FECHAS,
            "ic": round(float(ic.mean()), 4) if ic.size else None, "t": None if t is None else round(t, 2),
            "top": round(float(np.mean(alto)), 3) if alto else None,
            "bottom": round(float(np.mean(bajo)), 3) if bajo else None}


def calcular(idx: dict, sk: dict, nombres: dict) -> dict:
    fechas_m = sorted(idx)
    fechas_s = sorted(set(sk) | set(idx))
    pos = {f: i for i, f in enumerate(fechas_s)}
    hoy = fechas_m[-1]
    acciones = sorted({s for d in idx.values() for s in d if skew.es_accion(s, nombres)})
    col = {s: j for j, s in enumerate(acciones)}

    def cierre(f, s):
        v = (sk.get(f) or {}).get(s)
        return v[2] if v and len(v) > 2 and v[2] else np.nan

    # prueba en adelante de los indicadores y de los eventos
    xo, xg, yr, ev_ratio = [], [], [], []
    for f in fechas_m:
        i = pos[f]
        if i + H >= len(fechas_s):
            continue
        os_, ga, ratio = (np.full(len(acciones), np.nan) for _ in range(3))
        for s, v in idx[f].items():
            j = col.get(s)
            if j is None:
                continue
            c = np.array([cierre(fechas_s[k], s) for k in range(i, i + H + 1)])
            if not np.isfinite(c).all() or (c <= 0).any():
                continue
            r = np.diff(np.log(c))
            if (np.abs(r) > np.log(1.5)).any():   # split o dato roto
                continue
            if v[1]:
                ratio[j] = float(np.sqrt((r ** 2).sum()) * 100 / v[1])
            if v[2] and v[4] is not None and v[4] <= H:
                ev_ratio.append(float(np.abs(r).max() * 100 / v[2]))
            o = _os((sk.get(f) or {}).get(s))
            os_[j] = np.nan if o is None else o
            a = _adv(sk, fechas_s, i, s)
            if v[5] is not None and a:
                ga[j] = v[5] / a
        xo.append(os_)
        xg.append(ga)
        yr.append(ratio)
    prueba = {
        "heavy": _evaluar(xo, yr, 1),       # O/S alto: se espera más movimiento que el implícito
        "short": _evaluar(xg, yr, -1),      # gamma negativa frente al volumen: ídem
        "events": {"n": len(ev_ratio), "median": round(float(np.median(ev_ratio)), 3) if ev_ratio else None},
        "ratio": round(float(np.nanmedian(np.concatenate(yr))), 3) if yr and np.isfinite(np.concatenate(yr)).any() else None,
    }

    # ranking de hoy
    i = pos[hoy]
    filas = []
    for s in acciones:
        v = idx[hoy].get(s)
        if not v:
            continue
        o = _os((sk.get(hoy) or {}).get(s))
        o_dia = hoy
        if o is None and i > 0:   # el volumen de la acción del día puede llegar una sesión tarde
            o, o_dia = _os((sk.get(fechas_s[i - 1]) or {}).get(s)), fechas_s[i - 1]
        a = _adv(sk, fechas_s, i, s)
        filas.append({"sym": s, "name": nombres.get(s), "spot": v[7], "m1": v[0], "m5": v[1],
                      "ev": v[2], "ev_exp": v[3], "ev_n": v[4],
                      "gadv": None if v[5] is None or not a else round(v[5] / a, 5),
                      "below_flip": None if not v[6] else v[7] < v[6], "flip": v[6],
                      "os": None if o is None else round(float(np.exp(o)), 4), "os_date": o_dia if o is not None else None})
    for k, signo, flag in (("os", 1, "heavy"), ("gadv", -1, "short")):
        con = [f for f in filas if f[k] is not None]
        if len(con) < MIN_ACCIONES:
            continue
        q = _rangos(np.array([f[k] * signo for f in con])) / (len(con) - 1)
        for f, p in zip(con, q):
            if p >= 1 - QUINTIL and (flag != "short" or f["gadv"] < 0):
                f.setdefault("flags", []).append(flag)
    return {"date": hoy, "sessions": len(fechas_m), "first": fechas_m[0], "horizon": H,
            "thresholds": {"event_x": EVENTO_X, "event_sessions": EVENTO_SESIONES, "quintile": QUINTIL},
            "test": prueba, "rows": filas}


def publicar(st) -> dict | None:
    idx = almacen.get_json(st, INDICE) or {}
    if not idx:
        return None
    res = calcular(idx, almacen.get_json(st, skew.INDICE) or {}, dict(g.load_symbols()))
    almacen.put_json(st, PUB, res)
    return res
