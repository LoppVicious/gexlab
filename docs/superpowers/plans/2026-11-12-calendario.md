# Calendario económico: implementación (revisión 2: ForexFactory + BLS + FRED)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Actual/Forecast/Previous en una tarjeta del Summary, página Calendar con 11 países y filtros, y aviso del
motor (solo calendario) a la hora de cada evento + 1 min, con reintentos mientras falte el dato real.

**Architecture:** `eventos.py` usa ForexFactory para la semana en curso de todos los países (importancia,
forecast, previous) y las fuentes oficiales de EE. UU. para el futuro lejano. `reales.py` calcula el dato real de
EE. UU. con BLS (al minuto) y FRED. `motor.py calendario` solo rellena el dato real y publica. Un Durable Object
del Worker (`RelojCalendario`) pone una alarma en el próximo instante de aviso y lanza `motor.yml` con
`modo=calendario`; el cron `*/5` le pasa la lista. La web añade `web/calendario.js` (tarjeta y página).

**Tech Stack:** Python 3 (urllib, sin dependencias nuevas), Cloudflare Worker + Durable Object SQLite + R2,
GitHub Actions, JS sin framework.

**Spec:** `docs/superpowers/specs/2026-11-12-calendario-design.md` (revisión 2).

**Punto de partida:** rama `calendario` con los commits `ba631c2` y `20eea66` (Nasdaq, descartado: 403) y tres
commits de pruebas en Actions (`pruebas/prueba_nasdaq.py`, `prueba_fred.py`, `prueba_bls.py`, y `comparar.yml`
con `FRED_API_KEY` y `BLS_API_KEY`). De lo hecho se conserva: país en la clave (`_clave`, `_base`, `unir`),
`publicables`, `calendario`, `_utc`, `horas_aviso`, las pruebas de unión. Se quita todo lo de Nasdaq.

**Comandos** (PowerShell, desde `D:\Claude\GexLab\gexlab`): Python es `.venv\Scripts\python.exe` (abajo `py`).
No hay pytest: pruebas con `assert` en `pruebas/test_*.py`. Commits con `Co-Authored-By: Claude Opus 5.5
<noreply@anthropic.com>`. No hacer push salvo en la Tarea 8 y con permiso.

---

## Mapa de archivos

| Archivo | Cambio |
|---|---|
| `eventos.py` | Fuera Nasdaq; `forexfactory()` multipaís con `ff_fila`; `FF_NAMES` con etiquetas; avisos con reintentos; `marcar_reales`, `rellenar_reales`, `refrescar_reales` |
| `reales.py` | Nuevo: tabla `REALES`, descarga BLS/FRED, cálculo y formato del dato real |
| `pruebas/test_eventos.py`, `pruebas/test_reales.py` | Pruebas sin red |
| `pruebas/prueba_nasdaq.py` | Se borra |
| `motor.py`, `.github/workflows/motor.yml` | `EVENTOS_KEY`, `traer_eventos`, `fase_calendario`, modo `calendario`, `BLS_API_KEY` |
| `nube/worker.js`, `nube/desplegar.sh` | Durable Object `RelojCalendario` |
| `web/nube.js`, `server.py` | `/api/calendario` |
| `web/calendario.js`, `web/resumen.js`, `web/app.js`, `web/index.html`, `web/sg.css` | Tarjeta y página |
| `docs/ARQUITECTURA.md`, `CLAUDE.md`, `CHANGELOG.md` | Documentación |

---

### Task 1: ForexFactory multipaís en `eventos.py`

**Files:**
- Modify: `eventos.py`
- Modify: `pruebas/test_eventos.py`
- Delete: `pruebas/prueba_nasdaq.py`

- [ ] **Step 1: Pruebas que fallan**

En `pruebas/test_eventos.py`, sustituir `fila` y `test_normaliza` por:

```python
def ff(title, country="USD", date="2026-11-10T08:30:00-05:00", impact="High", forecast="", previous=""):
    return {"title": title, "country": country, "date": date, "impact": impact, "forecast": forecast, "previous": previous}


def test_ff_fila():
    e = ev.ff_fila(ff("CPI m/m", forecast="0.3%", previous="0.6%"))
    assert e == {"date": "2026-11-10", "time": "08:30", "name": "CPI (Oct)", "titulo": "CPI m/m", "country": "US",
                 "imp": 3, "forecast": "0.3%", "previous": "0.6%", "actual": None}, e
    e = ev.ff_fila(ff("German Prelim CPI m/m", "EUR", "2026-11-10T08:00:00-05:00", "Medium", "0.2%", "0.3%"))
    assert (e["country"], e["name"], e["imp"]) == ("DE", "German Prelim CPI m/m", 2) and "titulo" not in e, e
    assert ev.ff_fila(ff("CPI m/m", "EUR"))["country"] == "EZ"
    e = ev.ff_fila(ff("Empire State Manufacturing Index", impact="Low"))
    assert e["solo_cal"] is True and e["imp"] == 1 and e["name"] == "Empire State Manufacturing Index", e
    assert ev.ff_fila(ff("Bank Holiday", impact="Holiday")) is None
    assert ev.ff_fila(ff("CPI q/q", "NZD")) is None
    assert ev.ff_fila(ff("OPEC Meetings", date="2026-11-10T00:00:00-05:00", impact="Low"))["time"] == ""
```

En `test_union`, las claves no cambian. Sustituir `test_avisos` por:

```python
def test_avisos():
    # 2026-11-13 es viernes; en noviembre Nueva York es UTC-5
    def e(name, time, imp=2, real=True, actual=None, country="US"):
        return {"date": "2026-11-13", "time": time, "name": name, "country": country, "imp": imp,
                "real": real, "actual": actual, "forecast": "0.2%", "previous": "0.4%"}
    evs = [e("CPI (Oct)", "08:30", 3), e("Retail sales (Oct)", "08:30"), e("Fed Chair speaks", "10:00", real=False),
           e("Minor", "09:00", 1), e("ECOFIN Meetings", "", country="EZ", real=False)]
    from datetime import timezone
    utc = lambda h, m: datetime(2026, 11, 13, h, m, tzinfo=timezone.utc)  # noqa: E731
    assert ev.horas_aviso(evs, utc(13, 0)) == ["2026-11-13T13:31:00Z", "2026-11-13T15:01:00Z"]
    # sin dato real: el siguiente reintento (T+6, 16, 31, 61, 121) que no haya pasado; el discurso no reintenta
    assert ev.horas_aviso(evs, utc(13, 32)) == ["2026-11-13T13:36:00Z", "2026-11-13T15:01:00Z"]
    assert ev.horas_aviso(evs, utc(13, 40)) == ["2026-11-13T13:46:00Z", "2026-11-13T15:01:00Z"]
    assert ev.horas_aviso(evs, utc(15, 40)) == []          # pasado T+121 y el discurso ya avisado
    for x in evs[:2]:
        x["actual"] = "0.3%"
    assert ev.horas_aviso(evs, utc(13, 32)) == ["2026-11-13T15:01:00Z"]
```

- [ ] **Step 2: Comprobar que falla**

