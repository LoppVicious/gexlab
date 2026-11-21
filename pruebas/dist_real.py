"""Distribucion implicita con datos reales (comparar.yml): forma, control de calidad y coherencia con el 1 sigma."""
import math
import os
import sys

sys.path.insert(0, os.getcwd())
import gex_engine as g  # noqa: E402
import volatilidad  # noqa: E402

now = g.now_ny()
print("ahora", now)
for sym in ("SPX", "QQQ", "NVDA", "VIX"):
    ch = g.parse_chain(g.fetch_chain(sym))
    spot = ch["spot"]
    for dist in g.level_dists(ch, spot, now, sym):
        s = dist["atm_iv"] * math.sqrt(dist["T"])
        lo, hi = dist["fwd"] * math.exp(-s), dist["fwd"] * math.exp(s)
        fuera = g.prob_beyond(dist, hi, "up") + g.prob_beyond(dist, lo, "down")
        print(f"{sym} {dist['exp']} F {dist['fwd']:.2f} q50 {dist['q']['50']:.2f} ({(dist['q']['50'] / dist['fwd'] - 1) * 100:+.2f}%) "
              f"q5 {dist['q']['5']:.2f} q95 {dist['q']['95']:.2f} clip {dist['clip']:.4f} fuera de 1s {fuera:.3f}")
    r = g.compute(sym, max_dte=7 if sym == "NVDA" else 0, window_pct="auto")
    L = r["levels"]
    print(f"  spot {r['spot']:.2f} call {L['call_wall']} put {L['put_wall']} flip {L['flip']}")
    print("  level_probs", r["level_probs"])
    print("  snap", {k: v for k, v in g._snap(r).items() if k.startswith("pc_")})
v = volatilidad.vol_data("SPX", save=False)
print("vol SPX dists", len(v["dists"]), [d["exp"] for d in v["dists"]][:5], "max clip", max(d["clip"] for d in v["dists"]))
