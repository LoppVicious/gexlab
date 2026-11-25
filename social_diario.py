"""Social diario (dos pasadas: 16:20 ET sin acciones, y al acabar el historial diario con ellas): paquete de datos y graficos del dia para publicar en X (R2 social/{F}/paquete.json,
social/{F}/g/*.png y social/ultimo.json). Lo ejecuta social.yml tras el historial diario; los textos los escribe
Claude Code con /x-diario y se guardan en social/{F}/textos.json (Worker, nube/social.js). Solo los ve el admin.
Fuentes: cadenas de CBOE al cierre de SPX, NDX y RUT (se calculan aqui con el motor Perfil), hist500/ (indice de
skew con cierre, IV y volumen de opciones de toda la lista, indice de niveles, familia VIX) y pub/eventos.json.
Graficos en social_graficos.py.
Uso: python social_diario.py [--forzar]   (sin --forzar no rehace lo ya publicado)"""
from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import datetime, timedelta

import almacen
import gex_engine as g

SALIDA = "social/"
H = "hist500/"
INDICES = ["SPX", "NDX", "RUT"]
PROXY = {"SPX": "SPY", "NDX": "QQQ", "RUT": "IWM"}   # su m1_pct del dia anterior si no hay paquete previo
POSICION, MODELO, FILTRO = "standard", "spotgamma", "all"
DIAS_ANO = 252
# umbrales de destacado
SORPRESA, CALMA = 1.5, 0.3       # |cambio| / movimiento implicito
MURO_CERCA = 0.5                 # % del cierre a un muro
Z_ACCION, SALTO_IV, VOL_OPC = 2.5, 5.0, 3.0   # sigmas, puntos de IV, veces el volumen medio de opciones
VIX_CAMBIO, VIX_PCTL = 8.0, 80.0
TOP = 8
VIX_FAMILIA = ("VIX9D", "VIX", "VIX3M", "VIX6M", "VIX1Y")
# mercados cruzados: grupo -> [(simbolo, nombre, umbral de movimiento grande en %)]; TNX = rendimiento a 10 anos
MERCADOS = {
    "Rates": [("TNX", "10Y yield", None), ("TLT", "20Y+ Treasuries", 1.5), ("IEF", "7-10Y Treasuries", 0.8)],
    "Credit": [("HYG", "High yield", 0.8)],
    "Dollar": [("UUP", "US dollar", 0.8)],
    "Commodities": [("GLD", "Gold", 2.0), ("SLV", "Silver", 3.0), ("USO", "Oil", 3.0)],
    "Crypto": [("IBIT", "Bitcoin ETF", 5.0), ("ETHA", "Ether ETF", 6.0)],
}
TNX_PB = 10.0                        # puntos basicos que hacen noticia en el 10 anos
SECTORES = {"XLK": "Tech", "XLF": "Financials", "XLE": "Energy", "XLV": "Health care", "XLU": "Utilities",
            "XLY": "Discretionary", "XLP": "Staples", "XLI": "Industrials", "XLC": "Communication",
            "XLB": "Materials", "XLRE": "Real estate", "SMH": "Semis"}
AMPLITUD = ["SPY", "RSP", "QQQ", "IWM"]


def log(msg: str) -> None:
    print(msg, flush=True)


def _r(x, n=2):
    return None if x is None or (isinstance(x, float) and not math.isfinite(x)) else round(float(x), n)


