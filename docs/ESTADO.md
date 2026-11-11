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
- **Rejilla de strikes por ticker** (p. ej. SPX de 25, NDX de 50-100, SPY y QQQ de 1-5, IWM de 1). Probada el
  2026-11-09 y retirada: los niveles se calculan sobre las barras dibujadas, y al agrupar strikes se movían (Call Wall
  del NDX 27790 → 27400 con 100, del SPY 746 → 765 con 5; flip del SPX 7680 → 7590 con 25). Los strikes intermedios
  llevan entre el 10 y el 35% del OI cercano: hay que sumarlos, no descartarlos. Para retomarla: calcular los niveles con
  los strikes reales y usar la rejilla solo para dibujar.
- **Modelo "OI + volumen" como gexbot**, solo para comparar.
- **Filtro "90 días"** equivalente al "full" de gexbot.
- **Utilidades estilo SpotGamma:** Risk Reversal por vencimiento, Composite View. (Open Interest, Risk Engine y la
  calculadora ya están: `web/oi.js`, `web/riesgo.js`, `web/calculadora.js`.)
- **Importador de histórico de cadenas** (ThetaData, ORATS, CBOE DataShop…).
  - Por contrato y día: fecha, raíz, vencimiento, strike, C/P, OI vigente al abrir, IV (o bid/ask), bid, ask, volumen.
  - Además, OHLC del subyacente.
  - Con eso se recalculan el Histórico y la Validación con cualquier motor.
- **Desplazamiento índice → futuro** (ES/NQ) al copiar niveles a TradingView.
