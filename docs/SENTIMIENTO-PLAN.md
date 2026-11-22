# Sentimiento por put/call: plan de implementación

> **Para agentes:** sub-skill obligatoria: superpowers:subagent-driven-development (recomendada) o
> superpowers:executing-plans, tarea a tarea. Los pasos usan casillas (`- [ ]`).

**Objetivo:** indicador de sentimiento 1-100 (100 = codicia) por ticker a partir del put/call por tramos de
vencimiento, con divergencias, lectura de mercado, señal de swing en `skew.py` y página **Sentiment** en la web.

**Arquitectura:** `pcr.py` (nuevo) calcula las sumas por tramo de la cadena de cierre, mantiene
`hist500/_pcr.json.gz` y `hist500/_pcr_exp.json.gz`, calcula z, puntuaciones, divergencias y mercado, y publica
`pub/pcr.json`. `historial500.py` lo alimenta cada cierre y lo reconstruye con `--indice`. `skew.py` toma la z
combinada como señal `pcr`. La web lee `/api/pcr`.

**Stack:** Python 3 + numpy, almacén R2 (`almacen.py`), web en JS sin framework con SVG propio.

Diseño: `docs/SENTIMIENTO.md`. Reglas del proyecto: `CLAUDE.md` (web en inglés, código y comentarios en español,
colores de `C`, sin «·» en la web, `CHANGELOG.md` en el mismo commit del push, `git add` explícito: hay otras sesiones
en la misma carpeta).

---

## Archivos

| Archivo | Qué |
|---|---|
| `pcr.py` (nuevo) | sumas por tramo, desglose por vencimiento, índice, z, puntuación, divergencias, mercado, publicación |
| `pruebas/test_pcr.py` (nuevo) | pruebas sin red de `pcr.py` |
| `skew.py` | señal `pcr` (v[7] de la fila), `calcular(..., pcrz)`, `publicar` lee las z |
| `historial500.py` | alta diaria, reconstrucción en `--indice`, `publicar_pcr` |
| `server.py` | `/api/pcr` |
| `web/nube.js` | `/api/pcr` → `pub/pcr.json` |
| `web/sentiment.js`, `web/sentiment.css` (nuevos) | página Sentiment |
| `web/index.html`, `web/app.js` | menú, vista, `TOOLS`, `NAV`, script y hoja de estilo |
| `web/skewsig.js`, `web/index.html` | botón y columna de consenso de la señal `pcr` |
| `web/resumen.js` | tarjeta de sentimiento en Summary |
| `docs/ARQUITECTURA.md`, `CLAUDE.md`, `CHANGELOG.md`, `docs/ESTADO.md` | documentación |

Formato de las sumas de un tramo: `[vc, vp, oc, op]` = volumen × |delta| de calls y puts, OI × |delta| de calls y puts,
solo contratos fuera de dinero. La delta es la que ya trae la cadena (`ch["delta"]`, la del motor, guardada en la
cadena compacta).

---

### Tarea 1: sumas por tramo y desglose por vencimiento

**Archivos:** crear `pcr.py`, crear `pruebas/test_pcr.py`.

- [ ] **Paso 1: prueba que falla**

`pruebas/test_pcr.py`:

```python
"""Pruebas sin red de pcr.py (sentimiento por put/call). Uso: python pruebas/test_pcr.py"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import numpy as np  # noqa: E402

import pcr  # noqa: E402

SES = "2026-11-20"


def cadena(filas):
    """filas: (strike, es_call, vencimiento 'AAAA-MM-DD', vol, oi, delta)."""
    return {"K": np.array([f[0] for f in filas], float), "call": np.array([f[1] for f in filas], bool),
            "exp": np.array([f[2] + "T16:00" for f in filas], dtype="datetime64[m]"),
            "vol": np.array([f[3] for f in filas], float), "oi": np.array([f[4] for f in filas], float),
            "delta": np.array([f[5] for f in filas], float)}


def test_sumas_otm_y_delta():
    ch = cadena([
        (110, True, "2026-11-27", 100, 1000, 0.30),    # call fuera de dinero, t0 (7 días)
        (90, True, "2026-11-27", 5000, 9000, 0.95),    # call dentro de dinero (dividendo): fuera
        (90, False, "2026-11-27", 200, 500, -0.25),    # put fuera de dinero, t0
        (110, False, "2026-11-27", 50, 50, -0.90),     # put dentro de dinero: fuera
        (95, False, "2026-12-18", 40, 400, -0.40),     # put fuera de dinero, t1 (28 días)
        (130, True, "2027-06-18", 10, 300, 0.10),      # call fuera de dinero, t2
    ])
    s = pcr.sumas(ch, 100.0, SES)
    assert s["t0"] == [30.0, 50.0, 300.0, 125.0]
    assert s["t1"] == [0.0, 16.0, 0.0, 160.0]
    assert s["t2"] == [1.0, 0.0, 30.0, 0.0]
    assert s["all"] == [31.0, 66.0, 330.0, 285.0]


def test_sumas_tramo_vacio_y_vencido():
    ch = cadena([(110, True, "2026-11-19", 100, 100, 0.3),   # vencido antes de la sesión: fuera
                 (110, True, "2026-11-20", 10, 0, 0.2)])     # vence hoy: t0
    s = pcr.sumas(ch, 100.0, SES)
    assert s["t0"] == [2.0, 0.0, 0.0, 0.0] and s["t1"] is None and s["t2"] is None


def test_por_vencimiento():
    ch = cadena([(110, True, "2026-11-27", 100, 1000, 0.30), (90, False, "2026-11-27", 200, 500, -0.25),
                 (95, False, "2026-12-18", 40, 400, -0.40)])
    v = pcr.por_vencimiento(ch, 100.0, SES)
    assert v == [{"exp": "2026-11-27", "dte": 7, "pc_vol": round(50 / 30, 4), "pc_oi": round(125 / 300, 4)},
                 {"exp": "2026-12-18", "dte": 28, "pc_vol": None, "pc_oi": None}]


if __name__ == "__main__":
    n = 0
    for nombre, f in list(globals().items()):
        if nombre.startswith("test_"):
            f()
            n += 1
    print(f"test_pcr: {n} pruebas OK")
```

- [ ] **Paso 2: comprobar que falla**

Ejecutar: `.venv\Scripts\python.exe pruebas/test_pcr.py`
Esperado: `ModuleNotFoundError: No module named 'pcr'`.

- [ ] **Paso 3: implementación mínima**

`pcr.py`:

```python
"""Sentimiento por put/call (diseño en docs/SENTIMIENTO.md).

Con la cadena del cierre que guarda historial500.py, suma por tramo de vencimiento el volumen y el OI de calls y puts
fuera de dinero ponderados por |delta| (la del motor, la que guarda la cadena compacta). Fuera de dinero porque las
calls dentro del dinero que se compran antes del dividendo (KO, PFE) disparan el volumen sin decir nada del
sentimiento; |delta| para que una put lejana de 0,05 no pese lo mismo que una ATM. El spot se cancela en el ratio.

  t0: 0-7 días naturales (especulación), t1: 8-45 (mensual), t2: más de 45 (coberturas), all: todos.

Índice hist500/_pcr.json.gz = {fecha: {SYM: {t0|t1|t2|all: [vc, vp, oc, op] o None}}} (None: sin contratos fuera de
dinero en el tramo) y hist500/_pcr_exp.json.gz = {SYM: P/C por vencimiento del último día}. Puntuación de cada ticker:
z robusta de log(P/C de volumen) frente a sus VENTANA sesiones anteriores (mínimo MIN_SES), 1 + 99 × Φ(−z): 100 =
codicia (menos puts que lo normal), 1 = miedo. Publica pub/pcr.json (/api/pcr)."""
from __future__ import annotations

import math

import numpy as np

import almacen
import gex_engine as g
import skew

INDICE = "hist500/_pcr.json.gz"
VENCIMIENTOS = "hist500/_pcr_exp.json.gz"
PUB = "pub/pcr.json"
TRAMOS = {"t0": (0, 7), "t1": (8, 45), "t2": (46, 100_000), "all": (0, 100_000)}


def _r(p: float, c: float) -> float | None:
    return round(p / c, 4) if p > 0 and c > 0 else None


def _base(ch: dict, spot: float, sesion: str):
    """Días naturales al vencimiento, máscara fuera de dinero y no vencido, peso |delta|."""
    dias = ch["exp"].astype("datetime64[D]")
    dte = (dias - np.datetime64(sesion)).astype(int)
    otm = np.where(ch["call"], ch["K"] > spot, ch["K"] < spot) & (dte >= 0)
    return dias, dte, otm, np.abs(ch["delta"])


def _cuatro(ch: dict, m: np.ndarray, w: np.ndarray) -> list[float]:
    C = ch["call"]
    return [round(float((ch[k][x] * w[x]).sum()), 2) for k in ("vol", "oi") for x in (m & C, m & ~C)]


def sumas(ch: dict, spot: float, sesion: str) -> dict:
    """{tramo: [vc, vp, oc, op] o None}."""
    _, dte, otm, w = _base(ch, spot, sesion)
    out = {}
    for t, (a, b) in TRAMOS.items():
        m = otm & (dte >= a) & (dte <= b)
        out[t] = _cuatro(ch, m, w) if m.any() else None
    return out


def por_vencimiento(ch: dict, spot: float, sesion: str) -> list[dict]:
    """P/C de volumen y de OI de cada vencimiento (mismos contratos y pesos que sumas)."""
    dias, dte, otm, w = _base(ch, spot, sesion)
    out = []
    for d in np.unique(dias[otm]):
        m = otm & (dias == d)
        vc, vp, oc, op = _cuatro(ch, m, w)
        out.append({"exp": str(d), "dte": int(dte[m][0]), "pc_vol": _r(vp, vc), "pc_oi": _r(op, oc)})
    return out
```

