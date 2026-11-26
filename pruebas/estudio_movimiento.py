"""Estudio (estudio.yml, script=estudio_movimiento.py): qué anticipa cuánto se moverá una acción en las próximas
sesiones. Magnitud, no dirección: base del screener de movimiento esperado.

Solo lee (R2 y velas diarias de Tradier). Los registros de Actions son públicos: imprime agregados.

A. Precio, con historia larga (velas diarias de Tradier desde DESDE, acciones de la lista del historial diario):
   compresión (RV5/RV60), rango intradía (5 frente a 60 sesiones), choque de la última sesión y nivel de volatilidad
   (RV20) frente a la volatilidad del último año. Objetivo: |rendimiento| de la sesión siguiente y volatilidad
   realizada de las 5 siguientes, en unidades de la volatilidad del último año (así no gana siempre la acción más
   volátil: mide "más de lo normal para ella").
B. Opciones, con las cadenas al cierre de hist500 (desde el 2026-11-04): movimiento implícito a 1 y 5 sesiones,
   evento en la estructura temporal (salto de varianza a plazo entre dos vencimientos: resultados u otro evento,
   sin calendario), gamma de dealers frente al volumen en $ (motor Perfil, posición estándar), precio frente al flip
   y O/S. Objetivo: el movimiento realizado en % y su cociente con el implícito (¿algo anticipa más de lo que ya
   cotizan las opciones?).

Prueba: IC de rangos transversal por sesión (Spearman), media y t de Newey-West con tantos retardos como el horizonte;
media del objetivo por quintil de la señal."""
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import warnings  # noqa: E402

import numpy as np  # noqa: E402

import almacen  # noqa: E402
import gex_engine as g  # noqa: E402
import movimiento  # noqa: E402
import skew  # noqa: E402

DESDE = "2015-01-01"
HORIZONTES = (1, 5)
SALTO = np.log(1.5)          # |rendimiento| mayor: split o dato roto
BASE = 250                   # sesiones de la volatilidad de referencia
MIN_ACCIONES = 20            # acciones mínimas para puntuar una sesión
GAMMA = movimiento.GAMMA


# ---------------------------------------------------------------- prueba
def _rangos(x: np.ndarray) -> np.ndarray:
    return np.argsort(np.argsort(x, kind="stable"), kind="stable").astype(float)


def ic_serie(X: np.ndarray, Y: np.ndarray) -> np.ndarray:
    """IC de rangos por fila (sesión) con las columnas (acciones) que tienen las dos cosas."""
    out = []
    for x, y in zip(X, Y):
        m = np.isfinite(x) & np.isfinite(y)
        if m.sum() < MIN_ACCIONES or np.ptp(x[m]) == 0:
            continue
        out.append(float(np.corrcoef(_rangos(x[m]), _rangos(y[m]))[0, 1]))
    return np.array(out)


def quintiles(X: np.ndarray, Y: np.ndarray) -> list[float | None]:
    """Media del objetivo por quintil transversal de la señal (Q1 = señal más baja)."""
    suma, n = np.zeros(5), np.zeros(5)
    for x, y in zip(X, Y):
        m = np.isfinite(x) & np.isfinite(y)
        if m.sum() < MIN_ACCIONES:
            continue
        q = np.minimum((_rangos(x[m]) / m.sum() * 5).astype(int), 4)
        np.add.at(suma, q, y[m])
        np.add.at(n, q, 1)
    return [round(float(s / k), 3) if k else None for s, k in zip(suma, n)]


def informe(nombre: str, X: np.ndarray, Y: np.ndarray, h: int) -> str:
    ic = ic_serie(X, Y)
    if ic.size < 3:
        return f"  {nombre:<14} sin sesiones suficientes ({ic.size})"
    t = skew._t_nw(ic, h)
    q = quintiles(X, Y)
    return (f"  {nombre:<14} IC {ic.mean():+.3f}  t {t:+.1f}  sesiones {ic.size:>5}  "
            f"quintiles {' / '.join('-' if v is None else f'{v:.2f}' for v in q)}")


