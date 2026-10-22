-- Esqueleto de la campaña (hoja «Gerencias» del Excel de carga): Área > Gerencia > Sección, con o sin procesos.
-- Base existente:  npx wrangler d1 execute voz-relevamiento --remote --file=migracion-015.sql   (agregar --local para la base local)
-- Una campaña sin filas aquí funciona como siempre: sus gerencias y secciones salen de sus procesos.

CREATE TABLE IF NOT EXISTS estructura (
  campana_id TEXT NOT NULL,
  clave TEXT NOT NULL,                  -- gerencia|sección sin mayúsculas ni tildes: identifica la fila aunque se escriba distinto
  area TEXT NOT NULL DEFAULT '',        -- nivel superior (vacío = sin área); es de la gerencia y se repite en sus secciones
  gerencia TEXT NOT NULL,
  seccion TEXT NOT NULL DEFAULT '',     -- vacío = la gerencia se declaró sin secciones todavía
  orden INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (campana_id, clave)
);
