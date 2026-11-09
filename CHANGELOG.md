# Registro de cambios

Una entrada por día, la más reciente arriba: fecha, título y qué cambia para el usuario (**Añadido**, **Cambiado**,
**Corregido**). Cada push de ese día amplía la entrada del día. Los detalles técnicos están en los commits.

## 2026-11-09 — Documentación interna reorganizada

**Cambiado**
- Sin cambios en la web. La guía de trabajo (`CLAUDE.md`) se resume y su detalle pasa a `docs/ARQUITECTURA.md`;
  los pendientes e ideas, a `docs/ESTADO.md`.

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
