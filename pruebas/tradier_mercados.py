"""Prueba (prueba_tradier.yml, inputs[script]=tradier_mercados.py): cotizaciones de los mercados cruzados del social
diario con Tradier en una peticion y el bloque que se arma con ellas. Solo imprime precios publicos."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import fuente_tradier as ft  # noqa: E402
import social_diario as sd  # noqa: E402

simbolos = [s for lista in sd.MERCADOS.values() for s, _, _ in lista] + list(sd.SECTORES) + sd.AMPLITUD
cot = ft.cotizaciones(simbolos)
print(f"{len(cot)}/{len(simbolos)} simbolos; faltan: {sorted(set(simbolos) - set(cot))}")
for s in simbolos:
    if s in cot:
        print(s, cot[s])
m = sd.bloque_mercados(cot, sd.cripto_contado())
print(json.dumps({k: m[k] for k in ("amplitud", "grandes", "motivos")}, indent=1))
print(json.dumps(m["grupos"], indent=1))
