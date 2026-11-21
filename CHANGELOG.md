# Registro de cambios

Una entrada por día, la más reciente arriba: fecha, título y qué cambia para el usuario (**Añadido**, **Cambiado**,
**Corregido**). Cada push de ese día amplía la entrada del día. Los detalles técnicos están en los commits.

## 2026-11-21 — Crypto: señales con su historia, mineros y on-chain; régimen de volatilidad sin mezclar sesiones; datos sin la API de cotizaciones de CBOE

**Añadido**
- **Crypto, señales con su historia:** diez señales de BTC y ETH (MVRV por debajo de 1 o por encima de 3, precio que
  recupera o pierde el coste de los holders recientes, compra de hash ribbons, Puell bajo 0,5, SOPR de corto plazo que
  vuelve a 1, miedo y codicia extremos, pico de volatilidad implícita) con sus casos desde 2012, 2015, 2018 o 2022 y qué
  hizo el precio 30 y 90 días después frente a cualquier día del mismo periodo. Las activas o de los últimos 30 días
  entran en la lectura con su historia, aunque contradigan la lectura habitual.
- **Crypto, mineros:** hashrate (medias de 30 y 60 días, estado de los hash ribbons) y múltiplo de Puell, solo BTC.
- **Crypto, beneficio de los vendedores:** SOPR y SOPR de los holders de corto plazo (media de 7 días), solo BTC.
- **Crypto, actividad de la red y stablecoins:** direcciones activas frente a su media anual (BTC y ETH) y oferta de
  stablecoins con las cinco mayores y sus cambios a 7 y 30 días.
- **Crypto, percentiles:** MVRV, Puell, direcciones, SOPR, DVOL y Fear & Greed frente a su historia. Desde hoy se guarda
  una foto diaria de los derivados (GEX, risk reversal, funding, long/short...); sus percentiles salen a partir de 30 días.

**Corregido**
- **Datos que venían de las cotizaciones de CBOE** (dan 403 desde el 2026-11-20, también los históricos y los gráficos
  intradía): el tipo libre de riesgo del Summary vuelve a ser el de la letra a 13 semanas (IRX) y no el 4 % fijo; el IV
  rank del Compass y de la ficha, la volatilidad realizada, la correlación implícita, el pre-market por ETF de los
  índices, la IV a 30 días de la ficha, las velas intradía de las acciones y el paquete de X (curva del VIX y el 10 años)
  vuelven a tener datos. Salen de Tradier y, para los índices de CBOE (VIX y familia, IRX, TNX, COR...), de sus cierres
  oficiales diarios. La IV a 30 días pasa a ser la IV ATM del vencimiento más cercano a 30 días.
- **Régimen de volatilidad** (curva del VIX y Summary): con el mercado cerrado, los cuatro indicadores salen siempre
  del mismo cierre. CBOE no publica los cierres a la vez y la tarjeta podía mostrar el VVIX del día con el VIX, el
  VIX3M/VIX y el SKEW/VIX de la sesión anterior.

## 2026-11-20 — Sección Crypto, Social pasa a Research y régimen de volatilidad en la curva del VIX y el Summary

**Añadido**
- **Crypto** (nueva sección en la barra lateral): bitcoin y ether cada 15 minutos, todos los días. Exposición gamma de
  las opciones de Deribit por strike con flip, Call Wall y Put Wall (7 días, 30 días o todos los vencimientos); mapa de
  niveles con los de opciones y el coste on-chain (realized price y coste de los holders de corto y largo plazo);
  precio frente a ese coste en los dos últimos años; DVOL de un año, estructura temporal de la volatilidad con risk
  reversal y butterfly; vencimientos con nocional, put/call y max pain; basis de los futuros; funding, open interest y
  ratio long/short de OKX; MVRV, flujos de exchanges, Fear & Greed, stablecoins y el top 15 por capitalización. Una
  lectura por reglas separa la tendencia del posicionamiento (contrarian) y marca la capitulación o el
  sobrecalentamiento. Fuentes gratuitas y sin clave.
- **Régimen de volatilidad** (curva del VIX y Summary): VIX, VVIX, VIX3M/VIX y SKEW/VIX, cada uno con su zona
  (calma, estrés, zona de compra o complacencia) en una barra, y qué hizo el SPX desde 2010 tras los días de esa zona
  a 60 y 120 sesiones y su caída adicional típica. Niveles ajustados con un backtest desde 1990. En directo con la
  sesión abierta; fuera de ella, los cierres oficiales de CBOE, todos del mismo día.
- **Social, playbook de la próxima sesión:** gráfico con, por índice, el cierre, el rango de 1σ de mañana y los
  niveles de gamma con su distancia (los que coinciden, juntos; los que caen fuera del rango, en el borde), y la agenda
  (eventos con hora ET y vencimiento mensual).
- **Social, mercados cruzados y amplitud:** el 10 años (en % y pb), bonos largos e intermedios, high yield, dólar,
  oro, plata, petróleo, ETFs de bitcoin y ether y bitcoin y ether al contado (24 h); los 11 sectores y semis, y la
  amplitud (igual ponderado y small caps frente a SPY, sectores en verde). Con su gráfico.
- **Hilos:** cada post puede llevar hasta 4 respuestas, cada una con su imagen, su botón de copiar y su contador de 280.

**Cambiado**
- **Social** sale de Admin y pasa a la barra lateral, en Research. Solo la ve el administrador.
- **Textos de `/x-diario`:** cada cierre, dos hilos obligatorios (la conclusión del día de SPX, NDX y VIX con amplitud
  y mercados cruzados, y el playbook para la sesión siguiente), más posts sueltos cuando algo lo merezca. Con una
  lectura del día (alcista, bajista o de transición) que se nota en el tono.

**Corregido**
- **Curva del VIX en la web publicada:** VIX9D a VIX1Y y VIX/VIX3M salían vacíos porque CBOE rechaza ahora sus
  cotizaciones (403). En sesión se toman de Tradier y, con el mercado cerrado, de los cierres oficiales de CBOE.
- **Social, perfil del NDX:** las barras salían como hilos (el ancho se tomaba del paso mínimo entre strikes y el NDX
  mezcla strikes de 10 y de 100); ahora se usa el paso mediano.
- **Social en blanco con bloqueadores de anuncios:** sus listas de "social" ocultaban la página (id `socialView`,
  clases `soc-`). Ahora usa nombres neutros (`postsView`, `pst-`).
- **Curva VIX y Summary sin cierre del VIX:** si CBOE no da el VIX al contado del último cierre, la curva salía
  cortada desde abajo (el punto vacío se dibujaba en 0) y el Summary daba una variación falsa. Ahora la curva empieza
  en el primer futuro y no se muestra la variación.

## 2026-11-19 — Social: posts diarios para X en el panel de administración

**Añadido**
- **Admin > Social (solo el administrador):** después de cada cierre, una lista de posts para X con su imagen
  (1600 x 900, tema oscuro) y su texto en inglés de 280 caracteres como máximo. Cada post tiene botones para copiar el
  texto, copiar o descargar la imagen y marcarlo como publicado; el texto se puede retocar antes de copiarlo y un
  contador avisa si pasa de 280. Un selector permite ver días anteriores.
  - Siempre hay un post de los índices (SPX, NDX, RUT): cierre, movimiento frente al que esperaban las opciones,
    régimen de gamma, Call Wall, Put Wall, flip y rango de 1σ de la sesión siguiente. Además, lo que más destaque:
    acciones con un movimiento fuera de lo normal (en sigmas), salto de IV o volumen de opciones, el VIX y su curva,
    o la próxima sesión (vencimiento mensual, eventos de importancia alta).
  - Los datos y gráficos se generan solos en dos pasadas: a las 16:20 ET (listos hacia las 16:25) índices, VIX y
    próxima sesión, y al acabar el historial diario (hacia las 17:10 ET) se añaden las acciones. Los textos los
    escribe Claude Code con `/x-diario`.

