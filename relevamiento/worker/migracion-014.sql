-- Flujo guiado del Supervisor (Gerente): pasos confirmados, aprobación final por gerencia y procesos que el Gerente quita.
-- Base existente:  npx wrangler d1 execute voz-relevamiento --remote --file=migracion-014.sql   (agregar --local para la base local)

-- Procesos que el Gerente saca de su inventario (paso 1). Quedan fuera de alcance, pero se distinguen de los que sacó el consultor
-- y el Gerente puede restaurarlos mientras no apruebe. Vacío = no lo quitó el Gerente.
ALTER TABLE procesos ADD COLUMN quitado_por TEXT NOT NULL DEFAULT '';

-- Pasos 1 a 3 confirmados por cada Supervisor. El paso 4 es la aprobación final (tabla aprobaciones).
CREATE TABLE IF NOT EXISTS flujo_pasos (
  campana_id TEXT NOT NULL,
  supervisor_id TEXT NOT NULL,
  paso INTEGER NOT NULL,
  confirmado_en TEXT NOT NULL,
  PRIMARY KEY (supervisor_id, paso)
);
CREATE INDEX IF NOT EXISTS ix_flujo_camp ON flujo_pasos(campana_id);

-- Aprobación final del Gerente. Una fila activa = gerencia aprobada. Si MBC la reabre queda activa=0 con quién y por qué.
CREATE TABLE IF NOT EXISTS aprobaciones (
  id TEXT PRIMARY KEY,
  campana_id TEXT NOT NULL,
  supervisor_id TEXT NOT NULL,
  gerente TEXT NOT NULL DEFAULT '',        -- nombre de quien aprobó
  gerencias TEXT NOT NULL DEFAULT '[]',    -- gerencias que cubría su alcance al aprobar (JSON)
  procesos INTEGER NOT NULL DEFAULT 0,     -- procesos vigentes aprobados
  aprobado_en TEXT NOT NULL,
  activa INTEGER NOT NULL DEFAULT 1,
  reabierta_en TEXT NOT NULL DEFAULT '',
  reabierta_por TEXT NOT NULL DEFAULT '',
  motivo TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_aprob_camp ON aprobaciones(campana_id, activa);
CREATE INDEX IF NOT EXISTS ix_aprob_sup ON aprobaciones(supervisor_id, activa);
