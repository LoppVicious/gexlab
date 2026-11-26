"""Relleno (oscuros.yml): version para el tema oscuro de los graficos ya publicados y de los Takes hechos con ellos.

Desde el 2026-11-26, report_semanal.py y flujos_diario.py dibujan cada grafico en claro (g/{nombre}.png) y en oscuro
(g/{nombre}.oscuro.png), y nube/report.js copia las dos al crear el Take. Esto completa lo anterior:
1. Cada fecha de report/ y flujos/ con paquete.json: se redibujan sus graficos desde el paquete y se guarda la version
   oscura que falte (las claras no se tocan).
2. Cada imagen de takes/ identica byte a byte a un grafico claro recibe al lado, en takes/<id>/<hex>.oscuro.png, la
   version oscura de ese grafico (la web la usa si existe).
Escribe en R2. Se puede repetir: no rehace lo que ya existe."""
import hashlib
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import almacen  # noqa: E402

SUF = ".oscuro.png"


def oscuros_de_paquete(base: str, paq: dict) -> dict:
    """{nombre: PNG oscuro} redibujando los graficos del paquete."""
    if base == "report":
        import report_semanal as rs
        out = rs._dibujar(paq["bloques"])
    else:
        import flujos_graficos as fg
        out = fg.todos(paq)
    return {k[: -len(".oscuro")]: v for k, v in out.items() if k.endswith(".oscuro")}


def main() -> int:
    st = almacen.abrir()
    sha = lambda b: hashlib.sha256(b).hexdigest()  # noqa: E731
    por_hash = {}   # sha del PNG claro -> PNG oscuro
    for base in ("report", "flujos"):
        claves = st.list(f"{base}/")
        hay = set(claves)
        fechas = sorted({k.split("/")[1] for k in claves if k.endswith("/paquete.json")})
        for F in fechas:
            claros = [k for k in claves if k.startswith(f"{base}/{F}/g/") and k.endswith(".png") and not k.endswith(SUF)]
            if not claros:
                continue
            nuevos = oscuros_de_paquete(base, almacen.get_json(st, f"{base}/{F}/paquete.json"))
            hechos = 0
            for k in claros:
                nombre = k.rsplit("/", 1)[1][:-4]
                ko = f"{base}/{F}/g/{nombre}{SUF}"
                osc = st.get(ko) if ko in hay else nuevos.get(nombre)
                if osc is None:
                    print(f"{base}/{F}: sin version oscura de {nombre}", flush=True)
                    continue
                if ko not in hay:
                    st.put(ko, osc, "image/png")
                    hechos += 1
                por_hash[sha(st.get(k))] = osc
            print(f"{base}/{F}: {len(claros)} graficos, {hechos} oscuros nuevos", flush=True)

    claves = st.list("takes/")
    hay = set(claves)
    n = ya = 0
    for k in claves:
        if not k.endswith(".png") or k.endswith(SUF):
            continue
        ko = k[:-4] + SUF
        if ko in hay:
            ya += 1
            continue
        osc = por_hash.get(sha(st.get(k)))
        if osc:
            st.put(ko, osc, "image/png")
            n += 1
    print(f"takes/: {n} imagenes con version oscura nueva, {ya} ya la tenian", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
