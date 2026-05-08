-- Pay-per-access sessions (24h all-tools pass)
-- Run once: psql "$DATABASE_URL" -f migrations/pay_per_access.sql

CREATE TABLE IF NOT EXISTS pay_per_export_sessions (
  id                SERIAL PRIMARY KEY,
  stripe_session_id TEXT        NOT NULL UNIQUE,
  token             TEXT        NOT NULL UNIQUE,
  expires_at        TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ppe_token      ON pay_per_export_sessions (token);
CREATE INDEX IF NOT EXISTS idx_ppe_expires_at ON pay_per_export_sessions (expires_at);
