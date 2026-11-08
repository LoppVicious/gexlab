# Registro de cambios

Cada push a `main` añade aquí una entrada, la más reciente arriba: fecha, título y qué cambia para el usuario
(**Añadido**, **Cambiado**, **Corregido**). Los detalles técnicos están en el commit.

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
