"""Prueba de la fuente Tradier del motor: cadena completa, tiempos, peticiones, niveles frente a CBOE
e historial que ofrece la API. Solo escribe recuentos, fechas, tiempos y niveles (los registros son publicos)."""
import os, sys, time
from datetime import datetime, timedelta, timezone
sys.path.insert(0, os.getcwd())
import numpy as np
import gex_engine as g
import fuente_tradier as ft

print("token presente:", ft.disponible(), "| ahora ET", g.now_ny().strftime("%Y-%m-%d %H:%M"))
for sym in ("SPX", "NDX", "SPY", "AAPL", "BRK.B"):
    t, n0 = time.time(), ft.peticiones[0]
    try:
        raw_t = ft.cadena(sym)
    except Exception as e:  # noqa: BLE001
        print(f"\n{sym}: ERROR Tradier {type(e).__name__}: {e}")
        continue
    dt, n = time.time() - t, ft.peticiones[0] - n0
    ch_t = g.parse_chain(raw_t)
    g.os.environ["GEX_FUENTE"] = "cboe"
    raw_c = g.fetch_chain(sym, force=True)
    g.os.environ.pop("GEX_FUENTE")
    ch_c = g.parse_chain(raw_c)
    roots = {}
    for o in raw_t["data"]["options"]:
        m = g.OCC_RE.match(o["option"])
        if m:
            roots.setdefault(m.group(1), set()).add(m.group(2))
    print(f"\n{sym}: Tradier {len(ch_t['K'])} contratos, {len(np.unique(ch_t['exp']))} vencimientos, {n} peticiones, {dt:.1f} s"
          f" | CBOE {len(ch_c['K'])} contratos, {len(np.unique(ch_c['exp']))} vencimientos")
    print(f"  spot Tradier {ch_t['spot']:.2f} ({raw_t['timestamp']} UTC) | CBOE {ch_c['spot']:.2f} ({raw_c.get('timestamp')} UTC)")
    print("  raices:", {k: len(v) for k, v in roots.items()}, "| con IV", int((ch_t['iv_raw'] > 0.01).sum()), "| OI total T/C",
          int(ch_t["oi"].sum()), int(ch_c["oi"].sum()))
    for fuente, raw in (("Tradier", raw_t), ("CBOE   ", raw_c)):
        g._cache[g.normalize(sym)] = (time.time(), raw)
        for model in g.MODELS:
            for dte in (0, 45):
                try:
                    r = g.compute(sym, max_dte=dte, window_pct=5.0, model=model)
                    L = r["levels"]
                    print(f"  {fuente} {model:9s} dte {dte:>2}: flip {L['flip']} call {L['call_wall']} put {L['put_wall']} vt {L['vt']}"
                          f" GEX1% {r['totals']['net_per_pct'] / 1e9:.2f}B fuente={r['source']}")
                except Exception as e:  # noqa: BLE001
                    print(f"  {fuente} {model} {dte}: {e}")

print("\n--- historial que ofrece Tradier ---")
hoy = g.now_ny().date()


def rango(path, key1, key2):
    try:
        d = ft._get(path)
        rows = ft._lista(((d or {}).get(key1) or {}).get(key2))
        if not rows:
            return "vacio"
        f = lambda r: r.get("date") or r.get("time")  # noqa: E731
        return f"{len(rows)} filas, de {f(rows[0])} a {f(rows[-1])}, campos {sorted(rows[0])}"
    except Exception as e:  # noqa: BLE001
        return f"ERROR {type(e).__name__}: {e}"


print("SPX diario desde 2000:", rango("/markets/history?symbol=SPX&interval=daily&start=2000-01-01", "history", "day"))
print("SPY 1 min, hace 30 dias:", rango(f"/markets/timesales?symbol=SPY&interval=1min&start={hoy - timedelta(days=30)} 09:30&end={hoy - timedelta(days=29)} 16:00&session_filter=open", "series", "data"))
print("SPY 1 min, hoy:", rango(f"/markets/timesales?symbol=SPY&interval=1min&start={hoy} 09:30&session_filter=open", "series", "data"))
# un contrato concreto de SPY que vence en ~1 mes y esta cerca del dinero
exps = ft._vencimientos("SPY")
e = next((x for x in exps if (datetime.strptime(x, "%Y-%m-%d").date() - hoy).days >= 25), exps[-1])
opts = ft._opciones("SPY", e)
q = ft._lista(((ft._get("/markets/quotes?symbols=SPY") or {}).get("quotes") or {}).get("quote"))[0]
o = min(opts, key=lambda o: abs(float(o["strike"]) - float(q["last"])) + (0 if o["option_type"] == "call" else 0.001))
print(f"opcion {o['symbol']} diario desde hace 1 ano:", rango(f"/markets/history?symbol={o['symbol']}&interval=daily&start={hoy - timedelta(days=365)}", "history", "day"))
print(f"opcion {o['symbol']} 1 min hoy:", rango(f"/markets/timesales?symbol={o['symbol']}&interval=1min&start={hoy} 09:30", "series", "data"))
print("peticiones totales:", ft.peticiones[0])
