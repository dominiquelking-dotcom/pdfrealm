// PDFRealm Secure Suite: Secure AI Notes Assistant schema
// /PDFREALM_SECURE_AI_SCHEMA_V1
async function ensureSecureAiSchema(pool) {
  // Idempotent schema creation
  await pool.query(`
    CREATE TABLE IF NOT EXISTS secure_ai_sessions (
      id UUID PRIMARY KEY,
      created_by TEXT NOT NULL,
      session_type TEXT NOT NULL,
      context_id TEXT NOT NULL,
      title TEXT,
      status TEXT NOT NULL DEFAULT 'CONSENT_PENDING',
      started_at TIMESTAMPTZ,
      ended_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS secure_ai_participants (
      session_id UUID NOT NULL REFERENCES secure_ai_sessions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      display_name TEXT,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      left_at TIMESTAMPTZ,
      PRIMARY KEY (session_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS secure_ai_consent_events (
      id BIGSERIAL PRIMARY KEY,
      session_id UUID NOT NULL REFERENCES secure_ai_sessions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      consent BOOLEAN NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS secure_ai_recordings (
      session_id UUID PRIMARY KEY REFERENCES secure_ai_sessions(id) ON DELETE CASCADE,
      mime_type TEXT,
      duration_sec INTEGER,
      storage_key TEXT,
      size_bytes BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS secure_ai_transcripts (
      session_id UUID PRIMARY KEY REFERENCES secure_ai_sessions(id) ON DELETE CASCADE,
      storage_key TEXT,
      language TEXT,
      diarization BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS secure_ai_reports (
      session_id UUID PRIMARY KEY REFERENCES secure_ai_sessions(id) ON DELETE CASCADE,
      storage_key TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS secure_ai_jobs (
      id UUID PRIMARY KEY,
      session_id UUID NOT NULL REFERENCES secure_ai_sessions(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'QUEUED',
      progress TEXT,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_secure_ai_sessions_ctx ON secure_ai_sessions(session_type, context_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_secure_ai_jobs_session ON secure_ai_jobs(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_secure_ai_consent_session_user ON secure_ai_consent_events(session_id, user_id, created_at DESC);
  `);
}

module.exports = { ensureSecureAiSchema };