Run: `py pruebas\test_eventos.py`
Expected: `AttributeError: module 'eventos' has no attribute 'ff_fila'`

- [ ] **Step 3: Implementación**

En `eventos.py`:

1. Docstring:

```python
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
```

2. `VERSION = 5`. Añadir `import reales` tras `import gex_engine as g`. Quitar `import time` si ya no se usa.

3. En `bea()`, el PIB se llama `GDP` (ya está) y todos los eventos de `fomc`, `bea`, `census`, `fred` llevan
   `"country": "US"` (ya está).

4. Borrar la sección `# ---- Nasdaq` entera (`NASDAQ_URL`, `PAISES`, `IMPORTANCIA`, `_valor`, `nasdaq_fila`,
   `nasdaq_dia`), `_nasdaq_rango` y `NASDAQ_ATRAS, NASDAQ_ADELANTE`. Añadir en su lugar:

```python
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
```

5. Sustituir `actualizar(...)` por:

```python
CAL_ATRAS, CAL_ADELANTE, OTROS_DIAS = 14, 28, 35


def actualizar() -> tuple[list[dict], dict]:
    """Junta las fuentes con lo guardado (estado), marca y rellena el dato real, y devuelve eventos y resumen."""
    prev = g.read_json(STATE, {}) or {}
    # lo guardado con otra version (otras etiquetas o claves) se descarta: si no, quedarian eventos repetidos
    known = {_clave(e): e for e in prev.get("eventos", [])} if prev.get("version") == VERSION else {}
    res = {}
    for name, fn in (("fomc", fomc), ("bea", bea), ("census", census), ("fred", fred), ("forexfactory", forexfactory)):
        try:
            evs = fn()
            res[name] = len(evs)
            unir(known, evs)
        except Exception as ex:  # noqa: BLE001
            res[name] = f"error: {str(ex)[:80]}"
    hoy = g.now_ny()
    # EE. UU.: lo pasado se guarda GUARDAR_ANOS (la Validacion marca con ello los dias de evento); otros paises, 35 dias
    lo_us = (hoy - timedelta(days=365 * GUARDAR_ANOS)).strftime("%Y-%m-%d")
    lo_otros = (hoy - timedelta(days=OTROS_DIAS)).strftime("%Y-%m-%d")
    hi = (hoy + timedelta(days=400)).strftime("%Y-%m-%d")
    evs = sorted((e for e in known.values()
                  if (lo_us if e.get("country", "US") == "US" else lo_otros) <= e["date"] <= hi),
                 key=lambda e: (e["date"], e["time"] or "99:99", -e["imp"]))
    marcar_reales(evs)
    try:
        res["reales"] = rellenar_reales(evs)
    except Exception as ex:  # noqa: BLE001
        res["reales"] = f"error: {str(ex)[:80]}"
    g.write_json(STATE, {"eventos": evs, "fuentes": res, "version": VERSION,
                         "actualizado": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")})
    return evs, res
```

6. Añadir tras `actualizar`:

```python
def marcar_reales(evs: list[dict]) -> None:
    """real: el evento tiene fuente de dato real (reales.REALES). Solo EE. UU. con titulo de ForexFactory."""
    for e in evs:
        e["real"] = e.get("country", "US") == "US" and reales.regla(e.get("titulo") or e["name"]) is not None


def rellenar_reales(evs: list[dict], now: datetime | None = None) -> int:
    """Pone el dato real a los eventos de los ultimos 7 dias que ya han pasado y aun no lo tienen."""
    now = now or datetime.now(timezone.utc)
    hoy = (now + g._ny_offset(now)).date()
    lo = (hoy - timedelta(days=7)).isoformat()
    pend = [e for e in evs if e.get("real") and not e.get("actual") and e.get("time")
            and lo <= e["date"] <= hoy.isoformat() and _utc(e["date"], e["time"]) <= now]
    return reales.rellenar(pend) if pend else 0


def refrescar_reales() -> int:
    """Modo calendario del motor: solo el dato real sobre lo guardado (sin pedir ForexFactory)."""
    st = g.read_json(STATE, {}) or {}
    n = rellenar_reales(st.get("eventos", []))
    st["reales"] = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")
    g.write_json(STATE, st)
    return n
```

7. `publicables()` excluye `solo_cal`:

```python
def publicables() -> list[dict]:
    """EE. UU. desde hace 45 dias (Summary y estructura de volatilidad), sin los que solo van a la pagina Calendar."""
    lo = (g.now_ny() - timedelta(days=45)).strftime("%Y-%m-%d")
    return [e for e in _eventos() if e.get("country", "US") == "US" and not e.get("solo_cal") and e["date"] >= lo]
```

8. `calendario()` usa `CAL_ATRAS`/`CAL_ADELANTE` en vez de `NASDAQ_ATRAS`/`NASDAQ_ADELANTE`.

9. `horas_aviso` con reintentos:

```python
REINTENTOS = (6, 16, 31, 61, 121)  # minutos tras el evento mientras falte el dato real (FRED tarda hasta ~2 h)


def horas_aviso(evs: list[dict], now: datetime | None = None) -> list[str]:
    """Instantes (UTC ISO) en que el Worker lanza el modo calendario: hora del evento + 1 min y, si tiene fuente de
    dato real y aun no lo tiene, el siguiente reintento de REINTENTOS. Importancia 2 o mas, hoy y manana, con hora."""
    now = now or datetime.now(timezone.utc)
    hoy = (now + g._ny_offset(now)).date()
    dias = {hoy.isoformat(), (hoy + timedelta(days=1)).isoformat()}
    out = set()
    for e in evs:
        if e["imp"] < 2 or not e.get("time") or e["date"] not in dias:
            continue
        t = _utc(e["date"], e["time"])
        if t + timedelta(minutes=1) > now:
            out.add(t + timedelta(minutes=1))
        elif e.get("real") and not e.get("actual"):
            sig = next((t + timedelta(minutes=m) for m in REINTENTOS if t + timedelta(minutes=m) > now), None)
            if sig:
                out.add(sig)
    return [t.strftime("%Y-%m-%dT%H:%M:%SZ") for t in sorted(out)]
```

10. `__main__`:

```python
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
```

Para que el import funcione antes de la Tarea 2, crear `reales.py` provisional:

```python
"""Dato real de los indicadores de EE. UU. (se completa en la tarea siguiente)."""


def regla(titulo: str):
    return None


def rellenar(evs: list[dict]) -> int:
    return 0
```

Borrar `pruebas/prueba_nasdaq.py` (`git rm`).

- [ ] **Step 4: Comprobar que pasa**

Run: `py pruebas\test_eventos.py`
Expected: `ok test_ff_fila`, `ok test_union`, `ok test_avisos`

- [ ] **Step 5: Prueba real (ForexFactory desde el PC, una sola petición)**

Run: `$env:GEX_ALMACEN="local:./data/x"; py eventos.py`
Expected: `forexfactory` > 50 sin `error` (si da 429, esperar 5 min y repetir una vez; no más), el `Counter` con
varios países, y los de importancia 2+ de la semana con su forecast y previous.

