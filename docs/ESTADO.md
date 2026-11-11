# Estado

Última revisión: 2026-11-11. Cambios hechos: ver `CHANGELOG.md`.

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
- **Utilidades estilo SpotGamma:** Risk Reversal por vencimiento, Composite View. (Open Interest y Options Lab ya están:
  `web/oi.js`, `web/lab.js`.)
- **Importador de histórico de cadenas** (ThetaData, ORATS, CBOE DataShop…).
  - Por contrato y día: fecha, raíz, vencimiento, strike, C/P, OI vigente al abrir, IV (o bid/ask), bid, ask, volumen.
  - Además, OHLC del subyacente.
  - Con eso se recalculan el Histórico y la Validación con cualquier motor.
- **Desplazamiento índice → futuro** (ES/NQ) al copiar niveles a TradingView.

## Propuestas de la revisión de material cuantitativo (2026-11-11)
Por orden de prioridad.

1. **Calidad de datos** (hecho el 2026-11-11):
   - Raíces ajustadas: filtradas en `parse_chain` (`standard_roots`). Había HON2 (47 % del OI de HON), BABA2 (10 %),
     PANW1, WDC1, CVX1, BA1, B1SPY/B1IWM/B1VDA/B1SLA y SPXO.
   - Medido con CBOE en 20 tickers: los contratos sin bid, con spread > 50 % o sin IV pesan menos del 3 % de la gamma
     (salvo HON, por HON2). Las IV infladas de las alas 0DTE al final de la sesión (cotizaciones de 0,00/0,01) vienen
     igual de CBOE; repararlas movía algún muro casi empatado, pero nos alejaría de las referencias. No se tocan.
   - Convención de T: coherente (la IV y la gamma usan la misma varianza total). En Perfil, el mínimo de 1 h de T
     rebaja la gamma 0DTE en la última hora; es deliberado (copia el script de SpotGamma) y Auto usa Neto en 0DTE.
2. **Validación más rigurosa** (hecho el 2026-11-11): referencia por distancia para los muros, rango frente al normal
   del ticker, pruebas agrupadas por día con mínimo de 20 días, días con evento aparte. Pendiente:
   - IC de rango a 2 y 5 días y VRP sin días de evento, cuando haya historial (empezó el 2026-11-04).
   - Semáforo de Basilea sobre un rango de 2σ (hoy solo se guarda el de 1σ).
   - No aplica todavía: walk-forward (la Validación no ajusta umbrales).
3. **Posicionamiento** (hecho el 2026-11-11, panel lateral del Equity Hub y columna del Escáner): cobertura por 1 %
   en % del ADV$ con impacto por la raíz cuadrada (AAPL 7,2 % y ≈45 pb; NVDA 0,7 % y ≈27 pb), vanna y charm en % del
   ADV, GEX tras el próximo vencimiento, gamma por tramo (0-1, 2-7, 8-30, >30 días) y matriz precio × IV de GEX por
   1 % y de flujo de cobertura.
   - El flujo de la matriz es el cambio de delta en acciones por el precio; la DEX en $ no sirve (también cambia por
     revalorizar la delta que ya se tiene).
   - Sin dato en índices (SPX, NDX, RUT): se cubren sobre todo con futuros. Pendiente si hiciera falta: volumen de ES/NQ.
   - Charm acumulado hasta OPEX: no hecho (el charm no es lineal en el tiempo; la matriz y el charm diario bastan).
4. **Superficie de volatilidad** (hecho el 2026-11-11, en el Volatility dashboard): IV30 sin modelo (SPX 17,50
   frente a VIX 17,49), RR25 y BF25 por vencimiento, estructura e inversión, evento descontado del codo de la curva
   (NVDA ±9,8 % antes de resultados), Yang-Zhang y cono de un año. La curva VIX9D-VIX1Y ya estaba (VIX curve).
   - Yang-Zhang apenas cuenta un día que abre en máximos y cierra en mínimos (SPX el 2026-11-05: −4,45 %, YZ20 14,6 %
     frente a 22,1 % de cierre a cierre); por eso la prima de varianza va contra la de cierre a cierre.
   - Pendiente: vida media de la IV (Ornstein-Uhlenbeck), poco útil; el Compass sigue con `_realized_vol`.
   - Las copias locales de la cadena (`cache/`) pueden dar la sesión anterior a saltos; en producción (R2) salen bien.
5. **Correlación implícita** (SPX frente a megacaps) como indicador de régimen. Requiere cadenas de las megacaps.
6. **Flujo:** BVC sobre el volumen incremental de 5 min, prima y delta firmadas acumuladas, UOA ponderado por delta,
   vega y $. Mostrar siempre como estimación.

Descartado o prioridad baja: dependencia en cola y cópulas (pocos datos), HMM, tarjetas macro (spreads HY, curva),
construcción de carteras, ejecución y dimensionado.
