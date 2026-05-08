const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const router = express.Router();
router.use(express.json({ limit: "250mb" }));

const JOBS = new Map();     // id -> metadata
const QUEUE = [];           // job ids
let RUNNING = 0;

const MAX_JOBS = parseInt(process.env.JOB_MAX || "200", 10) || 200;
const CONCURRENCY = parseInt(process.env.JOB_CONCURRENCY || "1", 10) || 1;
const RETENTION_MIN = parseInt(process.env.JOB_RETENTION_MIN || "60", 10) || 60;

const PORT = process.env.PORT || "9000";
const SELF = process.env.JOB_SELF_URL || `http://127.0.0.1:${PORT}`;

const STORE_DIR = process.env.JOB_STORE_DIR || "/tmp/pdfrealm-jobs";
const STORE_TMP = path.join(STORE_DIR, "tmp");

const KIND_MAP = {
  apply:                  { url: "/api/pdf/apply",                 expect: "pdf",  contentType: "application/pdf", ext: ".pdf", filename: "applied.pdf" },
  optimize:               { url: "/api/pdf/optimize",              expect: "pdf",  contentType: "application/pdf", ext: ".pdf", filename: "optimized.pdf" },
  secure_raster:          { url: "/api/pdf/secure-raster",         expect: "pdf",  contentType: "application/pdf", ext: ".pdf", filename: "secure-raster.pdf" },
  secure_raster_selective:{ url: "/api/pdf/secure-raster-selective",expect:"pdf", contentType: "application/pdf", ext: ".pdf", filename: "secure-raster-selective.pdf" },
  extract_zip:            { url: "/api/pdf/extract-zip",           expect: "zip",  contentType: "application/zip", ext: ".zip", filename: "extract.zip" },
  redact_package:         { url: "/api/pdf/redact-package",        expect: "zip",  contentType: "application/zip", ext: ".zip", filename: "redaction-package.zip" },
  true_redact:            { url: "/api/pdf/true-redact",           expect: "pdf",  contentType: "application/pdf", ext: ".pdf", filename: "true-redacted.pdf" },
  true_redact_package:    { url: "/api/pdf/true-redact-package",   expect: "zip",  contentType: "application/zip", ext: ".zip", filename: "true-redaction-package.zip" },
  verify_v2:              { url: "/api/pdf/verify-v2",             expect: "json", contentType: "application/json", ext: ".json", filename: "verify-v2.json" },
};

function now() { return Date.now(); }
function genId() { try { return crypto.randomUUID(); } catch { return (Math.random().toString(16).slice(2) + now().toString(16)); } }

async function ensureDirs() {
  await fsp.mkdir(STORE_DIR, { recursive: true });
  await fsp.mkdir(STORE_TMP, { recursive: true });
}

function trimJobs() {
  if (JOBS.size <= MAX_JOBS) return;
  const arr = Array.from(JOBS.values()).sort((a,b) => (a.createdAt||0) - (b.createdAt||0));
  while (arr.length > MAX_JOBS) {
    const j = arr.shift();
    if (j) JOBS.delete(j.id);
  }
}

async function cleanupOld() {
  const cutoff = now() - RETENTION_MIN * 60 * 1000;
  for (const j of JOBS.values()) {
    if (!j.finishedAt) continue;
    if (j.finishedAt > cutoff) continue;
    if (j.filePath) {
      try { await fsp.rm(j.filePath, { force: true }); } catch {}
    }
    JOBS.delete(j.id);
  }
}

async function writeAtomic(finalPath, buf) {
  const tmp = path.join(STORE_TMP, `${path.basename(finalPath)}.${genId()}.tmp`);
  await fsp.writeFile(tmp, buf);
  await fsp.rename(tmp, finalPath);
}

async function runOne(job) {
  const conf = KIND_MAP[job.kind];
  if (!conf) throw new Error(`unknown kind: ${job.kind}`);

  job.status = "running";
  job.startedAt = now();

  // drop payload ref ASAP to reduce memory retention in JOBS map
  const payload = job.payload || {};
  job.payload = null;

  const resp = await fetch(SELF + conf.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`downstream failed: ${resp.status} ${t}`);
  }

  await ensureDirs();

  const filename = job.filename || conf.filename;
  const filePath = path.join(STORE_DIR, `${job.id}${conf.ext}`);

  if (conf.expect === "json") {
    const data = await resp.json();
    const buf = Buffer.from(JSON.stringify(data, null, 2));
    await writeAtomic(filePath, buf);
    job.status = "done";
    job.finishedAt = now();
    job.resultType = "json";
    job.filePath = filePath;
    job.bytes = buf.length;
    job.contentType = "application/json";
    job.filename = filename;
  } else {
    const ab = await resp.arrayBuffer();
    const buf = Buffer.from(new Uint8Array(ab));
    await writeAtomic(filePath, buf);
    job.status = "done";
    job.finishedAt = now();
    job.resultType = "binary";
    job.filePath = filePath;
    job.bytes = buf.length;
    job.contentType = conf.contentType;
    job.filename = filename;
  }

  trimJobs();
  await cleanupOld();
}

function pump() {
  while (RUNNING < CONCURRENCY && QUEUE.length) {
    const id = QUEUE.shift();
    const job = JOBS.get(id);
    if (!job) continue;

    RUNNING++;
    runOne(job)
      .catch((e) => {
        job.status = "error";
        job.finishedAt = now();
        job.error = String(e && e.message ? e.message : e);
      })
      .finally(() => {
        RUNNING--;
        pump();
      });
  }
}

// submit
router.post("/submit", async (req, res) => {
  try {
    const body = req.body || {};
    const kind = String(body.kind || "").trim();
    if (!KIND_MAP[kind]) return res.status(400).json({ error: "unknown kind", kinds: Object.keys(KIND_MAP) });

    const id = genId();
    const job = {
      id,
      kind,
      status: "queued",
      createdAt: now(),
      startedAt: null,
      finishedAt: null,
      error: null,
      payload: body.payload || {},
      filename: body.filename || null,
      filePath: null,
      bytes: null,
      contentType: null,
      resultType: null,
    };

    JOBS.set(id, job);
    trimJobs();

    QUEUE.push(id);
    pump();

    res.status(200).json({ ok: true, id, statusUrl: `/api/jobs/${id}`, downloadUrl: `/api/jobs/${id}/download` });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});

// status
router.get("/:id", (req, res) => {
  const id = String(req.params.id || "");
  const j = JOBS.get(id);
  if (!j) return res.status(404).json({ error: "not found" });

  res.status(200).json({
    ok: true,
    id: j.id,
    kind: j.kind,
    status: j.status,
    createdAt: j.createdAt,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    error: j.error,
    resultType: j.resultType,
    bytes: j.bytes,
    contentType: j.contentType,
    filename: j.filename,
    downloadUrl: `/api/jobs/${j.id}/download`,
  });
});

// download
router.get("/:id/download", async (req, res) => {
  const id = String(req.params.id || "");
  const j = JOBS.get(id);
  if (!j) return res.status(404).json({ error: "not found" });
  if (j.status !== "done") return res.status(409).json({ error: "not ready", status: j.status });
  if (!j.filePath) return res.status(500).json({ error: "missing filePath" });

  try {
    const st = await fsp.stat(j.filePath);
    res.setHeader("Content-Length", String(st.size));
  } catch {}

  res.setHeader("Content-Type", j.contentType || "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${j.filename || "result.bin"}"`);

  const rs = fs.createReadStream(j.filePath);
  rs.on("error", (e) => res.status(500).end(String(e && e.message ? e.message : e)));
  rs.pipe(res);
});

module.exports = router;
