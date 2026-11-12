"""
GEX Lab - calendario macro: eventos de EE. UU. para la estructura temporal de volatilidad y la Validacion, y los
de los paises grandes para la pagina Calendar, con dato real (actual), consenso (forecast) y anterior (previous).

Fuentes (todas publicas):
  - ForexFactory: la semana en curso de las divisas grandes con importancia, forecast y previous (sin dato real).
    Limita peticiones: como mucho una por hora. Las semanas ya vistas se conservan en el estado.
  - Reserva Federal: reuniones del FOMC (pagina del calendario), para el futuro lejano
  - BEA: PIB y renta/gasto personal (PCE), calendario ICS oficial
  - Census: ventas minoristas, bienes duraderos, construccion y venta de viviendas (calendario oficial)
  - FRED (con FRED_API_KEY): fechas futuras exactas de IPC, empleo, IPP, JOLTS, etc.
  - Dato real de EE. UU.: reales.py (BLS y FRED).
Misma fecha, pais y etiqueta: gana la ultima fuente (ForexFactory va al final).
Publica pub/eventos.json (EE. UU.), pub/calendario.json (11 paises) y pub/eventos_horas.json (avisos).
"""
from __future__ import annotations

import json
import os
import re
import urllib.request
from datetime import datetime, timedelta, timezone

import gex_engine as g
import reales

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/130.0 Safari/537.36")
STATE = os.path.join(g.CACHE_DIR, "eventos.json")
GUARDAR_ANOS = 3
VERSION = 5  # al cambiar las fuentes o las etiquetas, se fuerza una actualizacion y se descarta lo guardado con otra version
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
            out.append({"date": d.strftime("%Y-%m-%d"), "time": "14:00", "name": "FOMC", "country": "US", "imp": 3})
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
            out.append({"date": dt.strftime("%Y-%m-%d"), "time": dt.strftime("%H:%M"), "name": "GDP", "country": "US", "imp": 2})
        elif summ.startswith("Personal Income and Outlays"):
            out.append({"date": dt.strftime("%Y-%m-%d"), "time": dt.strftime("%H:%M"), "name": f"PCE ({_ref_month(dt)})", "country": "US", "imp": 3})
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
        out.append({"date": f"{m.group(3)}-{mm:02d}-{int(m.group(2)):02d}", "time": hh, "name": lab[1], "country": "US", "imp": lab[2]})
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
            out.append({"date": r["date"], "time": "10:00" if name in ("Michigan", "JOLTS") else "08:30", "name": nm, "country": "US", "imp": imp})
    return out


# ---------------------------------------------------------------- ForexFactory
FF_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json"
DIVISAS = {"USD": "US", "EUR": "EZ", "GBP": "GB", "JPY": "JP", "CNY": "CN", "CAD": "CA", "AUD": "AU", "CHF": "CH"}
EUR_PAIS = (("German ", "DE"), ("French ", "FR"), ("Italian ", "IT"))
FF_IMP = {"High": 3, "Medium": 2, "Low": 1}
# EE. UU.: titulo -> (etiqueta de siempre, meses de retraso del dato o None). Con etiqueta salen en el Summary, la
# estructura de volatilidad y la Validacion; sin ella, solo en la pagina Calendar (solo_cal).
FF_NAMES = [
    (r"^CPI m/m$", "CPI", 1), (r"^Non-Farm Employment Change$", "Payrolls (NFP)", 1), (r"^PPI m/m$", "PPI", 1),
    (r"^ISM Manufacturing PMI$", "ISM manufacturing", None), (r"^ISM Services PMI$", "ISM services", None),
    (r"^Unemployment Claims$", "Jobless claims", None), (r"^(Prelim|Revised) UoM Consumer Sentiment$", "Michigan", None),
    (r"^JOLTS Job Openings$", "JOLTS", 2), (r"^Retail Sales m/m$", "Retail sales", 1),
    (r"^Core PCE Price Index m/m$", "PCE", 1), (r"^FOMC Statement$", "FOMC", None),
    (r"^(Advance|Prelim|Final) GDP q/q$", "GDP", None), (r"^FOMC Meeting Minutes$", "FOMC minutes", None),
    (r"^Fed Chair .* Speaks$", "Fed Chair speaks", None), (r"^CB Consumer Confidence$", "Consumer confidence", None),
    (r"^Durable Goods Orders m/m$", "Durable goods", None), (r"^Housing Starts$", "Housing starts", None),
    (r"^New Home Sales$", "New home sales", None),
]


def _txt(s) -> str | None:
    s = str(s or "").strip()
    return s or None


