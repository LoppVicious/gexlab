"""Señales de opciones para swings en acciones: skew de puts, diferencia de IV call-put y volumen de opciones.

Son señales transversales: ordenan las acciones del historial diario entre sí cada sesión; no predicen el mercado.

  skew de puts (Xing, Zhang y Zhao, 2010): cuando las puts fuera de dinero se encarecen frente a las de en el
    dinero, alguien paga por protección y la acción tiende a ir peor que las demás. skew = IV put 25 delta − IV ATM,
    solo con contratos de horquilla estrecha (SK_HORQUILLA).
    Hipótesis: IC negativo.
  diferencia call-put (Cremers y Weinbaum, 2010): media ponderada por OI de IV call − IV put del mismo strike, en
    strikes a ±5 % del spot con horquilla de como mucho el 25 % en las dos patas. Si las calls están caras frente a
    las puts (desvío de la paridad), hay compra informada y la acción tiende a ir mejor. Hipótesis: IC positivo.
    Usa la IV de CBOE (`iv_raw`): la del motor sale del forward implícito por paridad y su diferencia es cero por
    construcción; con un forward sin dividendos salen desvíos de varios puntos por el desfase entre el cierre del
    subyacente y el de las opciones. La de CBOE no castiga a las acciones con dividendo (KO, PFE), pero en las
    opciones dentro del dinero con horquilla ancha es ruido: con ±10 % y sin filtro, GILD salía +1,8 por calls de
    140-165 con 2 $ de horquilla (la de 140 al 51 % frente a la put al 33 %) y BKNG −7,1.
  volumen de opciones frente a acciones, O/S (Johnson y So, 2012): log(contratos negociados × 100 / acciones
    negociadas) del día. Quien tiene información negativa la opera en opciones (vender acciones en corto cuesta más),
    así que un O/S alto anticipa que la acción irá peor. Hipótesis: IC negativo. Todas las series y vencimientos.
  prima de volatilidad, Vol premium (Goyal y Saretto, 2009): IV ATM a 30 días − volatilidad realizada de RV_DIAS
    sesiones (cierre a cierre, anualizada, con los cierres del índice). No es direccional: su prueba en adelante no
    mira el rendimiento sino la prima cobrada, IV de hoy − volatilidad realizada de las sesiones siguientes. Hipótesis:
    IC positivo (con la prima alta, la volatilidad realizada queda más por debajo de la IV). No vota en el consenso.

Skew y call-put, con la cadena del cierre que guarda historial500.py, en el mensual estándar más cercano a 30 días
entre 14 y 60 (los semanales de acciones poco líquidas dan alas sin sentido: JD tenía una put de 25 delta al 116 % con
el ATM al 45 %). Puntuación = media del percentil transversal del nivel y de su cambio en 5 sesiones (0 a 1).
Solo acciones: fuera índices, VIX y ETF.

Índice: hist500/_skew.json.gz = {fecha: {SYM: [atm, put25, cierre, call−put, contratos, acciones]}} (None donde no
se puede medir); se reconstruye con los días guardados (el volumen de la acción de días pasados, del histórico
diario de CBOE) y PREHIST sesiones anteriores solo con el cierre (de CBOE), para que la volatilidad realizada salga
desde el primer día; después el ciclo diario la mantiene con sus propios cierres. Prueba en adelante con los cierres del índice: IC = correlación de rangos entre
puntuación y rendimiento a 10 y 40 sesiones (unas dos semanas y unos dos meses: plazos de swing), con t de Newey-West
(las ventanas se solapan), y diferencial = quintil alto − quintil bajo. Diagnóstico por señal (`diag`): la misma prueba
solo con el nivel, solo con el cambio y con la puntuación neutralizada por el rendimiento de las CAMBIO sesiones
previas, para saber por qué falla una señal si falla. Publica pub/skew.json (/api/skew)."""
from __future__ import annotations

import re
from datetime import datetime

import numpy as np

import almacen
import gex_engine as g
import volatilidad

