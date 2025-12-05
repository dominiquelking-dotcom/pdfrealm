const express = require("express");
const path = require("path");
const PDFDocument = require("pdfkit");
const multer = require("multer");
const {
  PDFDocument: PDFLibDocument,
  StandardFonts,
  rgb,
} = require("pdf-lib");
const { Document, Packer, Paragraph, TextRun } = require("docx");

const app = express();
const PORT = process.env.PORT || 8080;

// ---- Middleware ----

// Simple logging
app.use((req, res, next) => {
  const now = new Date().toISOString();
  console.log(`[${now}] ${req.method} ${req.url}`);
  next();
});

// JSON for simple APIs
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

// ---------------------------------------------------------------------
//  TEMPLATE CATALOG (NEW)
// ---------------------------------------------------------------------
app.get("/api/templates/catalog", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "templates", "catalog.json"));
});

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

// ---------------------------------------------------------------------
//  INVOICE
// ---------------------------------------------------------------------
app.post("/api/invoice/generate", (req, res) => {
  const {
    from = "",
    to = "",
    number = "",
    amount = 0,
    notes = "",
  } = req.body || {};

  console.log("Generating invoice PDF for:", { from, to, number, amount });

  const doc = new PDFDocument({ margin: 50 });
  streamPdf(doc, res, number || "invoice");

  const { primary, accent, lightBorder, muted } = COLORS;
  const amtNum =
    typeof amount === "number" ? amount : parseFloat(amount) || 0;
  const amtStr = amtNum ? `$${amtNum.toFixed(2)}` : "—";

  // Header bar
  doc.rect(50, 40, 512, 70).fill(primary);

  // Company name
  doc
    .fill("#ffffff")
    .font("Helvetica-Bold")
    .fontSize(16)
    .text(from || "Your Business Name", 60, 60, { width: 300 });

  // Invoice title
  doc
    .font("Helvetica-Bold")
    .fontSize(22)
    .fill("#ffffff")
    .text("INVOICE", 0, 48, { align: "right", width: 512 });

  doc.fill(primary);
  let y = 130;

  // Bill From / To box
  doc
    .roundedRect(50, y, 260, 100, 6)
    .strokeColor(lightBorder)
    .lineWidth(1)
    .stroke();

  doc.fontSize(9).fillColor(muted).text("Bill From", 60, y + 10);
  doc
    .fontSize(10)
    .fillColor(primary)
    .font("Helvetica-Bold")
    .text(from || "—", 60, y + 23, { width: 240 });

  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor(muted)
    .text("Bill To", 60, y + 50);
  doc
    .font("Helvetica-Bold")
    .fontSize(10)
    .fillColor(primary)
    .text(to || "—", 60, y + 63, { width: 240 });

  // Invoice meta / amount box
  doc
    .roundedRect(320, y, 242, 100, 6)
    .strokeColor(lightBorder)
    .lineWidth(1)
    .stroke();

  const rightX = 330;

  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor(muted)
    .text("Invoice / Load #", rightX, y + 10);
  doc
    .font("Helvetica-Bold")
    .fontSize(11)
    .fillColor(primary)
    .text(number || "—", rightX, y + 22, { width: 190 });

  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor(muted)
    .text("Total Due", rightX, y + 50);
  doc
    .font("Helvetica-Bold")
    .fontSize(16)
    .fillColor(accent)
    .text(amtStr, rightX, y + 62, { width: 190 });

  y += 130;

  // Details table
  const tableLeft = 50;
  const tableRight = 562;
  const amountColX = tableRight - 100;

  doc
    .fontSize(10)
    .font("Helvetica-Bold")
    .fillColor(primary)
    .text("Details / Notes", tableLeft, y);

  y += 18;

  doc
    .moveTo(tableLeft, y)
    .lineTo(tableRight, y)
    .strokeColor(lightBorder)
    .lineWidth(1)
    .stroke();

  y += 6;

  doc
    .fontSize(9)
    .font("Helvetica-Bold")
    .fillColor(muted)
    .text("Description", tableLeft + 4, y, {
      width: amountColX - tableLeft - 8,
    });
  doc.text("Amount", amountColX + 4, y, { width: 90, align: "right" });

  y += 18;

  // Row background
  doc
    .rect(tableLeft, y - 4, tableRight - tableLeft, 36)
    .fill("#f9fafb");
  doc.fillColor(primary).font("Helvetica");

  doc.text(notes || "Services rendered", tableLeft + 8, y, {
    width: amountColX - tableLeft - 12,
  });
  doc
    .font("Helvetica-Bold")
    .text(amtStr, amountColX + 4, y, { width: 90, align: "right" });

  y += 50;

  // Totals
  doc
    .moveTo(tableLeft, y)
    .lineTo(tableRight, y)
    .strokeColor(lightBorder)
    .lineWidth(1)
    .stroke();

  y += 10;

  doc
    .fontSize(10)
    .font("Helvetica")
    .fillColor(muted)
    .text("Subtotal", amountColX + 4, y, { width: 90, align: "right" });

  y += 14;

  doc
    .font("Helvetica-Bold")
    .fillColor(primary)
    .text("Total Due", amountColX + 4, y, { width: 90, align: "right" });

  const valueY1 = y - 14;
  const valueY2 = y;

  doc
    .font("Helvetica")
    .fillColor(primary)
    .text(amtStr, amountColX - 70, valueY1, {
      width: 70,
      align: "right",
    });
  doc
    .font("Helvetica-Bold")
    .fillColor(accent)
    .text(amtStr, amountColX - 70, valueY2, {
      width: 70,
      align: "right",
    });

  // Footer
  doc
    .fontSize(8)
    .fillColor(muted)
    .text(
      "Generated by PDFRealm (MyFreightTracker PDF Studio). This invoice is for business use between the parties listed above.",
      50,
      720,
      { align: "center", width: 512 }
    );

  doc.end();
});

