-- Migración 017 (2026-10-24): la clave de acceso de Supervisores y Gerentes se puede volver a ver en la consola del equipo consultor.
-- Se sigue entrando con la huella (clave_hash); «clave» guarda el texto para mostrarlo. Las claves creadas antes quedan vacías
-- hasta que se carguen o se genere una nueva.  Aplicar UNA vez:
--   npx wrangler d1 execute voz-relevamiento --remote --file=migracion-017.sql
ALTER TABLE supervisores ADD COLUMN clave TEXT NOT NULL DEFAULT '';
