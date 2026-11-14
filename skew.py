"""Señal de skew para swings en acciones (Xing, Zhang y Zhao, 2010; An, Ang, Bali y Cakici, 2014).

Idea: cuando las puts fuera de dinero se encarecen frente a las de en el dinero, alguien está pagando por
protección, y la acción tiende a ir peor que las demás en las semanas siguientes. Es una señal transversal: ordena
las acciones del historial diario entre sí cada sesión; no predice el mercado.

Por acción y sesión, con la cadena del cierre que guarda historial500.py:
  vencimiento: el mensual estándar más cercano a 30 días entre 14 y 60 (los semanales de acciones poco líquidas
               dan alas sin sentido: JD tenía una put de 25 delta al 116 % con el ATM al 45 %)
  skew = IV de la put de 25 delta − IV ATM (puntos de volatilidad)
  cambio = skew de hoy − skew de hace 5 sesiones
  puntuación = media del percentil transversal del skew y del cambio (0 = skew barato, 1 = caro)
Solo acciones: fuera índices, VIX y ETF (su skew es estructuralmente distinto y quedarían siempre arriba).

Índice: hist500/_skew.json.gz = {fecha: {SYM: [atm, put25, cierre]}}; se reconstruye con los días guardados.
Prueba en adelante: para cada sesión puntuada, el rendimiento de cada acción a 5 y 20 sesiones con los cierres del
índice. IC = correlación de rangos entre puntuación y rendimiento (hipótesis: negativa), con t de Newey-West (las
ventanas se solapan), y diferencial = rendimiento medio del quintil de skew caro − el del barato.
Publica pub/skew.json (/api/skew)."""
from __future__ import annotations

import re
from datetime import datetime

import numpy as np

import almacen
import gex_engine as g
import volatilidad

INDICE = "hist500/_skew.json.gz"
DIAS_MIN, DIAS_MAX = 14, 60     # ventana del vencimiento mensual (días naturales)
CAMBIO = 5                      # sesiones para el cambio del skew
HORIZONTES = (5, 20)            # sesiones de la prueba en adelante
MIN_TICKERS = 20                # acciones mínimas para puntuar una sesión
MIN_FECHAS = 20                 # sesiones evaluadas mínimas para dar un veredicto
SALTO = 0.5                     # |rendimiento| mayor: split o dato roto, fuera
_FONDO = re.compile(r"\b(ETF|ETN|SPDR|Ishares|Proshares|Direxion|Vaneck|Kraneshares|Invesco|Fd|Fund|Trust|Tr)\b", re.I)
_EMPRESA = re.compile(r"\b(Inc|Corp|Ltd|Hldgs?|Plc|Co|Group|Holdings|Ads)\b", re.I)


def es_accion(sym: str, nombres: dict[str, str]) -> bool:
    if sym in g.INDEX_SYMBOLS or sym in g.CBOE_VOL_INDICES or sym in g.INDEX_PROXY.values():
        return False
    n = nombres.get(sym) or ""
    return not (_FONDO.search(n) and not _EMPRESA.search(n))


def punto(ch: dict, spot: float, now: datetime) -> list[float] | None:
    """[IV ATM, IV de la put de 25 delta] del mensual más cercano a 30 días, o None."""
    sm = [s for s in volatilidad.smiles_from_chain(ch, spot, now)
          if s.get("monthly") and DIAS_MIN <= s["dte"] <= DIAS_MAX]
    if not sm:
        return None
    s = min(sm, key=lambda x: abs(x["dte"] - 30))
    atm, p25 = volatilidad.atm_iv(s, spot), volatilidad.iv_at_delta(s, -0.25)
    return [round(atm, 5), round(p25, 5)] if atm and p25 else None


# ---------------------------------------------------------------- índice en R2
def actualizar(st, sesion: str, puntos: dict[str, list[float]]) -> int:
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
                idx.setdefault(m.group(1), {})[sym] = p + [float(d["spot"])]
    almacen.put_json(st, INDICE, dict(sorted(idx.items())))
    return len(idx)


# ---------------------------------------------------------------- señal y prueba en adelante
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


def puntuaciones(idx: dict[str, dict], acciones: set[str]) -> dict[str, list[dict]]:
    """{fecha: [{sym, skew, chg, atm, score}]} de las sesiones con al menos MIN_TICKERS acciones."""
    fechas = sorted(idx)
    out = {}
    for i, f in enumerate(fechas):
        prev = idx[fechas[i - CAMBIO]] if i >= CAMBIO else {}
        filas = []
        for sym, v in idx[f].items():
            if sym not in acciones:
                continue
            sk = v[1] - v[0]
            p = prev.get(sym)
            filas.append({"sym": sym, "skew": round(sk, 5), "atm": v[0],
                          "chg": round(sk - (p[1] - p[0]), 5) if p else None})
        if len(filas) < MIN_TICKERS:
            continue
        rk = _pct(np.array([r["skew"] for r in filas]))
        con = [k for k, r in enumerate(filas) if r["chg"] is not None]
        rc = np.full(len(filas), np.nan)
        if len(con) >= MIN_TICKERS:
            rc[con] = _pct(np.array([filas[k]["chg"] for k in con]))
        for k, r in enumerate(filas):
            r["score"] = round(float(np.nanmean([rk[k], rc[k]])), 4)
        out[f] = filas
    return out


def evaluar(idx: dict[str, dict], punt: dict[str, list[dict]]) -> dict:
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
            for r in filas:
                a, b = idx[f][r["sym"]], fut.get(r["sym"])
                if b and a[2] > 0 and abs(b[2] / a[2] - 1) < SALTO:
                    par.append((r["score"], b[2] / a[2] - 1))
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
                       "neg": round(float((x < 0).mean()), 3) if len(x) else None,
                       "enough": len(ics) >= MIN_FECHAS}
    return res


def calcular(idx: dict[str, dict], nombres: dict[str, str]) -> dict:
    syms = {s for d in idx.values() for s in d}
    acciones = {s for s in syms if es_accion(s, nombres)}
    punt = puntuaciones(idx, acciones)
    if not punt:
        raise LookupError(f"Not enough skew history yet: it needs the 30-day skew of at least {MIN_TICKERS} stocks "
                          "on the same session.")
    hoy = max(punt)
    filas = sorted(punt[hoy], key=lambda r: -r["score"])
    for k, r in enumerate(filas):
        r["name"] = nombres.get(r["sym"], "")
        r["q"] = 5 - min(4, int(k * 5 / len(filas)))     # 5 = skew más caro
    return {"date": hoy, "sessions": len(punt), "first": min(punt), "stocks": len(filas),
            "excluded": sorted(syms - acciones), "rows": filas, "eval": evaluar(idx, punt),
            "change_days": CAMBIO, "min_sessions": MIN_FECHAS}


def publicar(st) -> dict | None:
    idx = almacen.get_json(st, INDICE) or {}
    if not idx:
        return None
    res = calcular(idx, dict(g.load_symbols()))
    almacen.put_json(st, "pub/skew.json", res)
    return res
