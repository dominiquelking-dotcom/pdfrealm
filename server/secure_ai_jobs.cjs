// PDFRealm Secure Suite: Secure AI Notes Assistant job runner
// /PDFREALM_SECURE_AI_JOBS_V1
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { stitchWebmChunks } = require("./secure_ai_stitch.cjs");
const { transcribeAudioWav } = require("./secure_ai_transcribe.cjs");
const { summarizeTranscript } = require("./secure_ai_summarize.cjs");
const { generateReportPdfBuffer } = require("./secure_ai_pdf.cjs");
const { putVaultObject, putVaultObjectFromFile, deleteVaultObject } = require("./secure_ai_storage.cjs");

const ROOT_DIR = path.join(__dirname, "..");

function sessionWorkDir(sessionId) {
  return path.join(ROOT_DIR, "data", "secure-ai", String(sessionId));
}

function parseUserIdFromActorKey(actorKey) {
  // created_by is "user:<uuid>"
  const m = /^user:(.+)$/.exec(String(actorKey || ""));
  return m ? m[1] : null;
}

async function setJob(pool, jobId, patch) {
  const fields = [];
  const vals = [];
  let i = 1;
  for (const [k, v] of Object.entries(patch || {})) {
    fields.push(`${k} = $${i++}`);
    vals.push(v);
  }
  vals.push(jobId);
  await pool.query(`UPDATE secure_ai_jobs SET ${fields.join(", ")}, updated_at = NOW() WHERE id = $${i}`, vals);
}

async function setSessionStatus(pool, sessionId, status, patch) {
  const fields = ["status = $2", "updated_at = NOW()"];
  const vals = [sessionId, status];
  let i = 3;
  for (const [k, v] of Object.entries(patch || {})) {
    fields.push(`${k} = $${i++}`);
    vals.push(v);
  }
  await pool.query(`UPDATE secure_ai_sessions SET ${fields.join(", ")} WHERE id = $1`, vals);
}

async function getSession(pool, sessionId) {
  const r = await pool.query("SELECT * FROM secure_ai_sessions WHERE id = $1", [sessionId]);
  return r.rows[0] || null;
}

async function getParticipants(pool, sessionId) {
  const r = await pool.query("SELECT user_id, display_name FROM secure_ai_participants WHERE session_id = $1 ORDER BY joined_at ASC", [sessionId]);
  return r.rows || [];
}

async function getConsentSummary(pool, sessionId) {
  const r = await pool.query(
    `
    WITH latest AS (
      SELECT DISTINCT ON (user_id) user_id, consent, created_at
      FROM secure_ai_consent_events
      WHERE session_id = $1
      ORDER BY user_id, created_at DESC
    )
    SELECT
      (SELECT COUNT(*) FROM secure_ai_participants WHERE session_id = $1) AS participants_total,
      (SELECT COUNT(*) FROM latest WHERE consent = TRUE) AS consent_true,
      (SELECT COUNT(*) FROM latest WHERE consent = FALSE) AS consent_false
  `,
    [sessionId]
  );
  return r.rows[0] || { participants_total: 0, consent_true: 0, consent_false: 0 };
}

async function upsertRecording(pool, sessionId, rec) {
  await pool.query(
    `
    INSERT INTO secure_ai_recordings (session_id, mime_type, duration_sec, storage_key, size_bytes)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (session_id) DO UPDATE
      SET mime_type = EXCLUDED.mime_type,
          duration_sec = EXCLUDED.duration_sec,
          storage_key = EXCLUDED.storage_key,
          size_bytes = EXCLUDED.size_bytes,
          created_at = NOW()
  `,
    [sessionId, rec.mime_type || null, rec.duration_sec || null, rec.storage_key || null, rec.size_bytes || null]
  );
}

async function upsertTranscript(pool, sessionId, tr) {
  await pool.query(
    `
    INSERT INTO secure_ai_transcripts (session_id, storage_key, language, diarization)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (session_id) DO UPDATE
      SET storage_key = EXCLUDED.storage_key,
          language = EXCLUDED.language,
          diarization = EXCLUDED.diarization,
          created_at = NOW()
  `,
    [sessionId, tr.storage_key || null, tr.language || null, !!tr.diarization]
  );
}

async function upsertReport(pool, sessionId, rep) {
  await pool.query(
    `
    INSERT INTO secure_ai_reports (session_id, storage_key)
    VALUES ($1, $2)
    ON CONFLICT (session_id) DO UPDATE
      SET storage_key = EXCLUDED.storage_key,
          created_at = NOW()
  `,
    [sessionId, rep.storage_key]
  );
}

async function deleteSessionArtifacts(pool, sessionId) {
  const sess = await getSession(pool, sessionId);
  if (!sess) return;

  // Delete vault objects referenced by DB
  const keys = [];
  const r1 = await pool.query("SELECT storage_key FROM secure_ai_reports WHERE session_id = $1", [sessionId]);
  const r2 = await pool.query("SELECT storage_key FROM secure_ai_transcripts WHERE session_id = $1", [sessionId]);
  const r3 = await pool.query("SELECT storage_key FROM secure_ai_recordings WHERE session_id = $1", [sessionId]);
  for (const r of [r1, r2, r3]) {
    for (const row of r.rows || []) {
      if (row.storage_key) keys.push(row.storage_key);
    }
  }
  for (const k of keys) {
    try { await deleteVaultObject(k); } catch (_) {}
  }

  // Delete local workdir
  const dir = sessionWorkDir(sessionId);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}

  // Delete DB session (cascades to others)
  await pool.query("DELETE FROM secure_ai_sessions WHERE id = $1", [sessionId]);
}

