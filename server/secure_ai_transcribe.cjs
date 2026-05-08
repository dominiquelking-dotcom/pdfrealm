// PDFRealm Secure Suite: Secure AI Notes Assistant transcription
// /PDFREALM_SECURE_AI_TRANSCRIBE_V1
const fs = require("fs");
const path = require("path");
const { requestMultipartFile, getOpenAiApiKey } = require("./secure_ai_openai.cjs");

async function transcribeAudioWav({ wavPath, language }) {
  const provider = String(process.env.TRANSCRIBE_PROVIDER || (getOpenAiApiKey() ? "OPENAI" : "STUB")).toUpperCase();
  if (provider !== "OPENAI") {
    return {
      provider,
      language: language || null,
      segments: [{ start: 0, end: 0, speaker: "Speaker", text: "(Transcription unavailable — configure TRANSCRIBE_PROVIDER=OPENAI and OPENAI_API_KEY.)" }]
    };
  }

  const model = process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";
  if (!fs.existsSync(wavPath)) throw new Error("WAV file not found: " + wavPath);

  const fields = {
    model,
    response_format: "verbose_json"
  };

  // Timestamp segments when supported
  fields["timestamp_granularities[]"] = "segment";

  if (language) fields.language = language;

  const resp = await requestMultipartFile({
    path: "/v1/audio/transcriptions",
    fields,
    fileFieldName: "file",
    filePath: wavPath,
    fileName: path.basename(wavPath),
    fileMime: "audio/wav",
    timeoutMs: 300_000
  });

  const segments = Array.isArray(resp.segments)
    ? resp.segments.map((s) => ({
        start: typeof s.start === "number" ? s.start : 0,
        end: typeof s.end === "number" ? s.end : 0,
        speaker: "Speaker",
        text: String(s.text || "").trim()
      }))
    : [{ start: 0, end: 0, speaker: "Speaker", text: String(resp.text || "").trim() }];

  return {
    provider,
    language: resp.language || language || null,
    text: resp.text || null,
    segments
  };
}

module.exports = { transcribeAudioWav };