# ---------------------------------------------------------------- datos de precio
def velas(sym: str) -> tuple[str, dict]:
    try:
        d = (g.fetch_aux("historical", sym, ttl=6 * 3600) or {}).get("data", [])
    except Exception:  # noqa: BLE001
        d = []
    return sym, {r["date"]: (float(r.get("high") or r["close"]), float(r.get("low") or r["close"]), float(r["close"]),
                             float(r.get("volume") or 0)) for r in d if r.get("date", "") >= DESDE and r.get("close")}


def matrices(datos: dict[str, dict], fechas: list[str]) -> dict[str, np.ndarray]:
    """Matrices sesión × acción: rendimientos, rango intradía relativo y volumen en $."""
    syms = list(datos)
    H, L, C, V = (np.full((len(fechas), len(syms)), np.nan) for _ in range(4))
    pos = {f: i for i, f in enumerate(fechas)}
    for j, s in enumerate(syms):
        for f, (h, lo, c, v) in datos[s].items():
            if f in pos:
                H[pos[f], j], L[pos[f], j], C[pos[f], j], V[pos[f], j] = h, lo, c, v
    R = np.full_like(C, np.nan)
    R[1:] = np.log(C[1:] / C[:-1])
    R[np.abs(R) > SALTO] = np.nan
    return {"r": R, "rango": (H - L) / C, "dv": C * V}


def _movil(x: np.ndarray, n: int, f) -> np.ndarray:
    """f sobre las n sesiones que acaban en cada fila (NaN si falta más de una cuarta parte)."""
    out = np.full_like(x, np.nan)
    for i in range(n - 1, len(x)):
        w = x[i - n + 1:i + 1]
        ok = np.isfinite(w).sum(axis=0) >= max(2, int(n * 0.75))
        with np.errstate(all="ignore"):
            v = f(w)
        out[i] = np.where(ok, v, np.nan)
    return out


def _sd(w):
    return np.nanstd(w, axis=0, ddof=1)


def _media(w):
    return np.nanmean(w, axis=0)


def senales_precio(M: dict[str, np.ndarray]) -> tuple[dict[str, np.ndarray], np.ndarray]:
    R = M["r"]
    base = _movil(R, BASE, _sd)
    with np.errstate(all="ignore"):
        rv5, rv20, rv60 = _movil(R, 5, _sd), _movil(R, 20, _sd), _movil(R, 60, _sd)
        rg5, rg60 = _movil(M["rango"], 5, _media), _movil(M["rango"], 60, _media)
        return {
            "compresion": np.log(rv5 / rv60),
            "rango": np.log(rg5 / rg60),
            "choque": np.abs(R) / base,
            "nivel": rv20 / base,
        }, base


def objetivos(R: np.ndarray) -> dict[int, np.ndarray]:
    """Movimiento realizado tras cada sesión: |r| de la siguiente (h=1) o RMS de las h siguientes."""
    out = {}
    for h in HORIZONTES:
        Y = np.full_like(R, np.nan)
        for i in range(len(R) - h):
            w = R[i + 1:i + 1 + h]
            Y[i] = np.where(np.isfinite(w).all(axis=0), np.sqrt((w ** 2).mean(axis=0)), np.nan)
        out[h] = Y
    return out


# ---------------------------------------------------------------- datos de opciones
def leer_dia(st, sym: str, clave: str) -> tuple[str, str, dict] | None:
    dia = re.search(r"/(\d{4}-\d{2}-\d{2})\.json\.gz$", clave).group(1)
    try:
        d = almacen.get_json(st, clave) or {}
        if not d.get("chain") or not d.get("spot"):
            return None
        ch = g.parse_chain({"_min": d["chain"]})
        spot = float(d["spot"])
        now = datetime.fromisoformat(dia + "T16:00")
        mv = g.implied_moves(ch, spot, now) or {}
        ev = movimiento.evento(ch, spot, now)
        lv = (((d.get("levels") or {}).get(GAMMA[0]) or {}).get(GAMMA[1]) or {}).get(GAMMA[2]) or {}
        return sym, dia, {
            "m1": (mv.get("d1") or {}).get("pct"), "m5": (mv.get("d5") or {}).get("pct"),
            "ev": ev[0] if ev else 0.0, "ev_n": ev[2] if ev else None,
            "gamma": lv.get("net_per_pct"), "flip": lv.get("flip"), "spot": spot,
        }
    except Exception:  # noqa: BLE001  (un día roto no para el resto)
        return None


