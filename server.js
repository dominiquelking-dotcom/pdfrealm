const express = require("express");
const path = require("path");
const PDFDocument = require("pdfkit");
const multer = require("multer");
const { PDFDocument: PDFLibDocument, StandardFonts, rgb } = require("pdf-lib");
const { Document, Packer, Paragraph, TextRun } = require("docx");
const { exec } = require("child_process");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 8080;

// ---- Middleware ----
app.use((req, res, next) => {
  const now = new Date().toISOString();
  console.log(`[${now}] ${req.method} ${req.url}`);
  next();
});

app.use(express.json());

// File upload (in-memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024, // 15MB per file
    files: 10,
  },
});

// Static assets
app.use(express.static(path.join(__dirname, "public")));

// Shared colors
const COLORS = {
  primary: "#0f172a",
  accent: "#2563eb",
  lightBorder: "#e5e7eb",
  muted: "#6b7280",
};

// Helper: safe filename
function safeFilename(name, fallback) {
  const base = (name && String(name).trim()) || fallback || "document";
  return base.replace(/[^\w\-]+/g, "_");
}

/**
 * Helper: set headers + stream pdfkit doc.
 */
function streamPdf(doc, res, filenameBase) {
  const filename = safeFilename(filenameBase, "document") + ".pdf";
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  doc.pipe(res);
}

// ---- Additional tools and engines ----

// JPG → PDF
app.post("/api/convert/jpg-to-pdf", upload.array("files", 20), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: "No images uploaded" });

    const doc = new PDFDocument({ autoFirstPage: false });
    streamPdf(doc, res, "converted");

    for (const file of files) {
      const img = doc.openImage(file.buffer);
      doc.addPage({ size: [img.width, img.height] });
      doc.image(img, 0, 0);
    }

    doc.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to convert images to PDF" });
  }
});

// PDF → JPG (using pdftoppm and Ghostscript)
app.post("/api/convert/pdf-to-jpg", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No PDF uploaded" });

  const input = "/tmp/in.pdf";
  const output = "/tmp/out";
  fs.writeFileSync(input, req.file.buffer);

  exec(`pdftoppm -jpeg ${input} ${output}`, (err) => {
    if (err) return res.status(500).json({ error: "PDF to JPG failed" });

    const files = fs.readdirSync("/tmp").filter(f => f.startsWith("out"));
    const zip = require("archiver")("zip");
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", "attachment; filename=pages.zip");

    zip.pipe(res);

    for (const file of files) {
      zip.append(fs.readFileSync(`/tmp/${file}`), { name: file });
    }

    zip.finalize();
  });
});

// Compress PDF (Ghostscript)
app.post("/api/pdf/compress", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No PDF uploaded" });

    const originalName = req.file.originalname || "document.pdf";

    exec(`gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/ebook -dNOPAUSE -dQUIET -dBATCH -sOutputFile=/tmp/compressed.pdf /tmp/${originalName}`, (err) => {
      if (err) return res.status(500).json({ error: "Compression failed" });

      res.download("/tmp/compressed.pdf");
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to compress PDF" });
  }
});

// Split PDF
function parsePageRanges(ranges, totalPages) {
  const result = [];
  const parts = ranges.split(",");
  for (const raw of parts) {
    const part = raw.trim();
    if (/^\d+$/.test(part)) {
      const page = parseInt(part, 10);
      if (page >= 1 && page <= totalPages) {
        result.push(page - 1);
      }
    } else {
      const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
      if (m) {
        let start = parseInt(m[1], 10);
        let end = parseInt(m[2], 10);
        for (let p = start; p <= end; p++) {
          if (p >= 1 && p <= totalPages) result.push(p - 1);
        }
      }
    }
  }
  return Array.from(new Set(result));
}

app.post("/api/pdf/split", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No PDF uploaded" });

    const pdfDoc = await PDFLibDocument.load(req.file.buffer);
    const totalPages = pdfDoc.getPageCount();
    const ranges = req.body.ranges || "";
    let indices = parsePageRanges(ranges, totalPages);

    if (!indices.length) indices = pdfDoc.getPageIndices();

    const outDoc = await PDFLibDocument.create();
    const copiedPages = await outDoc.copyPages(pdfDoc, indices);
    copiedPages.forEach((p) => outDoc.addPage(p));

    const outBytes = await outDoc.save();
    res.send(Buffer.from(outBytes));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to split PDF" });
  }
});

// Estimate PDF
app.post("/api/estimate/generate", (req, res) => {
  // Existing code for estimate generation (as in your original server.js file)
  const { from, to, number, validUntil, items, subtotal, taxRate, notes } = req.body || {};
  const doc = new PDFDocument({ margin: 50 });
  streamPdf(doc, res, number || "estimate");

  // Existing PDF generation logic continues here ...
});

// Contract PDF
app.post("/api/contract/generate", (req, res) => {
  // Existing code for contract generation (as in your original server.js file)
  const { from, to, title, scope, payment, startDate, endDate, terms } = req.body || {};
  const doc = new PDFDocument({ margin: 60 });
  streamPdf(doc, res, title || "contract");

  // Existing PDF generation logic continues here ...
});

// Quote to Invoice PDF
app.post("/api/quote-invoice/generate", (req, res) => {
  // Existing code for quote to invoice generation (as in your original server.js file)
  const { from, to, estimateNumber, invoiceNumber, items, subtotal, taxRate, notes } = req.body || {};
  const doc = new PDFDocument({ margin: 50 });
  streamPdf(doc, res, invoiceNumber || "invoice");

  // Existing PDF generation logic continues here ...
});

// Business Letter PDF
app.post("/api/letter/generate", (req, res) => {
  // Existing code for business letter generation (as in your original server.js file)
  const { from, to, subject, body, signoff, senderName } = req.body || {};
  const doc = new PDFDocument({ margin: 60 });
  streamPdf(doc, res, subject || "letter");

  // Existing PDF generation logic continues here ...
});

// Word to PDF (placeholder converter)
app.post("/api/convert/word-to-pdf", upload.single("file"), (req, res) => {
  // Existing code for Word to PDF conversion (as in your original server.js file)
});

// PDF to Word (placeholder)
app.post("/api/convert/pdf-to-word", upload.single("file"), async (req, res) => {
  // Existing code for PDF to Word conversion (as in your original server.js file)
});

// Quick Sign (drag-positioned signature)
app.post("/api/quick-sign", upload.single("file"), async (req, res) => {
  // Existing code for quick sign (as in your original server.js file)
});

// Merge PDFs
app.post("/api/pdf/merge", upload.array("files", 10), async (req, res) => {
  // Existing code for PDF merging (as in your original server.js file)
});

// Root page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`PDFRealm (MyFreightTracker PDF Studio) running on port ${PORT}`);
});
