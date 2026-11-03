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
MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"]
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
        if summ.startswith("Gross Domestic Product"):
            kind = "avance" if "Advance" in summ else "2.ª est." if "Second" in summ else "3.ª est." if "Third" in summ else ""
            out.append({"date": dt.strftime("%Y-%m-%d"), "time": dt.strftime("%H:%M"), "name": f"PIB {kind}".strip(), "imp": 2})
        elif summ.startswith("Personal Income and Outlays"):
            out.append({"date": dt.strftime("%Y-%m-%d"), "time": dt.strftime("%H:%M"), "name": f"PCE ({_ref_month(dt)})", "imp": 3})
    return out


CENSUS = [("Advance Monthly Sales for Retail", "Ventas minoristas", 2), ("Advance Report on Durable Goods", "Bienes duraderos", 2),
          ("New Residential Construction", "Viviendas iniciadas", 1), ("New Residential Sales", "Venta de viviendas nuevas", 1)]


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
    (r"^CPI m/m", "IPC", 3), (r"^Core CPI m/m", None, 0), (r"^Non-Farm Employment Change", "Empleo (NFP)", 3),
    (r"^PPI m/m", "IPP", 2), (r"^ISM Manufacturing PMI", "ISM manufacturas", 2), (r"^ISM Services PMI", "ISM servicios", 2),
    (r"^Unemployment Claims", "Peticiones de desempleo", 1), (r"^(Prelim|Revised) UoM Consumer Sentiment", "Michigan", 1),
    (r"^JOLTS Job Openings", "JOLTS", 2), (r"^Retail Sales m/m", "Ventas minoristas", 2), (r"^Core PCE Price Index m/m", "PCE", 3),
    (r"^FOMC Statement", "FOMC", 3), (r"^(Advance|Prelim|Final) GDP q/q", "PIB", 2), (r"^FOMC Meeting Minutes", "Actas FOMC", 2),
    (r"^Fed Chair .* Speaks", "Habla el presidente de la Fed", 2), (r"^CB Consumer Confidence", "Confianza del consumidor", 1),
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
        if nm in ("IPC", "IPP", "Empleo (NFP)", "PCE", "Ventas minoristas", "JOLTS"):
            nm = f"{nm} ({_ref_month(ny, 2 if nm == 'JOLTS' else 1)})"
        out.append({"date": ny.strftime("%Y-%m-%d"), "time": ny.strftime("%H:%M"), "name": nm, "imp": name[1]})
    return out


FRED_RELEASES = {"Consumer Price Index": ("IPC", 3, 1), "Employment Situation": ("Empleo (NFP)", 3, 1),
                 "Producer Price Index": ("IPP", 2, 1), "Job Openings and Labor Turnover Survey": ("JOLTS", 2, 2),
                 "University of Michigan: Consumer Sentiment": ("Michigan", 1, None)}


def fred() -> list[dict]:
    key = os.environ.get("FRED_API_KEY")
    if not key:
        return []
    today = datetime.now(timezone.utc).date()
    url = ("https://api.stlouisfed.org/fred/releases/dates?file_type=json&include_release_dates_with_no_data=true"
           f"&limit=1000&sort_order=asc&realtime_start={today - timedelta(days=31)}&realtime_end={today + timedelta(days=370)}&api_key={key}")
    data = json.loads(_get(url))
    out = []
    for r in data.get("release_dates", []):
        hit = FRED_RELEASES.get(r.get("release_name"))
        if not hit:
            continue
        d = datetime.strptime(r["date"], "%Y-%m-%d")
        nm = hit[0] if hit[2] is None else f"{hit[0]} ({_ref_month(d, hit[2])})"
        out.append({"date": r["date"], "time": "08:30" if hit[0] != "Michigan" else "10:00", "name": nm, "imp": hit[1]})
    return out


# ---------------------------------------------------------------- union
def actualizar() -> tuple[list[dict], dict]:
    """Junta las fuentes, conserva lo visto antes (estado) y devuelve los eventos y un resumen por fuente."""
    prev = g.read_json(STATE, {}) or {}
    known = {f"{e['date']}|{e['name']}": e for e in prev.get("eventos", [])}
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
    lo = (datetime.now(timezone.utc) - timedelta(days=45)).strftime("%Y-%m-%d")
    hi = (datetime.now(timezone.utc) + timedelta(days=400)).strftime("%Y-%m-%d")
    evs = sorted((e for e in known.values() if lo <= e["date"] <= hi), key=lambda e: (e["date"], e["time"], -e["imp"]))
    g.write_json(STATE, {"eventos": evs, "fuentes": res, "actualizado": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")})
    return evs, res


def publicables() -> list[dict]:
    st = g.read_json(STATE, {}) or {}
    return st.get("eventos", [])


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
