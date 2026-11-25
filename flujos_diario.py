"""Nota diaria de flujos: paquete de datos y graficos del cierre en R2 (flujos/{F}/paquete.json, flujos/{F}/g/*.png,
flujos/ultimo.json) y la serie diaria flujos/_serie.json.gz (una fila por sesion con el AUM de los ETFs apalancados,
las cifras tal como se calcularon, la version del modelo y la tesis de la nota). Lo ejecuta flujos.yml al acabar el
historial diario; el texto lo escribe Claude Code con /take-flujos y el Worker guarda la tesis en flujos/{F}/tesis.json.
Fuentes: cadenas al cierre de hist500/ para los ETFs (se recalculan con el motor Perfil a la hora del cierre) y de
Tradier en directo para SPX, NDX y RUT (no estan en hist500), indice de niveles de hist500/_niveles/, cierres diarios
(CBOE o Tradier) y AUM de ProShares y Direxion. Calculos en flujos_calc.py, graficos en flujos_graficos.py.
Diseno en docs/FLUJOS.md.
Uso: python flujos_diario.py [--forzar] [--fecha YYYY-MM-DD]"""
from __future__ import annotations

import argparse
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timedelta

import numpy as np

import almacen
import flujos_calc as fc
import gex_engine as g
import report_semanal as rs

H = "hist500/"
SALIDA = "flujos/"
SERIE = SALIDA + "_serie.json.gz"
CALIB = SALIDA + "_calibracion.json"
SIMBOLOS = ["SPX", "SPY", "NDX", "QQQ", "RUT", "IWM"]
INDICE = "SPX"            # vol-control, CTAs y strikes de puts
POSICION, MODELO = "standard", "spotgamma"


def log(msg: str) -> None:
    print(msg, flush=True)


@contextmanager
def en_sesion(F: str):
    """El motor calcula con la hora de ahora: para una cadena guardada, el reloj se pone 20 min despues del cierre de
    F (las IV son las del cierre) y no se escribe nada en disco (flujo ni copias de la cadena)."""
    t = g.close_time(datetime.strptime(F, "%Y-%m-%d")) + timedelta(minutes=20)
    orig = (g.now_ny, g.flow_valid, g.save_chain_snapshot)
    g.now_ny = lambda: t
    g.flow_valid = lambda *a, **k: False
    g.save_chain_snapshot = lambda *a, **k: None
    try:
        yield
    finally:
        g.now_ny, g.flow_valid, g.save_chain_snapshot = orig


def calcular(sym: str, cadena: dict, F: str) -> dict:
    with en_sesion(F):
        g._cache[sym] = (time.time(), {"_min": cadena})
        try:
            return g.compute(sym, max_dte=fc.DEALERS_DTE, window_pct=5.0, model=MODELO, positioning=POSICION,
                             iv_term=True)
        finally:
            g._cache.pop(sym, None)


def _doc(st, sym, F):
    return almacen.get_json(st, f"{H}{sym}/{F}.json.gz")


def en_directo(sym: str, F: str) -> tuple[dict, dict]:
    """(resultado, cadena compacta) con la cadena de ahora (Tradier, CBOE de respaldo); solo si es de la sesion F."""
    g._cache.pop(sym, None)
    r = g.compute(sym, max_dte=fc.DEALERS_DTE, window_pct=5.0, model=MODELO, positioning=POSICION, force=True,
                  iv_term=True)
    if g.session_date(r["timestamp"]) != F:
        raise ValueError(f"la cadena de ahora es de {g.session_date(r['timestamp'])}, no de {F}")
    return r, g.chain_to_min(g.parse_chain(g._cache[g.normalize(sym)][1]))


def aum_etf(e: str) -> float | None:
    """AUM del ETF apalancado de la web de su emisor (ProShares o Direxion, como el report semanal)."""
    try:
        if fc.ETFS[e][3] == "proshares":
            return rs._aum_proshares(rs._get(rs.PROSHARES.format(s=e)))
        return rs._aum_direxion(rs._get(rs.DIREXION.format(s=e)))
    except Exception as ex:  # noqa: BLE001
        log(f"AUM {e}: {type(ex).__name__}: {str(ex)[:120]}")
        return None


