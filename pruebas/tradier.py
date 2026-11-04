"""Prueba de la API de Tradier (solo datos de mercado): tiempo real o diferido, indices, cadenas y limites."""
import json, os, time, urllib.request
from datetime import datetime, timezone

TOK = os.environ.get("TRADIER_TOKEN", "").strip()
BASE = "https://api.tradier.com/v1"


def get(path):
    req = urllib.request.Request(BASE + path, headers={"Authorization": f"Bearer {TOK}", "Accept": "application/json"})
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            h = {k: v for k, v in r.headers.items() if k.lower().startswith("x-ratelimit")}
            return json.loads(r.read()), h, time.time() - t, r.status
    except urllib.error.HTTPError as e:
        return {"error": e.read().decode()[:300]}, {}, time.time() - t, e.code


print("token presente:", bool(TOK), "longitud", len(TOK))
now = datetime.now(timezone.utc)
print("ahora UTC", now.strftime("%Y-%m-%d %H:%M:%S"))
d, h, dt, st = get("/markets/quotes?symbols=SPX,SPY,NDX,RUT,VIX,AAPL&greeks=false")
print("quotes", st, f"{dt:.2f}s", h)
for q in ((d.get("quotes") or {}).get("quote") or []) if isinstance(d, dict) else []:
    td = q.get("trade_date")
    age = (now.timestamp() * 1000 - td) / 1000 if td else None
    print(f"  {q.get('symbol'):5s} last {q.get('last')} bid {q.get('bid')} ask {q.get('ask')} trade hace {age and round(age)} s  type {q.get('type')}")
if st != 200:
    print(d)
for sym in ("SPX", "NDX", "RUT", "SPY", "AAPL"):
    d, h, dt, st = get(f"/markets/options/expirations?symbol={sym}&includeAllRoots=true&strikes=false")
    exps = (((d or {}).get("expirations") or {}).get("date")) or []
    exps = exps if isinstance(exps, list) else [exps]
    print(f"\nexpirations {sym}: {st} {len(exps)} fechas, primeras {exps[:4]}, ultima {exps[-1] if exps else None}  {h}")
    if not exps:
        print(d); continue
    d, h, dt, st = get(f"/markets/options/chains?symbol={sym}&expiration={exps[0]}&greeks=true")
    opts = ((d or {}).get("options") or {}).get("option") or []
    roots = sorted({o.get("root_symbol") for o in opts})
    oi = sum(o.get("open_interest") or 0 for o in opts); vol = sum(o.get("volume") or 0 for o in opts)
    gk = sum(1 for o in opts if o.get("greeks") and o["greeks"].get("mid_iv"))
    print(f"  chain {exps[0]}: {st} {len(opts)} contratos en {dt:.2f}s, raices {roots}, OI {oi}, volumen {vol}, con IV {gk}  {h}")
    if opts:
        o = opts[len(opts) // 2]
        print("  campos:", sorted(o.keys()))
        print("  greeks:", o.get("greeks"))
        print("  ejemplo:", {k: o.get(k) for k in ("symbol", "strike", "option_type", "bid", "ask", "last", "volume", "open_interest", "trade_date", "bid_date", "expiration_type")})
