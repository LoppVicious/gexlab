# Distribución implícita y probabilidades de los niveles: plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Calcular en el motor la distribución de precios que descuentan las opciones para cada vencimiento y la probabilidad de cerrar más allá (y tocar) de Call Wall, Put Wall y flip; mostrarla en el ticker y en una vista Distribution del Volatility dashboard, y guardarla cada día en el índice de niveles.

**Architecture:** Funciones numpy puras en `gex_engine.py` (válidas en Pyodide): `implied_distribution` (Breeden-Litzenberger sobre el smile), `level_dists` (próximo vencimiento y viernes), `level_probs` y `probs_snap`. `compute` añade `level_probs` al resultado; `_snap` y `historial500.CAMPOS_INDICE` guardan las probabilidades; `volatilidad.vol_data` añade `dists`. La web solo pinta.

**Tech Stack:** Python 3 + numpy, JS sin framework (SVG a mano), pruebas con scripts `python pruebas/test_*.py` (funciones `test_*` sin pytest, como `pruebas/test_cripto.py`).

**Spec:** `docs/superpowers/specs/2026-11-21-distribucion-implicita-design.md`.

**Reglas del repo que aplican a todo el plan:**
- Otras sesiones editan `gexlab/` a la vez: nunca `git add -A` ni `git stash` ni cambiar de rama; `git add` con rutas explícitas y `git commit -- <rutas>`.
- Python en Windows: escribir archivos con Edit/Write (LF), no con scripts que pasen a CRLF.
- Web en inglés, cifras en-US, sin «·» como separador, colores de `C`.
- `node --check` de cada JS tocado. Push a `main` solo en la tarea final, con `CHANGELOG.md` en el mismo commit.

---

## Mapa de archivos

| Archivo | Cambio |
|---|---|
| `gex_engine.py` | Nuevo bloque "Distribución implícita" tras `implied_moves`/`resolve_window` (antes de `INDEX_LIKE`, ~línea 1336): constantes, `_ncdf_exact`, `_trap`, `implied_distribution`, `prob_beyond`, `prob_touch`, `level_dists`, `level_probs`, `probs_snap`, `dist_json`, `dist_for_day`, `completar_probs`. `compute` (~línea 2190) añade `res["level_probs"]`. `_snap` (~línea 1501) añade `pc_*`. |
| `historial500.py` | `CAMPOS_INDICE` (línea 68) con `flip` y `pc_*`; `reconstruir_indice` (línea 228) rellena días antiguos con `g.completar_probs`. |
| `volatilidad.py` | `vol_data` (línea 426) añade `"dists"`. |
| `web/index.html` | `#emProbs` en la tarjeta del rango de 1σ (línea ~301); pestaña `Distribution` en `#volTabs` (línea ~495). |
| `web/app.js` | `paintLevelProbs(d)` junto a `paintEmRegime` (línea ~1241). |
| `web/vol.js` | `renderDist`, controles, nota, tooltip, celda en Overview. |
| `web/sg.css` | `.vg-wide` (celda a lo ancho en Overview). |
| `pruebas/test_dist.py` | Nuevo: pruebas sin red. |
| `pruebas/dist_real.py` | Nuevo: comprobación con datos reales en `comparar.yml`. |
| `CHANGELOG.md`, `docs/ARQUITECTURA.md`, `docs/ESTADO.md` | Documentación en la tarea final. |

---

### Task 1: `implied_distribution`, `prob_beyond`, `prob_touch`

**Files:**
- Create: `pruebas/test_dist.py`
- Modify: `gex_engine.py` (bloque nuevo antes de `INDEX_LIKE = ...`, ~línea 1336)

- [ ] **Step 1: Escribir las pruebas que fallan**

`pruebas/test_dist.py`:

```python
"""Pruebas sin red de la distribucion implicita (gex_engine). Uso: python pruebas/test_dist.py"""
import math
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import numpy as np  # noqa: E402

import gex_engine as g  # noqa: E402

AHORA = datetime(2026, 12, 1, 10, 0)          # martes, mercado abierto (hora de Nueva York, sin zona)
VTO = np.datetime64("2026-12-11T16:00")       # viernes, ~10 dias naturales


def cadena(exps, iv_fn, F=100.0, ks=None):
    """Cadena sintetica: call y put en cada strike de cada vencimiento, IV = iv_fn(K), forward F."""
    ks = np.arange(60.0, 140.5, 1.0) if ks is None else np.asarray(ks, float)
    K, C, E = [], [], []
    for e in exps:
        for k in ks:
            for c in (True, False):
                K.append(k); C.append(c); E.append(np.datetime64(e, "m"))
    K = np.array(K); C = np.array(C); E = np.array(E, dtype="datetime64[m]")
    return {"K": K, "call": C, "exp": E, "iv": np.array([iv_fn(k) for k in K]), "fwd": np.full(K.shape, F)}


def _ncdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def test_lognormal_con_iv_plana():
    ch = cadena([VTO], lambda k: 0.20)
    d = g.implied_distribution(ch, 100.0, AHORA, VTO)
    assert d is not None
    x, pdf, s = np.array(d["x"]), np.array(d["pdf"]), 0.20 * math.sqrt(d["T"])
    z = (np.log(x / 100.0) + 0.5 * s * s) / s
    exacta = np.exp(-0.5 * z * z) / (x * s * math.sqrt(2 * math.pi))
    assert np.max(np.abs(pdf - exacta)) < 0.01 * exacta.max(), np.max(np.abs(pdf - exacta)) / exacta.max()
    assert np.max(np.abs(np.array(d["logn"]) - exacta)) < 1e-6 * exacta.max() + 1e-12


def test_masa_media_y_percentiles():
    ch = cadena([VTO], lambda k: 0.20)
    d = g.implied_distribution(ch, 100.0, AHORA, VTO)
    x, pdf = np.array(d["x"]), np.array(d["pdf"])
    assert abs(g._trap(pdf, x) - 1) < 1e-9
    assert abs(g._trap(pdf * x, x) / 100.0 - 1) < 0.002
    q = d["q"]
    assert q["5"] < q["25"] < q["50"] < q["75"] < q["95"]
    assert d["clip"] < 0.01 and d["noisy"] is False


def test_prob_beyond_iv_plana():
    ch = cadena([VTO], lambda k: 0.20)
    d = g.implied_distribution(ch, 100.0, AHORA, VTO)
    s = 0.20 * math.sqrt(d["T"])
    for K in (95.0, 100.0, 105.0):
        d2 = (math.log(100.0 / K) - 0.5 * s * s) / s
        assert abs(g.prob_beyond(d, K, "up") - _ncdf(d2)) < 0.005, K
        assert abs(g.prob_beyond(d, K, "down") - (1 - _ncdf(d2))) < 0.005, K
    assert g.prob_beyond(d, 1e6, "up") == 0.0 and g.prob_beyond(d, 1e6, "down") == 1.0


def test_sesgo_de_puts_engorda_la_cola_izquierda():
    plana = g.implied_distribution(cadena([VTO], lambda k: 0.20), 100.0, AHORA, VTO)
    sesgo = g.implied_distribution(cadena([VTO], lambda k: 0.20 + 0.8 * max(0.0, math.log(100.0 / k))), 100.0, AHORA, VTO)
    assert sesgo["q"]["5"] < plana["q"]["5"]


def test_prob_touch_acotada():
    assert g.prob_touch(0.1) == 0.2
    assert g.prob_touch(0.7) == 1.0


def test_sin_dato():
    pocos = cadena([VTO], lambda k: 0.20, ks=[99.0, 100.0, 101.0])
    assert g.implied_distribution(pocos, 100.0, AHORA, VTO) is None
    casi = np.datetime64("2026-12-01T16:00")
    ch = cadena([casi], lambda k: 0.20)
    assert g.implied_distribution(ch, 100.0, datetime(2026, 12, 1, 15, 45), casi) is None


if __name__ == "__main__":
    fallos = 0
    for nombre, f in sorted(globals().items()):
        if nombre.startswith("test_") and callable(f):
            try:
                f()
                print("ok  ", nombre)
            except AssertionError as e:
                fallos += 1
                print("FALLO", nombre, e)
    sys.exit(1 if fallos else 0)
```

