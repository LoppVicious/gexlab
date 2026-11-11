"""
GEX Lab - flujo de opciones estimado (pagina Options flow).

CBOE y Tradier dan por contrato el volumen acumulado del dia, no cada operacion con su lado. El flujo se estima
comparando cada foto de la cadena con la anterior (el ciclo del motor, cada 15 min):
  - Volumen nuevo de cada contrato: volumen ahora - volumen en la foto anterior.
  - Lado (BVC, bulk volume classification): fraccion comprada = Phi(cambio de IV / desviacion tipica robusta de los
    cambios de IV de los contratos negociados en ese tramo). Se usa la IV y no el precio porque el precio de una
    opcion se mueve con el subyacente aunque nadie la compre; la IV sube cuando se paga de mas por ella. Si en el
    tramo hay pocos contratos para estimar la dispersion, la regla de cotizacion (ultima operacion cerca del ask o
    del bid).
  - Con ese volumen firmado (desde el cliente: + compra, - venta): prima neta de calls y de puts, delta neta en $ y
    vega neta en $ por punto de IV, acumuladas en la sesion.
  - Actividad inusual: contratos con volumen de hoy por encima de su open interest, ordenados por prima, con su
    delta y vega en $ y la parte estimada como compra.
Todo es una estimacion: no se ven las operaciones, solo el volumen entre dos fotos.

Estado por ticker en history/flujo_{SYM}.json.gz (lo guarda el ciclo con el resto del historial).
"""
from __future__ import annotations

import math
import os

import numpy as np

import gex_engine as g

TICK_GAP = 240          # s minimos entre dos tramos guardados (en el PC, cada consulta puede ser un tramo)
MIN_BVC = 20            # contratos negociados en el tramo para estimar la dispersion de los cambios de IV
REACH = 0.35            # contratos a +-35 % del precio
UOA_N = 15
UOA_MIN_VOL = 100


def _path(sym: str) -> str:
    return os.path.join(g.HIST_DIR, f"flujo_{sym.replace('.', '_')}.json.gz")


def _vega(F, K, iv, T):
    """Vega de Black-76 por punto de IV (sin descuento): cuanto cambia el precio si la IV sube 1 punto."""
    sw = iv * np.sqrt(T)
    d1 = (np.log(F / K) + 0.5 * sw * sw) / sw
    return F * np.exp(-0.5 * d1 * d1) / math.sqrt(2 * math.pi) * np.sqrt(T) * 0.01


def _phi(x):
    return 0.5 * (1 + np.vectorize(math.erf)(x / math.sqrt(2)))


