"""Pasada post-cierre del motor (motor.fase_cierre) con datos reales de CBOE y un almacen local.

Simula las 16:40 ET de hoy: los tickers del historial diario que no estan en el universo se calculan como los de
las listas (paquete, vol.json, historial de niveles, copia de la cadena, punto de volatilidad) y quedan marcados;
la segunda pasada no repite ninguno."""
import os
import sys
import tempfile

os.environ["GEX_ALMACEN"] = "local:" + tempfile.mkdtemp(prefix="almacen_")
sys.path.insert(0, os.getcwd())

import almacen  # noqa: E402
import gex_engine as g  # noqa: E402
import motor  # noqa: E402

# las 16:40 ET de la sesion a la que pertenece la cadena que da CBOE ahora (de madrugada o en tickers con poco
# volumen sigue siendo la del dia anterior): asi la hora simulada y los datos son coherentes
from datetime import datetime  # noqa: E402
ses = g.session_date(g.parse_chain(g.fetch_chain("KWEB"))["timestamp"])
fake = g.close_time(datetime.strptime(ses, "%Y-%m-%d")) + motor.timedelta(minutes=40)
g._cache.clear()
g.now_ny = lambda: fake
print("hora simulada", fake)

st = almacen.abrir()
almacen.put_json(st, "config/historial500.json", {"symbols": ["AAPL", "KWEB", "MCHI"]})
universo = ["AAPL"]

motor.fase_cierre(st, universo)
motor.esperar_subidas()

fallos = []
def ok(cond, msg):
    print(("OK   " if cond else "FALLO") + " " + msg)
    if not cond:
        fallos.append(msg)

marca = g.read_json(os.path.join(g.HIST_DIR, "_cierre.json"), {})
print("marca", marca)
for sym in ("KWEB", "MCHI"):
    paq = almacen.get_json(st, f"pub/t/{sym}/paquete.json")
    vol = almacen.get_json(st, f"pub/t/{sym}/vol.json")
    ok(bool(paq and paq.get("files")), f"{sym}: paquete publicado")
    ok(bool(vol and vol.get("matrix", {}).get("rows")), f"{sym}: vol.json con matriz")
    hist = g.read_json(os.path.join(g.HIST_DIR, f"{sym}.json"), {}) or {}
    ok(len(hist) >= 7, f"{sym}: historial de niveles ({len(hist)} claves)")
    day = fake.strftime("%Y-%m-%d")
    if not os.path.exists(g._snap_path(sym, day)):
        ch = g.parse_chain(g.fetch_chain(sym))
        print("  diagnostico:", sym, "timestamp", ch["timestamp"], "sesion", g.session_date(ch["timestamp"]),
              "copias", os.listdir(os.path.dirname(g._snap_path(sym, day))) if os.path.isdir(os.path.dirname(g._snap_path(sym, day))) else "sin carpeta")
    ok(os.path.exists(g._snap_path(sym, day)), f"{sym}: copia de la cadena del dia")
    iv = g.read_json(os.path.join(g.HIST_DIR, f"ivsurf_{sym}.json"), {}) or {}
    ok(day in iv, f"{sym}: punto de volatilidad del dia")
    ok(sym in (marca.get("hechos") or []), f"{sym}: marcado como hecho")
ok(almacen.get_json(st, "pub/t/AAPL/paquete.json") is None, "AAPL (en el universo) no lo toca la pasada")

# segunda pasada: nada pendiente
n_antes = len(motor._subidas)
motor.fase_cierre(st, universo)
ok(len(motor._subidas) == n_antes, "segunda pasada: no repite ningun ticker")

# antes del cierre no hace nada
g.now_ny = lambda: fake.replace(hour=15, minute=0)
os.remove(os.path.join(g.HIST_DIR, "_cierre.json"))
motor.fase_cierre(st, universo)
ok(not os.path.exists(os.path.join(g.HIST_DIR, "_cierre.json")), "con el mercado abierto no hace nada")

print("errores del motor:", motor._errores)
sys.exit(1 if fallos else 0)