- [ ] **Step 2: Comprobar que fallan**

Run: `.venv\Scripts\python.exe pruebas/test_dist.py`
Expected: falla con `AttributeError: module 'gex_engine' has no attribute 'implied_distribution'` (el bucle solo atrapa AssertionError; el error para el script, lo que basta para ver el fallo).

- [ ] **Step 3: Implementar**

En `gex_engine.py`, justo antes de la línea `INDEX_LIKE = INDEX_SYMBOLS | ...`:

```python
# ---------------------------------------------------------------- Distribucion implicita (Breeden-Litzenberger)
# Densidad neutral al riesgo del precio al vencimiento = segunda derivada del precio de la call respecto al strike.
# Las calls se valoran con Black sobre el forward y la IV fuera de dinero de cada strike (la misma regla que el
# smile de volatilidad.py), interpolada en log-strike y plana fuera de los strikes cotizados.
DIST_N = 400            # puntos de la rejilla de precios
DIST_SIGMAS = 5.0       # la rejilla cubre +-5 desviaciones (IV ATM) alrededor del forward
DIST_NOISY = 0.05       # masa negativa recortada por encima de la cual la forma es aproximada
DIST_MIN_MIN = 30.0     # minutos de mercado minimos hasta el vencimiento
VIX_LIKE = {"VIX", "VIXW"}


def _ncdf_exact(x: np.ndarray) -> np.ndarray:
    # erf exacta: la segunda derivada numerica amplifica el error de _ncdf (1,5e-7) hasta el 10 % en el 0DTE
    return 0.5 * (1.0 + np.vectorize(math.erf)(np.asarray(x, float) / math.sqrt(2.0)))


def _trap(y: np.ndarray, x: np.ndarray) -> float:
    return float(((y[1:] + y[:-1]) * np.diff(x)).sum() / 2.0)


def implied_distribution(ch: dict, spot: float, now: datetime, exp, n: int = DIST_N) -> dict | None:
    """Distribucion del precio al vencimiento `exp` (datetime64 de ch["exp"]). None sin datos suficientes."""
    exp = np.datetime64(exp, "m")
    q = quote_time(now)
    if trading_minutes(q, exp.astype(datetime)) < DIST_MIN_MIN:
        return None
    sel = (ch["exp"] == exp) & (ch["iv"] > 0.01) & (ch["iv"] < 5)
    if not sel.any():
        return None
    Fc = ch.get("fwd")
    f0 = float(Fc[sel][0]) if Fc is not None else float("nan")
    F = f0 if math.isfinite(f0) and f0 > 0 else float(spot)
    now64 = np.datetime64(now.replace(second=0, microsecond=0))
    T = max(float((exp - now64).astype("timedelta64[m]").astype(float)), 1.0) / YEAR_MIN
    K, C, IV = ch["K"][sel], ch["call"][sel], ch["iv"][sel]
    otm = np.where(C, K >= F, K < F)
    K, C, IV = K[otm], C[otm], IV[otm]
    sg = IV * math.sqrt(T)
    d1 = (np.log(F / K) + 0.5 * sg * sg) / sg
    dl = np.where(C, _ncdf_exact(d1), _ncdf_exact(d1) - 1)
    keep = np.abs(dl) >= 0.02                      # sin alas de |delta| < 0,02: ruido de horquilla
    K, IV = K[keep], IV[keep]
    if K.size:
        K, inv = np.unique(K, return_inverse=True)
        IV = np.bincount(inv, weights=IV) / np.bincount(inv)
    if K.size < 5:
        return None
    lk = np.log(K)
    atm = float(np.interp(math.log(F), lk, IV))
    s = atm * math.sqrt(T)
    x = F * np.exp(np.linspace(-DIST_SIGMAS * s, DIST_SIGMAS * s, n))
    sx = np.interp(np.log(x), lk, IV) * math.sqrt(T)     # np.interp deja la IV plana fuera de los extremos
    d1 = (np.log(F / x) + 0.5 * sx * sx) / sx
    call = F * _ncdf_exact(d1) - x * _ncdf_exact(d1 - sx)
    pdf = np.gradient(np.gradient(call, x), x)
    clip = -_trap(np.minimum(pdf, 0.0), x)
    pdf = np.maximum(pdf, 0.0)
    mass = _trap(pdf, x)
    if mass <= 0:
        return None
    pdf = pdf / mass
    cdf = np.concatenate([[0.0], np.cumsum((pdf[1:] + pdf[:-1]) * np.diff(x) / 2.0)])
    cdf = np.minimum(np.maximum.accumulate(cdf / cdf[-1]), 1.0)
    z = (np.log(x / F) + 0.5 * s * s) / s
    logn = np.exp(-0.5 * z * z) / (x * s * math.sqrt(2 * math.pi))
    days = int((exp.astype("datetime64[D]") - now64.astype("datetime64[D]")).astype(int))
    return {"exp": str(exp.astype("datetime64[D]")), "days": max(days, 0), "T": T, "fwd": F, "atm_iv": atm,
            "x": x, "pdf": pdf, "logn": logn, "cdf": cdf,
            "q": {str(p): float(np.interp(p / 100.0, cdf, x)) for p in (5, 25, 50, 75, 95)},
            "clip": float(clip), "noisy": bool(clip > DIST_NOISY)}


def prob_beyond(dist: dict, level: float, side: str) -> float:
    """Probabilidad de cerrar por encima ("up") o por debajo ("down") de `level` al vencimiento."""
    c = float(np.interp(level, dist["x"], dist["cdf"], left=0.0, right=1.0))
    return 1.0 - c if side == "up" else c


def prob_touch(p_close: float) -> float:
    """Probabilidad de tocar el nivel antes del vencimiento: regla de reflexion (sin deriva), tope 1. Estimada."""
    return min(1.0, 2.0 * p_close)
```

