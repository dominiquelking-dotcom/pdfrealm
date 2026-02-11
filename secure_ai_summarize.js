
function guessProvider() {
  if (process.env.LLM_PROVIDER) return String(process.env.LLM_PROVIDER).toLowerCase();
  if (process.env.OPENAI_API_KEY) return "openai";
  return "stub";
}

function formatTime(sec) {
  if (typeof sec !== "number" || !Number.isFinite(sec)) return "";
  const s = Math.max(0, Math.floor(sec));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function transcriptToText(transcript, maxChars = 25000) {
  const segs = Array.isArray(transcript?.segments) ? transcript.segments : [];
  const lines = [];
  for (const s of segs) {
    const t = `[${formatTime(s.start)}-${formatTime(s.end)}] ${s.speaker || "Speaker"}: ${String(s.text || "").trim()}`;
    if (!t.trim()) continue;
    lines.push(t);
  }
  let text = lines.join("\n");
  if (text.length > maxChars) text = text.slice(text.length - maxChars);
  return text;
}

function extractJson(text) {
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s === -1 || e === -1 || e <= s) throw new Error("No JSON object found in model output");
  const raw = text.slice(s, e + 1);
  return JSON.parse(raw);
}

async function summarizeWithOpenAI({ transcript, meta }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const transcriptText = transcriptToText(transcript);

  const sys = `You are an AI Notes assistant. You must output ONLY valid JSON (no markdown, no backticks).
Create a structured meeting/conversation report from the transcript.

JSON schema:
{
  "title": string,
  "summary": string[],               // 3-7 bullets
  "topics": [{"name": string, "points": string[]}],
  "decisions": [{"decision": string, "rationale": string}],
  "action_items": [{"task": string, "owner": string, "due_date": string, "priority": "low"|"medium"|"high"}],
  "open_questions": string[],
  "key_quotes": [{"quote": string, "speaker": string, "timestamp": string}]
}

Rules:
- Be conservative: if unsure, omit rather than invent.
- If owners/dates are not mentioned, use "" for owner/due_date.
- key_quotes: max 5, short.
`;

  const user = `Title/context: ${meta?.title || ""}\nSession type: ${meta?.sessionType || ""}\nParticipants: ${
    Array.isArray(meta?.participants) ? meta.participants.join(", ") : ""
  }\n\nTranscript:\n${transcriptText}`;

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      temperature: 0.2,
    }),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`OpenAI summarize failed (${resp.status}): ${t.slice(0, 400)}`);
  }

  const json = await resp.json();
  const text = json?.choices?.[0]?.message?.content || "";
  const out = extractJson(text);

  // Normalize some fields
  out.title = out.title || meta?.title || "Conversation Report";
  out.summary = Array.isArray(out.summary) ? out.summary : [];
  out.topics = Array.isArray(out.topics) ? out.topics : [];
  out.decisions = Array.isArray(out.decisions) ? out.decisions : [];
  out.action_items = Array.isArray(out.action_items) ? out.action_items : [];
  out.open_questions = Array.isArray(out.open_questions) ? out.open_questions : [];
  out.key_quotes = Array.isArray(out.key_quotes) ? out.key_quotes : [];

  return out;
}

/**
 * @param {{ transcript: any, meta?: any }} args
 */
async function summarizeTranscript(args) {
  const provider = guessProvider();
  if (provider === "openai") return summarizeWithOpenAI(args);

  // Stub: small placeholder so PDF still renders
  return {
    title: args?.meta?.title || "Conversation Report",
    summary: ["(LLM provider not configured)"],
    topics: [],
    decisions: [],
    action_items: [],
    open_questions: [],
    key_quotes: [],
  };
}

module.exports = { summarizeTranscript };
