# Report semanal: plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/report-semanal` en Claude Code lanza un workflow que calcula un paquete de datos y gráficos de la semana,
y Claude Code redacta con él un borrador de Founder Take que el admin revisa y publica.

**Architecture:** `report_semanal.py` (Actions) lee `hist500/` de R2, FRED y las webs de los emisores de ETFs; los
cálculos puros están en `report_calc.py` y los gráficos en `report_graficos.py`. Deja `report/{F}/paquete.json`,
los PNG y `report/ultimo.json` en R2. El Worker sirve eso y crea el borrador por `/api/report/*` (`nube/report.js`)
con un token propio, reutilizando la validación y la escritura de `nube/takes.js`. El skill del proyecto
`.claude/skills/report-semanal/` orquesta todo desde el PC.

**Tech Stack:** Python 3.12 (numpy, matplotlib solo en Actions), Cloudflare Worker (JS), D1, R2, GitHub Actions,
`gh api`, `curl`.

Spec: `docs/superpowers/specs/2026-11-13-report-semanal-design.md`.

---

## Mapa de archivos

| Archivo | Qué hace |
|---|---|
| `pruebas/prueba_etf_aum.py` (nuevo) | Prueba en Actions de las fuentes de participaciones/AUM de ProShares y Direxion |
| `report_calc.py` (nuevo) | Cálculos puros y umbrales de destacado de los cuatro bloques |
| `report_graficos.py` (nuevo) | PNG con matplotlib (paleta Daylight) |
| `report_semanal.py` (nuevo) | Lectura de R2/FRED/emisores, armado del paquete, escritura en R2, CLI |
| `pruebas/test_report.py` (nuevo) | Pruebas sin red de `report_calc.py` y del armado del paquete |
| `.github/workflows/report.yml` (nuevo) | `workflow_dispatch` que ejecuta `report_semanal.py` |
| `nube/takes.js` (cambia) | Se extrae `escribirTake` de `guardar`, con limpieza si falla a mitad |
| `nube/report.js` (nuevo) | Rutas `/api/report/*` con `REPORT_TOKEN` |
| `nube/worker.js` (cambia) | Enruta `/api/report/` antes de la sesión |
| `pruebas/test_report_api.mjs` (nuevo) | Pruebas de las rutas con D1 y R2 imitados |
| `pruebas/test_takes_api.mjs` (cambia) | Prueba de la limpieza de `escribirTake` |
| `nube/desplegar.sh`, `.github/workflows/desplegar.yml` (cambian) | Secreto `REPORT_TOKEN` del Worker |
| `.claude/skills/report-semanal/SKILL.md`, `guia-estilo.md` (nuevos) | El arranque y la guía de redacción |
| `docs/ARQUITECTURA.md`, `CLAUDE.md`, `docs/ESTADO.md`, `CHANGELOG.md` (cambian) | Documentación |

Comandos de prueba (PowerShell o Git Bash, desde `gexlab/`):
- Python: `.venv/Scripts/python.exe pruebas/test_report.py`
- JS: `node --test pruebas/test_takes.mjs pruebas/test_takes_api.mjs pruebas/test_report_api.mjs`
- Sintaxis: `node --check nube/report.js`, `node --check nube/takes.js`, `node --check nube/worker.js`

---

### Task 1: Prueba de la fuente de AUM de los ETFs apalancados

Decide si el bloque `etf_apal` puede tener datos. Se hace primero porque condiciona el parser de la Task 6.

**Files:**
- Create: `pruebas/prueba_etf_aum.py`

- [ ] **Step 1: Escribir la prueba**

```python
"""Prueba en Actions (comparar.yml): de donde sacar los activos (participaciones x NAV) de los ETFs apalancados.
Imprime las primeras lineas de cada fuente para fijar el parser de report_semanal.aum_etf.
Uso: gh api -X POST repos/LoppVicious/gexlab/actions/workflows/comparar.yml/dispatches -f ref=main -f 'inputs[script]=prueba_etf_aum.py'"""
import ssl
import urllib.request

FUENTES = {
    "TQQQ": "https://accounts.profunds.com/etfdata/ByFund/TQQQ-historical_nav.csv",
    "SQQQ": "https://accounts.profunds.com/etfdata/ByFund/SQQQ-historical_nav.csv",
    "SOXL": "https://www.direxion.com/holdings/SOXL.csv",
    "TNA": "https://www.direxion.com/holdings/TNA.csv",
}

for sym, url in FUENTES.items():
    print(f"===== {sym} {url}")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=25, context=ssl.create_default_context()) as r:
            txt = r.read().decode("utf-8", "replace")
        lineas = txt.splitlines()
        print(f"{len(lineas)} lineas")
        for ln in lineas[:12]:
            print("  ", ln[:200])
    except Exception as e:  # noqa: BLE001
        print(f"ERROR {type(e).__name__}: {str(e)[:200]}")
```

- [ ] **Step 2: Subir y ejecutar en Actions**

```bash
git add pruebas/prueba_etf_aum.py
git commit -m "Report semanal: prueba de fuentes de AUM de ETFs apalancados

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

El push a `main` lo hace el usuario o se pide su OK (ver CLAUDE.md: cada push lleva su entrada en `CHANGELOG.md`;
si se sube solo esta prueba, añadir en el mismo commit la línea «Prueba de fuentes de AUM de ETFs apalancados» en
Añadido de la entrada del día). Después:

```bash
gh api -X POST repos/LoppVicious/gexlab/actions/workflows/comparar.yml/dispatches -f ref=main -f 'inputs[script]=prueba_etf_aum.py'
```

Leer el log de la ejecución (`gh api repos/LoppVicious/gexlab/actions/runs?per_page=1`, luego
`gh api repos/LoppVicious/gexlab/actions/runs/<id>/logs` o la web).

- [ ] **Step 3: Anotar el resultado**

Esperado: ProShares devuelve un CSV con una cabecera que incluye `NAV` y `Shares Outstanding` (o
`Assets Under Management`); Direxion, un CSV con una línea `Shares Outstanding: <n>` y otra con el NAV o el total
de activos. Apuntar en este plan, debajo de este paso, los nombres exactos de columnas y líneas que salgan. Si alguna
fuente da error o no trae participaciones, sus ETFs quedarán en `sin_aum`; si ninguna sirve, el bloque saldrá
siempre `ausente` y se anota en `docs/ESTADO.md` (Task 11).

**Resultado (2026-11-13, ejecutada en local: son webs públicas):** ProShares da `Date` (`MM/DD/YYYY`) y
`Assets Under Management` por día, más reciente arriba. Direxion no da NAV: cabecera con
`Shares Outstanding:<n>` y luego las posiciones con `MarketValue` y `HoldingsPercent`; el AUM se saca como
`MarketValue x 100 / HoldingsPercent` de la posición mayor (`_aum_direxion` cambia respecto a la Task 6).
Valores reales: TQQQ 33.600 M$, SOXL 17.300 M$, TNA 1.180 M$.

---

### Task 2: `report_calc.py`, utilidades y bloque de vol realizada

**Files:**
- Create: `report_calc.py`
- Create: `pruebas/test_report.py`

- [ ] **Step 1: Escribir las pruebas que fallan**

`pruebas/test_report.py`:

```python
"""Pruebas sin red del report semanal: report_calc.py y el armado del paquete de report_semanal.py.
Uso: .venv/Scripts/python.exe pruebas/test_report.py"""
import math
import os
import sys
from datetime import date, timedelta

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import report_calc as rc  # noqa: E402


def laborables(n, desde="2024-01-01"):
    out, d = [], date.fromisoformat(desde)
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += timedelta(days=1)
    return out


def cierres(fechas, rets, inicio=100.0):
    """[(fecha, cierre)] con el primer cierre = inicio y luego cada retorno."""
    out, c = [(fechas[0], inicio)], inicio
    for f, r in zip(fechas[1:], rets):
        c *= 1 + r
        out.append((f, c))
    return out


def test_percentil():
    assert rc.percentil(5, list(range(1, 11))) == 50.0
    assert rc.percentil(0, [1, 2]) == 0.0
    assert rc.percentil(None, [1]) is None and rc.percentil(1, []) is None
    assert rc.extremo(10) and rc.extremo(90) and not rc.extremo(50) and not rc.extremo(None)


def test_vol_sub_baj():
    v = rc.vol_sub_baj([0.01, -0.02, 0.01, -0.02])
    assert v == {"sube": 15.9, "baja": 31.7, "cociente": 0.5}, v
    v = rc.vol_sub_baj([0.01])
    assert v["baja"] is None and v["cociente"] is None
    assert rc.vol_anual([0.01, -0.01]) == 15.9


def test_bloque_vol_real():
    f = laborables(420)
    hist = [0.005 if i % 2 else -0.005 for i in range(414)]
    semana = [0.001, -0.03, 0.001, -0.03, 0.001]
    rets = hist + semana
    spx = cierres(f, rets)
    vix = cierres(f, [-r * 3 for r in rets], 20.0)
    b = rc.bloque_vol_real({"SPX": spx}, vix, f[-5:])
    d = b["datos"]["SPX"]
    assert d["semana"]["cociente"] is not None and d["semana"]["cociente"] < 0.1, d["semana"]
    assert d["semana"]["pct"] == 0.0
    assert d["rvol20"]["pct"] == 100.0
    assert b["destacado"] and any("subida/bajada" in x for x in b["por_que"]), b["por_que"]
    assert len(d["mensual"]) <= 24 and d["mensual"][-1][0] == f[-1][:7]


