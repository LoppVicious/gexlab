"""
GEX Lab - motor en la nube (GitHub Actions).

  python motor.py ciclo            recoge y calcula todo para los tickers de todas las listas
  python motor.py ticker SPX AMD   calculo puntual de uno o varios tickers (p. ej. uno nuevo en una lista)

Cada ciclo:
  1. recupera el estado (historial, flujo, copias de la cadena, caches) del almacen
  2. recolector: aperturas, ultima media hora y cierres, como en el PC
  3. descarga cada ticker de CBOE y publica su paquete compacto (lo usa el motor del navegador)
  4. calcula Compass y Validacion de cada lista, la curva VIX, el COT y el Resumen
  5. calcula, a partir de los mismos paquetes, las vistas que los usuarios tienen seleccionadas y el Escaner
  6. guarda el estado

Lo que se publica (prefijo pub/) lo sirve la API a la web; el estado (prefijo estado/) no sale nunca.
Los registros de GitHub Actions son publicos: aqui solo se escriben tickers, tiempos y tamanos.
"""
from __future__ import annotations

import io
import json
import os
import shutil
import sys
import tarfile
import time
import traceback
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)
sys.path.insert(0, ROOT)

import almacen  # noqa: E402
import gex_engine as g  # noqa: E402

# una descarga de cada cadena por ciclo: con Tradier (tiempo real) cada cadena son decenas de peticiones
# (una por vencimiento, 120 por minuto) y el Compass y el recolector la vuelven a pedir
g.CACHE_TTL = 900

ESTADO_KEY = "estado/estado.tar.gz"
COPIAS_PREFIX = "estado/copias/"
COPIAS_N = 14
FX = os.path.join(ROOT, "salida", "fx")           # paquetes del ciclo, en formato de fixtures del motor
DTES = list(g.DTE_FILTERS)  # 0, 1, 7, 14, 30, 45 y todos
VAL_MODES = ["standard", "flow"]
SIEMPRE = ["VIX"]   # se calculan cada ciclo aunque no esten en ninguna lista (paquete, historico, volatilidad)
DEFAULT_VISTA = {"dte": "45", "range": "auto", "pos": "standard", "combo": "0", "sess": "auto", "model": "spotgamma"}

_t0 = time.time()
_errores: list[str] = []

# subidas en paralelo: cada escritura en R2 tarda ~1 s desde GitHub, el calculo sigue mientras tanto
from concurrent.futures import ThreadPoolExecutor  # noqa: E402
import gzip as _gzip  # noqa: E402
_pool = ThreadPoolExecutor(max_workers=8)
_subidas: list = []


def subir(st, key: str, obj) -> int:
    data = _gzip.compress(almacen.dumps(obj), compresslevel=6)
    _subidas.append((key, _pool.submit(st.put, key, data, "application/json; charset=utf-8", True)))
    return len(data)


def esperar_subidas() -> None:
    for key, f in _subidas:
        try:
            f.result()
        except Exception as e:  # noqa: BLE001
            err(f"subida {key}", e)
    _subidas.clear()


def log(msg: str) -> None:
    print(f"[{time.time() - _t0:6.1f}s] {msg}", flush=True)


def err(where: str, e: Exception) -> None:
    _errores.append(f"{where}: {type(e).__name__}: {str(e)[:160]}")
    log(f"ERROR {where}: {type(e).__name__}: {str(e)[:160]}")


# ---------------------------------------------------------------- claves de las vistas (las comparte la web)
def rango_canon(r) -> str:
    """'auto' o el % con punto y sin ceros sobrantes ('5', '2.5'). Mismo criterio que la web."""
    r = str(r).strip().lower().replace(",", ".")
    if r == "auto":
        return "auto"
    v = min(75.0, max(0.3, float(r)))
    return f"{v:.2f}".rstrip("0").rstrip(".")


def vista_canon(v: dict, symbol: str) -> dict:
    dte = str(v.get("dte", "45"))
    if dte not in DTES:
        dte = "45"
    combo = "1" if str(v.get("combo", "0")) in ("1", "true", "True") and symbol in g.INDEX_PROXY else "0"
    pos = "flow" if v.get("pos") == "flow" and combo == "0" else "standard"
    sess = v.get("sess") if v.get("sess") in ("auto", "last", "next") else "auto"
    model = "gexbot" if v.get("model") == "gexbot" else "spotgamma"
    return {"dte": dte, "range": rango_canon(v.get("range", "5")), "pos": pos, "combo": combo, "sess": sess, "model": model}


