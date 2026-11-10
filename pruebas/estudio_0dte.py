"""Estudio (estudio.yml, script=estudio_0dte.py): que configuracion del 0DTE explica mejor la sesion.

Configuraciones (niveles ex ante del 0DTE que guarda el motor en history/{SYM}.json, clave 'fecha|0{v}|a',
calculados antes de abrir o en los primeros 15 min):
  ""   Neto, convencion estandar     "f"  Neto, flujo
  "s"  Perfil, convencion estandar   "fs" Perfil, flujo
Resultado de cada sesion: velas de 5 min de Tradier (solo sesion regular).

Metricas:
  1. Rango: si el maximo no pasa del Call Wall y el minimo no baja del Put Wall, y el error de cada muro frente al
     extremo real (en % del spot).
  2. Muros: en cada toque (vela que llega a 0,10 % del muro), si en los 30 min siguientes rechaza (cierra a mas de
     0,20 % del muro hacia dentro) o rompe (cierra a mas de 0,10 % fuera).
  3. Regimen respecto al flip: con el precio por encima del flip (gamma positiva) deberia haber menos volatilidad y
     mas reversion a la media que por debajo. Volatilidad = desviacion de los rendimientos de 5 min (anualizada);
     reversion = autocorrelacion de rendimientos consecutivos (negativa = reversion).
Solo lee R2 y escribe resultados agregados (los registros son publicos)."""
import gzip
import io
import json
import math
import os
import sys
import tarfile
from datetime import datetime

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import almacen  # noqa: E402
import fuente_tradier as ft  # noqa: E402

SIMBOLOS = ["SPX", "SPY", "QQQ"]           # con velas de Tradier (NDX y RUT no las tienen)
CONFIG = {"": "Neto estandar", "f": "Neto flujo", "s": "Perfil estandar", "fs": "Perfil flujo"}
TOQUE, RECHAZO, ROTURA, VENTANA = 0.0010, 0.0020, 0.0010, 6   # 6 velas de 5 min = 30 min

st = almacen.abrir()
hist = {}
with tarfile.open(fileobj=io.BytesIO(st.get("estado/estado.tar.gz")), mode="r:gz") as tf:
    for s in SIMBOLOS:
        try:
            hist[s] = json.loads(tf.extractfile(f"history/{s}.json").read())
        except KeyError:
            hist[s] = {}


def velas(sym: str, dia: str) -> list[tuple]:
    d = ft._get(f"/markets/timesales?symbol={sym}&interval=5min&start={dia}%2009:30&end={dia}%2016:00&session_filter=open")
    out = []
    for b in ft._lista(((d or {}).get("series") or {}).get("data")):
        t = str(b["time"])[11:16]
        if "09:30" <= t < "16:00":
            out.append((t, float(b["open"]), float(b["high"]), float(b["low"]), float(b["close"])))
    return out


acum = {v: {"rango": [], "err_cw": [], "err_pw": [], "toques": [0, 0, 0], "ret_pos": [], "ret_neg": [],
            "ac_pos": [], "ac_neg": [], "sesiones": 0} for v in CONFIG}
