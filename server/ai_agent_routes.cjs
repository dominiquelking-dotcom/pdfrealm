"use strict";

/**
 * PDFRealm AI Operator routes — v2 (20-tool engine)
 * Mount point expected in server.js:
 *   const mountAiAgent = require("./server/ai_agent_routes.cjs");
 *   mountAiAgent({ app });
 *
 * Endpoints:
 *   POST /api/ai/upload
 *   POST /api/ai/plan
 *   POST /api/ai/run
 *   GET  /api/ai/job/:id
 *   GET  /api/ai/job/:id/download
 *   GET  /api/ai/job/:id/text
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

// In-memory stores (dev-safe)
const UPLOADS = new Map(); // uploadId -> { buffer, name, size, mime, createdAt }
const JOBS    = new Map(); // jobId    -> { status, resultBuffer, resultText, resultMime, stepLog, createdAt, plan, error }

function pruneMaps() {
  const maxUploads = 30;
  const maxJobs    = 50;
  if (UPLOADS.size > maxUploads) {
    const arr = Array.from(UPLOADS.entries()).sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (let i = 0; i < arr.length - maxUploads; i++) UPLOADS.delete(arr[i][0]);
  }
  if (JOBS.size > maxJobs) {
    const arr = Array.from(JOBS.entries()).sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (let i = 0; i < arr.length - maxJobs; i++) JOBS.delete(arr[i][0]);
  }
}

// ─── Tool Registry ────────────────────────────────────────────────────────────
const TOOL_REGISTRY = {
  rotate: {
    endpoint: "/api/rotate",
    desc: "Rotate PDF pages. Use degrees 90, 180, or 270.",
    args: { degrees: "number (90|180|270)", pages: "string (optional, e.g. '1-3,5')", password: "string (optional)" },
  },
  encrypt: {
    endpoint: "/api/encrypt",
    desc: "Add password protection to PDF.",
    args: { password: "string (required)", inputPassword: "string (optional, if already encrypted)" },
  },
  decrypt: {
    endpoint: "/api/decrypt",
    desc: "Remove password from PDF.",
    args: { password: "string (required, the current password)" },
  },
  compress: {
    endpoint: "/api/compress",
    desc: "Reduce PDF file size.",
    args: {},
  },
  watermark: {
    endpoint: "/api/watermark",
    desc: "Add a diagonal text watermark to all pages.",
    args: { text: "string (default: CONFIDENTIAL)" },
  },
  stamp: {
    endpoint: "/api/stamp",
    desc: "Add a text stamp to the bottom of all pages.",
    args: { text: "string (default: APPROVED)" },
  },
  flatten: {
    endpoint: "/api/flatten",
    desc: "Flatten form fields so they cannot be edited.",
    args: {},
  },
  merge: {
    endpoint: "/api/merge",
    desc: "Merge multiple PDFs into one. Only works with multiple uploaded files.",
    args: {},
  },
  split: {
    endpoint: "/api/split",
    desc: "Extract specific pages from PDF.",
    args: { ranges: "string (required, e.g. '1-3,5,7-9')" },
  },
  reorder: {
    endpoint: "/api/reorder",
    desc: "Reorder pages in a PDF.",
    args: { order: "string (required, comma-separated page numbers e.g. '3,1,2,4')" },
  },
  delete_page: {
    endpoint: "/api/delete-page",
    desc: "Delete a specific page from PDF.",
    args: { page: "number (required, 1-indexed)" },
  },
  page_numbers: {
    endpoint: "/api/page-numbers",
    desc: "Add page numbers to PDF.",
    args: { start: "number (default 1)", prefix: "string (optional, e.g. 'Page ')", pos: "string (tl|tc|tr|bl|bc|br, default br)" },
  },
  remove_metadata: {
    endpoint: "/api/meta/remove",
    desc: "Strip all metadata from PDF (author, title, creation date etc).",
    args: {},
  },
  repair: {
    endpoint: "/api/repair",
    desc: "Attempt to repair a corrupted or malformed PDF.",
    args: {},
  },
  ocr: {
    endpoint: "/api/ocr",
    desc: "Extract text from PDF or image using OCR. Returns text, not a PDF.",
    args: { lang: "string (default 'eng')" },
    returnsText: true,
  },
  pdf_to_word: {
    endpoint: "/api/pdf-to-word",
    desc: "Convert PDF to Word (.docx) document.",
    args: {},
    returnsMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  html_to_pdf: {
    endpoint: "/api/html-to-pdf",
    desc: "Convert HTML content to PDF.",
    args: { html: "string (required, HTML content)" },
    noFile: true,
  },
  url_to_pdf: {
    endpoint: "/api/url-to-pdf",
    desc: "Convert a web page URL to PDF.",
    args: { url: "string (required, full URL)" },
    noFile: true,
  },
  redact: {
    endpoint: "/api/redact",
    desc: "Redact rectangular areas on PDF pages with black boxes.",
    args: { boxes: "string (required, one per line: 'page,x,y,w,h' in PDF points)" },
  },
  remove_blank_pages: {
    endpoint: "/api/remove-blank-pages",
    desc: "Remove blank or near-blank pages from PDF.",
    args: {},
  },
};

// ─── OpenAI Planner ───────────────────────────────────────────────────────────
async function openAiPlan(prompt, fileInfo) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const toolDescriptions = Object.entries(TOOL_REGISTRY)
    .map(([name, t]) => `- ${name}: ${t.desc} Args: ${JSON.stringify(t.args)}`)
    .join("\n");

  const fileContext = fileInfo
    ? `\nThe user has uploaded: "${fileInfo.name}" (${Math.round(fileInfo.size / 1024)}KB, ${fileInfo.mime})`
    : "\nNo file uploaded yet.";

  const sys = `You are the PDFRealm AI Operator. You create step-by-step plans to process PDF documents.

AVAILABLE TOOLS:
${toolDescriptions}

RULES:
1. Return ONLY valid JSON: { "steps": [...], "summary": "...", "warnings": [...] }
2. Each step: { "tool": "tool_name", "args": { ... }, "description": "what this step does" }
3. "summary": a friendly 1-2 sentence explanation of what the plan will do
4. "warnings": array of strings for anything the user should know (empty array if none)
5. If the request mentions PII, SSN, names, emails — use the redact tool with appropriate boxes, OR note in warnings that manual box selection is needed
6. For watermark, default text is "CONFIDENTIAL" unless user specifies
7. For stamp, default text is "APPROVED" unless user specifies
8. Multiple steps are allowed and encouraged for complex requests
9. If a step requires info you don't have (e.g. specific page numbers to delete), make your best guess and add a warning
10. ocr and pdf_to_word return non-PDF output — they should be the LAST step if used
${fileContext}`;

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

  if (!r.ok) throw new Error(`OpenAI plan failed (${r.status})`);

  const j = await r.json();
  const content = j?.choices?.[0]?.message?.content || "{}";
  let plan;
  try { plan = JSON.parse(content); } catch { plan = null; }
  if (!plan || !Array.isArray(plan.steps)) throw new Error("Invalid plan JSON from OpenAI");
  return plan;
}

// ─── Fallback Planner ─────────────────────────────────────────────────────────
function basicPlanFallback(prompt) {
  const p = String(prompt || "").toLowerCase();
  const steps = [];

  if (p.includes("compress") || p.includes("reduce size") || p.includes("smaller"))
    steps.push({ tool: "compress", args: {}, description: "Compress PDF to reduce file size" });

  if (p.includes("flatten") || p.includes("non-editable") || p.includes("lock form"))
    steps.push({ tool: "flatten", args: {}, description: "Flatten form fields" });

  if (p.includes("watermark")) {
    const match = p.match(/watermark[^"']*["']([^"']+)["']/i) || p.match(/watermark.*?with\s+["']?([a-z\s]+)["']?/i);
    steps.push({ tool: "watermark", args: { text: match?.[1]?.trim() || "CONFIDENTIAL" }, description: "Add watermark" });
  }

  if (p.includes("stamp") || p.includes("approved") || p.includes("paid")) {
    const match = p.match(/stamp[^"']*["']([^"']+)["']/i);
    steps.push({ tool: "stamp", args: { text: match?.[1]?.trim() || "APPROVED" }, description: "Add stamp" });
  }

  if (p.includes("page number"))
    steps.push({ tool: "page_numbers", args: {}, description: "Add page numbers" });

  if (p.includes("remove metadata") || p.includes("strip metadata"))
    steps.push({ tool: "remove_metadata", args: {}, description: "Remove metadata" });

  if (p.includes("repair") || p.includes("fix"))
    steps.push({ tool: "repair", args: {}, description: "Repair PDF" });

  if (p.includes("rotate")) {
    const deg = p.match(/rotate\s+(\d{1,3})/i);
    steps.push({ tool: "rotate", args: { degrees: deg ? parseInt(deg[1], 10) : 90 }, description: "Rotate pages" });
  }

  if (p.includes("ocr") || p.includes("extract text"))
    steps.push({ tool: "ocr", args: {}, description: "Extract text via OCR" });

  if (p.includes("word") || p.includes("docx"))
    steps.push({ tool: "pdf_to_word", args: {}, description: "Convert to Word document" });

  if (p.includes("remove blank") || p.includes("blank page"))
    steps.push({ tool: "remove_blank_pages", args: {}, description: "Remove blank pages" });

  return {
    steps,
    summary: `Executing ${steps.length} operation(s) on your document.`,
    warnings: [],
  };
}

// ─── callTool ─────────────────────────────────────────────────────────────────
async function callTool(req, inputPdfBuffer, toolName, args) {
  const toolDef = TOOL_REGISTRY[toolName];
  if (!toolDef) throw new Error(`Unknown tool: ${toolName}`);

  const base = `${req.protocol}://${req.get("host")}`;
  const url  = base + toolDef.endpoint;

  let resp;

  if (toolDef.noFile) {
    // JSON body (html_to_pdf, url_to_pdf)
    resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
  } else {
    const fd = new FormData();
    if (inputPdfBuffer) {
      fd.append("file", new Blob([inputPdfBuffer], { type: "application/pdf" }), "input.pdf");
    }
    for (const [k, v] of Object.entries(args || {})) {
      if (v !== undefined && v !== null) fd.append(k, String(v));
    }
    resp = await fetch(url, { method: "POST", body: fd });
  }

  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try { const j = await resp.json(); msg = j?.error || j?.message || msg; } catch { /* ignore */ }
    throw new Error(`Tool "${toolName}" failed: ${msg}`);
  }

  if (toolDef.returnsText) {
    const j = await resp.json();
    return { text: j?.text || "", isText: true };
  }

  const ab = await resp.arrayBuffer();
  return { buffer: Buffer.from(ab), mime: toolDef.returnsMime || "application/pdf" };
}