def motor_calibracion(st, serie: dict, resultados: dict) -> dict:
    """{fecha: gamma por 1 % del motor del complejo S&P 500} en las fechas de fc.CALIBRACION. De la serie si la
    fila es de la version actual; si no (SPX no esta en hist500), SPY de ese dia recalculado de hist500 por el
    cociente (SPX + SPY) / SPY de hoy. Se guarda en flujos/_calibracion.json para no recalcular cada dia."""
    cache = almacen.get_json(st, CALIB) or {}
    out, cambio = {}, False
    for c in fc.CALIBRACION:
        f = c["fecha"]
        fila = serie.get(f) or {}
        if fila.get("modelo") == fc.VERSION and (x := (fila.get("complejos") or {}).get(c["complejo"])):
            out[f] = x["net"]
            continue
        if (k := cache.get(f)) and k.get("modelo") == fc.VERSION:
            out[f] = k["motor"]
            continue
        try:
            d = _doc(st, "SPY", f)
            if not d or not ("SPX" in resultados and "SPY" in resultados):
                raise ValueError("sin SPY de esa fecha o sin SPX y SPY de hoy")
            spy = calcular("SPY", d["chain"], f)["totals"]["net_per_pct"]
            hoy_spx, hoy_spy = (resultados[s]["totals"]["net_per_pct"] for s in ("SPX", "SPY"))
            out[f] = spy * (hoy_spx + hoy_spy) / hoy_spy
            cache[f] = {"modelo": fc.VERSION, "motor": out[f], "spy": spy, "cociente_hoy": (hoy_spx + hoy_spy) / hoy_spy,
                        "metodo": "SPY de esa fecha x (SPX + SPY) / SPY del dia en que se calculo"}
            cambio = True
        except Exception as e:  # noqa: BLE001
            log(f"calibracion {f}: {type(e).__name__}: {str(e)[:200]}")
    if cambio:
        almacen.put_json(st, CALIB, cache)
    return out


def _bloque(nombre, fn) -> dict:
    try:
        return {"estado": "ok", **fn()}
    except Exception as e:  # noqa: BLE001
        log(f"bloque {nombre}: {type(e).__name__}: {str(e)[:200]}")
        return {"estado": "ausente", "motivo": f"{type(e).__name__}: {str(e)[:200]}"}


def previas(F: str, serie: dict) -> list:
    """Filas de la serie anteriores a F calculadas con la version actual del modelo (las 252 ultimas)."""
    return [x for f, x in sorted(serie.items()) if f < F and x.get("modelo") == fc.VERSION][-252:]


def hist_net(filas: list) -> dict:
    """Gamma neta por 1 % de las sesiones anteriores, {simbolo o complejo: [...]}, de la serie: el indice de niveles
    de hist500 usa otro filtro de vencimientos (todos) y no es comparable."""
    por = {}
    for clave, nombres in (("dealers", SIMBOLOS), ("complejos", fc.COMPLEJOS)):
        for n in nombres:
            por[n] = [c["net"] for x in filas if (c := (x.get(clave) or {}).get(n)) and c.get("net") is not None]
    return por


