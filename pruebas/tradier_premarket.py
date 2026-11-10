"""Prueba (GitHub Actions, prueba_tradier.yml con script=tradier_premarket.py): que da Tradier fuera de la sesion
regular. 1) velas de 1 min de SPY/SPX con session_filter=all antes de las 09:30; 2) operaciones de la sesion nocturna
(GTH) de opciones SPXW cerca del dinero; 3) si existe algun simbolo de futuros. Solo escribe recuentos, horas y
precios de mercado, ningun dato de la cuenta."""
import os
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import fuente_tradier as ft  # noqa: E402

NY = ZoneInfo("America/New_York")
hoy = datetime.now(NY)
ayer = hoy - timedelta(days=1 if hoy.weekday() != 0 else 3)
print(f"ahora NY: {hoy:%Y-%m-%d %H:%M}")


def barras(sym: str, ini: str, fin: str, intervalo: str = "1min") -> list[dict]:
    d = ft._get(f"/markets/timesales?symbol={sym}&interval={intervalo}&start={ini.replace(' ', '%20')}"
                f"&end={fin.replace(' ', '%20')}&session_filter=all")
    return ft._lista(((d or {}).get("series") or {}).get("data"))


def resumen(nombre: str, v: list[dict]) -> None:
    if not v:
        print(f"  {nombre}: 0 barras")
        return
    pre = [b for b in v if b["time"][11:16] < "09:30" or b["time"][:10] < hoy.strftime("%Y-%m-%d")]
    print(f"  {nombre}: {len(v)} barras {v[0]['time']} -> {v[-1]['time']}; antes de 09:30 de hoy: {len(pre)}")
    if pre:
        print(f"    primera {pre[0]['time']} close {pre[0].get('close')} vol {pre[0].get('volume')} | "
              f"ultima pre {pre[-1]['time']} close {pre[-1].get('close')} vol {pre[-1].get('volume')}")
        horas = sorted({b["time"][:13] for b in pre})
        print(f"    horas con barras: {', '.join(h[5:] for h in horas)}")


# 1) subyacentes: ayer 16:00 -> hoy 09:40
ini = f"{ayer:%Y-%m-%d} 16:00"
fin = f"{hoy:%Y-%m-%d} 09:40"
print("\n1) Subyacentes, session_filter=all")
for s in ["SPY", "SPX", "QQQ", "NDX"]:
    try:
        resumen(s, barras(s, ini, fin))
    except Exception as e:  # noqa: BLE001
        print(f"  {s}: ERROR {type(e).__name__}: {e}")

# 2) opciones SPXW 0DTE cerca del dinero: GTH va de 20:15 (dia anterior) a 09:25
print("\n2) Opciones SPXW (sesion nocturna GTH 20:15-09:25)")
try:
    q = ft._lista(ft._get("/markets/quotes?symbols=SPX")["quotes"]["quote"])[0]
    spot = float(q.get("last") or q.get("prevclose"))
    exps = ft._vencimientos("SPX")
    for exp in exps[:2]:
        ops = ft._opciones("SPX", exp)
        ops = [o for o in ops if o.get("option_type") in ("call", "put")]
        cerca = sorted(ops, key=lambda o: abs(float(o["strike"]) - spot))[:4]
        print(f" venc {exp} (spot {spot}):")
        for o in cerca:
            print(f"  {o['symbol']} vol hoy {o.get('volume')} OI {o.get('open_interest')} "
                  f"ultima op {o.get('trade_date')}")
            resumen(o["symbol"], barras(o["symbol"], f"{ayer:%Y-%m-%d} 16:00", fin))
except Exception as e:  # noqa: BLE001
    print(f"  ERROR {type(e).__name__}: {e}")

# 3) futuros
print("\n3) Futuros")
for s in ["/ES", "ES", "/ESZ26", "ESZ26", "@ES"]:
    try:
        d = ft._get(f"/markets/quotes?symbols={s.replace('/', '%2F')}")
        qq = ft._lista(((d or {}).get("quotes") or {}).get("quote"))
        um = ((d or {}).get("quotes") or {}).get("unmatched_symbols")
        print(f"  {s}: {'precio ' + str(qq[0].get('last')) if qq else 'sin cotizacion'} unmatched={um}")
    except Exception as e:  # noqa: BLE001
        print(f"  {s}: ERROR {type(e).__name__}: {e}")
print(f"\npeticiones: {ft.peticiones[0]}")