Validation: los muros se juzgan por el cierre; el historial diario ya no pierde la última sesión

**Cambiado**
- **Validation, Call Wall y Put Wall:** un muro cuenta como aguantado si el cierre queda dentro (por debajo del Call
  Wall, por encima del Put Wall). Una mecha que lo pasa y vuelve es un rechazo, no una rotura; antes contaba como
  roto. La referencia ("Baseline", un nivel cualquiera a la misma distancia) se mide también con el cierre, para
  comparar lo mismo. Las cifras se rehacen solas en el siguiente cálculo de cada Validation.

**Corregido**
- **Validation > Daily history:** se calculaba al guardar la sesión (hacia las 17:10 ET), antes de que CBOE publique
  la vela diaria, así que la última sesión nunca se evaluaba; los tickers recién añadidos (el S&P 500) salían con 0
  sesiones. Ahora la ejecución de respaldo de la noche (22:30 ET en invierno) la recalcula en cuanto CBOE tiene la vela.

## 2026-11-15 — Trading window; índices en tiempo real cada minuto; Skew signal: Vol premium; Validation de toda la lista del historial diario; estudio del Skew signal

**Añadido**
- **Trading window (TRACE):** botón "Trading window" en la barra del mapa. Abre el mapa a pantalla completa sobre un
  gráfico de TradingView (Lightweight Charts), pensado para operar en el día:
  - Gráfico: zoom y desplazamiento con el ratón, escala de precios arrastrable, leyenda con la vela y el valor del
    mapa bajo el cursor, y barras de gamma por strike junto a la escala de precios.
  - Arriba: los 6 índices en tiempo real, vencimientos 0DTE o el filtro de siempre, velas de 1, 5 y 15 min, lentes
    Gamma, Delta y Charm, y botones para barras, referencias y sonido.
  - Niveles como escalones: se ve cómo se movieron el Call Wall, el Put Wall, el Gamma Flip y el Vol Trigger
    durante la sesión. Una flecha marca cada vela que cierra al otro lado de un nivel; con el precio en vivo, aviso
    en la ventana (y pitido si se activa) al cruzar uno.
  - Referencias: cierre, máximo y mínimo de la sesión anterior, apertura y rango de los primeros 30 min (en NDX y
    RUT no hay máximo ni mínimo de ayer: CBOE no da su histórico).
  - Eventos macro de EE. UU. de hoy como líneas verticales en su hora, con cuenta atrás en el panel.
  - Panel inferior con el flujo de opciones de la sesión (prima de calls y puts y delta neta).
  - Panel lateral con el plan de sesión: régimen y qué suele pasar en él, niveles con su distancia en sigmas, rango
    esperado, lo que comprarían o venderían los dealers si el precio se mueve ±½ y ±1 sigma (total y del próximo
    vencimiento), el strike 0DTE más grande cerca del precio (posible pin en la última hora), eventos, flujo y
    referencias.
  - El mapa y los niveles siguen llegando del motor (cada minuto en los índices en tiempo real); entre cálculo y
    cálculo, la última vela se mueve con el precio de Tradier cada 5 s (indicador "Live"). Tecla F para pantalla
    completa y Esc para cerrar.
- **Validation, toda la lista del historial diario:** nuevo selector "Tickers" con "My list" (la watchlist, como
  hasta ahora) y "Daily history" (los ~560 tickers del historial diario). Se calcula una vez al día, al terminar de
  guardar la sesión, con los niveles de cada cierre (sin las fotos de antes de la apertura) y el motor Perfil, para
  todos los filtros de vencimientos y los dos modos. Solo en la nube. Así las pruebas cuentan con muchas más
  sesiones por día y se pueden ajustar los umbrales con más datos.
- **Skew signal, quinta pestaña: Vol premium:** la IV a 30 días de cada acción menos lo que se ha movido de verdad en
  las últimas 20 sesiones. No dice hacia dónde irá la acción, sino si sus opciones están caras o baratas frente a su
  movimiento real: la investigación (Goyal y Saretto, 2009) encuentra que las opciones caras frente a la volatilidad
  realizada tienden a sobrevalorar el movimiento que viene. Por eso su prueba en adelante no mira el rendimiento,
  sino la prima que se habría cobrado (IV de hoy menos la volatilidad de las sesiones siguientes). Lectura de
  "Options rich" a "Options cheap"; no vota en el Consensus. La volatilidad realizada deja fuera el mayor movimiento
  de las 20 sesiones: un salto de resultados no se repite y hacía parecer baratísimas las opciones de INTC, AMD o MU.
  Los resultados que vienen sí encarecen la IV: antes de leer "rich" como venta, mirar el calendario.

**Cambiado**
- **Índices en tiempo real cada minuto:** SPX, NDX, RUT, SPY, QQQ e IWM se recalculan cada minuto con la
  sesión abierta (antes, cada 5 min): niveles, mapa TRACE, paquete y el último punto del Options flow. Siguen hasta
  las 16:15 ET (antes, 16:05), que es cuando dejan de cotizar sus opciones. Antes de la apertura (07:05-09:30), cada
  5 min como hasta ahora. Para no pasar del límite de Tradier, cada minuto se piden los vencimientos de hasta 14 días
  y los más lejanos se renuevan cada 5 min; el panel de volatilidad, también cada 5 min. Con Auto, la web los recoge
  al minuto.
- La Validation recorta los precios de cada ticker a los días que usa (las 500 sesiones de referencia y la ventana
  de volatilidad antes de su primera sesión con niveles): mismo resultado, la mitad de tiempo.

**Corregido**
- **Estudio del Skew signal** (`pruebas/estudio_skew.py`): fallaba al llegar al Consensus, que no tiene puntuación
  propia que ordenar; ahora imprime su prueba y su diagnóstico y salta el ranking.

## 2026-11-14 — Rango de 1σ ajustado por el régimen de gamma del SPX; Skew signal (put skew, call−put IV y volumen de opciones) para swings en acciones; régimen de la curva del VIX

**Añadido**
- **Equity Hub, gap de apertura (SPX, XSP y NDX, en el pre-mercado):** con el precio de pre-mercado, el gap frente
  al cierre de ayer en sigmas de la sesión y cuántas veces se ha cerrado en el mismo día un gap de ese tamaño desde
  2012 (SPY y QQQ): 74 % los de 0,1-0,3σ, 46 % los de 0,3-0,6σ, 28 % los de 0,6-1σ y 18 % los mayores. Probado
  fuera de muestra: el tamaño lo explica casi todo y la gamma no añade nada; si el día sigue al gap es una moneda
  al aire (51 %), por eso no se muestra.
- **Equity Hub, probabilidad de cerrar fuera del 1σ (SPX, SPY y XSP):** bajo el rango ajustado por la gamma, la
  probabilidad de que el SPX cierre la próxima sesión fuera del 1σ, frente a la habitual (19 %). Sale de un modelo con
  dos datos, la gamma del SPX y la parte corta de la curva del VIX (VIX9D/VIX), que se probó con años que no había
  visto: acierta más que el porcentaje fijo y está bien calibrado (los días a los que da un 8 % rompieron el 7,5 % de
  las veces; los de un 40 %, el 37 %). En rojo si es claramente mayor de lo normal, en violeta si es menor.
