"""Prueba (prueba_tradier.yml con script=premarket_mapa.py): tramo previo a la apertura del TRACE. Para SPX, NDX, RUT
y SPY: velas del ETF escaladas (fuente_tradier.velas_pre), salto entre la ultima vela previa y la primera del indice,
ratio de hoy frente al de ayer, y el mapa (gex_engine.heatmap) con esas velas. Lo repite simulando las 08:42 ET.
Solo escribe horas, recuentos y precios de mercado."""
import os
import sys
import time
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import fuente_tradier as ft  # noqa: E402
import gex_engine as g  # noqa: E402

VELAS_TRADIER = {"SPX", "SPY", "QQQ", "IWM"}
real_now = g.now_ny


def prueba(etiqueta: str) -> None:
    print(f"\n=== {etiqueta}: ahora NY {g.now_ny():%Y-%m-%d %H:%M}")
    for sym in ("SPX", "NDX", "RUT", "SPY"):
        etf = g.PRE_PROXY[sym]
        try:
            intr = ft.velas(sym) if sym in VELAS_TRADIER else g.fetch_aux("intraday", sym, ttl=0)
            dia = g.now_ny().strftime("%Y-%m-%d")
            # simulacion: solo las velas del indice anteriores a la hora simulada
            lim = g.now_ny().strftime("%Y-%m-%d %H:%M")
            idx = [b for b in (intr or {}).get("data", []) if str(b["datetime"])[:16].replace("T", " ") <= lim]
            pre = ft.velas_pre(sym, etf, idx)
            hoy = [b for b in idx if str(b["datetime"]).startswith(dia)]
            print(f" {sym} ({etf}): {len(pre)} velas previas"
                  + (f" {pre[0]['datetime'][11:16]}-{pre[-1]['datetime'][11:16]}, ultima close {pre[-1]['price']['close']}" if pre else ""))
            if pre and hoy:
                p1 = hoy[0]["price"]
                print(f"   primera del indice {hoy[0]['datetime'][11:16]} open {p1.get('open')} | salto "
                      f"{float(p1.get('open') or p1['close']) - pre[-1]['price']['close']:+.2f}")
            datos = {**(intr or {}), "data": pre + idx, "pre_src": etf if pre else None}
            g._aux_cache[f"intraday:{sym}"] = (time.time() + 3600, datos)
            g._heat_cache.clear()
            hm = g.heatmap(sym, max_dte=0, which="auto", model="spotgamma")
            npre = sum(1 for c in hm["candles"] if c[0] < "09:30")
            print(f"   mapa: {hm['times'][0]}-{hm['times'][-1]} ({len(hm['times'])} columnas), velas {len(hm['candles'])}"
                  f" ({npre} previas), live={hm['live']} pre={hm['pre']} pre_src={hm['pre_src']} kind={hm['kind']}"
                  f" barras a las {(hm['strike_bars'] or {}).get('time')}")
        except Exception as e:  # noqa: BLE001
            import traceback
            traceback.print_exc()
            print(f" {sym}: ERROR {type(e).__name__}: {e}")


prueba("hora real")
base = real_now()
g.now_ny = lambda: base.replace(hour=8, minute=42, second=0, microsecond=0)  # noqa: E731
g._aux_cache.clear()
prueba("simulado 08:42")
print(f"\npeticiones: {ft.peticiones[0]}")
