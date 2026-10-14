-- Migración 010 (2026-10-14): fecha en que se cargó o registró cada persona (para detectar quién lleva más de 7 días sin actividad).
-- Solo agrega una columna; las personas que ya existen quedan con la fecha de esta migración (nadie aparece inactivo de golpe).
-- Aplicar UNA vez sobre una base creada antes de esta fecha:
--   npx wrangler d1 execute voz-relevamiento --remote --file=migracion-010.sql
-- (Una base nueva no la necesita: schema.sql ya trae todo.)

ALTER TABLE encuestados ADD COLUMN creado TEXT;
UPDATE encuestados SET creado = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE creado IS NULL;
