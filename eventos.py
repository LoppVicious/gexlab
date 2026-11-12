"""
GEX Lab - calendario macro: eventos de EE. UU. para la estructura temporal de volatilidad y la Validacion, y los
de los paises grandes para la pagina Calendar, con dato real (actual), consenso (forecast) y anterior (previous).

Fuentes (todas publicas):
  - Nasdaq (principal): calendario economico por dia con actual, consenso y anterior de 20 paises; se usan 11.
    Cubre de 7 dias atras a 21 adelante. La importancia la pone la tabla IMPORTANCIA (Nasdaq no la da).
  - Reserva Federal: reuniones del FOMC (pagina del calendario), para el futuro lejano
  - BEA: PIB y renta/gasto personal (PCE), calendario ICS oficial
  - Census: ventas minoristas, bienes duraderos, construccion y venta de viviendas (calendario oficial)
  - FRED (opcional, con FRED_API_KEY): fechas futuras exactas de IPC, empleo, IPP, JOLTS, etc.
Misma fecha, pais y etiqueta: gana la ultima fuente (Nasdaq va al final).
Publica pub/eventos.json (EE. UU.), pub/calendario.json (11 paises) y pub/eventos_horas.json (avisos).
"""
from __future__ import annotations

import json
import os
import re
import urllib.request
from datetime import datetime, timedelta, timezone

import gex_engine as g

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/130.0 Safari/537.36")
STATE = os.path.join(g.CACHE_DIR, "eventos.json")
GUARDAR_ANOS = 3
VERSION = 4  # al cambiar las fuentes o las etiquetas, se fuerza una actualizacion y se descarta lo guardado con otra version
MESES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
MONTHS = {m: i + 1 for i, m in enumerate(["January", "February", "March", "April", "May", "June", "July",
                                           "August", "September", "October", "November", "December"])}


def _get(url: str, timeout: int = 25) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"})
    with urllib.request.urlopen(req, timeout=timeout, context=g._SSL_CTXS[0]) as r:
        return r.read().decode("utf-8", "replace")


def _ny(dt_utc: datetime) -> datetime:
    """Hora UTC (con o sin zona) -> hora de Nueva York sin zona."""
    dt_utc = dt_utc.replace(tzinfo=timezone.utc) if dt_utc.tzinfo is None else dt_utc.astimezone(timezone.utc)
    return (dt_utc + g._ny_offset(dt_utc)).replace(tzinfo=None)


def _ref_month(d: datetime, back: int = 1) -> str:
    m = (d.month - 1 - back) % 12
    return MESES[m]


# ---------------------------------------------------------------- fuentes
def fomc() -> list[dict]:
    t = _get("https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm")
    out = []
    parts = re.split(r"(\d{4}) FOMC Meetings", t)
    for i in range(1, len(parts) - 1, 2):
        year, body = int(parts[i]), parts[i + 1]
        for mon, days in re.findall(r'fomc-meeting__month[^>]*>\s*<strong>([A-Za-z/]+)</strong>.*?fomc-meeting__date[^>]*>\s*([\d\-\s*]+)', body, re.S):
            last_mon = mon.split("/")[-1]
            mm = next((v for k, v in MONTHS.items() if k.startswith(last_mon[:3])), None)
            nums = re.findall(r"\d+", days)
            if not mm or not nums:
                continue
            try:
                d = datetime(year, mm, int(nums[-1]))
            except ValueError:
                continue
            out.append({"date": d.strftime("%Y-%m-%d"), "time": "14:00", "name": "FOMC", "imp": 3})
    return out


def bea() -> list[dict]:
    t = _get("https://www.bea.gov/news/schedule/ics/online-calendar-subscription.ics")
    out = []
    for ev in t.split("BEGIN:VEVENT")[1:]:
        s = re.search(r"SUMMARY:(.+?)\r?\n(?! )", ev, re.S)
        d = re.search(r"DTSTART[^:]*:(\d{8}T\d{6})Z?", ev)
        if not s or not d:
            continue
        summ = s.group(1).replace("\\,", ",").replace("\r\n ", "").replace("\n ", "")
        dt = _ny(datetime.strptime(d.group(1), "%Y%m%dT%H%M%S"))
        if summ.startswith(("Gross Domestic Product", "GDP")):
            kind = "advance" if "Advance" in summ else "2nd est." if "Second" in summ else "3rd est." if "Third" in summ else ""
            out.append({"date": dt.strftime("%Y-%m-%d"), "time": dt.strftime("%H:%M"), "name": f"GDP {kind}".strip(), "imp": 2})
        elif summ.startswith("Personal Income and Outlays"):
            out.append({"date": dt.strftime("%Y-%m-%d"), "time": dt.strftime("%H:%M"), "name": f"PCE ({_ref_month(dt)})", "imp": 3})
    return out


