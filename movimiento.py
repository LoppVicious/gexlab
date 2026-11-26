"""Movimiento esperado de las acciones del historial diario (página Expected moves).

Magnitud, no dirección. Estudio de base: pruebas/estudio_movimiento.py (2026-11-26, 487 acciones):
- el movimiento implícito de las opciones a 1 y 5 sesiones ordena muy bien el movimiento real (IC de rangos +0,46 y
  +0,78): es el ranking principal;
- el salto de varianza a plazo entre dos vencimientos detecta eventos sin calendario (resultados): correlación +0,61
  con el mayor movimiento diario siguiente, que fue de mediana 0,71 veces el implícito del evento;
- dos señales anticipaban moverse más de lo que cotizan las opciones a 5 sesiones, con solo 16 sesiones: O/S alto y
  gamma de dealers negativa frente al volumen en $. Salen como indicadores en prueba, con su prueba en adelante;
- la compresión de volatilidad (RV5/RV60 baja) no anticipa expansión: va al revés, y queda fuera.

Volumen de la acción (2026-11-26, idea de Pau): un movimiento con el volumen de la acción muy por encima de su media,
vela de rango amplio y cierre cerca del máximo tiene continuidad; con mucho volumen de opciones y poco de la acción
suele quedarse en un rebote contenido. RVol = acciones del día / media de las ADV sesiones previas; rango = (máximo −
mínimo) / su media de las ADV sesiones previas; posición del cierre = (cierre − mínimo) / (máximo − mínimo).
Etiquetas "confirmed" (RVOL_MIN, RANGO_MIN y CIERRE_ALTO a la vez) y "options" (O/S en el quinto alto con RVol de como
mucho RVOL_BAJO). En prueba: IC de RVol frente a realizado/implícito y, por etiqueta, cuánto se movieron frente a lo
implícito y su rendimiento a H sesiones frente a la media de las demás acciones del día. Las velas diarias (máximo,
mínimo, cierre y volumen) salen del histórico diario (`velas`: Tradier en Actions), no de un índice.

Índice hist500/_mov.json.gz: {fecha: {SYM: [m1, m5, evento %, vencimiento del evento, sesiones hasta él,
gamma $ por 1 %, flip, cierre, m21]}} (m21: un mes, 21 sesiones; las filas antiguas no lo tienen). Lo escribe historial500.py con cada sesión (`punto`) y lo reconstruye con las
cadenas guardadas (`reconstruir`, `historial500.py --movimiento` o `--indice`). El volumen de opciones y de la
acción y los cierres salen del índice de skew (hist500/_skew.json.gz). Publica pub/movimiento.json."""
import re
from datetime import datetime, timedelta

import numpy as np

import almacen
import gex_engine as g
import skew

INDICE = "hist500/_mov.json.gz"
PUB = "pub/movimiento.json"
GAMMA = ("standard", "spotgamma", "45")   # motor Perfil, posición estándar, vencimientos hasta 45 días
EVENTO_X = 2.0           # varianza a plazo de un tramo frente a la del siguiente para llamarlo evento
EVENTO_SESIONES = 10     # solo eventos dentro de las próximas 10 sesiones
# peso de un día sin mercado (fin de semana, festivo) frente a una sesión en la varianza que cotizan las opciones.
# Sin él, el tramo del 2026-11-25 al 30 (Acción de Gracias y fin de semana: 1,5 sesiones en 5 días) daba "eventos"
# en AAPL, GOOGL, AMZN y TSLA; con las cadenas de ese día (pruebas/estudio_evento.py) sale entre 0,25 y 0,35
FIN_DE_SEMANA = 0.3
MES = 21                 # sesiones de un mes (252 / 12) para el movimiento a un mes
H = 5                    # horizonte de la prueba en adelante (sesiones)
ADV = 20                 # sesiones del volumen medio en $
MIN_ACCIONES = 20        # acciones mínimas para puntuar una sesión
MIN_FECHAS = 20          # sesiones evaluadas para dar un veredicto
QUINTIL = 0.2            # indicadores: quintil extremo del día
RVOL_MIN = 1.5           # confirmed: volumen de la acción frente a su media de ADV sesiones previas
RANGO_MIN = 1.2          # confirmed: rango del día frente a su media de ADV sesiones previas
CIERRE_ALTO = 0.75       # confirmed: cierre en el cuarto alto del rango del día
RVOL_BAJO = 1.0          # options: O/S en el quinto alto con la acción a su volumen normal o por debajo


