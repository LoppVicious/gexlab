# Founder Takes: notas, enlaces y research del fundador

Fecha: 2026-11-13. Estado: diseño aprobado en conversación, pendiente de revisar el spec escrito.

## Objetivo

Una página **Founder Takes** donde el admin publica contenido variado y personal: lectura de mercado, enlaces
comentados a noticias e hilos de X, PDFs, extractos de research y artículos de formación. Hoy leen los dos usuarios;
más adelante, más gente.

No se deciden categorías por adelantado. Hay **un solo tipo de entrada** con adjuntos opcionales y etiquetas libres.
Cuando haya 30-40 entradas se verá qué etiquetas merecen un filtro o una pestaña propia.

## Decisiones

- **Escribe el admin.** Los demás usuarios solo leen.
- **Claude prepara borradores, no publica.** La cuenta `Claude` (rol usuario) recibe el permiso de autor de borradores:
  crea y edita sus propios borradores desde el navegador integrado; el admin los revisa y publica. No se usa la
  sesión del admin en el navegador integrado: la sesión es única por cuenta y echaría al admin de su PC.
- **Datos en D1, archivos en R2.** El repo es público: nada de Takes ni de adjuntos en git.
- **Solo en la nube.** En modo PC (`server.py`) la página muestra «Founder Takes are available in the cloud version.»
- **Fuera de la primera versión:** comentarios, likes, avisos o notificaciones, tarjeta en Summary, Takes junto a cada
  ticker, vista previa automática de enlaces (X y muchas webs bloquean la descarga desde el Worker).

## Modelo de datos (`nube/schema.sql`, idempotente)

```sql
CREATE TABLE IF NOT EXISTS takes (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  titulo    TEXT NOT NULL DEFAULT '',     -- opcional: un Take corto puede no tener título
  cuerpo    TEXT NOT NULL DEFAULT '',     -- Markdown (subconjunto, ver Web)
  etiquetas TEXT NOT NULL DEFAULT '[]',   -- JSON, lista de cadenas
  estado    TEXT NOT NULL DEFAULT 'borrador',  -- 'borrador' | 'publicado'
  autor     TEXT NOT NULL,                -- usuario que lo creó
  creado    TEXT NOT NULL,
  editado   TEXT,
  publicado TEXT                          -- fecha de la primera publicación; orden del listado
);
CREATE INDEX IF NOT EXISTS takes_publicado ON takes(estado, publicado);
CREATE TABLE IF NOT EXISTS takes_adjuntos (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  take_id INTEGER NOT NULL,
  orden   INTEGER NOT NULL,
  tipo    TEXT NOT NULL,                  -- 'enlace' | 'pdf' | 'imagen' | 'cita'
  url     TEXT,                           -- enlace: URL externa; cita: URL del original (opcional)
  r2      TEXT,                           -- pdf e imagen: clave en R2
  titulo  TEXT NOT NULL DEFAULT '',       -- enlace/pdf: texto a mostrar; si falta, el dominio o el nombre del archivo
  texto   TEXT NOT NULL DEFAULT '',       -- cita: el extracto; resto: nota corta opcional
  fuente  TEXT NOT NULL DEFAULT ''        -- cita: autor o casa de research
);
CREATE INDEX IF NOT EXISTS takes_adjuntos_take ON takes_adjuntos(take_id, orden);
CREATE TABLE IF NOT EXISTS takes_autores (usuario TEXT PRIMARY KEY);  -- pueden crear borradores
```

Etiquetas: se guardan como se escriben (sin espacios sobrantes), sin duplicados ignorando mayúsculas, máximo 10 por
Take y 30 caracteres cada una. El filtro compara sin distinguir mayúsculas.

Archivos en R2: `takes/<take_id>/<id aleatorio>.<ext>`. El nombre original solo se guarda en `titulo`.

## Permisos

| Acción | Admin | Autor de borradores | Usuario |
|---|---|---|---|
| Ver Takes publicados y sus archivos | sí | sí | sí |
| Ver borradores | todos | solo los suyos | no |
| Crear y editar borradores | sí | solo los suyos | no |
| Publicar, despublicar, editar publicados, borrar | sí | no | no |

El admin marca qué usuarios son autores de borradores en `/admin` (botón «Allow drafts» / «Revoke drafts» en la
lista de usuarios, con la insignia «drafts»). Un autor al que se le retira el permiso sigue viendo sus borradores, pero
ya no puede editarlos.
Borrar un usuario lo quita también de `takes_autores`.

## API del Worker (`nube/worker.js`)

Todas exigen sesión. Los errores van en inglés, como el resto del Worker.

- `GET /api/takes`: lista sin el cuerpo completo. Devuelve `id, titulo, extracto (300 caracteres de texto plano),
  etiquetas, estado, autor, publicado, editado, adjuntos (tipo y título)`. Ordenada por `publicado` (o `creado` en
  borradores), la más reciente primero. Incluye los borradores que el usuario puede ver. El filtro por etiqueta se
  hace en el navegador: con cientos de entradas la lista sigue siendo pequeña.
