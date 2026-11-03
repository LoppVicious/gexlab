#!/usr/bin/env bash
# GEX Lab - instalacion en un servidor Ubuntu (Oracle Cloud Always Free).
# Uso:  bash ~/gexlab/servidor/instalar.sh tu-subdominio.duckdns.org [token-duckdns]
# Se puede volver a ejecutar sin problema: actualiza lo que haga falta y conserva los datos.
set -euo pipefail

DOMAIN="${1:-}"
DUCK_TOKEN="${2:-}"
APP="$HOME/gexlab"
PORT=8765

if [[ -z "$DOMAIN" ]]; then
  echo "Uso: bash $APP/servidor/instalar.sh tu-subdominio.duckdns.org [token-duckdns]"; exit 1
fi
if [[ ! -f "$APP/server.py" ]]; then
  echo "No encuentro $APP/server.py. Descomprime antes la app en $APP."; exit 1
fi
echo "==> GEX Lab en $DOMAIN"

echo "==> Paquetes del sistema"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3-venv python3-pip caddy curl iptables-persistent >/dev/null

# memoria de intercambio en maquinas pequenas (E2.1.Micro tiene 1 GB)
if [[ $(free -m | awk '/Mem:/ {print $2}') -lt 3000 && ! -f /swapfile ]]; then
  echo "==> Memoria de intercambio de 2 GB"
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "==> Cortafuegos del sistema: puertos 80 y 443"
for p in 80 443; do
  sudo iptables -C INPUT -p tcp --dport $p -m state --state NEW -j ACCEPT 2>/dev/null || \
    sudo iptables -I INPUT 1 -p tcp --dport $p -m state --state NEW -j ACCEPT
done
sudo netfilter-persistent save >/dev/null 2>&1 || true

echo "==> Entorno de Python"
cd "$APP"
[[ -d .venv ]] || python3 -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r requirements.txt
mkdir -p data history cache backups
chmod 700 data

echo "==> Servicio de la app (arranca solo y se reinicia si falla)"
sudo tee /etc/systemd/system/gexlab.service >/dev/null <<UNIT
[Unit]
Description=GEX Lab
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
WorkingDirectory=$APP
Environment=GEX_AUTH=1
Environment=GEX_SECURE=1
Environment=GEX_PORT=$PORT
Environment=PYTHONUNBUFFERED=1
ExecStart=$APP/.venv/bin/python $APP/server.py --server
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now gexlab >/dev/null
sudo systemctl restart gexlab

echo "==> HTTPS con Caddy (certificado gratuito automatico)"
sudo tee /etc/caddy/Caddyfile >/dev/null <<CADDY
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT
	header {
		Strict-Transport-Security "max-age=31536000"
		-Server
	}
}
CADDY
sudo systemctl enable caddy >/dev/null
sudo systemctl reload caddy || sudo systemctl restart caddy

echo "==> Tareas programadas: recolector cada 30 min, copia diaria del historial"
TMP=$(mktemp)
crontab -l 2>/dev/null | grep -v -e 'gexlab' > "$TMP" || true
cat >> "$TMP" <<CRON
# gexlab: recolector (decide solo si toca segun la hora de Nueva York)
*/30 * * * * cd $APP && GEX_AUTH=1 .venv/bin/python recolector.py >> history/cron.log 2>&1
@reboot sleep 60 && cd $APP && GEX_AUTH=1 .venv/bin/python recolector.py >> history/cron.log 2>&1
# gexlab: copia diaria de historial y usuarios (se guardan 14)
15 6 * * * bash $APP/servidor/copia.sh >> $APP/backups/copia.log 2>&1
CRON
if [[ -n "$DUCK_TOKEN" ]]; then
  SUB="${DOMAIN%%.duckdns.org}"
  echo "# gexlab: mantiene la IP en DuckDNS" >> "$TMP"
  echo "*/15 * * * * curl -s 'https://www.duckdns.org/update?domains=$SUB&token=$DUCK_TOKEN&ip=' >/dev/null" >> "$TMP"
fi
crontab "$TMP"; rm -f "$TMP"
chmod +x "$APP/servidor/"*.sh

sleep 3
if curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/login.html" | grep -q 200; then
  echo "==> La app responde."
else
  echo "!! La app no responde todavia. Revisa:  sudo journalctl -u gexlab -n 50"
fi
echo
echo "Listo. Ahora crea los usuarios:"
echo "   cd $APP && GEX_AUTH=1 .venv/bin/python usuarios.py crear tu_usuario"
echo "y abre  https://$DOMAIN  (el certificado puede tardar 1 minuto la primera vez)."