if __name__ == "__main__":
    for nombre, fn in list(globals().items()):
        if nombre.startswith("test_") and callable(fn):
            fn()
            print("ok", nombre)
```

- [ ] **Step 2: Ejecutar y ver que falla**

Run: `.venv/Scripts/python.exe pruebas/test_report.py`
Expected: `ModuleNotFoundError: No module named 'report_calc'`

- [ ] **Step 3: Implementar**

`report_calc.py`:

```python
"""Calculos puros del report semanal, sin red ni R2. Los usa report_semanal.py; pruebas en pruebas/test_report.py.
Bloques: gamma y niveles, vol realizada y spot-vol, rebalanceo de ETFs apalancados y vol a strike fijo.
Cada bloque devuelve {"destacado": bool, "por_que": [textos], "datos": {...}}. Los umbrales son fijos (spec del
2026-11-13) para que lo que entra en el report no dependa del LLM."""
from __future__ import annotations

import math
from datetime import date

import numpy as np

P_BAJO, P_ALTO = 10, 90        # percentiles extremos (gamma neta, cociente subida/bajada, spot-vol)
P_RVOL = 85                    # vol realizada a 20 sesiones
P_REBAL = 90                   # rebalanceo de ETFs apalancados (dia o semana, en valor absoluto)
UMBRAL_WALL = 0.02             # movimiento relativo de una wall en la semana
UMBRAL_ATM_1M = 1.5            # puntos de IV ATM a 1 mes, a strike fijo
UMBRAL_SKEW_1M = 1.0           # puntos de skew 25P-25C a 1 mes


def _r(x, n=1):
    return None if x is None or not math.isfinite(x) else round(float(x), n)


def percentil(x, serie):
    """Percentil (0-100) de x en la serie: % de valores <= x. None sin dato o sin serie."""
    if x is None or not math.isfinite(x):
        return None
    s = np.asarray([v for v in serie if v is not None and math.isfinite(v)], dtype=float)
    if not s.size:
        return None
    return round(100.0 * float((s <= x).mean()), 1)


def extremo(p, bajo=P_BAJO, alto=P_ALTO) -> bool:
    return p is not None and (p <= bajo or p >= alto)


def retornos(cierres):
    """[(fecha, cierre)] ordenado -> [(fecha, retorno simple)]."""
    return [(cierres[i][0], cierres[i][1] / cierres[i - 1][1] - 1)
            for i in range(1, len(cierres)) if cierres[i - 1][1]]


def vol_anual(rs):
    """Vol realizada anualizada en % (media cero, 252 sesiones)."""
    return _r(100 * math.sqrt(252 * sum(r * r for r in rs) / len(rs))) if rs else None


def vol_sub_baj(rs):
    """Vol realizada de los dias de subida y de los de bajada, y su cociente."""
    s = vol_anual([r for r in rs if r > 0])
    b = vol_anual([r for r in rs if r < 0])
    return {"sube": s, "baja": b, "cociente": _r(s / b, 2) if s and b else None}


def correlacion(a, b):
    if len(a) < 5:
        return None
    a, b = np.asarray(a, float), np.asarray(b, float)
    if a.std() == 0 or b.std() == 0:
        return None
    return float(np.corrcoef(a, b)[0, 1])


def _semana_iso(f):
    y, w, _ = date.fromisoformat(f).isocalendar()
    return y, w


def bloque_vol_real(indices: dict, vix: list, sesiones: list) -> dict:
    """indices: {nombre: [(fecha, cierre)]}; vix: [(fecha, cierre)]; sesiones: las de la semana del report."""
    ultimo, sem, mes = sesiones[-1], set(sesiones), sesiones[-1][:7]
    actual = _semana_iso(ultimo)
    dvix = {f: c - p for (_, p), (f, c) in zip(vix, vix[1:])}
    datos, por_que = {}, []
    for nombre, serie in indices.items():
        rs = [(f, r) for f, r in retornos(serie) if f <= ultimo]
        if len(rs) < 300:
            raise ValueError(f"Serie de {nombre} demasiado corta ({len(rs)} sesiones)")
        por_sem, por_mes = {}, {}
        for f, r in rs:
            if _semana_iso(f) != actual:
                por_sem.setdefault(_semana_iso(f), []).append(r)
            if f[:7] != mes:
                por_mes.setdefault(f[:7], []).append(r)
        vs = vol_sub_baj([r for f, r in rs if f in sem])
        vm = vol_sub_baj([r for f, r in rs if f[:7] == mes])
        vs["pct"] = percentil(vs["cociente"], [vol_sub_baj(v)["cociente"] for v in por_sem.values()])
        vm["pct"] = percentil(vm["cociente"], [vol_sub_baj(v)["cociente"] for v in por_mes.values()])
        solo = [r for _, r in rs]
        v20 = [vol_anual(solo[i - 20:i]) for i in range(20, len(solo) + 1)]
        rv = {"valor": v20[-1], "pct": percentil(v20[-1], v20[:-1])}
        par = [(r, dvix[f]) for f, r in rs if f in dvix]
        c20 = [correlacion([p[0] for p in par[i - 20:i]], [p[1] for p in par[i - 20:i]]) for i in range(20, len(par) + 1)]
        cv = {"valor": _r(c20[-1], 2) if c20 else None, "pct": percentil(c20[-1], c20[:-1]) if c20 else None}
        mensual = [[m, vol_sub_baj(v)["sube"], vol_sub_baj(v)["baja"]] for m, v in sorted(por_mes.items())[-23:]]
        mensual.append([mes, vm["sube"], vm["baja"]])
        datos[nombre] = {"semana": vs, "mes": vm, "rvol20": rv, "corr_spot_vol_20": cv, "mensual": mensual}
        if extremo(vs["pct"]):
            por_que.append(f"{nombre}: cociente vol subida/bajada de la semana {vs['cociente']} (percentil {vs['pct']})")
        if extremo(vm["pct"]):
            por_que.append(f"{nombre}: cociente vol subida/bajada del mes {vm['cociente']} (percentil {vm['pct']})")
        if rv["pct"] is not None and rv["pct"] >= P_RVOL:
            por_que.append(f"{nombre}: vol realizada a 20 sesiones {rv['valor']}% (percentil {rv['pct']})")
        if extremo(cv["pct"]):
            por_que.append(f"{nombre}: correlacion spot-vol a 20 sesiones {cv['valor']} (percentil {cv['pct']})")
    return {"destacado": bool(por_que), "por_que": por_que, "datos": datos}
```

- [ ] **Step 4: Ejecutar y ver que pasa**

Run: `.venv/Scripts/python.exe pruebas/test_report.py`
Expected: `ok test_percentil`, `ok test_vol_sub_baj`, `ok test_bloque_vol_real`

- [ ] **Step 5: Commit**

```bash
git add report_calc.py pruebas/test_report.py
git commit -m "Report semanal: calculos de vol realizada y spot-vol con pruebas

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Bloque de rebalanceo de ETFs apalancados

**Files:**
- Modify: `report_calc.py` (añadir al final)
- Modify: `pruebas/test_report.py` (añadir antes del `if __name__`)

- [ ] **Step 1: Pruebas que fallan**

```python
def test_rebalanceo():
    assert math.isclose(rc.rebalanceo(1e9, 3, 0.01), 6e7)
    assert math.isclose(rc.rebalanceo(1e9, -3, 0.01), 1.2e8)


def test_bloque_etf():
    f = laborables(300)
    rets = [0.001 if i % 2 else -0.001 for i in range(294)] + [0.03] * 5
    b = rc.bloque_etf({"TQQQ": 2e10, "SQQQ": 5e9, "UPRO": 1e10}, {"QQQ": cierres(f, rets)}, f[-5:])
    d = b["datos"]
    assert d["dias"][-1]["total"] == round(rc.rebalanceo(2e10, 3, 0.03) + rc.rebalanceo(5e9, -3, 0.03)), d["dias"][-1]
    assert d["dias"][-1]["pct"] == 100.0 and d["semana"]["pct"] == 100.0
    assert "SOXL" in d["sin_aum"] and "UPRO" in d["sin_subyacente"]
    assert b["destacado"]
    try:
        rc.bloque_etf({}, {"QQQ": cierres(f, rets)}, f[-5:])
        raise AssertionError("sin AUM deberia fallar")
    except ValueError:
        pass
```

- [ ] **Step 2: Ver que falla**

Run: `.venv/Scripts/python.exe pruebas/test_report.py`
Expected: `AttributeError: module 'report_calc' has no attribute 'rebalanceo'`

- [ ] **Step 3: Implementar** (al final de `report_calc.py`)

