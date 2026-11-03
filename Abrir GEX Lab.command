#!/bin/bash
# GEX Lab - lanzador para macOS (doble clic)
cd "$(dirname "$0")" || exit 1

if ! command -v python3 >/dev/null 2>&1; then
  echo "No se encuentra Python 3. Instálalo desde https://www.python.org/downloads/ y vuelve a abrir este archivo."
  read -r -p "Pulsa Enter para cerrar..."
  exit 1
fi

if [ ! -d ".venv" ]; then
  echo "Primera ejecución: preparando el entorno (solo esta vez)..."
  python3 -m venv .venv || { echo "No se pudo crear el entorno."; read -r -p "Enter para cerrar..."; exit 1; }
  ./.venv/bin/python -m pip install --quiet --upgrade pip
  ./.venv/bin/python -m pip install --quiet -r requirements.txt || { echo "No se pudo instalar numpy."; read -r -p "Enter para cerrar..."; exit 1; }
fi

# comprueba dependencias en cada arranque (instantaneo si ya estan)
./.venv/bin/python -c "import numpy, certifi" 2>/dev/null || ./.venv/bin/python -m pip install --quiet -r requirements.txt

./.venv/bin/python server.py
