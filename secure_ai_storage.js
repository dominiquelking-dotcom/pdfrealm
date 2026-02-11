
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");

/**
 * Store a buffer as a Vault file (S3 if configured, else local vault storage),
 * and create a corresponding DB row in either vault_files (new schema) or vault_objects (legacy).
 *
 * Returns { storageKey }.
 */
async function storeBufferToVault({
  rootDir,
  user,
  folderKey,
  originalName,
  buffer,
  mimeType,

  safeQuery,
  dbHasTable,
  dbHasColumn,

  s3,
  vaultBucket,
  requireAwsEnvOrThrow,
  getUserVaultPrefix,
  safeExtFromName,
  ensureVaultRootTrashWorking,
  ensureVaultFolderPath,
  normVaultFolderKey,
  vaultFoldersHaveTreeColumns,
}) {
  const userId = String(user.id);

  const rawName = (originalName || "file").toString();
  const cleanedName = rawName.replace(/[\\\/]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 140) || "file";
  const ext = safeExtFromName ? safeExtFromName(cleanedName) : path.extname(cleanedName);
  const filename = cleanedName;

  const folder = normVaultFolderKey ? normVaultFolderKey(String(folderKey || "")) : String(folderKey || "");
  const folderClean = String(folder || "").replace(/^\/+|\/+$/g, "");

  // Ensure vault folder row exists (if vault_folders table exists)
  let folderId = null;
  if (await dbHasTable("vault_folders")) {
    await ensureVaultRootTrashWorking(userId, dbHasColumn, safeQuery);
    const f = await ensureVaultFolderPath(userId, folderClean, safeQuery, dbHasColumn, vaultFoldersHaveTreeColumns);
    folderId = f?.id || null;
  }

  const prefix = getUserVaultPrefix ? getUserVaultPrefix({ id: userId }) : `${encodeURIComponent(userId)}/`;
  const folderSeg = folderClean ? folderClean.split("/").map(encodeURIComponent).join("/") + "/" : "";
  const baseKey = `${prefix}${folderSeg}${Date.now()}_${crypto.randomUUID()}_${filename}`;

  let storageKey = baseKey;
  let awsOk = true;
  try {
    requireAwsEnvOrThrow();
  } catch {
    awsOk = false;
  }

  if (awsOk) {
    await s3.send(
      new PutObjectCommand({
        Bucket: vaultBucket,
        Key: baseKey,
        Body: buffer,
        ContentType: mimeType || "application/octet-stream",
        ServerSideEncryption: "AES256",
      })
    );
  } else {
    // local/<userId>/<baseKey> where baseKey already includes safe user prefix
    const abs = path.join(rootDir || process.cwd(), "uploads", "vault", String(userId), baseKey);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buffer);
    storageKey = `local/${userId}/${baseKey}`;
  }

  // Create DB row: prefer new schema vault_files if present, else legacy vault_objects.
  if (await dbHasTable("vault_files")) {
    const id = crypto.randomUUID();
    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");

    const cols = [];
    const vals = [];
    const add = async (col, val) => {
      if (!(await dbHasColumn("vault_files", col))) return;
      cols.push(col);
      vals.push(val);
    };

    await add("id", id);
    await add("user_id", userId);
    await add("folder_id", folderId);
    await add("filename", filename);
    await add("size_bytes", buffer.length);
    await add("mime_type", mimeType || "application/octet-stream");
    await add("storage_key", storageKey);
    await add("sha256", sha256);
    await add("created_at", new Date());
    await add("updated_at", new Date());

    const placeholders = vals.map((_, i) => `$${i + 1}`);
    await safeQuery(`INSERT INTO vault_files (${cols.join(",")}) VALUES (${placeholders.join(",")})`, vals);
  } else if (await dbHasTable("vault_objects")) {
    const id = crypto.randomUUID();

    const cols = [];
    const vals = [];
    const add = async (col, val) => {
      if (!(await dbHasColumn("vault_objects", col))) return;
      cols.push(col);
      vals.push(val);
    };

    const leafFolder = folderClean.split("/").filter(Boolean).pop() || "";

    await add("id", id);
    await add("user_id", userId);
    await add("filename", filename);
    await add("folder", leafFolder);
    await add("folder_path", folderClean);
    await add("size_bytes", buffer.length);
    await add("mime_type", mimeType || "application/octet-stream");
    await add("key", id); // legacy uses its own "key" field; mirror id
    await add("s3_key", storageKey);
    await add("created_at", new Date());

    const placeholders = vals.map((_, i) => `$${i + 1}`);
    await safeQuery(`INSERT INTO vault_objects (${cols.join(",")}) VALUES (${placeholders.join(",")})`, vals);
  }

  return { storageKey, filename, ext };
}

/**
 * Best-effort: mark a Vault row deleted so it disappears from UI.
 */
async function softDeleteVaultObjectRow({ userId, storageKey, safeQuery, dbHasTable, dbHasColumn }) {
  const uid = String(userId);
  const key = String(storageKey);

  if (await dbHasTable("vault_files")) {
    const hasDeletedAt = await dbHasColumn("vault_files", "deleted_at");
    const hasUpdatedAt = await dbHasColumn("vault_files", "updated_at");
    if (!hasDeletedAt) return;
    await safeQuery(
      `UPDATE vault_files
       SET deleted_at = now()
       ${hasUpdatedAt ? ", updated_at = now()" : ""}
       WHERE user_id = $1 AND storage_key = $2 AND deleted_at IS NULL`,
      [uid, key]
    );
    return;
  }

  if (await dbHasTable("vault_objects")) {
    const hasDeletedAt = await dbHasColumn("vault_objects", "deleted_at");
    if (!hasDeletedAt) return;
    await safeQuery(
      `UPDATE vault_objects
       SET deleted_at = now()
       WHERE user_id = $1 AND s3_key = $2 AND deleted_at IS NULL`,
      [uid, key]
    );
  }
}

/**
 * Delete the underlying object by storage key (S3 or local vault storage).
 */
async function deleteVaultObjectByStorageKey({ storageKey, rootDir, s3, vaultBucket, requireAwsEnvOrThrow }) {
  const key = String(storageKey || "");
  if (!key) return;

  if (key.startsWith("local/")) {
    const parts = key.split("/");
    if (parts.length < 3) return;
    const userId = parts[1];
    const rel = parts.slice(2).join("/");
    const abs = path.join(rootDir || process.cwd(), "uploads", "vault", String(userId), rel);
    try {
      fs.unlinkSync(abs);
    } catch {}
    return;
  }

  requireAwsEnvOrThrow();
  await s3.send(new DeleteObjectCommand({ Bucket: vaultBucket, Key: key }));
}

module.exports = { storeBufferToVault, deleteVaultObjectByStorageKey, softDeleteVaultObjectRow };
