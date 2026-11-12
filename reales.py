"""
GEX Lab - dato real (actual) de los indicadores de EE. UU. del calendario.

  - BLS (API v2, BLS_API_KEY opcional: sin clave, 25 consultas al dia): CPI, nominas, paro, salario por hora, PPI y
    JOLTS, en el minuto de la publicacion.
  - FRED (FRED_API_KEY): el resto; tarda de 3 min a 2 h segun la serie (medido el 2026-11-12).
Un dato es el nuevo solo si la ultima observacion es del periodo esperado (mes del evento menos el retraso,
trimestre de hace 3 meses, o semana que acaba como mucho 7 dias antes): la fecha de vigencia de FRED cambia con
las revisiones y no sirve. Se escribe con los decimales y el sufijo del previous (o forecast) de ForexFactory.
"""
from __future__ import annotations

import json
import os
import re
import urllib.request
from datetime import date, datetime, timedelta

import gex_engine as g

# titulo de ForexFactory -> (fuente, serie, calculo, unidad base, periodicidad, retraso en meses).
# calculo: mm (% mensual), yy (% anual), dif (diferencia), nivel. Unidad base: lo que vale 1 en la serie
# (1000 = la serie va en miles). Periodicidad: M mensual, Q trimestral, W semanal.
REALES = [
    (r"^CPI m/m$", "bls", "CUSR0000SA0", "mm", 1, "M", 1),
    (r"^Core CPI m/m$", "bls", "CUSR0000SA0L1E", "mm", 1, "M", 1),
    (r"^CPI y/y$", "bls", "CUUR0000SA0", "yy", 1, "M", 1),
    (r"^Core CPI y/y$", "bls", "CUUR0000SA0L1E", "yy", 1, "M", 1),
    (r"^Non-Farm Employment Change$", "bls", "CES0000000001", "dif", 1000, "M", 1),
    (r"^Unemployment Rate$", "bls", "LNS14000000", "nivel", 1, "M", 1),
    (r"^Average Hourly Earnings m/m$", "bls", "CES0500000003", "mm", 1, "M", 1),
    (r"^PPI m/m$", "bls", "WPSFD4", "mm", 1, "M", 1),
    (r"^Core PPI m/m$", "bls", "WPSFD49104", "mm", 1, "M", 1),  # demanda final sin alimentos ni energia (= FRED PPIFES)
    (r"^JOLTS Job Openings$", "bls", "JTS000000000000000JOL", "nivel", 1000, "M", None),  # mes del dato: 1 atras si sale el dia 20 o despues, si no 2
    (r"^Retail Sales m/m$", "fred", "RSAFS", "mm", 1, "M", 1),
    (r"^Core Retail Sales m/m$", "fred", "RSFSXMV", "mm", 1, "M", 1),
    (r"^Core PCE Price Index m/m$", "fred", "PCEPILFE", "mm", 1, "M", 1),
    (r"^PCE Price Index m/m$", "fred", "PCEPI", "mm", 1, "M", 1),
    (r"^Unemployment Claims$", "fred", "ICSA", "nivel", 1, "W", 0),
    (r"^Advance GDP q/q$", "fred", "A191RL1Q225SBEA", "nivel", 1, "Q", 3),
    (r"^Durable Goods Orders m/m$", "fred", "DGORDER", "mm", 1, "M", 1),
    (r"^Core Durable Goods Orders m/m$", "fred", "ADXTNO", "mm", 1, "M", 1),
    (r"^Housing Starts$", "fred", "HOUST", "nivel", 1000, "M", 1),
    (r"^Building Permits$", "fred", "PERMIT", "nivel", 1000, "M", 1),
    (r"^New Home Sales$", "fred", "HSN1F", "nivel", 1000, "M", 1),
    (r"^Existing Home Sales$", "fred", "EXHOSLUSM495S", "nivel", 1, "M", 1),
]
SUFIJOS = {"": 1, "%": 1, "K": 1e3, "M": 1e6, "B": 1e9, "T": 1e12}


def regla(titulo: str) -> tuple | None:
    """(fuente, serie, calculo, unidad base, periodicidad, retraso) del titulo, o None si no hay dato real."""
    return next((x[1:] for x in REALES if re.search(x[0], titulo or "")), None)


def formato(v: float, muestra: str | None) -> str | None:
    """Valor (en unidades) con los decimales, separador de miles y sufijo de la muestra ('0.6%', '119K', '1,288K')."""
    m = re.fullmatch(r"-?([\d,]*)\.?(\d*)\s*([%KMBT]?)", str(muestra or "").strip())
    if not m or not (m.group(1) or m.group(2)):
        return None
    dec, suf = len(m.group(2)), m.group(3)
    x = round(v / SUFIJOS[suf], dec) + 0.0
    txt = f"{x:,.{dec}f}" if "," in m.group(1) else f"{x:.{dec}f}"
    return txt.removeprefix("-") + suf if float(txt.replace(",", "")) == 0 else txt + suf


