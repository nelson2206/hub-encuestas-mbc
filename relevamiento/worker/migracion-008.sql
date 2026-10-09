-- Migración 008 (2026-10-10): procesos fuera de alcance (p. ej. compra de bienes y servicios, que se levanta aparte).
-- Solo agrega una columna; no toca datos existentes.
-- Aplicar UNA vez sobre una base creada antes de esta fecha:
--   npx wrangler d1 execute voz-relevamiento --remote --file=migracion-008.sql
-- (Una base nueva no la necesita: schema.sql ya trae todo.)

ALTER TABLE procesos ADD COLUMN fuera_alcance INTEGER NOT NULL DEFAULT 0;   -- 1 = no se ve en la encuesta ni se estructura con IA