INDICE = "hist500/_skew.json.gz"
DIAS_MIN, DIAS_MAX = 14, 60     # ventana del vencimiento mensual (días naturales)
CP_BANDA = 0.05                 # strikes a ±5 % del spot para la diferencia call-put
CP_HORQUILLA = 0.25             # horquilla máxima de cada pata, en fracción del punto medio
CP_MIN_PARES = 2
# horquilla máxima de los contratos del skew: las puts lejanas son baratas y su horquilla relativa es mayor, por eso
# más holgada que la de call-put. Con 0,35 se quedan sin lectura GILD, HON, NTES, XPEV, PM, JD, BIDU y BKNG (alas de
# opciones poco líquidas) y las líquidas no cambian; con 0,25 caían también PEP, AMGN, TMUS o FTNT
SK_HORQUILLA = 0.35
CAMBIO = 5                      # sesiones para el cambio
HORIZONTES = (10, 40)           # sesiones de la prueba en adelante: unas dos semanas y unos dos meses (swing)
MIN_TICKERS = 20                # acciones mínimas para puntuar una sesión
MIN_FECHAS = 20                 # sesiones evaluadas mínimas para dar un veredicto (y nunca menos que el horizonte:
                                # las ventanas se solapan y a 40 sesiones, 20 serían media ventana independiente)
SALTO = 0.5                     # |rendimiento| mayor: split o dato roto, fuera
RV_DIAS = 20                    # sesiones de la volatilidad realizada de la prima de volatilidad
PREHIST = 45                    # sesiones previas solo con el cierre que añade la reconstrucción (para la RV)
# señal: nivel por acción a partir de la fila del índice, y signo del IC que espera la hipótesis
SENALES = {
    "skew": (lambda v: v[1] - v[0] if v[0] is not None and v[1] is not None else None, -1),
    "cp": (lambda v: v[3] if len(v) > 3 else None, 1),
    "os": (lambda v: float(np.log(v[4] * 100 / v[5])) if len(v) > 5 and v[4] and v[5] else None, -1),
}
# señales de volatilidad (no direccionales, no votan en el consenso): nivel con la RV que añade _con_rv en v[6], signo
# esperado del IC y objetivo de la prueba en adelante ("rv": IV de hoy − volatilidad realizada siguiente)
SENALES_VOL = {
    "vrp": (lambda v: v[0] - v[6] if len(v) > 6 and v[0] is not None and v[6] is not None else None, 1),
}
_FONDO = re.compile(r"\b(ETF|ETN|SPDR|Ishares|Proshares|Direxion|Vaneck|Kraneshares|Invesco|Fd|Fund|Trust|Tr)\b", re.I)
_EMPRESA = re.compile(r"\b(Inc|Corp|Ltd|Hldgs?|Plc|Co|Group|Holdings|Ads)\b", re.I)


def es_accion(sym: str, nombres: dict[str, str]) -> bool:
    if sym in g.INDEX_SYMBOLS or sym in g.CBOE_VOL_INDICES or sym in g.INDEX_PROXY.values():
        return False
    n = nombres.get(sym) or ""
    if re.search(r"\b(ETF|ETN)\b", n, re.I):  # "Ishares Inc Msci Sth Kor ETF" lleva Inc y es un fondo
        return False
    return not (_FONDO.search(n) and not _EMPRESA.search(n))


def _call_put(ch: dict, dia: str, spot: float) -> float | None:
    """Media ponderada por OI de IV call − IV put (de CBOE) en los strikes del vencimiento a ±CP_BANDA del spot con
    las dos patas cotizadas y horquilla de como mucho CP_HORQUILLA."""
    m = ch["exp"].astype("datetime64[D]") == np.datetime64(dia)
    K, C, oi, iv = ch["K"][m], ch["call"][m], ch["oi"][m], ch["iv_raw"][m]
    bid, ask = ch["bid"][m], ch["ask"][m]
    estrecha = (bid > 0) & (ask >= bid) & ((ask - bid) <= CP_HORQUILLA * (ask + bid) / 2)
    num = den = 0.0
    n = 0
    for k in np.unique(K):
        if abs(np.log(k / spot)) > CP_BANDA:
            continue
        c, p = np.where((K == k) & C)[0], np.where((K == k) & ~C)[0]
        if not len(c) or not len(p):
            continue
        c, p = c[0], p[0]
        w = oi[c] + oi[p]
        if w <= 0 or not (estrecha[c] and estrecha[p]) or not (0.01 < iv[c] < 5 and 0.01 < iv[p] < 5):
            continue
        num += w * (iv[c] - iv[p])
        den += w
        n += 1
    return round(num / den, 5) if n >= CP_MIN_PARES and den > 0 else None