```python
# ------------------------------------------------------------------ ETFs apalancados
ETF_APAL = {  # ETF: (ETF 1x del subyacente guardado en hist500, apalancamiento)
    "TQQQ": ("QQQ", 3), "SQQQ": ("QQQ", -3), "QLD": ("QQQ", 2),
    "UPRO": ("SPY", 3), "SPXL": ("SPY", 3), "SPXU": ("SPY", -3), "SSO": ("SPY", 2),
    "SOXL": ("SOXX", 3), "SOXS": ("SOXX", -3),
    "TNA": ("IWM", 3), "TZA": ("IWM", -3),
}


def rebalanceo(aum, L, r):
    """Dolares que el ETF compra (+) o vende (-) al cierre para volver a su apalancamiento: AUM x L x (L-1) x r."""
    return aum * L * (L - 1) * r


def bloque_etf(aum: dict, spots: dict, sesiones: list) -> dict:
    """aum: {ETF: dolares}; spots: {ETF 1x: [(fecha, cierre)]}. Percentiles frente a 252 sesiones con el AUM actual."""
    con_aum = {e: a for e, a in aum.items() if e in ETF_APAL and a}
    if not con_aum:
        raise ValueError("Sin AUM de ningun ETF apalancado")
    rets = {s: dict(retornos(c)) for s, c in spots.items()}
    usados = {e: a for e, a in con_aum.items() if ETF_APAL[e][0] in rets}
    if not usados:
        raise ValueError("Sin precios de los subyacentes de los ETFs apalancados")

    def por_indice(f):
        out = {}
        for e, a in usados.items():
            sub, L = ETF_APAL[e]
            r = rets[sub].get(f)
            if r is not None:
                out[sub] = out.get(sub, 0.0) + rebalanceo(a, L, r)
        return out

    fechas = sorted({f for d in rets.values() for f in d if f < sesiones[0]})[-252:]
    tot = [sum(por_indice(f).values()) for f in fechas]
    abs_dia = [abs(x) for x in tot]
    abs_sem = [abs(sum(tot[i - len(sesiones):i])) for i in range(len(sesiones), len(tot) + 1)]
    dias, por_que = [], []
    for f in sesiones:
        p = por_indice(f)
        t = sum(p.values())
        dias.append({"fecha": f, "por_indice": {k: round(v) for k, v in p.items()}, "total": round(t),
                     "pct": percentil(abs(t), abs_dia)})
        if dias[-1]["pct"] is not None and dias[-1]["pct"] >= P_REBAL:
            por_que.append(f"{f}: rebalanceo estimado {t / 1e9:+.1f} mil millones (percentil {dias[-1]['pct']})")
    st = sum(d["total"] for d in dias)
    semana = {"total": st, "pct": percentil(abs(st), abs_sem)}
    if semana["pct"] is not None and semana["pct"] >= P_REBAL:
        por_que.append(f"Semana: rebalanceo acumulado {st / 1e9:+.1f} mil millones (percentil {semana['pct']})")
    return {"destacado": bool(por_que), "por_que": por_que, "datos": {
        "dias": dias, "semana": semana, "aum": {e: round(a) for e, a in usados.items()},
        "sin_aum": sorted(set(ETF_APAL) - set(con_aum)), "sin_subyacente": sorted(set(con_aum) - set(usados)),
        "nota": "Percentiles frente a 252 sesiones con el AUM actual: no hay historico de AUM"}}
```

- [ ] **Step 4: Ver que pasa**

Run: `.venv/Scripts/python.exe pruebas/test_report.py`
Expected: todas las líneas `ok`, incluidas `test_rebalanceo` y `test_bloque_etf`.

- [ ] **Step 5: Commit**

```bash
git add report_calc.py pruebas/test_report.py
git commit -m "Report semanal: rebalanceo de ETFs apalancados con pruebas

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Bloques de vol a strike fijo y de gamma

**Files:**
- Modify: `report_calc.py` (añadir al final)
- Modify: `pruebas/test_report.py`

La cadena que reciben estas funciones es la de `gex_engine.chain_from_min` (arrays numpy): `K`, `call` (bool),
`exp` (`datetime64[m]` por contrato), `iv` (decimal, 0.20 = 20 %), `delta`, `fwd` (por contrato) y `spot`.

- [ ] **Step 1: Pruebas que fallan**

```python
def cadena(iv_base, sesion="2026-11-13", dte=30):
    K = np.arange(80.0, 121.0)
    n = K.size
    dc = np.clip(0.5 - (K - 100) * 0.025, 0.01, 0.99)
    iv = iv_base + 0.002 * (100 - K)
    exp = np.datetime64(sesion, "D") + np.timedelta64(dte, "D")
    return {"K": np.concatenate([K, K]), "call": np.array([True] * n + [False] * n),
            "exp": np.array([exp.astype("datetime64[m]") + np.timedelta64(16 * 60, "m")] * (2 * n)),
            "iv": np.concatenate([iv, iv]), "delta": np.concatenate([dc, dc - 1]),
            "fwd": np.full(2 * n, 100.0), "spot": 100.0}


def test_bloque_vol_strike():
    b = rc.bloque_vol_strike({"SPY": (cadena(0.20), cadena(0.18))}, "2026-11-13")
    filas = b["datos"]["SPY"]
    assert [f["tenor"] for f in filas] == ["1m"], filas
    c = filas[0]["celdas"]
    assert c["25P"]["strike"] == 90.0 and c["25P"]["iv"] == 22.0, c["25P"]
    assert c["50"]["cambio"] == 2.0 and filas[0]["skew_25_cambio"] == 0.0, (c["50"], filas[0])
    assert b["destacado"] and "ATM" in b["por_que"][0]


def test_bloque_gamma():
    s = lambda spot, flip, cw: {"spot": spot, "flip": flip, "call_wall": cw, "put_wall": 95.0, "net_per_pct": 0.5}
    semanas = {"SPY": {"previa": ("2026-11-06", s(100.0, 99.0, 105.0)),
                       "dias": [("2026-11-09", s(101.0, 99.0, 105.0)), ("2026-11-10", s(98.0, 99.0, 110.0))]}}
    b = rc.bloque_gamma(semanas, {"SPY": [float(x) for x in range(1, 101)]})
    d = b["datos"]["SPY"]
    assert d["regimen"] == "negativa" and d["cruces"] == [{"fecha": "2026-11-10", "a": "negativa"}], d
    assert d["cambio"]["call_wall"] == 4.8 and d["net_pct"] == 0.0, d
    assert b["destacado"] and len(b["por_que"]) == 3, b["por_que"]
```

- [ ] **Step 2: Ver que falla**

Run: `.venv/Scripts/python.exe pruebas/test_report.py`
Expected: `AttributeError: module 'report_calc' has no attribute 'bloque_vol_strike'`

- [ ] **Step 3: Implementar** (al final de `report_calc.py`)

```python
# ------------------------------------------------------------------ vol a strike fijo
TENORES = (("1w", 7), ("2w", 14), ("1m", 30), ("2m", 61), ("3m", 91), ("6m", 182), ("1y", 365))
DELTAS = (("10P", -0.10), ("25P", -0.25), ("40P", -0.40), ("50", None), ("40C", 0.40), ("25C", 0.25), ("10C", 0.10))


def _serie(ch, x, call):
    m = (ch["exp"] == x) & (ch["call"] == call) & (ch["iv"] > 0.01) & np.isfinite(ch["delta"])
    o = np.argsort(ch["K"][m])
    return ch["K"][m][o], ch["iv"][m][o], ch["delta"][m][o]


def strike_de_delta(ch, x, d):
    """Strike del vencimiento x con esa delta (interpolada); d None = ATM (el forward del vencimiento)."""
    if d is None:
        fw = ch["fwd"][ch["exp"] == x]
        return float(fw[0]) if fw.size else float(ch["spot"])
    K, _, de = _serie(ch, x, d > 0)
    if K.size < 2:
        return None
    o = np.argsort(de)
    if not (de[o][0] <= d <= de[o][-1]):
        return None
    return float(np.interp(d, de[o], K[o]))


def iv_en(ch, x, K, call):
    """IV en % del vencimiento x en el strike K (interpolada entre strikes); None fuera de rango."""
    Ks, iv, _ = _serie(ch, x, call)
    if Ks.size < 2 or not (Ks[0] <= K <= Ks[-1]):
        return None
    return float(np.interp(K, Ks, iv)) * 100


def vencimientos(ch, sesion):
    """[(tenor, vencimiento, dias)]: el vencimiento mas cercano a cada tenor, si esta a menos del 35 % (min. 3 dias)."""
    d0 = np.datetime64(sesion, "D")
    exps = np.unique(ch["exp"])
    dte = (exps.astype("datetime64[D]") - d0).astype(int)
    out, vistos = [], set()
    for nombre, obj in TENORES:
        dif = np.where(dte >= 1, np.abs(dte - obj), 10 ** 6)
        i = int(np.argmin(dif))
        if dif[i] <= max(3, obj * 0.35) and exps[i] not in vistos:
            vistos.add(exps[i])
            out.append((nombre, exps[i], int(dte[i])))
    return out


def _iv_atm(ch, x, K):
    v = [a for a in (iv_en(ch, x, K, True), iv_en(ch, x, K, False)) if a is not None]
    return sum(v) / len(v) if v else None