- [ ] **Step 6: Commit**

```bash
git add eventos.py reales.py pruebas/test_eventos.py
git rm pruebas/prueba_nasdaq.py
git commit -m "Calendario: ForexFactory multipais en lugar de Nasdaq"
```

---

### Task 2: Dato real con BLS y FRED (`reales.py`)

**Files:**
- Modify: `reales.py` (sustituye el provisional)
- Create: `pruebas/test_reales.py`

- [ ] **Step 1: Pruebas que fallan**

Crear `pruebas/test_reales.py`:

```python
"""Pruebas sin red de reales.py. Uso: .venv/Scripts/python.exe pruebas/test_reales.py"""
import os
import sys
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import reales as r  # noqa: E402


def ev(titulo, fecha, previous, forecast=None):
    return {"titulo": titulo, "name": titulo, "date": fecha, "previous": previous, "forecast": forecast}


def test_formato():
    assert r.formato(0.3503, "0.6%") == "0.4%"
    assert r.formato(-0.21, "-0.4%") == "-0.2%"
    assert r.formato(165000, "119K") == "165K"
    assert r.formato(7523000, "7.19M") == "7.52M"
    assert r.formato(1221000, "1,288K") == "1,221K"
    assert r.formato(5, "n/a") is None


def test_regla():
    assert r.regla("CPI m/m")[1] == "CUSR0000SA0"
    assert r.regla("Prelim GDP q/q")[1] == "A191RL1Q225SBEA"
    assert r.regla("ISM Manufacturing PMI") is None


def test_actual():
    cpi = [(date(2026, 10, 1), 337.476), (date(2026, 9, 1), 336.298)]
    assert r.actual(ev("CPI m/m", "2026-11-10", "0.6%"), cpi) == "0.4%"
    # dato aun del mes anterior: no es el nuevo
    assert r.actual(ev("CPI m/m", "2026-12-10", "0.4%"), cpi) is None
    nfp = [(date(2026, 10, 1), 159293), (date(2026, 9, 1), 159128)]
    assert r.actual(ev("Non-Farm Employment Change", "2026-11-06", "119K"), nfp) == "165K"
    claims = [(date(2026, 11, 7), 205000), (date(2026, 10, 31), 189000)]
    assert r.actual(ev("Unemployment Claims", "2026-11-12", "189K"), claims) == "205K"
    assert r.actual(ev("Unemployment Claims", "2026-11-19", "205K"), claims) is None
    gdp = [(date(2026, 7, 1), 3.4), (date(2026, 4, 1), 2.2)]
    assert r.actual(ev("Advance GDP q/q", "2026-10-29", "2.2%"), gdp) == "3.4%"
    yy = [(date(2026, 10, 1), 337.511)] + [(date(2026, m, 1), 330.0) for m in range(9, 0, -1)] + \
         [(date(2025, m, 1), 327.0) for m in range(12, 9, -1)]
    assert r.actual(ev("CPI y/y", "2026-11-10", "3.0%"), yy) == "3.2%"


if __name__ == "__main__":
    for nombre, fn in list(globals().items()):
        if nombre.startswith("test_"):
            fn()
            print("ok", nombre)
```

(337.511 / 327.0 − 1 = 3.21 %.)

- [ ] **Step 2: Comprobar que falla**

Run: `py pruebas\test_reales.py`
Expected: `AttributeError: module 'reales' has no attribute 'formato'`

- [ ] **Step 3: Implementación**

Sustituir `reales.py` por:

```python
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
    (r"^JOLTS Job Openings$", "bls", "JTS000000000000000JOL", "nivel", 1000, "M", 2),
    (r"^Retail Sales m/m$", "fred", "RSAFS", "mm", 1, "M", 1),
    (r"^Core Retail Sales m/m$", "fred", "RSFSXMV", "mm", 1, "M", 1),
    (r"^Core PCE Price Index m/m$", "fred", "PCEPILFE", "mm", 1, "M", 1),
    (r"^PCE Price Index m/m$", "fred", "PCEPI", "mm", 1, "M", 1),
    (r"^Unemployment Claims$", "fred", "ICSA", "nivel", 1, "W", 0),
    (r"^(Advance|Prelim|Final) GDP q/q$", "fred", "A191RL1Q225SBEA", "nivel", 1, "Q", 3),
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
    x = v / SUFIJOS[suf]
    return (f"{x:,.{dec}f}" if "," in m.group(1) else f"{x:.{dec}f}") + suf


def _mes(d: date, n: int) -> date:
    """Primer dia del mes n meses antes de d."""
    y, m = divmod(d.year * 12 + d.month - 1 - n, 12)
    return date(y, m + 1, 1)


def _es_nuevo(fecha: date, per: str, retraso: int, obs: date) -> bool:
    if per == "W":
        return fecha - timedelta(days=7) <= obs < fecha
    if per == "Q":
        m = _mes(fecha, 3)
        return obs == date(m.year, (m.month - 1) // 3 * 3 + 1, 1)
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
    if calc == "mm" and len(obs) > 1:
        v = (v0 / obs[1][1] - 1) * 100
    elif calc == "yy":
        hace = next((x for d, x in obs if d == _mes(obs[0][0], 12)), None)
        if hace is None:
            return None
        v = (v0 / hace - 1) * 100
    elif calc == "dif" and len(obs) > 1:
        v = (v0 - obs[1][1]) * base
    elif calc == "nivel":
        v = v0 * base
    else:
        return None
    return formato(v, e.get("previous") or e.get("forecast"))


# ---------------------------------------------------------------- descargas
def _bls(series: list[str]) -> dict[str, list[tuple[date, float]]]:
    year = datetime.now().year
    body = {"seriesid": series, "startyear": str(year - 1), "endyear": str(year)}
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
                except ValueError:
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
        except ValueError:  # "." = sin dato
            pass
    return obs


def rellenar(evs: list[dict]) -> int:
    """Pone e['actual'] a los eventos que ya lo tienen publicado. Una peticion a BLS y una por serie de FRED."""
    reglas = [(e, regla(e.get("titulo") or e.get("name"))) for e in evs]
    reglas = [(e, rg) for e, rg in reglas if rg]
    bls = sorted({rg[1] for _, rg in reglas if rg[0] == "bls"})
    datos = _bls(bls) if bls else {}
    for s in sorted({rg[1] for _, rg in reglas if rg[0] == "fred"}):
        datos[s] = _fred(s)
    n = 0
    for e, rg in reglas:
        v = actual(e, datos.get(rg[1]) or [])
        if v:
            e["actual"] = v
            n += 1
    return n
```

- [ ] **Step 4: Comprobar que pasa**

Run: `py pruebas\test_reales.py` → `ok test_formato`, `ok test_regla`, `ok test_actual`
Run: `py pruebas\test_eventos.py` → tres `ok`.

- [ ] **Step 5: Comprobación con datos reales (BLS sin clave, una petición)**

Run:
```powershell
py -c "import reales; from datetime import date; d=reales._bls(['CUSR0000SA0','WPSFD49104']); print({k: v[:2] for k, v in d.items()}); print(reales.actual({'titulo':'CPI m/m','date':'2026-11-10','previous':'0.6%'}, d['CUSR0000SA0']))"
```
Expected: dos observaciones por serie (CPI 2026-10 = 337.476) y `0.4%`.

