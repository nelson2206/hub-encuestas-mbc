-- Voz MBC · Relevamiento de procesos — base D1 (voz-relevamiento)
-- Base nueva: npx wrangler d1 execute voz-relevamiento --remote --file=schema.sql
-- Base creada antes del 2026-09-28: aplicar en su lugar migracion-002.sql y migracion-003.sql
-- Base creada antes del 2026-09-29: aplicar migracion-003.sql y migracion-004.sql
-- Base creada antes del 2026-10-06: aplicar migracion-005.sql
-- El audio NUNCA se guarda: solo el texto que el encuestado revisa y confirma.

CREATE TABLE IF NOT EXISTS campanas (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  cliente TEXT NOT NULL,
  glosario TEXT NOT NULL DEFAULT '',   -- términos para mejorar la transcripción (siglas, sistemas, marcas)
  creada TEXT NOT NULL,
  codigo_publico TEXT,                 -- código del enlace abierto (?c=)
  abierta INTEGER NOT NULL DEFAULT 0,  -- 1 = el enlace abierto acepta registros
  dominio TEXT NOT NULL DEFAULT '',    -- dominio de correo exigido al registrarse (opcional)
  logo TEXT NOT NULL DEFAULT '',       -- logo del cliente (data URI) que se muestra en la encuesta
  ia_auto INTEGER NOT NULL DEFAULT 1,  -- 1 = la tarea programada completa la matriz con la IA
  estandares TEXT NOT NULL DEFAULT ''  -- glosario de estándares (TPS, Toyota Way, ISO…); vacío = el glosario base del Worker
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_camp_codigo ON campanas(codigo_publico);

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
  actualizado TEXT,
  origen TEXT NOT NULL DEFAULT 'carga',      -- carga (Excel) / abierto (se registró solo)
  creado TEXT                                -- cuándo se cargó o registró (para medir inactividad)
);
CREATE INDEX IF NOT EXISTS ix_enc_campana ON encuestados(campana_id);
CREATE INDEX IF NOT EXISTS ix_enc_correo ON encuestados(campana_id, correo);

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
  fuente TEXT NOT NULL DEFAULT 'inventario',   -- inventario / nuevo (encuestado) / consultor
  creado_por TEXT,                              -- encuestado que lo agregó (si es nuevo)
  orden INTEGER NOT NULL DEFAULT 0,
  matriz TEXT NOT NULL DEFAULT '{}',            -- fila de la matriz (JSON): columnas del inventario del cliente + contrato
  validacion TEXT NOT NULL DEFAULT '',          -- '' / actualizado / validado
  validado_por TEXT NOT NULL DEFAULT '',        -- cargo de quien validó
  validado_en TEXT,
  actualizado_en TEXT,
  entrevista TEXT NOT NULL DEFAULT '',          -- '' (pendiente) / agendada / realizada
  entrevista_fecha TEXT,                        -- AAAA-MM-DD
  entrevistado TEXT NOT NULL DEFAULT '',        -- cargo o persona entrevistada
  fuera_alcance INTEGER NOT NULL DEFAULT 0,     -- 1 = no se levanta en la encuesta (p. ej. compra de bienes y servicios)
  personas TEXT NOT NULL DEFAULT '',            -- nombres del inventario anterior, uno por línea (buscador por persona)
  matriz_ia TEXT NOT NULL DEFAULT '{}'          -- campos de la matriz que llenó la IA: {campo: {estado, en}}
);
CREATE INDEX IF NOT EXISTS ix_proc_campana ON procesos(campana_id, gerencia, seccion);

-- Lo que cada encuestado dice del proceso precargado: sigue vigente, cambió o ya no se hace.
CREATE TABLE IF NOT EXISTS revisiones (
  encuestado_id TEXT NOT NULL,
  proceso_id TEXT NOT NULL,
  estado TEXT NOT NULL,          -- vigente / cambio / no_participo / no_existe
  comentario TEXT NOT NULL DEFAULT '',
  actualizado TEXT NOT NULL,
  PRIMARY KEY (encuestado_id, proceso_id)
);

-- Procesos que una persona eligió con el buscador (pueden ser de cualquier gerencia).
CREATE TABLE IF NOT EXISTS asignaciones (
  encuestado_id TEXT NOT NULL,
  proceso_id TEXT NOT NULL,
  creado TEXT NOT NULL,
  origen TEXT NOT NULL DEFAULT 'encuestado',   -- encuestado (lo eligió) / consultor / inventario (por su nombre)
  PRIMARY KEY (encuestado_id, proceso_id)
);
CREATE INDEX IF NOT EXISTS ix_asig_proceso ON asignaciones(proceso_id);

