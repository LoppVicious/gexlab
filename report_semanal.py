"""Report semanal: paquete de datos y graficos de la semana en R2 (report/{F}/paquete.json, report/{F}/g/*.png y
report/ultimo.json). Lo ejecuta report.yml (Actions); el texto lo escribe Claude Code con /report-semanal.
Lee hist500/ (niveles, cadenas al cierre, familia VIX), FRED (SP500, NASDAQ100) y las webs de ProShares y Direxion.
Calculos en report_calc.py; graficos en report_graficos.py. Spec: docs/superpowers/specs/2026-11-13-report-semanal-design.md
Uso: python report_semanal.py [--fecha YYYY-MM-DD]   (sin fecha: la ultima sesion guardada)"""
from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import sys
import urllib.request
from datetime import date, datetime, timedelta

import almacen
import gex_engine as g
import report_calc as rc

H = "hist500/"
SALIDA = "report/"
GAMMA = ["SPX", "NDX", "SPY", "QQQ", "IWM", "VIX"]
VOL_STRIKE = ["SPX", "SPY", "QQQ"]
POSICION, MODELO, FILTRO = "standard", "spotgamma", "all"
FRED_INDICES = {"SPX": "SP500", "NDX": "NASDAQ100"}
PROSHARES = "https://accounts.profunds.com/etfdata/ByFund/{s}-historical_nav.csv"
DIREXION = "https://www.direxion.com/holdings/{s}.csv"
EMISOR = {"TQQQ": "proshares", "SQQQ": "proshares", "QLD": "proshares", "UPRO": "proshares", "SPXU": "proshares",
          "SSO": "proshares", "SPXL": "direxion", "SOXL": "direxion", "SOXS": "direxion", "TNA": "direxion",
          "TZA": "direxion"}


def log(msg: str) -> None:
    print(msg, flush=True)


# ------------------------------------------------------------------ fuentes externas
def _get(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=25, context=g._SSL_CTXS[0]) as r:
        return r.read().decode("utf-8", "replace")


def fred_serie(serie: str) -> list:
    """Serie diaria completa de FRED: [(fecha, valor)] ascendente. Necesita FRED_API_KEY."""
    key = os.environ.get("FRED_API_KEY")
    if not key:
        raise RuntimeError("Falta FRED_API_KEY")
    d = json.loads(_get(f"https://api.stlouisfed.org/fred/series/observations?series_id={serie}"
                        f"&observation_start=1970-01-01&sort_order=asc&file_type=json&api_key={key}"))
    out = []
    for o in d.get("observations", []):
        try:
            out.append((o["date"], float(o["value"])))
        except (KeyError, ValueError):   # "." = sin dato
            pass
    return out


def _num(s: str) -> float:
    return float(re.sub(r"[^0-9.\-]", "", s))


def _aum_proshares(txt: str) -> float:
    filas = [f for f in csv.reader(io.StringIO(txt)) if f]
    i = next(i for i, f in enumerate(filas) if any("shares outstanding" in c.lower() for c in f))
    cab = [c.strip().lower() for c in filas[i]]
    datos = [f for f in filas[i + 1:] if len(f) == len(cab)]
    col = lambda nombre: next(j for j, c in enumerate(cab) if nombre in c)
    jf = col("date")
    ult = max(datos, key=lambda f: datetime.strptime(f[jf].strip(), "%m/%d/%Y"))
    if any("assets" in c for c in cab):
        return _num(ult[col("assets")])
    acciones = _num(ult[col("shares outstanding")])
    if "(000)" in cab[col("shares outstanding")]:
        acciones *= 1000
    return acciones * _num(ult[next(j for j, c in enumerate(cab) if c == "nav")])


def _aum_direxion(txt: str) -> float:
    """El CSV de cartera de Direxion no trae NAV: cada fila trae MarketValue y HoldingsPercent (% de los activos
    netos), asi que AUM = MarketValue x 100 / HoldingsPercent de la posicion mayor (la de menos error de redondeo)."""
    filas = [f for f in csv.reader(io.StringIO(txt)) if f]
    i = next(i for i, f in enumerate(filas) if "MarketValue" in f and "HoldingsPercent" in f)
    jv, jp = filas[i].index("MarketValue"), filas[i].index("HoldingsPercent")
    pos = [(_num(f[jv]), _num(f[jp])) for f in filas[i + 1:] if len(f) == len(filas[i])]
    mv, pct = max((p for p in pos if p[1] > 0), key=lambda p: p[0])
    return mv * 100 / pct


