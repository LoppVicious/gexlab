# Report semanal: borrador automático de Take con datos de flujos y volatilidad

Fecha: 2026-11-13. Estado: diseño aprobado en conversación, pendiente de revisar el spec escrito.

## Objetivo

Un report semanal en **Founder Takes**, del estilo de las notas de flujos de los bancos (titular con la conclusión,
cifras con su percentil, gráficos), escrito casi solo. El usuario lo arranca en Claude Code con `/report-semanal`;
el resultado es un **borrador** que el admin revisa y publica.

Solo entra lo que esa semana sea destacable. Si un bloque no tiene nada que contar, no aparece.

## Decisiones

- **Arranque manual.** `/report-semanal` en Claude Code (skill del proyecto). Sin tarea programada por ahora.
- **Actions calcula, Claude Code escribe.** Los datos salen de R2 y de fuentes con clave (FRED), que solo están en
  Actions. Claude Code nunca toca R2 ni Tradier: lee un paquete ya calculado por una ruta del Worker.
- **Coste 0 €.** Actions de repo público, R2 del plan gratuito, la clave de FRED que ya existe y la suscripción de
  Claude Code del usuario. Sin API de pago.
- **Borrador, nunca publicado.** El Worker crea el Take con autor `Claude` y estado `borrador`. Publica el admin.
- **Texto en inglés** (la web está en inglés), voz propia. Nada que imite a un banco o a un analista concreto.
- **Nada inventado.** Las cifras salen del paquete; el contexto de noticias solo con búsqueda web y enlace a la fuente.
- **Fuera de esta versión:** report diario, tarea programada, avisos al publicar, histórico propio de AUM de ETFs.

## Flujo

```
/report-semanal [fecha]                      (Claude Code, PC del usuario)
  1. gh api ... workflows/report.yml/dispatches  inputs[fecha]
  2. espera a que acabe la ejecución (gh api .../runs, cada 30 s, máx. 15 min)
report.yml -> python report_semanal.py --fecha F   (Actions)
  lee hist500/ y FRED, calcula los bloques, dibuja PNG
  escribe R2 report/{F}/paquete.json y report/{F}/g/{nombre}.png
  3. GET  /api/report/{F}                    -> paquete.json
  4. GET  /api/report/{F}/g/{nombre}.png     -> mira los gráficos destacados
  5. redacta título, cuerpo Markdown y elige gráficos
  6. POST /api/report/{F}/take               -> borrador en D1 + PNG copiados a takes/{id}/
  7. dice al usuario el id del borrador; el admin lo revisa en Research ▸ Takes
```

`F` es la última sesión de la semana (normalmente viernes). Sin argumento, el skill toma la última sesión cerrada.
Ejecutarlo dos veces la misma semana crea otro borrador; el skill lo avisa y el admin borra el que sobre.

## Paquete (`report/{F}/paquete.json`)

```json
{
  "version": 1,
  "fecha": "2026-11-13",
  "sesiones": ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"],
  "generado": "2026-11-13 17:05 ET",
  "bloques": {
    "gamma":      {"estado": "ok", "destacado": true,  "por_que": ["QQQ cruzó el flip el jueves"], "datos": {}, "graficos": ["gamma_qqq"]},
    "vol_real":   {"estado": "ok", "destacado": false, "por_que": [], "datos": {}, "graficos": []},
    "etf_apal":   {"estado": "ausente", "motivo": "Sin fuente de AUM para SOXL"},
    "vol_strike": {"estado": "ok", "destacado": true,  "por_que": ["Skew 25P-25C a 1 mes de SPY +1,4 puntos"], "datos": {}, "graficos": ["vol_strike_spy"]}
  }
}
```

- `estado`: `ok` o `ausente` (con `motivo`). Un bloque que falla no rompe los demás.
- `destacado` y `por_que` se calculan con umbrales fijos (constantes al principio de `report_semanal.py`), para que
  la elección no dependa del LLM. Claude escribe solo los bloques destacados; puede citar cifras de los demás como apoyo.
- Cada cifra relevante lleva su percentil y la ventana con la que se calculó.

### Bloque `gamma`: gamma y niveles

