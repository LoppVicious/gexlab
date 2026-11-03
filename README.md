# GEX Lab

Dashboard local de exposición gamma (GEX) para cualquier índice, ETF o acción con opciones en CBOE. Gratis, sin claves ni cuentas.

## Abrir

**Mac:** doble clic en `Abrir GEX Lab.command`.
La primera vez macOS puede bloquearlo por venir de internet: clic derecho sobre el archivo, "Abrir", y confirma. Solo hace falta una vez.

**Windows:** doble clic en `Abrir GEX Lab.bat`.

Requisito único: Python 3.10 o superior (python.org). La primera apertura tarda unos segundos porque instala numpy en un entorno propio dentro de la carpeta; las siguientes son inmediatas.

Se abre el navegador en `http://127.0.0.1:8765`. Para cerrar la app, cierra la ventana de terminal.

## Uso

- **Resumen:** una pantalla para antes de la apertura: régimen, niveles con su distancia al precio y movimiento esperado de SPX, NDX y RUT; forma de la curva VIX; extremos del COT, y cuándo abre o cierra el mercado en tu hora. Clic en una tarjeta para abrir su detalle.
- Escribe un ticker o el nombre de la empresa (por ejemplo `nvidia` o `berkshire`) y elige en el desplegable. Funciona con índices (`SPX`, `NDX`, `RUT`, `XSP`), ETF y unas 5.000 acciones con opciones listadas. Con el campo vacío ves los recientes. Atajo: tecla `/`.
- **Vencimientos:** 0DTE (el más cercano), ≤ 7 días, ≤ 45 días (por defecto) o todos.
- **Rango:** ventana de strikes alrededor del spot.
- **Spot manual:** para el pre-market de índices, escribe el nivel implícito por futuros (por ejemplo, ES ajustado por la base) y los niveles se recalculan con ese spot.
- **Perfil:** GEX total recalculada en cada nivel hipotético del subyacente; el cruce por cero es el Gamma Flip.
- **Barras:** *Neta* (GEX neta por strike), *Calls y puts* (en espejo) o *Vencimiento* (el vencimiento más próximo en tono claro, apilado sobre el resto).
- **Rango 1σ:** banda sombreada con el rango de 1 desviación típica (68,3%) de la próxima sesión, implícito en las opciones; el panel muestra también el de 5 sesiones (como los Implied 1-Day y 5-Day Move de SpotGamma, aunque los suyos se ajustan además con datos históricos). El precio del straddle ATM, que mide el movimiento medio (≈ 0,8σ), queda en la ayuda del dato.
- **Vol Trigger / Hedge Wall:** en índices y sus ETF el nivel se llama Volatility Trigger; en acciones, Hedge Wall, que es como lo llama SpotGamma. Es el mismo cálculo.
- **Zona de transición:** a menos de un 0,5% del Gamma Flip la app no atribuye un efecto claro a los dealers; el régimen pesa cuando el precio está claramente por encima o por debajo.
- **Cambios diarios:** cada cálculo guarda una foto de los niveles en la carpeta `history`. Desde la segunda sesión verás bajo cada nivel su valor anterior y la variación.
- **Mapa** (estilo TRACE): eje vertical el precio, horizontal la hora de la sesión; el color es la GEX total si el precio estuviera en ese nivel a esa hora. Muestra cómo la gamma 0DTE se intensifica hacia el cierre. A la izquierda, GEX por strike; encima, la línea de precio intradía y los niveles (botón *Niveles*). Con velas de 5 minutos. Antes del cierre muestra la sesión de hoy; con el mercado cerrado, la última sesión (selector *Última sesión / Próxima*). Durante cada sesión la app guarda una copia de la cadena en `history/chains` para que las repeticiones incluyan los contratos que vencen ese día (CBOE los borra al vencer). Límite: usa el open interest del cierre anterior, así que no recoge el flujo nuevo del día.
- **Compass** (en el escáner): cada ticker en un mapa de cuadrantes. Eje vertical, IV rank (volatilidad cara o barata); eje horizontal, risk reversal rank 25Δ (sesgo hacia calls o puts). Los ranks usan el histórico propio del ticker cuando hay 60 sesiones guardadas (el IV rank de los tickers con índice de volatilidad de CBOE usa ese índice desde el primer día); hasta entonces son provisionales frente al resto de la lista (IV frente a volatilidad realizada, y risk reversal relativo a la IV) y se dibujan como círculos huecos.
- **Escáner:** tabla con tu lista de tickers (régimen, flip, walls, GEX, movimiento esperado y peso del próximo vencimiento). Ordena con clic en la cabecera, añade o quita tickers y haz clic en una fila para abrir su análisis.
- **Dealers: Estándar / Flujo (beta).** *Estándar* asume dealers largos de calls y cortos de puts. *Flujo* estima su posición contrato a contrato: parte de la convención estándar y cada noche atribuye el cambio de open interest al lado de la última operación del día (cerca del ask, el cliente compró, así que los dealers quedan cortos de esa opción; cerca del bid, al revés). Suma además el 50% del volumen clasificado de hoy. Necesita al menos 2 sesiones guardadas del ticker y mejora con los días; si faltan días entre dos sesiones guardadas, ese tramo usa la convención estándar. Es una aproximación con datos públicos, no el flujo completo.
- **+ SPY / + QQQ / + IWM:** en SPX, NDX y RUT suma las opciones del ETF convertidas a unidades del índice (strike × ratio, OI ÷ ratio), como los niveles combo.
- **Gamma / Vanna / Charm** (vista por strike): vanna = compras (+) o ventas (−) de cobertura de los dealers si la volatilidad implícita cae 1 punto; charm = compras o ventas de cobertura por el paso de un día. El panel muestra el total de ambas.
- **Auto 5 min:** recalcula cada 5 minutos y avisa (en la app y con notificación del sistema si la permites) cuando el precio cruza el Put Wall, el VT, el Gamma Flip o el Call Wall.
- **Informe:** una sola imagen con el resumen de niveles y cifras, el gráfico por strike y el mapa.
- **Validación** (en el escáner): para tu lista, compara los niveles conocidos antes de cada sesión con su máximo, mínimo y cierre reales: rango medio en gamma positiva frente a negativa, % de sesiones en que se respetaron los walls y % de cierres dentro del rango 1σ de la sesión. Usa la foto ex ante de esa sesión (calculada antes de la apertura, con el open interest nuevo) o, si no la hay, la última de la sesión anterior; nunca niveles calculados durante la propia sesión, que ya conocen el precio. Se llena con el uso.
- **Exportar PNG:** imagen 3000 × 1020 lista para publicar.
- **Curva VIX:** curva de futuros del VIX con los cierres oficiales de CBOE, comparada con la de hace una semana y un mes, y los índices VIX9D, VIX, VIX3M, VIX6M y VIX1Y en directo. Clasifica la forma (contango, backwardation, invertida en el tramo corto, joroba o plana) con el VIX al contado, el primer y el segundo vencimiento; un tramo con menos del 0,5% de diferencia cuenta como plano, para que la etiqueta no cambie por céntimos. Muestra la pendiente M2/M1 y su percentil del último año, la prima del M1 sobre el VIX, el futuro sintético a 30 días, el ratio VIX/VIX3M y la historia diaria del contango. Los contratos vencidos se guardan en `cache/vx`; los vivos se actualizan cuando CBOE publica un cierre nuevo.
- **COT:** informe semanal Traders in Financial Futures de la CFTC (solo futuros) para S&P 500, Nasdaq 100, Russell 2000, Dow, VIX y los bonos del Tesoro a 2, 5 y 10 años, Ultra 10, T-Bond y Ultra T-Bond. Para gestoras, fondos apalancados y dealers: posición neta, cambio semanal e índice COT (dónde está la neta dentro de su rango de 3 años o de 1 año; extremos por encima de 90 o por debajo de 10). Clic en un mercado para ver su historia con el precio de referencia. Se actualiza solo tras la publicación del viernes (15:30 ET).