# ---------------------------------------------------------------- estudio
def parte_a(datos: dict[str, dict]) -> tuple[list[str], dict]:
    fechas = sorted({f for d in datos.values() for f in d})
    M = matrices(datos, fechas)
    S, base = senales_precio(M)
    Y = objetivos(M["r"])
    print(f"\nA. PRECIO: {len(datos)} acciones, {len(fechas)} sesiones ({fechas[0]} a {fechas[-1]})")
    for h in HORIZONTES:
        Yn = Y[h] / base
        print(f"\n objetivo: movimiento de {'la sesión siguiente' if h == 1 else f'las {h} siguientes'} / vol. de un año")
        for k, X in S.items():
            print(informe(k, X, Yn, h))
        # por tramos de años: que no sea un solo episodio
        for a, b in (("2015", "2019"), ("2020", "2022"), ("2023", "2026")):
            filas = np.array([a <= f[:4] <= b for f in fechas])
            ics = {k: ic_serie(X[filas], Yn[filas]) for k, X in S.items()}
            print(f"   {a}-{b}: " + ", ".join(f"{k} {v.mean():+.3f}" if v.size else f"{k} -" for k, v in ics.items()))
    return fechas, {"M": M, "S": S, "base": base}


def parte_b(st, acciones: list[str], fechas_a: list[str], A: dict):
    rx = re.compile(r"/(\d{4}-\d{2}-\d{2})\.json\.gz$")
    claves = [(s, k) for s in acciones for k in st.list(f"hist500/{s}/") if rx.search(k)]
    with ThreadPoolExecutor(max_workers=16) as ex:   # cada lectura de R2 tarda ~1 s desde GitHub
        filas = [x for x in ex.map(lambda sk: leer_dia(st, *sk), claves) if x]
    dias = sorted({d for _, d, _ in filas})
    print(f"\nB. OPCIONES: {len(filas)} cadenas, {len({s for s, _, _ in filas})} acciones, "
          f"{len(dias)} sesiones ({dias[0] if dias else '-'} a {dias[-1] if dias else '-'})")
    if len(dias) < 3:
        return
    pos_a = {f: i for i, f in enumerate(fechas_a)}
    syms = acciones
    col = {s: j for j, s in enumerate(syms)}
    sk = {f: v for f, v in (almacen.get_json(st, skew.INDICE) or {}).items()}
    R, dv = A["M"]["r"], A["M"]["dv"]
    adv = _movil(dv, 20, _media)
    rv20 = _movil(R, 20, _sd)
    Yr = objetivos(R)
    campos = ("m1", "m5", "evento", "gamma_adv", "bajo_flip", "os", "implicito_rv", "compresion", "base")
    X = {k: np.full((len(dias), len(syms)), np.nan) for k in campos}
    Yp = {h: np.full((len(dias), len(syms)), np.nan) for h in HORIZONTES}
    ev_n = np.full((len(dias), len(syms)), np.nan)
    for s, dia, v in filas:
        i, j = dias.index(dia), col[s]
        ia = pos_a.get(dia)
        X["m1"][i, j] = v["m1"] if v["m1"] else np.nan
        X["m5"][i, j] = v["m5"] if v["m5"] else np.nan
        X["evento"][i, j] = v["ev"]
        ev_n[i, j] = v["ev_n"] if v["ev_n"] else np.nan
        if v["flip"]:
            X["bajo_flip"][i, j] = float(v["spot"] < v["flip"])
        fila_sk = (sk.get(dia) or {}).get(s) or []
        if len(fila_sk) > 5 and fila_sk[4] and fila_sk[5]:
            X["os"][i, j] = np.log(fila_sk[4] * 100 / fila_sk[5])
        if ia is None:
            continue
        if v["gamma"] is not None and np.isfinite(adv[ia, j]) and adv[ia, j] > 0:
            X["gamma_adv"][i, j] = v["gamma"] / adv[ia, j]
        if v["m5"] and np.isfinite(rv20[ia, j]) and rv20[ia, j] > 0:
            X["implicito_rv"][i, j] = v["m5"] / 100 / np.sqrt(5) / rv20[ia, j]
        X["compresion"][i, j] = A["S"]["compresion"][ia, j]
        X["base"][i, j] = A["base"][ia, j] * 100
        for h in HORIZONTES:
            Yp[h][i, j] = Yr[h][ia, j] * 100 * np.sqrt(h)   # en % del movimiento acumulado de 1 sigma
    for h in HORIZONTES:
        imp = X["m1" if h == 1 else "m5"]
        ok = np.isfinite(Yp[h]) & np.isfinite(imp)
        print(f"\n horizonte {h}: {int(ok.any(axis=1).sum())} sesiones con resultado; realizado/implícito medio "
              f"{np.nanmedian(Yp[h][ok] / imp[ok]):.2f} (mediana)" if ok.any() else f"\n horizonte {h}: sin resultado")
        if not ok.any():
            continue
        print("  objetivo: movimiento realizado en %")
        for k in ("m1" if h == 1 else "m5", "base", "evento"):
            print(informe(k, X[k], Yp[h], h))
        print("  objetivo: realizado / implícito (¿anticipa más de lo que cotizan las opciones?)")
        rel = Yp[h] / imp
        for k in ("evento", "gamma_adv", "bajo_flip", "os", "implicito_rv", "compresion"):
            print(informe(k, X[k], rel, h))
    # eventos: ¿el salto de la estructura temporal anticipa el día grande?
    hay = np.isfinite(ev_n) & (ev_n <= 5)
    if hay.any():
        i, j = np.nonzero(hay)
        dias_ok = [(a, b) for a, b in zip(i, j) if pos_a.get(dias[a]) is not None]
        mx, prev, sin = [], [], []
        for a, b in dias_ok:
            ia = pos_a[dias[a]]
            w = R[ia + 1:ia + 6, b]
            if len(w) == 5 and np.isfinite(w).all():
                mx.append(float(np.abs(w).max() * 100))
                prev.append(float(X["evento"][a, b]))
        for a in range(len(dias)):
            ia = pos_a.get(dias[a])
            if ia is None or ia + 5 >= len(R):
                continue
            for b in range(len(syms)):
                if not hay[a, b] and np.isfinite(X["m1"][a, b]):
                    w = R[ia + 1:ia + 6, b]
                    if np.isfinite(w).all():
                        sin.append(float(np.abs(w).max() * 100 / X["m1"][a, b]))
        print(f"\n eventos en las próximas 5 sesiones: {int(hay.sum())} acción-día, {len(mx)} con resultado")
        if mx:
            mx, prev = np.array(mx), np.array(prev)
            print(f"  mayor |movimiento| diario de las 5 siguientes: mediana {np.median(mx):.2f} %, "
                  f"evento implícito mediana {np.median(prev):.2f} %, cociente mediano {np.median(mx / prev):.2f}")
            if len(mx) >= 5:
                print(f"  correlación de rangos evento implícito / mayor movimiento: "
                      f"{np.corrcoef(_rangos(prev), _rangos(mx))[0, 1]:+.2f}")
        if sin:
            print(f"  sin evento: mayor |movimiento| de las 5 siguientes / implícito de 1 sesión, mediana {np.median(sin):.2f}")
    hoy = dias[-1]
    i = dias.index(hoy)
    top = sorted(((X["evento"][i, j], s, ev_n[i, j]) for s, j in col.items() if X["evento"][i, j] > 0), reverse=True)
    print(f"\n eventos implícitos el {hoy}: {len(top)}; mayores: "
          + ", ".join(f"{s} {e:.1f} % (<= {n:.0f} ses.)" for e, s, n in top[:10]))


def main():
    warnings.simplefilter("ignore", RuntimeWarning)   # ventanas con huecos: dan NaN y se descartan
    st = almacen.abrir()
    idx = almacen.get_json(st, skew.INDICE) or {}
    nombres = dict(g.load_symbols())
    ultimo = idx[max(idx)] if idx else {}
    acciones = sorted(s for s in ultimo if skew.es_accion(s, nombres))
    print(f"acciones de la lista con lectura el {max(idx) if idx else '-'}: {len(acciones)}")
    with ThreadPoolExecutor(max_workers=8) as ex:
        datos = {s: d for s, d in ex.map(velas, acciones) if len(d) > BASE + 60}
    print(f"con velas diarias suficientes: {len(datos)}")
    acciones = list(datos)
    fechas, A = parte_a(datos)
    parte_b(st, acciones, fechas, A)


if __name__ == "__main__":
    main()
