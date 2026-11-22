"""Estudio (estudio.yml, script=estudio_pcr.py): liquidez del índice de put/call (hist500/_pcr.json.gz).

Solo lee R2. Para calibrar pcr.MIN_PATA: reparto de la pata menor (volumen × |delta| de calls o puts, la más
pequeña) por tramo en la última sesión, cuántos tickers tienen lectura con cada umbral, qué parte de sus días quedan
con lectura y los ratios más extremos que sobreviven a cada umbral."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import numpy as np  # noqa: E402

import almacen  # noqa: E402
import pcr  # noqa: E402

UMBRALES = (0, 10, 25, 50, 100)

idx = almacen.get_json(almacen.abrir(), pcr.INDICE) or {}
if not idx:
    sys.exit("indice vacio")
fechas = sorted(idx)
hoy = fechas[-1]
print(f"indice: {len(fechas)} sesiones ({fechas[0]} a {hoy}), {len(idx[hoy])} tickers hoy; MIN_PATA = {pcr.MIN_PATA}")
for t in ("t0", "t1", "t2"):
    menor = np.array([min(s[t][0], s[t][1]) for s in idx[hoy].values() if s.get(t)])
    q = np.quantile(menor, [0.1, 0.25, 0.5, 0.75, 0.9]) if menor.size else []
    print(f"\n{t}: {menor.size} tickers con contratos; pata menor (vol x |delta|) p10/p25/p50/p75/p90 = "
          + " / ".join(f"{x:,.1f}" for x in q))
    for u in UMBRALES:
        ok = [(s[t][1] / s[t][0], k) for k, s in idx[hoy].items()
              if s.get(t) and s[t][0] >= max(u, 1e-9) and s[t][1] >= max(u, 1e-9)]
        r = np.array([x for x, _ in ok])
        ext = sorted(ok, reverse=True)[:4]
        print(f"  umbral {u:>4}: {len(ok):>3} con lectura; P/C p5/p50/p95 = "
              + (" / ".join(f"{x:.2f}" for x in np.quantile(r, [0.05, 0.5, 0.95])) if r.size else "-")
              + "; mas altos: " + ", ".join(f"{k} {x:.1f}" for x, k in ext))

# parte de los días con lectura (t0 o t1) de cada ticker con todas las sesiones, por umbral
completos = [k for k in idx[hoy] if sum(1 for f in fechas if k in idx[f]) == len(fechas)]
print(f"\n{len(completos)} tickers con las {len(fechas)} sesiones; dias con lectura en t0 o t1 por umbral:")
for u in UMBRALES:
    partes = []
    for k in completos:
        n = 0
        for f in fechas:
            s = idx[f][k]
            if any(s.get(t) and s[t][0] >= max(u, 1e-9) and s[t][1] >= max(u, 1e-9) for t in ("t0", "t1")):
                n += 1
        partes.append(n / len(fechas))
    p = np.array(partes)
    print(f"  umbral {u:>4}: media {p.mean():.0%}, tickers con todos los dias {int((p == 1).sum())}, "
          f"con menos de la mitad {int((p < 0.5).sum())}")