Nota: `x`, `pdf`, `logn` y `cdf` quedan como arrays numpy dentro del motor; `dist_json` (Task 4) los convierte para la web. Las pruebas usan `np.array(d["x"])`, válido con arrays.

- [ ] **Step 4: Comprobar que pasan**

Run: `.venv\Scripts\python.exe pruebas/test_dist.py`
Expected: seis líneas `ok`, salida 0. Si `test_lognormal_con_iv_plana` falla por poco en los extremos, no ampliar la tolerancia sin mirar dónde está el error (`np.argmax(np.abs(pdf - exacta))`): en el centro indicaría un fallo de T o del forward.

- [ ] **Step 5: Commit**

```powershell
git add gex_engine.py pruebas/test_dist.py
git commit -m "Motor: distribución implícita por vencimiento (Breeden-Litzenberger)" -- gex_engine.py pruebas/test_dist.py
```

---

### Task 2: `level_dists`, `level_probs`, `probs_snap` y resultado de `compute`

**Files:**
- Modify: `gex_engine.py` (mismo bloque; `compute` ~línea 2190; `_snap` ~línea 1501)
- Modify: `pruebas/test_dist.py`

- [ ] **Step 1: Pruebas que fallan**

Añadir a `pruebas/test_dist.py` (antes del `if __name__`):

```python
def test_level_dists_proximo_y_viernes():
    exps = ["2026-12-02T16:00", "2026-12-04T16:00", "2026-12-11T16:00"]
    ds = g.level_dists(cadena(exps, lambda k: 0.20), 100.0, AHORA, "SPX")
    assert [d["exp"] for d in ds] == ["2026-12-02", "2026-12-04"]
    # el proximo ya es viernes: solo uno
    ds = g.level_dists(cadena(["2026-12-04T16:00", "2026-12-11T16:00"], lambda k: 0.20), 100.0, AHORA, "SPY")
    assert [d["exp"] for d in ds] == ["2026-12-04"]
    # VIX: miercoles
    ds = g.level_dists(cadena(["2026-12-01T16:00", "2026-12-02T16:00", "2026-12-04T16:00"], lambda k: 0.8, F=18.0,
                              ks=np.arange(10.0, 40.5, 0.5)), 18.0, AHORA, "VIX")
    assert [d["exp"] for d in ds] == ["2026-12-01", "2026-12-02"]


def test_level_probs():
    ds = g.level_dists(cadena([VTO], lambda k: 0.20), 100.0, AHORA, "SPY")
    lp = g.level_probs(ds, 100.0, {"call_wall": 105.0, "put_wall": 95.0, "flip": 98.0})
    r = lp[0]
    assert r["exp"] == "2026-12-11"
    assert 0 < r["call_wall"]["close"] < 0.5 and abs(r["call_wall"]["touch"] - 2 * r["call_wall"]["close"]) < 2e-4
    assert 0 < r["put_wall"]["close"] < 0.5
    assert r["flip"]["side"] == "down" and r["flip"]["close"] > r["put_wall"]["close"]
    # spot ya por encima del Call Wall: sin toque; nivel ausente: fuera
    lp = g.level_probs(ds, 100.0, {"call_wall": 99.0, "put_wall": None, "flip": None})
    assert "touch" not in lp[0]["call_wall"] and "put_wall" not in lp[0] and "flip" not in lp[0]


def test_probs_snap():
    lp = [{"exp": "2026-12-11", "days": 10, "call_wall": {"close": 0.12, "touch": 0.24},
           "put_wall": {"close": 0.18, "touch": 0.36}, "flip": {"side": "down", "close": 0.41, "touch": 0.82}}]
    assert g.probs_snap(lp) == {"pc_exp": "2026-12-11", "pc_cw": 0.12, "pc_pw": 0.18, "pc_flip": 0.41}
    assert g.probs_snap([]) == {"pc_exp": None, "pc_cw": None, "pc_pw": None, "pc_flip": None}
```

- [ ] **Step 2: Comprobar que fallan**

Run: `.venv\Scripts\python.exe pruebas/test_dist.py`
Expected: `AttributeError: ... 'level_dists'`.

- [ ] **Step 3: Implementar**

En el bloque de la Task 1, tras `prob_touch`:

```python
def level_dists(ch: dict, spot: float, now: datetime, symbol: str) -> list[dict]:
    """Distribucion del proximo vencimiento (0DTE en los indices) y, si es otro, del semanal de esa misma semana
    (viernes o jueves por festivo; en el VIX, miercoles o martes)."""
    now64 = np.datetime64(now.replace(second=0, microsecond=0))
    exps = np.unique(ch["exp"][ch["exp"] > now64])[:12]
    first = None
    for e in exps:
        first = implied_distribution(ch, spot, now, e)
        if first:
            break
    if not first:
        return []
    out = [first]
    wd = 2 if normalize(symbol) in VIX_LIKE else 4
    d0 = date.fromisoformat(first["exp"])
    for e in exps:
        de = date.fromisoformat(str(e.astype("datetime64[D]")))
        if de <= d0 or de.isocalendar()[:2] != d0.isocalendar()[:2] or de.weekday() not in (wd, wd - 1):
            continue
        # el jueves solo si el viernes no tiene vencimiento (festivo)
        if de.weekday() == wd - 1 and any(str(x.astype("datetime64[D]")) == str(de + timedelta(days=1)) for x in exps):
            continue
        dist = implied_distribution(ch, spot, now, e)
        if dist:
            out.append(dist)
            break
    return out


def level_probs(dists: list[dict], spot: float, levels: dict) -> list[dict]:
    """Probabilidad de cerrar mas alla de Call Wall (por encima), Put Wall (por debajo) y flip (hacia su lado) y,
    si el spot aun no lo ha cruzado, de tocarlo antes (estimada)."""
    out = []
    for dist in dists:
        row = {"exp": dist["exp"], "days": dist["days"]}
        for key, side in (("call_wall", "up"), ("put_wall", "down"), ("flip", None)):
            lv = levels.get(key)
            if lv is None or (side is None and lv == spot):
                continue
            sd = side or ("down" if lv < spot else "up")
            p = prob_beyond(dist, float(lv), sd)
            item = {"close": round(p, 4)}
            if not (spot >= lv if sd == "up" else spot <= lv):
                item["touch"] = round(prob_touch(p), 4)
            if side is None:
                item["side"] = sd
            row[key] = item
        out.append(row)
    return out


def probs_snap(lp: list[dict] | None) -> dict:
    """Probabilidades de cierre del primer vencimiento, para la foto diaria y el indice de niveles."""
    r = (lp or [{}])[0]
    return {"pc_exp": r.get("exp"), "pc_cw": (r.get("call_wall") or {}).get("close"),
            "pc_pw": (r.get("put_wall") or {}).get("close"), "pc_flip": (r.get("flip") or {}).get("close")}
```

`gex_engine.py:25` importa `datetime, timedelta, timezone` pero no `date`: cambiar esa línea a
`from datetime import date, datetime, timedelta, timezone` (comprobar antes con `grep -n "\bdate\b *=" gex_engine.py`
que ninguna variable local se llama `date` en funciones que lo necesiten; si alguna lo hace, usar `import datetime as _dt`
y `_dt.date` dentro de `level_dists`).

En `compute`, justo después de `res["session"] = session_date(ch["timestamp"])`:

```python
    try:   # auxiliar: si falla, el resto del resultado sigue
        res["level_probs"] = level_probs(level_dists(ch, spot, now_dt, normalize(symbol)), spot, res["levels"])
    except Exception:  # noqa: BLE001
        res["level_probs"] = []
```

En `_snap`, añadir al final del dict devuelto (antes de `"saved"`): `**probs_snap(res.get("level_probs")),` y `"flip"` ya está. Queda:

```python
            "m1_session": ((res.get("moves") or {}).get("d1") or {}).get("session"),
            **probs_snap(res.get("level_probs")),
            "saved": now_ny().strftime("%Y-%m-%d %H:%M")}
```

Importante: `history_update(res, ...)` (que llama a `_snap`) va después de la línea de `res["session"]`; el `try` de `level_probs` debe quedar antes de `res["prev"] = history_update(...)`.

- [ ] **Step 4: Comprobar**

Run: `.venv\Scripts\python.exe pruebas/test_dist.py` → todas `ok`.
Run: `.venv\Scripts\python.exe -c "import gex_engine"` → sin salida.
Run (con red, opcional en local): `.venv\Scripts\python.exe -c "import gex_engine as g; r=g.compute('SPY', max_dte=0, window_pct='auto'); print(r['level_probs'])"` → lista con uno o dos vencimientos y cifras entre 0 y 1.

- [ ] **Step 5: Commit**

```powershell
git add gex_engine.py pruebas/test_dist.py
git commit -m "Motor: probabilidades implícitas de Call Wall, Put Wall y flip" -- gex_engine.py pruebas/test_dist.py
```

---

### Task 3: índice de niveles con las probabilidades (y relleno de días pasados)

**Files:**
- Modify: `gex_engine.py` (bloque de la distribución)
- Modify: `historial500.py:68` y `historial500.py:228-238`
- Modify: `pruebas/test_dist.py`

- [ ] **Step 1: Prueba que falla**

```python
def test_completar_probs_rellena_dias_antiguos():
    ch = cadena(["2026-12-02T16:00", "2026-12-04T16:00"], lambda k: 0.20)
    viejo = {"spot": 100.0, "call_wall": 105.0, "put_wall": 95.0, "flip": 98.0}
    nuevo = {"spot": 100.0, "call_wall": 105.0, "put_wall": 95.0, "flip": 98.0, "pc_cw": 0.5}
    doc = {"symbol": "SPY", "session": "2026-12-01", "chain": {"falso": True},
           "levels": {"standard": {"spotgamma": {"0": viejo, "45": nuevo}}}}
    orig = g.chain_from_min
    g.chain_from_min = lambda d: ch
    try:
        g.completar_probs(doc)
    finally:
        g.chain_from_min = orig
    assert viejo["pc_exp"] == "2026-12-02" and 0 < viejo["pc_cw"] < 0.5 and viejo["pc_flip"] > 0
    assert nuevo["pc_cw"] == 0.5          # los que ya lo tienen no se tocan
```

- [ ] **Step 2: Comprobar que falla**

Run: `.venv\Scripts\python.exe pruebas/test_dist.py` → `AttributeError: ... 'completar_probs'`.

- [ ] **Step 3: Implementar**

En `gex_engine.py`, tras `probs_snap`:

```python
def completar_probs(doc: dict) -> None:
    """Dia de hist500 guardado antes de level_probs: anade pc_* a cada foto de niveles con la cadena del cierre
    (como si se calculara a las 16:15 ET de esa sesion). Una distribucion por spot distinto."""
    fotos = [sn for ms in (doc.get("levels") or {}).values() for fs in ms.values() for sn in fs.values()
             if "pc_cw" not in sn and sn.get("spot")]
    if not fotos or not doc.get("chain"):
        return
    ch = chain_from_min(doc["chain"])
    ahora = datetime.strptime(doc["session"] + " 16:15", "%Y-%m-%d %H:%M")
    cache: dict = {}
    for sn in fotos:
        s = float(sn["spot"])
        if s not in cache:
            cache[s] = level_dists(ch, s, ahora, doc.get("symbol") or "")
        sn.update(probs_snap(level_probs(cache[s], s, sn)))
```