- [ ] **Step 6: Commit**

```bash
git add reales.py pruebas/test_reales.py
git commit -m "Calendario: dato real de EE. UU. con BLS y FRED"
```

---

### Task 3: Motor, modo `calendario` y estado propio

**Files:**
- Modify: `motor.py` (docstring, tras `ESTADO_KEY` línea 44, `fase_macro` líneas 422-433, `ciclo()`, nueva `calendario()`, `__main__`)
- Modify: `.github/workflows/motor.yml`

- [ ] **Step 1: `motor.py`**

Tras `ESTADO_KEY = "estado/estado.tar.gz"`:

```python
EVENTOS_KEY = "estado/eventos.json"  # estado del calendario: aparte del tar, lo escriben el ciclo y el modo calendario
```

Sustituir el bloque `try:  # calendario macro: como mucho cada 6 h ... err("calendario", e)` de `fase_macro` por:

```python
    fase_calendario(st, completo=True)
```

Antes de `def fase_vistas`:

```python
def traer_eventos(st) -> None:
    """El estado del calendario de R2 manda sobre la copia del tar (el modo calendario no guarda el tar)."""
    import eventos
    d = almacen.get_json(st, EVENTOS_KEY)
    if d:
        os.makedirs(os.path.dirname(eventos.STATE), exist_ok=True)
        g.write_json(eventos.STATE, d)


def fase_calendario(st, completo: bool) -> None:
    """completo (ciclo): todas las fuentes como mucho cada hora (ForexFactory limita peticiones) y, si no toca,
    solo el dato real. Modo calendario: solo el dato real. Publica siempre eventos, calendario y avisos."""
    try:
        import eventos
        traer_eventos(st)  # justo antes de usarlo, para no pisar lo que haya publicado el otro modo
        st_ev = g.read_json(eventos.STATE, {}) or {}
        last = st_ev.get("actualizado")
        fred_nueva = bool(os.environ.get("FRED_API_KEY")) and not (st_ev.get("fuentes") or {}).get("fred")
        vieja = (st_ev.get("version") != eventos.VERSION or fred_nueva or not last or
                 (datetime.now(timezone.utc) - datetime.strptime(last, "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)).total_seconds() > 3600)
        if completo and vieja:
            evs, res = eventos.actualizar()
            log(f"calendario: {len(evs)} eventos ({', '.join(f'{k} {v}' for k, v in res.items())})")
        else:
            log(f"calendario: {eventos.refrescar_reales()} datos reales nuevos")
        almacen.put_json(st, EVENTOS_KEY, g.read_json(eventos.STATE, {}))
        subir(st, "pub/eventos.json", eventos.publicables())
        subir(st, "pub/calendario.json", {"eventos": eventos.calendario(),
                                          "actualizado": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")})
        subir(st, "pub/eventos_horas.json", {"horas": eventos.horas_aviso(eventos._eventos())})
    except Exception as e:  # noqa: BLE001
        err("calendario", e)
```

En `ciclo()`, justo después de `restaurar_estado(st)`:

```python
    traer_eventos(st)  # la Validacion (fase_listas) marca los dias de evento con el calendario al dia
```

Tras `def rapido()`:

```python
def calendario() -> int:
    """Lo lanza la alarma del Worker a la hora de cada evento + 1 min (y reintentos): solo el dato real del
    calendario, sin tickers ni ForexFactory."""
    st = almacen.abrir()
    fase_calendario(st, completo=False)
    esperar_subidas()
    log(f"calendario terminado, {len(_errores)} errores")
    return 1 if _errores else 0
```

En `__main__`:

```python
        sys.exit(ciclo() if modo == "ciclo" else tickers(sys.argv[2:]) if modo == "ticker" else rapido() if modo == "rapido"
                 else calendario() if modo == "calendario" else 2)
```

En el docstring, tras la línea de `rapido`:

```
  python motor.py calendario       solo el dato real del calendario macro (BLS y FRED): lo lanza la alarma del
                                   Worker a la hora de cada evento + 1 min; no toca tickers ni guarda el tar
```

- [ ] **Step 2: `motor.yml`**

```yaml
      modo:
        description: "ciclo (todo), ticker (calculo puntual), rapido (indices en tiempo real) o calendario (solo eventos)"
        type: choice
        options: [ciclo, ticker, rapido, calendario]
        default: ciclo
```

En `env` del paso «Ejecutar motor», tras `FRED_API_KEY`:

```yaml
          BLS_API_KEY: ${{ secrets.BLS_API_KEY }}
```

En el `case`:

```bash
            calendario) python motor.py calendario ;;
```

(antes de `*) python motor.py ciclo ;;`).

- [ ] **Step 3: Prueba local**

Run: `$env:GEX_ALMACEN="local:./data/x"; py motor.py calendario`
Expected: `calendario: 0 datos reales nuevos` (o más) y `calendario terminado, 0 errores`.

Run (mismo `GEX_ALMACEN`): `py -c "import almacen; st=almacen.abrir(); print(almacen.get_json(st,'pub/eventos_horas.json')); print(len(almacen.get_json(st,'pub/calendario.json')['eventos']))"`
Expected: `{'horas': [...]}` y un número > 0 (hay estado de la Tarea 1 en `cache/eventos.json`; si `traer_eventos`
no encuentra nada en `data/x/estado/eventos.json`, se queda el de `cache/`).

Run: `py -c "import motor"` → sin salida.

- [ ] **Step 4: Commit**

```bash
git add motor.py .github/workflows/motor.yml
git commit -m "Motor: modo calendario y estado del calendario aparte"
```

---

### Task 4: Alarma en el Worker (Durable Object)

**Files:**
- Modify: `nube/worker.js` (antes de `export default`, y `scheduled`)
- Modify: `nube/desplegar.sh`

- [ ] **Step 1: `worker.js`**

Antes de `export default {`:

```js
// ------------------------------------------------------------------ alarma del calendario (Durable Object)
// Una sola instancia guarda los instantes de aviso que publica el motor (pub/eventos_horas.json: hora de cada
// evento + 1 min y reintentos mientras falte el dato real) y pone la alarma en el proximo. Al sonar lanza el motor
// en modo calendario (solo eventos). El cron */5 le vuelve a pasar la lista: si se pierde la alarma, vuelve en 5 min.
export class RelojCalendario {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }

  async fetch(req) {
    const lista = await req.json().catch(() => []);
    const ts = [...new Set((Array.isArray(lista) ? lista : []).map((s) => Date.parse(s)))]
      .filter((t) => Number.isFinite(t) && t > Date.now()).sort((a, b) => a - b).slice(0, 200);
    await this.ctx.storage.put("ts", ts);
    const cur = await this.ctx.storage.getAlarm();
    if (ts.length && cur !== ts[0]) await this.ctx.storage.setAlarm(ts[0]);
    else if (!ts.length && cur != null) await this.ctx.storage.deleteAlarm();
    return new Response(JSON.stringify({ proxima: ts[0] ? new Date(ts[0]).toISOString() : null }));
  }

  async alarm() {
    const ok = await dispatch(this.env, { modo: "calendario" });
    if (!ok) console.log("calendario: no se pudo lanzar el motor");
    const ts = ((await this.ctx.storage.get("ts")) || []).filter((t) => t > Date.now() + 1000);
    await this.ctx.storage.put("ts", ts);
    if (ts.length) await this.ctx.storage.setAlarm(ts[0]);
  }
}

async function programarCalendario(env) {
  if (!env.RELOJ) return;
  const d = await r2json(env, "pub/eventos_horas.json");
  if (!d || !Array.isArray(d.horas)) return;
  const reloj = env.RELOJ.get(env.RELOJ.idFromName("calendario"));
  await reloj.fetch("https://reloj/programar", { method: "POST", body: JSON.stringify(d.horas) });
}
```

