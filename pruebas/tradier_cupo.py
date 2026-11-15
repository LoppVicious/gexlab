"""Cupo de Tradier con el modo rapido: descarga las cadenas y velas de los 6 indices en tiempo real (lo mismo que
una pasada de motor.py rapido) tres veces seguidas y anota, por tipo de peticion, las cabeceras X-Ratelimit y las
esperas. Sirve para saber si una pasada por minuto cabe en el limite. Solo escribe recuentos, tiempos y cabeceras."""
import os, sys, time
import urllib.request
sys.path.insert(0, os.getcwd())
import fuente_tradier as ft
import motor

registro = []  # (tipo, used, available, allowed, expiry)
_orig = urllib.request.urlopen


def _espia(req, *a, **k):
    r = _orig(req, *a, **k)
    url = req.full_url if hasattr(req, "full_url") else str(req)
    tipo = url.split("/v1/")[-1].split("?")[0]
    h = r.headers
    registro.append((tipo, h.get("X-Ratelimit-Used"), h.get("X-Ratelimit-Available"), h.get("X-Ratelimit-Allowed"),
                     h.get("X-Ratelimit-Expiry"), round(time.time(), 2)))
    return r


urllib.request.urlopen = _espia
print("token presente:", ft.disponible())
for ronda in range(3):
    t0, n0, r0 = time.time(), ft.peticiones[0], len(registro)
    for sym in motor.TIEMPO_REAL:
        t, n = time.time(), ft.peticiones[0]
        try:
            ch = ft.cadena(sym)
            nc = len(ch["data"]["options"])
        except Exception as e:  # noqa: BLE001
            nc = f"ERROR {type(e).__name__}: {e}"
        if sym in motor.VELAS_TRADIER:
            try:
                ft.velas(sym)
            except Exception as e:  # noqa: BLE001
                print(f"  velas {sym}: {type(e).__name__}")
        print(f"ronda {ronda} {sym}: {ft.peticiones[0] - n} peticiones, {time.time() - t:.1f} s, contratos {nc}")
    print(f"ronda {ronda}: {ft.peticiones[0] - n0} peticiones en {time.time() - t0:.1f} s")
    por = {}
    for tipo, used, avail, allowed, exp, ts in registro[r0:]:
        por.setdefault(tipo, []).append((used, avail, allowed, exp))
    for tipo, v in por.items():
        usados = [int(x[0]) for x in v if x[0] is not None]
        print(f"  {tipo}: {len(v)} peticiones, allowed {v[-1][2]}, used min {min(usados, default=None)} max "
              f"{max(usados, default=None)}, available al final {v[-1][1]}, expiras distintos {len({x[3] for x in v})}")
print("peticiones totales:", ft.peticiones[0])