def aum_etf(sym: str) -> float | None:
    """Activos del ETF en dolares (participaciones x NAV) de la web del emisor; None si no se puede."""
    try:
        if EMISOR[sym] == "proshares":
            return _aum_proshares(_get(PROSHARES.format(s=sym)))
        return _aum_direxion(_get(DIREXION.format(s=sym)))
    except Exception as e:  # noqa: BLE001
        log(f"AUM {sym}: {type(e).__name__}: {str(e)[:120]}")
        return None


# ------------------------------------------------------------------ hist500
def sesiones_guardadas(st) -> list:
    rx = re.compile(r"(\d{4}-\d{2}-\d{2})\.json$")
    return sorted(m.group(1) for k in st.list(H + "_dias/") if (m := rx.search(k)))


def semana_de(dias: list, fecha: str | None) -> tuple:
    """(sesiones de la semana hasta fecha, ultima sesion de la semana anterior o None)."""
    hasta = [d for d in dias if fecha is None or d <= fecha]
    if not hasta:
        raise SystemExit("No hay sesiones guardadas en hist500/_dias/")
    F = date.fromisoformat(hasta[-1])
    lunes = (F - timedelta(days=F.weekday())).isoformat()
    previas = [d for d in hasta if d < lunes]
    return [d for d in hasta if d >= lunes], (previas[-1] if previas else None)


def _snap(levels) -> dict | None:
    try:
        return levels[POSICION][MODELO][FILTRO]
    except (KeyError, TypeError):
        return None


def _doc(st, sym, fecha):
    return almacen.get_json(st, f"{H}{sym}/{fecha}.json.gz") if fecha else None


def _indice(st, sym) -> dict:
    return almacen.get_json(st, f"{H}_niveles/{sym}.json.gz") or {}


def cierres_cboe(sym: str) -> list:
    """Cierres diarios de CBOE (desde 2004 en los ETFs grandes): [(fecha, cierre)] ascendente. hist500/_niveles
    solo tiene las sesiones desde que existe el historial, pocas para percentiles de un ano."""
    h = g.fetch_aux("historical", sym, ttl=0) or {}
    return sorted((r["date"], float(r["close"])) for r in h.get("data") or [] if r.get("date") and r.get("close"))


# ------------------------------------------------------------------ bloques
def _gamma(st, ses, previa):
    semanas, hist = {}, {}
    for sym in GAMMA:
        dias = [(d, s) for d in ses if (s := _snap((_doc(st, sym, d) or {}).get("levels")))]
        if not dias:
            continue
        sp = _snap((_doc(st, sym, previa) or {}).get("levels")) if previa else None
        semanas[sym] = {"previa": (previa, sp) if sp else None, "dias": dias}
        idx = _indice(st, sym)
        hist[sym] = [s["net_per_pct"] for f, lv in sorted(idx.items())[-253:]
                     if f < ses[-1] and (s := _snap(lv)) and s.get("net_per_pct") is not None]
    return rc.bloque_gamma(semanas, hist)


def _vol_real(st, ses, fred):
    hv = almacen.get_json(st, f"{H}_indices_vol/historico.json.gz") or {}
    vix = [(r[0], float(r[4])) for r in (hv.get("series") or {}).get("VIX", []) if r and r[4] is not None]
    if not vix:
        raise ValueError("Sin serie del VIX en hist500/_indices_vol/historico.json.gz")
    return rc.bloque_vol_real({k: fred(s) for k, s in FRED_INDICES.items()}, vix, ses)


def _etf(ses, aum, precios):
    activos = {e: aum(e) for e in rc.ETF_APAL}
    if not any(activos.values()):
        raise ValueError("Sin AUM de ningun ETF apalancado")
    subs = sorted({s for s, _ in rc.ETF_APAL.values()})
    spots = {s: [(f, c) for f, c in v if f <= ses[-1]] for s in subs if (v := precios(s))}
    return rc.bloque_etf(activos, spots, ses)


