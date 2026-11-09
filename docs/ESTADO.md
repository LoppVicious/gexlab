# Estado

Última revisión: 2026-11-09. Cambios hechos: ver `CHANGELOG.md`.

## Pendiente / ideas apuntadas por el usuario
- **Dealer Hedge Ratio** (en espera): COT TFF de dealers en ES y VX (en % del OI, z-score de 3 años) + pendiente de la curva del VIX.
  - Va como tarjeta en COT y alerta en Resumen.
  - Validar antes con el histórico de la CFTC desde 2010.
- **Motor SpotGamma:**
  - Superficie sticky-delta al recalcular el perfil.
  - Vol Trigger alternativo = flip con solo los vencimientos de ≤ 5 días.
  - Descartado: peso e^(−dte/20).
- **Modo flujo automático:** flujo en 0DTE y estándar en el resto.
- **Niveles del 0DTE fijados a la apertura** (opción).
- **Elegir un vencimiento concreto**, además de los filtros acumulados.
- **Modelo "OI + volumen" como gexbot**, solo para comparar.
- **Filtro "90 días"** equivalente al "full" de gexbot.
- **Utilidades estilo SpotGamma:** Risk Reversal por vencimiento, Composite View, OI y volumen por strike con cambio de OI.
- **Importador de histórico de cadenas** (ThetaData, ORATS, CBOE DataShop…).
  - Por contrato y día: fecha, raíz, vencimiento, strike, C/P, OI vigente al abrir, IV (o bid/ask), bid, ask, volumen.
  - Además, OHLC del subyacente.
  - Con eso se recalculan el Histórico y la Validación con cualquier motor.
- **Desplazamiento índice → futuro** (ES/NQ) al copiar niveles a TradingView.
