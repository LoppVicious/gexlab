"""
GEX Lab - historial diario de una lista de tickers (GitHub Actions, workflow historial500.yml).

La lista la edita el administrador en la web (Usuarios > Historial diario) y se guarda en R2 en
config/historial500.json; si aun no existe, se usa TICKERS (la lista inicial).

  python historial500.py                 sesion de hoy (solo si ya ha cerrado y no esta hecha)
  python historial500.py --forzar        rehace la ultima sesion cerrada (con el mercado cerrado)
  python historial500.py --forzar AAPL   solo esos tickers (pruebas)

Para cada ticker guarda en el almacen (R2 en la nube) un archivo por sesion:
  hist500/{SYM}/{AAAA-MM-DD}.json.gz
    chain:  cadena de CBOE al cierre en formato compacto (chain_to_min): contratos con OI o con volumen del dia
            (strike, tipo, vencimiento, OI, IV, bid, ask, volumen, ultimo precio).
            Se puede recalcular con cualquier motor: gex_engine.parse_chain({"_min": chain}).
    levels[posicion][motor][filtro]: niveles con posicion "standard" y "flow", los dos motores y los filtros
            de la barra (0, 1, 7, 14, 30, 45, all; el 0DTE solo con vencimientos diarios), rango 5 %. Son los mismos campos que
            guarda el historico de la app tras el cierre (el 0DTE ya es el vencimiento siguiente).
  hist500/_flujo/{SYM}.json.gz: volumen del dia y lado de la ultima operacion por contrato de las ultimas
            FLOW_DAYS sesiones (lo que necesita el modo flujo); se actualiza cada dia.
Al terminar escribe hist500/_dias/{fecha}.json (resumen) y borra lo que tenga mas de RETENCION_ANOS.
Nunca toca el estado del motor (estado/estado.tar.gz). Los registros de Actions son publicos: solo se
escriben tickers, tiempos y tamanos.
"""
from __future__ import annotations

import os
import re
import sys
import tempfile
import time
from datetime import timedelta

ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)
sys.path.insert(0, ROOT)

import numpy as np  # noqa: E402

import almacen  # noqa: E402
import gex_engine as g  # noqa: E402

TICKERS = """
NVDA AAPL MSFT AMZN GOOGL GOOG META AVGO TSLA MU AMD WMT ASML PLTR INTC COST CSCO PANW AMAT NFLX CRWD TXN AMGN
LIN ARM SHOP MRVL GILD PEP QCOM TMUS BKNG SBUX ADBE FTNT VRTX STX WDC SNDK LLY BRK.B JPM XOM JNJ V ABBV MA CVX
RSP SPY QQQ GLD IWM XLK SMH XLF XLV TLT DIA XLE IEF XLI SLV XLU GDX XLY XLC SOXL DRAM MTUM XLP BKLN AGG SOXX
EEM XBI EWY TAN KO PG HD MRK CAT GE BAC PM ORCL CRM MCD TMO DIS IBM PFE GS MS BA RTX HON UNP LOW T VZ
MCHI KWEB BABA JD PDD BIDU NTES NIO LI XPEV YUMC FUTU
""".split()

PREFIX = "hist500/"
RETENCION_ANOS = 2
ESPERA_CIERRE_MIN = 20          # CBOE publica con 15 min de retraso
LISTA_KEY = "config/historial500.json"  # la escribe el Worker (/api/admin/historial)
POSICIONES = ("standard", "flow")
RANGO = 5.0                     # el mismo rango que usa el historico de la app
PAUSA = 0.5                     # segundos entre tickers (ademas del limite de gex_engine)

_t0 = time.time()

# sin efectos secundarios: carpeta temporal propia, ni historico, ni copias de la cadena, ni volatilidad realizada.
# El flujo se guarda a mano (una vez por ticker) y no en cada compute.
g.HIST_DIR = tempfile.mkdtemp(prefix="hist500_")
_record_flow = g.record_flow
g.history_update = lambda *a, **k: None
g.history_series = lambda *a, **k: {}
g.record_flow = lambda *a, **k: None
g.save_chain_snapshot = lambda *a, **k: None
g._realized_vol = lambda *a, **k: None   # ahorra una peticion a CBOE por ticker


