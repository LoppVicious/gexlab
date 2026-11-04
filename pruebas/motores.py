"""Compara los dos motores (gexbot y SpotGamma) con datos reales."""
import os, sys, time
sys.path.insert(0, os.getcwd())
import gex_engine as g
print("tipo libre de riesgo", g.rate_info())
for sym in ("SPX", "NDX", "SPY", "AAPL"):
    ch = g.parse_chain(g.fetch_chain(sym))
    dv = g.implied_dividends(ch, ch["spot"], g.quote_time(g.now_ny()), sym)
    print(f"\n{sym} spot {ch['spot']}: dividendo implicito ref {dv['ref']} en {dv['n']} vencimientos; muestra",
          {k[:10]: round(v, 4) for k, v in list(dv["by_exp"].items())[:12]})
    for dte in (0, 45):
        for model in ("gexbot", "spotgamma"):
            t = time.time()
            r = g.compute(sym, max_dte=dte, window_pct="auto", model=model)
            L = r["levels"]
            print(f"  dte {dte:>2} {model:9s} flip {L['flip']} (zero {L['zero_gamma'] and round(L['zero_gamma'], 1)}) call {L['call_wall']} put {L['put_wall']} vt {L['vt']} "
                  f"GEX 1% {r['totals']['net_per_pct'] / 1e9:.2f}B  {time.time() - t:.1f}s")
t = time.time()
h = g.heatmap("SPX", max_dte=0, window_pct=3.0, model="spotgamma")
print("\nmapa spotgamma", len(h["z"]), "x", len(h["z"][0]), "velas", len(h["candles"]), f"{time.time() - t:.1f}s")
