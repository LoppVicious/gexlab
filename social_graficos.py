"""Graficos PNG del social diario para X (matplotlib, solo en Actions): 1600 x 900 px, tema oscuro Bento.
Los colores son los de THEMES.dark en web/app.js (si cambian alli, cambiarlos aqui). Cada funcion devuelve bytes PNG."""
from __future__ import annotations

import io
from datetime import datetime

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.ticker import FuncFormatter  # noqa: E402

# THEMES.dark de web/app.js (+ vt de THEME_EXTRA)
C = {"ink": "#000000", "surface": "#121214", "grid": "#1f1f23", "axis": "#2e2e34", "text": "#fafafa", "muted": "#a1a1aa",
     "faint": "#71717a", "neg": "#ff2f7c", "pos": "#9461ff", "put": "#22c58b", "call": "#ff5a5f", "amber": "#f2b632",
     "accent": "#34d3b0", "vt": "#ff8a3d", "spot": "#d4d4d8"}
W, H, DPI = 16, 9, 100
MARCA = "GEX Lab"


def _fecha(iso: str) -> str:
    d = datetime.strptime(iso, "%Y-%m-%d")
    return f"{d:%a} {d:%b} {d.day}, {d.year}"


def _ordinal(v) -> str:
    n = int(round(v))
    suf = "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suf}"


def _n(v, d=0) -> str:
    return "-" if v is None else f"{v:,.{d}f}"


def _pct(v, d=2) -> str:
    return "-" if v is None else f"{v:+.{d}f}%"


def _fig():
    fig = plt.figure(figsize=(W, H), dpi=DPI)
    fig.patch.set_facecolor(C["ink"])
    return fig


def _ejes(fig, rect=(0.06, 0.12, 0.9, 0.66)):
    ax = fig.add_axes(rect)
    ax.set_facecolor(C["surface"])
    for s in ax.spines.values():
        s.set_color(C["axis"])
    ax.tick_params(colors=C["muted"], labelsize=13)
    ax.grid(True, color=C["grid"], linewidth=1)
    ax.set_axisbelow(True)
    return ax


def _cabecera(fig, titulo, sub):
    fig.text(0.06, 0.93, titulo, color=C["text"], fontsize=30, fontweight="bold", va="top")
    fig.text(0.06, 0.865, sub, color=C["muted"], fontsize=17, va="top")
    fig.text(0.96, 0.035, MARCA, color=C["accent"], fontsize=16, fontweight="bold", ha="right", va="bottom")


def _png(fig) -> bytes:
    b = io.BytesIO()
    fig.savefig(b, format="png", facecolor=fig.get_facecolor())
    plt.close(fig)
    return b.getvalue()


def tabla_indices(F: str, sig: str, ok: dict) -> bytes:
    """Niveles de los indices para la proxima sesion: una fila por indice."""
    fig = _fig()
    _cabecera(fig, f"Index gamma levels for {_fecha(sig)}", f"Options positioning at the {_fecha(F)} close")
    cols = [("Index", 0.06), ("Close", 0.2), ("Day", 0.31), ("vs implied", 0.41), ("Gamma", 0.52),
            ("Call Wall", 0.63), ("Put Wall", 0.73), ("Flip", 0.83), ("Next-day 1σ", 0.925)]
    y0 = 0.72
    for t, x in cols:
        fig.text(x, y0, t, color=C["faint"], fontsize=15, ha="left" if t == "Index" else "center", va="center")
    fig.add_artist(plt.Line2D([0.05, 0.97], [y0 - 0.04, y0 - 0.04], color=C["axis"], linewidth=1.5, transform=fig.transFigure))
    paso = 0.17
    for i, (sym, b) in enumerate(ok.items()):
        y = y0 - 0.13 - i * paso
        N, d = b["niveles"], b["siguiente"]
        pos = b["regimen"] == "positive"
        celdas = [
            (sym, C["text"], 26, "bold"),
            (_n(b["cierre"], 2), C["text"], 21, "normal"),
            (_pct(b["cambio_pct"]), C["put"] if (b["cambio_pct"] or 0) >= 0 else C["neg"], 21, "bold"),
            ("-" if b["cambio_vs_esperado"] is None else f"{b['cambio_vs_esperado']:.1f}x", C["text"], 21, "normal"),
            ("Positive" if pos else "Negative", C["pos"] if pos else C["neg"], 21, "bold"),
            (_n(N["call_wall"]), C["call"], 21, "normal"),
            (_n(N["put_wall"]), C["put"], 21, "normal"),
            (_n(N["flip"]), C["amber"], 21, "normal"),
            (f"±{d['pct']:.2f}%" if d.get("pct") else "-", C["text"], 21, "normal"),
        ]
        for (t, x), (txt, col, fs, fw) in zip(cols, celdas):
            fig.text(x, y, txt, color=col, fontsize=fs, fontweight=fw, ha="left" if t == "Index" else "center", va="center")
        if d.get("lo") and d.get("hi"):
            fig.text(0.925, y - 0.045, f"{_n(d['lo'])} - {_n(d['hi'])}", color=C["muted"], fontsize=14, ha="center", va="center")
    fig.text(0.06, 0.035, "vs implied: today's move divided by the 1σ move options priced for today. Flip: where net dealer gamma changes sign.",
             color=C["faint"], fontsize=13, va="bottom")
    return _png(fig)


