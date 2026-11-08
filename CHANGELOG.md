# Registro de cambios

Cada push a `main` añade aquí una entrada, la más reciente arriba: fecha, título y qué cambia para el usuario
(**Añadido**, **Cambiado**, **Corregido**). Los detalles técnicos están en el commit.

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