def log(msg: str) -> None:
    print(f"[{time.time() - _t0:6.1f}s] {msg}", flush=True)


def sesion_objetivo(forzar: bool) -> str | None:
    """Sesion que toca guardar: la de hoy si ya cerro hace ESPERA_CIERRE_MIN. Con --forzar, la ultima sesion
    cerrada, pero nunca con el mercado abierto (los datos serian de la sesion en curso)."""
    now = g.now_ny()
    if g.is_trading_day(now) and now >= g.close_time(now) + timedelta(minutes=ESPERA_CIERRE_MIN):
        return now.strftime("%Y-%m-%d")
    if not forzar:
        return None
    if g.market_open(now) or (g.is_trading_day(now) and now >= g.close_time(now)):
        return None  # abierto o recien cerrado: hay que esperar
    return g.last_close(now).strftime("%Y-%m-%d")


def lista_tickers(st) -> tuple[list[str], str]:
    """Tickers del dia: la lista de la web (R2) o, si nadie la ha editado aun, TICKERS."""
    try:
        d = almacen.get_json(st, LISTA_KEY)
    except Exception as e:  # noqa: BLE001
        log(f"lista de la web no disponible ({type(e).__name__}); se usa la del codigo")
        d = None
    if d and isinstance(d.get("symbols"), list) and d["symbols"]:
        return [str(x) for x in d["symbols"]], "web"
    return list(TICKERS), "codigo"


def vencimientos_diarios(ch: dict, sesion: str) -> bool:
    """El 0DTE solo tiene sentido con vencimientos diarios (indices y los ETFs grandes): al menos 4 vencimientos
    distintos en los 7 dias naturales siguientes a la sesion. Las acciones (semanales o lunes/miercoles/viernes)
    y los ETFs pequenos no lo guardan."""
    d0 = np.datetime64(sesion)
    dias = np.unique(ch["exp"].astype("datetime64[D]"))
    return int(((dias > d0) & (dias <= d0 + 7)).sum()) >= 4


def cadena_compacta(ch: dict) -> dict:
    keep = (ch["oi"] > 0) | (ch["vol"] > 0)
    sub = {k: (v[keep] if isinstance(v, np.ndarray) and v.shape == keep.shape else v) for k, v in ch.items()}
    return g.chain_to_min(sub)


def guardar_ticker(st, sym: str, sesion: str) -> int:
    g._cache.pop(sym, None)
    ch = g.parse_chain(g.fetch_chain(sym, force=True))
    ses_cadena = g.session_date(ch["timestamp"])
    if ses_cadena != sesion:
        raise ValueError(f"la cadena de CBOE es de la sesion {ses_cadena}, no de {sesion}")
    # flujo: el historico de las ultimas sesiones (R2) + la de hoy, antes de calcular con posicion "flow"
    fkey = f"{PREFIX}_flujo/{sym}.json.gz"
    fpath = os.path.join(g.HIST_DIR, f"flow_{sym.replace('.', '_')}.json.gz")
    previo = almacen.get_json(st, fkey)
    if previo:
        g.write_json(fpath, previo)
    _record_flow(sym, ch, sesion, force=True)
    flujo = g.read_json(fpath, {}) or {}

    filtros = [x for x in g.DTE_FILTERS if x != "0" or vencimientos_diarios(ch, sesion)]
    niveles: dict = {}
    info_flujo = None
    for pos in POSICIONES:
        for model in g.MODELS:
            for f in filtros:
                try:
                    r = g.compute(sym, max_dte=g.dte_arg(f), window_pct=RANGO, model=model, positioning=pos)
                except LookupError:  # sin contratos en ese filtro
                    continue
                snap = g._snap(r)
                snap.update(zero_gamma=r["levels"]["zero_gamma"], front_expiry=r["front_expiry"],
                            call_per_pct=r["totals"]["call_per_pct"], put_per_pct=r["totals"]["put_per_pct"])
                niveles.setdefault(pos, {}).setdefault(model, {})[f] = snap
                if pos == "flow" and r.get("flow_info"):
                    info_flujo = {k: r["flow_info"].get(k) for k in ("days", "first", "kappa", "gaps")}
    doc = {
        "v": 2, "symbol": sym, "session": sesion, "saved": g.now_ny().strftime("%Y-%m-%d %H:%M ET"),
        "source": "CBOE delayed quotes", "rate": g.rate_info(), "range_pct": RANGO, "flow_info": info_flujo,
        "spot": ch["spot"], "close": ch["close"], "prev_close": ch["prev_close"],
        "levels": niveles, "chain": cadena_compacta(ch),
    }
    n = almacen.put_json(st, f"{PREFIX}{g.normalize(sym)}/{sesion}.json.gz", doc)
    if flujo:
        almacen.put_json(st, fkey, flujo)
    return n


