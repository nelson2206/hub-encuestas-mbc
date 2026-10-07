-- Migración 005 (2026-10-06): la IA completa la matriz con lo que contaron en la encuesta.
-- Solo agrega columnas; no toca datos existentes.
-- Aplicar UNA vez sobre una base creada antes de esta fecha:
--   npx wrangler d1 execute voz-relevamiento --remote --file=migracion-005.sql
-- (Una base nueva no la necesita: schema.sql ya trae todo.)

ALTER TABLE procesos ADD COLUMN matriz_ia TEXT NOT NULL DEFAULT '{}';   -- campos de la matriz que llenó la IA: {campo: {estado, en}}
ALTER TABLE campanas ADD COLUMN ia_auto INTEGER NOT NULL DEFAULT 1;     -- 1 = la tarea programada completa la matriz sola
