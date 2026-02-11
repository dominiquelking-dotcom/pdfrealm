// PDFRealm Secure Suite: Secure AI Notes Assistant summarization
// /PDFREALM_SECURE_AI_SUMMARIZE_V1
const { requestJson, getOpenAiApiKey } = require("./secure_ai_openai.cjs");

function extractResponseText(resp) {
  if (!resp) return "";
  if (typeof resp.output_text === "string") return resp.output_text;
  if (typeof resp.outputText === "string") return resp.outputText;

  // Responses API shape: output: [{content:[{type:'output_text', text:'...'}]}]
  if (Array.isArray(resp.output)) {
    for (const item of resp.output) {
      if (item && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (!c) continue;
          if (c.type === "output_text" && typeof c.text === "string") return c.text;
          if (c.type === "text" && typeof c.text === "string") return c.text;
        }
      }
    }
  }

  // Fallback
  try { return JSON.stringify(resp); } catch (_) { return String(resp); }
}

function safeJsonParse(txt) {
  if (!txt) return null;
  try { return JSON.parse(txt); } catch (_) {}
  const i = txt.indexOf("{");
  const j = txt.lastIndexOf("}");
  if (i >= 0 && j > i) {
    try { return JSON.parse(txt.slice(i, j + 1)); } catch (_) {}
  }
  return null;
}

function defaultSummaryStub(transcript) {
  const segs = (transcript && transcript.segments) ? transcript.segments : [];
  const preview = segs.slice(0, 8).map((s) => s.text).filter(Boolean).join(" ").slice(0, 400);
  return {
    summary: preview ? `Transcript preview: ${preview}` : "No transcript available.",
    topics: [],
    decisions: [],
    action_items: [],
    open_questions: [],
    key_quotes: []
  };
}

async function summarizeTranscript({ transcript, session }) {
  const provider = String(process.env.LLM_PROVIDER || (getOpenAiApiKey() ? "OPENAI" : "STUB")).toUpperCase();
  if (provider !== "OPENAI") return { provider, ...defaultSummaryStub(transcript) };

  const model = process.env.OPENAI_LLM_MODEL || "gpt-4o-mini";
  const maxChars = Number(process.env.SECURE_AI_MAX_TRANSCRIPT_CHARS || 120000);

  const lines = [];
  const segs = Array.isArray(transcript?.segments) ? transcript.segments : [];
  for (const s of segs) {
    const ts = typeof s.start === "number" ? `${s.start.toFixed(1)}s` : "";
    const te = typeof s.end === "number" ? `${s.end.toFixed(1)}s` : "";
    const sp = s.speaker ? String(s.speaker) : "Speaker";
    const t = String(s.text || "").replace(/\s+/g, " ").trim();
    if (!t) continue;
    lines.push(`[${ts}-${te}] ${sp}: ${t}`);
  }

  let transcriptText = lines.join("\n");
  if (transcriptText.length > maxChars) transcriptText = transcriptText.slice(0, maxChars) + "\n...[truncated]";

  const sys = `You are an assistant designed to produce a JSON meeting notes object. Output MUST be valid JSON only (no markdown).`;
  const user = `
Create concise meeting/call notes as JSON for the following session.

Session:
- title: ${session?.title || ""}
- session_type: ${session?.session_type || ""}
- started_at: ${session?.started_at || ""}
- ended_at: ${session?.ended_at || ""}

Requirements:
Return a single JSON object with EXACT keys:
- summary: string
- topics: array of { topic: string, details: string }
- decisions: array of string
- action_items: array of { owner: string|null, item: string, due: string|null }
- open_questions: array of string
- key_quotes: array of { speaker: string, quote: string }

Transcript (timestamped):
${transcriptText}
`.trim();

  const body = {
    model,
    input: [
      { role: "system", content: sys + " Include the word JSON in your reasoning: JSON." },
      { role: "user", content: user }
    ],
    text: { format: { type: "json_object" } },
    max_output_tokens: Number(process.env.SECURE_AI_MAX_OUTPUT_TOKENS || 1200)
  };

  const resp = await requestJson({ path: "/v1/responses", bodyObj: body, timeoutMs: 120_000 });
  const out = extractResponseText(resp);
  const obj = safeJsonParse(out);
  if (!obj) throw new Error("Failed to parse summarization JSON.");

  return { provider, ...obj };
}

module.exports = { summarizeTranscript };
