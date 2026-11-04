"""Diagnostico de las velas intradia de CBOE y de las del mapa."""
import os, sys
sys.path.insert(0, os.getcwd())
import gex_engine as g
now = g.now_ny()
print("ahora NY", now, "abierto", g.market_open(now))
for sym in ("SPX", "SPY"):
    raw = g.fetch_aux("intraday", sym, ttl=0)
    d = (raw or {}).get("data", [])
    print(sym, "barras", len(d), "primera", d[:1], "ultima", d[-1:])
for which in ("auto", "last", "next"):
    sess, kind = g.map_session(now, which)
    print(which, "->", sess, kind)
    h = g.heatmap("SPX", max_dte=0, window_pct=3.0, which=which)
    print("   velas", len(h["candles"]), h["candles"][:2], "session", h["session"], "live", h["live"])
