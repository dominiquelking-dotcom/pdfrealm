/**
 * PDFRealm Office (Collabora Online) — minimal WOPI host (filesystem-backed) + session endpoints
 *
 * Why this file exists:
 * - This is a *dev-friendly* WOPI host you can mount into your Express app while you iterate on
 *   Collabora Online built-from-source (coolwsd on :9980).
 * - PDFRealm's production flow should use the Vault-backed WOPI routes in server.js.
 *
 * API shape intentionally matches office.html:
 *   POST /api/office/new      -> { ok:true, fileId, iframeUrl?, wopiSrc? }
 *   POST /api/office/session  -> { ok:true, iframeUrl, wopiSrc, access_token }
 *
 * WOPI endpoints:
 *   GET  /wopi/files/:id
 *   GET  /wopi/files/:id/contents
 *   POST /wopi/files/:id/contents
 *   POST /wopi/files/:id   (LOCK/UNLOCK/REFRESH_LOCK/GET_LOCK)
 */

const path = require("path");
const fsp = require("fs/promises");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const jwt = require("jsonwebtoken");

// --------------------------- helpers ---------------------------

function decodeXmlEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function parseBool(v, dflt = false) {
  if (v === undefined || v === null) return dflt;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return dflt;
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

function safeExt(extOrName) {
  const e = String(extOrName || "").toLowerCase().replace(/^\./, "");
  if (["docx", "xlsx", "pptx"].includes(e)) return e;
  const n = String(extOrName || "");
  const i = n.lastIndexOf(".");
  if (i >= 0) return safeExt(n.slice(i + 1));
  return "";
}

function getAccessToken(req) {
  const q = req.query || {};
  const tokenQ = q.access_token || q.accessToken || null;
  if (tokenQ) return String(tokenQ);

  const auth = req.headers.authorization || req.headers.Authorization || "";
  const m = String(auth).match(/^Bearer\s+(.+)$/i);
  if (m && m[1]) return m[1].trim();
  return null;
}

async function fetchText(url) {
  const insecureTls = parseBool(process.env.COLLABORA_INSECURE, false);
  const isHttps = String(url).startsWith("https:");
  if (insecureTls && isHttps) {
    const https = require("https");
    return await new Promise((resolve, reject) => {
      https
        .get(url, { rejectUnauthorized: false }, (resp) => {
          if (resp.statusCode && resp.statusCode >= 400) return reject(new Error(`HTTP ${resp.statusCode}`));
          let data = "";
          resp.setEncoding("utf8");
          resp.on("data", (c) => (data += c));
          resp.on("end", () => resolve(data));
        })
        .on("error", reject);
    });
  }

  if (typeof fetch === "function") {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  }

  const mod = isHttps ? require("https") : require("http");
  return await new Promise((resolve, reject) => {
    mod
      .get(url, (resp) => {
        if (resp.statusCode && resp.statusCode >= 400) return reject(new Error(`HTTP ${resp.statusCode}`));
        let data = "";
        resp.setEncoding("utf8");
        resp.on("data", (c) => (data += c));
        resp.on("end", () => resolve(data));
      })
      .on("error", reject);
  });
}

function defaultRequireAuth(req, res, next) {
  // Dev default (no-op). In PDFRealm production, pass opts.requireAuth to enforce auth.
  next();
}

// --------------------------- module ---------------------------

function mountOffice(app, opts = {}) {
  const router = express.Router();

  const dataDir = opts.dataDir || path.join(process.cwd(), "data", "office");
  const templatesDir = opts.templatesDir || path.join(process.cwd(), "office_templates");

  // IMPORTANT: must be reachable *from the Collabora server*.
  // If coolwsd is running locally (make run), this can be http://localhost:8080 (your PDFRealm dev server).
  const publicBaseUrl = String(opts.publicBaseUrl || process.env.PUBLIC_BASE_URL || "").replace(/\/+$/g, "");

  // For Collabora from source, you likely want: http://localhost:9980 (matches coolwsd "Launch in browser" output)
  const collaboraBaseUrl = String(opts.collaboraBaseUrl || process.env.COLLABORA_URL || "http://localhost:9980").replace(
    /\/+$/g,
    ""
  );

  // Align with server.js: OFFICE_WOPI_SECRET is the preferred env var.
  const secret = String(opts.secret || process.env.OFFICE_WOPI_SECRET || process.env.WOPI_SECRET || "dev-change-me");

  const requireAuth = opts.requireAuth || defaultRequireAuth;

  if (!publicBaseUrl) {
    console.warn("[office] publicBaseUrl not set. WOPISrc must be absolute and reachable by Collabora.");
  }

  // --- discovery cache (10 minutes) ---
  let discoveryCache = { ts: 0, byExt: {} };
  async function getActionUrlForExt(ext) {
    const e = safeExt(ext);
    if (!e) return null;
    const now = Date.now();
    if (discoveryCache.ts && now - discoveryCache.ts < 10 * 60 * 1000) {
      const cached = discoveryCache.byExt[e];
      return cached ? cached.urlsrc : null;
    }

    const discoveryUrl = `${collaboraBaseUrl}/hosting/discovery`;
    const xml = await fetchText(discoveryUrl);

    const byExt = {};
    const reAction = /<action\b[^>]*\bext="([^"]+)"[^>]*\bname="([^"]+)"[^>]*\burlsrc="([^"]+)"[^>]*\/>/gi;
    let m;
    while ((m = reAction.exec(xml))) {
      const ex = String(m[1] || "").toLowerCase();
      const name = String(m[2] || "").toLowerCase();
      const urlsrc = decodeXmlEntities(m[3] || "");
      if (!byExt[ex] || name === "edit") byExt[ex] = { name, urlsrc };
    }

    discoveryCache = { ts: now, byExt };
    const found = byExt[e];
    return found ? found.urlsrc : null;
  }

  async function buildIframeUrl({ fileId, ext, accessToken }) {
    const wopiSrc = `${publicBaseUrl}/wopi/files/${encodeURIComponent(fileId)}`;
    const urlsrc = await getActionUrlForExt(ext).catch(() => null);

    if (urlsrc) {
      let u = urlsrc;

      if (u.includes("WOPISrc=")) {
        if (u.endsWith("WOPISrc=")) u += encodeURIComponent(wopiSrc);
        else {
          const hasVal = /WOPISrc=[^&]+/.test(u);
          if (!hasVal) u = u.replace("WOPISrc=", "WOPISrc=" + encodeURIComponent(wopiSrc));
        }
      } else {
        const sep = u.includes("?") ? (u.endsWith("?") || u.endsWith("&") ? "" : "&") : "?";
        u = u + sep + "WOPISrc=" + encodeURIComponent(wopiSrc);
      }

      if (!u.includes("access_token=")) {
        u += (u.includes("?") ? "&" : "?") + "access_token=" + encodeURIComponent(accessToken);
      }

      return { iframeUrl: u, wopiSrc };
    }

    // fallback (older path)
    const fallback = `${collaboraBaseUrl}/loleaflet/dist/loleaflet.html?WOPISrc=${encodeURIComponent(wopiSrc)}&access_token=${encodeURIComponent(
      accessToken
    )}`;
    return { iframeUrl: fallback, wopiSrc };
  }

  // --- simple fs meta ---
  function metaPath(fileId) {
    return path.join(dataDir, `${fileId}.json`);
  }
  async function readMeta(fileId) {
    const raw = await fsp.readFile(metaPath(fileId), "utf8");
    return JSON.parse(raw);
  }
  async function writeMeta(fileId, meta) {
    await fsp.writeFile(metaPath(fileId), JSON.stringify(meta, null, 2), "utf8");
  }

  // --- locks ---
  const locks = new Map(); // fileId -> { lock, expiresAt }
  function lockGet(fileId) {
    const it = locks.get(fileId);
    if (!it) return null;
    if (it.expiresAt && it.expiresAt < Date.now()) {
      locks.delete(fileId);
      return null;
    }
    return it.lock || null;
  }
  function lockSet(fileId, lock) {
    locks.set(fileId, { lock, expiresAt: Date.now() + 30 * 60 * 1000 });
  }
  function lockClear(fileId) {
    locks.delete(fileId);
  }

  // -------------------- API endpoints --------------------

  // Create new blank OOXML doc in dataDir from templates
  router.post("/api/office/new", requireAuth, express.json(), async (req, res) => {
    try {
      await ensureDir(dataDir);

      const kind = safeExt(req.body?.kind || req.body?.type || req.query?.kind);
      if (!kind) return res.status(400).json({ ok: false, error: "kind must be docx|xlsx|pptx" });

      const fileId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
      const baseFileName = `Untitled-${String(fileId).slice(0, 8)}.${kind}`;
      const storageName = `${fileId}.${kind}`;

      const srcTemplate = path.join(templatesDir, `blank.${kind}`);
      const dstPath = path.join(dataDir, storageName);

      if (!fs.existsSync(srcTemplate)) {
        return res.status(500).json({ ok: false, error: `Missing template: ${srcTemplate}` });
      }

      const buf = await fsp.readFile(srcTemplate);
      await fsp.writeFile(dstPath, buf);

      const meta = {
        fileId,
        ext: kind,
        storageName,
        baseFileName,
        ownerId: String(req.user?.id || "vault"),
        version: String(Date.now()),
        size: buf.length,
      };
      await writeMeta(fileId, meta);

      // Return fileId (office.html expects this) and also include a convenience iframeUrl.
      const accessToken = jwt.sign({ scope: "wopi", fileId }, secret, { expiresIn: "1h" });
      const { iframeUrl, wopiSrc } = await buildIframeUrl({ fileId, ext: kind, accessToken });

      res.json({ ok: true, fileId, file: { id: fileId, name: baseFileName }, iframeUrl, wopiSrc, access_token: accessToken });
    } catch (e) {
      console.error("[office/new]", e);
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // Create an editor session URL for an existing fileId
  router.post("/api/office/session", requireAuth, express.json(), async (req, res) => {
    try {
      const fileId = String(req.body?.fileId || req.body?.id || "").trim();
      if (!fileId) return res.status(400).json({ ok: false, error: "fileId required" });

      const meta = await readMeta(fileId).catch(() => null);
      if (!meta) return res.status(404).json({ ok: false, error: "file not found" });

      const accessToken = jwt.sign({ scope: "wopi", fileId }, secret, { expiresIn: "1h" });
      const { iframeUrl, wopiSrc } = await buildIframeUrl({ fileId, ext: meta.ext, accessToken });

      res.json({ ok: true, iframeUrl, wopiSrc, access_token: accessToken });
    } catch (e) {
      console.error("[office/session]", e);
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // -------------------- WOPI endpoints --------------------

  function wopiAuth(req, res, next) {
    try {
      const token = getAccessToken(req);
      if (!token) return res.status(401).json({ error: "missing access_token" });
      const payload = jwt.verify(token, secret);
      if (!payload || payload.scope !== "wopi" || !payload.fileId) return res.status(401).json({ error: "invalid token" });
      req.wopi = { fileId: String(payload.fileId) };
      next();
    } catch (e) {
      return res.status(401).json({ error: "unauthorized" });
    }
  }

  // CheckFileInfo
  router.get("/wopi/files/:id", wopiAuth, async (req, res) => {
    try {
      const fileId = String(req.params.id || "");
      if (req.wopi.fileId !== fileId) return res.status(403).json({ error: "forbidden" });

      const meta = await readMeta(fileId);
      const p = path.join(dataDir, meta.storageName);
      const stat = await fsp.stat(p);

      res.json({
        BaseFileName: meta.baseFileName,
        Size: stat.size,
        OwnerId: meta.ownerId || "vault",
        UserId: meta.ownerId || "user",
        UserFriendlyName: "PDFRealm User",
        Version: meta.version || String(stat.mtimeMs),
        SupportsUpdate: true,
        SupportsLocks: true,
        SupportsGetLock: true,
        UserCanWrite: true,
      });
    } catch (e) {
      res.status(404).json({ error: "file not found" });
    }
  });

  // GetFile contents
  router.get("/wopi/files/:id/contents", wopiAuth, async (req, res) => {
    try {
      const fileId = String(req.params.id || "");
      if (req.wopi.fileId !== fileId) return res.status(403).send("Forbidden");

      const meta = await readMeta(fileId);
      const p = path.join(dataDir, meta.storageName);

      res.setHeader("Content-Type", "application/octet-stream");
      fs.createReadStream(p).pipe(res);
    } catch (e) {
      res.status(404).send("Not found");
    }
  });

  // PutFile contents
  router.post("/wopi/files/:id/contents", express.raw({ type: "*/*", limit: "200mb" }), wopiAuth, async (req, res) => {
    try {
      const fileId = String(req.params.id || "");
      if (req.wopi.fileId !== fileId) return res.status(403).send("Forbidden");

      const meta = await readMeta(fileId);

      // Lock check (helpful but minimal)
      const incomingLock = String(req.headers["x-wopi-lock"] || req.headers["X-WOPI-Lock"] || "");
      const current = lockGet(fileId);
      if (current && incomingLock && current !== incomingLock) {
        res.setHeader("X-WOPI-Lock", current);
        return res.status(409).json({ error: "lock mismatch" });
      }

      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");
      const p = path.join(dataDir, meta.storageName);
      await fsp.writeFile(p, buf);

      meta.size = buf.length || 0;
      meta.version = String(Date.now());
      await writeMeta(fileId, meta);

      return res.status(200).end();
    } catch (e) {
      res.status(404).json({ error: "file not found" });
    }
  });

  // LOCK/UNLOCK/REFRESH_LOCK/GET_LOCK
  router.post("/wopi/files/:id", express.raw({ type: "*/*", limit: "1mb" }), wopiAuth, async (req, res) => {
    const fileId = String(req.params.id || "");
    if (req.wopi.fileId !== fileId) return res.status(403).send("Forbidden");

    const override = String(req.headers["x-wopi-override"] || req.headers["X-WOPI-Override"] || "").toUpperCase();
    const lock = String(req.headers["x-wopi-lock"] || req.headers["X-WOPI-Lock"] || "");

    const existing = lockGet(fileId);

    if (override === "GET_LOCK") {
      if (existing) res.setHeader("X-WOPI-Lock", existing);
      return res.status(200).end();
    }

    if (override === "LOCK" || override === "REFRESH_LOCK") {
      if (existing && existing !== lock) {
        res.setHeader("X-WOPI-Lock", existing);
        return res.status(409).json({ error: "lock mismatch" });
      }
      lockSet(fileId, lock);
      res.setHeader("X-WOPI-Lock", lock);
      return res.status(200).end();
    }

    if (override === "UNLOCK") {
      if (existing && existing !== lock) {
        res.setHeader("X-WOPI-Lock", existing);
        return res.status(409).json({ error: "lock mismatch" });
      }
      lockClear(fileId);
      return res.status(200).end();
    }

    return res.status(400).json({ error: `unsupported override ${override}` });
  });

  // Mount router
  app.use(router);
  console.log(`[office] mounted (filesystem dev). dataDir=${dataDir} collabora=${collaboraBaseUrl}`);
}

module.exports = { mountOffice };