# ------------------------------------------------------------------ calculos (sin red)
def bloque_indice(res: dict, esperado_hoy: float | None, previo: dict | None) -> dict:
    """Resumen de un indice a partir de g.compute tras el cierre. esperado_hoy: movimiento implicito (1 sigma, %)
    que tenia la sesion de hoy; previo: el bloque de este indice en el paquete de la sesion anterior."""
    L, spot = res["levels"], res["spot"]
    d1 = (res.get("moves") or {}).get("d1") or {}
    d5 = (res.get("moves") or {}).get("d5") or {}
    chg = res.get("chg_pct")
    ratio = abs(chg) / esperado_hoy if chg is not None and esperado_hoy else None
    dist = lambda k: None if k is None else (k / spot - 1) * 100
    regimen = res["regime"]
    cambio_reg = bool(previo) and previo.get("regimen") != regimen
    muros = {k: L.get(k) for k in ("call_wall", "put_wall", "flip", "vt", "abs_gamma")}
    cerca = [k for k in ("call_wall", "put_wall") if muros[k] is not None and abs(dist(muros[k])) <= MURO_CERCA]
    movidos = {k: [previo["niveles"].get(k), muros[k]] for k in ("call_wall", "put_wall", "flip")
               if previo and previo.get("niveles", {}).get(k) is not None and muros[k] is not None
               and previo["niveles"][k] != muros[k]}
    motivos = []
    if ratio is not None and ratio >= SORPRESA:
        motivos.append("move_vs_implied_big")
    if ratio is not None and ratio <= CALMA:
        motivos.append("move_vs_implied_small")
    if cambio_reg:
        motivos.append("regime_flip")
    motivos += [f"near_{k}" for k in cerca]
    return {
        "cierre": _r(spot), "cierre_previo": _r(res.get("prev_close")), "cambio_pct": _r(chg),
        "esperado_hoy_pct": _r(esperado_hoy), "cambio_vs_esperado": _r(ratio),
        "regimen": regimen, "regimen_previo": previo.get("regimen") if previo else None,
        "gamma_neta_1pct": _r(res["totals"]["net_per_pct"], 0),
        "gamma_neta_1pct_previa": previo.get("gamma_neta_1pct") if previo else None,
        "niveles": {k: _r(v) for k, v in muros.items()},
        "distancia_pct": {k: _r(dist(v)) for k, v in muros.items()},
        "niveles_movidos": movidos,
        "siguiente": {"sesion": d1.get("session"), "pct": _r(d1.get("pct")), "lo": _r(d1.get("lo")), "hi": _r(d1.get("hi"))},
        "semana": {"pct": _r(d5.get("pct")), "lo": _r(d5.get("lo")), "hi": _r(d5.get("hi"))},
        "vencimiento_proximo": res.get("front_expiry"), "gamma_proximo_pct": _r(100 * (res.get("front_share") or 0), 1),
        "motivos": motivos, "destacado": bool(motivos),
    }


def _iv(x):
    """IV ATM del indice de skew en tanto por uno (si viniera en %, se pasa a tanto por uno)."""
    if x is None:
        return None
    x = float(x)
    return x / 100 if x > 3 else x


def bloque_acciones(idx: dict, F: str, excluir=()) -> dict:
    """Movimientos de la lista del historial diario con el indice de skew {fecha: {SYM: [atm, put25, cierre,
    call-put, contratos, acciones]}}: cambio en sigmas (con la IV ATM de ayer), salto de IV y volumen de opciones
    frente a su media de 20 sesiones."""
    dias = sorted(d for d in idx if d <= F)
    if not dias or dias[-1] != F or len(dias) < 2:
        raise ValueError(f"Sin la sesion {F} y la anterior en el indice de skew")
    hoy, ayer = idx[F], idx[dias[-2]]
    previos = [idx[d] for d in dias[-21:-1]]
    filas = []
    for sym, f in hoy.items():
        a = ayer.get(sym)
        if sym in excluir or not f or not a or not f[2] or not a[2]:
            continue
        chg = (f[2] / a[2] - 1) * 100
        iv0, iv1 = _iv(a[0]), _iv(f[0])
        sig = iv0 * 100 / math.sqrt(DIAS_ANO) if iv0 else None
        vols = [p[sym][4] for p in previos if p.get(sym) and p[sym][4]]
        media = sum(vols) / len(vols) if len(vols) >= 5 else None
        filas.append({"sym": sym, "cierre": _r(f[2]), "cambio_pct": _r(chg), "sigma_pct": _r(sig),
                      "z": _r(chg / sig) if sig else None,
                      "iv": _r(iv1 * 100 if iv1 else None, 1), "iv_cambio": _r((iv1 - iv0) * 100, 1) if iv0 and iv1 else None,
                      "opciones": f[4], "opciones_vs_media": _r(f[4] / media, 1) if media and f[4] else None})
    if not filas:
        raise ValueError("Sin acciones con cierre de hoy y de ayer")
    top = lambda k, n=TOP, absoluto=True: [x for x in sorted((x for x in filas if x[k] is not None),
                                                               key=lambda x: -abs(x[k]) if absoluto else -x[k])][:n]
    sigmas, iv, vol = top("z"), top("iv_cambio", 5, False), top("opciones_vs_media", 5, False)
    motivos = []
    if sigmas and abs(sigmas[0]["z"]) >= Z_ACCION:
        motivos.append("big_sigma_move")
    if iv and iv[0]["iv_cambio"] >= SALTO_IV:
        motivos.append("iv_jump")
    if vol and vol[0]["opciones_vs_media"] >= VOL_OPC:
        motivos.append("options_volume_spike")
    subieron = sum(1 for x in filas if x["cambio_pct"] > 0)
    return {"sesion_previa": dias[-2], "n": len(filas), "suben": subieron, "bajan": len(filas) - subieron,
            "mayor_sigma": sigmas, "mayor_salto_iv": iv, "mayor_volumen_opciones": vol,
            "motivos": motivos, "destacado": bool(motivos)}