def _estrechas(ch: dict, maximo: float) -> dict:
    """La cadena solo con los contratos cotizados con horquilla de como mucho `maximo` del punto medio."""
    b, a = ch["bid"], ch["ask"]
    m = (b > 0) & (a >= b) & ((a - b) <= maximo * (a + b) / 2)
    n = len(m)
    return {k: (x[m] if isinstance(x, np.ndarray) and x.shape[:1] == (n,) else x) for k, x in ch.items()}


def punto(ch: dict, spot: float, now: datetime) -> list | None:
    """[IV ATM, IV put 25 delta, IV call − IV put] del mensual más cercano a 30 días (None donde no se puede).
    El vencimiento se elige con la cadena completa; el skew sale solo de contratos con horquilla de como mucho
    SK_HORQUILLA (si no quedan strikes suficientes, sin lectura)."""
    sm = [s for s in volatilidad.smiles_from_chain(ch, spot, now)
          if s.get("monthly") and DIAS_MIN <= s["dte"] <= DIAS_MAX]
    if not sm:
        return None
    exp = min(sm, key=lambda x: abs(x["dte"] - 30))["exp"]
    s = next((x for x in volatilidad.smiles_from_chain(_estrechas(ch, SK_HORQUILLA), spot, now) if x["exp"] == exp), None)
    atm, p25 = (volatilidad.atm_iv(s, spot), volatilidad.iv_at_delta(s, -0.25)) if s else (None, None)
    cp = _call_put(ch, exp, spot) if "iv_raw" in ch else None
    out = [round(atm, 5) if atm else None, round(p25, 5) if p25 else None, cp]
    return out if any(x is not None for x in out) else None


# ---------------------------------------------------------------- índice en R2
def fila(p: list | None, cierre: float, contratos: float | None, acciones: float | None) -> list:
    """Fila del índice: [atm, put25, cierre, call−put, contratos de opciones, acciones] (volúmenes del día)."""
    p = p or [None, None, None]
    return [p[0], p[1], float(cierre), p[2], float(contratos) if contratos else None,
            float(acciones) if acciones else None]


def actualizar(st, sesion: str, puntos: dict[str, list]) -> int:
    """puntos: {SYM: fila}."""
    idx = almacen.get_json(st, INDICE) or {}
    idx[sesion] = puntos
    almacen.put_json(st, INDICE, dict(sorted(idx.items())))
    return len(idx)


