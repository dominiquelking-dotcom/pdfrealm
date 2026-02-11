
const fs = require("fs");

function guessProvider() {
  if (process.env.TRANSCRIBE_PROVIDER) return String(process.env.TRANSCRIBE_PROVIDER).toLowerCase();
  if (process.env.OPENAI_API_KEY) return "openai";
  return "stub";
}

async function transcribeWithOpenAI({ wavPath, language }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const model = process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1";

  const buf = fs.readFileSync(wavPath);
  const blob = new Blob([buf], { type: "audio/wav" });
  const form = new FormData();
  form.append("file", blob, "audio.wav");
  form.append("model", model);
  form.append("response_format", "verbose_json");
  if (language) form.append("language", language);

  const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`OpenAI transcription failed (${resp.status}): ${t.slice(0, 400)}`);
  }

  const json = await resp.json();
  const segments = Array.isArray(json.segments)
    ? json.segments.map((s) => ({
        start: typeof s.start === "number" ? s.start : 0,
        end: typeof s.end === "number" ? s.end : 0,
        speaker: "Speaker",
        text: String(s.text || "").trim(),
      }))
    : [];

  return {
    language: json.language || language || "unknown",
    segments,
    text: json.text || undefined,
  };
}

/**
 * @param {{ wavPath: string, language?: string }} opts
 * @returns {Promise<{language: string, segments: Array<{start:number,end:number,speaker:string,text:string}>, text?: string}>}
 */
async function transcribeAudioWav(opts) {
  const provider = guessProvider();
  if (provider === "openai") return transcribeWithOpenAI(opts);
  // Stub provider: produce empty transcript to keep pipeline stable
  return { language: opts.language || "unknown", segments: [] };
}

module.exports = { transcribeAudioWav };