Nota: `_cuatro` devuelve `[vol call, vol put, oi call, oi put]` (el bucle externo es `k`, el interno el lado).

- [ ] **Paso 4: comprobar que pasa**

Ejecutar: `.venv\Scripts\python.exe pruebas/test_pcr.py`
Esperado: `test_pcr: 3 pruebas OK`.

- [ ] **Paso 5: commit**

```powershell
git add pcr.py pruebas/test_pcr.py
git commit -m "pcr: sumas de put/call por tramo y por vencimiento"
```

---

### Tarea 2: z robusta y puntuación

**Archivos:** modificar `pcr.py`, `pruebas/test_pcr.py`.

- [ ] **Paso 1: pruebas que fallan** (añadir a `pruebas/test_pcr.py`, antes del bloque `__main__`)

```python
def test_serie_z_minimo_y_mad():
    xs = [0.0, 1.0] * 10                          # 20 valores: mediana 0,5, MAD 0,5
    z = pcr.serie_z(xs + [2.0])
    assert all(v is None for v in z[:20])         # sin 20 sesiones previas, sin z
    assert abs(z[20] - (2.0 - 0.5) / (1.4826 * 0.5)) < 1e-9
    assert pcr.serie_z([1.0] * 21)[20] is None    # MAD 0: sin lectura
    assert pcr.serie_z([None] * 5 + [0.0, 1.0] * 10 + [None])[-1] is None   # hoy sin dato


def test_serie_z_ventana():
    xs = [5.0] * 40 + [0.0, 1.0] * 30 + [0.5]     # las 40 primeras quedan fuera de la ventana de 60
    assert abs(pcr.serie_z(xs)[-1]) < 1e-9


def test_puntuacion_escala():
    assert pcr.puntuacion(0.0) == 50 or pcr.puntuacion(0.0) == 51
    assert pcr.puntuacion(3.0) == 1               # muchas más puts que lo normal: miedo
    assert pcr.puntuacion(-3.0) == 100            # muchas menos puts: codicia
    assert pcr.puntuacion(1.0) < pcr.puntuacion(0.0) < pcr.puntuacion(-1.0)
    assert pcr.puntuacion(None) is None


def test_log_pc():
    assert pcr.log_pc([10.0, 20.0, 5.0, 5.0]) == math.log(2.0)
    assert pcr.log_pc([10.0, 20.0, 5.0, 10.0], oi=True) == math.log(2.0)
    assert pcr.log_pc([0.0, 20.0, 5.0, 5.0]) is None and pcr.log_pc(None) is None
```

- [ ] **Paso 2: comprobar que fallan**

Ejecutar: `.venv\Scripts\python.exe pruebas/test_pcr.py`
Esperado: `AttributeError: module 'pcr' has no attribute 'serie_z'`.

- [ ] **Paso 3: implementación** (añadir a `pcr.py` tras `TRAMOS`)

```python
VENTANA = 60                    # sesiones de la referencia de cada ticker
MIN_SES = 20                    # sesiones previas mínimas para dar z
```

y al final del archivo:

```python
# ---------------------------------------------------------------- z y puntuación
def log_pc(s: list | None, oi: bool = False) -> float | None:
    """log(puts / calls) de unas sumas [vc, vp, oc, op]; None sin las dos patas."""
    if not s:
        return None
    c, p = (s[2], s[3]) if oi else (s[0], s[1])
    return math.log(p / c) if p > 0 and c > 0 else None


def serie_z(xs: list[float | None]) -> list[float | None]:
    """z robusta de cada valor frente a los VENTANA anteriores (posiciones de sesión; los None no cuentan):
    (x − mediana) / (1,4826 × MAD). Sin MIN_SES valores previos o con MAD 0, None."""
    out: list[float | None] = []
    for i, x in enumerate(xs):
        prev = np.array([v for v in xs[max(0, i - VENTANA):i] if v is not None])
        if x is None or prev.size < MIN_SES:
            out.append(None)
            continue
        med = float(np.median(prev))
        mad = float(np.median(np.abs(prev - med)))
        out.append((x - med) / (1.4826 * mad) if mad > 0 else None)
    return out


def puntuacion(z: float | None) -> int | None:
    """1 + 99 × Φ(−z): z alta (más puts que lo normal) = miedo, cerca de 1; z baja = codicia, cerca de 100."""
    return None if z is None else int(round(1 + 99 * 0.5 * (1 + math.erf(-z / math.sqrt(2)))))
```

- [ ] **Paso 4: comprobar que pasan**

Ejecutar: `.venv\Scripts\python.exe pruebas/test_pcr.py`
Esperado: `test_pcr: 7 pruebas OK`.

- [ ] **Paso 5: commit**

```powershell
git add pcr.py pruebas/test_pcr.py
git commit -m "pcr: z robusta y puntuacion de 1 a 100"
```

---

### Tarea 3: divergencias con el precio

**Archivos:** modificar `pcr.py`, `pruebas/test_pcr.py`.

Regla (de la spec): bajista si el cierre está en máximo de `DIV_SES` = 20 sesiones y la media de la puntuación de las 5
últimas cae al menos `DIV_PUNTOS` = 15 frente a la de las 5 anteriores; alcista al revés. `flags` marca cada sesión
donde se cumple; `casos` cuenta solo la primera de cada racha (otra del mismo tipo no cuenta hasta pasar 10 sesiones
sin ella), para que la estadística no repita el mismo episodio.

- [ ] **Paso 1: pruebas que fallan**

```python
def test_divergencia_bajista_y_racha():
    cierres = [100.0 + i for i in range(30)]                  # máximos de 20 sesiones cada día
    scores = [70] * 20 + [40] * 10                            # la puntuación se hunde
    casos, flags = pcr.divergencias(cierres, scores)
    # i = 21: media 58 frente a 70 (−12), aún no; i = 22: 52 frente a 70 (−18), sí
    assert flags[21] is None and flags[22] == "bear"
    assert casos == [(22, "bear")]                            # la racha (22 a 26) cuenta una vez
    assert flags[29] is None                                  # 40 frente a 40: sin diferencia


def test_divergencia_alcista():
    cierres = [200.0 - i for i in range(25)]
    scores = [30] * 20 + [60] * 5
    casos, _ = pcr.divergencias(cierres, scores)
    assert casos and casos[0][1] == "bull"


def test_sin_divergencia_con_huecos():
    cierres = [100.0 + i for i in range(30)]
    cierres[15] = None                                        # falta un cierre en la ventana: no se evalúa
    casos, flags = pcr.divergencias(cierres, [70] * 20 + [40] * 10)
    assert all(f is None for f in flags[15:35]) and not casos
```

