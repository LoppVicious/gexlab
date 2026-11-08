#!/usr/bin/env bash
# Despliegue en Cloudflare (lo ejecuta GitHub Actions). Idempotente.
# Un solo Worker "dashboard": web (archivos estaticos), API, y reloj del motor (cron).
# Variables: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, GH_DISPATCH_TOKEN, GEX_SETUP_CODE
set -euo pipefail
cd "$(dirname "$0")"
W="wrangler"

echo "==> Base de datos D1"
dbid() { $W d1 list --json | python3 -c "import json,sys; print(next((d['uuid'] for d in json.load(sys.stdin) if d['name']=='gexlab'), ''))"; }
DBID=$(dbid)
if [ -z "$DBID" ]; then $W d1 create gexlab >/dev/null; DBID=$(dbid); fi
[ -n "$DBID" ] || { echo "No se pudo crear la base de datos"; exit 1; }

cat > wrangler.toml <<TOML
name = "dashboard"
main = "worker.js"
compatibility_date = "2025-09-01"
workers_dev = true
preview_urls = false

[assets]
directory = "./dist"
binding = "ASSETS"
run_worker_first = true

[[d1_databases]]
binding = "DB"
database_name = "gexlab"
database_id = "$DBID"

[[r2_buckets]]
binding = "R2"
bucket_name = "gexlab"

[triggers]
crons = ["*/15 * * * *"]
TOML
$W d1 execute gexlab --remote --file schema.sql >/dev/null
echo "    tablas al dia"

echo "==> Web y API"
rm -rf dist && mkdir -p dist
cp -r ../web/. dist/
cp pages/login.html pages/setup.html dist/
cp ../gex_engine.py dist/
cp ../CHANGELOG.md dist/   # lo muestra el panel de administracion
if ! OUT=$($W deploy 2>&1); then echo "$OUT" | grep -Ei "error|subdomain|https://" ; exit 1; fi
echo "$OUT" | grep -Ei "https://" || true
printf '%s' "$GEX_SETUP_CODE" | $W secret put GEX_SETUP_CODE >/dev/null
printf '%s' "$GH_DISPATCH_TOKEN" | $W secret put GH_DISPATCH_TOKEN >/dev/null
echo "    secretos al dia; reloj cada 15 min en horario de mercado"
# la app se llamaba "gexlab": se borra el Worker antiguo para que su reloj no lance el motor dos veces
if $W deployments list --name gexlab >/dev/null 2>&1; then
  $W delete --name gexlab --force 2>&1 | grep -Ei "delet|error|success" || true
fi
