// PDFRealm Secure Suite: Secure AI Notes Assistant storage helper (Vault wrapper)
// Stores outputs in S3 (AES256) when configured, otherwise local ./uploads/vault
// /PDFREALM_SECURE_AI_STORAGE_V1
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");

const ROOT_DIR = path.join(__dirname, "..");

const s3Region = process.env.AWS_REGION || "us-east-2";
const vaultBucket =
  process.env.SECURE_VAULT_BUCKET ||
  process.env.AWS_VAULT_BUCKET ||
  process.env.AWS_Vault_Bucket ||
  process.env.AWS_S3_BUCKET ||
  "pdfrealm";

const s3 = new S3Client({
  region: s3Region,
  credentials: process.env.AWS_ACCESS_KEY_ID
    ? {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ""
      }
    : undefined
});

function awsOk() {
  return !!(process.env.AWS_REGION && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && vaultBucket);
}

function safeSegment(s) {
  return String(s || "").replace(/[^a-zA-Z0-9_\-./]/g, "_").replace(/\/+/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function getUserVaultPrefix(userId) {
  const rawPrefix = String(process.env.VAULT_OBJECT_PREFIX || "").trim();
  const normPrefix = rawPrefix ? rawPrefix.replace(/^\/+/, "").replace(/\/?$/, "/") : "";
  const safeUser = String(userId || "unknown").replace(/[^a-zA-Z0-9_\-]/g, "_");
  return `${normPrefix}${safeUser}/`;
}

function buildVaultKey({ userId, folderPath, fileName }) {
  const prefix = getUserVaultPrefix(userId);
  const folderSeg = safeSegment(folderPath || "Secure AI Notes");
  const safeName = String(fileName || "file").replace(/[^a-zA-Z0-9_.\-]/g, "_");
  const uniq = crypto.randomBytes(8).toString("hex");
  return `${prefix}${folderSeg}/${Date.now()}_${uniq}_${safeName}`;
}

function localAbsPathFromStorageKey(storageKey) {
  // local/<userId>/<baseKey>
  const m = /^local\/([^/]+)\/(.+)$/.exec(storageKey || "");
  if (!m) return null;
  const userId = m[1];
  const rel = m[2];
  return path.join(ROOT_DIR, "uploads", "vault", String(userId), rel);
}

async function putVaultObject({ userId, folderPath, fileName, mimeType, buffer }) {
  const baseKey = buildVaultKey({ userId, folderPath, fileName });
  const contentType = mimeType || "application/octet-stream";
  const sizeBytes = buffer ? buffer.length : 0;

  if (awsOk()) {
    await s3.send(
      new PutObjectCommand({
        Bucket: vaultBucket,
        Key: baseKey,
        Body: buffer,
        ContentType: contentType,
        ServerSideEncryption: "AES256"
      })
    );
    return { storageKey: baseKey, sizeBytes, backend: "s3", bucket: vaultBucket };
  }

  const abs = path.join(ROOT_DIR, "uploads", "vault", String(userId), baseKey);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buffer);
  return { storageKey: `local/${userId}/${baseKey}`, sizeBytes, backend: "local", absPath: abs };
}

async function putVaultObjectFromFile({ userId, folderPath, fileName, mimeType, absPath }) {
  if (!absPath) throw new Error("absPath required");
  const baseKey = buildVaultKey({ userId, folderPath, fileName });
  const contentType = mimeType || "application/octet-stream";

  const stat = fs.statSync(absPath);

  if (awsOk()) {
    await s3.send(
      new PutObjectCommand({
        Bucket: vaultBucket,
        Key: baseKey,
        Body: fs.createReadStream(absPath),
        ContentType: contentType,
        ContentLength: stat.size,
        ServerSideEncryption: "AES256"
      })
    );
    return { storageKey: baseKey, sizeBytes: stat.size, backend: "s3", bucket: vaultBucket };
  }

  const destAbs = path.join(ROOT_DIR, "uploads", "vault", String(userId), baseKey);
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.copyFileSync(absPath, destAbs);
  return { storageKey: `local/${userId}/${baseKey}`, sizeBytes: stat.size, backend: "local", absPath: destAbs };
}



async function streamVaultObjectToResponse({ storageKey, res, mimeType, downloadName }) {
  if (!storageKey) {
    res.status(404).send("Missing storage key");
    return;
  }

  if (storageKey.startsWith("local/")) {
    const abs = localAbsPathFromStorageKey(storageKey);
    if (!abs || !fs.existsSync(abs)) {
      res.status(404).send("Not found");
      return;
    }
    res.setHeader("Content-Type", mimeType || "application/octet-stream");
    if (downloadName) res.setHeader("Content-Disposition", `attachment; filename="${downloadName}"`);
    fs.createReadStream(abs).pipe(res);
    return;
  }

  // S3
  const obj = await s3.send(new GetObjectCommand({ Bucket: vaultBucket, Key: storageKey }));
  res.setHeader("Content-Type", mimeType || obj.ContentType || "application/octet-stream");
  if (downloadName) res.setHeader("Content-Disposition", `attachment; filename="${downloadName}"`);
  if (obj.Body && typeof obj.Body.pipe === "function") {
    obj.Body.pipe(res);
  } else {
    // Fallback: buffer in memory
    const chunks = [];
    for await (const c of obj.Body) chunks.push(Buffer.from(c));
    res.end(Buffer.concat(chunks));
  }
}

async function deleteVaultObject(storageKey) {
  if (!storageKey) return;
  if (storageKey.startsWith("local/")) {
    const abs = localAbsPathFromStorageKey(storageKey);
    if (abs && fs.existsSync(abs)) {
      try { fs.unlinkSync(abs); } catch (_) {}
    }
    return;
  }
  if (!awsOk()) return;
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: vaultBucket, Key: storageKey }));
  } catch (_) {}
}

module.exports = {
  putVaultObject,
  putVaultObjectFromFile,
  streamVaultObjectToResponse,
  deleteVaultObject,
  awsOk
};