def clave_niveles(v: dict) -> str:
    return f"{v['dte']}_{v['range']}_{v['pos']}_{v['combo']}" + ("_gb" if v.get("model") == "gexbot" else "")


def clave_mapa(v: dict) -> str:
    return clave_niveles(v) + f"_{v['sess']}"


def _dte_arg(dte: str):
    return None if dte == "all" else int(dte)


def _rango_arg(r: str):
    return "auto" if r == "auto" else float(r)


# ---------------------------------------------------------------- estado
def restaurar_estado(st) -> None:
    b = st.get(ESTADO_KEY)
    prov = os.path.join(ROOT, "almacen", *ESTADO_KEY.split("/"))
    if not b and os.path.exists(prov):  # paso del almacen provisional (cache de GitHub) a R2
        with open(prov, "rb") as f:
            b = f.read()
        log("estado: se recupera del almacen provisional")
    if not b:
        log("estado: no hay estado previo, se empieza de cero")
        return
    with tarfile.open(fileobj=io.BytesIO(b), mode="r:gz") as tf:
        for m in tf.getmembers():
            if m.name.startswith(("/", "..")) or ".." in m.name.split("/") or not (m.isfile() or m.isdir()):
                continue
            if not m.name.split("/")[0] in ("history", "cache"):
                continue
            tf.extract(m, ROOT, filter="data")
    log(f"estado: restaurado ({len(b) / 1e6:.1f} MB)")


def guardar_estado(st, copia: bool) -> None:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz", compresslevel=6) as tf:
        for d in ("history", "cache"):
            if os.path.isdir(d):
                tf.add(d)
    data = buf.getvalue()
    st.put(ESTADO_KEY, data, "application/gzip")
    log(f"estado: guardado ({len(data) / 1e6:.1f} MB)")
    if copia:
        st.put(f"{COPIAS_PREFIX}{datetime.now(timezone.utc):%Y-%m-%d}.tar.gz", data, "application/gzip")
        for k in st.list(COPIAS_PREFIX)[:-COPIAS_N]:
            st.delete(k)


# ---------------------------------------------------------------- importacion del historial del PC
IMPORT_KEY = "importar/historial.tar.gz"


def _merge_json(a: dict, b: dict, prefer_a_suffix: str | None = None) -> dict:
    """Une dos diccionarios por clave. Gana b (la nube, mas reciente) salvo en las claves que acaban en
    prefer_a_suffix (fotos ex ante: vale la primera que se hizo, la del PC)."""
    out = dict(a)
    for k, v in b.items():
        if prefer_a_suffix and k.endswith(prefer_a_suffix) and k in a:
            continue
        out[k] = v
    return out