En `scheduled`, tras la línea de `tocaHistorial`:

```js
    ctx.waitUntil(programarCalendario(env).catch((e) => console.log("calendario:", e.message)));
```

- [ ] **Step 2: `desplegar.sh`**

En el heredoc de `wrangler.toml`, tras `[[r2_buckets]]` (y su `bucket_name`) y antes de `[triggers]`:

```toml
[[durable_objects.bindings]]
name = "RELOJ"
class_name = "RelojCalendario"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["RelojCalendario"]
```

Cambiar el `echo` de secretos por:

```bash
echo "    secretos al dia; reloj cada 5 min (indices en tiempo real), cada 15 min (ciclo completo) y alarma del calendario"
```

- [ ] **Step 3: Comprobar**: `node --check nube/worker.js` → sin salida.

- [ ] **Step 4: Commit**

```bash
git add nube/worker.js nube/desplegar.sh
git commit -m "Worker: alarma del calendario con Durable Object"
```

---

### Task 5: Ruta `/api/calendario`

**Files:**
- Modify: `web/nube.js` (tras `case "/api/eventos"`)
- Modify: `server.py` (bloque `/api/eventos`)

- [ ] **Step 1: `nube.js`**

```js
      case "/api/calendario": return pub("calendario.json", s, "Calendar");
```

- [ ] **Step 2: `server.py`**

Sustituir el bloque `if url.path == "/api/eventos":` por:

```python
        if url.path in ("/api/eventos", "/api/calendario"):
            try:
                import eventos
                st = gex_engine.read_json(eventos.STATE, {}) or {}
                if not st.get("eventos") or st.get("version") != eventos.VERSION or q.get("refresh") == "1":
                    eventos.actualizar()
                if url.path == "/api/calendario":
                    return self._json(200, {"eventos": eventos.calendario(),
                                            "actualizado": (gex_engine.read_json(eventos.STATE, {}) or {}).get("actualizado")})
                return self._json(200, {"eventos": eventos.publicables()})
            except Exception as e:  # noqa: BLE001
                return self._json(200, {"eventos": [], "error": str(e)})
```

- [ ] **Step 3: Comprobar**: `node --check web/nube.js` y `py -c "import server"` → sin errores.

- [ ] **Step 4: Commit**

```bash
git add web/nube.js server.py
git commit -m "API: /api/calendario en la nube y en local"
```

---

### Task 6: Tarjeta compartida y Summary

**Files:**
- Create: `web/calendario.js`
- Modify: `web/resumen.js:52`, `web/index.html` (script tras `resumen.js`), `web/sg.css` (tras `.su-day .none`)

- [ ] **Step 1: Nombres libres**

Run: `Select-String -Path web\*.js,web\*.css,web\index.html -Pattern "calTip|calNum|calCmp|calCard|calKey|calEv\b|calView|\.cal-|CAL_"`
Expected: sin resultados.

- [ ] **Step 2: `web/calendario.js` (tarjeta)**

```js
"use strict";
/* ============================================================ Calendario economico
   - Tarjeta (Summary y Calendar): al pasar el raton o tocar un evento, Actual, Forecast y Previous.
   - Pagina Calendar: 11 paises de 14 dias atras a 28 adelante, filtro de paises e importancia (preferencias).
   Datos: /api/calendario (motor: eventos.py con ForexFactory y fuentes oficiales; reales.py, BLS y FRED). Los
   elementos con data-cal="clave" abren la tarjeta. Solo EE. UU. tiene dato real (e.real). */

const CAL_PAISES = [["US", "United States"], ["EZ", "Euro Area"], ["DE", "Germany"], ["FR", "France"], ["IT", "Italy"],
  ["GB", "United Kingdom"], ["JP", "Japan"], ["CN", "China"], ["CA", "Canada"], ["AU", "Australia"], ["CH", "Switzerland"]];
const CAL_NOMBRE = Object.fromEntries(CAL_PAISES);
const CAL_IMP = ["", "Low", "Medium", "High"];
const calEv = new Map();   // clave -> evento, para la tarjeta

const calKey = (e) => `${e.country || "US"}|${e.date}|${e.time}|${e.name}`;
function calReg(e) { const k = calKey(e); calEv.set(k, e); return esc(k); }
const calWhen = (e) => (e.time ? nyDate(`${e.date} ${e.time}`) : null);
const calTitle = (e) => e.titulo || e.name;

// "194K", "-0.4%", "1,710K", "15.6B" -> {v, u}; null si no es una cifra
function calNum(s) {
  const m = /^(-?[\d,]*\.?\d+)\s*([%KMBT]?)$/i.exec(String(s || "").trim());
  return m ? { v: parseFloat(m[1].replace(/,/g, "")), u: m[2].toUpperCase() } : null;
}
// direccion del dato frente al consenso (no dice si es bueno o malo)
function calCmp(e) {
  const a = calNum(e.actual), f = calNum(e.forecast);
  if (!a || !f || a.u !== f.u || a.v === f.v) return "";
  return a.v > f.v ? "pos" : "neg";
}
function calActual(e) {
  if (e.actual) return `<b class="${calCmp(e)}">${esc(e.actual)}</b>`;
  const t = calWhen(e);
  return e.real && t && t <= new Date() ? `<b class="pend">Pending</b>` : "<b>—</b>";
}
function calImpBars(imp) { return `<i class="imp i${imp}" title="${CAL_IMP[imp] || ""} impact"><u></u><u></u><u></u></i>`; }

function calCard(e) {
  const t = calWhen(e), d = suDate(e.date);
  const cuando = `${SU_DIA[d.getDay()]} ${SU_MES[d.getMonth()]} ${d.getDate()}${t ? ", " + hhmm(t) : ""}`;
  return `<div class="cal-tip-h"><b>${esc(calTitle(e))}</b>${calImpBars(e.imp)}</div>
    <div class="cal-tip-s">${esc(CAL_NOMBRE[e.country || "US"] || e.country)}, ${cuando}</div>
    <dl class="cal-tip-n"><div><dt>Actual</dt><dd>${calActual(e)}</dd></div>
    <div><dt>Forecast</dt><dd>${esc(e.forecast || "—")}</dd></div><div><dt>Previous</dt><dd>${esc(e.previous || "—")}</dd></div></dl>`;
}

let calTipEl = null;
function calTip(el) {
  const e = el && calEv.get(el.dataset.cal);
  if (!e) { if (calTipEl) calTipEl.hidden = true; return; }
  if (!calTipEl) { calTipEl = document.createElement("div"); calTipEl.className = "cal-tip"; calTipEl.setAttribute("role", "tooltip"); document.body.appendChild(calTipEl); }
  calTipEl.innerHTML = calCard(e);
  calTipEl.hidden = false;
  const r = el.getBoundingClientRect(), w = calTipEl.offsetWidth, h = calTipEl.offsetHeight;
  const x = Math.max(8, Math.min(r.left, innerWidth - w - 8));
  const y = r.bottom + 6 + h > innerHeight ? r.top - h - 6 : r.bottom + 6;
  calTipEl.style.left = `${x}px`; calTipEl.style.top = `${Math.max(8, y)}px`;
}
document.addEventListener("pointerover", (ev) => { if (ev.pointerType !== "touch") calTip(ev.target.closest("[data-cal]")); });
document.addEventListener("focusin", (ev) => calTip(ev.target.closest("[data-cal]")));
document.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-cal]");
  calTip(el && !(calTipEl && !calTipEl.hidden && calTipEl.dataset.k === el.dataset.cal) ? el : null);
  if (calTipEl) calTipEl.dataset.k = el && !calTipEl.hidden ? el.dataset.cal : "";
});
addEventListener("scroll", () => calTip(null), { passive: true, capture: true });
```

