"""Estudio: ¿se cierra el gap de apertura? ¿o el día sigue en la dirección del gap? (SPY y QQQ, 2012 hasta hoy)

Gap = ln(apertura_t / cierre_{t-1}) en sigmas diarias del índice de volatilidad del día anterior (VIX para SPY, VXN
para QQQ). Solo gaps de más de 0,1 σ. Objetivos:
  cierra  el precio vuelve en la sesión al cierre anterior (mínimo ≤ cierre previo si el gap es al alza; máximo ≥ si
          es a la baja)
  sigue   el cierre del día queda más allá de la apertura en la dirección del gap (día de tendencia)
Variables (conocidas en la apertura): |gap| en σ, dirección (+1 alza), percentil del GEX de SqueezeMetrics del día
anterior, VIX9D/VIX del día anterior, rendimiento del día anterior en σ con el signo del gap.
Regresión logística (macro.logit_fit); entrena en 2012-2019 y prueba en 2020-hoy, y al revés. Referencias: la
frecuencia fija y una logística solo con |gap| (lo obvio: los gaps grandes se cierran menos).
Usa SPY y QQQ porque sus aperturas son operaciones reales (en el SPX de CBOE hay años con la apertura igual al cierre
anterior).

Uso: python pruebas/estudio_gaps.py"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import macro  # noqa: E402

CORTE = "2020-01-01"
NOMBRES = macro.GAP_VARS


def brier(p, y):
    return float(np.mean((p - y) ** 2))


def prueba(X, y, F, nombre):
    tr, te = F < CORTE, F >= CORTE
    print(f"\n--- {nombre}: {y.mean():.1%} de {len(y)} gaps (entrenamiento {y[tr].mean():.1%}, prueba {y[te].mean():.1%})")
    for a, b, et in ((tr, te, "2012-2019 -> 2020-hoy"), (te, tr, "2020-hoy -> 2012-2019")):
        fija = brier(np.full(b.sum(), y[a].mean()), y[b])
        mg = macro.logit_fit(X[a][:, :1], y[a])
        solo = brier(macro.logit_prob(X[b][:, :1], mg), y[b])
        m = macro.logit_fit(X[a], y[a])
        p = macro.logit_prob(X[b], m)
        comp = brier(p, y[b])
        print(f"{et}: Brier fija {fija:.4f}, solo |gap| {solo:.4f}, completo {comp:.4f} "
              f"(mejora frente a solo |gap| {1 - comp / solo:+.1%})")
    m = macro.logit_fit(X, y)
    print("coeficientes (todo, estandarizados):", ", ".join(f"{n} {c:+.2f}" for n, c in zip(["const"] + NOMBRES, m["w"])))
    m = macro.logit_fit(X[tr], y[tr])
    p = macro.logit_prob(X[te], m)
    for k, n in enumerate(NOMBRES[1:], 1):          # aportación de cada variable además del tamaño del gap
        idx = [j for j in range(len(NOMBRES)) if j != k]
        bk = brier(macro.logit_prob(X[te][:, idx], macro.logit_fit(X[tr][:, idx], y[tr])), y[te])
        print(f"  sin {n:4}: Brier {bk:.4f} ({'empeora' if bk > brier(p, y[te]) else 'mejora'} {abs(bk / brier(p, y[te]) - 1):.1%})")
    # tabla simple por tamaño de gap y régimen de gamma (toda la historia)
    q = np.minimum(4, (X[:, 2] * 5).astype(int))
    for lo, hi in ((0.1, 0.3), (0.3, 0.6), (0.6, 1.0), (1.0, 99)):
        m = (X[:, 0] >= lo) & (X[:, 0] < hi)
        print(f"  gap {lo}-{hi} σ ({int(m.sum())}): {y[m].mean():.0%};  gamma baja (Q1-2) {y[m & (q <= 1)].mean():.0%}, "
              f"alta (Q4-5) {y[m & (q >= 3)].mean():.0%}")


def main():
    for precio, vol in (("SPY", "VIX"), ("QQQ", "VXN")):
        X, yc, ys, F = macro.datos_gaps(precio, vol)
        print(f"\n===== {precio} (sigma del {vol}), {F[0]} a {F[-1]} =====")
        prueba(X, yc, F, "el gap se cierra")
        prueba(X, ys, F, "el día sigue al gap")


if __name__ == "__main__":
    main()
