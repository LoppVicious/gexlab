"""Prueba en Actions: la API de BLS (v2, sin clave si no hay BLS_API_KEY) responde a Python y las series dan lo esperado.
Imprime las dos ultimas observaciones de cada serie."""
import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import gex_engine as g  # noqa: E402

SERIES = {
    "CUSR0000SA0": "CPI SA (indice)", "CUSR0000SA0L1E": "CPI subyacente SA", "CUUR0000SA0": "CPI NSA (para y/y)",
    "CUUR0000SA0L1E": "CPI subyacente NSA", "CES0000000001": "Nominas no agricolas (miles)",
    "LNS14000000": "Tasa de paro", "CES0500000003": "Salario por hora", "WPSFD4": "PPI demanda final SA",
    "WPSFD49104": "PPI demanda final sin alimentos, energia ni comercio SA", "WPSFD49116": "PPI sin alimentos ni energia SA",
    "JTS000000000000000JOL": "JOLTS vacantes (miles)",
}
body = {"seriesid": list(SERIES), "latest": False, "startyear": "2026", "endyear": "2026"}
if os.environ.get("BLS_API_KEY"):
    body["registrationkey"] = os.environ["BLS_API_KEY"]
req = urllib.request.Request("https://api.bls.gov/publicAPI/v2/timeseries/data/", data=json.dumps(body).encode(),
                             headers={"Content-Type": "application/json"})
with urllib.request.urlopen(req, timeout=30, context=g._SSL_CTXS[0]) as r:
    d = json.loads(r.read().decode())
print(d.get("status"), d.get("message"))
for s in (d.get("Results") or {}).get("series", []):
    obs = s.get("data") or []
    txt = ", ".join(f"{o['year']}-{o['period']}={o['value']}" for o in obs[:3])
    print(f"{s['seriesID']:24} {SERIES.get(s['seriesID'], ''):52} {txt}")