- [ ] **Step 3: Summary**

En `web/resumen.js:52`, la línea `const it = ...` pasa a:

```js
    const it = evs.filter((e) => e.date === x).map((e) => `<div class="ev i${e.imp}" data-cal="${calReg(e)}" tabindex="0"><span>${esc(e.name)}</span><i class="imp"><u></u><u></u><u></u></i><time>${nyHHMM(x + " " + e.time) || e.time}</time></div>`);
```

En `web/index.html`, tras `<script src="resumen.js"></script>`: `<script src="calendario.js"></script>`.

- [ ] **Step 4: Estilos**

En `web/sg.css`, tras `.su-day .none {...}`:

```css
.su-day .ev[data-cal] { cursor: default; }
.su-day .ev[data-cal]:hover span { color: var(--accent); }
/* tarjeta del calendario (Summary y Calendar) */
.cal-tip { position: fixed; z-index: 60; width: 260px; padding: 12px 14px; border-radius: 14px; background: var(--surface);
  border: 1px solid var(--line); box-shadow: 0 10px 30px rgba(0, 0, 0, .28); font-size: 13px; pointer-events: none; }
.cal-tip[hidden] { display: none; }
.cal-tip-h { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
.cal-tip-h b { font-weight: 700; }
.cal-tip-s { color: var(--faint); font-size: 12px; margin: 2px 0 10px; }
.cal-tip-n { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 0; }
.cal-tip-n dt { color: var(--faint); font-size: 11.5px; }
.cal-tip-n dd { margin: 2px 0 0; font-variant-numeric: tabular-nums; }
:is(.cal-tip, .caltable) .pos { color: var(--pos); }
:is(.cal-tip, .caltable) .neg { color: var(--neg); }
:is(.cal-tip, .caltable) .pend { color: var(--amber); font-weight: 500; }
:is(.cal-tip, .caltable) .imp { display: inline-flex; gap: 2px; align-items: flex-end; height: 12px; }
:is(.cal-tip, .caltable) .imp u { display: block; width: 3px; border-radius: 1px; background: var(--line-strong); }
:is(.cal-tip, .caltable) .imp u:nth-child(1) { height: 5px; }
:is(.cal-tip, .caltable) .imp u:nth-child(2) { height: 8px; }
:is(.cal-tip, .caltable) .imp u:nth-child(3) { height: 12px; }
:is(.cal-tip, .caltable) .imp.i1 u:nth-child(1), :is(.cal-tip, .caltable) .imp.i2 u:nth-child(-n+2) { background: var(--amber); }
:is(.cal-tip, .caltable) .imp.i3 u { background: var(--neg); }
```

- [ ] **Step 5: Comprobar**

`node --check web/calendario.js`, `node --check web/resumen.js` → sin salida. Con `gexlab-py` (preview_start):
Summary, pasar el ratón por un evento → tarjeta con título, país, hora local y las tres cifras; temas oscuro y
claro; móvil (tocar abre, tocar fuera cierra). Consola sin errores.

- [ ] **Step 6: Commit**

```bash
git add web/calendario.js web/resumen.js web/index.html web/sg.css
git commit -m "Summary: tarjeta con actual, forecast y previous en los eventos"
```

---

### Task 7: Página Calendar

**Files:**
- Modify: `web/calendario.js`, `web/index.html` (botón tras `navSummary`; vista tras el `</main>` de `sumView`), `web/app.js` (`TOOLS`, `NAV`, `currentNav`), `web/sg.css`

- [ ] **Step 1: Claves libres**

Run: `Select-String -Path web\*.js -Pattern '"calPaises"|"calImp"|"calendar"'` → sin resultados.

- [ ] **Step 2: HTML**

Tras el botón `navSummary`:

```html
      <button class="item" id="navCal" data-title="Calendar" title="Calendar"><svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="14" height="12.5" rx="2"/><path d="M3 8.5h14M7 3v3M13 3v3"/></svg><span class="lbl">Calendar</span></button>
```

Tras el `</main>` de `sumView`:

```html
<main class="macro cal" id="calView" hidden>
  <div class="scan-bar">
    <div class="cal-nav">
      <button class="btn" id="calPrev" aria-label="Previous week">‹</button>
      <button class="btn" id="calToday">Today</button>
      <button class="btn" id="calNext" aria-label="Next week">›</button>
      <span class="cal-week" id="calWeek"></span>
    </div>
    <details class="cal-paises" id="calPaisesBox">
      <summary class="btn">Countries <span id="calPaisesN"></span></summary>
      <div class="cal-paises-menu">
        <div class="cal-paises-all"><button class="btn" data-todos="1">All</button><button class="btn" data-todos="0">None</button></div>
        <div id="calPaises"></div>
      </div>
    </details>
    <div class="ctl inline">
      <span class="cap" id="capCalImp">Impact</span>
      <div class="seg boxed" role="radiogroup" aria-labelledby="capCalImp" id="calImpSeg">
        <button role="radio" data-v="1">All</button>
        <button role="radio" data-v="2">Medium+</button>
        <button role="radio" data-v="3">High</button>
      </div>
    </div>
    <div class="spacer"></div>
    <span class="scan-status" id="calStatus"></span>
  </div>
  <div class="tablewrap"><table class="caltable" id="calTable"></table></div>
</main>
```

- [ ] **Step 3: Página en `calendario.js`**

Añadir al final:

