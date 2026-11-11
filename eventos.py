"""
GEX Lab - calendario macro de EE. UU. para marcar los eventos sobre la estructura temporal de volatilidad.

Fuentes (todas publicas):
  - Reserva Federal: reuniones del FOMC (pagina del calendario)
  - BEA: PIB y renta/gasto personal (PCE), calendario ICS oficial
  - Census: ventas minoristas, bienes duraderos, construccion y venta de viviendas (calendario oficial)
  - ForexFactory: la semana en curso (IPC, empleo, IPP, ISM, Michigan, peticiones de desempleo...). Las semanas
    ya vistas se conservan en el estado, asi que el historico se va completando solo.
  - FRED (opcional, con FRED_API_KEY): fechas futuras exactas de IPC, empleo, IPP, JOLTS, etc.
Publica pub/eventos.json: [{date, time, name, imp}] desde hace 30 dias hasta un ano vista.
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
VERSION = 3  # al cambiar las fuentes o las etiquetas, se fuerza una actualizacion y se descarta lo guardado con otra version
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


FF_NAMES = [
    (r"^CPI m/m", "CPI", 3), (r"^Core CPI m/m", None, 0), (r"^Non-Farm Employment Change", "Payrolls (NFP)", 3),
    (r"^PPI m/m", "PPI", 2), (r"^ISM Manufacturing PMI", "ISM manufacturing", 2), (r"^ISM Services PMI", "ISM services", 2),
    (r"^Unemployment Claims", "Jobless claims", 1), (r"^(Prelim|Revised) UoM Consumer Sentiment", "Michigan", 1),
    (r"^JOLTS Job Openings", "JOLTS", 2), (r"^Retail Sales m/m", "Retail sales", 2), (r"^Core PCE Price Index m/m", "PCE", 3),
    (r"^FOMC Statement", "FOMC", 3), (r"^(Advance|Prelim|Final) GDP q/q", "GDP", 2), (r"^FOMC Meeting Minutes", "FOMC minutes", 2),
    (r"^Fed Chair .* Speaks", "Fed Chair speaks", 2), (r"^CB Consumer Confidence", "Consumer confidence", 1),
]


def forexfactory() -> list[dict]:
    data = json.loads(_get("https://nfs.faireconomy.media/ff_calendar_thisweek.json"))
    out = []
    for e in data:
        if e.get("country") != "USD":
            continue
        name = next(((n, i) for rx, n, i in FF_NAMES if re.search(rx, e.get("title", ""))), None)
        if not name or not name[0]:
            continue
        try:
            dt = datetime.fromisoformat(e["date"])
        except (KeyError, ValueError):
            continue
        ny = _ny(dt)
        nm = name[0]
        if nm in ("CPI", "PPI", "Payrolls (NFP)", "PCE", "Retail sales", "JOLTS"):
            nm = f"{nm} ({_ref_month(ny, 2 if nm == 'JOLTS' else 1)})"
        out.append({"date": ny.strftime("%Y-%m-%d"), "time": ny.strftime("%H:%M"), "name": nm, "imp": name[1]})
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
