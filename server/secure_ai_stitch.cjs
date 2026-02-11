// PDFRealm Secure Suite: Secure AI Notes Assistant audio stitching utilities
// /PDFREALM_SECURE_AI_STITCH_V1
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const msg = (r.stderr || r.stdout || "").slice(-4000);
    throw new Error(`Command failed: ${cmd} ${args.join(" ")}\n${msg}`);
  }
  return r;
}

function listChunkFiles(chunksDir) {
  if (!fs.existsSync(chunksDir)) return [];
  const files = fs
    .readdirSync(chunksDir)
    .filter((f) => f.endsWith(".webm") || f.endsWith(".ogg"))
    .sort();
  return files;
}

function stitchWebmChunks({ sessionDir, ffmpegPath }) {
  const ffmpeg = ffmpegPath || process.env.FFMPEG_PATH || "ffmpeg";
  const chunksDir = path.join(sessionDir, "chunks");
  const files = listChunkFiles(chunksDir);
  if (!files.length) throw new Error("No chunks found to stitch.");

  // concat list file (relative paths from chunksDir)
  const listPath = path.join(chunksDir, "chunks.txt");
  const listLines = files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`);
  fs.writeFileSync(listPath, listLines.join("\n") + "\n");

  const combinedWebmPath = path.join(sessionDir, "combined.webm");
  run(ffmpeg, ["-f", "concat", "-safe", "0", "-i", "chunks.txt", "-c", "copy", combinedWebmPath], { cwd: chunksDir });

  const wavPath = path.join(sessionDir, "audio.wav");
  run(ffmpeg, ["-y", "-i", combinedWebmPath, "-ar", "16000", "-ac", "1", wavPath], { cwd: sessionDir });

  return { combinedWebmPath, wavPath, chunkCount: files.length };
}

module.exports = { stitchWebmChunks };