def importar(st) -> None:
    """Mezcla en el estado el historial que el administrador sube desde la web (carpeta history del PC)."""
    b = st.get(IMPORT_KEY)
    if not b:
        return
    import tempfile
    tmp = tempfile.mkdtemp()
    n = 0
    with tarfile.open(fileobj=io.BytesIO(b), mode="r:gz") as tf:
        for m in tf.getmembers():
            parts = m.name.replace("\\", "/").split("/")
            if not m.isfile() or ".." in parts or m.name.startswith("/") or parts[0] != "history":
                continue
            tf.extract(m, tmp, filter="data")
    src = os.path.join(tmp, "history")
    for dirpath, _, files in os.walk(src):
        for fn in files:
            rel = os.path.relpath(os.path.join(dirpath, fn), src)
            if fn.endswith(".log") or fn.endswith(".tmp"):
                continue
            pc_path, cl_path = os.path.join(dirpath, fn), os.path.join(g.HIST_DIR, rel)
            try:
                if rel.startswith("chains" + os.sep):
                    if not os.path.exists(cl_path):  # copia de la cadena: si la nube ya tiene ese dia, vale la suya
                        os.makedirs(os.path.dirname(cl_path), exist_ok=True)
                        shutil.copy2(pc_path, cl_path)
                        n += 1
                    continue
                pc = g.read_json(pc_path) or {}
                cl = g.read_json(cl_path) or {}
                if fn == "recolector_state.json":
                    out = dict(pc)
                    out.update({k: v for k, v in cl.items() if v})
                    for k in ("apertura", "intradia", "cierre"):  # la recogida mas reciente de cada tipo
                        out[k] = max(x for x in (pc.get(k), cl.get(k)) if x) if (pc.get(k) or cl.get(k)) else None
                    if not cl.get("ultima_recogida") and pc.get("ultima_recogida"):
                        out["ultima_recogida"] = pc["ultima_recogida"]
                elif fn == "universo.json":
                    out = {k: max(x for x in (pc.get(k), cl.get(k)) if x) for k in set(pc) | set(cl)}
                else:  # niveles, flujo y volatilidad: union por sesion
                    out = _merge_json(pc, cl, prefer_a_suffix="|a")
                g.write_json(cl_path, out)
                n += 1
            except Exception as e:  # noqa: BLE001
                err(f"importar {rel}", e)
    shutil.rmtree(tmp, ignore_errors=True)
    st.delete(IMPORT_KEY)
    log(f"importacion: {n} archivos del historial del PC mezclados")


# ---------------------------------------------------------------- configuracion (la escribe la API)
def leer_config(st) -> dict:
    c = almacen.get_json(st, "config/config.json", {}) or {}
    listas = {k: [s for s in v if isinstance(s, str)] for k, v in (c.get("listas") or {}).items() if isinstance(v, list)}
    if not listas:
        listas = {"base": list(g.DEFAULT_WATCH)}
    universo = []
    for v in listas.values():
        for s in v:
            try:
                s = g.normalize(s)
            except ValueError:
                continue
            if s not in universo:
                universo.append(s)
    fijos = almacen.get_json(st, "config/fijos.json", {}) or {}  # tickers fijos (panel de administracion)
    for s in [*SIEMPRE, *(fijos.get("symbols") or [])]:
        try:
            s = g.normalize(str(s))
        except ValueError:
            continue
        if s not in universo:
            universo.append(s)
    vistas = c.get("vistas") or [DEFAULT_VISTA]
    if DEFAULT_VISTA not in vistas:
        vistas = [DEFAULT_VISTA] + list(vistas)
    return {"listas": listas, "universo": universo, "vistas": vistas[:12]}


# ---------------------------------------------------------------- paquete de cada ticker
def paquete(sym: str) -> dict:
    """Todo lo que el motor del navegador necesita para calcular cualquier vista de este ticker.
    Las rutas 'fx/...' van a la carpeta de datos del motor y 'hist/...' a su historial."""
    raw = g.fetch_chain(sym)
    ch = g.parse_chain(raw)
    mn = g.chain_to_min(ch)
    files = {f"fx/{sym}.min.json": mn}
    try:
        files[f"fx/flowpos_{sym.replace('.', '_')}.json"] = g.flow_positions_all(sym, g.chain_from_min(mn))
    except Exception as e:  # noqa: BLE001
        err(f"{sym} flujo", e)
    intr = g.fetch_aux("intraday", sym, ttl=60)
    if intr:
        files[f"fx/intraday_{sym}.json"] = intr
    proxy = g.INDEX_PROXY.get(sym)
    if proxy:
        q = g.fetch_quote(proxy)
        if q:
            files[f"fx/quote_{proxy}.json"] = q
    files["fx/rate.json"] = g.rate_info()
    # ultimos cierres (volatilidad realizada de la ficha del Equity Hub)
    for hs in (sym, proxy):
        if not hs:
            continue
        hd = g.fetch_aux("historical", hs, ttl=6 * 3600)
        if hd and hd.get("data"):
            files[f"fx/historical_{hs}.json"] = {"data": hd["data"][-30:]}
            break
    h = g.read_json(os.path.join(g.HIST_DIR, f"{sym.replace('.', '_')}.json"))
    if h:
        files[f"hist/{sym.replace('.', '_')}.json"] = h
    day = g.map_session(g.now_ny(), "last")[0].strftime("%Y-%m-%d")
    snap = g.read_json(g._snap_path(sym, day))
    if snap:
        files[f"hist/chains/{os.path.basename(g._snap_path(sym, day))}"] = snap
    return {"v": 1, "symbol": sym, "name": g.name_of(sym), "proxy": proxy, "generado": g.now_ny().strftime("%Y-%m-%d %H:%M ET"),
            "timestamp": ch["timestamp"], "files": files}


