function triggerDownloadFromResponse(res, suggestedName) {
  return res.blob().then((blob) => {
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = suggestedName || "document";
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  });
}

async function jsonToPdf(url, payload, filename) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Server error ${res.status}`);
  }
  await triggerDownloadFromResponse(res, filename);
}

document.addEventListener("DOMContentLoaded", () => {
  console.log("app.js loaded, wiring buttons…");

  // ---------------- Quick Sign ----------------
  const qsFileInput = document.getElementById("qsFile");
  const qsSignerInput = document.getElementById("qsSignerName");
  const qsPdfFrame = document.getElementById("qsPdfFrame");
  const qsPdfPlaceholder = document.getElementById("qsPdfPlaceholder");
  const qsViewerWrapper = document.getElementById("qsViewerWrapper");
  const qsSignatureOverlay = document.getElementById("qsSignatureOverlay");
  const qsSignatureText = document.getElementById("qsSignatureText");
  const qsApplyBtn = document.getElementById("qsApplyBtn");
  const qsStatus = document.getElementById("qsStatus");

  let qsCurrentPdfUrl = null;

  function updateQsSignatureText() {
    if (!qsSignatureText || !qsSignerInput) return;
    const name = qsSignerInput.value.trim() || "Signature";
    qsSignatureText.textContent = name;
  }

  if (qsSignerInput) {
    qsSignerInput.addEventListener("input", updateQsSignatureText);
  }

  function resetQuickSignPreview() {
    if (qsPdfPlaceholder) qsPdfPlaceholder.style.display = "block";
    if (qsViewerWrapper) qsViewerWrapper.style.display = "none";
    if (qsSignatureOverlay) qsSignatureOverlay.style.display = "none";
    if (qsPdfFrame) qsPdfFrame.src = "";
    if (qsCurrentPdfUrl) {
      URL.revokeObjectURL(qsCurrentPdfUrl);
      qsCurrentPdfUrl = null;
    }
  }

  if (qsFileInput && qsPdfFrame) {
    qsFileInput.addEventListener("change", () => {
      const file = qsFileInput.files?.[0];
      if (!file) {
        resetQuickSignPreview();
        return;
      }
      if (file.type !== "application/pdf") {
        alert("Please select a PDF file.");
        qsFileInput.value = "";
        resetQuickSignPreview();
        return;
      }

      if (qsCurrentPdfUrl) {
        URL.revokeObjectURL(qsCurrentPdfUrl);
      }
      qsCurrentPdfUrl = URL.createObjectURL(file);
      qsPdfFrame.src = qsCurrentPdfUrl;

      if (qsPdfPlaceholder) qsPdfPlaceholder.style.display = "none";
      if (qsViewerWrapper) qsViewerWrapper.style.display = "block";
      if (qsSignatureOverlay) {
        qsSignatureOverlay.style.display = "block";
        // Center-ish position
        const wrapperRect = qsViewerWrapper.getBoundingClientRect();
        const overlayRect = qsSignatureOverlay.getBoundingClientRect();
        const left =
          wrapperRect.width / 2 - (overlayRect.width || 120) / 2;
        const top = wrapperRect.height * 0.75;
        qsSignatureOverlay.style.left = `${left}px`;
        qsSignatureOverlay.style.top = `${top}px`;
      }

      if (qsStatus) {
        qsStatus.textContent =
          'Drag the signature on the preview, then click "Apply".';
      }

      updateQsSignatureText();
    });
  }

  // Drag logic
  if (qsSignatureOverlay && qsViewerWrapper) {
    let isDragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    qsSignatureOverlay.addEventListener("mousedown", (e) => {
      isDragging = true;
      const overlayRect = qsSignatureOverlay.getBoundingClientRect();
      dragOffsetX = e.clientX - overlayRect.left;
      dragOffsetY = e.clientY - overlayRect.top;
      qsSignatureOverlay.style.cursor = "grabbing";
    });

    document.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      const wrapperRect = qsViewerWrapper.getBoundingClientRect();
      let left = e.clientX - wrapperRect.left - dragOffsetX;
      let top = e.clientY - wrapperRect.top - dragOffsetY;

      const maxLeft = wrapperRect.width - qsSignatureOverlay.offsetWidth;
      const maxTop = wrapperRect.height - qsSignatureOverlay.offsetHeight;

      left = Math.max(0, Math.min(left, maxLeft));
      top = Math.max(0, Math.min(top, maxTop));

      qsSignatureOverlay.style.left = `${left}px`;
      qsSignatureOverlay.style.top = `${top}px`;
    });

    document.addEventListener("mouseup", () => {
      if (isDragging) {
        isDragging = false;
        qsSignatureOverlay.style.cursor = "grab";
      }
    });
  }

  if (qsApplyBtn && qsFileInput && qsViewerWrapper && qsSignatureOverlay) {
    qsApplyBtn.addEventListener("click", async () => {
      const file = qsFileInput.files?.[0];
      if (!file) {
        alert("Select a PDF file first.");
        return;
      }
      const signerName = qsSignerInput?.value.trim();
      if (!signerName) {
        alert("Enter a signer name.");
        return;
      }

      const wrapperRect = qsViewerWrapper.getBoundingClientRect();
      const overlayRect = qsSignatureOverlay.getBoundingClientRect();

      const centerX =
        overlayRect.left -
        wrapperRect.left +
        overlayRect.width / 2;
      const centerY =
        overlayRect.top -
        wrapperRect.top +
        overlayRect.height / 2;

      const posX = centerX / wrapperRect.width;
      const posY = centerY / wrapperRect.height;

      const formData = new FormData();
      formData.append("file", file);
      formData.append("signerName", signerName);
      formData.append("posX", String(posX));
      formData.append("posY", String(posY));

      try {
        qsApplyBtn.disabled = true;
        qsApplyBtn.textContent = "Applying signature...";
        if (qsStatus) {
          qsStatus.textContent =
            "Applying signature on the server and generating a signed PDF...";
        }

        const res = await fetch("/api/quick-sign", {
          method: "POST",
          body: formData,
        });
        if (!res.ok) {
          throw new Error(`Server error ${res.status}`);
        }

        await triggerDownloadFromResponse(res, "signed.pdf");

        if (qsStatus) {
          qsStatus.textContent = "Signed PDF downloaded.";
        }
      } catch (err) {
        console.error(err);
        alert("Error applying signature. Check console for details.");
        if (qsStatus) {
          qsStatus.textContent =
            "Something went wrong. Try again or refresh the page.";
        }
      } finally {
        qsApplyBtn.disabled = false;
        qsApplyBtn.textContent = "Apply & download signed PDF";
      }
    });
  }

  // ---------------- Invoice ----------------
  const invoiceBtn = document.getElementById("invoiceExportBtn");
  if (invoiceBtn) {
    console.log("Found invoiceExportBtn");
    invoiceBtn.addEventListener("click", async () => {
      const from = document.getElementById("invFrom")?.value || "";
      const to = document.getElementById("invTo")?.value || "";
      const number = document.getElementById("invNumber")?.value || "";
      const amountRaw = document.getElementById("invAmount")?.value || "";
      const notes = document.getElementById("invNotes")?.value || "";
      const amount = amountRaw ? parseFloat(amountRaw) : 0;

      try {
        invoiceBtn.disabled = true;
        invoiceBtn.textContent = "Generating invoice...";
        await jsonToPdf(
          "/api/invoice/generate",
          { from, to, number, amount, notes },
          (number || "invoice") + ".pdf"
        );
      } catch (err) {
        console.error(err);
        alert("Error generating invoice PDF.");
      } finally {
        invoiceBtn.disabled = false;
        invoiceBtn.textContent = "Export invoice PDF – $1.49";
      }
    });
  } else {
    console.warn("invoiceExportBtn not found");
  }

  // ---------------- Receipt ----------------
  const receiptBtn = document.getElementById("receiptExportBtn");
  if (receiptBtn) {
    console.log("Found receiptExportBtn");
    receiptBtn.addEventListener("click", async () => {
      console.log("Receipt button clicked");
      const from = document.getElementById("recFrom")?.value || "";
      const to = document.getElementById("recTo")?.value || "";
      const amountRaw = document.getElementById("recAmount")?.value || "";
      const reason = document.getElementById("recReason")?.value || "";
      const method = document.getElementById("recMethod")?.value || "";
      const amount = amountRaw ? parseFloat(amountRaw) : 0;

      try {
        receiptBtn.disabled = true;
        receiptBtn.textContent = "Generating receipt...";
        await jsonToPdf(
          "/api/receipt/generate",
          { from, to, amount, reason, method },
          "receipt.pdf"
        );
      } catch (err) {
        console.error(err);
        alert("Error generating receipt PDF.");
      } finally {
        receiptBtn.disabled = false;
        receiptBtn.textContent = "Export receipt PDF – $1.49";
      }
    });
  } else {
    console.warn("receiptExportBtn not found");
  }

  // ---------------- Paystub ----------------
  const paystubBtn = document.getElementById("paystubExportBtn");
  if (paystubBtn) {
    paystubBtn.addEventListener("click", async () => {
      const employee = document.getElementById("psEmployee")?.value || "";
      const employer = document.getElementById("psEmployer")?.value || "";
      const grossRaw = document.getElementById("psGross")?.value || "";
      const dedRaw = document.getElementById("psDeductions")?.value || "";
      const period = document.getElementById("psPeriod")?.value || "";
      const gross = grossRaw ? parseFloat(grossRaw) : 0;
      const deductions = dedRaw ? parseFloat(dedRaw) : 0;

      try {
        paystubBtn.disabled = true;
        paystubBtn.textContent = "Generating paystub...";
        await jsonToPdf(
          "/api/paystub/generate",
          { employee, employer, gross, deductions, period },
          "paystub.pdf"
        );
      } catch (err) {
        console.error(err);
        alert("Error generating paystub PDF.");
      } finally {
        paystubBtn.disabled = false;
        paystubBtn.textContent = "Export paystub PDF – $1.49";
      }
    });
  }

  // ---------------- Word -> PDF ----------------
  const wordBtn = document.getElementById("wordToPdfBtn");
  if (wordBtn) {
    wordBtn.addEventListener("click", async () => {
      const fileInput = document.getElementById("w2pFile");
      const titleInput = document.getElementById("w2pTitle");
      const file = fileInput?.files?.[0];

      if (!file) {
        alert("Select a Word file first.");
        return;
      }

      const title = titleInput?.value || "";
      const formData = new FormData();
      formData.append("file", file);
      if (title) formData.append("title", title);

      try {
        wordBtn.disabled = true;
        wordBtn.textContent = "Converting...";
        const res = await fetch("/api/convert/word-to-pdf", {
          method: "POST",
          body: formData,
        });
        if (!res.ok) throw new Error(`Server error ${res.status}`);
        const nameBase =
          (title || file.name.replace(/\.(docx?|rtf)$/i, "")) || "converted";
        await triggerDownloadFromResponse(res, nameBase + ".pdf");
      } catch (err) {
        console.error(err);
        alert("Error converting Word to PDF.");
      } finally {
        wordBtn.disabled = false;
        wordBtn.textContent = "Convert to PDF – $1.49";
      }
    });
  }

  // ---------------- PDF -> Word ----------------
  const pdfToWordBtn = document.getElementById("pdfToWordBtn");
  if (pdfToWordBtn) {
    pdfToWordBtn.addEventListener("click", async () => {
      const fileInput = document.getElementById("p2wFile");
      const titleInput = document.getElementById("p2wTitle");
      const file = fileInput?.files?.[0];

      if (!file) {
        alert("Select a PDF first.");
        return;
      }

      const formData = new FormData();
      formData.append("file", file);

      try {
        pdfToWordBtn.disabled = true;
        pdfToWordBtn.textContent = "Converting...";
        const res = await fetch("/api/convert/pdf-to-word", {
          method: "POST",
          body: formData,
        });
        if (!res.ok) throw new Error(`Server error ${res.status}`);
        const base =
          (titleInput?.value ||
            file.name.replace(/\.pdf$/i, "") ||
            "converted") + ".docx";
        await triggerDownloadFromResponse(res, base);
      } catch (err) {
        console.error(err);
        alert("Error converting PDF to Word.");
      } finally {
        pdfToWordBtn.disabled = false;
        pdfToWordBtn.textContent = "Convert to Word – $1.49";
      }
    });
  }

  // ---------------- Merge PDFs ----------------
  const mergeBtn = document.getElementById("mergePdfBtn");
  if (mergeBtn) {
    mergeBtn.addEventListener("click", async () => {
      const fileInput = document.getElementById("mergeFiles");
      const files = fileInput?.files;

      if (!files || !files.length) {
        alert("Select at least one PDF.");
        return;
      }

      const formData = new FormData();
      Array.from(files).forEach((file) => {
        formData.append("files", file);
      });

      try {
        mergeBtn.disabled = true;
        mergeBtn.textContent = "Merging PDFs...";
        const res = await fetch("/api/pdf/merge", {
          method: "POST",
          body: formData,
        });
        if (!res.ok) throw new Error(`Server error ${res.status}`);
        await triggerDownloadFromResponse(res, "merged.pdf");
      } catch (err) {
        console.error(err);
        alert("Error merging PDFs.");
      } finally {
        mergeBtn.disabled = false;
        mergeBtn.textContent = "Merge & export – $1.49";
      }
    });
  }

  // ================================================================
  // NEW: Estimate, Contract, Quote→Invoice, Business Letter
  // ================================================================

  // ---------------- Estimate ----------------
  const estimateBtn = document.getElementById("estimateExportBtn");
  if (estimateBtn) {
    estimateBtn.addEventListener("click", async () => {
      const from = document.getElementById("estFrom")?.value || "";
      const to = document.getElementById("estTo")?.value || "";
      const number = document.getElementById("estNumber")?.value || "";
      const validUntil =
        document.getElementById("estValidUntil")?.value || "";
      const items = document.getElementById("estItems")?.value || "";
      const subtotalRaw =
        document.getElementById("estSubtotal")?.value || "";
      const taxRateRaw =
        document.getElementById("estTaxRate")?.value || "";
      const notes = document.getElementById("estNotes")?.value || "";

      const subtotal = subtotalRaw ? parseFloat(subtotalRaw) : 0;
      const taxRate = taxRateRaw ? parseFloat(taxRateRaw) : 0;

      try {
        estimateBtn.disabled = true;
        estimateBtn.textContent = "Generating estimate...";
        await jsonToPdf(
          "/api/estimate/generate",
          {
            from,
            to,
            number,
            validUntil,
            items,
            subtotal,
            taxRate,
            notes,
          },
          (number || "estimate") + ".pdf"
        );
      } catch (err) {
        console.error(err);
        alert("Error generating estimate PDF.");
      } finally {
        estimateBtn.disabled = false;
        estimateBtn.textContent = "Export estimate PDF – $1.49";
      }
    });
  }

  // ---------------- Contract ----------------
  const contractBtn = document.getElementById("contractExportBtn");
  if (contractBtn) {
    contractBtn.addEventListener("click", async () => {
      const from = document.getElementById("contractFrom")?.value || "";
      const to = document.getElementById("contractTo")?.value || "";
      const title = document.getElementById("contractTitle")?.value || "";
      const scope = document.getElementById("contractScope")?.value || "";
      const payment =
        document.getElementById("contractPayment")?.value || "";
      const startDate =
        document.getElementById("contractStart")?.value || "";
      const endDate = document.getElementById("contractEnd")?.value || "";
      const terms = document.getElementById("contractTerms")?.value || "";

      try {
        contractBtn.disabled = true;
        contractBtn.textContent = "Generating contract...";
        await jsonToPdf(
          "/api/contract/generate",
          {
            from,
            to,
            title,
            scope,
            payment,
            startDate,
            endDate,
            terms,
          },
          (title || "contract") + ".pdf"
        );
      } catch (err) {
        console.error(err);
        alert("Error generating contract PDF.");
      } finally {
        contractBtn.disabled = false;
        contractBtn.textContent = "Export contract PDF – $1.49";
      }
    });
  }

  // ---------------- Quote → Invoice ----------------
  const quoteInvoiceBtn = document.getElementById(
    "quoteInvoiceExportBtn"
  );
  if (quoteInvoiceBtn) {
    quoteInvoiceBtn.addEventListener("click", async () => {
      const from = document.getElementById("qiFrom")?.value || "";
      const to = document.getElementById("qiTo")?.value || "";
      const estimateNumber =
        document.getElementById("qiEstimateNumber")?.value || "";
      const invoiceNumber =
        document.getElementById("qiInvoiceNumber")?.value || "";
      const items = document.getElementById("qiItems")?.value || "";
      const subtotalRaw =
        document.getElementById("qiSubtotal")?.value || "";
      const taxRateRaw =
        document.getElementById("qiTaxRate")?.value || "";
      const notes = document.getElementById("qiNotes")?.value || "";

      const subtotal = subtotalRaw ? parseFloat(subtotalRaw) : 0;
      const taxRate = taxRateRaw ? parseFloat(taxRateRaw) : 0;

      try {
        quoteInvoiceBtn.disabled = true;
        quoteInvoiceBtn.textContent = "Generating invoice...";
        await jsonToPdf(
          "/api/quote-invoice/generate",
          {
            from,
            to,
            estimateNumber,
            invoiceNumber,
            items,
            subtotal,
            taxRate,
            notes,
          },
          (invoiceNumber || "invoice") + ".pdf"
        );
      } catch (err) {
        console.error(err);
        alert("Error generating invoice from quote.");
      } finally {
        quoteInvoiceBtn.disabled = false;
        quoteInvoiceBtn.textContent =
          "Export invoice PDF – $1.49";
      }
    });
  }

  // ---------------- Business Letter ----------------
  const letterBtn = document.getElementById("letterExportBtn");
  if (letterBtn) {
    letterBtn.addEventListener("click", async () => {
      const from = document.getElementById("letterFrom")?.value || "";
      const to = document.getElementById("letterTo")?.value || "";
      const subject =
        document.getElementById("letterSubject")?.value || "";
      const body = document.getElementById("letterBody")?.value || "";
      const signoff =
        document.getElementById("letterSignoff")?.value || "Sincerely,";
      const senderName =
        document.getElementById("letterSenderName")?.value || "";

      try {
        letterBtn.disabled = true;
        letterBtn.textContent = "Generating letter...";
        await jsonToPdf(
          "/api/letter/generate",
          { from, to, subject, body, signoff, senderName },
          (subject || "letter") + ".pdf"
        );
      } catch (err) {
        console.error(err);
        alert("Error generating letter PDF.");
      } finally {
        letterBtn.disabled = false;
        letterBtn.textContent = "Export letter PDF – $1.49";
      }
    });
  }

  // ================================================================
  // NEW: More Tools – PDF→JPG, JPG→PDF, Compress, Split
  // ================================================================

  // ---------------- PDF -> JPG (placeholder) ----------------
  const pdfToJpgBtn = document.getElementById("pdfToJpgBtn");
  if (pdfToJpgBtn) {
    pdfToJpgBtn.addEventListener("click", async () => {
      const fileInput = document.getElementById("pdfToJpgFile");
      const dpiInput = document.getElementById("pdfToJpgDpi");
      const file = fileInput?.files?.[0];

      if (!file) {
        alert("Select a PDF first.");
        return;
      }

      const dpi = dpiInput?.value || "";

      const formData = new FormData();
      formData.append("file", file);
      if (dpi) formData.append("dpi", dpi);

      try {
        pdfToJpgBtn.disabled = true;
        pdfToJpgBtn.textContent = "Processing...";
        const res = await fetch("/api/pdf/to-jpg", {
          method: "POST",
          body: formData,
        });
        if (!res.ok) throw new Error(`Server error ${res.status}`);
        const baseName =
          file.name.replace(/\.pdf$/i, "") || "pdf-to-jpg-preview";
        await triggerDownloadFromResponse(
          res,
          baseName + "-pdf-to-jpg-preview.pdf"
        );
      } catch (err) {
        console.error(err);
        alert("Error running PDF → JPG (preview).");
      } finally {
        pdfToJpgBtn.disabled = false;
        pdfToJpgBtn.textContent = "Convert to JPG – $1.49";
      }
    });
  }

  // ---------------- JPG / Image -> PDF ----------------
  const jpgToPdfBtn = document.getElementById("jpgToPdfBtn");
  if (jpgToPdfBtn) {
    jpgToPdfBtn.addEventListener("click", async () => {
      const fileInput = document.getElementById("jpgToPdfFiles");
      const titleInput = document.getElementById("jpgToPdfTitle");
      const files = fileInput?.files;

      if (!files || !files.length) {
        alert("Select at least one image.");
        return;
      }

      const title = titleInput?.value || "images-to-pdf";
      const formData = new FormData();
      Array.from(files).forEach((file) => {
        formData.append("files", file);
      });
      formData.append("title", title);

      try {
        jpgToPdfBtn.disabled = true;
        jpgToPdfBtn.textContent = "Converting...";
        const res = await fetch("/api/image/jpg-to-pdf", {
          method: "POST",
          body: formData,
        });
        if (!res.ok) throw new Error(`Server error ${res.status}`);
        const base = title || "images-to-pdf";
        await triggerDownloadFromResponse(res, base + ".pdf");
      } catch (err) {
        console.error(err);
        alert("Error converting images to PDF.");
      } finally {
        jpgToPdfBtn.disabled = false;
        jpgToPdfBtn.textContent = "Convert to PDF – $1.49";
      }
    });
  }

  // ---------------- Compress PDF ----------------
  const compressBtn = document.getElementById("compressPdfBtn");
  if (compressBtn) {
    compressBtn.addEventListener("click", async () => {
      const fileInput = document.getElementById("compressPdfFile");
      const qualityInput = document.getElementById("compressQuality");
      const file = fileInput?.files?.[0];

      if (!file) {
        alert("Select a PDF first.");
        return;
      }

      const quality = qualityInput?.value || "balanced";

      const formData = new FormData();
      formData.append("file", file);
      formData.append("quality", quality);

      try {
        compressBtn.disabled = true;
        compressBtn.textContent = "Compressing...";
        const res = await fetch("/api/pdf/compress", {
          method: "POST",
          body: formData,
        });
        if (!res.ok) throw new Error(`Server error ${res.status}`);
        const base =
          file.name.replace(/\.pdf$/i, "") || "compressed-document";
        await triggerDownloadFromResponse(res, base + "-compressed.pdf");
      } catch (err) {
        console.error(err);
        alert("Error compressing PDF.");
      } finally {
        compressBtn.disabled = false;
        compressBtn.textContent = "Compress & download – $1.49";
      }
    });
  }

  // ---------------- Split PDF ----------------
  const splitBtn = document.getElementById("splitPdfBtn");
  if (splitBtn) {
    splitBtn.addEventListener("click", async () => {
      const fileInput = document.getElementById("splitPdfFile");
      const rangesInput = document.getElementById("splitPageRanges");
      const file = fileInput?.files?.[0];

      if (!file) {
        alert("Select a PDF first.");
        return;
      }

      const ranges = rangesInput?.value || "";

      const formData = new FormData();
      formData.append("file", file);
      formData.append("ranges", ranges);

      try {
        splitBtn.disabled = true;
        splitBtn.textContent = "Splitting...";
        const res = await fetch("/api/pdf/split", {
          method: "POST",
          body: formData,
        });
        if (!res.ok) throw new Error(`Server error ${res.status}`);
        const base = file.name.replace(/\.pdf$/i, "") || "split-document";
        await triggerDownloadFromResponse(res, base + "-split.pdf");
      } catch (err) {
        console.error(err);
        alert("Error splitting PDF.");
      } finally {
        splitBtn.disabled = false;
        splitBtn.textContent = "Split & export – $1.49";
      }
    });
  }
});