def reconstruir(st, syms: list[str]) -> int:
    """Índice desde todas las cadenas guardadas en hist500/{SYM}/ (lento: una lectura por ticker y día)."""
    rx = re.compile(r"/(\d{4}-\d{2}-\d{2})\.json\.gz$")
    previo = almacen.get_json(st, INDICE) or {}   # conserva volúmenes que el histórico de CBOE aún no tenga
    idx: dict[str, dict] = {}
    for sym in syms:
        claves = [k for k in st.list(f"hist500/{sym}/") if rx.search(k)]
        if not claves:
            continue
        try:  # volumen y cierre de la acción de cada día (los archivos del historial no guardan el volumen)
            hist = (g.fetch_aux("historical", sym, ttl=6 * 3600) or {}).get("data", [])
            vol = {r["date"]: float(r.get("volume") or 0) for r in hist}
            cierres = {r["date"]: float(r.get("close") or 0) for r in hist}
        except Exception:  # noqa: BLE001
            vol, cierres = {}, {}
        for k in claves:
            dia = rx.search(k).group(1)
            d = almacen.get_json(st, k) or {}
            if not d.get("chain") or not d.get("spot"):
                continue
            try:
                ch = g.parse_chain({"_min": d["chain"]})
                p = punto(ch, float(d["spot"]), datetime.fromisoformat(dia + "T16:00"))
            except Exception:  # noqa: BLE001  (un día roto no para el resto)
                continue
            ov = float(ch["vol"].sum())
            antes = (previo.get(dia) or {}).get(sym) or []
            sv = vol.get(dia) or (antes[5] if len(antes) > 5 else None)
            if p or (ov and sv):
                idx.setdefault(dia, {})[sym] = fila(p, d["spot"], ov, sv)
        # PREHIST sesiones anteriores al primer día guardado, solo con el cierre: la volatilidad realizada de la prima
        # de volatilidad sale así desde el primer día (las demás señales las ignoran: no tienen IV ni volumen)
        primero = min((rx.search(k).group(1) for k in claves), default=None)
        for dia in [f for f in sorted(cierres) if primero and f < primero and cierres[f] > 0][-PREHIST:]:
            idx.setdefault(dia, {}).setdefault(sym, fila(None, cierres[dia], None, None))
    almacen.put_json(st, INDICE, dict(sorted(idx.items())))
    return sum(1 for d in idx.values() if any(v[0] is not None or v[4] for v in d.values()))


# ---------------------------------------------------------------- señales y prueba en adelante
def _pct(x: np.ndarray) -> np.ndarray:
    """Percentil transversal (0 a 1)."""
    o = np.argsort(np.argsort(x, kind="stable"), kind="stable").astype(float)
    return o / max(len(x) - 1, 1)


def _t_nw(x: np.ndarray, lags: int) -> float | None:
    """t de la media con Newey-West (la serie de IC se solapa cuando el horizonte es de varias sesiones)."""
    n = len(x)
    if n < 3:
        return None
    e = x - x.mean()
    s = float(e @ e) / n
    for k in range(1, min(lags, n - 1) + 1):
        s += 2 * (1 - k / (lags + 1)) * float(e[k:] @ e[:-k]) / n
    return float(x.mean() / np.sqrt(s / n)) if s > 0 else None


def _rv(c: np.ndarray) -> float | None:
    """Volatilidad realizada cierre a cierre, anualizada, de una serie de cierres consecutivos (None si falta alguno o
    hay un salto de split)."""
    if len(c) < 3 or not np.all(np.isfinite(c)) or np.any(c <= 0):
        return None
    r = np.diff(np.log(c))
    return None if np.any(np.abs(r) > np.log(1 + SALTO)) else float(r.std(ddof=1) * np.sqrt(252))


def _cierres(idx: dict[str, dict], fechas: list[str], sym: str, i: int, j: int) -> np.ndarray:
    """Cierres de `sym` en las sesiones fechas[i..j] (NaN donde no hay)."""
    return np.array([((idx[fechas[k]].get(sym) or [None] * 3)[2] or np.nan) for k in range(i, j + 1)], dtype=float)


def _con_rv(idx: dict[str, dict]) -> dict[str, dict]:
    """El índice con la volatilidad realizada de las RV_DIAS sesiones previas añadida en v[6] de cada fila con IV."""
    fechas = sorted(idx)
    out = {}
    for i, f in enumerate(fechas):
        d = {}
        for sym, v in idx[f].items():
            rv = _rv(_cierres(idx, fechas, sym, i - RV_DIAS, i)) if i >= RV_DIAS and v[0] is not None else None
            d[sym] = list(v) + [None] * (6 - len(v)) + [None if rv is None else round(rv, 5)]
        out[f] = d
    return out