En `historial500.py`:

```python
CAMPOS_INDICE = ("spot", "call_wall", "put_wall", "flip", "net_per_pct", "m1_pct", "m1_session", "saved",
                 "pc_exp", "pc_cw", "pc_pw", "pc_flip")
```

Y en `reconstruir_indice`, sustituir el cuerpo del bucle:

```python
            d = almacen.get_json(st, k) or {}
            if d.get("levels"):
                try:   # dias anteriores a las probabilidades implicitas: se calculan con la cadena guardada
                    g.completar_probs(d)
                except Exception as e:  # noqa: BLE001
                    log(f"ERROR probabilidades {sym} {m.group(1)}: {type(e).__name__}: {str(e)[:120]}")
                idx[m.group(1)] = _niveles_indice(d["levels"])
```

Comprobar que `log` existe en `historial500.py` (`grep -n "^def log" historial500.py`); se usa ya en `guardar_ticker`.

Nota: la foto diaria de `guardar_ticker` ya trae `pc_*` por `g._snap` (Task 2); solo los días anteriores necesitan el relleno. Los documentos de día en R2 no se reescriben.

- [ ] **Step 4: Comprobar**

Run: `.venv\Scripts\python.exe pruebas/test_dist.py` → todas `ok`.
Run: `.venv\Scripts\python.exe -c "import historial500"` → sin error (si importar el script tuviera efectos, usar `python -m py_compile historial500.py`).
Si hay días locales (`data/x/hist500/`): `$env:GEX_ALMACEN="local:./data/x"; .venv\Scripts\python.exe historial500.py --indice` y mirar que `data/x/hist500/_niveles/SPY.json.gz` lleva `pc_cw`. Si no hay copia local, se comprueba en la Task 7.

- [ ] **Step 5: Commit**

```powershell
git add gex_engine.py historial500.py pruebas/test_dist.py
git commit -m "Historial: probabilidades implícitas de los niveles en el índice diario" -- gex_engine.py historial500.py pruebas/test_dist.py
```

---

### Task 4: `dists` en `/api/vol`

**Files:**
- Modify: `gex_engine.py` (bloque de la distribución)
- Modify: `volatilidad.py:426-459`
- Modify: `pruebas/test_dist.py`

- [ ] **Step 1: Prueba que falla**

```python
def test_dist_json_y_dist_for_day():
    ch = cadena(["2026-12-02T16:00", "2026-12-11T16:00"], lambda k: 0.20)
    d = g.dist_for_day(ch, 100.0, AHORA, "2026-12-11", n=200)
    assert d and d["exp"] == "2026-12-11"
    j = g.dist_json(d)
    assert len(j["x"]) == 200 and max(j["pdf"]) == 1.0 and j["cdf"][-1] == 1.0
    assert set(j) == {"exp", "days", "T", "fwd", "atm_iv", "x", "pdf", "logn", "cdf", "q", "clip", "noisy"}
    import json
    json.dumps(j)                         # serializable
    assert g.dist_for_day(ch, 100.0, AHORA, "2026-12-09") is None
```

- [ ] **Step 2: Comprobar que falla**

Run: `.venv\Scripts\python.exe pruebas/test_dist.py` → `AttributeError: ... 'dist_for_day'`.

- [ ] **Step 3: Implementar**

En `gex_engine.py`, tras `completar_probs`:

```python
def dist_for_day(ch: dict, spot: float, now: datetime, day: str, n: int = DIST_N) -> dict | None:
    """Distribucion del primer vencimiento de ese dia con datos (en SPX, el mensual AM antes que el semanal PM)."""
    for e in np.unique(ch["exp"][ch["exp"].astype("datetime64[D]") == np.datetime64(day, "D")]):
        dist = implied_distribution(ch, spot, now, e, n=n)
        if dist:
            return dist
    return None


def dist_json(dist: dict) -> dict:
    """Para la web: densidad y lognormal relativas al maximo de la densidad (0-1), CDF y precios redondeados."""
    pm = float(dist["pdf"].max()) or 1.0
    r = lambda a, k: np.round(np.asarray(a, float), k).tolist()   # noqa: E731
    return {"exp": dist["exp"], "days": dist["days"], "T": round(dist["T"], 6), "fwd": round(dist["fwd"], 4),
            "atm_iv": round(dist["atm_iv"], 5), "x": r(dist["x"], 4), "pdf": r(dist["pdf"] / pm, 4),
            "logn": r(dist["logn"] / pm, 4), "cdf": r(dist["cdf"], 5),
            "q": {k: round(v, 4) for k, v in dist["q"].items()}, "clip": round(dist["clip"], 4),
            "noisy": dist["noisy"]}
```

En `volatilidad.vol_data`, antes del `return`:

```python
    dists = []
    try:   # distribucion implicita: proximo vencimiento (aunque sea diario) y el de cada smile
        first = g.level_dists(ch, spot, now, sym)[:1]
        dias = ([first[0]["exp"]] if first else []) + [s["exp"] for s in sm]
        for day in dict.fromkeys(dias):
            dist = g.dist_for_day(ch, spot, now, day, n=200)
            if dist:
                dists.append(g.dist_json(dist))
    except Exception:  # noqa: BLE001  (el resto del panel sigue)
        dists = []
```

y en el dict devuelto añadir `"dists": dists,` tras `"smiles": sm,`.

- [ ] **Step 4: Comprobar**

Run: `.venv\Scripts\python.exe pruebas/test_dist.py` → todas `ok`.
Run: `.venv\Scripts\python.exe -c "import volatilidad"` → sin error.
Opcional con red: `.venv\Scripts\python.exe -c "import volatilidad as v, json; d=v.vol_data('SPY', save=False); print(len(d['dists']), d['dists'][0]['exp'], d['dists'][0]['q'], len(json.dumps(d))//1024, 'KB')"`. Anotar el tamaño: si `vol.json` supera ~400 KB, limitar `dists` a los vencimientos de ≤ 100 días.

- [ ] **Step 5: Commit**

