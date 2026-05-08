-- PDFRealm Evidence / Hash Evidence Machine (Phase 1) — Postgres tables
-- Safe to run multiple times.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS evidence_artifacts (
  id uuid PRIMARY KEY,
  owner_user_id uuid,
  filename text,
  mime_type text,
  size_bytes bigint,
  sha256 text,
  storage_path text,
  created_at timestamptz DEFAULT NOW(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS evidence_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  artifact_id uuid NOT NULL REFERENCES evidence_artifacts(id) ON DELETE CASCADE,
  actor_user_id uuid,
  actor_role text,
  action text NOT NULL,
  details jsonb,
  prev_hash text,
  event_hash text,
  created_at timestamptz DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_evidence_artifacts_owner ON evidence_artifacts(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_evidence_events_artifact ON evidence_events(artifact_id, id);
