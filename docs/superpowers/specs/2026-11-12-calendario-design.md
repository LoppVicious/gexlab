# Calendario económico: dato real, aviso a la hora del evento y página Calendar

Fecha: 2026-11-12 (revisión 2: Nasdaq descartado). Estado: aprobado en conversación.

## Objetivo

1. En el Summary, al pasar el ratón (o tocar en móvil) sobre un evento de la semana, una tarjeta con Actual,
   Forecast y Previous.
2. Una página **Calendar** con los países grandes, filtro de países por casillas y filtro de importancia.
3. El dato real aparece en la web en cuanto la fuente lo tiene: a la hora del evento + 1 min se lanza un ciclo
   **solo del calendario** (sin tickers ni cadenas), con reintentos mientras falte el dato.

## Fuentes (comprobadas el 2026-11-12 desde GitHub Actions con Python)

- **Nasdaq, descartado:** `api.nasdaq.com` es el servicio interno de su web, con protección antibots: 403 a
  Python desde el PC y desde Actions. No se intenta esquivar.
- **ForexFactory** (`nfs.faireconomy.media/ff_calendar_thisweek.json`, sin clave): la semana en curso de todas las
  divisas grandes con `title, country (divisa), date, impact, forecast, previous`. **No trae `actual`** (el campo
  no existe). Limita peticiones: como mucho una por hora.
- **BLS** (API v2, `api.bls.gov`, clave gratuita `BLS_API_KEY`, 500 consultas/día): CPI, nóminas, paro, salario
  por hora, PPI y JOLTS en el minuto de la publicación. Probado sin clave: responde y coincide con FRED.
- **FRED** (`FRED_API_KEY`, ya configurada): el resto de EE. UU. Retraso medido sobre la publicación oficial:
  peticiones de desempleo 4 min, inicios de vivienda 3, ventas minoristas 8, PCE 13, PIB 31, venta de viviendas
  4-7, JOLTS 10; CPI 42 min, PPI 1 h 50, nóminas 2 h 13, bienes duraderos 2 h (estos cuatro, mejor por BLS salvo
  bienes duraderos, que es de Census). Michigan llega con un mes de retraso: no sirve. ISM y Conference Board no
  están en FRED: sin dato real.
- **Fuentes oficiales** de fechas de EE. UU. (Fed, BEA, Census, FRED releases), como ahora: dan el futuro lejano
  que necesita la estructura de volatilidad.

Consecuencia: dato real solo de EE. UU. (los indicadores de la tabla `REALES`). El resto de países muestra
forecast y previous; su actual queda en `—`.

## Datos

### `eventos.py`: ForexFactory multipaís

- Divisa → país: `USD US, EUR EZ, GBP GB, JPY JP, CNY CN, CAD CA, AUD AU, CHF CH` (NZD y otras, fuera). Dentro de
  EUR, el título manda: `German … → DE`, `French … → FR`, `Italian … → IT`.
- Importancia: `High 3, Medium 2, Low 1`; `Holiday` y `Non-Economic` fuera. Desaparece la tabla `IMPORTANCIA`.
- Nombre: el título de ForexFactory (`CPI m/m`). Para EE. UU., los títulos de `FF_NAMES` llevan además la
  etiqueta de siempre como `name` (`CPI (Oct)`, `Payrolls (NFP) (Oct)`...) y el título va en `titulo`; así el
  Summary, la estructura de volatilidad y la Validación no cambian y la unión con las fuentes oficiales sigue
  funcionando. Los de EE. UU. sin etiqueta llevan `solo_cal: true` y no salen en `pub/eventos.json`.
- Lo visto se conserva en el estado: las semanas pasadas se van acumulando (otros países, 35 días).
- Refresco completo (todas las fuentes) como mucho cada hora, en el ciclo de 15 min.

### `reales.py`: dato real de EE. UU.

Tabla `REALES`: título de ForexFactory → (fuente, serie, transformación, unidad base, periodicidad):

| Título FF | Fuente y serie | Cálculo |
|---|---|---|
| CPI m/m · Core CPI m/m | BLS CUSR0000SA0 · CUSR0000SA0L1E | % mensual |
| CPI y/y · Core CPI y/y | BLS CUUR0000SA0 · CUUR0000SA0L1E | % anual |
| Non-Farm Employment Change | BLS CES0000000001 | diferencia (miles) |
| Unemployment Rate | BLS LNS14000000 | nivel % |
| Average Hourly Earnings m/m | BLS CES0500000003 | % mensual |
| PPI m/m · Core PPI m/m | BLS WPSFD4 · (código a confirmar con el catálogo) | % mensual |
| JOLTS Job Openings | BLS JTS000000000000000JOL | nivel (miles), mes del dato: 1 atrás si sale el día 20 o después, si no 2 |
| Retail Sales m/m · Core Retail Sales m/m | FRED RSAFS · RSFSXMV | % mensual |
| Core PCE Price Index m/m · PCE Price Index m/m | FRED PCEPILFE · PCEPI | % mensual |
| Unemployment Claims | FRED ICSA | nivel, semanal |
| Advance GDP q/q (solo Advance: Prelim y Final no tienen comprobación fiable de "nuevo") | FRED A191RL1Q225SBEA | nivel %, trimestral |
| Durable Goods Orders m/m · Core … | FRED DGORDER · ADXTNO | % mensual |
| Housing Starts · Building Permits | FRED HOUST · PERMIT | nivel (miles) |
| New Home Sales · Existing Home Sales | FRED HSN1F · EXHOSLUSM495S | nivel |