- Tickers: los de `GAMMA = SPX NDX SPY QQQ IWM VIX` que tengan `hist500/` esa semana (hoy SPY, QQQ, IWM y VIX).
- Por sesión: spot, gamma neta, flip, call wall y put wall de `levels["standard"]["spotgamma"]["all"]` (posición
  estándar, motor Perfil, todos los vencimientos; foto tras el cierre). Cambio frente a la última sesión de la semana anterior.
- Percentil de la gamma neta frente al último año de `hist500/_niveles/`.
- Destacado si: el spot cruza el flip durante la semana; una wall se mueve más de `UMBRAL_WALL` (2 %); la gamma neta
  está por debajo del percentil 10 o por encima del 90.
- Gráfico por ticker destacado: spot de la semana con flip y walls.

### Bloque `vol_real`: vol realizada y spot-vol

- Series: FRED `SP500` y `NASDAQ100` (cierres diarios, 10 años o más) y el VIX de `hist500/_indices_vol/`.
- Vol realizada anualizada de cierre a cierre de los días de subida y de los de bajada, en la semana y en lo que va de
  mes, y su cociente. Correlación de los retornos del índice con el cambio diario del VIX en 20 sesiones.
- Percentiles frente a toda la serie disponible, con ventanas de la misma longitud.
- Destacado si: el cociente subida/bajada está por debajo del percentil 10 o por encima del 90; la correlación
  spot-vol sale de su rango del 10 al 90; la vol realizada a 20 sesiones supera el percentil 85.
- Gráfico: barras de vol realizada de subida y de bajada por mes, con el mes en curso marcado.

### Bloque `etf_apal`: rebalanceo de ETFs apalancados

- Lista fija con su apalancamiento: TQQQ 3, SQQQ −3, SOXL 3, SOXS −3, UPRO 3, SPXU −3, SPXL 3, TNA 3, TZA −3,
  QLD 2, SSO 2. Se agrupan por índice subyacente.
- Rebalanceo estimado al cierre de cada sesión: `AUM × L × (L − 1) × r`, con `r` el retorno del subyacente del día
  (cierre de su ETF 1x en `hist500/`: QQQ, SPY, IWM o SOXX) y `AUM` = participaciones en circulación × cierre del ETF.
- **Fuente de participaciones en circulación:** por decidir con una prueba previa (`pruebas/prueba_etf_aum.py` en
  `comparar.yml`) sobre las webs de los emisores (ProShares, Direxion). Si no hay fuente gratuita y fiable, el bloque
  sale siempre `ausente` con ese motivo y se documenta.
- Percentil del rebalanceo de cada día frente a un año de retornos con el AUM actual (se dice así en el paquete:
  no hay histórico de AUM).
- Destacado si un día o el total de la semana supera el percentil 90 en valor absoluto.
- Gráfico: barras del rebalanceo por día y por índice.

### Bloque `vol_strike`: vol a strike fijo

- Tickers: SPY y QQQ (y SPX si está en `hist500/`). Cadenas al cierre de `hist500/{SYM}/{fecha}.json.gz`
  (`iv` y `delta` por contrato).
- Vencimientos: el más cercano a 1 y 2 semanas, 1, 2, 3 y 6 meses y 1 año. Strikes: los de delta 10P, 25P, 40P, 50,
  40C, 25C y 10C en la última sesión.
- Cambio de IV en puntos al mismo strike y mismo vencimiento frente a la última sesión de la semana anterior
  (interpolando por strike en la cadena anterior). Skew 25P − 25C y su cambio.
- Destacado si `|cambio ATM 1 mes| ≥ 1,5` puntos o `|cambio skew 25P−25C 1 mes| ≥ 1` punto.
- Gráfico: tabla en color (vencimiento × delta) con los cambios.

### Gráficos

PNG de 1200 px de ancho con matplotlib, fondo propio y la paleta del tema Daylight (los colores de `THEMES` en
`web/app.js`, copiados como constantes en el script con un comentario que lo diga). Se ven bien en los dos temas
porque llevan fondo propio. Las tablas van como imagen: el Markdown de Takes (`web/takes-md.js`) no tiene tablas.

## Worker: rutas `/api/report/*` (`nube/report.js`)