## Recolector diario

Para que el modelo de flujo, el Compass y la validación acumulen datos aunque no abras la app:

1. Doble clic en `Instalar recolector.bat` (una sola vez). Registra dos tareas en el Programador de tareas de Windows y hace una primera recogida.
2. Los tickers son los de la lista del escáner (se guardan en `watchlist.json`); añade o quita desde el escáner.

Cómo funciona:
- **Cada 30 min con el PC encendido** el recolector comprueba la hora de Nueva York y solo actúa cuando toca: una recogida antes de la apertura (08:30–09:45 ET, con el open interest nuevo: son los niveles ex ante que usa la validación), otra en la última media hora de la sesión (con el 0DTE aún vivo, para poder repetir el mapa) y otra 15 min después del cierre (volúmenes finales). Respeta festivos, cierres anticipados y los cambios de hora de ambos lados.
- **Al iniciar sesión** recupera la sesión pendiente si el PC estuvo apagado. Los niveles se recuperan hasta la apertura siguiente; el flujo por contrato, solo hasta las 04:00 ET del día siguiente (después CBOE puede publicar el open interest nuevo y se mezclarían dos días; ese tramo usa la convención estándar). La copia de la cadena con el 0DTE no se recupera.
- **A las 22:40** una segunda tarea despierta el PC si está en suspensión (requiere que Windows tenga activados los temporizadores de activación).
- Guarda niveles en los dos modos, flujo por contrato, volatilidad y copia de la cadena. Registro en `history/recolector.log`; su estado se ve en el escáner.
- Espacio: los archivos grandes se comprimen y rotan (flujo 8 sesiones, cadenas 10); los niveles y la volatilidad se guardan 3 años. Con 12 tickers son unos 15–20 MB estables más ~5 MB al año. Los datos pesados de los tickers que quites se borran a los 30 días.
- Para quitarlo: `Desinstalar recolector.bat` (los datos se conservan).

