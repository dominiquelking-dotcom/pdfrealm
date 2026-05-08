// PDFRealm Secure Suite: Secure AI Notes Assistant PDF generator (pdfkit)
// /PDFREALM_SECURE_AI_PDF_V1
const PDFDocument = require("pdfkit");

function toIso(d) {
  try {
    if (!d) return "";
    const dt = typeof d === "string" ? new Date(d) : d;
    if (Number.isNaN(dt.getTime())) return String(d);
    return dt.toISOString();
  } catch (_) {
    return String(d || "");
  }
}

function sanitizeText(s) {
  return String(s || "").replace(/\u0000/g, "").trim();
}

function addH1(doc, text) {
  doc.moveDown(0.2);
  doc.fontSize(20).font("Helvetica-Bold").fillColor("black").text(sanitizeText(text), { align: "left" });
  doc.moveDown(0.4);
}

function addH2(doc, text) {
  doc.moveDown(0.8);
  doc.fontSize(14).font("Helvetica-Bold").fillColor("black").text(sanitizeText(text));
  doc.moveDown(0.3);
}

function addPara(doc, text) {
  doc.fontSize(11).font("Helvetica").fillColor("black").text(sanitizeText(text), { lineGap: 3 });
}

function addBullets(doc, items) {
  const arr = Array.isArray(items) ? items : [];
  doc.fontSize(11).font("Helvetica").fillColor("black");
  for (const it of arr) {
    const line = sanitizeText(it);
    if (!line) continue;
    doc.text("• " + line, { indent: 14, lineGap: 3 });
  }
  if (!arr.length) doc.text("—", { indent: 14 });
}

function addKeyValue(doc, key, value) {
  doc.font("Helvetica-Bold").text(sanitizeText(key) + ": ", { continued: true });
  doc.font("Helvetica").text(sanitizeText(value));
}

async function generateReportPdfBuffer({ session, participants, summary, transcript, includeTranscript }) {
  const doc = new PDFDocument({
    size: "LETTER",
    margin: 54,
    bufferPages: true
  });

  const chunks = [];
  doc.on("data", (c) => chunks.push(c));

  // Title
  addH1(doc, summary?.title || session?.title || "AI Notes Report");

  // Meta
  doc.fontSize(10).fillColor("#444").font("Helvetica");
  addKeyValue(doc, "Session Type", session?.session_type || "");
  addKeyValue(doc, "Context", session?.context_id || "");
  addKeyValue(doc, "Started", toIso(session?.started_at || session?.created_at));
  addKeyValue(doc, "Ended", toIso(session?.ended_at || ""));
  addKeyValue(doc, "Generated", new Date().toISOString());
  doc.moveDown(0.8);

  // Participants
  addH2(doc, "Participants");
  const pLines = (participants || []).map((p) => sanitizeText(p.display_name || p.user_id)).filter(Boolean);
  addBullets(doc, pLines);

  // Summary
  addH2(doc, "Summary");
  addPara(doc, summary?.summary || "");

  // Topics
  addH2(doc, "Topics");
  const topics = Array.isArray(summary?.topics) ? summary.topics : [];
  if (!topics.length) {
    doc.text("—");
  } else {
    for (const t of topics) {
      const topic = sanitizeText(t.topic || "");
      const details = sanitizeText(t.details || "");
      if (topic) doc.font("Helvetica-Bold").text(topic);
      if (details) doc.font("Helvetica").text(details, { indent: 12, lineGap: 3 });
      doc.moveDown(0.2);
    }
  }

  // Decisions
  addH2(doc, "Decisions");
  addBullets(doc, summary?.decisions || []);

  // Action items
  addH2(doc, "Action Items");
  const ai = Array.isArray(summary?.action_items) ? summary.action_items : [];
  if (!ai.length) {
    doc.text("—");
  } else {
    for (const item of ai) {
      const owner = sanitizeText(item.owner || "");
      const txt = sanitizeText(item.item || "");
      const due = sanitizeText(item.due || "");
      let line = txt;
      if (owner) line = `${txt} (Owner: ${owner}${due ? `, Due: ${due}` : ""})`;
      else if (due) line = `${txt} (Due: ${due})`;
      doc.text("• " + line, { indent: 14, lineGap: 3 });
    }
  }

  // Open questions
  addH2(doc, "Open Questions");
  addBullets(doc, summary?.open_questions || []);

  // Key quotes
  addH2(doc, "Key Quotes");
  const quotes = Array.isArray(summary?.key_quotes) ? summary.key_quotes : [];
  if (!quotes.length) {
    doc.text("—");
  } else {
    for (const q of quotes) {
      const sp = sanitizeText(q.speaker || "Speaker");
      const qt = sanitizeText(q.quote || "");
      if (!qt) continue;
      doc.font("Helvetica-Bold").text(sp + ":", { continued: true });
      doc.font("Helvetica").text(" “" + qt + "”");
      doc.moveDown(0.2);
    }
  }

  if (includeTranscript) {
    addH2(doc, "Transcript (Appendix)");
    const segs = Array.isArray(transcript?.segments) ? transcript.segments : [];
    if (!segs.length) {
      doc.text("—");
    } else {
      doc.font("Helvetica").fontSize(9).fillColor("black");
      for (const s of segs) {
        const ts = typeof s.start === "number" ? s.start.toFixed(1) : "";
        const te = typeof s.end === "number" ? s.end.toFixed(1) : "";
        const sp = sanitizeText(s.speaker || "Speaker");
        const tx = sanitizeText(s.text || "");
        if (!tx) continue;
        doc.text(`[${ts}-${te}] ${sp}: ${tx}`, { lineGap: 2 });
      }
    }
  }

  // Footer page numbers
  const range = doc.bufferedPageRange(); // { start: 0, count: N }
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.fontSize(9).fillColor("#666").font("Helvetica");
    doc.text(`Page ${i + 1} of ${range.count}`, 0, doc.page.height - 40, { align: "center" });
  }

  doc.end();

  return await new Promise((resolve) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

module.exports = { generateReportPdfBuffer };