// ---------------------------------------------------------------------
//  RECEIPT
// ---------------------------------------------------------------------
app.post("/api/receipt/generate", (req, res) => {
  const {
    from = "",
    to = "",
    amount = 0,
    reason = "",
    method = "",
  } = req.body || {};

  console.log("Generating receipt PDF for:", { from, to, amount });

  const doc = new PDFDocument({ margin: 50 });
  streamPdf(doc, res, "receipt");

  const { primary, accent, lightBorder, muted } = COLORS;
  const amtNum =
    typeof amount === "number" ? amount : parseFloat(amount) || 0;
  const amtStr = amtNum ? `$${amtNum.toFixed(2)}` : "—";

  // Header
  doc.rect(50, 40, 512, 60).fill(primary);

  doc
    .fill("#ffffff")
    .font("Helvetica-Bold")
    .fontSize(16)
    .text(from || "Payment Receipt", 60, 55, { width: 300 });

  doc
    .font("Helvetica-Bold")
    .fontSize(20)
    .fill("#ffffff")
    .text("RECEIPT", 0, 48, { align: "right", width: 512 });

  doc.fill(primary);

  let y = 120;

  // To / amount
  doc
    .roundedRect(50, y, 512, 80, 6)
    .strokeColor(lightBorder)
    .lineWidth(1)
    .stroke();

  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor(muted)
    .text("Received from:", 60, y + 12);
  doc
    .font("Helvetica-Bold")
    .fontSize(11)
    .fillColor(primary)
    .text(to || "—", 60, y + 26, { width: 260 });

  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor(muted)
    .text("Amount:", 340, y + 12);
  doc
    .font("Helvetica-Bold")
    .fontSize(14)
    .fillColor(accent)
    .text(amtStr, 340, y + 26, { width: 200, align: "right" });

  y += 110;

  // Reason / method
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor(muted)
    .text("For:", 50, y);
  doc
    .font("Helvetica")
    .fontSize(11)
    .fillColor(primary)
    .text(reason || "—", 70, y, { width: 492 });

  y += 40;

  doc
    .fontSize(10)
    .fillColor(muted)
    .text("Payment method:", 50, y);
  doc
    .font("Helvetica-Bold")
    .fontSize(11)
    .fillColor(primary)
    .text(method || "—", 135, y);

  // Footer
  doc
    .fontSize(8)
    .fillColor(muted)
    .text(
      "Thank you for your payment. Keep this receipt for your records.",
      50,
      720,
      { align: "center", width: 512 }
    );

  doc.end();
});

