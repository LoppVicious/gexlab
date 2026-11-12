"""Prueba en Actions: cuanto tarda FRED en tener el dato real tras cada publicacion.
Para cada serie: ultima actualizacion (last_updated), ultima observacion y desde cuando vale (realtime_start)."""
import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import gex_engine as g  # noqa: E402

KEY = os.environ.get("FRED_API_KEY")
SERIES = ["CPIAUCSL", "CPILFESL", "PAYEMS", "UNRATE", "CES0500000003", "PPIFIS", "PPIFES", "RSAFS", "RSFSXMV",
          "PCEPILFE", "PCEPI", "ICSA", "JTSJOL", "A191RL1Q225SBEA", "DGORDER", "ADXTNO", "HOUST", "PERMIT",
          "HSN1F", "EXHOSLUSM495S", "UMCSENT"]


def get(path: str) -> dict:
    url = f"https://api.stlouisfed.org/fred/{path}&api_key={KEY}&file_type=json"
    with urllib.request.urlopen(url, timeout=25, context=g._SSL_CTXS[0]) as r:
        return json.loads(r.read().decode())


if not KEY:
    sys.exit("sin FRED_API_KEY")
for s in SERIES:
    try:
        info = get(f"series?series_id={s}")["seriess"][0]
        obs = get(f"series/observations?series_id={s}&sort_order=desc&limit=2")["observations"]
        print(f"{s:16} updated {info['last_updated']:24} last {obs[0]['date']} = {obs[0]['value']:>10} "
              f"(desde {obs[0]['realtime_start']}), antes {obs[1]['value']}")
    except Exception as e:  # noqa: BLE001
        print(f"{s:16} {type(e).__name__}: {str(e)[:80]}")