- **Equity Hub, rango ajustado y probabilidad del 1σ también en NDX, QQQ y XND:** la gamma del SPX separa también los
  días del Nasdaq (fuera del 1σ del VXN el 33,5 % de las sesiones con gamma muy baja y el 13,1 % con muy alta), así
  que se aplica con su propia calibración (QQQ y VXN desde 2012). El Russell (RUT, IWM) no la tiene: CBOE no publica
  la historia de su índice de volatilidad.
- **VIX curve, "SPX after similar curves":** qué hizo el SPX desde 2009 tras cada tramo de VIX/VIX3M (rendimiento
  medio a 20 sesiones, % de veces al alza y volatilidad realizada siguiente menos el VIX), con el tramo de hoy
  resaltado. Cuanto más plana o invertida la curva, mejor fue el SPX después (+0,5 % con contango profundo, +2,8 % en
  backwardation), aunque con mucha más volatilidad: es una inclinación, no una certeza. Si el tramo corto se invierte
  (VIX9D/VIX por encima de 1,05), avisa de que vender prima ha compensado bastante menos.
- **Skew signal** (en el menú, sección Signals): las acciones del historial diario ordenadas por lo caras que están sus
  puts. Skew = IV de la put de 25 delta menos la ATM, en el vencimiento mensual más cercano a 30 días, al cierre; se
  combina con su cambio en 5 sesiones. La investigación (Xing, Zhang y Zhao, 2010) encuentra que las acciones con el
  skew más caro tienden a ir peor que el resto en las semanas siguientes. Fuera índices, ETF y VIX.
- A la izquierda, la prueba en adelante con nuestros propios datos: correlación entre la puntuación y el rendimiento
  de las 10 y 40 sesiones siguientes (unas dos semanas y unos dos meses: plazos de swing). Hasta tener 20 sesiones
  evaluadas a 10 y 40 a 40 dice "Collecting data" y no muestra la t (con pocas sesiones no significa nada): mientras
  tanto el ranking es una lista para vigilar, no una señal. Por detrás se guarda un diagnóstico (nivel y cambio por
  separado, y la puntuación sin el efecto del rendimiento de la semana previa) para saber por qué falla una señal si
  falla. Al pulsar una acción se abre su Volatility dashboard.
- **Skew signal, segunda señal: Call−put IV** (selector encima de la tabla): IV de las calls menos la de las puts en
  los mismos strikes cercanos al precio, ponderada por OI. Si las calls están caras frente a las puts hay compra
  informada, y la investigación (Cremers y Weinbaum, 2010) encuentra que esas acciones van mejor que el resto. Tiene
  su propia prueba en adelante; la columna de lectura va en el sentido que espera cada estudio. Solo cuenta strikes a
  ±5 % del precio con horquilla estrecha en la call y en la put: las acciones con opciones poco líquidas (GILD, BKNG,
  HON, JD, T) se quedan sin lectura en lugar de dar ruido. El put skew aplica el mismo criterio (horquilla de como
  mucho el 35 %, más holgada porque las puts lejanas son baratas): GILD salía primera con puts de horquilla del 61 %.
- **Skew signal, tercera señal: Options volume (O/S):** contratos de opciones negociados × 100 frente a acciones
  negociadas en el día. Quien tiene malas noticias suele operar con opciones, porque ponerse corto en la acción
  cuesta más, y la investigación (Johnson y So, 2012) encuentra que las acciones con O/S alto van peor que el resto.
  Si el volumen de la acción de la última sesión aún no está publicado, enseña la sesión anterior y lo indica.
- **Skew signal, Consensus** (pestaña por defecto): las acciones en las que al menos dos de las tres señales apuntan
  en el mismo sentido y ninguna en contra, separadas en alcistas y bajistas, con el voto de cada señal. Tiene su
  propia prueba en adelante con la puntuación combinada, para saber si juntas funcionan mejor que por separado.
- **Equity Hub, rango de 1σ de SPX, SPY y XSP:** una línea más con el rango corregido por el régimen de gamma del
  SPX (GEX diario de SqueezeMetrics frente al último año, de muy bajo a muy alto). Desde 2012, con gamma muy alta el SPX
  cerró fuera del rango implícito el 9 % de las sesiones y con gamma muy baja el 30 %; el rango ajustado es el que de
  verdad contuvo el 68,3 % de los cierres en cada régimen. Al pasar el ratón, el detalle.
- Estudio que lo respalda (`pruebas/regimen_gamma.py`): el GEX predice el rango del día siguiente más allá del VIX y
  del rango reciente, en 2011-2018 y en 2019-2026. No predice la dirección ni el cierre de los gaps.

**Cambiado**
- **Historial diario:** la lista admite hasta 600 tickers (antes 200), para guardar el S&P 500 además de la lista
  propia. Medido con la ejecución real: unos 4 MB al día por cada 110 tickers; con 560 tickers y 2 años de retención
  quedan unos 7,5 GB en R2, dentro de los 10 GB gratuitos. La ejecución diaria pasa a durar unos 50 minutos.

**Corregido**
- **Ticker inexistente:** un ticker que no está en el directorio de opciones de CBOE (una errata como APPL) ya no
  llega nunca al motor. Al abrirlo, la web avisa de inmediato de que no tiene opciones, en lugar de lanzar el motor en
  cada refresco (fallaba cada 10 minutos y mandaba un correo de error de GitHub cada vez); al añadirlo a una lista,
  no se añade y sale un aviso.
- **Skew signal:** la tabla ocupaba solo la mitad del alto en pantallas anchas (la nota del pie se quedaba con la otra
  mitad), y EWY, un ETF, salía como acción. Al pie se listan ahora las acciones guardadas ese día que no dan lectura
  (opciones demasiado finas o sin strikes útiles en el mensual, como NIO a menos de 3 $), para que cuadre el número;
  las recién añadidas a la lista no cuentan hasta su primer día guardado.

## 2026-11-13 — Founder Takes y report semanal

**Añadido**
- **Founder Takes** (en el menú, sección Research): notas, lecturas de mercado y material de research del fundador.
  Cada Take lleva texto (con títulos, negrita, cursiva, listas, citas y enlaces), etiquetas libres y los adjuntos que
  hagan falta: enlaces a noticias o hilos de X con una nota, citas de research con su fuente, imágenes y PDFs (hasta
  20 MB cada uno). El listado se filtra por etiquetas (se recuerda el filtro) y con un buscador.
- El administrador escribe, publica, despublica y borra. Los borradores no los ve nadie más. Desde `/admin` puede dar
  a otra cuenta permiso para preparar borradores ("Allow drafts"); esa cuenta no puede publicar.
- Editor con vista previa, etiquetas con autocompletado, adjuntos que se reordenan, y capturas pegadas o arrastradas.
  Al subir un PDF recuerda que el research de pago se cita con un extracto y un enlace, no entero.

- **Report semanal** en Founder Takes: un borrador semanal con lo destacable de la semana en gamma y niveles, vol
  realizada en subidas y bajadas, rebalanceo estimado de los ETFs apalancados y vol a strike fijo, con gráficos.
  Lo prepara Claude a partir de los datos de GEX Lab; el administrador lo revisa y lo publica.

**Cambiado**
- Si un Take no se puede guardar a mitad, no quedan archivos sueltos ni un Take a medias.
- Las peticiones que modifican datos con PUT o DELETE también deben venir de la propia web, como ya pasaba con POST.

