const express = require("express");
const path = require("path");
const PDFDocument = require("pdfkit");

const app = express();
const PORT = process.env.PORT || 8080;

// Basic logging
app.use((req, res, next) => {
  const now = new Date().toISOString();
  console.log(`[${now}] ${req.method} ${req.url}`);
  next();
});

// Parse JSON bodies for API routes
app.use(express.json());

// Serve static assets
app.use(express.static(path.join(__dirname, "public")));

// ---- API: Invoice PDF generator ----
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

  const filename = (number || "invoice").replace(/[^\w\-]+/g, "_") + ".pdf";
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}"`
  );

  doc.pipe(res);

  // ---------- Colors / helpers ----------
  const primary = "#0f172a";
  const accent = "#2563eb";
  const lightBorder = "#e5e7eb";
  const muted = "#6b7280";

  const amtNum =
    typeof amount === "number" ? amount : parseFloat(amount) || 0;
  const amtStr = amtNum ? `$${amtNum.toFixed(2)}` : "—";

  // ---------- Header bar ----------
  doc
    .rect(50, 40, 512, 70)
    .fill(primary);

  doc
    .fill("#ffffff")
    .font("Helvetica-Bold")
    .fontSize(16)
    .text(from || "Your Business", 60, 50, {
      width: 300,
    });

  doc
    .font("Helvetica")
    .fontSize(9)
    .fill("#cbd5f5")
    .text("MyFreightTracker PDF Studio", 60, 75);

  doc
    .font("Helvetica-Bold")
    .fontSize(22)
    .fill("#ffffff")
    .text("INVOICE", 0, 48, {
      align: "right",
      width: 512,
    });

  // reset fill for body
  doc.fill(primary);

  let y = 130;

  // ---------- Bill From / Bill To boxes ----------
  // Left box: Bill From / To
  doc
    .roundedRect(50, y, 260, 100, 6)
    .strokeColor(lightBorder)
    .lineWidth(1)
    .stroke();

  doc
    .fontSize(9)
    .fillColor(muted)
    .text("Bill From", 60, y + 10);

  doc
    .fontSize(10)
    .fillColor(primary)
    .font("Helvetica-Bold")
    .text(from || "—", 60, y + 23, { width: 240 });

  doc
    .font("Helvetica")
    .fillColor(muted)
    .text("Bill To", 60, y + 50);

  doc
    .font("Helvetica-Bold")
    .fillColor(primary)
    .text(to || "—", 60, y + 63, { width: 240 });

  // Right box: Invoice meta + amount
  doc
    .roundedRect(50 + 270, y, 242, 100, 6)
    .strokeColor(lightBorder)
    .lineWidth(1)
    .stroke();

  const rightX = 50 + 280;

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

  // ---------- Line item / notes "table" ----------
  doc
    .fontSize(10)
    .fillColor(primary)
    .font("Helvetica-Bold")
    .text("Details / Notes", 50, y);

  y += 18;

  // table header
  const tableLeft = 50;
  const tableRight = 562;
  const amountColX = tableRight - 100;

  doc
    .moveTo(tableLeft, y)
    .lineTo(tableRight, y)
    .strokeColor(lightBorder)
    .lineWidth(1)
    .stroke();

  y += 6;

  doc
    .fontSize(9)
    .fillColor(muted)
    .font("Helvetica-Bold")
    .text("Description", tableLeft + 4, y, {
      width: amountColX - tableLeft - 8,
    });

  doc
    .text("Amount", amountColX + 4, y, {
      width: 90,
      align: "right",
    });

  y += 18;

  // table row background
  doc
    .rect(tableLeft, y - 4, tableRight - tableLeft, 36)
    .fill("#f9fafb");

  doc.fillColor(primary).font("Helvetica");

  const description = notes || "Services rendered";

  doc.text(description, tableLeft + 8, y, {
    width: amountColX - tableLeft - 12,
  });

  doc
    .font("Helvetica-Bold")
    .text(amtStr, amountColX + 4, y, {
      width: 90,
      align: "right",
    });

  y += 50;

  // Subtotal / total section
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
    .text("Subtotal", amountColX + 4, y, {
      width: 90,
      align: "right",
    });

  y += 14;

  doc
    .font("Helvetica-Bold")
    .fillColor(primary)
    .text("Total Due", amountColX + 4, y, {
      width: 90,
      align: "right",
    });

  // values
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

  // ---------- Footer ----------
  doc
    .fontSize(8)
    .fillColor(muted)
    .text(
      "Generated by MyFreightTracker PDF Studio. This invoice is for business use between the parties listed above.",
      50,
      720,
      { align: "center", width: 512 }
    );

  doc.end();
});

// Root route – serve main UI
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`DocSuite UI running on port ${PORT}`);
});
