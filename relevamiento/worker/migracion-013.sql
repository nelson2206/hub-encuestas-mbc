-- Migración 013 (2026-10-20): perfil Supervisor (clave propia y alcance), registro de delegaciones y de acciones, y límite de intentos de clave.
-- Solo crea tablas. Aplicar UNA vez:
--   npx wrangler d1 execute voz-relevamiento --remote --file=migracion-013.sql

CREATE TABLE IF NOT EXISTS supervisores (
  id TEXT PRIMARY KEY,
  campana_id TEXT NOT NULL,
  nombre TEXT NOT NULL,
  correo TEXT NOT NULL DEFAULT '',
  clave_hash TEXT NOT NULL,
  activo INTEGER NOT NULL DEFAULT 1,
  alcance TEXT NOT NULL DEFAULT '{"todo":false}',
  creado TEXT NOT NULL,
  ultimo TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS ix_sup_clave ON supervisores(clave_hash);
CREATE INDEX IF NOT EXISTS ix_sup_camp ON supervisores(campana_id);

CREATE TABLE IF NOT EXISTS delegaciones (
  id TEXT PRIMARY KEY,
  campana_id TEXT NOT NULL,
  encuestado_id TEXT NOT NULL,
  proceso_id TEXT NOT NULL,
  actor_tipo TEXT NOT NULL,
  actor_id TEXT NOT NULL DEFAULT '',
  actor_nombre TEXT NOT NULL DEFAULT '',
  creado TEXT NOT NULL,
  activa INTEGER NOT NULL DEFAULT 1,
  quitada TEXT NOT NULL DEFAULT '',
  quitada_por TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_del_camp ON delegaciones(campana_id, activa);
CREATE INDEX IF NOT EXISTS ix_del_enc ON delegaciones(encuestado_id, proceso_id);

CREATE TABLE IF NOT EXISTS acciones (
  id TEXT PRIMARY KEY,
  campana_id TEXT NOT NULL,
  actor_tipo TEXT NOT NULL,
  actor_id TEXT NOT NULL DEFAULT '',
  actor_nombre TEXT NOT NULL DEFAULT '',
  accion TEXT NOT NULL,
  detalle TEXT NOT NULL DEFAULT '',
  creado TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_acc_camp ON acciones(campana_id, creado);

CREATE TABLE IF NOT EXISTS login_intentos (
  ip TEXT NOT NULL,
  ventana INTEGER NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip, ventana)
);