// ---------------------------------------------------------------------
//  PAYSTUB
// ---------------------------------------------------------------------
app.post("/api/paystub/generate", (req, res) => {
  const {
    employee = "",
    employer = "",
    gross = 0,
    deductions = 0,
    period = "",
  } = req.body || {};

  console.log("Generating paystub PDF for:", { employee, employer });

  const grossNum =
    typeof gross === "number" ? gross : parseFloat(gross) || 0;
  const dedNum =
    typeof deductions === "number"
      ? deductions
      : parseFloat(deductions) || 0;
  const net = Math.max(grossNum - dedNum, 0);

  const doc = new PDFDocument({ margin: 50 });
  streamPdf(doc, res, "paystub");

  const { primary, accent, lightBorder, muted } = COLORS;

  // Header
  doc.rect(50, 40, 512, 60).fill(primary);

  doc
    .fill("#ffffff")
    .font("Helvetica-Bold")
    .fontSize(16)
    .text(employer || "Employer", 60, 55, { width: 300 });

  doc
    .font("Helvetica-Bold")
    .fontSize(18)
    .fill("#ffffff")
    .text("PAYSTUB", 0, 50, { align: "right", width: 512 });

  doc.fill(primary);

  let y = 120;

  // Employee / period box
  doc
    .roundedRect(50, y, 512, 80, 6)
    .strokeColor(lightBorder)
    .lineWidth(1)
    .stroke();

  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor(muted)
    .text("Employee:", 60, y + 12);
  doc
    .font("Helvetica-Bold")
    .fontSize(11)
    .fillColor(primary)
    .text(employee || "—", 60, y + 26, { width: 260 });

  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor(muted)
    .text("Pay period:", 340, y + 12);
  doc
    .font("Helvetica-Bold")
    .fontSize(11)
    .fillColor(primary)
    .text(period || "—", 340, y + 26, { width: 200, align: "right" });

  y += 110;

  // Earnings / deductions table
  doc
    .font("Helvetica-Bold")
    .fontSize(10)
    .fillColor(primary)
    .text("Earnings", 50, y);
  doc.text("Deductions", 320, y);

  y += 14;

  doc
    .moveTo(50, y)
    .lineTo(562, y)
    .strokeColor(lightBorder)
    .lineWidth(1)
    .stroke();

  y += 8;

  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor(muted)
    .text("Gross pay", 50, y);
  doc
    .font("Helvetica-Bold")
    .fillColor(primary)
    .text(`$${grossNum.toFixed(2)}`, 180, y, { width: 80, align: "right" });

  doc
    .font("Helvetica")
    .fillColor(muted)
    .text("Total deductions", 320, y);
  doc
    .font("Helvetica-Bold")
    .fillColor(primary)
    .text(`$${dedNum.toFixed(2)}`, 480, y, { width: 70, align: "right" });

  y += 40;

  doc
    .moveTo(50, y)
    .lineTo(562, y)
    .strokeColor(lightBorder)
    .lineWidth(1)
    .stroke();

  y += 10;

  doc
    .font("Helvetica-Bold")
    .fontSize(11)
    .fillColor(primary)
    .text("Net pay:", 50, y);
  doc
    .font("Helvetica-Bold")
    .fontSize(14)
    .fillColor(accent)
    .text(`$${net.toFixed(2)}`, 120, y - 3, {
      width: 150,
      align: "left",
    });

  // Footer
  doc
    .fontSize(8)
    .fillColor(muted)
    .text(
      "For internal business use only. This document is not a substitute for formal payroll.",
      50,
      720,
      { align: "center", width: 512 }
    );

  doc.end();
});

// ---------------------------------------------------------------------
//  WORD -> PDF (placeholder converter)
// ---------------------------------------------------------------------
app.post(
  "/api/convert/word-to-pdf",
  upload.single("file"),
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const originalName = req.file.originalname;
    const title = req.body.title || "";

    console.log("Word->PDF for:", originalName);

    const doc = new PDFDocument({ margin: 50 });
    const baseName = safeFilename(
      title || originalName.replace(/\.(docx?|rtf)$/i, ""),
      "converted"
    );
    streamPdf(doc, res, baseName);

    const { primary, muted } = COLORS;

    doc
      .font("Helvetica-Bold")
      .fontSize(20)
      .fillColor(primary)
      .text("Word → PDF (Preview)", { align: "left" })
      .moveDown();

    doc
      .font("Helvetica")
      .fontSize(11)
      .fillColor(primary)
      .text(`Original file: ${originalName}`)
      .moveDown(0.5);

    if (title) {
      doc
        .font("Helvetica")
        .fontSize(11)
        .text(`Output title: ${title}`)
        .moveDown();
    }

    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor(muted)
      .text(
        "This is a placeholder PDF generated from the uploaded Word document. " +
          "Full content conversion will be added later.",
        { align: "left" }
      );

    doc
      .moveDown(2)
      .fontSize(8)
      .fillColor(muted)
      .text("Generated by PDFRealm (MyFreightTracker PDF Studio).", {
        align: "left",
      });

    doc.end();
  }
);

