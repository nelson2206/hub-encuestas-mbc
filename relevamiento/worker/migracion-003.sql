-- Migración 003 (2026-09-29): matriz de procesos con el formato del inventario del cliente y check de validación.
-- Solo agrega columnas; no toca datos existentes.
-- Aplicar UNA vez sobre una base creada antes de esta fecha:
--   npx wrangler d1 execute voz-relevamiento --remote --file=migracion-003.sql
-- (Una base nueva no la necesita: schema.sql ya trae todo.)

ALTER TABLE procesos ADD COLUMN matriz TEXT NOT NULL DEFAULT '{}';      -- fila de la matriz (JSON)
ALTER TABLE procesos ADD COLUMN validacion TEXT NOT NULL DEFAULT '';    -- '' / actualizado / validado
ALTER TABLE procesos ADD COLUMN validado_por TEXT NOT NULL DEFAULT '';  -- cargo de quien validó
ALTER TABLE procesos ADD COLUMN validado_en TEXT;
ALTER TABLE procesos ADD COLUMN actualizado_en TEXT;
