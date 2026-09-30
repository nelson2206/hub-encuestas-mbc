-- Migración 004 (2026-09-29): logo del cliente, búsqueda por persona, asignación de procesos y checklist por bloque.
-- Solo agrega columnas; no toca datos existentes.
-- Aplicar UNA vez sobre una base creada antes de esta fecha:
--   npx wrangler d1 execute voz-relevamiento --remote --file=migracion-004.sql
-- (Una base nueva no la necesita: schema.sql ya trae todo.)

ALTER TABLE campanas ADD COLUMN logo TEXT NOT NULL DEFAULT '';               -- logo del cliente (data URI)
ALTER TABLE procesos ADD COLUMN personas TEXT NOT NULL DEFAULT '';           -- nombres del inventario anterior, uno por línea (buscador)
ALTER TABLE asignaciones ADD COLUMN origen TEXT NOT NULL DEFAULT 'encuestado'; -- encuestado / consultor / inventario
ALTER TABLE respuestas ADD COLUMN checklist TEXT NOT NULL DEFAULT '{}';      -- puntos del bloque: cubierto / falta / no_aplica