## 2026-11-12 — Nuevo aspecto: Bento (oscuro) y Daylight (claro); Summary nuevo; calendario económico con dato real; Options Lab como constructor de estrategias; Open Interest, COT y Options flow en una pantalla; Validation con los veredictos arriba; Volatility con vista general; Scanner visual; Equity Hub como puesto de trabajo; TRACE con el mapa a todo el ancho

**Añadido**
- **Calendar** (en Market, bajo Summary): los datos macro de EE. UU., zona euro, Alemania, Francia, Italia, Reino
  Unido, Japón, China, Canadá, Australia y Suiza, por días y en tu hora local, con importancia, **Actual**,
  **Forecast** y **Previous**. Filtro de países (casillas, All y None) e importancia mínima, que se recuerdan; flechas
  para cambiar de semana (de dos atrás a cuatro adelante) y el próximo dato marcado. Forecast y previous son de la
  semana en curso; el dato real, solo de EE. UU.
- En el **Summary**, al pasar el ratón (o tocar en el móvil) por un dato de la semana sale una tarjeta con Actual,
  Forecast y Previous. Actual en color según quede por encima o por debajo del consenso, y «Pending» mientras no sale.
- El dato real de EE. UU. llega en uno o dos minutos: a la hora de cada dato se lanza un ciclo solo del calendario
  (CPI, empleo, PPI y JOLTS de BLS al minuto; ventas minoristas, PCE, peticiones de desempleo, PIB, bienes duraderos y
  vivienda de FRED, que tarda de 3 minutos a 2 horas), con reintentos hasta que sale.
- **Validation**: columna **Outside 2σ** con los cierres fuera del doble del rango de 1σ frente al 4,55 % teórico
  y el semáforo de Basilea de cada ticker (verde, amarillo o rojo según lo improbable que sea ese número de fallos;
  orientativo hasta 250 sesiones), y una quinta tarjeta arriba, «2σ range», con el total y los tickers en cada zona.
  Usa el historial ya guardado desde el 2026-11-04.

**Cambiado**
- **Validation** reordenada: arriba el avance hacia el veredicto (días evaluados frente a los 20 necesarios) y
  cuatro tarjetas (Call Wall, Put Wall, régimen de gamma y rango de 1σ) con su pregunta, la cifra observada frente
  a la referencia en barras y el veredicto; debajo, la tabla por ticker con barras y una marca en la referencia
  (verde si la supera, roja si no), rangos en una línea y desplazamiento propio si hay muchos tickers; al lado, los
  días con evento frente a los normales.
- **Options flow** en una sola pantalla: las seis tarjetas de arriba retocadas (prima de calls y puts y delta neta
  en el color de su línea), una frase con la lectura del día, el acumulado de la sesión con zonas suaves bajo calls
  y puts, alto ajustado a la ventana y tarjeta al pasar el ratón, y al lado la actividad inusual en una columna
  ancha (contrato, volumen y veces el OI, IV, prima y % comprado; delta y vega al pasar el ratón).
- **COT** en una sola pantalla: a la izquierda los mercados con el índice COT de Asset managers, Leveraged funds y
  Dealers en celdas rellenas con el color de cada grupo (la cifra al final del relleno; los extremos, intensos y con
  borde ámbar); a la derecha el mercado elegido con el interés abierto, el neto de cada grupo y su cambio semanal,
  su índice, una frase con los extremos y el mayor movimiento de la semana, y el historial con el precio de
  referencia, de alto ajustado a la ventana y con tarjeta al pasar el ratón.
- Options Lab, Open Interest y COT dejan de repetir el nombre de la página bajo la barra superior.
- **Open Interest** en una sola pantalla: cifras en fila (OI de calls y puts con su cambio, put/call de OI y de
  volumen, volumen, max pain con su distancia y los strikes con más OI); los vencimientos pasan a ser columnas con
  sus barras de calls y puts que se eligen pulsando (Shift para sumar), con los filtros por plazo encima; el gráfico
  por strike, más limpio, resalta los strikes con más calls y puts, marca precio y max pain en pastillas y ajusta su
  alto a la ventana; al lado, los contratos que más se abrieron y cerraron, o los más negociados en Volume (con aviso
  si el volumen supera al OI).
- **Options Lab** rehecho como constructor de estrategias. Al entrar, una galería de 28 estrategias en cinco familias
  (Directional, Income, Volatility, Neutral, Hedging), cada una con el dibujo de su perfil de pago, una frase y su
  sesgo; se añaden synthetic long y short, bull put y bear call spread, short straddle y strangle, iron butterfly,
  jade lizard, strap, strip, reverse iron condor, put butterfly, put calendar, collar y covered put. Al elegir una,
  todo cabe en una pantalla: nombre, fila de cifras (coste, máximos, probabilidad, punto muerto, distancia a él,
  precio y griegas), gráfico de P&L con zona de ganancia y de pérdida que ajusta su alto a la ventana, y la tabla de
  posiciones con strike, tipo, vencimiento, Long/Short, tamaño, precio, IV, P&L, griegas, valor teórico, bid y ask;
  el ojo saca una pata del cálculo sin borrarla. Al pasar el ratón por el gráfico se ve el P&L de hoy y al
  vencimiento y la probabilidad de acabar por debajo y por encima de ese precio. **What-if** (fecha y volatilidad con
  atajos), **Greek** (una griega en el eje derecho) y zoom van en la barra del gráfico. Al bajar, el nombre y las
  cifras quedan fijos arriba. Los escenarios usan pasos de porcentaje redondos. Cada ticker recuerda su estrategia.
- **Scanner** como tabla visual: las columnas de Gamma Flip, Call Wall y Put Wall pasan a una barra por fila del
  Put Wall al Call Wall con el precio (punto) y el flip (marca ámbar), con los tres niveles, su distancia y una
  flecha si cambiaron desde la sesión anterior; el GEX por 1 % es una barra que sale del cero y el rango 1σ otra
  barra. El precio lleva debajo la variación del día (la columna ordena por ella).
- **Volatility dashboard**: nueva vista **Overview** (la de entrada) con las cuatro gráficas a la vez (Term
  structure, Skew, Skew by expiration y Realized vs. implied) y la matriz por strike fijo debajo. Al pulsar una se
  abre en grande con sus controles; las pestañas cambian de vista sin volver a la general, y Esc vuelve. Cada cifra
  de arriba lleva una conclusión breve («Options are cheap», «Short-dated vol elevated», «Puts in demand»...),
  resaltada si es notable, con su criterio en el texto de ayuda.
- **Aspecto de toda la web**, con dos temas que se alternan con el botón de la barra lateral y comparten forma: letra
  Manrope con cifras grandes, barra lateral flotante, bloques muy redondeados sin bordes y controles en pastilla. Solo
  cambia el color: **Bento** (oscuro) en negro puro con lo elegido en blanco, y **Daylight** (claro) en gris lavanda con
  tarjetas blancas de sombra suave y acento índigo. Los rótulos dejan de ir en mayúsculas, los gráficos usan los colores
  de cada tema, y el inicio de sesión y el alta siguen el mismo estilo.
- **Summary** rehecho como parte de mercado: cuenta atrás hasta la apertura y la semana con los datos macro (importancia
  en tres marcas, hora local) y los vencimientos; SPX, NDX y RUT con su **terreno de gamma** (perfil de gamma por precio
  coloreado como el mapa de TRACE, con muros, flip, precio y banda de 1σ), GEX por 1 % y su cambio, 1σ de la semana,
  gamma que vence y niveles movidos desde ayer; **Volatility** (curva del VIX frente a ayer y hace una semana,
  estructura VIX9D a VIX1Y, IV frente a RV de SPX); **Correlation and dispersion** (un año de COR1M y DSPX con bandas de
  percentil); mapa de régimen de la watchlist; flujo de opciones de SPX con la actividad inusual; y extremos del COT en
  medidores. Cada panel lleva a su página.