```js
// ------------------------------------------------------------ pagina Calendar
const cal = { data: null, at: 0, ctrl: null, lunes: null };
const calLunes = (iso) => { const d = suDate(iso); return suAdd(iso, -((d.getDay() + 6) % 7)); };
function calPaisesSel() {
  try { const a = JSON.parse(store.get("calPaises", "null")); if (Array.isArray(a)) return new Set(a); } catch { /* */ }
  return new Set(CAL_PAISES.map((p) => p[0]));
}
const calImpMin = () => +store.get("calImp", "2");
// fecha de hoy en Nueva York (YYYY-MM-DD)
function calHoyNY() { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date()); }

function showCal() {
  if (cal.data) renderCal();
  if (!cal.data || Date.now() - cal.at > 60000) loadCal();
}

async function loadCal(refresh = false) {
  if (cal.ctrl) cal.ctrl.abort();
  cal.ctrl = new AbortController();
  $("refreshBtn").classList.add("spin");
  if (!cal.data) $("calTable").innerHTML = `<tbody><tr><td class="empty">Loading the calendar…</td></tr></tbody>`;
  try {
    const r = await fetch("/api/calendario" + (refresh ? "?refresh=1" : ""), { signal: cal.ctrl.signal });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Could not load the calendar");
    cal.data = d; cal.at = Date.now();
    if (state.mode === "calendar") renderCal();
  } catch (e) {
    if (e.name === "AbortError") return;
    if (state.mode === "calendar") {
      $("calStatus").textContent = cal.data ? "Could not refresh" : "";
      if (!cal.data) $("calTable").innerHTML = `<tbody><tr><td class="empty">${esc(e.message === "Failed to fetch" ? "The local server is not responding. Open GEX Lab again." : e.message)}</td></tr></tbody>`;
    }
  } finally { $("refreshBtn").classList.remove("spin"); }
}

function renderCal() {
  const evs = (cal.data && cal.data.eventos) || [];
  const hoy = calHoyNY();
  if (!cal.lunes) cal.lunes = calLunes(hoy);
  const fin = suAdd(cal.lunes, 6), sel = calPaisesSel(), min = calImpMin();
  const lo = evs.length ? calLunes(evs[0].date) : cal.lunes, hi = evs.length ? evs[evs.length - 1].date : fin;
  $("calPrev").disabled = cal.lunes <= lo; $("calNext").disabled = fin >= hi;
  const a = suDate(cal.lunes), b = suDate(fin);
  $("calWeek").textContent = `${SU_MES[a.getMonth()]} ${a.getDate()} to ${SU_MES[b.getMonth()]} ${b.getDate()}`;
  $("calPaisesN").textContent = sel.size === CAL_PAISES.length ? "(all)" : `(${sel.size})`;
  $("calPaises").innerHTML = CAL_PAISES.map(([c, n]) => `<label><input type="checkbox" value="${c}"${sel.has(c) ? " checked" : ""}> ${esc(n)}</label>`).join("");
  document.querySelectorAll("#calImpSeg button").forEach((x) => x.setAttribute("aria-checked", String(+x.dataset.v === min)));
  const vis = evs.filter((e) => e.date >= cal.lunes && e.date <= fin && sel.has(e.country || "US") && e.imp >= min);
  const ahora = new Date(), prox = vis.find((e) => { const t = calWhen(e); return t && t > ahora; });
  let html = `<thead><tr><th>Time</th><th>Country</th><th>Event</th><th>Impact</th><th>Actual</th><th>Forecast</th><th>Previous</th></tr></thead>`;
  for (let i = 0; i < 7; i++) {
    const x = suAdd(cal.lunes, i), dia = vis.filter((e) => e.date === x);
    if (!dia.length) continue;
    const D = suDate(x);
    html += `<tbody${x === hoy ? ' class="hoy"' : ""}><tr class="cal-dia"><th colspan="7">${x === hoy ? "Today, " : ""}${SU_DIA[D.getDay()]} ${SU_MES[D.getMonth()]} ${D.getDate()}</th></tr>`
      + dia.map((e) => { const t = calWhen(e);
        return `<tr data-cal="${calReg(e)}" class="i${e.imp}${e === prox ? " prox" : ""}"><td class="num">${t ? hhmm(t) : "All day"}</td><td><span class="cal-pais">${esc(e.country || "US")}</span></td>`
          + `<td class="cal-ev">${esc(calTitle(e))}<span class="cal-fp">F ${esc(e.forecast || "—")}, P ${esc(e.previous || "—")}</span></td><td>${calImpBars(e.imp)}</td>`
          + `<td class="num">${calActual(e)}</td><td class="num cal-f">${esc(e.forecast || "—")}</td><td class="num cal-f">${esc(e.previous || "—")}</td></tr>`; }).join("")
      + `</tbody>`;
  }
  if (!vis.length) html += `<tbody><tr><td class="empty" colspan="7">No releases for these countries and impact this week.</td></tr></tbody>`;
  $("calTable").innerHTML = html;
  // actualizado: "YYYY-MM-DD HH:MM" en UTC
  $("calStatus").textContent = cal.data && cal.data.actualizado ? `Updated ${localTime(cal.data.actualizado.replace(" ", "T") + ":00Z", true)}` : "";
}

function bindCal() {
  $("calPrev").addEventListener("click", () => { cal.lunes = suAdd(cal.lunes, -7); renderCal(); });
  $("calNext").addEventListener("click", () => { cal.lunes = suAdd(cal.lunes, 7); renderCal(); });
  $("calToday").addEventListener("click", () => { cal.lunes = null; renderCal(); });
  $("calPaises").addEventListener("change", () => {
    store.set("calPaises", JSON.stringify([...document.querySelectorAll("#calPaises input:checked")].map((x) => x.value)));
    renderCal();
  });
  document.querySelector(".cal-paises-all").addEventListener("click", (e) => {
    const b = e.target.closest("[data-todos]");
    if (!b) return;
    store.set("calPaises", JSON.stringify(b.dataset.todos === "1" ? CAL_PAISES.map((p) => p[0]) : []));
    renderCal();
  });
  $("calImpSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]");
    if (b) { store.set("calImp", b.dataset.v); renderCal(); }
  });
  document.addEventListener("click", (e) => { const d = $("calPaisesBox"); if (d.open && !d.contains(e.target)) d.open = false; });
  // abierta: se recarga cada minuto (el motor publica el dato real un par de minutos despues del evento)
  setInterval(() => { if (state.mode === "calendar" && !document.hidden) loadCal(); }, 60000);
}
document.addEventListener("DOMContentLoaded", bindCal);
```

Nota: la semana de ForexFactory va de domingo a sábado; la página empieza en lunes, así que los eventos del
domingo (Asia) salen en la semana anterior. Se acepta.

- [ ] **Step 4: `app.js`**

En `TOOLS`:

```js
  calendar: { view: "calView", ticker: false, show: () => showCal(), render: () => renderCal(), load: (r) => loadCal(r) },
```

En `NAV`, tras `navSummary`:

```js
  navCal: { t: "Calendar", go: () => setMode("calendar") },
```

En `currentNav`, tras la línea de `summary`:

```js
  if (m === "calendar") return "navCal";
```

`setMode` ya llama a `tool.show()` (`app.js:2182`) y el arranque restaura el modo si está en `TOOLS`.

