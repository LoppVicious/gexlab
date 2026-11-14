"""Estudio: ¿la forma de la curva del VIX anticipa lo que hace el SPX después? (2009 hasta hoy)

Datos: cierres diarios de CBOE de SPX, VIX, VIX3M (desde 2009-09) y VIX9D (desde 2011).
Señal del cierre de t; resultado desde el cierre de t:
  - rendimiento del SPX a 5 y 20 sesiones (media, mediana, % de veces al alza);
  - volatilidad realizada de las 20 sesiones siguientes (cierre a cierre, anualizada) frente al VIX de t.
Tramos de VIX/VIX3M (pendiente a 3 meses) y de VIX9D/VIX (pendiente de la parte corta). Para cada tramo, t de
Newey-West de la diferencia con la media de todos los días (las ventanas se solapan) y las dos mitades
(2009-2017 y 2018-hoy) para ver si aguanta. Solo imprime estadísticos agregados.

Uso: python pruebas/regimen_vix.py   (o en Actions con comparar.yml, inputs[script]=regimen_vix.py)."""
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import gex_engine as g  # noqa: E402

CORTE = "2018-01-01"
TRAMOS_3M = [("< 0.80 (deep contango)", 0, 0.80), ("0.80-0.88", 0.80, 0.88), ("0.88-0.95", 0.88, 0.95),
             ("0.95-1.00", 0.95, 1.00), ("> 1.00 (backwardation)", 1.00, 9)]
TRAMOS_9D = [("< 0.85", 0, 0.85), ("0.85-0.95", 0.85, 0.95), ("0.95-1.05", 0.95, 1.05), ("> 1.05", 1.05, 9)]


def cierres(sym):
    d, _ = g.history_ohlc(sym)
    return {k: v[3] for k, v in d.items() if v[3] > 0}


def t_nw(x, lags):
    n = len(x)
    if n < 10:
        return float("nan")
    e = x - x.mean()
    s = float(e @ e) / n
    for k in range(1, min(lags, n - 1) + 1):
        s += 2 * (1 - k / (lags + 1)) * float(e[k:] @ e[:-k]) / n
    return float(x.mean() / math.sqrt(s / n)) if s > 0 else float("nan")


def main():
    spx, vix, v3, v9 = (cierres(s) for s in ("SPX", "VIX", "VIX3M", "VIX9D"))
    fechas = sorted(set(spx) & set(vix) & set(v3))
    C = np.array([spx[f] for f in fechas])
    V = np.array([vix[f] for f in fechas])
    R3 = V / np.array([v3[f] for f in fechas])
    R9 = np.array([v9[f] / vix[f] if f in v9 else np.nan for f in fechas])
    n = len(fechas)
    lr = np.diff(np.log(C))
    f5 = np.full(n, np.nan); f20 = np.full(n, np.nan); rv = np.full(n, np.nan)
    for i in range(n):
        if i + 5 < n:
            f5[i] = C[i + 5] / C[i] - 1
        if i + 20 < n:
            f20[i] = C[i + 20] / C[i] - 1
            rv[i] = lr[i:i + 20].std(ddof=1) * math.sqrt(252) * 100
    spread = rv - V                                  # realizada siguiente − VIX (negativo = la prima se cobró)
    F = np.array(fechas)
    print(f"sesiones: {n} ({fechas[0]} a {fechas[-1]}); hoy VIX/VIX3M {R3[-1]:.3f}, VIX9D/VIX {R9[-1]:.3f}")

    def tabla(nombre, R, tramos):
        for per, m_per in (("todo", np.ones(n, bool)), ("2009-2017", F < CORTE), ("2018-hoy", F >= CORTE)):
            ok = m_per & np.isfinite(R)
            b5, b20 = np.nanmean(f5[ok]), np.nanmean(f20[ok])
            print(f"\n=== {nombre}, {per} ({int(ok.sum())} días; media de todos: 5d {b5:+.2%}, 20d {b20:+.2%}) ===")
            print("tramo                      días   5d media  %up   20d media  mediana  %up   t(20d-todos)  RV20-VIX")
            for et, lo, hi in tramos:
                m = ok & (R >= lo) & (R < hi)
                m5, m20 = m & np.isfinite(f5), m & np.isfinite(f20)
                if m20.sum() < 20:
                    print(f"{et:25} {int(m.sum()):5}  pocos datos")
                    continue
                d20 = f20[m20] - b20
                print(f"{et:25} {int(m.sum()):5}  {f5[m5].mean():+7.2%} {np.mean(f5[m5] > 0):5.0%}  {f20[m20].mean():+8.2%} "
                      f"{np.median(f20[m20]):+8.2%} {np.mean(f20[m20] > 0):5.0%}  {t_nw(d20, 19):8.1f}     "
                      f"{np.nanmean(spread[m20]):+6.1f}")

    tabla("VIX/VIX3M", R3, TRAMOS_3M)
    tabla("VIX9D/VIX", R9, TRAMOS_9D)


if __name__ == "__main__":
    main()
