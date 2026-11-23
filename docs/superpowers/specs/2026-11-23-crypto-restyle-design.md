# Restyle de Crypto y del mapa de liquidaciones

Fecha: 2026-11-23. Estado: aprobado en la conversación; falta revisar este texto.

## Objetivo

La página Crypto y la pestaña Liquidations tienen demasiada información a la vez: la columna izquierda ocupa una
quinta parte del ancho en todas las pestañas, el mapa dibuja cientos de rayas finas y los controles ocupan dos filas.
Se busca que se lea de un vistazo, como Coinfuty, sin perder datos ni cambiar el modelo.

## 1. Página Crypto: tira de resumen en vez de columna

- Se quita `aside.cx-side`. En su lugar, una fila encima de las pestañas (`#cxStrip`), visible en todas:
  selector BTC/ETH, nombre y precio, cambio 24 h (7 d y 30 d en el `title`), estado (`lec.resumen`, pequeño y con su
  color de tono), cuatro cifras (Net GEX, MVRV, DVOL, Fear & Greed) y la hora de actualización. Si el dato es viejo
  (`a.viejo`) o fallan fuentes (`d.errores`), un aviso corto en la misma fila.
- La lectura completa (píldoras Trend y Positioning, puntos con «Show N more», las seis cifras con contexto, el aviso
  de señales y «All numbers») pasa a un panel nuevo, primero de la pestaña Overview (`data-tabs="overview"`).
- `cxSide` se divide en `cxStrip` (la fila) y `cxReading` (el panel de Overview); los ids internos (`cxRead`,
  `cxKpis`, `cxFacts`, `cxSigLink`, `cxErr`) se conservan donde tenga sentido para no tocar el resto.
- `.cx-main` ocupa todo el ancho. En móvil la tira hace salto de línea (precio y estado arriba, cifras debajo).

## 2. Mapa de liquidaciones: zonas en vez de rayas

- **Suma por zona.** El modelo añade una rejilla `gZ`: en cada tramo y vela, la suma de `gV` de los tramos a menos de
  `LQ_ZONA` (±0,4 %) en precio logarítmico. El mapa pinta `gZ` (cada fila, el valor máximo de los tramos que cubre,
  como hoy) y la escala `topeV` sale de `gZ`. Así los niveles cercanos se juntan en una zona continua.
- **Sin hueco entre filas.** `LQ_BANDA` deja de reservar 1 px vacío; las filas contiguas con valor forman un bloque.
- **Sin fragmentos.** Un nivel que el precio toca antes de `LQ_VIDA_MIN` velas (6, a ajustar con datos) no entra en la
  rejilla de dibujo; si sigue vivo en la última vela, entra siempre.
- **Intensidad mínima por defecto más alta** (20 %, a ajustar para que ETH y BTC en 1D y 15m queden con 10 a 20
  zonas visibles). Clave de preferencia nueva (`lqMin5`) para que se aplique el nuevo valor.
- **Todo de la misma fuente.** Perfil, líneas Longs y Shorts, `presion`, `grupos`, tooltip y «Nearest liquidity»
  pasan de `gV` a `gZ` (`ahora` lee la última columna de `gZ`). El tooltip enseña el rango de la zona (±0,4 %) y la
  suma; el desglose por apalancamiento y fechas sigue saliendo de `niveles` dentro de ese rango.
- La paleta, la curva `LQ_CURVA` y el filtro de apalancamientos no cambian.

## 3. Liquidations: una fila de controles

- Visibles: activo (desplegable con buscador que sustituye a la caja de texto y a los diez botones rápidos; los
  populares arriba), marcos 5m a 1D, Settings, Copy y Full screen.
- Settings (popover, mismo patrón que el desplegable de exchanges): apalancamientos, intensidad mínima, exchanges y
  atajos Swing y Scalp. Se cierra al pulsar fuera o con Esc.
- Fuera: Older (`lqMas`, `lq.extra`) y Expand (`lqGrande` y su modal). Full screen se queda.
- Leyenda de color (`#lqEscala`) debajo del mapa, a la izquierda; a la derecha, una línea con el veredicto y la
  liquidez más cercana a cada lado. Las tarjetas (grupos y fiabilidad) y «How to read» van en un `<details>` Details.

## 4. Errores de carga

- El Worker (`liq` en `nube/worker.js`) y `liq_local.py` solo guardan en caché respuestas de Coinalyze que sean una
  lista JSON; cualquier otra cosa se devuelve como 502 con un mensaje en inglés, sin cachear.
- `lqPedir` comprueba que la respuesta sea una lista; si no, error «The data source sent an unexpected answer».
- Si falla la carga de un activo o marco nuevo, el mapa anterior no se queda como si fuera el pedido: se vacía y se
  enseña el mensaje con un botón Retry, y el desplegable de activo sigue marcando lo pedido.

## Fuera de alcance

El modelo de cálculo (`calcular`, pesos, memoria), el resto de pestañas de Crypto salvo el ancho, el panel de
liquidaciones reales y los temas.

## Pruebas

- `node --test pruebas/test_liq.mjs`: `gZ` suma los tramos de ±`LQ_ZONA`; un nivel de vida corta no entra y uno vivo
  al final sí; `grupos` y `presion` caen sobre filas de `gZ` que pasan el umbral; `topeV` sale de `gZ`.
- `node --check` de `web/liq.js`, `web/liq-modelo.js`, `web/cripto.js` y `nube/worker.js`.
- Visual en el PC (`server.py`, datos públicos de Binance) en tema claro y oscuro, escritorio y móvil: tira, Overview,
  Liquidations con BTC y ETH en 1D y 15m. En producción, si se puede acceder.
- `CHANGELOG.md` y `docs/CRIPTO.md` en el mismo push.