- **Equity Hub** reorganizado en tres columnas: a la izquierda la watchlist (ordenada de la que más sube a la que más baja en el
  día; un clic carga el ticker; se pliega con la
  flecha de su cabecera y el gráfico gana ese ancho, y la elección se recuerda), en el centro el
  gráfico y a la derecha el precio, el régimen, los niveles y el Net GEX. Debajo, un panel con pestañas reúne lo que
  antes era una columna muy larga: **Profile**, **Flows** (rango 1σ, vanna, charm, vencimiento próximo y gamma por
  vencimiento), **Scenarios** y **Data**. La pestaña elegida se recuerda.
- **TRACE**: el mapa ocupa todo el ancho. Encima, una franja con lo que se mira durante la sesión: precio, zona de
  gamma, el nivel de abajo y el de arriba con su distancia (en puntos y en %) y el precio situado a escala entre los
  dos, el resto de niveles con el Net GEX y el estado del mapa (preapertura, en vivo, repetición o próxima sesión).
  Flows, Scenarios y Data van en el mismo panel de pestañas que el Hub, y las barras laterales, 0DTE y la pista de
  zoom pasan a la misma fila que la lente y las velas.
- La fila de vencimientos, rango y modelo ocupa una sola línea, con cada etiqueta a la izquierda de su control. Junto
  a Settings ya no aparece el texto del motor y la convención por defecto: solo salen los ajustes cambiados. La
  explicación del gráfico pasa a un icono «i». En By strike, **Gamma by expiration** ya no lleva la línea de
  vencimientos encima del gráfico (empujaba el gráfico y cortaba las barras por abajo): cada vencimiento está en el
  tooltip.

**Corregido**
- **Scanner** vacío («Add tickers to get started») al abrirlo después de Validation o Compass: ahora se calcula al
  entrar desde cualquier vista.
- **Summary** antes de la apertura: SPX, NDX y RUT muestran el precio pre-market (última vela de SPY, QQQ o IWM en
  Tradier, escalada al índice) con su cambio frente al cierre de ayer y la marca «Pre-market». Antes salía el cierre de
  ayer, porque la cotización retrasada de CBOE del ETF no se mueve fuera de horario.
- En el terreno de gamma del Summary las etiquetas de los niveles ya no se montan unas sobre otras (p. ej. Gamma Flip
  y Call Wall muy juntos en el NDX): cada una va a la primera fila libre.
- Las imágenes copiadas o descargadas de un gráfico tienen esquinas rectas; antes se veían las esquinas redondeadas
  sobre otro color. El informe conserva sus tarjetas redondeadas.
- En tema claro, la sección activa de la barra lateral lleva un tinte índigo suave con el texto en índigo, en lugar
  de un bloque de color intenso que dejaba el texto oscuro e ilegible.
- Al abrir la web con Options Lab como última pantalla salía en blanco (`showLab is not defined`): la app arranca
  ahora cuando han cargado todos sus scripts.
- El título de las pestañas de inicio de sesión y de alta usa un guion en lugar del punto medio. El sistema visual
  «Papel técnico» que se probó hoy se ha retirado: la web conserva sus colores y su letra de siempre.

## 2026-11-11 — Compass con estela de historial, cabecera propia y pantalla completa; Volatility dashboard con IV30 sin modelo, evento descontado, forma del skew y cono de volatilidad; coberturas frente al volumen y escenarios en el Equity Hub; página de correlación implícita; flujo de opciones estimado; Validación con el historial diario, referencia y pruebas; Open Interest y Options Lab; fuera las opciones ajustadas

**Añadido**
- **Open Interest** (menú Positioning): OI por strike del ticker de la barra superior, con calls arriba y puts abajo, la
  marca del OI de la sesión anterior, y también el cambio de OI o el volumen de hoy. Se eligen los vencimientos (todos,
  próximos 7 días, de 8 a 45, más de 45, o uno o varios a mano) y el rango (±5, 10 o 20 %). Al lado: calls y puts
  con su cambio, ratio put/call (OI y volumen), max pain, strikes con más OI de calls y de puts y volumen de hoy.
  Debajo: OI por vencimiento (pulsando una barra se ve solo ese) y los contratos con más altas y más bajas.
- **Options Lab** (menú Tools): calculadora de opciones y constructor de estrategias en uno. Dos modos: **Live
  chain**, con la cadena real del ticker de la barra superior (cada pata entra al precio medio con su IV y se valora
  con el forward de su vencimiento), e **Hypothetical**, con precio, IV, tipo y dividendo inventados. Una o varias
  patas (compra o venta, cantidad, call, put o acciones, vencimiento o días, strike, IV y precio de entrada) o
  estrategias de un clic (calls y puts largas o cortas, spreads, straddle, strangle, iron condor, butterfly,
  calendar, covered call y protective put). Lecturas de coste, máximos, puntos muertos y probabilidad de ganar; una
  frase con lo esencial («You collect $5,555. You make money between 7,344 and 7,831…»); P&L por precio al primer
  vencimiento, hoy y en la fecha elegida, con un cambio de IV; griegas netas en dólares, y matriz de escenarios.
  Las posiciones se guardan (las tres últimas de Live y la de Hypothetical).
- **Estética de instrumento** en Open Interest y Options Lab: paneles con barra de rótulo, lecturas con cifras tipo
  display, gráficos sobre papel milimetrado con la curva principal como trazo de osciloscopio, teclas que se
  invierten al elegirlas y faders con marcas.
- Las dos herramientas usan como precio del subyacente el que implican las opciones (forward del vencimiento más
  cercano): con el mercado cerrado, el último precio de un índice se queda en el cierre mientras sus opciones siguen
  cotizando, y se avisa cuando no coinciden.
- **Compass: estela de cada ticker** con las últimas sesiones guardadas, para ver si su volatilidad está más cara o
  más barata que hace unos días. Desplegable «History» en la cabecera del Compass: Off, 3, 5 o 10 días (5 por
  defecto). Cada sesión se calcula con el mismo método que el punto de hoy: índice de volatilidad de CBOE si lo
  tiene, su historial propio con 60 sesiones o, si no, frente al resto de la lista en esa misma sesión. El tooltip
  da el cambio de IV rank y RR rank desde el inicio de la estela.
- **Ampliar el Compass:** botón junto al desplegable; el gráfico y la lista ocupan toda la ventana. Esc o el mismo
  botón para volver.
- **Añadir tickers desde el buscador de la lista del Compass** («Find or add a ticker»): si lo escrito no está en
  la lista, aparece «+ Add … to your list» (también con Enter).
- **Validación con el historial diario:** usa también los niveles guardados cada día al cierre de los tickers del
  historial diario, así un ticker recién añadido a la lista sale con todas las sesiones desde el primer día de ese
  historial, no solo desde que se añadió. Solo se validan los tickers de la lista.
- **Volatility dashboard: resumen de la superficie** encima del gráfico, con seis lecturas: IV30 sin modelo (con la
  fórmula del VIX sobre todas las opciones fuera de dinero; en el SPX da el VIX), volatilidad realizada de 20 sesiones
  (cierre a cierre y Yang-Zhang), prima de varianza (IV30 menos realizada), forma de la estructura temporal (normal,
  bulto en el corto plazo o invertida), skew a 30 días (risk reversal y butterfly de 25 delta) y el evento que
  descuenta la curva.
