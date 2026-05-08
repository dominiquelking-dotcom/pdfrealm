// Minimal OpenAI HTTP helpers (no SDK dependency)
// /PDFREALM_SECURE_AI_OPENAI_HTTP_V1
const https = require("https");
const fs = require("fs");
const crypto = require("crypto");

function getOpenAiApiKey() {
  return process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || "";
}

function requestJson({ path, method, apiKey, bodyObj, timeoutMs }) {
  const key = apiKey || getOpenAiApiKey();
  if (!key) throw new Error("OPENAI_API_KEY not configured.");

  const payload = Buffer.from(JSON.stringify(bodyObj || {}), "utf8");
  const opts = {
    method: method || "POST",
    hostname: "api.openai.com",
    path,
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
      "Content-Length": payload.length
    },
    timeout: timeoutMs || 60_000
  };

  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        const txt = buf.toString("utf8");
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(txt));
          } catch (e) {
            reject(new Error("Failed to parse OpenAI JSON response: " + e.message));
          }
        } else {
          reject(new Error(`OpenAI error ${res.statusCode}: ${txt.slice(0, 2000)}`));
        }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function requestMultipartFile({ path, apiKey, fields, fileFieldName, filePath, fileName, fileMime, timeoutMs }) {
  const key = apiKey || getOpenAiApiKey();
  if (!key) throw new Error("OPENAI_API_KEY not configured.");
  if (!filePath) throw new Error("filePath required.");

  const boundary = "----pdfrealm_boundary_" + crypto.randomBytes(12).toString("hex");
  const fieldParts = [];

  const addField = (name, value) => {
    fieldParts.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
          `${value}\r\n`,
        "utf8"
      )
    );
  };

  const f = fields || {};
  for (const [k, v] of Object.entries(f)) addField(k, v);

  const stat = fs.statSync(filePath);
  const safeFileName = fileName || "audio.wav";
  const fileHeader = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fileFieldName || "file"}"; filename="${safeFileName}"\r\n` +
      `Content-Type: ${fileMime || "application/octet-stream"}\r\n\r\n`,
    "utf8"
  );
  const fileFooter = Buffer.from("\r\n", "utf8");
  const end = Buffer.from(`--${boundary}--\r\n`, "utf8");

  const contentLength = fieldParts.reduce((a, b) => a + b.length, 0) + fileHeader.length + stat.size + fileFooter.length + end.length;

  const opts = {
    method: "POST",
    hostname: "api.openai.com",
    path,
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": contentLength
    },
    timeout: timeoutMs || 120_000
  };

  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        const txt = buf.toString("utf8");
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(txt));
          } catch (e) {
            reject(new Error("Failed to parse OpenAI JSON response: " + e.message + " body=" + txt.slice(0, 500)));
          }
        } else {
          reject(new Error(`OpenAI error ${res.statusCode}: ${txt.slice(0, 2000)}`));
        }
      });
    });

    req.on("error", reject);

    for (const p of fieldParts) req.write(p);
    req.write(fileHeader);

    const rs = fs.createReadStream(filePath);
    rs.on("error", reject);
    rs.on("end", () => {
      req.write(fileFooter);
      req.write(end);
      req.end();
    });
    rs.pipe(req, { end: false });
  });
}

module.exports = {
  requestJson,
  requestMultipartFile,
  getOpenAiApiKey
};