def perfil(sym: str, res: dict, b: dict, sig: str) -> bytes:
    """Gamma neta por strike alrededor del cierre, con los niveles y el rango de 1 sigma de la proxima sesion."""
    spot = res["spot"]
    sem = (b.get("semana") or {}).get("pct") or 3.0
    ancho = max(1.4 * sem, 2.0) / 100 * spot
    pares = [(k, v) for k, v in zip(res["strikes"], res["net"]) if abs(k - spot) <= ancho]
    if len(pares) < 5:
        raise ValueError("Pocos strikes en la ventana")
    ks, vs = zip(*pares)
    paso = min(abs(ks[i + 1] - ks[i]) for i in range(len(ks) - 1) if ks[i + 1] != ks[i])
    fig = _fig()
    pos = b["regimen"] == "positive"
    _cabecera(fig, f"{sym} gamma by strike into {_fecha(sig)}",
              f"Close {_n(b['cierre'], 2)} ({_pct(b['cambio_pct'])}). Net dealer gamma {'positive' if pos else 'negative'}.")
    ax = _ejes(fig)
    ax.bar(ks, vs, width=paso * 0.8, color=[C["pos"] if v >= 0 else C["neg"] for v in vs], alpha=0.9)
    ax.axhline(0, color=C["axis"], linewidth=1.2)
    d = b["siguiente"]
    if d.get("lo") and d.get("hi"):
        ax.axvspan(d["lo"], d["hi"], color=C["text"], alpha=0.06, label=f"Next-day 1σ ±{d['pct']:.2f}%")
    N = b["niveles"]
    for k, nombre, col, est in (("call_wall", "Call Wall", C["call"], "-"), ("put_wall", "Put Wall", C["put"], "-"),
                                ("flip", "Flip", C["amber"], "--"), ("vt", "Vol Trigger", C["vt"], ":")):
        v = N.get(k)
        if v is not None and abs(v - spot) <= ancho:
            ax.axvline(v, color=col, linewidth=2.2, linestyle=est, label=f"{nombre} {_n(v)}")
    ax.axvline(spot, color=C["spot"], linewidth=2.2, label=f"Close {_n(spot)}")
    ax.set_xlim(spot - ancho, spot + ancho)
    ax.set_yticklabels([])
    ax.tick_params(axis="y", length=0)
    ax.legend(frameon=False, labelcolor=C["muted"], fontsize=14, ncol=6, loc="lower left", bbox_to_anchor=(0, 1.0))
    ax.xaxis.set_major_formatter(FuncFormatter(lambda x, _: f"{x:,.0f}"))
    return _png(fig)


def acciones(F: str, top: list) -> bytes:
    """Mayores movimientos del dia en sigmas (cambio / movimiento diario implicito por la IV ATM de ayer)."""
    filas = [x for x in top if x.get("z") is not None][:8][::-1]
    if not filas:
        raise ValueError("Sin filas")
    fig = _fig()
    _cabecera(fig, "Biggest moves vs what options priced", f"{_fecha(F)}. Day change in standard deviations of the implied daily move.")
    ax = _ejes(fig, (0.2, 0.1, 0.72, 0.7))
    zs = [x["z"] for x in filas]
    ax.barh(range(len(filas)), zs, color=[C["put"] if z >= 0 else C["neg"] for z in zs], height=0.62)
    ax.set_yticks(range(len(filas)))
    ax.set_yticklabels([f"{x['sym']}  {_pct(x['cambio_pct'], 1)}" for x in filas], fontsize=18, color=C["text"])
    ax.axvline(0, color=C["axis"], linewidth=1.2)
    lim = max(abs(z) for z in zs) * 1.18
    ax.set_xlim(-lim if min(zs) < 0 else 0, lim if max(zs) > 0 else 0.5)
    for i, z in enumerate(zs):
        ax.text(z + (lim * 0.015 if z >= 0 else -lim * 0.015), i, f"{z:+.1f}σ", va="center", ha="left" if z >= 0 else "right",
                color=C["text"], fontsize=16, fontweight="bold")
    ax.grid(axis="y", visible=False)
    return _png(fig)


def vix(F: str, v: dict) -> bytes:
    """Curva de los indices de volatilidad (VIX9D a VIX1Y): hoy frente a la sesion anterior."""
    nombres = ["VIX9D", "VIX", "VIX3M", "VIX6M", "VIX1Y"]
    hoy = [v["curva"].get(s) for s in nombres]
    ayer = [(v.get("curva_previa") or {}).get(s) for s in nombres]
    if sum(x is not None for x in hoy) < 3:
        raise ValueError("Curva incompleta")
    fig = _fig()
    _cabecera(fig, f"VIX {_n(v['cierre'], 2)} ({_pct(v['cambio_pct'], 1)})",
              f"{_fecha(F)}. Volatility index term structure"
              + (f", VIX at the {_ordinal(v['percentil_1a'])} percentile of the past year." if v.get("percentil_1a") is not None else "."))
    ax = _ejes(fig)
    xs = range(len(nombres))
    if any(x is not None for x in ayer):
        ax.plot(xs, ayer, color=C["faint"], linewidth=2.5, marker="o", markersize=9, label="Previous session")
    ax.plot(xs, hoy, color=C["accent"], linewidth=3.5, marker="o", markersize=12, label="Today")
    for i, y in enumerate(hoy):
        if y is not None:
            ax.annotate(f"{y:.2f}", (i, y), textcoords="offset points", xytext=(0, 14), ha="center", color=C["text"], fontsize=16)
    vals = [x for x in hoy + ayer if x is not None]
    marg = (max(vals) - min(vals)) * 0.15 or 1
    ax.set_ylim(min(vals) - marg, max(vals) + marg)
    ax.set_xticks(list(xs))
    ax.set_xticklabels(nombres, fontsize=16, color=C["text"])
    ax.legend(frameon=False, labelcolor=C["muted"], fontsize=15, loc="lower left", bbox_to_anchor=(0, 1.0), ncol=2)
    return _png(fig)
