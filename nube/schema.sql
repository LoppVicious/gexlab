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