# ---------------------------------------------------------------- de la cadena
def semanal(d: datetime) -> bool:
    """Vencimiento semanal estándar: viernes, o jueves con el viernes festivo."""
    return d.weekday() == 4 or (d.weekday() == 3 and not g.is_trading_day(d + timedelta(days=1)))


def evento(ch: dict, spot: float, now: datetime) -> tuple[float, str, float] | None:
    """Evento que cotiza la estructura temporal: varianza ATM a plazo de cada tramo entre vencimientos semanales por
    unidad de tiempo efectivo (sesiones + FIN_DE_SEMANA por cada día sin mercado); si la del primer tramo con salto
    es EVENTO_X veces la del tramo siguiente, el exceso es la varianza del evento.
    Solo vencimientos semanales (viernes, o jueves si el viernes es festivo): los diarios de lunes y miércoles de las
    acciones grandes cotizan menos IV que el viernes y la sierra daba eventos falsos (MSFT, AMZN o TSLA "by Dec 4"
    con las cadenas del 2026-11-25).
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
        if not semanal(exd):
            continue
        n = g.trading_minutes(q, exd) / g.SESSION_MIN
        if n < 0.5 or iv <= 0:
            continue
        dias = (exd - q).total_seconds() / 86400
        pts.append((n, iv * iv * dias * 1440 / g.YEAR_MIN, str(ex.astype("datetime64[D]")), dias))
        if n > EVENTO_SESIONES + 15:
            break
    pts.sort()
    previo = (0.0, 0.0, 0.0)
    tramos = []  # (sesiones al final del tramo, tiempo efectivo, varianza a plazo por unidad, vencimiento)
    for n, w, ex, dias in pts:
        dn = n - previo[0]
        if dn >= 0.9:   # vencimientos del mismo día o casi: el tramo no mide nada
            dt = dn + FIN_DE_SEMANA * max(0.0, (dias - previo[2]) - dn)
            tramos.append((n, dt, (w - previo[1]) / dt, ex))
            previo = (n, w, dias)
    for (n, dn, f, ex), (_, _, f2, _) in zip(tramos, tramos[1:]):
        if n > EVENTO_SESIONES:
            break
        if f2 > 0 and f > EVENTO_X * f2:
            return float(np.sqrt((f - f2) * dn) * 100), ex, float(n)
    return None


def punto(ch: dict, spot: float, sesion: str, niveles: dict | None) -> list | None:
    """Fila del índice de una acción al cierre de `sesion`."""
    now = datetime.fromisoformat(sesion + "T16:00")
    mv = g.implied_moves(ch, spot, now, (1, 5, MES)) or {}
    m1, m5, m21 = ((mv.get(k) or {}).get("pct") for k in ("d1", "d5", f"d{MES}"))
    if not m1 and not m5:
        return None
    ev = evento(ch, spot, now)
    lv = (((niveles or {}).get(GAMMA[0]) or {}).get(GAMMA[1]) or {}).get(GAMMA[2]) or {}
    r = lambda x, n=4: None if x is None else round(float(x), n)  # noqa: E731
    return [r(m1), r(m5), r(ev[0]) if ev else None, ev[1] if ev else None, r(ev[2], 2) if ev else None,
            r(lv.get("net_per_pct"), 0), r(lv.get("flip")), r(spot), r(m21)]


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


def velas(syms: list[str], desde: str) -> dict:
    """Velas diarias desde `desde` del histórico (Tradier en Actions; sin token, vacío):
    {SYM: {"i": {fecha: fila}, "a": array de filas [máximo, mínimo, cierre, acciones]}}."""
    out = {}
    for s in syms:
        try:
            h = (g.fetch_aux("historical", s, ttl=3600) or {}).get("data") or []
        except Exception:  # noqa: BLE001  (un ticker sin histórico no para el resto)
            continue
        fechas, filas = [], []
        for r in h:
            try:
                hi, lo, c, v = (float(r.get(k) or 0) for k in ("high", "low", "close", "volume"))
            except (TypeError, ValueError):
                continue
            if r.get("date", "") >= desde and c > 0 and hi >= lo > 0 and v > 0:
                fechas.append(r["date"])
                filas.append((hi, lo, c, v))
        if filas:
            out[s] = {"i": {f: j for j, f in enumerate(fechas)}, "a": np.array(filas)}
    return out


def _vela(v: dict | None, fecha: str) -> dict | None:
    """RVol, rango relativo y posición del cierre de la vela de `fecha` frente a las ADV sesiones previas."""
    j = v["i"].get(fecha) if v else None
    if j is None or j < ADV:
        return None
    a = v["a"]
    hi, lo, c, vol = a[j]
    previas = a[j - ADV:j]
    mv, mr = float(previas[:, 3].mean()), float((previas[:, 0] - previas[:, 1]).mean())
    if mv <= 0 or mr <= 0:
        return None
    rango = hi - lo
    return {"rvol": float(vol / mv), "range": float(rango / mr), "pos": float((c - lo) / rango) if rango > 0 else 0.5}


def confirmada(x: dict | None) -> bool:
    return bool(x) and x["rvol"] >= RVOL_MIN and x["range"] >= RANGO_MIN and x["pos"] >= CIERRE_ALTO


def _quinto_alto(x: np.ndarray) -> np.ndarray:
    """Máscara del quinto alto del día entre los valores finitos (toda falsa con menos de MIN_ACCIONES)."""
    m = np.isfinite(x)
    out = np.zeros(len(x), bool)
    if m.sum() >= MIN_ACCIONES:
        out[np.where(m)[0][_rangos(x[m]) / (m.sum() - 1) >= 1 - QUINTIL]] = True
    return out


def _casos(c: list[tuple[float, float]]) -> dict:
    """Casos de una etiqueta: (realizado/implícito, rendimiento a H sesiones − media del día, en puntos %)."""
    r = np.array([x[0] for x in c if np.isfinite(x[0])])
    e = np.array([x[1] for x in c if np.isfinite(x[1])])
    return {"n": len(c), "need": MIN_FECHAS, "enough": len(c) >= MIN_FECHAS,
            "ratio": round(float(np.median(r)), 3) if r.size else None,
            "excess": round(float(e.mean()), 3) if e.size else None,
            "hit": round(float((e > 0).mean()), 3) if e.size else None}


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


def calcular(idx: dict, sk: dict, nombres: dict, vl: dict | None = None) -> dict:
    """vl: velas diarias de `velas` (sin ellas, sin RVol ni sus etiquetas)."""
    vl = vl or {}
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
    xo, xg, xv, yr, ev_ratio = [], [], [], [], []
    casos = {"confirmed": [], "options": []}
    for f in fechas_m:
        i = pos[f]
        if i + H >= len(fechas_s):
            continue
        os_, ga, ratio, rv, ret = (np.full(len(acciones), np.nan) for _ in range(5))
        conf = np.zeros(len(acciones), bool)
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
            ret[j] = float(r.sum() * 100)
            if v[1]:
                ratio[j] = float(np.sqrt((r ** 2).sum()) * 100 / v[1])
            if v[2] and v[4] is not None and v[4] <= H:
                ev_ratio.append(float(np.abs(r).max() * 100 / v[2]))
            o = _os((sk.get(f) or {}).get(s))
            os_[j] = np.nan if o is None else o
            a = _adv(sk, fechas_s, i, s)
            if v[5] is not None and a:
                ga[j] = v[5] / a
            x = _vela(vl.get(s), f)
            if x:
                rv[j], conf[j] = np.log(x["rvol"]), confirmada(x)
        media = float(np.nanmean(ret)) if np.isfinite(ret).sum() >= MIN_ACCIONES else np.nan
        opc = _quinto_alto(os_) & np.isfinite(rv) & (rv <= np.log(RVOL_BAJO))
        for k, m in (("confirmed", conf), ("options", opc)):
            casos[k] += [(ratio[j], ret[j] - media) for j in np.where(m)[0]]
        xo.append(os_)
        xg.append(ga)
        xv.append(rv)
        yr.append(ratio)
    prueba = {
        "heavy": _evaluar(xo, yr, 1),       # O/S alto: se espera más movimiento que el implícito
        "short": _evaluar(xg, yr, -1),      # gamma negativa frente al volumen: ídem
        "rvol": _evaluar(xv, yr, 1),        # volumen de la acción alto frente a su media: ídem
        "confirmed": _casos(casos["confirmed"]),
        "options": _casos(casos["options"]),
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
        x, x_dia = _vela(vl.get(s), hoy), hoy
        if x is None and i > 0:   # la vela del día puede llegar una sesión tarde, como el volumen
            x, x_dia = _vela(vl.get(s), fechas_s[i - 1]), fechas_s[i - 1]
        filas.append({"sym": s, "name": nombres.get(s), "spot": v[7], "m1": v[0], "m5": v[1],
                      "m21": v[8] if len(v) > 8 else None,
                      "ev": v[2], "ev_exp": v[3], "ev_n": v[4],
                      "gadv": None if v[5] is None or not a else round(v[5] / a, 5),
                      "below_flip": None if not v[6] else v[7] < v[6], "flip": v[6],
                      "os": None if o is None else round(float(np.exp(o)), 4), "os_date": o_dia if o is not None else None,
                      "rvol": None if x is None else round(x["rvol"], 3),
                      "range": None if x is None else round(x["range"], 3),
                      "close_pos": None if x is None else round(x["pos"], 3),
                      "candle_date": x_dia if x is not None else None, "_conf": confirmada(x)})
    for k, signo, flag in (("os", 1, "heavy"), ("gadv", -1, "short")):
        con = [f for f in filas if f[k] is not None]
        if len(con) < MIN_ACCIONES:
            continue
        q = _rangos(np.array([f[k] * signo for f in con])) / (len(con) - 1)
        for f, p in zip(con, q):
            if p >= 1 - QUINTIL and (flag != "short" or f["gadv"] < 0):
                f.setdefault("flags", []).append(flag)
    for f in filas:
        if f.pop("_conf"):
            f.setdefault("flags", []).append("confirmed")
        if "heavy" in f.get("flags", []) and f["rvol"] is not None and f["rvol"] <= RVOL_BAJO:
            f["flags"].append("options")
    return {"date": hoy, "sessions": len(fechas_m), "first": fechas_m[0], "horizon": H,
            "thresholds": {"event_x": EVENTO_X, "event_sessions": EVENTO_SESIONES, "quintile": QUINTIL,
                           "rvol_min": RVOL_MIN, "range_min": RANGO_MIN, "close_high": CIERRE_ALTO,
                           "rvol_low": RVOL_BAJO, "adv": ADV},
            "test": prueba, "rows": filas}


def publicar(st) -> dict | None:
    idx = almacen.get_json(st, INDICE) or {}
    if not idx:
        return None
    nombres = dict(g.load_symbols())
    syms = sorted({s for d in idx.values() for s in d if skew.es_accion(s, nombres)})
    desde = str(np.datetime64(min(idx)) - np.timedelta64(2 * ADV, "D"))   # unas ADV sesiones antes del primer día
    res = calcular(idx, almacen.get_json(st, skew.INDICE) or {}, nombres, velas(syms, desde))
    almacen.put_json(st, PUB, res)
    return res
