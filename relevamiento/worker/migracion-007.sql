-- Migración 007 (2026-10-09): seguimiento de entrevistas por proceso (pantalla «Entrevistas» de la consola).
-- Solo agrega columnas; no toca datos existentes.
-- Aplicar UNA vez sobre una base creada antes de esta fecha:
--   npx wrangler d1 execute voz-relevamiento --remote --file=migracion-007.sql
-- (Una base nueva no la necesita: schema.sql ya trae todo.)

ALTER TABLE procesos ADD COLUMN entrevista TEXT NOT NULL DEFAULT '';        -- '' (pendiente) / agendada / realizada
ALTER TABLE procesos ADD COLUMN entrevista_fecha TEXT;                      -- AAAA-MM-DD de la entrevista (hecha o agendada)
ALTER TABLE procesos ADD COLUMN entrevistado TEXT NOT NULL DEFAULT '';      -- cargo o persona entrevistada