def bloque_vol_strike(cadenas: dict, sesion: str) -> dict:
    """cadenas: {ticker: (cadena de la sesion, cadena de la ultima sesion de la semana anterior)}."""
    datos, por_que = {}, []
    for sym, (ch, prev) in cadenas.items():
        filas = []
        for tenor, x, dte in vencimientos(ch, sesion):
            celdas = {}
            for et, d in DELTAS:
                K = strike_de_delta(ch, x, d)
                if K is None:
                    continue
                if d is None:
                    ahora, antes = _iv_atm(ch, x, K), _iv_atm(prev, x, K)
                else:
                    ahora, antes = iv_en(ch, x, K, d > 0), iv_en(prev, x, K, d > 0)
                celdas[et] = {"strike": _r(K, 2), "iv": _r(ahora),
                              "cambio": _r(ahora - antes, 2) if ahora is not None and antes is not None else None}
            fila = {"tenor": tenor, "vencimiento": str(x)[:10], "dte": dte, "celdas": celdas,
                    "skew_25": None, "skew_25_cambio": None}
            p, c = celdas.get("25P"), celdas.get("25C")
            if p and c and p["iv"] is not None and c["iv"] is not None:
                fila["skew_25"] = _r(p["iv"] - c["iv"])
                if p["cambio"] is not None and c["cambio"] is not None:
                    fila["skew_25_cambio"] = _r(p["cambio"] - c["cambio"], 2)
            filas.append(fila)
        if not filas:
            continue
        datos[sym] = filas
        m1 = next((f for f in filas if f["tenor"] == "1m"), None)
        if m1:
            atm = (m1["celdas"].get("50") or {}).get("cambio")
            if atm is not None and abs(atm) >= UMBRAL_ATM_1M:
                por_que.append(f"{sym}: IV ATM a 1 mes {atm:+.1f} puntos a strike fijo en la semana")
            sk = m1["skew_25_cambio"]
            if sk is not None and abs(sk) >= UMBRAL_SKEW_1M:
                por_que.append(f"{sym}: skew 25P-25C a 1 mes {sk:+.1f} puntos en la semana")
    if not datos:
        raise ValueError("Sin cadenas utiles para la vol a strike fijo")
    return {"destacado": bool(por_que), "por_que": por_que, "datos": datos}


# ------------------------------------------------------------------ gamma y niveles
CAMPOS_GAMMA = ("spot", "flip", "call_wall", "put_wall", "net_per_pct")


def regimen(s):
    if not s or s.get("flip") is None or s.get("spot") is None:
        return None
    return "positiva" if s["spot"] >= s["flip"] else "negativa"


def bloque_gamma(semanas: dict, hist_net: dict) -> dict:
    """semanas: {ticker: {"previa": (fecha, snap) o None, "dias": [(fecha, snap)]}}, snap con CAMPOS_GAMMA;
    hist_net: {ticker: [gamma neta (net_per_pct) del ultimo ano]}."""
    datos, por_que = {}, []
    for sym, w in semanas.items():
        dias = w["dias"]
        if not dias:
            continue
        serie = ([w["previa"]] if w.get("previa") else []) + dias
        cruces, antes = [], None
        for f, s in serie:
            r = regimen(s)
            if antes is not None and r is not None and r != antes:
                cruces.append({"fecha": f, "a": r})
            antes = r if r is not None else antes
        ult, prev = dias[-1][1], (w["previa"][1] if w.get("previa") else None)
        cambio = {}
        for k in ("call_wall", "put_wall"):
            a, b = (prev or {}).get(k), ult.get(k)
            cambio[k] = _r(100 * (b / a - 1)) if a and b else None
        net_pct = percentil(ult.get("net_per_pct"), hist_net.get(sym, []))
        datos[sym] = {"dias": [{"fecha": f, **{k: s.get(k) for k in CAMPOS_GAMMA}} for f, s in dias],
                      "previa": ({"fecha": w["previa"][0], **{k: prev.get(k) for k in CAMPOS_GAMMA}} if prev else None),
                      "regimen": regimen(ult), "cruces": cruces, "cambio": cambio, "net_pct": net_pct}
        for c in cruces:
            por_que.append(f"{sym}: el spot paso a gamma {c['a']} el {c['fecha']}")
        for k, v in cambio.items():
            if v is not None and abs(v) >= 100 * UMBRAL_WALL:
                por_que.append(f"{sym}: {k} {v:+.1f} % en la semana")
        if extremo(net_pct):
            por_que.append(f"{sym}: gamma neta en el percentil {net_pct} del ultimo ano")
    if not datos:
        raise ValueError("Sin niveles de ningun ticker esta semana")
    return {"destacado": bool(por_que), "por_que": por_que, "datos": datos}
```

- [ ] **Step 4: Ver que pasa**

Run: `.venv/Scripts/python.exe pruebas/test_report.py`
Expected: todas `ok`, incluidas `test_bloque_vol_strike` y `test_bloque_gamma`.

- [ ] **Step 5: Commit**

```bash
git add report_calc.py pruebas/test_report.py
git commit -m "Report semanal: vol a strike fijo y gamma con pruebas

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Gráficos (`report_graficos.py`)

matplotlib no está en el `.venv` local ni en `requirements-nube.txt`: se instala solo en `report.yml`. La prueba se
salta si no está y la comprobación real es la ejecución de la Task 12.

**Files:**
- Create: `report_graficos.py`
- Modify: `pruebas/test_report.py`

- [ ] **Step 1: Prueba (se salta sin matplotlib)**

```python
def test_graficos():
    try:
        import matplotlib  # noqa: F401
    except ImportError:
        print("  (sin matplotlib: se comprueba en Actions)")
        return
    import report_graficos as rg
    f = laborables(420)
    rets = [0.005 if i % 2 else -0.005 for i in range(419)]
    vr = rc.bloque_vol_real({"SPX": cierres(f, rets)}, cierres(f, [-r for r in rets], 20.0), f[-5:])
    s = lambda spot: {"spot": spot, "flip": 99.0, "call_wall": 105.0, "put_wall": 95.0, "net_per_pct": 0.5}
    gm = rc.bloque_gamma({"SPY": {"previa": ("2026-11-06", s(100.0)), "dias": [("2026-11-09", s(101.0))]}}, {})
    vs = rc.bloque_vol_strike({"SPY": (cadena(0.20), cadena(0.18))}, "2026-11-13")
    et = rc.bloque_etf({"TQQQ": 2e10}, {"QQQ": cierres(f, rets)}, f[-5:])
    pngs = [rg.gamma("SPY", gm["datos"]["SPY"]), rg.vol_real("SPX", vr["datos"]["SPX"]),
            rg.vol_strike("SPY", vs["datos"]["SPY"]), rg.etf(et["datos"])]
    assert all(p[:8] == b"\x89PNG\r\n\x1a\n" for p in pngs)
```

- [ ] **Step 2: Implementar**

```python
"""Graficos PNG del report semanal (matplotlib, solo en Actions). Fondo propio y paleta del tema Daylight: los
colores son los de THEMES.light en web/app.js (si cambian alli, cambiarlos aqui). Cada funcion devuelve bytes PNG."""
from __future__ import annotations

import io

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.colors import LinearSegmentedColormap  # noqa: E402

# THEMES.light de web/app.js
C = {"surface": "#ffffff", "grid": "#eceef4", "axis": "#d3d7e3", "text": "#11142b", "muted": "#4c5170",
     "neg": "#e11d6a", "pos": "#6a3df0", "put": "#0b9b6a", "call": "#e5484d", "amber": "#c27c0e", "accent": "#5145e5"}
ANCHO, DPI = 12, 100   # 1200 px de ancho


def _fig(alto=5.0):
    fig, ax = plt.subplots(figsize=(ANCHO, alto), dpi=DPI)
    fig.patch.set_facecolor(C["surface"])
    ax.set_facecolor(C["surface"])
    for s in ax.spines.values():
        s.set_color(C["axis"])
    ax.tick_params(colors=C["muted"], labelsize=10)
    ax.grid(True, color=C["grid"], linewidth=0.8)
    ax.set_axisbelow(True)
    return fig, ax


def _png(fig) -> bytes:
    b = io.BytesIO()
    fig.savefig(b, format="png", facecolor=fig.get_facecolor(), bbox_inches="tight")
    plt.close(fig)
    return b.getvalue()


def _titulo(ax, t):
    ax.set_title(t, loc="left", color=C["text"], fontsize=14, fontweight="bold")


def gamma(sym: str, d: dict) -> bytes:
    """Spot de la semana con flip, call wall y put wall (incluye la ultima sesion de la semana anterior)."""
    filas = ([d["previa"]] if d.get("previa") else []) + d["dias"]
    x = [f["fecha"][5:] for f in filas]
    fig, ax = _fig()
    for k, col, et in (("call_wall", C["call"], "Call wall"), ("put_wall", C["put"], "Put wall"),
                       ("flip", C["amber"], "Gamma flip")):
        ax.step(x, [f.get(k) for f in filas], where="mid", color=col, linewidth=1.6, label=et)
    ax.plot(x, [f.get("spot") for f in filas], color=C["text"], linewidth=2.4, marker="o", label="Spot")
    _titulo(ax, f"{sym}: spot vs gamma levels (week)")
    ax.legend(frameon=False, labelcolor=C["muted"], ncol=4, loc="upper left")
    return _png(fig)


def vol_real(nombre: str, d: dict) -> bytes:
    """Barras mensuales de vol realizada de los dias de subida y de bajada; el mes en curso, al final."""
    m = d["mensual"]
    x = list(range(len(m)))
    fig, ax = _fig()
    ax.bar([i - 0.2 for i in x], [r[1] or 0 for r in m], width=0.4, color=C["pos"], label="Up-day realized vol")
    ax.bar([i + 0.2 for i in x], [r[2] or 0 for r in m], width=0.4, color=C["neg"], label="Down-day realized vol")
    ax.set_xticks(x, [r[0] for r in m], rotation=60, fontsize=8)
    ax.axvspan(x[-1] - 0.5, x[-1] + 0.5, color=C["grid"], zorder=0)
    ax.set_ylabel("%", color=C["muted"])
    _titulo(ax, f"{nombre}: realized vol on up days vs down days (monthly)")
    ax.legend(frameon=False, labelcolor=C["muted"], loc="upper left")
    return _png(fig)


def vol_strike(sym: str, filas: list) -> bytes:
    """Tabla en color: cambio semanal de IV a strike fijo por vencimiento y delta."""
    import numpy as np
    from report_calc import DELTAS
    cols = [et for et, _ in DELTAS]
    z = np.array([[(f["celdas"].get(c) or {}).get("cambio") for c in cols] for f in filas], dtype=float)
    lim = max(1.0, float(np.nanmax(np.abs(z)))) if np.isfinite(z).any() else 1.0
    cmap = LinearSegmentedColormap.from_list("d", [C["put"], C["surface"], C["neg"]])
    fig, ax = _fig(0.6 * len(filas) + 1.6)
    ax.grid(False)
    ax.imshow(np.nan_to_num(z), cmap=cmap, vmin=-lim, vmax=lim, aspect="auto")
    for i in range(z.shape[0]):
        for j in range(z.shape[1]):
            ax.text(j, i, "-" if not np.isfinite(z[i, j]) else f"{z[i, j]:+.2f}", ha="center", va="center",
                    color=C["text"], fontsize=10)
    ax.set_xticks(range(len(cols)), cols)
    ax.set_yticks(range(len(filas)), [f"{f['tenor']}  {f['vencimiento']}" for f in filas])
    _titulo(ax, f"{sym}: fixed-strike IV change vs last week (vol points)")
    return _png(fig)


def etf(d: dict) -> bytes:
    """Barras apiladas del rebalanceo estimado de cada dia, por indice (miles de millones)."""
    dias = d["dias"]
    x = [f["fecha"][5:] for f in dias]
    subs = sorted({k for f in dias for k in f["por_indice"]})
    cols = [C["accent"], C["neg"], C["put"], C["amber"], C["pos"]]
    fig, ax = _fig()
    base_pos, base_neg = [0.0] * len(dias), [0.0] * len(dias)
    for i, s in enumerate(subs):
        v = [f["por_indice"].get(s, 0) / 1e9 for f in dias]
        base = [bp if a >= 0 else bn for a, bp, bn in zip(v, base_pos, base_neg)]
        ax.bar(x, v, bottom=base, color=cols[i % len(cols)], label=s, width=0.6)
        base_pos = [bp + max(a, 0) for a, bp in zip(v, base_pos)]
        base_neg = [bn + min(a, 0) for a, bn in zip(v, base_neg)]
    ax.axhline(0, color=C["axis"], linewidth=1)
    ax.set_ylabel("$bn", color=C["muted"])
    _titulo(ax, "Leveraged ETFs: estimated close rebalance by underlying")
    ax.legend(frameon=False, labelcolor=C["muted"], ncol=len(subs), loc="upper left")
    return _png(fig)
```

