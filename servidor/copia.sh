#!/usr/bin/env bash
# Copia comprimida del historial, los usuarios y sus listas. Se conservan las 14 mas recientes.
set -euo pipefail
APP="$HOME/gexlab"
mkdir -p "$APP/backups"
F="$APP/backups/gexlab_$(date +%Y-%m-%d).tgz"
tar -czf "$F" -C "$APP" history data watchlist.json 2>/dev/null || tar -czf "$F" -C "$APP" history data
ls -1t "$APP"/backups/gexlab_*.tgz | tail -n +15 | xargs -r rm -f
echo "$(date '+%F %T') copia $F ($(du -h "$F" | cut -f1))"