CENSUS = [("Advance Monthly Sales for Retail", "Retail sales", 2), ("Advance Report on Durable Goods", "Durable goods", 2),
          ("New Residential Construction", "Housing starts", 1), ("New Residential Sales", "New home sales", 1)]


def census() -> list[dict]:
    t = _get("https://www.census.gov/economic-indicators/calendar-listview.html")
    out = []
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", t, re.S):
        txt = re.sub(r"<[^>]+>", " ", row)
        txt = re.sub(r"\s+", " ", txt).strip()
        lab = next((c for c in CENSUS if c[0].lower() in txt.lower()), None)
        if not lab:
            continue
        m = re.search(r"([A-Z][a-z]+)\.? (\d{1,2}), (\d{4})", txt)
        if not m:
            continue
        mm = next((v for k, v in MONTHS.items() if k.startswith(m.group(1)[:3])), None)
        if not mm:
            continue
        tm = re.search(r"(\d{1,2}):(\d{2}) ?([AP])\.?M", txt, re.I)
        hh = "08:30" if not tm else f"{(int(tm.group(1)) % 12) + (12 if tm.group(3).upper() == 'P' else 0):02d}:{tm.group(2)}"
        out.append({"date": f"{m.group(3)}-{mm:02d}-{int(m.group(2)):02d}", "time": hh, "name": lab[1], "imp": lab[2]})
    return out


# id de cada publicacion en FRED: (etiqueta, importancia, meses de retraso del dato)
FRED_RELEASES = {10: ("CPI", 3, 1), 50: ("Payrolls (NFP)", 3, 1), 46: ("PPI", 2, 1), 192: ("JOLTS", 2, 2),
                 91: ("Michigan", 1, None), 180: ("Jobless claims", 1, None)}


def fred() -> list[dict]:
    """Fechas de publicacion (pasadas recientes y futuras programadas) de cada indicador, una consulta por indicador."""
    key = os.environ.get("FRED_API_KEY")
    if not key:
        return []
    today = datetime.now(timezone.utc).date()
    out = []
    for rid, (name, imp, lag) in FRED_RELEASES.items():
        url = ("https://api.stlouisfed.org/fred/release/dates?file_type=json&include_release_dates_with_no_data=true"
               f"&sort_order=asc&limit=200&realtime_start={today - timedelta(days=31)}&realtime_end=9999-12-31"
               f"&release_id={rid}&api_key={key}")
        data = json.loads(_get(url))
        for r in data.get("release_dates", []):
            d = datetime.strptime(r["date"], "%Y-%m-%d")
            if d.date() > today + timedelta(days=400):
                continue
            nm = name if lag is None else f"{name} ({_ref_month(d, lag)})"
            out.append({"date": r["date"], "time": "10:00" if name in ("Michigan", "JOLTS") else "08:30", "name": nm, "imp": imp})
    return out


# ---------------------------------------------------------------- Nasdaq
NASDAQ_URL = "https://api.nasdaq.com/api/calendar/economicevents?date={}"
PAISES = {"United States": "US", "Euro Zone": "EZ", "Germany": "DE", "France": "FR", "Italy": "IT",
          "United Kingdom": "GB", "Japan": "JP", "China": "CN", "Canada": "CA", "Australia": "AU", "Switzerland": "CH"}