- `GET /api/takes/:id`: el Take completo con sus adjuntos. 404 si no existe o no se puede ver.
- `POST /api/takes`: crea un borrador. Cuerpo `multipart/form-data` con un campo `datos` (JSON: título, cuerpo,
  etiquetas, adjuntos en orden) y los archivos nuevos (`archivo0`, `archivo1`…, referenciados desde `datos`).
- `PUT /api/takes/:id`: igual que `POST`; reemplaza el Take y su lista de adjuntos. Los adjuntos que ya existían se
  conservan por `id`; los archivos de R2 de los adjuntos quitados se borran.
- `POST /api/takes/:id/estado` con `{"estado": "publicado" | "borrador"}`: solo admin. La primera publicación fija
  `publicado`.
- `DELETE /api/takes/:id`: solo admin. Borra el Take, sus adjuntos y sus archivos de R2.
- `GET /api/takes/archivo/<clave>`: sirve el archivo de R2 si el Take al que pertenece es visible para el usuario.
  Cabeceras `Content-Type` del tipo guardado, `Content-Disposition: inline`, `X-Content-Type-Options: nosniff`,
  `Cache-Control: private, max-age=86400`.

Validación en el Worker (no se confía en el navegador):
- Archivos: PDF, PNG, JPEG o WebP, comprobados por los primeros bytes además de la extensión; máximo 20 MB cada uno
  y 8 por Take. SVG no se admite (puede llevar scripts).
- Enlaces: solo `http` y `https`.
- Longitudes: título 200, cuerpo 50.000, cita 5.000, nota 500 caracteres.

`nube.js` no necesita traducir nada: las rutas `/api/takes` llegan tal cual al Worker. En `server.py`, `/api/takes`
responde 404 con el mensaje de «solo en la nube».

## Web

Archivos nuevos `web/takes.js` y `web/takes.css` (enlazado en `index.html` antes de `tema.css`, solo con tokens del
tema; es una página de lectura, no una herramienta: no va en `herramientas.css`). Respeta los globales compartidos: prefijo `tk` en funciones, clases y claves de preferencias.

- **Menú:** sección nueva **Research** con el botón **Takes** (título de página «Founder Takes»), con su icono
  SVG como los demás.
- **Listado:** tarjetas con fecha (en-US), título o primeras palabras, extracto, etiquetas y un icono por tipo de
  adjunto. Encima, las etiquetas usadas como chips de filtro (varias a la vez = deben estar todas) y un buscador de
  texto sobre título y extracto. El filtro elegido se recuerda en las preferencias (`tkFiltro`).
- **Detalle:** el Take completo. El cuerpo se pinta con un Markdown mínimo propio que **escapa todo el HTML** y solo
  reconoce títulos `#`/`##`/`###`, negrita, cursiva, enlaces `[texto](url)` (solo http/https, `target=_blank`,
  `rel=noopener noreferrer`), listas, citas `>`, código en línea y párrafos. Adjuntos debajo, en orden:
  - enlace: tarjeta con título, dominio y la nota;
  - pdf: tarjeta con nombre y botón «Open PDF», que lo abre en una pestaña nueva con el visor del navegador;
  - imagen: la imagen a todo el ancho de la columna, clic para verla a tamaño real;
  - cita: bloque citado con la fuente y el enlace «Source» si hay URL.
- **Editor** (admin y autores): «New take» en el listado y «Edit» en el detalle. Campos: título, cuerpo (textarea con
  pestaña «Preview» que usa el mismo renderizador), etiquetas (chips con autocompletado de las existentes) y adjuntos
  (añadir enlace, cita o archivo; arrastrar archivos o pegar una imagen del portapapeles; reordenar con flechas;
  quitar). Botones «Save draft» y, solo para el admin, «Publish» / «Unpublish» y «Delete» (con confirmación).
  Al añadir un PDF aparece el aviso: «Only upload PDFs you own or that are freely shareable. For paid research, quote
  a short excerpt and link to the source.»
- Borradores marcados con la etiqueta «Draft» en el listado.
- Colores de `C`/variables de `tema.css`; comprobado en Bento oscuro y Daylight claro, y en móvil.

## Docs

- `docs/ARQUITECTURA.md`: tablas, rutas, claves de R2 `takes/` y permisos.
- `CHANGELOG.md`: entrada del día en el mismo commit del push.
- `CLAUDE.md` (mapa): una línea para `web/takes.js`.

## Pruebas

- `node --check` de `nube/worker.js`, `web/takes.js` y cada JS tocado.
- Tras el despliegue, en producción con el navegador integrado y la cuenta `Claude` (ya marcada como autora):
  crear un borrador con texto, enlace, cita, imagen y PDF; que el admin lo ve y lo publica; que un borrador del admin
  y sus archivos dan 404 a la cuenta `Claude` (autora, pero no suya) y aparecen al publicarlo; que `Claude` no puede
  publicar ni borrar (403); que un SVG, un `.pdf` que no es PDF y un enlace `javascript:`
  se rechazan; que borrar el Take borra sus archivos de R2.
- Markdown: cuerpo con `<script>`, `<img onerror>` y `[x](javascript:alert(1))` se ve como texto, sin ejecutarse.
- Capturas en tema claro y oscuro, escritorio y móvil.
