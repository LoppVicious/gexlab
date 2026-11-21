"""Qué símbolo acepta Tradier para las acciones de clase (BRK.B, BF.B): cotización, vencimientos y contratos con cada
formato candidato, y la cadena completa con fuente_tradier.cadena. Se lanza con prueba_tradier.yml."""
import os
import sys

sys.path.insert(0, os.getcwd())
import fuente_tradier as ft  # noqa: E402

for base in ("BRK.B", "BF.B"):
    a, b = base.split(".")
    for s in (base, f"{a}/{b}", f"{a}{b}", f"{a}-{b}", f"{a} {b}"):
        q = s.replace("/", "%2F").replace(" ", "%20")
        try:
            cot = ft._lista(((ft._get(f"/markets/quotes?symbols={q}&greeks=false") or {}).get("quotes") or {}).get("quote"))
            c = cot[0] if cot else {}
            exps = ft._vencimientos(q)
            n = len(ft._opciones(q, exps[0])) if exps else 0
            print(f"{s:7s} cotizacion {c.get('symbol')} {c.get('last')} {c.get('type')}  vencimientos {len(exps)}  contratos 1.er {n}"
                  f"  ejemplo {(ft._opciones(q, exps[0]) or [{}])[0].get('symbol') if exps else '-'}")
        except Exception as e:  # noqa: BLE001
            print(f"{s:7s} ERROR {type(e).__name__}: {str(e)[:100]}")
    try:
        ch = ft.cadena(base)
        print(f"cadena({base}): {len(ch['data']['options'])} contratos, precio {ch['data']['current_price']}")
    except Exception as e:  # noqa: BLE001
        print(f"cadena({base}): ERROR {type(e).__name__}: {str(e)[:100]}")
