
/**
 * In-process job runner for Secure AI Notes.
 * Keeps jobs persisted in Postgres (secure_ai_jobs) and executes them sequentially.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { GetObjectCommand } = require("@aws-sdk/client-s3");

let _runner = null;

function initSecureAiJobRunner(deps) {
  if (_runner) return _runner;
  _runner = new SecureAiJobRunner(deps);
  _runner.start();
  return _runner;
}

class SecureAiJobRunner {
  constructor(deps) {
    this.deps = deps;
    this.queue = [];
    this.active = new Set();
    this.running = false;
    this.retentionTimer = null;
  }

  start() {
    // no-op: worker is on-demand
  }

  enqueue(jobId) {
    const id = String(jobId);
    if (this.active.has(id)) return;
    this.active.add(id);
    this.queue.push(id);
    this._kick();
  }

  _kick() {
    if (this.running) return;
    const next = this.queue.shift();
    if (!next) return;
    this.running = true;
    setImmediate(async () => {
      try {
        await this._processJob(next);
      } catch (e) {
        console.error("[secure-ai] job crashed", next, e);
      } finally {
        this.running = false;
        this.active.delete(next);
        this._kick();
      }
    });
  }

  async _setJob(jobId, patch) {
    const { safeQuery } = this.deps;
    const status = patch.status ?? null;
    const progress = patch.progress ?? null;
    const error = patch.error ?? null;
    await safeQuery(
      `UPDATE secure_ai_jobs
       SET status = COALESCE($2, status),
           progress = COALESCE($3, progress),
           error = $4,
           updated_at = now()
       WHERE id = $1`,
      [jobId, status, progress, error]
    );
  }

  async _setSessionStatus(sessionId, status) {
    const { safeQuery } = this.deps;
    await safeQuery(`UPDATE secure_ai_sessions SET status = $2 WHERE id = $1`, [sessionId, status]);
  }

  async _fetchJob(jobId) {
    const { safeQuery } = this.deps;
    const r = await safeQuery(
      `SELECT id, session_id, status, progress
       FROM secure_ai_jobs
       WHERE id = $1
       LIMIT 1`,
      [jobId]
    );
    if (!r.rowCount) throw new Error("Job not found: " + jobId);
    return r.rows[0];
  }

  async _fetchSession(sessionId) {
    const { safeQuery } = this.deps;
    const r = await safeQuery(
      `SELECT id, created_by, session_type, title, status, started_at, ended_at, room_id, created_at
       FROM secure_ai_sessions
       WHERE id = $1
       LIMIT 1`,
      [sessionId]
    );
    if (!r.rowCount) throw new Error("Session not found: " + sessionId);
    return r.rows[0];
  }

  async _fetchParticipants(sessionId) {
    const { safeQuery } = this.deps;
    const r = await safeQuery(
      `SELECT user_id, display_name, joined_at, left_at
       FROM secure_ai_participants
       WHERE session_id = $1
       ORDER BY joined_at ASC`,
      [sessionId]
    );
    return r.rows.map((p) => ({
      userId: String(p.user_id),
      displayName: p.display_name || String(p.user_id),
      joinedAt: p.joined_at,
      leftAt: p.left_at,
    }));
  }

  async _computeConsent(sessionId) {
    const { safeQuery } = this.deps;
    const participants = await safeQuery(
      `SELECT user_id
       FROM secure_ai_participants
       WHERE session_id = $1 AND left_at IS NULL`,
      [sessionId]
    );
    const ids = participants.rows.map((r) => String(r.user_id));
    if (!ids.length) return { required: 0, accepted: 0, allConsented: true };

    const latest = await safeQuery(
      `SELECT DISTINCT ON (user_id) user_id, consent
       FROM secure_ai_consent_events
       WHERE session_id = $1
       ORDER BY user_id, created_at DESC`,
      [sessionId]
    );
    const latestMap = {};
    for (const row of latest.rows) latestMap[String(row.user_id)] = !!row.consent;
    let accepted = 0;
    for (const id of ids) if (latestMap[id] === true) accepted += 1;
    return { required: ids.length, accepted, allConsented: accepted === ids.length };
  }

  _sessionDir(sessionId) {
    return path.join(this.deps.dataRoot, String(sessionId));
  }

  async _processJob(jobId) {
    const { safeQuery } = this.deps;
    const job = await this._fetchJob(jobId);
    const sessionId = job.session_id;
    const session = await this._fetchSession(sessionId);

    try {
    await this._setJob(jobId, { status: "PROCESSING", progress: "Preparing" });
    await this._setSessionStatus(sessionId, "PROCESSING");

    const sessDir = this._sessionDir(sessionId);
    fs.mkdirSync(sessDir, { recursive: true });

    const participants = await this._fetchParticipants(sessionId);
    const consent = await this._computeConsent(sessionId);

    // 1) Prepare transcript
    let transcript = null;

    if (String(session.session_type) === "chat") {
      await this._setJob(jobId, { progress: "Reading chat log" });
      const chatPath = path.join(sessDir, "chat.txt");
      const chatText = fs.existsSync(chatPath) ? fs.readFileSync(chatPath, "utf-8") : "";
      const lines = chatText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 8000);

      transcript = {
        language: "unknown",
        segments: lines.map((text, i) => ({
          start: i * 1.0,
          end: i * 1.0,
          speaker: "Chat",
          text,
        })),
      };
    } else {
      await this._setJob(jobId, { progress: "Stitching audio" });
      const stitched = await this.deps.stitchSessionAudioToWav({
        sessionId,
        dataRoot: this.deps.dataRoot,
        ffmpegPath: this.deps.ffmpegPath,
      });
      await this._setJob(jobId, { progress: "Transcribing" });
      transcript = await this.deps.transcribeAudioWav({ wavPath: stitched.wavPath });
    }

    fs.writeFileSync(path.join(sessDir, "transcript.json"), JSON.stringify(transcript, null, 2), "utf-8");

    // 2) Summarize
    await this._setJob(jobId, { progress: "Summarizing" });
    const summary = await this.deps.summarizeTranscript({
      transcript,
      meta: {
        title: session.title || "Conversation",
        sessionType: session.session_type,
        participants: participants.map((p) => p.displayName),
      },
    });

    fs.writeFileSync(path.join(sessDir, "summary.json"), JSON.stringify(summary, null, 2), "utf-8");

    // 3) Render PDF
    await this._setJob(jobId, { progress: "Rendering PDF" });
    const includeTranscript = String(process.env.SECURE_AI_PDF_INCLUDE_TRANSCRIPT || "false").toLowerCase() === "true";
    const pdfBuffer = await this.deps.renderConversationReportPdf({
      meta: {
        title: summary?.title || session.title || "Conversation Report",
        sessionType: session.session_type,
        startedAt: session.started_at || session.created_at || new Date().toISOString(),
        endedAt: session.ended_at || new Date().toISOString(),
        participants: participants.map((p) => p.displayName),
        consent,
      },
      transcript: includeTranscript ? transcript : null,
      summary,
    });

    // 4) Store artifacts in Vault (reports + transcript JSON). Audio storage is optional.
    await this._setJob(jobId, { progress: "Saving to Vault" });

    const ownerUser = { id: session.created_by, display_name: null, email: null };
    const folderKey = process.env.SECURE_AI_VAULT_FOLDER || "AI Notes";

    const nowTag = new Date().toISOString().replace(/[:.]/g, "-");
    const safeTitle = (session.title || "conversation").replace(/[^\w\- ]+/g, "").trim().slice(0, 60) || "conversation";
    const pdfName = `AI_Notes_${safeTitle}_${nowTag}.pdf`;
    const transcriptName = `AI_Notes_${safeTitle}_${nowTag}_transcript.json`;

    const reportObj = await this.deps.storeBufferToVault({
      rootDir: this.deps.rootDir,
      user: ownerUser,
      folderKey,
      originalName: pdfName,
      buffer: pdfBuffer,
      mimeType: "application/pdf",
      safeQuery,
      dbHasTable: this.deps.dbHasTable,
      dbHasColumn: this.deps.dbHasColumn,
      s3: this.deps.s3,
      vaultBucket: this.deps.vaultBucket,
      requireAwsEnvOrThrow: this.deps.requireAwsEnvOrThrow,
      getUserVaultPrefix: this.deps.getUserVaultPrefix,
      safeExtFromName: this.deps.safeExtFromName,
      ensureVaultRootTrashWorking: this.deps.ensureVaultRootTrashWorking,
      ensureVaultFolderPath: this.deps.ensureVaultFolderPath,
      normVaultFolderKey: this.deps.normVaultFolderKey,
      vaultFoldersHaveTreeColumns: this.deps.vaultFoldersHaveTreeColumns,
    });

    const transcriptObj = await this.deps.storeBufferToVault({
      rootDir: this.deps.rootDir,
      user: ownerUser,
      folderKey,
      originalName: transcriptName,
      buffer: Buffer.from(JSON.stringify(transcript, null, 2), "utf-8"),
      mimeType: "application/json",
      safeQuery,
      dbHasTable: this.deps.dbHasTable,
      dbHasColumn: this.deps.dbHasColumn,
      s3: this.deps.s3,
      vaultBucket: this.deps.vaultBucket,
      requireAwsEnvOrThrow: this.deps.requireAwsEnvOrThrow,
      getUserVaultPrefix: this.deps.getUserVaultPrefix,
      safeExtFromName: this.deps.safeExtFromName,
      ensureVaultRootTrashWorking: this.deps.ensureVaultRootTrashWorking,
      ensureVaultFolderPath: this.deps.ensureVaultFolderPath,
      normVaultFolderKey: this.deps.normVaultFolderKey,
      vaultFoldersHaveTreeColumns: this.deps.vaultFoldersHaveTreeColumns,
    });

    await safeQuery(
      `INSERT INTO secure_ai_reports (session_id, storage_key, created_at)
       VALUES ($1, $2, now())
       ON CONFLICT (session_id)
       DO UPDATE SET storage_key = EXCLUDED.storage_key, created_at = now()`,
      [sessionId, reportObj.storageKey]
    );

    await safeQuery(
      `INSERT INTO secure_ai_transcripts (session_id, storage_key, created_at)
       VALUES ($1, $2, now())
       ON CONFLICT (session_id)
       DO UPDATE SET storage_key = EXCLUDED.storage_key, created_at = now()`,
      [sessionId, transcriptObj.storageKey]
    );

    await this._setJob(jobId, { status: "READY", progress: "Ready", error: null });
    await this._setSessionStatus(sessionId, "READY");
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e);
      console.error("[secure-ai] job failed", jobId, msg);
      await this._setJob(jobId, { status: "FAILED", progress: "Failed", error: msg.slice(0, 2000) });
      await this._setSessionStatus(sessionId, "FAILED");
    }
  }

  // -----------------------------
  // Storage streaming + deletion
  // -----------------------------
  async streamStorageKeyToResponse(storageKey, res) {
    const key = String(storageKey || "");
    if (!key) throw new Error("Missing storageKey");

    if (key.startsWith("local/")) {
      // local/<userId>/<rel>
      const parts = key.split("/");
      if (parts.length < 3) throw new Error("Bad local key");
      const userId = parts[1];
      const rel = parts.slice(2).join("/");
      const abs = path.join(this.deps.rootDir, "uploads", "vault", String(userId), rel);
      const stream = fs.createReadStream(abs);
      return new Promise((resolve, reject) => {
        stream.on("error", reject);
        stream.on("end", resolve);
        stream.pipe(res);
      });
    }

    // S3
    this.deps.requireAwsEnvOrThrow();
    const out = await this.deps.s3.send(new GetObjectCommand({ Bucket: this.deps.vaultBucket, Key: key }));
    return new Promise((resolve, reject) => {
      out.Body.on("error", reject);
      out.Body.on("end", resolve);
      out.Body.pipe(res);
    });
  }

  async deleteSessionArtifacts(sessionId, ownerUser) {
    const { safeQuery } = this.deps;
    const sid = String(sessionId);

    const r1 = await safeQuery(`SELECT storage_key FROM secure_ai_reports WHERE session_id = $1`, [sid]);
    const r2 = await safeQuery(`SELECT storage_key FROM secure_ai_transcripts WHERE session_id = $1`, [sid]);
    const r3 = await safeQuery(`SELECT storage_key FROM secure_ai_recordings WHERE session_id = $1`, [sid]);

    const keys = []
      .concat(r1.rows.map((r) => r.storage_key))
      .concat(r2.rows.map((r) => r.storage_key))
      .concat(r3.rows.map((r) => r.storage_key))
      .filter(Boolean);

    for (const key of keys) {
      // Best-effort: hide from Vault UI, then delete underlying object
      await this.deps.softDeleteVaultObjectRow({
        userId: String(ownerUser.id),
        storageKey: key,
        safeQuery,
        dbHasTable: this.deps.dbHasTable,
        dbHasColumn: this.deps.dbHasColumn,
      }).catch(() => {});

      await this.deps.deleteVaultObjectByStorageKey({
        storageKey: key,
        rootDir: this.deps.rootDir,
        s3: this.deps.s3,
        vaultBucket: this.deps.vaultBucket,
        requireAwsEnvOrThrow: this.deps.requireAwsEnvOrThrow,
      }).catch(() => {});
    }

    // Remove server-side working directory
    const sessDir = this._sessionDir(sid);
    try {
      fs.rmSync(sessDir, { recursive: true, force: true });
    } catch {}

    // Delete DB rows (cascade)
    await safeQuery(`DELETE FROM secure_ai_sessions WHERE id = $1`, [sid]);
  }

  // -----------------------------
  // Retention cleanup
  // -----------------------------
  startRetentionCleanup() {
    if (this.retentionTimer) return;

    const raw = String(process.env.SECURE_AI_RETENTION_DAYS || "7").trim();
    const days = Number.parseInt(raw, 10);
    if (!Number.isFinite(days) || days <= 0) return;

    const intervalMs = 24 * 60 * 60 * 1000;

    const run = async () => {
      try {
        const { safeQuery } = this.deps;
        const r = await safeQuery(
          `SELECT id, created_by
           FROM secure_ai_sessions
           WHERE ended_at IS NOT NULL
             AND ended_at < (now() - ($1::text || ' days')::interval)
           ORDER BY ended_at ASC
           LIMIT 50`,
          [String(days)]
        );

        for (const row of r.rows) {
          // eslint-disable-next-line no-await-in-loop
          await this.deleteSessionArtifacts(row.id, { id: row.created_by }).catch(() => {});
        }
      } catch (e) {
        console.error("[secure-ai] retention cleanup failed", e);
      }
    };

    // Run once shortly after start, then daily
    setTimeout(run, 10_000);
    this.retentionTimer = setInterval(run, intervalMs);
  }
}

module.exports = { initSecureAiJobRunner };
