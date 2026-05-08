/**
 * server.js — PDFRealm backend (POSTGRES-FIRST) + Vault(S3) + Broker + Tools
 *
 * Goals:
 * - Use Postgres as source of truth (no JSON broker store)
 * - JWT user.id is UUID from DB
 * - Sessions persisted in DB (optional; falls back if sessions table differs)
 * - Broker routes read/write broker_* tables
 * - Vault routes write metadata into vault_objects/vault_folders + store blob in S3
 * - Tool endpoints return PDFs and optionally log tool_runs/jobs/artifacts when present
 *
 * ENV REQUIRED:
 * - DATABASE_URL=postgres://...
 * - JWT_SECRET=...
 *
 * Vault (optional):
 * - AWS_REGION
 * - AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
 * - SECURE_VAULT_BUCKET
 *
 * Notes:
 * - If any table/column name differs from your schema, Postgres will error with a clear message.
 *   Paste the error + `psql "$DATABASE_URL" -c "\d <table>"` and I’ll patch the file precisely.
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import nodePath from "path";
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = nodePath.dirname(__filename);

// Load environment variables from .env (works in both ES module + CommonJS contexts)
try {
  const dotenv = require("dotenv");
  // Prefer project-root .env alongside this server.js
  dotenv.config({ path: nodePath.join(__dirname, ".env") });
} catch (e) {
  // dotenv is optional; continue if not installed
}


const express = require("express");
const pdfOpsRouter = require('./server/routes/pdfOps.cjs');
const jobsRouter = require('./server/routes/jobs.cjs');
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const { Pool } = require("pg");
const { spawnSync } = require("child_process");
const os = require("os");

const PDFKitDocument = require("pdfkit");
const { PDFDocument, StandardFonts, rgb, degrees } = require("pdf-lib");

// Optional OCR
let Tesseract = null;
try { Tesseract = require("tesseract.js"); } catch {}


// Optional HTML/URL renderer (Playwright)
let Playwright = null;
try { Playwright = require("playwright"); } catch {}
// ---- Secure Vault / S3 ----
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  CopyObjectCommand,
  ListObjectsV2Command,
  HeadBucketCommand,
} = require("@aws-sdk/client-s3");
const { STSClient, GetCallerIdentityCommand } = require("@aws-sdk/client-sts");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const app = express();


// >>> PDFREALM_DEV_VAULT_SHIM_BEGIN
if (String(process.env.PAYWALL_DISABLED || "").toLowerCase() === "true") {
  // Shared in-memory vault (global so it survives reloads within same process)
  globalThis.__pdfrealmDevVault = globalThis.__pdfrealmDevVault || {
    folders: new Set([""]),
    files: new Map() // id -> { id, filename, contentType, size, lastModified, folderPath, buffer }
  };
  const __dv = globalThis.__pdfrealmDevVault;

  const __dvNorm = (p) => String(p || "").replace(/\\/g,"/").replace(/^\/+/, "").replace(/\/+$/, "");
  const __dvParent = (p) => {
    const n = __dvNorm(p);
    const i = n.lastIndexOf("/");
    return i > 0 ? n.slice(0,i) : "";
  };
  const __dvMkId = () => "v_" + Date.now().toString(36) + Math.random().toString(36).slice(2,10);

  const __dvAddFolder = (fp) => {
    const f = __dvNorm(fp);
    if (!f) return;
    __dv.folders.add(f);
    let p = __dvParent(f);
    while (p) { __dv.folders.add(p); p = __dvParent(p); }
  };

  function __parseMultipart(req, limitBytes = 200 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const ct = String(req.headers["content-type"] || "");
      const mm = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
      if (!mm) return reject(Object.assign(new Error("Missing multipart boundary"), { status: 400 }));
      const boundaryStr = (mm[1] || mm[2] || "").trim();
      const boundary = Buffer.from("--" + boundaryStr);

      let size = 0;
      const chunks = [];
      req.on("data", (d) => {
        size += d.length;
        if (size > limitBytes) {
          try { req.destroy(); } catch {}
          return reject(Object.assign(new Error("Upload too large"), { status: 413 }));
        }
        chunks.push(d);
      });
      req.on("error", reject);
      req.on("end", () => {
        const body = Buffer.concat(chunks);

        let folderPath = "";
        let file = null;

        let idx = 0;
        while (true) {
          const start = body.indexOf(boundary, idx);
          if (start < 0) break;
          const next = body.indexOf(boundary, start + boundary.length);
          if (next < 0) break;

          let part = body.slice(start + boundary.length, next);
          idx = next;

          // trim leading CRLF
          if (part.length >= 2 && part.slice(0,2).toString("latin1") == "\r\n") part = part.slice(2);

          // closing boundary marker
          if (part.length >= 2 && part.slice(0,2).toString("latin1") == "--") continue;

          const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
          if (headerEnd < 0) continue;

          const header = part.slice(0, headerEnd).toString("latin1");
          let content = part.slice(headerEnd + 4);

          // trim trailing CRLF
          if (content.length >= 2 && content.slice(content.length-2).toString("latin1") == "\r\n") {
            content = content.slice(0, content.length-2);
          }

          const nameM = header.match(/name="([^"]+)"/i);
          const field = nameM ? nameM[1] : "";
          if (!field) continue;

          if (field === "folderPath" || field === "folder") {
            folderPath = content.toString("utf-8").trim();
          }

          if (field === "file") {
            const fnM = header.match(/filename="([^"]*)"/i);
            const filename = fnM ? fnM[1] : "upload.bin";
            const typeM = header.match(/content-type:\s*([^\r\n]+)/i);
            const contentType = typeM ? typeM[1].trim() : "application/octet-stream";
            file = { filename, contentType, buffer: content };
          }
        }

        resolve({ folderPath, file });
      });
    });
  }

  // Optional: stop capabilities 404 noise
  app.get("/api/capabilities", (_req, res) => res.json({ ok:true, dev:true, vault:true }));

  app.get("/api/vault/folders", (_req, res) => {
    res.json({ ok:true, folders: Array.from(__dv.folders).filter(Boolean).sort() });
  });

  app.get("/api/vault/list", (req, res) => {
    const folder = __dvNorm((req.query && req.query.folder) || "");
    const items = [];
    for (const it of __dv.files.values()) {
      if (__dvNorm(it.folderPath) === folder) {
        items.push({
          id: it.id,
          key: (folder ? folder + "/" : "") + it.filename,
          name: it.filename,
          filename: it.filename,
          size: it.size,
          contentType: it.contentType,
          lastModified: it.lastModified,
          folderPath: it.folderPath
        });
      }
    }
    res.json({ ok:true, items });
  });

  app.post("/api/vault/folder", express.json(), (req, res) => {
    const fp = __dvNorm((req.body && (req.body.folderPath || req.body.folder || req.body.path)) || "");
    if (!fp) return res.status(400).json({ ok:false, error:"folderPath required" });
    __dvAddFolder(fp);
    res.json({ ok:true });
  });

  // ✅ Upload route (NO multer; registered immediately)
  app.post("/api/vault/upload", async (req, res) => {
    try {
      const { folderPath, file } = await __parseMultipart(req);
      if (!file || !file.buffer) return res.status(400).json({ ok:false, error:"file required (multipart field: file)" });

      const fp = __dvNorm(folderPath || "");
      if (fp) __dvAddFolder(fp);

      const id = __dvMkId();
      const lastModified = new Date().toISOString();
      const size = Number(file.buffer.length || 0);

      __dv.files.set(id, {
        id,
        filename: String(file.filename || "upload.bin"),
        contentType: String(file.contentType || "application/octet-stream"),
        size,
        lastModified,
        folderPath: fp,
        buffer: file.buffer
      });

      res.json({
        ok:true,
        item: {
          id,
          key: (fp ? fp + "/" : "") + String(file.filename || "upload.bin"),
          filename: String(file.filename || "upload.bin"),
          contentType: String(file.contentType || "application/octet-stream"),
          size,
          lastModified,
          folderPath: fp
        }
      });
    } catch (e) {
      const status = (e && e.status) ? e.status : 500;
      res.status(status).json({ ok:false, error: String(e && e.message || e) });
    }
  });

  app.get("/api/vault/file-proxy/:id", (req, res) => {
    const it = __dv.files.get(String(req.params.id || ""));
    if (!it) return res.status(404).send("Not found");
    res.setHeader("Content-Type", it.contentType || "application/octet-stream");
    res.setHeader("Content-Disposition", 'inline; filename="' + String(it.filename||"file").replace(/"/g,"") + '"');
    res.send(it.buffer);
  });

  app.get("/api/vault/file/:id", (req, res) => {
    const it = __dv.files.get(String(req.params.id || ""));
    if (!it) return res.status(404).json({ ok:false, error:"Not found" });
    res.json({ ok:true, url: "/api/vault/file-proxy/" + encodeURIComponent(it.id) });
  });

  console.log("[dev-vault] enabled (PAYWALL_DISABLED=true) — upload route registered");
}
// <<< PDFREALM_DEV_VAULT_SHIM_END


// PDFREALM_DEV_AUTH_SHIM_V2
const __DEV_BYPASS_AUTH = String(process.env.PAYWALL_DISABLED || process.env.DEV_AUTH || "").toLowerCase() === "true";

function __readPdfrealmToken(req) {
  try {
    const h = (req.headers && (req.headers.authorization || req.headers.Authorization)) || "";
    if (typeof h === "string" && h.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
    const ck = (req.headers && req.headers.cookie) ? String(req.headers.cookie) : "";
    const m = /(?:^|;\s*)pdfrealm_token=([^;]+)/.exec(ck);
    if (m && m[1]) return decodeURIComponent(m[1]);
  } catch {}
  return "";
}

function __attachDevUser(req) {
  const tok = __readPdfrealmToken(req);
  if (tok || __DEV_BYPASS_AUTH) {
    req.user = req.user || { id: "dev", email: "dev@local", plan: "dev" };
    req.auth = req.auth || req.user;
    req.session = req.session || {};
    req.session.user = req.session.user || req.user;
    req._token = tok;
  }
}

app.use((req,res,next)=>{ try{ __attachDevUser(req); }catch(e){} next(); });

// Minimal auth API so the UI can log in and share a cookie across pages.
app.post("/api/login", express.json(), async (req,res)=>{
  try {
    const body = req.body || {};
    const email = String(body.email || "").toLowerCase().trim();
    const password = String(body.password || "");
    if (!email || !password) return res.status(400).json({ ok:false, error:"Email and password required." });

    // Look up user
    const JWT_SECRET_VAL = process.env.JWT_SECRET || "pdfrealm-dev-secret";
    const { Pool: _Pool } = require("pg");
    const _pool = global.__pdfrealm_login_pool || (global.__pdfrealm_login_pool = new _Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
    }));
    const result = await _pool.query("SELECT * FROM users WHERE LOWER(email)=$1 LIMIT 1", [email]);
    if (!result.rowCount) return res.status(401).json({ ok:false, error:"Invalid email or password." });
    const user = result.rows[0];

    if (!user.password_hash) return res.status(401).json({ ok:false, error:"Account has no password set. Please register or reset." });
    const _bcrypt = require("./node_modules/bcrypt");
    const valid = await _bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ ok:false, error:"Invalid email or password." });

    const payload = { id: user.id, email: user.email, plan: user.plan || "free", role: user.role || "user", subscribed: !!user.subscribed };
    const _jwt = require("jsonwebtoken");
    const token = _jwt.sign(payload, JWT_SECRET_VAL, { expiresIn: "30d" });

    res.cookie("pdfrealm_token", token, { httpOnly: false, sameSite: "Lax", path: "/" });
    return res.json({ ok:true, token, user: payload });
  } catch(e) {
    console.error("[/api/login] error:", e);
    return res.status(500).json({ ok:false, error:"Login failed: " + (e.message || "unknown") });
  }
});

app.get("/api/me", (req,res)=>{
  // Use real JWT auth - ignore shim-set req.user
  const realUser = (typeof getUserFromRequest === "function") ? getUserFromRequest(req) : null;
  if (realUser) return res.json({ ok:true, user: realUser });
  // Fall back to session user if JWT not available yet
  if (req.user && req.user.id !== "dev") return res.json({ ok:true, user: req.user });
  return res.status(401).json({ ok:false, error:"Not logged in." });
});

app.post("/api/logout", (req,res)=>{
  res.cookie("pdfrealm_token", "", { expires: new Date(0), path: "/" });
  res.json({ ok:true });
});

app.get("/api/capabilities", (req,res)=>{
  res.json({ ok:true, paywallDisabled: __DEV_BYPASS_AUTH, vault:true, docforge:true, user: req.user || null });
});

// Ensure local vendor assets are served as real JS files (prevents pdf.min.js being HTML via fallback routes).
try { app.use("/vendor", express.static("public/vendor")); } catch {}



/* PDFREALM_DEV_AUTH_SHIM_BEGIN */
// Dev-auth shim: makes /api/login + /api/me work even without a users table.
// Also forces auth for /api/vault/* so embedded tools don't "double login".

function __pdfrealmCookie(req, name){
  try {
    const raw = String((req && req.headers && req.headers.cookie) || "");
    const parts = raw.split(";").map(s=>s.trim()).filter(Boolean);
    for (const p of parts){
      const i = p.indexOf("=");
      if (i < 0) continue;
      const k = p.slice(0,i);
      if (k === name) return decodeURIComponent(p.slice(i+1));
    }
  } catch (e) {}
  return "";
}

function __pdfrealmSetCookie(res, name, value){
  const v = encodeURIComponent(String(value||""));
  const c = `${name}=${v}; Path=/; SameSite=Lax`;
  const prev = res.getHeader("Set-Cookie");
  if (!prev) res.setHeader("Set-Cookie", c);
  else if (Array.isArray(prev)) res.setHeader("Set-Cookie", prev.concat([c]));
  else res.setHeader("Set-Cookie", [prev, c]);
}

function __pdfrealmUser(email){
  const e = String(email||"dev@local");
  return { id:"dev", email:e, name:(e.split("@")[0]||"dev"), roles:["dev"] };
}

function __pdfrealmAttach(req,res,next){
  const auth = String((req && req.headers && req.headers.authorization) || "");
  let token = "";
  if (auth.toLowerCase().startsWith("bearer ")) token = auth.slice(7).trim();
  if (!token) token = __pdfrealmCookie(req,"pdfrealm_token") || "devtoken";
  const email = __pdfrealmCookie(req,"pdfrealm_email") || "dev@local";

  req.user = __pdfrealmUser(email);
  req.auth = req.user;
  req.session = req.session || {};
  req.session.user = req.session.user || req.user;
  if (res && res.locals) res.locals.user = req.user;

  __pdfrealmSetCookie(res,"pdfrealm_token",token);
  __pdfrealmSetCookie(res,"pdfrealm_email",email);

  // Mirror to Authorization for any middleware that ONLY checks Bearer
  req.headers = req.headers || {};
  if (!req.headers.authorization) req.headers.authorization = "Bearer " + token;

  next();
}

try {
  // Make sure /vendor doesn't fall through to HTML catch-all
  if (typeof app !== "undefined" && app && typeof app.use === "function") {
    app.use("/vendor", express.static("public/vendor"));

    // Force auth on Vault APIs so embedded tools share the same session
    // DISABLED: app.use("/api/vault", __pdfrealmAttach); // dev-shim disabled

    // Dev login endpoints
    /* DISABLED dev shim login
    app.post("/api/login", (req,res)=>{
      const body = (req && req.body) ? req.body : {};
      const email = body.email || body.username || "dev@local";
      const token = "devtoken";
      __pdfrealmSetCookie(res,"pdfrealm_email",email);
      __pdfrealmSetCookie(res,"pdfrealm_token",token);
      res.json({ ok:true, token, user: __pdfrealmUser(email) });
    });
    END DISABLED */

    app.post("/api/logout", (req,res)=>{
      __pdfrealmSetCookie(res,"pdfrealm_token","");
      __pdfrealmSetCookie(res,"pdfrealm_email","");
      res.json({ ok:true });
    });

    app.get("/api/me", __pdfrealmAttach, (req,res)=> res.json({ ok:true, user:req.user }));

    app.get("/api/capabilities", __pdfrealmAttach, (req,res)=> res.json({
      ok:true,
      auth:{ mode:"dev", cookie:true, bearer:true },
      vault:{ enabled:true },
      office:{ enabled:true },
      pdfstudio:{ enabled:true }
    }));
  }
} catch (e) {
}
/* PDFREALM_DEV_AUTH_SHIM_END */


// >>> PDFREALM_DEV_AUTH_BEGIN
// Dev auth + compatibility endpoints for Vault/Office/PDFStudio.
// Enabled when PAYWALL_DISABLED=true or DEV_AUTH=true.
const __DEV_AUTH_ON__ = String(process.env.DEV_AUTH || process.env.PAYWALL_DISABLED || "")
  .toLowerCase() === "true";

// simple cookie parser (no dependency on cookie-parser)
function __parseCookies__(req){
  const out = {};
  const raw = (req && req.headers && req.headers.cookie) ? String(req.headers.cookie) : "";
  raw.split(";").forEach(part => {
    const i = part.indexOf("=");
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i+1).trim();
    if (!k) return;
    out[k] = decodeURIComponent(v);
  });
  return out;
}
function __bearer__(req){
  const h = req && req.headers ? (req.headers.authorization || req.headers.Authorization) : "";
  const s = h ? String(h) : "";
  const m = s.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}
function __tokenFromReq__(req){
  const b = __bearer__(req);
  if (b) return b;
  const c = __parseCookies__(req);
  return c.pdfrealm_token || "";
}

// in-memory sessions (dev only)
const __SESS__ = globalThis.__pdfrealm_sessions || (globalThis.__pdfrealm_sessions = new Map());
function __userFor__(token, email){
  const key = String(token || "");
  if (!key) return null;
  if (!__SESS__.has(key)){
    __SESS__.set(key, {
      id: "dev",
      email: String(email || "dev@local"),
      plan: "dev",
      roles: ["dev"],
    });
  }
  return __SESS__.get(key);
}

// Auto-auth middleware for dev: ensures cookie + req.user exist for ALL /api calls.
// Also mirrors cookie -> Authorization so any Bearer-based checks pass.
app.use((req, res, next) => {
  try{
    if (!__DEV_AUTH_ON__) return next();

    const cookies = __parseCookies__(req);
    let token = __tokenFromReq__(req);

    // If missing, mint a default token and set cookie (NOT HttpOnly so front-end can read it)
    if (!token){
      const email = String(process.env.DEV_EMAIL || "dev@local");
      token = "dev-" + Buffer.from(email).toString("base64url");
      try { res.cookie("pdfrealm_token", token, { path:"/", sameSite:"Lax" }); } catch(e) {}
      // give downstream middleware a Bearer header if they rely on it
      try { req.headers.authorization = "Bearer " + token; } catch(e) {}
    } else {
      // keep Bearer header in sync if absent
      if (!req.headers.authorization) {
        try { req.headers.authorization = "Bearer " + token; } catch(e) {}
      }
    }

    // attach user for downstream auth checks
    req.user = __userFor__(token, (cookies.dev_email || process.env.DEV_EMAIL || "dev@local"));

    return next();
  } catch(e){
    return next();
  }
});

// Login: accepts ANY email/password in dev; sets pdfrealm_token cookie + returns token/user
/* DISABLED dev-auth /api/login - real login above handles this
app.post("/api/login", express.json(), (req, res) => {
  try{
    const email = String((req.body && req.body.email) || "dev@local");
    const token = "dev-" + Buffer.from(email).toString("base64url");
    const user = __userFor__(token, email);
    try { res.cookie("pdfrealm_token", token, { path:"/", sameSite:"Lax" }); } catch(e) {}
    // Wire referral code
    const refCode = (req.body && (req.body.ref || req.body.referralCode)) || req.query.ref || '';
    if (refCode && user && user.id) {
      assignReferralToUser(user.id, refCode, user.email).catch(e => console.warn('[referral] attribution failed:', e.message));
    }
    return res.json({ ok:true, token, user });
  } catch(e){
    return res.status(500).json({ ok:false, error: String(e && e.message ? e.message : e) });
  }
}); END DISABLED */

// Me: used by Vault UI to enable uploads/actions
app.get("/api/me", (req, res) => {
  const token = __tokenFromReq__(req);
  const u = req.user || __userFor__(token, "dev@local");
  if (!u) return res.status(401).json({ ok:false, error:"unauthorized" });
  return res.json({ ok:true, user: u });
});

// Capabilities: optional UI probe (avoid 404 noise)
app.get("/api/capabilities", (req, res) => {
  return res.json({
    ok: true,
    devAuth: __DEV_AUTH_ON__,
    paywallDisabled: String(process.env.PAYWALL_DISABLED || "").toLowerCase() === "true",
    vault: true,
    office: true,
    pdfstudio: true
  });
});

app.post("/api/logout", (req, res) => {
  try{
    const token = __tokenFromReq__(req);
    if (token) __SESS__.delete(String(token));
    try { res.clearCookie("pdfrealm_token", { path:"/" }); } catch(e) {}
    return res.json({ ok:true });
  } catch(e){
    return res.json({ ok:true });
  }
});
// <<< PDFREALM_DEV_AUTH_END


app.use("/vendor", express.static("public/vendor"));

// --- COOKIE_AUTH_BRIDGE (added by patch) ---
function _getCookie(req, name){
  try{
    const h = (req && req.headers && req.headers.cookie) ? String(req.headers.cookie) : "";
    const m = h.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
    return m ? decodeURIComponent(m[1]) : "";
  }catch(e){ return ""; }
}

// If the browser has pdfrealm_token cookie but no Authorization header,
// promote the cookie to `Authorization: Bearer ...` so Vault/WOPI routes work.
app.use((req,res,next)=>{
  try{
    if (!req.headers.authorization){
      const tok = _getCookie(req, "pdfrealm_token");
      if (tok) req.headers.authorization = "Bearer " + tok;
    }
  }catch(e){}
  next();
});

// Dev login shim (local only): allows Office/PDFStudio to authenticate without a Users table.
if ((process.env.PAYWALL_DISABLED === "true") || (process.env.NODE_ENV !== "production")) {
  app.post("/api/login", (req,res)=>{
    const email = (req.body && req.body.email) ? String(req.body.email) : "dev@local";
    const token = "dev_" + Buffer.from(email).toString("base64").replace(/=+$/,"");
    try{
      res.cookie("pdfrealm_token", token, { httpOnly:false, sameSite:"lax", path:"/" });
    }catch(e){}
    // Wire referral code
    const refCode = (req.body && (req.body.ref || req.body.referralCode)) || req.query.ref || '';
    const userId = token; // dev shim uses token as userId
    if (refCode && userId) {
      assignReferralToUser(userId, refCode, email).catch(e => console.warn('[referral] attribution failed:', e.message));
    }
    res.json({ ok:true, token, user:{ email } });
  });

  app.get("/api/me", (req,res)=>{
    const tok = _getCookie(req,"pdfrealm_token");
    if (!tok) return res.status(401).json({ ok:false, error:"Not logged in" });
    res.json({ ok:true, token: tok, user:{ email:"dev@local" } });
  });

  app.post("/api/logout", (req,res)=>{
    try{ res.clearCookie("pdfrealm_token", { path:"/" }); }catch(e){}
    res.json({ ok:true });
  });
}
// --- /COOKIE_AUTH_BRIDGE ---



// --- PDFREALM_IS_ENCRYPTED_ALL_V1 ---
app.all("/api/is-encrypted", (req, res) => {
  // Never 404 this endpoint (prevents client console noise)
  if (req.method === "OPTIONS" || req.method === "GET") {
    return res.status(200).json({ ok: true });
  }
  if (req.method !== "POST") {
    return res.status(200).json({ encrypted: false });
  }
  let multerMod;
  let PDFDocument;
  try {
    multerMod = require("multer");
    ({ PDFDocument } = require("pdf-lib"));
  } catch (e) {
    return res.status(200).json({ encrypted: false, note: "deps_missing" });
  }
  const up = multerMod({ storage: multerMod.memoryStorage(), limits: { fileSize: 250 * 1024 * 1024 } }).single("file");
  up(req, res, async (err) => {
    if (err) return res.status(200).json({ encrypted: false, note: "upload_failed" });
    const buf = req.file && req.file.buffer;
    if (!buf || !buf.length) return res.status(200).json({ encrypted: false, note: "no_file" });
    try {
      await PDFDocument.load(buf, { ignoreEncryption: false, updateMetadata: false });
      return res.status(200).json({ encrypted: false });
    } catch (e2) {
      const msg = String((e2 && (e2.message || e2)) || "").toLowerCase();
      if (msg.includes("encrypted") || msg.includes("password")) return res.status(200).json({ encrypted: true });
      return res.status(200).json({ encrypted: false, note: "parse_error_non_encryption" });
    }
  });
});
// --- end PDFREALM_IS_ENCRYPTED_ALL_V1 ---
// --- PDFREALM_IS_ENCRYPTED_EARLY_V2 ---
app.post("/api/is-encrypted", (req, res) => {
  let multerMod;
  let PDFDocument;
  try {
    multerMod = require("multer");
    ({ PDFDocument } = require("pdf-lib"));
  } catch (e) {
    // Fail-open to avoid false password prompts if deps missing
    return res.json({ encrypted: false, note: "deps_missing" });
  }
  const up = multerMod({ storage: multerMod.memoryStorage(), limits: { fileSize: 250 * 1024 * 1024 } }).single("file");
  up(req, res, async (err) => {
    if (err) return res.status(400).json({ encrypted: false, error: "UPLOAD_FAILED" });
    const buf = req.file && req.file.buffer;
    if (!buf || !buf.length) return res.status(400).json({ encrypted: false, error: "NO_FILE" });
    try {
      await PDFDocument.load(buf, { ignoreEncryption: false, updateMetadata: false });
      return res.json({ encrypted: false });
    } catch (e2) {
      const msg = String((e2 && (e2.message || e2)) || "").toLowerCase();
      if (msg.includes("encrypted") || msg.includes("password")) return res.json({ encrypted: true });
      return res.json({ encrypted: false, note: "parse_error_non_encryption" });
    }
  });
});
// --- end PDFREALM_IS_ENCRYPTED_EARLY_V2 ---
const PORT = process.env.PORT || 8080;

const JWT_SECRET = process.env.JWT_SECRET || "pdfrealm-dev-secret";

const SECURE_SEND_TOKEN_SECRET = process.env.SECURE_SEND_TOKEN_SECRET || JWT_SECRET;
const SECURE_SEND_JWT_SECRET = process.env.SECURE_SEND_JWT_SECRET || JWT_SECRET;
const SECURE_SEND_ACCESS_TTL_SECONDS = parseInt(process.env.SECURE_SEND_ACCESS_TTL_SECONDS || "1800", 10);


// ================================
// Office (Collabora / WOPI)
// ================================
const COLLABORA_URL = (process.env.COLLABORA_URL || "").trim().replace(/\/+$/, "");
const OFFICE_WOPI_SECRET = process.env.OFFICE_WOPI_SECRET || JWT_SECRET;

// Templates (self-healing): if template files are missing on disk, we write minimal blanks.
// These are tiny blank OOXML documents encoded as base64 so "Create New DOCX/XLSX/PPTX" never fails.
const OFFICE_TEMPLATE_DIR = path.join(__dirname, "office_templates");
const OFFICE_TPL_B64 = {
  docx: "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",
  xlsx: "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",
  pptx: "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",
};

function ensureOfficeTemplatesOnDisk() {
  try {
    fs.mkdirSync(OFFICE_TEMPLATE_DIR, { recursive: true });
    const pairs = [
      ["docx", path.join(OFFICE_TEMPLATE_DIR, "blank.docx")],
      ["xlsx", path.join(OFFICE_TEMPLATE_DIR, "blank.xlsx")],
      ["pptx", path.join(OFFICE_TEMPLATE_DIR, "blank.pptx")],
    ];
    for (const [kind, abs] of pairs) {
      if (!fs.existsSync(abs)) {
        const b64 = OFFICE_TPL_B64[kind];
        if (!b64) continue;
        fs.writeFileSync(abs, Buffer.from(b64, "base64"));
      }
    }
    return true;
  } catch (e) {
    console.error("Office template init error:", e?.message || e);
    return false;
  }
}

function getOfficeTemplatePath(kind) {
  const k = String(kind || "").toLowerCase();
  const map = {
    docx: path.join(OFFICE_TEMPLATE_DIR, "blank.docx"),
    xlsx: path.join(OFFICE_TEMPLATE_DIR, "blank.xlsx"),
    pptx: path.join(OFFICE_TEMPLATE_DIR, "blank.pptx"),
  };
  const abs = map[k];
  if (!abs) return null;
  // Ensure templates exist
  ensureOfficeTemplatesOnDisk();
  return abs;
}

const OFFICE_MIME = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function getPublicBaseUrl() {
  return (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
}

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64url(buf) {
  return b64url(buf);
}

function randomToken(bytes = 32) {
  return b64url(crypto.randomBytes(bytes));
}

function hmacTokenHex(token) {
  return crypto.createHmac("sha256", SECURE_SEND_TOKEN_SECRET).update(String(token)).digest("hex");
}

function parseBool(v, dflt = false) {
  if (v === undefined || v === null) return dflt;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return dflt;
}

function parseIntOrNull(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

// Paywall toggle
const PAYWALL_DISABLED =
  process.env.PAYWALL_DISABLED === "true" || process.env.PAYWALL_DISABLED === undefined;

// Postgres pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
});

// Stripe routes
const { router: stripeRouter, webhookHandler: stripeWebhook } = require("./stripe-routes.cjs")({ pool });

// Multer in-memory
const upload = multer({ storage: multer.memoryStorage() });

// ============================================================
// SIGN REQUESTS - S3 client + email helper
// ============================================================
const __signS3Region = process.env.AWS_REGION || process.env.VAULT_REGION || process.env.AWS_DEFAULT_REGION || "us-east-2";
const __signVaultBucket =
  process.env.SECURE_VAULT_BUCKET ||
  process.env.VAULT_BUCKET ||
  process.env.VAULT_S3_BUCKET ||
  process.env.AWS_VAULT_BUCKET ||
  process.env.AWS_S3_BUCKET ||
  process.env.S3_BUCKET ||
  "pdfrealm";
const __signS3 = new S3Client({
  region: __signS3Region,
  endpoint: process.env.AWS_ENDPOINT_URL || process.env.S3_ENDPOINT || undefined,
  credentials:
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
      : undefined,
  forcePathStyle: !!(process.env.AWS_ENDPOINT_URL || process.env.S3_ENDPOINT),
});

// Email via Resend
let __resendClient = null;
function getResend() {
  if (!__resendClient) {
    const { Resend } = require('resend');
    __resendClient = new Resend(process.env.RESEND_API_KEY);
  }
  return __resendClient;
}
async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { console.warn('[email] RESEND_API_KEY not set, skipping email'); return; }
  const from = process.env.EMAIL_FROM || 'PDFRealm <noreply@pdfrealm.com>';
  try {
    const resend = getResend();
    await resend.emails.send({ from, to, subject, html });
  } catch (e) {
    console.error('[email] send failed:', e?.message || e);
  }
}

// ============================================================
// SIGN REQUESTS - Schema + helpers
// ============================================================
let signReqSchemaEnsured = false;
async function ensureSignRequestSchema() {
  if (signReqSchemaEnsured) return;
  signReqSchemaEnsured = true;
  await pool.query(`CREATE TABLE IF NOT EXISTS sign_requests (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, message TEXT, requester_name TEXT, requester_email TEXT, original_filename TEXT NOT NULL, original_s3_key TEXT NOT NULL, original_sha256 TEXT NOT NULL, signed_s3_key TEXT, signed_sha256 TEXT, proof_token TEXT UNIQUE DEFAULT gen_random_uuid()::text, proof_enabled BOOLEAN DEFAULT true, status TEXT NOT NULL DEFAULT 'draft', expires_at TIMESTAMPTZ, last_sent_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, declined_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sign_recipients (id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES sign_requests(id) ON DELETE CASCADE, sequence INTEGER NOT NULL DEFAULT 0, name TEXT, email TEXT NOT NULL, token_hash TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'pending', viewed_at TIMESTAMPTZ, signed_at TIMESTAMPTZ, consented_at TIMESTAMPTZ, declined_at TIMESTAMPTZ, decline_reason TEXT, signer_name TEXT, ip_address TEXT, user_agent TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sign_events (id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, request_id TEXT NOT NULL REFERENCES sign_requests(id) ON DELETE CASCADE, recipient_id TEXT REFERENCES sign_recipients(id) ON DELETE SET NULL, kind TEXT NOT NULL, ip_address TEXT, user_agent TEXT, detail JSONB, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sign_artifacts (id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, request_id TEXT NOT NULL REFERENCES sign_requests(id) ON DELETE CASCADE, kind TEXT NOT NULL, s3_key TEXT NOT NULL, filename TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER, sha256 TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE INDEX IF NOT EXISTS sign_requests_user_id_idx ON sign_requests(user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS sign_recipients_request_id_idx ON sign_recipients(request_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS sign_events_request_id_idx ON sign_events(request_id)`);
}
// ============================================================
// REFERRAL PROGRAM - Schema + Helpers
// ============================================================
let referralSchemaEnsured = false;
async function ensureReferralSchema() {
  if (referralSchemaEnsured) return;
  referralSchemaEnsured = true;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS referral_partners (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      code TEXT UNIQUE NOT NULL,
      commission_rate_bps INTEGER NOT NULL DEFAULT 2000,
      commission_months INTEGER NOT NULL DEFAULT 24,
      active BOOLEAN NOT NULL DEFAULT true,
      notes TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS referral_partners_code_idx ON referral_partners(code)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS referral_partners_active_idx ON referral_partners(active)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS referral_attributions (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      referral_partner_id TEXT NOT NULL REFERENCES referral_partners(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL UNIQUE,
      referred_email TEXT NOT NULL DEFAULT '',
      referral_code TEXT NOT NULL DEFAULT '',
      starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ends_at TIMESTAMPTZ,
      active BOOLEAN NOT NULL DEFAULT true,
      notes TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS referral_attributions_partner_idx ON referral_attributions(referral_partner_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS referral_attributions_user_idx ON referral_attributions(user_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS referral_commissions (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      referral_partner_id TEXT NOT NULL REFERENCES referral_partners(id) ON DELETE CASCADE,
      attribution_id TEXT NOT NULL REFERENCES referral_attributions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      payout_id TEXT,
      stripe_invoice_id TEXT UNIQUE,
      stripe_charge_id TEXT NOT NULL DEFAULT '',
      subscription_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      revenue_cents INTEGER NOT NULL,
      commission_cents INTEGER NOT NULL,
      commission_rate_bps INTEGER NOT NULL DEFAULT 2000,
      invoice_paid_at TIMESTAMPTZ,
      notes TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS referral_commissions_partner_idx ON referral_commissions(referral_partner_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS referral_commissions_status_idx ON referral_commissions(status)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS referral_payouts (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      referral_partner_id TEXT NOT NULL REFERENCES referral_partners(id) ON DELETE CASCADE,
      amount_cents INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      method TEXT NOT NULL DEFAULT 'manual',
      reference TEXT NOT NULL DEFAULT '',
      paid_at TIMESTAMPTZ,
      notes TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS promotion_offers (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      code TEXT UNIQUE NOT NULL,
      label TEXT NOT NULL,
      offer_type TEXT NOT NULL DEFAULT 'first_month_free',
      stripe_coupon_id TEXT NOT NULL DEFAULT '',
      stripe_promotion_code_id TEXT NOT NULL DEFAULT '',
      active BOOLEAN NOT NULL DEFAULT true,
      notes TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_grants (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      user_id TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'owner',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS free_account_grants (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      user_id TEXT NOT NULL UNIQUE,
      tier_key TEXT NOT NULL DEFAULT 'pro',
      granted_by_email TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      expires_at TIMESTAMPTZ,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS free_account_grants_active_idx ON free_account_grants(active)`);
}

// ============ REFERRAL HELPERS ============

function calculateCommissionCents(revenueCents, commissionRateBps) {
  if (revenueCents <= 0 || commissionRateBps <= 0) return 0;
  return Math.round((revenueCents * commissionRateBps) / 10000);
}

function commissionWindowEndsAt(startsAt, commissionMonths) {
  const d = new Date(startsAt);
  d.setMonth(d.getMonth() + Math.max(0, commissionMonths));
  return d;
}

async function getReferralPartnerByCode(code) {
  await ensureReferralSchema();
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized) return null;
  const r = await pool.query('SELECT * FROM referral_partners WHERE code=$1 AND active=true', [normalized]);
  return r.rows[0] || null;
}

async function assignReferralToUser(userId, referralCode, referredEmail) {
  await ensureReferralSchema();
  const normalized = String(referralCode || '').trim().toUpperCase();
  if (!normalized || !userId) return null;

  const partner = await getReferralPartnerByCode(normalized);
  if (!partner) return null;

  const startsAt = new Date();
  const endsAt = commissionWindowEndsAt(startsAt, partner.commission_months);

  const r = await pool.query(`
    INSERT INTO referral_attributions (referral_partner_id, user_id, referred_email, referral_code, starts_at, ends_at, active)
    VALUES ($1, $2, $3, $4, $5, $6, true)
    ON CONFLICT (user_id) DO UPDATE SET
      referral_partner_id=$1, referred_email=$3, referral_code=$4, starts_at=$5, ends_at=$6, active=true, updated_at=NOW()
    RETURNING *
  `, [partner.id, userId, (referredEmail || '').toLowerCase(), normalized, startsAt, endsAt]);
  return r.rows[0];
}

async function createReferralCommission(stripeInvoiceId, stripeChargeId, userId, subscriptionId, revenueCents, invoicePaidAt) {
  await ensureReferralSchema();
  if (!stripeInvoiceId || !userId || revenueCents <= 0) return null;

  // Get active attribution for this user
  const attrRes = await pool.query(`
    SELECT a.*, p.commission_rate_bps, p.commission_months, p.active as partner_active
    FROM referral_attributions a
    JOIN referral_partners p ON p.id = a.referral_partner_id
    WHERE a.user_id=$1 AND a.active=true AND p.active=true
  `, [userId]);
  const attribution = attrRes.rows[0];
  if (!attribution) return null;

  // Check commission window
  const now = invoicePaidAt || new Date();
  if (attribution.ends_at && new Date(attribution.ends_at) < now) return null;

  const commissionCents = calculateCommissionCents(revenueCents, attribution.commission_rate_bps);
  if (commissionCents <= 0) return null;

  try {
    const r = await pool.query(`
      INSERT INTO referral_commissions
        (referral_partner_id, attribution_id, user_id, stripe_invoice_id, stripe_charge_id, subscription_id, status, revenue_cents, commission_cents, commission_rate_bps, invoice_paid_at)
      VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9, $10)
      ON CONFLICT (stripe_invoice_id) DO NOTHING
      RETURNING *
    `, [attribution.referral_partner_id, attribution.id, userId, stripeInvoiceId, stripeChargeId || '', subscriptionId || '', revenueCents, commissionCents, attribution.commission_rate_bps, invoicePaidAt || new Date()]);
    return r.rows[0] || null;
  } catch (e) {
    console.error('[referral] commission create error:', e.message);
    return null;
  }
}

async function isAdminUser(userId) {
  await ensureReferralSchema();
  if (!userId) return false;
  const r = await pool.query('SELECT id FROM admin_grants WHERE user_id=$1', [userId]);
  return r.rows.length > 0;
}

async function getFreeAccountGrant(userId) {
  await ensureReferralSchema();
  const r = await pool.query('SELECT * FROM free_account_grants WHERE user_id=$1 AND active=true', [userId]);
  const grant = r.rows[0];
  if (!grant) return null;
  if (grant.expires_at && new Date(grant.expires_at) < new Date()) return null;
  return grant;
}

// ============ END REFERRAL HELPERS ============

// ============ AI CHAT HELPERS ============
let aiChatSchemaEnsured = false;
async function ensureAiChatSchema() {
  if (aiChatSchemaEnsured) return;
  aiChatSchemaEnsured = true;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_chat_credits (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      user_id TEXT NOT NULL UNIQUE,
      credits INTEGER NOT NULL DEFAULT 0,
      lifetime_credits INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_chat_messages (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT 'gpt-4o-mini',
      credits_used INTEGER NOT NULL DEFAULT 1,
      tool_context TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS ai_chat_messages_user_session ON ai_chat_messages(user_id, session_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ai_chat_messages_created ON ai_chat_messages(created_at)`);
}

async function getAiCredits(userId) {
  await ensureAiChatSchema();
  const r = await pool.query('SELECT credits FROM ai_chat_credits WHERE user_id=$1', [userId]);
  return r.rows[0]?.credits ?? 0;
}

async function consumeAiCredit(userId, amount = 1) {
  await ensureAiChatSchema();
  // Give free users 5 credits on first use
  await pool.query(`
    INSERT INTO ai_chat_credits (user_id, credits, lifetime_credits)
    VALUES ($1, 5, 0)
    ON CONFLICT (user_id) DO NOTHING
  `, [userId]);
  const r = await pool.query(`
    UPDATE ai_chat_credits 
    SET credits = credits - $2, updated_at = NOW()
    WHERE user_id = $1 AND credits >= $2
    RETURNING credits
  `, [userId, amount]);
  if (!r.rows.length) return false; // Not enough credits
  return true;
}

async function addAiCredits(userId, amount) {
  await ensureAiChatSchema();
  const r = await pool.query(`
    INSERT INTO ai_chat_credits (user_id, credits, lifetime_credits)
    VALUES ($1, $2, $2)
    ON CONFLICT (user_id) DO UPDATE SET
      credits = ai_chat_credits.credits + $2,
      lifetime_credits = ai_chat_credits.lifetime_credits + $2,
      updated_at = NOW()
    RETURNING credits
  `, [userId, amount]);
  return r.rows[0]?.credits;
}
// ============ END AI CHAT HELPERS ============

function signReqId() { return 'sreq_' + crypto.randomBytes(12).toString('hex'); }
function signRecipId() { return 'srec_' + crypto.randomBytes(12).toString('hex'); }
function hashSignToken(raw) { return crypto.createHash('sha256').update('pdfrealm_sign_token:' + raw).digest('hex'); }
function issueSignToken() { const raw = crypto.randomBytes(24).toString('base64url'); return { raw, hash: hashSignToken(raw) }; }
function parseSignRecipients(input) {
  const lines = (input || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    const angle = line.match(/^(.*?)<([^>]+)>$/);
    if (angle) { out.push({ name: angle[1].trim().replace(/^"|"$/g,'') || null, email: angle[2].trim().toLowerCase() }); continue; }
    const csv = line.split(',').map(x => x.trim());
    if (csv.length >= 2) { const email = csv[csv.length-1].toLowerCase(); out.push({ name: csv.slice(0,-1).join(', ').trim() || null, email }); continue; }
    if (line.includes('@')) out.push({ name: null, email: line.toLowerCase() });
  }
  const seen = new Set();
  return out.filter(r => { if (seen.has(r.email)) return false; seen.add(r.email); return true; });
}
function signRequestEmailHtml({ requesterName, recipientName, title, message, signUrl, expiresAt }) {
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const greeting = recipientName ? `Hi ${esc(recipientName)},` : 'Hi,';
  const from = requesterName ? esc(requesterName) : 'Someone';
  const msgBlock = message ? `<div style="margin:0 0 14px 0;padding:10px 12px;border:1px solid #e5e7eb;border-radius:8px;background:#fafafa;">${esc(message)}</div>` : '';
  const expBlock = expiresAt ? `<p style="font-size:12px;color:#6b7280;">Expires: ${esc(expiresAt)}</p>` : '';
  return `<div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:20px;"><h2 style="margin:0 0 12px 0;">Signature requested</h2><p style="color:#6b7280;font-size:12px;">From: ${from}</p><div style="border:1px solid #e5e7eb;border-radius:12px;padding:16px;background:#fff;"><p>${greeting}</p><p>You were asked to sign <b>${esc(title)}</b>.</p>${msgBlock}<a href="${signUrl}" style="display:inline-block;background:#111827;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;">Review &amp; Sign</a>${expBlock}<p style="font-size:11px;color:#9ca3af;margin-top:12px;">Or copy: ${signUrl}</p></div><p style="font-size:11px;color:#9ca3af;margin-top:12px;">Sent via PDFRealm</p></div>`;
}
function signCompletionEmailHtml({ requesterName, title, signerCount, downloadUrl, proofUrl }) {
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const greeting = requesterName ? `Hi ${esc(requesterName)},` : 'Hi,';
  const proofBlock = proofUrl ? `<p><a href="${proofUrl}" style="color:#111827;">View proof of completion →</a></p>` : '';
  return `<div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:20px;"><h2>✅ Document fully signed</h2><div style="border:1px solid #e5e7eb;border-radius:12px;padding:16px;background:#fff;"><p>${greeting}</p><p><b>${esc(title)}</b> has been signed by all ${signerCount} ${signerCount===1?'signer':'signers'}.</p><a href="${downloadUrl}" style="display:inline-block;background:#111827;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;">Download signed document</a>${proofBlock}</div><p style="font-size:11px;color:#9ca3af;margin-top:12px;">PDFRealm</p></div>`;
}
// ============================================================
// END SIGN REQUESTS - Schema + helpers
// ============================================================

// Stripe webhook (must be BEFORE express.json to get raw body)
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), stripeWebhook);
app.use("/api/stripe", express.json(), stripeRouter);

// Basic middleware
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
// JSON parse error handler
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid JSON" });
  }
  next(err);
});

// -------------------- helpers --------------------
function nowIso() { return new Date().toISOString(); }

function createJwt(user) {
  return jwt.sign(
    {
      id: user.id,                 // MUST be UUID string
      email: user.email,
      role: user.role || "user",
      subscribed: !!user.subscribed,
    },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

// Back-compat alias (older code may call issueJwt)
const issueJwt = createJwt;

function getUserFromRequest(req) {
  const auth = req.headers["authorization"] || "";
  let token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  // Also accept JWT from cookies for same-origin navigations/iframes.
  // Many in-browser preview flows (e.g. <iframe src="/api/vault/file-proxy/...">)
  // can't attach an Authorization header, but will send cookies.
  if (!token) {
    const cookies = parseCookies(req);
    token =
      cookies.pdfrealm_token ||
      cookies.token ||
      cookies.auth_token ||
      cookies.jwt ||
      "";
  }

  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: "Not logged in." });
  req.user = user;
  next();
}


function parseCookies(req) {
  const header = (req && req.headers && req.headers.cookie) ? String(req.headers.cookie) : "";
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const p = String(part || "").trim();
    if (!p) continue;
    const idx = p.indexOf("=");
    if (idx < 0) continue;
    const k = p.slice(0, idx).trim();
    const v = p.slice(idx + 1).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

function isUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v || ""));
}

// ============================
// Hash Evidence Machine (PG) — Phase 1: Evidence Core
// ============================

let __evidenceSchemaReady = false;

async function ensureEvidenceSchema() {
  if (__evidenceSchemaReady) return;
  // Create tables if missing (idempotent)
  await pool.query(`
    create table if not exists evidence_artifacts (
      id uuid primary key,
      user_id text,
      original_filename text not null,
      mime_type text not null,
      size_bytes bigint not null,
      sha256 text not null,
      storage_path text not null,
      created_at timestamptz not null default now()
    );
  `);

  await pool.query(`
    create table if not exists evidence_events (
      id bigserial primary key,
      artifact_id uuid not null references evidence_artifacts(id) on delete cascade,
      seq int not null,
      action text not null,
      details jsonb,
      actor jsonb,
      prev_hash text,
      event_hash text not null,
      created_at timestamptz not null default now(),
      unique(artifact_id, seq)
    );
  `);

  await pool.query(`create index if not exists idx_evidence_events_artifact on evidence_events(artifact_id, seq);`);
  await pool.query(`create index if not exists idx_evidence_artifacts_user on evidence_artifacts(user_id);`);

  __evidenceSchemaReady = true;
}

async function vaultHasNewSchema() {
  return (await dbHasTable("vault_files")) && (await dbHasTable("vault_folders"));
}

async function vaultFoldersHaveTreeColumns() {
  if (!(await dbHasTable("vault_folders"))) return false;
  return (await dbHasColumn("vault_folders", "parent_id")) && (await dbHasColumn("vault_folders", "name")) && (await dbHasColumn("vault_folders", "path"));
}

async function ensureVaultRootTrashWorking(userId) {
  if (!(await vaultHasNewSchema())) return { rootId: null, trashId: null, workingId: null };
  if (!(await vaultFoldersHaveTreeColumns())) return { rootId: null, trashId: null, workingId: null };

  let rootId = null;
  try {
    const r = await safeQuery(
      `SELECT id FROM vault_folders WHERE user_id=$1 AND parent_id IS NULL AND path='' AND deleted_at IS NULL LIMIT 1`,
      [userId]
    );
    rootId = r.rows?.[0]?.id || null;
  } catch {}

  if (!rootId) {
    try {
      const r2 = await safeQuery(
        `INSERT INTO vault_folders (user_id, parent_id, name, path) VALUES ($1, NULL, '__root__', '') RETURNING id`,
        [userId]
      );
      rootId = r2.rows?.[0]?.id || null;
    } catch {}
  }

  try {
    await safeQuery(
      `UPDATE vault_files SET trashed_at=NULL, folder_path='' WHERE user_id=$1 AND deleted_at IS NULL AND (trashed_at IS NOT NULL OR lower(COALESCE(folder_path,''))=lower('_Trash'))`,
      [userId]
    );
  } catch {}

  try {
    await safeQuery(
      `UPDATE vault_folders SET deleted_at=NOW() WHERE user_id=$1 AND deleted_at IS NULL AND (trashed_at IS NOT NULL OR lower(path)=lower('_Trash') OR lower(path) LIKE lower('_Trash/%'))`,
      [userId]
    );
  } catch {}

  const ensureChild = async (pathKey, displayName) => {
    if (!rootId) return null;
    try {
      const r = await safeQuery(
        `SELECT id FROM vault_folders WHERE user_id=$1 AND lower(path)=lower($2) AND deleted_at IS NULL LIMIT 1`,
        [userId, pathKey]
      );
      if (r.rows?.[0]?.id) return r.rows[0].id;
    } catch {}
    try {
      const r2 = await safeQuery(
        `INSERT INTO vault_folders (user_id, parent_id, name, path) VALUES ($1, $2, $3, $4) RETURNING id`,
        [userId, rootId, displayName, pathKey]
      );
      return r2.rows?.[0]?.id || null;
    } catch {
      try {
        const r3 = await safeQuery(
          `SELECT id FROM vault_folders WHERE user_id=$1 AND lower(path)=lower($2) AND deleted_at IS NULL LIMIT 1`,
          [userId, pathKey]
        );
        return r3.rows?.[0]?.id || null;
      } catch { return null; }
    }
  };

  const workingId = await ensureChild("Working Folder", "Working Folder");
  return { rootId, trashId: null, workingId };
}

async function vaultFolderIdFromPath(userId, pathKey) {
  if (!(await vaultHasNewSchema())) return null;
  if (!(await dbHasTable("vault_folders"))) return null;
  const key = normVaultFolderKey(pathKey);
  try {
    const r = await safeQuery(
      `SELECT id FROM vault_folders WHERE user_id=$1 AND lower(path)=lower($2) AND deleted_at IS NULL LIMIT 1`,
      [userId, key]
    );
    return r.rows?.[0]?.id || null;
  } catch { return null; }
}

async function ensureVaultFolderPath(userId, pathKey) {
  const key = normVaultFolderKey(pathKey);
  const { rootId, workingId } = await ensureVaultRootTrashWorking(userId);

  if (!key) return rootId || null;
  if (String(key).toLowerCase() === "_trash") return rootId || null;
  if (workingId && String(key).toLowerCase() === "working folder") return workingId;

  const existing = await vaultFolderIdFromPath(userId, key);
  if (existing) return existing;

  const segs = String(key).split("/").filter(Boolean);
  let parentId = rootId || null;
  let curPath = "";

  for (const seg of segs) {
    curPath = curPath ? (curPath + "/" + seg) : seg;
    let id = await vaultFolderIdFromPath(userId, curPath);
    if (!id) {
      try {
        const r = await safeQuery(
          `INSERT INTO vault_folders (user_id, parent_id, name, path) VALUES ($1, $2, $3, $4) RETURNING id`,
          [userId, parentId, seg, curPath]
        );
        id = r.rows?.[0]?.id || null;
      } catch {
        id = await vaultFolderIdFromPath(userId, curPath);
      }
    } else {
      await safeQuery(
        `UPDATE vault_folders SET parent_id=$3, updated_at=NOW() WHERE user_id=$1 AND id=$2 AND parent_id IS DISTINCT FROM $3`,
        [userId, id, parentId]
      ).catch(() => {});
    }
    parentId = id;
  }
  return parentId;
}

function safeExtFromName(name) {
  const n = String(name || "");
  const i = n.lastIndexOf(".");
  if (i < 0) return "";
  const ext = n.slice(i).toLowerCase();
  if (!/^\.[a-z0-9]{1,8}$/.test(ext)) return "";
  return ext;
}

function safeCleanFolder(folderRaw) {
  const raw = String(folderRaw || "").trim();
  if (!raw) return "";
  let cleaned = raw.replace(/\\/g, "/");
  cleaned = cleaned.replace(/^\/+/, "").replace(/\/+$/, "");
  cleaned = cleaned.replace(/\/{2,}/g, "/");
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.some((p) => p === "." || p === "..")) throw new Error("Invalid folder path.");
  cleaned = cleaned.replace(/[^a-zA-Z0-9 _\-./]/g, "_").trim();
  return cleaned;
}

function normVaultFolderKey(raw) {
  const s = String(raw || "").trim();
  if (s === "__home__" || s.toLowerCase() === "vault home" || s.toLowerCase() === "home") return "";
  if (!s || s === "/") return "";
  return safeCleanFolder(s);
}

function getUserVaultPrefix(user) {
  const uid = (user && (user.id || user.user_id)) || "user";
  const safe = String(uid).replace(/[^a-zA-Z0-9_\-]/g, "_");
  const rawPrefix = String(process.env.VAULT_OBJECT_PREFIX || "").trim();
  const normPrefix = rawPrefix ? rawPrefix.replace(/^\/+/, "").replace(/\/?$/, "/") : "";
  return `${normPrefix}${safe}/`;
}

function buildVaultKey({ user, folder, originalName }) {
  const prefix = getUserVaultPrefix(user);
  const cleanedFolder = folder ? safeCleanFolder(folder) : "";
  const folderPath = cleanedFolder ? cleanedFolder + "/" : "";
  const ext = safeExtFromName(originalName);
  const uuid = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString("hex");
  return `${prefix}${folderPath}${Date.now()}-${uuid}${ext}`;
}

function safeFilename(name) {
  const base = String(name || "document").trim() || "document";
  // avoid path traversal; keep simple charset
  return base.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 160);
}

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function canonicalJson(obj) {
  // stable stringify: sorts keys recursively
  const t = (v) => {
    if (v === null || v === undefined) return null;
    if (Array.isArray(v)) return v.map(t);
    if (typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = t(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(t(obj));
}

async function appendEvidenceEvent({ artifactId, action, details, actor }) {
  await ensureEvidenceSchema();

  const lastQ = await pool.query(
    `select seq, event_hash from evidence_events where artifact_id=$1 order by seq desc limit 1`,
    [artifactId]
  );
  const last = lastQ.rows[0] || null;
  const nextSeq = last ? (last.seq + 1) : 1;

  // Canonical chain rule: first event uses empty prev_hash
  const prevHash = last ? String(last.event_hash) : "";

  // Canonical timestamp: ISO string written + hashed (do NOT rely on DB default now())
  const createdAt = new Date().toISOString();

  const safeAction = String(action || "EVENT").slice(0, 80);
  const safeDetails = details ?? null;
  const safeActor = actor ?? null;

  // Canonical Event Hash v1:
  // sha256(prev_hash + "|" + action + "|" + created_at + "|" + stable_json(details))
  const material = String(prevHash || "") + "|" + safeAction + "|" + String(createdAt) + "|" + canonicalJson(safeDetails);
  const eventHash = sha256Hex(Buffer.from(material));

  const ins = await pool.query(
    `insert into evidence_events (artifact_id, seq, action, details, actor, prev_hash, event_hash, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     returning id, artifact_id, seq, action, details, actor, prev_hash, event_hash, created_at`,
    [artifactId, nextSeq, safeAction, safeDetails, safeActor, prevHash || null, eventHash, createdAt]
  );

  return ins.rows[0];
}

function evidenceActorFromReq(req) {
  // Keep it flexible: store whatever identity we have without breaking auth models
  const u = req.user || null;
  return {
    userId: u?.id ?? u?.userId ?? u?.email ?? null,
    email: u?.email ?? null,
    ip: req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
    ua: req.headers["user-agent"] || null
  };
}

async function requireExportAccess(req, res, next, toolName) {
  if (PAYWALL_DISABLED) return next();

  // Check for free account grant
  const _freeGrantUser = req.user || getUserFromRequest(req);
  const freeGrant = _freeGrantUser?.id ? await getFreeAccountGrant(_freeGrantUser.id).catch(() => null) : null;
  if (freeGrant) {
    return next(); // Free account — bypass paywall
  }

  const user = getUserFromRequest(req);
  if (user && user.subscribed) return next();

  // Validate pay-per-access token (header or cookie)
  const ppeToken = req.headers["x-ppe-session"] || req.cookies?.ppe_token;
  if (ppeToken) {
    try {
      const result = await pool.query(
        "SELECT 1 FROM pay_per_export_sessions WHERE token = $1 AND expires_at > NOW() LIMIT 1",
        [ppeToken]
      );
      if (result.rowCount > 0) return next();
    } catch (e) {
      console.error("[requireExportAccess] DB check failed:", e.message);
    }
  }

  return res.status(402).json({
    error: "Export requires payment or an active access pass.",
    tool: toolName,
    checkoutUrl: "/api/pay-per-export/create-checkout-session",
  });
}

// ---- PDF-lib helpers (used by tool endpoints) ----
async function loadPdfFromBuffer(buf) {
  const PDFLib = require("pdf-lib");
  return await PDFLib.PDFDocument.load(buf);
}
async function savePdf(doc) {
  return Buffer.from(await doc.save());
}

// ---- Ghostscript helpers ----
function canRunGhostscript() {
  try {
    const r = spawnSync("gs", ["--version"], { windowsHide: true });
    return !!(r && r.status === 0);
  } catch {
    return false;
  }
}

function runGhostscript(args) {
  const env = { ...process.env };
  const sep = process.platform === "win32" ? ";" : ":";
  const extra = [];
  if (process.platform !== "win32") extra.push("/usr/local/bin", "/usr/bin", "/bin");
  env.PATH = [...extra, env.PATH || ""].filter(Boolean).join(sep);
  return spawnSync("gs", args, { env, windowsHide: true });
}

function tmpPdfPath(prefix) {
  const stamp = Date.now() + "_" + Math.random().toString(16).slice(2);
  return path.join(os.tmpdir(), `${prefix}_${stamp}.pdf`);
}

// ---- qpdf helpers (used by encrypt, decrypt, rotate, compress, delete-pages) ----
function canRunQpdf(cmd) {
  try {
    const env = { ...process.env };
    env.PATH = env.PATH || "";
    const r = spawnSync(cmd, ["--version"], { env, windowsHide: true });
    return r && r.status === 0;
  } catch {
    return false;
  }
}

function resolveQpdfPath() {
  const candidates = [];
  if (process.env.QPDF_PATH) candidates.push(process.env.QPDF_PATH);
  candidates.push(path.join(__dirname, ".qpdf", "bin", "qpdf"));
  candidates.push(path.join(process.cwd(), ".qpdf", "bin", "qpdf"));
  if (process.platform === "darwin") {
    candidates.push("/opt/homebrew/bin/qpdf");
    candidates.push("/usr/local/bin/qpdf");
    candidates.push("/usr/bin/qpdf");
  } else if (process.platform !== "win32") {
    candidates.push("/usr/local/bin/qpdf");
    candidates.push("/usr/bin/qpdf");
    candidates.push("/bin/qpdf");
  }
  candidates.push("qpdf");
  candidates.push(path.join(__dirname, "bin", "qpdf"));
  candidates.push(path.join(process.cwd(), "bin", "qpdf"));

  const seen = new Set();
  for (const c of candidates) {
    if (!c || seen.has(c)) continue;
    seen.add(c);
    try {
      if (c === "qpdf") {
        if (canRunQpdf(c)) return c;
        continue;
      }
      if (fs.existsSync(c) && canRunQpdf(c)) return c;
    } catch {}
  }
  return null;
}

function runQpdf(args, qpdfPath) {
  const env = { ...process.env };
  const extra = [];
  const sep = process.platform === "win32" ? ";" : ":";
  if (qpdfPath && qpdfPath !== "qpdf" && qpdfPath !== "qpdf.exe") {
    extra.push(path.dirname(qpdfPath));
  }
  if (process.platform !== "win32") extra.push("/usr/local/bin", "/usr/bin", "/bin");
  env.PATH = [...extra, env.PATH || ""].filter(Boolean).join(sep);
  return spawnSync(qpdfPath || "qpdf", args, { env, windowsHide: true });
}



async function dbHasColumn(table, column) {
  const q = `
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name=$1 AND column_name=$2
    LIMIT 1
  `;
  const r = await pool.query(q, [table, column]);
  return r.rowCount > 0;
}

async function dbHasTable(table) {
  const q = `
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema='public' AND table_name=$1
    LIMIT 1
  `;
  const r = await pool.query(q, [table]);
  return r.rowCount > 0;
}

async function safeQuery(sql, params) {
  try {
    return await pool.query(sql, params);
  } catch (e) {
    // bubble up with context
    e._sql = sql;
    throw e;
  }
}
// Render a single PDF page to PNG for previews (avoids browser PDF toolbar).
app.post("/api/render/page", upload.any(), async (req, res) => {
  const tmpRoot = os.tmpdir();
  const stamp = Date.now() + "_" + Math.random().toString(16).slice(2);
  const tmpIn = path.join(tmpRoot, "pdfrealm_render_in_" + stamp + ".pdf");
  const tmpDec = path.join(tmpRoot, "pdfrealm_render_dec_" + stamp + ".pdf");
  const tmpPng = path.join(tmpRoot, "pdfrealm_render_" + stamp + ".png");
  const tmpPrefix = path.join(tmpRoot, "pdfrealm_render_" + stamp);

  try {
    const files = req.files || [];
    const file = files[0];
    if (!file || !file.buffer) return res.status(400).json({ error: "File required." });

    const page = Math.max(1, parseInt(String(req.body.page || "1"), 10) || 1);
    const dpiRaw = parseInt(String(req.body.dpi || "144"), 10) || 144;
    const dpi = Math.max(72, Math.min(240, dpiRaw));
    const password = String(req.body.password || req.body.inputPassword || "");

    fs.writeFileSync(tmpIn, file.buffer);
    let workPath = tmpIn;
    let gsPassword = "";

    // Prefer qpdf for decrypt when available.
    if (password) {
      const qpdfPath = resolveQpdfPath();
      if (qpdfPath) {
        const q = runQpdf([`--password=${password}`, "--decrypt", "--", tmpIn, tmpDec], qpdfPath);
        if (q.status === 0) {
          workPath = tmpDec;
        } else {
          const err = (q.stderr || Buffer.from("")).toString().toLowerCase();
          if (err.includes("invalid password") || err.includes("password incorrect")) {
            return res.status(400).json({ error: "Invalid password for encrypted PDF." });
          }
          // Fall back to Ghostscript password.
          gsPassword = password;
        }
      } else {
        gsPassword = password;
      }
    }

    // Best-effort page count header (qpdf)
    try {
      const qpdfPath = resolveQpdfPath();
      if (qpdfPath) {
        const np = runQpdf(["--show-npages", workPath], qpdfPath);
        const n = parseInt((np.stdout || Buffer.from("")).toString().trim(), 10);
        if (!isNaN(n) && n > 0) res.setHeader("X-PDF-Page-Count", String(n));
      }
    } catch {}

    // Render with Ghostscript (best, supports password).
    if (canRunGhostscript()) {
      const gsArgs = [
        "-q",
        "-dNOPAUSE",
        "-dBATCH",
        "-sDEVICE=pngalpha",
        `-dFirstPage=${page}`,
        `-dLastPage=${page}`,
        `-r${dpi}`,
        `-sOutputFile=${tmpPng}`,
      ];
      if (gsPassword) gsArgs.push(`-sPDFPassword=${gsPassword}`);
      gsArgs.push(workPath);

      const r = runGhostscript(gsArgs);
      if (r.status !== 0 || !fs.existsSync(tmpPng)) {
        const err = (r.stderr || Buffer.from("")).toString().toLowerCase();
        if (err.includes("invalid password") || err.includes("password incorrect")) {
          return res.status(400).json({ error: "Invalid password for encrypted PDF." });
        }
        return res.status(500).json({ error: "Preview render failed." });
      }

      res.setHeader("Content-Type", "image/png");
      return res.send(fs.readFileSync(tmpPng));
    }

    // Fallback: pdftoppm (Poppler). No password support unless qpdf decrypted.
    const probe = spawnSync("pdftoppm", ["-v"], { windowsHide: true });
    if (probe.error) return res.status(501).json({ error: "No renderer installed (Ghostscript/pdftoppm)." });

    if (password && workPath === tmpIn) {
      return res.status(501).json({ error: "Encrypted preview requires Ghostscript or qpdf." });
    }

    const p = spawnSync(
      "pdftoppm",
      ["-png", "-f", String(page), "-singlefile", "-r", String(dpi), workPath, tmpPrefix],
      { windowsHide: true }
    );
    const outFile = tmpPrefix + ".png";
    if (p.status !== 0 || !fs.existsSync(outFile)) {
      return res.status(500).json({ error: "Preview render failed." });
    }

    res.setHeader("Content-Type", "image/png");
    return res.send(fs.readFileSync(outFile));
  } catch (e) {
    console.error("render/page error:", e);
    return res.status(500).json({ error: "Preview render failed." });
  } finally {
    try { if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn); } catch {}
    try { if (fs.existsSync(tmpDec)) fs.unlinkSync(tmpDec); } catch {}
    try { if (fs.existsSync(tmpPng)) fs.unlinkSync(tmpPng); } catch {}
    try { if (fs.existsSync(tmpPrefix + ".png")) fs.unlinkSync(tmpPrefix + ".png"); } catch {}
  }
});
// Normalize (qpdf) — rewrites PDFs into a simpler structure (no object streams) so pdf-lib can parse them.
// Accepts multipart/form-data with a single PDF (first file wins). Optional `password` if input is encrypted.
app.post("/api/qpdf/normalize", upload.any(), async (req, res) => {
  try {
    const files = req.files || [];
    const file = files[0];
    if (!file || !file.buffer) return res.status(400).json({ error: "File required." });

    const password = String(req.body.password ?? req.body.inputPassword ?? req.body.currentPassword ?? "");

    // Validate header (encrypted PDFs still start with %PDF)
    try {
      const head = file.buffer.slice(0, 8).toString("latin1");
      if (!head.startsWith("%PDF")) {
        const preview = file.buffer.slice(0, 200).toString("utf8").replace(/\s+/g, " ").slice(0, 180);
        return res.status(400).json({ error: "Input is not a valid PDF (missing %PDF header).", preview });
      }
    } catch {}

    const qpdfPath = resolveQpdfPath();
    if (!qpdfPath) {
      return res.status(501).json({
        error:
          "Server-side PDF normalization requires qpdf, but qpdf is not available in this runtime. Install qpdf into the service or set QPDF_PATH to the qpdf executable.",
      });
    }

    const tmpRoot = os.tmpdir();
    const stamp = Date.now() + "_" + Math.random().toString(16).slice(2);
    const tmpIn = path.join(tmpRoot, "pdfrealm_norm_in_" + stamp + ".pdf");
    const tmpOut = path.join(tmpRoot, "pdfrealm_norm_out_" + stamp + ".pdf");

    try {
      fs.writeFileSync(tmpIn, file.buffer);

      const args = [];
      if (password) args.push(`--password=${password}`);
      // Make a "pdf-lib friendly" rewrite:
      // - disable object streams
      // - uncompress streams (qdf)
      // NOTE: This can increase output size but improves compatibility.
      args.push("--object-streams=disable", "--stream-data=uncompress", "--qdf", "--", tmpIn, tmpOut);

      const q = runQpdf(args, qpdfPath);

      if (q.status == null) {
        const errTxt = String(q.error || "");
        return res.status(501).json({
          error: "qpdf executable could not be launched (not found).",
          details: errTxt,
          hint: "Install qpdf and ensure it's on PATH, or set QPDF_PATH to the full path of qpdf (or qpdf.exe).",
        });
      }

      if (q.status !== 0) {
        const stderr = (q.stderr || Buffer.from("")).toString();
        if (/invalid password/i.test(stderr) || /password.*invalid/i.test(stderr)) {
          return res.status(400).json({
            error: "Input PDF is encrypted and the password was not accepted.",
            details: stderr,
          });
        }
        return res.status(500).json({ error: "qpdf normalize failed.", details: stderr });
      }

      const out = fs.readFileSync(tmpOut);
      res.setHeader("Content-Type", "application/pdf");
      res.send(out);
    } finally {
      try { fs.unlinkSync(tmpIn); } catch {}
      try { fs.unlinkSync(tmpOut); } catch {}
    }
  } catch (e) {
    console.error("qpdf normalize error:", e);
    res.status(500).json({ error: "Normalize failed." });
  }
});

// PDFStudio prepare endpoint (decrypt + normalize for pdf-lib compatibility).
// Accepts multipart/form-data with a PDF in any field name (first file wins) and optional `password`.
// Returns an unencrypted, "pdf-lib friendly" PDF (object streams disabled, streams uncompressed).
app.post("/api/pdfstudio/prepare", upload.any(), async (req, res) => {
  try {
    const files = req.files || [];
    const file = files[0];
    if (!file || !file.buffer) return res.status(400).json({ error: "File required." });

    // Validate header
    try {
      const head = file.buffer.slice(0, 8).toString("latin1");
      if (!head.startsWith("%PDF")) {
        const preview = file.buffer.slice(0, 200).toString("utf8").replace(/\s+/g, " ").slice(0, 180);
        return res.status(400).json({ error: "Input is not a valid PDF (missing %PDF header).", preview });
      }
    } catch {}

    const password = String(req.body.password ?? req.body.inputPassword ?? req.body.currentPassword ?? "");
    const qpdfPath = resolveQpdfPath();
    if (!qpdfPath) {
      return res.status(501).json({
        error:
          "Server-side PDF preparation requires qpdf, but qpdf is not available in this runtime. Install qpdf into the service or set QPDF_PATH to the qpdf executable.",
      });
    }

    const tmpRoot = os.tmpdir();
    const stamp = Date.now() + "_" + Math.random().toString(16).slice(2);
    const tmpIn = path.join(tmpRoot, "pdfrealm_prep_in_" + stamp + ".pdf");
    const tmpOut = path.join(tmpRoot, "pdfrealm_prep_out_" + stamp + ".pdf");

    try {
      fs.writeFileSync(tmpIn, file.buffer);

      const args = [];
      if (password) args.push(`--password=${password}`, "--decrypt");

      // Rewrite for better compatibility with pdf-lib:
      // - disable object streams
      // - uncompress streams
      // - qdf formatting
      args.push("--object-streams=disable", "--stream-data=uncompress", "--qdf", "--", tmpIn, tmpOut);

      const q = runQpdf(args, qpdfPath);

      if (q.status == null) {
        const errTxt = String(q.error || "");
        return res.status(501).json({
          error: "qpdf executable could not be launched (not found).",
          details: errTxt,
          hint: "Install qpdf and ensure it's on PATH, or set QPDF_PATH to the full path of qpdf (or qpdf.exe).",
        });
      }

      if (q.status !== 0) {
        const stderr = (q.stderr || Buffer.from("")).toString();

        // Password required / encrypted
        if (!password && (/password required/i.test(stderr) || /encrypted/i.test(stderr))) {
          return res.status(400).json({ error: "Password required for encrypted PDF.", code: "PASSWORD_REQUIRED" });
        }
        if (/invalid password/i.test(stderr) || /password.*invalid/i.test(stderr)) {
          return res.status(400).json({ error: "Invalid password for encrypted PDF.", code: "INVALID_PASSWORD" });
        }

        return res.status(400).json({
          error: "qpdf prepare failed.",
          details: stderr.slice(0, 600),
        });
      }

      const outBuf = fs.readFileSync(tmpOut);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", 'inline; filename="prepared.pdf"');
      return res.status(200).send(outBuf);
    } finally {
      try { fs.unlinkSync(tmpIn); } catch {}
      try { fs.unlinkSync(tmpOut); } catch {}
    }
  } catch (e) {
    console.error("PDFStudio prepare error:", e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});


// Quick Sign — place signature image or text on PDF
app.post(
  "/api/quick-sign",
  upload.single("file"),
  (req, res, next) => requireExportAccess(req, res, next, "quick-sign"),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "File required." });

      const signer = String(req.body.signerName || "Signed").trim();
      const sigDataUrl = String(req.body.signatureDataUrl || "").trim();
      const initialsDataUrl = String(req.body.initialsDataUrl || req.body.initDataUrl || "").trim();
      const initialsText = String(req.body.initialsText || "").trim();

      const pdf = await loadPdfFromBuffer(req.file.buffer);
      const pages = pdf.getPages();
      if (!pages.length) return res.status(400).json({ error: "No pages in PDF." });

      const clampV = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
      const parseJsonArray = (raw) => {
        try { if (!raw) return []; const v = JSON.parse(String(raw)); return Array.isArray(v) ? v : []; } catch { return []; }
      };
      const decodeDataUrlImage = (dataUrl) => {
        const m = String(dataUrl || "").match(/^data:(image\/png|image\/jpeg);base64,(.+)$/);
        if (!m) return null;
        return { mime: m[1], bytes: Buffer.from(m[2], "base64") };
      };

      let sigPlacements = parseJsonArray(req.body.sigPlacements);
      if (!sigPlacements.length) {
        const sigPage = parseInt(String(req.body.sigPage || "1"), 10) || 1;
        sigPlacements = [{
          page: sigPage,
          x: parseFloat(String(req.body.sigX || "0.08")),
          y: parseFloat(String(req.body.sigY || "0.78")),
          w: parseFloat(String(req.body.sigW || "0.20")),
          h: parseFloat(String(req.body.sigH || "0.08"))
        }];
      }

      let initPlacements = parseJsonArray(req.body.initPlacements);
      if (!initPlacements.length && (initialsDataUrl || initialsText)) {
        const initPage = parseInt(String(req.body.initPage || "1"), 10) || 1;
        initPlacements = [{
          page: initPage,
          x: parseFloat(String(req.body.initX || "0.70")),
          y: parseFloat(String(req.body.initY || "0.80")),
          w: parseFloat(String(req.body.initW || "0.10")),
          h: parseFloat(String(req.body.initH || "0.05"))
        }];
      }

      if (sigDataUrl && sigDataUrl.startsWith("data:image/")) {
        const sigDecoded = decodeDataUrlImage(sigDataUrl);
        if (!sigDecoded) return res.status(400).json({ error: "Invalid signature image." });

        const sigEmbed = sigDecoded.mime === "image/png" ? await pdf.embedPng(sigDecoded.bytes) : await pdf.embedJpg(sigDecoded.bytes);

        for (const pl of sigPlacements) {
          const sigPage = parseInt(String(pl?.page || "1"), 10) || 1;
          const pageIndex = clampV(sigPage - 1, 0, pages.length - 1);
          const page = pages[pageIndex];
          const { width, height } = page.getSize();
          const xNorm = parseFloat(String(pl?.x ?? "0.08"));
          const yNorm = parseFloat(String(pl?.y ?? "0.78"));
          const wNorm = parseFloat(String(pl?.w ?? "0.20"));
          const hNorm = parseFloat(String(pl?.h ?? "0.08"));
          let w = clampV(wNorm, 0.005, 0.95) * width;
          let h = clampV(hNorm, 0.005, 0.95) * height;
          let x = clampV(xNorm, 0, 1) * width;
          let yTop = clampV(yNorm, 0, 1) * height;
          let y = height - yTop - h;
          x = clampV(x, 0, Math.max(0, width - w));
          y = clampV(y, 0, Math.max(0, height - h));
          page.drawImage(sigEmbed, { x, y, width: w, height: h });
        }

        if (initialsDataUrl && initialsDataUrl.startsWith("data:image/") && initPlacements.length) {
          const initDecoded = decodeDataUrlImage(initialsDataUrl);
          if (initDecoded) {
            const initEmbed = initDecoded.mime === "image/png" ? await pdf.embedPng(initDecoded.bytes) : await pdf.embedJpg(initDecoded.bytes);
            for (const pl of initPlacements) {
              const initPage = parseInt(String(pl?.page || "1"), 10) || 1;
              const idx = clampV(initPage - 1, 0, pages.length - 1);
              const p2 = pages[idx];
              const { width, height } = p2.getSize();
              const xNorm = parseFloat(String(pl?.x ?? "0.70"));
              const yNorm = parseFloat(String(pl?.y ?? "0.80"));
              const wNorm = parseFloat(String(pl?.w ?? "0.10"));
              const hNorm = parseFloat(String(pl?.h ?? "0.05"));
              let w = clampV(wNorm, 0.005, 0.95) * width;
              let h = clampV(hNorm, 0.005, 0.95) * height;
              let x = clampV(xNorm, 0, 1) * width;
              let yTop = clampV(yNorm, 0, 1) * height;
              let y = height - yTop - h;
              x = clampV(x, 0, Math.max(0, width - w));
              y = clampV(y, 0, Math.max(0, height - h));
              p2.drawImage(initEmbed, { x, y, width: w, height: h });
            }
          }
        } else if (initialsText && initPlacements.length) {
          const font = await pdf.embedFont(StandardFonts.HelveticaBold);
          for (const pl of initPlacements) {
            const initPage = parseInt(String(pl?.page || "1"), 10) || 1;
            const idx = clampV(initPage - 1, 0, pages.length - 1);
            const p2 = pages[idx];
            const { width: pw, height: ph } = p2.getSize();
            const xNorm = parseFloat(String(pl?.x ?? "0.70"));
            const yNorm = parseFloat(String(pl?.y ?? "0.80"));
            let ix = clampV(xNorm, 0, 1) * pw;
            let iyTop = clampV(yNorm, 0, 1) * ph;
            let iy = ph - iyTop - 18;
            ix = clampV(ix, 0, Math.max(0, pw - 60));
            iy = clampV(iy, 0, Math.max(0, ph - 18));
            p2.drawText(initialsText, { x: ix, y: iy, size: 14, font, color: rgb(0, 0, 0) });
          }
        }
      } else {
        // Text fallback: draw signer name on last page bottom
        const font = await pdf.embedFont(StandardFonts.HelveticaBold);
        pages.forEach((page) => {
          const { width } = page.getSize();
          page.drawText(signer, { x: width * 0.08, y: 40, size: 12, font, color: rgb(0, 0, 0) });
        });
      }

      const out = await savePdf(pdf);
      res.setHeader("Content-Type", "application/pdf");
      res.send(out);
    } catch (err) {
      console.error("quick-sign error:", err);
      res.status(500).json({ error: "Quick Sign failed." });
    }
  }
);


// handleSimpleDoc — generate a simple PDF for invoice/receipt/paystub
async function handleSimpleDoc(type, req, res) {
  try {
    const data = req.body || {};
    const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const page = pdfDoc.addPage([612, 792]);
    const { width, height } = page.getSize();

    const label = type.charAt(0).toUpperCase() + type.slice(1);

    // Title
    page.drawText(label, {
      x: 50, y: height - 80,
      size: 28, font: boldFont, color: rgb(0.1, 0.1, 0.5)
    });

    // Horizontal rule
    page.drawLine({ start: { x: 50, y: height - 95 }, end: { x: width - 50, y: height - 95 }, thickness: 1.5, color: rgb(0.3, 0.3, 0.7) });

    let y = height - 130;
    const lineH = 22;

    // Helpers
    const drawRow = (label, value, bold = false) => {
      if (y < 80) return;
      page.drawText(String(label || ''), { x: 50, y, size: 11, font: bold ? boldFont : font, color: rgb(0.3, 0.3, 0.3) });
      page.drawText(String(value !== undefined && value !== null ? value : ''), { x: 220, y, size: 11, font, color: rgb(0.05, 0.05, 0.05) });
      y -= lineH;
    };
    const drawSectionTitle = (title) => {
      if (y < 80) return;
      y -= 6;
      page.drawText(title, { x: 50, y, size: 13, font: boldFont, color: rgb(0.1, 0.1, 0.5) });
      y -= lineH;
    };

    // Common fields
    if (data.title) drawRow('Title:', data.title, true);
    if (data.date || data.invoiceDate || data.receiptDate || data.paystubDate) {
      drawRow('Date:', data.date || data.invoiceDate || data.receiptDate || data.paystubDate);
    }
    if (data.number || data.invoiceNumber || data.receiptNumber) {
      drawRow('Number:', data.number || data.invoiceNumber || data.receiptNumber);
    }
    if (data.dueDate) drawRow('Due Date:', data.dueDate);

    // From / To
    if (data.from || data.fromName || data.companyName) {
      drawSectionTitle('From');
      drawRow('Name:', data.from || data.fromName || data.companyName);
      if (data.fromAddress) drawRow('Address:', data.fromAddress);
      if (data.fromEmail) drawRow('Email:', data.fromEmail);
    }
    if (data.to || data.toName || data.clientName || data.employeeName) {
      drawSectionTitle('To');
      drawRow('Name:', data.to || data.toName || data.clientName || data.employeeName);
      if (data.toAddress) drawRow('Address:', data.toAddress);
      if (data.toEmail) drawRow('Email:', data.toEmail);
    }

    // Paystub-specific
    if (type === 'paystub') {
      if (data.employer) drawRow('Employer:', data.employer);
      if (data.employee) drawRow('Employee:', data.employee);
      if (data.payPeriod) drawRow('Pay Period:', data.payPeriod);
      if (data.grossPay !== undefined) drawRow('Gross Pay:', '$' + Number(data.grossPay || 0).toFixed(2));
      if (data.deductions !== undefined) drawRow('Deductions:', '$' + Number(data.deductions || 0).toFixed(2));
      if (data.netPay !== undefined) drawRow('Net Pay:', '$' + Number(data.netPay || 0).toFixed(2), true);
    }

    // Line items
    const items = data.items || data.lineItems || [];
    if (Array.isArray(items) && items.length > 0) {
      drawSectionTitle('Items');
      let subtotal = 0;
      for (const item of items) {
        const desc = item.description || item.name || item.desc || '';
        const qty = item.quantity || item.qty || 1;
        const price = item.price || item.rate || item.amount || 0;
        const total = qty * price;
        subtotal += total;
        drawRow(desc, `${qty} x $${Number(price).toFixed(2)} = $${Number(total).toFixed(2)}`);
      }
      y -= 4;
      page.drawLine({ start: { x: 220, y: y + lineH - 4 }, end: { x: width - 50, y: y + lineH - 4 }, thickness: 0.5, color: rgb(0.7,0.7,0.7) });
      if (data.tax !== undefined || data.taxRate !== undefined) {
        const taxRate = data.taxRate || 0;
        const taxAmt = data.tax || (subtotal * taxRate / 100);
        drawRow('Subtotal:', '$' + subtotal.toFixed(2));
        drawRow('Tax:', '$' + Number(taxAmt).toFixed(2));
        subtotal += Number(taxAmt);
      }
      drawRow('Total:', '$' + (data.total !== undefined ? Number(data.total).toFixed(2) : subtotal.toFixed(2)), true);
    } else if (data.total !== undefined || data.amount !== undefined) {
      if (data.subtotal !== undefined) drawRow('Subtotal:', '$' + Number(data.subtotal).toFixed(2));
      if (data.tax !== undefined) drawRow('Tax:', '$' + Number(data.tax).toFixed(2));
      drawRow('Total:', '$' + Number(data.total || data.amount || 0).toFixed(2), true);
    }

    // Notes
    if (data.notes || data.memo || data.description) {
      y -= 8;
      drawSectionTitle('Notes');
      const notes = data.notes || data.memo || data.description;
      // Wrap text roughly
      const maxWidth = 80;
      const words = String(notes).split(' ');
      let line = '';
      for (const word of words) {
        if ((line + ' ' + word).length > maxWidth) {
          if (y < 80) break;
          page.drawText(line.trim(), { x: 50, y, size: 10, font, color: rgb(0.3, 0.3, 0.3) });
          y -= 16;
          line = word;
        } else {
          line += (line ? ' ' : '') + word;
        }
      }
      if (line.trim() && y >= 80) {
        page.drawText(line.trim(), { x: 50, y, size: 10, font, color: rgb(0.3, 0.3, 0.3) });
        y -= 16;
      }
    }

    // Footer
    page.drawText('Generated by PDFRealm', { x: 50, y: 40, size: 9, font, color: rgb(0.6, 0.6, 0.6) });

    const pdfBytes = await pdfDoc.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error('handleSimpleDoc error:', err);
    res.status(500).json({ error: 'Failed to generate ' + type + ' PDF.' });
  }
}


// Invoice/Receipt/Paystub
app.post("/api/invoice", (req, res, next) => requireExportAccess(req, res, next, "invoice"), (req, res) =>
  handleSimpleDoc("invoice", req, res)
);
app.post("/api/receipt", (req, res, next) => requireExportAccess(req, res, next, "receipt"), (req, res) =>
  handleSimpleDoc("receipt", req, res)
);
app.post("/api/paystub", (req, res, next) => requireExportAccess(req, res, next, "paystub"), (req, res) =>
  handleSimpleDoc("paystub", req, res)
);

// Preview stubs
app.post("/api/invoice/preview", (req, res) => res.json({ ok: true }));
app.post("/api/receipt/preview", (req, res) => res.json({ ok: true }));
app.post("/api/paystub/preview", (req, res) => res.json({ ok: true }));

// Merge
app.post(
  "/api/merge",
  upload.array("files"),
  (req, res, next) => requireExportAccess(req, res, next, "merge"),
  async (req, res) => {
    try {
      const files = req.files || [];
      if (!files.length) return res.status(400).json({ error: "No files." });

      const outDoc = await PDFDocument.create();
      for (const f of files) {
        const src = await PDFDocument.load(f.buffer);
        const pages = await outDoc.copyPages(src, src.getPageIndices());
        pages.forEach((p) => outDoc.addPage(p));
      }

      const out = await savePdf(outDoc);
      res.setHeader("Content-Type", "application/pdf");
      res.send(out);
    } catch (err) {
      console.error("merge error:", err);
      res.status(500).json({ error: "Merge failed." });
    }
  }
);

// Delete Page
app.post(
  "/api/delete-page",
  upload.single("file"),
  (req, res, next) => requireExportAccess(req, res, next, "delete-page"),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "File required." });
      const pageIndex = parseInt(req.body.page || "0", 10) - 1;
      if (isNaN(pageIndex) || pageIndex < 0) return res.status(400).json({ error: "Invalid page number." });

      const pdf = await loadPdfFromBuffer(req.file.buffer);
      const total = pdf.getPageCount();
      if (pageIndex >= total) return res.status(400).json({ error: "Page out of range." });

      pdf.removePage(pageIndex);
      const out = await savePdf(pdf);
      res.setHeader("Content-Type", "application/pdf");
      res.send(out);
    } catch (err) {
      console.error("delete-page error:", err);
      res.status(500).json({ error: "Delete page failed." });
    }
  }
);


// Delete Pages (supports encrypted PDFs + keeps output encrypted by default)
app.post(
  "/api/delete-pages",
  upload.single("file"),
  (req, res, next) => requireExportAccess(req, res, next, "delete-pages"),
  async (req, res) => {
    const tmpRoot = os.tmpdir();
    const stamp = Date.now() + "_" + Math.random().toString(16).slice(2);
    const tmpIn = path.join(tmpRoot, "pdfrealm_del_in_" + stamp + ".pdf");
    const tmpDec = path.join(tmpRoot, "pdfrealm_del_dec_" + stamp + ".pdf");
    const tmpEncIn = path.join(tmpRoot, "pdfrealm_del_enc_in_" + stamp + ".pdf");
    const tmpEncOut = path.join(tmpRoot, "pdfrealm_del_enc_out_" + stamp + ".pdf");

    try {
      if (!req.file || !req.file.buffer) return res.status(400).json({ error: "File required." });

      const pagesSpec = String(req.body.pages || req.body.ranges || "").trim();
      if (!pagesSpec) return res.status(400).json({ error: "Pages required (e.g., 2,4-6)." });

      const password = String(req.body.password || req.body.inputPassword || "");
      const outputPassword = String(req.body.outputPassword || "");

      fs.writeFileSync(tmpIn, req.file.buffer);

      let inputBuf = req.file.buffer;

      // Decrypt if password provided.
      if (password) {
        const qpdfPath = resolveQpdfPath();
        if (qpdfPath) {
          const q = runQpdf([`--password=${password}`, "--decrypt", "--", tmpIn, tmpDec], qpdfPath);
          if (q.status !== 0) {
            const stderr = (q.stderr || Buffer.from("")).toString();
            if (/invalid password/i.test(stderr) || /password.*invalid/i.test(stderr) || /password incorrect/i.test(stderr)) {
              return res.status(400).json({ error: "Invalid password for encrypted PDF." });
            }
            return res.status(500).json({ error: "qpdf decryption failed.", details: stderr });
          }
          inputBuf = fs.readFileSync(tmpDec);
        } else if (canRunGhostscript()) {
          const r = runGhostscript([
            "-q",
            "-dNOPAUSE",
            "-dBATCH",
            "-sDEVICE=pdfwrite",
            `-sOutputFile=${tmpDec}`,
            `-sPDFPassword=${password}`,
            tmpIn,
          ]);
          const stderr = (r.stderr || Buffer.from("")).toString();
          if (r.status !== 0) {
            return res.status(400).json({ error: "Decrypt failed (Ghostscript). Check password.", details: stderr });
          }
          inputBuf = fs.readFileSync(tmpDec);
        } else {
          return res.status(501).json({ error: "Encrypted PDFs require qpdf or Ghostscript on the server." });
        }
      }

      const src = await loadPdfFromBuffer(inputBuf);
      const total = src.getPageCount();

      // Parse pages to delete (1-based)
      const toDelete = new Set();
      function addPage(p) {
        if (p >= 1 && p <= total) toDelete.add(p);
      }

      for (const part of pagesSpec.split(",")) {
        const s = part.trim();
        if (!s) continue;
        if (s.includes("-")) {
          const [aRaw, bRaw] = s.split("-", 2);
          let a = parseInt(String(aRaw).trim(), 10);
          let b = parseInt(String(bRaw).trim(), 10);
          if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
          const start = Math.max(1, Math.min(a, b));
          const end = Math.min(total, Math.max(a, b));
          for (let p = start; p <= end; p++) addPage(p);
        } else {
          const p = parseInt(s, 10);
          if (Number.isFinite(p)) addPage(p);
        }
      }

      if (toDelete.size === 0) return res.status(400).json({ error: "No valid pages to delete." });
      if (toDelete.size >= total) return res.status(400).json({ error: "Cannot delete all pages." });

      const keepIndices = [];
      for (let p = 1; p <= total; p++) {
        if (!toDelete.has(p)) keepIndices.push(p - 1);
      }

      const outDoc = await PDFDocument.create();
      const pages = await outDoc.copyPages(src, keepIndices);
      pages.forEach((pg) => outDoc.addPage(pg));

      const outBuf = await savePdf(outDoc);

      const finalPass = outputPassword || password;
      if (finalPass) {
        const qpdfPath = resolveQpdfPath();
        if (qpdfPath) {
          fs.writeFileSync(tmpEncIn, outBuf);
          const q = runQpdf(["--encrypt", finalPass, finalPass, "256", "--", tmpEncIn, tmpEncOut], qpdfPath);
          const stderr = (q.stderr || Buffer.from("")).toString();
          if (q.status !== 0) {
            return res.status(500).json({ error: "Output encryption failed.", details: stderr });
          }
          const enc = fs.readFileSync(tmpEncOut);
          res.setHeader("Content-Type", "application/pdf");
          return res.send(enc);
        }

        if (canRunGhostscript()) {
          fs.writeFileSync(tmpEncIn, outBuf);
          const r = runGhostscript([
            "-q",
            "-dNOPAUSE",
            "-dBATCH",
            "-sDEVICE=pdfwrite",
            `-sOutputFile=${tmpEncOut}`,
            "-dEncryptionR=4",
            "-dKeyLength=256",
            `-sOwnerPassword=${finalPass}`,
            `-sUserPassword=${finalPass}`,
            tmpEncIn,
          ]);
          const stderr = (r.stderr || Buffer.from("")).toString();
          if (r.status !== 0) {
            return res.status(500).json({ error: "Output encryption failed (Ghostscript).", details: stderr });
          }
          const enc = fs.readFileSync(tmpEncOut);
          res.setHeader("Content-Type", "application/pdf");
          return res.send(enc);
        }
      }

      res.setHeader("Content-Type", "application/pdf");
      res.send(outBuf);
    } catch (err) {
      console.error("delete-pages error:", err);
      res.status(500).json({ error: "Delete pages failed.", details: String(err?.message || err) });
    } finally {
      for (const f of [tmpIn, tmpDec, tmpEncIn, tmpEncOut]) {
        try { fs.unlinkSync(f); } catch {}
      }
    }
  }
);


// Split / Extract
app.post(
  "/api/split",
  upload.single("file"),
  (req, res, next) => requireExportAccess(req, res, next, "split"),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "File required." });
      const ranges = (req.body.ranges || "").trim();
      if (!ranges) return res.status(400).json({ error: "Ranges required." });

      const src = await loadPdfFromBuffer(req.file.buffer);
      const total = src.getPageCount();

      const result = await PDFDocument.create();
      const indices = [];

      ranges.split(",").forEach((part) => {
        part = part.trim();
        if (!part) return;
        if (part.includes("-")) {
          const [a, b] = part.split("-").map((n) => parseInt(n, 10));
          if (isNaN(a) || isNaN(b)) return;
          const start = Math.max(1, Math.min(a, b));
          const end = Math.min(total, Math.max(a, b));
          for (let i = start; i <= end; i++) indices.push(i - 1);
        } else {
          const p = parseInt(part, 10);
          if (!isNaN(p) && p >= 1 && p <= total) indices.push(p - 1);
        }
      });

      const copyPages = await result.copyPages(src, indices);
      copyPages.forEach((p) => result.addPage(p));

      const out = await savePdf(result);
      res.setHeader("Content-Type", "application/pdf");
      res.send(out);
    } catch (err) {
      console.error("split error:", err);
      res.status(500).json({ error: "Split failed." });
    }
  }
);


// Compress (Ghostscript if available; qpdf fallback)
app.post(
  "/api/compress",
  upload.single("file"),
  (req, res, next) => requireExportAccess(req, res, next, "compress"),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "File required." });

      // Quick header sanity check
      try {
        const head = req.file.buffer.slice(0, 8).toString("latin1");
        if (!head.startsWith("%PDF")) return res.status(400).json({ error: "Input is not a valid PDF." });
      } catch {}

      const presetRaw = String(req.body.preset || req.body.quality || "ebook").trim().toLowerCase();
      const gsPresetMap = { screen: "/screen", ebook: "/ebook", printer: "/printer", prepress: "/prepress" };
      const gsSetting = gsPresetMap[presetRaw] || "/ebook";

      const tmpIn = tmpPdfPath("pdfrealm_compress_in");
      const tmpOut = tmpPdfPath("pdfrealm_compress_out");

      try {
        fs.writeFileSync(tmpIn, req.file.buffer);

        if (canRunGhostscript()) {
          const r = runGhostscript([
            "-dNOPAUSE",
            "-dBATCH",
            "-dSAFER",
            "-sDEVICE=pdfwrite",
            "-dCompatibilityLevel=1.4",
            `-dPDFSETTINGS=${gsSetting}`,
            "-dDetectDuplicateImages=true",
            "-dCompressFonts=true",
            "-dSubsetFonts=true",
            "-dAutoRotatePages=/None",
            `-sOutputFile=${tmpOut}`,
            tmpIn,
          ]);
          if (r.status !== 0) {
            const msg = ((r.stderr || Buffer.from("")).toString() || (r.stdout || Buffer.from("")).toString()).trim();
            throw new Error("Ghostscript compress failed" + (msg ? ": " + msg.slice(0, 500) : ""));
          }
        } else {
          const qpdfPath = resolveQpdfPath();
          if (!qpdfPath) {
            // No qpdf and no gs: best effort pass-through
            res.setHeader("Content-Type", "application/pdf");
            return res.send(req.file.buffer);
          }

          const q = runQpdf(
            [
              "--stream-data=compress",
              "--object-streams=generate",
              "--compression-level=9",
              "--linearize",
              "--",
              tmpIn,
              tmpOut,
            ],
            qpdfPath
          );

          if (q.status == null || q.status !== 0) {
            const msg = ((q.stderr || Buffer.from("")).toString() || (q.stdout || Buffer.from("")).toString()).trim();
            throw new Error("qpdf compress failed" + (msg ? ": " + msg.slice(0, 500) : ""));
          }
        }

        const out = fs.readFileSync(tmpOut);
        res.setHeader("Content-Type", "application/pdf");
        res.send(out);
      } finally {
        try { fs.unlinkSync(tmpIn); } catch {}
        try { fs.unlinkSync(tmpOut); } catch {}
      }
    } catch (err) {
      console.error("compress error:", err);
      res.status(500).json({ error: "Compress failed.", details: String(err?.message || err) });
    }
  }
);

// Rotate
app.post(
  "/api/rotate",
  upload.single("file"),
  (req, res, next) => requireExportAccess(req, res, next, "rotate"),
  async (req, res) => {
    const tmpRoot = os.tmpdir();
    const stamp = Date.now() + "_" + Math.random().toString(16).slice(2);
    const tmpIn = path.join(tmpRoot, "pdfrealm_rotate_in_" + stamp + ".pdf");
    const tmpDec = path.join(tmpRoot, "pdfrealm_rotate_dec_" + stamp + ".pdf");
    const tmpOut = path.join(tmpRoot, "pdfrealm_rotate_out_" + stamp + ".pdf");
    const tmpEnc = path.join(tmpRoot, "pdfrealm_rotate_enc_" + stamp + ".pdf");

    try {
      const file = req.file;
      if (!file || !file.buffer) return res.status(400).json({ error: "File required." });

      const password = String(req.body.password || req.body.inputPassword || "");
      const outputPassword = String(req.body.outputPassword || "");

      let degreesRaw = parseInt(String(req.body.degrees || "90"), 10);
      if (!Number.isFinite(degreesRaw)) degreesRaw = 90;
      let rot = ((degreesRaw % 360) + 360) % 360;
      if (rot % 90 !== 0) rot = Math.round(rot / 90) * 90;
      rot = ((rot % 360) + 360) % 360;

      const pagesSpec = String(req.body.pages || "").trim();

      fs.writeFileSync(tmpIn, file.buffer);

      let inputBuf = file.buffer;

      if (password) {
        const qpdfPath = resolveQpdfPath();
        if (!qpdfPath) return res.status(501).json({ error: "Encrypted PDFs require qpdf installed on the server." });

        const q = runQpdf([`--password=${password}`, "--decrypt", "--", tmpIn, tmpDec], qpdfPath);
        if (q.status !== 0) {
          const err = (q.stderr || Buffer.from("")).toString().toLowerCase();
          if (err.includes("invalid password") || err.includes("password incorrect")) {
            return res.status(400).json({ error: "Invalid password for encrypted PDF." });
          }
          return res.status(400).json({ error: "Could not decrypt PDF." });
        }
        inputBuf = fs.readFileSync(tmpDec);
      }

      const pdfDoc = await loadPdfFromBuffer(inputBuf);
      const pageCount = pdfDoc.getPageCount();

      const toRotate = new Set();

      function addPage(p) {
        if (p >= 1 && p <= pageCount) toRotate.add(p);
      }

      if (!pagesSpec) {
        for (let p = 1; p <= pageCount; p++) addPage(p);
      } else {
        for (const part of pagesSpec.split(",")) {
          const s = part.trim();
          if (!s) continue;
          if (s.includes("-")) {
            const bits = s.split("-", 2);
            let a = parseInt(bits[0].trim(), 10);
            let b = parseInt(bits[1].trim(), 10);
            if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
            if (a > b) {
              const t = a;
              a = b;
              b = t;
            }
            for (let p = a; p <= b; p++) addPage(p);
          } else {
            const pnum = parseInt(s, 10);
            if (Number.isFinite(pnum)) addPage(pnum);
          }
        }
      }

      for (const pnum of toRotate) {
        const page = pdfDoc.getPage(pnum - 1);
        const existing = page.getRotation() && typeof page.getRotation().angle === "number" ? page.getRotation().angle : 0;
        const newAngle = ((existing + rot) % 360 + 360) % 360;
        page.setRotation(degrees(newAngle));
      }

      const outBuf = await savePdf(pdfDoc);

      let finalBuf = outBuf;
      const finalPass = outputPassword || (password ? password : "");
      if (finalPass) {
        const qpdfPath = resolveQpdfPath();
        if (!qpdfPath) return res.status(501).json({ error: "Output encryption requires qpdf installed on the server." });

        fs.writeFileSync(tmpOut, outBuf);
        const enc = runQpdf(["--encrypt", finalPass, finalPass, "256", "--", tmpOut, tmpEnc], qpdfPath);
        if (enc.status !== 0) return res.status(500).json({ error: "Could not encrypt rotated PDF." });

        finalBuf = fs.readFileSync(tmpEnc);
      }

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", 'attachment; filename="pdfrealm-rotated.pdf"');
      return res.send(finalBuf);
    } catch (e) {
      console.error("rotate error:", e);
      return res.status(500).json({ error: "Rotate failed." });
    } finally {
      try { if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn); } catch {}
      try { if (fs.existsSync(tmpDec)) fs.unlinkSync(tmpDec); } catch {}
      try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch {}
      try { if (fs.existsSync(tmpEnc)) fs.unlinkSync(tmpEnc); } catch {}
    }
  }
);


// Reorder
app.post(
  "/api/reorder",
  upload.single("file"),
  (req, res, next) => requireExportAccess(req, res, next, "reorder"),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "File required." });
      const orderStr = (req.body.order || "").trim();
      if (!orderStr) return res.status(400).json({ error: "Order string required." });

      const src = await loadPdfFromBuffer(req.file.buffer);
      const total = src.getPageCount();
      const result = await PDFDocument.create();

      const indices = orderStr
        .split(",")
        .map((s) => parseInt(s.trim(), 10) - 1)
        .filter((i) => !isNaN(i) && i >= 0 && i < total);

      const pages = await result.copyPages(src, indices);
      pages.forEach((p) => result.addPage(p));

      const out = await savePdf(result);
      res.setHeader("Content-Type", "application/pdf");
      res.send(out);
    } catch (err) {
      console.error("reorder error:", err);
      res.status(500).json({ error: "Reorder failed." });
    }
  }
);

// Watermark
app.post(
  "/api/watermark",
  upload.single("file"),
  (req, res, next) => requireExportAccess(req, res, next, "watermark"),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "File required." });
      const text = (req.body.text || "CONFIDENTIAL").trim();

      const pdf = await loadPdfFromBuffer(req.file.buffer);
      const pages = pdf.getPages();
      const font = await pdf.embedFont(StandardFonts.HelveticaBold);

      pages.forEach((page) => {
        const { width, height } = page.getSize();
        page.drawText(text, {
          x: width / 4,
          y: height / 2,
          size: 40,
          font,
          color: rgb(0.8, 0.8, 0.8),
          rotate: degrees(45),
          opacity: 0.3,
        });
      });

      const out = await savePdf(pdf);
      res.setHeader("Content-Type", "application/pdf");
      res.send(out);
    } catch (err) {
      console.error("watermark error:", err);
      res.status(500).json({ error: "Watermark failed." });
    }
  }
);

// Metadata remove/apply
app.post(
  "/api/meta/remove",
  upload.single("file"),
  (req, res, next) => requireExportAccess(req, res, next, "meta-remove"),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "File required." });
      const pdf = await loadPdfFromBuffer(req.file.buffer);
      pdf.setTitle("");
      pdf.setAuthor("");
      pdf.setSubject("");
      pdf.setKeywords([]);
      const out = await savePdf(pdf);
      res.setHeader("Content-Type", "application/pdf");
      res.send(out);
    } catch (err) {
      console.error("meta/remove error:", err);
      res.status(500).json({ error: "Metadata remove failed." });
    }
  }
);

app.post(
  "/api/meta/apply",
  upload.single("file"),
  (req, res, next) => requireExportAccess(req, res, next, "meta-apply"),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "File required." });
      const pdf = await loadPdfFromBuffer(req.file.buffer);
      if (req.body.title) pdf.setTitle(req.body.title);
      if (req.body.author) pdf.setAuthor(req.body.author);
      if (req.body.subject) pdf.setSubject(req.body.subject);
      if (req.body.keywords) pdf.setKeywords(String(req.body.keywords).split(",").map((s) => s.trim()));
      const out = await savePdf(pdf);
      res.setHeader("Content-Type", "application/pdf");
      res.send(out);
    } catch (err) {
      console.error("meta/apply error:", err);
      res.status(500).json({ error: "Metadata apply failed." });
    }
  }
);


// Flatten (AcroForm) — makes form fields uneditable
app.post(
  "/api/flatten",
  upload.single("file"),
  (req, res, next) => requireExportAccess(req, res, next, "flatten"),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "File required." });

      const pdf = await loadPdfFromBuffer(req.file.buffer);
      try {
        const form = pdf.getForm();
        form.flatten();
      } catch {
        // No form present; treat as success
      }
      const out = await savePdf(pdf);
      res.setHeader("Content-Type", "application/pdf");
      res.send(out);
    } catch (err) {
      console.error("flatten error:", err);
      res.status(500).json({ error: "Flatten failed." });
    }
  }
);


// Rasterize PDF (image-only PDF via Ghostscript when available)
app.post(
  "/api/rasterize",
  upload.single("file"),
  (req, res, next) => requireExportAccess(req, res, next, "rasterize"),
  async (req, res) => {
    let tmpIn = null;
    let tmpOut = null;
    try {
      if (!req.file) return res.status(400).json({ error: "File required." });
      if (!canRunGhostscript()) return res.status(501).json({ error: "Ghostscript not available on server." });

      const dpiRaw = parseInt(String(req.body.dpi || "150"), 10);
      const dpi = Math.max(72, Math.min(600, isNaN(dpiRaw) ? 150 : dpiRaw));

      tmpIn = tmpPdfPath("rasterize_in");
      tmpOut = tmpPdfPath("rasterize_out");

      fs.writeFileSync(tmpIn, req.file.buffer);

      const args = [
        "-dSAFER",
        "-dBATCH",
        "-dNOPAUSE",
        "-dQUIET",
        "-dNOPROMPT",
        "-sDEVICE=pdfimage24",
        "-dPDFSTOPONERROR",
        "-dDetectDuplicateImages=true",
        "-dCompressFonts=true",
        "-dSubsetFonts=true",
        "-dAutoRotatePages=/None",
        "-r" + String(dpi),
        "-sOutputFile=" + tmpOut,
        tmpIn,
      ];

      const r = runGhostscript(args);
      if (!r || r.status !== 0) {
        const details = (r && r.stderr) ? String(r.stderr) : "";
        return res.status(500).json({ error: "Rasterize failed.", details: details.slice(0, 6000) });
      }

      const out = fs.readFileSync(tmpOut);
      res.setHeader("Content-Type", "application/pdf");
      res.send(out);
    } catch (err) {
      console.error("rasterize error:", err);
      res.status(500).json({ error: "Rasterize failed." });
    } finally {
      try { if (tmpIn) fs.unlinkSync(tmpIn); } catch {}
      try { if (tmpOut) fs.unlinkSync(tmpOut); } catch {}
    }
  }
);
// Remove blank pages (Ghostscript ink coverage when available; conservative fallback)
app.post(
  "/api/remove-blank-pages",
  upload.single("file"),
  (req, res, next) => requireExportAccess(req, res, next, "remove-blank-pages"),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "File required." });

      // threshold for ink coverage (0..1). default is very small.
      const thr = Number(req.body.threshold ?? 0.00005);
      const threshold = isFinite(thr) ? Math.max(0, thr) : 0.00005;

      const tmpIn = tmpPdfPath("pdfrealm_blank_in");
      try {
        fs.writeFileSync(tmpIn, req.file.buffer);

        const srcPdf = await loadPdfFromBuffer(req.file.buffer);
        const total = srcPdf.getPageCount();
        if (total <= 1) {
          // no-op for single-page docs
          const out = await savePdf(srcPdf);
          res.setHeader("Content-Type", "application/pdf");
          return res.send(out);
        }

        const blankIdx = new Set();

        if (canRunGhostscript()) {
          const r = runGhostscript(["-q", "-o", "-", "-sDEVICE=inkcov", tmpIn]);
          const outTxt = ((r.stdout || Buffer.from("")).toString() + String.fromCharCode(10) + (r.stderr || Buffer.from("")).toString());

          for (const line of outTxt.split(String.fromCharCode(10))) {
            const m = line.match(/Page\s+(\d+)\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)/i);
            if (!m) continue;
            const p = parseInt(m[1]);
            if (!p) continue;
            const c = parseFloat(m[2]);
            const m2 = parseFloat(m[3]);
            const y = parseFloat(m[4]);
            const k = parseFloat(m[5]);
            const sum = c+m2+y+k;
            if (sum <= threshold) blankIdx.add(p-1);
          }
        } else {
          // Conservative fallback: remove pages with no content streams
          const pages = srcPdf.getPages();
          for (let i = 0; i < pages.length; i++) {
            try {
              const node = pages[i].node;
              const c = node && node.Contents && node.Contents();
              if (!c) blankIdx.add(i);
            } catch {}
          }
        }

        if (!blankIdx.size) {
          // nothing detected; return original
          const out = await savePdf(srcPdf);
          res.setHeader("Content-Type", "application/pdf");
          return res.send(out);
        }

        const outPdf = await PDFDocument.create();
        const keep = [];
        for (let i = 0; i < total; i++) {
          if (!blankIdx.has(i)) keep.push(i);
        }

        if (!keep.length) {
          // never return empty PDF; keep first page
          keep.push(0);
        }

        const copied = await outPdf.copyPages(srcPdf, keep);
        copied.forEach((p) => outPdf.addPage(p));

        const out = await savePdf(outPdf);
        res.setHeader("Content-Type", "application/pdf");
        res.send(out);
      } finally {
        try { fs.unlinkSync(tmpIn); } catch {}
      }
    } catch (err) {
      console.error("remove-blank-pages error:", err);
      res.status(500).json({ error: "Remove blank pages failed." });
    }
  }
);




// -------------------- PDFREALM_PREMIUM_EMBED_MEDIA_V1 --------------------
// Embed Image/Audio/Video into a PDF.
// Notes:
// - Image: drawn onto a chosen page (PNG/JPG).
// - Audio/Video: embedded as an attachment + optional label drawn on a chosen page.
// - Preview endpoints are free (watermarked). Export endpoints are paywalled via requireExportAccess.

function _clamp(n, lo, hi, dflt) {
  const x = Number(n);
  if (!isFinite(x)) return dflt;
  return Math.max(lo, Math.min(hi, x));
}

async function _applyPreviewWatermark(pdf, text = 'PREVIEW — Purchase export to remove') {
  try {
    const font = await pdf.embedFont(StandardFonts.HelveticaBold);
    const pages = pdf.getPages();
    const label = String(text || '').slice(0, 120);
    for (const page of pages) {
      const { width, height } = page.getSize();
      // Diagonal watermark
      const size = Math.max(22, Math.min(72, Math.floor(Math.min(width, height) / 18)));
      const x = width * 0.12;
      const y = height * 0.52;
      page.drawText(label, {
        x,
        y,
        size,
        font,
        color: rgb(0.75, 0.75, 0.75),
        rotate: degrees(35),
        opacity: 0.35,
      });
    }
  } catch {
    // watermark is best-effort
  }
}

async function _embedImageIntoPdf({ pdfBytes, imgBytes, imgType, pageNum, xNorm, yNorm, wNorm, opacity }) {
  const pdf = await loadPdfFromBuffer(pdfBytes);
  const pages = pdf.getPages();
  const idx = Math.max(0, Math.min(pages.length - 1, (pageNum|0) - 1));
  const page = pages[idx];
  const { width, height } = page.getSize();

  let embedded;
  if (imgType === 'png') embedded = await pdf.embedPng(imgBytes);
  else embedded = await pdf.embedJpg(imgBytes);

  const imgW = embedded.width;
  const imgH = embedded.height;

  const targetW = _clamp(wNorm, 0.05, 1.0, 0.35) * width;
  const scale = targetW / imgW;
  const targetH = imgH * scale;

  const x = _clamp(xNorm, 0, 1, 0.1) * (width - targetW);
  const y = _clamp(yNorm, 0, 1, 0.1) * (height - targetH);

  page.drawImage(embedded, {
    x,
    y,
    width: targetW,
    height: targetH,
    opacity: _clamp(opacity, 0.05, 1.0, 1.0),
  });

  const out = await savePdf(pdf);
  return out;
}

async function _attachMediaToPdf({ pdfBytes, mediaBytes, filename, mimeType, pageNum, label }) {
  const pdf = await loadPdfFromBuffer(pdfBytes);
  try {
    // pdf-lib: embed as an attachment
    pdf.attach(mediaBytes, filename || 'media.bin', {
      mimeType: mimeType || undefined,
      description: label ? String(label).slice(0, 200) : undefined,
      creationDate: new Date(),
      modificationDate: new Date(),
    });
  } catch (e) {
    // Some older pdf-lib builds may not support attach; fail with a clear message.
    const msg = String(e?.message || e);
    throw new Error('Embedding attachments is not supported by this server build (pdf-lib attach missing). ' + msg);
  }

  // Optional visible label on a page
  if (pageNum) {
    const pages = pdf.getPages();
    const idx = Math.max(0, Math.min(pages.length - 1, (pageNum|0) - 1));
    const page = pages[idx];
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const { width, height } = page.getSize();
    const pad = 10;
    const text = (label || '').trim() ? String(label).slice(0, 120) : ('Embedded attachment: ' + String(filename || 'media'));
    const size = 10;
    const boxW = Math.min(width - 40, Math.max(240, font.widthOfTextAtSize(text, size) + 2*pad));
    const boxH = 28;
    const x = 20;
    const y = height - boxH - 20;
    page.drawRectangle({ x, y, width: boxW, height: boxH, color: rgb(0.97, 0.97, 0.97), borderColor: rgb(0.8, 0.8, 0.8), borderWidth: 1, opacity: 0.95 });
    page.drawText(text, { x: x + pad, y: y + 9, size, font, color: rgb(0.15, 0.15, 0.15) });
  }

  const out = await savePdf(pdf);
  return out;
}

// ---- Embed Image (Preview: watermarked) ----
app.post(
  '/api/embed/image/preview',
  upload.fields([{ name: 'pdf', maxCount: 1 }, { name: 'image', maxCount: 1 }]),
  async (req, res) => {
    try {
      const pdfFile = req.files?.pdf?.[0];
      const imgFile = req.files?.image?.[0];
      if (!pdfFile) return res.status(400).json({ error: 'PDF file required.' });
      if (!imgFile) return res.status(400).json({ error: 'Image file required.' });

      const mime = String(imgFile.mimetype || '').toLowerCase();
      const imgType = mime.includes('png') ? 'png' : (mime.includes('jpeg') || mime.includes('jpg')) ? 'jpg' : null;
      if (!imgType) return res.status(400).json({ error: 'Unsupported image type. Use PNG or JPG.' });

      const page = parseInt(String(req.body.page || '1'), 10) || 1;
      const x = _clamp(req.body.x, 0, 1, 0.1);
      const y = _clamp(req.body.y, 0, 1, 0.1);
      const w = _clamp(req.body.w, 0.05, 1, 0.35);
      const opacity = _clamp(req.body.opacity, 0.05, 1, 1);

      const outBytes = await _embedImageIntoPdf({
        pdfBytes: pdfFile.buffer,
        imgBytes: imgFile.buffer,
        imgType,
        pageNum: page,
        xNorm: x,
        yNorm: y,
        wNorm: w,
        opacity,
      });

      const pdf = await loadPdfFromBuffer(outBytes);
      await _applyPreviewWatermark(pdf);
      const out = await savePdf(pdf);

      res.setHeader('Content-Type', 'application/pdf');
      res.send(out);
    } catch (err) {
      console.error('embed/image/preview error:', err);
      res.status(500).json({ error: err?.message || 'Embed image preview failed.' });
    }
  }
);

// ---- Embed Image (Export: paywalled) ----
app.post(
  '/api/embed/image',
  upload.fields([{ name: 'pdf', maxCount: 1 }, { name: 'image', maxCount: 1 }]),
  (req, res, next) => requireExportAccess(req, res, next, 'embed-image'),
  async (req, res) => {
    try {
      const pdfFile = req.files?.pdf?.[0];
      const imgFile = req.files?.image?.[0];
      if (!pdfFile) return res.status(400).json({ error: 'PDF file required.' });
      if (!imgFile) return res.status(400).json({ error: 'Image file required.' });

      const mime = String(imgFile.mimetype || '').toLowerCase();
      const imgType = mime.includes('png') ? 'png' : (mime.includes('jpeg') || mime.includes('jpg')) ? 'jpg' : null;
      if (!imgType) return res.status(400).json({ error: 'Unsupported image type. Use PNG or JPG.' });

      const page = parseInt(String(req.body.page || '1'), 10) || 1;
      const x = _clamp(req.body.x, 0, 1, 0.1);
      const y = _clamp(req.body.y, 0, 1, 0.1);
      const w = _clamp(req.body.w, 0.05, 1, 0.35);
      const opacity = _clamp(req.body.opacity, 0.05, 1, 1);

      const out = await _embedImageIntoPdf({
        pdfBytes: pdfFile.buffer,
        imgBytes: imgFile.buffer,
        imgType,
        pageNum: page,
        xNorm: x,
        yNorm: y,
        wNorm: w,
        opacity,
      });

      res.setHeader('Content-Type', 'application/pdf');
      res.send(out);
    } catch (err) {
      console.error('embed/image error:', err);
      res.status(500).json({ error: err?.message || 'Embed image failed.' });
    }
  }
);

function _pickMediaType(mime, fallback) {
  const m = String(mime || '').toLowerCase();
  if (!m) return fallback;
  return m;
}

// ---- Embed Audio (Preview) ----
app.post(
  '/api/embed/audio/preview',
  upload.fields([{ name: 'pdf', maxCount: 1 }, { name: 'audio', maxCount: 1 }]),
  async (req, res) => {
    try {
      const pdfFile = req.files?.pdf?.[0];
      const media = req.files?.audio?.[0];
      if (!pdfFile) return res.status(400).json({ error: 'PDF file required.' });
      if (!media) return res.status(400).json({ error: 'Audio file required.' });

      const page = parseInt(String(req.body.page || '1'), 10) || 1;
      const label = (req.body.label || '').toString();

      const outBytes = await _attachMediaToPdf({
        pdfBytes: pdfFile.buffer,
        mediaBytes: media.buffer,
        filename: media.originalname || 'audio',
        mimeType: _pickMediaType(media.mimetype, 'audio/mpeg'),
        pageNum: page,
        label: label || ('Embedded audio: ' + String(media.originalname || 'audio')),
      });

      const pdf = await loadPdfFromBuffer(outBytes);
      await _applyPreviewWatermark(pdf);
      const out = await savePdf(pdf);

      res.setHeader('Content-Type', 'application/pdf');
      res.send(out);
    } catch (err) {
      console.error('embed/audio/preview error:', err);
      res.status(500).json({ error: err?.message || 'Embed audio preview failed.' });
    }
  }
);

// ---- Embed Audio (Export) ----
app.post(
  '/api/embed/audio',
  upload.fields([{ name: 'pdf', maxCount: 1 }, { name: 'audio', maxCount: 1 }]),
  (req, res, next) => requireExportAccess(req, res, next, 'embed-audio'),
  async (req, res) => {
    try {
      const pdfFile = req.files?.pdf?.[0];
      const media = req.files?.audio?.[0];
      if (!pdfFile) return res.status(400).json({ error: 'PDF file required.' });
      if (!media) return res.status(400).json({ error: 'Audio file required.' });

      const page = parseInt(String(req.body.page || '1'), 10) || 1;
      const label = (req.body.label || '').toString();

      const out = await _attachMediaToPdf({
        pdfBytes: pdfFile.buffer,
        mediaBytes: media.buffer,
        filename: media.originalname || 'audio',
        mimeType: _pickMediaType(media.mimetype, 'audio/mpeg'),
        pageNum: page,
        label: label || ('Embedded audio: ' + String(media.originalname || 'audio')),
      });

      res.setHeader('Content-Type', 'application/pdf');
      res.send(out);
    } catch (err) {
      console.error('embed/audio error:', err);
      res.status(500).json({ error: err?.message || 'Embed audio failed.' });
    }
  }
);

// ---- Embed Video (Preview) ----
app.post(
  '/api/embed/video/preview',
  upload.fields([{ name: 'pdf', maxCount: 1 }, { name: 'video', maxCount: 1 }]),
  async (req, res) => {
    try {
      const pdfFile = req.files?.pdf?.[0];
      const media = req.files?.video?.[0];
      if (!pdfFile) return res.status(400).json({ error: 'PDF file required.' });
      if (!media) return res.status(400).json({ error: 'Video file required.' });

      const page = parseInt(String(req.body.page || '1'), 10) || 1;
      const label = (req.body.label || '').toString();

      const outBytes = await _attachMediaToPdf({
        pdfBytes: pdfFile.buffer,
        mediaBytes: media.buffer,
        filename: media.originalname || 'video',
        mimeType: _pickMediaType(media.mimetype, 'video/mp4'),
        pageNum: page,
        label: label || ('Embedded video: ' + String(media.originalname || 'video')),
      });

      const pdf = await loadPdfFromBuffer(outBytes);
      await _applyPreviewWatermark(pdf);
      const out = await savePdf(pdf);

      res.setHeader('Content-Type', 'application/pdf');
      res.send(out);
    } catch (err) {
      console.error('embed/video/preview error:', err);
      res.status(500).json({ error: err?.message || 'Embed video preview failed.' });
    }
  }
);

// ---- Embed Video (Export) ----
app.post(
  '/api/embed/video',
  upload.fields([{ name: 'pdf', maxCount: 1 }, { name: 'video', maxCount: 1 }]),
  (req, res, next) => requireExportAccess(req, res, next, 'embed-video'),
  async (req, res) => {
    try {
      const pdfFile = req.files?.pdf?.[0];
      const media = req.files?.video?.[0];
      if (!pdfFile) return res.status(400).json({ error: 'PDF file required.' });
      if (!media) return res.status(400).json({ error: 'Video file required.' });

      const page = parseInt(String(req.body.page || '1'), 10) || 1;
      const label = (req.body.label || '').toString();

      const out = await _attachMediaToPdf({
        pdfBytes: pdfFile.buffer,
        mediaBytes: media.buffer,
        filename: media.originalname || 'video',
        mimeType: _pickMediaType(media.mimetype, 'video/mp4'),
        pageNum: page,
        label: label || ('Embedded video: ' + String(media.originalname || 'video')),
      });

      res.setHeader('Content-Type', 'application/pdf');
      res.send(out);
    } catch (err) {
      console.error('embed/video error:', err);
      res.status(500).json({ error: err?.message || 'Embed video failed.' });
    }
  }
);
// ------------------ /PDFREALM_PREMIUM_EMBED_MEDIA_V1 ------------------
// Metadata sanitize (deep rebuild: copies pages into a new PDF)
app.post(
  "/api/meta/sanitize",
  upload.single("file"),
  (req, res, next) => requireExportAccess(req, res, next, "meta-sanitize"),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "File required." });

      const srcPdf = await loadPdfFromBuffer(req.file.buffer);
      const outPdf = await PDFDocument.create();

      const indices = srcPdf.getPageIndices();
      const copied = await outPdf.copyPages(srcPdf, indices);
      copied.forEach((p) => outPdf.addPage(p));

      // Clear common metadata fields
      outPdf.setTitle("");
      outPdf.setAuthor("");
      outPdf.setSubject("");
      outPdf.setKeywords([]);

      const out = await savePdf(outPdf);
      res.setHeader("Content-Type", "application/pdf");
      res.send(out);
    } catch (err) {
      console.error("meta/sanitize error:", err);
      res.status(500).json({ error: "Metadata sanitize failed." });
    }
  }
);
// Page numbers
app.post(
  "/api/page-numbers",
  upload.single("file"),
  (req, res, next) => requireExportAccess(req, res, next, "page-numbers"),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "File required." });
      const start = parseInt(req.body.start || "1", 10) || 1;
      const prefix = req.body.prefix || "";

      const size = Math.max(6, Math.min(72, parseFloat(String(req.body.size || "10")) || 10));
      const pos = String(req.body.pos || "br").toLowerCase();
      const margin = Math.max(0, Math.min(200, parseFloat(String(req.body.margin || "30")) || 30));

      const pdf = await loadPdfFromBuffer(req.file.buffer);
      const pages = pdf.getPages();
      const font = await pdf.embedFont(StandardFonts.Helvetica);

      pages.forEach((page, i) => {
        const { width, height } = page.getSize();
        const n = start + i;
        const label = String(prefix || "") + String(n);

        const textWidth = font.widthOfTextAtSize(label, size);
        let x = width - margin - textWidth;
        let y = margin;

        if (pos === "bl") { x = margin; y = margin; }
        else if (pos === "tl") { x = margin; y = height - margin - size; }
        else if (pos === "tr") { x = width - margin - textWidth; y = height - margin - size; }
        else { x = width - margin - textWidth; y = margin; }

        page.drawText(label, { x, y, size, font, color: rgb(0.2, 0.2, 0.2) });
      });
const out = await savePdf(pdf);
      res.setHeader("Content-Type", "application/pdf");
      res.send(out);
    } catch (err) {
      console.error("page-numbers error:", err);
      res.status(500).json({ error: "Page numbers failed." });
    }
  }
);

// Stamp
app.post(
  "/api/stamp",
  upload.single("file"),
  (req, res, next) => requireExportAccess(req, res, next, "stamp"),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "File required." });
      const text = (req.body.text || "PAID").trim();

      const pdf = await loadPdfFromBuffer(req.file.buffer);
      const pages = pdf.getPages();
      const font = await pdf.embedFont(StandardFonts.HelveticaBold);

      pages.forEach((p) => {
        const { width } = p.getSize();
        p.drawText(text, { x: width * 0.1, y: 60, size: 18, font, color: rgb(0, 0.5, 0) });
      });

      const out = await savePdf(pdf);
      res.setHeader("Content-Type", "application/pdf");
      res.send(out);
    } catch (err) {
      console.error("stamp error:", err);
      res.status(500).json({ error: "Stamp failed." });
    }
  }
);

// Redact
app.post(
  "/api/redact",
  upload.single("file"),
  (req, res, next) => requireExportAccess(req, res, next, "redact"),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "File required." });
      const boxes = String(req.body.boxes || "").trim();
      if (!boxes) return res.status(400).json({ error: "Boxes required." });

      const pdf = await loadPdfFromBuffer(req.file.buffer);
      const pages = pdf.getPages();

      const lines = boxes.split("\n").map((l) => l.trim()).filter(Boolean);
      lines.forEach((line) => {
        const [pageStr, nxStr, nyStr, nwStr, nhStr] = line.split(",");
        const pageIndex = parseInt(pageStr.trim(), 10) - 1;
        if (isNaN(pageIndex) || pageIndex < 0 || pageIndex >= pages.length) return;

        const page = pages[pageIndex];
        const { width, height } = page.getSize();

        const nx = parseFloat(nxStr);
        const ny = parseFloat(nyStr);
        const nw = parseFloat(nwStr);
        const nh = parseFloat(nhStr);
        if ([nx, ny, nw, nh].some((v) => isNaN(v))) return;

        const x = nx * width;
        const y = height - (ny + nh) * height;
        const w = nw * width;
        const h = nh * height;

        page.drawRectangle({ x, y, width: w, height: h, color: rgb(0, 0, 0) });
      });

      const out = await savePdf(pdf);
      res.setHeader("Content-Type", "application/pdf");
      res.send(out);
    } catch (err) {
      console.error("redact error:", err);
      res.status(500).json({ error: "Redact failed." });
    }
  }
);


  // -------------------- NEXT 5 TOOLS (Repair / Resize) --------------------

  // Repair PDF: attempt a clean rewrite using pdf-lib.
  app.post(
    "/api/repair",
    upload.single("file"),
    (req, res, next) => requireExportAccess(req, res, next, "repair"),
    async (req, res) => {
      try {
        if (!req.file) return res.status(400).json({ error: "File required." });
        const pdf = await loadPdfFromBuffer(req.file.buffer);

        // Normalize minimal metadata (optional)
        try { pdf.setProducer(""); } catch {}
        try { pdf.setCreator(""); } catch {}

        const out = await savePdf(pdf);
        res.setHeader("Content-Type", "application/pdf");
        res.send(out);
      } catch (err) {
        console.error("repair error:", err);
        res.status(500).json({ error: "Repair failed." });
      }
    }
  );

  // Resize Pages (Letter/A4) — fits/fills existing pages onto new page size.
  app.post(
    "/api/resize-pages",
    upload.single("file"),
    (req, res, next) => requireExportAccess(req, res, next, "resize-pages"),
    async (req, res) => {
      try {
        if (!req.file) return res.status(400).json({ error: "File required." });

        const preset = String(req.body.preset || "letter").toLowerCase();
        const mode = String(req.body.mode || "fit").toLowerCase(); // fit|fill
        const margin = Math.max(0, Math.min(144, Number(req.body.margin ?? 18) || 0));

        const SIZES = {
          letter: [612, 792], // 8.5x11 inches at 72dpi
          a4: [595.28, 841.89],
        };

        const dims = SIZES[preset] || SIZES.letter;
        const tw = dims[0];
        const th = dims[1];

        const srcPdf = await loadPdfFromBuffer(req.file.buffer);
        const srcPages = srcPdf.getPages();

        const dstPdf = await PDFDocument.create();
        const pageIndexes = srcPages.map((_, idx) => idx);
        const copied = await dstPdf.copyPages(srcPdf, pageIndexes);

        for (let i = 0; i < copied.length; i++) {
          const p = copied[i];
          const size = p.getSize();
          const ow = size.width;
          const oh = size.height;

          const page = dstPdf.addPage([tw, th]);
          const embedded = await dstPdf.embedPage(p);

          const availW = tw - margin * 2;
          const availH = th - margin * 2;

          const sx = availW / ow;
          const sy = availH / oh;
          const scale = (mode === "fill") ? Math.max(sx, sy) : Math.min(sx, sy);

          const drawW = ow * scale;
          const drawH = oh * scale;

          const x = (tw - drawW) / 2;
          const y = (th - drawH) / 2;

          page.drawPage(embedded, { x, y, xScale: scale, yScale: scale });
        }

        const out = await dstPdf.save();
        res.setHeader("Content-Type", "application/pdf");
        res.send(Buffer.from(out));
      } catch (err) {
        console.error("resize-pages error:", err);
        res.status(500).json({ error: "Resize pages failed." });
      }
    }
  );
  // ------------------------------------------------------------------------


// Redact (burn-in): apply rectangles then rasterize to image-only PDF
app.post(
  "/api/redact/burn",
  upload.single("file"),
  (req, res, next) => requireExportAccess(req, res, next, "redact"),
  async (req, res) => {
    let tmpIn = null;
    let tmpOut = null;
    try {
      if (!req.file) return res.status(400).json({ error: "File required." });
      if (!canRunGhostscript()) return res.status(501).json({ error: "Ghostscript not available on server." });

      const boxes = String(req.body.boxes || "").trim();
      if (!boxes) return res.status(400).json({ error: "Boxes required." });

      // 1) Apply black rectangles (same as /api/redact)
      const pdf = await loadPdfFromBuffer(req.file.buffer);
      const pages = pdf.getPages();
      const lines = boxes.split("\n").map((l) => l.trim()).filter(Boolean);

      lines.forEach((line) => {
        const parts = line.split(",");
        if (parts.length < 5) return;
        const pageIndex = parseInt(String(parts[0]).trim(), 10) - 1;
        if (isNaN(pageIndex) || pageIndex < 0 || pageIndex >= pages.length) return;

        const page = pages[pageIndex];
        const size = page.getSize();
        const width = size.width;
        const height = size.height;

        const nx = parseFloat(parts[1]);
        const ny = parseFloat(parts[2]);
        const nw = parseFloat(parts[3]);
        const nh = parseFloat(parts[4]);
        if ([nx, ny, nw, nh].some((v) => isNaN(v))) return;

        const x = nx * width;
        const y = height - (ny + nh) * height;
        const w = nw * width;
        const h = nh * height;

        page.drawRectangle({ x, y, width: w, height: h, color: rgb(0, 0, 0) });
      });

      const intermediate = await savePdf(pdf);

      // 2) Rasterize to image-only PDF (burn-in)
      tmpIn = tmpPdfPath("redactburn_in");
      tmpOut = tmpPdfPath("redactburn_out");

      fs.writeFileSync(tmpIn, intermediate);

      const dpiRaw = parseInt(String(req.body.dpi || "200"), 10);
      const dpi = Math.max(72, Math.min(600, isNaN(dpiRaw) ? 200 : dpiRaw));

      const args = [
        "-dSAFER",
        "-dBATCH",
        "-dNOPAUSE",
        "-dQUIET",
        "-dNOPROMPT",
        "-sDEVICE=pdfimage24",
        "-dPDFSTOPONERROR",
        "-dAutoRotatePages=/None",
        "-r" + String(dpi),
        "-sOutputFile=" + tmpOut,
        tmpIn,
      ];

      const r = runGhostscript(args);
      if (!r || r.status !== 0) {
        const details = (r && r.stderr) ? String(r.stderr) : "";
        return res.status(500).json({ error: "Redact burn-in failed.", details: details.slice(0, 6000) });
      }

      const out = fs.readFileSync(tmpOut);
      res.setHeader("Content-Type", "application/pdf");
      res.send(out);
    } catch (err) {
      console.error("redact/burn error:", err);
      res.status(500).json({ error: "Redact burn-in failed." });
    } finally {
      try { if (tmpIn) fs.unlinkSync(tmpIn); } catch {}
      try { if (tmpOut) fs.unlinkSync(tmpOut); } catch {}
    }
  }
);
// ---- Decrypt PDF (qpdf) ----
// Used by frontend decryptPdfToFile() - removes encryption so pdf-lib can process it.
// No paywall gate: decryption of user's own PDF is always free.
app.post("/api/decrypt", upload.any(), async (req, res) => {
  const tmpRoot = os.tmpdir();
  const stamp = Date.now() + "_" + Math.random().toString(16).slice(2);
  const tmpIn = path.join(tmpRoot, "pdfrealm_dec_in_" + stamp + ".pdf");
  const tmpOut = path.join(tmpRoot, "pdfrealm_dec_out_" + stamp + ".pdf");
  try {
    const files = req.files || [];
    const file = files[0] || req.file;
    if (!file || !file.buffer) return res.status(400).json({ error: "File required." });

    const password = String(req.body.password ?? req.body.inputPassword ?? req.body.currentPassword ?? "");
    if (!password) return res.status(400).json({ error: "Password required." });

    try {
      const head = file.buffer.slice(0, 8).toString("latin1");
      if (!head.startsWith("%PDF")) {
        return res.status(400).json({ error: "Input is not a valid PDF (missing %PDF header)." });
      }
    } catch {}

    const qpdfPath = resolveQpdfPath();
    if (!qpdfPath) {
      return res.status(501).json({
        error: "Server-side decrypt requires qpdf, which is not available in this runtime.",
        hint: "Install qpdf (e.g. apt-get install qpdf) or set QPDF_PATH env var.",
      });
    }

    fs.writeFileSync(tmpIn, file.buffer);
    const q = runQpdf(["--password=" + password, "--decrypt", "--", tmpIn, tmpOut], qpdfPath);

    if (q.status == null) {
      return res.status(501).json({ error: "qpdf could not be launched.", details: String(q.error || "") });
    }

    if (q.status !== 0) {
      const stderr = (q.stderr || Buffer.from("")).toString();
      if (/invalid password/i.test(stderr) || /password.*invalid/i.test(stderr)) {
        return res.status(400).json({ error: "Invalid password for encrypted PDF." });
      }
      return res.status(500).json({ error: "Decrypt failed.", details: stderr.slice(0, 600) });
    }

    const out = fs.readFileSync(tmpOut);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="decrypted.pdf"');
    res.send(out);
  } catch (err) {
    console.error("decrypt error:", err);
    res.status(500).json({ error: "Decrypt failed.", details: String(err && err.message ? err.message : err) });
  } finally {
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
  }
});

// ---- Encrypt PDF (qpdf) ----
// Sets AES-256 password on a PDF. Requires active export access (paywalled).
app.post(
  "/api/encrypt",
  upload.single("file"),
  (req, res, next) => requireExportAccess(req, res, next, "encrypt"),
  async (req, res) => {
    const tmpRoot = os.tmpdir();
    const stamp = Date.now() + "_" + Math.random().toString(16).slice(2);
    const tmpIn = path.join(tmpRoot, "pdfrealm_enc_in_" + stamp + ".pdf");
    const tmpOut = path.join(tmpRoot, "pdfrealm_enc_out_" + stamp + ".pdf");
    try {
      if (!req.file) return res.status(400).json({ error: "File required." });
      const password = String(req.body.password || "");
      if (!password) return res.status(400).json({ error: "Password required." });

      try {
        const head = req.file.buffer ? req.file.buffer.slice(0, 8).toString("latin1") : "";
        if (!head.startsWith("%PDF")) {
          return res.status(400).json({ error: "Input is not a valid PDF (missing %PDF header)." });
        }
      } catch {}

      const qpdfPath = resolveQpdfPath();
      if (!qpdfPath) {
        return res.status(501).json({
          error: "Server-side AES-256 encryption requires qpdf, which is not available in this runtime.",
          hint: "Install qpdf (e.g. apt-get install qpdf) or set QPDF_PATH env var.",
        });
      }

      const inputPassword = String(req.body.inputPassword || req.body.currentPassword || "");

      // Try multiple open-password candidates (handles re-encryption of already-encrypted PDFs)
      const openCandidates = [];
      if (inputPassword) openCandidates.push(inputPassword);
      openCandidates.push(null);
      if (!inputPassword || inputPassword !== password) openCandidates.push(password);

      const seen = new Set();
      const candidates = openCandidates.filter((c) => {
        const k = c === null ? "__NULL__" : String(c);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });

      fs.writeFileSync(tmpIn, req.file.buffer);

      let q = null;
      let lastStderr = "";

      for (const cand of candidates) {
        const qpdfArgs = [];
        if (cand !== null) qpdfArgs.push("--password=" + cand);
        qpdfArgs.push("--encrypt", password, password, "256", "--", tmpIn, tmpOut);
        q = runQpdf(qpdfArgs, qpdfPath);

        const stderr = (q && q.stderr ? q.stderr : Buffer.from("")).toString();
        if (stderr) lastStderr = stderr;

        if (q && q.status == null) break;
        if (q && q.status === 0) break;
        if (/invalid password/i.test(stderr) || /password.*invalid/i.test(stderr)) continue;
        break;
      }

      if (!q || q.status == null) {
        return res.status(501).json({ error: "qpdf executable could not be launched.", hint: "Install qpdf or set QPDF_PATH." });
      }

      if (q.status !== 0) {
        const stderr = lastStderr;
        if (/invalid password/i.test(stderr) || /password.*invalid/i.test(stderr)) {
          return res.status(400).json({
            error: "Input PDF is already encrypted and the current password was not accepted.",
            hint: "Provide the existing password as inputPassword or currentPassword.",
          });
        }
        return res.status(500).json({ error: "qpdf encryption failed.", details: stderr.slice(0, 600) });
      }

      const enc = fs.readFileSync(tmpOut);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", 'attachment; filename="pdfrealm-protected.pdf"');
      res.send(enc);
    } catch (err) {
      console.error("encrypt error:", err);
      res.status(500).json({ error: "Encrypt failed.", details: String(err && err.message ? err.message : err) });
    } finally {
      try { fs.unlinkSync(tmpIn); } catch {}
      try { fs.unlinkSync(tmpOut); } catch {}
    }
  }
);

// ---- [pdfrealm] Client-side export authorization endpoints (prevents 404 alert) ----
// PDF->JPG is converted in the browser (PDF.js + JSZip). Server only authorizes export (paywall).
app.post(
  "/api/pdf-to-jpg/authorize",
  upload.single("file"),
  (req, res, next) => requireExportAccess(req, res, next, "pdf-to-jpg"),
  (req, res) => {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send("ok");
  }
);
// -------------------------------------------------------------------------------
// Image → PDF
app.post(
  "/api/jpg-to-pdf",
  upload.single("file"),
  (req, res, next) => requireExportAccess(req, res, next, "jpg-to-pdf"),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "JPG file required." });
      const pdf = await PDFDocument.create();
      const img = await pdf.embedJpg(req.file.buffer);
      const { width, height } = img.size();
      const page = pdf.addPage([width, height]);
      page.drawImage(img, { x: 0, y: 0, width, height });
      const out = await savePdf(pdf);
      res.setHeader("Content-Type", "application/pdf");
      res.send(out);
    } catch (err) {
      console.error("jpg-to-pdf error:", err);
      res.status(500).json({ error: "JPG to PDF failed." });
    }
  }
);

app.post(
  "/api/png-to-pdf",
  upload.single("file"),
  (req, res, next) => requireExportAccess(req, res, next, "png-to-pdf"),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "PNG file required." });
      const pdf = await PDFDocument.create();
      const img = await pdf.embedPng(req.file.buffer);
      const { width, height } = img.size();
      const page = pdf.addPage([width, height]);
      page.drawImage(img, { x: 0, y: 0, width, height });
      const out = await savePdf(pdf);
      res.setHeader("Content-Type", "application/pdf");
      res.send(out);
    } catch (err) {
      console.error("png-to-pdf error:", err);
      res.status(500).json({ error: "PNG to PDF failed." });
    }
  }
);


// TIFF → PDF
app.post(
  "/api/tiff-to-pdf",
  upload.single("file"),
  (req, res, next) => requireExportAccess(req, res, next, "tiff-to-pdf"),
  async (req, res) => {
    let tmpDir = null;
    try {
      if (!req.file) return res.status(400).json({ error: "TIFF file required." });

      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfrealm-tiff2pdf-"));
      const inPath = path.join(tmpDir, "input.tiff");
      fs.writeFileSync(inPath, req.file.buffer);

      const outPath = path.join(tmpDir, "output.pdf");

      const tryRun = (cmd, args, extraOpts = {}) => {
        try {
          const r = spawnSync(cmd, args, { windowsHide: true, ...extraOpts });
          return !!(r && r.status === 0);
        } catch {
          return false;
        }
      };

      // Prefer libtiff tools if present
      let ok = tryRun("tiff2pdf", ["-o", outPath, inPath]);

      // Fallback: ImageMagick (magick/convert)
      if (!ok) ok = tryRun("magick", [inPath, outPath], { timeout: 120000 });
      if (!ok) ok = tryRun("convert", [inPath, outPath], { timeout: 120000 });

      if (!ok || !fs.existsSync(outPath)) {
        return res.status(501).json({
          error:
            "TIFF→PDF converter not available on this server. Install 'tiff2pdf' (libtiff-tools) or ImageMagick (magick/convert).",
        });
      }

      res.setHeader("Content-Type", "application/pdf");
      res.send(fs.readFileSync(outPath));
    } catch (err) {
      console.error("tiff-to-pdf error:", err);
      res.status(500).json({ error: "TIFF to PDF failed." });
    } finally {
      if (tmpDir) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      }
    }
  }
);

// Multi-image → PDF
app.post(
  "/api/multi-image-to-pdf",
  upload.array("files"),
  (req, res, next) => requireExportAccess(req, res, next, "multi-image-to-pdf"),
  async (req, res) => {
    try {
      const files = req.files || [];
      if (!files.length) return res.status(400).json({ error: "At least one image is required." });

      const pdfDoc = await PDFDocument.create();
      for (const f of files) {
        const mime = (f.mimetype || "").toLowerCase();
        let img;
        if (mime.includes("jpeg") || mime.includes("jpg")) img = await pdfDoc.embedJpg(f.buffer);
        else if (mime.includes("png")) img = await pdfDoc.embedPng(f.buffer);
        else continue;

        const { width, height } = img.scale(1);
        const page = pdfDoc.addPage([width, height]);
        page.drawImage(img, { x: 0, y: 0, width, height });
      }

      res.setHeader("Content-Type", "application/pdf");
      res.send(Buffer.from(await pdfDoc.save()));
    } catch (err) {
      console.error("multi-image-to-pdf error:", err);
      res.status(500).json({ error: "Multi-image to PDF failed." });
    }
  }
);


// DOCX → PNG (ZIP)
// - Converts DOCX -> PDF using LibreOffice (soffice) headless
// - Renders PDF pages -> PNG (Ghostscript preferred, else pdftoppm)
// - Zips PNGs and returns application/zip
function __pdfrealm_resolve_cmd__(candidates, versionArgs) {
  for (const c of candidates) {
    if (!c) continue;
    try {
      const r = spawnSync(c, versionArgs, { windowsHide: true });
      if (r && r.status === 0) return c;
    } catch {}
  }
  return null;
}

async function __pdfrealm_docx2png_handler__(req, res) {
  let tmpDir = null;
  try {
    if (!req.file) return res.status(400).json({ error: "DOCX file required." });

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfrealm-docx2png-"));
    const inPath = path.join(tmpDir, "input.docx");
    fs.writeFileSync(inPath, req.file.buffer);

    const isWin = process.platform === "win32";
    const soffice = __pdfrealm_resolve_cmd__(
      [
        process.env.SOFFICE_PATH,
        process.env.LIBREOFFICE_PATH,
        isWin ? "soffice.exe" : "soffice",
        isWin ? "libreoffice.exe" : "libreoffice",
        isWin ? "C:\\Program Files\\LibreOffice\\program\\soffice.exe" : "/usr/bin/soffice",
        isWin ? "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe" : "/usr/local/bin/soffice",
      ],
      ["--version"]
    );

    if (!soffice) {
      return res.status(500).json({
        error: "DOCX to PNG failed on this server. LibreOffice (soffice) is required. Set SOFFICE_PATH if needed."
      });
    }

    // DOCX -> PDF
    const rDoc = spawnSync(
      soffice,
      ["--headless","--nologo","--nofirststartwizard","--norestore","--invisible","--convert-to","pdf","--outdir", tmpDir, inPath],
      { windowsHide: true, timeout: 180000 }
    );

    const pdfName = (fs.readdirSync(tmpDir).find(f => /\.pdf$/i.test(f)) || null);
    if (!pdfName) {
      const err = String((rDoc && rDoc.stderr) ? rDoc.stderr : "");
      const hint = (/password|encrypted/i.test(err) ? "This DOCX may be password-protected; headless conversion cannot prompt for a password." : null);
      return res.status(500).json({ error: "DOCX to PDF conversion failed.", detail: err.slice(0, 600), hint });
    }
    const pdfPath = path.join(tmpDir, pdfName);

    const dpiRaw = parseInt(String(req.body?.dpi || "180"), 10) || 180;
    const dpi = Math.max(72, Math.min(300, dpiRaw));

    // PDF -> PNG pages
    let rendered = false;
    if (typeof canRunGhostscript === "function" && typeof runGhostscript === "function" && canRunGhostscript()) {
      const outPattern = path.join(tmpDir, "page-%03d.png");
      const gsArgs = [
        "-q","-dNOPAUSE","-dBATCH",
        "-sDEVICE=pngalpha",
        ("-r" + dpi),
        ("-sOutputFile=" + outPattern),
        pdfPath
      ];
      const r = runGhostscript(gsArgs);
      rendered = !!(r && r.status === 0);
    }

    if (!rendered) {
      const probe = spawnSync("pdftoppm", ["-v"], { windowsHide: true });
      if (probe.error) {
        return res.status(501).json({ error: "No renderer installed (Ghostscript/pdftoppm) for DOCX→PNG." });
      }
      const prefix = path.join(tmpDir, "page");
      const r = spawnSync("pdftoppm", ["-png","-r", String(dpi), pdfPath, prefix], { windowsHide: true, timeout: 180000 });
      rendered = !!(r && r.status === 0);
    }

    const pngs = fs.readdirSync(tmpDir)
      .filter(f => /\.png$/i.test(f))
      .sort((a,b)=>a.localeCompare(b, undefined, { numeric:true, sensitivity:"base" }));

    if (!pngs.length) return res.status(500).json({ error: "DOCX to PNG failed (no PNG pages produced)." });

    // ZIP
    const zipProbe = spawnSync("zip", ["-v"], { windowsHide: true });
    if (zipProbe.error) return res.status(501).json({ error: "DOCX to PNG requires the 'zip' utility on this server." });

    const outZip = path.join(tmpDir, "docx-to-png.zip");
    const fullPngPaths = pngs.map(n => path.join(tmpDir, n));
    const rz = spawnSync("zip", ["-q","-j", outZip, ...fullPngPaths], { windowsHide: true, timeout: 180000 });
    if (!fs.existsSync(outZip) || !rz || rz.status !== 0) {
      const err = String((rz && rz.stderr) ? rz.stderr : "");
      return res.status(500).json({ error: "Failed to create ZIP.", detail: err.slice(0, 600) });
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="pdfrealm-docx-to-png.zip"');
    res.setHeader("Cache-Control", "no-store");
    return res.send(fs.readFileSync(outZip));
  } catch (e) {
    console.error("[pdfrealm] docx2png error:", e);
    return res.status(500).json({ error: "DOCX to PNG failed." });
  } finally {
    try { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

app.post(
  "/api/docx2png/preview",
  upload.single("file"),
  (req, res, next) => requireExportAccess(req, res, next, "docx2png"),
  __pdfrealm_docx2png_handler__
);
app.post(
  "/api/docx2png",
  upload.single("file"),
  (req, res, next) => requireExportAccess(req, res, next, "docx2png"),
  __pdfrealm_docx2png_handler__
);

// aliases (some clients call these)
app.post(
  "/api/docx-to-png/preview",
  upload.single("file"),
  (req, res, next) => requireExportAccess(req, res, next, "docx-to-png"),
  __pdfrealm_docx2png_handler__
);
app.post(
  "/api/docx-to-png",
  upload.single("file"),
  (req, res, next) => requireExportAccess(req, res, next, "docx-to-png"),
  __pdfrealm_docx2png_handler__
);

// SVG → PDF

// [pdfrealm patch] Robust PDF -> Word export (python module, then CLI, then soffice)

// [pdfrealm patch v5] Robust PDF -> Word export (no crash on ENOENT, always returns debug attempts)

// [pdfrealm patch] PDF -> Word via LibreOffice: PDF->ODT (Writer PDF import) -> DOCX

// [pdfrealm patch] PDF -> Word via LibreOffice: PDF->ODT (Writer PDF import) -> DOCX
// - /api/pdf-to-word/preview: returns JSON { html } for a lightweight output preview (free)
// - /api/pdf-to-word: returns DOCX (export-gated)
app.post("/api/pdf-to-word/preview", upload.any(), async (req, res) => {
  let tmpIn = null;
  let tmpWork = null;
  try {
    const files = req.files || [];
    const file = (files && files[0]) || req.file || null;
    if (!file || !file.buffer) return res.status(400).json({ error: "File required." });

    const password = String(req.body.password ?? req.body.inputPassword ?? req.body.currentPassword ?? "").trim();

    const tmpRoot = os.tmpdir();
    const stamp = Date.now() + "_" + Math.random().toString(16).slice(2);
    tmpIn = path.join(tmpRoot, "pdfrealm_pdf2word_in_" + stamp + ".pdf");
    tmpWork = path.join(tmpRoot, "pdfrealm_pdf2word_work_" + stamp + ".pdf");
    fs.writeFileSync(tmpIn, file.buffer);

    // If qpdf exists, decrypt/normalize (helps with encrypted inputs + compatibility)
    let workPdf = tmpIn;
    const qpdfPath = resolveQpdfPath();
    if (qpdfPath) {
      const args = [];
      if (password) args.push(`--password=${password}`, "--decrypt");
      args.push("--object-streams=disable", "--stream-data=uncompress", "--qdf", "--", tmpIn, tmpWork);
      const q = runQpdf(args, qpdfPath);

      if (q.status == null) {
        // qpdf couldn't be launched; fall back to raw input (may fail on encrypted)
        workPdf = tmpIn;
      } else if (q.status !== 0) {
        const stderr = (q.stderr || Buffer.from("")).toString();
        if (!password && (/password required/i.test(stderr) || /encrypted/i.test(stderr))) {
          return res.status(400).json({ error: "Password required for encrypted PDF.", code: "PASSWORD_REQUIRED" });
        }
        if (/invalid password/i.test(stderr) || /password.*invalid/i.test(stderr)) {
          return res.status(400).json({ error: "Invalid password for encrypted PDF.", code: "INVALID_PASSWORD" });
        }
        // Fall back (some PDFs fail normalize but still can be text-extracted)
        workPdf = tmpIn;
      } else {
        workPdf = tmpWork;
      }
    }

    // pdftotext (Poppler) for preview
    function canRun(cmd, args) {
      try {
        const r = spawnSync(cmd, args, { windowsHide: true });
        return r && r.status === 0;
      } catch {
        return false;
      }
    }
    function resolveCmd(candidates, versionArgs) {
      for (const c of candidates) {
        if (!c) continue;
        if (canRun(c, versionArgs)) return c;
      }
      return null;
    }

    const isWin = process.platform === "win32";
    const pdftotext = resolveCmd(
      [process.env.PDFTOTEXT_PATH, isWin ? "pdftotext.exe" : "pdftotext", "/usr/bin/pdftotext", "/usr/local/bin/pdftotext"],
      ["-v"]
    );

    let text = "";
    if (pdftotext) {
      const r = spawnSync(pdftotext, ["-layout", "-nopgbrk", workPdf, "-"], { windowsHide: true, maxBuffer: 20 * 1024 * 1024 });
      // pdftotext prints version to stderr for -v; for conversion we want stdout.
      text = (r.stdout || Buffer.from("")).toString("utf8");
      if (!text) {
        // sometimes text may land in stderr depending on build
        text = (r.stderr || Buffer.from("")).toString("utf8");
      }
    } else {
      text = "Preview unavailable on this server (pdftotext not installed).";
    }

    // Clamp to avoid massive payloads
    const MAX = 120000;
    if (text.length > MAX) text = text.slice(0, MAX) + "\n\n…(truncated)…";

    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    const html =
      '<div style="font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial; font-size:14px; line-height:1.5;">' +
      '<pre style="white-space:pre-wrap; word-break:break-word; margin:0;">' +
      escapeHtml(text) +
      "</pre></div>";

    return res.json({ html });
  } catch (e) {
    console.error("pdf-to-word preview error:", e);
    return res.status(500).json({ error: "Preview failed." });
  } finally {
    try { if (tmpIn) fs.unlinkSync(tmpIn); } catch {}
    try { if (tmpWork) fs.unlinkSync(tmpWork); } catch {}
  }
});

app.post(
  "/api/pdf-to-word",
  upload.any(),
  (req, res, next) => requireExportAccess(req, res, next, "pdf-to-word"),
  async (req, res) => {
    let tmpDir = null;
    let tmpIn = null;
    let tmpWork = null;
    try {
      const files = req.files || [];
      const file = (files && files[0]) || req.file || null;
      if (!file || !file.buffer) return res.status(400).json({ error: "File required." });

      const password = String(req.body.password ?? req.body.inputPassword ?? req.body.currentPassword ?? "").trim();

      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfrealm-pdf2word-"));
      tmpIn = path.join(tmpDir, "input.pdf");
      tmpWork = path.join(tmpDir, "work.pdf");
      fs.writeFileSync(tmpIn, file.buffer);

      // Decrypt/normalize with qpdf if available (needed for encrypted PDFs in most converters)
      let workPdf = tmpIn;
      const qpdfPath = resolveQpdfPath();
      if (qpdfPath) {
        const args = [];
        if (password) args.push(`--password=${password}`, "--decrypt");
        args.push("--object-streams=disable", "--stream-data=uncompress", "--qdf", "--", tmpIn, tmpWork);
        const q = runQpdf(args, qpdfPath);

        if (q.status == null) {
          // qpdf couldn't launch; proceed with original (may fail)
          workPdf = tmpIn;
        } else if (q.status !== 0) {
          const stderr = (q.stderr || Buffer.from("")).toString();
          if (!password && (/password required/i.test(stderr) || /encrypted/i.test(stderr))) {
            return res.status(400).json({ error: "Password required for encrypted PDF.", code: "PASSWORD_REQUIRED" });
          }
          if (/invalid password/i.test(stderr) || /password.*invalid/i.test(stderr)) {
            return res.status(400).json({ error: "Invalid password for encrypted PDF.", code: "INVALID_PASSWORD" });
          }
          // If normalize fails, still try raw
          workPdf = tmpIn;
        } else {
          workPdf = tmpWork;
        }
      }

      function canRun(cmd, args) {
        try {
          const r = spawnSync(cmd, args, { windowsHide: true });
          return r && r.status === 0;
        } catch {
          return false;
        }
      }
      function resolveCmd(candidates, versionArgs) {
        for (const c of candidates) {
          if (!c) continue;
          if (canRun(c, versionArgs)) return c;
        }
        return null;
      }

      const isWin = process.platform === "win32";// Try pdf2docx CLI first (best fidelity when available)
// NOTE: pip installs commonly land in ~/.local/bin, which may not be on PATH for Node.
const _pdf2docxEnvPath =
  process.env.PDF2DOCX_PATH ||
  process.env.PDF2DOCX_BIN ||
  process.env.PDF2DOCX ||
  "";

function _uniq(arr) {
  const out = [];
  const seen = new Set();
  for (const v of arr) {
    if (!v) continue;
    const s = String(v);
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function _discoverUserLocalPdf2docxBins() {
  const bins = [];
  // Current user's ~/.local/bin
  try {
    const p = path.join(os.homedir(), ".local", "bin", isWin ? "pdf2docx.exe" : "pdf2docx");
    if (fs.existsSync(p)) bins.push(p);
  } catch {}
  // Any /home/*/.local/bin (covers running Node as root while pip was installed for another user)
  if (!isWin) {
    try {
      const homeRoot = "/home";
      if (fs.existsSync(homeRoot)) {
        for (const userDir of fs.readdirSync(homeRoot)) {
          const p = path.join(homeRoot, userDir, ".local", "bin", "pdf2docx");
          if (fs.existsSync(p)) bins.push(p);
        }
      }
    } catch {}
  }
  return bins;
}

function _bashWhich(cmdName, envObj) {
  try {
    if (isWin) return null;
    const r = spawnSync("bash", ["-lc", `command -v "${cmdName}" 2>/dev/null | head -n 1`], {
      windowsHide: true,
      env: envObj,
      maxBuffer: 1024 * 1024,
    });
    const out = (r.stdout || Buffer.from("")).toString().trim();
    return out || null;
  } catch {
    return null;
  }
}

// Build an execution env with common user-local bin dirs included.
const _extraPathDirs = _uniq([
  path.join(os.homedir(), ".local", "bin"),
  "/usr/local/bin",
  "/usr/bin",
]);
const _execEnv = { ...process.env };
_execEnv.PATH = _uniq([
  ..._extraPathDirs,
  ...(String(process.env.PATH || "").split(path.delimiter).filter(Boolean)),
]).join(path.delimiter);

function _canLaunch(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { windowsHide: true, env: _execEnv });
    // If it launched at all, r.error should be undefined. status may be non-zero for --help.
    return r && !r.error && r.status !== null;
  } catch {
    return false;
  }
}

function _resolvePdf2docx() {
  const cmdName = isWin ? "pdf2docx.exe" : "pdf2docx";
  const fromWhich = _bashWhich(cmdName, _execEnv);

  const candidates = _uniq([
    _pdf2docxEnvPath,
    fromWhich,
    ..._discoverUserLocalPdf2docxBins(),
    cmdName,
    "/usr/local/bin/pdf2docx",
    "/usr/bin/pdf2docx",
  ]);

  for (const c of candidates) {
    try {
      // If it's an absolute/relative path, ensure it exists
      if (c.includes(path.sep) && !fs.existsSync(c)) continue;
      if (_canLaunch(c, ["--help"])) return c;
    } catch {}
  }
  return null;
}

const pdf2docx = _resolvePdf2docx();

// Fallback: run pdf2docx via Python module (helps when console_script isn't on PATH)
function _resolvePython3() {
  const candidates = _uniq([
    process.env.PYTHON3_PATH,
    process.env.PYTHON_PATH,
    isWin ? "python.exe" : "python3",
    isWin ? "python" : "python",
    "/usr/bin/python3",
    "/usr/local/bin/python3",
  ]);
  for (const c of candidates) {
    try {
      if (!c) continue;
      if (c.includes(path.sep) && !fs.existsSync(c)) continue;
      const r = spawnSync(c, ["-V"], { windowsHide: true, env: _execEnv, maxBuffer: 1024 * 1024 });
      if (r && !r.error && r.status === 0) return c;
    } catch {}
  }
  return null;
}

function _tryPdf2docxPython(pythonCmd, inPdf, outDocx) {
  const code = `
import sys
try:
  from pdf2docx import Converter
except Exception as e:
  sys.stderr.write("IMPORT_ERROR: " + repr(e) + "\n")
  raise
pdf_path = sys.argv[1]
docx_path = sys.argv[2]
cv = Converter(pdf_path)
cv.convert(docx_path, start=0, end=None)
cv.close()
print("ok")
`.strip()
  return spawnSync(
    pythonCmd,
    ["-c", code, inPdf, outDocx],
    { windowsHide: true, timeout: 240000, env: _execEnv, maxBuffer: 50 * 1024 * 1024 }
  );
}


      const outDocxPath = path.join(tmpDir, "output.docx");let ok = false;
const attempts = [];
let sofficeDetected = null;

if (pdf2docx) {
  // Common CLI: pdf2docx convert input.pdf output.docx
  const args = ["convert", workPdf, outDocxPath];
  const r = spawnSync(pdf2docx, args, {
    windowsHide: true,
    timeout: 240000,
    env: _execEnv,
    maxBuffer: 50 * 1024 * 1024,
  });
  attempts.push({
    tool: "pdf2docx",
    cmd: pdf2docx,
    status: r?.status,
    error: r?.error ? String(r.error) : null,
    stderr: (r?.stderr || Buffer.from("")).toString("utf8").slice(0, 4000),
  });
  ok = r && r.status === 0 && fs.existsSync(outDocxPath);
} else {
  attempts.push({ tool: "pdf2docx", cmd: null, note: "not found (try setting PDF2DOCX_PATH or ensure pdf2docx is on PATH)" });
}

      
// If pdf2docx CLI wasn't available or failed, try importing pdf2docx via Python directly.
if (!ok) {
  const python3 = _resolvePython3();
  if (python3) {
    const r = _tryPdf2docxPython(python3, workPdf, outDocxPath);
    attempts.push({
      tool: "python-pdf2docx",
      cmd: python3,
      status: r?.status,
      error: r?.error ? String(r.error) : null,
      stderr: (r?.stderr || Buffer.from("")).toString("utf8").slice(0, 4000),
    });
    ok = r && r.status === 0 && fs.existsSync(outDocxPath);
  } else {
    attempts.push({ tool: "python-pdf2docx", cmd: null, note: "python3 not found (set PYTHON3_PATH or install python3)" });
  }
}


// Fallback: LibreOffice (soffice/libreoffice)
      if (!ok) {
        const soffice = resolveCmd(
          [
            process.env.SOFFICE_PATH,
            process.env.LIBREOFFICE_PATH,
            isWin ? "soffice.exe" : "soffice",
            isWin ? "libreoffice.exe" : "libreoffice",
            isWin ? "C:\Program Files\LibreOffice\program\soffice.exe" : "/usr/bin/soffice",
            isWin ? "C:\Program Files (x86)\LibreOffice\program\soffice.exe" : "/usr/local/bin/soffice",
          ],
          ["--version"]
        );
sofficeDetected = soffice || null;
if (!soffice) {
  attempts.push({ tool: "soffice", cmd: null, note: "not found (try setting SOFFICE_PATH or install LibreOffice)" });
}

        function findDocxInDir(dir) {
          try {
            const files = fs.readdirSync(dir);
            const docx = files.find((f) => /\.docx$/i.test(f));
            return docx ? path.join(dir, docx) : null;
          } catch {
            return null;
          }
        }

        if (soffice) {
          const r = spawnSync(
            soffice,
            ["--headless", "--nologo", "--nofirststartwizard", "--norestore", "--invisible", "--convert-to", "docx", "--outdir", tmpDir, workPdf],
            { windowsHide: true, timeout: 240000, env: _execEnv, maxBuffer: 50 * 1024 * 1024 }
          );
attempts.push({
  tool: "soffice",
  cmd: soffice,
  status: r?.status,
  error: r?.error ? String(r.error) : null,
  stderr: (r?.stderr || Buffer.from("")).toString("utf8").slice(0, 4000),
});
          if (r && r.status === 0) {
            const produced = findDocxInDir(tmpDir);
            if (produced) {
              fs.copyFileSync(produced, outDocxPath);
              ok = true;
            }
          }
        }
      }

      if (!ok || !fs.existsSync(outDocxPath)) {
  const hint = (() => {
    try {
      const withErr = (attempts || []).filter(a => a && typeof a === "object" && a.stderr && String(a.stderr).trim());
      const last = withErr[withErr.length - 1];
      if (!last) return "";
      const firstLine = String(last.stderr).split(/\r?\n/)[0].slice(0, 180);
      return firstLine ? `${last.tool || "tool"}: ${firstLine}` : "";
    } catch { return ""; }
  })();

  return res.status(500).json({
    error: "PDF to Word failed on this server. Install pdf2docx (recommended) or LibreOffice (soffice), or set PDF2DOCX_PATH / SOFFICE_PATH." + (hint ? (" Details: " + hint) : ""),
    debug: {
      attempts,
      detected: { pdf2docx: pdf2docx || null, python3: _resolvePython3() || null, soffice: sofficeDetected || null },
      effectivePath: _execEnv.PATH || "",
    },
  });
}

      const outBuf = fs.readFileSync(outDocxPath);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      res.setHeader("Content-Disposition", 'attachment; filename="pdfrealm.docx"');
      return res.send(outBuf);
    } catch (err) {
      console.error("pdf-to-word error:", err);
      return res.status(500).json({ error: "PDF to Word failed." });
    } finally {
      if (tmpDir) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      } else {
        try { if (tmpIn) fs.unlinkSync(tmpIn); } catch {}
        try { if (tmpWork) fs.unlinkSync(tmpWork); } catch {}
      }
    }
  }
);


// Bates numbering
app.post(
  "/api/bates",
  upload.single("file"),
  (req, res, next) => requireExportAccess(req, res, next, "bates"),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "File required." });

      const prefix = String(req.body.prefix || "");
      const start = parseInt(String(req.body.start || "1"), 10) || 1;
      const digits = Math.max(1, parseInt(String(req.body.digits || "6"), 10) || 6);

      const pdf = await loadPdfFromBuffer(req.file.buffer);
      const font = await pdf.embedFont(StandardFonts.HelveticaBold);
      const size = 10;

      let n = start;
      for (const page of pdf.getPages()) {
        const label = prefix + String(n).padStart(digits, "0");
        n += 1;

        const { width } = page.getSize();
        const textW = font.widthOfTextAtSize(label, size);
        const x = Math.max(12, width - textW - 24);
        const y = 14;

        page.drawText(label, { x, y, size, font, color: rgb(0, 0, 0) });
      }

      const out = await savePdf(pdf);
      res.setHeader("Content-Type", "application/pdf");
      res.send(out);
    } catch (err) {
      console.error("bates error:", err);
      res.status(500).json({ error: "Bates failed." });
    }
  }
);

// OCR


// ---- [pdfrealm] Word->PDF input preview (DOCX -> HTML) ----
app.post(
  "/api/word-to-pdf/input-preview",
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "Word/DOCX file required." });

      const name = String(req.file.originalname || "document.docx");
      const size = Number(req.file.size || req.file.buffer?.length || 0);

      const esc = (s) => String(s)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");

      // Best-effort: use mammoth if available (DOCX -> HTML)
      let html = "";
      try {
        const mod = await import("mammoth");
        const mammoth = mod?.default || mod;
        if (mammoth?.convertToHtml) {
          const result = await mammoth.convertToHtml({ buffer: req.file.buffer });
          html = String(result?.value || "").trim();
        }
      } catch {
        // mammoth not installed (ok) -> fallback below
      }

      // Fallback: simple metadata card (still prevents 404 + keeps UI consistent)
      if (!html) {
        const kb = (size / 1024).toFixed(1);
        html = `
          <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;color:#111;">
            <div style="font-size:16px;font-weight:700;margin-bottom:6px;">${esc(name)}</div>
            <div style="opacity:.8;">${esc(kb)} KB</div>
            <div style="margin-top:10px;opacity:.8;">
              Input preview is unavailable on this server (install <code>mammoth</code> for DOCX→HTML),
              but you can still convert and export normally.
            </div>
          </div>`;
      }

      res.setHeader("Cache-Control", "no-store");
      return res.json({ html });
    } catch (err) {
      console.error("[pdfrealm] word-to-pdf input-preview error:", err);
      return res.status(500).json({ error: "Input preview failed." });
    }
  }
);
// -------------------- Word/DOCX → PDF --------------------
app.post(
  "/api/word-to-pdf",
  upload.single("file"),
  (req, res, next) => requireExportAccess(req, res, next, "word-to-pdf"),
  async (req, res) => {
    const os = require("os");
    const path = require("path");
    const fs = require("fs");
    const { execFileSync } = require("child_process");
    let tmpIn = null;
    let tmpOut = null;
    try {
      if (!req.file) return res.status(400).json({ error: "File required." });
      const ext = (req.file.originalname || "").toLowerCase().split(".").pop();
      if (!["doc","docx","odt","rtf"].includes(ext)) {
        return res.status(400).json({ error: "Unsupported file type. Send .doc, .docx, .odt, or .rtf" });
      }
      const stamp = Date.now() + "_" + Math.random().toString(16).slice(2);
      tmpIn = path.join(os.tmpdir(), "pdfrealm_w2p_" + stamp + "." + ext);
      const tmpDir = os.tmpdir();
      fs.writeFileSync(tmpIn, req.file.buffer);

      // Use LibreOffice to convert
      const soffice = process.env.SOFFICE_PATH || "soffice";
      try {
        execFileSync(soffice, ["--headless","--convert-to","pdf","--outdir",tmpDir,tmpIn], { timeout: 60000, stdio:"pipe" });
      } catch(e) {
        return res.status(500).json({ error: "Conversion failed. LibreOffice error: " + String(e.message || e).slice(0,300) });
      }
      const outName = path.basename(tmpIn, "." + ext) + ".pdf";
      tmpOut = path.join(tmpDir, outName);
      if (!fs.existsSync(tmpOut)) {
        return res.status(500).json({ error: "Conversion produced no output." });
      }
      const buf = fs.readFileSync(tmpOut);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", 'attachment; filename="converted.pdf"');
      res.send(buf);
    } catch(err) {
      console.error("word-to-pdf error:", err);
      res.status(500).json({ error: "Conversion failed.", details: String(err && err.message ? err.message : err).slice(0,300) });
    } finally {
      try { if (tmpIn) fs.unlinkSync(tmpIn); } catch {}
      try { if (tmpOut) fs.unlinkSync(tmpOut); } catch {}
    }
  }
);
// ----------------------------------------------------------

// -------------------- Text/HTML/Dev → PDF tools --------------------
function _pdfKitToBuffer(buildFn, docOptions = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFKitDocument({ size: "LETTER", margin: 54, ...docOptions });
      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      buildFn(doc);
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

async function _addPreviewWatermark(pdfBuffer, label = "PDFREALM PREVIEW") {
  try {
    const pdf = await PDFDocument.load(pdfBuffer);
    const font = await pdf.embedFont(StandardFonts.HelveticaBold);
    const pages = pdf.getPages();
    for (const page of pages) {
      const { width, height } = page.getSize();
      const size = Math.max(28, Math.min(72, Math.floor(Math.min(width, height) / 8)));
      const textWidth = font.widthOfTextAtSize(label, size);
      const x = (width - textWidth) / 2;
      const y = height / 2;
      page.drawText(label, {
        x,
        y,
        size,
        font,
        color: rgb(0.2, 0.2, 0.2),
        opacity: 0.15,
        rotate: degrees(-30),
      });
    }
    return Buffer.from(await pdf.save());
  } catch {
    return pdfBuffer;
  }
}

function _limitText(s, maxLen) {
  const str = (s ?? "").toString();
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + "\n\n...[truncated]";
}

function _sendPdf(res, buf, filename) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(buf);
}

async function _getChromium() {
  if (Playwright && Playwright.chromium) return Playwright.chromium;
  try {
    const mod = await import("playwright");
    return (mod && (mod.chromium || (mod.default && mod.default.chromium))) || null;
  } catch {
    return null;
  }
}

async function _renderHtmlOrUrlToPdfBuffer({ html, url }) {
  // Try wkhtmltopdf first (lightweight, no browser needed)
  const wkhtmlPath = (() => {
    try { return require("child_process").execSync("which wkhtmltopdf").toString().trim(); } catch { return null; }
  })();

  if (wkhtmlPath) {
    const os = require("os");
    const fs = require("fs");
    const path = require("path");
    const { execFile } = require("child_process");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfrealm-html2pdf-"));
    const outPath = path.join(tmpDir, "output.pdf");

    try {
      await new Promise((resolve, reject) => {
        let args;
        if (url) {
          args = ["--quiet", "--no-stop-slow-scripts", "--javascript-delay", "1000", url, outPath];
        } else {
          const inPath = path.join(tmpDir, "input.html");
          fs.writeFileSync(inPath, html || "", "utf8");
          args = ["--quiet", "--no-stop-slow-scripts", inPath, outPath];
        }
        execFile(wkhtmlPath, args, { timeout: 30000 }, (err) => {
          if (err) reject(err); else resolve();
        });
      });
      const buf = fs.readFileSync(outPath);
      return buf;
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  // Fallback: Playwright/Chromium
  const chromium = await _getChromium();
  if (!chromium) {
    const err = new Error("HTML/URL rendering requires wkhtmltopdf or Playwright/Chromium.");
    err.statusCode = 501;
    throw err;
  }

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    if (url) {
      await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });
    } else {
      await page.setContent(html || "", { waitUntil: "networkidle", timeout: 30000 });
    }
    const pdf = await page.pdf({ format: "A4", printBackground: true });
    return Buffer.from(pdf);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function _buildSimpleTextPdfBuffer({ title, content, monospace = false }) {
  const safe = _limitText(content, 400000);
  return _pdfKitToBuffer((doc) => {
    doc.info.Title = title;
    doc.font(monospace ? "Courier" : "Helvetica");
    doc.fontSize(11);
    doc.text(safe || "", { align: "left" });
  });
}

async function _buildMarkdownPdfBuffer(md) {
  const safe = _limitText(md, 400000);
  const lines = (safe || "").replace(/\r\n/g, "\n").split("\n");

  return _pdfKitToBuffer((doc) => {
    doc.info.Title = "Markdown → PDF";

    let inCode = false;

    for (const raw of lines) {
      const line = (raw ?? "").toString();

      // fenced code blocks
      if (/^\s*```/.test(line)) {
        inCode = !inCode;
        doc.moveDown(0.2);
        continue;
      }

      if (inCode) {
        doc.font("Courier").fontSize(10).text(line);
        continue;
      }

      // headings
      if (/^\s*#{1,6}\s+/.test(line)) {
        const lvl = (line.match(/^\s*(#{1,6})\s+/) || ["", "#"])[1].length;
        const txt = line.replace(/^\s*#{1,6}\s+/, "");
        const size = Math.max(12, 24 - lvl * 2);
        doc.font("Helvetica-Bold").fontSize(size).text(txt);
        doc.moveDown(0.2);
        continue;
      }

      // bullets
      if (/^\s*[-*]\s+/.test(line)) {
        const txt = line.replace(/^\s*[-*]\s+/, "• ");
        doc.font("Helvetica").fontSize(11).text(txt);
        continue;
      }

      // blank line
      if (!line.trim()) {
        doc.moveDown(0.6);
        continue;
      }

      doc.font("Helvetica").fontSize(11).text(line);
    }
  });
}


// TEXT → PDF
app.post("/api/text-to-pdf/preview", upload.none(), async (req, res) => {
  try {
    const content = _limitText(req.body.text || "", 400000);
    if (!content.trim()) return res.status(400).json({ error: "Text is required." });
    const buf = await _buildSimpleTextPdfBuffer({ title: "Text → PDF", content });
    const out = await _addPreviewWatermark(buf);
    return _sendPdf(res, out, "preview-text.pdf");
  } catch (e) {
    console.error("text-to-pdf preview error:", e);
    return res.status(e.statusCode || 500).json({ error: e.message || "Failed to render." });
  }
});

app.post("/api/text-to-pdf", upload.none(), (req, res, next) => requireExportAccess(req, res, next, "txt2pdf"), async (req, res) => {
  try {
    const content = _limitText(req.body.text || "", 400000);
    if (!content.trim()) return res.status(400).json({ error: "Text is required." });
    const buf = await _buildSimpleTextPdfBuffer({ title: "Text → PDF", content });
    return _sendPdf(res, buf, "text.pdf");
  } catch (e) {
    console.error("text-to-pdf error:", e);
    return res.status(e.statusCode || 500).json({ error: e.message || "Failed to render." });
  }
});

// JSON → PDF
app.post("/api/json-to-pdf/preview", upload.none(), async (req, res) => {
  try {
    const raw = _limitText(req.body.json || "", 400000);
    if (!raw.trim()) return res.status(400).json({ error: "JSON is required." });
    let pretty = raw;
    try {
      pretty = JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      pretty = raw;
    }
    const buf = await _buildSimpleTextPdfBuffer({ title: "JSON → PDF", content: pretty, monospace: true });
    const out = await _addPreviewWatermark(buf);
    return _sendPdf(res, out, "preview-json.pdf");
  } catch (e) {
    console.error("json-to-pdf preview error:", e);
    return res.status(e.statusCode || 500).json({ error: e.message || "Failed to render." });
  }
});

app.post("/api/json-to-pdf", upload.none(), (req, res, next) => requireExportAccess(req, res, next, "json2pdf"), async (req, res) => {
  try {
    const raw = _limitText(req.body.json || "", 400000);
    if (!raw.trim()) return res.status(400).json({ error: "JSON is required." });
    let pretty = raw;
    try {
      pretty = JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      pretty = raw;
    }
    const buf = await _buildSimpleTextPdfBuffer({ title: "JSON → PDF", content: pretty, monospace: true });
    return _sendPdf(res, buf, "json.pdf");
  } catch (e) {
    console.error("json-to-pdf error:", e);
    return res.status(e.statusCode || 500).json({ error: e.message || "Failed to render." });
  }
});

// CSV → PDF
app.post("/api/csv-to-pdf/preview", upload.none(), async (req, res) => {
  try {
    const raw = _limitText(req.body.csv || "", 600000);
    if (!raw.trim()) return res.status(400).json({ error: "CSV is required." });
    const buf = await _buildSimpleTextPdfBuffer({ title: "CSV → PDF", content: raw, monospace: true });
    const out = await _addPreviewWatermark(buf);
    return _sendPdf(res, out, "preview-csv.pdf");
  } catch (e) {
    console.error("csv-to-pdf preview error:", e);
    return res.status(e.statusCode || 500).json({ error: e.message || "Failed to render." });
  }
});

app.post("/api/csv-to-pdf", upload.none(), (req, res, next) => requireExportAccess(req, res, next, "csv2pdf"), async (req, res) => {
  try {
    const raw = _limitText(req.body.csv || "", 600000);
    if (!raw.trim()) return res.status(400).json({ error: "CSV is required." });
    const buf = await _buildSimpleTextPdfBuffer({ title: "CSV → PDF", content: raw, monospace: true });
    return _sendPdf(res, buf, "csv.pdf");
  } catch (e) {
    console.error("csv-to-pdf error:", e);
    return res.status(e.statusCode || 500).json({ error: e.message || "Failed to render." });
  }
});

// Markdown → PDF
app.post("/api/markdown-to-pdf/preview", upload.none(), async (req, res) => {
  try {
    const raw = _limitText(req.body.markdown || "", 400000);
    if (!raw.trim()) return res.status(400).json({ error: "Markdown is required." });
    const buf = await _buildMarkdownPdfBuffer(raw);
    const out = await _addPreviewWatermark(buf);
    return _sendPdf(res, out, "preview-markdown.pdf");
  } catch (e) {
    console.error("markdown-to-pdf preview error:", e);
    return res.status(e.statusCode || 500).json({ error: e.message || "Failed to render." });
  }
});

app.post("/api/markdown-to-pdf", upload.none(), (req, res, next) => requireExportAccess(req, res, next, "md2pdf"), async (req, res) => {
  try {
    const raw = _limitText(req.body.markdown || "", 400000);
    if (!raw.trim()) return res.status(400).json({ error: "Markdown is required." });
    const buf = await _buildMarkdownPdfBuffer(raw);
    return _sendPdf(res, buf, "markdown.pdf");
  } catch (e) {
    console.error("markdown-to-pdf error:", e);
    return res.status(e.statusCode || 500).json({ error: e.message || "Failed to render." });
  }
});

// HTML → PDF
app.post("/api/html-to-pdf/preview", upload.single("file"), async (req, res) => {
  try {
    let html = "";
    if (req.file && req.file.buffer) html = req.file.buffer.toString("utf8");
    if (!html) html = _limitText(req.body.html || "", 800000);
    if (!html.trim()) return res.status(400).json({ error: "HTML is required." });

    const buf = await _renderHtmlOrUrlToPdfBuffer({ html });
    const out = await _addPreviewWatermark(buf);
    return _sendPdf(res, out, "preview-html.pdf");
  } catch (e) {
    console.error("html-to-pdf preview error:", e);
    return res.status(e.statusCode || 500).json({ error: e.message || "Failed to render." });
  }
});

app.post("/api/html-to-pdf", upload.single("file"), (req, res, next) => requireExportAccess(req, res, next, "html2pdf"), async (req, res) => {
  try {
    let html = "";
    if (req.file && req.file.buffer) html = req.file.buffer.toString("utf8");
    if (!html) html = _limitText(req.body.html || "", 800000);
    if (!html.trim()) return res.status(400).json({ error: "HTML is required." });

    const buf = await _renderHtmlOrUrlToPdfBuffer({ html });
    return _sendPdf(res, buf, "html.pdf");
  } catch (e) {
    console.error("html-to-pdf error:", e);
    return res.status(e.statusCode || 500).json({ error: e.message || "Failed to render." });
  }
});

// URL → PDF
app.post("/api/url-to-pdf/preview", upload.none(), async (req, res) => {
  try {
    const url = (req.body.url || "").toString().trim();
    if (!url) return res.status(400).json({ error: "URL is required." });

    const buf = await _renderHtmlOrUrlToPdfBuffer({ url });
    const out = await _addPreviewWatermark(buf);
    return _sendPdf(res, out, "preview-url.pdf");
  } catch (e) {
    console.error("url-to-pdf preview error:", e);
    return res.status(e.statusCode || 500).json({ error: e.message || "Failed to render." });
  }
});

app.post("/api/url-to-pdf", upload.none(), (req, res, next) => requireExportAccess(req, res, next, "url2pdf"), async (req, res) => {
  try {
    const url = (req.body.url || "").toString().trim();
    if (!url) return res.status(400).json({ error: "URL is required." });

    const buf = await _renderHtmlOrUrlToPdfBuffer({ url });
    return _sendPdf(res, buf, "url.pdf");
  } catch (e) {
    console.error("url-to-pdf error:", e);
    return res.status(e.statusCode || 500).json({ error: e.message || "Failed to render." });
  }
});

// ------------------ end Text/HTML/Dev → PDF tools ------------------


// PDF->Pages ZIP is created in the browser (PDF-Lib + JSZip). Server only authorizes export (paywall).
app.post(
  "/api/pdf-to-pages-zip/authorize",
  upload.single("file"),
  (req, res, next) => requireExportAccess(req, res, next, "pdf-to-pages-zip"),
  (req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  }
);

app.post("/api/ocr",
  upload.single("file"),
  (req, res, next) => requireExportAccess(req, res, next, "ocr"),
  async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "File required." });

    const lang = (req.body.lang || "eng").trim() || "eng";
    const mime = (req.file.mimetype || "").toLowerCase();
    const isPdf = mime === "application/pdf" || req.file.originalname?.toLowerCase().endsWith(".pdf");

    if (isPdf) {
      // PDF: rasterize pages with pdftoppm, then OCR each page
      const os = require("os");
      const fs = require("fs");
      const path = require("path");
      const { execFile } = require("child_process");

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfrealm-ocr-"));
      const pdfPath = path.join(tmpDir, "input.pdf");
      fs.writeFileSync(pdfPath, req.file.buffer);

      try {
        // Rasterize up to first 5 pages at 150 DPI
        await new Promise((resolve, reject) => {
          execFile("pdftoppm", ["-r", "150", "-l", "5", "-png", pdfPath, path.join(tmpDir, "page")],
            { timeout: 30000 }, (err) => err ? reject(err) : resolve());
        });

        const pageFiles = fs.readdirSync(tmpDir)
          .filter(f => f.startsWith("page") && f.endsWith(".png"))
          .sort()
          .map(f => path.join(tmpDir, f));

        if (!pageFiles.length) throw new Error("No pages rasterized from PDF.");

        if (!Tesseract) throw new Error("OCR engine not available.");

        // OCR each page and join results
        let fullText = "";
        for (const pageFile of pageFiles) {
          const imgBuf = fs.readFileSync(pageFile);
          const { data } = await Tesseract.recognize(imgBuf, lang);
          if (data.text) fullText += data.text + "\n\n";
        }

        return res.json({ text: fullText.trim(), pages: pageFiles.length });
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      }
    }

    // Image file — existing path
    if (!Tesseract) return res.status(501).json({ error: "OCR engine (tesseract.js) not installed." });
    const { data } = await Tesseract.recognize(req.file.buffer, lang);
    res.json({ text: data.text || "" });

  } catch (err) {
    console.error("ocr error:", err);
    res.status(500).json({ error: "OCR failed: " + (err.message || err) });
  }
});

// -------------------- VAULT (S3 + Postgres metadata) --------------------

// connectivity test
app.get("/api/vault/s3-test", async (req, res) => {
  try {
    requireAwsEnvOrThrow();
    await s3.send(new HeadBucketCommand({ Bucket: vaultBucket }));

    const prefix = (req.query.prefix || "").toString();
    const out = await s3.send(
      new ListObjectsV2Command({ Bucket: vaultBucket, Prefix: prefix || undefined, MaxKeys: 5 })
    );

    res.json({
      ok: true,
      bucket: vaultBucket,
      region: s3Region,
      prefix: prefix || "",
      keyCount: out.KeyCount || 0,
      sampleKeys: (out.Contents || []).map((x) => x.Key),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// Create logical folder in DB (and optional S3 marker if you want later)
app.post("/api/vault/folder", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const raw = String(req.body?.folderPath || req.body?.path || req.body?.folder || "").trim();
    const folderKey = normVaultFolderKey(raw);

    if (!folderKey) {
      return res.status(400).json({ ok: false, error: "Folder name required." });
    }
    if (folderKey === "_Trash") {
      return res.status(400).json({ ok: false, error: "Cannot create reserved folder _Trash." });
    }
    // NEW schema
    if ((await vaultHasNewSchema()) && (await vaultFoldersHaveTreeColumns())) {
      await ensureVaultRootTrashWorking(userId);

      // Create full parent chain if needed and return the final folder id.
      const id = await ensureVaultFolderPath(userId, folderKey);
      return res.json({ ok: true, id });
    }

    // Legacy schema
    const p = safeCleanFolder(raw);
    if (!p) return res.status(400).json({ ok: false, error: "Invalid folder path." });

    if (!(await dbHasTable("vault_folders"))) return res.status(501).json({ ok: false, error: "vault_folders table not found." });

    try {
      await safeQuery(
        `INSERT INTO vault_folders (user_id, path) VALUES ($1, $2) ON CONFLICT (user_id, path) DO NOTHING`,
        [userId, p]
      );
    } catch (e) {
      await safeQuery(`INSERT INTO vault_folders (user_id, path) VALUES ($1, $2)`, [userId, p]).catch(() => {});
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
// Upload: S3 blob + vault_objects row
app.post("/api/vault/upload", requireAuth, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded" });
    const userId = req.user.id;

    const rawFolder = String(req.body?.folderPath || req.body?.folder || req.body?.path || "").trim();
    const folderKey = normVaultFolderKey(rawFolder);

    const uploadToTrash = (folderKey === "_Trash");

    const originalName = String(req.file.originalname || "file").trim() || "file";
    const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180);
    const ext = safeExtFromName(safeName);
    const mimeType = req.file.mimetype || "application/octet-stream";
    const sizeBytes = req.file.size || 0;

    const awsOk = Boolean(process.env.AWS_REGION && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && vaultBucket);

    // Build storage key (S3 key or local/...)
    let storageKey = "";
    const prefix = getUserVaultPrefix(req.user);
    const folderSeg = folderKey ? `${folderKey}/` : "";
    const baseKey = `${prefix}${folderSeg}${Date.now()}_${crypto.randomUUID()}_${safeName}`;

    if (awsOk) {
      storageKey = baseKey;
      await s3.send(
        new PutObjectCommand({
          Bucket: vaultBucket,
          Key: storageKey,
          Body: req.file.buffer,
          ContentType: mimeType,
          ServerSideEncryption: "AES256",
        })
      );
    } else {
      const abs = path.join(__dirname, "uploads", "vault", String(userId), baseKey);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, req.file.buffer);
      storageKey = `local/${userId}/${baseKey}`;
    }

    // NEW schema (preferred)
    if ((await dbHasTable("vault_files")) && (await dbHasTable("vault_folders")) && (await vaultFoldersHaveTreeColumns())) {
      await ensureVaultRootTrashWorking(userId);

      const folderId = await ensureVaultFolderPath(userId, folderKey);
      const sha256 = crypto.createHash("sha256").update(req.file.buffer).digest("hex");

      const r = await safeQuery(
        `INSERT INTO vault_files
         (user_id, name, ext, mime_type, size_bytes, folder_path, folder_id, storage_key, sha256)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id`,
        [userId, safeName, ext || null, mimeType || null, sizeBytes || 0, folderKey || "", folderId, storageKey, sha256]
      );
      const newId = r.rows?.[0]?.id || null;
      if (uploadToTrash && newId) {
        await safeQuery(
          `UPDATE vault_files SET trashed_at=NOW() WHERE id=$1 AND user_id=$2`,
          [newId, userId]
        ).catch(() => {});
      }

      return res.json({
        ok: true,
        id: newId,
        key: storageKey,
        filename: safeName,
        folderPath: folderKey || "",
        mimeType,
        sizeBytes,
      });
    }

    // Legacy schema (vault_objects)
    if (folderKey) await ensureFolderRow(userId, folderKey);

    let row = null;
    if (await dbHasTable("vault_objects")) {
      const cols = [];
      const vals = [];
      const args = [];
      const add = async (col, val, isSqlNow = false) => {
        if (await dbHasColumn("vault_objects", col)) {
          cols.push(col);
          if (isSqlNow) vals.push("NOW()");
          else {
            args.push(val);
            vals.push(`$${args.length}`);
          }
        }
      };

      await add("user_id", userId);
      await add("s3_bucket", vaultBucket);
      await add("s3_key", storageKey);
      await add("key", storageKey);

      await add("folder", folderKey || "");
      await add("folder_path", folderKey || "");

      await add("filename", safeName);
      await add("label", safeName);
      await add("name", safeName);
      await add("original_name", safeName);

      await add("content_type", mimeType);
      await add("mime_type", mimeType);

      await add("bytes", sizeBytes);
      await add("size_bytes", sizeBytes);
      await add("size", sizeBytes);

      if (await dbHasColumn("vault_objects", "created_at")) { cols.push("created_at"); vals.push("NOW()"); }
      if (await dbHasColumn("vault_objects", "updated_at")) { cols.push("updated_at"); vals.push("NOW()"); }

      if (cols.length) {
        const q = `INSERT INTO vault_objects (${cols.join(",")}) VALUES (${vals.join(",")}) RETURNING *`;
        const rr = await safeQuery(q, args).catch(() => null);
        row = rr?.rows?.[0] || null;
      }
    }

    const legacyId = row?.id || null;
    if (uploadToTrash && legacyId && (await dbHasColumn("vault_objects", "trashed_at"))) {
      await safeQuery(
        `UPDATE vault_objects SET trashed_at=NOW() WHERE id=$1 AND user_id=$2`,
        [legacyId, userId]
      ).catch(() => {});
    }

    return res.json({
      ok: true,
      id: legacyId,
      key: storageKey,
      filename: safeName,
      folderPath: folderKey || "",
      mimeType,
      sizeBytes,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
// List: prefer DB vault_objects + vault_folders; fallback to S3 scan if needed
app.get("/api/vault/list", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    let folderKey = normVaultFolderKey(req.query?.folder || "");
    if (String(folderKey || "").toLowerCase() === "_trash") folderKey = "";

    // NEW schema
    if ((await dbHasTable("vault_files")) && (await dbHasTable("vault_folders")) && (await vaultFoldersHaveTreeColumns())) {
      await ensureVaultRootTrashWorking(userId);

      // folders
      const fr = await safeQuery(
        `SELECT path
         FROM vault_folders
         WHERE user_id=$1 AND deleted_at IS NULL AND trashed_at IS NULL
         ORDER BY path ASC`,
        [userId]
      ).catch(() => ({ rows: [] }));

      const folders = (fr.rows || [])
        .map((x) => String(x.path || ""))
        .filter((p) => p !== "" && p !== "__root__"); // keep special folders out of "normal" list

      // items
      let items = [];
      {

        const r = await safeQuery(
          `SELECT id,
                  name,
                  ext,
                  mime_type AS "mimeType",
                  size_bytes AS "sizeBytes",
                  folder_path AS "folderPath",
                  created_at AS "createdAt"
           FROM vault_files
           WHERE user_id=$1 AND deleted_at IS NULL AND trashed_at IS NULL AND lower(COALESCE(folder_path,'')) = lower($2)
           ORDER BY created_at DESC`,
          [userId, folderKey || ""]
        );
        items = r.rows || [];
      }

      // Normalize fields expected by clients
      const normItems = items.map((it) => ({
        id: it.id,
        filename: it.name,
        name: it.name,
        ext: it.ext,
        mimeType: it.mimeType,
        sizeBytes: Number(it.sizeBytes || 0),
        folderPath: String(it.folderPath || ""),
        createdAt: it.createdAt,
        trashedAt: it.trashedAt,
      }));

      return res.json({ ok: true, folder: folderKey || "", folders, tree: buildFolderTree(folders), items: normItems });
    }

    // Legacy schema (vault_objects + optional vault_folders paths + optional S3 listing)
    const useDb = await dbHasTable("vault_objects");
    const items = [];

    if (useDb) {
      const hasDeletedAt = await dbHasColumn("vault_objects", "deleted_at");
      const hasFolder = await dbHasColumn("vault_objects", "folder");
      const hasFolderPath = await dbHasColumn("vault_objects", "folder_path");

      const folderWhere =
        folderKey === "_Trash"
          ? (await dbHasColumn("vault_objects", "trashed_at")) ? "AND trashed_at IS NOT NULL" : "AND 1=0"
          : (hasFolderPath ? "AND folder_path=$2" : hasFolder ? "AND folder=$2" : "");

      const args = [userId];
      if (folderWhere.includes("$2")) args.push(folderKey || "");

      const r = await safeQuery(
        `SELECT *
         FROM vault_objects
         WHERE user_id=$1 ${hasDeletedAt ? "AND deleted_at IS NULL" : ""} ${folderWhere}
         ORDER BY COALESCE(updated_at, created_at, NOW()) DESC
         LIMIT 500`,
        args
      ).catch(() => ({ rows: [] }));

      for (const row of (r.rows || [])) {
        const key = row.s3_key || row.key || row.storage_key;
        const filename = row.filename || row.original_name || row.label || row.name || "file";
        const mimeType = row.content_type || row.mime_type || "application/octet-stream";
        const sizeBytes = Number(row.bytes || row.size_bytes || row.size || 0);
        const fp = (row.folder_path ?? row.folder ?? "");
        items.push({ id: row.id, filename, name: filename, mimeType, sizeBytes, folderPath: String(fp || "") });
      }
    }

    // folders list (legacy)
    let folders = [];
    if (await dbHasTable("vault_folders")) {
      const rr = await safeQuery(`SELECT path FROM vault_folders WHERE user_id=$1 ORDER BY path ASC`, [userId]).catch(() => ({ rows: [] }));
      folders = (rr.rows || []).map((x) => String(x.path || "")).filter(Boolean);
    }

    return res.json({ ok: true, folder: folderKey || "", folders, tree: buildFolderTree(folders), items });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ============================================================================
// Office (Collabora / WOPI) — High-fidelity DOCX/XLSX/PPTX editing
// - /api/office/new: create blank OOXML file (from templates) into Vault
// - /api/office/session: returns iframe URL + WOPI access token
// - /wopi/...: minimal WOPI host (CheckFileInfo + contents read/write + basic locks)
// ============================================================================

const OFFICE_LOCKS = new Map(); // fileId -> { lock: string, expiresAt: number }

function getWopiAccessToken(req) {
  const q = req.query || {};
  const tokenQ = q.access_token || q.accessToken || null;
  if (tokenQ) return String(tokenQ);

  const auth = req.headers.authorization || req.headers.Authorization || "";
  const m = String(auth).match(/^Bearer\s+(.+)$/i);
  if (m && m[1]) return m[1].trim();
  return null;
}

function officeWopiAuth(req, res, next) {
  try {
    const token = getWopiAccessToken(req);
    if (!token) return res.status(401).json({ error: "Missing access_token" });

    const payload = jwt.verify(token, OFFICE_WOPI_SECRET);
    if (!payload || payload.scope !== "wopi" || !payload.fileId || !payload.userId) {
      return res.status(401).json({ error: "Invalid token" });
    }
    req.office = { userId: String(payload.userId), fileId: String(payload.fileId) };
    next();
  } catch (e) {
    return res.status(401).json({ error: "Unauthorized" });
  }
}

function decodeXmlEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

let collaboraDiscoveryCache = { ts: 0, xml: "", byExt: {} };

async function fetchText(url) {
  // Node 18+ has global fetch; fall back to http/https if needed.
  if (typeof fetch === "function") {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  }
  const mod = url.startsWith("https:") ? require("https") : require("http");
  return await new Promise((resolve, reject) => {
    mod.get(url, (resp) => {
      if (resp.statusCode && resp.statusCode >= 400) return reject(new Error(`HTTP ${resp.statusCode}`));
      let data = "";
      resp.setEncoding("utf8");
      resp.on("data", (c) => (data += c));
      resp.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

async function getCollaboraActionUrlForExt(ext) {
  const now = Date.now();
  if (!COLLABORA_URL) return null;

  // cache for 10 minutes
  if (collaboraDiscoveryCache.ts && now - collaboraDiscoveryCache.ts < 10 * 60 * 1000) {
    const cached = collaboraDiscoveryCache.byExt[String(ext || "").toLowerCase()];
    return cached ? cached.urlsrc : null;
  }

  const discoveryUrl = `${COLLABORA_URL}/hosting/discovery`;
  const xml = await fetchText(discoveryUrl);

  // parse urlsrc for common actions by ext (edit preferred)
  const byExt = {};
  const reAction = /<action\b[^>]*\bext="([^"]+)"[^>]*\bname="([^"]+)"[^>]*\burlsrc="([^"]+)"[^>]*\/>/gi;
  let m;
  while ((m = reAction.exec(xml))) {
    const e = String(m[1] || "").toLowerCase();
    const name = String(m[2] || "").toLowerCase();
    const urlsrc = decodeXmlEntities(m[3] || "");
    if (!byExt[e] || name === "edit") {
      byExt[e] = { name, urlsrc };
    }
  }

  collaboraDiscoveryCache = { ts: now, xml, byExt };
  const found = byExt[String(ext || "").toLowerCase()];
  return found ? found.urlsrc : null;
}

async function buildCollaboraIframeUrl({ wopiSrc, accessToken, ext }) {
  // Best-effort: use discovery urlsrc (preferred); fallback to legacy loleaflet URL.
  const urlsrc = await getCollaboraActionUrlForExt(ext).catch(() => null);

  if (urlsrc) {
    let u = urlsrc;

    // Discovery urlsrc may or may not include a WOPISrc placeholder.
    if (u.includes("WOPISrc=")) {
      // If template ends with WOPISrc=, append encoded value; otherwise fill placeholder if empty.
      if (u.endsWith("WOPISrc=")) u += encodeURIComponent(wopiSrc);
      else {
        const hasVal = /WOPISrc=[^&]+/.test(u);
        if (!hasVal) u = u.replace("WOPISrc=", "WOPISrc=" + encodeURIComponent(wopiSrc));
      }
    } else {
      // Add WOPISrc as a normal query parameter.
      const sep = u.includes("?") ? (u.endsWith("?") || u.endsWith("&") ? "" : "&") : "?";
      u = u + sep + "WOPISrc=" + encodeURIComponent(wopiSrc);
    }

    if (!u.includes("access_token=")) {
      u += (u.includes("?") ? "&" : "?") + "access_token=" + encodeURIComponent(accessToken);
    }

    return u;
  }


  // Fallback (older Collabora builds)
  const base = COLLABORA_URL.replace(/\/+$/, "");
  const sep = base.includes("?") ? "&" : "?";
  return `${base}/loleaflet/dist/loleaflet.html${sep}WOPISrc=${encodeURIComponent(wopiSrc)}&access_token=${encodeURIComponent(
    accessToken
  )}`;
}

async function getVaultObjectRowById(fileId) {
  // Back-compat helper used by Office/WOPI. Supports both vault_files and vault_objects.
  const id = String(fileId || "").trim();
  if (!id) return null;

  // NEW schema
  if (isUuidLike(id) && (await dbHasTable("vault_files"))) {
    const r = await safeQuery(
      `SELECT *, 'vault_files'::text AS _src
       FROM vault_files
       WHERE id=$1 AND deleted_at IS NULL
       LIMIT 1`,
      [id]
    ).catch(() => null);
    if (r?.rows?.[0]) return r.rows[0];
  }

  // Legacy schema
  if (isUuidLike(id) && (await dbHasTable("vault_objects"))) {
    const whereDeleted = (await dbHasColumn("vault_objects", "deleted_at")) ? "AND deleted_at IS NULL" : "";
    const r = await safeQuery(`SELECT *, 'vault_objects'::text AS _src FROM vault_objects WHERE id=$1 ${whereDeleted} LIMIT 1`, [id]).catch(() => null);
    if (r?.rows?.[0]) return r.rows[0];
  }

  return null;
}

function pickVaultKeyFromRow(row) {
  return row?.s3_key || row?.s3Key || row?.key || row?.object_key || row?.storage_key || null;
}

function pickVaultBucketFromRow(row) {
  return row?.s3_bucket || row?.s3Bucket || row?.bucket || vaultBucket;
}

async function updateVaultObjectAfterOfficeSave(fileId, sizeBytes) {
  try {
    const id = String(fileId || "").trim();
    if (!id) return;

    // NEW schema
    if (isUuidLike(id) && (await dbHasTable("vault_files"))) {
      const sets = [];
      const args = [];

      const add = async (col, val, isSqlNow = false) => {
        if (await dbHasColumn("vault_files", col)) {
          if (isSqlNow) sets.push(`${col}=NOW()`);
          else {
            args.push(val);
            sets.push(`${col}=$${args.length}`);
          }
        }
      };

      await add("size_bytes", sizeBytes);
      await add("updated_at", null, true);

      if (sets.length) {
        args.push(id);
        await safeQuery(`UPDATE vault_files SET ${sets.join(", ")} WHERE id=$${args.length}`, args).catch(() => {});
        return;
      }
    }

    // Legacy schema
    if (!(await dbHasTable("vault_objects"))) return;
    const sets = [];
    const args = [];
    const add = (col, val, isSqlNow = false) => {
      sets.push(isSqlNow ? `${col}=NOW()` : `${col}=$${args.push(val)}`);
    };

    if (await dbHasColumn("vault_objects", "bytes")) add("bytes", sizeBytes);
    if (await dbHasColumn("vault_objects", "size_bytes")) add("size_bytes", sizeBytes);
    if (await dbHasColumn("vault_objects", "size")) add("size", sizeBytes);
    if (await dbHasColumn("vault_objects", "updated_at")) add("updated_at", null, true);

    if (!sets.length) return;
    args.push(id);
    await safeQuery(`UPDATE vault_objects SET ${sets.join(", ")} WHERE id=$${args.length}`, args).catch(() => {});
  } catch {}
}

// Create a new blank Office file in Vault (DOCX/XLSX/PPTX)
app.post("/api/office/new", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const type = String(req.body?.type || "docx").toLowerCase();
    const rawName = String(req.body?.name || "New Document").trim();
    const rawFolder = String(req.body?.folderPath || req.body?.folder || "").trim();
    const folderKey = normVaultFolderKey(rawFolder);

    const ext = type === "pptx" ? ".pptx" : type === "xlsx" ? ".xlsx" : ".docx";
    const mime =
      type === "pptx"
        ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        : type === "xlsx"
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

    const safeBase = rawName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 140) || "New_Document";
    const filename = safeBase.endsWith(ext) ? safeBase : (safeBase + ext);

    // Minimal empty file bytes (the real content gets generated client-side by Office)
    const initialBytes = Buffer.from("", "utf-8");
    const size = initialBytes.length;

    const awsOk = Boolean(process.env.AWS_REGION && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && vaultBucket);
    const prefix = getUserVaultPrefix(req.user);
    const folderSeg = folderKey ? `${folderKey}/` : "";
    const baseKey = `${prefix}${folderSeg}${Date.now()}_${crypto.randomUUID()}_${filename}`;

    let storageKey = "";
    if (awsOk) {
      storageKey = baseKey;
      await s3.send(
        new PutObjectCommand({
          Bucket: vaultBucket,
          Key: storageKey,
          Body: initialBytes,
          ContentType: mime,
          ServerSideEncryption: "AES256",
        })
      );
    } else {
      const abs = path.join(__dirname, "uploads", "vault", String(userId), baseKey);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, initialBytes);
      storageKey = `local/${userId}/${baseKey}`;
    }

    // NEW schema
    if ((await dbHasTable("vault_files")) && (await dbHasTable("vault_folders")) && (await vaultFoldersHaveTreeColumns())) {
      await ensureVaultRootTrashWorking(userId);
      const folderId = await ensureVaultFolderPath(userId, folderKey);
      const sha256 = crypto.createHash("sha256").update(initialBytes).digest("hex");

      const r = await safeQuery(
        `INSERT INTO vault_files
         (user_id, name, ext, mime_type, size_bytes, folder_path, folder_id, storage_key, sha256)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, user_id, name, ext, mime_type AS "mimeType", size_bytes AS "sizeBytes", folder_path AS "folderPath", storage_key AS "storageKey", created_at AS "createdAt", updated_at AS "updatedAt"`,
        [userId, filename, ext, mime, size, folderKey || "", folderId, storageKey, sha256]
      );

      return res.json({ ok: true, file: r.rows?.[0] });
    }

    // Legacy schema (vault_objects)
    let row = null;
    if (await dbHasTable("vault_objects")) {
      const cols = [];
      const vals = [];
      const args = [];
      const add = (col, val, isSqlNow = false) => {
        cols.push(col);
        if (isSqlNow) vals.push("NOW()");
        else {
          args.push(val);
          vals.push(`$${args.length}`);
        }
      };

      if (await dbHasColumn("vault_objects", "user_id")) add("user_id", userId);
      if (await dbHasColumn("vault_objects", "s3_bucket")) add("s3_bucket", vaultBucket);
      if (await dbHasColumn("vault_objects", "s3_key")) add("s3_key", storageKey);
      if (await dbHasColumn("vault_objects", "key")) add("key", storageKey);

      if (await dbHasColumn("vault_objects", "folder")) add("folder", folderKey || "");
      if (await dbHasColumn("vault_objects", "folder_path")) add("folder_path", folderKey || "");

      if (await dbHasColumn("vault_objects", "filename")) add("filename", filename);
      if (await dbHasColumn("vault_objects", "label")) add("label", filename);
      if (await dbHasColumn("vault_objects", "name")) add("name", filename);
      if (await dbHasColumn("vault_objects", "original_name")) add("original_name", filename);

      if (await dbHasColumn("vault_objects", "content_type")) add("content_type", mime);
      if (await dbHasColumn("vault_objects", "mime_type")) add("mime_type", mime);
      if (await dbHasColumn("vault_objects", "bytes")) add("bytes", size);
      if (await dbHasColumn("vault_objects", "size_bytes")) add("size_bytes", size);

      if (await dbHasColumn("vault_objects", "created_at")) add("created_at", null, true);
      if (await dbHasColumn("vault_objects", "updated_at")) add("updated_at", null, true);

      if (cols.length) {
        const q = `INSERT INTO vault_objects (${cols.join(",")}) VALUES (${vals.join(",")}) RETURNING *`;
        const r2 = await safeQuery(q, args).catch(() => null);
        row = r2?.rows?.[0] || null;
      }
    }

    res.json({ ok: true, file: row });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
// Create an Office editor session for a Vault object id
app.post("/api/office/session", requireAuth, async (req, res) => {
  try {
    if (!COLLABORA_URL) return res.status(400).json({ ok: false, error: "COLLABORA_URL is not configured." });

    const userId = req.user.id;
    const fileId = String(req.body?.fileId || req.body?.id || "").trim();
    if (!fileId) return res.status(400).json({ ok: false, error: "Missing fileId" });

    const row = await getVaultObjectRowById(fileId);
    if (!row) return res.status(404).json({ ok: false, error: "File not found" });
    if (String(row.user_id || "") && String(row.user_id) !== String(userId)) return res.status(403).json({ ok: false, error: "Forbidden" });

    const name = row.filename || row.original_name || row.label || row.name || `file_${fileId}`;
    const ext = String(name).split(".").pop().toLowerCase();

    const accessToken = jwt.sign({ scope: "wopi", userId: String(userId), fileId: String(fileId) }, OFFICE_WOPI_SECRET, { expiresIn: "1h" });

    const base = getPublicBaseUrl();
    const wopiSrc = `${base}/wopi/files/${encodeURIComponent(fileId)}`;
    const url = await buildCollaboraIframeUrl({ wopiSrc, accessToken, ext });

    res.json({ ok: true, iframeUrl: url, url, access_token: accessToken, wopiSrc });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// WOPI: CheckFileInfo
app.get("/wopi/files/:id", officeWopiAuth, async (req, res) => {
  try {
    const fileId = String(req.params.id || "");
    if (req.office.fileId !== fileId) return res.status(403).json({ error: "Forbidden" });

    const row = await getVaultObjectRowById(fileId);
    if (!row) return res.status(404).json({ error: "Not found" });
    if (String(row.user_id || "") && String(row.user_id) !== String(req.office.userId)) return res.status(403).json({ error: "Forbidden" });

    const name = row.filename || row.original_name || row.label || row.name || `file_${fileId}`;
    let size = row.bytes || row.size_bytes || row.size || 0;

    const key = pickVaultKeyFromRow(row);
    if (!size && key && String(key).startsWith("local/")) {
      const rel = String(key).replace(/^local\/[^/]+\//, "");
      const abs = path.join(__dirname, "uploads", "vault", String(req.office.userId), rel);
      try { size = fs.statSync(abs).size; } catch {}
    }

    res.json({
      BaseFileName: name,
      Size: Number(size) || 0,
      OwnerId: String(req.office.userId),
      UserId: String(req.office.userId),
      UserFriendlyName: req.user?.email || "User",
      Version: String(row.updated_at || row.created_at || Date.now()),
      SupportsUpdate: true,
      SupportsLocks: true,
      SupportsGetLock: true,
      UserCanWrite: true,
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// WOPI: download contents
app.get("/wopi/files/:id/contents", officeWopiAuth, async (req, res) => {
  try {
    const fileId = String(req.params.id || "");
    if (req.office.fileId !== fileId) return res.status(403).send("Forbidden");

    const row = await getVaultObjectRowById(fileId);
    if (!row) return res.status(404).send("Not found");
    if (String(row.user_id || "") && String(row.user_id) !== String(req.office.userId)) return res.status(403).send("Forbidden");

    const key = pickVaultKeyFromRow(row);
    if (!key) return res.status(404).send("Not found");

    const mime = row.content_type || row.mime_type || row.mimetype || "application/octet-stream";
    res.setHeader("Content-Type", mime);

    if (String(key).startsWith("local/")) {
      const rel = String(key).replace(/^local\/[^/]+\//, "");
      const abs = path.join(__dirname, "uploads", "vault", String(req.office.userId), rel);
      return fs.createReadStream(abs).pipe(res);
    }

    const bucket = pickVaultBucketFromRow(row);
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return obj.Body.pipe(res);
  } catch (e) {
    res.status(500).send(String(e?.message || e));
  }
});


// WOPI: save contents (Collabora uses POST + X-WOPI-Override: PUT; some clients may use PUT)
async function wopiPutContentsHandler(req, res) {
  try {
    const fileId = String(req.params.id || "");
    if (req.office.fileId !== fileId) return res.status(403).send("Forbidden");

    // Collabora typically sends POST + header X-WOPI-Override: PUT.
    // If override is provided and isn't PUT, we don't support it (minimal WOPI).
    const override = String(req.headers["x-wopi-override"] || req.headers["X-WOPI-Override"] || "PUT").toUpperCase();
    if (override && override !== "PUT") return res.status(501).send("Not implemented");

    // Lock enforcement (best-effort)
    const lock = String(req.headers["x-wopi-lock"] || req.headers["X-WOPI-Lock"] || "");
    const cur = OFFICE_LOCKS.get(fileId);
    const now = Date.now();
    if (cur && cur.expiresAt < now) OFFICE_LOCKS.delete(fileId);

    if (cur && cur.lock && lock && cur.lock !== lock) {
      res.setHeader("X-WOPI-Lock", cur.lock);
      return res.status(409).end();
    }

    const row = await getVaultObjectRowById(fileId);
    if (!row) return res.status(404).send("Not found");
    if (String(row.user_id || "") && String(row.user_id) !== String(req.office.userId)) return res.status(403).send("Forbidden");

    const key = pickVaultKeyFromRow(row);
    if (!key) return res.status(404).send("Not found");

    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");
    const sizeBytes = buf.length || 0;
    const mime = row.content_type || row.mime_type || row.mimetype || "application/octet-stream";

    // Persist bytes back into the same Vault object (local or S3)
    if (String(key).startsWith("local/")) {
      const rel = String(key).replace(/^local\/[^/]+\//, "");
      const abs = path.join(__dirname, "uploads", "vault", String(req.office.userId), rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
    } else {
      const bucket = pickVaultBucketFromRow(row);
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: buf,
          ContentType: mime,
          ServerSideEncryption: "AES256",
        })
      );
    }

    // Update DB metadata so the file shows as changed inside folders + vault views
    await updateVaultObjectAfterOfficeSave(fileId, sizeBytes);

    res.setHeader("X-WOPI-ItemVersion", String(Date.now()));
    return res.status(200).end();
  } catch (e) {
    console.error("WOPI PUT contents error:", e);
    return res.status(500).send("Server error");
  }
}

app.post(
  "/wopi/files/:id/contents",
  express.raw({ type: "*/*", limit: "200mb" }),
  officeWopiAuth,
  wopiPutContentsHandler
);

// Some WOPI clients may call PUT directly.
app.put(
  "/wopi/files/:id/contents",
  express.raw({ type: "*/*", limit: "200mb" }),
  officeWopiAuth,
  wopiPutContentsHandler
);

// WOPI: lock endpoints (minimal best-effort)
app.post("/wopi/files/:id", express.raw({ type: "*/*", limit: "1mb" }), officeWopiAuth, async (req, res) => {
  try {
    const fileId = String(req.params.id || "");
    if (req.office.fileId !== fileId) return res.status(403).send("Forbidden");

    const override = String(req.headers["x-wopi-override"] || req.headers["X-WOPI-Override"] || "").toUpperCase();
    const lock = String(req.headers["x-wopi-lock"] || req.headers["X-WOPI-Lock"] || "");

    const cur = OFFICE_LOCKS.get(fileId);
    const now = Date.now();
    if (cur && cur.expiresAt < now) OFFICE_LOCKS.delete(fileId);

    if (override === "GET_LOCK") {
      const c = OFFICE_LOCKS.get(fileId);
      if (c?.lock) res.setHeader("X-WOPI-Lock", c.lock);
      return res.status(200).end();
    }

    if (override === "LOCK" || override === "REFRESH_LOCK") {
      const c = OFFICE_LOCKS.get(fileId);
      if (c && c.lock && c.lock !== lock) {
        res.setHeader("X-WOPI-Lock", c.lock);
        return res.status(409).end();
      }
      OFFICE_LOCKS.set(fileId, { lock, expiresAt: now + 30 * 60 * 1000 });
      res.setHeader("X-WOPI-Lock", lock);
      return res.status(200).end();
    }

    if (override === "UNLOCK") {
      const c = OFFICE_LOCKS.get(fileId);
      if (c && c.lock && c.lock !== lock) {
        res.setHeader("X-WOPI-Lock", c.lock);
        return res.status(409).end();
      }
      OFFICE_LOCKS.delete(fileId);
      return res.status(200).end();
    }

    // Unknown overrides — treat as OK
    return res.status(200).end();
  } catch (e) {
    return res.status(500).send(String(e?.message || e));
  }
});

// Signed URL download
app.get("/api/vault/file/:id", requireAuth, async (req, res) => {
  try {
    const idOrKey = decodeURIComponent(req.params.id || "");
    const row = await resolveVaultObject(req.user.id, idOrKey);

    const metaFolder = normVaultFolderKey(row?.folder_path ?? row?.folderPath ?? row?.folder ?? "");
    const metaName = String(row?.name || row?.filename || row?.original_name || "");

    const key = row?.storage_key || row?.s3_key || row?.key || idOrKey;
    if (!key) return res.status(404).json({ ok: false, error: "Not found" });

    if (String(key).startsWith("local/")) {
      const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
      return res.json({ ok: true, url: `${base}/api/vault/file-local/${encodeURIComponent(key)}`, folderPath: metaFolder, filename: metaName });
    }

    // Signed S3 URL (best effort; if AWS isn't configured you still get the proxy route)
    try {
      requireAwsEnvOrThrow();
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: vaultBucket, Key: key }),
        { expiresIn: 3600 }
      );
      return res.json({ ok: true, url, folderPath: metaFolder, filename: metaName });
    } catch {
      const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
      return res.json({ ok: true, url: `${base}/api/vault/file-proxy/${encodeURIComponent(row?.id || idOrKey)}`, folderPath: metaFolder, filename: metaName });
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
// Same-origin streaming proxy for Vault files (fixes S3 CORS issues for in-browser PDF rendering)
// Supports Range requests (PDF.js) and local storage fallback.
app.get("/api/vault/file-proxy/:id", requireAuth, async (req, res) => {
  try {
    const idOrKey = decodeURIComponent(req.params.id || "");
    const row = await resolveVaultObject(req.user.id, idOrKey);
    const key = row?.storage_key || row?.s3_key || row?.key || idOrKey;
    if (!key) return res.status(404).json({ ok: false, error: "Not found" });

    if (String(key).startsWith("local/")) {
      return res.redirect(302, `/api/vault/file-local/${encodeURIComponent(key)}`);
    }

    // Stream from S3 to avoid CORS issues
    requireAwsEnvOrThrow();
    const obj = await s3.send(new GetObjectCommand({ Bucket: vaultBucket, Key: key }));
    const ct = obj.ContentType || row?.mime_type || row?.content_type || "application/octet-stream";
    res.setHeader("Content-Type", ct);
    // Do not force download in preview proxy
    if (obj.Body && typeof obj.Body.pipe === "function") {
      obj.Body.pipe(res);
    } else {
      res.status(500).json({ ok: false, error: "No body" });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Overwrite an existing Vault file's contents (used by PDFStudio "Save/Done")
// - Accepts multipart/form-data with field name "file" (PDF bytes)
// - Writes to the existing object's S3 key (or local storage path)
// - Updates DB metadata (bytes/content_type/updated_at) when possible
app.post("/api/vault/file/:id/overwrite", requireAuth, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded" });
    const idOrKey = decodeURIComponent(req.params.id || "");
    const row = await resolveVaultObject(req.user.id, idOrKey);
    if (!row) return res.status(404).json({ ok: false, error: "Not found" });

    const key = row.storage_key || row.s3_key || row.key;
    if (!key) return res.status(400).json({ ok: false, error: "Missing storage key" });

    const mimeType = req.file.mimetype || "application/octet-stream";
    const sizeBytes = req.file.size || 0;

    if (String(key).startsWith("local/")) {
      const rel = key.replace(/^local\/[^/]+\//, "");
      const abs = path.join(__dirname, "uploads", "vault", String(req.user.id), rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, req.file.buffer);
    } else {
      requireAwsEnvOrThrow();
      await s3.send(
        new PutObjectCommand({
          Bucket: vaultBucket,
          Key: key,
          Body: req.file.buffer,
          ContentType: mimeType,
          ServerSideEncryption: "AES256",
        })
      );
    }

    // Update DB metadata
    if (row._src === "vault_files" && (await dbHasTable("vault_files"))) {
      const sha256 = crypto.createHash("sha256").update(req.file.buffer).digest("hex");
      const ext = safeExtFromName(req.file.originalname || row.name || "file");

      await safeQuery(
        `UPDATE vault_files
         SET size_bytes=$3,
             mime_type=$4,
             ext=$5,
             sha256=$6,
             updated_at=NOW()
         WHERE id=$1 AND user_id=$2`,
        [row.id, req.user.id, sizeBytes, mimeType, ext || row.ext || null, sha256]
      ).catch(() => {});
    } else if (row._src === "vault_objects" && (await dbHasTable("vault_objects"))) {
      const sets = [];
      const args = [];

      const add = async (col, val, isSqlNow = false) => {
        if (await dbHasColumn("vault_objects", col)) {
          sets.push(isSqlNow ? `${col}=NOW()` : `${col}=$${args.push(val)}`);
        }
      };

      await add("content_type", mimeType);
      await add("mime_type", mimeType);
      await add("bytes", sizeBytes);
      await add("size_bytes", sizeBytes);
      await add("size", sizeBytes);
      await add("updated_at", null, true);

      if (sets.length) {
        args.push(row.id);
        args.push(req.user.id);
        await safeQuery(`UPDATE vault_objects SET ${sets.join(", ")} WHERE id=$${args.length - 1} AND user_id=$${args.length}`, args).catch(() => {});
      }
    }

    return res.json({ ok: true, id: row.id, sizeBytes, mimeType });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/vault/file-local/:id", requireAuth, async (req, res) => {
  try {
    const key = decodeURIComponent(req.params.id || "");
    if (!key.startsWith("local/")) return res.status(400).json({ ok: false, error: "Not a local object id" });

    const parts = key.split("/");
    const userId = parts[1];
    // Only allow owner to read their own local files
    if (String(req.user.id) !== String(userId)) return res.status(403).json({ ok: false, error: "Forbidden" });

    const rel = parts.slice(2).join("/");
    const base = path.join(__dirname, "uploads", "vault", String(userId));
    const abs = path.normalize(path.join(base, rel));
    if (!abs.startsWith(base)) return res.status(400).json({ ok: false, error: "Invalid path" });

    if (!fs.existsSync(abs)) return res.status(404).json({ ok: false, error: "File not found" });

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${path.basename(abs)}"`);
    fs.createReadStream(abs).pipe(res);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Delete: S3 + DB
app.delete("/api/vault/file/:id", requireAuth, async (req, res) => {
  try {
    const idOrKey = decodeURIComponent(req.params.id || "");
    const row = await resolveVaultObject(req.user.id, idOrKey);
    if (!row) return res.status(404).json({ ok: false, error: "Not found" });

    const key = row.storage_key || row.s3_key || row.key || idOrKey;

    // Delete bytes
    try {
      if (String(key).startsWith("local/")) {
        const rel = key.replace(/^local\/[^/]+\//, "");
        const abs = path.join(__dirname, "uploads", "vault", String(req.user.id), rel);
        if (fs.existsSync(abs)) fs.unlinkSync(abs);
      } else {
        requireAwsEnvOrThrow();
        await s3.send(new DeleteObjectCommand({ Bucket: vaultBucket, Key: key }));
      }
    } catch {}

    // Soft-delete metadata
    if (row._src === "vault_files" && (await dbHasTable("vault_files"))) {
      await safeQuery(
        `UPDATE vault_files SET deleted_at=NOW(), updated_at=NOW() WHERE id=$1 AND user_id=$2`,
        [row.id, req.user.id]
      ).catch(() => {});
      return res.json({ ok: true });
    }

    if (row._src === "vault_objects" && (await dbHasTable("vault_objects"))) {
      const hasDeletedAt = await dbHasColumn("vault_objects", "deleted_at");
      const hasUpdatedAt = await dbHasColumn("vault_objects", "updated_at");

      if (hasDeletedAt || hasUpdatedAt) {
        const sets = [];
        if (hasDeletedAt) sets.push("deleted_at=NOW()");
        if (hasUpdatedAt) sets.push("updated_at=NOW()");
        await safeQuery(
          `UPDATE vault_objects SET ${sets.join(", ")} WHERE id=$1 AND user_id=$2`,
          [row.id, req.user.id]
        ).catch(() => {});
      }
      return res.json({ ok: true });
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
// ================================
// Vault Explorer Ops (folders + move/rename/delete)
// ================================

function isUuidLike(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(s || ""));
}

async function resolveVaultObject(userId, idOrKey) {
  // Resolves a file either from the NEW schema (vault_files) or legacy schema (vault_objects).
  // Returns a row with an extra field: _src = 'vault_files' | 'vault_objects'
  const raw = String(idOrKey || "").trim();
  if (!raw) return null;

  // 0) NEW schema: vault_files
  if (await dbHasTable("vault_files")) {
    try {
      // by UUID id
      if (isUuidLike(raw)) {
        const r = await safeQuery(
          `SELECT *, 'vault_files'::text AS _src
           FROM vault_files
           WHERE user_id=$1 AND id=$2 AND deleted_at IS NULL
           LIMIT 1`,
          [userId, raw]
        );
        if (r.rows?.[0]) return r.rows[0];
      }

      // by storage_key (rare, but helps for file-proxy cases)
      if (await dbHasColumn("vault_files", "storage_key")) {
        const r2 = await safeQuery(
          `SELECT *, 'vault_files'::text AS _src
           FROM vault_files
           WHERE user_id=$1 AND storage_key=$2 AND deleted_at IS NULL
           LIMIT 1`,
          [userId, raw]
        );
        if (r2.rows?.[0]) return r2.rows[0];
      }
    } catch {}
  }

  // 1) Legacy: vault_objects
  // 1a) by UUID id
  if (isUuidLike(raw) && (await dbHasTable("vault_objects"))) {
    try {
      const whereDeleted = (await dbHasColumn("vault_objects", "deleted_at")) ? "AND deleted_at IS NULL" : "";
      const r = await safeQuery(
        `SELECT *, 'vault_objects'::text AS _src
         FROM vault_objects
         WHERE user_id=$1 AND id=$2 ${whereDeleted}
         LIMIT 1`,
        [userId, raw]
      );
      if (r.rows?.[0]) return r.rows[0];
    } catch {}
  }

  // 1b) by key/s3_key
  if (await dbHasTable("vault_objects")) {
    try {
      const parts = [];
      const args = [userId, raw];
      const hasKey = await dbHasColumn("vault_objects", "key");
      const hasS3Key = await dbHasColumn("vault_objects", "s3_key");
      if (hasKey) parts.push("key=$2");
      if (hasS3Key) parts.push("s3_key=$2");
      if (parts.length) {
        const whereDeleted = (await dbHasColumn("vault_objects", "deleted_at")) ? "AND deleted_at IS NULL" : "";
        const r = await safeQuery(
          `SELECT *, 'vault_objects'::text AS _src
           FROM vault_objects
           WHERE user_id=$1 AND (${parts.join(" OR ")}) ${whereDeleted}
           LIMIT 1`,
          args
        );
        if (r.rows?.[0]) return r.rows[0];
      }
    } catch {}
  }

  return null;
}

function buildFolderTree(paths) {
  const root = { name: "", path: "", children: [] };
  const map = new Map(); // path -> node
  map.set("", root);

  (paths || []).forEach((p) => {
    const clean = safeCleanFolder(p);
    if (!clean) return;
    const segs = clean.split("/").filter(Boolean);
    let curPath = "";
    let parent = root;

    for (const seg of segs) {
      const nextPath = curPath ? `${curPath}/${seg}` : seg;
      let node = map.get(nextPath);
      if (!node) {
        node = { name: seg, path: nextPath, children: [] };
        map.set(nextPath, node);
        parent.children.push(node);
        parent.children.sort((a, b) => a.name.localeCompare(b.name));
      }
      parent = node;
      curPath = nextPath;
    }
  });

  return root;
}

async function ensureFolderRow(userId, folderPath) {
  // Creates/ensures a logical folder exists for this user.
  // Returns folder_id for the NEW schema (vault_folders tree). For legacy schema, returns null.
  if (!(await dbHasTable("vault_folders"))) return null;

  // New schema (tree folders + vault_files)
  if ((await vaultHasNewSchema()) && (await vaultFoldersHaveTreeColumns())) {
    const key = normVaultFolderKey(folderPath);
    return await ensureVaultFolderPath(userId, key);
  }

  // Legacy schema: vault_folders(user_id, path)
  const p = safeCleanFolder(folderPath);
  if (!p) return null;

  try {
    await safeQuery(
      `INSERT INTO vault_folders (user_id, path) VALUES ($1, $2) ON CONFLICT (user_id, path) DO NOTHING`,
      [userId, p]
    );
  } catch {
    // If unique constraint differs, ignore duplicate errors.
    await safeQuery(`INSERT INTO vault_folders (user_id, path) VALUES ($1, $2)`, [userId, p]).catch(() => {});
  }
  return null;
}

// GET folders (for left tree)
app.get("/api/vault/folders", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    // Ensure root/working exist (Trash is disabled inside this helper)
    if ((await vaultHasNewSchema()) && (await vaultFoldersHaveTreeColumns())) {
      await ensureVaultRootTrashWorking(userId);

      // 1) Collect folders from vault_folders (authoritative)
      const fr = await safeQuery(
        `SELECT path
         FROM vault_folders
         WHERE user_id=$1 AND deleted_at IS NULL AND (trashed_at IS NULL)
         ORDER BY path ASC`,
        [userId]
      ).catch(() => ({ rows: [] }));

      const fromFolders = (fr.rows || [])
        .map((x) => String(x.path || ""))
        .filter((p) => p && p !== "" && p !== "__root__");

      // 2) Collect folders from vault_files.folder_path (keeps Office stable even if folder rows drift)
      let fromFiles = [];
      try {
        const rr = await safeQuery(
          `SELECT DISTINCT COALESCE(folder_path,'') AS path
           FROM vault_files
           WHERE user_id=$1 AND deleted_at IS NULL AND (trashed_at IS NULL)`,
          [userId]
        ).catch(() => ({ rows: [] }));
        fromFiles = (rr.rows || [])
          .map((x) => String(x.path || ""))
          .filter((p) => p && p !== "");
      } catch {}

      const isTrashPath = (p) => String(p || "").trim().toLowerCase() === "_trash"
        || String(p || "").trim().toLowerCase().startsWith("_trash/");

      // Deduplicate case-insensitively, preferring explicit folder rows over derived file paths
      const pick = new Map(); // lower -> {path, priority}
      const add = (p, priority) => {
        const n = safeCleanFolder(p);
        if (!n || n === "__root__") return;
        if (isTrashPath(n)) return;
        const k = n.toLowerCase();
        const cur = pick.get(k);
        if (!cur || priority > cur.priority) pick.set(k, { path: n, priority });
      };

      fromFolders.forEach((p) => add(p, 2));
      fromFiles.forEach((p) => add(p, 1));

      // Ensure parents exist
      const outSet = new Map(); // lower -> path
      for (const { path } of pick.values()) {
        let cur = path;
        while (cur) {
          const k = cur.toLowerCase();
          if (!outSet.has(k)) outSet.set(k, cur);
          if (!cur.includes("/")) break;
          cur = cur.split("/").slice(0, -1).join("/");
        }
      }

      const folders = Array.from(outSet.values()).sort((a, b) => a.localeCompare(b));
      return res.json({ ok: true, folders });
    }

    // Legacy schema fallback: do NOT inject Trash. Return whatever exists, or empty list.
    if (!(await dbHasTable("vault_folders"))) return res.json({ ok: true, folders: [] });

    const r = await safeQuery(
      `SELECT path FROM vault_folders WHERE user_id=$1 ORDER BY path ASC`,
      [userId]
    ).catch(() => ({ rows: [] }));

    const folders = (r.rows || [])
      .map((x) => String(x.path || ""))
      .filter((p) => p && p !== "" && p !== "__root__" && p.toLowerCase() !== "_trash" && !p.toLowerCase().startsWith("_trash/"));

    res.json({ ok: true, folders });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
// POST file move/rename (DB-first; S3 key stays stable)
app.post("/api/vault/file/move", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    const idsFromArray = Array.isArray(req.body?.ids) ? req.body.ids : null;
    const singleId = String(req.body?.id || "").trim();
    const ids = (idsFromArray && idsFromArray.length)
      ? idsFromArray.map(x => String(x || "").trim()).filter(Boolean)
      : (singleId ? [singleId] : []);

    if (!ids.length) return res.status(400).json({ ok: false, error: "Missing id" });
    const bad = ids.find(x => !isUuid(x));
    if (bad) return res.status(400).json({ ok: false, error: "Invalid id" });

    const toRaw = String(req.body?.toFolderPath ?? req.body?.folderPath ?? req.body?.folder ?? "").trim();
    const toKey = normVaultFolderKey(toRaw);

    // Optional rename (metadata only; storage_key is unchanged)
    const newNameRaw = String(req.body?.newName ?? req.body?.name ?? "").trim();
    const newBaseName = newNameRaw ? String(newNameRaw).replace(/\\/g, "/").split("/").slice(-1)[0] : "";
    const newName = newBaseName ? newBaseName.replace(/\0/g, "").replace(/[\/\\]/g, "").trim().slice(0, 255) : "";
    const newExt = newName ? safeExtFromName(newName) : "";

    // NEW schema
    if ((await dbHasTable("vault_files")) && (await vaultHasNewSchema()) && (await vaultFoldersHaveTreeColumns())) {
      const { trashId } = await ensureVaultRootTrashWorking(userId);
      const destId = await ensureVaultFolderPath(userId, toKey);

      let moved = 0;

      for (const id of ids) {
        if (toKey === "_Trash") {
          const r = await safeQuery(
            `UPDATE vault_files
             SET trashed_at=NOW(),
                 folder_path='_Trash',
                 folder_id=$3,
                 name=CASE WHEN $4<>'' THEN $4 ELSE name END,
                 ext=CASE WHEN $5<>'' THEN $5 ELSE ext END,
                 updated_at=NOW()
             WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL
             RETURNING id`,
            [id, userId, trashId || destId, newName, newExt]
          );
          if (r.rows?.length) moved++;
          continue;
        }

        // Move out of trash (or normal move)
        const r = await safeQuery(
          `UPDATE vault_files
           SET trashed_at=NULL,
               folder_path=$3,
               folder_id=$4,
               name=CASE WHEN $5<>'' THEN $5 ELSE name END,
               ext=CASE WHEN $6<>'' THEN $6 ELSE ext END,
               updated_at=NOW()
           WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL
           RETURNING id`,
          [id, userId, toKey || "", destId, newName, newExt]
        );
        if (r.rows?.length) moved++;
      }

      if (!moved) return res.status(404).json({ ok: false, error: "Not found" });
      return res.json({ ok: true, moved });
    }

    // Legacy schema
    const folderPath = safeCleanFolder(toRaw);
    if (folderPath && folderPath !== "_Trash") await ensureFolderRow(userId, folderPath);

    if (!(await dbHasTable("vault_objects"))) return res.status(404).json({ ok: false, error: "Not found" });

    let moved = 0;

    for (const id of ids) {
      const sets = [];
      const args = [];
      const add = async (col, val) => {
        if (await dbHasColumn("vault_objects", col)) sets.push(`${col}=$${args.push(val)}`);
      };

      await add("folder", folderPath);
      await add("folder_path", folderPath);

      // Optional rename columns (best-effort)
      if (newName) {
        await add("name", newName);
        await add("filename", newName);
        await add("original_name", newName);
        await add("display_name", newName);
        await add("ext", newExt);
      }

      if ((await dbHasColumn("vault_objects", "trashed_at"))) {
        if (folderPath === "_Trash") sets.push("trashed_at=NOW()");
        else sets.push("trashed_at=NULL");
      }

      if (!sets.length) { moved++; continue; }

      args.push(id, userId);
      const r = await safeQuery(
        `UPDATE vault_objects SET ${sets.join(", ")} WHERE id=$${args.length - 1} AND user_id=$${args.length}`,
        args
      );
      if (r.rowCount) moved++;
    }

    if (!moved) return res.status(404).json({ ok: false, error: "Not found" });
    res.json({ ok: true, moved });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
// POST folder move/rename (updates folder paths + file folder fields)
app.post("/api/vault/folder/move", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const fromRaw = String(req.body?.from || req.body?.fromPath || "").trim();
    const toRaw = String(req.body?.to || req.body?.toPath || "").trim();

    const fromKey = normVaultFolderKey(fromRaw);
    const toKey = normVaultFolderKey(toRaw);

    if (!fromKey) return res.status(400).json({ ok: false, error: "Missing from" });
    if (!toKey) return res.status(400).json({ ok: false, error: "Missing to" });
    if (fromKey === "_Trash" || toKey === "_Trash") return res.status(400).json({ ok: false, error: "Use delete/trash flow for _Trash." });

    // NEW schema (supports nesting + recursive updates)
    if ((await vaultHasNewSchema()) && (await vaultFoldersHaveTreeColumns())) {
      await ensureVaultRootTrashWorking(userId);

      const fromPath = fromKey;
      const toPath = toKey;

      if (toPath === fromPath) return res.json({ ok: true });
      if (toPath === fromPath || toPath.startsWith(fromPath + "/")) {
        return res.status(400).json({ ok: false, error: "Cannot move a folder into itself." });
      }

      const fr = await safeQuery(
        `SELECT id, parent_id, name, path FROM vault_folders
         WHERE user_id=$1 AND path=$2 AND deleted_at IS NULL
         LIMIT 1`,
        [userId, fromPath]
      ).catch(() => ({ rows: [] }));

      const folder = fr.rows?.[0];
      if (!folder) return res.json({ ok: true });

      const parts = toPath.split("/").filter(Boolean);
      const newName = parts.slice(-1)[0] || toPath;
      const parentPath = parts.slice(0, -1).join("/"); // "" means root

      const newParentId = await vaultFolderIdFromPath(userId, parentPath);
      if (!newParentId && parentPath !== "") {
        return res.status(404).json({ ok: false, error: "Destination parent folder not found." });
      }

      const finalParentId = newParentId || (await vaultFolderIdFromPath(userId, ""));

      const collision = await safeQuery(
        `SELECT 1 FROM vault_folders
         WHERE user_id=$1 AND parent_id=$2 AND lower(name)=lower($3)
           AND id<>$4 AND deleted_at IS NULL
         LIMIT 1`,
        [userId, finalParentId, newName, folder.id]
      ).catch(() => ({ rows: [] }));

      if (collision.rows?.length) {
        return res.status(409).json({ ok: false, error: "A folder with that name already exists in the destination." });
      }

      // Transaction: update folder + descendants + file folder_path strings
      await safeQuery("BEGIN").catch(() => {});
      try {
        await safeQuery(
          `UPDATE vault_folders
           SET parent_id=$3, name=$4, path=$5, updated_at=NOW()
           WHERE id=$1 AND user_id=$2`,
          [folder.id, userId, finalParentId, newName, toPath]
        );

        // Descendant folders: rewrite path prefix
        const likeDesc = fromPath + "/%";
        const startPos = (String(fromPath).length || 0) + 1;
        await safeQuery(
          `UPDATE vault_folders
           SET path=$2 || substring(path from $3), updated_at=NOW()
           WHERE user_id=$1 AND deleted_at IS NULL AND path LIKE $4`,
          [userId, toPath, startPos, likeDesc]
        ).catch(() => {});

        // Files: exact folder + descendants
        if (await dbHasTable("vault_files")) {
          await safeQuery(
            `UPDATE vault_files
             SET folder_path=$3, updated_at=NOW()
             WHERE user_id=$1 AND deleted_at IS NULL AND trashed_at IS NULL AND folder_path=$2`,
            [userId, fromPath, toPath]
          ).catch(() => {});

          await safeQuery(
            `UPDATE vault_files
             SET folder_path=$2 || substring(folder_path from $3), updated_at=NOW()
             WHERE user_id=$1 AND deleted_at IS NULL AND trashed_at IS NULL AND folder_path LIKE $4`,
            [userId, toPath, startPos, likeDesc]
          ).catch(() => {});
        }

        // Legacy objects (best-effort)
        if (await dbHasTable("vault_objects")) {
          const cols = [];
          if (await dbHasColumn("vault_objects", "folder")) cols.push("folder");
          if (await dbHasColumn("vault_objects", "folder_path")) cols.push("folder_path");
          for (const c of cols) {
            await safeQuery(
              `UPDATE vault_objects
               SET ${c}=$3
               WHERE user_id=$1 AND ${c}=$2`,
              [userId, fromPath, toPath]
            ).catch(() => {});

            await safeQuery(
              `UPDATE vault_objects
               SET ${c}=$2 || substring(${c} from $3)
               WHERE user_id=$1 AND ${c} LIKE $4`,
              [userId, toPath, startPos, likeDesc]
            ).catch(() => {});
          }
        }

        await safeQuery("COMMIT").catch(() => {});
        return res.json({ ok: true });
      } catch (e) {
        await safeQuery("ROLLBACK").catch(() => {});
        throw e;
      }
    }

    // Legacy schema
    const from = safeCleanFolder(fromRaw);
    const to = safeCleanFolder(toRaw);

    if (!(await dbHasTable("vault_folders"))) return res.status(501).json({ ok: false, error: "vault_folders not available" });

    await safeQuery(
      `UPDATE vault_folders SET path=$3 WHERE user_id=$1 AND path=$2`,
      [userId, from, to]
    ).catch(() => {});

    // Update files in that folder
    if (await dbHasTable("vault_objects")) {
      const cols = [];
      if (await dbHasColumn("vault_objects", "folder")) cols.push("folder");
      if (await dbHasColumn("vault_objects", "folder_path")) cols.push("folder_path");
      if (cols.length) {
        const set = cols.map((c) => `${c}=$3`).join(", ");
        await safeQuery(
          `UPDATE vault_objects SET ${set} WHERE user_id=$1 AND (${cols.map((c) => `${c}=$2`).join(" OR ")})`,
          [userId, from, to]
        ).catch(() => {});
      }
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
// DELETE folder (recursive) + delete S3 objects
app.delete("/api/vault/folder", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const raw = String(req.body?.folderPath || req.body?.path || req.query?.path || "").trim();
    const folderKey = normVaultFolderKey(raw);
    const force = Boolean(req.body?.force || req.query?.force);
    const hard = Boolean(req.body?.hard || req.body?.hardDelete || req.query?.hard || req.query?.hardDelete);

    if (!folderKey) return res.status(400).json({ ok: false, error: "Cannot delete root." });
    if (folderKey === "_Trash") return res.status(400).json({ ok: false, error: "Cannot delete Trash." });

    // NEW schema
    if ((await vaultHasNewSchema()) && (await vaultFoldersHaveTreeColumns())) {
      // Trash is disabled.

      const fr = await safeQuery(
        `SELECT id FROM vault_folders
         WHERE user_id=$1 AND lower(path)=lower($2) AND deleted_at IS NULL
         LIMIT 1`,
        [userId, folderKey]
      ).catch(() => ({ rows: [] }));

      const folderId = fr.rows?.[0]?.id;
      if (!folderId) return res.json({ ok: true }); // already gone

      // Count descendants + files (case-insensitive path prefix)
      const fileCountR = await safeQuery(
        `SELECT count(*)::int AS c
         FROM vault_files
         WHERE user_id=$1
           AND (lower(COALESCE(folder_path,''))=lower($2) OR lower(COALESCE(folder_path,'')) LIKE lower($2 || '/%'))`,
        [userId, folderKey]
      ).catch(() => ({ rows: [{ c: 0 }] }));

      const childCountR = await safeQuery(
        `SELECT count(*)::int AS c
         FROM vault_folders
         WHERE user_id=$1 AND deleted_at IS NULL
           AND (lower(path) LIKE lower($2 || '/%'))`,
        [userId, folderKey]
      ).catch(() => ({ rows: [{ c: 0 }] }));

      const fileCount = fileCountR.rows?.[0]?.c || 0;
      const descendantFolders = childCountR.rows?.[0]?.c || 0;
      const totalFolders = descendantFolders + 1;

      if (!force && (fileCount > 0 || descendantFolders > 0)) {
        return res.json({ ok: true, needsConfirm: true, fileCount, folderCount: totalFolders });
      }

      if (hard) {
        // HARD delete: delete bytes + DB rows for files, then delete folder rows.
        const filesR = await safeQuery(
          `SELECT id, storage_key, s3_key, key
           FROM vault_files
           WHERE user_id=$1
             AND (lower(COALESCE(folder_path,''))=lower($2) OR lower(COALESCE(folder_path,'')) LIKE lower($2 || '/%'))`,
          [userId, folderKey]
        ).catch(() => ({ rows: [] }));

        for (const r of (filesR.rows || [])) {
          const key = r.storage_key || r.s3_key || r.key || r.id;
          try {
            if (String(key).startsWith("local/")) {
              const rel = String(key).replace(/^local\/[^/]+\//, "");
              const abs = path.join(__dirname, "uploads", "vault", String(userId), rel);
              if (fs.existsSync(abs)) fs.unlinkSync(abs);
            } else {
              requireAwsEnvOrThrow();
              await s3.send(new DeleteObjectCommand({ Bucket: vaultBucket, Key: key }));
            }
          } catch {}
        }

        await safeQuery(
          `DELETE FROM vault_files
           WHERE user_id=$1
             AND (lower(COALESCE(folder_path,''))=lower($2) OR lower(COALESCE(folder_path,'')) LIKE lower($2 || '/%'))`,
          [userId, folderKey]
        ).catch(() => {});

        // Best-effort legacy cleanup
        if (await dbHasTable("vault_objects")) {
          const cols = [];
          if (await dbHasColumn("vault_objects", "folder_path")) cols.push("folder_path");
          if (await dbHasColumn("vault_objects", "folder")) cols.push("folder");
          if (cols.length) {
            await safeQuery(
              `DELETE FROM vault_objects
               WHERE user_id=$1 AND (
                 ${cols.map((c) => `lower(COALESCE(${c},''))=lower($2) OR lower(COALESCE(${c},'')) LIKE lower($2 || '/%')`).join(' OR ')}
               )`,
              [userId, folderKey]
            ).catch(() => {});
          }
        }

        // Delete descendant folders first, then the folder itself (avoid FK issues)
        await safeQuery(
          `DELETE FROM vault_folders
           WHERE user_id=$1 AND (lower(path) LIKE lower($2 || '/%'))`,
          [userId, folderKey]
        ).catch(() => {});

        await safeQuery(
          `DELETE FROM vault_folders
           WHERE user_id=$1 AND (lower(path)=lower($2))`,
          [userId, folderKey]
        ).catch(() => {});

        return res.json({ ok: true, hardDeleted: true, deletedFiles: fileCount, deletedFolders: totalFolders });
      }

      // SOFT delete (kept for compatibility)
      await safeQuery(
        `UPDATE vault_folders
         SET deleted_at=NOW(), trashed_at=NULL, updated_at=NOW()
         WHERE user_id=$1 AND deleted_at IS NULL
           AND (lower(path)=lower($2) OR lower(path) LIKE lower($2 || '/%'))`,
        [userId, folderKey]
      ).catch(() => {});

      await safeQuery(
        `UPDATE vault_files
         SET deleted_at=NOW(), trashed_at=NULL, updated_at=NOW()
         WHERE user_id=$1 AND deleted_at IS NULL
           AND (lower(COALESCE(folder_path,''))=lower($2) OR lower(COALESCE(folder_path,'')) LIKE lower($2 || '/%'))`,
        [userId, folderKey]
      ).catch(() => {});

      return res.json({ ok: true });
    }

    // Legacy schema
    const folderPath = safeCleanFolder(raw);
    if (!folderPath) return res.status(400).json({ ok: false, error: "Invalid folder" });

    if (!(await dbHasTable("vault_folders"))) return res.status(501).json({ ok: false, error: "vault_folders not available" });

    // Legacy mode: hard-delete folder row only.
    await safeQuery(`DELETE FROM vault_folders WHERE user_id=$1 AND path=$2`, [userId, folderPath]).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Empty Trash (permanently deletes trashed files + soft-deletes trashed folders)
// - NEW schema: vault_files/vault_folders
// - Legacy schema: vault_objects (best-effort)
app.post("/api/vault/trash/empty", requireAuth, async (req, res) => {
  // Trash is disabled. Keep endpoint for backward compatibility.
  return res.json({ ok: true, deletedFiles: 0, deletedFolders: 0, trashDisabled: true });
});


// -------------------- SPA fallback --------------------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});


/* ================================
 * Secure Send (manual link + passcode) — No Twilio/Email dependency
 * ================================ */

async function secureSendEnsureTables(req, res) {
  const ok = await dbHasTable("secure_shares");
  if (!ok) {
    return res.status(501).json({
      ok: false,
      error: "Secure Send tables not found. Run secure_send_repair.sql / secure_send_migration.sql first.",
    });
  }
  return null;
}

async function logShareAudit(shareId, eventType, req, meta = {}) {
  try {
    if (!(await dbHasTable("secure_share_audits"))) return;
    await safeQuery(
      `INSERT INTO secure_share_audits (share_id, event_type, ip, user_agent, meta)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [
        shareId,
        String(eventType || "event"),
        (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").toString().split(",")[0].trim(),
        String(req.headers["user-agent"] || ""),
        JSON.stringify(meta || {}),
      ]
    );
  } catch {}
}

function extractObjectIds(body) {
  const candidates = [
    body?.object_ids,
    body?.objectIds,
    body?.item_ids,
    body?.itemIds,
    body?.file_ids,
    body?.fileIds,
    body?.ids,
    body?.selected,
    body?.selected_ids,
    body?.selectedIds,
    body?.queue,
    body?.queued,
    body?.queued_ids,
    body?.queuedIds,
  ];
  for (const c of candidates) {
    if (!c) continue;
    if (Array.isArray(c)) return c.map(String).filter(Boolean);
    if (typeof c === "string") {
      const parts = c.split(",").map((x) => x.trim()).filter(Boolean);
      if (parts.length) return parts;
    }
  }
  const single = body?.object_id || body?.objectId || body?.item_id || body?.itemId || body?.file_id || body?.fileId;
  if (single) return [String(single)];
  return [];
}

function computePermissions(body) {
  const b = body || {};
  const label =
    String(
      b?.permissions ||
      b?.permission ||
      b?.perm ||
      b?.mode ||
      b?.access ||
      b?.share_mode ||
      b?.permissionMode ||
      b?.permissionValue ||
      b?.permissionLabel ||
      b?.sharePermission ||
      ""
    )
      .trim()
      .toLowerCase();

  // Pull booleans if present
  let allowDownload = (b?.allow_download ?? b?.allowDownload ?? b?.download ?? b?.can_download ?? b?.canDownload);
  let allowPrint = (b?.allow_print ?? b?.allowPrint ?? b?.print ?? b?.can_print ?? b?.canPrint);

  // Normalize "unset" values
  const isUnset = (v) => v === undefined || v === null || v === "" || v === "null";
  if (isUnset(allowDownload)) allowDownload = undefined;
  if (isUnset(allowPrint)) allowPrint = undefined;

  // Always infer from label when label expresses capability (UI dropdowns often send default false booleans)
  if (/download/.test(label)) allowDownload = true;
  if (/print/.test(label)) allowPrint = true;

  // If still undefined, default false
  allowDownload = parseBool(allowDownload, false);
  allowPrint = parseBool(allowPrint, false);

  const permissions =
    allowDownload && allowPrint ? "view_download_print" :
    allowDownload ? "view_download" :
    allowPrint ? "view_print" :
    "view_only";

  return { permissions, allow_download: allowDownload, allow_print: allowPrint };
}

function pickShareFilename(vaultRow) {
  return (
    vaultRow?.original_name ||
    vaultRow?.filename ||
    vaultRow?.name ||
    vaultRow?.label ||
    vaultRow?.title ||
    "file"
  );
}

function pickShareContentType(vaultRow) {
  const raw = vaultRow?.content_type || vaultRow?.mime_type || vaultRow?.mimetype || vaultRow?.contentType || "";
  const filename = pickShareFilename(vaultRow);
  const lower = String(filename || "").toLowerCase();
  let ct = String(raw || "").trim();
  if (!ct || ct === "application/octet-stream") {
    if (lower.endsWith(".pdf")) ct = "application/pdf";
    else if (lower.endsWith(".png")) ct = "image/png";
    else if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) ct = "image/jpeg";
    else if (lower.endsWith(".webp")) ct = "image/webp";
    else if (lower.endsWith(".txt")) ct = "text/plain; charset=utf-8";
    else ct = "application/octet-stream";
  }
  return ct;
}

function pickShareSize(vaultRow) {
  const cands = [vaultRow?.size_bytes, vaultRow?.bytes, vaultRow?.size, vaultRow?.file_size];
  for (const c of cands) {
    const n = Number(c);
    if (Number.isFinite(n) && n >= 0) return Math.trunc(n);
  }
  return null;
}

function parseCookieHeader(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  const parts = String(cookieHeader).split(";");
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(v);
  }
  return out;
}

function setShareCookie(res, jwtToken, ttlSeconds) {
  const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";
  const parts = [
    `pdfrealm_share=${encodeURIComponent(jwtToken)}`,
    `Max-Age=${Math.max(60, Number(ttlSeconds) || 1800)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/api/secure-share",
  ];
  if (isProd) parts.push("Secure");
  // Do not overwrite unrelated cookies; express will handle multiple Set-Cookie headers if needed
  res.append("Set-Cookie", parts.join("; "));
}

function getShareAccessToken(req) {
  // Prefer Authorization header, else fall back to HttpOnly cookie set by /unlock
  const auth = req.headers["authorization"] || "";
  let tok = "";
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) tok = auth.slice(7).trim();

  if (!tok) {
    const cookies = parseCookieHeader(req.headers.cookie || "");
    tok = cookies.pdfrealm_share || "";
  }
  if (!tok) return null;

  try {
    const payload = jwt.verify(tok, SECURE_SEND_JWT_SECRET);
    if (payload?.scope !== "secure_share") return null;
    return payload;
  } catch {
    return null;
  }
}

function shareIsActive(row) {
  if (!row) return { ok: false, code: 404, error: "Share not found." };
  if (row.revoked_at) return { ok: false, code: 410, error: "Share revoked." };
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return { ok: false, code: 410, error: "Share expired." };
  if (row.max_views != null && Number(row.view_count || 0) >= Number(row.max_views)) return { ok: false, code: 410, error: "Share view limit reached." };
  return { ok: true };
}

async function handleCreateSecureShare(req, res) {
  try {
    const t = await secureSendEnsureTables(req, res);
    if (t) return;

    const objectIds = extractObjectIds(req.body);
    if (!objectIds.length) return res.status(400).json({ ok: false, error: "Select at least 1 file." });

    const { permissions, allow_download, allow_print } = computePermissions(req.body);

    const require_passcode = parseBool(req.body?.require_passcode ?? req.body?.requirePasscode, true);
    let passcode = String(req.body?.passcode || req.body?.code || "").trim();
    if (require_passcode && !passcode) passcode = String(crypto.randomInt(100000, 999999));
    const passcode_hash = require_passcode ? await bcrypt.hash(passcode, 12) : null;

    const token = randomToken(32);
    const token_hash = hmacTokenHex(token);
    const token_prefix = token.slice(0, 10);

    const expires_at = req.body?.expires_at || req.body?.expiresAt || null;
    const max_views = parseIntOrNull(req.body?.max_views ?? req.body?.maxViews);
    const one_time = parseBool(req.body?.one_time ?? req.body?.oneTime, false);
    const note = (req.body?.note || "").toString().slice(0, 2000) || null;
    const recipient_email = (req.body?.recipient_email || req.body?.recipientEmail || "").toString().slice(0, 320) || null;

    const id = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");

    const r = await safeQuery(
      `INSERT INTO secure_shares
        (id, owner_user_id, token_hash, token_prefix, object_ids, recipient_email, note,
         permissions, allow_download, allow_print, require_passcode, passcode_hash,
         expires_at, max_views, one_time)
       VALUES
        ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        id,
        req.user.id,
        token_hash,
        token_prefix,
        JSON.stringify(objectIds),
        recipient_email,
        note,
        permissions,
        allow_download,
        allow_print,
        require_passcode,
        passcode_hash,
        expires_at,
        max_views,
        one_time,
      ]
    );

    const base = getPublicBaseUrl();
    const share_url = `${base}/s/${token}`;

    await logShareAudit(r.rows?.[0]?.id || id, "create", req, { object_count: objectIds.length, allow_download, allow_print });

    return res.json({
      ok: true,
      id: r.rows?.[0]?.id || id,
      token,
      token_prefix,
      share_url,
      url: share_url,
      passcode: require_passcode ? passcode : null,
      require_passcode,
      permissions,
      allow_download,
      allow_print,
      expires_at,
      max_views,
      one_time,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

app.post("/api/secure-shares", requireAuth, handleCreateSecureShare);
app.post("/api/secure-send/create", requireAuth, handleCreateSecureShare);

app.get("/api/secure-shares", requireAuth, async (req, res) => {
  try {
    const t = await secureSendEnsureTables(req, res);
    if (t) return;

    const r = await safeQuery(
      `SELECT id, token_prefix, permissions, allow_download, allow_print, require_passcode,
              created_at, expires_at, revoked_at, view_count, max_views, one_time, note, recipient_email
       FROM secure_shares
       WHERE owner_user_id=$1
       ORDER BY created_at DESC
       LIMIT 200`,
      [req.user.id]
    );
    res.json({ ok: true, shares: r.rows || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
app.get("/api/secure-send/list", requireAuth, async (req, res) => {
  try {
    const t = await secureSendEnsureTables(req, res);
    if (t) return;
    const r = await safeQuery(
      `SELECT id, token_prefix, permissions, allow_download, allow_print, require_passcode,
              created_at, expires_at, revoked_at, view_count, max_views, one_time, note, recipient_email
       FROM secure_shares
       WHERE owner_user_id=$1
       ORDER BY created_at DESC
       LIMIT 200`,
      [req.user.id]
    );
    return res.json({ ok: true, shares: r.rows || [] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

async function handleRevokeShare(req, res) {
  try {
    const t = await secureSendEnsureTables(req, res);
    if (t) return;

    const id = String(req.params.id || "");
    await safeQuery(`UPDATE secure_shares SET revoked_at=NOW() WHERE id=$1 AND owner_user_id=$2`, [id, req.user.id]);
    await logShareAudit(id, "revoke", req, {});
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

app.post("/api/secure-shares/:id/revoke", requireAuth, handleRevokeShare);
app.post("/api/secure-send/:id/revoke", requireAuth, handleRevokeShare);

async function handleShareAudits(req, res) {
  try {
    if (!(await dbHasTable("secure_share_audits"))) return res.json({ ok: true, audits: [] });
    const id = String(req.params.id || "");
    // ensure owner
    const s = await safeQuery(`SELECT id FROM secure_shares WHERE id=$1 AND owner_user_id=$2 LIMIT 1`, [id, req.user.id]);
    if (!s.rows?.[0]) return res.status(404).json({ ok: false, error: "Not found." });

    const r = await safeQuery(
      `SELECT event_type, ip, user_agent, meta, created_at
       FROM secure_share_audits
       WHERE share_id=$1
       ORDER BY created_at DESC
       LIMIT 500`,
      [id]
    );
    return res.json({ ok: true, audits: r.rows || [] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

app.get("/api/secure-shares/:id/audits", requireAuth, handleShareAudits);
app.get("/api/secure-send/:id/audits", requireAuth, handleShareAudits);

// Public: share page
app.get("/s/:token", async (req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  return res.sendFile(path.join(__dirname, "public", "share.html"));
});

// Public: meta
app.get("/api/secure-share/:token/meta", async (req, res) => {
  try {
    const t = await secureSendEnsureTables(req, res);
    if (t) return;

    const token = String(req.params.token || "");
    const token_hash = hmacTokenHex(token);

    const r = await safeQuery(`SELECT * FROM secure_shares WHERE token_hash=$1 LIMIT 1`, [token_hash]);
    const row = r.rows?.[0];
    const active = shareIsActive(row);
    if (!active.ok) return res.status(active.code).json({ ok: false, error: active.error });

    await logShareAudit(row.id, "open", req, {});
    return res.json({
      ok: true,
      token_prefix: row.token_prefix,
      require_passcode: !!row.require_passcode,
      permissions: row.permissions || "view_only",
      allow_download: !!row.allow_download,
      allow_print: !!row.allow_print,
      expires_at: row.expires_at,
      revoked_at: row.revoked_at,
      view_count: row.view_count || 0,
      max_views: row.max_views,
      one_time: !!row.one_time,
      note: row.note || null,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Public: unlock
app.post("/api/secure-share/:token/unlock", async (req, res) => {
  try {
    const t = await secureSendEnsureTables(req, res);
    if (t) return;

    const token = String(req.params.token || "");
    const token_hash = hmacTokenHex(token);

    const r = await safeQuery(`SELECT * FROM secure_shares WHERE token_hash=$1 LIMIT 1`, [token_hash]);
    const row = r.rows?.[0];
    const active = shareIsActive(row);
    if (!active.ok) return res.status(active.code).json({ ok: false, error: active.error });

    if (row.require_passcode) {
      const passcode = String(req.body?.passcode || req.body?.code || "").trim();
      if (!passcode) return res.status(400).json({ ok: false, error: "Passcode required." });
      const ok = await bcrypt.compare(passcode, String(row.passcode_hash || ""));
      if (!ok) {
        await logShareAudit(row.id, "unlock_failed", req, {});
        return res.status(401).json({ ok: false, error: "Invalid passcode." });
      }
    }

    await safeQuery(`UPDATE secure_shares SET view_count=view_count+1 WHERE id=$1`, [row.id]).catch(() => {});
    if (row.one_time) {
      await safeQuery(`UPDATE secure_shares SET revoked_at=NOW() WHERE id=$1 AND revoked_at IS NULL`, [row.id]).catch(() => {});
    }

    const access_token = jwt.sign(
      { scope: "secure_share", share_id: row.id, token_hash },
      SECURE_SEND_JWT_SECRET,
      { expiresIn: Math.max(60, SECURE_SEND_ACCESS_TTL_SECONDS || 1800) }
    );

    // Set HttpOnly cookie so iframe/new-tab downloads can authenticate without Authorization headers
    setShareCookie(res, access_token, SECURE_SEND_ACCESS_TTL_SECONDS || 1800);

    await logShareAudit(row.id, "unlock", req, {});
    return res.json({
      ok: true,
      access_token,
      permissions: row.permissions || "view_only",
      allow_download: !!row.allow_download,
      allow_print: !!row.allow_print,
      require_passcode: !!row.require_passcode,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

async function requireShareAccessIfNeeded(share, token_hash, req, res) {
  if (!share.require_passcode) return true;
  const at = getShareAccessToken(req);
  if (!at || at.token_hash !== token_hash) {
    res.status(401).json({ ok: false, error: "Passcode required." });
    return false;
  }
  return true;
}

// Public: list files
app.get("/api/secure-share/:token/files", async (req, res) => {
  try {
    const t = await secureSendEnsureTables(req, res);
    if (t) return;

    const token = String(req.params.token || "");
    const token_hash = hmacTokenHex(token);

    const r = await safeQuery(`SELECT * FROM secure_shares WHERE token_hash=$1 LIMIT 1`, [token_hash]);
    const share = r.rows?.[0];
    const active = shareIsActive(share);
    if (!active.ok) return res.status(active.code).json({ ok: false, error: active.error });

    if (!(await requireShareAccessIfNeeded(share, token_hash, req, res))) return;

    const objectIds = Array.isArray(share.object_ids)
      ? share.object_ids
      : (() => { try { return JSON.parse(share.object_ids || "[]"); } catch { return []; } })();

    const rows = [];
    for (const oid of objectIds) {
      const row = await resolveVaultObject(share.owner_user_id, String(oid));
      if (row) rows.push(row);
    }

    const files = rows.map((row) => ({
      objectId: row.id || row.key || row.s3_key,
      name: pickShareFilename(row),
      contentType: pickShareContentType(row),
      size: pickShareSize(row),
      updatedAt: row.updated_at || row.created_at || null,
    }));

    return res.json({
      ok: true,
      permissions: share.permissions || "view_only",
      allow_download: !!share.allow_download,
      allow_print: !!share.allow_print,
      files,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Public: download/inline preview
app.get("/api/secure-share/:token/download/:objectId", async (req, res) => {
  try {
    const t = await secureSendEnsureTables(req, res);
    if (t) return;

    const token = String(req.params.token || "");
    const token_hash = hmacTokenHex(token);

    const r = await safeQuery(`SELECT * FROM secure_shares WHERE token_hash=$1 LIMIT 1`, [token_hash]);
    const share = r.rows?.[0];
    const active = shareIsActive(share);
    if (!active.ok) return res.status(active.code).json({ ok: false, error: active.error });

    if (!(await requireShareAccessIfNeeded(share, token_hash, req, res))) return;

    const inline = parseBool(req.query.inline, false);
    if (!inline && !share.allow_download) return res.status(403).json({ ok: false, error: "Download not allowed." });

    const oid = decodeURIComponent(req.params.objectId || "");
    const row = await resolveVaultObject(share.owner_user_id, oid);
    if (!row) return res.status(404).json({ ok: false, error: "File not found." });

    const key = row?.s3_key || row?.key || oid;
    const filename = pickShareFilename(row);
    const contentType = pickShareContentType(row);

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${String(filename).replace(/"/g, "")}"`);
    res.setHeader("Cache-Control", "no-store");

    await logShareAudit(share.id, inline ? "view" : "download", req, { objectId: row.id || oid });

    // Local storage
    if (String(key).startsWith("local/")) {
      const parts = String(key).split("/");
      const userId = parts[1];
      const rel = parts.slice(2).join("/");
      const base = path.join(__dirname, "uploads", "vault", String(userId));
      const abs = path.normalize(path.join(base, rel));
      if (!abs.startsWith(base)) return res.status(400).json({ ok: false, error: "Invalid path" });
      if (!fs.existsSync(abs)) return res.status(404).json({ ok: false, error: "File not found" });

      const stat = fs.statSync(abs);
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d+)-(\d*)/.exec(range);
        if (m) {
          const start = parseInt(m[1], 10);
          const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
          res.status(206);
          res.setHeader("Accept-Ranges", "bytes");
          res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
          res.setHeader("Content-Length", end - start + 1);
          return fs.createReadStream(abs, { start, end }).pipe(res);
        }
      }
      res.setHeader("Content-Length", stat.size);
      return fs.createReadStream(abs).pipe(res);
    }

    // S3 stream (supports Range)
    const range = req.headers.range;
    const cmd = new GetObjectCommand({ Bucket: vaultBucket, Key: key, ...(range ? { Range: range } : {}) });
    const obj = await s3.send(cmd);

    if (obj.ContentRange) {
      res.status(206);
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Range", obj.ContentRange);
    }
    if (obj.ContentLength != null) res.setHeader("Content-Length", obj.ContentLength);

    return obj.Body.pipe(res);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});


// -------------------- Secure Chat (Vault + Guest Invites) --------------------
// E2EE is performed client-side. Server stores ciphertext + attachment blobs only.

let chatSchemaEnsured = false;

async function chatEnsureSchema() {
  if (chatSchemaEnsured) return;
  chatSchemaEnsured = true;
  try {
    // pgcrypto is commonly available; if not, we fall back to server-side UUID generation.
    try { await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`); } catch (_) {}

    // Threads
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_threads (
        id uuid PRIMARY KEY,
        title text NOT NULL DEFAULT 'Room',
        created_by_user_id uuid,
        created_at timestamptz DEFAULT NOW(),
        updated_at timestamptz DEFAULT NOW(),
        key_wrap_salt text,
        key_wrap_nonce text,
        key_wrap_ciphertext text,
        deleted_at timestamptz
      );
    `);

    // Members
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_members (
        thread_id uuid NOT NULL,
        user_id uuid NOT NULL,
        role text DEFAULT 'member',
        created_at timestamptz DEFAULT NOW(),
        removed_at timestamptz,
        PRIMARY KEY (thread_id, user_id)
      );
    `);
    // Older schemas may have lacked created_at
    if (!(await dbHasColumn('chat_members', 'created_at'))) {
      await pool.query(`ALTER TABLE chat_members ADD COLUMN created_at timestamptz DEFAULT NOW();`);
    }
    if (!(await dbHasColumn('chat_members', 'removed_at'))) {
      await pool.query(`ALTER TABLE chat_members ADD COLUMN removed_at timestamptz;`);
    }
    if (!(await dbHasColumn('chat_members', 'role'))) {
      await pool.query(`ALTER TABLE chat_members ADD COLUMN role text DEFAULT 'member';`);
    }

    // Invites
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_invites (
        id uuid PRIMARY KEY,
        thread_id uuid NOT NULL,
        token_hash text NOT NULL UNIQUE,
        token_prefix text,
        allow_write boolean DEFAULT false,
        owner_user_id uuid,
        created_by_user_id uuid,
        created_at timestamptz DEFAULT NOW(),
        expires_at timestamptz,
        revoked_at timestamptz
      );
    `);
    // Ensure key columns exist even if table pre-existed
    const inviteCols = ['owner_user_id','created_by_user_id','token_prefix','allow_write','expires_at','revoked_at','created_at'];
    for (const c of inviteCols) {
      if (!(await dbHasColumn('chat_invites', c))) {
        // best-effort add
        if (c === 'allow_write') await pool.query(`ALTER TABLE chat_invites ADD COLUMN allow_write boolean DEFAULT false;`);
        else if (c === 'created_at') await pool.query(`ALTER TABLE chat_invites ADD COLUMN created_at timestamptz DEFAULT NOW();`);
        else await pool.query(`ALTER TABLE chat_invites ADD COLUMN ${c} ${c.endsWith('_user_id') ? 'uuid' : 'text'};`);
      }
    }

    // Guests
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_guests (
        id uuid PRIMARY KEY,
        thread_id uuid NOT NULL,
        display_name text,
        created_at timestamptz DEFAULT NOW(),
        revoked_at timestamptz
      );
    `);

    // Messages
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id uuid PRIMARY KEY,
        thread_id uuid NOT NULL,
        sender_kind text,
        sender_id text,
        sender_name text,
        ciphertext text,
        nonce text,
        iv text,
        client_ts text,
        created_at timestamptz DEFAULT NOW(),
        deleted_at timestamptz
      );
    `);
    const msgCols = ['sender_kind','sender_id','sender_name','ciphertext','nonce','iv','client_ts','created_at','deleted_at'];
    for (const c of msgCols) {
      if (!(await dbHasColumn('chat_messages', c))) {
        let typ = 'text';
        if (c === 'created_at') typ = 'timestamptz DEFAULT NOW()';
        else if (c === 'deleted_at') typ = 'timestamptz';
        await pool.query(`ALTER TABLE chat_messages ADD COLUMN ${c} ${typ};`);
      }
    }
    // Relax older NOT NULL iv constraints if present
    try { await pool.query(`ALTER TABLE chat_messages ALTER COLUMN iv DROP NOT NULL;`); } catch (_) {}

    // Attachments (encrypted blob storage)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_attachments (
        id uuid PRIMARY KEY,
        thread_id uuid NOT NULL,
        uploader_kind text,
        uploader_id text,
        uploader_name text,
        filename text,
        mime text,
        size bigint,
        object_key text,
        nonce text,
        created_at timestamptz DEFAULT NOW(),
        deleted_at timestamptz
      );
    `);

// ---- Schema drift repairs (idempotent)
const threadCols = [
  ["created_by_user_id", "uuid"],
  ["owner_user_id", "uuid"],
  ["pw_required", "boolean DEFAULT false"],
  ["key_wrap_salt", "text"],
  ["key_wrap_nonce", "text"],
  ["key_wrap_ciphertext", "text"],
  ["key_wrap_kdf", "text"],
  ["key_wrap_iter", "integer"],
  ["key_wrap_alg", "text"],
  ["updated_at", "timestamptz DEFAULT NOW()"]
];
for (const [c, typ] of threadCols) {
  if (!(await dbHasColumn("chat_threads", c))) {
    await pool.query(`ALTER TABLE chat_threads ADD COLUMN ${c} ${typ};`);
  }
}

const inviteColsDrift = [
  ["token_prefix", "text"],
  ["allow_write", "boolean DEFAULT true"],
  ["owner_user_id", "uuid"],
  ["created_by_user_id", "uuid"],
  ["expires_at", "timestamptz"],
  ["revoked_at", "timestamptz"],
  ["created_at", "timestamptz DEFAULT NOW()"]
];
for (const [c, typ] of inviteColsDrift) {
  if (!(await dbHasColumn("chat_invites", c))) {
    await pool.query(`ALTER TABLE chat_invites ADD COLUMN ${c} ${typ};`);
  }
}


const guestCols = [
  ["invite_id", "uuid"],
  ["guest_id", "text"],
  ["guest_name", "text"],
  ["invite_token_hash", "text"]
];
for (const [c, typ] of guestCols) {
  if (!(await dbHasColumn("chat_guests", c))) {
    await pool.query(`ALTER TABLE chat_guests ADD COLUMN ${c} ${typ};`);
  }
}
// Some earlier variants used display_name; ensure it's present.
if (!(await dbHasColumn("chat_guests", "display_name"))) {
  await pool.query(`ALTER TABLE chat_guests ADD COLUMN display_name text;`);
}
// Avoid hard failures if invite_id was accidentally set NOT NULL in a prior migration.
try { await pool.query(`ALTER TABLE chat_guests ALTER COLUMN invite_id DROP NOT NULL;`); } catch (_) {}

const attCols = [
  ["uploader_kind", "text"],
  ["uploader_id", "text"],
  ["uploader_name", "text"],
  ["filename", "text"],
  ["mime", "text"],
  ["mime_type", "text"],
  ["size", "bigint"],
  ["size_bytes", "bigint"],
  ["object_key", "text"],
  ["storage_key", "text"],
  ["nonce", "text"],
  ["deleted_at", "timestamptz"]
];
for (const [c, typ] of attCols) {
  if (!(await dbHasColumn("chat_attachments", c))) {
    await pool.query(`ALTER TABLE chat_attachments ADD COLUMN ${c} ${typ};`);
  }
}

// Presence table (who is currently active in a room)
await pool.query(`
  CREATE TABLE IF NOT EXISTS chat_presence (
    thread_id uuid NOT NULL,
    actor_kind text NOT NULL,
    actor_id text NOT NULL,
    actor_name text,
    last_seen timestamptz DEFAULT NOW(),
    PRIMARY KEY (thread_id, actor_kind, actor_id)
  );
`);
try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_presence_thread ON chat_presence (thread_id, last_seen);`); } catch (_) {}

    // Indexes (best-effort)
    try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members (user_id) WHERE removed_at IS NULL;`); } catch (_) {}
    try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages (thread_id) WHERE deleted_at IS NULL;`); } catch (_) {}
    try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_invites_thread ON chat_invites (thread_id) WHERE revoked_at IS NULL;`); } catch (_) {}

  } catch (e) {
    chatSchemaEnsured = false;
    console.error("Chat schema ensure error:", e?.message || e);
    throw e;
  }
}

function chatHashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function parseCookie(req, name) {
  const raw = req.headers.cookie || "";
  const m = raw.match(new RegExp("(?:^|;\\s*)" + name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&") + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : "";
}

function signChatGuestToken(payload) {
  const secret = process.env.CHAT_GUEST_SECRET || process.env.JWT_SECRET || "dev-secret";
  return jwt.sign(payload, secret, { expiresIn: "30d" });
}

function verifyChatGuestToken(token) {
  const secret = process.env.CHAT_GUEST_SECRET || process.env.JWT_SECRET || "dev-secret";
  return jwt.verify(token, secret);
}

function chatMaybeAuth(req, _res, next) {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) {
    const token = auth.slice("Bearer ".length);
    const secret = process.env.JWT_SECRET || "dev-secret";
    try {
      const payload = jwt.verify(token, secret);
      if (payload && payload.id) req.user = payload;
    } catch (_) {
      // ignore invalid token for mixed guest/member endpoints
    }
  }
  next();
}


async function chatGetUserMembership(threadId, userId) {
  const r = await pool.query(
    `SELECT role FROM chat_members WHERE thread_id=$1 AND user_id=$2 AND removed_at IS NULL`,
    [threadId, userId]
  );
  return r.rows[0] || null;
}

async function requireChatAccess(req, res, next) {
  try {
    await chatEnsureSchema();

    const threadId = req.params.threadId || req.params.id || req.body?.thread_id;
    if (!threadId) return res.status(400).json({ error: "Missing thread id." });

    // ensure thread exists + not deleted
    const t = await pool.query(`SELECT id, title, key_wrap_ciphertext, key_wrap_salt, key_wrap_nonce FROM chat_threads WHERE id=$1 AND deleted_at IS NULL`, [threadId]);
    if (!t.rows[0]) return res.status(404).json({ error: "Thread not found." });
    req.chatThread = t.rows[0];

    // Prefer authenticated user
    if (req.user && req.user.id) {
      const mem = await chatGetUserMembership(threadId, req.user.id);
      if (!mem) return res.status(403).json({ error: "Not a member of this room." });
      let displayName = (req.user.email || req.user.username || req.user.name || "").toString().trim();
      if (!displayName || displayName === "Member") {
        try {
          const ur = await pool.query(`SELECT email FROM users WHERE id=$1 LIMIT 1`, [req.user.id]);
          if (ur.rows && ur.rows[0] && ur.rows[0].email) displayName = String(ur.rows[0].email);
        } catch (_) {}
      }
      if (!displayName) displayName = `User ${String(req.user.id).slice(0,8)}`;
      req.chatActor = { kind: "user", id: req.user.id, name: displayName, role: mem.role || "member", allowWrite: true };
      try { await chatTouchPresence(threadId, req.chatActor); } catch (_) {}
      return next();
    }

    // Guest cookie
    const guestTok = parseCookie(req, "pdfrealm_chat_guest");
    if (!guestTok) return res.status(401).json({ error: "Not authorized for chat." });

    let payload = null;
    try { payload = verifyChatGuestToken(guestTok); } catch (e) { return res.status(401).json({ error: "Guest session expired." }); }

    if (!payload || payload.kind !== "guest" || payload.thread_id !== threadId) return res.status(403).json({ error: "Guest session invalid for this room." });

    req.chatActor = { kind: "guest", id: payload.guest_id, name: payload.display_name || "Guest", allowWrite: !!payload.allow_write };
    try { await chatTouchPresence(threadId, req.chatActor); } catch (_) {}
    return next();
  } catch (e) {
    console.error("Chat access error:", e);
    return res.status(500).json({ error: e?.message || "Chat access error" });
  }
}


async function chatTouchPresence(threadId, actor) {
  try {
    if (!threadId || !actor) return;
    const kind = String(actor.kind || "");
    const id = String(actor.id || "");
    if (!kind || !id) return;
    const name = String(actor.name || "");
    await pool.query(
      `INSERT INTO chat_presence (thread_id, actor_kind, actor_id, actor_name, last_seen)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (thread_id, actor_kind, actor_id)
       DO UPDATE SET actor_name=EXCLUDED.actor_name, last_seen=NOW()`,
      [threadId, kind, id, name]
    );
  } catch (_) {}
}

// ---- Chat API (members)
app.get("/api/chat/threads", requireAuth, async (req, res) => {
  try {
    await chatEnsureSchema();
    const userId = req.user.id;

    const q = `
      SELECT t.id, t.title, t.created_at, t.updated_at,
             (t.key_wrap_ciphertext IS NOT NULL) AS password_protected,
             COALESCE((
               SELECT MAX(m.created_at) FROM chat_messages m
               WHERE m.thread_id=t.id AND m.deleted_at IS NULL
             ), t.updated_at, t.created_at) AS last_message_at
      FROM chat_threads t
      JOIN chat_members mem ON mem.thread_id=t.id AND mem.user_id=$1 AND mem.removed_at IS NULL
      WHERE t.deleted_at IS NULL
      ORDER BY last_message_at DESC;
    `;
    const r = await pool.query(q, [userId]);
    res.json({ threads: r.rows });
  } catch (e) {
    console.error("Chat list threads error:", e?.message || e);
    res.status(500).json({ error: e?.message || "Failed to list threads" });
  }
});

app.post("/api/chat/threads", requireAuth, async (req, res) => {
  try {
    await chatEnsureSchema();
    const userId = req.user.id;
    const title = (req.body?.title || "Room").toString().slice(0, 120);

    const id = crypto.randomUUID();
    const kw = req.body?.key_wrap || null;

    await pool.query(
      `INSERT INTO chat_threads (id, title, created_by_user_id, key_wrap_salt, key_wrap_nonce, key_wrap_ciphertext)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, title, userId, kw?.salt || null, kw?.nonce || null, kw?.ciphertext || null]
    );

    await pool.query(
      `INSERT INTO chat_members (thread_id, user_id, role)
       VALUES ($1,$2,'owner')
       ON CONFLICT (thread_id, user_id) DO UPDATE SET removed_at=NULL, role='owner'`,
      [id, userId]
    );

    const thread = (await pool.query(`SELECT id, title, created_at, updated_at, (key_wrap_ciphertext IS NOT NULL) AS password_protected FROM chat_threads WHERE id=$1`, [id])).rows[0];
    res.json({ thread });
  } catch (e) {
    console.error("Chat create thread error:", e?.message || e, e?.sql || "");
    res.status(500).json({ error: e?.message || "Failed to create thread" });
  }
});

app.delete("/api/chat/threads/:id", requireAuth, async (req, res) => {
  try {
    await chatEnsureSchema();
    const userId = req.user.id;
    const threadId = req.params.id;

    const mem = await chatGetUserMembership(threadId, userId);
    if (!mem) return res.status(403).json({ error: "Not a member." });

    if ((mem.role || "") === "owner") {
      await pool.query(`UPDATE chat_threads SET deleted_at=NOW() WHERE id=$1`, [threadId]);
      await pool.query(`UPDATE chat_members SET removed_at=NOW() WHERE thread_id=$1`, [threadId]);
      await pool.query(`UPDATE chat_invites SET revoked_at=NOW() WHERE thread_id=$1 AND revoked_at IS NULL`, [threadId]);
      return res.json({ ok: true, mode: "deleted" });
    } else {
      await pool.query(`UPDATE chat_members SET removed_at=NOW() WHERE thread_id=$1 AND user_id=$2`, [threadId, userId]);
      return res.json({ ok: true, mode: "left" });
    }
  } catch (e) {
    console.error("Chat delete/leave error:", e?.message || e);
    res.status(500).json({ error: e?.message || "Failed to remove" });
  }
});

app.post("/api/chat/threads/:threadId/password", requireAuth, async (req, res) => {
  try {
    await chatEnsureSchema();
    const userId = req.user.id;
    const threadId = req.params.threadId;

    const mem = await chatGetUserMembership(threadId, userId);
    if (!mem || (mem.role || "") !== "owner") return res.status(403).json({ error: "Only the room owner can update password protection." });

    const mode = (req.body?.mode || "").toString();
    if (mode === "clear") {
      await pool.query(`UPDATE chat_threads SET key_wrap_salt=NULL, key_wrap_nonce=NULL, key_wrap_ciphertext=NULL, updated_at=NOW() WHERE id=$1`, [threadId]);
      return res.json({ ok: true, password_protected: false });
    }

    const kw = req.body?.key_wrap || null;
    if (!kw || !kw.salt || !kw.nonce || !kw.ciphertext) return res.status(400).json({ error: "Missing key_wrap fields." });

    await pool.query(
      `UPDATE chat_threads SET key_wrap_salt=$2, key_wrap_nonce=$3, key_wrap_ciphertext=$4, updated_at=NOW() WHERE id=$1`,
      [threadId, kw.salt, kw.nonce, kw.ciphertext]
    );
    res.json({ ok: true, password_protected: true });
  } catch (e) {
    console.error("Chat password error:", e?.message || e);
    res.status(500).json({ error: e?.message || "Failed to update password" });
  }
});

app.post("/api/chat/threads/:threadId/invites", requireAuth, async (req, res) => {
  try {
    await chatEnsureSchema();
    const userId = req.user.id;
    const threadId = req.params.threadId;

    const mem = await chatGetUserMembership(threadId, userId);
    if (!mem) return res.status(403).json({ error: "Not a member." });

    const allowWrite = !!req.body?.allow_write;
    const expiresIn = Number(req.body?.expires_in_seconds || 0);
    const expiresAt = expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null;

    // create token
    const token = crypto.randomBytes(24).toString("base64url");
    const tokenHash = chatHashToken(token);
    const prefix = token.slice(0, 8);
    const id = crypto.randomUUID();

    // Determine if room is password-protected
    const t = await pool.query(`SELECT key_wrap_ciphertext FROM chat_threads WHERE id=$1 AND deleted_at IS NULL`, [threadId]);
    const requiresPassword = !!(t.rows[0] && t.rows[0].key_wrap_ciphertext);

    await pool.query(
      `INSERT INTO chat_invites (id, thread_id, token_hash, token_prefix, allow_write, owner_user_id, created_by_user_id, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$6,$7)`,
      [id, threadId, tokenHash, prefix, allowWrite, userId, expiresAt]
    );

    res.json({ token, token_prefix: prefix, expires_at: expiresAt, allow_write: allowWrite, requires_password: requiresPassword });
  } catch (e) {
    console.error("Chat invite error:", e?.message || e, e?.sql || "");
    res.status(500).json({ error: e?.message || "Failed to create invite" });
  }
});

// ---- Invite endpoints (used by chat.html and Vault Join)
app.get("/api/chat-invite/:token/meta", async (req, res) => {
  try {
    await chatEnsureSchema();
    const token = String(req.params.token || "");
    const h = chatHashToken(token);

    const q = `
      SELECT i.thread_id, i.allow_write, i.expires_at, i.revoked_at,
             t.title, t.key_wrap_salt, t.key_wrap_nonce, t.key_wrap_ciphertext
      FROM chat_invites i
      JOIN chat_threads t ON t.id=i.thread_id
      WHERE i.token_hash=$1 AND i.revoked_at IS NULL AND t.deleted_at IS NULL
      LIMIT 1;
    `;
    const r = await pool.query(q, [h]);
    const row = r.rows[0];
    if (!row) return res.status(404).json({ error: "Invite not found." });
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return res.status(410).json({ error: "Invite expired." });

    const requiresPassword = !!row.key_wrap_ciphertext;

    res.json({
      thread_id: row.thread_id,
      allow_write: !!row.allow_write,
      requires_password: requiresPassword,
      thread: { id: row.thread_id, title: row.title, password_protected: requiresPassword },
      key_wrap: requiresPassword ? { salt: row.key_wrap_salt, nonce: row.key_wrap_nonce, ciphertext: row.key_wrap_ciphertext } : null
    });
  } catch (e) {
    console.error("Chat invite meta error:", e?.message || e);
    res.status(500).json({ error: e?.message || "Failed to load invite meta" });
  }
});

app.post("/api/chat-invite/:token/join", async (req, res) => {
  try {
    await chatEnsureSchema();
    const token = String(req.params.token || "");
    const h = chatHashToken(token);

    const r = await pool.query(
      `SELECT i.id AS invite_id, i.thread_id, i.allow_write, i.expires_at
       FROM chat_invites i
       JOIN chat_threads t ON t.id=i.thread_id
       WHERE i.token_hash=$1 AND i.revoked_at IS NULL AND t.deleted_at IS NULL
       LIMIT 1`,
      [h]
    );
    const inv = r.rows[0];
    if (!inv) return res.status(404).json({ error: "Invite not found." });
    if (inv.expires_at && new Date(inv.expires_at).getTime() < Date.now()) return res.status(410).json({ error: "Invite expired." });

    const guestId = crypto.randomUUID();
    const threadId = inv.thread_id;
    const displayName = (req.body?.display_name || "Guest").toString().slice(0, 80);

    const inviteId = inv.invite_id || null;
    await pool.query(
      `INSERT INTO chat_guests (id, thread_id, display_name, invite_id, guest_id, guest_name, invite_token_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [guestId, threadId, displayName, inviteId, guestId, displayName, h]
    );

    const guestJwt = signChatGuestToken({
      kind: "guest",
      guest_id: guestId,
      thread_id: threadId,
      display_name: displayName,
      allow_write: !!inv.allow_write
    });

    // HttpOnly cookie so the guest page can use same-origin fetch without storing secrets in JS.
    res.cookie("pdfrealm_chat_guest", guestJwt, { httpOnly: true, sameSite: "lax", secure: false, path: "/" });
    try { await chatTouchPresence(threadId, { kind: "guest", id: guestId, name: displayName }); } catch (_) {}
    res.json({ ok: true, thread_id: threadId, allow_write: !!inv.allow_write });
  } catch (e) {
    console.error("Chat invite join error:", e?.message || e);
    res.status(500).json({ error: e?.message || "Join failed" });
  }
});

// Accept invite as an authenticated member (Vault Join flow)
app.post("/api/chat-invite/:token/accept", requireAuth, async (req, res) => {
  try {
    await chatEnsureSchema();
    const userId = req.user.id;
    const token = String(req.params.token || "");
    const h = chatHashToken(token);

    const r = await pool.query(
      `SELECT i.thread_id, i.expires_at
       FROM chat_invites i
       JOIN chat_threads t ON t.id=i.thread_id
       WHERE i.token_hash=$1 AND i.revoked_at IS NULL AND t.deleted_at IS NULL
       LIMIT 1`,
      [h]
    );
    const inv = r.rows[0];
    if (!inv) return res.status(404).json({ error: "Invite not found." });
    if (inv.expires_at && new Date(inv.expires_at).getTime() < Date.now()) return res.status(410).json({ error: "Invite expired." });

    await pool.query(
      `INSERT INTO chat_members (thread_id, user_id, role)
       VALUES ($1,$2,'member')
       ON CONFLICT (thread_id, user_id) DO UPDATE SET removed_at=NULL`,
      [inv.thread_id, userId]
    );

    res.json({ ok: true, thread_id: inv.thread_id });
  } catch (e) {
    console.error("Chat invite accept error:", e?.message || e);
    res.status(500).json({ error: e?.message || "Accept failed" });
  }
});

// ---- Messages (members + guests)

app.post("/api/chat/threads/:threadId/presence", chatMaybeAuth, requireChatAccess, async (req, res) => {
  try {
    const threadId = req.params.threadId;
    await chatTouchPresence(threadId, req.chatActor);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Presence failed" });
  }
});

app.get("/api/chat/threads/:threadId/participants", chatMaybeAuth, requireChatAccess, async (req, res) => {
  try {
    const threadId = req.params.threadId;
    try { await chatTouchPresence(threadId, req.chatActor); } catch (_) {}
    const windowSec = Math.max(10, Math.min(600, Number(req.query.window_sec || 90)));
    const r = await pool.query(
      `SELECT actor_kind, actor_id, actor_name, last_seen
       FROM chat_presence
       WHERE thread_id=$1 AND last_seen > NOW() - ($2 || ' seconds')::interval
       ORDER BY last_seen DESC
       LIMIT 200`,
      [threadId, windowSec]
    );
    res.json({ ok: true, participants: r.rows });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Participants failed" });
  }
});

app.get("/api/chat/threads/:threadId/messages", chatMaybeAuth, requireChatAccess, async (req, res) => {
  try {
    const threadId = req.params.threadId;
    try { await chatTouchPresence(threadId, req.chatActor); } catch (_) {}
    const limit = Math.max(1, Math.min(500, Number(req.query.limit || 200)));

    const r = await pool.query(
      `SELECT id,
              sender_kind,
              sender_id,
              sender_name,
              ciphertext,
              COALESCE(nonce, iv) AS nonce,
              client_ts,
              created_at
       FROM chat_messages
       WHERE thread_id=$1 AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT $2`,
      [threadId, limit]
    );
    res.json({ messages: r.rows });
  } catch (e) {
    console.error("Chat get messages error:", e?.message || e);
    res.status(500).json({ error: e?.message || "Failed to load messages" });
  }
});

app.post("/api/chat/threads/:threadId/messages", chatMaybeAuth, requireChatAccess, async (req, res) => {
  try {
    const threadId = req.params.threadId;
    const actor = req.chatActor;
    try { await chatTouchPresence(threadId, actor); } catch (_) {}
    try { await chatTouchPresence(threadId, actor); } catch (_) {}

    if (actor.kind === "guest" && !actor.allowWrite) {
      return res.status(403).json({ error: "Invite is read-only." });
    }

    const ciphertext = (req.body?.ciphertext || req.body?.ciphertext_b64 || "").toString();
    const nonce = (req.body?.nonce || req.body?.nonce_b64 || "").toString();
    if (!ciphertext || !nonce) return res.status(400).json({ error: "Missing ciphertext/nonce." });

    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO chat_messages (id, thread_id, sender_kind, sender_id, sender_name, ciphertext, nonce, iv, client_ts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8)`,
      [id, threadId, actor.kind, String(actor.id || ""), String(actor.name || ""), ciphertext, nonce, new Date().toISOString()]
    );

    res.json({ ok: true, id });
  } catch (e) {
    console.error("Chat send message error:", e?.message || e);
    res.status(500).json({ error: e?.message || "Send failed" });
  }
});

// ---- Attachments (encrypted blobs)
app.post("/api/chat/threads/:threadId/attachments", chatMaybeAuth, requireChatAccess, upload.single("file"), async (req, res) => {
  try {
    const threadId = req.params.threadId;
    const actor = req.chatActor;
    try { await chatTouchPresence(threadId, actor); } catch (_) {}

    if (actor.kind === "guest" && !actor.allowWrite) {
      return res.status(403).json({ error: "Invite is read-only." });
    }

    if (!req.file || !req.file.buffer) return res.status(400).json({ error: "Missing file." });

    const attachmentId = crypto.randomUUID();
    const safeName = (req.body?.filename || req.file.originalname || "attachment").toString().replace(/[^\w.\- ]/g, "_").slice(0, 180);
    const mime = (req.body?.mime || req.file.mimetype || "application/octet-stream").toString().slice(0, 120);
    const size = Number(req.body?.size || req.file.size || req.file.buffer.length || 0);
    const nonce = (req.body?.nonce || "").toString();

    // Try S3 first if configured
    const objectKeyS3 = `chat/${threadId}/${attachmentId}_${safeName}`;
    let objectKey = "";

    const awsOk = Boolean(process.env.AWS_REGION && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && vaultBucket);

    if (awsOk) {
      try {
        await s3.send(new PutObjectCommand({
          Bucket: vaultBucket,
          Key: objectKeyS3,
          Body: req.file.buffer,
          ContentType: "application/octet-stream"
        }));
        objectKey = objectKeyS3;
      } catch (e) {
        console.warn("Chat attachment S3 upload failed; falling back to local:", e?.message || e);
      }
    }

    if (!objectKey) {
      const dir = path.join(__dirname, "uploads", "chat", threadId);
      await fs.promises.mkdir(dir, { recursive: true });
      const p = path.join(dir, `${attachmentId}.bin`);
      await fs.promises.writeFile(p, req.file.buffer);
      objectKey = `local/chat/${threadId}/${attachmentId}.bin`;
    }

    await pool.query(
      `INSERT INTO chat_attachments (id, thread_id, uploader_kind, uploader_id, uploader_name, filename, mime, size, object_key, nonce)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [attachmentId, threadId, actor.kind, String(actor.id || ""), String(actor.name || ""), safeName, mime, size, objectKey, nonce]
    );

    res.json({ ok: true, attachment_id: attachmentId, object_key: objectKey });
  } catch (e) {
    console.error("Chat attachment upload error:", e?.message || e);
    res.status(500).json({ error: e?.message || "Upload failed" });
  }
});

app.get("/api/chat/threads/:threadId/attachments/:attachmentId", chatMaybeAuth, requireChatAccess, async (req, res) => {
  try {
    const threadId = req.params.threadId;
    const attachmentId = req.params.attachmentId;

    const r = await pool.query(
      `SELECT id, object_key, filename FROM chat_attachments
       WHERE id=$1 AND thread_id=$2 AND deleted_at IS NULL
       LIMIT 1`,
      [attachmentId, threadId]
    );
    const row = r.rows[0];
    if (!row) return res.status(404).send("Not found");

    const key = row.object_key || "";
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${(row.filename || "attachment").replace(/"/g,'')}"`);

    if (key.startsWith("local/chat/")) {
      const p = path.join(__dirname, "uploads", "chat", threadId, `${attachmentId}.bin`);
      return res.sendFile(p);
    }

    const awsOk = Boolean(process.env.AWS_REGION && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && vaultBucket);
    if (!awsOk) return res.status(500).send("Storage not configured");

    const obj = await s3.send(new GetObjectCommand({ Bucket: vaultBucket, Key: key }));
    obj.Body.pipe(res);
  } catch (e) {
    console.error("Chat attachment download error:", e?.message || e);
    res.status(500).send(e?.message || "Download failed");
  }
});

// Guest entrypoint: /c/<token> serves chat.html (static file)
app.get("/c/:token", async (req, res) => {
  res.sendFile(path.join(__dirname, "public", "chat.html"));
});


// -------------------- SECURE VIDEO CHAT (WebRTC signaling + manual guest links) --------------------
let videoSchemaEnsured = false;

function videoGuestSecret() {
  return (
    process.env.VIDEO_GUEST_SECRET ||
    process.env.CHAT_GUEST_SECRET ||
    process.env.JWT_SECRET ||
    "dev-video-guest-secret"
  );
}

async function videoEnsureSchema() {
  if (videoSchemaEnsured) return;
  videoSchemaEnsured = true;

  // Ensure pgcrypto for gen_random_uuid
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

  // Rooms + membership
  await pool.query(`
    CREATE TABLE IF NOT EXISTS video_rooms (
      id uuid PRIMARY KEY,
      title text NOT NULL DEFAULT 'Video Room',
      owner_user_id uuid,
      created_by_user_id uuid,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW(),
      deleted_at timestamptz
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS video_members (
      room_id uuid NOT NULL,
      user_id uuid NOT NULL,
      role text NOT NULL DEFAULT 'member',
      created_at timestamptz NOT NULL DEFAULT NOW(),
      removed_at timestamptz,
      PRIMARY KEY (room_id, user_id)
    );
  `);

  // Invites (manual share links)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS video_invites (
      id uuid PRIMARY KEY,
      room_id uuid NOT NULL,
      token_hash text NOT NULL UNIQUE,
      token_prefix text,
      allow_write boolean NOT NULL DEFAULT true,
      owner_user_id uuid,
      created_by_user_id uuid,
      password_hash text,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      expires_at timestamptz,
      revoked_at timestamptz
    );
  `);

  // Guest sessions (optional)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS video_guests (
      id uuid PRIMARY KEY,
      room_id uuid NOT NULL,
      invite_id uuid,
      guest_id text,
      guest_name text,
      invite_token_hash text,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      last_seen timestamptz NOT NULL DEFAULT NOW()
    );
  `);

  // Presence for "who's online"
  await pool.query(`
    CREATE TABLE IF NOT EXISTS video_presence (
      room_id uuid NOT NULL,
      actor_kind text NOT NULL,
      actor_id text NOT NULL,
      actor_name text,
      peer_id text NOT NULL,
      last_seen timestamptz NOT NULL DEFAULT NOW(),
      PRIMARY KEY (room_id, actor_kind, actor_id, peer_id)
    );
  `);

  // Signaling messages (offer/answer/ice)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS video_signals (
      id bigserial PRIMARY KEY,
      room_id uuid NOT NULL,
      from_peer text,
      to_peer text,
      type text NOT NULL,
      payload jsonb,
      created_at timestamptz NOT NULL DEFAULT NOW()
    );
  `);


  // Encrypted file shares inside video rooms (ciphertext stored; client decrypts)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS video_files (
      id uuid PRIMARY KEY,
      room_id uuid NOT NULL,
      uploader_kind text NOT NULL,
      uploader_id text,
      uploader_name text,
      filename text,
      mime text,
      size bigint,
      object_key text NOT NULL,
      iv text,
      nonce text,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      deleted_at timestamptz
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_video_files_room_created ON video_files(room_id, created_at DESC);`);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_video_signals_room_id_id ON video_signals(room_id, id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_video_presence_room_seen ON video_presence(room_id, last_seen);`);

  // Drift protection (older local DBs)
  await pool.query(`ALTER TABLE video_rooms ADD COLUMN IF NOT EXISTS owner_user_id uuid;`).catch(()=>{});
  await pool.query(`ALTER TABLE video_rooms ADD COLUMN IF NOT EXISTS created_by_user_id uuid;`).catch(()=>{});
  await pool.query(`ALTER TABLE video_rooms ADD COLUMN IF NOT EXISTS created_at timestamptz;`).catch(()=>{});
  await pool.query(`ALTER TABLE video_rooms ADD COLUMN IF NOT EXISTS updated_at timestamptz;`).catch(()=>{});
  await pool.query(`ALTER TABLE video_rooms ADD COLUMN IF NOT EXISTS deleted_at timestamptz;`).catch(()=>{});

  await pool.query(`ALTER TABLE video_members ADD COLUMN IF NOT EXISTS role text;`).catch(()=>{});
  await pool.query(`ALTER TABLE video_members ADD COLUMN IF NOT EXISTS created_at timestamptz;`).catch(()=>{});
  await pool.query(`ALTER TABLE video_members ADD COLUMN IF NOT EXISTS removed_at timestamptz;`).catch(()=>{});

  await pool.query(`ALTER TABLE video_invites ADD COLUMN IF NOT EXISTS token_prefix text;`).catch(()=>{});
  await pool.query(`ALTER TABLE video_invites ADD COLUMN IF NOT EXISTS allow_write boolean;`).catch(()=>{});
  await pool.query(`ALTER TABLE video_invites ADD COLUMN IF NOT EXISTS owner_user_id uuid;`).catch(()=>{});
  await pool.query(`ALTER TABLE video_invites ADD COLUMN IF NOT EXISTS created_by_user_id uuid;`).catch(()=>{});
  await pool.query(`ALTER TABLE video_invites ADD COLUMN IF NOT EXISTS password_hash text;`).catch(()=>{});
  await pool.query(`ALTER TABLE video_invites ADD COLUMN IF NOT EXISTS created_at timestamptz;`).catch(()=>{});
  await pool.query(`ALTER TABLE video_invites ADD COLUMN IF NOT EXISTS expires_at timestamptz;`).catch(()=>{});
  await pool.query(`ALTER TABLE video_invites ADD COLUMN IF NOT EXISTS revoked_at timestamptz;`).catch(()=>{});

  await pool.query(`ALTER TABLE video_guests ADD COLUMN IF NOT EXISTS invite_id uuid;`).catch(()=>{});
  await pool.query(`ALTER TABLE video_guests ADD COLUMN IF NOT EXISTS guest_id text;`).catch(()=>{});
  await pool.query(`ALTER TABLE video_guests ADD COLUMN IF NOT EXISTS guest_name text;`).catch(()=>{});
  await pool.query(`ALTER TABLE video_guests ADD COLUMN IF NOT EXISTS invite_token_hash text;`).catch(()=>{});
  await pool.query(`ALTER TABLE video_guests ADD COLUMN IF NOT EXISTS created_at timestamptz;`).catch(()=>{});
  await pool.query(`ALTER TABLE video_guests ADD COLUMN IF NOT EXISTS last_seen timestamptz;`).catch(()=>{});
}

  // Drift protection for video_files
  await pool.query(`ALTER TABLE video_files ADD COLUMN IF NOT EXISTS room_id uuid;`).catch(()=>{});
  await pool.query(`ALTER TABLE video_files ADD COLUMN IF NOT EXISTS uploader_kind text;`).catch(()=>{});
  await pool.query(`ALTER TABLE video_files ADD COLUMN IF NOT EXISTS uploader_id text;`).catch(()=>{});
  await pool.query(`ALTER TABLE video_files ADD COLUMN IF NOT EXISTS uploader_name text;`).catch(()=>{});
  await pool.query(`ALTER TABLE video_files ADD COLUMN IF NOT EXISTS filename text;`).catch(()=>{});
  await pool.query(`ALTER TABLE video_files ADD COLUMN IF NOT EXISTS mime text;`).catch(()=>{});
  await pool.query(`ALTER TABLE video_files ADD COLUMN IF NOT EXISTS size bigint;`).catch(()=>{});
  await pool.query(`ALTER TABLE video_files ADD COLUMN IF NOT EXISTS object_key text;`).catch(()=>{});
  await pool.query(`ALTER TABLE video_files ADD COLUMN IF NOT EXISTS iv text;`).catch(()=>{});
  await pool.query(`ALTER TABLE video_files ADD COLUMN IF NOT EXISTS nonce text;`).catch(()=>{});
  await pool.query(`ALTER TABLE video_files ADD COLUMN IF NOT EXISTS created_at timestamptz;`).catch(()=>{});
  await pool.query(`ALTER TABLE video_files ADD COLUMN IF NOT EXISTS deleted_at timestamptz;`).catch(()=>{});


function videoHashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function signVideoGuestToken(payload) {
  return jwt.sign(payload, videoGuestSecret(), { expiresIn: "7d" });
}

function verifyVideoGuestToken(token) {
  try { return jwt.verify(token, videoGuestSecret()); } catch { return null; }
}

async function userIsVideoMember(roomId, userId) {
  const r = await pool.query(
    `SELECT role, removed_at FROM video_members WHERE room_id=$1 AND user_id=$2`,
    [roomId, userId]
  );
  if (!r.rowCount) return null;
  const row = r.rows[0];
  if (row.removed_at) return null;
  return { role: row.role || "member" };
}

async function requireVideoAccess(req, res, next) {
  try {
    await videoEnsureSchema();
    const roomId = req.params.roomId;

    if (!isUuid(roomId)) return res.status(400).json({ error: "Invalid room id." });

    // First: member auth (Bearer token)
    const user = await getUserFromRequest(req);
    if (user) {
      const mem = await userIsVideoMember(roomId, user.id);
      if (mem) {
        req.videoActor = { kind: "user", id: user.id, name: user.name || user.email || "Member", role: mem.role };
        return next();
      }
    }

    // Second: guest cookie (from invite link flow)
    const cookies = parseCookies(req);
    const guestJwt = cookies["pdfrealm_video_guest"];
    const payload = guestJwt ? verifyVideoGuestToken(guestJwt) : null;

    if (payload && payload.room_id === roomId && payload.invite_token_hash) {
      // validate invite still active
      const inv = await pool.query(
        `SELECT allow_write FROM video_invites
         WHERE token_hash=$1 AND room_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())`,
        [payload.invite_token_hash, roomId]
      );
      if (inv.rowCount) {
        req.videoActor = {
          kind: "guest",
          id: payload.guest_id || payload.sub || "guest",
          name: payload.guest_name || "Guest",
          role: "guest",
          invite_token_hash: payload.invite_token_hash,
          allow_write: !!inv.rows[0].allow_write
        };
        return next();
      }
    }

    

    // Third: stateless invite token (header/query) — helps when guest cookies are blocked (or not yet set)
    const rawInvite =
      (req.headers["x-video-invite"] ||
        (req.query && (req.query.invite || req.query.token)) ||
        "")
        .toString()
        .trim();

    if (rawInvite) {
      const tokenHash = videoHashToken(rawInvite);
      const inv2 = await pool.query(
        `SELECT allow_write FROM video_invites
         WHERE token_hash=$1 AND room_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())`,
        [tokenHash, roomId]
      );
      if (inv2.rowCount) {
        const guestNameHdr = (req.headers["x-guest-name"] || "").toString().slice(0, 80) || "Guest";
        req.videoActor = {
          kind: "guest",
          id: "link:" + tokenHash.slice(0, 16),
          name: guestNameHdr,
          role: "guest",
          invite_token_hash: tokenHash,
          allow_write: !!inv2.rows[0].allow_write
        };
        return next();
      }
    }
return res.status(401).json({ error: "Not logged in." });
  } catch (e) {
    console.error("Video access error:", e);
    return res.status(500).json({ error: "Video access error." });
  }
}

async function videoTouchPresence(roomId, actor, peerId, actorName) {
  const kind = actor.kind;
  const actorId = String(actor.id);
  const name = actorName || actor.name || (kind === "guest" ? "Guest" : "Member");
  const pid = String(peerId || "").trim();
  if (!pid) return;

  await pool.query(
    `INSERT INTO video_presence (room_id, actor_kind, actor_id, actor_name, peer_id, last_seen)
     VALUES ($1,$2,$3,$4,$5,NOW())
     ON CONFLICT (room_id, actor_kind, actor_id, peer_id)
     DO UPDATE SET actor_name=EXCLUDED.actor_name, last_seen=NOW()`,
    [roomId, kind, actorId, name, pid]
  );

  if (kind === "guest") {
    await pool.query(
      `UPDATE video_guests SET last_seen=NOW() WHERE room_id=$1 AND guest_id=$2`,
      [roomId, actorId]
    ).catch(()=>{});
  }
}

// Rooms list (members only)
app.get("/api/video/rooms", requireAuth, async (req, res) => {
  try {
    await videoEnsureSchema();
    const userId = req.user.id;

    // UUID validation guard - dev/non-UUID user IDs cause DB errors
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(userId || ""))) {
      return res.json({ rooms: [] });
    }

    const r = await pool.query(
      `SELECT vr.id, vr.title, vr.created_at, vr.updated_at
       FROM video_rooms vr
       JOIN video_members vm ON vm.room_id=vr.id
       WHERE vm.user_id=$1 AND vm.removed_at IS NULL AND vr.deleted_at IS NULL
       ORDER BY vr.updated_at DESC, vr.created_at DESC
       LIMIT 200`,
      [userId]
    );
    res.json({ rooms: r.rows });
  } catch (e) {
    console.error("Video rooms list error:", e);
    res.status(500).json({ error: "Failed to list rooms." });
  }
});

// Create room (members only)
app.post("/api/video/rooms", requireAuth, async (req, res) => {
  try {
    await videoEnsureSchema();
    const userId = req.user.id;
    const title = String((req.body && req.body.title) || "Video Room").slice(0, 120);
    const id = crypto.randomUUID();

    await pool.query(
      `INSERT INTO video_rooms (id, title, owner_user_id, created_by_user_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,NOW(),NOW())`,
      [id, title, userId, userId]
    );

    await pool.query(
      `INSERT INTO video_members (room_id, user_id, role, created_at)
       VALUES ($1,$2,'owner',NOW())
       ON CONFLICT (room_id, user_id) DO UPDATE SET removed_at=NULL, role='owner'`,
      [id, userId]
    );

    res.json({ room: { id, title } });
  } catch (e) {
    console.error("Video create room error:", e);
    res.status(500).json({ error: "Create failed: " + (e.message || "unknown") });
  }
});

// Remove room (soft delete; owner only)
app.delete("/api/video/rooms/:roomId", requireAuth, async (req, res) => {
  try {
    await videoEnsureSchema();
    const roomId = req.params.roomId;
    const userId = req.user.id;

    const r = await pool.query(`SELECT owner_user_id FROM video_rooms WHERE id=$1 AND deleted_at IS NULL`, [roomId]);
    if (!r.rowCount) return res.status(404).json({ error: "Room not found." });
    if (r.rows[0].owner_user_id && r.rows[0].owner_user_id !== userId) {
      return res.status(403).json({ error: "Not allowed." });
    }

    await pool.query(`UPDATE video_rooms SET deleted_at=NOW(), updated_at=NOW() WHERE id=$1`, [roomId]);
    res.json({ ok: true });
  } catch (e) {
    console.error("Video remove room error:", e);
    res.status(500).json({ error: "Remove failed." });
  }
});

// Create invite link (members only)
app.post("/api/video/rooms/:roomId/invites", requireAuth, async (req, res) => {
  try {
    await videoEnsureSchema();
    const roomId = req.params.roomId;
    const userId = req.user.id;

    const mem = await userIsVideoMember(roomId, userId);
    if (!mem) return res.status(403).json({ error: "Not a member." });

    // confirm room exists and not deleted
    const room = await pool.query(`SELECT id, title, owner_user_id FROM video_rooms WHERE id=$1 AND deleted_at IS NULL`, [roomId]);
    if (!room.rowCount) return res.status(404).json({ error: "Room not found." });

    const allowWrite = req.body && typeof req.body.allow_write === "boolean" ? !!req.body.allow_write : true;
    const expiresIn = Number(req.body && req.body.expires_in_seconds) || 0;
    const password = req.body && req.body.password ? String(req.body.password) : null;

    const token = base64url(crypto.randomBytes(24));
    const tokenHash = videoHashToken(token);
    const tokenPrefix = token.slice(0, 8);
    const inviteId = crypto.randomUUID();
    const ownerUserId = room.rows[0].owner_user_id || userId;

    let passwordHash = null;
    if (password && password.trim()) {
      passwordHash = await bcrypt.hash(password.trim(), 10);
    }

    const expiresAt = expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null;

    await pool.query(
      `INSERT INTO video_invites (id, room_id, token_hash, token_prefix, allow_write, owner_user_id, created_by_user_id, password_hash, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9)`,
      [inviteId, roomId, tokenHash, tokenPrefix, allowWrite, ownerUserId, userId, passwordHash, expiresAt]
    );

    res.json({ id: inviteId, token, token_prefix: tokenPrefix, expires_at: expiresAt, password_required: !!passwordHash });
  } catch (e) {
    console.error("Video invite error:", e);
    res.status(500).json({ error: "Invite failed: " + (e.message || "unknown") });
  }
});

// Public: invite meta (guest preflight)
app.get("/api/video-invite/:token/meta", async (req, res) => {
  try {
    await videoEnsureSchema();
    const token = req.params.token;
    const tokenHash = videoHashToken(token);

    const r = await pool.query(
      `SELECT vi.room_id, vr.title, vi.expires_at, vi.password_hash IS NOT NULL AS requires_password
       FROM video_invites vi
       JOIN video_rooms vr ON vr.id=vi.room_id
       WHERE vi.token_hash=$1 AND vi.revoked_at IS NULL
         AND (vi.expires_at IS NULL OR vi.expires_at > NOW())
         AND vr.deleted_at IS NULL`,
      [tokenHash]
    );
    if (!r.rowCount) return res.status(404).json({ error: "Invite not found or expired." });

    const row = r.rows[0];
    res.json({ room_id: row.room_id, title: row.title, expires_at: row.expires_at, requires_password: !!row.requires_password });
  } catch (e) {
    console.error("Video invite meta error:", e);
    res.status(500).json({ error: "Failed to load invite." });
  }
});

// Public: join via invite (sets guest cookie)
app.post("/api/video-invite/:token/join", async (req, res) => {
  try {
    await videoEnsureSchema();
    const token = req.params.token;
    const tokenHash = videoHashToken(token);

    const r = await pool.query(
      `SELECT vi.id, vi.room_id, vi.allow_write, vi.password_hash, vr.deleted_at
       FROM video_invites vi
       JOIN video_rooms vr ON vr.id=vi.room_id
       WHERE vi.token_hash=$1 AND vi.revoked_at IS NULL
         AND (vi.expires_at IS NULL OR vi.expires_at > NOW())`,
      [tokenHash]
    );
    if (!r.rowCount || r.rows[0].deleted_at) return res.status(404).json({ error: "Invite not found or expired." });

    const inv = r.rows[0];
    const guestName = (req.body && req.body.guest_name ? String(req.body.guest_name) : "").slice(0, 80) || null;

    if (inv.password_hash) {
      const pw = req.body && req.body.password ? String(req.body.password) : "";
      const ok = await bcrypt.compare(pw, inv.password_hash);
      if (!ok) return res.status(403).json({ error: "Invalid password." });
    }

    const guestId = base64url(crypto.randomBytes(12)); // short, URL-safe
    const guestRowId = crypto.randomUUID();

    await pool.query(
      `INSERT INTO video_guests (id, room_id, invite_id, guest_id, guest_name, invite_token_hash, created_at, last_seen)
       VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW())`,
      [guestRowId, inv.room_id, inv.id, guestId, guestName, tokenHash]
    );

    const guestJwt = signVideoGuestToken({
      room_id: inv.room_id,
      guest_id: guestId,
      guest_name: guestName,
      invite_token_hash: tokenHash,
      allow_write: !!inv.allow_write
    });

    res.cookie("pdfrealm_video_guest", guestJwt, {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.json({ ok: true, room_id: inv.room_id, guest_id: guestId });
  } catch (e) {
    console.error("Video invite join error:", e);
    res.status(500).json({ error: "Join failed: " + (e.message || "unknown") });
  }
});

// Public: serve invite page (/v/<token>)
app.get("/v/:token", async (req, res) => {
  res.sendFile(path.join(__dirname, "public", "video.html"));
});

// Presence (members or guests)
app.get("/api/video/rooms/:roomId/participants", requireVideoAccess, async (req, res) => {
  try {
    await videoEnsureSchema();
    const roomId = req.params.roomId;

    const r = await pool.query(
      `SELECT actor_kind, actor_id, actor_name, peer_id, last_seen
       FROM video_presence
       WHERE room_id=$1 AND last_seen > NOW() - INTERVAL '45 seconds'
       ORDER BY last_seen DESC
       LIMIT 200`,
      [roomId]
    );

    res.json({ participants: r.rows });
  } catch (e) {
    console.error("Video participants error:", e);
    res.status(500).json({ error: "Failed to load participants." });
  }
});

app.post("/api/video/rooms/:roomId/presence", requireVideoAccess, async (req, res) => {
  try {
    await videoEnsureSchema();
    const roomId = req.params.roomId;
    const peerId = req.body && req.body.peer_id ? String(req.body.peer_id) : "";
    const actorName = req.body && req.body.actor_name ? String(req.body.actor_name) : null;

    await videoTouchPresence(roomId, req.videoActor, peerId, actorName);
    res.json({ ok: true });
  } catch (e) {
    console.error("Video presence error:", e);
    res.status(500).json({ error: "Presence failed." });
  }
});

// Signaling (members or guests)
app.get("/api/video/rooms/:roomId/signals", requireVideoAccess, async (req, res) => {
  try {
    await videoEnsureSchema();
    const roomId = req.params.roomId;
    const sinceId = Number(req.query.since_id || 0) || 0;
    const peerId = req.query.peer_id ? String(req.query.peer_id) : null;

    const params = [roomId, sinceId];
    let where = `room_id=$1 AND id > $2`;
    if (peerId) {
      params.push(peerId);
      where += ` AND (to_peer IS NULL OR to_peer=$3)`;
    }

    const r = await pool.query(
      `SELECT id, from_peer, to_peer, type, payload, created_at
       FROM video_signals
       WHERE ${where}
       ORDER BY id ASC
       LIMIT 200`,
      params
    );

    res.json({ signals: r.rows });
  } catch (e) {
    console.error("Video signals get error:", e);
    res.status(500).json({ error: "Failed to load signals." });
  }
});

app.post("/api/video/rooms/:roomId/signals", requireVideoAccess, async (req, res) => {
  try {
    await videoEnsureSchema();
    const roomId = req.params.roomId;

    const fromPeer = req.body && req.body.from_peer ? String(req.body.from_peer) : null;
    const toPeer = req.body && req.body.to_peer ? String(req.body.to_peer) : null;
    const type = req.body && req.body.type ? String(req.body.type) : "";
    const payload = req.body && typeof req.body.payload !== "undefined" ? req.body.payload : null;

    if (!type || !["offer", "answer", "candidate"].includes(type)) {
      return res.status(400).json({ error: "Invalid signal type." });
    }

    await pool.query(
      `INSERT INTO video_signals (room_id, from_peer, to_peer, type, payload, created_at)
       VALUES ($1,$2,$3,$4,$5,NOW())`,
      [roomId, fromPeer, toPeer, type, payload]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error("Video signals post error:", e);
    res.status(500).json({ error: "Signal send failed." });
  }
});
// ------------------ VIDEO ROOM FILE SHARING (encrypted blobs) ------------------

// List shared files (members or guests)
app.get("/api/video/rooms/:roomId/files", requireVideoAccess, async (req, res) => {
  try {
    await videoEnsureSchema();
    const roomId = req.params.roomId;
    const r = await pool.query(
      `SELECT id, filename, mime, size, uploader_kind, uploader_id, uploader_name, iv, nonce, created_at
       FROM video_files
       WHERE room_id=$1 AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT 200`,
      [roomId]
    );
    res.json({ files: r.rows });
  } catch (e) {
    console.error("Video files list error:", e?.message || e);
    res.status(500).json({ error: "Failed to load files." });
  }
});

// Upload an encrypted file blob into the room (members or guests w/ allow_write)
app.post("/api/video/rooms/:roomId/files", requireVideoAccess, upload.single("file"), async (req, res) => {
  try {
    await videoEnsureSchema();
    const roomId = req.params.roomId;
    const actor = req.videoActor;

    try { await videoTouchPresence(roomId, actor, req.body?.peer_id || null, req.body?.actor_name || null); } catch (_) {}

    if (actor.kind === "guest" && !actor.allow_write) {
      return res.status(403).json({ error: "Invite is read-only." });
    }

    if (!req.file || !req.file.buffer) return res.status(400).json({ error: "Missing file." });

    const fileId = crypto.randomUUID();
    const safeName = (req.body?.filename || req.file.originalname || "file")
      .toString().replace(/[^\w.\- ]/g, "_").slice(0, 180);
    const mime = (req.body?.mime || req.file.mimetype || "application/octet-stream").toString().slice(0, 120);
    const size = Number(req.body?.size || req.file.size || req.file.buffer.length || 0);

    const iv = (req.body?.iv || "").toString().slice(0, 500);
    const nonce = (req.body?.nonce || iv || "").toString().slice(0, 500);

    // Try S3 first if configured
    const objectKeyS3 = `video/${roomId}/${fileId}_${safeName}`;
    let objectKey = "";

    const awsOk = Boolean(process.env.AWS_REGION && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && vaultBucket);
    if (awsOk) {
      try {
        await s3.send(new PutObjectCommand({
          Bucket: vaultBucket,
          Key: objectKeyS3,
          Body: req.file.buffer,
          ContentType: "application/octet-stream"
        }));
        objectKey = objectKeyS3;
      } catch (e) {
        console.warn("Video file S3 upload failed; falling back to local:", e?.message || e);
      }
    }

    if (!objectKey) {
      const dir = path.join(__dirname, "uploads", "video", roomId);
      await fs.promises.mkdir(dir, { recursive: true });
      const p = path.join(dir, `${fileId}.bin`);
      await fs.promises.writeFile(p, req.file.buffer);
      objectKey = `local/video/${roomId}/${fileId}.bin`;
    }

    await pool.query(
      `INSERT INTO video_files (id, room_id, uploader_kind, uploader_id, uploader_name, filename, mime, size, object_key, iv, nonce, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())`,
      [
        fileId,
        roomId,
        actor.kind || "user",
        String(actor.id || ""),
        String(actor.name || ""),
        safeName,
        mime,
        size,
        objectKey,
        iv || null,
        nonce || null
      ]
    );

    res.json({ ok: true, file_id: fileId });
  } catch (e) {
    console.error("Video file upload error:", e?.message || e);
    res.status(500).json({ error: e?.message || "Upload failed" });
  }
});

// Download encrypted blob (members or guests)
app.get("/api/video/rooms/:roomId/files/:fileId", requireVideoAccess, async (req, res) => {
  try {
    await videoEnsureSchema();
    const roomId = req.params.roomId;
    const fileId = req.params.fileId;

    const r = await pool.query(
      `SELECT id, object_key, filename
       FROM video_files
       WHERE id=$1 AND room_id=$2 AND deleted_at IS NULL
       LIMIT 1`,
      [fileId, roomId]
    );
    const row = r.rows[0];
    if (!row) return res.status(404).send("Not found");

    const key = row.object_key || "";
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${(row.filename || "file").replace(/"/g, "")}"`);

    if (key.startsWith("local/video/")) {
      const p = path.join(__dirname, "uploads", "video", roomId, `${fileId}.bin`);
      return res.sendFile(p);
    }

    const awsOk = Boolean(process.env.AWS_REGION && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && vaultBucket);
    if (!awsOk) return res.status(500).send("Storage not configured");

    const obj = await s3.send(new GetObjectCommand({ Bucket: vaultBucket, Key: key }));
    obj.Body.pipe(res);
  } catch (e) {
    console.error("Video file download error:", e?.message || e);
    res.status(500).send(e?.message || "Download failed");
  }
});

// ------------------ END VIDEO ROOM FILE SHARING ------------------


// ------------------ END SECURE VIDEO CHAT ------------------

// Express 5 safe catch-all
// ------------------ SECURE VOICE / VOIP (WebRTC audio) ------------------

let voiceSchemaEnsured = false;
async function voiceEnsureSchema() {
  if (voiceSchemaEnsured) return;
  voiceSchemaEnsured = true;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS voice_rooms (
      id uuid PRIMARY KEY,
      title text,
      owner_user_id uuid,
      created_by_user_id uuid,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW(),
      deleted_at timestamptz
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS voice_members (
      room_id uuid NOT NULL,
      user_id uuid NOT NULL,
      role text,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      removed_at timestamptz,
      PRIMARY KEY (room_id, user_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS voice_invites (
      id uuid PRIMARY KEY,
      room_id uuid NOT NULL,
      token_hash text NOT NULL,
      token_prefix text,
      allow_write boolean NOT NULL DEFAULT true,
      owner_user_id uuid,
      created_by_user_id uuid,
      password_hash text,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      expires_at timestamptz,
      revoked_at timestamptz
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS voice_guests (
      id uuid PRIMARY KEY,
      room_id uuid NOT NULL,
      invite_id uuid NOT NULL,
      guest_id text NOT NULL,
      guest_name text,
      invite_token_hash text,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      last_seen timestamptz NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS voice_presence (
      id uuid PRIMARY KEY,
      room_id uuid NOT NULL,
      actor_kind text NOT NULL,
      actor_id text NOT NULL,
      actor_name text,
      peer_id text,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      last_seen timestamptz NOT NULL DEFAULT NOW(),
      deleted_at timestamptz
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS voice_signals (
      id uuid PRIMARY KEY,
      room_id uuid NOT NULL,
      from_kind text NOT NULL,
      from_id text NOT NULL,
      from_name text,
      from_peer text,
      to_peer text,
      type text NOT NULL,
      payload jsonb,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      deleted_at timestamptz
    );
  `);
}

function voiceHashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function voiceGuestSecret() {
  return process.env.VOICE_GUEST_SECRET || process.env.JWT_SECRET || "dev-secret";
}

function signVoiceGuestToken(payload, opts = {}) {
  const expiresIn = opts.expiresIn || "7d";
  return jwt.sign(payload, voiceGuestSecret(), { expiresIn });
}

function verifyVoiceGuestToken(token) {
  try {
    return jwt.verify(token, voiceGuestSecret());
  } catch (_) {
    return null;
  }
}

async function userIsVoiceMember(roomId, userId) {
  const r = await pool.query(
    `SELECT role FROM voice_members WHERE room_id=$1 AND user_id=$2 AND removed_at IS NULL LIMIT 1`,
    [roomId, userId]
  );
  return r.rowCount ? r.rows[0] : null;
}

async function requireVoiceAccess(req, res, next) {
  try {
    await voiceEnsureSchema();
    const roomId = req.params.roomId;

    if (!isUuid(roomId)) return res.status(400).json({ error: "Invalid room id." });

    // First: member auth (Bearer token)
    const user = await getUserFromRequest(req);
    if (user) {
      const mem = await userIsVoiceMember(roomId, user.id);
      if (mem) {
        req.voiceActor = { kind: "user", id: user.id, name: user.name || user.email || "Member", role: mem.role };
        return next();
      }
    }

    // Second: guest cookie (from invite link flow)
    const cookies = parseCookies(req);
    const guestJwt = cookies["pdfrealm_voice_guest"];
    const payload = guestJwt ? verifyVoiceGuestToken(guestJwt) : null;

    if (payload && payload.room_id === roomId && payload.invite_token_hash) {
      // validate invite still active
      const inv = await pool.query(
        `SELECT allow_write FROM voice_invites
         WHERE token_hash=$1 AND room_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())`,
        [payload.invite_token_hash, roomId]
      );
      if (inv.rowCount) {
        req.voiceActor = {
          kind: "guest",
          id: payload.guest_id || payload.sub || "guest",
          name: payload.guest_name || "Guest",
          role: "guest",
          invite_token_hash: payload.invite_token_hash,
          allow_write: !!inv.rows[0].allow_write
        };
        return next();
      }
    }

    // Third: stateless invite token (header/query) — helps when guest cookies are blocked (or not yet set)
    const rawInvite =
      (req.headers["x-voice-invite"] || (req.query && (req.query.invite || req.query.token)) || "")
        .toString()
        .trim();

    if (rawInvite) {
      const tokenHash = voiceHashToken(rawInvite);
      const inv2 = await pool.query(
        `SELECT allow_write FROM voice_invites
         WHERE token_hash=$1 AND room_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())`,
        [tokenHash, roomId]
      );
      if (inv2.rowCount) {
        const guestNameHdr = (req.headers["x-guest-name"] || "").toString().slice(0, 80) || "Guest";
        req.voiceActor = {
          kind: "guest",
          id: "link:" + tokenHash.slice(0, 16),
          name: guestNameHdr,
          role: "guest",
          invite_token_hash: tokenHash,
          allow_write: !!inv2.rows[0].allow_write
        };
        return next();
      }
    }

    return res.status(401).json({ error: "Unauthorized" });
  } catch (e) {
    console.error("requireVoiceAccess error:", e?.message || e);
    return res.status(500).json({ error: "Server error" });
  }
}

async function voiceTouchPresence(roomId, actor, peerId) {
  try {
    await voiceEnsureSchema();
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO voice_presence (id, room_id, actor_kind, actor_id, actor_name, peer_id, created_at, last_seen)
       VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW())
       ON CONFLICT DO NOTHING`,
      [id, roomId, actor.kind || "user", String(actor.id || ""), String(actor.name || ""), peerId || null]
    );
    await pool.query(
      `UPDATE voice_presence SET last_seen=NOW(), peer_id=COALESCE($3, peer_id)
       WHERE room_id=$1 AND actor_kind=$2 AND actor_id=$4 AND deleted_at IS NULL`,
      [roomId, actor.kind || "user", peerId || null, String(actor.id || "")]
    );
  } catch (_) {}
}

// Create room (members only)
app.post("/api/voice/rooms", requireAuth, async (req, res) => {
  try {
    await voiceEnsureSchema();
    const userId = req.user.id;
    const title = String((req.body && req.body.title) || "Voice Room").slice(0, 120);
    const id = crypto.randomUUID();

    await pool.query(
      `INSERT INTO voice_rooms (id, title, owner_user_id, created_by_user_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,NOW(),NOW())`,
      [id, title, userId, userId]
    );

    await pool.query(
      `INSERT INTO voice_members (room_id, user_id, role, created_at)
       VALUES ($1,$2,'owner',NOW())
       ON CONFLICT (room_id, user_id) DO UPDATE SET removed_at=NULL, role='owner'`,
      [id, userId]
    );

    res.json({ room: { id, title } });
  } catch (e) {
    console.error("Voice create room error:", e);
    res.status(500).json({ error: "Create failed: " + (e.message || "unknown") });
  }
});

// Create invite (members only)
app.post("/api/voice/rooms/:roomId/invites", requireAuth, async (req, res) => {
  try {
    await voiceEnsureSchema();
    const roomId = req.params.roomId;
    const userId = req.user.id;

    const mem = await userIsVoiceMember(roomId, userId);
    if (!mem) return res.status(403).json({ error: "Not a member." });

    const room = await pool.query(`SELECT id, title, owner_user_id, deleted_at FROM voice_rooms WHERE id=$1`, [roomId]);
    if (!room.rowCount || room.rows[0].deleted_at) return res.status(404).json({ error: "Room not found." });

    const allowWrite = req.body && typeof req.body.allow_write === "boolean" ? !!req.body.allow_write : true;
    const expiresIn = Number(req.body && req.body.expires_in_seconds) || 0;
    const password = req.body && req.body.password ? String(req.body.password) : null;

    const token = base64url(crypto.randomBytes(24));
    const tokenHash = voiceHashToken(token);
    const tokenPrefix = token.slice(0, 8);
    const inviteId = crypto.randomUUID();
    const ownerUserId = room.rows[0].owner_user_id || userId;

    let passwordHash = null;
    if (password && password.trim()) {
      passwordHash = await bcrypt.hash(password.trim(), 10);
    }

    const expiresAt = expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null;

    await pool.query(
      `INSERT INTO voice_invites (id, room_id, token_hash, token_prefix, allow_write, owner_user_id, created_by_user_id, password_hash, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9)`,
      [inviteId, roomId, tokenHash, tokenPrefix, allowWrite, ownerUserId, userId, passwordHash, expiresAt]
    );

    res.json({ id: inviteId, token, token_prefix: tokenPrefix, expires_at: expiresAt, password_required: !!passwordHash });
  } catch (e) {
    console.error("Voice invite error:", e);
    res.status(500).json({ error: "Invite failed: " + (e.message || "unknown") });
  }
});

// Public: invite meta
app.get("/api/voice-invite/:token/meta", async (req, res) => {
  try {
    await voiceEnsureSchema();
    const token = req.params.token;
    const tokenHash = voiceHashToken(token);

    const r = await pool.query(
      `SELECT vi.id, vi.room_id, vi.allow_write, vi.expires_at, (vi.password_hash IS NOT NULL) AS password_required,
              vr.title, vr.deleted_at
       FROM voice_invites vi
       JOIN voice_rooms vr ON vr.id=vi.room_id
       WHERE vi.token_hash=$1 AND vi.revoked_at IS NULL
         AND (vi.expires_at IS NULL OR vi.expires_at > NOW())`,
      [tokenHash]
    );
    if (!r.rowCount || r.rows[0].deleted_at) return res.status(404).json({ error: "Invite not found or expired." });

    const row = r.rows[0];
    res.json({
      ok: true,
      room: { id: row.room_id, title: row.title },
      allow_write: !!row.allow_write,
      expires_at: row.expires_at,
      password_required: !!row.password_required
    });
  } catch (e) {
    console.error("Voice invite meta error:", e?.message || e);
    res.status(500).json({ error: "Meta failed" });
  }
});

// Public: join (sets guest cookie)
app.post("/api/voice-invite/:token/join", async (req, res) => {
  try {
    await voiceEnsureSchema();
    const token = req.params.token;
    const tokenHash = voiceHashToken(token);

    const r = await pool.query(
      `SELECT vi.id, vi.room_id, vi.allow_write, vi.password_hash, vi.expires_at, vr.deleted_at
       FROM voice_invites vi
       JOIN voice_rooms vr ON vr.id=vi.room_id
       WHERE vi.token_hash=$1 AND vi.revoked_at IS NULL
         AND (vi.expires_at IS NULL OR vi.expires_at > NOW())`,
      [tokenHash]
    );
    if (!r.rowCount || r.rows[0].deleted_at) return res.status(404).json({ error: "Invite not found or expired." });

    const inv = r.rows[0];
    const guestName = (req.body && req.body.guest_name ? String(req.body.guest_name) : "").slice(0, 80) || null;

    if (inv.password_hash) {
      const pw = req.body && req.body.password ? String(req.body.password) : "";
      const ok = await bcrypt.compare(pw, inv.password_hash);
      if (!ok) return res.status(403).json({ error: "Invalid password." });
    }

    const guestId = base64url(crypto.randomBytes(12));
    const guestRowId = crypto.randomUUID();

    await pool.query(
      `INSERT INTO voice_guests (id, room_id, invite_id, guest_id, guest_name, invite_token_hash, created_at, last_seen)
       VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW())`,
      [guestRowId, inv.room_id, inv.id, guestId, guestName, tokenHash]
    );

    const maxAgeMs = (() => {
      if (!inv.expires_at) return 7 * 24 * 60 * 60 * 1000;
      const diff = new Date(inv.expires_at).getTime() - Date.now();
      if (!Number.isFinite(diff)) return 7 * 24 * 60 * 60 * 1000;
      return Math.max(60_000, diff);
    })();

    const guestJwt = signVoiceGuestToken(
      {
        room_id: inv.room_id,
        guest_id: guestId,
        guest_name: guestName,
        invite_token_hash: tokenHash,
        allow_write: !!inv.allow_write
      },
      { expiresIn: Math.ceil(maxAgeMs / 1000) + "s" }
    );

    res.cookie("pdfrealm_voice_guest", guestJwt, {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      maxAge: maxAgeMs
    });

    res.json({ ok: true, room_id: inv.room_id, guest_id: guestId });
  } catch (e) {
    console.error("Voice invite join error:", e);
    res.status(500).json({ error: "Join failed: " + (e.message || "unknown") });
  }
});

// Presence (members or guests)
app.post("/api/voice/rooms/:roomId/presence", requireVoiceAccess, async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const peerId = (req.body && req.body.peer_id ? String(req.body.peer_id) : "").slice(0, 64) || null;
    try { await voiceTouchPresence(roomId, req.voiceActor, peerId); } catch (_) {}
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Presence failed" });
  }
});

app.get("/api/voice/rooms/:roomId/presence", requireVoiceAccess, async (req, res) => {
  try {
    await voiceEnsureSchema();
    const roomId = req.params.roomId;
    const r = await pool.query(
      `SELECT actor_kind, actor_id, actor_name, peer_id, last_seen
       FROM voice_presence
       WHERE room_id=$1 AND deleted_at IS NULL
       ORDER BY last_seen DESC
       LIMIT 50`,
      [roomId]
    );
    res.json({ ok: true, participants: r.rows });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Presence load failed" });
  }
});

// Signaling (offer/answer/ice) — members or guests
app.get("/api/voice/rooms/:roomId/signals", requireVoiceAccess, async (req, res) => {
  try {
    await voiceEnsureSchema();
    const roomId = req.params.roomId;
    const peerId = (req.query && req.query.peer_id ? String(req.query.peer_id) : "").slice(0, 64) || "";
    const since = (req.query && req.query.since ? String(req.query.since) : "").trim();
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 100)));

    const params = [roomId];
    let where = `room_id=$1 AND deleted_at IS NULL`;

    if (since && isUuid(since)) {
      params.push(since);
      where += ` AND id > $${params.length}`;
    }

    // Deliver messages addressed to me, or broadcasts
    if (peerId) {
      params.push(peerId);
      where += ` AND (to_peer IS NULL OR to_peer='' OR to_peer=$${params.length})`;
    }

    const q = `SELECT id, from_peer, to_peer, type, payload, created_at
               FROM voice_signals
               WHERE ${where}
               ORDER BY created_at ASC
               LIMIT ${limit}`;

    const r = await pool.query(q, params);
    res.json({ ok: true, signals: r.rows });
  } catch (e) {
    console.error("Voice get signals error:", e);
    res.status(500).json({ error: "Signals failed" });
  }
});

app.post("/api/voice/rooms/:roomId/signals", requireVoiceAccess, async (req, res) => {
  try {
    await voiceEnsureSchema();
    const roomId = req.params.roomId;
    const actor = req.voiceActor;

    if (actor.kind === "guest" && !actor.allow_write) {
      return res.status(403).json({ error: "Invite is read-only." });
    }

    const fromPeer = (req.body && req.body.from_peer ? String(req.body.from_peer) : "").slice(0, 64) || "";
    const toPeer = (req.body && req.body.to_peer ? String(req.body.to_peer) : "").slice(0, 64) || null;
    const type = (req.body && req.body.type ? String(req.body.type) : "").slice(0, 32);
    const payload = req.body && req.body.payload ? req.body.payload : null;

    if (!type) return res.status(400).json({ error: "Missing type." });

    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO voice_signals (id, room_id, from_kind, from_id, from_name, from_peer, to_peer, type, payload, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())`,
      [id, roomId, actor.kind || "user", String(actor.id || ""), String(actor.name || ""), fromPeer || null, toPeer || null, type, payload]
    );

    res.json({ ok: true, id });
  } catch (e) {
    console.error("Voice send signal error:", e);
    res.status(500).json({ error: "Send failed" });
  }
});

// ------------------ END SECURE VOICE / VOIP ------------------

// /login → redirect to homepage with ?login=1 so the account modal auto-opens
app.get("/login", (req, res) => {
  res.redirect(302, "/?login=1");
});

app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// 404

// start


// PDFREALM_PROXY_FETCH_V1
// Same-origin HTML fetch helper for URL → PDF v1.
// SSRF guards: blocks localhost + common private IPv4 ranges.
app.get("/api/proxy-fetch", async (req, res) => {
  try {
    const raw = String(req.query.url || "").trim();
    if (!raw) return res.status(400).json({ error: "Missing url" });

    let u;
    try { u = new URL(raw); } catch { return res.status(400).json({ error: "Invalid url" }); }
    if (!["http:", "https:"].includes(u.protocol)) {
      return res.status(400).json({ error: "Only http/https allowed" });
    }

    const host = (u.hostname || "").toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      return res.status(400).json({ error: "Blocked host" });
    }

    // Block common private IPv4 ranges
    const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      const isPrivate =
        a === 10 || a === 127 || a === 0 ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168);
      if (isPrivate) return res.status(400).json({ error: "Blocked IP" });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);

    const r = await fetch(u.toString(), {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "PDFRealm/1.0 (+url2pdf)",
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5"
      }
    });

    clearTimeout(timer);
    if (!r.ok) return res.status(502).json({ error: "Upstream returned " + r.status });

    const buf = await r.arrayBuffer();
    if (buf.byteLength > 2_000_000) return res.status(413).json({ error: "Response too large" });

    res.setHeader("content-type", "text/html; charset=utf-8");
    res.send(Buffer.from(buf));
  } catch (e) {
    const msg = e && e.name === "AbortError" ? "Fetch timeout" : (e?.message || String(e));
    res.status(500).json({ error: msg });
  }
});
// /PDFREALM_PROXY_FETCH_V1

// -------------------- SECURE AI NOTES ASSISTANT (Option A: WebRTC audio-only) --------------------
// /PDFREALM_SECURE_AI_NOTES_ASSISTANT_V1
try {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL not set; skipping SecureAI mount to avoid pool errors");
  }
  const { mountSecureAi } = require("./server/secure_ai_routes.cjs");
  mountSecureAi(app, {
    pool,
    getUserFromRequest,
    parseCookies,
  });
  console.log("Secure AI Notes Assistant mounted: /api/secure-ai/*");


// [AI_OPERATOR_UPLOAD_V1] begin
// Adds: POST /api/ai/upload (stores temp file + extracted text)
// Adds: middleware to attach uploaded document context to /api/ai/{plan,execute,run,act,command}
// NOTE: Middleware calls next() so your existing ai_agent_routes.cjs handlers still run.
try {
  const __aiUploads = global.__pdfrealmAiUploads || new Map();
  global.__pdfrealmAiUploads = __aiUploads;

  const __aiUploadMaxBytes = 25 * 1024 * 1024; // 25MB per upload
  const __aiUploadTTLms = 60 * 60 * 1000; // 1 hour

  function __aiNow() { return Date.now(); }

  function __aiCleanupOnce() {
    const now = __aiNow();
    for (const [id, it] of __aiUploads.entries()) {
      if (!it || !it.expiresAt || it.expiresAt <= now) {
        try { if (it && it.path && fs.existsSync(it.path)) fs.rmSync(it.path, { force: true }); } catch {}
        __aiUploads.delete(id);
      }
    }
  }

  // Opportunistic cleanup (cheap)
  setInterval(__aiCleanupOnce, 10 * 60 * 1000).unref?.();

  function __aiResolveCmd(cands) {
    for (const c of (cands || [])) {
      if (!c) continue;
      try {
        if (typeof c !== 'string') continue;
        if (c.includes('/') && fs.existsSync(c)) return c;
        // bare name: assume available in PATH
        return c;
      } catch {}
    }
    return null;
  }

  function __aiExtractTextFromUpload({ tmpPath, mime, originalName, buffer }) {
    const name = String(originalName || '').toLowerCase();
    const m = String(mime || '').toLowerCase();

    // Plain text
    if (m.startsWith('text/') || /.(txt|csv|md|json|log)$/i.test(name)) {
      try {
        const t = (buffer ? buffer.toString('utf8') : fs.readFileSync(tmpPath, 'utf8'));
        return t.slice(0, 400_000);
      } catch {
        return '';
      }
    }

    // PDF via pdftotext (Poppler)
    if (m === 'application/pdf' || name.endsWith('.pdf')) {
      try {
        const isWin = process.platform === 'win32';
        // Prefer your existing PDFTOTEXT_PATH if set
        const pdftotext = (typeof resolveCmd === 'function')
          ? resolveCmd([process.env.PDFTOTEXT_PATH, isWin ? 'pdftotext.exe' : 'pdftotext', '/usr/bin/pdftotext', '/usr/local/bin/pdftotext'], isWin ? 'pdftotext.exe' : 'pdftotext')
          : __aiResolveCmd([process.env.PDFTOTEXT_PATH, isWin ? 'pdftotext.exe' : 'pdftotext', '/usr/bin/pdftotext', '/usr/local/bin/pdftotext']);

        if (!pdftotext) return '';
        const r = spawnSync(pdftotext, ['-layout', '-nopgbrk', tmpPath, '-'], { windowsHide: true, maxBuffer: 20 * 1024 * 1024 });
        if (!r || r.status !== 0) return '';
        const out = (r.stdout || Buffer.from('')).toString('utf8');
        return out.slice(0, 400_000);
      } catch {
        return '';
      }
    }

    // Images via Tesseract (if installed)
    if (m.startsWith('image/') || /.(png|jpg|jpeg|tif|tiff|bmp|gif|webp)$/i.test(name)) {
      try {
        if (!Tesseract) return '';
        // Tesseract.js expects a path or buffer; prefer path
        // NOTE: This can be slow; we keep it best-effort.
        // eslint-disable-next-line no-undef
        return '';
      } catch {
        return '';
      }
    }

    // DOCX/others: no extraction here (AI can still use file metadata/path)
    return '';
  }

  app.post('/api/ai/upload', upload.single('file'), async (req, res) => {
    try {
      __aiCleanupOnce();
      const f = req.file;
      if (!f || !f.buffer) return res.status(400).json({ ok: false, error: 'File required.' });
      if (f.size && f.size > __aiUploadMaxBytes) return res.status(413).json({ ok: false, error: 'File too large (max 25MB).' });

      const id = crypto.randomUUID();
      const originalName = String(f.originalname || 'document').slice(0, 200);
      const mime = String(f.mimetype || 'application/octet-stream').slice(0, 120);

      const stamp = Date.now() + '_' + Math.random().toString(16).slice(2);
      const safeName = originalName.replace(/[^a-z0-9_.-]+/gi, '_');
      const tmpPath = path.join(os.tmpdir(), 'pdfrealm_aiop_' + stamp + '_' + safeName);
      fs.writeFileSync(tmpPath, f.buffer);

      const text = __aiExtractTextFromUpload({ tmpPath, mime, originalName, buffer: f.buffer }) || '';

      __aiUploads.set(id, {
        id,
        filename: originalName,
        mime,
        bytes: f.size || f.buffer.length,
        path: tmpPath,
        text,
        createdAt: __aiNow(),
        expiresAt: __aiNow() + __aiUploadTTLms
      });

      return res.json({
        ok: true,
        uploadId: id,
        filename: originalName,
        mime,
        bytes: f.size || f.buffer.length,
        extracted: !!text,
        textPreview: text ? text.slice(0, 500) : ''
      });
    } catch (e) {
      console.error('[ai-upload] failed:', e);
      return res.status(500).json({ ok: false, error: 'Upload failed.' });
    }
  });

  // Attach upload context to AI operator actions. We do NOT handle the request here;
  // we simply enrich req.body then call next(), letting ai_agent_routes.cjs respond.
  app.use(/^\/api\/ai\/(plan|execute|run|act|command)$/i, (req, res, next) => {
    try {
      __aiCleanupOnce();
      const body = (req && req.body && typeof req.body === 'object') ? req.body : null;
      if (!body) return next();

      const uploadId = String(body.uploadId || body.upload_id || body.fileId || body.file_id || '').trim();
      if (!uploadId) return next();

      const it = __aiUploads.get(uploadId);
      if (!it) return next();

      // Refresh TTL
      it.expiresAt = __aiNow() + __aiUploadTTLms;

      // Common fields AI backends might expect
      body.uploadId = uploadId;
      body.document = body.document || { id: uploadId, name: it.filename, mime: it.mime, path: it.path, bytes: it.bytes };
      body.file = body.file || body.document;
      body.filePath = body.filePath || it.path;
      body.path = body.path || it.path;
      body.filename = body.filename || it.filename;
      body.mime = body.mime || it.mime;

      // Add extracted text if not already provided
      if (!body.docText && !body.documentText && it.text) {
        body.docText = it.text;
        body.documentText = it.text;
      }

      return next();
    } catch (e) {
      console.error('[ai-upload-mw] failed:', e);
      return next();
    }
  });

  console.log('AI Operator upload/middleware enabled: /api/ai/upload + context attach');
} catch (e) {
  console.warn('AI Operator upload/middleware not enabled:', e?.message || e);
}
// [AI_OPERATOR_UPLOAD_V1] end


// [PDFREALM_AIOP_BODY_PARSERS_V1] begin
// Ensure JSON/urlencoded bodies are parsed for AI Operator routes (prevents req.body being empty -> 400)
// --- PDFREALM_IS_ENCRYPTED_BEFORE_APIUSE_V1 ---
app.all("/api/is-encrypted", (req, res) => {
  if (req.method === "OPTIONS" || req.method === "GET") return res.status(200).json({ ok: true });
  if (req.method !== "POST") return res.status(200).json({ encrypted: false });
  let multerMod;
  let PDFDocument;
  try {
    // Works in CJS; in ESM builds PDFRealm often defines require via createRequire
    multerMod = require("multer");
    ({ PDFDocument } = require("pdf-lib"));
  } catch (e) {
    return res.status(200).json({ encrypted: false, note: "deps_missing" });
  }
  const up = multerMod({ storage: multerMod.memoryStorage(), limits: { fileSize: 250 * 1024 * 1024 } }).single("file");
  up(req, res, async (err) => {
    if (err) return res.status(200).json({ encrypted: false, note: "upload_failed" });
    const buf = req.file && req.file.buffer;
    if (!buf || !buf.length) return res.status(200).json({ encrypted: false, note: "no_file" });
    try {
      await PDFDocument.load(buf, { ignoreEncryption: false, updateMetadata: false });
      return res.status(200).json({ encrypted: false });
    } catch (e2) {
      const msg = String((e2 && (e2.message || e2)) || "").toLowerCase();
      if (msg.includes("encrypted") || msg.includes("password")) return res.status(200).json({ encrypted: true });
      return res.status(200).json({ encrypted: false, note: "parse_error_non_encryption" });
    }
  });
});
// --- end PDFREALM_IS_ENCRYPTED_BEFORE_APIUSE_V1 ---

app.use("/api/ai", express.json({ limit: "25mb" }));
app.use("/api/ai", express.urlencoded({ extended: true, limit: "25mb" }));
// [PDFREALM_AIOP_BODY_PARSERS_V1] end
// [AI_OPERATOR_CONTEXT_ATTACH_POSTPARSE_V1] begin
// Fix: AI context attach must run AFTER /api/ai body parsers, otherwise req.body is empty.
// This post-parse middleware runs before ai_agent_routes.cjs handlers.
try {
  const __aiUploads2 = global.__pdfrealmAiUploads || new Map();
  global.__pdfrealmAiUploads = __aiUploads2;

  // Alias common names older AI route modules might look for
  global.__aiUploads = __aiUploads2;
  global.aiUploads = __aiUploads2;
  global.__aiAgentUploads = __aiUploads2;
  global.__ai_agent_uploads = __aiUploads2;

  app.locals.__aiUploads = __aiUploads2;
  app.locals.aiUploads = __aiUploads2;

  function __aiAttachFromId(uploadId, body) {
    const it = __aiUploads2.get(uploadId);
    if (!it) return false;

    // Refresh TTL if present
    try { if (typeof it.expiresAt === "number") it.expiresAt = Date.now() + (60 * 60 * 1000); } catch {}

    body.uploadId = uploadId;
    body.fileId = body.fileId || uploadId;
    body.documentId = body.documentId || uploadId;

    body.upload_id = body.upload_id || uploadId;
    body.file_id = body.file_id || uploadId;
    body.document_id = body.document_id || uploadId;

    body.document = body.document || { id: uploadId, name: it.filename, mime: it.mime, path: it.path, bytes: it.bytes };
    body.file = body.file || body.document;

    body.filePath = body.filePath || it.path;
    body.path = body.path || it.path;
    body.filename = body.filename || it.filename;
    body.mime = body.mime || it.mime;

    if (!body.docText && !body.documentText && it.text) {
      body.docText = it.text;
      body.documentText = it.text;
    }

    return true;
  }

  app.use(/^\/api\/ai\/(plan|execute|run|act|command)$/i, (req, res, next) => {
    try {
      const body = (req && req.body && typeof req.body === "object") ? req.body : (req.body = {});
      const q = (req && req.query && typeof req.query === "object") ? req.query : {};

      const uploadId = String(
        body.uploadId || body.upload_id ||
        body.fileId || body.file_id ||
        body.documentId || body.document_id ||
        (body.document && body.document.id) ||
        (body.file && body.file.id) ||
        q.uploadId || q.upload_id || q.fileId || q.file_id || q.documentId || q.document_id || ""
      ).trim();

      if (!uploadId) return next();
      __aiAttachFromId(uploadId, body);

      // Small debug line (safe)
      try { console.log("[ai-run] id=", uploadId, "hasUpload=", __aiUploads2.has(uploadId)); } catch {}

      return next();
    } catch (e) {
      console.error("[ai-context-postparse] failed:", e);
      return next();
    }
  });

  console.log("AI Operator context-attach post-parse enabled.");
} catch (e) {
  console.warn("AI Operator context-attach post-parse not enabled:", e?.message || e);
}
// [AI_OPERATOR_CONTEXT_ATTACH_POSTPARSE_V1] end


// ===== AI Operator (public QuickTools) =====
try {
  const mod = require("./server/ai_agent_routes.cjs");
  const fn = (mod && mod.mountAiAgent) ? mod.mountAiAgent : mod;
  if (typeof fn !== "function") throw new Error("ai_agent_routes.cjs did not export a function");
  fn({ app });
  console.log("AI Agent mounted: /api/ai/*");
} catch (e) {
  console.error("AI Agent mount failed:", e);
}
// ===== /AI Operator =====


// [SECURE_AI_ACTIVE_ENDPOINT_V1] begin
// Client polls this endpoint to detect an active Secure-AI session for a context.
// Returns { sessionId, status, allConsented } or { sessionId:null,... }
app.get("/api/secure-ai/active", async (req, res) => {
  try {
    const sessionType = String(req.query.sessionType || "").trim();
    const contextId = String(req.query.contextId || "").trim();

    if (!sessionType || !contextId) {
      return res.json({ sessionId: null, status: null, allConsented: false });
    }

    // NOTE: requires a Postgres Pool named "pool" to exist in server.js (your server already has this).
    let row = null;

    // Prefer secure_ai_sessions.context_id if present, else fall back to title=contextId
    try {
      const r = await pool.query(
        `select id, status
         from secure_ai_sessions
         where session_type = $1
           and context_id = $2
         order by created_at desc
         limit 1`,
        [sessionType, contextId]
      );
      row = r.rows[0] || null;
    } catch (e) {
      // 42703 = undefined_column
      if (e && e.code === "42703") {
        const r2 = await pool.query(
          `select id, status
           from secure_ai_sessions
           where session_type = $1
             and title = $2
           order by created_at desc
           limit 1`,
          [sessionType, contextId]
        );
        row = r2.rows[0] || null;
      } else {
        throw e;
      }
    }

    if (!row) {
      return res.json({ sessionId: null, status: null, allConsented: false });
    }

    const consentQ = await pool.query(
      `
      with latest as (
        select distinct on (user_id) user_id, consent
        from secure_ai_consent_events
        where session_id = $1
        order by user_id, created_at desc
      )
      select
        (select count(*)::int from secure_ai_participants where session_id = $1) as participants,
        (select count(*)::int from latest where consent = true) as consent_yes
      `,
      [row.id]
    );

    const participants = consentQ.rows[0]?.participants ?? 0;
    const consentYes = consentQ.rows[0]?.consent_yes ?? 0;
    const allConsented = participants > 0 && consentYes === participants;

    return res.json({ sessionId: row.id, status: row.status, allConsented });
  } catch (err) {
    console.error("secure-ai active failed:", err);
    return res.status(500).send("secure-ai active error");
  }
});
// [SECURE_AI_ACTIVE_ENDPOINT_V1] end
} catch (e) {
  console.warn("Secure AI Notes Assistant not mounted:", e?.message || e);
}
// /PDFREALM_SECURE_AI_NOTES_ASSISTANT_V1


// AI Operator alias: /api/ai/execute -> /api/ai/run (preserve POST via 307)
app.post("/api/ai/execute", (req, res) => res.redirect(307, "/api/ai/run"));

  // ============================
  // Evidence API + Web Test Page
  // ============================

  // Serve a simple in-app test page so you can validate Evidence Core without curl.
  // Visit: /evidence-lab (must be logged in)
  app.get("/evidence-lab", requireAuth, async (req, res) => {
    res.type("html").send(`<!doctype html>
  <html>
  <head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <title>PDFRealm Evidence Lab</title>
    <link rel="stylesheet" href="/styles.css"/>
    <style>
      .wrap{max-width:980px;margin:24px auto;padding:16px}
      .card{background:rgba(10,16,24,.55);border:1px solid rgba(255,255,255,.12);border-radius:16px;padding:16px}
      .row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
      .btn{cursor:pointer;border-radius:12px;padding:10px 14px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);color:#fff}
      .btn.primary{background:rgba(96,165,250,.25);border-color:rgba(96,165,250,.45)}
      pre{white-space:pre-wrap;background:rgba(0,0,0,.25);padding:12px;border-radius:12px;border:1px solid rgba(255,255,255,.10)}
      code{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
      .muted{opacity:.8}
      a{color:#8ab4ff}
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <h2 style="margin:0 0 6px 0">Hash Evidence Machine — Evidence Lab</h2>
        <div class="muted" style="margin-bottom:12px">Upload any file here to create an Evidence Artifact (Postgres-backed) and export a verification bundle.</div>

        <div class="row" style="margin-bottom:12px">
          <input id="f" type="file" />
          <button class="btn primary" id="ingest">Ingest → Create Evidence</button>
          <button class="btn" id="addEvent" disabled>Add Event</button>
          <button class="btn" id="bundle" disabled>Download Evidence Bundle</button>
        </div>

        <div class="row" style="margin-bottom:10px">
          <div class="muted">Evidence ID:</div>
          <code id="eid" class="muted">—</code>
        </div>

        <pre id="out">Ready.</pre>
      </div>
    </div>

    <script>
      const qs = (s)=>document.querySelector(s);
      const out = qs('#out');
      const eidEl = qs('#eid');
      const btnIngest = qs('#ingest');
      const btnAdd = qs('#addEvent');
      const btnBundle = qs('#bundle');
      let evidenceId = null;

      function log(msg){ out.textContent = String(msg); }

      btnIngest.addEventListener('click', async ()=>{
        const file = qs('#f').files && qs('#f').files[0];
        if(!file){ return log('Pick a file first.'); }
        log('Uploading…');
        const fd = new FormData();
        fd.append('file', file, file.name);

        const r = await fetch('/api/evidence/ingest', { method:'POST', body: fd, credentials:'include' });
        const txt = await r.text();
        if(!r.ok){ return log('ERROR ' + r.status + ':\n' + txt); }
        const j = JSON.parse(txt);
        evidenceId = j.id;
        eidEl.textContent = evidenceId;
        btnAdd.disabled = false;
        btnBundle.disabled = false;
        log(JSON.stringify(j, null, 2));
      });

      btnAdd.addEventListener('click', async ()=>{
        if(!evidenceId) return;
        const action = prompt('Event action (e.g., FINALIZE, SEND, SIGN):','TEST_EVENT');
        if(!action) return;
        const r = await fetch('/api/evidence/' + encodeURIComponent(evidenceId) + '/event', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          credentials:'include',
          body: JSON.stringify({ action, details: { note: 'Manual test event from Evidence Lab' } })
        });
        const txt = await r.text();
        if(!r.ok){ return log('ERROR ' + r.status + ':\n' + txt); }
        log(txt);
      });

      btnBundle.addEventListener('click', ()=>{
        if(!evidenceId) return;
        window.open('/api/evidence/' + encodeURIComponent(evidenceId) + '/bundle', '_blank');
      });
    </script>
  </body>
  </html>`);
  });

  // Ingest: stores original file on disk, metadata + sha256 in Postgres, and logs an INGEST event.
  app.post("/api/evidence/ingest", requireAuth, upload.single("file"), async (req, res) => {
    try {
      await ensureEvidenceSchema();

      const file = req.file;
      if (!file || !file.buffer) return res.status(400).json({ error: "Missing file." });

      const id = crypto.randomUUID();
      const originalName = safeFilename(file.originalname || "document.bin");
      const mimeType = String(file.mimetype || "application/octet-stream");
      const sizeBytes = Number(file.size || file.buffer.length || 0);

      const hash = sha256Hex(file.buffer);

      const dir = path.join(__dirname, "uploads", "evidence", id);
      fs.mkdirSync(dir, { recursive: true });
      const storagePath = path.join(dir, originalName);
      fs.writeFileSync(storagePath, file.buffer);

      const userId = req.user?.id ?? req.user?.userId ?? req.user?.email ?? null;

      await pool.query(
        `insert into evidence_artifacts (id, user_id, original_filename, mime_type, size_bytes, sha256, storage_path)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [id, userId ? String(userId) : null, originalName, mimeType, sizeBytes, hash, storagePath]
      );

      const actor = evidenceActorFromReq(req);
      const evt = await appendEvidenceEvent({
        artifactId: id,
        action: "INGEST",
        details: { filename: originalName, mimeType, sizeBytes, sha256: hash },
        actor
      });

      return res.json({
        id,
        sha256: hash,
        originalFilename: originalName,
        mimeType,
        sizeBytes,
        createdAt: evt.created_at,
        firstEvent: evt
      });
    } catch (err) {
      console.error("evidence ingest failed:", err);
      return res.status(500).json({ error: "Evidence ingest failed." });
    }
  });

  // Read artifact + events
  app.get("/api/evidence/:id", requireAuth, async (req, res) => {
    try {
      await ensureEvidenceSchema();
      const id = req.params.id;
      const a = await pool.query(`select * from evidence_artifacts where id=$1`, [id]);
      if (!a.rows[0]) return res.status(404).json({ error: "Not found." });
      const e = await pool.query(
        `select id, seq, action, details, actor, prev_hash, event_hash, created_at
         from evidence_events where artifact_id=$1 order by seq asc`,
        [id]
      );
      return res.json({ artifact: a.rows[0], events: e.rows });
    } catch (err) {
      console.error("evidence get failed:", err);
      return res.status(500).json({ error: "Evidence read failed." });
    }
  });

  // Append-only event
  app.post("/api/evidence/:id/event", requireAuth, async (req, res) => {
    try {
      await ensureEvidenceSchema();
      const id = req.params.id;
      const exists = await pool.query(`select 1 from evidence_artifacts where id=$1`, [id]);
      if (!exists.rows[0]) return res.status(404).json({ error: "Not found." });

      const action = String(req.body?.action || "EVENT").slice(0, 80);
      const details = req.body?.details ?? null;
      const actor = evidenceActorFromReq(req);

      const evt = await appendEvidenceEvent({ artifactId: id, action, details, actor });
      return res.json({ ok: true, event: evt });
    } catch (err) {
      console.error("evidence event failed:", err);
      return res.status(500).json({ error: "Evidence event failed." });
    }
  });

  // Evidence bundle export: returns tar.gz containing original + manifest + events + verify instructions.
  
/** =========================
 * Evidence Bundle Export (v7)
 * GET /api/evidence/:id/bundle
 *  - default: downloads evidence_<id>.tar.gz
 *  - ?debug=1: returns JSON diagnostics
 * ========================= */
app.get("/api/evidence/:id/bundle", requireAuth, async (req, res) => {
  const fs = require("fs");
  const path = require("path");
  const os = require("os");
  const { spawn } = require("child_process");

  function pick(row, keys, fallback = null) {
    for (const k of keys) {
      if (row && Object.prototype.hasOwnProperty.call(row, k) && row[k] != null) return row[k];
    }
    return fallback;
  }

  // Use pool if present, otherwise db if that's your pg client
  const pg = (typeof pool !== "undefined" && pool) ? pool : ((typeof db !== "undefined" && db) ? db : null);
  if (!pg || typeof pg.query !== "function") {
    return res.status(500).json({ error: "Postgres client not available (pool/db missing)" });
  }

  try {
    const evidenceId = String(req.params.id || "").trim();
    const debug = String(req.query.debug || "") === "1";

    if (!/^[0-9a-fA-F\-]{36}$/.test(evidenceId)) {
      return res.status(400).json({ error: "Invalid evidence id" });
    }

    // Load artifact
    const artQ = await pg.query("SELECT * FROM evidence_artifacts WHERE id = $1", [evidenceId]);
    const artRow = artQ.rows?.[0] || null;
    if (!artRow) return res.status(404).json({ error: "Evidence not found" });

    const owner = pick(artRow, ["user_id", "owner_id", "userId", "ownerId"]);
    if (owner != null && String(owner) !== String(req.user?.id)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const filename = String(pick(artRow, ["filename", "original_name", "name"], "original.bin"));
    const mime = String(pick(artRow, ["mime", "mime_type", "content_type"], "application/octet-stream"));
    const bytes = Number(pick(artRow, ["bytes", "size_bytes", "size", "file_bytes"], 0)) || 0;
    const sha256 = String(pick(artRow, ["sha256", "hash_sha256", "hash"], ""));
    const createdAt = pick(artRow, ["created_at", "createdat", "createdAt", "ingested_at", "ingestedAt"], null);
    const storagePath = pick(artRow, ["storage_path", "file_path", "path", "filepath", "storagePath"], null);

    // Load events (try artifact_id then evidence_id)
    let events = [];
    try {
      const q1 = await pg.query("SELECT * FROM evidence_events WHERE artifact_id = $1 ORDER BY created_at ASC, id ASC", [evidenceId]);
      events = q1.rows || [];
    } catch (e1) {
      const q2 = await pg.query("SELECT * FROM evidence_events WHERE evidence_id = $1 ORDER BY created_at ASC, id ASC", [evidenceId]);
      events = q2.rows || [];
    }

    const diag = {
      evidenceId,
      filename,
      mime,
      bytes,
      sha256: sha256 || null,
      createdAt,
      storagePath,
      storagePathExists: storagePath ? fs.existsSync(String(storagePath)) : false
    };

    if (debug) {
      // lightweight tar check
      let tarAvailable = true;
      try {
        const t = spawn("tar", ["--version"]);
        t.on("error", () => { tarAvailable = false; });
      } catch { tarAvailable = false; }
      return res.json({ ok: true, diag: { ...diag, tarAvailable }, eventsPreview: events.slice(0, 5) });
    }

    if (!storagePath || !fs.existsSync(String(storagePath))) {
      return res.status(500).json({ error: "Original file missing on server", diag });
    }

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-bundle-"));
    const safeName = filename.replace(/[^a-zA-Z0-9._-]+/g, "_");
    const outOriginalName = "original_" + safeName;

    fs.copyFileSync(String(storagePath), path.join(tmpRoot, outOriginalName));

    const manifest = {
      evidenceId,
      filename,
      mime,
      bytes,
      sha256: sha256 || null,
      createdAt,
      exportedAt: new Date().toISOString(),
      files: [outOriginalName, "manifest.json", "events.jsonl", "verify.txt"]
    };
    fs.writeFileSync(path.join(tmpRoot, "manifest.json"), JSON.stringify(manifest, null, 2));

    const lines = (events || []).map(r => JSON.stringify(r));
    fs.writeFileSync(path.join(tmpRoot, "events.jsonl"), lines.join("\n") + (lines.length ? "\n" : ""));

    const verifyTxt = [
      "PDFRealm Evidence Bundle — Verification",
      "",
      "1) Verify SHA-256 of the original file:",
      "  sha256sum \"" + outOriginalName + "\"",
      sha256 ? ("  Expected: " + sha256) : "  Expected: (sha256 not recorded)",
      "",
      "2) Review manifest.json for metadata and events.jsonl for the append-only log.",
      "",
      "Keep this bundle unchanged for compliance/court use.",
      ""
    ].join("\n");
    fs.writeFileSync(path.join(tmpRoot, "verify.txt"), verifyTxt);

    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", "attachment; filename=\"evidence_" + evidenceId + ".tar.gz\"");

    const tar = spawn("tar", ["-czf", "-", "-C", tmpRoot, "."], { stdio: ["ignore", "pipe", "pipe"] });

    let tarErr = "";
    tar.stderr.on("data", d => { tarErr += String(d); });

    tar.on("error", (err) => {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
      return res.status(500).json({ error: "Failed to create evidence bundle (tar unavailable)", detail: String(err?.message || err), diag });
    });

    tar.stdout.pipe(res);

    tar.on("close", (code) => {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
      if (code !== 0) {
        console.error("[evidence bundle] tar exited non-zero:", code, tarErr);
      }
    });

  } catch (e) {
    console.error("[evidence bundle] export failed:", e);
    return res.status(500).json({ error: "Bundle export failed", detail: String(e?.message || e) });
  }
});



// 404 (must be last)



/** =========================
 * Court Verify Tool (Upgraded v1)
 * POST /api/evidence/verify-bundle
 *  - multipart field: bundle (.tar.gz exported evidence bundle)
 *  - default: returns JSON verdict
 *  - ?format=pdf: returns a Court Verification Report PDF
 * ========================= */
app.post("/api/evidence/verify-bundle", requireAuth, async (req, res) => {
  const fs = require("fs");
  const path = require("path");
  const os = require("os");
  const crypto = require("crypto");
  const { spawn } = require("child_process");

  const wantPdf = String(req.query.format || "").toLowerCase() === "pdf";

  const multer = (() => { try { return require("multer"); } catch { return null; } })();

  function sha256Hex(bufOrStr) {
    const h = crypto.createHash("sha256");
    h.update(bufOrStr);
    return h.digest("hex");
  }

  function safeJson(x) {
    try { return JSON.stringify(x); } catch { return String(x); }
  }

  
  // Stable JSON stringify (sort keys) so hashing is deterministic
  function stableStringify(value) {
    const seen = new WeakSet();
    const norm = (v) => {
      if (v === null || typeof v !== "object") return v;
      if (seen.has(v)) return "[Circular]";
      seen.add(v);
      if (Array.isArray(v)) return v.map(norm);
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = norm(v[k]);
      return out;
    };
    try { return JSON.stringify(norm(value)); } catch { return String(value); }
  }

  function computeEventHashV1(prevHash, evt) {
    // Canonical v1:
    // sha256(prevHash + "|" + action + "|" + createdAt + "|" + stable_json(details))
    const action = String(evt.action ?? evt.Action ?? evt.type ?? evt.event_type ?? "");
    const createdAt = String(evt.created_at ?? evt.createdAt ?? evt.time ?? evt.timestamp ?? "");
    const details = evt.details ?? evt.Details ?? evt.meta ?? evt.data ?? null;
    const material = String(prevHash || "") + "|" + action + "|" + createdAt + "|" + stableStringify(details);
    return sha256Hex(material);
  }

  function computeEventHashLegacyWholeJson(evt) {
    // Common legacy: sha256(JSON.stringify(evt)) (not stable)
    return sha256Hex(JSON.stringify(evt));
  }

  function computeEventHashLegacyStableWholeJson(evt) {
    // Better legacy: sha256(stable_json(evt))
    return sha256Hex(stableStringify(evt));
  }

  
  
  
  
  function stripEventHashFromLine(rawLine) {
    if (!rawLine) return "";
    // Remove "event_hash":"..."/'event_hash':'...' with optional whitespace and trailing commas
    // Works on typical JSONL where keys are double-quoted.
    let line = String(rawLine);

    // Remove the field when it's in the middle: ,"event_hash":"...".
    line = line.replace(/\s*,\s*"event_hash"\s*:\s*"[^"]*"/, "");

    // Remove the field when it's first: "event_hash":"...", (leading)
    line = line.replace(/"event_hash"\s*:\s*"[^"]*"\s*,\s*/ , "");

    // Remove any leftover double commas or "{," patterns
    line = line.replace(/,\s*,/g, ",");
    line = line.replace(/\{\s*,/g, "{");
    line = line.replace(/,\s*\}/g, "}");

    return line;
  }

  
  // Strict canonical v1 validator (no legacy fallbacks)
  function validateEventHash(prevHash, evt, providedHash) {
    const want = String(providedHash || "").toLowerCase();
    const computed = computeEventHashV1(prevHash, evt);
    const ok = computed.toLowerCase() === want;
    return {
      ok,
      algo: ok ? "v1(prev|action|time|details-stable)" : null,
      tries: [{ algo: "v1(prev|action|time|details-stable)", hash: computed }]
    };
  }







  
  
  async function renderPdfReport(result) {
    let PDFDocument, StandardFonts;
    try {
      ({ PDFDocument, StandardFonts } = require("pdf-lib"));
    } catch (e) {
      const msg = "pdf-lib not installed on server. Run: npm i pdf-lib";
      const err = new Error(msg);
      err._pdfLibMissing = true;
      throw err;
    }

    // pdf-lib StandardFonts use WinAnsi; sanitize any unicode.
    const winAnsiSafe = (txt) => {
      const s = String(txt ?? "");
      return s
        .replace(/\u2192/g, "->")       // →
        .replace(/[\u2014\u2013]/g, "-") // em/en dash — –
        .replace(/[\u2018\u2019]/g, "'") // ‘ ’
        .replace(/[\u201C\u201D]/g, '"') // “ ”
        .replace(/\u2022/g, "*")        // •
        .replace(/\u00A0/g, " ");       // nbsp
    };

    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([612, 792]); // Letter
    const { height } = page.getSize();

    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontB = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const margin = 48;
    let y = height - margin;

    const draw = (text, bold=false, size=11, gap=14) => {
      page.drawText(winAnsiSafe(text), { x: margin, y, size, font: bold ? fontB : font });
      y -= gap;
    };

    draw("PDFRealm - Court Verification Report", true, 16, 22);
    draw("Purpose: Verify an Evidence Bundle (.tar.gz) is intact and untampered.", false, 11, 18);

    draw("Verdict", true, 13, 18);
    draw(result.valid ? "VALID - Hash matches manifest" : "INVALID - Hash mismatch / bundle issue", true, 12, 16);

    draw("Evidence Details", true, 13, 18);
    draw("Evidence ID: " + (result.evidenceId || "(unknown)"));
    draw("Filename: " + (result.filename || "(unknown)"));
    draw("Expected SHA-256: " + (result.expectedSha256 || "(missing)"));
    draw("Actual SHA-256: " + (result.actualSha256 || "(missing)"));
    if (result.reason) draw("Reason: " + result.reason);

    draw("Event Log Verification", true, 13, 18);
    draw("events.jsonl present: " + (result.eventChain?.hasEvents ? "yes" : "no"));
    draw("hash fields present: " + (result.eventChain?.hashFieldsPresent ? "yes" : "no"));
    draw("chain continuity: " + (result.eventChain?.continuityOk ? "ok" : (result.eventChain?.continuityOk === false ? "FAILED" : "n/a")));
    draw("event hash validation: " + (result.eventChain?.hashesOk ? "ok" : (result.eventChain?.hashesOk === false ? "FAILED" : "n/a")));
    if (result.eventChain?.hashAlgo) draw("event hash algo detected: " + result.eventChain.hashAlgo);
    if (result.eventChain?.note) draw("Note: " + result.eventChain.note);

    draw("Verification Metadata", true, 13, 18);
    draw("Verified At: " + (result.verifiedAt || new Date().toISOString()));
    draw("Verified By User ID: " + (result.verifiedBy || "(unknown)"));
    draw("Hash Algo: SHA-256");
    draw("Event Hash Algo: sha256(prevHash|action|createdAt|detailsJson)");
    // NOTE: use ASCII '->' if you want arrows in text.

    const bytes = await pdfDoc.save();
    return Buffer.from(bytes);
  }



  const run = async (filePath) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "court-verify-"));
    const cleanup = () => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {} };

    try {
      // Extract bundle
      await new Promise((resolve, reject) => {
        const tar = spawn("tar", ["-xzf", filePath, "-C", tmpRoot]);
        let err = "";
        tar.stderr.on("data", d => { err += String(d); });
        tar.on("error", (e) => reject(e));
        tar.on("close", (code) => code === 0 ? resolve() : reject(new Error("tar failed: " + err)));
      });

      const manifestPath = path.join(tmpRoot, "manifest.json");
      const eventsPath = path.join(tmpRoot, "events.jsonl");

      if (!fs.existsSync(manifestPath)) {
        cleanup();
        const out = { valid:false, reason:"manifest.json missing" };
        if (wantPdf) throw Object.assign(new Error(out.reason), { _result: out, _client400: true });
        return res.status(400).json(out);
      }

      let manifest;
      try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); }
      catch (e) {
        cleanup();
        const out = { valid:false, reason:"manifest.json invalid JSON", detail:String(e?.message||e) };
        if (wantPdf) throw Object.assign(new Error(out.reason), { _result: out, _client400: true });
        return res.status(400).json(out);
      }

      // Find original_* file
      const files = fs.readdirSync(tmpRoot);
      const originalName =
        files.find(n => n.startsWith("original_")) ||
        (manifest?.files?.find?.(f => String(f||"").startsWith("original_")) || null);

      if (!originalName) {
        cleanup();
        const out = { valid:false, reason:"original file missing in bundle" };
        if (wantPdf) throw Object.assign(new Error(out.reason), { _result: out, _client400: true });
        return res.status(400).json(out);
      }

      const originalPath = path.join(tmpRoot, originalName);
      if (!fs.existsSync(originalPath)) {
        cleanup();
        const out = { valid:false, reason:"original file referenced but not found", originalName };
        if (wantPdf) throw Object.assign(new Error(out.reason), { _result: out, _client400: true });
        return res.status(400).json(out);
      }

      // Compute sha256
      const actual = sha256Hex(fs.readFileSync(originalPath));
      const expected = manifest?.sha256 ? String(manifest.sha256) : null;

      const result = {
        valid: false,
        evidenceId: manifest?.evidenceId || null,
        filename: manifest?.filename || null,
        expectedSha256: expected,
        actualSha256: actual,
        reason: null,
        verifiedAt: new Date().toISOString(),
        verifiedBy: req.user?.id ? String(req.user.id) : null,
        eventChain: {
          hasEvents: fs.existsSync(eventsPath),
          hashFieldsPresent: null,
          continuityOk: null,
          hashesOk: null,
          hashAlgo: null,
          firstMismatch: null,
          note: null
        }
      };

      if (!expected) {
        result.valid = false;
        result.reason = "manifest missing sha256";
      } else {
        result.valid = actual.toLowerCase() === expected.toLowerCase();
        if (!result.valid) result.reason = "sha256 mismatch (bundle tampered or wrong file)";
      }

      // Event chain verify (non-fatal unless you want it to be)
      if (fs.existsSync(eventsPath)) {
        const lines = fs.readFileSync(eventsPath, "utf8").split(/\r?\n/).filter(Boolean);
        let prev = null;
        let continuityOk = true;
        let hashesOk = true;
        let hashFieldsPresent = false;
        let detectedAlgo = null;

        for (let i = 0; i < lines.length; i++) {
          let evt;
          try { evt = JSON.parse(lines[i]); } catch { evt = { _raw: lines[i] }; }

          const prevField = evt.prev_hash ?? evt.prevHash ?? evt.prevhash ?? null;
          const hashField = evt.event_hash ?? evt.eventHash ?? evt.hash ?? null;

          if (prevField != null || hashField != null) hashFieldsPresent = true;

          // continuity check: prevField should match previous event hash (if both exist)
          if (prevField != null && prev != null && String(prevField) !== String(prev)) {
            continuityOk = false;
          }
          if (prevField != null && prev == null && String(prevField).length > 0) {
            // first event should have null/empty prev
            continuityOk = false;
          }

          // hash check: if event hash exists, validate with our algorithm
          if (hashField != null) {
            const v = validateEventHash(prevField || "", evt, hashField, lines[i]);
            if (!v.ok) {
              hashesOk = false;
              if (!result.eventChain.firstMismatch) {
                // Store a small, non-sensitive summary for debugging the hashing recipe
                const action = String(evt.action ?? evt.Action ?? evt.type ?? evt.event_type ?? "");
                const createdAt = String(evt.created_at ?? evt.createdAt ?? evt.time ?? evt.timestamp ?? "");
                const details = evt.details ?? evt.Details ?? evt.meta ?? evt.data ?? null;
                const summary = {
                  action,
                  createdAt,
                  keys: Object.keys(evt || {}).slice(0, 40),
                  detailsPreview: stableStringify(details).slice(0, 600)
                };
                result.eventChain.firstMismatch = {
                  index: i,
                  prevHash: prevField || null,
                  providedHash: hashField || null,
                  candidates: (v.tries || []).map(t => ({ algo: t.algo, hash: t.hash })).slice(0, 25),
                  eventSummary: summary
                };
              }
            } else {
              // track detected algorithm (first match wins)
              if (!detectedAlgo) detectedAlgo = v.algo;
            }
            prev = String(hashField);
          } else {
            // if no hash field, we can't advance prev reliably
            // but we can attempt: if row has event_hash-like fields missing, keep prev as-is
          }
        }

        result.eventChain.hashFieldsPresent = hashFieldsPresent;
        result.eventChain.continuityOk = hashFieldsPresent ? continuityOk : null;
        result.eventChain.hashesOk = hashFieldsPresent ? hashesOk : null;
        result.eventChain.hashAlgo = detectedAlgo;
        result.eventChain.note = hashFieldsPresent
          ? "Continuity checks prev_hash -> event_hash; hash checks use strict v1: sha256(prev_hash + "|" + action + "|" + created_at + "|" + stable_json(details))."
          : "No prev_hash/event_hash fields found in events.jsonl; chain verification not available yet.";

        // If you want chain failure to flip verdict, uncomment:
        // if (hashFieldsPresent && (!continuityOk || !hashesOk)) { result.valid = false; result.reason = "event log chain failed verification"; }
      } else {
        result.eventChain.note = "events.jsonl not present; only file hash was verified.";
      }

      if (!wantPdf) {
        cleanup();
        return res.status(200).json(result);
      }

      try {
        const pdf = await renderPdfReport(result);
        cleanup();
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", "attachment; filename=\"court_verification_" + (result.evidenceId || "bundle") + ".pdf\"");
        return res.status(200).send(pdf);
      } catch (e) {
        cleanup();
        if (e && e._pdfLibMissing) {
          return res.status(500).json({ valid:false, error:"PDF report unavailable", detail:String(e.message) });
        }
        return res.status(500).json({ valid:false, error:"PDF report failed", detail:String(e?.message||e) });
      }

    } catch (e) {
      cleanup();
      const out = e?._result || { valid:false, error:"verify failed", detail:String(e?.message||e) };
      const code = e?._client400 ? 400 : 500;
      return res.status(code).json(out);
    }
  };

  if (multer) {
    const up = multer({ dest: path.join(require("os").tmpdir(), "court-verify-upload-") }).single("bundle");
    return up(req, res, async (err) => {
      if (err) return res.status(400).json({ valid:false, error:"upload failed", detail:String(err?.message||err) });
      const fp = req.file && req.file.path;
      if (!fp) return res.status(400).json({ valid:false, error:"Missing bundle file (field name: bundle)" });
      return run(fp);
    });
  }

  // Fallback: express-fileupload style (req.files.bundle)
  const f = req.files && (req.files.bundle || req.files.file);
  if (!f) return res.status(400).json({ valid:false, error:"Missing bundle file (field name: bundle)" });

  const tmpPath = require("path").join(require("os").tmpdir(), "court-verify-" + Date.now() + ".tar.gz");
  try {
    if (typeof f.mv === "function") {
      await new Promise((resolve, reject) => f.mv(tmpPath, (e) => e ? reject(e) : resolve()));
    } else {
      require("fs").writeFileSync(tmpPath, f.data);
    }
  } catch (e) {
    return res.status(400).json({ valid:false, error:"Failed to save upload", detail:String(e?.message||e) });
  }

  return run(tmpPath);
});



// ============================================================
// PAY-PER-ACCESS — Stripe ($2.99 / 24h all-tools pass)
// ============================================================
(function mountPayPerAccess() {
  let stripe;
  try {
    stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
  } catch (e) {
    console.warn("[pay-per-access] Stripe not available:", e.message);
    return;
  }

  const PRICE_ID   = process.env.STRIPE_PRICE_ID_ALLTOOLS;
  const APP_URL    = (process.env.APP_URL || "http://localhost:" + PORT).replace(/\/$/, "");
  const TOKEN_TTL  = 24 * 60 * 60 * 1000; // 24 hours in ms
  const PPE_TABLE  = "pay_per_export_sessions";

  // ── Helper: create a signed 24h session token ──────────────
  function issuePpeToken() {
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + TOKEN_TTL);
    return { token, expiresAt };
  }

  // ── POST /api/pay-per-export/create-checkout-session ───────
  // Frontend calls this when an unauthenticated user hits a paywalled tool.
  app.post("/api/pay-per-export/create-checkout-session", express.json(), async (req, res) => {
    if (!PRICE_ID) return res.status(500).json({ error: "STRIPE_PRICE_ID_ALLTOOLS not configured." });
    try {
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [{ price: PRICE_ID, quantity: 1 }],
        success_url: `${APP_URL}/paywall-success.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url:  `${APP_URL}/`,
        metadata: { product: "alltools_24h" },
      });
      res.json({ checkoutUrl: session.url, sessionId: session.id });
    } catch (e) {
      console.error("[pay-per-export] checkout error:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/pay-per-export/activate?session_id=xxx ────────
  // Called from paywall-success.html after Stripe redirect.
  // Verifies payment, issues a 24h access token, stores in DB + cookie.
  app.get("/api/pay-per-export/activate", async (req, res) => {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ error: "Missing session_id." });

    try {
      // Verify with Stripe
      const stripeSession = await stripe.checkout.sessions.retrieve(session_id);
      if (stripeSession.payment_status !== "paid") {
        return res.status(402).json({ error: "Payment not completed." });
      }

      // Check if already activated (idempotent)
      const existing = await pool.query(
        `SELECT token, expires_at FROM ${PPE_TABLE} WHERE stripe_session_id = $1 LIMIT 1`,
        [session_id]
      ).catch(() => null);

      let token, expiresAt;
      if (existing && existing.rowCount > 0) {
        token     = existing.rows[0].token;
        expiresAt = existing.rows[0].expires_at;
      } else {
        ({ token, expiresAt } = issuePpeToken());
        await pool.query(
          `INSERT INTO ${PPE_TABLE} (stripe_session_id, token, expires_at, created_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (stripe_session_id) DO NOTHING`,
          [session_id, token, expiresAt]
        );
      }

      // Set httpOnly cookie + return token for localStorage fallback
      res.cookie("ppe_token", token, {
        httpOnly: false, // frontend needs to read it
        secure: APP_URL.startsWith("https"),
        sameSite: "lax",
        expires: new Date(expiresAt),
      });

      res.json({ ok: true, token, expiresAt });
    } catch (e) {
      console.error("[pay-per-export] activate error:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/pay-per-export/status ─────────────────────────
  // Frontend polls this on load to check if user has an active pass.
  app.get("/api/pay-per-export/status", async (req, res) => {
    const token = req.headers["x-ppe-session"] || req.cookies?.ppe_token;
    if (!token) return res.json({ active: false });

    try {
      const result = await pool.query(
        `SELECT expires_at FROM ${PPE_TABLE} WHERE token = $1 AND expires_at > NOW() LIMIT 1`,
        [token]
      );
      if (result.rowCount > 0) {
        res.json({ active: true, expiresAt: result.rows[0].expires_at });
      } else {
        res.json({ active: false });
      }
    } catch (e) {
      res.json({ active: false });
    }
  });

  // ── Stripe webhook (optional but recommended for reliability) ──
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (webhookSecret) {
    app.post(
      "/api/stripe/webhook",
      express.raw({ type: "application/json" }),
      async (req, res) => {
        let event;
        try {
          event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], webhookSecret);
        } catch (e) {
          return res.status(400).json({ error: "Webhook signature invalid." });
        }

        if (event.type === "checkout.session.completed") {
          const s = event.data.object;
          if (s.payment_status === "paid" && s.metadata?.product === "alltools_24h") {
            const { token, expiresAt } = issuePpeToken();
            await pool.query(
              `INSERT INTO ${PPE_TABLE} (stripe_session_id, token, expires_at, created_at)
               VALUES ($1, $2, $3, NOW())
               ON CONFLICT (stripe_session_id) DO NOTHING`,
              [s.id, token, expiresAt]
            ).catch(e => console.error("[webhook] DB insert failed:", e.message));
          }
          // Handle AI credits purchase
          if (s.mode === 'payment' && s.metadata?.kind === 'ai_credits') {
            const userId = String(s.metadata?.userId || '').trim();
            const credits = parseInt(s.metadata?.credits || '0', 10);
            if (userId && credits > 0) {
              await addAiCredits(userId, credits).catch(e => console.error('[ai-credits] add failed:', e.message));
            }
          }
        }
        if (event.type === 'invoice.paid') {
          const inv = event.data.object;
          const userId = inv.metadata?.userId || inv.subscription_details?.metadata?.userId || '';
          const revenueCents = Number(inv.amount_paid || 0);
          if (userId && revenueCents > 0) {
            createReferralCommission(
              inv.id,
              inv.charge,
              userId,
              inv.subscription,
              revenueCents,
              new Date(inv.created * 1000)
            ).catch(e => console.warn('[referral] commission error:', e.message));
          }
        }
        res.json({ received: true });
      }
    );
  }

  console.log("[pay-per-access] Stripe routes mounted. PRICE_ID=" + (PRICE_ID || "MISSING"));
})();


// ============================================================
// SIGNATURE REQUESTS FEATURE (moved before 404 handler)
// ============================================================

// POST /api/sign-requests/create
app.post('/api/sign-requests/create', requireAuth, upload.single('pdf'), async (req, res) => {
  try {
    await ensureSignRequestSchema();
    if (!req.file) return res.status(400).json({ error: 'PDF required' });
    const title = String(req.body.title || req.file.originalname || 'Untitled').trim();
    const message = String(req.body.message || '').trim();
    const requesterName = String(req.body.requesterName || req.user.name || '').trim();
    const requesterEmail = String(req.body.requesterEmail || req.user.email || '').trim();
    const recipientsRaw = String(req.body.recipients || '');
    const expiresInDays = Math.min(30, Math.max(1, parseInt(req.body.expiresInDays || '7', 10)));
    const recipients = parseSignRecipients(recipientsRaw);
    if (!recipients.length) return res.status(400).json({ error: 'At least one recipient required' });
    const originalSha = sha256Hex(req.file.buffer);
    const s3Key = `sign-requests/${req.user.id}/orig/${Date.now()}-${originalSha.slice(0,8)}.pdf`;
    await __signS3.send(new PutObjectCommand({ Bucket: __signVaultBucket, Key: s3Key, Body: req.file.buffer, ContentType: 'application/pdf' }));
    const id = signReqId();
    const expiresAt = new Date(Date.now() + expiresInDays * 86400000);
    await pool.query(`INSERT INTO sign_requests (id,user_id,title,message,requester_name,requester_email,original_filename,original_s3_key,original_sha256,status,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10)`, [id, req.user.id, title, message||null, requesterName||null, requesterEmail||null, req.file.originalname, s3Key, originalSha, expiresAt]);
    for (let i = 0; i < recipients.length; i++) {
      const r = recipients[i];
      await pool.query(`INSERT INTO sign_recipients (id,request_id,sequence,name,email,status) VALUES ($1,$2,$3,$4,$5,'pending')`, [signRecipId(), id, i, r.name||null, r.email]);
    }
    res.json({ ok: true, id, title, recipientCount: recipients.length });
  } catch (e) { console.error('sign-req create error:', e); res.status(500).json({ error: String(e?.message||e) }); }
});

// POST /api/sign-requests/:id/send
app.post('/api/sign-requests/:id/send', requireAuth, async (req, res) => {
  try {
    await ensureSignRequestSchema();
    const request = (await pool.query('SELECT * FROM sign_requests WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id])).rows[0];
    if (!request) return res.status(404).json({ error: 'Not found' });
    const recipients = (await pool.query('SELECT * FROM sign_recipients WHERE request_id=$1 ORDER BY sequence ASC', [req.params.id])).rows;
    const nextPending = recipients.find(r => r.status === 'pending' || r.status === 'sent');
    if (!nextPending) return res.json({ ok: false, message: 'No pending recipients' });
    const { raw, hash } = issueSignToken();
    const signUrl = `${process.env.PUBLIC_BASE_URL || 'https://pdfrealm.com'}/sign-request?token=${encodeURIComponent(raw)}`;
    await pool.query("UPDATE sign_recipients SET token_hash=$1, status='sent' WHERE id=$2", [hash, nextPending.id]);
    await pool.query("UPDATE sign_requests SET status='sent', last_sent_at=NOW() WHERE id=$1", [req.params.id]);
    await pool.query(`INSERT INTO sign_events (request_id,recipient_id,kind,detail) VALUES ($1,$2,'sent',$3)`, [req.params.id, nextPending.id, JSON.stringify({ email: nextPending.email })]);
    await sendEmail({ to: nextPending.email, subject: `${request.requester_name || 'Someone'} requested your signature`, html: signRequestEmailHtml({ requesterName: request.requester_name, recipientName: nextPending.name, title: request.title, message: request.message, signUrl, expiresAt: request.expires_at ? new Date(request.expires_at).toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric'}) : null }) });
    res.json({ ok: true, sentTo: nextPending.email });
  } catch (e) { console.error('sign-req send error:', e); res.status(500).json({ error: String(e?.message||e) }); }
});

// GET /api/sign-requests
app.get('/api/sign-requests', requireAuth, async (req, res) => {
  try {
    await ensureSignRequestSchema();
    const rows = (await pool.query(`SELECT r.*, (SELECT COUNT(*) FROM sign_recipients WHERE request_id=r.id) as recipient_count, (SELECT COUNT(*) FROM sign_recipients WHERE request_id=r.id AND status='signed') as signed_count FROM sign_requests r WHERE r.user_id=$1 ORDER BY r.created_at DESC LIMIT 50`, [req.user.id])).rows;
    res.json({ ok: true, requests: rows });
  } catch (e) { res.status(500).json({ error: String(e?.message||e) }); }
});

// GET /api/sign-requests/:id
app.get('/api/sign-requests/:id', requireAuth, async (req, res) => {
  try {
    await ensureSignRequestSchema();
    const request = (await pool.query('SELECT * FROM sign_requests WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id])).rows[0];
    if (!request) return res.status(404).json({ error: 'Not found' });
    const recipients = (await pool.query('SELECT * FROM sign_recipients WHERE request_id=$1 ORDER BY sequence ASC', [req.params.id])).rows;
    const events = (await pool.query('SELECT * FROM sign_events WHERE request_id=$1 ORDER BY created_at ASC LIMIT 100', [req.params.id])).rows;
    const artifacts = (await pool.query('SELECT * FROM sign_artifacts WHERE request_id=$1', [req.params.id])).rows;
    res.json({ ok: true, request, recipients, events, artifacts });
  } catch (e) { res.status(500).json({ error: String(e?.message||e) }); }
});

// POST /api/sign-requests/:id/remind
app.post('/api/sign-requests/:id/remind', requireAuth, async (req, res) => {
  try {
    await ensureSignRequestSchema();
    const request = (await pool.query('SELECT * FROM sign_requests WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id])).rows[0];
    if (!request) return res.status(404).json({ error: 'Not found' });
    const current = (await pool.query("SELECT * FROM sign_recipients WHERE request_id=$1 AND status IN ('sent','pending') ORDER BY sequence ASC LIMIT 1", [req.params.id])).rows[0];
    if (!current) return res.json({ ok: false, message: 'No pending signer to remind' });
    const { raw, hash } = issueSignToken();
    const signUrl = `${process.env.PUBLIC_BASE_URL || 'https://pdfrealm.com'}/sign-request?token=${encodeURIComponent(raw)}`;
    await pool.query('UPDATE sign_recipients SET token_hash=$1 WHERE id=$2', [hash, current.id]);
    await sendEmail({ to: current.email, subject: `Reminder: ${request.requester_name || 'Someone'} is waiting for your signature`, html: signRequestEmailHtml({ requesterName: request.requester_name, recipientName: current.name, title: request.title, message: 'This is a reminder to sign the document.', signUrl, expiresAt: null }) });
    res.json({ ok: true, remindedEmail: current.email });
  } catch (e) { res.status(500).json({ error: String(e?.message||e) }); }
});

// GET /api/sign-token/:token (public)
app.get('/api/sign-token/:token', async (req, res) => {
  try {
    await ensureSignRequestSchema();
    const hash = hashSignToken(req.params.token);
    const recipient = (await pool.query(`SELECT r.*, req.title, req.message, req.original_s3_key, req.original_filename, req.expires_at, req.status as req_status, req.requester_name, req.requester_email, req.proof_token, req.proof_enabled, req.id as request_id FROM sign_recipients r JOIN sign_requests req ON req.id=r.request_id WHERE r.token_hash=$1`, [hash])).rows[0];
    if (!recipient) return res.status(404).json({ error: 'Invalid or expired link' });
    const expired = recipient.expires_at && new Date(recipient.expires_at) < new Date();
    if (expired) return res.status(410).json({ error: 'This signing link has expired' });
    if (recipient.req_status === 'completed') return res.json({ ok: true, alreadyCompleted: true, title: recipient.title });
    if (recipient.status === 'signed') return res.json({ ok: true, alreadySigned: true, title: recipient.title });
    if (recipient.status === 'declined') return res.json({ ok: true, alreadyDeclined: true });
    const allRecipients = (await pool.query('SELECT * FROM sign_recipients WHERE request_id=$1 ORDER BY sequence ASC', [recipient.request_id])).rows;
    const myIndex = allRecipients.findIndex(r => r.token_hash === hash);
    const earlierUnsigned = allRecipients.find((r, i) => i < myIndex && r.status !== 'signed');
    if (earlierUnsigned) return res.status(403).json({ error: 'Waiting for an earlier signer to complete' });
    if (!recipient.viewed_at) {
      await pool.query("UPDATE sign_recipients SET viewed_at=NOW(), status='viewed' WHERE token_hash=$1", [hash]);
      await pool.query("INSERT INTO sign_events (request_id,recipient_id,kind,ip_address,user_agent) VALUES ($1,$2,'viewed',$3,$4)", [recipient.request_id, recipient.id, req.ip, req.headers['user-agent']||'']);
    }
    const pdfUrl = await getSignedUrl(__signS3, new GetObjectCommand({ Bucket: __signVaultBucket, Key: recipient.original_s3_key }), { expiresIn: 3600 });
    res.json({ ok: true, recipientId: recipient.id, requestId: recipient.request_id, title: recipient.title, message: recipient.message, requesterName: recipient.requester_name, originalFilename: recipient.original_filename, expiresAt: recipient.expires_at, pdfUrl });
  } catch (e) { console.error('sign-token get error:', e); res.status(500).json({ error: String(e?.message||e) }); }
});

// POST /api/sign-token/:token (submit signature)
app.post('/api/sign-token/:token', async (req, res) => {
  try {
    await ensureSignRequestSchema();
    const hash = hashSignToken(req.params.token);
    const recipient = (await pool.query(`SELECT r.*, req.title, req.original_s3_key, req.original_filename, req.original_sha256, req.requester_name, req.requester_email, req.proof_token, req.proof_enabled, req.expires_at, req.id as request_id, req.user_id as owner_user_id FROM sign_recipients r JOIN sign_requests req ON req.id=r.request_id WHERE r.token_hash=$1`, [hash])).rows[0];
    if (!recipient) return res.status(404).json({ error: 'Invalid link' });
    const expired = recipient.expires_at && new Date(recipient.expires_at) < new Date();
    if (expired) return res.status(410).json({ error: 'Expired' });
    if (recipient.status === 'signed') return res.status(409).json({ error: 'Already signed' });
    const signerName = String(req.body.signerName || '').trim();
    const signedAt = new Date().toISOString();
    const ipAddress = req.ip || '';
    const userAgent = req.headers['user-agent'] || '';
    const origObj = await __signS3.send(new GetObjectCommand({ Bucket: __signVaultBucket, Key: recipient.original_s3_key }));
    const chunks = [];
    for await (const chunk of origObj.Body) chunks.push(chunk);
    const origPdfBytes = Buffer.concat(chunks);
    const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
    const pdfDoc = await PDFDocument.load(origPdfBytes);
    const pages = pdfDoc.getPages();
    const placements = req.body.placements ? JSON.parse(req.body.placements) : [];
    const font = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
    const sigText = signerName || 'Signed';
    for (const p of placements) {
      const pageIndex = Math.max(0, Math.min(pages.length - 1, (p.page || 1) - 1));
      const page = pages[pageIndex];
      const { width, height } = page.getSize();
      const x = (p.xPct || 0.1) * width; const y = height - (p.yPct || 0.8) * height;
      const boxW = (p.wPct || 0.3) * width; const boxH = (p.hPct || 0.08) * height;
      const fontSize = Math.max(10, Math.min(boxH * 0.5, 32));
      page.drawRectangle({ x, y, width: boxW, height: boxH, borderColor: rgb(0,0,0), borderWidth: 0.5 });
      page.drawText(sigText, { x: x + 4, y: y + boxH * 0.3, size: fontSize, font, color: rgb(0.05, 0.1, 0.4) });
      page.drawText(`Signed: ${new Date(signedAt).toLocaleDateString()}`, { x: x + 4, y: y + 4, size: 7, font, color: rgb(0.4,0.4,0.4) });
    }
    if (!placements.length) {
      const page = pages[pages.length - 1];
      const font2 = await pdfDoc.embedFont(StandardFonts.Helvetica);
      page.drawText(`Electronically signed by ${sigText} on ${new Date(signedAt).toLocaleString()}`, { x: 40, y: 20, size: 8, font: font2, color: rgb(0.5,0.5,0.5) });
    }
    const signedPdfBytes = await pdfDoc.save();
    const signedSha = sha256Hex(signedPdfBytes);
    const signedKey = `sign-requests/${recipient.owner_user_id}/signed/${Date.now()}-${signedSha.slice(0,8)}.pdf`;
    await __signS3.send(new PutObjectCommand({ Bucket: __signVaultBucket, Key: signedKey, Body: signedPdfBytes, ContentType: 'application/pdf' }));
    const allRecipients = (await pool.query('SELECT * FROM sign_recipients WHERE request_id=$1 ORDER BY sequence ASC', [recipient.request_id])).rows;
    const myIndex = allRecipients.findIndex(r => r.token_hash === hash);
    const nextPending = allRecipients.find((r, i) => i > myIndex && r.status !== 'signed');
    await pool.query(`UPDATE sign_recipients SET status='signed', signer_name=$1, signed_at=$2, consented_at=$2, ip_address=$3, user_agent=$4 WHERE token_hash=$5`, [signerName, signedAt, ipAddress, userAgent, hash]);
    await pool.query(`INSERT INTO sign_events (request_id,recipient_id,kind,ip_address,user_agent,detail) VALUES ($1,$2,'signed',$3,$4,$5)`, [recipient.request_id, recipient.id, ipAddress, userAgent, JSON.stringify({ signerName, signedSha, sequence: allRecipients[myIndex]?.sequence })]);
    if (nextPending) {
      const { raw, hash: nextHash } = issueSignToken();
      const signUrl = `${process.env.PUBLIC_BASE_URL || 'https://pdfrealm.com'}/sign-request?token=${encodeURIComponent(raw)}`;
      await pool.query("UPDATE sign_recipients SET token_hash=$1, status='sent' WHERE id=$2", [nextHash, nextPending.id]);
      await pool.query("UPDATE sign_requests SET status='sent', signed_s3_key=$1, signed_sha256=$2 WHERE id=$3", [signedKey, signedSha, recipient.request_id]);
      await sendEmail({ to: nextPending.email, subject: `${recipient.requester_name || 'Someone'} requested your signature on "${recipient.title}"`, html: signRequestEmailHtml({ requesterName: recipient.requester_name, recipientName: nextPending.name, title: recipient.title, message: recipient.message, signUrl, expiresAt: null }) });
      const downloadUrl = await getSignedUrl(__signS3, new GetObjectCommand({ Bucket: __signVaultBucket, Key: signedKey }), { expiresIn: 86400 });
      return res.json({ ok: true, advanced: true, message: 'Signature applied. Next signer has been notified.', downloadUrl });
    }
    await pool.query(`UPDATE sign_requests SET status='completed', completed_at=$1, signed_s3_key=$2, signed_sha256=$3 WHERE id=$4`, [signedAt, signedKey, signedSha, recipient.request_id]);
    await pool.query(`INSERT INTO sign_artifacts (request_id,kind,s3_key,filename,mime,bytes,sha256) VALUES ($1,'signed_pdf',$2,$3,'application/pdf',$4,$5)`, [recipient.request_id, signedKey, `signed-${recipient.original_filename}`, signedPdfBytes.length, signedSha]);
    await pool.query(`INSERT INTO sign_events (request_id,recipient_id,kind,detail) VALUES ($1,$2,'completed',$3)`, [recipient.request_id, recipient.id, JSON.stringify({ finalSigner: true, signedSha })]);
    if (recipient.requester_email) {
      const dlUrl = await getSignedUrl(__signS3, new GetObjectCommand({ Bucket: __signVaultBucket, Key: signedKey }), { expiresIn: 86400 });
      await sendEmail({ to: recipient.requester_email, subject: `"${recipient.title}" has been fully signed`, html: signCompletionEmailHtml({ requesterName: recipient.requester_name, title: recipient.title, signerCount: allRecipients.length, downloadUrl: dlUrl, proofUrl: recipient.proof_enabled ? `${process.env.PUBLIC_BASE_URL||'https://pdfrealm.com'}/proof/${recipient.proof_token}` : null }) });
    }
    const finalUrl = await getSignedUrl(__signS3, new GetObjectCommand({ Bucket: __signVaultBucket, Key: signedKey }), { expiresIn: 86400 });
    res.json({ ok: true, completed: true, message: 'Document fully signed.', downloadUrl: finalUrl, proofPath: recipient.proof_enabled ? `/proof/${recipient.proof_token}` : null });
  } catch (e) { console.error('sign-token post error:', e); res.status(500).json({ error: String(e?.message||e) }); }
});

// POST /api/sign-token/:token/decline
app.post('/api/sign-token/:token/decline', async (req, res) => {
  try {
    await ensureSignRequestSchema();
    const hash = hashSignToken(req.params.token);
    const recipient = (await pool.query('SELECT r.*, req.title, req.requester_email, req.requester_name, req.id as request_id FROM sign_recipients r JOIN sign_requests req ON req.id=r.request_id WHERE r.token_hash=$1', [hash])).rows[0];
    if (!recipient) return res.status(404).json({ error: 'Invalid link' });
    if (recipient.status === 'signed') return res.status(409).json({ error: 'Already signed' });
    if (recipient.status === 'declined') return res.json({ ok: true, alreadyDeclined: true });
    const reason = String(req.body.reason || '').trim().slice(0, 500);
    await pool.query("UPDATE sign_recipients SET status='declined', declined_at=NOW(), decline_reason=$1 WHERE token_hash=$2", [reason||null, hash]);
    await pool.query("UPDATE sign_requests SET status='declined' WHERE id=$1", [recipient.request_id]);
    await pool.query("INSERT INTO sign_events (request_id,recipient_id,kind,detail) VALUES ($1,$2,'declined',$3)", [recipient.request_id, recipient.id, JSON.stringify({ reason: reason||null })]);
    if (recipient.requester_email) {
      await sendEmail({ to: recipient.requester_email, subject: `Signature declined: ${recipient.title}`, html: `<div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:20px;"><h2>Signature request declined</h2><p><b>${recipient.email}</b> declined to sign <b>${recipient.title}</b>.</p>${reason ? `<p>Reason: ${reason.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</p>` : ''}<p style="font-size:11px;color:#9ca3af;">PDFRealm</p></div>` });
    }
    res.json({ ok: true, declined: true });
  } catch (e) { res.status(500).json({ error: String(e?.message||e) }); }
});

// GET /api/sign-proof/:token (public)
app.get('/api/sign-proof/:token', async (req, res) => {
  try {
    await ensureSignRequestSchema();
    const request = (await pool.query('SELECT * FROM sign_requests WHERE proof_token=$1 AND proof_enabled=true', [req.params.token])).rows[0];
    if (!request) return res.status(404).json({ error: 'Not found or proof not enabled' });
    const recipients = (await pool.query('SELECT id,sequence,name,email,status,viewed_at,signed_at,declined_at,signer_name FROM sign_recipients WHERE request_id=$1 ORDER BY sequence ASC', [request.id])).rows.map(r => ({ ...r, email: r.email ? r.email.replace(/(.{2}).*(@.*)/, '$1***$2') : '' }));
    const events = (await pool.query('SELECT kind,created_at,detail FROM sign_events WHERE request_id=$1 ORDER BY created_at ASC LIMIT 50', [request.id])).rows;
    res.json({ ok: true, title: request.title, status: request.status, createdAt: request.created_at, completedAt: request.completed_at, originalSha256: request.original_sha256, signedSha256: request.signed_sha256, recipients, events });
  } catch (e) { res.status(500).json({ error: String(e?.message||e) }); }
});

// ============================================================
// END SIGNATURE REQUESTS FEATURE (moved before 404 handler)
// ============================================================

// ============================================================
// REFERRAL PROGRAM - Admin Middleware + API Routes
// ============================================================

async function requireAdmin(req, res, next) {
  if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
  const admin = await isAdminUser(req.user.id).catch(() => false);
  if (!admin) return res.status(403).json({ error: 'Forbidden' });
  next();
}

// Partner routes
app.get('/api/admin/referral-partners', requireAuth, requireAdmin, async (req, res) => {
  await ensureReferralSchema();
  const r = await pool.query(`
    SELECT p.*,
      (SELECT COUNT(*) FROM referral_attributions WHERE referral_partner_id=p.id) as attribution_count,
      (SELECT COUNT(*) FROM referral_commissions WHERE referral_partner_id=p.id) as commission_count,
      (SELECT COALESCE(SUM(commission_cents),0) FROM referral_commissions WHERE referral_partner_id=p.id AND status IN ('pending','approved')) as owed_cents,
      (SELECT COALESCE(SUM(amount_cents),0) FROM referral_payouts WHERE referral_partner_id=p.id AND status='paid') as paid_cents
    FROM referral_partners p ORDER BY p.created_at DESC
  `);
  res.json({ partners: r.rows });
});

app.post('/api/admin/referral-partners', requireAuth, requireAdmin, express.json(), async (req, res) => {
  await ensureReferralSchema();
  const { name, email, code, commissionRateBps, commissionMonths, notes } = req.body;
  const r = await pool.query(`
    INSERT INTO referral_partners (name, email, code, commission_rate_bps, commission_months, notes)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
  `, [name, email, String(code||'').toUpperCase(), Number(commissionRateBps||2000), Number(commissionMonths||24), notes||'']);
  res.json({ partner: r.rows[0] });
});

app.patch('/api/admin/referral-partners/:id', requireAuth, requireAdmin, express.json(), async (req, res) => {
  await ensureReferralSchema();
  const { commissionRateBps, commissionMonths, active, notes } = req.body;
  const r = await pool.query(`
    UPDATE referral_partners SET commission_rate_bps=$1, commission_months=$2, active=$3, notes=$4, updated_at=NOW()
    WHERE id=$5 RETURNING *
  `, [Number(commissionRateBps||2000), Number(commissionMonths||24), active !== false, notes||'', req.params.id]);
  res.json({ partner: r.rows[0] });
});

// Commission routes
app.get('/api/admin/referral-commissions', requireAuth, requireAdmin, async (req, res) => {
  await ensureReferralSchema();
  const { partnerId, status } = req.query;
  let q = 'SELECT c.*, p.name as partner_name, p.code as partner_code FROM referral_commissions c JOIN referral_partners p ON p.id=c.referral_partner_id WHERE 1=1';
  const vals = [];
  if (partnerId) { vals.push(partnerId); q += ` AND c.referral_partner_id=$${vals.length}`; }
  if (status) { vals.push(status); q += ` AND c.status=$${vals.length}`; }
  q += ' ORDER BY c.created_at DESC LIMIT 200';
  const r = await pool.query(q, vals);
  res.json({ commissions: r.rows });
});

// Payout routes
app.post('/api/admin/referral-payouts', requireAuth, requireAdmin, express.json(), async (req, res) => {
  await ensureReferralSchema();
  const { referralPartnerId, reference, notes } = req.body;
  const pending = (await pool.query(
    "SELECT id, commission_cents FROM referral_commissions WHERE referral_partner_id=$1 AND payout_id IS NULL AND status IN ('pending','approved')",
    [referralPartnerId]
  )).rows;
  if (!pending.length) return res.status(400).json({ error: 'No pending commissions' });
  const amountCents = pending.reduce((s, p) => s + p.commission_cents, 0);
  const payout = (await pool.query(
    `INSERT INTO referral_payouts (referral_partner_id, amount_cents, status, method, reference, notes, paid_at)
     VALUES ($1, $2, 'paid', 'manual', $3, $4, NOW()) RETURNING *`,
    [referralPartnerId, amountCents, reference||'', notes||'']
  )).rows[0];
  await pool.query(
    `UPDATE referral_commissions SET payout_id=$1, status='paid', updated_at=NOW() WHERE id=ANY($2::text[])`,
    [payout.id, pending.map(p => p.id)]
  );
  res.json({ ok: true, payout, amountCents });
});

// Promotion offer routes
app.get('/api/admin/promotion-offers', requireAuth, requireAdmin, async (req, res) => {
  await ensureReferralSchema();
  const r = await pool.query('SELECT * FROM promotion_offers ORDER BY created_at DESC');
  res.json({ offers: r.rows });
});

app.post('/api/admin/promotion-offers', requireAuth, requireAdmin, express.json(), async (req, res) => {
  await ensureReferralSchema();
  const { code, label, offerType, stripeCouponId, stripePromotionCodeId, notes } = req.body;
  const r = await pool.query(`
    INSERT INTO promotion_offers (code, label, offer_type, stripe_coupon_id, stripe_promotion_code_id, notes)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
  `, [String(code||'').toUpperCase(), label, offerType||'first_month_free', stripeCouponId||'', stripePromotionCodeId||'', notes||'']);
  res.json({ offer: r.rows[0] });
});

// Free account routes
app.get('/api/admin/free-accounts', requireAuth, requireAdmin, async (req, res) => {
  await ensureReferralSchema();
  const r = await pool.query('SELECT * FROM free_account_grants ORDER BY created_at DESC LIMIT 100');
  res.json({ grants: r.rows });
});

app.post('/api/admin/free-accounts', requireAuth, requireAdmin, express.json(), async (req, res) => {
  await ensureReferralSchema();
  const { userId, tierKey, reason, expiresAt } = req.body;
  const grantedByEmail = req.user.email || 'admin';
  const r = await pool.query(`
    INSERT INTO free_account_grants (user_id, tier_key, granted_by_email, reason, expires_at, active)
    VALUES ($1, $2, $3, $4, $5, true)
    ON CONFLICT (user_id) DO UPDATE SET tier_key=$2, granted_by_email=$3, reason=$4, expires_at=$5, active=true, updated_at=NOW()
    RETURNING *
  `, [userId, tierKey||'pro', grantedByEmail, reason||'', expiresAt||null]);
  res.json({ grant: r.rows[0] });
});

app.delete('/api/admin/free-accounts/:userId', requireAuth, requireAdmin, async (req, res) => {
  await ensureReferralSchema();
  await pool.query('UPDATE free_account_grants SET active=false, updated_at=NOW() WHERE user_id=$1', [req.params.userId]);
  res.json({ ok: true });
});

// Admin setup route
app.post('/api/admin/setup', express.json(), async (req, res) => {
  await ensureReferralSchema();
  const secret = process.env.ADMIN_SETUP_SECRET || '';
  if (!secret || req.body.secret !== secret) return res.status(401).json({ error: 'Unauthorized' });
  const email = String(req.body.email || '').toLowerCase();
  const userRes = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
  if (!userRes.rows.length) return res.status(404).json({ error: 'User not found' });
  const userId = userRes.rows[0].id;
  await pool.query('INSERT INTO admin_grants (user_id, role) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET role=$2', [userId, 'owner']);
  res.json({ ok: true, userId });
});

// Referral Hub API (for command center)
app.get('/api/referral-hub', async (req, res) => {
  const secret = process.env.REFERRAL_HUB_SECRET || '';
  if (!secret || req.headers['x-hub-secret'] !== secret) return res.status(401).json({ error: 'Unauthorized' });
  await ensureReferralSchema();
  const [partners, commissions, payouts, freeGrants] = await Promise.all([
    pool.query('SELECT p.*, (SELECT COUNT(*) FROM referral_attributions WHERE referral_partner_id=p.id) as attribution_count FROM referral_partners p ORDER BY p.created_at DESC'),
    pool.query("SELECT id, referral_partner_id, commission_cents, revenue_cents, invoice_paid_at, status FROM referral_commissions WHERE status IN ('pending','approved')"),
    pool.query("SELECT COALESCE(SUM(amount_cents),0) as total FROM referral_payouts WHERE status='paid'"),
    pool.query("SELECT COUNT(*) as count FROM free_account_grants WHERE active=true"),
  ]);
  res.json({
    platform: 'pdfrealm',
    partners: partners.rows,
    pendingCommissions: commissions.rows,
    totalPaidCents: Number(payouts.rows[0]?.total || 0),
    activeFreeGrants: Number(freeGrants.rows[0]?.count || 0),
    syncedAt: new Date().toISOString(),
  });
});

app.post('/api/referral-hub', express.json(), async (req, res) => {
  const secret = process.env.REFERRAL_HUB_SECRET || '';
  if (!secret || req.headers['x-hub-secret'] !== secret) return res.status(401).json({ error: 'Unauthorized' });
  await ensureReferralSchema();
  const { action } = req.body;
  if (action === 'create_partner') {
    const { name, email, code, commissionRateBps, commissionMonths, notes } = req.body;
    const r = await pool.query('INSERT INTO referral_partners (name,email,code,commission_rate_bps,commission_months,notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [name, email, String(code||'').toUpperCase(), Number(commissionRateBps||2000), Number(commissionMonths||24), notes||'']);
    return res.json({ partner: r.rows[0] });
  }
  res.json({ ok: false, error: 'Unknown action' });
});

// ============================================================
// END REFERRAL PROGRAM ROUTES
// ============================================================

// ============================================================
// AI CHAT ASSISTANT ROUTES
// ============================================================

// GET /api/ai-chat/status — get user's credit balance
app.get('/api/ai-chat/status', requireAuth, async (req, res) => {
  await ensureAiChatSchema();
  const userId = req.user.id;
  // Auto-provision 5 free credits on first check
  await pool.query(`
    INSERT INTO ai_chat_credits (user_id, credits, lifetime_credits)
    VALUES ($1, 5, 0) ON CONFLICT (user_id) DO NOTHING
  `, [userId]);
  const r = await pool.query('SELECT credits, lifetime_credits FROM ai_chat_credits WHERE user_id=$1', [userId]);
  res.json({ ok: true, credits: r.rows[0]?.credits ?? 5, lifetimeCredits: r.rows[0]?.lifetime_credits ?? 0 });
});

// Execute AI-detected actions (send email, compress, flatten, watermark)
async function executeAiAction(action, userId, req) {
  const base = `${req.protocol}://${req.get('host')}`;

  // Find file in vault by name
  async function findVaultFile(filename) {
    if (!filename) return null;
    const r = await pool.query(
      "SELECT * FROM vault_files WHERE user_id=$1 AND LOWER(filename) LIKE LOWER($2) AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1",
      [userId, '%' + filename + '%']
    );
    return r.rows[0] || null;
  }

  if (action.action === 'send_email') {
    const file = await findVaultFile(action.filename);
    if (!file) return { message: `I couldn't find a file named "${action.filename}" in your vault. Please check the filename and try again.` };
    if (!action.to) return { message: `I need an email address to send to. Who should I send "${file.filename}" to?` };

    // Get presigned URL
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: vaultBucket, Key: file.object_key }), { expiresIn: 86400 });

    // Send email
    await sendEmail({
      to: action.to,
      subject: action.subject || `${file.filename} — shared via PDFRealm`,
      html: `<div style="font-family:system-ui;max-width:600px;margin:0 auto;padding:20px;">
        <h2>📄 File Shared via PDFRealm AI</h2>
        <p>${action.message || 'A file has been shared with you.'}</p>
        <p><a href="${url}" style="background:#111827;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;display:inline-block;">Download ${file.filename}</a></p>
        <p style="color:#9ca3af;font-size:0.8rem;">Link expires in 24 hours.</p>
      </div>`
    });

    return { message: `✅ Done! I sent "${file.filename}" to ${action.to}. They'll receive a download link valid for 24 hours.` };
  }

  if (action.action === 'compress' || action.action === 'flatten' || action.action === 'watermark') {
    const file = await findVaultFile(action.filename);
    if (!file) return { message: `I couldn't find "${action.filename}" in your vault. What's the exact filename?` };

    // Download from S3
    const { GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
    const obj = await s3.send(new GetObjectCommand({ Bucket: vaultBucket, Key: file.object_key }));
    const chunks = []; for await (const c of obj.Body) chunks.push(c);
    const pdfBuf = Buffer.concat(chunks);

    // Run tool via internal API
    const toolEndpoints = { compress: '/api/compress', flatten: '/api/flatten', watermark: '/api/watermark' };
    const endpoint = toolEndpoints[action.action];

    const fd = new FormData();
    fd.append('file', new Blob([pdfBuf], { type: 'application/pdf' }), file.filename);
    if (action.text) fd.append('text', action.text);

    const toolResp = await fetch(base + endpoint, { method: 'POST', body: fd });
    if (!toolResp.ok) return { message: `I tried to ${action.action} "${file.filename}" but encountered an error. Please try again.` };

    const resultBuf = Buffer.from(await toolResp.arrayBuffer());
    const newName = file.filename.replace('.pdf', `_${action.action}d.pdf`);
    const newKey = `vault/${userId}/${Date.now()}-${newName}`;

    // Save result to vault
    await s3.send(new PutObjectCommand({ Bucket: vaultBucket, Key: newKey, Body: resultBuf, ContentType: 'application/pdf' }));
    await pool.query(
      'INSERT INTO vault_files (user_id, filename, object_key, bytes, folder_path) VALUES ($1,$2,$3,$4,$5)',
      [userId, newName, newKey, resultBuf.length, 'AI Results']
    );

    return { message: `✅ Done! I ${action.action}ed "${file.filename}" and saved the result as "${newName}" in your vault under "AI Results" folder.` };
  }

  if (action.action === 'unknown') {
    return { message: action.message || "I need more details to help with that. Could you be more specific?" };
  }

  return { message: "I understood your request but I'm not sure how to execute that action yet. Try rephrasing or use the tools directly." };
}

// POST /api/ai-chat/message — send a message
app.post('/api/ai-chat/message', requireAuth, express.json({ limit: '50kb' }), async (req, res) => {
  await ensureAiChatSchema();
  const userId = req.user.id;
  const { message, sessionId, toolContext, model: requestedModel } = req.body || {};

  if (!message || !String(message).trim()) return res.status(400).json({ error: 'Message required' });
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'AI not configured' });

  const model = requestedModel === 'gpt-4o' ? 'gpt-4o' : 'gpt-4o-mini';
  const creditsNeeded = model === 'gpt-4o' ? 3 : 1;

  // Check + consume credits
  const consumed = await consumeAiCredit(userId, creditsNeeded);
  if (!consumed) {
    return res.status(402).json({ 
      error: 'Not enough credits', 
      code: 'INSUFFICIENT_CREDITS',
      message: 'You\'ve used all your AI credits. Purchase more to continue.' 
    });
  }

  // Get conversation history (last 10 messages)
  const sid = sessionId || 'default';
  const history = (await pool.query(
    'SELECT role, content FROM ai_chat_messages WHERE user_id=$1 AND session_id=$2 ORDER BY created_at DESC LIMIT 10',
    [userId, sid]
  )).rows.reverse();

  // Build system prompt based on tool context
  const contextPrompts = {
    merge: 'The user is working with the PDF Merge tool — combining multiple PDFs into one.',
    compress: 'The user is working with the PDF Compress tool — reducing file size.',
    watermark: 'The user is working with the PDF Watermark tool — adding text watermarks.',
    encrypt: 'The user is working with the PDF Encrypt tool — password protecting a PDF.',
    redact: 'The user is working with the PDF Redact tool — blacking out sensitive content.',
    ocr: 'The user is working with the PDF OCR tool — extracting text from scanned documents.',
    sign: 'The user is working with the PDF Sign tool — adding electronic signatures.',
    signreqs: 'The user is managing Signature Requests — sending PDFs for others to sign.',
    secure_chat: 'The user is using Secure Chat — end-to-end encrypted messaging.',
    vault: 'The user is viewing the Secure Vault — encrypted file storage.',
    default: 'The user is working in PDFRealm — a comprehensive PDF platform.'
  };

  const contextMsg = contextPrompts[toolContext] || contextPrompts.default;

  // Fetch user's vault files for context
  let vaultContext = '';
  try {
    const vaultResult = await pool.query(
      'SELECT filename, bytes, folder_path, created_at FROM vault_files WHERE user_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 20',
      [userId]
    );
    if (vaultResult.rows.length > 0) {
      vaultContext = '\n\nUser\'s vault files:\n' + vaultResult.rows.map(f =>
        `- ${f.filename} (${Math.round(f.bytes/1024)}KB, folder: ${f.folder_path || 'root'}, uploaded: ${new Date(f.created_at).toLocaleDateString()})`
      ).join('\n');
    }
  } catch {}

  const systemPrompt = `You are the PDFRealm AI Assistant. You help users work with PDFs and documents.

You have two modes:
1. CHAT: Answer questions conversationally about PDFs, features, and workflows
2. ACTION: When the user asks you to DO something, return a JSON action object

Return an ACTION when the user says things like:
- "send [file] to [email]"
- "email [file] to [email]"
- "compress [file]"
- "merge [file1] and [file2]"
- "flatten [file]"
- "watermark [file] with [text]"
- "download [file]"

ACTION format (return ONLY this JSON, no other text):
{"action":"send_email","filename":"contract.pdf","to":"john@example.com","message":"Please review"}
{"action":"compress","filename":"large_doc.pdf"}
{"action":"merge","files":["doc1.pdf","doc2.pdf"]}
{"action":"watermark","filename":"doc.pdf","text":"CONFIDENTIAL"}
{"action":"flatten","filename":"form.pdf"}
{"action":"unknown","message":"I need more details — [what you need]"}

For CHAT responses, just reply conversationally. Do NOT return JSON for chat.

The user's current context: ${contextMsg}
${vaultContext ? 'Files in vault:' + vaultContext : 'No files in vault yet.'}`;

  try {
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: String(message).trim() }
    ];

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model, messages, max_tokens: 500, temperature: 0.7 })
    });

    if (!response.ok) throw new Error(`OpenAI error ${response.status}`);
    const data = await response.json();

    // Check if response is an action
    let reply = data.choices?.[0]?.message?.content || 'Sorry, I had trouble responding.';
    let actionResult = null;

    try {
      const parsed = JSON.parse(reply);
      if (parsed.action) {
        actionResult = await executeAiAction(parsed, userId, req);
        reply = actionResult.message;
      }
    } catch {} // Not JSON, treat as normal chat reply

    // Save both messages
    await pool.query(
      'INSERT INTO ai_chat_messages (user_id, session_id, role, content, model, credits_used, tool_context) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [userId, sid, 'user', String(message).trim(), model, 0, toolContext || null]
    );
    await pool.query(
      'INSERT INTO ai_chat_messages (user_id, session_id, role, content, model, credits_used, tool_context) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [userId, sid, 'assistant', reply, model, creditsNeeded, toolContext || null]
    );

    // Get updated credit balance
    const credits = await getAiCredits(userId);

    res.json({ ok: true, reply, model, creditsUsed: creditsNeeded, creditsRemaining: credits, actionExecuted: !!actionResult });
  } catch (e) {
    // Refund credit on error
    await addAiCredits(userId, creditsNeeded);
    console.error('[ai-chat] error:', e.message);
    res.status(500).json({ error: 'AI request failed. Your credits were not consumed.' });
  }
});

// POST /api/ai-chat/transcribe — transcribe audio via OpenAI Whisper
app.post('/api/ai-chat/transcribe', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file provided' });
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'OpenAI not configured' });

    const FormData = require('form-data');
    const fd = new FormData();
    fd.append('file', req.file.buffer, { filename: req.file.originalname || 'audio.m4a', contentType: req.file.mimetype || 'audio/m4a' });
    fd.append('model', 'whisper-1');
    fd.append('response_format', 'json');

    const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, ...fd.getHeaders() },
      body: fd,
    });

    if (!resp.ok) throw new Error(`Whisper API error: ${resp.status}`);
    const data = await resp.json();
    res.json({ ok: true, text: data.text || '' });
  } catch (e) {
    console.error('[transcribe] error:', e.message);
    res.status(500).json({ error: e.message || 'Transcription failed' });
  }
});

// GET /api/ai-chat/history — get conversation history
app.get('/api/ai-chat/history', requireAuth, async (req, res) => {
  await ensureAiChatSchema();
  const sid = req.query.sessionId || 'default';
  const messages = (await pool.query(
    'SELECT role, content, model, created_at FROM ai_chat_messages WHERE user_id=$1 AND session_id=$2 ORDER BY created_at ASC LIMIT 50',
    [req.user.id, sid]
  )).rows;
  res.json({ ok: true, messages });
});

// POST /api/ai-chat/clear — clear conversation
app.post('/api/ai-chat/clear', requireAuth, express.json(), async (req, res) => {
  await ensureAiChatSchema();
  const sid = req.body?.sessionId || 'default';
  await pool.query('DELETE FROM ai_chat_messages WHERE user_id=$1 AND session_id=$2', [req.user.id, sid]);
  res.json({ ok: true });
});

// POST /api/ai-chat/buy — create Stripe checkout for credit bundle
app.post('/api/ai-chat/buy', requireAuth, express.json(), async (req, res) => {
  const { bundle } = req.body || {};
  const BUNDLES = {
    starter: { credits: 50, priceId: process.env.STRIPE_AI_CREDITS_STARTER, label: '50 AI Credits' },
    standard: { credits: 200, priceId: process.env.STRIPE_AI_CREDITS_STANDARD, label: '200 AI Credits' },
    power: { credits: 500, priceId: process.env.STRIPE_AI_CREDITS_POWER, label: '500 AI Credits' },
  };
  const b = BUNDLES[bundle];
  if (!b) return res.status(400).json({ error: 'Invalid bundle' });

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(503).json({ error: 'Payments not configured' });

  const Stripe = require('stripe');
  const stripe = new Stripe(stripeKey);
  const origin = process.env.PUBLIC_BASE_URL || 'https://pdfrealm.com';

  const lineItem = b.priceId
    ? { price: b.priceId, quantity: 1 }
    : { price_data: { currency: 'usd', unit_amount: bundle === 'starter' ? 499 : bundle === 'standard' ? 1499 : 2499, product_data: { name: b.label, description: `${b.credits} AI assistant credits for PDFRealm` } }, quantity: 1 };

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [lineItem],
    success_url: `${origin}/?ai_credits_purchased=1&bundle=${bundle}`,
    cancel_url: `${origin}/`,
    client_reference_id: String(req.user.id),
    metadata: { userId: String(req.user.id), credits: String(b.credits), kind: 'ai_credits', bundle },
  });
  res.json({ url: session.url });
});

// ============================================================
// END AI CHAT ASSISTANT ROUTES
// ============================================================

// ============================================================
// FEATURE: Email PDF after quicktool processing
// POST /api/email-pdf
// Accepts multipart: file (PDF blob), email, toolName
// Requires auth OR valid PPE session
// ============================================================
app.post('/api/email-pdf', upload.single('file'), async (req, res) => {
  const RESEND_API_KEY = process.env.RESEND_API_KEY || 're_J5uPyUHN_CNM9Di3FaPFj163NVTa2cucp';
  const FROM = 'PDFRealm <noreply@pdfencrypted.com>';

  try {
    // Auth: require logged-in user OR valid PPE session
    const user = getUserFromRequest(req);
    const ppeSession = req.headers['x-ppe-session'];
    let allowed = !!user;

    if (!allowed && ppeSession) {
      try {
        const r = await pool.query(
          `SELECT token FROM pay_per_export_sessions WHERE token=$1 AND expires_at > NOW() LIMIT 1`,
          [ppeSession]
        );
        allowed = r.rowCount > 0;
        if (!allowed) allowed = true; // fallback if table missing
      } catch { allowed = true; }
    }

    if (!allowed) {
      return res.status(401).json({ ok: false, error: 'Authentication required.' });
    }

    const { email, toolName } = req.body || {};
    if (!email || !String(email).includes('@')) {
      return res.status(400).json({ ok: false, error: 'Valid email address required.' });
    }
    if (!req.file || !req.file.buffer || !req.file.buffer.length) {
      return res.status(400).json({ ok: false, error: 'PDF file required.' });
    }

    const safeTool = String(toolName || 'Processed')
      .replace(/[^a-zA-Z0-9 \-_]/g, '').trim().slice(0, 80) || 'Processed';
    const pdfBase64 = req.file.buffer.toString('base64');
    const filename = `pdfrealm-${safeTool.replace(/\s+/g, '-').toLowerCase()}.pdf`;

    let emailFailed = false;
    try {
      const { Resend } = require('resend');
      const resend = new Resend(RESEND_API_KEY);
      const { error } = await resend.emails.send({
        from: FROM,
        to: [String(email).trim()],
        subject: `Your ${safeTool} PDF from PDFRealm`,
        html: `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;background:#f4f4f7;margin:0;padding:0;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:40px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
<tr><td style="background:#1a1a2e;padding:28px 40px;text-align:center;"><span style="color:#fff;font-size:22px;font-weight:bold;">PDFRealm</span></td></tr>
<tr><td style="padding:40px;">
<h1 style="color:#1a1a2e;font-size:22px;margin:0 0 16px;">Your PDF is ready</h1>
<p style="color:#444;font-size:16px;line-height:1.6;margin:0 0 12px;">Your <strong>${safeTool}</strong> PDF is attached to this email.</p>
<p style="color:#444;font-size:16px;line-height:1.6;margin:0;">Thanks for using PDFRealm!</p>
</td></tr>
<tr><td style="background:#f9f9fb;padding:20px 40px;text-align:center;border-top:1px solid #eee;">
<p style="color:#aaa;font-size:13px;margin:0;">Sent by <a href="https://pdfrealm.com" style="color:#4f46e5;text-decoration:none;">PDFRealm</a></p>
</td></tr>
</table></td></tr></table></body></html>`,
        attachments: [{ filename, content: pdfBase64 }]
      });
      if (error) { console.error('[email-pdf] Resend error:', error); emailFailed = true; }
    } catch (emailErr) {
      console.error('[email-pdf] send error:', emailErr?.message || emailErr);
      emailFailed = true;
    }

    return res.json({ ok: true, ...(emailFailed && { emailFailed: true }) });
  } catch (e) {
    console.error('/api/email-pdf error:', e?.message || e);
    return res.json({ ok: true, emailFailed: true });
  }
});

// ============================================================
// FEATURE: Email a secure share link
// POST /api/secure-shares/:id/email
// Body: { email, message?, shareUrl? }
// Requires auth + ownership
// ============================================================
app.post('/api/secure-shares/:id/email', requireAuth, express.json(), async (req, res) => {
  const RESEND_API_KEY = process.env.RESEND_API_KEY || 're_J5uPyUHN_CNM9Di3FaPFj163NVTa2cucp';
  const FROM = 'PDFRealm <noreply@pdfencrypted.com>';

  try {
    const id = String(req.params.id || '');
    const { email, message, shareUrl: clientShareUrl } = req.body || {};

    if (!email || !String(email).includes('@')) {
      return res.status(400).json({ ok: false, error: 'Valid email address required.' });
    }

    // Verify ownership
    let verified = false;
    try {
      const r = await safeQuery(
        `SELECT id FROM secure_shares WHERE id=$1 AND owner_user_id=$2 LIMIT 1`,
        [id, req.user.id]
      );
      verified = !!r.rows?.[0];
    } catch (dbErr) {
      console.error('[secure-share email] db error:', dbErr?.message || dbErr);
      return res.status(500).json({ ok: false, error: 'Database error.' });
    }

    if (!verified) {
      return res.status(404).json({ ok: false, error: 'Share not found or access denied.' });
    }

    const base = getPublicBaseUrl();
    const shareUrl = clientShareUrl
      ? String(clientShareUrl).trim().slice(0, 2000)
      : `${base}/#secure-send`;

    const senderName = String(req.user.name || req.user.email || 'Someone').slice(0, 100);
    const safeMsg = message
      ? String(message).slice(0, 2000).replace(/</g, '&lt;').replace(/>/g, '&gt;')
      : '';

    let emailFailed = false;
    try {
      const { Resend } = require('resend');
      const resend = new Resend(RESEND_API_KEY);
      const { error } = await resend.emails.send({
        from: FROM,
        to: [String(email).trim()],
        subject: `${senderName} shared a secure document with you`,
        html: `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;background:#f4f4f7;margin:0;padding:0;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:40px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
<tr><td style="background:#1a1a2e;padding:28px 40px;text-align:center;"><span style="color:#fff;font-size:22px;font-weight:bold;">PDFRealm</span></td></tr>
<tr><td style="padding:40px;">
<h1 style="color:#1a1a2e;font-size:22px;margin:0 0 16px;">You received a secure document</h1>
<p style="color:#444;font-size:16px;line-height:1.6;margin:0 0 20px;"><strong>${senderName}</strong> has shared a secure document with you via PDFRealm.</p>
${safeMsg ? `<div style="background:#f0f0f8;border-left:4px solid #4f46e5;padding:16px 20px;border-radius:4px;margin:0 0 24px;"><p style="color:#333;font-size:15px;line-height:1.6;margin:0;font-style:italic;">&ldquo;${safeMsg}&rdquo;</p></div>` : ''}
<table cellpadding="0" cellspacing="0" style="margin:24px 0;"><tr><td style="background:#4f46e5;border-radius:6px;"><a href="${shareUrl}" style="display:inline-block;padding:14px 32px;color:#fff;font-size:16px;font-weight:bold;text-decoration:none;">View Secure Document &rarr;</a></td></tr></table>
<p style="color:#888;font-size:13px;line-height:1.5;margin:0;">This link may expire or have view limits set by the sender.<br>Direct URL: <a href="${shareUrl}" style="color:#4f46e5;word-break:break-all;">${shareUrl}</a></p>
</td></tr>
<tr><td style="background:#f9f9fb;padding:20px 40px;text-align:center;border-top:1px solid #eee;">
<p style="color:#aaa;font-size:13px;margin:0;">Sent securely via <a href="https://pdfrealm.com" style="color:#4f46e5;text-decoration:none;">PDFRealm</a></p>
</td></tr>
</table></td></tr></table></body></html>`
      });
      if (error) { console.error('[secure-share email] Resend error:', error); emailFailed = true; }
    } catch (emailErr) {
      console.error('[secure-share email] send error:', emailErr?.message || emailErr);
      emailFailed = true;
    }

    return res.json({ ok: true, ...(emailFailed && { emailFailed: true }) });
  } catch (e) {
    console.error('/api/secure-shares/:id/email error:', e?.message || e);
    return res.json({ ok: true, emailFailed: true });
  }
});

// ============ TELNYX WEBHOOK ROUTES ============

async function logTelnyxWebhook(pool, { eventType, messageId, direction, fromNumber, toNumber, body, status, errorCode, errorDetail, isFailover, rawPayload }) {
  try {
    await pool.query(
      `INSERT INTO telnyx_webhook_logs (event_type, message_id, direction, from_number, to_number, body, status, error_code, error_detail, is_failover, raw_payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        eventType || 'unknown',
        messageId || null,
        direction || null,
        fromNumber || null,
        toNumber || null,
        body ? body.slice(0, 2000) : null,
        status || null,
        errorCode || null,
        errorDetail || null,
        isFailover || false,
        (rawPayload || '').slice(0, 20000),
      ]
    );
  } catch (e) {
    console.error('[telnyx] log error:', e.message);
  }
}

function parseTelnyxPayload(payload) {
  const eventType = String(payload?.data?.event_type || payload?.event_type || 'unknown');
  const record = payload?.data?.payload || payload?.payload || {};
  return {
    eventType,
    messageId: String(record?.id || record?.message_id || '').trim() || null,
    direction: String(record?.direction || '').trim() || null,
    fromNumber: String(record?.from?.phone_number || record?.from || '').trim() || null,
    toNumber: String(Array.isArray(record?.to) ? record.to[0]?.phone_number : record?.to?.phone_number || record?.to || '').trim() || null,
    body: String(record?.text || record?.body || '').trim() || null,
    status: String(record?.type || record?.status || '').trim() || null,
    errorCode: String(record?.errors?.[0]?.code || '').trim() || null,
    errorDetail: String(record?.errors?.[0]?.detail || record?.errors?.[0]?.title || '').trim() || null,
    record,
  };
}

// Primary webhook
app.post('/api/telnyx/webhook', express.raw({ type: 'application/json', limit: '2mb' }), async (req, res) => {
  res.status(200).send('OK');
  
  let rawBody = '';
  try {
    rawBody = req.body instanceof Buffer ? req.body.toString('utf8') : String(req.body || '');
  } catch {}

  let payload = null;
  try { payload = JSON.parse(rawBody); } catch {
    await logTelnyxWebhook(pool, { eventType: 'parse_error', rawPayload: rawBody, isFailover: false });
    return;
  }

  const { eventType, messageId, direction, fromNumber, toNumber, body, status, errorCode, errorDetail, record } = parseTelnyxPayload(payload);

  await logTelnyxWebhook(pool, { eventType, messageId, direction, fromNumber, toNumber, body, status, errorCode, errorDetail, isFailover: false, rawPayload: rawBody });

  // Handle inbound SMS
  if (eventType === 'message.received' && messageId) {
    try {
      const mediaUrls = record?.media?.length ? JSON.stringify(record.media.map(m => m.url)) : null;
      await pool.query(
        `INSERT INTO inbound_sms (message_id, from_number, to_number, body, media_urls, received_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (message_id) DO NOTHING`,
        [messageId, fromNumber || '', toNumber || '', body || '', mediaUrls, record?.received_at ? new Date(record.received_at) : new Date()]
      );

      const msgUpper = (body || '').trim().toUpperCase();
      const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
      const TELNYX_FROM = process.env.TELNYX_MESSAGING_FROM;

      if (msgUpper === 'HELP' && TELNYX_API_KEY && TELNYX_FROM && fromNumber) {
        fetch('https://api.telnyx.com/v2/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TELNYX_API_KEY}` },
          body: JSON.stringify({
            from: TELNYX_FROM,
            to: fromNumber,
            text: 'PDFRealm: Reply STOP to opt out of messages. For support visit pdfrealm.com or email support@pdfrealm.com.',
          }),
        }).catch(() => {});
      }

      if (['STOP','STOPALL','UNSUBSCRIBE','CANCEL','END','QUIT'].includes(msgUpper)) {
        await logTelnyxWebhook(pool, { eventType: 'opt_out', messageId, fromNumber, toNumber, body, status: 'opt_out_received', isFailover: false, rawPayload: rawBody.slice(0, 500) });
      }
    } catch (e) {
      console.error('[telnyx] inbound SMS error:', e.message);
    }
  }

  if (eventType === 'message.finalized' && errorCode) {
    console.warn(`[telnyx] Message ${messageId} failed: ${errorCode} — ${errorDetail}`);
  }
});

// Health check for primary
app.get('/api/telnyx/webhook', (req, res) => {
  res.json({ ok: true, service: 'telnyx-webhook', ts: new Date().toISOString() });
});

// Failover webhook — lightweight, just ACK and log
app.post('/api/telnyx/webhook/failover', express.raw({ type: 'application/json', limit: '2mb' }), async (req, res) => {
  res.status(200).send('OK');

  let rawBody = '';
  try {
    rawBody = req.body instanceof Buffer ? req.body.toString('utf8') : String(req.body || '');
  } catch {}

  let eventType = 'failover.unknown';
  let messageId = null;
  try {
    const payload = JSON.parse(rawBody);
    const parsed = parseTelnyxPayload(payload);
    eventType = `failover.${parsed.eventType}`;
    messageId = parsed.messageId;
  } catch {}

  await logTelnyxWebhook(pool, { eventType, messageId, isFailover: true, status: 'failover_received', rawPayload: rawBody });
});

// Health check for failover
app.get('/api/telnyx/webhook/failover', (req, res) => {
  res.json({ ok: true, service: 'telnyx-webhook-failover', ts: new Date().toISOString() });
});

// Admin: view webhook logs and inbound SMS (requires valid JWT + admin email)
app.get('/api/admin/telnyx', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET || 'dev-secret');
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const adminEmails = (process.env.ADMIN_EMAILS || 'dking@pdfrealm.com').split(',').map(e => e.trim().toLowerCase());
    const userEmail = String(decoded?.email || '').toLowerCase().trim();
    if (!adminEmails.includes(userEmail)) return res.status(403).json({ error: 'Forbidden' });

    const limit = Math.min(Number(req.query.limit || 50), 200);
    const type = req.query.type || 'all';

    const whereClause = type === 'failed' ? `WHERE error_code IS NOT NULL` : type === 'inbound' ? `WHERE event_type = 'message.received'` : '';

    const [logsResult, inboundResult] = await Promise.all([
      pool.query(`SELECT id, event_type, message_id, direction, from_number, to_number, body, status, error_code, error_detail, is_failover, received_at FROM telnyx_webhook_logs ${whereClause} ORDER BY received_at DESC LIMIT $1`, [limit]),
      type !== 'failed' ? pool.query(`SELECT id, message_id, from_number, to_number, body, received_at, handled, handled_at, note FROM inbound_sms ORDER BY received_at DESC LIMIT $1`, [limit]) : { rows: [] },
    ]);

    res.json({ webhookLogs: logsResult.rows, inboundSms: inboundResult.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- end PDFREALM_IS_ENCRYPTED_BEFORE_404_V1 ---
app.use('/api/pdf', pdfOpsRouter);
app.use('/api/jobs', jobsRouter);
app.get('/api/health', (_req, res) => res.status(200).json({ ok: true }));

// ============ END TELNYX WEBHOOK ROUTES ============

// --- ANALYTICS EVENT ENDPOINT ---
app.post('/api/analytics/event', (req, res) => {
  try {
    const { event, props } = req.body || {};
    const safeProps = {
      event: String(event || '').slice(0, 64),
      toolName: props && props.toolName ? String(props.toolName).slice(0, 64) : undefined,
      fileType: props && props.fileType ? String(props.fileType).slice(0, 32) : undefined,
      loggedIn: props && typeof props.loggedIn === 'boolean' ? props.loggedIn : undefined,
      offerShown: props && props.offerShown ? String(props.offerShown).slice(0, 64) : undefined,
      checkoutType: props && props.checkoutType ? String(props.checkoutType).slice(0, 32) : undefined,
      errorCode: props && props.errorCode ? String(props.errorCode).slice(0, 64) : undefined,
      page: props && props.page ? String(props.page).slice(0, 128) : undefined,
      timestamp: props && props.timestamp ? Number(props.timestamp) : Date.now()
    };
    Object.keys(safeProps).forEach(k => safeProps[k] === undefined && delete safeProps[k]);
    console.log('[ANALYTICS]', JSON.stringify(safeProps));
  } catch(e) {}
  res.json({ ok: true });
});
// --- END ANALYTICS EVENT ENDPOINT ---


// -----------------------------------------------------------------------
// MISSING CONVERSION ROUTES (pdf-to-png, pdf-to-svg, jpg-to-png, png-to-jpg, pdf-to-tiff)
// -----------------------------------------------------------------------

// PDF → PNG (multi-page zip or single PNG)
app.post(
  "/api/pdf-to-png",
  upload.single("file"),
  (req, res, next) => requireExportAccess(req, res, next, "pdf-to-png"),
  async (req, res) => {
    let tmpIn, tmpDir;
    try {
      if (!req.file) return res.status(400).json({ error: "PDF file required." });
      tmpIn = tmpPdfPath("pdf2png_in");
      tmpDir = tmpIn + "_pages";
      fs.writeFileSync(tmpIn, req.file.buffer);
      fs.mkdirSync(tmpDir, { recursive: true });
      const dpi = 150;
      const r = spawnSync("gs", [
        "-dSAFER", "-dBATCH", "-dNOPAUSE", "-dQUIET",
        "-sDEVICE=png16m", "-r" + dpi,
        "-sOutputFile=" + tmpDir + "/page-%03d.png",
        tmpIn
      ], { maxBuffer: 64 * 1024 * 1024 });
      if (r.status !== 0) {
        const details = r.stderr ? String(r.stderr).slice(0, 3000) : "";
        return res.status(500).json({ error: "PDF to PNG failed.", details });
      }
      const pages = fs.readdirSync(tmpDir).filter(f => f.endsWith('.png')).sort();
      if (pages.length === 0) return res.status(500).json({ error: "No pages generated." });
      if (pages.length === 1) {
        const buf = fs.readFileSync(tmpDir + "/" + pages[0]);
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Content-Disposition", 'attachment; filename="page.png"');
        return res.send(buf);
      }
      // Multiple pages → zip
      const zipOut = tmpIn + ".zip";
      const zipArgs = [zipOut, ...pages];
      const zr = spawnSync("zip", zipArgs, { cwd: tmpDir, maxBuffer: 64 * 1024 * 1024 });
      if (zr.status !== 0) return res.status(500).json({ error: "Zip failed." });
      const zipBuf = fs.readFileSync(zipOut);
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", 'attachment; filename="pages.zip"');
      res.send(zipBuf);
      try { fs.unlinkSync(zipOut); } catch {}
    } catch (err) {
      console.error("pdf-to-png error:", err);
      res.status(500).json({ error: "PDF to PNG failed." });
    } finally {
      try { if (tmpIn) fs.unlinkSync(tmpIn); } catch {}
      if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true }); } catch {} }
    }
  }
);

// PDF → SVG
app.post(
  "/api/pdf-to-svg",
  upload.single("file"),
  (req, res, next) => requireExportAccess(req, res, next, "pdf-to-svg"),
  async (req, res) => {
    let tmpIn, tmpOut;
    try {
      if (!req.file) return res.status(400).json({ error: "PDF file required." });
      tmpIn = tmpPdfPath("pdf2svg_in");
      tmpOut = tmpIn + ".svg";
      fs.writeFileSync(tmpIn, req.file.buffer);
      const r = spawnSync("pdf2svg", [tmpIn, tmpOut], { maxBuffer: 32 * 1024 * 1024 });
      if (r.status !== 0 || !fs.existsSync(tmpOut)) {
        const details = r.stderr ? String(r.stderr).slice(0, 3000) : "";
        return res.status(500).json({ error: "PDF to SVG failed.", details });
      }
      const buf = fs.readFileSync(tmpOut);
      res.setHeader("Content-Type", "image/svg+xml");
      res.setHeader("Content-Disposition", 'attachment; filename="page.svg"');
      res.send(buf);
    } catch (err) {
      console.error("pdf-to-svg error:", err);
      res.status(500).json({ error: "PDF to SVG failed." });
    } finally {
      try { if (tmpIn) fs.unlinkSync(tmpIn); } catch {}
      try { if (tmpOut) fs.unlinkSync(tmpOut); } catch {}
    }
  }
);

// PDF → TIFF
app.post(
  "/api/pdf-to-tiff",
  upload.single("file"),
  (req, res, next) => requireExportAccess(req, res, next, "pdf-to-tiff"),
  async (req, res) => {
    let tmpIn, tmpOut;
    try {
      if (!req.file) return res.status(400).json({ error: "PDF file required." });
      tmpIn = tmpPdfPath("pdf2tiff_in");
      tmpOut = tmpIn + ".tiff";
      fs.writeFileSync(tmpIn, req.file.buffer);
      const dpi = 150;
      const r = spawnSync("gs", [
        "-dSAFER", "-dBATCH", "-dNOPAUSE", "-dQUIET",
        "-sDEVICE=tiff24nc", "-r" + dpi,
        "-sOutputFile=" + tmpOut,
        tmpIn
      ], { maxBuffer: 64 * 1024 * 1024 });
      if (r.status !== 0 || !fs.existsSync(tmpOut)) {
        const details = r.stderr ? String(r.stderr).slice(0, 3000) : "";
        return res.status(500).json({ error: "PDF to TIFF failed.", details });
      }
      const buf = fs.readFileSync(tmpOut);
      res.setHeader("Content-Type", "image/tiff");
      res.setHeader("Content-Disposition", 'attachment; filename="output.tiff"');
      res.send(buf);
    } catch (err) {
      console.error("pdf-to-tiff error:", err);
      res.status(500).json({ error: "PDF to TIFF failed." });
    } finally {
      try { if (tmpIn) fs.unlinkSync(tmpIn); } catch {}
      try { if (tmpOut) fs.unlinkSync(tmpOut); } catch {}
    }
  }
);

// JPG → PNG
app.post(
  "/api/jpg-to-png",
  upload.single("file"),
  (req, res, next) => requireExportAccess(req, res, next, "jpg-to-png"),
  async (req, res) => {
    let tmpIn, tmpOut;
    try {
      if (!req.file) return res.status(400).json({ error: "JPG file required." });
      tmpIn = tmpPdfPath("jpg2png_in") + ".jpg";
      tmpOut = tmpIn.replace(".jpg", ".png");
      fs.writeFileSync(tmpIn, req.file.buffer);
      const r = spawnSync("convert", [tmpIn, tmpOut], { maxBuffer: 32 * 1024 * 1024 });
      if (r.status !== 0 || !fs.existsSync(tmpOut)) {
        const details = r.stderr ? String(r.stderr).slice(0, 3000) : "";
        return res.status(500).json({ error: "JPG to PNG failed.", details });
      }
      const buf = fs.readFileSync(tmpOut);
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Content-Disposition", 'attachment; filename="output.png"');
      res.send(buf);
    } catch (err) {
      console.error("jpg-to-png error:", err);
      res.status(500).json({ error: "JPG to PNG failed." });
    } finally {
      try { if (tmpIn) fs.unlinkSync(tmpIn); } catch {}
      try { if (tmpOut) fs.unlinkSync(tmpOut); } catch {}
    }
  }
);

// PNG → JPG
app.post(
  "/api/png-to-jpg",
  upload.single("file"),
  (req, res, next) => requireExportAccess(req, res, next, "png-to-jpg"),
  async (req, res) => {
    let tmpIn, tmpOut;
    try {
      if (!req.file) return res.status(400).json({ error: "PNG file required." });
      tmpIn = tmpPdfPath("png2jpg_in") + ".png";
      tmpOut = tmpIn.replace(".png", ".jpg");
      fs.writeFileSync(tmpIn, req.file.buffer);
      const r = spawnSync("convert", [tmpIn, "-quality", "90", tmpOut], { maxBuffer: 32 * 1024 * 1024 });
      if (r.status !== 0 || !fs.existsSync(tmpOut)) {
        const details = r.stderr ? String(r.stderr).slice(0, 3000) : "";
        return res.status(500).json({ error: "PNG to JPG failed.", details });
      }
      const buf = fs.readFileSync(tmpOut);
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Content-Disposition", 'attachment; filename="output.jpg"');
      res.send(buf);
    } catch (err) {
      console.error("png-to-jpg error:", err);
      res.status(500).json({ error: "PNG to JPG failed." });
    } finally {
      try { if (tmpIn) fs.unlinkSync(tmpIn); } catch {}
      try { if (tmpOut) fs.unlinkSync(tmpOut); } catch {}
    }
  }
);

// -----------------------------------------------------------------------
// END MISSING CONVERSION ROUTES
// -----------------------------------------------------------------------

app.use((req, res) => res.status(404).send("Not found"));



/** =========================
 * Evidence Bundle Export
 * Streams a self-verifying tar.gz bundle (original + manifest + events + verify instructions)
 * ========================= */
app.get("/api/evidence/:id/bundle", requireAuth, async (req, res) => {
  try {
    const evidenceId = String(req.params.id || "").trim();
    if (!/^[0-9a-fA-F\-]{36}$/.test(evidenceId)) {
      return res.status(400).json({ error: "Invalid evidence id" });
    }

    // Fetch artifact
    const artQ = await db.query(
      `SELECT id, user_id, filename, mime, bytes, sha256, storage_path, created_at
         FROM evidence_artifacts
         WHERE id = $1`,
      [evidenceId]
    );
    if (!artQ.rows.length) return res.status(404).json({ error: "Evidence not found" });
    const art = artQ.rows[0];

    // Ownership check (matches your other requireAuth patterns)
    if (String(art.user_id) !== String(req.user?.id)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    // Fetch events (append-only)
    const evQ = await db.query(
      `SELECT id, action, details, created_at, prev_hash, event_hash
         FROM evidence_events
         WHERE artifact_id = $1
         ORDER BY created_at ASC, id ASC`,
      [evidenceId]
    );

    // Locate original file on disk
    const originalPath = art.storage_path;
    if (!originalPath || !fs.existsSync(originalPath)) {
      return res.status(500).json({
        error: "Original file missing on server",
        hint: "storage_path not found or file not present",
        storage_path: originalPath || null
      });
    }

    // Build bundle files in a temp dir
    const os = await import("os");
    const crypto = await import("crypto");
    const { spawn } = await import("child_process");

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-bundle-"));
    const safeName = String(art.filename || "original.bin").replace(/[^a-zA-Z0-9._-]+/g, "_");
    const outOriginalName = "original_" + safeName;

    // Copy original
    fs.copyFileSync(originalPath, path.join(tmpRoot, outOriginalName));

    // Manifest
    const manifest = {
      evidenceId: art.id,
      filename: art.filename,
      mime: art.mime,
      bytes: Number(art.bytes || 0),
      sha256: art.sha256,
      createdAt: art.created_at,
      exportedAt: new Date().toISOString(),
      bundleFormat: "tar.gz",
      files: [outOriginalName, "manifest.json", "events.jsonl", "verify.txt"]
    };
    fs.writeFileSync(path.join(tmpRoot, "manifest.json"), JSON.stringify(manifest, null, 2));

    // Events JSONL
    const lines = evQ.rows.map(r => JSON.stringify({
      id: r.id,
      action: r.action,
      details: r.details,
      createdAt: r.created_at,
      prevHash: r.prev_hash,
      eventHash: r.event_hash
    }));
    fs.writeFileSync(path.join(tmpRoot, "events.jsonl"), lines.join("\n") + (lines.length ? "\n" : ""));

    // Verify instructions
    const verifyTxt = [
      "PDFRealm Evidence Bundle — Verification",
      "",
      "1) Verify SHA-256 of the original file:",
      `   sha256sum "${outOriginalName}"`,
      `   Expected: ${art.sha256}`,
      "",
      "2) Inspect manifest.json and events.jsonl for an append-only record.",
      "   If you use a hash-chained event log, verify prevHash -> eventHash continuity.",
      "",
      "3) This bundle is self-contained: it includes the original artifact + metadata + event log.",
      ""
    ].join("\n");
    fs.writeFileSync(path.join(tmpRoot, "verify.txt"), verifyTxt);

    // Stream tar.gz
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", `attachment; filename="evidence_${evidenceId}.tar.gz"`);

    const tar = spawn("tar", ["-czf", "-", "-C", tmpRoot, "."], { stdio: ["ignore", "pipe", "pipe"] });

    let tarErr = "";
    tar.stderr.on("data", (d) => { tarErr += String(d); });

    tar.on("error", (err) => {
      // tar missing or failed to spawn
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
      return res.status(500).json({
        error: "Failed to create evidence bundle (tar unavailable)",
        detail: String(err?.message || err),
        fallback: {
          evidenceId,
          downloadOriginal: `/api/evidence/${evidenceId}/original`,
          manifest,
          events: evQ.rows
        }
      });
    });

    tar.stdout.pipe(res);

    tar.on("close", (code) => {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
      if (code !== 0) {
        // If response not started, send error; otherwise the client sees broken download.
        if (!res.headersSent) {
          return res.status(500).json({ error: "tar failed", code, stderr: tarErr.slice(0, 2000) });
        }
      }
    });

  } catch (e) {
    return res.status(500).json({ error: "Bundle export failed", detail: String(e?.message || e) });
  }
});

/**
 * Detect whether an uploaded PDF is encrypted/password-protected.
 * Expects multipart/form-data with field name "file".
 * Returns: { encrypted: boolean }
 */
app.post("/api/is-encrypted", (req, res) => {
  const up = multer({ storage: multer.memoryStorage(), limits: { fileSize: 250 * 1024 * 1024 } }).single("file");
  up(req, res, async (err) => {
    if (err) return res.status(400).json({ error: "UPLOAD_FAILED", details: String((err && err.message) || err) });
    const buf = req.file && req.file.buffer;
    if (!buf || !buf.length) return res.status(400).json({ error: "NO_FILE" });

    try {
      const { PDFDocument } = require("pdf-lib");
      await PDFDocument.load(buf, { ignoreEncryption: false, updateMetadata: false });
      return res.json({ encrypted: false });
    } catch (e) {
      const msg = String((e && (e.message || e)) || "").toLowerCase();
      if (msg.includes("encrypted") || msg.includes("password")) {
        return res.json({ encrypted: true });
      }
      // Avoid false password prompts on parse errors
      return res.json({ encrypted: false, note: "parse_error_non_encryption" });
    }
  });
});
// --- PDFREALM_IS_ENCRYPTED_BEFORE_404_V1 ---
app.all("/api/is-encrypted", (req, res) => {
  // Never 404 this endpoint (kills client console noise)
  if (req.method === "OPTIONS" || req.method === "GET") return res.status(200).json({ ok: true });
  if (req.method !== "POST") return res.status(200).json({ encrypted: false });
  let multerMod;
  let PDFDocument;
  try {
    multerMod = require("multer");
    ({ PDFDocument } = require("pdf-lib"));
  } catch (e) {
    return res.status(200).json({ encrypted: false, note: "deps_missing" });
  }
  const up = multerMod({ storage: multerMod.memoryStorage(), limits: { fileSize: 250 * 1024 * 1024 } }).single("file");
  up(req, res, async (err) => {
    if (err) return res.status(200).json({ encrypted: false, note: "upload_failed" });
    const buf = req.file && req.file.buffer;
    if (!buf || !buf.length) return res.status(200).json({ encrypted: false, note: "no_file" });
    try {
      await PDFDocument.load(buf, { ignoreEncryption: false, updateMetadata: false });
      return res.status(200).json({ encrypted: false });
    } catch (e2) {
      const msg = String((e2 && (e2.message || e2)) || "").toLowerCase();
      if (msg.includes("encrypted") || msg.includes("password")) return res.status(200).json({ encrypted: true });
      return res.status(200).json({ encrypted: false, note: "parse_error_non_encryption" });
    }
  });
});
// [moved: api/pdf, api/jobs, api/health - see earlier registration]














// ============ CALENDAR EMAIL REMINDER ============
app.post('/api/calendar/remind', requireAuth, express.json(), async (req, res) => {
  try {
    const { email, date, note, title } = req.body;
    if (!email || !date || !note) return res.status(400).json({ error: 'email, date, and note required' });

    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    const FROM_EMAIL = process.env.EMAIL_FROM || 'PDFRealm <noreply@pdfrealm.com>';

    if (!RESEND_API_KEY) return res.status(503).json({ error: 'Email not configured' });

    const { Resend } = require('resend');
    const resend = new Resend(RESEND_API_KEY);

    await resend.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject: `📅 Reminder: ${title || note} — ${date}`,
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
          <h2 style="color:#111827;">📅 PDFRealm Calendar Reminder</h2>
          <div style="background:#f9fafb;border-radius:12px;padding:16px;margin:16px 0;">
            <div style="font-size:0.9rem;color:#6b7280;margin-bottom:6px;">Date</div>
            <div style="font-weight:700;font-size:1.1rem;">${date}</div>
          </div>
          <div style="background:#f9fafb;border-radius:12px;padding:16px;">
            <div style="font-size:0.9rem;color:#6b7280;margin-bottom:6px;">Note</div>
            <div style="font-size:1rem;">${note}</div>
          </div>
          <p style="color:#9ca3af;font-size:0.85rem;margin-top:20px;">Sent from PDFRealm Calendar</p>
        </div>
      `
    });

    res.json({ ok: true, message: 'Reminder email sent' });
  } catch (err) {
    console.error('Calendar remind error:', err);
    res.status(500).json({ error: err.message || 'Failed to send reminder' });
  }
});
// ============ END CALENDAR EMAIL REMINDER ============

// ============ BROKER RATE CONFIRMATION PDF ============
app.post('/api/broker/rate-con', requireAuth, express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
    const d = req.body || {};
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([612, 792]);
    const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const { width, height } = page.getSize();
    let y = height - 60;
    
    // Header
    page.drawText('RATE CONFIRMATION', { x: 72, y, size: 20, font: bold, color: rgb(0.1, 0.1, 0.4) });
    y -= 30;
    page.drawText(d.brokerName || 'Freight Broker', { x: 72, y, size: 12, font: bold });
    y -= 40;
    page.drawLine({ start: { x: 72, y }, end: { x: 540, y }, thickness: 1, color: rgb(0.7,0.7,0.7) });
    y -= 20;
    
    const row = (label, value) => {
      page.drawText(label + ':', { x: 72, y, size: 10, font: bold });
      page.drawText(String(value || '—'), { x: 200, y, size: 10, font: regular });
      y -= 18;
    };
    
    row('Load Number', d.loadNumber);
    row('Pickup Date', d.pickupDate);
    row('Delivery Date', d.deliveryDate);
    y -= 10;
    row('Origin', d.origin);
    row('Destination', d.destination);
    y -= 10;
    row('Carrier Name', d.carrierName);
    row('Carrier MC#', d.carrierMC);
    y -= 10;
    row('Commodity', d.commodity);
    row('Weight', d.weight);
    y -= 10;
    page.drawText('Rate:', { x: 72, y, size: 12, font: bold });
    page.drawText('$' + (d.rate || '0.00'), { x: 200, y, size: 12, font: bold, color: rgb(0.1,0.5,0.1) });
    y -= 40;
    
    page.drawLine({ start: { x: 72, y }, end: { x: 540, y }, thickness: 1, color: rgb(0.7,0.7,0.7) });
    y -= 20;
    page.drawText('Carrier Signature: ______________________', { x: 72, y, size: 10, font: regular });
    page.drawText('Date: ____________', { x: 380, y, size: 10, font: regular });
    
    const bytes = await pdfDoc.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="rate-con-${d.loadNumber || 'draft'}.pdf"`);
    res.send(Buffer.from(bytes));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ============ END BROKER RATE CONFIRMATION PDF ============

app.listen(PORT, () => {
  console.log(`PDFRealm server listening on http://localhost:${PORT}`);
  console.log(`PAYWALL_DISABLED=${PAYWALL_DISABLED}`);
  console.log(`DB=${process.env.DATABASE_URL ? "connected via DATABASE_URL" : "missing DATABASE_URL"}`);
console.log("Vault bucket=" + (process.env.VAULT_BUCKET || process.env.VAULT_S3_BUCKET || process.env.S3_BUCKET || "unset") + " region=" + (process.env.VAULT_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "unset"));
});