"""Graficos PNG del report semanal (matplotlib, solo en Actions). Fondo propio y paleta del tema Daylight: los
colores son los de THEMES.light en web/app.js (si cambian alli, cambiarlos aqui). Cada funcion devuelve bytes PNG."""
from __future__ import annotations

import io

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.colors import LinearSegmentedColormap  # noqa: E402

# THEMES.light de web/app.js
C = {"surface": "#ffffff", "grid": "#eceef4", "axis": "#d3d7e3", "text": "#11142b", "muted": "#4c5170",
     "neg": "#e11d6a", "pos": "#6a3df0", "put": "#0b9b6a", "call": "#e5484d", "amber": "#c27c0e", "accent": "#5145e5"}
ANCHO, DPI = 12, 100   # 1200 px de ancho


def _fig(alto=5.0):
    fig, ax = plt.subplots(figsize=(ANCHO, alto), dpi=DPI)
    fig.patch.set_facecolor(C["surface"])
    ax.set_facecolor(C["surface"])
    for s in ax.spines.values():
        s.set_color(C["axis"])
    ax.tick_params(colors=C["muted"], labelsize=10)
    ax.grid(True, color=C["grid"], linewidth=0.8)
    ax.set_axisbelow(True)
    return fig, ax


def _png(fig) -> bytes:
    b = io.BytesIO()
    fig.savefig(b, format="png", facecolor=fig.get_facecolor(), bbox_inches="tight")
    plt.close(fig)
    return b.getvalue()


def _titulo(ax, t):
    ax.set_title(t, loc="left", color=C["text"], fontsize=14, fontweight="bold", pad=30)


def _leyenda(ax, ncol):
    """Entre el titulo y el grafico, a la izquierda: dentro tapaba barras y lineas, y a la derecha del titulo
    chocaba con los titulos largos."""
    ax.legend(frameon=False, labelcolor=C["muted"], ncol=ncol, loc="lower left", bbox_to_anchor=(0, 1), fontsize=10,
              borderaxespad=0.2)


def gamma(sym: str, d: dict) -> bytes:
    """Spot de la semana con flip, call wall y put wall (incluye la ultima sesion de la semana anterior)."""
    filas = ([d["previa"]] if d.get("previa") else []) + d["dias"]
    x = [f["fecha"][5:] for f in filas]
    fig, ax = _fig()
    for k, col, et in (("call_wall", C["call"], "Call wall"), ("put_wall", C["put"], "Put wall"),
                       ("flip", C["amber"], "Gamma flip")):
        ax.step(x, [f.get(k) for f in filas], where="mid", color=col, linewidth=1.6, label=et)
    ax.plot(x, [f.get("spot") for f in filas], color=C["text"], linewidth=2.4, marker="o", label="Spot")
    _titulo(ax, f"{sym}: spot vs gamma levels (week)")
    _leyenda(ax, 4)
    return _png(fig)


def vol_real(nombre: str, d: dict) -> bytes:
    """Barras mensuales de vol realizada de los dias de subida y de bajada; el mes en curso, al final."""
    m = d["mensual"]
    x = list(range(len(m)))
    fig, ax = _fig()
    ax.bar([i - 0.2 for i in x], [r[1] or 0 for r in m], width=0.4, color=C["pos"], label="Up-day realized vol")
    ax.bar([i + 0.2 for i in x], [r[2] or 0 for r in m], width=0.4, color=C["neg"], label="Down-day realized vol")
    ax.set_xticks(x, [r[0] for r in m], rotation=60, fontsize=8)
    ax.axvspan(x[-1] - 0.5, x[-1] + 0.5, color=C["grid"], zorder=0)
    ax.set_ylabel("%", color=C["muted"])
    _titulo(ax, f"{nombre}: realized vol on up days vs down days (monthly)")
    _leyenda(ax, 2)
    return _png(fig)


def vol_strike(sym: str, filas: list) -> bytes:
    """Tabla en color: cambio semanal de IV a strike fijo por vencimiento y delta."""
    import numpy as np
    from report_calc import DELTAS
    cols = [et for et, _ in DELTAS]
    z = np.array([[(f["celdas"].get(c) or {}).get("cambio") for c in cols] for f in filas], dtype=float)
    lim = max(1.0, float(np.nanmax(np.abs(z)))) if np.isfinite(z).any() else 1.0
    cmap = LinearSegmentedColormap.from_list("d", [C["put"], C["surface"], C["neg"]])
    fig, ax = _fig(0.6 * len(filas) + 1.6)
    ax.grid(False)
    ax.imshow(np.nan_to_num(z), cmap=cmap, vmin=-lim, vmax=lim, aspect="auto")
    for i in range(z.shape[0]):
        for j in range(z.shape[1]):
            ax.text(j, i, "-" if not np.isfinite(z[i, j]) else f"{z[i, j]:+.2f}", ha="center", va="center",
                    color=C["text"], fontsize=10)
    ax.set_xticks(range(len(cols)), cols)
    ax.set_yticks(range(len(filas)), [f"{f['tenor']}  {f['vencimiento']}" for f in filas])
    _titulo(ax, f"{sym}: fixed-strike IV change vs last week (vol points)")
    return _png(fig)


def etf(d: dict) -> bytes:
    """Barras apiladas del rebalanceo estimado de cada dia, por indice (miles de millones)."""
    dias = d["dias"]
    x = [f["fecha"][5:] for f in dias]
    subs = sorted({k for f in dias for k in f["por_indice"]})
    cols = [C["accent"], C["neg"], C["put"], C["amber"], C["pos"]]
    fig, ax = _fig()
    base_pos, base_neg = [0.0] * len(dias), [0.0] * len(dias)
    for i, s in enumerate(subs):
        v = [f["por_indice"].get(s, 0) / 1e9 for f in dias]
        base = [bp if a >= 0 else bn for a, bp, bn in zip(v, base_pos, base_neg)]
        ax.bar(x, v, bottom=base, color=cols[i % len(cols)], label=s, width=0.6)
        base_pos = [bp + max(a, 0) for a, bp in zip(v, base_pos)]
        base_neg = [bn + min(a, 0) for a, bn in zip(v, base_neg)]
    ax.axhline(0, color=C["axis"], linewidth=1)
    ax.set_ylabel("$bn", color=C["muted"])
    _titulo(ax, "Leveraged ETFs: estimated close rebalance by underlying")
    _leyenda(ax, len(subs))
    return _png(fig)
