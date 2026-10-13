-- Migración 009 (2026-10-13): precarga del checklist desde documentos cargados en la consola.
-- Solo agrega una tabla; no toca datos existentes.
-- Aplicar UNA vez sobre una base creada antes de esta fecha:
--   npx wrangler d1 execute voz-relevamiento --remote --file=migracion-009.sql
-- (Una base nueva no la necesita: schema.sql ya trae todo.)

CREATE TABLE IF NOT EXISTS precarga (
  proceso_id TEXT NOT NULL,
  bloque TEXT NOT NULL,
  punto TEXT NOT NULL,                       -- id del punto del checklist (objetivo, sistemas, estandar_tdp…)
  texto TEXT NOT NULL DEFAULT '',            -- lo que dice el documento sobre el punto: INTERNO, nunca se envía a la encuesta
  archivos TEXT NOT NULL DEFAULT '[]',       -- nombres de los archivos de donde salió (JSON)
  creado TEXT NOT NULL,
  actualizado TEXT NOT NULL,
  PRIMARY KEY (proceso_id, punto)
);
CREATE INDEX IF NOT EXISTS ix_precarga_proceso ON precarga(proceso_id);
