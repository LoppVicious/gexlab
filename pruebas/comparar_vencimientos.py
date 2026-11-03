"""Niveles de SPX vencimiento a vencimiento (como la tabla de gexbot) con OI, volumen y OI+volumen,
para varias ventanas de strikes alrededor del spot."""
import os, sys
sys.path.insert(0, os.getcwd())
import numpy as np
import gex_engine as g

ch = g.parse_chain(g.fetch_chain("SPX"))
spot = ch["spot"]
now = g.now_ny().replace(second=0, microsecond=0)
q = g.quote_time(now)
print(f"spot {spot:.2f}  quote {q}  ahora {now}")
m = (ch["exp"] > np.datetime64(q)) & (ch["iv"] > 0.01)
K, C, OI, VOL, IV, E = (ch[x][m] for x in ("K", "call", "oi", "vol", "iv", "exp"))
W, T = g.variance_to_expiry(IV, E, q, q)
gam = g.gamma_w(spot, K, W, T) * 100.0 * spot * spot * 0.01
sign = np.where(C, 1.0, -1.0)


def niveles(k, v):
    pos, neg = np.maximum(v, 0), np.maximum(-v, 0)
    if (v > 0).any() and (v < 0).any():
        cost = np.cumsum(pos)[:-1] + np.cumsum(neg[::-1])[::-1][1:]
        mids = (k[:-1] + k[1:]) / 2
        b = np.where(cost <= cost.min() + 1e-6)[0]
        flip = float(mids[b[np.argmin(np.abs(mids[b] - spot))]])
    else:
        flip = None
    return flip, float(k[np.argmax(v)]), float(k[np.argmin(v)]), float(k[np.argmax(np.abs(v))])


exps = sorted(set(E.tolist()))[:22]
for ex in exps:
    ex = np.datetime64(ex)
    s = E == ex
    ks = np.unique(K[s])
    iv_atm = float(np.interp(spot, ks, [IV[s & (K == k)].mean() for k in ks]))
    em = spot * iv_atm * np.sqrt(max(float(T[s][0]), 1 / 365 / 24))
    out = []
    for lab, pos in (("oi", OI), ("vol", VOL), ("both", OI + VOL)):
        v = np.array([(gam[s & (K == k)] * sign[s & (K == k)] * pos[s & (K == k)]).sum() for k in ks])
        for wl, w in (("1.5%", 0.015), ("3%", 0.03), ("5%", 0.05), ("2em", 2 * em / spot)):
            sel = np.abs(ks / spot - 1) <= w
            if sel.sum() < 3:
                continue
            f, cw, pw, mj = niveles(ks[sel], v[sel])
            out.append(f"{lab:4s} {wl:4s} flip {f if f is None else round(f, 1)!s:>7} gamma {mj:>6.0f} call {cw:>6.0f} put {pw:>6.0f}")
    print(f"\n{str(ex)[:16]}  (1σ {em/spot*100:.2f}%)")
    print("\n".join("   " + o for o in out))
