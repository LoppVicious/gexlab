"""Prueba en Actions (comparar.yml): de donde sacar los activos (participaciones x NAV) de los ETFs apalancados.
Imprime las primeras lineas de cada fuente para fijar el parser de report_semanal.aum_etf.
Uso: gh api -X POST repos/LoppVicious/gexlab/actions/workflows/comparar.yml/dispatches -f ref=main -f 'inputs[script]=prueba_etf_aum.py'"""
import ssl
import urllib.request

FUENTES = {
    "TQQQ": "https://accounts.profunds.com/etfdata/ByFund/TQQQ-historical_nav.csv",
    "SQQQ": "https://accounts.profunds.com/etfdata/ByFund/SQQQ-historical_nav.csv",
    "SOXL": "https://www.direxion.com/holdings/SOXL.csv",
    "TNA": "https://www.direxion.com/holdings/TNA.csv",
}

for sym, url in FUENTES.items():
    print(f"===== {sym} {url}")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=25, context=ssl.create_default_context()) as r:
            txt = r.read().decode("utf-8", "replace")
        lineas = txt.splitlines()
        print(f"{len(lineas)} lineas")
        for ln in lineas[:12]:
            print("  ", ln[:200])
    except Exception as e:  # noqa: BLE001
        print(f"ERROR {type(e).__name__}: {str(e)[:200]}")
