"""Ejecuta cripto.py de principio a fin desde Actions con un almacen local del runner (sin R2).

Uso: comparar.yml con inputs[script]=cripto_actions.py. Comprueba que todas las fuentes responden desde una IP de
EE. UU. y muestra el resumen de la lectura.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["GEX_ALMACEN"] = "local:./_cripto_prueba"
import cripto  # noqa: E402

sys.exit(cripto.main())
