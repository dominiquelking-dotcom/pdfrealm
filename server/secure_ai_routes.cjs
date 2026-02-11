// PDFRealm Secure Suite: Secure AI Notes Assistant routes
// /PDFREALM_SECURE_AI_ROUTES_V1
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const { ensureSecureAiSchema } = require("./secure_ai_schema.cjs");
const { streamVaultObjectToResponse } = require("./secure_ai_storage.cjs");
const { startSecureAiJobWorker, startRetentionCleanup, deleteSessionArtifacts } = require("./secure_ai_jobs.cjs");

const ROOT_DIR = path.join(__dirname, "..");

function isUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(s || ""));
}

function videoGuestSecret() {
  return process.env.VIDEO_GUEST_SECRET || process.env.JWT_SECRET || "dev-video-guest-secret";
}
function voiceGuestSecret() {
  return process.env.VOICE_GUEST_SECRET || process.env.JWT_SECRET || "dev-voice-guest-secret";
}
function chatGuestSecret() {
  return process.env.CHAT_GUEST_SECRET || process.env.JWT_SECRET || "dev-secret";
}

function parseCookiesFallback(req) {
  const out = {};
  const raw = req.headers.cookie || "";
  raw.split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) {
      const k = p.slice(0, i).trim();
      const v = p.slice(i + 1).trim();
      out[k] = decodeURIComponent(v);
    }
  });
  return out;
}

function actorFromUser(user) {
  if (!user || !user.id) return null;
  return { kind: "user", actorKey: `user:${user.id}`, displayName: user.email || user.name || user.id, raw: user };
}

function actorFromGuestToken(sessionType, token) {
  try {
    const secret = sessionType === "video" ? videoGuestSecret() : sessionType === "voip" ? voiceGuestSecret() : chatGuestSecret();
    const p = jwt.verify(token, secret);
    const ctxId = sessionType === "video" ? p.room_id : sessionType === "voip" ? p.room_id : p.thread_id;
    const gid = p.guest_id;
    const gname = p.guest_name || p.display_name || "Guest";
    if (!ctxId || !gid) return null;
    return { kind: "guest", actorKey: `guest:${gid}`, displayName: gname, contextId: ctxId, raw: p };
  } catch (_) {
    return null;
  }
}

async function checkMembership(pool, sessionType, contextId, actor) {
  if (!actor) return false;
  if (actor.kind === "guest") {
    // token itself is the membership proof; must match context
    return String(actor.contextId) === String(contextId);
  }
  if (actor.kind !== "user") return false;

  const uid = actor.raw.id;
  if (!uid) return false;

  if (sessionType === "video") {
    if (!isUuid(contextId) || !isUuid(uid)) return false;
    const r = await pool.query(
      "SELECT role FROM video_members WHERE room_id = $1 AND user_id = $2 AND removed_at IS NULL LIMIT 1",
      [contextId, uid]
    );
    return !!r.rows[0];
  }
  if (sessionType === "voip") {
    if (!isUuid(contextId) || !isUuid(uid)) return false;
    const r = await pool.query(
      "SELECT role FROM voice_members WHERE room_id = $1 AND user_id = $2 AND removed_at IS NULL LIMIT 1",
      [contextId, uid]
    );
    return !!r.rows[0];
  }
  if (sessionType === "chat") {
    if (!isUuid(contextId) || !isUuid(uid)) return false;
    const r = await pool.query(
      "SELECT role FROM chat_members WHERE thread_id = $1 AND user_id = $2 AND removed_at IS NULL LIMIT 1",
      [contextId, uid]
    );
    return !!r.rows[0];
  }
  return false;
}

async function checkOwner(pool, sessionType, contextId, userId) {
  if (!userId) return false;
  if (sessionType === "video") {
    const r = await pool.query(
      "SELECT 1 FROM video_members WHERE room_id = $1 AND user_id = $2 AND removed_at IS NULL AND role = 'owner' LIMIT 1",
      [contextId, userId]
    );
    return !!r.rows[0];
  }
  if (sessionType === "voip") {
    const r = await pool.query(
      "SELECT 1 FROM voice_members WHERE room_id = $1 AND user_id = $2 AND removed_at IS NULL AND role = 'owner' LIMIT 1",
      [contextId, userId]
    );
    return !!r.rows[0];
  }
  if (sessionType === "chat") {
    const r = await pool.query(
      "SELECT 1 FROM chat_members WHERE thread_id = $1 AND user_id = $2 AND removed_at IS NULL AND role = 'owner' LIMIT 1",
      [contextId, userId]
    );
    return !!r.rows[0];
  }
  return false;
}