# (pais, regex anclado sobre eventName, importancia, etiqueta o None, meses de retraso del dato o None).
# Lo que no esta aqui: importancia 1 y el nombre de Nasdaq. Las etiquetas de EE. UU. son las de siempre (Summary,
# estructura de volatilidad, Validacion). (*) sin ver aun en datos reales de Nasdaq: patron provisional.
IMPORTANCIA = [
    ("US", r"^Fed Interest Rate Decision$", 3, "FOMC", None),
    ("US", r"^FOMC Press Conference$", 3, None, None),
    ("US", r"^CPI$", 3, "CPI", 1),
    ("US", r"^Nonfarm Payrolls$", 3, "Payrolls (NFP)", 1),  # (*)
    ("US", r"^(Core PCE Price Index|PCE price index)$", 3, "PCE", 1),
    ("US", r"^PPI$", 2, "PPI", 1),
    ("US", r"^Retail Sales$", 2, "Retail sales", 1),
    ("US", r"^GDP$", 2, "GDP", None),
    ("US", r"^ISM Manufacturing PMI$", 2, "ISM manufacturing", None),
    ("US", r"^ISM Non-Manufacturing PMI$", 2, "ISM services", None),
    ("US", r"^JOLTS Job Openings$", 2, "JOLTS", 2),
    ("US", r"^FOMC Meeting Minutes$", 2, "FOMC minutes", None),
    ("US", r"^Fed Chair .* Speaks$", 2, "Fed Chair speaks", None),
    ("US", r"^Durable Goods Orders$", 2, "Durable goods", None),
    ("US", r"^CB Consumer Confidence$", 2, "Consumer confidence", None),
    ("US", r"^Michigan Consumer Sentiment", 2, "Michigan", None),  # (*)
    ("US", r"^Initial Jobless Claims$", 1, "Jobless claims", None),
    ("US", r"^Housing Starts$", 1, "Housing starts", None),
    ("US", r"^New Home Sales$", 1, "New home sales", None),
    ("EZ", r"^ECB Interest Rate Decision$", 3, None, None),
    ("EZ", r"^ECB Press Conference$", 3, None, None),
    ("EZ", r"^CPI$", 3, None, None),
    ("EZ", r"^Core CPI$", 2, None, None),
    ("EZ", r"^ECB President Lagarde Speaks$", 2, None, None),
    ("EZ", r"^HCOB Eurozone Composite PMI$", 2, None, None),
    ("EZ", r"^ZEW Economic Sentiment$", 2, None, None),
    ("EZ", r"^GDP$", 2, None, None),  # (*)
    ("DE", r"^German CPI$", 2, None, None),
    ("DE", r"^German Ifo Business Climate Index$", 2, None, None),
    ("DE", r"^German ZEW Economic Sentiment$", 2, None, None),
    ("DE", r"^HCOB Germany (Manufacturing|Services) PMI$", 2, None, None),
    ("FR", r"^French CPI$", 2, None, None),
    ("IT", r"^Italian CPI$", 2, None, None),
    ("GB", r"^BoE Interest Rate Decision$", 3, None, None),
    ("GB", r"^CPI$", 3, None, None),
    ("GB", r"^GDP$", 2, None, None),
    ("GB", r"^Unemployment Rate$", 2, None, None),
    ("GB", r"^BoE Gov Bailey Speaks$", 2, None, None),
    ("GB", r"^S&P Global (Services|Manufacturing) PMI$", 2, None, None),
    ("JP", r"^BoJ Interest Rate Decision$", 3, None, None),
    ("JP", r"^(National|Tokyo) CPI$", 2, None, None),
    ("JP", r"^GDP$", 2, None, None),
    ("JP", r"^Reuters Tankan Index$", 2, None, None),
    ("CN", r"^(CPI|GDP|Industrial Production|Retail Sales|RatingDog Manufacturing PMI)$", 2, None, None),
    ("CA", r"^BoC Interest Rate Decision$", 3, None, None),
    ("CA", r"^(CPI|BOC Press Conference)$", 2, None, None),
    ("AU", r"^RBA Interest Rate Decision$", 3, None, None),
    ("AU", r"^(CPI|Monthly CPI Indicator|Employment Change|Unemployment Rate)$", 2, None, None),
    ("CH", r"^SNB Monetary Policy Assessment$", 3, None, None),
    ("CH", r"^CPI$", 2, None, None),
]


def _valor(s) -> str | None:
    s = str(s or "").replace("&nbsp;", " ").strip()
    return s or None


