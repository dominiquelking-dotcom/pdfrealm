"use strict";

/**
 * PDFRealm AI Operator routes (ADD-ON, non-breaking)
 * Mount point expected in server.js:
 *   const mountAiAgent = require("./server/ai_agent_routes.cjs");
 *   mountAiAgent({ app });
 *
 * Endpoints:
 *   POST /api/ai/upload     (multipart, field: file OR files)
 *   POST /api/ai/plan       (json or multipart; key: prompt)
 *   POST /api/ai/run        (json: {uploadId, plan})
 *   GET  /api/ai/job/:id    (status)
 *   GET  /api/ai/job/:id/download (forces browser download)
 */

const express = require("express");
const multer = require("multer");
const crypto = require("crypto");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 80 * 1024 * 1024 }, // 80MB
});

function id() {
  return crypto.randomBytes(16).toString("hex");
}

// In-memory stores (dev-safe). You can replace later with DB/Artifacts.
const UPLOADS = new Map(); // uploadId -> { buffer, name, size, mime, createdAt }
const JOBS = new Map();    // jobId -> { status, resultBuffer, createdAt, plan, error }

function pruneMaps() {
  // keep memory bounded (very simple LRU-ish by createdAt)
  const maxUploads = 30;
  const maxJobs = 50;

  if (UPLOADS.size > maxUploads) {
    const arr = Array.from(UPLOADS.entries()).sort((a,b) => a[1].createdAt - b[1].createdAt);
    for (let i = 0; i < arr.length - maxUploads; i++) UPLOADS.delete(arr[i][0]);
  }
  if (JOBS.size > maxJobs) {
    const arr = Array.from(JOBS.entries()).sort((a,b) => a[1].createdAt - b[1].createdAt);
    for (let i = 0; i < arr.length - maxJobs; i++) JOBS.delete(arr[i][0]);
  }
}

async function readJsonSafe(res) {
  try { return await res.json(); } catch { return null; }
}

async function callTool(req, inputPdfBuffer, endpointPath, fields) {
  const base = `${req.protocol}://${req.get("host")}`;

  // Node 20+: global FormData/Blob available
  const fd = new FormData();
  fd.append("file", new Blob([inputPdfBuffer], { type: "application/pdf" }), "input.pdf");

  for (const [k, v] of Object.entries(fields || {})) {
    if (v === undefined || v === null) continue;
    fd.append(k, String(v));
  }

  const resp = await fetch(base + endpointPath, {
    method: "POST",
    body: fd,
  });

  if (!resp.ok) {
    const maybe = await readJsonSafe(resp);
    const msg = maybe?.error || maybe?.details || (await resp.text().catch(() => "")) || `HTTP ${resp.status}`;
    const err = new Error(msg);
    err.status = resp.status;
    err.details = maybe || null;
    throw err;
  }

  const ab = await resp.arrayBuffer();
  return Buffer.from(ab);
}

function basicPlanFallback(prompt) {
  // Minimal deterministic fallback if OPENAI is not configured.
  const p = String(prompt || "").toLowerCase();

  const steps = [];
  const rot = p.match(/rotate\s+(-?\d{1,3})/i) || p.match(/rotate\s+.*?(\d{1,3})\s*degrees/i);
  if (rot) steps.push({ tool: "rotate", args: { degrees: parseInt(rot[1], 10) } });

  const enc = p.match(/encrypt.*?(password|pass)\s*[:=]?\s*([^\s]+)/i) || p.match(/encrypt.*?with\s+password\s+([^\s]+)/i);
  if (enc) steps.push({ tool: "encrypt", args: { password: enc[2] || enc[1] } });

  return { steps };
}

async function openAiPlan(prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const sys = [
    "You are the PDFRealm AI Operator planner.",
    "Return ONLY a JSON object with a top-level key 'steps' (array).",
    "Each step is { tool: string, args: object }.",
    "Allowed tools: rotate, encrypt.",
    "rotate args: { degrees: 90|180|270|0, pages?: '2-4,7', password?: string, outputPassword?: string }",
    "encrypt args: { password: string, inputPassword?: string }",
    "If a request is unclear, still return best-effort steps.",
  ].join("\n");

  const payload = {
    model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: sys },
      { role: "user", content: String(prompt || "") },
    ],
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`OpenAI plan failed (${r.status}): ${t.slice(0, 300)}`);
  }

  const j = await r.json();
  const content = j?.choices?.[0]?.message?.content || "{}";
  let plan;
  try { plan = JSON.parse(content); } catch { plan = null; }
  if (!plan || !Array.isArray(plan.steps)) throw new Error("OpenAI returned invalid plan JSON.");
  return plan;
}

