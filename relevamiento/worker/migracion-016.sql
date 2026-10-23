-- Migración 016 (2026-10-23): perfil de cada Supervisor (supervisor de sección o gerente de gerencia) y la persona de la campaña a la que corresponde.
-- Solo agrega columnas. Los Supervisores que ya existen quedan como 'gerente' (lo que eran hasta hoy). Aplicar UNA vez:
--   npx wrangler d1 execute voz-relevamiento --remote --file=migracion-016.sql
ALTER TABLE supervisores ADD COLUMN perfil TEXT NOT NULL DEFAULT 'gerente';        -- supervisor (su sección, sin validación final) / gerente (su gerencia, con validación final)
ALTER TABLE supervisores ADD COLUMN encuestado_id TEXT NOT NULL DEFAULT '';        -- persona de «Personas y enlaces» a la que se le dio el perfil ('' = lo creó el cliente a mano)
CREATE INDEX IF NOT EXISTS ix_sup_enc ON supervisores(encuestado_id);