- **Evento descontado en la estructura temporal:** los tramos cuya varianza forward destaca sobre la normal y sobre
  sus vecinos salen con un círculo y el movimiento de un día que se paga de más (NVDA: ±9,8 % hasta el vencimiento
  del 20 de noviembre, el de sus resultados). El tooltip añade IV sin modelo, risk reversal, butterfly y evento.
- **Pestaña «Skew by expiration»:** risk reversal y butterfly de 25 delta de cada vencimiento, con la sesión anterior.
- **Pestaña «Realized vs. implied»:** cono de volatilidad del último año (Yang-Zhang a 10, 20, 30, 60, 90 y 120
  sesiones: mínimo, percentiles 10-90, mediana y máximo), con la realizada de hoy y la IV ATM del mismo plazo. NDX y
  RUT usan su ETF; en el VIX no se muestra (sus opciones van sobre el futuro).
- **Equity Hub: coberturas frente al volumen.** Nueva lectura «Hedging vs. volume»: la cobertura de los dealers por
  un movimiento del 1 % en % del volumen medio diario en dólares, con su impacto aproximado en el precio (ley de la
  raíz cuadrada) y si va a favor o en contra del movimiento; también vanna y charm en % del volumen. No sale en los
  índices, que se cubren sobre todo con futuros. El Escáner tiene la columna «Hedge / ADV» para comparar tickers.
- **Equity Hub: gamma por vencimiento**, en una barra con los tramos 0-1, 2-7, 8-30 y más de 30 días, y la GEX por 1 %
  que queda tras el próximo vencimiento («Expires…»).
- **Equity Hub: escenarios.** Tabla precio (−5 % a +5 %) por IV (−5 a +5 puntos) con la GEX por 1 % o con el flujo
  de cobertura: lo que los dealers comprarían o venderían para seguir cubiertos si el precio y la IV fueran ahí.
- **Página Correlation** (menú Volatility): correlación implícita de CBOE entre las 50 mayores acciones del S&P 500
  a 10 días, 1, 3, 6 y 9 meses y 1 año, con la de hace una semana y la banda 10-90 del último año; índice de dispersión
  DSPX y VIX; lectura del régimen (bloque, normal o cada acción por su lado) y dos años de historia.
- **Página Options flow** (menú Positioning), marcada como estimación: cada 15 minutos el motor compara la cadena con
  la foto anterior y clasifica el volumen nuevo de cada contrato como compra o venta según cuánto se movió su IV
  frente al resto (BVC). Muestra la prima neta de calls y de puts, la delta y la vega netas de los clientes
  acumuladas en la sesión, con el precio, y la actividad inusual del día (volumen por encima del open interest)
  con prima, delta y vega en dólares y la parte estimada como compra. Solo para los tickers de las listas.

**Cambiado**
- El Compass tiene cabecera propia (título, historial y ampliar) dentro de su recuadro, como los desplegables del
  TRACE.
- El cuadro «Add ticker» de la barra del escáner solo sale en la vista Tabla.
- **Validación con referencia y pruebas.** Cada muro se compara con lo que habría aguantado un nivel cualquiera a la
  misma distancia, según el historial del ticker y su volatilidad del momento («baseline»). El rango de cada sesión se
  mide también frente al rango normal del ticker, para separar el régimen de gamma de la volatilidad de la época. Un
  panel nuevo, «Is it better than chance?», da un veredicto por prueba (muros, régimen de gamma y rango de 1σ frente
  al 68,3 %): agrupa las sesiones por día, porque los tickers se mueven juntos, y no concluye nada con menos de 20
  días. Debajo, los días con evento (vencimiento mensual, FOMC, IPC, empleo) frente al resto.
- El calendario macro guarda los eventos pasados tres años (la web sigue recibiendo los últimos 45 días), para marcar
  los días con evento en la Validación.
- La estela ya no exige 60 sesiones de historial propio: sale desde la segunda sesión guardada. Mientras un eje es
  provisional (comparado con la lista), la estela de ese eje se mueve a saltos.

**Corregido**
- **Equity Hub se quedaba en blanco** al entrar desde Summary, VIX curve o COT: la marca de «pantalla sin ticker»
  de esas secciones se invertía en vez de quitarse y ocultaba controles y gráfico. Ahora se quita siempre.
- **La web dejó de pintar gráficos** (TRACE, Equity Hub, Volatility dashboard…: «yt.ticks is not iterable»): una
  función de las herramientas nuevas se llamaba igual que la de los ejes de `app.js` y la sustituía. Renombrada.
- **Open Interest no cargaba en la nube** («undefined is not a function»): su preferencia de vencimientos usaba la
  misma clave que el modo de OI del Equity Hub. Ahora tiene claves propias. Las posiciones guardadas se guardan
  compactas (la nube corta cada preferencia a 2.000 caracteres).
- **«Comprobar web» fallaba siempre** en su última prueba: pedía las cabeceras a `/login.html`, que ahora redirige a
  `/login`. Ahora las pide a `/login`.
- **Opciones ajustadas mezcladas con las normales.** Tras un split, un spin-off o una fusión, las opciones antiguas
  pasan a otra raíz (HON2, BABA2, PANW1…) y entregan otra cesta, no 100 acciones. Entraban en la GEX y en el forward
  como si fueran normales: en HON eran el 47 % del open interest y en BABA el 10 %. Ahora se descartan, igual que
  productos raros como B1SPY o SPXO. En HON (filtro de 45 días) el flip pasa de 206,6 a 210,4 y el Call Wall de 230 a
  240. Las fotos ya guardadas en el historial de esos tickers conservan el cálculo antiguo.

## 2026-11-10 — Web en inglés, tema claro revisado y curva VIX en directo y frente a la sesión anterior; IV sobre el forward implícito; la lista del historial diario alimenta toda la web; pre-market en el TRACE; lentes Delta y Charm Pressure en el TRACE

**Añadido**
- **Lentes del TRACE (desplegable «Lens» de la cabecera del mapa), como en el TRACE de SpotGamma:**
  - **Gamma:** el mapa de siempre (por strike o total).
  - **Delta Pressure:** lo que los dealers comprarían (violeta) o venderían (magenta) para seguir cubiertos si el
    precio fuera desde donde estaba a esa hora hasta cada nivel. Con gamma positiva, venta encima y compra debajo
    (frenan el precio); con gamma negativa, al revés (lo aceleran).
  - **Charm Pressure:** lo que comprarían o venderían durante la hora siguiente solo por el paso del tiempo, con el
    precio quieto en cada nivel. Hacia el cierre, la línea donde cambia de signo marca las zonas de pin. Se apaga en
    los últimos 15 minutos.
  - Delta y Charm no se precalculan en el motor: se calculan al pedirlos (en la nube, en el navegador, y solo se
    repiten cuando el motor publica datos nuevos). Con todos los vencimientos de SPX tardan como la lente Gamma.
- **Más opciones del mapa**, a mano como en SpotGamma: en la cabecera, desplegables de lente y de velas junto a
  Key levels, Settings y Export; encima de la columna de barras, desplegable de qué muestran y el interruptor 0DTE.
  En Settings quedan el color del mapa (Gamma), la sesión, la escala de color y las curvas de nivel. En el móvil
  la cabecera pasa a dos líneas.
  - **Curvas de nivel** al 25, 50 y 75 % de la escala de color (y en Delta y Charm, la del cero, más marcada). Donde
    se juntan, el valor cambia deprisa. Se pueden quitar.
  - **Velas de 1, 5 o 15 minutos.**
  - **Escala de color:** Auto (la de siempre), baja, media o alta (color pleno al 25, 50 o 100 % del máximo).
  - **Zoom vertical:** arrastrar arriba o abajo sobre el mapa; doble clic o «Reset zoom» para volver.
  - **Barras de la izquierda:** GEX, open interest (calls a la derecha, puts a la izquierda) o contratos netos de
    los dealers, de todos los vencimientos del filtro o solo del próximo (0DTE). El tooltip da los valores de la
    barra dibujada.