def bloque_vix(cot: dict, serie: list) -> dict:
    """Familia VIX con las cotizaciones tras el cierre (gex_engine.fetch_quote) ({SYM: {close, current_price, prev_day_close}}) y el
    percentil del cierre en el ultimo ano (serie diaria de cierres anteriores)."""
    hoy = lambda s: (cot.get(s) or {}).get("close") or (cot.get(s) or {}).get("current_price")
    ayer = lambda s: (cot.get(s) or {}).get("prev_day_close")
    vix = hoy("VIX")
    if not vix:
        raise ValueError("Sin cierre del VIX")
    prev = ayer("VIX")
    chg = (vix / prev - 1) * 100 if prev else None
    curva = {s: _r(hoy(s)) for s in VIX_FAMILIA}
    curva_prev = {s: _r(ayer(s)) for s in VIX_FAMILIA}
    ano = [c for _, c in serie[-DIAS_ANO:]]
    pct = 100 * sum(1 for c in ano if c < vix) / len(ano) if len(ano) >= 100 else None
    invertida = bool(curva.get("VIX3M")) and vix > curva["VIX3M"]
    motivos = []
    if chg is not None and abs(chg) >= VIX_CAMBIO:
        motivos.append("big_vix_move")
    if invertida:
        motivos.append("term_structure_inverted")
    if pct is not None and pct >= VIX_PCTL:
        motivos.append("vix_high_percentile")
    return {"cierre": _r(vix), "cambio_pct": _r(chg), "percentil_1a": _r(pct, 0), "curva": curva,
            "curva_previa": curva_prev if any(curva_prev.values()) else None, "invertida": invertida,
            "motivos": motivos, "destacado": bool(motivos)}