detalle = []
for sym in SIMBOLOS:
    h = hist[sym]
    dias = sorted({k.split("|")[0] for k in h if k.endswith("|a") and k.split("|")[1] in {"0" + v for v in CONFIG}})
    for dia in dias:
        if dia >= datetime.now().strftime("%Y-%m-%d"):
            continue  # la sesion de hoy aun no ha terminado
        vs = velas(sym, dia)
        if len(vs) < 60:
            print(f"{sym} {dia}: solo {len(vs)} velas, fuera")
            continue
        hi, lo = max(v[2] for v in vs), min(v[3] for v in vs)
        c = np.array([v[4] for v in vs])
        r = np.diff(np.log(c))
        fila = [sym, dia]
        for v in CONFIG:
            L = h.get(f"{dia}|0{v}|a")
            if not L or not L.get("call_wall") or not L.get("put_wall"):
                fila.append("-")
                continue
            a = acum[v]
            a["sesiones"] += 1
            cw, pw, fl, sp = float(L["call_wall"]), float(L["put_wall"]), L.get("flip"), float(L["spot"])
            dentro = hi <= cw and lo >= pw
            a["rango"].append(dentro)
            a["err_cw"].append((cw - hi) / sp * 100)
            a["err_pw"].append((lo - pw) / sp * 100)
            for muro, signo in ((cw, 1), (pw, -1)):      # signo: +1 muro de arriba, -1 de abajo
                i = 0
                while i < len(vs) - 1:
                    toca = (vs[i][2] >= muro * (1 - TOQUE)) if signo > 0 else (vs[i][3] <= muro * (1 + TOQUE))
                    ya_fuera = (vs[i][1] - muro) * signo > muro * ROTURA
                    if toca and not ya_fuera:
                        a["toques"][0] += 1
                        fut = [x[4] for x in vs[i + 1:i + 1 + VENTANA]]
                        if any((x - muro) * signo > muro * ROTURA for x in fut):
                            a["toques"][2] += 1
                        elif any((muro - x) * signo > muro * RECHAZO for x in fut):
                            a["toques"][1] += 1
                        i += VENTANA  # un toque por ventana
                    else:
                        i += 1
            if fl:
                arriba = c[:-1] > float(fl)
                a["ret_pos"] += r[arriba].tolist()
                a["ret_neg"] += r[~arriba].tolist()
                for m, k in ((arriba, "ac_pos"), (~arriba, "ac_neg")):
                    par = m[:-1] & m[1:]
                    a[k] += list(zip(r[:-1][par], r[1:][par]))
            fila.append(f"{'dentro' if dentro else 'fuera '} CW {cw:g} PW {pw:g} flip {fl}")
        detalle.append((fila, hi, lo))

print("\n=== Sesiones (maximo / minimo real, y niveles ex ante de cada configuracion)")
for fila, hi, lo in detalle:
    print(f"{fila[0]} {fila[1]}  max {hi:g} min {lo:g}")
    for v, txt in zip(CONFIG, fila[2:]):
        print(f"    {CONFIG[v]:16s} {txt}")


def vol(x):
    return float(np.std(x, ddof=1) * math.sqrt(78 * 252) * 100) if len(x) > 2 else float("nan")


def ac(p):
    if len(p) < 5:
        return float("nan")
    a, b = np.array(p).T
    return float(np.corrcoef(a, b)[0, 1])


print("\n=== Resumen por configuracion (todas las sesiones y simbolos)")
print(f"{'config':16s} {'ses':>3s} {'rango ok':>8s} {'err CW %':>8s} {'err PW %':>8s} {'toques':>6s} {'rechazo':>7s} "
      f"{'rotura':>6s} | {'vol>flip':>8s} {'vol<flip':>8s} {'n>':>4s} {'n<':>4s} {'ac>flip':>7s} {'ac<flip':>7s}")
for v, a in acum.items():
    n = a["sesiones"]
    if not n:
        print(f"{CONFIG[v]:16s} sin sesiones")
        continue
    t = a["toques"]
    print(f"{CONFIG[v]:16s} {n:3d} {np.mean(a['rango']) * 100:7.0f}% {np.mean(np.abs(a['err_cw'])):8.2f} "
          f"{np.mean(np.abs(a['err_pw'])):8.2f} {t[0]:6d} {t[1] / max(t[0], 1) * 100:6.0f}% {t[2] / max(t[0], 1) * 100:5.0f}% | "
          f"{vol(a['ret_pos']):8.1f} {vol(a['ret_neg']):8.1f} {len(a['ret_pos']):4d} {len(a['ret_neg']):4d} "
          f"{ac(a['ac_pos']):7.2f} {ac(a['ac_neg']):7.2f}")
print("\nLectura: mejor = mas 'rango ok', menos error de muros, mas rechazo, vol<flip mayor que vol>flip y "
      "autocorrelacion mas negativa por encima del flip. Pocas sesiones: orientativo.")
print(f"peticiones Tradier: {ft.peticiones[0]}")