- [ ] **Step 3: Ejecutar las pruebas**

Run: `.venv/Scripts/python.exe pruebas/test_report.py`
Expected: todas `ok`; `test_graficos` imprime `(sin matplotlib: se comprueba en Actions)`.

- [ ] **Step 4: Commit**

```bash
git add report_graficos.py pruebas/test_report.py
git commit -m "Report semanal: graficos PNG con la paleta Daylight

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `report_semanal.py` (lectura, paquete y escritura en R2)

**Files:**
- Create: `report_semanal.py`
- Modify: `pruebas/test_report.py`

- [ ] **Step 1: Prueba del armado con almacenamiento local (falla)**

```python
def test_armar_paquete():
    import tempfile
    import almacen
    import report_semanal as rs

    st = almacen.Local(tempfile.mkdtemp())
    f = laborables(420, "2025-03-03")
    sesiones, previa = f[-5:], f[-6]
    for d in f[-30:]:
        st.put(f"hist500/_dias/{d}.json", b"{}", "application/json")
    lv = lambda spot: {"standard": {"spotgamma": {"all": {"spot": spot, "flip": spot - 1, "call_wall": spot + 5,
                                                         "put_wall": spot - 5, "net_per_pct": 0.3}}}}

    def mini(iv_base):   # mismo vencimiento (F + 30 dias) en todas las sesiones, para comparar a strike fijo
        ch = cadena(iv_base, sesiones[-1], 30)
        return {"symbol": "SPY", "spot": 100.0, "exps": [str(np.unique(ch["exp"])[0])], "e": [0] * ch["K"].size,
                "fwds": [100.0], "call": ch["call"].astype(int).tolist(), "K": ch["K"].tolist(),
                "oi": [1] * ch["K"].size, "vol": [0] * ch["K"].size, "iv": ch["iv"].tolist(),
                "iv_raw": ch["iv"].tolist(), "delta": ch["delta"].tolist(), "bid": [1.0] * ch["K"].size,
                "ask": [1.1] * ch["K"].size, "last": [1.0] * ch["K"].size}

    for d in [previa] + sesiones:
        almacen.put_json(st, f"hist500/SPY/{d}.json.gz", {"levels": lv(100.0), "chain": mini(0.20 if d != previa else 0.18)})
    almacen.put_json(st, "hist500/_niveles/SPY.json.gz", {d: lv(100.0 + i * 0.1) for i, d in enumerate(f[-300:])})
    rets = [0.005 if i % 2 else -0.005 for i in range(419)]
    almacen.put_json(st, "hist500/_indices_vol/historico.json.gz",
                     {"series": {"VIX": [[d, 0, 0, 0, c] for d, c in cierres(f, [-r for r in rets], 20.0)]}})
    fred = lambda serie: cierres(f, rets)
    p, graficos = rs.armar(st, sesiones[-1], fred=fred, aum=lambda sym: None, dibujar=False)
    b = p["bloques"]
    assert p["fecha"] == sesiones[-1] and p["sesiones"] == sesiones and p["previa"] == previa
    assert b["gamma"]["estado"] == "ok" and "SPY" in b["gamma"]["datos"], b["gamma"]
    assert b["vol_strike"]["estado"] == "ok" and b["vol_strike"]["destacado"], b["vol_strike"]
    assert b["vol_real"]["estado"] == "ok" and set(b["vol_real"]["datos"]) == {"SPX", "NDX"}
    assert b["etf_apal"]["estado"] == "ausente" and "AUM" in b["etf_apal"]["motivo"], b["etf_apal"]
    assert graficos == {}
    rs.publicar(st, p, {"x": b"\x89PNG"})
    assert almacen.get_json(st, f"report/{sesiones[-1]}/paquete.json")["fecha"] == sesiones[-1]
    assert almacen.get_json(st, "report/ultimo.json") == {"fecha": sesiones[-1]}
    assert st.get(f"report/{sesiones[-1]}/g/x.png") == b"\x89PNG"
```

- [ ] **Step 2: Ver que falla**

Run: `.venv/Scripts/python.exe pruebas/test_report.py`
Expected: `ModuleNotFoundError: No module named 'report_semanal'`

- [ ] **Step 3: Implementar**

`report_semanal.py` (el parser de `aum_etf` sigue lo que imprimió la Task 1; si las columnas o líneas difieren de
las de abajo, cambiar solo `_aum_proshares` / `_aum_direxion` y anotarlo):

```python
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
    acc = re.search(r"Shares Outstanding[^0-9]*([\d,\.]+)", txt, re.I)
    nav = re.search(r"\bNAV[^0-9]*([\d,\.]+)", txt, re.I)
    if not acc or not nav:
        raise ValueError("Formato de Direxion desconocido")
    return _num(acc.group(1)) * _num(nav.group(1))


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


def _spots(st, sym, hasta) -> list:
    out = []
    for f, lv in sorted(_indice(st, sym).items()):
        s = _snap(lv)
        if f <= hasta and s and s.get("spot"):
            out.append((f, float(s["spot"])))
    return out


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


def _etf(st, ses, aum):
    subs = sorted({s for s, _ in rc.ETF_APAL.values()})
    return rc.bloque_etf({e: aum(e) for e in rc.ETF_APAL}, {s: v for s in subs if (v := _spots(st, s, ses[-1]))}, ses)


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


