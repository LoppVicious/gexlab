"""Graficos PNG de la nota diaria de flujos (matplotlib, solo en Actions), con el estilo y la paleta del report
semanal (report_graficos.py). todos() devuelve {nombre: bytes PNG} y anota en cada bloque sus graficos."""
from __future__ import annotations

import matplotlib.pyplot as plt

from report_graficos import ANCHO, DPI, C, _fig, _leyenda, _png, _titulo


def _b(x):
    return x / 1e9


def asimetria(F: str, a: dict) -> bytes:
    """Flujos mecanicos estimados si el mercado cae o sube un 5 % en una sesion, por fuente."""
    fuentes = list(dict.fromkeys(list(a["-5"]["fuentes"]) + list(a["5"]["fuentes"])))
    y = range(len(fuentes))
    fig, ax = _fig(0.6 * len(fuentes) + 2.2)
    baja = [_b(a["-5"]["fuentes"].get(f, 0)) for f in fuentes]
    sube = [_b(a["5"]["fuentes"].get(f, 0)) for f in fuentes]
    ax.barh([i + 0.2 for i in y], baja, height=0.38, color=C["neg"], label=f"Market -5%: {_b(a['-5']['total']):+.1f}B")
    ax.barh([i - 0.2 for i in y], sube, height=0.38, color=C["pos"], label=f"Market +5%: {_b(a['5']['total']):+.1f}B")
    ax.set_yticks(list(y), fuentes, color=C["text"])
    ax.invert_yaxis()
    ax.axvline(0, color=C["axis"], linewidth=1)
    ax.set_xlabel("$B bought (+) or sold (-), estimate", color=C["muted"])
    _titulo(ax, f"Mechanical flows on a 5% move ({F})")
    _leyenda(ax, 2)
    return _png(fig)


def dealers(F: str, comp: dict) -> bytes:
    """Cobertura de los dealers segun el movimiento del indice (IV de estres), por complejo."""
    fig, ax = _fig()
    cols = [C["accent"], C["amber"], C["put"]]
    for (n, c), col in zip(comp.items(), cols):
        xs = sorted(int(k) for k in c["estres"])
        ax.plot(xs, [_b(c["estres"][str(x)]) for x in xs], color=col, linewidth=2.2, marker="o",
                label=f"{n} ({'+'.join(c['simbolos'])})")
    ax.axhline(0, color=C["axis"], linewidth=1)
    ax.axvline(0, color=C["axis"], linewidth=1)
    ax.set_xlabel("Index move in one session (%), IV +5 pts on selloffs, -2 pts on rallies", color=C["muted"])
    ax.set_ylabel("$B dealers buy (+) / sell (-)", color=C["muted"])
    _titulo(ax, f"Dealer hedging by scenario ({F})")
    _leyenda(ax, 3)
    return _png(fig)


def strikes(F: str, s: dict) -> bytes:
    """Strikes del SPX con mas puts cerca del precio, su vencimiento principal y la recompra de los dealers si el
    indice cerrara alli."""
    filas = s["strikes"]
    fig, ax = _fig()
    x = [f"{f['strike']:,.0f}" for f in filas]
    cols = [C["put"] if f["dist_pct"] > 0 else C["muted"] for f in filas]
    ax.bar(x, [f["oi"] / 1000 for f in filas], color=cols)
    for i, f in enumerate(filas):
        ax.annotate(f"{f['vencimiento'][5:]} ({f['vencimiento_pct']:.0f}%)\n{_b(f['flujo_si_cierra_aqui']):+.1f}B",
                    (i, f["oi"] / 1000), ha="center", va="bottom", fontsize=9, color=C["text"],
                    xytext=(0, 3), textcoords="offset points")
    ax.set_ylabel("Put open interest (thousands)", color=C["muted"])
    ax.set_xlabel(f"SPX strike (close {s['spot']:,.0f}); label: main expiry and dealer flow on that strike's puts if SPX closes there",
                  color=C["muted"])
    ax.margins(y=0.25)
    _titulo(ax, f"SPX put strikes near spot ({F})")
    return _png(fig)


