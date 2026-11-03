#!/usr/bin/env bash
# Aplica una version nueva del codigo (subida como ~/gexlab_codigo.tgz) sin tocar historial, usuarios ni listas.
set -euo pipefail
APP="$HOME/gexlab"
PKG="$HOME/gexlab_codigo.tgz"
[[ -f "$PKG" ]] || { echo "No encuentro $PKG"; exit 1; }
bash "$APP/servidor/copia.sh" || true
tar -xzf "$PKG" -C "$HOME"
rm -f "$PKG"
cd "$APP" && .venv/bin/pip install -q -r requirements.txt
chmod +x "$APP/servidor/"*.sh
sudo systemctl restart gexlab
echo "Actualizado y reiniciado."