```powershell
git add gex_engine.py volatilidad.py pruebas/test_dist.py
git commit -m "Volatilidad: distribuciones implícitas en /api/vol" -- gex_engine.py volatilidad.py pruebas/test_dist.py
```

---

### Task 5: línea de probabilidades en el ticker

**Files:**
- Modify: `web/index.html` (tarjeta `#facts`, tras `<span class="fs" id="emRegime" hidden></span>`)
- Modify: `web/app.js` (junto a `paintEmRegime`, ~línea 1241 y la definición tras `function move1`)

- [ ] **Step 1: Marcado**

En `web/index.html`, tras la línea de `emRegime`:

```html
      <span class="fs" id="emProbs" hidden></span>
```

- [ ] **Step 2: Pintado**

En `web/app.js`, tras `function sessLabel(...)` (~línea 686):

```js
// probabilidades implicitas de los niveles (level_probs del motor, distribucion de Breeden-Litzenberger):
// cerrar mas alla al vencimiento y tocar antes (estimada, el doble por la regla de reflexion)
function paintLevelProbs(d) {
  const el = $("emProbs"), lp = d.level_probs || [];
  const first = lp[0];
  const pp = (v) => `${fmtNum(v * 100, v < 0.1 ? 1 : 0)}%`;
  const part = (o, label) => (o ? `${label} ${pp(o.close)}${o.touch != null ? ` (touch ≈${pp(o.touch)})` : ""}` : "");
  const line = (r) => [part(r.call_wall, "above Call Wall"), part(r.put_wall, "below Put Wall"),
    r.flip ? part(r.flip, `${r.flip.side === "up" ? "above" : "below"} flip`) : ""].filter(Boolean).join(", ");
  const txt1 = first ? line(first) : "";
  el.hidden = !txt1;
  if (!txt1) return;
  el.textContent = `Close ${ddmm(first.exp)}: ${txt1}`;
  const second = lp[1] && line(lp[1]);
  el.title = "Probability implied by option prices (risk-neutral distribution at expiration, from the smile). " +
    "Touch is an estimate: about twice the close probability, before expiration." + (second ? ` Close ${ddmm(lp[1].exp)}: ${second}.` : "");
}
```

Y en la función que pinta la tarjeta, tras `paintEmRegime(d, em);`:

```js
  paintLevelProbs(d);
```

- [ ] **Step 3: Comprobar**

Run: `node --check web/app.js` → sin salida.
Local: `.venv\Scripts\python.exe server.py` (preview de `.claude/launch.json` si existe; si no, crearlo con `runtimeExecutable` `.venv\Scripts\python.exe`, `runtimeArgs` `["server.py"]`, `port` 8765) → abrir SPY y SPX, ver la línea bajo el rango de 1σ en tema oscuro y claro; sin `·`; el `title` con el segundo vencimiento.

- [ ] **Step 4: Commit**

```powershell
git add web/index.html web/app.js
git commit -m "Web: probabilidades implícitas de los niveles en la tarjeta del rango" -- web/index.html web/app.js
```

---

### Task 6: vista Distribution en Volatility

**Files:**
- Modify: `web/index.html` (`#volTabs`)
- Modify: `web/vol.js`
- Modify: `web/sg.css` (tras `.vg-mat { ... }`, línea 743)

- [ ] **Step 1: Pestaña y CSS**

En `web/index.html`, dentro de `#volTabs`, tras el botón `data-v="realized"`:

```html
      <button role="tab" data-v="dist" aria-selected="false">Distribution</button>
```

En `web/sg.css`, tras `.vg-mat { grid-column: 1 / -1; }`:

```css
.vg-wide { grid-column: 1 / -1; }
```

- [ ] **Step 2: Estado, vista en Overview y dibujo**

En `web/vol.js`:

1. En el objeto `vol`, añadir `distExp: "",` (vencimiento elegido; vacío = el primero).
2. `VOL_VIEWS`: añadir `["dist", "Distribution", "Price distribution at expiration implied by options"]` al final.
3. En `renderVolGrid`, la celda de `dist` a lo ancho y su dibujo:

```js
  g.innerHTML = VOL_VIEWS.map(([k, t, s]) => `<section class="vg-cell${k === "dist" ? " vg-wide" : ""}" data-v="${k}" tabindex="0" role="button" aria-label="Open ${t}"><header><h3>${t}</h3><span>${s}</span>${open}</header><div class="vg-ch" data-k="${k}"></div></section>`).join("")
```

y en ese mismo `renderVolGrid` y en `renderVol`, añadir `dist: renderDist` a los mapas `draw`:

```js
  const draw = { term: renderTerm, skew: renderSkew, shape: renderShape, realized: renderRealized, dist: renderDist };
```

```js
  const draw = { term: renderTerm, shape: renderShape, realized: renderRealized, dist: renderDist }[vol.tab] || renderSkew;
```

4. Funciones nuevas, tras `renderSkew`:

```js
/* ------------------------------------------------------------ distribucion implicita */
// probabilidad de cerrar por debajo de v (CDF interpolada); por encima = 1 - esto
function distCdf(z, v) {
  const x = z.x, c = z.cdf;
  if (v <= x[0]) return 0;
  if (v >= x[x.length - 1]) return 1;
  let i = 1; while (x[i] < v) i++;
  return c[i - 1] + (c[i] - c[i - 1]) * (v - x[i - 1]) / (x[i] - x[i - 1]);
}
function distSel() {
  const ds = (vol.data.dists || []).filter(inH);
  return ds.find((z) => z.exp === vol.distExp) || ds[0] || null;
}
// niveles del ticker cargado en la app, si es el mismo simbolo
function distLevels() {
  const sd = typeof state !== "undefined" && state.data;
  if (!sd || sd.symbol !== vol.data.symbol || !sd.levels) return [];
  const L = sd.levels;
  return [["Call Wall", L.call_wall, C.call, "up"], ["Put Wall", L.put_wall, C.put, "down"],
    ["Flip", L.flip, C.amber, L.flip != null && L.flip < sd.spot ? "down" : "up"]].filter((r) => r[1] != null);
}

function renderDist(W, H) {
  const d = vol.data, z = distSel();
  if (!z) return `<div class="placeholder">No implied distribution for this ticker.</div>`;
  const narrow = W < 640, fs = narrow ? 10.5 : 11.5;
  const L = narrow ? 18 : 24, R = W - (narrow ? 12 : 24), T = 30, B = H - 46;
  const span = z.q["95"] - z.q["5"];
  const lo = Math.max(z.x[0], z.q["5"] - 0.6 * span), hi = Math.min(z.x[z.x.length - 1], z.q["95"] + 0.6 * span);
  const xOf = (v) => L + ((v - lo) / (hi - lo || 1)) * (R - L);
  const idx = z.x.map((v, i) => i).filter((i) => z.x[i] >= lo && z.x[i] <= hi);
  const ymax = Math.max(1, ...idx.map((i) => z.logn[i])) * 1.08;
  const yOf = (v) => B - (v / ymax) * (B - T);
  const path = (arr) => idx.map((i, j) => `${j ? "L" : "M"}${xOf(z.x[i]).toFixed(1)},${yOf(arr[i]).toFixed(1)}`).join("");
  let s = "";
  // +-1 sigma con la IV ATM
  const sg = z.atm_iv * Math.sqrt(z.T), b0 = Math.max(lo, z.fwd * Math.exp(-sg)), b1 = Math.min(hi, z.fwd * Math.exp(sg));
  s += `<rect x="${xOf(b0)}" y="${T}" width="${Math.max(0, xOf(b1) - xOf(b0))}" height="${B - T}" fill="${volColors().band}"/>`;
  niceTicks(lo, hi, narrow ? 4 : 8).ticks.filter((v) => v >= lo && v <= hi).forEach((v) => { s += txt(xOf(v), B + fs + 8, fmtNum(v, v < 100 ? 1 : 0), { a: "middle", fs }); });
  s += `<line x1="${L}" x2="${R}" y1="${B}" y2="${B}" stroke="${C.axis}"/>`;
  s += `<path d="${path(z.pdf)}L${xOf(z.x[idx[idx.length - 1]]).toFixed(1)},${B}L${xOf(z.x[idx[0]]).toFixed(1)},${B}Z" fill="${C.accent}" fill-opacity=".16"/>`;
  s += `<path d="${path(z.logn)}" fill="none" stroke="${C.muted}" stroke-width="1.4" stroke-dasharray="4 4"/>`;
  s += `<path d="${path(z.pdf)}" fill="none" stroke="${C.accent}" stroke-width="2.2"/>`;
  const sx = xOf(d.spot);
  if (d.spot >= lo && d.spot <= hi) s += `<line x1="${sx}" x2="${sx}" y1="${T}" y2="${B}" stroke="${C.spotline}" stroke-dasharray="2 4" stroke-opacity=".7"/>` + txt(sx + 5, T + fs, `Spot ${fmtSpot(d.spot)}`, { fs, c: C.muted });
  distLevels().forEach(([name, v, col, side], j) => {
    if (v < lo || v > hi) return;
    const p = side === "up" ? 1 - distCdf(z, v) : distCdf(z, v);
    const x = xOf(v);
    s += `<line x1="${x}" x2="${x}" y1="${T}" y2="${B}" stroke="${col}" stroke-width="1.4"/>` +
      txt(x + 5, T + fs * (2.4 + j * 1.3), `${name} ${fmtLevel(v)}: ${side === "up" ? "above" : "below"} ${fmtNum(p * 100, p < 0.1 ? 1 : 0)}%`, { fs, c: col });
  });
  if (z.noisy) s += txt(R, T - 10, "Sparse quotes, shape approximate", { a: "end", fs, c: C.amber });
  s += txt(R, B + fs * 2 + 14, `Price at expiration ${volDate(z.exp)}`, { a: "end", fs, c: C.faint });
  s += `<line id="vhl" x1="0" x2="0" y1="${T}" y2="${B}" stroke="${C.spotline}" stroke-opacity=".6" visibility="hidden"/>`;
  vol.geo = { kind: "dist", z, lo, hi, L, R };
  return volFrame(W, H, s);
}
```

Comprobar que `fmtLevel` existe en `web/app.js` (`grep -n "function fmtLevel" web/app.js`); si no, usar `fmtSpot`.

5. `volControls`, antes del `return` final (la matriz):

```js
  if (vol.tab === "dist") {
    const z = distSel();
    const ex = (d.dists || []).filter(inH).map((x) => `<button class="vexp${z && x.exp === z.exp ? " on" : ""}" data-de="${x.exp}"${z && x.exp === z.exp ? ` style="--c:${C.accent}"` : ""}>${volDate(x.exp)}<small>${volDays(x)}d</small></button>`).join("");
    const q = z ? `<span class="vleg">Percentiles: 5th ${fmtNum(z.q["5"], 2)}, 25th ${fmtNum(z.q["25"], 2)}, median ${fmtNum(z.q["50"], 2)}, 75th ${fmtNum(z.q["75"], 2)}, 95th ${fmtNum(z.q["95"], 2)}</span>` : "";
    return `<div class="vrow">${horSeg()}<span class="vleg"><i style="background:${C.accent}"></i>Implied by options <i style="background:${C.muted}"></i>Lognormal at ATM IV (dashed) <i style="background:${volColors().band}"></i>±1σ</span></div>
      <div class="vrow">${q}</div><div class="vrow vexps" aria-label="Expiration">${ex}</div>`;
  }
```

6. Clic en los vencimientos: en `bindVol`, buscar el manejador de `#volCtl` que atiende `button.vexp` (`grep -n "vexp" web/vol.js`) y, al principio del manejador de clic de `#volCtl`, añadir:

```js
    const de = e.target.closest("button[data-de]");
    if (de) { vol.distExp = de.dataset.de; renderVol(); return; }
```

7. `volNote`:

```js
  if (vol.tab === "dist") return "Risk-neutral distribution of the price at expiration, from option prices (second derivative of call prices across strikes, Breeden-Litzenberger), with the implied volatility of each strike. The dashed line is a lognormal with the at-the-money IV: where the solid curve sits above it, the market pays more for that move than plain volatility would. Shaded: ±1σ. With the ticker loaded, the levels show the probability of closing beyond them. Not a forecast: it includes the premium the market pays for protection.";
```

8. `volTip`, nueva rama antes del `else` final (la del skew):