def nasdaq_fila(r: dict, d: datetime) -> dict | None:
    """Fila de Nasdaq -> evento, o None si el pais no interesa. La hora ('gmt') ya viene en hora de Nueva York."""
    pais = PAISES.get(r.get("country"))
    nombre = _valor(r.get("eventName"))
    if not pais or not nombre:
        return None
    hora = _valor(r.get("gmt")) or ""
    hora = hora if re.fullmatch(r"\d{2}:\d{2}", hora) else ""
    imp, nm = 1, nombre
    for p, rx, i, etiqueta, retraso in IMPORTANCIA:
        if p == pais and re.search(rx, nombre):
            imp = i
            if etiqueta:
                nm = etiqueta if retraso is None else f"{etiqueta} ({_ref_month(d, retraso)})"
            break
    return {"date": d.strftime("%Y-%m-%d"), "time": hora, "name": nm, "country": pais, "imp": imp,
            "actual": _valor(r.get("actual")), "forecast": _valor(r.get("consensus")), "previous": _valor(r.get("previous"))}


def nasdaq_dia(d: datetime) -> list[dict]:
    req = urllib.request.Request(NASDAQ_URL.format(d.strftime("%Y-%m-%d")),
                                 headers={"User-Agent": UA, "Accept": "application/json", "Accept-Language": "en-US,en;q=0.9"})
    with urllib.request.urlopen(req, timeout=25, context=g._SSL_CTXS[0]) as r:
        data = json.loads(r.read().decode("utf-8", "replace"))
    filas = ((data or {}).get("data") or {}).get("rows") or []
    return [e for e in (nasdaq_fila(f, d) for f in filas) if e]


# ---------------------------------------------------------------- union
def actualizar() -> tuple[list[dict], dict]:
    """Junta las fuentes, conserva lo visto antes (estado) y devuelve los eventos y un resumen por fuente."""
    prev = g.read_json(STATE, {}) or {}
    # lo guardado con otra version (otras etiquetas) se descarta: si no, quedarian eventos repetidos con el nombre viejo
    known = {f"{e['date']}|{e['name']}": e for e in prev.get("eventos", [])} if prev.get("version") == VERSION else {}
    res = {}
    for name, fn in (("fomc", fomc), ("bea", bea), ("census", census), ("forexfactory", forexfactory), ("fred", fred)):
        try:
            evs = fn()
            res[name] = len(evs)
            for e in evs:
                # la misma publicacion con otra etiqueta de mes: se queda la mas reciente
                base = e["name"].split(" (")[0]
                for k in [k for k in known if k.startswith(e["date"] + "|" + base)]:
                    known.pop(k)
                known[f"{e['date']}|{e['name']}"] = e
        except Exception as ex:  # noqa: BLE001
            res[name] = f"error: {str(ex)[:80]}"
    # lo pasado se guarda GUARDAR_ANOS (la Validacion marca con ello los dias de evento); la web recibe 45 dias
    lo = (datetime.now(timezone.utc) - timedelta(days=365 * GUARDAR_ANOS)).strftime("%Y-%m-%d")
    hi = (datetime.now(timezone.utc) + timedelta(days=400)).strftime("%Y-%m-%d")
    evs = sorted((e for e in known.values() if lo <= e["date"] <= hi), key=lambda e: (e["date"], e["time"], -e["imp"]))
    g.write_json(STATE, {"eventos": evs, "fuentes": res, "version": VERSION,
                         "actualizado": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")})
    return evs, res


def publicables() -> list[dict]:
    st = g.read_json(STATE, {}) or {}
    lo = (datetime.now(timezone.utc) - timedelta(days=45)).strftime("%Y-%m-%d")
    return [e for e in st.get("eventos", []) if e["date"] >= lo]


if __name__ == "__main__":
    import sys
    if "--census" in sys.argv:
        t = _get("https://www.census.gov/economic-indicators/calendar-listview.html")
        rows = [re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", r)).strip() for r in re.findall(r"<tr[^>]*>(.*?)</tr>", t, re.S)]
        print(len(rows)); print("\n".join(rows[:25]))
    evs, res = actualizar()
    print(res)
    for e in evs[:60]:
        print(e)