// ---------------------------------------------------------------------
//  PDF -> WORD (placeholder DOCX)
// ---------------------------------------------------------------------
app.post(
  "/api/convert/pdf-to-word",
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const originalName = req.file.originalname;
      console.log("PDF->Word for:", originalName);

      const docx = new Document({
        sections: [
          {
            properties: {},
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: "PDF → Word (Preview)",
                    bold: true,
                    size: 28,
                  }),
                ],
              }),
              new Paragraph(""),
              new Paragraph(`Original PDF file: ${originalName}`),
              new Paragraph(""),
              new Paragraph(
                "This is a placeholder Word document created by PDFRealm (MyFreightTracker PDF Studio)."
              ),
              new Paragraph(
                "Full content conversion from PDF to an editable Word layout will be added later."
              ),
            ],
          },
        ],
      });

      const buffer = await Packer.toBuffer(docx);
      const baseName = safeFilename(
        originalName.replace(/\.pdf$/i, ""),
        "converted"
      );
      const filename = `${baseName}.docx`;

      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=\"${filename}\"`
      );
      res.send(buffer);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to create Word document" });
    }
  }
);

// ---------------------------------------------------------------------
//  QUICK SIGN (drag-positioned signature)
// ---------------------------------------------------------------------
app.post(
  "/api/quick-sign",
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No PDF uploaded" });
      }

      const signerName = (req.body.signerName || "").trim() || "Signed";
      // Normalized coordinates from front-end (0–1)
      const posX = parseFloat(req.body.posX);
      const posY = parseFloat(req.body.posY);

      const xNorm = isNaN(posX) ? 0.5 : Math.min(Math.max(posX, 0), 1);
      const yNorm = isNaN(posY) ? 0.2 : Math.min(Math.max(posY, 0), 1);

      const originalName = req.file.originalname || "document.pdf";
      console.log("Quick sign for:", {
        originalName,
        signerName,
        xNorm,
        yNorm,
      });

      // Load existing PDF
      const pdfDoc = await PDFLibDocument.load(req.file.buffer);

      const pages = pdfDoc.getPages();
      const lastPage = pages[pages.length - 1];
      const { width, height } = lastPage.getSize();

      const font = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
      const fontSize = 18;

      // Convert from viewer coords (top-left origin, normalized) to PDF coords
      const htmlX = xNorm * width;
      const htmlYFromTop = yNorm * height;

      const pdfBaselineY = height - htmlYFromTop - 4;
      const pdfLineY = pdfBaselineY - 4;

      const signatureText = signerName;
      const signedOn = new Date().toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "2-digit",
      });

      // Optional line
      lastPage.drawLine({
        start: { x: 40, y: pdfLineY },
        end: { x: width - 40, y: pdfLineY },
        thickness: 0.7,
        color: rgb(0.7, 0.7, 0.7),
      });

      // Signature text
      lastPage.drawText(signatureText, {
        x: htmlX,
        y: pdfBaselineY,
        size: fontSize,
        font,
        color: rgb(0.1, 0.1, 0.1),
      });

      // "Signed on"
      lastPage.drawText(`Signed on ${signedOn}`, {
        x: 44,
        y: pdfLineY - 14,
        size: 9,
        font,
        color: rgb(0.4, 0.4, 0.4),
      });

      const signedBytes = await pdfDoc.save();

      const base = safeFilename(
        originalName.replace(/\.pdf$/i, "") + "-signed",
        "signed"
      );
      const filename = `${base}.pdf`;

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`
      );
      res.send(Buffer.from(signedBytes));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to quick-sign PDF" });
    }
  }
);

// ---------------------------------------------------------------------
//  MERGE PDFs
// ---------------------------------------------------------------------
app.post(
  "/api/pdf/merge",
  upload.array("files", 10),
  async (req, res) => {
    try {
      const files = req.files || [];
      if (!files.length) {
        return res.status(400).json({ error: "No PDF files uploaded" });
      }

      console.log("Merging PDFs:", files.map((f) => f.originalname));

      const mergedPdf = await PDFLibDocument.create();

      for (const file of files) {
        const pdf = await PDFLibDocument.load(file.buffer);
        const copiedPages = await mergedPdf.copyPages(
          pdf,
          pdf.getPageIndices()
        );
        copiedPages.forEach((page) => mergedPdf.addPage(page));
      }

      const mergedBytes = await mergedPdf.save();
      const filename = "merged.pdf";

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`
      );
      res.send(Buffer.from(mergedBytes));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to merge PDFs" });
    }
  }
);

// ---------------------------------------------------------------------
//  Root page
// ---------------------------------------------------------------------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`PDFRealm (MyFreightTracker PDF Studio) running on port ${PORT}`);
});

