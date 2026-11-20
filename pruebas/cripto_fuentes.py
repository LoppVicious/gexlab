"""Prueba desde Actions (IP de EE. UU.) que las fuentes de la seccion Crypto responden.

Uso: comparar.yml con inputs[script]=cripto_fuentes.py. Sin claves.
"""
import json
import urllib.request

UA = {"User-Agent": "gexlab-prueba/1.0"}
URLS = {
    "deribit_opciones": "https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option",
    "deribit_futuros": "https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=future",
    "deribit_dvol": "https://www.deribit.com/api/v2/public/get_index_price?index_name=btcdvol_usdc",
    "okx_funding": "https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP",
    "okx_oi": "https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=BTC-USDT-SWAP",
    "okx_lsr": "https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=BTC&period=1H",
    "bybit_ticker": "https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT",
    "binance_fut": "https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT",
    "coinbase": "https://api.exchange.coinbase.com/products/BTC-USD/ticker",
    "kraken": "https://api.kraken.com/0/public/Ticker?pair=XBTUSD",
    "coingecko": "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd",
    "coinmetrics": "https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=CapMVRVCur,FlowInExUSD&page_size=1&paging_from=end",
    "bitcoin_data": "https://bitcoin-data.com/v1/sth-realized-price/last",
    "defillama": "https://stablecoins.llama.fi/stablecoins?includePrices=false",
    "mempool": "https://mempool.space/api/v1/fees/recommended",
    "feargreed": "https://api.alternative.me/fng/?limit=1",
}

for nombre, url in URLS.items():
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20) as r:
            cuerpo = r.read()
            print(f"OK   {nombre:18} {r.status} {len(cuerpo):>9} B  {cuerpo[:140]!r}")
    except Exception as e:  # noqa: BLE001
        extra = ""
        if hasattr(e, "read"):
            try:
                extra = e.read()[:160]
            except Exception:  # noqa: BLE001
                pass
        print(f"FALLA {nombre:18} {e} {extra!r}")
print(json.dumps({"fin": True}))
