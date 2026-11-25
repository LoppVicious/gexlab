"""Cotizacion, cierre previo e historico diario de Tradier para los indices (y sus ETF), para revisar el cambio diario."""
import json
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from datetime import datetime, timezone

import fuente_tradier as ft

q = ft._lista(((ft._get("/markets/quotes?symbols=SPX,NDX,RUT,SPY,QQQ,IWM&greeks=false") or {}).get("quotes") or {}).get("quote"))
for x in q:
    print(json.dumps({k: x.get(k) for k in ("symbol", "type", "last", "close", "prevclose", "change", "change_percentage",
                                             "trade_date", "open", "high", "low")}))
    td = x.get("trade_date") or 0
    ts = datetime.fromtimestamp(td / 1000, tz=timezone.utc) if td else datetime.now(timezone.utc)
    try:
        print("  historico:", ft.historico(x["symbol"], "2026-11-15")["data"][-4:])
    except Exception as e:  # noqa: BLE001
        print("  historico:", type(e).__name__, e)
    print("  _cierre_previo:", ft._cierre_previo(x["symbol"], x, ts), "ts", ts)