function sessionDir(sessionId) {
  return path.join(ROOT_DIR, "data", "secure-ai", String(sessionId));
}

function requireSessionType(x) {
  const t = String(x || "").toLowerCase();
  if (t === "video" || t === "voip" || t === "chat") return t;
  return null;
}

async function computeConsent(pool, sessionId) {
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
  const row = r.rows[0] || { participants_total: 0, consent_true: 0, consent_false: 0 };
  const total = Number(row.participants_total || 0);
  const yes = Number(row.consent_true || 0);
  const no = Number(row.consent_false || 0);
  return { total, yes, no, allConsented: total > 0 && yes === total && no === 0, anyDeclined: no > 0 };
}

async function upsertParticipant(pool, sessionId, actorKey, displayName) {
  await pool.query(
    `
    INSERT INTO secure_ai_participants (session_id, user_id, display_name)
    VALUES ($1, $2, $3)
    ON CONFLICT (session_id, user_id) DO UPDATE
      SET display_name = COALESCE(EXCLUDED.display_name, secure_ai_participants.display_name),
          left_at = NULL
  `,
    [sessionId, actorKey, displayName || null]
  );
}

async function latestConsentForActor(pool, sessionId, actorKey) {
  const r = await pool.query(
    "SELECT consent FROM secure_ai_consent_events WHERE session_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 1",
    [sessionId, actorKey]
  );
  if (!r.rows[0]) return null;
  return r.rows[0].consent;
}

