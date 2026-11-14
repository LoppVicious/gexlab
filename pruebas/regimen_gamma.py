"""Estudio: ¿el régimen de gamma del SPX predice la forma del día siguiente? (2011 hasta hoy)

Datos: GEX diario del SPX de SqueezeMetrics (CSV público, desde 2011-05-02) y OHLC de SPX y VIX de CBOE.
El GEX de la fecha t sale con datos del cierre de t, así que la señal de cada día es el GEX del día anterior.
El régimen es el percentil del GEX frente a las 252 sesiones previas (sin mirar el futuro: el GEX crece con el
mercado y un umbral fijo no sirve), en quintiles Q1 (gamma baja o negativa) a Q5 (gamma alta).

Pruebas, todas medidas en unidades del movimiento esperado del VIX (sigma diaria = VIX / raíz(252)):
  1. Rango: rango intradía ln(H/L) / sigma y frecuencia de |rendimiento| > sigma (rompe el movimiento esperado).
     Además, regresión del log del rango con referencia HAR (rango de ayer, media de 5 y 22 días) y log VIX:
     ¿el GEX añade algo? Errores de Newey-West con 5 retardos.
  2. Gap: con |gap| > 0,25 sigma, fracción de gaps que se cierran en la sesión (vuelven al cierre anterior).
  3. Continuación: signo(gap) x rendimiento apertura-cierre (positivo = el día sigue al gap) y autocorrelación
     de los rendimientos diarios (positiva = momentum, negativa = reversión).
Separa 2011-2018 y 2019-hoy para ver si el efecto aguanta. Solo imprime estadísticos agregados.

Uso: python pruebas/regimen_gamma.py   (o en Actions con comparar.yml, inputs[script]=regimen_gamma.py)."""
import csv
import io
import math
import os
import sys
import urllib.request

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import gex_engine as g  # noqa: E402

URL_SM = "https://squeezemetrics.com/monitor/static/DIX.csv"
VENTANA = 252
GAP_MIN = 0.25          # gap mínimo, en sigmas diarias
CORTE = "2019-01-01"    # separa las dos mitades


def gex_squeezemetrics() -> dict[str, float]:
    req = urllib.request.Request(URL_SM, headers={"User-Agent": "Mozilla/5.0 (estudio)"})
    with urllib.request.urlopen(req, timeout=60) as r:
        texto = r.read().decode("utf-8")
    return {f["date"]: float(f["gex"]) for f in csv.DictReader(io.StringIO(texto)) if f.get("gex")}


def percentil_movil(x: np.ndarray, n: int) -> np.ndarray:
    """Percentil de x[i] frente a x[i-n:i] (NaN mientras no hay n previos)."""
    out = np.full(len(x), np.nan)
    for i in range(n, len(x)):
        out[i] = (x[i - n:i] < x[i]).mean()
    return out


def ols_nw(y: np.ndarray, X: np.ndarray, lags: int = 5) -> tuple[np.ndarray, np.ndarray, float]:
    """Coeficientes, t de Newey-West y R2."""
    X = np.column_stack([np.ones(len(y)), X])
    b = np.linalg.lstsq(X, y, rcond=None)[0]
    e = y - X @ b
    xe = X * e[:, None]
    S = xe.T @ xe
    for k in range(1, lags + 1):
        w = 1 - k / (lags + 1)
        G = xe[k:].T @ xe[:-k]
        S += w * (G + G.T)
    inv = np.linalg.inv(X.T @ X)
    se = np.sqrt(np.diag(inv @ S @ inv))
    r2 = 1 - e.var() / y.var()
    return b, b / se, r2


def t_diferencia(a: np.ndarray, b: np.ndarray) -> float:
    """t de Welch de media(a) - media(b)."""
    return (a.mean() - b.mean()) / math.sqrt(a.var(ddof=1) / len(a) + b.var(ddof=1) / len(b))


