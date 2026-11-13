-- GEX Lab en Cloudflare D1. Idempotente: se aplica en cada despliegue.
CREATE TABLE IF NOT EXISTS usuarios (
  usuario   TEXT PRIMARY KEY,
  sal       TEXT NOT NULL,          -- sal del PBKDF2 que hace el navegador
  verif     TEXT NOT NULL,          -- SHA-256 del resultado del PBKDF2 (nunca la contrasena)
  rol       TEXT NOT NULL DEFAULT 'usuario',
  lid       TEXT NOT NULL,          -- identificador anonimo de su lista (lo usa el motor)
  inactivo  INTEGER NOT NULL DEFAULT 0,
  creado    TEXT NOT NULL,
  cambiado  TEXT
);
CREATE TABLE IF NOT EXISTS sesiones (
  h       TEXT PRIMARY KEY,         -- SHA-256 del token de la cookie
  usuario TEXT NOT NULL,
  exp     INTEGER NOT NULL,
  creada  TEXT NOT NULL,
  ip      TEXT
);
CREATE INDEX IF NOT EXISTS sesiones_usuario ON sesiones(usuario);
CREATE TABLE IF NOT EXISTS prefs (usuario TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS listas (usuario TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS fallos (clave TEXT PRIMARY KEY, n INTEGER NOT NULL, hasta INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pedidos (simbolo TEXT PRIMARY KEY, t INTEGER NOT NULL);
-- sesiones cerradas por un inicio de sesion en otro dispositivo (para avisar al expulsado); se purgan a los 30 dias
CREATE TABLE IF NOT EXISTS sesiones_cerradas (h TEXT PRIMARY KEY, motivo TEXT NOT NULL, t INTEGER NOT NULL);
-- Founder Takes: entradas del admin (y borradores de autores), adjuntos y quien puede escribir borradores.
-- Archivos (pdf, imagen) en R2: takes/<take_id>/<24 hex>.<ext>
CREATE TABLE IF NOT EXISTS takes (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  titulo    TEXT NOT NULL DEFAULT '',
  cuerpo    TEXT NOT NULL DEFAULT '',     -- Markdown (subconjunto de web/takes-md.js)
  etiquetas TEXT NOT NULL DEFAULT '[]',   -- JSON, lista de cadenas
  estado    TEXT NOT NULL DEFAULT 'borrador',  -- 'borrador' | 'publicado'
  autor     TEXT NOT NULL,
  creado    TEXT NOT NULL,                -- ISO 8601 UTC
  editado   TEXT,
  publicado TEXT                          -- primera publicacion; orden del listado
);
CREATE INDEX IF NOT EXISTS takes_publicado ON takes(estado, publicado);
CREATE TABLE IF NOT EXISTS takes_adjuntos (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  take_id INTEGER NOT NULL,
  orden   INTEGER NOT NULL,
  tipo    TEXT NOT NULL,                  -- 'enlace' | 'pdf' | 'imagen' | 'cita'
  url     TEXT,                           -- enlace: obligatoria; cita: opcional
  r2      TEXT,                           -- pdf e imagen: clave en R2
  titulo  TEXT NOT NULL DEFAULT '',
  texto   TEXT NOT NULL DEFAULT '',       -- cita: el extracto; resto: nota corta
  fuente  TEXT NOT NULL DEFAULT ''        -- cita: autor o casa de research
);
CREATE INDEX IF NOT EXISTS takes_adjuntos_take ON takes_adjuntos(take_id, orden);
CREATE INDEX IF NOT EXISTS takes_adjuntos_r2 ON takes_adjuntos(r2);
CREATE TABLE IF NOT EXISTS takes_autores (usuario TEXT PRIMARY KEY);