- [ ] **Paso 2: comprobar que fallan**

Ejecutar: `.venv\Scripts\python.exe pruebas/test_pcr.py`
Esperado: `AttributeError: module 'pcr' has no attribute 'divergencias'`.

- [ ] **Paso 3: implementación**

Constantes junto a las demás:

```python
DIV_SES = 20                    # máximo o mínimo de cierre de estas sesiones
DIV_MEDIA = 5                   # sesiones de cada media de la puntuación
DIV_PUNTOS = 15                 # diferencia mínima entre las dos medias
```

Al final de `pcr.py`:

```python
# ---------------------------------------------------------------- divergencias
def divergencias(cierres: list, scores: list) -> tuple[list[tuple[int, str]], list[str | None]]:
    """flags: "bear"/"bull"/None por sesión; casos: (sesión, tipo) de la primera sesión de cada racha."""
    n = len(scores)
    flags: list[str | None] = [None] * n
    casos, ultimo = [], {}
    for i in range(n):
        if i < max(DIV_SES, 2 * DIV_MEDIA) - 1:
            continue
        ven = cierres[i - DIV_SES + 1:i + 1]
        a = scores[i - DIV_MEDIA + 1:i + 1]
        b = scores[i - 2 * DIV_MEDIA + 1:i - DIV_MEDIA + 1]
        if any(x is None for x in (*ven, *a, *b)):
            continue
        d = float(np.mean(a) - np.mean(b))
        tipo = ("bear" if ven[-1] >= max(ven) and d <= -DIV_PUNTOS else
                "bull" if ven[-1] <= min(ven) and d >= DIV_PUNTOS else None)
        if not tipo:
            continue
        flags[i] = tipo
        if i - ultimo.get(tipo, -10**6) > 2 * DIV_MEDIA:
            casos.append((i, tipo))
        ultimo[tipo] = i
    return casos, flags
```

- [ ] **Paso 4: comprobar que pasan**

Ejecutar: `.venv\Scripts\python.exe pruebas/test_pcr.py`
Esperado: `test_pcr: 10 pruebas OK`.

- [ ] **Paso 5: commit**

```powershell
git add pcr.py pruebas/test_pcr.py
git commit -m "pcr: divergencias entre puntuacion y precio"
```

---

### Tarea 4: cálculo completo y publicación

**Archivos:** modificar `pcr.py`, `pruebas/test_pcr.py`.

- [ ] **Paso 1: prueba que falla**

```python
def _idx_sintetico(n=30):
    """AAPL con P/C estable y un salto de puts el último día; SPY estable; cierres en el índice de skew."""
    rng = np.random.default_rng(1)
    idx, sk = {}, {}
    for i in range(n):
        f = f"2026-{9 + i // 28:02d}-{1 + i % 28:02d}"
        pa = 1.0 + 0.1 * rng.standard_normal() if i < n - 1 else 3.0
        idx[f] = {"AAPL": {"t0": [100.0, 100 * pa, 10.0, 10.0], "t1": [50.0, 50 * pa, 5.0, 5.0], "t2": None, "all": [150.0, 150 * pa, 15.0, 15.0]},
                  "SPY": {"t0": [100.0, 150 + rng.standard_normal(), 1.0, 1.0], "t1": None, "t2": None, "all": None}}
        sk[f] = {"AAPL": [None, None, 100.0 + i, None, None, None], "SPY": [None, None, 500.0, None, None, None]}
    return idx, sk


def test_calcular():
    idx, sk = _idx_sintetico()
    r = pcr.calcular(idx, sk, {"AAPL": "Apple Inc", "SPY": "SPDR S&P 500 ETF Trust"}, {"AAPL": [{"exp": "x"}]},
                     {"sign": -1, "sessions": 3, "eval": {}})
    filas = {x["sym"]: x for x in r["rows"]}
    a = filas["AAPL"]
    assert a["stock"] and not filas["SPY"]["stock"]
    assert a["score"] is not None and a["score"] <= 5          # salto de puts: miedo
    assert a["tranches"]["t0"]["score"] <= 5 and a["tranches"]["t2"]["score"] is None
    assert a["n"] == 30 and r["sessions"] == 30
    assert r["market"]["indices"]["SPY"]["score"] is not None
    assert r["market"]["breadth"]["n"] == 1 and r["market"]["breadth"]["fear_pct"] == 100.0
    assert r["market"]["stocks"]["score"] == a["score"]         # una sola acción: el agregado es ella
    assert r["series"]["AAPL"][-1] == [max(idx), 129.0, a["score"]]
    assert r["expiries"] == {"AAPL": [{"exp": "x"}]} and r["swing"]["sign"] == -1
    assert "_STOCKS" not in filas


def test_zetas_y_vacio():
    idx, _ = _idx_sintetico()
    z = pcr.zetas(idx)
    assert z[max(idx)]["AAPL"] > 3 and min(idx) not in z
    try:
        pcr.calcular({}, {}, {})
        raise AssertionError("sin historia debe fallar")
    except LookupError:
        pass
```

- [ ] **Paso 2: comprobar que fallan**

Ejecutar: `.venv\Scripts\python.exe pruebas/test_pcr.py`
Esperado: `AttributeError: module 'pcr' has no attribute 'calcular'`.

- [ ] **Paso 3: implementación**

Constantes:

```python
CAMBIO = 5                      # sesiones del cambio de la puntuación
HORIZONTES = (10, 40)           # rendimiento tras una divergencia (los de skew)
INDICES = ("SPX", "SPY", "QQQ", "IWM")
AGREGADO = "_STOCKS"            # suma de todas las acciones (t0 y t1), como un ticker más
SERIE_MAX = 250                 # sesiones publicadas por ticker para el gráfico
```

Al final de `pcr.py`:

```python
# ---------------------------------------------------------------- cálculo
def _media(zs: list) -> float | None:
    v = [z for z in zs if z is not None]
    return float(np.mean(v)) if v else None


def _red(x: float | None, nd: int = 4) -> float | None:
    return None if x is None else round(x, nd)


def _ticker(fechas: list[str], idx: dict, sym: str):
    """z y P/C de cada tramo por sesión y z combinada (media de t0 y t1)."""
    filas = [idx[f].get(sym) or {} for f in fechas]
    z, zoi, pc = {}, {}, {}
    for t in TRAMOS:
        xs = [log_pc(r.get(t)) for r in filas]
        z[t] = serie_z(xs)
        zoi[t] = serie_z([log_pc(r.get(t), oi=True) for r in filas])
        pc[t] = [None if x is None else math.exp(x) for x in xs]
    comb = [_media([z["t0"][i], z["t1"][i]]) for i in range(len(fechas))]
    n = sum(1 for r in filas if log_pc(r.get("t0")) is not None or log_pc(r.get("t1")) is not None)
    return z, zoi, pc, comb, n


def _con_agregado(idx: dict, acciones: set[str]) -> dict:
    """Añade AGREGADO a cada sesión: suma de t0 y t1 de todas las acciones."""
    out = {}
    for f, d in idx.items():
        agg = {}
        for t in ("t0", "t1"):
            v = [d[s][t] for s in d if s in acciones and d[s].get(t)]
            agg[t] = [round(sum(x[k] for x in v), 2) for k in range(4)] if v else None
        out[f] = {**d, AGREGADO: agg}
    return out


def zetas(idx: dict) -> dict:
    """{fecha: {SYM: z combinada}} para la señal de swing de skew.py (más puts que lo normal = alto)."""
    fechas = sorted(idx)
    out: dict = {}
    for s in {s for d in idx.values() for s in d}:
        for f, z in zip(fechas, _ticker(fechas, idx, s)[3]):
            if z is not None:
                out.setdefault(f, {})[s] = round(z, 4)
    return out


def _ret(c: list, i: int, h: int) -> float | None:
    j = i + h
    if j >= len(c) or not c[i] or not c[j] or abs(c[j] / c[i] - 1) >= skew.SALTO:
        return None
    return c[j] / c[i] - 1


def _resumen_div(lista: list[tuple], signo: int) -> dict:
    out = {"n": len(lista)}
    for k, h in enumerate(HORIZONTES):
        r = [x[k] for x in lista if x[k] is not None]
        out[f"n{h}"] = len(r)
        out[f"ret{h}"] = round(float(np.mean(r)), 5) if r else None
        out[f"hit{h}"] = round(sum(1 for x in r if x * signo > 0) / len(r), 3) if r else None
    return out


def calcular(idx: dict, idx_skew: dict, nombres: dict, venc: dict | None = None, swing: dict | None = None) -> dict:
    if not idx:
        raise LookupError("Not enough history yet: the put/call index is empty.")
    fechas = sorted(idx)
    hoy = fechas[-1]
    syms = sorted({s for d in idx.values() for s in d})
    acciones = {s for s in syms if skew.es_accion(s, nombres)}
    idx = _con_agregado(idx, acciones)
    rows, series, casos_tipo = [], {}, {"bear": [], "bull": []}
    for sym in syms + [AGREGADO]:
        if sym not in idx[hoy] or not idx[hoy][sym]:
            continue
        z, zoi, pc, comb, n = _ticker(fechas, idx, sym)
        sc = [puntuacion(x) for x in comb]
        u = len(fechas) - 1
        row = {"sym": sym, "name": nombres.get(sym, ""), "stock": sym in acciones, "n": n,
               "score": sc[u], "z": _red(comb[u]),
               "chg5": sc[u] - sc[u - CAMBIO] if u >= CAMBIO and sc[u] is not None and sc[u - CAMBIO] is not None else None,
               "tranches": {t: {"pc": _red(pc[t][u]), "z": _red(z[t][u]), "zoi": _red(zoi[t][u]),
                                "score": puntuacion(z[t][u])} for t in TRAMOS},
               "div": None}
        if sym != AGREGADO:
            cier = [((idx_skew.get(f) or {}).get(sym) or [None] * 3)[2] for f in fechas]
            casos, flags = divergencias(cier, sc)
            rec = [(i, t) for i, t in enumerate(flags) if t and i > u - DIV_MEDIA]
            if rec:
                row["div"] = {"type": rec[-1][1], "date": fechas[rec[-1][0]]}
            for i, t in casos:
                casos_tipo[t].append(tuple(_ret(cier, i, h) for h in HORIZONTES))
            series[sym] = [[fechas[i], cier[i], sc[i]] for i in range(max(0, len(fechas) - SERIE_MAX), len(fechas))
                           if cier[i] is not None or sc[i] is not None]
        rows.append(row)
    por = {r["sym"]: r for r in rows}
    agg = por.get(AGREGADO)
    rows = [r for r in rows if r["sym"] != AGREGADO]
    st = [r["score"] for r in rows if r["stock"] and r["score"] is not None]
    pct = lambda cond: round(100 * sum(1 for x in st if cond(x)) / len(st), 1) if st else None  # noqa: E731
    market = {
        "indices": {s: {k: por[s][k] for k in ("score", "z", "chg5", "n")} for s in INDICES if s in por},
        "breadth": {"n": len(st), "median": float(np.median(st)) if st else None,
                    "fear_pct": pct(lambda x: x < 20), "greed_pct": pct(lambda x: x > 80)},
        "stocks": {k: agg[k] for k in ("score", "z", "chg5", "n")} if agg else None,
    }
    return {"date": hoy, "first": fechas[0], "sessions": len(fechas), "window": VENTANA, "min_sessions": MIN_SES,
            "market": market, "rows": rows, "expiries": venc or {}, "series": series,
            "divergences": {"bear": _resumen_div(casos_tipo["bear"], -1), "bull": _resumen_div(casos_tipo["bull"], 1),
                            "rule": {"sessions": DIV_SES, "mean": DIV_MEDIA, "points": DIV_PUNTOS}},
            "swing": swing}
```

Persistencia (al final):

```python
# ---------------------------------------------------------------- índice en R2
def actualizar(st, sesion: str, filas: dict, venc: dict) -> int:
    """filas: {SYM: sumas}; venc: {SYM: por_vencimiento} del día (sustituye al anterior)."""
    idx = almacen.get_json(st, INDICE) or {}
    idx[sesion] = filas
    almacen.put_json(st, INDICE, dict(sorted(idx.items())))
    if venc:
        almacen.put_json(st, VENCIMIENTOS, venc)
    return len(idx)


def _dias(st, sym: str):
    """Sumas de todos los días guardados de un ticker y el desglose por vencimiento del último."""
    import re
    rx = re.compile(r"/(\d{4}-\d{2}-\d{2})\.json\.gz$")
    res, ultimo = {}, None
    for k in sorted(k for k in st.list(f"hist500/{sym}/") if rx.search(k)):
        dia = rx.search(k).group(1)
        d = almacen.get_json(st, k) or {}
        if not d.get("chain") or not d.get("spot"):
            continue
        try:
            ch = g.parse_chain({"_min": d["chain"]})
            s = float(d["spot"])
            res[dia] = sumas(ch, s, dia)
            ultimo = por_vencimiento(ch, s, dia)
        except Exception:  # noqa: BLE001  (un día roto no para el resto)
            continue
    return sym, res, ultimo


def reconstruir(st, syms: list[str]) -> int:
    """Índice desde todas las cadenas guardadas en hist500/{SYM}/ (8 lecturas en paralelo: cada una tarda ~1 s)."""
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=8) as ex:
        partes = list(ex.map(lambda s: _dias(st, s), syms))
    idx, venc = {}, {}
    for sym, res, ult in partes:
        for dia, s in res.items():
            idx.setdefault(dia, {})[sym] = s
        if ult is not None:
            venc[sym] = ult
    almacen.put_json(st, INDICE, dict(sorted(idx.items())))
    almacen.put_json(st, VENCIMIENTOS, venc)
    return len(idx)


def publicar(st) -> dict | None:
    """pub/pcr.json con el índice, los cierres del índice de skew y la prueba de la señal pcr de pub/skew.json
    (por eso se publica después de skew)."""
    idx = almacen.get_json(st, INDICE) or {}
    if not idx:
        return None
    sg = ((almacen.get_json(st, "pub/skew.json") or {}).get("signals") or {}).get("pcr")
    swing = {k: sg[k] for k in ("sign", "sessions", "eval")} if sg else None
    res = calcular(idx, almacen.get_json(st, skew.INDICE) or {}, dict(g.load_symbols()),
                   almacen.get_json(st, VENCIMIENTOS) or {}, swing)
    almacen.put_json(st, PUB, res)
    return res
```

- [ ] **Paso 4: comprobar que pasan**

Ejecutar: `.venv\Scripts\python.exe pruebas/test_pcr.py`
Esperado: `test_pcr: 12 pruebas OK`. Las fechas sintéticas de `_idx_sintetico` deben ser 30 distintas y ordenadas
(28 de septiembre y 2 de octubre): comprobar `len(idx) == 30` si algo no cuadra.

- [ ] **Paso 5: commit**

```powershell
git add pcr.py pruebas/test_pcr.py
git commit -m "pcr: puntuaciones, mercado, divergencias y publicacion"
```

---

### Tarea 5: señal `pcr` en `skew.py`

**Archivos:** modificar `skew.py` (`SENALES` en la línea ~67, `calcular` ~415, `publicar` ~458, docstring),
`pruebas/test_pcr.py`.

- [ ] **Paso 1: prueba que falla**

```python
def test_skew_con_pcr():
    import skew
    idx = {"2026-11-20": {s: [0.3, 0.35, 100.0, 0.0, 1000.0, 1e6] for s in [f"S{i}" for i in range(25)]}}
    pcrz = {"2026-11-20": {f"S{i}": i / 10 for i in range(25)}}
    r = skew.calcular(idx, {f"S{i}": f"Stock {i} Inc" for i in range(25)}, None, pcrz)
    filas = {x["sym"]: x for x in r["rows"]}
    assert filas["S24"]["pcr"]["v"] == 2.4 and filas["S24"]["pcr"]["score"] > filas["S0"]["pcr"]["score"]
    assert r["signals"]["pcr"]["sign"] == -1
```

- [ ] **Paso 2: comprobar que falla**

Ejecutar: `.venv\Scripts\python.exe pruebas/test_pcr.py`
Esperado: `TypeError: calcular() takes from 2 to 3 positional arguments but 4 were given`.

