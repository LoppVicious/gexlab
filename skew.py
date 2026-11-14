"""Señal de skew para swings en acciones (Xing, Zhang y Zhao, 2010; An, Ang, Bali y Cakici, 2014).

Idea: cuando las puts fuera de dinero se encarecen frente a las de en el dinero, alguien informado está comprando
protección, y la acción tiende a ir peor que las demás en las semanas siguientes. Es una señal transversal: ordena
las acciones del historial diario entre sí cada sesión, no predice el mercado.

Por ticker y sesión, del historial de la superficie (volatilidad.history, `ivsurf_{SYM}.json`, que el motor guarda
con la foto de cada día):
  skew = IV de la put de 25 delta a 30 días − IV ATM a 30 días (puntos de volatilidad)
  cambio = skew de hoy − skew de hace 5 sesiones
  puntuación = media del percentil transversal del skew y del cambio (0 = skew barato, 1 = caro)
Solo acciones: fuera índices, VIX y ETF (su skew es estructuralmente distinto y quedarían siempre arriba).

Prueba en adelante: para cada sesión pasada con puntuaciones, el rendimiento de cada acción a 5 y 20 sesiones
(cierres de CBOE). IC = correlación de rangos entre puntuación y rendimiento (la hipótesis: negativa), con t de
Newey-West (las ventanas se solapan), y diferencial = rendimiento medio del quintil de skew caro − el del barato.
La publica el motor una vez por sesión (`pub/skew.json`, `/api/skew`)."""
from __future__ import annotations

import bisect
import re

import numpy as np

import gex_engine as g
import volatilidad

TENOR, DELTA = "30", "-0.25"
CAMBIO = 5                      # sesiones para el cambio del skew
HORIZONTES = (5, 20)            # sesiones de la prueba en adelante
MIN_TICKERS = 20                # acciones mínimas para puntuar una sesión
MIN_FECHAS = 20                 # sesiones evaluadas mínimas para dar un veredicto
_FONDO = re.compile(r"\b(ETF|ETN|SPDR|Ishares|Proshares|Direxion|Vaneck|Kraneshares|Invesco|Fd|Fund|Trust|Tr)\b", re.I)
_EMPRESA = re.compile(r"\b(Inc|Corp|Ltd|Hldgs?|Plc|Co|Group|Holdings|Ads)\b", re.I)


def es_accion(sym: str, nombres: dict[str, str]) -> bool:
    if sym in g.INDEX_SYMBOLS or sym in g.CBOE_VOL_INDICES or sym in g.INDEX_PROXY.values():
        return False
    n = nombres.get(sym) or ""
    return not (_FONDO.search(n) and not _EMPRESA.search(n))


def serie(sym: str) -> dict[str, tuple[float, float]]:
    """{fecha: (IV ATM a 30 días, IV de la put de 25 delta a 30 días)}."""
    h = g.read_json(volatilidad._hist_path(sym), {}) or {}
    out = {}
    for d, snap in h.items():
        atm = (snap.get("t") or {}).get(TENOR)
        p25 = ((snap.get("s") or {}).get(TENOR) or {}).get(DELTA)
        if atm and p25:
            out[d] = (float(atm), float(p25))
    return out


def _pct(x: np.ndarray) -> np.ndarray:
    """Percentil transversal (0 a 1) con empates repartidos."""
    o = np.argsort(np.argsort(x, kind="stable"), kind="stable").astype(float)
    return o / max(len(x) - 1, 1)


def _spearman(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.corrcoef(_pct(a), _pct(b))[0, 1])


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


