-- Migración 011 (2026-10-16): enlaces por sección (disponibilidad por fecha), texto de invitación editable y acceso del cliente (solo lectura).
-- Solo agrega columnas y una tabla; no toca datos existentes.
-- Aplicar UNA vez sobre una base creada antes de esta fecha:
--   npx wrangler d1 execute voz-relevamiento --remote --file=migracion-011.sql
-- (Una base nueva no la necesita: schema.sql ya trae todo.)

ALTER TABLE campanas ADD COLUMN codigo_cliente TEXT;                    -- código de acceso de la administradora del cliente
ALTER TABLE campanas ADD COLUMN cliente_activo INTEGER NOT NULL DEFAULT 0;
ALTER TABLE campanas ADD COLUMN cliente_ultimo TEXT;                    -- último ingreso del cliente
ALTER TABLE campanas ADD COLUMN invitacion TEXT NOT NULL DEFAULT '';    -- texto de invitación de la campaña (vacío = texto base)

CREATE TABLE IF NOT EXISTS ventanas (
  campana_id TEXT NOT NULL,
  gerencia TEXT NOT NULL,
  seccion TEXT NOT NULL,
  abre TEXT NOT NULL DEFAULT '',       -- AAAA-MM-DD: antes de esa fecha la sección no está disponible
  cierra TEXT NOT NULL DEFAULT '',     -- AAAA-MM-DD: plazo de referencia (no bloquea)
  mensaje TEXT NOT NULL DEFAULT '',    -- mensaje para quien entre antes de la apertura
  PRIMARY KEY (campana_id, gerencia, seccion)
);