def sistematicos(F: str, vc: dict, ct: dict) -> bytes:
    """Exposicion estimada de vol-control y posicion de CTA en el ultimo ano."""
    fig, ax = _fig()
    f1 = [f for f, _ in vc["historia"]]
    ax.plot(f1, [v for _, v in vc["historia"]], color=C["accent"], linewidth=2, label="Vol control exposure (x capital)")
    ax2 = ax.twinx()
    f2 = [f for f, _ in ct["historia"]]
    ax2.plot(f2, [v for _, v in ct["historia"]], color=C["amber"], linewidth=2, label="CTA trend position (-1 to 1)")
    ax2.axhline(0, color=C["amber"], linewidth=0.8, linestyle=":")
    ax2.set_ylim(-1.05, 1.05)
    ax2.tick_params(colors=C["muted"], labelsize=10)
    for sp in ax2.spines.values():
        sp.set_color(C["axis"])
    paso = max(1, len(f1) // 8)
    ax.set_xticks(range(0, len(f1), paso), [f[2:7] for f in f1[::paso]])
    l1, e1 = ax.get_legend_handles_labels()
    l2, e2 = ax2.get_legend_handles_labels()
    ax.legend(l1 + l2, e1 + e2, frameon=False, labelcolor=C["muted"], ncol=2, loc="lower left",
              bbox_to_anchor=(0, 1), fontsize=10, borderaxespad=0.2)
    _titulo(ax, f"Systematic positioning, estimates ({F})")
    return _png(fig)


def letf(F: str, et: dict) -> bytes:
    """Tabla de rebalanceo de los ETFs apalancados por categoria: hoy en miles de millones y percentil con signo."""
    cats = et["categorias"]
    fig, ax = plt.subplots(figsize=(ANCHO, 2.1), dpi=DPI)
    fig.patch.set_facecolor(C["surface"])
    ax.axis("off")
    filas = [[f"{c['hoy'] / 1e9:+.1f}" for c in cats], [f"{c['pct']:.1f}%" if c["pct"] is not None else "n/a" for c in cats]]
    t = ax.table(cellText=filas, rowLabels=["Today ($B)", "Percentile"], colLabels=[c["categoria"] for c in cats],
                 cellLoc="center", rowLoc="center", loc="center")
    t.auto_set_font_size(False)
    t.set_fontsize(11)
    t.scale(1, 1.8)
    for (r, k), cel in t.get_celld().items():
        cel.set_edgecolor(C["axis"])
        cel.set_facecolor(C["surface"])
        cel.get_text().set_color(C["text"])
        if r == 0 or k == -1:
            cel.get_text().set_fontweight("bold")
            cel.set_facecolor(C["grid"])
        elif k >= 0 and cats[k]["pct"] is not None and (cats[k]["pct"] <= 10 or cats[k]["pct"] >= 90):
            cel.set_facecolor("#fff1c2")
            cel.get_text().set_fontweight("bold")
    tot = et["total"] / 1e9
    pct = f", percentile {et['pct']:.1f}%" if et.get("pct") is not None else ""
    ax.set_title(f"Leveraged ETF rebalance at the close ({F}): {tot:+.1f}B{pct}", loc="left", color=C["text"],
                 fontsize=14, fontweight="bold")
    fig.text(0.01, 0.02, f"Each extra 1% move adds {et['por_1pct'] / 1e9:.1f}B. Percentile vs 252 sessions, signed "
             "(low = heavy selling). Estimate from issuer AUM.", color=C["muted"], fontsize=9)
    return _png(fig)


def todos(paq: dict, _res_spx=None) -> dict:
    F, b, out = paq["fecha"], paq["bloques"], {}
    ok = lambda k: b.get(k) if (b.get(k) or {}).get("estado") == "ok" else None   # noqa: E731
    trabajos = []
    if ok("letf") and b["letf"].get("categorias"):
        trabajos.append((["letf"], "letf", lambda: letf(F, b["letf"])))
    if ok("asimetria"):
        trabajos.append((["asimetria"], "asimetria", lambda: asimetria(F, b["asimetria"])))
    if ok("dealers") and b["dealers"]["complejos"]:
        trabajos.append((["dealers"], "dealers", lambda: dealers(F, b["dealers"]["complejos"])))
    if ok("strikes") and b["strikes"]["strikes"]:
        trabajos.append((["strikes"], "strikes_puts", lambda: strikes(F, b["strikes"])))
    if ok("vol_control") and ok("cta"):
        trabajos.append((["vol_control", "cta"], "sistematicos", lambda: sistematicos(F, b["vol_control"], b["cta"])))
    for bloques, nombre, fn in trabajos:
        try:
            out[nombre] = fn()
            for k in bloques:
                b[k].setdefault("graficos", []).append(nombre)
        except Exception as e:  # noqa: BLE001
            print(f"grafico {nombre}: {type(e).__name__}: {str(e)[:200]}", flush=True)
        finally:
            plt.close("all")
    return out