def ff_fila(r: dict) -> dict | None:
    """Evento de ForexFactory -> evento, o None si la divisa o el tipo no interesan."""
    pais, imp, titulo = DIVISAS.get(r.get("country")), FF_IMP.get(r.get("impact")), _txt(r.get("title"))
    if not pais or not imp or not titulo:
        return None
    if pais == "EZ":
        pais = next((p for pre, p in EUR_PAIS if titulo.startswith(pre)), "EZ")
    try:
        ny = _ny(datetime.fromisoformat(r["date"]))
    except (KeyError, ValueError):
        return None
    hora = ny.strftime("%H:%M")
    e = {"date": ny.strftime("%Y-%m-%d"), "time": "" if hora == "00:00" else hora,  # 00:00: dia entero o sin hora
         "name": titulo, "country": pais, "imp": imp,
         "forecast": _txt(r.get("forecast")), "previous": _txt(r.get("previous")), "actual": None}
    if pais == "US":
        et = next(((n, lag) for rx, n, lag in FF_NAMES if re.search(rx, titulo)), None)
        if et:
            e["titulo"] = titulo
            e["name"] = et[0] if et[1] is None else f"{et[0]} ({_ref_month(ny, et[1])})"
        else:
            e["solo_cal"] = True
    return e


def forexfactory() -> list[dict]:
    return [e for e in (ff_fila(r) for r in json.loads(_get(FF_URL))) if e]


# ---------------------------------------------------------------- union
def _clave(e: dict) -> str:
    return f"{e['date']}|{e.get('country', 'US')}|{e['name']}"


def _base(k: str) -> str:
    """Clave sin el mes de referencia: 'CPI (Oct)' y 'CPI (Sep)' son la misma publicacion; 'CPI, n.s.a' no."""
    return re.sub(r" \([A-Z][a-z]{2}\)$", "", k)


def unir(known: dict, evs: list[dict], solo_nuevos: bool = False) -> None:
    """Anade evs a known. Misma fecha, pais y etiqueta (sin el mes) es la misma publicacion.
    solo_nuevos (fuentes oficiales): si ya esta, se salta, para no borrar lo de ForexFactory.
    Si no (ForexFactory): se mezcla con lo que habia; los campos None no pisan lo guardado (p. ej. el actual)."""
    for e in evs:
        base = _base(_clave(e))
        claves = [k for k in known if _base(k) == base]
        if solo_nuevos and claves:
            continue
        viejo = {}
        for k in claves:
            viejo.update(known.pop(k))
        known[_clave(e)] = {**viejo, **{k: v for k, v in e.items() if v is not None}}


CAL_ATRAS, CAL_ADELANTE, OTROS_DIAS = 14, 28, 35


