"""Señales de opciones para swings en acciones: skew de puts y diferencia de IV call-put.

Son señales transversales: ordenan las acciones del historial diario entre sí cada sesión; no predicen el mercado.

  skew de puts (Xing, Zhang y Zhao, 2010): cuando las puts fuera de dinero se encarecen frente a las de en el
    dinero, alguien paga por protección y la acción tiende a ir peor que las demás. skew = IV put 25 delta − IV ATM.
    Hipótesis: IC negativo.
  diferencia call-put (Cremers y Weinbaum, 2010): media ponderada por OI de IV call − IV put del mismo strike, en
    strikes a ±10 % del spot. Si las calls están caras frente a las puts (desvío de la paridad), hay compra informada
    y la acción tiende a ir mejor. Hipótesis: IC positivo. Usa la IV de CBOE (`iv_raw`): la del motor sale del
    forward implícito por paridad y su diferencia es cero por construcción; con un forward sin dividendos salen
    desvíos de varios puntos por el desfase entre el cierre del subyacente y el de las opciones. La de CBOE da
    valores pequeños y no castiga a las acciones con dividendo (KO +0,3, PFE +0,1 el 2026-11-13).

Las dos, con la cadena del cierre que guarda historial500.py, en el mensual estándar más cercano a 30 días entre 14 y
60 (los semanales de acciones poco líquidas dan alas sin sentido: JD tenía una put de 25 delta al 116 % con el ATM
al 45 %). Puntuación = media del percentil transversal del nivel y de su cambio en 5 sesiones (0 a 1).
Solo acciones: fuera índices, VIX y ETF.

Índice: hist500/_skew.json.gz = {fecha: {SYM: [atm, put25, cierre, call−put]}} (None donde no se puede medir); se
reconstruye con los días guardados. Prueba en adelante con los cierres del índice: IC = correlación de rangos entre
puntuación y rendimiento a 5 y 20 sesiones, con t de Newey-West (las ventanas se solapan), y diferencial = quintil
alto − quintil bajo. Publica pub/skew.json (/api/skew)."""
from __future__ import annotations

import re
from datetime import datetime

import numpy as np

import almacen
import gex_engine as g
import volatilidad

