-- Migración 018 (2026-11-05): tope diario de la IA de Cloudflare (Whisper) para no pasar del cupo gratuito.
-- Desde que la cuenta usa Workers Paid, lo que pasa de 10.000 neuronas al día se cobra a la tarjeta, sin tope de Cloudflare.
-- Esta tabla lleva los segundos de audio transcritos por día (UTC, que es cuando Cloudflare reinicia el cupo).
-- Aplicar UNA vez:
--   npx wrangler d1 execute voz-relevamiento --remote --file=migracion-018.sql
CREATE TABLE IF NOT EXISTS uso_ia (
  dia TEXT PRIMARY KEY,              -- AAAA-MM-DD en UTC
  segundos REAL NOT NULL DEFAULT 0,  -- audio enviado a Whisper (cada intento cuenta, también los reintentos)
  llamadas INTEGER NOT NULL DEFAULT 0
);
