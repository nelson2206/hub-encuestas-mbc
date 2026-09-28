-- Migración 002 (2026-09-28): enlace abierto con buscador de procesos y mapa de cobertura.
-- Solo agrega columnas y una tabla; no toca datos existentes.
-- Aplicar UNA vez sobre una base creada con la versión anterior de schema.sql:
--   npx wrangler d1 execute voz-relevamiento --remote --file=migracion-002.sql
-- (Una base nueva no la necesita: schema.sql ya trae todo.)

ALTER TABLE campanas ADD COLUMN codigo_publico TEXT;                 -- código del enlace abierto (?c=)
ALTER TABLE campanas ADD COLUMN abierta INTEGER NOT NULL DEFAULT 0;  -- 1 = el enlace abierto acepta registros
ALTER TABLE campanas ADD COLUMN dominio TEXT NOT NULL DEFAULT '';    -- dominio de correo exigido al registrarse (opcional)
CREATE UNIQUE INDEX IF NOT EXISTS ux_camp_codigo ON campanas(codigo_publico);

ALTER TABLE encuestados ADD COLUMN origen TEXT NOT NULL DEFAULT 'carga';  -- carga (Excel) / abierto (se registró solo)
CREATE INDEX IF NOT EXISTS ix_enc_correo ON encuestados(campana_id, correo);

-- Procesos que una persona eligió con el buscador (pueden ser de cualquier gerencia).
CREATE TABLE IF NOT EXISTS asignaciones (
  encuestado_id TEXT NOT NULL,
  proceso_id TEXT NOT NULL,
  creado TEXT NOT NULL,
  PRIMARY KEY (encuestado_id, proceso_id)
);
CREATE INDEX IF NOT EXISTS ix_asig_proceso ON asignaciones(proceso_id);