INDICE = "hist500/_skew.json.gz"
DIAS_MIN, DIAS_MAX = 14, 60     # ventana del vencimiento mensual (días naturales)
CP_BANDA = 0.10                 # strikes a ±10 % del spot para la diferencia call-put
CP_MIN_PARES = 3
CAMBIO = 5                      # sesiones para el cambio
HORIZONTES = (5, 20)            # sesiones de la prueba en adelante
MIN_TICKERS = 20                # acciones mínimas para puntuar una sesión
MIN_FECHAS = 20                 # sesiones evaluadas mínimas para dar un veredicto
SALTO = 0.5                     # |rendimiento| mayor: split o dato roto, fuera
# señal: nivel por acción a partir de la fila del índice, y signo del IC que espera la hipótesis
SENALES = {
    "skew": (lambda v: v[1] - v[0] if v[0] is not None and v[1] is not None else None, -1),
    "cp": (lambda v: v[3] if len(v) > 3 else None, 1),
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
    """Media ponderada por OI de IV call − IV put (de CBOE) en los strikes del vencimiento a ±CP_BANDA del spot."""
    m = ch["exp"].astype("datetime64[D]") == np.datetime64(dia)
    K, C, oi, iv = ch["K"][m], ch["call"][m], ch["oi"][m], ch["iv_raw"][m]
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
        if w <= 0 or not (0.01 < iv[c] < 5 and 0.01 < iv[p] < 5):
            continue
        num += w * (iv[c] - iv[p])
        den += w
        n += 1
    return round(num / den, 5) if n >= CP_MIN_PARES and den > 0 else None


def punto(ch: dict, spot: float, now: datetime) -> list | None:
    """[IV ATM, IV put 25 delta, IV call − IV put] del mensual más cercano a 30 días (None donde no se puede)."""
    sm = [s for s in volatilidad.smiles_from_chain(ch, spot, now)
          if s.get("monthly") and DIAS_MIN <= s["dte"] <= DIAS_MAX]
    if not sm:
        return None
    s = min(sm, key=lambda x: abs(x["dte"] - 30))
    atm, p25 = volatilidad.atm_iv(s, spot), volatilidad.iv_at_delta(s, -0.25)
    cp = _call_put(ch, s["exp"], spot) if "iv_raw" in ch else None
    out = [round(atm, 5) if atm else None, round(p25, 5) if p25 else None, cp]
    return out if any(x is not None for x in out) else None


# ---------------------------------------------------------------- índice en R2
def fila(p: list, cierre: float) -> list:
    return [p[0], p[1], float(cierre), p[2]]


def actualizar(st, sesion: str, puntos: dict[str, list]) -> int:
    """puntos: {SYM: [atm, put25, cierre, call−put]}."""
    idx = almacen.get_json(st, INDICE) or {}
    idx[sesion] = puntos
    almacen.put_json(st, INDICE, dict(sorted(idx.items())))
    return len(idx)


def reconstruir(st, syms: list[str]) -> int:
    """Índice desde todas las cadenas guardadas en hist500/{SYM}/ (lento: una lectura por ticker y día)."""
    rx = re.compile(r"/(\d{4}-\d{2}-\d{2})\.json\.gz$")
    idx: dict[str, dict] = {}
    for sym in syms:
        for k in st.list(f"hist500/{sym}/"):
            m = rx.search(k)
            if not m:
                continue
            d = almacen.get_json(st, k) or {}
            if not d.get("chain") or not d.get("spot"):
                continue
            try:
                ch = g.parse_chain({"_min": d["chain"]})
                p = punto(ch, float(d["spot"]), datetime.fromisoformat(m.group(1) + "T16:00"))
            except Exception:  # noqa: BLE001  (un día roto no para el resto)
                continue
            if p:
                idx.setdefault(m.group(1), {})[sym] = fila(p, d["spot"])
    almacen.put_json(st, INDICE, dict(sorted(idx.items())))
    return len(idx)


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
        for k, s in enumerate(syms):
            filas[s]["score"] = round(float(np.nanmean([rk[k], rc[k]])), 4)
        out[f] = filas
    return out


def evaluar(idx: dict[str, dict], punt: dict[str, dict[str, dict]]) -> dict:
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
        res[str(h)] = {"n": len(ics), "first": usadas[0] if usadas else None, "last": usadas[-1] if usadas else None,
                       "ic": round(float(x.mean()), 4) if len(x) else None,
                       "t": round(t, 2) if len(x) >= 3 and (t := _t_nw(x, h - 1)) is not None else None,
                       "spread": round(float(np.mean(difs)), 5) if difs else None,
                       "enough": len(ics) >= MIN_FECHAS}
    return res


def calcular(idx: dict[str, dict], nombres: dict[str, str], lista: list[str] | None = None) -> dict:
    syms = {s for d in idx.values() for s in d} | set(lista or [])
    acciones = {s for s in syms if es_accion(s, nombres)}
    hoy = max(idx) if idx else None
    filas: dict[str, dict] = {}
    senales = {}
    for nombre, (nivel, signo) in SENALES.items():
        punt = puntuaciones(idx, acciones, nivel)
        senales[nombre] = {"sign": signo, "sessions": len(punt), "first": min(punt) if punt else None,
                           "eval": evaluar(idx, punt)}
        for s, r in (punt.get(hoy) or {}).items():
            filas.setdefault(s, {"sym": s, "name": nombres.get(s, "")})[nombre] = r
    if not filas:
        raise LookupError(f"Not enough history yet: the signals need at least {MIN_TICKERS} stocks on the same session.")
    for nombre in SENALES:  # quintil de cada señal (5 = puntuación más alta)
        orden = sorted((r for r in filas.values() if nombre in r), key=lambda r: -r[nombre]["score"])
        for k, r in enumerate(orden):
            r[nombre]["q"] = 5 - min(4, int(k * 5 / len(orden)))
    for r in filas.values():
        if r["sym"] in idx[hoy] and idx[hoy][r["sym"]][0] is not None:
            r["atm"] = idx[hoy][r["sym"]][0]
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