- **Workflow de estudios (`estudio.yml`):** ejecuta un script de `pruebas/` con lectura del estado del motor y del
  historial diario en R2, para comparar configuraciones con el historial propio. Solo lee; no cambia nada de la web.
  `pruebas/estudio_0dte.py` compara las cuatro configuraciones del 0DTE (Neto/Perfil, estándar/flujo) con lo que
  hizo el precio: rango entre muros, rechazo o rotura en cada toque y volatilidad por encima y por debajo del flip.
  `pruebas/estudio_inventario.py` cuenta el historial disponible.
- **El historial diario alimenta toda la web:** cada día, tras el cierre (desde las 16:20 ET), el motor calcula
  una vez todos los tickers de la lista del historial diario que no están en ninguna watchlist, igual que los de
  las listas. Así acumulan historia para el Volatility dashboard (cambio diario de la matriz por strike fijo,
  sesión anterior y hace una semana, percentiles 10-90 a partir de 15 sesiones), el Histórico y el modo flujo, y
  se abren al instante con los datos del último cierre en lugar del aviso «Downloading … in the cloud». La pasada
  se reparte entre los ciclos de después del cierre y no repite los ya hechos en la sesión.
- **Pre-market en el TRACE:** el mapa de SPX, NDX, RUT, SPY, QQQ e IWM empieza a las 07:00 ET. Antes de la
  apertura muestra, atenuadas, las velas del ETF fuera de horario (SPY, QQQ, IWM), escaladas al índice, y
  una línea discontinua a las 09:30. Desde las 09:40 esas velas se reescalan con la relación índice/ETF del día, así
  que empalman sin salto con el índice real (también el día del dividendo del ETF). Antes de abrir, el precio y los
  niveles van con la última vela y el motor rápido se actualiza cada 5 min desde las 07:05. El open interest sigue
  siendo el del cierre anterior: en ese tramo el mapa cambia con el precio. Pruebas con datos reales en
  `pruebas/tradier_premarket.py` y `pruebas/premarket_mapa.py`.

**Cambiado**
- **Velas de 1 minuto de Tradier** (antes de 5) para los índices en tiempo real, también en el tramo previo a la
  apertura: el mapa puede mostrarlas a 1, 5 o 15 minutos.
- **Toda la web en inglés:** menús, gráficos, tooltips, glosario, avisos, mensajes de error, inicio de sesión y
  administración. Las cifras usan el formato inglés (7,550.25) y las fechas van como «Nov 13»; el spot manual se
  escribe con punto decimal. Las etiquetas del COT, la forma de la curva VIX y los nombres del calendario de eventos
  pasan a inglés en el siguiente ciclo del motor. El registro de cambios sigue en español.
- **Tema claro:** colores con más contraste sobre blanco (acento, ámbar, verde y texto tenue), sombra leve en los
  paneles, y gráficos con colores propios del tema: líneas del vencimiento mensual, vencimientos del skew, matriz de
  volatilidad, índices VIX9D–VIX1Y, puntos del Compass, cierre anterior e histórico. La página de acceso respeta el
  tema elegido.
- **Tema claro más firme:** textos y bordes más oscuros, colores de nivel más saturados y letra más gruesa en el menú
  lateral, las etiquetas y las cifras. En el Impacto calls y puts las barras por strike van en gris para no
  confundirse con la línea de gamma total.
- **Vol Trigger / Hedge Wall** en naranja (antes ámbar como el Gamma Flip) en los dos temas.
- **Curva VIX:** compara con la sesión anterior y con hace una semana, como el Volatility dashboard; se quita la
  curva de hace un mes. La sesión anterior aparece en el gráfico, la leyenda y los tooltips.
- **Curva VIX en directo:** con el mercado abierto, la línea principal («Today») es la curva de hoy: el precio de
  cada futuro VX implícito en las opciones del VIX (paridad put-call), actualizado en cada ciclo del motor e
  incluidos los vencimientos semanales; el último cierre oficial pasa a ser la sesión anterior. Cuando CBOE publica
  la liquidación, la principal vuelve a ser el cierre oficial («Last close» con su fecha). El panel de la izquierda
  (forma, VIX, M1, M2, pendiente, futuro a 30 días y racha) también pasa a directo mientras exista esa curva.
- **Sin el separador «·» en la web:** los textos de estado, tooltips, títulos de pestaña, la imagen exportada y
  la administración usan comas, paréntesis o guion (por ejemplo «Live 17:04, implied by VIX options»).

**Corregido**
- **TRACE del VIX tras el cierre con Delta o Charm Pressure:** daba «boolean index did not match indexed array». Al
  repetir una sesión con su copia guardada de la cadena, se mezclaban precios bid/ask de la cadena actual (con otro
  número de contratos). Ahora la copia se usa sola.
- **Saltos del skew en el spot:** la IV se calculaba con el spot, y antes de la apertura (o con dividendos en los ETF)
  ese spot no coincide con el precio que descuentan las opciones, así que puts y calls daban IV distintas en el mismo
  strike (en NDX, de 27 % a 42 % en el vencimiento de 3 días). Ahora el motor saca el forward de cada vencimiento por
  paridad put-call y calcula sobre él la IV (punto medio bid/ask, Black-76), la delta y la elección de la opción
  fuera de dinero, con Tradier y con CBOE. Mejora el skew, la estructura temporal (IV ATM en el forward), la
  matriz, el risk reversal, el movimiento esperado y las IV que usan los dos motores de gamma; los niveles GEX apenas
  cambian. La sesión anterior del skew sigue con el método viejo hasta que se guarde una copia nueva (mañana).
- **Call Wall y Put Wall (motor Perfil)** dependían del rango visible: en BABA el Hub a ±20 % daba la Call Wall en
  120 y el Escáner (5 %) en 110. Ahora se buscan en un rango fijo por activo: ±10 % en índices y sus ETF (SPX, NDX,
  RUT, SPY, QQQ, IWM…), ±20 % en acciones y ±100 % en el VIX. Hub, Escáner, Compass e histórico dan la misma wall;
  si cae fuera del gráfico, su etiqueta aparece en el borde con una flecha.
- Al cambiar de tema sin recargar, la curva VIX, el resumen, el COT y el glosario mantenían los colores del tema
  anterior.
- En el modo PC, la actualización automática daba un error cada minuto.
- En el mapa (TRACE), el rótulo de las barras por strike se montaba sobre sus cifras.
- **Curva VIX:** el cierre de los futuros del día aparece en el primer ciclo del motor tras publicarlo CBOE (se busca
  desde las 16:00 ET, 22:00 en España) en vez de al día siguiente a las 13:45. Se toma de la liquidación diaria de CBOE hasta que llega a sus archivos históricos, de
  madrugada; mientras tanto, el tooltip de cada vencimiento da el open interest de la sesión anterior y el volumen
  como pendiente.
- **Informe (Export ▸ Report):** fallaba con «Could not create the image» porque el título «Call & put impact»
  llevaba un `&` sin escapar y el SVG del informe dejaba de ser XML válido. Afectaba también a copiar o descargar
  la imagen de la vista Impact.