def puntuaciones(series: dict[str, dict[str, tuple[float, float]]]) -> dict[str, list[dict]]:
    """{fecha: [{sym, skew, chg, atm, score}]} de las sesiones con al menos MIN_TICKERS acciones."""
    fechas = sorted({d for s in series.values() for d in s})
    out = {}
    for i, f in enumerate(fechas):
        prev = fechas[i - CAMBIO] if i >= CAMBIO else None
        filas = []
        for sym, s in series.items():
            if f not in s:
                continue
            atm, p25 = s[f]
            chg = (p25 - atm) - (s[prev][1] - s[prev][0]) if prev and prev in s else None
            filas.append({"sym": sym, "skew": round(p25 - atm, 5), "chg": None if chg is None else round(chg, 5),
                          "atm": round(atm, 5)})
        if len(filas) < MIN_TICKERS:
            continue
        sk = _pct(np.array([r["skew"] for r in filas]))
        con = [k for k, r in enumerate(filas) if r["chg"] is not None]
        ch = np.full(len(filas), np.nan)
        if len(con) >= MIN_TICKERS:
            ch[con] = _pct(np.array([filas[k]["chg"] for k in con]))
        for k, r in enumerate(filas):
            r["score"] = round(float(np.nanmean([sk[k], ch[k]])), 4)
        out[f] = filas
    return out


def _rend(cierres: list[tuple[str, float]], f: str, h: int) -> float | None:
    fechas = [d for d, _ in cierres]
    i = bisect.bisect_left(fechas, f)
    if i >= len(fechas) or fechas[i] != f or i + h >= len(fechas):
        return None
    return cierres[i + h][1] / cierres[i][1] - 1


def evaluar(punt: dict[str, list[dict]], cierres: dict[str, list[tuple[str, float]]]) -> dict:
    res = {}
    for h in HORIZONTES:
        ics, difs, fechas = [], [], []
        for f, filas in sorted(punt.items()):
            par = [(r["score"], _rend(cierres.get(r["sym"], []), f, h)) for r in filas]
            par = [(s, x) for s, x in par if x is not None]
            if len(par) < MIN_TICKERS:
                continue
            sc, rt = np.array([p[0] for p in par]), np.array([p[1] for p in par])
            ics.append(_spearman(sc, rt))
            q = np.quantile(sc, [0.2, 0.8])
            difs.append(float(rt[sc >= q[1]].mean() - rt[sc <= q[0]].mean()))
            fechas.append(f)
        x = np.array(ics)
        res[str(h)] = {"n": len(ics), "first": fechas[0] if fechas else None, "last": fechas[-1] if fechas else None,
                       "ic": round(float(x.mean()), 4) if len(x) else None,
                       "t": None if len(x) < 3 else round(_t_nw(x, h - 1) or 0, 2),
                       "spread": round(float(np.mean(difs)), 5) if difs else None,
                       "neg": round(float((x < 0).mean()), 3) if len(x) else None,
                       "enough": len(ics) >= MIN_FECHAS}
    return res


def calcular(syms: list[str]) -> dict:
    nombres = dict(g.load_symbols())
    acciones = [s for s in syms if es_accion(s, nombres)]
    series = {s: v for s in acciones if (v := serie(s))}
    punt = puntuaciones(series)
    if not punt:
        raise LookupError("Not enough skew history yet: it needs the 30-day surface of at least "
                          f"{MIN_TICKERS} stocks on the same session.")
    cierres = {}
    for s in series:
        ohlc, _ = g.history_ohlc(s)
        cierres[s] = [(d, v[3]) for d, v in sorted(ohlc.items()) if v[3] > 0]
    hoy = max(punt)
    filas = sorted(punt[hoy], key=lambda r: -r["score"])
    for k, r in enumerate(filas):
        r["name"] = nombres.get(r["sym"], "")
        r["q"] = 5 - min(4, int(k * 5 / len(filas)))     # 5 = skew más caro
    return {"date": hoy, "sessions": len(punt), "first": min(punt), "stocks": len(filas),
            "excluded": sorted(set(syms) - set(acciones)), "rows": filas, "eval": evaluar(punt, cierres),
            "tenor": int(TENOR), "delta": float(DELTA), "change_days": CAMBIO}