def puntuaciones(idx: dict[str, dict], acciones: set[str], nivel) -> dict[str, dict[str, dict]]:
    """{fecha: {SYM: {v, chg, score}}} de una señal en las sesiones con al menos MIN_TICKERS acciones."""
    fechas = sorted(idx)
    out = {}
    for i, f in enumerate(fechas):
        prev = idx[fechas[i - CAMBIO]] if i >= CAMBIO else {}
        filas = {}
        for sym, v in idx[f].items():
            x = nivel(v) if sym in acciones else None
            if x is None:
                continue
            p = nivel(prev[sym]) if sym in prev else None
            filas[sym] = {"v": round(x, 5), "chg": round(x - p, 5) if p is not None else None}
        if len(filas) < MIN_TICKERS:
            continue
        syms = list(filas)
        rk = _pct(np.array([filas[s]["v"] for s in syms]))
        con = [k for k, s in enumerate(syms) if filas[s]["chg"] is not None]
        rc = np.full(len(syms), np.nan)
        if len(con) >= MIN_TICKERS:
            rc[con] = _pct(np.array([filas[syms[k]]["chg"] for k in con]))
        for k, s in enumerate(syms):  # lv y ch: cada parte por separado, para el diagnóstico
            filas[s]["score"] = round(float(np.nanmean([rk[k], rc[k]])), 4)
            filas[s]["lv"] = round(float(rk[k]), 4)
            if not np.isnan(rc[k]):
                filas[s]["ch"] = round(float(rc[k]), 4)
        out[f] = filas
    return out


def evaluar(idx: dict[str, dict], punt: dict[str, dict[str, dict]], objetivo: str = "ret") -> dict:
    """Prueba en adelante de una puntuación. Objetivo "ret": rendimiento de la acción a h sesiones; "rv": prima de
    volatilidad cobrada, IV de la sesión − volatilidad realizada de las h sesiones siguientes."""
    fechas = sorted(idx)
    pos = {f: i for i, f in enumerate(fechas)}
    res = {}
    for h in HORIZONTES:
        ics, difs, usadas = [], [], []
        for f, filas in sorted(punt.items()):
            j = pos[f] + h
            if j >= len(fechas):
                continue
            fut = idx[fechas[j]]
            par = []
            for sym, r in filas.items():
                if objetivo == "rv":
                    iv, rv = idx[f][sym][0], _rv(_cierres(idx, fechas, sym, pos[f], j))
                    if iv is not None and rv is not None:
                        par.append((r["score"], iv - rv))
                    continue
                a, b = idx[f][sym][2], (fut.get(sym) or [None] * 3)[2]
                if b and a > 0 and abs(b / a - 1) < SALTO:
                    par.append((r["score"], b / a - 1))
            if len(par) < MIN_TICKERS:
                continue
            sc, rt = np.array([p[0] for p in par]), np.array([p[1] for p in par])
            ics.append(float(np.corrcoef(_pct(sc), _pct(rt))[0, 1]))
            q = np.quantile(sc, [0.2, 0.8])
            difs.append(float(rt[sc >= q[1]].mean() - rt[sc <= q[0]].mean()))
            usadas.append(f)
        x = np.array(ics)
        need = max(MIN_FECHAS, h)
        res[str(h)] = {"n": len(ics), "need": need, "first": usadas[0] if usadas else None, "last": usadas[-1] if usadas else None,
                       "ic": round(float(x.mean()), 4) if len(x) else None,
                       "t": round(t, 2) if len(x) >= 3 and (t := _t_nw(x, h - 1)) is not None else None,
                       "spread": round(float(np.mean(difs)), 5) if difs else None,
                       "enough": len(ics) >= need}
    return res


def _parte(punt: dict[str, dict[str, dict]], clave: str) -> dict[str, dict[str, dict]]:
    """Una sola parte de la puntuación (lv: nivel, ch: cambio) como `score`, para evaluarla aparte."""
    out = {}
    for f, filas in punt.items():
        d = {s: {"score": r[clave]} for s, r in filas.items() if clave in r}
        if len(d) >= MIN_TICKERS:
            out[f] = d
    return out