- [ ] **Step 5: Estilos**

En `web/sg.css`, tras los de la tarjeta:

```css
/* pagina Calendar */
.cal-nav { display: flex; align-items: center; gap: 6px; }
.cal-week { margin-left: 8px; font-weight: 700; }
.cal-paises { position: relative; }
.cal-paises > summary { list-style: none; cursor: pointer; }
.cal-paises > summary::-webkit-details-marker { display: none; }
.cal-paises-menu { position: absolute; z-index: 50; top: calc(100% + 6px); left: 0; min-width: 220px; padding: 10px 12px;
  border-radius: 14px; background: var(--surface); border: 1px solid var(--line); box-shadow: 0 10px 30px rgba(0, 0, 0, .28); }
.cal-paises-all { display: flex; gap: 6px; margin-bottom: 8px; }
#calPaises label { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 13px; cursor: pointer; }
.caltable { width: 100%; border-collapse: collapse; font-size: 13px; }
.caltable th, .caltable td { padding: 8px 10px; text-align: left; border-top: 1px solid var(--line-soft); }
.caltable thead th { color: var(--faint); font-weight: 500; font-size: 12px; border-top: 0; }
.caltable .num { font-variant-numeric: tabular-nums; white-space: nowrap; }
.caltable .cal-dia th { padding-top: 16px; font-size: 13px; color: var(--muted); }
.caltable tbody.hoy .cal-dia th { color: var(--accent); }
.caltable tr.i1 .cal-ev { color: var(--muted); }
.caltable tr.i3 .cal-ev { font-weight: 700; }
.caltable tr.prox td { background: color-mix(in srgb, var(--accent) 7%, transparent); }
.caltable tr.prox td:first-child { box-shadow: inset 2px 0 0 var(--accent); }
.cal-pais { font-size: 11.5px; font-weight: 700; padding: 2px 6px; border-radius: 6px; background: var(--surface-2); color: var(--muted); }
.cal-fp { display: none; }
@media (max-width: 720px) {
  .caltable .cal-f, .caltable thead th:nth-child(n+6) { display: none; }
  .cal-fp { display: block; font-size: 12px; color: var(--faint); font-weight: 400; margin-top: 2px; }
  .caltable th, .caltable td { padding: 7px 6px; }
}
```

- [ ] **Step 6: Comprobar**

`node --check web/calendario.js`, `node --check web/app.js` → sin salida. Con `gexlab-py`:
- Barra lateral: `Calendar` bajo Summary; título "Calendar" y la semana actual.
- Flechas y `Today`; se desactivan en los bordes del rango.
- `Countries`: quitar Japan y China, recargar: siguen quitados. `None` → mensaje; `All` → todos.
- `Impact`: `High` deja solo los de 3 barras. Tarjeta al pasar el ratón por una fila.
- Temas Bento y Daylight; móvil (resize_window mobile) sin scroll horizontal.
- TRACE, Equity Hub y Volatility dashboard siguen bien (globales compartidos). Consola sin errores.

- [ ] **Step 7: Commit**

```bash
git add web/calendario.js web/index.html web/app.js web/sg.css
git commit -m "Pagina Calendar con filtro de paises e importancia"
```

---

### Task 8: Documentación, fusión, despliegue y prueba real

**Files:** `docs/ARQUITECTURA.md`, `CLAUDE.md`, `CHANGELOG.md`

- [ ] **Step 1: Documentación**

`docs/ARQUITECTURA.md`, en los crons del Worker:

```markdown
  - alarma del calendario (Durable Object `RelojCalendario`, binding `RELOJ`): el cron */5 le pasa
    `pub/eventos_horas.json` (hora de cada evento de importancia 2+ de hoy y mañana + 1 min, y reintentos a
    +6, 16, 31, 61 y 121 min mientras falte el dato real) y la alarma lanza `motor.yml` con `modo=calendario`
    (solo el dato real, BLS y FRED; sin tickers ni ForexFactory).
```

Claves de R2: `estado/eventos.json` (estado del calendario, fuera del tar), `pub/calendario.json`,
`pub/eventos_horas.json`. Secretos: `BLS_API_KEY` (opcional, API de BLS). Fuentes del calendario: ForexFactory
(semana en curso, una petición por hora como mucho), oficiales de EE. UU., BLS y FRED (dato real).

`CLAUDE.md`, Mapa: `eventos.py` (calendario macro: ForexFactory + fuentes oficiales de EE. UU.), `reales.py`
(dato real con BLS y FRED) y en `web/` `calendario.js` (tarjeta de eventos y página Calendar).

- [ ] **Step 2: Fusión con `main`**

```bash
git fetch origin
git rebase origin/main
```

Si hay conflicto en `CHANGELOG.md`, quedarse con la entrada del día de `main` y ampliarla (Step 3). Pruebas tras
el rebase: `py pruebas\test_eventos.py`, `py pruebas\test_reales.py`, `node --check` de `web\app.js`,
`web\calendario.js`, `web\resumen.js`, `web\nube.js`, `nube\worker.js`; `py -c "import gex_engine, eventos, reales, motor, server"`.

- [ ] **Step 3: CHANGELOG**

En la entrada del día (crearla arriba si no existe), añadir:

```markdown
### Añadido
- Página Calendar: EE. UU., zona euro, Alemania, Francia, Italia, Reino Unido, Japón, China, Canadá, Australia y
  Suiza con importancia, consenso y anterior (ForexFactory, semana en curso) y dato real de EE. UU. (BLS al
  minuto; FRED para el resto). Filtro de países e importancia que se recuerda.
- Tarjeta en los eventos del Summary con Actual, Forecast y Previous.
- Una alarma del Worker lanza un ciclo solo del calendario a la hora de cada evento + 1 min, con reintentos
  mientras falte el dato real.

### Cambiado
- El calendario guarda su estado aparte del resto del motor.
```

- [ ] **Step 4: Commit y push (con permiso del usuario)**

```bash
git add docs/ARQUITECTURA.md CLAUDE.md CHANGELOG.md
git commit -m "Docs: calendario economico"
git push origin calendario:main
```

Comprobar el despliegue (crea el Durable Object):
`gh api "repos/LoppVicious/gexlab/actions/runs?per_page=3" --jq '.workflow_runs[] | [.name,.status,.conclusion] | @tsv'`

- [ ] **Step 5: Prueba real**

1. `gh api -X POST repos/LoppVicious/gexlab/actions/workflows/motor.yml/dispatches -f ref=main -f 'inputs[modo]=calendario'`;
   log: `calendario: N datos reales nuevos`, `0 errores`.
2. Siguiente ciclo de 15 min (VERSION 5: refresco completo): Ctrl+F5 en la web; Summary con tarjeta; Calendar con
   los países de la semana.
3. Próximo evento de EE. UU. de importancia 2+ con dato real: run `Motor calendario` entre T+1 y T+2 min y el
   actual en la tarjeta (BLS) o en un reintento (FRED).
4. Si la alarma no salta: panel de Cloudflare, Workers, `dashboard`, Durable Objects: `RelojCalendario`.
