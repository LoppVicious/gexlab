# Registro de cambios

Una entrada por día, la más reciente arriba: fecha, título y qué cambia para el usuario (**Añadido**, **Cambiado**,
**Corregido**). Cada push de ese día amplía la entrada del día. Los detalles técnicos están en los commits.

## 2026-11-11 — Compass con estela de historial, cabecera propia y pantalla completa; Validación con el historial diario; Open Interest y Options Lab

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

**Cambiado**
- El Compass tiene cabecera propia (título, historial y ampliar) dentro de su recuadro, como los desplegables del
  TRACE.
- El cuadro «Add ticker» de la barra del escáner solo sale en la vista Tabla.
- La estela ya no exige 60 sesiones de historial propio: sale desde la segunda sesión guardada. Mientras un eje es
  provisional (comparado con la lista), la estela de ese eje se mueve a saltos.

**Corregido**
- **La web dejó de pintar gráficos** (TRACE, Equity Hub, Volatility dashboard…: «yt.ticks is not iterable»): una
  función de las herramientas nuevas se llamaba igual que la de los ejes de `app.js` y la sustituía. Renombrada.
- **Open Interest no cargaba en la nube** («undefined is not a function»): su preferencia de vencimientos usaba la
  misma clave que el modo de OI del Equity Hub. Ahora tiene claves propias. Las posiciones guardadas se guardan
  compactas (la nube corta cada preferencia a 2.000 caracteres).

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