// ─── Mount ────────────────────────────────────────────────────────────────────
module.exports = function mountAiAgent({ app }) {
  const router = express.Router();
  router.use(express.json({ limit: "2mb" }));

  // Health
  router.get("/health", (req, res) => res.json({ ok: true, tools: Object.keys(TOOL_REGISTRY).length }));

  // Tool list (useful for frontend)
  router.get("/tools", (req, res) => {
    const list = Object.entries(TOOL_REGISTRY).map(([name, t]) => ({
      name,
      desc: t.desc,
      args: t.args,
      returnsText: !!t.returnsText,
      noFile: !!t.noFile,
    }));
    res.json({ tools: list });
  });

  // Upload
  router.post("/upload", upload.any(), (req, res) => {
    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) {
      return res.status(400).json({ error: "No files uploaded." });
    }

    const uploads = [];
    for (const f of files) {
      const uploadId = id();
      UPLOADS.set(uploadId, {
        buffer:    f.buffer,
        name:      f.originalname || "upload.pdf",
        size:      f.size || (f.buffer ? f.buffer.length : 0),
        mime:      f.mimetype || "application/octet-stream",
        createdAt: Date.now(),
      });
      uploads.push({
        id:   uploadId,
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
      const prompt = req.body?.prompt ?? req.body?.instruction ?? req.body?.text ?? "";
      if (!String(prompt || "").trim()) return res.status(400).json({ error: "Missing prompt" });

      const uploadId = req.body?.uploadId || req.body?.fileId;
      const fileInfo = uploadId && UPLOADS.has(uploadId)
        ? {
            name: UPLOADS.get(uploadId).name,
            size: UPLOADS.get(uploadId).size,
            mime: UPLOADS.get(uploadId).mime,
          }
        : null;

      let plan = null;
      try { plan = await openAiPlan(prompt, fileInfo); } catch (_) { plan = null; }
      if (!plan) plan = basicPlanFallback(prompt);
      if (!plan || !Array.isArray(plan.steps)) plan = { steps: [], summary: "No steps planned.", warnings: [] };

      res.json({ plan, summary: plan.summary, warnings: plan.warnings || [] });
    } catch (e) {
      res.status(500).json({ error: "Plan failed.", details: String(e?.message || e) });
    }
  });

  // Run
  router.post("/run", async (req, res) => {
    try {
      const uploadId = req.body?.uploadId || req.body?.fileId || req.body?.id;
      const planRaw  = req.body?.plan;
      const plan     = typeof planRaw === "string" ? JSON.parse(planRaw) : planRaw;

      if (!plan || !Array.isArray(plan.steps)) {
        return res.status(400).json({ error: "Missing plan.steps" });
      }

      let buf = null;
      if (uploadId && UPLOADS.has(uploadId)) {
        buf = UPLOADS.get(uploadId).buffer;
      }

      const jobId    = id();
      const stepLog  = [];
      let finalText  = null;
      let finalMime  = "application/pdf";

      JOBS.set(jobId, {
        status:       "RUNNING",
        createdAt:    Date.now(),
        plan,
        error:        null,
        resultBuffer: null,
        resultText:   null,
      });
      pruneMaps();

      for (const step of plan.steps) {
        const toolName = String(step?.tool || "").toLowerCase().replace(/-/g, "_").trim();
        const args     = step?.args || {};
        const desc     = step?.description || toolName;

        if (!TOOL_REGISTRY[toolName]) {
          stepLog.push({ tool: toolName, status: "skipped", reason: `Unknown tool: ${toolName}` });
          continue;
        }

        try {
          const result = await callTool(req, buf, toolName, args);
          if (result.isText) {
            finalText = result.text;
            stepLog.push({ tool: toolName, status: "ok", desc, output: "text" });
          } else {
            buf       = result.buffer;
            finalMime = result.mime;
            stepLog.push({ tool: toolName, status: "ok", desc, outputBytes: buf.length });
          }
        } catch (e) {
          stepLog.push({ tool: toolName, status: "error", desc, error: e.message });
          // Don't abort — continue with remaining steps using last good buffer
        }
      }

      const job = JOBS.get(jobId);
      if (job) {
        job.status       = "DONE";
        job.resultBuffer = buf;
        job.resultText   = finalText;
        job.resultMime   = finalMime;
        job.stepLog      = stepLog;
      }

      const successCount = stepLog.filter(s => s.status === "ok").length;
      const errorCount   = stepLog.filter(s => s.status === "error").length;

      const autoSummary = plan.summary ||
        `Completed ${successCount} of ${plan.steps.length} steps.${errorCount > 0 ? ` ${errorCount} step(s) had errors.` : ""}`;

      res.json({
        jobId,
        status:      "DONE",
        summary:     autoSummary,
        warnings:    plan.warnings || [],
        stepLog,
        downloadUrl: buf       ? `/api/ai/job/${jobId}/download` : null,
        hasText:     !!finalText,
        textPreview: finalText ? finalText.slice(0, 500) : null,
        textUrl:     finalText ? `/api/ai/job/${jobId}/text`     : null,
      });
    } catch (e) {
      res.status(500).json({ error: "Run failed.", details: String(e?.message || e) });
    }
  });

  // Job status
  router.get("/job/:id", (req, res) => {
    const job = JOBS.get(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json({
      id:          req.params.id,
      status:      job.status,
      createdAt:   job.createdAt,
      error:       job.error,
      hasResult:   !!job.resultBuffer || !!job.resultText,
      downloadUrl: job.resultBuffer ? `/api/ai/job/${req.params.id}/download` : null,
      textUrl:     job.resultText   ? `/api/ai/job/${req.params.id}/text`     : null,
      stepLog:     job.stepLog || [],
    });
  });

  // Download
  router.get("/job/:id/download", (req, res) => {
    const job = JOBS.get(req.params.id);
    if (!job || !job.resultBuffer) return res.status(404).send("Not found");

    const mime = job.resultMime || "application/pdf";
    const ext  = mime.includes("wordprocessingml") ? "docx" : "pdf";

    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Disposition", `attachment; filename="pdfrealm_ai_result_${req.params.id}.${ext}"`);
    res.send(job.resultBuffer);
  });

  // Text result (OCR etc.)
  router.get("/job/:id/text", (req, res) => {
    const job = JOBS.get(req.params.id);
    if (!job || !job.resultText) return res.status(404).send("Not found");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(job.resultText);
  });

  app.use("/api/ai", router);
  console.log(`AI Agent mounted: /api/ai/* (${Object.keys(TOOL_REGISTRY).length} tools)`);
};
