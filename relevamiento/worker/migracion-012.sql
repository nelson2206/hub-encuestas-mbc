-- Migración 012 (2026-10-16): nombre de la dirección del panel del cliente (cosmético: admin.html?cliente=nombre).
-- Solo agrega una columna. Aplicar UNA vez:
--   npx wrangler d1 execute voz-relevamiento --remote --file=migracion-012.sql
-- (Una base nueva no la necesita: schema.sql ya trae todo.)

ALTER TABLE campanas ADD COLUMN cliente_alias TEXT NOT NULL DEFAULT '';
