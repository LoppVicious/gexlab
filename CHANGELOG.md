# Registro de cambios

Cada push a `main` añade aquí una entrada, la más reciente arriba: fecha, título y qué cambia para el usuario
(**Añadido**, **Cambiado**, **Corregido**). Los detalles técnicos están en el commit.

## 2026-11-08 — Escáner y tickers más rápidos, marca de agua en las imágenes

**Añadido**
- Marca de agua en las imágenes (Copiar, PNG): logo y «GEX Lab» arriba a la derecha y el logo grande, gris y muy
  tenue en el centro, detrás del gráfico. En el Informe, el logo y el nombre arriba a la derecha. En pantalla no cambia.

**Corregido**
- Escáner: un ticker recién añadido a la lista podía quedarse «calculando» hasta 15 minutos, porque solo aparecía
  tras el siguiente ciclo completo del motor. Ahora su fila se calcula al momento en el navegador.
- Al abrir un ticker un día nuevo (antes de la apertura o en fin de semana) se recalculaba en el navegador y se
  pedía una descarga nueva aunque los datos publicados fueran los del último cierre. Fuera de sesión, ahora solo
  se consideran antiguos los datos anteriores al último cierre del mercado, y se muestran al momento.
- El pie del Informe indica la fuente real de las opciones (Tradier o CBOE).

## 2026-11-08 — Barras por vencimiento: próximo, semanales y mensuales

**Cambiado**
- Barras ▸ Vencimiento (TRACE y Equity Hub, Por strike): en vez de un color por cada día de vencimiento, cada barra se
  reparte en el próximo vencimiento (0DTE, verde azulado), cada semanal (violetas) y cada mensual (corales), dentro
  del filtro de vencimientos elegido. Los diarios de lunes a jueves se suman al semanal o mensual de su semana, así
  la barra sigue sumando la GEX total. Más allá de 12 semanas, los posteriores van juntos en gris.
- La leyenda del gráfico muestra una muestra por tipo; bajo los botones, cada tramo con su fecha, los días que faltan
  y su peso en la gamma; el tooltip desglosa el strike por tramos.

## 2026-11-08 — Índices en tiempo real cada 5 minutos

**Añadido**
- SPX, NDX, RUT, SPY, QQQ e IWM se recalculan cada 5 minutos con el mercado abierto (de 09:35 a 16:05 ET), con la
  cadena de opciones de Tradier en tiempo real.
- El mapa del TRACE de SPX, SPY, QQQ e IWM usa velas de 5 minutos de Tradier, sin retraso: cada 5 minutos aparece la
  vela que acaba de cerrar (la vela en curso no se muestra; en el SPX, nada después del cierre). Tradier no da velas
  de NDX ni de RUT: su mapa sigue con las de CBOE, aunque sus niveles se recalculan igualmente cada 5 minutos.
- Administración: la pista de ciclos separa el ciclo completo (arriba) del de los índices (abajo), y el bloque del
  motor indica el último ciclo de los índices.

**Cambiado**
- El resto de tickers sigue cada 15 minutos (opciones de Tradier, velas de CBOE con ~15 min de retraso).
- Con la actualización automática activada, la web recarga cada minuto esos seis índices y cada 5 minutos el resto,
  para mostrar los datos nuevos en cuanto el motor los publica.
- El pie de la página y la información de la fuente explican qué se actualiza cada 5 y cada 15 minutos.

## 2026-11-08 — Deslizador de zoom estable y definiciones sin cálculo

**Cambiado**
- Las definiciones que aparecen al dejar el ratón sobre un nivel o un dato ya no muestran «Cómo se calcula aquí»:
  solo qué es y para qué sirve.

**Corregido**
- Barra de zoom bajo los gráficos (TRACE y Equity Hub): al arrastrar un extremo más allá del borde, la barra temblaba.
  El botón «Todo» aparecía y desaparecía y la pista cambiaba de ancho durante el arrastre; ahora el botón ocupa
  siempre su sitio y la pista mantiene su medida mientras se arrastra.

## 2026-11-08 — Página de administración, motores Neto / Perfil y barras por vencimiento

**Añadido**
- Página de administración propia (`/admin`, botón «Administración» de la barra lateral, solo para el administrador):
  - Estado: pista con los ciclos del motor del día (terminados, con error, en marcha), estado del motor, del historial
    diario y del espacio ocupado en R2 (de los 10 GB gratis), errores del último ciclo y últimas ejecuciones con enlace
    al registro de GitHub.
  - Usuarios: alta, último inicio de sesión, tamaño de su lista, sesión abierta; cambiar contraseña, activar,
    desactivar y borrar.
  - Configuración: lista del historial diario y nueva lista de tickers fijos que el motor calcula siempre.
  - Acciones: lanzar un ciclo del motor o guardar el historial diario (con opción de rehacer la última sesión) y subir
    el historial del PC.
  - Cambios: este registro.
- El historial diario mide al terminar el espacio ocupado en R2 por carpeta.

**Cambiado**
- Los motores se llaman **Neto** (antes «gexbot») y **Perfil** (antes «SpotGamma»).
- Nuevo motor por defecto para todos, **Auto**: Neto con el vencimiento 0DTE y Perfil con los demás. Se puede fijar
  uno en Ajustes del modelo.
- Escáner, Compass y Validación usan siempre Perfil.
- La ventana de usuarios de la app se sustituye por la página de administración.
- Barras ▸ Vencimiento (TRACE y Equity Hub, Por strike): cada barra se reparte por vencimientos, cada uno con su color
  en una misma gama (verde azulado el más próximo, violeta los lejanos), en vez de «próximo vencimiento + resto». Los 11
  más próximos llevan color propio y los posteriores van juntos en gris. Bajo los botones se ve cada vencimiento con
  su color y su peso en la gamma, y el tooltip desglosa el strike por vencimiento.

## 2026-11-08 — Rango hasta el 75 % y vencimientos detallados

**Añadido**
- Barras ▸ Vencimiento (TRACE y Equity Hub, Por strike): bajo los botones del gráfico se indica el próximo
  vencimiento con su día, si es diario, semanal o mensual, los días que faltan y su parte de la gamma, y qué hay en
  el resto (fechas y cuántos vencimientos de cada tipo).
- Cada cálculo devuelve la lista de vencimientos que incluye, con su tipo y su parte de la gamma (`expiries`).

**Cambiado**
- Rango manual: hasta ±75 % (antes ±30 %). Los contratos se consideran hasta un 20 % más allá del rango elegido
  (antes, como mucho a ±35 % del precio) y el perfil ya no puede llegar a precio cero.
- Equity Hub ▸ Impacto calls y puts: la línea del vencimiento indica día, tipo y días que faltan.
- La leyenda del gráfico en modo Vencimiento es corta para que no desaparezca en pantallas estrechas.
- La regla de vencimiento mensual (tercer viernes; en el VIX, su miércoles) vive en `gex_engine` y la comparten el
  panel de volatilidad y el resto de la app.