def main() -> None:
    gex = gex_squeezemetrics()
    spx, _ = g.history_ohlc("SPX")
    vix, _ = g.history_ohlc("VIX")
    fechas = sorted(set(gex) & set(spx) & set(vix))
    print(f"sesiones comunes: {len(fechas)} ({fechas[0]} a {fechas[-1]})")

    G = np.array([gex[f] for f in fechas])
    O, H, L, C = (np.array([spx[f][k] for f in fechas]) for k in range(4))
    V = np.array([vix[f][3] for f in fechas])
    pct = percentil_movil(G, VENTANA)

    # día t usa la señal de t-1
    i = np.arange(1, len(fechas))
    sig = V[i - 1] / 100 / math.sqrt(252)
    q = np.floor(pct[i - 1] * 5).clip(0, 4)              # 0..4 = Q1..Q5
    neg = G[i - 1] < 0
    rango = np.log(H[i] / L[i]) / sig
    ret = np.log(C[i] / C[i - 1])
    rompe = np.abs(ret) > sig
    gap = np.log(O[i] / C[i - 1])
    oc = np.log(C[i] / O[i])
    ret_prev = np.r_[np.nan, ret[:-1]]
    abre_valida = np.abs(O[i] - C[i - 1]) > 0.01        # CBOE repite el cierre como apertura algunos días
    cerrado = np.where(gap > 0, L[i] <= C[i - 1], H[i] >= C[i - 1])
    gap_ok = abre_valida & (np.abs(gap) > GAP_MIN * sig)
    seguir = np.sign(gap) * oc / sig
    f_i = np.array(fechas)[i]
    valido = ~np.isnan(pct[i - 1]) & np.isfinite(rango) & (rango > 0)

    print(f"días con GEX negativo: {int(neg[valido].sum())} de {int(valido.sum())}")
    for nombre, m_per in (("2011-hoy", valido), ("2011-2018", valido & (f_i < CORTE)),
                          ("2019-hoy", valido & (f_i >= CORTE))):
        print(f"\n=== {nombre} ({int(m_per.sum())} días) ===")
        print("grupo     n   rango/s  |r|>s  gap n  cierra  sigue/s  autocorr")
        grupos = [(f"Q{k + 1}", m_per & (q == k)) for k in range(5)] + [("GEX<0", m_per & neg)]
        for etq, m in grupos:
            mg = m & gap_ok
            mc = m & np.isfinite(ret_prev)
            ac = np.corrcoef(ret_prev[mc], ret[mc])[0, 1] if mc.sum() > 10 else float("nan")
            print(f"{etq:6} {int(m.sum()):5}  {rango[m].mean():7.2f}  {rompe[m].mean():5.1%}  {int(mg.sum()):5}  "
                  f"{cerrado[mg].mean():6.1%}  {seguir[mg].mean():+7.3f}  {ac:+8.3f}")
        lo, hi = m_per & (q == 0), m_per & (q == 4)
        glo, ghi = lo & gap_ok, hi & gap_ok
        print(f"Q1 - Q5: rango/s {rango[lo].mean() - rango[hi].mean():+.2f} (t {t_diferencia(rango[lo], rango[hi]):.1f}), "
              f"|r|>s {rompe[lo].mean() - rompe[hi].mean():+.1%} "
              f"(t {t_diferencia(rompe[lo].astype(float), rompe[hi].astype(float)):.1f}), "
              f"gap cerrado {cerrado[glo].mean() - cerrado[ghi].mean():+.1%} "
              f"(t {t_diferencia(cerrado[glo].astype(float), cerrado[ghi].astype(float)):.1f})")

        # ¿añade el GEX algo a una referencia HAR + VIX? (en log del rango absoluto)
        lr = np.log(np.log(H[i] / L[i]))
        r_all = np.log(H / L)
        har1 = np.log(r_all[i - 1])
        har5 = np.log(np.array([r_all[max(0, k - 5):k].mean() for k in i]))
        har22 = np.log(np.array([r_all[max(0, k - 22):k].mean() for k in i]))
        lv = np.log(V[i - 1])
        m = m_per & np.isfinite(har1) & np.isfinite(har5) & np.isfinite(har22) & (i >= 23)
        base = np.column_stack([har1[m], har5[m], har22[m], lv[m]])
        _, _, r2b = ols_nw(lr[m], base)
        b, t, r2 = ols_nw(lr[m], np.column_stack([base, pct[i - 1][m]]))
        print(f"log rango ~ HAR + log VIX: R2 {r2b:.3f}; + percentil GEX: R2 {r2:.3f}, "
              f"coef {b[-1]:+.3f} (t NW {t[-1]:.1f}; -0,1 = rango un 10 % menor de Q1 a Q5)")


if __name__ == "__main__":
    main()