- Un dato es el nuevo solo si la observación más reciente es del **periodo esperado** (mes del evento menos el
  retraso; trimestre de hace 3 meses para el PIB; semana que acaba como mucho 7 días antes para las peticiones semanales).
  La fecha "desde cuándo vale" de FRED no sirve: cambia con las revisiones.
- Formato como ForexFactory: decimales y sufijo (`%`, `K`, `M`, `B`) del `previous` o el `forecast` del evento.
- Se rellenan eventos de EE. UU. de los últimos 2 días con hora pasada, sin `actual` y con entrada en `REALES`.
  Cada evento lleva `real: true` si tiene fuente de dato real.
- BLS: una sola petición POST con todas las series necesarias. FRED: una por serie. Caché por ejecución.

### Publicación

- `pub/eventos.json`: EE. UU. sin `solo_cal` (como hoy) + `country, titulo, actual, forecast, previous, real`.
- `pub/calendario.json`: `{eventos, actualizado}` con todos los países, de 14 días atrás a 28 adelante (más allá
  de la semana en curso solo hay fechas oficiales de EE. UU., sin forecast).
- `pub/eventos_horas.json`: `{horas}` instantes de aviso.

## Modo `calendario` del motor

- `motor.py calendario`: trae el estado del calendario de R2 (`estado/eventos.json`), rellena el dato real
  (`reales.rellenar`), guarda y publica. No pide ForexFactory (límite de peticiones) ni toca tickers.
- El estado del calendario va en su propia clave de R2, fuera del tar del ciclo (el modo calendario no puede
  guardar el tar: pisaría al ciclo).
- `motor.yml`: `calendario` en las opciones; `BLS_API_KEY` en el entorno.
- Solo se busca el dato real de eventos de los últimos 2 días (limita la cuota de BLS). Si una fuente falla, las
  demás siguen; solo si todas fallan se registra el error.
- El ciclo de 15 min: refresco completo como mucho cada hora y, siempre, `reales.rellenar` (recoge lo que llegue
  tarde) y publicación.

### Instantes de aviso

Solo hay avisos para eventos de hoy y mañana con importancia 2+, hora, fuente de dato real (`real: true`) y sin
`actual` todavía (el modo calendario no puede actualizar los demás): `T + 1 min` y todos los de
`T + 6, 16, 31, 61, 121 min` que no hayan pasado (si uno recoge el dato, el evento deja de avisar). Sin duplicados.

## Alarma en el Worker (Durable Object)

Sin cambios respecto a la revisión 1: clase `RelojCalendario` (SQLite, plan gratuito), `programar(instantes)`
pone la alarma en el más próximo; `alarm()` lanza `motor.yml` con `modo=calendario` y programa el siguiente;
el cron `*/5` le pasa `pub/eventos_horas.json` en cada tick.

## Web

- **Tarjeta** (Summary y Calendar): título (`titulo` o `name`), país, día y hora local, importancia, Actual,
  Forecast, Previous. Actual: la cifra, coloreada `--pos`/`--neg` según quede por encima o por debajo del
  forecast (solo dirección); `Pending` si `real` y ya pasó la hora; `—` en otro caso.
- **Página Calendar** (sección Market, bajo Summary): tabla por día con hora local, país, evento, importancia,
  Actual, Forecast, Previous; semana actual por defecto, flechas y `Today`; fila del próximo evento marcada;
  filtro **Countries** (11 casillas, `All`/`None`) e importancia mínima (`All`, `Medium+`, `High`), guardados
  en las preferencias; recarga cada minuto. Inglés, temas Bento y Daylight, móvil.

## Errores

- ForexFactory falla o limita (429): se conserva lo guardado; se reintenta en el siguiente refresco (1 h).
- BLS o FRED fallan: el evento sigue sin actual; siguiente aviso o ciclo lo reintenta.
- Carrera ciclo/calendario sobre el estado: los dos traen el estado de R2 justo antes de usarlo; el hueco es de
  segundos y lo cubre el siguiente relleno.

## Pruebas

- Sin red: normalización de ForexFactory, unión por país, avisos y reintentos, cálculo y formato del dato real
  con series de ejemplo.
- En Actions: ForexFactory, BLS y FRED con Python; `motor.yml` con `modo=calendario`.
- En producción: un evento real (CPI, nóminas o peticiones de desempleo) con su run `Motor calendario` a T+1 y el
  actual en la tarjeta.