- [ ] **Paso 3: implementación**

En `SENALES` añadir:

```python
    # z combinada de put/call de pcr.py (más puts que lo normal del ticker = alto), en v[7] por _con_pcr.
    # Pan y Poteshman (2006): más puts, peor rendimiento (con volumen de apertura comprador; aquí volumen total)
    "pcr": (lambda v: v[7] if len(v) > 7 else None, -1),
```

Tras `_con_rv`:

```python
def _con_pcr(idx: dict[str, dict], pcrz: dict) -> dict[str, dict]:
    """Añade en v[7] la z combinada de put/call (pcr.zetas). Las filas de _con_rv tienen 7 campos."""
    return {f: {s: list(v) + [None] * (7 - len(v)) + [(pcrz.get(f) or {}).get(s)] for s, v in d.items()}
            for f, d in idx.items()}
```

En `calcular`, firma y primera línea:

```python
def calcular(idx: dict[str, dict], nombres: dict[str, str], lista: list[str] | None = None,
             pcrz: dict | None = None) -> dict:
    idx = _con_pcr(_con_rv(idx), pcrz or {})
```

En `publicar`:

```python
    import pcr  # aquí y no arriba: pcr importa skew
    res = calcular(idx, dict(g.load_symbols()), guardados, pcr.zetas(almacen.get_json(st, pcr.INDICE) or {}))
```

Docstring de `skew.py`: añadir tras el bloque de O/S:

```
  put/call (pcr.py): z de log(P/C de volumen fuera de dinero ponderado por delta, vencimientos de 0 a 45 días)
    frente a la historia de cada acción. Más puts que lo normal, peor rendimiento (Pan y Poteshman, 2006, con
    volumen de apertura comprador; aquí es el total). Hipótesis: IC negativo. Sin dato hasta MIN_SES sesiones.
```

- [ ] **Paso 4: comprobar que pasan**

Ejecutar: `.venv\Scripts\python.exe pruebas/test_pcr.py` y `.venv\Scripts\python.exe -c "import skew, pcr, historial500"`
Esperado: `test_pcr: 13 pruebas OK` y sin errores de importación.

- [ ] **Paso 5: commit**

```powershell
git add skew.py pruebas/test_pcr.py
git commit -m "skew: senal de put/call (pcr) en la prueba en adelante y el consenso"
```

---

### Tarea 6: `historial500.py`

**Archivos:** modificar `historial500.py` (import ~48, docstring ~25, `guardar_ticker` ~167, `publicar_skew` ~273,
`main` ~363-450).

- [ ] **Paso 1: import y docstring**

Tras `import skew  # noqa: E402`:

```python
import pcr  # noqa: E402
```

En el docstring, tras la línea de `hist500/_skew.json.gz`:

```
  hist500/_pcr.json.gz, hist500/_pcr_exp.json.gz y pub/pcr.json: sentimiento por put/call (pcr.py).
```

y la línea de `--indice` pasa a: `reconstruye hist500/_niveles/, _skew.json.gz y _pcr.json.gz con los dias ya guardados`.

- [ ] **Paso 2: `guardar_ticker`**

Firma: `def guardar_ticker(st, sym: str, sesion: str, puntos: dict | None = None, pcrs: dict | None = None) -> int:`

Tras el bloque `if puntos is not None: ...`:

```python
    if pcrs is not None:  # sentimiento por put/call (pcr.py): sumas por tramo y P/C por vencimiento del día
        try:
            spot = float(ch["spot"])
            pcrs[sym] = (pcr.sumas(ch, spot, sesion), pcr.por_vencimiento(ch, spot, sesion))
        except Exception as e:  # noqa: BLE001
            log(f"ERROR pcr {sym}: {type(e).__name__}: {str(e)[:120]}")
```

- [ ] **Paso 3: `publicar_pcr`** (tras `publicar_skew`)

```python
def publicar_pcr(st) -> None:
    """pub/pcr.json; después de publicar_skew, que trae la prueba de la señal pcr."""
    try:
        r = pcr.publicar(st)
        if r:
            log(f"pcr: {len(r['rows'])} tickers el {r['date']}, {r['sessions']} sesiones, "
                f"{sum(1 for x in r['rows'] if x['score'] is not None)} con puntuacion")
    except Exception as e:  # noqa: BLE001
        log(f"ERROR pcr: {type(e).__name__}: {str(e)[:120]}")
```

- [ ] **Paso 4: `main`**

En `--indice`, dentro de `if not pedidos:`, antes de `skew.reconstruir`:

```python
            try:
                log(f"pcr: indice con {pcr.reconstruir(st, syms)} sesiones")
            except Exception as e:  # noqa: BLE001
                log(f"ERROR pcr: {type(e).__name__}: {str(e)[:120]}")
```

y tras `publicar_skew(st)` (dentro del mismo `try` de skew, o justo después): `publicar_pcr(st)`.

En la sesión diaria: `pcrs: dict = {}` junto a `puntos: dict = {}`; la llamada pasa a
`n = guardar_ticker(st, sym, sesion, puntos, pcrs)`; antes de `if puntos:`:

```python
    if pcrs:
        try:
            n = pcr.actualizar(st, sesion, {s: v[0] for s, v in pcrs.items()}, {s: v[1] for s, v in pcrs.items()})
            log(f"pcr: {len(pcrs)} tickers, indice con {n} sesiones")
        except Exception as e:  # noqa: BLE001
            log(f"ERROR pcr: {type(e).__name__}: {str(e)[:120]}")
```

y tras el bloque `if puntos:` (después de `publicar_skew(st, ok)`): `publicar_pcr(st)`.

- [ ] **Paso 5: comprobar en local con datos reales de un ticker**

```powershell
$env:GEX_ALMACEN="local:./data/x"; .venv\Scripts\python.exe historial500.py --forzar AAPL
```

Esperado: `AAPL: ... KB` sin `ERROR pcr`. Como es prueba con tickers (`pedidos`), no escribe el índice: comprobar las
sumas a mano:

```powershell
$env:GEX_ALMACEN="local:./data/x"; .venv\Scripts\python.exe -c "import almacen,pcr,gex_engine as g; st=almacen.abrir(); k=sorted(st.list('hist500/AAPL/'))[-1]; d=almacen.get_json(st,k); ch=g.parse_chain({'_min':d['chain']}); s=k[-18:-8]; print(s, pcr.sumas(ch,float(d['spot']),s)); print(pcr.por_vencimiento(ch,float(d['spot']),s)[:4])"
```

Esperado: cuatro tramos con números positivos y P/C por vencimiento razonables (entre 0,2 y 5).

- [ ] **Paso 6: commit**

```powershell
git add historial500.py
git commit -m "historial500: indice de put/call diario, reconstruccion y publicacion"
```

---

### Tarea 7: API (`server.py`, `nube.js`)

- [ ] **Paso 1: `server.py`**, tras el bloque de `/api/skew` (~línea 295):

```python
        if url.path == "/api/pcr":  # lo calcula el historial diario (pcr.py); aqui se lee del almacen
            import almacen
            d = almacen.get_json(almacen.abrir(), "pub/pcr.json")
            if not d:
                return self._json(503, {"error": "Sentiment: no data yet. The daily history computes it after each close."})
            return self._json(200, d)
```

- [ ] **Paso 2: `web/nube.js`**, tras `case "/api/skew"`:

```js
      case "/api/pcr": return pub("pcr.json", s, "Sentiment");
```

El Worker ya sirve cualquier `pub/*` por `/api/pub/` (`nube/worker.js`, `SAFE_PATH`): no hay que tocarlo.

- [ ] **Paso 3: comprobar**

```powershell
node --check web\nube.js; .venv\Scripts\python.exe -c "import server"
```

- [ ] **Paso 4: commit**

```powershell
git add server.py web/nube.js
git commit -m "api: /api/pcr"
```

---

### Tarea 8: página Sentiment

**Archivos:** crear `web/sentiment.js`, `web/sentiment.css`; modificar `web/index.html`, `web/app.js`.

Globales con prefijo `sen` (memoria: los nombres chocan entre scripts). Reutiliza las clases de la Skew signal
(`macro mview`, `mside`, `facts`, `scan`, `ssk-bar`, `ssk-tilt`). Colores del gráfico, de `C`.

