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

Skew y call-put, con la cadena del cierre que guarda historial500.py, en el mensual estándar más cercano a 30 días
entre 14 y 60 (los semanales de acciones poco líquidas dan alas sin sentido: JD tenía una put de 25 delta al 116 % con
el ATM al 45 %). Puntuación = media del percentil transversal del nivel y de su cambio en 5 sesiones (0 a 1).
Solo acciones: fuera índices, VIX y ETF.

Índice: hist500/_skew.json.gz = {fecha: {SYM: [atm, put25, cierre, call−put, contratos, acciones]}} (None donde no
se puede medir); se reconstruye con los días guardados (el volumen de la acción de días pasados, del histórico
diario de CBOE). Prueba en adelante con los cierres del índice: IC = correlación de rangos entre
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
CP_BANDA = 0.05                 # strikes a ±5 % del spot para la diferencia call-put
CP_HORQUILLA = 0.25             # horquilla máxima de cada pata, en fracción del punto medio
CP_MIN_PARES = 2
# horquilla máxima de los contratos del skew: las puts lejanas son baratas y su horquilla relativa es mayor, por eso
# más holgada que la de call-put. Con 0,35 se quedan sin lectura GILD, HON, NTES, XPEV, PM, JD, BIDU y BKNG (alas de
# opciones poco líquidas) y las líquidas no cambian; con 0,25 caían también PEP, AMGN, TMUS o FTNT
SK_HORQUILLA = 0.35
CAMBIO = 5                      # sesiones para el cambio
HORIZONTES = (5, 20)            # sesiones de la prueba en adelante
MIN_TICKERS = 20                # acciones mínimas para puntuar una sesión
MIN_FECHAS = 20                 # sesiones evaluadas mínimas para dar un veredicto
SALTO = 0.5                     # |rendimiento| mayor: split o dato roto, fuera
# señal: nivel por acción a partir de la fila del índice, y signo del IC que espera la hipótesis
SENALES = {
    "skew": (lambda v: v[1] - v[0] if v[0] is not None and v[1] is not None else None, -1),
    "cp": (lambda v: v[3] if len(v) > 3 else None, 1),
    "os": (lambda v: float(np.log(v[4] * 100 / v[5])) if len(v) > 5 and v[4] and v[5] else None, -1),
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
        try:  # volumen de la acción de cada día (los archivos del historial no lo guardan)
            vol = {r["date"]: float(r.get("volume") or 0)
                   for r in (g.fetch_aux("historical", sym, ttl=6 * 3600) or {}).get("data", [])}
        except Exception:  # noqa: BLE001
            vol = {}
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
    syms = {s for d in idx.values() for s in d} | set(lista or [])
    acciones = {s for s in syms if es_accion(s, nombres)}
    hoy = max(idx) if idx else None
    filas: dict[str, dict] = {}
    senales = {}
    punts = {}
    for nombre, (nivel, signo) in SENALES.items():
        punt = punts[nombre] = puntuaciones(idx, acciones, nivel)
        # cada señal enseña su última sesión con datos: el volumen de la acción de días pasados sale del histórico de
        # CBOE, que publica el de un día una sesión más tarde
        ultima = max(punt) if punt else None
        senales[nombre] = {"sign": signo, "sessions": len(punt), "first": min(punt) if punt else None,
                           "date": ultima, "eval": evaluar(idx, punt)}
        for s, r in (punt.get(ultima) or {}).items():
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
        r["combo"] = consenso(r)
    # consenso: su propia prueba en adelante con la puntuación combinada de cada sesión (positiva = alcista)
    comb = combinar(punts)
    senales["combo"] = {"sign": 1, "sessions": len(comb), "first": min(comb) if comb else None,
                        "date": max(comb) if comb else None, "eval": evaluar(idx, comb)}
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