```js
  } else if (g.kind === "dist") {
    if (x < g.L || x > g.R) { $("volTip").hidden = true; if (hl) hl.setAttribute("visibility", "hidden"); return; }
    const v = g.lo + ((x - g.L) / (g.R - g.L)) * (g.hi - g.lo), c = distCdf(g.z, v);
    html = `<div class="t">Price ${fmtNum(v, 2)} (${fmtNum((v / vol.data.spot - 1) * 100, 2)}%)</div>
      <div class="r">Close above <b>${fmtNum((1 - c) * 100, 1)}%</b></div>
      <div class="r">Close below <b>${fmtNum(c * 100, 1)}%</b></div>`;
    if (hl) { hl.setAttribute("x1", x); hl.setAttribute("x2", x); hl.setAttribute("visibility", "visible"); }
```

- [ ] **Step 3: Comprobar**

Run: `node --check web/vol.js` y `node --check web/app.js` → sin salida.
Local con `server.py`: Volatility de SPX, QQQ, NVDA y VIX:
- Overview: la celda Distribution a lo ancho, sin romper la rejilla (y en < 1100 px, una columna).
- Vista Distribution: curva, lognormal discontinua, banda, spot; cambiar de vencimiento; tooltip con probabilidades que suman 100 %.
- Con el ticker cargado (abrir SPX en la vista principal y volver): líneas de Call Wall, Put Wall y flip con su probabilidad.
- Tema oscuro y claro; consola sin errores (`read_console_messages`).
Captura de pantalla de cada tema como prueba.

- [ ] **Step 4: Commit**

```powershell
git add web/index.html web/vol.js web/sg.css
git commit -m "Web: vista Distribution en Volatility" -- web/index.html web/vol.js web/sg.css
```

---

### Task 7: datos reales, documentación y despliegue

**Files:**
- Create: `pruebas/dist_real.py`
- Modify: `CHANGELOG.md`, `docs/ARQUITECTURA.md`, `docs/ESTADO.md`

- [ ] **Step 1: Script de comprobación con datos reales**

`pruebas/dist_real.py`:

```python
"""Distribucion implicita con datos reales (comparar.yml): forma, control de calidad y coherencia con el 1 sigma."""
import os
import sys

sys.path.insert(0, os.getcwd())
import gex_engine as g  # noqa: E402

now = g.now_ny()
for sym in ("SPX", "QQQ", "NVDA", "VIX"):
    ch = g.parse_chain(g.fetch_chain(sym))
    spot = ch["spot"]
    for dist in g.level_dists(ch, spot, now, sym):
        s = dist["atm_iv"] * dist["T"] ** 0.5
        lo, hi = dist["fwd"] * (2.718281828 ** -s), dist["fwd"] * (2.718281828 ** s)
        fuera = g.prob_beyond(dist, hi, "up") + g.prob_beyond(dist, lo, "down")
        print(f"{sym} {dist['exp']} F {dist['fwd']:.2f} q50 {dist['q']['50']:.2f} ({(dist['q']['50'] / dist['fwd'] - 1) * 100:+.2f}%) "
              f"q5 {dist['q']['5']:.2f} q95 {dist['q']['95']:.2f} clip {dist['clip']:.4f} fuera de 1s {fuera:.3f}")
    r = g.compute(sym, max_dte=0 if sym != "NVDA" else 7, window_pct="auto")
    print("  level_probs", r["level_probs"])
```

- [ ] **Step 2: Subir solo el script y lanzarlo**

El workflow lee `main`, así que el script tiene que estar subido. Antes del push, confirmar con el usuario (es el despliegue del motor: `gex_engine.py` dispara `desplegar.yml`). Con su visto bueno, hacer el Step 3 (documentación) y el Step 4 (push) primero, y después:

```powershell
gh api -X POST repos/LoppVicious/gexlab/actions/workflows/comparar.yml/dispatches -f ref=main -f 'inputs[script]=dist_real.py'
```

Leer el log de la ejecución (`gh api repos/LoppVicious/gexlab/actions/runs?per_page=1`, luego los jobs y `.../logs`). Criterios: `q50` dentro de ±1 % del forward (más en el VIX), `clip` < 0,05 salvo alguna ala, `fuera de 1s` entre 0,25 y 0,40, y `level_probs` con cifras entre 0 y 1. Si algo falla, corregir antes de dar la tarea por cerrada.

- [ ] **Step 3: Documentación**

- `CHANGELOG.md`: en la entrada del día (si ya existe, ampliarla y reescribirla al estado final; leerla antes, porque otras sesiones la editan), en Añadido: "Distribución implícita por vencimiento (Breeden-Litzenberger): probabilidad de cerrar más allá de Call Wall, Put Wall y flip y de tocarlos (estimada) en la tarjeta del rango de 1σ; vista Distribution en Volatility; las probabilidades de cierre se guardan cada día en el índice de niveles."
- `docs/ARQUITECTURA.md`: en la sección de `hist500/_niveles/`, los campos nuevos (`flip`, `pc_exp`, `pc_cw`, `pc_pw`, `pc_flip`) y que `--indice` rellena los días pasados con la cadena guardada; en la parte del motor, `level_probs` en el resultado y `dists` en `/api/vol`.
- `docs/ESTADO.md`: pendiente "Validación de las probabilidades implícitas: comparar la frecuencia real de cierres más allá de cada nivel con `pc_*` cuando haya 20-30 sesiones (desde el 2026-11-04 con el relleno)".

- [ ] **Step 4: Commit y push (con el visto bueno del usuario)**

```powershell
git add pruebas/dist_real.py CHANGELOG.md docs/ARQUITECTURA.md docs/ESTADO.md
git commit -m "Distribución implícita: prueba con datos reales y documentación" -- pruebas/dist_real.py CHANGELOG.md docs/ARQUITECTURA.md docs/ESTADO.md
git push origin main
```

Si el push se rechaza porque otra sesión subió antes: `git pull --rebase origin main` (sin stash; si hay cambios sin commit de otras sesiones que lo impidan, parar y avisar al usuario).

- [ ] **Step 5: Comprobar en producción**

Tras `desplegar.yml` y el siguiente ciclo del motor (15 min): https://dashboard.gexlab.workers.dev con Ctrl+F5, SPX y QQQ: línea de probabilidades y vista Distribution en los dos temas. Al día siguiente de mercado, tras el historial de las 16:30 ET, comprobar que `hist500/_niveles/SPY.json.gz` lleva `pc_cw` (desde `/admin` o con un `pruebas/*.py` que lo lea), y lanzar `historial500.py --indice` en Actions si se quiere el relleno de los días anteriores.