def armar(st, fecha=None, fred=fred_serie, aum=aum_etf, dibujar=True) -> tuple:
    """(paquete, {nombre: bytes PNG}) de la semana que acaba en fecha (o en la ultima sesion guardada)."""
    ses, previa = semana_de(sesiones_guardadas(st), fecha)
    bloques = {
        "gamma": _bloque("gamma", lambda: _gamma(st, ses, previa)),
        "vol_real": _bloque("vol_real", lambda: _vol_real(st, ses, fred)),
        "etf_apal": _bloque("etf_apal", lambda: _etf(st, ses, aum)),
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
```

- [ ] **Step 4: Ver que pasa**

Run: `.venv/Scripts/python.exe pruebas/test_report.py`
Expected: todas `ok`, incluida `test_armar_paquete`.

- [ ] **Step 5: Commit**

```bash
git add report_semanal.py pruebas/test_report.py
git commit -m "Report semanal: armado del paquete y escritura en R2

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Workflow `report.yml`

**Files:**
- Create: `.github/workflows/report.yml`

- [ ] **Step 1: Escribirlo**

```yaml
name: Report semanal
# Paquete de datos y graficos de la semana en R2 report/{fecha}/ (report_semanal.py). Lo lanza /report-semanal
# desde Claude Code; el texto del report lo escribe Claude Code con ese paquete.
on:
  workflow_dispatch:
    inputs:
      fecha:
        description: "Ultima sesion de la semana (YYYY-MM-DD); vacio = la ultima guardada"
        required: false
        default: ""
concurrency:
  group: report
  cancel-in-progress: false
permissions:
  contents: read
jobs:
  report:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
          cache: pip
          cache-dependency-path: requirements-nube.txt
      - run: pip install -q -r requirements-nube.txt matplotlib
      - run: python pruebas/test_report.py
      - name: Calcular y publicar
        env:
          R2_ACCOUNT_ID: ${{ secrets.R2_ACCOUNT_ID }}
          R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
          R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
          R2_BUCKET: ${{ vars.R2_BUCKET || 'gexlab' }}
          GEX_ALMACEN: r2
          FRED_API_KEY: ${{ secrets.FRED_API_KEY }}
          FECHA: ${{ inputs.fecha }}
        run: python report_semanal.py ${FECHA:+--fecha "$FECHA"}
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/report.yml
git commit -m "Report semanal: workflow que calcula el paquete

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: `escribirTake` en `nube/takes.js` con limpieza

**Files:**
- Modify: `nube/takes.js` (función `guardar`, líneas ~180-225)
- Modify: `pruebas/test_takes_api.mjs`

- [ ] **Step 1: Prueba que falla** (al final de `pruebas/test_takes_api.mjs`; añadir `escribirTake, validarTake` al import de `../nube/takes.js`)

```js
test("escribirTake deshace el Take nuevo y los archivos subidos si falla a mitad", async () => {
  const env = entorno();
  let n = 0;
  const put = env.R2.put;
  env.R2.put = async (k, v, o) => { if (++n === 2) throw new Error("R2 caido"); return put(k, v, o); };
  const t = validarTake({ titulo: "x", cuerpo: "y", adjuntos: [{ tipo: "imagen", archivo: "a0" }, { tipo: "imagen", archivo: "a1" }] },
    new Map([["a0", { nombre: "a.png", bytes: PNG }], ["a1", { nombre: "b.png", bytes: PNG }]]), new Map());
  await assert.rejects(escribirTake(env, "claude", t, null, new Map()), /R2 caido/);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM takes").get().n, 0);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM takes_adjuntos").get().n, 0);
  assert.equal(env.R2.m.size, 0);
});
```

- [ ] **Step 2: Ver que falla**

Run: `node --test pruebas/test_takes_api.mjs`
Expected: FAIL, `escribirTake` no exportado (`SyntaxError: The requested module ... does not provide an export named 'escribirTake'`).

- [ ] **Step 3: Implementar.** Sustituir en `guardar` todo lo que va desde `const ts = ahora();` hasta
`return h.json(200, { id });` por:

```js
  return h.json(200, { id: await escribirTake(env, me.user, t, id, previos) });
}

// Escribe un Take ya validado (validarTake): fila, archivos nuevos en R2 y lista de adjuntos. id null = nuevo.
// Si algo falla, borra lo subido en esta llamada y, si el Take era nuevo, su fila. Lo usa tambien nube/report.js
export async function escribirTake(env, autor, t, id, previos) {
  const nuevo = id == null, subidos = [];
  try {
    const ts = ahora();
    if (nuevo) {
      const r = await env.DB.prepare("INSERT INTO takes (titulo, cuerpo, etiquetas, estado, autor, creado) VALUES (?, ?, ?, 'borrador', ?, ?) RETURNING id")
        .bind(t.titulo, t.cuerpo, JSON.stringify(t.etiquetas), autor, ts).first();
      id = r.id;
    } else {
      await env.DB.prepare("UPDATE takes SET titulo = ?, cuerpo = ?, etiquetas = ?, editado = ? WHERE id = ?")
        .bind(t.titulo, t.cuerpo, JSON.stringify(t.etiquetas), ts, id).run();
    }
    // primero los archivos nuevos a R2; luego la lista de adjuntos de una vez; al final se borran los quitados
    for (const a of t.adjuntos) {
      if (!a.nuevo) continue;
      a.r2 = `takes/${id}/${rand()}.${a.nuevo.ext}`;
      await env.R2.put(a.r2, a.nuevo.bytes, { httpMetadata: { contentType: a.nuevo.mime } });
      subidos.push(a.r2);
    }
    const sigue = new Set(t.adjuntos.filter((a) => a.id != null).map((a) => a.id));
    const quitar = [...previos.values()].filter((a) => !sigue.has(a.id) && a.r2).map((a) => a.r2);
    const ins = "INSERT INTO takes_adjuntos (take_id, orden, tipo, url, r2, titulo, texto, fuente) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
    await env.DB.batch([
      env.DB.prepare("DELETE FROM takes_adjuntos WHERE take_id = ?").bind(id),
      ...t.adjuntos.map((a, i) => env.DB.prepare(ins).bind(id, i, a.tipo, a.url, a.r2, a.titulo, a.texto, a.fuente)),
    ]);
    if (quitar.length) await env.R2.delete(quitar);
    return id;
  } catch (e) {
    if (subidos.length) await env.R2.delete(subidos).catch(() => {});
    if (nuevo && id != null) {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM takes_adjuntos WHERE take_id = ?").bind(id),
        env.DB.prepare("DELETE FROM takes WHERE id = ?").bind(id),
      ]).catch(() => {});
    }
    throw e;
  }
}
```

(Comprobar que la llave de cierre de `guardar` queda una sola vez: la línea `return h.json(200, { id: ... });`
seguida de `}` cierra `guardar`, y `escribirTake` va justo después, antes de `async function estado`.)

- [ ] **Step 4: Ver que pasa**

Run: `node --check nube/takes.js; node --test pruebas/test_takes.mjs pruebas/test_takes_api.mjs`
Expected: todas las pruebas `pass`, incluida la nueva.

- [ ] **Step 5: Commit**

```bash
git add nube/takes.js pruebas/test_takes_api.mjs
git commit -m "Takes: escribirTake reutilizable y limpieza si el guardado falla a mitad

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Rutas `/api/report/*` (`nube/report.js`) y enrutado

**Files:**
- Create: `nube/report.js`
- Modify: `nube/worker.js` (import arriba, junto a `import { takes } ...`; y en `fetch`, tras la comprobación de `Origin`)
- Create: `pruebas/test_report_api.mjs`

- [ ] **Step 1: Pruebas que fallan**

`pruebas/test_report_api.mjs`:

```js
// Pruebas de las rutas /api/report/* de nube/report.js: D1 imitado con node:sqlite y R2 con un Map.
// Ejecutar: node --test pruebas/test_report_api.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { report } from "../nube/report.js";

function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../nube/schema.sql", import.meta.url), "utf8"));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
  });
  return { db, prepare: (sql) => stmt(sql), batch: async (ss) => { const out = []; for (const s of ss) out.push(await s.run()); return out; } };
}

function r2() {
  const m = new Map();
  return {
    m,
    put: async (k, v, o) => { m.set(k, { bytes: v, ct: o.httpMetadata.contentType }); },
    get: async (k) => (m.has(k) ? { body: m.get(k).bytes, httpMetadata: { contentType: m.get(k).ct } } : null),
    delete: async (ks) => { for (const k of [].concat(ks)) m.delete(k); },
  };
}

const json = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: { "Content-Type": "application/json" } });
const body = async (req) => JSON.parse(await req.text());
const h = { json, body, SEC_HEADERS: { "X-Content-Type-Options": "nosniff" } };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const F = "2026-11-13";

function entorno(token = "secreto-de-prueba") {
  const env = { DB: d1(), R2: r2(), REPORT_TOKEN: token };
  const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
  env.R2.m.set(`report/${F}/paquete.json`, { bytes: enc({ fecha: F, bloques: {} }), ct: "application/json" });
  env.R2.m.set("report/ultimo.json", { bytes: enc({ fecha: F }), ct: "application/json" });
  env.R2.m.set(`report/${F}/g/gamma_spy.png`, { bytes: PNG, ct: "image/png" });
  env.R2.m.set(`report/${F}/g/falso.png`, { bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), ct: "image/png" });
  return env;
}

async function llama(env, method, path, data, token = "secreto-de-prueba") {
  const url = new URL("https://x.test" + path);
  const headers = { Authorization: `Bearer ${token}` };
  const init = { method, headers };
  if (data !== undefined) { headers["Content-Type"] = "application/json"; init.body = JSON.stringify(data); }
  try {
    const r = await report(new Request(url, init), env, url, h);
    const ct = r.headers.get("Content-Type") || "";
    return { status: r.status, ct, d: ct.includes("json") ? await r.json() : new Uint8Array(await r.arrayBuffer()) };
  } catch (e) { return { status: 400, d: { error: e.message } }; }   // como el catch de worker.js
}

test("sin secreto configurado o con token incorrecto: 404", async () => {
  assert.equal((await llama(entorno(""), "GET", `/api/report/${F}`)).status, 404);
  assert.equal((await llama(entorno(), "GET", `/api/report/${F}`, undefined, "otro")).status, 404);
});

test("lee el ultimo, el paquete y un grafico; valida fecha y nombre", async () => {
  const env = entorno();
  assert.deepEqual((await llama(env, "GET", "/api/report/ultimo")).d, { fecha: F });
  const p = await llama(env, "GET", `/api/report/${F}`);
  assert.equal(p.status, 200);
  assert.equal(p.d.fecha, F);
  const g = await llama(env, "GET", `/api/report/${F}/g/gamma_spy.png`);
  assert.equal(g.status, 200);
  assert.equal(g.ct, "image/png");
  assert.equal(g.d.length, PNG.length);
  assert.equal((await llama(env, "GET", "/api/report/2026-13")).status, 400);
  assert.equal((await llama(env, "GET", `/api/report/${F}/g/Mal-Nombre.png`)).status, 400);
  assert.equal((await llama(env, "GET", "/api/report/2026-11-06")).status, 404);
});

test("crea un borrador de claude con los graficos copiados a takes/", async () => {
  const env = entorno();
  const r = await llama(env, "POST", `/api/report/${F}/take`, {
    titulo: "Weekly: test", cuerpo: "Body", etiquetas: ["Weekly", "Auto"],
    graficos: [{ nombre: "gamma_spy", titulo: "SPY gamma", nota: "Spot vs levels" }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const t = env.DB.db.prepare("SELECT * FROM takes WHERE id = ?").get(r.d.id);
  assert.equal(t.estado, "borrador");
  assert.equal(t.autor, "claude");
  const a = env.DB.db.prepare("SELECT * FROM takes_adjuntos WHERE take_id = ?").all(r.d.id);
  assert.equal(a.length, 1);
  assert.equal(a[0].tipo, "imagen");
  assert.equal(a[0].texto, "Spot vs levels");
  assert.match(a[0].r2, new RegExp(`^takes/${r.d.id}/[0-9a-f]{24}\\.png$`));
  assert.ok(env.R2.m.has(a[0].r2));
});

test("un PNG falso o un grafico que no existe no crean nada", async () => {
  const env = entorno();
  const falso = await llama(env, "POST", `/api/report/${F}/take`, { titulo: "x", cuerpo: "y", graficos: [{ nombre: "falso" }] });
  assert.equal(falso.status, 400);
  assert.match(falso.d.error, /Unsupported file/);
  const no = await llama(env, "POST", `/api/report/${F}/take`, { titulo: "x", cuerpo: "y", graficos: [{ nombre: "no_existe" }] });
  assert.equal(no.status, 404);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM takes").get().n, 0);
});
```