def armar(st, F: str, serie: dict, aum=aum_etf, precios=rs.cierres_cboe, dibujar=True, directo=en_directo) -> tuple:
    """(paquete, {nombre: PNG}) de la sesion F: cadena guardada en hist500 si esta; si no, la de ahora."""
    resultados, cadenas = {}, {}
    for sym in SIMBOLOS:
        try:
            d = _doc(st, sym, F)
            if d and d.get("chain"):
                cadenas[sym] = d["chain"]
                resultados[sym] = calcular(sym, d["chain"], F)
            else:
                resultados[sym], cadenas[sym] = directo(sym, F)
        except Exception as e:  # noqa: BLE001
            log(f"{sym}: {type(e).__name__}: {str(e)[:200]}")

    def dealers():
        if not resultados:
            raise ValueError("Sin cadenas de ningun indice")
        por = {s: fc.dealers(r) for s, r in resultados.items()}
        b = {"simbolos": por, "complejos": fc.complejos(por)}
        esc = fc.escala_dealers(motor_calibracion(st, serie, resultados))
        if not esc:
            raise ValueError("Sin calibracion de la escala de los dealers")
        b["calibracion"] = esc
        return fc.escalar(b, esc["factor"])

    cierres_idx = precios(INDICE)
    aum_hist = {f: x["aum"] for f, x in serie.items() if x.get("aum")}

    def letf():
        a = {e: aum(e) for e in fc.ETFS}
        subs = sorted({v[0] for v in fc.ETFS.values()})
        return fc.letf(a, {s: v for s in subs if (v := precios(s))}, F, aum_hist)

    def strikes():
        if INDICE not in resultados:
            raise ValueError(f"Sin cadena de {INDICE}")
        t0 = np.datetime64(g.close_time(datetime.strptime(F, "%Y-%m-%d")), "m")
        return fc.strikes_puts(g.chain_from_min(cadenas[INDICE]), resultados[INDICE]["spot"], t0, g.risk_free())

    bloques = {"dealers": _bloque("dealers", dealers),
               "letf": _bloque("letf", letf),
               "vol_control": _bloque("vol_control", lambda: fc.vol_control(cierres_idx, F)),
               "cta": _bloque("cta", lambda: fc.cta(cierres_idx, F)),
               "strikes": _bloque("strikes", strikes)}
    ok = lambda k: bloques[k] if bloques[k]["estado"] == "ok" else None   # noqa: E731
    bloques["asimetria"] = _bloque("asimetria", lambda: fc.asimetria(
        (ok("dealers") or {}).get("complejos") or {}, ok("letf"), ok("vol_control")))
    paquete = {"version": 1, "modelo": fc.MODELO, "fecha": F,
               "siguiente_sesion": g.next_trading_day(datetime.strptime(F, "%Y-%m-%d")).strftime("%Y-%m-%d"),
               "generado": g.now_ny().strftime("%Y-%m-%d %H:%M ET"), "bloques": bloques}
    filas = previas(F, serie)
    paquete["destacados"] = fc.destacados(paquete, hist_net(filas),
                                          [(x.get("asim") or {}).get("cociente") for x in filas])
    fp = max((f for f in serie if f < F), default=None)
    paquete["previa"] = {"fecha": fp, **serie[fp]} if fp else None
    graficos = {}
    if dibujar:
        import flujos_graficos as fg
        graficos = fg.todos(paquete, resultados.get(INDICE))
    return paquete, graficos


def leer_serie(st) -> dict:
    return almacen.get_json(st, SERIE) or {}


def con_tesis(st, serie: dict, dias: int = 15) -> dict:
    """Anade a las ultimas filas la tesis que guardo el Worker al crear el borrador (flujos/{F}/tesis.json)."""
    for f in sorted(serie)[-dias:]:
        if not serie[f].get("tesis") and (t := almacen.get_json(st, f"{SALIDA}{f}/tesis.json")):
            serie[f]["tesis"] = t
    return serie


def publicar(st, paquete: dict, graficos: dict, serie: dict) -> None:
    F = paquete["fecha"]
    for nombre, png in graficos.items():
        st.put(f"{SALIDA}{F}/g/{nombre}.png", png, "image/png")
    st.put(f"{SALIDA}{F}/paquete.json", almacen.dumps(paquete), "application/json; charset=utf-8")
    st.put(f"{SALIDA}ultimo.json", almacen.dumps({"fecha": F}), "application/json; charset=utf-8")
    serie[F] = {**fc.fila_serie(paquete), **({"tesis": serie[F]["tesis"]} if serie.get(F, {}).get("tesis") else {})}
    almacen.put_json(st, SERIE, con_tesis(st, serie))


def main(args) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--forzar", action="store_true")
    ap.add_argument("--fecha", default=None)
    a = ap.parse_args(args)
    st = almacen.abrir()
    dias = rs.sesiones_guardadas(st)
    F = a.fecha or (dias[-1] if dias else None)
    if not F or F not in dias:
        raise SystemExit(f"Sin la sesion {F} en {H}_dias/")
    ult = (almacen.get_json(st, f"{SALIDA}ultimo.json") or {}).get("fecha")
    if ult and ult >= F and not a.forzar:
        log(f"{SALIDA}{F}/ ya estaba hecho; con --forzar se rehace")
        return 0
    serie = leer_serie(st)
    paquete, graficos = armar(st, F, serie)
    publicar(st, paquete, graficos, serie)
    for k, b in paquete["bloques"].items():
        log(f"{k}: {b['estado']}" + ("" if b["estado"] == "ok" else f" ({b['motivo']})"))
    log(f"destacados: {paquete['destacados']}")
    log(f"graficos: {sorted(graficos)}")
    log(f"{SALIDA}{F}/ listo")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
