"""Compara los niveles de GEX Lab con las definiciones que usa gexbot (cruce de signo por strike, muros sin
restriccion de lado) para SPX, con los datos de CBOE del momento."""
import os, sys
sys.path.insert(0, os.getcwd())
import numpy as np
import gex_engine as g

def gexbot_levels(strikes, net):
    k, v = np.array(strikes), np.array(net)
    cw = float(k[np.argmax(v)]) if (v > 0).any() else None
    pw = float(k[np.argmin(v)]) if (v < 0).any() else None
    major = float(k[np.argmax(np.abs(v))])
    # frontera de signo: el punto que deja la menor gamma "mal colocada" (positiva por debajo, negativa por encima)
    pos, neg = np.maximum(v, 0), np.maximum(-v, 0)
    best, bk = None, None
    for i in range(1, len(k)):
        cost = pos[:i].sum() + neg[i:].sum()
        if best is None or cost < best:
            best, bk = cost, (k[i - 1] + k[i]) / 2
    return {"flip": bk, "call_wall": cw, "put_wall": pw, "major": major}

for dte, w in ((0, 3.0), (0, "auto"), (98, 4.0), (98, 5.0)):
    r = g.compute("SPX", max_dte=dte, window_pct=w)
    L = r["levels"]
    per1 = np.array(r["net"]) * r["spot"] * 0.01
    print(f"\nSPX dte<={dte} spot {r['spot']:.2f} front {r['front_expiry']} contratos {r['meta']['contracts']} venc {r['meta']['expirations']}")
    print(f"  GEX Lab : flip {L["flip"]} (zero gamma {L["zero_gamma"]}) rango ±{L["window"]} call wall {L['call_wall']} put wall {L['put_wall']} VT {L['vt']}")
    gb = gexbot_levels(r["strikes"], r["net"])
    print(f"  estilo gexbot: flip {gb['flip']} call wall {gb['call_wall']} put wall {gb['put_wall']} major {gb['major']}")
    for k in (7475, 7500, 7510, 7520, 7550, 7560, 7565, 7570, 7580, 7590, 7600, 7625, 7640, 7650, 7700):
        if k in r["strikes"]:
            i = r["strikes"].index(k)
            print(f"    {k}: neta por 1% {per1[i]/1e6:9.1f}M   calls {r['calls'][i]*r['spot']*0.01/1e6:9.1f}M  puts {r['puts'][i]*r['spot']*0.01/1e6:9.1f}M")