Historial que necesita cada parte: niveles, mapa, movimiento esperado, vanna y charm, ninguno; cambios diarios, 2 sesiones; modelo de flujo, ~2 semanas; Compass, 60 sesiones para el risk reversal (el IV rank de SPX, SPY, NDX, QQQ, DJX, DIA, AAPL, AMZN, GOOGL, GS, IBM, EEM y GLD usa desde el primer día un año de VIX, VXN, VXD, VXAPL, VXAZN, VXGOG, VXGS, VXIBM, VXEEM y GVZ); validación, ~3 meses indicativa y 1 año sólida.

## Servidor privado (acceso desde el móvil)

La app puede publicarse en un servidor propio con inicio de sesión. Cada usuario tiene su lista de seguimiento y sus ajustes; el historial es común y el recolector recoge la unión de todas las listas.

- `auth.py` y `usuarios.py`: usuarios, contraseñas (PBKDF2, nunca en texto plano), sesiones de 30 días y bloqueo tras 5 intentos fallidos. Solo se activa con `GEX_AUTH=1`; en el PC todo sigue igual, sin contraseña.
- Carpeta `servidor/`:
  - `servidor.txt`: IP, clave SSH, dominio y token de DuckDNS.
  - `1 Instalar en el servidor.bat`: sube la app con tu historial y ejecuta `instalar.sh` (Python, servicio, HTTPS con Caddy, cortafuegos, recolector cada 30 min, copia diaria).
  - `2 Crear usuario.bat` y `Usuarios del servidor.bat`: altas, cambios de contraseña, bajas.
  - `3 Actualizar servidor.bat`: sube solo el código; el historial y los usuarios del servidor no se tocan.
  - `4 Descargar copia del servidor.bat`: trae a `D:\Claude\gexlab_copias` la última copia del historial y los usuarios.

## Metodología