def _mes(d: date, n: int) -> date:
    """Primer dia del mes n meses antes de d."""
    y, m = divmod(d.year * 12 + d.month - 1 - n, 12)
    return date(y, m + 1, 1)


def _es_nuevo(fecha: date, per: str, retraso: int | None, obs: date) -> bool:
    if per == "W":
        return fecha - timedelta(days=7) <= obs < fecha
    if per == "Q":
        m = _mes(fecha, 3)
        return obs == date(m.year, (m.month - 1) // 3 * 3 + 1, 1)
    if retraso is None:  # JOLTS: sale a principios de mes (dato de hace 2) o a finales (dato del mes anterior)
        retraso = 1 if fecha.day >= 20 else 2
    return obs == _mes(fecha, retraso)


def actual(e: dict, obs: list[tuple[date, float]]) -> str | None:
    """Dato real del evento con las observaciones de su serie (de la mas reciente a la mas antigua), o None."""
    rg = regla(e.get("titulo") or e.get("name"))
    if not rg or not obs:
        return None
    _, _, calc, base, per, retraso = rg
    if not _es_nuevo(date.fromisoformat(e["date"]), per, retraso, obs[0][0]):
        return None
    v0 = obs[0][1]
    if calc in ("mm", "dif") and (len(obs) < 2 or obs[1][0] != _mes(obs[0][0], 1)):
        return None  # falta el mes anterior
    if calc == "mm":
        v = (v0 / obs[1][1] - 1) * 100
    elif calc == "yy":
        hace = next((x for d, x in obs if d == _mes(obs[0][0], 12)), None)
        if hace is None:
            return None
        v = (v0 / hace - 1) * 100
    elif calc == "dif":
        v = (v0 - obs[1][1]) * base
    elif calc == "nivel":
        v = v0 * base
    else:
        return None
    muestras = [m for m in (e.get("previous"), e.get("forecast")) if formato(0, m)]
    return formato(v, max(muestras, key=lambda m: len(m.split(".")[1].rstrip("%KMBT ")) if "." in m else 0, default=None))


# ---------------------------------------------------------------- descargas
def _bls(series: list[str]) -> dict[str, list[tuple[date, float]]]:
    year = datetime.now().year
    body = {"seriesid": series, "startyear": str(year - 2), "endyear": str(year)}
    if os.environ.get("BLS_API_KEY"):
        body["registrationkey"] = os.environ["BLS_API_KEY"]
    req = urllib.request.Request("https://api.bls.gov/publicAPI/v2/timeseries/data/", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30, context=g._SSL_CTXS[0]) as r:
        d = json.loads(r.read().decode("utf-8"))
    if d.get("status") != "REQUEST_SUCCEEDED":
        raise RuntimeError(f"BLS: {d.get('status')} {d.get('message')}")
    out = {}
    for s in (d.get("Results") or {}).get("series", []):
        obs = []
        for o in s.get("data") or []:
            if re.fullmatch(r"M(0[1-9]|1[0-2])", o.get("period", "")):
                try:
                    obs.append((date(int(o["year"]), int(o["period"][1:]), 1), float(o["value"])))
                except (KeyError, ValueError):
                    pass
        out[s["seriesID"]] = sorted(obs, reverse=True)
    return out


def _fred(serie: str) -> list[tuple[date, float]]:
    key = os.environ.get("FRED_API_KEY")
    if not key:
        return []
    url = (f"https://api.stlouisfed.org/fred/series/observations?series_id={serie}&sort_order=desc&limit=30"
           f"&file_type=json&api_key={key}")
    with urllib.request.urlopen(url, timeout=25, context=g._SSL_CTXS[0]) as r:
        d = json.loads(r.read().decode("utf-8"))
    obs = []
    for o in d.get("observations", []):
        try:
            obs.append((date.fromisoformat(o["date"]), float(o["value"])))
        except (KeyError, ValueError):  # "." = sin dato
            pass
    return obs


def rellenar(evs: list[dict]) -> int:
    """Pone e['actual'] a los eventos que ya lo tienen publicado. Una peticion a BLS y una por serie de FRED."""
    reglas = [(e, regla(e.get("titulo") or e.get("name"))) for e in evs]
    reglas = [(e, rg) for e, rg in reglas if rg]
    errores, datos = [], {}
    bls = sorted({rg[1] for _, rg in reglas if rg[0] == "bls"})
    try:
        datos = _bls(bls) if bls else {}
    except Exception as ex:  # noqa: BLE001  una fuente caida no bloquea a la otra
        errores.append(ex)
    for s in sorted({rg[1] for _, rg in reglas if rg[0] == "fred"}):
        try:
            datos[s] = _fred(s)
        except Exception as ex:  # noqa: BLE001
            errores.append(ex)
    if errores and not any(datos.values()):
        raise RuntimeError(str(errores[0]))
    n = 0
    for e, rg in reglas:
        v = actual(e, datos.get(rg[1]) or [])
        if v:
            e["actual"] = v
            n += 1
    return n