- Autenticación propia: cabecera `Authorization: Bearer <REPORT_TOKEN>`, comparación en tiempo constante. Secreto
  del Worker `REPORT_TOKEN` (`wrangler secret put`). Sin el secreto configurado, las rutas responden 404.
  No usan la sesión de usuario y no sirven para nada más.
- `GET /api/report/ultimo`: devuelve `report/ultimo.json` (`{"fecha": F}`), que el script escribe al acabar; así el
  skill sabe qué semana calculó el workflow cuando no se le pasa fecha.
- `GET /api/report/{F}`: devuelve `report/{F}/paquete.json` (404 si no existe). `F` validada como `YYYY-MM-DD`.
- `GET /api/report/{F}/g/{nombre}.png`: el gráfico; `nombre` validado (`[a-z0-9_]{1,40}`).
- `POST /api/report/{F}/take`: JSON `{titulo, cuerpo, etiquetas, graficos: [{nombre, nota}]}`. Pasa por las mismas
  validaciones y límites de `nube/takes.js` (`LIM`, `limpiarEtiquetas`, `tipoArchivo` sobre los bytes del PNG).
  Crea el Take con autor `Claude` y estado `borrador`, y copia cada PNG a `takes/{id}/<24 hex>.png` como adjunto
  `imagen` en ese orden. Si algo falla a mitad, borra lo creado (Take y archivos). Devuelve `{id}`.
- Reutiliza funciones de `nube/takes.js` en lugar de duplicarlas; si hace falta, se exporta la que crea un Take.

## Skill del proyecto (`.claude/skills/report-semanal/`)

- `SKILL.md`: los pasos del flujo, con los comandos exactos. Comprueba primero que existe la variable de entorno
  `GEXLAB_REPORT_TOKEN`; si no, explica cómo crearla (el token lo genera el usuario y lo pone en el Worker y en su
  PC; nunca se pega en el chat). Si ningún bloque está destacado, lo dice y no crea Take.
- `guia-estilo.md`:
  - Título `Weekly: <conclusión principal>`. Una sección por bloque destacado, de la más importante a la menos.
  - Cada sección abre con un titular que ya dice la conclusión y sigue con el porqué, con cifras y percentiles.
  - Párrafos cortos; 500 a 1.200 palabras en total.
  - Contexto de noticias solo si una búsqueda web lo respalda, con enlace. Sin fuente, no se menciona.
  - Nada de recomendaciones de inversión; lectura de posicionamiento y flujos.
  - Etiquetas `Weekly` y `Auto`. Sin el carácter `·` como separador.

## Workflow (`.github/workflows/report.yml`)

`workflow_dispatch` con entrada `fecha` (opcional). Instala dependencias, ejecuta `python report_semanal.py --fecha F`
con los secretos de R2 y `FRED_API_KEY` que ya existen. No escribe nada en el repo. R2 `report/` no se borra
(pocos KB por semana).

## Errores

- Un bloque que falla queda `ausente` con el motivo, sin rellenar con supuestos.
- Si falta `hist500/` de alguna sesión de la semana, se calcula con las que haya y se dice cuáles faltan.
- El skill se para y lo explica si: falta el token, el workflow falla (enlace a la ejecución), el paquete no existe,
  o el POST devuelve error.

## Pruebas

- `pruebas/test_report.py` sin red: vol realizada de subida y de bajada, rebalanceo de ETFs, IV a strike fijo con
  interpolación, umbrales de destacado y paquete con bloques ausentes. Datos sintéticos.
- `pruebas/test_report_api.mjs`: las rutas del Worker con D1 y R2 imitados, como `test_takes_api.mjs` (token
  incorrecto, fecha mal formada, PNG falso, borrado al fallar a mitad).
- Prueba real: `report.yml` sobre la semana en curso, revisando el paquete y los gráficos antes de dar el skill por
  bueno.

## Documentación

`docs/ARQUITECTURA.md` (sección del report: flujo, claves de R2, rutas, secreto `REPORT_TOKEN`), `CLAUDE.md` (mapa:
`report_semanal.py`, `nube/report.js`, skill) y `CHANGELOG.md` en el commit que se suba a `main`.