- [ ] **Paso 1: `web/index.html`**

Hoja de estilo, tras `cripto.css`: `<link rel="stylesheet" href="sentiment.css">`.

Menú, tras el botón `navSkew`:

```html
      <button class="item" id="navSent" data-title="Sentiment" title="Put/call sentiment of each ticker against its own history"><svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 14a7 7 0 0 1 14 0"/><path d="M10 14l3.5-4.5"/></svg><span class="lbl">Sentiment</span></button>
```

Vista, tras el `</main>` de `skewSigView`:

```html
<main class="macro mview" id="sentView" hidden>
  <aside class="mside" aria-label="Market sentiment">
    <div class="mhead">
      <div class="sym">Put/call sentiment</div>
      <div class="mstate" id="senState">—</div>
      <div class="msub" id="senSub"></div>
    </div>
    <div class="sen-gauge" id="senGauge"></div>
    <p class="regime" id="senRead"></p>
    <div class="facts" id="senFacts"></div>
    <p class="mnote">Each score compares a ticker's put/call ratio with its own last 60 sessions: <b>100</b> means far fewer puts than usual (greed), <b>1</b> far more (fear). Only out-of-the-money options count, weighted by delta, so dividend trades in deep in-the-money calls and cheap far puts do not move it. Combined: expirations up to 45 days. On indices the put/call ratio is mostly hedging, and its extremes have tended to mark turns the other way.</p>
  </aside>
  <section class="mcharts">
    <div class="mchart-head"><span class="mtitle" id="senChartTitle">Click a ticker</span></div>
    <div class="mchart" id="senChart" role="img" aria-label="Price and sentiment score"></div>
    <div class="sen-exp" id="senExp"></div>
    <p class="chart-caption" id="senCap"></p>
    <div class="tablewrap"><table class="scan sen-table" id="senTable">
      <thead><tr>
        <th data-k="sym" class="l">Ticker</th>
        <th data-k="score" title="Combined score, expirations up to 45 days (100 = greed)">Score</th>
        <th data-k="t0" title="Expirations within 7 days">0-7d</th>
        <th data-k="t1" title="Expirations of 8 to 45 days">8-45d</th>
        <th data-k="t2" title="Expirations beyond 45 days">45d+</th>
        <th data-k="chg5" title="Change of the combined score over 5 sessions">5d change</th>
        <th data-k="div" class="l" title="Price at a 20-session high or low while the score moves 15 points the other way">Divergence</th>
      </tr></thead>
      <tbody id="senBody"></tbody>
    </table></div>
    <p class="chart-caption" id="senFoot"></p>
  </section>
</main>
```

Script, tras `skewsig.js`: `<script src="sentiment.js"></script>`.

- [ ] **Paso 2: `web/app.js`**

En `TOOLS`, tras `skewsig`:

```js
  sentiment: { view: "sentView", ticker: false, show: () => showSent(), render: () => renderSent(), load: () => loadSent() },
```

En `NAV`, tras `navSkew`: `navSent: { t: "Sentiment", go: () => setMode("sentiment") },`
En `currentNav`, tras la línea de `skewsig`: `if (m === "sentiment") return "navSent";`

- [ ] **Paso 3: `web/sentiment.js`**

```js
"use strict";
/* ============================================================ Sentimiento por put/call (Signals, Sentiment)
   Datos: /api/pcr (pcr.py, lo publica historial500.py tras cada cierre). Puntuacion 1-100 de cada ticker frente a su
   propia historia (100 = codicia: menos puts que lo normal), por tramos de vencimiento, con divergencias frente al
   precio. A la izquierda el mercado; a la derecha el grafico del ticker elegido y la tabla.
   Nombres con prefijo sen: los scripts de web/ comparten globales. */

const sen = { data: null, at: 0, ctrl: null, sym: store.get("senSym", "SPY"), sort: "score", dir: 1 };
const senLabel = (s) => (s == null ? "" : s <= 20 ? "Fear" : s < 40 ? "Leaning fear" : s <= 60 ? "Neutral" : s < 80 ? "Leaning greed" : "Greed");
const senCls = (s) => (s == null ? "" : s < 40 ? "neg" : s > 60 ? "pos" : "");
const senNum = (s) => (s == null ? "—" : fmtNum(s, 0));
const senSigned = (v) => (v == null ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "") + fmtNum(Math.abs(v), 0));

function senStatus() { return sen.data ? `Put/call sentiment, close of ${ddmm(sen.data.date)}` : ""; }

function showSent() {
  if (sen.data) { renderSent(); setStatus("", senStatus()); }
  if (!sen.data || Date.now() - sen.at > 300000) loadSent();
}

async function loadSent() {
  if (sen.ctrl) sen.ctrl.abort();
  sen.ctrl = new AbortController();
  $("refreshBtn").classList.add("spin");
  setStatus("busy", "Loading the put/call sentiment…");
  if (!sen.data) $("senBody").innerHTML = `<tr><td class="l" colspan="7"><div class="empty">Loading…</div></td></tr>`;
  try {
    const r = await fetch("/api/pcr", { signal: sen.ctrl.signal });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Could not load the sentiment");
    sen.data = d; sen.at = Date.now();
    if (state.mode === "sentiment") { renderSent(); setStatus("", senStatus()); }
  } catch (e) {
    if (e.name === "AbortError") return;
    if (state.mode === "sentiment") {
      setStatus("err", sen.data ? "Could not refresh" : "No data");
      if (!sen.data) $("senBody").innerHTML = `<tr><td class="l" colspan="7"><div class="empty">${esc(e.message === "Failed to fetch" ? "The local server is not responding. Open GEX Lab again." : e.message)}</div></td></tr>`;
    }
  } finally { $("refreshBtn").classList.remove("spin"); }
}

// medidor 1-100 del agregado de las acciones
function senGauge(s) {
  const W = 220, H = 120, r = 90, cx = W / 2, cy = 105;
  const pt = (v, rr = r) => { const a = Math.PI * (1 - (v - 1) / 99); return [cx + rr * Math.cos(a), cy - rr * Math.sin(a)]; };
  const arc = (a, b, col) => { const [x1, y1] = pt(a), [x2, y2] = pt(b); return `<path d="M${x1} ${y1} A${r} ${r} 0 0 1 ${x2} ${y2}" stroke="${col}" stroke-width="12" fill="none"/>`; };
  let g = arc(1, 20, C.neg) + arc(20, 80, C.axis) + arc(80, 100, C.pos);
  if (s != null) { const [x, y] = pt(s, r - 22); g += `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="${C.text}" stroke-width="2.5" stroke-linecap="round"/><circle cx="${cx}" cy="${cy}" r="4" fill="${C.text}"/>`; }
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">${g}</svg>
    <div class="sen-gval"><b>${senNum(s)}</b><span class="ssk-tilt ${senCls(s)}">${senLabel(s) || "Building history"}</span></div>`;
}

function senValidated(d) {
  const e = d.swing && d.swing.eval && d.swing.eval["40"];
  return !!(e && e.enough);
}

function renderSent() {
  const d = sen.data;
  if (!d) return;
  const m = d.market, stk = m.stocks || {};
  const falta = Math.max(0, d.min_sessions - d.sessions);
  $("senState").textContent = falta ? "Collecting data" : senValidated(d) ? "Tested" : "Not validated yet";
  $("senState").className = "mstate " + (falta || !senValidated(d) ? "mixed" : "contango");
  $("senSub").textContent = `${d.rows.length} tickers, close of ${longDate(d.date)}. ${d.sessions} session${d.sessions === 1 ? "" : "s"} since ${ddmm(d.first)}`;
  $("senGauge").innerHTML = senGauge(stk.score);
  $("senRead").textContent = falta
    ? `Each ticker needs ${d.min_sessions} sessions of its own history before it gets a score: ${falta} more to go. Until then the table shows the raw put/call ratios.`
    : `Stocks as a whole: ${senLabel(stk.score).toLowerCase()}. ${m.breadth.n ? `${fmtNum(m.breadth.fear_pct, 0)}% of the stocks in fear (under 20) and ${fmtNum(m.breadth.greed_pct, 0)}% in greed (over 80).` : ""}`;
  const fact = (l, v, s) => `<div class="fact"><span class="fl">${l}</span><strong>${v}</strong><span class="fs">${s}</span></div>`;
  const ix = Object.entries(m.indices).map(([s, x]) => fact(s, senNum(x.score), x.score == null ? `${x.n}/${d.min_sessions} sessions` : `${senLabel(x.score)}, 5d ${senSigned(x.chg5)}`)).join("");
  const dv = d.divergences, dl = (k, t) => { const x = dv[k]; return fact(t, String(x.n), x.n40 ? `after 40 sessions ${fmtNum(x.ret40 * 100, 1)}% on average, ${fmtNum(x.hit40 * 100, 0)}% right` : x.n10 ? `after 10 sessions ${fmtNum(x.ret10 * 100, 1)}% on average, ${fmtNum(x.hit10 * 100, 0)}% right` : "too recent to judge"); };
  $("senFacts").innerHTML = fact("Median stock", senNum(m.breadth.median), `${m.breadth.n} stocks with a score`) + ix +
    dl("bear", "Bearish divergences") + dl("bull", "Bullish divergences");
  renderSentTable(d);
  renderSentTicker(d);
}

