"""Estudio: probabilidad de que el SPX cierre fuera del 1σ del VIX (modelo 1 en pequeño).

Objetivo del día t: |ln(C_t / C_{t-1})| > VIX_{t-1} / 100 / raíz(252). Variables del cierre de t-1:
  gex   percentil del GEX de SqueezeMetrics frente a las 252 sesiones previas
  r9    VIX9D / VIX            (parte corta de la curva)
  r3    VIX / VIX3M            (pendiente a 3 meses)
  rv5   media de |rendimiento| de las 5 sesiones previas / sigma del VIX (lo que se está moviendo frente a lo que
        descuenta el VIX)
  lvix  log del VIX
Regresión logística por Newton (macro.logit_fit). Entrena en 2012-2019 y prueba en 2020-hoy sin tocar nada;
referencias: la frecuencia fija de entrenamiento y una logística solo con log VIX. Se comparan Brier y log-loss
fuera de muestra, y la calibración por deciles. Sin eventos macro: no hay calendario histórico anterior a 2026.

Uso: python pruebas/modelo_1sigma.py [precio vol]   (por defecto SPX VIX; p. ej. QQQ VXN)"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import macro  # noqa: E402

CORTE = "2020-01-01"


def main(precio="SPX", vol="VIX"):
    X, y, f, nombres = macro.datos_1sigma(precio, vol)
    tr, te = f < CORTE, f >= CORTE
    print(f"{precio} con {vol}. días: {len(y)} ({f[0]} a {f[-1]}); entrenamiento {int(tr.sum())}, prueba "
          f"{int(te.sum())}; rompe el 1σ: {y[tr].mean():.1%} / {y[te].mean():.1%}")
    # lo que usa el rango ajustado: por quintil del GEX del SPX, % de días fuera del 1σ (toda la historia)
    q = np.minimum(4, (X[:, nombres.index("gex")] * 5).astype(int))
    print("por quintil del GEX del SPX: " + ", ".join(f"Q{k + 1} {y[q == k].mean():.1%}" for k in range(5)))
    i2 = [nombres.index(c) for c in macro.SIGMA1_MODELO]
    m2 = macro.logit_fit(X[tr][:, i2], y[tr])
    b2m = np.mean((macro.logit_prob(X[te][:, i2], m2) - y[te]) ** 2)
    m2r = macro.logit_fit(X[te][:, i2], y[te])
    b2r = np.mean((macro.logit_prob(X[tr][:, i2], m2r) - y[tr]) ** 2)
    print(f"modelo publicado ({', '.join(macro.SIGMA1_MODELO)}): Brier {b2m:.4f} en 2020-hoy "
          f"(fija {np.mean((y[tr].mean() - y[te]) ** 2):.4f}); al revés {b2r:.4f} (fija {np.mean((y[te].mean() - y[tr]) ** 2):.4f})")

    def evalua(nombre, p):
        p = np.clip(p, 1e-6, 1 - 1e-6)
        brier = np.mean((p - y[te]) ** 2)
        ll = -np.mean(y[te] * np.log(p) + (1 - y[te]) * np.log(1 - p))
        print(f"{nombre:30} Brier {brier:.4f}   log-loss {ll:.4f}")
        return brier

    b0 = evalua("frecuencia fija", np.full(te.sum(), y[tr].mean()))
    i_v = [nombres.index("lvix")]
    w_v = macro.logit_fit(X[tr][:, i_v], y[tr])
    b1 = evalua("solo log VIX", macro.logit_prob(X[te][:, i_v], w_v))
    w = macro.logit_fit(X[tr], y[tr])
    p = macro.logit_prob(X[te], w)
    b2 = evalua("modelo completo", p)
    print(f"mejora de Brier frente a solo VIX: {1 - b2 / b1:.1%}; frente a la frecuencia fija: {1 - b2 / b0:.1%}")
    print("coeficientes (entrenamiento, variables estandarizadas):",
          ", ".join(f"{n} {c:+.2f}" for n, c in zip(["const"] + nombres, w["w"])))
    # aportación de cada variable: Brier fuera de muestra al quitarla
    for k, n in enumerate(nombres):
        idx = [j for j in range(len(nombres)) if j != k]
        wk = macro.logit_fit(X[tr][:, idx], y[tr])
        bk = np.mean((macro.logit_prob(X[te][:, idx], wk) - y[te]) ** 2)
        print(f"  sin {n:5}: Brier {bk:.4f} ({'empeora' if bk > b2 else 'mejora'} {abs(bk / b2 - 1):.1%})")
    print("calibración fuera de muestra (deciles de probabilidad):")
    q = np.quantile(p, np.linspace(0, 1, 11))
    for a, b in zip(q[:-1], q[1:]):
        m = (p >= a) & (p <= b)
        print(f"  {a:5.1%}-{b:5.1%}: previsto {p[m].mean():5.1%}, real {y[te][m].mean():5.1%} ({int(m.sum())} días)")


if __name__ == "__main__":
    main(*sys.argv[1:3])