def escribir_fixtures(paq: dict) -> None:
    """Deja el paquete en salida/fx para calcular las vistas exactamente como lo hara el navegador."""
    for rel, obj in paq["files"].items():
        if not rel.startswith("fx/"):
            continue
        p = os.path.join(FX, rel[3:])
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            json.dump(obj, f, separators=(",", ":"))


# ---------------------------------------------------------------- fases
def fase_tickers(st, syms: list[str], proxies: list[str]) -> list[str]:
    """Descarga, mantiene el historial y el flujo (como al usar la app en el PC) y publica los paquetes."""
    ok = []
    for sym in syms + [p for p in proxies if p not in syms]:
        t = time.time()
        for intento in range(2):  # si CBOE limita las peticiones (429), espera y lo reintenta una vez
            try:
                _ticker(st, sym, syms)
                ok.append(sym)
                log(f"{sym}: listo en {time.time() - t:.1f} s")
                break
            except ConnectionError as e:
                if "429" in str(e) and intento == 0:
                    log(f"{sym}: CBOE limita las peticiones, reintento en 20 s")
                    time.sleep(20)
                    continue
                err(sym, e)
                break
            except Exception as e:  # noqa: BLE001
                err(sym, e)
                break
        time.sleep(0.3)
    return ok


def _ticker(st, sym: str, syms: list[str]) -> None:
    """Un ticker: historial de niveles, paquete para el navegador y panel de volatilidad."""
    if sym in syms:
        # historial de niveles de los dos motores, los cuatro filtros y los dos modos (Historico y Validacion),
        # flujo y copia de la cadena
        for mdl in g.MODELS:
            for dte in [_dte_arg(x) for x in DTES]:
                for pos in ("standard", "flow"):
                    try:
                        g.compute(sym, max_dte=dte, window_pct=5.0, model=mdl, positioning=pos)
                    except LookupError:  # sin vencimientos en ese filtro (p. ej. solo mensuales): se salta
                        pass
    paq = paquete(sym)
    escribir_fixtures(paq)
    n = subir(st, f"pub/t/{sym}/paquete.json", paq)
    try:  # panel de volatilidad (y su historia diaria)
        import volatilidad
        subir(st, f"pub/t/{sym}/vol.json", volatilidad.vol_data(sym, save=sym in syms))
    except Exception as e:  # noqa: BLE001
        err(f"{sym} volatilidad", e)
    log(f"{sym}: paquete {n / 1e6:.2f} MB")


def fase_listas(st, listas: dict) -> None:
    for lid, syms in listas.items():
        syms = [s for s in syms if s]
        try:
            subir(st, f"pub/l/{lid}/compass.json", g.compass(syms))
        except Exception as e:  # noqa: BLE001
            err(f"compass {lid}", e)
        for dte in DTES:
            for mode in VAL_MODES:
                try:
                    for mdl in g.MODELS:  # la Validacion sigue al motor elegido en la web
                        subir(st, f"pub/l/{lid}/validacion_{dte}_{mode}_{mdl}.json", g.validation(syms, dte, mode, mdl))
                except Exception as e:  # noqa: BLE001
                    err(f"validacion {lid} {dte} {mode}", e)
    log(f"listas: Compass y Validacion de {len(listas)} listas")