def _neutral(idx: dict[str, dict], punt: dict[str, dict[str, dict]]) -> tuple[dict, float | None]:
    """Puntuación sin la parte que explica el rendimiento de las CAMBIO sesiones previas: residuo de la regresión
    transversal de su percentil sobre el del rendimiento previo. Si una señal funciona al revés de lo esperado solo
    por reversión a corto plazo (puts caras y mucho volumen de opciones tras una caída, y luego rebote), aquí deja de
    hacerlo. Devuelve también la correlación media de rangos entre puntuación y rendimiento previo."""
    fechas = sorted(idx)
    pos = {f: i for i, f in enumerate(fechas)}
    out, cors = {}, []
    for f, filas in punt.items():
        if pos[f] < CAMBIO:
            continue
        prev = idx[fechas[pos[f] - CAMBIO]]
        syms, sc, rt = [], [], []
        for s, r in filas.items():
            a, b = (prev.get(s) or [None] * 3)[2], idx[f][s][2]
            if a and a > 0 and b and abs(b / a - 1) < SALTO:
                syms.append(s)
                sc.append(r["score"])
                rt.append(b / a - 1)
        if len(syms) < MIN_TICKERS:
            continue
        x, y = _pct(np.array(rt)), _pct(np.array(sc))
        cors.append(float(np.corrcoef(x, y)[0, 1]))
        b1, b0 = np.polyfit(x, y, 1)
        out[f] = {s: {"score": round(float(v), 4)} for s, v in zip(syms, y - (b0 + b1 * x))}
    return out, (round(float(np.mean(cors)), 4) if cors else None)


def diagnostico(idx: dict[str, dict], punt: dict[str, dict[str, dict]], partes: bool = True,
                objetivo: str = "ret") -> dict:
    """La prueba en adelante de cada parte de la puntuación y de la puntuación neutralizada (ver _neutral).
    `past`: correlación media entre la puntuación y el rendimiento previo (cerca de ±1, la señal es casi solo eso).
    En las señales de volatilidad solo las partes: la reversión del rendimiento no es lo que explican."""
    if objetivo != "ret":
        return {"level": evaluar(idx, _parte(punt, "lv"), objetivo), "change": evaluar(idx, _parte(punt, "ch"), objetivo)}
    neu, past = _neutral(idx, punt)
    d = {"past": past, "neutral": evaluar(idx, neu)}
    if partes:
        d["level"] = evaluar(idx, _parte(punt, "lv"))
        d["change"] = evaluar(idx, _parte(punt, "ch"))
    return d


def _direccion(nombre: str, score: float) -> float:
    """Puntuación de una señal llevada a dirección: +1 lo más alcista, −1 lo más bajista según su estudio."""
    return (score - 0.5) * 2 * SENALES[nombre][1]


def consenso(r: dict) -> dict | None:
    """Coincidencia de las señales de una acción. Cada señal vota alcista o bajista si está en los dos quintiles
    extremos de su lado (put skew y O/S altos, bajista; call-put alto, alcista). Hay coincidencia ("match") con al
    menos dos votos en el mismo sentido y ninguno en contra. `v`: media de las direcciones (−1 a +1)."""
    votos, dirs = {}, []
    for nombre, (_, signo) in SENALES.items():
        s = r.get(nombre)
        if not s:
            continue
        dirs.append(_direccion(nombre, s["score"]))
        alto, bajo = s["q"] >= 4, s["q"] <= 2
        votos[nombre] = (1 if alto else -1 if bajo else 0) * signo
    if len(dirs) < 2:
        return None
    alc, baj = sum(v > 0 for v in votos.values()), sum(v < 0 for v in votos.values())
    return {"v": round(float(np.mean(dirs)), 4), "n": len(dirs), "votes": votos,
            "match": "bull" if alc >= 2 and not baj else "bear" if baj >= 2 and not alc else None}


def combinar(punts: dict[str, dict]) -> dict[str, dict[str, dict]]:
    """Puntuación combinada por sesión: media de las direcciones de las señales con dato ese día (al menos dos), y
    su percentil transversal como `score` (1 = lo más alcista). La usa la prueba en adelante del consenso."""
    out = {}
    for f in sorted(set().union(*(p.keys() for p in punts.values()))):
        syms = set().union(*((p.get(f) or {}).keys() for p in punts.values()))
        filas = {}
        for s in syms:
            d = [_direccion(k, p[f][s]["score"]) for k, p in punts.items() if s in (p.get(f) or {})]
            if len(d) >= 2:
                filas[s] = {"v": round(float(np.mean(d)), 4)}
        if len(filas) < MIN_TICKERS:
            continue
        orden = list(filas)
        for s, sc in zip(orden, _pct(np.array([filas[s]["v"] for s in orden]))):
            filas[s]["score"] = round(float(sc), 4)
        out[f] = filas
    return out


