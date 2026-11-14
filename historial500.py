"""
GEX Lab - historial diario de una lista de tickers (GitHub Actions, workflow historial500.yml).

La lista la edita el administrador en la web (Usuarios > Historial diario) y se guarda en R2 en
config/historial500.json; si aun no existe, se usa TICKERS (la lista inicial).

  python historial500.py                 sesion de hoy (solo si ya ha cerrado y no esta hecha)
  python historial500.py --forzar        rehace la ultima sesion cerrada (con el mercado cerrado)
  python historial500.py --forzar AAPL   solo esos tickers (pruebas)
  python historial500.py --indice        reconstruye hist500/_niveles/ y hist500/_skew.json.gz con los dias ya guardados

Para cada ticker guarda en el almacen (R2 en la nube) un archivo por sesion:
  hist500/{SYM}/{AAAA-MM-DD}.json.gz
    chain:  cadena de CBOE al cierre en formato compacto (chain_to_min): contratos con OI o con volumen del dia
            (strike, tipo, vencimiento, OI, IV, bid, ask, volumen, ultimo precio).
            Se puede recalcular con cualquier motor: gex_engine.parse_chain({"_min": chain}).
    levels[posicion][motor][filtro]: niveles con posicion "standard" y "flow", los dos motores y los filtros
            de la barra (0, 1, 7, 14, 30, 45, all; el 0DTE solo con vencimientos diarios), rango 5 %. Son los mismos campos que
            guarda el historico de la app tras el cierre (el 0DTE ya es el vencimiento siguiente).
  hist500/_niveles/{SYM}.json.gz: indice {fecha: levels} con los campos de CAMPOS_INDICE de todos los dias del
            ticker; lo usa la Validacion del motor para tener toda la historia de un ticker recien anadido.
  hist500/_flujo/{SYM}.json.gz: volumen del dia y lado de la ultima operacion por contrato de las ultimas
            FLOW_DAYS sesiones (lo que necesita el modo flujo); se actualiza cada dia.
  hist500/_skew.json.gz y pub/skew.json: skew a 30 dias de cada accion y señal de skew (skew.py).
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
import skew  # noqa: E402

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
SIEMPRE = ["VIX"]                        # se guardan siempre, esten o no en la lista de la web
INDICES_VOL = ["VIX", "VIX9D", "VIX3M", "VIX6M", "VIX1Y"]   # serie diaria completa (solo el VIX tiene opciones)
NUNCA_BORRAR = ("VIX/", "_indices_vol/")  # el VIX y la familia VIX se guardan sin limite de anos
POSICIONES = ("standard", "flow")
RANGO = 5.0                     # el mismo rango que usa el historico de la app
PAUSA = 0.5                     # segundos entre tickers (ademas del limite de gex_engine)
CAMPOS_INDICE = ("spot", "call_wall", "put_wall", "net_per_pct", "m1_pct", "m1_session", "saved")

_t0 = time.time()
_record_flow = g.record_flow


def _aislar() -> None:
    """Sin efectos secundarios: carpeta temporal propia, ni historico, ni copias de la cadena, ni volatilidad
    realizada. El flujo se guarda a mano (una vez por ticker) y no en cada compute. Solo al ejecutar el script:
    motor.py importa este modulo para leer la lista y no debe heredar estos cambios."""
    g.HIST_DIR = tempfile.mkdtemp(prefix="hist500_")
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
        lista, origen = [str(x) for x in d["symbols"]], "web"
    else:
        lista, origen = list(TICKERS), "codigo"
    return lista + [s for s in SIEMPRE if s not in lista], origen


def guardar_indices_vol(st, sesion: str) -> int:
    """Familia VIX: el dia (apertura, maximo, minimo, cierre de cada indice y la curva de futuros del VIX) en
    _indices_vol/{fecha}.json y la serie diaria completa de CBOE (desde 1990 el VIX) en _indices_vol/historico.json.gz,
    que se reescribe cada dia con lo ultimo. No se borra nunca."""
    dia: dict = {"session": sesion, "saved": g.now_ny().strftime("%Y-%m-%d %H:%M ET"), "indices": {}}
    serie: dict = {}
    for s in INDICES_VOL:
        try:
            q = (g.fetch_quote(s, ttl=0) or {}).get("data") or {}
            dia["indices"][s] = {k: q.get(k) for k in ("open", "high", "low", "close", "prev_day_close", "current_price",
                                                        "last_trade_time")}
            h = g.fetch_aux("historical", s, ttl=0) or {}
            serie[s] = [[r.get("date"), r.get("open"), r.get("high"), r.get("low"), r.get("close")]
                        for r in h.get("data") or [] if r.get("date")]
        except Exception as e:  # noqa: BLE001
            log(f"ERROR {s}: {type(e).__name__}: {str(e)[:100]}")
    try:  # curva de futuros del VIX (cierres oficiales) y estructura de los indices
        import macro
        c = macro.vix_curve()
        dia["futuros"] = {"date": c.get("date"), "points": c.get("points"), "vix_close": c.get("vix_close"),
                          "term": c.get("term"), "m1": c.get("m1"), "m2": c.get("m2")}
    except Exception as e:  # noqa: BLE001
        log(f"ERROR futuros del VIX: {type(e).__name__}: {str(e)[:100]}")
    n = almacen.put_json(st, f"{PREFIX}_indices_vol/{sesion}.json", dia)
    if serie:
        n += almacen.put_json(st, f"{PREFIX}_indices_vol/historico.json.gz",
                              {"actualizado": sesion, "columnas": ["fecha", "apertura", "maximo", "minimo", "cierre"],
                               "series": serie})
    log(f"familia VIX: {len(dia['indices'])} indices, serie de {sum(len(v) for v in serie.values())} dias, {n / 1024:.0f} KB")
    return n


def vencimientos_diarios(ch: dict, sesion: str) -> bool:
    """El 0DTE solo tiene sentido con vencimientos diarios (indices y los ETFs grandes): al menos 4 vencimientos
    distintos en los 7 dias naturales siguientes a la sesion. Las acciones (semanales o lunes/miercoles/viernes)
    y los ETFs pequenos no lo guardan."""
    d0 = np.datetime64(sesion)
    dias = np.unique(ch["exp"].astype("datetime64[D]"))
    return int(((dias > d0) & (dias <= d0 + np.timedelta64(7, "D"))).sum()) >= 4


def cadena_compacta(ch: dict) -> dict:
    keep = (ch["oi"] > 0) | (ch["vol"] > 0)
    sub = {k: (v[keep] if isinstance(v, np.ndarray) and v.shape == keep.shape else v) for k, v in ch.items()}
    return g.chain_to_min(sub)


def guardar_ticker(st, sym: str, sesion: str, puntos: dict | None = None) -> int:
    g._cache.pop(sym, None)
    ch = g.parse_chain(g.fetch_chain(sym, force=True))
    ses_cadena = g.session_date(ch["timestamp"])
    if ses_cadena != sesion:
        raise ValueError(f"la cadena de CBOE es de la sesion {ses_cadena}, no de {sesion}")
    if puntos is not None:  # skew a 30 dias para la señal de skew (skew.py); el cierre sirve para la prueba en adelante
        try:
            p = skew.punto(ch, float(ch["spot"]), g.now_ny())
            if p:
                puntos[sym] = p + [float(ch["spot"])]
        except Exception as e:  # noqa: BLE001
            log(f"ERROR skew {sym}: {type(e).__name__}: {str(e)[:120]}")
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
    try:
        actualizar_indice(st, sym, sesion, niveles)
    except Exception as e:  # noqa: BLE001
        log(f"ERROR indice de niveles {sym}: {type(e).__name__}: {str(e)[:120]}")
    return n


def _niveles_indice(niveles: dict) -> dict:
    """Solo los campos que usa la validacion, con la misma estructura levels[posicion][motor][filtro]."""
    return {pos: {mdl: {f: {k: sn.get(k) for k in CAMPOS_INDICE} for f, sn in fs.items()}
                  for mdl, fs in ms.items()} for pos, ms in niveles.items()}


def reconstruir_indice(st, sym: str) -> dict:
    """Indice de niveles a partir de todos los dias guardados del ticker en hist500/{SYM}/."""
    idx = {}
    rx = re.compile(r"/(\d{4}-\d{2}-\d{2})\.json\.gz$")
    for k in st.list(f"{PREFIX}{g.normalize(sym)}/"):
        m = rx.search(k)
        if m:
            d = almacen.get_json(st, k) or {}
            if d.get("levels"):
                idx[m.group(1)] = _niveles_indice(d["levels"])
    return idx


def actualizar_indice(st, sym: str, sesion: str, niveles: dict | None = None) -> int:
    """Indice compacto hist500/_niveles/{SYM}.json.gz = {fecha: niveles}; lo lee la Validacion del motor
    (leer_indice). Anade la sesion; si el indice aun no existe o no se pasan niveles, lo reconstruye con todos
    los dias guardados. Devuelve las sesiones del indice."""
    sym = g.normalize(sym)
    key = f"{PREFIX}_niveles/{sym}.json.gz"
    idx = almacen.get_json(st, key) if niveles is not None else None
    if idx is None:
        idx = reconstruir_indice(st, sym)
    if niveles is not None:
        idx[sesion] = _niveles_indice(niveles)
    if not f"{sym}/".startswith(NUNCA_BORRAR):
        corte = f"{int(sesion[:4]) - RETENCION_ANOS}{sesion[4:]}"
        idx = {d: v for d, v in idx.items() if d >= corte}
    if idx:
        almacen.put_json(st, key, dict(sorted(idx.items())))
    return len(idx)


def leer_indice(st, sym: str) -> dict:
    """Niveles de cada sesion guardada del ticker ({fecha: levels[posicion][motor][filtro]}); {} si no hay."""
    try:
        return almacen.get_json(st, f"{PREFIX}_niveles/{g.normalize(sym)}.json.gz") or {}
    except Exception:  # noqa: BLE001
        return {}


def publicar_skew(st) -> None:
    try:
        r = skew.publicar(st)
        if r:
            e = r["eval"]
            log(f"skew: {r['stocks']} acciones el {r['date']}, {r['sessions']} sesiones puntuadas; "
                + ", ".join(f"{h} sesiones: {v['n']} evaluadas" for h, v in e.items()))
    except LookupError as e:
        log(f"skew: {e}")


def podar(st, sesion: str) -> int:
    """Borra los archivos con fecha anterior a RETENCION_ANOS antes de la sesion."""
    corte = f"{int(sesion[:4]) - RETENCION_ANOS}{sesion[4:]}"
    rx = re.compile(r"/(\d{4}-\d{2}-\d{2})\.json(\.gz)?$")
    n = 0
    for k in st.list(PREFIX):
        if k[len(PREFIX):].startswith(NUNCA_BORRAR):
            continue
        m = rx.search(k)
        if m and m.group(1) < corte:
            st.delete(k)
            n += 1
    return n


def main(args: list[str]) -> int:
    _aislar()
    forzar = "--forzar" in args
    pedidos = [a for a in args if not a.startswith("--")]
    if "--indice" in args:  # solo reconstruye los indices de niveles con los dias ya guardados
        st = almacen.abrir()
        hoy = g.now_ny().strftime("%Y-%m-%d")
        for sym in pedidos or lista_tickers(st)[0]:
            try:
                log(f"{sym}: indice con {actualizar_indice(st, sym, hoy)} sesiones")
            except Exception as e:  # noqa: BLE001
                log(f"ERROR indice {sym}: {type(e).__name__}: {str(e)[:120]}")
        if not pedidos:
            syms = []
            for a in lista_tickers(st)[0]:
                try:
                    syms.append(g.normalize(a))
                except ValueError:
                    pass
            try:
                log(f"skew: indice con {skew.reconstruir(st, syms)} sesiones")
                publicar_skew(st)
            except Exception as e:  # noqa: BLE001
                log(f"ERROR skew: {type(e).__name__}: {str(e)[:120]}")
        return 0
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
    puntos: dict = {}
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
                n = guardar_ticker(st, sym, sesion, puntos)
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

    try:
        total += guardar_indices_vol(st, sesion)
    except Exception as e:  # noqa: BLE001
        log(f"ERROR familia VIX: {type(e).__name__}: {str(e)[:120]}")
    if pedidos:  # prueba con unos tickers: ni poda ni marca de sesion hecha
        log(f"prueba terminada: {len(ok)}/{len(syms)} tickers, {total / 1e6:.2f} MB")
        return 0 if ok else 1
    if puntos:
        try:
            log(f"skew: {len(puntos)} tickers, indice con {skew.actualizar(st, sesion, puntos)} sesiones")
            publicar_skew(st)
        except Exception as e:  # noqa: BLE001
            log(f"ERROR skew: {type(e).__name__}: {str(e)[:120]}")
    borrados = podar(st, sesion)
    almacen.put_json(st, marca, {
        "session": sesion, "saved": g.now_ny().strftime("%Y-%m-%d %H:%M ET"), "ok": ok, "errores": fallos,
        "bytes": total, "segundos": round(time.time() - _t0, 1)})
    log(f"terminado: {len(ok)}/{len(syms)} tickers, {total / 1e6:.1f} MB, {borrados} archivos antiguos borrados")
    try:  # espacio ocupado en R2, para el panel de administracion
        u = almacen.uso(st)
        u["fecha"] = g.now_ny().strftime("%Y-%m-%d %H:%M ET")
        almacen.put_json(st, "estado/uso.json", u)
        log(f"almacen: {u['total'] / 1e9:.2f} GB en {u['n']} archivos")
    except Exception as e:  # noqa: BLE001
        log(f"uso del almacen no disponible: {type(e).__name__}: {str(e)[:120]}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