- [ ] **Step 2: Ver que falla**

Run: `node --test pruebas/test_report_api.mjs`
Expected: FAIL, `Cannot find module '.../nube/report.js'`.

- [ ] **Step 3: Implementar `nube/report.js`**

```js
// GEX Lab - report semanal: sirve el paquete y los graficos que deja report_semanal.py en R2 (report/{F}/) y crea
// el borrador del Take. Solo con "Authorization: Bearer <REPORT_TOKEN>" (secreto del Worker); sin el secreto
// configurado o con otro token, 404. No usa la sesion de usuario. Lo llama el skill /report-semanal de Claude Code.
import { validarTake, escribirTake } from "./takes.js";

export const AUTOR_REPORT = "claude";   // la cuenta Claude, con permiso de borradores en Takes
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const NOMBRE = /^[a-z0-9_]{1,40}$/;

async function tokenOk(req, env) {
  const t = env.REPORT_TOKEN;
  const m = /^Bearer (.+)$/.exec(req.headers.get("Authorization") || "");
  if (!t || !m) return false;
  const enc = new TextEncoder();   // se comparan los SHA-256: misma longitud y tiempo constante
  const [a, b] = await Promise.all([m[1], t].map((s) => crypto.subtle.digest("SHA-256", enc.encode(s))));
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

async function servir(env, key, tipo, h) {
  const obj = await env.R2.get(key);
  if (!obj) return h.json(404, { error: "Not found" });
  return new Response(obj.body, { headers: { "Content-Type": tipo, "Cache-Control": "no-store", ...h.SEC_HEADERS } });
}

export async function report(req, env, url, h) {
  if (!(await tokenOk(req, env))) return h.json(404, { error: "not found" });
  const m = /^\/api\/report\/([^/]+)(\/.*)?$/.exec(url.pathname);
  const f = m ? m[1] : "", resto = (m && m[2]) || "";
  if (f === "ultimo" && req.method === "GET" && !resto) return servir(env, "report/ultimo.json", "application/json; charset=utf-8", h);
  if (!FECHA.test(f) || isNaN(Date.parse(f))) return h.json(400, { error: "Invalid date" });
  if (req.method === "GET" && !resto) return servir(env, `report/${f}/paquete.json`, "application/json; charset=utf-8", h);
  const g = /^\/g\/([^/]+)\.png$/.exec(resto);
  if (req.method === "GET" && g) {
    if (!NOMBRE.test(g[1])) return h.json(400, { error: "Invalid chart name" });
    return servir(env, `report/${f}/g/${g[1]}.png`, "image/png", h);
  }
  if (req.method === "POST" && resto === "/take") return crear(req, env, f, h);
  return h.json(404, { error: "not found" });
}

// JSON {titulo, cuerpo, etiquetas, graficos: [{nombre, titulo, nota}]} -> borrador de AUTOR_REPORT con los PNG
async function crear(req, env, f, h) {
  const d = await h.body(req);
  const graficos = Array.isArray(d.graficos) ? d.graficos : [];
  const archivos = new Map(), adjuntos = [];
  for (const [i, x] of graficos.entries()) {
    const nombre = String((x && x.nombre) || "");
    if (!NOMBRE.test(nombre)) return h.json(400, { error: `Invalid chart name: ${nombre.slice(0, 40)}` });
    const obj = await env.R2.get(`report/${f}/g/${nombre}.png`);
    if (!obj) return h.json(404, { error: `Chart not found: ${nombre}` });
    const campo = `archivo${i}`;
    archivos.set(campo, { nombre: `${nombre}.png`, bytes: new Uint8Array(await new Response(obj.body).arrayBuffer()) });
    adjuntos.push({ tipo: "imagen", archivo: campo, titulo: String(x.titulo || ""), texto: String(x.nota || "") });
  }
  const t = validarTake({ titulo: d.titulo, cuerpo: d.cuerpo, etiquetas: d.etiquetas, adjuntos }, archivos, new Map());
  return h.json(200, { id: await escribirTake(env, AUTOR_REPORT, t, null, new Map()) });
}
```

- [ ] **Step 4: Enrutar en `nube/worker.js`**

Import (junto a la línea 8):

```js
import { report } from "./report.js";   // report semanal: rutas con token propio, sin sesion
```

En `fetch`, justo después del bloque que comprueba `Origin` y antes de `if (PUBLIC.has(p)) {`:

```js
      if (p.startsWith("/api/report/")) return await report(req, env, url, { json, body, SEC_HEADERS });
```

- [ ] **Step 5: Ver que pasa**

Run: `node --check nube/report.js; node --check nube/worker.js; node --test pruebas/test_takes.mjs pruebas/test_takes_api.mjs pruebas/test_report_api.mjs`
Expected: todo `pass`.

- [ ] **Step 6: Commit**

```bash
git add nube/report.js nube/worker.js pruebas/test_report_api.mjs
git commit -m "Report semanal: rutas del Worker con token propio y pruebas

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Secreto `REPORT_TOKEN` en el despliegue

**Files:**
- Modify: `nube/desplegar.sh` (tras `printf '%s' "$GH_DISPATCH_TOKEN" | $W secret put GH_DISPATCH_TOKEN >/dev/null`)
- Modify: `.github/workflows/desplegar.yml` (env del paso «Desplegar en Cloudflare»)

- [ ] **Step 1: `nube/desplegar.sh`**

Cambiar la línea de comentario de variables a
`# Variables: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, GH_DISPATCH_TOKEN, GEX_SETUP_CODE, REPORT_TOKEN (opcional)`
y añadir tras el `secret put GH_DISPATCH_TOKEN`:

```bash
if [ -n "${REPORT_TOKEN:-}" ]; then   # report semanal (/api/report/*); sin el secreto esas rutas responden 404
  printf '%s' "$REPORT_TOKEN" | $W secret put REPORT_TOKEN >/dev/null
fi
```

- [ ] **Step 2: `.github/workflows/desplegar.yml`**, en `env:` del paso de despliegue:

```yaml
          REPORT_TOKEN: ${{ secrets.REPORT_TOKEN }}
```

- [ ] **Step 3: Comprobar sintaxis**

Run: `bash -n nube/desplegar.sh`
Expected: sin salida.

- [ ] **Step 4: Commit**

```bash
git add nube/desplegar.sh .github/workflows/desplegar.yml
git commit -m "Report semanal: secreto REPORT_TOKEN en el despliegue del Worker

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Skill del proyecto y documentación

**Files:**
- Create: `.claude/skills/report-semanal/SKILL.md`
- Create: `.claude/skills/report-semanal/guia-estilo.md`
- Modify: `docs/ARQUITECTURA.md` (sección nueva tras Founder Takes), `CLAUDE.md` (Mapa y Comandos), `docs/ESTADO.md`

`.claude/launch.json` sigue sin subirse: añadir solo la carpeta `skills/`.

- [ ] **Step 1: `SKILL.md`**

````markdown
---
name: report-semanal
description: Genera el report semanal de GEX Lab como borrador de Founder Take. Lanza report.yml en Actions, lee el paquete de datos y los graficos, redacta el texto en ingles y crea el borrador. Usar cuando el usuario escriba /report-semanal o pida el report semanal.
---

# Report semanal

Argumento opcional: la ultima sesion de la semana (`YYYY-MM-DD`). Sin argumento, la ultima guardada.
Todo en Git Bash desde `gexlab/`. Base: `https://dashboard.gexlab.workers.dev`. Ficheros temporales: el scratchpad.

## 1. Token

`test -n "$GEXLAB_REPORT_TOKEN" && echo ok`. Si falta, para y explica al usuario: crear un token largo aleatorio,
guardarlo como secreto `REPORT_TOKEN` en GitHub (Settings > Secrets > Actions), redesplegar (`desplegar.yml`) y
ponerlo en su PC como variable de entorno de usuario `GEXLAB_REPORT_TOKEN`. Que no lo pegue en el chat.