def actualizar() -> tuple[list[dict], dict]:
    """Junta las fuentes con lo guardado (estado), marca y rellena el dato real, y devuelve eventos y resumen."""
    prev = g.read_json(STATE, {}) or {}
    # lo guardado con otra version (otras etiquetas o claves) se descarta salvo los eventos de EE. UU. pasados
    # que usa la Validacion; el resto se conservaria con claves viejas y quedarian eventos repetidos
    if prev.get("version") == VERSION:
        known = {_clave(e): e for e in prev.get("eventos", [])}
    else:
        # migracion: FRED solo mira 31 dias atras; se conservan los dias de evento pasados que usa la Validacion
        hoy_s = g.now_ny().strftime("%Y-%m-%d")
        known = {_clave(e): e for e in ({**e, "country": "US"} for e in prev.get("eventos", [])
                                        if e.get("country", "US") == "US" and e["date"] < hoy_s
                                        and _base(e["name"]) in g.EVENT_NAMES)}
    res = {}
    for name, fn in (("fomc", fomc), ("bea", bea), ("census", census), ("fred", fred), ("forexfactory", forexfactory)):
        try:
            evs = fn()
            res[name] = len(evs)
            unir(known, evs, solo_nuevos=name != "forexfactory")
        except Exception as ex:  # noqa: BLE001
            res[name] = f"error: {str(ex)[:80]}"
    hoy = g.now_ny()
    # EE. UU.: lo pasado se guarda GUARDAR_ANOS (la Validacion marca con ello los dias de evento); otros paises y
    # los de solo calendario, 35 dias
    lo_us = (hoy - timedelta(days=365 * GUARDAR_ANOS)).strftime("%Y-%m-%d")
    lo_otros = (hoy - timedelta(days=OTROS_DIAS)).strftime("%Y-%m-%d")
    hi = (hoy + timedelta(days=400)).strftime("%Y-%m-%d")
    evs = sorted((e for e in known.values()
                  if (lo_us if e.get("country", "US") == "US" and not e.get("solo_cal") else lo_otros) <= e["date"] <= hi),
                 key=lambda e: (e["date"], e["time"] or "99:99", -e["imp"]))
    marcar_reales(evs)
    try:
        res["reales"] = rellenar_reales(evs)
    except Exception as ex:  # noqa: BLE001
        res["reales"] = f"error: {str(ex)[:80]}"
    g.write_json(STATE, {"eventos": evs, "fuentes": res, "version": VERSION,
                         "actualizado": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")})
    return evs, res


def marcar_reales(evs: list[dict]) -> None:
    """real: el evento tiene fuente de dato real (reales.REALES). Solo EE. UU. con titulo de ForexFactory."""
    for e in evs:
        e["real"] = e.get("country", "US") == "US" and reales.regla(e.get("titulo") or e["name"]) is not None


def rellenar_reales(evs: list[dict], now: datetime | None = None) -> int:
    """Pone el dato real a los eventos de los ultimos 2 dias que ya han pasado y aun no lo tienen."""
    now = now or datetime.now(timezone.utc)
    hoy = (now + g._ny_offset(now)).date()
    lo = (hoy - timedelta(days=2)).isoformat()
    pend = [e for e in evs if e.get("real") and not e.get("actual") and e.get("time")
            and lo <= e["date"] <= hoy.isoformat() and _utc(e["date"], e["time"]) <= now]
    return reales.rellenar(pend) if pend else 0


def refrescar_reales() -> int:
    """Modo calendario del motor: solo el dato real sobre lo guardado (sin pedir ForexFactory). Vuelve a marcar
    `real` con las reglas actuales de reales.REALES, para que las marcas guardadas no queden viejas."""
    st = g.read_json(STATE, {}) or {}
    if not st.get("eventos"):  # sin estado no se escribe nada: pisaria el de R2 con uno vacio
        return 0
    marcar_reales(st["eventos"])
    try:
        n = rellenar_reales(st["eventos"])
    except Exception as e:  # noqa: BLE001
        n = 0
        st.setdefault("fuentes", {})["reales"] = f"error: {e}"
    st["reales"] = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")
    g.write_json(STATE, st)
    return n


def conservar_reales(evs: list[dict], otros: list[dict]) -> int:
    """Copia el dato real (actual) de `otros` a los eventos de `evs` que aun no lo tienen (misma clave): asi un
    estado leido antes de otra escritura no pierde lo que esa escritura recogio. Devuelve cuantos copia."""
    por_clave = {_clave(o): o for o in otros if o.get("actual")}
    n = 0
    for e in evs:
        o = por_clave.get(_clave(e))
        if o and not e.get("actual"):
            e["actual"] = o["actual"]
            n += 1
    return n


def _eventos() -> list[dict]:
    return (g.read_json(STATE, {}) or {}).get("eventos", [])


def publicables() -> list[dict]:
    """EE. UU. desde hace 45 dias (Summary y estructura de volatilidad), sin los que solo van a la pagina Calendar."""
    lo = (g.now_ny() - timedelta(days=45)).strftime("%Y-%m-%d")
    return [e for e in _eventos() if e.get("country", "US") == "US" and not e.get("solo_cal") and e["date"] >= lo]


def calendario() -> list[dict]:
    """Todos los paises dentro del rango de la pagina Calendar."""
    hoy = g.now_ny()
    lo = (hoy - timedelta(days=CAL_ATRAS)).strftime("%Y-%m-%d")
    hi = (hoy + timedelta(days=CAL_ADELANTE)).strftime("%Y-%m-%d")
    return [e for e in _eventos() if lo <= e["date"] <= hi]


def _utc(fecha: str, hora: str) -> datetime:
    """Fecha y hora de Nueva York -> UTC (con zona)."""
    ny = datetime.strptime(f"{fecha} {hora}", "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)
    u = ny - g._ny_offset(ny)
    return ny - g._ny_offset(u)


REINTENTOS = (6, 16, 31, 61, 121)  # minutos tras el evento mientras falte el dato real (FRED tarda hasta ~2 h)


def horas_aviso(evs: list[dict], now: datetime | None = None) -> list[str]:
    """Instantes (UTC ISO) en que el Worker lanza el modo calendario: solo para eventos con fuente de dato real
    (real) y aun sin el, que son los unicos que ese modo puede actualizar: hora del evento + 1 min y todos los
    reintentos de REINTENTOS que no hayan pasado (si uno acierta, el evento deja de avisar). Importancia 2 o mas,
    hoy y manana, con hora."""
    now = now or datetime.now(timezone.utc)
    hoy = (now + g._ny_offset(now)).date()
    dias = {hoy.isoformat(), (hoy + timedelta(days=1)).isoformat()}
    out = set()
    for e in evs:
        if e["imp"] < 2 or not e.get("time") or e["date"] not in dias or not e.get("real") or e.get("actual"):
            continue
        t = _utc(e["date"], e["time"])
        out.update(t + timedelta(minutes=m) for m in (1,) + REINTENTOS if t + timedelta(minutes=m) > now)
    return [t.strftime("%Y-%m-%dT%H:%M:%SZ") for t in sorted(out)]


if __name__ == "__main__":
    evs, res = actualizar()
    print(res)
    from collections import Counter
    print(Counter(e.get("country", "US") for e in calendario()))
    semana = g.now_ny().strftime("%Y-%m-%d")
    for e in calendario():
        if e["imp"] >= 2 and e["date"] >= semana:
            print(e)
    print(horas_aviso(evs))