def fase_macro(st) -> None:
    import macro
    for key, fn in (("vix", macro.vix_curve), ("cot", macro.cot), ("resumen", macro.summary)):
        try:
            subir(st, f"pub/{key}.json", fn())
        except Exception as e:  # noqa: BLE001
            err(key, e)
    for m in macro.COT_MARKETS:
        try:
            subir(st, f"pub/cot_hist/{m[0]}.json", macro.cot_history(m[0]))
        except Exception as e:  # noqa: BLE001
            err(f"cot {m[0]}", e)
    try:  # calendario macro: como mucho cada 6 h
        import eventos
        st_ev = g.read_json(eventos.STATE, {}) or {}
        last = st_ev.get("actualizado")
        fred_nueva = st_ev.get("version") != eventos.VERSION or (
            bool(os.environ.get("FRED_API_KEY")) and not (st_ev.get("fuentes") or {}).get("fred"))
        if fred_nueva or not last or (datetime.now(timezone.utc) - datetime.strptime(last, "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)).total_seconds() > 6 * 3600:
            evs, res = eventos.actualizar()
            log(f"calendario: {len(evs)} eventos ({', '.join(f'{k} {v}' for k, v in res.items())})")
        subir(st, "pub/eventos.json", eventos.publicables())
    except Exception as e:  # noqa: BLE001
        err("calendario", e)
    log("macro: curva VIX, COT y Resumen")


def _borrar_vistas_viejas(st, sym: str, hechas: set) -> int:
    """Vistas precalculadas que ya nadie usa: si se quedan, la web las serviria con datos de otro ciclo."""
    n = 0
    try:
        for kind in ("niveles", "mapa"):
            pre = f"pub/t/{sym}/{kind}/"
            for key in st.list(pre):
                if key[len(pre):].removesuffix(".json") not in hechas:
                    st.delete(key)
                    n += 1
    except Exception as e:  # noqa: BLE001
        err(f"{sym} limpieza de vistas", e)
    return n


def fase_vistas(st, syms: list[str], vistas: list[dict], listas: dict) -> None:
    """Con los paquetes ya escritos: el motor trabaja sin red, igual que en el navegador."""
    prev_fx = os.environ.get("GEX_FIXTURE_DIR")
    os.environ["GEX_FIXTURE_DIR"] = FX
    g._cache.clear(); g._aux_cache.clear(); g._heat_cache.clear(); g._rate["t"] = 0.0
    n = n_borradas = 0
    for sym in syms:
        hechas = set()
        for v0 in vistas:
            v = vista_canon(v0, sym)
            kn, km = clave_niveles(v), clave_mapa(v)
            args = dict(max_dte=_dte_arg(v["dte"]), window_pct=_rango_arg(v["range"]),
                        combine=v["combo"] == "1", positioning=v["pos"], model=v["model"])
            try:
                if kn not in hechas:
                    subir(st, f"pub/t/{sym}/niveles/{kn}.json", g.compute(sym, **args))
                    hechas.add(kn); n += 1
                if km not in hechas:
                    subir(st, f"pub/t/{sym}/mapa/{km}.json", g.heatmap(sym, which=v["sess"], **args))
                    hechas.add(km); n += 1
            except Exception as e:  # noqa: BLE001
                err(f"{sym} vista {km}", e)
        n_borradas += _borrar_vistas_viejas(st, sym, hechas)
    log(f"vistas: {n} calculadas, {n_borradas} antiguas borradas")
    for dte in DTES:
        try:
            rows = g.scan(syms, _dte_arg(dte))
            at = g.now_ny().strftime("%Y-%m-%d %H:%M")
            for lid, ls in listas.items():
                subir(st, f"pub/l/{lid}/escaner_{dte}.json",
                                 {"rows": [r for r in rows if r.get("symbol") in ls], "computed_at": at})
        except Exception as e:  # noqa: BLE001
            err(f"escaner {dte}", e)
    log("escaner: 4 filtros de vencimientos")
    if prev_fx:
        os.environ["GEX_FIXTURE_DIR"] = prev_fx
    else:
        del os.environ["GEX_FIXTURE_DIR"]
    g._cache.clear(); g._aux_cache.clear(); g._heat_cache.clear(); g._rate["t"] = 0.0


def publicar_generales(st) -> None:
    import recolector
    stt = recolector.read_state()
    stt["instalado"] = True
    stt["nube"] = True
    subir(st, "pub/recolector.json", stt)
    # directorio de simbolos para el buscador (una vez al dia)
    meta = almacen.get_json(st, "pub/simbolos_meta.json", {}) or {}
    hoy = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if meta.get("fecha") != hoy:
        try:
            syms = g.load_symbols()
            subir(st, "pub/simbolos.json", [[s, n] for s, n in syms])
            subir(st, "pub/simbolos_meta.json", {"fecha": hoy, "n": len(syms)})
        except Exception as e:  # noqa: BLE001
            err("simbolos", e)


# ---------------------------------------------------------------- modos
def ciclo() -> int:
    st = almacen.abrir()
    restaurar_estado(st)
    importar(st)
    cfg = leer_config(st)
    syms = cfg["universo"]
    g.load_symbols()  # nombres de los tickers
    log(f"universo: {len(syms)} tickers, {len(cfg['listas'])} listas, {len(cfg['vistas'])} vistas")

    import recolector
    recolector.universe = lambda: list(syms)  # en la nube el universo lo da la configuracion
    antes = dict(recolector.read_state())
    try:
        recolector.run()
    except Exception as e:  # noqa: BLE001
        err("recolector", e)
    despues = recolector.read_state()
    hubo_cierre = despues.get("cierre") != antes.get("cierre")
    if despues.get("ultima_recogida") != antes.get("ultima_recogida"):
        u = despues.get("ultima_recogida") or {}
        log(f"recolector: {u.get('tipo')} {u.get('sesion')} {u.get('ok')}/{u.get('total')}")

    shutil.rmtree(os.path.join(ROOT, "salida"), ignore_errors=True)
    proxies = sorted({g.INDEX_PROXY[s] for s in syms if s in g.INDEX_PROXY})
    ok = fase_tickers(st, syms, proxies)
    fase_listas(st, cfg["listas"])
    fase_macro(st)
    fase_vistas(st, [s for s in syms if s in ok], cfg["vistas"], cfg["listas"])
    publicar_generales(st)
    esperar_subidas()
    guardar_estado(st, copia=hubo_cierre)
    subir(st, "pub/motor.json", {
        "ultimo_ciclo": g.now_ny().strftime("%Y-%m-%d %H:%M ET"), "segundos": round(time.time() - _t0, 1),
        "tickers": ok, "errores": _errores[-20:]})
    esperar_subidas()
    log(f"ciclo terminado: {len(ok)}/{len(syms)} tickers, {len(_errores)} errores")
    return 0 if ok else 1


def tickers(args: list[str]) -> int:
    """Calculo puntual: no toca el estado (solo lo lee) para no pisar al ciclo."""
    st = almacen.abrir()
    restaurar_estado(st)
    cfg = leer_config(st)
    syms = []
    for a in args:
        try:
            s = g.normalize(a)
        except ValueError:
            continue
        if s not in syms:
            syms.append(s)
    shutil.rmtree(os.path.join(ROOT, "salida"), ignore_errors=True)
    proxies = sorted({g.INDEX_PROXY[s] for s in syms if s in g.INDEX_PROXY})
    ok = fase_tickers(st, syms, proxies)
    fase_vistas_ticker = [s for s in syms if s in ok]
    os.environ["GEX_FIXTURE_DIR"] = FX
    g._cache.clear(); g._aux_cache.clear(); g._heat_cache.clear(); g._rate["t"] = 0.0
    for sym in fase_vistas_ticker:
        for v0 in cfg["vistas"]:
            v = vista_canon(v0, sym)
            args_ = dict(max_dte=_dte_arg(v["dte"]), window_pct=_rango_arg(v["range"]),
                         combine=v["combo"] == "1", positioning=v["pos"], model=v["model"])
            try:
                subir(st, f"pub/t/{sym}/niveles/{clave_niveles(v)}.json", g.compute(sym, **args_))
                subir(st, f"pub/t/{sym}/mapa/{clave_mapa(v)}.json", g.heatmap(sym, which=v["sess"], **args_))
            except Exception as e:  # noqa: BLE001
                err(f"{sym} vista", e)
    esperar_subidas()
    log(f"puntual: {len(fase_vistas_ticker)}/{len(syms)} tickers")
    return 0 if ok else 1


if __name__ == "__main__":
    modo = sys.argv[1] if len(sys.argv) > 1 else "ciclo"
    try:
        sys.exit(ciclo() if modo == "ciclo" else tickers(sys.argv[2:]) if modo == "ticker" else 2)
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        sys.exit(1)