def bloque_mercados(cot: dict, cripto: dict | None = None) -> dict:
    """Mercados cruzados al cierre (cotizaciones {SYM: {ultimo, previo, cambio_pct}}): tipos, credito, dolar, materias
    primas y crypto; sectores y amplitud (igual ponderado frente al indice, small caps, sectores en verde).
    cripto: {"BTC": {ultimo, cambio_24h_pct}, ...} del mercado al contado (24 h), opcional."""
    fila = lambda s, n: {"sym": s, "nombre": n, "ultimo": _r(cot[s]["ultimo"]), "cambio_pct": _r(cot[s].get("cambio_pct"))}
    grupos, motivos, grandes = {}, [], []
    for grupo, lista in MERCADOS.items():
        filas = []
        for s, n, umbral in lista:
            if s not in cot or cot[s].get("cambio_pct") is None:
                continue
            f = fila(s, n)
            if s == "TNX":   # el indice del 10 anos cotiza x10 (42.5 = 4.25 %): rendimiento y cambio en pb
                k = 10 if cot[s]["ultimo"] > 20 else 1
                f["rendimiento_pct"] = _r(cot[s]["ultimo"] / k, 3)
                f["cambio_pb"] = _r((cot[s]["ultimo"] - cot[s]["previo"]) / k * 100, 1) if cot[s].get("previo") else None
                if f["cambio_pb"] is not None and abs(f["cambio_pb"]) >= TNX_PB:
                    grandes.append(s)
            elif umbral and abs(f["cambio_pct"]) >= umbral:
                grandes.append(s)
            filas.append(f)
        grupos[grupo] = filas
    if cripto:
        grupos["Crypto spot"] = [{"sym": k, "nombre": k, "ultimo": _r(v["ultimo"]), "cambio_pct": _r(v["cambio_24h_pct"]), "ventana": "24h"}
                                 for k, v in cripto.items() if v.get("ultimo")]
    sectores = sorted((fila(s, n) for s, n in SECTORES.items() if s in cot and cot[s].get("cambio_pct") is not None),
                      key=lambda x: -x["cambio_pct"])
    sec11 = [x for x in sectores if x["sym"] != "SMH"]
    c = lambda s: (cot.get(s) or {}).get("cambio_pct")
    rel = lambda a, b: _r(c(a) - c(b)) if c(a) is not None and c(b) is not None else None
    amplitud = {"rsp_vs_spy": rel("RSP", "SPY"), "iwm_vs_spy": rel("IWM", "SPY"), "qqq_vs_spy": rel("QQQ", "SPY"),
                "sectores_suben": sum(1 for x in sec11 if x["cambio_pct"] > 0), "sectores_total": len(sec11),
                "etfs": {s: _r(c(s)) for s in AMPLITUD if c(s) is not None}}
    if not any(grupos.values()) and not sectores:
        raise ValueError("Sin cotizaciones de mercados")
    spy = c("SPY")
    if sec11 and spy is not None:
        if spy > 0 and (amplitud["sectores_suben"] <= len(sec11) // 3 or (amplitud["rsp_vs_spy"] or 0) <= -0.5):
            motivos.append("narrow_breadth")
        if spy < 0 and amplitud["sectores_suben"] <= 1:
            motivos.append("broad_selloff")
        if spy > 0 and amplitud["sectores_suben"] >= len(sec11) - 1:
            motivos.append("broad_rally")
    if grandes:
        motivos.append("big_cross_asset_move")
    return {"grupos": grupos, "sectores": sectores, "amplitud": amplitud, "grandes": grandes,
            "motivos": motivos, "destacado": bool(motivos)}


def tercer_viernes(d: datetime) -> bool:
    return d.weekday() == 4 and 15 <= d.day <= 21


def bloque_manana(evs: list, sesion: str) -> dict:
    """Eventos de EE. UU. de importancia 2+ de la proxima sesion y si es vencimiento mensual."""
    d = datetime.strptime(sesion, "%Y-%m-%d")
    lista = sorted(({"hora": e.get("time"), "evento": e.get("titulo") or e.get("name"), "importancia": e.get("imp"),
                     "previsto": e.get("forecast"), "anterior": e.get("previous")}
                    for e in evs if e.get("date") == sesion and (e.get("imp") or 0) >= 2),
                   key=lambda e: (e["hora"] or "99:99", -(e["importancia"] or 0)))
    opex = tercer_viernes(d)
    motivos = (["monthly_opex"] if opex else []) + (["high_impact_event"] if any(e["importancia"] >= 3 for e in lista) else [])
    return {"sesion": sesion, "dia": d.strftime("%A"), "opex_mensual": opex, "eventos": lista,
            "motivos": motivos, "destacado": bool(motivos)}


# ------------------------------------------------------------------ lectura
def _snap(levels):
    try:
        return levels[POSICION][MODELO][FILTRO]
    except (KeyError, TypeError):
        return None


def _niveles(st, sym) -> dict:
    return almacen.get_json(st, f"{H}_niveles/{sym}.json.gz") or {}


def esperado_proxy(st, sym: str, F: str) -> float | None:
    """m1_pct del ETF del indice guardado la sesion anterior a F (su rango implicito para F)."""
    idx = _niveles(st, PROXY[sym])
    previas = [d for d in sorted(idx) if d < F]
    s = _snap(idx[previas[-1]]) if previas else None
    return s.get("m1_pct") if s and s.get("m1_session") == F else None


def niveles_accion(st, sym: str, F: str) -> dict | None:
    idx = _niveles(st, sym)
    hoy = _snap(idx.get(F))
    if not hoy:
        return None
    previas = [d for d in sorted(idx) if d < F]
    ayer = _snap(idx[previas[-1]]) if previas else None
    reg = lambda s: None if not s or s.get("net_per_pct") is None else ("positive" if s["net_per_pct"] > 0 else "negative")
    return {"call_wall": hoy.get("call_wall"), "put_wall": hoy.get("put_wall"), "regimen": reg(hoy),
            "regimen_previo": reg(ayer), "rango_siguiente_pct": _r(hoy.get("m1_pct"))}


def _bloque(nombre, fn) -> dict:
    try:
        return {"estado": "ok", **fn(), "graficos": []}
    except Exception as e:  # noqa: BLE001
        log(f"bloque {nombre}: {type(e).__name__}: {str(e)[:200]}")
        return {"estado": "ausente", "motivo": f"{type(e).__name__}: {str(e)[:200]}"}


def cotizaciones_cierre() -> dict:
    """Mercados cruzados con Tradier (una peticion; necesita TRADIER_TOKEN) y lo que falte (el 10 anos, TNX, que
    Tradier no tiene; o todo, sin token) con gex_engine.fetch_quote simbolo a simbolo (CSV de CBOE)."""
    simbolos = [s for lista in MERCADOS.values() for s, _, _ in lista] + list(SECTORES) + AMPLITUD
    out = {}
    try:
        import fuente_tradier as ft
        if ft.token():
            out = ft.cotizaciones(simbolos)
    except Exception as e:  # noqa: BLE001
        log(f"cotizaciones de Tradier: {type(e).__name__}: {str(e)[:120]}")
    for s in [x for x in simbolos if x not in out]:
        q = (g.fetch_quote(s, ttl=0) or {}).get("data") or {}
        ult, prev = q.get("close") or q.get("current_price"), q.get("prev_day_close")
        if ult and prev:
            out[s] = {"ultimo": float(ult), "previo": float(prev), "cambio_pct": (float(ult) / float(prev) - 1) * 100}
    return out


def cripto_contado() -> dict:
    """Bitcoin y ether al contado y su cambio en 24 h (CoinGecko, sin clave). Vacio si falla."""
    try:
        import urllib.request
        req = urllib.request.Request("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum"
                                     "&vs_currencies=usd&include_24hr_change=true", headers={"User-Agent": "gexlab"})
        with urllib.request.urlopen(req, timeout=15, context=g._SSL_CTXS[0]) as r:
            d = json.loads(r.read().decode("utf-8"))
        return {k: {"ultimo": d[i]["usd"], "cambio_24h_pct": d[i].get("usd_24h_change")}
                for k, i in (("BTC", "bitcoin"), ("ETH", "ethereum")) if d.get(i, {}).get("usd")}
    except Exception as e:  # noqa: BLE001
        log(f"cripto: {type(e).__name__}: {str(e)[:120]}")
        return {}


def leer_acciones(st, F: str) -> dict:
    """Bloque de acciones con el indice de skew del historial diario y los niveles de las que se citan."""
    skew_idx = almacen.get_json(st, f"{H}_skew.json.gz") or {}
    acciones = _bloque("acciones", lambda: bloque_acciones(skew_idx, F, excluir={"VIX"}))
    if acciones["estado"] == "ok":
        citadas = {x["sym"] for k in ("mayor_sigma", "mayor_salto_iv", "mayor_volumen_opciones") for x in acciones[k][:5]}
        for k in ("mayor_sigma", "mayor_salto_iv", "mayor_volumen_opciones"):
            for x in acciones[k]:
                if x["sym"] in citadas:
                    x["niveles"] = niveles_accion(st, x["sym"], F)
                    x["nombre"] = g.name_of(x["sym"])
    return acciones


def anadir_acciones(st, paquete: dict) -> dict:
    """Segunda pasada: solo el bloque de acciones (y su grafico) sobre el paquete de la primera. Las cadenas de
    CBOE ya no estan tras las ~17:15 ET, asi que los indices no se recalculan."""
    acciones = leer_acciones(st, paquete["fecha"])
    paquete["acciones"] = acciones
    graficos = {}
    if acciones["estado"] == "ok":
        try:
            import social_graficos as sg
            graficos["acciones_sigma"] = sg.acciones(paquete["fecha"], acciones["mayor_sigma"])
            acciones["graficos"].append("acciones_sigma")
        except Exception as e:  # noqa: BLE001
            log(f"grafico acciones_sigma: {type(e).__name__}: {str(e)[:200]}")
    paquete["acciones_generado"] = g.now_ny().strftime("%Y-%m-%d %H:%M ET")
    return graficos


def armar(st, previo: dict | None, dibujar=True) -> tuple:
    """(paquete, {nombre: PNG}) de la ultima sesion cerrada."""
    resultados, F = {}, None
    for sym in INDICES:
        try:
            resultados[sym] = g.compute(sym, max_dte=None, window_pct=5.0, model=MODELO, positioning=POSICION)
            F = F or g.session_date(resultados[sym]["timestamp"])
        except Exception as e:  # noqa: BLE001
            log(f"{sym}: {type(e).__name__}: {str(e)[:200]}")
    if not F:
        raise SystemExit("Sin datos de ningun indice")
    prev_ind = (previo or {}).get("indices") or {}
    indices = {}
    for sym in INDICES:
        def uno(sym=sym):
            if sym not in resultados:
                raise ValueError("Sin cadena")
            p = prev_ind.get(sym) if prev_ind.get(sym, {}).get("estado") == "ok" else None
            esp = p["siguiente"]["pct"] if p and p["siguiente"].get("sesion") == F else esperado_proxy(st, sym, F)
            return bloque_indice(resultados[sym], esp, p)
        indices[sym] = _bloque(sym, uno)
    acciones = leer_acciones(st, F)

    def vix():   # cotizaciones del cierre (Tradier o CSV de CBOE) y serie diaria del CSV: no espera al historial diario
        cot = {x: ((g.fetch_quote(x, ttl=0) or {}).get("data") or {}) for x in VIX_FAMILIA}
        serie = [(h["date"], h["close"]) for h in g.daily_csv("VIX", ttl=0) if h["date"] < F]
        return bloque_vix(cot, serie)
    vixb = _bloque("vix", vix)
    mercados = _bloque("mercados", lambda: bloque_mercados(cotizaciones_cierre(), cripto_contado()))
    sig = g.next_trading_day(datetime.strptime(F, "%Y-%m-%d")).strftime("%Y-%m-%d")
    manana = _bloque("manana", lambda: bloque_manana(almacen.get_json(st, "pub/eventos.json") or [], sig))
    paquete = {"version": 1, "fecha": F, "siguiente_sesion": sig, "previa": (previo or {}).get("fecha"),
               "generado": g.now_ny().strftime("%Y-%m-%d %H:%M ET"),
               "indices": indices, "acciones": acciones, "vix": vixb, "mercados": mercados, "manana": manana}
    graficos = _dibujar(paquete, resultados) if dibujar else {}
    return paquete, graficos


def _dibujar(paq: dict, resultados: dict) -> dict:
    """Cada grafico se anota en los bloques que lo usan (campo graficos)."""
    import social_graficos as sg
    out, trabajos = {}, []
    ok = {s: b for s, b in paq["indices"].items() if b["estado"] == "ok"}
    if ok:
        trabajos.append((list(ok.values()), "indices_niveles", lambda: sg.tabla_indices(paq["fecha"], paq["siguiente_sesion"], ok)))
        trabajos.append(([paq["manana"]] if paq["manana"]["estado"] == "ok" else [], "playbook",
                         lambda: sg.playbook(paq["fecha"], paq["siguiente_sesion"], ok, paq["manana"])))
    if paq["mercados"]["estado"] == "ok":
        trabajos.append(([paq["mercados"]], "mercados", lambda: sg.mercados(paq["fecha"], paq["mercados"])))
    for s, b in ok.items():
        trabajos.append(([b], f"perfil_{s.lower()}", lambda s=s, b=b: sg.perfil(s, resultados[s], b, paq["siguiente_sesion"])))
    if paq["acciones"]["estado"] == "ok":
        trabajos.append(([paq["acciones"]], "acciones_sigma", lambda: sg.acciones(paq["fecha"], paq["acciones"]["mayor_sigma"])))
    if paq["vix"]["estado"] == "ok" and paq["vix"]["curva_previa"]:
        trabajos.append(([paq["vix"]], "vix_curva", lambda: sg.vix(paq["fecha"], paq["vix"])))
    for bloques, nombre, fn in trabajos:
        try:
            out[nombre] = fn()
            for b in bloques:
                b["graficos"].append(nombre)
        except Exception as e:  # noqa: BLE001
            log(f"grafico {nombre}: {type(e).__name__}: {str(e)[:200]}")
    return out


def publicar(st, paquete: dict, graficos: dict) -> None:
    F = paquete["fecha"]
    for nombre, png in graficos.items():
        st.put(f"{SALIDA}{F}/g/{nombre}.png", png, "image/png")
    st.put(f"{SALIDA}{F}/paquete.json", almacen.dumps(paquete), "application/json; charset=utf-8")
    st.put(f"{SALIDA}ultimo.json", almacen.dumps({"fecha": F}), "application/json; charset=utf-8")


def _leer(st, key):
    b = st.get(key)
    return json.loads(b) if b else None


def ultima_sesion_cerrada(now: datetime) -> str:
    d = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return (d if g.is_trading_day(now) and now >= g.close_time(now) else g.prev_trading_day(d)).strftime("%Y-%m-%d")


def main(args) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--forzar", action="store_true")
    a = ap.parse_args(args)
    now = g.now_ny()
    if g.is_trading_day(now) and g.close_time(now) - timedelta(hours=12) <= now < g.close_time(now) + timedelta(minutes=20):
        log(f"Mercado abierto o recien cerrado ({now:%H:%M} ET): el paquete se hace tras el cierre")
        return 0
    st = almacen.abrir()
    F = ultima_sesion_cerrada(now)
    ult = (_leer(st, f"{SALIDA}ultimo.json") or {}).get("fecha")
    previo = _leer(st, f"{SALIDA}{ult}/paquete.json") if ult else None
    if ult == F and not a.forzar:
        # primera pasada a las 16:20 ET sin acciones; la segunda, al acabar el historial diario, las anade
        if (previo.get("acciones") or {}).get("estado") == "ok" or not st.get(f"{H}_dias/{F}.json"):
            log(f"social/{F}/ ya estaba hecho" + ("" if (previo.get("acciones") or {}).get("estado") == "ok"
                                                 else " y el historial diario aun no tiene la sesion") + "; con --forzar se rehace")
            return 0
        log("Segunda pasada: el historial diario ya tiene la sesion, se anaden las acciones")
        graficos = anadir_acciones(st, previo)
        publicar(st, previo, graficos)
        b = previo["acciones"]
        log(f"acciones: {b['estado']}" + (f" motivos={b['motivos']}" if b["estado"] == "ok" else f" ({b['motivo']})"))
        return 0
    if previo and previo.get("fecha") == F:   # al rehacer, el previo es el de la sesion anterior
        previo = _leer(st, f"{SALIDA}{previo['previa']}/paquete.json") if previo.get("previa") else None
    paquete, graficos = armar(st, previo)
    if paquete["fecha"] != F:
        log(f"Aviso: las cadenas son de {paquete['fecha']}, no de {F}")
    publicar(st, paquete, graficos)
    for k in INDICES:
        b = paquete["indices"][k]
        log(f"{k}: {b['estado']}" + (f" {b['cambio_pct']}% vs {b['esperado_hoy_pct']}% implicito, {b['regimen']}, motivos={b['motivos']}" if b["estado"] == "ok" else f" ({b['motivo']})"))
    for k in ("acciones", "vix", "mercados", "manana"):
        b = paquete[k]
        log(f"{k}: {b['estado']}" + (f" motivos={b['motivos']}" if b["estado"] == "ok" else f" ({b['motivo']})"))
    log(f"{len(graficos)} graficos; social/{paquete['fecha']}/ listo")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