async function processJob(pool, jobId, sessionId) {
  const session = await getSession(pool, sessionId);
  if (!session) throw new Error("Session not found for job.");

  await setSessionStatus(pool, sessionId, "PROCESSING");
  await setJob(pool, jobId, { progress: "Loading inputs…" });

  const workDir = sessionWorkDir(sessionId);
  fs.mkdirSync(workDir, { recursive: true });

  const participants = await getParticipants(pool, sessionId);
  const consent = await getConsentSummary(pool, sessionId);

  const createdByUserId = parseUserIdFromActorKey(session.created_by);
  if (!createdByUserId) throw new Error("Session created_by is invalid.");

  let transcript = null;
  let combinedWebmPath = null;

  if (session.session_type === "chat") {
    await setJob(pool, jobId, { progress: "Reading chat transcript…" });
    const chatPath = path.join(workDir, "chat_transcript.json");
    if (!fs.existsSync(chatPath)) throw new Error("Chat transcript missing. (Host must upload before finalize.)");
    const obj = JSON.parse(fs.readFileSync(chatPath, "utf8"));
    const messages = Array.isArray(obj.messages) ? obj.messages : [];
    const segments = messages.map((m, idx) => ({
      start: idx,
      end: idx,
      speaker: m.who || "Participant",
      text: m.text || ""
    }));
    transcript = { provider: "CLIENT_CHAT", language: null, segments };
  } else {
    await setJob(pool, jobId, { progress: "Stitching audio chunks…" });
    const stitched = stitchWebmChunks({ sessionDir: workDir });
    combinedWebmPath = stitched.combinedWebmPath;

    await setJob(pool, jobId, { progress: "Transcribing audio…" });
    transcript = await transcribeAudioWav({ wavPath: stitched.wavPath });

    // Save transcript to local for audit/debug
    fs.writeFileSync(path.join(workDir, "transcript.json"), JSON.stringify(transcript, null, 2));
  }

  await setJob(pool, jobId, { progress: "Summarizing transcript…" });
  const summary = await summarizeTranscript({ transcript, session });

  await setJob(pool, jobId, { progress: "Rendering PDF report…" });
  const includeTranscript = String(process.env.SECURE_AI_INCLUDE_TRANSCRIPT || "0") === "1";
  const pdfBuf = await generateReportPdfBuffer({
    session,
    participants,
    summary,
    transcript,
    includeTranscript
  });

  await setJob(pool, jobId, { progress: "Storing artifacts in Vault…" });

  // Transcript JSON to Vault
  const transcriptBuf = Buffer.from(JSON.stringify({ session, participants, consent, transcript, summary }, null, 2), "utf8");
  const trObj = await putVaultObject({
    userId: createdByUserId,
    folderPath: "Secure AI Notes",
    fileName: `${sessionId}_transcript.json`,
    mimeType: "application/json",
    buffer: transcriptBuf
  });
  await upsertTranscript(pool, sessionId, { storage_key: trObj.storageKey, language: transcript.language || null, diarization: false });

  // Report PDF to Vault
  const repObj = await putVaultObject({
    userId: createdByUserId,
    folderPath: "Secure AI Notes",
    fileName: `${sessionId}_report.pdf`,
    mimeType: "application/pdf",
    buffer: pdfBuf
  });
  await upsertReport(pool, sessionId, { storage_key: repObj.storageKey });

  // Combined audio to Vault (for video/voip)
  if (combinedWebmPath && fs.existsSync(combinedWebmPath)) {
    const audObj = await putVaultObjectFromFile({
      userId: createdByUserId,
      folderPath: "Secure AI Notes",
      fileName: `${sessionId}_audio.webm`,
      mimeType: "audio/webm",
      absPath: combinedWebmPath
    });
    await upsertRecording(pool, sessionId, { storage_key: audObj.storageKey, mime_type: "audio/webm", size_bytes: audObj.sizeBytes });
  }

  await setJob(pool, jobId, { status: "READY", progress: "Done." });
  await setSessionStatus(pool, sessionId, "READY");
}

function startSecureAiJobWorker(pool) {
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const r = await pool.query(
        "SELECT id, session_id FROM secure_ai_jobs WHERE status = 'QUEUED' ORDER BY created_at ASC LIMIT 1"
      );
      const job = r.rows[0];
      if (!job) return;

      await setJob(pool, job.id, { status: "RUNNING", progress: "Starting…" });
      try {
        await processJob(pool, job.id, job.session_id);
      } catch (e) {
        console.error("[SecureAI] job failed", e);
        await setJob(pool, job.id, { status: "FAILED", error: e.message || String(e), progress: "Failed." });
        try { await setSessionStatus(pool, job.session_id, "FAILED"); } catch (_) {}
      }
    } finally {
      running = false;
    }
  }

  // Poll queue
  setInterval(tick, 2000);
  setTimeout(tick, 500);
}

function startRetentionCleanup(pool) {
  const days = Number(process.env.SECURE_AI_RETENTION_DAYS || 7);
  const intervalMs = 24 * 60 * 60 * 1000;

  async function cleanup() {
    try {
      const r = await pool.query(
        "SELECT id FROM secure_ai_sessions WHERE created_at < NOW() - ($1 * INTERVAL '1 day')",
        [days]
      );
      for (const row of r.rows || []) {
        try {
          await deleteSessionArtifacts(pool, row.id);
        } catch (e) {
          console.warn("[SecureAI] retention cleanup failed for session", row.id, e.message || e);
        }
      }
    } catch (e) {
      console.warn("[SecureAI] retention cleanup query failed", e.message || e);
    }
  }

  setInterval(cleanup, intervalMs);
  setTimeout(cleanup, 10_000);
}

module.exports = {
  startSecureAiJobWorker,
  startRetentionCleanup,
  deleteSessionArtifacts
};