function mountSecureAi(app, deps) {
  const pool = deps.pool;
  const getUserFromRequest = deps.getUserFromRequest;
  const parseCookies = deps.parseCookies || parseCookiesFallback;

  ensureSecureAiSchema(pool)
    .then(() => {
      startSecureAiJobWorker(pool);
      startRetentionCleanup(pool);
    })
    .catch((e) => console.error("[SecureAI] schema ensure failed", e));

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

  const router = express.Router();

  // Create session (owner-only)
  router.post("/session", express.json(), async (req, res) => {
    try {
      const sessionType = requireSessionType(req.body?.sessionType);
      const contextId = String(req.body?.contextId || "");
      const title = String(req.body?.title || "");

      if (!sessionType || !contextId) return res.status(400).json({ error: "Missing sessionType/contextId" });

      const user = getUserFromRequest ? getUserFromRequest(req) : null;
      if (!user) return res.status(401).json({ error: "Auth required" });

      // Must be owner in the underlying tool context
      if (!isUuid(user.id) || !isUuid(contextId)) return res.status(400).json({ error: "Invalid IDs" });
      const ok = await checkOwner(pool, sessionType, contextId, user.id);
      if (!ok) return res.status(403).json({ error: "Only the owner can start AI Notes." });

      const sessionId = crypto.randomUUID();

      const createdBy = `user:${user.id}`;
      await pool.query(
        `
        INSERT INTO secure_ai_sessions (id, created_by, session_type, context_id, title, status)
        VALUES ($1, $2, $3, $4, $5, 'CONSENT_PENDING')
      `,
        [sessionId, createdBy, sessionType, contextId, title]
      );

      // Host is a participant and implicitly consents by enabling
      await upsertParticipant(pool, sessionId, createdBy, user.email || user.name || user.id);
      await pool.query(
        "INSERT INTO secure_ai_consent_events (session_id, user_id, consent) VALUES ($1, $2, TRUE)",
        [sessionId, createdBy]
      );

      res.json({ sessionId });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  // Active session state for a given tool context
  router.get("/active", async (req, res) => {
    try {
      const sessionType = requireSessionType(req.query?.sessionType);
      const contextId = String(req.query?.contextId || "");
      if (!sessionType || !contextId) return res.status(400).json({ error: "Missing sessionType/contextId" });

      // Determine actor (user or guest) and membership
      const user = getUserFromRequest ? getUserFromRequest(req) : null;
      let actor = actorFromUser(user);
      if (!actor) {
        const cookies = parseCookies(req) || {};
        const tokenName = sessionType === "video" ? "pdfrealm_video_guest" : sessionType === "voip" ? "pdfrealm_voice_guest" : "pdfrealm_chat_guest";
        actor = actorFromGuestToken(sessionType, cookies[tokenName] || "");
      }
      const member = await checkMembership(pool, sessionType, contextId, actor);
      if (!member) return res.status(403).json({ active: false });

      const r = await pool.query(
        "SELECT * FROM secure_ai_sessions WHERE session_type = $1 AND context_id = $2 ORDER BY created_at DESC LIMIT 1",
        [sessionType, contextId]
      );
      const sess = r.rows[0];
      if (!sess) return res.json({ active: false });

      // Upsert participant
      await upsertParticipant(pool, sess.id, actor.actorKey, actor.displayName);

      // Consent state
      const consent = await computeConsent(pool, sess.id);
      const last = await latestConsentForActor(pool, sess.id, actor.actorKey);
      const needsConsent = last === null && sess.status !== "FAILED";

      // Report ready?
      const rep = await pool.query("SELECT 1 FROM secure_ai_reports WHERE session_id = $1 LIMIT 1", [sess.id]);
      const reportReady = !!rep.rows[0] && sess.status === "READY";

      // Latest job (optional)
      const job = await pool.query(
        "SELECT status, progress, error FROM secure_ai_jobs WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1",
        [sess.id]
      );
      const j = job.rows[0] || null;

      res.json({
        active: true,
        sessionId: sess.id,
        sessionType: sess.session_type,
        contextId: sess.context_id,
        title: sess.title,
        status: sess.status,
        allConsented: consent.allConsented,
        anyDeclined: consent.anyDeclined,
        needsConsent,
        reportReady,
        job: j
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  // Consent event
  router.post("/session/:id/consent", express.json(), async (req, res) => {
    try {
      const sessionId = String(req.params.id || "");
      if (!isUuid(sessionId)) return res.status(400).json({ error: "Bad session id" });

      const s = await pool.query("SELECT * FROM secure_ai_sessions WHERE id = $1", [sessionId]);
      const sess = s.rows[0];
      if (!sess) return res.status(404).json({ error: "Session not found" });

      const sessionType = sess.session_type;
      const contextId = sess.context_id;

      // Actor user or guest
      const user = getUserFromRequest ? getUserFromRequest(req) : null;
      let actor = actorFromUser(user);
      if (!actor) {
        const cookies = parseCookies(req) || {};
        const tokenName = sessionType === "video" ? "pdfrealm_video_guest" : sessionType === "voip" ? "pdfrealm_voice_guest" : "pdfrealm_chat_guest";
        actor = actorFromGuestToken(sessionType, cookies[tokenName] || "");
      }
      const member = await checkMembership(pool, sessionType, contextId, actor);
      if (!member) return res.status(403).json({ error: "Not allowed" });

      const consent = !!req.body?.consent;

      await upsertParticipant(pool, sessionId, actor.actorKey, actor.displayName);
      await pool.query(
        "INSERT INTO secure_ai_consent_events (session_id, user_id, consent) VALUES ($1, $2, $3)",
        [sessionId, actor.actorKey, consent]
      );

      const c = await computeConsent(pool, sessionId);

      if (c.anyDeclined) {
        await pool.query("UPDATE secure_ai_sessions SET status='FAILED', ended_at=NOW(), updated_at=NOW() WHERE id=$1", [sessionId]);
      }

      res.json({ ok: true, allConsented: c.allConsented, anyDeclined: c.anyDeclined });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  // Mark recording/capture started (owner-only)
  router.post("/session/:id/start", async (req, res) => {
    try {
      const sessionId = String(req.params.id || "");
      if (!isUuid(sessionId)) return res.status(400).json({ error: "Bad session id" });

      const s = await pool.query("SELECT * FROM secure_ai_sessions WHERE id = $1", [sessionId]);
      const sess = s.rows[0];
      if (!sess) return res.status(404).json({ error: "Session not found" });

      const user = getUserFromRequest ? getUserFromRequest(req) : null;
      const actor = actorFromUser(user);
      if (!actor) return res.status(401).json({ error: "Auth required" });

      if (actor.actorKey !== sess.created_by) return res.status(403).json({ error: "Owner only" });

      const c = await computeConsent(pool, sessionId);
      if (!c.allConsented) return res.status(409).json({ error: "Waiting for consent" });

      await pool.query(
        "UPDATE secure_ai_sessions SET status='RECORDING', started_at = COALESCE(started_at, NOW()), updated_at=NOW() WHERE id=$1 AND status <> 'FAILED'",
        [sessionId]
      );

      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  // Upload audio chunk (owner-only)
  router.post("/session/:id/chunk", upload.single("chunk"), async (req, res) => {
    try {
      const sessionId = String(req.params.id || "");
      if (!isUuid(sessionId)) return res.status(400).json({ error: "Bad session id" });

      const s = await pool.query("SELECT * FROM secure_ai_sessions WHERE id = $1", [sessionId]);
      const sess = s.rows[0];
      if (!sess) return res.status(404).json({ error: "Session not found" });

      const user = getUserFromRequest ? getUserFromRequest(req) : null;
      const actor = actorFromUser(user);
      if (!actor) return res.status(401).json({ error: "Auth required" });
      if (actor.actorKey !== sess.created_by) return res.status(403).json({ error: "Owner only" });

      const c = await computeConsent(pool, sessionId);
      if (!c.allConsented) return res.status(409).json({ error: "Waiting for consent" });

      const seq = Number(req.body?.seq || 0);
      const mimeType = String(req.body?.mimeType || "audio/webm");
      const file = req.file;
      if (!file || !file.buffer) return res.status(400).json({ error: "Missing chunk" });

      const dir = sessionDir(sessionId);
      const chunksDir = path.join(dir, "chunks");
      fs.mkdirSync(chunksDir, { recursive: true });

      const ext = mimeType.includes("ogg") ? "ogg" : "webm";
      const name = `chunk_${String(seq).padStart(6, "0")}.${ext}`;
      fs.writeFileSync(path.join(chunksDir, name), file.buffer);

      // Ensure status is RECORDING
      await pool.query(
        "UPDATE secure_ai_sessions SET status='RECORDING', started_at = COALESCE(started_at, NOW()), updated_at=NOW() WHERE id=$1 AND status IN ('CONSENT_PENDING','RECORDING')",
        [sessionId]
      );

      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  // Upload decrypted chat transcript (owner-only)
  router.post("/session/:id/chat-transcript", express.json({ limit: "5mb" }), async (req, res) => {
    try {
      const sessionId = String(req.params.id || "");
      if (!isUuid(sessionId)) return res.status(400).json({ error: "Bad session id" });

      const s = await pool.query("SELECT * FROM secure_ai_sessions WHERE id = $1", [sessionId]);
      const sess = s.rows[0];
      if (!sess) return res.status(404).json({ error: "Session not found" });

      const user = getUserFromRequest ? getUserFromRequest(req) : null;
      const actor = actorFromUser(user);
      if (!actor) return res.status(401).json({ error: "Auth required" });
      if (actor.actorKey !== sess.created_by) return res.status(403).json({ error: "Owner only" });

      const dir = sessionDir(sessionId);
      fs.mkdirSync(dir, { recursive: true });

      fs.writeFileSync(path.join(dir, "chat_transcript.json"), JSON.stringify(req.body || {}, null, 2));
      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  // Finalize and enqueue job (owner-only)
  router.post("/session/:id/finalize", async (req, res) => {
    try {
      const sessionId = String(req.params.id || "");
      if (!isUuid(sessionId)) return res.status(400).json({ error: "Bad session id" });

      const s = await pool.query("SELECT * FROM secure_ai_sessions WHERE id = $1", [sessionId]);
      const sess = s.rows[0];
      if (!sess) return res.status(404).json({ error: "Session not found" });

      const user = getUserFromRequest ? getUserFromRequest(req) : null;
      const actor = actorFromUser(user);
      if (!actor) return res.status(401).json({ error: "Auth required" });
      if (actor.actorKey !== sess.created_by) return res.status(403).json({ error: "Owner only" });

      // If someone declined, don't proceed
      const c = await computeConsent(pool, sessionId);
      if (c.anyDeclined) return res.status(409).json({ error: "A participant declined consent." });

      // Close session
      await pool.query(
        "UPDATE secure_ai_sessions SET status='FINALIZING', ended_at=COALESCE(ended_at, NOW()), updated_at=NOW() WHERE id=$1 AND status <> 'FAILED'",
        [sessionId]
      );

      const jobId = crypto.randomUUID();
      await pool.query(
        "INSERT INTO secure_ai_jobs (id, session_id, status, progress) VALUES ($1, $2, 'QUEUED', 'Queued')",
        [jobId, sessionId]
      );

      res.json({ jobId });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  // Job status (participants)
  router.get("/job/:id", async (req, res) => {
    try {
      const jobId = String(req.params.id || "");
      if (!isUuid(jobId)) return res.status(400).json({ error: "Bad job id" });

      const r = await pool.query(
        "SELECT j.*, s.session_type, s.context_id, s.title, s.status AS session_status FROM secure_ai_jobs j JOIN secure_ai_sessions s ON s.id = j.session_id WHERE j.id = $1",
        [jobId]
      );
      const row = r.rows[0];
      if (!row) return res.status(404).json({ error: "Job not found" });

      const sessionType = row.session_type;
      const contextId = row.context_id;

      // Actor
      const user = getUserFromRequest ? getUserFromRequest(req) : null;
      let actor = actorFromUser(user);
      if (!actor) {
        const cookies = parseCookies(req) || {};
        const tokenName = sessionType === "video" ? "pdfrealm_video_guest" : sessionType === "voip" ? "pdfrealm_voice_guest" : "pdfrealm_chat_guest";
        actor = actorFromGuestToken(sessionType, cookies[tokenName] || "");
      }
      const member = await checkMembership(pool, sessionType, contextId, actor);
      if (!member) return res.status(403).json({ error: "Not allowed" });

      res.json({
        jobId: row.id,
        sessionId: row.session_id,
        status: row.status,
        progress: row.progress,
        error: row.error,
        sessionStatus: row.session_status,
        title: row.title
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  // Download report (participants)
  router.get("/session/:id/report", async (req, res) => {
    try {
      const sessionId = String(req.params.id || "");
      if (!isUuid(sessionId)) return res.status(400).send("Bad session id");

      const s = await pool.query("SELECT * FROM secure_ai_sessions WHERE id = $1", [sessionId]);
      const sess = s.rows[0];
      if (!sess) return res.status(404).send("Session not found");

      const sessionType = sess.session_type;
      const contextId = sess.context_id;

      // Actor
      const user = getUserFromRequest ? getUserFromRequest(req) : null;
      let actor = actorFromUser(user);
      if (!actor) {
        const cookies = parseCookies(req) || {};
        const tokenName = sessionType === "video" ? "pdfrealm_video_guest" : sessionType === "voip" ? "pdfrealm_voice_guest" : "pdfrealm_chat_guest";
        actor = actorFromGuestToken(sessionType, cookies[tokenName] || "");
      }
      const member = await checkMembership(pool, sessionType, contextId, actor);
      if (!member) return res.status(403).send("Not allowed");

      const r = await pool.query("SELECT storage_key FROM secure_ai_reports WHERE session_id = $1", [sessionId]);
      const row = r.rows[0];
      if (!row) return res.status(404).send("Report not ready");

      const downloadName = `secure_ai_report_${sessionId}.pdf`;
      await streamVaultObjectToResponse({ storageKey: row.storage_key, res, mimeType: "application/pdf", downloadName });
    } catch (e) {
      console.error(e);
      res.status(500).send(e.message || String(e));
    }
  });

  // Delete session artifacts (owner-only)
  router.delete("/session/:id", async (req, res) => {
    try {
      const sessionId = String(req.params.id || "");
      if (!isUuid(sessionId)) return res.status(400).json({ error: "Bad session id" });

      const s = await pool.query("SELECT * FROM secure_ai_sessions WHERE id = $1", [sessionId]);
      const sess = s.rows[0];
      if (!sess) return res.status(404).json({ error: "Session not found" });

      const user = getUserFromRequest ? getUserFromRequest(req) : null;
      const actor = actorFromUser(user);
      if (!actor) return res.status(401).json({ error: "Auth required" });
      if (actor.actorKey !== sess.created_by) return res.status(403).json({ error: "Owner only" });

      await deleteSessionArtifacts(pool, sessionId);
      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  app.use("/api/secure-ai", router);
}

module.exports = { mountSecureAi };