def tick(sym: str, save: bool = True, ch: dict | None = None) -> dict:
    sym = g.normalize(sym)
    ch = ch or g.parse_chain(g.fetch_chain(sym))
    now = g.now_ny()
    session = g.session_date(ch["timestamp"])
    spot = float(ch["spot"])
    now64 = np.datetime64(now.replace(second=0, microsecond=0))
    m = (ch["exp"] > now64) & (ch["vol"] > 0) & (ch["iv"] > 0.01) & (np.abs(ch["K"] / spot - 1) < REACH)
    K, C, E = ch["K"][m], ch["call"][m], ch["exp"][m]
    vol, iv, oi = ch["vol"][m], ch["iv"][m], ch["oi"][m]
    bid, ask, last = ch["bid"][m], ch["ask"][m], ch["last"][m]
    mid = np.where((bid > 0) & (ask >= bid), (bid + ask) / 2, last)
    F = ch["fwd"][m] if ch.get("fwd") is not None else np.full(K.shape, spot)
    F = np.where(np.isfinite(F) & (F > 0), F, spot)
    T = np.maximum((E - now64).astype("timedelta64[m]").astype(float), 30.0) / g.YEAR_MIN
    delta = ch["delta"][m]
    vega = _vega(F, K, iv, T)
    keys = g._contract_keys(K, C, E)

    path = _path(sym)
    st = g.read_json(path, {}) or {}
    if st.get("session") != session:
        # sesion nueva: el volumen empieza de cero; la IV de referencia, la de la ultima foto de la sesion anterior
        ref = {k: v[1] for k, v in (st.get("last") or {}).items()}
        st = {"session": session, "last": {k: [0, v] for k, v in ref.items()}, "acc": {}, "series": [], "t": 0}
    last_st = st["last"]

    # --- tramo: volumen nuevo de cada contrato y su lado
    pv = np.array([last_st.get(k, [0, 0])[0] for k in keys], dtype=float)
    piv = np.array([last_st.get(k, [0, 0])[1] for k in keys], dtype=float)
    dv = np.maximum(vol - pv, 0)
    tr = dv > 0
    known = tr & (piv > 0.01)
    div = iv - piv
    b = (1 + g._classify(last, bid, ask)) / 2          # regla de cotizacion: 1, 0,5 o 0
    method = "quote"
    if known.sum() >= MIN_BVC:
        x = div[known]
        sig = 1.4826 * float(np.median(np.abs(x - np.median(x))))
        if sig > 1e-6:
            b = np.where(known, _phi(div / sig), b)
            method = "bvc"
    signed = dv * (2 * b - 1)                           # + comprado por clientes, - vendido
    step = {"cp": float((signed * mid * 100)[C].sum()), "pp": float((signed * mid * 100)[~C].sum()),
            "d": float((signed * delta * 100 * spot).sum()), "vg": float((signed * vega * 100).sum()),
            "v": float(dv.sum())}
    prev = st["series"][-1] if st["series"] else {"cp": 0, "pp": 0, "d": 0, "vg": 0, "v": 0}
    point = {"t": now.strftime("%H:%M"), "s": round(spot, 4), "m": method,
             **{k: round(prev[k] + step[k], 2) for k in ("cp", "pp", "d", "vg", "v")}}
    series = list(st["series"])
    acc = dict(st.get("acc") or {})
    new_tick = step["v"] > 0
    if new_tick:
        series.append(point)
        for i in np.where(tr)[0]:
            a = acc.get(keys[i], [0.0, 0.0])
            acc[keys[i]] = [round(a[0] + float(signed[i]), 1), round(a[1] + float(dv[i]), 1)]
    saved = False
    if save and new_tick and (now.timestamp() - st.get("t", 0) >= TICK_GAP or not st["series"]):
        out_st = {"session": session, "t": now.timestamp(), "series": series, "acc": acc,
                  "last": {k: [int(v), round(float(s), 4)] for k, v, s in zip(keys, vol, iv)}}
        # los contratos sin volumen hoy guardan solo su IV (referencia del primer tramo de la proxima sesion)
        today = now.strftime("%Y-%m-%d")
        for k, v in last_st.items():
            if k[:10] >= today:                         # sin los vencidos
                out_st["last"].setdefault(k, v)
        try:
            g.write_json(path, out_st)
            saved = True
        except OSError:
            pass

    # --- actividad inusual: volumen de hoy por encima del open interest
    prem = vol * mid * 100
    cand = np.where((vol >= UOA_MIN_VOL) & (vol > oi))[0]
    cand = cand[np.argsort(-prem[cand])][:UOA_N]
    uoa = []
    for i in cand:
        a = acc.get(keys[i])
        uoa.append({"exp": str(E[i])[:10], "k": float(K[i]), "c": bool(C[i]), "vol": int(vol[i]), "oi": int(oi[i]),
                    "iv": round(float(iv[i]), 4), "mid": round(float(mid[i]), 3), "prem": round(float(prem[i])),
                    "delta": round(float(vol[i] * delta[i] * 100 * spot)), "vega": round(float(vol[i] * vega[i] * 100)),
                    "bought": round((1 + a[0] / a[1]) / 2, 3) if a and a[1] > 0 else None})
    tot_v = float(vol.sum())
    cls_v = float(sum(v[1] for v in acc.values()))
    return {"symbol": sym, "name": g.name_of(sym), "session": session, "spot": spot,
            "generado": now.strftime("%Y-%m-%d %H:%M ET"), "series": series, "uoa": uoa,
            "volume": {"total": tot_v, "classified": cls_v,
                       "calls": float(vol[C].sum()), "puts": float(vol[~C].sum())},
            "provisional": bool(new_tick and not saved)}