module.exports = function mountAiAgent({ app }) {
  const router = express.Router();
  router.use(express.json({ limit: "2mb" }));

  // Health
  router.get("/health", (req, res) => res.json({ ok: true }));

  // Upload
  router.post("/upload", upload.any(), (req, res) => {
    const files = Array.isArray(req.files) ? req.files : [];
    // Accept both "file" and "files" field names; multer.any() collects all.
    if (!files.length) {
      return res.status(400).json({ error: "No files uploaded." });
    }

    const uploads = [];
    for (const f of files) {
      const uploadId = id();
      UPLOADS.set(uploadId, {
        buffer: f.buffer,
        name: f.originalname || "upload.pdf",
        size: f.size || (f.buffer ? f.buffer.length : 0),
        mime: f.mimetype || "application/octet-stream",
        createdAt: Date.now(),
      });
      uploads.push({
        id: uploadId,
        name: f.originalname || "upload.pdf",
        size: f.size || (f.buffer ? f.buffer.length : 0),
        mime: f.mimetype || "application/octet-stream",
      });
    }

    pruneMaps();
    res.json({ uploads });
  });

  // Plan
  router.post("/plan", upload.none(), async (req, res) => {
    try {
      // Works for JSON OR form fields because:
      // - router.use(express.json()) handles JSON
      // - upload.none() handles multipart form fields
      const prompt =
        req.body?.prompt ??
        req.body?.instruction ??
        req.body?.text ??
        "";

      if (!String(prompt || "").trim()) {
        return res.status(400).json({ error: "Missing prompt" });
      }

      let plan = null;
      try {
        plan = await openAiPlan(prompt);
      } catch (e) {
        // If OpenAI fails but key exists, still allow fallback for dev.
        plan = null;
      }
      if (!plan) plan = basicPlanFallback(prompt);

      // Normalize
      if (!plan || !Array.isArray(plan.steps)) plan = { steps: [] };
      res.json({ plan });
    } catch (e) {
      res.status(500).json({ error: "Plan failed.", details: String(e?.message || e) });
    }
  });

  // Run (orchestrate existing PDFRealm endpoints; NO new PDF logic)
  router.post("/run", async (req, res) => {
    try {
      const uploadId = req.body?.uploadId || req.body?.fileId || req.body?.id;
      const plan = req.body?.plan;

      if (!uploadId || !UPLOADS.has(uploadId)) {
        return res.status(400).json({ error: "Missing fileId/uploadId (upload a PDF first)." });
      }
      if (!plan || !Array.isArray(plan.steps)) {
        return res.status(400).json({ error: "Missing plan.steps" });
      }

      const u = UPLOADS.get(uploadId);
      let buf = u.buffer;

      const jobId = id();
      JOBS.set(jobId, { status: "RUNNING", createdAt: Date.now(), plan, error: null, resultBuffer: null });
      pruneMaps();

      for (const step of plan.steps) {
        const tool = String(step?.tool || "").toLowerCase().trim();
        const args = step?.args || {};

        if (tool === "rotate") {
          const degrees = args.degrees ?? args.angle ?? 90;
          const pages = args.pages ?? "";
          const password = args.password ?? args.inputPassword ?? "";
          const outputPassword = args.outputPassword ?? "";
          buf = await callTool(req, buf, "/api/rotate", { degrees, pages, password, outputPassword });
          continue;
        }

        if (tool === "encrypt") {
          const password = args.password ?? "";
          const inputPassword = args.inputPassword ?? args.currentPassword ?? "";
          if (!password) throw new Error("encrypt step missing password");
          buf = await callTool(req, buf, "/api/encrypt", { password, inputPassword });
          continue;
        }

        throw new Error(`Unknown tool in plan: ${tool}`);
      }

      const job = JOBS.get(jobId);
      if (job) {
        job.status = "DONE";
        job.resultBuffer = buf;
      }

      res.json({
        jobId,
        status: "DONE",
        downloadUrl: `/api/ai/job/${jobId}/download`,
      });
    } catch (e) {
      const msg = String(e?.message || e);
      res.status(500).json({ error: "Run failed.", details: msg });
    }
  });

  // Job status
  router.get("/job/:id", (req, res) => {
    const job = JOBS.get(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json({
      id: req.params.id,
      status: job.status,
      createdAt: job.createdAt,
      error: job.error,
      hasResult: !!job.resultBuffer,
      downloadUrl: job.resultBuffer ? `/api/ai/job/${req.params.id}/download` : null,
    });
  });

  // Download (forces browser to download)
  router.get("/job/:id/download", (req, res) => {
    const job = JOBS.get(req.params.id);
    if (!job || !job.resultBuffer) return res.status(404).send("Not found");

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="pdfrealm_ai_result_${req.params.id}.pdf"`);
    res.send(job.resultBuffer);
  });

  app.use("/api/ai", router);
  console.log("AI Agent mounted: /api/ai/*");
};