def calcular(idx: dict[str, dict], nombres: dict[str, str], lista: list[str] | None = None) -> dict:
    idx = _con_rv(idx)
    syms = {s for d in idx.values() for s in d} | set(lista or [])
    acciones = {s for s in syms if es_accion(s, nombres)}
    # la última sesión con IV (las filas previas que añade la reconstrucción solo tienen el cierre)
    hoy = max((f for f, d in idx.items() if any(v[0] is not None or v[4] for v in d.values())), default=None)
    filas: dict[str, dict] = {}
    senales = {}
    punts = {}
    todas = {**{k: (*v, "ret") for k, v in SENALES.items()}, **{k: (*v, "rv") for k, v in SENALES_VOL.items()}}
    for nombre, (nivel, signo, objetivo) in todas.items():
        punt = punts[nombre] = puntuaciones(idx, acciones, nivel)
        # cada señal enseña su última sesión con datos: el volumen de la acción de días pasados sale del histórico de
        # CBOE, que publica el de un día una sesión más tarde
        ultima = max(punt) if punt else None
        senales[nombre] = {"sign": signo, "target": objetivo, "sessions": len(punt), "first": min(punt) if punt else None,
                           "date": ultima, "eval": evaluar(idx, punt, objetivo), "diag": diagnostico(idx, punt, objetivo=objetivo)}
        for s, r in (punt.get(ultima) or {}).items():
            filas.setdefault(s, {"sym": s, "name": nombres.get(s, "")})[nombre] = {k: r[k] for k in ("v", "chg", "score")}
    if not filas:
        raise LookupError(f"Not enough history yet: the signals need at least {MIN_TICKERS} stocks on the same session.")
    for nombre in todas:  # quintil de cada señal (5 = puntuación más alta)
        orden = sorted((r for r in filas.values() if nombre in r), key=lambda r: -r[nombre]["score"])
        for k, r in enumerate(orden):
            r[nombre]["q"] = 5 - min(4, int(k * 5 / len(orden)))
    for r in filas.values():
        if r["sym"] in idx[hoy] and idx[hoy][r["sym"]][0] is not None:
            r["atm"] = idx[hoy][r["sym"]][0]
            if idx[hoy][r["sym"]][6] is not None:
                r["rv"] = idx[hoy][r["sym"]][6]
        r["combo"] = consenso(r)
    # consenso: su propia prueba en adelante con la puntuación combinada de cada sesión (positiva = alcista)
    comb = combinar({k: punts[k] for k in SENALES})
    senales["combo"] = {"sign": 1, "sessions": len(comb), "first": min(comb) if comb else None,
                        "date": max(comb) if comb else None, "eval": evaluar(idx, comb),
                        "diag": diagnostico(idx, comb, partes=False)}
    # acciones de la lista sin lectura hoy (opciones demasiado finas o sin put de 25 delta en el mensual)
    sin = sorted(s for s in acciones if s not in filas and (lista is None or s in lista))
    return {"date": hoy, "stocks": len(filas), "rows": sorted(filas.values(), key=lambda r: r["sym"]),
            "signals": senales, "excluded": sorted(syms - acciones), "missing": sin,
            "change_days": CAMBIO, "min_sessions": MIN_FECHAS}


def publicar(st, guardados: list[str] | None = None) -> dict | None:
    """Las acciones "sin lectura" son las que el historial guardó en la última sesión (hist500/_dias/, campo ok) y no
    dan valor; las añadidas a la lista que aún no tienen ningún día guardado no cuentan."""
    idx = almacen.get_json(st, INDICE) or {}
    if not idx:
        return None
    if guardados is None:
        guardados = (almacen.get_json(st, f"hist500/_dias/{max(idx)}.json") or {}).get("ok")
    res = calcular(idx, dict(g.load_symbols()), guardados)
    almacen.put_json(st, "pub/skew.json", res)
    return res