function renderSentTable(d) {
  const k = sen.sort, dir = sen.dir;
  const val = (r) => (k === "sym" ? r.sym : k === "div" ? (r.div ? r.div.type : null) : k === "score" || k === "chg5" ? r[k] : r.tranches[k].score);
  const rows = [...d.rows].sort((a, b) => {
    const x = val(a), y = val(b);
    if (k === "sym" || k === "div") return dir * String(x ?? "~").localeCompare(String(y ?? "~"));
    if (x == null) return 1; if (y == null) return -1;
    return dir * (x - y);
  });
  const cell = (s, pc) => (s != null ? `<span class="ssk-bar"><i style="width:${s}%"></i></span>${senNum(s)}` : pc != null ? `<span class="ssk-tilt">P/C ${fmtNum(pc, 2)}</span>` : "—");
  $("senBody").innerHTML = rows.map((r) => `<tr data-s="${esc(r.sym)}" class="${r.sym === sen.sym ? "on" : ""}" title="${esc(r.name || r.sym)}">
    <td class="l"><b>${esc(r.sym)}</b></td>
    <td><span class="ssk-tilt ${senCls(r.score)}">${r.score == null ? `${r.n}/${d.min_sessions}` : senNum(r.score)}</span></td>
    ${["t0", "t1", "t2"].map((t) => `<td>${cell(r.tranches[t].score, r.tranches[t].pc)}</td>`).join("")}
    <td>${senSigned(r.chg5)}</td>
    <td class="l">${r.div ? `<span class="ssk-tilt ${r.div.type === "bear" ? "neg" : "pos"}">${r.div.type === "bear" ? "▼ Bearish" : "▲ Bullish"}, ${ddmm(r.div.date)}</span>` : ""}</td></tr>`).join("");
  document.querySelectorAll("#senTable th[data-k]").forEach((th) => {
    th.classList.toggle("sorted", th.dataset.k === k);
    th.dataset.dir = th.dataset.k === k ? (dir > 0 ? "▲" : "▼") : "";
  });
  $("senFoot").textContent = "Until a ticker has its own history the cells show its raw put/call ratio (delta-weighted, out of the money). The swing test of this signal is on the Skew signal page.";
}

