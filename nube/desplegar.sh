#!/usr/bin/env bash
# Despliegue en Cloudflare (lo ejecuta GitHub Actions). Idempotente.
# Variables: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, GH_DISPATCH_TOKEN, GEX_SETUP_CODE
set -euo pipefail
cd "$(dirname "$0")"
W="wrangler"

echo "==> Base de datos D1"
DBID=$($W d1 list --json | python3 -c "import json,sys; print(next((d['uuid'] for d in json.load(sys.stdin) if d['name']=='gexlab'), ''))")
if [ -z "$DBID" ]; then
  $W d1 create gexlab >/dev/null
  DBID=$($W d1 list --json | python3 -c "import json,sys; print(next((d['uuid'] for d in json.load(sys.stdin) if d['name']=='gexlab'), ''))")
fi
[ -n "$DBID" ] || { echo "No se pudo crear la base de datos"; exit 1; }

cat > wrangler.toml <<TOML
name = "gexlab"
pages_build_output_dir = "dist"
compatibility_date = "2025-09-01"

[[d1_databases]]
binding = "DB"
database_name = "gexlab"
database_id = "$DBID"

[[r2_buckets]]
binding = "R2"
bucket_name = "gexlab"
TOML
$W d1 execute gexlab --remote --file schema.sql >/dev/null
echo "    tablas al dia"

echo "==> Web"
rm -rf dist && mkdir -p dist
cp -r ../web/. dist/
cp pages/login.html pages/setup.html pages/_worker.js dist/
cp ../gex_engine.py dist/
if ! $W pages project list --json 2>/dev/null | grep -q '"gexlab"'; then
  $W pages project create gexlab --production-branch main >/dev/null
fi
printf '%s' "$GEX_SETUP_CODE" | $W pages secret put GEX_SETUP_CODE --project-name gexlab >/dev/null
printf '%s' "$GH_DISPATCH_TOKEN" | $W pages secret put GH_DISPATCH_TOKEN --project-name gexlab >/dev/null
$W pages deploy dist --project-name gexlab --branch main --commit-dirty=true 2>&1 | grep -Ei "deployment complete|https://|error" || true

echo "==> Reloj"
(cd reloj && $W deploy >/dev/null && printf '%s' "$GH_DISPATCH_TOKEN" | $W secret put GH_DISPATCH_TOKEN >/dev/null)
echo "    cada 15 min en horario de mercado"
$W pages project list --json 2>/dev/null | python3 -c "import json,sys; [print('==> Direccion: https://' + (p.get('Project Domains') or p.get('domains') or ['?'])[0] if isinstance(p.get('Project Domains') or p.get('domains'), list) else '==> ' + str(p)) for p in json.load(sys.stdin) if 'gexlab' in json.dumps(p)]" || true