- **Datos:** CBOE delayed quotes (~15 min de retraso). El open interest es el del cierre anterior.
- **Volatilidad implícita:** en cada strike se usa la IV de la opción fuera de dinero para la call y la put (paridad put-call); las IV de opciones dentro de dinero salen de horquillas anchas y son ruido.
- **Tiempo:** la IV de CBOE está en días naturales y se valora en el momento de la cotización (ahora con el mercado abierto; el último cierre si está cerrado). La varianza restante (σ²·T) solo se consume en horas de mercado (lunes a viernes, 09:30–16:00 ET), así que fines de semana y noches no reducen la gamma y, dentro del día, la gamma del vencimiento se intensifica de forma realista hacia el cierre. Liquidación AM a las 09:30 para SPX, NDX, RUT, VIX y VIXW mensuales; el resto a las 16:00. Usa el calendario oficial de la NYSE 2026–2028 (festivos y cierres anticipados a las 13:00; hay que ampliarlo en `NYSE_HOLIDAYS` cuando se publique 2029). Validado contra la gamma que publica CBOE por contrato (SPX, 2 a 60 días, ±3% del spot): sin sesgo (desviación media −0,1%) y diferencia típica del 2% por contrato.
- **Gamma, vanna y charm:** Black-Scholes sin dividendos (el efecto es despreciable) sobre la varianza total restante. Tipo sin riesgo: la letra del Tesoro a 13 semanas (índice IRX de CBOE, tipo de descuento pasado a continuo), actualizada cada 6 horas; si no se puede leer, 4%. Vanna y charm verificadas contra derivadas numéricas. El charm de los contratos que vencen en menos de un día es el cambio real de delta hasta el vencimiento, no la tasa instantánea extrapolada a 24 horas.
- **GEX por strike:** Γ × OI × 100 × S, calls con signo + y puts con signo − (dealers largos de calls, cortos de puts). Unidad: $ de delta por $1 de movimiento. Cada strike cae exactamente en su barra.
- **GEX neta por 1%:** Γ × OI × 100 × S² × 0,01.
- **Gamma Flip:** cruce por cero del perfil (GEX total recalculada en cada precio hipotético, IV fija por strike) más cercano al spot.
- **Call Wall / Put Wall:** strike con mayor GEX neta positiva por encima del spot / negativa por debajo (si un lado no tiene barras de ese signo, gamma de calls o puts sola). Se buscan en ±10%.
- **Volatility Trigger:** aproximación propia, no el nivel de SpotGamma: el strike más alto por debajo del flip con gamma neta negativa de al menos el 25% del máximo absoluto.
- **Rango 1σ (1 y 5 sesiones):** para cada vencimiento, varianza total ATM (IV interpolada al spot × tiempo natural); se interpola en minutos de mercado hasta 390 (1 sesión) y 1.950 (5 sesiones) y 1σ = S·√w. Incluye el riesgo de fines de semana y festivos que el mercado ya pone en precio. Con el mercado abierto, la sesión de hoy cuenta solo por el tiempo que le queda (la banda se estrecha hacia el cierre). La validación mide el % de cierres dentro del rango de 1 sesión (68,3% en teoría).
- **Straddle ATM:** precio del straddle del vencimiento más próximo, interpolado entre los dos strikes que rodean al spot y descontando el valor intrínseco (movimiento absoluto medio, ≈ 0,8σ).
- **Variación diaria:** la que publica CBOE (fuera de horario su "cierre anterior" coincide con el de hoy).
- **Pre-market de índices:** entre las 04:00 y las 09:30 ET, el spot de SPX, NDX, RUT y DJX se estima con su ETF (SPY, QQQ, IWM, DIA): cierre del índice × precio actual del ETF / cierre del ETF. Fuera de esa franja se muestra como referencia.
- **Histórico:** las fotos diarias se guardan con la fecha de la última sesión que ha abierto (fines de semana, madrugadas y pre-market cuentan como la sesión anterior). Lo calculado en el pre-market y en los primeros 15 minutos se guarda además como foto ex ante de la sesión que empieza.

Los niveles son estimaciones basadas en supuestos sobre el posicionamiento de los dealers, no su libro real. Úsalos como contexto de régimen.

## Archivos

- `server.py`: servidor local.
- `gex_engine.py`: descarga y cálculo. Constantes ajustables al inicio (tipo de interés, caché).
- `recolector.py`: recogida diaria automática (ver arriba).
- `auth.py`, `usuarios.py`, `servidor/`: versión publicada con usuarios (ver arriba).
- `macro.py`: curva de futuros del VIX y COT.
- `watchlist.json`: lista de seguimiento compartida.
- `history/`: datos guardados.
- `web/`: interfaz.