- **Informe:** el logo de GEX Lab se montaba sobre la primera cifra clave; pasa al pie, junto a la hora de
  generación. La pastilla «Negative gamma» cortaba la última letra: los anchos de texto de las imágenes exportadas
  se miden ahora con el grosor real y con la fuente de respaldo, que es la que dibuja el navegador en una imagen.

## 2026-11-09 — Menú Exportar más corto

**Cambiado**
- **Exportar:** se quita «Descargar PNG»; quedan Copiar imagen, Informe completo y Niveles para TradingView.
- Documentación interna: la guía de trabajo (`CLAUDE.md`) se resume y su detalle pasa a `docs/ARQUITECTURA.md`;
  los pendientes e ideas, a `docs/ESTADO.md`.

**Corregido**
- «Informe completo» salía desplazado a la derecha en el menú Exportar.

## 2026-11-08 — Índices en tiempo real, delta y open interest, panel de opciones, administración y motores Neto / Perfil

**Añadido**
- **Índices en tiempo real:** SPX, NDX, RUT, SPY, QQQ e IWM se recalculan cada 5 minutos con el mercado abierto
  (de 09:35 a 16:05 ET), con la cadena de opciones de Tradier en tiempo real.
  - El mapa del TRACE de SPX, SPY, QQQ e IWM usa velas de 5 minutos de Tradier, sin retraso: cada 5 minutos aparece la
    vela que acaba de cerrar (la vela en curso no se muestra; en el SPX, nada después del cierre). Tradier no da velas
    de NDX ni de RUT: su mapa sigue con las de CBOE, aunque sus niveles se recalculan igualmente cada 5 minutos.
- **Panel de opciones del gráfico** (botón con lo elegido, p. ej. «Gamma · Total · 1 línea»), con interruptores y una (i)
  en cada opción que explica qué hace:
  - Tipo de gráfico: Gamma, **Delta** (nuevo), Vanna, Charm y Open interest.
  - **Líneas** sobre Por strike, con su eje a la derecha, en Gamma y en Delta: total, del próximo vencimiento, del
    vencimiento mensual, total sin el próximo y total sin el mensual (varias a la vez). El tooltip da su valor.
  - Barras de cada tipo; en el Mapa, color y sesión.
- **Interruptor «Niveles clave»** en la cabecera del gráfico (Por strike, Mapa e Impacto): muestra u oculta las
  etiquetas y líneas de los niveles en cualquier tipo de gráfico.
- **Delta** por strike: la delta que tienen los dealers en cada strike, en $, total o de calls y puts (lado a lado).
- **Open interest** por strike: contratos abiertos de calls (arriba) y puts (abajo); su **cambio diario**, contratos
  abiertos o cerrados en la última sesión (solo en los tickers de las listas, de los que el motor guarda el open
  interest de cada sesión); y el **posicionamiento neto** de los dealers en contratos (convención estándar o, con
  «Dealers: flujo», el estimado). Bajo los botones, los totales; el tooltip da las cifras de cada strike.
- **Página de administración** (`/admin`, botón «Administración» de la barra lateral, solo para el administrador):
  - Estado: pista con los ciclos del motor del día (arriba el ciclo completo, abajo el de los índices; terminados, con
    error o en marcha), estado del motor, de los índices, del historial diario y del espacio ocupado en R2 (de los
    10 GB gratis), errores del último ciclo y últimas ejecuciones con enlace al registro de GitHub.
  - Usuarios: alta, último inicio de sesión, tamaño de su lista y sesión abierta; cambiar contraseña, activar,
    desactivar y borrar.
  - Configuración: lista del historial diario y nueva lista de tickers fijos que el motor calcula siempre.
  - Acciones: lanzar un ciclo del motor o guardar el historial diario (con opción de rehacer la última sesión) y subir
    el historial del PC.
  - Cambios: este registro.
- **Marca de agua** en las imágenes (Copiar, PNG): logo y «GEX Lab» arriba a la derecha y el logo grande, gris y muy
  tenue en el centro, detrás del gráfico. En el Informe, el logo y el nombre arriba a la derecha. En pantalla no cambia.
- **Barras ▸ Vencimiento** (TRACE y Equity Hub, Por strike): bajo los botones del gráfico, cada tramo con su fecha, si
  es semanal o mensual, los días que faltan y su peso en la gamma; el tooltip desglosa el strike por tramos.
- El historial diario mide al terminar el espacio ocupado en R2 por carpeta.

**Cambiado**
- **Letra nueva en toda la web:** IBM Plex Sans (antes Inter), también en los gráficos y en las imágenes exportadas, con
  cifras de ancho fijo para que las columnas de números queden alineadas.
- **Cabecera de los gráficos más limpia:** el tipo de gráfico, las barras y las opciones del mapa pasan al panel de
  opciones; Informe, Copiar, PNG y TradingView, al menú «Exportar».
- **Barras ▸ Vencimiento:** cada barra se reparte en el próximo vencimiento (0DTE, verde azulado), cada semanal
  (violetas) y cada mensual (corales), dentro del filtro de vencimientos elegido, en vez de «próximo + resto». Los
  diarios de lunes a jueves se suman al semanal o mensual de su semana, así la barra sigue sumando la GEX total. Más
  allá de 12 semanas, los posteriores van juntos en gris. La leyenda muestra una muestra por tipo.
- **Motores:** se llaman **Neto** (antes «gexbot») y **Perfil** (antes «SpotGamma»). Nuevo motor por defecto para
  todos, **Auto**: Neto con el vencimiento 0DTE y Perfil con los demás; se puede fijar uno en Ajustes del modelo.
  Escáner, Compass y Validación usan siempre Perfil.
- El resto de tickers sigue cada 15 minutos (opciones de Tradier, velas de CBOE con ~15 min de retraso). Con la
  actualización automática, la web recarga cada minuto los seis índices y cada 5 minutos el resto.
- El pie de la página, la información de la fuente y el pie del Informe indican la fuente real de las opciones y qué
  se actualiza cada 5 y cada 15 minutos.
- Rango manual: hasta ±75 % (antes ±30 %). Los contratos se consideran hasta un 20 % más allá del rango elegido
  (antes, como mucho a ±35 % del precio) y el perfil ya no puede llegar a precio cero.
- Equity Hub ▸ Impacto calls y puts: la línea del vencimiento indica día, tipo y días que faltan.
- Las definiciones que aparecen al dejar el ratón sobre un nivel o un dato ya no muestran «Cómo se calcula aquí»:
  solo qué es y para qué sirve.
- La ventana de usuarios de la app se sustituye por la página de administración.

**Corregido**
- Escáner: un ticker recién añadido a la lista podía quedarse «calculando» hasta 15 minutos, porque solo aparecía
  tras el siguiente ciclo completo del motor. Ahora su fila se calcula al momento en el navegador.
- Al abrir un ticker un día nuevo (antes de la apertura o en fin de semana) se recalculaba en el navegador y se pedía
  una descarga nueva aunque los datos publicados fueran los del último cierre. Fuera de sesión, ahora solo se
  consideran antiguos los datos anteriores al último cierre del mercado, y se muestran al momento.
- Barras por vencimiento con zoom: los tramos de cada barra no se recortaban con el zoom y podían no coincidir con su
  strike.
- Barra de zoom bajo los gráficos (TRACE y Equity Hub): al arrastrar un extremo más allá del borde, la barra temblaba.
  Ahora el botón «Todo» ocupa siempre su sitio y la pista mantiene su medida mientras se arrastra.
