"""Cotizacion, cierre previo e historico diario de Tradier para los indices (y sus ETF), para revisar el cambio diario."""
import json
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import fuente_tradier as ft

q = ft._lista(((ft._get("/markets/quotes?symbols=SPX,NDX,RUT,SPY,QQQ,IWM&greeks=false") or {}).get("quotes") or {}).get("quote"))
for x in q:
    print(json.dumps({k: x.get(k) for k in ("symbol", "type", "last", "close", "prevclose", "change", "change_percentage",
                                             "trade_date", "open", "high", "low")}))
    try:
        print("  historico:", ft.historico(x["symbol"], "2026-11-15")["data"][-4:])
    except Exception as e:  # noqa: BLE001
        print("  historico:", type(e).__name__, e)

# precio del motor (paridad put-call o cierre oficial) y velas escaladas de NDX y RUT
import gex_engine as g
for sym, etf in (("NDX", "QQQ"), ("RUT", "IWM"), ("SPX", None)):
    ch = g.parse_chain(g.fetch_chain(sym, force=True))
    print(sym, "spot", round(ch["spot"], 2), "prev", round(ch["prev_close"], 2), "chg", ch["chg_pct"], "source", ch.get("source"))
    print("  paridad en la cadena:", bool(g.fetch_chain(sym)["data"].get("spot_paridad")),
          " paridad calculada:", g._spot_paridad(sym, ch["spot"], ch["K"], ch["call"], ch["exp"], ch["bid"], ch["ask"]))
    if etf:
        v = ft.velas_indice(sym, etf, ch["spot"])["data"]
        dias = sorted({b["datetime"][:10] for b in v})
        for d in dias[-3:]:
            u = [b for b in v if b["datetime"].startswith(d)]
            print("  velas", d, len(u), "primera", u[0]["price"]["open"], "ultima", u[-1]["price"]["close"])