def podar(st, sesion: str) -> int:
    """Borra los archivos con fecha anterior a RETENCION_ANOS antes de la sesion."""
    corte = f"{int(sesion[:4]) - RETENCION_ANOS}{sesion[4:]}"
    rx = re.compile(r"/(\d{4}-\d{2}-\d{2})\.json(\.gz)?$")
    n = 0
    for k in st.list(PREFIX):
        m = rx.search(k)
        if m and m.group(1) < corte:
            st.delete(k)
            n += 1
    return n


def main(args: list[str]) -> int:
    forzar = "--forzar" in args
    pedidos = [a for a in args if not a.startswith("--")]
    sesion = sesion_objetivo(forzar)
    now = g.now_ny()
    if sesion is None:
        log(f"nada que hacer: {now:%Y-%m-%d %H:%M} ET (dia sin mercado o sesion sin cerrar)")
        return 0
    st = almacen.abrir()
    marca = f"{PREFIX}_dias/{sesion}.json"
    if not forzar and st.get(marca) is not None:
        log(f"sesion {sesion} ya guardada")
        return 0

    lista, origen = (pedidos, "prueba") if pedidos else lista_tickers(st)
    syms = []
    for a in lista:
        try:
            s = g.normalize(a)
        except ValueError:
            log(f"ticker no valido en la lista: {a}")
            continue
        if s not in syms:
            syms.append(s)
    log(f"sesion {sesion}: {len(syms)} tickers (lista: {origen})")
    ok, fallos, total = [], [], 0
    pendientes = list(syms)
    for ronda in range(2):  # segunda ronda: los que fallaron, tras una pausa
        if ronda:
            if not pendientes:
                break
            log(f"reintento de {len(pendientes)} tickers en 60 s")
            time.sleep(60)
        siguientes = []
        for sym in pendientes:
            t = time.time()
            try:
                n = guardar_ticker(st, sym, sesion)
                total += n
                ok.append(sym)
                log(f"{sym}: {n / 1024:.0f} KB en {time.time() - t:.1f} s")
            except Exception as e:  # noqa: BLE001
                siguientes.append(sym)
                log(f"ERROR {sym}: {type(e).__name__}: {str(e)[:120]}")
                if "429" in str(e):
                    time.sleep(20)
            time.sleep(PAUSA)
        pendientes = siguientes
    fallos = pendientes

    if pedidos:  # prueba con unos tickers: ni poda ni marca de sesion hecha
        log(f"prueba terminada: {len(ok)}/{len(syms)} tickers, {total / 1e6:.2f} MB")
        return 0 if ok else 1
    borrados = podar(st, sesion)
    almacen.put_json(st, marca, {
        "session": sesion, "saved": g.now_ny().strftime("%Y-%m-%d %H:%M ET"), "ok": ok, "errores": fallos,
        "bytes": total, "segundos": round(time.time() - _t0, 1)})
    log(f"terminado: {len(ok)}/{len(syms)} tickers, {total / 1e6:.1f} MB, {borrados} archivos antiguos borrados")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