## 2. Lanzar el calculo y esperar

```bash
T0=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh api -X POST repos/LoppVicious/gexlab/actions/workflows/report.yml/dispatches -f ref=main -f "inputs[fecha]=FECHA_O_VACIO"
```

Espera con este bucle en segundo plano (`run_in_background`), que acaba cuando la ejecucion nueva termina:

```bash
for i in $(seq 1 40); do
  r=$(gh api "repos/LoppVicious/gexlab/actions/workflows/report.yml/runs?per_page=1" --jq '.workflow_runs[0] | "\(.created_at) \(.status) \(.conclusion) \(.html_url)"')
  set -- $r
  if [ "$1" \> "$T0" ] || [ "$1" = "$T0" ]; then [ "$2" = completed ] && { echo "$r"; exit 0; }; fi
  sleep 30
done; echo "timeout $r"; exit 1
```

Si `conclusion` no es `success`, para y da al usuario el enlace de la ejecucion.

## 3. Leer el paquete y los graficos

```bash
A="Authorization: Bearer $GEXLAB_REPORT_TOKEN"; B=https://dashboard.gexlab.workers.dev/api/report
F=$(curl -sf -H "$A" $B/ultimo | python -c "import json,sys; print(json.load(sys.stdin)['fecha'])")
curl -sf -H "$A" "$B/$F" -o "<scratchpad>/paquete.json"
```

Lee `paquete.json`. Para cada bloque con `estado` `ok` y `destacado` true, descarga sus `graficos`
(`curl -sf -H "$A" "$B/$F/g/<nombre>.png" -o "<scratchpad>/<nombre>.png"`) y miralos con Read.
Si ningun bloque esta destacado, dilo al usuario con el resumen de una linea por bloque y para: no hay report.

## 4. Contexto de la semana (opcional)

Busca en la web (WebSearch, modo standard) que movio el mercado esa semana, solo para explicar los bloques
destacados. Usa solo lo que tenga fuente; guarda los enlaces.

## 5. Redactar

Sigue `guia-estilo.md` (en esta carpeta). Las cifras salen solo del paquete.

## 6. Crear el borrador

Escribe `<scratchpad>/take.json`:
`{"titulo": "...", "cuerpo": "...", "etiquetas": ["Weekly", "Auto"], "graficos": [{"nombre": "...", "titulo": "...", "nota": "..."}]}`
(maximo 8 graficos, en el orden en que se citan en el texto).

```bash
curl -sf -X POST -H "$A" -H "Content-Type: application/json" --data-binary @"<scratchpad>/take.json" "$B/$F/take"
```

Responde `{"id": N}`. Dile al usuario que el borrador N esta en Research > Takes para revisarlo y publicarlo.
Si ya habia un borrador de esa semana, recuerdale que borre el que sobre. Si el POST falla, ensena el error.
````

- [ ] **Step 2: `guia-estilo.md`**

```markdown
# Guia de estilo del report semanal

Lectores: los usuarios de GEX Lab, que conocen gamma, walls, flip y vol. Texto en ingles (la web esta en ingles).

## Estructura
- Titulo: `Weekly: <la conclusion principal en pocas palabras>`.
- Dos o tres frases de entrada con lo mas importante de la semana.
- Una seccion por bloque destacado, de la mas importante a la menos. Encabezado `##` que ya diga la conclusion
  (por ejemplo `## QQQ flipped to negative gamma on Thursday`), no el nombre del bloque.
- Dentro de cada seccion: que paso, por que importa (mecanica de cobertura de dealers, flujos mecanicos) y que
  vigilar la semana que viene. Cifras con su percentil y su ventana ("90th percentile over 10 years").
- Las cifras de bloques no destacados pueden aparecer como apoyo, sin seccion propia.
- Cierre: "What to watch", 3-5 puntos con niveles concretos del paquete (walls, flip).
- 500-1.200 palabras.

## Tono
- Directo y propio. Frases cortas. Nada que imite a un banco, a un analista o su firma.
- Sin recomendaciones de compra o venta: lectura de posicionamiento y flujos.
- Sin exageraciones ni mayusculas para enfatizar; sin emojis.
- No uses el caracter `·` como separador.

## Datos
- Solo cifras del paquete. Si un dato no esta, no se menciona.
- Las estimaciones (rebalanceo de ETFs con AUM actual, gamma estimada por OI) se dicen como estimaciones.
- Noticias solo con enlace a la fuente, en Markdown `[texto](url)`.
- Markdown de Takes: encabezados, negrita, cursiva, listas y enlaces. No hay tablas: las tablas van en los graficos.
```

- [ ] **Step 3: `docs/ARQUITECTURA.md`**, sección nueva después del bloque de Founder Takes:

```markdown
**Report semanal (borrador de Take):** `/report-semanal` en Claude Code (`.claude/skills/report-semanal/`) lanza
`report.yml`, que ejecuta `report_semanal.py` (lectura y paquete), `report_calc.py` (cálculos y umbrales de
destacado) y `report_graficos.py` (PNG, paleta Daylight). Lee `hist500/` (niveles, cadenas al cierre, familia VIX),
FRED (`SP500`, `NASDAQ100`) y las webs de ProShares y Direxion (AUM de ETFs apalancados).
- R2: `report/{F}/paquete.json`, `report/{F}/g/{nombre}.png` y `report/ultimo.json` (`{"fecha": F}`). No se borran.
- Worker (`nube/report.js`): `GET /api/report/ultimo`, `GET /api/report/{F}`, `GET /api/report/{F}/g/{nombre}.png`
  y `POST /api/report/{F}/take` (crea un borrador de la cuenta `claude` con los PNG elegidos, con
  `validarTake`/`escribirTake` de `nube/takes.js`). Solo con `Authorization: Bearer <REPORT_TOKEN>`; sin el secreto,
  404. Secreto de GitHub `REPORT_TOKEN` (lo pone `desplegar.sh` en el Worker) y, en el PC, `GEXLAB_REPORT_TOKEN`.
- Pruebas: `python pruebas/test_report.py` (sin red; los gráficos solo si hay matplotlib) y
  `node --test pruebas/test_report_api.mjs`. Spec y plan en `docs/superpowers/`.
```

- [ ] **Step 4: `CLAUDE.md`**: en Mapa añadir la línea
`- report_semanal.py, report_calc.py, report_graficos.py: report semanal (paquete en R2 report/); nube/report.js: sus rutas; skill /report-semanal`
y en Comandos, tras la línea de Takes:
`Report: python pruebas/test_report.py y node --test pruebas/test_report_api.mjs.`

- [ ] **Step 5: `docs/ESTADO.md`**: añadir el punto
`- **Report semanal** (2026-11-13): primera versión con /report-semanal. Siguientes posibles: report diario sin LLM, tarea programada, histórico propio de AUM de ETFs, ajustar umbrales tras los primeros reports.`
y, si la Task 1 dejó fuentes sin servir, cuáles.

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/report-semanal docs/ARQUITECTURA.md CLAUDE.md docs/ESTADO.md
git commit -m "Report semanal: skill del proyecto y documentacion

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Subida, secreto y prueba real

- [ ] **Step 1: CHANGELOG y push (con OK del usuario)**

Entrada del día en `CHANGELOG.md` (ampliar la de 2026-11-13 si existe): Añadido «Report semanal: /report-semanal
en Claude Code genera un borrador de Founder Take con gamma y niveles, vol realizada y spot-vol, rebalanceo de ETFs
apalancados y vol a strike fijo»; Cambiado «Takes: si un guardado falla a mitad, se borran los archivos subidos y el
Take nuevo». Commit y, con el OK del usuario, `git push origin main` (lanza `desplegar.yml`).

- [ ] **Step 2: Secreto (lo hace el usuario)**

El usuario crea el secreto `REPORT_TOKEN` en GitHub, relanza `desplegar.yml`
(`gh api -X POST repos/LoppVicious/gexlab/actions/workflows/desplegar.yml/dispatches -f ref=main`) y crea la variable
de entorno de usuario `GEXLAB_REPORT_TOKEN` en Windows (reiniciando Claude Code para que la vea).
Comprobar: `curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $GEXLAB_REPORT_TOKEN" https://dashboard.gexlab.workers.dev/api/report/ultimo`
Expected: `404` antes de la primera ejecución del report (no hay `ultimo.json`) y `200` después; con otro token, `404` siempre.

- [ ] **Step 3: Ejecutar `report.yml` y revisar el paquete**

```bash
gh api -X POST repos/LoppVicious/gexlab/actions/workflows/report.yml/dispatches -f ref=main
```

En el log: las pruebas pasan (con `test_graficos` real) y una línea por bloque. Descargar el paquete y los PNG con
`curl` y revisar a mano: las cifras de gamma frente a la web (mismo ticker, motor Perfil, todos los vencimientos), la
vol a strike fijo frente al Volatility dashboard, la serie de FRED completa, y que los PNG se leen bien en los temas
claro y oscuro de Takes. Corregir lo que no cuadre antes del paso 4.

- [ ] **Step 4: `/report-semanal` de punta a punta**

Ejecutar el skill, comprobar que crea el borrador con autor `claude`, abrirlo en la web (navegador integrado, cuenta
Claude) en los dos temas, y enseñárselo al usuario para que lo revise y decida si publica.
