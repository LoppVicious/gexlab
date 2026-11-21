"""Coste en Tradier del historial diario (historial500.py): peticiones y segundos por ticker con la cadena completa,
sesión de la cadena (session_date), volumen de la acción (O/S) y lectura de skew. Con una muestra de la lista
inicial (TICKERS) más índices y VIX; extrapola a 529 tickers. Se lanza con prueba_tradier.yml."""
import os
import sys
import time

sys.path.insert(0, os.getcwd())
import gex_engine as g  # noqa: E402
import fuente_tradier as ft  # noqa: E402
import historial500 as h  # noqa: E402
import skew  # noqa: E402

lista = [s for s in h.TICKERS.split() if s.isalpha()] if isinstance(h.TICKERS, str) else list(h.TICKERS)
muestra = ["SPX", "SPY", "VIX", "QQQ"] + lista[::max(1, len(lista) // 24)][:24]
print(f"lista inicial: {len(lista)} tickers; muestra: {len(muestra)}; sesion objetivo con --forzar: {h.sesion_objetivo(True)}")
tot_p, tot_s, n = 0, 0.0, 0
for sym in muestra:
    p0, t0 = ft.peticiones[0], time.time()
    try:
        raw = ft.cadena(sym)
        ch = g.parse_chain(raw)
        dp, dt = ft.peticiones[0] - p0, time.time() - t0
        tot_p, tot_s, n = tot_p + dp, tot_s + dt, n + 1
        pt = skew.punto(ch, float(ch["spot"]), g.now_ny())
        print(f"{sym:6s} {dp:4d} pet. {dt:5.1f} s  sesion {g.session_date(ch['timestamp'])}  ts {raw['timestamp']}  "
              f"contratos {len(ch['K'])}  vol. accion {raw['data'].get('volume')}  skew {pt}")
    except Exception as e:  # noqa: BLE001
        print(f"{sym:6s} ERROR {type(e).__name__}: {str(e)[:120]}")
if n:
    print(f"media: {tot_p / n:.1f} peticiones y {tot_s / n:.1f} s por ticker; 529 tickers: ~{tot_p / n * 529:.0f} peticiones,"
          f" ~{(tot_s / n + h.PAUSA) * 529 / 60:.0f} min")
print(f"cupo al final: {ft._cupo}")