CREATE TABLE IF NOT EXISTS respuestas (
  encuestado_id TEXT NOT NULL,
  proceso_id TEXT NOT NULL,
  pregunta TEXT NOT NULL,        -- q1..q6
  texto TEXT NOT NULL DEFAULT '',
  sistemas TEXT NOT NULL DEFAULT '[]',   -- JSON: sistemas del catálogo marcados (q3 o bloque 2)
  checklist TEXT NOT NULL DEFAULT '{}',  -- JSON por punto del bloque: {estado: cubierto/falta/no_aplica, fuente: ia/persona, evidencia}
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

-- Precarga del checklist desde documentos cargados en la consola (2026-10-13). El texto es interno: la encuesta solo recibe qué puntos están cubiertos.
CREATE TABLE IF NOT EXISTS precarga (
  proceso_id TEXT NOT NULL,
  bloque TEXT NOT NULL,
  punto TEXT NOT NULL,
  texto TEXT NOT NULL DEFAULT '',
  archivos TEXT NOT NULL DEFAULT '[]',
  creado TEXT NOT NULL,
  actualizado TEXT NOT NULL,
  PRIMARY KEY (proceso_id, punto)
);
CREATE INDEX IF NOT EXISTS ix_precarga_proceso ON precarga(proceso_id);

-- Enlaces por sección (2026-10-16): disponibilidad por fecha de cada sección, texto de invitación y acceso del cliente (solo lectura).
-- campanas.codigo_cliente / cliente_activo / cliente_ultimo / invitacion se agregan con migracion-011.sql.
CREATE TABLE IF NOT EXISTS ventanas (
  campana_id TEXT NOT NULL,
  gerencia TEXT NOT NULL,
  seccion TEXT NOT NULL,
  abre TEXT NOT NULL DEFAULT '',
  cierra TEXT NOT NULL DEFAULT '',
  mensaje TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (campana_id, gerencia, seccion)
);
-- campanas.cliente_alias (nombre de la dirección del panel del cliente) se agrega con migracion-012.sql.

-- Perfil Supervisor, delegaciones, acciones y límite de intentos (migracion-013.sql)
CREATE TABLE IF NOT EXISTS supervisores (
  id TEXT PRIMARY KEY,
  campana_id TEXT NOT NULL,
  nombre TEXT NOT NULL,
  correo TEXT NOT NULL DEFAULT '',
  clave_hash TEXT NOT NULL,
  activo INTEGER NOT NULL DEFAULT 1,
  alcance TEXT NOT NULL DEFAULT '{"todo":false}',
  creado TEXT NOT NULL,
  ultimo TEXT NOT NULL DEFAULT '',
  perfil TEXT NOT NULL DEFAULT 'gerente',   -- supervisor (su sección) / gerente (su gerencia, con validación final)
  encuestado_id TEXT NOT NULL DEFAULT ''    -- persona a la que se le dio el perfil desde la consola ('' = lo creó el cliente)
);
CREATE UNIQUE INDEX IF NOT EXISTS ix_sup_clave ON supervisores(clave_hash);
CREATE INDEX IF NOT EXISTS ix_sup_camp ON supervisores(campana_id);

CREATE TABLE IF NOT EXISTS delegaciones (
  id TEXT PRIMARY KEY,
  campana_id TEXT NOT NULL,
  encuestado_id TEXT NOT NULL,
  proceso_id TEXT NOT NULL,
  actor_tipo TEXT NOT NULL,
  actor_id TEXT NOT NULL DEFAULT '',
  actor_nombre TEXT NOT NULL DEFAULT '',
  creado TEXT NOT NULL,
  activa INTEGER NOT NULL DEFAULT 1,
  quitada TEXT NOT NULL DEFAULT '',
  quitada_por TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_del_camp ON delegaciones(campana_id, activa);
CREATE INDEX IF NOT EXISTS ix_del_enc ON delegaciones(encuestado_id, proceso_id);

CREATE TABLE IF NOT EXISTS acciones (
  id TEXT PRIMARY KEY,
  campana_id TEXT NOT NULL,
  actor_tipo TEXT NOT NULL,
  actor_id TEXT NOT NULL DEFAULT '',
  actor_nombre TEXT NOT NULL DEFAULT '',
  accion TEXT NOT NULL,
  detalle TEXT NOT NULL DEFAULT '',
  creado TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_acc_camp ON acciones(campana_id, creado);

CREATE TABLE IF NOT EXISTS login_intentos (
  ip TEXT NOT NULL,
  ventana INTEGER NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip, ventana)
);

-- Flujo guiado del Supervisor (migracion-014.sql): procesos.quitado_por, flujo_pasos y aprobaciones.
-- Base nueva: aplicar después de schema.sql las migraciones 011, 012 y 014 (schema.sql no incluye sus columnas ni tablas).

-- Esqueleto Área > Gerencia > Sección (migracion-015.sql): tabla estructura. Aplicarla también en una base nueva.
