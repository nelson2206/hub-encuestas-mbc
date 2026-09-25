-- Voz MBC · Relevamiento de procesos — base D1 (voz-relevamiento)
-- Aplicar: npx wrangler d1 execute voz-relevamiento --remote --file=schema.sql
-- El audio NUNCA se guarda: solo el texto que el encuestado revisa y confirma.

CREATE TABLE IF NOT EXISTS campanas (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  cliente TEXT NOT NULL,
  glosario TEXT NOT NULL DEFAULT '',   -- términos para mejorar la transcripción (siglas, sistemas, marcas)
  creada TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS encuestados (
  id TEXT PRIMARY KEY,
  campana_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  nombre TEXT NOT NULL,
  correo TEXT NOT NULL DEFAULT '',
  gerencia TEXT NOT NULL,
  seccion TEXT NOT NULL,
  rol TEXT NOT NULL DEFAULT '',        -- líder / soporte
  estado TEXT NOT NULL DEFAULT 'pendiente',  -- pendiente / en_curso / enviado
  actualizado TEXT
);
CREATE INDEX IF NOT EXISTS ix_enc_campana ON encuestados(campana_id);

CREATE TABLE IF NOT EXISTS procesos (
  id TEXT PRIMARY KEY,
  campana_id TEXT NOT NULL,
  codigo TEXT NOT NULL DEFAULT '',
  gerencia TEXT NOT NULL,
  seccion TEXT NOT NULL,
  macroproceso TEXT NOT NULL DEFAULT '',
  proceso TEXT NOT NULL DEFAULT '',
  subproceso TEXT NOT NULL DEFAULT '',
  descripcion TEXT NOT NULL DEFAULT '',
  fuente TEXT NOT NULL DEFAULT 'inventario',   -- inventario / nuevo
  creado_por TEXT,                              -- encuestado que lo agregó (si es nuevo)
  orden INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_proc_campana ON procesos(campana_id, gerencia, seccion);

-- Lo que cada encuestado dice del proceso precargado: sigue vigente, cambió o ya no se hace.
CREATE TABLE IF NOT EXISTS revisiones (
  encuestado_id TEXT NOT NULL,
  proceso_id TEXT NOT NULL,
  estado TEXT NOT NULL,          -- vigente / cambio / no_existe
  comentario TEXT NOT NULL DEFAULT '',
  actualizado TEXT NOT NULL,
  PRIMARY KEY (encuestado_id, proceso_id)
);

CREATE TABLE IF NOT EXISTS respuestas (
  encuestado_id TEXT NOT NULL,
  proceso_id TEXT NOT NULL,
  pregunta TEXT NOT NULL,        -- q1..q6
  texto TEXT NOT NULL DEFAULT '',
  sistemas TEXT NOT NULL DEFAULT '[]',   -- JSON: sistemas del catálogo marcados (solo q3)
  actualizado TEXT NOT NULL,
  PRIMARY KEY (encuestado_id, proceso_id, pregunta)
);
CREATE INDEX IF NOT EXISTS ix_resp_proceso ON respuestas(proceso_id);

CREATE TABLE IF NOT EXISTS sistemas (
  id TEXT PRIMARY KEY,
  campana_id TEXT NOT NULL,
  nombre TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_sis_campana ON sistemas(campana_id);

-- Resultado de la estructuración con IA, una fila por proceso (se sobrescribe al regenerar).
CREATE TABLE IF NOT EXISTS estructurado (
  proceso_id TEXT PRIMARY KEY,
  campana_id TEXT NOT NULL,
  datos TEXT NOT NULL,           -- JSON con campos {valor, estado, evidencia} y preguntas de validación
  modelo TEXT NOT NULL,
  generado TEXT NOT NULL
);
