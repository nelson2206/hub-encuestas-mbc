-- Migración 006 (2026-10-09): glosario de estándares por campaña (TPS, Toyota Way, ISO, NTP…), editable en la consola.
-- Solo agrega una columna; vacía = se usa el glosario base del Worker.
-- Aplicar UNA vez sobre una base creada antes de esta fecha:
--   npx wrangler d1 execute voz-relevamiento --remote --file=migracion-006.sql
-- (Una base nueva no la necesita: schema.sql ya trae todo.)

ALTER TABLE campanas ADD COLUMN estandares TEXT NOT NULL DEFAULT '';