// precio arriba, puntuacion abajo (bandas 20 y 80), con el mismo eje de fechas
function renderSentTicker(d) {
  const ser = d.series[sen.sym] || [];
  const row = d.rows.find((r) => r.sym === sen.sym);
  $("senChartTitle").textContent = row ? `${sen.sym}: price and sentiment` : "Click a ticker";
  const el = $("senChart");
  const W = Math.max(320, el.clientWidth || 640), H = 260, L = 44, R = 12, T = 10, mid = 150, B = 22;
  if (ser.length < 2) { el.innerHTML = `<div class="empty">Not enough history for ${esc(sen.sym)} yet.</div>`; $("senExp").innerHTML = ""; return; }
  const x = (i) => L + (i / (ser.length - 1)) * (W - L - R);
  const ps = ser.map((p) => p[1]).filter((v) => v != null), lo = Math.min(...ps), hi = Math.max(...ps), sp = hi - lo || 1;
  const yp = (v) => T + (1 - (v - lo) / sp) * (mid - T - 14);
  const ys = (v) => mid + 8 + (1 - (v - 1) / 99) * (H - B - mid - 8);
  const path = (k, y) => { let s = "", on = false; ser.forEach((p, i) => { if (p[k] == null) { on = false; return; } s += `${on ? "L" : "M"}${x(i).toFixed(1)} ${y(p[k]).toFixed(1)}`; on = true; }); return s; };
  let g = `<line x1="${L}" x2="${W - R}" y1="${ys(80)}" y2="${ys(80)}" stroke="${C.pos}" stroke-dasharray="3 3" opacity=".6"/>
    <line x1="${L}" x2="${W - R}" y1="${ys(20)}" y2="${ys(20)}" stroke="${C.neg}" stroke-dasharray="3 3" opacity=".6"/>
    <text x="${L - 6}" y="${ys(80) + 4}" text-anchor="end" fill="${C.faint}" font-size="10">80</text>
    <text x="${L - 6}" y="${ys(20) + 4}" text-anchor="end" fill="${C.faint}" font-size="10">20</text>
    <text x="${L - 6}" y="${yp(hi) + 4}" text-anchor="end" fill="${C.faint}" font-size="10">${fmtNum(hi, hi < 100 ? 2 : 0)}</text>
    <text x="${L - 6}" y="${yp(lo) + 4}" text-anchor="end" fill="${C.faint}" font-size="10">${fmtNum(lo, lo < 100 ? 2 : 0)}</text>
    <path d="${path(1, yp)}" stroke="${C.text}" stroke-width="1.6" fill="none"/>
    <path d="${path(2, ys)}" stroke="${C.accent}" stroke-width="1.8" fill="none"/>
    <text x="${L}" y="${H - 6}" fill="${C.faint}" font-size="10">${ddmm(ser[0][0])}</text>
    <text x="${W - R}" y="${H - 6}" text-anchor="end" fill="${C.faint}" font-size="10">${ddmm(ser[ser.length - 1][0])}</text>`;
  if (row && row.div) {
    const i = ser.findIndex((p) => p[0] === row.div.date);
    if (i >= 0 && ser[i][1] != null) g += `<circle cx="${x(i)}" cy="${yp(ser[i][1])}" r="5" fill="none" stroke="${row.div.type === "bear" ? C.neg : C.pos}" stroke-width="2"/>`;
  }
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${g}</svg>`;
  const ex = (d.expiries[sen.sym] || []).slice(0, 12);
  $("senExp").innerHTML = ex.length ? `<table class="scan sen-exp-t"><thead><tr><th class="l">Expiration</th><th>Days</th><th>P/C volume</th><th>P/C open interest</th></tr></thead><tbody>${ex.map((e) =>
    `<tr><td class="l">${ddmm(e.exp)}</td><td>${e.dte}</td><td>${e.pc_vol == null ? "—" : fmtNum(e.pc_vol, 2)}</td><td>${e.pc_oi == null ? "—" : fmtNum(e.pc_oi, 2)}</td></tr>`).join("")}</tbody></table>` : "";
  $("senCap").textContent = row ? `Price (top) and combined score (bottom, 1 to 100). Put/call by expiration on ${ddmm(d.date)}, out-of-the-money options weighted by delta.` : "";
}

$("senTable").querySelector("thead").addEventListener("click", (e) => {
  const th = e.target.closest("th[data-k]"); if (!th) return;
  if (sen.sort === th.dataset.k) sen.dir = -sen.dir; else { sen.sort = th.dataset.k; sen.dir = 1; }
  renderSent();
});
$("senBody").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-s]"); if (!tr) return;
  sen.sym = tr.dataset.s; store.set("senSym", sen.sym);
  renderSent();
});
```

Nota: orden por defecto ascendente de la puntuación (`dir: 1`): arriba lo más miedoso, que es lo que más se mira.

- [ ] **Paso 4: `web/sentiment.css`**

```css
/* Sentiment (sentiment.js): medidor, tabla por vencimiento y fila elegida. Colores de tema.css */
.sen-gauge { display: flex; flex-direction: column; align-items: center; margin: 8px 0 4px; }
.sen-gval { display: flex; flex-direction: column; align-items: center; margin-top: -34px; }
.sen-gval b { font-size: 30px; font-weight: 800; color: var(--text); }
.sen-exp { margin: 6px 0 2px; }
.sen-exp-t td, .sen-exp-t th { font-size: 12.5px; }
.sen-table tr.on td { background: var(--accent-soft); }
.sen-table tbody tr { cursor: pointer; }
```

- [ ] **Paso 5: comprobar sintaxis**

```powershell
node --check web\sentiment.js; node --check web\app.js
```

- [ ] **Paso 6: comprobar en el navegador con datos locales**

Generar un `pub/pcr.json` local con el índice que haya en `data/x` (o, si no hay suficiente, con
`_idx_sintetico` de la prueba escrito a `data/x/pub/pcr.json` mediante `pcr.calcular`). Arrancar la vista previa
(`preview_start`, configuración del servidor local de `.claude/launch.json`, o crearla con
`.venv\Scripts\python.exe server.py`, puerto 8765) con `GEX_ALMACEN=local:./data/x`, abrir Sentiment y comprobar:
sin errores en consola, medidor, tabla ordenable, gráfico al pulsar un ticker, temas claro y oscuro
(`resize_window` con `colorScheme`), y ancho de móvil sin desbordar.

- [ ] **Paso 7: commit**

```powershell
git add web/sentiment.js web/sentiment.css web/index.html web/app.js
git commit -m "web: pagina Sentiment"
```

---

### Tarea 9: señal `pcr` en la página Skew signal

**Archivos:** `web/skewsig.js`, `web/index.html`.

- [ ] **Paso 1: `SSK_SIG`** (tras `os`):

```js
  // z de log(P/C) frente a la historia del ticker (pcr.py): positiva, mas puts que lo normal
  pcr: { name: "Put/call", level: "P/C z", levelTip: "Robust z-score of the delta-weighted out-of-the-money put/call volume ratio (expirations up to 45 days) against the stock's own last 60 sessions",
    caption: "P/C z: how unusual today's put/call ratio is for the stock (positive, more puts than usual).",
    fmt: (v) => (v == null ? "—" : sskSigned(v, 2)), fmtChg: (v) => (v == null ? "—" : sskSigned(v, 2)),
    works: "Stocks with more puts than usual have been lagging the rest, as the research says. The ranking can tilt a swing book: avoid longs at the top, favour them at the bottom.",
    tilt: SSK_BEAR },
```

`sskSigned` se declara más abajo con `const`: se usa dentro de funciones flecha que se llaman después de cargar el
script, así que no hay problema de zona muerta.

- [ ] **Paso 2: botón en `index.html`** dentro de `#sskSeg`, tras el de `os`:
`<button role="radio" data-v="pcr" aria-checked="false">Put/call</button>`

- [ ] **Paso 3: consenso** en `renderSskConsensus`: añadir a la cabecera, tras `os`,
`["pcr", "Put/call", "", "Vote of the put/call signal"],`; en la fila, tras `${vote(r, "os")}`, `<td>${vote(r, "pcr")}</td>`;
en `group`, `colspan="6"` pasa a `colspan="7"` (dos sitios); en el texto de `sskFoot`: "Put skew, options volume and
put/call vote bearish when high; call−put votes bullish when high."

- [ ] **Paso 4: comprobar**

`node --check web\skewsig.js`. En la vista previa, Skew signal > Put/call muestra "Collecting data" mientras no haya
20 sesiones, sin errores en consola.

- [ ] **Paso 5: commit**

```powershell
git add web/skewsig.js web/index.html
git commit -m "web: senal de put/call en Skew signal"
```

---

### Tarea 10: tarjeta en Summary

**Archivos:** `web/resumen.js`.

- [ ] **Paso 1:** en `su` añadir `pcr: null`; en `suLoad`, a `jobs`:
`get("/api/pcr").then((d) => { su.pcr = d || su.pcr; }),`

- [ ] **Paso 2:** función nueva (junto a `suCot`):

```js
function suSent() {
  const P = su.pcr, m = P && P.market, s = m && m.stocks;
  const head = `<header><h3>Put/call sentiment</h3><span class="sub">${P ? `close of ${ddmm(P.date)}, 100 = greed` : "stocks against their own history"}</span></header>`;
  if (!s || s.score == null) return `<section class="su-card su-sent" data-go="sentiment" title="Open Sentiment">${head}${suWait(P ? `Building history: ${P.sessions} of ${P.min_sessions} sessions.` : "Loading…")}</section>`;
  const b = m.breadth, cls = s.score < 40 ? "dn" : s.score > 60 ? "up" : "";
  return `<section class="su-card su-sent" data-go="sentiment" title="Open Sentiment">${head}
    <div class="su-nd"><span>Stocks combined</span><b class="${cls}">${fmtNum(s.score, 0)}</b></div>
    <div class="su-nd"><span>In fear (under 20) / in greed (over 80)</span><b>${fmtNum(b.fear_pct, 0)}% / ${fmtNum(b.greed_pct, 0)}%</b></div></section>`;
}
```

- [ ] **Paso 3:** en `renderSummary`, tras `${suVolReg()}`, añadir `${suSent()}`.

- [ ] **Paso 4: comprobar** `node --check web\resumen.js`; en la vista previa, Summary enseña la tarjeta y al pulsarla
abre Sentiment; claro y oscuro.

- [ ] **Paso 5: commit**

```powershell
git add web/resumen.js
git commit -m "web: sentimiento de put/call en Summary"
```

---

### Tarea 11: documentación, push y prueba real

- [ ] **Paso 1: docs**
  - `docs/ARQUITECTURA.md`: claves de R2 `hist500/_pcr.json.gz`, `hist500/_pcr_exp.json.gz`, `pub/pcr.json`;
    ruta `/api/pcr`; orden en `historial500.py` (pcr.actualizar → skew → publicar_skew → publicar_pcr).
  - `CLAUDE.md`, sección Mapa: `pcr.py` — sentimiento por put/call (z por ticker, divergencias, mercado; señal `pcr`
    de skew), `web/sentiment.js|css` (página Sentiment); prueba `python pruebas/test_pcr.py` en Comandos.
  - `docs/ESTADO.md`: pendiente "Sentimiento put/call: revisar hacia el 2026-12-15 (20 sesiones) y el veredicto
    del swing hacia febrero de 2027".
  - `CHANGELOG.md`: entrada del día (ampliar si ya existe), Añadido.

- [ ] **Paso 2: pruebas completas**

```powershell
.venv\Scripts\python.exe pruebas/test_pcr.py; node --check web\app.js; node --check web\sentiment.js; node --check web\skewsig.js; node --check web\resumen.js; node --check web\nube.js
```

- [ ] **Paso 3: commit de docs y push** (con permiso del usuario)

```powershell
git add docs/ARQUITECTURA.md docs/ESTADO.md CLAUDE.md CHANGELOG.md
git commit -m "Sentimiento por put/call: documentacion y CHANGELOG"
git push origin main
```

- [ ] **Paso 4: reconstrucción real en Actions**

```powershell
gh api -X POST repos/LoppVicious/gexlab/actions/workflows/historial500.yml/dispatches -f ref=main -f 'inputs[indice]=true'
```

Leer el registro: `pcr: indice con N sesiones` (N ≈ días desde el 2026-11-04) y `pcr: ... tickers ...` sin
`ERROR pcr`. Si algún día falla por cadenas antiguas sin `delta`, verlo en el número de sesiones por ticker.

- [ ] **Paso 5: comprobar en producción**

En el navegador integrado (sesión del usuario), https://dashboard.gexlab.workers.dev tras Ctrl+F5: Sentiment carga
con "Collecting data" y P/C brutos en la tabla; un ticker muestra su gráfico y su P/C por vencimiento; Skew signal >
Put/call sin errores; Summary con la tarjeta. Revisar a mano dos tickers conocidos (p. ej. SPY con P/C alto y una
tecnológica con P/C bajo) y que sus P/C por vencimiento tengan sentido.