def _vol_strike(st, ses, previa):
    cadenas = {}
    for sym in VOL_STRIKE:
        a, b = _doc(st, sym, ses[-1]), _doc(st, sym, previa)
        if a and b and a.get("chain") and b.get("chain"):
            cadenas[sym] = (g.chain_from_min(a["chain"]), g.chain_from_min(b["chain"]))
    if not cadenas:
        raise ValueError("Sin cadenas de esta semana y de la anterior")
    return rc.bloque_vol_strike(cadenas, ses[-1])


def _bloque(nombre, fn) -> dict:
    try:
        return {"estado": "ok", **fn(), "graficos": []}
    except Exception as e:  # noqa: BLE001
        log(f"bloque {nombre}: {type(e).__name__}: {str(e)[:200]}")
        return {"estado": "ausente", "motivo": f"{type(e).__name__}: {str(e)[:200]}"}


def _dibujar(bloques) -> dict:
    import report_graficos as rg
    out = {}
    trabajos = []
    if bloques["gamma"]["estado"] == "ok":
        trabajos += [("gamma", f"gamma_{s.lower()}", lambda s=s, d=d: rg.gamma(s, d)) for s, d in bloques["gamma"]["datos"].items()]
    if bloques["vol_real"]["estado"] == "ok":
        trabajos += [("vol_real", f"vol_real_{s.lower()}", lambda s=s, d=d: rg.vol_real(s, d)) for s, d in bloques["vol_real"]["datos"].items()]
    if bloques["vol_strike"]["estado"] == "ok":
        trabajos += [("vol_strike", f"vol_strike_{s.lower()}", lambda s=s, d=d: rg.vol_strike(s, d)) for s, d in bloques["vol_strike"]["datos"].items()]
    if bloques["etf_apal"]["estado"] == "ok":
        trabajos.append(("etf_apal", "etf_apal", lambda d=bloques["etf_apal"]["datos"]: rg.etf(d)))
    for bloque, nombre, fn in trabajos:
        try:
            out[nombre] = fn()
            bloques[bloque]["graficos"].append(nombre)
        except Exception as e:  # noqa: BLE001
            log(f"grafico {nombre}: {type(e).__name__}: {str(e)[:200]}")
    return out


def armar(st, fecha=None, fred=fred_serie, aum=aum_etf, precios=cierres_cboe, dibujar=True) -> tuple:
    """(paquete, {nombre: bytes PNG}) de la semana que acaba en fecha (o en la ultima sesion guardada)."""
    ses, previa = semana_de(sesiones_guardadas(st), fecha)
    bloques = {
        "gamma": _bloque("gamma", lambda: _gamma(st, ses, previa)),
        "vol_real": _bloque("vol_real", lambda: _vol_real(st, ses, fred)),
        "etf_apal": _bloque("etf_apal", lambda: _etf(ses, aum, precios)),
        "vol_strike": _bloque("vol_strike", lambda: _vol_strike(st, ses, previa)),
    }
    graficos = _dibujar(bloques) if dibujar else {}
    paquete = {"version": 1, "fecha": ses[-1], "sesiones": ses, "previa": previa,
               "generado": g.now_ny().strftime("%Y-%m-%d %H:%M ET"), "bloques": bloques}
    return paquete, graficos


def publicar(st, paquete: dict, graficos: dict) -> None:
    F = paquete["fecha"]
    for nombre, png in graficos.items():
        st.put(f"{SALIDA}{F}/g/{nombre}.png", png, "image/png")
    st.put(f"{SALIDA}{F}/paquete.json", almacen.dumps(paquete), "application/json; charset=utf-8")
    st.put(f"{SALIDA}ultimo.json", almacen.dumps({"fecha": F}), "application/json; charset=utf-8")


def main(args) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fecha", default=None)
    a = ap.parse_args(args)
    st = almacen.abrir()
    paquete, graficos = armar(st, a.fecha or None)
    publicar(st, paquete, graficos)
    for k, b in paquete["bloques"].items():
        log(f"{k}: {b['estado']}" + (f", destacado={b['destacado']}, {len(b['graficos'])} graficos" if b["estado"] == "ok" else f" ({b['motivo']})"))
    log(f"report/{paquete['fecha']}/ listo")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
