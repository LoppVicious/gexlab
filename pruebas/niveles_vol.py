"""Estudio de los cortes de macro.VOLREG (régimen de volatilidad): niveles de VIX, VVIX, VIX3M/VIX y SKEW/VIX.
Episodio = primer cierre diario que cumple la condición tras >= 20 sesiones sin cumplirla.
Uso: python pruebas/niveles_vol.py (o en Actions con comparar.yml).
Resultado: SPX a 20/60/120 sesiones (media, % al alza), caída adicional máxima en 60 sesiones (min/entrada - 1)."""
import os
import sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import gex_engine as g  # noqa: E402
import macro  # noqa: E402


def cierres(sym):
    d, _ = g.history_ohlc(sym)
    return {k: v[3] for k, v in d.items() if v[3] > 0}


csv_cboe = macro._csv_cierres


spx, vix, v3 = cierres("SPX"), cierres("VIX"), cierres("VIX3M")
vvix, skew = csv_cboe("VVIX"), csv_cboe("SKEW")
F = sorted(f for f in spx if f >= "1990-01-02" and f in vix)
C = np.array([spx[f] for f in F])
n = len(C)
S = {
    "VIX": np.array([vix[f] for f in F]),
    "VVIX": np.array([vvix.get(f, np.nan) for f in F]),
    "VIX3M/VIX": np.array([v3[f] / vix[f] if f in v3 else np.nan for f in F]),
    "SKEW/VIX": np.array([skew[f] / vix[f] if f in skew else np.nan for f in F]),
}
H = (20, 60, 120)
fwd = {h: np.array([C[i + h] / C[i] - 1 if i + h < n else np.nan for i in range(n)]) for h in H}
dd60 = np.array([C[i + 1:i + 61].min() / C[i] - 1 if i + 60 < n else np.nan for i in range(n)])
# caída previa: SPX frente al máximo de 60 sesiones (cuánto llevaba corregido al dar la señal)
pre = np.array([C[i] / C[max(0, i - 60):i + 1].max() - 1 for i in range(n)])


def base(serie):
    m = np.isfinite(serie)
    i0 = int(np.argmax(m))
    sel = np.arange(i0, n)
    return sel


def fila(nombre, idx):
    idx = [i for i in idx if np.isfinite(fwd[60][i])]
    if not idx:
        return f"{nombre:<26} n=0"
    a = np.array(idx)
    t = [f"{np.nanmean(fwd[h][a])*100:+5.1f}%/{np.mean(fwd[h][a] > 0)*100:3.0f}%" for h in H]
    return (f"{nombre:<26} n={len(a):3d}  " + "  ".join(t) +
            f"  dd60 med {np.median(dd60[a])*100:5.1f}% p10 {np.percentile(dd60[a],10)*100:5.1f}%"
            f"  prev {np.median(pre[a])*100:5.1f}%")


def episodios(cond, enfriar=20):
    out, ult = [], -10**9
    for i in range(n):
        if cond[i] and i - ult > enfriar:
            out.append(i)
        if cond[i]:
            ult = i
    return out


print(f"SPX {F[0]}..{F[-1]}  columnas: ret 20/60/120 sesiones (media/% al alza), caída extra máx 60s (mediana, p10), corrección previa desde máx 60s")
for nombre, serie, umbrales, lado in (
    ("VIX", S["VIX"], (20, 25, 30, 35, 40, 45), ">="),
    ("VVIX", S["VVIX"], (110, 120, 130, 140, 150), ">="),
    ("VVIX", S["VVIX"], (85, 80, 75), "<="),
    ("VIX3M/VIX", S["VIX3M/VIX"], (1.00, 0.95, 0.90, 0.85, 0.80), "<="),
    ("VIX3M/VIX", S["VIX3M/VIX"], (1.20, 1.25, 1.30), ">="),
    ("SKEW/VIX", S["SKEW/VIX"], (6.0, 5.5, 5.0, 4.5, 4.0, 3.5), "<="),
    ("SKEW/VIX", S["SKEW/VIX"], (10, 11, 12), ">="),
):
    sel = base(serie)
    print(f"\n== {nombre} desde {F[sel[0]]}")
    print(fila("  todos los días", sel))
    for u in umbrales:
        cond = np.nan_to_num(serie >= u if lado == ">=" else serie <= u, nan=0).astype(bool)
        print(fila(f"  {lado} {u}", episodios(cond)))

# Lista de episodios de los niveles actuales, para ver fechas
print("\n== Episodios SKEW/VIX <= 5 (fecha, SPX ret 60s, dd60)")
for i in episodios(np.nan_to_num(S["SKEW/VIX"] <= 5).astype(bool)):
    print(f"  {F[i]}  VIX {S['VIX'][i]:5.1f}  r60 {fwd[60][i]*100 if np.isfinite(fwd[60][i]) else float('nan'):+6.1f}%  dd60 {dd60[i]*100 if np.isfinite(dd60[i]) else float('nan'):6.1f}%")
print("\nHoy:", {k: round(float(v[-1]), 3) for k, v in S.items()}, "VVIX csv último", max(vvix), vvix[max(vvix)], "SKEW", skew[max(skew)])
